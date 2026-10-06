import { balance, buildings, units, type Position } from '@frontier/shared';
import type { Building, Entity, SimulationState, TaskState, Unit } from './state.js';
import { activeCombatant, CombatSpatialIndex, inAttackRange, type CombatContext } from './combat.js';

const hz=balance.rules.simulationHz;
const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
export interface OrderContext extends CombatContext {
  workReachable(unit:Unit,target:Entity):boolean;
  exitPosition(building:Building|Unit,unitType:string,unitId?:string):Position|undefined;
  task(unit:Unit,state:TaskState,reason?:string):void;
  cancelPath(unit:Unit):void;
}
export function beginTransition(unit:Unit,kind:'deploy'|'pack',queueAfterTransition=false):void{
  if(!units[unit.typeId].deploySeconds)return;
  const desired=kind==='deploy'?'deployed':'packed';
  if(unit.deploymentState==='deploying'||unit.deploymentState==='packing'){if(queueAfterTransition)unit.desiredDeployment=desired;return;}
  delete unit.desiredDeployment;if((unit.deploymentState??'packed')===desired)return;
  delete unit.windup;unit.deploymentState=kind==='deploy'?'deploying':'packing';unit.transitionTicks=Math.ceil((kind==='deploy'?units[unit.typeId].deploySeconds!:units[unit.typeId].packSeconds!)*hz);unit.transitionRequired=unit.transitionTicks;unit.path=[];
}
export function advanceTransitions(state:SimulationState,entities:readonly Entity[]=Object.values(state.entities)):void{
  for(const entity of entities)if(entity.kind==='unit'&&Boolean(units[entity.typeId].deploySeconds)&&(entity.deploymentState==='deploying'||entity.deploymentState==='packing')){
    entity.transitionTicks=Math.max(0,(entity.transitionTicks??0)-1);
    if(entity.transitionTicks===0){entity.deploymentState=entity.deploymentState==='deploying'?'deployed':'packed';delete entity.transitionTicks;delete entity.transitionRequired;const desired=entity.desiredDeployment;delete entity.desiredDeployment;if(desired&&desired!==entity.deploymentState)beginTransition(entity,desired==='packed'?'pack':'deploy');}
  }
}
/** Movement commands cannot erase a real deployment or packing transition. */
export function canMove(unit:Unit):boolean{
  if(unit.garrisonedIn)return false;if(!units[unit.typeId].deploySeconds)return true;
  if(unit.deploymentState==='deployed')beginTransition(unit,'pack');
  return (unit.deploymentState??'packed')==='packed';
}
export function updateEngagements(context:OrderContext):void{
  const combatants=(context.entities?.()??Object.values(context.state.entities)).filter(activeCombatant);let spatial:CombatSpatialIndex|undefined;
  for(const unit of combatants){
    if(unit.kind!=='unit'||context.state.economies[unit.ownerId]!.defeated)continue;
    // Routine acquisition cannot cancel a legally committed fixed-aim wind-up.
    // Explicit commands and actual movement still interrupt through cancelPath.
    if(unit.windup)continue;
    const order=unit.orders[0];
    if(order?.kind==='attack'||order?.kind==='attack_ground'||order?.kind==='move'){delete unit.engagement;continue;}
    if(Boolean(units[unit.typeId].deploySeconds)&&unit.deploymentState!=='deployed'&&!order){delete unit.engagement;continue;}
    const attackMoving=order?.kind==='attack_move'||order?.kind==='patrol',economic=Boolean(order&&!attackMoving),military=!units[unit.typeId].tags.includes('worker'),idleMilitary=!order&&military;
    const acquisitionMm=Math.max(units[unit.typeId].visionM,!economic&&military?balance.rules.combatAcquisitionRadiusM:0)*1000;
    const previous=unit.engagement;
    if(previous){
      const target=context.state.entities[previous.targetId],leash=acquisitionMm;
      const retain=target&&activeCombatant(target)&&context.hostile(unit.ownerId,target.ownerId)&&context.visible(unit.ownerId,target)&&(unit.stance!=='stand_ground'||inAttackRange(context,unit,target))&&(unit.stance!=='defensive'||distance(target,previous.anchor)<=leash);
      if(retain){previous.lastKnown={xMm:target.xMm,zMm:target.zMm};continue;}
      delete unit.engagement;context.cancelPath(unit);
      // An idle defensive guard returns to its observed starting position after
      // combat. Reacquiring from each chase endpoint would let its leash creep.
      // Existing attack-move/patrol and queued player orders keep their priority.
      if(idleMilitary&&unit.stance==='defensive'&&distance(unit,previous.anchor)>100){unit.orders.push({kind:'move',target:{...previous.anchor}});context.task(unit,'moving');continue;}
    }
    const mayChase=!economic&&unit.stance!=='stand_ground'&&(attackMoving||unit.stance==='aggressive'||idleMilitary);
    const retaliation=unit.lastAttackerId&&unit.lastDamagedTick!==undefined&&context.state.tick-unit.lastDamagedTick<=Math.ceil(units[unit.typeId].attackCooldownSeconds*hz)*2?unit.lastAttackerId:undefined;
    if(economic&&(!retaliation||unit.stance==='stand_ground'))continue;
    const reach=Math.max(economic?0:context.definition(unit).rangeM*1000,unit.stance!=='stand_ground'&&(mayChase||retaliation)?acquisitionMm:0);
    spatial??=new CombatSpatialIndex(combatants,context.ownerFilter?.('engagement',combatants),'engagement');
    const target=spatial.nearest(unit,reach,enemy=>context.hostile(unit.ownerId,enemy.ownerId)&&context.visible(unit.ownerId,enemy)&&((!economic&&inAttackRange(context,unit,enemy))||((mayChase||enemy.id===retaliation)&&unit.stance!=='stand_ground'&&distance(unit,enemy)<=acquisitionMm)),unit.ownerId);
    if(target){unit.engagement={targetId:target.id,lastKnown:{xMm:target.xMm,zMm:target.zMm},anchor:{xMm:unit.xMm,zMm:unit.zMm}};context.cancelPath(unit);}
  }
}
export function advanceGarrisons(context:OrderContext):void{
  const {state}=context,entities=context.entities?.()??Object.values(state.entities);
  for(const entity of entities){
    if(entity.kind!=='unit'||entity.hp<=0||state.economies[entity.ownerId]!.defeated)continue;
    if(entity.garrisonedIn){
      const building=state.entities[entity.garrisonedIn];if(!building||building.kind==='resource'||!garrisonCapacity(building))continue;
      entity.xMm=building.xMm;entity.zMm=building.zMm;entity.garrisonHealTicks=(entity.garrisonHealTicks??0)+1;
      if(entity.garrisonHealTicks>=hz){entity.hp=Math.min(entity.maxHp,entity.hp+balance.rules.garrisonHealHpPerSecond);entity.garrisonHealTicks-=hz;}
      continue;
    }
    const order=entity.orders[0];if(order?.kind!=='garrison'||entity.engagement)continue;
    const building=state.entities[order.targetId!];
    // A hidden static change is handled by the common last-known pursuit path.
    if(!building||!context.visible(entity.ownerId,building))continue;
    if(building.kind==='resource'||!garrisonCapacity(building)||building.kind==='building'&&!context.complete(building)||context.hostile(entity.ownerId,building.ownerId)||!canBoard(entity,building)){entity.orders.shift();context.cancelPath(entity);continue;}
    if(!context.workReachable(entity,building))continue;
    const occupants=building.garrisoned??=[];
    if(occupants.length>=garrisonCapacity(building)){context.task(entity,'blocked','GARRISON_FULL');continue;}
    occupants.push(entity.id);entity.garrisonedIn=building.id;entity.garrisonHealTicks??=0;entity.xMm=building.xMm;entity.zMm=building.zMm;entity.orders.shift();delete entity.engagement;context.cancelPath(entity);context.task(entity,'idle');
  }
  for(const building of entities)if(building.kind!=='resource'&&building.pendingUngarrison?.length){
    const pending:string[]=[];
    for(const id of building.pendingUngarrison){
      const unit=state.entities[id];if(!unit||unit.kind!=='unit'||unit.garrisonedIn!==building.id)continue;
      const point=context.exitPosition(building,unit.typeId,unit.id);if(!point){pending.push(id);context.task(unit,'blocked','EXIT_BLOCKED');continue;}
      release(unit,building,point);context.cancelPath(unit);context.task(unit,'idle');
    }
    building.pendingUngarrison=pending;
  }
}
function release(unit:Unit,building:Building|Unit,position:Position):void{
  delete unit.garrisonedIn;unit.xMm=position.xMm;unit.zMm=position.zMm;unit.path=[];
  building.garrisoned=building.garrisoned?.filter(id=>id!==unit.id);
}
/** Called after removing only the destroyed host's obstacle, before unit deaths. */
export function ejectDestroyedGarrison(context:OrderContext,building:Building|Unit):void{
  for(const id of [...building.garrisoned??[]]){
    const unit=context.state.entities[id];if(!unit||unit.kind!=='unit')continue;
    const position=context.exitPosition(building,unit.typeId,unit.id);
    if(!position){unit.hp=0;continue;}
    release(unit,building,position);unit.hp-=Math.ceil(unit.maxHp*balance.rules.garrisonEjectionDamageFraction);context.cancelPath(unit);context.task(unit,'idle');
  }
  building.garrisoned=[];building.pendingUngarrison=[];
}

export function garrisonCapacity(entity:Entity):number{return entity.kind==='building'?buildings[entity.typeId].garrisonCapacity:entity.kind==='unit'?units[entity.typeId].mobileGarrisonCapacity??0:0;}
export function canBoard(unit:Unit,host:Entity):boolean{const definition=units[unit.typeId];return definition.canGarrison&&!definition.tags.includes('colossal')&&(host.kind!=='unit'||!definition.tags.includes('worker')&&!definition.tags.includes('siege'));}
