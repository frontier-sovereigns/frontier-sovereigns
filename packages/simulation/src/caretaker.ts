import { satisfiesBuilding, developmentContent, nextStructureUpgrade, upgradePrice } from './legendary-ai.js';
import type { ControllerProfiler } from './ai-controller.js';
import { controllerPulse } from './controller-schedule.js';
import { balance, ages, resolveRuleset, wallTypeForMaterial, buildings, units, technologies, terrainBuildable, placementAreaDiscovered, resourcePlacementBounds, terrainLineOfSight, terrainVisionBlockers, type GameplayCommand, type PlayerView, type ViewEntity, type AgeId, type BuildingId, type UnitId, type Position, type ResourceBank, type Difficulty, type TechnologyId, type Cell } from '@frontier/shared';
import { fallbackCommands, type FallbackMemory } from './fallback.js';
import { fortifyPlacementCellLimit } from './fortify-geometry.js';
import { aiBuildingClearanceMm, knownNavigation, pendingBuildingOccupants, type AiDecisionContext } from './ai-exploration.js';

export interface CaretakerMemory extends FallbackMemory {
  nextStrategicTick:number;
  pending:{observedTick:number;executeTick:number;commands:GameplayCommand[]}[];
  seenEnemies:Record<string,{firstSeenTick:number;lastSeenTick:number;typeId:string}>;
  construction?:Record<string,{progress:number;lastProgressTick:number;builders:Record<string,Position&{lastMovedTick:number}>;helperId?:string;retryAtTick?:number;blockedSinceTick?:number}>;
  constructionAvoid?:{typeId:BuildingId;position:Position;rotation:0|90|180|270;untilTick:number}[];
  constructionRecon?:{typeId:BuildingId;origin:Cell;createdTick:number;phase:'survey'|'release';members:{id:string;target:Position;stance:'aggressive'|'defensive'|'stand_ground';lastPosition:Position;lastProgressTick:number;issuedTick?:number}[]};
}
export function emptyCaretakerMemory():CaretakerMemory{return {sequence:0,scoutIndex:0,buildAttempt:0,assignments:{},farmAssignments:{},nextStrategicTick:0,pending:[],seenEnemies:{}};}

/** Autonomous production reserves at least half the match population for combat.
 * Existing villagers and human purchases are never removed or reassigned here. */
export function maxAiWorkers(view:PlayerView):number{return Math.max(6,Math.floor(view.self.populationLimit/2));}

const hz=balance.rules.simulationHz;
export interface RulePolicyOptions {difficulty?:Difficulty;targetWorkers?:number;retreatHpFraction?:number;allowStrategic?:boolean;allowMilitaryProduction?:boolean;desiredUnitType?:UnitId;armyTarget?:number;housingBuffer?:number;workerReserve?:number;scoutAllowed?:boolean;maintainScout?:boolean;attackTargetId?:string;memoryRefreshTicks?:number;reservedWorkerIds?:readonly string[];protectedEntityIds?:ReadonlySet<string>;avoidBuildingCells?:readonly Cell[];resourceWeights?:ResourceBank}
const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const selected=(command:GameplayCommand):string[]=>'unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:'builderId'in command?[command.builderId]:[];
/** Recheck delayed AI recovery against the recipient's current view. A planned
 * site may have activated during reaction delay; never cancel its physical work. */
export function constructionRecoveryCommandValid(view:PlayerView,command:GameplayCommand,protectedIds?:ReadonlySet<string>):boolean {
  return command.kind!=='cancel_foundation'||!protectedIds?.has(command.foundationId)&&view.entities.some(entity=>entity.id===command.foundationId&&entity.kind==='building'&&entity.ownerId===view.playerId&&!entity.ghost&&entity.pendingConstruction&&entity.blockedReason==='PLACEMENT_BLOCKED');
}
/** Retain only our own failed planned footprints for three game minutes. This
 * is disclosed failure memory, never a conclusion about a hidden obstacle. */
export function constructionAvoidCells(view:PlayerView,memory:CaretakerMemory):Cell[]{
  const grid=balance.rules.buildingGridM*1000,result:Cell[]=[];
  for(const entry of (memory.constructionAvoid??[]).slice(-8))if(entry.untilTick>view.tick){let [width,depth]=buildings[entry.typeId].footprintCells;if(entry.rotation===90||entry.rotation===270)[width,depth]=[depth,width];const left=Math.floor(entry.position.xMm/grid-width/2),top=Math.floor(entry.position.zMm/grid-depth/2);for(let z=top;z<top+depth;z++)for(let x=left;x<left+width;x++)result.push({x,z});}
  return result;
}
/** Persist one bounded survey per commander. Visibility is earned by ordinary
 * units outside the proposed footprint; no private spawn or reserved-site data
 * enters planning, and admission retains the full observed clearance halo. */
