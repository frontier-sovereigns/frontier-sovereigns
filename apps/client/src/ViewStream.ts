import { SnapshotAssembler, DeltaAssembler, applyViewDelta, normalizePlayerView, validateServerSocketMessage, validateConsistentPlayerView, type PlayerView, type PlayerViewDelta, type ServerSocketMessage } from '@frontier/shared';

type AuxiliaryMessage = Extract<ServerSocketMessage, { type: 'lobby' | 'receipt' | 'command_received' | 'error' | 'communication' }>;
export type StreamResult = { type: 'view'; view: PlayerView; resetInterpolation: boolean } | { type: 'event'; message: AuxiliaryMessage } | { type: 'resync'; reason?: string } | { type: 'pending' };
/** Holds the last complete recipient view until another complete, validated state exists. */
export class ViewStream {
  private readonly assembler = new SnapshotAssembler();
  private readonly deltaAssembler = new DeltaAssembler();
  private current: PlayerView | null = null;
  private awaitingSnapshot = true;
  private requested = false;
  private requestedAt = 0;
  private assemblyBoundary = '';
  constructor(private readonly playerId: string | undefined, private contentHash: string) {}
  setContentHash(hash:string):void { if(hash!==this.contentHash){this.contentHash=hash;this.reset();} }
  get view(): PlayerView | null { return this.current; }
  get synchronizing(): boolean { return this.awaitingSnapshot; }
  reset(): void { this.current = null; this.assembler.reset(); this.deltaAssembler.reset(); this.awaitingSnapshot = true; this.requested = false; this.assemblyBoundary = ''; }
  requestSnapshot(now: number, reason?: string): StreamResult {
    this.assembler.reset(); this.deltaAssembler.reset(); this.assemblyBoundary = ''; this.awaitingSnapshot = true;
    if (this.requested) return { type: 'pending' };
    this.requested = true; this.requestedAt = now; return { type: 'resync', reason };
  }
  poll(now: number): StreamResult {
    if (this.assembler.expire(now)) { this.requested = false; return this.requestSnapshot(now, 'Snapshot transfer timed out. Requesting a fresh viewpoint.'); }
    if (this.deltaAssembler.expire(now)) { this.requested = false; return this.requestSnapshot(now, 'Viewpoint update timed out. Requesting a fresh snapshot.'); }
    if (this.requested && !this.assemblyBoundary && now - this.requestedAt >= 10000) { this.requested = false; return this.requestSnapshot(now, 'Waiting for a complete viewpoint from the host.'); }
    return { type: 'pending' };
  }
  ingest(input: unknown, now: number): StreamResult {
    if (!validateServerSocketMessage(input)) return this.requestSnapshot(now, 'Viewpoint validation failed. Requesting a fresh snapshot.');
    if (input.type === 'lobby' || input.type === 'receipt' || input.type === 'command_received' || input.type === 'error' || input.type === 'communication') return { type: 'event', message: input };
    const header = input.type === 'snapshot' ? input.view : input.type === 'delta' ? input.delta : input;
    if (header.playerId !== this.playerId || header.contentHash !== this.contentHash) return this.requestSnapshot(now, 'Content or viewpoint mismatch. Reload to obtain the current game content.');
    const sameMatch = this.current?.matchId === header.matchId;
    if (sameMatch && (header.matchEpoch < this.current!.matchEpoch || header.matchEpoch === this.current!.matchEpoch && header.sequence < this.current!.sequence)) return { type: 'pending' };
    if (input.type === 'delta' || input.type === 'delta_chunk') {
      if (this.awaitingSnapshot) return { type: 'pending' };
      if (sameMatch && header.matchEpoch === this.current?.matchEpoch && header.sequence === this.current.sequence) return { type: 'pending' };
      let delta: PlayerViewDelta;
      if (input.type === 'delta_chunk') {
        // A partial update never advances the viewpoint or command watermark.
        // Reject a gap before retaining any payload, then recheck on application.
        if (!this.current || !sameMatch || input.matchEpoch !== this.current.matchEpoch || input.baseSequence !== this.current.sequence) return this.requestSnapshot(now, 'Viewpoint sequence gap. Synchronizing with the host.');
        const result = this.deltaAssembler.push(input, now);
        if (result.status === 'pending') return { type: 'pending' };
        if (result.status === 'rejected') return this.requestSnapshot(now, `Viewpoint update rejected (${result.code}). Synchronizing with the host.`);
        delta = result.delta;
      } else delta = input.delta;
      const next = this.current && applyViewDelta(this.current, delta);
      if (!next) return this.requestSnapshot(now, 'Viewpoint sequence gap. Synchronizing with the host.');
      this.current = next; this.deltaAssembler.reset(); return { type: 'view', view: next, resetInterpolation: false };
    }
    let next: PlayerView;
    if (input.type === 'snapshot_chunk') {
      if (!this.awaitingSnapshot && sameMatch && input.matchEpoch === this.current?.matchEpoch && input.sequence === this.current.sequence) return { type: 'pending' };
      // A full replacement supersedes an incomplete update immediately. Its
      // deadline starts independently, and only one payload remains retained.
      this.deltaAssembler.reset(); this.awaitingSnapshot = true;
      const boundary = `${input.matchId}:${input.matchEpoch}:${input.playerId}`;
      if (this.assemblyBoundary && this.assemblyBoundary !== boundary) this.assembler.reset();
      if (!this.assemblyBoundary) this.requested = false;
      this.assemblyBoundary = boundary;
      const result = this.assembler.push(input, now);
      if (result.status === 'pending') return { type: 'pending' };
      if (result.status === 'rejected') return this.requestSnapshot(now, `Snapshot rejected (${result.code}). Synchronizing with the host.`);
      next = result.view;
    } else { if (!validateConsistentPlayerView(input.view)) return this.requestSnapshot(now, 'Invalid snapshot state. Synchronizing with the host.'); next = normalizePlayerView(input.view); }
    if (this.current?.matchId === next.matchId && this.current.matchEpoch === next.matchEpoch && next.self.lastCommandSequence < this.current.self.lastCommandSequence) return this.requestSnapshot(now, 'Command boundary mismatch. Synchronizing with the host.');
    this.current = next; this.assembler.reset(); this.deltaAssembler.reset(); this.assemblyBoundary = ''; this.awaitingSnapshot = false; this.requested = false;
    return { type: 'view', view: next, resetInterpolation: true };
  }
}

export function nextCommandSequence(memory: number, stored: string | null, serverBoundary: number): number {
  const parsed = Number(stored), persisted = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  const sequence = Math.max(memory, persisted, serverBoundary) + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('Command sequence exhausted. Rejoin the match.');
  return sequence;
}
