import { balance, resolveRuleset, legendaryExpansion, buildings, units, sha256, terrainBuildable, terrainObstacles, type BuildingId, type MapType, type Position, type PublicPlayer, type ResourceBank, type ResourceType, type Rotation, type TerrainRegion, type UnitId, type ForestCell, type RulesetId, type MaximumAge } from '@frontier/shared';
import { Navigation, type Obstacle } from './navigation.js';
import { SeededRandom } from './random.js';
import { forestClearingComponents,proveForestClearing,resourceWorkBounds,resourceWorkPoints } from './forest-navigation.js';
import { validateBroadMapRoutes, type BroadMapRouteReport } from './map-connectivity.js';
import { GenerationResourceAccess } from './map-resource-access.js';
import { addForestBelts,forestCrossingReservations,forestTerritoryCuts } from './map-forest-belts.js';
import { validateForestFrontiers,validateForestBeltSummary,forestApproachOverlapsObstacle,forestCrossingPolygons,type ForestFrontier } from './map-forest-belts-validation.js';

export const MAP_GENERATOR_VERSION='7.0.1';
export interface MapSpawn {playerId:string;center:Position;buildings:{typeId:BuildingId;position:Position;rotation:Rotation}[];units:{typeId:UnitId;position:Position}[]}
export interface MapResource extends Position {resource:ResourceType;typeId:string;amount:number;startRegion?:string;outerRegion?:string;outerEntry?:Position;forest?:ForestCell}
export interface LegendaryHomeSite {playerId:string;citadel:Position;siegeYard:Position;siegeYardRotation:0|90;giantExit:Position}
export interface MapValidation {attempt:number;connected:boolean;spawnReports:{playerId:string;resources:ResourceBank;travelMm:ResourceBank}[];travelVariation:ResourceBank;resourceNodes:number;expansionPatches:number;broadRoutes?:{minimumWidthMm:number;independentRoutes:number;verifiedPairs:number;sampledCells:number};forestBelts?:{frontiers:number;openings:number;minimumDepthMm:number;treeNodes:number;extraTreeNodes:number};longWar?:{homeSites:LegendaryHomeSite[];nonStartingResources:ResourceBank;outerAccessVariation:ResourceBank}}
/** This record is host-only. Only type/version/dimensions/terrain belong in player snapshots. */
export interface GeneratedMap {rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';type:MapType;generatorVersion:string;seed:string;widthMm:number;heightMm:number;terrain:TerrainRegion[];spawns:MapSpawn[];resources:MapResource[];forestFrontiers?:ForestFrontier[];validation:MapValidation}
export interface MapOptions {rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';seed:string|number;factions:PublicPlayer[];mapType?:MapType;mapSize?:'auto'|'small'|'medium'|'large'}
const grid=balance.rules.buildingGridM*balance.rules.positionUnitsPerM;
const startLayoutsPerInset=9,startInsetLevels=4;
const forestCellMm=balance.maps.forestNavigationCellM*balance.rules.positionUnitsPerM;
const resources:ResourceType[]=['food','wood','gold','stone'];
const zero=():ResourceBank=>({food:0,wood:0,gold:0,stone:0});
const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const snap=(value:number)=>Math.round(value/grid)*grid;
const bank=(minimum:ResourceBank,resource:ResourceType,part:number,count:number)=>Math.floor(minimum[resource]/count)+(part<minimum[resource]%count?1:0);
const resourceRadius=(resource:ResourceType)=>resource==='wood'?450:650;
const typeFor=(resource:ResourceType,rng:SeededRandom)=>resource==='wood'?['tree_oak','tree_pine','tree_round_canopy'][Math.floor(rng.next()*3)]!:resource==='food'?'forage_patch':resource==='gold'?'gold_deposit':'stone_quarry';
const maximumMapRadius=(map:Pick<GeneratedMap,'rulesetId'|'maxAge'|'startingResourcePreset'>)=>Math.max(...resolveRuleset(map.rulesetId,map.maxAge,map.startingResourcePreset).units.map(unit=>unit.collisionRadiusM*1000));
/** Outer expansions may share frontier land; they cannot occupy another home's
 * protected starting area or be assigned from a remote part of the map. */
const withinOuterRegion=(map:GeneratedMap,point:Position,owner:MapSpawn):boolean=>{
  const own=distance(point,owner.center),reach=balance.maps.naturalBarriers.minimumStartSeparationM*2000,staging=balance.maps.naturalBarriers.stagingRegionM*1000;
  return own<=reach&&map.spawns.every(other=>other===owner||distance(point,other.center)>=staging);
};
/** ADD-11 divides the additional stock, not the original neutral economy. The
 * pre-expansion baseline is independently recoverable from ordinary neutral
 * cluster counts and physical tree cells in the validated original belts. */
const longWarStockRequirements=(map:GeneratedMap,resource:'wood'|'gold'|'stone')=>{
  const perNode=balance.maps.spawnResourceMinimum[resource]/balance.maps.resourceNodes.expansion[resource];
  let baseline=0;for(let index=0;index<Math.max(4,map.spawns.length*2);index++)if(resources[index%4]===resource)baseline+=balance.maps.resourceNodes.expansion[resource];
  if(resource==='wood')baseline=Math.max(baseline,map.resources.filter(node=>node.resource==='wood'&&!node.startRegion&&node.forest&&map.forestFrontiers?.some(frontier=>{const normal=frontier.axis==='x'?node.xMm:node.zMm,along=frontier.axis==='x'?node.zMm:node.xMm;return Math.abs(normal-frontier.coordinateMm)<frontier.depthMm/2&&along>frontier.fromMm&&along<frontier.toMm&&!frontier.crossings.some(crossing=>Math.abs(along-crossing.centerMm)<crossing.widthMm/2);})).length);
  const target=Math.ceil(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*map.spawns.length/perNode),additional=Math.max(0,target-baseline);
  const outer=Math.ceil(additional*legendaryExpansion.longWar.outerExpansionFraction/map.spawns.length)*map.spawns.length;
  return {perNode,baseline,target,additional,outer};
};
const emptyValidation=():MapValidation=>({attempt:0,connected:false,spawnReports:[],travelVariation:zero(),resourceNodes:0,expansionPatches:0});
const broadOrigin=(map:GeneratedMap,spawn:MapSpawn):Position=>({xMm:spawn.center.xMm,zMm:spawn.center.zMm+(map.rulesetId==='legendary_ages_v1'&&(map.maxAge??8)>=5?-14000:12000)});

/** Generation reservations, not free buildings. Keep both late-game footprints
 * outside the starting resource layout while retaining the same edge rotation. */
function legendaryHomeSites(map:GeneratedMap):LegendaryHomeSite[] {
  if(map.rulesetId!=='legendary_ages_v1'||(map.maxAge??8)<5)return [];
  return map.spawns.map(spawn=>{
    const rotate=Math.min(spawn.center.xMm,map.widthMm-spawn.center.xMm)<Math.min(spawn.center.zMm,map.heightMm-spawn.center.zMm);
    const position=(x:number,z:number):Position=>({xMm:spawn.center.xMm+(rotate?z:x),zMm:spawn.center.zMm+(rotate?-x:z)});
    return {playerId:spawn.playerId,citadel:position(-26000,22000),siegeYard:position(24000,-10000),siegeYardRotation:rotate?90:0,giantExit:position(24000,0)};
  });
}
function legendaryPlotObstacles(site:LegendaryHomeSite):Obstacle[] {
  const citadel=buildings.grand_citadel.footprintCells,yard=buildings.great_siege_yard.footprintCells;
  return [{id:`reserved_citadel_${site.playerId}`,...site.citadel,halfWidth:citadel[0]*grid/2,halfHeight:citadel[1]*grid/2},{id:`reserved_yard_${site.playerId}`,...site.siegeYard,halfWidth:yard[site.siegeYardRotation===90?1:0]*grid/2,halfHeight:yard[site.siegeYardRotation===90?0:1]*grid/2}];
}

function valleyAxes(length:number):number[]{
  const size=balance.maps.sizes.find(size=>length<=size.cells[0]!*grid)??balance.maps.sizes.at(-1)!;
  const count=balance.maps.forestBelts.territoryCellsBySize[size.id as 'small'|'medium'|'large'];
  return Array.from({length:count},(_,index)=>snap(length*(index+.5)/count));
}

function riverSlotCenters(height:number):number[]{
  const size=balance.maps.sizes.find(size=>height===size.cells[1]!*grid)!,slots=Math.ceil(size.factions[1]!/2);
  return Array.from({length:slots},(_,index)=>snap(40000+(height-80000)*index/(slots-1)));
}

const landformColumns=(type:MapType,width:number):number[]=>type==='river_divide'?[balance.maps.naturalBarriers.minimumRouteWidthM*2000,width-balance.maps.naturalBarriers.minimumRouteWidthM*2000]:valleyAxes(width);

function territoryAxes(map:Pick<GeneratedMap,'type'|'widthMm'|'heightMm'>):{x:number[];z:number[]} {
  if(map.type!=='river_divide')return {x:forestTerritoryCuts(valleyAxes(map.widthMm)),z:forestTerritoryCuts(valleyAxes(map.heightMm))};
  return {x:[map.widthMm/2],z:forestTerritoryCuts(riverSlotCenters(map.heightMm))};
}

/** Public ridge anchors leave broad corridors before private settlement/resource
 * selection. The later forest plan chooses the actual protected crossings. */
function landforms(type:MapType,width:number,height:number,rng:SeededRandom):TerrainRegion[]{
  const result:TerrainRegion[]=[],xs=landformColumns(type,width),zs=valleyAxes(height),halfValley=balance.maps.naturalBarriers.valleyWidthM*500;
  if(type==='river_divide'){
    result.push({id:'river',kind:'water',xMm:width/2-6000,zMm:0,widthMm:12000,depthMm:height,elevationMm:-1500});
    const slots=riverSlotCenters(height),count=Math.min(balance.maps.forestBelts.preferredOpenings,slots.length);
    for(let index=0;index<count;index++){
      const z=slots[Math.round(index*(slots.length-1)/(count-1))]!;
      result.push({id:`bridge_${index+1}`,kind:'bridge',xMm:width/2-8000,zMm:z-halfValley,widthMm:16000,depthMm:halfValley*2,elevationMm:0});
    }
    // River bank strips use their own public capacity grid. Square anchors end
    // exactly at a belt face; an extra protruding ridge corner would pinch its
    // otherwise valid flared bank crossing.
    const depth=balance.maps.forestBelts.targetDepthM*1000,bankLane=6000+balance.maps.naturalBarriers.valleyWidthM*1000;
    const centers=[Math.floor((width/2-bankLane-depth/2)/forestCellMm)*forestCellMm,Math.ceil((width/2+bankLane+depth/2)/forestCellMm)*forestCellMm];
    for(const [row,z]of forestTerritoryCuts(slots).entries())for(const [side,x]of centers.entries())result.push({id:`ridge_bank_${side}_${row}`,kind:'ridge',xMm:x-depth/2,zMm:z-depth/2,widthMm:depth,depthMm:depth,elevationMm:(balance.maps.naturalBarriers.ridgeHeightM-Math.floor(rng.next()*3)*2)*1000});
    return result;
  }
  for(let z=0;z<zs.length-1;z++)for(let x=0;x<xs.length-1;x++){
    const left=xs[x]!+halfValley,right=xs[x+1]!-halfValley,top=zs[z]!+halfValley,bottom=zs[z+1]!-halfValley;
    // Compact ridge anchors leave accessible foothills inside each plot. The
    // broad public terrain corridors remain clear of permanent mountains.
    const vertical=rng.next()<.5,minimum=balance.maps.forestBelts.targetDepthM*1000,insetX=(right-left-minimum-(vertical?0:forestCellMm*2))/2,insetZ=(bottom-top-minimum-(vertical?forestCellMm*2:0))/2;
    // Ridge edges share the forest lattice, so touching harvestable woodland
    // can close a frontier without tiny walkable cracks. This remains seed-only.
    const centerX=Math.round((left+right)/2/forestCellMm)*forestCellMm,centerZ=Math.round((top+bottom)/2/forestCellMm)*forestCellMm;
    const ridgeLeft=Math.min(Math.ceil((left+insetX)/forestCellMm)*forestCellMm,centerX-minimum/2),ridgeTop=Math.min(Math.ceil((top+insetZ)/forestCellMm)*forestCellMm,centerZ-minimum/2),ridgeRight=Math.max(Math.floor((right-insetX)/forestCellMm)*forestCellMm,centerX+minimum/2),ridgeBottom=Math.max(Math.floor((bottom-insetZ)/forestCellMm)*forestCellMm,centerZ+minimum/2);
    const ridge:TerrainRegion={id:`ridge_${x}_${z}`,kind:'ridge',xMm:ridgeLeft,zMm:ridgeTop,widthMm:ridgeRight-ridgeLeft,depthMm:ridgeBottom-ridgeTop,elevationMm:(balance.maps.naturalBarriers.ridgeHeightM-Math.floor(rng.next()*3)*2)*1000};
    result.push(ridge);
  }
  return result;
}

function validateNaturalBarriers(map:GeneratedMap):void {
  const rules=balance.maps.naturalBarriers,half=rules.valleyWidthM*500,xs=landformColumns(map.type,map.widthMm),zs=map.type==='river_divide'?riverSlotCenters(map.heightMm):valleyAxes(map.heightMm);
  for(const region of map.terrain){
    if(region.kind==='ridge'){
      if(xs.some(x=>region.xMm<x+half&&region.xMm+region.widthMm>x-half)||zs.some(z=>region.zMm<z+half&&region.zMm+region.depthMm>z-half))throw new Error('RIDGE_OBSTRUCTS_RESERVED_VALLEY');
      if(map.type==='river_divide'&&region.xMm<map.widthMm/2+6000+rules.minimumRouteWidthM*1000&&region.xMm+region.widthMm>map.widthMm/2-6000-rules.minimumRouteWidthM*1000)throw new Error('NARROW_RIVERBANK');
    }
    if(region.kind==='bridge'&&region.depthMm<rules.valleyWidthM*1000)throw new Error('NARROW_CROSSING');
  }
}

function startingLayout(playerId:string,center:Position):MapSpawn {
  const spawn:MapSpawn={playerId,center,buildings:[],units:[]};
  for(const [typeId,count]of Object.entries(balance.start.buildings))for(let i=0;i<count;i++)spawn.buildings.push({typeId:typeId as BuildingId,position:typeId==='town_center'?{...center}:{xMm:center.xMm-12000-i*6000,zMm:center.zMm-6000},rotation:0});
  for(const [typeId,count]of Object.entries(balance.start.units))for(let i=0;i<count;i++)spawn.units.push({typeId:typeId as UnitId,position:typeId==='villager'?{xMm:center.xMm-4000+i*1600,zMm:center.zMm+8000}:{xMm:center.xMm+9500+i*1600,zMm:center.zMm+8500}});
  return spawn;
}

function startingResources(spawn:MapSpawn,rng:SeededRandom,forestPatchId:string,width:number,height:number):MapResource[]{
  const result:MapResource[]=[],minimum=balance.maps.spawnResourceMinimum;
  const verticalEdge=Math.min(spawn.center.xMm,width-spawn.center.xMm)<Math.min(spawn.center.zMm,height-spawn.center.zMm);
  const add=(resource:ResourceType,x:number,z:number)=>result.push({resource,typeId:typeFor(resource,rng),xMm:spawn.center.xMm+(verticalEdge?z:x),zMm:spawn.center.zMm+(verticalEdge?-x:z),amount:minimum[resource]/balance.maps.resourceNodes.starting[resource],startRegion:spawn.playerId,...(resource==='wood'?{forest:{patchId:forestPatchId,cellMm:forestCellMm}}:{})});
  // Keep the parallel footprint compact so both wide frontier approaches fit
  // beside a town. Rotate the same ordinary-yield layout on vertical map edges.
  for(let i=0;i<30;i++)add('wood',2000+(i%6)*forestCellMm,15000+Math.floor(i/6)*forestCellMm);
  for(let i=0;i<6;i++)add('food',-14000+(i%3)*2200,3500+Math.floor(i/3)*2200);
  for(let i=0;i<5;i++)add('gold',-18000+i*3000,-24000);
  for(let i=0;i<5;i++)add('stone',-6000+i*3000,-22000);
  return result;
}

function staticObstacles(map:GeneratedMap):Obstacle[]{
  const obstacles=terrainObstacles(map.terrain);
  for(const spawn of map.spawns)for(const [index,building]of spawn.buildings.entries()){
    const [w,d]=buildings[building.typeId].footprintCells;
    obstacles.push({id:`start_${spawn.playerId}_${index}`,xMm:building.position.xMm,zMm:building.position.zMm,halfWidth:w*grid/2,halfHeight:d*grid/2});
  }
  map.resources.forEach((node,index)=>obstacles.push({id:`resource_${index}`,xMm:node.xMm,zMm:node.zMm,...resourceWorkBounds(node)}));
  return obstacles;
}

function publicPassable(map:GeneratedMap,point:Position,margin:number):boolean {
  return point.xMm-margin>=0&&point.zMm-margin>=0&&point.xMm+margin<=map.widthMm&&point.zMm+margin<=map.heightMm&&terrainBuildable(map.terrain,{xMm:point.xMm-margin,zMm:point.zMm-margin,widthMm:margin*2,depthMm:margin*2});
}

/** Search safe outer regions instead of clustering starts around the map center.
 * Only locked team IDs define allies. The bounded search maximizes the closest
 * opposing start, then keeps allies together and improves overall enemy distance.
 * Secret seeded offsets/ties preserve placement independence from public terrain.
 */
function separatedStarts(map:GeneratedMap,factions:PublicPlayer[],rng:SeededRandom,attempt=0):Map<string,Position> {
  const margin=40000,wideInset=(balance.maps.naturalBarriers.stagingRegionM+balance.maps.naturalBarriers.minimumRouteWidthM)*1000;
  const bankAnchor=Math.floor((map.widthMm/2-(6000+balance.maps.naturalBarriers.valleyWidthM*1000)-balance.maps.forestBelts.targetDepthM*500)/forestCellMm)*forestCellMm;
  const edgeInset=map.startingResourcePreset==='long_war'?(map.type==='river_divide'?Math.min(wideInset+8000,bankAnchor-margin-balance.maps.forestBelts.targetDepthM*500-4000):margin+Math.floor(attempt/startLayoutsPerInset)%startInsetLevels*8000):margin,spacing=balance.maps.naturalBarriers.minimumStartSeparationM*1000,candidates:Position[]=[];
  let originalCandidates:Position[]=[];
  const axes=territoryAxes(map);
  const add=(x:number,z:number,reserveEveryCut=true)=>{
    const point={xMm:snap(x),zMm:snap(z)};
    if(map.startingResourcePreset==='long_war'&&map.type==='river_divide'&&(point.xMm<edgeInset||point.xMm>map.widthMm-edgeInset))return;
    const beltClearance=margin+balance.maps.forestBelts.targetDepthM*500;
    if(reserveEveryCut&&(axes.x.some(value=>Math.abs(point.xMm-value)<beltClearance)||axes.z.some(value=>Math.abs(point.zMm-value)<beltClearance)))return;
    if(publicPassable(map,point,margin)&&!candidates.some(prior=>prior.xMm===point.xMm&&prior.zMm===point.zMm))candidates.push(point);
  };
  // Small private inward offsets retain the full resource/building clearance.
  const left=edgeInset+snap(rng.next()*4000),right=map.widthMm-edgeInset-snap(rng.next()*4000),top=edgeInset+snap(rng.next()*4000),bottom=map.heightMm-edgeInset-snap(rng.next()*4000);
  const midpoints=(cuts:readonly number[],length:number)=>{const edges=[0,...cuts,length];return edges.slice(1).map((end,index)=>(edges[index]!+end)/2);};
  if(map.type==='river_divide'){
    const slots=riverSlotCenters(map.heightMm);
    for(const [index,z]of slots.entries()){
      const inset=edgeInset+(slots.length===6&&index%2?72000:0);
      // Independent private offsets avoid publishing exact occupied start
      // coordinates through the otherwise public capacity/terrain grid.
      for(const side of ['left','right'] as const){
        const offset=slots.length===2?0:snap(rng.next()*2000),zOffset=snap(rng.next()*2000)*(index===slots.length-1?-1:1);
        add(side==='left'?inset+offset:map.widthMm-inset-offset,z+zOffset);
      }
    }
  }else{
    for(const x of [left,...midpoints(axes.x,map.widthMm),right]){add(x,top);add(x,bottom);}
    for(const z of midpoints(axes.z,map.heightMm)){add(left,z);add(right,z);}
    originalCandidates=[...candidates];
    // Along-edge alternatives let opposing alliances leave a wider neutral
    // gap without moving starts into the forest or sacrificing broad passages.
    if(new Set(factions.map(faction=>faction.teamId)).size<factions.length){
      const edgePositions=(cuts:readonly number[],length:number)=>midpoints(cuts,length).flatMap(center=>[-1,1].map(direction=>center+direction*balance.maps.forestBelts.minimumDepthM*1000));
      for(const x of edgePositions(axes.x,map.widthMm)){add(x,top);add(x,bottom);}
      for(const z of edgePositions(axes.z,map.heightMm)){add(left,z);add(right,z);}
      // Allied homes can share a corner territory. Only an actual rival cut
      // needs its 52m clearance; partition() verifies that selected-cut rule.
      // Reserving every unused cut here would force eleven homes into twelve
      // outer cells and leave too few empty rival boundary regions.
      if(factions.length>balance.maps.sizes.find(size=>size.id==='medium')!.factions[1]!){
        const step=spacing/4;
        for(let x=left;x<=right;x+=step){add(x,top,false);add(x,bottom,false);}
        for(let z=top;z<=bottom;z+=step){add(left,z,false);add(right,z,false);}
      }
    }
  }
  for(let i=candidates.length-1;i>0;i--){const other=Math.floor(rng.next()*(i+1));[candidates[i],candidates[other]]=[candidates[other]!,candidates[i]!];}
  const teams=new Map<string,PublicPlayer[]>();
  for(const faction of factions){const members=teams.get(faction.teamId)??[];members.push(faction);teams.set(faction.teamId,members);}
  const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
  const grouped=[...teams.values()].sort((a,b)=>b.length-a.length||lexical(a[0]!.teamId,b[0]!.teamId)).map(members=>members.sort((a,b)=>lexical(a.id,b.id)));
  let ordered=grouped.flat();
  const orders=grouped.some(group=>group.length>1)&&grouped.length>1?[ordered,[...grouped.map(group=>group[0]!),...grouped.flatMap(group=>group.slice(1))]]:[ordered];
  const distances=candidates.map(a=>candidates.map(b=>distance(a,b)));
  const region=(point:Position)=>`${axes.x.filter(value=>point.xMm>value).length}:${axes.z.filter(value=>point.zMm>value).length}`;
  const score=(chosen:number[]):number[]=>{
    let nearestEnemy=Infinity,alliedDistance=0,enemyDistance=0;
    for(let i=0;i<chosen.length;i++)for(let j=0;j<i;j++){
      const separation=distances[chosen[i]!]![chosen[j]!]!;
      if(separation<spacing)return[-Infinity,0,0];
      if(ordered[i]!.teamId===ordered[j]!.teamId)alliedDistance+=separation;
      else {if(region(candidates[chosen[i]!]!)===region(candidates[chosen[j]!]!))return[-Infinity,0,0];nearestEnemy=Math.min(nearestEnemy,separation);enemyDistance+=separation;}
    }
    return[nearestEnemy,-alliedDistance,enemyDistance];
  };
  const better=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++){if(a[i]!>b[i]!)return true;if(a[i]!<b[i]!)return false;}return false;};
  let best:number[]|undefined,bestOrder=ordered,bestScore=[-Infinity,0,0];
  const allCandidates=candidates.map((_,index)=>index),originalIndices=allCandidates.filter(index=>originalCandidates.includes(candidates[index]!));
  const pools=originalIndices.length>=ordered.length&&originalIndices.length<candidates.length?[originalIndices,allCandidates]:[allCandidates];
  // Each pool/order has sixteen anchors and four improvement passes. Seeding
  // every alliance before filling its members keeps rival spacing in the score
  // before one compact allied cluster can consume the candidate region.
  // The original pool avoids a greedy allied cluster hiding better separated
  // arrangements merely because extra candidate positions became available.
  for(const order of orders)for(const pool of pools)for(let anchor=0,anchors=Math.min(16,pool.length);anchor<anchors;anchor++){
    ordered=order;
    const chosen=[pool[Math.floor(anchor*pool.length/anchors)]!];
    for(let index=1;index<ordered.length;index++){
      let choice=-1,choiceScore=[-Infinity,0,0];
      for(const candidate of pool){
        const candidateScore=score([...chosen,candidate]);
        if(better(candidateScore,choiceScore)){choice=candidate;choiceScore=candidateScore;}
      }
      if(choice<0)break;chosen.push(choice);
    }
    if(chosen.length!==ordered.length)continue;
    let current=score(chosen);
    for(let pass=0;pass<4;pass++){
      let changed=false;
      for(let index=0;index<chosen.length;index++){
        let selected=chosen[index]!;
        for(let candidate=0;candidate<candidates.length;candidate++){
          chosen[index]=candidate;const next=score(chosen);
          if(better(next,current)){selected=candidate;current=next;changed=true;}
        }
        chosen[index]=selected;
      }
      if(!changed)break;
    }
    if(better(current,bestScore)){best=[...chosen];bestOrder=ordered;bestScore=current;}
  }
  if(!best)throw new Error('SPAWN_PLACEMENT_FAILED');
  return new Map(bestOrder.map((faction,index)=>[faction.id,candidates[best[index]!]!]));
}

