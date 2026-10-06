import { legendaryArmyChoice, developmentContent, nextStructureUpgrade, satisfiesBuilding } from './legendary-ai.js';
import { balance, wallTypeForMaterial, gateTypeForMaterial, buildings, units, type GameplayCommand, type PlayerView, type Position, type UnitId, type BuildingId, type ResourceBank, type ViewEntity } from '@frontier/shared';
import { caretakerCommands, buildingCommand, constructionReconnaissance, constructionAvoidCells, constructionRecoveryCommandValid, maxAiWorkers, missingAgeBuildings, type RulePolicyOptions } from './caretaker.js';
import { controllerPulse } from './controller-schedule.js';
import { Navigation, PathBudgetExceededError } from './navigation.js';
import { commandEntities } from './assistant.js';
import { aiResourceReserve, aiFortifyPlacementCells, armyGoalMembers, commandCost, desiredGoalCommands } from './ai-executor.js';
import { fortifyControllerCommands, markFortifyQueued } from './fortify-planner.js';
import { knownNavigation, scoutDestination, type AiDecisionContext } from './ai-exploration.js';
import { matchesFortifyLayoutEntity, matchesFortifyScreenEntity } from './fortify-geometry.js';
import { resourceWorkBounds } from './forest-navigation.js';
import { effectiveEconomyWeights } from './fallback.js';
import { assessFortification } from './ai-observation.js';
import type { AiCommandProposal, CommanderState, ResourceHandoff, ControllerProfiler } from './ai-controller.js';

