import { describe, expect, it } from 'vitest';
import { balance, units, effectiveBuilding, contentHash, createPreparedViewScope, type GameplayCommand, type PlayerView, type PublicPlayer, type PreparedViewHandle } from '@frontier/shared';
import { createSimulation, restoreSimulation, type EngineIdentity } from '@frontier/simulation';
import { Navigation } from '../packages/simulation/src/navigation.js';
import { PathScheduler, type PathRequest } from '../packages/simulation/src/path-scheduler.js';
import { capacityComposition, capacityDutyCommands, capacityTimingContract, capacityTimingMetrics, createCapacityDutyMemory, createCapacityFixture, validateCapacityGeometry, type CapacityDrill } from '../scripts/load-fixture.js';
import { capacityActivityPassed, createCapacityActivityCensus, observeCapacityPathRequests, createReplicationPhaseCensus, densitySummary, distribution, installLoadStageProfile, loadTimingQualificationEligible, memoryTrend } from '../scripts/load.js';

const identity: EngineIdentity = { engineBuildHash: '8'.repeat(64), runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch } };
const factions: PublicPlayer[] = ['blue', 'red'].map(id => ({ id, name: id, teamId: id, kind: 'human', color: '#123456' }));

it('separates300ms capacity frame budgets from the unchanged20Hz integer game clock',()=>{
  expect(capacityTimingContract(300)).toMatchObject({authoritativeIntervalMs:300,frameTicks:6,gameTicksPerSecond:20,p95Ms:240,p99Ms:300,publicationIntervalMs:300,pathWorkPerFrame:24000});
  expect(capacityTimingContract(300).frameHz).toBeCloseTo(10/3);
  expect(capacityTimingContract(50)).toMatchObject({frameTicks:1,frameHz:20,gameTicksPerSecond:20,p95Ms:35,p99Ms:50,pathWorkPerFrame:4000});
});
it('requires complete coordinator-cycle evidence for300ms qualification instead of cheaper advancing callbacks',()=>{
  const simulation={tickMs:{p50:100,p95:150,p99:200,max:200},callbackMs:{p50:120,p95:200,p99:220,max:220},cycleMs:{p50:200,p95:260,p99:310,max:310},cycleSamples:10};
  expect(capacityTimingMetrics(simulation,300)).toBe(simulation.cycleMs);expect(capacityTimingMetrics(simulation,300)!.p95).toBeGreaterThan(capacityTimingContract(300).p95Ms);
  expect(capacityTimingMetrics(simulation,50)).toBe(simulation.tickMs);
  expect(capacityTimingMetrics({...simulation,cycleSamples:0},300)).toBeUndefined();
  expect(capacityTimingMetrics({tickMs:simulation.tickMs},300)).toBeUndefined();
});

it('explicitly creates300ms capacity saves without changing legacy fixture defaults',()=>{
  const fixture=createCapacityFixture({factions,identity,populationLimit:120,seed:'capacity-frame300',authoritativeIntervalMs:300});
  expect(fixture.save.payload.options.authoritativeIntervalMs).toBe(300);
  const restored=restoreSimulation(fixture.save,identity,{preserveEpoch:true});expect(restored.options.authoritativeIntervalMs).toBe(300);expect(restored.capture()).toEqual(fixture.save.payload);
});

