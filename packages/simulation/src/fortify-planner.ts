import { balance, buildings, wallTypeForMaterial, gateTypeForMaterial, structureUpgrade, buildingSatisfies, type BuildingId, sha256, terrainObstacles, units, placementAreaDiscovered, type Cell, type GameplayCommand, type PlayerView, type Position, type ViewEntity } from '@frontier/shared';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget } from './navigation.js';
import { fortifyViewObstacle, resolveFortifyGeometry, resolveFortifyScreen, type FortifyGeometryMemory, type FortifyGoal } from './fortify-geometry.js';
import { fortificationObstacles } from './fortifications.js';
import type { Building } from './state.js';
import { aiBuildingClearanceMm } from './ai-exploration.js';

export interface FortifyMemory extends FortifyGeometryMemory {goalKey?:string;pendingUntilTick?:number;nextPlanningTick?:number;lastSignature?:string;geometryKey?:string;validatedFaces?:number;validatedResources?:number;proofPhase?:'baseline'|'proposed';routesValid?:boolean;routeFailure?:string;scouting?:{workerId:string;target:Position}}
export interface FortifyResult {status:'building'|'complete'|'blocked'|'waiting';commands:GameplayCommand[];reason?:string}
const grid=balance.rules.buildingGridM*1000,limit=100000;
/** Call only after the proposal has entered the controller's ordinary command queue. */
export function markFortifyQueued(memory:FortifyMemory,command:GameplayCommand,tick:number):void{memory.lastSignature=JSON.stringify(command);memory.pendingUntilTick=tick+2*balance.rules.simulationHz;if(command.kind==='move')memory.scouting={workerId:command.unitIds[0]!,target:{...command.target}};else delete memory.scouting;}
/** Expensive unfinished proofs need not repeat at every tactical combat pulse.
 * Changing the intended site/material still gets an immediate first decision. */
export function fortifyControllerCommands(view:PlayerView,goal:FortifyGoal,memory:FortifyMemory,eligibleBuilderIds?:ReadonlySet<string>):FortifyResult{
  const goalKey=`${view.playerId}:${goal.anchorRef}:${goal.material}:${goal.radiusM}`;
  if(memory.goalKey===goalKey&&(memory.nextPlanningTick??0)>view.tick){const reason=memory.blockedGeometry?.reason??memory.routeFailure;return {status:reason?'blocked':'waiting',commands:[],reason:reason??'FORTIFICATION_RETRY_DELAY'};}
  const result=fortifyCommands(view,goal,memory,undefined,eligibleBuilderIds);
  if(!result.commands.length&&result.status!=='complete')memory.nextPlanningTick=view.tick+(result.status==='blocked'?5:1)*balance.rules.simulationHz;
  else delete memory.nextPlanningTick;
  return result;
}
/** Adding prefix cells can only remove existing work faces. Check at most one
 * full run plus ceil(log2(64)) prefixes; ordinary admission still proves routes. */