export function constructionReconnaissance(view:PlayerView,memory:CaretakerMemory,typeId?:BuildingId,anchor?:Position,options:{protectedIds?:ReadonlySet<string>;unavailable?:ReadonlySet<string>;avoidCells?:readonly Cell[];pending?:readonly GameplayCommand[];context?:AiDecisionContext}={}):GameplayCommand[]{
  if(view.rulesetId!=='legendary_ages_v1'||!memory.constructionRecon&&!typeId)return [];
  const own=options.context?.roster(view)?.owned??view.entities.filter(e=>e.ownerId===view.playerId&&!e.ghost),byId=new Map(own.map(e=>[e.id,e])),pending=new Set((options.pending??[]).flatMap(selected)),blocked=(id:string)=>options.protectedIds?.has(id)||options.unavailable?.has(id)||pending.has(id);
  const grid=balance.rules.buildingGridM*1000,cell=view.map.fogCellMm,columns=view.map.widthMm/cell,halo=Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),explored=new Set(view.fog.explored),isDiscovered=(x:number,z:number)=>explored.has(Math.floor(z/cell)*columns+Math.floor(x/cell));
  let record=memory.constructionRecon;
  if(!record&&typeId&&anchor&&Math.max(...buildings[typeId].footprintCells)*grid>=14000){
    const [w,h]=buildings[typeId].footprintCells,width=w*grid,depth=h*grid,eligible=own.filter(e=>e.kind==='unit'&&!e.garrisonedIn&&!e.queuedOrderCount&&!blocked(e.id)&&(e.typeId==='scout'||e.typeId==='villager')&&!(e.cargo?.amount??0)&&['idle','gather',...(e.typeId==='scout'?['move']:[])].includes(e.order??'idle')).sort((a,b)=>units[b.typeId].visionM-units[a.typeId].visionM||distance(a,anchor)-distance(b,anchor)||a.id.localeCompare(b.id)).slice(0,12);
    if(!eligible.length||!eligible.some(e=>units[e.typeId].visionM*1000>Math.min(width,depth)/2+600))return [];
    const navigation=options.context?.navigation(view)??knownNavigation(view),terrain=terrainVisionBlockers(view.map.terrain??[]),avoid=new Set((options.avoidCells??[]).map(c=>`${c.x},${c.z}`));
    // Test at most32 origins per strategic attempt, cycling deterministically
    // across the same bounded625-origin neighborhood used by construction.
    const sites:Position[]=[];for(let z=-24;z<=24;z+=2)for(let x=-24;x<=24;x+=2)sites.push({xMm:(Math.floor(anchor.xMm/grid)+x)*grid,zMm:(Math.floor(anchor.zMm/grid)+z)*grid});sites.sort((a,b)=>distance({xMm:a.xMm+width/2,zMm:a.zMm+depth/2},anchor)-distance({xMm:b.xMm+width/2,zMm:b.zMm+depth/2},anchor));
    const occupied=placementOccupancy([...view.entities,...pendingBuildingOccupants(options.pending??[])],grid,{left:0,top:0,right:view.map.widthMm,bottom:view.map.heightMm},false),offset=(memory.buildAttempt++*32)%sites.length;
    for(let index=0;index<Math.min(32,sites.length);index++){
      const origin=sites[(offset+index)%sites.length]!,left=origin.xMm,top=origin.zMm,right=left+width,bottom=top+depth;
      if(left<halo||top<halo||right+halo>=view.map.widthMm||bottom+halo>=view.map.heightMm||!terrainBuildable(view.map.terrain??[],{...origin,widthMm:width,depthMm:depth})||occupied(left,top,right,bottom))continue;
      let reserved=false;for(let z=top/grid-2;z<bottom/grid+2&&!reserved;z++)for(let x=left/grid-2;x<right/grid+2;x++)if(avoid.has(`${x},${z}`)){reserved=true;break;}if(reserved)continue;
      const cx=(left+right)/2,cz=(top+bottom)/2;if(view.entities.some(e=>e.ownerId&&e.ownerId!==view.playerId&&!e.ghost&&view.players.find(p=>p.id===e.ownerId)?.teamId!==view.players.find(p=>p.id===view.playerId)?.teamId&&distance(e,{xMm:cx,zMm:cz})<24000))continue;
      const samples:Position[]=[];for(let z=Math.floor((top-halo)/cell);z<Math.ceil((bottom+halo)/cell);z++)for(let x=Math.floor((left-halo)/cell);x<Math.ceil((right+halo)/cell);x++)samples.push({xMm:(x+.5)*cell,zMm:(z+.5)*cell});
      const covered=new Set<number>(),members:NonNullable<CaretakerMemory['constructionRecon']>['members']=[],points:Position[]=[];
      // Eight positions on each pair of opposing faces provide worker coverage
      // at corners as well as a scout's wider central view. All remain outside.
      for(const t of [0,.25,.5,.75,1]){points.push({xMm:left-800,zMm:top+(bottom-top)*t},{xMm:right+800,zMm:top+(bottom-top)*t},{xMm:left+(right-left)*t,zMm:top-800},{xMm:left+(right-left)*t,zMm:bottom+800});}
      const coverageByType=new Map<string,{point:Position;cells:number[]}[]>();
      for(const unit of eligible){
        if(members.length>=8)break;const radius=units[unit.typeId].collisionRadiusM*1000,vision=units[unit.typeId].visionM*1000;let best:Position|undefined,bestCells:number[]=[];
        let candidates=coverageByType.get(unit.typeId);if(!candidates){candidates=points.filter(point=>navigation.free(point,radius)).map(point=>({point,cells:samples.flatMap((sample,i)=>distance(point,sample)<=vision-250&&terrainLineOfSight(terrain,point,sample)?[i]:[])}));coverageByType.set(unit.typeId,candidates);}
        for(const candidate of candidates){const {point}=candidate;if(members.some(m=>distance(m.target,point)<1600))continue;const cells=candidate.cells.filter(i=>!covered.has(i));if(cells.length>bestCells.length||cells.length===bestCells.length&&best&&distance(unit,point)<distance(unit,best)){best=point;bestCells=cells;}}
        if(!bestCells.length||!best)continue;for(const i of bestCells)covered.add(i);members.push({id:unit.id,target:best,stance:unit.stance==='aggressive'||unit.stance==='stand_ground'?unit.stance:'defensive',lastPosition:{xMm:unit.xMm,zMm:unit.zMm},lastProgressTick:view.tick});if(covered.size===samples.length)break;
      }
      if(covered.size!==samples.length)continue;
      record=memory.constructionRecon={typeId,origin:{x:left/grid,z:top/grid},createdTick:view.tick,phase:'survey',members};break;
    }
  }
  if(!record)return [];
  const definition=buildings[record.typeId],left=record.origin.x*grid,top=record.origin.z*grid,right=left+definition.footprintCells[0]*grid,bottom=top+definition.footprintCells[1]*grid;
  if(own.some(e=>e.kind==='building'&&e.xMm===(left+right)/2&&e.zMm===(top+bottom)/2)||view.tick-record.createdTick>180*hz||record.members.some(m=>!byId.has(m.id)||options.protectedIds?.has(m.id)))record.phase='release';
  if(record.phase==='release'){
    const commands:GameplayCommand[]=[];record.members=record.members.filter(member=>{const unit=byId.get(member.id);if(!unit||options.protectedIds?.has(member.id)||unit.stance===member.stance)return false;if(!blocked(member.id))commands.push({kind:'set_stance',unitIds:[member.id],stance:member.stance});return true;});if(!record.members.length)delete memory.constructionRecon;return commands;
  }
  // Discovery is persistent: a survey does not need every member to remain in
  // position once the footprint and its clearance have been explored.
  if(placementAreaDiscovered({xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top},view.map.widthMm,view.map.heightMm,cell,halo,isDiscovered,view.map.terrain??[])){
    const occupied=placementOccupancy([...view.entities,...pendingBuildingOccupants(options.pending??[])],grid,{left,top,right,bottom},false);
    if(occupied(left,top,right,bottom)){record.phase='release';return [];}
    const builder=own.find(e=>e.typeId==='villager'&&!e.garrisonedIn&&!e.queuedOrderCount&&!blocked(e.id)&&(!e.order||['idle','gather'].includes(e.order)));
    const bank={...view.self.resources};for(const command of options.pending??[]){const price=cost(command,view);if(price)for(const resource of balance.resourceOrder)bank[resource]-=price[resource];}
    if(builder&&!definition.requiredTechnologies?.some(id=>!view.self.technologies?.includes(id))&&balance.resourceOrder.every(resource=>bank[resource]>=definition.cost[resource])){record.phase='release';return [{kind:'build',buildingType:record.typeId as Extract<GameplayCommand,{kind:'build'}>['buildingType'],builderIds:[builder.id],originCell:{...record.origin},rotation:0,queued:false}];}
    return [];
  }
  const commands:GameplayCommand[]=[];
  for(const member of record.members){const unit=byId.get(member.id)!;if(unit.xMm!==member.lastPosition.xMm||unit.zMm!==member.lastPosition.zMm){member.lastPosition={xMm:unit.xMm,zMm:unit.zMm};member.lastProgressTick=view.tick;}
    if(blocked(member.id))continue;if(unit.stance!=='stand_ground'){commands.push({kind:'set_stance',unitIds:[unit.id],stance:'stand_ground'});continue;}
    if(distance(unit,member.target)<=350)continue;
    if(view.tick-member.lastProgressTick>30*hz){record.phase='release';break;}
    if(unit.order==='move'&&unit.taskState!=='blocked'||member.issuedTick!==undefined&&view.tick-member.issuedTick<10*hz)continue;
    commands.push({kind:'move',unitIds:[unit.id],target:{...member.target},queued:false});member.issuedTick=view.tick;
  }
  return record.phase==='release'?[]:commands;
}
/** Complete prerequisites, not merely a foundation, unlock the next age. Prefer
 * already-paid distinct types when the age permits several alternatives. */
export function missingAgeBuildings(view:PlayerView,context?:AiDecisionContext):BuildingId[]{
  const own=context?.roster(view)?.buildings??view.entities.filter(entity=>entity.ownerId===view.playerId&&entity.kind==='building'&&!entity.ghost),completed=new Set(own.filter(entity=>entity.progress===1).map(entity=>entity.typeId));
  return resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1)?.prerequisites.flatMap(prerequisite=>{
    const missing=prerequisite.types.filter(type=>![...completed].some(actual=>satisfiesBuilding(actual,type)));
    if(prerequisite.kind==='completed_buildings')return missing;
    return missing.sort((a,b)=>Number(own.some(entity=>entity.typeId===b))-Number(own.some(entity=>entity.typeId===a))).slice(0,Math.max(0,prerequisite.count-prerequisite.types.filter(type=>[...completed].some(actual=>satisfiesBuilding(actual,type))).length));
  })??[];
}
/** Include ordinary engineering research and its producers in age priority.
 * Otherwise reserving a citadel's bank can indefinitely prevent buying the
 * university/engineering needed to make that same citadel legal. */
export function ageDependencyRequirements(view:PlayerView,context?:AiDecisionContext):{buildings:Set<BuildingId>;technologies:Set<string>}{
  const result={buildings:new Set<BuildingId>(),technologies:new Set<string>()},own=context?.roster(view)?.buildings??view.entities.filter(e=>e.ownerId===view.playerId&&e.kind==='building'&&!e.ghost),done=new Set(view.self.technologies??[]);
  const visitBuilding=(type:BuildingId):void=>{if(result.buildings.has(type)||own.some(e=>e.progress===1&&satisfiesBuilding(e.typeId,type)))return;result.buildings.add(type);for(const id of buildings[type].requiredTechnologies??[])visitTechnology(id);};
  const visitTechnology=(id:TechnologyId):void=>{if(done.has(id)||result.technologies.has(id))return;result.technologies.add(id);const technology=technologies[id];for(const prior of technology.prerequisites)visitTechnology(prior);visitBuilding(technology.researchedAt);};
  for(const type of missingAgeBuildings(view,context))visitBuilding(type);return result;
}
/** Keep optional purchases from consuming the next age's unpaid construction
 * budget. Already-paid sites and delayed prerequisite purchases need no second
 * reservation. This derives policy costs only from recipient-owned structures. */