/** Spatial lookup is generation-only; every accepted placement is still checked
 * against exact work footprints. Touching tree cells within a patch stay solid. */
class ResourcePlacementIndex {
  private readonly buckets=new Map<string,MapResource[]>();
  private readonly cell=12000;
  add(node:MapResource):void {const key=`${Math.floor(node.xMm/this.cell)},${Math.floor(node.zMm/this.cell)}`,bucket=this.buckets.get(key)??[];bucket.push(node);this.buckets.set(key,bucket);}
  overlaps(node:MapResource,gap=0):boolean {
    const a=resourceWorkBounds(node),reach=Math.max(a.halfWidth,a.halfHeight)+forestCellMm/2+gap;
    for(let z=Math.floor((node.zMm-reach)/this.cell);z<=Math.floor((node.zMm+reach)/this.cell);z++)for(let x=Math.floor((node.xMm-reach)/this.cell);x<=Math.floor((node.xMm+reach)/this.cell);x++)for(const prior of this.buckets.get(`${x},${z}`)??[]){const b=resourceWorkBounds(prior);if(Math.abs(node.xMm-prior.xMm)<a.halfWidth+b.halfWidth+gap&&Math.abs(node.zMm-prior.zMm)<a.halfHeight+b.halfHeight+gap)return true;}
    return false;
  }
}

