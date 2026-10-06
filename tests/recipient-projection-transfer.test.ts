import { describe,expect,it,vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { balance,contentHash,resolveRuleset,type PlayerView } from '@frontier/shared';
import { RecipientProjectionReceiver,type ProjectionTransfer,PROJECTION_TRANSFER_MAX_BYTES } from '../apps/server/src/recipient-projection-transfer.js';
import { ProjectionCredits,RecipientProjection,type ProjectionPatch } from '../packages/simulation/src/recipient-projection.js';
import { postNativeProjection } from '../packages/simulation/src/recipient-projection-native.js';

function view(playerId='blue',sequence=1):PlayerView {
  return {protocolVersion:2,contentHash,matchId:'projection_transfer',matchEpoch:1,playerId,tick:sequence*2,sequence,status:'RUNNING',
    map:{widthMm:640000,heightMm:640000,fogCellMm:2000},
    self:{lastCommandSequence:sequence,resources:{food:100,wood:100,gold:0,stone:0},age:1,population:1,populationCap:15,populationLimit:120,reservedPopulation:0},
    players:[],entities:[{id:`${playerId}_worker`,kind:'unit',typeId:'villager',ownerId:playerId,xMm:10000,zMm:10000,hp:35,maxHp:35,cargo:{resource:'wood',amount:7},order:'gather'}],fog:{visible:[1],explored:[1]},effects:[]};
}
function header(input:PlayerView):ProjectionPatch['header'] {
  const {protocolVersion,contentHash,matchId,matchEpoch,playerId,tick,sequence,status}=input;
  return {protocolVersion,contentHash,matchId,matchEpoch,playerId,tick,sequence,status};
}
function full(input=view(),revision=1,generation=1):ProjectionTransfer {
  const {entities,...fields}=input;
  return {generation,patch:{revision,baseRevision:0,header:header(input),fields,removedFields:[],entities:{upserts:entities,removed:[],order:entities.map(entity=>entity.id)}}};
}
function update(input=view('blue',2),baseRevision=1,revision=2):ProjectionTransfer {
  return {generation:1,patch:{revision,baseRevision,header:header(input),fields:{tick:input.tick,sequence:input.sequence,self:input.self},removedFields:[],entities:{upserts:input.entities,removed:[]}}};
}
function receiver(){const value=new RecipientProjectionReceiver();value.reset(1);return value;}

describe('internal absolute recipient projection transport',()=>{
  it('retains eight-age identity and owner state through sparse recipient publication',()=>{
    const source=new RecipientProjection(),target=receiver(),initial=view(),rules=resolveRuleset('legendary_ages_v1',8,'long_war');
    Object.assign(initial,{rulesetId:rules.rulesetId,maxAge:rules.maxAge,startingResourcePreset:rules.startingResourcePreset,contentHash:rules.contentHash});initial.self.age=7;
    initial.entities.push({id:'citadel',kind:'building',typeId:'runic_citadel',ownerId:'blue',xMm:40000,zMm:40000,hp:6000,maxHp:9000,progress:1,ward:{current:700,max:2500,supportId:'spire'},upgrade:{jobId:'upgrade',targetTypeId:'titan_citadel',progress:.2,started:true,state:'active'}});
    const prepare=(input:PlayerView)=>{source.begin();for(const entity of input.entities)source.entity(entity);const {entities:_entities,...fields}=input;return source.finish(fields);};
    const first=target.receive({generation:1,patch:prepare(initial)},'blue');expect(first).toEqual(initial);
    const next=structuredClone(initial);next.tick++;next.sequence++;next.entities[1]!.upgrade!.progress=.4;
    const patch=prepare(next);expect(patch.entities.upserts).toHaveLength(1);expect(target.receive({generation:1,patch},'blue')).toEqual(next);expect(first.entities[1]!.upgrade!.progress).toBe(.2);
  });
  it('transfers the configured dense forest population and retains depletion through sparse updates',()=>{
    const source=new RecipientProjection(),target=receiver(),initial=view();
    initial.entities=Array.from({length:balance.rules.maxResourceNodes},(_,index):PlayerView['entities'][number]=>({id:`tree_${index}`,kind:'resource',typeId:'tree_oak',ownerId:null,xMm:index%200*3000+1500,zMm:Math.floor(index/200)*3000+1500,hp:1,maxHp:1,resource:'wood',amount:250,forest:{cellMm:3000,patchId:'a'.repeat(64)}}));
    initial.fog.visible=Array.from({length:102400},(_,index)=>index);initial.fog.explored=[...initial.fog.visible];
    const prepare=(input:PlayerView)=>{source.begin();for(const entity of input.entities)source.entity(entity);const {entities:_entities,...fields}=input;return source.finish(fields);};
    const first=target.receive({generation:1,patch:prepare(initial)},'blue');expect(first).toEqual(initial);
    const next={...initial,tick:4,sequence:2,entities:initial.entities.slice(1)};
    next.entities[0]={...next.entities[0]!,amount:249};
    const patch=prepare(next);expect(patch.entities.removed).toEqual(['tree_0']);expect(patch.entities.upserts).toHaveLength(1);
    expect(target.receive({generation:1,patch},'blue')).toEqual(next);
    expect(first.entities).toHaveLength(balance.rules.maxResourceNodes);expect(first.entities[1]!.amount).toBe(250);
    expect(()=>target.receive({generation:1,patch},'red')).toThrow('INVALID_SNAPSHOT_RECIPIENT');
  });
  it('validates presentation speed on full and retained-fog paths and removes it atomically on return to normal',()=>{
    const target=receiver(),initial={...view(),simulationSpeed:.9},first=target.receive(full(initial),'blue');
    expect(first.simulationSpeed).toBe(.9);
    for(const speed of [0,.099,1.01,Infinity,NaN,'0.9',null]){
      const fullInvalid=full(initial);Object.assign(fullInvalid.patch.fields,{simulationSpeed:speed});
      expect(()=>receiver().receive(fullInvalid,'blue')).toThrow('INVALID_PROJECTION_TRANSFER');
      const updateInvalid=update();Object.assign(updateInvalid.patch.fields,{simulationSpeed:speed});
      expect(()=>target.receive(updateInvalid,'blue')).toThrow('INVALID_PROJECTION_TRANSFER');
    }
    const next=update();next.patch.fields.simulationSpeed=.1;
    const second=target.receive(next,'blue');expect(second.simulationSpeed).toBe(.1);expect(first.simulationSpeed).toBe(.9);
    const ambiguous=update(view('blue',3),2,3);ambiguous.patch.fields.simulationSpeed=1;ambiguous.patch.removedFields=['simulationSpeed'];
    expect(()=>target.receive(ambiguous,'blue')).toThrow('INVALID_PROJECTION_TRANSFER');
    const normal=update(view('blue',3),2,3);normal.patch.removedFields=['simulationSpeed'];
    expect(target.receive(normal,'blue')).toEqual(view('blue',3));expect(second.simulationSpeed).toBe(.1);
  });
  it('reconstructs absolute updates, removals, insertions, order, fog and field deletion without mutating older publications',()=>{
    const target=receiver(),initial=view(),first=target.receive(full(initial),'blue'),before=structuredClone(first);
    const next=view('blue',2);next.entities=[{...next.entities[0]!,id:'new_worker',xMm:12000}];delete next.entities[0]!.cargo;delete next.effects;next.fog={visible:[2],explored:[1,2]};
    const patch=update(next);patch.patch.entities.removed=['blue_worker'];patch.patch.entities.order=['new_worker'];patch.patch.fields.fog=next.fog;patch.patch.removedFields=['effects'];
    expect(target.receive(patch,'blue')).toEqual(next);expect(first).toEqual(before);
    // Caller-owned transfer mutation cannot rewrite the retained parsed base.
    patch.patch.entities.upserts[0]!.hp=0;
    const unchanged=update(view('blue',3),2,3);unchanged.patch.entities.upserts=[];
    const third=target.receive(unchanged,'blue');expect(third.entities[0]!.hp).toBe(35);expect(third.entities[0]!.cargo).toBeUndefined();expect(third.effects).toBeUndefined();
  });
  it('rejects missing/wrong bases, stale revisions, cross-recipient and cross-epoch patches without corrupting the last base',()=>{
    const target=receiver();expect(()=>target.receive(update(),'blue')).toThrow('PROJECTION_BASE_MISMATCH');target.receive(full(),'blue');
    const wrongBase=update();wrongBase.patch.baseRevision=0;expect(()=>target.receive(wrongBase,'blue')).toThrow();
    expect(()=>target.receive(update(),'red')).toThrow('INVALID_SNAPSHOT_RECIPIENT');
    const epoch=update();epoch.patch.header.matchEpoch=2;epoch.patch.fields.matchEpoch=2;expect(()=>target.receive(epoch,'blue')).toThrow('PROJECTION_IDENTITY_MISMATCH');
    expect(target.receive(update(),'blue')).toEqual(view('blue',2));expect(()=>target.receive(update(),'blue')).toThrow();
    const past=update(view('blue',1),2,3);expect(()=>target.receive(past,'blue')).toThrow('STALE_PROJECTION_TRANSFER');
    expect(target.receive(update(view('blue',3),2,3),'blue')).toEqual(view('blue',3));
  });
  it('binds resets to an explicit monotonically increasing stream generation and permits a complete new epoch',()=>{
    const target=receiver();target.receive(full(),'blue');target.reset(2);
    expect(()=>target.receive(full(view(),2),'blue')).toThrow('STALE_PROJECTION_TRANSFER');expect(()=>target.reset(2)).toThrow('STALE_PROJECTION_RESET');
    const next=view();next.matchEpoch=2;next.tick=0;next.sequence=0;
    expect(target.receive(full(next,1,2),'blue')).toEqual(next);expect(target.inventory()).toMatchObject({generation:2,recipients:1,entities:1});
    target.clear();expect(target.inventory().recipients).toBe(0);expect(()=>target.receive({...update(),generation:2},'blue')).toThrow('PROJECTION_BASE_MISMATCH');
  });
  it('rejects unknown fields, inconsistent headers, duplicate IDs, unknown removal and incomplete order atomically',()=>{
    const target=receiver();target.receive(full(),'blue');
    const bad:ProjectionTransfer[]=[];
    const field=update();Object.assign(field.patch.fields,{secretSeed:'never allowed'});bad.push(field);
    const envelope=update();Object.assign(envelope,{extra:true});bad.push(envelope);
    const mismatch=update();mismatch.patch.header.tick++;bad.push(mismatch);
    const duplicate=update();duplicate.patch.entities.upserts.push({...duplicate.patch.entities.upserts[0]!});bad.push(duplicate);
    const removal=update();removal.patch.entities.removed=['absent'];bad.push(removal);
    const order=update();order.patch.entities.order=[];bad.push(order);
    const required=update();required.patch.removedFields=['self'];bad.push(required);
    const schema=update();schema.patch.entities.upserts[0]!.hp=-1;bad.push(schema);
    const map=update();map.patch.fields.map={...view().map,widthMm:320000};bad.push(map);
    for(const patch of bad)expect(()=>target.receive(patch,'blue')).toThrow();
    expect(target.receive(update(),'blue')).toEqual(view('blue',2));
  });
  it('preserves internal JSON semantics and rejects unsafe descriptors before executing user code',()=>{
    const target=receiver(),input=full();input.patch.fields.effects=undefined;input.patch.entities.upserts[0]!.xMm=-0;
    expect(target.receive(input,'blue')).toEqual(JSON.parse(JSON.stringify({...view(),effects:undefined,entities:input.patch.entities.upserts})));
    const getter=vi.fn(()=>2),unsafe=update();Object.defineProperty(unsafe.patch.fields,'tick',{get:getter,enumerable:true});
    expect(()=>target.receive(unsafe,'blue')).toThrow();expect(getter).not.toHaveBeenCalled();
    const method=vi.fn(()=>({})),unsafeMethod=update();Object.assign(unsafeMethod.patch.fields,{toJSON:method});expect(()=>target.receive(unsafeMethod,'blue')).toThrow();expect(method).not.toHaveBeenCalled();
    const dangerous=update();Object.defineProperty(dangerous.patch.fields,'__proto__',{value:{polluted:true},enumerable:true});expect(()=>target.receive(dangerous,'blue')).toThrow();
    const cycle=update();Object.assign(cycle.patch.fields,{cycle});expect(()=>target.receive(cycle,'blue')).toThrow();
    const sparse=update();sparse.patch.entities.upserts.length=2;expect(()=>target.receive(sparse,'blue')).toThrow();
    const hidden=update();Object.defineProperty(hidden.patch.fields,'hidden',{value:1,enumerable:false});expect(()=>target.receive(hidden,'blue')).toThrow();
  });
  it('bounds recipients, transfer size and detached entity inventory',()=>{
    const target=receiver();for(let index=0;index<11;index++)target.receive(full(view(`player_${index}`)),`player_${index}`);
    expect(target.inventory()).toMatchObject({recipients:11,entities:11});expect(()=>target.receive(full(view('overflow')),'overflow')).toThrow('RECIPIENT_LIMIT');
    const huge=full();Object.assign(huge.patch.fields,{huge:'\u0000'.repeat(Math.ceil(PROJECTION_TRANSFER_MAX_BYTES/6))});expect(()=>receiver().receive(huge,'blue')).toThrow('PROJECTION_TRANSFER_TOO_LARGE');
  });
  it('uses sparse fog deltas in the existing revision lane with exact detached views and full reset fallback',()=>{
    const source=new RecipientProjection(),target=receiver(),initial=view();initial.fog={visible:Array.from({length:80},(_,index)=>index),explored:Array.from({length:100},(_,index)=>index)};
    const prepare=(next:PlayerView)=>{source.begin();for(const entity of next.entities)source.entity(entity);const {entities:_entities,...fields}=next;return source.finish(fields);};
    const first=target.receive({generation:1,patch:prepare(initial)},'blue'),before=structuredClone(first);
    const next=view('blue',2);next.fog={visible:[...initial.fog.visible.slice(1),100],explored:[...initial.fog.explored,100]};
    const patch=prepare(next);expect(patch.fields.fog).toBeUndefined();expect(patch.fogDelta).toEqual({visibleAdded:[100],visibleRemoved:[0],exploredAdded:[100]});
    expect(target.receive({generation:1,patch},'blue')).toEqual(next);expect(first).toEqual(before);
    patch.fogDelta!.visibleAdded[0]=900;
    const unchanged=view('blue',3);unchanged.fog=structuredClone(next.fog);expect(target.receive({generation:1,patch:prepare(unchanged)},'blue')).toEqual(unchanged);
    const reset=view('blue',4);reset.fog={visible:[1],explored:[1]};const fullFog=prepare(reset);expect(fullFog.fogDelta).toBeUndefined();expect(fullFog.fields.fog).toEqual(reset.fog);expect(target.receive({generation:1,patch:fullFog},'blue')).toEqual(reset);
    // Dense changes are kept absolute when sparse keys would expand the transfer.
    const dense=view('blue',5);dense.fog={visible:[2],explored:[1,2]};expect(prepare(dense).fogDelta).toBeUndefined();
  });
  it('rejects malformed or misbound fog deltas atomically while retaining the prior recipient base',()=>{
    const target=receiver(),initial=view();initial.fog={visible:[1,2],explored:[1,2,3]};target.receive(full(initial),'blue');
    const valid=update();valid.patch.fogDelta={visibleAdded:[3],visibleRemoved:[1],exploredAdded:[]};
    const cases:((value:ProjectionTransfer)=>void)[]=[
      value=>{value.patch.baseRevision=0;},value=>{value.patch.fields.fog=initial.fog;},value=>{value.patch.fields.map=initial.map;},
      value=>{value.patch.fogDelta!.visibleAdded=[2];},value=>{value.patch.fogDelta!.visibleRemoved=[9];},value=>{value.patch.fogDelta!.visibleAdded=[4];},
      value=>{value.patch.fogDelta!.visibleAdded=[3,3];},value=>{value.patch.fogDelta!.exploredAdded=[2];},value=>{value.patch.fogDelta!.exploredAdded=[102400];},
      value=>{Object.assign(value.patch.fogDelta!,{hidden:[1]});},
    ];
    for(const change of cases){const bad=structuredClone(valid);change(bad);expect(()=>target.receive(bad,'blue')).toThrow();}
    const expected=view('blue',2);expected.fog={visible:[2,3],explored:[1,2,3]};expect(target.receive(valid,'blue')).toEqual(expected);
    target.reset(2);expect(()=>target.receive({...valid,generation:2},'blue')).toThrow('PROJECTION_BASE_MISMATCH');
  });
  it('carries native projection fog deltas through genuine opaque IPC with unchanged recipient views',async()=>{
    const source=new RecipientProjection(),target=receiver(),channel=new MessageChannel(),initial=view();initial.fog={visible:Array.from({length:80},(_,index)=>index),explored:Array.from({length:100},(_,index)=>index)};
    const next=view('blue',2);next.fog={visible:[...initial.fog.visible.slice(1),100],explored:[...initial.fog.explored,100]};
    try{
      for(const input of [initial,next]){
        source.begin();for(const entity of input.entities)source.entity(entity);const {entities:_entities,...fields}=input,handle=source.finishNative(fields);
        const pending=once(channel.port2,'message');postNativeProjection(handle,channel.port1,{generation:1,publicationRequest:0});
        const [packet]=await pending;if(input===next)expect(packet.transfer.patch.fogDelta).toEqual({visibleAdded:[100],visibleRemoved:[0],exploredAdded:[100]});
        expect(target.receive(packet.transfer,'blue')).toEqual(input);
      }
    }finally{channel.port1.close();channel.port2.close();}
  });
});

describe('preconstruction recipient credits',()=>{
  it('bounds six recipients to four reserved transfers and services waiting recipients before an early sender',()=>{
    const credits=new ProjectionCredits(),players=Array.from({length:6},(_,index)=>`p${index}`);credits.reset();credits.subscribe(players);
    expect(credits.eligible()).toEqual(players.slice(0,4));
    for(const player of players.slice(0,4))credits.reserve(player,1);
    expect(credits.eligible()).toEqual([]);expect(credits.inventory()).toMatchObject({active:4,pending:2,reservedBytes:128*1024*1024});
    for(let index=0;index<100;index++)credits.request(players);
    expect(credits.inventory()).toMatchObject({active:4,pending:6,reservedBytes:128*1024*1024});
    expect(credits.acknowledge('p0',1,1)).toBe(true);expect(credits.eligible()).toEqual(['p4']);
    expect(()=>credits.reserve('p0',2)).toThrow('PROJECTION_CREDIT_REQUIRED');credits.reserve('p4',1);
    credits.acknowledge('p1',1,1);expect(credits.eligible()).toEqual(['p5']);credits.reserve('p5',1);
    credits.acknowledge('p2',1,1);expect(credits.eligible()).toEqual(['p0']);
  });
  it('retains cancelled-generation byte reservations until exact old credits return',()=>{
    const credits=new ProjectionCredits(),players=['p0','p1','p2','p3'];credits.reset();credits.subscribe(players);
    for(const player of players)credits.reserve(player,1);
    expect(credits.reset()).toBe(2);credits.subscribe(players);
    expect(credits.inventory()).toMatchObject({active:4,retired:4,pending:4,reservedBytes:128*1024*1024});expect(credits.eligible()).toEqual([]);
    expect(credits.acknowledge('p0',1,999)).toBe(false);expect(credits.eligible()).toEqual([]);
    expect(credits.acknowledge('p0',1,1)).toBe(true);expect(credits.eligible()).toEqual(['p0']);credits.reserve('p0',1);
    expect(credits.acknowledge('p0',1,1)).toBe(false);expect(credits.inventory()).toMatchObject({active:4,retired:3});
    expect(()=>credits.acknowledge('p0',2,2)).toThrow('STALE_PROJECTION_CREDIT');expect(credits.acknowledge('p0',2,1)).toBe(true);
    for(const player of players.slice(1))expect(credits.acknowledge(player,1,1)).toBe(true);
    expect(credits.inventory()).toMatchObject({active:0,retired:0,reservedBytes:0});
    expect(()=>credits.subscribe([...players,...players])).toThrow('INVALID_PROJECTION_SUBSCRIBERS');
    expect(()=>credits.subscribe(Array.from({length:12},(_,index)=>`p${index}`))).toThrow('INVALID_PROJECTION_SUBSCRIBERS');
  });
});