export function agePrerequisiteReserve(view:PlayerView,committed:readonly GameplayCommand[]=[],context?:AiDecisionContext):ResourceBank{
  const paid=new Set((context?.roster(view)?.buildings??view.entities.filter(entity=>entity.ownerId===view.playerId&&entity.kind==='building'&&!entity.ghost)).map(entity=>entity.typeId));
  for(const command of committed)if(command.kind==='build')paid.add(command.buildingType);
  const reserve:ResourceBank={food:0,wood:0,gold:0,stone:0};
  for(const type of missingAgeBuildings(view,context))if(!paid.has(type))for(const resource of balance.resourceOrder)reserve[resource]+=buildings[type].cost[resource];
  return reserve;
}
/** Save food toward the actual age price while constructing its prerequisites;
 * reserve the other advancement resources once those dependencies are complete. */
export function ageProgressionReserve(view:PlayerView,committed:readonly GameplayCommand[]=[],context?:AiDecisionContext):ResourceBank{
  const reserve=agePrerequisiteReserve(view,committed,context),own=context?.roster(view)?.owned??view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost);
  const next=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1),ready=!missingAgeBuildings(view,context).length;
  if(next&&own.filter(entity=>entity.typeId==='villager').length>=6&&!own.some(entity=>entity.queue?.some(job=>job.kind==='age'))&&!committed.some(command=>command.kind==='advance_age'))for(const resource of balance.resourceOrder)if(resource==='food'||ready)reserve[resource]+=next.cost[resource];
  return reserve;
}
/** Drop-off expansion is bounded by the workforce that can use it. This is an
 * AI purchasing policy, not a building limit; human commands remain unrestricted. */
export function campExpansionAllowed(view:PlayerView,type:BuildingId,committed:readonly GameplayCommand[]=[],context?:AiDecisionContext):boolean{
  if(type!=='lumber_camp'&&type!=='mining_camp')return true;
  const own=context?.roster(view)?.owned??view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),campCount=own.filter(entity=>entity.typeId==='lumber_camp'||entity.typeId==='mining_camp').length+committed.filter(command=>command.kind==='build'&&(command.buildingType==='lumber_camp'||command.buildingType==='mining_camp')).length;
  // Expansion of one drop-off type must never bar the other type's first
  // research producer. A paid/pending first instance still counts as present.
  if(!own.some(entity=>entity.kind==='building'&&entity.typeId===type)&&!committed.some(command=>command.kind==='build'&&command.buildingType===type))return true;
  return campCount<Math.max(4,Math.ceil(own.filter(entity=>entity.typeId==='villager').length/6));
}
/** Continue a paid, unstaffed site without borrowing a protected/queued worker.
 * Older observations without workTargetId retain conservative global behavior. */
export function unstaffedFoundationCommand(foundation:ViewEntity,workers:ViewEntity[],locked:ReadonlySet<string>,protectedIds?:ReadonlySet<string>):GameplayCommand|undefined {
  if(protectedIds?.has(foundation.id)||foundation.pendingConstruction&&foundation.blockedReason==='PLACEMENT_BLOCKED'||workers.some(worker=>worker.order==='build'&&(!worker.workTargetId||worker.workTargetId===foundation.id)))return;
  const builder=workers.filter(worker=>!locked.has(worker.id)&&!protectedIds?.has(worker.id)&&!worker.garrisonedIn&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)&&['idle','gather'].includes(worker.order??'idle')).sort((a,b)=>distance(a,foundation)-distance(b,foundation)||a.id.localeCompare(b.id))[0];
  if(builder)return {kind:'continue_build',builderIds:[builder.id],foundationId:foundation.id,queued:false};
}
const key=(command:GameplayCommand):string=>command.kind==='train'?`producer:${command.buildingId}`:command.kind==='research'?`research:${command.technologyId}`:command.kind==='advance_age'?'age':command.kind==='build'?`build:${command.buildingType}`:command.kind==='set_auto_reseed'?'auto_reseed':JSON.stringify(command);
function cost(command:GameplayCommand,view?:PlayerView):ResourceBank|undefined {
  if(command.kind==='upgrade_structure'&&view){const result={food:0,wood:0,gold:0,stone:0};for(const id of command.buildingIds){const entity=view.entities.find(entity=>entity.id===id);if(entity){const price=upgradePrice(entity,command.targetTypeId);for(const resource of balance.resourceOrder)result[resource]+=price[resource];}}return result;}
  if(command.kind==='build')return buildings[command.buildingType].cost;
  if(command.kind==='reseed_farm')return buildings.farm.reseedCost;
  if(command.kind==='train')return Object.fromEntries(balance.resourceOrder.map(resource=>[resource,units[command.unitType].cost[resource]*command.quantity])) as ResourceBank;
  if(command.kind==='research')return technologies[command.technologyId].cost;
  if(command.kind==='advance_age')return ages[command.targetAge]?.cost;
  if(command.kind==='tribute'){const price={food:0,wood:0,gold:0,stone:0};price[command.resource]=command.amount+Math.ceil(command.amount*balance.rules.market.tributeFeeFraction);return price;}
  if(command.kind==='build_wall')return Object.fromEntries(balance.resourceOrder.map(resource=>[resource,buildings[wallTypeForMaterial(command.material)].cost[resource]*command.cells.length])) as ResourceBank;
  return undefined;
}
/** Local to one synchronous proposal. Only already-disclosed occupants enter
 * the index; no observation, entity identity, or geometry survives the call. */
