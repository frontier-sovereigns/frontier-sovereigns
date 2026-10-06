import { balance,type ForestCell,type Position,type ResourceType } from '@frontier/shared';
import { Navigation,type Obstacle } from './navigation.js';

interface ResourceGeometry {resource?:ResourceType;forest?:ForestCell}
interface KnownForestTree extends Position,ResourceGeometry {id:string;amount?:number}

/** Trunk/discovery geometry stays separate; only authored forest cells widen work
 * and walking occupancy. Each cell belongs to one resource, never a merged hull. */
export function resourceWorkBounds(node:ResourceGeometry):{halfWidth:number;halfHeight:number}{
  const half=node.resource==='wood'&&node.forest?node.forest.cellMm/2:node.resource==='wood'?450:650;
  return {halfWidth:half,halfHeight:half};
}

/** Caller supplies recipient knowledge, never the world's undisclosed roster. */
export function forestCandidates<T extends KnownForestTree>(known:readonly T[],target:T,origin:Position,radiusMm=30000):T[]{
  if(target.resource!=='wood'||!target.forest)return [];
  const squared=radiusMm*radiusMm,nearby=known.filter(node=>node.resource==='wood'&&node.forest&&(node.xMm-target.xMm)**2+(node.zMm-target.zMm)**2<=squared),parents=new Map<string,string>();
  const root=(id:string):string=>{let result=id;while(parents.has(result))result=parents.get(result)!;while(parents.has(id)){const next=parents.get(id)!;parents.set(id,result);id=next;}return result;};
  // Task patches bound search bookkeeping, not physical forest ownership. Known
  // touching cells connect those IDs even when a worker just depleted the cell;
  // empty cells are never returned as work targets. Unseen geometry cannot join
  // patches, and disconnected disclosed fragments of one ID retain continuity.
  for(const component of forestClearingComponents(nearby.map(node=>({...node,amount:1})))){
    const first=component[0]!.forest!.patchId;
    for(const node of component){const a=root(first),b=root(node.forest!.patchId);if(a!==b)parents.set(b,a);}
  }
  const intended=root(target.forest.patchId);
  return nearby.filter(node=>(node.amount??0)>0&&root(node.forest!.patchId)===intended)
    .sort((a,b)=>Math.hypot(a.xMm-origin.xMm,a.zMm-origin.zMm)-Math.hypot(b.xMm-origin.xMm,b.zMm-origin.zMm)||a.id.localeCompare(b.id));
}

export function resourceWorkPoints(node:Position&ResourceGeometry,workerRadiusMm:number):Position[]{
  const {halfWidth,halfHeight}=resourceWorkBounds(node),gap=workerRadiusMm+200;
  return [{xMm:node.xMm-halfWidth-gap,zMm:node.zMm},{xMm:node.xMm+halfWidth+gap,zMm:node.zMm},
    {xMm:node.xMm,zMm:node.zMm-halfHeight-gap},{xMm:node.xMm,zMm:node.zMm+halfHeight+gap}];
}

/** Physical forests can span several bounded task-selection patches. Clearing
 * follows the touching cells, while those original patch identities stay intact.
 * Map validation supplies authored cells; runtime callers supply only disclosed
 * cells. This helper never obtains world state on its own. */
