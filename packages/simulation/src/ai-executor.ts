import { satisfiesBuilding, developmentContent, nextStructureUpgrade, upgradePrice } from './legendary-ai.js';
import { balance, ages, resolveRuleset, wallTypeForMaterial, buildings, units, technologies, type AgeId, type BuildingId, type GameplayCommand, type PlayerView, type Position, type ResourceBank, type TechnologyId, type UnitId, type ViewEntity } from '@frontier/shared';
import { commandEntities } from './assistant.js';
import { ageProgressionReserve, ageDependencyRequirements, buildingCommand, constructionReconnaissance, constructionAvoidCells, campExpansionAllowed, maxAiWorkers, missingAgeBuildings, unstaffedFoundationCommand } from './caretaker.js';
import { effectiveEconomyWeights, reconcileEconomyAssignments } from './fallback.js';
import { fortifyControllerCommands, markFortifyQueued } from './fortify-planner.js';
import { fortifyPlacementCells, matchesFortifyLayoutEntity, fortifyScreenPlacementCells, matchesFortifyScreenEntity } from './fortify-geometry.js';
import type { AiCommandProposal, AiGoalState, CommanderState } from './ai-controller.js';
import { developmentBuildings, type AiReference } from './ai-observation.js';
import type { AiDecisionContext } from './ai-exploration.js';

const hz=balance.rules.simulationHz,distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const selected=(command:GameplayCommand):string[]=>'unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:[];
export function aiFortifyPlacementCells(view:PlayerView,state:CommanderState){
  const active=new Set(state.plan?.goals.filter(goal=>goal.kind==='fortify'&&goal.expiresTick>view.tick&&!['rejected','expired'].includes(goal.status)).map(goal=>goal.key));
  let paid:ViewEntity[]|undefined;
  return Object.entries(state.fortifications).filter(([key,memory])=>{
    if(!memory.layout&&!memory.screen)return false;
    if((active.has(key)||key==='fallback')&&!memory.blockedGeometry&&!memory.routeFailure)return true;
    if(!memory.layoutCommitted)return false;
    paid??=view.entities.filter(entity=>entity.kind==='building'&&entity.ownerId===view.playerId&&!entity.ghost&&buildings[entity.typeId].wallEquivalentCells);
    return paid.some(entity=>(['palisade','stone','bastion','runestone','titan','eternal'] as const).some(material=>memory.layout&&matchesFortifyLayoutEntity(memory.layout,material,entity)||memory.screen&&matchesFortifyScreenEntity(memory.screen,material,entity)));
  }).flatMap(([,memory])=>memory.screen?fortifyScreenPlacementCells(memory.screen):fortifyPlacementCells(memory.layout!));
}
export function commandCost(command:GameplayCommand,view?:PlayerView):ResourceBank|undefined {
  if(command.kind==='upgrade_structure'&&view){const result={food:0,wood:0,gold:0,stone:0};for(const id of command.buildingIds){const entity=view.entities.find(entity=>entity.id===id);if(entity){const price=upgradePrice(entity,command.targetTypeId);for(const resource of balance.resourceOrder)result[resource]+=price[resource];}}return result;}
  if(command.kind==='build')return buildings[command.buildingType].cost;
  if(command.kind==='reseed_farm')return buildings.farm.reseedCost;
  if(command.kind==='train')return Object.fromEntries(balance.resourceOrder.map(resource=>[resource,units[command.unitType].cost[resource]*command.quantity])) as ResourceBank;
  if(command.kind==='research')return technologies[command.technologyId].cost;
  if(command.kind==='advance_age')return ages[command.targetAge]?.cost;
  if(command.kind==='tribute'){const result={food:0,wood:0,gold:0,stone:0};result[command.resource]=command.amount+Math.ceil(command.amount*balance.rules.market.tributeFeeFraction);return result;}
  if(command.kind==='build_wall')return Object.fromEntries(balance.resourceOrder.map(resource=>[resource,buildings[wallTypeForMaterial(command.material)].cost[resource]*command.cells.length])) as ResourceBank;
  return undefined;
}
export function aiResourceReserve(view:PlayerView,workerCount:number,committed:readonly GameplayCommand[]=[],context?:AiDecisionContext):ResourceBank{
  const faction=view.players.find(player=>player.id===view.playerId)!,policy=balance.ai.rulePolicies[faction.difficulty??'medium'];
  const ageReserve=ageProgressionReserve(view,committed,context);
  const foodRecovery=view.self.resources.food<units.villager.cost.food*2&&!committed.some(command=>command.kind==='build'&&command.buildingType==='farm')&&!view.entities.some(entity=>!entity.ghost&&entity.resource==='food'&&(entity.amount??0)>0&&(entity.kind==='resource'||entity.ownerId===view.playerId&&entity.progress===1));
  return {food:Math.max(ageReserve.food,workerCount<6?units.villager.cost.food*policy.workerReserve:0),wood:Math.max(ageReserve.wood,foodRecovery?buildings.farm.cost.wood:0,view.self.populationCap<view.self.populationLimit&&view.self.population+view.self.reservedPopulation>=view.self.populationCap-policy.housingBuffer?buildings.house.cost.wood:0),gold:ageReserve.gold,stone:ageReserve.stone};
}
function destination(view:PlayerView,reference:AiReference):Position|undefined {
  if(!('position'in reference))return;
  const entity='entityId'in reference?view.entities.find(entity=>entity.id===reference.entityId):undefined;
  if(entity?.kind==='building'){let [w,h]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];return {xMm:Math.max(1000,Math.min(view.map.widthMm-1000,entity.xMm+w*1000+2500)),zMm:Math.max(1000,Math.min(view.map.heightMm-1000,entity.zMm+h*1000+2500))};}
  return {...reference.position};
}
/** Autonomous army-main is a standing military intention, including later
 * reinforcements. A human cooperation preset retains its frozen membership. */
