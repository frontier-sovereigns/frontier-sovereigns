import type { PlayerView, PlayerViewDelta, SnapshotChunk, DeltaChunk } from './types.js';
import { MAX_WORLD_ENTITIES } from './types.js';
import { canonicalJson, sha256 } from './hash.js';
import { buildings } from './content.js';
import { validatePlayerView, validatePlayerViewDelta, validateSnapshotChunk, validateDeltaChunk } from './validation.js';
import { byId, numbers, unique, identity, sameJson, consistent, withoutVisualTraces, deltaFromValidatedViews, encodeDeltaMessageFromValidatedViews, encode, chunksFromNormalizedView, chunksFromEncodedDeltaMessage, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_CHUNKS, SNAPSHOT_MAX_BYTES } from './view-stream-kernel.js';
export { SNAPSHOT_CHUNK_BYTES, SNAPSHOT_MAX_CHUNKS, SNAPSHOT_MAX_BYTES, OWNED_ENTITY_FIELDS } from './view-stream-kernel.js';

export const SNAPSHOT_ASSEMBLY_TIMEOUT_MS=10000;
export function validateConsistentPlayerView(value:unknown):value is PlayerView{return validatePlayerView(value)&&consistent(value);}
/** Stable public ordering has no relationship to private entity creation order. */
export function normalizePlayerView(view:PlayerView):PlayerView {
  const copy=structuredClone(view);copy.entities.sort(byId);copy.fog.visible.sort((a,b)=>a-b);copy.fog.explored.sort((a,b)=>a-b);return copy;
}
export function createViewDelta(base:PlayerView,next:PlayerView):PlayerViewDelta {
  if(!validatePlayerView(base)||!validatePlayerView(next)||!consistent(base)||!consistent(next))throw new Error('INVALID_DELTA_BOUNDARY');
  return deltaFromValidatedViews(base,next);
}
/** Coalesced publication may skip intermediate paid upgrades. Accept only the
 * declared upward chain on the same static footprint, never a replacement unit,
 * unrelated structure, relocated building or ownership transfer. */
function legalStructureUpgrade(prior:PlayerView['entities'][number],next:PlayerView['entities'][number]):boolean{
  if(prior.kind!=='building'||next.kind!=='building'||prior.ownerId!==next.ownerId||prior.xMm!==next.xMm||prior.zMm!==next.zMm||(prior.rotation??0)!==(next.rotation??0))return false;
  let target=buildings[next.typeId];const source=buildings[prior.typeId];if(!target||!source)return false;
  for(let stages=0;stages<8&&target.upgradeFrom;stages++){
    const previous=buildings[target.upgradeFrom];
    if(!previous||previous.footprintCells.some((extent,index)=>extent!==target!.footprintCells[index]))return false;
    if(previous.id===source.id)return true;
    target=previous;
  }
  return false;
}
/** Failed or stale deltas leave the caller's previous view untouched. */
export function applyViewDelta(base:PlayerView,delta:PlayerViewDelta):PlayerView|undefined {
  if(!validatePlayerView(base)||!validatePlayerViewDelta(delta)||!consistent(base)||identity(base)!==identity(delta)||delta.baseSequence!==base.sequence||delta.sequence<=delta.baseSequence||delta.tick<base.tick||!sameJson(base.map,delta.map)||delta.self.lastCommandSequence<base.self.lastCommandSequence)return undefined;
  const ids=[...delta.creates.map(entity=>entity.id),...delta.updates.map(entity=>entity.id),...delta.conceals,...delta.removals];if(!unique(ids))return undefined;
  const entities=new Map(base.entities.map(entity=>[entity.id,entity]));
  for(const entity of delta.creates){if(entities.has(entity.id))return undefined;entities.set(entity.id,entity);}
  for(const entity of delta.updates){const prior=entities.get(entity.id);if(!prior||prior.kind!==entity.kind||prior.ownerId!==entity.ownerId||prior.typeId!==entity.typeId&&!legalStructureUpgrade(prior,entity))return undefined;entities.set(entity.id,entity);}
  const observedDeaths=new Set((delta.effects??[]).filter(effect=>effect.kind==='death'&&effect.entityId).map(effect=>effect.entityId!));
  for(const id of delta.conceals){const prior=entities.get(id);if(!prior||prior.kind!=='unit'||prior.ownerId===base.playerId)return undefined;entities.delete(id);}
  for(const id of delta.removals){const prior=entities.get(id);if(!prior||(prior.kind==='unit'&&prior.ownerId!==base.playerId&&!observedDeaths.has(id)))return undefined;entities.delete(id);}
  const visible=new Set(base.fog.visible),explored=new Set(base.fog.explored);
  if(!unique([...delta.fog.visibleAdded,...delta.fog.visibleRemoved])||!unique(delta.fog.exploredAdded))return undefined;
  for(const cell of delta.fog.visibleRemoved){if(!visible.delete(cell))return undefined;}
  for(const cell of delta.fog.visibleAdded){if(visible.has(cell))return undefined;visible.add(cell);}
  for(const cell of delta.fog.exploredAdded){if(explored.has(cell))return undefined;explored.add(cell);}
  const {baseSequence:_baseSequence,creates:_creates,updates:_updates,conceals:_conceals,removals:_removals,fog:_fog,...header}=delta;
  const next:PlayerView={...header,entities:[...entities.values()].sort(byId),fog:{visible:numbers(visible),explored:numbers(explored)}};
  return validatePlayerView(next)&&consistent(next)?structuredClone(next):undefined;
}
function decode(text:string):Uint8Array {const raw=atob(text),result=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)result[i]=raw.charCodeAt(i);if(encode(result)!==text)throw new Error('NON_CANONICAL_BASE64');return result;}
export function chunkView(view:PlayerView,transferId:string):SnapshotChunk[] {
  if(view.entities.length>MAX_WORLD_ENTITIES)throw new Error('SNAPSHOT_TOO_LARGE');
  if(!validatePlayerView(view)||!consistent(view))throw new Error('INVALID_SNAPSHOT');
  return chunksFromNormalizedView(normalizePlayerView(view),transferId);
}
export function chunkViewDelta(delta:PlayerViewDelta,transferId:string):DeltaChunk[] {
  const captured=validatePlayerViewDelta.capture(delta,{enumerableOnly:true});
  if(!captured||captured.sequence<=captured.baseSequence)throw new Error('INVALID_DELTA');
  return chunksFromEncodedDeltaMessage(JSON.stringify({type:'delta',delta:captured}),captured,transferId);
}