export function forestClearingComponents<T extends KnownForestTree>(nodes:readonly T[]):T[][]{
  if(nodes.length>balance.rules.maxResourceNodes)throw new Error('FOREST_COMPONENT_LIMIT');
  const trees=nodes.filter(node=>node.resource==='wood'&&node.forest&&(node.amount??0)>0),parents=trees.map((_,index)=>index),buckets=new Map<string,number[]>(),bucketMm=8000;
  const root=(index:number):number=>{while(parents[index]!==index){parents[index]=parents[parents[index]!]!;index=parents[index]!;}return index;};
  for(let index=0;index<trees.length;index++){
    const node=trees[index]!,bounds=resourceWorkBounds(node),seen=new Set<number>();
    if(!Number.isSafeInteger(node.xMm)||!Number.isSafeInteger(node.zMm)||!Number.isSafeInteger(node.forest!.cellMm)||node.forest!.cellMm<=0||node.forest!.cellMm>bucketMm)throw new Error('INVALID_FOREST_CELL_GEOMETRY');
    for(let z=Math.floor((node.zMm-bounds.halfHeight)/bucketMm);z<=Math.floor((node.zMm+bounds.halfHeight)/bucketMm);z++)for(let x=Math.floor((node.xMm-bounds.halfWidth)/bucketMm);x<=Math.floor((node.xMm+bounds.halfWidth)/bucketMm);x++){
      const key=`${x},${z}`,bucket=buckets.get(key)??[];
      for(const otherIndex of bucket){
        if(seen.has(otherIndex))continue;seen.add(otherIndex);
        const other=trees[otherIndex]!,otherBounds=resourceWorkBounds(other);
        if(Math.abs(node.xMm-other.xMm)>bounds.halfWidth+otherBounds.halfWidth||Math.abs(node.zMm-other.zMm)>bounds.halfHeight+otherBounds.halfHeight)continue;
        const a=root(index),b=root(otherIndex);if(a!==b)parents[Math.max(a,b)]=Math.min(a,b);
      }
      bucket.push(index);buckets.set(key,bucket);
    }
  }
  const components=new Map<number,T[]>();
  for(let index=0;index<trees.length;index++){const key=root(index),component=components.get(key)??[];component.push(trees[index]!);components.set(key,component);}
  return [...components.values()];
}

/** Bounded authored-map proof: every removed cell has an actual accessible work
 * face and a reversible path back to the starting/drop-off area in the geometry
 * preceding its removal. Successful simultaneous frontiers form a legal ordered
 * clearing sequence because depletion only removes blockers. No world mutation.
 */
export function proveForestClearing(widthMm:number,heightMm:number,obstacles:readonly Obstacle[],nodes:readonly (KnownForestTree&{amount:number})[],start:Position,workerRadiusMm:number,legalPath?:(path:readonly Position[])=>boolean):string[]|null {
  if(nodes.length>balance.rules.maxResourceNodes)throw new Error('FOREST_COMPONENT_LIMIT');
  if(!nodes.length)return [];
  // Most authored patches clear entirely from their nearby reachable anchor.
  // Keep that proof local so each frontier rebuild does not re-index every tree
  // on the map. The cropped world's bounds prevent paths from leaving the
  // checked geometry; obstacles crossing a boundary remain solid in the crop.
  const margin=Math.max(9000,workerRadiusMm+200),grid=1000;
  let minX=start.xMm-workerRadiusMm,minZ=start.zMm-workerRadiusMm,maxX=start.xMm+workerRadiusMm,maxZ=start.zMm+workerRadiusMm;
  for(const node of nodes){const bounds=resourceWorkBounds(node);minX=Math.min(minX,node.xMm-bounds.halfWidth);minZ=Math.min(minZ,node.zMm-bounds.halfHeight);maxX=Math.max(maxX,node.xMm+bounds.halfWidth);maxZ=Math.max(maxZ,node.zMm+bounds.halfHeight);}
  const left=Math.max(0,Math.floor((minX-margin)/grid)*grid),top=Math.max(0,Math.floor((minZ-margin)/grid)*grid),right=Math.min(widthMm,Math.ceil((maxX+margin)/grid)*grid),bottom=Math.min(heightMm,Math.ceil((maxZ+margin)/grid)*grid);
  if(left>0||top>0||right<widthMm||bottom<heightMm){
    const localObstacles=obstacles.filter(obstacle=>obstacle.xMm+obstacle.halfWidth>=left&&obstacle.xMm-obstacle.halfWidth<=right&&obstacle.zMm+obstacle.halfHeight>=top&&obstacle.zMm-obstacle.halfHeight<=bottom).map(obstacle=>({...obstacle,xMm:obstacle.xMm-left,zMm:obstacle.zMm-top}));
    const localNodes=nodes.map(node=>({...node,xMm:node.xMm-left,zMm:node.zMm-top}));
    const local=proveClearingInBounds(right-left,bottom-top,localObstacles,localNodes,{xMm:start.xMm-left,zMm:start.zMm-top},workerRadiusMm,legalPath?path=>legalPath(path.map(point=>({xMm:point.xMm+left,zMm:point.zMm+top}))):undefined);
    if(local)return local;
  }
  // A valid approach may require a detour outside the crop. Retain the original
  // whole-map proof as a fallback rather than rejecting that authored layout.
  return proveClearingInBounds(widthMm,heightMm,obstacles,nodes,start,workerRadiusMm,legalPath);
}

