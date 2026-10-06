import { parentPort, workerData } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { freemem, totalmem } from 'node:os';
import { createSimulation, createLiveSimulation, restoreSimulation, restoreLiveSimulation, ReplayRunner, type Simulation, type LiveSimulation } from '@frontier/simulation';
import { balance, type PlayerView } from '@frontier/shared';
import { engineIdentity } from './build-info.js';
import { ActivityDiagnostics } from './activity-diagnostics.js';
import { ActionCoverageDiagnostics, diagnosticNow, IsolateRuntimeDiagnostics, MovementDiagnostics, PerformanceDiagnostics, WorkerCallbackDiagnostics, WorkerCallbackSpan, WorkerCycleDiagnostics, WorkerOverloadDiagnostics, WorkerSimulationStageDiagnostics, type ActionCoverageCandidate, type WorkerCallbackPhase, type PublicationStamp } from './performance-diagnostics.js';
import { FogProducer, type FogTransfer } from './worker-fog-transfer.js';
import { PathWorkerPool, PathWorkerService } from './path-worker-pool.js';
import { VisionWorkerPool } from './vision-worker-pool.js';
import { ProjectionCredits, type ProjectionPatch } from '../../../packages/simulation/src/recipient-projection.js';
import { isNativeProjectionPort, nativeProjectionHeader, postNativeProjection, type NativeProjection } from '../../../packages/simulation/src/recipient-projection-native.js';
import { createNativeCommandBatch } from '../../../packages/simulation/src/command-admission-native.js';
import { SimulationPacing } from './simulation-pacing.js';
import { PlanningStallMonitor } from './planning-stall-monitor.js';
import { detachLiveSimulationRead } from '../../../packages/simulation/src/live-simulation-owner.js';

