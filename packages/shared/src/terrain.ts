import { balance } from './content.js';

/** Public landform geometry. This contains no placement seed, spawn or resource records. */
export interface TerrainRectangle { xMm:number;zMm:number;widthMm:number;depthMm:number }
/** Construction clearance includes resource art and building/gate overhangs;
 * walking and gathering retain their separate physical/work bounds. Content
 * validation keeps non-tree clearance within the already-observed tree halo. */
export function resourcePlacementBounds(node:{resource?:string;forest?:{cellMm:number}},treeClearanceMm:number):{halfWidth:number;halfHeight:number}{
  const half=node.resource==='wood'?Math.max(treeClearanceMm,(node.forest?.cellMm??0)/2):balance.rules.nonTreeBuildingClearanceM*1000;
  return {halfWidth:half,halfHeight:half};
}
/** Observe the clearance halo before occupancy tests, so hidden trees cannot be probed. */
export function placementAreaVisible(rect:TerrainRectangle,widthMm:number,heightMm:number,fogCellMm:number,clearanceMm:number,visible:(xMm:number,zMm:number)=>boolean):boolean{
  const left=Math.max(0,Math.floor((rect.xMm-clearanceMm)/fogCellMm)),top=Math.max(0,Math.floor((rect.zMm-clearanceMm)/fogCellMm));
  const right=Math.ceil(Math.min(widthMm,rect.xMm+rect.widthMm+clearanceMm)/fogCellMm),bottom=Math.ceil(Math.min(heightMm,rect.zMm+rect.depthMm+clearanceMm)/fogCellMm);
  for(let z=top;z<bottom;z++)for(let x=left;x<right;x++)if(!visible(Math.min(widthMm-1,(x+.5)*fogCellMm),Math.min(heightMm-1,(z+.5)*fogCellMm)))return false;
  return true;
}
interface RegionBase extends TerrainRectangle { id:string }
export type TerrainRegion =
  | (RegionBase & {kind:'water'|'bridge'|'plateau'|'cliff'|'hill'|'ridge';elevationMm:number})
  | (RegionBase & {kind:'ramp';axis:'x'|'z';startElevationMm:number;endElevationMm:number});
export interface TerrainObstacle {id:string;xMm:number;zMm:number;halfWidth:number;halfHeight:number}
const contains=(r:TerrainRectangle,x:number,z:number)=>x>=r.xMm&&z>=r.zMm&&x<=r.xMm+r.widthMm&&z<=r.zMm+r.depthMm;
const overlaps=(a:TerrainRectangle,b:TerrainRectangle)=>a.xMm<b.xMm+b.widthMm&&a.xMm+a.widthMm>b.xMm&&a.zMm<b.zMm+b.depthMm&&a.zMm+a.depthMm>b.zMm;

/** Rocky, non-navigable relief contained entirely in its rectangular collision foot.
 * Only public geometry affects this profile; it cannot disclose a placement seed.
 * A raised rock edge makes the full blocked footprint apparent, including corners.
 */
export function ridgeHeightAt(region:TerrainRectangle&{elevationMm:number},xMm:number,zMm:number):number {
  if(!contains(region,xMm,zMm))return 0;
  const nx=(xMm-region.xMm)*2/region.widthMm-1,nz=(zMm-region.zMm)*2/region.depthMm-1;
  const along=region.widthMm>=region.depthMm?nx:nz,across=region.widthMm>=region.depthMm?nz:nx;
  const shoulder=Math.min(1,Math.max(0,1-Math.abs(nx))*3.5,Math.max(0,1-Math.abs(nz))*3.5);
  const crest=Math.max(.78-Math.abs(along+.56)*1.6,1-Math.abs(along-.08)*1.8,.84-Math.abs(along-.62)*2);
  const fold=1-.25*Math.abs(across+.12*Math.sin(along*11));
  return Math.round(region.elevationMm*(.10+.90*shoulder*Math.max(.22,crest)*fold));
}