declare const preparedViewBrand: unique symbol;
/** Runtime authority comes only from a scope's private WeakMap, never this compile-time brand. */
export interface PreparedViewHandle { readonly [preparedViewBrand]: true }
export type PreparedViewBoundary=Readonly<Pick<PlayerView,'protocolVersion'|'contentHash'|'matchId'|'matchEpoch'|'playerId'|'sequence'|'tick'>>;
export interface PreparedViewScope {
  prepare(input:unknown):PreparedViewHandle;
  prepareJson(text:unknown):PreparedViewHandle;
  boundary(handle:PreparedViewHandle):PreparedViewBoundary;
  delta(base:PreparedViewHandle,next:PreparedViewHandle):PlayerViewDelta;
  /** Immutable wire envelope; never exposes references to the scope's owned snapshots. */
  encodeDeltaMessage(base:PreparedViewHandle,next:PreparedViewHandle):string;
  chunks(handle:PreparedViewHandle,transferId:string):SnapshotChunk[];
}
/** One recipient's detached snapshots. No method exposes owned data or trusts a caller-owned object. */
export function createPreparedViewScope(options:{visualTraces?:boolean}={}):PreparedViewScope {
  const entries=new WeakMap<PreparedViewHandle,{view:PlayerView;boundary:PreparedViewBoundary}>();
  let recipient:string|undefined;
  const read=(handle:PreparedViewHandle)=>{const entry=entries.get(handle);if(!entry)throw new Error('INVALID_PREPARED_VIEW');return entry;};
  const retain=(view:PlayerView|undefined):PreparedViewHandle=>{
    if(!view){
      if(validatePlayerView.errors?.some(error=>error.keyword==='maxBytes'||(error.keyword==='maxItems'&&error.instancePath==='/entities')))throw new Error('SNAPSHOT_TOO_LARGE');
      throw new Error('INVALID_SNAPSHOT');
    }
    if(!consistent(view))throw new Error('INVALID_SNAPSHOT');
    if(recipient!==undefined&&view.playerId!==recipient)throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    if(options.visualTraces===false)view=withoutVisualTraces(view);
    // Capture or parsing owns every nested object; normalization cannot mutate a caller.
    view.entities.sort(byId);view.fog.visible.sort((a,b)=>a-b);view.fog.explored.sort((a,b)=>a-b);
    const handle=Object.freeze(Object.create(null)) as PreparedViewHandle;
    const {protocolVersion,contentHash,matchId,matchEpoch,playerId,sequence,tick}=view;
    const boundary=Object.freeze({protocolVersion,contentHash,matchId,matchEpoch,playerId,sequence,tick});
    entries.set(handle,{view,boundary});recipient=playerId;return handle;
  };
  return Object.freeze({
    prepare(input:unknown):PreparedViewHandle {
      // Required nonenumerable fields would validate but disappear during JSON encoding.
      return retain(validatePlayerView.capture(input,{enumerableOnly:true}));
    },
    prepareJson(text:unknown):PreparedViewHandle{return retain(validatePlayerView.parseJson(text,SNAPSHOT_MAX_BYTES));},
    boundary(handle:PreparedViewHandle):PreparedViewBoundary{return read(handle).boundary;},
    delta(base:PreparedViewHandle,next:PreparedViewHandle):PlayerViewDelta{return deltaFromValidatedViews(read(base).view,read(next).view,true);},
    encodeDeltaMessage(base:PreparedViewHandle,next:PreparedViewHandle):string{return encodeDeltaMessageFromValidatedViews(read(base).view,read(next).view,true);},
    chunks(handle:PreparedViewHandle,transferId:string):SnapshotChunk[]{return chunksFromNormalizedView(read(handle).view,transferId);},
  });
}
export type SnapshotAssemblyResult={status:'pending'}|{status:'complete';view:PlayerView}|{status:'rejected';code:string};
interface Assembly {metadata:Omit<SnapshotChunk,'index'|'data'>;startedMs:number;chunks:Map<number,Uint8Array>;bytes:number}
/** One bounded transfer; no allocation is sized from an unvalidated peer field. */
export class SnapshotAssembler {
  private active:Assembly|undefined;
  reset():void{this.active=undefined;}
  expire(nowMs:number):boolean {if(this.active&&nowMs-this.active.startedMs>=SNAPSHOT_ASSEMBLY_TIMEOUT_MS){this.reset();return true;}return false;}
  push(chunk:SnapshotChunk,nowMs:number):SnapshotAssemblyResult {
    const reject=(code:string):SnapshotAssemblyResult=>{this.reset();return {status:'rejected',code};};
    if(!Number.isFinite(nowMs)||nowMs<0||!validateSnapshotChunk(chunk))return reject('INVALID_SNAPSHOT_CHUNK');
    if(this.expire(nowMs))return reject('SNAPSHOT_TIMEOUT');
    if(chunk.index>=chunk.count||chunk.count!==Math.ceil(chunk.byteLength/SNAPSHOT_CHUNK_BYTES))return reject('INVALID_SNAPSHOT_LENGTH');
    const {index,data,...metadata}=chunk;
    if(this.active&&canonicalJson(metadata)!==canonicalJson(this.active.metadata)){
      const prior=this.active.metadata,sameRecipient=identity(metadata)===identity(prior);
      // An explicitly newer full snapshot can overtake the tail of a resync
      // already on the wire. Stale tail chunks must not destroy the new assembly.
      if(sameRecipient&&metadata.sequence<prior.sequence)return {status:'pending'};
      if(sameRecipient&&metadata.transferId!==prior.transferId&&metadata.sequence>prior.sequence&&index===0)this.reset();
      else return reject('SNAPSHOT_TRANSFER_MISMATCH');
    }
    let bytes:Uint8Array;try{bytes=decode(data);}catch{return reject('INVALID_SNAPSHOT_ENCODING');}
    const expected=index===chunk.count-1?chunk.byteLength-index*SNAPSHOT_CHUNK_BYTES:SNAPSHOT_CHUNK_BYTES;if(bytes.length!==expected)return reject('INVALID_SNAPSHOT_LENGTH');
    const assembly=this.active??{metadata,startedMs:nowMs,chunks:new Map<number,Uint8Array>(),bytes:0};this.active=assembly;
    const prior=assembly.chunks.get(index);if(prior){if(prior.length!==bytes.length||prior.some((byte,i)=>byte!==bytes[i]))return reject('SNAPSHOT_DUPLICATE_CONFLICT');return {status:'pending'};}
    if(assembly.bytes+bytes.length>SNAPSHOT_MAX_BYTES)return reject('SNAPSHOT_TOO_LARGE');assembly.chunks.set(index,bytes);assembly.bytes+=bytes.length;
    if(assembly.chunks.size!==chunk.count)return {status:'pending'};
    if(assembly.bytes!==chunk.byteLength)return reject('INVALID_SNAPSHOT_LENGTH');
    const full=new Uint8Array(assembly.bytes);for(let i=0;i<chunk.count;i++){const part=assembly.chunks.get(i);if(!part)return reject('INCOMPLETE_SNAPSHOT');full.set(part,i*SNAPSHOT_CHUNK_BYTES);}
    try{
      const text=new TextDecoder('utf-8',{fatal:true}).decode(full);if(sha256(text)!==chunk.sha256)return reject('SNAPSHOT_CHECKSUM_MISMATCH');
      const view:unknown=JSON.parse(text);if(!validatePlayerView(view)||!consistent(view)||identity(view)!==identity(chunk)||view.sequence!==chunk.sequence)return reject('INVALID_SNAPSHOT');
      this.reset();return {status:'complete',view:normalizePlayerView(view)};
    }catch{return reject('INVALID_SNAPSHOT');}
  }
}

