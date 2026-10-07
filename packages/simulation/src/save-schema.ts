// Host-only validation. Do not re-export this compiler from the browser package.
import type { ErrorObject, ValidateFunction } from 'ajv';
import { MAX_WORLD_ENTITIES, MAX_WORLD_ACTORS, balance, buildings, resolveRuleset, isContentAllowed, structureUpgrade, isSafeJson, OWNED_ENTITY_FIELDS, technologies, units, validateAiPlan, type StrictValidator } from '@frontier/shared';
import { ajv, saveSchemaFragments as shared } from '../../shared/src/validation-compiler.js';
import type { JournalEvent, SimulationSavePayload } from './persistence-types.js';
import type { CommanderState } from './ai-controller.js';
import { validFortifyLayout, validFortifyScreen } from './fortify-geometry.js';
import { SharedPathJobs } from './shared-path-jobs.js';
import { CONNECTOR_CELL_MM, CONNECTOR_REACH_CELLS, CONNECTOR_NODE_LIMIT } from './navigation.js';
import { CORNER_OBSTACLE_LIMIT, CORNER_POINT_LIMIT, CORNER_WORK_LIMIT, validCornerPathSearch } from './path-scheduler.js';

type Schema=Record<string,unknown>;
const integer=(minimum=0,maximum=Number.MAX_SAFE_INTEGER):Schema=>({type:'integer',minimum,maximum});
const number=(minimum=0,maximum=Number.MAX_SAFE_INTEGER):Schema=>({type:'number',minimum,maximum});
const text=(maxLength=256,minLength=0):Schema=>({type:'string',minLength,maxLength});
const id={...text(96,1),pattern:'^[A-Za-z0-9_-]+$'},hash={...text(64,64),pattern:'^[a-f0-9]{64}$'},flag={type:'boolean'};
const object=(properties:Record<string,unknown>,required=Object.keys(properties)):Schema=>({type:'object',additionalProperties:false,properties,required});
const array=(items:unknown,maxItems:number,minItems=0):Schema=>({type:'array',items,maxItems,minItems});
const tuple=(a:unknown,b:unknown):Schema=>({type:'array',prefixItems:[a,b],items:false,minItems:2,maxItems:2});
const record=(value:unknown,maxProperties:number,keys:unknown=id):Schema=>({type:'object',propertyNames:keys,additionalProperties:value,maxProperties});
const optional=(properties:Record<string,unknown>,required:string[]):Schema=>object(properties,required);
const position=object({xMm:integer(0,640000),zMm:integer(0,640000)});
const positionFields={xMm:integer(0,640000),zMm:integer(0,640000)};
const resources=object(Object.fromEntries(balance.resourceOrder.map(resource=>[resource,integer()])));
const resource={enum:balance.resourceOrder},unitId={enum:Object.keys(units)},buildingId={enum:Object.keys(buildings)},technologyId={enum:Object.keys(technologies)};
const status={enum:['LOADING','COUNTDOWN','RUNNING','PAUSED','FINISHED']};
const gameplay={$ref:'urn:open-frontiers:client-command:v2#/properties/command'},envelope={$ref:'urn:open-frontiers:client-command:v2'};
const orders:Schema=array({$ref:'#/$defs/order'},16);
const order=optional({manualOrder:{const:true},kind:{enum:['move','attack','attack_move','attack_ground','patrol','garrison','gather','build','repair','reseed']},planningClass:{enum:['interactive','routine']},target:position,targetId:id,forestIntentId:id,phase:{enum:['gather','deposit']},lastKnown:position,dropOffId:id,points:array(position,8),pointIndex:integer(0,7),wallTargets:array(id,64),authority:object({kind:{const:'caretaker'},generation:integer()}),formation:optional({id,center:position,anchor:position,checkedRevision:integer(),retryAtTick:integer(),searchIndex:integer()},['id','center','anchor'])},['kind']);
const stamp=object({region:{...text(32,1),pattern:'^[0-9]+,[0-9]+$'},revision:integer()});
const jobBase={id,originalCost:resources,work:integer(),required:integer(1),reserved:flag,started:flag,blockedReason:text(96,1)};
const job={oneOf:[
  optional({...jobBase,kind:{const:'train'},typeId:unitId,state:{enum:['waiting','active','population_blocked','exit_blocked','prerequisite_blocked']}},['id','kind','typeId','originalCost','work','required','reserved','started','state']),
  optional({...jobBase,kind:{const:'research'},typeId:technologyId,state:{enum:['waiting','active','prerequisite_blocked']}},['id','kind','typeId','originalCost','work','required','reserved','started','state']),
  optional({...jobBase,kind:{const:'age'},typeId:{enum:['age_2','age_3','age_4','age_5','age_6','age_7','age_8']},targetAge:{enum:[2,3,4,5,6,7,8]},state:{enum:['waiting','active','prerequisite_blocked']}},['id','kind','typeId','targetAge','originalCost','work','required','reserved','started','state']),
]};
const attack=optional({attack:number(),attackType:{enum:['melee','pierce','crush']},bonusDamage:record(number(),32,text(96,1)),wardDepletionMultiplier:integer(1,3)},['attack','attackType','bonusDamage']);
const entityBase={id,...positionFields,hp:integer(),maxHp:integer(1)};
const workFaceLimit=Math.max(16,...Object.values(buildings).map(definition=>4*(definition.footprintCells[0]+definition.footprintCells[1])+4));
const unit=optional({...entityBase,kind:{const:'unit'},typeId:unitId,ownerId:id,orders,path:array(position,409600),pathRevision:integer(),cargo:object({resource:{anyOf:[resource,{type:'null'}]},amount:integer()}),gatherRemainder:integer(0,19999),cooldown:integer(),stance:{enum:['aggressive','defensive','stand_ground']},repathAtTick:integer(),taskState:{enum:['idle','moving','gathering','returning','building','repairing','blocked']},blockedReason:text(96,1),orderRevision:integer(),engagement:object({targetId:id,lastKnown:position,anchor:position}),lastAttackerId:id,lastDamagedTick:integer(),deploymentState:{enum:['packed','deploying','deployed','packing']},transitionTicks:integer(),transitionRequired:integer(1),desiredDeployment:{enum:['packed','deployed']},garrisonedIn:id,garrisonHealTicks:integer(),garrisoned:array(id,8),pendingUngarrison:array(id,8),weaponCooldowns:array(integer(),3),windup:optional({launchTick:integer(),aim:position,targetId:id,orderRevision:integer(),from:position,attack},['launchTick','aim','orderRevision','from','attack']),autoGather:flag,autoGatherAtTick:integer(),resourceSearch:object({purpose:{enum:['idle','depleted','forest']},targetIds:array(id,balance.rules.maxResourceNodes),index:integer(0,balance.rules.maxResourceNodes)}),pathRegions:array(stamp,1600),pathRequestId:id,pathDestination:position,lastProgressTick:integer(),pathBlockedRevision:integer(),pathBlockedNeighbors:text(65536),approachGoal:optional({key:text(512,1),revision:integer(),point:position,retryAtTick:integer(),failedPoints:array(position,workFaceLimit)},['key','revision'])},['id','kind','typeId','ownerId','xMm','zMm','hp','maxHp','orders','path','pathRevision','cargo','gatherRemainder','cooldown','stance','repathAtTick']);
const building=optional({...entityBase,kind:{const:'building'},typeId:buildingId,ownerId:id,rotation:{enum:[0,90,180,270]},work:integer(),required:integer(1),grantedHp:integer(),queue:array(job,6),cooldown:integer(),rally:position,demolitionTick:integer(),foodRemaining:integer(),farmerId:id,reseedWork:integer(),reseedRequired:integer(1),repairCredits:record(number(),11),repairRemainders:record(resources,11),repairDenominator:integer(1),gateMode:{enum:['AUTO','LOCKED','OPEN']},gateOpen:flag,gateCloseAfterTick:integer(),garrisoned:array(id,24),pendingUngarrison:array(id,24),weaponCooldowns:array(integer(),3),pendingConstruction:optional({clearanceMm:{enum:[0,balance.rules.buildingGridM*2000]},blocked:flag,retryAtTick:integer()},['clearanceMm']),upgrade:object({id,targetTypeId:buildingId,originalCost:resources,work:integer(),required:integer(1),started:flag}),ward:object({current:integer(),max:integer(1),supportId:id,quietSinceTick:integer(),recoveryRemainder:integer(0,19)}),monumentCompletedTick:integer()},['id','kind','typeId','ownerId','xMm','zMm','hp','maxHp','rotation','work','required','grantedHp','queue','cooldown']);
const entity={oneOf:[unit,building,optional({...entityBase,kind:{const:'resource'},typeId:id,ownerId:{type:'null'},resource,amount:integer(),forest:object({patchId:id,cellMm:{const:balance.maps.forestNavigationCellM*balance.rules.positionUnitsPerM}})},['id','xMm','zMm','hp','maxHp','kind','typeId','ownerId','resource','amount'])]};
const statistics=object({unitsTrained:integer(),unitsLost:integer(),buildingsBuilt:integer(),buildingsLost:integer(),ageTicks:object({'1':integer(),'2':integer(),'3':integer(),'4':integer(),'5':integer(),'6':integer(),'7':integer(),'8':integer()},['1']),fallbackTicks:integer(),modelReadyTicks:integer(),inferenceFailures:integer()});
const economy=optional({resources,age:integer(1,8),defeated:flag,aiResignationSinceTick:integer(),collected:resources,spent:resources,lastClientSequence:integer(),autoReseed:flag,ledger:array(shared.ledgerEntry,1000000),lostCargo:resources,notifications:array(shared.notification,30),statistics,technologies:{...array(technologyId,41),uniqueItems:true},researchRevision:integer(0,41)},['resources','age','defeated','collected','spent','lastClientSequence','autoReseed','ledger','lostCargo','notifications','statistics','technologies','researchRevision']);
const fallback=optional({sequence:integer(),scoutIndex:integer(),buildAttempt:integer(),assignments:record(resource,2200),farmAssignments:record(id,2640),explorerId:id,scoutRoute:object({target:position,issuedTick:integer()})},['sequence','scoutIndex','buildAttempt']);
const construction=record(optional({progress:number(0,1),lastProgressTick:integer(),builders:record(object({...positionFields,lastMovedTick:integer()}),200),helperId:id,retryAtTick:integer(),blockedSinceTick:integer()},['progress','lastProgressTick','builders']),balance.rules.maxNonWallBuildingsPerPlayer+balance.rules.maxWallEquivalentCellsPerPlayer);
const constructionAvoid=array(object({typeId:buildingId,position,rotation:{enum:[0,90,180,270]},untilTick:integer()}),8);
const constructionRecon=object({typeId:buildingId,origin:object({x:integer(0,319),z:integer(0,319)}),createdTick:integer(),phase:{enum:['survey','release']},members:array(optional({id,target:position,stance:{enum:['aggressive','defensive','stand_ground']},lastPosition:position,lastProgressTick:integer(),issuedTick:integer()},['id','target','stance','lastPosition','lastProgressTick']),8)});
const caretaker=object({...(fallback.properties as Record<string,unknown>),nextStrategicTick:integer(),pending:array(object({observedTick:integer(),executeTick:integer(),commands:array(gameplay,200)}),60),seenEnemies:record(object({firstSeenTick:integer(),lastSeenTick:integer(),typeId:id}),MAX_WORLD_ACTORS),construction,constructionRecon,constructionAvoid},['sequence','scoutIndex','buildAttempt','nextStrategicTick','pending','seenEnemies']);
const aiBinding=object({matchId:id,matchEpoch:integer(1,2147483647),playerId:id,requestId:id,observationId:id,observedTick:integer(),controllerGeneration:integer(1)});
const aiReference={oneOf:[
  object({ref:id,kind:{const:'own_base'},entityId:id,position}),optional({ref:id,kind:{const:'ally_anchor'},playerId:id,position,entityId:id},['ref','kind','playerId','position']),
  object({ref:id,kind:{const:'enemy_memory'},entityId:id,position,lastSeenTick:integer()}),object({ref:id,kind:{const:'frontier'},position}),
  object({ref:id,kind:{const:'squad'},entityIds:{...array(id,200),uniqueItems:true}}),object({ref:id,kind:{const:'ally'},playerId:id}),
  object({ref:id,kind:{const:'resource'},entityId:id,position,resource,lastSeenTick:integer()}),object({ref:id,kind:{const:'team_ping'},position,senderId:id,verified:{const:false}}),
]};
const aiReferences=record(aiReference,64);
const aiFact=optional({id,tick:integer(),expiresTick:integer(),kind:{enum:['enemy_seen','resource_warning','owned_event','ally_request','request_outcome']},provenance:{enum:['observation','owned_event','human_claim','team_ping']},confidence:{enum:['observed','unverified']},sourcePlayerId:id,text:text(240,1),entityId:id,position,requestId:id},['id','tick','expiresTick','kind','provenance','confidence','sourcePlayerId','text']);
const aiReceipt=optional({tick:integer(),clientCommandId:id,status:{enum:['accepted','rejected']},code:text(96,1),goalKey:text(256,1)},['tick','clientCommandId','status']);
const aiMemory=object({matchId:id,playerId:id,facts:array(aiFact,20),summary:text(640),recentReceipts:array(aiReceipt,20)});
const aiChat=optional({requestId:id,senderId:id,recipientId:id,text:text(500),tick:integer(),position,verified:{const:false},intent:{oneOf:[object({action:{const:'defend_base'}}),object({action:{const:'attack_ping'},position}),object({action:{const:'tribute'},resource,amount:integer(1,1000)})]}},['requestId','senderId','recipientId','text','tick','verified']);
const aiGoal={$ref:'urn:frontier-sovereigns:ai-plan:v1#/properties/goals/items'};
const aiGoalState={...optional({key:text(256,1),kind:{enum:['economy','ensure_building','ensure_units','research','advance_age','develop','army_order','scout','fortify','tribute']},status:{enum:['accepted','pending','fulfilled','blocked','rejected','expired']},reportedStatus:{enum:['accepted','pending','fulfilled','blocked','rejected','expired']},reason:text(96,1),acceptedTick:integer(),expiresTick:integer(),goal:aiGoal,correlationId:id,source:{const:'preset'},frozenReferences:record(aiReference,2),lastIssuedTick:integer(),lastSignature:text(65536),candidateIndex:integer(),attempts:integer()},['key','kind','status','acceptedTick','expiresTick','goal','candidateIndex','attempts']),dependentRequired:{source:['frozenReferences','correlationId'],frozenReferences:['source']}};
const aiPlan=object({generation:integer(1),strategy:text(160,1),acceptedTick:integer(),expiresTick:integer(),goals:array(aiGoalState,8)});
const fortifyCell=object({x:integer(0,319),z:integer(0,319)});
const fortifyLayout=object({cells:array(fortifyCell,160,16),gates:array(optional({originCell:fortifyCell,rotation:{enum:[0,90]},widthCells:{enum:[3,5]}},['originCell','rotation']),4,4),origin:position,signature:hash});
const fortifyScreen=object({cells:array(fortifyCell,6,6),origin:position,signature:hash});
const fortifyMemory=optional({scouting:object({workerId:id,target:position}),goalKey:text(256,1),pendingUntilTick:integer(),nextPlanningTick:integer(),lastSignature:text(65536),geometryKey:text(8*1024*1024),validatedFaces:integer(0,4),validatedResources:integer(0,balance.rules.maxResourceNodes),proofPhase:{enum:['baseline','proposed']},routesValid:flag,routeFailure:text(96,1),layout:fortifyLayout,screen:fortifyScreen,layoutCommitted:{const:true},layoutKey:hash,blockedGeometry:object({key:hash,reason:text(96,1)})},[]);
const resourceHandoff=object({workerId:id,resourceId:id,resource,phase:{enum:['move','gather']},target:position,issuedTick:integer(),expiresTick:integer(),lastProgressTick:integer(),lastPosition:position});
const commanderProperties={...(caretaker.properties as Record<string,unknown>),pending:array(optional({observedTick:integer(),executeTick:integer(),commands:array(gameplay,200),goalKey:text(256,1),planGeneration:integer(1)},['observedTick','executeTick','commands']),60),generation:integer(1),observationNonce:integer(),planGeneration:integer(),nextScoutTick:integer(),memory:aiMemory,activeRequest:object({binding:aiBinding,references:aiReferences,chatRequestIds:{...array(id,8),uniqueItems:true}}),plan:aiPlan,fortifications:record(fortifyMemory,9,text(256,1)),tributeCredits:record(integer(),256,text(256,1)),planReferences:aiReferences,chatRequests:array(aiChat,32),mode:{enum:['model','fallback']},reason:text(96,1),inferenceFailures:integer(),resourceHandoff,resourceHandoffCooldown:object({resourceId:id,untilTick:integer()}),outbox:array(optional({recipientId:id,text:text(500,1),requestId:id,status:{enum:['planned','declined','completed','blocked','expired']}},['recipientId','text','status']),32)};
const commander=optional(commanderProperties,['sequence','scoutIndex','buildAttempt','nextStrategicTick','pending','seenEnemies','generation','observationNonce','planGeneration','nextScoutTick','memory','fortifications','tributeCredits','planReferences','chatRequests','mode','reason','inferenceFailures','outbox']);
const assistantPreferences=object({modelId:{anyOf:[id,{type:'null'}]},enabled:flag,reserve:object(Object.fromEntries(balance.resourceOrder.map(resource=>[resource,integer(0,1_000_000)])))});
const assistant=object({preferences:assistantPreferences,protectedEntityIds:{...array(id,16000),uniqueItems:true},releaseAfterIdle:record(integer(-1),16000),autoReseedProtected:flag,cancelledSites:array(object({...positionFields,expiresTick:integer()}),2640),sequence:integer()});
const control=optional({mode:{enum:['human','disconnected','caretaker','ai']},generation:integer(),memory:caretaker,suspendedOrders:record(orders,2200),priorAutoReseed:flag,assistant},['mode','generation','memory','suspendedOrders']);

