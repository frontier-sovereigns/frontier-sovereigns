import { PlanningWorkCensus } from './planning-work-diagnostics.js';
import type { PathDiagnosticClock } from './path-diagnostics.js';
import {balance,type Position} from '@frontier/shared';
import { types as nodeTypes } from 'node:util';
import { Navigation, type Obstacle } from './navigation.js';
import { supportsFormationPrefix,supportsOwnedDirectSweep } from './owned-navigation.js';

export interface MovementBody extends Position {id:string;radiusMm:number}
/** Private process-local identity. Never saved, sent to clients, or used for ties. */
export interface MovementHandle {readonly slot:number;readonly generation:number}
type DirectFailureWitness={kind:'static'}|{kind:'unit';slot:number;generation:number;xMm:number;zMm:number;radiusMm:number};
const staticDirectFailure:DirectFailureWitness=Object.freeze({kind:'static'});
/** Collision-free signed cell pair in the hot domain; generic large worlds keep exact keys. */
const unitBucketKey=(x:number,z:number):number|string=>x>=-4096&&x<4096&&z>=-4096&&z<4096?z*8192+x:`${x},${z}`;
/** Dynamic broad phase. The simulation updates an entry immediately after movement. */
export class UnitSpatialIndex {
  private readonly slots=new Map<string,number>();
  private readonly buckets=new Map<number|string,Set<number>>();
  private readonly bodies:(MovementBody|undefined)[]=[];
  private readonly owners:(object|undefined)[]=[];
  private readonly keys:(number|string|undefined)[]=[];
  private readonly vacant:number[]=[];
  private readonly radiusCounts=new Map<number,number>();
  private readonly scratch:MovementBody[][]=[];
  private readonly directSweepScratch:number[][]=[];
  private x=new Float64Array(256);
  private z=new Float64Array(256);
  private radii=new Float64Array(256);
  private orders=new Float64Array(256);
  private generations=new Uint32Array(256);
  private observed=new Float64Array(256);
  private roster=0;
  private maxRadius=0;
  private topology=0;
  constructor(private readonly cellMm=4000){}
  /** Motion bounds remain valid across ordinary position updates, but never
   * across spawns, garrison changes, replacement bodies or radius changes. */
  topologyVersion():number{return this.topology;}
  private grow():void{
    const size=this.x.length*2;
    const grow=(prior:Float64Array)=>{const next=new Float64Array(size);next.set(prior);return next;};
    this.x=grow(this.x);this.z=grow(this.z);this.radii=grow(this.radii);this.orders=grow(this.orders);this.observed=grow(this.observed);
    const generations=new Uint32Array(size);generations.set(this.generations);this.generations=generations;
  }
  private removeRadius(radius:number):void{const remaining=this.radiusCounts.get(radius)!-1;if(remaining)this.radiusCounts.set(radius,remaining);else{this.radiusCounts.delete(radius);if(radius===this.maxRadius){this.maxRadius=0;for(const value of this.radiusCounts.keys())this.maxRadius=Math.max(this.maxRadius,value);}}}
  /** Update retained storage without allocating a temporary body or replacing its slot. */
  update(id:string,xMm:number,zMm:number,radiusMm:number,orderRevision=0,owner?:object):void {
    let slot=this.slots.get(id);
    if(slot!==undefined&&owner!==undefined&&this.owners[slot]!==owner){this.delete(id);slot=undefined;}
    if(slot===undefined){
      this.topology++;
      slot=this.vacant.pop()??this.bodies.length;if(slot>=this.x.length)this.grow();
      this.slots.set(id,slot);this.generations[slot]++;this.bodies[slot]={id,xMm,zMm,radiusMm};this.owners[slot]=owner;
      this.radiusCounts.set(radiusMm,(this.radiusCounts.get(radiusMm)??0)+1);this.maxRadius=Math.max(this.maxRadius,radiusMm);
    }else if(this.radii[slot]!==radiusMm){this.topology++;this.removeRadius(this.radii[slot]!);this.radiusCounts.set(radiusMm,(this.radiusCounts.get(radiusMm)??0)+1);this.maxRadius=Math.max(this.maxRadius,radiusMm);}
    this.observed[slot]=this.roster;this.orders[slot]=orderRevision;
    if(this.keys[slot]!==undefined&&this.x[slot]===xMm&&this.z[slot]===zMm&&this.radii[slot]===radiusMm)return;
    const key=unitBucketKey(Math.floor(xMm/this.cellMm),Math.floor(zMm/this.cellMm)),prior=this.keys[slot];
    if(prior!==key){if(prior!==undefined){const bucket=this.buckets.get(prior)!;bucket.delete(slot);if(!bucket.size)this.buckets.delete(prior);}const bucket=this.buckets.get(key)??new Set<number>();bucket.add(slot);this.buckets.set(key,bucket);this.keys[slot]=key;}
    this.x[slot]=xMm;this.z[slot]=zMm;this.radii[slot]=radiusMm;
    const body=this.bodies[slot]!;body.xMm=xMm;body.zMm=zMm;body.radiusMm=radiusMm;
  }
  set(body:MovementBody):void{this.update(body.id,body.xMm,body.zMm,body.radiusMm);}
  handle(id:string):MovementHandle|undefined{const slot=this.slots.get(id);return slot===undefined?undefined:{slot,generation:this.generations[slot]!};}
  resolve(handle:MovementHandle):MovementBody|undefined{return this.generations[handle.slot]===handle.generation?this.bodies[handle.slot]:undefined;}
  body(id:string):MovementBody|undefined{const slot=this.slots.get(id);return slot===undefined?undefined:this.bodies[slot];}
  /** The ordinary entity roster pass also reconciles deliberately mutable fixture state. */
  beginRoster():void{if(this.roster===Number.MAX_SAFE_INTEGER){this.observed.fill(0);this.roster=0;}this.roster++;}
  endRoster():void{for(const [id,slot]of this.slots)if(this.observed[slot]!==this.roster)this.delete(id);}
  synchronize(bodies:Iterable<MovementBody>):void{
    this.beginRoster();for(const body of bodies)this.set(body);this.endRoster();
  }
  delete(id:string):void{
    const slot=this.slots.get(id);if(slot===undefined)return;const key=this.keys[slot]!,bucket=this.buckets.get(key)!;bucket.delete(slot);if(!bucket.size)this.buckets.delete(key);
    this.topology++;
    this.removeRadius(this.radii[slot]!);this.slots.delete(id);this.bodies[slot]=undefined;this.owners[slot]=undefined;this.keys[slot]=undefined;
    // Retire an exhausted generation instead of allowing a stale handle to alias.
    if(this.generations[slot]!==0xffffffff)this.vacant.push(slot);
  }
  private query(point:Position,distanceMm:number,result:MovementBody[]):MovementBody[]{
    const reach=distanceMm+this.maxRadius;
    for(let z=Math.floor((point.zMm-reach)/this.cellMm);z<=Math.floor((point.zMm+reach)/this.cellMm);z++)for(let x=Math.floor((point.xMm-reach)/this.cellMm);x<=Math.floor((point.xMm+reach)/this.cellMm);x++)for(const slot of this.buckets.get(unitBucketKey(x,z))??[]){if(Math.hypot(this.x[slot]!-point.xMm,this.z[slot]!-point.zMm)<=distanceMm+this.radii[slot]!)result.push(this.bodies[slot]!);}
    return result.sort((a,b)=>a.id.localeCompare(b.id));
  }
  /** Scratch is synchronous and scoped; nested queries get separate retained storage. */
  withNearby<T>(point:Position,distanceMm:number,consume:(bodies:readonly MovementBody[])=>T):T{
    const result=this.scratch.pop()??[];try{return consume(this.query(point,distanceMm,result));}finally{result.length=0;this.scratch.push(result);}
  }
  nearby(point:Position,distanceMm:number):MovementBody[]{return this.withNearby(point,distanceMm,bodies=>bodies.map(body=>({...body})));}
  private intersects(point:Position,distanceMm:number,exceptId:string|undefined,test:(x:number,z:number,radius:number)=>boolean,failures?:DirectFailureWitness[]):boolean{
    const reach=distanceMm+this.maxRadius,except=exceptId===undefined?undefined:this.slots.get(exceptId);
    for(let z=Math.floor((point.zMm-reach)/this.cellMm);z<=Math.floor((point.zMm+reach)/this.cellMm);z++)for(let x=Math.floor((point.xMm-reach)/this.cellMm);x<=Math.floor((point.xMm+reach)/this.cellMm);x++)for(const slot of this.buckets.get(unitBucketKey(x,z))??[]){if(slot!==except&&Math.hypot(this.x[slot]!-point.xMm,this.z[slot]!-point.zMm)<=distanceMm+this.radii[slot]!&&test(this.x[slot]!,this.z[slot]!,this.radii[slot]!)){if(failures)this.recordDirectFailure(slot,failures);return true;}}
    return false;
  }
  free(point:Position,radiusMm:number,exceptId?:string):boolean{return !this.intersects(point,radiusMm,exceptId,(x,z,radius)=>Math.hypot(x-point.xMm,z-point.zMm)<radiusMm+radius);}
  clearLine(from:Position,to:Position,radiusMm:number,exceptId?:string,failures?:DirectFailureWitness[]):boolean{const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length2=dx*dx+dz*dz,test=(x:number,z:number,radius:number)=>{const t=length2?Math.max(0,Math.min(1,((x-from.xMm)*dx+(z-from.zMm)*dz)/length2)):0;return Math.hypot(from.xMm+dx*t-x,from.zMm+dz*t-z)<radiusMm+radius;};return !(failures?this.intersects(from,Math.sqrt(length2)+radiusMm,exceptId,test,failures):this.intersects(from,Math.sqrt(length2)+radiusMm,exceptId,test));}
  private recordDirectFailure(slot:number,failures:DirectFailureWitness[]):void{failures.push({kind:'unit',slot,generation:this.generations[slot]!,xMm:this.x[slot]!,zMm:this.z[slot]!,radiusMm:this.radii[slot]!});}
  /** A witnessed collision remains a collision even if unrelated bodies move.
   * Slot generations reject deletion/replacement; motion and radius stay exact. */
  directFailuresUnchanged(failures:readonly DirectFailureWitness[]):boolean{return failures.length>0&&failures.length<=4&&failures.every(value=>value.kind==='static'||Boolean(this.bodies[value.slot])&&this.generations[value.slot]===value.generation&&this.x[value.slot]===value.xMm&&this.z[value.slot]===value.zMm&&this.radii[value.slot]===value.radiusMm);}
  /** Saved recovery timing observes only authorized bodies that actually block
   * an attempted displacement. Unrelated passing traffic cannot keep restarting
   * a stationary queue's timer. Numeric storage, not exposed body aliases, is
   * the collision source; this signature never authorizes a displacement. */
  blockingStamp(body:MovementBody,choices:readonly Position[],isKnownUnit:(id:string)=>boolean):string|undefined{
    if(!choices.length||choices.length>4||!Number.isFinite(this.cellMm)||this.cellMm<=0||!Number.isFinite(this.maxRadius)||this.maxRadius<0||![body.xMm,body.zMm,body.radiusMm].every(Number.isFinite)||body.radiusMm<0||choices.some(point=>!Number.isFinite(point.xMm)||!Number.isFinite(point.zMm)))return undefined;
    let distance=0;for(const point of choices)distance=Math.max(distance,Math.hypot(point.xMm-body.xMm,point.zMm-body.zMm));
    const reach=distance+body.radiusMm+this.maxRadius,left=Math.floor((body.xMm-reach)/this.cellMm),right=Math.floor((body.xMm+reach)/this.cellMm),top=Math.floor((body.zMm-reach)/this.cellMm),bottom=Math.floor((body.zMm+reach)/this.cellMm);
    if(!Number.isFinite(reach)||(right-left+1)*(bottom-top+1)>64)return undefined;
    const except=this.slots.get(body.id),records:[string,number,number,number][]=[];let visited=0;
    for(let z=top;z<=bottom;z++)for(let x=left;x<=right;x++)for(const slot of this.buckets.get(unitBucketKey(x,z))??[]){
      if(++visited>2200)return undefined;if(slot===except)continue;
      const xMm=this.x[slot]!,zMm=this.z[slot]!,radiusMm=this.radii[slot]!,id=this.bodies[slot]!.id;
      if(Math.hypot(xMm-body.xMm,zMm-body.zMm)>distance+body.radiusMm+radiusMm||!isKnownUnit(id))continue;
      if(!choices.some(point=>{const dx=point.xMm-body.xMm,dz=point.zMm-body.zMm,length2=dx*dx+dz*dz,t=length2?Math.max(0,Math.min(1,((xMm-body.xMm)*dx+(zMm-body.zMm)*dz)/length2)):0;return Math.hypot(body.xMm+dx*t-xMm,body.zMm+dz*t-zMm)<body.radiusMm+radiusMm;}))continue;
      if(records.length>=128)return undefined;records.push([id,xMm,zMm,radiusMm]);
    }
    records.sort((a,b)=>a[0].localeCompare(b[0]));const stamp=JSON.stringify(records);return stamp.length<=32768?stamp:undefined;
  }
  /** One synchronous native direct step, with at most four rounding choices.
   * Static sweeps still precede each dynamic test. Scratch stays internal and is
   * released before the next actor can move; no result survives this call. */
  firstClearCandidate(body:MovementBody,choices:readonly Position[],navigation:Navigation,nativeOwned=false,failures?:DirectFailureWitness[]):Position|undefined{
    const scalar=()=>choices.find(point=>{if(!navigation.clearLine(body,point,body.radiusMm)){failures?.push(staticDirectFailure);return false;}return failures?this.clearLine(body,point,body.radiusMm,body.id,failures):this.clearLine(body,point,body.radiusMm,body.id);});
    if(!nativeOwned||nodeTypes.isProxy(choices)||!Array.isArray(choices)||Object.getPrototypeOf(choices)!==Array.prototype)return scalar();
    const length=Object.getOwnPropertyDescriptor(choices,'length')!.value as number;
    if(length<2||length>4||Reflect.ownKeys(choices).length!==length+1||Array.prototype.find!==directSweepArrayFind)return scalar();
    for(let i=0;i<length;i++){const descriptor=Object.getOwnPropertyDescriptor(choices,String(i));if(!descriptor||!('value'in descriptor))return scalar();}
    if(nodeTypes.isProxy(this)||Object.getPrototypeOf(this)!==UnitSpatialIndex.prototype||!supportsOwnedDirectSweep(navigation))return scalar();
    for(const [key,original]of directSweepIndexReaders){const descriptor=Object.getOwnPropertyDescriptor(this,key)??Object.getOwnPropertyDescriptor(UnitSpatialIndex.prototype,key);if(!descriptor||!('value'in descriptor)||descriptor.value!==original)return scalar();}
    // Private game positions are bounded integers. Unusual public fixtures keep
    // their original property reads, bucket iteration and floating-point path.
    const plain=(value:Position,fields:readonly string[])=>!nodeTypes.isProxy(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)&&fields.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value'in descriptor&&Number.isSafeInteger(descriptor.value)&&Math.abs(descriptor.value)<=1_000_000;});
    if(!plain(body,['xMm','zMm','radiusMm']))return scalar();
    const id=Object.getOwnPropertyDescriptor(body,'id');if(!id||!('value'in id)||typeof id.value!=='string')return scalar();
    if(body.radiusMm<0||choices.some(point=>!plain(point,['xMm','zMm']))||!Number.isFinite(this.cellMm)||this.cellMm<=0||!Number.isFinite(this.maxRadius)||this.maxRadius<0)return scalar();
    let maximum=0;for(const point of choices){const dx=point.xMm-body.xMm,dz=point.zMm-body.zMm;maximum=Math.max(maximum,Math.sqrt(dx*dx+dz*dz)+body.radiusMm);}
    const reach=maximum+this.maxRadius,left=Math.floor((body.xMm-reach)/this.cellMm),right=Math.floor((body.xMm+reach)/this.cellMm),top=Math.floor((body.zMm-reach)/this.cellMm),bottom=Math.floor((body.zMm+reach)/this.cellMm);
    if((right-left+1)*(bottom-top+1)>64)return scalar();
    const scratch=this.directSweepScratch.pop()??[],except=this.slots.get(body.id);let gathered=false,overflow=false;
    try{
      for(const point of choices){
        if(!navigation.clearLine(body,point,body.radiusMm)){failures?.push(staticDirectFailure);continue;}
        if(!gathered){
          gathered=true;
          outer:for(let z=top;z<=bottom;z++)for(let x=left;x<=right;x++)for(const slot of this.buckets.get(unitBucketKey(x,z))??[]){
            if(slot===except)continue;
            if(scratch.length>=2200*3){overflow=true;break outer;}
            scratch.push(slot,x,z);
          }
        }
        if(overflow){if(failures?this.clearLine(body,point,body.radiusMm,body.id,failures):this.clearLine(body,point,body.radiusMm,body.id))return point;continue;}
        const dx=point.xMm-body.xMm,dz=point.zMm-body.zMm,length2=dx*dx+dz*dz,distance=Math.sqrt(length2)+body.radiusMm,candidateReach=distance+this.maxRadius;
        const minX=Math.floor((body.xMm-candidateReach)/this.cellMm),maxX=Math.floor((body.xMm+candidateReach)/this.cellMm),minZ=Math.floor((body.zMm-candidateReach)/this.cellMm),maxZ=Math.floor((body.zMm+candidateReach)/this.cellMm);
        let blocked=false;
        for(let i=0;i<scratch.length;i+=3){
          if(scratch[i+1]!<minX||scratch[i+1]!>maxX||scratch[i+2]!<minZ||scratch[i+2]!>maxZ)continue;
          const slot=scratch[i]!,x=this.x[slot]!,z=this.z[slot]!,radius=this.radii[slot]!;
          if(Math.hypot(x-body.xMm,z-body.zMm)>distance+radius)continue;
          const t=length2?Math.max(0,Math.min(1,((x-body.xMm)*dx+(z-body.zMm)*dz)/length2)):0;
          if(Math.hypot(body.xMm+dx*t-x,body.zMm+dz*t-z)<body.radiusMm+radius){if(failures)this.recordDirectFailure(slot,failures);blocked=true;break;}
        }
        if(!blocked)return point;
      }
      return undefined;
    }finally{scratch.length=0;this.directSweepScratch.push(scratch);}
  }
}
const directSweepIndexReaders=new Map<string,unknown>(['clearLine','intersects'].map(key=>[key,Object.getOwnPropertyDescriptor(UnitSpatialIndex.prototype,key)!.value]));
const directWitnessIndexReaders=new Map<string,unknown>(['clearLine','intersects','firstClearCandidate','recordDirectFailure','directFailuresUnchanged'].map(key=>[key,Object.getOwnPropertyDescriptor(UnitSpatialIndex.prototype,key)!.value]));
const directSweepArrayFind=Array.prototype.find;
function supportsDirectWitnesses(index:UnitSpatialIndex,navigation:Navigation,body:MovementBody,point:Position,speedMm:number):boolean{
  if(nodeTypes.isProxy(index)||Object.getPrototypeOf(index)!==UnitSpatialIndex.prototype||!supportsOwnedDirectSweep(navigation)||Array.prototype.find!==directSweepArrayFind||!Number.isSafeInteger(speedMm)||speedMm<0||speedMm>1_000_000)return false;
  for(const [key,original]of directWitnessIndexReaders){const descriptor=Object.getOwnPropertyDescriptor(index,key)??Object.getOwnPropertyDescriptor(UnitSpatialIndex.prototype,key);if(!descriptor||!('value'in descriptor)||descriptor.value!==original)return false;}
  for(const [value,fields]of [[body,['xMm','zMm','radiusMm']],[point,['xMm','zMm']]] as const){if(nodeTypes.isProxy(value)||(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null))return false;for(const key of fields){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor)||!Number.isSafeInteger(descriptor.value)||Math.abs(descriptor.value)>1_000_000)return false;}}
  const id=Object.getOwnPropertyDescriptor(body,'id');return Boolean(id&&'value'in id&&typeof id.value==='string'&&body.radiusMm>=0);
}

