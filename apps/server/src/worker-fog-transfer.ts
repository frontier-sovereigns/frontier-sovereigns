/** Internal Node worker transport over already authorized projections.
 * Receiver trees belong exclusively to WorkerViewChannel, which exposes only opaque
 * capabilities. Public object offers continue through the original validation path. */
import { validatePlayerView, type PlayerView } from '@frontier/shared';
import { validatePlayerView as compiledView } from '../../../packages/shared/src/validators.generated.js';
import { protect } from '../../../packages/shared/src/validation-safety.js';
import { byId, consistent, SNAPSHOT_MAX_BYTES } from '../../../packages/shared/src/view-stream-kernel.js';

type Fog=PlayerView['fog'];
type Patch={visibleAdded:number[];visibleRemoved:number[];exploredAdded:number[]};
type Transfer={kind:'full';generation:number;token:number;view:PlayerView}|{kind:'fog';generation:number;token:number;baseToken:number;body:PlayerView;patch:Patch};
interface Base {token:number;identity:string;fog:Fog}
interface SenderRow {base?:Base;active?:{token:number;next?:Base};pending?:PlayerView}
function invalid():never{throw new Error('INVALID_SNAPSHOT');}
function checked(value:PlayerView|undefined,errors:readonly {keyword:string;instancePath:string}[]|null|undefined):PlayerView {if(value)return value;if(errors?.some(error=>error.keyword==='maxBytes'||error.keyword==='maxItems'&&error.instancePath==='/entities'))throw new Error('SNAPSHOT_TOO_LARGE');return invalid();}
const identity=(view:PlayerView)=>JSON.stringify([view.protocolVersion,view.contentHash,view.matchId,view.matchEpoch,view.playerId,view.map]);
const int=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
const exactKeys=(value:object,keys:string[])=>{const actual=Object.keys(value);return actual.length===keys.length&&actual.every((key,index)=>key===keys[index]);};
function canonical(values:unknown,cells:number):values is number[]{
  if(!Array.isArray(values)||values.length>102400||Object.getPrototypeOf(values)!==Array.prototype||Object.keys(values).length!==values.length)return false;
  for(let index=0;index<values.length;index++)if(!int(values[index])||values[index]>=cells||index>0&&values[index]<=values[index-1])return false;
  return true;
}
function subset(part:readonly number[],whole:readonly number[]):boolean {let index=0;for(const cell of part){while(index<whole.length&&whole[index]!<cell)index++;if(whole[index]!==cell)return false;}return true;}
function cellCount(view:PlayerView):number {if(!view?.map||typeof view.map!=='object')return 0;const columns=view.map.widthMm/view.map.fogCellMm,rows=view.map.heightMm/view.map.fogCellMm;return Number.isSafeInteger(columns)&&Number.isSafeInteger(rows)&&columns>0&&rows>0&&columns*rows<=102400?columns*rows:0;}
function delta(before:readonly number[],after:readonly number[]):{added:number[];removed:number[]} {
  const added:number[]=[],removed:number[]=[];let a=0,b=0;
  while(a<before.length&&b<after.length){if(before[a]!<after[b]!)removed.push(before[a++]!);else if(after[b]!<before[a]!)added.push(after[b++]!);else{a++;b++;}}
  while(a<before.length)removed.push(before[a++]!);while(b<after.length)added.push(after[b++]!);return {added,removed};
}
function patchArray(base:readonly number[],added:readonly number[],removed:readonly number[]):number[]{
  if(!added.length&&!removed.length)return base as number[];
  const result:number[]=[];let a=0,b=0,c=0;
  while(a<base.length||b<added.length){
    if(b<added.length&&(a===base.length||added[b]!<base[a]!)){if(c<removed.length&&removed[c]!<=added[b]!)invalid();result.push(added[b++]!);}
    else{const value=base[a++]!;if(b<added.length&&added[b]===value)invalid();if(c<removed.length&&removed[c]!<value)invalid();if(c<removed.length&&removed[c]===value)c++;else result.push(value);}
  }
  if(c!==removed.length||result.length>102400)invalid();return result;
}
const arrayBytes=(values:readonly number[])=>2+Math.max(0,values.length-1)+values.reduce((sum,value)=>sum+String(value).length,0);
/** At most one in-flight and one latest detached authorized target per recipient.
 * offer receives a fresh internally owned projection, never a public borrowed view.
 * Credit is gateway mirror application credit, independent of browser RTT. */
