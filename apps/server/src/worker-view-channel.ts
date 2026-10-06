import { Worker, type WorkerOptions } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION, validatePlayerView, validateSnapshotChunk, validateDeltaChunk, type DeltaChunk, type SnapshotChunk, type PlayerView, type PreparedViewBoundary, type PreparedViewHandle, type PreparedViewScope } from '@frontier/shared';
import { validatePlayerView as compiledView } from '../../../packages/shared/src/validators.generated.js';
import { byId, consistent, withoutVisualTraces, deltaFromValidatedViews, encodeDeltaMessageFromValidatedViews, chunksFromNormalizedView, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_CHUNKS, SNAPSHOT_MAX_BYTES } from '../../../packages/shared/src/view-stream-kernel.js';
import type { PerformanceDiagnostics, PublicationStamp } from './performance-diagnostics.js';
import { FogReceiver } from './worker-fog-transfer.js';
import { RecipientProjectionReceiver, type ProjectionTransfer } from './recipient-projection-transfer.js';

declare const transferBrand: unique symbol;
declare const sharedBrand: unique symbol;
declare const publicationBrand: unique symbol;
export interface WorkerViewTransfer { readonly [transferBrand]: true }
export interface SharedWorkerView { readonly [sharedBrand]: true }
/** A recipient-filtered worker tree retained only until the publication worker takes it. */
export interface WorkerPublicationView { readonly [publicationBrand]: true }
export type WorkerViewBoundary = PreparedViewBoundary & Readonly<{ status: PlayerView['status'] }>;
export type SnapshotEncoding = 'portable' | 'native';
export interface WorkerPreparedViewScope extends PreparedViewScope { adopt(handle: SharedWorkerView): PreparedViewHandle }
interface Lifetime { generation: number; closed: boolean }
interface Prepared { view: PlayerView; boundary: PreparedViewBoundary; header: WorkerViewBoundary }
interface SharedRecord { prepared: Prepared; lifetime: Lifetime; generation: number }
const shared = new WeakMap<SharedWorkerView, SharedRecord>();
interface ProjectionRecord { transfer: ProjectionTransfer; stream: number; requestToken: number; acknowledge: (failed: boolean) => void; reset: () => void }
const publication = new WeakMap<WorkerPublicationView, { view: unknown; header: WorkerViewBoundary; lifetime: Lifetime; generation: number; projection?: ProjectionRecord; countdown?: boolean }>();
let nextProjectionStream = 0;
// This long-lived callback has its own closure: it must not retain a transfer
// through the ACK callback's lexical scope after the encoder releases credit.
function projectionResetter(worker: Worker, lifetime: Lifetime, generation: number): () => void {
  return () => { if (!lifetime.closed) worker.postMessage({ type: 'projection-restart', generation }); };
}
const invalid = (): never => { throw new Error('INVALID_SNAPSHOT'); };
const tokenError = (): never => { throw new Error('INVALID_VIEW_TRANSFER'); };
const measure = <T>(metrics: PerformanceDiagnostics | undefined, phase: 'ownedSafetySize' | 'ownedSchema' | 'ownedConsistency' | 'ownedNormalize' | 'ownedJsonFallback', operation: () => T): T =>
  metrics ? metrics.measure(phase, operation) : operation();

/** A bounded JSON byte census of an exclusively owned structured-clone tree.
 * Never used on arbitrary public objects. Repeated aliases/undefined/-0 use the retained JSON lane.
 */
