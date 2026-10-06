import { MAX_WORLD_ENTITIES,type Position } from '@frontier/shared';
import { Navigation, type Obstacle } from './navigation.js';

export interface BroadRouteSettlement extends Position {
  playerId:string;
  clearanceRadiusMm?:number;
  /** A legal army rally inside the clearing, never the occupied town center. */
  origin?:Position;
}
export interface BroadMapRouteInput {
  widthMm:number;heightMm:number;obstacles:readonly Obstacle[];
  settlements:readonly BroadRouteSettlement[];passageWidthMm:number;
  cellMm?:number;maxUnitRadiusMm?:number;
  /** Generation-only witness preference. Exact clearance and independence
   * proofs remain unchanged; the ordinary validator does not require it. */
  preferSharedCorridors?:boolean;
  /** Distant pairs establish reusable cross-map roads before local connectors. */
  sharedCorridorOrder?:'near'|'far';
  /** One optional bounded cleanup pass after all pairs have valid witnesses. */
  refineSharedCorridors?:boolean;
  /** Generation-only land already reserved for mandatory forest passages.
   * Influences witness cost only; it never grants geometric clearance. */
  sharedCorridorSeed?:{cellMm:3000;cells:Uint8Array};
}
export interface BroadRoutePair {
  fromPlayerId:string;toPlayerId:string;routeCount:0|1|2;
  /** Full-width formation centerlines, starting/ending inside their own clearing. */
  routes:Position[][];
  /** Ordinary largest-unit access, entirely inside the endpoint clearing. */
  accessRoutes:{from:Position[];to:Position[]}[];
  reason?:'NO_BROAD_EXIT'|'NO_BROAD_ROUTE'|'NO_INDEPENDENT_ROUTE';
}
export interface BroadMapRouteReport {
  valid:boolean;pairs:BroadRoutePair[];sampledCells:number;geometryQueries:number;searchNodes:number;
  failure?:'INVALID_INPUT'|'WORK_LIMIT';
}
type Segment=readonly [Position,Position];
const distance2=(a:Position,b:Position)=>(a.xMm-b.xMm)**2+(a.zMm-b.zMm)**2;
function pointSegmentDistance2(p:Position,a:Position,b:Position):number {
  const dx=b.xMm-a.xMm,dz=b.zMm-a.zMm,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((p.xMm-a.xMm)*dx+(p.zMm-a.zMm)*dz)/length)):0;
  return (p.xMm-a.xMm-dx*t)**2+(p.zMm-a.zMm-dz*t)**2;
}
function segmentDistance2(a:Segment,b:Segment):number {
  const [p,q]=a,[r,s]=b,dx=q.xMm-p.xMm,dz=q.zMm-p.zMm,ex=s.xMm-r.xMm,ez=s.zMm-r.zMm,cross=dx*ez-dz*ex;
  if(cross){const t=((r.xMm-p.xMm)*ez-(r.zMm-p.zMm)*ex)/cross,u=((r.xMm-p.xMm)*dz-(r.zMm-p.zMm)*dx)/cross;if(t>=0&&t<=1&&u>=0&&u<=1)return 0;}
  return Math.min(pointSegmentDistance2(p,r,s),pointSegmentDistance2(q,r,s),pointSegmentDistance2(r,p,q),pointSegmentDistance2(s,p,q));
}
/** Clip away only the two endpoint clearings. This permits routes to merge at
 * home, but not to share a pass immediately beyond the clearing's boundary. */
