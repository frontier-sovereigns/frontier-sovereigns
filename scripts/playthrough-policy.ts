import {
  ages, balance, buildings, technologies, units, terrainBuildable, terrainObstacles,
  type BuildingId, type Cell, type ClientCommandEnvelope, type CommandReceipt, type GameplayCommand,
  type PlayerView, type Position, type ResourceBank, type ResourceType, type TechnologyId, type UnitId, type ViewEntity,
} from '@frontier/shared';

// An external scripted HUMAN participant, not a replacement for the game's AI.
// The only world input is the same filtered PlayerView that its browser receives.
// Every purchase, movement and attack below must cross the ordinary command path.
const hz = balance.rules.simulationHz, grid = balance.rules.buildingGridM * 1000;
const resources = balance.resourceOrder, zero = (): ResourceBank => ({ food: 0, wood: 0, gold: 0, stone: 0 });
const distance = (a: Position, b: Position) => Math.hypot(a.xMm - b.xMm, a.zMm - b.zMm);
type Structure = Extract<GameplayCommand,{kind:'build'}>['buildingType'];
interface Pending {
  command: GameplayCommand; key: string; cost: ResourceBank; tick: number; unitIds: string[];
  clientCommandId?: string; clientSequence?: number; receipt?: CommandReceipt; armyTarget?: string;
}
export type PlaythroughMilestone = { met: false } | { met: true; observedTick: number; matchEpoch: number; entityId: string; typeId: string; proof: string; resource?: ResourceType; adjacentFortificationIds?: string[] };
export interface PlaythroughEvidence {
  completedFarm: PlaythroughMilestone; completedWall: PlaythroughMilestone; completedGate: PlaythroughMilestone;
  resourceZeroObserved: PlaythroughMilestone; resourceDepletion: PlaythroughMilestone; naturalNodeDepletion: PlaythroughMilestone; fortificationBreach: PlaythroughMilestone;
}
interface ResourceObservation { typeId: string; resource: ResourceType; positive: boolean; seenTick: number }
interface FortificationObservation { typeId: string; hp: number; observedDamage: boolean; seenTick: number; adjacentIds: string[] }
interface ObservationMemory { matchId?: string; playerId?: string; epoch?: number; sequence: number; tick: number; resources: Record<string, ResourceObservation>; fortifications: Record<string, FortificationObservation>; acceptedGatherTargets: Record<string, { targetId: string; acceptedTick: number; matchEpoch: number }> }
export interface PlaythroughMemory {
  identity?: string; nextDecisionTick: number; homeId?: string; home?: Position;
  pending: Pending[]; assignments: Record<string, ResourceType>; farmAssignments: Record<string, string>;
  lastOrder: Record<string, number>; lastTarget: Record<string, string>; siteAttempt: Record<string, number>;
  cooldownUntil: Record<string, number>; scoutIndex: number; revisitIndex?: number; lastRebalanceTick: number;
  defenseCells?: Cell[]; defenseComplete: boolean; lastArmyOrderTick: number; lastArmyTarget?: string; assaultStarted: boolean;
  observations: ObservationMemory; farmClaimsToRenew: Record<string, string>;
  telemetry: { phase: 'economy' | 'ages' | 'military' | 'combat' | 'defeated' | 'finished'; decisions: number;
    emitted: number; accepted: number; rejected: Record<string, number>; ageTicks: Record<string, number>;
    technologyTicks: Record<string, number>; maxWorkers: number; maxMilitary: number; visibleCombatOrders: number;
    pendingWithoutReceipt: number; lastBlocked?: string; epochChanges: number; evidence: PlaythroughEvidence };
}
export interface PlaythroughOptions { targetWorkers?: number; maximumCommandsPerDecision?: number; targetMilitaryPopulation?: number }
export function createPlaythroughMemory(): PlaythroughMemory {
  return { nextDecisionTick: 0, pending: [], assignments: {}, farmAssignments: {}, lastOrder: {}, lastTarget: {}, siteAttempt: {}, cooldownUntil: {}, scoutIndex: 0,
    lastRebalanceTick: -1_000_000, defenseComplete: false, lastArmyOrderTick: -1_000_000, assaultStarted: false,
    observations: { sequence: -1, tick: -1, resources: {}, fortifications: {}, acceptedGatherTargets: {} }, farmClaimsToRenew: {},
    telemetry: { phase: 'economy', decisions: 0, emitted: 0, accepted: 0, rejected: {}, ageTicks: {}, technologyTicks: {}, maxWorkers: 0, maxMilitary: 0, visibleCombatOrders: 0, pendingWithoutReceipt: 0, epochChanges: 0,
      evidence: { completedFarm: { met: false }, completedWall: { met: false }, completedGate: { met: false }, resourceZeroObserved: { met: false }, resourceDepletion: { met: false }, naturalNodeDepletion: { met: false }, fortificationBreach: { met: false } } } };
}
/** Call immediately for each envelope returned by the network client's command(). */
export function playthroughCommandSent(memory: PlaythroughMemory, envelope: ClientCommandEnvelope): void {
  const encoded = JSON.stringify(envelope.command), pending = memory.pending.find(item => !item.clientCommandId && JSON.stringify(item.command) === encoded);
  if (!pending) throw new Error('PLAYTHROUGH_UNPLANNED_COMMAND');
  pending.clientCommandId = envelope.clientCommandId; pending.clientSequence = envelope.clientSequence;
}
/** Duplicate receipts are harmless. Accepted costs stay reserved until the view catches up. */
export function playthroughReceipt(memory: PlaythroughMemory, receipt: CommandReceipt): void {
  const item = memory.pending.find(pending => pending.clientCommandId === receipt.clientCommandId);
  if (!item || item.receipt) return;
  item.receipt = receipt;
  if (receipt.status === 'accepted') {
    memory.telemetry.accepted++;
    if (item.key === 'army') {
      memory.assaultStarted = true;
      if (item.armyTarget === undefined) delete memory.lastArmyTarget;
      else memory.lastArmyTarget = item.armyTarget;
    }
    for (const id of item.unitIds) {
      if (item.command.kind === 'gather') memory.observations.acceptedGatherTargets[id] = { targetId: item.command.targetId, acceptedTick: receipt.tick, matchEpoch: memory.observations.epoch! };
      else if (item.command.kind !== 'set_stance') delete memory.observations.acceptedGatherTargets[id];
    }
    return;
  }
  const code = receipt.code ?? 'UNKNOWN'; memory.telemetry.rejected[code] = (memory.telemetry.rejected[code] ?? 0) + 1;
  memory.telemetry.lastBlocked = code; memory.cooldownUntil[item.key] = receipt.tick + 5 * hz;
  for (const id of item.unitIds) forgetWorker(memory, id);
  if (item.command.kind === 'build') memory.siteAttempt[item.command.buildingType] = (memory.siteAttempt[item.command.buildingType] ?? 0) + 1;
  if (item.command.kind === 'build_wall') { memory.siteAttempt.defense = (memory.siteAttempt.defense ?? 0) + 1; delete memory.defenseCells; }
  memory.pending = memory.pending.filter(pending => pending !== item);
}
function forgetWorker(memory: PlaythroughMemory, workerId: string): void {
  delete memory.assignments[workerId];
  delete memory.farmClaimsToRenew[workerId];
  for (const [farmId, id] of Object.entries(memory.farmAssignments)) if (id === workerId) delete memory.farmAssignments[farmId];
}

