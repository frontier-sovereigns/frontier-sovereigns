import { MAX_WORLD_ENTITIES,type Position } from '@frontier/shared';
import { Navigation, type Obstacle } from './navigation.js';

export interface ResourceAccessBounds { minXMm?:number;maxXMm?:number;minZMm?:number;maxZMm?:number }
export interface GenerationResourceAccessOptions {
  widthMm:number;heightMm:number;obstacles:readonly Obstacle[];workerRadiusMm:number;
  cellMm?:number;bounds?:ResourceAccessBounds;maxGeometryQueries?:number;maxDistanceSearchNodes?:number;
}

export interface GenerationWalkingRoute { distanceMm:number;path:Position[] }
interface DistanceField { distances:Float64Array;parents:Int32Array;settled:Uint8Array;heap:DistanceHeap }
const directions=[[0,-1],[1,0],[0,1],[-1,0]] as const;
class DistanceHeap {
  private readonly entries:{id:number;distance:number}[]=[];
  peek():{id:number;distance:number}|undefined{return this.entries[0];}
  push(id:number,distance:number):void {
    const entry={id,distance};let at=this.entries.length;this.entries.push(entry);
    while(at>0){const parent=(at-1)>>1,other=this.entries[parent]!;if(other.distance<distance||other.distance===distance&&other.id<=id)break;this.entries[at]=other;at=parent;}
    this.entries[at]=entry;
  }
  pop():{id:number;distance:number}|undefined {
    const first=this.entries[0],last=this.entries.pop();if(!first||!last||!this.entries.length)return first;
    let at=0;
    while(at*2+1<this.entries.length){let child=at*2+1;const right=child+1,a=this.entries[child]!,b=this.entries[right];if(b&&(b.distance<a.distance||b.distance===a.distance&&b.id<a.id))child=right;const next=this.entries[child]!;if(last.distance<next.distance||last.distance===next.distance&&last.id<=next.id)break;this.entries[at]=next;at=child;}
    this.entries[at]=last;return first;
  }
}

/** Generation-only reachability index. Every accepted connection is an exact
 * swept path through immutable final obstacles. A sampled graph may reject a
 * narrow route, but never accepts an obstructed one. Connected components and
 * short endpoint connectors are shared across thousands of resource proofs.
 * Convex bounds optionally restrict all walking to one side of a river.
 * This does not prove access after chopping: the forest peeling proof remains
 * responsible for every tree that is initially behind other forest cells. */
export class GenerationResourceAccess {
  private readonly nav:Navigation;
  private readonly cell:number;
  private readonly radius:number;
  private readonly columns:number;
  private readonly rows:number;
  private readonly labels:Int32Array;
  private readonly freeCells:Int8Array;
  private readonly queue:Int32Array;
  private readonly edges:Uint8Array;
  private readonly endpoints=new Map<string,number[]>();
  private readonly fields=new Map<string,DistanceField>();
  private readonly bounds:Required<ResourceAccessBounds>;
  private readonly maximum:number;
  private readonly maximumDistanceNodes:number;
  private distanceNodes=0;
  private queries=0;
  private sampled=0;
  private componentCount=0;
  private stopped=false;

