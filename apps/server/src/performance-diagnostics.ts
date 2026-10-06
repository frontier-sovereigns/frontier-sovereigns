import type { ControllerProfileContext, ControllerProfilePhase, ControllerProfiler } from '@frontier/simulation';
import type { PlayerView, WorkerCallbackSummary, WorkerRuntimeSummary } from '@frontier/shared';
import { monitorEventLoopDelay, performance, PerformanceObserver } from 'node:perf_hooks';

/** Private, explicitly opt-in instrumentation. Nothing here enters player packets or saves. */
export const PERFORMANCE_SAMPLE_LIMIT = 1200;
export const PERFORMANCE_PHASES = [
  'workerCallback', 'advancingCallback', 'tickDebt', 'commandDrain', 'commandQueue', 'commandAdmission', 'activity',
  'viewConstruction', 'viewPost', 'journal', 'checkpoint', 'viewIpc', 'publication',
  'stringify', 'prepare', 'deltaEncode', 'deltaChunks', 'snapshotChunks', 'sendCallback', 'workerRequestQueue', 'workerRequestRoundTrip',
  'ownedSafetySize', 'ownedSchema', 'ownedConsistency', 'ownedNormalize', 'ownedJsonFallback', 'ownedAuditSerialize', 'preparedAdoption',
  'acceptedToFirstMove', 'queuedToFirstMove', 'viewDeliveryAge', 'viewDeliveryInterval',
  'commandIssuedToDeliveredMove', 'acceptedToDeliveredMove', 'firstMoveToDeliveredMove',
] as const;
export type PerformancePhase = typeof PERFORMANCE_PHASES[number];

/** hrtime uses the same monotonic host clock in the server and its worker threads. */
export const diagnosticNow = (): number => Number(process.hrtime.bigint()) / 1e6;

class Samples {
  private values = new Float64Array(PERFORMANCE_SAMPLE_LIMIT);
  private count = 0;
  private total = 0;
  private maximum = 0;
  private invalid = 0;
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0) { this.invalid++; return; }
    this.values[this.count % PERFORMANCE_SAMPLE_LIMIT] = value;
    this.count++; this.total += value; this.maximum = Math.max(this.maximum, value);
  }
  snapshot() {
    const samples = Math.min(this.count, PERFORMANCE_SAMPLE_LIMIT);
    const sorted = Array.from(this.values.subarray(0, samples)).sort((a, b) => a - b);
    const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(samples * fraction) - 1)] ?? null;
    return { count: this.count, totalMs: this.total, meanMs: this.count ? this.total / this.count : null,
      maxMs: this.count ? this.maximum : null, invalid: this.invalid,
      rolling: { samples, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: sorted.at(-1) ?? null } };
  }
}

export class PerformanceDiagnostics {
  private phases = new Map<PerformancePhase, Samples>();
  private counts = new Map<string, number>();
  constructor(readonly now: () => number = diagnosticNow) {}
  sample(phase: PerformancePhase, durationMs: number): void {
    let samples = this.phases.get(phase);
    if (!samples) { samples = new Samples(); this.phases.set(phase, samples); }
    samples.add(durationMs);
  }
  measure<T>(phase: PerformancePhase, operation: () => T): T {
    const started = this.now();
    try { return operation(); } finally { this.sample(phase, this.now() - started); }
  }
  count(name: string, amount = 1): void {
    // Names are fixed internal call sites; still bound the map if a caller is wrong.
    if (!this.counts.has(name) && this.counts.size >= 64) return;
    if (Number.isSafeInteger(amount) && amount >= 0) this.counts.set(name, Math.min(Number.MAX_SAFE_INTEGER, (this.counts.get(name) ?? 0) + amount));
  }
  snapshot() {
    return { enabled: true as const, timingQualificationEligible: false as const,
      sampleLimitPerPhase: PERFORMANCE_SAMPLE_LIMIT,
      scope: 'Private diagnostic timings; rolling samples are not pooled run percentiles. Nested phases overlap.',
      phases: Object.fromEntries([...this.phases].map(([name, samples]) => [name, samples.snapshot()])),
      counts: Object.fromEntries(this.counts) };
  }
}

const WORKER_HISTORY_LIMIT = 256;
const WORKER_OPERATIONS = new Set(['timer', 'replay-open', 'replay-step', 'init', 'restore', 'capture', 'ai-state', 'ai-prepare', 'ai-complete', 'ai-invalidate', 'ai-chat', 'diagnostics', 'performance-diagnostics', 'subscribe', 'view', 'command', 'status', 'end-draw', 'control-mode', 'surrender', 'projection-credit', 'projection-restart', 'projection-flush', 'publication-request', 'view-credit']);
export const WORKER_CALLBACK_PHASES = ['commandDrain', 'coreStep', 'activityProjection', 'viewAssemblyPost', 'journalCheckpoint', 'other'] as const;
export type WorkerCallbackPhase = typeof WORKER_CALLBACK_PHASES[number];
export interface WorkerCallbackAccounting {
  operation: string; startedAtMs: number; endedAtMs: number; totalMs: number;
  phasesMs: Record<WorkerCallbackPhase, number>; accountedMs: number; remainderMs: number; invalidClockSamples: number;
  simulationStages?: WorkerSimulationCallbackStages;
}

/** One non-reentrant callback, including awaited phases. Child spans replace their parent. */
export class WorkerCallbackSpan {
  readonly phasesMs = Object.fromEntries(WORKER_CALLBACK_PHASES.map(phase => [phase, 0])) as Record<WorkerCallbackPhase, number>;
  private phase: WorkerCallbackPhase = 'other';
  private boundary: number;
  private invalidClockSamples = 0;
  private result?: WorkerCallbackAccounting;
  constructor(readonly operation: string, readonly startedAtMs: number, private readonly now: () => number) { this.boundary = startedAtMs; }
  private transition(next: WorkerCallbackPhase, atMs = this.now()): void {
    const elapsed = atMs - this.boundary;
    if (!Number.isFinite(elapsed) || elapsed < 0) { this.invalidClockSamples++; return; }
    this.phasesMs[this.phase] += elapsed; this.phase = next; this.boundary = atMs;
  }
  measure<T>(phase: WorkerCallbackPhase, operation: () => T): T {
    if (this.result) return operation();
    const previous = this.phase; this.transition(phase);
    try { return operation(); } finally { this.transition(previous); }
  }
  async measureAsync<T>(phase: WorkerCallbackPhase, operation: () => Promise<T>): Promise<T> {
    if (this.result) return operation();
    const previous = this.phase; this.transition(phase);
    try { return await operation(); } finally { this.transition(previous); }
  }
  finish(): WorkerCallbackAccounting {
    if (!this.result) {
      this.transition('other');
      const totalMs = this.boundary - this.startedAtMs, accountedMs = Object.values(this.phasesMs).reduce((sum, value) => sum + value, 0);
      this.result = { operation: this.operation, startedAtMs: this.startedAtMs, endedAtMs: this.boundary, totalMs,
        phasesMs: { ...this.phasesMs }, accountedMs, remainderMs: totalMs - accountedMs, invalidClockSamples: this.invalidClockSamples };
    }
    return { ...this.result, phasesMs: { ...this.result.phasesMs } };
  }
}

/** Cumulative totals plus bounded distributions; the chronological callback records live in overload history. */
export class WorkerCallbackDiagnostics {
  private total = new Samples();
  private phases = new Map(WORKER_CALLBACK_PHASES.map(phase => [phase, new Samples()]));
  private operations = new Map<string, Samples>();
  private invalidClockSamples = 0;
  private absoluteReconciliationErrorMs = 0;
  constructor(private readonly now: () => number = diagnosticNow) {}
  begin(operation: string): WorkerCallbackSpan { return new WorkerCallbackSpan(WORKER_OPERATIONS.has(operation) ? operation : 'unknown', this.now(), this.now); }
  finish(span: WorkerCallbackSpan): WorkerCallbackAccounting {
    const value = span.finish(); this.total.add(value.totalMs);
    for (const phase of WORKER_CALLBACK_PHASES) this.phases.get(phase)!.add(value.phasesMs[phase]);
    let operation = this.operations.get(value.operation);
    if (!operation) { operation = new Samples(); this.operations.set(value.operation, operation); }
    operation.add(value.totalMs); this.invalidClockSamples += value.invalidClockSamples;
    this.absoluteReconciliationErrorMs += Math.abs(value.remainderMs); return value;
  }
  snapshot() {
    return { clock: 'host-monotonic-hrtime-ms', scope: 'Exclusive coordinator callback wall-time phases, including awaited workers, startup and message handlers. Activity/projection contains worker-side activity and movement-certificate maintenance; authoritative vision and action projection inside Simulation.step remain in coreStep. Other includes operation-specific control/AI work and instrumentation. Nested legacy phase timings and GC durations must not be added to these totals. Recording the completed ledger itself occurs after the interval.',
      total: this.total.snapshot(), phases: Object.fromEntries([...this.phases].map(([phase, samples]) => [phase, samples.snapshot()])),
      callbackKinds: Object.fromEntries([...this.operations].map(([operation, samples]) => [operation, samples.snapshot()])),
      invalidClockSamples: this.invalidClockSamples, absoluteReconciliationErrorMs: this.absoluteReconciliationErrorMs };
  }
}

