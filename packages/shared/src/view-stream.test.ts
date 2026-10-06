import { describe, expect, it } from 'vitest';
import { balance,MAX_WORLD_ENTITIES } from './index.js';
import { applyViewDelta, chunkView, chunkViewDelta, DeltaAssembler, contentHash, createPreparedViewScope, createViewDelta, normalizePlayerView, sha256, SnapshotAssembler, SNAPSHOT_ASSEMBLY_TIMEOUT_MS, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_BYTES, validateDeltaChunk, validatePlayerView, validatePlayerViewDelta, validateReplayListResponse, validateReplayOpenResponse, validateReplayStepResponse, validateServerSocketMessage, type DeltaChunk, type PlayerView, type PlayerViewDelta, type PreparedViewHandle, type SnapshotChunk, type ViewEntity } from './index.js';

function unit(id:string,ownerId='enemy'):ViewEntity{return {id,ownerId,kind:'unit',typeId:'militia',hp:55,maxHp:55,xMm:4000,zMm:4000};}
function view():PlayerView{return {protocolVersion:2,contentHash,matchId:'stream',matchEpoch:1,playerId:'me',tick:2,sequence:5,status:'RUNNING',map:{widthMm:640000,heightMm:640000,fogCellMm:2000},self:{lastCommandSequence:7,resources:{food:50,wood:50,gold:0,stone:0},age:1,population:1,populationCap:15,populationLimit:120,reservedPopulation:0},players:[],entities:[unit('own','me'),unit('hidden_next'),{...unit('memory'),kind:'building',typeId:'house',ghost:true,lastSeenTick:1}],fog:{visible:[1,2],explored:[0,1,2]},effects:[],projectiles:[]};}
function advance(base:PlayerView):PlayerView{const next=structuredClone(base);next.sequence++;next.tick+=2;return next;}

function coarseView():PlayerView {
  const input=view();input.tick=6;input.committedTimeMs=300;input.frameRevision=1;input.authoritativeIntervalMs=300;input.publicationIntervalMs=300;
  input.entities[0]!.motionTrace={complete:true,points:[{tick:0,xMm:3000,zMm:4000},{tick:6,xMm:4000,zMm:4000}]};
  input.projectiles=[{id:'arrow',kind:'arrow',xMm:5000,yMm:2000,zMm:4000,motionTrace:{complete:true,points:[{tick:0,xMm:4500,yMm:3000,zMm:4000},{tick:6,xMm:5000,yMm:2000,zMm:4000}]}}];
  return input;
}

it.each([450,600] as const)('retains complete %sms history through compiled snapshot, delta and replay admission',async interval=>{
  const compiler=await import('./validation-compiler.js'),base=coarseView(),next=structuredClone(base),steps=interval/50;
  next.tick+=steps;next.committedTimeMs=next.tick*50;next.frameRevision=(next.frameRevision??0)+1;next.sequence++;
  next.authoritativeIntervalMs=interval;next.publicationIntervalMs=interval;next.projectiles=[];
  const entity=next.entities[0]!;entity.xMm+=steps*100;entity.visualAction={kind:'move',startedTick:6};
  entity.motionTrace={complete:true,points:Array.from({length:steps+1},(_,i)=>({tick:6+i,xMm:4000+i*100,zMm:4000}))};
  entity.visualTrace={complete:true,fromTick:6,points:Array.from({length:steps+1},(_,i)=>({tick:6+i,visualAction:entity.visualAction}))};
  const delta=createViewDelta(base,next),replay={replayId:'replay_1790000000000_abcdef0123456789',startTick:0,endTick:next.tick,tick:next.tick,done:true,view:next};
  for(const checks of [{validatePlayerView,validatePlayerViewDelta,validateServerSocketMessage,validateReplayStepResponse},compiler]){
    expect(checks.validatePlayerView(next)).toBe(true);expect(checks.validatePlayerViewDelta(delta)).toBe(true);
    expect(checks.validateServerSocketMessage({type:'delta',delta})).toBe(true);expect(checks.validateReplayStepResponse(replay)).toBe(true);
    for(const change of [
      (v:PlayerView)=>{v.publicationIntervalMs=300;},
      (v:PlayerView)=>{delete v.committedTimeMs;},
      (v:PlayerView)=>{v.entities[0]!.motionTrace!.points[0]!.tick=5;},
      (v:PlayerView)=>{v.entities[0]!.visualTrace!.fromTick=5;},
      (v:PlayerView)=>{v.entities[0]!.ghost=true;},
      (v:PlayerView)=>{v.entities[0]!.visualTrace!.points[1]!.tick=next.tick+1;},
    ]){const invalid=structuredClone(next);change(invalid);expect(checks.validatePlayerView(invalid)).toBe(false);}
  }
  expect(applyViewDelta(base,delta)).toEqual(normalizePlayerView(next));
  const assembler=new SnapshotAssembler();let result;for(const chunk of chunkView(next,`cadence_${interval}`))result=assembler.push(chunk,1000);
  expect(result).toEqual({status:'complete',view:normalizePlayerView(next)});
});

it('applies same-tick cadence changes without resetting command sequence or admitting obsolete long traces',()=>{
  let base=coarseView();base.projectiles=[];delete base.entities[0]!.motionTrace;
  for(const interval of [450,600,450,300] as const){
    const next=structuredClone(base);next.sequence++;next.authoritativeIntervalMs=interval;next.publicationIntervalMs=interval;
    const restored=applyViewDelta(base,createViewDelta(base,next));expect(restored).toEqual(normalizePlayerView(next));
    expect(restored!.self.lastCommandSequence).toBe(7);expect(restored!.tick).toBe(6);base=next;
  }
  const expired=structuredClone(base);expired.tick=24;expired.committedTimeMs=1200;
  expired.entities[0]!.motionTrace={complete:true,points:[{tick:12,xMm:3000,zMm:4000},{tick:24,xMm:4000,zMm:4000}]};
  expect(validatePlayerView(expired)).toBe(false);expired.authoritativeIntervalMs=600;expired.publicationIntervalMs=600;expect(validatePlayerView(expired)).toBe(true);
});

it('keeps planned construction private to its owner in snapshots and deltas',()=>{
  const initial=view();initial.entities=[{...unit('site','me'),kind:'building',typeId:'house',progress:0,pendingConstruction:true}];
  expect(validatePlayerView(initial)).toBe(true);expect(normalizePlayerView(initial).entities[0]!.pendingConstruction).toBe(true);
  const next=advance(initial);delete next.entities[0]!.pendingConstruction;next.entities[0]!.progress=.1;
  expect(applyViewDelta(initial,createViewDelta(initial,next))).toEqual(normalizePlayerView(next));
  const concealed=structuredClone(initial);concealed.entities[0]!.ownerId='enemy';expect(()=>chunkView(concealed,'private_site')).toThrow('INVALID_SNAPSHOT');
  const wrongKind=structuredClone(initial);wrongKind.entities[0]!.kind='unit';expect(validatePlayerView(wrongKind)).toBe(false);
});

it.each([['grand_citadel','runic_citadel'],['grand_citadel','eternal_citadel'],['stone_wall','eternal_wall'],['bastion_gate','eternal_gate']])('applies same-footprint declared upgrades from %s to %s without requesting a snapshot', (source,target)=>{
  const base=view();base.maxAge=8;base.entities=[{...unit('structure','me'),kind:'building',typeId:source,progress:1}];
  const next=advance(base);next.entities[0]!.typeId=target;
  const original=structuredClone(base),delta=createViewDelta(base,next);expect(delta.updates).toHaveLength(1);expect(applyViewDelta(base,delta)).toEqual(normalizePlayerView(next));expect(base).toEqual(original);
});
it.each([
  ['undeclared predecessor','fortress','grand_citadel',{}],['downgrade','eternal_citadel','grand_citadel',{}],['unrelated structure','house','eternal_citadel',{}],['sideways family','grand_citadel','eternal_gate',{}],
  ['relocated','grand_citadel','runic_citadel',{xMm:6000}],['rotated','grand_citadel','runic_citadel',{rotation:90}],['changed owner','grand_citadel','runic_citadel',{ownerId:'other'}],
] as const)('rejects %s as an in-place structural upgrade',(_label,source,target,patch)=>{
  const base=view();base.maxAge=8;base.entities=[{...unit('structure','me'),kind:'building',typeId:source,progress:1}];const next=advance(base);Object.assign(next.entities[0]!,{typeId:target},patch);
  expect(applyViewDelta(base,createViewDelta(base,next))).toBeUndefined();
});