  constructor(options:GenerationResourceAccessOptions) {
    const {widthMm,heightMm,obstacles,workerRadiusMm,bounds={}}=options;
    this.cell=options.cellMm??2000;this.radius=workerRadiusMm;this.maximum=options.maxGeometryQueries??1500000;this.maximumDistanceNodes=options.maxDistanceSearchNodes??5000000;
    this.bounds={minXMm:bounds.minXMm??0,maxXMm:bounds.maxXMm??widthMm,minZMm:bounds.minZMm??0,maxZMm:bounds.maxZMm??heightMm};
    if(![widthMm,heightMm,this.cell,this.radius,this.maximum,...Object.values(this.bounds)].every(Number.isFinite)||widthMm<=0||heightMm<=0||widthMm>640000||heightMm>640000||this.cell<1000||this.cell>4000||this.radius<=0||this.radius>=this.cell||!Number.isInteger(this.maximum)||this.maximum<1||this.maximum>5000000||obstacles.length>MAX_WORLD_ENTITIES+4096||this.bounds.minXMm<0||this.bounds.minZMm<0||this.bounds.maxXMm>widthMm||this.bounds.maxZMm>heightMm||this.bounds.minXMm>=this.bounds.maxXMm||this.bounds.minZMm>=this.bounds.maxZMm||obstacles.some(o=>![o.xMm,o.zMm,o.halfWidth,o.halfHeight].every(Number.isFinite)||o.halfWidth<0||o.halfHeight<0))throw new Error('INVALID_RESOURCE_ACCESS_INDEX');
    if(!Number.isInteger(this.maximumDistanceNodes)||this.maximumDistanceNodes<1||this.maximumDistanceNodes>5000000)throw new Error('INVALID_RESOURCE_ACCESS_INDEX');
    this.columns=Math.floor(widthMm/this.cell)+1;this.rows=Math.floor(heightMm/this.cell)+1;
    const count=this.columns*this.rows;
    this.labels=new Int32Array(count);this.freeCells=new Int8Array(count);this.queue=new Int32Array(count);this.edges=new Uint8Array(count*4);
    // Own a geometry snapshot: callers cannot silently invalidate cached proofs.
    this.nav=new Navigation(widthMm,heightMm,obstacles.map(obstacle=>({...obstacle})));
  }

  get diagnostics():{geometryQueries:number;sampledCells:number;components:number;distanceSearchNodes:number;exhausted:boolean} {
    return {geometryQueries:this.queries,sampledCells:this.sampled,components:this.componentCount,distanceSearchNodes:this.distanceNodes,exhausted:this.stopped};
  }

  walkingDistance(from:Position,targets:readonly Position[],maximumDistanceMm=Infinity):number|null {
    return this.walkingRoute(from,targets,maximumDistanceMm)?.distanceMm??null;
  }