describe('optional load stage profiling', () => {
  const names = ['advanceControllers', 'advanceProduction', 'advanceWork', 'advanceMovement', 'updateVision', 'resolveDeaths', 'observeActions', 'evaluateVictory'];
  const stub = (): Record<string, unknown> => Object.create(Object.fromEntries(names.map(name => [name, () => undefined]))) as Record<string, unknown>;

  it('leaves disabled stage methods and navigation descriptors untouched', () => {
    const target = stub(), descriptors = Object.getOwnPropertyDescriptors(target), methods = names.map(name => target[name]), navigation = Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny');
    const profile = installLoadStageProfile(target, false);
    expect(profile.stages).toEqual({}); expect(names.map(name => target[name])).toEqual(methods);
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors); expect(Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny')).toEqual(navigation);
    profile.restore(); profile.restore();
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors); expect(Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny')).toEqual(navigation);
    // Disabled mode does not even inspect missing methods.
    expect(installLoadStageProfile({}, false).stages).toEqual({});
  });

  it('preserves stage receivers, arguments, return identity and thrown errors, then restores exact descriptors', () => {
    const target = stub(), receiver = { fixture: true }, result = {}, argument = {}, failure = new Error('same failure');
    let receivedThis: unknown, receivedArguments: unknown[] = [];
    Object.defineProperty(target, 'advanceWork', { configurable: true, enumerable: false, writable: false, value: function(this: unknown, ...args: unknown[]) { receivedThis = this; receivedArguments = args; if (args[0] === failure) throw failure; return result; } });
    const descriptors = Object.getOwnPropertyDescriptors(target), navigation = Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny'), profile = installLoadStageProfile(target, true);
    try {
      const wrapped = target.advanceWork as (...args: unknown[]) => unknown;
      expect(wrapped.call(receiver, argument, 7)).toBe(result); expect(receivedThis).toBe(receiver); expect(receivedArguments).toEqual([argument, 7]); expect(receivedArguments[0]).toBe(argument);
      let caught: unknown; try { wrapped.call(receiver, failure); } catch (error) { caught = error; }
      expect(caught).toBe(failure); expect(profile.stages.advanceWork!.calls).toBe(2);
      expect(Object.keys(profile.stages)).toEqual([...names, 'navigation.pathToAny']);
      expect(profile.stages.advanceWork!.totalMs).toBeGreaterThanOrEqual(profile.stages.advanceWork!.maxMs);
    } finally { profile.restore(); }
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors); expect(Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny')).toEqual(navigation);
    profile.restore(); expect(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors);
  });

  it('rolls back already installed stage hooks if a later method cannot be wrapped', () => {
    const target = stub(); Object.defineProperty(target, 'advanceMovement', { value: undefined, configurable: true });
    const descriptors = Object.getOwnPropertyDescriptors(target), navigation = Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny');
    expect(() => installLoadStageProfile(target, true)).toThrow('UNKNOWN_PROFILE_STAGE:advanceMovement');
    expect(Object.getOwnPropertyDescriptors(target)).toEqual(descriptors); expect(Object.getOwnPropertyDescriptor(Navigation.prototype, 'pathToAny')).toEqual(navigation);
  });

  it('excludes every enabled diagnostic flag and combination from timing qualification', () => {
    const flags = ['LOAD_STAGE_PROFILE', 'LOAD_NAV_CENSUS', 'LOAD_NAV_LINE_CENSUS', 'LOAD_ACTIVITY_CENSUS', 'LOAD_REPLICATION_CENSUS'];
    expect(loadTimingQualificationEligible({})).toBe(true);
    for (let mask = 0; mask < 32; mask++) expect(loadTimingQualificationEligible(Object.fromEntries(flags.map((flag, index) => [flag, mask & (1 << index) ? '1' : '0'])))).toBe(mask === 0);
    for (const disabled of ['', '0', 'true', undefined]) expect(loadTimingQualificationEligible(Object.fromEntries(flags.map(flag => [flag, disabled])))).toBe(true);
  });

  it('preserves actual navigation results and exact deterministic work at success and exhaustion boundaries', () => {
    const exercise = (enabled: boolean) => {
      const profile = installLoadStageProfile(stub(), enabled), outcomes: unknown[] = [];
      try {
        for (const remaining of [0, 5, 5000]) {
          const budget = { remaining, used: 0 }, nav = new Navigation(20000, 20000, [{ id: 'wall', xMm: 10000, zMm: 10000, halfWidth: 1000, halfHeight: 2000 }], 2000, 1000, budget);
          try { outcomes.push({ answer: nav.pathToAny({ xMm: 5000, zMm: 10000 }, [{ xMm: 15000, zMm: 10000 }], 350), budget }); }
          catch (error) { outcomes.push({ error: (error as Error).message, budget }); }
        }
        return { outcomes, calls: profile.stages['navigation.pathToAny']?.calls };
      } finally { profile.restore(); }
    };
    const reference = exercise(false), observed = exercise(true);
    expect(observed.outcomes).toEqual(reference.outcomes); expect(observed.calls).toBe(3); expect(reference.calls).toBeUndefined();
    expect(observed.outcomes[0]).toMatchObject({ error: 'PATH_BUSY', budget: { remaining: 0, used: 0 } });
    expect(observed.outcomes[1]).toMatchObject({ error: 'PATH_BUSY', budget: { remaining: 0, used: 5 } });
    expect(observed.outcomes[2]).toMatchObject({ answer: expect.any(Array) });
  });

  it('preserves paid commands, ordinary movement, captures and filtered snapshot/delta bytes in a bounded paired simulation', () => {
    const exercise = (enabled: boolean) => {
      const simulation = createSimulation({ factions, controllers: false, seed: 'stage-profile-equivalence', matchId: 'stage-profile-equivalence' });
      const profile = installLoadStageProfile(simulation as unknown as Record<string, unknown>, enabled), encoders = factions.map(() => createPreparedViewScope()), bases: (PreparedViewHandle | undefined)[] = [], encoded: { text: string; bytes: number }[] = [], actions: unknown[] = [], paths: unknown[] = [];
      try {
        const view = simulation.view('blue'), worker = view.entities.find(entity => entity.ownerId === 'blue' && entity.typeId === 'villager')!, town = view.entities.find(entity => entity.ownerId === 'blue' && entity.typeId === 'town_center')!;
        const node = view.entities.filter(entity => entity.kind === 'resource' && !entity.ghost && (entity.amount ?? 0) > 0).sort((a, b) => Math.hypot(a.xMm - worker.xMm, a.zMm - worker.zMm) - Math.hypot(b.xMm - worker.xMm, b.zMm - worker.zMm) || a.id.localeCompare(b.id))[0]!;
        const commands: GameplayCommand[] = [{ kind: 'train', buildingId: town.id, unitType: 'villager', quantity: 1 }, { kind: 'gather', unitIds: [worker.id], targetId: node.id, queued: false }];
        const receipts = commands.map((command, index) => simulation.command('blue', { protocolVersion: 2, matchId: simulation.state.matchId, matchEpoch: simulation.state.matchEpoch, clientCommandId: `stage_${index}`, clientSequence: index + 1, command }));
        expect(receipts.every(receipt => receipt.status === 'accepted')).toBe(true);
        for (let tick = 1; tick <= 24; tick++) {
          simulation.step(); actions.push(simulation.committedUnitActions()); paths.push(simulation.pathDiagnostics());
          if (tick % 2 === 0) for (const [index, next] of simulation.views(factions.map(faction => faction.id)).entries()) {
            const encoder = encoders[index]!, prepared = encoder.prepareJson(JSON.stringify(next)), before = bases[index];
            const text = before ? encoder.encodeDeltaMessage(before, prepared) : JSON.stringify({ type: 'snapshot', view: next });
            encoded.push({ text, bytes: Buffer.byteLength(text) }); bases[index] = prepared;
          }
        }
        expect(simulation.state.economies.blue!.spent.food).toBeGreaterThan(0);
        expect(actions.flat()).toContainEqual(expect.objectContaining({ id: worker.id, kind: 'move' }));
        expect(encoded).toHaveLength(24);
        return { result: { receipts, actions, paths, encoded, capture: simulation.capture() }, stages: profile.stages };
      } finally { profile.restore(); }
    };
    const reference = exercise(false), observed = exercise(true);
    expect(observed.result).toEqual(reference.result); expect(reference.stages).toEqual({});
    for (const name of names) if (name === 'advanceControllers') expect(observed.stages[name]!.calls).toBe(0); else expect(observed.stages[name]!.calls).toBeGreaterThanOrEqual(24);
  });
});

