import { describe, expect, it } from 'vitest';
import { PlanningWorkCensus, PlanningOverlapCensus, planningCompatibility, planningTaskDetails } from '../src/planning-work-diagnostics.js';
import { Navigation } from '../src/navigation.js';
import { LocalAvoidance, UnitSpatialIndex } from '../src/movement.js';
import { PathScheduler, type PathRequest } from '../src/path-scheduler.js';
import { createSimulation, exportSimulationSave, restoreSimulation, type EngineIdentity, type Simulation, type Unit } from '../src/index.js';
import type { GameplayCommand, PublicPlayer } from '@frontier/shared';

const request: PathRequest = { id: 'path', unitId: 'u', orderRevision: 1, profile: 'blue', radiusMm: 350, from: { xMm: 8000, zMm: 24000 }, target: { xMm: 56000, zMm: 24000 } };
const identity: EngineIdentity = { engineBuildHash: '2'.repeat(64), runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch } };

describe('B1/B2 private planning readiness census', () => {
  it('accounts nested spans without adding inclusive children twice and bounds retained examples/kinds/depth', () => {
    let now = 0; const census = new PlanningWorkCensus({ tick: () => 7, now: () => now++ });
    expect(census.measure('scheduler.step', () => census.measure('scheduler.connectors', () => 42), request)).toBe(42);
    let snapshot = census.snapshot();
    expect(snapshot.operations['scheduler.step']).toMatchObject({ calls: 1, measured: 1, inclusiveMs: 3, exclusiveMs: 2 });
    expect(snapshot.operations['scheduler.connectors']).toMatchObject({ calls: 1, measured: 1, inclusiveMs: 1, exclusiveMs: 1 });
    for (let index = 0; index < 40; index++) census.measure('local.path', () => undefined);
    const recurse = (depth: number): void => { if (depth) census.measure('local.step', () => recurse(depth - 1)); };
    recurse(20); census.begin('not-an-operation' as never);
    snapshot = census.snapshot();
    expect(snapshot.largest).toHaveLength(16); expect(snapshot.largestOmissions).toBeGreaterThan(0); expect(snapshot.depthOmissions).toBe(4); expect(snapshot.operationOmissions).toBe(1); expect(snapshot.openSpans).toBe(0);
    expect(Object.keys(snapshot.operations).length).toBeLessThanOrEqual(snapshot.limits.operationKinds);
    snapshot.largest[0]!.ms = 999999; expect(census.snapshot().largest[0]!.ms).not.toBe(999999);
  });

  it('keeps thrown/backward/invalid clocks and original operation errors out of game decisions', () => {
    for (const read of [() => Number.NaN, () => -1, () => { throw new Error('clock failure'); }]) {
      const census = new PlanningWorkCensus({ tick: read, now: read });
      expect(census.measure('local.path', () => 17)).toBe(17);
      const original = new Error('original-operation'); expect(() => census.measure('local.path', () => { throw original; })).toThrow(original);
      expect(census.snapshot()).toMatchObject({ openSpans: 0, operations: { 'local.path': { calls: 2, measured: 0, invalid: 2 } } });
    }
    let now = 10; const backward = new PlanningWorkCensus({ tick: () => 0, now: () => now-- });
    backward.measure('local.path', () => undefined); expect(backward.snapshot().operations['local.path']!.invalid).toBe(1);
    const readings = [0, 100, 200, 50], nested = new PlanningWorkCensus({ tick: () => 0, now: () => readings.shift()! });
    expect(nested.measure('scheduler.step', () => nested.measure('scheduler.connectors', () => 23))).toBe(23);
    expect(nested.snapshot()).toMatchObject({ invalidClockReads: 1, openSpans: 0, operations: { 'scheduler.step': { measured: 0, invalid: 1 }, 'scheduler.connectors': { measured: 1, inclusiveMs: 100 } } });
  });

  it('labels incomplete component metadata unknown and never equates regions, owners, radii or heuristic targets', () => {
    const details = planningTaskDetails({ ...request, stage: 'coarse', startComponents: ['0,1,4'], endComponents: ['3,1,8'] });
    const rows = [
      { request, details },
      { request: { ...request, unitId: 'near', target: { xMm: 56500, zMm: 24000 } }, details },
      { request: { ...request, unitId: 'other-label' }, details: { ...details, ends: ['3,1,9'] } },
      { request: { ...request, unitId: 'foreign', profile: 'red' }, details },
      { request: { ...request, unitId: 'large', radiusMm: 850 }, details },
      { request: { ...request, unitId: 'unknown' }, details: planningTaskDetails({ ...request, stage: 'direct', lineSteps: 100, lineStep: 4 }) },
    ];
    const result = planningCompatibility(rows);
    expect(result).toMatchObject({ compatibilityProven: false, knownComponents: 5, unknownComponents: 1, goalComponentCandidates: { sharedRequests: 2 }, exactTargetOrderedComponentCandidates: { sharedRequests: 0 }, directRemaining: { known: 1, total: 96 } });
    const overflow = planningTaskDetails({ ...request, stage: 'coarse', startComponents: Array(10).fill('0,1,4'), endComponents: ['3,1,8'] });
    expect(planningCompatibility([{ request, details: overflow }]).unknownComponents).toBe(1);
    const many = Array.from({ length: 30 }, (_, index) => ({ request: { ...request, profile: `p${index}` }, details }));
    expect(planningCompatibility(many).goalComponentCandidates).toMatchObject({ groups: 30, omittedGroupExamples: 14 });
    details.ends![0] = 'mutated'; expect(result.goalComponentCandidates.sharedRequests).toBe(2);
  });

  it('retains short-lived overlap peaks, separates pending identity and bounds membership across reset', () => {
    const census = new PlanningOverlapCensus();
    const details = planningTaskDetails({ ...request, stage: 'coarse', startComponents: ['0,1,4'], endComponents: ['3,1,8'] });
    census.update(request, details, true);
    census.update({ ...request, unitId: 'second' }, details, true);
    census.update({ ...request, unitId: 'second' }, details, true);
    expect(census.snapshot().exactTargetOrderedComponentCandidates).toMatchObject({ activeSharedRequests: 2, maximumGroupSize: 2, joinsIntoExistingCandidateGroup: 1 });
    census.remove('second'); census.update(request, details, false);
    expect(census.snapshot()).toMatchObject({ trackedMembers: 0, goalComponentCandidates: { activeSharedRequests: 0, maximumSharedRequests: 2 } });
    for (let index = 0; index < 4097; index++) census.update({ ...request, unitId: `bounded-${index}` }, details, true);
    expect(census.snapshot()).toMatchObject({ trackedMembers: 4096, omittedUpdates: 1, goalComponentCandidates: { activeSharedRequests: 4096 } });
    census.clearActive();
    expect(census.snapshot()).toMatchObject({ trackedMembers: 0, activeResets: 1, goalComponentCandidates: { activeGroups: 0, activeSharedRequests: 0, maximumGroupSize: 4096 } });
    census.update({ ...request, unitId: 'unknown' }, planningTaskDetails(request), true);
    expect(census.snapshot().trackedMembers).toBe(0);
    census.update(request, details, true);
    census.update({ ...request, unitId: 'other-owner', profile: 'red' }, details, true);
    expect(census.snapshot().goalComponentCandidates.activeSharedRequests).toBe(0);
    const detached = census.snapshot(); detached.goalComponentCandidates.maximumGroupSize = -1;
    expect(census.snapshot().goalComponentCandidates.maximumGroupSize).toBe(4096);
  });

  it('preserves scheduled work, route results, cancel/invalidation and cold pending frontiers with diagnostics enabled', () => {
    const obstacle = { id: 'wall', xMm: 32000, zMm: 24000, halfWidth: 1000, halfHeight: 18000 };
    const nav = new Navigation(64000, 64000, [obstacle]);
    const control = new PathScheduler(() => nav, ['blue', 'red']), observed = new PathScheduler(() => nav, ['blue', 'red']);
    let tick = 0, now = 0, charged = 0; observed.enablePathDiagnostics({ tick: () => tick, now: () => ++now });
    control.request(request); observed.request(request);
    let cold: PathScheduler | undefined;
    for (tick = 1; tick <= 45; tick++) {
      if (tick === 8) for (const scheduler of [control, observed]) scheduler.request({ ...request, id: 'other', unitId: 'other', profile: 'red' });
      if (tick === 10) for (const scheduler of [control, observed]) scheduler.cancel('other');
      if (tick === 12) for (const scheduler of [control, observed]) {
        const pending = scheduler.exportState().tasks.find(task => task.unitId === request.unitId);
        const startRegion = `${Math.floor(request.from.xMm / 16000)},${Math.floor(request.from.zMm / 16000)},`;
        expect(pending?.stage).toBe('coarse');
        expect(Object.keys(pending?.coarse?.scores ?? {}).some(component => component.startsWith(startRegion))).toBe(true);
        // An unvisited wall region need not restart the current search. Exercise
        // invalidation of an already-used dependency, without changing its work.
        scheduler.invalidate('blue', [{ ...request.from, widthMm: 1000, depthMm: 1000 }]);
      }
      const expected = control.advance(128); charged += expected.work; expect(observed.advance(128)).toEqual(expected); if (cold) expect(cold.advance(128)).toEqual(expected);
      const result = control.take('u', 1); expect(observed.take('u', 1)).toEqual(result); if (cold) expect(cold.take('u', 1)).toEqual(result);
      expect(JSON.stringify(observed.exportState())).toBe(JSON.stringify(control.exportState()));
      if (cold) expect(JSON.stringify(cold.exportState())).toBe(JSON.stringify(control.exportState()));
      if (tick === 20) { cold = new PathScheduler(() => nav, ['blue', 'red']); cold.importState(observed.exportState()); cold.enablePathDiagnostics({ tick: () => tick, now: () => { throw new Error('diagnostic-only'); } }); }
    }
    const report = observed.pathDiagnostics()!;
    expect(report.execution.operations['scheduler.step']!.calls).toBe(charged);
    expect(report.execution.scheduledWork.total).toBe(charged);
    expect(report.execution.scheduledWork.byStage.direct).toBeGreaterThan(0);
    expect(report.execution.scheduledWork.byStage.coarse).toBeGreaterThan(0);
    expect(report.counts).toMatchObject({ canceled: 1, invalidations: 1, restarts: 1 });
    expect(report.execution.operations['scheduler.connectors']!.calls).toBeGreaterThan(0);
    expect(report.execution.operations['scheduler.region-fill']!.calls).toBeGreaterThan(0);
    expect(JSON.stringify(observed.exportState())).not.toMatch(/execution|compatibility|inclusiveMs|invalidClock/);
  });

  it('keeps local2048-node grants, retry resolution, legal steps and cold state exact', () => {
    const nav = new Navigation(24000, 32000, [{ id: 'top', xMm: 12000, zMm: 6025, halfWidth: 1000, halfHeight: 6025 }, { id: 'bottom', xMm: 12000, zMm: 22475, halfWidth: 1000, halfHeight: 9525 }]);
    const body = { id: 'mover', xMm: 2000, zMm: 4000, radiusMm: 350 }, stopped = { id: 'stopped', xMm: 2700, zMm: 4000, radiusMm: 350 }, target = { xMm: 22000, zMm: 4000 };
    const index = new UnitSpatialIndex(); index.set(body); index.set(stopped);
    const control = new LocalAvoidance(), observed = new LocalAvoidance(); let now = 0, tick = 0;
    observed.enablePlanningDiagnostics({ tick: () => tick, now: () => ++now });
    let cold: LocalAvoidance | undefined;
    for (tick = 0; tick < 30; tick++) {
      for (const current of [control, observed, ...(cold ? [cold] : [])]) current.beginTick(tick, 1);
      const next = control.step(body, target, 150, nav, index); expect(observed.step(body, target, 150, nav, index)).toEqual(next); if (cold) expect(cold.step(body, target, 150, nav, index)).toEqual(next);
      expect(JSON.stringify(observed.exportState())).toBe(JSON.stringify(control.exportState())); if (cold) expect(cold.exportState()).toEqual(control.exportState());
      if (next) { expect(index.clearLine(body, next, 350, body.id)).toBe(true); Object.assign(body, next); index.set(body); }
      if (tick === 10) { cold = new LocalAvoidance(); cold.importState(observed.exportState()); cold.enablePlanningDiagnostics({ tick: () => tick, now: () => Number.NaN }); }
    }
    expect(observed.planningDiagnostics()!.operations['local.path']!.calls).toBeGreaterThan(0);
    expect(observed.planningDiagnostics()!.operations['local.grant']!.calls).toBeGreaterThan(0);
    expect(index.nearby(stopped, 0).find(value => value.id === stopped.id)).toEqual(stopped);
    control.release(body.id); observed.release(body.id); expect(observed.exportState()).toEqual(control.exportState());
  });

  it('reports a thrown local search in both enclosing scopes and preserves the original exception and state', () => {
    const original = new Error('query-failure'), nav = new Navigation(24000, 24000, []);
    const overlay = nav.withAdditionalObstacles.bind(nav);
    nav.withAdditionalObstacles = (...args) => { const local = overlay(...args); local.path = () => { throw original; }; return local; };
    const body = { id: 'mover', xMm: 2000, zMm: 4000, radiusMm: 350 }, stopped = { id: 'stopped', xMm: 2700, zMm: 4000, radiusMm: 350 };
    const index = new UnitSpatialIndex(); index.set(body); index.set(stopped);
    const control = new LocalAvoidance(), observed = new LocalAvoidance(); let now = 0;
    observed.enablePlanningDiagnostics({ tick: () => 0, now: () => ++now });
    for (const avoidance of [control, observed]) {
      avoidance.beginTick(0, 1);
      expect(() => avoidance.step(body, { xMm: 22000, zMm: 4000 }, 150, nav, index)).toThrow(original);
    }
    expect(observed.exportState()).toEqual(control.exportState());
    expect(observed.planningDiagnostics()).toMatchObject({ openSpans: 0, operations: { 'local.path': { calls: 1, failures: 1 }, 'local.grant': { calls: 1, failures: 1 }, 'local.step': { calls: 1, failures: 1 }, 'local.overlay': { calls: 1, failures: 0 } } });
  });

  it('keeps actual Simulation receipts, captures, views/actions and journal exact through same-identity cold restore', () => {
    const factions: PublicPlayer[] = [{ id: 'blue', name: 'Blue', teamId: 'blue', kind: 'human', color: '#3388ff' }, { id: 'red', name: 'Red', teamId: 'red', kind: 'human', color: '#ee5533' }];
    let control = createSimulation({ factions, matchId: 'planning-census', seed: 'planning-census', controllers: false, sharedVision: false });
    let observed = restoreSimulation(exportSimulationSave(control, identity), identity, { preserveEpoch: true });
    let now = 0; observed.enablePlanningDiagnostics(() => ++now);
    const compare = () => { expect(JSON.stringify(observed.capture())).toBe(JSON.stringify(control.capture())); expect(observed.views(['blue', 'red'])).toEqual(control.views(['blue', 'red'])); expect(observed.committedUnitActions()).toEqual(control.committedUnitActions()); expect(observed.journalEvents()).toEqual(control.journalEvents()); };
    const send = (simulation: Simulation, command: GameplayCommand) => { const sequence = simulation.state.economies.blue!.lastClientSequence + 1; return simulation.command('blue', { protocolVersion: 2, matchId: simulation.state.matchId, matchEpoch: simulation.state.matchEpoch, clientSequence: sequence, clientCommandId: `census_${sequence}`, command }); };
    const mover = Object.values(control.state.entities).find((value): value is Unit => value.kind === 'unit' && value.ownerId === 'blue')!;
    for (const command of [{ kind: 'stop', unitIds: [mover.id] }, { kind: 'move', unitIds: [mover.id], target: { xMm: mover.xMm + 4000, zMm: mover.zMm }, queued: false }] satisfies GameplayCommand[]) expect(send(observed, command)).toEqual(send(control, command));
    // Restore both initial transient-action maps before comparing live steps.
    control = restoreSimulation(exportSimulationSave(control, identity), identity, { preserveEpoch: true });
    observed = restoreSimulation(exportSimulationSave(observed, identity), identity, { preserveEpoch: true }); observed.enablePlanningDiagnostics(() => ++now);
    for (let tick = 0; tick < 24; tick++) {
      control.step(); observed.step(); compare(); observed.planningDiagnostics();
      if (tick === 11) { control = restoreSimulation(exportSimulationSave(control, identity), identity, { preserveEpoch: true }); observed = restoreSimulation(exportSimulationSave(observed, identity), identity, { preserveEpoch: true }); observed.enablePlanningDiagnostics(() => { throw new Error('clock-only'); }); compare(); }
    }
    expect(observed.planningDiagnostics()?.localAvoidance).toHaveLength(2);
    expect(JSON.stringify([observed.capture(), observed.views(['blue', 'red']), observed.journalEvents()])).not.toMatch(/compatibilityProven|inclusiveMs|largestOmissions|workCensus/);
  });
});