function placementOccupancy(entities:readonly ViewEntity[],grid:number,area:{left:number;top:number;right:number;bottom:number},proposedFortification:boolean):(left:number,top:number,right:number,bottom:number)=>boolean {
  interface Occupant {x:number;z:number;halfWidth:number;halfHeight:number;radius?:number;checked:number}
  const bucketMm=8000,columns=Math.floor((area.right-area.left)/bucketMm)+1,buckets=new Map<number,Occupant[]>();
  for(const entity of entities){
    if(entity.ghost&&entity.kind==='unit'||entity.kind==='resource'&&(entity.amount??0)===0||entity.garrisonedIn)continue;
    const radius=entity.kind==='unit'?units[entity.typeId].collisionRadiusM*1000:undefined,size=entity.kind==='building'?buildings[entity.typeId].footprintCells:[1,1],rotated=entity.rotation===90||entity.rotation===270,buildingClearance=entity.kind==='building'&&proposedFortification&&buildings[entity.typeId].wallEquivalentCells?0:aiBuildingClearanceMm;
    const bounds=radius!==undefined?{halfWidth:radius,halfHeight:radius}:entity.kind==='resource'?resourcePlacementBounds(entity,balance.rules.treeBuildingClearanceM*1000):{halfWidth:(rotated?size[1]!:size[0]!)*grid/2+buildingClearance,halfHeight:(rotated?size[0]!:size[1]!)*grid/2+buildingClearance};
    const occupant:Occupant={x:entity.xMm,z:entity.zMm,...bounds,...(radius!==undefined?{radius}:{}),checked:0};
    const left=Math.max(area.left,occupant.x-bounds.halfWidth),right=Math.min(area.right,occupant.x+bounds.halfWidth),top=Math.max(area.top,occupant.z-bounds.halfHeight),bottom=Math.min(area.bottom,occupant.z+bounds.halfHeight);
    if(left>right||top>bottom)continue;
    for(let z=Math.floor((top-area.top)/bucketMm);z<=Math.floor((bottom-area.top)/bucketMm);z++)for(let x=Math.floor((left-area.left)/bucketMm);x<=Math.floor((right-area.left)/bucketMm);x++){
      const key=z*columns+x,bucket=buckets.get(key);if(bucket)bucket.push(occupant);else buckets.set(key,[occupant]);
    }
  }
  let query=0;
  return (left,top,right,bottom)=>{
    query++;
    for(let z=Math.floor((top-area.top)/bucketMm);z<=Math.floor((bottom-area.top)/bucketMm);z++)for(let x=Math.floor((left-area.left)/bucketMm);x<=Math.floor((right-area.left)/bucketMm);x++)for(const occupant of buckets.get(z*columns+x)??[]){
      if(occupant.checked===query)continue;occupant.checked=query;
      if(occupant.radius!==undefined){const dx=Math.max(left-occupant.x,0,occupant.x-right),dz=Math.max(top-occupant.z,0,occupant.z-bottom);if(dx*dx+dz*dz<occupant.radius*occupant.radius)return true;}
      else if(occupant.x+occupant.halfWidth>left&&occupant.x-occupant.halfWidth<right&&occupant.z+occupant.halfHeight>top&&occupant.z-occupant.halfHeight<bottom)return true;
    }
    return false;
  };
}
/** An explored, remembered-unoccupied site proposal. Admission proves reachability. */
export function buildingCommand(view:PlayerView,typeId:BuildingId,anchor:Position,workers:ViewEntity[],candidateIndex=0,avoidBuildingCells:readonly Cell[]=[],pendingCommands:readonly GameplayCommand[]=[]):GameplayCommand|undefined {
  if(!workers.length||buildings[typeId].minAge>view.self.age)return;
  if(!buildings[typeId].wallEquivalentCells&&view.entities.filter(entity=>entity.ownerId===view.playerId&&entity.kind==='building'&&!buildings[entity.typeId].wallEquivalentCells).length>=balance.rules.maxNonWallBuildingsPerPlayer)return;
  const definition=buildings[typeId],grid=balance.rules.buildingGridM*1000,[width,depth]=definition.footprintCells,explored=new Set(view.fog.explored),fogWidth=view.map.widthMm/view.map.fogCellMm;
  const candidates:Position[]=[];
  for(let z=-10;z<=10;z+=2)for(let x=-10;x<=10;x+=2)candidates.push({xMm:(Math.floor(anchor.xMm/grid)+x)*grid,zMm:(Math.floor(anchor.zMm/grid)+z)*grid});
  candidates.sort((a,b)=>distance(a,anchor)-distance(b,anchor));
  // Preserve the original121-site preference, then expand through nearby explored
  // land. A crowded village must not permanently exclude larger prerequisites.
  // The complete search is bounded to625 origins; admission still proves access.
  function* sites():Generator<Position>{
    yield* candidates;
    const outer:Position[]=[];
    for(let z=-24;z<=24;z+=2)for(let x=-24;x<=24;x+=2)if(Math.abs(x)>10||Math.abs(z)>10)outer.push({xMm:(Math.floor(anchor.xMm/grid)+x)*grid,zMm:(Math.floor(anchor.zMm/grid)+z)*grid});
    outer.sort((a,b)=>distance(a,anchor)-distance(b,anchor));yield* outer;
  }
  const avoid=avoidBuildingCells.slice(0,fortifyPlacementCellLimit*balance.ai.maxGoals),reserved=new Set(avoid.map(cell=>`${cell.x},${cell.z}`)),streetCells=definition.wallEquivalentCells?0:aiBuildingClearanceMm/grid,offset=candidateIndex%32;
  const proposal=(point:Position|undefined):GameplayCommand|undefined=>{if(!point)return;const worker=[...workers].sort((a,b)=>distance(a,point)-distance(b,point))[0]!;return {kind:'build',buildingType:typeId as Extract<GameplayCommand,{kind:'build'}>['buildingType'],builderIds:[worker.id],originCell:{x:point.xMm/grid,z:point.zMm/grid},rotation:0,queued:false};};
  let occupied:ReturnType<typeof placementOccupancy>|undefined;
  const legalSites:Position[]=[];for(const point of sites()){
    const right=point.xMm+width*grid,bottom=point.zMm+depth*grid;if(point.xMm<0||point.zMm<0||right>view.map.widthMm||bottom>view.map.heightMm)continue;
    if(!terrainBuildable(view.map.terrain??[],{...point,widthMm:width*grid,depthMm:depth*grid}))continue;
    if(!placementAreaDiscovered({...point,widthMm:width*grid,depthMm:depth*grid},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),(x,z)=>explored.has(Math.floor(z/view.map.fogCellMm)*fogWidth+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]))continue;
    // Build once, lazily after terrain/fog eligibility. Clip the index to this
    // same625-origin search area; neither sites nor obstacle footprints change.
    occupied??=placementOccupancy(pendingCommands.length?[...view.entities,...pendingBuildingOccupants(pendingCommands)]:view.entities,grid,{left:(Math.floor(anchor.xMm/grid)-24)*grid,top:(Math.floor(anchor.zMm/grid)-24)*grid,right:(Math.floor(anchor.xMm/grid)+24+width)*grid,bottom:(Math.floor(anchor.zMm/grid)+24+depth)*grid},Boolean(definition.wallEquivalentCells));
    if(occupied(point.xMm,point.zMm,right,bottom))continue;
    // Future walls need the same street as walls already present. Keeping just
    // their occupied cells free would prevent the paid layout from finishing.
    let reservedSite=false;for(let z=point.zMm/grid-streetCells;z<bottom/grid+streetCells&&!reservedSite;z++)for(let x=point.xMm/grid-streetCells;x<right/grid+streetCells;x++)if(reserved.has(`${x},${z}`)){reservedSite=true;break;}if(reservedSite)continue;
    legalSites.push(point);if(legalSites.length<=offset)continue;return proposal(point);
  }
  // Only at most32 legal sites are retained. Wrap an exhausted retry offset
  // through the available choices rather than discarding a safe explored site.
  // Reserved approaches never enter this list, even when the village is crowded.
  return proposal(legalSites.length?legalSites[offset%legalSites.length]:undefined);
}

/** Conquest does not defeat a faction merely because its Town Center is lost.
 * Rebuild through paid ordinary admission, including one autonomous carrier
 * when every worker has cargo and no drop-off remains. Building retains cargo. */
export function baseRecoveryCommand(view:PlayerView,workers:ViewEntity[],locked:ReadonlySet<string>,protectedIds?:ReadonlySet<string>,avoidCells:readonly Cell[]=[]):GameplayCommand|undefined {
  const own=view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),structures=own.filter(entity=>entity.kind==='building');
  if(structures.some(entity=>entity.typeId==='town_center'&&entity.progress===1))return;
  const eligible=workers.filter(worker=>!locked.has(worker.id)&&!protectedIds?.has(worker.id)&&!worker.garrisonedIn&&!worker.queuedOrderCount&&['idle','gather'].includes(worker.order??'idle')).sort((a,b)=>Number(Boolean(a.cargo?.amount))-Number(Boolean(b.cargo?.amount))||a.id.localeCompare(b.id));
  const paid=structures.find(entity=>entity.typeId==='town_center'&&(entity.progress??1)<1)??structures.find(entity=>(entity.progress??1)<1&&workers.some(worker=>worker.cargo?.resource&&(worker.cargo.amount??0)>0&&buildings[entity.typeId].dropOffResources.includes(worker.cargo.resource)));
  if(paid){if(protectedIds?.has(paid.id)||paid.pendingConstruction&&paid.blockedReason==='PLACEMENT_BLOCKED'||workers.some(worker=>worker.order==='build'&&(!worker.workTargetId||worker.workTargetId===paid.id)))return;const worker=eligible.sort((a,b)=>distance(a,paid)-distance(b,paid)||a.id.localeCompare(b.id))[0];return worker?{kind:'continue_build',builderIds:[worker.id],foundationId:paid.id,queued:false}:undefined;}
  if(!eligible.length)return;
  const anchor=structures.find(entity=>entity.progress===1&&!protectedIds?.has(entity.id))??eligible[0]!;
  const affordable=(type:BuildingId)=>buildings[type].minAge<=view.self.age&&balance.resourceOrder.every(resource=>view.self.resources[resource]>=buildings[type].cost[resource]);
  if(affordable('town_center')){const home=buildingCommand(view,'town_center',anchor,eligible,0,avoidCells);if(home)return home;}
  const cargo=eligible.find(worker=>(worker.cargo?.amount??0)>0)?.cargo?.resource,type:BuildingId=cargo==='wood'?'lumber_camp':cargo==='food'?'mill':'mining_camp';
  if(cargo&&!structures.some(entity=>buildings[entity.typeId].dropOffResources.includes(cargo))&&affordable(type))return buildingCommand(view,type,anchor,eligible,0,avoidCells);
}