function replicationView(index: number, sequence: number): PlayerView {
  return { protocolVersion: 2, contentHash, matchId: 'census', matchEpoch: 1, tick: sequence * 2, sequence, playerId: `p${index}`, status: 'RUNNING', map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 }, players: [],
    self: { lastCommandSequence: 0, resources: { food: 50 + index, wood: 0, gold: 0, stone: 0 }, age: 1, population: 1, populationCap: 15, populationLimit: 120, reservedPopulation: 0 },
    entities: [{ id: `private_unit_${index}`, ownerId: `p${index}`, kind: 'unit', typeId: 'villager', xMm: 4000 + sequence, zMm: 4000, hp: 35, maxHp: 35, cargo: { resource: 'wood', amount: sequence } },
      ...(sequence === 1 ? [{ id: 'visible_enemy', ownerId: 'enemy', kind: 'unit' as const, typeId: 'militia', xMm: 5000, zMm: 4000, hp: 55, maxHp: 55 }] : [])],
    fog: sequence === 1 ? { visible: [2, 1], explored: [2, 0, 1] } : { visible: [3, 2], explored: [3, 2, 0, 1] } };
}

it('measures replication phases while preserving all eleven snapshots, subsequent deltas and exact UTF-8 byte counts', () => {
  const census = createReplicationPhaseCensus(), observed = Array.from({ length: 11 }, () => createPreparedViewScope()), reference = Array.from({ length: 11 }, () => createPreparedViewScope());
  const observedBase = new Map<number, PreparedViewHandle>(), referenceBase = new Map<number, PreparedViewHandle>();
  for (const sequence of [1, 2]) {
    const views = Array.from({ length: 11 }, (_, index) => replicationView(index, sequence));
    views[0]!.players = [{ id: 'p0', name: '\u754c\ud83c\udf32', teamId: 't0', color: '#123456', kind: 'human' }];
    const original = structuredClone(views);
    expect(census.views(() => views)).toBe(views);
    for (const [index, view] of views.entries()) {
      const encoder = reference[index]!, prepared = encoder.prepareJson(JSON.stringify(view)), before = referenceBase.get(index);
      const encoded = before ? encoder.encodeDeltaMessage(before, prepared) : JSON.stringify({ type: 'snapshot', view }), size = Buffer.byteLength(encoded);
      const actual = census.encode(view, observed[index]!, () => observedBase.get(index));
      expect(actual.encoded).toBe(encoded); expect(actual.size).toBe(size);
      expect(observed[index]!.boundary(actual.prepared)).toEqual(encoder.boundary(prepared));
      if (index === 0) expect(size).toBeGreaterThan(encoded.length);
      for (let other = 0; other < 11; other++) if (other !== index) expect(actual.encoded).not.toContain(`private_unit_${other}\"`);
      if (sequence === 2) expect(JSON.parse(actual.encoded).delta.conceals).toEqual(['visible_enemy']);
      observedBase.set(index, actual.prepared); referenceBase.set(index, prepared);
    }
    expect(views).toEqual(original);
  }
  expect(census.report).toMatchObject({ hostOnly: true, timingQualificationEligible: false });
  expect(Object.fromEntries(Object.entries(census.report.phases).map(([phase, metric]) => [phase, metric.calls]))).toEqual({ views: 2, stringify: 22, prepareJson: 22, deltaEncoding: 11, snapshotEncoding: 11, byteCount: 22 });
  for (const metric of Object.values(census.report.phases)) { expect(Object.keys(metric)).toEqual(['calls', 'totalMs', 'maxMs']); expect(metric.maxMs).toBeGreaterThanOrEqual(0); expect(metric.totalMs).toBeGreaterThanOrEqual(metric.maxMs); }
  expect(JSON.stringify(census.report)).not.toContain('private_unit_');
});

