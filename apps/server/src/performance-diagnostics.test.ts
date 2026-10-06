import { describe, expect, it } from 'vitest';
import { balance, buildings, units, type BuildingId, type GameplayCommand, type PublicPlayer, type UnitId } from '@frontier/shared';
import { createSimulation, exportSimulationSave, restoreSimulation, type Building, type EngineIdentity, type Unit } from '@frontier/simulation';
import { VisionMaskKernel } from '../../../packages/simulation/src/vision-mask-kernel.js';
import { ActionCoverageDiagnostics, IsolateRuntimeDiagnostics, MovementDiagnostics, PERFORMANCE_SAMPLE_LIMIT, PerformanceDiagnostics, PublicationTimes, ViewDeliveryDiagnostics, WorkerCallbackDiagnostics, WorkerCycleDiagnostics, WorkerOverloadDiagnostics, WORKER_SIMULATION_STAGES, WorkerSimulationStageDiagnostics, WorkerControllerPhaseDiagnostics, CONTROLLER_PROFILE_ROW_LIMIT, type ControllerPhaseRow } from './performance-diagnostics.js';

describe('complete coordinator cycle costs',()=>{
  const running={matchId:'cycle',matchEpoch:1,status:'RUNNING'};
  const accounting=(start:number,duration:number)=>({startedAtMs:start,endedAtMs:start+duration,totalMs:duration,invalidClockSamples:0});
  it('combines separate publication, commands, diagnostics and checkpoint costs with the next advance exactly once',()=>{
    const cycles=new WorkerCycleDiagnostics();cycles.observe({...running,status:'LOADING'},running,accounting(0,5000),false);
    cycles.observe(running,running,accounting(6000,200),true);expect(cycles.snapshot().cycleSamples).toBe(0);
    cycles.observe(running,running,accounting(6200,40),false); // queued projection flush
    cycles.observe(running,running,accounting(6240,5),false); // command
    cycles.observe(running,running,accounting(6245,12),false); // host diagnostics
    cycles.observe(running,running,accounting(6257,33),false); // checkpoint
    cycles.observe(running,running,accounting(7000,220),true);
    expect(cycles.snapshot()).toEqual({cycleMs:{p50:310,p95:310,p99:310,max:310},cycleSamples:1});
  });
  it('does not earn samples or add idle wall time from timer polls and excludes incomplete pause/epoch tails',()=>{
    const cycles=new WorkerCycleDiagnostics();cycles.observe(running,running,accounting(0,200),true);
    for(let index=0;index<20;index++)cycles.observe(running,running,accounting(1000+index*3000,1),false);
    expect(cycles.snapshot().cycleSamples).toBe(0);cycles.observe(running,running,accounting(70000,200),true);
    expect(cycles.snapshot()).toEqual({cycleMs:{p50:220,p95:220,p99:220,max:220},cycleSamples:1});
    cycles.observe(running,running,accounting(70200,1000),false);
    const paused={...running,status:'PAUSED'},resumed={...running,matchEpoch:2};
    cycles.observe(running,paused,accounting(71200,50),false);cycles.observe(paused,paused,accounting(72000,5000),false);
    cycles.observe(paused,resumed,accounting(90000,50),false);cycles.observe(resumed,resumed,accounting(91000,300),true);
    expect(cycles.snapshot().cycleSamples).toBe(1);cycles.observe(resumed,resumed,accounting(92000,240),true);
    expect(cycles.snapshot()).toEqual({cycleMs:{p50:220,p95:240,p99:240,max:240},cycleSamples:2});
    cycles.reset();expect(cycles.snapshot()).toEqual({cycleMs:{p50:0,p95:0,p99:0,max:0},cycleSamples:0});
  });
  it('rejects overlapping or invalid callback spans and bounds retained complete cycles',()=>{
    const cycles=new WorkerCycleDiagnostics();cycles.observe(running,running,accounting(0,100),true);
    cycles.observe(running,running,accounting(90,100),true);expect(cycles.snapshot().cycleSamples).toBe(0);
    cycles.observe(running,running,accounting(200,100),true);cycles.observe(running,running,{...accounting(400,100),invalidClockSamples:1},true);
    expect(cycles.snapshot().cycleSamples).toBe(0);
    for(let index=0;index<1301;index++)cycles.observe(running,running,accounting(1000+index*300,index<100?250:100),true);
    expect(cycles.snapshot()).toEqual({cycleMs:{p50:100,p95:100,p99:100,max:100},cycleSamples:1200});
  });
  it('adds actual background planner return work without counting waits or double charging an awaited callback',()=>{
    const cycles=new WorkerCycleDiagnostics();cycles.observeCoordinatorWork(running,40,false); // no prior advancing boundary
    cycles.observe(running,running,accounting(0,100),true);
    cycles.observeCoordinatorWork(running,3,false);cycles.observeCoordinatorWork(running,13,false);cycles.observeCoordinatorWork(running,8,false);
    // During an awaited capture, its enclosing200ms already owns the callback.
    cycles.observeCoordinatorWork(running,50,true);cycles.observe(running,running,accounting(5000,200),false);
    cycles.observe(running,running,accounting(6000,100),true);
    expect(cycles.snapshot()).toEqual({cycleMs:{p50:324,p95:324,p99:324,max:324},cycleSamples:1});
    cycles.observeCoordinatorWork({...running,matchEpoch:2},999,false);cycles.observeCoordinatorWork({...running,status:'PAUSED'},999,false);
    cycles.observeCoordinatorWork(running,NaN,false);cycles.observeCoordinatorWork(running,-10,false);
    cycles.observe(running,running,accounting(7000,100),true);expect(cycles.snapshot().cycleMs.p50).toBe(100);
    cycles.reset();cycles.observeCoordinatorWork(running,999,false);cycles.observe(running,running,accounting(8000,100),true);
    expect(cycles.snapshot().cycleSamples).toBe(0);
  });
});