it.each(['wooden_gate','stone_gate','bastion_gate','runestone_gate','titan_gate','eternal_gate'])('retains authorized gate transitions for %s through snapshot and delta validation',typeId=>{
  const snapshot=coarseView();snapshot.maxAge=8;snapshot.entities=[{...unit('gate','me'),kind:'building',typeId,gateOpen:true,visualTrace:{complete:true,fromTick:0,points:[{tick:0,gateOpen:false},{tick:2,gateOpen:true},{tick:6,gateOpen:true}]}}];
  expect(validatePlayerView(snapshot)).toBe(true);expect(normalizePlayerView(snapshot).entities[0]!.visualTrace).toEqual(snapshot.entities[0]!.visualTrace);
  const next=advance(snapshot);next.tick=12;next.committedTimeMs=600;next.frameRevision=2;next.projectiles=[];next.entities[0]!.gateOpen=false;
  next.entities[0]!.visualTrace={complete:true,fromTick:6,points:[{tick:6,gateOpen:true},{tick:9,gateOpen:false},{tick:12,gateOpen:false}]};
  const delta=createViewDelta(snapshot,next);expect(validatePlayerViewDelta(delta)).toBe(true);expect(applyViewDelta(snapshot,delta)).toEqual(normalizePlayerView(next));
});

it('validates bounded visual events identically at snapshot, delta, replay and compiler boundaries',async()=>{
  const make=()=>{const input=coarseView(),entity=input.entities[0]!;delete entity.motionTrace;entity.visualAction={kind:'build',startedTick:2,facingMilliRad:1000};entity.visualTrace={complete:true,fromTick:0,points:[{tick:0,visualAction:{kind:'idle',startedTick:0}},{tick:2,visualAction:{...entity.visualAction}},{tick:6,visualAction:{...entity.visualAction}}]};return input;};
  const compiler=await import('./validation-compiler.js'),valid=make();expect(validatePlayerView(valid)).toBe(true);expect(compiler.validatePlayerView(valid)).toBe(true);
  const gate=make();gate.entities[0]={...gate.entities[0]!,kind:'building',typeId:'wooden_gate',gateOpen:true};for(const point of gate.entities[0].visualTrace!.points)point.gateOpen=point.tick>0;expect(validatePlayerView(gate)).toBe(true);
  const incomplete=make();incomplete.entities[0]!.visualTrace!.complete=false;incomplete.entities[0]!.visualTrace!.points.shift();expect(validatePlayerView(incomplete)).toBe(true);
  const cases:[string,(input:PlayerView)=>void][]=[
    ['future',input=>{input.entities[0]!.visualTrace!.points[1]!.tick=7;}],
    ['duplicate',input=>{input.entities[0]!.visualTrace!.points[1]!.tick=0;}],
    ['wrong endpoint',input=>{input.entities[0]!.visualTrace!.points.at(-1)!.visualAction!.facingMilliRad=0;}],
    ['missing endpoint',input=>{input.entities[0]!.visualTrace!.points.pop();}],
    ['false baseline',input=>{input.entities[0]!.visualTrace!.points.shift();}],
    ['old frame',input=>{input.tick=12;input.committedTimeMs=600;input.projectiles=[];}],
    ['future action',input=>{input.entities[0]!.visualTrace!.points[0]!.visualAction!.startedTick=1;}],
    ['too many',input=>{input.entities[0]!.visualTrace!.points=Array.from({length:8},(_,tick)=>({tick}));}],
    ['resource',input=>{input.entities[0]!.kind='resource';}],
    ['ghost',input=>{input.entities[0]!.ghost=true;}],
    ['garrison',input=>{input.entities[0]!.garrisonedIn='home';}],
    ['unit gate',input=>{input.entities[0]!.gateOpen=true;for(const point of input.entities[0]!.visualTrace!.points)point.gateOpen=true;}],
    ['private data',input=>{Object.assign(input.entities[0]!.visualTrace!.points[1]!,{targetId:'hidden_target'});}]
  ];
  for(const [label,change]of cases){const input=make();change(input);const {entities,fog:_fog,...header}=input,delta={...header,baseSequence:4,creates:[],updates:entities,conceals:[],removals:[],fog:{visibleAdded:[],visibleRemoved:[],exploredAdded:[]}};
    for(const checks of [{validatePlayerView,validatePlayerViewDelta,validateServerSocketMessage,validateReplayStepResponse},compiler]){
      expect(checks.validatePlayerView(input),label).toBe(false);expect(checks.validatePlayerViewDelta(delta),label).toBe(false);expect(checks.validateServerSocketMessage({type:'snapshot',view:input}),label).toBe(false);
      expect(checks.validateReplayStepResponse({replayId:'replay_1790000000000_abcdef0123456789',startTick:0,endTick:20,tick:input.tick,done:false,view:input}),label).toBe(false);
    }
  }
});

it('round-trips committed frame timing and certified traces through prepared, delta and chunk lanes',()=>{
  const base=coarseView(),next=structuredClone(base);next.tick=12;next.committedTimeMs=600;next.frameRevision=2;next.sequence++;
  next.entities[0]!.motionTrace={complete:true,points:[{tick:6,xMm:4000,zMm:4000},{tick:12,xMm:4600,zMm:4000}]};next.entities[0]!.xMm=4600;
  next.projectiles=[];
  const scope=createPreparedViewScope(),a=scope.prepare(base),b=scope.prepare(next),delta=createViewDelta(base,next);
  expect(scope.delta(a,b)).toEqual(delta);expect(applyViewDelta(base,delta)).toEqual(normalizePlayerView(next));
  expect(validateServerSocketMessage({type:'delta',delta})).toBe(true);
  const assembler=new SnapshotAssembler();let result;for(const chunk of scope.chunks(b,'coarse_trace'))result=assembler.push(chunk,1000);
  expect(result).toEqual({status:'complete',view:normalizePlayerView(next)});
  const deltaAssembler=new DeltaAssembler();let deltaResult;for(const chunk of chunkViewDelta(delta,'coarse_delta'))deltaResult=deltaAssembler.push(chunk,1000);
  expect(deltaResult).toEqual({status:'complete',delta});
  const incomplete=structuredClone(next);incomplete.entities[0]!.motionTrace={complete:false,points:[{tick:12,xMm:4600,zMm:4000}]};expect(validatePlayerView(incomplete)).toBe(true);
});

