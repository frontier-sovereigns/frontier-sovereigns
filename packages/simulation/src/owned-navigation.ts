import { MAX_WORLD_ENTITIES, type Position } from '@frontier/shared';
import { types as nodeTypes } from 'node:util';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from './navigation.js';

const CACHE_CAPACITY=8192;
const MAX_OWNED_OBSTACLES=MAX_WORLD_ENTITIES+4096;
const ownedObstacles=new WeakSet<Obstacle>();
interface CachedQuery {answer:boolean;cost?:number}
interface PackedObstacle {ordinal:number;id:string;values:Float64Array;offset:number}
interface QueryScratch {seen:Uint32Array;generation:number;active:boolean}
interface RecordOwner {parent?:RecordOwner;records:Map<Obstacle,PackedObstacle>}
interface OwnedGeometry {
  widthMm:number;heightMm:number;obstacles:Obstacle[];queries:Map<number,CachedQuery>;
  recordOwner:RecordOwner;recordCount:number;
  buckets:Map<number|string,readonly PackedObstacle[]>;inheritedBuckets?:ReadonlyMap<number|string,readonly PackedObstacle[]>;scratch:QueryScratch;
}

/** Capture each distinct mutable source once. Already-owned immutable references
 * can be reused by overlays without losing their original identity aliases. */
function captureObstacles(obstacles:readonly Obstacle[]):Obstacle[]{
  const copies=new Map<Obstacle,Obstacle>(),result=obstacles.map(obstacle=>{
    if(ownedObstacles.has(obstacle))return obstacle;
    let copy=copies.get(obstacle);
    if(!copy){copy=Object.freeze({...obstacle});copies.set(obstacle,copy);ownedObstacles.add(copy);}
    return copy;
  });
  Object.freeze(result);return result;
}
function bucketKey(x:number,z:number):number|string{return x>=-4096&&x<4096&&z>=-4096&&z<4096?z*8192+x:`${x},${z}`;}
function existingRecord(owner:RecordOwner|undefined,obstacle:Obstacle):PackedObstacle|undefined {
  for(;owner;owner=owner.parent){const record=owner.records.get(obstacle);if(record)return record;}
}
/** Buckets preserve the generic insertion order. An overlay shares immutable
 * base records and unchanged buckets, copying only buckets it appends to. */
function geometry(widthMm:number,heightMm:number,obstacles:Obstacle[],parent?:OwnedGeometry,additional=obstacles):OwnedGeometry {
  const records=new Map<Obstacle,PackedObstacle>(),inheritedBuckets=parent?.inheritedBuckets??parent?.buckets,buckets=new Map<number|string,readonly PackedObstacle[]>(parent?.inheritedBuckets?parent.buckets:undefined),changed=new Map<number|string,PackedObstacle[]>(),values=new Float64Array(additional.length*5);
  let recordCount=parent?.recordCount??0,offset=0;
  for(const obstacle of additional){
    let record=records.get(obstacle)??existingRecord(parent?.recordOwner,obstacle);
    if(!record){
      values[offset]=obstacle.xMm;values[offset+1]=obstacle.zMm;values[offset+2]=obstacle.halfWidth;values[offset+3]=obstacle.halfHeight;values[offset+4]=obstacle.circle?1:0;
      record=Object.freeze({ordinal:recordCount++,id:obstacle.id,values,offset});records.set(obstacle,record);offset+=5;
    }
    for(let z=Math.floor((obstacle.zMm-obstacle.halfHeight)/8000);z<=Math.floor((obstacle.zMm+obstacle.halfHeight)/8000);z++)for(let x=Math.floor((obstacle.xMm-obstacle.halfWidth)/8000);x<=Math.floor((obstacle.xMm+obstacle.halfWidth)/8000);x++){
      const key=bucketKey(x,z);let bucket=changed.get(key);if(!bucket){bucket=[...(buckets.get(key)??inheritedBuckets?.get(key)??[])];changed.set(key,bucket);buckets.set(key,bucket);}bucket.push(record);
    }
  }
  for(const bucket of changed.values())Object.freeze(bucket);
  return Object.freeze({widthMm,heightMm,obstacles,queries:new Map<number,CachedQuery>(),recordOwner:Object.freeze({parent:parent?.recordOwner,records}),recordCount,buckets,inheritedBuckets,scratch:{seen:new Uint32Array(recordCount),generation:0,active:false}});
}