function outsideClearings(a:Position,b:Position,endpoints:readonly BroadRouteSettlement[]):Segment[] {
  let intervals:[number,number][]=[[0,1]];const dx=b.xMm-a.xMm,dz=b.zMm-a.zMm,aa=dx*dx+dz*dz;
  if(!aa)return [];
  for(const endpoint of endpoints){
    const x=a.xMm-endpoint.xMm,z=a.zMm-endpoint.zMm,r=endpoint.clearanceRadiusMm??40000,bb=2*(x*dx+z*dz),cc=x*x+z*z-r*r,discriminant=bb*bb-4*aa*cc;
    if(discriminant<=0)continue;
    const root=Math.sqrt(discriminant),lo=Math.max(0,(-bb-root)/(2*aa)),hi=Math.min(1,(-bb+root)/(2*aa));if(lo>=hi)continue;
    intervals=intervals.flatMap(([start,end])=>{if(hi<=start||lo>=end)return [[start,end]];const result:[number,number][]=[];if(lo>start)result.push([start,lo]);if(hi<end)result.push([hi,end]);return result;});
  }
  return intervals.map(([start,end])=>[{xMm:a.xMm+dx*start,zMm:a.zMm+dz*start},{xMm:a.xMm+dx*end,zMm:a.zMm+dz*end}]);
}
function compact(points:Position[]):Position[] {return points.filter((p,i)=>!i||i===points.length-1||(p.xMm-points[i-1]!.xMm)*(points[i+1]!.zMm-p.zMm)!==(p.zMm-points[i-1]!.zMm)*(points[i+1]!.xMm-p.xMm));}

/** Conservative generation-time proof, not a replacement runtime pathfinder.
 * Every lattice edge receives exact swept geometry clearance. The second
 * formation corridor must be physically disjoint from the first outside the
 * endpoints; neighboring lattice paths through one 32m gap cannot count twice.
 * A >=64m open gap may carry two independent 32m corridors. Greedy witness
 * selection can reject a valid layout; it cannot weaken the required clearance.
 * Neither corridor may transit a third settlement. Work is bounded, fail-closed,
 * and reports stop on the first failed pair so generation can retry cheaply. */
