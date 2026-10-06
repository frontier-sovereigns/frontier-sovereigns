import { balance, buildings, units, terrainObstacles, terrainVisionBlockers, terrainLineOfSight, resourcePlacementBounds, type PlayerView, type Position, type BuildingId, type ViewEntity, type GameplayCommand } from '@frontier/shared';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from './navigation.js';
import { fortificationObstacles } from './fortifications.js';
import { resourceWorkBounds } from './forest-navigation.js';

const hz=balance.rules.simulationHz,distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
/** Two build-grid cells leave a street wider than two largest siege bodies.
 * This is a construction policy; movement still uses the true collision shape. */
export const aiBuildingClearanceMm=balance.rules.buildingGridM*2000;
/** Delayed purchases reserve their geometry before foundations appear in a view. */
export function pendingBuildingOccupants(commands:readonly GameplayCommand[]):ViewEntity[]{
  const grid=balance.rules.buildingGridM*1000,result:ViewEntity[]=[];
  for(const [index,command]of commands.entries()){
    if(command.kind==='build'){
      let [w,h]=buildings[command.buildingType].footprintCells;if(command.rotation===90||command.rotation===270)[w,h]=[h,w];
      result.push({id:`pending_build_${index}`,kind:'building',typeId:command.buildingType,ownerId:null,xMm:(command.originCell.x+w/2)*grid,zMm:(command.originCell.z+h/2)*grid,rotation:command.rotation,hp:1,maxHp:1,progress:0});
    }else if(command.kind==='build_wall')for(const [cellIndex,cell]of command.cells.entries())result.push({id:`pending_wall_${index}_${cellIndex}`,kind:'building',typeId:command.material==='stone'?'stone_wall':'palisade_wall',ownerId:null,xMm:(cell.x+.5)*grid,zMm:(cell.z+.5)*grid,hp:1,maxHp:1,progress:0});
  }
  return result;
}
interface DecisionRoster {own:ViewEntity[];owned:ViewEntity[];workers:ViewEntity[];complete:ViewEntity[];army:ViewEntity[];resources:ViewEntity[];enemies:ViewEntity[];buildings:ViewEntity[]}
interface PlacementArea {left:number;top:number;right:number;bottom:number}
type PlacementOccupancy=(left:number,top:number,right:number,bottom:number)=>boolean;
/** Fallback's exact rectangle rule, deliberately distinct from caretaker's
 * circular-unit placement rule. Clip only the derived buckets, never footprints. */
function fallbackPlacementIndex(entities:readonly ViewEntity[],area:PlacementArea):PlacementOccupancy|undefined {
  if(!Object.values(area).every(Number.isFinite)||area.left>area.right||area.top>area.bottom)return;
  interface Rectangle {left:number;top:number;right:number;bottom:number;checked:number}
  const grid=balance.rules.buildingGridM*1000,bucketMm=8000,columns=Math.floor((area.right-area.left)/bucketMm)+1,buckets=new Map<number,Rectangle[]>();
  for(const entity of entities){
    if(entity.ghost&&entity.kind==='unit'||entity.kind==='resource'&&(entity.amount??0)===0)continue;
    const size=entity.kind==='building'?buildings[entity.typeId]?.footprintCells:[1,1];if(!size)return;
    const rotated=entity.rotation===90||entity.rotation===270,gap=entity.kind==='building'?aiBuildingClearanceMm:0,bounds=entity.kind==='resource'?resourcePlacementBounds(entity,balance.rules.treeBuildingClearanceM*1000):{halfWidth:(rotated?size[1]!:size[0]!)*grid/2+gap,halfHeight:(rotated?size[0]!:size[1]!)*grid/2+gap};
    const rectangle:Rectangle={left:entity.xMm-bounds.halfWidth,right:entity.xMm+bounds.halfWidth,top:entity.zMm-bounds.halfHeight,bottom:entity.zMm+bounds.halfHeight,checked:0};
    if(![rectangle.left,rectangle.right,rectangle.top,rectangle.bottom].every(Number.isFinite)||rectangle.left>rectangle.right||rectangle.top>rectangle.bottom)return;
    const left=Math.max(area.left,rectangle.left),right=Math.min(area.right,rectangle.right),top=Math.max(area.top,rectangle.top),bottom=Math.min(area.bottom,rectangle.bottom);
    if(left>right||top>bottom)continue;
    for(let z=Math.floor((top-area.top)/bucketMm);z<=Math.floor((bottom-area.top)/bucketMm);z++)for(let x=Math.floor((left-area.left)/bucketMm);x<=Math.floor((right-area.left)/bucketMm);x++){
      const key=z*columns+x,bucket=buckets.get(key);if(bucket)bucket.push(rectangle);else buckets.set(key,[rectangle]);
    }
  }
  let query=0;
  return (left,top,right,bottom)=>{
    query++;
    for(let z=Math.floor((top-area.top)/bucketMm);z<=Math.floor((bottom-area.top)/bucketMm);z++)for(let x=Math.floor((left-area.left)/bucketMm);x<=Math.floor((right-area.left)/bucketMm);x++)for(const rectangle of buckets.get(z*columns+x)??[]){
      if(rectangle.checked===query)continue;rectangle.checked=query;
      if(rectangle.right>left&&rectangle.left<right&&rectangle.bottom>top&&rectangle.top<bottom)return true;
    }
    return false;
  };
}
/** One synchronous, privately owned policy decision. Callers must not mutate
 * the borrowed observations. Public helpers without a scope keep their original
 * mutable-input behavior; close() releases every observation and geometry root. */