/** A revision has no parent geometry: untouched immutable records/buckets may
 * be shared, but removed records and old query caches are not retained by it. */
function reviseGeometry(prior:OwnedGeometry,obstacles:Obstacle[]):OwnedGeometry|undefined {
  if(prior.inheritedBuckets||prior.recordOwner.parent||obstacles.length>MAX_OWNED_OBSTACLES)return;
  const oldOrder=new Map<Obstacle,number>(),nextOrder=new Map<Obstacle,number>();
  for(let index=0;index<prior.obstacles.length;index++){
    const obstacle=prior.obstacles[index]!;if(oldOrder.has(obstacle))return;oldOrder.set(obstacle,index);
  }
  const added:Obstacle[]=[],removed:Obstacle[]=[];let previous=-1;
  for(let index=0;index<obstacles.length;index++){
    const obstacle=obstacles[index]!;if(nextOrder.has(obstacle))return;nextOrder.set(obstacle,index);
    const ordinal=oldOrder.get(obstacle);
    // Relative order determines exact early-exit and budget charges. A reorder
    // deliberately takes the existing complete constructor.
    if(ordinal===undefined)added.push(obstacle);else{if(ordinal<=previous)return;previous=ordinal;}
  }
  for(const obstacle of prior.obstacles)if(!nextOrder.has(obstacle))removed.push(obstacle);
  if(added.length+removed.length>256||prior.recordCount+added.length>Math.min(MAX_OWNED_OBSTACLES*2,Math.max(1024,obstacles.length*2)))return;
  const changed=new Set<number|string>(),additions=new Map<number|string,PackedObstacle[]>(),records=new Map<Obstacle,PackedObstacle>(),order=new Map<PackedObstacle,number>(),values=new Float64Array(added.length*5);
  let recordCount=prior.recordCount,offset=0;
  for(let index=0;index<obstacles.length;index++){
    const obstacle=obstacles[index]!;
    let record=prior.recordOwner.records.get(obstacle);
    if(!record){
      values[offset]=obstacle.xMm;values[offset+1]=obstacle.zMm;values[offset+2]=obstacle.halfWidth;values[offset+3]=obstacle.halfHeight;values[offset+4]=obstacle.circle?1:0;
      record=Object.freeze({ordinal:recordCount++,id:obstacle.id,values,offset});offset+=5;
    }
    records.set(obstacle,record);order.set(record,index);
  }
  const cells=(obstacle:Obstacle,record?:PackedObstacle):boolean=>{
    const x0=Math.floor((obstacle.xMm-obstacle.halfWidth)/8000),x1=Math.floor((obstacle.xMm+obstacle.halfWidth)/8000),z0=Math.floor((obstacle.zMm-obstacle.halfHeight)/8000),z1=Math.floor((obstacle.zMm+obstacle.halfHeight)/8000);
    if(![x0,x1,z0,z1].every(Number.isSafeInteger)||x1<x0||z1<z0||(x1-x0+1)*(z1-z0+1)>4096)return false;
    for(let z=z0;z<=z1;z++)for(let x=x0;x<=x1;x++){
      const key=bucketKey(x,z);changed.add(key);if(changed.size>4096)return false;
      if(record){const bucket=additions.get(key)??[];bucket.push(record);additions.set(key,bucket);}
    }
    return true;
  };
  for(const obstacle of removed)if(!cells(obstacle))return;
  for(const obstacle of added)if(!cells(obstacle,records.get(obstacle)!))return;
  const buckets=new Map(prior.buckets);
  for(const key of changed){
    const bucket=(prior.buckets.get(key)??[]).filter(record=>order.has(record));
    bucket.push(...(additions.get(key)??[]));bucket.sort((a,b)=>order.get(a)!-order.get(b)!);
    if(bucket.length)buckets.set(key,Object.freeze(bucket));else buckets.delete(key);
  }
  return Object.freeze({widthMm:prior.widthMm,heightMm:prior.heightMm,obstacles,queries:new Map<number,CachedQuery>(),recordOwner:Object.freeze({records}),recordCount,buckets,scratch:{seen:new Uint32Array(recordCount),generation:0,active:false}});
}

