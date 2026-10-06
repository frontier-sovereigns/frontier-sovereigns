import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSimulation } from '@frontier/simulation';
import {
  ages, balance, buildings, technologies, units, terrainBuildable,
  type BuildingId, type GameplayCommand, type PlayerView, type Position,
  type PublicPlayer, type ResourceBank, type ResourceType, type ViewEntity,
} from '@frontier/shared';

// A reproducible ordinary-resource M4 scenario. Decisions use only Blue's filtered
// view; authoritative reads below verify accounting and timing, never change state.
const seed = process.env.PROGRESSION_SEED ?? 'm4-normal-ages-20260919';
const tickLimit = Number(process.env.PROGRESSION_TICKS ?? 36000);
assert(Number.isInteger(tickLimit) && tickLimit > 0 && tickLimit <= 72000, 'INVALID_PROGRESSION_TICKS');
const factions: PublicPlayer[] = [
  { id: 'blue', name: 'Blue', teamId: 'blue', color: '#3388ff', kind: 'human' },
  { id: 'red', name: 'Red', teamId: 'red', color: '#ee7744', kind: 'human' },
];
const sim = createSimulation({ seed, mapType: 'river_divide', matchId: 'normal-ages', factions, controllers: false });
const initial = sim.view('blue'), homeId = initial.entities.find(entity => entity.ownerId === 'blue' && entity.typeId === 'town_center')!.id;
assert.deepEqual(initial.self.resources, balance.start.resources);
assert.equal(initial.self.age, 1);
const hz = balance.rules.simulationHz, scale = balance.rules.resourceScale, grid = balance.rules.buildingGridM * 1000;
const distance = (a: Position, b: Position) => Math.hypot(a.xMm - b.xMm, a.zMm - b.zMm);
const affordable = (view: PlayerView, cost: ResourceBank) => balance.resourceOrder.every(resource => view.self.resources[resource] >= cost[resource]);
const assignments = new Map<string, ResourceType>(), farmAssignments = new Map<string, string>();
const lastOrder = new Map<string, number>(), lastTarget = new Map<string, string>();
const rejected: Record<string, number> = {};
let sequence = 0, siteAttempt = 0, scoutIndex = 0;
type Structure = Extract<GameplayCommand,{kind:'build'}>['buildingType'];
type TrackedJob = { id: string; typeId: string; acceptedTick: number; seconds: number; cost: ResourceBank; start?: number; end?: number };
const tracked: TrackedJob[] = [];

function issue(command: GameplayCommand): boolean {
  const view = sim.view('blue'), clientSequence = ++sequence;
  const receipt = sim.command('blue', { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch,
    clientCommandId: `progression_${clientSequence}`, clientSequence, command });
  if (receipt.status === 'rejected') rejected[receipt.code ?? 'UNKNOWN'] = (rejected[receipt.code ?? 'UNKNOWN'] ?? 0) + 1;
  return receipt.status === 'accepted';
}

function forgetAssignment(workerId: string): void {
  assignments.delete(workerId);
  for (const [farmId, id] of farmAssignments) if (id === workerId) farmAssignments.delete(farmId);
}

function gather(worker: ViewEntity, target: ViewEntity, tick: number): boolean {
  if (!issue({ kind: 'gather', unitIds: [worker.id], targetId: target.id, queued: false })) return false;
  forgetAssignment(worker.id); assignments.set(worker.id, target.resource!);
  lastOrder.set(worker.id, tick); lastTarget.set(worker.id, target.id);
  if (target.typeId === 'farm') farmAssignments.set(target.id, worker.id);
  return true;
}