it('records failed replication phase attempts without swallowing strict validation or retaining their payloads', () => {
  const census = createReplicationPhaseCensus(), encoder = createPreparedViewScope(), invalid = replicationView(0, 1);
  invalid.entities[1]!.queue = []; let baseReads = 0;
  expect(() => census.encode(invalid, encoder, () => { baseReads++; return undefined; })).toThrow('INVALID_SNAPSHOT');
  expect(baseReads).toBe(0); expect(census.report.phases.prepareJson.calls).toBe(1); expect(census.report.phases.snapshotEncoding.calls).toBe(0); expect(census.report.phases.byteCount.calls).toBe(0);
  const valid = replicationView(0, 1), first = census.encode(valid, encoder, () => undefined);
  expect(() => census.encode(valid, encoder, () => first.prepared)).toThrow('INVALID_DELTA_BOUNDARY');
  expect(census.report.phases.deltaEncoding.calls).toBe(1); expect(census.report.phases.byteCount.calls).toBe(1);
  const failure = new Error('host_only_failure_payload');
  expect(() => census.views(() => { throw failure; })).toThrow(failure);
  expect(census.report.phases.views.calls).toBe(1); expect(JSON.stringify(census.report)).not.toContain(failure.message);
});

it('fails complete capacity minutes when any required activity is missing and never passes an unsampled minute',()=>{
  const evidence={completeMinuteWindows:1,eachMinuteMovement:true,eachMinuteGathering:true,eachMinuteRepair:true,eachMinuteCombat:true,eachFactionCollectsEveryMinute:true,everySurvivingUnitActiveEachMinute:true};
  expect(capacityActivityPassed(evidence)).toBe(true);
  expect(capacityActivityPassed({...evidence,completeMinuteWindows:0})).toBe(false);
  for(const key of ['eachMinuteMovement','eachMinuteGathering','eachMinuteRepair','eachMinuteCombat','eachFactionCollectsEveryMinute','everySurvivingUnitActiveEachMinute'] as const)expect(capacityActivityPassed({...evidence,[key]:false})).toBe(false);
});