interface RevisionCapture {obstacles:Obstacle[];copies:Map<Obstacle,Obstacle>}
/** Bindings belong to one immutable navigation owner. Ordinary mutable factory
 * callers never acquire one and still take their complete snapshot on each call. */
const revisionCaptures=new WeakMap<Navigation,RevisionCapture>();
function captureRevision(obstacles:Obstacle[],prior?:RevisionCapture):RevisionCapture|undefined {
  if(nodeTypes.isProxy(obstacles)||!Array.isArray(obstacles)||Object.getPrototypeOf(obstacles)!==Array.prototype||!Object.isFrozen(obstacles)||obstacles.length>MAX_OWNED_OBSTACLES)return;
  const copies=new Map<Obstacle,Obstacle>(),captured:Obstacle[]=[];
  for(let index=0;index<obstacles.length;index++){
    const slot=Object.getOwnPropertyDescriptor(obstacles,String(index));if(!slot||!('value'in slot))return;
    const source=slot.value as Obstacle;
    if(!source||typeof source!=='object'||nodeTypes.isProxy(source)||copies.has(source))return;
    let copy=prior?.copies.get(source);
    if(!copy){
      if(Object.getPrototypeOf(source)!==Object.prototype||!Object.isFrozen(source))return;
      const fields=Object.getOwnPropertyDescriptors(source),keys=Reflect.ownKeys(source);
      if(keys.some(key=>typeof key!=='string'||!['id','xMm','zMm','halfWidth','halfHeight','circle'].includes(key)))return;
      if(keys.some(key=>!('value'in fields[key as string]!))||typeof fields.id?.value!=='string')return;
      if(!['xMm','zMm','halfWidth','halfHeight'].every(key=>typeof fields[key]?.value==='number'&&Number.isFinite(fields[key]!.value)))return;
      if(fields.circle&&typeof fields.circle.value!=='boolean')return;
      copy=Object.freeze({...source});ownedObstacles.add(copy);
    }
    copies.set(source,copy);captured.push(copy);
  }
  Object.freeze(captured);return {obstacles:captured,copies};
}