export class FogProducer {
  #rows=new Map<string,SenderRow>();#generation=1;#nonce=0;
  get generation():number{return this.#generation;}
  reset():number{this.#generation++;this.#rows.clear();return this.#generation;}
  inventory(){return {recipients:this.#rows.size,active:[...this.#rows.values()].filter(row=>row.active).length,pending:[...this.#rows.values()].filter(row=>row.pending).length};}
  offer(view:PlayerView):Transfer|undefined{
    if(!view||typeof view!=='object'||typeof view.playerId!=='string')invalid();
    let row=this.#rows.get(view.playerId);if(!row){if(this.#rows.size>=11)throw new Error('RECIPIENT_LIMIT');row={};this.#rows.set(view.playerId,row);}
    if(row.active){row.pending=view;return;}
    return this.#make(row,view);
  }
  acknowledge(playerId:string,generation:number,token:number):Transfer|undefined{
    const row=this.#rows.get(playerId);if(generation!==this.#generation||!row?.active||row.active.token!==token)throw new Error('STALE_FOG_CREDIT');
    row.base=row.active.next;row.active=undefined;const next=row.pending;row.pending=undefined;return next?this.#make(row,next):undefined;
  }
  #make(row:SenderRow,view:PlayerView):Transfer{
    const token=++this.#nonce,generation=this.#generation,cells=cellCount(view),fog=view.fog;
    const usable=!!cells&&!!fog&&exactKeys(fog,['visible','explored'])&&canonical(fog.visible,cells)&&canonical(fog.explored,cells)&&subset(fog.visible,fog.explored);
    if(!usable){row.active={token};return {kind:'full',generation,token,view};}
    let key:string;try{key=identity(view);}catch{row.active={token};return {kind:'full',generation,token,view};}const next={token,identity:key,fog:{visible:fog.visible.slice(),explored:fog.explored.slice()}};
    const before=row.base;
    if(!before||before.identity!==key){row.active={token,next};return {kind:'full',generation,token,view};}
    const visible=delta(before.fog.visible,fog.visible),explored=delta(before.fog.explored,fog.explored);
    row.active={token,next};if(explored.removed.length)return {kind:'full',generation,token,view};
    return {kind:'fog',generation,token,baseToken:before.token,body:{...view,fog:{visible:[],explored:[]}},patch:{visibleAdded:visible.added,visibleRemoved:visible.removed,exploredAdded:explored.added}};
  }
}
interface Mirror extends Base {generation:number;visibleBytes:number;exploredBytes:number;cells:number}
/** One mirror per channel, called only from its actual Worker message callback.
 * Returned trees are never mutated or exposed by that channel. */
export class FogReceiver {
  #mirrors=new Map<string,Mirror>();#generation=1;
  reset(generation:number):void{if(generation!==this.#generation+1)throw new Error('STALE_FOG_RESET');this.#generation=generation;this.#mirrors.clear();}
  clear():void{this.#mirrors.clear();}
  inventory(){return {recipients:this.#mirrors.size,cells:[...this.#mirrors.values()].reduce((sum,row)=>sum+row.fog.visible.length+row.fog.explored.length,0)};}
  receive(transfer:Transfer,expectedPlayerId:string):PlayerView{
    if(!transfer||!int(transfer.generation)||!int(transfer.token)||!['full','fog'].includes(transfer.kind))invalid();
    // A trusted lifecycle control resets both endpoints. Data cannot silently
    // advance one recipient into a different worker lifetime than the others.
    if(transfer.generation!==this.#generation)throw new Error('STALE_FOG_TRANSFER');
    if((transfer.kind==='full'?transfer.view:transfer.body)?.playerId!==expectedPlayerId)throw new Error('INVALID_SNAPSHOT_RECIPIENT');
    let view:PlayerView|undefined,visibleBytes:number,exploredBytes:number;
    if(transfer.kind==='full'){
      if(!exactKeys(transfer,['kind','generation','token','view']))invalid();
      view=checked(validatePlayerView.parseJson(JSON.stringify(transfer.view),SNAPSHOT_MAX_BYTES),validatePlayerView.errors);if(!consistent(view))invalid();
      view.entities.sort(byId);view.fog.visible.sort((a,b)=>a-b);view.fog.explored.sort((a,b)=>a-b);
      visibleBytes=arrayBytes(view.fog.visible);exploredBytes=arrayBytes(view.fog.explored);
    }else{
      if(!exactKeys(transfer,['kind','generation','token','baseToken','body','patch'])||!int(transfer.baseToken))invalid();
      const body=transfer.body,prior=body&&this.#mirrors.get(body.playerId),patch=transfer.patch;
      if(!prior||prior.generation!==transfer.generation||prior.token!==transfer.baseToken||transfer.token<=prior.token||!patch||!exactKeys(patch,['visibleAdded','visibleRemoved','exploredAdded']))invalid();
      for(const values of [patch.visibleAdded,patch.visibleRemoved,patch.exploredAdded])if(!canonical(values,prior.cells))invalid();
      const visible=patchArray(prior.fog.visible,patch.visibleAdded,patch.visibleRemoved),explored=patchArray(prior.fog.explored,patch.exploredAdded,[]);
      if(!subset(patch.visibleAdded,explored))invalid();
      visibleBytes=prior.visibleBytes+patch.visibleAdded.reduce((n,v)=>n+String(v).length,0)-patch.visibleRemoved.reduce((n,v)=>n+String(v).length,0)+Math.max(0,visible.length-1)-Math.max(0,prior.fog.visible.length-1);
      exploredBytes=prior.exploredBytes+patch.exploredAdded.reduce((n,v)=>n+String(v).length,0)+Math.max(0,explored.length-1)-Math.max(0,prior.fog.explored.length-1);
      // Existing safety+compiled schema inspect every non-fog value. Budgets reserve
      // exactly the omitted numeric leaves/UTF-8 bytes; placeholder container nodes remain.
      const strict=protect(compiledView as any,undefined,1000000-visible.length-explored.length);
      view=checked(strict.parseJson(JSON.stringify(body),SNAPSHOT_MAX_BYTES-visibleBytes-exploredBytes+4) as PlayerView|undefined,strict.errors);
      if(!view||!consistent(view)||!exactKeys(view.fog,['visible','explored'])||view.fog.visible.length||view.fog.explored.length||identity(view)!==prior.identity)invalid();
      view.entities.sort(byId);view.fog={visible,explored};
    }
    const key=view.playerId;if(!this.#mirrors.has(key)&&this.#mirrors.size>=11)throw new Error('RECIPIENT_LIMIT');
    const prior=this.#mirrors.get(key);if(prior&&(transfer.generation<prior.generation||transfer.generation===prior.generation&&transfer.token<=prior.token))throw new Error('STALE_FOG_TRANSFER');
    this.#mirrors.set(key,{generation:transfer.generation,token:transfer.token,identity:identity(view),fog:view.fog,visibleBytes:visibleBytes!,exploredBytes:exploredBytes!,cells:cellCount(view)});
    return view;
  }
}
export type {Transfer as FogTransfer};