/** Call for EVERY accepted authorized view, including PAUSED and FINISHED views.
 * It never emits a command. Short-lived hit/death effects must not depend on the
 * slower policy cadence. Missing/ghost entities alone never prove destruction.
 */
export function observePlaythrough(view: PlayerView, memory: PlaythroughMemory): void {
  const identity = `${view.matchId}:${view.matchEpoch}:${view.playerId}`;
  if (memory.identity !== identity) {
    const sameParticipant = memory.observations.matchId === view.matchId && memory.observations.playerId === view.playerId;
    const telemetry = sameParticipant ? memory.telemetry : undefined, oldClaims = sameParticipant ? { ...memory.farmAssignments } : {}, assaultStarted = sameParticipant && memory.assaultStarted;
    for (const key of Object.keys(memory)) delete (memory as unknown as Record<string, unknown>)[key];
    Object.assign(memory, createPlaythroughMemory()); memory.identity = identity;
    if (telemetry) { memory.telemetry = telemetry; memory.telemetry.epochChanges++; memory.telemetry.pendingWithoutReceipt = 0; memory.assaultStarted = assaultStarted; }
    memory.observations.matchId = view.matchId; memory.observations.playerId = view.playerId; memory.observations.epoch = view.matchEpoch;
    const own = new Map(view.entities.filter(entity => entity.ownerId === view.playerId && !entity.ghost).map(entity => [entity.id, entity]));
    for (const worker of own.values()) if (worker.typeId === 'villager' && worker.order === 'gather' && worker.cargo?.resource) memory.assignments[worker.id] = worker.cargo.resource;
    // A restored in-flight farmer carrying wood has no public target ID. Keep its
    // prior authorized intention reserved, then explicitly reconfirm it through
    // an ordinary gather command before treating it as a current assignment.
    for (const [farmId, workerId] of Object.entries(oldClaims)) {
      const farm = own.get(farmId), worker = own.get(workerId);
      if (farm?.typeId === 'farm' && farm.progress === 1 && (farm.amount ?? 0) > 0 && !farm.farmerAssigned && worker?.typeId === 'villager' && worker.order === 'gather') {
        memory.farmAssignments[farmId] = workerId; memory.farmClaimsToRenew[workerId] = farmId;
      }
    }
    memory.defenseComplete = [...own.values()].some(entity => ['wooden_gate', 'stone_gate'].includes(entity.typeId) && entity.progress === 1);
  }
  const observed = memory.observations;
  if (view.sequence <= observed.sequence || view.tick < observed.tick) return;
  observed.sequence = view.sequence; observed.tick = view.tick;
  const own = view.entities.filter(entity => entity.ownerId === view.playerId && !entity.ghost), ownIds = new Set(own.map(entity => entity.id));
  for (const id of Object.keys(observed.acceptedGatherTargets)) if (!ownIds.has(id)) delete observed.acceptedGatherTargets[id];
  memory.telemetry.ageTicks[String(view.self.age)] ??= view.tick;
  memory.telemetry.maxWorkers = Math.max(memory.telemetry.maxWorkers, own.filter(entity => entity.typeId === 'villager').length);
  memory.telemetry.maxMilitary = Math.max(memory.telemetry.maxMilitary, own.filter(entity => entity.kind === 'unit' && !['villager', 'scout'].includes(entity.typeId)).length);
  for (const id of view.self.technologies ?? []) memory.telemetry.technologyTicks[id] ??= view.tick;
  if (view.status === 'FINISHED') memory.telemetry.phase = 'finished';
  const evidence = memory.telemetry.evidence;
  const mark = (key: keyof PlaythroughEvidence, entity: Pick<ViewEntity, 'id' | 'typeId' | 'resource'>, proof: string, extra: { adjacentFortificationIds?: string[] } = {}) => {
    if (!evidence[key].met) evidence[key] = { met: true, observedTick: view.tick, matchEpoch: view.matchEpoch, entityId: entity.id, typeId: entity.typeId, proof, ...(entity.resource ? { resource: entity.resource } : {}), ...extra };
  };
  for (const entity of own) if (entity.kind === 'building' && entity.progress === 1 && entity.hp > 0) {
    if (entity.typeId === 'farm') mark('completedFarm', entity, 'owned_live_completed_structure');
    if (['palisade_wall', 'stone_wall'].includes(entity.typeId)) mark('completedWall', entity, 'owned_live_completed_structure');
    if (['wooden_gate', 'stone_gate'].includes(entity.typeId)) mark('completedGate', entity, 'owned_live_completed_structure');
  }
  const live = view.entities.filter(entity => !entity.ghost), resources = live.filter(entity => entity.kind === 'resource' || entity.typeId === 'farm');
  for (const entity of resources) {
    if (!entity.resource || entity.amount === undefined) continue;
    const previous = observed.resources[entity.id];
    if (previous?.positive && entity.amount === 0) {
      mark('resourceZeroObserved', entity, 'positive_to_reported_zero_whole_units');
      if (entity.typeId === 'farm' && entity.ownerId === view.playerId && ['exhausted', 'reseeding'].includes(entity.farmState ?? '')) mark('resourceDepletion', entity, 'positive_owned_farm_observed_exhausted_or_reseeding');
      else if (entity.kind === 'resource' && own.some(worker => {
        const assignment = observed.acceptedGatherTargets[worker.id];
        if (worker.typeId !== 'villager' || assignment?.targetId !== entity.id || assignment.matchEpoch !== view.matchEpoch || view.tick <= assignment.acceptedTick) return false;
        // The current reason lasts only one simulation tick. The authorized
        // notification survives a 10 Hz snapshot gap; older orders/epochs and
        // another worker's notification cannot corroborate rounded zero.
        return worker.blockedReason === 'RESOURCE_DEPLETED' || view.self.notifications?.some(notice => notice.code === 'RESOURCE_DEPLETED' && notice.entityId === worker.id && notice.tick > assignment.acceptedTick && notice.tick <= view.tick);
      })) {
        mark('resourceDepletion', entity, 'reported_zero_and_owned_gatherer_resource_depleted');
        mark('naturalNodeDepletion', entity, 'reported_zero_and_owned_gatherer_resource_depleted');
      }
    }
    observed.resources[entity.id] = { typeId: entity.typeId, resource: entity.resource, positive: Boolean(previous?.positive || entity.amount > 0), seenTick: view.tick };
  }
  const me = view.players.find(player => player.id === view.playerId), hostile = (entity: ViewEntity) => view.players.some(player => player.id === entity.ownerId && player.teamId !== me?.teamId);
  const fortifications = live.filter(entity => entity.kind === 'building' && Boolean(buildings[entity.typeId].wallEquivalentCells) && entity.progress === 1);
  for (const entity of fortifications.filter(entity => ['palisade_wall', 'stone_wall'].includes(entity.typeId) && hostile(entity) && entity.hp > 0).slice(0, 512)) {
    const previous = observed.fortifications[entity.id], adjacentIds = fortifications.filter(other => adjacentFortifications(entity, other)).slice(0, 4).map(other => other.id);
    observed.fortifications[entity.id] = { typeId: entity.typeId, hp: entity.hp, observedDamage: Boolean(previous?.observedDamage || previous && entity.hp < previous.hp), seenTick: view.tick, adjacentIds };
  }
  for (const effect of view.effects ?? []) if (effect.kind === 'death' && effect.entityId && effect.typeId && effect.tick <= view.tick) {
    const previous = observed.fortifications[effect.entityId];
    if (!previous || effect.typeId !== previous.typeId || previous.seenTick > effect.tick || previous.adjacentIds.length < 2) continue;
    const observedHit = previous.observedDamage || view.effects?.some(hit => hit.kind === 'hit' && hit.entityId === effect.entityId && hit.tick >= previous.seenTick && hit.tick <= effect.tick);
    if (observedHit) mark('fortificationBreach', { id: effect.entityId, typeId: effect.typeId }, 'authorized_damaged_connected_fortification_death', { adjacentFortificationIds: [...previous.adjacentIds] });
  }
  // Baselines are bounded and never restored across an epoch. Eviction can leave a
  // milestone unmet, but cannot manufacture positive evidence from a hidden change.
  for (const records of [observed.resources, observed.fortifications]) {
    const entries = Object.entries(records); if (entries.length > 512) for (const [id] of entries.sort((a, b) => a[1].seenTick - b[1].seenTick || a[0].localeCompare(b[0])).slice(0, entries.length - 512)) delete records[id];
  }
}
function commandUnits(command: GameplayCommand): string[] {
  return 'unitIds' in command ? command.unitIds : 'builderIds' in command ? command.builderIds : command.kind === 'reseed_farm' ? [command.builderId] : [];
}
function completed(entity: ViewEntity): boolean { return entity.kind === 'building' && (entity.progress ?? 1) === 1; }
function adjacentFortifications(entity:ViewEntity,other:ViewEntity):boolean {
  if(entity.id===other.id||entity.ownerId!==other.ownerId)return false;
  const half=(value:ViewEntity):[number,number]=>{const [x,z]=buildings[value.typeId].footprintCells;return (value.rotation??0)%180?[z*grid/2,x*grid/2]:[x*grid/2,z*grid/2];};
  const [x,z]=half(entity),[ox,oz]=half(other),dx=Math.abs(entity.xMm-other.xMm),dz=Math.abs(entity.zMm-other.zMm);
  return Math.abs(dx-x-ox)<=1&&dz<z+oz||Math.abs(dz-z-oz)<=1&&dx<x+ox;
}
function commandCost(command: GameplayCommand): ResourceBank {
  if (command.kind === 'build') return { ...buildings[command.buildingType].cost };
  if (command.kind === 'build_wall') return Object.fromEntries(resources.map(resource => [resource, buildings[command.material === 'palisade' ? 'palisade_wall' : 'stone_wall'].cost[resource] * command.cells.length])) as ResourceBank;
  if (command.kind === 'replace_wall_with_gate') return { ...buildings.wooden_gate.cost };
  if (command.kind === 'train') return Object.fromEntries(resources.map(resource => [resource, units[command.unitType].cost[resource] * command.quantity])) as ResourceBank;
  if (command.kind === 'advance_age') return { ...ages[command.targetAge]!.cost };
  if (command.kind === 'research') return { ...technologies[command.technologyId].cost };
  if (command.kind === 'reseed_farm') return { ...buildings.farm.reseedCost! };
  return zero();
}

