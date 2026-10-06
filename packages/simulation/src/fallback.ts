import { balance, resolveRuleset, buildings, units, terrainBuildable, placementAreaDiscovered, resourcePlacementBounds, type GameplayCommand, type PlayerView, type BuildingId, type ResourceType, type ResourceBank, type ViewEntity, type Cell, type Position } from '@frontier/shared';
import { fortifyPlacementCellLimit } from './fortify-geometry.js';
import { aiBuildingClearanceMm, knownNavigation, scoutDestination, type AiDecisionContext } from './ai-exploration.js';

export interface FallbackMemory { sequence:number;scoutIndex:number;buildAttempt:number;assignments?:Record<string,ResourceType>;farmAssignments?:Record<string,string>;explorerId?:string;scoutRoute?:{target:Position;issuedTick:number} }
export interface FallbackOptions {housingBuffer?:number;scoutAllowed?:boolean;reservedWorkerIds?:readonly string[];protectedEntityIds?:ReadonlySet<string>;avoidBuildingCells?:readonly Cell[];economyOnly?:boolean;resourceWeights?:ResourceBank}
/** Reconcile only current disclosed work targets. Pending/manual assignments
 * remain reserved; at most the workforce's target IDs enter the lookup map. */
export function reconcileEconomyAssignments(view:PlayerView,memory:FallbackMemory,workers:readonly ViewEntity[],reserved:ReadonlySet<string>):void {
  const active=workers.filter(worker=>worker.order==='gather'&&worker.workTargetId&&!reserved.has(worker.id));if(!active.length)return;
  const wanted=new Set(active.map(worker=>worker.workTargetId!)),resources=new Map<string,ResourceType>();
  for(const entity of view.entities)if(wanted.has(entity.id)&&!entity.ghost&&entity.resource&&(entity.kind==='resource'||entity.typeId==='farm'&&entity.ownerId===view.playerId))resources.set(entity.id,entity.resource);
  const assignments=memory.assignments??(memory.assignments={}),observed=new Map<string,string>();
  for(const worker of active){const actual=resources.get(worker.workTargetId!);if(actual){assignments[worker.id]=actual;observed.set(worker.id,worker.workTargetId!);}}
  for(const [farmId,workerId]of Object.entries(memory.farmAssignments??{}))if(observed.has(workerId)&&observed.get(workerId)!==farmId)delete memory.farmAssignments![farmId];
}
/** Preferences guide a healthy economy; an actual shortage temporarily shifts
 * free gatherers away from large surpluses. Costs remain content-derived. */
