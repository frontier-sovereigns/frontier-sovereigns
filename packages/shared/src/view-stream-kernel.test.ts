import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import { applyViewDelta, chunkView, contentHash, createPreparedViewScope, createViewDelta, SnapshotAssembler, SNAPSHOT_CHUNK_BYTES, type PlayerView, type PlayerViewDelta, type SnapshotChunk, type ViewEntity } from './index.js';

function entity(id:string,ownerId='enemy'):ViewEntity {
  return {id,ownerId,kind:'unit',typeId:'militia',hp:55,maxHp:55,xMm:4000,zMm:4000};
}
function fixture(large=false):PlayerView {
  return {protocolVersion:2,contentHash,matchId:'kernel_wire',matchEpoch:4,playerId:'me',tick:2,sequence:5,status:'RUNNING',
    map:{widthMm:640000,heightMm:640000,fogCellMm:2000},
    self:{lastCommandSequence:7,resources:{food:50,wood:50,gold:0,stone:0},age:1,population:1,populationCap:15,populationLimit:120,reservedPopulation:0},
    players:[{id:'me',name:'\u73a9\u5bb6 \ud83c\udff0',teamId:'blue',color:'#abcdef',kind:'human'}],
    entities:[{...entity('own','me'),cargo:{resource:'gold',amount:3}},entity('concealed_enemy'),{...entity('memory'),kind:'building',typeId:'house',ghost:true,lastSeenTick:1}],
    fog:{visible:[2,1],explored:large?Array.from({length:102400},(_,index)=>102399-index):[2,0,1]},effects:[],projectiles:[]};
}
/** Independent wire oracle: expected order is written from the fixture, not production normalization. */
function expectedNormalized(input:PlayerView):PlayerView {
  return {...input,entities:[input.entities[1]!,input.entities[2]!,input.entities[0]!],
    fog:{visible:[1,2],explored:input.fog.explored.length>3?Array.from({length:102400},(_,index)=>index):[0,1,2]}};
}
/** Node's independent UTF-8/base64/hash primitives provide exact byte expectations. */
function expectedChunks(input:PlayerView,transferId:string):SnapshotChunk[] {
  const text=JSON.stringify(input),bytes=Buffer.from(text,'utf8'),hash=createHash('sha256').update(text,'utf8').digest('hex');
  const count=Math.ceil(bytes.length/32768),chunks:SnapshotChunk[]=[];
  for(let index=0;index<count;index++)chunks.push({type:'snapshot_chunk',transferId,protocolVersion:input.protocolVersion,contentHash:input.contentHash,
    matchId:input.matchId,matchEpoch:input.matchEpoch,playerId:input.playerId,sequence:input.sequence,index,count,byteLength:bytes.length,sha256:hash,
    data:bytes.subarray(index*32768,Math.min(bytes.length,(index+1)*32768)).toString('base64')});
  return chunks;
}
describe('extracted encoding kernel public-boundary oracle',()=>{
  it.each([false,true])('retains exact fixed-transfer-ID UTF-8 chunk bytes (large=%s)',large=>{
    expect(SNAPSHOT_CHUNK_BYTES).toBe(32768);
    const input=fixture(large),expected=expectedNormalized(input),transferId='kernel_fixed_transfer',wire=expectedChunks(expected,transferId);
    expect(large?wire.length>1:wire.length===1).toBe(true);
    expect(chunkView(input,transferId)).toEqual(wire);
    for(const lane of ['capture','json'] as const){
      const scope=createPreparedViewScope(),prepared=lane==='capture'?scope.prepare(input):scope.prepareJson(JSON.stringify(input));
      expect(scope.chunks(prepared,transferId).map(chunk=>JSON.stringify(chunk))).toEqual(wire.map(chunk=>JSON.stringify(chunk)));
      const assembler=new SnapshotAssembler();
      for(const [index,chunk] of wire.entries()){
        const assembled=assembler.push(chunk,0);
        expect(assembled).toEqual(index===wire.length-1?{status:'complete',view:expected}:{status:'pending'});
      }
    }
  });
  it.each([false,true])('retains exact delta bytes, private captures and visible-death classification (observed=%s)',observed=>{
    const base=fixture(),own={...base.entities[0]!,xMm:5000,cargo:{resource:'gold' as const,amount:4}},created=entity('new_visible');
    const next:PlayerView={...structuredClone(base),sequence:6,tick:4,entities:[own,created],fog:{visible:[3,2],explored:[3,0,2,1]},
      effects:observed?[{id:'death_seen',kind:'death',tick:4,entityId:'concealed_enemy',typeId:'militia',xMm:4000,zMm:4000}]:[]};
    const {entities:_entities,fog:_fog,...header}=next;
    const expected:PlayerViewDelta={...header,baseSequence:5,creates:[created],updates:[own],conceals:observed?[]:['concealed_enemy'],
      removals:observed?['concealed_enemy','memory']:['memory'],fog:{visibleAdded:[3],visibleRemoved:[1],exploredAdded:[3]}};
    const expectedText=JSON.stringify({type:'delta',delta:expected}),expectedView={...next,entities:[created,own],fog:{visible:[2,3],explored:[0,1,2,3]}};
    expect(JSON.stringify({type:'delta',delta:createViewDelta(base,next)})).toBe(expectedText);
    for(const lane of ['capture','json'] as const){
      const scope=createPreparedViewScope(),prepare=(value:PlayerView)=>lane==='capture'?scope.prepare(value):scope.prepareJson(JSON.stringify(value));
      const before=prepare(base),after=prepare(next);
      expect(scope.encodeDeltaMessage(before,after)).toBe(expectedText);
      expect(applyViewDelta(base,JSON.parse(expectedText).delta)).toEqual(expectedView);
      const delta=scope.delta(before,after);delta.updates[0]!.cargo!.amount=999;delta.self.resources.food=0;
      expect(scope.encodeDeltaMessage(before,after)).toBe(expectedText);
    }
  });
  it('keeps hostile public object handling and caller mutation outside the retained tree',()=>{
    let reads=0;
    const accessor=fixture();Object.defineProperty(accessor.self.resources,'gold',{get(){reads++;throw new Error('must not run');}});
    expect(()=>createPreparedViewScope().prepare(accessor)).toThrow('INVALID_SNAPSHOT');expect(reads).toBe(0);
    const nonenumerable=fixture();Object.defineProperty(nonenumerable.entities[0]!,'id',{enumerable:false});
    expect(()=>createPreparedViewScope().prepare(nonenumerable)).toThrow('INVALID_SNAPSHOT');
    const source=fixture(),expected=expectedChunks(expectedNormalized(structuredClone(source)),'kernel_alias'),raw=source.entities[0]!;
    source.entities[0]=new Proxy(raw,{get(){reads++;throw new Error('must not run');}});
    const scope=createPreparedViewScope(),prepared=scope.prepare(source);
    raw.cargo!.amount=999;source.fog.explored.length=0;source.self.resources.food=999;
    expect(scope.chunks(prepared,'kernel_alias')).toEqual(expected);expect(reads).toBe(0);
    const output=scope.chunks(prepared,'kernel_alias');output[0]!.data='changed';
    expect(scope.chunks(prepared,'kernel_alias')).toEqual(expected);
  });
  it('does not add public trusted-object or borrowed-reference kernel exports',()=>{
    for(const name of ['consistent','borrowedDeltaFromValidatedViews','deltaFromValidatedViews','encodeDeltaMessageFromValidatedViews','chunksFromNormalizedView','prepareOwned']){
      expect(name in publicApi).toBe(false);
    }
    const scope=createPreparedViewScope();
    expect('prepareOwned' in scope).toBe(false);
  });
});
