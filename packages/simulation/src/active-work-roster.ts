import type {Entity, Unit} from './state.js';

export type WorkSleep = 'inert'|'travel'|'pending'|'deposit';
interface Watches {targets:string[];cells:number[];ownerId:string;sleep?:WorkSleep}
const schedulingCounts={created:0,visits:0,sleeps:0,contacts:0};
const count=(key:keyof typeof schedulingCounts)=>{if(schedulingCounts[key]<Number.MAX_SAFE_INTEGER)schedulingCounts[key]++;};

/** Privately owned work membership. The bitset changes scheduling only, never
 * world state, actor order, job arithmetic, path service or command authority.
 * All jobs start awake. Native mutation hooks may wake an earlier actor, but it
 * is visited only in the NEXT work pass, matching scalar actor iteration. */
export class ActiveWorkRoster {
  readonly units:readonly Unit[];
  private readonly indexes=new Map<string,number>();
  private readonly active:Uint32Array;
  private readonly generations:Uint32Array;
  private readonly watches=new Map<number,Watches>();
  private readonly targets=new Map<string,Set<number>>();
  private readonly cells=new Map<string,Map<number,Set<number>>>();
  private readonly deposits=new Set<number>();
  private subscriptions=0;
  private readonly subscriptionLimit=2200*20;

  private constructor(readonly actors:readonly Entity[],public frame:number,units:Unit[]){
    count('created');
    this.units=units;this.active=new Uint32Array(Math.ceil(units.length/32));this.generations=new Uint32Array(units.length);
    for(let i=0;i<units.length;i++){this.indexes.set(units[i]!.id,i);this.enable(i);}
  }
  static create(actors:readonly Entity[],frame:number):ActiveWorkRoster|undefined{
    const units=actors.filter((entity):entity is Unit=>entity.kind==='unit');
    // A malformed/custom world retains the existing scalar implementation.
    if(units.length>2200||new Set(units.map(unit=>unit.id)).size!==units.length)return;
    return new ActiveWorkRoster(actors,frame,units);
  }
  /** Detached, bounded development counters; never state or activity credit. */
  static diagnostics(){return {...schedulingCounts};}
  recordContact():void{count('contacts');}
  private enable(index:number):void{this.active[index>>>5]!|=1<<(index&31);}
  private disable(index:number):void{this.active[index>>>5]!&=~(1<<(index&31));}
  private invalidate(index:number):void{this.generations[index]=this.generations[index]!+1;this.enable(index);}
  generation(unitId:string):number|undefined{const index=this.indexes.get(unitId);return index===undefined?undefined:this.generations[index];}
  /** Reload each word after yielding: a later actor woken by depletion during
   * this pass must run now; an already visited actor must never run twice. */
  *due():IterableIterator<Unit>{
    for(let word=0;word<this.active.length;word++){
      let visited=0;
      while(true){
        const bits=this.active[word]!&~visited;if(!bits)break;
        const low=bits&-bits,bit=31-Math.clz32(low),index=word*32+bit;
        visited|=(2**(bit+1)-1)>>>0;
        const unit=this.units[index];if(unit){count('visits');yield unit;}
      }
    }
  }
  wake(unitId:string):void{const index=this.indexes.get(unitId);if(index!==undefined)this.invalidate(index);}
  wakeTarget(id:string):void{for(const index of this.targets.get(id)??[])this.invalidate(index);}
  wakeOwner(ownerId:string):void{for(const [index,watch]of this.watches)if(watch.ownerId===ownerId)this.invalidate(index);}
  wakeDeposits():void{for(const index of this.deposits)this.invalidate(index);}
  wakeAll():void{for(let i=0;i<this.units.length;i++)this.invalidate(i);}
  /** Frame-local sleep proofs expire at the boundary; gathering contacts remain
   * active and recheck their live cargo, target, visibility and geometry. Keep
   * their subscriptions/generations instead of reconstructing every worker. */
  beginFrame(frame:number):void{if(this.frame!==frame){this.frame=frame;this.wakeSleeping();}}
  wakeSleeping():void{for(const [index,watch]of this.watches)if(watch.sleep)this.invalidate(index);}
  sleeping(unitId:string):WorkSleep|undefined{const index=this.indexes.get(unitId);return index===undefined?undefined:this.watches.get(index)?.sleep;}
  private release(index:number):void{
    const prior=this.watches.get(index);if(!prior)return;
    for(const id of prior.targets){const set=this.targets.get(id)!;set.delete(index);if(!set.size)this.targets.delete(id);this.subscriptions--;}
    const owner=this.cells.get(prior.ownerId);
    for(const cell of prior.cells){const set=owner?.get(cell);set?.delete(index);if(!set?.size)owner?.delete(cell);this.subscriptions--;}
    if(!owner?.size)this.cells.delete(prior.ownerId);
    this.deposits.delete(index);this.watches.delete(index);
  }
  /** Watch only the authorized target footprint cells that can change the
   * established decision. No hidden enemy metadata or future path result enters
   * these records. Overflow keeps this actor active instead of losing work. */
  watch(unit:Unit,targetIds:readonly string[],fogCells:readonly number[],sleep?:WorkSleep):boolean{
    const index=this.indexes.get(unit.id);if(index===undefined||this.units[index]!==unit)return false;
    const prior=this.watches.get(index);
    if(prior&&prior.ownerId===unit.ownerId&&prior.sleep===sleep&&prior.targets.length===targetIds.length&&prior.cells.length===fogCells.length&&prior.targets.every((id,i)=>id===targetIds[i])&&prior.cells.every((cell,i)=>cell===fogCells[i])){
      if(sleep){this.disable(index);count('sleeps');}else this.enable(index);return true;
    }
    const targets=[...new Set(targetIds)],cells=[...new Set(fogCells)];
    this.release(index);
    if(targets.length>2||cells.length>18||this.subscriptions+targets.length+cells.length>this.subscriptionLimit){this.enable(index);return false;}
    const watch:Watches={targets,cells,ownerId:unit.ownerId,...(sleep?{sleep}:{})};this.watches.set(index,watch);
    for(const id of targets){let set=this.targets.get(id);if(!set){set=new Set();this.targets.set(id,set);}set.add(index);this.subscriptions++;}
    let owner=this.cells.get(unit.ownerId);if(!owner){owner=new Map();this.cells.set(unit.ownerId,owner);}
    for(const cell of cells){let set=owner.get(cell);if(!set){set=new Set();owner.set(cell,set);}set.add(index);this.subscriptions++;}
    if(sleep==='deposit')this.deposits.add(index);
    if(sleep){this.disable(index);count('sleeps');}else this.enable(index);
    return true;
  }
  /** Called after a committed visibility result, before the next work phase.
   * Reading only subscribed cells is bounded by jobs, not the whole map. */
  observeVisibility(ownerId:string,before:Uint8Array|undefined,after:Uint8Array):void{
    if(before===after)return;
    const cells=this.cells.get(ownerId);if(!cells)return;
    if(!before||before.length!==after.length){this.wakeOwner(ownerId);return;}
    for(const [cell,indexes]of cells)if(before[cell]!==after[cell])for(const index of indexes)this.invalidate(index);
  }
}