function tryBuild(view: PlayerView, typeId: Structure, workers: ViewEntity[], own: ViewEntity[]): boolean {
  const def = buildings[typeId], home = own.find(entity => entity.id === homeId)!;
  if (!affordable(view, def.cost) || own.some(entity => entity.kind === 'building' && (entity.progress ?? 1) < 1)) return false;
  const candidates: { x: number; z: number }[] = [], visible = new Set(view.fog.visible), columns = view.map.widthMm / view.map.fogCellMm;
  const resource = typeId === 'mill' ? 'food' : typeId === 'lumber_camp' ? 'wood' : typeId === 'mining_camp' ? 'gold' : undefined;
  const anchor = resource ? view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && entity.resource === resource && (entity.amount ?? 0) > 0)
    .sort((a, b) => distance(a, home) - distance(b, home))[0] ?? home : home;
  for (let z = -18; z <= 18; z += 2) for (let x = -18; x <= 18; x += 2) candidates.push({ x: Math.floor(home.xMm / grid) + x, z: Math.floor(home.zMm / grid) + z });
  const center = (cell: { x: number; z: number }) => ({ xMm: (cell.x + def.footprintCells[0] / 2) * grid, zMm: (cell.z + def.footprintCells[1] / 2) * grid });
  const legal = candidates.filter(cell => {
    const left = cell.x * grid, top = cell.z * grid, width = def.footprintCells[0] * grid, depth = def.footprintCells[1] * grid;
    if (left < 0 || top < 0 || left + width > view.map.widthMm || top + depth > view.map.heightMm) return false;
    if (!terrainBuildable(view.map.terrain ?? [], { xMm: left, zMm: top, widthMm: width, depthMm: depth })) return false;
    for (let z = top; z < top + depth; z += view.map.fogCellMm) for (let x = left; x < left + width; x += view.map.fogCellMm)
      if (!visible.has(Math.floor(z / view.map.fogCellMm) * columns + Math.floor(x / view.map.fogCellMm))) return false;
    const point = center(cell);
    return !view.entities.some(entity => {
      if (entity.ghost || entity.kind === 'resource' && (entity.amount ?? 0) === 0 || entity.garrisonedIn) return false;
      if (entity.kind === 'unit') {
        const radius = units[entity.typeId].collisionRadiusM * 1000 + 100;
        return Math.hypot(Math.max(left - entity.xMm, 0, entity.xMm - left - width), Math.max(top - entity.zMm, 0, entity.zMm - top - depth)) < radius;
      }
      let halfWidth = entity.kind === 'building' ? buildings[entity.typeId].footprintCells[0] * grid / 2 : entity.resource === 'wood' ? 450 : 650;
      let halfDepth = entity.kind === 'building' ? buildings[entity.typeId].footprintCells[1] * grid / 2 : halfWidth;
      if ((entity.rotation ?? 0) % 180) [halfWidth, halfDepth] = [halfDepth, halfWidth];
      // Leave walking lanes between buildings; the server still proves the route.
      return Math.abs(entity.xMm - point.xMm) < halfWidth + width / 2 + 1000 && Math.abs(entity.zMm - point.zMm) < halfDepth + depth / 2 + 1000;
    });
  }).sort((a, b) => distance(center(a), anchor) - distance(center(b), anchor) || a.z - b.z || a.x - b.x);
  if (!legal.length) return false;
  const site = legal[siteAttempt % Math.min(legal.length, 12)]!;
  const worker = workers.filter(entity => !['build', 'reseed'].includes(entity.order ?? '')).sort((a, b) => distance(a, center(site)) - distance(b, center(site)))[0];
  if (!worker) return false;
  if (!issue({ kind: 'build', buildingType: typeId, builderIds: [worker.id], originCell: site, rotation: 0, queued: false })) { siteAttempt++; return false; }
  siteAttempt = 0; forgetAssignment(worker.id); return true;
}

