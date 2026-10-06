import { afterEach, describe, expect, it } from 'vitest';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { applyViewDelta, contentHash, createPreparedViewScope, normalizePlayerView, SNAPSHOT_MAX_BYTES, SnapshotAssembler, DeltaAssembler, type PlayerView, type ServerSocketMessage } from '@frontier/shared';
import { WorkerViewChannel, captureSharedPublication, createProjectionPreparedReceiver, createWorkerPreparedViewScope, inspectWorkerViewJson, workerViewBoundary, type SharedWorkerView, type WorkerViewTransfer } from '../apps/server/src/worker-view-channel.js';
import { PerformanceDiagnostics } from '../apps/server/src/performance-diagnostics.js';
import { PUBLICATION_CHUNK_WINDOW, ViewPublisher } from '../apps/server/src/view-publisher.js';
import { FogProducer, FogReceiver } from '../apps/server/src/worker-fog-transfer.js';
import { RecipientProjection } from '../packages/simulation/src/recipient-projection.js';
import { RecipientProjectionReceiver, type ProjectionTransfer } from '../apps/server/src/recipient-projection-transfer.js';

const channels: WorkerViewChannel[] = [];
afterEach(async () => { await Promise.all(channels.splice(0).map(channel => channel.terminate())); });
function worker(): WorkerViewChannel {
  // A real Worker copies both directions; no raw-tree injection or fake receiver API exists.
  const channel = new WorkerViewChannel("const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>{parentPort.postMessage({type:'view',playerId:m.recipient??m.view.playerId,view:m.view});if(m.mutate&&m.view.self)m.view.self.resources.food=999;});", { eval: true });
  channels.push(channel); return channel;
}
function receive<T>(channel: WorkerViewChannel, view: unknown, use: (token: WorkerViewTransfer, playerId: string) => T, recipient?: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    channel.onError = reject;
    channel.onView = (playerId, token) => { try { resolve(use(token, playerId)); } catch (error) { reject(error); } };
    channel.postMessage({ view, recipient, mutate: true });
  });
}
function view(sequence = 1, playerId = 'me'): PlayerView {
  return { protocolVersion: 2, contentHash, matchId: 'owned_transfer', matchEpoch: 1, playerId, tick: sequence * 2, sequence, status: 'RUNNING',
    map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 },
    self: { lastCommandSequence: sequence, resources: { food: 100, wood: 50, gold: 0, stone: 0 }, age: 1, population: 1, populationCap: 15, populationLimit: 120, reservedPopulation: 0 },
    players: [{ id: playerId, name: '\u754c\ud83c\udff0\ud800\n"\\', teamId: 'blue', kind: 'human', color: '#abcdef' }],
    entities: [{ id: 'own', kind: 'unit', typeId: 'militia', ownerId: playerId, hp: 55, maxHp: 55, xMm: sequence * 1000, zMm: 1000, cargo: { resource: 'gold', amount: sequence }, order: 'gather' }],
    fog: { visible: [2, 1], explored: [2, 0, 1] }, effects: [], projectiles: [] };
}
function owned(channel: WorkerViewChannel, input: PlayerView, metrics?: PerformanceDiagnostics): Promise<SharedWorkerView> {
  return receive(channel, input, (token, playerId) => channel.consume(token, playerId, false, metrics));
}
class Transport {
  readyState = 1; bufferedAmount = 0; wire: string[] = []; callbacks: (() => void)[] = []; closed: string[] = [];
  send(text: string, done: (error?: Error) => void) { this.wire.push(text); this.callbacks.push(done); }
  close(_code: number, reason: string) { this.closed.push(reason); this.readyState = 3; }
  async acknowledge() { expect(this.callbacks.length).toBeGreaterThan(0); this.callbacks.shift()!(); await nextTurn(); }
  async drain() { let count = 0; do { while (this.callbacks.length) { if (++count > 1024) throw new Error('UNBOUNDED_TRANSFER'); this.callbacks.shift()!(); } await nextTurn(); } while (this.callbacks.length); }
}
function decoded(transport: Transport): PlayerView | undefined {
  const assembler = new SnapshotAssembler(), deltaAssembler = new DeltaAssembler(); let current: PlayerView | undefined;
  for (const text of transport.wire) {
    const frame = JSON.parse(text) as ServerSocketMessage;
    if (frame.type === 'snapshot_chunk') { deltaAssembler.reset(); const result = assembler.push(frame, 0); expect(result.status).not.toBe('rejected'); if (result.status === 'complete') current = result.view; }
    else if (frame.type === 'delta_chunk') { expect(current).toBeDefined(); const result = deltaAssembler.push(frame, 0); expect(result.status).not.toBe('rejected'); if (result.status === 'complete') { current = applyViewDelta(current!, result.delta); expect(current).toBeDefined(); } }
    else if (frame.type === 'delta') { deltaAssembler.reset(); expect(current).toBeDefined(); current = applyViewDelta(current!, frame.delta); expect(current).toBeDefined(); }
  }
  return current;
}

function projectionTransfer(cache: RecipientProjection, input: PlayerView, generation = 1): ProjectionTransfer {
  cache.begin();for (const entity of input.entities) cache.entity(entity);
  const { entities: _entities, ...fields } = input;
  return { generation, patch: cache.finish(fields) };
}