function inspectOwnedJson(root: unknown): { lowerBound: number; sizeFallback: boolean; semanticFallback: boolean } {
  let lowerBound = 0, upperBound = 0, remaining = 1000000, semanticFallback = false;
  const seen = new Set<object>(), ancestors = new Set<object>();
  const add = (lower: number, upper = lower) => {
    lowerBound += lower;
    if (lowerBound > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
    upperBound = Math.min(SNAPSHOT_MAX_BYTES + 1, upperBound + upper);
  };
  // Every JSON-encoded UTF-16 code unit takes at least one and at most six UTF-8 bytes.
  // Escapes/lone surrogates take six; a surrogate pair takes four for two code units.
  const string = (value: string) => add(value.length + 2, value.length * 6 + 2);
  const visit = (value: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 32) invalid();
    if (value === null) { add(4); return; }
    if (typeof value === 'string') { string(value); return; }
    if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      if (Object.is(value, -0)) semanticFallback = true;
      add(String(value).length); return;
    }
    if (typeof value !== 'object') invalid();
    const object = value as object;
    if (ancestors.has(object)) invalid();
    if (seen.has(object)) semanticFallback = true;
    seen.add(object); ancestors.add(object);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > remaining || Object.keys(value).length !== value.length) invalid();
      add(2);
      for (let index = 0; index < value.length; index++) {
        if (index) add(1);
        if (value[index] === undefined) { if (--remaining < 0 || depth + 1 > 32) invalid(); semanticFallback = true; add(4); }
        else visit(value[index], depth + 1);
      }
    } else {
      const prototype = Object.getPrototypeOf(object);
      if (prototype !== Object.prototype && prototype !== null) invalid();
      add(2); let count = 0;
      for (const key of Object.keys(object)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') invalid();
        const child = (object as Record<string, unknown>)[key];
        if (child === undefined) { if (--remaining < 0 || depth + 1 > 32) invalid(); semanticFallback = true; continue; }
        if (count++) add(1); string(key); add(1); visit(child, depth + 1);
      }
    }
    ancestors.delete(object);
  };
  visit(root, 0); return { lowerBound, sizeFallback: upperBound > SNAPSHOT_MAX_BYTES, semanticFallback };
}
function validated(value: PlayerView | undefined): PlayerView {
  if (value) return value;
  if (validatePlayerView.errors?.some(error => error.keyword === 'maxBytes' || error.keyword === 'maxItems' && error.instancePath === '/entities')) throw new Error('SNAPSHOT_TOO_LARGE');
  return invalid();
}
function normalize(view: PlayerView, metrics?: PerformanceDiagnostics): Prepared {
  if (!measure(metrics, 'ownedConsistency', () => consistent(view))) invalid();
  return normalizeConsistent(view, metrics);
}
/** Only strict capture/owned validation or the private projection receiver may
 * reach this helper after full consistency has already been proved. */
