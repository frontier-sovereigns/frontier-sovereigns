import { balance, buildings, units, terrainBuildable, placementAreaDiscovered, type BuildingId, type Cell, type GameplayCommand, type Position, type ResourceBank, type Rotation } from '@frontier/shared';
import { Navigation, type NavigationWorkBudget, type Obstacle } from './navigation.js';
import type { UnitSpatialIndex } from './movement.js';
import type { Building, Entity, SimulationState, Unit } from './state.js';
import { contentPrerequisiteReason } from './progression.js';

const rules=balance.rules,grid=rules.buildingGridM*1000;
const gateUnitRadiusMm=Math.max(...Object.values(units).map(definition=>definition.collisionRadiusM*1000));
// This only bounds the optional broad phase. Unsupported geometry keeps the
// scalar gate rules, rather than entering an unbounded spatial bucket loop.
const gateQueryLimitMm=Math.max(...Object.values(buildings).filter(definition=>definition.defaultGateMode).map(definition=>Math.hypot(definition.footprintCells[0]!*grid/2,definition.footprintCells[1]!*grid/2)+Math.max(definition.autoOpenDistanceM!*1000,gateUnitRadiusMm)));
type WallCommand=Extract<GameplayCommand,{kind:'build_wall'|'replace_wall_with_gate'}>;
export interface FortificationSite {typeId:BuildingId;position:Position;rotation:Rotation;pending?:boolean}
export interface FortificationPlan {
  create:FortificationSite[];removeIds:string[];existingTargetIds:string[];cost:ResourceBank;
  assignments:{workerId:string;siteIndices:number[]}[];
}
export interface FortificationContext {
  state:SimulationState;
  visible:(playerId:string,point:Position)=>boolean;
  discovered?:(playerId:string,point:Position)=>boolean;
  /** Admission cannot inspect live occupancy in explored fog. */
  knownEntities?:readonly Entity[];
  bounds:(entity:Entity)=>{halfWidth:number;halfHeight:number};
  /** Additional AI construction spacing; never changes physical navigation. */
  clearanceMm?:number;
  /** Only the recipient's known obstacles, plus public terrain. */
  obstacles:Obstacle[];
  /** Shared across every site and builder in this recipient's admission slice. */
  workBudget?:NavigationWorkBudget;
  canApproach:(worker:Unit,proposed:Building,navigation:Navigation)=>Position[]|null;
}
const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
export function isGate(building:Pick<Building,'typeId'>):boolean{return Boolean(buildings[building.typeId].defaultGateMode);}
export function fortificationBounds(building:Pick<Building,'typeId'|'rotation'>):{halfWidth:number;halfHeight:number}{
  let [w,h]=buildings[building.typeId].footprintCells;if(building.rotation===90||building.rotation===270)[w,h]=[h,w];
  return {halfWidth:w*grid/2,halfHeight:h*grid/2};
}
/** Shared physical shape: neither alliances nor owner identity change an open passage. */
export function fortificationObstacles(building:Pick<Building,'id'|'typeId'|'ownerId'|'xMm'|'zMm'|'rotation'|'work'|'required'|'gateMode'|'gateOpen'>,planningFor?:string,hostile?:(a:string,b:string|null)=>boolean):Obstacle[]{
  const bounds=fortificationBounds(building),whole={id:building.id,xMm:building.xMm,zMm:building.zMm,...bounds};
  const def=buildings[building.typeId];
  const autoPassage=planningFor!==undefined&&hostile!==undefined&&!hostile(planningFor,building.ownerId)&&(building.gateMode??def.defaultGateMode)==='AUTO';
  if(!isGate(building)||building.work<building.required||(!building.gateOpen&&!autoPassage))return [whole];
  const halfPassage=def.gatePassageWidthM!*500,vertical=building.rotation===90||building.rotation===270;
  const longHalf=vertical?bounds.halfHeight:bounds.halfWidth,postHalf=(longHalf-halfPassage)/2,offset=halfPassage+postHalf;
  return [-1,1].map(sign=>({...whole,xMm:building.xMm+(vertical?0:sign*offset),zMm:building.zMm+(vertical?sign*offset:0),halfWidth:vertical?bounds.halfWidth:postHalf,halfHeight:vertical?postHalf:bounds.halfHeight}));
}
export function validWallPath(cells:Cell[]):boolean{
  if(!cells.length||cells.length>rules.maxWallSegmentsPerCommand)return false;
  const seen=new Set<string>();let previousAxis='',bends=0;
  for(let index=0;index<cells.length;index++){
    const cell=cells[index]!,key=`${cell.x},${cell.z}`;if(seen.has(key))return false;seen.add(key);
    if(index){const previous=cells[index-1]!,dx=cell.x-previous.x,dz=cell.z-previous.z;if(Math.abs(dx)+Math.abs(dz)!==1)return false;const axis=dx?'x':'z';if(previousAxis&&previousAxis!==axis)bends++;if(bends>1)return false;previousAxis=axis;}
  }
  return true;
}
function dummy(site:FortificationSite,id:string,ownerId:string):Building{
  const def=buildings[site.typeId];return {...site.position,id,ownerId,typeId:site.typeId,rotation:site.rotation,kind:'building',hp:1,maxHp:def.maxHp,work:0,required:def.buildSeconds*rules.simulationHz*100,grantedHp:1,queue:[],cooldown:0};
}
/** Pure admission: every site is checked before any entity, queue or bank changes. */
export function planFortification(ctx:FortificationContext,playerId:string,command:WallCommand):FortificationPlan|{error:string;cost?:ResourceBank}{
  const state=ctx.state,all=ctx.knownEntities??Object.values(state.entities),eco=state.economies[playerId];
  const workers=command.builderIds.map(id=>state.entities[id]);
  if(!workers.length||workers.some(worker=>worker?.kind!=='unit'||worker.ownerId!==playerId||worker.typeId!=='villager'||worker.garrisonedIn))return {error:'INVALID_BUILDER'};
  const builders=workers as Unit[],create:FortificationSite[]=[],removeIds:string[]=[],existingTargetIds:string[]=[];
  let typeId:BuildingId;
  if(command.kind==='build_wall'){
    if(!validWallPath(command.cells))return {error:'INVALID_WALL_PATH'};
    typeId=command.material==='palisade'?'palisade_wall':`${command.material}_wall` as BuildingId;
    for(const [index,cell]of command.cells.entries()){
      const position={xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid};
      const existing=all.find(e=>e.kind==='building'&&e.xMm===position.xMm&&e.zMm===position.zMm);
      if(existing?.kind==='building'&&existing.typeId===typeId&&existing.ownerId===playerId&&(index===0||index===command.cells.length-1)){
        if(existing.work<existing.required)existingTargetIds.push(existing.id);continue;
      }
      create.push({typeId,position,rotation:0});
    }
  }else{
    if(![3,5].includes(command.wallIds.length)||new Set(command.wallIds).size!==command.wallIds.length)return {error:'INVALID_GATE_REPLACEMENT'};
    const walls=command.wallIds.map(id=>state.entities[id]);
    if(walls.some(w=>!w||w.kind!=='building'||w.ownerId!==playerId||w.work<w.required||w.upgrade||!['palisade_wall','stone_wall','bastion_wall','runestone_wall','titan_wall','eternal_wall'].includes(w.typeId)))return {error:'INVALID_GATE_REPLACEMENT'};
    const selected=walls as Building[];
    if(selected.some(w=>w.typeId!==selected[0]!.typeId))return {error:'INVALID_GATE_REPLACEMENT'};
    const expansion=!['palisade_wall','stone_wall'].includes(selected[0]!.typeId);if(selected.length!==(expansion?5:3))return {error:'INVALID_GATE_REPLACEMENT'};
    const horizontal=selected.every(w=>w.zMm===selected[0]!.zMm),vertical=selected.every(w=>w.xMm===selected[0]!.xMm);
    if(!horizontal&&!vertical)return {error:'INVALID_GATE_REPLACEMENT'};
    selected.sort((a,b)=>horizontal?a.xMm-b.xMm:a.zMm-b.zMm);
    if(selected.slice(1).some((wall,index)=>distance(wall,selected[index]!)!==grid))return {error:'INVALID_GATE_REPLACEMENT'};
    typeId=selected[0]!.typeId==='palisade_wall'?'wooden_gate':selected[0]!.typeId.replace('_wall','_gate') as BuildingId;
    const center=selected[Math.floor(selected.length/2)]!;create.push({typeId,position:{xMm:center.xMm,zMm:center.zMm},rotation:horizontal?0:90});removeIds.push(...command.wallIds);
  }
  const def=buildings[typeId];if(!eco||eco.age<def.minAge)return {error:'AGE_REQUIRED'};
  const reason=contentPrerequisiteReason(state,playerId,typeId);if(reason)return {error:reason};
  const wallCells=all.reduce((sum,e)=>sum+(e.kind==='building'&&e.ownerId===playerId&&!removeIds.includes(e.id)?buildings[e.typeId].wallEquivalentCells??0:0),0);
  if(wallCells+create.length*(def.wallEquivalentCells??1)>rules.maxWallEquivalentCellsPerPlayer)return {error:'WALL_LIMIT'};
  const proposals=create.map((site,index)=>dummy(site,`proposal_${index}`,playerId));
  for(const [index,proposal]of proposals.entries()){
    const b=fortificationBounds(proposal),left=proposal.xMm-b.halfWidth,top=proposal.zMm-b.halfHeight,right=proposal.xMm+b.halfWidth,bottom=proposal.zMm+b.halfHeight;
    if(left<0||top<0||right>state.widthMm||bottom>state.heightMm)return {error:'OUT_OF_BOUNDS'};
    const rectangle={xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top},halo=Math.max(rules.treeBuildingClearanceM*1000,ctx.clearanceMm??0);
    if(!placementAreaDiscovered(rectangle,state.widthMm,state.heightMm,rules.fogGridM*1000,halo,(xMm,zMm)=>(ctx.discovered??ctx.visible)(playerId,{xMm,zMm}),state.map.terrain))return {error:'PLACEMENT_UNAVAILABLE'};
    if(!placementAreaDiscovered(rectangle,state.widthMm,state.heightMm,rules.fogGridM*1000,halo,(xMm,zMm)=>ctx.visible(playerId,{xMm,zMm}),state.map.terrain))create[index]!.pending=true;
    if(!terrainBuildable(state.map.terrain,{xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top}))return {error:'PLACEMENT_BLOCKED'};
    for(const entity of all){
      if(removeIds.includes(entity.id)||(entity.kind==='resource'&&entity.amount===0)||(entity.kind==='unit'&&entity.garrisonedIn))continue;
      const occupied=ctx.bounds(entity);
      if(entity.kind==='unit'){
        const dx=Math.max(left-entity.xMm,0,entity.xMm-right),dz=Math.max(top-entity.zMm,0,entity.zMm-bottom);
        if(dx*dx+dz*dz<occupied.halfWidth*occupied.halfWidth)return {error:'PLACEMENT_BLOCKED'};
      }else if(entity.xMm+occupied.halfWidth>left&&entity.xMm-occupied.halfWidth<right&&entity.zMm+occupied.halfHeight>top&&entity.zMm-occupied.halfHeight<bottom)return {error:'PLACEMENT_BLOCKED'};
    }
  }
  const cost={food:0,wood:0,gold:0,stone:0};for(const resource of balance.resourceOrder)cost[resource]=def.cost[resource]*create.length;
  // Cheap preflight bounds the work for unaffordable batches; index supplies the receipt deficit.
  if(balance.resourceOrder.some(resource=>eco.resources[resource]<cost[resource]*rules.resourceScale))return {error:'INSUFFICIENT_RESOURCES',cost};
  const nav=new Navigation(state.widthMm,state.heightMm,[...ctx.obstacles.filter(o=>!removeIds.includes(o.id)),...proposals.map(p=>({id:p.id,xMm:p.xMm,zMm:p.zMm,...fortificationBounds(p)}))],30000,1000,ctx.workBudget);
  const assignments=builders.map(worker=>({workerId:worker.id,siteIndices:[] as number[]}));
  for(const [index,proposal]of proposals.entries()){
    const candidates=[...builders].sort((a,b)=>distance(a,proposal)-distance(b,proposal)||a.id.localeCompare(b.id));
    const worker=candidates.find(candidate=>ctx.canApproach(candidate,proposal,nav));if(!worker)return {error:'NO_PATH'};
    assignments.find(assignment=>assignment.workerId===worker.id)!.siteIndices.push(index);
  }
  for(const assignment of assignments)if(!assignment.siteIndices.length&&(proposals.length||existingTargetIds.length)){
    const worker=state.entities[assignment.workerId] as Unit;
    const site=proposals.map((proposal,index)=>({proposal,index})).sort((a,b)=>distance(worker,a.proposal)-distance(worker,b.proposal)).find(({proposal})=>ctx.canApproach(worker,proposal,nav));
    if(site)assignment.siteIndices.push(site.index);
    else if(!existingTargetIds.some(id=>ctx.canApproach(worker,state.entities[id] as Building,nav)))return {error:'NO_PATH'};
  }
  for(const assignment of assignments){const worker=state.entities[assignment.workerId] as Unit;assignment.siteIndices.sort((a,b)=>distance(worker,create[a]!.position)-distance(worker,create[b]!.position)||a-b);}
  return {create,removeIds,existingTargetIds,cost,assignments};
}

