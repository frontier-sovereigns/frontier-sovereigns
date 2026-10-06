import { describe, expect, it } from 'vitest';
import { balance, buildings, contentHash, units, validateClientCommand, type BuildingId, type ClientCommandEnvelope, type GameplayCommand, type PlayerView, type ViewEntity } from '@frontier/shared';
import { createSimulation, exportSimulationSave, restoreSimulation, type Building, type EngineIdentity, type Simulation, type Unit } from '@frontier/simulation';
import { createPlaythroughMemory, observePlaythrough, planPlaythrough, playthroughCommandSent, playthroughReceipt, type PlaythroughMemory } from '../scripts/playthrough-policy.js';

function fixture(): PlayerView {
  const home: ViewEntity = { id: 'home', ownerId: 'human', kind: 'building', typeId: 'town_center', xMm: 40000, zMm: 40000, hp: buildings.town_center.maxHp, maxHp: buildings.town_center.maxHp, progress: 1, queue: [] };
  const workers: ViewEntity[] = Array.from({ length: 6 }, (_, i) => ({ id: `worker_${i}`, ownerId: 'human', kind: 'unit', typeId: 'villager', xMm: 34000 + i * 1500, zMm: 32000, hp: units.villager.maxHp, maxHp: units.villager.maxHp, order: 'idle', taskState: 'idle', cargo: { resource: null, amount: 0 } }));
  return { protocolVersion: 2, contentHash, matchId: 'policy', matchEpoch: 1, tick: 0, sequence: 1, playerId: 'human', status: 'RUNNING', map: { widthMm: 80000, heightMm: 80000, fogCellMm: 2000 }, self: { lastCommandSequence: 0, resources: { ...balance.start.resources }, age: 1, population: 7, populationCap:15,populationLimit:120, reservedPopulation: 0, technologies: [], autoReseed: false }, players: [{ id: 'human', name: 'Human', color: '#ffffff', teamId: 'blue', kind: 'human' }, { id: 'enemy', name: 'Enemy', color: '#000000', teamId: 'red', kind: 'ai' }], entities: [home, ...workers, { id: 'forage', kind: 'resource', ownerId: null, typeId: 'forage_bush', resource: 'food', amount: 1000, xMm: 48000, zMm: 30000, hp: 1, maxHp: 1 }], fog: { visible: Array.from({ length: 1600 }, (_, index) => index), explored: Array.from({ length: 1600 }, (_, index) => index) } };
}