type CycleBoundary = { matchId:string; matchEpoch:number; status:string } | undefined;
/** Complete measured coordinator work between successive advances, including
 * separate publication/RPC/checkpoint callbacks and synchronous compute returns.
 * Exclusive callback durations
 * include async waiting, not timer idle gaps or work on other isolates. The first
 * advance only opens a cycle; a pause/epoch change discards its incomplete tail. */
export class WorkerCycleDiagnostics {
  private samples = new Samples();
  private key:string|undefined;
  private armed = false;
  private pendingMs = 0;
  private previousEndMs:number|undefined;
  reset():void { this.samples=new Samples();this.suspend(); }
  private suspend():void { this.key=undefined;this.armed=false;this.pendingMs=0;this.previousEndMs=undefined; }
  /** A synchronous compute-return scope outside a serialized callback. The
   * caller marks overlapping awaited callbacks, whose elapsed span owns it. */
  observeCoordinatorWork(state:CycleBoundary,elapsedMs:number,insideCallback:boolean):void {
    if(insideCallback||!this.armed||!state||state.status!=='RUNNING'||this.key!==`${state.matchId}:${state.matchEpoch}`||!Number.isFinite(elapsedMs)||elapsedMs<0)return;
    this.pendingMs+=elapsedMs;
  }
  observe(before:CycleBoundary,after:CycleBoundary,accounting:Pick<WorkerCallbackAccounting,'startedAtMs'|'endedAtMs'|'totalMs'|'invalidClockSamples'>,advanced:boolean):void {
    const key=before?`${before.matchId}:${before.matchEpoch}`:undefined;
    if(!before||!after||before.status!=='RUNNING'||after.status!=='RUNNING'||before.matchId!==after.matchId||before.matchEpoch!==after.matchEpoch
      ||accounting.invalidClockSamples||![accounting.startedAtMs,accounting.endedAtMs,accounting.totalMs].every(Number.isFinite)||accounting.totalMs<0||accounting.endedAtMs<accounting.startedAtMs){this.suspend();return;}
    if(this.key!==key){this.suspend();this.key=key;}
    // The worker serializes callbacks. Do not double-count an overlapping or
    // backwards interval if an adapter violates that ownership contract.
    if(this.previousEndMs!==undefined&&accounting.startedAtMs<this.previousEndMs){this.suspend();return;}
    this.previousEndMs=accounting.endedAtMs;
    if(this.armed)this.pendingMs+=accounting.totalMs;
    if(advanced){if(this.armed)this.samples.add(this.pendingMs);this.armed=true;this.pendingMs=0;}
  }
  snapshot(){const {rolling}=this.samples.snapshot();return {cycleMs:{p50:rolling.p50Ms??0,p95:rolling.p95Ms??0,p99:rolling.p99Ms??0,max:rolling.maxMs??0},cycleSamples:rolling.samples};}
}

/** The load profiler's instance-wrapper pattern, without importing its executable entry.
 * All names are fixed and only the worker's explicit diagnostic mode installs hooks. */
export const WORKER_SIMULATION_STAGES = ['advanceControllers', 'advanceCaretakers', 'advanceProduction', 'advanceTransitions', 'advanceGates', 'updateEngagements', 'advanceGarrisons', 'advanceCombat', 'advanceWork', 'advanceMovement', 'updateVision', 'resolveDeaths', 'observeActions', 'evaluateVictory', 'refreshPlanningNav', 'formationTargets', 'command', 'prepareMovement', 'prepareVision', 'commitVision', 'planningGeometries'] as const;
const WORKER_ASYNC_STAGES = ['advanceMovementAsync', 'planningBatch', 'visionBatch'] as const;
const ALL_WORKER_SIMULATION_STAGES = [...WORKER_SIMULATION_STAGES, ...WORKER_ASYNC_STAGES] as const;
type WorkerSimulationStage = typeof ALL_WORKER_SIMULATION_STAGES[number];
type StageMetric = { calls: number; inclusiveMs: number; exclusiveMs: number; maxInclusiveMs: number; failures: number };
type StageMetrics = Record<WorkerSimulationStage | 'unattributed', StageMetric>;
const stageMetrics = (): StageMetrics => Object.fromEntries([...ALL_WORKER_SIMULATION_STAGES, 'unattributed'].map(name => [name, { calls: 0, inclusiveMs: 0, exclusiveMs: 0, maxInclusiveMs: 0, failures: 0 }])) as StageMetrics;
interface StagePosition { tick: number; matchEpoch: number }
export interface WorkerSimulationStageSlice {
  root: 'coreStep' | 'externalAdmission'; startTick: number; endTick: number; epoch: number; endEpoch: number;
  startedAtMs: number; endedAtMs: number; totalMs: number; metrics: StageMetrics; invalidClockSamples: number;
  accountedMs: number; remainderMs: number;
}
export interface WorkerSimulationCallbackStages {
  stepLimit: number; omittedSteps: number; steps: WorkerSimulationStageSlice[];
  externalAdmission: { calls: number; totalMs: number; metrics: StageMetrics; invalidClockSamples: number; worst: WorkerSimulationStageSlice | null } | null;
  coreEnvelopeResidualMs: number; commandDrainResidualMs: number; controllerBreakdown:ControllerPhaseReport;
}
class SimulationStageSpan {
  private readonly metrics = stageMetrics();
  private phase: WorkerSimulationStage | 'unattributed' = 'unattributed';
  private boundary = 0;
  private invalid = 0;
  readonly startedAtMs: number;
  readonly startTick: number;
  readonly epoch: number;
  constructor(readonly root: WorkerSimulationStageSlice['root'], state: StagePosition, private readonly now: () => number) {
    this.startTick = state.tick; this.epoch = state.matchEpoch; this.startedAtMs = this.read();
  }
  private read(): number {
    let value: number; try { value = this.now(); } catch { this.invalid++; return this.boundary; }
    if (!Number.isFinite(value) || value < this.boundary) { this.invalid++; return this.boundary; }
    this.boundary = value; return value;
  }
  private transition(phase: WorkerSimulationStage | 'unattributed'): number {
    const previous = this.boundary, at = this.read(); this.metrics[this.phase].exclusiveMs += at - previous; this.phase = phase; return at;
  }
  measure<T>(phase: WorkerSimulationStage, operation: () => T): T {
    const previous = this.phase, started = this.transition(phase); let failed = true;
    try { const result = operation(); failed = false; return result; }
    finally {
      const duration = this.transition(previous) - started, metric = this.metrics[phase];
      metric.calls++; metric.inclusiveMs += duration; metric.maxInclusiveMs = Math.max(metric.maxInclusiveMs, duration); if (failed) metric.failures++;
    }
  }
  async measureAsync<T>(phase: WorkerSimulationStage, operation: () => Promise<T>): Promise<T> {
    const previous = this.phase, started = this.transition(phase); let failed = true;
    try { const result = await operation(); failed = false; return result; }
    finally {
      const duration = this.transition(previous) - started, metric = this.metrics[phase];
      metric.calls++; metric.inclusiveMs += duration; metric.maxInclusiveMs = Math.max(metric.maxInclusiveMs, duration); if (failed) metric.failures++;
    }
  }
  finish(state: StagePosition): WorkerSimulationStageSlice {
    const endedAtMs = this.transition('unattributed'), totalMs = endedAtMs - this.startedAtMs;
    const accountedMs = Object.values(this.metrics).reduce((sum, metric) => sum + metric.exclusiveMs, 0);
    return { root: this.root, startTick: this.startTick, endTick: state.tick, epoch: this.epoch, endEpoch: state.matchEpoch,
      startedAtMs: this.startedAtMs, endedAtMs, totalMs, metrics: this.metrics, invalidClockSamples: this.invalid, accountedMs, remainderMs: totalMs - accountedMs };
  }
}