/** Retain nearby clusters at ordinary yields, then distribute actual objects in
 * territory lots. Frontier crossings, broad route witnesses and both riverbanks
 * are excluded before packing. */
function addResourceQuantity(map:GeneratedMap,rng:SeededRandom,options:MapOptions,attempt:number,expansionCount:number):BroadMapRouteReport {
  const outerPass=map.startingResourcePreset==='long_war';
  // A shared occupancy lattice makes packing linear in land area rather than
  // repeatedly probing thousands of rejected clusters against every route.
  // Preserve the actual post-belt route witnesses. The old blanket valley
  // reservation would punch extra unplanned openings through every frontier.
  const cell=forestCellMm,columns=Math.floor(map.widthMm/cell),rows=Math.floor(map.heightMm/cell),blocked=new Uint8Array(columns*rows);
  const reservationCells:Record<string,number>={total:blocked.length};
  const captureReservation=(stage:string)=>{if(outerPass)reservationCells[stage]=blocked.reduce((sum,value)=>sum+value,0);};
  const reserve=(left:number,top:number,right:number,bottom:number,target=blocked)=>{
    for(let z=Math.max(0,Math.floor(top/cell));z<Math.min(rows,Math.ceil(bottom/cell));z++)for(let x=Math.max(0,Math.floor(left/cell));x<Math.min(columns,Math.ceil(right/cell));x++)target[z*columns+x]=1;
  };
  for(const obstacle of staticObstacles(map))reserve(obstacle.xMm-obstacle.halfWidth,obstacle.zMm-obstacle.halfHeight,obstacle.xMm+obstacle.halfWidth,obstacle.zMm+obstacle.halfHeight);
  captureReservation('geometry');
  for(const site of legendaryHomeSites(map))for(const plot of legendaryPlotObstacles(site)){
    const clearance=balance.rules.treeBuildingClearanceM*1000;
    reserve(plot.xMm-plot.halfWidth-clearance,plot.zMm-plot.halfHeight-clearance,plot.xMm+plot.halfWidth+clearance,plot.zMm+plot.halfHeight+clearance);
  }
  captureReservation('homePlots');
  const protect=(path:Position[],half:number,target=blocked)=>{for(let i=1;i<path.length;i++){const a=path[i-1]!,b=path[i]!;reserve(Math.min(a.xMm,b.xMm)-half,Math.min(a.zMm,b.zMm)-half,Math.max(a.xMm,b.xMm)+half,Math.max(a.zMm,b.zMm)+half,target);}};
  const protectCardinal=(path:Position[],radius:number,target=blocked)=>{
    for(let i=1;i<path.length;i++){
      const a=path[i-1]!,b=path[i]!;
      if(a.xMm!==b.xMm&&a.zMm!==b.zMm){protect([a,b],radius,target);continue;}
      const left=Math.min(a.xMm,b.xMm),right=Math.max(a.xMm,b.xMm),top=Math.min(a.zMm,b.zMm),bottom=Math.max(a.zMm,b.zMm);
      for(let z=Math.max(0,Math.floor((top-radius)/cell));z<Math.min(rows,Math.ceil((bottom+radius)/cell));z++)for(let x=Math.max(0,Math.floor((left-radius)/cell));x<Math.min(columns,Math.ceil((right+radius)/cell));x++){
        const dx=Math.max(left-(x+1)*cell,x*cell-right,0),dz=Math.max(top-(z+1)*cell,z*cell-bottom,0);
        if(dx*dx+dz*dz<=radius*radius)target[z*columns+x]=1;
      }
    }
  };
  const protectTravel=(path:Position[],target=blocked,clearanceRadius=units.villager.collisionRadiusM*1000)=>{
    // Samples are at most500mm apart. A250mm guard covers every point between
    // samples, in addition to the unchanged full collision/exit radius.
    const half=clearanceRadius+250;
    for(let i=1;i<path.length;i++){const a=path[i-1]!,b=path[i]!;if(a.xMm===b.xMm||a.zMm===b.zMm){protectCardinal([a,b],clearanceRadius,target);continue;}const steps=Math.max(1,Math.ceil(distance(a,b)/500));for(let step=0;step<=steps;step++){const x=a.xMm+(b.xMm-a.xMm)*step/steps,z=a.zMm+(b.zMm-a.zMm)*step/steps;reserve(x-half,z-half,x+half,z+half,target);}}
  };
  const crossingMask=new Uint8Array(blocked.length);
  if(outerPass)for(const frontier of map.forestFrontiers??[])for(const crossing of frontier.crossings){
    // Exact swept48m passage, round end caps and complete flare polygons.
    const half=frontier.depthMm/2+crossing.approachMm,width=crossing.widthMm/2;
    protectCardinal(frontier.axis==='x'?[{xMm:frontier.coordinateMm-half,zMm:crossing.centerMm},{xMm:frontier.coordinateMm+half,zMm:crossing.centerMm}]:[{xMm:crossing.centerMm,zMm:frontier.coordinateMm-half},{xMm:crossing.centerMm,zMm:frontier.coordinateMm+half}],width,crossingMask);
    for(const polygon of forestCrossingPolygons(frontier,crossing)){
      const left=Math.min(...polygon.map(point=>point.xMm)),right=Math.max(...polygon.map(point=>point.xMm)),top=Math.min(...polygon.map(point=>point.zMm)),bottom=Math.max(...polygon.map(point=>point.zMm));
      for(let z=Math.max(0,Math.floor(top/cell));z<Math.min(rows,Math.ceil(bottom/cell));z++)for(let x=Math.max(0,Math.floor(left/cell));x<Math.min(columns,Math.ceil(right/cell));x++)if(forestApproachOverlapsObstacle({id:'reserved',xMm:(x+.5)*cell,zMm:(z+.5)*cell,halfWidth:cell/2,halfHeight:cell/2},polygon))crossingMask[z*columns+x]=1;
    }
  }
  const baseline=validateBroadMapRoutes({preferSharedCorridors:outerPass,...(outerPass?{sharedCorridorOrder:'far' as const,refineSharedCorridors:true}:{}),widthMm:map.widthMm,heightMm:map.heightMm,obstacles:staticObstacles(map),settlements:map.spawns.map(spawn=>({playerId:spawn.playerId,...spawn.center,clearanceRadiusMm:balance.maps.naturalBarriers.stagingRegionM*1000,origin:broadOrigin(map,spawn)})),passageWidthMm:balance.maps.naturalBarriers.minimumRouteWidthM*1000,maxUnitRadiusMm:maximumMapRadius(map)});
  if(!baseline.valid){const pair=baseline.pairs.find(pair=>pair.routeCount<2);throw new Error(`INVALID_BASELINE_BROAD_ROUTES:${baseline.failure??pair?.reason??'UNKNOWN'}:${pair?.fromPlayerId??''}:${pair?.toPlayerId??''}`);}
  const sites=legendaryHomeSites(map);
  if(sites.length){
    const homeNav=new Navigation(map.widthMm,map.heightMm,staticObstacles(map)),radius=Math.max(4000,maximumMapRadius(map));
    for(const site of sites){
      const future=homeNav.withAdditionalObstacles(legendaryPlotObstacles(site)),spawn=map.spawns.find(spawn=>spawn.playerId===site.playerId)!;
      const exit=future.path(site.giantExit,broadOrigin(map,spawn),radius);
      if(!exit)throw new Error('NO_LEGENDARY_YARD_EXIT_RESERVATION');
      protectTravel([site.giantExit,...exit],blocked,radius);
    }
  }
  captureReservation('yardExits');
  // Reuse the same proven corridor network through every packing stage. A new
  // greedy search may choose different valid routes and needlessly reserve more
  // land. Final geometry is independently validated after packing.
  for(const pair of baseline.pairs){
    for(const path of pair.routes)if(outerPass)protectCardinal(path,balance.maps.naturalBarriers.minimumRouteWidthM*500);else protect(path,balance.maps.naturalBarriers.minimumRouteWidthM*500);
  }
  captureReservation('broadRoutes');
  for(const pair of baseline.pairs){
    for(const path of pair.accessRoutes){const clearance=Math.max(1000,maximumMapRadius(map));if(map.startingResourcePreset==='long_war'){protectTravel(path.from,blocked,clearance);protectTravel(path.to,blocked,clearance);}else{protect(path.from,clearance);protect(path.to,clearance);}}
  }
  captureReservation('accessRoutes');
  if(outerPass){for(let id=0;id<blocked.length;id++)if(crossingMask[id])blocked[id]=1;}
  else for(const bounds of forestCrossingReservations(map.forestFrontiers??[]))reserve(bounds.left,bounds.top,bounds.right,bounds.bottom);
  if(map.type==='river_divide'){const half=6000+balance.maps.naturalBarriers.minimumRouteWidthM*1000;reserve(map.widthMm/2-half,0,map.widthMm/2+half,map.heightMm);}
  captureReservation('crossings');
  for(let z=0;z<rows;z++)for(let x=0;x<columns;x++)if(map.spawns.some(spawn=>Math.hypot(Math.max(0,Math.abs((x+.5)*cell-spawn.center.xMm)-cell/2),Math.max(0,Math.abs((z+.5)*cell-spawn.center.zMm)-cell/2))<24000))blocked[z*columns+x]=1;
  captureReservation('staging');
  const stride=columns+1,prefix=new Int32Array(stride*(rows+1));
  for(let z=0;z<rows;z++)for(let x=0;x<columns;x++)prefix[(z+1)*stride+x+1]=blocked[z*columns+x]!+prefix[z*stride+x+1]!+prefix[(z+1)*stride+x]!-prefix[z*stride+x]!;
  const occupied=blocked.slice();
  interface Lot {x:number;z:number;width:number;height:number;tie:number}
  const templates=new Map<number,Lot[]>(),ordered=new Map<string,{lots:Lot[];cursor:number}>();
  const lotsFor=(count:number):Lot[]=>{
    const prior=templates.get(count);if(prior)return prior;
    const widths=count===30?[6,5,3,10,2,15]:[Math.min(5,count),Math.min(2,count),1],lots:Lot[]=[];
    for(const width of new Set(widths)){const height=Math.ceil(count/width);for(let z=0;z<=rows-height;z++)for(let x=0;x<=columns-width;x++){
      const total=prefix[(z+height)*stride+x+width]!-prefix[z*stride+x+width]!-prefix[(z+height)*stride+x]!+prefix[z*stride+x]!;
      if(!total)lots.push({x,z,width,height,tie:rng.next()});
    }}
    templates.set(count,lots);return lots;
  };
  let serial=0,resourceApproaches:Uint8Array|undefined;
  let packingAccess:GenerationResourceAccess|undefined;
  const packingSource={xMm:map.spawns[0]!.center.xMm,zMm:map.spawns[0]!.center.zMm+12000},packingWorkFaces=new Map<string,boolean>();
  const outerDistanceFloor=new Map<ResourceType,number>();
  let outerMetric:GenerationResourceAccess|undefined;
  let outerEntryQueries=0;
  const lotNodes=(resource:ResourceType,lot:Lot,count:number):MapResource[]=>Array.from({length:count},(_,n)=>({resource,typeId:resource==='wood'?'tree_oak':resource==='gold'?'gold_deposit':resource==='stone'?'stone_quarry':'forage_patch',xMm:(lot.x+n%lot.width+.5)*cell+(resource==='wood'?0:500),zMm:(lot.z+Math.floor(n/lot.width)+.5)*cell+(resource==='wood'?0:500),amount:1,...(resource==='wood'?{forest:{patchId:'prospective',cellMm:forestCellMm}}:{})}));
  const lotClear=(resource:ResourceType,lot:Lot,count:number,mask=occupied):boolean=>{
    for(let n=0;n<count;n++){const id=(lot.z+Math.floor(n/lot.width))*columns+lot.x+n%lot.width;if(mask[id]||resource!=='wood'&&!resourceApproaches?.[id])return false;}
    if(packingAccess&&resource!=='wood')for(const node of lotNodes(resource,lot,count)){
      const key=`${node.xMm},${node.zMm}`;let reachable=packingWorkFaces.get(key);
      if(reachable===undefined){reachable=workPoints(node).some(point=>packingAccess!.reachable(packingSource,point));if(packingAccess.diagnostics.exhausted)throw new Error('LONG_WAR_PACKING_ACCESS_WORK_LIMIT');packingWorkFaces.set(key,reachable);}
      if(!reachable)return false;
    }
    return true;
  };
  const lotInRegion=(resource:ResourceType,lot:Lot,count:number,owner:MapSpawn):boolean=>{
    const offset=resource==='wood'?0:500;
    for(let n=0;n<count;n++)if(!withinOuterRegion(map,{xMm:(lot.x+n%lot.width+.5)*cell+offset,zMm:(lot.z+Math.floor(n/lot.width)+.5)*cell+offset},owner))return false;
    return true;
  };
  // Euclidean separation supplies a safe lower bound for every work face.
  // A protected actual entry route separately supplies the region's upper bound.
  const lotDistanceFloor=(resource:ResourceType,lot:Lot,count:number,from:Position):number=>{
    const gap=(resource==='wood'?cell/2:650)+units.villager.collisionRadiusM*1000+200,offset=resource==='wood'?0:500;
    const left=(lot.x+.5)*cell+offset-gap,right=(lot.x+Math.min(count,lot.width)-.5)*cell+offset+gap,top=(lot.z+.5)*cell+offset-gap,bottom=(lot.z+Math.ceil(count/lot.width)-.5)*cell+offset+gap;
    return Math.hypot(Math.max(left-from.xMm,0,from.xMm-right),Math.max(top-from.zMm,0,from.zMm-bottom));
  };
  const commitLot=(resource:ResourceType,lot:Lot,nodeCount:number,owner?:MapSpawn,neutralAnchor?:MapSpawn,entry?:Position)=>{
    const patchId=`forest_${sha256(`forest:${options.seed}:${attempt}:quantity:${outerPass?'outer:':''}${serial++}`).slice(0,32)}`,counts=owner?balance.maps.resourceNodes.starting:balance.maps.resourceNodes.expansion;
    for(const [n,position]of lotNodes(resource,lot,nodeCount).entries()){
      occupied[(lot.z+Math.floor(n/lot.width))*columns+lot.x+n%lot.width]=1;
      const node:MapResource={...position,typeId:typeFor(resource,rng),amount:bank(balance.maps.spawnResourceMinimum,resource,n,counts[resource]),...(owner?{startRegion:owner.playerId}:{}),...(neutralAnchor?{outerRegion:neutralAnchor.playerId}:{}),...(resource==='wood'?{forest:{patchId,cellMm:forestCellMm}}:{})};
      if(entry&&workPoints(node).some(point=>point.xMm===entry.xMm&&point.zMm===entry.zMm))node.outerEntry={...entry};
      map.resources.push(node);
    }
  };
  const prepareResourceApproaches=()=>{
    const nav=new Navigation(map.widthMm,map.heightMm,staticObstacles(map)),radius=units.villager.collisionRadiusM*1000,seen=new Uint8Array(columns*rows),free=new Int8Array(columns*rows),queue=new Int32Array(columns*rows);
    const point=(id:number):Position=>({xMm:(id%columns+.5)*cell,zMm:(Math.floor(id/columns)+.5)*cell});
    const isFree=(id:number)=>{if(!free[id])free[id]=nav.free(point(id),radius)?1:-1;return free[id]===1;};
    if(outerPass){
      const available=new Uint8Array(seen.length);for(let id=0;id<available.length;id++)if(!occupied[id]&&isFree(id))available[id]=1;
      resourceApproaches=available;return;
    }
    const home=map.spawns[0]!.center,rally={xMm:home.xMm,zMm:home.zMm+12000},nearX=Math.floor(rally.xMm/cell),nearZ=Math.floor(rally.zMm/cell);
    let origin=-1;
    for(let ring=0;ring<=2&&origin<0;ring++)for(let dz=-ring;dz<=ring&&origin<0;dz++)for(let dx=-ring;dx<=ring;dx++){
      const x=nearX+dx,z=nearZ+dz,id=z*columns+x;if(x>=0&&z>=0&&x<columns&&z<rows&&isFree(id)&&nav.clearLine(rally,point(id),radius)){origin=id;break;}
    }
    let head=0,tail=0;
    if(origin>=0){seen[origin]=1;queue[tail++]=origin;}
    while(head<tail){const id=queue[head++]!,x=id%columns,z=Math.floor(id/columns),from=point(id);
      for(const [dx,dz]of [[0,-1],[1,0],[0,1],[-1,0]] as const){const nx=x+dx,nz=z+dz,next=nz*columns+nx;if(nx<0||nz<0||nx>=columns||nz>=rows||seen[next]||!isFree(next)||!nav.clearLine(from,point(next),radius))continue;seen[next]=1;queue[tail++]=next;}
    }
    const roomy=new Uint8Array(seen.length);
    for(let z=0;z<rows;z++)for(let x=0;x<columns;x++){const id=z*columns+x;if(!seen[id])continue;
      for(const [dx,dz]of [[-1,-1],[1,-1],[-1,1],[1,1]] as const)if(x+dx>=0&&x+dx<columns&&z+dz>=0&&z+dz<rows&&seen[id+dx]&&seen[id+dz*columns]&&seen[id+dx+dz*columns]){roomy[id]=1;break;}
    }
    // The final 1m component proof validates every real work face. A3m sampling
    // lattice cannot represent the legal gaps between ordinary mineral nodes;
    // do not mistake its disconnected sample centers for impassable terrain.
    // Reserved army corridors and worker approaches are still excluded above.
    resourceApproaches=roomy;
  };
  const place=(resource:ResourceType,nodeCount:number,owner?:MapSpawn,neutralAnchor?:MapSpawn):void=>{
    const key=`${owner?.playerId??(neutralAnchor?'outer_'+neutralAnchor.playerId+'_'+resource:'expansion')}:${nodeCount}`;let order=ordered.get(key);
    if(!order){const near=owner??neutralAnchor;const lots=lotsFor(nodeCount).filter(lot=>!near||map.type!=='river_divide'||((lot.x+lot.width/2)*cell<map.widthMm/2)===(near.center.xMm<map.widthMm/2));
      if(neutralAnchor){const rally={xMm:neutralAnchor.center.xMm,zMm:neutralAnchor.center.zMm+12000},floor=outerDistanceFloor.get(resource)!,scores=new Map(lots.map(lot=>{const lower=lotDistanceFloor(resource,lot,nodeCount,rally);return [lot,lower<floor?1000000-lower:lower] as const;}));lots.sort((a,b)=>scores.get(a)!-scores.get(b)!||a.tie-b.tie);}
      else lots.sort((a,b)=>near?((a.x+a.width/2)*cell-near.center.xMm)**2+((a.z+a.height/2)*cell-near.center.zMm)**2-((b.x+b.width/2)*cell-near.center.xMm)**2-((b.z+b.height/2)*cell-near.center.zMm)**2||a.tie-b.tie:a.tie-b.tie);
      order={lots,cursor:0};ordered.set(key,order);
    }
    while(order.cursor<order.lots.length){const lot=order.lots[order.cursor++]!;
      if(!lotClear(resource,lot,nodeCount)||neutralAnchor&&!lotInRegion(resource,lot,nodeCount,neutralAnchor))continue;
      if(neutralAnchor){
        const rally={xMm:neutralAnchor.center.xMm,zMm:neutralAnchor.center.zMm+12000};
        // The protected first patch bounds each region's nearest walking access.
        // Further physical stock may extend away from it, but never closer than
        // the common lower bound. Final reachability still checks every node.
        if(lotDistanceFloor(resource,lot,nodeCount,rally)<outerDistanceFloor.get(resource)!){
          const closest=outerMetric!.walkingDistance(rally,lotNodes(resource,lot,nodeCount).flatMap(workPoints),outerDistanceFloor.get(resource)!);
          if(outerMetric!.diagnostics.exhausted)throw new Error('LONG_WAR_STOCK_DISTANCE_WORK_LIMIT');
          if(closest!==null&&closest<outerDistanceFloor.get(resource)!)continue;
        }
      }
      commitLot(resource,lot,nodeCount,owner,neutralAnchor);
      return;
    }
    // Fill remaining legal space with smaller physical lots; never replace
    // missing objects by increasing a surviving object's stored resources.
    if(nodeCount>1){const first=Math.floor(nodeCount/2);place(resource,first,owner,neutralAnchor);place(resource,nodeCount-first,owner,neutralAnchor);return;}
    throw new Error(`RESOURCE_QUANTITY_PLACEMENT_FAILED:${resource}:${owner?.playerId??neutralAnchor?.playerId??'expansion'}:${outerPass?'outer':'remaining'}:${map.resources.filter(node=>node.resource===resource&&(owner?node.startRegion===owner.playerId:neutralAnchor?node.outerRegion===neutralAnchor.playerId:!node.startRegion)).length}:floor=${outerDistanceFloor.get(resource)??0}:free=${lotsFor(1).filter(lot=>lotClear(resource,lot,1)&&(!neutralAnchor||lotInRegion(resource,lot,1,neutralAnchor))).length}:freeGlobal=${lotsFor(1).filter(lot=>lotClear(resource,lot,1)).length}:reservations=${JSON.stringify(reservationCells)}:stock=${resource==='food'?'food':JSON.stringify(longWarStockRequirements(map,resource))}`);
  };
  const prepareOuterEntries=(resource:ResourceType,allocations:{spawn:MapSpawn;left:number}[]):void=>{
    if(!allocations.some(entry=>entry.left>0))return;
    const radius=units.villager.collisionRadiusM*1000,baseNav=new Navigation(map.widthMm,map.heightMm,staticObstacles(map),10000);
    const candidates=allocations.map(({spawn,left})=>{
      const count=Math.min(left,1),rally={xMm:spawn.center.xMm,zMm:spawn.center.zMm+12000};
      const lots=count?lotsFor(count).filter(lot=>(map.type!=='river_divide'||((lot.x+lot.width/2)*cell<map.widthMm/2)===(spawn.center.xMm<map.widthMm/2))&&lotClear(resource,lot,count)&&lotInRegion(resource,lot,count,spawn)).map(lot=>({lot,distance:lotDistanceFloor(resource,lot,count,rally)})).sort((a,b)=>a.distance-b.distance||a.lot.tie-b.lot.tie):[];
      return {spawn,count,rally,lots,measured:new Map<Lot,Position[]|null>()};
    });
    // Match actual walking distances around forests, not straight-line radii.
    // Each region gets a protected real entry in the same band. Remaining stock
    // stays outside its lower bound; final validation searches every work face.
    const failures:string[]=[];
    for(let floor=24000;floor<=192000;floor+=4000){
      const mask=occupied.slice();let nav=baseNav,valid=true;
      const plans:{spawn:MapSpawn;count:number;lot:Lot;path:Position[];rally:Position;entry:Position}[]=[];
      for(const candidate of candidates){
        if(!candidate.count)continue;let chosen=false,queries=0,minimumLength=Infinity,maximumLength=0;const sampled:Lot[]=[];
        const upper=floor*(1+balance.maps.startingTravelVariationFraction);
        const target=floor*.8;
        const ranked=candidate.lots.filter(entry=>entry.distance<=upper).sort((a,b)=>Math.abs(a.distance-target)-Math.abs(b.distance-target)||a.lot.tie-b.lot.tie);
        for(const {lot,distance:lower}of ranked){
          if(lower>upper)continue;
          if(sampled.some(prior=>Math.hypot(prior.x-lot.x,prior.z-lot.z)<3))continue;
          if(!lotClear(resource,lot,candidate.count,mask))continue;if(++queries>24)break;sampled.push(lot);
          const nodes=lotNodes(resource,lot,candidate.count),future=nav.withAdditionalObstacles(nodes.map((node,index)=>({id:`outer_${candidate.spawn.playerId}_${index}`,...node,...resourceWorkBounds(node)})));
          let path=candidate.measured.get(lot);
          if(path===undefined){if(++outerEntryQueries>768)throw new Error('LONG_WAR_ENTRY_SEARCH_BUDGET');const targets=nodes.flatMap(workPoints).sort((a,b)=>distance(a,candidate.rally)-distance(b,candidate.rally));path=outerMetric!.walkingRoute(candidate.rally,targets,upper)?.path??null;if(outerMetric!.diagnostics.exhausted)throw new Error('LONG_WAR_ENTRY_DISTANCE_WORK_LIMIT');if(path)candidate.measured.set(lot,path);}
          if(path){let prior=candidate.rally;if(!path.every(point=>{const clear=future.clearLine(prior,point,radius);prior=point;return clear;}))continue;}
          if(!path)continue;const length=pathLength(candidate.rally,path);
          minimumLength=Math.min(minimumLength,length);maximumLength=Math.max(maximumLength,length);
          if(length<floor||length>upper)continue;
          for(let n=0;n<candidate.count;n++)mask[(lot.z+Math.floor(n/lot.width))*columns+lot.x+n%lot.width]=1;
          protectTravel([candidate.rally,...path],mask);
          plans.push({spawn:candidate.spawn,count:candidate.count,lot,path,rally:candidate.rally,entry:path.at(-1)!});nav=future;chosen=true;break;
        }
        if(!chosen){failures.push(`${floor}:${candidate.spawn.playerId}:${candidate.lots.length}:${queries}:${Math.round(minimumLength)}-${Math.round(maximumLength)}`);valid=false;break;}
      }
      if(!valid)continue;
      outerDistanceFloor.set(resource,floor);
      for(const plan of plans){commitLot(resource,plan.lot,plan.count,undefined,plan.spawn,plan.entry);protectTravel([plan.rally,...plan.path],occupied);allocations.find(entry=>entry.spawn===plan.spawn)!.left-=plan.count;}
      return;
    }
    throw new Error(`NO_FAIR_LONG_WAR_OUTER_ENTRIES:${resource}:${failures.join(',')}`);
  };
  // Starting guarantees precede optional expansion packing across ALL resources:
  // neutral food or wood must never consume another home's mandatory gold space.
  if(outerPass)for(const resource of ['wood','food','gold','stone'] as const){
    if(resource!=='wood')prepareResourceApproaches();
    const patchLimit=resource==='wood'?balance.maps.resourceNodes.forestPatchLimit:10;
    const remaining=new Map(map.spawns.map(spawn=>[spawn.playerId,balance.maps.resourceNodes.starting[resource]-map.resources.filter(node=>node.startRegion===spawn.playerId&&node.resource===resource).length]));
    while([...remaining.values()].some(count=>count>0))for(const spawn of map.spawns){const left=remaining.get(spawn.playerId)!;if(left>0){const count=Math.min(left,patchLimit);place(resource,count,spawn);remaining.set(spawn.playerId,left-count);}}
  }
  if(outerPass)outerMetric=new GenerationResourceAccess({widthMm:map.widthMm,heightMm:map.heightMm,obstacles:staticObstacles(map),workerRadiusMm:units.villager.collisionRadiusM*1000,cellMm:1000,maxGeometryQueries:5000000});
  const preparedAllocations=new Map<ResourceType,{spawn:MapSpawn;left:number}[]>();
  if(outerPass)for(const resource of ['wood','gold','stone'] as const){
    prepareResourceApproaches();
    const perHome=longWarStockRequirements(map,resource).outer/map.spawns.length;
    const allocations=map.spawns.map(spawn=>({spawn,left:perHome}));
    prepareOuterEntries(resource,allocations);preparedAllocations.set(resource,allocations);
  }
  // Larger forest lots precede deposit clusters; each faction receives one lot
  // per round, then neutral expansions receive their exact remaining quantity.
  const packingOrder:ResourceType[]=outerPass?['wood',...(['gold','stone'] as ResourceType[]).sort((a,b)=>(outerDistanceFloor.get(b)??0)-(outerDistanceFloor.get(a)??0)),'food']:['wood','food','gold','stone'];
  for(const resource of packingOrder){
    const patchLimit=resource==='wood'?balance.maps.resourceNodes.forestPatchLimit:10;
    const expansionTarget=Array.from({length:expansionCount},(_,index)=>resources[index%4]).filter(type=>type===resource).length*balance.maps.resourceNodes.expansion[resource];
    const originalNeutral=map.resources.filter(node=>node.resource===resource&&!node.startRegion).length;
    const yieldPerNode=balance.maps.spawnResourceMinimum[resource]/balance.maps.resourceNodes.expansion[resource];
    const target=map.startingResourcePreset==='long_war'&&resource!=='food'?Math.ceil(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*map.spawns.length/yieldPerNode):0;
    const outer=outerPass&&resource!=='food'?longWarStockRequirements(map,resource).outer:0;
    const extra=outerPass?outer:Math.max(0,target-Math.max(expansionTarget,originalNeutral));
    if(resource==='food'||map.startingResourcePreset==='long_war'&&(resource!=='wood'||outer>0))prepareResourceApproaches();
    if(map.resources.length+extra>balance.rules.maxResourceNodes)throw new Error('RESOURCE_NODE_LIMIT');
    // Starting stock is already guaranteed. Give every home equal extra outer
    // stock before contested deposits consume the remaining legal approaches.
    // Round-robin placement uses the same ordinary-yield resource objects.
    const allocations=preparedAllocations.get(resource)??map.spawns.map((spawn,index)=>({spawn,left:Math.floor(outer/map.spawns.length)+(index<outer%map.spawns.length?1:0)}));
    if(!preparedAllocations.has(resource))prepareOuterEntries(resource,allocations);
    if(outerPass&&resource==='wood'&&outer>0){
      const floor=outerDistanceFloor.get(resource)!;
      const stock=allocations.map(allocation=>{
        const rally={xMm:allocation.spawn.center.xMm,zMm:allocation.spawn.center.zMm+12000};
        return {allocation,cursor:0,nodes:map.resources.filter(node=>node.resource==='wood'&&!node.startRegion&&!node.outerRegion&&withinOuterRegion(map,node,allocation.spawn)&&workPoints(node).every(point=>distance(point,rally)>=floor)).sort((a,b)=>distance(a,rally)-distance(b,rally))};
      });
      let changed=true;while(changed){changed=false;for(const entry of stock){if(!entry.allocation.left)continue;while(entry.cursor<entry.nodes.length&&entry.nodes[entry.cursor]!.outerRegion)entry.cursor++;if(entry.cursor>=entry.nodes.length)continue;entry.nodes[entry.cursor++]!.outerRegion=entry.allocation.spawn.playerId;entry.allocation.left--;changed=true;}}
    }
    while(allocations.some(entry=>entry.left>0))for(const entry of allocations){if(!entry.left)continue;const count=Math.min(entry.left,patchLimit);place(resource,count,undefined,entry.spawn);entry.left-=count;}
    if(outerPass&&resource==='wood'){
      const actual=map.resources.filter(node=>node.resource==='wood'&&!node.startRegion).length;
      for(let left=Math.max(0,Math.max(expansionTarget,target)-actual);left>0;left-=patchLimit)place(resource,Math.min(left,patchLimit));
      // Forest packing is now final. Share one exact1m component index so
      // deposits cannot be placed into pockets enclosed by new woodland.
      packingAccess=new GenerationResourceAccess({widthMm:map.widthMm,heightMm:map.heightMm,obstacles:staticObstacles(map),workerRadiusMm:units.villager.collisionRadiusM*1000,cellMm:1000,maxGeometryQueries:3000000});
      // A reachable deposit must not seal the last harvest edge of woodland.
      // Preserve one real approach per physical tree component before minerals
      // fill nearby cells; patch labels do not imply independent access.
      const woodland=forestClearingComponents(map.resources.flatMap((node,index)=>node.forest?[{...node,id:`resource_${index}`}]:[]));
      for(const members of woodland){
        let nearest=map.spawns[0]!,closest=Infinity;
        for(const spawn of map.spawns)for(const member of members){const gap=distance(spawn.center,member);if(gap<closest){closest=gap;nearest=spawn;}}
        const rally={xMm:nearest.center.xMm,zMm:nearest.center.zMm+12000},route=packingAccess.walkingRoute(rally,members.flatMap(workPoints));
        if(packingAccess.diagnostics.exhausted)throw new Error('LONG_WAR_WOODLAND_ACCESS_WORK_LIMIT');
        if(!route)throw new Error('UNREACHABLE_LONG_WAR_WOODLAND');
        protectTravel([rally,...route.path],occupied);
      }
    }
    if(outerPass)continue;
    const remaining=new Map(map.spawns.map(spawn=>[spawn.playerId,balance.maps.resourceNodes.starting[resource]-map.resources.filter(node=>node.startRegion===spawn.playerId&&node.resource===resource).length]));
    while([...remaining.values()].some(count=>count>0))for(const spawn of map.spawns){const left=remaining.get(spawn.playerId)!;if(left>0){const count=Math.min(left,patchLimit);place(resource,count,spawn);remaining.set(spawn.playerId,left-count);}}
    for(let left=Math.max(0,expansionTarget-originalNeutral)+extra-outer;left>0;left-=patchLimit)place(resource,Math.min(left,patchLimit));
  }
  if(outerPass)for(const resource of ['wood','food','gold','stone'] as const){
    if(resource!=='wood')prepareResourceApproaches();
    const baselineCount=Array.from({length:expansionCount},(_,index)=>resources[index%4]).filter(type=>type===resource).length*balance.maps.resourceNodes.expansion[resource];
    const target=resource==='food'?baselineCount:Math.max(baselineCount,longWarStockRequirements(map,resource).target);
    const actual=map.resources.filter(node=>node.resource===resource&&!node.startRegion).length,patchLimit=resource==='wood'?balance.maps.resourceNodes.forestPatchLimit:10;
    for(let left=Math.max(0,target-actual);left>0;left-=patchLimit)place(resource,Math.min(left,patchLimit));
  }
  if(map.startingResourcePreset==='long_war'){
    if(map.validation.forestBelts){
      const baseWood=Array.from({length:expansionCount},(_,index)=>resources[index%4]).filter(resource=>resource==='wood').length*balance.maps.resourceNodes.expansion.wood;
      map.validation.forestBelts.extraTreeNodes=Math.max(0,map.resources.filter(node=>!node.startRegion&&node.resource==='wood').length-baseWood);
    }
  }
  // All complete witnesses are reserved before packing; verify actual final
  // geometry rather than treating those reservations as a proof by themselves.
  const final=validateBroadMapRoutes({widthMm:map.widthMm,heightMm:map.heightMm,obstacles:staticObstacles(map),settlements:map.spawns.map(spawn=>({playerId:spawn.playerId,...spawn.center,clearanceRadiusMm:balance.maps.naturalBarriers.stagingRegionM*1000,origin:broadOrigin(map,spawn)})),passageWidthMm:balance.maps.naturalBarriers.minimumRouteWidthM*1000,maxUnitRadiusMm:maximumMapRadius(map)});
  if(!final.valid)throw new Error(`RESOURCE_ROUTE_REPAIR_FAILED:${final.failure??final.pairs.find(entry=>entry.routeCount<2)?.reason??'UNKNOWN'}`);
  return baseline;
}

