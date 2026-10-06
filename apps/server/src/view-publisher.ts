import { randomBytes } from 'node:crypto';
import { createPreparedViewScope, type PlayerView, type PreparedViewBoundary, type PreparedViewHandle, type PreparedViewScope } from '@frontier/shared';
import type { PerformanceDiagnostics } from './performance-diagnostics.js';
import { nativeDeltaChunksFromEncodedMessage, type SharedWorkerView } from './worker-view-channel.js';
type PublicationScope = PreparedViewScope & { adopt?: (handle: SharedWorkerView) => PreparedViewHandle };

interface Transport {
  readyState: number; bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}
// A small ordered window avoids an encoder/gateway round trip for every chunk.
// The next delta base still waits for every callback in the whole transfer.
export const PUBLICATION_CHUNK_WINDOW = 4;
const sameViewpoint = (a: PreparedViewBoundary, b: PreparedViewBoundary) => a.playerId === b.playerId && a.matchId === b.matchId && a.matchEpoch === b.matchEpoch && a.contentHash === b.contentHash;

/** One completed base and one coalesced latest view per authenticated socket. */
export class ViewPublisher {
  private scope: PublicationScope;
  private base?: PreparedViewHandle;
  private pending?: PreparedViewHandle;
  private force = true;
  private pumping = false;
  private generation = 0;
  constructor(private readonly socket: Transport, private readonly performanceMetrics?: PerformanceDiagnostics,
    private readonly scopeFactory: (options?:{visualTraces?:boolean}) => PublicationScope = createPreparedViewScope,
    private readonly snapshotCompleted?: (boundary: PreparedViewBoundary) => void,
    // The current opt-in bundle accepts chunked deltas and bounded visual traces.
    // Older sessions receive legacy entity fields even after a forced reset.
    private readonly deltaChunks = false,
    private readonly viewCompleted?: (boundary: PreparedViewBoundary) => void) { this.scope = scopeFactory({visualTraces:deltaChunks}); }
  reset(): void { this.generation++; this.scope = this.scopeFactory({visualTraces:this.deltaChunks}); this.base = undefined; this.pending = undefined; this.force = true; }
  offer(view: PlayerView, forceSnapshot = false): void {
    if (this.socket.readyState !== 1) return;
    let prepared: PreparedViewHandle;
    try { prepared = this.performanceMetrics ? this.performanceMetrics.measure('prepare', () => this.scope.prepare(view)) : this.scope.prepare(view); } catch (error) { this.fail(error); return; }
    this.accept(prepared, forceSnapshot);
  }
  /** Only JSON text enters the parse-owned path; object offers retain descriptor validation. */
  offerJson(text: unknown, forceSnapshot = false): void {
    if (this.socket.readyState !== 1) return;
    let prepared: PreparedViewHandle;
    try { prepared = this.performanceMetrics ? this.performanceMetrics.measure('prepare', () => this.scope.prepareJson(text)) : this.scope.prepareJson(text); } catch (error) { this.fail(error); return; }
    this.accept(prepared, forceSnapshot);
  }
  offerPrepared(handle: SharedWorkerView, forceSnapshot = false): void {
    if (this.socket.readyState !== 1) return;
    try {
      const adopt = () => { if (!this.scope.adopt) throw new Error('INVALID_PREPARED_VIEW'); return this.scope.adopt(handle); };
      const prepared = this.performanceMetrics ? this.performanceMetrics.measure('preparedAdoption', adopt) : adopt();
      this.accept(prepared, forceSnapshot);
    } catch (error) { this.fail(error); }
  }
  rejectPublication(error: unknown): void { this.fail(error); }
  private accept(prepared: PreparedViewHandle, forceSnapshot: boolean): void {
    const boundary = this.scope.boundary(prepared), pending = this.pending && this.scope.boundary(this.pending), base = this.base && this.scope.boundary(this.base);
    this.force ||= forceSnapshot;
    if (pending && sameViewpoint(pending, boundary) && pending.sequence > boundary.sequence) { this.performanceMetrics?.count('staleViewOffers'); return; }
    if (!this.force && base && sameViewpoint(base, boundary) && base.sequence >= boundary.sequence) { this.performanceMetrics?.count('staleViewOffers'); return; }
    if (this.pending) this.performanceMetrics?.count('coalescedViewOffers');
    this.pending = prepared;
    if (!this.pumping) void this.pump();
  }
  private fail(error: unknown): void {
    const code = error instanceof Error && error.message === 'SNAPSHOT_TOO_LARGE' ? 'SNAPSHOT_TOO_LARGE' : 'SLOW_CLIENT_RECONNECT';
    this.reset();
    if (this.socket.readyState === 1) this.socket.close(4008, code);
  }
  private write(encoded: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== 1) return reject(new Error('SOCKET_CLOSED'));
      if (this.socket.bufferedAmount > 1024 * 1024) return reject(new Error('SLOW_CLIENT_RECONNECT'));
      const started = this.performanceMetrics?.now();
      const timer = setTimeout(() => { this.performanceMetrics?.count('sendTimeouts'); reject(new Error('SLOW_CLIENT_RECONNECT')); }, 5000); timer.unref();
      try { this.socket.send(encoded, error => { clearTimeout(timer); if (this.performanceMetrics) this.performanceMetrics.sample('sendCallback', this.performanceMetrics.now() - started!); if (error) reject(error); else resolve(); }); }
      catch (error) { clearTimeout(timer); reject(error); }
    });
  }
  private async writeChunks(chunks: readonly unknown[], generation: number): Promise<void> {
    for (let index = 0; index < chunks.length && generation === this.generation; index += PUBLICATION_CHUNK_WINDOW) {
      // send() preserves WebSocket order; Promise.all only pipelines completion
      // callbacks. Rejections stay observed for every already-issued write.
      await Promise.all(chunks.slice(index, index + PUBLICATION_CHUNK_WINDOW).map(chunk => this.write(JSON.stringify(chunk))));
    }
  }
  private async pump(): Promise<void> {
    this.pumping = true;
    let generation = this.generation;
    try {
      while (this.pending && this.socket.readyState === 1) {
        const next = this.pending, scope = this.scope;
        generation = this.generation;
        const nextBoundary = scope.boundary(next), baseBoundary = this.base && scope.boundary(this.base);
        this.pending = undefined;
        let full = this.force || !baseBoundary || !sameViewpoint(baseBoundary, nextBoundary);
        if(full)this.performanceMetrics?.count('fullSnapshotForced');
        this.force = false;
        if (baseBoundary && sameViewpoint(baseBoundary, nextBoundary) && nextBoundary.sequence < baseBoundary.sequence) continue;
        if (!full && this.base) {
          let encoded;
          try { encoded = this.performanceMetrics ? this.performanceMetrics.measure('deltaEncode', () => scope.encodeDeltaMessage(this.base!, next)) : scope.encodeDeltaMessage(this.base, next); } catch { full = true; this.performanceMetrics?.count('fullSnapshotDeltaEncodingFallback'); }
          if (encoded) {
            if (Buffer.byteLength(encoded) <= 65536) await this.write(encoded);
            else if(!this.deltaChunks){full=true;this.performanceMetrics?.count('fullSnapshotLegacyDeltaLimit');}
            else {
              // Preserve the smaller change set instead of amplifying it into
              // an entire authorized viewpoint at the single-message byte boundary.
              let chunks;
              try { const encodeChunks=()=>nativeDeltaChunksFromEncodedMessage(encoded!,{...nextBoundary,baseSequence:baseBoundary!.sequence},`delta_${randomBytes(12).toString('hex')}`);chunks=this.performanceMetrics?this.performanceMetrics.measure('deltaChunks',encodeChunks):encodeChunks(); }
              catch { full=true;this.performanceMetrics?.count('fullSnapshotDeltaChunkFallback'); }
              if(chunks){
                this.performanceMetrics?.count('chunkedDeltaTransfers');
                await this.writeChunks(chunks,generation);
              }
            }
          }
        }
        if (full) {
          const transferId = `snapshot_${randomBytes(12).toString('hex')}`;
          const chunks = this.performanceMetrics ? this.performanceMetrics.measure('snapshotChunks', () => scope.chunks(next, transferId)) : scope.chunks(next, transferId);
          this.performanceMetrics?.count('fullSnapshotTransfers');
          await this.writeChunks(chunks,generation);
        }
        if (generation === this.generation) {
          if (!baseBoundary || !sameViewpoint(baseBoundary, nextBoundary) || nextBoundary.sequence > baseBoundary.sequence) this.performanceMetrics?.count('completedDistinctViewSequences');
          this.base = next;
          if (full) this.snapshotCompleted?.(nextBoundary);
          this.viewCompleted?.(nextBoundary);
        }
      }
    } catch (error) {
      // An obsolete write can fail after a resync already supplied a replacement
      // epoch. It must not clear or close that replacement publication.
      if (generation === this.generation) this.fail(error);
    } finally {
      this.pumping = false;
      if (this.pending && this.socket.readyState === 1) void this.pump();
    }
  }
}