export const CONTROLLER_PROFILE_ROW_LIMIT=24;
export const CONTROLLER_PROFILE_PHASES=['priorClone','view','memoryRefresh','policy','caretakerClone','admission','journal'] as const;
type ControllerMetrics=Record<ControllerProfilePhase|'unattributed',StageMetric>;
const controllerMetrics=():ControllerMetrics=>Object.fromEntries([...CONTROLLER_PROFILE_PHASES,'unattributed'].map(name=>[name,{calls:0,inclusiveMs:0,exclusiveMs:0,maxInclusiveMs:0,failures:0}])) as ControllerMetrics;
interface ControllerShape {entityCount:number;ownEntityCount:number;ghostCount:number;visibleFogCells:number;exploredFogCells:number;terrainCount:number}
export interface ControllerPhaseRow extends ControllerProfileContext {startedAtMs:number;endedAtMs:number;totalMs:number;accountedMs:number;remainderMs:number;invalidClockSamples:number;failed:boolean;metrics:ControllerMetrics;observation?:ControllerShape}
interface ControllerPhaseReport {rowLimit:number;omittedRows:number;rows:ControllerPhaseRow[];calls:number;totalMs:number;invalidClockSamples:number;metrics:ControllerMetrics;scope:string}
class ControllerPhaseSpan {
  readonly metrics=controllerMetrics();private phase:ControllerProfilePhase|'unattributed'='unattributed';private boundary=0;private invalid=0;private shape?:ControllerShape;
  readonly startedAtMs:number;
  constructor(private readonly context:ControllerProfileContext,private readonly now:()=>number){this.startedAtMs=this.read();}
  private read():number{let at:number;try{at=this.now();}catch{this.invalid++;return this.boundary;}if(!Number.isFinite(at)||at<this.boundary){this.invalid++;return this.boundary;}this.boundary=at;return at;}
  private transition(phase:ControllerProfilePhase|'unattributed'):number{const previous=this.boundary,at=this.read();this.metrics[this.phase].exclusiveMs+=at-previous;this.phase=phase;return at;}
  measure<T>(phase:ControllerProfilePhase,operation:()=>T):T{const previous=this.phase,started=this.transition(phase);let failed=true;try{const value=operation();failed=false;return value;}finally{const duration=this.transition(previous)-started,metric=this.metrics[phase];metric.calls++;metric.inclusiveMs+=duration;metric.maxInclusiveMs=Math.max(metric.maxInclusiveMs,duration);if(failed)metric.failures++;}}
  observation(view:PlayerView):void{let ownEntityCount=0,ghostCount=0;for(const entity of view.entities){if(entity.ownerId===view.playerId)ownEntityCount++;if(entity.ghost)ghostCount++;}this.shape={entityCount:view.entities.length,ownEntityCount,ghostCount,visibleFogCells:view.fog.visible.length,exploredFogCells:view.fog.explored.length,terrainCount:view.map.terrain?.length??0};}
  finish(failed:boolean):ControllerPhaseRow{const endedAtMs=this.transition('unattributed'),totalMs=endedAtMs-this.startedAtMs,accountedMs=Object.values(this.metrics).reduce((sum,metric)=>sum+metric.exclusiveMs,0);return{...this.context,startedAtMs:this.startedAtMs,endedAtMs,totalMs,accountedMs,remainderMs:totalMs-accountedMs,invalidClockSamples:this.invalid,failed,metrics:this.metrics,...(this.shape?{observation:this.shape}:{})};}
}
/** No timers/observers; one active synchronous commander, bounded retained rows. */
export class WorkerControllerPhaseDiagnostics implements ControllerProfiler {
  private active?:ControllerPhaseSpan;private rows:ControllerPhaseRow[]=[];private omittedRows=0;private calls=0;private totalMs=0;private invalidClockSamples=0;private metrics=controllerMetrics();
  constructor(private readonly now:()=>number=diagnosticNow){}
  reset():void{this.rows=[];this.omittedRows=0;this.calls=0;this.totalMs=0;this.invalidClockSamples=0;this.metrics=controllerMetrics();}
  commander<T>(context:ControllerProfileContext,operation:()=>T):T{const previous=this.active,span=new ControllerPhaseSpan(context,this.now);this.active=span;let failed=true;try{const value=operation();failed=false;return value;}finally{this.active=previous;const row=span.finish(failed);this.calls++;this.totalMs+=row.totalMs;this.invalidClockSamples+=row.invalidClockSamples;for(const phase of [...CONTROLLER_PROFILE_PHASES,'unattributed'] as const){const to=this.metrics[phase],from=row.metrics[phase];to.calls+=from.calls;to.inclusiveMs+=from.inclusiveMs;to.exclusiveMs+=from.exclusiveMs;to.failures+=from.failures;to.maxInclusiveMs=Math.max(to.maxInclusiveMs,from.maxInclusiveMs);}if(this.rows.length<CONTROLLER_PROFILE_ROW_LIMIT)this.rows.push(row);else this.omittedRows++;}}
  measure<T>(phase:ControllerProfilePhase,operation:()=>T):T{return this.active?this.active.measure(phase,operation):operation();}
  observation(view:PlayerView):void{this.active?.observation(view);}
  snapshot():ControllerPhaseReport{return structuredClone({rowLimit:CONTROLLER_PROFILE_ROW_LIMIT,omittedRows:this.omittedRows,rows:this.rows,calls:this.calls,totalMs:this.totalMs,invalidClockSamples:this.invalidClockSamples,metrics:this.metrics,scope:'Private diagnostic-only per-AI synchronous controller invocation. policy includes nested caretakerClone; sum exclusiveMs plus unattributed, never inclusive intervals. Each row is nested inside advanceControllers/coreStep and must not be added to that parent. journal includes outcome reporting, commander patch generation/size choice and journal capture. observation counts and in-span bookkeeping belong to unattributed. Commander context construction and due/expiry cause scans precede the span and remain in parent advanceControllers overhead. Completed-row aggregation also remains outside this span. Full PlayerView, commander memory, commands, model content and secrets are never retained. Wall timings include scheduling/GC and diagnostic overhead; not qualification.'});}
}