it('bounds host activity counters and reports accepted unit coverage without confusing new paths with invalidation',()=>{
  const census=createCapacityActivityCensus(2),request=(unitId:string):PathRequest=>({id:`path_${unitId}`,unitId,orderRevision:1,from:{xMm:5000,zMm:5000},target:{xMm:15000,zMm:5000},radiusMm:400,profile:'blue'});
  census.accepted({kind:'gather',unitIds:['worker'],targetId:'tree',queued:false},10);census.accepted({kind:'move',unitIds:['worker'],target:{xMm:15000,zMm:5000},queued:false},20);
  census.requested(request('worker'),20,false);census.requested(request('worker'),21,true);
  expect(census.read('worker')).toMatchObject({acceptedCommands:2,acceptedMoveCommands:1,lastAcceptedTick:20,lastAcceptedKind:'move',pathRequests:2,invalidationRestarts:1,firstRequestTick:20,lastRequestTick:21});
  const detached=census.read('worker')!;detached.pathRequests=100;expect(census.read('worker')!.pathRequests).toBe(2);
  census.requested(request('next'),30,false);census.requested(request('last'),40,false);expect(census.read('worker')).toBeUndefined();expect(census.totals).toEqual({acceptedUnitCommands:2,pathRequests:4,invalidationRestarts:1,evictions:1});expect(()=>createCapacityActivityCensus(8193)).toThrow('INVALID_ACTIVITY_CENSUS_CAPACITY');
});

it('observes actual scheduler invalidation restarts while preserving requests, work, results and restoration',()=>{
  const nav=new Navigation(64000,64000,[]),observed=new PathScheduler(()=>nav,['blue']),reference=new PathScheduler(()=>nav,['blue']),census=createCapacityActivityCensus(),originalRequest=observed.request,originalInvalidate=observed.invalidate;let tick=1;
  const restore=observeCapacityPathRequests(observed,census,()=>tick),request:PathRequest={id:'first',unitId:'soldier',orderRevision:1,profile:'blue',from:{xMm:5000,zMm:5000},target:{xMm:30000,zMm:5000},radiusMm:400};
  try{
    observed.request(request);reference.request(request);expect(observed.advance(2)).toEqual(reference.advance(2));tick=4;
    const changes=[{xMm:50000,zMm:50000,widthMm:1000,depthMm:1000}];observed.invalidate('blue',changes);reference.invalidate('blue',changes);
    expect(census.read('soldier')).toMatchObject({pathRequests:1,invalidationRestarts:0,firstRequestTick:1,lastRequestTick:1});expect(observed.exportState()).toEqual(reference.exportState());expect(observed.exportState().tasks[0]!.lineStep).toBe(2);
    const intersecting=[{xMm:10000,zMm:4500,widthMm:1000,depthMm:1000}];observed.invalidate('blue',intersecting);reference.invalidate('blue',intersecting);
    expect(census.read('soldier')).toMatchObject({pathRequests:2,invalidationRestarts:1,firstRequestTick:1,lastRequestTick:4});expect(observed.exportState()).toEqual(reference.exportState());
    expect(observed.exportState().tasks[0]!.lineStep).toBe(0);
    tick=10;const next={...request,id:'second',orderRevision:2};observed.request(next);reference.request(next);expect(observed.advance(500)).toEqual(reference.advance(500));expect(observed.take('soldier',2)).toEqual(reference.take('soldier',2));expect(observed.exportState()).toEqual(reference.exportState());expect(census.read('soldier')).toMatchObject({pathRequests:3,invalidationRestarts:1,lastRequestId:'second',lastOrderRevision:2,lastRequestTick:10});
  }finally{restore();}expect(observed.request).toBe(originalRequest);expect(observed.invalidate).toBe(originalInvalidate);
});

