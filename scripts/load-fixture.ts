import { balance, buildings, units, effectiveBuilding, effectiveUnit, sha256, type BuildingId, type GameplayCommand, type PlayerView, type Position, type PublicPlayer, type ResourceBank, type ResourceType, type UnitId, type SimulationDiagnostics } from '@frontier/shared';
import { createSimulation, sealSimulationCapture, validateSave, type Building, type EngineIdentity, type Entity, type ResourceNode, type SaveEnvelope, type SimulationSavePayload, type Unit } from '@frontier/simulation';
import { debit, emptyBank, scaledCost, transact } from '../packages/simulation/src/economy.js';

/** Offline fixture only. No application route or live-world mutation calls this module. */
export type CapacityComposition = 'one-pop' | 'mixed';
export interface CapacityDrill {
  playerId: string; home: Position; farms: { workerId: string; farmId: string }[];
  resourceWorkers: { workerId: string; resource: ResourceType }[];
  repairers: string[]; repairHouseId: string; combatArchers: string[]; combatTargetId: string;
  armyGroups: string[][]; gateLoop: [Position, Position];
}
export interface CapacityDutyMemory { nextTick: number; routes: Record<string, { phase: number; retryTick: number }> }
export interface CapacityProvenance {
  generator: 'capacity-fixture-v1'|'capacity-forest-v2'; seed: string; composition: CapacityComposition;
  acquisition: 'synthetic late-game fixture; not ordinary-resource progression';
  openingReservePerResource: number; catalogCostByFaction: Record<string, ResourceBank>;
  expectedUnits: number; expectedPopulation: number; nonWallBuildingsPerFaction: number; wallEquivalentCellsPerFaction: number; resourceNodes: number;
  controllers: boolean; runtimeGrantsOrRespawns: false; initialCollisionPairsChecked: number;
  resourceLayout: 'finite-town-edge-bands-v1'|'finite-town-forest-bands-v2'; townEdgeNodesPerFaction: number;
  forestPatches?:number;forestCells?:number;workloadMembershipHash?:string;
}
export interface CapacityFixture { save: SaveEnvelope; provenance: CapacityProvenance; drills: Record<string, CapacityDrill> }
/** Frame cadence is independent of the retained integer game-time clock. */
export function capacityTimingContract(authoritativeIntervalMs:50|300){
  if(authoritativeIntervalMs!==50&&authoritativeIntervalMs!==300)throw new Error('INVALID_QUALIFICATION_FRAME');
  return {authoritativeIntervalMs,frameTicks:authoritativeIntervalMs*balance.rules.simulationHz/1000,frameHz:1000/authoritativeIntervalMs,gameTicksPerSecond:balance.rules.simulationHz,p95Ms:authoritativeIntervalMs===300?240:35,p99Ms:authoritativeIntervalMs,publicationIntervalMs:authoritativeIntervalMs===300?300:100,pathWorkPerFrame:4000*authoritativeIntervalMs/50};
}
/** Missing complete cycles cannot pass by substituting a cheaper core/callback
 * measurement. Historical 50ms qualification retains its existing metric. */
export function capacityTimingMetrics(simulation:Pick<SimulationDiagnostics,'tickMs'|'cycleMs'|'cycleSamples'>,authoritativeIntervalMs:50|300){
  return authoritativeIntervalMs===300?(simulation.cycleSamples&&simulation.cycleSamples>0?simulation.cycleMs:undefined):simulation.tickMs;
}
const hz = balance.rules.simulationHz, scale = balance.rules.resourceScale, grid = balance.rules.buildingGridM * 1000;
const resources = balance.resourceOrder;
const technologyIds = balance.technologies.map(technology => technology.id).sort();
const unitTypes: UnitId[] = ['militia', 'spearman', 'archer', 'skirmisher', 'light_cavalry', 'scout'];
const mixedTypes: UnitId[] = [...unitTypes, 'knight', 'battering_ram', 'catapult', 'trebuchet'];

