import { balance, buildings, units, wallTypeForMaterial, gateTypeForMaterial, isContentAllowed, sha256, terrainBuildable, terrainObstacles, placementAreaDiscovered, resourcePlacementBounds, type AiGoal, type Cell, type PlayerView, type Position, type ViewEntity } from '@frontier/shared';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from './navigation.js';
import { fortificationObstacles } from './fortifications.js';
import type { Building } from './state.js';
import { resourceWorkBounds } from './forest-navigation.js';
import { aiBuildingClearanceMm } from './ai-exploration.js';

export type FortifyGoal=Extract<AiGoal,{kind:'fortify'}>;
export interface FortifyGate {originCell:Cell;rotation:0|90;widthCells?:3|5}
export interface FortifyLayout {cells:Cell[];gates:FortifyGate[];origin:Position;signature:string}
/** A short defensive frontage with broad bypasses; one end may meet a mountain. */
export interface FortifyScreen {cells:Cell[];origin:Position;signature:string}
// Four gates reserve two adjacent grid rows on each side, up to five cells wide. Keep this
// reservation separate from the authoritative wall-equivalent construction cap.
export const fortifyPlanCellLimit=160;
export const fortifyPlacementCellLimit=fortifyPlanCellLimit+4*5*4;
export function fortifyPlacementCells(layout:FortifyLayout):Cell[]{
  const cells=layout.cells.slice(0,fortifyPlanCellLimit);
  for(const gate of layout.gates.slice(0,4))for(const side of [-2,-1,1,2])for(let along=0;along<(gate.widthCells??3);along++)cells.push({x:gate.originCell.x+(gate.rotation===0?along:side),z:gate.originCell.z+(gate.rotation===90?along:side)});
  return cells;
}
export interface FortifyGeometryMemory {layout?:FortifyLayout;screen?:FortifyScreen;layoutCommitted?:true;layoutKey?:string;blockedGeometry?:{key:string;reason:string}}
export interface FortifyGeometry {status:'ready';layout:FortifyLayout;anchorFaces:Position[];wallRuns:Cell[][];walls:Cell[];matchedIds:Set<string>;wallAt:(cell:Cell)=>ViewEntity|undefined;gateAt:(gate:FortifyGate)=>ViewEntity|undefined;knownObstacles:Obstacle[];proposedObstacles:Obstacle[]}
export type FortifyGeometryResult=FortifyGeometry|{status:'blocked'|'waiting';reason:string};
const grid=balance.rules.buildingGridM*1000,key=(cell:Cell)=>`${cell.x},${cell.z}`;
export function fortifyViewObstacle(entity:ViewEntity):Obstacle{
  if(entity.kind==='building'){let[w,h]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];return {id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth:w*grid/2,halfHeight:h*grid/2};}
  return {id:entity.id,xMm:entity.xMm,zMm:entity.zMm,...resourceWorkBounds(entity)};
}
export function insideFortifyLayout(cells:readonly Cell[],point:Position):boolean{
  const x=point.xMm/grid-.5,z=point.zMm/grid-.5;let inside=false;
  for(let i=0,j=cells.length-1;i<cells.length;j=i++){const a=cells[i]!,b=cells[j]!;if((a.z>z)!==(b.z>z)&&x<(b.x-a.x)*(z-a.z)/(b.z-a.z)+a.x)inside=!inside;}
  return inside;
}
export function fortifyLayoutSignature(cells:Cell[],gates:FortifyGate[]):string{return sha256(JSON.stringify({cells,gates}));}
export function compatibleFortification(actual:string,target:string):boolean {
  if(actual===target)return true;
  const a=buildings[actual],b=buildings[target];if(!a||!b||a.footprintCells.some((n,i)=>n!==b.footprintCells[i]))return false;
  const reaches=(from:string,to:string):boolean=>{let current=buildings[from];for(let n=0;n<8&&current?.upgradeFrom;n++){if(current.upgradeFrom===to)return true;current=buildings[current.upgradeFrom];}return false;};
  return reaches(actual,target)||reaches(target,actual);
}
export function matchesFortifyLayoutEntity(layout:FortifyLayout,material:FortifyGoal['material'],entity:ViewEntity):boolean{
  if(entity.kind!=='building')return false;
  const wall=wallTypeForMaterial(material),gate=gateTypeForMaterial(material);
  if(compatibleFortification(entity.typeId,gate))return layout.gates.some(site=>(entity.rotation??0)===site.rotation&&entity.xMm===(site.originCell.x+(site.rotation===0?(site.widthCells??3)/2:.5))*grid&&entity.zMm===(site.originCell.z+(site.rotation===90?(site.widthCells??3)/2:.5))*grid);
  if(!compatibleFortification(entity.typeId,wall))return false;
  const cell={x:entity.xMm/grid-.5,z:entity.zMm/grid-.5};
  return layout.cells.some(candidate=>key(candidate)===key(cell))&&!layout.gates.some(site=>Array.from({length:site.widthCells??3},(_,index)=>({x:site.originCell.x+(site.rotation===0?index:0),z:site.originCell.z+(site.rotation===90?index:0)})).some(candidate=>key(candidate)===key(cell)));
}
export function matchesFortifyScreenEntity(screen:FortifyScreen,material:FortifyGoal['material'],entity:ViewEntity):boolean{
  return entity.kind==='building'&&compatibleFortification(entity.typeId,wallTypeForMaterial(material))&&screen.cells.some(cell=>entity.xMm===(cell.x+.5)*grid&&entity.zMm===(cell.z+.5)*grid);
}
export function validFortifyScreen(screen:FortifyScreen):boolean{
  const cells=screen.cells;if(cells.length!==6||new Set(cells.map(key)).size!==6)return false;
  const dx=cells[1]!.x-cells[0]!.x,dz=cells[1]!.z-cells[0]!.z;
  return Math.abs(dx)+Math.abs(dz)===1&&cells.every((cell,index)=>Number.isInteger(cell.x)&&Number.isInteger(cell.z)&&cell.x>=0&&cell.z>=0&&cell.x===cells[0]!.x+dx*index&&cell.z===cells[0]!.z+dz*index)&&screen.signature===fortifyLayoutSignature(cells,[]);
}
/** Reserve 12m-wide open lanes beside both wall ends, extending 12m each side. */
export function fortifyScreenPlacementCells(screen:FortifyScreen):Cell[]{
  const horizontal=screen.cells[0]!.z===screen.cells[1]!.z,minX=Math.min(...screen.cells.map(cell=>cell.x)),minZ=Math.min(...screen.cells.map(cell=>cell.z)),cells=screen.cells.slice();
  for(const along of [-6,-5,-4,-3,-2,-1,6,7,8,9,10,11])for(let across=-6;across<=6;across++)cells.push({x:minX+(horizontal?along:across),z:minZ+(horizontal?across:along)});
  return cells;
}