it('distinguishes maximal unit counts from mixed-combat population weights at both capacities', () => {
  for (const limit of [120, 200] as const) {
    const one = capacityComposition(limit, 'one-pop'), mixed = capacityComposition(limit, 'mixed');
    expect(one.length * 11).toBe(limit === 120 ? 1320 : 2200); expect(one.every(type => units[type].population === 1)).toBe(true);
    expect(mixed.length).toBeLessThan(limit); expect(mixed.reduce((sum, type) => sum + units[type].population, 0)).toBe(limit);
    expect(mixed).toContain('trebuchet'); expect(mixed.filter(type => type === 'villager')).toHaveLength(40);
  }
});

it('validates a deterministic two-faction offline capacity save without advancing or funding a live world', () => {
  const first = createCapacityFixture({ factions, identity, populationLimit: 120, seed: 'capacity-unit-fixture' });
  expect(createCapacityFixture({ factions, identity, populationLimit: 120, seed: 'capacity-unit-fixture' }).save).toEqual(first.save);
  expect(first.provenance).toMatchObject({ expectedUnits: 240, expectedPopulation: 240, nonWallBuildingsPerFaction: 80, wallEquivalentCellsPerFaction: 160, resourceNodes: 8000, controllers: false, runtimeGrantsOrRespawns: false });
  expect(first.provenance.initialCollisionPairsChecked).toBeGreaterThan(8000);
  const restored = restoreSimulation(first.save, identity, { preserveEpoch: true }); expect(restored.state.tick).toBe(0); expect(restored.capture()).toEqual(first.save.payload);
  for (const faction of factions) { expect(first.drills[faction.id]!.farms).toHaveLength(16); expect(first.drills[faction.id]!.repairers).toHaveLength(5); expect(restored.state.economies[faction.id]!.technologies).toHaveLength(balance.technologies.length); }
  const collision = structuredClone(Object.values(first.save.payload.state.entities).filter(entity => entity.kind === 'unit').slice(0, 2)); collision[1]!.xMm = collision[0]!.xMm; collision[1]!.zMm = collision[0]!.zMm;
  expect(() => validateCapacityGeometry(collision)).toThrow('FIXTURE_COLLISION');
});

it.each([120, 200] as const)('constructs the actual eleven-faction %i profile with no simulation advancement', populationLimit => {
  const roster: PublicPlayer[] = Array.from({ length: 11 }, (_, index) => ({ id: `capacity_${index}`, name: `Capacity ${index}`, teamId: `team_${index}`, kind: index < 6 ? 'human' : 'ai', color: '#123456', hostPlayer: index === 0 }));
  const fixture = createCapacityFixture({ factions: roster, identity, populationLimit, seed: `capacity-${populationLimit}` });
  expect(fixture.save.payload.state.tick).toBe(0);
  expect(fixture.provenance).toMatchObject({ expectedUnits: populationLimit * 11, expectedPopulation: populationLimit * 11, resourceNodes: 8000 });
  expect(Object.values(fixture.save.payload.state.entities).filter(entity => entity.kind === 'unit')).toHaveLength(populationLimit * 11);
  expect(Object.values(fixture.save.payload.state.entities).filter(entity => entity.kind === 'building')).toHaveLength(11 * (80 + 154 + 2));
  expect(Object.values(fixture.save.payload.state.entities).some(entity => entity.typeId === 'monument')).toBe(false);
  expect(fixture.provenance).toMatchObject({ resourceLayout: 'finite-town-edge-bands-v1', townEdgeNodesPerFaction: 700 });
  const entities = Object.values(fixture.save.payload.state.entities);
  for (const [index, faction] of roster.entries()) {
    const x = index % 4 * 152000, z = Math.floor(index / 4) * 200000, economy = fixture.save.payload.state.economies[faction.id]!;
    const townNodes = entities.filter(entity => entity.kind === 'resource' && entity.xMm >= x && entity.xMm < x + 152000 && entity.zMm >= z && entity.zMm < z + 200000);
    expect(townNodes).toHaveLength(719);
    const emitters = entities.flatMap(entity => entity.kind === 'building' && entity.ownerId === faction.id ? [{ x: entity.xMm, z: entity.zMm, range: effectiveBuilding(entity.typeId, economy.technologies).visionM * 1000 }] : []);
    for (const resource of ['wood', 'gold', 'stone']) {
      // Flat fixture: a resource-center fog cell covered by an ordinary building
      // emitter is observable without a reveal grant or simulation advancement.
      const visibleReserve = townNodes.filter(node => node.kind === 'resource' && node.resource === resource && emitters.some(emitter => Math.hypot(emitter.x - node.xMm, emitter.z - node.zMm) <= emitter.range));
      expect(visibleReserve.length).toBeGreaterThan(20);
    }
  }
});