describe('bounded playthrough economy recovery', () => {
  const options = { targetWorkers: 6 };
  it.each([1, 2, 3] as const)('replaces a lost scout in Age%s and reserves the paid job across a stale view', age => {
    const view = fixture(), memory = createPlaythroughMemory(); view.self.age = age;
    view.self.resources = { food: units.scout.cost.food, wood: 0, gold: 0, stone: 0 }; view.entities = view.entities.filter(entity => entity.kind !== 'resource');
    view.entities.push({ id: 'remembered_wood', kind: 'resource', ownerId: null, typeId: 'tree_oak', resource: 'wood', amount: 100, ghost: true, xMm: 70000, zMm: 40000, hp: 1, maxHp: 1 });
    const before = JSON.stringify(view), commands = planPlaythrough(view, memory, options);
    expect(commands).toEqual([{ kind: 'train', buildingId: 'home', unitType: 'scout', quantity: 1 }]); expect(JSON.stringify(view)).toBe(before);
    const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'replace_scout', clientSequence: 1, command: commands[0]! };
    expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope);
    playthroughReceipt(memory, { status: 'accepted', clientCommandId: envelope.clientCommandId, tick: view.tick, sequence: 1 });
    expect(memory.pending[0]!.cost).toEqual(units.scout.cost);
    expect(planPlaythrough({ ...view, tick: 20, sequence: 2 }, memory, options)).toEqual([]);
  });
  it('waits for housing, food, a completed producer and its current job before replacing the scout', () => {
    for (const reason of ['housing', 'reserved_population', 'food', 'foundation', 'queue', 'existing_scout'] as const) {
      const view = fixture(); view.self.age = 3; view.self.resources = { food: units.scout.cost.food, wood: 0, gold: 0, stone: 0 }; view.entities = view.entities.filter(entity => entity.kind !== 'resource');
      const home = view.entities.find(entity => entity.id === 'home')!;
      if (reason === 'housing') view.self.populationCap = view.self.population;
      if (reason === 'reserved_population') view.self.reservedPopulation = view.self.populationCap - view.self.population;
      if (reason === 'food') view.self.resources.food--;
      if (reason === 'foundation') home.progress = .5;
      if (reason === 'queue') home.queue = [{ id: 'existing_job', kind: 'train', typeId: 'villager', progress: .5, state: 'active' }];
      if (reason === 'existing_scout') view.entities.push({ id: 'scout', kind: 'unit', typeId: 'scout', ownerId: 'human', xMm: 30000, zMm: 30000, hp: units.scout.maxHp, maxHp: units.scout.maxHp, order: 'move', taskState: 'moving' });
      expect(planPlaythrough(view, createPlaythroughMemory(), options).some(command => command.kind === 'train' && command.unitType === 'scout'), reason).toBe(false);
    }
  });
  function matureView(): PlayerView {
    const view = fixture(); view.self.age = 4; view.self.populationCap = 120; view.self.autoReseed = true;
    view.self.technologies = ['forestry_1', 'forestry_2', 'forestry_3'];
    for (const [index, typeId] of (['mill', 'lumber_camp', 'mining_camp', 'market', 'blacksmith', 'siege_workshop', 'university', 'watchtower', 'barracks', 'archery_range', 'wooden_gate'] as const).entries())
      view.entities.push({ id: typeId, typeId, kind: 'building', ownerId: 'human', xMm: 60000, zMm: 10000 + index * 4000, hp: buildings[typeId].maxHp, maxHp: buildings[typeId].maxHp, progress: 1, queue: [] });
    return view;
  }
  function exhaustedFarm(id: string, xMm = 25000): ViewEntity {
    return { id, typeId: 'farm', kind: 'building', ownerId: 'human', xMm, zMm: 32000, hp: buildings.farm.maxHp, maxHp: buildings.farm.maxHp, progress: 1, resource: 'food', amount: 0, farmState: 'exhausted', farmerAssigned: false };
  }
  function isolatedSimulation() {
    const sim = createSimulation({ seed: 'playthrough-recovery', matchId: 'recovery', factions: fixture().players, controllers: false });
    const home = Object.values(sim.state.entities).find((entity): entity is Building => entity.kind === 'building' && entity.ownerId === 'human' && entity.typeId === 'town_center')!;
    const worker = Object.values(sim.state.entities).find((entity): entity is Unit => entity.kind === 'unit' && entity.ownerId === 'human' && entity.typeId === 'villager')!;
    // Explicit mechanics fixture. Purchases/work below use the ordinary command
    // path; this does not claim an unmodified standard-start playthrough.
    for (const entity of Object.values(sim.state.entities)) if (![home.id, worker.id].includes(entity.id) && !(entity.ownerId === 'enemy' && entity.typeId === 'town_center')) delete sim.state.entities[entity.id];
    Object.assign(home, { xMm: 120000, zMm: 120000 }); Object.assign(worker, { xMm: 128150, zMm: 120000 });
    sim.state.navigationRevision++;
    const structure = (id: string, typeId: BuildingId, xMm: number, zMm: number): Building => {
      const def = buildings[typeId], required = def.buildSeconds * balance.rules.simulationHz * 100;
      const entity: Building = { id, typeId, kind: 'building', ownerId: 'human', xMm, zMm, hp: def.maxHp, maxHp: def.maxHp, rotation: 0, work: required, required, grantedHp: def.maxHp, queue: [], cooldown: 0 };
      sim.state.entities[id] = entity; sim.state.navigationRevision++; return entity;
    };
    return { sim, home, worker, structure };
  }
  it('pays for a replacement scout before Empire, reveals wood and resumes ordinary worker deposits', () => {
    const { sim, worker } = isolatedSimulation(), economy = sim.state.economies.human!;
    economy.age = 3; economy.resources = { food: units.scout.cost.food * balance.rules.resourceScale, wood: 0, gold: 0, stone: 0 };
    for (let index = 1; index < 6; index++) {
      const extra = structuredClone(worker); extra.id = `replacement_worker_${index}`; extra.zMm = 110000 + index * 1800; sim.state.entities[extra.id] = extra;
    }
    sim.state.entities.unseen_tree = { id: 'unseen_tree', kind: 'resource', ownerId: null, typeId: 'tree_oak', resource: 'wood', amount: 100 * balance.rules.resourceScale, xMm: 150000, zMm: 120000, hp: 1, maxHp: 1 };
    sim.state.navigationRevision++; sim.step();
    const memory = createPlaythroughMemory(); let sequence = 0, seenWood = false, admittedGather = false;
    expect(sim.view('human').entities.some(entity => entity.id === 'unseen_tree')).toBe(false);
    for (let tick = 0; tick < 3000 && economy.collected.wood === 0; tick++) {
      const view = sim.view('human'); seenWood ||= view.entities.some(entity => entity.id === 'unseen_tree' && !entity.ghost);
      for (const command of planPlaythrough(view, memory, options)) {
        if (command.kind === 'gather') { expect(view.entities.some(entity => entity.id === command.targetId && !entity.ghost)).toBe(true); admittedGather = true; }
        const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: `scout_recovery_${++sequence}`, clientSequence: sequence, command };
        playthroughCommandSent(memory, envelope); const receipt = sim.command('human', envelope); expect(receipt.status, command.kind).toBe('accepted'); playthroughReceipt(memory, receipt);
      }
      sim.step();
    }
    expect(seenWood).toBe(true); expect(admittedGather).toBe(true); expect(economy.collected.wood).toBeGreaterThan(0);
    expect(sim.state.commandLog.filter(event => event.playerId === 'human' && event.envelope.command.kind === 'train')).toHaveLength(1);
    expect(economy.spent.food).toBe(units.scout.cost.food * balance.rules.resourceScale);
    expect(economy.age).toBe(3);
  });
  it('pays once to reseed an abandoned farm, performs actual work, and resumes gathering', () => {
    const { sim, worker, structure } = isolatedSimulation(), farm = structure('abandoned_farm', 'farm', 132000, 120000);
    farm.foodRemaining = 0; sim.state.economies.human!.autoReseed = true;
    sim.state.economies.human!.resources = { food: 0, wood: buildings.farm.reseedCost!.wood * 1000, gold: 0, stone: 0 }; sim.step();
    const view = sim.view('human'), memory = createPlaythroughMemory(), before = JSON.stringify(view), commands = planPlaythrough(view, memory, { targetWorkers: 1 });
    expect(commands).toEqual([{ kind: 'reseed_farm', farmId: farm.id, builderId: worker.id }]); expect(JSON.stringify(view)).toBe(before);
    const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: 'recover_farm', clientSequence: 1, command: commands[0]! };
    expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope);
    const receipt = sim.command('human', envelope); expect(receipt.status).toBe('accepted'); playthroughReceipt(memory, receipt);
    expect(sim.view('human').self.resources.wood).toBe(0); expect(farm.foodRemaining).toBe(0);
    expect(planPlaythrough({ ...view, tick: view.tick + 20, sequence: view.sequence + 1 }, memory, { targetWorkers: 1 })).toEqual([]);
    for (let tick = 0; tick < 800 && farm.foodRemaining === 0; tick++) sim.step();
    expect(farm.foodRemaining).toBe(buildings.farm.foodCapacity! * 1000); expect(worker.orders[0]?.kind).toBe('gather');
    sim.step(20); expect(worker.cargo.resource).toBe('food'); expect(worker.cargo.amount).toBeGreaterThan(0);
    expect(sim.state.economies.human!.ledger.filter(entry => entry.reason === 'farm_reseed')).toMatchObject([{ resource: 'wood', deltaMilli: -buildings.farm.reseedCost!.wood * 1000 }]);
  });
  it('reserves the exhausted farm and its worker across accepted receipts and stale views', () => {
    const view = matureView(), memory = createPlaythroughMemory(); view.entities = view.entities.filter(entity => entity.kind !== 'resource');
    view.entities.push(exhaustedFarm('farm')); view.self.resources = { food: 0, wood: 120, gold: 0, stone: 0 };
    const commands = planPlaythrough(view, memory, options), command = commands.find(command => command.kind === 'reseed_farm')!;
    expect(command).toMatchObject({ kind: 'reseed_farm', farmId: 'farm' }); if (command.kind !== 'reseed_farm') throw new Error('RESEED_FIXTURE_MISSING');
    expect(commands.filter(candidate => 'unitIds' in candidate && candidate.unitIds.includes(command.builderId) || 'builderIds' in candidate && candidate.builderIds.includes(command.builderId))).toEqual([]);
    const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'reserved_reseed', clientSequence: 1, command };
    playthroughCommandSent(memory, envelope); playthroughReceipt(memory, { status: 'accepted', clientCommandId: envelope.clientCommandId, tick: 0, sequence: 1 });
    const pending = memory.pending.find(item => item.command.kind === 'reseed_farm')!;
    expect(pending.cost).toEqual(buildings.farm.reseedCost); expect(memory.farmAssignments.farm).toBe(command.builderId);
    const stale = structuredClone(view); stale.tick = 20; stale.sequence++;
    expect(planPlaythrough(stale, memory, options).some(candidate => candidate.kind === 'reseed_farm')).toBe(false);
    const acknowledged = structuredClone(stale); acknowledged.tick = 40; acknowledged.sequence++; acknowledged.self.lastCommandSequence = 1;
    Object.assign(acknowledged.entities.find(entity => entity.id === 'farm')!, { farmState: 'reseeding' });
    Object.assign(acknowledged.entities.find(entity => entity.id === command.builderId)!, { order: 'reseed', taskState: 'building' });
    expect(planPlaythrough(acknowledged, memory, options).some(candidate => candidate.kind === 'reseed_farm')).toBe(false);
  });
  it('subtracts pending reseed costs before a second farm and waits when recovery is unaffordable', () => {
    const view = matureView(), memory = createPlaythroughMemory(); view.entities.push(exhaustedFarm('farm_a'), exhaustedFarm('farm_b', 20000));
    view.self.resources = { food: 0, wood: buildings.farm.reseedCost!.wood, gold: 0, stone: 0 };
    const commands = planPlaythrough(view, memory, options); expect(commands.filter(command => command.kind === 'reseed_farm')).toHaveLength(1);
    const later = structuredClone(view); later.tick = 20; later.sequence++;
    expect(planPlaythrough(later, memory, options).some(command => command.kind === 'reseed_farm')).toBe(false);
    later.self.resources.wood--; expect(planPlaythrough(later, createPlaythroughMemory(), options).some(command => command.kind === 'reseed_farm')).toBe(false);
  });
  it('does not buy reseeding for rounded-zero, assigned, unfinished, hidden, or foreign farms', () => {
    for (const patch of [{ farmState: 'ready' as const }, { farmerAssigned: true }, { progress: .5 }, { ghost: true }, { ownerId: 'enemy' }, { farmState: 'reseeding' as const }]) {
      const view = matureView(); view.self.resources = { food: 0, wood: 60, gold: 0, stone: 0 }; view.entities.push({ ...exhaustedFarm('farm'), ...patch });
      expect(planPlaythrough(view, createPlaythroughMemory(), options).some(command => command.kind === 'reseed_farm'), JSON.stringify(patch)).toBe(false);
    }
    const rebuilding = matureView(); rebuilding.entities = rebuilding.entities.filter(entity => entity.typeId !== 'town_center');
    rebuilding.self.resources = { food: 0, wood: 60, gold: 0, stone: 0 }; rebuilding.entities.push(exhaustedFarm('farm'));
    expect(planPlaythrough(rebuilding, createPlaythroughMemory(), options).some(command => command.kind === 'reseed_farm')).toBe(false);
  });
  it('finds an omitted-parity visible barracks site and admits it through ordinary construction', () => {
    const { sim, worker, structure } = isolatedSimulation(); sim.state.economies.human!.age = 4;
    sim.state.economies.human!.resources = { food: 0, wood: buildings.barracks.cost.wood * 1000, gold: 0, stone: 0 };
    for (const [index, typeId] of (['mill', 'lumber_camp', 'mining_camp', 'market', 'blacksmith', 'siege_workshop', 'university', 'farm'] as const).entries()) {
      const entity = structure(typeId, typeId, 80000 + index * 10000, 80000); if (typeId === 'farm') entity.foodRemaining = buildings.farm.foodCapacity! * 1000;
    }
    structure('watchtower', 'watchtower', 134000, 118000); sim.step();
    const view = sim.view('human'), columns = Math.ceil(view.map.widthMm / view.map.fogCellMm), origin = { x: 65, z: 61 };
    const visible = Array.from({ length: 16 }, (_, index) => (origin.z + Math.floor(index / 4)) * columns + origin.x + index % 4);
    expect(visible.every(cell => view.fog.visible.includes(cell))).toBe(true);
    view.fog.visible = visible; view.fog.explored = visible; const before = JSON.stringify(view);
    const command = planPlaythrough(view, createPlaythroughMemory(), { targetWorkers: 1 }).find(command => command.kind === 'build')!;
    expect(command).toEqual({ kind: 'build', buildingType: 'barracks', builderIds: [worker.id], originCell: origin, rotation: 0, queued: false }); expect(JSON.stringify(view)).toBe(before);
    const hidden = structuredClone(view); hidden.fog.visible = visible.slice(1);
    expect(planPlaythrough(hidden, createPlaythroughMemory(), { targetWorkers: 1 }).some(candidate => candidate.kind === 'build')).toBe(false);
    const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'odd_site', clientSequence: 1, command };
    expect(validateClientCommand(envelope)).toBe(true); expect(sim.command('human', envelope).status).toBe('accepted');
    expect(sim.view('human').self.resources.wood).toBe(0); expect(Object.values(sim.state.entities).some(entity => entity.typeId === 'barracks' && entity.xMm === 134000 && entity.zMm === 126000)).toBe(true);
  });
  it('keeps coarse placement choices when the original grid has a visible legal site', () => {
    const view = matureView(); view.entities = view.entities.filter(entity => entity.typeId !== 'barracks'); view.self.resources = { food: 0, wood: 175, gold: 0, stone: 0 };
    const command = planPlaythrough(view, createPlaythroughMemory(), options).find(command => command.kind === 'build')!;
    expect(command.kind).toBe('build'); if (command.kind !== 'build') throw new Error('BUILD_FIXTURE_MISSING');
    expect(command.buildingType).toBe('barracks'); expect(command.originCell.x % 2).toBe(0); expect(command.originCell.z % 2).toBe(0);
  });
  it('uses affordable gold-free units, retains funded preferences, and reserves their actual costs', () => {
    for (const [bank, expected] of [[{ food: 85, wood: 60, gold: 0, stone: 0 }, ['spearman', 'skirmisher']], [{ food: 60, wood: 25, gold: 65, stone: 0 }, ['militia', 'archer']]] as const) {
      const view = matureView(), memory = createPlaythroughMemory(); view.self.resources = { ...bank }; const before = JSON.stringify(view);
      const commands = planPlaythrough(view, memory, options), trained = commands.filter(command => command.kind === 'train');
      expect(trained.map(command => command.unitType)).toEqual(expected); expect(JSON.stringify(view)).toBe(before);
      expect(memory.pending.filter(item => item.command.kind === 'train').map(item => item.cost)).toEqual(expected.map(type => units[type].cost));
      commands.forEach((command, index) => { const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: `recovery_${index}`, clientSequence: index + 1, command }; expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope); playthroughReceipt(memory, { status: 'accepted', clientCommandId: envelope.clientCommandId, tick: 0, sequence: index + 1 }); });
      const stale = structuredClone(view); stale.tick = 20; stale.sequence++;
      expect(planPlaythrough(stale, memory, options).some(command => command.kind === 'train')).toBe(false);
    }
    const poor = matureView(); poor.self.resources = { food: 49, wood: 24, gold: 0, stone: 0 };
    expect(planPlaythrough(poor, createPlaythroughMemory(), options).some(command => command.kind === 'train')).toBe(false);
  });
});
describe('filtered playthrough policy network reservations', () => {
  it('holds paid purchases across accepted-receipt / stale-view gaps without mutating the view', () => {
    const view = fixture(), before = JSON.stringify(view), memory = createPlaythroughMemory();
    const commands = planPlaythrough(view, memory), purchases = commands.filter(command => ['build', 'train'].includes(command.kind));
    expect(purchases.length).toBeGreaterThan(0); expect(commands.length).toBeLessThanOrEqual(8); expect(JSON.stringify(view)).toBe(before);
    commands.forEach((command, index) => { const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: `command_${index}`, clientSequence: index + 1, command }; expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope); playthroughReceipt(memory, { status: 'accepted', clientCommandId: envelope.clientCommandId, tick: 0, sequence: index + 1 }); });
    expect(planPlaythrough(view, memory)).toEqual([]);
    const stale = { ...view, tick: 20, sequence: 2 };
    const later = planPlaythrough(stale, memory); expect(later.some(command => ['build', 'train'].includes(command.kind))).toBe(false);
    expect(memory.pending.filter(item => item.receipt?.status === 'accepted')).toHaveLength(commands.length);
    // Tick alone cannot release a debit; the snapshot must acknowledge its sequence.
    expect(memory.telemetry.accepted).toBe(commands.length);
    playthroughReceipt(memory, { status: 'accepted', clientCommandId: 'command_0', tick: 0, sequence: 1 }); expect(memory.telemetry.accepted).toBe(commands.length);
  });
  it('releases rejected site reservations with bounded retry, and clears old-epoch targets', () => {
    const view = fixture(), memory = createPlaythroughMemory(), command = planPlaythrough(view, memory).find(command => command.kind === 'build')!;
    expect(command.kind).toBe('build');
    playthroughCommandSent(memory, { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'bad_site', clientSequence: 1, command });
    playthroughReceipt(memory, { status: 'rejected', clientCommandId: 'bad_site', code: 'NO_PATH', tick: 0, sequence: 1 });
    expect(memory.pending.some(item => item.clientCommandId === 'bad_site')).toBe(false); expect(memory.siteAttempt.mill).toBe(1);
    expect(planPlaythrough({ ...view, tick: 20 }, memory).some(item => item.kind === 'build' && item.buildingType === 'mill')).toBe(false);
    memory.lastArmyTarget = 'previous_epoch_enemy'; memory.defenseCells = [{ x: 1, z: 1 }];
    planPlaythrough({ ...view, matchEpoch: 2, tick: 1 }, memory);
    expect(memory.lastArmyTarget).toBeUndefined(); expect(memory.defenseCells).toBeUndefined(); expect(memory.pending.every(item => !item.clientCommandId)).toBe(true);
  });
  it('does not invent attack targets from public opposing faction identity or hidden resource memories', () => {
    const view = fixture(), memory = createPlaythroughMemory(); view.self.age = 4;
    view.entities = view.entities.filter(entity => entity.kind !== 'resource');
    view.entities.push({ id: 'remembered_food', ownerId: null, kind: 'resource', typeId: 'forage_bush', resource: 'food', amount: 999, xMm: 10000, zMm: 10000, hp: 1, maxHp: 1, ghost: true });
    const commands = planPlaythrough(view, memory);
    expect(commands.some(command => ['attack_target', 'attack_move', 'attack_ground'].includes(command.kind))).toBe(false);
    expect(commands.some(command => command.kind === 'gather' && command.targetId === 'remembered_food')).toBe(false);
  });
  it('collects recovery stone before Age IV and buys a replacement Town Center only when funded',()=>{
    const view=fixture(),memory=createPlaythroughMemory();observePlaythrough(view,memory);view.self.age=2;view.self.resources={food:0,wood:50,gold:0,stone:25};view.entities=view.entities.filter(entity=>entity.id!=='home');
    for(const [id,typeId,xMm]of [['lumber','lumber_camp',20000],['mining','mining_camp',60000]] as const)view.entities.push({id,typeId,ownerId:'human',kind:'building',xMm,zMm:50000,hp:100,maxHp:100,progress:1,queue:[]});
    view.entities.push({id:'wood',kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:500,xMm:24000,zMm:30000,hp:1,maxHp:1},{id:'stone',kind:'resource',ownerId:null,typeId:'stone_quarry',resource:'stone',amount:500,xMm:58000,zMm:30000,hp:1,maxHp:1});
    const commands=planPlaythrough(view,memory);expect(commands.some(command=>command.kind==='gather'&&command.targetId==='stone')).toBe(true);expect(commands.some(command=>command.kind==='build'&&command.buildingType==='town_center')).toBe(false);
    const funded=structuredClone(view);funded.tick=200;funded.sequence++;funded.self.resources={food:0,wood:400,gold:0,stone:300};const replacement=planPlaythrough(funded,createPlaythroughMemory()).find(command=>command.kind==='build'&&command.buildingType==='town_center');
    expect(replacement).toBeDefined();expect(validateClientCommand({protocolVersion:2,matchId:view.matchId,matchEpoch:1,clientCommandId:'rebuild',clientSequence:1,command:replacement})).toBe(true);
    const advanced=structuredClone(view);advanced.self.age=4;advanced.self.resources={food:1000,wood:399,gold:1000,stone:299};advanced.entities.push({id:'barracks',typeId:'barracks',ownerId:'human',kind:'building',xMm:60000,zMm:60000,hp:100,maxHp:100,progress:1,queue:[]});
    expect(planPlaythrough(advanced,createPlaythroughMemory()).some(command=>command.kind==='research'||command.kind==='train')).toBe(false);
  });
  it('funds the missing stone drop-off before assigning recovery miners',()=>{
    const view=fixture();view.self.age=2;view.self.resources={food:0,wood:150,gold:0,stone:25};view.entities=view.entities.filter(entity=>entity.id!=='home');
    view.entities.push({id:'lumber',typeId:'lumber_camp',ownerId:'human',kind:'building',xMm:20000,zMm:50000,hp:100,maxHp:100,progress:1,queue:[]},{id:'wood',kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:500,xMm:24000,zMm:30000,hp:1,maxHp:1},{id:'stone',kind:'resource',ownerId:null,typeId:'stone_quarry',resource:'stone',amount:500,xMm:58000,zMm:30000,hp:1,maxHp:1});
    const commands=planPlaythrough(view,createPlaythroughMemory());expect(commands.some(command=>command.kind==='build'&&command.buildingType==='mining_camp')).toBe(true);expect(commands.some(command=>command.kind==='gather'&&command.targetId==='wood')).toBe(true);expect(commands.some(command=>command.kind==='gather'&&command.targetId==='stone')).toBe(false);
  });
  it('attacks a visible connected wall before its defender and retains that breach target',()=>{
    const view=fixture(),memory=createPlaythroughMemory();view.self.age=4;view.self.resources={food:0,wood:0,gold:0,stone:0};
    for(let i=0;i<12;i++)view.entities.push({id:`army_${i}`,ownerId:'human',kind:'unit',typeId:'militia',xMm:30000+i*100,zMm:38000,hp:55,maxHp:55,order:'idle',taskState:'blocked'});
    for(const [id,xMm]of [['left',28000],['middle',30000],['right',32000]] as const)view.entities.push({id,xMm,zMm:44000,ownerId:'enemy',kind:'building',typeId:'palisade_wall',hp:300,maxHp:300,progress:1});
    view.entities.push({id:'defender',ownerId:'enemy',kind:'unit',typeId:'militia',xMm:30000,zMm:48000,hp:55,maxHp:55});
    const commands=planPlaythrough(view,memory),attack=commands.find(command=>command.kind==='attack_target');expect(attack).toMatchObject({kind:'attack_target',targetId:'middle'});
    commands.forEach((command,index)=>{const envelope:ClientCommandEnvelope={protocolVersion:2,matchId:view.matchId,matchEpoch:1,clientCommandId:`breach_${index}`,clientSequence:index+1,command};expect(validateClientCommand(envelope)).toBe(true);playthroughCommandSent(memory,envelope);playthroughReceipt(memory,{status:'accepted',clientCommandId:envelope.clientCommandId,tick:0,sequence:index+1});});
    const later=structuredClone(view);later.tick=620;later.sequence++;later.self.lastCommandSequence=commands.length;for(const unit of later.entities.filter(entity=>entity.id.startsWith('army_'))){unit.order='attack';unit.taskState='moving';}
    expect(memory.lastArmyTarget).toBe('middle');expect(planPlaythrough(later,memory).some(command=>command.kind==='attack_target')).toBe(false);
    const concealed=structuredClone(view);for(const wall of concealed.entities.filter(entity=>entity.kind==='building'&&entity.ownerId==='enemy'))wall.ghost=true;
    expect(planPlaythrough(concealed,createPlaythroughMemory()).filter(command=>command.kind==='attack_target').every(command=>command.targetId==='defender')).toBe(true);
    const blockedAgain=structuredClone(view),alreadyBreached=createPlaythroughMemory();blockedAgain.entities=blockedAgain.entities.filter(entity=>!['left','right'].includes(entity.id));observePlaythrough(blockedAgain,alreadyBreached);
    alreadyBreached.telemetry.evidence.fortificationBreach={met:true,observedTick:0,matchEpoch:1,entityId:'prior_wall',typeId:'palisade_wall',proof:'prior_authorized_breach'};
    expect(planPlaythrough(blockedAgain,alreadyBreached).find(command=>command.kind==='attack_target')).toMatchObject({targetId:'middle'});
  });
  it('preserves same-participant history through paused restore epochs, while rebuilding only authorized cargo assignments', () => {
    const view = fixture(), memory = createPlaythroughMemory(); observePlaythrough(view, memory);
    memory.telemetry.accepted = 12; memory.telemetry.technologyTicks.forestry_1 = 70;
    memory.pending.push({ command: { kind: 'stop', unitIds: ['worker_0'] }, key: 'old', cost: { food: 0, wood: 0, gold: 0, stone: 0 }, tick: 4, unitIds: ['worker_0'], clientCommandId: 'old_epoch', clientSequence: 8 });
    const restored = structuredClone(view); restored.matchEpoch = 3; restored.tick = 200; restored.sequence = 1; restored.status = 'PAUSED'; restored.self.age = 2;
    Object.assign(restored.entities.find(entity => entity.id === 'worker_0')!, { order: 'gather', cargo: { resource: 'wood', amount: 7 } });
    observePlaythrough(restored, memory);
    expect(memory.pending).toEqual([]); expect(memory.telemetry.accepted).toBe(12); expect(memory.telemetry.ageTicks).toEqual({ 1: 0, 2: 200 }); expect(memory.telemetry.technologyTicks.forestry_1).toBe(70);
    expect(memory.assignments).toEqual({ worker_0: 'wood' }); expect(memory.telemetry.epochChanges).toBe(1);
    observePlaythrough(restored, memory); expect(memory.telemetry.epochChanges).toBe(1);
    observePlaythrough({ ...restored, matchId: 'another_game' }, memory); expect(memory.telemetry.accepted).toBe(0); expect(memory.telemetry.technologyTicks).toEqual({});
  });
  it('reconfirms a restored carrying farmer through an ordinary gather before another worker can claim that farm', () => {
    const view = fixture(), memory = createPlaythroughMemory(); observePlaythrough(view, memory);
    memory.farmAssignments.farm = 'worker_0';
    const restored = structuredClone(view); restored.matchEpoch = 2; restored.tick = 40; restored.sequence = 1; restored.self.autoReseed = true;
    restored.entities.push({ id: 'farm', kind: 'building', typeId: 'farm', ownerId: 'human', xMm: 30000, zMm: 44000, hp: 300, maxHp: 300, progress: 1, resource: 'food', amount: 350, farmState: 'ready', farmerAssigned: false });
    Object.assign(restored.entities.find(entity => entity.id === 'worker_0')!, { order: 'gather', cargo: { resource: 'wood', amount: 7 } });
    observePlaythrough(restored, memory); expect(memory.assignments.worker_0).toBe('wood'); expect(memory.farmAssignments.farm).toBe('worker_0');
    const commands = planPlaythrough(restored, memory);
    expect(commands.filter(command => command.kind === 'gather' && command.targetId === 'farm')).toEqual([{ kind: 'gather', unitIds: ['worker_0'], targetId: 'farm', queued: false }]);
    expect(memory.assignments.worker_0).toBe('food'); expect(memory.farmClaimsToRenew).toEqual({});
  });
  it('revisits explored public positions without resetting moving or engaged units', () => {
    const view = fixture(), memory = createPlaythroughMemory(); view.self.age = 4; view.self.resources = { food: 0, wood: 0, gold: 0, stone: 0 };
    view.entities.push({ id: 'scout', typeId: 'scout', kind: 'unit', ownerId: 'human', xMm: 35000, zMm: 35000, hp: 65, maxHp: 65, order: 'idle', taskState: 'idle' });
    for (const [id, order] of [['idle_army', 'idle'], ['moving_army', 'attack_move'], ['engaged_army', 'attack']] as const)
      view.entities.push({ id, typeId: 'militia', kind: 'unit', ownerId: 'human', xMm: 36000, zMm: 36000, hp: 55, maxHp: 55, order, taskState: order === 'idle' ? 'idle' : 'moving' });
    const commands = planPlaythrough(view, memory), scoutMove = commands.find(command => command.kind === 'move')!, armyMove = commands.find(command => command.kind === 'attack_move')!;
    expect(scoutMove).toMatchObject({ kind: 'move', unitIds: ['scout'] }); expect(armyMove).toMatchObject({ kind: 'attack_move', unitIds: ['idle_army'] });
    commands.forEach((command, index) => {
      const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: `sweep_${index}`, clientSequence: index + 1, command };
      expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope); playthroughReceipt(memory, { status: 'accepted', clientCommandId: envelope.clientCommandId, tick: view.tick, sequence: index + 1 });
    });
    const cooling = structuredClone(view); cooling.tick = 40; cooling.sequence++; cooling.self.lastCommandSequence = commands.length;
    expect(planPlaythrough(cooling, memory).some(command => command.kind === 'move' || command.kind === 'attack_move')).toBe(false);
    const moving = structuredClone(cooling); moving.tick = 200; moving.sequence++;
    for (const entity of moving.entities.filter(entity => entity.id === 'scout' || entity.id === 'idle_army')) { entity.order = entity.id === 'scout' ? 'move' : 'attack_move'; entity.taskState = 'moving'; }
    expect(planPlaythrough(moving, memory).some(command => command.kind === 'move' || command.kind === 'attack_move')).toBe(false);
    const arrived = structuredClone(moving); arrived.tick = 400; arrived.sequence++;
    if (scoutMove.kind !== 'move' || armyMove.kind !== 'attack_move') throw new Error('SWEEP_FIXTURE_MISSING');
    Object.assign(arrived.entities.find(entity => entity.id === 'scout')!, scoutMove.target, { order: 'idle', taskState: 'idle' });
    Object.assign(arrived.entities.find(entity => entity.id === 'idle_army')!, armyMove.target, { order: 'idle', taskState: 'idle' });
    const next = planPlaythrough(arrived, memory);
    expect(next.find(command => command.kind === 'move')).not.toMatchObject({ target: scoutMove.target });
    expect(next.find(command => command.kind === 'attack_move')).toMatchObject({ unitIds: ['idle_army'] });
  });
  it('admits continued ordinary search while a concealed surviving Scout prevents conquest', () => {
    const sim = createSimulation({ seed: 'playthrough-revisit', matchId: 'revisit', factions: fixture().players, controllers: false });
    const scout = Object.values(sim.state.entities).find((entity): entity is Unit => entity.kind === 'unit' && entity.ownerId === 'human' && entity.typeId === 'scout')!;
    const enemyScout = Object.values(sim.state.entities).find((entity): entity is Unit => entity.kind === 'unit' && entity.ownerId === 'enemy' && entity.typeId === 'scout')!;
    const home = Object.values(sim.state.entities).find((entity): entity is Building => entity.kind === 'building' && entity.ownerId === 'human' && entity.typeId === 'town_center')!;
    // Explicit endgame/search fixture, not a standard-start victory claim. The
    // policy sees only filtered views; the remaining enemy's position is withheld.
    for (const entity of Object.values(sim.state.entities)) if (![scout.id, enemyScout.id, home.id].includes(entity.id)) delete sim.state.entities[entity.id];
    Object.assign(scout, { xMm: 100000, zMm: 100000 }); Object.assign(home, { xMm: 120000, zMm: 120000 }); Object.assign(enemyScout, { xMm: 220000, zMm: 220000 });
    sim.state.economies.human!.age = 4; sim.state.economies.human!.resources = { food: 0, wood: 0, gold: 0, stone: 0 }; sim.state.navigationRevision++;
    sim.state.vision.human!.explored = Array.from({ length: sim.state.widthMm / 2000 * (sim.state.heightMm / 2000) }, (_, index) => index); sim.step();
    const memory = createPlaythroughMemory(), destinations: string[] = [];
    for (let tick = 0; tick < 240; tick++) {
      const view = sim.view('human'); expect(view.entities.some(entity => entity.ownerId === 'enemy')).toBe(false);
      for (const command of planPlaythrough(view, memory)) {
        const sequence = sim.state.economies.human!.lastClientSequence + 1;
        const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: `search_${sequence}`, clientSequence: sequence, command };
        playthroughCommandSent(memory, envelope); const receipt = sim.command('human', envelope); expect(receipt.status).toBe('accepted'); playthroughReceipt(memory, receipt);
        if (command.kind === 'move') destinations.push(JSON.stringify(command.target));
      }
      sim.step();
    }
    expect(sim.state.status).toBe('RUNNING'); expect(sim.state.economies.enemy!.defeated).toBe(false);
    expect(new Set(destinations).size).toBeGreaterThanOrEqual(2); expect(destinations.length).toBeLessThanOrEqual(3);
    expect(Math.hypot(scout.xMm - 100000, scout.zMm - 100000)).toBeGreaterThan(1000);
  });
});

