import type { PlayerView, PlayerViewDelta, SnapshotChunk, DeltaChunk, ViewEntity } from './types.js';
import { sha256 } from './hash.js';
import { validateSnapshotChunk, validateDeltaChunk } from './validation.js';
import { resolveRuleset, units, buildings, technologies } from './content.js';

/** @internal Pure operations on already validated data, not a trust or ownership boundary.
 * Import only from internal implementations after strict capture/parse validation.
 * No helper retains input or returns borrowed mutable references. Not a package export.
 */
export const SNAPSHOT_CHUNK_BYTES=32768;
export const SNAPSHOT_MAX_CHUNKS=512;
export const SNAPSHOT_MAX_BYTES=SNAPSHOT_CHUNK_BYTES*SNAPSHOT_MAX_CHUNKS;
export const OWNED_ENTITY_FIELDS=['pendingConstruction','upgrade','weaponCooldowns','ammoAffordable','cargo','order','queue','gateMode','garrisoned','stance','garrisonedIn','rally','taskState','queuedOrderCount','blockedReason','farmerAssigned','demolitionTicksRemaining','forestIntentId','workTargetId'] as const;
/** Internal compatibility projection over validated private data. Preserve the
 * shared source for opted-in sockets and copy only entities that lose a field. */
export function withoutVisualTraces(view:PlayerView):PlayerView {
  if(!view.entities.some(entity=>Object.hasOwn(entity,'visualTrace')))return view;
  return {...view,entities:view.entities.map(entity=>{
    if(!Object.hasOwn(entity,'visualTrace'))return entity;
    const {visualTrace:_trace,...legacy}=entity;return legacy;
  })};
}
export const byId=(a:{id:string},b:{id:string})=>a.id<b.id?-1:a.id>b.id?1:0;
export const numbers=(values:Iterable<number>)=>[...values].sort((a,b)=>a-b);
export const unique=(values:readonly (string|number)[])=>new Set(values).size===values.length;
export const identity=(view:Pick<PlayerView,'protocolVersion'|'contentHash'|'matchId'|'matchEpoch'|'playerId'>)=>[view.protocolVersion,view.contentHash,view.matchId,view.matchEpoch,view.playerId].join('|');
/** Inputs here already passed strict JSON/schema validation; key order is immaterial. */
export function sameJson(a:unknown,b:unknown):boolean {
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)){if(!Array.isArray(b)||a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!sameJson(a[i],b[i]))return false;return true;}
  if(Array.isArray(b))return false;
  const keys=Object.keys(a);if(keys.length!==Object.keys(b).length)return false;
  for(const key of keys)if(!Object.hasOwn(b,key)||!sameJson((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key]))return false;
  return true;
}
function validFog(visible:readonly number[],explored:readonly number[],cells:number):boolean {
  const ascending=(values:readonly number[])=>values.every((value,index)=>index===0||value>values[index-1]!);
  if(ascending(visible)&&ascending(explored)){
    if((explored.at(-1)??0)>=cells)return false;let cursor=0;
    for(const cell of visible){while(cursor<explored.length&&explored[cursor]!<cell)cursor++;if(explored[cursor]!==cell)return false;}return true;
  }
  if(!unique(visible)||!unique(explored))return false;const known=new Set(explored);
  return explored.every(cell=>cell<cells)&&visible.every(cell=>known.has(cell));
}
export function consistent(view:PlayerView):boolean {
  const maxAge=view.maxAge??(view.rulesetId==='legendary_ages_v1'?8:4);
  if(view.self.age>maxAge||view.players.some(player=>(player.age??1)>maxAge)||(view.self.technologies??[]).some(id=>technologies[id]!.minAge>maxAge))return false;
  if(view.rulesetId!==undefined){try{if(resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).contentHash!==view.contentHash)return false;}catch{return false;}}
  const columns=view.map.widthMm/view.map.fogCellMm,rows=view.map.heightMm/view.map.fogCellMm,cells=columns*rows;
  if(!Number.isSafeInteger(columns)||!Number.isSafeInteger(rows)||cells>102400||!unique(view.entities.map(entity=>entity.id))||!unique(view.players.map(player=>player.id))||!validFog(view.fog.visible,view.fog.explored,cells))return false;
  return view.entities.every(entity=>(entity.visualAge??1)<=maxAge&&!((entity.kind==='unit'?units[entity.typeId]:entity.kind==='building'?buildings[entity.typeId]:undefined)?.minAge!>maxAge)&&entity.xMm<=view.map.widthMm&&entity.zMm<=view.map.heightMm&&(entity.ownerId===view.playerId||(OWNED_ENTITY_FIELDS.every(field=>!Object.hasOwn(entity,field))&&!entity.ward?.supportId&&!entity.windup?.aim)))&&unique((view.effects??[]).map(effect=>effect.id))&&unique((view.projectiles??[]).map(projectile=>projectile.id));
}
/** Linear differences for the preparation scope's owned, strictly ascending, unique arrays. */
function sortedFogDifference(base:PlayerView['fog'],next:PlayerView['fog']):PlayerViewDelta['fog'] {
  const visibleAdded:number[]=[],visibleRemoved:number[]=[],exploredAdded:number[]=[];
  let before=0,after=0;
  while(before<base.visible.length&&after<next.visible.length){
    const oldCell=base.visible[before]!,newCell=next.visible[after]!;
    if(oldCell<newCell){visibleRemoved.push(oldCell);before++;}
    else if(newCell<oldCell){visibleAdded.push(newCell);after++;}
    else{before++;after++;}
  }
  while(before<base.visible.length)visibleRemoved.push(base.visible[before++]!);
  while(after<next.visible.length)visibleAdded.push(next.visible[after++]!);
  before=0;after=0;
  while(before<base.explored.length&&after<next.explored.length){
    const oldCell=base.explored[before]!,newCell=next.explored[after]!;
    if(oldCell<newCell)throw new Error('INVALID_DELTA_FOG');
    if(newCell<oldCell){exploredAdded.push(newCell);after++;}
    else{before++;after++;}
  }
  if(before<base.explored.length)throw new Error('INVALID_DELTA_FOG');
  while(after<next.explored.length)exploredAdded.push(next.explored[after++]!);
  return {visibleAdded,visibleRemoved,exploredAdded};
}
export function deltaFromValidatedViews(base:PlayerView,next:PlayerView,normalized=false):PlayerViewDelta {
  return structuredClone(borrowedDeltaFromValidatedViews(base,next,normalized));
}
/** Internal intermediate, never exported: clone or synchronously encode before returning. */
function borrowedDeltaFromValidatedViews(base:PlayerView,next:PlayerView,normalized=false):PlayerViewDelta {
  if(identity(base)!==identity(next)||next.sequence<=base.sequence||next.tick<base.tick||!sameJson(base.map,next.map))throw new Error('INVALID_DELTA_BOUNDARY');
  const creates:ViewEntity[]=[],updates:ViewEntity[]=[],conceals:string[]=[],removals:string[]=[];
  const observedDeaths=new Set((next.effects??[]).filter(effect=>effect.kind==='death'&&effect.entityId).map(effect=>effect.entityId!));
  const remove=(entity:ViewEntity)=>{
    if(entity.ownerId===next.playerId||entity.kind!=='unit'||observedDeaths.has(entity.id))removals.push(entity.id);else conceals.push(entity.id);
  };
  if(normalized){
    // Only private preparation supplies strictly ID-sorted, unique entity arrays.
    let before=0,after=0;
    while(before<base.entities.length&&after<next.entities.length){
      const prior=base.entities[before]!,entity=next.entities[after]!;
      if(prior.id<entity.id){remove(prior);before++;}
      else if(entity.id<prior.id){creates.push(entity);after++;}
      else{if(!sameJson(prior,entity))updates.push(entity);before++;after++;}
    }
    while(before<base.entities.length)remove(base.entities[before++]!);
    while(after<next.entities.length)creates.push(next.entities[after++]!);
  }else{
    const before=new Map(base.entities.map(entity=>[entity.id,entity])),after=new Map(next.entities.map(entity=>[entity.id,entity]));
    for(const entity of next.entities){const prior=before.get(entity.id);if(!prior)creates.push(entity);else if(!sameJson(prior,entity))updates.push(entity);}
    for(const entity of base.entities)if(!after.has(entity.id))remove(entity);
    creates.sort(byId);updates.sort(byId);conceals.sort();removals.sort();
  }
  let fog:PlayerViewDelta['fog'];
  if(normalized)fog=sortedFogDifference(base.fog,next.fog);
  else{
    const visible=new Set(base.fog.visible),nextVisible=new Set(next.fog.visible),explored=new Set(base.fog.explored),nextExplored=new Set(next.fog.explored);
    if(base.fog.explored.some(cell=>!nextExplored.has(cell)))throw new Error('INVALID_DELTA_FOG');
    fog={visibleAdded:numbers(next.fog.visible.filter(cell=>!visible.has(cell))),visibleRemoved:numbers(base.fog.visible.filter(cell=>!nextVisible.has(cell))),exploredAdded:numbers(next.fog.explored.filter(cell=>!explored.has(cell)))};
  }
  const {entities:_entities,fog:_fog,...header}=next;
  return {...header,baseSequence:base.sequence,creates,updates,conceals,removals,fog};
}
export function encodeDeltaMessageFromValidatedViews(base:PlayerView,next:PlayerView,normalized=false):string {
  return JSON.stringify({type:'delta',delta:borrowedDeltaFromValidatedViews(base,next,normalized)});
}
export function encode(bytes:Uint8Array):string {let text='';for(const byte of bytes)text+=String.fromCharCode(byte);return btoa(text);}
export function chunksFromNormalizedView(view:PlayerView,transferId:string):SnapshotChunk[] {
  const text=JSON.stringify(view),bytes=new TextEncoder().encode(text);
  if(bytes.length>SNAPSHOT_MAX_BYTES)throw new Error('SNAPSHOT_TOO_LARGE');
  const count=Math.ceil(bytes.length/SNAPSHOT_CHUNK_BYTES),hash=sha256(text);
  const result=Array.from({length:count},(_,index):SnapshotChunk=>({type:'snapshot_chunk',transferId,protocolVersion:view.protocolVersion,contentHash:view.contentHash,matchId:view.matchId,matchEpoch:view.matchEpoch,playerId:view.playerId,sequence:view.sequence,index,count,byteLength:bytes.length,sha256:hash,data:encode(bytes.subarray(index*SNAPSHOT_CHUNK_BYTES,(index+1)*SNAPSHOT_CHUNK_BYTES))}));
  if(result.some(chunk=>!validateSnapshotChunk(chunk)))throw new Error('INVALID_SNAPSHOT_TRANSFER');return result;
}
/** Internal encoder reuse: scopes already validated and serialized the delta.
 * Chunk only its JSON body, without reparsing or exposing a borrowed view tree. */