/** Legal arrival slots retain enough room for another large body to pass between ranks. */
export function formationTargets(bodies:readonly MovementBody[],target:Position,navigation:Navigation):Map<string,Position>{
  const result=new Map<string,Position>();if(!bodies.length)return result;
  const spacing=Math.ceil((Math.max(...bodies.map(body=>body.radiusMm))*4+200)/1000)*1000,columns=Math.ceil(Math.sqrt(bodies.length)),rows=Math.ceil(bodies.length/columns);
  const maximumRadius=Math.max(...bodies.map(body=>body.radiusMm));
  const candidates:Position[]=[];
  for(let ring=0;ring<32&&candidates.length<Math.max(256,bodies.length*8);ring++)for(let z=-ring;z<rows+ring;z++)for(let x=-ring;x<columns+ring;x++){
    if(ring&&x!==-ring&&z!==-ring&&x!==columns+ring-1&&z!==rows+ring-1)continue;
    candidates.push({xMm:Math.round(target.xMm+(x-(columns-1)/2)*spacing),zMm:Math.round(target.zMm+(z-(rows-1)/2)*spacing)});
  }
  const center={xMm:bodies.reduce((sum,body)=>sum+body.xMm,0)/bodies.length,zMm:bodies.reduce((sum,body)=>sum+body.zMm,0)/bodies.length};
  const length=Math.hypot(target.xMm-center.xMm,target.zMm-center.zMm)||1,dx=(target.xMm-center.xMm)/length,dz=(target.zMm-center.zMm)/length;
  const lateral=(point:Position)=>point.zMm*dx-point.xMm*dz,forward=(point:Position)=>point.xMm*dx+point.zMm*dz;
  // Preserve lateral ranks and put the leading ranks furthest into the destination;
  // leaders must not park immediately in front of the units following them.
  const ordered=[...bodies].sort((a,b)=>lateral(a)-lateral(b)||forward(b)-forward(a)||a.id.localeCompare(b.id));
  // Parked ranks leave a traversable strip beside resources and structures.
  // This is destination clearance, not a change to any unit's collision radius.
  const destinationClearance=bodies.length>1?maximumRadius*3+250:maximumRadius;
  const legal:Position[]=[],prefix=supportsFormationPrefix(navigation);
  for(const candidate of candidates){
    if(navigation.free(candidate,destinationClearance)&&legal.length<bodies.length)legal.push(candidate);
    // Budgeted and custom callers retain every original query/exhaustion point.
    if(prefix&&legal.length===bodies.length)break;
  }
  // Extra parking space is a preference. Keep a complete compact group near the
  // click when roomy slots would move it far outside the requested enclosure.
  const nominal=candidates.slice(0,bodies.length),nominalRadius=Math.hypot((columns-1)*spacing/2,(rows-1)*spacing/2);
  if(legal.some(point=>Math.hypot(point.xMm-target.xMm,point.zMm-target.zMm)>nominalRadius+spacing)){
    if(nominal.every(point=>navigation.free(point,maximumRadius)))legal.splice(0,legal.length,...nominal);
    else if(bodies.length===2&&navigation.free(target,maximumRadius)){
      // A rounded click can leave just one nominal slot against a wall. Try the
      // center and existing nearby candidates for this pair. Larger groups keep
      // their roomy ranks so this adjustment cannot change army arrival flow.
      const compact:Position[]=[];
      for(const point of [{...target},...candidates]){
        if(compact.length===bodies.length)break;
        if(Math.hypot(point.xMm-target.xMm,point.zMm-target.zMm)>nominalRadius+spacing||!navigation.free(point,maximumRadius)||compact.some(prior=>Math.hypot(prior.xMm-point.xMm,prior.zMm-point.zMm)<maximumRadius*2+200)||!navigation.clearLine(target,point,maximumRadius))continue;
        compact.push(point);
      }
      if(compact.length===bodies.length)legal.splice(0,legal.length,...compact);
    }
  }
  if(legal.length<bodies.length){
    const narrow:Position[]=[{...target}];for(let index=1;index<=bodies.length;index++)for(const [x,z]of [[index,0],[-index,0],[0,index],[0,-index]] as const)narrow.push({xMm:target.xMm+x*spacing,zMm:target.zMm+z*spacing});
    for(const candidate of [...narrow,...candidates])if(legal.length<bodies.length&&navigation.free(candidate,maximumRadius)&&legal.every(prior=>Math.hypot(prior.xMm-candidate.xMm,prior.zMm-candidate.zMm)>=maximumRadius*2+200))legal.push(candidate);
  }
  legal.sort((a,b)=>lateral(a)-lateral(b)||forward(b)-forward(a));
  for(const [index,point]of legal.entries())result.set(ordered[index]!.id,point);
  return result;
}

