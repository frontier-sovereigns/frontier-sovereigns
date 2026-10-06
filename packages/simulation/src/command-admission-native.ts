import { MessagePort } from 'node:worker_threads';

export interface NativeCommandItem {
  id: number;
  playerId: string;
  command: unknown;
  diagnosticSentAtMs?: number;
  requestExpiresAtMs?: number;
}

declare const nativeCommandBatchBrand: unique symbol;
/** One-use owner of a fixed, detached list. No caller callbacks or iterators run
 * between admissions; only the captured native clock and IPC sender do. */
export interface NativeCommandBatch { readonly [nativeCommandBatchBrand]: true }

const nativeHasRef = Function.prototype.call.bind(MessagePort.prototype.hasRef) as (port: MessagePort) => boolean;
const nativePost = Function.prototype.call.bind(MessagePort.prototype.postMessage) as (port: MessagePort, value: unknown) => void;
const nativeClone = structuredClone;
const nativeNanoseconds = process.hrtime.bigint;
const entries = new WeakMap<NativeCommandBatch, { port: MessagePort; items: NativeCommandItem[] }>();

/** Internal worker adapter. Cloning happens before a simulation scope opens, so
 * getters in unsupported caller fixtures cannot execute during shared reads.
 * Normal inputs already crossed native worker IPC; this copy owns the list. */
export function createNativeCommandBatch(port: MessagePort, items: readonly NativeCommandItem[]): NativeCommandBatch {
  try { nativeHasRef(port); } catch { throw new Error('INVALID_NATIVE_COMMAND_PORT'); }
  const owned = nativeClone(items) as NativeCommandItem[];
  if (!Array.isArray(owned)) throw new Error('INVALID_NATIVE_COMMAND_BATCH');
  const handle = Object.freeze(Object.create(null)) as NativeCommandBatch;
  entries.set(handle, { port, items: owned });
  return handle;
}

/** Claim before admitting anything, including validation failures. The returned
 * methods close over genuine intrinsics; replacing port.postMessage cannot
 * inspect a receipt or mutate the simulation before the next command. */
export function consumeNativeCommandBatch(handle: NativeCommandBatch) {
  const entry = entries.get(handle);
  if (!entry) throw new Error('INVALID_NATIVE_COMMAND_BATCH');
  entries.delete(handle);
  return Object.freeze({
    items: entry.items as readonly NativeCommandItem[],
    expired: (deadline: number): boolean => Number(nativeNanoseconds()) / 1e6 >= deadline,
    reply: (id: number, value?: unknown, error?: string): void => nativePost(entry.port, { id, value, error }),
  });
}