export function capacityComposition(population: 120 | 200, composition: CapacityComposition): UnitId[] {
  const result: UnitId[] = [...Array<UnitId>(40).fill('villager'), ...Array<UnitId>(4).fill('archer')], choices = composition === 'one-pop' ? unitTypes : mixedTypes;
  let used = result.reduce((sum, type) => sum + units[type].population, 0), cursor = 0;
  while (used < population) {
    const type = choices[cursor++ % choices.length]!; if (used + units[type].population > population) continue;
    result.push(type); used += units[type].population;
  }
  return result;
}
const position = (xMm: number, zMm: number): Position => ({ xMm, zMm });
const townOrigin = (index: number) => position(index % 4 * 152000, Math.floor(index / 4) * 200000);
const combatPosition = (index: number) => position(628000, 16000 + index * 54000);
const nodeType = (resource: ResourceType) => ({ food: 'forage_patch', wood: 'tree_oak', gold: 'gold_deposit', stone: 'stone_quarry' })[resource];
const nodeAmount = (resource: ResourceType) => Math.floor(balance.maps.spawnResourceMinimum[resource] / (resource === 'wood' ? 30 : resource === 'food' ? 6 : 5)) * scale;

function rectangle(entity: Entity) {
  const definition = entity.kind === 'building' ? buildings[entity.typeId] : undefined;
  const rotated = entity.kind === 'building' && (entity.rotation === 90 || entity.rotation === 270);
  const width = definition ? definition.footprintCells[rotated ? 1 : 0] * grid / 2 : entity.kind === 'resource' ? entity.forest ? entity.forest.cellMm / 2 : entity.resource === 'wood' ? 450 : 650 : units[entity.typeId].collisionRadiusM * 1000;
  const depth = definition ? definition.footprintCells[rotated ? 0 : 1] * grid / 2 : width;
  return { x: entity.xMm, z: entity.zMm, width, depth, circle: entity.kind === 'unit' };
}
/** Spatial buckets keep validation bounded; touching edges are legal. Gates start closed. */
export function validateCapacityGeometry(entities: Entity[], widthMm = 640000, heightMm = 640000): number {
  const buckets = new Map<string, number[]>(); let pairs = 0;
  const boxes = entities.map(rectangle);
  for (let index = 0; index < entities.length; index++) {
    const entity = entities[index]!, box = boxes[index]!, nearby = new Set<number>();
    if (box.x - box.width < 0 || box.z - box.depth < 0 || box.x + box.width > widthMm || box.z + box.depth > heightMm) throw new Error(`FIXTURE_OUT_OF_BOUNDS:${entity.id}`);
    const keys: string[] = [];
    for (let z = Math.floor((box.z - box.depth) / 8000); z <= Math.floor((box.z + box.depth) / 8000); z++) for (let x = Math.floor((box.x - box.width) / 8000); x <= Math.floor((box.x + box.width) / 8000); x++) { const key = `${x},${z}`; keys.push(key); for (const prior of buckets.get(key) ?? []) nearby.add(prior); }
    for (const prior of nearby) {
      pairs++; const other = boxes[prior]!; let overlap: boolean;
      if (box.circle && other.circle) overlap = Math.hypot(box.x - other.x, box.z - other.z) < box.width + other.width;
      else if (box.circle || other.circle) { const circle = box.circle ? box : other, rect = box.circle ? other : box; const dx = Math.max(0, Math.abs(circle.x - rect.x) - rect.width), dz = Math.max(0, Math.abs(circle.z - rect.z) - rect.depth); overlap = dx * dx + dz * dz < circle.width * circle.width; }
      else overlap = Math.abs(box.x - other.x) < box.width + other.width && Math.abs(box.z - other.z) < box.depth + other.depth;
      if (overlap) throw new Error(`FIXTURE_COLLISION:${entity.id}:${entities[prior]!.id}`);
    }
    for (const key of keys) { const bucket = buckets.get(key) ?? []; bucket.push(index); buckets.set(key, bucket); }
  }
  return pairs;
}