const projectileFields={sourceTypeId:unitId,launchHeightMm:integer(1,100000),id,ownerId:id,sourceId:id,from:position,aim:position,launchTick:integer(),hitTick:integer(),attack};
const projectile={oneOf:[optional({...projectileFields,kind:{const:'arrow'},targetId:id},['id','ownerId','sourceId','from','aim','launchTick','hitTick','attack','kind','targetId']),optional({...projectileFields,kind:{const:'stone'},bands:array(object({radiusM:number(),multiplier:number()}),8)},['id','ownerId','sourceId','from','aim','launchTick','hitTick','attack','kind','bands'])]};
const effect={...shared.effect,properties:{...shared.effect.properties,recipients:array(id,11)},required:[...shared.effect.required,'recipients']};
const mapValidation=optional({attempt:integer(0,50),connected:flag,spawnReports:array(object({playerId:id,resources,travelMm:resources}),11),travelVariation:object(Object.fromEntries(balance.resourceOrder.map(resource=>[resource,number()]))),resourceNodes:integer(0,balance.rules.maxResourceNodes),expansionPatches:integer(),broadRoutes:object({minimumWidthMm:integer(32000,64000),independentRoutes:{const:2},verifiedPairs:integer(1,55),sampledCells:integer(1,100000)}),longWar:object({homeSites:array(object({playerId:id,citadel:position,siegeYard:position,siegeYardRotation:{enum:[0,90]},giantExit:position}),11),nonStartingResources:resources,outerAccessVariation:object(Object.fromEntries(balance.resourceOrder.map(resource=>[resource,number()]))) }),forestBelts:object({frontiers:integer(0,32),openings:integer(0,96),minimumDepthMm:integer(0,30000),treeNodes:integer(0,balance.rules.maxResourceNodes),extraTreeNodes:integer(0,balance.rules.maxResourceNodes)})},['attempt','connected','spawnReports','travelVariation','resourceNodes','expansionPatches']);
const vision=object({visible:array(integer(0,102399),102400),explored:array(integer(0,102399),102400),memory:record(shared.entity,131072),actions:record(shared.visualAction,MAX_WORLD_ACTORS)});
const state=optional({rulesetId:{enum:['classic_v1','legendary_ages_v1']},maxAge:{enum:[4,5,6,7,8]},startingResourcePreset:{enum:['standard','long_war']},matchId:id,matchEpoch:integer(1,2147483647),tick:integer(),sequence:integer(),movementCadenceTier:{enum:[0,1,2,3]},frameRevision:integer(),randomState:integer(0,4294967295),secretIdKey:text(4096,1),entityNonce:integer(),status,factions:array(shared.publicPlayer,11,2),receipts:record(object({digest:hash,tick:integer(),receipt:shared.receipt}),100000,text(292,1)),eventOrdinal:integer(),commandLog:array(object({playerId:id,envelope,sequence:integer(1),tick:integer()}),4096),entities:record(entity,MAX_WORLD_ENTITIES),economies:record(economy,11),vision:record(vision,11),controllers:record(commander,11),control:record(control,11),widthMm:integer(1,640000),heightMm:integer(1,640000),navigationRevision:integer(),map:object({type:{enum:['open_frontier','river_divide']},generatorVersion:text(64,1),seed:text(4096,1),terrain:array(shared.terrainRegion,64),validation:mapValidation}),projectiles:array(projectile,20000),effects:array(effect,4096),ageAnnouncements:array(object({playerId:id,age:{enum:[2,3,4,5,6,7,8]},tick:integer()}),77),pathAdmission:record(object({tick:integer(),remaining:integer(0,50000),used:integer(0,50000)}),11),result:object({winnerTeamId:{anyOf:[id,{type:'null'}]},reason:text(128,1),durationTicks:integer(),statistics:array(shared.finalStatistics,11)})},['matchId','matchEpoch','tick','sequence','movementCadenceTier','randomState','secretIdKey','entityNonce','status','factions','receipts','eventOrdinal','commandLog','entities','economies','vision','controllers','control','widthMm','heightMm','navigationRevision','map','projectiles','effects','ageAnnouncements','pathAdmission']);
const obstacle=optional({id,...positionFields,halfWidth:number(0,640000),halfHeight:number(0,640000),circle:flag},['id','xMm','zMm','halfWidth','halfHeight']);
const search=object({heap:array(object({key:text(96,1),score:number()}),1638400),scores:record(number(),409600,text(96,1)),parents:record(text(96,1),409600,text(96,1)),closed:record({const:true},409600,text(96,1))});
const result={oneOf:[object({status:{const:'blocked'},id,orderRevision:integer()}),object({status:{const:'ready'},id,orderRevision:integer(),points:array(position,409600),regions:array(stamp,1600)})]};
const connectorBridge=object({queue:array(integer(0,6553599),CONNECTOR_NODE_LIMIT),cursor:integer(0,CONNECTOR_NODE_LIMIT),parents:record(integer(-1,6553599),CONNECTOR_NODE_LIMIT,{...text(7,1),pattern:'^(0|[1-9][0-9]*)$'}),cells:array(integer(0,409599),49)});
const connectorRoutes=array(object({cell:integer(0,409599),points:array(position,CONNECTOR_NODE_LIMIT,1)}),9,1);
const cornerSearch=optional({phase:{enum:['collect','search']},obstacleCursor:integer(0,CORNER_OBSTACLE_LIMIT),points:array(position,CORNER_POINT_LIMIT+2),work:integer(0,CORNER_WORK_LIMIT),scores:array({anyOf:[number(),{type:'null'}]},CORNER_POINT_LIMIT+2),parents:array(integer(-1,CORNER_POINT_LIMIT+1),CORNER_POINT_LIMIT+2),closed:array(flag,CORNER_POINT_LIMIT+2),current:integer(0,CORNER_POINT_LIMIT+1),edgeCursor:integer(0,CORNER_POINT_LIMIT+2),sweepStep:integer(0,4000),sweepSteps:integer(0,4000)},['phase','obstacleCursor','points','work']);
const task=optional({id,unitId:id,orderRevision:integer(),from:position,target:position,radiusMm:number(1,10000),profile:id,workClass:{enum:['interactive','routine','optional']},enqueuedTick:integer(),stage:{enum:['direct','corner','coarse','fine','done']},lineStep:integer(),lineSteps:integer(1,4000),result,corner:cornerSearch,starts:array(integer(0,409599),9),ends:array(integer(0,409599),9),prepareEndpoints:{const:true},startBridge:connectorBridge,endBridge:connectorBridge,startRoutes:connectorRoutes,endRoutes:connectorRoutes,startComponents:array(text(96,1),9),endComponents:array(text(96,1),9),coarse:search,currentComponent:text(96,1),edgeCursor:integer(0,63),corridor:array(text(32,1),1600),fine:search,currentCell:integer(0,409599),neighborCursor:integer(0,3),cacheKey:text(4096,1),lateCacheChecked:{const:true},endJoinChecked:{const:true}},['id','unitId','orderRevision','from','target','radiusMm','profile','stage','lineStep','lineSteps']);
const region=object({key:text(256,1),profile:id,radiusMm:number(1,10000),x:integer(0,39),z:integer(0,39),labels:array(integer(-2,255),256,256),cursor:integer(0,256),frontier:array(integer(0,255),256),frontierCursor:integer(0,256),label:integer(0,255),complete:flag});
const route=object({profile:id,radiusMm:number(1,10000),points:array(position,409600),regions:array(stamp,1600),corridor:array(text(32,1),1600)});
const sharedRequest=optional({id,unitId:id,orderRevision:integer(),from:position,target:position,radiusMm:number(1,10000),profile:id,workClass:{enum:['interactive','routine','optional']},enqueuedTick:integer()},['id','unitId','orderRevision','from','target','radiusMm','profile']);
const sharedMember=object({request:sharedRequest,geometryRevision:integer(),widthMm:integer(1,640000),heightMm:integer(1,640000),startComponents:array(text(96,1),9,1),endComponents:array(text(96,1),1,1),connectorRegions:array(text(32,1),4096)});
const sharedFrontier=optional({profile:id,radiusMm:number(1,10000),from:position,target:position,starts:array(integer(0,409599),9,1),ends:array(integer(0,409599),9,1),startComponents:array(text(96,1),9,1),endComponents:array(text(96,1),1,1),coarse:search,currentComponent:text(96,1),edgeCursor:integer(0,63)},['profile','radiusMm','from','target','starts','ends','startComponents','endComponents','coarse']);
const sharedJobs=object({geometryVersions:record(integer(),11),registry:object({version:{const:1},serials:record(integer(),11),waiting:array(sharedMember,2200),jobs:array(object({id:text(128,1),key:text(4096,1),frontier:sharedFrontier,geometryRevision:integer(),widthMm:integer(1,640000),heightMm:integer(1,640000),members:array(sharedMember,32,1),dependencies:array(text(32,1),4096)}),704)})});
const scheduler=optional({version:{const:1},tasks:array(task,2200),regions:array(region,100000),revisions:record(integer(),20000,text(128,1)),routes:array(tuple(text(4096,1),route),5632),cursor:integer(),profileCursors:record(integer(),11),invalidationClearances:record(number(1000,10000),11),priority:object({tick:integer(),profiles:record(object({phase:integer(0,3),interactive:integer(0,2200),routine:integer(0,2200),optional:integer(0,2200)}),11)}),sharedJobs},['version','tasks','regions','revisions','routes','cursor','profileCursors']);
const localRoute=optional({target:position,points:array(position,409600),retryTick:integer(),nextSearchCellMm:{enum:[250,1000]},neighborStamp:text(65536),stableSinceTick:integer(),lastProgress:flag,yield:object({requesterId:id,untilTick:integer(),point:position,origin:position})},['target','points','retryTick']);
// An acknowledged save contains compact waiting intents and bounded admitted
// answers. Worker-only neighbor snapshots and in-flight authority cannot persist.
const localDetourJob=optional({requestId:integer(1),orderRevision:integer(),body:object({id,...positionFields,radiusMm:number(1,10000)}),target:position,following:position,remainingPath:array(position,6),cellMm:{enum:[250,1000]},queuedTick:integer(),firstTick:integer(),dispatchedTick:integer(),status:{enum:['credit','queued','ready','retry']},ready:optional({tick:integer(),destination:position,points:array(position,128)},['tick','points'])},['requestId','orderRevision','body','target','remainingPath','cellMm','queuedTick','firstTick','status']);
const local=optional({tick:integer(),searches:integer(0,8),routes:array(tuple(id,localRoute),2200),waiting:array(tuple(id,object({firstTick:integer(),lastTick:integer()})),2200),grants:array(id,8),deferred:object({version:{const:1},nextRequestId:integer(1),jobs:array(tuple(id,localDetourJob),2200)})},['tick','searches','routes','waiting','grants']);
const runtime=object({profileIds:array(id,11,2),planningProfiles:array(tuple(id,object({revision:integer(),obstacles:array(tuple(text(256,1),obstacle),131200)})),11,2),pathScheduler:scheduler,approachReservations:array(tuple(id,array(tuple(id,object({targetId:id,position,radiusMm:number(1,10000)})),2200)),11,2),localAvoidance:array(tuple(id,local),11,2)});
const payloadSchema={$id:'urn:frontier:simulation-save:v1',$defs:{order},...object({schemaVersion:{const:1},contentHash:hash,options:optional({rulesetId:{enum:['classic_v1','legendary_ages_v1']},maxAge:{enum:[4,5,6,7,8]},startingResourcePreset:{enum:['standard','long_war']},authoritativeIntervalMs:{enum:[50,300]},localPlanningMode:{const:'deferred-v1'},populationLimit:{enum:[80,120,200]},sharedVision:flag,controllers:flag,monumentVictory:flag,caretakerEnabled:flag,seed:{anyOf:[text(4096,1),number(-Number.MAX_SAFE_INTEGER)]},mapType:{enum:['open_frontier','river_divide']},mapSize:{enum:['auto','small','medium','large']}},['populationLimit','sharedVision','controllers','monumentVictory','caretakerEnabled','seed','mapType','mapSize']),state,runtime})};
const journalBase={ordinal:integer(1),tick:integer(),phase:{enum:['boundary','controllers']}};
const commanderPatch=object({path:array({anyOf:[integer(),{...text(256,1),not:{enum:['__proto__','prototype','constructor']}}]},12),value:{}});
const journalSchema={$id:'urn:frontier:simulation-journal:v1',oneOf:[
  object({...journalBase,kind:{const:'command'},playerId:id,envelope,receipt:shared.receipt,source:{enum:['human','ai','caretaker']}}),
  object({...journalBase,kind:{const:'invalid_command'},playerId:id,receipt:shared.receipt}),
  object({...journalBase,phase:{const:'boundary'},kind:{const:'movement_cadence'},tier:{enum:[0,1,2,3]}}),
  object({...journalBase,phase:{const:'boundary'},kind:{enum:['planning_service_start','planning_service_admit']},leases:integer(1,60)}),
  object({...journalBase,phase:{const:'boundary'},kind:{const:'planning_stall_recovery'},proposals:array(object({unitId:id,requestId:id,orderRevision:integer(),progressTick:integer(),playerId:id}),16,1)}),
  object({...journalBase,kind:{const:'status'},status}),object({...journalBase,kind:{const:'epoch'},epoch:integer(1,2147483647)}),object({...journalBase,kind:{const:'draw'}}),object({...journalBase,kind:{const:'admin_surrender'},playerId:id}),
  object({...journalBase,kind:{const:'controller_memory'},playerId:id,memory:commander}),object({...journalBase,kind:{const:'commander_memory'},playerId:id,memory:commander}),object({...journalBase,kind:{const:'caretaker_memory'},playerId:id,memory:caretaker}),object({...journalBase,kind:{const:'control'},playerId:id,mode:{enum:['human','disconnected','caretaker']}}),
  object({...journalBase,kind:{const:'assistant'},playerId:id,preferences:assistantPreferences}),object({...journalBase,kind:{const:'assistant_release'},playerId:id,entityIds:{...array(id,2200),uniqueItems:true}}),object({...journalBase,kind:{const:'ai_model'},playerId:id,modelId:id}),
  object({...journalBase,kind:{const:'commander_patch'},playerId:id,patches:array(commanderPatch,256,1)}),
]};
const compiledPayload=ajv.compile<SimulationSavePayload>(payloadSchema),compiledJournal=ajv.compile<JournalEvent>(journalSchema),compiledCommander=ajv.compile<CommanderState>(commander);
const unique=(values:readonly (string|number)[])=>new Set(values).size===values.length;
const sameKeys=(keys:readonly string[],expected:readonly string[])=>keys.length===expected.length&&unique(keys)&&keys.every(key=>expected.includes(key));
function constructionSemantic(state:Pick<CommanderState,'construction'|'constructionRecon'|'constructionAvoid'>,tick:number):boolean {
  const recon=state.constructionRecon;if(recon&&(recon.createdTick>tick||!unique(recon.members.map(member=>member.id))||recon.members.some(member=>member.lastProgressTick>tick||(member.issuedTick??0)>tick)))return false;
  if(state.constructionAvoid?.some(entry=>entry.untilTick>tick+180*balance.rules.simulationHz))return false;
  return Object.values(state.construction??{}).every(record=>record.lastProgressTick<=tick&&(record.blockedSinceTick??0)<=tick&&(record.retryAtTick??0)<=tick+balance.ai.difficulty.easy.strategicIntervalSeconds*balance.rules.simulationHz&&Object.values(record.builders).every(builder=>builder.lastMovedTick<=tick));
}
function commanderSemantic(state:CommanderState,playerId:string,tick:number):boolean {
  if(!constructionSemantic(state,tick))return false;
  if(state.scoutRoute&&state.scoutRoute.issuedTick>tick)return false;
  if(state.memory.playerId!==playerId||!unique(state.memory.facts.map(fact=>fact.id))||!unique(state.memory.recentReceipts.map(receipt=>receipt.clientCommandId))||!unique(state.chatRequests.map(request=>request.requestId)))return false;
  for(const fact of state.memory.facts){const claimed=fact.provenance==='human_claim'||fact.provenance==='team_ping';if(fact.tick>tick||fact.expiresTick<fact.tick||claimed&&fact.confidence!=='unverified'||!claimed&&(fact.confidence!=='observed'||fact.sourcePlayerId!==playerId))return false;}
  if(state.memory.recentReceipts.some(receipt=>receipt.tick>tick)||state.pending.some(batch=>batch.executeTick<batch.observedTick||batch.observedTick>tick)||state.chatRequests.some(request=>request.recipientId!==playerId||request.tick>tick))return false;
  const handoff=state.resourceHandoff;if(handoff&&(handoff.issuedTick>tick||handoff.lastProgressTick>tick||handoff.expiresTick<handoff.issuedTick||handoff.expiresTick-handoff.issuedTick>4*balance.ai.goalTtlSeconds*balance.rules.simulationHz||handoff.lastProgressTick>handoff.expiresTick))return false;
  if(state.resourceHandoffCooldown&&state.resourceHandoffCooldown.untilTick>tick+balance.ai.difficulty.easy.strategicIntervalSeconds*balance.rules.simulationHz)return false;
  for(const memory of Object.values(state.fortifications)){
    const shape=memory.layout??memory.screen;
    if(shape){const [owner,anchor,material,radius,...extra]=(memory.goalKey??'').split(':');if(owner!==playerId||!anchor||!/^[A-Za-z0-9_-]+$/.test(anchor)||!['palisade','stone','bastion','runestone','titan','eternal'].includes(material??'')||!Number.isInteger(Number(radius))||Number(radius)<18||Number(radius)>60||extra.length||!memory.layoutKey||memory.layout&&memory.screen||memory.layout&&(!validFortifyLayout(memory.layout)||memory.layout.gates.some(g=>(g.widthCells??3)!==(['palisade','stone'].includes(material!)?3:5)))||memory.screen&&!validFortifyScreen(memory.screen))return false;}
    if(memory.layoutCommitted&&!shape||memory.layoutKey&&!shape)return false;
    if(memory.proofPhase&&(!shape||!memory.geometryKey||memory.validatedResources===undefined||memory.validatedFaces===undefined||memory.routesValid))return false;
    if(shape&&memory.routesValid&&(memory.validatedFaces!==4||memory.validatedResources===undefined||!memory.geometryKey))return false;
  }
  if(state.activeRequest){const binding=state.activeRequest.binding;if(binding.playerId!==playerId||binding.controllerGeneration!==state.generation||binding.observedTick>tick||binding.matchId!==state.memory.matchId)return false;}
  for(const references of [state.planReferences,...(state.activeRequest?[state.activeRequest.references]:[]),...(state.plan?.goals.flatMap(goal=>goal.frozenReferences?[goal.frozenReferences]:[])??[])])for(const [key,reference]of Object.entries(references))if(key!==reference.ref||'lastSeenTick'in reference&&reference.lastSeenTick>tick)return false;
  if(state.plan&&(state.plan.generation>state.planGeneration||state.plan.acceptedTick>tick||state.plan.expiresTick<state.plan.acceptedTick||!unique(state.plan.goals.map(goal=>goal.key))||!validateAiPlan({schemaVersion:1,observationId:'saved_plan',strategy:state.plan.strategy,goals:state.plan.goals.map(goal=>goal.goal),message:null})||state.plan.goals.some(goal=>goal.kind!==goal.goal.kind||goal.acceptedTick>tick||goal.expiresTick<goal.acceptedTick||goal.lastIssuedTick!==undefined&&goal.lastIssuedTick>tick)))return false;
  for(const entry of state.plan?.goals??[])if(entry.source==='preset'){
    const goal=entry.goal,refs=entry.frozenReferences!;
    if(goal.kind!=='tribute'&&goal.kind!=='army_order')return false;
    const keys=goal.kind==='tribute'?[goal.allyRef]:[goal.squadRef,goal.targetRef];if(!sameKeys(Object.keys(refs),[...new Set(keys)]))return false;
    const chat=state.chatRequests.find(request=>request.requestId===entry.correlationId),live=entry.expiresTick>tick&&!['fulfilled','rejected','expired'].includes(entry.status);
    if(!chat&&live||chat&&!chat.intent)return false;
    if(goal.kind==='tribute'){
      const ally=refs[goal.allyRef];if(ally?.kind!=='ally'||chat&&(chat.intent?.action!=='tribute'||chat.intent.resource!==goal.resource||chat.intent.amount!==goal.amount||ally.playerId!==chat.senderId))return false;
    }else{
      const squad=refs[goal.squadRef],target=refs[goal.targetRef];if(squad?.kind!=='squad'||!target||!['team_ping','ally_anchor'].includes(target.kind))return false;
      if(chat){const intent=chat.intent!;if(intent.action==='tribute'||goal.order!==(intent.action==='defend_base'?'assist':'attack')||target.kind==='team_ping'&&target.senderId!==chat.senderId||target.kind==='ally_anchor'&&target.playerId!==chat.senderId)return false;
        if(intent.action==='attack_ping'&&('position'in target)&&(target.position.xMm!==intent.position.xMm||target.position.zMm!==intent.position.zMm))return false;}
    }
  }
  return true;
}
function semantic(payload:SimulationSavePayload):boolean {
  const {state:s,runtime:r,options}=payload,ids=s.factions.map(faction=>faction.id),owners=new Set(ids);
  if(s.rulesetId!==options.rulesetId||s.maxAge!==options.maxAge||s.startingResourcePreset!==options.startingResourcePreset)return false;
  if(options.localPlanningMode!==undefined&&options.authoritativeIntervalMs!==300)return false;
  if(payload.contentHash!==resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset).contentHash||!unique(ids)||s.factions.filter(faction=>faction.kind==='human').length>6||s.factions.filter(faction=>faction.kind==='ai').length>5||ids.some(id=>['__proto__','constructor','prototype'].includes(id))||String(options.seed)!==s.map.seed||options.mapType!==s.map.type||!sameKeys(r.profileIds,ids))return false;
  for(const data of [s.economies,s.vision,s.controllers,s.control,s.pathAdmission!])if(!sameKeys(Object.keys(data),ids))return false;
  for(const entries of [r.planningProfiles,r.approachReservations,r.localAvoidance])if(!sameKeys(entries.map(([id])=>id),ids))return false;
  if(!Object.keys(r.pathScheduler.profileCursors!).every(id=>owners.has(id)))return false;
  if(r.pathScheduler.invalidationClearances&&!Object.keys(r.pathScheduler.invalidationClearances).every(id=>owners.has(id)))return false;
  const fogCells=s.widthMm/2000*s.heightMm/2000;if(s.widthMm%2000||s.heightMm%2000||fogCells>102400)return false;
  for(const [id,e]of Object.entries(s.entities)){
    if(id!==e.id||e.xMm>s.widthMm||e.zMm>s.heightMm||e.hp>e.maxHp||e.kind!=='resource'&&!owners.has(e.ownerId))return false;
    if(e.kind==='resource'&&e.forest&&(e.resource!=='wood'||e.xMm<e.forest.cellMm/2||e.zMm<e.forest.cellMm/2||e.xMm+e.forest.cellMm/2>s.widthMm||e.zMm+e.forest.cellMm/2>s.heightMm))return false;
    if(e.kind!=='resource'&&!isContentAllowed(e.typeId,options.rulesetId,options.maxAge))return false;
    if(e.kind==='unit'){
      if((e.cargo.resource===null)!==(e.cargo.amount===0)||e.garrisonedIn&&(!s.entities[e.garrisonedIn]||s.entities[e.garrisonedIn]?.kind==='resource'))return false;
      if((e.garrisoned?.length??0)>(units[e.typeId].mobileGarrisonCapacity??0)||!unique(e.garrisoned??[]))return false;for(const id of e.garrisoned??[]){const passenger=s.entities[id];if(passenger?.kind!=='unit'||passenger.garrisonedIn!==e.id||!units[passenger.typeId].canGarrison||units[passenger.typeId].tags.some(tag=>['worker','siege','colossal'].includes(tag)))return false;}
      const failed=e.approachGoal?.failedPoints??[];
      if(e.resourceSearch&&(e.typeId!=='villager'||!unique(e.resourceSearch.targetIds)||e.resourceSearch.index>e.resourceSearch.targetIds.length||e.resourceSearch.purpose==='idle'&&e.orders.length>0||e.resourceSearch.purpose!=='idle'&&e.orders[0]?.kind!=='gather'||e.resourceSearch.purpose==='forest'&&!e.orders[0]?.forestIntentId))return false;
      if(e.orders.some(order=>order.forestIntentId&&(order.kind!=='gather'||e.typeId!=='villager')))return false;
      if(!unique(failed.map(point=>`${point.xMm},${point.zMm}`))||failed.some(point=>point.xMm>s.widthMm||point.zMm>s.heightMm||e.approachGoal?.point?.xMm===point.xMm&&e.approachGoal.point.zMm===point.zMm))return false;
      for(const order of e.orders){if(['move','attack_move','attack_ground'].includes(order.kind)&&!order.target||['attack','gather','build','repair','garrison','reseed'].includes(order.kind)&&!order.targetId||order.kind==='patrol'&&(!order.points||order.points.length<2||order.pointIndex!==undefined&&order.pointIndex>=order.points.length))return false;}
      if(e.garrisonedIn){const host=s.entities[e.garrisonedIn]!;if(host.kind==='resource'||!host.garrisoned?.includes(e.id))return false;}
    }
    if(e.kind==='building'){
      if(e.pendingConstruction&&(e.work!==0||e.queue.length>0||e.upgrade||e.ward||e.garrisoned?.length||e.reseedRequired||e.monumentCompletedTick!==undefined||e.gateOpen))return false;
      if(e.upgrade){const upgrade=structureUpgrade(e.typeId,e.upgrade.targetTypeId);if(!upgrade||!isContentAllowed(e.upgrade.targetTypeId,options.rulesetId,options.maxAge)||e.upgrade.work>e.upgrade.required||!e.upgrade.started&&e.upgrade.work>0||e.upgrade.required!==upgrade.seconds*balance.rules.simulationHz*100||balance.resourceOrder.some(resource=>upgrade.cost[resource]!==e.upgrade!.originalCost[resource]))return false;}
      if(e.ward&&(e.ward.current>e.ward.max||e.ward.quietSinceTick>s.tick||!buildings[e.typeId].wardEligible||s.entities[e.ward.supportId]?.typeId!=='ward_spire'||s.entities[e.ward.supportId]?.ownerId!==e.ownerId))return false;
      if(e.work>e.required||e.grantedHp>e.maxHp||e.reseedWork!==undefined&&(e.reseedRequired===undefined||e.reseedWork>e.reseedRequired)||!unique(e.queue.map(job=>job.id))||!unique(e.garrisoned??[])||!unique(e.pendingUngarrison??[]))return false;
      for(const job of e.queue){
        if(job.work>job.required||!job.started&&job.work!==0||job.kind!=='train'&&job.reserved||job.state==='prerequisite_blocked'&&!job.blockedReason||job.kind==='age'&&job.typeId!==`age_${job.targetAge}`)return false;
        if(job.kind!=='age'&&!isContentAllowed(job.typeId,options.rulesetId,options.maxAge))return false;
        const definition=job.kind==='train'?units[job.typeId]:job.kind==='research'?technologies[job.typeId]:resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset).ages.find(age=>age.id===job.targetAge)!;
        if(!definition)return false;const seconds='trainSeconds'in definition?definition.trainSeconds:definition.researchSeconds;
        if(job.required!==seconds*balance.rules.simulationHz||balance.resourceOrder.some(resource=>job.originalCost[resource]!==definition.cost[resource])||job.kind==='train'&&units[job.typeId].producedAt!==e.typeId||job.kind==='research'&&technologies[job.typeId].researchedAt!==e.typeId||job.kind==='age'&&e.typeId!=='town_center')return false;
      }
      if((e.garrisoned?.length??0)>buildings[e.typeId].garrisonCapacity)return false;
      for(const id of e.garrisoned??[]){const occupant=s.entities[id];if(occupant?.kind!=='unit'||occupant.garrisonedIn!==e.id)return false;}
      for(const key of Object.keys(e.repairRemainders??{}))if(!owners.has(key))return false;
    }
  }
  if(s.rulesetId==='legendary_ages_v1'){
    const counts=new Map<string,Map<string,number>>(),families=new Map<string,Map<string,number>>();
    const add=(map:Map<string,Map<string,number>>,owner:string,key:string)=>{let row=map.get(owner);if(!row){row=new Map();map.set(owner,row);}row.set(key,(row.get(key)??0)+1);};
    for(const entity of Object.values(s.entities))if(entity.kind!=='resource'&&entity.hp>0){
      add(counts,entity.ownerId,entity.typeId);
      if(entity.kind==='building'){const definition=buildings[entity.typeId];if(definition.family)add(families,entity.ownerId,definition.family);if(entity.upgrade)add(counts,entity.ownerId,entity.upgrade.targetTypeId);for(const job of entity.queue)if(job.kind==='train')add(counts,entity.ownerId,job.typeId);}
    }
    for(const [owner,row]of counts)for(const [type,count]of row){const definition=units[type]??buildings[type],structure=buildings[type];if(definition?.maxPerPlayer&&count>definition.maxPerPlayer)return false;if(structure?.familyCap&&(families.get(owner)?.get(structure.family!)??0)>structure.familyCap)return false;}
  }
  for(const id of ids){
    const economy=s.economies[id]!,vision=s.vision[id]!,budget=s.pathAdmission![id]!;if(economy.age>(options.maxAge??4)||economy.technologies.some(id=>!isContentAllowed(id,options.rulesetId,options.maxAge))||economy.researchRevision!==economy.technologies.length||budget.remaining+budget.used!==50000||budget.tick>s.tick)return false;
    if(economy.aiResignationSinceTick!==undefined&&(economy.aiResignationSinceTick>s.tick||economy.defeated||s.factions.find(f=>f.id===id)!.kind!=='ai'))return false;
    if(!unique(vision.visible)||!unique(vision.explored)||vision.explored.some(cell=>cell>=fogCells))return false;const explored=new Set(vision.explored);if(vision.visible.some(cell=>!explored.has(cell)))return false;
    for(const [key,memory]of Object.entries(vision.memory))if(key!==memory.id||memory.kind==='unit'||memory.ownerId===id||memory.ownerId!==null&&!owners.has(memory.ownerId)||OWNED_ENTITY_FIELDS.some(field=>Object.hasOwn(memory,field)))return false;
    if(Object.values(vision.actions).some(action=>action.startedTick>s.tick)||Object.values(vision.memory).some(memory=>memory.visualAction&&memory.visualAction.startedTick>(memory.lastSeenTick??s.tick)))return false;
    if(s.factions.find(faction=>faction.id===id)!.kind==='ai'&&s.control[id]!.mode!=='ai')return false;
    for(const pending of s.control[id]!.memory.pending)if(pending.executeTick<pending.observedTick)return false;
    const commander=s.controllers[id] as CommanderState;
    for(const memory of [commander,s.control[id]!.memory]){const explorer=memory.explorerId&&s.entities[memory.explorerId];if(explorer&&(explorer.ownerId!==id||explorer.typeId!=='villager')||memory.scoutRoute&&(memory.scoutRoute.issuedTick>s.tick||memory.scoutRoute.target.xMm>s.widthMm||memory.scoutRoute.target.zMm>s.heightMm)||!constructionSemantic(memory,s.tick))return false;
      const recon=memory.constructionRecon;if(recon){const grid=balance.rules.buildingGridM*1000,def=buildings[recon.typeId];if((recon.origin.x+def.footprintCells[0])*grid>s.widthMm||(recon.origin.z+def.footprintCells[1])*grid>s.heightMm||recon.members.some(member=>[member.target,member.lastPosition].some(point=>point.xMm>s.widthMm||point.zMm>s.heightMm)||s.entities[member.id]&&(s.entities[member.id]!.ownerId!==id||!['villager','scout'].includes(s.entities[member.id]!.typeId))))return false;}
      if(memory.constructionAvoid?.some(entry=>{let [w,h]=buildings[entry.typeId].footprintCells;if(entry.rotation===90||entry.rotation===270)[w,h]=[h,w];const x=entry.position.xMm,z=entry.position.zMm,scale=balance.rules.buildingGridM*500;return x-w*scale<0||x+w*scale>s.widthMm||z-h*scale<0||z+h*scale>s.heightMm;}))return false;
      for(const [siteId,record]of Object.entries(memory.construction??{})){const site=s.entities[siteId];if(site&&(site.ownerId!==id||site.kind!=='building'))return false;for(const [workerId,position]of Object.entries(record.builders)){const worker=s.entities[workerId];if(worker&&(worker.ownerId!==id||worker.typeId!=='villager')||position.xMm>s.widthMm||position.zMm>s.heightMm)return false;}const helper=record.helperId&&s.entities[record.helperId];if(helper&&(helper.ownerId!==id||helper.typeId!=='villager'))return false;}
    }
    if(!commanderSemantic(commander,id,s.tick)||commander.memory.matchId!==s.matchId||commander.activeRequest&&commander.activeRequest.binding.matchEpoch!==s.matchEpoch)return false;
    const handoff=commander.resourceHandoff;if(handoff&&([handoff.target,handoff.lastPosition].some(point=>point.xMm>s.widthMm||point.zMm>s.heightMm)||s.entities[handoff.workerId]&&(s.entities[handoff.workerId]!.ownerId!==id||s.entities[handoff.workerId]!.typeId!=='villager')))return false;
    for(const memory of Object.values(commander.fortifications)){const shape=memory.layout??memory.screen;if(shape){const anchor=s.entities[memory.goalKey!.split(':')[1]!],grid=balance.rules.buildingGridM*1000;if(anchor&&(anchor.ownerId!==id||anchor.kind!=='building')||shape.origin.xMm>s.widthMm||shape.origin.zMm>s.heightMm||shape.cells.some(cell=>(cell.x+1)*grid>s.widthMm||(cell.z+1)*grid>s.heightMm))return false;}}
    const faction=s.factions.find(faction=>faction.id===id)!,assistant=s.control[id]!.assistant;
    if(faction.aiModelId&&faction.kind!=='ai')return false;
    if(assistant&&(faction.kind!=='human'||assistant.preferences.enabled&&!assistant.preferences.modelId||assistant.protectedEntityIds.some(entityId=>s.entities[entityId]&&s.entities[entityId]!.ownerId!==id)||Object.entries(assistant.releaseAfterIdle).some(([entityId,tick])=>!assistant.protectedEntityIds.includes(entityId)||tick>s.tick)))return false;
    if(faction.assistant&&(faction.kind!=='human'||!assistant||faction.assistant.enabled!==assistant.preferences.enabled||faction.assistant.modelId!==assistant.preferences.modelId))return false;
    if(faction.kind==='human'&&(!assistant?.preferences.enabled||!assistant.preferences.modelId||s.control[id]!.mode!=='human')&&(commander.activeRequest||commander.plan||commander.mode==='model'))return false;
    const team=s.factions.find(faction=>faction.id===id)!.teamId,allied=(other:string)=>other!==id&&s.factions.some(faction=>faction.id===other&&faction.teamId===team);
    if(commander.chatRequests.some(request=>!allied(request.senderId))||commander.outbox.some(message=>!allied(message.recipientId))||commander.memory.facts.some(fact=>fact.confidence==='unverified'&&!allied(fact.sourcePlayerId)))return false;
    for(const registry of [commander.planReferences,...(commander.activeRequest?[commander.activeRequest.references]:[]),...(commander.plan?.goals.flatMap(goal=>goal.frozenReferences?[goal.frozenReferences]:[])??[])])for(const reference of Object.values(registry)){
      if('position'in reference&&(reference.position.xMm>s.widthMm||reference.position.zMm>s.heightMm)||'playerId'in reference&&!allied(reference.playerId)||reference.kind==='team_ping'&&!allied(reference.senderId))return false;
      if(reference.kind==='squad'&&reference.entityIds.some(entityId=>s.entities[entityId]&&s.entities[entityId]!.ownerId!==id)||reference.kind==='own_base'&&s.entities[reference.entityId]&&s.entities[reference.entityId]!.ownerId!==id)return false;
    }
  }
  for(const [key,entry]of Object.entries(s.receipts)){const parts=key.split(':');if((parts.length!==3&&(parts.length!==4||parts[2]!=='ai'||!s.control[parts[1]!]?.assistant))||!owners.has(parts[1]!)||Number(parts[0])>s.matchEpoch||entry.tick>s.tick||parts.at(-1)!==entry.receipt.clientCommandId)return false;}
  if(s.commandLog.some((entry,index)=>!owners.has(entry.playerId)||entry.tick>s.tick||entry.sequence>s.sequence||index>0&&entry.sequence<=s.commandLog[index-1]!.sequence))return false;
  if(s.effects.some(effect=>effect.tick>s.tick||effect.ownerId!==undefined&&!owners.has(effect.ownerId)||!unique(effect.recipients)||effect.recipients.some(id=>!owners.has(id)))||s.projectiles.some(projectile=>!owners.has(projectile.ownerId)||projectile.hitTick<projectile.launchTick)||s.ageAnnouncements.some(announcement=>!owners.has(announcement.playerId)||announcement.tick>s.tick))return false;
  for(const [_id,profile]of r.planningProfiles)if(!unique(profile.obstacles.map(([key])=>key)))return false;
  for(const [playerId,entries]of r.approachReservations)if(!unique(entries.map(([id])=>id))||entries.some(([id])=>s.entities[id]?.ownerId!==playerId))return false;
  for(const [playerId,local]of r.localAvoidance){
    if(!unique(local.routes.map(([id])=>id))||!unique(local.waiting.map(([id])=>id))||!unique(local.grants)||local.tick>s.tick)return false;
    for(const [id]of local.routes)if(s.entities[id]?.ownerId!==playerId)return false;
    const deferred=local.deferred;if(!deferred){if(options.localPlanningMode==='deferred-v1')return false;continue;}
    if(options.localPlanningMode!=='deferred-v1'||!unique(deferred.jobs.map(([id])=>id))||!unique(deferred.jobs.map(([,job])=>job.requestId)))return false;
    const routes=new Set(local.routes.map(([id])=>id)),inside=(point:{xMm:number;zMm:number})=>point.xMm<=s.widthMm&&point.zMm<=s.heightMm;
    for(const [id,job]of deferred.jobs){
      const unit=s.entities[id];
      if(unit?.kind!=='unit'||unit.ownerId!==playerId||job.body.id!==id||job.orderRevision!==(unit.orderRevision??0)||!routes.has(id)||job.requestId>=deferred.nextRequestId||job.firstTick>job.queuedTick||job.queuedTick>s.tick)return false;
      if((job.status==='ready')!==Boolean(job.ready)||(job.status==='ready')!==(job.dispatchedTick!==undefined))return false;
      if(!inside(job.body)||!inside(job.target)||job.following&&!inside(job.following)||job.remainingPath.some(point=>!inside(point)))return false;
      if(job.ready&&(job.dispatchedTick!<job.queuedTick||job.ready.tick<job.dispatchedTick!||job.ready.tick>s.tick||job.ready.destination&&!inside(job.ready.destination)||job.ready.points.some(point=>!inside(point))||job.ready.points.length>0&&!job.ready.destination))return false;
      // A position, goal, radius or geometry may have changed after movement.
      // Preserve stale compact intents; dispatch/use revalidates their authority.
    }
  }
  const scheduler=r.pathScheduler;if(!unique(scheduler.tasks.map(task=>task.unitId))||!unique(scheduler.regions.map(region=>region.key))||!unique(scheduler.routes.map(([key])=>key)))return false;
  const validClearance=(profile:string,radius:number)=>!scheduler.invalidationClearances||(scheduler.invalidationClearances[profile]??1000)>=radius;
  if(scheduler.priority&&(scheduler.priority.tick>s.tick||Object.keys(scheduler.priority.profiles).some(profile=>!owners.has(profile))))return false;
  for(const task of scheduler.tasks){
    if(!validClearance(task.profile,task.radiusMm))return false;
    if((task.workClass===undefined)!==(task.enqueuedTick===undefined)||task.enqueuedTick!==undefined&&(task.enqueuedTick>s.tick||!scheduler.priority))return false;
    if(!owners.has(task.profile)||s.entities[task.unitId]?.ownerId!==task.profile||task.lineStep>task.lineSteps||task.stage==='done'&&!task.result||task.stage!=='done'&&task.result||['coarse','fine'].includes(task.stage)&&(!task.starts||!task.ends)||task.stage==='fine'&&(!task.fine||!task.coarse||!task.corridor)||task.currentComponent!==undefined&&(!task.coarse||task.edgeCursor===undefined)||task.currentCell!==undefined&&(!task.fine||task.neighborCursor===undefined))return false;
    if(task.coarse&&(!task.startComponents||!task.endComponents||!task.cacheKey)||task.currentComponent!==undefined&&!Object.hasOwn(task.coarse!.scores,task.currentComponent)||task.currentCell!==undefined&&!Object.hasOwn(task.fine!.scores,String(task.currentCell))||(task.edgeCursor===undefined)!==(task.currentComponent===undefined)||(task.neighborCursor===undefined)!==(task.currentCell===undefined))return false;
    if((task.lateCacheChecked||task.endJoinChecked)&&(!task.fine||!task.cacheKey||!['fine','done'].includes(task.stage)))return false;
    if(task.prepareEndpoints&&(task.stage!=='coarse'||!task.starts||task.starts.length||!task.ends||task.ends.length||['corner','startBridge','endBridge','startRoutes','endRoutes','startComponents','endComponents','coarse','fine','corridor','cacheKey','currentComponent','edgeCursor','currentCell','neighborCursor','lateCacheChecked','endJoinChecked'].some(key=>Object.hasOwn(task,key))))return false;
    if(task.result&&(task.result.id!==task.id||task.result.orderRevision!==task.orderRevision))return false;
    if(task.corner||task.stage==='corner'){
      if(['starts','ends','startBridge','endBridge','startRoutes','endRoutes','startComponents','endComponents','coarse','fine','corridor','cacheKey','currentComponent','edgeCursor','currentCell','neighborCursor','lateCacheChecked','endJoinChecked'].some(key=>Object.hasOwn(task,key)))return false;
      const profile=r.planningProfiles.find(([id])=>id===task.profile)?.[1];
      if(!profile||!validCornerPathSearch(task,s.widthMm,s.heightMm,profile.obstacles.map(([,obstacle])=>obstacle)))return false;
    }
    for(const [endpoint,bridge,routes,cells]of [[task.from,task.startBridge,task.startRoutes,task.starts],[task.target,task.endBridge,task.endRoutes,task.ends]] as const){
      const width=Math.floor(s.widthMm/CONNECTOR_CELL_MM),height=Math.floor(s.heightMm/CONNECTOR_CELL_MM),cx=Math.floor(endpoint.xMm/CONNECTOR_CELL_MM),cz=Math.floor(endpoint.zMm/CONNECTOR_CELL_MM),coarseWidth=Math.floor(s.widthMm/1000);
      const inPatch=(x:number,z:number)=>x>=0&&z>=0&&x<width&&z<height&&Math.abs(x-cx)<=CONNECTOR_REACH_CELLS&&Math.abs(z-cz)<=CONNECTOR_REACH_CELLS;
      if(bridge){
        if(routes||!cells||cells.length||task.coarse||!['coarse','done'].includes(task.stage)||task.stage==='done'&&task.result?.status!=='blocked'||bridge.cursor>bridge.queue.length||!unique(bridge.queue)||Object.keys(bridge.parents).length!==bridge.queue.length)return false;
        const indices=new Map(bridge.queue.map((cell,index)=>[cell,index]));let roots=0,foundChild=false;const expectedCells:number[]=[];
        for(const [index,cell]of bridge.queue.entries()){
          const x=cell%width,z=Math.floor(cell/width),parent=bridge.parents[String(cell)];if(!inPatch(x,z)||parent===undefined)return false;
          if(parent===-1){if(foundChild||++roots>9||Math.abs(x-cx)>3||Math.abs(z-cz)>3)return false;}
          else{foundChild=true;const parentIndex=indices.get(parent);if(parentIndex===undefined||parentIndex>=index||parentIndex>=bridge.cursor||Math.abs(x-parent%width)+Math.abs(z-Math.floor(parent/width))!==1)return false;}
          if(index<bridge.cursor&&x*CONNECTOR_CELL_MM%1000===0&&z*CONNECTOR_CELL_MM%1000===0)expectedCells.push(z*CONNECTOR_CELL_MM/1000*coarseWidth+x*CONNECTOR_CELL_MM/1000);
        }
        if(JSON.stringify(expectedCells)!==JSON.stringify(bridge.cells))return false;
      }
      if(routes){
        if(task.stage==='direct'||!cells||JSON.stringify(routes.map(route=>route.cell))!==JSON.stringify(cells)||!unique(cells))return false;
        for(const route of routes){const last=route.points.at(-1)!;if(last.xMm!==route.cell%coarseWidth*1000||last.zMm!==Math.floor(route.cell/coarseWidth)*1000)return false;for(const [index,point]of route.points.entries()){if(point.xMm%CONNECTOR_CELL_MM||point.zMm%CONNECTOR_CELL_MM||!inPatch(point.xMm/CONNECTOR_CELL_MM,point.zMm/CONNECTOR_CELL_MM))return false;const previous=route.points[index-1];if(previous&&point.xMm!==previous.xMm&&point.zMm!==previous.zMm)return false;}}
      }
    }
    for(const [kind,search]of [['coarse',task.coarse],['fine',task.fine]] as const)if(search){
      const validKey=(key:string)=>kind==='fine'?/^(0|[1-9][0-9]*)$/.test(key)&&Number(key)<s.widthMm/1000*s.heightMm/1000:/^[0-9]+,[0-9]+,[0-9]+$/.test(key)&&key.split(',').every((part,index)=>Number(part)<(index===0?Math.ceil(s.widthMm/16000):index===1?Math.ceil(s.heightMm/16000):256));
      if(Object.keys(search.scores).some(key=>!validKey(key))||search.heap.some(item=>!validKey(item.key)||!Object.hasOwn(search.scores,item.key))||Object.keys(search.closed).some(key=>!Object.hasOwn(search.scores,key)))return false;
      for(const [key,parent]of Object.entries(search.parents))if(!Object.hasOwn(search.scores,key)||!Object.hasOwn(search.scores,parent))return false;
      const checked=new Set<string>();for(const key of Object.keys(search.parents)){const chain=new Set<string>();let cursor:string|undefined=key;while(cursor!==undefined&&!checked.has(cursor)){if(chain.has(cursor))return false;chain.add(cursor);cursor=search.parents[cursor];}for(const item of chain)checked.add(item);}
    }
  }
  for(const region of scheduler.regions)if(!validClearance(region.profile,region.radiusMm)||!owners.has(region.profile)||region.key!==`${region.profile}:${region.radiusMm}:${region.x},${region.z}`||region.frontierCursor>region.frontier.length||!unique(region.frontier)||region.complete&&(region.cursor!==256||region.labels.includes(-2)))return false;
  const routeCounts=new Map<string,number>();for(const [,route]of scheduler.routes){const count=(routeCounts.get(route.profile)??0)+1;if(!validClearance(route.profile,route.radiusMm)||!owners.has(route.profile)||count>512)return false;routeCounts.set(route.profile,count);}
  if(scheduler.sharedJobs){
    const sharedState=scheduler.sharedJobs;if(!scheduler.priority||Object.keys(sharedState.geometryVersions).some(profile=>!owners.has(profile))||Object.keys(sharedState.registry.serials).some(profile=>!owners.has(profile)))return false;
    const tasks=new Map(scheduler.tasks.map(task=>[task.unitId,task]));
    const registry=new SharedPathJobs(member=>{
      const task=tasks.get(member.request.unitId),request=member.request;
      if(!task||task.stage!=='coarse'||!task.coarse||!task.starts||!task.ends||!task.startComponents||!task.endComponents||task.id!==request.id||task.orderRevision!==request.orderRevision||task.profile!==request.profile||task.radiusMm!==request.radiusMm||task.from.xMm!==request.from.xMm||task.from.zMm!==request.from.zMm||task.target.xMm!==request.target.xMm||task.target.zMm!==request.target.zMm||task.workClass!==request.workClass||task.enqueuedTick!==request.enqueuedTick||request.enqueuedTick===undefined||request.enqueuedTick>s.tick||member.widthMm!==s.widthMm||member.heightMm!==s.heightMm||!Object.hasOwn(sharedState.geometryVersions,request.profile)||member.geometryRevision>sharedState.geometryVersions[request.profile]!||JSON.stringify(task.startComponents)!==JSON.stringify(member.startComponents)||JSON.stringify(task.endComponents)!==JSON.stringify(member.endComponents))return;
      return {profile:task.profile,radiusMm:task.radiusMm,from:task.from,target:task.target,starts:task.starts,ends:task.ends,startComponents:task.startComponents,endComponents:task.endComponents,coarse:task.coarse,...(task.currentComponent!==undefined?{currentComponent:task.currentComponent,edgeCursor:task.edgeCursor!}:{})};
    });
    try{registry.importState(sharedState.registry);}catch{return false;}
  }
  return true;
}
function guard<T>(compiled:ValidateFunction<T>,nodeBudget:number,check?:(value:T)=>boolean):StrictValidator<T>{
  const validator:StrictValidator<T>=Object.assign((value:unknown):value is T=>{if(!isSafeJson(value,0,{remaining:nodeBudget})){validator.errors=[{instancePath:'',schemaPath:'',keyword:'safeJson',params:{},message:'bounded plain save data required'}];return false;}if(!compiled(value)){validator.errors=compiled.errors;return false;}if(check&&!check(value)){validator.errors=[{instancePath:'',schemaPath:'',keyword:'semantic',params:{},message:'save consistency check failed'}];return false;}validator.errors=null;return true;},{errors:null as ErrorObject[]|null|undefined});return validator;
}
// The disk envelope enforces a separate byte cap before parsing. This host-only
// walk allows large region labels; it deliberately does not reuse browser limits.
export const validateSimulationSavePayload=guard(compiledPayload,50000000,semantic);
const validateCommanderShape=guard(compiledCommander,1000000);
export function validateCommanderMemory(value:unknown,playerId:string,tick:number):value is CommanderState{return Number.isSafeInteger(tick)&&tick>=0&&validateCommanderShape(value)&&commanderSemantic(value,playerId,tick);}
export const validateJournalEvent=guard(compiledJournal,1000000,event=>event.kind==='planning_stall_recovery'?unique(event.proposals.map(proposal=>proposal.unitId))&&event.proposals.every(proposal=>proposal.progressTick<=event.tick):event.kind==='commander_patch'?new TextEncoder().encode(JSON.stringify(event.patches)).byteLength<=262144:event.kind==='caretaker_memory'?(!event.memory.scoutRoute||event.memory.scoutRoute.issuedTick<=event.tick)&&constructionSemantic(event.memory,event.tick):!['controller_memory','commander_memory'].includes(event.kind)||commanderSemantic((event as unknown as {memory:CommanderState}).memory,(event as unknown as {playerId:string}).playerId,event.tick));