export type DeltaAssemblyResult={status:'pending'}|{status:'complete';delta:PlayerViewDelta}|{status:'rejected';code:string};
interface DeltaAssembly {metadata:Omit<DeltaChunk,'index'|'data'>;startedMs:number;chunks:Map<number,Uint8Array>;bytes:number}
/** One bounded delta transfer, with the same byte/count/deadline limits as a
 * snapshot. Completion validates the document but never mutates its base view. */
export class DeltaAssembler {
  private active:DeltaAssembly|undefined;
  reset():void{this.active=undefined;}
  expire(nowMs:number):boolean {if(this.active&&nowMs-this.active.startedMs>=SNAPSHOT_ASSEMBLY_TIMEOUT_MS){this.reset();return true;}return false;}
  push(chunk:DeltaChunk,nowMs:number):DeltaAssemblyResult {
    const reject=(code:string):DeltaAssemblyResult=>{this.reset();return {status:'rejected',code};};
    if(!Number.isFinite(nowMs)||nowMs<0||!validateDeltaChunk(chunk))return reject('INVALID_DELTA_CHUNK');
    if(this.expire(nowMs))return reject('DELTA_TIMEOUT');
    if(chunk.index>=chunk.count||chunk.count!==Math.ceil(chunk.byteLength/SNAPSHOT_CHUNK_BYTES))return reject('INVALID_DELTA_LENGTH');
    const {index,data,...metadata}=chunk;
    if(this.active&&canonicalJson(metadata)!==canonicalJson(this.active.metadata)){
      const prior=this.active.metadata,sameRecipient=identity(metadata)===identity(prior);
      if(sameRecipient&&metadata.sequence<prior.sequence)return {status:'pending'};
      // A sender may coalesce a newer delta against the same completed base.
      // A different base requires client resynchronization, never partial apply.
      if(sameRecipient&&metadata.baseSequence===prior.baseSequence&&metadata.transferId!==prior.transferId&&metadata.sequence>prior.sequence&&index===0)this.reset();
      else return reject('DELTA_TRANSFER_MISMATCH');
    }
    let bytes:Uint8Array;try{bytes=decode(data);}catch{return reject('INVALID_DELTA_ENCODING');}
    const expected=index===chunk.count-1?chunk.byteLength-index*SNAPSHOT_CHUNK_BYTES:SNAPSHOT_CHUNK_BYTES;if(bytes.length!==expected)return reject('INVALID_DELTA_LENGTH');
    const assembly=this.active??{metadata,startedMs:nowMs,chunks:new Map<number,Uint8Array>(),bytes:0};this.active=assembly;
    const prior=assembly.chunks.get(index);if(prior){if(prior.length!==bytes.length||prior.some((byte,i)=>byte!==bytes[i]))return reject('DELTA_DUPLICATE_CONFLICT');return {status:'pending'};}
    if(assembly.bytes+bytes.length>SNAPSHOT_MAX_BYTES)return reject('DELTA_TOO_LARGE');assembly.chunks.set(index,bytes);assembly.bytes+=bytes.length;
    if(assembly.chunks.size!==chunk.count)return {status:'pending'};
    if(assembly.bytes!==chunk.byteLength)return reject('INVALID_DELTA_LENGTH');
    const full=new Uint8Array(assembly.bytes);for(let i=0;i<chunk.count;i++){const part=assembly.chunks.get(i);if(!part)return reject('INCOMPLETE_DELTA');full.set(part,i*SNAPSHOT_CHUNK_BYTES);}
    try{
      const text=new TextDecoder('utf-8',{fatal:true}).decode(full);if(sha256(text)!==chunk.sha256)return reject('DELTA_CHECKSUM_MISMATCH');
      const delta:unknown=JSON.parse(text);if(!validatePlayerViewDelta(delta)||identity(delta)!==identity(chunk)||delta.sequence!==chunk.sequence||delta.baseSequence!==chunk.baseSequence||delta.sequence<=delta.baseSequence)return reject('INVALID_DELTA');
      this.reset();return {status:'complete',delta};
    }catch{return reject('INVALID_DELTA');}
  }
}
