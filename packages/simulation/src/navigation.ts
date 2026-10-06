import type { Position } from '@frontier/shared';

export interface Obstacle { id: string; xMm: number; zMm: number; halfWidth: number; halfHeight: number; circle?: boolean }
export interface NavigationWorkBudget {remaining:number;used:number}
export class PathBudgetExceededError extends Error {constructor(){super('PATH_BUSY');this.name='PathBudgetExceededError';}}
function hitsCircle(fromX:number,fromZ:number,dx:number,dz:number,length2:number,x:number,z:number,radius:number):boolean{
  const t=length2?Math.max(0,Math.min(1,((x-fromX)*dx+(z-fromZ)*dz)/length2)):0;
  return Math.hypot(fromX+dx*t-x,fromZ+dz*t-z)<radius;
}
function hitsRectangle(fromX:number,fromZ:number,dx:number,dz:number,left:number,top:number,right:number,bottom:number):boolean{
  let enter=0,leave=1;
  if(dx===0){if(fromX<=left||fromX>=right)return false;}else{const a=(left-fromX)/dx,b=(right-fromX)/dx;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
  if(dz===0){if(fromZ<=top||fromZ>=bottom)return false;}else{const a=(top-fromZ)/dz,b=(bottom-fromZ)/dz;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
  return enter<leave;
}
/** Exact signed cell pairs for ordinary maps; arbitrary external geometry keeps
 * its original string key. Numeric and fallback string keys cannot collide. */
function bucketKey(x:number,z:number):number|string{return x>=-4096&&x<4096&&z>=-4096&&z<4096?z*8192+x:`${x},${z}`;}
/** Connect exact work positions to the lattice without crossing obstacles. Keep
 * the original nine queries unchanged when they succeed; narrow resource gaps
 * may need an escape through either of two additional, bounded outer rings. */
export function navigationConnectors(nav:Navigation,point:Position,radius:number,cellMm:number,center:(id:number)=>Position):number[]{
  const width=Math.floor(nav.widthMm/cellMm),height=Math.floor(nav.heightMm/cellMm),cx=Math.floor(point.xMm/cellMm),cz=Math.floor(point.zMm/cellMm),result:number[]=[];
  for(let ring=1;ring<=3;ring++){
    for(let z=cz-ring;z<=cz+ring;z++)for(let x=cx-ring;x<=cx+ring;x++){
      if(ring>1&&Math.max(Math.abs(x-cx),Math.abs(z-cz))!==ring)continue;
      if(x>=0&&z>=0&&x<width&&z<height){const id=z*width+x,target=center(id);if(nav.free(target,radius)&&nav.clearLine(point,target,radius))result.push(id);}
    }
    if(result.length)return result.sort((a,b)=>Math.hypot(center(a).xMm-point.xMm,center(a).zMm-point.zMm)-Math.hypot(center(b).xMm-point.xMm,center(b).zMm-point.zMm)||a-b).slice(0,9);
  }
  return result;
}
/** A small endpoint bridge fills gaps that do not contain a metre-grid node.
 * Only failed ordinary connectors use it. Every edge still uses exact swept
 * clearance, and callers retain their existing geometry/query work budget. */
export const CONNECTOR_CELL_MM=250,CONNECTOR_REACH_CELLS=12,CONNECTOR_NODE_LIMIT=625;
export interface EndpointConnectorSearch {queue:number[];cursor:number;parents:Record<string,number>;cells:number[]}
export interface EndpointConnectorRoute {cell:number;points:Position[]}
const connectorPoint=(id:number,width:number):Position=>({xMm:id%width*CONNECTOR_CELL_MM,zMm:Math.floor(id/width)*CONNECTOR_CELL_MM});
export function createEndpointConnectorSearch(nav:Navigation,point:Position,radius:number):EndpointConnectorSearch{
  const width=Math.floor(nav.widthMm/CONNECTOR_CELL_MM),queue=navigationConnectors(nav,point,radius,CONNECTOR_CELL_MM,id=>connectorPoint(id,width));
  return {queue,cursor:0,parents:Object.fromEntries(queue.map(id=>[String(id),-1])),cells:[]};
}
/** One expansion is one existing scheduler service credit, never a new grant. */
export function advanceEndpointConnectorSearch(state:EndpointConnectorSearch,nav:Navigation,point:Position,radius:number,cellMm:number):void{
  if(state.cursor>=state.queue.length)return;
  const width=Math.floor(nav.widthMm/CONNECTOR_CELL_MM),height=Math.floor(nav.heightMm/CONNECTOR_CELL_MM),current=state.queue[state.cursor++]!,from=connectorPoint(current,width),cx=Math.floor(point.xMm/CONNECTOR_CELL_MM),cz=Math.floor(point.zMm/CONNECTOR_CELL_MM);
  if(from.xMm%cellMm===0&&from.zMm%cellMm===0)state.cells.push(from.zMm/cellMm*Math.floor(nav.widthMm/cellMm)+from.xMm/cellMm);
  for(const [dx,dz]of [[0,-1],[-1,0],[1,0],[0,1]] as const){
    const x=current%width+dx,z=Math.floor(current/width)+dz,id=z*width+x;
    if(x<0||z<0||x>=width||z>=height||Math.abs(x-cx)>CONNECTOR_REACH_CELLS||Math.abs(z-cz)>CONNECTOR_REACH_CELLS||Object.hasOwn(state.parents,String(id)))continue;
    const target=connectorPoint(id,width);if(!nav.free(target,radius)||!nav.clearLine(from,target,radius))continue;
    state.parents[String(id)]=current;state.queue.push(id);
  }
}
export function endpointConnectorRoutes(state:EndpointConnectorSearch,nav:Navigation,point:Position,cellMm:number):EndpointConnectorRoute[]{
  const width=Math.floor(nav.widthMm/CONNECTOR_CELL_MM),coarseWidth=Math.floor(nav.widthMm/cellMm);
  return state.cells.map(cell=>{
    const points:Position[]=[];let cursor=Math.floor(cell/coarseWidth)*cellMm/CONNECTOR_CELL_MM*width+cell%coarseWidth*cellMm/CONNECTOR_CELL_MM;
    while(cursor!==-1){points.push(connectorPoint(cursor,width));cursor=state.parents[String(cursor)]!;}points.reverse();
    let distance=0,prior=point;for(const next of points){distance+=Math.hypot(next.xMm-prior.xMm,next.zMm-prior.zMm);prior=next;}
    // Collinear compression changes neither geometry nor charged queries.
    const compact=points.filter((next,index)=>{const before=index?points[index-1]!:point,after=points[index+1];return !after||(next.xMm-before.xMm)*(after.zMm-next.zMm)!==(next.zMm-before.zMm)*(after.xMm-next.xMm);});
    return {cell,points:compact,distance};
  }).sort((a,b)=>a.distance-b.distance||a.cell-b.cell).slice(0,9).map(({cell,points})=>({cell,points}));
}
export function connectorRouteLength(point:Position,points:readonly Position[]):number{let result=0;for(const next of points){result+=Math.hypot(next.xMm-point.xMm,next.zMm-point.zMm);point=next;}return result;}
/** A deterministic 1m navigation grid. Derived caches never enter player packets. */
export class Navigation {
  private readonly buckets=new Map<number|string,Obstacle[]>();
  private inheritedBuckets:ReadonlyMap<number|string,Obstacle[]>|undefined;
  constructor(readonly widthMm: number, readonly heightMm: number, readonly obstacles: Obstacle[],readonly maxSearchNodes=30000,readonly cellMm=1000,readonly workBudget?:NavigationWorkBudget,base?:Navigation) {
    if(base)this.obstacles=[...base.obstacles,...obstacles];
    this.populateBuckets(obstacles,base);
  }
  /** Owned geometry supplies its own packed index. Ordinary overlays retain one
   * root map and only copy cumulative overrides, never a growing lookup chain. */
  protected populateBuckets(obstacles:Obstacle[],base?:Navigation):void {
    if(base){
      if(base.populateBuckets===Navigation.prototype.populateBuckets){
        this.inheritedBuckets=base.inheritedBuckets??base.buckets;
        if(base.inheritedBuckets)for(const [key,bucket]of base.buckets)this.buckets.set(key,bucket);
      }else for(const [key,bucket]of base.bucketEntries())this.buckets.set(key,bucket);
    }
    const copied=new Set<number|string>();
    for(const obstacle of obstacles)for(let z=Math.floor((obstacle.zMm-obstacle.halfHeight)/8000);z<=Math.floor((obstacle.zMm+obstacle.halfHeight)/8000);z++)for(let x=Math.floor((obstacle.xMm-obstacle.halfWidth)/8000);x<=Math.floor((obstacle.xMm+obstacle.halfWidth)/8000);x++){
      const key=bucketKey(x,z);let bucket=this.buckets.get(key)??this.inheritedBuckets?.get(key)??[];if(base&&!copied.has(key)){bucket=[...bucket];copied.add(key);}bucket.push(obstacle);this.buckets.set(key,bucket);
    }
  }
  protected *bucketEntries():IterableIterator<[number|string,Obstacle[]]>{
    if(this.inheritedBuckets)for(const [key,bucket]of this.inheritedBuckets)yield [key,this.buckets.get(key)??bucket];
    for(const [key,bucket]of this.buckets)if(!this.inheritedBuckets?.has(key))yield [key,bucket];
  }
  /** Bucket membership and order stay fixed; generic source objects remain live. */
  withAdditionalObstacles(obstacles:Obstacle[],maxSearchNodes=this.maxSearchNodes,cellMm=this.cellMm,workBudget?:NavigationWorkBudget):Navigation{return new Navigation(this.widthMm,this.heightMm,obstacles,maxSearchNodes,cellMm,workBudget,this);}
  private chargeWork():void{if(!this.workBudget)return;if(this.workBudget.remaining<=0)throw new PathBudgetExceededError();this.workBudget.remaining--;this.workBudget.used++;}
  free(point: Position, radius: number, ignoredId?:string): boolean {
    if (point.xMm < radius || point.zMm < radius || point.xMm > this.widthMm - radius || point.zMm > this.heightMm - radius) return false;
    for(let z=Math.floor((point.zMm-radius)/8000);z<=Math.floor((point.zMm+radius)/8000);z++)for(let x=Math.floor((point.xMm-radius)/8000);x<=Math.floor((point.xMm+radius)/8000);x++){
      this.chargeWork();
      const key=bucketKey(x,z);if((this.buckets.get(key)??this.inheritedBuckets?.get(key))?.some(o => {this.chargeWork();if(o.id===ignoredId)return false;if(o.circle)return Math.hypot(point.xMm-o.xMm,point.zMm-o.zMm)<o.halfWidth+radius;const dx=Math.max(0,Math.abs(point.xMm-o.xMm)-o.halfWidth),dz=Math.max(0,Math.abs(point.zMm-o.zMm)-o.halfHeight);return radius?dx*dx+dz*dz<radius*radius:Math.abs(point.xMm-o.xMm)<o.halfWidth&&Math.abs(point.zMm-o.zMm)<o.halfHeight;}))return false;
    }
    return true;
  }
  clearLine(from: Position, to: Position, radius: number, ignoredId?:string): boolean {
    if(!this.free(from,radius,ignoredId)||!this.free(to,radius,ignoredId))return false;
    const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length2=dx*dx+dz*dz,seen=new Set<Obstacle>();
    for(let z=Math.floor((Math.min(from.zMm,to.zMm)-radius)/8000);z<=Math.floor((Math.max(from.zMm,to.zMm)+radius)/8000);z++)for(let x=Math.floor((Math.min(from.xMm,to.xMm)-radius)/8000);x<=Math.floor((Math.max(from.xMm,to.xMm)+radius)/8000);x++){this.chargeWork();const key=bucketKey(x,z);for(const obstacle of this.buckets.get(key)??this.inheritedBuckets?.get(key)??[]){
      if(obstacle.id===ignoredId||seen.has(obstacle))continue;seen.add(obstacle);
      this.chargeWork();
      if(obstacle.circle){if(hitsCircle(from.xMm,from.zMm,dx,dz,length2,obstacle.xMm,obstacle.zMm,radius+obstacle.halfWidth))return false;continue;}
      const left=obstacle.xMm-obstacle.halfWidth,right=obstacle.xMm+obstacle.halfWidth,top=obstacle.zMm-obstacle.halfHeight,bottom=obstacle.zMm+obstacle.halfHeight;
      // Sweeping a circular unit around a rectangle produces rounded corners.
      if(hitsRectangle(from.xMm,from.zMm,dx,dz,left-radius,top,right+radius,bottom)||hitsRectangle(from.xMm,from.zMm,dx,dz,left,top-radius,right,bottom+radius)||(radius>0&&(hitsCircle(from.xMm,from.zMm,dx,dz,length2,left,top,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,right,top,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,left,bottom,radius)||hitsCircle(from.xMm,from.zMm,dx,dz,length2,right,bottom,radius))))return false;
    }}
    return true;
  }
  path(from: Position, target: Position, radius: number): Position[] | null {
    return this.pathToAny(from,[target],radius);
  }
  /** Search all legal work faces together so an unreachable face cannot starve another. */
  pathToAny(from:Position, targets:Position[], radius:number):Position[]|null {
    const seenTargets=new Set<string>(),legal:Position[]=[];
    for(const target of targets){const key=`${target.xMm},${target.zMm}`;if(seenTargets.has(key))continue;seenTargets.add(key);if(this.free(target,radius))legal.push(target);}
    if(!legal.length)return null;
    for(const target of legal)if(this.clearLine(from,target,radius))return [{...target}];
    const width = Math.floor(this.widthMm / this.cellMm), height = Math.floor(this.heightMm / this.cellMm);
    const goalCells=legal.map(target=>({x:Math.floor(target.xMm/this.cellMm),z:Math.floor(target.zMm/this.cellMm)}));
    // Integer-meter nodes align with both 2m wall openings and resource gaps.
    // Half-offset nodes can erase legal corridors for small and large bodies.
    const offset=0;
    const center=(id:number):Position=>({xMm:(id%width)*this.cellMm+offset,zMm:Math.floor(id/width)*this.cellMm+offset});
    // Exact legal work positions can lie in a cell whose center intersects an obstacle.
    // Connect both endpoints to reachable neighboring centers, never to a blocked center.
    let bridgeWork=0;
    const connectors=(point:Position):EndpointConnectorRoute[]=>{
      const direct=navigationConnectors(this,point,radius,this.cellMm,center);if(direct.length)return direct.map(cell=>({cell,points:[center(cell)]}));
      // Finer local searches already supply their own nodes. The bridge is an
      // endpoint repair for the ordinary lattice, not recursive resolution.
      if(this.cellMm<=CONNECTOR_CELL_MM||this.cellMm%CONNECTOR_CELL_MM!==0)return [];
      const state=createEndpointConnectorSearch(this,point,radius);
      while(state.cursor<state.queue.length&&bridgeWork<this.maxSearchNodes){advanceEndpointConnectorSearch(state,this,point,radius,this.cellMm);bridgeWork++;}
      return state.cursor===state.queue.length?endpointConnectorRoutes(state,this,point,this.cellMm):[];
    };
    const startRoutes=connectors(from),starts=startRoutes.map(route=>route.cell),ends=new Map<number,{target:Position;points:Position[]}>();
    for(const target of legal)for(const route of connectors(target)){
      const previous=ends.get(route.cell);
      if(!previous||connectorRouteLength(target,route.points)<connectorRouteLength(previous.target,previous.points))ends.set(route.cell,{target,points:route.points});
    }
    if(!starts.length||!ends.size)return null;
    const score=new Map<number,number>(), parents=new Map<number,number>();
    const closed=new Set<number>(), open:{id:number;f:number}[]=[];
    const estimate=(x:number,z:number)=>{let best=Infinity;for(const goal of goalCells)best=Math.min(best,Math.max(0,Math.abs(x-goal.x)-1)+Math.max(0,Math.abs(z-goal.z)-1));return best;};
    const push=(item:{id:number;f:number})=>{open.push(item);let i=open.length-1;while(i>0){const parent=(i-1)>>1;if(open[parent]!.f<item.f||(open[parent]!.f===item.f&&open[parent]!.id<item.id))break;open[i]=open[parent]!;i=parent;}open[i]=item;};
    const pop=()=>{const root=open[0]!,tail=open.pop()!;if(open.length){let i=0;while(i*2+1<open.length){let child=i*2+1;if(child+1<open.length&&(open[child+1]!.f<open[child]!.f||(open[child+1]!.f===open[child]!.f&&open[child+1]!.id<open[child]!.id)))child++;if(tail.f<open[child]!.f||(tail.f===open[child]!.f&&tail.id<open[child]!.id))break;open[i]=open[child]!;i=child;}open[i]=tail;}return root;};
    for(const route of startRoutes){const start=route.cell,cost=connectorRouteLength(from,route.points)/this.cellMm;score.set(start,cost);push({id:start,f:cost+estimate(start%width,Math.floor(start/width))});}
    while(open.length&&closed.size+bridgeWork<this.maxSearchNodes){
      const current=pop().id;
      if(closed.has(current))continue;
      if(ends.has(current)){
        const end=ends.get(current)!,points:Position[]=[center(current)];let cursor=current;
        while(parents.has(cursor)){cursor=parents.get(cursor)!;points.push(center(cursor));}
        points.reverse();points.unshift(...startRoutes.find(route=>route.cell===cursor)!.points.slice(0,-1));points.push(...end.points.slice(0,-1).reverse(),{...end.target});
        // Retain only visible corners. Clearance is checked for the complete segment.
        const compact:Position[]=[];let anchor=from;
        for(let i=0;i<points.length;){let j=i;while(j+1<points.length&&this.clearLine(anchor,points[j+1]!,radius))j++;compact.push(points[j]!);anchor=points[j]!;i=j+1;}
        return compact;
      }
      closed.add(current);
      const cx=current%width,cz=Math.floor(current/width);
      for(const [dx,dz] of [[0,-1],[-1,0],[1,0],[0,1]] as const){
        const x=cx+dx,z=cz+dz,id=z*width+x;
        if(x<0||z<0||x>=width||z>=height||closed.has(id))continue;
        // A non-improving edge cannot change the search. Avoid querying its
        // geometry, preserving the work budget for candidates we can enqueue.
        const candidate=score.get(current)!+1;if(candidate>=(score.get(id)??Infinity))continue;
        if(!this.free(center(id),radius)||!this.clearLine(center(current),center(id),radius))continue;
        score.set(id,candidate);parents.set(id,current);push({id,f:candidate+estimate(x,z)*1.001});
      }
    }
    return null;
  }
}