/** One deterministic, collision-safe local step; no pushing or teleportation. */
export function separatedStep(body:MovementBody,target:Position,speedMm:number,navigation:Navigation,neighbors:UnitSpatialIndex):Position|undefined {
  const dx=target.xMm-body.xMm,dz=target.zMm-body.zMm,distance=Math.hypot(dx,dz);if(!distance)return {xMm:body.xMm,zMm:body.zMm};
  const step=Math.min(distance,speedMm);let vx=dx/distance*step,vz=dz/distance*step;
  neighbors.withNearby(body,body.radiusMm+200,nearby=>{for(const other of nearby)if(other.id!==body.id){const x=body.xMm-other.xMm,z=body.zMm-other.zMm,d=Math.hypot(x,z),separation=body.radiusMm+other.radiusMm+200;if(d>0&&d<separation){const strength=(separation-d)/200*step;vx+=x/d*strength;vz+=z/d*strength;}}});
  const heading=Math.atan2(vz,vx);
  // Both flanks remain bounded. A shared ordering gives queues a consistent side.
  for(const offset of [0,Math.PI/6,-Math.PI/6,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2]){
    const candidate={xMm:Math.round(body.xMm+Math.cos(heading+offset)*step),zMm:Math.round(body.zMm+Math.sin(heading+offset)*step)};
    if(navigation.clearLine(body,candidate,body.radiusMm)&&neighbors.clearLine(body,candidate,body.radiusMm,body.id))return candidate;
  }
  return undefined;
}