  /** Minimum distance in this sampled clearance graph, including exact short
   * endpoint connectors and a legal direct edge. This is not a claim of the
   * continuous shortest path. Every faction uses precisely the same metric.
   * A field resumes after a bounded query; no incomplete frontier is discarded. */
  walkingRoute(from:Position,targets:readonly Position[],maximumDistanceMm=Infinity):GenerationWalkingRoute|null {
    if(this.stopped||!this.inside(from)||Number.isNaN(maximumDistanceMm)||maximumDistanceMm<0||targets.length>MAX_WORLD_ENTITIES*8)return null;
    try {
      const candidates=new Map<string,{point:Position;lower:number}>();
      let lowerBound=Infinity;
      for(const point of targets){if(!this.inside(point))continue;const lower=Math.hypot(point.xMm-from.xMm,point.zMm-from.zMm);if(lower>maximumDistanceMm)continue;candidates.set(`${point.xMm},${point.zMm}`,{point,lower});lowerBound=Math.min(lowerBound,lower);}
      if(!candidates.size)return null;
      const ordered=[...candidates.values()].sort((a,b)=>a.lower-b.lower||a.point.zMm-b.point.zMm||a.point.xMm-b.point.xMm);
      let best=Infinity,bestTarget:Position|undefined,bestId=-1;
      for(const {point,lower}of ordered){if(lower>=best)break;if(this.line(from,point)){best=lower;bestTarget=point;}}
      if(best===lowerBound&&bestTarget)return {distanceMm:best,path:[{...bestTarget}]};
      const field=this.distanceField(from),terminals=new Map<number,{point:Position;tail:number}>();
      for(const {point,lower}of ordered){if(lower>=best)break;for(const id of this.connectors(point)){const grid=this.point(id),tail=Math.hypot(point.xMm-grid.xMm,point.zMm-grid.zMm),prior=terminals.get(id);if(!prior||tail<prior.tail)terminals.set(id,{point,tail});}}
      for(const [id,terminal]of terminals){const distance=field.distances[id]!+terminal.tail;if(field.settled[id]&&distance<=maximumDistanceMm&&distance<best){best=distance;bestId=id;bestTarget=terminal.point;}}
      while(true){
        const entry=field.heap.peek();if(!entry)break;
        if(field.settled[entry.id]||entry.distance!==field.distances[entry.id]){field.heap.pop();continue;}
        if(entry.distance>=best||entry.distance>maximumDistanceMm)break;
        if(this.distanceNodes>=this.maximumDistanceNodes)throw new Error('RESOURCE_ACCESS_WORK_LIMIT');
        field.heap.pop();this.distanceNodes++;field.settled[entry.id]=1;
        const terminal=terminals.get(entry.id),distance=terminal?entry.distance+terminal.tail:Infinity;
        if(distance<=maximumDistanceMm&&distance<best){best=distance;bestId=entry.id;bestTarget=terminal!.point;}
        const x=entry.id%this.columns,z=Math.floor(entry.id/this.columns);
        // Preserve outgoing frontier even when this query just found its answer:
        // a later resource may need distances beyond the current stopping bound.
        for(let direction=0;direction<4;direction++){const [dx,dz]=directions[direction]!,nx=x+dx,nz=z+dz;if(nx<0||nz<0||nx>=this.columns||nz>=this.rows)continue;const next=nz*this.columns+nx;if(field.settled[next]||!this.edge(entry.id,next,direction))continue;const nextDistance=entry.distance+this.cell;if(nextDistance<field.distances[next]!){field.distances[next]=nextDistance;field.parents[next]=entry.id;field.heap.push(next,nextDistance);}}
      }
      if(!bestTarget||best>maximumDistanceMm)return null;
      const path:Position[]=[];
      if(bestId>=0){for(let id=bestId;id>=0;id=field.parents[id]!)path.push(this.point(id));path.reverse();if(path[0]?.xMm===from.xMm&&path[0]?.zMm===from.zMm)path.shift();}
      const last=path[path.length-1];if(!last||last.xMm!==bestTarget.xMm||last.zMm!==bestTarget.zMm)path.push({...bestTarget});
      return {distanceMm:best,path};
    } catch(error){if(error instanceof Error&&error.message==='RESOURCE_ACCESS_WORK_LIMIT'){this.stopped=true;return null;}throw error;}
  }

  private distanceField(from:Position):DistanceField {
    const key=`${from.xMm},${from.zMm}`,cached=this.fields.get(key);if(cached)return cached;
    // There can be at most eleven concurrent faction rallies. Unusual callers
    // may evict a field, but cannot grow resident distance arrays without bound.
    if(this.fields.size>=11)this.fields.delete(this.fields.keys().next().value!);
    const count=this.columns*this.rows,field:DistanceField={distances:new Float64Array(count).fill(Infinity),parents:new Int32Array(count).fill(-1),settled:new Uint8Array(count),heap:new DistanceHeap()};
    for(const id of this.connectors(from)){const point=this.point(id),distance=Math.hypot(point.xMm-from.xMm,point.zMm-from.zMm);field.distances[id]=distance;field.heap.push(id,distance);}
    this.fields.set(key,field);return field;
  }

  private edge(from:number,to:number,direction:number):boolean {
    const index=from*4+direction,cached=this.edges[index];if(cached)return cached===2;
    const clear=this.free(to)&&this.line(this.point(from),this.point(to)),value=clear?2:1;this.edges[index]=value;this.edges[to*4+(direction+2)%4]=value;return clear;
  }