describe('playthrough army continuation', () => {
  function assaultView(count = 12): PlayerView {
    const view = fixture(); view.self.age = 4; view.self.resources = { food: 0, wood: 0, gold: 0, stone: 0 };
    view.entities = view.entities.filter(entity => entity.typeId === 'town_center');
    for (let index = 0; index < count; index++) view.entities.push({ id: `army_${index}`, kind: 'unit', typeId: 'militia', ownerId: 'human', xMm: 30000 + index * 100, zMm: 38000, hp: units.militia.maxHp, maxHp: units.militia.maxHp, order: 'idle', taskState: 'idle' });
    for (const [id, xMm] of [['left', 58000], ['middle', 60000], ['right', 62000]] as const) view.entities.push({ id, kind: 'building', typeId: 'palisade_wall', ownerId: 'enemy', xMm, zMm: 44000, hp: buildings.palisade_wall.maxHp, maxHp: buildings.palisade_wall.maxHp, progress: 1 });
    return view;
  }
  function settle(view: PlayerView, memory: PlaythroughMemory, commands: GameplayCommand[], accepted = true): PlayerView {
    const next = structuredClone(view); next.tick += 100; next.sequence++; next.self.lastCommandSequence += commands.length;
    commands.forEach((command, index) => {
      const sequence = view.self.lastCommandSequence + index + 1, clientCommandId = `army_test_${sequence}`;
      playthroughCommandSent(memory, { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId, clientSequence: sequence, command });
      playthroughReceipt(memory, { status: accepted ? 'accepted' : 'rejected', clientCommandId, tick: view.tick, sequence, ...(accepted ? {} : { code: 'PATH_BUSY' }) });
      if (accepted && 'unitIds' in command) for (const id of command.unitIds) {
        const unit = next.entities.find(entity => entity.id === id)!;
        if (command.kind === 'attack_target') Object.assign(unit, { order: 'attack', taskState: 'moving' });
        else if (command.kind === 'attack_move') Object.assign(unit, { order: 'attack_move', taskState: 'moving' });
      }
    });
    return next;
  }
  const armyCommands = (commands: GameplayCommand[]) => commands.filter(command => command.kind === 'attack_target' || command.kind === 'attack_move');
  function replaceTarget(view: PlayerView): void {
    view.entities = view.entities.filter(entity => entity.ownerId !== 'enemy');
    view.entities.push({ id: 'next_enemy', kind: 'unit', typeId: 'villager', ownerId: 'enemy', xMm: 70000, zMm: 60000, hp: units.villager.maxHp, maxHp: units.villager.maxHp });
  }

  it('leaves an unchanged moving assault alone after30seconds and retries only its straggler and reinforcement', () => {
    const view = assaultView(), memory = createPlaythroughMemory(), first = planPlaythrough(view, memory);
    expect(armyCommands(first)).toMatchObject([{ kind: 'attack_target', targetId: 'middle' }]); expect(memory.lastArmyTarget).toBeUndefined(); expect(memory.assaultStarted).toBe(false);
    const moving = settle(view, memory, first); moving.tick = 620;
    expect(memory.lastArmyTarget).toBe('middle'); expect(memory.assaultStarted).toBe(true); expect(armyCommands(planPlaythrough(moving, memory))).toEqual([]);
    const joined = structuredClone(moving); joined.tick += 100; joined.sequence++;
    joined.entities.find(entity => entity.id === 'army_0')!.taskState = 'blocked';
    joined.entities.push({ ...joined.entities.find(entity => entity.id === 'army_1')!, id: 'reinforcement', order: 'idle', taskState: 'idle' });
    const before = JSON.stringify(joined), commands = planPlaythrough(joined, memory);
    expect(armyCommands(commands)).toEqual([{ kind: 'attack_target', unitIds: ['army_0', 'reinforcement'], targetId: 'middle', queued: false }]); expect(JSON.stringify(joined)).toBe(before);
    const acknowledged = settle(joined, memory, commands); expect(armyCommands(planPlaythrough(acknowledged, memory))).toEqual([]);
  });

  it('retains the accepted destination through rejected redirects and same-target retries', () => {
    const first = assaultView(), memory = createPlaythroughMemory(), current = settle(first, memory, planPlaythrough(first, memory));
    replaceTarget(current); const redirect = planPlaythrough(current, memory);
    expect(armyCommands(redirect)[0]).toMatchObject({ targetId: 'next_enemy', unitIds: Array.from({ length: 12 }, (_, index) => `army_${index}`) }); expect(memory.lastArmyTarget).toBe('middle');
    const rejected = settle(current, memory, redirect, false); expect(memory.lastArmyTarget).toBe('middle');
    const retry = planPlaythrough(rejected, memory); expect(armyCommands(retry)).toEqual(armyCommands(redirect));
    const accepted = settle(rejected, memory, retry); expect(memory.lastArmyTarget).toBe('next_enemy');
    const stale = structuredClone(accepted); stale.self.lastCommandSequence = rejected.self.lastCommandSequence;
    expect(armyCommands(planPlaythrough(stale, memory))).toEqual([]);
    accepted.tick += 100; accepted.sequence++; accepted.entities.find(entity => entity.id === 'army_0')!.taskState = 'blocked';
    const straggler = planPlaythrough(accepted, memory); expect(armyCommands(straggler)).toMatchObject([{ unitIds: ['army_0'] }]);
    const again = settle(accepted, memory, straggler, false); expect(memory.lastArmyTarget).toBe('next_enemy');
    expect(armyCommands(planPlaythrough(again, memory))).toEqual(armyCommands(straggler));
  });

  it('uses only a remembered coordinate when a breach is hidden and redirects when a different enemy is observed', () => {
    const first = assaultView(), memory = createPlaythroughMemory(), hidden = settle(first, memory, planPlaythrough(first, memory));
    hidden.entities = hidden.entities.filter(entity => !['left', 'right'].includes(entity.id));
    for (const entity of hidden.entities.filter(entity => entity.ownerId === 'enemy')) entity.ghost = true;
    expect(armyCommands(planPlaythrough(hidden, memory))).toEqual([]);
    hidden.tick += 100; hidden.sequence++; const waiting = hidden.entities.find(entity => entity.id === 'army_0')!; waiting.order = 'idle'; waiting.taskState = 'idle';
    const search = planPlaythrough(hidden, memory);
    expect(armyCommands(search)).toEqual([{ kind: 'attack_move', unitIds: ['army_0'], target: { xMm: 60000, zMm: 44000 }, queued: false }]);
    const observed = settle(hidden, memory, search); replaceTarget(observed);
    expect(armyCommands(planPlaythrough(observed, memory))[0]).toMatchObject({ kind: 'attack_target', targetId: 'next_enemy', unitIds: Array.from({ length: 12 }, (_, index) => `army_${index}`) });
    const noTarget = assaultView(3); noTarget.entities = noTarget.entities.filter(entity => entity.ownerId !== 'enemy');
    noTarget.fog.explored = []; expect(armyCommands(planPlaythrough(noTarget, createPlaythroughMemory()))).toEqual([]);
  });

  it('continues a smaller surviving assault across its own epoch but preserves healthy-base assembly and other identities', () => {
    const assembling = assaultView(3); expect(armyCommands(planPlaythrough(assembling, createPlaythroughMemory()))).toEqual([]);
    const first = assaultView(), memory = createPlaythroughMemory(), survivors = settle(first, memory, planPlaythrough(first, memory));
    survivors.entities = survivors.entities.filter(entity => !entity.id.startsWith('army_') || Number(entity.id.slice(5)) < 3); replaceTarget(survivors);
    expect(armyCommands(planPlaythrough(survivors, memory))[0]).toMatchObject({ kind: 'attack_target', targetId: 'next_enemy', unitIds: ['army_0', 'army_1', 'army_2'] });
    const restored = structuredClone(survivors); restored.matchEpoch++; restored.sequence = 1; restored.status = 'PAUSED';
    observePlaythrough(restored, memory); expect(memory.assaultStarted).toBe(true); expect(memory.lastArmyTarget).toBeUndefined(); expect(memory.pending).toEqual([]);
    restored.status = 'RUNNING'; restored.sequence++; expect(armyCommands(planPlaythrough(restored, memory))[0]).toMatchObject({ targetId: 'next_enemy', unitIds: ['army_0', 'army_1', 'army_2'] });
    observePlaythrough({ ...restored, matchId: 'different_match' }, memory); expect(memory.assaultStarted).toBe(false);
    memory.assaultStarted = true; observePlaythrough({ ...restored, matchId: 'different_match', playerId: 'enemy' }, memory); expect(memory.assaultStarted).toBe(false);
  });

  function combatSimulation(): { sim: Simulation; army: Unit[]; observer: Unit; home: Building; target: Building } {
    const sim = createSimulation({ seed: 'playthrough-path-preservation', matchId: 'path-preservation', factions: fixture().players, controllers: false, sharedVision: false });
    const original = Object.values(sim.state.entities), template = original.find((entity): entity is Unit => entity.kind === 'unit' && entity.typeId === 'villager')!;
    const home = original.find((entity): entity is Building => entity.kind === 'building' && entity.ownerId === 'human' && entity.typeId === 'town_center')!, enemyHome = original.find((entity): entity is Building => entity.kind === 'building' && entity.ownerId === 'enemy' && entity.typeId === 'town_center')!;
    // Explicit mechanics fixture. No path/search state is fabricated; all attack
    // orders and route work below use the normal simulation command/step path.
    sim.state.entities = {}; sim.state.widthMm = sim.state.heightMm = 320000;
    Object.assign(home, { xMm: 30000, zMm: 30000 }); Object.assign(enemyHome, { xMm: 280000, zMm: 280000 }); sim.state.entities[home.id] = home; sim.state.entities[enemyHome.id] = enemyHome;
    const makeUnit = (id: string, typeId: 'militia' | 'scout', xMm: number, zMm: number): Unit => {
      const entity: Unit = { ...structuredClone(template), id, typeId, ownerId: 'human', xMm, zMm, hp: units[typeId].maxHp, maxHp: units[typeId].maxHp, orders: [], path: [], stance: 'stand_ground' };
      sim.state.entities[id] = entity; return entity;
    };
    const army = Array.from({ length: 12 }, (_, index) => makeUnit(`soldier_${index}`, 'militia', index === 11 ? 130000 : 50000, 110000 + index * 1000)), observer = makeUnit('observer', 'scout', 150000, 101000);
    let target!: Building;
    for (const [id, xMm] of [['left', 148000], ['middle', 150000], ['right', 152000]] as const) {
      const def = buildings.palisade_wall, required = def.buildSeconds * balance.rules.simulationHz * 100;
      const wall: Building = { id, typeId: 'palisade_wall', ownerId: 'enemy', kind: 'building', xMm, zMm: 110000, hp: def.maxHp, maxHp: def.maxHp, grantedHp: def.maxHp, rotation: 0, work: required, required, queue: [], cooldown: 0 };
      sim.state.entities[id] = wall; if (id === 'middle') target = wall;
    }
    sim.state.map.terrain = [{ id: 'detour', kind: 'water', xMm: 100000, zMm: 90000, widthMm: 2000, depthMm: 60000, elevationMm: 0 }];
    for (const vision of Object.values(sim.state.vision)) { vision.memory = {}; vision.actions = {}; vision.explored = []; }
    sim.state.economies.human!.age = 4; sim.state.economies.human!.resources = { food: 0, wood: 0, gold: 0, stone: 0 }; sim.state.navigationRevision++; sim.step();
    // Keep the test's target continuously observed through an ordinary short
    // patrol. Free exploration could hide it and legitimately change priority.
    expect(sim.command('human', { protocolVersion: 2, matchId: sim.state.matchId, matchEpoch: sim.state.matchEpoch, clientCommandId: 'observer_patrol', clientSequence: 1,
      command: { kind: 'patrol', unitIds: [observer.id], points: [{ xMm: 150000, zMm: 101000 }, { xMm: 150000, zMm: 100000 }], queued: false } }).status).toBe('accepted');
    return { sim, army, observer, home, target };
  }
  function dispatch(sim: Simulation, memory: PlaythroughMemory, commands: GameplayCommand[]): void {
    for (const command of commands) {
      const sequence = sim.state.economies.human!.lastClientSequence + 1, envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: sim.state.matchId, matchEpoch: sim.state.matchEpoch, clientCommandId: `real_army_${sequence}`, clientSequence: sequence, command };
      expect(validateClientCommand(envelope)).toBe(true); playthroughCommandSent(memory, envelope); const receipt = sim.command('human', envelope); expect(receipt.status).toBe('accepted'); playthroughReceipt(memory, receipt);
    }
  }

  it('preserves actual pending scheduler work and a ready route when an idle reinforcement joins', () => {
    const { sim, army } = combatSimulation(), memory = createPlaythroughMemory(); dispatch(sim, memory, planPlaythrough(sim.view('human'), memory));
    for (let tick = 0; tick < 60 && !(army.some(unit => unit.path.length > 0) && sim.capture().runtime.pathScheduler.tasks.some(task => task.stage !== 'done')); tick++) sim.step();
    expect(army.some(unit => unit.path.length > 0)).toBe(true); const beforeTasks = sim.capture().runtime.pathScheduler.tasks; expect(beforeTasks.some(task => task.stage !== 'done')).toBe(true);
    const before = structuredClone(army), reinforcement: Unit = { ...structuredClone(army[0]!), id: 'new_soldier', xMm: 47000, orders: [], path: [], taskState: 'idle' };
    delete reinforcement.pathRequestId; delete reinforcement.pathDestination; delete reinforcement.pathRegions; sim.state.entities[reinforcement.id] = reinforcement;
    // Make the harness decision due at this real in-flight boundary; do not alter
    // any simulation route, scheduler budget, tick, or unit progress for the test.
    memory.nextDecisionTick = sim.state.tick; memory.lastArmyOrderTick = sim.state.tick - 100;
    const commands = planPlaythrough(sim.view('human'), memory);
    expect(armyCommands(commands)).toEqual([{ kind: 'attack_target', unitIds: [reinforcement.id], targetId: 'middle', queued: false }]); dispatch(sim, memory, commands);
    expect(army).toEqual(before); expect(sim.capture().runtime.pathScheduler.tasks).toEqual(beforeTasks); expect(reinforcement.orders[0]).toMatchObject({ kind: 'attack', targetId: 'middle' });
  });

  it('restores military-only control before AgeIV and attacks only the wall revealed by its own scout', () => {
    const { sim, army, observer, home, target } = combatSimulation();
    for (const unit of army.slice(1)) delete sim.state.entities[unit.id]; delete sim.state.entities[home.id]; sim.state.economies.human!.age = 3; sim.state.navigationRevision++; sim.step();
    expect(Math.hypot(army[0]!.xMm - target.xMm, army[0]!.zMm - target.zMm)).toBeGreaterThan(units.militia.visionM * 1000);
    expect(Math.hypot(observer.xMm - target.xMm, observer.zMm - target.zMm)).toBeLessThan(units.scout.visionM * 1000);
    const identity: EngineIdentity = { engineBuildHash: '6'.repeat(64), runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch } }, memory = createPlaythroughMemory(); observePlaythrough(sim.view('human'), memory);
    const restored = restoreSimulation(exportSimulationSave(sim, identity), identity); observePlaythrough(restored.view('human'), memory); expect(memory.home).toBeUndefined(); expect(memory.assaultStarted).toBe(false); restored.setStatus('RUNNING');
    const view = restored.view('human'); expect(view.entities.some(entity => entity.id === target.id && !entity.ghost)).toBe(true);
    const commands = planPlaythrough(view, memory); expect(armyCommands(commands)).toEqual([{ kind: 'attack_target', unitIds: [army[0]!.id], targetId: target.id, queued: false }]);
    expect(commands.some(command => 'builderIds' in command || command.kind === 'gather' || command.kind === 'train')).toBe(false); dispatch(restored, memory, commands);
    expect((restored.state.entities[army[0]!.id] as Unit).orders[0]).toMatchObject({ kind: 'attack', targetId: target.id }); expect(memory.assaultStarted).toBe(true);
  });

  it('continues a scout-only survivor after epoch reset without claiming construction ability', () => {
    const view = assaultView(0); view.entities = [{ id: 'last_scout', kind: 'unit', typeId: 'scout', ownerId: 'human', xMm: 30000, zMm: 30000, hp: units.scout.maxHp, maxHp: units.scout.maxHp, order: 'idle', taskState: 'idle' }];
    const memory = createPlaythroughMemory(); observePlaythrough(view, memory); view.matchEpoch++; view.sequence = 1; view.status = 'PAUSED'; observePlaythrough(view, memory); view.status = 'RUNNING'; view.sequence++;
    expect(planPlaythrough(view, memory)).toEqual([expect.objectContaining({ kind: 'move', unitIds: ['last_scout'] })]); expect(memory.telemetry.lastBlocked).not.toBe('NO_SURVIVING_BASE_OR_WORKER');
  });
});