/** Synchronous ordinary engine observation only; returned commands own nested data. */
function caretakerObservation(view:PlayerView,difficulty:Difficulty,reservedCommands:GameplayCommand[],locked:Set<string>):PlayerView {
  const sourceFaction=view.players.find(player=>player.id===view.playerId)!,faction=sourceFaction.difficulty===difficulty?sourceFaction:{...sourceFaction,difficulty};
  const observation:PlayerView={...view,players:faction===sourceFaction?view.players:view.players.map(player=>player===sourceFaction?faction:player)};
  // Source identity preserves repeated references and distinct records with equal IDs.
  const changed=new Map<ViewEntity,ViewEntity>(),writable=(entity:ViewEntity):ViewEntity=>{let copy=changed.get(entity);if(!copy){copy={...entity};changed.set(entity,copy);}return copy;};
  for(const entity of view.entities)if(entity.ownerId===view.playerId&&locked.has(entity.id)){const command=reservedCommands.find(command=>selected(command).includes(entity.id));if(command){const order=command.kind==='gather'?'gather':command.kind==='build'||command.kind==='continue_build'?'build':command.kind==='reseed_farm'?'reseed':'move';if(entity.order!==order)writable(entity).order=order;}}
  for(const command of reservedCommands)if(command.kind==='gather'||command.kind==='reseed_farm'){const farmId=command.kind==='gather'?command.targetId:command.farmId,farm=view.entities.find(entity=>entity.id===farmId&&entity.typeId==='farm');if(farm&&farm.farmerAssigned!==true)writable(farm).farmerAssigned=true;}
  if(changed.size)observation.entities=view.entities.map(entity=>changed.get(entity)??entity);
  return observation;
}

