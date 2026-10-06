import { afterEach, describe, expect, it, vi } from 'vitest';
import { threadId, Worker } from 'node:worker_threads';
import { applyViewDelta, contentHash, normalizePlayerView, SnapshotAssembler, DeltaAssembler, validateServerSocketMessage, type PlayerView, type ServerSocketMessage } from '@frontier/shared';
import { PublicationWorker, ThreadedViewPublisher } from '../apps/server/src/publication-pool.js';
import { PUBLICATION_CHUNK_WINDOW } from '../apps/server/src/view-publisher.js';
import { WorkerViewChannel, type WorkerPublicationView } from '../apps/server/src/worker-view-channel.js';
import { PerformanceDiagnostics } from '../apps/server/src/performance-diagnostics.js';
import { RecipientProjection } from '../packages/simulation/src/recipient-projection.js';
import { computeWorkerEnvironment } from '../apps/server/src/compute-worker-environment.js';

const workers: PublicationWorker[] = [], channels: WorkerViewChannel[] = [], simulationWorkers: Worker[] = [];
afterEach(async () => { await Promise.all(workers.splice(0).map(worker => worker.close())); await Promise.all(channels.splice(0).map(channel => channel.terminate())); await Promise.all(simulationWorkers.splice(0).map(worker => worker.terminate())); });
function worker(snapshotEncoding: 'native' | 'portable' = 'native') { const value = new PublicationWorker({ snapshotEncoding }); workers.push(value); return value; }
function view(sequence = 1, large = false, playerId = 'blue'): PlayerView {
  return { protocolVersion: 2, contentHash, matchId: 'thread_publication', matchEpoch: 1, playerId, tick: sequence * 2, sequence, status: 'RUNNING',
    map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 }, self: { lastCommandSequence: sequence, resources: { food: 100, wood: 100, gold: 0, stone: 0 }, age: 1, population: 1, populationCap: 15, populationLimit: 120, reservedPopulation: 0 },
    players: [], entities: [{ id: `${playerId}_worker`, kind: 'unit', typeId: 'villager', ownerId: playerId, xMm: 10000 + sequence * 100, zMm: 10000, hp: 35, maxHp: 35, cargo: { resource: 'wood', amount: 7 }, order: 'gather' }],
    fog: { visible: [1], explored: large ? Array.from({ length: 102400 }, (_, index) => index) : [1] } };
}
class Transport {
  readyState = 1; bufferedAmount = 0; wire: string[] = []; callbacks: ((error?: Error) => void)[] = []; closed: { code: number; reason: string }[] = [];
  send(text: string, callback: (error?: Error) => void) { this.wire.push(text); this.callbacks.push(callback); }
  close(code: number, reason: string) { this.closed.push({ code, reason }); this.readyState = 3; }
  acknowledge(error?: Error) { const callback = this.callbacks.shift(); expect(callback).toBeDefined(); callback!(error); }
  decoded(): PlayerView | undefined {
    const assembler = new SnapshotAssembler(), deltaAssembler = new DeltaAssembler(); let current: PlayerView | undefined, epoch: number | undefined;
    for (const text of this.wire) {
      const frame = JSON.parse(text) as ServerSocketMessage; expect(validateServerSocketMessage(frame)).toBe(true);
      if (frame.type === 'snapshot_chunk') {
        deltaAssembler.reset();
        // The browser discards its previous assembly when the match epoch changes.
        if (epoch !== frame.matchEpoch) { assembler.reset(); current = undefined; epoch = frame.matchEpoch; }
        const result = assembler.push(frame, 0); expect(result.status).not.toBe('rejected'); if (result.status === 'complete') current = result.view;
      }
      else if (frame.type === 'delta_chunk') { expect(current).toBeDefined(); const result = deltaAssembler.push(frame, 0); expect(result.status).not.toBe('rejected'); if (result.status === 'complete') { current = applyViewDelta(current!, result.delta); expect(current).toBeDefined(); } }
      else if (frame.type === 'delta') { deltaAssembler.reset(); expect(current).toBeDefined(); current = applyViewDelta(current!, frame.delta); expect(current).toBeDefined(); }
      else throw new Error('UNEXPECTED_PUBLICATION_FRAME');
    }
    return current;
  }
  async drainTo(sequence: number, epoch = 1) {
    await until(() => {
      while (this.callbacks.length) this.acknowledge();
      const latest = this.decoded();
      if (this.closed.length) throw new Error(this.closed[0]!.reason);
      return latest?.sequence === sequence && latest.matchEpoch === epoch;
    });
    while (this.callbacks.length) this.acknowledge();
  }
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('PUBLICATION_TEST_TIMEOUT'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function deferred(input: PlayerView): Promise<{ channel: WorkerViewChannel; handle: WorkerPublicationView }> {
  const channel = new WorkerViewChannel(`const {parentPort}=require('node:worker_threads');parentPort.on('message',view=>parentPort.postMessage({type:'view',playerId:view.playerId,view}));`, { eval: true });
  channels.push(channel);
  const handle = await new Promise<WorkerPublicationView>((resolve, reject) => {
    channel.onError = reject; channel.onView = (playerId, token) => { try { resolve(channel.defer(token, playerId)); } catch (error) { reject(error); } };
    channel.postMessage(input);
  });
  return { channel, handle };
}
function projectionSource() {
  const channel = new WorkerViewChannel(`const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{
    if(m.type==='projection-credit'){parentPort.postMessage({...m,type:'credited'});return;}
    if(m.type==='projection-restart'){parentPort.postMessage({...m,type:'restart-request'});return;}
    if(m.reset)parentPort.postMessage({type:'projection-reset',generation:m.reset});
    parentPort.postMessage({type:'projection-view',playerId:m.transfer.patch.header.playerId,publicationRequest:m.publicationRequest,transfer:m.transfer});
  });`, { eval: true });
  channels.push(channel); const credits: { generation: number; revision: number; failed?: boolean }[] = [];
  channel.onMessage = message => { if (message.type === 'credited') credits.push(message); };
  let projection = new RecipientProjection();
  return { channel, credits,
    send(input: PlayerView, generation = 1, reset = false, countdown = false, publicationRequest = 0): Promise<WorkerPublicationView> {
      if (reset) projection = new RecipientProjection();
      projection.begin(); for (const entity of input.entities) projection.entity(structuredClone(entity));
      const { entities: _entities, ...fields } = input, patch = projection.finish(structuredClone(fields));
      return new Promise((resolve, reject) => {
        channel.onError = reject;
        channel.onView = (playerId, token) => { try { resolve(channel.defer(token, playerId, countdown)); } catch (error) { reject(error); } };
        channel.postMessage({ ...(reset ? { reset: generation } : {}), publicationRequest, transfer: { generation, patch } });
      });
    },
  };
}

describe('persistent threaded publication', () => {
  it('retains visual trace capability across threaded publication resets and shared projections', async () => {
    const pool=worker(),source=projectionSource(),modern=new Transport(),legacy=new Transport();
    const opted=pool.createPublisher(modern,undefined,true),ordinary=pool.createPublisher(legacy);
    for(const sequence of [1,2,3]){
      const input=view(sequence);input.tick=sequence*6;input.frameRevision=sequence;input.authoritativeIntervalMs=300;input.publicationIntervalMs=300;input.committedTimeMs=input.tick*50;
      const entity=input.entities[0]!;entity.visualAction={kind:'gather_wood',startedTick:input.tick-1};entity.visualTrace={complete:true,fromTick:input.tick-6,points:[{tick:input.tick-6,visualAction:{kind:'idle',startedTick:0}},{tick:input.tick,visualAction:{...entity.visualAction}}]};
      if(sequence===3){opted.reset();ordinary.reset();}
      const handle=await source.send(input,1,sequence===1);pool.offerProjection(handle,[ordinary,opted]);
      await Promise.all([modern.drainTo(sequence),legacy.drainTo(sequence)]);
      expect(modern.decoded()).toEqual(normalizePlayerView(input));const expected=normalizePlayerView(input);delete expected.entities[0]!.visualTrace;expect(legacy.decoded()).toEqual(expected);
      expect(input.entities[0]!.visualTrace).toBeDefined();
    }
    expect(modern.closed).toEqual([]);expect(legacy.closed).toEqual([]);
  });
  it('keeps chunked delta capability socket-local across the real publication worker', async () => {
    const pool=worker(),modern=new Transport(),legacy=new Transport(),opted=pool.createPublisher(modern,undefined,true),ordinary=pool.createPublisher(legacy);
    const dense=(sequence:number)=>{const input=view(sequence,true);input.entities=Array.from({length:600},(_,index)=>({...input.entities[0]!,id:`capability_${index}`}));return input;};
    for(const publisher of [opted,ordinary])publisher.offer(dense(1));await Promise.all([modern.drainTo(1),legacy.drainTo(1)]);const modernStart=modern.wire.length,legacyStart=legacy.wire.length;
    for(const publisher of [opted,ordinary])publisher.offer(dense(2));await Promise.all([modern.drainTo(2),legacy.drainTo(2)]);
    const updates=modern.wire.slice(modernStart).map(text=>JSON.parse(text)),fallback=legacy.wire.slice(legacyStart).map(text=>JSON.parse(text));
    expect(updates.length).toBeGreaterThan(1);expect(updates.every(frame=>frame.type==='delta_chunk'&&frame.baseSequence===1&&frame.sequence===2)).toBe(true);
    expect(fallback.length).toBeGreaterThan(1);expect(fallback.every(frame=>frame.type==='snapshot_chunk'&&frame.sequence===2)).toBe(true);
    expect(modern.decoded()).toEqual(normalizePlayerView(dense(2)));expect(legacy.decoded()).toEqual(modern.decoded());expect(modern.closed).toEqual([]);expect(legacy.closed).toEqual([]);
  });
  it.each(['construction', 'native-send'] as const)('fails the real simulation worker after a control publication %s failure instead of retaining an unsent base', async failureMode => {
    const simulationUrl = new URL('../packages/simulation/src/index.ts', import.meta.url).href, workerUrl = new URL('../apps/server/src/worker.ts', import.meta.url).href;
    // Patch only this test-owned isolate, then load the real worker entry. Both
    // imports use the same registered loader/module identity; no production
    // operation, port mock, or crash-injection hook is introduced.
    const source = `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {register}=await import('tsx/esm/api');register();
        const {Simulation}=await import(${JSON.stringify(simulationUrl)});
        const original=Simulation.prototype.publicationTransfers;
        Simulation.prototype.publicationTransfers=function(requests){
          const fail=workerData.failureMode==='construction'?this.state.status==='PAUSED':this.state.control.a?.mode==='caretaker';
          if(fail){
            if(workerData.failureMode==='construction')throw new Error('TEST_PROJECTION_CONSTRUCTION_FAILURE');
            const home=Object.values(this.state.entities).find(entity=>entity.kind==='building'&&entity.ownerId==='a');
            if(!home)throw new Error('TEST_HOME_MISSING');
            home.rally={xMm:home.xMm,zMm:home.zMm,uncloneable:()=>undefined};
          }
          const handles=original.call(this,requests);
          if(fail&&workerData.failureMode==='native-send')parentPort.postMessage({type:'test-native-export-prepared',count:handles.length});
          return handles;
        };
        await import(${JSON.stringify(workerUrl)});
        parentPort.postMessage({type:'test-ready'});
      })().catch(error=>setImmediate(()=>{throw error;}));`;
    const simulationWorker = new Worker(source, { eval: true, execArgv: [], env: computeWorkerEnvironment(), workerData: { failureMode, projectionTransfer: true, planningWorkers: 0, visionWorkers: 0 } });
    simulationWorkers.push(simulationWorker);
    const packets: any[] = []; let failure: Error | undefined, exitCode: number | undefined, triggered = false, requestId = 0;
    const retryId = 10000;
    simulationWorker.on('message', packet => packets.push(packet));
    simulationWorker.on('error', error => {
      failure = error;
      // The worker must be terminal after publication fails, even if the caller
      // retries a harmless request while the error/exit events are in transit.
      if (triggered) { try { simulationWorker.postMessage({ id: retryId, type: 'diagnostics' }); } catch { /* already terminated */ } }
    });
    simulationWorker.on('exit', code => { exitCode = code; });
    const request = async (type: string, payload: Record<string, unknown> = {}) => {
      const id = ++requestId; simulationWorker.postMessage({ ...payload, id, type });
      await until(() => { if (failure) throw failure; return packets.some(packet => packet.id === id); });
      const response = packets.find(packet => packet.id === id); expect(response.error).toBeUndefined(); return response.value;
    };
    await until(() => { if (failure) throw failure; return packets.some(packet => packet.type === 'test-ready'); });
    await request('init', { options: { matchId: 'fatal-publication', seed: 'fatal-publication', controllers: false, factions: [
      { id: 'a', name: 'A', teamId: 'a', color: '#3388ff', kind: 'human' },
      { id: 'b', name: 'B', teamId: 'b', color: '#ff8844', kind: 'human' },
    ] } });
    await request('subscribe', { playerIds: ['a'] });
    await until(() => { if (failure) throw failure; return packets.some(packet => packet.type === 'projection-view'); });
    const initial = packets.find(packet => packet.type === 'projection-view');
    expect(initial.transfer.patch).toMatchObject({ baseRevision: 0, revision: 1, header: { playerId: 'a', status: 'LOADING' } });
    simulationWorker.postMessage({ type: 'projection-credit', playerId: 'a', generation: initial.transfer.generation, revision: initial.transfer.patch.revision });
    expect(await request('diagnostics')).toMatchObject({ tick: 0, status: 'LOADING' });
    const failedRequestId = ++requestId; triggered = true;
    simulationWorker.postMessage(failureMode === 'construction'
      ? { id: failedRequestId, type: 'status', status: 'PAUSED' }
      : { id: failedRequestId, type: 'control-mode', playerId: 'a', mode: 'caretaker' });
    await until(() => failure !== undefined && exitCode !== undefined);
    expect(failure!.message).toBe('PROJECTION_PUBLICATION_FAILED'); expect(exitCode).not.toBe(0);
    // If a conservative detached preparation path cloned the poisoned rally,
    // it would throw before this marker, rather than testing native send failure.
    expect(packets.filter(packet => packet.type === 'test-native-export-prepared')).toEqual(failureMode === 'native-send' ? [{ type: 'test-native-export-prepared', count: 1 }] : []);
    expect(packets.filter(packet => packet.type === 'projection-view')).toHaveLength(1);
    // Controls acknowledge their state transition before publish(). Preserve that
    // ordering, but never convert the later publication failure into a normal
    // recoverable RPC error and continue from its undelivered projection base.
    expect(packets.some(packet => packet.id === failedRequestId && packet.error)).toBe(false);
    expect(packets.some(packet => packet.id === retryId)).toBe(false);
  }, 20000);
  it('keeps resync pending through stale transfers, coalescing, and completion of an older requested snapshot', async () => {
    const pool = worker(), source = projectionSource(), transport = new Transport(), publisher = pool.createPublisher(transport);
    const offer = async (sequence: number, requestToken: number) => {
      pool.offerProjection(await source.send(view(sequence), 1, sequence === 1, false, requestToken), [publisher]);
      await until(() => source.credits.length === sequence);
    };
    await offer(1, 0); await transport.drainTo(1);
    const request = (token: number) => expect(publisher.requestSnapshot({ stream: source.channel.projectionStream, token, matchId: view().matchId, matchEpoch: 1 })).toBe(true);
    request(10);
    // This frame was constructed before the source accepted the resync request.
    await offer(2, 9); await until(() => transport.callbacks.length > 0);
    expect(JSON.parse(transport.wire.at(-1)!).type).toBe('delta');
    await offer(3, 10); await offer(4, 10);
    transport.acknowledge(); await until(() => transport.wire.some(text => JSON.parse(text).sequence === 4));
    expect(JSON.parse(transport.wire.at(-1)!)).toMatchObject({ type: 'snapshot_chunk', sequence: 4 });
    request(11); // Completion of snapshot 4 cannot satisfy this newer request.
    await transport.drainTo(4);
    await offer(5, 10); await transport.drainTo(5);
    expect(JSON.parse(transport.wire.at(-1)!).type).toBe('delta');
    await offer(6, 11); await transport.drainTo(6);
    await offer(7, 11); await transport.drainTo(7);
    expect(transport.wire.map(text => JSON.parse(text)).filter(frame => frame.type === 'snapshot_chunk' && frame.index === 0).map(frame => frame.sequence)).toEqual([1, 4, 6]);
    expect(transport.decoded()).toEqual(normalizePlayerView(view(7)));
    expect(transport.wire.join('')).not.toMatch(/publicationRequest|requestToken|snapshot-complete/);
  });
  it('does not discard a new-epoch resync obligation when an older epoch transfer is already in transit', async () => {
    const pool = worker(), source = projectionSource(), transport = new Transport(), publisher = pool.createPublisher(transport);
    pool.offerProjection(await source.send(view(1), 1, true), [publisher]); await transport.drainTo(1);
    publisher.requestSnapshot({ stream: source.channel.projectionStream, token: 20, matchId: view().matchId, matchEpoch: 2 });
    pool.offerProjection(await source.send(view(2), 1, false, false, 19), [publisher]); await transport.drainTo(2);
    const next = view(3); next.matchEpoch = 2;
    pool.offerProjection(await source.send(next, 2, true, false, 19), [publisher]); await transport.drainTo(3, 2);
    const requested = view(4); requested.matchEpoch = 2;
    pool.offerProjection(await source.send(requested, 2, false, false, 20), [publisher]); await transport.drainTo(4, 2);
    expect(transport.wire.map(text => JSON.parse(text)).filter(frame => frame.type === 'snapshot_chunk' && frame.index === 0).map(frame => frame.sequence)).toEqual([1, 3, 4]);
  });
  it('retains source byte ownership until confirmed worker termination and delays replacement', async () => {
    const pool = worker(), source = projectionSource(), transport = new Transport(), publisher = pool.createPublisher(transport);
    await pool.ready;
    const native = (pool as unknown as { worker: import('node:worker_threads').Worker }).worker, terminate = native.terminate.bind(native);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const termination = vi.spyOn(native, 'terminate').mockImplementation(async () => { await held; return terminate(); });
    try {
      pool.offerProjection(await source.send(view(), 1, true), [publisher]);
      native.emit('error', new Error('TEST_ENCODER_FAILURE'));
      expect(pool.diagnostics()).toMatchObject({ failed: true, projectionTransfers: 1, projectionReservedBytes: 32 * 1024 * 1024, recoveries: 0 });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(source.credits).toHaveLength(0); expect(pool.diagnostics().recoveries).toBe(0);
      expect(transport.closed).toHaveLength(1);
      release(); await until(() => source.credits.length === 1);
      expect(source.credits[0]).toMatchObject({ generation: 1, revision: 1, failed: true });
      expect(pool.diagnostics()).toMatchObject({ projectionTransfers: 0, projectionReservedBytes: 0 });
      await until(() => pool.diagnostics().recoveries === 1);
    } finally { release(); termination.mockRestore(); }
  });
  it('keeps disposed-stream transfers reserved until their encoder consumption ACK', async () => {
    const pool = worker(), source = projectionSource(), transport = new Transport(), publisher = pool.createPublisher(transport);
    await pool.ready;
    pool.offerProjection(await source.send(view(), 1, true), [publisher]);
    pool.releaseProjectionStream(source.channel.projectionStream);
    expect(pool.diagnostics()).toMatchObject({ projectionStreams: 0, projectionTransfers: 1, projectionReservedBytes: 32 * 1024 * 1024 });
    expect(source.credits).toHaveLength(0);
    await until(() => source.credits.length === 1);
    expect(pool.diagnostics()).toMatchObject({ projectionStreams: 0, projectionTransfers: 0, projectionReservedBytes: 0 });
    await transport.drainTo(1);
  });
  it('reconstructs one recipient projection per encoder transfer and fans out independently of a stalled socket', async () => {
    const pool = worker(), source = projectionSource(), slow = new Transport(), fast = new Transport();
    const publishers = [pool.createPublisher(slow), pool.createPublisher(fast)], audited: PlayerView[] = [];
    const audit = (text: string) => { audited.push(JSON.parse(text)); };
    for (let sequence = 1; sequence <= 3; sequence++) {
      const next = view(sequence), handle = await source.send(next, 1, sequence === 1, sequence === 1);
      expect(Object.keys(handle)).toEqual([]); pool.offerProjection(handle, publishers, audit);
      await until(() => source.credits.length === sequence);
      expect(source.credits.at(-1)).toMatchObject({ generation: 1, revision: sequence });
      expect(source.credits.at(-1)!.failed).toBeUndefined();
      await fast.drainTo(sequence);
      expect(fast.decoded()).toEqual(normalizePlayerView({ ...next, status: sequence === 1 ? 'COUNTDOWN' : 'RUNNING' }));
    }
    expect(slow.callbacks).toHaveLength(1); // source credit is independent of this unresolved send
    await slow.drainTo(3); expect(slow.decoded()).toEqual(fast.decoded());
    expect(audited.map(value => value.sequence)).toEqual([1, 2, 3]);
    expect(pool.diagnostics()).toMatchObject({ projectionTransfers: 0, projectionStreams: 1, projectionReservedBytes: 0 });
  });
  it('resets projection generations and reconnects to a fresh complete recipient base after encoder failure', async () => {
    const pool = worker(), source = projectionSource(), first = new Transport(), publisher = pool.createPublisher(first);
    pool.offerProjection(await source.send(view(), 1, true), [publisher]); await first.drainTo(1);
    await until(() => source.credits.length === 1);
    await (pool as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await until(() => first.closed.length > 0 && pool.diagnostics().recoveries === 1);
    const next = view(2); next.matchEpoch = 2;
    const second = new Transport(), recovered = pool.createPublisher(second);
    pool.offerProjection(await source.send(next, 2, true), [recovered]); await second.drainTo(2, 2);
    await until(() => source.credits.length === 2);
    expect(second.decoded()).toEqual(normalizePlayerView(next));
    expect(second.wire.map(text => JSON.parse(text).type)).toEqual(['snapshot_chunk']);
    pool.releaseProjectionStream(source.channel.projectionStream);
    expect(pool.diagnostics()).toMatchObject({ projectionStreams: 0, projectionTransfers: 0 });
  });
  it.each(['native', 'portable'] as const)('uses a separate thread and preserves snapshots, exact deltas and socket-completed bases (%s)', async encoding => {
    const pool = worker(encoding), transport = new Transport(), metrics = new PerformanceDiagnostics(), publisher = pool.createPublisher(transport, metrics);
    expect(await pool.ready).toBeGreaterThan(0); expect(pool.diagnostics().threadId).not.toBe(threadId);
    publisher.offer(view()); await transport.drainTo(1);
    publisher.offerJson(JSON.stringify(view(2))); await until(() => transport.callbacks.length > 0);
    publisher.offer(view(3)); await transport.drainTo(3);
    const deltas = transport.wire.map(text => JSON.parse(text)).filter(frame => frame.type === 'delta');
    expect(deltas.map(frame => [frame.delta.baseSequence, frame.delta.sequence])).toEqual([[1, 2], [2, 3]]);
    expect(transport.decoded()).toEqual(normalizePlayerView(view(3)));
    await until(() => metrics.snapshot().counts.completedDistinctViewSequences === 3);
    expect(metrics.snapshot().phases.snapshotChunks!.count).toBe(1);
    expect(transport.wire.join('')).not.toContain('threadId'); expect(transport.closed).toEqual([]);
  });
  it('timestamps the latest long source, completion or socket gap and clears it across reset', () => {
    let now=0,wall=1000000;
    const owner={post:vi.fn(),postOffer:vi.fn(),remove:vi.fn()} as unknown as PublicationWorker,transport=new Transport();
    const publisher=new ThreadedViewPublisher(owner,7,transport,undefined,false,()=>now,()=>wall);
    publisher.offer(view());publisher.receive({type:'view-complete',channel:7,generation:0,boundary:view()});
    now=1100;wall+=1100;publisher.offer(view(2));
    expect(publisher.deliveryDiagnostics().lastLongGap).toEqual({at:1001100,stage:'offer',durationMs:1100});
    publisher.receive({type:'write',channel:7,generation:0,writeId:1,text:'{}'});
    publisher.receive({type:'write',channel:7,generation:0,writeId:2,text:'{}'});
    now=2300;wall+=1200;transport.acknowledge();
    expect(publisher.deliveryDiagnostics().lastLongGap).toEqual({at:1002300,stage:'socket_callback',durationMs:1200});
    publisher.receive({type:'view-complete',channel:7,generation:0,boundary:view(2)});
    expect(publisher.deliveryDiagnostics().lastLongGap).toEqual({at:1002300,stage:'completion',durationMs:2300});
    publisher.deliveryDiagnostics().lastLongGap!.durationMs=0;
    now=3300;wall+=1000;publisher.receive({type:'view-complete',channel:7,generation:0,boundary:view(3)});
    expect(publisher.deliveryDiagnostics().lastLongGap).toEqual({at:1002300,stage:'completion',durationMs:2300});
    publisher.reset();now=5000;wall+=1700;transport.acknowledge(new Error('OLD_GENERATION'));
    expect(publisher.deliveryDiagnostics()).toMatchObject({lastLongGap:null,pendingSocketWrites:0,lastSocketCallbackMs:null,completedViews:0});
  });
  it('reports bounded source, socket and completed-view stages without claiming partial chunks delivered', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view(1, true));
    await until(() => transport.callbacks.length === PUBLICATION_CHUNK_WINDOW);
    expect(publisher.deliveryDiagnostics()).toMatchObject({ playerId: 'blue', offeredViews: 1, completedViews: 0, offeredSequence: 1,
      completedSequence: null, completedAgeMs: null, pendingSocketWrites: PUBLICATION_CHUNK_WINDOW });
    publisher.offer(view(2, true));
    for (let index = 1; index < PUBLICATION_CHUNK_WINDOW; index++) transport.acknowledge();
    await until(() => publisher.deliveryDiagnostics().pendingSocketWrites === 1);
    expect(transport.wire).toHaveLength(PUBLICATION_CHUNK_WINDOW);
    expect(publisher.deliveryDiagnostics()).toMatchObject({ offeredViews: 2, completedViews: 0, offeredSequence: 2, completedSequence: null });
    expect(publisher.deliveryDiagnostics().oldestSocketWriteMs).toBeGreaterThanOrEqual(0);
    expect(publisher.deliveryDiagnostics().lastSocketCallbackMs).toBeGreaterThanOrEqual(0);
    await transport.drainTo(2);
    await until(() => publisher.deliveryDiagnostics().completedSequence === 2);
    const report = pool.diagnostics().delivery;
    expect(report).toMatchObject({ scope: 'gateway_publication_socket_callbacks', channels: [{ offeredViews: 2, completedViews: 2, completedSequence: 2, pendingSocketWrites: 0, oldestSocketWriteMs: null }] });
    expect(report.channels[0]!.maxOfferIntervalMs).toBeGreaterThanOrEqual(0);
    expect(report.channels[0]!.maxCompletedIntervalMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(report)).not.toMatch(/worker|food|entities|credentials/);
    expect(transport.wire.join('')).not.toMatch(/view-complete|offeredViews|completedAgeMs|lastSocketCallbackMs/);
    report.channels[0]!.completedViews = 999;
    expect(publisher.deliveryDiagnostics().completedViews).toBe(2);
    publisher.reset();
    expect(publisher.deliveryDiagnostics()).toMatchObject({ offeredViews: 0, completedViews: 0, completedSequence: null,
      offerAgeMs: null, lastWriteAgeMs: null, completedAgeMs: null, pendingSocketWrites: 0 });
  });
  it('never reports completion or advances a queued view when any pipelined write fails', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view(1, true)); await until(() => transport.callbacks.length === PUBLICATION_CHUNK_WINDOW);
    publisher.offer(view(2, true));
    transport.acknowledge(new Error('TEST_WINDOW_FAILURE'));
    await until(() => transport.closed.length > 0);
    while (transport.callbacks.length) transport.acknowledge();
    expect(publisher.deliveryDiagnostics()).toMatchObject({ completedViews: 0, completedSequence: null, pendingSocketWrites: 0 });
    expect(transport.wire).toHaveLength(PUBLICATION_CHUNK_WINDOW);
    expect(transport.closed).toEqual([{ code: 4008, reason: 'SLOW_CLIENT_RECONNECT' }]);
    expect(pool.diagnostics().delivery.channels).toEqual([]);
  });
  it('bounds the IPC offer queue, preserves a requested snapshot and rejects older pending offers', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view(1, true));
    for (let sequence = 2; sequence <= 100; sequence++) publisher.offer(view(sequence, true), sequence === 2);
    publisher.offer(view(40, true));
    expect(publisher.inventory()).toEqual({ active: true, pending: true });
    expect(pool.diagnostics()).toMatchObject({ channels: 1, inflightOffers: 1, pendingOffers: 1 });
    await until(() => transport.wire.length === PUBLICATION_CHUNK_WINDOW); expect(transport.callbacks).toHaveLength(PUBLICATION_CHUNK_WINDOW);
    await transport.drainTo(100);
    const starts = transport.wire.map(text => JSON.parse(text)).filter(frame => frame.type === 'snapshot_chunk' && frame.index === 0);
    expect(starts.map(frame => frame.sequence)).toEqual([1, 100]); expect(transport.closed).toEqual([]);
  });
  it('resets an in-flight snapshot and never installs its old epoch as a new delta base', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view(1, true)); await until(() => transport.wire.length === PUBLICATION_CHUNK_WINDOW);
    publisher.reset(); const next = view(2, true); next.matchEpoch = 2; publisher.offer(next);
    await transport.drainTo(2, 2);
    const frames = transport.wire.map(text => JSON.parse(text));
    expect(frames.filter(frame => frame.matchEpoch === 1)).toHaveLength(PUBLICATION_CHUNK_WINDOW);
    expect(frames.every(frame => frame.type === 'snapshot_chunk')).toBe(true);
    expect(transport.decoded()).toEqual(normalizePlayerView(next)); expect(transport.closed).toEqual([]);
  });
  it('forwards only an opaque recipient-filtered worker tree and rejects expired capabilities', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport), source = view();
    Object.assign(source, { optionalUndefined: undefined }); source.entities[0]!.xMm = -0;
    const { channel, handle } = await deferred(source);
    expect(Object.keys(handle)).toEqual([]); publisher.offerTransferred(handle); source.self.resources.gold = 999;
    await transport.drainTo(1); expect(transport.decoded()!.self.resources.gold).toBe(0);
    expect(Object.is(transport.decoded()!.entities[0]!.xMm, -0)).toBe(false);
    expect(transport.decoded()).not.toHaveProperty('optionalUndefined');
    channel.invalidateTransfers(); const other = new Transport(); pool.createPublisher(other).offerTransferred(handle);
    expect(other.closed).toEqual([{ code: 4008, reason: 'SLOW_CLIENT_RECONNECT' }]);
    expect(other.wire).toEqual([]);
  });
  it('isolates recipients and rejects malformed or hidden fields before an encoded frame can leave the worker', async () => {
    const pool = worker(), blue = new Transport(), red = new Transport();
    const bluePublisher = pool.createPublisher(blue), redPublisher = pool.createPublisher(red);
    bluePublisher.offerJson(JSON.stringify(view(1, false, 'blue'))); redPublisher.offerJson(JSON.stringify(view(1, false, 'red')));
    await Promise.all([blue.drainTo(1), red.drainTo(1)]);
    const poisoned = view(2, false, 'blue'); Object.assign(poisoned, { credentials: 'private_endpoint_key' });
    bluePublisher.offerJson(JSON.stringify(poisoned)); await until(() => blue.closed.length > 0);
    redPublisher.offerJson(JSON.stringify(view(2, false, 'red'))); await red.drainTo(2);
    expect(blue.wire.join('')).not.toContain('private_endpoint_key'); expect(blue.wire.join('')).not.toContain('red_worker');
    expect(red.wire.join('')).not.toContain('blue_worker'); expect(red.closed).toEqual([]);
  });
  it('fails a cross-recipient offer, rejects oversized JSON, and keeps public object getter safety', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view()); await transport.drainTo(1); publisher.offer(view(2, false, 'red'));
    await until(() => transport.closed.length > 0); expect(transport.wire.join('')).not.toContain('red_worker');
    const large = new Transport(); pool.createPublisher(large).offerJson(' '.repeat(16 * 1024 * 1024 + 1));
    expect(large.closed).toEqual([{ code: 4008, reason: 'SNAPSHOT_TOO_LARGE' }]);
    const getter = new Transport(), malicious = view(); let calls = 0;
    Object.defineProperty(malicious, 'self', { enumerable: true, get() { calls++; return view().self; } });
    pool.createPublisher(getter).offer(malicious); expect(calls).toBe(0); expect(getter.wire).toEqual([]); expect(getter.closed).toHaveLength(1);
  });
  it('enforces gateway socket backpressure and callback failures while another recipient continues', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view()); await transport.drainTo(1); const count = transport.wire.length;
    transport.bufferedAmount = 1024 * 1024 + 1; publisher.offer(view(2)); await until(() => transport.closed.length > 0);
    expect(transport.wire).toHaveLength(count); expect(transport.closed[0]!.reason).toBe('SLOW_CLIENT_RECONNECT');
    const failed = new Transport(), other = pool.createPublisher(failed); other.offer(view()); await until(() => failed.callbacks.length > 0);
    failed.acknowledge(new Error('transport failed')); await until(() => failed.closed.length > 0); expect(failed.closed[0]!.reason).toBe('SLOW_CLIENT_RECONNECT');
    const healthy = new Transport(); pool.createPublisher(healthy).offer(view()); await healthy.drainTo(1); expect(healthy.closed).toEqual([]);
  });
  it('cleans channels on socket disposal and does not send writes from disposed generations', async () => {
    const pool = worker(), transport = new Transport(), publisher = pool.createPublisher(transport);
    publisher.offer(view(1, true)); await until(() => transport.callbacks.length > 0);
    publisher.dispose(); const count = transport.wire.length; transport.acknowledge(); publisher.offer(view(2));
    expect(pool.diagnostics().channels).toBe(0); expect(transport.wire).toHaveLength(count);
    await pool.close(); expect(transport.closed).toEqual([]);
  });
  it('fails active streams closed on worker exit, then reconnects with a fresh thread and complete snapshot', async () => {
    const pool = worker(), first = new Transport(), second = new Transport();
    pool.createPublisher(first).offer(view(1, true)); pool.createPublisher(second).offer(view(1, false, 'red'));
    await until(() => first.callbacks.length > 0 && second.callbacks.length > 0);
    // Terminate only the worker created by this test; no production delay or crash hook.
    await (pool as unknown as { worker: { terminate(): Promise<number> } }).worker.terminate();
    await until(() => first.closed.length > 0 && second.closed.length > 0);
    expect(pool.diagnostics()).toMatchObject({ failed: true, channels: 0 });
    expect(first.closed[0]!.reason).toBe('SLOW_CLIENT_RECONNECT'); expect(second.closed[0]!.reason).toBe('SLOW_CLIENT_RECONNECT');
    const later = new Transport(); pool.createPublisher(later).offer(view());
    expect(later.closed[0]!.reason).toBe('SLOW_CLIENT_RECONNECT'); expect(later.wire).toEqual([]);
    await until(() => pool.diagnostics().recoveries === 1);
    const recovered = new Transport(); pool.createPublisher(recovered).offer(view(2));
    await recovered.drainTo(2);
    expect(recovered.wire.map(text => JSON.parse(text).type)).toEqual(['snapshot_chunk']);
    expect(recovered.decoded()).toEqual(normalizePlayerView(view(2)));
    expect(pool.diagnostics()).toMatchObject({ failed: false, recoveries: 1 });
  });
});
