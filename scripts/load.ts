import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createSimulation, restoreSimulation, type Simulation } from '@frontier/simulation';
import { balance, buildings, units, contentHash, createPreparedViewScope, effectiveUnit, TEAM_IDENTITIES, type GameplayCommand, type PlayerView, type PreparedViewHandle, type PreparedViewScope, type PublicPlayer } from '@frontier/shared';
import { Navigation } from '../packages/simulation/src/navigation.js';
import type { PathRequest, PathScheduler, PathWorkReport } from '../packages/simulation/src/path-scheduler.js';
import type { CommittedAction } from '../packages/simulation/src/observed-actions.js';
import { engineIdentity } from '../apps/server/src/build-info.js';
import { capacityTimingContract, capacityDutyCommands, createCapacityDutyMemory, createCapacityFixture, type CapacityFixture } from './load-fixture.js';

declare const __PROFILE_EXECUTION__: 'bundled-production' | undefined;
const execution = typeof __PROFILE_EXECUTION__ === 'string' ? __PROFILE_EXECUTION__ : 'source-tsx';

interface ActivityEvidence {
  completeMinuteWindows:number;eachMinuteMovement:boolean;eachMinuteGathering:boolean;
  eachMinuteRepair:boolean;eachMinuteCombat:boolean;eachFactionCollectsEveryMinute:boolean;
  everySurvivingUnitActiveEachMinute:boolean;
}
/** A short diagnostic has no complete activity evidence; populated units alone do not pass. */
export function capacityActivityPassed(evidence:ActivityEvidence):boolean {
  return evidence.completeMinuteWindows>0&&evidence.eachMinuteMovement&&evidence.eachMinuteGathering&&evidence.eachMinuteRepair&&evidence.eachMinuteCombat&&evidence.eachFactionCollectsEveryMinute&&evidence.everySurvivingUnitActiveEachMinute;
}
interface UnitActivityCensus {
  acceptedCommands:number;acceptedMoveCommands:number;lastAcceptedTick?:number;lastAcceptedKind?:string;
  pathRequests:number;invalidationRestarts:number;firstRequestTick?:number;lastRequestTick?:number;lastRequestId?:string;lastOrderRevision?:number;
}
/** Host diagnostic only: bounded counters, no world snapshots in the tick loop. */
export function createCapacityActivityCensus(capacity=8192){
  if(!Number.isInteger(capacity)||capacity<1||capacity>8192)throw Error('INVALID_ACTIVITY_CENSUS_CAPACITY');
  const records=new Map<string,UnitActivityCensus>(),totals={acceptedUnitCommands:0,pathRequests:0,invalidationRestarts:0,evictions:0};
  const get=(id:string)=>{let record=records.get(id);if(!record){if(records.size>=capacity){records.delete(records.keys().next().value!);totals.evictions++;}record={acceptedCommands:0,acceptedMoveCommands:0,pathRequests:0,invalidationRestarts:0};records.set(id,record);}return record;};
  return {capacity,totals,
    accepted(command:GameplayCommand,tick:number){for(const id of 'unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:[]){const record=get(id);record.acceptedCommands++;if(command.kind==='move')record.acceptedMoveCommands++;record.lastAcceptedTick=tick;record.lastAcceptedKind=command.kind;totals.acceptedUnitCommands++;}},
    requested(request:PathRequest,tick:number,invalidated:boolean){const record=get(request.unitId);record.pathRequests++;totals.pathRequests++;if(invalidated){record.invalidationRestarts++;totals.invalidationRestarts++;}record.firstRequestTick??=tick;record.lastRequestTick=tick;record.lastRequestId=request.id;record.lastOrderRevision=request.orderRevision;},
    read(id:string){const record=records.get(id);return record?{...record}:undefined;},
  };
}
export function observeCapacityPathRequests(scheduler:PathScheduler,census:ReturnType<typeof createCapacityActivityCensus>,tick:()=>number):()=>void {
  const request=scheduler.request,invalidate=scheduler.invalidate;let invalidating=0;
  scheduler.request=function(input){const result=request.call(this,input);census.requested(input,tick(),invalidating>0);return result;};
  scheduler.invalidate=function(...args){invalidating++;try{return invalidate.apply(this,args);}finally{invalidating--;}};
  return ()=>{scheduler.request=request;scheduler.invalidate=invalidate;};
}

function setting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`INVALID_${name}`); return value;
}
export function distribution(values: number[]) {
  if (!values.length) return { samples: 0, min: 0, median: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b), at = (part: number) => sorted[Math.max(0, Math.ceil(sorted.length * part) - 1)]!;
  return { samples: values.length, min: sorted[0]!, median: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1)!, mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}