describe('bounded private performance diagnostics', () => {
  it('reconciles exclusive callback phases across nested details, four steps, failures and other work', () => {
    let now = 0;
    const callbacks = new WorkerCallbackDiagnostics(() => now), history = new WorkerOverloadDiagnostics(() => now);
    const span = callbacks.begin('timer'), event = history.begin('timer', { tick: 0, matchEpoch: 1, status: 'RUNNING' }, 200, span.startedAtMs);
    now = 2;
    span.measure('commandDrain', () => { now += 3; });
    for (let tick = 0; tick < 4; tick++) {
      span.measure('coreStep', () => { now += 5; });
      span.measure('activityProjection', () => { now += 2; });
    }
    span.measure('viewAssemblyPost', () => {
      now += 7;
      span.measure('journalCheckpoint', () => { now += 11; }); // child is excluded from the parent
      now += 13;
    });
    expect(() => span.measure('journalCheckpoint', () => { now += 17; throw new Error('capture failed'); })).toThrow('capture failed');
    now += 19;
    const accounting = callbacks.finish(span);
    expect(accounting).toMatchObject({ operation: 'timer', totalMs: 100, accountedMs: 100, remainderMs: 0, invalidClockSamples: 0,
      phasesMs: { commandDrain: 3, coreStep: 20, activityProjection: 8, viewAssemblyPost: 20, journalCheckpoint: 28, other: 21 } });
    history.finish(event, { tick: 4, matchEpoch: 1, status: 'RUNNING' }, [5, 5, 5, 5], accounting);
    accounting.phasesMs.coreStep = 999;
    expect(history.snapshot().recentEvents[0]!.accounting?.phasesMs.coreStep).toBe(20);
    const report = callbacks.snapshot(); expect(report.total.totalMs).toBe(100);
    expect(report.phases.coreStep!.totalMs).toBe(20); expect(report.callbackKinds.timer!.count).toBe(1);
    expect(report.absoluteReconciliationErrorMs).toBe(0);
    for (let index = 0; index < 1300; index++) { const next = callbacks.begin('unexpected'); now++; callbacks.finish(next); }
    expect(callbacks.snapshot().total.rolling.samples).toBe(1200);
    expect(Object.keys(callbacks.snapshot().callbackKinds)).toEqual(['timer', 'unknown']);
  });

  it('bounds GC records, maps their clock, keeps ELU separate and omits shared process RSS', () => {
    let deliver!: (list: { getEntries(): unknown[] }) => void, disconnected = 0, enabled = 0, disabled = 0;
    let utilization = { active: 10, idle: 30, utilization: .25 };
    let now = 1000;
    const runtime = {
      performance: { now: () => 100, eventLoopUtilization: (later?: typeof utilization, earlier?: typeof utilization) => {
        if (!later || !earlier) return { ...utilization };
        const active = later.active - earlier.active, idle = later.idle - earlier.idle;
        return { active, idle, utilization: active + idle ? active / (active + idle) : 0 };
      } },
      monitorEventLoopDelay: () => ({ enable: () => { enabled++; }, disable: () => { disabled++; }, count: 3, mean: 2000000, max: 7000000, percentile: (value: number) => value * 100000 }),
      PerformanceObserver: class {
        constructor(callback: typeof deliver) { deliver = callback; }
        observe(options: unknown) { expect(options).toEqual({ entryTypes: ['gc'] }); }
        disconnect() { disconnected++; }
      },
      memoryUsage: () => ({ rss: 999, heapTotal: 40, heapUsed: 20, external: 5, arrayBuffers: 3 }),
    };
    const metrics = new IsolateRuntimeDiagnostics('test-worker', () => now++, runtime as unknown as ConstructorParameters<typeof IsolateRuntimeDiagnostics>[2]);
    expect(enabled).toBe(1);
    deliver({ getEntries: () => Array.from({ length: 300 }, (_, index) => ({ startTime: 100 + index, duration: 2, detail: { kind: 1, flags: 0 } })) });
    deliver({ getEntries: () => [{ startTime: NaN, duration: 2 }, { startTime: 500, duration: 3, detail: { kind: 99999 } }] });
    utilization = { active: 30, idle: 50, utilization: .375 };
    const report = metrics.snapshot();
    expect(report.gc.durations).toMatchObject({ count: 301, totalMs: 603 });
    expect(report.gc).toMatchObject({ invalid: 1, evictedEvents: 45, eventLimit: 256, byKind: { 1: { count: 300, totalMs: 600 }, 0: { count: 1, totalMs: 3 } }, clock: { mappingErrorBoundMs: .5 } });
    expect(report.gc.recentEvents).toHaveLength(256);
    expect(report.gc.recentEvents[0]).toMatchObject({ startPerformanceMs: 145, startHostMonotonicMs: 1045.5 });
    expect(report.eventLoopUtilization.sinceStart).toEqual({ active: 20, idle: 20, utilization: .5 });
    expect(report.eventLoopDelay).toMatchObject({ samples: 3, meanMs: 2, maxMs: 7, p95Ms: 9.5 });
    expect(report.memory).toEqual({ heapTotal: 40, heapUsed: 20, external: 5, arrayBuffers: 3 });
    report.gc.recentEvents[0]!.durationMs = 999; expect(metrics.snapshot().gc.recentEvents[0]!.durationMs).toBe(2);
    expect(metrics.snapshot().eventLoopUtilization.sincePreviousSnapshot).toEqual({ active: 0, idle: 0, utilization: 0 });
    metrics.close(); metrics.close(); expect(disconnected).toBe(1); expect(disabled).toBe(1); expect(metrics.snapshot().closed).toBe(true);
  });

  it('retains a detached overload timeline separating callback work from gaps and survives pause', () => {
    let now = 0;
    const history = new WorkerOverloadDiagnostics(() => now), state = { tick: 20, matchEpoch: 1, status: 'RUNNING' };
    const first = history.begin('timer', state, 0); now = 45; state.tick++;
    history.finish(first, state, [40]);
    now = 50; const message = history.begin('capture', state); now = 70; history.finish(message, state);
    now = 2300; const trigger = history.begin('timer', state, 2200); history.captureOverload(trigger);
    state.status = 'PAUSED'; state.matchEpoch++; now = 2310; history.finish(trigger, state);
    const report = history.snapshot();
    expect(report.lastOverload).toMatchObject({ trigger: { tick: 21, epoch: 1, status: 'RUNNING', debtMs: 2200, gapBeforeMs: 2230 },
      completedCallback: { durationMs: 10, stepsMs: [] }, precedingEvents: [
        { operation: 'timer', durationMs: 45, stepsMs: [40], gapBeforeMs: null }, { operation: 'capture', durationMs: 20, gapBeforeMs: 5 },
      ] });
    report.lastOverload!.precedingEvents[0]!.stepsMs[0] = 999;
    report.lastOverload!.trigger.debtMs = 0;
    for (let i = 0; i < 300; i++) { now += 10; const span = history.begin('timer', state); history.finish(span, state); }
    expect(history.snapshot().recentEvents).toHaveLength(256);
    expect(history.snapshot().lastOverload?.precedingEvents[0]?.stepsMs).toEqual([40]);
    expect(history.snapshot().lastOverload?.trigger.debtMs).toBe(2200);
    state.status = 'RUNNING'; const resumed = history.begin('timer', state, 0); history.finish(resumed, state);
    expect(history.snapshot().lastOverload?.trigger.epoch).toBe(1);
    history.reset(); expect(history.snapshot()).toMatchObject({ recentEvents: [], lastOverload: null });
    expect(history.begin('unexpected payload', state).operation).toBe('unknown');
  });

  it('retains advancing callbacks across admission bursts with explicit bounded loss counts', () => {
    let now = 0;
    const history = new WorkerOverloadDiagnostics(() => now), state = { tick: 0, matchEpoch: 1, status: 'RUNNING' };
    for (let index = 0; index < 300; index++) { const span = history.begin('timer', state); now += 50; state.tick++; history.finish(span, state, [45]); }
    for (let index = 0; index < 300; index++) { const span = history.begin('command', state); now++; history.finish(span, state); }
    const trigger = history.begin('timer', state, 2200); history.captureOverload(trigger);
    const report = history.snapshot();
    expect(report).toMatchObject({ eventCount: 600, advancingEventCount: 300, omittedEvents: 344, omittedAdvancingEvents: 44 });
    expect(report.recentEvents.every(event => event.operation === 'command')).toBe(true);
    expect(report.recentAdvancingEvents).toHaveLength(256);
    expect(report.lastOverload?.precedingAdvancingEvents[0]).toMatchObject({ tick: 44, endTick: 45, stepsMs: [45] });
    report.recentAdvancingEvents[0]!.stepsMs[0] = 999;
    report.lastOverload!.precedingAdvancingEvents[0]!.stepsMs[0] = 999;
    expect(history.snapshot().lastOverload?.precedingAdvancingEvents[0]?.stepsMs).toEqual([45]);
    history.reset(); expect(history.snapshot()).toMatchObject({ eventCount: 0, advancingEventCount: 0, omittedEvents: 0, omittedAdvancingEvents: 0, recentAdvancingEvents: [], lastOverload: null });
  });

  it('keeps exact cumulative totals and bounded rolling samples, including failures and invalid clocks', () => {
    let now = 0;
    const metrics = new PerformanceDiagnostics(() => now);
    for (let index = 1; index <= PERFORMANCE_SAMPLE_LIMIT + 300; index++) metrics.sample('viewIpc', index);
    metrics.sample('viewIpc', -1); metrics.sample('viewIpc', NaN);
    expect(() => metrics.measure('prepare', () => { now = 7; throw new Error('same failure'); })).toThrow('same failure');
    const report = metrics.snapshot();
    expect(report.timingQualificationEligible).toBe(false);
    expect(report.phases.viewIpc).toEqual({ count: 1500, totalMs: 1125750, meanMs: 750.5, maxMs: 1500, invalid: 2,
      rolling: { samples: 1200, p50Ms: 900, p95Ms: 1440, p99Ms: 1488, maxMs: 1500 } });
    expect(report.phases.prepare?.totalMs).toBe(7);
    report.phases.viewIpc!.totalMs = 0;
    expect(metrics.snapshot().phases.viewIpc?.totalMs).toBe(1125750);
    for (let index = 0; index < 100; index++) metrics.count(`fixed_${index}`);
    expect(Object.keys(metrics.snapshot().counts)).toHaveLength(64);
  });

  it('bounds recipient correlation windows and detaches stamps across epochs and readers', () => {
    const times = new PublicationTimes();
    for (let sequence = 1; sequence <= 140; sequence++) times.record('blue', { matchId: 'match_a', tick: sequence * 2, sequence, matchEpoch: 1, completedAtMs: 100, postedAtMs: 101 });
    expect(times.find('blue', 'match_a', 1, 12)).toBeUndefined();
    const found = times.find('blue', 'match_a', 1, 13)!; expect(found.tick).toBe(26);
    found.completedAtMs = 999; expect(times.find('blue', 'match_a', 1, 13)?.completedAtMs).toBe(100);
    times.record('blue', { matchId: 'match_a', tick: 0, sequence: 1, matchEpoch: 2, completedAtMs: 200, postedAtMs: 201 });
    expect(times.find('blue', 'match_a', 1, 140)).toBeUndefined();
    for (let index = 0; index < 11; index++) times.record(`other_${index}`, { matchId: 'match_a', tick: 0, sequence: 1, matchEpoch: 1, completedAtMs: 1, postedAtMs: 2 });
    expect(times.find('other_9', 'match_a', 1, 1)).toBeDefined(); expect(times.find('other_10', 'match_a', 1, 1)).toBeUndefined();
    times.record('blue', { matchId: 'match_b', tick: 0, sequence: 1, matchEpoch: 2, postedAtMs: 300 });
    expect(times.find('blue', 'match_a', 2, 1)).toBeUndefined();
    expect(times.find('blue', 'match_b', 2, 1)?.completedAtMs).toBeUndefined();
  });

  it('measures distinct completed tick views, not chunk count or forced same-tick snapshots', () => {
    let now = 110;
    const metrics = new PerformanceDiagnostics(() => now), delivery = new ViewDeliveryDiagnostics(metrics);
    const view = { matchId: 'match_a', matchEpoch: 1, tick: 2, sequence: 1, status: 'RUNNING' };
    delivery.observe(view, { ...view, completedAtMs: 100, postedAtMs: 102 });
    now = 140; delivery.observe({ ...view, sequence: 2 });
    now = 210; delivery.observe({ ...view, tick: 4, sequence: 3 }, { ...view, tick: 4, sequence: 3, completedAtMs: 200, postedAtMs: 201 });
    now = 999; delivery.reset(); delivery.observe({ ...view, tick: 6, sequence: 4 });
    now = 1100; delivery.observe({ ...view, matchEpoch: 2, tick: 0, sequence: 1 });
    now = 1200; delivery.observe({ ...view, matchId: 'match_b', matchEpoch: 2, tick: 0, sequence: 1 }, { ...view, matchId: 'match_a', matchEpoch: 2, tick: 0, sequence: 1, completedAtMs: 1100, postedAtMs: 1101 });
    const report = metrics.snapshot();
    expect(report.phases.viewDeliveryInterval?.count).toBe(1); expect(report.phases.viewDeliveryInterval?.meanMs).toBe(100);
    expect(report.phases.viewDeliveryAge?.count).toBe(2); expect(report.phases.viewDeliveryAge?.maxMs).toBe(10);
    expect(report.counts).toEqual({ distinctRunningTickViews: 5, repeatedOrStaleTickViews: 1, deliveryStampMissing: 3 });
  });

  function fixture() {
    return { matchId: 'match_a', matchEpoch: 1, tick: 0, status: 'RUNNING', entities: { own_worker: { id: 'own_worker', kind: 'unit', ownerId: 'blue', hp: 35, xMm: 100, zMm: 200, orderRevision: 0, orders: [] as unknown[], path: [] as unknown[] } } };
  }
  const envelope = { matchId: 'match_a', matchEpoch: 1, clientCommandId: 'move_1', clientSequence: 1, command: { kind: 'move', queued: false, unitIds: ['own_worker'] } };
  function movementView(state: ReturnType<typeof fixture>) {
    return { matchId: state.matchId, matchEpoch: state.matchEpoch, tick: state.tick, sequence: state.tick, status: state.status, playerId: 'blue',
      entities: Object.values(state.entities).map(unit => ({ id: unit.id, kind: unit.kind, ownerId: unit.ownerId, xMm: unit.xMm, zMm: unit.zMm, visualAction: { kind: 'move' } })) };
  }

  it('separates first authoritative displacement from one exact delivered authorized movement without depending on receipt delivery', () => {
    let now = 0;
    const serverMetrics = new PerformanceDiagnostics(() => now), observerMetrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(serverMetrics), delivery = new ViewDeliveryDiagnostics(observerMetrics), state = fixture();
    delivery.commandIssued('blue', envelope); now = 5; delivery.commandIssued('blue', envelope);
    const candidate = movements.candidate('blue', envelope, state, 5);
    now = 10; state.entities.own_worker.orderRevision = 1; movements.accepted(candidate, true, true, state);
    now = 30; state.tick = 1; state.entities.own_worker.xMm = 110; movements.observe(state, [{ id: 'own_worker', kind: 'move' }]);
    const view = movementView(state); now = 40;
    const certificates = movements.publication(view, state); expect(certificates).toHaveLength(1);
    expect(certificates[0]).toMatchObject({ commandId: 'move_1', commandSequence: 1, orderRevision: 1, firstMoveTick: 1 });
    const stamp = { ...view, completedAtMs: 30, postedAtMs: 40, movements: certificates }, times = new PublicationTimes(); times.record('blue', stamp);
    certificates[0]!.orderRevision = 99; const found = times.find('blue', 'match_a', 1, 1)!; expect(found.movements![0]!.orderRevision).toBe(1); found.movements![0]!.xMm = 999;
    now = 80; delivery.observe(view, times.find('blue', 'match_a', 1, 1));
    expect(serverMetrics.snapshot().phases.acceptedToFirstMove?.meanMs).toBe(20);
    expect(observerMetrics.snapshot().phases.commandIssuedToDeliveredMove?.meanMs).toBe(80); expect(observerMetrics.snapshot().phases.acceptedToDeliveredMove?.meanMs).toBe(70); expect(observerMetrics.snapshot().phases.firstMoveToDeliveredMove?.meanMs).toBe(50);
    now = 90; delivery.observe(view, stamp); delivery.commandIssued('blue', envelope);
    expect(observerMetrics.snapshot().phases.commandIssuedToDeliveredMove?.count).toBe(1); expect(delivery.snapshot().pendingCommands).toBe(0);
    expect(observerMetrics.snapshot().counts.deliveredMoveDuplicateOrStaleCommand).toBe(2);
    expect(JSON.stringify(observerMetrics.snapshot())).not.toContain('own_worker'); expect(JSON.stringify(serverMetrics.snapshot())).not.toContain('move_1');
  });

  it.each(['rejected', 'duplicate', 'blocked', 'stationary_carry', 'uncommitted', 'superseded_before_move', 'superseded_after_move', 'foreign_view', 'hidden_unit', 'wrong_pose', 'old_view', 'epoch', 'new_match', 'paused'] as const)('refuses a delivered movement certificate for %s', condition => {
    let now = 0;
    const metrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(metrics), delivery = new ViewDeliveryDiagnostics(metrics), state = fixture();
    delivery.commandIssued('blue', envelope); const candidate = movements.candidate('blue', envelope, state, 0);
    state.entities.own_worker.orderRevision = 1; now = 10; movements.accepted(candidate, condition !== 'duplicate', condition !== 'rejected', state);
    if (condition === 'superseded_before_move') state.entities.own_worker.orderRevision++;
    state.tick = 1; if (condition !== 'blocked' && condition !== 'stationary_carry') state.entities.own_worker.xMm = 110;
    now = 30; movements.observe(state, [{ id: 'own_worker', kind: condition === 'stationary_carry' ? 'carry' : condition === 'uncommitted' ? 'attack' : 'move' }]);
    if (condition === 'superseded_after_move') state.entities.own_worker.orderRevision++;
    if (condition === 'epoch') state.matchEpoch++;
    if (condition === 'new_match') state.matchId = 'match_b';
    if (condition === 'paused') state.status = 'PAUSED';
    const view = movementView(state);
    if (condition === 'foreign_view') view.playerId = 'red';
    if (condition === 'hidden_unit') view.entities = [];
    if (condition === 'wrong_pose') view.entities[0]!.xMm++;
    if (condition === 'old_view') view.tick--;
    const certificates = movements.publication(view, state); expect(certificates).toEqual([]);
    now = 50; delivery.observe(view, { ...view, postedAtMs: 40, movements: certificates });
    expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toBeUndefined();
    if (condition === 'blocked' || condition === 'stationary_carry') {
      now = 10011; movements.observe(state, []); delivery.observe({ ...view, tick: 2, sequence: 2 });
      expect(metrics.snapshot().counts).toMatchObject({ moveProbeExpired: 1, deliveredMoveExpiredWithoutDelivery: 1 });
    }
  });

  it.each(['sequence', 'epoch', 'match', 'player', 'command_sequence', 'pose', 'idle_pose', 'missing_stamp', 'older_acceptance'] as const)('does not match an observer command against a certificate with %s mismatch', condition => {
    let now = 0;
    const metrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(metrics), delivery = new ViewDeliveryDiagnostics(metrics), state = fixture();
    delivery.commandIssued('blue', envelope); const candidate = movements.candidate('blue', envelope, state, 0);
    now = 10; state.entities.own_worker.orderRevision = 1; movements.accepted(candidate, true, true, state);
    now = 30; state.tick = 1; state.entities.own_worker.xMm = 110; movements.observe(state, [{ id: 'own_worker', kind: 'move' }]);
    const view = movementView(state), stamp = { ...view, postedAtMs: 40, movements: movements.publication(view, state) };
    if (condition === 'sequence') stamp.sequence++;
    if (condition === 'epoch') stamp.matchEpoch++;
    if (condition === 'match') stamp.matchId = 'other_match';
    if (condition === 'player') stamp.movements[0]!.playerId = 'red';
    if (condition === 'command_sequence') stamp.movements[0]!.commandSequence++;
    if (condition === 'pose') stamp.movements[0]!.xMm++;
    if (condition === 'idle_pose') view.entities[0]!.visualAction.kind = 'idle';
    if (condition === 'older_acceptance') { delivery.reset(); now = 35; delivery.commandIssued('blue', envelope); }
    now = 80; delivery.observe(view, condition === 'missing_stamp' ? undefined : stamp);
    expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toBeUndefined();
  });

  it('bounds issued commands and certificate retention and clears correlation across pause, reset and new epochs', () => {
    let now = 0;
    const metrics = new PerformanceDiagnostics(() => now), delivery = new ViewDeliveryDiagnostics(metrics), movements = new MovementDiagnostics(metrics), state = fixture();
    for (let sequence = 1; sequence <= 65; sequence++) delivery.commandIssued('blue', { ...envelope, clientCommandId: `move_${sequence}`, clientSequence: sequence });
    expect(delivery.snapshot().pendingCommands).toBe(64); expect(metrics.snapshot().counts.deliveredMoveOverflow).toBe(1);
    delivery.reset(); expect(delivery.snapshot().pendingCommands).toBe(0); expect(metrics.snapshot().counts.deliveredMoveBoundaryCensored).toBe(64);
    delivery.commandIssued('blue', envelope); delivery.observe({ ...movementView(state), status: 'PAUSED' }); expect(delivery.snapshot().pendingCommands).toBe(0);
    delivery.commandIssued('blue', envelope); delivery.observe({ ...movementView(state), matchEpoch: 2 }); expect(delivery.snapshot().pendingCommands).toBe(0);
    delivery.commandIssued('blue', { ...envelope, matchEpoch: 2 }); delivery.observe(movementView(state)); expect(delivery.snapshot().pendingCommands).toBe(1); // stale epoch must not censor the new command
    const candidate = movements.candidate('blue', envelope, state, 0); now = 10; state.entities.own_worker.orderRevision = 1; movements.accepted(candidate, true, true, state);
    now = 30; state.tick = 1; state.entities.own_worker.xMm = 110; movements.observe(state, [{ id: 'own_worker', kind: 'move' }]); expect(movements.snapshot().certificateCommands).toBe(1);
    now = 10011; movements.observe(state, []); expect(movements.snapshot().certificateCommands).toBe(0); expect(metrics.snapshot().counts.moveCertificateWindowExpired).toBe(1); expect(metrics.snapshot().counts.moveProbeExpired).toBeUndefined();
    movements.reset(); expect(movements.publication(movementView(state), state)).toEqual([]);
  });

  it('bounds certificate windows without suppressing authoritative first-move samples under overflow', () => {
    let now=0;
    const metrics=new PerformanceDiagnostics(()=>now),movements=new MovementDiagnostics(metrics),state=fixture(),entities=state.entities as Record<string,typeof state.entities.own_worker>;
    const accept=(index:number)=>{
      const id=index?`worker_${index}`:'own_worker';if(index)entities[id]={...structuredClone(entities.own_worker!),id,xMm:100,orderRevision:0};
      const command={...envelope,clientCommandId:`move_${index}`,clientSequence:index+1,command:{...envelope.command,unitIds:[id]}},candidate=movements.candidate('blue',command,state,now);
      entities[id]!.orderRevision++;movements.accepted(candidate,true,true,state);return id;
    };
    const ids=Array.from({length:64},(_,index)=>accept(index));now=10;state.tick=1;for(const id of ids)entities[id]!.xMm+=10;
    movements.observe(state,ids.map(id=>({id,kind:'move'})));expect(movements.snapshot()).toMatchObject({pendingCommands:0,certificateCommands:64,certificateUnits:64});
    now=20;const last=accept(64);expect(movements.snapshot().pendingCommands).toBe(1);now=30;state.tick=2;entities[last]!.xMm+=10;movements.observe(state,[{id:last,kind:'move'}]);
    expect(metrics.snapshot().phases.acceptedToFirstMove?.count).toBe(65);expect(metrics.snapshot().counts.moveCertificateOverflow).toBe(1);expect(metrics.snapshot().counts.moveProbeOverflow).toBeUndefined();expect(movements.snapshot().certificateCommands).toBe(64);
  });

  it('records first committed movement after a fresh idle Move, without counting drifting or duplicate commands', () => {
    let now = 10;
    const metrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(metrics), state = fixture();
    const before = structuredClone(state), candidate = movements.candidate('blue', envelope, state, 0);
    expect(state).toEqual(before);
    state.entities.own_worker.orderRevision = 1; state.entities.own_worker.orders.push({ kind: 'move' });
    movements.accepted(candidate, true, true, state); movements.accepted(candidate, false, true, state);
    now = 20; state.entities.own_worker.xMm = 110; movements.observe(state, [{ id: 'own_worker', kind: 'attack' }]);
    expect(movements.snapshot().pendingCommands).toBe(1);
    now = 30; movements.observe(state, [{ id: 'own_worker', kind: 'move' }]);
    expect(movements.snapshot().pendingCommands).toBe(0);
    const report = metrics.snapshot();
    expect(report.phases.acceptedToFirstMove?.meanMs).toBe(20); expect(report.phases.queuedToFirstMove?.meanMs).toBe(30);
    expect(report.counts).toMatchObject({ moveProbeAccepted: 1, moveProbeDuplicate: 1, moveProbeCompleted: 1 });
    expect(JSON.stringify(report)).not.toContain('own_worker');
    expect(movements.candidate('blue', envelope, state, 0)).toBeUndefined();
    expect(movements.candidate('red', envelope, fixture(), 0)).toBeUndefined();
    expect(movements.candidate('blue', { ...envelope, command: { ...envelope.command, queued: true } }, fixture(), 0)).toBeUndefined();
  });

  it('measures an idle loaded worker following Move while refusing stationary carry as movement', () => {
    const simulation = createSimulation({ seed: 'loaded-worker-diagnostic', matchId: 'loaded_worker_diagnostic', controllers: false,
      factions: ['blue', 'red'].map(id => ({ id, name: id, teamId: id, color: '#123456', kind: 'human' })) });
    const worker = Object.values(simulation.state.entities).find((entity): entity is Unit => entity.kind === 'unit' && entity.ownerId === 'blue' && entity.typeId === 'villager')!;
    const towns = Object.values(simulation.state.entities).filter(entity => entity.kind === 'building' && entity.typeId === 'town_center');
    simulation.state.entities = Object.fromEntries([worker, ...towns].map(entity => [entity.id, entity]));
    simulation.state.map.terrain = []; simulation.state.navigationRevision++;
    for (const [index, town] of towns.entries()) { town.xMm = index ? simulation.state.widthMm - 20000 : 20000; town.zMm = index ? simulation.state.heightMm - 20000 : 20000; }
    worker.xMm = Math.floor(simulation.state.widthMm / 2); worker.zMm = Math.floor(simulation.state.heightMm / 2);
    worker.cargo = { resource: 'wood', amount: 1000 }; worker.autoGather = false; worker.stance = 'stand_ground';
    for (const vision of Object.values(simulation.state.vision)) { vision.memory = {}; vision.actions = {}; vision.explored = []; }
    simulation.step();
    expect(worker.orders).toHaveLength(0); expect(worker.path).toHaveLength(0);
    expect(simulation.view('blue').entities.find(entity => entity.id === worker.id)?.visualAction?.kind).toBe('carry');
    let now = 10;
    const metrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(metrics), observerMetrics = new PerformanceDiagnostics(() => now), delivery = new ViewDeliveryDiagnostics(observerMetrics);
    const command = { protocolVersion: 2, matchId: simulation.state.matchId, matchEpoch: simulation.state.matchEpoch, clientCommandId: 'loaded_move', clientSequence: 1,
      command: { kind: 'move', unitIds: [worker.id], queued: false, target: { xMm: worker.xMm + 2000, zMm: worker.zMm } } };
    delivery.commandIssued('blue', command);
    const candidate = movements.candidate('blue', command, simulation.state, 0), receipt = simulation.command('blue', command);
    expect(receipt.status).toBe('accepted'); movements.accepted(candidate, true, true, simulation.state);
    now = 20; movements.observe(simulation.state, [{ id: worker.id, kind: 'carry' }]);
    expect(movements.snapshot().pendingCommands).toBe(1); expect(metrics.snapshot().phases.acceptedToFirstMove).toBeUndefined();
    expect(movements.publication(simulation.view('blue'), simulation.state)).toEqual([]);
    let carried = false;
    for (let tick = 0; tick < 20 && movements.snapshot().pendingCommands; tick++) {
      simulation.step(); now += 50; const actions = simulation.committedUnitActions();
      carried ||= actions.some(action => action.id === worker.id && action.kind === 'carry'); movements.observe(simulation.state, actions);
    }
    expect(carried).toBe(true); expect(movements.snapshot().pendingCommands).toBe(0);
    expect(metrics.snapshot().phases.acceptedToFirstMove?.count).toBe(1); expect(worker.cargo.amount).toBe(1000);
    const view = simulation.view('blue'), certificates = movements.publication(view, simulation.state); expect(certificates).toHaveLength(1);
    now += 17; delivery.observe(view, { matchId: view.matchId, matchEpoch: view.matchEpoch, tick: view.tick, sequence: view.sequence, postedAtMs: now - 10, movements: certificates });
    expect(observerMetrics.snapshot().phases.firstMoveToDeliveredMove?.meanMs).toBe(17); expect(observerMetrics.snapshot().counts.deliveredMoveCompleted).toBe(1);
    for (const value of [JSON.stringify(view), JSON.stringify(simulation.capture())]) for (const privateField of ['firstMoveAtMs', 'commandIssuedToDeliveredMove', 'moveCertificate']) expect(value).not.toContain(privateField);
    const acceptedRevision=worker.orderRevision;let arrivalCertified=false;
    for(let tick=0;tick<40&&worker.orders.length;tick++){
      simulation.step();now+=50;const current=simulation.view('blue'),proof=movements.publication(current,simulation.state);
      if(worker.orderRevision===acceptedRevision&&Math.hypot(worker.xMm-command.command.target.xMm,worker.zMm-command.command.target.zMm)<=100){expect(proof).toHaveLength(1);arrivalCertified=true;}
      if(worker.orderRevision!==acceptedRevision)expect(proof).toEqual([]);
      movements.observe(simulation.state,simulation.committedUnitActions());
    }
    expect(arrivalCertified).toBe(true);expect(worker.orders).toHaveLength(0);expect(worker.orderRevision).toBeGreaterThan(acceptedRevision!);
    expect(simulation.view('blue').entities.find(entity=>entity.id===worker.id)?.visualAction?.kind).toBe('carry');expect(movements.publication(simulation.view('blue'),simulation.state)).toEqual([]);
    simulation.state.entities.automatic_resource={id:'automatic_resource',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:worker.xMm+6000,zMm:worker.zMm,hp:1,maxHp:1,amount:100000};simulation.state.navigationRevision++;worker.stance='defensive';worker.autoGather=true;
    let automaticMotion=false;
    for(let tick=0;tick<80&&!automaticMotion;tick++){
      simulation.step();now+=50;const actions=simulation.committedUnitActions();automaticMotion=actions.some(action=>action.id===worker.id&&(action.kind==='move'||action.kind==='carry'));
      expect(movements.publication(simulation.view('blue'),simulation.state)).toEqual([]);movements.observe(simulation.state,actions);
    }
    expect(automaticMotion).toBe(true);expect(worker.orderRevision).toBeGreaterThan(acceptedRevision!);expect(observerMetrics.snapshot().counts.deliveredMoveCompleted).toBe(1);
  });

  it('counts supersession, boundary changes, expiry and overflow rather than presenting them as successful latency', () => {
    let now = 0;
    const metrics = new PerformanceDiagnostics(() => now), movements = new MovementDiagnostics(metrics), state = fixture();
    const track = () => movements.accepted(movements.candidate('blue', envelope, state, 0), true, true, state);
    track(); state.entities.own_worker.orderRevision++; movements.observe(state, []);
    track(); state.matchEpoch++; movements.observe(state, []);
    track(); state.matchId = 'match_b'; movements.observe(state, []);
    track(); now = 10001; movements.observe(state, []);
    for (let index = 0; index < 65; index++) track();
    expect(movements.snapshot().pendingCommands).toBe(64);
    expect(metrics.snapshot().counts).toMatchObject({ moveProbeSuperseded: 1, moveProbeBoundaryCensored: 2, moveProbeExpired: 1, moveProbeOverflow: 1 });
    state.status = 'PAUSED'; movements.observe(state, []);
    expect(movements.snapshot().pendingCommands).toBe(0);
    expect(metrics.snapshot().phases.acceptedToFirstMove).toBeUndefined();
  });
});