/** Integer millimeter elevation, sampled identically by simulation and renderer. */
export function terrainHeightAt(terrain:readonly TerrainRegion[],xMm:number,zMm:number):number {
  let elevation=0;
  for(const region of terrain)if(region.kind==='water'&&contains(region,xMm,zMm))elevation=region.elevationMm;
  for(const region of terrain)if(region.kind!=='water'&&region.kind!=='bridge'&&region.kind!=='ramp'&&contains(region,xMm,zMm)){
    if(region.kind==='ridge')elevation=Math.max(elevation,ridgeHeightAt(region,xMm,zMm));
    else if(region.kind==='hill'){
      const nx=(xMm-(region.xMm+region.widthMm/2))/(region.widthMm/2),nz=(zMm-(region.zMm+region.depthMm/2))/(region.depthMm/2),r2=nx*nx+nz*nz;
      if(r2<1)elevation=Math.max(elevation,Math.round(region.elevationMm*(1-r2)**2));
    }else elevation=Math.max(elevation,region.elevationMm);
  }
  for(const region of terrain)if(contains(region,xMm,zMm)){
    if(region.kind==='bridge')elevation=region.elevationMm;
    if(region.kind==='ramp'){const t=region.axis==='x'?(xMm-region.xMm)/region.widthMm:(zMm-region.zMm)/region.depthMm;elevation=Math.round(region.startElevationMm+(region.endElevationMm-region.startElevationMm)*t);}
  }
  return elevation;
}

function subtract(rect:TerrainRectangle,passage:TerrainRectangle):TerrainRectangle[]{
  if(!overlaps(rect,passage))return [rect];
  const left=Math.max(rect.xMm,passage.xMm),right=Math.min(rect.xMm+rect.widthMm,passage.xMm+passage.widthMm),top=Math.max(rect.zMm,passage.zMm),bottom=Math.min(rect.zMm+rect.depthMm,passage.zMm+passage.depthMm),pieces:TerrainRectangle[]=[];
  if(top>rect.zMm)pieces.push({...rect,depthMm:top-rect.zMm});
  if(bottom<rect.zMm+rect.depthMm)pieces.push({...rect,zMm:bottom,depthMm:rect.zMm+rect.depthMm-bottom});
  if(left>rect.xMm)pieces.push({xMm:rect.xMm,zMm:top,widthMm:left-rect.xMm,depthMm:bottom-top});
  if(right<rect.xMm+rect.widthMm)pieces.push({xMm:right,zMm:top,widthMm:rect.xMm+rect.widthMm-right,depthMm:bottom-top});
  return pieces;
}
/** Bridges cut water and ramps cut cliff barriers; the same descriptors render the crossing. */
export function terrainObstacles(terrain:readonly TerrainRegion[]):TerrainObstacle[]{
  const result:TerrainObstacle[]=[];
  for(const region of terrain)if(region.kind==='water'||region.kind==='cliff'||region.kind==='ridge'){
    let pieces:TerrainRectangle[]=[region];
    for(const passage of terrain)if((region.kind==='water'&&passage.kind==='bridge')||(region.kind==='cliff'&&passage.kind==='ramp'))pieces=pieces.flatMap(piece=>subtract(piece,passage));
    for(const [index,piece]of pieces.entries())result.push({id:`terrain_${region.id}_${index}`,xMm:piece.xMm+piece.widthMm/2,zMm:piece.zMm+piece.depthMm/2,halfWidth:piece.widthMm/2,halfHeight:piece.depthMm/2});
  }
  return result;
}

/** A planned site may use explored ground without revealing current occupants.
 * Public impassable land outside the footprint needs no exploration: a wall can
 * meet a mountain face without scouting inside the mountain. Partly blocked
 * cells and actual bridge/ramp passages still require discovery. */