  reachable(from:Position,to:Position):boolean {
    if(this.stopped||!this.inside(from)||!this.inside(to))return false;
    try {
      if(this.line(from,to))return true;
      const sources=this.connectors(from);if(!sources.length)return false;
      const seen=new Set<number>();
      for(const source of sources){
        const component=this.labels[source]||this.flood(source);if(!component||seen.has(component))continue;
        seen.add(component);if(this.connectsToComponent(to,component))return true;
      }
      return false;
    } catch(error) {
      if(error instanceof Error&&error.message==='RESOURCE_ACCESS_WORK_LIMIT'){this.stopped=true;return false;}
      throw error;
    }
  }

  private inside(point:Position):boolean {
    return Number.isFinite(point.xMm)&&Number.isFinite(point.zMm)&&point.xMm>=this.bounds.minXMm&&point.xMm<=this.bounds.maxXMm&&point.zMm>=this.bounds.minZMm&&point.zMm<=this.bounds.maxZMm;
  }

  private charge():void {if(this.queries>=this.maximum)throw new Error('RESOURCE_ACCESS_WORK_LIMIT');this.queries++;}
  private line(a:Position,b:Position):boolean {this.charge();return this.nav.clearLine(a,b,this.radius);}
  private point(id:number):Position {return {xMm:id%this.columns*this.cell,zMm:Math.floor(id/this.columns)*this.cell};}
  private free(id:number):boolean {
    if(this.freeCells[id]===0){
      const point=this.point(id);this.sampled++;
      if(!this.inside(point)){this.freeCells[id]=-1;return false;}
      this.charge();this.freeCells[id]=this.nav.free(point,this.radius)?1:-1;
    }
    return this.freeCells[id]===1;
  }

  private connectors(point:Position):number[] {
    const key=`${point.xMm},${point.zMm}`,cached=this.endpoints.get(key);if(cached)return cached;
    const cx=Math.round(point.xMm/this.cell),cz=Math.round(point.zMm/this.cell),result:number[]=[];
    // All connectors within this fixed window are considered. Keeping only the
    // nearest one can strand a valid endpoint on a different side of a blocker.
    for(let z=Math.max(0,cz-3);z<=Math.min(this.rows-1,cz+3);z++)for(let x=Math.max(0,cx-3);x<=Math.min(this.columns-1,cx+3);x++){
      const id=z*this.columns+x;if(this.free(id)&&this.line(point,this.point(id)))result.push(id);
    }
    this.endpoints.set(key,result);return result;
  }

  private connectsToComponent(point:Position,component:number):boolean {
    const cached=this.endpoints.get(`${point.xMm},${point.zMm}`);
    if(cached)return cached.some(id=>this.labels[id]===component);
    const cx=Math.round(point.xMm/this.cell),cz=Math.round(point.zMm/this.cell);
    // The source flood has completed: every node belonging to this component
    // already has its label. Test only those candidates, stopping after one
    // exact connector succeeds. Other components remain available to later
    // source attempts. No partial target list is cached as an exhaustive list.
    for(let z=Math.max(0,cz-3);z<=Math.min(this.rows-1,cz+3);z++)for(let x=Math.max(0,cx-3);x<=Math.min(this.columns-1,cx+3);x++){
      const id=z*this.columns+x;
      if(this.labels[id]===component&&this.line(point,this.point(id)))return true;
    }
    return false;
  }

  private flood(start:number):number {
    if(!this.free(start))return 0;
    const component=++this.componentCount;let head=0,tail=1;this.queue[0]=start;this.labels[start]=component;
    while(head<tail){
      const id=this.queue[head++]!,x=id%this.columns,z=Math.floor(id/this.columns);
      for(let direction=0;direction<4;direction++){
        const [dx,dz]=directions[direction]!;
        const nx=x+dx,nz=z+dz;if(nx<0||nz<0||nx>=this.columns||nz>=this.rows)continue;
        const next=nz*this.columns+nx;if(this.labels[next]||!this.edge(id,next,direction))continue;
        this.labels[next]=component;this.queue[tail++]=next;
      }
    }
    return component;
  }
}