export function validateBroadMapRoutes(input:BroadMapRouteInput):BroadMapRouteReport {
  const report:BroadMapRouteReport={valid:false,pairs:[],sampledCells:0,geometryQueries:0,searchNodes:0};
  const {widthMm,heightMm,obstacles,settlements,passageWidthMm}=input,cell=input.cellMm??8000,unit=input.maxUnitRadiusMm??850,radius=passageWidthMm/2;
  if(![widthMm,heightMm,cell,passageWidthMm,unit].every(Number.isFinite)||widthMm<=0||heightMm<=0||widthMm>640000||heightMm>640000||cell<4000||cell>16000||passageWidthMm<cell*2||unit<=0||unit>=radius||settlements.length<2||settlements.length>11||obstacles.length>MAX_WORLD_ENTITIES+4096||new Set(settlements.map(s=>s.playerId)).size!==settlements.length||settlements.some(s=>![s.xMm,s.zMm,s.clearanceRadiusMm??40000,s.origin?.xMm??s.xMm,s.origin?.zMm??s.zMm].every(Number.isFinite)||(s.clearanceRadiusMm??40000)<radius||(s.clearanceRadiusMm??40000)>80000)||obstacles.some(o=>![o.xMm,o.zMm,o.halfWidth,o.halfHeight].every(Number.isFinite)||o.halfWidth<0||o.halfHeight<0))return {...report,failure:'INVALID_INPUT'};
  const seed=input.sharedCorridorSeed,seedColumns=Math.floor(widthMm/3000),seedRows=Math.floor(heightMm/3000);
  if(seed&&(seed.cellMm!==3000||!(seed.cells instanceof Uint8Array)||seed.cells.length!==seedColumns*seedRows||seed.cells.some(value=>value>1)))return {...report,failure:'INVALID_INPUT'};
  // Overlapping endpoint exemptions could otherwise turn a zero-length shared
  // local path into a purported pair of independent inter-settlement routes.
  if(settlements.some((s,index)=>settlements.slice(0,index).some(other=>distance2(s,other)<((s.clearanceRadiusMm??40000)+(other.clearanceRadiusMm??40000))**2)))return {...report,failure:'INVALID_INPUT'};
  const cols=Math.floor(widthMm/cell)+1,rows=Math.floor(heightMm/cell)+1,count=cols*rows;
  if(count>30000)return {...report,failure:'WORK_LIMIT'};
  const nav=new Navigation(widthMm,heightMm,[...obstacles]),points=Array.from({length:count},(_,id)=>({xMm:id%cols*cell,zMm:Math.floor(id/cols)*cell})),free=new Uint8Array(count),edges=new Uint8Array(count),masks=new Uint16Array(count),edgeMasks=new Uint16Array(count*4),offsets=[-cols,1,cols,-1];
  const tick=()=>{if(++report.geometryQueries>300000)throw new Error('BROAD_ROUTE_WORK_LIMIT');};
  const isFree=(point:Position,r:number)=>{tick();return nav.free(point,r);},line=(a:Position,b:Position,r:number)=>{tick();return nav.clearLine(a,b,r);};
  try {
    for(let id=0;id<count;id++){
      const p=points[id]!;free[id]=+isFree(p,radius);
      for(let s=0;s<settlements.length;s++)if(distance2(p,settlements[s]!)<((settlements[s]!.clearanceRadiusMm??40000)+radius)**2)masks[id]!|=1<<s;
    }
    report.sampledCells=count;
    for(let id=0;id<count;id++)if(free[id])for(const dir of [1,2]){
      const next=id+offsets[dir]!;if(next>=count||(dir===1&&id%cols===cols-1)||!free[next]||!line(points[id]!,points[next]!,radius))continue;
      edges[id]!|=1<<dir;edges[next]!|=1<<((dir+2)%4);
      let mask=0;for(let s=0;s<settlements.length;s++)if(pointSegmentDistance2(settlements[s]!,points[id]!,points[next]!)<((settlements[s]!.clearanceRadiusMm??40000)+radius)**2)mask|=1<<s;
      edgeMasks[id*4+dir]=mask;edgeMasks[next*4+(dir+2)%4]=mask;
    }
    // A tiny local lattice connects each broad mouth to the real starting rally.
    // It cannot escape a clearing and re-enter through some unrelated narrow path.
    const access=settlements.map(settlement=>{
      const origin=settlement.origin??settlement,extent=settlement.clearanceRadiusMm??40000,localCell=2000,side=Math.ceil(extent/localCell),size=side*2+1,parents=new Int32Array(size*size).fill(-2),queue:number[]=[],center=side*size+side;
      const point=(id:number):Position=>({xMm:origin.xMm+(id%size-side)*localCell,zMm:origin.zMm+(Math.floor(id/size)-side)*localCell});
      const inside=(p:Position)=>distance2(p,settlement)<=(extent-unit)**2;
      if(inside(origin)&&isFree(origin,unit)){parents[center]=-1;queue.push(center);}
      for(let cursor=0;cursor<queue.length;cursor++){
        const id=queue[cursor]!,p=point(id);report.searchNodes++;
        for(const [dx,dz] of [[0,-1],[1,0],[0,1],[-1,0]]){
          const x=id%size+dx!,z=Math.floor(id/size)+dz!,next=z*size+x;if(x<0||z<0||x>=size||z>=size||parents[next]!==-2)continue;
          const target=point(next);if(!inside(target)||!line(p,target,unit))continue;parents[next]=id;queue.push(next);
        }
      }
      const routes=new Map<number,Position[]>();
      for(let id=0;id<count;id++){
        const p=points[id]!;if(!free[id]||!inside(p))continue;
        const cx=Math.round((p.xMm-origin.xMm)/localCell)+side,cz=Math.round((p.zMm-origin.zMm)/localCell)+side;
        for(const [dx,dz] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]){
          const x=cx+dx!,z=cz+dz!,candidate=z*size+x;if(x<0||z<0||x>=size||z>=size||parents[candidate]===-2)continue;
          const target=point(candidate);if(!line(target,p,unit))continue;
          const path:Position[]=[p];let cursor=candidate;while(cursor!==-1){path.push(point(cursor));cursor=parents[cursor]!;}path.reverse();routes.set(id,compact(path));break;
        }
      }
      return routes;
    });
    const sharedCells=input.preferSharedCorridors?new Uint8Array(count):undefined;
    if(sharedCells&&seed)for(let id=0;id<count;id++){const point=points[id]!,x=Math.floor(point.xMm/3000),z=Math.floor(point.zMm/3000);if(x<seedColumns&&z<seedRows&&seed.cells[z*seedColumns+x])sharedCells[id]=1;}
    const seedSharedCells=sharedCells&&seed?sharedCells.slice():undefined;
    const refinements:((marginalCost:(from:number,to:number)=>number)=>BroadRoutePair|undefined)[]=[];
    const pairOrder:{from:number;to:number}[]=[];
    for(let from=0;from<settlements.length;from++)for(let to=from+1;to<settlements.length;to++)pairOrder.push({from,to});
    // Near-first remains available for ordinary shared layouts. At maximum
    // capacity, distant pairs can establish a reusable backbone before local
    // endpoint connectors consume the same region in many different directions.
    // Only witness order changes; every settlement pair still receives a proof.
    const distantFirst=input.sharedCorridorOrder==='far';
    if(sharedCells)pairOrder.sort((a,b)=>(distantFirst?-1:1)*(distance2(settlements[a.from]!,settlements[a.to]!)-distance2(settlements[b.from]!,settlements[b.to]!))||a.from-b.from||a.to-b.to);
    for(const {from,to}of pairOrder){
      const a=settlements[from]!,b=settlements[to]!,pair:BroadRoutePair={fromPlayerId:a.playerId,toPlayerId:b.playerId,routeCount:0,routes:[],accessRoutes:[]};report.pairs.push(pair);
      const forbidden=((1<<settlements.length)-1)&~((1<<from)|(1<<to)),sources=[...access[from]!.keys()].filter(id=>!(masks[id]!&forbidden)),targets=new Set([...access[to]!.keys()].filter(id=>!(masks[id]!&forbidden)));
      if(!sources.length||!targets.size){pair.reason='NO_BROAD_EXIT';return report;}
      type DirectionBias={axis:'xMm'|'zMm';reverse:boolean};
      // Estimate additional reserved area per lattice node. The bounded stencil
      // favors overlap with already proved full-width corridors rather than
      // merely preferring the same one-dimensional centerline.
      const reuseCosts=sharedCells?new Uint16Array(count):undefined,stencil=Math.min(4,Math.ceil(radius/cell));
      let refinedEdgeCost:((from:number,to:number)=>number)|undefined;
      const refreshReuseCosts=()=>{if(reuseCosts)for(let id=0;id<count;id++)if(free[id]){
        let added=0;const x=id%cols,z=Math.floor(id/cols);
        for(let dz=-stencil;dz<=stencil;dz++)for(let dx=-stencil;dx<=stencil;dx++)if(x+dx>=0&&z+dz>=0&&x+dx<cols&&z+dz<rows&&!sharedCells![(z+dz)*cols+x+dx])added++;
        reuseCosts[id]=1+added*(distantFirst?32:1);
      }};
      refreshReuseCosts();
      const search=(first:readonly Position[]|undefined,sourceIds=sources,targetIds=targets,bias?:DirectionBias,reuse=false):number[]|undefined=>{
        const prior:Segment[]=first?first.slice(1).flatMap((p,i)=>outsideClearings(first[i]!,p,[a,b])):[],parents=new Int32Array(count).fill(-2),queue:number[]=[],separation2=passageWidthMm**2;
        const costs=bias||reuse?new Float64Array(count).fill(Infinity):undefined,heap:{id:number;cost:number}[]=[];
        const before=(a:{id:number;cost:number},b:{id:number;cost:number})=>a.cost<b.cost||(a.cost===b.cost&&a.id<b.id);
        const enqueue=(id:number,cost:number)=>{
          if(!costs){queue.push(id);return;}
          costs[id]=cost;const value={id,cost};let index=heap.length;heap.push(value);
          while(index){const parent=(index-1)>>1;if(!before(value,heap[parent]!))break;heap[index]=heap[parent]!;index=parent;}heap[index]=value;
        };
        const pop=()=>{const result=heap[0]!,last=heap.pop()!;if(heap.length){let index=0;while(index*2+1<heap.length){let child=index*2+1;if(child+1<heap.length&&before(heap[child+1]!,heap[child]!))child++;if(!before(heap[child]!,last))break;heap[index]=heap[child]!;index=child;}heap[index]=last;}return result;};
        const pointClear=(p:Position)=>distance2(p,a)<=(a.clearanceRadiusMm??40000)**2||distance2(p,b)<=(b.clearanceRadiusMm??40000)**2||prior.every(segment=>pointSegmentDistance2(p,...segment)>=separation2);
        const edgeClear=(p:Position,q:Position)=>!prior.length||outsideClearings(p,q,[a,b]).every(segment=>prior.every(other=>segmentDistance2(segment,other)>=separation2));
        for(const id of sourceIds)if(pointClear(points[id]!)){parents[id]=-1;enqueue(id,0);}
        for(let cursor=0;costs?heap.length>0:cursor<queue.length;cursor++){
          const item=costs?pop():undefined,id=item?.id??queue[cursor]!;if(costs&&item!.cost!==costs[id])continue;
          if(report.searchNodes>=5000000)throw new Error('BROAD_ROUTE_WORK_LIMIT');report.searchNodes++;
          if(targetIds.has(id)){const result:number[]=[];let node=id;while(node!==-1){result.push(node);node=parents[node]!;}return result.reverse();}
          for(let dir=0;dir<4;dir++){
            if(!(edges[id]!&(1<<dir))||(edgeMasks[id*4+dir]!&forbidden))continue;
            const next=id+offsets[dir]!,span=bias?.axis==='xMm'?widthMm:heightMm,coordinate=bias?points[id]![bias.axis]+points[next]![bias.axis]:0,cost=costs?costs[id]!+(reuse?(refinedEdgeCost?.(id,next)??reuseCosts![id]!+reuseCosts![next]!):span+4*(bias!.reverse?span*2-coordinate:coordinate)):0;
            if((costs?cost>=costs[next]!:parents[next]!==-2)||!pointClear(points[next]!)||!edgeClear(points[id]!,points[next]!))continue;
            parents[next]=id;enqueue(next,cost);
          }
        }
        return undefined;
      };
      // Ordinary shortest witnesses first; cardinal mouth alternatives avoid
      // consuming the middle of a broad open valley when a side route exists.
      const attempts:{sources:number[];targets:Set<number>;bias?:DirectionBias;reuse?:boolean}[]=[...(sharedCells?[{sources,targets,reuse:true}]:[]),{sources,targets}];
      for(const axis of ['xMm','zMm'] as const)for(const sign of [-1,1]){
        const rank=(ids:Iterable<number>)=>[...ids].sort((i,j)=>sign*(points[i]![axis]-points[j]![axis])||i-j);
        attempts.push({sources:rank(sources).slice(0,1),targets:new Set(rank(targets).slice(0,1))});
      }
      // Choosing another mouth alone still finds the same central shortest path.
      // Cardinal cost biases find a genuinely different side of the landscape,
      // without changing either width or the independent-corridor acceptance test.
      for(const axis of ['xMm','zMm'] as const)for(const reverse of [false,true])attempts.push({sources,targets,bias:{axis,reverse}});
      for(const attempt of attempts){
        const first=search(undefined,attempt.sources,attempt.targets,attempt.bias,attempt.reuse);if(!first)continue;
        const firstPoints=compact(first.map(id=>points[id]!)),second=search(firstPoints,sources,targets,undefined,attempt.reuse);
        if(!pair.routeCount){pair.routeCount=1;pair.routes=[firstPoints];pair.accessRoutes=[{from:access[from]!.get(first[0]!)!,to:access[to]!.get(first.at(-1)!)!}];}
        if(!second)continue;
        pair.routeCount=2;pair.routes=[firstPoints,compact(second.map(id=>points[id]!))];pair.accessRoutes=[first,second].map(route=>({from:access[from]!.get(route[0]!)!,to:access[to]!.get(route.at(-1)!)!}));break;
      }
      if(pair.routeCount!==2){pair.reason=pair.routeCount?'NO_INDEPENDENT_ROUTE':'NO_BROAD_ROUTE';return report;}
      if(sharedCells&&input.refineSharedCorridors)refinements.push(marginalCost=>{
        refinedEdgeCost=marginalCost;
        refreshReuseCosts();
        const first=search(undefined,sources,targets,undefined,true);if(!first)return undefined;
        const firstPoints=compact(first.map(id=>points[id]!)),second=search(firstPoints,sources,targets,undefined,true);if(!second)return undefined;
        return {fromPlayerId:a.playerId,toPlayerId:b.playerId,routeCount:2,routes:[firstPoints,compact(second.map(id=>points[id]!))],accessRoutes:[first,second].map(route=>({from:access[from]!.get(route[0]!)!,to:access[to]!.get(route.at(-1)!)!}))};
      });
      if(sharedCells)for(const path of pair.routes)for(let index=1;index<path.length;index++){
        const p=path[index-1]!,q=path[index]!;
        for(let z=Math.max(0,Math.ceil((Math.min(p.zMm,q.zMm)-radius)/cell));z<=Math.min(rows-1,Math.floor((Math.max(p.zMm,q.zMm)+radius)/cell));z++)for(let x=Math.max(0,Math.ceil((Math.min(p.xMm,q.xMm)-radius)/cell));x<=Math.min(cols-1,Math.floor((Math.max(p.xMm,q.xMm)+radius)/cell));x++)sharedCells[z*cols+x]=1;
      }
    }
    if(sharedCells&&refinements.length){
      // Earlier roads can become redundant once later pairs establish a shared
      // backbone. Remove only this pair's votes, then prefer all other roads.
      // An exact 3m cell/capsule union measures actual generation reservations;
      // the 8m preference grid never substitutes for physical route clearance.
      const packingCell=3000,packingCols=Math.floor(widthMm/packingCell),packingRows=Math.floor(heightMm/packingCell);
      const mask=(pair:BroadRoutePair,step:number,columns:number,rows:number,rounded:boolean):number[]=>{
        const cells=new Set<number>();
        for(const path of pair.routes)for(let i=1;i<path.length;i++){
          const a=path[i-1]!,b=path[i]!,left=Math.min(a.xMm,b.xMm),right=Math.max(a.xMm,b.xMm),top=Math.min(a.zMm,b.zMm),bottom=Math.max(a.zMm,b.zMm);
          for(let z=Math.max(0,rounded?Math.floor((top-radius)/step):Math.ceil((top-radius)/step));z<Math.min(rows,rounded?Math.ceil((bottom+radius)/step):Math.floor((bottom+radius)/step)+1);z++)for(let x=Math.max(0,rounded?Math.floor((left-radius)/step):Math.ceil((left-radius)/step));x<Math.min(columns,rounded?Math.ceil((right+radius)/step):Math.floor((right+radius)/step)+1);x++){
            const dx=Math.max(left-(x+1)*step,x*step-right,0),dz=Math.max(top-(z+1)*step,z*step-bottom,0);
            if(!rounded||dx*dx+dz*dz<=radius*radius)cells.add(z*columns+x);
          }
        }
        return [...cells];
      };
      const packed=report.pairs.map(pair=>mask(pair,packingCell,packingCols,packingRows,true)),coarse=report.pairs.map(pair=>mask(pair,cell,cols,rows,false));
      const packedRefs=new Uint16Array(packingCols*packingRows),coarseRefs=new Uint16Array(count);
      if(seed)for(let id=0;id<packedRefs.length;id++)packedRefs[id]=seed.cells[id]!;
      if(seedSharedCells)for(let id=0;id<count;id++)coarseRefs[id]=seedSharedCells[id]!;
      for(const ids of packed)for(const id of ids)packedRefs[id]!++;for(const ids of coarse)for(const id of ids)coarseRefs[id]!++;
      let refinementCellWork=0;
      for(let index=0;index<refinements.length&&report.searchNodes<4800000;index++){
        const oldPacked=packed[index]!,oldCoarse=coarse[index]!;
        let released=0;for(const id of oldPacked)if(--packedRefs[id]! ===0)released++;for(const id of oldCoarse)sharedCells[id]=+(--coarseRefs[id]!>0);
        let replacement:BroadRoutePair|undefined,exhausted=false;
        const marginalCosts=new Uint32Array(count*4),marginalCost=(from:number,to:number):number=>{
          const direction=offsets.indexOf(to-from),key=from*4+direction,cached=marginalCosts[key];if(cached)return cached;
          const a=points[from]!,b=points[to]!,left=Math.min(a.xMm,b.xMm),right=Math.max(a.xMm,b.xMm),top=Math.min(a.zMm,b.zMm),bottom=Math.max(a.zMm,b.zMm);let added=0;
          for(let z=Math.max(0,Math.floor((top-radius)/packingCell));z<Math.min(packingRows,Math.ceil((bottom+radius)/packingCell));z++)for(let x=Math.max(0,Math.floor((left-radius)/packingCell));x<Math.min(packingCols,Math.ceil((right+radius)/packingCell));x++){
            if(++refinementCellWork>25000000)throw new Error('BROAD_ROUTE_REFINEMENT_WORK_LIMIT');
            if(packedRefs[z*packingCols+x])continue;const dx=Math.max(left-(x+1)*packingCell,x*packingCell-right,0),dz=Math.max(top-(z+1)*packingCell,z*packingCell-bottom,0);if(dx*dx+dz*dz<=radius*radius)added++;
          }
          const cost=1+added*32;marginalCosts[key]=cost;marginalCosts[to*4+(direction+2)%4]=cost;return cost;
        };
        try{replacement=refinements[index]!(marginalCost);}catch(error){if(error instanceof Error&&(error.message==='BROAD_ROUTE_WORK_LIMIT'||error.message==='BROAD_ROUTE_REFINEMENT_WORK_LIMIT'))exhausted=true;else throw error;}
        const candidatePacked=replacement?mask(replacement,packingCell,packingCols,packingRows,true):[],added=candidatePacked.reduce((sum,id)=>sum+ +(packedRefs[id]===0),0);
        if(replacement&&added<released){report.pairs[index]=replacement;packed[index]=candidatePacked;coarse[index]=mask(replacement,cell,cols,rows,false);}
        for(const id of packed[index]!)packedRefs[id]!++;for(const id of coarse[index]!)sharedCells[id]=+(++coarseRefs[id]!>0);
        // Cleanup is optional: the already proven certificate remains valid if
        // its bounded search allowance runs out. No partial candidate is used.
        if(exhausted)break;
      }
    }
    report.valid=true;return report;
  } catch(error){if(error instanceof Error&&error.message==='BROAD_ROUTE_WORK_LIMIT')return {...report,valid:false,failure:'WORK_LIMIT'};throw error;}
}
