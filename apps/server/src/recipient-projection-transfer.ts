import { MAX_WORLD_ENTITIES,validatePlayerView, type PlayerView, type ViewEntity } from '@frontier/shared';
import { validatePlayerView as compiledView } from '../../../packages/shared/src/validators.generated.js';
import { protect } from '../../../packages/shared/src/validation-safety.js';
import { consistent, SNAPSHOT_MAX_BYTES } from '../../../packages/shared/src/view-stream-kernel.js';
import { applyProjectionFogDelta, type ProjectionPatch } from '../../../packages/simulation/src/recipient-projection.js';

export type ProjectionTransfer={generation:number;patch:ProjectionPatch};
export const PROJECTION_TRANSFER_MAX_BYTES=32*1024*1024;
const headerKeys=['protocolVersion','contentHash','matchId','matchEpoch','playerId','tick','sequence','status'] as const;
const fieldKeys=new Set<string>([...headerKeys,'rulesetId','maxAge','startingResourcePreset','simulationSpeed','publicationIntervalMs','committedTimeMs','frameRevision','authoritativeIntervalMs','map','self','players','fog','projectiles','effects','monuments','ageAnnouncements','result']);
const optionalKeys=new Set<string>(['rulesetId','maxAge','startingResourcePreset','simulationSpeed','publicationIntervalMs','committedTimeMs','frameRevision','authoritativeIntervalMs','projectiles','effects','monuments','ageAnnouncements','result']);
const integer=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
function invalid():never{throw new Error('INVALID_PROJECTION_TRANSFER');}
const keys=(value:unknown,required:readonly string[],optional:readonly string[]=[]):value is Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const actual=Object.keys(value);return required.every(key=>Object.hasOwn(value,key))&&actual.every(key=>required.includes(key)||optional.includes(key));
};
function uniqueStrings(value:unknown,limit=MAX_WORLD_ENTITIES):value is string[]{
  return Array.isArray(value)&&value.length<=limit&&value.every(id=>typeof id==='string'&&id.length>0&&id.length<=128)&&new Set(value).size===value.length;
}
/** Preserve the existing internal JSON lane's undefined/-0 semantics, but never
 * execute a getter/toJSON method or allocate an unbounded serialized transfer. */
function detachedTransfer(input:unknown):ProjectionTransfer {
  let remaining=2_000_000,encodedBytes=0;const ancestors=new Set<object>();
  const add=(bytes:number)=>{encodedBytes+=bytes;if(encodedBytes>PROJECTION_TRANSFER_MAX_BYTES)throw new Error('PROJECTION_TRANSFER_TOO_LARGE');};
  const stringBytes=(value:string)=>{
    let bytes=Buffer.byteLength(value)+2;
    for(let index=0;index<value.length;index++){
      const code=value.charCodeAt(index);
      if(code===34||code===92)bytes++;
      else if(code<32)bytes+=code===8||code===9||code===10||code===12||code===13?1:5;
      else if(code>=0xd800&&code<=0xdbff){const next=value.charCodeAt(index+1);if(next>=0xdc00&&next<=0xdfff)index++;else bytes+=3;}
      else if(code>=0xdc00&&code<=0xdfff)bytes+=3;
    }
    return bytes;
  };
  const walk=(value:unknown,depth:number):void=>{
    if(--remaining<0||depth>32)invalid();
    if(value===undefined)return;
    if(value===null){add(4);return;}
    if(typeof value==='string'){add(stringBytes(value));return;}
    if(typeof value==='number'){if(!Number.isFinite(value))invalid();add(String(value).length);return;}
    if(typeof value==='boolean'){add(value?4:5);return;}
    if(typeof value!=='object'||ancestors.has(value))invalid();
    const prototype=Object.getPrototypeOf(value);
    if(Array.isArray(value)){
      if(prototype!==Array.prototype||value.length>remaining||Object.keys(value).length!==value.length)invalid();
    }else if(prototype!==Object.prototype&&prototype!==null)invalid();
    if(Object.getOwnPropertySymbols(value).length)invalid();
    ancestors.add(value);add(2);let count=0;
    for(const key of Object.getOwnPropertyNames(value)){
      if(Array.isArray(value)&&key==='length')continue;
      if(Array.isArray(value)&&key!==String(count))invalid();
      if(key==='__proto__'||key==='constructor'||key==='prototype')invalid();
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(!descriptor||!('value'in descriptor)||!descriptor.enumerable)invalid();
      if(!Array.isArray(value)&&descriptor.value===undefined){if(--remaining<0)invalid();continue;}
      if(count++)add(1);
      if(!Array.isArray(value))add(stringBytes(key)+1);
      if(Array.isArray(value)&&descriptor.value===undefined){add(4);if(--remaining<0)invalid();}
      else walk(descriptor.value,depth+1);
    }
    ancestors.delete(value);
  };
  walk(input,0);const json=JSON.stringify(input);
  if(typeof json!=='string')invalid();
  if(Buffer.byteLength(json)>PROJECTION_TRANSFER_MAX_BYTES)throw new Error('PROJECTION_TRANSFER_TOO_LARGE');
  return JSON.parse(json) as ProjectionTransfer;
}
const fogArrayBytes=(values:readonly number[])=>2+Math.max(0,values.length-1)+values.reduce((sum,value)=>sum+String(value).length,0);
interface Base {revision:number;view:PlayerView;entities:Map<string,ViewEntity>;fogBytes:number}
/** Internal encoder owner only. Returned views are immutable owned publications;
 * callers must never edit them or expose their retained objects to other code.
 * No patch mutates a previously returned view or commits a partial invalid base. */