function enqueueProgression(command: Extract<GameplayCommand, { kind: 'advance_age' | 'research' }>, seconds: number, cost: ResourceBank): void {
  const before = { ...sim.state.economies.blue!.resources };
  if (!issue(command)) return;
  for (const resource of balance.resourceOrder) assert.equal(sim.state.economies.blue!.resources[resource], before[resource] - cost[resource] * scale, `EXACT_ENQUEUE_COST_${resource}`);
  const producerId = command.kind === 'advance_age' ? command.townCenterId : command.buildingId;
  const producer = sim.state.entities[producerId]; assert(producer?.kind === 'building');
  const job = producer.queue.at(-1)!;
  tracked.push({ id: job.id, typeId: job.typeId, acceptedTick: sim.state.tick, seconds, cost: { ...cost } });
  console.log(JSON.stringify({ event: 'progression_enqueued', tick: sim.state.tick, typeId: job.typeId, seconds, cost }));
}

function control(view: PlayerView): void {
  const own = view.entities.filter(entity => entity.ownerId === view.playerId), workers = own.filter(entity => entity.typeId === 'villager');
  const home = own.find(entity => entity.id === homeId)!;
  assert(home, 'STARTING_TOWN_CENTER_SURVIVES');
  const complete = (type: BuildingId) => own.some(entity => entity.typeId === type && entity.progress === 1);
  const exists = (type: BuildingId) => own.some(entity => entity.typeId === type);
  const forage = view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && entity.resource === 'food').reduce((sum, entity) => sum + (entity.amount ?? 0), 0);
  const farms = own.filter(entity => entity.typeId === 'farm');
  for (const [id] of assignments) if (!workers.some(worker => worker.id === id && ['gather', 'reseed'].includes(worker.order ?? ''))) forgetAssignment(id);
  for (const [farmId, workerId] of farmAssignments) if (!farms.some(farm => farm.id === farmId) || !workers.some(worker => worker.id === workerId && ['gather', 'reseed'].includes(worker.order ?? ''))) farmAssignments.delete(farmId);

  const scout = own.find(entity => entity.typeId === 'scout');
  if (scout && (scout.order === 'idle' || scout.taskState === 'blocked') && view.tick - (lastOrder.get(scout.id) ?? -1000) >= 5 * hz) {
    const offsets = [[-30000, -30000], [30000, -30000], [30000, 30000], [-30000, 30000]];
    const [dx, dz] = offsets[scoutIndex++ % offsets.length]!;
    if (issue({ kind: 'move', unitIds: [scout.id], target: { xMm: home.xMm + dx!, zMm: home.zMm + dz! }, queued: false })) lastOrder.set(scout.id, view.tick);
  }
  if (farms.length && !view.self.autoReseed) issue({ kind: 'set_auto_reseed', enabled: true });
  const desired = { food: Math.ceil(workers.length * .5), wood: Math.ceil(workers.length * .35), gold: Math.max(1, workers.length - Math.ceil(workers.length * .5) - Math.ceil(workers.length * .35)), stone: 0 };
  const freeFarms = () => farms.filter(farm => farm.progress === 1 && (farm.amount ?? 0) > 0 && !farm.farmerAssigned && !farmAssignments.has(farm.id));
  const targets = (worker: ViewEntity, resource: ResourceType) => [...view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && entity.resource === resource && (entity.amount ?? 0) > 0), ...(resource === 'food' ? freeFarms() : [])]
    .sort((a, b) => Number(a.id === lastTarget.get(worker.id) && worker.taskState === 'blocked') - Number(b.id === lastTarget.get(worker.id) && worker.taskState === 'blocked') || distance(a, worker) - distance(b, worker));
  for (const worker of workers) {
    const idle = worker.order === 'idle' || worker.blockedReason === 'FARM_OCCUPIED';
    const retry = worker.taskState === 'blocked' && worker.order === 'gather' && view.tick - (lastOrder.get(worker.id) ?? 0) >= 10 * hz;
    if (!idle && !retry) continue;
    forgetAssignment(worker.id);
    const count = (resource: ResourceType) => [...assignments.values()].filter(value => value === resource).length;
    const priorities = (['food', 'wood', 'gold'] as const).slice().sort((a, b) => (desired[b] - count(b)) / desired[b] - (desired[a] - count(a)) / desired[a]);
    for (const resource of priorities) { const target = targets(worker, resource)[0]; if (target && gather(worker, target, view.tick)) break; }
  }
  // Move one surplus logger to an available food source as farms become ready.
  if ([...assignments.values()].filter(value => value === 'food').length < desired.food) {
    const worker = workers.find(entity => entity.order === 'gather' && assignments.get(entity.id) === 'wood');
    const target = worker && targets(worker, 'food')[0]; if (worker && target) gather(worker, target, view.tick);
  }
  let needed: Structure | undefined;
  if (workers.length < 20 && view.self.population + view.self.reservedPopulation >= view.self.populationCap - 2) needed = 'house';
  else if (!exists('mill')) needed = 'mill';
  else if (!exists('lumber_camp')) needed = 'lumber_camp';
  else if (!exists('mining_camp')) needed = 'mining_camp';
  else if (forage < 350 && farms.length < desired.food) needed = 'farm';
  else if (view.self.age >= 2 && !exists('market')) needed = 'market';
  else if (view.self.age >= 2 && !exists('blacksmith')) needed = 'blacksmith';
  else if (view.self.age >= 3 && !exists('siege_workshop')) needed = 'siege_workshop';
  else if (view.self.age >= 3 && !exists('university')) needed = 'university';
  if (needed) tryBuild(view, needed, workers, own);

  // Refresh only the authorized view after spending; no bank is read from another faction.
  const current = sim.view('blue'), town = current.entities.find(entity => entity.id === homeId)!;
  const pendingAge = own.some(entity => entity.queue?.some(job => job.typeId.startsWith('age_')));
  if (current.self.age < 4 && !pendingAge) {
    const next = ages[current.self.age + 1]!;
    const ready = next.prerequisites.every(rule => rule.kind === 'completed_buildings' ? rule.types.every(complete) : rule.types.filter(complete).length >= rule.count);
    if (ready && affordable(current, next.cost)) enqueueProgression({ kind: 'advance_age', townCenterId: homeId, targetAge: next.id as 2 | 3 | 4 }, next.researchSeconds, next.cost);
  }
  const afterAge = sim.view('blue'), lumber = afterAge.entities.find(entity => entity.ownerId === 'blue' && entity.typeId === 'lumber_camp' && entity.progress === 1), forestry = technologies.forestry_1;
  if (afterAge.self.age >= forestry.minAge && lumber && !afterAge.self.technologies?.includes(forestry.id) && !lumber.queue?.some(job => job.typeId === forestry.id) && affordable(afterAge, forestry.cost))
    enqueueProgression({ kind: 'research', buildingId: lumber.id, technologyId: forestry.id }, forestry.researchSeconds, forestry.cost);
  const afterResearch = sim.view('blue');
  if (workers.length < 20 && (town.queue?.length ?? 0) === 0 && affordable(afterResearch, units.villager.cost)) issue({ kind: 'train', buildingId: homeId, unitType: 'villager', quantity: 1 });
}

