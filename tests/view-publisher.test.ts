import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyViewDelta, chunkView, contentHash, createViewDelta, MAX_WORLD_ENTITIES, normalizePlayerView, SnapshotAssembler, DeltaAssembler, validateServerSocketMessage, type PlayerView, type ServerSocketMessage } from '@frontier/shared';
import { PUBLICATION_CHUNK_WINDOW, ViewPublisher } from '../apps/server/src/view-publisher.js';
import { MeteredTransport } from '../apps/server/src/transport-metrics.js';
import { PerformanceDiagnostics } from '../apps/server/src/performance-diagnostics.js';
import { nativeDeltaChunksFromEncodedMessage } from '../apps/server/src/worker-view-channel.js';
import { chunksFromEncodedDeltaMessage, SNAPSHOT_MAX_BYTES, SNAPSHOT_CHUNK_BYTES } from '../packages/shared/src/view-stream-kernel.js';

class ControlledTransport {
  readyState=1;bufferedAmount=0;frames:ServerSocketMessage[]=[];wire:string[]=[];callbacks:((error?:Error)=>void)[]=[];closed:{code:number;reason:string}[]=[];
  send(data:string,callback:(error?:Error)=>void=()=>{}){const value:unknown=JSON.parse(data);expect(validateServerSocketMessage(value)).toBe(true);this.wire.push(data);this.frames.push(value as ServerSocketMessage);this.callbacks.push(callback);}
  close(code:number,reason:string){this.closed.push({code,reason});this.readyState=3;}
  async acknowledge(error?:Error){const callback=this.callbacks.shift();expect(callback).toBeDefined();callback!(error);for(let turn=0;turn<6;turn++)await Promise.resolve();}
  async drain(){let count=0;while(this.callbacks.length){if(++count>1024)throw new Error('UNBOUNDED_PUBLISHER');await this.acknowledge();}}
}
function view(sequence=1,large=false,playerId='blue'):PlayerView {
  return {protocolVersion:2,contentHash,matchId:'publisher',matchEpoch:1,playerId,tick:sequence*2,sequence,status:'RUNNING',map:{widthMm:640000,heightMm:640000,fogCellMm:2000},self:{lastCommandSequence:sequence,resources:{food:100,wood:100,gold:0,stone:0},age:1,population:1,populationCap:15,populationLimit:120,reservedPopulation:0},players:[],entities:[{id:`${playerId}_private_worker`,kind:'unit',typeId:'villager',ownerId:playerId,xMm:10000+sequence*100,zMm:10000,hp:35,maxHp:35,cargo:{resource:'wood',amount:7},order:'gather'}],fog:{visible:[1],explored:large?Array.from({length:102400},(_,index)=>index):[1]}};
}
function receive(frames:ServerSocketMessage[]):PlayerView|undefined {
  const assembly=new SnapshotAssembler(),deltas=new DeltaAssembler();let current:PlayerView|undefined;
  for(const frame of frames){
    if(frame.type==='snapshot_chunk'){deltas.reset();const result=assembly.push(frame,0);expect(result.status).not.toBe('rejected');if(result.status==='complete')current=result.view;}
    else if(frame.type==='delta_chunk'){const result=deltas.push(frame,0);expect(result.status).not.toBe('rejected');if(result.status==='complete'){expect(current).toBeDefined();current=applyViewDelta(current!,result.delta);expect(current).toBeDefined();}}
    else if(frame.type==='delta'){expect(current).toBeDefined();current=applyViewDelta(current!,frame.delta);expect(current).toBeDefined();}
    else throw new Error('UNEXPECTED_GAME_MESSAGE');
  }
  return current;
}
afterEach(()=>vi.useRealTimers());

it('keeps private diagnostic publication equivalent through coalescing without adding packet fields',async()=>{
  const ordinary=new ControlledTransport(),observed=new ControlledTransport(),metrics=new PerformanceDiagnostics(()=>10);
  const publishers=[new ViewPublisher(ordinary),new ViewPublisher(observed,metrics)];
  for(const publisher of publishers){publisher.offer(view(1));publisher.offerJson(JSON.stringify(view(2)));publisher.offerJson(JSON.stringify(view(3)));}
  await ordinary.drain();await observed.drain();
  expect(receive(observed.frames)).toEqual(receive(ordinary.frames));
  expect(observed.frames.filter(frame=>frame.type==='delta')).toEqual(ordinary.frames.filter(frame=>frame.type==='delta'));
  const stripTransferId=(frame:ServerSocketMessage)=>frame.type==='snapshot_chunk'?{...frame,transferId:'normalized'}:frame;
  expect(observed.frames.map(stripTransferId)).toEqual(ordinary.frames.map(stripTransferId));
  expect(metrics.snapshot().counts).toMatchObject({coalescedViewOffers:1,completedDistinctViewSequences:2,fullSnapshotTransfers:1});
  expect(metrics.snapshot().phases.prepare?.count).toBe(3);
  expect(observed.wire.join('')).not.toContain('performanceDiagnostics');
});

