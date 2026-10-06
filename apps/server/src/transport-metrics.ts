interface TextTransport {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}

export const TRANSPORT_WINDOW_MS = 10000;
const BUCKET_MS = 1000;

/** Counts application payloads handed to send, not delivery or network framing.
 * One fixed ten-bucket ring belongs to each current connection; no text is kept.
 * The original socket and its send overloads are never replaced or modified. */
export class MeteredTransport {
  private totalBytes = 0;
  private lastTime = 0;
  private buckets = Array.from({ length: TRANSPORT_WINDOW_MS / BUCKET_MS }, () => ({ second: -1, bytes: 0 }));
  constructor(private readonly socket: TextTransport, private readonly clock: () => number = Date.now,
    private readonly inspectOutbound?: (text: string) => void) {}
  get readyState(): number { return this.socket.readyState; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  close(code: number, reason: string): void { this.socket.close(code, reason); }
  send(data: string, callback?: (error?: Error) => void): void {
    // Trusted, opt-in qualification audit; never receives credentials from a client.
    this.inspectOutbound?.(data);
    const bytes = Buffer.byteLength(data, 'utf8');
    // Preserve receiver, callback identity and error behavior. A throwing send
    // contributes nothing; a later callback failure is still an enqueued attempt.
    if (callback === undefined) this.socket.send(data);
    else this.socket.send(data, callback);
    this.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.totalBytes + bytes);
    const second = this.second(), bucket = this.buckets[second % this.buckets.length]!;
    if (bucket.second !== second) { bucket.second = second; bucket.bytes = 0; }
    bucket.bytes = Math.min(Number.MAX_SAFE_INTEGER, bucket.bytes + bytes);
  }
  private second(): number {
    this.lastTime = Math.max(this.lastTime, this.clock());
    return Math.floor(this.lastTime / BUCKET_MS);
  }
  snapshot(): { totalBytes: number; bytesPerSecond: number } {
    const second = this.second();
    const bytes = this.buckets.reduce((sum, bucket) => bucket.second > second - this.buckets.length && bucket.second <= second ? Math.min(Number.MAX_SAFE_INTEGER, sum + bucket.bytes) : sum, 0);
    // Fixed denominator also during the first ten seconds. Includes the current
    // partial one-second bucket and the previous nine; no per-message history.
    return { totalBytes: this.totalBytes, bytesPerSecond: bytes / (TRANSPORT_WINDOW_MS / 1000) };
  }
}