function boundedCollisionInteger(value:number):boolean{return Number.isInteger(value)&&value>=-1000000&&value<=1000000;}
function chargeWork(budget:NavigationWorkBudget|undefined):void{if(!budget)return;if(budget.remaining<=0)throw new PathBudgetExceededError();budget.remaining--;budget.used++;}
function hitsCircle(fromX:number,fromZ:number,dx:number,dz:number,length2:number,x:number,z:number,radius:number):boolean{
  const t=length2?Math.max(0,Math.min(1,((x-fromX)*dx+(z-fromZ)*dz)/length2)):0;
  return Math.hypot(fromX+dx*t-x,fromZ+dz*t-z)<radius;
}
function hitsRectangle(fromX:number,fromZ:number,dx:number,dz:number,left:number,top:number,right:number,bottom:number):boolean{
  let enter=0,leave=1;
  if(dx===0){if(fromX<=left||fromX>=right)return false;}else{const a=(left-fromX)/dx,b=(right-fromX)/dx;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
  if(dz===0){if(fromZ<=top||fromZ>=bottom)return false;}else{const a=(top-fromZ)/dz,b=(bottom-fromZ)/dz;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
  return enter<leave;
}
/** Whole-metre queries retain their positive keys. Quarter-metre local searches
 * use a disjoint negative domain, bounded below by -26,864,521,216. Other query
 * forms retain the generic geometry path. Both domains are exact safe integers. */
function queryKey(point:Position,radius:number,ignoredId:string|undefined,cellMm:number):number|undefined {
  if(ignoredId!==undefined||!Number.isInteger(radius)||radius<=0||radius>=4096||point.xMm<0||point.xMm>640000||point.zMm<0||point.zMm>640000)return undefined;
  if(point.xMm%1000===0&&point.zMm%1000===0)return (radius*641+point.zMm/1000)*641+point.xMm/1000;
  if(cellMm===250&&point.xMm%250===0&&point.zMm%250===0)return -1-((radius*2561+point.zMm/250)*2561+point.xMm/250);
  return undefined;
}
/** Ordered one-metre cardinal sweeps occupy a third, disjoint safe-integer
 * domain above2^32. Reverse sweeps can encounter obstructions in another order
 * and therefore must retain their own exact work charge. */
function lineKey(from:Position,to:Position,radius:number,ignoredId:string|undefined):number|undefined {
  const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,direction=dx===1000&&dz===0?0:dx===-1000&&dz===0?1:dx===0&&dz===1000?2:dx===0&&dz===-1000?3:-1;
  if(direction<0||to.xMm<0||to.xMm>640000||to.zMm<0||to.zMm>640000)return;
  const start=queryKey(from,radius,ignoredId,1000);return start===undefined?undefined:2**32+start*4+direction;
}
function exactBudget(budget:NavigationWorkBudget):boolean{return Number.isSafeInteger(budget.remaining)&&budget.remaining>=0&&Number.isSafeInteger(budget.used)&&budget.used>=0&&Number.isSafeInteger(budget.remaining+budget.used);}
function consume(budget:NavigationWorkBudget,cost:number):void {
  if(cost===0)return;
  if(budget.remaining<cost){const remaining=budget.remaining;if(remaining>0){budget.remaining=0;budget.used+=remaining;}throw new PathBudgetExceededError();}
  budget.remaining-=cost;budget.used+=cost;
}

/** Generic Navigation has no cache branch or extra counters. Only this explicit
 * immutable owner can reuse answers; neither cache nor ownership enters saves. */
class OwnedNavigation extends Navigation {
  readonly #geometry:OwnedGeometry;
  constructor(owned:OwnedGeometry,maxSearchNodes:number,cellMm:number,workBudget?:NavigationWorkBudget){
    super(owned.widthMm,owned.heightMm,owned.obstacles,maxSearchNodes,cellMm,workBudget);
    this.#geometry=owned;Object.freeze(this.obstacles);Object.freeze(this);
  }
  protected override populateBuckets():void {}
  /** Preserve the public generic constructor's optional base argument. Normal
   * owned overlays use packed buckets directly and never materialize this bridge. */
  protected override *bucketEntries():IterableIterator<[number|string,Obstacle[]]> {
    const originals=new Map<PackedObstacle,Obstacle>();
    for(let owner:RecordOwner|undefined=this.#geometry.recordOwner;owner;owner=owner.parent)for(const [obstacle,record]of owner.records)originals.set(record,obstacle);
    const {buckets,inheritedBuckets}=this.#geometry;
    if(inheritedBuckets)for(const [key,bucket]of inheritedBuckets)yield [key,(buckets.get(key)??bucket).map(record=>originals.get(record)!)];
    for(const [key,bucket]of buckets)if(!inheritedBuckets?.has(key))yield [key,bucket.map(record=>originals.get(record)!)];
  }
  protected freeUncached(point:Position,radius:number,ignoredId?:string):boolean {
    if(point.xMm<radius||point.zMm<radius||point.xMm>this.widthMm-radius||point.zMm>this.heightMm-radius)return false;
    const budget=this.workBudget,{buckets,inheritedBuckets}=this.#geometry;
    for(let z=Math.floor((point.zMm-radius)/8000);z<=Math.floor((point.zMm+radius)/8000);z++)for(let x=Math.floor((point.xMm-radius)/8000);x<=Math.floor((point.xMm+radius)/8000);x++){
      chargeWork(budget);const key=bucketKey(x,z),bucket=buckets.get(key)??inheritedBuckets?.get(key);if(!bucket)continue;
      for(const obstacle of bucket){
        chargeWork(budget);if(obstacle.id===ignoredId)continue;
        const values=obstacle.values,offset=obstacle.offset,ox=values[offset]!,oz=values[offset+1]!,halfWidth=values[offset+2]!,halfHeight=values[offset+3]!;
        if(values[offset+4]){if(Math.hypot(point.xMm-ox,point.zMm-oz)<halfWidth+radius)return false;continue;}
        const dx=Math.max(0,Math.abs(point.xMm-ox)-halfWidth),dz=Math.max(0,Math.abs(point.zMm-oz)-halfHeight);
        if(radius?dx*dx+dz*dz<radius*radius:Math.abs(point.xMm-ox)<halfWidth&&Math.abs(point.zMm-oz)<halfHeight)return false;
      }
    }
    return true;
  }
  protected clearLineUncached(from:Position,to:Position,radius:number,ignoredId?:string):boolean {
    if(!this.free(from,radius,ignoredId)||!this.free(to,radius,ignoredId))return false;
    const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length2=dx*dx+dz*dz,budget=this.workBudget,{buckets,inheritedBuckets}=this.#geometry,shared=this.#geometry.scratch;
    const bounded=radius>=0&&boundedCollisionInteger(radius)&&boundedCollisionInteger(from.xMm)&&boundedCollisionInteger(from.zMm)&&boundedCollisionInteger(to.xMm)&&boundedCollisionInteger(to.zMm);
    const sweptLeft=Math.min(from.xMm,to.xMm)-radius,sweptRight=Math.max(from.xMm,to.xMm)+radius,sweptTop=Math.min(from.zMm,to.zMm)-radius,sweptBottom=Math.max(from.zMm,to.zMm)+radius;
    // Queries are synchronous. Reentrant budget accessors still receive isolated
    // scratch; partial failures always release the reusable primary scratch.
    const scratch=shared.active?{seen:new Uint32Array(this.#geometry.recordCount),generation:0,active:false}:shared;
    if(scratch.generation===0xffffffff){scratch.seen.fill(0);scratch.generation=0;}
    const generation=++scratch.generation,seen=scratch.seen;scratch.active=true;
    try{
      for(let z=Math.floor((Math.min(from.zMm,to.zMm)-radius)/8000);z<=Math.floor((Math.max(from.zMm,to.zMm)+radius)/8000);z++)for(let x=Math.floor((Math.min(from.xMm,to.xMm)-radius)/8000);x<=Math.floor((Math.max(from.xMm,to.xMm)+radius)/8000);x++){
        chargeWork(budget);const key=bucketKey(x,z),bucket=buckets.get(key)??inheritedBuckets?.get(key);if(!bucket)continue;
        for(const obstacle of bucket){
          if(obstacle.id===ignoredId||seen[obstacle.ordinal]===generation)continue;seen[obstacle.ordinal]=generation;chargeWork(budget);
          const values=obstacle.values,offset=obstacle.offset,ox=values[offset]!,oz=values[offset+1]!,halfWidth=values[offset+2]!,halfHeight=values[offset+3]!;
          // Charge and mark exactly as the scalar sweep before rejecting bounds.
          // Strict separation and bounded integers preserve tangency and all
          // fractional/large/malformed fallbacks. Generic mutable readers do not
          // use this shortcut; these fields were captured by the geometry owner.
          const extentZ=values[offset+4]?halfWidth:halfHeight;
          if(bounded&&halfWidth>=0&&extentZ>=0&&boundedCollisionInteger(halfWidth)&&boundedCollisionInteger(extentZ)&&boundedCollisionInteger(ox)&&boundedCollisionInteger(oz)&&(ox+halfWidth<sweptLeft||ox-halfWidth>sweptRight||oz+extentZ<sweptTop||oz-extentZ>sweptBottom))continue;
          if(values[offset+4]){if(hitsCircle(from.xMm,from.zMm,dx,dz,length2,ox,oz,radius+halfWidth))return false;continue;}
          const left=ox-halfWidth,right=ox+halfWidth,top=oz-halfHeight,bottom=oz+halfHeight;
          if(hitsRectangle(from.xMm,from.zMm,dx,dz,left-radius,top,right+radius,bottom)||hitsRectangle(from.xMm,from.zMm,dx,dz,left,top-radius,right,bottom+radius)||(radius>0&&(hitsCircle(from.xMm,from.zMm,dx,dz,length2,left,top,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,right,top,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,left,bottom,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,right,bottom,radius))))return false;
        }
      }
      return true;
    }finally{scratch.active=false;}
  }
  override free(point:Position,radius:number,ignoredId?:string):boolean {
    const key=queryKey(point,radius,ignoredId,this.cellMm),budget=this.workBudget;
    if(key===undefined||budget&&!exactBudget(budget))return this.freeUncached(point,radius,ignoredId);
    const queries=this.#geometry.queries,prior=queries.get(key);
    if(prior&&(!budget||prior.cost!==undefined)){if(budget)consume(budget,prior.cost!);return prior.answer;}
    const usedBefore=budget?.used,answer=this.freeUncached(point,radius,ignoredId);
    // A partial budget failure throws above and never creates or updates a key.
    // Unbudgeted misses need no charge counter; a later admitted query learns
    // its cost through the unchanged, bounded algorithm on successful completion.
    const entry:CachedQuery={answer,...(budget?{cost:budget.used-usedBefore!}:{})};
    if(!prior&&queries.size>=CACHE_CAPACITY)queries.delete(queries.keys().next().value!);
    queries.set(key,entry);return answer;
  }
  override clearLine(from:Position,to:Position,radius:number,ignoredId?:string):boolean {
    const key=lineKey(from,to,radius,ignoredId),budget=this.workBudget;
    if(key===undefined||budget&&!exactBudget(budget))return this.clearLineUncached(from,to,radius,ignoredId);
    const queries=this.#geometry.queries,prior=queries.get(key);
    if(prior&&(!budget||prior.cost!==undefined)){if(budget)consume(budget,prior.cost!);return prior.answer;}
    const usedBefore=budget?.used,answer=this.clearLineUncached(from,to,radius,ignoredId);
    // Endpoint checks and the sweep are one completed query. Partial failures
    // never populate this key; nested free answers retain their exact charges.
    const entry:CachedQuery={answer,...(budget?{cost:budget.used-usedBefore!}:{})};
    if(!queries.has(key)&&queries.size>=CACHE_CAPACITY)queries.delete(queries.keys().next().value!);
    queries.set(key,entry);return answer;
  }
  revision(obstacles:Obstacle[],maxSearchNodes:number,cellMm:number,workBudget?:NavigationWorkBudget):Navigation|undefined {
    const revised=reviseGeometry(this.#geometry,obstacles);
    return revised?new OwnedNavigation(revised,maxSearchNodes,cellMm,workBudget):undefined;
  }
  withBudget(workBudget:NavigationWorkBudget,maxSearchNodes:number,cellMm:number):Navigation{return new OwnedNavigation(this.#geometry,maxSearchNodes,cellMm,workBudget);}
  override withAdditionalObstacles(obstacles:Obstacle[],maxSearchNodes=this.maxSearchNodes,cellMm=this.cellMm,workBudget?:NavigationWorkBudget):Navigation {
    const additional=captureObstacles(obstacles),all=[...this.obstacles,...additional];Object.freeze(all);
    return new OwnedNavigation(geometry(this.widthMm,this.heightMm,all,this.#geometry,additional),maxSearchNodes,cellMm,workBudget);
  }
}

const canonicalOwnedFree=OwnedNavigation.prototype.free,canonicalOwnedUncached=Object.getOwnPropertyDescriptor(OwnedNavigation.prototype,'freeUncached')!.value;
const directSweepReaders=new Map<string,unknown>(['clearLine','clearLineUncached','free','freeUncached'].map(key=>[key,Object.getOwnPropertyDescriptor(OwnedNavigation.prototype,key)!.value]));
/** The movement owner may batch dynamic queries only around pure, unbudgeted
 * static sweeps. Inspect descriptors without invoking a custom reader/getter. */
export function supportsOwnedDirectSweep(navigation:Navigation):boolean{
  if(nodeTypes.isProxy(navigation)||Object.getPrototypeOf(navigation)!==OwnedNavigation.prototype||navigation.workBudget)return false;
  for(const [key,original]of directSweepReaders){const descriptor=Object.getOwnPropertyDescriptor(navigation,key)??Object.getOwnPropertyDescriptor(OwnedNavigation.prototype,key);if(!descriptor||!('value'in descriptor)||descriptor.value!==original)return false;}
  return true;
}
/** Only the immutable owner has a pure unbudgeted predicate. Generic/custom
 * readers retain exhaustive formation queries and their observable callbacks. */
export function supportsFormationPrefix(navigation:Navigation):boolean{return navigation instanceof OwnedNavigation&&navigation.free===canonicalOwnedFree&&(navigation as unknown as {freeUncached:unknown}).freeUncached===canonicalOwnedUncached&&!navigation.workBudget;}

export function createOwnedNavigation(widthMm:number,heightMm:number,obstacles:Obstacle[],maxSearchNodes=30000,cellMm=1000,workBudget?:NavigationWorkBudget):Navigation {
  return new OwnedNavigation(geometry(widthMm,heightMm,captureObstacles(obstacles)),maxSearchNodes,cellMm,workBudget);
}
const canonicalOwnedRevision=OwnedNavigation.prototype.revision;
/** Native authorized source lists only. This helper neither discovers entities
 * nor skips knownObstacles/gate/memory validation; unsupported inputs retain the
 * existing complete constructor, including repeated aliases and mutable data. */
export function createOwnedNavigationRevision(prior:Navigation|undefined,widthMm:number,heightMm:number,obstacles:Obstacle[],maxSearchNodes=30000,cellMm=1000,workBudget?:NavigationWorkBudget):Navigation {
  const previous=prior&&!nodeTypes.isProxy(prior)&&Object.getOwnPropertyDescriptor(OwnedNavigation.prototype,'revision')?.value===canonicalOwnedRevision&&prior instanceof OwnedNavigation&&prior.revision===canonicalOwnedRevision&&prior.widthMm===widthMm&&prior.heightMm===heightMm?prior:undefined;
  const capture=captureRevision(obstacles,previous?revisionCaptures.get(previous):undefined);
  if(!capture)return createOwnedNavigation(widthMm,heightMm,obstacles,maxSearchNodes,cellMm,workBudget);
  const navigation=previous&&revisionCaptures.has(previous)?previous.revision(capture.obstacles,maxSearchNodes,cellMm,workBudget):undefined;
  const result=navigation??new OwnedNavigation(geometry(widthMm,heightMm,capture.obstacles),maxSearchNodes,cellMm,workBudget);
  revisionCaptures.set(result,capture);return result;
}

/** A private geometry owner is the only route to sharing an answer cache.
 * Generic callers retain their existing mutable-geometry constructor semantics. */
export function withOwnedNavigationBudget(navigation:Navigation,workBudget:NavigationWorkBudget,maxSearchNodes=30000,cellMm=1000):Navigation {
  return navigation instanceof OwnedNavigation?navigation.withBudget(workBudget,maxSearchNodes,cellMm):new Navigation(navigation.widthMm,navigation.heightMm,navigation.obstacles,maxSearchNodes,cellMm,workBudget);
}