/** Medium rule policy consumes only a recipient-filtered observation; it has no model or world handle. */
export function caretakerCommands(view:PlayerView,memory:CaretakerMemory,options:RulePolicyOptions={},profiler?:ControllerProfiler,context?:AiDecisionContext):GameplayCommand[] {
  const difficulty=options.difficulty??'medium',policy=balance.ai.difficulty[difficulty];
  const due=memory.pending.filter(batch=>batch.executeTick<=view.tick).flatMap(batch=>batch.commands).filter(command=>constructionRecoveryCommandValid(view,command,options.protectedEntityIds));memory.pending=memory.pending.filter(batch=>batch.executeTick>view.tick);
  if(!controllerPulse(view,policy.tacticalIntervalSeconds*hz))return due;
  if(memory.constructionAvoid){memory.constructionAvoid=memory.constructionAvoid.filter(entry=>entry.untilTick>view.tick).slice(-8);if(!memory.constructionAvoid.length)delete memory.constructionAvoid;}
  const avoid=constructionAvoidCells(view,memory);if(avoid.length)options={...options,avoidBuildingCells:[...(options.avoidBuildingCells??[]),...avoid]};
  const pending=memory.pending.flatMap(batch=>batch.commands),reservedCommands=[...due,...pending],locked=new Set([...reservedCommands.flatMap(selected),...(options.reservedWorkerIds??[])]),keys=new Set(reservedCommands.map(key)),bank={...view.self.resources},planned:GameplayCommand[]=[];
  for(const command of pending){const price=cost(command,view);if(price)for(const resource of balance.resourceOrder)bank[resource]-=price[resource];}
  // This existing private diagnostic label now measures borrowed observation
  // preparation, not a deep clone. No diagnostic clock is read when disabled.
  const observation=profiler?profiler.measure('caretakerClone',()=>caretakerObservation(view,difficulty,reservedCommands,locked)):caretakerObservation(view,difficulty,reservedCommands,locked),faction=observation.players.find(player=>player.id===view.playerId)!;
  context?.inherit(view,observation);const roster=context?.roster(observation);
  const own=roster?.owned??observation.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),home=own.find(entity=>entity.typeId==='town_center'&&entity.progress===1),workers=roster?.workers??own.filter(entity=>entity.typeId==='villager'&&!entity.garrisonedIn),complete=roster?.complete??own.filter(entity=>entity.kind==='building'&&entity.progress===1),army=roster?.army??own.filter(entity=>entity.kind==='unit'&&!['villager','scout'].includes(entity.typeId)&&!entity.garrisonedIn);
  if(!home){
    const site=own.find(entity=>entity.typeId==='town_center'&&(entity.progress??1)<1)??own.find(entity=>entity.kind==='building'&&(entity.progress??1)<1&&workers.some(worker=>worker.cargo?.resource&&(worker.cargo.amount??0)>0&&buildings[entity.typeId].dropOffResources.includes(worker.cargo.resource))),records=memory.construction??(memory.construction={});
    const active=new Set(own.filter(entity=>entity.kind==='building'&&((entity.progress??1)<1||entity.upgrade)).map(entity=>entity.id));for(const id of Object.keys(records))if(!active.has(id))delete records[id];
    if(site){
      const record=records[site.id]??(records[site.id]={progress:site.progress??0,lastProgressTick:view.tick,builders:{}}),delay=policy.strategicIntervalSeconds*hz;
      if(record.progress!==(site.progress??0)){record.progress=site.progress??0;record.lastProgressTick=view.tick;}
      if(site.pendingConstruction&&site.blockedReason==='PLACEMENT_BLOCKED')record.blockedSinceTick??=view.tick;else delete record.blockedSinceTick;
      const assigned=workers.filter(worker=>worker.order==='build'&&(!worker.workTargetId||worker.workTargetId===site.id));
      const assignedIds=new Set(assigned.map(worker=>worker.id));for(const id of Object.keys(record.builders))if(!assignedIds.has(id))delete record.builders[id];
      for(const worker of assigned){const prior=record.builders[worker.id];if(!prior||prior.xMm!==worker.xMm||prior.zMm!==worker.zMm)record.builders[worker.id]={xMm:worker.xMm,zMm:worker.zMm,lastMovedTick:view.tick};}
      if(record.blockedSinceTick!==undefined&&view.tick-record.blockedSinceTick>=Math.max(60*hz,policy.strategicIntervalSeconds*hz*3)&&!options.protectedEntityIds?.has(site.id)&&!assigned.some(worker=>options.protectedEntityIds?.has(worker.id)||locked.has(worker.id)||worker.queuedOrderCount)&&assigned.every(worker=>worker.blockedReason==='PLACEMENT_BLOCKED'||view.tick-record.builders[worker.id]!.lastMovedTick>=delay)&&!reservedCommands.some(command=>command.kind==='cancel_foundation'&&command.foundationId===site.id)){
        memory.pending.push({observedTick:view.tick,executeTick:view.tick+Math.ceil(policy.reactionDelaySeconds*hz),commands:[{kind:'cancel_foundation',foundationId:site.id}]});
        memory.constructionAvoid=[...(memory.constructionAvoid??[]),{typeId:site.typeId as BuildingId,position:{xMm:site.xMm,zMm:site.zMm},rotation:site.rotation??0,untilTick:view.tick+180*hz}].slice(-8);return due;
      }
      const stalled=assigned.length>0&&assigned.every(worker=>worker.blockedReason==='PATH_BLOCKED'||view.tick-record.lastProgressTick>=delay&&view.tick-record.builders[worker.id]!.lastMovedTick>=delay),builder=assigned.find(worker=>!locked.has(worker.id)&&!options.protectedEntityIds?.has(worker.id)&&!worker.queuedOrderCount);
      if(stalled&&builder&&!options.protectedEntityIds?.has(site.id)&&view.tick>=(record.retryAtTick??0)&&!reservedCommands.some(command=>command.kind==='continue_build'&&command.foundationId===site.id)){
        memory.pending.push({observedTick:view.tick,executeTick:view.tick+Math.ceil(policy.reactionDelaySeconds*hz),commands:[{kind:'continue_build',foundationId:site.id,builderIds:[builder.id],queued:false}]});record.retryAtTick=view.tick+delay;return due;
      }
    }
    if(!reservedCommands.some(command=>command.kind==='build'||command.kind==='continue_build')){const recoveryView={...observation,self:{...observation.self,resources:bank}},action=baseRecoveryCommand(recoveryView,workers,locked,options.protectedEntityIds,options.avoidBuildingCells);if(action)memory.pending.push({observedTick:view.tick,executeTick:view.tick+Math.ceil(policy.reactionDelaySeconds*hz),commands:[action]});}
    return due;
  }
  const missing=missingAgeBuildings(observation,context),foundations=own.filter(entity=>entity.kind==='building'&&((entity.progress??1)<1||entity.upgrade));
  const emergencyHousing=view.self.populationCap<view.self.populationLimit&&view.self.population+view.self.reservedPopulation>=view.self.populationCap&&!foundations.some(entity=>buildings[entity.typeId].populationProvided>0);
  const nextAgeFood=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1)?.cost.food??0;
  const foodSupply=observation.entities.some(entity=>!entity.ghost&&entity.resource==='food'&&(entity.amount??0)>0&&(entity.kind==='resource'&&distance(entity,home)<=32000||entity.ownerId===view.playerId&&entity.progress===1));
  const emergencyFood=bank.food<Math.max(units.villager.cost.food*2,nextAgeFood)&&!foodSupply&&!foundations.some(entity=>entity.typeId==='farm');
  const dependencies=ageDependencyRequirements(observation,context),priorityResearch=dependencies.technologies;
  const priorityBuilds=new Set<BuildingId>([...dependencies.buildings,...(emergencyHousing?['house' as const]:[]),...(emergencyFood?['farm' as const]:[])]);
  const ageReserve=options.allowStrategic===false?agePrerequisiteReserve(observation,reservedCommands,context):ageProgressionReserve(observation,reservedCommands,context);
  const threatened=observation.entities.some(enemy=>enemy.kind==='unit'&&!enemy.ghost&&enemy.ownerId&&observation.players.find(player=>player.id===enemy.ownerId)?.teamId!==faction.teamId&&distance(enemy,home)<25000);
  const add=(command:GameplayCommand|undefined):boolean=>{
    if(command&&options.protectedEntityIds){if('unitIds'in command){const ids=command.unitIds.filter(id=>!options.protectedEntityIds!.has(id));if(!ids.length)return false;command={...command,unitIds:ids};}else if('builderIds'in command){const ids=command.builderIds.filter(id=>!options.protectedEntityIds!.has(id));if(!ids.length)return false;command={...command,builderIds:ids};}else if('buildingId'in command&&options.protectedEntityIds.has(command.buildingId)||'townCenterId'in command&&options.protectedEntityIds.has(command.townCenterId))return false;}
    if(!command||planned.length>=200||keys.has(key(command))||selected(command).some(id=>locked.has(id)))return false;
    if((command.kind==='continue_build'||command.kind==='cancel_foundation')&&options.protectedEntityIds?.has(command.foundationId))return false;
    if(command.kind==='upgrade_structure'&&command.buildingIds.some(id=>options.protectedEntityIds?.has(id)))return false;
    if(command.kind==='build'&&([...due,...pending,...planned].some(item=>item.kind==='build'||item.kind==='build_wall')||foundations.some(entity=>entity.typeId===command.buildingType)||foundations.length&&!priorityBuilds.has(command.buildingType)))return false;
    if(command.kind==='build'&&!missing.includes(command.buildingType)&&!campExpansionAllowed(observation,command.buildingType,[...reservedCommands,...planned],context))return false;
    const price=cost(command,view),priority=command.kind==='reseed_farm'||command.kind==='research'&&priorityResearch.has(command.technologyId)||command.kind==='upgrade_structure'&&missing.some(type=>satisfiesBuilding(type,command.targetTypeId))||command.kind==='advance_age'||command.kind==='train'&&(command.unitType==='villager'?workers.length<6:threatened&&army.length<4&&command.quantity===1)||command.kind==='build'&&priorityBuilds.has(command.buildingType);
    // A wood reserve cannot block food-only workforce recovery. Reserve only
    // resources this purchase spends; ordinary affordability still applies.
    if(price&&balance.resourceOrder.some(resource=>bank[resource]<price[resource]||price[resource]>0&&!priority&&bank[resource]-price[resource]<ageReserve[resource]))return false;
    if(price)for(const resource of balance.resourceOrder){bank[resource]-=price[resource];if(command.kind==='build'&&missing.includes(command.buildingType))ageReserve[resource]=Math.max(0,ageReserve[resource]-price[resource]);}keys.add(key(command));for(const id of selected(command))locked.add(id);planned.push(command);return true;
  };
  for(const command of constructionReconnaissance(observation,memory,undefined,undefined,{protectedIds:options.protectedEntityIds,unavailable:new Set(options.reservedWorkerIds??[]),pending:reservedCommands,context}))add(command);
  for(const member of memory.constructionRecon?.members??[])locked.add(member.id);
  // Observe ordinary owned work only. A moving order is not evidence of motion:
  // persist position/progress checks so an indefinitely queued route can recover.
  // One helper per site is retained; subsequent retries replan that helper rather
  // than draining the economy or cancelling/refunding a paid foundation.
  if(foundations.length||memory.construction){
    const records=memory.construction??(memory.construction={}),active=new Set(foundations.map(site=>site.id)),delay=policy.strategicIntervalSeconds*hz;
    const bySite=new Map<string,ViewEntity[]>(),unspecified:ViewEntity[]=[];
    for(const worker of workers)if(worker.order==='build'){if(!worker.workTargetId)unspecified.push(worker);else{const group=bySite.get(worker.workTargetId)??[];group.push(worker);bySite.set(worker.workTargetId,group);}}
    for(const id of Object.keys(records))if(!active.has(id))delete records[id];
    let recovering=false;
    for(const site of [...foundations].sort((a,b)=>Number(missing.includes(b.typeId as BuildingId))-Number(missing.includes(a.typeId as BuildingId))||distance(a,home)-distance(b,home)||a.id.localeCompare(b.id))){
      const record=records[site.id]??(records[site.id]={progress:site.upgrade?.progress??site.progress??0,lastProgressTick:view.tick,builders:{}});
      if(site.pendingConstruction&&site.blockedReason==='PLACEMENT_BLOCKED')record.blockedSinceTick??=view.tick;else delete record.blockedSinceTick;
      if(record.progress!==(site.upgrade?.progress??site.progress??0)){record.progress=site.upgrade?.progress??site.progress??0;record.lastProgressTick=view.tick;}
      const assigned=foundations.length===1?[...(bySite.get(site.id)??[]),...unspecified]:bySite.get(site.id)??[],ids=new Set(assigned.map(worker=>worker.id));
      for(const id of Object.keys(record.builders))if(!ids.has(id))delete record.builders[id];
      for(const worker of assigned){const prior=record.builders[worker.id];if(!prior||prior.xMm!==worker.xMm||prior.zMm!==worker.zMm)record.builders[worker.id]={xMm:worker.xMm,zMm:worker.zMm,lastMovedTick:view.tick};}
      const reserved=reservedCommands.some(command=>command.kind==='continue_build'&&command.foundationId===site.id);
      if(record.helperId&&!ids.has(record.helperId)&&!reserved)delete record.helperId;
      if(recovering||reserved||view.tick<(record.retryAtTick??0)||options.protectedEntityIds?.has(site.id)||assigned.some(worker=>options.protectedEntityIds?.has(worker.id))||foundations.length>1&&unspecified.length)continue;
      // Repeated blocked placement is not a path failure. After a conservative
      // recovery window, cancel only the unpaid-work blueprint. The authoritative
      // cancel rule refunds its original price once; actual foundations survive.
      if(record.blockedSinceTick!==undefined&&view.tick-record.blockedSinceTick>=Math.max(60*hz,delay*3)&&!assigned.some(worker=>locked.has(worker.id)||worker.queuedOrderCount)&&assigned.every(worker=>worker.blockedReason==='PLACEMENT_BLOCKED'||view.tick-record.builders[worker.id]!.lastMovedTick>=delay)){
        if(add({kind:'cancel_foundation',foundationId:site.id})){memory.constructionAvoid=[...(memory.constructionAvoid??[]),{typeId:site.typeId as BuildingId,position:{xMm:site.xMm,zMm:site.zMm},rotation:site.rotation??0,untilTick:view.tick+180*hz}].slice(-8);record.retryAtTick=view.tick+delay;recovering=true;}continue;
      }
      const stalled=assigned.length>0&&assigned.every(worker=>worker.taskState==='blocked'&&worker.blockedReason==='PATH_BLOCKED')||assigned.length>0&&view.tick-record.lastProgressTick>=delay&&assigned.every(worker=>view.tick-record.builders[worker.id]!.lastMovedTick>=delay);
      if(!stalled&&assigned.length)continue;
      let action:GameplayCommand|undefined;
      if(record.helperId){const helper=assigned.find(worker=>worker.id===record.helperId&&!locked.has(worker.id)&&!worker.queuedOrderCount);if(helper)action={kind:'continue_build',builderIds:[helper.id],foundationId:site.id,queued:false};}
      else{
        const helper=workers.filter(worker=>!locked.has(worker.id)&&!options.protectedEntityIds?.has(worker.id)&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)&&['idle','gather'].includes(worker.order??'idle')).sort((a,b)=>distance(a,site)-distance(b,site)||a.id.localeCompare(b.id))[0];
        // If the economy has no spare worker, retry an existing stalled builder.
        // Keep one identity/site and the same cooldown; never seize queued/cargo
        // or protected work, or multiply helpers on each failed route.
        const retry=helper??assigned.filter(worker=>!locked.has(worker.id)&&!options.protectedEntityIds?.has(worker.id)&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)).sort((a,b)=>distance(a,site)-distance(b,site)||a.id.localeCompare(b.id))[0];
        if(retry)action={kind:'continue_build',builderIds:[retry.id],foundationId:site.id,queued:false};
      }
      if(action&&add(action)){record.helperId=(action as Extract<GameplayCommand,{kind:'continue_build'}>).builderIds[0];record.retryAtTick=view.tick+delay;recovering=true;}
    }
  }
  const enemies=roster?.enemies??observation.entities.filter(entity=>entity.ownerId&&entity.ownerId!==view.playerId&&!entity.ghost&&observation.players.find(player=>player.id===entity.ownerId)?.teamId!==faction.teamId);
  for(const enemy of enemies.filter(enemy=>enemy.kind==='unit').sort((a,b)=>distance(a,home)-distance(b,home)||a.id.localeCompare(b.id)).slice(0,512)){const prior=memory.seenEnemies[enemy.id];if(!prior||view.tick-prior.lastSeenTick>=(options.memoryRefreshTicks??0))memory.seenEnemies[enemy.id]={firstSeenTick:prior?.firstSeenTick??view.tick,lastSeenTick:view.tick,typeId:enemy.typeId};}
  for(const [id,seen]of Object.entries(memory.seenEnemies))if(view.tick-seen.lastSeenTick>90*hz)delete memory.seenEnemies[id];
  for(const [id]of Object.entries(memory.seenEnemies).sort(([a,x],[b,y])=>y.lastSeenTick-x.lastSeenTick||a.localeCompare(b)).slice(512))delete memory.seenEnemies[id];
  // Retreat is a group decision; ordinary movement keeps priority over automatic acquisition.
  if(army.length&&enemies.some(enemy=>army.some(unit=>distance(unit,enemy)<18000))&&army.reduce((sum,unit)=>sum+unit.hp,0)<(options.retreatHpFraction??.55)*army.reduce((sum,unit)=>sum+unit.maxHp,0)&&army.some(unit=>unit.order!=='move')){
    const target={xMm:Math.max(1000,Math.min(view.map.widthMm-1000,home.xMm+12000)),zMm:home.zMm};add({kind:'move',unitIds:army.map(unit=>unit.id),target,queued:false});
  }else{
    const threats=enemies.filter(enemy=>distance(enemy,home)<25000||workers.some(worker=>distance(enemy,worker)<12000)),idle=army.filter(unit=>unit.order==='idle'||unit.taskState==='blocked');
    const eligible=threats.length?threats:view.tick>=policy.initialBaseAssaultNotBeforeSeconds*hz?enemies.filter(enemy=>!observation.players.find(player=>player.id===enemy.ownerId)?.defeated):[];
    const objectiveRank=(enemy:ViewEntity)=>enemy.typeId==='town_center'?0:enemy.typeId==='villager'?1:enemy.kind==='unit'?2:buildings[enemy.typeId]?.produces.length?3:4;
    const target=eligible.find(enemy=>enemy.id===options.attackTargetId)??[...eligible].sort((a,b)=>(threats.length?0:objectiveRank(a)-objectiveRank(b))||distance(a,home)-distance(b,home))[0];
    const prepared=threats.length||target?.typeId!=='town_center'||army.filter(unit=>!units[unit.typeId].tags.includes('siege')).length>=4;
    if(target&&idle.length&&prepared)add({kind:'attack_target',unitIds:idle.map(unit=>unit.id),targetId:target.id,queued:false});
  }
  const jobs=complete.flatMap(building=>building.queue??[]),queuedWorkers=jobs.filter(job=>job.kind==='train'&&job.typeId==='villager').length+pending.filter(command=>command.kind==='train'&&command.unitType==='villager').length;
  // Reserve an affordable age before new workers, military or optional research
  // consume its exact bank. Already-paid villagers remain ahead in the queue.
  if(options.allowStrategic!==false&&view.tick>=memory.nextStrategicTick){
    const nextAge=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1),proposedJobs=[...due,...pending,...planned],homeJobs=(home.queue?.length??0)+proposedJobs.reduce((count,command)=>count+(command.kind==='train'&&command.buildingId===home.id?command.quantity:(command.kind==='research'&&command.buildingId===home.id||command.kind==='advance_age'&&command.townCenterId===home.id)?1:0),0),dueSpend={food:0,wood:0,gold:0,stone:0};
    for(const command of due){const price=cost(command,view);if(price)for(const resource of balance.resourceOrder)dueSpend[resource]+=price[resource];}
    if(nextAge&&!missing.length&&!jobs.some(job=>job.kind==='age')&&!proposedJobs.some(command=>command.kind==='advance_age')&&homeJobs<balance.rules.queueWaitingLimit+1&&balance.resourceOrder.every(resource=>bank[resource]-dueSpend[resource]>=nextAge.cost[resource]))add({kind:'advance_age',townCenterId:home.id,targetAge:nextAge.id as Exclude<AgeId,1>});
  }
  if(workers.length+queuedWorkers<Math.min(options.targetWorkers??20,maxAiWorkers(view))&&(home.queue?.length??0)===0&&view.self.population+view.self.reservedPopulation<view.self.populationCap)add({kind:'train',buildingId:home.id,unitType:'villager',quantity:1});
  const observed=Object.values(memory.seenEnemies),cavalry=observed.filter(enemy=>units[enemy.typeId]?.tags.includes('cavalry')).length,ranged=observed.filter(enemy=>units[enemy.typeId]?.tags.includes('ranged')).length;
  const desired:UnitId=options.desiredUnitType??(cavalry>ranged?'spearman':ranged>0&&view.self.age>=2?'skirmisher':view.self.age>=2?'archer':'militia');
  const producer=complete.find(building=>building.typeId===units[desired].producedAt&&(building.queue?.length??0)===0);
  if(options.allowMilitaryProduction!==false&&producer&&army.length<(options.armyTarget??Math.max(4,workers.length))&&view.self.population+view.self.reservedPopulation<view.self.populationCap&&(units[desired].cost.food===0||bank.food>=units[desired].cost.food+units.villager.cost.food*(options.workerReserve??1)))add({kind:'train',buildingId:producer.id,unitType:desired,quantity:1});
  if(options.allowStrategic!==false&&view.tick>=memory.nextStrategicTick){
    memory.nextStrategicTick=view.tick+policy.strategicIntervalSeconds*hz;
    // A paid unit awaiting its exit does not need more queued replacements.
    // Clear at most one owned idle blocker through visible legal space. Static
    // obstructions remain a reported production block; never demolish a site.
    const blocked=complete.find(building=>!options.protectedEntityIds?.has(building.id)&&building.queue?.some(job=>job.state==='exit_blocked'));
    if(blocked){
      const blocker=own.filter(entity=>entity.kind==='unit'&&!locked.has(entity.id)&&!options.protectedEntityIds?.has(entity.id)&&!entity.garrisonedIn&&!entity.queuedOrderCount&&!(entity.cargo?.amount??0)&&entity.order==='idle'&&distance(entity,blocked)<Math.max(...buildings[blocked.typeId].footprintCells)*1000+4000).sort((a,b)=>distance(a,blocked)-distance(b,blocked)||a.id.localeCompare(b.id))[0];
      if(blocker){
        const navigation=context?.navigation(observation)??knownNavigation(observation),radius=units[blocker.typeId].collisionRadiusM*1000,visible=new Set(view.fog.visible),width=view.map.widthMm/view.map.fogCellMm;
        const candidates=[[1,0],[0,1],[-1,0],[0,-1],[1,1],[-1,1],[-1,-1],[1,-1]].map(([x,z])=>({xMm:blocker.xMm+x!*6000,zMm:blocker.zMm+z!*6000})).sort((a,b)=>distance(b,blocked)-distance(a,blocked));
        const target=candidates.find(point=>visible.has(Math.floor(point.zMm/view.map.fogCellMm)*width+Math.floor(point.xMm/view.map.fogCellMm))&&navigation.free(point,radius)&&navigation.clearLine(blocker,point,radius)&&!observation.entities.some(entity=>entity.kind==='unit'&&!entity.ghost&&!entity.garrisonedIn&&entity.id!==blocker.id&&distance(entity,point)<radius+units[entity.typeId].collisionRadiusM*1000));
        if(target)add({kind:'move',unitIds:[blocker.id],target,queued:false});
      }
    }
    const free=workers.filter(worker=>!locked.has(worker.id)&&!options.protectedEntityIds?.has(worker.id)&&!worker.queuedOrderCount&&!['build','reseed'].includes(worker.order??'')),knownResources=roster?.resources??observation.entities.filter(entity=>entity.kind==='resource'&&!entity.ghost&&(entity.amount??0)>0);
    const completed=new Set(complete.map(building=>building.typeId));
    let essential=emergencyHousing?'house':emergencyFood?'farm':missing.find(type=>!foundations.some(site=>satisfiesBuilding(site.typeId,type)||site.upgrade&&satisfiesBuilding(site.upgrade.targetTypeId,type)))??(!missing.length&&!completed.has(units[desired].producedAt)?units[desired].producedAt:undefined);
    if(essential){
      const needed=buildings[essential].requiredTechnologies?.find(id=>!view.self.technologies?.includes(id));
      if(needed){let research=technologies[needed];for(let depth=0;depth<41;depth++){const before=research.prerequisites.find(id=>!view.self.technologies?.includes(id));if(!before)break;research=technologies[before];}priorityResearch.add(research.id);
        const source=complete.find(entity=>entity.typeId===research.researchedAt&&(entity.queue?.length??0)===0&&!options.protectedEntityIds?.has(entity.id));
        if(source){if(!jobs.some(job=>job.kind==='research'&&job.typeId===research.id)&&![...reservedCommands,...planned].some(command=>command.kind==='research'&&command.technologyId===research.id))add({kind:'research',buildingId:source.id,technologyId:research.id});essential=undefined;}
        else if(!complete.some(entity=>entity.typeId===research.researchedAt)){essential=research.researchedAt;priorityBuilds.add(essential);}else essential=undefined;
      }
      if(essential&&!buildings[essential].requiredTechnologies?.some(id=>!view.self.technologies?.includes(id))){const action=nextStructureUpgrade(observation,essential,options.protectedEntityIds)??buildingCommand(observation,essential,home,free,0,options.avoidBuildingCells);if(action)add(action);else if(!memory.constructionRecon)for(const command of constructionReconnaissance(observation,memory,essential,home,{protectedIds:options.protectedEntityIds,unavailable:locked,avoidCells:options.avoidBuildingCells,pending:[...reservedCommands,...planned],context}))add(command);for(const member of memory.constructionRecon?.members??[])locked.add(member.id);}
    }
    // Discovery alone is not demand. Prefer the greatest observed worker travel
    // burden, not the first resource in world order. A blocked forest edge must
    // not prevent trying a different demanded deposit during this strategic turn.
    if(!missing.length&&free.length&&!foundations.length&&![...reservedCommands,...planned].some(command=>command.kind==='build'||command.kind==='build_wall')){
      const committed=[...reservedCommands,...planned],allowed=new Set((['lumber_camp','mining_camp'] as const).filter(type=>campExpansionAllowed(observation,type,committed,context)));
      const demanded=new Map<string,number>();
      for(const worker of workers)if(worker.order==='gather'&&!options.protectedEntityIds?.has(worker.id)&&worker.workTargetId)demanded.set(worker.workTargetId,(demanded.get(worker.workTargetId)??0)+1);
      const allies=new Set(observation.players.filter(player=>player.teamId===faction.teamId&&!player.defeated).map(player=>player.id));
      const dropoffs=observation.entities.filter(entity=>entity.kind==='building'&&!entity.ghost&&entity.progress===1&&allies.has(entity.ownerId!));
      const sites=(allowed.size?knownResources:[]).flatMap(node=>{
        const count=demanded.get(node.id)??0;if(!count||node.ghost||(node.amount??0)<=0||!['wood','gold','stone'].includes(node.resource??''))return [];
        const type:'lumber_camp'|'mining_camp'=node.resource==='wood'?'lumber_camp':'mining_camp';if(!allowed.has(type))return [];
        const nearest=dropoffs.reduce((best,building)=>buildings[building.typeId].dropOffResources.includes(node.resource!)?Math.min(best,distance(building,node)):best,Infinity);
        return nearest>16000?[{node,type,score:count*(nearest-16000)}]:[];
      }).sort((a,b)=>b.score-a.score||a.node.id.localeCompare(b.node.id));
      const attempted:typeof sites=[];
      for(const site of sites){
        if(attempted.length>=3)break;
        if(attempted.some(prior=>prior.type===site.type&&distance(prior.node,site.node)<=16000))continue;
        attempted.push(site);
        if(add(buildingCommand(observation,site.type,site.node,free,0,options.avoidBuildingCells)))break;
      }
    }
    const completedResearch=new Set(view.self.technologies??[]),pendingResearch=new Set([...jobs.filter(job=>job.kind==='research').map(job=>job.typeId),...pending.filter(command=>command.kind==='research').map(command=>command.technologyId)]);
    const research=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).technologies.find(technology=>technology.minAge<=view.self.age&&!completedResearch.has(technology.id)&&!pendingResearch.has(technology.id)&&technology.prerequisites.every(id=>completedResearch.has(id))&&complete.some(building=>building.typeId===technology.researchedAt&&(building.queue?.length??0)===0)&&balance.resourceOrder.every(resource=>bank[resource]>=technology.cost[resource]+(resource==='food'?50:0)));
    if(research){const building=complete.find(building=>building.typeId===research.researchedAt&&(building.queue?.length??0)===0)!;add({kind:'research',buildingId:building.id,technologyId:research.id});}
  }
  // The ordinary fallback provides task continuation, housing, renewable farms and fog-frontier exploration.
  const economicObservation=planned.some(command=>command.kind==='continue_build')?caretakerObservation(observation,difficulty,planned,locked):observation;
  context?.inherit(observation,economicObservation);
  const economic=fallbackCommands(economicObservation,memory,{housingBuffer:options.housingBuffer,scoutAllowed:options.scoutAllowed,reservedWorkerIds:[...locked],protectedEntityIds:options.protectedEntityIds,avoidBuildingCells:options.avoidBuildingCells,economyOnly:true,resourceWeights:options.resourceWeights},context).filter(command=>command.kind!=='train'&&command.kind!=='attack_target'&&(options.scoutAllowed!==false||command.kind!=='move'));economic.sort((a,b)=>Number(b.kind==='build')-Number(a.kind==='build'));
  for(const command of economic)add(command);
  // AI-only replacement follows economy/age work and every earlier proposal.
  // Paid queues already occupy reservedPopulation; unpaid quantities do not.
  if(options.maintainScout&&(faction.kind==='ai'||faction.assistant?.enabled)&&view.self.age>=units.scout.minAge&&!own.some(entity=>entity.typeId==='scout')&&!jobs.some(job=>job.kind==='train'&&job.typeId==='scout')){
    const proposed=[...due,...pending,...planned],queuedScout=proposed.some(command=>command.kind==='train'&&command.unitType==='scout');
    const producer=complete.find(building=>building.typeId===units.scout.producedAt&&(building.queue?.length??0)===0&&!proposed.some(command=>command.kind==='advance_age'?command.townCenterId===building.id:(command.kind==='train'||command.kind==='research')&&command.buildingId===building.id));
    const unpaidPopulation=proposed.reduce((sum,command)=>sum+(command.kind==='train'?units[command.unitType].population*command.quantity:0),0),dueSpend={food:0,wood:0,gold:0,stone:0};
    for(const command of due){const price=cost(command,view);if(price)for(const resource of balance.resourceOrder)dueSpend[resource]+=price[resource];}
    if(!queuedScout&&producer&&view.self.population+view.self.reservedPopulation+unpaidPopulation+units.scout.population<=Math.min(view.self.populationCap,view.self.populationLimit)&&balance.resourceOrder.every(resource=>bank[resource]-dueSpend[resource]>=units.scout.cost[resource]))add({kind:'train',buildingId:producer.id,unitType:'scout',quantity:1});
  }
  if(planned.length)memory.pending.push({observedTick:view.tick,executeTick:view.tick+Math.ceil(policy.reactionDelaySeconds*hz),commands:planned});
  return due;
}