const initialNodes = Object.fromEntries(balance.resourceOrder.map(resource => [resource, Object.values(sim.state.entities).reduce((sum, entity) => sum + (entity.kind === 'resource' && entity.resource === resource ? entity.amount : 0), 0)]));
const previousFarm = new Map<string, number>(); let farmHarvest = 0;
const started = performance.now();
console.log(JSON.stringify({ event: 'start', seed, mapType: 'river_divide', tickLimit, mutations: 'ordinary player commands only', controllerInformation: 'filtered Blue PlayerView', opponent: 'idle second human faction' }));
for (let tick = 0; tick < tickLimit && sim.state.status === 'RUNNING'; tick++) {
  if (sim.state.tick % hz === 0) control(sim.view('blue'));
  sim.step();
  const entities = Object.values(sim.state.entities);
  for (const economy of Object.values(sim.state.economies)) for (const resource of balance.resourceOrder) assert(Number.isSafeInteger(economy.resources[resource]) && economy.resources[resource] >= 0, 'BANK_INVARIANT');
  for (const entity of entities) if (entity.kind === 'building' && entity.typeId === 'farm') {
    const amount = entity.foodRemaining ?? 0, previous = previousFarm.get(entity.id) ?? 0;
    if (amount < previous) farmHarvest += previous - amount;
    previousFarm.set(entity.id, amount);
  }
  for (const record of tracked.filter(record => record.end === undefined)) {
    const job = entities.flatMap(entity => entity.kind === 'building' ? entity.queue : []).find(job => job.id === record.id);
    if (job?.started && record.start === undefined) record.start = sim.state.tick;
    if (!job) {
      assert(record.start !== undefined, 'JOB_STARTED_BEFORE_COMPLETION'); record.end = sim.state.tick;
      assert.equal(record.end - record.start + 1, record.seconds * hz, `EXACT_DURATION_${record.typeId}`);
      console.log(JSON.stringify({ event: 'progression_completed', ...record }));
    }
  }
  if (sim.state.tick % 1200 === 0) {
    const view = sim.view('blue');
    console.log(JSON.stringify({ event: 'progress', tick: view.tick, elapsedMs: Math.round(performance.now() - started), age: view.self.age, resources: view.self.resources,
      workers: view.entities.filter(entity => entity.ownerId === 'blue' && entity.typeId === 'villager').length,
      buildings: view.entities.filter(entity => entity.ownerId === 'blue' && entity.kind === 'building').map(entity => ({ type: entity.typeId, progress: entity.progress })), rejected }));
  }
  const view = sim.state.tick % hz === 0 ? sim.view('blue') : undefined;
  if (view?.self.age === 4 && view.self.technologies?.includes('forestry_1')) break;
}
const final = sim.view('blue');
assert.equal(final.self.age, 4, JSON.stringify({ message: 'NORMAL_RESOURCE_EMPIRE_NOT_REACHED', tick: final.tick, self: final.self, rejected,
  workers: final.entities.filter(entity => entity.ownerId === 'blue' && entity.typeId === 'villager').map(entity => ({ id: entity.id, order: entity.order, task: entity.taskState, reason: entity.blockedReason, resource: assignments.get(entity.id), cargo: entity.cargo })) }));