it('rejects inconsistent timing and unsafe traces identically at every shipped and compiler boundary',async()=>{
  const compiler=await import('./validation-compiler.js');
  const boundaries=[{validatePlayerView,validatePlayerViewDelta,validateServerSocketMessage,validateReplayStepResponse},compiler];
  const invalid:[string,(input:PlayerView)=>void][]=[
    ['partial clock',input=>{delete input.committedTimeMs;}],
    ['partial revision',input=>{delete input.frameRevision;}],
    ['partial interval',input=>{delete input.authoritativeIntervalMs;}],
    ['clock mismatch',input=>{input.committedTimeMs=350;}],
    ['incorrect publication',input=>{input.publicationIntervalMs=100;}],
    ['unversioned trace',input=>{delete input.committedTimeMs;delete input.frameRevision;delete input.authoritativeIntervalMs;delete input.publicationIntervalMs;}],
    ['future sample',input=>{input.entities[0]!.motionTrace!.points[0]!.tick=7;}],
    ['duplicate sample',input=>{input.entities[0]!.motionTrace!.points[0]!.tick=6;}],
    ['uncommitted endpoint',input=>{input.entities[0]!.motionTrace!.points[1]!.tick=5;}],
    ['wrong endpoint position',input=>{input.entities[0]!.motionTrace!.points[1]!.xMm=5000;}],
    ['old interval',input=>{input.tick=12;input.committedTimeMs=600;input.entities[0]!.motionTrace!.points[1]!.tick=12;input.projectiles=[];}],
    ['outside map',input=>{input.map.widthMm=20000;input.entities[0]!.motionTrace!.points[0]!.xMm=21000;}],
    ['unit altitude',input=>{input.entities[0]!.motionTrace!.points[0]!.yMm=2000;}],
    ['remembered unit',input=>{input.entities[0]!.ghost=true;input.entities[0]!.lastSeenTick=2;}],
    ['garrisoned unit',input=>{input.entities[0]!.garrisonedIn='town_center';}],
    ['static object',input=>{input.entities[0]!.kind='building';input.entities[0]!.typeId='house';}],
    ['projectile without altitude',input=>{delete input.projectiles![0]!.motionTrace!.points[0]!.yMm;}],
    ['projectile wrong altitude',input=>{input.projectiles![0]!.motionTrace!.points[1]!.yMm=3000;}],
  ];
  for(const [label,mutate] of invalid){
    const input=coarseView();mutate(input);
    const {entities,fog:_fog,...header}=input,delta={...header,baseSequence:4,creates:[],updates:entities,conceals:[],removals:[],fog:{visibleAdded:[],visibleRemoved:[],exploredAdded:[]}};
    const replay={replayId:'replay_1790000000000_abcdef0123456789',startTick:0,endTick:20,tick:input.tick,done:false,view:input};
    for(const checks of boundaries){
      expect(checks.validatePlayerView(input),label).toBe(false);expect(checks.validatePlayerViewDelta(delta),label).toBe(false);
      expect(checks.validateServerSocketMessage({type:'snapshot',view:input}),label).toBe(false);expect(checks.validateServerSocketMessage({type:'delta',delta}),label).toBe(false);
      expect(checks.validateReplayStepResponse(replay),label).toBe(false);
    }
    expect(validatePlayerView.capture(input),label).toBeUndefined();expect(validatePlayerView.parseJson(JSON.stringify(input),SNAPSHOT_MAX_BYTES),label).toBeUndefined();
    expect(()=>chunkView(input,'invalid_trace'),label).toThrow('INVALID_SNAPSHOT');
  }
});

describe('bounded chunked delta transfers',()=>{
  function transfer(sequence=6){const base=view(),next=advance(base);next.sequence=sequence;next.entities.push(...Array.from({length:1000},(_,index)=>unit(`new_${index}`,'me')));const delta=createViewDelta(base,next);return {base,next,delta,chunks:chunkViewDelta(delta,`delta_${sequence}`)};}
  function alteredDocument(chunks:DeltaChunk[],mutate:(value:Record<string,unknown>)=>void):DeltaChunk[]{
    const document=JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk.data,'base64'))).toString('utf8')) as Record<string,unknown>;mutate(document);
    const text=JSON.stringify(document),bytes=Buffer.from(text),count=Math.ceil(bytes.length/SNAPSHOT_CHUNK_BYTES);
    return Array.from({length:count},(_,index)=>({...chunks[0]!,index,count,byteLength:bytes.length,sha256:sha256(text),data:bytes.subarray(index*SNAPSHOT_CHUNK_BYTES,(index+1)*SNAPSHOT_CHUNK_BYTES).toString('base64')}));
  }
  it('assembles large recipient deltas out of order without touching the complete base',()=>{
    const {base,next,delta,chunks}=transfer(),original=structuredClone(base),assembler=new DeltaAssembler();expect(chunks.length).toBeGreaterThan(2);
    for(const chunk of chunks){expect(validateDeltaChunk(chunk)).toBe(true);expect(validateServerSocketMessage(chunk)).toBe(true);expect(Buffer.from(chunk.data,'base64').length).toBeLessThanOrEqual(SNAPSHOT_CHUNK_BYTES);}
    expect(assembler.push(chunks[1]!,1000)).toEqual({status:'pending'});expect(assembler.push(chunks[1]!,1001)).toEqual({status:'pending'});
    let result;for(const chunk of [...chunks].reverse().filter(chunk=>chunk.index!==1)){result=assembler.push(chunk,1002);expect(base).toEqual(original);}
    expect(result).toEqual({status:'complete',delta});expect(applyViewDelta(base,delta)).toEqual(normalizePlayerView(next));
    expect(applyViewDelta({...base,sequence:base.sequence-1},delta)).toBeUndefined();
  });
  it('enforces strict envelope and sequence bounds in shipped and compiler validators',async()=>{
    const compiler=await import('./validation-compiler.js'),chunk=transfer().chunks[0]!;
    for(const malformed of [{...chunk,sequence:chunk.baseSequence},{...chunk,baseSequence:-1},{...chunk,baseSequence:1.5},{...chunk,count:513},{...chunk,byteLength:SNAPSHOT_MAX_BYTES+1},{...chunk,unknown:true},{...chunk,type:'snapshot_chunk',baseSequence:5}]){
      for(const check of [validateDeltaChunk,compiler.validateDeltaChunk,validateServerSocketMessage,compiler.validateServerSocketMessage])expect(check(malformed)).toBe(false);
      expect(new DeltaAssembler().push(malformed as DeltaChunk,1000).status).toBe('rejected');
    }
    for(const malformed of [{...chunk,index:chunk.count},{...chunk,count:chunk.count-1},{...chunk,data:chunk.data.slice(4)}])expect(new DeltaAssembler().push(malformed,1000)).toEqual({status:'rejected',code:'INVALID_DELTA_LENGTH'});
    expect(new DeltaAssembler().push(chunk,NaN)).toEqual({status:'rejected',code:'INVALID_DELTA_CHUNK'});
  });
  it('rejects identity and base confusion, conflicting duplicates, and damaged checksums',()=>{
    const {chunks}=transfer();
    for(const patch of [{playerId:'other'},{matchId:'other'},{matchEpoch:2},{contentHash:'0'.repeat(64)},{baseSequence:4},{transferId:'other_transfer'}]){
      const assembler=new DeltaAssembler();expect(assembler.push(chunks[0]!,1000).status).toBe('pending');expect(assembler.push({...chunks[1]!,...patch},1001)).toEqual({status:'rejected',code:'DELTA_TRANSFER_MISMATCH'});
    }
    const changed=Buffer.from(chunks[0]!.data,'base64');changed[10]=changed[10]!^1;const bad={...chunks[0]!,data:changed.toString('base64')},duplicate=new DeltaAssembler();duplicate.push(chunks[0]!,1000);
    expect(duplicate.push(bad,1001)).toEqual({status:'rejected',code:'DELTA_DUPLICATE_CONFLICT'});
    const checksum=new DeltaAssembler();let result;for(const chunk of [bad,...chunks.slice(1)])result=checksum.push(chunk,1000);expect(result).toEqual({status:'rejected',code:'DELTA_CHECKSUM_MISMATCH'});
  });
  it('does not extend the assembly deadline with duplicates and resets cleanly',()=>{
    const {chunks,delta}=transfer(),assembler=new DeltaAssembler();assembler.push(chunks[0]!,1000);assembler.push(chunks[0]!,1000+SNAPSHOT_ASSEMBLY_TIMEOUT_MS-1);
    expect(assembler.push(chunks[1]!,1000+SNAPSHOT_ASSEMBLY_TIMEOUT_MS)).toEqual({status:'rejected',code:'DELTA_TIMEOUT'});
    assembler.push(chunks[0]!,20000);expect(assembler.expire(20000+SNAPSHOT_ASSEMBLY_TIMEOUT_MS)).toBe(true);expect(assembler.expire(40000)).toBe(false);
    assembler.push(chunks[0]!,40000);assembler.reset();let result;for(const chunk of chunks)result=assembler.push(chunk,50000);expect(result).toEqual({status:'complete',delta});
  });
  it('accepts a newer same-base transfer while ignoring its stale tail, never a different base',()=>{
    const old=transfer(),fresh=transfer(7),assembler=new DeltaAssembler();assembler.push(old.chunks[0]!,1000);expect(assembler.push(fresh.chunks[0]!,1001).status).toBe('pending');
    expect(assembler.push(old.chunks[1]!,1002).status).toBe('pending');let result;for(const chunk of fresh.chunks.slice(1))result=assembler.push(chunk,1003);expect(result).toEqual({status:'complete',delta:fresh.delta});
    assembler.push(old.chunks[0]!,2000);expect(assembler.push({...fresh.chunks[0]!,baseSequence:6},2001)).toEqual({status:'rejected',code:'DELTA_TRANSFER_MISMATCH'});
  });
  it('validates the decoded delta even when a malicious sender recomputes a matching checksum',()=>{
    const {chunks}=transfer();
    for(const mutate of [(value:Record<string,unknown>)=>{value.baseSequence=4;},(value:Record<string,unknown>)=>{value.playerId='other';},(value:Record<string,unknown>)=>{value.sequence=7;},(value:Record<string,unknown>)=>{(value.creates as Record<string,unknown>[])[0]!.order={hidden:'forbidden'};}]){
      const assembler=new DeltaAssembler();let result;for(const chunk of alteredDocument(chunks,mutate))result=assembler.push(chunk,1000);expect(result).toEqual({status:'rejected',code:'INVALID_DELTA'});
    }
  });
  it('captures caller-owned input once without invoking accessors and retains exact UTF-8 text',()=>{
    const {delta}=transfer();delta.creates[0]!.order='資源が不足しています';const before=structuredClone(delta),chunks=chunkViewDelta(delta,'unicode_delta');delta.creates[0]!.hp=1;delta.creates[0]!.order='changed';
    const assembler=new DeltaAssembler();let result;for(const chunk of chunks)result=assembler.push(chunk,1000);expect(result).toEqual({status:'complete',delta:before});
    let reads=0;const accessor=structuredClone(before);Object.defineProperty(accessor,'sequence',{enumerable:true,get(){reads++;return 6;}});expect(()=>chunkViewDelta(accessor,'invalid')).toThrow('INVALID_DELTA');expect(reads).toBe(0);
    const hidden=structuredClone(before);Object.defineProperty(hidden,'sequence',{enumerable:false,value:6});expect(()=>chunkViewDelta(hidden,'invalid')).toThrow('INVALID_DELTA');
  });
});