function normalizeConsistent(view: PlayerView, metrics?: PerformanceDiagnostics): Prepared {
  measure(metrics, 'ownedNormalize', () => { view.entities.sort(byId); view.fog.visible.sort((a, b) => a - b); view.fog.explored.sort((a, b) => a - b); });
  const { protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick, status } = view;
  const boundary = Object.freeze({ protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick });
  return { view, boundary, header: Object.freeze({ ...boundary, status }) };
}
function readShared(handle: SharedWorkerView): Prepared {
  const entry = shared.get(handle);
  if (!entry || entry.lifetime.closed || entry.generation !== entry.lifetime.generation) throw new Error('INVALID_PREPARED_VIEW');
  return entry.prepared;
}
export function workerViewBoundary(handle: SharedWorkerView): WorkerViewBoundary { return readShared(handle).header; }
export function postSharedWorkerView(handle: SharedWorkerView, target: Worker, envelope: Readonly<Record<string, unknown>>): void {
  if (!(target instanceof Worker)) throw new Error('INVALID_PUBLICATION_WORKER');
  target.postMessage({ ...envelope, view: readShared(handle).view });
}
function readPublication(handle: WorkerPublicationView) {
  const entry = publication.get(handle);
  if (!entry || entry.lifetime.closed || entry.generation !== entry.lifetime.generation) throw new Error('INVALID_VIEW_TRANSFER');
  return entry;
}
export function workerPublicationBoundary(handle: WorkerPublicationView): WorkerViewBoundary { return readPublication(handle).header; }
/** The raw tree can only be copied into an actual Node worker, never borrowed by callers. */
export function postWorkerPublicationView(handle: WorkerPublicationView, target: Worker, envelope: Readonly<Record<string, unknown>>): void {
  if (!(target instanceof Worker)) throw new Error('INVALID_PUBLICATION_WORKER');
  const entry = readPublication(handle);
  if (entry.projection) throw new Error('PROJECTION_FANOUT_REQUIRED');
  target.postMessage({ ...envelope, view: entry.view });
}
export function workerPublicationProjection(handle: WorkerPublicationView) {
  const entry = readPublication(handle), value = entry.projection;
  return value ? { stream: value.stream, generation: value.transfer.generation, revision: value.transfer.patch.revision, playerId: entry.header.playerId, requestToken: value.requestToken } : undefined;
}
export function postWorkerProjection(handle: WorkerPublicationView, target: Worker, envelope: Readonly<Record<string, unknown>>): void {
  if (!(target instanceof Worker)) throw new Error('INVALID_PUBLICATION_WORKER');
  const entry = readPublication(handle), value = entry.projection;
  if (!value) throw new Error('INVALID_PROJECTION_TRANSFER');
  target.postMessage({ ...envelope, transfer: value.transfer, countdown: entry.countdown });
}
export function acknowledgeWorkerProjection(handle: WorkerPublicationView, failed = false): void {
  // An ACK for an invalidated source generation is harmless; its callback drops it.
  publication.get(handle)?.projection?.acknowledge(failed);
}
export function workerProjectionResetter(handle: WorkerPublicationView): () => void {
  const value = readPublication(handle).projection;
  if (!value) throw new Error('INVALID_PROJECTION_TRANSFER');
  return value.reset;
}
export function inspectWorkerPublicationJson(handle: WorkerPublicationView, inspect: (text: string, playerId: string) => void): void {
  const entry = readPublication(handle);
  if (entry.projection) throw new Error('PROJECTION_AUDIT_REQUIRES_ENCODER');
  inspect(JSON.stringify(entry.view), entry.header.playerId);
}
/** Strict direct capture performed once in the encoder, then adopted by every
 * socket for that recipient. A caller never receives the retained mutable tree. */