describe('current-connection application payload metrics',()=>{
  it('audits the exact outbound payload without changing send ownership',()=>{
    const order:string[]=[],callback=vi.fn();
    const socket={readyState:1,bufferedAmount:0,send(text:string,done?:typeof callback){expect(this).toBe(socket);expect(text).toBe('界');expect(done).toBe(callback);order.push('send');},close(){}};
    const meter=new MeteredTransport(socket,()=>0,text=>{expect(text).toBe('界');order.push('audit');});
    meter.send('界',callback);expect(order).toEqual(['audit','send']);expect(meter.snapshot().totalBytes).toBe(3);
    const blocked=new MeteredTransport(socket,()=>0,()=>{throw new Error('QUALIFICATION_SECRET_LEAK');});
    expect(()=>blocked.send('界',callback)).toThrow('QUALIFICATION_SECRET_LEAK');
    expect(order).toEqual(['audit','send']);expect(blocked.snapshot().totalBytes).toBe(0);
  });
  it('counts exact UTF-8 bytes for chunks, deltas, receipts and ordinary chat without changing publication',async()=>{
    const socket=new ControlledTransport(),meter=new MeteredTransport(socket,()=>0),publisher=new ViewPublisher(meter);
    publisher.offer(view(1,true));await socket.drain();publisher.offer(view(2,true));await socket.drain();
    const ordinary:ServerSocketMessage[]=[{type:'receipt',receipt:{status:'accepted',clientCommandId:'ordinary_stop',tick:4,sequence:1}},
      {type:'communication',state:{messages:[{id:'message_one',tick:4,senderId:'blue',channel:'all',source:'human',text:'守城🏰'}],pings:[],sendHumanChat:false}}];
    for(const message of ordinary)meter.send(JSON.stringify(message));await socket.drain();
    expect(socket.frames.filter(frame=>frame.type==='snapshot_chunk').length).toBeGreaterThan(1);
    expect(socket.frames.some(frame=>frame.type==='delta')).toBe(true);
    expect(receive(socket.frames.filter(frame=>frame.type==='snapshot_chunk'||frame.type==='delta'))).toEqual(normalizePlayerView(view(2,true)));
    const bytes=socket.wire.reduce((sum,text)=>sum+Buffer.byteLength(text,'utf8'),0);
    expect(bytes).toBeGreaterThan(socket.wire.reduce((sum,text)=>sum+text.length,0));
    expect(meter.snapshot()).toEqual({totalBytes:bytes,bytesPerSecond:bytes/10});expect(socket.closed).toEqual([]);
  });
  it('expires the fixed ten-bucket rate while retaining totals and clamps clock rollback',()=>{
    let now=0;const socket={readyState:1,bufferedAmount:0,send(_data:string){},close(){}},meter=new MeteredTransport(socket,()=>now);
    meter.send('a');now=999;meter.send('界');now=1000;meter.send('🏰');
    now=9999;expect(meter.snapshot()).toEqual({totalBytes:8,bytesPerSecond:.8});
    now=10000;expect(meter.snapshot()).toEqual({totalBytes:8,bytesPerSecond:.4});
    now=11000;expect(meter.snapshot()).toEqual({totalBytes:8,bytesPerSecond:0});
    now=1000;expect(meter.snapshot().bytesPerSecond).toBe(0);
    now=1e12;meter.send('b');expect(meter.snapshot()).toEqual({totalBytes:9,bytesPerSecond:.1});
    // A snapshot is detached and numeric; changing it cannot reset a live meter.
    meter.snapshot().totalBytes=0;expect(meter.snapshot().totalBytes).toBe(9);
  });
  it('preserves the socket receiver, callback identity and failures without counting a throwing send',()=>{
    let savedCallback:((error?:Error)=>void)|undefined,throwSend=false;
    const socket={readyState:1,bufferedAmount:5,send(data:string,callback?:(error?:Error)=>void){expect(this).toBe(socket);expect(data).toBe('界');if(throwSend)throw new Error('send failed');savedCallback=callback;},close(code:number,reason:string){expect(this).toBe(socket);expect([code,reason]).toEqual([4008,'SLOW_CLIENT_RECONNECT']);this.readyState=3;}};
    const meter=new MeteredTransport(socket,()=>0),callback=vi.fn(function(this:unknown,error?:Error){expect(this).toBe(socket);expect(error?.message).toBe('later failure');});
    meter.send('界',callback);expect(savedCallback).toBe(callback);savedCallback!.call(socket,new Error('later failure'));expect(callback).toHaveBeenCalledTimes(1);
    expect(meter.snapshot().totalBytes).toBe(3);throwSend=true;expect(()=>meter.send('界')).toThrow('send failed');expect(meter.snapshot().totalBytes).toBe(3);
    expect(meter.bufferedAmount).toBe(5);socket.bufferedAmount=1024*1024+1;expect(meter.bufferedAmount).toBe(1024*1024+1);
    meter.close(4008,'SLOW_CLIENT_RECONNECT');expect(meter.readyState).toBe(3);
  });
  it('retains publisher backpressure limits without counting skipped or invalid sends',async()=>{
    const socket=new ControlledTransport(),meter=new MeteredTransport(socket),publisher=new ViewPublisher(meter);
    publisher.offer(view());await socket.drain();const bytes=meter.snapshot().totalBytes;
    socket.bufferedAmount=1024*1024+1;publisher.offer(view(2));await Promise.resolve();await Promise.resolve();
    expect(meter.snapshot().totalBytes).toBe(bytes);expect(socket.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);
    publisher.offer(view(3));expect(meter.snapshot().totalBytes).toBe(bytes);
  });
});