it('reports attrition honestly instead of qualifying density from the initial maximum alone', () => {
  expect(densitySummary([1320, 1320, 1200, 1000], 1320)).toMatchObject({ min: 1000, median: 1200, max: 1320, samplesAtNominal: 2, samplesBelow95Percent: 2, samplesBelow90Percent: 1, nominalFraction: .5 });
  expect(distribution([50, 1, 35, 10, 40])).toMatchObject({ min: 1, median: 35, p95: 50, p99: 50, max: 50 });
  expect(densitySummary([], 1320).nominalFraction).toBe(0);
  expect(memoryTrend([{ elapsedMs: 0, rssMiB: 1000, heapUsedMiB: 500 }, { elapsedMs: 600000, rssMiB: 100, heapUsedMiB: 50 }, { elapsedMs: 1200000, rssMiB: 120, heapUsedMiB: 60 }])).toMatchObject({ excludesFirstMinutes: 10, sampledMinutes: 10, rssMiBPerMinute: 2, heapMiBPerMinute: 1, automaticNoLeakClaim: false });
  expect(memoryTrend([{ elapsedMs: 0, rssMiB: 100, heapUsedMiB: 50 }]).rssMiBPerMinute).toBeNull();
});

it('keeps drill decisions recipient-scoped, waits when paused, and does not target a hidden enemy House', () => {
  const drill: CapacityDrill = { playerId: 'blue', home: { xMm: 10000, zMm: 10000 }, farms: [], resourceWorkers: [{ workerId: 'worker', resource: 'wood' }], repairers: [], repairHouseId: 'own-house', combatArchers: ['archer'], combatTargetId: 'hidden-house', armyGroups: [], gateLoop: [{ xMm: 10000, zMm: 12000 }, { xMm: 10000, zMm: 20000 }] };
  const view: PlayerView = { protocolVersion: 2, contentHash: 'fixture', matchId: 'fixture', matchEpoch: 1, tick: 1, sequence: 1, status: 'RUNNING', playerId: 'blue', map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 }, players: factions, self: { lastCommandSequence: 0, resources: { food: 0, wood: 0, gold: 0, stone: 0 }, age: 4, population: 120, populationCap:120,populationLimit:120, reservedPopulation: 0, autoReseed: true }, fog: { visible: [], explored: [] }, entities: [{ id: 'worker', ownerId: 'blue', kind: 'unit', typeId: 'villager', xMm: 10000, zMm: 10000, hp: 40, maxHp: 40, order: 'idle' }, { id: 'archer', ownerId: 'blue', kind: 'unit', typeId: 'archer', xMm: 20000, zMm: 20000, hp: 45, maxHp: 45, order: 'idle' }, { id: 'hidden-house', ownerId: 'red', kind: 'building', typeId: 'house', xMm: 22000, zMm: 20000, hp: 700, maxHp: 720, ghost: true }, { id: 'known-tree', ownerId: null, kind: 'resource', typeId: 'tree_oak', resource: 'wood', amount: 100, xMm: 11000, zMm: 10000, hp: 1, maxHp: 1 }] };
  expect(capacityDutyCommands(view, drill, createCapacityDutyMemory())).toEqual([{ kind: 'gather', unitIds: ['worker'], targetId: 'known-tree', queued: false }]);
  expect(capacityDutyCommands({ ...view, status: 'PAUSED' }, drill, createCapacityDutyMemory())).toEqual([]);
  expect(() => capacityDutyCommands({ ...view, playerId: 'red' }, drill, createCapacityDutyMemory())).toThrow('DUTY_VIEWPOINT_MISMATCH');
});