export function buildCandidate(options:MapOptions,attempt:number):GeneratedMap {
  const count=options.factions.length,size=options.mapSize&&options.mapSize!=='auto'?balance.maps.sizes.find(size=>size.id===options.mapSize)!:balance.maps.sizes.find(size=>count>=size.factions[0]!&&count<=size.factions[1]!)!,width=size.cells[0]!*grid,height=size.cells[1]!*grid,type=options.mapType??'open_frontier';
  const terrainRng=new SeededRandom(sha256(`terrain:${options.seed}`)),placement=new SeededRandom(sha256(`placement:${options.seed}:${attempt}`));
  const resolved=resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset);
  const map:GeneratedMap={rulesetId:resolved.rulesetId,maxAge:resolved.maxAge,startingResourcePreset:resolved.startingResourcePreset,type,generatorVersion:MAP_GENERATOR_VERSION,seed:String(options.seed),widthMm:width,heightMm:height,terrain:landforms(type,width,height,terrainRng),spawns:[],resources:[],forestFrontiers:[],validation:emptyValidation()};
  const centers=separatedStarts(map,options.factions,placement,attempt);
  for(const [index,faction]of options.factions.entries()){
    const spawn=startingLayout(faction.id,centers.get(faction.id)!);
    if(!publicPassable(map,spawn.center,40000))throw new Error('SPAWN_TERRAIN_CONFLICT');
    if(map.spawns.some(other=>distance(other.center,spawn.center)<balance.maps.naturalBarriers.minimumStartSeparationM*1000))throw new Error('SPAWN_OVERLAP');
    map.spawns.push(spawn);map.resources.push(...startingResources(spawn,placement,`forest_${sha256(`forest:${options.seed}:${attempt}:start:${index}`).slice(0,32)}`,width,height));
  }
  const expansionCount=Math.max(4,count*2);
  addForestBelts(map,options.factions,territoryAxes(map),staticObstacles(map),attempt,(position,owner,serial)=>({
    ...position,resource:'wood',typeId:typeFor('wood',placement),amount:balance.maps.spawnResourceMinimum.wood/(owner?balance.maps.resourceNodes.starting.wood:balance.maps.resourceNodes.expansion.wood),...(owner?{startRegion:owner}:{}),forest:{cellMm:forestCellMm,patchId:`forest_${sha256(`forest:${options.seed}:${attempt}:belt:${owner??'expansion'}:${Math.floor(serial/balance.maps.resourceNodes.forestPatchLimit)}`).slice(0,32)}`}
  }));
  addResourceQuantity(map,placement,options,attempt,expansionCount);
  map.validation.attempt=attempt+1;map.validation.expansionPatches=expansionCount;
  return map;
}