function proveClearingInBounds(widthMm:number,heightMm:number,obstacles:readonly Obstacle[],nodes:readonly (KnownForestTree&{amount:number})[],start:Position,workerRadiusMm:number,legalPath:((path:readonly Position[])=>boolean)|undefined):string[]|null {
  const remaining=[...nodes],cleared=new Set<string>(),sequence:string[]=[];
  // Removing cells cannot invalidate a previously proved route. Retain its
  // reachable endpoint and use short exact connectors for later frontiers,
  // rather than repeatedly searching from the same distant anchor. Routes use
  // parent links so a long clearing sequence does not retain quadratic copies.
  interface Reachable {point:Position;parent?:Reachable;segment:readonly Position[]}
  const reachable=new Map<string,Reachable[]>(),recorded=new Set<string>(),bucketMm=8000;
  const retain=(point:Position,parent:Reachable|undefined,segment:readonly Position[])=>{
    const position=`${point.xMm},${point.zMm}`;if(recorded.has(position))return;recorded.add(position);
    const key=`${Math.floor(point.xMm/bucketMm)},${Math.floor(point.zMm/bucketMm)}`,bucket=reachable.get(key)??[];bucket.push({point,parent,segment});reachable.set(key,bucket);
  };
  const route=(anchor:Reachable,point:Position):Position[]=>{
    const segments:(readonly Position[])[]=[];
    for(let cursor:Reachable|undefined=anchor;cursor;cursor=cursor.parent)segments.push(cursor.segment);
    return [...segments.reverse().flat(),point];
  };
  retain(start,undefined,[]);
  while(remaining.length){
    const nav=new Navigation(widthMm,heightMm,obstacles.filter(obstacle=>!cleared.has(obstacle.id))),frontier:string[]=[];
    for(const node of remaining){
      const bounds=resourceWorkBounds(node);
      for(const point of resourceWorkPoints(node,workerRadiusMm)){
        if(!nav.free(point,workerRadiusMm))continue;
        const surface={xMm:Math.max(node.xMm-bounds.halfWidth,Math.min(node.xMm+bounds.halfWidth,point.xMm)),zMm:Math.max(node.zMm-bounds.halfHeight,Math.min(node.zMm+bounds.halfHeight,point.zMm))};
        if(!nav.clearLine(point,surface,0,node.id))continue;
        const x=Math.floor(point.xMm/bucketMm),z=Math.floor(point.zMm/bucketMm);let reached=false;
        for(let dz=-1;dz<=1&&!reached;dz++)for(let dx=-1;dx<=1&&!reached;dx++)for(const anchor of reachable.get(`${x+dx},${z+dz}`)??[]){
          if((anchor.point.xMm-point.xMm)**2+(anchor.point.zMm-point.zMm)**2>bucketMm*bucketMm||!nav.clearLine(anchor.point,point,workerRadiusMm))continue;
          if(legalPath&&!legalPath(route(anchor,point)))continue;
          retain(point,anchor,[point]);reached=true;break;
        }
        if(!reached){const path=nav.path(start,point,workerRadiusMm);if(path&&(!legalPath||legalPath(path))){retain(point,undefined,path);reached=true;}}
        if(reached){frontier.push(node.id);break;}
      }
    }
    if(!frontier.length)return null;
    for(const id of frontier){cleared.add(id);sequence.push(id);}
    for(let index=remaining.length-1;index>=0;index--)if(cleared.has(remaining[index]!.id))remaining.splice(index,1);
  }
  return sequence;
}