export function captureSharedPublication(input: unknown): SharedWorkerView {
  const view = validated(validatePlayerView.capture(input, { enumerableOnly: true }));
  const census = inspectOwnedJson(view);
  if (census.sizeFallback && Buffer.byteLength(JSON.stringify(view)) > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
  const handle = Object.freeze(Object.create(null)) as SharedWorkerView;
  shared.set(handle, { prepared: normalize(view), lifetime: { generation: 0, closed: false }, generation: 0 });
  return handle;
}
/** Exclusively owns its strict projection receiver and never exposes its bases.
 * Reconstructed publications already passed the full schema, JSON-safety and
 * consistency contracts, including the complete-view node/depth and byte limits.
 * Copy only normalization's arrays instead of capturing or traversing that tree again.
 * No caller-owned PlayerView can enter this path or borrow a retained raw view. */
export function createProjectionPreparedReceiver() {
  const receiver = new RecipientProjectionReceiver();
  return Object.freeze({
    reset(generation: number): void { receiver.reset(generation); },
    clear(): void { receiver.clear(); },
    receive(input: ProjectionTransfer, playerId: string, countdown = false, inspect?: (text: string) => void): SharedWorkerView {
      const source = receiver.receive(input, playerId);
      const view: PlayerView = { ...source, entities: source.entities.slice(), fog: { ...source.fog, visible: source.fog.visible.slice(), explored: source.fog.explored.slice() },
        ...(countdown ? { status: 'COUNTDOWN' as const } : {}) };
      // Copies/sorting preserve the receiver-validated complete node count, depth
      // and exact JSON byte size. Only status substitution can increase bytes.
      if (countdown && source.status !== 'COUNTDOWN' && Buffer.byteLength(JSON.stringify(view)) > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
      // Optional QA keeps its existing pre-normalization JSON ordering; only an
      // encoded string leaves this closure, never the receiver's retained tree.
      if (inspect) inspect(JSON.stringify(view));
      const handle = Object.freeze(Object.create(null)) as SharedWorkerView;
      shared.set(handle, { prepared: normalizeConsistent(view), lifetime: { generation: 0, closed: false }, generation: 0 });
      return handle;
    },
  });
}
/** Trusted optional QA receives only an encoded authorized view, never its retained tree. */
export function inspectWorkerViewJson(handle: SharedWorkerView, inspect: (text: string, playerId: string) => void): void {
  const entry = readShared(handle); inspect(JSON.stringify(entry.view), entry.boundary.playerId);
}
/** Server-only encoding of the immutable message produced by a validated view
 * scope. No parse, borrowed tree or Buffer crosses this boundary. */
export function nativeDeltaChunksFromEncodedMessage(message:string,boundary:Pick<DeltaChunk,'protocolVersion'|'contentHash'|'matchId'|'matchEpoch'|'playerId'|'sequence'|'baseSequence'>,transferId:string):DeltaChunk[] {
  const prefix='{"type":"delta","delta":';
  if(!message.startsWith(prefix)||!message.endsWith('}'))throw new Error('INVALID_DELTA_TRANSFER');
  const text=message.slice(prefix.length,-1);
  if(text.length>SNAPSHOT_MAX_BYTES||Buffer.byteLength(text,'utf8')>SNAPSHOT_MAX_BYTES)throw new Error('DELTA_TOO_LARGE');
  const bytes=Buffer.from(text,'utf8'),count=Math.ceil(bytes.length/SNAPSHOT_CHUNK_BYTES);
  if(count<1||count>SNAPSHOT_MAX_CHUNKS)throw new Error('INVALID_DELTA_TRANSFER');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const chunks=Array.from({length:count},(_,index):DeltaChunk=>({type:'delta_chunk',transferId,protocolVersion:boundary.protocolVersion,contentHash:boundary.contentHash,matchId:boundary.matchId,matchEpoch:boundary.matchEpoch,playerId:boundary.playerId,sequence:boundary.sequence,baseSequence:boundary.baseSequence,index,count,byteLength:bytes.length,sha256:hash,data:bytes.subarray(index*SNAPSHOT_CHUNK_BYTES,(index+1)*SNAPSHOT_CHUNK_BYTES).toString('base64')}));
  if(chunks.some(chunk=>!validateDeltaChunk(chunk)))throw new Error('INVALID_DELTA_TRANSFER');return chunks;
}
/** Node-only codec over a privately owned, validated and normalized record.
 * No Buffer or borrowed view escapes; key/chunk order is the portable protocol's exact order.
 */
function nativeChunks(view: PlayerView, transferId: string): SnapshotChunk[] {
  const text = JSON.stringify(view), bytes = Buffer.from(text, 'utf8');
  if (bytes.length > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
  const count = Math.ceil(bytes.length / SNAPSHOT_CHUNK_BYTES);
  if (count < 1 || count > SNAPSHOT_MAX_CHUNKS) throw new Error('INVALID_SNAPSHOT_TRANSFER');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const result = Array.from({ length: count }, (_, index): SnapshotChunk => ({
    type: 'snapshot_chunk', transferId, protocolVersion: view.protocolVersion, contentHash: view.contentHash,
    matchId: view.matchId, matchEpoch: view.matchEpoch, playerId: view.playerId, sequence: view.sequence,
    index, count, byteLength: bytes.length, sha256: hash,
    data: bytes.subarray(index * SNAPSHOT_CHUNK_BYTES, (index + 1) * SNAPSHOT_CHUNK_BYTES).toString('base64'),
  }));
  if (result.some(chunk => !validateSnapshotChunk(chunk))) throw new Error('INVALID_SNAPSHOT_TRANSFER');
  return result;
}
/** Safe public/direct ingress and opaque adoption. No arbitrary-object owned-retain method exists. */
export function createWorkerPreparedViewScope(options: { snapshotEncoding?: SnapshotEncoding; visualTraces?:boolean } = {}): WorkerPreparedViewScope {
  const encoding = options.snapshotEncoding ?? 'native';
  if (encoding !== 'portable' && encoding !== 'native') throw new Error('INVALID_SNAPSHOT_ENCODING');
  const chunks = encoding === 'native' ? nativeChunks : chunksFromNormalizedView;
  const entries = new WeakMap<PreparedViewHandle, Prepared>(); let recipient: string | undefined;
  const read = (handle: PreparedViewHandle) => { const entry = entries.get(handle); if (!entry) throw new Error('INVALID_PREPARED_VIEW'); return entry; };
  const retain = (entry: Prepared): PreparedViewHandle => {
    if (recipient !== undefined && recipient !== entry.boundary.playerId) throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    if(options.visualTraces===false){const view=withoutVisualTraces(entry.view);if(view!==entry.view)entry={...entry,view};}
    const handle = Object.freeze(Object.create(null)) as PreparedViewHandle;
    entries.set(handle, entry); recipient = entry.boundary.playerId; return handle;
  };
  return Object.freeze({
    prepare(input: unknown): PreparedViewHandle {
      const view = validated(validatePlayerView.capture(input, { enumerableOnly: true }));
      // Capture already owns plain data. Bound its byte size before retaining any direct offer.
      const census = inspectOwnedJson(view);
      if (census.sizeFallback && Buffer.byteLength(JSON.stringify(view), 'utf8') > SNAPSHOT_MAX_BYTES) throw new Error('SNAPSHOT_TOO_LARGE');
      return retain(normalize(view));
    },
    prepareJson(text: unknown): PreparedViewHandle { return retain(normalize(validated(validatePlayerView.parseJson(text, SNAPSHOT_MAX_BYTES)))); },
    adopt(handle: SharedWorkerView): PreparedViewHandle { return retain(readShared(handle)); },
    boundary(handle: PreparedViewHandle): PreparedViewBoundary { return read(handle).boundary; },
    delta(base: PreparedViewHandle, next: PreparedViewHandle) { return deltaFromValidatedViews(read(base).view, read(next).view, true); },
    encodeDeltaMessage(base: PreparedViewHandle, next: PreparedViewHandle): string { return encodeDeltaMessageFromValidatedViews(read(base).view, read(next).view, true); },
    chunks(handle: PreparedViewHandle, transferId: string) { return chunks(read(handle).view, transferId); },
  });
}
/** Actual Node Worker owner: only its message callback can mint receive capabilities.
 * Tokens expire when that synchronous callback returns, and raw scheduled trees never leave this class.
 */
export class WorkerViewChannel {
  #worker: Worker;
  #lifetime: Lifetime = { generation: 0, closed: false };
  #transfers = new WeakMap<WorkerViewTransfer, { view: unknown; playerId: string; generation: number; validated: boolean; projection?: ProjectionRecord }>();
  #fog = new FogReceiver();
  readonly projectionStream = ++nextProjectionStream;
  #projectionGeneration = 0;
  onMessage: (message: any) => void = () => {};
  onView: (playerId: string, transfer: WorkerViewTransfer, stamp?: PublicationStamp, receivedAtMs?: number) => void = () => {};
  onError: (error: Error) => void = () => {};
  onExit: () => void = () => {};
  constructor(filename: string | URL, options?: WorkerOptions, metrics?: PerformanceDiagnostics) {
    this.#worker = new Worker(filename, options);
    this.#worker.on('message', message => {
      if (message?.type === 'projection-reset') {
        if (!Number.isSafeInteger(message.generation) || message.generation <= this.#projectionGeneration) { this.onError(new Error('STALE_PROJECTION_RESET')); return; }
        this.#projectionGeneration = message.generation; this.invalidateTransfers(); return;
      }
      if (message?.type === 'view-reset') {
        try { this.#fog.reset(message.generation); this.invalidateTransfers(); }
        catch (error) { this.onError(error as Error); }
        return;
      }
      if (message?.type !== 'view' && message?.type !== 'fog-view' && message?.type !== 'projection-view') { this.onMessage(message); return; }
      if (this.#lifetime.closed) return;
      const receivedAtMs = metrics?.now();
      let view = message.view;
      let projection: ProjectionRecord | undefined;
      if (message.type === 'projection-view') {
        const transfer = message.transfer as ProjectionTransfer;
        if (transfer?.generation !== this.#projectionGeneration || !Number.isSafeInteger(transfer?.patch?.revision) || transfer.patch.revision < 1) { this.onError(new Error('STALE_PROJECTION_TRANSFER')); return; }
        const requestToken = message.publicationRequest ?? 0;
        if (!Number.isSafeInteger(requestToken) || requestToken < 0) { this.onError(new Error('INVALID_PROJECTION_REQUEST')); return; }
        let acknowledged = false;
        projection = { transfer, stream: this.projectionStream, requestToken, acknowledge: failed => {
          if (acknowledged) return; acknowledged = true;
          if (this.#lifetime.closed) return;
          this.#worker.postMessage({ type: 'projection-credit', playerId: message.playerId, generation: transfer.generation, revision: transfer.patch.revision, ...(failed ? { failed: true } : {}) });
        }, reset: projectionResetter(this.#worker, this.#lifetime, transfer.generation) };
        view = transfer.patch.header;
      }
      const validated = message.type === 'fog-view';
      if (validated) {
        try {
          const receive = () => this.#fog.receive(message.transfer, message.playerId);
          view = metrics ? metrics.measure('prepare', receive) : receive();
        }
        catch (error) { this.onError(error as Error); return; }
      }
      const token = Object.freeze(Object.create(null)) as WorkerViewTransfer;
      this.#transfers.set(token, { view, playerId: message.playerId, generation: this.#lifetime.generation, validated, projection });
      try { this.onView(message.playerId, token, message.performanceStamp, receivedAtMs); }
      finally {
        // Unclaimed transfers cannot hold a source slot forever (e.g. last socket
        // disappeared before its unsubscribe reached the simulation boundary).
        if (projection && this.#transfers.has(token)) projection.acknowledge(true);
        this.#transfers.delete(token);
        // Application credit bounds internal transfer work, independently of sockets.
        if (validated && !this.#lifetime.closed) this.#worker.postMessage({ type: 'view-credit', playerId: message.playerId, generation: message.transfer.generation, token: message.transfer.token });
      }
    });
    this.#worker.on('error', error => this.onError(error));
    this.#worker.on('exit', () => { this.invalidateTransfers(); this.#fog.clear(); this.#lifetime.closed = true; this.onExit(); });
  }
  #read(token: WorkerViewTransfer, playerId: string) {
    const entry = this.#transfers.get(token);
    if (!entry || this.#lifetime.closed || entry.generation !== this.#lifetime.generation || entry.playerId !== playerId) return tokenError();
    return entry;
  }
  #take(token: WorkerViewTransfer, playerId: string): unknown {
    const entry = this.#read(token, playerId); this.#transfers.delete(token); return entry.view;
  }
  /** Small detached header for gateway status bookkeeping; full view validation still precedes publication. */
  header(token: WorkerViewTransfer, playerId: string): WorkerViewBoundary {
    const value = this.#read(token, playerId).view;
    if (!value || typeof value !== 'object') return invalid();
    const view = value as PlayerView;
    if (view.protocolVersion !== PROTOCOL_VERSION || typeof view.contentHash !== 'string' || typeof view.matchId !== 'string' || view.playerId !== playerId
      || ![view.matchEpoch, view.sequence, view.tick].every(number => Number.isSafeInteger(number) && number >= 0)
      || !['LOADING','COUNTDOWN','RUNNING','PAUSED','FINISHED'].includes(view.status)) return invalid();
    const { protocolVersion, contentHash, matchId, matchEpoch, sequence, tick, status } = view;
    return Object.freeze({ protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick, status });
  }
  /** Retained JSON baseline. Tokens, not caller-owned objects, are the only accepted input. */
  serialize(token: WorkerViewTransfer, playerId: string, countdown = false): string {
    if (this.#read(token, playerId).projection) throw new Error('PROJECTION_FANOUT_REQUIRED');
    const view = this.#take(token, playerId) as PlayerView;
    if (!view || view.playerId !== playerId) throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    return JSON.stringify({ ...view, status: countdown ? 'COUNTDOWN' : view.status });
  }
  /** Defer full validation/encoding to a separate worker without serializing on the gateway. */
  defer(token: WorkerViewTransfer, playerId: string, countdown = false): WorkerPublicationView {
    const projection = this.#read(token, playerId).projection;
    const header = this.header(token, playerId), input = this.#take(token, playerId) as PlayerView;
    const handle = Object.freeze(Object.create(null)) as WorkerPublicationView;
    publication.set(handle, { view: countdown ? { ...input, status: 'COUNTDOWN' } : input,
      header: countdown ? Object.freeze({ ...header, status: 'COUNTDOWN' }) : header,
      lifetime: this.#lifetime, generation: this.#lifetime.generation, projection, countdown });
    return handle;
  }
  consume(token: WorkerViewTransfer, playerId: string, countdown = false, metrics?: PerformanceDiagnostics): SharedWorkerView {
    if (this.#read(token, playerId).projection) throw new Error('PROJECTION_FANOUT_REQUIRED');
    const alreadyValidated = this.#read(token, playerId).validated;
    const input = this.#take(token, playerId);
    if (!input || typeof input !== 'object') return invalid();
    if (alreadyValidated) {
      let view = input as PlayerView;
      // Status substitution can increase the complete byte size. Retain full
      // validation for this rare gateway-only change instead of relaxing the cap.
      if (countdown && view.status !== 'COUNTDOWN') view = validated(validatePlayerView.parseJson(JSON.stringify({ ...view, status: 'COUNTDOWN' }), SNAPSHOT_MAX_BYTES));
      const { protocolVersion, contentHash, matchId, matchEpoch, sequence, tick, status } = view;
      const boundary = Object.freeze({ protocolVersion, contentHash, matchId, matchEpoch, playerId, sequence, tick });
      const prepared = { view, boundary, header: Object.freeze({ ...boundary, status }) };
      const handle = Object.freeze(Object.create(null)) as SharedWorkerView;
      shared.set(handle, { prepared, lifetime: this.#lifetime, generation: this.#lifetime.generation });
      metrics?.count('fogPreparedViews'); return handle;
    }
    const candidate = countdown ? { ...(input as PlayerView), status: 'COUNTDOWN' } : input;
    const census = measure(metrics, 'ownedSafetySize', () => inspectOwnedJson(candidate));
    let view: PlayerView;
    if (census.sizeFallback || census.semanticFallback) {
      metrics?.count('ownedJsonFallbacks');
      if (census.sizeFallback) metrics?.count('ownedSizeFallbacks');
      if (census.semanticFallback) metrics?.count('ownedSemanticFallbacks');
      view = measure(metrics, 'ownedJsonFallback', () => validated(validatePlayerView.parseJson(JSON.stringify(candidate), SNAPSHOT_MAX_BYTES)));
    } else {
      if (!measure(metrics, 'ownedSchema', () => compiledView(candidate))) {
        if (compiledView.errors?.some(error => error.keyword === 'maxItems' && error.instancePath === '/entities')) throw new Error('SNAPSHOT_TOO_LARGE');
        return invalid();
      }
      view = candidate as PlayerView;
    }
    if (view.playerId !== playerId) throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    const prepared = normalize(view, metrics), handle = Object.freeze(Object.create(null)) as SharedWorkerView;
    shared.set(handle, { prepared, lifetime: this.#lifetime, generation: this.#lifetime.generation });
    metrics?.count('ownedPreparedViews'); return handle;
  }
  invalidateTransfers(): void { this.#lifetime.generation++; this.#transfers = new WeakMap(); }
  postMessage(message: unknown): void { this.#worker.postMessage(message); }
  /** Lifecycle-only access preserves existing failure tests without exposing raw message listeners. */
  once(event: 'online', listener: () => void): this {
    if (event !== 'online') throw new Error('INVALID_WORKER_EVENT'); this.#worker.once(event, listener); return this;
  }
  async terminate(): Promise<number> { this.invalidateTransfers(); this.#fog.clear(); this.#lifetime.closed = true; return this.#worker.terminate(); }
}