describe('playthrough evidence from filtered observations', () => {
  const structure = (id: string, typeId: 'farm' | 'palisade_wall' | 'wooden_gate', ownerId = 'human', xMm = 30000): ViewEntity => ({ id, typeId, ownerId, kind: 'building', xMm, zMm: 44000, hp: 300, maxHp: 300, progress: 1, ...(typeId === 'farm' ? { resource: 'food' as const, amount: 350, farmState: 'ready' as const } : {}) });
  it('requires live completed owned geometry, not a ghost, unfinished foundation or accepted receipt', () => {
    const view = fixture(), memory = createPlaythroughMemory(); view.entities.push({ ...structure('farm', 'farm'), progress: .99 }, { ...structure('wall', 'palisade_wall'), ghost: true }, structure('gate', 'wooden_gate', 'enemy'));
    observePlaythrough(view, memory); expect(Object.values(memory.telemetry.evidence).every(item => !item.met)).toBe(true);
    view.entities = view.entities.filter(entity => !['farm', 'wall', 'gate'].includes(entity.id)); view.entities.push(structure('farm', 'farm'), structure('wall', 'palisade_wall'), structure('gate', 'wooden_gate')); view.tick = 20; view.sequence++;
    observePlaythrough(view, memory); for (const key of ['completedFarm', 'completedWall', 'completedGate'] as const) expect(memory.telemetry.evidence[key]).toMatchObject({ met: true, observedTick: 20, proof: 'owned_live_completed_structure' });
  });
  it('does not equate rounded zero, disappearance or hidden depletion with exact exhaustion', () => {
    const view = fixture(), memory = createPlaythroughMemory(); view.entities.push(structure('farm', 'farm')); observePlaythrough(view, memory);
    const zero = structuredClone(view); zero.tick = 20; zero.sequence++; zero.entities.find(entity => entity.id === 'forage')!.amount = 0;
    observePlaythrough(zero, memory); expect(memory.telemetry.evidence.resourceZeroObserved.met).toBe(true); expect(memory.telemetry.evidence.resourceDepletion.met).toBe(false);
    const hidden = structuredClone(zero); hidden.tick = 40; hidden.sequence++; Object.assign(hidden.entities.find(entity => entity.id === 'farm')!, { amount: 0, farmState: 'exhausted', ghost: true }); hidden.entities = hidden.entities.filter(entity => entity.id !== 'forage');
    observePlaythrough(hidden, memory); expect(memory.telemetry.evidence.resourceDepletion.met).toBe(false);
    const exhausted = structuredClone(hidden); exhausted.tick = 60; exhausted.sequence++; exhausted.entities.find(entity => entity.id === 'farm')!.ghost = false;
    observePlaythrough(exhausted, memory); expect(memory.telemetry.evidence.resourceDepletion).toMatchObject({ met: true, entityId: 'farm', resource: 'food', proof: 'positive_owned_farm_observed_exhausted_or_reseeding' });
    expect(memory.telemetry.evidence.naturalNodeDepletion.met).toBe(false);
  });
  it('can corroborate natural-node exhaustion using its accepted worker and explicit depletion reason', () => {
    const view = fixture(), memory = createPlaythroughMemory(), commands = planPlaythrough(view, memory), command = commands.find(command => command.kind === 'gather')!;
    expect(command.kind).toBe('gather'); playthroughCommandSent(memory, { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'gather', clientSequence: 1, command }); playthroughReceipt(memory, { status: 'accepted', clientCommandId: 'gather', tick: 0, sequence: 1 });
    const next = structuredClone(view); next.tick = 20; next.sequence++; next.entities.find(entity => entity.id === 'forage')!.amount = 0;
    Object.assign(next.entities.find(entity => entity.id === ('unitIds' in command ? command.unitIds[0] : ''))!, { order: 'idle', blockedReason: 'RESOURCE_DEPLETED' });
    observePlaythrough(next, memory); expect(memory.telemetry.evidence.resourceDepletion).toMatchObject({ met: true, entityId: 'forage', proof: 'reported_zero_and_owned_gatherer_resource_depleted' });
    expect(memory.telemetry.evidence.naturalNodeDepletion).toMatchObject({met:true,entityId:'forage',proof:'reported_zero_and_owned_gatherer_resource_depleted'});
  });
  it('uses only a later notification for the accepted gatherer in the same epoch', () => {
    for (const scenario of ['current', 'older', 'same_tick', 'other_worker', 'future', 'other_epoch', 'nonzero'] as const) {
      const view = fixture(), memory = createPlaythroughMemory(); view.tick = 10; view.sequence = 10;
      const command = planPlaythrough(view, memory).find(command => command.kind === 'gather')!;
      if (command.kind !== 'gather') throw new Error('GATHER_FIXTURE_MISSING');
      playthroughCommandSent(memory, { protocolVersion: 2, matchId: view.matchId, matchEpoch: 1, clientCommandId: 'gather', clientSequence: 1, command });
      playthroughReceipt(memory, { status: 'accepted', clientCommandId: 'gather', tick: 10, sequence: 1 });
      const next = structuredClone(view); next.tick = 20; next.sequence = 20;
      next.entities.find(entity => entity.id === command.targetId)!.amount = scenario === 'nonzero' ? 1 : 0;
      next.self.notifications = [{ id: 'depleted', code: 'RESOURCE_DEPLETED', entityId: scenario === 'other_worker' ? 'worker_not_assigned' : command.unitIds[0], tick: scenario === 'older' ? 9 : scenario === 'same_tick' ? 10 : scenario === 'future' ? 21 : 11 }];
      if (scenario === 'other_epoch') next.matchEpoch = 2;
      observePlaythrough(next, memory);
      expect(memory.telemetry.evidence.naturalNodeDepletion.met, scenario).toBe(scenario === 'current');
    }
  });
  it('records real exhaustion between 10 Hz views after the one-tick reason has cleared', () => {
    const sim = createSimulation({ seed: 'playthrough-depletion', matchId: 'depletion', factions: fixture().players, controllers: false });
    // Isolated observation fixture: one small node beside a legal drop-off. The
    // gather, exhaustion, deposit and notification all run through the engine.
    for (const entity of Object.values(sim.state.entities)) if (entity.kind === 'resource') delete sim.state.entities[entity.id];
    const home = Object.values(sim.state.entities).find((entity): entity is Building => entity.kind === 'building' && entity.ownerId === 'human' && entity.typeId === 'town_center')!;
    const worker = Object.values(sim.state.entities).find((entity): entity is Unit => entity.kind === 'unit' && entity.ownerId === 'human' && entity.typeId === 'villager')!;
    Object.assign(home, { xMm: 120000, zMm: 120000 }); Object.assign(worker, { xMm: 127000, zMm: 120000 });
    sim.state.entities.small_tree = { id: 'small_tree', ownerId: null, kind: 'resource', typeId: 'tree_oak', resource: 'wood', amount: 1000, xMm: 128000, zMm: 120000, hp: 1, maxHp: 1 };
    sim.state.economies.human!.resources = { food: 0, wood: 0, gold: 0, stone: 0 }; sim.state.navigationRevision++; sim.step();
    const memory = createPlaythroughMemory(), initial = sim.view('human');
    const command = planPlaythrough(initial, memory).find(command => command.kind === 'gather' && command.unitIds.includes(worker.id))!;
    if (command.kind !== 'gather') throw new Error('GATHER_FIXTURE_MISSING');
    const envelope: ClientCommandEnvelope = { protocolVersion: 2, matchId: initial.matchId, matchEpoch: initial.matchEpoch, clientCommandId: 'actual_gather', clientSequence: 1, command };
    playthroughCommandSent(memory, envelope); const receipt = sim.command('human', envelope); expect(receipt.status).toBe('accepted'); playthroughReceipt(memory, receipt);
    const sampled: PlayerView[] = [];
    for (let tick = 0; tick < 60; tick++) {
      sim.step();
      if ((sim.state.tick - initial.tick) % 2 === 0) { const view = sim.view('human'); sampled.push(view); observePlaythrough(view, memory); }
    }
    const notice = sim.view('human').self.notifications!.find(notice => notice.entityId === worker.id && notice.code === 'RESOURCE_DEPLETED')!;
    expect(notice).toBeDefined(); expect((notice.tick - initial.tick) % 2).toBe(1);
    expect(sampled.every(view => view.entities.find(entity => entity.id === worker.id)?.blockedReason !== 'RESOURCE_DEPLETED')).toBe(true);
    expect(sim.state.entities.small_tree).toMatchObject({ amount: 0 }); expect(sim.view('human').self.resources.wood).toBe(1);
    expect(memory.telemetry.evidence.naturalNodeDepletion).toMatchObject({ met: true, entityId: 'small_tree', observedTick: notice.tick + 1 });
  });
  it('requires authorized damage and a named death of a previously connected hostile wall', () => {
    const initial = fixture(); initial.entities.push(structure('left', 'palisade_wall', 'enemy', 28000), structure('middle', 'palisade_wall', 'enemy', 30000), structure('right', 'palisade_wall', 'enemy', 32000));
    const memory = createPlaythroughMemory(); observePlaythrough(initial, memory);
    const hidden = structuredClone(initial); hidden.tick = 10; hidden.sequence++; hidden.entities.find(entity => entity.id === 'middle')!.ghost = true;
    observePlaythrough(hidden, memory); expect(memory.telemetry.evidence.fortificationBreach.met).toBe(false);
    const missing = structuredClone(hidden); missing.tick = 20; missing.sequence++; missing.entities = missing.entities.filter(entity => entity.id !== 'middle');
    observePlaythrough(missing, memory); expect(memory.telemetry.evidence.fortificationBreach.met).toBe(false);
    const destroyed = structuredClone(missing); destroyed.tick = 21; destroyed.sequence++; destroyed.effects = [{ id: 'hit', entityId: 'middle', kind: 'hit', typeId: 'palisade_wall', ownerId: 'enemy', tick: 21, xMm: 30000, zMm: 44000 }, { id: 'death', entityId: 'middle', kind: 'death', typeId: 'palisade_wall', ownerId: 'enemy', tick: 21, xMm: 30000, zMm: 44000 }];
    observePlaythrough(destroyed, memory); expect(memory.telemetry.evidence.fortificationBreach).toMatchObject({ met: true, entityId: 'middle', adjacentFortificationIds: ['left', 'right'], proof: 'authorized_damaged_connected_fortification_death' });
    const newEpoch = createPlaythroughMemory(); observePlaythrough(initial, newEpoch); observePlaythrough({ ...destroyed, matchEpoch: 2 }, newEpoch); expect(newEpoch.telemetry.evidence.fortificationBreach.met).toBe(false);
    const noDamage = createPlaythroughMemory(); observePlaythrough(initial, noDamage); observePlaythrough({ ...destroyed, effects: destroyed.effects.filter(effect => effect.kind === 'death') }, noDamage); expect(noDamage.telemetry.evidence.fortificationBreach.met).toBe(false);
  });
});