describe('recipient-only atomic delta stream',()=>{
  it('admits the configured dense-resource capacity with full fog while retaining packet bounds and recipient privacy',()=>{
    const input=view();input.entities=Array.from({length:balance.rules.maxResourceNodes},(_,index)=>({id:`tree_${index}`,kind:'resource' as const,typeId:'tree_oak',ownerId:null,xMm:index%200*3000+1500,zMm:Math.floor(index/200)*3000+1500,hp:1,maxHp:1,resource:'wood' as const,amount:250,forest:{cellMm:3000,patchId:'a'.repeat(64)}}));
    input.fog.visible=Array.from({length:102400},(_,index)=>index);input.fog.explored=[...input.fog.visible];
    expect(MAX_WORLD_ENTITIES).toBeGreaterThan(input.entities.length);expect(validatePlayerView(input)).toBe(true);
    const chunks=chunkView(input,'dense_forests');expect(chunks.length).toBeGreaterThan(1);expect(chunks.reduce((sum,chunk)=>sum+Buffer.from(chunk.data,'base64').byteLength,0)).toBeLessThan(SNAPSHOT_MAX_BYTES);
    const malicious=structuredClone(input);Object.assign(malicious.entities[0]!,{order:'move'});expect(()=>chunkView(malicious,'private_fields')).toThrow('INVALID_SNAPSHOT');
  });
  it('preserves bounded publication cadence independently of simulation speed across every snapshot and delta lane',()=>{
    let base=view();base.simulationSpeed=.6;
    for(const publicationIntervalMs of [100,150,200,100,undefined] as const){
      const next=advance(base);if(publicationIntervalMs===undefined)delete next.publicationIntervalMs;else next.publicationIntervalMs=publicationIntervalMs;
      const scope=createPreparedViewScope(),before=scope.prepare(base),after=scope.prepare(next),delta=createViewDelta(base,next);
      expect(validatePlayerView(next)).toBe(true);expect(validatePlayerViewDelta(delta)).toBe(true);
      expect(scope.delta(before,after)).toEqual(delta);expect(JSON.parse(scope.encodeDeltaMessage(before,after))).toEqual({type:'delta',delta});
      const restored=applyViewDelta(base,delta)!;expect(restored).toEqual(normalizePlayerView(next));expect(restored.simulationSpeed).toBe(.6);
      if(publicationIntervalMs===undefined)expect(restored).not.toHaveProperty('publicationIntervalMs');else expect(restored.publicationIntervalMs).toBe(publicationIntervalMs);
      for(const chunks of [chunkView(next,'cadence_snapshot'),scope.chunks(after,'cadence_prepared')]){
        const assembler=new SnapshotAssembler();let assembled;for(const chunk of chunks)assembled=assembler.push(chunk,1000);
        expect(assembled).toEqual({status:'complete',view:normalizePlayerView(next)});
      }
      base=next;
    }
    for(const publicationIntervalMs of [0,50,125,201,Infinity,NaN,'150',null]){
      expect(validatePlayerView({...base,publicationIntervalMs})).toBe(false);
      expect(validatePlayerViewDelta({...createViewDelta(base,advance(base)),publicationIntervalMs})).toBe(false);
    }
  });
  it('carries bounded presentation speed through snapshots and deltas and removes it when normal speed returns',()=>{
    let base=view();
    for(const simulationSpeed of [.9,.1,1,undefined]){
      const next=advance(base);if(simulationSpeed===undefined)delete next.simulationSpeed;else next.simulationSpeed=simulationSpeed;
      expect(validatePlayerView(next)).toBe(true);expect(validateServerSocketMessage({type:'snapshot',view:next})).toBe(true);
      const delta=createViewDelta(base,next),scope=createPreparedViewScope();
      expect(scope.delta(scope.prepare(base),scope.prepare(next))).toEqual(delta);
      expect(validatePlayerViewDelta(delta)).toBe(true);expect(validateServerSocketMessage({type:'delta',delta})).toBe(true);
      const rebuilt=applyViewDelta(base,delta)!;expect(rebuilt).toEqual(normalizePlayerView(next));
      if(simulationSpeed===undefined)expect(rebuilt).not.toHaveProperty('simulationSpeed');else expect(rebuilt.simulationSpeed).toBe(simulationSpeed);
      base=next;
    }
    for(const simulationSpeed of [0,.099,1.01,NaN,Infinity,'0.9',null]){
      expect(validatePlayerView({...base,simulationSpeed})).toBe(false);
      expect(validatePlayerViewDelta({...createViewDelta(base,advance(base)),simulationSpeed})).toBe(false);
    }
  });
  it('compares validated JSON independent of property order while detecting nested changes',()=>{
    const base=view();base.entities[0]!.cargo={resource:'wood',amount:3};base.entities[0]!.xMm=0;
    const next=advance(base);next.entities=next.entities.map(entity=>Object.fromEntries(Object.entries(entity).reverse()) as ViewEntity);next.entities[0]!.cargo={amount:3,resource:'wood'};next.entities[0]!.xMm=-0;next.map=Object.fromEntries(Object.entries(next.map).reverse()) as PlayerView['map'];
    expect(createViewDelta(base,next).updates).toEqual([]);
    next.entities[0]!.cargo!.amount=4;const delta=createViewDelta(base,next);expect(delta.updates.map(entity=>entity.id)).toEqual(['own']);expect(applyViewDelta(base,delta)).toEqual(normalizePlayerView(next));
    delta.updates[0]!.cargo!.amount=99;expect(base.entities[0]!.cargo!.amount).toBe(3);expect(next.entities[0]!.cargo!.amount).toBe(4);
  });
  it('rejects optional undefined values and array holes before structural equality can hide them',()=>{
    const base=view(),undefinedOwn=advance(base);Object.assign(undefinedOwn.entities[0]!,{rally:undefined});
    expect(()=>createViewDelta(base,undefinedOwn)).toThrow('INVALID_DELTA_BOUNDARY');
    const hole=advance(base);delete hole.fog.visible[0];expect(()=>createViewDelta(base,hole)).toThrow('INVALID_DELTA_BOUNDARY');
    const undefinedArray=advance(base);Object.assign(undefinedArray.fog.visible,{0:undefined});expect(()=>createViewDelta(base,undefinedArray)).toThrow('INVALID_DELTA_BOUNDARY');
  });
  it('accepts equivalent unsorted fog but rejects duplicate, out-of-range and unexplored cells',()=>{
    const base=view(),next=advance(base);next.fog={visible:[2,1],explored:[2,0,1]};expect(applyViewDelta(base,createViewDelta(base,next))).toEqual(normalizePlayerView(next));
    for(const fog of [{visible:[1,1],explored:[0,1,2]},{visible:[1,2],explored:[0,1,2,2]},{visible:[3],explored:[0,1,2]},{visible:[1],explored:[0,1,102400]}]){const invalid=advance(base);invalid.fog=fog;expect(()=>createViewDelta(base,invalid)).toThrow('INVALID_DELTA_BOUNDARY');}
  });
  it('strictly decodes host replay metadata and bounded timeline viewpoints',()=>{
    const replayId='replay_1790000000000_abcdef0123456789',summary={id:replayId,createdAt:'2026-09-19T10:00:00.000Z',startTick:0,endTick:20,endOrdinal:9,bytes:50000};
    expect(validateReplayListResponse({recordings:[summary],warnings:[]})).toBe(true);expect(validateReplayListResponse({recordings:[{...summary,path:'private.ndjson'}],warnings:[]})).toBe(false);
    const opened={replayId,startTick:0,endTick:20,players:[]};expect(validateReplayOpenResponse(opened)).toBe(true);expect(validateReplayOpenResponse({...opened,startTick:21})).toBe(false);
    const response={replayId,startTick:0,endTick:20,tick:2,done:false,view:view()};expect(validateReplayStepResponse(response)).toBe(true);expect(validateReplayStepResponse({...response,tick:3})).toBe(false);expect(validateReplayStepResponse({...response,endTick:1})).toBe(false);expect(validateReplayStepResponse({...response,rawWorld:{seed:'private'}})).toBe(false);
  });
  it('reconstructs an authorized view with full updates, creates, concealment, observed removals and fog transitions',()=>{
    const base=view(),next=advance(base);next.entities=next.entities.filter(entity=>entity.id==='own');next.entities[0]!.xMm=5000;next.entities.push(unit('new_visible'));next.fog={visible:[2,3],explored:[0,1,2,3]};next.self.lastCommandSequence=8;
    const delta=createViewDelta(base,next);expect(delta).toMatchObject({baseSequence:5,sequence:6,conceals:['hidden_next'],removals:['memory']});expect(validatePlayerViewDelta(delta)).toBe(true);expect(validateServerSocketMessage({type:'delta',delta})).toBe(true);
    const original=structuredClone(base),reconstructed=applyViewDelta(base,delta);expect(reconstructed).toEqual(normalizePlayerView(next));expect(base).toEqual(original);reconstructed!.entities[0]!.hp=1;expect(next.entities.every(entity=>entity.hp===55)).toBe(true);
  });
  it('does not turn disappearance inside the prior visible cell into a hidden death report',()=>{
    const base=view(),next=advance(base);next.entities=next.entities.filter(entity=>entity.id!=='hidden_next');
    // Hidden movement and hidden death have the same authorized view and packet.
    const moved=createViewDelta(base,next),died=createViewDelta(base,structuredClone(next));expect(moved).toEqual(died);expect(moved.conceals).toEqual(['hidden_next']);expect(moved.removals).toEqual([]);
    next.effects=[{id:'observed_death',kind:'death',tick:next.tick,entityId:'hidden_next',typeId:'militia',xMm:4000,zMm:4000}];const observed=createViewDelta(base,next);expect(observed.conceals).toEqual([]);expect(observed.removals).toEqual(['hidden_next']);expect(applyViewDelta(base,observed)).toEqual(normalizePlayerView(next));
  });
  it.each([
    ['stale base',(delta:PlayerViewDelta)=>{delta.baseSequence--;}],
    ['wrong epoch',(delta:PlayerViewDelta)=>{delta.matchEpoch++;}],
    ['wrong recipient',(delta:PlayerViewDelta)=>{delta.playerId='other';}],
    ['wrong content',(delta:PlayerViewDelta)=>{delta.contentHash='other';}],
    ['backwards command watermark',(delta:PlayerViewDelta)=>{delta.self.lastCommandSequence=0;}],
    ['duplicate mutation',(delta:PlayerViewDelta)=>{delta.creates=[unit('duplicate'),unit('duplicate')];}],
    ['create existing',(delta:PlayerViewDelta)=>{delta.creates=[unit('own','me')];}],
    ['update missing',(delta:PlayerViewDelta)=>{delta.updates=[unit('missing')];}],
    ['change owner',(delta:PlayerViewDelta)=>{delta.updates=[unit('own','enemy')];}],
    ['enemy private queue',(delta:PlayerViewDelta)=>{delta.updates=[{...unit('hidden_next'),queue:[]}];}],
    ['conceal owned',(delta:PlayerViewDelta)=>{delta.conceals=['own'];}],
    ['unobserved enemy removal',(delta:PlayerViewDelta)=>{delta.removals=['hidden_next'];}],
    ['remove missing',(delta:PlayerViewDelta)=>{delta.removals=['missing'];}],
    ['remove absent fog',(delta:PlayerViewDelta)=>{delta.fog.visibleRemoved=[5];}],
    ['add already visible fog',(delta:PlayerViewDelta)=>{delta.fog.visibleAdded=[1];}],
    ['duplicate fog',(delta:PlayerViewDelta)=>{delta.fog.visibleAdded=[4,4];delta.fog.exploredAdded=[4];}],
    ['visibility without exploration',(delta:PlayerViewDelta)=>{delta.fog.visibleAdded=[4];}],
    ['repeat explored',(delta:PlayerViewDelta)=>{delta.fog.exploredAdded=[0];}],
    ['unknown field',(delta:PlayerViewDelta)=>{Object.assign(delta,{rawWorld:{}});}],
  ])('rejects %s without mutating the base',(_name,mutate)=>{const base=view(),original=structuredClone(base),delta=createViewDelta(base,advance(base));mutate(delta);expect(applyViewDelta(base,delta)).toBeUndefined();expect(base).toEqual(original);});
  it('preserves an unchanged stale building after unseen damage and removes it only when a refreshed filtered view clears the site',()=>{
    const base=view(),hidden=advance(base),delta=createViewDelta(base,hidden);expect(delta.updates).toEqual([]);expect(delta.removals).toEqual([]);const revisited=advance(hidden);revisited.entities=revisited.entities.filter(entity=>entity.id!=='memory');expect(createViewDelta(hidden,revisited).removals).toEqual(['memory']);
  });
});

