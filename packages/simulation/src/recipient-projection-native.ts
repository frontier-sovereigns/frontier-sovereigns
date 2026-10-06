import { MessagePort } from 'node:worker_threads';
import type { ProjectionPatch } from './recipient-projection.js';

declare const nativeProjectionBrand: unique symbol;
/** A one-use capability, never a borrowed projection record. */
export interface NativeProjection { readonly [nativeProjectionBrand]: true }
type Header = Readonly<ProjectionPatch['header']>;
interface Lifetime { epoch: number; closed: boolean; current?: NativeProjection }
interface Entry { patch: ProjectionPatch; header: Header; lifetime: Lifetime; epoch: number }
const entries = new WeakMap<NativeProjection, Entry>();
// Capture genuine native methods once. Neither prototype lookups at send time nor
// a caller's own postMessage/hasRef implementation may observe the private tree.
const nativeHasRef = Function.prototype.call.bind(MessagePort.prototype.hasRef) as (port: MessagePort) => boolean;
const nativePost = Function.prototype.call.bind(MessagePort.prototype.postMessage) as (port: MessagePort, value: unknown) => void;
const invalid = (): never => { throw new Error('INVALID_NATIVE_PROJECTION'); };

function read(handle: NativeProjection): Entry {
  const entry = entries.get(handle);
  if (!entry || entry.lifetime.closed || entry.epoch !== entry.lifetime.epoch) return invalid();
  return entry;
}
function invalidate(lifetime: Lifetime): void {
  if (lifetime.current) entries.delete(lifetime.current);
  lifetime.current = undefined; lifetime.epoch++;
}

/** Internal owner scope. Its inputs are private presentation records; it exposes
 * only opaque handles and scalar headers, never an unwrap or a callback. */
export function createNativeProjectionScope() {
  const lifetime: Lifetime = { epoch: 0, closed: false };
  return Object.freeze({
    invalidate(): void { invalidate(lifetime); },
    close(): void { lifetime.closed = true; invalidate(lifetime); },
    prepare(patch: ProjectionPatch): NativeProjection {
      if (lifetime.closed) return invalid();
      const { protocolVersion, contentHash, matchId, matchEpoch, playerId, tick, sequence, status } = patch.header;
      if (![protocolVersion, matchEpoch, tick, sequence].every(Number.isSafeInteger) ||
          ![contentHash, matchId, playerId, status].every(value => typeof value === 'string')) return invalid();
      const header = Object.freeze({ protocolVersion, contentHash, matchId, matchEpoch, playerId, tick, sequence, status });
      const handle = Object.freeze(Object.create(null)) as NativeProjection;
      invalidate(lifetime); lifetime.current = handle;
      entries.set(handle, { patch, header, lifetime, epoch: lifetime.epoch });
      return handle;
    },
  });
}

export function nativeProjectionHeader(handle: NativeProjection): Header { return read(handle).header; }

export function isNativeProjectionPort(value: unknown): value is MessagePort {
  try { nativeHasRef(value as MessagePort); return true; } catch { return false; }
}

/** The only reader of private projection bodies is native structured-clone IPC.
 * This adapter knows no sockets, browser sessions, delivery policy or credentials.
 * Full patch/view validation remains at the receiving publication boundary. */
export function postNativeProjection(handle: NativeProjection, port: MessagePort,
  envelope: { generation: number; publicationRequest: number; performanceStamp?: unknown }): void {
  const entry = read(handle);
  if (!isNativeProjectionPort(port)) throw new Error('INVALID_NATIVE_PROJECTION_PORT');
  // Even a native clone/send failure consumes the capability. A producer with an
  // advanced base must fail closed or reset, never retry the same export silently.
  entries.delete(handle);
  if (entry.lifetime.current === handle) entry.lifetime.current = undefined;
  nativePost(port, { type: 'projection-view', playerId: entry.header.playerId,
    publicationRequest: envelope.publicationRequest, transfer: { generation: envelope.generation, patch: entry.patch },
    ...(envelope.performanceStamp !== undefined ? { performanceStamp: envelope.performanceStamp } : {}) });
}