describe('private per-unit command action coverage', () => {
  function setup(kind: 'move' | 'gather' = 'move') {
    let now = 0;
    const coverage = new ActionCoverageDiagnostics(() => now);
    const make = (id: string) => ({ id, kind: 'unit', typeId: 'villager', ownerId: 'blue', hp: 35, xMm: 100, zMm: 200,
      orderRevision: 1 as number | undefined, orders: [{ kind, ...(kind === 'gather' ? { targetId: 'known_gold' } : {}) }], path: [{ xMm: 300, zMm: 200 }] });
    const state = { matchId: 'coverage_match', matchEpoch: 1, tick: 0, status: 'RUNNING', entities: { a: make('a'), b: make('b') } };
    const envelope = { clientCommandId: 'group_1', clientSequence: 1, command: { kind, unitIds: ['a', 'b'], queued: false, ...(kind === 'gather' ? { targetId: 'known_gold' } : {}) } };
    const accept = () => { const candidate = coverage.candidate('blue', envelope, state, -5); now = 5; coverage.accepted(candidate, true, true, state); };
    return { coverage, state, envelope, accept, at: (value: number) => { now = value; } };
  }

  it('distinguishes first unit motion from full group motion, including already-moving units', () => {
    const { coverage, state, accept, at } = setup();
    accept(); const before = JSON.stringify(state);
    coverage.observe(state, [{ id: 'a', kind: 'move' }]); // committed label alone is insufficient
    expect(coverage.snapshot().counts.movedUnits).toBe(0); expect(JSON.stringify(state)).toBe(before);
    at(15); state.tick++; state.entities.a.xMm += 10; coverage.observe(state, [{ id: 'a', kind: 'move' }]);
    let report = coverage.snapshot();
    expect(report).toMatchObject({ pendingCommands: 1, pendingUnits: 1, counts: { acceptedCommands: 1, acceptedUnits: 2, movedUnits: 1, fullyActedCommands: 0 } });
    expect(report.latencies.move!.acceptedToFirstMovement!.meanMs).toBe(10);
    expect(report.latencies.move!.acceptedToAllMovement!.count).toBe(0);
    at(25); state.tick++; state.entities.b.zMm += 10; coverage.observe(state, [{ id: 'b', kind: 'carry' }]);
    report = coverage.snapshot();
    expect(report).toMatchObject({ pendingCommands: 0, counts: { fullyActedCommands: 1, trackedUnits: 2, movedUnits: 2, workedUnits: 0 } });
    expect(report.latencies.move!.acceptedToAllMovement!.meanMs).toBe(20);
    expect(report.latencies.move!.queueToAdmission!.meanMs).toBe(5); expect(report.latencies.move!.admission!.meanMs).toBe(5);
    expect(report.completed[0]!.units.map(unit => unit.outcome)).toEqual(['acted', 'acted']);
    report.completed[0]!.units[0]!.revision = 999;
    expect(coverage.snapshot().completed[0]!.units[0]!.revision).toBe(1);
  });

  it.each(['gather_food', 'gather_wood', 'mine'])('separates gathering movement from actual %s work and counts stationary workers', action => {
    const { coverage, state, accept, at } = setup('gather'); accept();
    at(15); state.tick++; state.entities.b.xMm += 10;
    coverage.observe(state, [{ id: 'a', kind: action }, { id: 'b', kind: 'carry' }]);
    let report = coverage.snapshot();
    expect(report).toMatchObject({ pendingUnits: 1, counts: { workedUnits: 1, movedUnits: 1, fullyActedCommands: 0 } });
    expect(report.latencies.gather!.acceptedToFirstWork!.meanMs).toBe(10);
    expect(report.latencies.gather!.acceptedToAllWork!.count).toBe(0);
    at(35); state.tick++; coverage.observe(state, [{ id: 'b', kind: action }]); report = coverage.snapshot();
    expect(report).toMatchObject({ pendingUnits: 0, counts: { workedUnits: 2, movedUnits: 1, fullyActedCommands: 1 } });
    expect(report.latencies.gather!.acceptedToAllWork!.meanMs).toBe(30);
    expect(report.latencies.gather!.acceptedToAllMovement!.count).toBe(0);
  });

  it('retains partial group results with expiry rather than calling pending requests unreachable', () => {
    const { coverage, state, accept, at } = setup('gather'); accept();
    at(25); state.tick++; coverage.observe(state, [{ id: 'a', kind: 'mine' }]);
    at(10005); state.tick++; coverage.observe(state, []);
    expect(coverage.snapshot().pendingUnits).toBe(1); // exact timeout boundary remains eligible
    at(10006); state.tick++; coverage.observe(state, []);
    const report = coverage.snapshot();
    expect(report.counts).toMatchObject({ fullyActedCommands: 0, partiallyActedCommands: 1, workedUnits: 1, expiredUnits: 1 });
    expect(report.completed[0]!.units.map(unit => unit.outcome)).toEqual(['acted', 'expired']);
    expect(report.latencies.gather!.acceptedToAllWork!.count).toBe(0);
    expect(report.counts).not.toHaveProperty('unreachable'); expect(report.counts).not.toHaveProperty('blocked');
  });

  it.each(['revision', 'order', 'death', 'owner', 'epoch', 'match', 'pause', 'reset'] as const)('censors unfinished group members on %s', reason => {
    const { coverage, state, accept } = setup('gather'); accept();
    if (reason === 'revision') state.entities.a.orderRevision = 2;
    if (reason === 'order') state.entities.a.orders = [];
    if (reason === 'death') state.entities.a.hp = 0;
    if (reason === 'owner') state.entities.a.ownerId = 'red';
    if (reason === 'epoch') state.matchEpoch++;
    if (reason === 'match') state.matchId = 'replacement';
    if (reason === 'pause') state.status = 'PAUSED';
    if (reason === 'reset') coverage.reset(); else coverage.observe(state, [{ id: 'a', kind: 'mine' }]);
    const report = coverage.snapshot();
    expect(report.counts.workedUnits).toBe(0);
    if (reason === 'revision') expect(report.counts.revisionCensoredUnits).toBe(1);
    else if (['order', 'death', 'owner'].includes(reason)) expect(report.counts.canceledUnits).toBe(1);
    else expect(report.counts.boundaryCensoredUnits).toBe(2);
  });

  it('reports rejected, duplicate, failed, invalid and ineligible attempts explicitly', () => {
    const { coverage, state, envelope } = setup('gather'); state.entities.b.typeId = 'militia';
    const first = coverage.candidate('blue', envelope, state, 0); coverage.accepted(first, true, false, state);
    const duplicate = coverage.candidate('blue', envelope, state, 0); coverage.accepted(duplicate, false, true, state);
    coverage.admissionFailed(coverage.candidate('blue', envelope, state, 0));
    expect(coverage.candidate('blue', { ...envelope, command: { ...envelope.command, queued: true } }, state, 0)).toBeUndefined();
    expect(coverage.candidate('blue', { ...envelope, command: { ...envelope.command, unitIds: ['a', 'a'] } }, state, 0)).toBeUndefined();
    const report = coverage.snapshot();
    expect(report.counts).toMatchObject({ submittedCommands: 5, eligibleCommands: 3, eligibleUnits: 3, ineligibleUnits: 3,
      rejectedCommands: 1, duplicateCommands: 1, failedAdmissionCommands: 1, queuedOrUnsupportedCommands: 1, invalidEnvelopes: 1, acceptedCommands: 0 });
    expect(report.pendingCommands).toBe(0);
  });

  it('does not claim full coverage when accepted eligible units lack a usable revision', () => {
    const { coverage, state, envelope, at } = setup('gather');
    const candidate = coverage.candidate('blue', envelope, state, 0); state.entities.b.orderRevision = undefined;
    coverage.accepted(candidate, true, true, state); at(20); state.tick++; coverage.observe(state, [{ id: 'a', kind: 'mine' }]);
    const report = coverage.snapshot();
    expect(report.counts).toMatchObject({ acceptedUnits: 2, trackedUnits: 1, untrackableAcceptedUnits: 1, fullyActedCommands: 0, partiallyActedCommands: 1 });
    expect(report.completed[0]).toMatchObject({ eligibleUnits: 2, trackedUnits: 1, workedUnits: 1 });
    expect(report.latencies.gather!.acceptedToAllWork!.count).toBe(0);
  });

  it('bounds pending and retained completed groups and reports overflow and eviction', () => {
    const { coverage, state, envelope } = setup('gather');
    const submit = (sequence: number) => coverage.accepted(coverage.candidate('blue', { ...envelope, clientCommandId: `group_${sequence}`, clientSequence: sequence }, state, 0), true, true, state);
    for (let index = 1; index <= 65; index++) submit(index);
    expect(coverage.snapshot()).toMatchObject({ pendingCommands: 64, counts: { trackedCommands: 64, overflowCommands: 1, overflowUnits: 2 } });
    coverage.reset(); expect(coverage.snapshot().completed).toHaveLength(64);
    submit(66); coverage.reset();
    expect(coverage.snapshot()).toMatchObject({ completedEvicted: 1, counts: { boundaryCensoredUnits: 130 } });
    expect(coverage.snapshot().completed).toHaveLength(64);
  });
});