export function chunksFromEncodedDeltaMessage(message:string,boundary:Pick<DeltaChunk,'protocolVersion'|'contentHash'|'matchId'|'matchEpoch'|'playerId'|'sequence'|'baseSequence'>,transferId:string):DeltaChunk[] {
  const prefix='{"type":"delta","delta":';
  if(!message.startsWith(prefix)||!message.endsWith('}'))throw new Error('INVALID_DELTA_TRANSFER');
  const text=message.slice(prefix.length,-1);if(text.length>SNAPSHOT_MAX_BYTES)throw new Error('DELTA_TOO_LARGE');
  const bytes=new TextEncoder().encode(text);if(bytes.length>SNAPSHOT_MAX_BYTES)throw new Error('DELTA_TOO_LARGE');
  const count=Math.ceil(bytes.length/SNAPSHOT_CHUNK_BYTES);if(count<1||count>SNAPSHOT_MAX_CHUNKS)throw new Error('INVALID_DELTA_TRANSFER');
  const hash=sha256(text),chunks=Array.from({length:count},(_,index):DeltaChunk=>({type:'delta_chunk',transferId,protocolVersion:boundary.protocolVersion,contentHash:boundary.contentHash,matchId:boundary.matchId,matchEpoch:boundary.matchEpoch,playerId:boundary.playerId,sequence:boundary.sequence,baseSequence:boundary.baseSequence,index,count,byteLength:bytes.length,sha256:hash,data:encode(bytes.subarray(index*SNAPSHOT_CHUNK_BYTES,(index+1)*SNAPSHOT_CHUNK_BYTES))}));
  if(chunks.some(chunk=>!validateDeltaChunk(chunk)))throw new Error('INVALID_DELTA_TRANSFER');return chunks;
}