export function armyGoalMembers(view:PlayerView,state:CommanderState,goal:AiGoalState,own:readonly ViewEntity[]):ViewEntity[]{
  if(goal.goal.kind!=='army_order')return [];
  const squad=(goal.frozenReferences??state.planReferences)[goal.goal.squadRef];if(squad?.kind!=='squad')return [];
  const autonomousMain=!goal.source&&!goal.frozenReferences&&goal.goal.squadRef==='army-main',ids=autonomousMain?undefined:new Set(squad.entityIds);
  return own.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost&&entity.kind==='unit'&&!entity.garrisonedIn&&(ids?ids.has(entity.id):!['villager','scout'].includes(entity.typeId)));
}
/** Evaluate an authorized view. An optional enqueue callback accepts each proposal once. */
export function desiredGoalCommands(view:PlayerView,state:CommanderState,enqueue?:(proposal:AiCommandProposal)=>boolean,protectedIds?:ReadonlySet<string>,context?:AiDecisionContext):AiCommandProposal[]{
  if(!state.plan)return [];
  const roster=context?.roster(view),own=roster?.owned??view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),workers=roster?.workers??own.filter(entity=>entity.typeId==='villager'&&!entity.garrisonedIn),complete=roster?.complete??own.filter(entity=>entity.kind==='building'&&entity.progress===1),jobs=complete.flatMap(building=>building.queue??[]),pending=state.pending.flatMap(batch=>batch.commands),locked=new Set([...pending.flatMap(selected),...(protectedIds??[]),...state.constructionRecon?.members.map(member=>member.id)??[]]);
  reconcileEconomyAssignments(view,state,workers,locked);
  const bank={...view.self.resources},proposals:AiCommandProposal[]=[];
  for(const command of pending){const cost=commandCost(command,view);if(cost)for(const resource of balance.resourceOrder)bank[resource]-=cost[resource];}
  const faction=view.players.find(player=>player.id===view.playerId)!,missing=new Set(missingAgeBuildings(view,context)),dependencies=ageDependencyRequirements(view,context);let reserve=aiResourceReserve(view,workers.length,pending,context);
  const unpaidPrerequisites=new Set([...missing].filter(type=>!own.some(entity=>entity.kind==='building'&&entity.typeId===type)&&!pending.some(command=>command.kind==='build'&&command.buildingType===type)));
  const committed=()=>[...pending,...proposals.map(proposal=>proposal.command)];
  const reservedCells=()=>[...aiFortifyPlacementCells(view,state),...constructionAvoidCells(view,state)];
  const continuing=(id:string)=>[...pending,...proposals.map(proposal=>proposal.command)].some(command=>command.kind==='continue_build'&&command.foundationId===id);
  const issue=(goal:AiGoalState,command:GameplayCommand|undefined):boolean=>{
    if(command&&protectedIds&&commandEntities(command).some(id=>protectedIds.has(id))){goal.status='blocked';goal.reason='MANUAL_CONTROL';return false;}
    if(!command){goal.status='blocked';goal.reason='NO_LEGAL_ACTION';return false;}
    if(selected(command).some(id=>locked.has(id))){goal.status='pending';goal.reason='UNIT_BUSY';return false;}
    const priorityConstruction=command.kind==='upgrade_structure'&&[...missing].some(type=>satisfiesBuilding(type,command.targetTypeId))||command.kind==='build'&&(dependencies.buildings.has(command.buildingType)||command.buildingType==='house'&&view.self.population+view.self.reservedPopulation>=view.self.populationCap||command.buildingType==='farm'&&bank.food<units.villager.cost.food*2&&!view.entities.some(entity=>!entity.ghost&&entity.resource==='food'&&(entity.amount??0)>0&&(entity.kind==='resource'||entity.ownerId===view.playerId&&entity.progress===1)));
    // The caretaker shares this command queue. Optional construction must not
    // occupy its only construction slot before unpaid age dependencies, even
    // when an incoming model plan omitted an advance-age goal entirely.
    if(unpaidPrerequisites.size&&(command.kind==='build'||command.kind==='build_wall')&&!priorityConstruction){goal.status='pending';goal.reason='AGE_PREREQUISITES_REQUIRED';return false;}
    if(command.kind==='build'&&!missing.has(command.buildingType)&&!campExpansionAllowed(view,command.buildingType,[...pending,...proposals.map(proposal=>proposal.command)],context)){goal.status='pending';goal.reason='CAMP_WORKFORCE_BUDGET';return false;}
    const cost=commandCost(command,view),essential=command.kind==='research'&&dependencies.technologies.has(command.technologyId)||command.kind==='advance_age'||priorityConstruction||command.kind==='train'&&command.unitType==='villager'&&workers.length<6||command.kind==='build'&&command.buildingType==='house';
    if(cost&&balance.resourceOrder.some(resource=>bank[resource]<cost[resource]||cost[resource]>0&&!essential&&bank[resource]-cost[resource]<reserve[resource])){goal.status='pending';goal.reason='INSUFFICIENT_RESOURCES';return false;}
    const proposal={command,goalKey:goal.key,planGeneration:state.plan!.generation};
    if(enqueue&&!enqueue(proposal)){goal.status='pending';goal.reason='COMMAND_QUEUE_FULL';return false;}
    if(cost)for(const resource of balance.resourceOrder)bank[resource]-=cost[resource];for(const id of selected(command))locked.add(id);
    goal.status='pending';delete goal.reason;proposals.push(proposal);
    if(command.kind==='build'&&missing.has(command.buildingType)){unpaidPrerequisites.delete(command.buildingType);reserve=aiResourceReserve(view,workers.length,[...pending,...proposals.map(item=>item.command)],context);}
    return true;
  };
  const constructionAttempted=new Set<AiGoalState>();
  const buildDependency=(goal:AiGoalState,type:BuildingId,anchor:Position):boolean=>{
    const needed=buildings[type].requiredTechnologies?.find(id=>!view.self.technologies?.includes(id));if(needed)return research(goal,needed);
    const existing=own.filter(entity=>entity.kind==='building'&&(satisfiesBuilding(entity.typeId,type)||entity.upgrade&&satisfiesBuilding(entity.upgrade.targetTypeId,type))),foundation=existing.find(entity=>(entity.progress??1)<1||entity.upgrade);
    if(foundation){const continuation=!continuing(foundation.id)&&unstaffedFoundationCommand(foundation,workers,locked,protectedIds);if(continuation)return issue(goal,continuation);goal.status='pending';goal.reason=protectedIds?.has(foundation.id)?'MANUAL_CONTROL':'FOUNDATION_IN_PROGRESS';return false;}
    if(committed().some(action=>action.kind==='build'&&action.buildingType===type)){goal.status='pending';goal.reason='CONSTRUCTION_QUEUED';return false;}
    const upgrade=nextStructureUpgrade(view,type,protectedIds);
    if(upgrade){
      if(committed().some(action=>action.kind==='upgrade_structure'&&action.buildingIds.some(id=>upgrade.kind==='upgrade_structure'&&upgrade.buildingIds.includes(id)))){goal.status='pending';goal.reason='UPGRADE_QUEUED';return false;}
      return issue(goal,upgrade);
    }
    // Report the controlling prerequisite before optional placement/price work.
    // Paid foundations above remain resumable; housing and food recovery still
    // use their ordinary urgency checks at admission to the proposal queue.
    if(unpaidPrerequisites.size&&!dependencies.buildings.has(type)&&type!=='house'&&type!=='farm'){goal.status='pending';goal.reason='AGE_PREREQUISITES_REQUIRED';return false;}
    const price=buildings[type].cost,essential=dependencies.buildings.has(type)||type==='house';
    if(balance.resourceOrder.some(resource=>bank[resource]<price[resource]||price[resource]>0&&!essential&&bank[resource]-price[resource]<reserve[resource])){goal.status='pending';goal.reason='INSUFFICIENT_RESOURCES';return false;}
    if(state.constructionRecon?.phase==='survey'&&state.constructionRecon.typeId===type){goal.status='pending';goal.reason='SITE_RECONNAISSANCE';return false;}
    const eligible=workers.filter(worker=>!locked.has(worker.id)&&!worker.queuedOrderCount&&!['build','reseed'].includes(worker.order??''));
    if(!eligible.length){goal.status='pending';goal.reason=workers.length&&workers.every(worker=>protectedIds?.has(worker.id))?'MANUAL_CONTROL':'UNIT_BUSY';return false;}
    // A full-development goal can consider several cheap upgrades, but performs
    // at most one placement search per pulse if visible space is unavailable.
    if(constructionAttempted.has(goal))return false;constructionAttempted.add(goal);
    const action=buildingCommand(view,type,anchor,eligible,goal.candidateIndex,reservedCells(),committed());
    if(!action){
      goal.candidateIndex=(goal.candidateIndex+1)%32;let issued=false;
      if(!state.constructionRecon)for(const command of constructionReconnaissance(view,state,type,anchor,{protectedIds,unavailable:locked,avoidCells:reservedCells(),pending:committed(),context}))issued=issue(goal,command)||issued;
      for(const member of state.constructionRecon?.members??[])locked.add(member.id);
      if(issued)return true;goal.status='pending';goal.reason=state.constructionRecon?'SITE_RECONNAISSANCE':'NO_VISIBLE_SITE';return false;
    }
    return issue(goal,action);
  };
  const advance=(goal:AiGoalState):boolean=>{
    if(jobs.some(job=>job.kind==='age')||committed().some(action=>action.kind==='advance_age')){goal.status='pending';goal.reason='AGE_QUEUED';return false;}
    const next=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1),home=complete.find(building=>!protectedIds?.has(building.id)&&building.typeId==='town_center');
    if(!next||!home){goal.status='pending';goal.reason='PREREQUISITES_REQUIRED';return false;}
    const missing=missingAgeBuildings(view,context);if(missing.length)return buildDependency(goal,missing[0]!,home);
    const queued=committed().reduce((count,action)=>count+(action.kind==='train'&&action.buildingId===home.id?action.quantity:(action.kind==='research'&&action.buildingId===home.id)?1:0),home.queue?.length??0);
    if(queued>=balance.rules.queueWaitingLimit+1){goal.status='pending';goal.reason='PRODUCTION_QUEUED';return false;}
    return issue(goal,{kind:'advance_age',townCenterId:home.id,targetAge:next.id as Exclude<AgeId,1>});
  };
  const research=(goal:AiGoalState,type:TechnologyId):boolean=>{
    const definition=technologies[type];
    if(jobs.some(job=>job.kind==='research'&&job.typeId===type)||committed().some(action=>action.kind==='research'&&action.technologyId===type)){goal.status='pending';goal.reason='RESEARCH_QUEUED';return false;}
    // Follow the validated, acyclic content tree; ask for a final upgrade once,
    // then buy each ordinary prerequisite instead of waiting for another model.
    const prerequisite=definition.prerequisites.find(id=>!view.self.technologies?.includes(id));if(prerequisite)return research(goal,prerequisite);
    if(view.self.age<definition.minAge)return advance(goal);
    const sources=complete.filter(building=>building.typeId===definition.researchedAt),producer=sources.find(building=>!protectedIds?.has(building.id)&&(building.queue?.length??0)+committed().reduce((count,action)=>count+(action.kind==='train'&&action.buildingId===building.id?action.quantity:(action.kind==='research'&&action.buildingId===building.id||action.kind==='advance_age'&&action.townCenterId===building.id)?1:0),0)<balance.rules.queueWaitingLimit+1);
    if(!producer){
      if(sources.length){goal.status='pending';goal.reason=sources.every(building=>protectedIds?.has(building.id))?'MANUAL_CONTROL':'PRODUCTION_QUEUED';return false;}
      const home=complete.find(building=>building.typeId==='town_center');if(home)return buildDependency(goal,definition.researchedAt,home);
      goal.status='pending';goal.reason='PREREQUISITES_REQUIRED';return false;
    }
    return issue(goal,{kind:'research',buildingId:producer.id,technologyId:type});
  };
  const train=(goal:AiGoalState,typeId:UnitId,target:number)=>{
    const requested=target;if(typeId==='villager')target=Math.min(target,maxAiWorkers(view));
    const live=own.filter(entity=>entity.typeId===typeId&&entity.kind==='unit').length,queued=jobs.filter(job=>job.kind==='train'&&job.typeId===typeId).length+committed().reduce((count,action)=>count+(action.kind==='train'&&action.unitType===typeId?action.quantity:0),0);
    if(live>=target){goal.status=requested>target?'pending':'fulfilled';if(requested>target)goal.reason='MILITARY_POPULATION_RESERVED';else delete goal.reason;return;}
    if(live+queued>=target){goal.status='pending';goal.reason='PRODUCTION_QUEUED';return;}
    const definition=units[typeId];target=Math.min(target,definition.maxPerPlayer??target);
    if(live+queued>=target){goal.status=live>=target?'blocked':'pending';goal.reason=live>=target?'UNIT_CAP':'PRODUCTION_QUEUED';return;}
    const neededTech=definition.requiredTechnologies?.find(id=>!view.self.technologies?.includes(id));if(neededTech){research(goal,neededTech);return;}
    const neededBuilding=definition.requiredBuildings?.find(type=>!complete.some(entity=>satisfiesBuilding(entity.typeId,type)));if(neededBuilding){const home=complete.find(entity=>entity.typeId==='town_center');if(home)buildDependency(goal,neededBuilding,home);return;}
    const producer=complete.find(building=>!protectedIds?.has(building.id)&&building.typeId===definition.producedAt&&!building.queue?.some(job=>job.state==='exit_blocked'||job.state==='population_blocked')&&(building.queue?.length??0)<balance.rules.queueWaitingLimit+1);
    if(view.self.age<definition.minAge){advance(goal);return;}
    if(!producer){const home=complete.find(building=>building.typeId==='town_center');if(home&&!complete.some(building=>building.typeId===definition.producedAt))buildDependency(goal,definition.producedAt,home);else{goal.status='pending';goal.reason='PRODUCER_REQUIRED';}return;}
    const quantity=Math.min(target-live-queued,6-(producer.queue?.length??0),Math.floor((view.self.populationCap-view.self.population-view.self.reservedPopulation)/definition.population),...balance.resourceOrder.filter(resource=>definition.cost[resource]>0).map(resource=>Math.floor(Math.max(0,bank[resource]-(typeId==='villager'&&workers.length<6?0:reserve[resource]))/definition.cost[resource])));
    if(quantity>0)issue(goal,{kind:'train',buildingId:producer.id,unitType:typeId,quantity});else{goal.status='pending';goal.reason=view.self.populationCap-view.self.population-view.self.reservedPopulation<definition.population?'POPULATION_LIMIT':'INSUFFICIENT_RESOURCES';}
  };
  // A requested age includes its ordinary construction dependencies. Evaluate it
  // before optional expansion goals so the latter cannot spend its builder/bank.
  for(const goal of [...state.plan.goals].sort((a,b)=>Number(b.kind==='advance_age'||b.kind==='develop')-Number(a.kind==='advance_age'||a.kind==='develop'))){
    if(goal.status==='rejected'||goal.status==='expired')continue;
    if(view.tick>=goal.expiresTick){if(goal.status!=='fulfilled'){goal.status='expired';goal.reason='GOAL_EXPIRED';}continue;}
    if(state.pending.some(batch=>batch.goalKey===goal.key)||goal.lastIssuedTick!==undefined&&view.tick-goal.lastIssuedTick<hz){goal.status=goal.status==='fulfilled'?'fulfilled':'pending';continue;}
    const command=goal.goal,references=goal.frozenReferences??state.planReferences;
    switch(command.kind){
      case 'ensure_units':train(goal,command.unitType,command.targetCount);break;
      case 'ensure_building':{
        const existing=own.filter(entity=>entity.kind==='building'&&(satisfiesBuilding(entity.typeId,command.buildingType)||entity.upgrade&&satisfiesBuilding(entity.upgrade.targetTypeId,command.buildingType)));
        if(existing.filter(entity=>entity.progress===1&&!entity.upgrade).length>=Math.min(command.targetCount,buildings[command.buildingType].maxPerPlayer??buildings[command.buildingType].familyCap??Infinity)){goal.status='fulfilled';delete goal.reason;break;}
        const foundation=existing.find(entity=>(entity.progress??1)<1||entity.upgrade);
        if(foundation){const continuation=!continuing(foundation.id)&&unstaffedFoundationCommand(foundation,workers,locked,protectedIds);if(continuation)issue(goal,continuation);else{goal.status='pending';goal.reason=protectedIds?.has(foundation.id)?'MANUAL_CONTROL':'FOUNDATION_IN_PROGRESS';}break;}
        if(existing.length+[...pending,...proposals.map(proposal=>proposal.command)].filter(action=>action.kind==='build'&&action.buildingType===command.buildingType).length>=command.targetCount){goal.status='pending';goal.reason='CONSTRUCTION_QUEUED';break;}
        const anchor=references[command.anchorRef],point=anchor&&'position'in anchor?anchor.position:undefined;
        if(!point){goal.status='rejected';goal.reason='INVALID_ANCHOR';break;}
        if(anchor?.kind==='own_base'&&!own.some(entity=>entity.id===anchor.entityId&&entity.kind==='building'&&entity.hp>0)){goal.status='blocked';goal.reason='BASE_RECOVERY_REQUIRED';break;}
        if(view.self.age<buildings[command.buildingType].minAge){advance(goal);break;}
        buildDependency(goal,command.buildingType,point);break;
      }
      case 'economy':{
        train(goal,'villager',command.targetVillagers);
        if(proposals.some(proposal=>proposal.goalKey===goal.key))break;
        const assignments=state.assignments??(state.assignments={}),counts=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,workers.filter(worker=>assignments[worker.id]===resource&&worker.order==='gather').length])) as ResourceBank;
        const weights=effectiveEconomyWeights(view,command.weights),resources=[...balance.resourceOrder].sort((a,b)=>(workers.length*weights[b]/100-counts[b])-(workers.length*weights[a]/100-counts[a]));
        for(const resource of resources){if(weights[resource]===0)continue;const worker=workers.find(worker=>!locked.has(worker.id)&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)&&(worker.order==='idle'||worker.order==='gather'&&assignments[worker.id]!==resource&&counts[assignments[worker.id]??resource]>workers.length*weights[assignments[worker.id]??resource]/100));if(!worker)continue;
          const node=view.entities.filter(entity=>!entity.ghost&&entity.resource===resource&&(entity.amount??0)>0&&(entity.kind==='resource'||entity.ownerId===view.playerId&&entity.typeId==='farm'&&!entity.farmerAssigned&&!state.farmAssignments?.[entity.id])).sort((a,b)=>distance(a,worker)-distance(b,worker))[0];
          if(node&&issue(goal,{kind:'gather',unitIds:[worker.id],targetId:node.id,queued:false})){assignments[worker.id]=resource;if(node.typeId==='farm')(state.farmAssignments??={})[node.id]=worker.id;break;}
        }
        break;
      }
      case 'research':{
        if(view.self.technologies?.includes(command.technologyId)){goal.status='fulfilled';delete goal.reason;break;}
        research(goal,command.technologyId);break;
      }
      case 'advance_age':{
        if(view.self.age>=command.targetAge){goal.status='fulfilled';delete goal.reason;break;}
        advance(goal);break;
      }
      case 'develop':{
        const anchor=references[command.anchorRef];if(anchor?.kind!=='own_base'){goal.status='rejected';goal.reason='INVALID_ANCHOR';break;}
        if(!own.some(entity=>entity.id===anchor.entityId&&entity.kind==='building'&&entity.hp>0)){goal.status='blocked';goal.reason='BASE_RECOVERY_REQUIRED';break;}
        if(view.self.age<command.targetAge){advance(goal);break;}
        const infrastructure=developmentContent(view).filter(building=>building.minAge<=command.targetAge&&!complete.some(entity=>satisfiesBuilding(entity.typeId,building.id)));
        const upgrades=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).technologies.filter(technology=>technology.minAge<=command.targetAge&&!view.self.technologies?.includes(technology.id));
        if(!infrastructure.length&&!upgrades.length){goal.status='fulfilled';delete goal.reason;break;}
        // One affordable action per goal/pulse. Expensive optional structures
        // must not stop cheaper research, while paid foundations remain resumable.
        // Failed placement advances the persisted candidate cursor. Rotate the
        // starting type next pulse so a large site that cannot fit does not
        // indefinitely exclude smaller missing support buildings. Capture the
        // offset before searching; a failure must not reorder this same pulse.
        const start=infrastructure.length?goal.candidateIndex%infrastructure.length:0;
        const ordered=[...infrastructure.slice(start),...infrastructure.slice(0,start)];
        let issued=false;for(const building of ordered)if(buildDependency(goal,building.id,anchor.position)){issued=true;break;}
        if(!issued)for(const technology of upgrades)if(research(goal,technology.id))break;
        break;
      }
      case 'tribute':{
        const remaining=command.amount-(state.tributeCredits[goal.key]??0);if(remaining<=0){goal.status='fulfilled';delete goal.reason;break;}
        const ally=references[command.allyRef];if(ally?.kind!=='ally'){goal.status='rejected';goal.reason='INVALID_ALLY';break;}issue(goal,{kind:'tribute',recipientId:ally.playerId,resource:command.resource,amount:remaining});break;
      }
      case 'fortify':{
        const anchor=references[command.anchorRef];if(anchor?.kind!=='own_base'){goal.status='rejected';goal.reason='INVALID_ANCHOR';break;}
        if(!own.some(entity=>entity.id===anchor.entityId&&entity.kind==='building'&&entity.hp>0)){goal.status='blocked';goal.reason='BASE_RECOVERY_REQUIRED';break;}
        const memory=state.fortifications[goal.key]??(state.fortifications[goal.key]={}),available={...view,self:{...view.self,resources:Object.fromEntries(balance.resourceOrder.map(resource=>[resource,Math.max(0,bank[resource]-reserve[resource])])) as ResourceBank}},eligible=new Set(workers.filter(worker=>!locked.has(worker.id)&&!worker.queuedOrderCount&&!['build','reseed'].includes(worker.order??'')).map(worker=>worker.id)),result=fortifyControllerCommands(available,{...command,anchorRef:anchor.entityId},memory,eligible);
        goal.status=result.status==='complete'?'fulfilled':result.status==='blocked'?'blocked':'pending';if(result.reason)goal.reason=result.reason;else delete goal.reason;for(const action of result.commands)if(issue(goal,action)&&enqueue)markFortifyQueued(memory,action,view.tick);break;
      }
      case 'army_order':case 'scout':{
        const reference=references[command.kind==='scout'?command.zoneRef:command.targetRef],target=reference&&destination(view,reference);if(!target){goal.status='rejected';goal.reason='INVALID_TARGET_REF';break;}
        const members=command.kind==='scout'?own.filter(entity=>entity.typeId==='scout'&&!entity.garrisonedIn&&!protectedIds?.has(entity.id)).slice(0,1):armyGoalMembers(view,state,goal,own).filter(entity=>!protectedIds?.has(entity.id));
        if(!members.length){goal.status='blocked';goal.reason='NO_AVAILABLE_SQUAD';break;}
        const knownTarget=reference&&'entityId'in reference?view.entities.find(entity=>entity.id===reference.entityId):undefined,visibleTarget=knownTarget&&!knownTarget.ghost?knownTarget:undefined,hostileTarget=knownTarget?.ownerId&&view.players.find(player=>player.id===knownTarget.ownerId)?.teamId!==faction.teamId;
        if(members.every(unit=>distance(unit,target)<5000)&&!(command.kind==='army_order'&&['attack','raid'].includes(command.order)&&hostileTarget)){goal.status='fulfilled';delete goal.reason;break;}
        const defense=visibleTarget&&own.some(entity=>(entity.typeId==='town_center'&&distance(entity,visibleTarget)<25000)||(entity.typeId==='villager'&&distance(entity,visibleTarget)<12000));
        if(command.kind==='army_order'&&['attack','raid'].includes(command.order)&&!defense&&view.tick<balance.ai.difficulty[faction.difficulty??'medium'].initialBaseAssaultNotBeforeSeconds*hz){goal.status='blocked';goal.reason='INITIAL_ASSAULT_RESTRICTED';break;}
        const offensive=command.kind==='army_order'&&['attack','raid'].includes(command.order);
        if(offensive&&!goal.source&&!defense&&view.entities.some(enemy=>!enemy.ghost&&enemy.kind==='unit'&&enemy.ownerId&&view.players.some(player=>player.id===enemy.ownerId&&player.teamId!==faction.teamId&&!player.defeated)&&own.some(entity=>entity.typeId==='town_center'&&distance(entity,enemy)<25000||entity.typeId==='villager'&&distance(entity,enemy)<12000))){goal.status='pending';goal.reason='LOCAL_DEFENSE_REQUIRED';break;}
        // One travelling member must not strand the rest of its squad. Never
        // reset an active route, a queued human order or an ongoing attack just
        // to attach an idle reinforcement to the same strategic intention.
        const ready=members.filter(unit=>!locked.has(unit.id)&&!unit.queuedOrderCount&&!['packing','deploying'].includes(unit.deploymentState??'')&&!(unit.visualAction?.kind==='attack'&&(unit.visualAction.durationTicks===undefined||unit.visualAction.startedTick+unit.visualAction.durationTicks>view.tick))&&(goal.lastIssuedTick===undefined||unit.order==='idle'||unit.taskState==='blocked')&&(offensive&&hostileTarget||distance(unit,target)>=5000)).slice(0,200); // Ordinary unitIds command-schema limit; later idle members join next pulse.
        if(!ready.length){goal.status='pending';goal.reason='SQUAD_EN_ROUTE';break;}
        const pack=ready.filter(unit=>unit.deploymentState==='deployed'&&(!visibleTarget||distance(unit,visibleTarget)>(units[unit.typeId].rangeM+Math.max(...(visibleTarget.kind==='building'?buildings[visibleTarget.typeId].footprintCells:[0])))*1000||distance(unit,visibleTarget)<units[unit.typeId].minRangeM*1000));
        if(pack.length){issue(goal,{kind:'pack',unitIds:pack.map(unit=>unit.id)});break;}
        const action:GameplayCommand=offensive&&visibleTarget?.ownerId&&view.players.find(player=>player.id===visibleTarget.ownerId)?.teamId!==faction.teamId?{kind:'attack_target',unitIds:ready.map(unit=>unit.id),targetId:visibleTarget.id,queued:false}:{kind:command.kind==='scout'||command.kind==='army_order'&&['retreat','rally'].includes(command.order)?'move':'attack_move',unitIds:ready.map(unit=>unit.id),target,queued:false};issue(goal,action);break;
      }
    }
  }
  return proposals;
}