export function placementAreaDiscovered(rect:TerrainRectangle,widthMm:number,heightMm:number,fogCellMm:number,clearanceMm:number,explored:(xMm:number,zMm:number)=>boolean,terrain:readonly TerrainRegion[]):boolean{
  const halo={xMm:Math.max(0,rect.xMm-clearanceMm),zMm:Math.max(0,rect.zMm-clearanceMm),widthMm:0,depthMm:0};
  halo.widthMm=Math.min(widthMm,rect.xMm+rect.widthMm+clearanceMm)-halo.xMm;
  halo.depthMm=Math.min(heightMm,rect.zMm+rect.depthMm+clearanceMm)-halo.zMm;
  const left=Math.floor(halo.xMm/fogCellMm),top=Math.floor(halo.zMm/fogCellMm),right=Math.ceil((halo.xMm+halo.widthMm)/fogCellMm),bottom=Math.ceil((halo.zMm+halo.depthMm)/fogCellMm);
  let barriers:TerrainRectangle[]|undefined;
  for(let z=top;z<bottom;z++)for(let x=left;x<right;x++){
    if(explored(Math.min(widthMm-1,(x+.5)*fogCellMm),Math.min(heightMm-1,(z+.5)*fogCellMm)))continue;
    const xMm=Math.max(halo.xMm,x*fogCellMm),zMm=Math.max(halo.zMm,z*fogCellMm),cell={xMm,zMm,widthMm:Math.min(halo.xMm+halo.widthMm,(x+1)*fogCellMm)-xMm,depthMm:Math.min(halo.zMm+halo.depthMm,(z+1)*fogCellMm)-zMm};
    if(overlaps(cell,rect))return false;
    barriers??=terrainObstacles(terrain).map(obstacle=>({xMm:obstacle.xMm-obstacle.halfWidth,zMm:obstacle.zMm-obstacle.halfHeight,widthMm:obstacle.halfWidth*2,depthMm:obstacle.halfHeight*2}));
    let uncovered=[cell];
    for(const barrier of barriers){uncovered=uncovered.flatMap(piece=>subtract(piece,barrier));if(!uncovered.length)break;}
    if(uncovered.length)return false;
  }
  return true;
}

/** Impassable cliffs and ridges occlude vision; ramps only cut legacy cliffs. */
export function terrainVisionBlockers(terrain:readonly TerrainRegion[]):TerrainObstacle[]{
  return terrainObstacles(terrain.filter(region=>region.kind==='cliff'||region.kind==='ridge'||region.kind==='ramp'));
}

/** Exact segment/rectangle intersection, independent of navigation sampling or graphics. */
export function terrainLineOfSight(blockers:readonly TerrainObstacle[],from:{xMm:number;zMm:number},to:{xMm:number;zMm:number}):boolean {
  for(const blocker of blockers){
    let near=0,far=1,intersects=true;
    for(const [start,end,low,high]of [
      [from.xMm,to.xMm,blocker.xMm-blocker.halfWidth,blocker.xMm+blocker.halfWidth],
      [from.zMm,to.zMm,blocker.zMm-blocker.halfHeight,blocker.zMm+blocker.halfHeight],
    ] as const){
      const delta=end-start;
      if(delta===0){if(start<=low||start>=high){intersects=false;break;}continue;}
      const entry=(low-start)/delta,exit=(high-start)/delta;
      near=Math.max(near,Math.min(entry,exit));far=Math.min(far,Math.max(entry,exit));
      if(near>=far){intersects=false;break;}
    }
    if(intersects&&near<1&&far>0)return false;
  }
  return true;
}

/** Building footprints must be flat, and cannot occupy water, crossings, cliffs or slopes. */
export function terrainBuildable(terrain:readonly TerrainRegion[],footprint:TerrainRectangle):boolean {
  // Height sampling includes a landform's boundary for rendering. A footprint
  // merely touching an adjacent ridge must not inherit its raised edge; only
  // landforms occupying actual footprint area can affect its flatness.
  const intersecting=terrain.filter(region=>overlaps(region,footprint));
  if(intersecting.some(region=>region.kind!=='plateau'))return false;
  const heights=[terrainHeightAt(intersecting,footprint.xMm,footprint.zMm),terrainHeightAt(intersecting,footprint.xMm+footprint.widthMm-1,footprint.zMm),terrainHeightAt(intersecting,footprint.xMm,footprint.zMm+footprint.depthMm-1),terrainHeightAt(intersecting,footprint.xMm+footprint.widthMm-1,footprint.zMm+footprint.depthMm-1)];
  return Math.max(...heights)-Math.min(...heights)<=1;
}