export class WorkerSimulationStageDiagnostics {
  private restores: (() => void)[] = [];
  private active?: SimulationStageSpan;
  private steps: WorkerSimulationStageSlice[] = [];
  private omittedSteps = 0;
  private coreTotalMs = 0;
  private readonly controllers:WorkerControllerPhaseDiagnostics;
  private external: WorkerSimulationCallbackStages['externalAdmission'] = null;
  constructor(private readonly now: () => number = diagnosticNow) { this.controllers=new WorkerControllerPhaseDiagnostics(now); }
  restore(): void { while (this.restores.length) this.restores.pop()!(); }
  install(target: Record<string, unknown>): void {
    this.restore(); const owner = this;
    try {
      for (const stage of WORKER_SIMULATION_STAGES) {
        const descriptor = Object.getOwnPropertyDescriptor(target, stage), original = target[stage];
        if (typeof original !== 'function' || descriptor && !('value' in descriptor)) throw new Error('UNKNOWN_PROFILE_STAGE:' + stage);
        const wrapped = function(this: unknown, ...args: unknown[]) { return owner.active ? owner.active.measure(stage, () => original.apply(this, args)) : original.apply(this, args); };
        Object.defineProperty(target, stage, { ...(descriptor ?? { configurable: true, enumerable: true, writable: true }), value: wrapped });
        this.restores.push(() => { if (descriptor) Object.defineProperty(target, stage, descriptor); else delete target[stage]; });
        if(stage==='refreshPlanningNav'&&typeof target.registerPlanningRefreshDiagnostic==='function'){
          // Only this owned timing wrapper is offered for the simulation's narrow
          // identity check. A wrapper around an existing custom reader is rejected.
          const release=target.registerPlanningRefreshDiagnostic.call(target,original,wrapped);
          if(typeof release==='function')this.restores.push(()=>release());
        }
        if((stage==='advanceTransitions'||stage==='advanceGates')&&typeof target.registerGatePhaseDiagnostic==='function'){
          const release=target.registerGatePhaseDiagnostic.call(target,stage,original,wrapped);
          if(typeof release==='function')this.restores.push(()=>release());
        }
        if(typeof target.registerFramePlanningDiagnostic==='function'){
          const release=target.registerFramePlanningDiagnostic.call(target,stage,original,wrapped);
          if(typeof release==='function')this.restores.push(()=>release());
        }
      }
      // Runtime-only wrappers keep instrumentation out of simulation/save identity.
      // These phases are strictly nested by the non-reentrant authoritative driver.
      const wrapAsync = (object: Record<string, unknown>, key: string, stage: WorkerSimulationStage) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key), original = object[key];
        if (original === undefined) return; // Inline execution has no worker executor.
        if (typeof original !== 'function' || descriptor && !('value' in descriptor)) throw new Error('UNKNOWN_PROFILE_STAGE:' + stage);
        const wrapped = function(this: unknown, ...args: unknown[]) { return owner.active ? owner.active.measureAsync(stage, () => original.apply(this, args)) : original.apply(this, args); };
        Object.defineProperty(object, key, { ...(descriptor ?? { configurable: true, enumerable: true, writable: true }), value: wrapped });
        this.restores.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; });
      };
      wrapAsync(target, 'advanceMovementAsync', 'advanceMovementAsync');
      wrapAsync(target, 'visionExecutor', 'visionBatch');
      const scheduler = target.pathScheduler;
      if (scheduler && typeof scheduler === 'object') wrapAsync(scheduler as Record<string, unknown>, 'advanceAsync', 'planningBatch');
      const descriptor=Object.getOwnPropertyDescriptor(target,'controllerProfiler');
      const controllerProfiler:ControllerProfiler={commander:(context,operation)=>owner.active?owner.controllers.commander(context,operation):operation(),measure:(phase,operation)=>owner.controllers.measure(phase,operation),observation:view=>owner.controllers.observation(view)};
      Object.defineProperty(target,'controllerProfiler',{...(descriptor??{configurable:true,enumerable:true,writable:true}),value:controllerProfiler});
      this.restores.push(()=>{if(descriptor)Object.defineProperty(target,'controllerProfiler',descriptor);else delete target.controllerProfiler;});
    } catch (error) { this.restore(); throw error; }
  }
  beginCallback(): void { this.steps = []; this.omittedSteps = 0; this.coreTotalMs = 0; this.external = null; this.controllers.reset(); }
  private measureRoot<T>(root: WorkerSimulationStageSlice['root'], state: StagePosition, operation: () => T): T {
    // Worker roots are synchronous and disjoint; nested method scopes use active.measure.
    const previous = this.active, span = new SimulationStageSpan(root, state, this.now); this.active = span;
    try { return operation(); }
    finally {
      this.active = previous; const slice = span.finish(state);
      if (root === 'coreStep') { this.coreTotalMs += slice.totalMs; if (this.steps.length < 4) this.steps.push(slice); else this.omittedSteps++; }
      else {
        const aggregate = this.external ??= { calls: 0, totalMs: 0, metrics: stageMetrics(), invalidClockSamples: 0, worst: null };
        aggregate.calls++; aggregate.totalMs += slice.totalMs; aggregate.invalidClockSamples += slice.invalidClockSamples;
        for (const name of [...ALL_WORKER_SIMULATION_STAGES, 'unattributed'] as const) {
          const to = aggregate.metrics[name], from = slice.metrics[name];
          to.calls += from.calls; to.inclusiveMs += from.inclusiveMs; to.exclusiveMs += from.exclusiveMs; to.failures += from.failures; to.maxInclusiveMs = Math.max(to.maxInclusiveMs, from.maxInclusiveMs);
        }
        if (!aggregate.worst || slice.totalMs > aggregate.worst.totalMs) aggregate.worst = slice;
      }
    }
  }
  step<T>(state: StagePosition, operation: () => T): T { return this.measureRoot('coreStep', state, operation); }
  async stepAsync<T>(state: StagePosition, operation: () => Promise<T>): Promise<T> {
    const previous=this.active,span=new SimulationStageSpan('coreStep',state,this.now);this.active=span;
    try{return await operation();}finally{this.active=previous;const slice=span.finish(state);this.coreTotalMs+=slice.totalMs;if(this.steps.length<4)this.steps.push(slice);else this.omittedSteps++;}
  }
  externalAdmission<T>(state: StagePosition, operation: () => T): T { return this.measureRoot('externalAdmission', state, operation); }
  finishCallback(accounting: WorkerCallbackAccounting): WorkerSimulationCallbackStages {
    return { stepLimit: 4, omittedSteps: this.omittedSteps, steps: this.steps, externalAdmission: this.external, controllerBreakdown:this.controllers.snapshot(),
      coreEnvelopeResidualMs: accounting.phasesMs.coreStep - this.coreTotalMs,
      commandDrainResidualMs: accounting.phasesMs.commandDrain - (this.external?.totalMs ?? 0) };
  }
  static readonly scope = 'Private opt-in live timer steps and queued worker command admission only; constructor and replay work are excluded. Each per-step row has exact tick/epoch and shares callback startedAtMs through its parent ledger. Metric inclusiveMs contains nested children and must not be summed. ExclusiveMs plus unattributed reconciles only within one slice; slices are nested inside the existing coreStep or commandDrain callback phase and must not be added to it. Async planningBatch/visionBatch include coordinator pool preparation, worker waiting and result assembly; matching private pool timestamps distinguish worker execution from those enclosing intervals. advanceMovementAsync exclusive time includes local-query preparation/installation and other work outside its named children. Unattributed includes remaining context/argument construction, effect/receipt/statistics maintenance and profiler overhead. External admission is worker pending-command execution, currently human-source including harness commands; controller/caretaker commands execute inside coreStep and are separate. Envelope residuals include root-wrapper bookkeeping and other parent work. Timings are wall time including GC/scheduling, not CPU time; instrumentation cannot qualify timing.';
}

const GC_EVENT_LIMIT = 256;
interface GcEvent { startPerformanceMs: number; startHostMonotonicMs: number; durationMs: number; kind: number; flags: number }
interface RuntimeDiagnosticSource {
  performance: Pick<typeof performance, 'now' | 'eventLoopUtilization'>;
  monitorEventLoopDelay: typeof monitorEventLoopDelay;
  PerformanceObserver: typeof PerformanceObserver;
  memoryUsage: typeof process.memoryUsage;
}
/** Construct only for explicit diagnostics. No intervals or GC observers exist when it is disabled. */
export class IsolateRuntimeDiagnostics {
  private observer: PerformanceObserver;
  private delay: ReturnType<typeof monitorEventLoopDelay>;
  private started: ReturnType<typeof performance.eventLoopUtilization>;
  private previous: ReturnType<typeof performance.eventLoopUtilization>;
  private clockOffsetMs: number;
  private clockMappingErrorBoundMs: number;
  private gcEvents: GcEvent[] = [];
  private gcDurations = new Samples();
  private gcKinds = new Map<number, { count: number; totalMs: number }>();
  private gcInvalid = 0;
  private closed = false;
  constructor(readonly isolate: string, private readonly now: () => number = diagnosticNow,
    private readonly runtime: RuntimeDiagnosticSource = { performance, monitorEventLoopDelay, PerformanceObserver, memoryUsage: process.memoryUsage }) {
    this.delay = runtime.monitorEventLoopDelay({ resolution: 20 });
    this.started = runtime.performance.eventLoopUtilization(); this.previous = this.started;
    const before = now(), performanceMs = runtime.performance.now(), after = now();
    this.clockOffsetMs = (before + after) / 2 - performanceMs; this.clockMappingErrorBoundMs = Math.max(0, after - before) / 2;
    this.observer = new runtime.PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        const detail = (entry as unknown as { detail?: { kind?: number; flags?: number } }).detail;
        const kind = [1, 2, 4, 8].includes(detail?.kind ?? 0) ? detail!.kind! : 0;
        if (![entry.startTime, entry.duration].every(Number.isFinite) || entry.startTime < 0 || entry.duration < 0) { this.gcInvalid++; continue; }
        this.gcDurations.add(entry.duration);
        const aggregate = this.gcKinds.get(kind) ?? { count: 0, totalMs: 0 }; aggregate.count++; aggregate.totalMs += entry.duration; this.gcKinds.set(kind, aggregate);
        this.gcEvents.push({ startPerformanceMs: entry.startTime, startHostMonotonicMs: entry.startTime + this.clockOffsetMs, durationMs: entry.duration, kind, flags: Number.isSafeInteger(detail?.flags) ? detail!.flags! : 0 });
        if (this.gcEvents.length > GC_EVENT_LIMIT) this.gcEvents.shift();
      }
    });
    this.observer.observe({ entryTypes: ['gc'] }); this.delay.enable();
  }
  snapshot() {
    const current = this.runtime.performance.eventLoopUtilization(), sinceStart = this.runtime.performance.eventLoopUtilization(current, this.started), sincePrevious = this.runtime.performance.eventLoopUtilization(current, this.previous);
    this.previous = current;
    const memory = this.runtime.memoryUsage(), nsToMs = (value: number) => Number.isFinite(value) ? value / 1e6 : null;
    const delaySamples = this.delay.count;
    const gcDurations = this.gcDurations.snapshot();
    return { isolate: this.isolate, sampledAtHostMonotonicMs: this.now(), closed: this.closed,
      scope: 'Per-isolate diagnostics. ELU is event-loop activity, not CPU utilization. GC intervals can overlap callback phases and must not be added to callback time. Observer delivery is asynchronous; the newest GC event may arrive after this snapshot. RSS is process-wide and is deliberately omitted here.',
      memory: { heapTotal: memory.heapTotal, heapUsed: memory.heapUsed, external: memory.external, arrayBuffers: memory.arrayBuffers },
      eventLoopUtilization: { sinceStart, sincePreviousSnapshot: sincePrevious },
      eventLoopDelay: { resolutionMs: 20, samples: delaySamples, scope: 'Cumulative since observer creation; nanosecond histogram converted to milliseconds.',
        meanMs: delaySamples ? nsToMs(this.delay.mean) : null, maxMs: delaySamples ? nsToMs(this.delay.max) : null,
        p50Ms: delaySamples ? nsToMs(this.delay.percentile(50)) : null, p95Ms: delaySamples ? nsToMs(this.delay.percentile(95)) : null, p99Ms: delaySamples ? nsToMs(this.delay.percentile(99)) : null },
      gc: { eventLimit: GC_EVENT_LIMIT, durations: gcDurations, invalid: this.gcInvalid,
        evictedEvents: Math.max(0, gcDurations.count - GC_EVENT_LIMIT), byKind: Object.fromEntries([...this.gcKinds].map(([kind, value]) => [kind, { ...value }])),
        clock: { source: 'performance entry startTime mapped to host monotonic hrtime at construction', mappingErrorBoundMs: this.clockMappingErrorBoundMs }, recentEvents: this.gcEvents.map(event => ({ ...event })) } };
  }
  close(): void { if (!this.closed) { this.closed = true; this.observer.disconnect(); this.delay.disable(); } }
}
interface WorkerPosition { tick: number; matchEpoch: number; status: string }
interface WorkerSpan { operation: string; startedAtMs: number; gapBeforeMs: number | null; tick: number | null; epoch: number | null; status: string | null; debtMs: number | null }
interface WorkerEvent extends WorkerSpan { durationMs: number; endTick: number | null; stepsMs: number[]; accounting?: WorkerCallbackAccounting }
/** Bounded chronological evidence; a scheduling gap alone cannot identify its cause.
 * Normal operation retains coarse callback phases without installing diagnostic
 * simulation hooks or replacing the native command/publication paths. */