export function densitySummary(values: number[], expectedUnits: number) {
  return { ...distribution(values), expectedUnits, samplesAtNominal: values.filter(value => value >= expectedUnits).length, samplesBelow95Percent: values.filter(value => value < expectedUnits * .95).length, samplesBelow90Percent: values.filter(value => value < expectedUnits * .9).length, nominalFraction: values.length ? values.filter(value => value >= expectedUnits).length / values.length : 0 };
}
export function memoryTrend(samples: { elapsedMs: number; rssMiB: number; heapUsedMiB: number }[]) {
  const steady = samples.filter(sample => sample.elapsedMs >= 600000), slope = (key: 'rssMiB' | 'heapUsedMiB') => {
    if (steady.length < 2) return null;
    const meanX = steady.reduce((sum, sample) => sum + sample.elapsedMs / 60000, 0) / steady.length, meanY = steady.reduce((sum, sample) => sum + sample[key], 0) / steady.length;
    const denominator = steady.reduce((sum, sample) => sum + (sample.elapsedMs / 60000 - meanX) ** 2, 0);
    return denominator ? steady.reduce((sum, sample) => sum + (sample.elapsedMs / 60000 - meanX) * (sample[key] - meanY), 0) / denominator : null;
  };
  return { excludesFirstMinutes: 10, sampledMinutes: steady.length ? (steady.at(-1)!.elapsedMs - steady[0]!.elapsedMs) / 60000 : 0, rssMiBPerMinute: slope('rssMiB'), heapMiBPerMinute: slope('heapUsedMiB'), automaticNoLeakClaim: false };
}
type Measurement = { calls: number; totalMs: number; maxMs: number };
/** Stage hooks are diagnostic only; ordinary capacity timing keeps native dispatch. */
export function installLoadStageProfile(simulation: Record<string, unknown>, enabled: boolean) {
  const stages: Record<string, Measurement> = {}, restores: (() => void)[] = [];
  const restore = () => { while (restores.length) restores.pop()!(); };
  const measure = (target: Record<string, unknown>, key: string, label: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key), original = target[key];
    if (typeof original !== 'function' || (descriptor && !('value' in descriptor))) throw new Error(`UNKNOWN_PROFILE_STAGE:${label}`);
    const metric = stages[label] = { calls: 0, totalMs: 0, maxMs: 0 };
    const wrapped = function(this: unknown, ...args: unknown[]) { const start = performance.now(); try { return original.apply(this, args); } finally { const ms = performance.now() - start; metric.calls++; metric.totalMs += ms; metric.maxMs = Math.max(metric.maxMs, ms); } };
    Object.defineProperty(target, key, { ...(descriptor ?? { configurable: true, enumerable: true, writable: true }), value: wrapped });
    restores.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; });
  };
  if (enabled) try {
    for (const stage of ['advanceControllers', 'advanceProduction', 'advanceWork', 'advanceMovement', 'updateVision', 'resolveDeaths', 'observeActions', 'evaluateVictory']) measure(simulation, stage, stage);
    measure(Navigation.prototype as unknown as Record<string, unknown>, 'pathToAny', 'navigation.pathToAny');
  } catch (error) { restore(); throw error; }
  return { stages, restore };
}
export function loadTimingQualificationEligible(environment: Record<string, string | undefined>): boolean {
  return !['LOAD_STAGE_PROFILE', 'LOAD_NAV_CENSUS', 'LOAD_NAV_LINE_CENSUS', 'LOAD_ACTIVITY_CENSUS', 'LOAD_REPLICATION_CENSUS'].some(flag => environment[flag] === '1');
}
/** Optional host-only timings: fixed counters, no retained views or per-call samples. */
export function createReplicationPhaseCensus() {
  const empty = (): Measurement => ({ calls: 0, totalMs: 0, maxMs: 0 });
  const phases = { views: empty(), stringify: empty(), prepareJson: empty(), deltaEncoding: empty(), snapshotEncoding: empty(), byteCount: empty() };
  const measure = <T>(phase: keyof typeof phases, operation: () => T): T => {
    const start = performance.now();
    try { return operation(); }
    finally { const ms = performance.now() - start, metric = phases[phase]; metric.calls++; metric.totalMs += ms; metric.maxMs = Math.max(metric.maxMs, ms); }
  };
  return {
    report: { hostOnly: true, timingQualificationEligible: false, phases, scope: 'Non-overlapping synchronous phase timings in milliseconds; calls include failed attempts. Views is per publication batch; other phases are per viewpoint. All original JSON validation and encoding execute; no IPC, socket, chunking or compression measurement.' },
    views(generate: () => PlayerView[]): PlayerView[] { return measure('views', generate); },
    encode(view: PlayerView, encoder: PreparedViewScope, readBase: () => PreparedViewHandle | undefined) {
      const text = measure('stringify', () => JSON.stringify(view)), prepared = measure('prepareJson', () => encoder.prepareJson(text)), before = readBase();
      const encoded = before ? measure('deltaEncoding', () => encoder.encodeDeltaMessage(before, prepared)) : measure('snapshotEncoding', () => JSON.stringify({ type: 'snapshot', view }));
      const size = measure('byteCount', () => Buffer.byteLength(encoded));
      return { prepared, encoded, size };
    },
  };
}
interface Observation { tick: number; elapsedMs: number; units: number; population: number; resources: number; activeResources: number; nonWallStructures: number; wallEquivalentCells: number; garrisoned: number; moving: number; gathering: number; repairing: number; blocked: number; queuedJobs: number; projectiles: number; journalBytes: number; rssMiB: number; heapUsedMiB: number; externalMiB: number; path: PathWorkReport; factions: { id: string; units: number; population: number; lost: number; collected: number; spent: number; defeated: boolean }[] }

