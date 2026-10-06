import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, validatePlayerView, type PlayerView, type PreparedViewBoundary } from '@frontier/shared';
import { SNAPSHOT_MAX_BYTES } from '../../../packages/shared/src/view-stream-kernel.js';
import { acknowledgeWorkerProjection, createWorkerPreparedViewScope, postSharedWorkerView, postWorkerPublicationView, postWorkerProjection, workerPublicationBoundary, workerPublicationProjection, workerProjectionResetter, type SharedWorkerView, type SnapshotEncoding, type WorkerPublicationView } from './worker-view-channel.js';
import type { ProjectionTransfer } from './recipient-projection-transfer.js';
import { diagnosticNow, type PerformanceDiagnostics, type PerformancePhase } from './performance-diagnostics.js';
import { computeWorkerEnvironment } from './compute-worker-environment.js';

export interface PublicationTransport {
  readyState: number; bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}
export type PublicationRequest =
  | { type: 'projection-reset'; stream: number; generation: number }
  | { type: 'projection-dispose'; stream: number }
  | { type: 'projection'; stream: number; generation: number; lease: number; playerId: string; transfer: ProjectionTransfer; countdown?: boolean; audit: boolean; targets: { channel: number; generation: number; force: boolean }[] }
  | { type: 'open' | 'reset'; channel: number; generation: number; metrics: boolean; deltaChunks: boolean }
  | { type: 'offer'; channel: number; generation: number; offerId: number; force: boolean; view?: PlayerView; json?: string; jsonBaseline?: boolean }
  | { type: 'ack'; channel: number; generation: number; writeId: number; error?: string }
  | { type: 'dispose'; channel: number; generation: number };
export type PublicationReply =
  | { type: 'ready'; threadId: number }
  | { type: 'projection-credit'; stream: number; generation: number; lease: number; playerId: string; error?: string; audit?: string }
  | { type: 'credit'; channel: number; generation: number; offerId: number }
  | { type: 'write'; channel: number; generation: number; writeId: number; text: string }
  | { type: 'snapshot-complete'; channel: number; generation: number; boundary: PreparedViewBoundary }
  | { type: 'view-complete'; channel: number; generation: number; boundary: PreparedViewBoundary }
  | { type: 'close'; channel: number; generation: number; code: number; reason: string }
  | { type: 'sample'; channel: number; generation: number; phase: PerformancePhase; durationMs: number }
  | { type: 'count'; channel: number; generation: number; name: string; amount: number };
type Offer = { boundary: PreparedViewBoundary; force: boolean } & (
  { kind: 'worker'; value: WorkerPublicationView } | { kind: 'prepared'; value: SharedWorkerView } | { kind: 'json'; value: string } | { kind: 'view'; value: PlayerView });
const sameViewpoint = (a: PreparedViewBoundary, b: PreparedViewBoundary) => a.playerId === b.playerId && a.matchId === b.matchId && a.matchEpoch === b.matchEpoch && a.contentHash === b.contentHash;
function boundary(value: unknown): PreparedViewBoundary {
  if (!value || typeof value !== 'object') throw new Error('INVALID_SNAPSHOT');
  const view = value as PlayerView;
  if (view.protocolVersion !== PROTOCOL_VERSION || typeof view.contentHash !== 'string' || typeof view.matchId !== 'string' || typeof view.playerId !== 'string'
    || ![view.matchEpoch, view.sequence, view.tick].every(number => Number.isSafeInteger(number) && number >= 0)) throw new Error('INVALID_SNAPSHOT');
  const { protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick } = view;
  return { protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick };
}