/** Prevents workers from all selecting the same perimeter work position. */
export class ApproachReservations {
  private slots=new Map<string,{targetId:string;position:Position;radiusMm:number}>();
  release(unitId:string):void{this.slots.delete(unitId);}
  /** A retained native work face must still own this exact claim. Geometry and
   * other actors' occupancy are checked separately against the current slice. */
  matchesClaim(unitId:string,targetId:string,radiusMm:number,point:Position):boolean{
    const slot=this.slots.get(unitId);return slot?.targetId===targetId&&slot.radiusMm===radiusMm&&slot.position.xMm===point.xMm&&slot.position.zMm===point.zMm;
  }
  available(unitId:string,point:Position,radiusMm:number):boolean{
    for(const [id,slot]of this.slots)if(id!==unitId){
      // Preserve current slot/query reads, strict tangency and the exact circle
      // test. Distant reserved faces do not need a square-root calculation.
      const dx=slot.position.xMm-point.xMm,dz=slot.position.zMm-point.zMm,separation=slot.radiusMm+radiusMm;
      if(Math.abs(dx)>=separation||Math.abs(dz)>=separation)continue;
      if(Math.hypot(dx,dz)<separation)return false;
    }
    return true;
  }
  claim(unitId:string,targetId:string,radiusMm:number,candidates:readonly Position[],isLegal:(point:Position)=>boolean):Position|undefined {
    const prior=this.slots.get(unitId);if(prior?.targetId===targetId&&isLegal(prior.position))return {...prior.position};
    this.slots.delete(unitId);
    for(const candidate of candidates)if(isLegal(candidate)&&this.available(unitId,candidate,radiusMm)){
      this.slots.set(unitId,{targetId,position:{...candidate},radiusMm});return {...candidate};
    }
    return undefined;
  }
  /** Native callers can defer pure candidate preparation until the current
   * reserved slot fails its ordinary legality check. Check that slot once. */
  claimLazy(unitId:string,targetId:string,radiusMm:number,candidates:()=>readonly Position[],isLegal:(point:Position)=>boolean):Position|undefined {
    const prior=this.slots.get(unitId);if(prior?.targetId===targetId&&isLegal(prior.position))return {...prior.position};
    const points=candidates();this.slots.delete(unitId);
    for(const candidate of points)if(isLegal(candidate)&&this.available(unitId,candidate,radiusMm)){
      this.slots.set(unitId,{targetId,position:{...candidate},radiusMm});return {...candidate};
    }
    return undefined;
  }
  exportState():[string,{targetId:string;position:Position;radiusMm:number}][]{return structuredClone([...this.slots]);}
  importState(state:ReturnType<ApproachReservations['exportState']>):void{this.slots=new Map(structuredClone(state));}
}

interface LocalRoute {target:Position;points:Position[];retryTick:number;nextSearchCellMm?:250|1000;neighborStamp?:string;stableSinceTick?:number;lastProgress?:boolean;yield?:{requesterId:string;untilTick:number;point:Position;origin:Position}}
export interface LocalPathCandidate {body:MovementBody;target:Position;following?:Position;remainingPath?:readonly Position[];orderRevision?:number}
export interface LocalPathQuery extends LocalPathCandidate {profile:string;geometryRevision:number;cellMm:250|1000;neighbors:Obstacle[];localRequestId?:number;localOrderRevision?:number}
export interface LocalPathResult {query:LocalPathQuery;destination?:Position;points:Position[]}
/** Versioned pending authority. Large historical neighbor snapshots exist only
 * in bounded dispatched leases; queued requests retain a compact route intent. */
export interface LocalDetourJob {
  requestId:number;orderRevision:number;body:MovementBody;target:Position;following?:Position;remainingPath:Position[];
  cellMm:250|1000;queuedTick:number;firstTick:number;status:'credit'|'queued'|'inflight'|'ready'|'retry';dispatchedTick?:number;
  ready?:{tick:number;destination?:Position;points:Position[]};
}
export interface DeferredLocalState {version:1;nextRequestId:number;jobs:[string,LocalDetourJob][]}
/** Keep floor/ceil choice ordering (including exact ties) identical everywhere. */
function directMovementChoices(body:Position,point:Position,speedMm:number):Position[]{
  const dx=point.xMm-body.xMm,dz=point.zMm-body.zMm,d=Math.hypot(dx,dz),ratio=d?Math.min(1,speedMm/d):1,x=body.xMm+dx*ratio,z=body.zMm+dz*ratio;
  // Integer rounding must not turn a legal tangent into a collision.
  return [...new Set([Math.floor(x),Math.ceil(x)])].flatMap(xMm=>[...new Set([Math.floor(z),Math.ceil(z)])].map(zMm=>({xMm,zMm}))).sort((a,b)=>Math.hypot(a.xMm-x,a.zMm-z)-Math.hypot(b.xMm-x,b.zMm-z));
}
/** The same integer sweep is used by full decisions and certified continuations. */
function directMovementStep(body:MovementBody,point:Position,speedMm:number,navigation:Navigation,neighbors:UnitSpatialIndex,nativeOwned=false,failures?:DirectFailureWitness[]):Position|undefined{
  const choices=directMovementChoices(body,point,speedMm);
  if(!nativeOwned)return choices.find(next=>navigation.clearLine(body,next,body.radiusMm)&&neighbors.clearLine(body,next,body.radiusMm,body.id));
  // Ordinary unobstructed movement pays no batch setup or scratch collection.
  const first=choices[0]!;if(!navigation.clearLine(body,first,body.radiusMm))failures?.push(staticDirectFailure);else if(failures?neighbors.clearLine(body,first,body.radiusMm,body.id,failures):neighbors.clearLine(body,first,body.radiusMm,body.id))return first;
  return failures?neighbors.firstClearCandidate(body,choices.slice(1),navigation,true,failures):neighbors.firstClearCandidate(body,choices.slice(1),navigation,true);
}
interface FailedDirectStep {
  xMm:number;zMm:number;radiusMm:number;targetX:number;targetZ:number;speedMm:number;orderRevision:number;
  navigation:Navigation;neighbors:UnitSpatialIndex;failures:DirectFailureWitness[];
}
/** Bounded worker calculation. Legacy prefetch requires exact inputs; versioned
 * deferred guidance is admitted separately and always uses current sweeps. */