const workPoints=(node:MapResource):Position[]=>resourceWorkPoints(node,units.villager.collisionRadiusM*1000);
const pathLength=(start:Position,path:Position[])=>{let total=0,prior=start;for(const point of path){total+=distance(prior,point);prior=point;}return total;};

/** Validates actual walking routes, rather than treating straight-line distance as reachability. */
export function validateGeneratedMap(map:GeneratedMap):MapValidation {
  const forestGuarantees=map.generatorVersion==='7.0.0'||map.generatorVersion==='7.0.1';
  const forestBelts=forestGuarantees?validateForestBeltSummary({frontiers:map.forestFrontiers,resources:map.resources,factionCount:map.spawns.length,summary:map.validation.forestBelts}):map.validation.forestBelts;
  const size=balance.maps.sizes.find(size=>map.widthMm===size.cells[0]!*grid&&map.heightMm===size.cells[1]!*grid);
  if(!size||map.spawns.length<2||map.spawns.length>size.factions[1]!)throw new Error('INVALID_MAP_DIMENSIONS');
  if(!balance.maps.types.includes(map.type)||new Set(map.spawns.map(spawn=>spawn.playerId)).size!==map.spawns.length)throw new Error('INVALID_MAP_SPAWNS');
  if(map.resources.length>balance.rules.maxResourceNodes)throw new Error('RESOURCE_NODE_LIMIT');
  const expectedExpansion=zero();for(let index=0;index<Math.max(4,map.spawns.length*2);index++)expectedExpansion[resources[index%4]!]+=balance.maps.resourceNodes.expansion[resources[index%4]!];
  if(map.startingResourcePreset==='long_war')for(const resource of ['gold','stone'] as const){
    const yieldPerNode=balance.maps.spawnResourceMinimum[resource]/balance.maps.resourceNodes.expansion[resource];
    expectedExpansion[resource]=Math.max(expectedExpansion[resource],Math.ceil(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*map.spawns.length/yieldPerNode));
  }
  for(const owner of [...map.spawns.map(spawn=>spawn.playerId),undefined])for(const resource of resources)if(map.resources.filter(node=>node.startRegion===owner&&node.resource===resource).length!==(owner?balance.maps.resourceNodes.starting[resource]:expectedExpansion[resource]+(resource==='wood'?(forestBelts?.extraTreeNodes??0):0)))throw new Error('INVALID_RESOURCE_QUANTITY');
  for(const node of map.resources)if(node.amount!==balance.maps.spawnResourceMinimum[node.resource]/(node.startRegion?balance.maps.resourceNodes.starting:balance.maps.resourceNodes.expansion)[node.resource])throw new Error('INVALID_RESOURCE_YIELD');
  if(map.terrain.some(region=>!Number.isSafeInteger(region.xMm)||!Number.isSafeInteger(region.zMm)||!Number.isSafeInteger(region.widthMm)||!Number.isSafeInteger(region.depthMm)||region.xMm<0||region.zMm<0||region.widthMm<=0||region.depthMm<=0||region.xMm+region.widthMm>map.widthMm||region.zMm+region.depthMm>map.heightMm))throw new Error('INVALID_TERRAIN_BOUNDS');
  validateNaturalBarriers(map);
  for(const [index,spawn]of map.spawns.entries()){
    if(!publicPassable(map,spawn.center,40000)||map.spawns.slice(0,index).some(other=>distance(other.center,spawn.center)<balance.maps.naturalBarriers.minimumStartSeparationM*1000))throw new Error('INVALID_MAP_SPAWNS');
    for(const [typeId,count]of Object.entries(balance.start.buildings))if(spawn.buildings.filter(building=>building.typeId===typeId).length!==count)throw new Error('INVALID_STARTING_COUNTS');
    for(const [typeId,count]of Object.entries(balance.start.units))if(spawn.units.filter(unit=>unit.typeId===typeId).length!==count)throw new Error('INVALID_STARTING_COUNTS');
    if(spawn.buildings.length!==Object.values(balance.start.buildings).reduce((a,b)=>a+b,0)||spawn.units.length!==Object.values(balance.start.units).reduce((a,b)=>a+b,0))throw new Error('INVALID_STARTING_COUNTS');
  }
  const terrainNav=new Navigation(map.widthMm,map.heightMm,terrainObstacles(map.terrain));
  const placedResources=new ResourcePlacementIndex();
  for(const node of map.resources){
    if(!resources.includes(node.resource)||!Number.isSafeInteger(node.amount)||node.amount<=0||!Number.isSafeInteger(node.xMm)||!Number.isSafeInteger(node.zMm)||!terrainNav.free(node,resourceRadius(node.resource)))throw new Error('INVALID_RESOURCE_NODE');
    if(node.startRegion&&!map.spawns.some(spawn=>spawn.playerId===node.startRegion))throw new Error('INVALID_STARTING_RESOURCE_OWNER');
    if(node.outerRegion&&(node.startRegion||map.startingResourcePreset!=='long_war'||!map.spawns.some(spawn=>spawn.playerId===node.outerRegion)))throw new Error('INVALID_OUTER_RESOURCE_REGION');
    if(node.outerEntry&&(!node.outerRegion||!workPoints(node).some(point=>point.xMm===node.outerEntry!.xMm&&point.zMm===node.outerEntry!.zMm)))throw new Error('INVALID_OUTER_RESOURCE_ENTRY');
    if(node.forest&&(node.resource!=='wood'||node.forest.cellMm!==forestCellMm||!/^[_A-Za-z0-9-]{1,96}$/.test(node.forest.patchId)||!terrainNav.free(node,node.forest.cellMm/2)||!terrainBuildable(map.terrain,{xMm:node.xMm-node.forest.cellMm/2,zMm:node.zMm-node.forest.cellMm/2,widthMm:node.forest.cellMm,depthMm:node.forest.cellMm})))throw new Error('INVALID_FOREST_CELL');
    if(placedResources.overlaps(node))throw new Error('RESOURCE_OVERLAP');placedResources.add(node);
  }
  const obstacles=staticObstacles(map),nav=new Navigation(map.widthMm,map.heightMm,obstacles),radius=units.villager.collisionRadiusM*1000;
  if(forestGuarantees&&!map.forestFrontiers)throw new Error('MISSING_FOREST_FRONTIERS');
  const frontiers=validateForestFrontiers({widthMm:map.widthMm,heightMm:map.heightMm,obstacles,frontiers:map.forestFrontiers??[],terrain:map.terrain});
  if(!frontiers.valid)throw new Error(`INVALID_FOREST_FRONTIER:${frontiers.failure}:${frontiers.frontierId??''}`);
  const report:MapValidation={...emptyValidation(),attempt:map.validation.attempt,expansionPatches:map.validation.expansionPatches,resourceNodes:map.resources.length,...(forestBelts?{forestBelts}:{})};
  const resourceIds=new Map(map.resources.map((node,index)=>[node,`resource_${index}`]));
  const accessOptions={widthMm:map.widthMm,heightMm:map.heightMm,obstacles,workerRadiusMm:radius,cellMm:1000,...(map.startingResourcePreset==='long_war'?{maxGeometryQueries:5000000}:{})};
  const access=new GenerationResourceAccess(accessOptions),river=map.type==='river_divide'?map.terrain.find(region=>region.id==='river'&&region.kind==='water'):undefined;
  const bankAccess=river?[new GenerationResourceAccess({...accessOptions,bounds:{maxXMm:river.xMm-1}}),new GenerationResourceAccess({...accessOptions,bounds:{minXMm:river.xMm+river.widthMm+1}})]:[access,access];
  const patches=new Map<string,(MapResource&{id:string})[]>();for(const node of map.resources)if(node.forest){const members=patches.get(node.forest.patchId)??[];members.push({...node,id:resourceIds.get(node)!});patches.set(node.forest.patchId,members);}
  for(const members of patches.values())if(members.length>balance.maps.resourceNodes.forestPatchLimit||members.some(member=>member.startRegion!==members[0]!.startRegion))throw new Error('INVALID_FOREST_PATCH');
  const components=forestClearingComponents([...patches.values()].flat()),componentById=new Map(components.flatMap((members,index)=>members.map(member=>[member.id,index] as const)));
  const provedComponents=new Map<number,{anchor:Position;from:Set<string>}>();
  const provePatch=(node:MapResource,start:Position,approachIndex:GenerationResourceAccess,legalPath?:(path:readonly Position[])=>boolean)=>{
    if(!node.forest)return true;
    const component=componentById.get(resourceIds.get(node)!)!,members=components[component]!,key=`${start.xMm},${start.zMm}`,proved=provedComponents.get(component);
    if(proved){if(proved.from.has(key))return true;if(!approachIndex.reachable(start,proved.anchor))return false;proved.from.add(key);return true;}
    // Connected woodland can span several bounded metadata patches. Prove its
    // initially reachable edge, then actual monotonic clearing of the complete
    // physical component; neighboring patch IDs do not create imaginary aisles.
    let anchor:Position|undefined;
    for(const member of [...members].sort((a,b)=>distance(a,start)-distance(b,start))){
      for(const point of workPoints(member)){
        if(!nav.free(point,radius))continue;
        if(approachIndex.reachable(start,point)){anchor=point;break;}
      }
      if(anchor)break;
    }
    if(!anchor||!proveForestClearing(map.widthMm,map.heightMm,obstacles,members,anchor,radius,legalPath))return false;
    provedComponents.set(component,{anchor,from:new Set([key])});return true;
  };
  const rallies:Position[]=[];
  for(const spawn of map.spawns){
    for(const [index,building]of spawn.buildings.entries()){
      const dimensions=buildings[building.typeId].footprintCells,[w,d]=building.rotation===90||building.rotation===270?[dimensions[1],dimensions[0]]:dimensions;
      const footprint={xMm:building.position.xMm-w*grid/2,zMm:building.position.zMm-d*grid/2,widthMm:w*grid,depthMm:d*grid};
      if(footprint.xMm<0||footprint.zMm<0||footprint.xMm+footprint.widthMm>map.widthMm||footprint.zMm+footprint.depthMm>map.heightMm||!terrainBuildable(map.terrain,footprint)||obstacles.some(o=>o.id!==`start_${spawn.playerId}_${index}`&&Math.abs(o.xMm-building.position.xMm)<o.halfWidth+w*grid/2&&Math.abs(o.zMm-building.position.zMm)<o.halfHeight+d*grid/2))throw new Error('INVALID_STARTING_BUILDING');
    }
    const rally={xMm:spawn.center.xMm,zMm:spawn.center.zMm+12000};
    if(!nav.free(rally,radius))throw new Error('BLOCKED_STARTING_AREA');
    for(const [index,unit]of spawn.units.entries()){const unitRadius=units[unit.typeId].collisionRadiusM*1000;if(!nav.free(unit.position,unitRadius)||!nav.path(unit.position,rally,unitRadius)||spawn.units.slice(0,index).some(other=>distance(unit.position,other.position)<unitRadius+units[other.typeId].collisionRadiusM*1000))throw new Error('TRAPPED_STARTING_UNIT');}
    rallies.push(rally);
    const total=zero(),travel=zero(),own=map.resources.filter(node=>node.startRegion===spawn.playerId);
    for(const node of own){
      total[node.resource]+=node.amount;
      if(river&&(spawn.center.xMm<river.xMm)!==(node.xMm<river.xMm))throw new Error('CROSS_BANK_STARTING_RESOURCE');
      const legalPath=(path:readonly Position[])=>!river||path.every(p=>spawn.center.xMm<river.xMm?p.xMm<river.xMm:p.xMm>river.xMm+river.widthMm);
      const approachIndex=bankAccess[river&&spawn.center.xMm>river.xMm?1:0]!;
      const reachable=node.forest?provePatch(node,rally,approachIndex,legalPath):workPoints(node).some(point=>approachIndex.reachable(rally,point));
      if(!reachable)throw new Error(`UNREACHABLE_STARTING_RESOURCE:${node.resource}`);
    }
    for(const resource of resources){
      if(total[resource]<balance.maps.spawnResourceMinimum[resource])throw new Error('INSUFFICIENT_STARTING_RESOURCES');
      const candidates=own.filter(node=>node.resource===resource).sort((a,b)=>distance(a,spawn.center)-distance(b,spawn.center));
      const nearest=resource==='wood'?candidates.filter(node=>workPoints(node).some(point=>nav.free(point,radius))).slice(0,3):candidates.slice(0,3);
      const half=buildings.town_center.footprintCells[0]*grid/2;
      let shortest=Infinity;
      for(const node of nearest){
        const dropoff={xMm:Math.max(spawn.center.xMm-half-radius-100,Math.min(spawn.center.xMm+half+radius+100,node.xMm)),zMm:Math.max(spawn.center.zMm-half-radius-100,Math.min(spawn.center.zMm+half+radius+100,node.zMm))};
        for(const point of workPoints(node)){const path=nav.path(dropoff,point,radius);if(path)shortest=Math.min(shortest,pathLength(dropoff,path));}
      }
      const limit=resource==='food'||resource==='wood'?30000:45000;
      if(!Number.isFinite(shortest)||shortest>limit)throw new Error('STARTING_TRAVEL_LIMIT');
      travel[resource]=Math.round(shortest);
    }
    report.spawnReports.push({playerId:spawn.playerId,resources:total,travelMm:travel});
  }
  for(const resource of resources){const distances=report.spawnReports.map(spawn=>spawn.travelMm[resource]);const variation=Math.max(...distances)/Math.min(...distances)-1;if(variation>balance.maps.startingTravelVariationFraction)throw new Error('STARTING_TRAVEL_VARIATION');report.travelVariation[resource]=variation;}
  const broad=validateBroadMapRoutes({widthMm:map.widthMm,heightMm:map.heightMm,obstacles,settlements:map.spawns.map((spawn,index)=>({playerId:spawn.playerId,...spawn.center,clearanceRadiusMm:balance.maps.naturalBarriers.stagingRegionM*1000,origin:broadOrigin(map,spawn)})),passageWidthMm:balance.maps.naturalBarriers.minimumRouteWidthM*1000,maxUnitRadiusMm:maximumMapRadius(map)});
  if(!broad.valid){const failed=broad.pairs.find(pair=>pair.routeCount<2);throw new Error(`INSUFFICIENT_BROAD_ROUTES:${broad.failure??failed?.reason??'UNKNOWN'}:${failed?.fromPlayerId??''}:${failed?.toPlayerId??''}`);}
  report.broadRoutes={minimumWidthMm:balance.maps.naturalBarriers.minimumRouteWidthM*1000,independentRoutes:2,verifiedPairs:broad.pairs.length,sampledCells:broad.sampledCells};
  for(const node of map.resources.filter(node=>!node.startRegion)){
    const start=[...rallies].sort((a,b)=>distance(a,node)-distance(b,node))[0]!;
    if(node.forest?!provePatch(node,start,access):!workPoints(node).some(point=>access.reachable(start,point)))throw new Error(`ISOLATED_EXPANSION_RESOURCE:${node.resource}:${node.xMm},${node.zMm}:${node.outerRegion??'shared'}:${JSON.stringify(access.diagnostics)}`);
  }
  for(const bridge of map.terrain.filter(region=>region.kind==='bridge')){
    const a={xMm:bridge.xMm-1000,zMm:bridge.zMm+bridge.depthMm/2},b={xMm:bridge.xMm+bridge.widthMm+1000,zMm:bridge.zMm+bridge.depthMm/2};
    if(!nav.clearLine(a,b,maximumMapRadius(map)))throw new Error('UNUSABLE_CROSSING');
  }
  if(map.startingResourcePreset==='long_war')for(const resource of ['wood','gold','stone'] as const){
    const amount=map.resources.reduce((sum,node)=>sum+(!node.startRegion&&node.resource===resource?node.amount:0),0);
    if(amount<legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*map.spawns.length)throw new Error('INSUFFICIENT_LONG_WAR_RESOURCE');
  }
  const homeSites=legendaryHomeSites(map);
  if(homeSites.length||map.startingResourcePreset==='long_war'){
    for(const site of homeSites){
      const plots=legendaryPlotObstacles(site),future=nav.withAdditionalObstacles(plots),rally=rallies[map.spawns.findIndex(spawn=>spawn.playerId===site.playerId)]!,giantRadius=Math.max(4000,maximumMapRadius(map));
      for(const plot of plots){
        const rectangle={xMm:plot.xMm-plot.halfWidth,zMm:plot.zMm-plot.halfHeight,widthMm:plot.halfWidth*2,depthMm:plot.halfHeight*2};
        if(rectangle.xMm<0||rectangle.zMm<0||rectangle.xMm+rectangle.widthMm>map.widthMm||rectangle.zMm+rectangle.depthMm>map.heightMm||!terrainBuildable(map.terrain,rectangle)||obstacles.some(obstacle=>{
          const clearance=obstacle.id.startsWith('resource_')?balance.rules.treeBuildingClearanceM*1000:balance.rules.nonTreeBuildingClearanceM*1000;
          return Math.abs(obstacle.xMm-plot.xMm)<obstacle.halfWidth+plot.halfWidth+clearance&&Math.abs(obstacle.zMm-plot.zMm)<obstacle.halfHeight+plot.halfHeight+clearance;
        }))throw new Error('INVALID_LEGENDARY_HOME_PLOT');
        const approaches=[{xMm:plot.xMm+plot.halfWidth+radius+100,zMm:plot.zMm},{xMm:plot.xMm-plot.halfWidth-radius-100,zMm:plot.zMm},{xMm:plot.xMm,zMm:plot.zMm+plot.halfHeight+radius+100},{xMm:plot.xMm,zMm:plot.zMm-plot.halfHeight-radius-100}];
        if(!approaches.some(point=>future.path(rally,point,radius)))throw new Error('UNREACHABLE_LEGENDARY_HOME_PLOT');
      }
      if(!future.free(site.giantExit,giantRadius)||!future.path(site.giantExit,broadOrigin(map,map.spawns.find(spawn=>spawn.playerId===site.playerId)!),giantRadius))throw new Error('BLOCKED_LEGENDARY_YARD_EXIT');
    }
    const totals=zero(),variation=zero();for(const node of map.resources)if(!node.startRegion)totals[node.resource]+=node.amount;
    if(map.startingResourcePreset==='long_war')for(const resource of ['wood','gold','stone'] as const){
      const distances:number[]=[];
      const {baseline,additional,outer}=longWarStockRequirements(map,resource);
      if(map.resources.filter(node=>node.resource===resource&&!node.startRegion&&!node.outerRegion).length<baseline+additional-outer)throw new Error('INSUFFICIENT_LONG_WAR_CONTESTED_STOCK');
      for(const [index,spawn]of map.spawns.entries()){
        const candidates=map.resources.filter(node=>node.outerRegion===spawn.playerId&&node.resource===resource).sort((a,b)=>distance(a,rallies[index]!)-distance(b,rallies[index]!));
        const expected=Math.floor(outer/map.spawns.length)+(index<outer%map.spawns.length?1:0);
        if(candidates.length!==expected)throw new Error('INVALID_LONG_WAR_OUTER_ALLOCATION');
        if(!candidates.length)continue;
        for(const node of candidates){
          if(!withinOuterRegion(map,node,spawn))throw new Error('CROSS_REGION_OUTER_RESOURCE');
          if(node.forest?!provePatch(node,rallies[index]!,access):!workPoints(node).some(point=>access.reachable(rallies[index]!,point)))throw new Error('UNREACHABLE_LONG_WAR_OUTER_STOCK');
        }
        const entries=candidates.flatMap(node=>node.outerEntry?[node.outerEntry]:[]);
        if(!entries.length)throw new Error('MISSING_LONG_WAR_OUTER_ENTRY');
        // Independently measure the actual entry route after all stock is placed.
        // Regional membership, exact counts and every node's owner access are
        // checked above; reserved paths are never accepted as reachability proof.
        const nearest=access.walkingDistance(rallies[index]!,candidates.flatMap(workPoints));
        if(access.diagnostics.exhausted)throw new Error('LONG_WAR_FINAL_DISTANCE_WORK_LIMIT');
        if(nearest===null)throw new Error('UNREACHABLE_LONG_WAR_OUTER_RESOURCE');
        distances.push(nearest);
      }
      if(distances.length&&distances.length!==map.spawns.length)throw new Error('ASYMMETRIC_LONG_WAR_OUTER_RESOURCE');
      // The same defined1m clearance-graph metric chooses and independently
      // validates nearest stock. Runtime Navigation retains its direct fastpath.
      if(distances.length){variation[resource]=Math.max(...distances)/Math.min(...distances)-1;if(variation[resource]>balance.maps.startingTravelVariationFraction)throw new Error(`LONG_WAR_OUTER_TRAVEL_VARIATION:${resource}:${variation[resource].toFixed(3)}`);}
    }
    report.longWar={homeSites,nonStartingResources:totals,outerAccessVariation:variation};
  }
  report.connected=true;return report;
}