/** A crowded settlement need not admit a complete ring to have useful defense.
 * This optional short frontage uses only known geometry, never seals a passage,
 * and still passes the planner's ordinary resource/build-access proofs. A rock
 * face may close one end when the other end retains its full 12m bypass. */
export function resolveFortifyScreen(view:PlayerView,goal:FortifyGoal,memory:FortifyGeometryMemory,budget:NavigationWorkBudget):FortifyGeometryResult{
  const own=view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),anchor=own.find(entity=>entity.id===goal.anchorRef&&entity.kind==='building');
  if(!anchor)return {status:'blocked',reason:'INVALID_ANCHOR'};
  const wallType=wallTypeForMaterial(goal.material);if(!isContentAllowed(wallType,view.rulesetId,view.maxAge)||view.self.age<buildings[wallType].minAge)return {status:'blocked',reason:'AGE_REQUIRED'};
  if(buildings[wallType].requiredTechnologies?.some(id=>!view.self.technologies?.includes(id)))return {status:'blocked',reason:'TECHNOLOGY_REQUIRED'};
  const staticEntities=view.entities.filter(entity=>entity.kind!=='unit'&&!(entity.kind==='resource'&&(entity.amount??0)<=0)),terrain=terrainObstacles(view.map.terrain??[]),staticObstacles=staticEntities.map(fortifyViewObstacle),explored=new Set(view.fog.explored),fogWidth=view.map.widthMm/view.map.fogCellMm;
  const mountains=terrainObstacles((view.map.terrain??[]).filter(region=>region.kind==='ridge'||region.kind==='cliff'||region.kind==='ramp')),mountainIds=new Set(mountains.map(obstacle=>obstacle.id));
  const observed=(cell:Cell,mask:ReadonlySet<number>,halo=0)=>placementAreaDiscovered({xMm:cell.x*grid,zMm:cell.z*grid,widthMm:grid,depthMm:grid},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,halo,(x,z)=>mask.has(Math.floor(z/view.map.fogCellMm)*fogWidth+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]);
  const knowledgeKey=sha256(JSON.stringify({screen:true,goal,anchor:{x:anchor.xMm,z:anchor.zMm},map:view.map,explored:view.fog.explored,age:view.self.age,static:staticEntities.map((entity,index)=>({shape:staticObstacles[index],type:entity.typeId,owner:entity.ownerId,rotation:entity.rotation}))}));
  if(memory.blockedGeometry?.key===knowledgeKey)return {status:'blocked',reason:memory.blockedGeometry.reason};
  const blocked=(reason:string):FortifyGeometryResult=>{memory.blockedGeometry={key:knowledgeKey,reason};return {status:'blocked',reason};};
  const wallAt=(cell:Cell)=>own.find(entity=>entity.kind==='building'&&compatibleFortification(entity.typeId,wallType)&&entity.xMm===(cell.x+.5)*grid&&entity.zMm===(cell.z+.5)*grid);
  const matched=(screen:FortifyScreen)=>new Set(screen.cells.map(wallAt).filter((entity):entity is ViewEntity=>Boolean(entity)).map(entity=>entity.id));
  const anchorBox=fortifyViewObstacle(anchor),anchorFaces=[{xMm:anchor.xMm-anchorBox.halfWidth-900,zMm:anchor.zMm},{xMm:anchor.xMm+anchorBox.halfWidth+900,zMm:anchor.zMm},{xMm:anchor.xMm,zMm:anchor.zMm-anchorBox.halfHeight-900},{xMm:anchor.xMm,zMm:anchor.zMm+anchorBox.halfHeight+900}];
  let unbuiltKnown:Obstacle[]|undefined,unbuiltNavigation:Navigation|undefined,unbuiltPlacement:Navigation|undefined;
  const evaluate=(screen:FortifyScreen):{origin:Position;ids:Set<string>;known:Obstacle[]}|undefined=>{
    const ids=matched(screen),other=own.reduce((sum,entity)=>sum+(entity.kind==='building'&&!ids.has(entity.id)?buildings[entity.typeId].wallEquivalentCells??0:0),0);
    if(screen.cells.length+other>balance.rules.maxWallEquivalentCellsPerPlayer)return;
    const known=ids.size?[...terrain,...staticObstacles.filter(obstacle=>!ids.has(obstacle.id))]:(unbuiltKnown??=[...terrain,...staticObstacles]),nav=ids.size?new Navigation(view.map.widthMm,view.map.heightMm,known,30000,1000,budget):(unbuiltNavigation??=new Navigation(view.map.widthMm,view.map.heightMm,known,30000,1000,budget));
    // The exact buildable rectangle below checks mountain overlap. Its legal
    // face contact must not be rejected by this conservative enclosing circle.
    const placementNavigation=()=>new Navigation(view.map.widthMm,view.map.heightMm,[...terrain.filter(obstacle=>!mountainIds.has(obstacle.id)),...staticEntities.flatMap((entity,index)=>ids.has(entity.id)?[]:[entity.kind==='resource'?{...staticObstacles[index]!,...resourcePlacementBounds(entity,balance.rules.treeBuildingClearanceM*1000)}:buildings[entity.typeId].wallEquivalentCells?staticObstacles[index]!:{...staticObstacles[index]!,halfWidth:staticObstacles[index]!.halfWidth+aiBuildingClearanceMm,halfHeight:staticObstacles[index]!.halfHeight+aiBuildingClearanceMm}])],30000,1000,budget);
    const placement=ids.size?placementNavigation():(unbuiltPlacement??=placementNavigation());
    if(screen.cells.some(cell=>!observed(cell,explored,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm))||!terrainBuildable(view.map.terrain??[],{xMm:cell.x*grid,zMm:cell.z*grid,widthMm:grid,depthMm:grid})||!placement.free({xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid},Math.SQRT2*grid/2)))return;
    const horizontal=screen.cells[0]!.z===screen.cells[1]!.z,minX=Math.min(...screen.cells.map(cell=>cell.x))*grid,minZ=Math.min(...screen.cells.map(cell=>cell.z))*grid;
    const minAlong=horizontal?minX:minZ,minAcross=horizontal?minZ:minX;
    const mountainEnd=(end:'start'|'finish')=>mountains.some(obstacle=>{
      const along=horizontal?obstacle.xMm:obstacle.zMm,across=horizontal?obstacle.zMm:obstacle.xMm,halfAlong=horizontal?obstacle.halfWidth:obstacle.halfHeight,halfAcross=horizontal?obstacle.halfHeight:obstacle.halfWidth;
      return (end==='start'?along+halfAlong===minAlong:along-halfAlong===minAlong+6*grid)&&across-halfAcross<=minAcross&&across+halfAcross>=minAcross+grid;
    });
    const startAnchored=mountainEnd('start'),finishAnchored=mountainEnd('finish');
    if(startAnchored&&finishAnchored)return;
    if(fortifyScreenPlacementCells(screen).some(cell=>{
      const along=(horizontal?cell.x:cell.z)*grid;
      return !(startAnchored&&along<minAlong||finishAnchored&&along>=minAlong+6*grid)&&!observed(cell,explored);
    }))return;
    // A 6m-radius swept disk proves a 12m-wide bypass. These strips never become
    // gates; ordinary construction preference keeps future buildings off them.
    for(const along of [...(startAnchored?[]:[-6000]),...(finishAnchored?[]:[18000])]){const center={xMm:minX+(horizontal?along:grid/2),zMm:minZ+(horizontal?grid/2:along)},from={xMm:center.xMm-(horizontal?0:7000),zMm:center.zMm-(horizontal?7000:0)},to={xMm:center.xMm+(horizontal?0:7000),zMm:center.zMm+(horizontal?7000:0)};if(!nav.clearLine(from,to,6000))return;}
    // A clear loop around the new segment proves every route crossing its
    // footprint can detour locally. Unlike resource-by-resource A*, this proof
    // cannot restart indefinitely when distant mines or trees change.
    const corners=startAnchored?[[1000,-1000],[13000,-1000],[13000,3000],[1000,3000]]:finishAnchored?[[11000,-1000],[-1000,-1000],[-1000,3000],[11000,3000]]:[[-1000,-1000],[13000,-1000],[13000,3000],[-1000,3000]];
    const loop=corners.map(([along,across])=>({xMm:horizontal?minAlong+along!:minAcross+across!,zMm:horizontal?minAcross+across!:minAlong+along!}));
    if(loop.some((point,index)=>(index<loop.length-1||!startAnchored&&!finishAnchored)&&!nav.clearLine(point,loop[(index+1)%loop.length]!,350)))return;
    const origin=anchorFaces.find(face=>nav.free(face,350));return origin?{origin,ids,known}:undefined;
  };
  let selected=memory.screen,proof:ReturnType<typeof evaluate>;
  try{
    if(selected){if(!validFortifyScreen(selected))return blocked('INVALID_SCREEN');proof=evaluate(selected);if(!proof){if(memory.layoutCommitted||matched(selected).size)return blocked('SCREEN_ACCESS_BLOCKED');selected=undefined;}}
    if(!selected){
      const team=view.players.find(player=>player.id===view.playerId)?.teamId,enemies=view.entities.filter(entity=>{
        if(!entity.ownerId||entity.hp<=0)return false;const owner=view.players.find(player=>player.id===entity.ownerId);if(!owner||owner.teamId===team||owner.defeated)return false;
        const armed=entity.kind==='unit'?!entity.ghost&&!entity.garrisonedIn&&!units[entity.typeId]?.tags.includes('worker')&&(units[entity.typeId]?.attack??0)>0:entity.kind==='building'&&(entity.progress??1)===1&&(buildings[entity.typeId]?.attack??0)>0;
        return armed&&(!entity.ghost||entity.lastSeenTick!==undefined&&entity.lastSeenTick<=view.tick&&view.tick-entity.lastSeenTick<=120*balance.rules.simulationHz);
      }),target=enemies.sort((a,b)=>Math.hypot(a.xMm-anchor.xMm,a.zMm-anchor.zMm)-Math.hypot(b.xMm-anchor.xMm,b.zMm-anchor.zMm)||a.id.localeCompare(b.id))[0]??{xMm:view.map.widthMm/2,zMm:view.map.heightMm/2},dx=target.xMm-anchor.xMm,dz=target.zMm-anchor.zMm;
      const directions=[{x:0,z:-1},{x:1,z:0},{x:0,z:1},{x:-1,z:0}].sort((a,b)=>(b.x*dx+b.z*dz)-(a.x*dx+a.z*dz));
      // Try at most32 public mountain faces near this settlement. A natural
      // anchor is useful only on the threat-facing side, and evaluate still
      // proves the opposite broad bypass and every remembered obstacle.
      const nearbyMountains=mountains.filter(obstacle=>Math.hypot(obstacle.xMm-anchor.xMm,obstacle.zMm-anchor.zMm)<80000).sort((a,b)=>Math.hypot(a.xMm-anchor.xMm,a.zMm-anchor.zMm)-Math.hypot(b.xMm-anchor.xMm,b.zMm-anchor.zMm)||a.id.localeCompare(b.id)).slice(0,8);
      for(const mountain of nearbyMountains){
        const left=mountain.xMm-mountain.halfWidth,right=mountain.xMm+mountain.halfWidth,top=mountain.zMm-mountain.halfHeight,bottom=mountain.zMm+mountain.halfHeight;
        const row=Math.floor(Math.max(top,Math.min(bottom-grid,anchor.zMm))/grid),column=Math.floor(Math.max(left,Math.min(right-grid,anchor.xMm))/grid);
        for(const site of [{x:left/grid-6,z:row,horizontal:true},{x:right/grid,z:row,horizontal:true},{x:column,z:top/grid-6,horizontal:false},{x:column,z:bottom/grid,horizontal:false}]){
          if(!Number.isInteger(site.x)||!Number.isInteger(site.z)||site.x<0||site.z<0)continue;
          const center={xMm:(site.x+(site.horizontal?3:.5))*grid,zMm:(site.z+(site.horizontal?.5:3))*grid},ax=center.xMm-anchor.xMm,az=center.zMm-anchor.zMm;
          if(Math.hypot(ax,az)>60000||ax*dx+az*dz<0)continue;
          const cells=Array.from({length:6},(_,index)=>({x:site.x+(site.horizontal?index:0),z:site.z+(site.horizontal?0:index)})),candidate={cells,origin:{xMm:anchor.xMm,zMm:anchor.zMm},signature:fortifyLayoutSignature(cells,[])};
          proof=evaluate(candidate);if(proof){selected=candidate;break;}
        }
        if(selected)break;
      }
      // Cover the ground between the former sparse samples, including wider
      // lateral approaches around a mature town. The shared work budget bounds
      // every geometry query; hidden sites can only become scouting proposals.
      for(const direction of selected?[]:directions){for(const [offset,lateral] of [6,8,10,12,14,16,18,20,22,24,26,28,30].flatMap(offset=>[0,-6,6,-12,12,-18,18].map(lateral=>[offset,lateral] as const))){
        const horizontal=direction.z!==0,cx=Math.floor(anchor.xMm/grid)+direction.x*offset+(horizontal?lateral:0),cz=Math.floor(anchor.zMm/grid)+direction.z*offset+(horizontal?0:lateral),cells=Array.from({length:6},(_,index)=>({x:cx+(horizontal?index-3:0),z:cz+(horizontal?0:index-3)})),candidate={cells,origin:{xMm:anchor.xMm,zMm:anchor.zMm},signature:fortifyLayoutSignature(cells,[])};
        if(cells.some(cell=>cell.x<0||cell.z<0))continue;proof=evaluate(candidate);if(proof){selected=candidate;break;}
      }if(selected)break;}
      if(!selected||!proof)return blocked('SCREEN_NO_LEGAL_SITE');
    }
  }catch(error){if(!(error instanceof PathBudgetExceededError))throw error;return {status:'waiting',reason:'VALIDATING_FORTIFICATION_LAYOUT'};}
  const {origin,ids:matchedIds,known:knownObstacles}=proof!;selected={...selected,origin:{...origin}};memory.screen=selected;delete memory.layout;memory.layoutKey=knowledgeKey;delete memory.blockedGeometry;if(matchedIds.size)memory.layoutCommitted=true;
  const walls=selected.cells,proposedObstacles=walls.map(cell=>({id:`planned_${key(cell)}`,xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid,halfWidth:grid/2,halfHeight:grid/2})),wallRuns:Cell[][]=[];let run:Cell[]=[];
  for(const cell of walls){if(wallAt(cell)){if(run.length)wallRuns.push(run);run=[];}else run.push(cell);}if(run.length)wallRuns.push(run);
  return {status:'ready',layout:{...selected,gates:[]},anchorFaces,wallRuns,walls,matchedIds,wallAt,gateAt:()=>undefined,knownObstacles,proposedObstacles};
}
/** Saved geometry must be a simple lattice cycle with four disjoint straight gates. */
export function validFortifyLayout(layout:FortifyLayout):boolean{
  const {cells,gates}=layout;if(cells.length<16||cells.length>fortifyPlanCellLimit||gates.length!==4||new Set(cells.map(key)).size!==cells.length)return false;
  if(cells.some((cell,index)=>{const next=cells[(index+1)%cells.length]!;return Math.abs(cell.x-next.x)+Math.abs(cell.z-next.z)!==1;}))return false;
  const used=new Set<string>();
  for(const gate of gates){if(gate.widthCells!==undefined&&gate.widthCells!==3&&gate.widthCells!==5)return false;const selected=Array.from({length:gate.widthCells??3},(_,index)=>({x:gate.originCell.x+(gate.rotation===0?index:0),z:gate.originCell.z+(gate.rotation===90?index:0)}));
    for(let index=1;index<selected.length-1;index++){
      const center=cells.findIndex(cell=>key(cell)===key(selected[index]!));if(center<0)return false;
      const adjacent=[cells[(center+cells.length-1)%cells.length]!,cells[(center+1)%cells.length]!].map(key).sort();
      if(adjacent.join('|')!==[key(selected[index-1]!),key(selected[index+1]!)].sort().join('|'))return false;
    }
    for(const cell of selected){if(used.has(key(cell)))return false;used.add(key(cell));}
  }
  return insideFortifyLayout(cells,layout.origin)&&fortifyLayoutSignature(cells,gates)===layout.signature;
}