export function computeLocalPathQuery(query:LocalPathQuery,navigation:Navigation):LocalPathResult{
  const local=navigation.withAdditionalObstacles(query.neighbors,2048,query.cellMm),radius=query.body.radiusMm;
  let destination=local.free(query.target,radius)?query.target:query.following&&local.free(query.following,radius)?query.following:undefined;
  for(let index=2;!destination&&query.remainingPath&&index<Math.min(query.remainingPath.length,6);index++)if(local.free(query.remainingPath[index]!,radius))destination=query.remainingPath[index];
  return {query,...(destination?{destination:{...destination}}:{}),points:destination?local.path(query.body,destination,radius)??[]:[]};
}
/** Temporary neighbors affect only bounded local detours, never the global map. */
export class LocalAvoidance {
  private deferred:DeferredLocalState|undefined;
  private localJobs=new Map<string,LocalDetourJob>();
  private localCounters={prepared:0,admitted:0,used:0,discarded:0};
  private failedDirectSteps=new Map<string,FailedDirectStep>();
  private failedDirectPrepared=0;
  private failedDirectUsed=0;
  /** Derived collision proofs only. Counts do not claim any physical progress. */
  directFailureDiagnostics(){return {prepared:this.failedDirectPrepared,used:this.failedDirectUsed,pending:this.failedDirectSteps.size};}
  constructor(mode?:'deferred-v1'){if(mode==='deferred-v1')this.deferred={version:1,nextRequestId:1,jobs:[]};}
  private workCensus:PlanningWorkCensus|undefined;
  enablePlanningDiagnostics(clock:PathDiagnosticClock):void{this.workCensus=new PlanningWorkCensus(clock);}
  planningDiagnostics(){return this.workCensus?.snapshot();}
  private routes=new Map<string,LocalRoute>();
  private tick=0;
  private searches=0;
  private waiting=new Map<string,{firstTick:number;lastTick:number}>();
  private grants=new Set<string>();
  private parallelResults=new Map<string,LocalPathResult>();
  private parallelNavigation:Navigation|undefined;
  private parallelRevision=-1;
  private parallelUntilTick=-1;
  private parallelUsed=0;
  private readonly obstaclePool:Obstacle[]=[];
  private readonly obstacleScratch:Obstacle[]=[];
  /** These records live only through one synchronous local search. Worker input
   * uses detached records below and never aliases this reusable scratch. */
  private knownObstacles(body:MovementBody,neighbors:UnitSpatialIndex,isKnownUnit:(id:string)=>boolean):Obstacle[]{
    const result=this.obstacleScratch;result.length=0;
    return neighbors.withNearby(body,8000,nearby=>{for(const other of nearby)if(other.id!==body.id&&isKnownUnit(other.id)){
      const obstacle=this.obstaclePool[result.length]??(this.obstaclePool[result.length]={id:other.id,xMm:0,zMm:0,halfWidth:0,halfHeight:0,circle:true});
      obstacle.id=other.id;obstacle.xMm=other.xMm;obstacle.zMm=other.zMm;obstacle.halfWidth=other.radiusMm;obstacle.halfHeight=other.radiusMm;result.push(obstacle);
    }return result;});
  }
  /** Per-phase derived memo only; it is intentionally absent from saves/replay. */
  prepareParallelQueries(profile:string,geometryRevision:number,candidates:readonly LocalPathCandidate[],_navigation:Navigation,neighbors:UnitSpatialIndex,isKnownUnit:(id:string)=>boolean):LocalPathQuery[]{
    if(!this.searches)return [];
    const eligible=candidates.filter(candidate=>{const route=this.routes.get(candidate.body.id);return route&&route.retryTick<=this.tick&&(route.lastProgress===false||this.waiting.has(candidate.body.id)||this.grants.has(candidate.body.id));});
    const selected=[...eligible.filter(candidate=>this.grants.has(candidate.body.id)),...eligible.filter(candidate=>!this.grants.has(candidate.body.id))].slice(0,this.searches);
    return selected.map(candidate=>({profile,geometryRevision,body:{...candidate.body},target:{...candidate.target},...(candidate.following?{following:{...candidate.following}}:{}),...(candidate.remainingPath?{remainingPath:candidate.remainingPath.slice(0,6).map(point=>({...point}))}:{}),cellMm:this.routes.get(candidate.body.id)?.nextSearchCellMm??250,neighbors:this.knownObstacles(candidate.body,neighbors,isKnownUnit).map(obstacle=>({...obstacle}))}));
  }
  /** Pure speculative work, independent of this contact slice's spent credits.
   * Oldest established waiters get the same first opportunity as local grants.
   * A retry later in the next frame may use the answer only after exact checks. */
  prepareServiceQueries(profile:string,geometryRevision:number,candidates:readonly LocalPathCandidate[],neighbors:UnitSpatialIndex,isKnownUnit:(id:string)=>boolean,throughTick:number,limit:number):LocalPathQuery[]{
    if(!Number.isSafeInteger(throughTick)||throughTick<this.tick||throughTick>this.tick+12||!Number.isSafeInteger(limit)||limit<0||limit>8)throw new Error('INVALID_LOCAL_PREFETCH_BOUND');
    const eligible=candidates.filter(candidate=>{const route=this.routes.get(candidate.body.id);return route&&!route.yield&&route.retryTick<=throughTick&&(route.lastProgress===false||this.waiting.has(candidate.body.id)||this.grants.has(candidate.body.id));});
    eligible.sort((a,b)=>{const aa=this.waiting.get(a.body.id),bb=this.waiting.get(b.body.id);return Number(!aa)-Number(!bb)||(aa?.firstTick??this.routes.get(a.body.id)!.retryTick)-(bb?.firstTick??this.routes.get(b.body.id)!.retryTick)||(a.body.id<b.body.id?-1:a.body.id>b.body.id?1:0);});
    return eligible.slice(0,limit).map(candidate=>({profile,geometryRevision,body:{...candidate.body},target:{...candidate.target},...(candidate.following?{following:{...candidate.following}}:{}),...(candidate.remainingPath?{remainingPath:candidate.remainingPath.slice(0,6).map(point=>({...point}))}:{}),cellMm:this.routes.get(candidate.body.id)?.nextSearchCellMm??250,neighbors:this.knownObstacles(candidate.body,neighbors,isKnownUnit).map(obstacle=>({...obstacle}))}));
  }
  private sameIntent(job:LocalDetourJob,body:MovementBody,target:Position,following:Position|undefined,remainingPath:readonly Position[]|undefined,orderRevision:number):boolean{
    const path=remainingPath??[],same=(a:Position|undefined,b:Position|undefined)=>a===undefined?b===undefined:b!==undefined&&a.xMm===b.xMm&&a.zMm===b.zMm;
    return job.orderRevision===orderRevision&&job.body.id===body.id&&same(job.body,body)&&job.body.radiusMm===body.radiusMm&&same(job.target,target)&&same(job.following,following)&&job.remainingPath.length===Math.min(path.length,6)&&job.remainingPath.every((point,index)=>same(point,path[index]));
  }
  /** Spend no contact credit here: the waiting contact already reserved it.
   * Only selected jobs acquire detached neighbor snapshots. Historical bodies
   * guide a route; current physical sweeps still authorize every displacement. */
  prepareDeferredQueries(profile:string,geometryRevision:number,candidates:readonly LocalPathCandidate[],neighbors:UnitSpatialIndex,isKnownUnit:(id:string)=>boolean,limit:number,tick:number):LocalPathQuery[]{
    if(!this.deferred)return [];
    if(!Number.isSafeInteger(limit)||limit<0||limit>480||!Number.isSafeInteger(tick)||tick<this.tick)throw new Error('INVALID_LOCAL_SERVICE_BOUND');
    const current=new Map(candidates.map(candidate=>[candidate.body.id,candidate]));
    for(const [id,job]of this.localJobs){const candidate=current.get(id);if(!candidate){this.localJobs.delete(id);continue;}if(!this.sameIntent(job,candidate.body,candidate.target,candidate.following,candidate.remainingPath,candidate.orderRevision??0)){
      if(job.body.xMm!==candidate.body.xMm||job.body.zMm!==candidate.body.zMm||job.orderRevision!==(candidate.orderRevision??0)){this.localJobs.delete(id);continue;}
      job.body={...candidate.body};job.target={...candidate.target};job.remainingPath=(candidate.remainingPath??[]).slice(0,6).map(point=>({...point}));if(candidate.following)job.following={...candidate.following};else delete job.following;job.status='retry';delete job.ready;delete job.dispatchedTick;
      const route=this.routes.get(id);if(route)route.retryTick=Math.min(route.retryTick,tick);
    }}
    // FIFO paid attempts prevents repeatedly failed old movers from taking the
    // first partial lease forever. firstTick remains the no-progress watchdog.
    const waiting=[...this.localJobs].filter(([,job])=>job.status==='queued').sort((a,b)=>a[1].queuedTick-b[1].queuedTick||a[1].firstTick-b[1].firstTick||(a[0]<b[0]?-1:a[0]>b[0]?1:0));
    return waiting.slice(0,limit).map(([,job])=>{
      const nearby=this.knownObstacles(job.body,neighbors,isKnownUnit).slice().sort((a,b)=>((a.xMm-job.body.xMm)**2+(a.zMm-job.body.zMm)**2)-((b.xMm-job.body.xMm)**2+(b.zMm-job.body.zMm)**2)||(a.id<b.id?-1:a.id>b.id?1:0)).slice(0,128).map(obstacle=>({...obstacle}));
      job.status='inflight';job.dispatchedTick=tick;
      this.localCounters.prepared++;
      return {profile,geometryRevision,body:{...job.body},target:{...job.target},...(job.following?{following:{...job.following}}:{}),remainingPath:job.remainingPath.map(point=>({...point})),cellMm:job.cellMm,neighbors:nearby,localRequestId:job.requestId,localOrderRevision:job.orderRevision};
    });
  }
  /** One recorded service admission includes only actually acknowledged leases.
   * Unexecuted selected work keeps its already-paid credit and original age. */
  admitDeferredResults(results:readonly LocalPathResult[],tick:number,bounds?:{widthMm:number;heightMm:number}):void{
    if(!this.deferred)return;
    const point=(value:Position|undefined):value is Position=>{
      if(!value||typeof value!=='object'||!([Object.prototype,null] as unknown[]).includes(Object.getPrototypeOf(value)))return false;
      const x=Object.getOwnPropertyDescriptor(value,'xMm'),z=Object.getOwnPropertyDescriptor(value,'zMm');
      return Boolean(x&&z&&'value'in x&&'value'in z&&Number.isSafeInteger(x.value)&&Number.isSafeInteger(z.value)&&x.value>=0&&z.value>=0&&(!bounds||x.value<=bounds.widthMm&&z.value<=bounds.heightMm));
    };
    for(const result of results){const job=this.localJobs.get(result.query?.body?.id);if(!job||job.status!=='inflight'||job.requestId!==result.query.localRequestId||job.orderRevision!==result.query.localOrderRevision)continue;
      const valid=Array.isArray(result.points)&&result.points.length<=2048&&result.points.every(value=>point(value))&&(!result.destination||point(result.destination));
      this.localCounters.admitted++;if(!valid)this.localCounters.discarded++;
      // A bounded prefix is sufficient guidance. Reaching it never consumes the
      // global destination; the next current sweep continues toward that goal.
      job.status='ready';job.ready={tick,...(valid&&result.destination?{destination:{...result.destination}}:{}),points:valid?result.points.slice(0,128).map(value=>({...value})):[]};
    }
    for(const job of this.localJobs.values())if(job.status==='inflight'){job.status='queued';delete job.dispatchedTick;}
  }
  pendingLocal(id:string):boolean{return this.localJobs.has(id);}
  /** Derived travel preparation may outlive a frame only while this exact
   * current pose/order/route still owns a local wait. This query spends no
   * credit, consumes no result and does not refresh the request's age. */
  matchesPendingLocal(body:MovementBody,target:Position,following:Position|undefined,remainingPath:readonly Position[],orderRevision:number):boolean{
    const job=this.localJobs.get(body.id);return Boolean(this.deferred&&job&&this.sameIntent(job,body,target,following,remainingPath,orderRevision));
  }
  deferredDiagnostics(tick=this.tick):{waitingForCredit:number;queued:number;inflight:number;ready:number;retry:number;oldestWaitTicks:number;prepared:number;admitted:number;used:number;discarded:number}|undefined{
    if(!this.deferred)return;
    const value={waitingForCredit:0,queued:0,inflight:0,ready:0,retry:0,oldestWaitTicks:0,...this.localCounters};for(const job of this.localJobs.values()){if(job.status==='credit')value.waitingForCredit++;else value[job.status]++;value.oldestWaitTicks=Math.max(value.oldestWaitTicks,Math.max(0,tick-job.firstTick));}return value;
  }
  pendingLocalRequests():{unitId:string;requestId:string;orderRevision:number;firstTick:number}[]{return [...this.localJobs].map(([unitId,job])=>({unitId,requestId:'local_detour_v1',orderRevision:job.orderRevision,firstTick:job.firstTick}));}
  /** Request serials never rewind within an owner. Late prior-epoch replies
   * cannot match a newly queued intent even if pose and order are unchanged. */
  invalidateDeferredEpoch():void{for(const id of this.localJobs.keys()){const route=this.routes.get(id);if(route)route.retryTick=this.tick;}this.localJobs.clear();this.failedDirectSteps.clear();}
  /** A journaled, bounded wall-age recovery asks for a fresh detour without
   * destroying the valid global route or manufacturing movement progress. */
  retryPendingLocal(id:string):boolean{const job=this.localJobs.get(id),route=this.routes.get(id);if(!job||!route)return false;job.status='retry';delete job.ready;delete job.dispatchedTick;route.retryTick=this.tick;return true;}
  installParallelResults(results:readonly LocalPathResult[],navigation:Navigation,geometryRevision:number,validThroughTick=this.tick):void{
    if(!Number.isSafeInteger(validThroughTick)||validThroughTick<this.tick||validThroughTick>this.tick+12)throw new Error('INVALID_LOCAL_PREFETCH_EXPIRY');
    this.parallelResults=new Map(results.filter(result=>result.query.geometryRevision===geometryRevision).map(result=>[result.query.body.id,result]));this.parallelNavigation=navigation;this.parallelRevision=geometryRevision;this.parallelUntilTick=validThroughTick;
  }
  parallelDiagnostics(){return {used:this.parallelUsed,pending:this.parallelResults.size};}
  private parallelPath(body:MovementBody,destination:Position,cellMm:250|1000,neighbors:readonly Obstacle[],navigation:Navigation):Position[]|undefined{
    const result=this.parallelResults.get(body.id);this.parallelResults.delete(body.id);if(!result||this.parallelNavigation!==navigation||result.query.geometryRevision!==this.parallelRevision||result.query.cellMm!==cellMm||result.query.body.xMm!==body.xMm||result.query.body.zMm!==body.zMm||result.query.body.radiusMm!==body.radiusMm||result.destination?.xMm!==destination.xMm||result.destination.zMm!==destination.zMm||result.query.neighbors.length!==neighbors.length)return;
    if(result.query.neighbors.some((prior,index)=>{const next=neighbors[index]!;return prior.id!==next.id||prior.xMm!==next.xMm||prior.zMm!==next.zMm||prior.halfWidth!==next.halfWidth||prior.halfHeight!==next.halfHeight||prior.circle!==next.circle;}))return;
    this.parallelUsed++;return result.points.map(point=>({...point}));
  }
  beginTick(tick:number,maxSearches=8,preservePrefetch=false):void{
    if(!Number.isSafeInteger(maxSearches)||maxSearches<0)throw new Error('INVALID_LOCAL_PATH_BUDGET');
    this.tick=tick;this.searches=maxSearches;
    if(!preservePrefetch)this.failedDirectSteps.clear();
    if(!preservePrefetch||tick>this.parallelUntilTick){this.parallelResults.clear();this.parallelNavigation=undefined;this.parallelRevision=-1;this.parallelUntilTick=-1;}
    for(const [id,request]of this.waiting)if(request.lastTick<tick-1)this.waiting.delete(id);
    this.grants=new Set([...this.waiting].sort((a,b)=>a[1].firstTick-b[1].firstTick||a[0].localeCompare(b[0])).slice(0,maxSearches).map(([id])=>id));
  }
  release(id:string):void{this.routes.delete(id);this.waiting.delete(id);this.grants.delete(id);this.parallelResults.delete(id);this.localJobs.delete(id);this.failedDirectSteps.delete(id);for(const route of this.routes.values())if(route.yield?.requesterId===id)delete route.yield;}
  madeProgress(id:string):boolean{return this.routes.get(id)?.lastProgress??false;}
  /** Pure eligibility query avoids preparing unused asynchronous detour inputs. */
  needsParallelQuery(id:string):boolean{const route=this.routes.get(id);return Boolean(this.searches&&route&&route.retryTick<=this.tick&&(route.lastProgress===false||this.waiting.has(id)||this.grants.has(id)));}
  /** A successful continuation has exactly the ordinary direct-step state changes.
   * A conflict leaves all state untouched so the full solver runs in this tick. */
  continueStraight(body:MovementBody,target:Position,speedMm:number,physicalNavigation:Navigation,neighbors:UnitSpatialIndex,nativeOwned=false):Position|undefined{
    const route=this.routes.get(body.id);
    if(!route||route.yield||route.points.length||route.lastProgress!==true||route.target.xMm!==target.xMm||route.target.zMm!==target.zMm)return;
    const next=directMovementStep(body,target,speedMm,physicalNavigation,neighbors,nativeOwned);if(!next)return;
    route.lastProgress=Math.hypot(target.xMm-body.xMm,target.zMm-body.zMm)-Math.hypot(target.xMm-next.xMm,target.zMm-next.zMm)>1;
    this.waiting.delete(body.id);this.grants.delete(body.id);this.localJobs.delete(body.id);if(this.deferred&&(next.xMm!==body.xMm||next.zMm!==body.zMm)){delete route.neighborStamp;delete route.stableSinceTick;}return next;
  }
  /** Prove a short isolated corridor once. Inflation includes every rounded
   * contact position and another body's maximum motion before the last commit;
   * one extra step covers bodies later in the current ordered movement pass. */
  prepareStraightFlight(body:MovementBody,target:Position,speedMm:number,steps:number,maximumOtherStepMm:number,physicalNavigation:Navigation,neighbors:UnitSpatialIndex):Position[]|undefined{
    const route=this.routes.get(body.id);
    if(!route||route.yield||route.points.length||route.lastProgress!==true||route.target.xMm!==target.xMm||route.target.zMm!==target.zMm||!Number.isInteger(steps)||steps<1||steps>11||!Number.isFinite(maximumOtherStepMm)||maximumOtherStepMm<speedMm||Math.hypot(target.xMm-body.xMm,target.zMm-body.zMm)<=(speedMm+2)*steps+100)return;
    const points:Position[]=[];let prior:Position=body;
    for(let index=0;index<steps;index++){prior=directMovementChoices(prior,target,speedMm)[0]!;points.push(prior);}
    const end=points.at(-1)!,dx=end.xMm-body.xMm,dz=end.zMm-body.zMm,length2=dx*dx+dz*dz;let deviation=1;
    for(const point of points){const t=length2?Math.max(0,Math.min(1,((point.xMm-body.xMm)*dx+(point.zMm-body.zMm)*dz)/length2)):0;deviation=Math.max(deviation,Math.hypot(point.xMm-body.xMm-dx*t,point.zMm-body.zMm-dz*t)+1);}
    // Another body's first rounded candidate can be blocked, so its later legal
    // floor/ceil choice may add up to sqrt(2) mm to the nominal step length.
    if(!physicalNavigation.clearLine(body,end,body.radiusMm+deviation)||!neighbors.clearLine(body,end,body.radiusMm+deviation+(maximumOtherStepMm+2)*(steps+1),body.id))return;
    return points;
  }
  /** Caller owns a current corridor certificate. Commit only the same state
   * effects as an ordinary successful direct step, without another query. */
  continueProvenStraight(body:MovementBody,target:Position,next:Position):boolean{
    const route=this.routes.get(body.id);
    if(!route||route.yield||route.points.length||route.lastProgress!==true||route.target.xMm!==target.xMm||route.target.zMm!==target.zMm)return false;
    route.lastProgress=Math.hypot(target.xMm-body.xMm,target.zMm-body.zMm)-Math.hypot(target.xMm-next.xMm,target.zMm-next.zMm)>1;this.waiting.delete(body.id);this.grants.delete(body.id);this.localJobs.delete(body.id);if(this.deferred&&(next.xMm!==body.xMm||next.zMm!==body.zMm)){delete route.neighborStamp;delete route.stableSinceTick;}return true;
  }
  step(body:MovementBody,target:Position,speedMm:number,navigation:Navigation,neighbors:UnitSpatialIndex,physicalNavigation:Navigation=navigation,isKnownUnit:(id:string)=>boolean=()=>true,following?:Position,remainingPath?:readonly Position[],nativeOwned=false,orderRevision=0):Position|undefined {
    const stepSpan=this.workCensus?.begin('local.step',{unitId:body.id,stage:'local'});
    try{
    let route=this.routes.get(body.id);
    if(!route||route.target.xMm!==target.xMm||route.target.zMm!==target.zMm){route={target:{...target},points:[],retryTick:0,...(route?.yield?{yield:route.yield}:{})};this.routes.set(body.id,route);}
    route.lastProgress=false;
    const accepted=(next:Position|undefined,guide:Position):Position|undefined=>{if(next){route!.lastProgress=Math.hypot(guide.xMm-body.xMm,guide.zMm-body.zMm)-Math.hypot(guide.xMm-next.xMm,guide.zMm-next.zMm)>1;this.waiting.delete(body.id);this.grants.delete(body.id);if(next.xMm!==body.xMm||next.zMm!==body.zMm){this.localJobs.delete(body.id);this.failedDirectSteps.delete(body.id);if(this.deferred){delete route!.neighborStamp;delete route!.stableSinceTick;}}}return next;};
    while(route.points.length&&Math.hypot(route.points[0]!.xMm-body.xMm,route.points[0]!.zMm-body.zMm)<=1)route.points.shift();
    const direct=(point:Position):Position|undefined=>{
      if(!this.deferred||!nativeOwned){this.failedDirectSteps.clear();return directMovementStep(body,point,speedMm,physicalNavigation,neighbors,nativeOwned);}
      // Freely moving actors keep their existing direct fast path. The first
      // blocked contact creates a compact local job; only established waiting
      // actors pay capability checks and collect a collision proof.
      const id=!nodeTypes.isProxy(body)&&Object.getOwnPropertyDescriptor(body,'id');
      if(id&&'value'in id&&typeof id.value==='string'&&!this.failedDirectSteps.has(id.value)&&!this.localJobs.has(id.value))return directMovementStep(body,point,speedMm,physicalNavigation,neighbors,true);
      if(!supportsDirectWitnesses(neighbors,physicalNavigation,body,point,speedMm)){
        this.failedDirectSteps.clear();return directMovementStep(body,point,speedMm,physicalNavigation,neighbors,nativeOwned);
      }
      const prior=this.failedDirectSteps.get(body.id);
      if(prior&&prior.navigation===physicalNavigation&&prior.neighbors===neighbors&&prior.xMm===body.xMm&&prior.zMm===body.zMm&&prior.radiusMm===body.radiusMm&&prior.targetX===point.xMm&&prior.targetZ===point.zMm&&prior.speedMm===speedMm&&prior.orderRevision===orderRevision&&neighbors.directFailuresUnchanged(prior.failures)){
        this.failedDirectUsed++;return undefined;
      }
      const failures:DirectFailureWitness[]=[],next=directMovementStep(body,point,speedMm,physicalNavigation,neighbors,true,failures);
      this.failedDirectSteps.delete(body.id);
      if(!next&&failures.length&&failures.length<=4&&this.failedDirectSteps.size<2200){
        this.failedDirectSteps.set(body.id,{xMm:body.xMm,zMm:body.zMm,radiusMm:body.radiusMm,targetX:point.xMm,targetZ:point.zMm,speedMm,orderRevision,navigation:physicalNavigation,neighbors,failures});this.failedDirectPrepared++;
      }
      return next;
    };
    if(route.yield){
      const requester=neighbors.withNearby(route.yield.origin,4000,nearby=>nearby.find(other=>other.id===route.yield!.requesterId));
      if(route.yield.untilTick<=this.tick||!this.routes.has(route.yield.requesterId)||!requester||Math.hypot(requester.xMm-route.yield.origin.xMm,requester.zMm-route.yield.origin.zMm)>3500)delete route.yield;
      else{if(Math.hypot(body.xMm-route.yield.point.xMm,body.zMm-route.yield.point.zMm)<=1)return undefined;const yielded=direct(route.yield.point);if(yielded)return accepted(yielded,route.yield.point);delete route.yield;}
    }
    let next=direct(route.points[0]??target);if(next)return accepted(next,route.points[0]??target);
    let admittedEmpty=false,oldestWait=this.localJobs.get(body.id)?.firstTick;
    if(this.deferred){
      let job=this.localJobs.get(body.id);
      if(job&&!this.sameIntent(job,body,target,following,remainingPath,orderRevision)){
        if(job.body.xMm===body.xMm&&job.body.zMm===body.zMm&&job.orderRevision===orderRevision){job.body={...body};job.target={...target};job.remainingPath=(remainingPath??[]).slice(0,6).map(point=>({...point}));if(following)job.following={...following};else delete job.following;job.status='retry';delete job.ready;delete job.dispatchedTick;}
        else{this.localJobs.delete(body.id);job=undefined;oldestWait=undefined;}route.retryTick=this.tick;
      }
      if(job?.status==='ready'){
        const answer=job.ready!,fresh=job.dispatchedTick!==undefined&&this.tick-job.dispatchedTick<=40;
        // The endpoint and route intent remain authorized. Historical neighbor
        // poses are deliberately advisory; re-check current known static space.
        const authorized=answer.destination!==undefined&&[target,following,...(remainingPath??[]).slice(2,6)].some(point=>point&&point.xMm===answer.destination!.xMm&&point.zMm===answer.destination!.zMm);
        let previous:Position=body,legal=fresh&&authorized&&answer.points.length>0;
        for(const point of answer.points){if(!legal||!Number.isSafeInteger(point.xMm)||!Number.isSafeInteger(point.zMm)||point.xMm<0||point.zMm<0||point.xMm>navigation.widthMm||point.zMm>navigation.heightMm||!navigation.clearLine(previous,point,body.radiusMm)){legal=false;break;}previous=point;}
        route.points=legal?answer.points.map(point=>({...point})):[];
        if(legal)this.localCounters.used++;else if(answer.points.length)this.localCounters.discarded++;
        // An old empty/congested reply is never proof the current route is
        // impossible. Retry later while preserving the original waiting age.
        route.nextSearchCellMm=route.points.length||job.cellMm===1000?250:1000;
        job.status='retry';delete job.ready;delete job.dispatchedTick;route.retryTick=this.tick+10;
        if(route.points.length){const adopted=direct(route.points[0]!);if(adopted)return accepted(adopted,route.points[0]!);}
        admittedEmpty=true;
      }else if(job&&job.status!=='retry'&&job.status!=='credit')return undefined;
    }
    if(!admittedEmpty){
    if(this.tick<route.retryTick)return undefined;
    const waiting=this.waiting.get(body.id);if(waiting)waiting.lastTick=this.tick;else this.waiting.set(body.id,{firstTick:oldestWait??this.tick,lastTick:this.tick});
    if(this.deferred&&!this.localJobs.has(body.id)){
      if(this.localJobs.size>=2200)throw new Error('LOCAL_PATH_QUEUE_LIMIT');
      this.localJobs.set(body.id,{requestId:this.deferred.nextRequestId++,orderRevision,body:{...body},target:{...target},...(following?{following:{...following}}:{}),remainingPath:(remainingPath??[]).slice(0,6).map(point=>({...point})),cellMm:route.nextSearchCellMm??250,queuedTick:this.tick,firstTick:oldestWait??this.tick,status:'credit'});
    }
    if(!this.grants.has(body.id)&&this.searches<=this.grants.size)return undefined;
    this.searches--;this.grants.delete(body.id);this.waiting.delete(body.id);route.retryTick=this.tick+10;
    if(this.deferred){
      if(!this.localJobs.has(body.id)&&this.localJobs.size>=2200)throw new Error('LOCAL_PATH_QUEUE_LIMIT');
      const credit=this.localJobs.get(body.id);this.localJobs.set(body.id,{requestId:credit?.status==='credit'?credit.requestId:this.deferred.nextRequestId++,orderRevision,body:{...body},target:{...target},...(following?{following:{...following}}:{}),remainingPath:(remainingPath??[]).slice(0,6).map(point=>({...point})),cellMm:route.nextSearchCellMm??250,queuedTick:this.tick,firstTick:oldestWait??this.tick,status:'queued'});
      return undefined;
    }
    }
    const grant=this.workCensus?.begin('local.grant');
    try{
    if(!admittedEmpty){
    const nearby=this.workCensus?this.workCensus.measure('local.neighbors',()=>this.knownObstacles(body,neighbors,isKnownUnit)):this.knownObstacles(body,neighbors,isKnownUnit);
    // A stopped body can seal a passage between whole buildings. Retain the
    // fine search first, then try a coarse detour after a failed fine grant.
    // Failed retries alternate with the full existing2048-node allowance and
    // one connector setup per grant; success restores the fine-first priority.
    // Persist the next resolution so restoring during a retry preserves order.
    const cellMm=route.nextSearchCellMm??250;
    const local=this.workCensus?this.workCensus.measure('local.overlay',()=>navigation.withAdditionalObstacles(nearby,2048,cellMm)):navigation.withAdditionalObstacles(nearby,2048,cellMm);
    let destination=local.free(target,body.radiusMm)?target:following&&local.free(following,body.radiusMm)?following:undefined;
    // Arrived units can occupy consecutive intermediate waypoints. Inspect at
    // most four later points on this unit's authorized route, then prove a full
    // local detour. This never moves blockers or skips the per-step sweep.
    for(let index=2;!destination&&remainingPath&&index<Math.min(remainingPath.length,6);index++)if(local.free(remainingPath[index]!,body.radiusMm))destination=remainingPath[index];
    route.points=destination?this.parallelPath(body,destination,cellMm,nearby,navigation)??(this.workCensus?this.workCensus.measure('local.path',()=>local.path(body,destination!,body.radiusMm)):local.path(body,destination,body.radiusMm))??[]:[];
    route.nextSearchCellMm=route.points.length||cellMm===1000?250:1000;
    if(route.points.length)return accepted(direct(route.points[0]!),route.points[0]!);
    }
    // A neighbor can leave a legal channel narrower than the local lattice.
    // Exact circle tangents provide a bounded continuous alternative only when
    // the local grid has no route; collision still checks the entire segment.
    const guide=route.points[0]??target,blocking=this.deferred?neighbors.blockingStamp(body,directMovementChoices(body,guide,speedMm),isKnownUnit):undefined;
    let stamp=this.deferred?blocking===undefined?undefined:JSON.stringify([body.xMm,body.zMm,body.radiusMm,orderRevision,guide.xMm,guide.zMm,speedMm,blocking]):neighbors.withNearby(body,body.radiusMm+2000,nearby=>nearby.filter(other=>other.id!==body.id&&isKnownUnit(other.id)).map(other=>`${other.id}:${other.xMm}:${other.zMm}`).join('|'));
    if(this.deferred&&stamp!==undefined&&stamp.length>65536)stamp=undefined;
    // An oversized/custom neighborhood conservatively restarts the recovery
    // delay. Ordinary same-intent retries retain it, including after a save.
    if(stamp===undefined||route.neighborStamp!==stamp){if(stamp===undefined)delete route.neighborStamp;else route.neighborStamp=stamp;route.stableSinceTick=this.tick;}
    // A moving blocker or a fresh intermediate guide can keep changing the
    // stability signature without moving this actor at all. After five game
    // seconds, a matching persisted wait may try the same bounded recovery at
    // this already-admitted failed retry. Pending jobs/credits still return
    // above, and an oversized neighborhood never bypasses its conservative gate.
    const stalled=this.deferred&&admittedEmpty&&stamp!==undefined?this.localJobs.get(body.id):undefined;
    const prolonged=stalled?.status==='retry'&&stalled.orderRevision===orderRevision&&stalled.body.id===body.id&&stalled.body.xMm===body.xMm&&stalled.body.zMm===body.zMm&&stalled.body.radiusMm===body.radiusMm&&this.tick-stalled.firstTick>=5*balance.rules.simulationHz;
    if(this.tick-(route.stableSinceTick??this.tick)<60&&!prolonged)return undefined;
    // Only this faction's active moving routes participate. A stopped unit or
    // another faction is never moved by a right-of-way decision. Stable IDs
    // impose an acyclic priority order when two movers need the same opening.
    const priority=neighbors.withNearby(body,body.radiusMm+1800,nearby=>nearby.find(other=>other.id<body.id&&this.routes.has(other.id)));
    if(priority){
      const forward=Math.atan2(target.zMm-body.zMm,target.xMm-body.xMm),away=Math.atan2(body.zMm-priority.zMm,body.xMm-priority.xMm),directions=[forward+Math.PI,away,forward+Math.PI/2,forward-Math.PI/2];
      for(const length of [3000,2000,1000])for(const angle of directions){const point={xMm:Math.round(body.xMm+Math.cos(angle)*length),zMm:Math.round(body.zMm+Math.sin(angle)*length)};
        if(navigation.clearLine(body,point,body.radiusMm)&&physicalNavigation.clearLine(body,point,body.radiusMm)&&neighbors.clearLine(body,point,body.radiusMm,body.id)){route.yield={requesterId:priority.id,untilTick:this.tick+200,point,origin:{xMm:body.xMm,zMm:body.zMm}};return accepted(direct(point),point);}
      }
    }
    const distance=Math.hypot(target.xMm-body.xMm,target.zMm-body.zMm),angles=[0,Math.PI/2,Math.PI,-Math.PI/2];
    neighbors.withNearby(body,body.radiusMm+2000,nearby=>{for(const other of nearby)if(other.id!==body.id&&isKnownUnit(other.id)){const dx=other.xMm-body.xMm,dz=other.zMm-body.zMm,d=Math.hypot(dx,dz),angle=Math.atan2(dz,dx),alpha=Math.asin(Math.min(1,(body.radiusMm+other.radiusMm+1)/d));angles.push(angle+alpha+.001,angle-alpha-.001);}});
    const candidates=angles.map(angle=>({xMm:Math.round(body.xMm+Math.cos(angle)*speedMm),zMm:Math.round(body.zMm+Math.sin(angle)*speedMm)})).filter(point=>Math.hypot(point.xMm-target.xMm,point.zMm-target.zMm)<distance-1).sort((a,b)=>Math.hypot(a.xMm-target.xMm,a.zMm-target.zMm)-Math.hypot(b.xMm-target.xMm,b.zMm-target.zMm));
    return accepted(candidates.find(point=>navigation.clearLine(point,target,body.radiusMm)&&physicalNavigation.clearLine(body,point,body.radiusMm)&&neighbors.clearLine(body,point,body.radiusMm,body.id)),target);
    }catch(error){this.workCensus?.recordFailure('local.grant');throw error;}finally{this.workCensus?.end(grant);}
    }catch(error){this.workCensus?.recordFailure('local.step');throw error;}finally{this.workCensus?.end(stepSpan);}
  }
  exportState():{tick:number;searches:number;routes:[string,LocalRoute][];waiting:[string,{firstTick:number;lastTick:number}][];grants:string[];deferred?:DeferredLocalState}{return structuredClone({tick:this.tick,searches:this.searches,routes:[...this.routes],waiting:[...this.waiting],grants:[...this.grants],...(this.deferred?{deferred:{...this.deferred,jobs:[...this.localJobs]}}:{})});}
  importState(state:ReturnType<LocalAvoidance['exportState']>):void{const copy=structuredClone(state);this.tick=copy.tick;this.searches=copy.searches;this.routes=new Map(copy.routes);this.waiting=new Map(copy.waiting??[]);this.grants=new Set(copy.grants??[]);if(copy.deferred){this.deferred={version:1,nextRequestId:copy.deferred.nextRequestId,jobs:[]};this.localJobs=new Map(copy.deferred.jobs);}else this.localJobs.clear();this.parallelResults.clear();this.parallelNavigation=undefined;this.parallelRevision=-1;this.parallelUntilTick=-1;this.failedDirectSteps.clear();}
}