if (!parentPort) throw new Error('SIMULATION_WORKER_REQUIRED');
const port = parentPort;
const nativeProjectionPort = isNativeProjectionPort(port) ? port : undefined;
class ProjectionPublicationError extends Error {
  constructor(cause: unknown) { super('PROJECTION_PUBLICATION_FAILED', { cause }); }
}
const performanceMetrics = workerData?.performanceDiagnostics === true ? new PerformanceDiagnostics() : undefined;
const fogProducer = workerData?.fogTransfer === true ? new FogProducer() : undefined;
const projectionCredits = workerData?.projectionTransfer === true ? new ProjectionCredits() : undefined;
const projectionRevisions = new Map<string, number>();
const projectionRequests = new Map<string, number>();
let projectionIdentity = '';
let projectionFlushSerial = 0;
let projectionFlushPending: { token: number; generation: number } | undefined;
let projectionFlushTimer: ReturnType<typeof setImmediate> | undefined;
function resetProjection() {
  if (!projectionCredits) return;
  if (projectionFlushTimer !== undefined) clearImmediate(projectionFlushTimer);
  projectionFlushTimer = undefined; projectionFlushPending = undefined;
  projectionRevisions.clear(); simulation?.resetPublication();
  projectionIdentity = simulation ? `${simulation.state.matchId}:${simulation.state.matchEpoch}` : '';
  port.postMessage({ type: 'projection-reset', generation: projectionCredits.reset() });
  projectionCredits.subscribe(subscribers);
}
const fogStamps = new Map<string, PublicationStamp>();
function resetFog() {
  projectionRequests.clear();
  if (fogProducer) { fogStamps.clear(); port.postMessage({ type: 'view-reset', generation: fogProducer.reset() }); }
  resetProjection();
}
function postFog(playerId: string, transfer: FogTransfer) {
  const stamp = fogStamps.get(playerId); fogStamps.delete(playerId);
  const post = () => port.postMessage({ type: 'fog-view', playerId, transfer,
    ...(stamp ? { performanceStamp: { ...stamp, postedAtMs: performanceMetrics!.now() } } : {}) });
  if (performanceMetrics) { performanceMetrics.measure('viewPost', post); performanceMetrics.count('publishedViews'); }
  else post();
}
const movementMetrics = performanceMetrics && new MovementDiagnostics(performanceMetrics);
const actionCoverage = performanceMetrics && new ActionCoverageDiagnostics(performanceMetrics.now);
const workerClock = performanceMetrics?.now ?? (() => performance.now());
const overloadMetrics = new WorkerOverloadDiagnostics(workerClock, performanceMetrics ? 256 : 16);
const callbackMetrics = performanceMetrics && new WorkerCallbackDiagnostics(performanceMetrics.now);
const cycleMetrics = new WorkerCycleDiagnostics();
const simulationStages = performanceMetrics && new WorkerSimulationStageDiagnostics(performanceMetrics.now);
const isolateMetrics = performanceMetrics && new IsolateRuntimeDiagnostics('simulation-worker', performanceMetrics.now);
let callbackSpan: WorkerCallbackSpan | undefined;
function callbackPhase<T>(phase: WorkerCallbackPhase, operation: () => T): T { return callbackSpan ? callbackSpan.measure(phase, operation) : operation(); }
let completedTick = -1, completedAtMs = 0, completedMatchId = '', completedEpoch = -1;
function resetCompletion() { pendingOldestAtMs=undefined;promotedCommands=0;resetPlanningRecovery(); publicationTicks.clear(); tickDurations.length=0; callbackDurations.length=0; cycleMetrics.reset(); completedTick = -1; completedAtMs = 0; completedMatchId = ''; completedEpoch = -1; movementMetrics?.reset(); actionCoverage?.reset(); }
function cycleBoundary(){const state=simulation?.state;return state?{matchId:state.matchId,matchEpoch:state.matchEpoch,status:state.status}:undefined;}
function renewalState(playerId:string){if(!simulation)return undefined;const state=simulation.state,commander=state.controllers[playerId],economy=state.economies[playerId],statistics=economy?.statistics;if(!commander||!statistics||!economy)return undefined;return {matchId:state.matchId,matchEpoch:state.matchEpoch,playerId,controllerGeneration:commander.generation,tick:state.tick,status:state.status,alive:!economy.defeated,mode:commander.mode,reason:commander.reason,plan:commander.plan?{generation:commander.plan.generation,acceptedTick:commander.plan.acceptedTick,expiresTick:commander.plan.expiresTick}:null,statistics:{modelReadyTicks:statistics.modelReadyTicks,fallbackTicks:statistics.fallbackTicks,inferenceFailures:statistics.inferenceFailures}};}
let simulation: Simulation | LiveSimulation | undefined;
let pathPool:PathWorkerPool|PathWorkerService|undefined;
let visionPool:VisionWorkerPool|undefined;
async function attachComputeWorkers(){
  await pathPool?.close();pathPool=undefined;
  await visionPool?.close();visionPool=undefined;
  const pathCount=workerData?.planningWorkers??2,visionCount=frameMs===300?(workerData?.coarseVisionWorkers??0):(workerData?.visionWorkers??2);
  if(pathCount>0){
    const options={workerCount:pathCount,performanceDiagnostics:Boolean(performanceMetrics)};
    pathPool=frameMs===300?new PathWorkerService(options,elapsedMs=>{
      const insideCallback=callbackSpan!==undefined,state=cycleBoundary();
      cycleMetrics.observeCoordinatorWork(state,elapsedMs,insideCallback);
      if(!insideCallback&&state?.status==='RUNNING')pacing.observeCallback(performance.now(),elapsedMs,0,Math.max(0,performance.now()-nextTick),queuedWorkAge(performance.now()),cadencePlanningBlocked(),recoveryMemoryPressure());
    }):new PathWorkerPool(options);
    await simulation!.attachPlanningExecutor(pathPool);
  }
  // The coarse threaded lane is opt-in: exact contact dependencies can make
  // repeated IPC slower than retained inline masks. Both profiles retain exact
  // per-contact visibility. Source deltas
  // and unchanged unions stay in persistent workers while the coordinator
  // prepares actor membership; frame boundary RPCs remain ordered below.
  if(visionCount>0){visionPool=new VisionWorkerPool({size:visionCount,performanceDiagnostics:Boolean(performanceMetrics),...(frameMs===300?{retryDelayMs:5000}:{})});simulation!.attachVisionExecutor((frame,binding)=>visionPool!.compute(frame,binding));}
}
// A yielding tick never shares mutable state with an RPC or another timer tick.
let boundaryBusy=false;
const boundaryMessages:any[]=[];
const boundaryArrival=new WeakMap<object,number>();
const BOUNDARY_MESSAGES_PER_TURN=16;
const URGENT_COMMAND_BURST=4;
let promotedCommands=0;
let boundaryContinuation:ReturnType<typeof setImmediate>|undefined;
let boundaryYields=0;
function nextBoundaryMessage(){
  // Stop/cancel can bring its player's earlier FIFO prefix forward through
  // unrelated commands. Any control/RPC is a fence; it is never crossed.
  // After four promotions, admit the oldest item, even under an urgent stream.
  if(promotedCommands<URGENT_COMMAND_BURST&&boundaryMessages[0]?.type==='command'){
    const firstByPlayer=new Map<string,number>();
    for(let index=0;index<boundaryMessages.length;index++){
      const message=boundaryMessages[index];if(message.type!=='command')break;
      if(typeof message.playerId!=='string')continue;
      if(!firstByPlayer.has(message.playerId))firstByPlayer.set(message.playerId,index);
      const kind=message.command?.command?.kind;
      if(kind==='stop'||kind==='cancel_job'||kind==='cancel_foundation'){
        const first=firstByPlayer.get(message.playerId)!;
        if(first>0){promotedCommands++;return boundaryMessages.splice(first,1)[0];}
        break;
      }
    }
  }
  promotedCommands=0;return boundaryMessages.shift();
}
async function drainBoundaryMessages(){
  if(boundaryBusy||boundaryContinuation!==undefined)return;boundaryBusy=true;
  try{
    // RPCs and each player's commands preserve FIFO at committed boundaries.
    // Urgent command prefixes can enter this bounded turn before unrelated
    // commands; the later authoritative drain still validates every command.
    // Yield the event
    // loop after a fixed number so a sustained burst cannot monopolize timers.
    // This never changes per-tick simulation/path budgets or drops accepted work.
    for(let count=0;count<BOUNDARY_MESSAGES_PER_TURN&&boundaryMessages.length;count++)await handleMessage(nextBoundaryMessage());
  }finally{
    boundaryBusy=false;
    if(boundaryMessages.length){boundaryYields++;boundaryContinuation=setImmediate(function continueBoundaryMessages(){boundaryContinuation=undefined;void drainBoundaryMessages();});}
  }
}
function enqueueBoundaryMessage(message:any){
  if(boundaryMessages.length>=4096){if(message.type==='view-credit'||message.type==='projection-credit'||message.type==='projection-restart'||message.type==='projection-flush')throw new Error('WORKER_BOUNDARY_QUEUE_OVERFLOW');reply(message.id,undefined,'SERVER_BUSY');return;}
  if(message&&typeof message==='object')boundaryArrival.set(message,performance.now());
  boundaryMessages.push(message);void drainBoundaryMessages();
}
port.on('message',enqueueBoundaryMessage);
function scheduleProjectionFlush() {
  if (!projectionCredits || projectionFlushPending) return;
  const pending = { token: ++projectionFlushSerial, generation: projectionCredits.generation };
  projectionFlushPending = pending;
  // Collect credit returns for one event-loop turn. The marker still enters the
  // serialized boundary queue, so it cannot inspect a yielding simulation phase.
  projectionFlushTimer = setImmediate(() => {
    if (projectionFlushPending !== pending) return;
    projectionFlushTimer = undefined;
    enqueueBoundaryMessage({ type: 'projection-flush', ...pending });
  });
}
let replay: ReplayRunner | undefined;
let replayBounds: { startTick: number; endTick: number } | undefined;
let subscribers: string[] = [];
let pending: { id: number; playerId: string; command: unknown; diagnosticSentAtMs?: number; requestExpiresAtMs?:number; queuedAtMs?:number }[] = [];
let pendingOldestAtMs:number|undefined;
const sequences = new Map<string, number>();
let nextTick = performance.now();
const tickMs = 1000 / balance.rules.simulationHz;
const configuredFrameMs:50|300=workerData?.authoritativeIntervalMs??balance.rules.authoritativeFrameMs;
let frameMs:50|300=configuredFrameMs;
let pacing = new SimulationPacing(frameMs, workerData?.overloadPolicy ?? 'adaptive');
const publicationTicks=new Map<string,number>();
let planningSampleAt=-Infinity,planningRecoveryBacklog=true;
const planningStalls=new PlanningStallMonitor();let planningStallSampleAt=-Infinity;
let memorySampleAt=-Infinity,memoryPressure=false;
function recoveryMemoryPressure():boolean{
  const now=performance.now();if(now-memorySampleAt>=5000){
    // Recovery must leave physical room for this host's model and browsers.
    // This inhibits a speed-up; it never changes or terminates another process.
    const available=freemem(),total=totalmem();
    memoryPressure=!Number.isFinite(available)||!Number.isFinite(total)||available<Math.max(512*1024*1024,total*.03);memorySampleAt=now;
  }
  return memoryPressure;
}
function resetPlanningRecovery(){planningSampleAt=-Infinity;planningRecoveryBacklog=true;planningStalls.reset();planningStallSampleAt=-Infinity;}
function recoverPlanningStalls():void{
  if(!simulation||simulation.state.status!=='RUNNING'){planningStalls.reset();planningStallSampleAt=-Infinity;return;}
  const now=performance.now();if(now-planningStallSampleAt<1000)return;
  const proposals=planningStalls.observe(simulation.stalledPlanningCandidates(),now,`${simulation.state.matchId}:${simulation.state.matchEpoch}`);
  if(proposals.length)simulation.recoverStalledPlanning(proposals);
  planningStallSampleAt=now;
}
function samplePlanningRecovery():void {
  if(!simulation||!pacing.needsPlanningRecoveryEvidence)return;
  const now=performance.now();if(now>=planningSampleAt&&now-planningSampleAt<1000)return;
  // Coordinator-local bounded queue ages, not a frontier capture or worker RPC.
  const queue=simulation.planningQueueDiagnostics();
  // A long-lived request may be making useful progress. Gate recovery on an
  // observed wall-time stall rather than its accumulated game-time age. Ready
  // admissions leave the monitor's pending set; retry proposals alone do not
  // erase a stall. Unknown or truncated queue evidence remains conservative.
  planningRecoveryBacklog=planningStalls.recoveryBlocked||queue.omittedRequests>0||queue.omittedProfiles>0||queue.profiles.some(profile=>profile.classes.some(row=>row.workClass!=='optional'&&row.pending>0&&row.requestAgeTicks.unknown>0));
  planningSampleAt=performance.now();
}
function cadencePlanningBlocked():boolean{return pacing.needsPlanningRecoveryEvidence&&(performance.now()<planningSampleAt||performance.now()-planningSampleAt>Math.max(1500,pacing.tickIntervalMs*2)||planningRecoveryBacklog);}
function queuedWorkAge(now:number):number {
  const boundary=boundaryMessages[0],arrival=boundary&&typeof boundary==='object'?boundaryArrival.get(boundary):undefined;
  return Math.max(0,arrival===undefined?0:now-arrival,pendingOldestAtMs===undefined?0:now-pendingOldestAtMs);
}
const tickDurations: number[] = [];
const callbackDurations: number[] = [];
let overrunSince: number | undefined;
let diagnosticMatch='',diagnosticTick=0;
let diagnosticPositions=new Map<string,{xMm:number;zMm:number}>();
const activityDiagnostics=new ActivityDiagnostics();
function diagnostics() {
  const paths=pathPool?.diagnostics(),vision=visionPool?.diagnostics();
  const planningThreads=paths?[...paths.workers.map(worker=>worker.threadId),...('serviceThreadId'in paths&&typeof paths.serviceThreadId==='number'?[paths.serviceThreadId]:[])]:[];
  const compute={planning:{mode:paths?'threads':'inline',threadIds:planningThreads.filter(id=>id>0),pending:simulation?.planningQueueDiagnostics().pending??0,recoveries:paths?.workers.reduce((sum,worker)=>sum+worker.recoveries,0)??0,degraded:planningThreads.some(id=>id<1)},vision:{mode:vision?'threads':'inline',threadIds:vision?.threadIds.filter(id=>id>0)??[],pending:vision?.busy?1:0,recoveries:vision?.recovered??0,degraded:vision?.threadIds.some(id=>id<1)??false},boundaryQueued:boundaryMessages.length};
  const sorted = [...tickDurations].sort((a, b) => a - b), callbacks=[...callbackDurations].sort((a,b)=>a-b), state=simulation?.state;
  const sample=simulation?.hostWorldDiagnostics(),key=sample?`${sample.matchId}:${sample.matchEpoch}`:'';
  if(key!==diagnosticMatch){diagnosticMatch=key;diagnosticTick=sample?.tick??0;diagnosticPositions.clear();}
  const activity={movingSinceLastSample:0,...(sample?.activity??{gathering:0,returning:0,building:0,repairing:0,blocked:0,attackCooldownActive:0})};
  const nextPositions=new Map<string,{xMm:number;zMm:number}>();
  for(const position of sample?.positions??[]){const previous=diagnosticPositions.get(position.id);if(previous&&Math.hypot(position.xMm-previous.xMm,position.zMm-previous.zMm)>1)activity.movingSinceLastSample++;nextPositions.set(position.id,position);}
  const sampledTicks=(sample?.tick??0)-diagnosticTick;diagnosticTick=sample?.tick??0;diagnosticPositions=nextPositions;
  return detachLiveSimulationRead({ tick: state?.tick ?? 0,status:state?.status??'LOBBY', tickMs: { p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, p99: sorted[Math.max(0, Math.ceil(sorted.length * .99) - 1)] ?? 0, max: sorted.at(-1) ?? 0 }, debtMs: state?.status === 'RUNNING' ? Math.max(0, performance.now() - nextTick) : 0, overrunWarning: overrunSince !== undefined && performance.now() - overrunSince >= 5000,
    callbackMs:{p50:callbacks[Math.max(0,Math.ceil(callbacks.length*.5)-1)]??0,p95:callbacks[Math.max(0,Math.ceil(callbacks.length*.95)-1)]??0,p99:callbacks[Math.max(0,Math.ceil(callbacks.length*.99)-1)]??0,max:callbacks.at(-1)??0},callbackSamples:callbacks.length,...cycleMetrics.snapshot(),
    pacing:{...pacing.snapshot(),authoritativeIntervalMs:pacing.frameIntervalMs},...(simulation?{frame:simulation.frameDiagnostics()}:{}),movementDecisions:simulation?.movementDecisionDiagnostics()??{full:0,reused:0,attempted:0},path:simulation?.pathDiagnostics()??null,compute,runtime:overloadMetrics.hostSnapshot(boundaryYields),world:sample?.world??{units:0,population:0,resourceNodes:0,activeResourceNodes:0,nonnegativeResources:true,factions:[]},activity:{...activity,sampledTicks},...(state?{activityWindow:activityDiagnostics.snapshot(state)}:{}),memory:process.memoryUsage() });
}
const reply = (id: number, value?: unknown, error?: string) => port.postMessage({ id, value, error });
function postCheckpoint(envelope: Parameters<Simulation['postNativeCapture']>[1]) {
  if (!simulation) throw new Error('NO_MATCH');
  if (simulation.postNativeCapture(port, envelope)) return;
  const payload = simulation.capture();
  if (envelope.type === 'reply') reply(envelope.id, payload);
  else port.postMessage({ type: 'checkpoint', payload, autosave: envelope.autosave });
}
function flushJournal() {
  return callbackPhase('journalCheckpoint', () => {
  if (!simulation) return;
  const started = performanceMetrics?.now();
  try {
  for (const message of simulation.drainAiMessages()) { const { playerId, ...body } = message; port.postMessage({ type: 'ai-message', playerId, message: body }); }
  for (let i = 0; i < 8; i++) {
    const batch = simulation.drainJournal();
    if (batch.events.length || batch.gapBeforeOrdinal !== undefined) port.postMessage({ type: 'journal', batch });
    if (batch.events.length < 512) break;
  }
  } finally { if (performanceMetrics) performanceMetrics.sample('journal', performanceMetrics.now() - started!); }
  });
}
function beginJournal() { callbackPhase('journalCheckpoint', () => { if (simulation) port.postMessage({ type: 'journal-start', payload: simulation.initialCapture() }); }); }
function sequenceView(view:PlayerView) { view.sequence=(sequences.get(view.playerId)??0)+1;sequences.set(view.playerId,view.sequence);return view; }
function snapshot(playerId: string) {
  if (!simulation) throw new Error('NO_MATCH');
  return sequenceView(simulation.view(playerId));
}
function publishProjected(request = true,playerIds:readonly string[]=subscribers) {
  if (!simulation || !projectionCredits) return;
  try {
  if (projectionIdentity !== `${simulation.state.matchId}:${simulation.state.matchEpoch}`) resetProjection();
  if (request) projectionCredits.request(playerIds);
  // Check committed, recipient-authorized observations even when every encoder
  // slot is busy, so urgent facts remain latched until a later credit can serve
  // them. Priority never changes an already posted transfer or its byte lease.
  if(frameMs===300)projectionCredits.prioritize(simulation.urgentPublicationRecipients(subscribers));
  // Reserve bounded byte credit before creating any recipient DTO or entity list.
  const requests = projectionCredits.eligible().map(playerId => {
    const revision = (projectionRevisions.get(playerId) ?? 0) + 1;
    projectionCredits.reserve(playerId, revision); projectionRevisions.set(playerId, revision);
    const sequence = (sequences.get(playerId) ?? 0) + 1; sequences.set(playerId, sequence);
    return { playerId, sequence };
  });
  if (!requests.length) return;
  const construct = () => nativeProjectionPort ? simulation!.publicationTransfers(requests) : simulation!.publicationProjections(requests);
  const patches = performanceMetrics ? performanceMetrics.measure('viewConstruction', construct) : construct();
  for (const patch of patches) {
    const header = nativeProjectionPort ? nativeProjectionHeader(patch as NativeProjection) : (patch as ProjectionPatch).header;
    publicationTicks.set(header.playerId,header.tick);
    // Diagnostic movement tracing intentionally uses a full reference view; the
    // normal production lane never builds it. Its cost is excluded from qualification.
    const movements = performanceMetrics ? movementMetrics!.publication(simulation.view(header.playerId), simulation.state) : undefined;
    const stamp = performanceMetrics ? { matchId: header.matchId, tick: header.tick, sequence: header.sequence, matchEpoch: header.matchEpoch,
      ...(completedMatchId === header.matchId && completedEpoch === header.matchEpoch && completedTick === header.tick ? { completedAtMs } : {}), postedAtMs: performanceMetrics.now(), ...(movements?.length ? { movements } : {}) } : undefined;
    const post = () => nativeProjectionPort ? postNativeProjection(patch as NativeProjection, nativeProjectionPort, {
      generation: projectionCredits.generation, publicationRequest: projectionRequests.get(header.playerId) ?? 0, ...(stamp ? { performanceStamp: stamp } : {}),
    }) : port.postMessage({ type: 'projection-view', playerId: header.playerId, publicationRequest: projectionRequests.get(header.playerId) ?? 0, transfer: { generation: projectionCredits.generation, patch }, ...(stamp ? { performanceStamp: stamp } : {}) });
    if (performanceMetrics) performanceMetrics.measure('viewPost', post); else post();
    performanceMetrics?.count('publishedViews');
  }
  } catch (error) { throw new ProjectionPublicationError(error); }
}
function publish(playerIds:readonly string[]=subscribers) {
  return callbackPhase('viewAssemblyPost', () => {
  if (!simulation) return;
  if (projectionCredits) { publishProjected(true,playerIds); return; }
  const views = performanceMetrics ? performanceMetrics.measure('viewConstruction', () => simulation!.views([...playerIds])) : simulation.views([...playerIds]);
  for (const view of views) {
    publicationTicks.set(view.playerId,view.tick);
    sequenceView(view);
    if (!performanceMetrics) {
      if (fogProducer) { const transfer = fogProducer.offer(view); if (transfer) postFog(view.playerId, transfer); }
      else port.postMessage({type:'view',playerId:view.playerId,view});
      continue;
    }
    const movements = movementMetrics!.publication(view, simulation.state);
    const stamp = { matchId: view.matchId, tick: view.tick, sequence: view.sequence, matchEpoch: view.matchEpoch,
      ...(completedMatchId === view.matchId && completedEpoch === view.matchEpoch && completedTick === view.tick ? { completedAtMs } : {}), postedAtMs: performanceMetrics.now(), ...(movements.length ? { movements } : {}) };
    if (fogProducer) {
      fogStamps.set(view.playerId, stamp);
      const transfer = performanceMetrics.measure('viewPost', () => fogProducer.offer(view));
      if (transfer) postFog(view.playerId, transfer); else performanceMetrics.count('fogCoalescedOffers');
    } else {
      performanceMetrics.measure('viewPost', () => port.postMessage({type:'view',playerId:view.playerId,view,performanceStamp:stamp}));
      performanceMetrics.count('publishedViews');
    }
  }
  });
}
async function handleMessage(message:any) {
  const cycleBefore=cycleBoundary();
  const expired=message.requestExpiresAtMs!==undefined&&(!Number.isFinite(message.requestExpiresAtMs)||diagnosticNow()>=message.requestExpiresAtMs);
  if (!expired&&(message.type === 'init' || message.type === 'restore' || message.type === 'replay-open')) {overloadMetrics.reset();boundaryYields=0;}
  callbackSpan = callbackMetrics?.begin(message.type) ?? new WorkerCallbackSpan(message.type,workerClock(),workerClock);
  const diagnosticSpan = overloadMetrics?.begin(message.type, simulation?.state, undefined, callbackSpan?.startedAtMs);
  if (performanceMetrics && Number.isFinite(message.diagnosticRequestSentAtMs)) performanceMetrics.sample('workerRequestQueue', callbackSpan!.startedAtMs - message.diagnosticRequestSentAtMs);
  try {
    // Expired queued requests still consume coordinator time, but never acquire
    // authority. The host-monotonic deadline is shared across worker isolates.
    if(expired){reply(message.id,undefined,'WORKER_TIMEOUT');return;}
    switch (message.type) {
      case 'projection-restart': {
        if (!projectionCredits) throw new Error('UNEXPECTED_PROJECTION_RESET');
        if (message.generation === projectionCredits.generation) { resetProjection(); scheduleProjectionFlush(); }
        return;
      }
      case 'projection-credit': {
        if (!projectionCredits) throw new Error('UNEXPECTED_PROJECTION_CREDIT');
        if (projectionCredits.acknowledge(message.playerId, message.generation, message.revision)) {
          if (message.failed && message.generation === projectionCredits.generation) resetProjection();
          scheduleProjectionFlush();
        }
        return;
      }
      case 'projection-flush': {
        if (!projectionCredits) throw new Error('UNEXPECTED_PROJECTION_FLUSH');
        const pending = projectionFlushPending;
        if (!pending || message.token !== pending.token || message.generation !== pending.generation || message.generation !== projectionCredits.generation) return;
        projectionFlushPending = undefined;
        callbackPhase('viewAssemblyPost', () => publishProjected(false));
        return;
      }
      case 'view-credit': {
        if (!fogProducer) throw new Error('UNEXPECTED_FOG_CREDIT');
        // Credits already in transit at a trusted init/restore reset are obsolete.
        if (Number.isSafeInteger(message.generation) && message.generation < fogProducer.generation) return;
        callbackPhase('viewAssemblyPost', () => {
          const transfer = fogProducer.acknowledge(message.playerId, message.generation, message.token);
          if (transfer) postFog(message.playerId, transfer);
        });
        return;
      }
      case 'replay-open': {
        if (simulation || replay) throw new Error('WORKER_ALREADY_INITIALIZED');
        resetCompletion();
        replay = new ReplayRunner(message.recording, engineIdentity);
        if (performanceMetrics) replay.simulation.enablePlanningDiagnostics(performanceMetrics.now);
        replayBounds = { startTick: message.recording.initial.payload.state.tick, endTick: message.recording.endTick };
        const first = replay.simulation.state.factions[0]!.id;
        reply(message.id, { ...replayBounds, players: replay.simulation.view(first).players }); break;
      }
      case 'replay-step': {
        if (!replay || !replayBounds) throw new Error('NO_REPLAY');
        if (!replay.simulation.state.factions.some(player => player.id === message.playerId)) throw new Error('INVALID_PLAYER');
        const result = callbackPhase('coreStep', () => replay!.advanceTo(message.targetTick, 200)), view = callbackPhase('viewAssemblyPost', () => replay!.simulation.view(message.playerId));
        view.sequence = (sequences.get(message.playerId) ?? 0) + 1; sequences.set(message.playerId, view.sequence);
        reply(message.id, { ...replayBounds, tick: result.tick, done: result.done, view }); break;
      }
      case 'init': resetCompletion(); frameMs=configuredFrameMs; pacing=new SimulationPacing(frameMs,workerData?.overloadPolicy??'adaptive'); simulation = nativeProjectionPort && !performanceMetrics ? createLiveSimulation({...message.options,authoritativeIntervalMs:frameMs}) : createSimulation({...message.options,authoritativeIntervalMs:frameMs}); pacing.reset(simulation.state.movementCadenceTier); if(simulation.state.movementCadenceTier!==pacing.cadenceTier)simulation.setMovementCadenceTier(pacing.cadenceTier); await attachComputeWorkers(); resetFog(); if (performanceMetrics) { (simulation as Simulation).enablePlanningDiagnostics(performanceMetrics.now); simulationStages!.install(simulation as unknown as Record<string, unknown>); } beginJournal(); simulation.setStatus('LOADING'); nextTick = performance.now() + pacing.tickIntervalMs; sequences.clear(); pending = []; reply(message.id, true); break;
      case 'restore':
        resetCompletion();
        simulation = nativeProjectionPort && !performanceMetrics ? restoreLiveSimulation(message.save, engineIdentity, { newEpoch: message.newEpoch }) : restoreSimulation(message.save, engineIdentity, { newEpoch: message.newEpoch }); frameMs=simulation.options.authoritativeIntervalMs??50; pacing=new SimulationPacing(frameMs,workerData?.overloadPolicy??'adaptive'); pacing.reset(simulation.state.movementCadenceTier); if(simulation.state.movementCadenceTier!==pacing.cadenceTier)simulation.setMovementCadenceTier(pacing.cadenceTier); await attachComputeWorkers(); await simulation.synchronizeCapture(); resetFog(); if (performanceMetrics) { (simulation as Simulation).enablePlanningDiagnostics(performanceMetrics.now); simulationStages!.install(simulation as unknown as Record<string, unknown>); } beginJournal();
        nextTick = performance.now() + pacing.tickIntervalMs; sequences.clear(); pending = []; callbackPhase('journalCheckpoint', () => postCheckpoint({type:'reply',id:message.id})); break;
      case 'capture':
        if (!simulation) throw new Error('NO_MATCH');
        flushJournal(); await callbackSpan!.measureAsync('journalCheckpoint',()=>simulation!.synchronizeCapture()); flushJournal(); callbackPhase('journalCheckpoint', () => postCheckpoint({type:'reply',id:message.id})); break;
      case 'assistant-configure': if(!simulation)throw new Error('NO_MATCH');reply(message.id,simulation.configureAssistant(message.playerId,message.preferences));publish();break;
      case 'assistant-state': if(!simulation)throw new Error('NO_MATCH');reply(message.id,simulation.assistantState(message.playerId));break;
      case 'assistant-release': if(!simulation)throw new Error('NO_MATCH');reply(message.id,simulation.releaseAssistantEntities(message.playerId,message.entityIds));break;
      case 'ai-model': if(!simulation)throw new Error('NO_MATCH');simulation.setAiModel(message.playerId,message.modelId);reply(message.id,true);publish();break;
      case 'ai-state': {if (!simulation) throw new Error('NO_MATCH');const state=simulation.aiSchedulingState();reply(message.id,{...state,commanders:state.commanders.map(commander=>({...commander,renewal:renewalState(commander.playerId)}))});break;}
      case 'ai-prepare': if (!simulation) throw new Error('NO_MATCH'); reply(message.id, simulation.prepareAiRequest(message.playerId, message.requestId, message.chatRequestIds)); break;
      case 'ai-complete': {if (!simulation) throw new Error('NO_MATCH');const result=simulation.completeAiRequest(message.binding,message.result);reply(message.id,{...result,renewal:renewalState(message.binding.playerId)});break;}
      case 'ai-invalidate': if (!simulation) throw new Error('NO_MATCH'); simulation.invalidateAiRequests(message.reason,message.playerIds); reply(message.id, true); break;
      case 'ai-chat': if (!simulation) throw new Error('NO_MATCH'); reply(message.id, simulation.acceptAiChat(message.request)); break;
      case 'diagnostics': reply(message.id, diagnostics()); break;
      case 'performance-diagnostics': reply(message.id, performanceMetrics ? { compute:{planning:pathPool?.diagnostics()??null,vision:visionPool?.diagnostics()??null}, worker: { ...performanceMetrics.snapshot(), callbackAccounting: callbackMetrics!.snapshot(), advancingCallbackScope: 'Complete timer callback that advanced one through four ticks; counts report ticks per callback. These are not per-tick quantiles.', simulationStageScope: WorkerSimulationStageDiagnostics.scope }, movement: movementMetrics!.snapshot(), actionCoverage: actionCoverage!.snapshot(), overload: overloadMetrics!.snapshot(), isolate: isolateMetrics!.snapshot(), planning: (simulation ?? replay?.simulation)?.planningDiagnostics() ?? null, planningQueue:(simulation??replay?.simulation)?.planningQueueDiagnostics()??null } : null); break;
      case 'subscribe': {
        if (!Array.isArray(message.playerIds) || message.playerIds.length > 11 || new Set(message.playerIds).size !== message.playerIds.length || message.playerIds.some((id: unknown) => typeof id !== 'string' || !simulation?.state.economies[id])) throw new Error('INVALID_SUBSCRIBERS');
        const changed = subscribers.length !== message.playerIds.length || subscribers.some(id => !message.playerIds.includes(id));
        subscribers = message.playerIds;
        for(const playerId of publicationTicks.keys())if(!subscribers.includes(playerId))publicationTicks.delete(playerId);
        for (const playerId of projectionRequests.keys()) if (!subscribers.includes(playerId)) projectionRequests.delete(playerId);
        if (changed && projectionCredits) { resetProjection(); publishProjected(false); }
        reply(message.id, true); break;
      }
      case 'publication-request': {
        if (!simulation || !projectionCredits) throw new Error('PROJECTION_PUBLICATION_UNAVAILABLE');
        if (typeof message.playerId !== 'string' || !subscribers.includes(message.playerId) || !Object.hasOwn(simulation.state.economies, message.playerId)) throw new Error('NOT_AUTHORIZED');
        if (message.matchId !== simulation.state.matchId || message.matchEpoch !== simulation.state.matchEpoch) throw new Error('MATCH_CHANGED');
        if (!Number.isSafeInteger(message.publicationRequest) || message.publicationRequest <= (projectionRequests.get(message.playerId) ?? 0)) throw new Error('STALE_PUBLICATION_REQUEST');
        projectionRequests.set(message.playerId, message.publicationRequest);
        projectionCredits.request([message.playerId]);
        callbackPhase('viewAssemblyPost', () => publishProjected(false));
        reply(message.id, true); break;
      }
      case 'view': callbackPhase('viewAssemblyPost', () => reply(message.id, snapshot(message.playerId))); break;
      case 'command':
        if (!simulation) throw new Error('NO_MATCH');
        if (pending.length >= 2048) throw new Error('SERVER_BUSY');
        // Intake changes no authoritative state or journal. The timer flushes
        // the journal after actual admission, preserving receipt/event order.
        {const queuedAtMs=boundaryArrival.get(message)??performance.now();pendingOldestAtMs=Math.min(pendingOldestAtMs??queuedAtMs,queuedAtMs);pending.push({...message,queuedAtMs});}return;
      case 'status':
        if (!simulation) throw new Error('NO_MATCH');
        if (message.invalidate) simulation.invalidateEpoch();
        simulation.setStatus(message.status); pacing.resume(); resetPlanningRecovery(); nextTick = performance.now() + pacing.tickIntervalMs; reply(message.id, { matchEpoch: simulation.state.matchEpoch }); publish(); break;
      case 'end-draw':
        if (!simulation) throw new Error('NO_MATCH');
        simulation.endAsDraw(); port.postMessage({ type: 'status', status: simulation.state.status, matchEpoch: simulation.state.matchEpoch });
        reply(message.id, true); publish(); break;
      case 'control-mode':
        if (!simulation) throw new Error('NO_MATCH');
        simulation.setControlMode(message.playerId, message.mode); reply(message.id, true); publish(); break;
      case 'surrender': {
        if (!simulation) throw new Error('NO_MATCH');
        simulation.adminSurrender(message.playerId);
        if (simulation.state.status === 'FINISHED') port.postMessage({ type: 'status', status: 'FINISHED', matchEpoch: simulation.state.matchEpoch });
        reply(message.id, true); publish(); break;
      }
      default: throw new Error('UNKNOWN_WORKER_OPERATION');
    }
    flushJournal();
  } catch (error) {
    // An invalid internal credit cannot be answered as an ordinary RPC: leaving
    // the sender waiting would silently stall a recipient. Fail the worker closed.
    if (error instanceof ProjectionPublicationError || message.type === 'view-credit' || message.type === 'projection-credit' || message.type === 'projection-flush') throw error;
    reply(message.id, undefined, error instanceof Error ? error.message : 'WORKER_ERROR');
  }
  finally {
    const accounting = callbackSpan && (callbackMetrics ? callbackMetrics.finish(callbackSpan) : callbackSpan.finish()); callbackSpan = undefined;
    if(accounting)cycleMetrics.observe(cycleBefore,cycleBoundary(),accounting,false);
    if (accounting && simulation?.state.status === 'RUNNING') pacing.observeCallback(performance.now(),accounting.totalMs,0,Math.max(0,performance.now()-nextTick),queuedWorkAge(performance.now()),cadencePlanningBlocked(),recoveryMemoryPressure());
    if (diagnosticSpan) overloadMetrics!.finish(diagnosticSpan, simulation?.state, [], accounting);
  }
}
async function runTimer() {
  const cycleBefore=cycleBoundary();
  callbackSpan = callbackMetrics?.begin('timer') ?? new WorkerCallbackSpan('timer',workerClock(),workerClock);
  simulationStages?.beginCallback();
  const callbackStarted = callbackSpan?.startedAtMs;
  let diagnosticSpan: ReturnType<WorkerOverloadDiagnostics['begin']> | undefined;
  const stepsMs: number[] = [];
  let advancedTicks = 0;
  try {
  if (!simulation) return;
  const now = performance.now();
  diagnosticSpan = overloadMetrics?.begin('timer', simulation.state, simulation.state.status === 'RUNNING' ? Math.max(0, now - nextTick) : undefined, callbackStarted);
  // Capture current scheduling debt before this callback changes pacing.
  if (performanceMetrics && simulation.state.status === 'RUNNING') performanceMetrics.sample('tickDebt', Math.max(0, now - nextTick));
  if (simulation.state.status === 'RUNNING') {
    const previousIntervalMs=pacing.tickIntervalMs;
    const adjustment = pacing.review(now, Math.max(0, now - nextTick), simulation.state.tick);
    if ((adjustment === 'pause'||adjustment === 'reduced'||adjustment === 'self-paced') && diagnosticSpan) overloadMetrics.captureOverload(diagnosticSpan,boundaryMessages.length,pending.length);
    if (adjustment === 'pause') {
      simulation.setStatus('PAUSED'); simulation.invalidateEpoch();
      port.postMessage({ type: 'status', status: 'PAUSED', matchEpoch: simulation.state.matchEpoch }); publish();
    } else if (adjustment === 'reduced' || adjustment === 'recovered') {
      simulation.setPresentationSpeed(pacing.speed);
      if (adjustment === 'recovered') nextTick = Math.min(nextTick,now+pacing.tickIntervalMs);
    } else if(adjustment === 'tier-changed') {
      simulation.setMovementCadenceTier(pacing.cadenceTier);
      // The pending commit now represents a different amount of game time.
      // Move its deadline by that difference; do not grant a longer frame at
      // the old short deadline or discard existing scheduling debt.
      nextTick += pacing.tickIntervalMs-previousIntervalMs;
      resetPlanningRecovery();
      publish(); // Publish changed interpolation cadence at this committed boundary.
    }
    nextTick = pacing.boundDeadline(nextTick, now);
  }
  const commandStarted = performanceMetrics?.now();
  callbackPhase('commandDrain', () => {
  pendingOldestAtMs=undefined;
  // The fixed native drain owns expiry and each immediate reply. Diagnostic
  // observers and non-native callbacks retain the original scalar loop below.
  if (!performanceMetrics && nativeProjectionPort) {
    if (pending.length) simulation!.drainNativeCommands(createNativeCommandBatch(port, pending.splice(0)));
    return;
  }
  for (const item of pending.splice(0)) {
    if(item.requestExpiresAtMs!==undefined&&diagnosticNow()>=item.requestExpiresAtMs){reply(item.id,undefined,'WORKER_TIMEOUT');continue;}
    let coverageCandidate: ActionCoverageCandidate | undefined;
    try {
      if (!performanceMetrics) { reply(item.id, simulation!.command(item.playerId, item.command)); continue; }
      const now = performanceMetrics.now(), queuedAt = Number.isFinite(item.diagnosticSentAtMs) ? item.diagnosticSentAtMs! : now;
      performanceMetrics.sample('commandQueue', now - queuedAt);
      const beforeSequence = simulation!.state.economies[item.playerId]?.lastClientSequence ?? -1;
      const candidate = movementMetrics!.candidate(item.playerId, item.command, simulation!.state, queuedAt);
      coverageCandidate = actionCoverage!.candidate(item.playerId, item.command, simulation!.state, queuedAt);
      const receipt = performanceMetrics.measure('commandAdmission', () => simulationStages!.externalAdmission(simulation!.state, () => simulation!.command(item.playerId, item.command)));
      movementMetrics!.accepted(candidate, receipt.sequence > beforeSequence, receipt.status === 'accepted', simulation!.state);
      actionCoverage!.accepted(coverageCandidate, receipt.sequence > beforeSequence, receipt.status === 'accepted', simulation!.state);
      reply(item.id, receipt);
    }
    catch { actionCoverage?.admissionFailed(coverageCandidate); reply(item.id, undefined, 'COMMAND_FAILED'); }
  }
  });
  if (performanceMetrics) performanceMetrics.sample('commandDrain', performanceMetrics.now() - commandStarted!);
  if (simulation.state.status !== 'RUNNING') { recoverPlanningStalls(); movementMetrics?.observe(simulation.state, []); actionCoverage?.observe(simulation.state, []); nextTick = now + pacing.tickIntervalMs; flushJournal(); return; }
  // Commands remain responsive even while a slowed clock waits for its next tick.
  if (now < nextTick) { flushJournal(); return; }
  // Every fixed-duration game step is retained. Only its wall deadline changes.
  for (let i = 0; i < pacing.maximumCatchUpSteps && now >= nextTick; i++) {
    if (performanceMetrics) callbackPhase('activityProjection', () => performanceMetrics.measure('activity', () => activityDiagnostics.synchronize(simulation!.state)));
    else callbackPhase('activityProjection',()=>activityDiagnostics.synchronize(simulation!.state));
    const beforeTick=simulation.state.tick;
    simulation.setPlanningServiceLeases(Math.min(60,Math.max(1,Math.ceil(pacing.tickIntervalMs/50))));
    const stepStart = performance.now();
    await callbackSpan!.measureAsync('coreStep', () => simulationStages ? simulationStages.stepAsync(simulation!.state, () => simulation!.advanceFrameAsync()) : simulation!.advanceFrameAsync());
    const duration = performance.now() - stepStart; tickDurations.push(duration); if (tickDurations.length > 1200) tickDurations.shift();
    stepsMs.push(duration);
    callbackPhase('activityProjection',()=>recoverPlanningStalls());
    if (performanceMetrics) {
      advancedTicks++;
      completedTick = simulation.state.tick; completedMatchId = simulation.state.matchId; completedEpoch = simulation.state.matchEpoch; completedAtMs = performanceMetrics.now();
      callbackPhase('activityProjection', () => {
        const actions = simulation!.committedUnitActions();
        performanceMetrics.measure('activity', () => activityDiagnostics.observeFrame(simulation!.state, simulation!.committedFrameActions()));
        movementMetrics!.observe(simulation!.state, actions);
        actionCoverage!.observe(simulation!.state, actions);
      });
    } else callbackPhase('activityProjection',()=>activityDiagnostics.observeFrame(simulation!.state,simulation!.committedFrameActions()));
    if (duration > simulation.authoritativeFrameIntervalMs) overrunSince ??= stepStart; else overrunSince = undefined;
    nextTick += pacing.tickIntervalMs;
    if (Math.floor(simulation.state.tick/(60*balance.rules.simulationHz))>Math.floor(beforeTick/(60*balance.rules.simulationHz))) {
      await callbackSpan!.measureAsync('journalCheckpoint',()=>simulation!.synchronizeCapture());
      flushJournal();
      if (performanceMetrics) callbackPhase('journalCheckpoint', () => performanceMetrics.measure('checkpoint', () => postCheckpoint({type:'checkpoint',autosave:true})));
      else callbackPhase('journalCheckpoint',()=>postCheckpoint({type:'checkpoint',autosave:true}));
    }
    if ((simulation.state.status as string) === 'FINISHED') { port.postMessage({ type: 'status', status: 'FINISHED', matchEpoch: simulation.state.matchEpoch }); publish(); break; }
    if(frameMs===300){publish();}
    else if(pacing.cadenceTier<2){
      if(simulation.state.tick%(balance.rules.simulationHz/balance.rules.replicationHz)===0)publish();
    }else{
      const urgent=new Set(simulation.urgentPublicationRecipients(subscribers));
      const due=subscribers.filter(playerId=>urgent.has(playerId)||simulation!.state.tick-(publicationTicks.get(playerId)??-Infinity)>=pacing.publicationIntervalMs/tickMs);
      if(due.length)publish(due);
    }
    // Service waiting controls/commands at this completed tick before another
    // catch-up step. Their arrival cannot expose or mutate an incomplete phase.
    if (boundaryMessages.length) break;
  }
  flushJournal();
  if (simulation.state.status === 'RUNNING') nextTick = pacing.boundDeadline(nextTick, performance.now());
  } finally {
    if(simulation?.state.status==='RUNNING'&&stepsMs.length)callbackPhase('activityProjection',samplePlanningRecovery);
    const accounting = callbackMetrics ? callbackMetrics.finish(callbackSpan!) : callbackSpan!.finish(); callbackSpan = undefined;
    cycleMetrics.observe(cycleBefore,cycleBoundary(),accounting,stepsMs.length>0);
    if(stepsMs.length){callbackDurations.push(accounting.totalMs);if(callbackDurations.length>1200)callbackDurations.shift();}
    if (simulation?.state.status === 'RUNNING') pacing.observeCallback(performance.now(),accounting.totalMs,stepsMs.length,Math.max(0,performance.now()-nextTick),queuedWorkAge(performance.now()),cadencePlanningBlocked(),recoveryMemoryPressure());
    if (performanceMetrics) {
    accounting.simulationStages = simulationStages!.finishCallback(accounting);
    const duration = accounting.totalMs;
    performanceMetrics.sample('workerCallback', duration);
    if (advancedTicks) { performanceMetrics.sample('advancingCallback', duration); performanceMetrics.count('advancedTicks', advancedTicks); performanceMetrics.count(`advancingCallbacksWith${advancedTicks}Ticks`); }
    }
    if (diagnosticSpan) overloadMetrics.finish(diagnosticSpan, simulation?.state, stepsMs, accounting);
  }
}
setInterval(()=>{
  if(boundaryBusy)return;
  boundaryBusy=true;
  return runTimer().catch(error=>{queueMicrotask(()=>{throw error;});}).finally(()=>{boundaryBusy=false;void drainBoundaryMessages();});
},10);