export class RecipientProjectionReceiver {
  private generation=0;
  private bases=new Map<string,Base>();
  reset(generation:number):void {
    if(!integer(generation)||generation<=this.generation)throw new Error('STALE_PROJECTION_RESET');
    this.generation=generation;this.bases.clear();
  }
  clear():void {this.bases.clear();}
  inventory(){return {generation:this.generation,recipients:this.bases.size,entities:[...this.bases.values()].reduce((total,base)=>total+base.entities.size,0)};}
  receive(input:ProjectionTransfer,expectedPlayerId:string):PlayerView {
    const transfer=detachedTransfer(input);
    if(!keys(transfer,['generation','patch'])||!integer(transfer.generation)||transfer.generation!==this.generation||this.generation===0)throw new Error('STALE_PROJECTION_TRANSFER');
    const patch=transfer.patch;
    if(!keys(patch,['revision','baseRevision','header','fields','removedFields','entities'],['fogDelta'])||!integer(patch.revision)||patch.revision===0||!integer(patch.baseRevision)||patch.revision<=patch.baseRevision)invalid();
    if(!keys(patch.header,headerKeys)||patch.header.playerId!==expectedPlayerId)throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    if(!keys(patch.fields,[],[...fieldKeys])||!uniqueStrings(patch.removedFields,optionalKeys.size)||patch.removedFields.some(key=>!optionalKeys.has(key)||Object.hasOwn(patch.fields,key)))invalid();
    if(!keys(patch.entities,['upserts','removed'],['order'])||!Array.isArray(patch.entities.upserts)||patch.entities.upserts.length>MAX_WORLD_ENTITIES||!uniqueStrings(patch.entities.removed))invalid();
    const ids=patch.entities.upserts.map(entity=>entity?.id);
    if(!uniqueStrings(ids)||ids.some(id=>patch.entities.removed.includes(id)))invalid();
    const prior=this.bases.get(expectedPlayerId);
    if(!prior&&this.bases.size>=11)throw new Error('RECIPIENT_LIMIT');
    if(patch.baseRevision!==0&&(!prior||prior.revision!==patch.baseRevision))throw new Error('PROJECTION_BASE_MISMATCH');
    if(prior&&patch.revision<=prior.revision)throw new Error('STALE_PROJECTION_TRANSFER');
    if(patch.baseRevision!==0&&['protocolVersion','contentHash','matchId','matchEpoch','playerId'].some(key=>patch.header[key as keyof typeof patch.header]!==prior!.view[key as keyof PlayerView]))throw new Error('PROJECTION_IDENTITY_MISMATCH');
    if(patch.baseRevision===0&&(patch.entities.removed.length||patch.removedFields.length||!patch.entities.order))invalid();
    const records=new Map<string,ViewEntity>(patch.baseRevision===0?[]:prior!.entities);
    for(const id of patch.entities.removed)if(!records.delete(id))invalid();
    for(const entity of patch.entities.upserts)records.set(entity.id,entity);
    if(records.size>MAX_WORLD_ENTITIES)throw new Error('SNAPSHOT_TOO_LARGE');
    const order=patch.entities.order??(patch.baseRevision===0?undefined:prior!.view.entities.map(entity=>entity.id));
    if(!uniqueStrings(order)||order.length!==records.size||order.some(id=>!records.has(id)))invalid();
    const fields:Record<string,unknown>=patch.baseRevision===0?{}:{...prior!.view};
    delete fields.entities;
    for(const key of patch.removedFields)delete fields[key];
    Object.assign(fields,patch.fields);
    if(Object.hasOwn(patch,'fogDelta')){
      if(!patch.baseRevision||!prior||Object.hasOwn(patch.fields,'fog')||Object.hasOwn(patch.fields,'map'))invalid();
      fields.fog=applyProjectionFogDelta(prior.view.fog,patch.fogDelta!,prior.view.map);
    }
    const view={...fields,entities:order.map(id=>records.get(id)!)} as unknown as PlayerView;
    if(headerKeys.some(key=>view[key]!==patch.header[key]))invalid();
    if(prior&&view.matchId===prior.view.matchId&&view.matchEpoch===prior.view.matchEpoch&&(view.tick<prior.view.tick||view.sequence<prior.view.sequence))throw new Error('STALE_PROJECTION_TRANSFER');
    if(patch.baseRevision!==0&&JSON.stringify(view.map)!==JSON.stringify(prior!.view.map))throw new Error('PROJECTION_IDENTITY_MISMATCH');
    let fogBytes:number;
    if(patch.baseRevision!==0&&!Object.hasOwn(patch.fields,'fog')){
      // Only the private, previously validated base can supply omitted fog. Its
      // numeric leaves remain charged to the complete schema safety budget, and
      // exact expanded bytes are charged before committing a new base. The empty
      // containers preserve depth; delta reconstruction checked every new cell,
      // ordering, bounds, disjointness and visible/explored containment above.
      fogBytes=prior!.fogBytes;
      if(patch.fogDelta){
        const delta=patch.fogDelta,digits=(values:readonly number[])=>values.reduce((sum,value)=>sum+String(value).length,0),commas=(length:number)=>Math.max(0,length-1);
        fogBytes+=digits(delta.visibleAdded)+digits(delta.exploredAdded)-digits(delta.visibleRemoved)
          +commas(view.fog.visible.length)-commas(prior!.view.fog.visible.length)+commas(view.fog.explored.length)-commas(prior!.view.fog.explored.length);
      }
      const shell={...view,fog:{visible:[],explored:[]}};
      if(Buffer.byteLength(JSON.stringify(shell))+fogBytes-4>SNAPSHOT_MAX_BYTES)throw new Error('SNAPSHOT_TOO_LARGE');
      const strict=protect(compiledView as any,undefined,1_000_000-view.fog.visible.length-view.fog.explored.length);
      if(!strict(shell)||!consistent(shell))invalid();
    }else{
      if(Buffer.byteLength(JSON.stringify(view))>SNAPSHOT_MAX_BYTES)throw new Error('SNAPSHOT_TOO_LARGE');
      if(!validatePlayerView(view)||!consistent(view))invalid();
      fogBytes=fogArrayBytes(view.fog.visible)+fogArrayBytes(view.fog.explored);
    }
    this.bases.set(expectedPlayerId,{revision:patch.revision,view,entities:records,fogBytes});
    return view;
  }
}