/** Crowded allied Long War homes need different setbacks before more variants
 * of the same setback. Interleave existing candidates; neither the first
 * candidate, private placement seed nor any geometry proof changes. */
export function mapGenerationAttempts(options:MapOptions):number[] {
  const attempts=Array.from({length:balance.maps.maxGenerationAttempts},(_,attempt)=>attempt);
  if((options.mapType??'open_frontier')!=='open_frontier'||options.factions.length<=balance.maps.sizes.find(size=>size.id==='medium')!.factions[1]!||new Set(options.factions.map(faction=>faction.teamId)).size===options.factions.length)return attempts;
  // Ordering must not change the generator's existing invalid-content errors.
  try{if(resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset).startingResourcePreset!=='long_war')return attempts;}catch{return attempts;}
  const buckets=Array.from({length:startInsetLevels},(_,inset)=>attempts.filter(attempt=>Math.floor(attempt/startLayoutsPerInset)%startInsetLevels===inset)),ordered:number[]=[];
  for(let index=0;ordered.length<attempts.length;index++)for(const bucket of buckets)if(bucket[index]!==undefined)ordered.push(bucket[index]!);
  return ordered;
}

export function generateMap(options:MapOptions):GeneratedMap {
  if(options.factions.length<2||options.factions.length>balance.rules.factionLimit||new Set(options.factions.map(f=>f.id)).size!==options.factions.length)throw new Error('INVALID_MAP_FACTIONS');
  if(options.mapType!==undefined&&!balance.maps.types.includes(options.mapType))throw new Error('INVALID_MAP_TYPE');
  if(options.mapSize!==undefined&&options.mapSize!=='auto'){
    const requested=balance.maps.sizes.find(size=>size.id===options.mapSize);if(!requested)throw new Error('INVALID_MAP_SIZE');if(options.factions.length>requested.factions[1]!)throw new Error('MAP_SIZE_TOO_SMALL');
  }
  let lastFailure='UNKNOWN';
  for(const attempt of mapGenerationAttempts(options))try{const map=buildCandidate(options,attempt);map.validation=validateGeneratedMap(map);return map;}catch(error){lastFailure=error instanceof Error?error.message:'UNKNOWN';}
  throw new Error(`MAP_GENERATION_FAILED:${lastFailure}`);
}