export class AiDecisionContext {
  private views=new Map<PlayerView,{roster?:DecisionRoster;geometry:{value?:Navigation;placements?:Map<string,PlacementOccupancy>}}>();
  constructor(view:PlayerView){this.views.set(view,{geometry:{}});}
  close():void{this.views.clear();}
  /** Only order/farmer-assignment or economy/difficulty overlays qualify. No
   * entity position, static footprint, ownership, gate or terrain may change. */
  inherit(source:PlayerView,derived:PlayerView):void{const prior=this.views.get(source);if(prior&&derived!==source)this.views.set(derived,derived.entities===source.entities?prior:{geometry:prior.geometry});}
  roster(view:PlayerView):DecisionRoster|undefined {
    const entry=this.views.get(view);if(!entry)return;if(entry.roster)return entry.roster;
    const roster:DecisionRoster={own:[],owned:[],workers:[],complete:[],army:[],resources:[],enemies:[],buildings:[]},team=view.players.find(player=>player.id===view.playerId)?.teamId;
    for(const entity of view.entities){
      if(entity.ownerId===view.playerId){roster.own.push(entity);if(!entity.ghost){roster.owned.push(entity);if(entity.typeId==='villager'&&!entity.garrisonedIn)roster.workers.push(entity);if(entity.kind==='building'){roster.buildings.push(entity);if(entity.progress===1)roster.complete.push(entity);}if(entity.kind==='unit'&&!['villager','scout'].includes(entity.typeId)&&!entity.garrisonedIn)roster.army.push(entity);}}
      else if(entity.ownerId&&!entity.ghost&&view.players.find(player=>player.id===entity.ownerId)?.teamId!==team)roster.enemies.push(entity);
      if(entity.kind==='resource'&&!entity.ghost&&(entity.amount??0)>0)roster.resources.push(entity);
    }
    entry.roster=roster;return roster;
  }
  navigation(view:PlayerView):Navigation|undefined{const entry=this.views.get(view);return entry?(entry.geometry.value??=knownNavigation(view)):undefined;}
  /** Called lazily only after a candidate passed map, terrain and fog checks.
   * All subsequent sites in this same decision retain their original order. */
  fallbackPlacement(view:PlayerView,area:PlacementArea):PlacementOccupancy|undefined {
    const entry=this.views.get(view);if(!entry)return;
    const placements=entry.geometry.placements??=new Map(),key=`${area.left}:${area.top}:${area.right}:${area.bottom}`,prior=placements.get(key);if(prior)return prior;
    const occupied=fallbackPlacementIndex(view.entities,area);if(occupied)placements.set(key,occupied);return occupied;
  }
  /** Reuse geometry buckets only. Each caller still owns its independent search
   * limit and mutable work budget, including failed probes and exhaustion. */
  query(view:PlayerView,geometry:Navigation,maxSearchNodes:number,budget:NavigationWorkBudget):Navigation|undefined{
    if(this.views.get(view)?.geometry.value!==geometry)return;
    return new Navigation(view.map.widthMm,view.map.heightMm,[],maxSearchNodes,1000,budget,geometry);
  }
}
/** Geometry comes only from this recipient's observations and public terrain. */
export function knownNavigation(view:PlayerView):Navigation {
  const obstacles:Obstacle[]=terrainObstacles(view.map.terrain??[]);
  for(const entity of view.entities){if(entity.kind==='unit'||entity.kind==='resource'&&(entity.amount??0)<=0)continue;
    if(entity.kind==='building'){
      const owned=entity.ownerId===view.playerId,active=owned&&!view.players.find(player=>player.id===view.playerId)?.defeated;
      obstacles.push(...fortificationObstacles({id:entity.id,typeId:entity.typeId as BuildingId,ownerId:entity.ownerId!,xMm:entity.xMm,zMm:entity.zMm,rotation:entity.rotation??0,work:entity.progress===1?1:0,required:1,gateOpen:entity.gateOpen,...(owned?{gateMode:entity.gateMode}:{})},active?view.playerId:undefined,(a,b)=>a!==b));
    }
    else obstacles.push({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,...resourceWorkBounds(entity)});
  }
  return new Navigation(view.map.widthMm,view.map.heightMm,obstacles,2048);
}
/** Public fog supplies destinations, never hidden resources or spawn positions.
 * An emergency worker uses its own sight and collision radius, never a Scout's. */