/** Only recipient-authorized static geometry participates in layout selection. */
export function resolveFortifyGeometry(view:PlayerView,goal:FortifyGoal,memory:FortifyGeometryMemory,budget:NavigationWorkBudget):FortifyGeometryResult{
  const own=view.entities.filter(entity=>entity.ownerId===view.playerId&&!entity.ghost),anchor=own.find(entity=>entity.id===goal.anchorRef&&entity.kind==='building');
  if(!anchor)return {status:'blocked',reason:'INVALID_ANCHOR'};
  if(!Number.isInteger(goal.radiusM)||goal.radiusM<18||goal.radiusM>60)return {status:'blocked',reason:'INVALID_RADIUS'};
  const wallType=wallTypeForMaterial(goal.material),gateType=gateTypeForMaterial(goal.material);
  if(!isContentAllowed(wallType,view.rulesetId,view.maxAge)||view.self.age<buildings[wallType].minAge)return {status:'blocked',reason:'AGE_REQUIRED'};
  if(buildings[wallType].requiredTechnologies?.some(id=>!view.self.technologies?.includes(id)))return {status:'blocked',reason:'TECHNOLOGY_REQUIRED'};
  const width=buildings[gateType].footprintCells[0] as 3|5,half=Math.floor(width/2),widthMetadata=width===5?{widthCells:5 as const}:{};
  const radius=Math.ceil(goal.radiusM/balance.rules.buildingGridM),inner=radius-3,outer=radius+3;
  if(inner*8>fortifyPlanCellLimit)return {status:'blocked',reason:'GEOMETRY_WORK_LIMIT'};
  const staticEntities=view.entities.filter(entity=>entity.kind!=='unit'&&!(entity.kind==='resource'&&(entity.amount??0)<=0));
  const staticObstacles=staticEntities.map(fortifyViewObstacle),placementObstacles=staticEntities.map((entity,index)=>entity.kind==='resource'?{...staticObstacles[index]!,...resourcePlacementBounds(entity,balance.rules.treeBuildingClearanceM*1000)}:buildings[entity.typeId].wallEquivalentCells?staticObstacles[index]!:{...staticObstacles[index]!,halfWidth:staticObstacles[index]!.halfWidth+aiBuildingClearanceMm,halfHeight:staticObstacles[index]!.halfHeight+aiBuildingClearanceMm}),terrain=terrainObstacles(view.map.terrain??[]),explored=new Set(view.fog.explored),fogWidth=view.map.widthMm/view.map.fogCellMm;
  const observedCell=(cell:Cell,mask:ReadonlySet<number>)=>placementAreaDiscovered({xMm:cell.x*grid,zMm:cell.z*grid,widthMm:grid,depthMm:grid},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),(x,z)=>mask.has(Math.floor(z/view.map.fogCellMm)*fogWidth+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]);
  const layoutExplored=memory.layout?.cells.every(cell=>observedCell(cell,explored))??true;
  const knowledgeKey=sha256(JSON.stringify({goal,anchor:{x:anchor.xMm,z:anchor.zMm,rotation:anchor.rotation},map:view.map,explored:view.fog.explored,layoutExplored,age:view.self.age,static:staticEntities.map((entity,index)=>({shape:staticObstacles[index],type:entity.typeId,owner:entity.ownerId,rotation:entity.rotation}))}));
  if(memory.blockedGeometry?.key===knowledgeKey)return {status:'blocked',reason:memory.blockedGeometry.reason};
  const blocked=(reason:string):FortifyGeometryResult=>{memory.blockedGeometry={key:knowledgeKey,reason};return {status:'blocked',reason};};
  const wallAt=(cell:Cell)=>own.find(entity=>entity.kind==='building'&&compatibleFortification(entity.typeId,wallType)&&entity.xMm===(cell.x+.5)*grid&&entity.zMm===(cell.z+.5)*grid);
  const gateAt=(site:FortifyGate)=>own.find(entity=>entity.kind==='building'&&compatibleFortification(entity.typeId,gateType)&&(entity.rotation??0)===site.rotation&&entity.xMm===(site.originCell.x+(site.rotation===0?(site.widthCells??3)/2:.5))*grid&&entity.zMm===(site.originCell.z+(site.rotation===90?(site.widthCells??3)/2:.5))*grid);
  const openings=(gates:FortifyGate[])=>new Set(gates.flatMap(gate=>Array.from({length:gate.widthCells??3},(_,index)=>key({x:gate.originCell.x+(gate.rotation===0?index:0),z:gate.originCell.z+(gate.rotation===90?index:0)}))));
  const matches=(cells:Cell[],gates:FortifyGate[])=>{const holes=openings(gates);return new Set([...cells.filter(cell=>!holes.has(key(cell))).map(wallAt),...gates.map(gateAt)].filter((entity):entity is ViewEntity=>Boolean(entity)).map(entity=>entity.id));};
  function cellFailure(cell:Cell,matched:ReadonlySet<string>):string|undefined{
    const x=cell.x*grid,z=cell.z*grid;
    if(x<0||z<0||x+grid>view.map.widthMm||z+grid>view.map.heightMm)return 'OUT_OF_BOUNDS';
    if(!observedCell(cell,explored))return 'RING_NOT_EXPLORED';
    if(!terrainBuildable(view.map.terrain??[],{xMm:x,zMm:z,widthMm:grid,depthMm:grid}))return 'TERRAIN_BLOCKED';
    if(placementObstacles.some(obstacle=>!matched.has(obstacle.id)&&obstacle.xMm+obstacle.halfWidth>x&&obstacle.xMm-obstacle.halfWidth<x+grid&&obstacle.zMm+obstacle.halfHeight>z&&obstacle.zMm-obstacle.halfHeight<z+grid))return 'RING_OCCUPIED';
  }
  function shapeFailure(cells:Cell[],gates:FortifyGate[]):string|undefined{
    const matched=matches(cells,gates),other=own.reduce((sum,entity)=>sum+(entity.kind==='building'&&!matched.has(entity.id)?buildings[entity.typeId].wallEquivalentCells??0:0),0);
    if(cells.length+other>balance.rules.maxWallEquivalentCellsPerPlayer)return 'WALL_LIMIT';
    const b=fortifyViewObstacle(anchor!);if(![-1,1].every(x=>[-1,1].every(z=>insideFortifyLayout(cells,{xMm:anchor!.xMm+x*b.halfWidth,zMm:anchor!.zMm+z*b.halfHeight}))))return 'INVALID_ENCLOSURE';
    return cells.map(cell=>cellFailure(cell,matched)).find(Boolean);
  }
  let selected=memory.layout;
  if(selected){
    if(!validFortifyLayout(selected))return blocked('INVALID_LAYOUT');
    if(matches(selected.cells,selected.gates).size)memory.layoutCommitted=true;
    // Explored layouts remain usable when workers move away. Every later
    // purchase rechecks the known footprint without inspecting hidden state.
    if(memory.layoutKey!==knowledgeKey){const failure=shapeFailure(selected.cells,selected.gates);if(failure){if(memory.layoutCommitted)return blocked(failure);selected=undefined;}}
  }
  if(!selected){
    const cx=Math.floor(anchor.xMm/grid),cz=Math.floor(anchor.zMm/grid),cells:Cell[]=[];
    for(let x=cx-radius;x<=cx+radius;x++)cells.push({x,z:cz-radius});for(let z=cz-radius+1;z<=cz+radius;z++)cells.push({x:cx+radius,z});
    for(let x=cx+radius-1;x>=cx-radius;x--)cells.push({x,z:cz+radius});for(let z=cz+radius-1;z>cz-radius;z--)cells.push({x:cx-radius,z});
    const gates:FortifyGate[]=[{originCell:{x:cx-half,z:cz-radius},rotation:0,...widthMetadata},{originCell:{x:cx-half,z:cz+radius},rotation:0,...widthMetadata},{originCell:{x:cx-radius,z:cz-half},rotation:90,...widthMetadata},{originCell:{x:cx+radius,z:cz-half},rotation:90,...widthMetadata}];
    const firstFailure=shapeFailure(cells,gates);
    if(!firstFailure)selected={cells,gates,origin:{xMm:anchor.xMm,zMm:anchor.zMm},signature:fortifyLayoutSignature(cells,gates)};
    else{
      // At most1,288 annulus cells (larger radii cannot fit160 wall-equivalent
      // cells), seven ray crossings, and50k charged graph-neighbor visits.
      const graph:Cell[]=[],indices=new Map<string,number>(),allowed:boolean[]=[];
      for(let z=cz-outer;z<=cz+outer;z++)for(let x=cx-outer;x<=cx+outer;x++)if(Math.max(Math.abs(x-cx),Math.abs(z-cz))>=inner){indices.set(key({x,z}),graph.length);graph.push({x,z});allowed.push(!cellFailure({x,z},new Set()));}
      if(graph.length>1288)return blocked('GEOMETRY_WORK_LIMIT');
      let work=0;const neighbors=graph.map(cell=>[[0,-1],[-1,0],[1,0],[0,1]].map(([dx,dz])=>indices.get(key({x:cell.x+dx!,z:cell.z+dz!}))).filter((index):index is number=>index!==undefined));
      for(let crossing=inner;crossing<=outer&&!selected;crossing++){
        const start=indices.get(key({x:cx+crossing,z:cz-1}))!,end=indices.get(key({x:cx+crossing,z:cz}))!;if(!allowed[start]||!allowed[end])continue;
        const distance=Array(graph.length).fill(Infinity) as number[],parents=Array(graph.length).fill(-1) as number[],closed=new Uint8Array(graph.length),heap:{id:number;score:number}[]=[];
        const less=(a:{id:number;score:number},b:{id:number;score:number})=>a.score<b.score||a.score===b.score&&a.id<b.id;
        const push=(item:{id:number;score:number})=>{let at=heap.length;heap.push(item);while(at){const parent=(at-1)>>1;if(!less(item,heap[parent]!))break;heap[at]=heap[parent]!;at=parent;}heap[at]=item;};
        const pop=()=>{const result=heap[0]!,tail=heap.pop()!;if(heap.length){let at=0;while(at*2+1<heap.length){let child=at*2+1;if(child+1<heap.length&&less(heap[child+1]!,heap[child]!))child++;if(!less(heap[child]!,tail))break;heap[at]=heap[child]!;at=child;}heap[at]=tail;}return result;};
        distance[start]=0;push({id:start,score:0});let found=false;
        while(heap.length){const current=pop();if(closed[current.id]||distance[current.id]!==current.score)continue;closed[current.id]=1;if(current.id===end){found=true;break;}
          for(const next of neighbors[current.id]!){if(work>=50000)return blocked('GEOMETRY_WORK_LIMIT');if(budget.remaining<=0)return {status:'waiting',reason:'VALIDATING_FORTIFICATION_LAYOUT'};work++;budget.used++;budget.remaining--;const a=graph[current.id]!,b=graph[next]!;
            if(!allowed[next]||closed[next]||a.x===b.x&&a.x>=cx+inner&&Math.min(a.z,b.z)===cz-1&&Math.max(a.z,b.z)===cz)continue;
            const score=current.score+100+10*Math.abs(Math.max(Math.abs(b.x-cx),Math.abs(b.z-cz))-radius);if(score>=distance[next]!)continue;distance[next]=score;parents[next]=current.id;push({id:next,score});
          }
        }
        if(!found)continue;const cycle:Cell[]=[];for(let index=end;index!==-1;index=parents[index]!)cycle.push(graph[index]!);cycle.reverse();if(cycle.length>fortifyPlanCellLimit)continue;
        const sites:Array<Array<FortifyGate&{offset:number;landing:number}>>=[[],[],[],[]],occupied=new Set(cycle.map(key));
        for(let i=0;i<cycle.length;i++){const at=(offset:number)=>cycle[(i+offset+cycle.length)%cycle.length]!,cell=at(0),dx=at(1).x-cell.x,dz=at(1).z-cell.z;
          if(Array.from({length:width+1},(_,index)=>index-half-1).some(offset=>at(offset+1).x-at(offset).x!==dx||at(offset+1).z-at(offset).z!==dz))continue;
          const quadrant=dx&&Math.abs(cell.x-cx)<=3?(cell.z<=cz-inner?0:cell.z>=cz+inner?2:-1):dz&&Math.abs(cell.z-cz)<=3?(cell.x>=cx+inner?1:cell.x<=cx-inner?3:-1):-1;
          if(quadrant<0)continue;
          const landing=[-2,-1,1,2].filter(step=>{const x=cell.x+(dz?step:0),z=cell.z+(dx?step:0),px=(x+.5)*grid,pz=(z+.5)*grid;if(occupied.has(key({x,z}))||px<350||pz<350||px>view.map.widthMm-350||pz>view.map.heightMm-350||!explored.has(Math.floor(pz/view.map.fogCellMm)*fogWidth+Math.floor(px/view.map.fogCellMm)))return false;
            return ![...terrain,...staticObstacles].some(obstacle=>{const ox=Math.max(0,Math.abs(px-obstacle.xMm)-obstacle.halfWidth),oz=Math.max(0,Math.abs(pz-obstacle.zMm)-obstacle.halfHeight);return ox*ox+oz*oz<350*350;});}).length;
          sites[quadrant]!.push({originCell:{x:cell.x-(dx?half:0),z:cell.z-(dz?half:0)},rotation:dx?0:90,...widthMetadata,offset:dx?Math.abs(cell.x-cx):Math.abs(cell.z-cz),landing});
        }
        if(sites.some(site=>!site.length))continue;const contourGates=sites.map(site=>{const {offset:_,landing:__,...gate}=site.sort((a,b)=>b.landing-a.landing||a.offset-b.offset||a.originCell.x-b.originCell.x||a.originCell.z-b.originCell.z)[0]!;return gate;});
        if(shapeFailure(cycle,contourGates))continue;selected={cells:cycle,gates:contourGates,origin:{xMm:anchor.xMm,zMm:anchor.zMm},signature:fortifyLayoutSignature(cycle,contourGates)};
      }
      if(!selected)return blocked(firstFailure);
    }
  }
  const matchedIds=matches(selected.cells,selected.gates),holes=openings(selected.gates),walls=selected.cells.filter(cell=>!holes.has(key(cell))),knownObstacles=[...terrain,...staticObstacles.filter(obstacle=>!matchedIds.has(obstacle.id))];
  const proposedObstacles:Obstacle[]=walls.map(cell=>({id:`planned_${key(cell)}`,xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid,halfWidth:grid/2,halfHeight:grid/2}));
  for(const [index,site]of selected.gates.entries())proposedObstacles.push(...fortificationObstacles({id:`planned_gate_${index}`,typeId:gateType,rotation:site.rotation,xMm:(site.originCell.x+(site.rotation===0?(site.widthCells??3)/2:.5))*grid,zMm:(site.originCell.z+(site.rotation===90?(site.widthCells??3)/2:.5))*grid,work:1,required:1,gateOpen:true} as Building));
  const anchorBox=fortifyViewObstacle(anchor),anchorFaces=[{xMm:anchor.xMm-anchorBox.halfWidth-900,zMm:anchor.zMm},{xMm:anchor.xMm+anchorBox.halfWidth+900,zMm:anchor.zMm},{xMm:anchor.xMm,zMm:anchor.zMm-anchorBox.halfHeight-900},{xMm:anchor.xMm,zMm:anchor.zMm+anchorBox.halfHeight+900}];
  if(memory.layoutKey!==knowledgeKey||memory.layout!==selected){
    const before=new Navigation(view.map.widthMm,view.map.heightMm,knownObstacles,30000,1000,budget),after=new Navigation(view.map.widthMm,view.map.heightMm,[...knownObstacles,...proposedObstacles],30000,1000,budget);
    const candidates=[...anchorFaces.filter(face=>face.xMm===selected!.origin.xMm&&face.zMm===selected!.origin.zMm),...anchorFaces];
    try{const origin=candidates.find(point=>insideFortifyLayout(selected!.cells,point)&&before.free(point,350)&&after.free(point,350));if(!origin)return blocked('NO_PROOF_ORIGIN');selected={...selected,origin:{...origin}};}
    catch(error){if(!(error instanceof PathBudgetExceededError))throw error;return {status:'waiting',reason:'VALIDATING_RESOURCE_ROUTES'};}
  }
  if(!validFortifyLayout(selected))return blocked('INVALID_LAYOUT');
  memory.layout=selected;memory.layoutKey=knowledgeKey;delete memory.blockedGeometry;if(matchedIds.size)memory.layoutCommitted=true;
  const wallRuns:Cell[][]=[];let run:Cell[]=[],axis='';
  for(const cell of selected.cells){if(holes.has(key(cell))||wallAt(cell)){if(run.length)wallRuns.push(run);run=[];axis='';continue;}
    const prior=run.at(-1),nextAxis=prior?(prior.x===cell.x?'z':'x'):'';
    if(run.length&&(axis&&axis!==nextAxis||run.length===balance.rules.maxWallSegmentsPerCommand)){wallRuns.push(run);run=[];axis='';}
    if(run.length)axis=nextAxis;run.push(cell);
  }
  if(run.length)wallRuns.push(run);
  return {status:'ready',layout:selected,anchorFaces,wallRuns,walls,matchedIds,wallAt,gateAt,knownObstacles,proposedObstacles};
}