describe('strict projection preparation without a second full capture', () => {
  it.each(['native','portable'] as const)('preserves exact %s snapshot/delta bytes, source order, audit and older handles', encoding => {
    const receiver=createProjectionPreparedReceiver(),legacy=new RecipientProjectionReceiver(),producer=new RecipientProjection(),actual=createWorkerPreparedViewScope({snapshotEncoding:encoding}),reference=createWorkerPreparedViewScope({snapshotEncoding:encoding});receiver.reset(1);legacy.reset(1);
    const first=view();first.entities=[{...first.entities[0]!,id:'z_unit'},{...first.entities[0]!,id:'a_unit'}];
    const second=structuredClone(first);second.sequence=2;second.tick=4;second.entities[0]!.hp--;second.fog={visible:[3,2],explored:[3,2,1,0]};delete second.effects;
    const third=structuredClone(second);third.sequence=3;third.tick=6;third.entities.reverse();delete third.entities[0]!.cargo;
    let previousActual:ReturnType<typeof actual.adopt>|undefined,previousReference:ReturnType<typeof reference.adopt>|undefined;
    const retained:{handle:ReturnType<typeof actual.adopt>;chunks:ReturnType<typeof actual.chunks>}[]=[];
    for(const input of [first,second,third]){
      const transfer=projectionTransfer(producer,input),legacyView=legacy.receive(transfer,'me');let audit='';
      const handle=receiver.receive(transfer,'me',false,text=>{audit=text;});expect(audit).toBe(JSON.stringify(legacyView));
      const current=actual.adopt(handle),expected=reference.adopt(captureSharedPublication(legacyView));
      expect(actual.chunks(current,'same')).toEqual(reference.chunks(expected,'same'));
      if(previousActual&&previousReference)expect(actual.encodeDeltaMessage(previousActual,current)).toBe(reference.encodeDeltaMessage(previousReference,expected));
      retained.push({handle:current,chunks:actual.chunks(current,'retained')});previousActual=current;previousReference=expected;
      if(transfer.patch.entities.upserts[0])transfer.patch.entities.upserts[0].hp=0;
      for(const old of retained)expect(actual.chunks(old.handle,'retained')).toEqual(old.chunks);
    }
    receiver.reset(2);legacy.reset(2);const restart=view(1);restart.matchEpoch=2;const restarted=projectionTransfer(new RecipientProjection(),restart,2);
    const current=receiver.receive(restarted,'me',true);
    expect(workerViewBoundary(current)).toMatchObject({matchEpoch:2,status:'COUNTDOWN'});
    const expected=reference.adopt(captureSharedPublication({...legacy.receive(restarted,'me'),status:'COUNTDOWN'}));expect(actual.chunks(actual.adopt(current),'restart')).toEqual(reference.chunks(expected,'restart'));
    for(const old of retained)expect(actual.chunks(old.handle,'retained')).toEqual(old.chunks);
  });

  it('keeps the opaque handoff inaccessible to forged views, recipients and stale revisions',()=>{
    const receiver=createProjectionPreparedReceiver(),producer=new RecipientProjection(),scope=createWorkerPreparedViewScope();receiver.reset(1);
    const transfer=projectionTransfer(producer,view());expect(()=>receiver.receive(transfer,'enemy')).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    const handle=receiver.receive(transfer,'me');expect(()=>receiver.receive(transfer,'me')).toThrow('STALE_PROJECTION_TRANSFER');
    for(const forged of [{},view(),structuredClone(handle),Object.create(handle)])expect(()=>scope.adopt(forged as SharedWorkerView)).toThrow('INVALID_PREPARED_VIEW');
    const bad=projectionTransfer(producer,view(2));bad.patch.entities.upserts[0]!.ownerId='enemy';expect(()=>receiver.receive(bad,'me')).toThrow('INVALID_PROJECTION_TRANSFER');
    const recovery=projectionTransfer(new RecipientProjection(),view(3));recovery.patch.revision=3;
    expect(workerViewBoundary(receiver.receive(recovery,'me')).sequence).toBe(3);
    receiver.clear();expect(()=>receiver.receive(projectionTransfer(producer,view(4)),'me')).toThrow('PROJECTION_BASE_MISMATCH');
  });

  it('applies the complete-view node limit to a small patch with retained fog leaves',()=>{
    const receiver=createProjectionPreparedReceiver(),producer=new RecipientProjection(),initial=view();receiver.reset(1);
    initial.fog={visible:Array.from({length:102400},(_,index)=>index),explored:Array.from({length:102400},(_,index)=>index)};
    receiver.receive(projectionTransfer(producer,initial),'me');
    const next=structuredClone(initial);next.sequence=2;next.tick=4;
    next.entities=Array.from({length:12500},(_,index)=>({id:`e${index}`,kind:'building',typeId:'house',ownerId:'me',xMm:0,zMm:0,hp:1,maxHp:1,
      queue:Array.from({length:6},(_,job)=>({id:`j${job}`,kind:'train',typeId:'militia',progress:0,state:'waiting',started:false,blockedReason:'x'})),garrisoned:Array.from({length:20},(_,unit)=>`u${unit}`)}));
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(SNAPSHOT_MAX_BYTES);
    expect(()=>captureSharedPublication(next)).toThrow('INVALID_SNAPSHOT');
    const transfer=projectionTransfer(producer,next);expect(transfer.patch.fields).not.toHaveProperty('fog');
    expect(()=>receiver.receive(transfer,'me')).toThrow('INVALID_PROJECTION_TRANSFER');
  });

  it('retains the exact full byte limit after countdown presentation increases the status length',()=>{
    const input=view();input.entities=Array.from({length:15000},(_,index)=>({id:`byte_e${index}`,kind:'building',typeId:'house',ownerId:'me',xMm:0,zMm:0,hp:1,maxHp:1,
      queue:Array.from({length:6},(_,job)=>({id:`j${job}`,kind:'train',typeId:'militia',progress:0,state:'waiting',started:false,blockedReason:'x'}))}));
    const jobs=input.entities.flatMap(entity=>entity.queue!);jobs[0]!.blockedReason='\u4e2d"\\\n';
    let remaining=SNAPSHOT_MAX_BYTES-1-Buffer.byteLength(JSON.stringify(input));expect(remaining).toBeGreaterThan(0);
    for(let index=1;index<jobs.length&&remaining;index++){const length=Math.min(95,remaining);jobs[index]!.blockedReason='x'.repeat(length+1);remaining-=length;}
    expect(remaining).toBe(0);expect(Buffer.byteLength(JSON.stringify(input))).toBe(SNAPSHOT_MAX_BYTES-1);
    const transfer=projectionTransfer(new RecipientProjection(),input),ordinary=createProjectionPreparedReceiver();ordinary.reset(1);
    expect(workerViewBoundary(ordinary.receive(transfer,'me')).status).toBe('RUNNING');
    const countdown=createProjectionPreparedReceiver();countdown.reset(1);
    expect(()=>captureSharedPublication({...input,status:'COUNTDOWN'})).toThrow('SNAPSHOT_TOO_LARGE');
    expect(()=>countdown.receive(transfer,'me',true)).toThrow('SNAPSHOT_TOO_LARGE');
  });
});