export class WorkerOverloadDiagnostics {
  private events: WorkerEvent[] = [];
  private advancingEvents: WorkerEvent[] = [];
  private eventCount = 0;
  private advancingEventCount = 0;
  private previousEndMs?: number;
  private overload?: { trigger: WorkerSpan; precedingEvents: WorkerEvent[]; precedingAdvancingEvents: WorkerEvent[]; omittedEvents: number; omittedAdvancingEvents: number; completedCallback?: WorkerEvent; boundaryQueued:number; pendingCommands:number };
  constructor(private readonly now: () => number = diagnosticNow, private readonly historyLimit = WORKER_HISTORY_LIMIT) {}
  reset(): void { this.events = []; this.advancingEvents = []; this.eventCount = 0; this.advancingEventCount = 0; this.previousEndMs = undefined; this.overload = undefined; }
  begin(operation: string, state?: WorkerPosition, debtMs?: number, startedAtMs = this.now()): WorkerSpan {
    return { operation: WORKER_OPERATIONS.has(operation) ? operation : 'unknown', startedAtMs,
      gapBeforeMs: this.previousEndMs === undefined ? null : Math.max(0, startedAtMs - this.previousEndMs),
      tick: state?.tick ?? null, epoch: state?.matchEpoch ?? null, status: state?.status ?? null, debtMs: debtMs ?? null };
  }
  finish(span: WorkerSpan, state?: WorkerPosition, stepsMs: number[] = [], accounting?: WorkerCallbackAccounting): void {
    const endedAtMs = accounting?.endedAtMs ?? this.now(), event = { ...span, durationMs: Math.max(0, endedAtMs - span.startedAtMs), endTick: state?.tick ?? null, stepsMs: stepsMs.slice(0, 4), ...(accounting ? { accounting: accounting.simulationStages ? structuredClone(accounting) : { ...accounting, phasesMs: { ...accounting.phasesMs } } } : {}) };
    this.eventCount++; this.events.push(event); if (this.events.length > this.historyLimit) this.events.shift();
    // Command bursts must not displace the advancing callbacks that accumulated
    // tick debt. This is a second view of the same intervals, never extra time.
    if (stepsMs.length) { this.advancingEventCount++; this.advancingEvents.push(event); if (this.advancingEvents.length > this.historyLimit) this.advancingEvents.shift(); }
    this.previousEndMs = endedAtMs;
    if (this.overload?.trigger === span) this.overload.completedCallback = event;
  }
  captureOverload(span: WorkerSpan, boundaryQueued=0, pendingCommands=0): void { this.overload = { trigger: span, precedingEvents: this.events.slice(), precedingAdvancingEvents: this.advancingEvents.slice(), omittedEvents: this.eventCount - this.events.length, omittedAdvancingEvents: this.advancingEventCount - this.advancingEvents.length, boundaryQueued, pendingCommands }; }
  hostSnapshot(boundaryYields:number):WorkerRuntimeSummary {
    const summarize=(event:WorkerEvent):WorkerCallbackSummary=>({operation:event.operation,tick:event.tick,endTick:event.endTick,epoch:event.epoch,durationMs:event.durationMs,gapBeforeMs:event.gapBeforeMs,
      phasesMs:event.accounting?{...event.accounting.phasesMs}:{commandDrain:0,coreStep:0,activityProjection:0,viewAssemblyPost:0,journalCheckpoint:0,other:event.durationMs}});
    const fault=this.overload;
    return {historyLimit:16,callbackCount:this.eventCount,boundaryYields,recentCallbacks:this.events.slice(-16).map(summarize),
      lastOverload:fault&&fault.trigger.tick!==null&&fault.trigger.epoch!==null&&fault.trigger.debtMs!==null?{
        tick:fault.trigger.tick,epoch:fault.trigger.epoch,debtMs:fault.trigger.debtMs,boundaryQueued:fault.boundaryQueued,pendingCommands:fault.pendingCommands,
        precedingCallbacks:fault.precedingEvents.slice(-16).map(summarize),precedingAdvancingCallbacks:fault.precedingAdvancingEvents.slice(-16).map(summarize)}:null};
  }
  snapshot() {
    return { eventLimit: this.historyLimit,
      scope: 'Private opt-in wall-clock history. Gap before each event includes normal timer idle, GC, native work and OS scheduling; it is not proof of CPU starvation. Step timings are nested within timer duration. Advancing history duplicates a subset of the same callbacks; never add the two histories. Last overload survives pause and resume, and resets on init or restore.',
      eventCount: this.eventCount, advancingEventCount: this.advancingEventCount, omittedEvents: this.eventCount - this.events.length, omittedAdvancingEvents: this.advancingEventCount - this.advancingEvents.length,
      recentEvents: structuredClone(this.events), recentAdvancingEvents: structuredClone(this.advancingEvents), lastOverload: this.overload ? structuredClone(this.overload) : null };
  }
}

export interface MovementCertificate { playerId: string; commandId: string; commandSequence: number; unitId: string; orderRevision: number; acceptedAtMs: number; firstMoveAtMs: number; firstMoveTick: number; xMm: number; zMm: number }
export interface PublicationStamp { matchId: string; tick: number; sequence: number; matchEpoch: number; completedAtMs?: number; postedAtMs: number; movements?: MovementCertificate[] }
const copyStamp = (stamp: PublicationStamp): PublicationStamp => ({ ...stamp, ...(stamp.movements ? { movements: stamp.movements.slice(0, 64).map(movement => ({ ...movement })) } : {}) });
/** Private only: bounded timestamps and certificates for already-authorized own units. */
export class PublicationTimes {
  private players = new Map<string, PublicationStamp[]>();
  record(playerId: string, stamp: PublicationStamp): void {
    if (![stamp.tick, stamp.sequence, stamp.matchEpoch, stamp.postedAtMs].every(Number.isFinite) || stamp.completedAtMs !== undefined && !Number.isFinite(stamp.completedAtMs)) return;
    let records = this.players.get(playerId);
    if (!records) { if (this.players.size >= 11) return; records = []; this.players.set(playerId, records); }
    if (records.at(-1)?.matchEpoch !== stamp.matchEpoch || records.at(-1)?.matchId !== stamp.matchId) records.length = 0;
    records.push(copyStamp(stamp)); if (records.length > 128) records.shift();
  }
  find(playerId: string, matchId: string, epoch: number, sequence: number): PublicationStamp | undefined {
    const stamp = this.players.get(playerId)?.find(record => record.matchId === matchId && record.matchEpoch === epoch && record.sequence === sequence);
    return stamp && copyStamp(stamp);
  }
}