export function scoutDestination(view:PlayerView,scout:Position&Partial<Pick<ViewEntity,'typeId'>>,enemies:Position[],geometry:Navigation,index:number,avoidTarget?:Position,context?:AiDecisionContext):Position|undefined {
  const definition=units[scout.typeId??'scout']??units.scout;
  const {widthMm,heightMm,fogCellMm:cell}=view.map,width=Math.floor(widthMm/cell),height=Math.floor(heightMm/cell),explored=new Uint8Array(width*height),vision=definition.visionM*1000,radius=definition.collisionRadiusM*1000;
  for(const id of view.fog.explored)explored[id]=1;
  const tiles=new Map<number,{point:Position;distance:number;cell:number}>(),tileColumns=Math.ceil(widthMm/vision);
  // One nearby frontier representative per vision-sized tile prevents a dense
  // local edge from filling the shortlist with nearly identical destinations.
  for(const id of view.fog.explored){const x=id%width,z=Math.floor(id/width);
    for(const [dx,dz]of [[-1,0],[0,-1],[1,0],[0,1]] as const){const nx=x+dx,nz=z+dz,next=nz*width+nx;if(nx<0||nz<0||nx>=width||nz>=height||explored[next])continue;
      const point={xMm:Math.round((nx+.5)*cell),zMm:Math.round((nz+.5)*cell)},key=Math.floor(point.zMm/vision)*tileColumns+Math.floor(point.xMm/vision),length=distance(scout,point),prior=tiles.get(key);
      if(!prior||length<prior.distance||length===prior.distance&&next<prior.cell)tiles.set(key,{point,distance:length,cell:next});
    }
  }
  const cardinal=[{xMm:scout.xMm-28000,zMm:scout.zMm},{xMm:scout.xMm,zMm:scout.zMm-28000},{xMm:scout.xMm+28000,zMm:scout.zMm},{xMm:scout.xMm,zMm:scout.zMm+28000}],candidates=[...cardinal.slice(index%4),...cardinal.slice(0,index%4),...[...tiles].sort(([a,left],[b,right])=>left.distance-right.distance||a-b).slice(0,60).map(([,value])=>value.point)],blockers=terrainVisionBlockers(view.map.terrain??[]);
  const novelty=(point:Position):number=>{let count=0;const nearby=blockers.filter(blocker=>Math.abs(blocker.xMm-point.xMm)<=blocker.halfWidth+vision&&Math.abs(blocker.zMm-point.zMm)<=blocker.halfHeight+vision);
    for(let z=Math.max(0,Math.floor((point.zMm-vision)/cell));z<Math.min(height,Math.ceil((point.zMm+vision)/cell));z++)for(let x=Math.max(0,Math.floor((point.xMm-vision)/cell));x<Math.min(width,Math.ceil((point.xMm+vision)/cell));x++){
      const target={xMm:(x+.5)*cell,zMm:(z+.5)*cell};if(!explored[z*width+x]&&distance(point,target)<=vision&&(!nearby.length||terrainLineOfSight(nearby,point,target)))count++;
    }return count;
  };
  // A recently blocked ordinary route should not monopolize the best-gain
  // target. The caller owns its bounded retry window and persisted destination.
  const allowed=(point:Position)=>point.xMm>=radius&&point.zMm>=radius&&point.xMm<=widthMm-radius&&point.zMm<=heightMm-radius&&(!avoidTarget||distance(point,avoidTarget)>vision/2);
  const ranked=candidates.filter(allowed).map((point,order)=>({point,order,gain:novelty(point),distance:distance(scout,point)})).filter(candidate=>candidate.gain>0).sort((a,b)=>b.gain-a.gain||a.distance-b.distance||a.order-b.order).map(candidate=>candidate.point),phase=Math.floor(view.tick/(balance.ai.rulePolicies.hard.scoutIntervalSeconds*hz)),alternatives=ranked.slice(4),offset=alternatives.length?phase*4%alternatives.length:0;
  const frontier=[...ranked.slice(0,4),...[...alternatives.slice(offset),...alternatives.slice(0,offset)].slice(0,4)];
  const safeSegment=(from:Position,to:Position)=>enemies.every(enemy=>{const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((enemy.xMm-from.xMm)*dx+(enemy.zMm-from.zMm)*dz)/length)):0;return Math.hypot(enemy.xMm-from.xMm-dx*t,enemy.zMm-from.zMm-dz*t)>=10000;});
  // All probes share one deterministic work limit, including failed routes.
  const budget={remaining:8000,used:0},nav=context?.query(view,geometry,512,budget)??new Navigation(widthMm,heightMm,geometry.obstacles,512,1000,budget);
  /** A frontier behind a ridge can require more fine-grid expansions than the
   * bounded probe allows. Prove a short visibility-graph route around at most
   * four public barriers, then advance to its first corner. Intermediate known
   * ground need not reveal fog itself: the complete route must reach a novel
   * frontier. Replanning its shortest remaining route avoids a blind corner
   * patrol, and every edge still checks known forests/buildings and threats. */
  const terrainWaypoint=(targets:Position[]):Position|undefined=>{
    const barriers=terrainObstacles(view.map.terrain??[]).filter(obstacle=>targets.some(target=>!terrainLineOfSight([{...obstacle,halfWidth:obstacle.halfWidth+radius,halfHeight:obstacle.halfHeight+radius}],scout,target)))
      .sort((a,b)=>Math.hypot(Math.max(0,Math.abs(a.xMm-scout.xMm)-a.halfWidth),Math.max(0,Math.abs(a.zMm-scout.zMm)-a.halfHeight))-Math.hypot(Math.max(0,Math.abs(b.xMm-scout.xMm)-b.halfWidth),Math.max(0,Math.abs(b.zMm-scout.zMm)-b.halfHeight))||a.id.localeCompare(b.id)).slice(0,4);
    if(!barriers.length)return undefined;
    const points:Position[]=[scout,...targets],keys=new Set(points.map(point=>`${point.xMm}:${point.zMm}`)),margin=radius+1000;
    for(const obstacle of barriers)for(const dx of [-1,1])for(const dz of [-1,1]){
      const point={xMm:Math.round(obstacle.xMm+dx*(obstacle.halfWidth+margin)),zMm:Math.round(obstacle.zMm+dz*(obstacle.halfHeight+margin))},key=`${point.xMm}:${point.zMm}`;
      if(!keys.has(key)&&distance(scout,point)>1000&&allowed(point)&&nav.free(point,radius)){keys.add(key);points.push(point);}
    }
    // At most 25 vertices (one Scout, eight frontiers, sixteen corners).
    // Symmetric edge memoization and the existing shared work budget bound this
    // independently of map area; it cannot start an unbounded fine-grid search.
    const lengths=points.map(()=>Infinity),previous=points.map(()=>-1),settled=new Uint8Array(points.length),edges=new Uint8Array(points.length*points.length);lengths[0]=0;
    for(let iteration=0;iteration<points.length;iteration++){
      let current=-1;for(let candidate=0;candidate<points.length;candidate++)if(!settled[candidate]&&Number.isFinite(lengths[candidate])&&(current<0||lengths[candidate]!<lengths[current]!))current=candidate;
      if(current<0)return undefined;
      if(current>0&&current<=targets.length){let first=current;while(previous[first]!>0)first=previous[first]!;return points[first];}
      settled[current]=1;
      for(let next=1;next<points.length;next++)if(!settled[next]){
        const length=lengths[current]!+distance(points[current]!,points[next]!);if(length>=lengths[next]!)continue;
        const key=current*points.length+next;
        if(!edges[key]){const clear=safeSegment(points[current]!,points[next]!)&&nav.clearLine(points[current]!,points[next]!,radius);edges[key]=edges[next*points.length+current]=clear?2:1;}
        if(edges[key]===2){lengths[next]=length;previous[next]=current;}
      }
    }
    return undefined;
  };
  const reachable=(targets:Position[]):Position|undefined=>{
    for(const target of targets)if(safeSegment(scout,target)&&nav.clearLine(scout,target,radius))return target;
    const waypoint=terrainWaypoint(targets);if(waypoint)return waypoint;
    const start=targets.length?phase%targets.length:0;
    for(const target of [...targets.slice(start),...targets.slice(0,start)]){const path=nav.path(scout,target,radius);if(!path)continue;let previous:Position=scout;if(path.every(point=>{const safe=safeSegment(previous,point);previous=point;return safe;}))return target;}
    return undefined;
  };
  try{
    const target=reachable(frontier);if(target)return target;
    // Old enemy memories cannot take precedence over a safe unexplored frontier.
    const team=view.players.find(player=>player.id===view.playerId)?.teamId,stale=view.entities.filter(entity=>entity.ghost&&entity.ownerId&&view.players.find(player=>player.id===entity.ownerId)?.teamId!==team&&view.tick-(entity.lastSeenTick??0)>30*hz).sort((a,b)=>(a.lastSeenTick??0)-(b.lastSeenTick??0)||a.id.localeCompare(b.id)).slice(0,8).map(entity=>({xMm:entity.xMm+12000,zMm:entity.zMm+12000}));
    return reachable(stale.filter(allowed));
  }catch(error){if(error instanceof PathBudgetExceededError)return undefined;throw error;}
}