function fogView(sequence = 1): PlayerView {
  const result = view(sequence); result.fog = { visible: [1, 2], explored: [0, 1, 2] }; return result;
}
function fogWorker(): WorkerViewChannel {
  const source = new URL('../apps/server/src/worker-fog-transfer.ts', import.meta.url).href;
  const channel = new WorkerViewChannel(`const {parentPort}=require('node:worker_threads');
    import('tsx/esm/api').then(async({tsImport})=>{
      const {FogProducer}=await tsImport(${JSON.stringify(source)},${JSON.stringify(import.meta.url)}), producer=new FogProducer();
      const post=(playerId,transfer)=>{if(transfer)parentPort.postMessage({type:'fog-view',playerId,transfer});};
      parentPort.on('message',m=>{
        if(m.type==='view-credit'){post(m.playerId,producer.acknowledge(m.playerId,m.generation,m.token));return;}
        if(m.reset){parentPort.postMessage({type:'view-reset',generation:producer.reset()});}
        for(const view of m.batch??[m.view])post(view.playerId,producer.offer(view));
      });
    });`, { eval: true });
  channels.push(channel); return channel;
}

describe('private incremental fog transport', () => {
  it('keeps exact normalized full/delta bytes and immutable retained views across fog, epoch and map changes', () => {
    const producer = new FogProducer(), receiver = new FogReceiver(), reference = createPreparedViewScope();
    const initial = fogView(), sequence: PlayerView[] = [initial];
    const second = fogView(2); second.fog = { visible: [2, 3], explored: [0, 1, 2, 3] }; sequence.push(second);
    const changed = structuredClone(second); changed.self.resources.food++; sequence.push(changed);
    const epoch = fogView(1); epoch.matchEpoch = 2; sequence.push(epoch);
    const mapped = fogView(2); mapped.matchEpoch = 2; mapped.map.widthMm = 320000; sequence.push(mapped);
    const texts: string[] = [], trees: PlayerView[] = [];
    for (const next of sequence) {
      const transfer = producer.offer(next)!;
      const actual = receiver.receive(structuredClone(transfer), next.playerId);
      const expected = reference.prepareJson(JSON.stringify(next));
      const text = Buffer.concat(reference.chunks(expected, 'exact').map(chunk => Buffer.from(chunk.data, 'base64'))).toString('utf8');
      expect(JSON.stringify(actual)).toBe(text); trees.push(actual); texts.push(text);
      producer.acknowledge(next.playerId, transfer.generation, transfer.token);
      next.fog.visible.push(99); // Remembered sender bases must be detached.
      expect(trees.map(tree => JSON.stringify(tree))).toEqual(texts);
    }
  });
  it('falls back for noncanonical fog and rejects stale, missing, cross-recipient and malformed patches', () => {
    for (const mutate of [
      (transfer: any) => transfer.baseToken++, (transfer: any) => transfer.patch.visibleAdded = [1],
      (transfer: any) => transfer.patch.visibleRemoved = [99], (transfer: any) => transfer.patch.exploredAdded = [0],
      (transfer: any) => transfer.patch.extra = [], (transfer: any) => transfer.body.entities[0].ownerId = 'foreign',
      (transfer: any) => transfer.body.fog.visible = [0], (transfer: any) => transfer.body.map.widthMm /= 2,
    ]) {
      const producer = new FogProducer(), receiver = new FogReceiver(), source = fogView();
      const first = producer.offer(source)!; receiver.receive(structuredClone(first), source.playerId); producer.acknowledge(source.playerId, first.generation, first.token);
      const patch = producer.offer(fogView(2))!; expect(patch.kind).toBe('fog');
      expect(() => new FogReceiver().receive(structuredClone(patch), source.playerId)).toThrow();
      expect(() => receiver.receive(structuredClone(patch), 'foreign')).toThrow('INVALID_SNAPSHOT_RECIPIENT');
      mutate(patch); expect(() => receiver.receive(structuredClone(patch), source.playerId)).toThrow('INVALID_SNAPSHOT');
    }
    const producer = new FogProducer(), receiver = new FogReceiver(), source = view();
    const first = producer.offer(source)!; expect(first.kind).toBe('full');
    expect(receiver.receive(structuredClone(first), source.playerId)).toEqual(normalizePlayerView(source));
    expect(() => receiver.receive(structuredClone(first), source.playerId)).toThrow('STALE_FOG_TRANSFER');
    receiver.reset(producer.reset()); expect(() => receiver.receive(structuredClone(first), source.playerId)).toThrow('STALE_FOG_TRANSFER');
    expect(() => producer.acknowledge(source.playerId, first.generation, first.token)).toThrow('STALE_FOG_CREDIT');
  });
  it('bounds recipients and coalesces one latest pending target without losing its authorized knowledge', () => {
    const producer = new FogProducer(), receiver = new FogReceiver(), first = producer.offer(fogView())!;
    receiver.receive(structuredClone(first), 'me');
    for (let sequence = 2; sequence <= 40; sequence++) {
      const next = fogView(sequence); next.fog.explored.push(3); if (sequence === 2) next.fog.visible.push(3);
      next.entities.push({ id: 'brief_sighting', kind: 'building', typeId: 'house', ownerId: 'enemy', xMm: 4000, zMm: 0, hp: 120, maxHp: 120, ghost: true, lastSeenTick: 4 });
      expect(producer.offer(next)).toBeUndefined();
    }
    expect(producer.inventory()).toEqual({ recipients: 1, active: 1, pending: 1 });
    const latest = producer.acknowledge('me', first.generation, first.token)!;
    const result = receiver.receive(structuredClone(latest), 'me'); expect(result.sequence).toBe(40);
    expect(result.entities.find(entity => entity.id === 'brief_sighting')?.ghost).toBe(true);
    expect(result.fog.explored).toContain(3); expect(result.fog.visible).not.toContain(3);
    producer.acknowledge('me', latest.generation, latest.token);
    expect(producer.inventory()).toEqual({ recipients: 1, active: 0, pending: 0 });
    for (let i = 0; i < 10; i++) { const next = fogView(); next.playerId = 'p' + i; next.entities = []; const transfer = producer.offer(next)!; receiver.receive(structuredClone(transfer), next.playerId); }
    const extra = fogView(); extra.playerId = 'excess'; expect(() => producer.offer(extra)).toThrow('RECIPIENT_LIMIT');
  });
  it('uses actual Worker credits independently of slow tabs, resync, countdown and lifetime resets', async () => {
    const channel = fogWorker(), slow = new Transport(), healthy = new Transport(), reference = createPreparedViewScope();
    const publishers = [slow, healthy].map(transport => new ViewPublisher(transport, undefined, createWorkerPreparedViewScope));
    let oldShared: SharedWorkerView | undefined;
    for (const sequence of [1, 2, 3]) {
      const next = fogView(sequence); next.fog.visible = [2, 3]; next.fog.explored = [0, 1, 2, 3];
      const shared = await receive(channel, next, (token, id) => channel.consume(token, id, sequence === 1));
      oldShared = shared; const scope = createWorkerPreparedViewScope(), expected = reference.prepare({ ...next, status: sequence === 1 ? 'COUNTDOWN' : 'RUNNING' });
      expect(scope.chunks(scope.adopt(shared), 'fog_exact')).toEqual(reference.chunks(expected, 'fog_exact'));
      for (const publisher of publishers) publisher.offerPrepared(shared); await healthy.drain();
    }
    await slow.drain(); expect(decoded(slow)).toEqual(decoded(healthy)); expect(decoded(healthy)?.sequence).toBe(3);
    publishers[0]!.offerPrepared(oldShared!, true); await slow.drain(); expect(JSON.parse(slow.wire.at(-1)!).type).toBe('snapshot_chunk');
    for (const publisher of publishers) publisher.reset();
    const restored = fogView(1); restored.matchEpoch = 2; restored.status = 'PAUSED';
    const next = await new Promise<SharedWorkerView>((resolve, reject) => {
      channel.onError = reject; channel.onView = (id, token) => { try { resolve(channel.consume(token, id)); } catch (error) { reject(error); } };
      channel.postMessage({ reset: true, view: restored });
    });
    expect(() => createWorkerPreparedViewScope().adopt(oldShared!)).toThrow('INVALID_PREPARED_VIEW');
    for (const publisher of publishers) publisher.offerPrepared(next); await slow.drain(); await healthy.drain();
    expect(decoded(slow)).toEqual(normalizePlayerView(restored)); expect(slow.closed).toEqual([]); expect(healthy.closed).toEqual([]);
  });
  it('reserves omitted fog leaves against the original complete-view node limit', () => {
    const initial = fogView(); initial.fog = { visible: Array.from({ length: 102400 }, (_, i) => i), explored: Array.from({ length: 102400 }, (_, i) => i) };
    const next = structuredClone(initial); next.sequence++;
    next.entities = Array.from({ length: 12500 }, (_, i) => ({ id: 'e' + i, kind: 'building', typeId: 'house', ownerId: 'me', xMm: 0, zMm: 0, hp: 1, maxHp: 1,
      queue: Array.from({ length: 6 }, (_, j) => ({ id: 'j' + j, kind: 'train', typeId: 'militia', progress: 0, state: 'waiting', started: false, blockedReason: 'x' })),
      garrisoned: Array.from({ length: 20 }, (_, j) => 'u' + j) }));
    const nodes = (value: unknown): number => 1 + (value && typeof value === 'object' ? Object.values(value).reduce<number>((sum, item) => sum + nodes(item), 0) : 0);
    expect(nodes(next)).toBeGreaterThan(1000000); expect(nodes({ ...next, fog: { visible: [], explored: [] } })).toBeLessThan(1000000);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(SNAPSHOT_MAX_BYTES);
    const producer = new FogProducer(), receiver = new FogReceiver(), first = producer.offer(initial)!;
    receiver.receive(structuredClone(first), 'me'); producer.acknowledge('me', first.generation, first.token);
    const patch = producer.offer(next)!; expect(patch.kind).toBe('fog');
    expect(() => createPreparedViewScope().prepareJson(JSON.stringify(next))).toThrow('INVALID_SNAPSHOT');
    expect(() => receiver.receive(structuredClone(patch), 'me')).toThrow('INVALID_SNAPSHOT');
  });
  it('preserves exact full UTF-8 byte boundaries through patches, including escaped Unicode', () => {
    const initial = fogView(), next = fogView(2);
    next.entities = Array.from({ length: 15000 }, (_, i) => ({ id: 'byte_e' + i, kind: 'building', typeId: 'house', ownerId: 'me', xMm: 0, zMm: 0, hp: 1, maxHp: 1,
      queue: Array.from({ length: 6 }, (_, j) => ({ id: 'j' + j, kind: 'train', typeId: 'militia', progress: 0, state: 'waiting', started: false, blockedReason: 'x' })) }));
    const jobs = next.entities.flatMap(entity => entity.queue!); jobs[0]!.blockedReason = '\u4e2d"\\\n';
    let remaining = SNAPSHOT_MAX_BYTES - 1 - Buffer.byteLength(JSON.stringify(next)); expect(remaining).toBeGreaterThan(0);
    for (let i = 1; i < jobs.length && remaining; i++) { const length = Math.min(95, remaining); jobs[i]!.blockedReason = 'x'.repeat(1 + length); remaining -= length; }
    expect(remaining).toBe(0); expect(jobs.at(-1)!.blockedReason!.length).toBeLessThanOrEqual(94);
    for (const limit of [SNAPSHOT_MAX_BYTES - 1, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_BYTES + 1]) {
      if (limit !== SNAPSHOT_MAX_BYTES - 1) jobs.at(-1)!.blockedReason += 'x';
      const text = JSON.stringify(next); expect(Buffer.byteLength(text)).toBe(limit);
      const producer = new FogProducer(), receiver = new FogReceiver(), first = producer.offer(initial)!;
      receiver.receive(structuredClone(first), 'me'); producer.acknowledge('me', first.generation, first.token);
      const patch = producer.offer(next)!; expect(patch.kind).toBe('fog');
      const projectionProducer=new RecipientProjection(),projectionReceiver=new RecipientProjectionReceiver();projectionReceiver.reset(1);
      projectionReceiver.receive(projectionTransfer(projectionProducer,initial),'me');
      const projected=projectionTransfer(projectionProducer,next);expect(projected.patch.fields).not.toHaveProperty('fog');
      if (limit > SNAPSHOT_MAX_BYTES) {
        expect(() => createPreparedViewScope().prepareJson(text)).toThrow('SNAPSHOT_TOO_LARGE');
        expect(() => receiver.receive(structuredClone(patch), 'me')).toThrow('SNAPSHOT_TOO_LARGE');
        expect(()=>projectionReceiver.receive(projected,'me')).toThrow('SNAPSHOT_TOO_LARGE');
      } else {
        const reference = createPreparedViewScope(), handle = reference.prepareJson(text);
        const expected = Buffer.concat(reference.chunks(handle, 'exact_bytes').map(chunk => Buffer.from(chunk.data, 'base64'))).toString('utf8');
        expect(JSON.stringify(receiver.receive(structuredClone(patch), 'me'))).toBe(expected);
        expect(projectionReceiver.receive(projected,'me')).toEqual(next);
      }
    }
  });
});