export function effectiveEconomyWeights(view:PlayerView,preferred:ResourceBank):ResourceBank{
  const next=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).ages.find(age=>age.id===view.self.age+1),target={food:Math.max(units.villager.cost.food*2,next?.cost.food??0),wood:Math.max(buildings.house.cost.wood,(buildings.farm.reseedCost?.wood??0)*2,next?.cost.wood??0),gold:next?.cost.gold??units.militia.cost.gold*2,stone:Math.max(buildings.watchtower.cost.stone,next?.cost.stone??0)};
  // Later ages need thousands of food, not just the price of two villagers.
  // Recover this mandatory resource even if a model allocated zero farmers.
  const ageFoodShort=Boolean(next&&view.self.resources.food<next.cost.food),shortage=balance.resourceOrder.filter(resource=>(preferred[resource]>0||resource==='food'&&ageFoodShort)&&target[resource]>0&&view.self.resources[resource]<(resource==='food'&&ageFoodShort?target[resource]:target[resource]/4));
  if(!shortage.length||!(ageFoodShort&&preferred.food===0)&&!balance.resourceOrder.some(resource=>preferred[resource]>0&&view.self.resources[resource]>target[resource]*4))return {...preferred};
  const scores=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,shortage.includes(resource)?preferred[resource]+100*(1-view.self.resources[resource]/target[resource]):view.self.resources[resource]>target[resource]*4?preferred[resource]/4:preferred[resource]])) as ResourceBank;
  const total=balance.resourceOrder.reduce((sum,resource)=>sum+scores[resource],0),result=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,Math.floor(scores[resource]/total*100)])) as ResourceBank;
  const remainder=100-balance.resourceOrder.reduce((sum,resource)=>sum+result[resource],0);result[shortage[0]!]+=remainder;return result;
}
/** Pure planner: no authoritative-world reference, endpoint dependency or privileged coordinates. */
export function fallbackCommands(view:PlayerView,memory:FallbackMemory,options:FallbackOptions={},context?:AiDecisionContext):GameplayCommand[]{
  const roster=context?.roster(view),result:GameplayCommand[]=[],own=roster?.own??view.entities.filter(e=>e.ownerId===view.playerId),home=own.find(e=>e.typeId==='town_center');
  if(!home)return result;
  const workers=own.filter(e=>e.typeId==='villager'),reserved=new Set([...(options.reservedWorkerIds??[]),...(options.protectedEntityIds??[])]),available=workers.filter(worker=>!reserved.has(worker.id)),faction=view.players.find(p=>p.id===view.playerId)!;
  const targets=roster?.resources??view.entities.filter(e=>e.kind==='resource'&&!e.ghost&&(e.amount??0)>0);
  // Build ordered resource groups only if this synchronous observation needs a
  // nearest-target query. Repeated records remain separate occurrences.
  let targetsByResource:Map<ResourceType,ViewEntity[]>|undefined;
  // Remote disclosed food does not make a local renewable economy unnecessary.
  // This is a cheap locality preference, not a claim that an unseen route is safe.
  const farms=own.filter(e=>e.typeId==='farm'),forage=targets.filter(e=>e.resource==='food'&&Math.hypot(e.xMm-home.xMm,e.zMm-home.zMm)<=32000).reduce((sum,e)=>sum+(e.amount??0),0);
  const assignments=memory.assignments??(memory.assignments={});
  const farmAssignments=memory.farmAssignments??(memory.farmAssignments={});
  // A model can change a worker's job without updating fallback's memory. Use
  // the disclosed current target, retaining reservations for delayed commands.
  reconcileEconomyAssignments(view,memory,workers,reserved);
  for(const id of Object.keys(assignments))if(!workers.some(worker=>worker.id===id&&(reserved.has(id)||['gather','reseed'].includes(worker.order??''))))delete assignments[id];
  for(const [farmId,workerId]of Object.entries(farmAssignments))if(!farms.some(farm=>farm.id===farmId)||!workers.some(worker=>worker.id===workerId&&['gather','reseed'].includes(worker.order??'')&&worker.blockedReason!=='FARM_OCCUPIED'))delete farmAssignments[farmId];
  const assigned=new Set<string>(),claimedFarms=new Set<string>();
  // Resume an orphan, or help one observed path-blocked builder with one idle
  // worker. Pending/due continuations count as builders in caretaker's view,
  // so even two blocked builders retain their orders without draining helpers.
  const foundations=own.filter(entity=>entity.kind==='building'&&!entity.ghost&&(entity.progress??1)<1),unfinished=foundations.find(entity=>!(entity.pendingConstruction&&entity.blockedReason==='PLACEMENT_BLOCKED')),builders=workers.filter(worker=>worker.order==='build');
  const assist=foundations.length===1&&builders.length===1&&!reserved.has(builders[0]!.id)&&builders[0]!.taskState==='blocked'&&builders[0]!.blockedReason==='PATH_BLOCKED';
  if(unfinished&&!workers.some(worker=>worker.order==='reseed')&&(!builders.length||assist)){
    const builder=available.filter(worker=>!worker.garrisonedIn&&!worker.queuedOrderCount&&(assist?worker.order==='idle':['idle','gather'].includes(worker.order??'idle'))).sort((a,b)=>Math.hypot(a.xMm-unfinished.xMm,a.zMm-unfinished.zMm)-Math.hypot(b.xMm-unfinished.xMm,b.zMm-unfinished.zMm)||a.id.localeCompare(b.id))[0];
    if(builder){result.push({kind:'continue_build',builderIds:[builder.id],foundationId:unfinished.id,queued:false});assigned.add(builder.id);delete assignments[builder.id];for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===builder.id)delete farmAssignments[farmId];}
  }
  const issueGather=(worker:ViewEntity,target:ViewEntity)=>{
    result.push({kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false});assignments[worker.id]=target.resource!;assigned.add(worker.id);
    for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===worker.id)delete farmAssignments[farmId];
    if(target.typeId==='farm'){claimedFarms.add(target.id);farmAssignments[target.id]=worker.id;}
  };
  const freeFarms=()=>farms.filter(farm=>farm.progress===1&&(farm.amount??0)>0&&!farm.farmerAssigned&&!farmAssignments[farm.id]&&!claimedFarms.has(farm.id));
  // An empty farm cannot fund its own reseed. Release one unpaid, blocked
  // farmer to wood when discovery supplies a target; never interrupt paid work,
  // carried cargo, queued orders or a manually reserved worker.
  const unfundedFarmer=(worker:ViewEntity)=>worker.order==='gather'&&worker.taskState==='blocked'&&worker.blockedReason==='INSUFFICIENT_RESOURCES'&&!worker.garrisonedIn&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0);
  // A model economy plan may have moved every farmer away during the shortage.
  // Auto-reseed cannot restart an orphaned empty farm without an ordinary worker
  // order. Reclaim one when its full cost is available, retaining all paid work.
  const emptyFarm=view.self.autoReseed?farms.find(farm=>farm.progress===1&&farm.farmState==='exhausted'&&!reserved.has(farm.id)&&!farm.farmerAssigned&&!farmAssignments[farm.id]):undefined;
  if(emptyFarm&&balance.resourceOrder.every(resource=>view.self.resources[resource]>=buildings.farm.reseedCost![resource])){
    const eligible=available.filter(worker=>!assigned.has(worker.id)&&!worker.garrisonedIn&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)&&['idle','gather'].includes(worker.order??'idle'));
    const farmer=eligible.find(worker=>worker.order==='idle')??eligible.find(worker=>assignments[worker.id]!=='food');
    if(farmer){result.push({kind:'reseed_farm',farmId:emptyFarm.id,builderId:farmer.id});assigned.add(farmer.id);assignments[farmer.id]='food';for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===farmer.id)delete farmAssignments[farmId];farmAssignments[emptyFarm.id]=farmer.id;}
  }
  // Retain one farmer during their return trip; reservations are owned-only snapshot data.
  if(forage<250)for(const farm of freeFarms()){
    const worker=available.find(w=>!assigned.has(w.id)&&(w.order==='idle'||w.blockedReason==='FARM_OCCUPIED'))??available.find(w=>!assigned.has(w.id)&&w.order==='gather'&&assignments[w.id]!=='food');
    if(worker)issueGather(worker,farm);
  }
  const allocation:ResourceType[]=['wood','food','food','gold','wood','food','stone','food','wood','food'];
  const nearest=(worker:ViewEntity,resource:ResourceType):ViewEntity|undefined=>{
    if(!targetsByResource){targetsByResource=new Map();for(const target of targets)if(target.resource){let group=targetsByResource.get(target.resource);if(!group){group=[];targetsByResource.set(target.resource,group);}group.push(target);}}
    // Reservations change after each gather proposal; farms must stay live to
    // those changes and follow resource records in the original tie order.
    const sources=targetsByResource.get(resource)??[],eligibleFarms=resource==='food'?freeFarms().filter(farm=>farm.resource===resource):[];
    let chosen:ViewEntity|undefined,closest=Infinity,finite=true;
    for(const group of [sources,eligibleFarms])for(const target of group){const distance=Math.hypot(target.xMm-worker.xMm,target.zMm-worker.zMm);if(!Number.isFinite(distance))finite=false;if(distance<closest){chosen=target;closest=distance;}}
    // Public mutable fixtures can supply non-finite geometry. Preserve the
    // old stable-sort comparator in that case, including NaN's tie behavior.
    if(!finite)return [...sources,...eligibleFarms].sort((a,b)=>Math.hypot(a.xMm-worker.xMm,a.zMm-worker.zMm)-Math.hypot(b.xMm-worker.xMm,b.zMm-worker.zMm))[0];
    return chosen;
  };
  // At most one existing worker changes jobs per pulse. Never interrupt cargo,
  // a queued/manual order, paid reseeding, a builder, or the last source worker.
  const preferred=options.resourceWeights??{food:50,wood:30,gold:10,stone:10},weights=effectiveEconomyWeights(view,preferred);
  let shortageReassigned=false;
  if(balance.resourceOrder.some(resource=>weights[resource]!==preferred[resource])){
    const counts=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,workers.filter(worker=>assignments[worker.id]===resource&&worker.order==='gather').length])) as ResourceBank;
    for(const resource of [...balance.resourceOrder].sort((a,b)=>(workers.length*weights[b]/100-counts[b])-(workers.length*weights[a]/100-counts[a]))){
      if(counts[resource]>=workers.length*weights[resource]/100)continue;
      const worker=available.find(worker=>!assigned.has(worker.id)&&!worker.garrisonedIn&&!worker.queuedOrderCount&&!(worker.cargo?.amount??0)&&worker.order==='gather'&&assignments[worker.id]!==undefined&&assignments[worker.id]!==resource&&counts[assignments[worker.id]!] > Math.max(1,workers.length*weights[assignments[worker.id]!]/100));
      const node=worker&&nearest(worker,resource);if(worker&&node){issueGather(worker,node);shortageReassigned=true;break;}
    }
  }
  for(const [index,worker]of workers.entries())if(!reserved.has(worker.id)&&(worker.order==='idle'||worker.blockedReason==='FARM_OCCUPIED')&&!assigned.has(worker.id)){
    const resource=allocation[index%allocation.length]!,node=nearest(worker,resource)??nearest(worker,resource==='wood'?'food':'wood');
    if(node)issueGather(worker,node);
  }
  if(!workers.some(worker=>assignments[worker.id]==='wood'&&(assigned.has(worker.id)||worker.order==='gather'&&worker.taskState!=='blocked'))){
    const worker=available.find(worker=>!assigned.has(worker.id)&&unfundedFarmer(worker)),node=worker&&nearest(worker,'wood');
    if(worker&&node)issueGather(worker,node);
  }
  // Reassign at most one existing gatherer when newly explored ore opens an unstaffed resource.
  for(const resource of shortageReassigned?[]:['gold','stone'] as const)if(targets.some(e=>e.resource===resource)&&!Object.values(assignments).includes(resource)){
    const worker=available.find(w=>!assigned.has(w.id)&&w.order==='gather'&&assignments[w.id]==='wood');
    const node=worker&&nearest(worker,resource);if(worker&&node){issueGather(worker,node);break;}
  }
  const desiredFarms=forage<250?Math.max(1,Math.ceil(workers.length/2)):0;
  if(farms.length&&!view.self.autoReseed)result.push({kind:'set_auto_reseed',enabled:true});
  const structures=own.filter(entity=>entity.kind==='building'),futureSupply=structures.reduce((sum,entity)=>sum+buildings[entity.typeId].populationProvided,0);
  const needsHousing=view.self.populationCap<view.self.populationLimit&&futureSupply<view.self.populationLimit&&view.self.population+view.self.reservedPopulation>=view.self.populationCap-(options.housingBuffer??2);
  const needed:BuildingId|undefined=needsHousing?'house':!own.some(e=>e.typeId==='barracks')?'barracks':farms.length<desiredFarms?'farm':undefined;
  if(needed&&structures.filter(entity=>!buildings[entity.typeId].wallEquivalentCells).length<balance.rules.maxNonWallBuildingsPerPlayer&&available.length&&!result.some(command=>command.kind==='reseed_farm')&&!workers.some(w=>w.order==='build'||w.order==='reseed')&&!own.some(e=>e.kind==='building'&&(e.progress??1)<1)&&balance.resourceOrder.every(resource=>view.self.resources[resource]>=buildings[needed].cost[resource])){
    const def=buildings[needed],grid=balance.rules.buildingGridM*1000;
    const explored=new Set(view.fog.explored),width=view.map.widthMm/view.map.fogCellMm;
    const candidates:{x:number;z:number}[]=[];
    for(let z=-10;z<=10;z+=2)for(let x=-10;x<=10;x+=2)candidates.push({x:Math.floor(home.xMm/grid)+x,z:Math.floor(home.zMm/grid)+z});
    candidates.sort((a,b)=>Math.hypot(a.x*grid-home.xMm,a.z*grid-home.zMm)-Math.hypot(b.x*grid-home.xMm,b.z*grid-home.zMm));
    let occupied:((left:number,top:number,right:number,bottom:number)=>boolean)|undefined;
    const legalSite=(c:Cell)=>{
      if(c.x<0||c.z<0)return false;
      const [w,h]=def.footprintCells,left=c.x*grid,right=(c.x+w)*grid,top=c.z*grid,bottom=(c.z+h)*grid;
      if(right>view.map.widthMm||bottom>view.map.heightMm)return false;
      if(!terrainBuildable(view.map.terrain??[],{xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top}))return false;
      if(!placementAreaDiscovered({xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),(x,z)=>explored.has(Math.floor(z/view.map.fogCellMm)*width+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]))return false;
      if(context){occupied??=context.fallbackPlacement(view,{left:(Math.floor(home.xMm/grid)-24)*grid,top:(Math.floor(home.zMm/grid)-24)*grid,right:(Math.floor(home.xMm/grid)+24+w)*grid,bottom:(Math.floor(home.zMm/grid)+24+h)*grid});if(occupied)return !occupied(left,top,right,bottom);}
      return !view.entities.some(e=>{if(e.ghost&&e.kind==='unit'||e.kind==='resource'&&(e.amount??0)===0)return false;let [width,depth]=e.kind==='building'?buildings[e.typeId as BuildingId].footprintCells:[1,1];if(e.rotation===90||e.rotation===270)[width,depth]=[depth,width];const gap=e.kind==='building'?aiBuildingClearanceMm:0,bounds=e.kind==='resource'?resourcePlacementBounds(e,balance.rules.treeBuildingClearanceM*1000):{halfWidth:width!*grid/2+gap,halfHeight:depth!*grid/2+gap};return e.xMm+bounds.halfWidth>left&&e.xMm-bounds.halfWidth<right&&e.zMm+bounds.halfHeight>top&&e.zMm-bounds.halfHeight<bottom;});
    };
    const legal=candidates.filter(legalSite);
    const avoid=(options.avoidBuildingCells??[]).slice(0,fortifyPlacementCellLimit*balance.ai.maxGoals),reserved=new Set(avoid.map(cell=>`${cell.x},${cell.z}`)),[w,h]=def.footprintCells;
    const streetCells=aiBuildingClearanceMm/grid,overlapsContour=(site:Cell)=>{for(let z=site.z-streetCells;z<site.z+h+streetCells;z++)for(let x=site.x-streetCells;x<site.x+w+streetCells;x++)if(reserved.has(`${x},${z}`))return true;return false;},preferred=avoid.length?legal.filter(site=>!overlapsContour(site)):legal;
    let sites=preferred;
    if(!sites.length){
      // Keep the625-origin bound when a wider street or reserved gate approach
      // consumes the original village sites. Never fill a reserved passage.
      const outer:Cell[]=[];for(let z=-24;z<=24;z+=2)for(let x=-24;x<=24;x+=2)if(Math.abs(x)>10||Math.abs(z)>10)outer.push({x:Math.floor(home.xMm/grid)+x,z:Math.floor(home.zMm/grid)+z});
      outer.sort((a,b)=>Math.hypot(a.x*grid-home.xMm,a.z*grid-home.zMm)-Math.hypot(b.x*grid-home.xMm,b.z*grid-home.zMm));
      const outside=outer.filter(site=>!overlapsContour(site)&&legalSite(site));if(outside.length)sites=outside;
    }
    // No clear site leaves construction pending; resources are not spent.
    if(sites.length){const site=sites[memory.buildAttempt++%sites.length]!;const builder=available.find(worker=>assignments[worker.id]!=='food')??available[0]!;result.push({kind:'build',builderIds:[builder.id],buildingType:needed as 'house'|'barracks'|'farm',originCell:site,rotation:0,queued:false});delete assignments[builder.id];assigned.add(builder.id);}
  }
  // Caretaker owns these decisions and formerly discarded every proposal from
  // this branch. Standalone fallback retains its complete command sequence.
  if(!options.economyOnly){
    if(workers.length<12&&(home.queue?.length??0)===0&&view.self.resources.food>=units.villager.cost.food)result.push({kind:'train',buildingId:home.id,unitType:'villager',quantity:1});
    const barracks=own.find(e=>e.typeId==='barracks'&&e.progress===1);
    if(barracks&&(barracks.queue?.length??0)===0&&view.self.resources.food>=units.militia.cost.food&&view.self.resources.gold>=units.militia.cost.gold)result.push({kind:'train',buildingId:barracks.id,unitType:'militia',quantity:1});
    const enemies=view.entities.filter(e=>e.ownerId&&e.ownerId!==view.playerId&&!e.ghost&&view.players.find(p=>p.id===e.ownerId)?.teamId!==faction.teamId);
    const policy=balance.ai.difficulty[faction.difficulty??'medium'];
    for(const army of own.filter(e=>e.typeId==='militia')){
      if(army.order!=='idle')continue;
      const enemy=enemies.sort((a,b)=>Math.hypot(a.xMm-army.xMm,a.zMm-army.zMm)-Math.hypot(b.xMm-army.xMm,b.zMm-army.zMm))[0];
      const defending=enemy&&Math.hypot(enemy.xMm-home.xMm,enemy.zMm-home.zMm)<25000;
      if(enemy&&(defending||view.tick>=policy.initialBaseAssaultNotBeforeSeconds*balance.rules.simulationHz))result.push({kind:'attack_target',unitIds:[army.id],targetId:enemy.id,queued:false});
    }
  }
  const previousExplorer=workers.find(worker=>worker.id===memory.explorerId);
  if(memory.explorerId&&(!previousExplorer||assigned.has(memory.explorerId)||previousExplorer.garrisonedIn||previousExplorer.queuedOrderCount||options.protectedEntityIds?.has(memory.explorerId)||(previousExplorer.cargo?.amount??0)>0||!['idle','move'].includes(previousExplorer.order??'idle')&&!unfundedFarmer(previousExplorer)))delete memory.explorerId;
  if(options.scoutAllowed!==false){
    const freeToExplore=(unit:ViewEntity)=>!reserved.has(unit.id)&&!assigned.has(unit.id)&&!unit.garrisonedIn&&!unit.queuedOrderCount&&!(unit.cargo?.amount??0)&&((unit.order??'idle')==='idle'||unit.order==='move'&&unit.taskState==='blocked');
    const scouts=own.filter(unit=>unit.typeId==='scout'&&!unit.garrisonedIn),scout=scouts.find(freeToExplore);
    const needsDiscovery=!targets.some(node=>node.resource==='wood')&&view.self.resources.wood<buildings.farm.reseedCost!.wood;
    // One recovery worker is enough when no Scout survives and food cannot pay
    // for a replacement. Retain that identity through delayed moves and saves.
    const worker=needsDiscovery&&!scouts.length?(memory.explorerId?previousExplorer&&freeToExplore(previousExplorer)?previousExplorer:undefined:available.find(unit=>freeToExplore(unit)||!reserved.has(unit.id)&&!assigned.has(unit.id)&&unfundedFarmer(unit))):undefined;
    const explorer=scout??worker;
    if(explorer){
      const enemies=view.entities.filter(entity=>entity.ownerId&&entity.ownerId!==view.playerId&&!entity.ghost&&view.players.find(player=>player.id===entity.ownerId)?.teamId!==faction.teamId);
      const avoid=explorer.taskState==='blocked'&&memory.scoutRoute&&view.tick-memory.scoutRoute.issuedTick<60*balance.rules.simulationHz?memory.scoutRoute.target:undefined;
      const target=scoutDestination(view,explorer,enemies,context?.navigation(view)??knownNavigation(view),memory.scoutIndex,avoid,context);
      if(target){result.push({kind:'move',unitIds:[explorer.id],target,queued:false});memory.scoutIndex++;memory.scoutRoute={target:{...target},issuedTick:view.tick};if(explorer.typeId==='villager'){memory.explorerId=explorer.id;delete assignments[explorer.id];for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===explorer.id)delete farmAssignments[farmId];}}
    }
  }
  return result;
}