describe('bounded per-socket viewpoint publisher',()=>{
  it('encodes identical native and portable delta chunks including escaped Unicode and exact byte boundaries',()=>{
    const first=view();
    for(const length of [1,200,1000]){
      const next=view(2);next.entities=Array.from({length},(_,index)=>({...next.entities[0]!,id:`native_${index}`,order:'\u754c\ud83c\udff0\ud800\n"\\'.repeat(2)}));
      const delta=createViewDelta(first,next),message=JSON.stringify({type:'delta',delta}),native=nativeDeltaChunksFromEncodedMessage(message,delta,'native_delta'),portable=chunksFromEncodedDeltaMessage(message,delta,'native_delta');
      expect(native).toEqual(portable);expect(native.map(chunk=>JSON.stringify(chunk))).toEqual(portable.map(chunk=>JSON.stringify(chunk)));
      const assembly=new DeltaAssembler();let result;for(const chunk of native)result=assembly.push(chunk,1000);expect(result).toEqual({status:'complete',delta});
    }
    const delta=createViewDelta(first,view(2));
    for(const byteLength of [SNAPSHOT_CHUNK_BYTES-1,SNAPSHOT_CHUNK_BYTES,SNAPSHOT_CHUNK_BYTES+1]){
      // The internal codec consumes already encoded JSON; whitespace after the
      // valid document exercises exact chunk cuts without growing game fields.
      const text=JSON.stringify(delta),message='{"type":"delta","delta":'+text+' '.repeat(byteLength-Buffer.byteLength(text))+'}';
      const native=nativeDeltaChunksFromEncodedMessage(message,delta,'byte_boundary');expect(native).toEqual(chunksFromEncodedDeltaMessage(message,delta,'byte_boundary'));expect(native).toHaveLength(Math.ceil(byteLength/SNAPSHOT_CHUNK_BYTES));expect(native[0]!.byteLength).toBe(byteLength);
    }
  });
  it('retains native and portable delta envelope, UTF-8 size and transfer bounds',()=>{
    const delta=createViewDelta(view(),view(2)),prefix='{"type":"delta","delta":';
    for(const encode of [nativeDeltaChunksFromEncodedMessage,chunksFromEncodedDeltaMessage]){
      expect(()=>encode(prefix+'}',delta,'empty')).toThrow('INVALID_DELTA_TRANSFER');
      expect(()=>encode(JSON.stringify(delta),delta,'unenveloped')).toThrow('INVALID_DELTA_TRANSFER');
      expect(()=>encode(prefix+' '.repeat(SNAPSHOT_MAX_BYTES+1)+'}',delta,'large_ascii')).toThrow('DELTA_TOO_LARGE');
      expect(()=>encode(prefix+'\u754c'.repeat(Math.floor(SNAPSHOT_MAX_BYTES/3)+1)+'}',delta,'large_utf8')).toThrow('DELTA_TOO_LARGE');
      expect(()=>encode(JSON.stringify({type:'delta',delta}),{...delta,baseSequence:delta.sequence},'wrong_base')).toThrow('INVALID_DELTA_TRANSFER');
      expect(()=>encode(JSON.stringify({type:'delta',delta}),delta,'x'.repeat(1000))).toThrow('INVALID_DELTA_TRANSFER');
    }
  });
  it('preserves legacy full fallback unless the socket explicitly opts into chunked deltas',async()=>{
    const transport=new ControlledTransport(),metrics=new PerformanceDiagnostics(),publisher=new ViewPublisher(transport,metrics);publisher.offer(view());await transport.drain();
    const expanded=view(2);expanded.entities=Array.from({length:1000},(_,index)=>({...expanded.entities[0]!,id:`legacy_${index}`}));publisher.offer(expanded);await transport.drain();
    expect(transport.frames.every(frame=>frame.type==='snapshot_chunk')).toBe(true);expect(receive(transport.frames)).toEqual(normalizePlayerView(expanded));
    expect(metrics.snapshot().counts).toMatchObject({fullSnapshotLegacyDeltaLimit:1,fullSnapshotTransfers:2});expect(metrics.snapshot().counts).not.toHaveProperty('chunkedDeltaTransfers');
  });
  it('chunks only the large change set and commits its base after the final write before a coalesced delta',async()=>{
    const transport=new ControlledTransport(),metrics=new PerformanceDiagnostics(),publisher=new ViewPublisher(transport,metrics,undefined,undefined,true),first=view(1,true),next=view(2,true);
    next.entities=Array.from({length:1000},(_,index)=>({...next.entities[0]!,id:`unit_${index}`}));publisher.offer(first);await transport.drain();const start=transport.frames.length;
    publisher.offer(next);const firstChunk=transport.frames[start]!;expect(firstChunk).toMatchObject({type:'delta_chunk',baseSequence:1,sequence:2,index:0});expect(receive(transport.frames)).toEqual(normalizePlayerView(first));
    const expected=structuredClone(next),later=structuredClone(next);later.sequence=4;later.tick=8;later.self.resources.food++;publisher.offer({...later,sequence:3,tick:6});publisher.offer(later);
    // Caller mutations cannot change the encoded in-flight document.
    next.entities[0]!.cargo!.amount=999;next.fog.explored=[];
    await transport.drain();expect(transport.closed).toEqual([]);expect(receive(transport.frames)).toEqual(normalizePlayerView(later));
    const chunks=transport.frames.slice(start).filter(frame=>frame.type==='delta_chunk');expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(frame=>frame.baseSequence===1&&frame.sequence===2)).toBe(true);
    const ordinary=transport.frames.at(-1)!;expect(ordinary).toMatchObject({type:'delta',delta:{baseSequence:2,sequence:4}});
    const deltaBytes=transport.wire.slice(start,-1).reduce((sum,text)=>sum+Buffer.byteLength(text),0),fullBytes=chunkView(expected,'full_comparison').reduce((sum,chunk)=>sum+Buffer.byteLength(JSON.stringify(chunk)),0);expect(deltaBytes).toBeLessThan(fullBytes/2);
    expect(metrics.snapshot().counts).toMatchObject({fullSnapshotForced:1,fullSnapshotTransfers:1,chunkedDeltaTransfers:1,coalescedViewOffers:1,completedDistinctViewSequences:3});
  });
  it('cancels remaining large-delta chunks on reset and bootstraps the replacement epoch',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,true);publisher.offer(view());await transport.drain();
    const next=view(2);next.entities=Array.from({length:1000},(_,index)=>({...next.entities[0]!,id:`reset_unit_${index}`}));publisher.offer(next);expect(transport.frames.at(-1)!.type).toBe('delta_chunk');
    publisher.reset();const replacement=view(1);replacement.matchEpoch=2;replacement.self.lastCommandSequence=0;publisher.offer(replacement);await transport.drain();
    expect(transport.frames.filter(frame=>frame.type==='delta_chunk')).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(receive(transport.frames)).toEqual(normalizePlayerView(replacement));
    const later=structuredClone(replacement);later.sequence=2;later.tick=4;publisher.offer(later);await transport.drain();expect(transport.frames.at(-1)).toMatchObject({type:'delta',delta:{matchEpoch:2,baseSequence:1}});
  });
  it('keeps chunked-delta write failures bounded and preserves encoder-failure full snapshots',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,true);publisher.offer(view());await transport.drain();const next=view(2);next.entities=Array.from({length:1000},(_,index)=>({...next.entities[0]!,id:`failed_unit_${index}`}));publisher.offer(next);
    await transport.acknowledge(new Error('delta chunk failed'));expect(transport.frames.filter(frame=>frame.type==='delta_chunk')).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(transport.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);await transport.drain();
    const healthy=new ControlledTransport(),metrics=new PerformanceDiagnostics(),fallback=new ViewPublisher(healthy,metrics);fallback.offer(view());await healthy.drain();const changedMap=view(2);changedMap.map.widthMm=638000;fallback.offer(changedMap);await healthy.drain();
    expect(healthy.frames.every(frame=>frame.type==='snapshot_chunk')).toBe(true);expect(receive(healthy.frames)).toEqual(normalizePlayerView(changedMap));expect(metrics.snapshot().counts).toMatchObject({fullSnapshotForced:1,fullSnapshotDeltaEncodingFallback:1,fullSnapshotTransfers:2});
  });
  it('orders parsed JSON and object offers against one completed base through coalescing, resync and epoch replacement',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport),first=view(1,true),latest=view(4,true);
    first.status='COUNTDOWN';publisher.offerJson(JSON.stringify(first));publisher.offer(view(2,true));
    let text=JSON.stringify(latest);publisher.offerJson(text);text=JSON.stringify(view(3,true));publisher.offerJson(text);
    await transport.drain();expect(receive(transport.frames)).toEqual(normalizePlayerView(latest));
    expect(transport.frames.filter(frame=>frame.type==='delta').map(frame=>frame.delta.sequence)).toEqual([4]);
    expect(transport.frames.filter(frame=>frame.type==='delta')[0]).toMatchObject({delta:{baseSequence:1,status:'RUNNING'}});
    const count=transport.frames.length;publisher.offerJson(JSON.stringify(latest),true);await transport.drain();
    expect(transport.frames.slice(count).every(frame=>frame.type==='snapshot_chunk')).toBe(true);
    const replaced=view(1);replaced.matchEpoch=2;replaced.status='PAUSED';replaced.self.lastCommandSequence=0;
    publisher.reset();publisher.offerJson(JSON.stringify(replaced));await transport.drain();
    expect(receive(transport.frames)).toEqual(normalizePlayerView(replaced));expect(transport.closed).toEqual([]);
  });
  it('keeps parsed recipient secrecy, strict admission and slow-client behavior on the JSON publication path',async()=>{
    for(const mutate of [
      (next:PlayerView)=>{next.playerId='red';},
      (next:PlayerView)=>{next.entities.push({...next.entities[0]!,id:'enemy_private',ownerId:'red'});},
      (next:PlayerView)=>{Object.assign(next,{credentials:'must_never_send'});},
      (next:PlayerView)=>{next.fog.visible.push(2);},
    ]){
      const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offerJson(JSON.stringify(view()));await transport.drain();
      const count=transport.frames.length,next=view(2);mutate(next);publisher.offerJson(JSON.stringify(next));
      expect(transport.frames).toHaveLength(count);expect(transport.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);expect(transport.wire.join('')).not.toContain('must_never_send');
    }
    const buffered=new ControlledTransport(),publisher=new ViewPublisher(buffered);publisher.offerJson(JSON.stringify(view()));await buffered.drain();
    const count=buffered.frames.length;buffered.bufferedAmount=1024*1024+1;publisher.offerJson(JSON.stringify(view(2)));await Promise.resolve();await Promise.resolve();
    expect(buffered.frames).toHaveLength(count);expect(buffered.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);
    let hooks=0;const malicious={toString(){hooks++;return JSON.stringify(view());},toJSON(){hooks++;return view();}};
    const nonstring=new ControlledTransport();new ViewPublisher(nonstring).offerJson(malicious);expect(hooks).toBe(0);expect(nonstring.frames).toEqual([]);expect(nonstring.closed).toHaveLength(1);
  });
  it('uses bounded delta transfers for parsed large deltas and preserves explicit oversize errors',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,true);publisher.offerJson(JSON.stringify(view()));await transport.drain();
    const expanded=view(2);expanded.entities=Array.from({length:1000},(_,index)=>({...expanded.entities[0]!,id:`blue_worker_${index}`}));
    publisher.offerJson(JSON.stringify(expanded));expanded.self.resources.gold=999;
    await transport.drain();expect(transport.frames.slice(1).every(frame=>frame.type==='delta_chunk')).toBe(true);expect(receive(transport.frames)!.self.resources.gold).toBe(0);
    const tooLarge=view(3);tooLarge.entities=Array.from({length:MAX_WORLD_ENTITIES+1},(_,index)=>({...tooLarge.entities[0]!,id:`blue_worker_${index}`}));
    publisher.offerJson(JSON.stringify(tooLarge));expect(transport.closed).toEqual([{code:4008,reason:'SNAPSHOT_TOO_LARGE'}]);
    const bytes=new ControlledTransport();new ViewPublisher(bytes).offerJson(' '.repeat(16*1024*1024+1));expect(bytes.closed).toEqual([{code:4008,reason:'SNAPSHOT_TOO_LARGE'}]);
  });
  it('sends the exact immutable delta envelope and retains its completed base while the write is pending',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport),first=view(1),next=view(2),expected=structuredClone(next);
    publisher.offer(first);await transport.drain();publisher.offer(next);
    expect(transport.wire.at(-1)).toBe(JSON.stringify({type:'delta',delta:createViewDelta(first,expected)}));
    next.self.resources.gold=999;next.entities[0]!.cargo!.amount=999;
    const later=view(3);publisher.offer(later);await transport.drain();
    expect(transport.closed).toEqual([]);expect(receive(transport.frames)).toEqual(normalizePlayerView(later));
    expect(transport.wire.at(-1)).toBe(JSON.stringify({type:'delta',delta:createViewDelta(expected,later)}));
  });
  it('pipelines a bounded chunk window and coalesces pending viewpoints against the completed base',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport),first=view(1,true),latest=view(3,true);
    publisher.offer(first);expect(transport.frames).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(transport.callbacks).toHaveLength(PUBLICATION_CHUNK_WINDOW);publisher.offer(view(2,true));publisher.offer(latest);
    // Releasing only part of the window never advances the delta base or sends
    // the next window. Network ordering remains the order passed to send().
    for(let index=1;index<PUBLICATION_CHUNK_WINDOW;index++)await transport.acknowledge();
    expect(transport.frames).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(transport.callbacks).toHaveLength(1);
    await transport.drain();expect(transport.closed).toEqual([]);expect(transport.frames.filter(frame=>frame.type==='delta').map(frame=>frame.delta.sequence)).toEqual([3]);
    const delta=transport.frames.at(-1)!;expect(delta.type==='delta'&&delta.delta.baseSequence).toBe(1);expect(receive(transport.frames)).toEqual(normalizePlayerView(latest));
  });
  it('forces a new complete snapshot after resync while an earlier full transfer is in flight',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(1,true));publisher.offer(view(2,true),true);await transport.drain();
    const starts=transport.frames.filter(frame=>frame.type==='snapshot_chunk'&&frame.index===0);expect(starts.map(frame=>frame.type==='snapshot_chunk'&&frame.sequence)).toEqual([1,2]);expect(transport.frames.every(frame=>frame.type==='snapshot_chunk')).toBe(true);expect(receive(transport.frames)).toEqual(normalizePlayerView(view(2,true)));
  });
  it('waits for every pipelined callback even when the last chunk acknowledges first',async()=>{
    const transport=new ControlledTransport(),completed=vi.fn(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,false,completed);
    publisher.offer(view(1,true));publisher.offer(view(2,true));
    for(let index=1;index<PUBLICATION_CHUNK_WINDOW;index++){
      transport.callbacks.pop()!();for(let turn=0;turn<6;turn++)await Promise.resolve();
    }
    expect(transport.frames).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(completed).not.toHaveBeenCalled();
    await transport.drain();
    expect(completed.mock.calls.map(call=>call[0].sequence)).toEqual([1,2]);
    expect(transport.frames.at(-1)).toMatchObject({type:'delta',delta:{baseSequence:1,sequence:2}});
    expect(receive(transport.frames)).toEqual(normalizePlayerView(view(2,true)));
  });
  it('keeps a replacement epoch alive when an obsolete write fails after reset',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);
    publisher.offer(view(1));publisher.reset();
    const replacement=view(1);replacement.matchEpoch=2;publisher.offer(replacement);
    await transport.acknowledge(new Error('OBSOLETE_EPOCH_WRITE_FAILED'));await transport.drain();
    expect(transport.closed).toEqual([]);expect(receive(transport.frames)).toEqual(normalizePlayerView(replacement));
    const later={...replacement,sequence:2,tick:4};publisher.offer(later);await transport.drain();
    expect(transport.frames.at(-1)).toMatchObject({type:'delta',delta:{matchEpoch:2,baseSequence:1,sequence:2}});
  });
  it('resets an interrupted generation without recording its partial snapshot as a delta base',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(1,true));publisher.reset();publisher.offer(view(2,true));await transport.drain();
    expect(transport.frames.filter(frame=>frame.type==='snapshot_chunk'&&frame.sequence===1)).toHaveLength(PUBLICATION_CHUNK_WINDOW);expect(transport.frames.every(frame=>frame.type==='snapshot_chunk')).toBe(true);expect(receive(transport.frames)).toEqual(normalizePlayerView(view(2,true)));
  });
  it('switches viewpoint epochs through a full snapshot and never applies their state as an old delta',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view());await transport.drain();const next=view(2);next.matchEpoch=2;next.self.lastCommandSequence=0;publisher.offer(next);await transport.drain();expect(transport.frames.every(frame=>frame.type==='snapshot_chunk')).toBe(true);expect(receive(transport.frames)).toEqual(normalizePlayerView(next));
  });
  it('ignores older ordinary views and still honors an explicit equal-sequence resync',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(5));await transport.drain();const before=transport.frames.length;publisher.offer(view(4));expect(transport.frames).toHaveLength(before);publisher.offer(view(5),true);await transport.drain();expect(transport.frames).toHaveLength(before+1);expect(transport.frames.at(-1)!.type).toBe('snapshot_chunk');
  });
  it('falls back to chunks for large deltas and exposes an explicit oversize failure',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,true);publisher.offer(view());await transport.drain();const expanded=view(2);expanded.entities=Array.from({length:1000},(_,index)=>({...expanded.entities[0]!,id:`blue_worker_${index}`}));publisher.offer(expanded);await transport.drain();expect(transport.frames.slice(1).every(frame=>frame.type==='delta_chunk')).toBe(true);expect(receive(transport.frames)).toEqual(normalizePlayerView(expanded));
    const tooLarge=view(3);tooLarge.entities=Array.from({length:MAX_WORLD_ENTITIES+1},(_,index)=>({...tooLarge.entities[0]!,id:`blue_worker_${index}`}));publisher.offer(tooLarge);await Promise.resolve();await Promise.resolve();expect(transport.closed).toEqual([{code:4008,reason:'SNAPSHOT_TOO_LARGE'}]);
  });
  it('uses UTF-8 bytes for encoded delta fallback rather than JavaScript string length',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport,undefined,undefined,undefined,true),first=view();publisher.offer(first);await transport.drain();
    const expanded=view(2);expanded.entities=Array.from({length:200},(_,index)=>({...expanded.entities[0]!,id:`worker_${index}`,order:'\u754c'.repeat(64)}));
    const encoded=JSON.stringify({type:'delta',delta:createViewDelta(first,expanded)});
    expect(encoded.length).toBeLessThan(65536);expect(Buffer.byteLength(encoded)).toBeGreaterThan(65536);
    publisher.offer(expanded);await transport.drain();expect(transport.frames.slice(1).every(frame=>frame.type==='delta_chunk')).toBe(true);
    expect(receive(transport.frames)).toEqual(normalizePlayerView(expanded));expect(transport.closed).toEqual([]);
  });
  it('enforces backpressure and write failure for encoded deltas after a completed snapshot',async()=>{
    const buffered=new ControlledTransport(),publisher=new ViewPublisher(buffered);publisher.offer(view());await buffered.drain();
    const frameCount=buffered.frames.length;buffered.bufferedAmount=1024*1024+1;publisher.offer(view(2));await Promise.resolve();await Promise.resolve();
    expect(buffered.frames).toHaveLength(frameCount);expect(buffered.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);
    const failed=new ControlledTransport(),other=new ViewPublisher(failed);other.offer(view());await failed.drain();other.offer(view(2));
    expect(failed.frames.at(-1)!.type).toBe('delta');await failed.acknowledge(new Error('write failed'));
    expect(failed.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);
  });
  it('bounds slow or failing transports instead of growing an unbounded send queue',async()=>{
    const buffered=new ControlledTransport();buffered.bufferedAmount=1024*1024+1;new ViewPublisher(buffered).offer(view());await vi.waitFor(()=>expect(buffered.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]));expect(buffered.frames).toHaveLength(0);
    const failed=new ControlledTransport();new ViewPublisher(failed).offer(view());await failed.acknowledge(new Error('write failed'));expect(failed.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);
    vi.useFakeTimers();const stalled=new ControlledTransport(),publisher=new ViewPublisher(stalled);publisher.offer(view());for(let sequence=2;sequence<100;sequence++)publisher.offer(view(sequence));expect(stalled.frames).toHaveLength(1);await vi.advanceTimersByTimeAsync(5001);expect(stalled.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);expect(stalled.frames).toHaveLength(1);
  });
  it('keeps two recipients private through independent full snapshots and subsequent deltas',async()=>{
    const blueTransport=new ControlledTransport(),redTransport=new ControlledTransport(),blue=new ViewPublisher(blueTransport),red=new ViewPublisher(redTransport);
    blue.offer(view(1,false,'blue'));red.offer(view(1,false,'red'));await blueTransport.drain();await redTransport.drain();blue.offer(view(2,false,'blue'));red.offer(view(2,false,'red'));await blueTransport.drain();await redTransport.drain();
    const blueView=receive(blueTransport.frames)!,redView=receive(redTransport.frames)!;expect(blueView.playerId).toBe('blue');expect(redView.playerId).toBe('red');expect(JSON.stringify(blueView)).not.toContain('red_private_worker');expect(JSON.stringify(redView)).not.toContain('blue_private_worker');
    for(const frame of blueTransport.frames.filter(frame=>frame.type==='delta'))expect(JSON.stringify(frame)).not.toContain('red_private_worker');
  });
  it('captures an offered pending view before its caller can mutate it during backpressure',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(1,true));
    const pending=view(2,true),expected=structuredClone(pending);publisher.offer(pending);
    pending.entities[0]!.cargo!.amount=999;pending.self.resources.gold=999;pending.fog.explored.length=0;
    let reads=0;Object.defineProperty(pending.map,'widthMm',{get(){reads++;throw new Error('caller getter');}});Object.setPrototypeOf(pending.entities[0]!,{secret:123});
    await transport.drain();expect(transport.closed).toEqual([]);expect(receive(transport.frames)).toEqual(normalizePlayerView(expected));expect(reads).toBe(0);
  });
  it('does not commit an in-flight delta as the base after a reset and epoch replacement',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(1));await transport.drain();
    publisher.offer(view(2));expect(transport.frames.at(-1)!.type).toBe('delta');publisher.reset();
    const replacement=view(1);replacement.matchEpoch=2;replacement.self.lastCommandSequence=0;publisher.offer(replacement);
    await transport.drain();expect(transport.closed).toEqual([]);expect(transport.frames.at(-1)!.type).toBe('snapshot_chunk');expect(receive(transport.frames)).toEqual(normalizePlayerView(replacement));
    const next=structuredClone(replacement);next.sequence=2;next.tick+=2;publisher.offer(next);await transport.drain();
    const frame=transport.frames.at(-1)!;expect(frame.type==='delta'&&frame.delta.baseSequence).toBe(1);expect(receive(transport.frames)).toEqual(normalizePlayerView(next));
  });
  it('rejects an unexpected recipient before it can replace the socket snapshot',async()=>{
    const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view(1));await transport.drain();
    publisher.offer(view(2,false,'red'));expect(transport.closed).toEqual([{code:4008,reason:'SLOW_CLIENT_RECONNECT'}]);expect(JSON.stringify(transport.frames)).not.toContain('red_private_worker');
  });
  it('keeps strict validation on large snapshot fallback and never invokes submitted accessors',async()=>{
    for(const corrupt of [
      (next:PlayerView)=>{next.entities.push({id:'enemy',ownerId:'enemy',kind:'unit',typeId:'militia',xMm:10000,zMm:10000,hp:55,maxHp:55,queue:[]});},
      (next:PlayerView)=>{Object.assign(next,{rawWorld:{enemySecret:123456}});},
      (next:PlayerView)=>{Object.assign(next.self,{cycle:next});},
      (next:PlayerView)=>{Object.assign(next.self.resources,{gold:1n});},
    ]){
      const transport=new ControlledTransport(),publisher=new ViewPublisher(transport);publisher.offer(view());await transport.drain();const count=transport.frames.length,next=view(2);
      next.entities=Array.from({length:1000},(_,index)=>({...next.entities[0]!,id:`worker_${index}`}));corrupt(next);publisher.offer(next);
      expect(transport.frames).toHaveLength(count);expect(transport.closed).toHaveLength(1);expect(JSON.stringify(transport.frames)).not.toContain('enemySecret');
    }
    let getterCalls=0;const accessor=view();Object.defineProperty(accessor,'map',{get(){getterCalls++;throw new Error('must not run');}});
    const transport=new ControlledTransport();new ViewPublisher(transport).offer(accessor);expect(getterCalls).toBe(0);expect(transport.frames).toEqual([]);expect(transport.closed).toHaveLength(1);
  });
});