describe('actual Worker-owned publication transfer', () => {
  it.each(['native','portable'] as const)('keeps visual traces socket-local without mutating shared %s views', async snapshotEncoding => {
    const channel=worker(),modern=new Transport(),legacy=new Transport();
    const factory=(options?:{visualTraces?:boolean})=>createWorkerPreparedViewScope({...options,snapshotEncoding});
    const opted=new ViewPublisher(modern,undefined,factory,undefined,true),ordinary=new ViewPublisher(legacy,undefined,factory);
    const traced=(sequence:number)=>{const input=view(sequence);input.tick=sequence*6;input.frameRevision=sequence;input.authoritativeIntervalMs=300;input.publicationIntervalMs=300;input.committedTimeMs=input.tick*50;
      const entity=input.entities[0]!;entity.visualAction={kind:'mine',startedTick:input.tick-2};entity.visualTrace={complete:true,fromTick:input.tick-6,points:[{tick:input.tick-6,visualAction:{kind:'idle',startedTick:0}},{tick:input.tick,visualAction:{...entity.visualAction}}]};return input;};
    for(const sequence of [1,2]){const input=traced(sequence),handle=await owned(channel,input);
      // The same privately owned source can feed both sockets in either order.
      for(const publisher of sequence===1?[ordinary,opted]:[opted,ordinary])publisher.offerPrepared(handle);
      await modern.drain();await legacy.drain();
      const expected=normalizePlayerView(input),prior=structuredClone(expected);delete prior.entities[0]!.visualTrace;
      expect(decoded(modern)).toEqual(expected);expect(decoded(legacy)).toEqual(prior);
      expect(input.entities[0]!.visualTrace).toBeDefined();
    }
    ordinary.reset();opted.reset();const next=traced(3);ordinary.offerJson(JSON.stringify(next));opted.offerJson(JSON.stringify(next));await legacy.drain();await modern.drain();
    expect(decoded(legacy)!.entities[0]!.visualTrace).toBeUndefined();expect(decoded(modern)!.entities[0]!.visualTrace).toEqual(next.entities[0]!.visualTrace);
    // The portable direct-capture publisher uses the same capability contract.
    const portableLegacy=new Transport(),portableModern=new Transport();
    new ViewPublisher(portableLegacy).offer(next);new ViewPublisher(portableModern,undefined,undefined,undefined,true).offer(next);
    await portableLegacy.drain();await portableModern.drain();
    expect(decoded(portableLegacy)!.entities[0]!.visualTrace).toBeUndefined();expect(decoded(portableModern)!.entities[0]!.visualTrace).toEqual(next.entities[0]!.visualTrace);
    expect(legacy.closed).toEqual([]);expect(modern.closed).toEqual([]);
    const invalid=traced(4);invalid.entities[0]!.visualTrace!.points.at(-1)!.tick++;
    // Compatibility filtering is after validation, never a way to admit an
    // invalid sender by discarding its malformed field.
    expect(()=>createPreparedViewScope({visualTraces:false}).prepare(invalid)).toThrow('INVALID_SNAPSHOT');
    expect(()=>createWorkerPreparedViewScope({snapshotEncoding,visualTraces:false}).prepareJson(JSON.stringify(invalid))).toThrow('INVALID_SNAPSHOT');
  });
  it('owns its received tree, matches fixed-ID JSON chunks/deltas and never returns mutable aliases', async () => {
    const channel = worker(), metrics = new PerformanceDiagnostics(), source = view(), expected = JSON.parse(JSON.stringify(source)) as PlayerView;
    const preparing = owned(channel, source, metrics); source.self.resources.food = 77; source.entities[0]!.cargo!.amount = 99;
    const shared = await preparing, scope = createWorkerPreparedViewScope(), first = scope.adopt(shared);
    const reference = createPreparedViewScope(), original = reference.prepareJson(JSON.stringify(expected));
    expect(scope.chunks(first, 'fixed_owned')).toEqual(reference.chunks(original, 'fixed_owned'));
    expect(Object.keys(shared)).toEqual([]); expect(Object.isFrozen(workerViewBoundary(shared))).toBe(true);
    const next = view(2), nextShared = await owned(channel, next, metrics), second = scope.adopt(nextShared), referenceNext = reference.prepareJson(JSON.stringify(next));
    expect(scope.encodeDeltaMessage(first, second)).toBe(reference.encodeDeltaMessage(original, referenceNext));
    scope.delta(first, second).updates[0]!.cargo!.amount = 1000;
    scope.chunks(second, 'fixed_next')[0]!.data = 'mutated';
    expect(scope.encodeDeltaMessage(first, second)).toBe(reference.encodeDeltaMessage(original, referenceNext));
    expect(scope.chunks(second, 'fixed_next')).toEqual(reference.chunks(referenceNext, 'fixed_next'));
    inspectWorkerViewJson(shared, (text, recipient) => { expect(recipient).toBe('me'); expect(JSON.parse(text)).toEqual(normalizePlayerView(expected)); });
    expect(metrics.snapshot().counts).toMatchObject({ ownedPreparedViews: 2 });
    for (const phase of ['ownedSafetySize','ownedSchema','ownedConsistency','ownedNormalize'] as const) expect(metrics.snapshot().phases[phase]!.count).toBe(2);
    expect(metrics.snapshot().counts.ownedJsonFallbacks).toBeUndefined();
  });
  it('preserves owned concealment, observed death, ghost memory and exact fog transitions against retained JSON', async () => {
    const channel = worker(), scope = createWorkerPreparedViewScope(), reference = createPreparedViewScope(), base = view();
    base.entities.push({ id: 'enemy', kind: 'unit', typeId: 'militia', ownerId: 'enemy', hp: 55, maxHp: 55, xMm: 2000, zMm: 0 },
      { id: 'memory', kind: 'building', typeId: 'house', ownerId: 'enemy', hp: 120, maxHp: 120, xMm: 4000, zMm: 0, ghost: true, lastSeenTick: 1, visualAction: { kind: 'idle', startedTick: 1 } });
    const first = scope.adopt(await owned(channel, base)), firstReference = reference.prepareJson(JSON.stringify(base));
    for (const observed of [false, true]) {
      const next = structuredClone(base); next.sequence = 2; next.tick = 4; next.entities = next.entities.filter(entity => entity.id !== 'enemy');
      next.fog = { visible: [3, 2], explored: [3, 0, 2, 1] };
      if (observed) next.effects = [{ id: 'death_seen', kind: 'death', tick: 4, entityId: 'enemy', typeId: 'militia', xMm: 2000, zMm: 0 }];
      const after = scope.adopt(await owned(channel, next)), afterReference = reference.prepareJson(JSON.stringify(next));
      const encoded = scope.encodeDeltaMessage(first, after);
      expect(encoded).toBe(reference.encodeDeltaMessage(firstReference, afterReference));
      expect(scope.chunks(after, 'fixed_memory')).toEqual(reference.chunks(afterReference, 'fixed_memory'));
      expect(JSON.parse(encoded).delta).toMatchObject({ conceals: observed ? [] : ['enemy'], removals: observed ? ['enemy'] : [], fog: { visibleAdded: [3], visibleRemoved: [1], exploredAdded: [3] } });
      expect(applyViewDelta(base, JSON.parse(encoded).delta)?.entities.find(entity => entity.id === 'memory')).toEqual(base.entities.find(entity => entity.id === 'memory'));
      const revisited = structuredClone(next); revisited.sequence++; revisited.tick += 2; revisited.effects = []; revisited.entities = revisited.entities.filter(entity => entity.id !== 'memory');
      const final = scope.adopt(await owned(channel, revisited)), finalReference = reference.prepareJson(JSON.stringify(revisited));
      expect(scope.encodeDeltaMessage(after, final)).toBe(reference.encodeDeltaMessage(afterReference, finalReference));
      expect(JSON.parse(scope.encodeDeltaMessage(after, final)).delta.removals).toEqual(['memory']);
    }
  });
  it('keeps public proxy capture, late source mutation and returned output aliases detached in the new Node scope', () => {
    const source = view(), expected = JSON.parse(JSON.stringify(source)) as PlayerView, raw = source.entities[0]!, scope = createWorkerPreparedViewScope(), reference = createPreparedViewScope();
    const expectedBase = reference.prepareJson(JSON.stringify(expected)); let reads = 0;
    source.entities[0] = new Proxy(raw, { get() { reads++; throw new Error('proxy getter'); } });
    source.players = new Proxy(source.players, { ownKeys(target) { Object.defineProperty(source.self.resources, 'food', { get() { reads++; throw new Error('late source getter'); } }); return Reflect.ownKeys(target); } });
    const base = scope.prepare(source);
    raw.hp = 0; raw.cargo!.amount = 999; source.fog.explored.length = 0; Object.setPrototypeOf(source.map, { widthMm: 1 });
    const next = view(2), after = scope.prepare(next), expectedAfter = reference.prepareJson(JSON.stringify(next));
    next.entities[0]!.cargo!.amount = 999; next.self.resources.food = 999;
    const delta = scope.delta(base, after); delta.self.resources.food = 0; delta.updates[0]!.cargo!.amount = 0;
    const chunks = scope.chunks(base, 'public_capture'); chunks[0]!.data = 'changed';
    expect(scope.chunks(base, 'public_capture')).toEqual(reference.chunks(expectedBase, 'public_capture'));
    expect(scope.encodeDeltaMessage(base, after)).toBe(reference.encodeDeltaMessage(expectedBase, expectedAfter)); expect(reads).toBe(0);
  });
  it('rejects forged, proxied, foreign-channel and reused tokens before reading their properties', async () => {
    const channel = worker(), other = worker(); let reads = 0;
    await receive(channel, view(), (token, recipient) => {
      const fake = new Proxy({}, { get() { reads++; throw new Error('hostile token'); } });
      for (const candidate of [{}, structuredClone(token), Object.create(token), fake]) expect(() => channel.consume(candidate as WorkerViewTransfer, recipient)).toThrow('INVALID_VIEW_TRANSFER');
      expect(() => other.consume(token, recipient)).toThrow('INVALID_VIEW_TRANSFER');
      expect(() => channel.consume(token, 'other')).toThrow('INVALID_VIEW_TRANSFER');
      const result = channel.consume(token, recipient);
      expect(() => channel.consume(token, recipient)).toThrow('INVALID_VIEW_TRANSFER');
      expect(() => channel.serialize(token, recipient)).toThrow('INVALID_VIEW_TRANSFER');
      const scope = createWorkerPreparedViewScope();
      for (const candidate of [{}, structuredClone(result), Object.create(result), new Proxy(result, { get() { reads++; throw new Error('hostile prepared'); } })]) expect(() => scope.adopt(candidate as SharedWorkerView)).toThrow('INVALID_PREPARED_VIEW');
      const foreign = createWorkerPreparedViewScope(); foreign.prepare(view(1, 'other'));
      expect(() => foreign.adopt(result)).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    });
    expect(reads).toBe(0);
  });
  it('expires callback-local tokens and invalidates stale worker-generation handles', async () => {
    const channel = worker(), token = await receive(channel, view(), token => token);
    expect(() => channel.consume(token, 'me')).toThrow('INVALID_VIEW_TRANSFER');
    const shared = await owned(channel, view()), scope = createWorkerPreparedViewScope(), base = scope.adopt(shared), completed = scope.chunks(base, 'completed_base');
    channel.invalidateTransfers();
    expect(() => createWorkerPreparedViewScope().adopt(shared)).toThrow('INVALID_PREPARED_VIEW');
    // Revocation prevents new adoption; an already-adopted immutable socket base can finish its transport.
    expect(scope.chunks(base, 'completed_base')).toEqual(completed);
    await receive(channel, view(), (token, recipient) => {
      channel.invalidateTransfers(); expect(() => channel.consume(token, recipient)).toThrow('INVALID_VIEW_TRANSFER');
    });
    const next = await owned(channel, view(2)); expect(workerViewBoundary(next).sequence).toBe(2);
  });
  it('uses bounded JSON fallback for aliases, optional undefined and negative zero without mutating public ingress behavior', async () => {
    const channel = worker(), input = view(), metrics = new PerformanceDiagnostics();
    input.fog.visible = [2, 1, -0]; input.fog.explored = input.fog.visible;
    Object.assign(input.entities[0]!, { rally: undefined });
    const result = await owned(channel, input, metrics), scope = createWorkerPreparedViewScope(), actual = scope.adopt(result);
    const reference = createPreparedViewScope(), expected = reference.prepareJson(JSON.stringify(input));
    expect(scope.chunks(actual, 'fallback_owned')).toEqual(reference.chunks(expected, 'fallback_owned'));
    expect(metrics.snapshot().counts).toMatchObject({ ownedJsonFallbacks: 1, ownedSemanticFallbacks: 1 });
    expect(() => scope.prepare(input)).toThrow('INVALID_SNAPSHOT');
    let reads = 0; const getter = view(); Object.defineProperty(getter.self.resources, 'food', { get() { reads++; throw new Error('private getter'); } });
    expect(() => scope.prepare(getter)).toThrow('INVALID_SNAPSHOT'); expect(reads).toBe(0);
    const hidden = view(); Object.defineProperty(hidden.entities[0]!, 'id', { enumerable: false });
    expect(() => scope.prepare(hidden)).toThrow('INVALID_SNAPSHOT');
  });
  it('validates schemas, per-recipient fields, fog, cycles and unsupported shared-memory containers before retention', async () => {
    const channel = worker();
    const cases: unknown[] = [];
    const enemy = view(); enemy.entities[0]!.ownerId = 'enemy'; cases.push(enemy);
    const fog = view(); fog.fog.visible = [3]; cases.push(fog);
    const cycle = view(); Object.assign(cycle, { loop: cycle }); cases.push(cycle);
    for (const extra of [new SharedArrayBuffer(8), new Map([['secret', 1]]), new Date(0), new Uint8Array(3)]) cases.push({ ...view(), extra });
    for (const input of cases) await expect(receive(channel, input, (token, recipient) => channel.consume(token, recipient))).rejects.toThrow('INVALID_SNAPSHOT');
    await expect(receive(channel, view(1, 'enemy'), (token, recipient) => channel.consume(token, recipient), 'me')).rejects.toThrow('INVALID_SNAPSHOT_RECIPIENT');
    const valid = await owned(channel, view()); expect(workerViewBoundary(valid).playerId).toBe('me');
  });
  it('falls back instead of rejecting a valid view whose conservative byte bound exceeds 16 MiB', async () => {
    const channel = worker(), metrics = new PerformanceDiagnostics(), input = view();
    input.entities = Array.from({ length: 16000 }, (_, index): PlayerView['entities'][number] => ({ ...input.entities[0]!, id: 'unit_' + String(index).padStart(5, '0'),
      cargo: { resource: 'gold', amount: 1 }, stance: 'defensive', taskState: 'gathering', visualAction: { kind: 'mine', startedTick: 2, facingMilliRad: 1571 } }));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(SNAPSHOT_MAX_BYTES);
    const result = await owned(channel, input, metrics);
    expect(workerViewBoundary(result).sequence).toBe(1);
    expect(metrics.snapshot().counts).toMatchObject({ ownedSizeFallbacks: 1, ownedJsonFallbacks: 1, ownedPreparedViews: 1 });
    inspectWorkerViewJson(result, text => expect(text).toBe(JSON.stringify(normalizePlayerView(JSON.parse(JSON.stringify(input))))));
  });
  it.each(['\u754c','\ud800'])('preserves exact 16 MiB UTF-8/escape admission at the fallback boundary (%j)', async character => {
    const channel = worker(), base = { ...view(), padding: '' }, overhead = Buffer.byteLength(JSON.stringify(base)), width = Buffer.byteLength(JSON.stringify(character)) - 2;
    const repetitions = Math.floor((SNAPSHOT_MAX_BYTES - overhead) / width), tail = SNAPSHOT_MAX_BYTES - overhead - repetitions * width;
    const input = { ...base, padding: character.repeat(repetitions) + 'x'.repeat(tail) };
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(SNAPSHOT_MAX_BYTES);
    // The extra field is intentionally schema-invalid; an at-limit object must reach schema rejection.
    await expect(receive(channel, input, (token, recipient) => channel.consume(token, recipient))).rejects.toThrow('INVALID_SNAPSHOT');
    input.padding += 'x';
    await expect(receive(channel, input, (token, recipient) => channel.consume(token, recipient))).rejects.toThrow('SNAPSHOT_TOO_LARGE');
  });
  it('retains the JSON baseline and consumes its token once, including countdown presentation', async () => {
    const channel = worker(), input = view();
    const text = await receive(channel, input, (token, recipient) => {
      expect(channel.header(token, recipient)).toMatchObject({ playerId: 'me', sequence: 1, status: 'RUNNING' });
      const text = channel.serialize(token, recipient, true);
      expect(() => channel.consume(token, recipient)).toThrow('INVALID_VIEW_TRANSFER'); return text;
    });
    expect(text).toBe(JSON.stringify({ ...input, status: 'COUNTDOWN' }));
  });
  it('interrupts an owned multi-chunk snapshot without publishing an old tail or adopting its partial base', async () => {
    const completed: number[] = [], channel = worker(), transport = new Transport(), publisher = new ViewPublisher(transport, undefined, createWorkerPreparedViewScope, boundary => completed.push(boundary.sequence));
    const large = (sequence: number) => { const input = view(sequence); input.fog.explored = Array.from({ length: 102400 }, (_, cell) => cell); return input; };
    publisher.offerPrepared(await owned(channel, large(1)));
    expect(JSON.parse(transport.wire[0]!).count).toBeGreaterThan(2);
    await transport.acknowledge();
    expect(transport.wire).toHaveLength(PUBLICATION_CHUNK_WINDOW); const resetAt = transport.wire.length;
    publisher.reset(); publisher.offerPrepared(await owned(channel, large(2)));
    await transport.drain();
    expect(completed).toEqual([2]);
    expect(transport.wire.slice(resetAt).every(text => { const frame = JSON.parse(text); return frame.type === 'snapshot_chunk' && frame.sequence === 2; })).toBe(true);
    expect(transport.wire.some(text => JSON.parse(text).type === 'delta')).toBe(false);
    expect(decoded(transport)).toEqual(normalizePlayerView(large(2))); expect(transport.closed).toEqual([]);
  });
  it.each(['native','portable'] as const)('chunks a large owned delta with %s snapshot encoding and advances only completed socket bases', async snapshotEncoding => {
    const completed:number[]=[],channel=worker(),transport=new Transport(),publisher=new ViewPublisher(transport,undefined,()=>createWorkerPreparedViewScope({snapshotEncoding}),undefined,true,boundary=>completed.push(boundary.sequence));
    const dense=(sequence:number)=>{const input=view(sequence);input.fog.explored=Array.from({length:102400},(_,cell)=>cell);input.entities=Array.from({length:2000},(_,index)=>({...input.entities[0]!,id:`changed_${index}`}));return input;};
    publisher.offerPrepared(await owned(channel,dense(1)));await transport.drain();const start=transport.wire.length;
    publisher.offerPrepared(await owned(channel,dense(2)));expect(JSON.parse(transport.wire.at(-1)!)).toMatchObject({type:'delta_chunk',baseSequence:1,sequence:2});expect(JSON.parse(transport.wire.at(-1)!).count).toBeGreaterThan(PUBLICATION_CHUNK_WINDOW);
    // One written-but-unacknowledged window cannot become the next delta's
    // base, and a reader must keep the complete sequence-one view meanwhile.
    expect(decoded(transport)).toEqual(normalizePlayerView(dense(1)));expect(completed).toEqual([1]);publisher.offerPrepared(await owned(channel,dense(3)));await transport.drain();
    const updates=transport.wire.slice(start).map(text=>{expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);return JSON.parse(text);});
    expect(updates.every(frame=>frame.type==='delta_chunk')).toBe(true);expect(updates.filter(frame=>frame.index===0).map(frame=>[frame.baseSequence,frame.sequence])).toEqual([[1,2],[2,3]]);
    expect(decoded(transport)).toEqual(normalizePlayerView(dense(3)));expect(completed).toEqual([1,2,3]);expect(transport.closed).toEqual([]);
  });
  it('keeps a forced resync sticky when it arrives during an owned multi-chunk transfer and the pending view is replaced', async () => {
    const channel = worker(), transport = new Transport(), publisher = new ViewPublisher(transport, undefined, createWorkerPreparedViewScope);
    const large = (sequence: number) => { const input = view(sequence); input.fog.explored = Array.from({ length: 102400 }, (_, cell) => cell); return input; };
    publisher.offerPrepared(await owned(channel, large(1)));
    expect(JSON.parse(transport.wire[0]!).count).toBeGreaterThan(2);
    publisher.offerPrepared(await owned(channel, large(2)), true);
    publisher.offerPrepared(await owned(channel, large(3)));
    await transport.drain();
    const frames = transport.wire.map(text => JSON.parse(text));
    expect(frames.every(frame => frame.type === 'snapshot_chunk')).toBe(true);
    expect(frames.filter(frame => frame.index === 0).map(frame => frame.sequence)).toEqual([1, 3]);
    expect(decoded(transport)).toEqual(normalizePlayerView(large(3))); expect(transport.closed).toEqual([]);
  });
  it('shares preparation while preserving per-socket bases, slow-tab coalescing, force resync and reset generations', async () => {
    const channel = worker(), slow = new Transport(), healthy = new Transport();
    const publishers = [new ViewPublisher(slow, undefined, createWorkerPreparedViewScope), new ViewPublisher(healthy, undefined, createWorkerPreparedViewScope)];
    // Direct capture establishes the initial base; the next scheduled owned view must be a delta.
    for (const publisher of publishers) publisher.offer(view(), true);
    await healthy.drain();
    for (const sequence of [2, 3]) {
      const shared = await owned(channel, view(sequence));
      for (const publisher of publishers) publisher.offerPrepared(shared);
      await healthy.drain();
    }
    expect(decoded(healthy)).toEqual(normalizePlayerView(view(3)));
    expect(healthy.wire.some(text => JSON.parse(text).type === 'delta')).toBe(true);
    await slow.drain(); expect(decoded(slow)).toEqual(normalizePlayerView(view(3)));
    publishers[0]!.offerPrepared(await owned(channel, view(3)), true); await slow.drain();
    expect(JSON.parse(slow.wire.at(-1)!).type).toBe('snapshot_chunk');
    publishers[0]!.offerPrepared(await owned(channel, view(4))); publishers[0]!.reset();
    const next = view(1); next.matchEpoch = 2; next.status = 'PAUSED';
    publishers[0]!.offerPrepared(await owned(channel, next)); await slow.drain();
    expect(decoded(slow)).toEqual(normalizePlayerView(next)); expect(slow.closed).toEqual([]); expect(healthy.closed).toEqual([]);
  });
});