/** One persistent encoding thread for all authenticated sockets. It never receives the world or credentials. */
export class PublicationWorker {
  private worker!: Worker;
  private readonly channels = new Map<number, ThreadedViewPublisher>();
  private readonly encoding: SnapshotEncoding;
  private nextId = 0;
  private closed = false;
  private failed = false;
  private workerThreadId: number | null = null;
  private recoveries = 0;
  private restarts: number[] = [];
  private restartTimer?: NodeJS.Timeout;
  private projectionStreams = new Map<number, number>();
  private projectionSources = new Map<number, () => void>();
  private projectionLeases = new Map<number, { handle: WorkerPublicationView; stream: number; generation: number; playerId: string; publishers: ThreadedViewPublisher[]; timer: NodeJS.Timeout; audit?: (text: string, playerId: string) => void }>();
  private nextProjectionLease = 0;
  private failWorker: (error: Error) => void = () => {};
  private termination?: Promise<number>;
  private readyResolve!: (id: number) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<number>;
  constructor(options: { snapshotEncoding?: SnapshotEncoding } = {}) {
    this.encoding = options.snapshotEncoding ?? 'native';
    if (!['native', 'portable'].includes(this.encoding)) throw new Error('INVALID_SNAPSHOT_ENCODING');
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    void this.ready.catch(() => {});
    this.start(false);
  }
  private start(restarting: boolean): void {
    if (this.closed) return;
    this.failed = false; this.workerThreadId = null;
    const built = new URL('./publication-worker.js', import.meta.url), workerData = { snapshotEncoding: this.encoding }, env = computeWorkerEnvironment();
    const worker = existsSync(fileURLToPath(built)) ? new Worker(built, { workerData, env, execArgv: [] }) : new Worker(
      `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./publication-worker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,
      { eval: true, workerData, env, execArgv: [] },
    );
    this.worker = worker;
    const timer = setTimeout(() => failure(new Error('PUBLICATION_WORKER_START_TIMEOUT')), 15000); timer.unref();
    const failure = (error: Error) => {
      clearTimeout(timer);
      if (this.closed || this.failed || this.worker !== worker) return;
      this.failed = true; this.workerThreadId = null; this.readyReject(error);
      for (const reset of this.projectionSources.values()) reset();
      this.projectionStreams.clear(); this.projectionSources.clear();
      for (const publisher of [...this.channels.values()]) publisher.rejectPublication(error);
      this.channels.clear();
      // Neither a replacement worker nor fresh source byte credit may overtake
      // the old worker's actual ownership release. A failed termination leaves
      // this lane degraded and reserved, rather than inventing free capacity.
      this.termination = worker.terminate();
      void this.termination.then(() => {
        this.failProjectionLeases();
        if (this.closed || this.worker !== worker) return;
        const now = Date.now(); this.restarts = this.restarts.filter(at => now - at < 60000);
        if (this.restarts.length < 3) {
          this.restarts.push(now);
          this.restartTimer = setTimeout(() => { this.restartTimer = undefined; this.termination = undefined; this.start(true); }, 250); this.restartTimer.unref();
        }
      }).catch(() => { /* No replacement is safe while termination is unconfirmed. */ });
    };
    this.failWorker = failure;
    worker.on('error', failure);
    worker.on('exit', () => { clearTimeout(timer); if (!this.closed) failure(new Error('PUBLICATION_WORKER_EXITED')); else this.readyReject(new Error('PUBLICATION_WORKER_CLOSED')); });
    worker.on('message', (message: PublicationReply) => {
      if (this.closed || this.failed || this.worker !== worker) return;
      if (message.type === 'ready') { clearTimeout(timer); this.workerThreadId = message.threadId; if (restarting) this.recoveries++; this.readyResolve(message.threadId); return; }
      if (message.type === 'projection-credit') {
        const lease = this.projectionLeases.get(message.lease);
        if (!lease || lease.stream !== message.stream || lease.generation !== message.generation || lease.playerId !== message.playerId) return;
        this.projectionLeases.delete(message.lease); clearTimeout(lease.timer);
        let failed = !!message.error;
        try { if (!failed && lease.audit) { if (typeof message.audit !== 'string') throw new Error('PROJECTION_AUDIT_MISSING'); lease.audit(message.audit, lease.playerId); } }
        catch { failed = true; }
        if (failed) for (const publisher of lease.publishers) publisher.rejectPublication(new Error(message.error ?? 'INVALID_PROJECTION_TRANSFER'));
        acknowledgeWorkerProjection(lease.handle, failed); return;
      }
      this.channels.get(message.channel)?.receive(message);
    });
  }
  createPublisher(socket: PublicationTransport, metrics?: PerformanceDiagnostics, deltaChunks = false): ThreadedViewPublisher {
    if (this.channels.size >= 128) throw new Error('PUBLICATION_CHANNEL_LIMIT');
    const publisher = new ThreadedViewPublisher(this, ++this.nextId, socket, metrics, deltaChunks);
    this.channels.set(publisher.id, publisher);
    if (this.closed || this.failed) publisher.rejectPublication(new Error('PUBLICATION_WORKER_UNAVAILABLE'));
    else this.post({ type: 'open', channel: publisher.id, generation: 0, metrics: !!metrics, deltaChunks });
    return publisher;
  }
  post(message: PublicationRequest): void {
    if (this.closed || this.failed) throw new Error('PUBLICATION_WORKER_UNAVAILABLE');
    this.worker.postMessage(message);
  }
  postOffer(message: Extract<PublicationRequest, { type: 'offer' }>, offer: Offer): void {
    if (this.closed || this.failed) throw new Error('PUBLICATION_WORKER_UNAVAILABLE');
    if (offer.kind === 'worker') postWorkerPublicationView(offer.value, this.worker, { ...message, jsonBaseline: true });
    else if (offer.kind === 'prepared') postSharedWorkerView(offer.value, this.worker, message);
    else this.worker.postMessage({ ...message, ...(offer.kind === 'json' ? { json: offer.value } : { view: offer.value }) });
  }
  /** One authorized absolute patch crosses IPC per recipient, regardless of how
   * many sockets share it. Encoder receipt returns source credit; socket send
   * callbacks remain the independent per-socket delta-base acknowledgment. */
  offerProjection(handle: WorkerPublicationView, publishers: ThreadedViewPublisher[], audit?: (text: string, playerId: string) => void): void {
    let leaseId: number | undefined;
    try {
      if (this.closed || this.failed) throw new Error('PUBLICATION_WORKER_UNAVAILABLE');
      const info = workerPublicationProjection(handle);
      if (!info) throw new Error('INVALID_PROJECTION_TRANSFER');
      this.projectionSources.set(info.stream, workerProjectionResetter(handle));
      if (this.projectionLeases.size >= 4) throw new Error('PROJECTION_BACKPRESSURE');
      const generation = this.projectionStreams.get(info.stream);
      if (generation === undefined || generation < info.generation) {
        if (generation === undefined && this.projectionStreams.size >= 16) throw new Error('PROJECTION_STREAM_LIMIT');
        this.post({ type: 'projection-reset', stream: info.stream, generation: info.generation });
        this.projectionStreams.set(info.stream, info.generation);
      } else if (generation !== info.generation) throw new Error('STALE_PROJECTION_TRANSFER');
      const header = workerPublicationBoundary(handle), targets = publishers.flatMap(publisher => {
        const target = publisher.projectionTarget(header, info); return target ? [target] : [];
      });
      leaseId = ++this.nextProjectionLease;
      const key = leaseId;
      const timer = setTimeout(() => {
        const lease = this.projectionLeases.get(key); if (!lease) return;
        // Releasing credit while a stuck encoder still owns that transfer would
        // break the global memory bound. Terminate its generation before reuse.
        this.failWorker(new Error('PUBLICATION_WORKER_TIMEOUT'));
      }, 15000); timer.unref();
      this.projectionLeases.set(leaseId, { handle, stream: info.stream, generation: info.generation, playerId: info.playerId, publishers, timer, audit });
      postWorkerProjection(handle, this.worker, { type: 'projection', stream: info.stream, generation: info.generation, playerId: info.playerId, lease: leaseId, targets, audit: !!audit });
    } catch (error) {
      if (leaseId !== undefined) { clearTimeout(this.projectionLeases.get(leaseId)?.timer); this.projectionLeases.delete(leaseId); }
      for (const publisher of publishers) publisher.rejectPublication(error);
      acknowledgeWorkerProjection(handle, true);
    }
  }
  releaseProjectionStream(stream: number): void {
    this.projectionStreams.delete(stream);
    this.projectionSources.delete(stream);
    // A queued dispose follows the already-sent transfers. Their byte leases
    // remain owned until individual encoder ACKs (or confirmed termination).
    for (const lease of this.projectionLeases.values()) if (lease.stream === stream) lease.audit = undefined;
    if (!this.closed && !this.failed) this.post({ type: 'projection-dispose', stream });
  }
  private failProjectionLeases(): void {
    for (const lease of this.projectionLeases.values()) { clearTimeout(lease.timer); acknowledgeWorkerProjection(lease.handle, true); }
    this.projectionLeases.clear();
  }
  remove(id: number): void { this.channels.delete(id); }
  diagnostics() { return { enabled: true, threadId: this.workerThreadId, channels: this.channels.size, failed: this.failed, recoveries: this.recoveries,
    inflightOffers: [...this.channels.values()].filter(channel => channel.inventory().active).length,
    pendingOffers: [...this.channels.values()].filter(channel => channel.inventory().pending).length,
    projectionTransfers: this.projectionLeases.size, projectionReservedBytes: this.projectionLeases.size * 32 * 1024 * 1024, projectionStreams: this.projectionStreams.size,
    delivery: { scope: 'gateway_publication_socket_callbacks' as const, channels: [...this.channels.values()].map(channel => channel.deliveryDiagnostics()) } }; }
  async close(): Promise<void> {
    if (this.closed) return;
    clearTimeout(this.restartTimer); this.restartTimer = undefined;
    this.projectionStreams.clear(); this.projectionSources.clear();
    for (const publisher of [...this.channels.values()]) publisher.dispose();
    this.closed = true; this.channels.clear(); await (this.termination ??= this.worker.terminate()); this.failProjectionLeases();
  }
}

/** Gateway half: one sent offer and one replaceable latest offer, plus a bounded chunk window.
 * Completion ACKs, not worker encoding completion, establish the worker's next delta base. */
export class ThreadedViewPublisher {
  private generation = 0;
  private nextOffer = 0;
  private active?: number;
  private pending?: Offer;
  private newest?: PreparedViewBoundary;
  private snapshotRequest?: { stream: number; token: number; matchId: string; matchEpoch: number; minimumSequence?: number };
  private adoptionScope = createWorkerPreparedViewScope();
  private disposed = false;
  // Constant-size per-connection observations. These remain host-only and never
  // retain payloads. A socket callback is completion at the host, not receipt or
  // application by the browser. Intervals can include manual pauses.
  private offeredViews = 0;
  private completedViews = 0;
  private completedSequence: number | null = null;
  private lastOfferAt: number | null = null;
  private lastWriteAt: number | null = null;
  private lastCompletedAt: number | null = null;
  private maxOfferInterval: number | null = null;
  private maxCompletedInterval: number | null = null;
  private lastSocketCallback: number | null = null;
  private maxSocketCallback: number | null = null;
  private lastLongGap: { at: number; stage: 'offer' | 'completion' | 'socket_callback'; durationMs: number } | null = null;
  private readonly pendingWrites = new Map<number, number>();
  constructor(private readonly owner: PublicationWorker, readonly id: number, private readonly socket: PublicationTransport, private readonly metrics?: PerformanceDiagnostics, private readonly deltaChunks = false,
    private readonly now: () => number = diagnosticNow, private readonly wallNow: () => number = Date.now) {}
  inventory() { return { active: this.active !== undefined, pending: this.pending !== undefined }; }
  deliveryDiagnostics() {
    const now = this.now(), age = (at: number | null) => at === null ? null : Math.max(0, now - at);
    return { channelId: this.id, playerId: this.newest?.playerId ?? null, offeredViews: this.offeredViews, completedViews: this.completedViews,
      offeredSequence: this.newest?.sequence ?? null, completedSequence: this.completedSequence,
      offerAgeMs: age(this.lastOfferAt), lastWriteAgeMs: age(this.lastWriteAt), completedAgeMs: age(this.lastCompletedAt),
      maxOfferIntervalMs: this.maxOfferInterval, maxCompletedIntervalMs: this.maxCompletedInterval,
      pendingSocketWrites: this.pendingWrites.size, oldestSocketWriteMs: age(this.pendingWrites.size ? Math.min(...this.pendingWrites.values()) : null),
      lastSocketCallbackMs: this.lastSocketCallback, maxSocketCallbackMs: this.maxSocketCallback, bufferedBytes: this.socket.bufferedAmount,
      lastLongGap: this.lastLongGap && { ...this.lastLongGap } };
  }
  private observeGap(stage: 'offer' | 'completion' | 'socket_callback', durationMs: number): void {
    if (durationMs > 1000) this.lastLongGap = { at: this.wallNow(), stage, durationMs };
  }
  private observedOffer(header: PreparedViewBoundary): void {
    const now = this.now();
    if (this.lastOfferAt !== null) { this.maxOfferInterval = Math.max(this.maxOfferInterval ?? 0, now - this.lastOfferAt); this.observeGap('offer', now - this.lastOfferAt); }
    this.lastOfferAt = now; this.offeredViews = Math.min(Number.MAX_SAFE_INTEGER, this.offeredViews + 1); this.newest = header;
  }
  offer(view: PlayerView, forceSnapshot = false): void {
    if (!this.available()) return;
    try {
      // Arbitrary direct offers retain descriptor safety before structured clone can invoke a getter.
      // Normal scheduled views use the opaque worker lane below, without capture/stringify on this thread.
      const captured = validatePlayerView.capture(view, { enumerableOnly: true });
      if (!captured) throw new Error(validatePlayerView.errors?.some(error => error.keyword === 'maxBytes' || error.keyword === 'maxItems' && error.instancePath === '/entities') ? 'SNAPSHOT_TOO_LARGE' : 'INVALID_SNAPSHOT');
      this.accept({ kind: 'view', value: captured, boundary: boundary(captured), force: forceSnapshot });
    } catch (error) { this.rejectPublication(error); }
  }
  offerJson(text: unknown, forceSnapshot = false, header?: PreparedViewBoundary): void {
    if (!this.available()) return;
    try {
      if (typeof text !== 'string') throw new Error('INVALID_SNAPSHOT');
      if (text.length > SNAPSHOT_MAX_BYTES || Buffer.byteLength(text) > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
      this.accept({ kind: 'json', value: text, boundary: boundary(header ?? JSON.parse(text)), force: forceSnapshot });
    } catch (error) { this.rejectPublication(error); }
  }
  offerPrepared(handle: SharedWorkerView, forceSnapshot = false): void {
    if (!this.available()) return;
    try {
      const adopt = () => this.adoptionScope.adopt(handle);
      const prepared = this.metrics ? this.metrics.measure('preparedAdoption', adopt) : adopt();
      this.accept({ kind: 'prepared', value: handle, boundary: this.adoptionScope.boundary(prepared), force: forceSnapshot });
    }
    catch (error) { this.rejectPublication(error); }
  }
  offerTransferred(handle: WorkerPublicationView, forceSnapshot = false): void {
    if (!this.available()) return;
    try { this.accept({ kind: 'worker', value: handle, boundary: workerPublicationBoundary(handle), force: forceSnapshot }); }
    catch (error) { this.rejectPublication(error); }
  }
  projectionTarget(header: PreparedViewBoundary, projection: { stream: number; requestToken: number }): { channel: number; generation: number; force: boolean } | undefined {
    if (!this.available()) return;
    if (this.newest && sameViewpoint(this.newest, header) && this.newest.sequence > header.sequence) return;
    this.observedOffer(header);
    let force = this.pending?.force ?? false;
    const request = this.snapshotRequest;
    if (request && request.stream === projection.stream && request.matchId === header.matchId && request.matchEpoch === header.matchEpoch && projection.requestToken >= request.token && request.minimumSequence === undefined) {
      request.minimumSequence = header.sequence; force = true;
    }
    // An older normal offer must not be submitted after this newer projection.
    if (this.pending && sameViewpoint(this.pending.boundary, header) && this.pending.boundary.sequence <= header.sequence) this.pending = undefined;
    return { channel: this.id, generation: this.generation, force };
  }
  requestSnapshot(request: { stream: number; token: number; matchId: string; matchEpoch: number }): boolean {
    if (!this.available()) return false;
    this.snapshotRequest = { ...request }; return true;
  }
  reset(): void {
    if (this.disposed) return;
    this.generation++; this.active = undefined; this.pending = undefined; this.newest = undefined; this.snapshotRequest = undefined;
    this.offeredViews = 0; this.completedViews = 0; this.completedSequence = null;
    this.lastOfferAt = this.lastWriteAt = this.lastCompletedAt = this.maxOfferInterval = this.maxCompletedInterval = this.lastSocketCallback = this.maxSocketCallback = null;
    this.lastLongGap = null;
    this.pendingWrites.clear();
    this.adoptionScope = createWorkerPreparedViewScope();
    try { this.owner.post({ type: 'reset', channel: this.id, generation: this.generation, metrics: !!this.metrics, deltaChunks:this.deltaChunks }); }
    catch (error) { this.rejectPublication(error); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.pending = undefined; this.active = undefined; this.newest = undefined; this.snapshotRequest = undefined;
    this.pendingWrites.clear();
    try { this.owner.post({ type: 'dispose', channel: this.id, generation: this.generation }); } catch { /* A failed worker owns no usable bases. */ }
    this.owner.remove(this.id);
  }
  rejectPublication(error: unknown): void {
    this.dispose();
    if (this.socket.readyState === 1) this.socket.close(4008, error instanceof Error && error.message === 'SNAPSHOT_TOO_LARGE' ? 'SNAPSHOT_TOO_LARGE' : 'SLOW_CLIENT_RECONNECT');
  }
  receive(message: Exclude<PublicationReply, { type: 'ready' | 'projection-credit' }>): void {
    if (this.disposed || message.generation !== this.generation) return;
    if (message.type === 'credit') {
      if (message.offerId !== this.active) return;
      this.active = undefined;
      if (this.pending) { const offer = this.pending; this.pending = undefined; this.submit(offer); }
    } else if (message.type === 'write') {
      const generation = this.generation;
      const started = this.now(); this.lastWriteAt = started; this.pendingWrites.set(message.writeId, started);
      let acknowledged = false;
      const ack = (error?: Error) => {
        if (acknowledged) return; acknowledged = true;
        if (this.disposed || generation !== this.generation) return;
        this.pendingWrites.delete(message.writeId);
        this.lastSocketCallback = Math.max(0, this.now() - started);
        this.maxSocketCallback = Math.max(this.maxSocketCallback ?? 0, this.lastSocketCallback);
        this.observeGap('socket_callback', this.lastSocketCallback);
        try { this.owner.post({ type: 'ack', channel: this.id, generation, writeId: message.writeId, ...(error ? { error: 'SOCKET_WRITE_FAILED' } : {}) }); }
        catch (failure) { this.rejectPublication(failure); }
      };
      if (!this.available() || this.socket.bufferedAmount > 1024 * 1024) { ack(new Error('SLOW_CLIENT_RECONNECT')); this.rejectPublication(new Error('SLOW_CLIENT_RECONNECT')); return; }
      try { this.socket.send(message.text, ack); } catch (error) { ack(error as Error); this.rejectPublication(error); }
    } else if (message.type === 'view-complete') {
      const now = this.now();
      if (this.lastCompletedAt !== null) { this.maxCompletedInterval = Math.max(this.maxCompletedInterval ?? 0, now - this.lastCompletedAt); this.observeGap('completion', now - this.lastCompletedAt); }
      this.lastCompletedAt = now; this.completedSequence = message.boundary.sequence;
      this.completedViews = Math.min(Number.MAX_SAFE_INTEGER, this.completedViews + 1);
    } else if (message.type === 'snapshot-complete') {
      const request = this.snapshotRequest;
      if (request?.minimumSequence !== undefined && request.matchId === message.boundary.matchId && request.matchEpoch === message.boundary.matchEpoch && message.boundary.sequence >= request.minimumSequence) this.snapshotRequest = undefined;
    } else if (message.type === 'close') { this.dispose(); if (this.socket.readyState === 1) this.socket.close(message.code, message.reason); }
    else if (message.type === 'sample') this.metrics?.sample(message.phase, message.durationMs);
    else this.metrics?.count(message.name, message.amount);
  }
  private available(): boolean { return !this.disposed && this.socket.readyState === 1; }
  private accept(offer: Offer): void {
    if (this.newest && sameViewpoint(this.newest, offer.boundary) && (this.newest.sequence > offer.boundary.sequence || this.newest.sequence === offer.boundary.sequence && !offer.force)) {
      this.metrics?.count('staleViewOffers'); return;
    }
    this.observedOffer(offer.boundary);
    if (this.active === undefined) this.submit(offer);
    else {
      if (this.pending) { offer.force ||= this.pending.force; this.metrics?.count('coalescedViewOffers'); }
      this.pending = offer;
    }
  }
  private submit(offer: Offer): void {
    this.active = ++this.nextOffer;
    try { this.owner.postOffer({ type: 'offer', channel: this.id, generation: this.generation, offerId: this.active, force: offer.force }, offer); }
    catch (error) { this.rejectPublication(error); }
  }
}