const hz=balance.rules.simulationHz,distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const selected=(command:GameplayCommand):string[]=>'unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:'builderId'in command?[command.builderId]:[];
const handoffCommand=(handoff:ResourceHandoff,command:GameplayCommand)=>command.kind===handoff.phase&&'unitIds'in command&&command.unitIds.length===1&&command.unitIds[0]===handoff.workerId&&(command.kind==='gather'?command.targetId===handoff.resourceId:command.kind==='move'&&command.target.xMm===handoff.target.xMm&&command.target.zMm===handoff.target.zMm);
const handoffEnemies=(view:PlayerView)=>{const team=view.players.find(player=>player.id===view.playerId)?.teamId;return view.entities.filter(entity=>{
  if(!entity.ownerId)return false;const owner=view.players.find(player=>player.id===entity.ownerId);if(owner?.teamId===team)return false;
  // Remembered armed structures remain a conservative hazard until ordinary
  // observation updates them. Inert structures still obstruct navigation.
  return entity.kind==='building'?(buildings[entity.typeId]?.attack??0)>0&&!owner?.defeated:entity.kind==='unit'&&!entity.ghost;
});};
function handoffSafe(from:Position,to:Position,enemies:ViewEntity[]):boolean {
  return enemies.every(enemy=>{const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((enemy.xMm-from.xMm)*dx+(enemy.zMm-from.zMm)*dz)/length)):0;
    const structure=enemy.kind==='building'?buildings[enemy.typeId]:undefined;
    // A circumscribed footprint circle covers every rotation, plus the worker's
    // radius and existing 2m caution margin. It intentionally rejects some safe
    // routes beside footprint faces; no unseen position or upgrade is inferred.
    const footprint=structure?Math.hypot(...structure.footprintCells)*balance.rules.buildingGridM*500+units.villager.collisionRadiusM*1000:0;
    const clearance=Math.max(10000,((units[enemy.typeId]?.rangeM??structure?.rangeM??0)+2)*1000+footprint);return Math.hypot(enemy.xMm-from.xMm-dx*t,enemy.zMm-from.zMm-dz*t)>=clearance;});
}
function releaseHandoff(view:PlayerView,state:CommanderState,keepAssignment=false):void {
  const handoff=state.resourceHandoff;if(!handoff)return;
  const interval=balance.ai.difficulty[view.players.find(player=>player.id===view.playerId)?.difficulty??'medium'].strategicIntervalSeconds*hz;
  state.resourceHandoffCooldown={resourceId:handoff.resourceId,untilTick:view.tick+interval};
  if(!keepAssignment&&state.assignments?.[handoff.workerId]===handoff.resource)delete state.assignments[handoff.workerId];
  delete state.resourceHandoff;
}
/** Cancel only our exact unpaid command. In-flight ordinary orders need an ordinary stop. */
function reconcileHandoff(view:PlayerView,state:CommanderState):string|undefined {
  const handoff=state.resourceHandoff;if(!handoff)return;
  const worker=view.entities.find(entity=>entity.id===handoff.workerId&&entity.ownerId===view.playerId&&!entity.ghost&&!entity.garrisonedIn),source=view.entities.find(entity=>entity.id===handoff.resourceId),pending=state.pending.flatMap(batch=>batch.commands),ownPending=pending.some(command=>handoffCommand(handoff,command));
  const foreign=pending.some(command=>selected(command).includes(handoff.workerId)&&!handoffCommand(handoff,command));
  if(worker&&view.tick<handoff.expiresTick&&distance(worker,handoff.lastPosition)>=1000){handoff.lastPosition={xMm:worker.xMm,zMm:worker.zMm};handoff.lastProgressTick=view.tick;}
  const completed=worker&&handoff.phase==='gather'&&!ownPending&&worker.cargo?.resource===handoff.resource&&worker.cargo.amount>0;
  const interrupted=foreign||worker&&(!['idle','move','gather'].includes(worker.order??'idle')||(worker.queuedOrderCount??0)>0||worker.cargo?.resource&&worker.cargo.resource!==handoff.resource&&worker.cargo.amount>0);
  const interval=balance.ai.difficulty[view.players.find(player=>player.id===view.playerId)?.difficulty??'medium'].strategicIntervalSeconds*hz,enemies=handoffEnemies(view);
  const economy=state.plan?.goals.find(goal=>goal.goal.kind==='economy'&&view.tick<goal.expiresTick&&!['rejected','expired'].includes(goal.status));
  const failed=!source||source.resource!==handoff.resource||(source.amount??0)<=0||economy?.goal.kind==='economy'&&economy.goal.weights[handoff.resource]===0||view.tick>=handoff.expiresTick||view.tick-handoff.lastProgressTick>=interval||worker&&(!handoffSafe(worker,worker,enemies)||!handoffSafe(handoff.target,handoff.target,enemies));
  if(!worker||interrupted||completed||failed){
    state.pending=state.pending.map(batch=>({...batch,commands:batch.commands.filter(command=>batch.observedTick!==handoff.issuedTick||!handoffCommand(handoff,command))})).filter(batch=>batch.commands.length);
    if(worker&&!interrupted&&!completed&&['move','gather'].includes(worker.order??''))return worker.id;
    releaseHandoff(view,state,Boolean(interrupted||completed));
  }
  return undefined;
}
function startResourceHandoff(view:PlayerView,state:CommanderState,workers:ViewEntity[],locked:Set<string>,weights:ResourceBank,add:(command:GameplayCommand)=>boolean,context?:AiDecisionContext):void {
  if(state.resourceHandoff||(state.resourceHandoffCooldown?.untilTick??0)>view.tick)return;
  const assignments=state.assignments??(state.assignments={}),farms=state.farmAssignments??(state.farmAssignments={}),farmers=new Set(Object.values(farms)),pending=state.pending.flatMap(batch=>batch.commands),counts=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,workers.filter(worker=>assignments[worker.id]===resource).length])) as ResourceBank;
  const resources=[...balance.resourceOrder].filter(resource=>weights[resource]>0&&counts[resource]<workers.length*weights[resource]/100&&!workers.some(worker=>assignments[worker.id]===resource&&(locked.has(worker.id)||worker.taskState!=='blocked'&&worker.order!=='idle'))).sort((a,b)=>(workers.length*weights[b]/100-counts[b])-(workers.length*weights[a]/100-counts[a]));
  const enemies=handoffEnemies(view),radius=units.villager.collisionRadiusM*1000,interval=balance.ai.difficulty[view.players.find(player=>player.id===view.playerId)?.difficulty??'medium'].strategicIntervalSeconds*hz;
  let nav:Navigation|undefined;
  for(const resource of resources){
    const eligible=workers.filter(worker=>!locked.has(worker.id)&&!farmers.has(worker.id)&&(worker.cargo?.amount??0)===0&&(worker.queuedOrderCount??0)===0&&(worker.order==='idle'||worker.order==='gather'&&worker.taskState==='blocked'&&assignments[worker.id]!==undefined&&counts[assignments[worker.id]!] > workers.length*weights[assignments[worker.id]!]/100)).sort((a,b)=>Number(a.order!=='idle')-Number(b.order!=='idle')||a.id.localeCompare(b.id));
    if(!eligible.length)continue;
    // Retry another equally preferred origin after each failed-probe cooldown.
    // Current cooldowns are whole tactical intervals, so a stable
    // class advances one position without a persisted cursor or extra route work.
    const peers=eligible.filter(worker=>(worker.order==='idle')===(eligible[0]!.order==='idle'));
    const worker=peers[Math.floor(view.tick/interval)%peers.length]!;
    const sources=view.entities.filter(entity=>entity.resource===resource&&(entity.amount??0)>0&&(entity.kind==='resource'||!entity.ghost&&entity.ownerId===view.playerId&&entity.typeId==='farm'&&entity.progress===1&&entity.farmState==='ready'&&!entity.farmerAssigned&&!farms[entity.id]&&!pending.some(command=>command.kind==='gather'&&command.targetId===entity.id||command.kind==='reseed_farm'&&command.farmId===entity.id))).sort((a,b)=>Number(Boolean(a.ghost))-Number(Boolean(b.ghost))||Number(a.id===state.resourceHandoffCooldown?.resourceId)-Number(b.id===state.resourceHandoffCooldown?.resourceId)||distance(a,worker)-distance(b,worker)||a.id.localeCompare(b.id)).slice(0,4);
    if(!sources.length)continue;
    const geometry=nav??context?.navigation(view)??knownNavigation(view),budget={remaining:8000,used:0};nav??=context?.query(view,geometry,512,budget)??new Navigation(view.map.widthMm,view.map.heightMm,geometry.obstacles,512,1000,budget);
    for(const source of sources){
      // Retain the ordinary resource trip's conservative standoff; a forest
      // destination additionally clears the full occupied cell.
      const half=source.kind==='building'?Math.max(...buildings[source.typeId].footprintCells)*1000:Math.max(650,resourceWorkBounds(source).halfWidth),offset=half+1500,points=[[-1,0],[0,-1],[1,0],[0,1],[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,z])=>({xMm:source.xMm+x!*offset,zMm:source.zMm+z!*offset})).sort((a,b)=>distance(a,worker)-distance(b,worker));
      // A later exhausted endpoint must not bypass an already observed unsafe
      // route for this source. A completed safe alternative can still be used.
      let unsafeRoute=false;
      try{for(const target of points){
        if(!nav.free(target,radius)||!handoffSafe(target,target,enemies))continue;
        let path:Position[]|null|undefined,length=distance(worker,target);
        try{path=nav.clearLine(worker,target,radius)?[target]:nav.path(worker,target,radius);}
        catch(error){
          if(!(error instanceof PathBudgetExceededError)||!source.ghost||unsafeRoute||!handoffSafe(worker,target,enemies))throw error;
          // Only a checked remembered destination may become an ordinary move
          // attempt when route work runs out. Its detour is unverified; the
          // movement scheduler and existing danger/progress/expiry checks remain
          // authoritative. No gather is sent before the source is seen again.
          path=undefined;
        }
        if(path===null)continue;
        if(path){let previous:Position=worker;length=0;const safe=path.every(point=>{length+=distance(previous,point);const valid=handoffSafe(previous,point,enemies);previous=point;return valid;});if(!safe){unsafeRoute=true;continue;}}
        const phase=source.ghost?'move':'gather',command:GameplayCommand=phase==='move'?{kind:'move',unitIds:[worker.id],target,queued:false}:{kind:'gather',unitIds:[worker.id],targetId:source.id,queued:false};
        if(!add(command))return;
        const lifetime=Math.min(4*balance.ai.goalTtlSeconds*hz,Math.max(balance.ai.goalTtlSeconds*hz,Math.ceil(length/(units.villager.moveSpeedMps*1000)*hz)*2+interval));
        state.resourceHandoff={workerId:worker.id,resourceId:source.id,resource,phase,target,issuedTick:view.tick,expiresTick:view.tick+lifetime,lastProgressTick:view.tick,lastPosition:{xMm:worker.xMm,zMm:worker.zMm}};assignments[worker.id]=resource;
        for(const [farmId,workerId]of Object.entries(farms))if(workerId===worker.id)delete farms[farmId];if(source.typeId==='farm')farms[source.id]=worker.id;
        return;
      }}catch(error){if(!(error instanceof PathBudgetExceededError))throw error;}
    }
    // A bounded failed probe is a retry delay, never a claim about hidden depletion.
    state.resourceHandoffCooldown={resourceId:sources[0]!.id,untilTick:view.tick+interval};return;
  }
}
/** Conquest survives the loss of a Town Center. Only unused, unprotected forces
 * receive missions; explicit model squads and current travel retain ownership. */