describe('privately owned prepared snapshots',()=>{
  it('prepares owned JSON with the same normalized chunks, deltas and recipient boundaries as object capture',()=>{
    const source=view(),next=advance(source);source.fog.explored=Array.from({length:102400},(_,cell)=>cell).reverse();next.fog.explored=[...source.fog.explored];
    next.fog.visible=[3,2];next.entities=next.entities.filter(entity=>entity.id!=='hidden_next');next.entities[0]!.cargo={resource:'gold',amount:3.5};
    const text=JSON.stringify(next),scope=createPreparedViewScope(),base=scope.prepareJson(JSON.stringify(source)),prepared=scope.prepareJson(text);
    const expected=normalizePlayerView(next),encoded=JSON.stringify({type:'delta',delta:createViewDelta(source,next)});
    const objectScope=createPreparedViewScope();expect(scope.boundary(prepared)).toEqual(objectScope.boundary(objectScope.prepare(next)));
    expect(scope.chunks(prepared,'parsed')).toEqual(chunkView(expected,'parsed'));expect(scope.encodeDeltaMessage(base,prepared)).toBe(encoded);
    const decoded=JSON.parse(text);decoded.entities[0].cargo.amount=999;next.entities.length=0;source.fog.explored.length=0;
    const delta=scope.delta(base,prepared);delta.self.resources.gold=999;delta.updates[0]!.cargo!.amount=999;
    expect(scope.encodeDeltaMessage(base,prepared)).toBe(encoded);expect(scope.chunks(prepared,'parsed')).toEqual(chunkView(expected,'parsed'));
    const foreign=advance(expected);foreign.playerId='enemy';foreign.entities=[];expect(()=>scope.prepareJson(JSON.stringify(foreign))).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    expect(()=>createPreparedViewScope().boundary(prepared)).toThrow('INVALID_PREPARED_VIEW');
  });
  it('rejects malformed text, private enemy fields, inconsistent fog and entity limits identically before retention',()=>{
    const invalid:PlayerView[]=[];
    for(const mutate of [
      (input:PlayerView)=>{input.entities[1]!.queue=[];},
      (input:PlayerView)=>{Object.assign(input,{rawWorld:{enemyBank:123}});},
      (input:PlayerView)=>{input.fog.visible=[3];},
      (input:PlayerView)=>{input.fog.explored=[1,1];},
      (input:PlayerView)=>{input.entities[0]!.xMm=input.map.widthMm+1;},
      (input:PlayerView)=>{input.entities.push({...input.entities[0]!});},
      (input:PlayerView)=>{Object.assign(input.entities[0]!,{visualAction:{kind:'attack',startedTick:1,durationTicks:20,targetId:'hidden'}});},
    ]){const input=view();mutate(input);invalid.push(input);}
    for(const input of invalid){const scope=createPreparedViewScope();expect(()=>scope.prepareJson(JSON.stringify(input))).toThrow('INVALID_SNAPSHOT');expect(()=>scope.prepare(input)).toThrow('INVALID_SNAPSHOT');}
    const text=JSON.stringify(view());
    for(const malformed of [text.slice(0,-1),text.replace('"hp":55','"hp":1e999'),text.replace('"self":{','"self":{"__proto__":{},'),text.replace('"self":{','"self":{"constructor":{},')])expect(()=>createPreparedViewScope().prepareJson(malformed)).toThrow('INVALID_SNAPSHOT');
    const oversized=view();oversized.entities=Array.from({length:MAX_WORLD_ENTITIES+1},(_,index)=>unit(`unit_${index}`));
    expect(()=>createPreparedViewScope().prepareJson(JSON.stringify(oversized))).toThrow('SNAPSHOT_TOO_LARGE');
    const scope=createPreparedViewScope();expect(()=>scope.prepareJson(text.replace('"playerId":"me"','"playerId":"bad","secret":1'))).toThrow('INVALID_SNAPSHOT');expect(scope.boundary(scope.prepareJson(text)).playerId).toBe('me');
  });
  it('enforces the 16 MiB text admission limit, including multibyte strings, without changing object-capture safety',()=>{
    const text=JSON.stringify(view()),atLimit=text+' '.repeat(SNAPSHOT_MAX_BYTES-text.length),scope=createPreparedViewScope();
    expect(scope.boundary(scope.prepareJson(atLimit)).sequence).toBe(5);
    expect(()=>scope.prepareJson(atLimit+' ')).toThrow('SNAPSHOT_TOO_LARGE');
    const multi='"'+'\u754c'.repeat(Math.ceil(SNAPSHOT_MAX_BYTES/3))+'"';expect(multi.length).toBeLessThan(SNAPSHOT_MAX_BYTES);expect(()=>scope.prepareJson(multi)).toThrow('SNAPSHOT_TOO_LARGE');
    let reads=0;const input=view();Object.defineProperty(input,'toJSON',{get(){reads++;throw new Error('private');}});
    expect(()=>scope.prepareJson(input)).toThrow('INVALID_SNAPSHOT');expect(()=>scope.prepare(input)).toThrow('INVALID_SNAPSHOT');expect(reads).toBe(0);
  });
  it('encodes the same ordered entity changes as the public path, including concealment and observed deaths',()=>{
    const entities=[unit('z_hidden'),unit('A_same','me'),{...unit('_memory'),kind:'building' as const,typeId:'house'},unit('b_dead'),unit('m_own','me'),unit('a_changed','me')];
    const changed=[unit('zz_new'),{...unit('a_changed','me'),hp:54},unit('-new'),Object.fromEntries(Object.entries(unit('A_same','me')).reverse()) as ViewEntity];
    const cases:[ViewEntity[],ViewEntity[]][]=[[entities,changed],[[],changed],[entities,[]],[[],[]]];
    for(const [prior,later] of cases)for(const reversed of [false,true]){
      const source=view(),next=advance(source);source.entities=reversed?[...prior].reverse():prior;next.entities=reversed?[...later].reverse():later;
      next.effects=[{id:'death',kind:'death',tick:next.tick,entityId:'b_dead',typeId:'militia',xMm:4000,zMm:4000}];
      const scope=createPreparedViewScope(),base=scope.prepare(source),prepared=scope.prepare(next),expected=createViewDelta(source,next);
      const encoded=scope.encodeDeltaMessage(base,prepared);
      expect(encoded).toBe(JSON.stringify({type:'delta',delta:expected}));expect(scope.delta(base,prepared)).toEqual(expected);
      const decoded=JSON.parse(encoded);expect(validateServerSocketMessage(decoded)).toBe(true);
      expect(applyViewDelta(source,decoded.delta)).toEqual(normalizePlayerView(next));
    }
  });
  it('matches public deltas or explored-shrink rejection for all 729 three-cell membership transitions and mixed ordering',()=>{
    const cells=[0,32768,102399],orders=[cells,[102399,32768,0],[32768,0,102399]];
    const fog=(state:number,order:number[]):PlayerView['fog']=>{
      const membership=(cell:number)=>Math.floor(state/3**cells.indexOf(cell))%3;
      return {visible:order.filter(cell=>membership(cell)===2),explored:order.filter(cell=>membership(cell)>0)};
    };
    for(let before=0;before<27;before++){
      const source=view();source.fog=fog(before,orders[before%orders.length]!);
      const scope=createPreparedViewScope(),base=scope.prepare(source);
      for(let after=0;after<27;after++){
        const next=advance(source);next.fog=fog(after,orders[(after+1)%orders.length]!);const prepared=scope.prepare(next);
        const shrinks=source.fog.explored.some(cell=>!next.fog.explored.includes(cell));
        if(shrinks){expect(()=>createViewDelta(source,next)).toThrow('INVALID_DELTA_FOG');expect(()=>scope.delta(base,prepared)).toThrow('INVALID_DELTA_FOG');}
        else{const delta=scope.delta(base,prepared);expect(delta).toEqual(createViewDelta(source,next));expect(applyViewDelta(source,delta)).toEqual(normalizePlayerView(next));}
      }
    }
  });
  it('matches the public path across the entire legal fog grid with dense interleaved additions and removals',()=>{
    const cells=Array.from({length:102400},(_,cell)=>cell),source=view(),next=advance(source);
    source.fog={visible:cells.filter(cell=>cell%4===0).reverse(),explored:cells.filter(cell=>cell%2===0).reverse()};
    next.fog={visible:cells.filter(cell=>cell%3===1).reverse(),explored:[...cells].reverse()};
    const original=structuredClone(source),originalNext=structuredClone(next),scope=createPreparedViewScope();
    const delta=scope.delta(scope.prepare(source),scope.prepare(next));
    expect(delta).toEqual(createViewDelta(source,next));expect(delta.fog.exploredAdded).toHaveLength(51200);
    expect(delta.fog.exploredAdded[0]).toBe(1);expect(delta.fog.exploredAdded.at(-1)).toBe(102399);
    expect(applyViewDelta(source,delta)).toEqual(normalizePlayerView(next));expect(source).toEqual(original);expect(next).toEqual(originalNext);
  });
  it('keeps signed zero membership and exact fog output semantics equivalent to the public path',()=>{
    for(const [prior,later] of [
      [{visible:[],explored:[]},{visible:[102399,-0],explored:[102399,-0]}],
      [{visible:[-0],explored:[-0]},{visible:[0],explored:[0]}],
    ] as [PlayerView['fog'],PlayerView['fog']][]){
      const source=view(),next=advance(source);source.fog=prior;next.fog=later;
      const scope=createPreparedViewScope(),delta=scope.delta(scope.prepare(source),scope.prepare(next));
      expect(delta).toEqual(createViewDelta(source,next));
    }
  });
  it('detaches all three fog difference arrays from inputs, retained snapshots and later results',()=>{
    const source=view(),next=advance(source);
    source.fog={visible:[102399,2],explored:[102399,4,2,0]};next.fog={visible:[102398,5,0],explored:[102399,102398,5,4,2,0]};
    const expected=createViewDelta(source,next),scope=createPreparedViewScope(),base=scope.prepare(source),prepared=scope.prepare(next);
    source.fog.visible.length=0;source.fog.explored.push(123);next.fog.visible.push(456);next.fog.explored.length=0;
    const delta=scope.delta(base,prepared);expect(delta).toEqual(expected);
    delta.fog.visibleAdded.push(102400);delta.fog.visibleRemoved.length=0;delta.fog.exploredAdded.reverse();delta.fog.exploredAdded.push(99999);
    expect(scope.delta(base,prepared)).toEqual(expected);
    const later=scope.delta(base,prepared);later.fog.exploredAdded.length=0;expect(scope.delta(base,prepared)).toEqual(expected);
  });
  it('rejects malformed fog before sorted differences can assume uniqueness or valid cell bounds',()=>{
    for(const invalid of [
      {visible:[0,-0],explored:[0]},
      {visible:[1],explored:[1,1]},
      {visible:[-1],explored:[-1]},
      {visible:[102400],explored:[102400]},
      {visible:[102399],explored:[0]},
    ]){
      const source=view(),next=advance(source);next.fog=invalid;
      expect(()=>createViewDelta(source,next)).toThrow('INVALID_DELTA_BOUNDARY');
      expect(()=>createPreparedViewScope().prepare(next)).toThrow('INVALID_SNAPSHOT');
    }
  });
  it('matches the public delta and snapshot paths after caller and returned-output mutation',()=>{
    const source=view(),next=advance(source);next.entities=next.entities.filter(entity=>entity.id!=='hidden_next');next.entities[0]!.cargo={resource:'wood',amount:4};next.fog={visible:[3,2],explored:[3,2,1,0]};
    const expectedBase=structuredClone(source),expectedNext=structuredClone(next),scope=createPreparedViewScope();
    const base=scope.prepare(source),prepared=scope.prepare(next);
    const expectedWire=JSON.stringify({type:'delta',delta:createViewDelta(expectedBase,expectedNext)});
    source.self.resources.food=999;source.entities[0]!.hp=0;next.entities[0]!.cargo!.amount=99;next.fog.explored.length=0;
    let getterCalls=0;Object.defineProperty(next.self.resources,'wood',{get(){getterCalls++;throw new Error('caller getter');}});Object.setPrototypeOf(source.map,{widthMm:1});
    const delta=scope.delta(base,prepared);expect(delta).toEqual(createViewDelta(expectedBase,expectedNext));expect(delta.conceals).toEqual(['hidden_next']);
    delta.updates[0]!.hp=1;delta.self.resources.food=0;delta.fog.exploredAdded.push(99999);
    expect(scope.delta(base,prepared)).toEqual(createViewDelta(expectedBase,expectedNext));
    const encoded=scope.encodeDeltaMessage(base,prepared);expect(encoded).toBe(expectedWire);
    const decoded=JSON.parse(encoded);decoded.delta.map.widthMm=2;decoded.delta.self.resources.gold=999;decoded.delta.updates[0].cargo.amount=999;
    expect(scope.encodeDeltaMessage(base,prepared)).toBe(expectedWire);expect(encoded).toBe(expectedWire);
    const chunks=scope.chunks(prepared,'prepared');expect(chunks).toEqual(chunkView(expectedNext,'prepared'));chunks[0]!.data='changed';
    expect(scope.chunks(prepared,'prepared')).toEqual(chunkView(expectedNext,'prepared'));expect(getterCalls).toBe(0);
    const boundary=scope.boundary(prepared);expect(Reflect.set(boundary,'playerId','enemy')).toBe(false);expect(scope.boundary(prepared).playerId).toBe('me');
  });
  it('rejects forged, cloned, proxied and wrong-scope handles without evaluating their properties',()=>{
    const scope=createPreparedViewScope(),other=createPreparedViewScope(),base=scope.prepare(view()),next=scope.prepare(advance(view()));
    expect(Object.getOwnPropertyNames(base)).toEqual([]);expect(Object.getOwnPropertySymbols(base)).toEqual([]);expect(Object.isFrozen(base)).toBe(true);
    let reads=0;const proxy=new Proxy(base,{get(){reads++;throw new Error('fake handle getter');}});
    for(const fake of [{},structuredClone(base),Object.create(base),proxy,other.prepare(view()),null]){
      expect(()=>scope.boundary(fake as PreparedViewHandle)).toThrow('INVALID_PREPARED_VIEW');
      expect(()=>scope.delta(fake as PreparedViewHandle,next)).toThrow('INVALID_PREPARED_VIEW');
      expect(()=>scope.encodeDeltaMessage(fake as PreparedViewHandle,next)).toThrow('INVALID_PREPARED_VIEW');
      expect(()=>scope.encodeDeltaMessage(base,fake as PreparedViewHandle)).toThrow('INVALID_PREPARED_VIEW');
      expect(()=>scope.chunks(fake as PreparedViewHandle,'fake')).toThrow('INVALID_PREPARED_VIEW');
    }
    expect(reads).toBe(0);expect(()=>other.delta(base,next)).toThrow('INVALID_PREPARED_VIEW');expect(()=>other.encodeDeltaMessage(base,next)).toThrow('INVALID_PREPARED_VIEW');
  });
  it('binds a scope to its recipient and preserves match, sequence, map and explored-fog boundaries',()=>{
    const scope=createPreparedViewScope(),base=scope.prepare(view()),foreign=advance(view());foreign.playerId='enemy';
    expect(()=>scope.prepare(foreign)).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    for(const mutate of [(next:PlayerView)=>{next.matchEpoch++;},(next:PlayerView)=>{next.sequence=5;},(next:PlayerView)=>{next.tick=1;},(next:PlayerView)=>{next.map.widthMm=638000;}]){
      const next=advance(view());mutate(next);const handle=scope.prepare(next);expect(()=>scope.delta(base,handle)).toThrow('INVALID_DELTA_BOUNDARY');expect(()=>scope.encodeDeltaMessage(base,handle)).toThrow('INVALID_DELTA_BOUNDARY');
    }
    const forgotten=advance(view());forgotten.fog.explored=[1,2];const forgottenHandle=scope.prepare(forgotten);expect(()=>scope.delta(base,forgottenHandle)).toThrow('INVALID_DELTA_FOG');expect(()=>scope.encodeDeltaMessage(base,forgottenHandle)).toThrow('INVALID_DELTA_FOG');
    expect(()=>scope.chunks(base,'invalid transfer id')).toThrow('INVALID_SNAPSHOT_TRANSFER');
  });
  it('rejects unsafe input and enemy private fields before preparing any transfer',()=>{
    const mutations:((input:PlayerView)=>void)[]=[
      input=>{Object.setPrototypeOf(input.self,{secret:1});},
      input=>{Object.assign(input.entities[0]!,{rally:undefined});},
      input=>{input.self.resources.food=NaN;},
      input=>{input.self.resources.wood=Infinity;},
      input=>{Object.assign(input.self,{loop:input});},
      input=>{Object.defineProperty(input,'__proto__',{value:{secret:1},enumerable:false});},
      input=>{delete input.fog.visible[0];},
      input=>{Object.assign(input.fog.visible,{extra:0});},
      input=>{input.entities.push({...unit('enemy_private'),queue:[]});},
      input=>{Object.defineProperty(input.entities[1]!,'cargo',{value:{resource:'gold',amount:123},enumerable:false});},
      input=>{Object.assign(input,{rawWorld:{enemyBank:123}});},
      input=>{input.fog.explored=new Array(1000001).fill(0);},
      input=>{let nested:unknown=null;for(let i=0;i<33;i++)nested={nested};Object.assign(input,{nested});},
    ];
    for(const mutate of mutations){const input=view();mutate(input);expect(()=>createPreparedViewScope().prepare(input)).toThrow('INVALID_SNAPSHOT');}
    const oversized=view();oversized.entities=Array.from({length:MAX_WORLD_ENTITIES+1},(_,index)=>unit(`unit_${index}`));expect(()=>createPreparedViewScope().prepare(oversized)).toThrow('SNAPSHOT_TOO_LARGE');
  });
  it('never reads accessors or proxy get traps and captures data before hostile source mutation',()=>{
    let getterCalls=0;
    for(const install of [
      (input:PlayerView)=>Object.defineProperty(input,'map',{get(){getterCalls++;throw new Error('getter');}}),
      (input:PlayerView)=>Object.defineProperty(input.self.resources,'gold',{get(){getterCalls++;return 1;}}),
      (input:PlayerView)=>Object.defineProperty(input.entities,0,{get(){getterCalls++;return unit('getter');},enumerable:true}),
    ]){const input=view();install(input);expect(()=>createPreparedViewScope().prepare(input)).toThrow('INVALID_SNAPSHOT');}
    const input=view(),expected=structuredClone(input),entity=input.entities[0]!;
    input.entities[0]=new Proxy(entity,{get(){getterCalls++;throw new Error('proxy get');}});
    input.players=new Proxy(input.players,{ownKeys(target){Object.defineProperty(input.self.resources,'food',{get(){getterCalls++;throw new Error('late getter');}});return Reflect.ownKeys(target);}});
    const scope=createPreparedViewScope(),handle=scope.prepare(input);entity.hp=1;
    expect(scope.chunks(handle,'captured')).toEqual(chunkView(expected,'captured'));expect(getterCalls).toBe(0);
    const broken=view();broken.self=new Proxy(broken.self,{getOwnPropertyDescriptor(){throw new Error('private descriptor payload');}});
    expect(()=>scope.prepare(broken)).toThrow('INVALID_SNAPSHOT');
  });
  it('rejects nonenumerable required fields that would disappear from an encoded snapshot',()=>{
    const input=view();Object.defineProperty(input.entities[0]!,'id',{enumerable:false});
    expect(validatePlayerView(input)).toBe(true);expect(validatePlayerView.capture(input)).toBeDefined();
    expect(validatePlayerView(normalizePlayerView(input))).toBe(false);
    expect(()=>createPreparedViewScope().prepare(input)).toThrow('INVALID_SNAPSHOT');
  });
});

