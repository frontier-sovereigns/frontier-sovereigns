import { parentPort, threadId, workerData } from 'node:worker_threads';
import { PUBLICATION_CHUNK_WINDOW, ViewPublisher } from './view-publisher.js';
import { createProjectionPreparedReceiver, createWorkerPreparedViewScope, type SnapshotEncoding } from './worker-view-channel.js';
import { PerformanceDiagnostics, type PerformancePhase } from './performance-diagnostics.js';
import type { PublicationReply, PublicationRequest } from './publication-pool.js';

if (!parentPort) throw new Error('PUBLICATION_WORKER_PORT_REQUIRED');
const port = parentPort, encoding: SnapshotEncoding = workerData.snapshotEncoding;
if (encoding !== 'native' && encoding !== 'portable') throw new Error('INVALID_SNAPSHOT_ENCODING');
const send = (reply: PublicationReply) => port.postMessage(reply);
interface Row { generation: number; publisher: ViewPublisher; metrics?: PerformanceDiagnostics; destroy: () => void; writes: Map<number, (error?: Error) => void> }
const channels = new Map<number, Row>();
const projections = new Map<number, ReturnType<typeof createProjectionPreparedReceiver>>();
let nextWrite = 0;
function open(channel: number, generation: number, enabled: boolean, deltaChunks: boolean): Row {
  const writes = new Map<number, (error?: Error) => void>();
  let active = true;
  const envelope = { channel, generation };
  class Metrics extends PerformanceDiagnostics {
    override sample(phase: PerformancePhase, durationMs: number): void { if (active) send({ type: 'sample', ...envelope, phase, durationMs }); }
    override count(name: string, amount = 1): void { if (active) send({ type: 'count', ...envelope, name, amount }); }
  }
  const socket = {
    get readyState() { return active ? 1 : 3; }, bufferedAmount: 0,
    send(text: string, callback: (error?: Error) => void) {
      if (!active || writes.size >= PUBLICATION_CHUNK_WINDOW) { callback(new Error('SLOW_CLIENT_RECONNECT')); return; }
      const writeId = ++nextWrite; writes.set(writeId, callback); send({ type: 'write', ...envelope, writeId, text });
    },
    close(code: number, reason: string) { if (active) { active = false; send({ type: 'close', ...envelope, code, reason }); } },
  };
  const metrics = enabled ? new Metrics() : undefined;
  const publisher = new ViewPublisher(socket, metrics, options => createWorkerPreparedViewScope({ ...options, snapshotEncoding: encoding }), boundary => {
    if (active) send({ type: 'snapshot-complete', ...envelope, boundary });
  }, deltaChunks, boundary => {
    if (active) send({ type: 'view-complete', ...envelope, boundary });
  });
  return { generation, publisher, metrics, writes, destroy() {
    active = false; publisher.reset();
    for (const callback of writes.values()) callback(new Error('PUBLICATION_RESET'));
    writes.clear();
  } };
}
port.on('message', (message: PublicationRequest) => {
  if (message.type === 'projection-reset') {
    let receiver = projections.get(message.stream);
    if (!receiver) { if (projections.size >= 16) throw new Error('PROJECTION_STREAM_LIMIT'); receiver = createProjectionPreparedReceiver(); projections.set(message.stream, receiver); }
    receiver.reset(message.generation); return;
  }
  if (message.type === 'projection-dispose') { projections.delete(message.stream); return; }
  if (message.type === 'projection') {
    let error: string | undefined, audit: string | undefined;
    try {
      const receiver = projections.get(message.stream);
      if (!receiver || message.transfer.generation !== message.generation) throw new Error('STALE_PROJECTION_TRANSFER');
      const metrics = message.targets.map(target => channels.get(target.channel)).find(row => row?.metrics)?.metrics;
      const prepare = () => {
        return receiver.receive(message.transfer, message.playerId, message.countdown, message.audit ? text => { audit = text; } : undefined);
      };
      const prepared = metrics ? metrics.measure('prepare', prepare) : prepare();
      for (const target of message.targets) {
        const row = channels.get(target.channel);
        if (row?.generation === target.generation) row.publisher.offerPrepared(prepared, target.force);
      }
    } catch (failure) {
      error = failure instanceof Error && failure.message === 'SNAPSHOT_TOO_LARGE' ? 'SNAPSHOT_TOO_LARGE' : 'INVALID_PROJECTION_TRANSFER';
      for (const target of message.targets) { const row = channels.get(target.channel); if (row?.generation === target.generation) row.publisher.rejectPublication(new Error(error)); }
    }
    send({ type: 'projection-credit', stream: message.stream, generation: message.generation, lease: message.lease, playerId: message.playerId, ...(error ? { error } : {}), ...(audit !== undefined ? { audit } : {}) }); return;
  }
  const current = channels.get(message.channel);
  if (message.type === 'open' || message.type === 'reset') {
    if (current && message.generation <= current.generation) return;
    current?.destroy();
    if (channels.size >= 128 && !current) { send({ type: 'close', channel: message.channel, generation: message.generation, code: 4008, reason: 'SLOW_CLIENT_RECONNECT' }); return; }
    channels.set(message.channel, open(message.channel, message.generation, message.metrics, message.deltaChunks === true)); return;
  }
  if (!current || current.generation !== message.generation) return;
  if (message.type === 'dispose') { current.destroy(); channels.delete(message.channel); return; }
  if (message.type === 'ack') {
    const callback = current.writes.get(message.writeId); current.writes.delete(message.writeId);
    callback?.(message.error ? new Error(message.error) : undefined); return;
  }
  if (message.type === 'offer') {
    try {
      if (message.json !== undefined) current.publisher.offerJson(message.json, message.force);
      // Preserve the retained JSON lane's undefined/-0/alias semantics while
      // moving both stringify and strict preparation off the gateway thread.
      else if (message.jsonBaseline) current.publisher.offerJson(JSON.stringify(message.view), message.force);
      else current.publisher.offer(message.view!, message.force);
    } catch (error) { current.publisher.rejectPublication(error); }
    send({ type: 'credit', channel: message.channel, generation: message.generation, offerId: message.offerId });
  }
});
send({ type: 'ready', threadId });