describe('production worker simulation stage wrappers', () => {
  it('separates awaited worker batches from preparation and commit without overlapping exclusive totals', async () => {
    let now = 0, fail = false;
    const failure = new Error('original-worker-failure'), state = { tick: 8, matchEpoch: 3 };
    const target: Record<string, unknown> = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, () => undefined]));
    const call = (name: string) => (target[name] as () => unknown)();
    target.prepareMovement = () => { now += 3; }; target.planningGeometries = () => { now += 2; };
    target.advanceMovement = () => { now += 5; }; target.prepareVision = () => { now += 2; };
    target.commitVision = () => { now += 3; };
    const scheduler = { async advanceAsync() { now += 4; await Promise.resolve(); now += 6; if (fail) throw failure; return 17; } };
    target.pathScheduler = scheduler;
    target.advanceMovementAsync = async () => { call('prepareMovement'); call('planningGeometries'); const result = await scheduler.advanceAsync(); now++; call('advanceMovement'); return result; };
    target.visionExecutor = async () => { now++; await Promise.resolve(); now += 9; return 23; };
    const before = Object.getOwnPropertyDescriptors(target), originalAdvance = scheduler.advanceAsync;
    const profiler = new WorkerSimulationStageDiagnostics(() => now), callbacks = new WorkerCallbackDiagnostics(() => now);
    profiler.install(target); profiler.beginCallback();
    const callback = callbacks.begin('timer');
    await callback.measureAsync('coreStep', () => profiler.stepAsync(state, async () => {
      now += 2; expect(await call('advanceMovementAsync')).toBe(17);
      call('prepareVision'); expect(await call('visionExecutor')).toBe(23); call('commitVision'); now += 2; state.tick++;
    }));
    const report = profiler.finishCallback(callbacks.finish(callback));
    expect(report.coreEnvelopeResidualMs).toBe(0);
    expect(report.steps[0]).toMatchObject({ totalMs: 40, accountedMs: 40, remainderMs: 0, metrics: {
      advanceMovementAsync: { calls: 1, inclusiveMs: 21, exclusiveMs: 1 },
      prepareMovement: { exclusiveMs: 3 }, planningGeometries: { exclusiveMs: 2 }, planningBatch: { inclusiveMs: 10, exclusiveMs: 10 },
      advanceMovement: { exclusiveMs: 5 }, prepareVision: { exclusiveMs: 2 }, visionBatch: { inclusiveMs: 10, exclusiveMs: 10 }, commitVision: { exclusiveMs: 3 }, unattributed: { exclusiveMs: 4 },
    } });
    fail = true; profiler.beginCallback();
    await expect(profiler.stepAsync(state, async () => call('advanceMovementAsync'))).rejects.toBe(failure);
    const failed = profiler.finishCallback(callbacks.begin('timer').finish()).steps[0]!;
    expect(failed).toMatchObject({ totalMs: 15, accountedMs: 15, remainderMs: 0, metrics: { planningBatch: { failures: 1, exclusiveMs: 10 }, advanceMovementAsync: { failures: 1 }, advanceMovement: { calls: 0 } } });
    expect(JSON.stringify(failed)).not.toContain(failure.message);
    profiler.restore(); expect(Object.getOwnPropertyDescriptors(target)).toEqual(before); expect(scheduler.advanceAsync).toBe(originalAdvance);
  });

  it.each([false,true])('registers only an owned canonical planning refresh and disposes before restoring it (custom original: %s)',custom=>{
    const sim=createSimulation({seed:'owned-refresh-diagnostic',matchId:'owned_refresh_diagnostic',controllers:false,
      factions:[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]}),target=sim as unknown as Record<string,unknown>;
    const canonical=target.refreshPlanningNav as (...args:unknown[])=>unknown;
    if(custom)target.refreshPlanningNav=function(this:unknown,...args:unknown[]){return canonical.apply(this,args);};
    const original=target.refreshPlanningNav,register=target.registerPlanningRefreshDiagnostic as (original:unknown,wrapper:unknown)=>(()=>void)|undefined;
    const calls:{original:unknown;wrapper:unknown;accepted:boolean}[]=[];let disposed=0;
    target.registerPlanningRefreshDiagnostic=function(this:typeof target,reader:unknown,wrapper:unknown){
      expect(this).toBe(target);expect(this.refreshPlanningNav).toBe(wrapper);
      const release=register.call(this,reader,wrapper);calls.push({original:reader,wrapper,accepted:typeof release==='function'});
      return release?()=>{expect(target.refreshPlanningNav).toBe(wrapper);disposed++;release();}:undefined;
    };
    const before=sim.capture(),profiler=new WorkerSimulationStageDiagnostics(()=>0);
    try{
      profiler.install(target);
      expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({original,accepted:!custom});
      expect(target.refreshPlanningNav).toBe(calls[0]!.wrapper);expect(target.refreshPlanningNav).not.toBe(original);
      expect(sim.capture()).toEqual(before);
      profiler.restore();profiler.restore();
      expect(disposed).toBe(custom?0:1);expect(target.refreshPlanningNav).toBe(original);
      expect(sim.capture()).toEqual(before);
    }finally{profiler.restore();delete target.registerPlanningRefreshDiagnostic;if(custom)delete target.refreshPlanningNav;}
  });

  it.each([undefined,'advanceTransitions','advanceGates'] as const)('registers only the two canonical gate-phase timing wrappers (custom original: %s)',custom=>{
    type GateStage='advanceTransitions'|'advanceGates';
    const sim=createSimulation({seed:'owned-gate-diagnostic',matchId:'owned_gate_diagnostic',controllers:false,
      factions:[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]}),target=sim as unknown as Record<string,unknown>;
    const canonical={advanceTransitions:target.advanceTransitions,advanceGates:target.advanceGates};
    if(custom){const original=canonical[custom] as (...args:unknown[])=>unknown;target[custom]=function(this:unknown,...args:unknown[]){return original.apply(this,args);};}
    const originals={advanceTransitions:target.advanceTransitions,advanceGates:target.advanceGates};
    const register=target.registerGatePhaseDiagnostic as (stage:GateStage,original:unknown,wrapper:unknown)=>(()=>void)|undefined;
    const calls:{stage:GateStage;original:unknown;wrapper:unknown;accepted:boolean}[]=[],disposed:GateStage[]=[];
    target.registerGatePhaseDiagnostic=function(this:typeof target,stage:GateStage,original:unknown,wrapper:unknown){
      expect(this).toBe(target);expect(this[stage]).toBe(wrapper);
      const release=register.call(this,stage,original,wrapper);calls.push({stage,original,wrapper,accepted:typeof release==='function'});
      return release?()=>{expect(target[stage]).toBe(wrapper);disposed.push(stage);release();}:undefined;
    };
    const before=sim.capture(),profiler=new WorkerSimulationStageDiagnostics(()=>0);
    try{
      profiler.install(target);
      expect(calls.map(call=>call.stage)).toEqual(['advanceTransitions','advanceGates']);
      for(const call of calls){expect(call.original).toBe(originals[call.stage]);expect(call.accepted).toBe(call.stage!==custom);expect(target[call.stage]).toBe(call.wrapper);}
      expect(sim.capture()).toEqual(before);
      profiler.restore();profiler.restore();
      expect(disposed).toEqual(calls.filter(call=>call.accepted).reverse().map(call=>call.stage));
      expect(target.advanceTransitions).toBe(originals.advanceTransitions);expect(target.advanceGates).toBe(originals.advanceGates);
      expect(sim.capture()).toEqual(before);
    }finally{profiler.restore();delete target.registerGatePhaseDiagnostic;target.advanceTransitions=canonical.advanceTransitions;target.advanceGates=canonical.advanceGates;}
  });

  it('preserves actual asynchronous vision, actions and capture with phase wrappers enabled', async () => {
    const options = { seed: 'async-stage-transparency', matchId: 'async_stage_transparency', sharedVision: false, controllers: false,
      factions: [{ id: 'blue', name: 'Blue', teamId: 'blue', kind: 'human' as const, color: '#3388ff' }, { id: 'red', name: 'Red', teamId: 'red', kind: 'human' as const, color: '#ee5533' }] };
    const reference = createSimulation(options), observed = createSimulation(options), kernel = new VisionMaskKernel();
    observed.attachVisionExecutor(async frame => { await Promise.resolve(); return kernel.compute(frame); });
    let time = 0; const profiler = new WorkerSimulationStageDiagnostics(() => ++time), callbacks = new WorkerCallbackDiagnostics(() => ++time);
    profiler.install(observed as unknown as Record<string, unknown>);
    try {
      for (let tick = 0; tick < 24; tick++) {
        reference.step(); profiler.beginCallback(); const span = callbacks.begin('timer');
        await span.measureAsync('coreStep', () => profiler.stepAsync(observed.state, () => observed.stepAsync()));
        const row = profiler.finishCallback(callbacks.finish(span)).steps[0]!;
        expect(row.accountedMs).toBe(row.totalMs); expect(row.remainderMs).toBe(0);
        expect(row.metrics.visionBatch.calls).toBeGreaterThan(0); expect(row.metrics.prepareVision.calls).toBeGreaterThan(0); expect(row.metrics.commitVision.calls).toBeGreaterThan(0);
        expect(observed.capture()).toEqual(reference.capture()); expect(observed.views(['blue', 'red'])).toEqual(reference.views(['blue', 'red']));
        expect(observed.committedUnitActions()).toEqual(reference.committedUnitActions()); expect(observed.drainJournal()).toEqual(reference.drainJournal());
      }
    } finally { profiler.restore(); }
  });

  it.each(['nonfinite', 'backward', 'throwing', 'invalid-start'] as const)('keeps gameplay results and exceptions intact with a %s diagnostic clock', condition => {
    let reads = 0, calls = 0;
    const clockFailure = new Error('private-clock-failure'), gameFailure = new Error('original-game-failure');
    const profiler = new WorkerSimulationStageDiagnostics(() => {
      if (++reads === 1 && condition !== 'invalid-start') return 10;
      if (condition === 'throwing' || condition === 'invalid-start') throw clockFailure;
      return condition === 'backward' ? 9 : NaN;
    });
    const target = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, () => { calls++; return 17; }])) as Record<string, () => number>;
    target.command = () => { calls++; throw gameFailure; };
    const state = { tick: 4, matchEpoch: 2 }; profiler.install(target); profiler.beginCallback();
    expect(reads).toBe(0); expect(target.advanceGates!()).toBe(17); expect(reads).toBe(0);
    expect(profiler.step(state, () => { state.tick++; return target.advanceWork!(); })).toBe(17);
    const invalid = condition === 'invalid-start' ? 4 : 3;
    reads = 0;
    try { profiler.externalAdmission(state, () => target.command!()); throw new Error('original exception was swallowed'); }
    catch (error) { expect(error).toBe(gameFailure); }
    const accounting = new WorkerCallbackDiagnostics(() => 0).begin('timer').finish(), report = profiler.finishCallback(accounting);
    expect(report.steps[0]).toMatchObject({ startTick: 4, endTick: 5, totalMs: 0, accountedMs: 0, remainderMs: 0, invalidClockSamples: invalid });
    expect(report.externalAdmission).toMatchObject({ calls: 1, totalMs: 0, invalidClockSamples: invalid, metrics: { command: { calls: 1, failures: 1, inclusiveMs: 0, exclusiveMs: 0 } } });
    expect(calls).toBe(3); expect(JSON.stringify(report)).not.toContain('private-clock-failure'); profiler.restore();
  });

  it('recovers a monotonic ledger after invalid and backward samples', () => {
    const samples = [10, 9, Infinity, 12], profiler = new WorkerSimulationStageDiagnostics(() => samples.shift()!);
    const target = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, () => undefined])) as Record<string, () => void>;
    profiler.install(target); profiler.beginCallback(); profiler.step({ tick: 1, matchEpoch: 1 }, () => target.advanceCombat!());
    const report = profiler.finishCallback(new WorkerCallbackDiagnostics(() => 0).begin('timer').finish());
    expect(report.steps[0]).toMatchObject({ totalMs: 2, accountedMs: 2, remainderMs: 0, invalidClockSamples: 2, metrics: { advanceCombat: { calls: 1, exclusiveMs: 0 }, unattributed: { exclusiveMs: 2 } } });
    expect(samples).toEqual([]); profiler.restore();
  });

  it('rolls back a failed install including imported own-method descriptors and can be installed again', () => {
    let reads = 0; const profiler = new WorkerSimulationStageDiagnostics(() => ++reads);
    const make = () => Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, function(this: { marker?: object }, argument: object) { expect(this.marker).toBe(argument); return argument; }])) as Record<string, unknown>;
    const previous = make(), broken = make(), restored = make(), marker = {}; restored.marker = marker;
    Object.defineProperty(broken, 'advanceCombat', { value: broken.advanceCombat, configurable: false, writable: false, enumerable: false });
    const beforePrevious = Object.getOwnPropertyDescriptors(previous), beforeBroken = Object.getOwnPropertyDescriptors(broken), beforeRestored = Object.getOwnPropertyDescriptors(restored);
    profiler.install(previous); expect(() => profiler.install(broken)).toThrow();
    expect(Object.getOwnPropertyDescriptors(previous)).toEqual(beforePrevious); expect(Object.getOwnPropertyDescriptors(broken)).toEqual(beforeBroken); expect(reads).toBe(0);
    profiler.install(restored); profiler.beginCallback();
    for (const stage of ['advanceTransitions', 'advanceGates', 'updateEngagements', 'advanceGarrisons', 'advanceCombat'] as const)
      expect(profiler.step({ tick: 1, matchEpoch: 1 }, () => (restored[stage] as (argument: object) => object).call(restored, marker))).toBe(marker);
    profiler.restore(); profiler.restore(); expect(Object.getOwnPropertyDescriptors(restored)).toEqual(beforeRestored);
  });

  it('preserves actual commands, state, actions, views and journals across cold reconstruction with all imported phases active', () => {
    const factions: PublicPlayer[] = [{ id: 'blue', name: 'Blue', teamId: 'blue', kind: 'human', color: '#3388ff' }, { id: 'red', name: 'Red', teamId: 'red', kind: 'human', color: '#ee5533' }];
    // One test identity deliberately compares observer on/off within this source build, not save migration.
    const identity: EngineIdentity = { engineBuildHash: '6'.repeat(64), runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch } };
    let reference = createSimulation({ factions, seed: 'stage-transparency', matchId: 'stage_transparency', sharedVision: false });
    reference.state.entities = {}; reference.state.map.terrain = []; reference.state.navigationRevision++;
    for (const vision of Object.values(reference.state.vision)) { vision.memory = {}; vision.explored = []; }
    reference.state.economies.blue!.age = 4; reference.state.economies.blue!.resources = { food: 1000000, wood: 1000000, gold: 1000000, stone: 1000000 };
    const structure = (id: string, typeId: BuildingId, xMm: number, zMm: number, ownerId = 'blue'): Building => {
      const definition = buildings[typeId], building: Building = { id, typeId, ownerId, kind: 'building', xMm, zMm, rotation: 0, hp: definition.maxHp, maxHp: definition.maxHp, grantedHp: definition.maxHp, work: definition.buildSeconds * balance.rules.simulationHz * 100, required: definition.buildSeconds * balance.rules.simulationHz * 100, queue: [], cooldown: 0 };
      reference.state.entities[id] = building; return building;
    };
    const unit = (id: string, typeId: UnitId, xMm: number, zMm: number, ownerId = 'blue'): Unit => {
      const entity: Unit = { id, typeId, ownerId, kind: 'unit', xMm, zMm, hp: units[typeId].maxHp, maxHp: units[typeId].maxHp, orders: [], path: [], pathRevision: 0, orderRevision: 0, repathAtTick: 0, cargo: { resource: null, amount: 0 }, gatherRemainder: 0, cooldown: 0, stance: 'stand_ground', ...(typeId === 'trebuchet' ? { deploymentState: 'packed' as const } : {}) };
      reference.state.entities[id] = entity; return entity;
    };
    structure('home', 'town_center', 30000, 30000); structure('enemy_home', 'town_center', 300000, 300000, 'red');
    const gate = structure('gate', 'wooden_gate', 66000, 30000); gate.gateMode = 'LOCKED'; gate.gateOpen = false;
    unit('scout', 'scout', 65000, 34000); unit('patient', 'villager', 23000, 30000).hp = 20;
    const house = structure('house', 'house', 40000, 46000); house.hp -= 100; unit('repairer', 'villager', 37000, 46000);
    unit('mover', 'villager', 110000, 110000); unit('mover_two', 'villager', 110000, 112000); unit('archer', 'archer', 60000, 66000); unit('victim', 'knight', 65000, 66000, 'red').cooldown = 10000; unit('trebuchet', 'trebuchet', 85000, 66000);
    reference.step(); // Constructor/fixture setup is outside the production observer's live scope.
    let observed = restoreSimulation(exportSimulationSave(reference, identity), identity, { preserveEpoch: true });
    let now = 0; const profiler = new WorkerSimulationStageDiagnostics(() => ++now), callbacks = new WorkerCallbackDiagnostics(() => ++now);
    const counts = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, 0])) as Record<typeof WORKER_SIMULATION_STAGES[number], number>;
    const account = (ledger: ReturnType<WorkerSimulationStageDiagnostics['finishCallback']>) => {
      for (const slice of [...ledger.steps, ...(ledger.externalAdmission ? [ledger.externalAdmission] : [])]) for (const stage of WORKER_SIMULATION_STAGES) counts[stage] += slice.metrics[stage].calls;
      for (const slice of ledger.steps) { expect(slice.remainderMs).toBe(0); expect(slice.invalidClockSamples).toBe(0); }
    };
    const compare = () => {
      expect(observed.state).toEqual(reference.state); expect(JSON.stringify(observed.capture())).toBe(JSON.stringify(reference.capture()));
      expect(observed.committedUnitActions()).toEqual(reference.committedUnitActions()); expect(observed.views(['blue', 'red'])).toEqual(reference.views(['blue', 'red'])); expect(observed.journalEvents()).toEqual(reference.journalEvents());
    };
    const admit = (command: GameplayCommand) => {
      const sequence = reference.state.economies.blue!.lastClientSequence + 1;
      const envelope = { protocolVersion: 2, matchId: reference.state.matchId, matchEpoch: reference.state.matchEpoch, clientCommandId: `stage_${sequence}`, clientSequence: sequence, command };
      const expected = reference.command('blue', envelope); profiler.beginCallback(); const span = callbacks.begin('timer');
      const actual = span.measure('commandDrain', () => profiler.externalAdmission(observed.state, () => observed.command('blue', envelope)));
      account(profiler.finishCallback(callbacks.finish(span))); expect(actual).toEqual(expected); return actual;
    };
    // A cold restore intentionally has no previous tick's transient committed-action map.
    reference = restoreSimulation(exportSimulationSave(reference, identity), identity, { preserveEpoch: true });
    const install = () => { const before = JSON.stringify(observed.capture()); profiler.install(observed as unknown as Record<string, unknown>); expect(JSON.stringify(observed.capture())).toBe(before); };
    install(); compare();
    try {
      for (const command of [
        { kind: 'set_gate_mode', gateId: 'gate', mode: 'AUTO' }, { kind: 'garrison', unitIds: ['patient'], targetId: 'home', queued: false },
        { kind: 'repair', unitIds: ['repairer'], targetId: 'house', queued: false }, { kind: 'deploy', unitIds: ['trebuchet'] },
        { kind: 'train', buildingId: 'home', unitType: 'villager', quantity: 1 }, { kind: 'move', unitIds: ['mover', 'mover_two'], target: { xMm: 114000, zMm: 110000 }, queued: false },
      ] satisfies GameplayCommand[]) expect(admit(command).status).toBe('accepted');
      expect(admit({ kind: 'move', unitIds: ['victim'], target: { xMm: 70000, zMm: 66000 }, queued: false }).status).toBe('rejected');
      compare();
      for (let index = 0; index < 48; index++) {
        const revision = observed.state.navigationRevision; reference.step(); profiler.beginCallback(); const span = callbacks.begin('timer');
        span.measure('coreStep', () => profiler.step(observed.state, () => observed.step())); account(profiler.finishCallback(callbacks.finish(span))); compare();
        if (index === 0) { expect((observed.state.entities.gate as Building).gateOpen).toBe(true); expect(observed.state.navigationRevision).toBe(revision + 1); }
        if (index === 23) {
          expect(observed.drainJournal()).toEqual(reference.drainJournal());
          const old = observed, originalCommand = Object.getPrototypeOf(old).command;
          reference = restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(reference, identity))), identity, { preserveEpoch: true });
          observed = restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(observed, identity))), identity, { preserveEpoch: true });
          install(); expect(old.command).toBe(originalCommand); compare();
          expect(admit({ kind: 'set_gate_mode', gateId: 'gate', mode: 'OPEN' }).status).toBe('accepted');
        }
      }
      // Planning transfer descriptors are used only by the async executor; its
      // preparation/await/commit accounting is covered separately above.
      for (const stage of WORKER_SIMULATION_STAGES) if (stage !== 'planningGeometries') expect(counts[stage], stage).toBeGreaterThan(0);
      expect((observed.state.entities.patient as Unit).garrisonedIn).toBe('home'); expect((observed.state.entities.patient as Unit).hp).toBeGreaterThan(20);
      expect((observed.state.entities.house as Building).hp).toBeGreaterThan(house.hp); expect((observed.state.entities.victim as Unit).hp).toBeLessThan(units.knight.maxHp);
      const serialized = JSON.stringify([observed.capture(), observed.views(['blue', 'red']), observed.journalEvents()]);
      for (const field of ['simulationStages', 'exclusiveMs', 'invalidClockSamples']) expect(serialized).not.toContain(field);
    } finally { profiler.restore(); }
    compare(); expect(Object.hasOwn(observed, 'command')).toBe(false);
  });

  it('separates external admission and nested controller work with exact per-step ledgers', () => {
    let now = 0; const state = { tick: 59, matchEpoch: 3, status: 'RUNNING' };
    const profiler = new WorkerSimulationStageDiagnostics(() => now), callbacks = new WorkerCallbackDiagnostics(() => now), history = new WorkerOverloadDiagnostics(() => now);
    const target: Record<string, (...args: unknown[]) => unknown> = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, () => { now++; }]));
    target.refreshPlanningNav = () => { now += 3; }; target.formationTargets = () => { now += 5; return 17; };
    target.command = function(this: typeof target) { now += 2; this.refreshPlanningNav!(); return this.formationTargets!(); };
    target.advanceControllers = function(this: typeof target) { now += 7; this.command!(); };
    const original = target.command; profiler.install(target); profiler.beginCallback();
    const accountingSpan = callbacks.begin('timer'), event = history.begin('timer', state, 0, accountingSpan.startedAtMs);
    accountingSpan.measure('commandDrain', () => { expect(profiler.externalAdmission(state, () => target.command!())).toBe(17); });
    accountingSpan.measure('coreStep', () => profiler.step(state, () => { state.tick++; target.advanceControllers!(); now += 11; }));
    const accounting = callbacks.finish(accountingSpan); accounting.simulationStages = profiler.finishCallback(accounting);
    expect(accounting.simulationStages.externalAdmission).toMatchObject({ calls: 1, totalMs: 10, metrics: { command: { calls: 1, inclusiveMs: 10, exclusiveMs: 2 }, refreshPlanningNav: { exclusiveMs: 3 }, formationTargets: { exclusiveMs: 5 } } });
    expect(accounting.simulationStages.steps[0]).toMatchObject({ startTick: 59, endTick: 60, epoch: 3, totalMs: 28, accountedMs: 28, remainderMs: 0, metrics: { advanceControllers: { inclusiveMs: 17, exclusiveMs: 7 }, command: { inclusiveMs: 10, exclusiveMs: 2 }, refreshPlanningNav: { exclusiveMs: 3 }, formationTargets: { exclusiveMs: 5 }, unattributed: { exclusiveMs: 11 } } });
    expect(accounting.simulationStages).toMatchObject({ coreEnvelopeResidualMs: 0, commandDrainResidualMs: 0 });
    history.finish(event, state, [28], accounting);
    for (let i = 0; i < 300; i++) { const queued = history.begin('command', state); now++; history.finish(queued, state); }
    const trigger = history.begin('timer', state, 2200); history.captureOverload(trigger);
    const report = history.snapshot(); expect(report.lastOverload!.precedingAdvancingEvents[0]!.accounting!.simulationStages!.steps[0]!.endTick).toBe(60);
    report.lastOverload!.precedingAdvancingEvents[0]!.accounting!.simulationStages!.steps[0]!.metrics.advanceControllers.exclusiveMs = 999;
    expect(history.snapshot().lastOverload!.precedingAdvancingEvents[0]!.accounting!.simulationStages!.steps[0]!.metrics.advanceControllers.exclusiveMs).toBe(7);
    profiler.restore(); expect(target.command).toBe(original);
  });

  it('restores inherited descriptors, bounds step rows and retains exceptions without retaining arguments', () => {
    let now = 0; const state = { tick: 0, matchEpoch: 1 }, profiler = new WorkerSimulationStageDiagnostics(() => now);
    const prototype = Object.fromEntries(WORKER_SIMULATION_STAGES.map(stage => [stage, function(this: { marker: number }, value?: unknown) { now++; if (value === 'fail') throw new Error('original-failure'); return this.marker; }]));
    const target = Object.assign(Object.create(prototype), { marker: 42 }) as Record<string, (...args: unknown[]) => unknown>;
    profiler.install(target); profiler.beginCallback();
    const span = new WorkerCallbackDiagnostics(() => now).begin('timer');
    for (let i = 0; i < 6; i++) span.measure('coreStep', () => profiler.step(state, () => { state.tick++; expect(target.advanceWork!()).toBe(42); }));
    expect(() => span.measure('commandDrain', () => profiler.externalAdmission(state, () => target.command!('fail')))).toThrow('original-failure');
    const accounting = span.finish(), report = profiler.finishCallback(accounting);
    expect(report).toMatchObject({ coreEnvelopeResidualMs: 0, commandDrainResidualMs: 0 });
    expect(report.steps).toHaveLength(4); expect(report.omittedSteps).toBe(2); expect(report.externalAdmission!.metrics.command.failures).toBe(1);
    expect(JSON.stringify(report)).not.toContain('original-failure'); profiler.restore(); for (const stage of WORKER_SIMULATION_STAGES) expect(Object.hasOwn(target, stage)).toBe(false);
    const saved = target.advanceControllers; Object.defineProperty(target, 'advanceProduction', { configurable: true, get: () => () => undefined });
    expect(() => profiler.install(target)).toThrow('UNKNOWN_PROFILE_STAGE:advanceProduction'); expect(target.advanceControllers).toBe(saved); expect(Object.hasOwn(target, 'advanceControllers')).toBe(false);
  });
});