describe('bounded snapshot assembly',()=>{
  function large(){const source=view();source.fog.explored=Array.from({length:102400},(_,index)=>index);source.players=[{id:'me',name:'玩家 🏰',teamId:'blue',color:'#abcdef',kind:'human'}];return source;}
  it('atomically assembles out-of-order UTF-8 chunks and harmless duplicates with a verified digest',()=>{
    const source=large(),chunks=chunkView(source,'transfer'),assembler=new SnapshotAssembler();expect(chunks.length).toBeGreaterThan(1);expect(chunks.every(chunk=>validateServerSocketMessage(chunk))).toBe(true);
    expect(assembler.push(chunks.at(-1)!,10)).toEqual({status:'pending'});expect(assembler.push(chunks.at(-1)!,20)).toEqual({status:'pending'});
    for(const chunk of chunks.slice(0,-2))expect(assembler.push(chunk,30)).toEqual({status:'pending'});
    expect(assembler.push(chunks.at(-2)!,40)).toEqual({status:'complete',view:normalizePlayerView(source)});
  });
  it('rejects conflicting duplicates, metadata swaps, corruption and allocation attacks',()=>{
    const chunks=chunkView(large(),'transfer');
    for(const mutate of [
      (chunk:SnapshotChunk)=>{chunk.count=1_000_000_000;},(chunk:SnapshotChunk)=>{chunk.byteLength=1_000_000_000;},
      (chunk:SnapshotChunk)=>{chunk.index=chunk.count;},(chunk:SnapshotChunk)=>{chunk.data+='AAAA';},
      (chunk:SnapshotChunk)=>{chunk.transferId='other';},(chunk:SnapshotChunk)=>{chunk.playerId='other';},
      (chunk:SnapshotChunk)=>{chunk.data=(chunk.data[0]==='A'?'B':'A')+chunk.data.slice(1);},
    ]){const assembler=new SnapshotAssembler();expect(assembler.push(chunks[0]!,0).status).toBe('pending');const altered=structuredClone(chunks[0]!);mutate(altered);expect(assembler.push(altered,1).status).toBe('rejected');}
    const corrupt=chunkView(view(),'single');corrupt[0]!.sha256='0'.repeat(64);expect(new SnapshotAssembler().push(corrupt[0]!,0)).toEqual({status:'rejected',code:'SNAPSHOT_CHECKSUM_MISMATCH'});
  });
  it('expires incomplete assembly and permits an explicit clean resync',()=>{
    const chunks=chunkView(large(),'transfer'),assembler=new SnapshotAssembler();expect(assembler.push(chunks[0]!,5).status).toBe('pending');expect(assembler.expire(5+SNAPSHOT_ASSEMBLY_TIMEOUT_MS-1)).toBe(false);expect(assembler.expire(5+SNAPSHOT_ASSEMBLY_TIMEOUT_MS)).toBe(true);
    const complete=chunkView(view(),'fresh')[0]!;expect(assembler.push(complete,11000).status).toBe('complete');
    expect(assembler.push(chunks[0]!,12000).status).toBe('pending');expect(assembler.push(chunks[1]!,22000)).toEqual({status:'rejected',code:'SNAPSHOT_TIMEOUT'});
  });
  it('lets a newer authorized snapshot replace an incomplete transfer and ignores its stale tail',()=>{
    const prior=chunkView(large(),'old'),source=advance(large()),next=chunkView(source,'new'),assembler=new SnapshotAssembler();
    expect(assembler.push(prior[1]!,0).status).toBe('pending');expect(assembler.push(next[0]!,1).status).toBe('pending');expect(assembler.push(prior[0]!,2).status).toBe('pending');
    for(const chunk of next.slice(1,-1))expect(assembler.push(chunk,3).status).toBe('pending');expect(assembler.push(next.at(-1)!,4)).toEqual({status:'complete',view:normalizePlayerView(source)});
  });
  it('accepts the configured live-entity capacity and fails explicitly above it',()=>{
    const source=view();source.entities=Array.from({length:MAX_WORLD_ENTITIES},(_,index)=>unit(`entity_${index}`));expect(()=>chunkView(source,'capacity')).not.toThrow();source.entities=Array.from({length:MAX_WORLD_ENTITIES+1},(_,index)=>unit(`entity_${index}`));expect(()=>chunkView(source,'oversize')).toThrow('SNAPSHOT_TOO_LARGE');
  });
  it('rejects a checksummed document with an invalid nested field rather than partially applying it',()=>{
    const source=view() as PlayerView&{rawWorld?:unknown};source.rawWorld={enemyBank:10};const text=JSON.stringify(source),bytes=new TextEncoder().encode(text),base=chunkView(view(),'invalid')[0]!;
    const chunk={...base,byteLength:bytes.length,sha256:sha256(text),data:btoa(String.fromCharCode(...bytes))};expect(bytes.length).toBeLessThan(SNAPSHOT_CHUNK_BYTES);expect(new SnapshotAssembler().push(chunk,0)).toEqual({status:'rejected',code:'INVALID_SNAPSHOT'});
  });
});