export function validateCapacityAccounting(payload: SimulationSavePayload, expected: CapacityProvenance): void {
  const all = Object.values(payload.state.entities);
  if (all.filter(entity => entity.kind === 'unit').length !== expected.expectedUnits || all.filter(entity => entity.kind === 'resource').length !== expected.resourceNodes) throw new Error('FIXTURE_ENTITY_COUNT');
  for (const faction of payload.state.factions) {
    const economy = payload.state.economies[faction.id]!, own = all.filter(entity => entity.ownerId === faction.id), complete = new Set(own.filter(entity => entity.kind === 'building').map(entity => entity.typeId));
    const used = own.reduce((sum, entity) => sum + (entity.kind === 'unit' ? units[entity.typeId].population : 0), 0);
    const supply = own.reduce((sum, entity) => sum + (entity.kind === 'building' ? buildings[entity.typeId].populationProvided : 0), 0);
    if (used !== payload.options.populationLimit || supply < used || economy.age !== 4) throw new Error('FIXTURE_POPULATION_OR_AGE');
    if (own.filter(entity => entity.kind === 'building' && !buildings[entity.typeId].wallEquivalentCells).length !== expected.nonWallBuildingsPerFaction || own.reduce((sum, entity) => sum + (entity.kind === 'building' ? buildings[entity.typeId].wallEquivalentCells ?? 0 : 0), 0) !== expected.wallEquivalentCellsPerFaction) throw new Error('FIXTURE_BUILDING_CAPACITY');
    for (const age of balance.ages) for (const requirement of age.prerequisites) if (requirement.kind === 'completed_buildings' ? !requirement.types.every(type => complete.has(type)) : requirement.types.filter(type => complete.has(type)).length < requirement.count) throw new Error('FIXTURE_AGE_PREREQUISITE');
    for (const technology of balance.technologies) if (!economy.technologies.includes(technology.id) || !complete.has(technology.researchedAt) || !technology.prerequisites.every(id => economy.technologies.includes(id))) throw new Error('FIXTURE_RESEARCH_PREREQUISITE');
    for (const entity of own) {
      const definition = entity.kind === 'unit' ? effectiveUnit(entity.typeId, economy.technologies) : entity.kind === 'building' ? effectiveBuilding(entity.typeId, economy.technologies) : undefined;
      if (!definition || entity.hp !== Math.round(definition.maxHp) || entity.maxHp !== Math.round(definition.maxHp) || definition.minAge > economy.age) throw new Error('FIXTURE_STAT');
      if (entity.kind === 'unit' && !complete.has(units[entity.typeId].producedAt)) throw new Error('FIXTURE_PRODUCER');
      if (entity.kind === 'building' && buildings[entity.typeId].maxPerPlayerByAge && own.filter(other => other.typeId === entity.typeId).length > buildings[entity.typeId].maxPerPlayerByAge!['4']!) throw new Error('FIXTURE_BUILDING_LIMIT');
      if (entity.typeId === 'monument' && !payload.options.monumentVictory) throw new Error('FIXTURE_DISABLED_MONUMENT');
    }
    for (const resource of resources) {
      if (economy.spent[resource] !== expected.catalogCostByFaction[faction.id]![resource] * scale || economy.resources[resource] !== expected.openingReservePerResource * scale - economy.spent[resource]) throw new Error('FIXTURE_COST');
      if (balance.start.resources[resource] * scale + economy.ledger.filter(entry => entry.resource === resource).reduce((sum, entry) => sum + entry.deltaMilli, 0) !== economy.resources[resource]) throw new Error('FIXTURE_LEDGER');
    }
  }
}