/** Local owned-observer correlation; these timestamps are never added to game packets. */
export class ViewDeliveryDiagnostics {
  private previous?: { matchId: string; epoch: number; tick: number; atMs: number };
  private issued = new Map<string, { playerId: string; matchId: string; epoch: number; sequence: number; atMs: number }>();
  private latestIssued?: { playerId: string; matchId: string; epoch: number; sequence: number };
  constructor(private readonly metrics: PerformanceDiagnostics) {}
  reset(): void { if (this.issued.size) this.metrics.count('deliveredMoveBoundaryCensored', this.issued.size); this.issued.clear(); this.latestIssued = undefined; this.previous = undefined; }
  commandIssued(playerId: string, envelope: { matchId: string; matchEpoch: number; clientCommandId: string; clientSequence: number; command: { kind: string; queued?: boolean } }): void {
    if (envelope.command.kind !== 'move' || envelope.command.queued !== false) return;
    if (!Number.isSafeInteger(envelope.clientSequence) || envelope.clientSequence < 1 || !envelope.clientCommandId || envelope.clientCommandId.length > 96) return;
    const previous = this.previous, latest = this.latestIssued;
    if (this.issued.has(envelope.clientCommandId) || previous && (previous.matchId !== envelope.matchId || previous.epoch !== envelope.matchEpoch) || latest && latest.playerId === playerId && latest.matchId === envelope.matchId && latest.epoch === envelope.matchEpoch && envelope.clientSequence <= latest.sequence) { this.metrics.count('deliveredMoveDuplicateOrStaleCommand'); return; }
    const now = this.metrics.now(); this.expire(now);
    this.latestIssued = { playerId, matchId: envelope.matchId, epoch: envelope.matchEpoch, sequence: envelope.clientSequence };
    if (this.issued.size >= 64) { this.metrics.count('deliveredMoveOverflow'); return; }
    this.issued.set(envelope.clientCommandId, { playerId, matchId: envelope.matchId, epoch: envelope.matchEpoch, sequence: envelope.clientSequence, atMs: now }); this.metrics.count('deliveredMoveIssued');
  }
  private expire(now: number): void { for (const [id, probe] of this.issued) if (now - probe.atMs > 10000) { this.issued.delete(id); this.metrics.count('deliveredMoveExpiredWithoutDelivery'); } }
  snapshot() { return { pendingCommands: this.issued.size, commandLimit: 64, timeoutMs: 10000,
    scope: 'Command issue to first certified reconstructed authorized delivered view for the first unit committing an accepted Move. Excludes renderer delay, queued/already-moving commands and units whose order revision changes before publication. Arrival on a publication tick can qualify. Missing certificates or delivery are censored.' }; }
  observe(view: { matchId: string; matchEpoch: number; tick: number; sequence: number; status: string; playerId?: string; entities?: readonly { id: string; kind: string; ownerId: string | null; xMm: number; zMm: number; ghost?: boolean; garrisonedIn?: string; visualAction?: { kind: string } }[] }, stamp?: PublicationStamp): void {
    if (view.status !== 'RUNNING') { this.reset(); return; }
    const now = this.metrics.now(), previous = this.previous;
    this.expire(now);
    if (previous?.matchId === view.matchId && (view.matchEpoch < previous.epoch || view.matchEpoch === previous.epoch && view.tick <= previous.tick)) { this.metrics.count('repeatedOrStaleTickViews'); return; }
    for (const [id, probe] of this.issued) if (probe.matchId !== view.matchId || probe.epoch !== view.matchEpoch || view.playerId !== undefined && probe.playerId !== view.playerId) { this.issued.delete(id); this.metrics.count('deliveredMoveBoundaryCensored'); }
    if (previous?.matchId === view.matchId && previous.epoch === view.matchEpoch) this.metrics.sample('viewDeliveryInterval', now - previous.atMs);
    this.previous = { matchId: view.matchId, epoch: view.matchEpoch, tick: view.tick, atMs: now };
    this.metrics.count('distinctRunningTickViews');
    const matched = stamp && stamp.matchId === view.matchId && stamp.tick === view.tick && stamp.sequence === view.sequence && stamp.matchEpoch === view.matchEpoch;
    if (matched && stamp.completedAtMs !== undefined) this.metrics.sample('viewDeliveryAge', now - stamp.completedAtMs);
    else this.metrics.count('deliveryStampMissing');
    if (!matched || !this.issued.size || !view.entities || !view.playerId) return;
    for (const certificate of stamp.movements ?? []) {
      const probe = this.issued.get(certificate.commandId);
      if (!probe || probe.playerId !== certificate.playerId || probe.playerId !== view.playerId || probe.sequence !== certificate.commandSequence || !Number.isSafeInteger(certificate.orderRevision) || ![certificate.acceptedAtMs, certificate.firstMoveAtMs, certificate.firstMoveTick].every(Number.isFinite) || certificate.firstMoveTick > view.tick || certificate.acceptedAtMs < probe.atMs || certificate.firstMoveAtMs < certificate.acceptedAtMs || now < certificate.firstMoveAtMs) continue;
      const unit = view.entities.find(entity => entity.id === certificate.unitId);
      if (!unit || unit.kind !== 'unit' || unit.ownerId !== view.playerId || unit.ghost || unit.garrisonedIn || unit.xMm !== certificate.xMm || unit.zMm !== certificate.zMm || !['move', 'carry'].includes(unit.visualAction?.kind ?? '')) continue;
      this.metrics.sample('commandIssuedToDeliveredMove', now - probe.atMs); this.metrics.sample('acceptedToDeliveredMove', now - certificate.acceptedAtMs); this.metrics.sample('firstMoveToDeliveredMove', now - certificate.firstMoveAtMs);
      this.metrics.count('deliveredMoveCompleted'); this.issued.delete(certificate.commandId);
    }
  }
}

interface MotionUnit { id: string; kind: string; typeId?: string; ownerId: string | null; hp: number; xMm: number; zMm: number; orderRevision?: number; orders?: readonly unknown[]; path?: readonly unknown[]; garrisonedIn?: string }
interface MotionState { matchId: string; matchEpoch: number; tick: number; status: string; entities: Record<string, MotionUnit> }
interface Probe { playerId: string; matchId: string; epoch: number; commandId: string; commandSequence: number; queuedAt: number; acceptedAt: number; units: { id: string; xMm: number; zMm: number; revision: number }[] }
interface MovedProbe extends Probe { firstMoveAt: number; firstMoveTick: number }
export interface MoveCandidate { playerId: string; matchId: string; epoch: number; commandId: string; commandSequence: number; queuedAt: number; ids: string[] }

/** Samples only idle-to-move transitions; ongoing movement cannot stand in for command response. */
export class MovementDiagnostics {
  private pending: Probe[] = [];
  private certificates: MovedProbe[] = [];
  constructor(private readonly metrics: PerformanceDiagnostics) {}
  candidate(playerId: string, envelope: unknown, state: MotionState, queuedAt: number): MoveCandidate | undefined {
    const input = envelope as { matchEpoch?: number; clientCommandId?: string; clientSequence?: number; command?: { kind?: string; queued?: boolean; unitIds?: unknown } } | null;
    if (!input || input.command?.kind !== 'move' || input.command.queued !== false || !Array.isArray(input.command.unitIds) || input.command.unitIds.length > 200 || !Number.isSafeInteger(input.clientSequence) || typeof input.clientCommandId !== 'string' || !input.clientCommandId || input.clientCommandId.length > 96) return;
    const ids = input.command.unitIds.filter((id): id is string => typeof id === 'string').filter(id => {
      const unit = state.entities[id];
      return unit?.kind === 'unit' && unit.ownerId === playerId && unit.hp > 0 && !unit.garrisonedIn && unit.orders?.length === 0 && unit.path?.length === 0;
    });
    if (!ids.length) { this.metrics.count('moveProbeNoIdleUnits'); return; }
    return { playerId, matchId: state.matchId, epoch: state.matchEpoch, commandId: input.clientCommandId, commandSequence: input.clientSequence!, queuedAt, ids };
  }
  accepted(candidate: MoveCandidate | undefined, fresh: boolean, accepted: boolean, state: MotionState): void {
    if (!candidate) return;
    if (!accepted || !fresh) { this.metrics.count(accepted ? 'moveProbeDuplicate' : 'moveProbeRejected'); return; }
    const units = candidate.ids.flatMap(id => { const unit = state.entities[id]; return unit?.kind === 'unit' && unit.orderRevision !== undefined ? [{ id, xMm: unit.xMm, zMm: unit.zMm, revision: unit.orderRevision }] : []; });
    if (candidate.matchId !== state.matchId || candidate.epoch !== state.matchEpoch || state.status !== 'RUNNING') { this.metrics.count('moveProbeBoundaryCensored'); return; }
    if (this.pending.length >= 64 || this.pending.reduce((sum, probe) => sum + probe.units.length, 0) + units.length > 4096) { this.metrics.count('moveProbeOverflow'); return; }
    if (!units.length) return;
    this.pending.push({ ...candidate, acceptedAt: this.metrics.now(), units }); this.metrics.count('moveProbeAccepted');
  }
  observe(state: MotionState, actions: readonly { id: string; kind: string }[]): void {
    if (!this.pending.length && !this.certificates.length) return;
    const now = this.metrics.now(), moved = new Set(actions.filter(action => action.kind === 'move' || action.kind === 'carry').map(action => action.id));
    this.pending = this.pending.filter(probe => {
      if (probe.matchId !== state.matchId || probe.epoch !== state.matchEpoch || state.status !== 'RUNNING') { this.metrics.count('moveProbeBoundaryCensored'); return false; }
      if (now - probe.acceptedAt > 10000) { this.metrics.count('moveProbeExpired'); return false; }
      probe.units = probe.units.filter(before => { const unit = state.entities[before.id]; return unit?.hp > 0 && unit.ownerId === probe.playerId && unit.orderRevision === before.revision; });
      if (!probe.units.length) { this.metrics.count('moveProbeSuperseded'); return false; }
      const first = probe.units.find(before => { const unit = state.entities[before.id]!; return moved.has(before.id) && (unit.xMm !== before.xMm || unit.zMm !== before.zMm); });
      if (!first) return true;
      this.metrics.sample('acceptedToFirstMove', now - probe.acceptedAt); this.metrics.sample('queuedToFirstMove', now - probe.queuedAt); this.metrics.count('moveProbeCompleted');
      if (this.certificates.length < 64) this.certificates.push({ ...probe, units: [first], firstMoveAt: now, firstMoveTick: state.tick });
      else this.metrics.count('moveCertificateOverflow'); return false;
    });
    this.certificates = this.certificates.filter(probe => {
      if (probe.matchId !== state.matchId || probe.epoch !== state.matchEpoch || state.status !== 'RUNNING') { this.metrics.count('moveCertificateBoundaryCensored'); return false; }
      if (now - probe.acceptedAt > 10000) { this.metrics.count('moveCertificateWindowExpired'); return false; }
      probe.units = probe.units.filter(before => { const unit = state.entities[before.id]; return unit?.hp > 0 && unit.ownerId === probe.playerId && unit.orderRevision === before.revision && !unit.garrisonedIn; });
      if (!probe.units.length) { this.metrics.count('moveCertificateSuperseded'); return false; } return true;
    });
  }
  reset(): void { if (this.pending.length) this.metrics.count('moveProbeBoundaryCensored', this.pending.length); if (this.certificates.length) this.metrics.count('moveCertificateBoundaryCensored', this.certificates.length); this.pending = []; this.certificates = []; }
  publication(view: { playerId: string; matchId: string; matchEpoch: number; tick: number; status: string; entities: readonly { id: string; kind: string; ownerId: string | null; xMm: number; zMm: number; ghost?: boolean; garrisonedIn?: string; visualAction?: { kind: string } }[] }, state: MotionState): MovementCertificate[] {
    if (!this.certificates.length || state.status !== 'RUNNING' || view.status !== 'RUNNING' || state.matchId !== view.matchId || state.matchEpoch !== view.matchEpoch || state.tick !== view.tick) return [];
    const now = this.metrics.now(), result: MovementCertificate[] = [];
    for (const probe of this.certificates) {
      if (probe.playerId !== view.playerId || probe.matchId !== view.matchId || probe.epoch !== view.matchEpoch || now - probe.acceptedAt > 10000 || probe.firstMoveTick > view.tick) continue;
      for (const before of probe.units) {
        const live = state.entities[before.id];
        if (!live || live.hp <= 0 || live.ownerId !== view.playerId || live.orderRevision !== before.revision || live.garrisonedIn || live.xMm === before.xMm && live.zMm === before.zMm) continue;
        const unit = view.entities.find(entity => entity.id === before.id);
        if (!unit || unit.kind !== 'unit' || unit.ownerId !== view.playerId || unit.ghost || unit.garrisonedIn || unit.xMm !== live.xMm || unit.zMm !== live.zMm || !['move', 'carry'].includes(unit.visualAction?.kind ?? '')) continue;
        result.push({ playerId: probe.playerId, commandId: probe.commandId, commandSequence: probe.commandSequence, unitId: before.id, orderRevision: before.revision, acceptedAtMs: probe.acceptedAt, firstMoveAtMs: probe.firstMoveAt, firstMoveTick: probe.firstMoveTick, xMm: unit.xMm, zMm: unit.zMm }); break;
      }
    }
    return result;
  }
  snapshot() { return { pendingCommands: this.pending.length, pendingUnits: this.pending.reduce((sum, probe) => sum + probe.units.length, 0), commandLimit: 64, unitLimit: 4096, timeoutMs: 10000,
    certificateCommands: this.certificates.length, certificateUnits: this.certificates.reduce((sum, probe) => sum + probe.units.length, 0), certificateCommandLimit: 64, certificateUnitLimit: 64,
    scope: 'Fresh accepted, nonqueued Move commands with at least one previously idle own unit; first committed position change. Delivery certificates separately retain the first unit committing each move, without consuming the original pending-probe budget. Certificate expiry is retention eviction, not proof of missing delivery; observer counters measure missing delivery. Excludes already-moving units and renderer delay.' }; }
}

