import { balance, buildings, units, terrainHeightAt, MAX_WORLD_ACTORS, type Position, type UnitDefinition, type BuildingDefinition } from '@frontier/shared';
import { types as nodeTypes } from 'node:util';
import type { AttackSnapshot, Building, Entity, Projectile, SimulationState, Unit } from './state.js';
import { absorbWard } from './legendary-mechanics.js';

export type Combatant=Unit|Building;
declare const ownerFilterBrand:unique symbol;
/** Opt-in for a synchronous phase whose callbacks cannot change actor ownership
 * or teams. Generic callback queries keep their original traversal. */
export type CombatOwnerFilter={readonly [ownerFilterBrand]:true};
interface OwnerFilterData {bits:Map<string,number>;hostile:Map<string,number>}
const ownerFilters=new WeakMap<CombatOwnerFilter,OwnerFilterData>();
type CombatPhase='engagement'|'combat';
const nativePhaseFilters=new WeakMap<CombatOwnerFilter,{phase:CombatPhase;combatants:readonly Combatant[]}>();
/** Internal factory capability. The owning simulation retains this closure;
 * neither its actor roster nor the closure crosses its public membrane. A
 * normal owner filter certifies only factions and never confers native trust. */
export function createNativeCombatOwnerFilterScope(){
  let prior:CombatOwnerFilter|undefined;
  return (factions:readonly {id:string;teamId:string}[],phase:CombatPhase,combatants:readonly Combatant[]):CombatOwnerFilter|undefined=>{
    if(prior)nativePhaseFilters.delete(prior);
    const filter=createCombatOwnerFilter(factions);prior=filter;
    if(filter)nativePhaseFilters.set(filter,{phase,combatants});return filter;
  };
}
export function createCombatOwnerFilter(factions:readonly {id:string;teamId:string}[]):CombatOwnerFilter|undefined {
  if(!Array.isArray(factions)||nodeTypes.isProxy(factions)||Object.getPrototypeOf(factions)!==Array.prototype||!factions.length||factions.length>11)return;
  const bits=new Map<string,number>(),teams:string[]=[];
  for(let index=0;index<factions.length;index++){
    const slot=Object.getOwnPropertyDescriptor(factions,String(index));if(!slot||!('value'in slot))return;
    const faction=slot.value;if(!faction||typeof faction!=='object'||nodeTypes.isProxy(faction))return;
    const prototype=Object.getPrototypeOf(faction);if(prototype!==Object.prototype&&prototype!==null)return;
    const id=Object.getOwnPropertyDescriptor(faction,'id'),team=Object.getOwnPropertyDescriptor(faction,'teamId');
    if(!id||!('value'in id)||typeof id.value!=='string'||!team||!('value'in team)||typeof team.value!=='string'||bits.has(id.value))return;
    bits.set(id.value,1<<index);teams.push(team.value);
  }
  const hostile=new Map<string,number>();let index=0;
  for(const id of bits.keys()){let mask=0;for(let other=0;other<teams.length;other++)if(teams[index]!==teams[other])mask|=1<<other;hostile.set(id,mask);index++;}
  const filter=Object.freeze({}) as CombatOwnerFilter;ownerFilters.set(filter,{bits,hostile});return filter;
}
export interface CombatContext {
  state:SimulationState;
  entities?():readonly Entity[];
  id():string;
  hostile(a:string,b:string|null):boolean;
  visible(playerId:string,point:Position):boolean;
  complete(entity:Entity):boolean;
  distance(a:Combatant,b:Combatant):number;
  pointDistance(point:Position,target:Combatant):number;
  meleeClear(a:Combatant,b:Combatant):boolean;
  effect(kind:'impact'|'hit'|'death',point:Position,typeId?:string,projectileKind?:'arrow'|'stone'):void;
  action(entity:Combatant,kind:'attack',durationTicks:number,aim:Position):void;
  definition(entity:Combatant):UnitDefinition|BuildingDefinition;
  ammunition?(unit:Unit,commit:boolean):boolean;
  /** Rechecked at each independently created engagement/combat index. */
  ownerFilter?(phase:'engagement'|'combat',combatants:readonly Combatant[]):CombatOwnerFilter|undefined;
}
const hz=balance.rules.simulationHz;
const centerDistance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
export const activeCombatant=(entity:Entity):entity is Combatant=>entity.kind!=='resource'&&entity.hp>0&&(entity.kind==='unit'?!entity.garrisonedIn:!entity.pendingConstruction);
interface CombatClock {entity:Combatant;ordinal:number;active:boolean;deadline:number;due:number;secondary?:number[]}
const deadlineCounts={frames:0,attempts:0,skippedCooldownContacts:0,skippedProjectileContacts:0,materializations:0};
const countDeadline=(key:keyof typeof deadlineCounts,amount=1)=>{deadlineCounts[key]=Math.min(Number.MAX_SAFE_INTEGER,deadlineCounts[key]+amount);};
/** Internal native-owner lane, bounded to one twelve-contact frame. Deadlines are
 * derived from ordinary saved counters, never retained across a capture. The
 * simulation owns every input and must notify eligibility changes before the
 * next combat phase; generic/callback callers never receive this lane implicitly. */