/** At most one bounded decision per simulation second; no clocks, IO or hidden state. */
export function planPlaythrough(view: PlayerView, memory: PlaythroughMemory, options: PlaythroughOptions = {}): GameplayCommand[] {
  observePlaythrough(view, memory);
  if (view.status !== 'RUNNING') { if (view.status === 'FINISHED') memory.telemetry.phase = 'finished'; return []; }
  if (view.tick < memory.nextDecisionTick) return [];
  memory.nextDecisionTick = view.tick + hz; memory.telemetry.decisions++;
  const boundedOption = (value: number, min: number, max: number) => { if (!Number.isFinite(value)) throw new Error('INVALID_PLAYTHROUGH_OPTION'); return Math.max(min, Math.min(max, Math.floor(value))); };
  const targetWorkers = boundedOption(options.targetWorkers ?? 20, 6, 40);
  const maximumCommands = boundedOption(options.maximumCommandsPerDecision ?? 8, 1, 12);
  const militaryPopulation = boundedOption(options.targetMilitaryPopulation ?? 70, 10, 150);
  memory.pending = memory.pending.filter(item => !(item.receipt?.status === 'accepted' && view.tick >= item.receipt.tick && view.self.lastCommandSequence >= item.clientSequence!));
  memory.telemetry.pendingWithoutReceipt = memory.pending.filter(item => !item.receipt && view.tick - item.tick > 60 * hz).length;
  if (memory.telemetry.pendingWithoutReceipt) memory.telemetry.lastBlocked = 'WAITING_FOR_COMMAND_RECEIPT';
  const own = view.entities.filter(entity => entity.ownerId === view.playerId && !entity.ghost);
  const ownIds = new Set(own.map(entity => entity.id));
  for (const record of [memory.assignments, memory.lastOrder, memory.lastTarget]) for (const id of Object.keys(record)) if (!ownIds.has(id)) delete record[id];
  for (const key of Object.keys(memory.cooldownUntil)) if (memory.cooldownUntil[key]! <= view.tick) delete memory.cooldownUntil[key];
  const workers = own.filter(entity => entity.typeId === 'villager' && !entity.garrisonedIn), army = own.filter(entity => entity.kind === 'unit' && !['villager', 'scout'].includes(entity.typeId) && !entity.garrisonedIn);
  const me = view.players.find(player => player.id === view.playerId)!;
  if (me.defeated) { memory.telemetry.phase = 'defeated'; return []; }
  const home = own.find(entity => entity.id === memory.homeId) ?? own.find(entity => entity.typeId === 'town_center');
  if (home) { memory.homeId = home.id; memory.home = { xMm: home.xMm, zMm: home.zMm }; }
  const anchor = memory.home ?? workers[0] ?? army[0] ?? own.find(entity => entity.typeId === 'scout' && !entity.garrisonedIn);
  if (!anchor) { memory.telemetry.lastBlocked = 'NO_SURVIVING_BASE_OR_WORKER'; return []; }
  memory.telemetry.maxWorkers = Math.max(memory.telemetry.maxWorkers, workers.length); memory.telemetry.maxMilitary = Math.max(memory.telemetry.maxMilitary, army.length);
  memory.telemetry.ageTicks[String(view.self.age)] ??= view.tick;
  for (const technology of view.self.technologies ?? []) memory.telemetry.technologyTicks[technology] ??= view.tick;
  memory.telemetry.phase = view.self.age === 4 ? 'military' : workers.length < targetWorkers ? 'economy' : 'ages';
  const commands: GameplayCommand[] = [], bank = { ...view.self.resources };
  for (const pending of memory.pending) for (const resource of resources) bank[resource] -= pending.cost[resource];
  const busy = new Set(memory.pending.flatMap(item => item.unitIds));
  const pendingKey = (key: string) => memory.pending.some(item => item.key === key);
  const affordable = (cost: ResourceBank) => resources.every(resource => bank[resource] >= cost[resource]);
  const emit = (command: GameplayCommand, key: string, armyTarget?: string): boolean => {
    const cost = commandCost(command), unitIds = commandUnits(command);
    if (commands.length >= maximumCommands || memory.pending.length >= 32 || pendingKey(key) || memory.cooldownUntil[key] > view.tick || !affordable(cost) || unitIds.some(id => busy.has(id))) return false;
    memory.pending.push({ command, key, cost, tick: view.tick, unitIds, ...(armyTarget === undefined ? {} : { armyTarget }) }); commands.push(command); memory.telemetry.emitted++;
    for (const resource of resources) bank[resource] -= cost[resource];
    for (const id of unitIds) { busy.add(id); memory.lastOrder[id] = view.tick; }
    return true;
  };
  const has = (type: BuildingId) => own.some(entity => entity.typeId === type) || pendingKey(`build:${type}`);
  const complete = (type: BuildingId) => own.some(entity => entity.typeId === type && completed(entity));
  const producerBusy = (id: string) => own.find(entity => entity.id === id)?.queue?.length || memory.pending.some(item => ('buildingId' in item.command && item.command.buildingId === id) || (item.command.kind === 'advance_age' && item.command.townCenterId === id));
  const nodes = view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && (entity.amount ?? 0) > 0);
  const farms = own.filter(entity => entity.typeId === 'farm');
  for (const worker of workers) if (!busy.has(worker.id) && !['gather', 'reseed'].includes(worker.order ?? '')) forgetWorker(memory, worker.id);
  for (const worker of workers) if (!memory.assignments[worker.id] && worker.order === 'gather' && worker.cargo?.resource) memory.assignments[worker.id] = worker.cargo.resource;
  for (const [farmId, workerId] of Object.entries(memory.farmAssignments)) if (!farms.some(farm => farm.id === farmId) || !ownIds.has(workerId)) delete memory.farmAssignments[farmId];
  const desired: ResourceBank = view.self.age < 4
    ? { food: Math.ceil(workers.length * .5), wood: Math.ceil(workers.length * .35), gold: Math.max(1, workers.length - Math.ceil(workers.length * .5) - Math.ceil(workers.length * .35)), stone: 0 }
    : { food: Math.ceil(workers.length * .4), wood: Math.ceil(workers.length * .3), gold: Math.max(1, workers.length - Math.ceil(workers.length * .4) - Math.ceil(workers.length * .3) - 1), stone: 1 };
  if(!home){
    // No producer can spend food/gold. Fund the ordinary replacement and keep
    // wood/stone drop-offs usable instead of waiting for an unreachable Age IV.
    const needsStone=bank.stone<buildings.town_center.cost.stone,needsWood=bank.wood<buildings.town_center.cost.wood;
    desired.food=desired.gold=0;desired.stone=needsStone&&complete('mining_camp')?(needsWood?Math.max(0,Math.min(workers.length-1,Math.ceil(workers.length*.4))):workers.length):0;desired.wood=workers.length-desired.stone;
  }
  const targets = (worker: ViewEntity, resource: ResourceType) => [...nodes.filter(node => node.resource === resource), ...(resource === 'food' ? farms.filter(farm => completed(farm) && (farm.amount ?? 0) > 0 && !farm.farmerAssigned && !memory.farmAssignments[farm.id]) : [])]
    .sort((a, b) => Number(a.id === memory.lastTarget[worker.id] && worker.taskState === 'blocked') - Number(b.id === memory.lastTarget[worker.id] && worker.taskState === 'blocked') || distance(worker, a) - distance(worker, b));
  const gather = (worker: ViewEntity, target: ViewEntity): boolean => {
    if (!emit({ kind: 'gather', unitIds: [worker.id], targetId: target.id, queued: false }, `worker:${worker.id}`)) return false;
    forgetWorker(memory, worker.id); memory.assignments[worker.id] = target.resource!; memory.lastTarget[worker.id] = target.id;
    if (target.typeId === 'farm') memory.farmAssignments[target.id] = worker.id;
    return true;
  };
  if (farms.length && !view.self.autoReseed) emit({ kind: 'set_auto_reseed', enabled: true }, 'auto_reseed');
  for (const [workerId, farmId] of Object.entries(memory.farmClaimsToRenew)) {
    const worker = workers.find(entity => entity.id === workerId), farm = farms.find(entity => entity.id === farmId);
    if (!worker || !farm || farm.farmerAssigned || !completed(farm) || !(farm.amount ?? 0)) { delete memory.farmClaimsToRenew[workerId]; if (memory.farmAssignments[farmId] === workerId) delete memory.farmAssignments[farmId]; continue; }
    gather(worker, farm);
  }

  const visible = new Set(view.fog.visible), columns = Math.ceil(view.map.widthMm / view.map.fogCellMm), terrain = view.map.terrain ?? [];
  function legalSite(cell: Cell, width: number, depth: number): boolean {
    const left = cell.x * grid, top = cell.z * grid, w = width * grid, d = depth * grid;
    if (left < 0 || top < 0 || left + w > view.map.widthMm || top + d > view.map.heightMm || !terrainBuildable(terrain, { xMm: left, zMm: top, widthMm: w, depthMm: d })) return false;
    for (let z = Math.floor(top / view.map.fogCellMm); z <= Math.floor((top + d - 1) / view.map.fogCellMm); z++) for (let x = Math.floor(left / view.map.fogCellMm); x <= Math.floor((left + w - 1) / view.map.fogCellMm); x++) if (!visible.has(z * columns + x)) return false;
    return !view.entities.some(entity => {
      if (entity.ghost || entity.garrisonedIn || entity.kind === 'resource' && !(entity.amount ?? 0)) return false;
      if (entity.kind === 'unit') return Math.hypot(Math.max(left - entity.xMm, 0, entity.xMm - left - w), Math.max(top - entity.zMm, 0, entity.zMm - top - d)) < units[entity.typeId].collisionRadiusM * 1000 + 100;
      let halfWidth = entity.kind === 'building' ? buildings[entity.typeId].footprintCells[0] * grid / 2 : entity.resource === 'wood' ? 450 : 650;
      let halfDepth = entity.kind === 'building' ? buildings[entity.typeId].footprintCells[1] * grid / 2 : halfWidth;
      if ((entity.rotation ?? 0) % 180) [halfWidth, halfDepth] = [halfDepth, halfWidth];
      return entity.xMm + halfWidth + 1000 > left && entity.xMm - halfWidth - 1000 < left + w && entity.zMm + halfDepth + 1000 > top && entity.zMm - halfDepth - 1000 < top + d;
    });
  }
  function sites(width: number, depth: number, near: Position = anchor!): Cell[] {
    const candidates: Cell[] = [];
    for (let z = -18; z <= 18; z += 2) for (let x = -18; x <= 18; x += 2) { const cell = { x: Math.floor(anchor!.xMm / grid) + x, z: Math.floor(anchor!.zMm / grid) + z }; if (legalSite(cell, width, depth)) candidates.push(cell); }
    // Preserve existing choices when the coarse scan succeeds. A crowded base
    // may leave only an origin on one of the omitted building-grid parities.
    if (!candidates.length) for (let z = -18; z <= 18; z++) for (let x = -18; x <= 18; x++) {
      if (x % 2 === 0 && z % 2 === 0) continue;
      const cell = { x: Math.floor(anchor!.xMm / grid) + x, z: Math.floor(anchor!.zMm / grid) + z };
      if (legalSite(cell, width, depth)) candidates.push(cell);
    }
    return candidates.sort((a, b) => distance({ xMm: (a.x + width / 2) * grid, zMm: (a.z + depth / 2) * grid }, near) - distance({ xMm: (b.x + width / 2) * grid, zMm: (b.z + depth / 2) * grid }, near) || a.z - b.z || a.x - b.x);
  }
  const builder = (near: Position) => workers.filter(worker => !busy.has(worker.id) && !['build', 'reseed'].includes(worker.order ?? '')).sort((a, b) => distance(a, near) - distance(b, near))[0];
  // Auto-reseed needs an existing gatherer. Recover one abandoned exhausted
  // farm through a paid command, reserving both its worker and farm until the
  // authoritative view acknowledges the receipt.
  const abandonedFarm = desired.food > 0 ? farms.find(farm => completed(farm) && farm.farmState === 'exhausted' && farm.amount === 0 && !farm.farmerAssigned && !memory.farmAssignments[farm.id] && !pendingKey(`reseed:${farm.id}`)) : undefined;
  if (abandonedFarm) {
    const worker = workers.filter(worker => worker.order === 'idle' && !busy.has(worker.id)).sort((a, b) => distance(a, abandonedFarm) - distance(b, abandonedFarm))[0];
    if (worker && emit({ kind: 'reseed_farm', farmId: abandonedFarm.id, builderId: worker.id }, `reseed:${abandonedFarm.id}`)) {
      forgetWorker(memory, worker.id); memory.assignments[worker.id] = 'food'; memory.lastTarget[worker.id] = abandonedFarm.id; memory.farmAssignments[abandonedFarm.id] = worker.id;
    }
  }
  const unfinished = own.filter(entity => entity.kind === 'building' && !completed(entity));
  const buildingPending = () => memory.pending.some(item => ['build', 'build_wall', 'replace_wall_with_gate'].includes(item.command.kind));
  function build(type: Structure): boolean {
    const def = buildings[type]; if (def.minAge > view.self.age || !affordable(def.cost) || unfinished.length || buildingPending()) return false;
    const resource = type === 'mill' ? 'food' : type === 'lumber_camp' ? 'wood' : type === 'mining_camp' ? 'gold' : undefined;
    const near = resource ? nodes.filter(node => node.resource === resource).sort((a, b) => distance(anchor!, a) - distance(anchor!, b))[0] ?? anchor! : anchor!;
    const candidates = sites(def.footprintCells[0], def.footprintCells[1], near), site = candidates[(memory.siteAttempt[type] ?? 0) % Math.min(candidates.length, 24)];
    if (!site) { memory.telemetry.lastBlocked = `NO_VISIBLE_SITE:${type}`; return false; }
    const worker = builder({ xMm: (site.x + def.footprintCells[0] / 2) * grid, zMm: (site.z + def.footprintCells[1] / 2) * grid });
    if (!worker || !emit({ kind: 'build', buildingType: type, builderIds: [worker.id], originCell: site, rotation: 0, queued: false }, `build:${type}`)) return false;
    forgetWorker(memory, worker.id); return true;
  }
  // Rescue interrupted construction through the same legal work order as a human.
  if (unfinished.length && !workers.some(worker => worker.order === 'build' && worker.taskState !== 'blocked') && !buildingPending()) {
    const site = unfinished[0]!, worker = builder(site);
    if (worker && emit({ kind: 'continue_build', builderIds: [worker.id], foundationId: site.id, queued: false }, `continue:${site.id}`)) forgetWorker(memory, worker.id);
  }
  const forage = nodes.filter(node => node.resource === 'food').reduce((sum, node) => sum + (node.amount ?? 0), 0);
  const queuedWorkers = own.reduce((sum, entity) => sum + (entity.queue?.filter(job => job.kind === 'train' && job.typeId === 'villager').length ?? 0), 0);
  const militaryPop = army.reduce((sum, unit) => sum + units[unit.typeId].population, 0);
  const needPopulation = workers.length + queuedWorkers < targetWorkers || view.self.age === 4 && militaryPop < militaryPopulation;
  let needed: Structure | undefined;
  if (!home && bank.wood < buildings.town_center.cost.wood && !complete('lumber_camp')) needed = 'lumber_camp';
  else if (!home && bank.stone < buildings.town_center.cost.stone && !complete('mining_camp')) needed = 'mining_camp';
  else if (!home) needed = 'town_center';
  else if (needPopulation && view.self.population + view.self.reservedPopulation >= view.self.populationCap - 3) needed = 'house';
  else if (!has('mill')) needed = 'mill';
  else if (!has('lumber_camp')) needed = 'lumber_camp';
  else if (!has('mining_camp')) needed = 'mining_camp';
  else if (forage < 350 && farms.length < desired.food) needed = 'farm';
  else if (view.self.age >= 2 && !has('market')) needed = 'market';
  else if (view.self.age >= 2 && !has('blacksmith')) needed = 'blacksmith';
  else if (view.self.age >= 3 && !has('siege_workshop')) needed = 'siege_workshop';
  else if (view.self.age >= 3 && !has('university')) needed = 'university';
  else if (view.self.age >= 2 && !has('watchtower') && bank.wood >= 250) needed = 'watchtower';
  else if (view.self.age === 4 && !has('barracks')) needed = 'barracks';
  else if (view.self.age === 4 && !has('archery_range')) needed = 'archery_range';
  if (needed) build(needed);
  if (home && view.self.age < 4 && !own.some(entity => entity.queue?.some(job => job.kind === 'age')) && !pendingKey('age')) {
    const next = ages[view.self.age + 1]!;
    if (next.prerequisites.every(rule => rule.kind === 'completed_buildings' ? rule.types.every(complete) : rule.types.filter(complete).length >= rule.count)) emit({ kind: 'advance_age', townCenterId: home.id, targetAge: next.id as 2 | 3 | 4 }, 'age');
  }
  for (const id of home?['forestry_1', 'forestry_2', 'forestry_3'] as TechnologyId[]:[]) {
    const tech = technologies[id], producer = own.find(entity => entity.typeId === tech.researchedAt && completed(entity));
    if (view.self.age >= tech.minAge && producer && !producerBusy(producer.id) && !(view.self.technologies ?? []).includes(id) && tech.prerequisites.every(prerequisite => view.self.technologies?.includes(prerequisite))) {
      emit({ kind: 'research', buildingId: producer.id, technologyId: id }, `research:${id}`); break;
    }
  }
  if (home && workers.length + queuedWorkers < targetWorkers && !producerBusy(home.id) && view.self.population + view.self.reservedPopulation < view.self.populationCap)
    emit({ kind: 'train', buildingId: home.id, unitType: 'villager', quantity: 1 }, `producer:${home.id}`);

  // A short open-ended defensive line exercises paid walls, then a real three-wall
  // replacement gate. It deliberately does not encircle or sever gathering routes.
  if (view.self.age >= 2 && !memory.defenseComplete && !unfinished.length && !buildingPending() && !needed && bank.wood >= 100) {
    if (!memory.defenseCells) {
      const candidates = sites(7, 1).filter(cell => distance({ xMm: (cell.x + 3.5) * grid, zMm: (cell.z + .5) * grid }, anchor) >= 14000);
      const site = candidates[(memory.siteAttempt.defense ?? 0) % Math.min(candidates.length, 24)], worker = site && builder({ xMm: (site.x + 3.5) * grid, zMm: (site.z + .5) * grid });
      if (site && worker) { const cells = Array.from({ length: 7 }, (_, index) => ({ x: site.x + index, z: site.z })); if (emit({ kind: 'build_wall', builderIds: [worker.id], material: 'palisade', cells, queued: false }, 'defense_wall')) { memory.defenseCells = cells; forgetWorker(memory, worker.id); } }
    } else {
      const middle = memory.defenseCells.slice(2, 5), walls = middle.map(cell => own.find(entity => entity.typeId === 'palisade_wall' && entity.xMm === (cell.x + .5) * grid && entity.zMm === (cell.z + .5) * grid && completed(entity)));
      const gate = own.find(entity => entity.typeId === 'wooden_gate' && entity.xMm === (middle[1]!.x + .5) * grid && entity.zMm === (middle[1]!.z + .5) * grid);
      if (gate && completed(gate)) memory.defenseComplete = true;
      else if (!gate && walls.every(Boolean)) { const worker = builder(walls[1]!); if (worker && emit({ kind: 'replace_wall_with_gate', builderIds: [worker.id], wallIds: walls.map(wall => wall!.id), queued: false }, 'defense_gate')) forgetWorker(memory, worker.id); }
      else if (!gate && !own.some(entity => entity.typeId === 'palisade_wall' && memory.defenseCells!.some(cell => entity.xMm === (cell.x + .5) * grid && entity.zMm === (cell.z + .5) * grid))) delete memory.defenseCells;
    }
  }
  if (home && view.self.age === 4 && militaryPop < militaryPopulation) {
    const count = (type: UnitId) => own.filter(entity => entity.typeId === type).length + own.reduce((sum, entity) => sum + (entity.queue?.filter(job => job.kind === 'train' && job.typeId === type).length ?? 0), 0);
    for (const preferred of ['battering_ram', 'militia', 'archer'] as const) {
      if (preferred === 'battering_ram' && count(preferred) >= 3) continue;
      const type: UnitId = affordable(units[preferred].cost) ? preferred : preferred === 'militia' ? 'spearman' : preferred === 'archer' ? 'skirmisher' : preferred;
      const producer = own.find(entity => entity.typeId === units[type].producedAt && completed(entity) && !producerBusy(entity.id));
      const pendingPop = memory.pending.reduce((sum, item) => sum + (item.command.kind === 'train' ? units[item.command.unitType].population * item.command.quantity : 0), 0);
      if (producer && view.self.population + view.self.reservedPopulation + pendingPop + units[type].population <= view.self.populationCap) emit({ kind: 'train', buildingId: producer.id, unitType: type, quantity: 1 }, `producer:${producer.id}`);
    }
  }

  // Last: idle workers get current, visible resource orders. Reserving farms before
  // returning the batch prevents two carrying workers claiming the same empty farm.
  const assignmentCount = (resource: ResourceType) => Object.values(memory.assignments).filter(value => value === resource).length;
  for (const worker of workers) {
    if (busy.has(worker.id)) continue;
    const idle = worker.order === 'idle' || worker.blockedReason === 'FARM_OCCUPIED', retry = worker.taskState === 'blocked' && worker.order === 'gather' && view.tick - (memory.lastOrder[worker.id] ?? 0) >= 10 * hz;
    if (!idle && !retry) continue;
    forgetWorker(memory, worker.id);
    const priorities = resources.filter(resource => desired[resource] > 0).sort((a, b) => (desired[b] - assignmentCount(b)) / desired[b] - (desired[a] - assignmentCount(a)) / desired[a]);
    for (const resource of priorities) { const target = targets(worker, resource)[0]; if (target && gather(worker, target)) break; }
  }
  if (view.tick - memory.lastRebalanceTick >= 5 * hz) {
    const deficient = resources.filter(resource => desired[resource] > assignmentCount(resource)).sort((a, b) => (desired[b] - assignmentCount(b)) / desired[b] - (desired[a] - assignmentCount(a)) / desired[a]);
    for (const resource of deficient) {
      const worker = workers.find(worker => !busy.has(worker.id) && worker.order === 'gather' && memory.assignments[worker.id] && assignmentCount(memory.assignments[worker.id]!) > desired[memory.assignments[worker.id]!]);
      const target = worker && targets(worker, resource)[0]; if (worker && target && gather(worker, target)) { memory.lastRebalanceTick = view.tick; break; }
    }
  }

  const hostile = (entity: ViewEntity) => entity.ownerId !== null && view.players.some(player => player.id === entity.ownerId && player.teamId !== me.teamId && !player.defeated);
  const threats = view.entities.filter(entity => !entity.ghost && hostile(entity));
  const militaryOnly = !home && workers.length === 0;
  if ((view.self.age === 4 || militaryOnly) && army.length > 0 && (army.length >= 12 || memory.assaultStarted || militaryOnly) && view.tick - memory.lastArmyOrderTick >= 5 * hz) {
    const fortifications=threats.filter(entity=>entity.kind==='building'&&completed(entity)&&entity.hp>0&&Boolean(buildings[entity.typeId].wallEquivalentCells));
    const retainedBreach=fortifications.find(entity=>entity.id===memory.lastArmyTarget),blocked=army.some(unit=>unit.taskState==='blocked');
    const connected=!memory.telemetry.evidence.fortificationBreach.met?fortifications.filter(entity=>['palisade_wall','stone_wall'].includes(entity.typeId)&&fortifications.filter(other=>adjacentFortifications(entity,other)).length>=2):[];
    const breachCandidates=connected.length?connected:blocked?fortifications:[];
    const retained=retainedBreach&&(!connected.length||connected.includes(retainedBreach))?retainedBreach:undefined;
    const breach=retained??breachCandidates.sort((a,b)=>distance(a,army[0]!)-distance(b,army[0]!)||a.id.localeCompare(b.id))[0];
    const target = breach??threats.sort((a, b) => Number(distance(a, anchor) > 25000) - Number(distance(b, anchor) > 25000) || Number(a.kind !== 'unit') - Number(b.kind !== 'unit') || distance(a, army[0]!) - distance(b, army[0]!))[0];
    const remembered = view.entities.filter(entity => entity.ghost && hostile(entity)).sort((a, b) => distance(a, army[0]!) - distance(b, army[0]!))[0];
    const destination = target ?? remembered;
    if (destination) {
      // An accepted destination remains the group's intention. A straggler or
      // reinforcement must not erase progressing teammates' paths/search work.
      const changed = memory.lastArmyTarget !== destination.id;
      const ids = army.filter(unit => !busy.has(unit.id) && (changed || unit.order === 'idle' || unit.taskState === 'blocked')).map(unit => unit.id);
      const command: GameplayCommand = target ? { kind: 'attack_target', unitIds: ids, targetId: target.id, queued: false } : { kind: 'attack_move', unitIds: ids, target: { xMm: destination.xMm, zMm: destination.zMm }, queued: false };
      if (ids.length && emit(command, 'army', destination.id)) { memory.lastArmyOrderTick = view.tick; memory.telemetry.phase = 'combat'; if (target) memory.telemetry.visibleCombatOrders++; }
    }
  }
  const obstacles = terrainObstacles(terrain), explored = new Set(view.fog.explored);
  const traversable = (point: Position) => point.xMm > 1000 && point.zMm > 1000 && point.xMm < view.map.widthMm - 1000 && point.zMm < view.map.heightMm - 1000 && !obstacles.some(obstacle => Math.abs(point.xMm - obstacle.xMm) < obstacle.halfWidth + 700 && Math.abs(point.zMm - obstacle.zMm) < obstacle.halfHeight + 700);
  // A serpentine grid is public map geometry, never a hidden entity lookup.
  // After exploration, revisit it cyclically: concealed surviving units still
  // prevent conquest. Each decision examines at most the bounded map grid once.
  const searchPoints: Position[] = [];
  if (view.self.age === 4) for (let zMm = 12000, row = 0; zMm < view.map.heightMm; zMm += 20000, row++) {
    const points: Position[] = [];
    for (let xMm = 12000; xMm < view.map.widthMm; xMm += 20000) { const point = { xMm, zMm }; if (traversable(point)) points.push(point); }
    searchPoints.push(...(row % 2 ? points.reverse() : points));
  }
  const unexplored = searchPoints.filter(point => !explored.has(Math.floor(point.zMm / view.map.fogCellMm) * columns + Math.floor(point.xMm / view.map.fogCellMm)));
  const revisit = view.self.age === 4 && !unexplored.length && !threats.length && !view.entities.some(entity => entity.ghost && hostile(entity));
  function nextRevisitPoint(from: Position): Position | undefined {
    if (!searchPoints.length) return;
    memory.revisitIndex ??= searchPoints.reduce((best, point, index) => distance(point, from) < distance(searchPoints[best]!, from) ? index : best, 0);
    for (let attempt = 0; attempt < searchPoints.length; attempt++) {
      const point = searchPoints[memory.revisitIndex % searchPoints.length]!;
      memory.revisitIndex = (memory.revisitIndex + 1) % searchPoints.length;
      if (distance(point, from) > 3000) return point;
    }
  }
  const scout = own.find(entity => entity.typeId === 'scout' && !entity.garrisonedIn);
  if (scout && !busy.has(scout.id) && (scout.order === 'idle' || scout.taskState === 'blocked') && view.tick - (memory.lastOrder[scout.id] ?? -1000) >= 5 * hz) {
    let target: Position | undefined;
    if (view.self.age < 4) {
      const offsets = [[-30000, -30000], [30000, -30000], [30000, 30000], [-30000, 30000]];
      for (let i = 0; i < offsets.length; i++) { const [x, z] = offsets[memory.scoutIndex++ % offsets.length]!; const point = { xMm: anchor.xMm + x!, zMm: anchor.zMm + z! }; if (traversable(point)) { target = point; break; } }
    } else {
      target = unexplored.length ? unexplored.sort((a, b) => distance(a, scout) - distance(b, scout) || a.zMm - b.zMm || a.xMm - b.xMm)[memory.scoutIndex++ % Math.min(unexplored.length, 4)] : revisit ? nextRevisitPoint(scout) : undefined;
    }
    if (target) emit({ kind: 'move', unitIds: [scout.id], target, queued: false }, `scout:${scout.id}`);
  } else if (!scout && home && completed(home) && !producerBusy(home.id)) {
    // Losing the scout can conceal the remaining resource nodes before Empire.
    // Rebuild it through normal paid production at any age, after other jobs.
    const pendingPopulation = memory.pending.reduce((sum, item) => sum + (item.command.kind === 'train' ? units[item.command.unitType].population * item.command.quantity : 0), 0);
    if (view.self.population + view.self.reservedPopulation + pendingPopulation + units.scout.population <= view.self.populationCap)
      emit({ kind: 'train', buildingId: home.id, unitType: 'scout', quantity: 1 }, `producer:${home.id}`);
  }
  if (revisit && view.tick - memory.lastArmyOrderTick >= 5 * hz) {
    // Leave every current path/engagement alone; only idle military units join a
    // new sweep leg. Attack-move retains ordinary visible-enemy acquisition.
    const idle = army.filter(unit => unit.order === 'idle' && !busy.has(unit.id));
    const target = idle.length ? nextRevisitPoint(idle[0]!) : undefined;
    if (target && emit({ kind: 'attack_move', unitIds: idle.map(unit => unit.id), target, queued: false }, 'army')) {
      memory.lastArmyOrderTick = view.tick;
    }
  }
  return commands;
}
