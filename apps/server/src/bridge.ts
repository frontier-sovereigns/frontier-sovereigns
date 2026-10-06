import { WorkerViewChannel, type WorkerViewTransfer } from './worker-view-channel.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SimulationOptions } from '@frontier/simulation';
import type { JournalBatch, ReplayRecording, SaveEnvelope, SimulationSavePayload } from '../../../packages/simulation/src/persistence-types.js';
import type { CommandReceipt, PlayerView, PublicPlayer, SimulationDiagnostics, AssistantPreferences, AssistantStateResponse } from '@frontier/shared';
import type { AiChatRequest, AiDispatch, AiRequestBinding } from '../../../packages/simulation/src/ai-observation.js';
import type { AiCompletion, SchedulingState } from './ai-scheduler.js';
import { diagnosticNow, PerformanceDiagnostics, PublicationTimes } from './performance-diagnostics.js';
import { computeWorkerEnvironment } from './compute-worker-environment.js';
import type { OverloadPolicy } from './simulation-pacing.js';
import { hydrateNativeCheckpointMessage } from '../../../packages/simulation/src/checkpoint-native.js';

export class SimulationBridge {
  private performanceMetrics?: PerformanceDiagnostics;
  private publicationTimes?: PublicationTimes;
  private worker: WorkerViewChannel;
  private nextId = 0;
  private nextPublicationRequest = 0;
  private closing = false;
  private failed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; sentAtMs?: number }>();
  onView: (playerId: string, transfer: WorkerViewTransfer) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  onStatus: (status: string, matchEpoch: number) => void = () => {};
  onJournalStart: (payload: SimulationSavePayload) => void = () => {};
  onJournal: (batch: JournalBatch) => void = () => {};
  onCheckpoint: (payload: SimulationSavePayload, autosave: boolean) => void = () => {};
  onAiMessage: (playerId: string, message: NonNullable<AiCompletion['message']>) => void = () => {};
  constructor(options: { performanceDiagnostics?: boolean; fogTransfer?: boolean; projectionTransfer?: boolean; planningWorkers?: number; visionWorkers?: number; coarseVisionWorkers?:number; overloadPolicy?: OverloadPolicy; authoritativeIntervalMs?:50|300 } = {}) {
    if (options.performanceDiagnostics === true) { this.performanceMetrics = new PerformanceDiagnostics(); this.publicationTimes = new PublicationTimes(); }
    const built = new URL('./worker.js', import.meta.url);
    const planningWorkers=options.planningWorkers??Number(process.env.FRONTIER_PATH_WORKERS??2),visionWorkers=options.visionWorkers??Number(process.env.FRONTIER_VISION_WORKERS??2),coarseVisionWorkers=options.coarseVisionWorkers??Number(process.env.FRONTIER_COARSE_VISION_WORKERS??0);
    if(![planningWorkers,visionWorkers,coarseVisionWorkers].every(count=>Number.isSafeInteger(count)&&count>=0&&count<=8))throw new Error('INVALID_COMPUTE_WORKER_COUNT');
    const overloadPolicy=options.overloadPolicy??process.env.FRONTIER_OVERLOAD_POLICY??'adaptive';
    if(overloadPolicy!=='adaptive'&&overloadPolicy!=='pause')throw new Error('INVALID_OVERLOAD_POLICY');
    const authoritativeIntervalMs=options.authoritativeIntervalMs??Number(process.env.FRONTIER_FRAME_MS??300);
    if(authoritativeIntervalMs!==50&&authoritativeIntervalMs!==300)throw new Error('INVALID_FRAME_INTERVAL');
    const workerData = { performanceDiagnostics: options.performanceDiagnostics === true, fogTransfer: options.fogTransfer === true, projectionTransfer: options.projectionTransfer === true, planningWorkers, visionWorkers, coarseVisionWorkers, overloadPolicy, authoritativeIntervalMs };
    const env=computeWorkerEnvironment();
    this.worker = existsSync(fileURLToPath(built)) ? new WorkerViewChannel(built, { workerData, env, execArgv: [] }, this.performanceMetrics) : new WorkerViewChannel(
      `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./worker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,
      { eval: true, workerData, env, execArgv: [] }, this.performanceMetrics,
    );
    this.worker.onView = (playerId, transfer, stamp, receivedAtMs) => {
      if (this.performanceMetrics && stamp) {
        this.performanceMetrics.sample('viewIpc', (receivedAtMs ?? diagnosticNow()) - stamp.postedAtMs);
        this.publicationTimes!.record(playerId, stamp);
      }
      this.onView(playerId, transfer);
    };
    this.worker.onMessage = message => {
      if(message.type==='native-checkpoint'){
        try{message=hydrateNativeCheckpointMessage(message) as typeof message;}catch(error){failure(error instanceof Error?error:new Error('INVALID_NATIVE_CHECKPOINT'));return;}
      }
      if (message.type === 'status') return this.onStatus(message.status, message.matchEpoch);
      if (message.type === 'journal-start') return this.onJournalStart(message.payload);
      if (message.type === 'journal') return this.onJournal(message.batch);
      if (message.type === 'checkpoint') return this.onCheckpoint(message.payload, message.autosave);
      if (message.type === 'ai-message') return this.onAiMessage(message.playerId, message.message);
      const promise = this.pending.get(message.id);
      if (!promise) return;
      this.pending.delete(message.id); clearTimeout(promise.timer);
      if (promise.sentAtMs !== undefined) this.performanceMetrics?.sample('workerRequestRoundTrip', diagnosticNow() - promise.sentAtMs);
      this.performanceMetrics?.count(message.error ? 'workerRequestFailed' : 'workerRequestCompleted');
      if (message.error) promise.reject(new Error(message.error)); else promise.resolve(message.value);
    };
    const failure = (error: Error) => {
      if (this.closing || this.failed) return; this.failed = true;
      for (const promise of this.pending.values()) { clearTimeout(promise.timer); promise.reject(error); }
      this.pending.clear(); this.onFailure(error);
    };
    this.worker.onError = failure;
    this.worker.onExit = () => failure(new Error('WORKER_EXITED'));
  }
  request<T>(type: string, payload: Record<string, unknown> = {}, onEnqueued?:()=>void): Promise<T> {
    if (this.closing || this.failed) return Promise.reject(new Error('WORKER_UNAVAILABLE'));
    if (this.pending.size > 2048) return Promise.reject(new Error('SERVER_BUSY'));
    const id = ++this.nextId;
    // Generating and validating a dense eleven-faction map is startup work.
    // Keep live commands/captures on their existing bound; only initialization
    // gets a separate finite deadline, including worker/module startup.
    const timeoutMs=type==='init'?30000:15000;
    return new Promise((resolve, reject) => {
      const sentAtMs = this.performanceMetrics ? diagnosticNow() : undefined;
      const timer = setTimeout(() => { this.pending.delete(id); this.performanceMetrics?.count('workerRequestTimedOut'); reject(new Error('WORKER_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, sentAtMs });
      this.performanceMetrics?.count('workerRequestIssued');
      this.worker.postMessage({ id, type, ...payload, requestExpiresAtMs:diagnosticNow()+timeoutMs, ...(sentAtMs !== undefined ? { diagnosticRequestSentAtMs: sentAtMs, ...(type === 'command' ? { diagnosticSentAtMs: sentAtMs } : {}) } : {}) });
      onEnqueued?.();
    });
  }
  publicationHeader(transfer: WorkerViewTransfer, playerId: string) { return this.worker.header(transfer, playerId); }
  get publicationStream() { return this.worker.projectionStream; }
  deferPublication(transfer: WorkerViewTransfer, playerId: string, countdown = false) { return this.worker.defer(transfer, playerId, countdown); }
  serializePublication(transfer: WorkerViewTransfer, playerId: string, countdown = false) { return this.worker.serialize(transfer, playerId, countdown); }
  preparePublication(transfer: WorkerViewTransfer, playerId: string, countdown = false, metrics?: PerformanceDiagnostics) { return this.worker.consume(transfer, playerId, countdown, metrics); }
  init(options: SimulationOptions) { return this.request('init', { options }); }
  restore(save: SaveEnvelope, newEpoch: number) { return this.request<SimulationSavePayload>('restore', { save, newEpoch }); }
  capture() { return this.request<SimulationSavePayload>('capture'); }
  openReplay(recording: ReplayRecording) { return this.request<{ startTick: number; endTick: number; players: PublicPlayer[] }>('replay-open', { recording }); }
  stepReplay(targetTick: number, playerId: string) { return this.request<{ startTick: number; endTick: number; tick: number; done: boolean; view: PlayerView }>('replay-step', { targetTick, playerId }); }
  command(playerId: string, command: unknown, onEnqueued?:()=>void) { return this.request<CommandReceipt>('command', { playerId, command },onEnqueued); }
  view(playerId: string) { return this.request<PlayerView>('view', { playerId }); }
  /** Queue fresh presentation work; the coordinator constructs it only after
   * acquiring encoder credit. Full authoritative reads keep their separate RPC. */
  reservePublicationRequest(): number { const token = ++this.nextPublicationRequest; if (!Number.isSafeInteger(token)) throw new Error('PUBLICATION_REQUEST_LIMIT'); return token; }
  publishRecipient(playerId: string, publicationRequest: number, matchId: string, matchEpoch: number) { return this.request<boolean>('publication-request', { playerId, publicationRequest, matchId, matchEpoch }); }
  status(status: string, invalidate = false) { return this.request<{ matchEpoch: number }>('status', { status, invalidate }); }
  controlMode(playerId: string, mode: 'human' | 'disconnected' | 'caretaker') { return this.request('control-mode', { playerId, mode }); }
  surrender(playerId: string) { return this.request('surrender', { playerId }); }
  endAsDraw() { return this.request('end-draw'); }
  subscribe(playerIds: string[]) { return this.request('subscribe', { playerIds }); }
  aiSchedulingState() { return this.request<SchedulingState>('ai-state'); }
  prepareAiRequest(playerId: string, requestId: string, chatRequestIds: string[]) { return this.request<AiDispatch>('ai-prepare', { playerId, requestId, chatRequestIds }); }
  completeAiRequest(binding: AiRequestBinding, result: { kind: 'plan'; plan: unknown } | { kind: 'failure'; code: string }) { return this.request<AiCompletion>('ai-complete', { binding, result }); }
  invalidateAiRequests(reason: string, playerIds?:string[]) { return this.request('ai-invalidate', { reason, playerIds }); }
  configureAssistant(playerId:string,preferences:AssistantPreferences) { return this.request<AssistantStateResponse>('assistant-configure',{playerId,preferences}); }
  assistantState(playerId:string) { return this.request<AssistantStateResponse>('assistant-state',{playerId}); }
  releaseAssistantEntities(playerId:string,entityIds:string[]) { return this.request<AssistantStateResponse>('assistant-release',{playerId,entityIds}); }
  setAiModel(playerId:string,modelId:string) { return this.request('ai-model',{playerId,modelId}); }
  acceptAiChat(request: AiChatRequest) { return this.request<{ accepted: boolean; code: string }>('ai-chat', { request }); }
  diagnostics() { return this.request<SimulationDiagnostics>('diagnostics'); }
  /** Private harness access only; never attached to an HTTP or WebSocket response. */
  async performanceDiagnostics() {
    if (!this.performanceMetrics) return null;
    return { bridge: { ...this.performanceMetrics.snapshot(), requests: { pending: this.pending.size, limit: 2049, timeoutMs: 15000, initializationTimeoutMs:30000,
      scope: 'Round trip includes worker queue, execution, reply cloning and gateway delivery. Queue is separately observed at worker entry using the shared host monotonic clock; nested intervals must not be added.' } }, simulation: await this.request<unknown>('performance-diagnostics') };
  }
  publicationStamp(playerId: string, matchId: string, epoch: number, sequence: number) { return this.publicationTimes?.find(playerId, matchId, epoch, sequence); }
  async close() { this.closing = true; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('SERVER_CLOSED')); } this.pending.clear(); await this.worker.terminate(); }
}