type CoverageKind = 'move' | 'gather';
type CoverageOutcome = 'acted' | 'canceled' | 'revisionCensored' | 'expired' | 'boundaryCensored';
interface CoverageUnit { id: string; revision: number; xMm: number; zMm: number; firstMoveTick?: number; firstWorkTick?: number; firstMoveAtMs?: number; firstWorkAtMs?: number; outcome?: CoverageOutcome }
export interface ActionCoverageCandidate {
  kind: CoverageKind; playerId: string; matchId: string; epoch: number; commandId: string; commandSequence: number;
  targetId?: string; queuedAtMs: number; admissionStartedAtMs: number; eligibleIds: string[]; submittedUnits: number;
}
interface CoverageGroup extends Omit<ActionCoverageCandidate, 'eligibleIds'> {
  acceptedAtMs: number; acceptedTick: number; eligibleUnits: number; units: CoverageUnit[]; firstMovementRecorded: boolean; allMovementRecorded: boolean;
  firstWorkRecorded: boolean; allWorkRecorded: boolean; closedAtMs?: number;
}
const COVERAGE_COMMAND_LIMIT = 64, COVERAGE_UNIT_LIMIT = 4096, COVERAGE_TIMEOUT_MS = 10000;
const coverageLatencyNames = ['queueToAdmission', 'admission', 'acceptedToFirstMovement', 'acceptedToAllMovement', 'acceptedToUnitMovement', 'acceptedToFirstWork', 'acceptedToAllWork', 'acceptedToUnitWork'] as const;
/** Group response coverage is independent of the older first-idle-Move delivery certificates. */
export class ActionCoverageDiagnostics {
  private pending: CoverageGroup[] = [];
  private completed: CoverageGroup[] = [];
  private retainedCompletedUnits = 0;
  private completedEvicted = 0;
  private counts = { submittedCommands: 0, submittedUnits: 0, invalidEnvelopes: 0, queuedOrUnsupportedCommands: 0,
    eligibleCommands: 0, eligibleUnits: 0, ineligibleUnits: 0, acceptedCommands: 0, acceptedUnits: 0, rejectedCommands: 0,
    duplicateCommands: 0, failedAdmissionCommands: 0, untrackableAcceptedUnits: 0, overflowCommands: 0, overflowUnits: 0,
    trackedCommands: 0, trackedUnits: 0, movedUnits: 0, workedUnits: 0, fullyActedCommands: 0, partiallyActedCommands: 0,
    canceledUnits: 0, revisionCensoredUnits: 0, expiredUnits: 0, boundaryCensoredUnits: 0 };
  private latencies = new Map<CoverageKind, Map<typeof coverageLatencyNames[number], Samples>>(
    (['move', 'gather'] as const).map(kind => [kind, new Map(coverageLatencyNames.map(name => [name, new Samples()]))]));
  constructor(private readonly now: () => number = diagnosticNow) {}
  private sample(kind: CoverageKind, name: typeof coverageLatencyNames[number], value: number): void { this.latencies.get(kind)!.get(name)!.add(value); }
  candidate(playerId: string, envelope: unknown, state: MotionState, queuedAtMs: number): ActionCoverageCandidate | undefined {
    const input = envelope as { clientCommandId?: unknown; clientSequence?: unknown; command?: { kind?: string; queued?: unknown; unitIds?: unknown; targetId?: unknown } } | null;
    if (!input || !['move', 'gather'].includes(input.command?.kind ?? '')) return;
    this.counts.submittedCommands++;
    if (input.command?.queued !== false) { this.counts.queuedOrUnsupportedCommands++; return; }
    if (typeof input.clientCommandId !== 'string' || !input.clientCommandId || input.clientCommandId.length > 96 ||
      typeof input.clientSequence !== 'number' || !Number.isSafeInteger(input.clientSequence) || input.clientSequence < 1 ||
      !Array.isArray(input.command.unitIds) || !input.command.unitIds.length || input.command.unitIds.length > 200 ||
      input.command.unitIds.some(id => typeof id !== 'string' || !id || id.length > 96) || new Set(input.command.unitIds).size !== input.command.unitIds.length) {
      this.counts.invalidEnvelopes++; return;
    }
    const kind = input.command.kind as CoverageKind, ids = input.command.unitIds as string[];
    this.counts.submittedUnits += ids.length;
    const eligibleIds = ids.filter(id => { const unit = state.entities[id]; return unit?.kind === 'unit' && unit.ownerId === playerId && unit.hp > 0 && !unit.garrisonedIn && (kind === 'move' || unit.typeId === 'villager'); });
    this.counts.eligibleUnits += eligibleIds.length; this.counts.ineligibleUnits += ids.length - eligibleIds.length;
    if (eligibleIds.length) this.counts.eligibleCommands++;
    return { kind, playerId, matchId: state.matchId, epoch: state.matchEpoch, commandId: input.clientCommandId, commandSequence: input.clientSequence,
      ...(typeof input.command.targetId === 'string' ? { targetId: input.command.targetId } : {}), queuedAtMs, admissionStartedAtMs: this.now(), eligibleIds, submittedUnits: ids.length };
  }
  admissionFailed(candidate: ActionCoverageCandidate | undefined): void {
    if (!candidate) return;
    this.counts.failedAdmissionCommands++; this.sample(candidate.kind, 'admission', this.now() - candidate.admissionStartedAtMs);
    this.sample(candidate.kind, 'queueToAdmission', candidate.admissionStartedAtMs - candidate.queuedAtMs);
  }
  accepted(candidate: ActionCoverageCandidate | undefined, fresh: boolean, accepted: boolean, state: MotionState): void {
    if (!candidate) return;
    const now = this.now(); this.sample(candidate.kind, 'admission', now - candidate.admissionStartedAtMs);
    this.sample(candidate.kind, 'queueToAdmission', candidate.admissionStartedAtMs - candidate.queuedAtMs);
    if (!accepted) { this.counts.rejectedCommands++; return; }
    if (!fresh) { this.counts.duplicateCommands++; return; }
    this.counts.acceptedCommands++; this.counts.acceptedUnits += candidate.eligibleIds.length;
    const units: CoverageUnit[] = candidate.eligibleIds.flatMap(id => {
      const unit = state.entities[id];
      return unit?.kind === 'unit' && unit.hp > 0 && unit.ownerId === candidate.playerId && !unit.garrisonedIn && Number.isSafeInteger(unit.orderRevision)
        ? [{ id, revision: unit.orderRevision!, xMm: unit.xMm, zMm: unit.zMm }] : [];
    });
    this.counts.untrackableAcceptedUnits += candidate.eligibleIds.length - units.length;
    if (!units.length) return;
    if (this.pending.length >= COVERAGE_COMMAND_LIMIT || this.pending.reduce((sum, group) => sum + group.units.length, 0) + units.length > COVERAGE_UNIT_LIMIT) {
      this.counts.overflowCommands++; this.counts.overflowUnits += units.length; return;
    }
    const { eligibleIds: _eligibleIds, ...details } = candidate;
    const group: CoverageGroup = { ...details, acceptedAtMs: now, acceptedTick: state.tick, eligibleUnits: candidate.eligibleIds.length, units,
      firstMovementRecorded: false, allMovementRecorded: false, firstWorkRecorded: false, allWorkRecorded: false };
    this.counts.trackedCommands++; this.counts.trackedUnits += units.length;
    if (state.status !== 'RUNNING' || state.matchId !== group.matchId || state.matchEpoch !== group.epoch) {
      for (const unit of units) { unit.outcome = 'boundaryCensored'; this.counts.boundaryCensoredUnits++; }
      this.complete(group, now); return;
    }
    this.pending.push(group);
  }
  private complete(group: CoverageGroup, now: number): void {
    group.closedAtMs = now;
    const acted = group.units.filter(unit => unit.outcome === 'acted').length;
    if (acted === group.eligibleUnits) this.counts.fullyActedCommands++; else if (acted) this.counts.partiallyActedCommands++;
    this.completed.push(group); this.retainedCompletedUnits += group.units.length;
    while (this.completed.length > COVERAGE_COMMAND_LIMIT || this.retainedCompletedUnits > COVERAGE_UNIT_LIMIT) {
      this.retainedCompletedUnits -= this.completed.shift()!.units.length; this.completedEvicted++;
    }
  }
  observe(state: MotionState, actions: readonly { id: string; kind: string }[]): void {
    if (!this.pending.length) return;
    const now = this.now(), committed = new Map(actions.map(action => [action.id, action.kind]));
    this.pending = this.pending.filter(group => {
      for (const unit of group.units) {
        if (unit.outcome) continue;
        const live = state.entities[unit.id];
        if (group.matchId !== state.matchId || group.epoch !== state.matchEpoch || state.status !== 'RUNNING') { unit.outcome = 'boundaryCensored'; this.counts.boundaryCensoredUnits++; continue; }
        if (now - group.acceptedAtMs > COVERAGE_TIMEOUT_MS) { unit.outcome = 'expired'; this.counts.expiredUnits++; continue; }
        if (!live || live.hp <= 0 || live.ownerId !== group.playerId || live.garrisonedIn) { unit.outcome = 'canceled'; this.counts.canceledUnits++; continue; }
        if (live.orderRevision !== unit.revision) { unit.outcome = 'revisionCensored'; this.counts.revisionCensoredUnits++; continue; }
        const action = committed.get(unit.id), order = live.orders?.[0] as { kind?: string; targetId?: string } | undefined;
        if (order?.kind !== group.kind || group.kind === 'gather' && order.targetId !== group.targetId) { unit.outcome = 'canceled'; this.counts.canceledUnits++; continue; }
        if (unit.firstMoveTick === undefined && (action === 'move' || action === 'carry') && (live.xMm !== unit.xMm || live.zMm !== unit.zMm)) {
          unit.firstMoveTick = state.tick; unit.firstMoveAtMs = now; this.counts.movedUnits++;
          this.sample(group.kind, 'acceptedToUnitMovement', now - group.acceptedAtMs);
          if (!group.firstMovementRecorded) { group.firstMovementRecorded = true; this.sample(group.kind, 'acceptedToFirstMovement', now - group.acceptedAtMs); }
        }
        if (group.kind === 'gather' && unit.firstWorkTick === undefined && ['gather_food', 'gather_wood', 'mine'].includes(action ?? '')) {
          unit.firstWorkTick = state.tick; unit.firstWorkAtMs = now; this.counts.workedUnits++;
          this.sample(group.kind, 'acceptedToUnitWork', now - group.acceptedAtMs);
          if (!group.firstWorkRecorded) { group.firstWorkRecorded = true; this.sample(group.kind, 'acceptedToFirstWork', now - group.acceptedAtMs); }
        }
        if (group.kind === 'move' ? unit.firstMoveTick !== undefined : unit.firstWorkTick !== undefined) unit.outcome = 'acted';
      }
      if (!group.allMovementRecorded && group.units.length === group.eligibleUnits && group.units.every(unit => unit.firstMoveTick !== undefined)) { group.allMovementRecorded = true; this.sample(group.kind, 'acceptedToAllMovement', now - group.acceptedAtMs); }
      if (group.kind === 'gather' && !group.allWorkRecorded && group.units.length === group.eligibleUnits && group.units.every(unit => unit.firstWorkTick !== undefined)) { group.allWorkRecorded = true; this.sample(group.kind, 'acceptedToAllWork', now - group.acceptedAtMs); }
      if (group.units.some(unit => !unit.outcome)) return true;
      this.complete(group, now); return false;
    });
  }
  reset(): void {
    const now = this.now();
    for (const group of this.pending) {
      for (const unit of group.units) if (!unit.outcome) { unit.outcome = 'boundaryCensored'; this.counts.boundaryCensoredUnits++; }
      this.complete(group, now);
    }
    this.pending = [];
  }
  snapshot() {
    const describe = (group: CoverageGroup) => ({ kind: group.kind, playerId: group.playerId, matchId: group.matchId, epoch: group.epoch,
      commandId: group.commandId, commandSequence: group.commandSequence, targetId: group.targetId, acceptedTick: group.acceptedTick,
      queuedAtMs: group.queuedAtMs, admissionStartedAtMs: group.admissionStartedAtMs, acceptedAtMs: group.acceptedAtMs, closedAtMs: group.closedAtMs,
      submittedUnits: group.submittedUnits, eligibleUnits: group.eligibleUnits, trackedUnits: group.units.length, movedUnits: group.units.filter(unit => unit.firstMoveTick !== undefined).length,
      workedUnits: group.units.filter(unit => unit.firstWorkTick !== undefined).length, pendingUnits: group.units.filter(unit => !unit.outcome).length,
      units: group.units.map(({ xMm: _x, zMm: _z, ...unit }) => ({ ...unit })) });
    return { scope: 'Host-private gateway-command admission coverage, not browser-issued or delivered/rendered latency. Fresh accepted nonqueued Move/Gather commands; all eligible own units, including already-moving units. Move requires committed displacement; Gather requires committed resource work and may need no movement. Order-revision changes are censored, including internal gather phase changes; cancellations are observed loss/replacement, not proof of a user Stop. Pending/exhausted planning never implies unreachable. Latency samples report successful stages only; expiry, pending, partial coverage and overflow remain explicit.',
      clock: 'host-monotonic-hrtime-ms', timingQualificationEligible: false,
      limits: { pendingCommands: COVERAGE_COMMAND_LIMIT, pendingUnits: COVERAGE_UNIT_LIMIT, completedCommands: COVERAGE_COMMAND_LIMIT, completedUnits: COVERAGE_UNIT_LIMIT, timeoutMs: COVERAGE_TIMEOUT_MS },
      counts: { ...this.counts }, pendingCommands: this.pending.length, pendingUnits: this.pending.reduce((sum, group) => sum + group.units.filter(unit => !unit.outcome).length, 0),
      completedEvicted: this.completedEvicted, latencies: Object.fromEntries([...this.latencies].map(([kind, samples]) => [kind, Object.fromEntries([...samples].map(([name, values]) => [name, values.snapshot()]))])),
      pending: this.pending.map(describe), completed: this.completed.map(describe) };
  }
}