function accessibleWallPrefix(view:PlayerView,worker:ViewEntity,run:Cell[],budget:NavigationWorkBudget):Cell[]{
  const radius=units[worker.typeId].collisionRadiusM*1000,margin=radius+500,bodies=view.entities.filter(entity=>entity.kind==='unit'&&!entity.ghost&&!entity.garrisonedIn&&entity.hp>0&&entity.id!==worker.id);
  const hostile=(a:string,b:string|null)=>Boolean(b&&view.players.find(player=>player.id===a)!.teamId!==view.players.find(player=>player.id===b)!.teamId);
  const known=[...terrainObstacles(view.map.terrain??[]),...view.entities.filter(entity=>entity.kind==='building'||entity.kind==='resource'&&(entity.amount??0)>0).flatMap(entity=>{
    if(entity.kind!=='building')return [fortifyViewObstacle(entity)];
    // A non-owned gate's private mode is absent. Only its observed opening
    // licenses passage; do not turn an allied closed gate into inferred AUTO.
    const planningFor=view.players.find(player=>player.id===entity.ownerId)?.defeated||entity.ownerId!==view.playerId&&entity.gateMode===undefined?undefined:view.playerId;
    return fortificationObstacles({id:entity.id,typeId:entity.typeId,ownerId:entity.ownerId!,xMm:entity.xMm,zMm:entity.zMm,rotation:entity.rotation??0,work:entity.progress??0,required:1,gateMode:entity.gateMode,gateOpen:entity.gateOpen} as Building,planningFor,hostile);
  })];
  const proposals=run.map((cell,index)=>({id:`access_${index}`,xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid,halfWidth:grid/2,halfHeight:grid/2}));
  const faces=proposals.map(site=>{
    // Match ordinary building admission's radius+500 faces and their order.
    const points:Position[]=[];for(let x=-site.halfWidth;x<=site.halfWidth;x+=1000)points.push({xMm:site.xMm+x,zMm:site.zMm-site.halfHeight-margin},{xMm:site.xMm+x,zMm:site.zMm+site.halfHeight+margin});
    for(let z=-site.halfHeight;z<=site.halfHeight;z+=1000)points.push({xMm:site.xMm-site.halfWidth-margin,zMm:site.zMm+z},{xMm:site.xMm+site.halfWidth+margin,zMm:site.zMm+z});
    return points.sort((a,b)=>Math.hypot(a.xMm-worker.xMm,a.zMm-worker.zMm)-Math.hypot(b.xMm-worker.xMm,b.zMm-worker.zMm));
  });
  const vacant=(point:Position)=>{for(const body of bodies){if(budget.remaining<=0)throw new PathBudgetExceededError();budget.remaining--;budget.used++;if(Math.hypot(point.xMm-body.xMm,point.zMm-body.zMm)<radius+units[body.typeId].collisionRadiusM*1000)return false;}return true;};
  const fits=(count:number)=>{const nav=new Navigation(view.map.widthMm,view.map.heightMm,[...known,...proposals.slice(0,count)],30000,1000,budget);for(let index=0;index<count;index++)if(!faces[index]!.some(point=>nav.free(point,radius)&&vacant(point)))return false;return true;};
  let best=0,upper=run.length;
  try{
    if(fits(upper))return run;upper--;
    while(best<upper){const middle=Math.ceil((best+upper)/2);if(fits(middle))best=middle;else upper=middle-1;}
  }catch(error){if(!(error instanceof PathBudgetExceededError))throw error;}
  // A failed/incomplete larger probe never licenses an unproved prefix.
  return run.slice(0,best);
}
/** Filtered desired-state planning. Geometry never replaces ordinary command admission. */
export function fortifyCommands(view:PlayerView,goal:FortifyGoal,memory:FortifyMemory,workBudget:NavigationWorkBudget={remaining:limit,used:0},eligibleBuilderIds?:ReadonlySet<string>):FortifyResult{
  const budget={remaining:Math.min(limit,workBudget.remaining),used:0};
  try{return plan(view,goal,memory,budget,eligibleBuilderIds);}finally{workBudget.remaining-=budget.used;workBudget.used+=budget.used;}
}
function plan(view:PlayerView,goal:FortifyGoal,memory:FortifyMemory,budget:NavigationWorkBudget,eligibleBuilderIds?:ReadonlySet<string>):FortifyResult{
  const block=(reason:string):FortifyResult=>({status:'blocked',commands:[],reason}),wait=(reason?:string):FortifyResult=>({status:'waiting',commands:[],...(reason?{reason}:{})});
  const goalKey=`${view.playerId}:${goal.anchorRef}:${goal.material}:${goal.radiusM}`;
  if(memory.goalKey!==goalKey){for(const key of Object.keys(memory) as (keyof FortifyMemory)[])delete memory[key];memory.goalKey=goalKey;}
  if((memory.pendingUntilTick??0)>view.tick)return wait();
  let geometry=memory.screen?resolveFortifyScreen(view,goal,memory,budget):resolveFortifyGeometry(view,goal,memory,budget);
  if(geometry.status==='blocked'&&!memory.screen&&!memory.layoutCommitted&&['RING_OCCUPIED','RING_NOT_EXPLORED','TERRAIN_BLOCKED'].includes(geometry.reason)){
    const screen=resolveFortifyScreen(view,goal,memory,budget);if(screen.status!=='blocked')geometry=screen;
  }
  if(geometry.status!=='ready')return {status:geometry.status,commands:[],reason:geometry.reason};
  const own=view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),anchor=own.find(entity=>entity.id===goal.anchorRef)!,workers=own.filter(entity=>entity.typeId==='villager'&&!entity.garrisonedIn);
  if(!workers.length)return block('NO_BUILDERS');
  const desiredWall=wallTypeForMaterial(goal.material),desiredGate=gateTypeForMaterial(goal.material);
  const pendingUpgrades=own.filter(entity=>geometry.matchedIds.has(entity.id)&&entity.upgrade);
  if(pendingUpgrades.length)return wait('UPGRADE_IN_PROGRESS');
  const lower=own.filter(entity=>geometry.matchedIds.has(entity.id)&&(entity.progress??1)>=1&&!buildingSatisfies(entity.typeId as BuildingId,entity.typeId.endsWith('_gate')?desiredGate:desiredWall));
  if(lower.length){
    const first=lower[0]!,next=Object.values(buildings).find(definition=>definition.upgradeFrom===first.typeId);
    if(!next||next.minAge>view.self.age||next.requiredTechnologies?.some(id=>!view.self.technologies?.includes(id)))return block('UPGRADE_PREREQUISITE_REQUIRED');
    const price=structureUpgrade(first.typeId as BuildingId,next.id)!;
    const affordable=Math.min(64,...balance.resourceOrder.filter(resource=>price.cost[resource]>0).map(resource=>Math.floor(view.self.resources[resource]/price.cost[resource])));
    if(affordable<1)return wait('INSUFFICIENT_RESOURCES');
    if(!workers.some(candidate=>!candidate.queuedOrderCount&&(!eligibleBuilderIds||eligibleBuilderIds.has(candidate.id))))return wait('BUILDERS_BUSY');
    return {status:'building',commands:[{kind:'upgrade_structure',buildingIds:lower.filter(entity=>entity.typeId===first.typeId).slice(0,affordable).map(entity=>entity.id),targetTypeId:next.id}]};
  }
  if(geometry.walls.every(cell=>(geometry.wallAt(cell)?.progress??0)>=1)&&geometry.layout.gates.every(site=>(geometry.gateAt(site)?.progress??0)>=1))return {status:'complete',commands:[]};
  const worker=workers.filter(candidate=>(!eligibleBuilderIds||eligibleBuilderIds.has(candidate.id))&&!candidate.queuedOrderCount&&!['build','reseed'].includes(candidate.order??'')).sort((a,b)=>Math.hypot(a.xMm-anchor.xMm,a.zMm-anchor.zMm)-Math.hypot(b.xMm-anchor.xMm,b.zMm-anchor.zMm))[0];
  const unfinished=own.find(entity=>geometry.matchedIds.has(entity.id)&&(entity.progress??1)<1);
  if(unfinished){if(!worker||workers.some(candidate=>candidate.order==='build'&&candidate.taskState!=='blocked'&&(!candidate.workTargetId||candidate.workTargetId===unfinished.id)))return wait('BUILDERS_BUSY');return {status:'building',commands:[{kind:'continue_build',builderIds:[worker.id],foundationId:unfinished.id,queued:false}]};}
  const resources=view.entities.filter(entity=>entity.kind==='resource'&&(entity.amount??0)>0),targets=resources.map(resource=>{const b=fortifyViewObstacle(resource);return [{xMm:resource.xMm-b.halfWidth-900,zMm:resource.zMm},{xMm:resource.xMm+b.halfWidth+900,zMm:resource.zMm},{xMm:resource.xMm,zMm:resource.zMm-b.halfHeight-900},{xMm:resource.xMm,zMm:resource.zMm+b.halfHeight+900}];});
  const geometryKey=sha256(JSON.stringify({knownObstacles:geometry.knownObstacles,layout:geometry.layout.signature,origin:geometry.layout.origin,anchorFaces:geometry.anchorFaces,radiusMm:350,resources:resources.map((resource,index)=>({id:resource.id,faces:targets[index]}))}));
  if(memory.geometryKey!==geometryKey){memory.geometryKey=geometryKey;memory.validatedFaces=0;memory.validatedResources=0;memory.proofPhase='baseline';memory.routesValid=false;delete memory.routeFailure;}
  // Screen selection proves a clear local detour around its whole footprint.
  // It preserves connectivity for every resource, including distant deposits,
  // without rescanning their entire routes on each tree depletion.
  if(memory.screen){memory.validatedFaces=geometry.anchorFaces.length;memory.validatedResources=resources.length;memory.routesValid=true;delete memory.proofPhase;delete memory.routeFailure;}
  if(memory.routeFailure)return block(memory.routeFailure);
  const knownNav=new Navigation(view.map.widthMm,view.map.heightMm,geometry.knownObstacles,30000,1000,budget),proposedNav=new Navigation(view.map.widthMm,view.map.heightMm,[...geometry.knownObstacles,...geometry.proposedObstacles],30000,1000,budget);
  // Spend the charged query allowance, not a fixed number of resource records.
  // Dense forests contain many fully enclosed trees whose four work faces can
  // be rejected cheaply. A four-record cap made such proofs take hundreds of
  // tactical pulses and restart whenever ordinary harvesting changed geometry.
  while(!memory.routesValid&&((memory.validatedFaces??0)<geometry.anchorFaces.length||(memory.validatedResources??0)<resources.length)){
    if(budget.remaining<=0)return wait('VALIDATING_RESOURCE_ROUTES');
    const face=(memory.validatedFaces??0)<geometry.anchorFaces.length,index=face?memory.validatedFaces??0:memory.validatedResources??0,phase=memory.proofPhase??'baseline',phaseBudget=budget.remaining;
    try{
      // A free face in another component is not evidence of an inaccessible
      // resource. Conservatively stop before purchases if it cannot be joined.
      const path=(phase==='baseline'?knownNav:proposedNav).pathToAny(geometry.layout.origin,face?[geometry.anchorFaces[index]!]:targets[index]!,350);
      if(phase==='baseline'&&path){memory.proofPhase='proposed';continue;}
      if(face&&phase==='baseline'&&!path&&!knownNav.free(geometry.anchorFaces[index]!,350)){memory.validatedFaces=index+1;continue;}
      if(!path&&(face||phase==='proposed')){memory.routeFailure=face?'ANCHOR_APPROACH_UNPROVEN':'RESOURCE_ROUTE_BLOCKED';return block(memory.routeFailure);}
      // Persist each completed resource before any subsequent interrupted phase.
      if(face)memory.validatedFaces=index+1;else memory.validatedResources=index+1;memory.proofPhase='baseline';
    }catch(error){
      if(!(error instanceof PathBudgetExceededError))throw error;
      // A whole fresh invocation is a bounded limit. Later phases wait with
      // their successful baseline and prior-resource cursor preserved.
      if(phaseBudget===limit){memory.routeFailure=face?'ANCHOR_APPROACH_LIMIT':'RESOURCE_ROUTE_LIMIT';return block(memory.routeFailure);}
      return wait('VALIDATING_RESOURCE_ROUTES');
    }
  }
  if((memory.validatedFaces??0)>=geometry.anchorFaces.length&&(memory.validatedResources??0)>=resources.length){memory.routesValid=true;delete memory.proofPhase;}
  if(!memory.routesValid)return wait('VALIDATING_RESOURCE_ROUTES');
  if(!worker)return wait('BUILDERS_BUSY');
  const wallType=wallTypeForMaterial(goal.material),gateType=gateTypeForMaterial(goal.material);
  const explored=new Set(view.fog.explored),fogWidth=view.map.widthMm/view.map.fogCellMm;
  const seen=(cells:readonly Cell[])=>cells.every(cell=>placementAreaDiscovered({xMm:cell.x*grid,zMm:cell.z*grid,widthMm:grid,depthMm:grid},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),(x,z)=>explored.has(Math.floor(z/view.map.fogCellMm)*fogWidth+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]));
  const occupied=(cells:Cell[])=>cells.some(cell=>view.entities.some(entity=>{if(entity.kind!=='unit'||entity.ghost||entity.garrisonedIn)return false;const dx=Math.max(cell.x*grid-entity.xMm,0,entity.xMm-(cell.x+1)*grid),dz=Math.max(cell.z*grid-entity.zMm,0,entity.zMm-(cell.z+1)*grid);return dx*dx+dz*dz<(units[entity.typeId].collisionRadiusM*1000)**2;}));
  const gateCells=(site:(typeof geometry.layout.gates)[number])=>Array.from({length:site.widthCells??3},(_,index)=>({x:site.originCell.x+(site.rotation===0?index:0),z:site.originCell.z+(site.rotation===90?index:0)}));
  const missingGates=geometry.layout.gates.filter(site=>!geometry.gateAt(site)),visibleGates=missingGates.filter(site=>seen(gateCells(site)));
  if(visibleGates.length){
    if(balance.resourceOrder.some(resource=>view.self.resources[resource]<buildings[gateType].cost[resource]))return wait('INSUFFICIENT_RESOURCES');
    const gate=visibleGates.find(site=>!occupied(gateCells(site)));
    if(!gate)return wait('SITE_OCCUPIED');
    return {status:'building',commands:[{kind:'build',builderIds:[worker.id],buildingType:gateType,originCell:gate.originCell,rotation:gate.rotation,queued:false}]};
  }
  const affordable=Math.min(balance.rules.maxWallSegmentsPerCommand,...balance.resourceOrder.filter(resource=>buildings[wallType].cost[resource]>0).map(resource=>Math.floor(view.self.resources[resource]/buildings[wallType].cost[resource])));
  if(affordable<=0)return wait('INSUFFICIENT_RESOURCES');
  let visibleWall=false;for(const edge of geometry.wallRuns){const run:Cell[]=[];for(const cell of edge){if(!seen([cell])){if(run.length)break;continue;}visibleWall=true;if(occupied([cell])){if(run.length)break;continue;}if(run.length){const prior=run.at(-1)!;if(Math.abs(prior.x-cell.x)+Math.abs(prior.z-cell.z)!==1)break;}run.push(cell);if(run.length===affordable)break;}if(run.length){const prefix=accessibleWallPrefix(view,worker,run,budget);return prefix.length?{status:'building',commands:[{kind:'build_wall',builderIds:[worker.id],material:goal.material,cells:prefix,queued:false}]}:wait(budget.remaining<=0?'VALIDATING_BUILD_ACCESS':'BUILD_ACCESS_BLOCKED');}}
  if(!visibleWall&&memory.screen){
    const scouting=memory.scouting&&workers.find(candidate=>candidate.id===memory.scouting!.workerId);
    if(scouting&&scouting.order==='move'&&scouting.taskState!=='blocked')return wait('SCOUTING_FORTIFICATION_SITE');
    // Reveal only remembered clear ground before spending. A worker move never
    // authorizes building in fog, and current admission still checks its route.
    const first=memory.screen.cells[0]!,last=memory.screen.cells.at(-1)!,horizontal=first.z===last.z;
    const center={xMm:(first.x+last.x+1)*grid/2,zMm:(first.z+last.z+1)*grid/2};
    const points=[-3000,3000].map(offset=>({xMm:center.xMm+(horizontal?0:offset),zMm:center.zMm+(horizontal?offset:0)})).sort((a,b)=>Math.hypot(a.xMm-worker.xMm,a.zMm-worker.zMm)-Math.hypot(b.xMm-worker.xMm,b.zMm-worker.zMm));
    const team=view.players.find(player=>player.id===view.playerId)?.teamId;
    const safe=(point:Position)=>!view.entities.some(entity=>entity.ownerId&&view.players.some(player=>player.id===entity.ownerId&&player.teamId!==team&&!player.defeated)&&(!entity.ghost||entity.kind==='building')&&(units[entity.typeId]?.attack??buildings[entity.typeId]?.attack??0)>0&&Math.hypot(point.xMm-entity.xMm,point.zMm-entity.zMm)<22000);
    const target=points.find(point=>safe(point)&&knownNav.free(point,units.villager.collisionRadiusM*1000));
    if(target)return {status:'building',commands:[{kind:'move',unitIds:[worker.id],target,queued:false}],reason:'SCOUTING_FORTIFICATION_SITE'};
  }
  return wait(visibleWall?'SITE_OCCUPIED':'SITE_NOT_EXPLORED');
}