export function createCapacityFixture(options: { factions: PublicPlayer[]; identity: EngineIdentity; populationLimit: 120 | 200; seed: string; composition?: CapacityComposition; controllers?: boolean; forest?:boolean; authoritativeIntervalMs?:50|300 }): CapacityFixture {
  if (options.factions.length < 2 || options.factions.length > 11) throw new Error('FIXTURE_FACTIONS');
  const composition = options.composition ?? 'one-pop', roster = capacityComposition(options.populationLimit, composition);
  const base = createSimulation({ factions: options.factions, seed: options.seed, matchId: `capacity_${sha256(options.seed).slice(0, 20)}`, secretIdKey: sha256(`capacity-private:${options.seed}`), controllers: options.controllers ?? false, mapType: 'open_frontier', mapSize: 'large', populationLimit: options.populationLimit, sharedVision: false,...(options.authoritativeIntervalMs?{authoritativeIntervalMs:options.authoritativeIntervalMs}:{}) });
  const payload = base.capture(), state = payload.state; state.entities = {}; state.widthMm = state.heightMm = 640000; state.navigationRevision++; state.entityNonce = 0;
  state.map = { type: 'open_frontier', seed: options.seed, generatorVersion: 'capacity-fixture-v1', terrain: [], validation: { attempt: 0, connected: false, spawnReports: [], travelVariation: emptyBank(), resourceNodes: 8000, expansionPatches: 0 } };
  for (const faction of state.factions) state.vision[faction.id] = { visible: [], explored: [], memory: {}, actions: {} };
  payload.runtime.planningProfiles = state.factions.map(faction => [faction.id, { revision: 0, obstacles: [] }]);
  const drills: Record<string, CapacityDrill> = {}, costs: Record<string, ResourceBank> = {}, ownedBuildings = new Map<string, Building[]>();
  const id = () => `fixture_${sha256(`${options.seed}:${++state.entityNonce}`).slice(0, 32)}`;
  const addCost = (owner: string, cost: ResourceBank) => { for (const resource of resources) costs[owner]![resource] += cost[resource]; };
  const addBuilding = (ownerId: string, typeId: BuildingId, point: Position): Building => {
    const definition = effectiveBuilding(typeId, technologyIds), hp = Math.round(definition.maxHp), required = definition.buildSeconds * hz * 100;
    const entity: Building = { id: id(), kind: 'building', ownerId, typeId, ...point, hp, maxHp: hp, grantedHp: hp, rotation: 0, work: required, required, queue: [], cooldown: 0, repairCredits: {}, repairRemainders: {}, ...(typeId === 'farm' ? { foodRemaining: definition.foodCapacity! * scale } : {}), ...(definition.defaultGateMode ? { gateMode: 'AUTO', gateOpen: false } : {}) };
    state.entities[entity.id] = entity; addCost(ownerId, definition.cost); const own = ownedBuildings.get(ownerId) ?? []; own.push(entity); ownedBuildings.set(ownerId, own); return entity;
  };
  const addUnit = (ownerId: string, typeId: UnitId, point: Position): Unit => {
    const definition = effectiveUnit(typeId, technologyIds), hp = Math.round(definition.maxHp);
    const entity: Unit = { id: id(), kind: 'unit', ownerId, typeId, ...point, hp, maxHp: hp, orders: [], path: [], pathRevision: state.navigationRevision, orderRevision: 0, repathAtTick: 0, cargo: { resource: null, amount: 0 }, gatherRemainder: 0, cooldown: 0, stance: 'stand_ground', ...(typeId === 'trebuchet' ? { deploymentState: 'packed' } : {}) };
    state.entities[entity.id] = entity; addCost(ownerId, definition.cost); return entity;
  };
  let resourceCount = 0;
  const addResource = (resource: ResourceType, point: Position) => { const entity: Entity = { id: id(), kind: 'resource', typeId: nodeType(resource), ownerId: null, ...point, hp: 1, maxHp: 1, resource, amount: nodeAmount(resource) }; state.entities[entity.id] = entity; resourceCount++; return entity; };
  for (const [index, faction] of state.factions.entries()) {
    const owner = faction.id, origin = townOrigin(index), economy = state.economies[owner]!; costs[owner] = emptyBank();
    economy.age = 4; economy.technologies = [...technologyIds]; economy.researchRevision = technologyIds.length; economy.statistics.ageTicks = { '1': 0, '2': 0, '3': 0, '4': 0 };
    for (const age of balance.ages) addCost(owner, age.cost); for (const technology of balance.technologies) addCost(owner, technology.cost);
    const types = balance.buildings.filter(definition => !definition.wallEquivalentCells && definition.id !== 'monument').map(definition => definition.id);
    while (types.filter(type => type === 'farm').length < 16) types.push('farm'); while (types.length < 79) types.push('house');
    for (const [slot, type] of types.entries()) addBuilding(owner, type, position(origin.xMm + 14000 + slot % 10 * 14000, origin.zMm + 16000 + Math.floor(slot / 10) * 14000));
    const enemyLane = (index + state.factions.length - 1) % state.factions.length, repairHouse = addBuilding(owner, 'house', combatPosition(enemyLane));
    for (let z = 0; z <= 30; z++) for (let x = 0; x <= 50; x++) {
      if (x !== 0 && x !== 50 && z !== 0 && z !== 30) continue;
      if ((z === 0 || z === 30) && x >= 24 && x <= 26) { if (x === 25) addBuilding(owner, 'wooden_gate', position(origin.xMm + 27000 + x * grid, origin.zMm + 133000 + z * grid)); continue; }
      addBuilding(owner, 'palisade_wall', position(origin.xMm + 27000 + x * grid, origin.zMm + 133000 + z * grid));
    }
    const own = ownedBuildings.get(owner)!, home = own.find(building => building.typeId === 'town_center')!, farms = own.filter(building => building.typeId === 'farm');
    const drill: CapacityDrill = { playerId: owner, home: position(home.xMm, home.zMm), farms: [], resourceWorkers: [], repairers: [], repairHouseId: repairHouse.id, combatArchers: [], combatTargetId: '', armyGroups: [], gateLoop: [position(origin.xMm + 77000, origin.zMm + 122000), position(origin.xMm + 77000, origin.zMm + 178000)] }; drills[owner] = drill;
    for (const farm of farms) { const worker = addUnit(owner, 'villager', position(farm.xMm, farm.zMm + buildings.farm.footprintCells[1] * 1000 + 700)); drill.farms.push({ workerId: worker.id, farmId: farm.id }); }
    for (let worker = 0; worker < 19; worker++) {
      const resource = worker < 7 ? 'wood' : worker < 13 ? 'gold' : 'stone', local = worker < 7 ? worker : worker < 13 ? worker - 7 : worker - 13;
      const node = addResource(resource, position(origin.xMm + (resource === 'wood' ? 12000 : resource === 'gold' ? 62000 : 112000) + local * 4000, origin.zMm + 3000));
      const villager = addUnit(owner, 'villager', position(node.xMm, node.zMm + (resource === 'wood' ? 1100 : 1300))); drill.resourceWorkers.push({ workerId: villager.id, resource });
    }
    for (let worker = 0; worker < 5; worker++) drill.repairers.push(addUnit(owner, 'villager', position(repairHouse.xMm + 3000, repairHouse.zMm + (worker - 2) * 800)).id);
    const lane = combatPosition(index); for (let archer = 0; archer < 4; archer++) drill.combatArchers.push(addUnit(owner, 'archer', position(lane.xMm - 7000, lane.zMm + (archer - 1.5) * 1400)).id);
    const marching: string[] = [];
    for (const [slot, type] of roster.slice(44).entries()) marching.push(addUnit(owner, type, position(origin.xMm + 34000 + slot % 12 * 7000, origin.zMm + 142000 + Math.floor(slot / 12) * 3000)).id);
    for (let offset = 0; offset < marching.length; offset += 16) drill.armyGroups.push(marching.slice(offset, offset + 16));
    economy.statistics.unitsTrained = roster.length; economy.statistics.buildingsBuilt = 80;
  }
  for (const [index, faction] of state.factions.entries()) drills[faction.id]!.combatTargetId = drills[state.factions[(index + 1) % state.factions.length]!.id]!.repairHouseId;
  // Finite reserves stay within ordinary town vision. Narrow edge columns leave
  // the building grid, farm approaches and army/gate corridors clear; workers can
  // discover the next exposed face as each catalog-sized node is exhausted.
  const edgeColumns = [1000, 3000, 5000, 7000, 147000, 149000, 151000];
  for (const [index] of state.factions.entries()) {
    const origin = townOrigin(index);
    for (let z = 1000; z < 200000; z += 2000) for (const x of edgeColumns) addResource(resources[resourceCount % resources.length]!, position(origin.xMm + x, origin.zMm + z));
  }
  for (let z = 1000; z < 640000 && resourceCount < 8000; z += 2000) for (let x = 1000; x < 640000 && resourceCount < 8000; x += 2000) {
    if (x >= 614000 || state.factions.some((_, index) => { const origin = townOrigin(index); return x >= origin.xMm && x < origin.xMm + 152000 && z >= origin.zMm && z < origin.zMm + 200000; })) continue;
    addResource(resources[resourceCount % resources.length]!, position(x, z));
  }
  if(options.forest){
    // A distinct rules fixture, never a rewrite of the historical v1 placement.
    // Reposition existing wood IDs only: all faction, unit, building, wall and
    // resource counts and finite resource amounts remain exactly unchanged.
    const nodes=Object.values(state.entities).filter((entity):entity is ResourceNode=>entity.kind==='resource'),cellMm=balance.maps.forestNavigationCellM*balance.rules.positionUnitsPerM;
    for(const [index,faction]of state.factions.entries()){
      const origin=townOrigin(index),workers=drills[faction.id]!.resourceWorkers.filter(assignment=>assignment.resource==='wood').map(assignment=>state.entities[assignment.workerId] as Unit);
      const active=workers.map(worker=>nodes.find(node=>node.resource==='wood'&&node.xMm===worker.xMm&&node.zMm===worker.zMm-1100)!);
      const activeIds=new Set(active.map(node=>node.id));
      const reserves=nodes.filter(node=>node.resource==='wood'&&!activeIds.has(node.id)&&node.xMm>=origin.xMm&&node.xMm<origin.xMm+152000&&node.zMm>=origin.zMm&&node.zMm<origin.zMm+200000).slice(0,5);
      if(active.length!==7||reserves.length!==5)throw new Error('FOREST_FIXTURE_RESERVE_MEMBERSHIP');
      const patch=[...active,...reserves],patchId=`forest_${sha256(`capacity-forest:${options.seed}:${faction.id}`).slice(0,32)}`;
      for(const [slot,node]of patch.entries()){
        node.xMm=origin.xMm+12000+slot%4*cellMm;node.zMm=origin.zMm+cellMm/2+Math.floor(slot/4)*cellMm;
        node.forest={patchId,cellMm};
      }
      for(const [slot,worker]of workers.entries()){
        const margin=units[worker.typeId].collisionRadiusM*1000+100;
        worker.xMm=origin.xMm+(slot<3?12000-cellMm/2-margin:slot<6?12000+3*cellMm+cellMm/2+margin:12000+3*cellMm);
        worker.zMm=origin.zMm+(slot<6?cellMm/2+(slot%3)*cellMm:3*cellMm+margin);
      }
    }
    state.map.generatorVersion='capacity-forest-v2';state.map.validation.expansionPatches=state.factions.length;
  }
  const provenance: CapacityProvenance = { generator: 'capacity-fixture-v1', seed: options.seed, composition, acquisition: 'synthetic late-game fixture; not ordinary-resource progression', openingReservePerResource: 100000, catalogCostByFaction: costs, expectedUnits: roster.length * state.factions.length, expectedPopulation: options.populationLimit * state.factions.length, nonWallBuildingsPerFaction: 80, wallEquivalentCellsPerFaction: 160, resourceNodes: 8000, controllers: payload.options.controllers, runtimeGrantsOrRespawns: false, initialCollisionPairsChecked: 0, resourceLayout: 'finite-town-edge-bands-v1', townEdgeNodesPerFaction: edgeColumns.length * 100 };
  if(options.forest){
    provenance.generator='capacity-forest-v2';provenance.resourceLayout='finite-town-forest-bands-v2';provenance.townEdgeNodesPerFaction-=5;
    provenance.forestPatches=state.factions.length;provenance.forestCells=state.factions.length*12;
    provenance.workloadMembershipHash=sha256(JSON.stringify({generator:provenance.generator,composition,entities:Object.values(state.entities).map(entity=>[entity.id,entity.kind,entity.typeId,entity.ownerId,entity.xMm,entity.zMm,entity.kind==='resource'?entity.resource:null,entity.kind==='resource'?entity.amount:null,entity.kind==='resource'?entity.forest??null:null]),drills}));
  }
  for (const faction of state.factions) {
    const economy = state.economies[faction.id]!, reserve = emptyBank(); for (const resource of resources) reserve[resource] = provenance.openingReservePerResource * scale - economy.resources[resource];
    if (!transact(economy, reserve, 'fixture_opening_reserve', 0) || !debit(economy, scaledCost(costs[faction.id]!), 'fixture_catalog_acquisitions', 0)) throw new Error('FIXTURE_UNFUNDED');
  }
  provenance.initialCollisionPairsChecked = validateCapacityGeometry(Object.values(state.entities)); validateCapacityAccounting(payload, provenance);
  const save = sealSimulationCapture(payload, options.identity); validateSave(save, options.identity); return { save, provenance, drills };
}

