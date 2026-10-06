import { afterEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { contentHash, createPreparedViewScope, normalizePlayerView, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_BYTES, SnapshotAssembler,
  validateConsistentPlayerView, type PlayerView, type SnapshotChunk } from '@frontier/shared';
import { createWorkerPreparedViewScope, WorkerViewChannel, type SnapshotEncoding } from '../apps/server/src/worker-view-channel.js';
import { ViewPublisher } from '../apps/server/src/view-publisher.js';

const channels: WorkerViewChannel[] = [];
afterEach(async () => { await Promise.all(channels.splice(0).map(channel => channel.terminate())); });
const modes: SnapshotEncoding[] = ['portable', 'native'];
function view(sequence = 1): PlayerView {
  return { protocolVersion: 2, contentHash, matchId: 'native_chunks', matchEpoch: 1, playerId: 'me', sequence, tick: sequence * 2, status: 'RUNNING',
    map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 },
    self: { lastCommandSequence: sequence, resources: { food: 50, wood: 50, gold: 0, stone: 0 }, age: 1, population: 1, populationCap: 15, populationLimit: 120, reservedPopulation: 0 },
    players: [{ id: 'me', name: '\u754c\ud83c\udff0\ud800\n"\\', teamId: 'blue', kind: 'human', color: '#abcdef' }],
    entities: [{ id: 'own', kind: 'unit', typeId: 'militia', ownerId: 'me', hp: 55, maxHp: 55, xMm: 2000 + sequence, zMm: 2000, cargo: { resource: 'gold', amount: sequence } }],
    fog: { visible: [2, 1], explored: [2, 0, 1] }, effects: [], projectiles: [] };
}
/** A valid protocol-size boundary fixture; not a feasible population/gameplay state. */
function sizedView(bytes: number): PlayerView {
  const input = view(), count = bytes < 1000000 ? 100 : 16000;
  input.entities = Array.from({ length: count }, (_, index) => ({ id: `unit_${String(index).padStart(5, '0')}`, kind: 'unit', typeId: 'militia', ownerId: 'me', hp: 55, maxHp: 55,
    xMm: 2000, zMm: 2000, order: '', garrisoned: [] }));
  let remaining = bytes - Buffer.byteLength(JSON.stringify(input)); expect(remaining).toBeGreaterThanOrEqual(0);
  for (const entity of input.entities) {
    for (let index = 0; index < 20; index++) {
      const overhead = index ? 3 : 2; if (remaining <= overhead) break;
      const length = Math.min(96, remaining - overhead); entity.garrisoned!.push('a'.repeat(length)); remaining -= length + overhead;
    }
    if (remaining <= 3) break;
  }
  expect(remaining).toBeLessThanOrEqual(3); input.entities[0]!.order = 'x'.repeat(remaining);
  expect(Buffer.byteLength(JSON.stringify(input))).toBe(bytes); expect(validateConsistentPlayerView(input)).toBe(true);
  return input;
}
const wire = (chunks: SnapshotChunk[]) => chunks.map(chunk => JSON.stringify(chunk));
function compare(input: PlayerView, transfer = 'fixed_native') {
  const reference = createPreparedViewScope(), handle = reference.prepareJson(JSON.stringify(input)), expected = wire(reference.chunks(handle, transfer));
  for (const snapshotEncoding of modes) {
    const scope = createWorkerPreparedViewScope({ snapshotEncoding }), prepared = scope.prepareJson(JSON.stringify(input)), chunks = scope.chunks(prepared, transfer);
    expect(wire(chunks)).toEqual(expected);
    expect(Object.keys(chunks[0]!)).toEqual(['type', 'transferId', 'protocolVersion', 'contentHash', 'matchId', 'matchEpoch', 'playerId', 'sequence', 'index', 'count', 'byteLength', 'sha256', 'data']);
    const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data, 'base64')));
    expect(bytes.length).toBe(chunks[0]!.byteLength); expect(createHash('sha256').update(bytes).digest('hex')).toBe(chunks[0]!.sha256);
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(normalizePlayerView(input));
    for (const [index, chunk] of chunks.entries()) { expect(chunk.index).toBe(index); expect(chunk.count).toBe(chunks.length); expect(Buffer.from(chunk.data, 'base64').length).toBeLessThanOrEqual(SNAPSHOT_CHUNK_BYTES); }
  }
  return expected;
}
describe('private Node native snapshot encoder', () => {
  it('keeps the Node default byte-identical to portable encoding and rejects unknown trusted selectors', () => {
    const input = view(), ordinary = createWorkerPreparedViewScope(), explicit = createWorkerPreparedViewScope({ snapshotEncoding: 'portable' });
    expect(ordinary.chunks(ordinary.prepare(input), 'default')).toEqual(explicit.chunks(explicit.prepare(input), 'default'));
    expect(() => createWorkerPreparedViewScope({ snapshotEncoding: 'invalid' as SnapshotEncoding })).toThrow('INVALID_SNAPSHOT_ENCODING');
  });
  it.each([SNAPSHOT_CHUNK_BYTES - 1, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_CHUNK_BYTES + 1])('matches exact chunks and padding at %i bytes including escaped Unicode', size => {
    const encoded = compare(sizedView(size)); expect(encoded.length).toBe(Math.ceil(size / SNAPSHOT_CHUNK_BYTES));
  });
  it('preserves exact 16 MiB admission and 512 chunks, then rejects one extra byte in both encoders', () => {
    const input = sizedView(SNAPSHOT_MAX_BYTES), raw = JSON.stringify(input), reference = createPreparedViewScope();
    const expected = wire(reference.chunks(reference.prepareJson(raw), 'maximum'));
    expect(expected).toHaveLength(512);
    for (const snapshotEncoding of modes) {
      const scope = createWorkerPreparedViewScope({ snapshotEncoding }), chunks = scope.chunks(scope.prepareJson(raw), 'maximum');
      expect(wire(chunks)).toEqual(expected); expect(chunks[511]).toMatchObject({ index: 511, count: 512, byteLength: SNAPSHOT_MAX_BYTES });
      expect(Buffer.from(chunks[511]!.data, 'base64')).toHaveLength(SNAPSHOT_CHUNK_BYTES);
    }
    input.entities[0]!.order += 'x'; const over = JSON.stringify(input);
    expect(Buffer.byteLength(over)).toBe(SNAPSHOT_MAX_BYTES + 1);
    expect(() => createPreparedViewScope().prepareJson(over)).toThrow('SNAPSHOT_TOO_LARGE');
    for (const snapshotEncoding of modes) {
      expect(() => createWorkerPreparedViewScope({ snapshotEncoding }).prepareJson(over)).toThrow('SNAPSHOT_TOO_LARGE');
      expect(() => createWorkerPreparedViewScope({ snapshotEncoding }).prepare(input)).toThrow('SNAPSHOT_TOO_LARGE');
    }
  }, 30000);
  it.each(modes)('preserves direct capture/getter/proxy/input/output alias safety (%s)', snapshotEncoding => {
    const input = view(), expected = JSON.parse(JSON.stringify(input)) as PlayerView, original = input.entities[0]!, scope = createWorkerPreparedViewScope({ snapshotEncoding }), reference = createPreparedViewScope();
    const expectedBase = reference.prepareJson(JSON.stringify(expected)); let reads = 0;
    input.entities[0] = new Proxy(original, { get() { reads++; throw new Error('proxy getter'); } });
    input.players = new Proxy(input.players, { ownKeys(target) { Object.defineProperty(input.self.resources, 'food', { get() { reads++; throw new Error('late getter'); } }); return Reflect.ownKeys(target); } });
    const before = scope.prepare(input); original.hp = 0; original.cargo!.amount = 999; input.fog.explored.length = 0;
    const next = view(2), after = scope.prepare(next), expectedNext = reference.prepareJson(JSON.stringify(next));
    next.entities[0]!.cargo!.amount = 999; next.self.resources.food = 999;
    const delta = scope.delta(before, after); delta.self.resources.food = 0; delta.updates[0]!.cargo!.amount = 0;
    scope.chunks(before, 'capture')[0]!.data = 'changed';
    expect(wire(scope.chunks(before, 'capture'))).toEqual(wire(reference.chunks(expectedBase, 'capture')));
    expect(scope.encodeDeltaMessage(before, after)).toBe(reference.encodeDeltaMessage(expectedBase, expectedNext)); expect(reads).toBe(0);
    const accessor = view(); Object.defineProperty(accessor.self.resources, 'food', { get() { reads++; return 50; } });
    expect(() => scope.prepare(accessor)).toThrow('INVALID_SNAPSHOT'); expect(reads).toBe(0);
    const hidden = view(); Object.defineProperty(hidden.entities[0]!, 'id', { enumerable: false });
    expect(() => scope.prepare(hidden)).toThrow('INVALID_SNAPSHOT');
  });
  it.each(modes)('keeps schema, consistency, handle/recipient and transfer-id rejection (%s)', snapshotEncoding => {
    const scope = createWorkerPreparedViewScope({ snapshotEncoding }), input = view(), handle = scope.prepare(input);
    for (const transfer of ['', 'bad transfer', 'a'.repeat(97)]) expect(() => scope.chunks(handle, transfer)).toThrow('INVALID_SNAPSHOT_TRANSFER');
    expect(() => scope.chunks({} as typeof handle, 'valid')).toThrow('INVALID_PREPARED_VIEW');
    expect(() => createWorkerPreparedViewScope({ snapshotEncoding }).chunks(handle, 'valid')).toThrow('INVALID_PREPARED_VIEW');
    const foreign = view(); foreign.playerId = 'other'; foreign.entities = [];
    expect(() => scope.prepareJson(JSON.stringify(foreign))).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    const invalid = view(); invalid.fog.visible.push(3);
    expect(() => scope.prepareJson(JSON.stringify(invalid))).toThrow('INVALID_SNAPSHOT');
    const secret = view(); secret.entities[0]!.ownerId = 'enemy';
    expect(() => scope.prepareJson(JSON.stringify(secret))).toThrow('INVALID_SNAPSHOT');
    expect(() => scope.prepareJson('{')).toThrow('INVALID_SNAPSHOT');
  });
  it.each(['json', 'owned'] as const)('keeps native chunks/deltas identical through actual Worker %s ingress', async preparation => {
    const channel = new WorkerViewChannel("const {parentPort}=require('node:worker_threads');parentPort.on('message',view=>parentPort.postMessage({type:'view',playerId:view.playerId,view}));", { eval: true }); channels.push(channel);
    const reference = createPreparedViewScope(), native = createWorkerPreparedViewScope({ snapshotEncoding: 'native' });
    const scopes = [reference, native], previous: ReturnType<typeof native.prepare>[] = [];
    for (const sequence of [1, 2]) {
      const input = view(sequence), expected = reference.prepareJson(JSON.stringify(input));
      const received = await new Promise<ReturnType<typeof native.prepare>>((resolve, reject) => {
        channel.onError = reject;
        channel.onView = (playerId, token) => {
          try { resolve(preparation === 'json' ? native.prepareJson(channel.serialize(token, playerId)) : native.adopt(channel.consume(token, playerId))); }
          catch (error) { reject(error); }
        };
        channel.postMessage(input);
      });
      const current = [expected, received];
      expect(wire(scopes[1]!.chunks(current[1]!, 'worker'))).toEqual(wire(scopes[0]!.chunks(current[0]!, 'worker')));
      if (sequence === 2) expect(scopes[1]!.encodeDeltaMessage(previous[1]!, current[1]!)).toBe(scopes[0]!.encodeDeltaMessage(previous[0]!, current[0]!));
      previous.splice(0, previous.length, ...current);
    }
  });
  it('keeps native multi-chunk reset and forced resync sticky without sending an old tail', async () => {
    const wire: string[] = [], callbacks: (() => void)[] = [], closed: string[] = [], completed: number[] = [];
    const transport = { readyState: 1, bufferedAmount: 0, send(text: string, done: (error?: Error) => void) { wire.push(text); callbacks.push(done); }, close(_code: number, reason: string) { closed.push(reason); } };
    const publisher = new ViewPublisher(transport, undefined, () => createWorkerPreparedViewScope({ snapshotEncoding: 'native' }), boundary => completed.push(boundary.sequence));
    const large = (sequence: number) => { const value = view(sequence); value.fog.explored = Array.from({ length: 102400 }, (_, cell) => cell); return value; };
    const drain = async () => { let count = 0; do { while (callbacks.length) { expect(++count).toBeLessThan(1024); callbacks.shift()!(); } await nextTurn(); } while (callbacks.length); };
    publisher.offer(large(1), true); expect(JSON.parse(wire[0]!).count).toBeGreaterThan(2);
    callbacks.shift()!(); await Promise.resolve(); await Promise.resolve(); const resetAt = wire.length;
    publisher.reset(); publisher.offerJson(JSON.stringify(large(2)), true); await drain();
    expect(completed).toEqual([2]);
    expect(wire.slice(resetAt).every(text => { const frame = JSON.parse(text); return frame.type === 'snapshot_chunk' && frame.sequence === 2; })).toBe(true);
    publisher.offerJson(JSON.stringify(large(3)), true); publisher.offerJson(JSON.stringify(large(4)), true); publisher.offerJson(JSON.stringify(large(5))); await drain();
    const assembler = new SnapshotAssembler(); let latest: PlayerView | undefined;
    for (const text of wire) { const frame = JSON.parse(text); expect(frame.type).toBe('snapshot_chunk'); const result = assembler.push(frame, 0); expect(result.status).not.toBe('rejected'); if (result.status === 'complete') latest = result.view; }
    expect(latest).toEqual(normalizePlayerView(large(5))); expect(completed).toEqual([2,3,5]); expect(closed).toEqual([]);
  });
});