export async function runLoad(): Promise<void> {
  const profile = process.env.LOAD_PROFILE ?? 'starting';
  if (!['starting', 'capacity120', 'capacity200', 'mixed120', 'mixed200'].includes(profile)) throw new Error('INVALID_LOAD_PROFILE');
  const capacity = profile !== 'starting', populationLimit = profile.endsWith('200') ? 200 : 120;
  const forestArgument=process.argv.slice(2).filter(argument=>argument!=='--').find(argument=>argument.startsWith('--forest='));
  const forestValue=forestArgument?.slice('--forest='.length)??process.env.LOAD_FOREST??'0';
  if(!['0','1'].includes(forestValue))throw new Error('INVALID_LOAD_FOREST');
  const forest=forestValue==='1';if(forest&&!capacity)throw new Error('FOREST_FIXTURE_REQUIRES_CAPACITY');
  const stageProfilingEnabled = process.env.LOAD_STAGE_PROFILE === '1';
  const activityCensus=process.env.LOAD_ACTIVITY_CENSUS==='1'?createCapacityActivityCensus():undefined;
  const replicationCensus=process.env.LOAD_REPLICATION_CENSUS==='1'?createReplicationPhaseCensus():undefined;
  if(activityCensus&&!capacity)throw Error('ACTIVITY_CENSUS_REQUIRES_CAPACITY');
  const factionCount = setting('LOAD_FACTIONS', 11, 2, 11), aiCount = setting('LOAD_AI', Math.min(5, factionCount - 1), 0, Math.min(5, factionCount));
  if (factionCount - aiCount > 6) throw new Error('LOAD_MORE_THAN_SIX_HUMANS');
  const minutes = setting('LOAD_MINUTES', 0, 0, 1440), realtime = process.env.LOAD_REALTIME === '1' || minutes > 0;
  const authoritativeIntervalMs=setting('LOAD_FRAME_MS',300,50,300);if(authoritativeIntervalMs!==50&&authoritativeIntervalMs!==300)throw new Error('INVALID_LOAD_FRAME_MS');
  const timingContract=capacityTimingContract(authoritativeIntervalMs),frameTicks=timingContract.frameTicks;
  if (minutes && minutes < 60) throw new Error('LOAD_SOAK_MINIMUM_60_MINUTES');
  if (minutes && process.env.LOAD_TICKS !== undefined) throw new Error('LOAD_CHOOSE_TICKS_OR_MINUTES');
  const ticks = minutes ? minutes * 60 * balance.rules.simulationHz : setting('LOAD_TICKS', 1200, 1, 1728000);
  if(ticks%frameTicks)throw new Error('LOAD_TICKS_MUST_ALIGN_FRAME');
  const maximumWallMinutes = setting('LOAD_MAX_WALL_MINUTES', minutes ? Math.ceil(minutes * 1.1) : 15, 1, 2880);
  if (minutes && maximumWallMinutes < minutes) throw new Error('LOAD_WALL_LIMIT_SHORTER_THAN_SOAK');
  const replicationHz = process.env.LOAD_VIEW_HZ===undefined?1000/timingContract.publicationIntervalMs:Number(process.env.LOAD_VIEW_HZ);
  if(!Number.isFinite(replicationHz)||replicationHz<0||replicationHz>timingContract.frameHz)throw new Error('INVALID_LOAD_VIEW_HZ');
  if (replicationHz && !Number.isInteger(balance.rules.simulationHz/replicationHz)) throw new Error('LOAD_VIEW_HZ_MUST_DIVIDE_TICK_RATE');
  const seed = process.env.LOAD_SEED ?? 'maximum-player-capacity-v1', mapType = process.env.LOAD_MAP ?? 'open_frontier';
  if (mapType !== 'open_frontier' && mapType !== 'river_divide') throw new Error('INVALID_LOAD_MAP');
  if (capacity && mapType !== 'open_frontier') throw new Error('CAPACITY_FIXTURE_IS_EXPLICIT_FLAT_MAP');
  const autonomous = capacity ? process.env.LOAD_AI_POLICY === '1' : true;
  const factions: PublicPlayer[] = Array.from({ length: factionCount }, (_, index) => ({ id: `p${index}`, name: `Load ${index}`, teamId: `t${index}`, color: TEAM_IDENTITIES[index]!.color, pattern: index, kind: index >= factionCount - aiCount ? 'ai' : 'human', difficulty: capacity ? 'medium' : 'easy', personality: balance.ai.personalities[index % balance.ai.personalities.length] as PublicPlayer['personality'], hostPlayer: index === 0 }));
  const freeMemoryGiBAtSetup = os.freemem() / 1073741824, setupStarted = performance.now(); let fixture: CapacityFixture | undefined, simulation: Simulation;
  if (capacity) { fixture = createCapacityFixture({ factions, identity: engineIdentity, populationLimit, seed, composition: profile.startsWith('mixed') ? 'mixed' : 'one-pop', controllers: autonomous,forest,authoritativeIntervalMs }); simulation = restoreSimulation(fixture.save, engineIdentity, { preserveEpoch: true }); }
  else simulation = createSimulation({ factions, seed, mapType, matchId: 'load-starting-match', populationLimit,authoritativeIntervalMs });
  const setupMs = performance.now() - setupStarted;
  const internals = simulation as unknown as { committedActions: Map<string, CommittedAction> } & Record<string, unknown>;
  const { stages, restore: restoreStages } = installLoadStageProfile(internals, stageProfilingEnabled), restores: (() => void)[] = [restoreStages];
  if(activityCensus)restores.push(observeCapacityPathRequests(internals.pathScheduler as PathScheduler,activityCensus,()=>simulation.state.tick));
  // Optional census of original geometry executions. Owned-cache hits bypass
  // this prototype method; instrumented timings are not qualification evidence.
  const navigationQueryCensus=process.env.LOAD_NAV_CENSUS==='1'?{queries:0,eligibleGridQueries:0,repeatedCompletedQueries:0,completedKeyInsertions:0,evictions:0,instancesWithEligibleQueries:0,capacityPerInstance:8192,measuredCallsReuseAnswers:false,cachedAnswersMayBypassCensus:true,queryScope:'original Navigation.free executions (cache misses or bypasses), not all free requests',timingQualificationEligible:false,repeatCountScope:'lower bound on repeated completed integer-metre positive-integer-radius keys without ignored IDs among original geometry executions; excludes owned-cache hits'}:undefined;
  if(navigationQueryCensus){
    const original=Navigation.prototype.free,known=new WeakMap<Navigation,Set<string>>();
    Navigation.prototype.free=function(point,radius,ignoredId){
      navigationQueryCensus.queries++;
      const eligible=ignoredId===undefined&&Number.isSafeInteger(radius)&&radius>0&&point.xMm%1000===0&&point.zMm%1000===0;
      let keys:Set<string>|undefined,key:string|undefined;
      if(eligible){navigationQueryCensus.eligibleGridQueries++;keys=known.get(this);if(!keys){keys=new Set();known.set(this,keys);navigationQueryCensus.instancesWithEligibleQueries++;}key=`${point.xMm}:${point.zMm}:${radius}`;}
      const answer=original.call(this,point,radius,ignoredId);
      if(keys&&key!==undefined){
        if(keys.has(key))navigationQueryCensus.repeatedCompletedQueries++;
        else{navigationQueryCensus.completedKeyInsertions++;if(keys.size>=navigationQueryCensus.capacityPerInstance){keys.delete(keys.values().next().value!);navigationQueryCensus.evictions++;}keys.add(key);}
      }
      return answer;
    };
    restores.push(()=>{Navigation.prototype.free=original;});
  }
  const navigationLineQueryCensus=process.env.LOAD_NAV_LINE_CENSUS==='1'?{
    queries:0,completedQueries:0,throws:0,eligibleCardinalQueries:0,completedEligibleQueries:0,eligibleThrows:0,repeatedCompletedQueries:0,completedKeyInsertions:0,evictions:0,instancesWithEligibleQueries:0,capacityPerInstance:8192,
    eligibleRadiusQueries:{} as Record<string,number>,measuredCallsReuseAnswers:false,cachedAnswersMayBypassCensus:true,freeCacheMayHitInside:true,timingQualificationEligible:false,
    queryScope:'original Navigation.clearLine executions (owned sweep-cache misses or bypasses), not all clearance requests; every measured sweep executes',
    repeatCountScope:'lower bound on repeated completed ordered cardinal one-metre edges among original executions, endpoints on integer metres0..640 and integer radius1..4095, without ignored IDs; excludes owned sweep-cache hits',
  }:undefined;
  if(navigationLineQueryCensus){
    const original=Navigation.prototype.clearLine,known=new WeakMap<Navigation,Set<number>>();
    const boundedMetre=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=640000&&value%1000===0;
    Navigation.prototype.clearLine=function(from,to,radius,ignoredId){
      navigationLineQueryCensus.queries++;
      const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,direction=dx===1000&&dz===0?0:dx===-1000&&dz===0?1:dx===0&&dz===1000?2:dx===0&&dz===-1000?3:-1;
      const eligible=direction>=0&&ignoredId===undefined&&Number.isInteger(radius)&&radius>0&&radius<4096&&boundedMetre(from.xMm)&&boundedMetre(from.zMm)&&boundedMetre(to.xMm)&&boundedMetre(to.zMm);
      let keys:Set<number>|undefined,key:number|undefined;
      if(eligible){
        navigationLineQueryCensus.eligibleCardinalQueries++;navigationLineQueryCensus.eligibleRadiusQueries[radius]=(navigationLineQueryCensus.eligibleRadiusQueries[radius]??0)+1;
        keys=known.get(this);if(!keys){keys=new Set();known.set(this,keys);navigationLineQueryCensus.instancesWithEligibleQueries++;}
        // Ordered directions remain distinct; reversed endpoints can charge
        // different work before the first obstruction or exhausted budget.
        key=((radius*641+from.zMm/1000)*641+from.xMm/1000)*4+direction;
      }
      try{
        const answer=original.call(this,from,to,radius,ignoredId);navigationLineQueryCensus.completedQueries++;
        if(keys&&key!==undefined){
          navigationLineQueryCensus.completedEligibleQueries++;
          if(keys.has(key))navigationLineQueryCensus.repeatedCompletedQueries++;
          else{navigationLineQueryCensus.completedKeyInsertions++;if(keys.size>=navigationLineQueryCensus.capacityPerInstance){keys.delete(keys.values().next().value!);navigationLineQueryCensus.evictions++;}keys.add(key);}
        }
        return answer;
      }catch(error){navigationLineQueryCensus.throws++;if(eligible)navigationLineQueryCensus.eligibleThrows++;throw error;}
    };
    restores.push(()=>{Navigation.prototype.clearLine=original;});
  }
  const timingQualificationEligible=loadTimingQualificationEligible(process.env);
  let path: PathWorkReport = { work: 0, pending: 0, ready: 0, blocked: 0, regionCount: 0, cacheHits: 0 }, maxPathPending = 0, pathWork = 0;
  const duty = new Map(factions.map(faction => [faction.id, createCapacityDutyMemory()])), latest = new Map<string, PreparedViewHandle>();
  const encoders=new Map(factions.map(faction=>[faction.id,createPreparedViewScope()]));
  const bytesByFaction: Record<string, { bytes: number; frames: number; sampleSeconds: number[]; currentSecondBytes: number }> = Object.fromEntries(factions.map(faction => [faction.id, { bytes: 0, frames: 0, sampleSeconds: [], currentSecondBytes: 0 }]));
  const timings: number[] = [], cycleTimings: number[] = [], replicationTimings: number[] = [], commandTimings: number[] = [], observations: Observation[] = [];
  const actions: Record<string, number> = {}, rejectedCommands: Record<string, number> = {}, carryCap = new Map<string, number>();
  const activityWindows: { fromTick: number; toTick: number; completeMinute: boolean; uniqueActiveUnits: number; committedActionTicks: Record<string, number>; factions: { id: string; uniqueActiveUnits: number; activeSurvivingUnits: number; collectedMilli: number; survivingUnits: number }[] }[] = [];
  let windowStart = 0, windowActions: Record<string, number> = {}, activeUnits = new Map<string, string>(), collectedAtWindowStart = Object.fromEntries(factions.map(faction => [faction.id, 0]));
  let lastCensusWindow:{fromTick:number;toTick:number;active:Set<string>}|undefined;
  let acceptedCommands = 0, journalBytes = 0, journalEvents = 0, launchedProjectiles = 0, lethalOccurrences = 0, consecutiveOverruns = 0, maxConsecutiveOverruns = 0, maxLatenessMs = 0, earlyTermination: string | undefined;
  const expectedUnits = Object.values(simulation.state.entities).filter(entity => entity.kind === 'unit').length;
  const started = performance.now(), cpuStarted = process.cpuUsage(), initialMemory = process.memoryUsage(); let lastProgress = started;
  const tickMs = 1000 / balance.rules.simulationHz;let nextDutyTick=simulation.state.tick;
  const inspect = (): Observation => {
    const entities = Object.values(simulation.state.entities), alive = entities.filter(entity => entity.kind === 'unit' && entity.hp > 0), memory = process.memoryUsage();
    for (const entity of entities) {
      if (entity.kind === 'resource' && (!Number.isSafeInteger(entity.amount) || entity.amount < 0)) throw new Error('LOAD_RESOURCE_NODE_INVARIANT');
      if (entity.kind === 'unit') {
        const economy = simulation.state.economies[entity.ownerId]!, key = `${entity.ownerId}:${entity.typeId}:${economy.researchRevision}`;
        if (!carryCap.has(key)) carryCap.set(key, effectiveUnit(entity.typeId, economy.technologies).carryCapacity ?? balance.rules.carryCapacity);
        if (!Number.isSafeInteger(entity.cargo.amount) || entity.cargo.amount < 0 || entity.cargo.amount > carryCap.get(key)! * balance.rules.resourceScale || entity.orders.length > balance.rules.orderQueueLimit) throw new Error('LOAD_UNIT_INVARIANT');
      }
      if (entity.kind === 'building' && (entity.queue.length > 6 || entity.typeId === 'farm' && (!Number.isSafeInteger(entity.foodRemaining) || entity.foodRemaining! < 0))) throw new Error('LOAD_BUILDING_INVARIANT');
    }
    return { tick: simulation.state.tick, elapsedMs: performance.now() - started, units: alive.length, population: alive.reduce((sum, entity) => sum + (entity.kind === 'unit' ? units[entity.typeId].population : 0), 0), resources: entities.filter(entity => entity.kind === 'resource').length, activeResources: entities.filter(entity => entity.kind === 'resource' && entity.amount > 0).length,
      nonWallStructures: entities.filter(entity => entity.kind === 'building' && !buildings[entity.typeId].wallEquivalentCells).length, wallEquivalentCells: entities.reduce((sum, entity) => sum + (entity.kind === 'building' ? buildings[entity.typeId].wallEquivalentCells ?? 0 : 0), 0), garrisoned: alive.filter(entity => entity.kind === 'unit' && entity.garrisonedIn).length,
      moving: alive.filter(entity => entity.kind === 'unit' && entity.taskState === 'moving').length, gathering: alive.filter(entity => entity.kind === 'unit' && entity.taskState === 'gathering').length, repairing: alive.filter(entity => entity.kind === 'unit' && entity.taskState === 'repairing').length, blocked: alive.filter(entity => entity.kind === 'unit' && entity.taskState === 'blocked').length,
      queuedJobs: entities.reduce((sum, entity) => sum + (entity.kind === 'building' ? entity.queue.length : 0), 0), projectiles: simulation.state.projectiles.length, journalBytes, rssMiB: memory.rss / 1048576, heapUsedMiB: memory.heapUsed / 1048576, externalMiB: memory.external / 1048576, path: { ...path },
      factions: factions.map(faction => { const own = alive.filter(entity => entity.ownerId === faction.id), economy = simulation.state.economies[faction.id]!; return { id: faction.id, units: own.length, population: own.reduce((sum, entity) => sum + (entity.kind === 'unit' ? units[entity.typeId].population : 0), 0), lost: economy.statistics.unitsLost, collected: Object.values(economy.collected).reduce((sum, amount) => sum + amount, 0), spent: Object.values(economy.spent).reduce((sum, amount) => sum + amount, 0), defeated: economy.defeated }; }) };
  };
  console.log(JSON.stringify({ event: 'load_started', profile, seed, factionCount, aiCount, ticks, realtime, authoritativeIntervalMs,timingContract,setupMs, expectedUnits, provenance: fixture?.provenance, policy: autonomous ? 'ordinary AI policies enabled; drill maintains humans only' : 'recipient-filtered scripted duty for every faction', qualification: 'headless synchronous diagnostic; real worker/model/network/production overload/render qualification separate' }));
  observations.push(inspect());
  try {
    for (let index = 0; index < ticks; index+=frameTicks) {
      if (simulation.state.status !== 'RUNNING') { earlyTermination = `MATCH_${simulation.state.status}_BEFORE_TARGET`; break; }
      if (performance.now() - started >= maximumWallMinutes * 60000) { earlyTermination = 'LOAD_WALL_TIME_LIMIT'; break; }
      if (realtime) { const wait = started + index * tickMs - performance.now(); if (wait > 0) await delay(wait); }
      maxLatenessMs = Math.max(maxLatenessMs, performance.now() - (started + index * tickMs));
      const cycleStart = performance.now();
      if (fixture && simulation.state.tick>=nextDutyTick) {nextDutyTick=(Math.floor(simulation.state.tick/balance.rules.simulationHz)+1)*balance.rules.simulationHz;for (const faction of factions) {
        if (autonomous && faction.kind === 'ai') continue;
        const view = simulation.view(faction.id), proposals = capacityDutyCommands(view, fixture.drills[faction.id]!, duty.get(faction.id)!);
        for (const command of proposals) {
          const commandStart = performance.now(), sequence = simulation.state.economies[faction.id]!.lastClientSequence + 1;
          const receipt = simulation.command(faction.id, { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: `load_${sequence}`, clientSequence: sequence, command }); commandTimings.push(performance.now() - commandStart);
          if (receipt.status === 'accepted'){acceptedCommands++;activityCensus?.accepted(command,simulation.state.tick);} else rejectedCommands[receipt.code ?? 'REJECTED'] = (rejectedCommands[receipt.code ?? 'REJECTED'] ?? 0) + 1;
        }
      }
      }
      const tickStart = performance.now(), previousTick = simulation.state.tick; simulation.advanceFrame(); const tickTime = performance.now() - tickStart;
      if (simulation.state.tick !== previousTick + frameTicks) { earlyTermination = 'SIMULATION_FRAME_DID_NOT_ADVANCE'; break; } timings.push(tickTime);
      path = simulation.pathDiagnostics(); maxPathPending = Math.max(maxPathPending, path.pending); pathWork += path.work;
      for (const [id, action] of internals.committedActions) {
        actions[action.kind] = (actions[action.kind] ?? 0) + 1; windowActions[action.kind] = (windowActions[action.kind] ?? 0) + 1;
        const entity = simulation.state.entities[id]; if (entity?.kind === 'unit') activeUnits.set(id, entity.ownerId);
      }
      launchedProjectiles += simulation.state.projectiles.filter(projectile => projectile.launchTick >previousTick&&projectile.launchTick<=simulation.state.tick).length; lethalOccurrences += simulation.state.effects.filter(effect => effect.tick>previousTick&&effect.tick<=simulation.state.tick&&effect.kind === 'death').length;
      for (const economy of Object.values(simulation.state.economies)) for (const amount of Object.values(economy.resources)) if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('LOAD_RESOURCE_BANK_INVARIANT');
      if (replicationHz && Math.floor(simulation.state.tick/(balance.rules.simulationHz/replicationHz))>Math.floor(previousTick/(balance.rules.simulationHz/replicationHz))) {
        const replicationStart = performance.now();
        if (replicationCensus) {
          for (const [index,view] of replicationCensus.views(() => simulation.views(factions.map(faction=>faction.id))).entries()) {
            const faction=factions[index]!, {prepared,size}=replicationCensus.encode(view,encoders.get(faction.id)!,()=>latest.get(faction.id));
            latest.set(faction.id, prepared); const metric = bytesByFaction[faction.id]!; metric.bytes += size; metric.currentSecondBytes += size; metric.frames++;
          }
        } else {
          // Keep the default publication path free of additional phase timers.
          for (const [index,view] of simulation.views(factions.map(faction=>faction.id)).entries()) {
            const faction=factions[index]!, encoder=encoders.get(faction.id)!,prepared=encoder.prepareJson(JSON.stringify(view)),before = latest.get(faction.id), encoded = before ? encoder.encodeDeltaMessage(before, prepared) : JSON.stringify({ type: 'snapshot', view }), size = Buffer.byteLength(encoded);
            latest.set(faction.id, prepared); const metric = bytesByFaction[faction.id]!; metric.bytes += size; metric.currentSecondBytes += size; metric.frames++;
          }
        }
        replicationTimings.push(performance.now() - replicationStart);
      }
      const cycleMs = performance.now() - cycleStart; cycleTimings.push(cycleMs); consecutiveOverruns = cycleMs > authoritativeIntervalMs ? consecutiveOverruns + 1 : 0; maxConsecutiveOverruns = Math.max(maxConsecutiveOverruns, consecutiveOverruns);
      if (Math.floor(simulation.state.tick/balance.rules.simulationHz)>Math.floor(previousTick/balance.rules.simulationHz) || index+frameTicks>=ticks) {
        const batch = simulation.drainJournal(); if (batch.gapBeforeOrdinal !== undefined) throw new Error('LOAD_JOURNAL_GAP'); journalEvents += batch.events.length; journalBytes += Buffer.byteLength(JSON.stringify(batch));
        observations.push(inspect()); for (const metric of Object.values(bytesByFaction)) { metric.sampleSeconds.push(metric.currentSecondBytes); metric.currentSecondBytes = 0; }
        if (simulation.state.tick - windowStart >= 60 * balance.rules.simulationHz || index+frameTicks>=ticks) {
          const sample = observations.at(-1)!;
          activityWindows.push({ fromTick: windowStart, toTick: simulation.state.tick, completeMinute: simulation.state.tick - windowStart === 60 * balance.rules.simulationHz, uniqueActiveUnits: activeUnits.size, committedActionTicks: windowActions, factions: sample.factions.map(faction => ({ id: faction.id, uniqueActiveUnits: [...activeUnits.values()].filter(owner => owner === faction.id).length, activeSurvivingUnits: [...activeUnits].filter(([id, owner]) => owner === faction.id && (simulation.state.entities[id]?.hp ?? 0) > 0).length, collectedMilli: faction.collected - collectedAtWindowStart[faction.id]!, survivingUnits: faction.units })) });
          if(activityCensus)lastCensusWindow={fromTick:windowStart,toTick:simulation.state.tick,active:new Set(activeUnits.keys())};
          windowStart = simulation.state.tick; windowActions = {}; activeUnits = new Map(); collectedAtWindowStart = Object.fromEntries(sample.factions.map(faction => [faction.id, faction.collected]));
        }
      }
      if (performance.now() - lastProgress >= 5000 || (index + 1) % 1000 === 0) { lastProgress = performance.now(); const current = observations.at(-1)!; console.log(JSON.stringify({ event: 'load_progress', tick: simulation.state.tick, elapsedMs: Math.round(lastProgress - started), lastTickMs: tickTime, units: current.units, moving: current.moving, gathering: current.gathering, blocked: current.blocked, rssMiB: current.rssMiB, path })); }
    }
  } catch (error) { earlyTermination = error instanceof Error ? error.message : 'LOAD_FAILURE'; }
  finally { for (const restore of restores.reverse()) restore(); }
  if (simulation.state.status !== 'RUNNING' && simulation.state.tick < ticks) earlyTermination ??= `MATCH_${simulation.state.status}_BEFORE_TARGET`;
  let finalInspectionFailure: string | undefined;
  if (observations.at(-1)!.tick !== simulation.state.tick) {
    try { observations.push(inspect()); } catch (error) { finalInspectionFailure = error instanceof Error ? error.message : 'LOAD_FINAL_INSPECTION_FAILURE'; earlyTermination ??= finalInspectionFailure; }
  }
  if (realtime && !earlyTermination && simulation.state.tick === ticks) { const remaining = started + ticks * tickMs - performance.now(); if (remaining > 0) await delay(remaining); }
  const elapsedMs = performance.now() - started, cpu = process.cpuUsage(cpuStarted), tickDistribution = distribution(timings);
  await simulation.synchronizeCapture();
  // Export scheduler state once, after timing finishes. These host-only details
  // explain inactivity; queued orders still never count as committed activity.
  const activityPathDiagnostic=activityCensus&&fixture?(()=>{
    const window=windowStart<simulation.state.tick?{fromTick:windowStart,toTick:simulation.state.tick,active:new Set(activeUnits.keys())}:lastCensusWindow??{fromTick:0,toTick:simulation.state.tick,active:new Set<string>()};
    const schedulerState=(internals.pathScheduler as PathScheduler).exportState(),tasks=new Map(schedulerState.tasks.map(task=>[task.unitId,task])),duties=new Map<string,{role:string;group?:number}>();
    for(const drill of Object.values(fixture.drills)){
      for(const assignment of drill.farms)duties.set(assignment.workerId,{role:'farmer'});
      for(const assignment of drill.resourceWorkers)duties.set(assignment.workerId,{role:`resource_${assignment.resource}`});
      for(const id of drill.repairers)duties.set(id,{role:'repairer'});for(const id of drill.combatArchers)duties.set(id,{role:'combat_archer'});
      for(const [group,ids]of drill.armyGroups.entries())for(const id of ids)duties.set(id,{role:'marcher',group});
    }
    const inactive=Object.values(simulation.state.entities).filter(entity=>entity.kind==='unit'&&entity.hp>0&&!window.active.has(entity.id)),maximumInactiveDetails=2200;
    const details=inactive.slice(0,maximumInactiveDetails).map(entity=>{if(entity.kind!=='unit')throw Error('ACTIVITY_CENSUS_UNIT');const task=tasks.get(entity.id),coverage=activityCensus.read(entity.id);return {
      id:entity.id,playerId:entity.ownerId,typeId:entity.typeId,duty:duties.get(entity.id)??{role:'not_in_opening_drill'},position:{xMm:entity.xMm,zMm:entity.zMm},order:entity.orders[0]?.kind??'idle',orderRevision:entity.orderRevision,taskState:entity.taskState,blockedReason:entity.blockedReason,garrisonedIn:entity.garrisonedIn,pathLength:entity.path.length,pathRequestId:entity.pathRequestId,pathDestination:entity.pathDestination,coverage:coverage??null,
      scheduler:task?{stage:task.stage,requestId:task.id,orderRevision:task.orderRevision,from:task.from,target:task.target,lineStep:task.lineStep,lineSteps:task.lineSteps,startConnectors:task.starts?.length,endConnectors:task.ends?.length,startComponents:task.startComponents,endComponents:task.endComponents,cacheKey:task.cacheKey,lateCacheChecked:task.lateCacheChecked,endJoinChecked:task.endJoinChecked??false,coarseQueued:task.coarse?.heap.length,coarseVisited:task.coarse?Object.keys(task.coarse.closed).length:undefined,coarseDiscovered:task.coarse?Object.keys(task.coarse.scores).length:undefined,coarseCurrentComponent:task.currentComponent,coarseEdgeCursor:task.edgeCursor,corridorRegions:task.corridor?.length,fineQueued:task.fine?.heap.length,fineVisited:task.fine?Object.keys(task.fine.closed).length:undefined,fineDiscovered:task.fine?Object.keys(task.fine.scores).length:undefined,fineNeighborCursor:task.neighborCursor,result:task.result?.status}:null,
    };});
    // Additive final host-only evidence: firstPoints is a bounded route prefix,
    // while first/last/pointCount retain their existing complete-route meanings.
    // Older reports omit this prefix and endJoinChecked; absence is unknown there.
    const maximumRouteCacheDetails=512*factionCount,maximumRouteCachePoints=8,routeCache=schedulerState.routes.slice(0,maximumRouteCacheDetails).map(([key,route])=>({key,profile:route.profile,radiusMm:route.radiusMm,first:route.points[0],last:route.points.at(-1),pointCount:route.points.length,firstPoints:route.points.slice(0,maximumRouteCachePoints)}));
    return {hostOnly:true,timingQualificationEligible:false,coverageScope:'accepted scripted-duty unit commands over the whole run; excludes autonomous AI commands',restartScope:'request calls made inside this scheduler invalidate method; exact observed restarts',activityWindow:{fromTick:window.fromTick,toTick:window.toTick,completeMinute:window.toTick-window.fromTick===60*balance.rules.simulationHz},counterCapacity:activityCensus.capacity,totals:activityCensus.totals,counterEvictionsMayLoseEarlierUnitHistory:activityCensus.totals.evictions>0,maximumInactiveDetails,inactiveSurvivingUnits:inactive.length,omittedInactiveDetails:Math.max(0,inactive.length-details.length),finalSchedulerTasks:tasks.size,maximumRouteCacheDetails,maximumRouteCachePoints,omittedRouteCacheDetails:Math.max(0,schedulerState.routes.length-routeCache.length),routeCache,inactive:details};
  })():undefined;
  const fullMinutes = activityWindows.filter(window => window.completeMinute), hasEveryMinute = (predicate: (window: typeof activityWindows[number]) => boolean) => fullMinutes.length > 0 && fullMinutes.every(predicate);
  const activityEvidence = { completeMinuteWindows: fullMinutes.length, eachMinuteMovement: hasEveryMinute(window => (window.committedActionTicks.move ?? 0) > 0), eachMinuteGathering: hasEveryMinute(window => ['gather_food', 'gather_wood', 'mine'].some(kind => (window.committedActionTicks[kind] ?? 0) > 0)), eachMinuteRepair: hasEveryMinute(window => (window.committedActionTicks.repair ?? 0) > 0), eachMinuteCombat: hasEveryMinute(window => (window.committedActionTicks.attack ?? 0) > 0), eachFactionCollectsEveryMinute: hasEveryMinute(window => window.factions.every(faction => faction.collectedMilli > 0)), everySurvivingUnitActiveEachMinute: hasEveryMinute(window => window.factions.every(faction => faction.activeSurvivingUnits === faction.survivingUnits)) };
  const cycleDistribution=distribution(cycleTimings),timingWithinTargets = timings.length > 0 && !earlyTermination && cycleDistribution.p95 <= timingContract.p95Ms && cycleDistribution.p99 <= timingContract.p99Ms, timingPass=timingQualificationEligible&&timingWithinTargets, memoryPass = observations.every(sample => sample.rssMiB <= 4096);
  const densityPass=observations.every(sample=>sample.units>=expectedUnits),activityRequired=capacity&&ticks>=60*balance.rules.simulationHz,activityPass=capacityActivityPassed(activityEvidence);
  const measuredFailures = [...(earlyTermination ? [earlyTermination] : []), ...(!timingWithinTargets ? ['TICK_TIMING_TARGET_NOT_MET'] : []), ...(!timingQualificationEligible?['INSTRUMENTED_TIMINGS_NOT_QUALIFIABLE']:[]), ...(!memoryPass ? ['PROCESS_MEMORY_TARGET_NOT_MET'] : []), ...(capacity&&!densityPass?['CAPACITY_DENSITY_TARGET_NOT_MET']:[]), ...(activityRequired&&!activityPass?['CAPACITY_ACTIVITY_TARGET_NOT_MET']:[])];
  const result = { profile,forest, execution, authoritativeIntervalMs,timingContract,seed, contentHash, engineBuildHash: engineIdentity.engineBuildHash, runtime: engineIdentity.runtimeProfile,
    hardware: { os: `${os.platform()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, totalMemoryGiB: os.totalmem() / 1073741824, freeMemoryGiBAtSetup, freeMemoryGiBAtEnd: os.freemem() / 1073741824 },
    setupMs, factionCount, aiCount, aiPolicies: factions.filter(faction => faction.kind === 'ai').map(({id,difficulty,personality}) => ({playerId:id,difficulty,personality})), populationLimit, expectedUnits, mapType, replicationHz, maximumWallMinutes, ticksRequested: ticks, ticksAdvanced: simulation.state.tick, realtime, wallTimeMs: elapsedMs, simulatedSeconds: simulation.state.tick / balance.rules.simulationHz, observedHz: simulation.state.tick / (elapsedMs / 1000), observedFrameHz: timings.length / (elapsedMs / 1000), planningExecution: authoritativeIntervalMs===300?'synchronous frozen-service diagnostic; use network-load for native worker timing':'synchronous legacy planner', cpuTimeMs: (cpu.user + cpu.system) / 1000,
    status: simulation.state.status, result: simulation.state.result, earlyTermination, finalInspectionFailure, completedRequestedRun: !earlyTermination && simulation.state.tick === ticks,
    provenance: fixture?.provenance, scope: { actualModel: false, actualNetwork: false, productionOverloadPausePolicy: false, browserRendering: false, serializedDeltaEstimates: true, memoryIncludesProfilerBuffers: true, fixtureOpeningReserves: capacity, runtimeGrantsOrRespawns: false, aiPoliciesEnabled: autonomous,stageProfilingEnabled,timingQualificationEligible },
    tickMs: tickDistribution, cycleMs: cycleDistribution, replicationBatchMs: distribution(replicationTimings), commandAdmissionMs: distribution(commandTimings), maxConsecutiveOverruns, maxLatenessMs: realtime ? maxLatenessMs : undefined,navigationQueryCensus,navigationLineQueryCensus,replicationPhaseCensus:replicationCensus?.report,
    density: densitySummary(observations.map(sample => sample.units), expectedUnits), factions: factions.map(faction => ({ id: faction.id, units: distribution(observations.map(sample => sample.factions.find(item => item.id === faction.id)!.units)), population: distribution(observations.map(sample => sample.factions.find(item => item.id === faction.id)!.population)) })),
    activity: { committedUnitActionTicks: actions, launchedProjectiles, lethalOccurrences, evidence: activityEvidence, minuteWindows: activityWindows, moving: distribution(observations.map(sample => sample.moving)), gathering: distribution(observations.map(sample => sample.gathering)), repairing: distribution(observations.map(sample => sample.repairing)), blocked: distribution(observations.map(sample => sample.blocked)) },activityPathDiagnostic,
    path: { maximumPending: maxPathPending, deterministicWork: pathWork, final: path }, journal: { events: journalEvents, serializedBytesDrained: journalBytes, persistedToDisk: false }, acceptedCommands, rejectedCommands,
    memory: { initialRssMiB: initialMemory.rss / 1048576, rssMiB: distribution(observations.map(sample => sample.rssMiB)), heapUsedMiB: distribution(observations.map(sample => sample.heapUsedMiB)), externalMiB: distribution(observations.map(sample => sample.externalMiB)), steadyStateTrend: memoryTrend(observations), firstTenMinuteMeanRssMiB: distribution(observations.filter(sample => sample.elapsedMs < 600000).map(sample => sample.rssMiB)).mean, lastTenMinuteMeanRssMiB: distribution(observations.filter(sample => sample.elapsedMs > elapsedMs - 600000).map(sample => sample.rssMiB)).mean },
    serializedBytesByViewpoint: Object.fromEntries(Object.entries(bytesByFaction).map(([id, metric]) => [id, { bytes: metric.bytes, frames: metric.frames, simulatedSecondBytes: distribution(metric.sampleSeconds), note: 'JSON snapshot/delta estimate; excludes chunking, compression and actual wire overhead' }])),
    thresholds: { tickTimingMeasuredPass: timingPass,timingQualificationEligible,diagnosticTickTimingWithinTargets:timingWithinTargets, peakRssWithin4GiB: memoryPass, allDensitySamplesAtNominal: densityPass,capacityActivityRequired:activityRequired,capacityActivityMeasuredPass:capacity?activityPass:null, completedSixtyMinutesOfAdvancingSimulation: simulation.state.tick >= 72000 && elapsedMs >= 3600000 && !earlyTermination, fullAcceptancePass: false }, measuredFailures, stages, samples: observations };
  const outputDirectory = resolve('runtime-data/load'); await mkdir(outputDirectory, { recursive: true }); const output = resolve(outputDirectory, `${profile}-${Date.now()}.json`); await writeFile(output, JSON.stringify(result, null, 2));
  const { samples: _samples, ...summary } = result; console.log(JSON.stringify({ event: 'load_finished', output, ...summary }, null, 2));
  if (measuredFailures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runLoad();