assert(final.self.technologies?.includes('forestry_1'), 'REAL_RESEARCH_COMPLETED');
assert.deepEqual(tracked.filter(record => record.typeId.startsWith('age_')).map(record => record.typeId), ['age_2', 'age_3', 'age_4']);
const conservation = balance.resourceOrder.map(resource => {
  const entities = Object.values(sim.state.entities), economies = Object.values(sim.state.economies);
  const remaining = entities.reduce((sum, entity) => sum + (entity.kind === 'resource' && entity.resource === resource ? entity.amount : 0), 0);
  const extracted = initialNodes[resource]! - remaining + (resource === 'food' ? farmHarvest : 0);
  const collected = economies.reduce((sum, economy) => sum + economy.collected[resource], 0), lost = economies.reduce((sum, economy) => sum + economy.lostCargo[resource], 0);
  const carried = entities.reduce((sum, entity) => sum + (entity.kind === 'unit' && entity.cargo.resource === resource ? entity.cargo.amount : 0), 0);
  assert.equal(extracted, collected + lost + carried, `CONSERVATION_${resource}`);
  for (const economy of economies) assert.equal(balance.start.resources[resource] * scale + economy.ledger.filter(entry => entry.resource === resource).reduce((sum, entry) => sum + entry.deltaMilli, 0), economy.resources[resource], `LEDGER_${resource}`);
  return { resource, extracted, collected, lost, carried };
});
console.log(JSON.stringify({ event: 'done', seed, tick: final.tick, age: final.self.age, technologies: final.self.technologies, elapsedMs: Math.round(performance.now() - started),
  tracked, conservation, commands: sim.state.commandLog.length, rejected, modelInferenceIncluded: false }));