function maintainConquest(view:PlayerView,state:CommanderState,army:ViewEntity[],home:ViewEntity|undefined,locked:ReadonlySet<string>,add:(command:GameplayCommand)=>boolean,context?:AiDecisionContext):void{
  const faction=view.players.find(player=>player.id===view.playerId)!,difficulty=faction.difficulty??'medium',policy=balance.ai.difficulty[difficulty],rules=balance.ai.rulePolicies[difficulty];
  if(view.tick<policy.initialBaseAssaultNotBeforeSeconds*hz)return;
  const missions=new Set((state.plan?.goals??[]).flatMap(goal=>{if(goal.goal.kind!=='army_order'||goal.expiresTick<=view.tick||['rejected','expired'].includes(goal.status)||goal.status==='fulfilled'&&!['defend','assist','rally','retreat'].includes(goal.goal.order))return [];return armyGoalMembers(view,state,goal,army).map(unit=>unit.id);}));
  const ready=army.filter(unit=>!missions.has(unit.id)&&!locked.has(unit.id)&&!unit.queuedOrderCount&&unit.order==='idle'&&unit.hp>=unit.maxHp*rules.retreatHpFraction),escorts=ready.filter(unit=>!units[unit.typeId].tags.includes('siege'));
  if(!escorts.length)return;
  const known=view.entities.filter(entity=>entity.ownerId&&entity.hp>0&&view.players.some(player=>player.id===entity.ownerId&&player.teamId!==faction.teamId&&!player.defeated)&&(!entity.ghost||entity.kind==='building'));
  if(home&&known.some(enemy=>enemy.kind==='unit'&&distance(enemy,home)<25000))return;
  const origin=home??escorts[0]!,rank=(entity:ViewEntity)=>entity.typeId==='town_center'?0:entity.typeId==='villager'?1:entity.kind==='unit'?2:buildings[entity.typeId]?.produces?.length?3:4;
  const target=known.sort((a,b)=>rank(a)-rank(b)||distance(a,origin)-distance(b,origin)||a.id.localeCompare(b.id))[0];
  if(!target){
    // A surviving army without a base still searches ordinary fog frontiers;
    // there are no hidden faction coordinates or unseen-unit targets here.
    if(!home){const explorer=escorts[0]!,point=scoutDestination(view,explorer,[],context?.navigation(view)??knownNavigation(view),state.scoutIndex,undefined,context);if(point&&add({kind:'attack_move',unitIds:[explorer.id],target:point,queued:false}))state.scoutIndex++;}
    return;
  }
  const required=target.kind==='unit'?1:home?Math.max(4,Math.floor((rules.armyTargetsByAge[Math.min(3,view.self.age-1)]??4)/3)):4;
  if(escorts.length<required)return;
  // Decline an autonomous all-in against an observed stronger defending army.
  // This is a policy estimate using disclosed HP and public unit definitions,
  // never inferred hidden upgrades or forces. Explicit model missions remain.
  const strength=(unit:ViewEntity)=>unit.hp*Math.max(1,units[unit.typeId].attack);
  const defenders=known.filter(entity=>entity.kind==='unit'&&!units[entity.typeId].tags.includes('worker')&&distance(entity,target)<25000);
  if(defenders.reduce((sum,unit)=>sum+strength(unit),0)>escorts.reduce((sum,unit)=>sum+strength(unit),0))return;
  if(target.ghost){
    let [width,depth]=buildings[target.typeId].footprintCells;if(target.rotation===90||target.rotation===270)[width,depth]=[depth,width];
    const nav=context?.navigation(view)??knownNavigation(view),radius=Math.max(...ready.map(unit=>units[unit.typeId].collisionRadiusM*1000));
    const point=[{xMm:target.xMm-width*1000-2500,zMm:target.zMm},{xMm:target.xMm+width*1000+2500,zMm:target.zMm},{xMm:target.xMm,zMm:target.zMm-depth*1000-2500},{xMm:target.xMm,zMm:target.zMm+depth*1000+2500}].sort((a,b)=>distance(a,origin)-distance(b,origin)).find(point=>nav.free(point,radius));
    if(point)add({kind:'attack_move',unitIds:ready.map(unit=>unit.id),target:point,queued:false});
  }else add({kind:'attack_target',unitIds:ready.map(unit=>unit.id),targetId:target.id,queued:false});
}
/** Policy changes decisions only. Every input is a player-filtered view and owned memory. */
export function commanderCommands(view:PlayerView,state:CommanderState,profiler?:ControllerProfiler,protectedIds?:ReadonlySet<string>,context?:AiDecisionContext):AiCommandProposal[]{
  const faction=view.players.find(player=>player.id===view.playerId)!,difficulty=faction.difficulty??'medium',personality=faction.personality??'builder',policy=balance.ai.difficulty[difficulty],rules=balance.ai.rulePolicies[difficulty],preferences=balance.ai.personalityPolicies[personality];
  for(const goal of state.plan?.goals??[])if(view.tick>=goal.expiresTick&&!['fulfilled','rejected','expired'].includes(goal.status)){goal.status='expired';goal.reason='GOAL_EXPIRED';}
  const activePlan=state.plan;state.pending=state.pending.filter(batch=>!batch.goalKey||activePlan&&activePlan.generation===batch.planGeneration&&activePlan.goals.some(goal=>goal.key===batch.goalKey&&view.tick<goal.expiresTick));
  const handoffStop=reconcileHandoff(view,state);
  const dueBatches=new Set(state.pending.filter(batch=>batch.executeTick<=view.tick)),due:AiCommandProposal[]=[...dueBatches].flatMap(batch=>batch.commands.filter(command=>constructionRecoveryCommandValid(view,command,protectedIds)).map(command=>({command,...(batch.goalKey?{goalKey:batch.goalKey,planGeneration:batch.planGeneration}:{})})));
  const finish=()=>{state.pending=state.pending.filter(batch=>!dueBatches.has(batch));return due;};
  if(state.plan&&view.tick>=state.plan.expiresTick){state.mode='fallback';state.reason='PLAN_EXPIRED';for(const goal of state.plan.goals)if(!['fulfilled','rejected','expired'].includes(goal.status)){goal.status='expired';goal.reason='GOAL_EXPIRED';}}
  if(!controllerPulse(view,policy.tacticalIntervalSeconds*hz))return finish();
  // Keep due proposals reserved while making the next decision from the pre-command view.
  // The caller admits them immediately after this function returns; they must not be bought twice.
  for(const batch of dueBatches)batch.executeTick=view.tick+1;
  const enqueue=(proposal:AiCommandProposal):boolean=>{if(state.pending.length>=59||protectedIds&&commandEntities(proposal.command).some(id=>protectedIds.has(id)))return false;state.pending.push({observedTick:view.tick,executeTick:view.tick+Math.ceil(policy.reactionDelaySeconds*hz),commands:[proposal.command],...(proposal.goalKey?{goalKey:proposal.goalKey,planGeneration:proposal.planGeneration}:{})});return true;};
  if(handoffStop&&enqueue({command:{kind:'stop',unitIds:[handoffStop]}}))releaseHandoff(view,state);
  for(const command of constructionReconnaissance(view,state,undefined,undefined,{protectedIds,pending:state.pending.flatMap(batch=>batch.commands),context}))enqueue({command});
  desiredGoalCommands(view,state,enqueue,protectedIds,context);
  if(state.resourceHandoff&&state.pending.some(batch=>batch.commands.some(command=>selected(command).includes(state.resourceHandoff!.workerId)&&!handoffCommand(state.resourceHandoff!,command))))releaseHandoff(view,state,true);
  const roster=context?.roster(view),own=roster?.owned??view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),home=own.find(entity=>entity.typeId==='town_center'&&entity.progress===1),workers=roster?.workers??own.filter(entity=>entity.typeId==='villager'&&!entity.garrisonedIn),army=roster?.army??own.filter(entity=>entity.kind==='unit'&&!['villager','scout'].includes(entity.typeId)&&!entity.garrisonedIn),complete=roster?.complete??own.filter(entity=>entity.kind==='building'&&entity.progress===1);
  if(!home){
    if(view.tick>=state.nextStrategicTick){maintainConquest(view,state,army,undefined,new Set([...state.pending.flatMap(batch=>batch.commands.flatMap(selected)),...(protectedIds??[])]),command=>enqueue({command}),context);state.nextStrategicTick=view.tick+policy.strategicIntervalSeconds*hz;}
    // Losing the Town Center is not defeat while villagers survive. Keep the
    // ordinary caretaker alive to repair/rebuild a home and maintain gathering.
    const economyGoal=state.plan?.goals.find(goal=>goal.goal.kind==='economy'&&view.tick<goal.expiresTick&&!['rejected','expired'].includes(goal.status));
    due.push(...caretakerCommands(view,state,{difficulty,targetWorkers:rules.targetWorkers,retreatHpFraction:rules.retreatHpFraction,housingBuffer:rules.housingBuffer,workerReserve:rules.workerReserve,protectedEntityIds:protectedIds,reservedWorkerIds:[...(state.resourceHandoff?[state.resourceHandoff.workerId]:[]),...(protectedIds??[])],resourceWeights:economyGoal?.goal.kind==='economy'?economyGoal.goal.weights:preferences.resourceWeights},profiler,context).map(command=>({command})));
    return finish();
  }
  const ageBuildings=missingAgeBuildings(view,context),unpaidAgeBuilding=ageBuildings.some(type=>!own.some(entity=>entity.kind==='building'&&entity.typeId===type));
  const enemies=roster?.enemies??view.entities.filter(entity=>entity.ownerId&&entity.ownerId!==view.playerId&&!entity.ghost&&view.players.find(player=>player.id===entity.ownerId)?.teamId!==faction.teamId),locked=new Set([...state.pending.flatMap(batch=>batch.commands.flatMap(selected)),...(protectedIds??[]),...state.constructionRecon?.members.map(member=>member.id)??[]]);
  const add=(command:GameplayCommand|undefined,additionalCommitted:readonly GameplayCommand[]=[]):boolean=>{
    if(!command||selected(command).some(id=>locked.has(id)))return false;
    if(unpaidAgeBuilding&&(command.kind==='build'||command.kind==='build_wall'))return false;
    const cost=commandCost(command,view);
    if(cost){
      const committed=[...state.pending.flatMap(batch=>batch.commands),...additionalCommitted],bank={...view.self.resources},reserve=aiResourceReserve(view,workers.length,committed,context);
      for(const prior of committed){const price=commandCost(prior,view);if(price)for(const resource of balance.resourceOrder)bank[resource]-=price[resource];}
      if(balance.resourceOrder.some(resource=>bank[resource]<cost[resource]||cost[resource]>0&&bank[resource]-cost[resource]<reserve[resource]))return false;
    }
    if(!enqueue({command}))return false;for(const id of selected(command))locked.add(id);return true;
  };
  const handoff=state.resourceHandoff;
  if(handoff){const source=view.entities.find(entity=>entity.id===handoff.resourceId);if(!handoffStop&&handoff.phase==='move'&&source&&!source.ghost&&(source.amount??0)>0&&add({kind:'gather',unitIds:[handoff.workerId],targetId:source.id,queued:false})){handoff.phase='gather';handoff.issuedTick=view.tick;}locked.add(handoff.workerId);}
  const preferred=preferences.preferredUnits.filter(id=>units[id].minAge<=view.self.age) as UnitId[],seen=[...Object.values(state.seenEnemies),...enemies],cavalry=seen.filter(entity=>units[entity.typeId]?.tags.includes('cavalry')).length,ranged=seen.filter(entity=>units[entity.typeId]?.tags.includes('ranged')).length;
  let desired:UnitId=preferred.find(type=>own.filter(entity=>entity.typeId===type).length<Math.max(1,Math.ceil(army.length/preferred.length)))??preferred[0]??'militia';
  if(difficulty!=='easy'){if(cavalry>ranged)desired='spearman';else if(ranged&&view.self.age>=2)desired='skirmisher';else if(difficulty==='hard'&&view.self.age>=3&&enemies.some(entity=>entity.kind==='building')&&!army.some(entity=>units[entity.typeId].tags.includes('siege')))desired='battering_ram';}
  const knownOpponents=view.entities.filter(entity=>entity.ownerId&&entity.hp>0&&view.players.some(player=>player.id===entity.ownerId&&player.teamId!==faction.teamId&&!player.defeated)&&(!entity.ghost||entity.kind==='building'));
  const knownBases=knownOpponents.filter(entity=>entity.typeId==='town_center');
  // All personalities need a way to break a known base. Food starvation must
  // not stall affordable wood/gold armies while their economy recovers.
  const desiredCost=units[desired].cost;
  if(balance.resourceOrder.some(resource=>view.self.resources[resource]<desiredCost[resource]))desired=preferred.find(type=>balance.resourceOrder.every(resource=>view.self.resources[resource]>=units[type].cost[resource]))??(view.self.age>=2&&view.self.resources.wood>=units.archer.cost.wood&&view.self.resources.gold>=units.archer.cost.gold?'archer':desired);
  if(view.self.age>=3&&knownBases.length&&army.filter(unit=>!units[unit.typeId].tags.includes('siege')).length>=4&&army.filter(unit=>units[unit.typeId].tags.includes('siege')).length<Math.max(1,Math.floor(army.length/8)))desired='battering_ram';
  desired=(legendaryArmyChoice(view,own,enemies) as UnitId|undefined)??desired;
  const threat=enemies.filter(enemy=>enemy.kind==='unit').sort((a,b)=>a.hp-b.hp||a.id.localeCompare(b.id))[0];
  if(difficulty==='hard'){
    // The observation is borrowed synchronously and remains unchanged here.
    // Build this geometry only when a tactical query needs it, once per pulse.
    let navigation:Navigation|undefined;const nav=()=>navigation??=context?.navigation(view)??knownNavigation(view);
    const scout=own.find(unit=>unit.typeId==='scout'&&!unit.garrisonedIn&&!unit.queuedOrderCount&&!locked.has(unit.id)&&((unit.order??'idle')==='idle'||unit.order==='move'&&unit.taskState==='blocked'));
    if(scout&&view.tick>=state.nextScoutTick){
      const avoid=scout.taskState==='blocked'&&state.scoutRoute&&view.tick-state.scoutRoute.issuedTick<60*hz?state.scoutRoute.target:undefined;
      const safe=scoutDestination(view,scout,enemies,nav(),state.scoutIndex,avoid,context);
      if(safe&&add({kind:'move',unitIds:[scout.id],target:safe,queued:false})){state.scoutIndex++;state.scoutRoute={target:{...safe},issuedTick:view.tick};}
    }
    // At most six ranged bodies kite per decision; safe straight segments use only known geometry.
    for(const unit of army.filter(unit=>units[unit.typeId].tags.includes('ranged')&&!units[unit.typeId].tags.includes('siege')).slice(0,6)){
      const enemy=enemies.filter(enemy=>enemy.kind==='unit'&&distance(enemy,unit)<4500).sort((a,b)=>distance(a,unit)-distance(b,unit))[0];if(!enemy)continue;
      const dx=unit.xMm-enemy.xMm,dz=unit.zMm-enemy.zMm,length=Math.hypot(dx,dz)||1,target={xMm:Math.round(unit.xMm+dx/length*3000),zMm:Math.round(unit.zMm+dz/length*3000)};
      if(nav().clearLine(unit,target,units[unit.typeId].collisionRadiusM*1000))add({kind:'move',unitIds:[unit.id],target,queued:false});
    }
    if(threat){const ready=army.filter(unit=>!locked.has(unit.id)&&distance(unit,threat)<18000&&['idle','attack_move','patrol'].includes(unit.order??'idle')).map(unit=>unit.id);if(ready.length)add({kind:'attack_target',unitIds:ready,targetId:threat.id,queued:false});}
    // Fast troops take a legal lateral approach to an observed worker; blocked flanks fall back to normal combat.
    const raiders=army.filter(unit=>units[unit.typeId].tags.includes('cavalry')&&!locked.has(unit.id)&&unit.order==='idle'),worker=enemies.find(enemy=>enemy.typeId==='villager');
    if(worker&&raiders.length){const target={xMm:worker.xMm+6000,zMm:worker.zMm};if(nav().clearLine(raiders[0]!,target,units[raiders[0]!.typeId].collisionRadiusM*1000))add({kind:'attack_move',unitIds:raiders.map(unit=>unit.id),target,queued:false});}
  }
  for(const unit of army.filter(unit=>units[unit.typeId].deploySeconds&&!unit.queuedOrderCount).slice(0,12)){
    const target=enemies.filter(enemy=>enemy.kind==='building').sort((a,b)=>distance(a,unit)-distance(b,unit))[0];if(!target)continue;
    if(distance(unit,target)<=units[unit.typeId].rangeM*1000&&distance(unit,target)>=units[unit.typeId].minRangeM*1000&&unit.deploymentState==='packed')add({kind:'deploy',unitIds:[unit.id]});
    else if((distance(unit,target)>units[unit.typeId].rangeM*1000||distance(unit,target)<units[unit.typeId].minRangeM*1000)&&unit.deploymentState==='deployed')add({kind:'pack',unitIds:[unit.id]});
  }
  if(view.rulesetId==='legendary_ages_v1'&&view.self.age>=6){
    // Bounded local counterplay uses only this recipient's current enemies.
    // Orders still pass ordinary visibility, ownership and clearance checks.
    const spires=enemies.filter(enemy=>enemy.kind==='building'&&enemy.typeId==='ward_spire'&&!enemy.ghost);
    for(const unit of army.filter(unit=>!locked.has(unit.id)&&!unit.queuedOrderCount&&['idle','attack_move'].includes(unit.order??'idle')&&units[unit.typeId].minAge>=5).slice(0,4)){
      const definition=units[unit.typeId],spire=spires.filter(target=>distance(unit,target)<=definition.rangeM*1000+20000).sort((a,b)=>distance(unit,a)-distance(unit,b))[0];
      if(spire)add({kind:'attack_target',unitIds:[unit.id],targetId:spire.id,queued:false});
    }
    if(difficulty!=='easy'){
      const exposed=army.find(unit=>unit.deploymentState==='deployed'&&enemies.some(enemy=>enemy.kind==='unit'&&distance(enemy,unit)<14000));
      const escorts=exposed?army.filter(unit=>!locked.has(unit.id)&&!unit.queuedOrderCount&&unit.order==='idle'&&units[unit.typeId].minAge<5&&distance(unit,exposed)>7000).slice(0,4):[];
      if(exposed&&escorts.length)add({kind:'attack_move',unitIds:escorts.map(unit=>unit.id),target:{xMm:exposed.xMm,zMm:exposed.zMm},queued:false});
    }
  }
  // Farms compete with natural food at the same distance preference. A farmer
  // returning cargo, or a delayed/due gather proposal, still reserves its farm.
  const idle=workers.find(worker=>!locked.has(worker.id)&&worker.order==='idle'),assignments=state.assignments??(state.assignments={}),farmAssignments=state.farmAssignments??(state.farmAssignments={});
  const pending=state.pending.flatMap(batch=>batch.commands),pendingFarms=new Set(pending.flatMap(command=>command.kind==='gather'?[command.targetId]:command.kind==='reseed_farm'?[command.farmId]:[]));
  for(const [farmId,workerId]of Object.entries(farmAssignments)){
    const worker=workers.find(worker=>worker.id===workerId),orders=pending.filter(command=>selected(command).includes(workerId));
    if(!own.some(entity=>entity.id===farmId&&entity.typeId==='farm')||!worker||(orders.length?!orders.some(command=>command.kind==='gather'&&command.targetId===farmId||command.kind==='reseed_farm'&&command.farmId===farmId):!['gather','reseed'].includes(worker.order??'')||worker.blockedReason==='FARM_OCCUPIED'))delete farmAssignments[farmId];
  }
  const economyGoal=state.plan?.goals.find(goal=>goal.goal.kind==='economy'&&view.tick<goal.expiresTick&&!['rejected','expired'].includes(goal.status)),weights=effectiveEconomyWeights(view,economyGoal?.goal.kind==='economy'?economyGoal.goal.weights:preferences.resourceWeights);
  if(idle){
    const idleWeights=effectiveEconomyWeights(view,preferences.resourceWeights),resources=[...balance.resourceOrder].sort((a,b)=>(workers.length*idleWeights[b]/100-Object.values(assignments).filter(value=>value===b).length)-(workers.length*idleWeights[a]/100-Object.values(assignments).filter(value=>value===a).length));
    for(const resource of resources){
      const node=view.entities.filter(entity=>!entity.ghost&&entity.resource===resource&&(entity.amount??0)>0&&(entity.kind==='resource'||resource==='food'&&entity.kind==='building'&&entity.typeId==='farm'&&entity.ownerId===view.playerId&&entity.progress===1&&entity.farmState==='ready'&&!entity.farmerAssigned&&!farmAssignments[entity.id]&&!pendingFarms.has(entity.id))).sort((a,b)=>distance(a,idle)-distance(b,idle))[0];
      if(!node)continue;
      if(add({kind:'gather',unitIds:[idle.id],targetId:node.id,queued:false})){
        assignments[idle.id]=resource;
        for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===idle.id)delete farmAssignments[farmId];
        if(node.typeId==='farm')farmAssignments[node.id]=idle.id;
      }
      break;
    }
  }
  startResourceHandoff(view,state,workers,locked,weights,add,context);
  const routinePlacementCells=()=>[...aiFortifyPlacementCells(view,state),...constructionAvoidCells(view,state)];
  let defenseProposal:{commands:GameplayCommand[];memory:CommanderState['fortifications'][string];urgentEconomy:boolean}|undefined;
  const strategic=view.tick>=state.nextStrategicTick;
  if(strategic&&state.mode==='fallback'){
    const free=workers.filter(worker=>!locked.has(worker.id)&&!['build','reseed'].includes(worker.order??'')),pendingBuild=state.pending.some(batch=>batch.commands.some(command=>command.kind==='build'||command.kind==='build_wall'))||own.some(entity=>entity.kind==='building'&&(entity.progress??1)<1);
    if(!pendingBuild&&!ageBuildings.length){const missing=preferences.infrastructure.find(type=>buildings[type].minAge<=view.self.age&&!own.some(entity=>entity.typeId===type));
      const desiredBases=rules.baseTargetsByAge[Math.min(3,view.self.age-1)]??1,remote=view.entities.find(entity=>entity.kind==='resource'&&!entity.ghost&&distance(entity,home)>22000);
      const lateInfrastructure=view.self.age>=5?developmentContent(view).filter(building=>building.minAge<=view.self.age&&(!building.family||building.family==='citadel')).sort((a,b)=>b.minAge-a.minAge).find(building=>!own.some(entity=>satisfiesBuilding(entity.typeId,building.id)||entity.upgrade&&satisfiesBuilding(entity.upgrade.targetTypeId,building.id)))?.id:undefined;
      const type=own.filter(entity=>entity.typeId==='town_center').length<desiredBases&&view.self.age>=3&&remote?'town_center':missing??lateInfrastructure;
      if(type&&!buildings[type].requiredTechnologies?.some(id=>!view.self.technologies?.includes(id))&&balance.resourceOrder.every(resource=>view.self.resources[resource]>=buildings[type].cost[resource]+(resource==='food'?50*rules.workerReserve:resource==='wood'?buildings.house.cost.wood:0))){const action=nextStructureUpgrade(view,type as BuildingId,protectedIds)??buildingCommand(view,type as BuildingId,type==='town_center'?remote!:home,free,state.buildAttempt++,routinePlacementCells());if(action)add(action);else if(!state.constructionRecon)for(const command of constructionReconnaissance(view,state,type as BuildingId,home,{protectedIds,unavailable:locked,avoidCells:routinePlacementCells(),pending:state.pending.flatMap(batch=>batch.commands),context}))add(command);for(const member of state.constructionRecon?.members??[])locked.add(member.id);}
    }
    if(preferences.assistAllies){const ally=view.entities.find(entity=>entity.typeId==='town_center'&&entity.ownerId!==view.playerId&&view.players.find(player=>player.id===entity.ownerId)?.teamId===faction.teamId&&enemies.some(enemy=>distance(enemy,entity)<25000));const available=army.filter(unit=>!locked.has(unit.id)&&unit.order==='idle');if(ally&&available.length)add({kind:'attack_move',unitIds:available.map(unit=>unit.id),target:{xMm:ally.xMm+10000,zMm:ally.zMm},queued:false});}
    if(personality==='diplomat'){const ally=view.players.find(player=>player.id!==view.playerId&&player.teamId===faction.teamId&&!player.defeated),key=ally?`diplomat:${ally.id}:wood`:'';if(ally&&!state.tributeCredits[key]&&view.self.resources.wood>=400){add({kind:'tribute',recipientId:ally.id,resource:'wood',amount:50});/* credit is recorded only after ordinary admission */}}
  }
  // Defensive construction is tactical maintenance in both model and fallback
  // modes. An explicit fortify goal keeps priority; never create a competing site.
  // The legacy "fallback" memory key also preserves paid work across renewals.
  const priorFortify=state.fortifications.fallback,priorMaterial=priorFortify&&(priorFortify.layout||priorFortify.screen)?(['palisade','stone','bastion','runestone','titan','eternal'] as const).find(material=>priorFortify.goalKey===`${view.playerId}:${home.id}:${material}:18`):undefined;
  const modelFortify=state.plan?.goals.some(goal=>goal.kind==='fortify'&&goal.expiresTick>view.tick&&!['rejected','expired'].includes(goal.status));
  const defense=strategic&&!modelFortify?assessFortification(view,home):undefined;
  const beginDefense=strategic&&defense?.wallCells===0&&(preferences.fortify&&(view.self.age>=3||view.self.resources.wood>=500||defense.reason==='established_economy')||view.self.age>=2&&workers.length>=6&&defense.reason==='exposed_economy');
  if(!modelFortify&&(priorMaterial||beginDefense)){
    // Prefer durable walls only if a gate is affordable; lacking stone must not
    // permanently prevent a threatened mature economy from using palisades.
    const lateMaterial=([...(['eternal','titan','runestone','bastion'] as const)].find(material=>view.rulesetId==='legendary_ages_v1'&&buildings[wallTypeForMaterial(material)].minAge<=view.self.age&&view.self.resources.stone>=buildings[gateTypeForMaterial(material)].cost.stone));
    const material=priorMaterial??lateMaterial??(view.self.age>=buildings.stone_wall.minAge&&(view.self.resources.stone>=buildings.stone_gate.cost.stone||own.some(entity=>entity.typeId==='stone_gate'&&distance(entity,home)<30000))?'stone':'palisade');
    const matchesDefense=(entity:ViewEntity)=>Boolean(priorMaterial&&(priorFortify?.layout&&matchesFortifyLayoutEntity(priorFortify.layout,material,entity)||priorFortify?.screen&&matchesFortifyScreenEntity(priorFortify.screen,material,entity)));
    // One independently staffed foundation need not suspend all defensive work.
    // New spending still waits for age dependencies and the current decision's
    // infrastructure purchases, and never diverts their occupied builders.
    const unrelatedBuild=ageBuildings.length>0||state.pending.some(batch=>batch.commands.some(command=>command.kind==='build'||command.kind==='build_wall'))||own.filter(entity=>entity.kind==='building'&&(entity.progress??1)<1&&!matchesDefense(entity)).length>=2;
    if(priorMaterial||!unrelatedBuild){
      const bank={...view.self.resources},committed=state.pending.flatMap(batch=>batch.commands),reserve=aiResourceReserve(view,workers.length,committed);
      for(const command of committed){const cost=commandCost(command,view);if(cost)for(const resource of balance.resourceOrder)bank[resource]-=cost[resource];}
      const urgentEconomy=view.self.population+view.self.reservedPopulation>=view.self.populationCap&&view.self.populationCap<view.self.populationLimit||bank.food<units.villager.cost.food*2&&bank.wood>=buildings.farm.cost.wood&&!view.entities.some(entity=>!entity.ghost&&entity.resource==='food'&&(entity.amount??0)>0&&(entity.kind==='resource'||entity.ownerId===view.playerId&&entity.progress===1));
      const available={...view,self:{...view.self,resources:Object.fromEntries(balance.resourceOrder.map(resource=>[resource,Math.max(0,bank[resource]-reserve[resource])])) as ResourceBank}},eligible=new Set(workers.filter(worker=>!unrelatedBuild&&!locked.has(worker.id)&&!worker.queuedOrderCount&&!['build','reseed'].includes(worker.order??'')).map(worker=>worker.id)),memory=state.fortifications.fallback??(state.fortifications.fallback={});
      const result=fortifyControllerCommands(available,{kind:'fortify',anchorRef:home.id,material,radiusM:18},memory,eligible);
      defenseProposal={commands:result.commands,memory,urgentEconomy};
    }
  }
  const scoutAllowed=view.tick>=state.nextScoutTick;if(scoutAllowed)state.nextScoutTick=view.tick+rules.scoutIntervalSeconds*hz;
  // When the model has not assigned an army mission, an established force
  // pursues conquest from disclosed enemy memory instead of waiting at home
  // until a scout happens to make a target visible again. Never restart paid
  // routes, interrupt queued/manual orders, or march an isolated siege engine.
  if(strategic)maintainConquest(view,state,army,home,locked,add,context);
  const preferredTarget=preferences.raid?enemies.find(enemy=>enemy.typeId==='villager')?.id:undefined;
  const armyTarget=Math.max(rules.armyTargetsByAge[Math.min(3,view.self.age-1)]??4,view.self.age>=3?Math.min(maxAiWorkers(view),workers.length):0);
  const caretakerOptions:RulePolicyOptions={difficulty,targetWorkers:rules.targetWorkers,retreatHpFraction:rules.retreatHpFraction,desiredUnitType:desired,armyTarget,housingBuffer:rules.housingBuffer,workerReserve:rules.workerReserve,scoutAllowed:scoutAllowed&&(difficulty!=='hard'||!own.some(unit=>unit.typeId==='scout'&&!unit.garrisonedIn)),maintainScout:true,attackTargetId:preferredTarget,memoryRefreshTicks:hz,reservedWorkerIds:[...(state.resourceHandoff?[state.resourceHandoff.workerId]:[]),...(protectedIds??[])],protectedEntityIds:protectedIds,avoidBuildingCells:routinePlacementCells(),resourceWeights:economyGoal?.goal.kind==='economy'?economyGoal.goal.weights:preferences.resourceWeights};
  const caretakerDue=caretakerCommands(view,state,caretakerOptions,profiler,context);
  if(defenseProposal){
    // Reserve the defensive site before economy placement, but let actual food,
    // housing and camp purchases choose their workers and spend first. One busy
    // ordinary site can coexist with defensive work on a later decision.
    const otherCommands=[...state.pending.flatMap(batch=>batch.commands),...caretakerDue];
    for(const command of otherCommands)for(const id of selected(command))locked.add(id);
    for(const command of defenseProposal.commands){
      if((command.kind==='build'||command.kind==='build_wall')&&(defenseProposal.urgentEconomy||otherCommands.some(other=>other.kind==='build'||other.kind==='build_wall')))continue;
      if(command.kind==='continue_build'&&otherCommands.some(other=>other.kind==='continue_build'&&other.foundationId===command.foundationId))continue;
      if(add(command,caretakerDue))markFortifyQueued(defenseProposal.memory,command,view.tick);
    }
  }
  due.push(...caretakerDue.map(command=>({command})));return finish();
}