/** Update physical openings before movement. Return changed regions for path invalidation. */
export function advanceGates(state:SimulationState,hostile:(a:string,b:string|null)=>boolean,all:readonly Entity[]=Object.values(state.entities),nearbyUnits?:UnitSpatialIndex,gateCandidates:readonly Entity[]=all):Obstacle[]{
  // The optional index is owned and reconciled by the simulation's gate phase.
  // Standalone/custom callers retain their original ordered scalar evaluation.
  let living=nearbyUnits?undefined:all.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn);
  const changed:Obstacle[]=[];
  // Native role membership omits only non-gates. Keep the full current world
  // for the scalar nearby fallback; gate state and body queries stay per tick.
  for(const gate of gateCandidates){
    if(gate.kind!=='building'||!isGate(gate))continue;
    const def=buildings[gate.typeId],bounds=fortificationBounds(gate),mode=gate.gateMode??def.defaultGateMode!;
    gate.gateMode=mode;
    const completed=gate.work>=gate.required,active=completed&&!state.economies[gate.ownerId]!.defeated;
    const evaluate=(some:(predicate:(unit:Unit)=>boolean)=>boolean)=>{
      const nearby=active&&some(unit=>!hostile(gate.ownerId,unit.ownerId)&&!state.economies[unit.ownerId]!.defeated&&Math.hypot(Math.max(0,Math.abs(unit.xMm-gate.xMm)-bounds.halfWidth),Math.max(0,Math.abs(unit.zMm-gate.zMm)-bounds.halfHeight))<=def.autoOpenDistanceM!*1000+units[unit.typeId].collisionRadiusM*1000);
      if(nearby)gate.gateCloseAfterTick=state.tick+Math.ceil(def.autoCloseDelaySeconds!*rules.simulationHz);
      let shouldOpen=Boolean(active&&(mode==='OPEN'||(mode==='AUTO'&&(nearby||(gate.gateOpen&&state.tick<(gate.gateCloseAfterTick??0))))));
      const vertical=gate.rotation===90||gate.rotation===270,passageHalf=def.gatePassageWidthM!*500;
      if(gate.gateOpen&&!shouldOpen&&some(unit=>{const radius=units[unit.typeId].collisionRadiusM*1000;return Math.abs(unit.xMm-gate.xMm)<(vertical?bounds.halfWidth:passageHalf)+radius&&Math.abs(unit.zMm-gate.zMm)<(vertical?passageHalf:bounds.halfHeight)+radius;}))shouldOpen=true;
      if(Boolean(gate.gateOpen)!==shouldOpen){gate.gateOpen=shouldOpen;changed.push({id:gate.id,xMm:gate.xMm,zMm:gate.zMm,...bounds});}
    };
    // The index adds each unit radius. Adding at least the maximum radius here
    // also covers corners of the anti-crush rectangle expanded on both axes.
    const reach=Math.hypot(bounds.halfWidth,bounds.halfHeight)+Math.max(def.autoOpenDistanceM!*1000,gateUnitRadiusMm);
    if(nearbyUnits&&Number.isSafeInteger(Math.trunc(gate.xMm))&&Number.isSafeInteger(Math.trunc(gate.zMm))&&Number.isFinite(reach)&&reach>=0&&reach<=gateQueryLimitMm){
      nearbyUnits.withNearby(gate,reach,bodies=>evaluate(predicate=>bodies.some(body=>{const unit=state.entities[body.id];return unit?.kind==='unit'&&unit.hp>0&&!unit.garrisonedIn&&predicate(unit);})));
    }else{
      living??=all.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn);
      evaluate(predicate=>living!.some(predicate));
    }
  }
  return changed;
}