export class NativeCombatTimeline {
  private clocks=new Map<Combatant,CombatClock>();
  private due=new Map<number,Uint32Array>();
  private ordered:(CombatClock|undefined)[]=[];
  private dirty=new Set<Combatant>();
  private factions=new Map<string,boolean>();
  private projectiles=new Map<number,Projectile[]>();
  private roster:readonly Entity[]|undefined;
  private lastTick:number;
  private active=0;
  private phaseOpen=false;
  private phaseOrdinal=-1;
  private launchesFinished=false;
  private constructor(private state:SimulationState,private endTick:number,startTick:number){this.lastTick=startTick;}
  static create(state:SimulationState,actors:readonly Entity[],startTick:number,endTick:number):NativeCombatTimeline|undefined{
    if(actors.length>MAX_WORLD_ACTORS||state.projectiles.length>20000||endTick-startTick<1||endTick-startTick>12)return;
    // One caller attempt per frame: peaceful zero-cooldown scenes retain the
    // scalar path without allocating clocks or retrying this scan six times.
    if(!actors.some(entity=>activeCombatant(entity)&&!state.economies[entity.ownerId]!.defeated&&entity.cooldown>0)&&!state.projectiles.some(projectile=>projectile.hitTick>startTick+1))return;
    const frame=new NativeCombatTimeline(state,endTick,startTick);frame.synchronize(actors);
    for(const projectile of state.projectiles)frame.addProjectile(projectile);
    countDeadline('frames');return frame;
  }
  static diagnostics(){return {...deadlineCounts};}
  notify(entity:Combatant):void{if(this.clocks.has(entity))this.dirty.add(entity);}
  /** A structure upgrade may add weapon ports between combat events. Resolve
   * existing counters before editing them, then retain their new deadlines so
   * the next roster synchronization cannot overwrite the upgrade's arming delay. */
  prepareWeaponChange(entity:Combatant):void{const clock=this.clocks.get(entity);if(clock)this.materialize(clock);}
  commitWeaponChange(entity:Combatant):void{
    const clock=this.clocks.get(entity);if(!clock)return;
    this.unschedule(clock);clock.deadline=this.lastTick+entity.cooldown;
    if(entity.weaponCooldowns)clock.secondary=entity.weaponCooldowns.map(value=>this.lastTick+value);else delete clock.secondary;
    this.schedule(clock);
  }
  private eligible(entity:Combatant):boolean{return activeCombatant(entity)&&!this.state.economies[entity.ownerId]!.defeated;}
  private unschedule(clock:CombatClock):void{const bucket=this.due.get(clock.due);if(bucket)bucket[clock.ordinal>>>5]!&=~(1<<(clock.ordinal&31));}
  private schedule(clock:CombatClock):void{
    const windup=clock.entity.kind==='unit'?clock.entity.windup?.launchTick:undefined;
    clock.due=Math.max(this.lastTick+1,Math.min(clock.deadline,...clock.secondary??[],windup??Infinity));
    if(!clock.active||clock.due>this.endTick)return;
    let bucket=this.due.get(clock.due);if(!bucket){bucket=new Uint32Array(Math.ceil(this.ordered.length/32));this.due.set(clock.due,bucket);}bucket[clock.ordinal>>>5]!|=1<<(clock.ordinal&31);
  }
  private materialize(clock:CombatClock):void{
    if(clock.active){clock.entity.cooldown=Math.max(0,clock.deadline-this.lastTick);if(clock.secondary)clock.entity.weaponCooldowns=clock.secondary.map(deadline=>Math.max(0,deadline-this.lastTick));countDeadline('materializations');}
  }
  private synchronize(actors:readonly Entity[]):void{
    if(actors!==this.roster){
      const prior=this.clocks,next=new Map<Combatant,CombatClock>();this.due.clear();this.active=0;this.ordered=new Array(actors.length);
      for(let ordinal=0;ordinal<actors.length;ordinal++){
        const entity=actors[ordinal]!;if(entity.kind==='resource')continue;
        const old=prior.get(entity);if(old)this.materialize(old);
        const clock:CombatClock={entity,ordinal,active:this.eligible(entity),deadline:this.lastTick+entity.cooldown,due:0,...(entity.weaponCooldowns?{secondary:entity.weaponCooldowns.map(value=>this.lastTick+value)}:{})};
        next.set(entity,clock);this.ordered[ordinal]=clock;if(clock.active)this.active++;this.schedule(clock);
      }
      this.clocks=next;this.roster=actors;this.dirty.clear();
    }
    for(const faction of this.state.factions){
      const defeated=this.state.economies[faction.id]!.defeated;
      if(this.factions.has(faction.id)&&this.factions.get(faction.id)!==defeated)for(const clock of this.clocks.values())if(clock.entity.ownerId===faction.id)this.dirty.add(clock.entity);
      this.factions.set(faction.id,defeated);
    }
    for(const entity of this.dirty){
      const clock=this.clocks.get(entity);if(!clock)continue;
      const active=this.eligible(entity);if(active===clock.active)continue;
      this.materialize(clock);this.unschedule(clock);this.active+=active?1:-1;clock.active=active;clock.deadline=this.lastTick+entity.cooldown;this.schedule(clock);
    }
    this.dirty.clear();
  }
  /** The roster order is the scalar phase order; the deadline wheel is only a
   * selector. Every current range/visibility/hostility check still runs on due actors. */
  attackers(actors:readonly Entity[],tick:number):Combatant[]{
    if(tick!==this.lastTick+1||tick>this.endTick)throw new Error('INVALID_NATIVE_COMBAT_PHASE');
    this.synchronize(actors);this.lastTick=tick;this.phaseOpen=true;this.phaseOrdinal=-1;this.launchesFinished=false;
    const bucket=this.due.get(tick),clocks:CombatClock[]=[];this.due.delete(tick);
    if(bucket)for(let word=0;word<bucket.length;word++){let bits=bucket[word]!;while(bits){const bit=31-Math.clz32(bits&-bits);bits&=bits-1;const clock=this.ordered[word*32+bit];if(clock)clocks.push(clock);}}
    countDeadline('skippedCooldownContacts',this.active-clocks.length);countDeadline('attempts',clocks.length);
    return clocks.map(clock=>clock.entity);
  }
  beforeAttempt(entity:Combatant):void{const clock=this.clocks.get(entity);if(clock){this.phaseOrdinal=clock.ordinal;this.materialize(clock);}}
  afterAttempt(entity:Combatant):void{
    const clock=this.clocks.get(entity);if(!clock)return;
    clock.deadline=this.lastTick+entity.cooldown;if(entity.weaponCooldowns)clock.secondary=entity.weaponCooldowns.map(value=>this.lastTick+value);this.schedule(clock);
  }
  addProjectile(projectile:Projectile):void{
    const tick=Math.max(this.lastTick+1,projectile.hitTick);if(tick>this.endTick)return;
    let bucket=this.projectiles.get(tick);if(!bucket){bucket=[];this.projectiles.set(tick,bucket);}bucket.push(projectile);
  }
  impacts(tick:number):readonly Projectile[]{
    const due=this.projectiles.get(tick);this.projectiles.delete(tick);
    if(!due)countDeadline('skippedProjectileContacts');return due??[];
  }
  completeLaunches():void{this.launchesFinished=true;}
  completePhase():void{this.phaseOpen=false;}
  /** Unexpected native failures must not advance counters of actors the scalar
   * phase never reached. This also makes finally-based frame capture safe. */
  abortPhase():void{
    if(this.phaseOpen&&!this.launchesFinished)for(const clock of this.clocks.values())if(clock.active&&clock.ordinal>this.phaseOrdinal){clock.deadline++;if(clock.secondary)clock.secondary=clock.secondary.map(deadline=>deadline+1);}
    this.phaseOpen=false;this.flush();
  }
  flush():void{for(const clock of this.clocks.values())this.materialize(clock);this.clocks.clear();this.due.clear();this.ordered=[];this.dirty.clear();this.projectiles.clear();this.roster=undefined;}
}
function combatBounds(entity:Combatant):{halfWidth:number;halfHeight:number}{
  if(entity.kind==='unit'){const radius=units[entity.typeId].collisionRadiusM*1000;return {halfWidth:radius,halfHeight:radius};}
  const [width,height]=buildings[entity.typeId].footprintCells,halfCell=balance.rules.buildingGridM*500;
  return entity.rotation===90||entity.rotation===270?{halfWidth:height*halfCell,halfHeight:width*halfCell}:{halfWidth:width*halfCell,halfHeight:height*halfCell};
}
/** A phase-local broad phase only: callers still apply exact range, fog and hostility. */
export class CombatSpatialIndex {
  private readonly rows=new Map<number,Map<number,number[]>>();
  private readonly cellMm=16000;
  private readonly visited:Uint32Array;
  private queryGeneration=0;
  private queryDepth=0;
  private ownerFilter:OwnerFilterData|undefined;
  private readonly bucketOwners=new WeakMap<number[],number>();
  constructor(private readonly combatants:readonly Combatant[],ownerFilter?:CombatOwnerFilter,phase?:CombatPhase){
    this.ownerFilter=ownerFilter&&ownerFilters.get(ownerFilter);
    const certificate=ownerFilter&&nativePhaseFilters.get(ownerFilter);
    // Consume even a mismatched attempt. It cannot be saved and reused against
    // another phase, a copied roster or a later construction. The private owner
    // performs no callbacks or mutation between minting and this consumption.
    if(ownerFilter)nativePhaseFilters.delete(ownerFilter);
    const native=certificate?.combatants===combatants&&certificate.phase===phase;
    this.visited=new Uint32Array(combatants.length);
    for(let index=0;index<combatants.length;index++){
      const entity=combatants[index]!;let ownerBit=0;
      if(this.ownerFilter){
        if(native)ownerBit=this.ownerFilter.bits.get(entity.ownerId)??0;
        else{
        const prototype=nodeTypes.isProxy(entity)?undefined:Object.getPrototypeOf(entity),owner=prototype===Object.prototype||prototype===null?Object.getOwnPropertyDescriptor(entity,'ownerId'):undefined;
        ownerBit=owner&&'value'in owner?this.ownerFilter.bits.get(owner.value)??0:0;
        if(ownerBit)for(const field of ['kind','typeId','xMm','zMm','rotation']){const descriptor=Object.getOwnPropertyDescriptor(entity,field);if(descriptor?!('value'in descriptor)||descriptor.value!==null&&typeof descriptor.value==='object':field in entity)ownerBit=0;}
        }
        if(!ownerBit)this.ownerFilter=undefined;
      }
      const bounds=combatBounds(entity);
      for(let z=Math.floor((entity.zMm-bounds.halfHeight)/this.cellMm);z<=Math.floor((entity.zMm+bounds.halfHeight)/this.cellMm);z++){
        let row=this.rows.get(z);if(!row){row=new Map();this.rows.set(z,row);}
        for(let x=Math.floor((entity.xMm-bounds.halfWidth)/this.cellMm);x<=Math.floor((entity.xMm+bounds.halfWidth)/this.cellMm);x++){
          let bucket=row.get(x);if(bucket)bucket.push(index);else{bucket=[index];row.set(x,bucket);}
          if(this.ownerFilter)this.bucketOwners.set(bucket,(this.bucketOwners.get(bucket)??0)|ownerBit);
        }
      }
    }
  }
  nearest(origin:Combatant,reachMm:number,eligible:(candidate:Combatant)=>boolean,ownerId?:string,stableIdTies=false):Combatant|undefined {
    const bounds=combatBounds(origin),seen=this.queryDepth?new Set<number>():undefined;
    const hostileMask=ownerId===undefined?undefined:this.ownerFilter?.hostile.get(ownerId);
    // Nested eligibility callbacks own a separate Set; they cannot overwrite
    // the outer query's marks or advance its generation. No marks are saved.
    let generation=0;
    if(!seen){if(this.queryGeneration===0xffffffff){this.visited.fill(0);this.queryGeneration=0;}generation=++this.queryGeneration;}
    this.queryDepth++;try{
    let best:Combatant|undefined,bestDistance=Infinity,bestIndex=Infinity;
    for(let z=Math.floor((origin.zMm-bounds.halfHeight-reachMm)/this.cellMm);z<=Math.floor((origin.zMm+bounds.halfHeight+reachMm)/this.cellMm);z++){
      const row=this.rows.get(z);if(!row)continue;
      for(let x=Math.floor((origin.xMm-bounds.halfWidth-reachMm)/this.cellMm);x<=Math.floor((origin.xMm+bounds.halfWidth+reachMm)/this.cellMm);x++){
        const bucket=row.get(x);if(!bucket||hostileMask!==undefined&&!(this.bucketOwners.get(bucket)!&hostileMask))continue;
        for(const index of bucket){
        if(seen){if(seen.has(index))continue;seen.add(index);}
        else{if(this.visited[index]===generation)continue;this.visited[index]=generation;}
        const candidate=this.combatants[index]!;if(!eligible(candidate))continue;
        const distance=centerDistance(candidate,origin);
        // Bucket traversal order must not replace the original roster's stable ties.
        if(distance<bestDistance||distance===bestDistance&&(stableIdTies?best===undefined||candidate.id<best.id:index<bestIndex)){best=candidate;bestDistance=distance;bestIndex=index;}
        }
      }
    }
    return best;
    }finally{this.queryDepth--;}
  }
  within(point:Position,radiusMm:number):Combatant[]{
    const seen=new Set<number>(),result:Combatant[]=[];
    for(let z=Math.floor((point.zMm-radiusMm)/this.cellMm);z<=Math.floor((point.zMm+radiusMm)/this.cellMm);z++)for(let x=Math.floor((point.xMm-radiusMm)/this.cellMm);x<=Math.floor((point.xMm+radiusMm)/this.cellMm);x++)for(const index of this.rows.get(z)?.get(x)??[])if(!seen.has(index)){seen.add(index);result.push(this.combatants[index]!);}
    return [...seen].sort((a,b)=>a-b).map(index=>this.combatants[index]!);
  }
}
export function attackSnapshot(definition:UnitDefinition|BuildingDefinition):AttackSnapshot {
  return {attack:definition.attack,attackType:definition.attackType!,bonusDamage:'bonusDamage'in definition?{...definition.bonusDamage}:{},...('wardDepletionMultiplier'in definition&&definition.wardDepletionMultiplier?{wardDepletionMultiplier:definition.wardDepletionMultiplier}:{})};
}
export function damageAmount(attack:AttackSnapshot,target:UnitDefinition|BuildingDefinition,multiplier=1):number {
  const bonus=Object.entries(attack.bonusDamage).reduce((sum,[tag,value])=>sum+(target.tags.includes(tag)?value:0),0);
  return Math.max(1,Math.floor((attack.attack+bonus)*multiplier)-target.armor[attack.attackType]);
}
export function inAttackRange(context:CombatContext,attacker:Combatant,target:Combatant):boolean {
  const definition=context.definition(attacker),distance=context.distance(attacker,target),minimum='minRangeM'in definition?definition.minRangeM:0;
  return distance>=minimum*1000&&distance<=definition.rangeM*1000;
}
/** All due impacts and legal launches are collected before any HP mutation. */
export function advanceCombat(context:CombatContext,timeline?:NativeCombatTimeline):void {
  try{
  const {state}=context,damage=new Map<string,{amount:number;attackerId:string}>(),entities=context.entities?.()??Object.values(state.entities);
  let combatants=timeline?undefined:entities.filter(activeCombatant);
  const targets=()=>combatants??=entities.filter(activeCombatant);
  const attackers=timeline?.attackers(entities,state.tick)??combatants!,impacts=timeline?.impacts(state.tick)??state.projectiles;
  const hit=(target:Combatant,attack:AttackSnapshot,sourceId:string,multiplier=1,projectile=false)=>{
    let amount=damageAmount(attack,context.definition(target),multiplier);if(target.kind==='building')amount=absorbWard(target,amount,attack.wardDepletionMultiplier??1,state.tick,projectile);const prior=damage.get(target.id);
    damage.set(target.id,{amount:(prior?.amount??0)+amount,attackerId:sourceId});
  };
  let splashSpatial:CombatSpatialIndex|undefined;
  for(const projectile of impacts)if(projectile.hitTick<=state.tick){
    if(projectile.kind==='arrow'){
      const target=state.entities[projectile.targetId];if(target&&target.kind!=='resource'&&target.hp>0&&!(target.kind==='building'&&target.pendingConstruction)&&context.hostile(projectile.ownerId,target.ownerId)){hit(target,projectile.attack,projectile.sourceId,1,true);if(target.kind!=='unit'||!target.garrisonedIn)context.effect('impact',target,undefined,'arrow');}
    }else{
      const impactTargets=(splashSpatial??=new CombatSpatialIndex(targets())).within(projectile.aim,Math.max(...projectile.bands.map(b=>b.radiusM))*1000);
      for(const target of impactTargets)if(context.hostile(projectile.ownerId,target.ownerId)){
        const distance=target.kind==='unit'&&state.rulesetId!=='legendary_ages_v1'?centerDistance(projectile.aim,target):context.pointDistance(projectile.aim,target);
        const band=projectile.bands.find(b=>distance<=b.radiusM*1000);if(band)hit(target,projectile.attack,projectile.sourceId,band.multiplier,true);
      }
      context.effect('impact',projectile.aim,projectile.sourceTypeId,'stone');
    }
  }
  // A hidden target death must not make the visible launch trajectory vanish early.
  // Missing targets already receive no damage when the scheduled impact resolves.
  if(!timeline||impacts.length)state.projectiles=state.projectiles.filter(projectile=>projectile.hitTick>state.tick);
  let spatial:CombatSpatialIndex|undefined;
  for(const attacker of attackers){
    timeline?.beforeAttempt(attacker);
    try{
    if(state.economies[attacker.ownerId]!.defeated)continue;
    if(!timeline&&attacker.cooldown>0)attacker.cooldown--;
    if(!timeline&&attacker.weaponCooldowns)attacker.weaponCooldowns=attacker.weaponCooldowns.map(value=>Math.max(0,value-1));
    const baseDefinition=context.definition(attacker),ports='weaponPorts'in baseDefinition?baseDefinition.weaponPorts??1:'turret'in baseDefinition&&baseDefinition.turret?2:1;
    if(ports>1)attacker.weaponCooldowns??=Array(ports-1).fill(0);
    const launch=(definition:UnitDefinition|BuildingDefinition,aim:Position,targetId:string|undefined,attack:AttackSnapshot,durationTicks=attacker.cooldown)=>{
      if(attacker.kind==='unit'&&'ammunitionCost'in definition&&definition.ammunitionCost&&context.ammunition&&!context.ammunition(attacker,true))return;
      // Secondary ports have independent clocks. Their visible attack must not
      // inherit a cooling (or idle) primary weapon's remaining duration.
      context.action(attacker,'attack',Math.max(1,durationTicks),aim);
      // Capture the authored port height once. Shooter death, motion or an
      // in-place building upgrade cannot change an already launched trajectory.
      const common={...(attacker.kind==='unit'?{sourceTypeId:attacker.typeId}:{}),...(definition.projectileLaunchHeightM===undefined?{}:{launchHeightMm:Math.round(definition.projectileLaunchHeightM*1000)}),id:context.id(),ownerId:attacker.ownerId,sourceId:attacker.id,from:{xMm:attacker.xMm,zMm:attacker.zMm},aim:{...aim},launchTick:state.tick,hitTick:state.tick+Math.max(1,Math.ceil(centerDistance(attacker,aim)/(definition.projectileSpeedMps*1000)*hz)),attack};
      if('areaDamageBands'in definition&&definition.areaDamageBands){const projectile:Projectile={...common,kind:'stone',bands:structuredClone(definition.areaDamageBands)};state.projectiles.push(projectile);timeline?.addProjectile(projectile);}
      else if(targetId){const projectile:Projectile={...common,kind:'arrow',targetId};state.projectiles.push(projectile);timeline?.addProjectile(projectile);}
    };
    if(attacker.kind==='unit'&&attacker.windup){const windup=attacker.windup;if((attacker.orderRevision??0)!==windup.orderRevision||attacker.xMm!==windup.from.xMm||attacker.zMm!==windup.from.zMm||'deploySeconds'in baseDefinition&&baseDefinition.deploySeconds&&attacker.deploymentState!=='deployed')delete attacker.windup;else if(windup.launchTick<=state.tick){launch(baseDefinition,windup.aim,windup.targetId,windup.attack);delete attacker.windup;}}
    for(let port=0;port<ports;port++){
    const definition=port>0&&'turret'in baseDefinition&&baseDefinition.turret?{...baseDefinition,...baseDefinition.turret,minRangeM:0,windupSeconds:0,ammunitionCost:undefined}:baseDefinition;
    const cooldown=port===0?attacker.cooldown:attacker.weaponCooldowns![port-1]!;
    if(cooldown>0||!definition.attack||(attacker.kind==='building'&&!context.complete(attacker))||(attacker.kind==='unit'&&'deploySeconds'in definition&&definition.deploySeconds&&attacker.deploymentState!=='deployed'))continue;
    if(attacker.kind==='unit'&&units[attacker.typeId].mobileGarrisonCapacity&&(attacker.path.length||attacker.taskState==='moving'&&attacker.lastProgressTick===state.tick))continue;
    const order=attacker.kind==='unit'?attacker.orders[0]:undefined;
    if(attacker.kind==='unit'&&order&&(order.kind==='move'||(!['attack','attack_ground','attack_move','patrol'].includes(order.kind)&&!attacker.engagement)))continue;
    const ground=order?.kind==='attack_ground'?order.target:undefined;
    let targetId=order?.kind==='attack'?order.targetId:attacker.kind==='unit'?attacker.engagement?.targetId:undefined;
    let target=targetId?state.entities[targetId]:undefined;
    if(target&&!activeCombatant(target))target=undefined;
    if(!target&&!ground){
      const roster=targets();spatial??=new CombatSpatialIndex(roster,context.ownerFilter?.('combat',roster),'combat');
      target=spatial.nearest(attacker,definition.rangeM*1000,t=>context.hostile(attacker.ownerId,t.ownerId)&&context.visible(attacker.ownerId,t)&&context.distance(attacker,t)>=('minRangeM'in definition?definition.minRangeM:0)*1000&&context.distance(attacker,t)<=definition.rangeM*1000,attacker.ownerId,Boolean((baseDefinition as BuildingDefinition).weaponPorts||(baseDefinition as UnitDefinition).turret));
    }
    let aim:Position|undefined;
    if(ground){
      if(!('areaDamageBands'in definition)||!definition.areaDamageBands)continue;
      const distance=Math.max(0,centerDistance(attacker,ground)-(attacker.kind==='unit'?units[attacker.typeId].collisionRadiusM*1000:0));
      if(distance<definition.minRangeM*1000||distance>definition.rangeM*1000)continue;
      aim=ground;
    }else{
      if(!target||!activeCombatant(target)||!context.visible(attacker.ownerId,target)||!context.hostile(attacker.ownerId,target.ownerId)||context.distance(attacker,target)<('minRangeM'in definition?definition.minRangeM:0)*1000||context.distance(attacker,target)>definition.rangeM*1000)continue;
      if(definition.projectileSpeedMps===0&&!context.meleeClear(attacker,target))continue;
      aim={xMm:target.xMm,zMm:target.zMm};
    }
    if(attacker.kind==='unit'&&'ammunitionCost'in definition&&definition.ammunitionCost&&context.ammunition&&!context.ammunition(attacker,false))continue;
    const nextCooldown=Math.ceil(definition.attackCooldownSeconds*hz);if(port===0)attacker.cooldown=nextCooldown;else attacker.weaponCooldowns![port-1]=nextCooldown;
    const attack=attackSnapshot(definition);
    if(definition.projectileSpeedMps>0){
      if(attacker.kind==='unit'&&'windupSeconds'in definition&&definition.windupSeconds)attacker.windup={launchTick:state.tick+Math.ceil(definition.windupSeconds*hz),aim:{...aim},...(target?{targetId:target.id}:{}),orderRevision:attacker.orderRevision??0,from:{xMm:attacker.xMm,zMm:attacker.zMm},attack};
      else launch(definition,aim,target?.id,attack,nextCooldown);
    }else if(target&&activeCombatant(target)){context.action(attacker,'attack',nextCooldown,aim);hit(target,attack,attacker.id);}
    }
    }finally{timeline?.afterAttempt(attacker);}
  }
  timeline?.completeLaunches();
  for(const [id,entry]of damage){const target=state.entities[id];if(target&&target.kind!=='resource'&&target.hp>0){target.hp-=entry.amount;timeline?.notify(target);context.effect('hit',target,target.typeId);if(target.kind==='unit'){target.lastAttackerId=entry.attackerId;target.lastDamagedTick=state.tick;}}}
  timeline?.completePhase();
  }catch(error){timeline?.abortPhase();throw error;}
}

/** Rendering coordinates use only the fixed legally observed launch trajectory. */
export function projectilePosition(projectile:Projectile,state:SimulationState):Position&{yMm:number}{
  const progress=Math.min(1,Math.max(0,(state.tick-projectile.launchTick)/(projectile.hitTick-projectile.launchTick)));
  const xMm=Math.round(projectile.from.xMm+(projectile.aim.xMm-projectile.from.xMm)*progress),zMm=Math.round(projectile.from.zMm+(projectile.aim.zMm-projectile.from.zMm)*progress);
  const fromHeight=terrainHeightAt(state.map.terrain,projectile.from.xMm,projectile.from.zMm)+(projectile.launchHeightMm??1500),toHeight=terrainHeightAt(state.map.terrain,projectile.aim.xMm,projectile.aim.zMm)+500;
  const arc=projectile.kind==='stone'?Math.min(10000,centerDistance(projectile.from,projectile.aim)/3):1000;
  return {xMm,zMm,yMm:Math.round(fromHeight+(toHeight-fromHeight)*progress+4*arc*progress*(1-progress))};
}