export const createCapacityDutyMemory = (): CapacityDutyMemory => ({ nextTick: 0, routes: {} });
/** Decisions consume one normal viewpoint; no world handle or hidden resource query. */
export function capacityDutyCommands(view: PlayerView, drill: CapacityDrill, memory: CapacityDutyMemory): GameplayCommand[] {
  if (drill.playerId !== view.playerId) throw new Error('DUTY_VIEWPOINT_MISMATCH');
  if (view.status !== 'RUNNING' || view.tick < memory.nextTick) return []; memory.nextTick = view.tick + hz;
  const commands: GameplayCommand[] = [], own = new Map(view.entities.filter(entity => entity.ownerId === view.playerId && !entity.ghost).map(entity => [entity.id, entity]));
  if (!view.self.autoReseed) commands.push({ kind: 'set_auto_reseed', enabled: true });
  for (const assignment of drill.farms) { const worker = own.get(assignment.workerId), farm = own.get(assignment.farmId); if (worker && farm && !['gather', 'reseed'].includes(worker.order ?? '') && (farm.amount ?? 0) > 0) commands.push({ kind: 'gather', unitIds: [worker.id], targetId: farm.id, queued: false }); }
  for (const assignment of drill.resourceWorkers) {
    const worker = own.get(assignment.workerId); if (!worker || worker.order === 'gather') continue;
    const node = view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && entity.resource === assignment.resource && (entity.amount ?? 0) > 0).sort((a, b) => Math.hypot(a.xMm - worker.xMm, a.zMm - worker.zMm) - Math.hypot(b.xMm - worker.xMm, b.zMm - worker.zMm))[0];
    if (node) commands.push({ kind: 'gather', unitIds: [worker.id], targetId: node.id, queued: false });
  }
  const house = own.get(drill.repairHouseId), repairers = drill.repairers.filter(id => own.get(id) && own.get(id)!.order !== 'repair');
  if (house && house.hp < house.maxHp && repairers.length) commands.push({ kind: 'repair', unitIds: repairers, targetId: house.id, queued: false });
  const target = view.entities.find(entity => entity.id === drill.combatTargetId && !entity.ghost), archers = drill.combatArchers.filter(id => own.get(id) && own.get(id)!.order !== 'attack');
  if (target && target.hp > 0 && archers.length) commands.push({ kind: 'attack_target', unitIds: archers, targetId: target.id, queued: false });
  for (const [index, group] of drill.armyGroups.entries()) {
    const live = group.map(id => own.get(id)).filter(entity => entity !== undefined); if (!live.length) continue;
    const route = memory.routes[index] ??= { phase: 0, retryTick: 0 };
    if (view.tick < route.retryTick || live.some(entity => entity.order === 'move' && entity.taskState !== 'blocked')) continue;
    const center = drill.gateLoop[route.phase % 2]!, target = { xMm: center.xMm + Math.round((index - (drill.armyGroups.length - 1) / 2) * 8000), zMm: center.zMm };
    commands.push({ kind: 'move', unitIds: live.map(entity => entity.id), target, queued: false }); route.phase++; route.retryTick = view.tick + 10 * hz;
  }
  return commands;
}