describe('private controller phase attribution',()=>{
  it('reconciles nested caretaker cloning, preserves exceptions, bounds rows and retains no inputs',()=>{
    let now=0,reads=0;const profiler=new WorkerControllerPhaseDiagnostics(()=>{reads++;return now;});
    expect(profiler.measure('policy',()=>17)).toBe(17);expect(reads).toBe(0);
    const context={playerId:'p0',tick:20,epoch:1,tacticalPulse:true,pendingDue:false,expiredGoal:false};
    const original=new Error('original-policy-error');
    expect(()=>profiler.commander(context,()=>{now+=2;profiler.measure('priorClone',()=>{now+=3;});profiler.measure('policy',()=>{now+=5;profiler.measure('caretakerClone',()=>{now+=7;});now+=11;});profiler.measure('admission',()=>{now+=13;throw original;});})).toThrow(original);
    const report=profiler.snapshot(),row=report.rows[0]!;
    expect(row).toMatchObject({totalMs:41,accountedMs:41,remainderMs:0,failed:true,metrics:{priorClone:{exclusiveMs:3},policy:{inclusiveMs:23,exclusiveMs:16},caretakerClone:{exclusiveMs:7},admission:{exclusiveMs:13,failures:1},unattributed:{exclusiveMs:2}}});
    expect(JSON.stringify(report)).not.toContain('original-policy-error');row.metrics.policy.exclusiveMs=999;expect(profiler.snapshot().rows[0]!.metrics.policy.exclusiveMs).toBe(16);
    for(let index=1;index<CONTROLLER_PROFILE_ROW_LIMIT+3;index++)profiler.commander({...context,tick:20+index},()=>{now++;});
    expect(profiler.snapshot()).toMatchObject({rowLimit:CONTROLLER_PROFILE_ROW_LIMIT,calls:CONTROLLER_PROFILE_ROW_LIMIT+3,omittedRows:3});expect(profiler.snapshot().rows).toHaveLength(CONTROLLER_PROFILE_ROW_LIMIT);
    profiler.reset();expect(profiler.snapshot()).toMatchObject({calls:0,totalMs:0,omittedRows:0,rows:[]});
  });
  it.each(['throwing','backward','nonfinite'] as const)('contains a %s clock without changing the original result',condition=>{
    let reads=0;const profiler=new WorkerControllerPhaseDiagnostics(()=>{if(++reads===1)return 10;if(condition==='throwing')throw new Error('private clock');return condition==='backward'?11-reads:Infinity;});
    const value={},failure=new Error('game failure'),context={playerId:'p0',tick:20,epoch:1,tacticalPulse:true,pendingDue:false,expiredGoal:false};
    expect(profiler.commander(context,()=>profiler.measure('policy',()=>value))).toBe(value);
    expect(()=>profiler.commander(context,()=>profiler.measure('journal',()=>{throw failure;}))).toThrow(failure);
    for(const row of profiler.snapshot().rows){expect(row.totalMs).toBe(0);expect(row.remainderMs).toBe(0);expect(row.invalidClockSamples).toBeGreaterThan(0);}
    for(let index=0;index<CONTROLLER_PROFILE_ROW_LIMIT+1;index++)profiler.commander(context,()=>profiler.measure('policy',()=>value));
    const report=profiler.snapshot();expect(report.omittedRows).toBeGreaterThan(0);expect(report.invalidClockSamples).toBeGreaterThan(report.rows.reduce((sum,row)=>sum+row.invalidClockSamples,0));
  });
  it('observes all five real AI policies including their shared caretaker clone without changing state, views, journals or cold continuation',()=>{
    const factions:PublicPlayer[]=[{id:'human',name:'Human',teamId:'human',kind:'human',color:'#3388ff'},...Array.from({length:5},(_,index)=>({id:'ai'+index,name:'AI '+index,teamId:'team'+index,kind:'ai' as const,difficulty:'medium' as const,personality:'marshal' as const,color:'#ee5533'}))];
    const identity:EngineIdentity={engineBuildHash:'8'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
    const initial=createSimulation({factions,matchId:'controller-profiling',seed:'controller-profiling',sharedVision:false,controllers:true});
    const save=exportSimulationSave(initial,identity);let reference=restoreSimulation(save,identity,{preserveEpoch:true}),observed=restoreSimulation(save,identity,{preserveEpoch:true});
    let reads=0;const profiler=new WorkerSimulationStageDiagnostics(()=>++reads),callbacks=new WorkerCallbackDiagnostics(()=>++reads),rows:ControllerPhaseRow[]=[];
    expect(reads).toBe(0);profiler.install(observed as unknown as Record<string,unknown>);expect(reads).toBe(0);
    for(let tick=1;tick<=45;tick++){
      reference.step();profiler.beginCallback();const span=callbacks.begin('timer');span.measure('coreStep',()=>profiler.step(observed.state,()=>observed.step()));
      const report=profiler.finishCallback(callbacks.finish(span));rows.push(...report.controllerBreakdown.rows);
      for(const row of report.controllerBreakdown.rows){expect(row.remainderMs).toBe(0);expect(row.invalidClockSamples).toBe(0);expect(row.metrics.view.calls).toBe(1);expect(row.metrics.priorClone.calls).toBe(1);}
      expect(observed.state).toEqual(reference.state);expect(JSON.stringify(observed.capture())).toBe(JSON.stringify(reference.capture()));expect(observed.views(factions.map(faction=>faction.id))).toEqual(reference.views(factions.map(faction=>faction.id)));expect(observed.committedUnitActions()).toEqual(reference.committedUnitActions());expect(observed.journalEvents()).toEqual(reference.journalEvents());
      if(tick===20){profiler.restore();reference=restoreSimulation(exportSimulationSave(reference,identity),identity,{preserveEpoch:true});observed=restoreSimulation(exportSimulationSave(observed,identity),identity,{preserveEpoch:true});profiler.install(observed as unknown as Record<string,unknown>);}
    }
    for(const tick of [20,40]){const pulse=rows.filter(row=>row.tick===tick&&row.tacticalPulse);expect(pulse.map(row=>row.playerId)).toEqual(factions.filter(faction=>faction.kind==='ai').map(faction=>faction.id));for(const row of pulse){expect(row.metrics.policy.calls).toBe(1);expect(row.metrics.caretakerClone.calls).toBe(1);expect(row.metrics.memoryRefresh.calls).toBe(1);expect(row.observation!.entityCount).toBeGreaterThan(0);}}
    expect(rows.some(row=>row.pendingDue&&!row.tacticalPulse)).toBe(true);
    expect(JSON.stringify(observed.capture())).not.toContain('controllerBreakdown');expect(JSON.stringify(observed.views(factions.map(faction=>faction.id)))).not.toContain('caretakerClone');
    profiler.restore();const before=reads;observed.step();expect(reads).toBe(before);
  });
});
