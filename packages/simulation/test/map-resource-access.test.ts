import { describe,expect,it } from 'vitest';
import { GenerationResourceAccess } from '../src/map-resource-access.js';
import { Navigation,type Obstacle } from '../src/navigation.js';

const wall=(id:string,x:number,z:number,width:number,depth:number):Obstacle=>({id,xMm:x,zMm:z,halfWidth:width/2,halfHeight:depth/2});
const options=(obstacles:Obstacle[]=[])=>({widthMm:24000,heightMm:24000,obstacles,workerRadiusMm:350});
describe('shared map resource accessibility proof',()=>{
  it('chooses a nearer obstructed workface over a farther visible one using the same walking metric',()=>{
    const input={widthMm:40000,heightMm:30000,workerRadiusMm:350,cellMm:1000,obstacles:[wall('short-ridge',12000,10000,1000,6000)]},index=new GenerationResourceAccess(input),from={xMm:5000,zMm:10000},near={xMm:17000,zMm:10000},far={xMm:5000,zMm:27000},nav=new Navigation(input.widthMm,input.heightMm,input.obstacles);
    expect(nav.clearLine(from,near,350)).toBe(false);expect(nav.clearLine(from,far,350)).toBe(true);
    const route=index.walkingRoute(from,[far,near],20000)!;
    expect(route).not.toBeNull();expect(route.path.at(-1)).toEqual(near);expect(route.distanceMm).toBeGreaterThan(12000);expect(route.distanceMm).toBeLessThan(17000);
    let position=from,total=0;for(const next of route.path){expect(nav.clearLine(position,next,350)).toBe(true);total+=Math.hypot(next.xMm-position.xMm,next.zMm-position.zMm);position=next;}expect(total).toBeCloseTo(route.distanceMm,8);
    expect(index.walkingDistance(from,[near,far],route.distanceMm-1)).toBeNull();
    expect(index.walkingDistance(from,[near,far],route.distanceMm)).toBeCloseTo(route.distanceMm,8);
  });

  it('resumes cached distance frontiers for farther goals and shares swept edges between rallies',()=>{
    const input={...options([wall('ridge',12000,12000,1000,12000)]),cellMm:1000},index=new GenerationResourceAccess(input),from={xMm:5000,zMm:8000},near={xMm:16000,zMm:8000},far={xMm:19000,zMm:18000};
    const short=index.walkingDistance(from,[near],18000);expect(short).not.toBeNull();const afterShort=index.diagnostics;
    const long=index.walkingRoute(from,[far],35000)!;expect(long).not.toBeNull();expect(long.distanceMm).toBeGreaterThan(short!);expect(index.diagnostics.distanceSearchNodes).toBeGreaterThan(afterShort.distanceSearchNodes);
    const afterLong=index.diagnostics;expect(index.walkingDistance(from,[far,near],35000)).toBe(short);expect(index.diagnostics.distanceSearchNodes).toBe(afterLong.distanceSearchNodes);
    const reverse=index.walkingDistance(far,[from],35000);expect(reverse).toBeCloseTo(long.distanceMm,8);
    const cold=new GenerationResourceAccess(input);expect(cold.walkingDistance(far,[from],35000)).toBeCloseTo(reverse!,8);
    expect(index.diagnostics.geometryQueries-afterLong.geometryQueries).toBeLessThan(cold.diagnostics.geometryQueries);
  });

  it('fails closed when nearest-distance proof exhausts work even if a farther direct route exists',()=>{
    const input={widthMm:40000,heightMm:30000,workerRadiusMm:350,cellMm:1000,obstacles:[wall('short-ridge',12000,10000,1000,6000)],maxDistanceSearchNodes:1},index=new GenerationResourceAccess(input);
    expect(index.walkingDistance({xMm:5000,zMm:10000},[{xMm:17000,zMm:10000},{xMm:5000,zMm:27000}],20000)).toBeNull();
    expect(index.diagnostics).toMatchObject({distanceSearchNodes:1,exhausted:true});
    expect(index.walkingDistance({xMm:5000,zMm:10000},[{xMm:5000,zMm:11000}],20000)).toBeNull();
  });

  it('proves a detour and reuses its connected component for later resources',()=>{
    const index=new GenerationResourceAccess(options([wall('ridge',12000,12000,4000,16000)]));
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:21000,zMm:12000})).toBe(true);
    const first=index.diagnostics;
    expect(first.components).toBe(1);
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:21000,zMm:12500})).toBe(true);
    expect(index.diagnostics.sampledCells).toBe(first.sampledCells);
    expect(index.diagnostics.geometryQueries-first.geometryQueries).toBeLessThan(60);
  });

  it('rejects an enclosed deposit and a blocked endpoint',()=>{
    const obstacles=[wall('north',12000,8000,10000,2000),wall('south',12000,16000,10000,2000),wall('west',8000,12000,2000,10000),wall('east',16000,12000,2000,10000)];
    const index=new GenerationResourceAccess(options(obstacles));
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:12000,zMm:12000})).toBe(false);
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:8000,zMm:12000})).toBe(false);
  });

  it('checks swept clearance rather than linking free grid endpoints through a thin wall',()=>{
    const index=new GenerationResourceAccess(options([wall('thin-wall',11000,12000,200,24000)]));
    expect(index.reachable({xMm:8000,zMm:12000},{xMm:14000,zMm:12000})).toBe(false);
  });

  it('keeps later target connectors available after a query from the wrong component',()=>{
    const obstacles=[wall('divider',12000,12000,1000,24000),wall('right-spur',18000,12000,2000,8000)],input=options(obstacles),index=new GenerationResourceAccess(input),target={xMm:14000,zMm:12000};
    expect(index.reachable({xMm:3000,zMm:12000},target)).toBe(false);
    // The target window starts on the wrong side of the divider, and the direct
    // right-side route meets the spur. A later connector must still prove a detour.
    expect(index.reachable({xMm:22000,zMm:12000},target)).toBe(true);
    expect(new Navigation(input.widthMm,input.heightMm,obstacles).path({xMm:22000,zMm:12000},target,input.workerRadiusMm)).not.toBeNull();
    expect(index.reachable({xMm:3000,zMm:14000},target)).toBe(false);
    expect(index.reachable({xMm:22000,zMm:14000},target)).toBe(true);
    expect(index.diagnostics.components).toBe(2);
  });

  it('proves another resource with a small remaining budget after the shared source flood',()=>{
    const input=options([wall('ridge',12000,12000,4000,16000)]),from={xMm:3000,zMm:12000},first={xMm:21000,zMm:12000},next={xMm:21000,zMm:12500},reference=new GenerationResourceAccess(input);
    expect(reference.reachable(from,first)).toBe(true);
    const index=new GenerationResourceAccess({...input,maxGeometryQueries:reference.diagnostics.geometryQueries+8});
    expect(index.reachable(from,first)).toBe(true);expect(index.reachable(from,next)).toBe(true);expect(index.diagnostics.exhausted).toBe(false);
  });

  it('requires a same-bank route when a resource can only be reached across the bank boundary',()=>{
    const obstacles=[wall('spur',6000,12000,12000,2000)],from={xMm:4000,zMm:4000},to={xMm:4000,zMm:20000};
    expect(new GenerationResourceAccess(options(obstacles)).reachable(from,to)).toBe(true);
    expect(new GenerationResourceAccess({...options(obstacles),bounds:{maxXMm:11999}}).reachable(from,to)).toBe(false);
  });

  it('fails closed after exhausting its fixed work budget, including a partially labelled component',()=>{
    const index=new GenerationResourceAccess({...options([wall('ridge',12000,12000,4000,16000)]),maxGeometryQueries:200});
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:21000,zMm:12000})).toBe(false);
    expect(index.diagnostics).toMatchObject({exhausted:true,geometryQueries:200,components:1});
    expect(index.reachable({xMm:3000,zMm:12000},{xMm:3500,zMm:12000})).toBe(false);
  });

  it('retains immutable geometry when an external obstacle changes',()=>{
    const obstacle=wall('wall',12000,12000,1000,24000),index=new GenerationResourceAccess(options([obstacle]));
    obstacle.zMm=50000;
    expect(index.reachable({xMm:4000,zMm:12000},{xMm:20000,zMm:12000})).toBe(false);
  });

  it('agrees conservatively with exact navigation across deterministic mixed obstacle fixtures',()=>{
    for(let seed=0;seed<4;seed++){
      const obstacles=[wall('a',8000+seed*500,8000,2500,9000),wall('b',16000,16000-seed*500,2500,9000)];
      const input=options(obstacles),index=new GenerationResourceAccess(input),nav=new Navigation(input.widthMm,input.heightMm,obstacles);
      for(const to of [{xMm:21000,zMm:21000},{xMm:12000,zMm:12000},{xMm:3000,zMm:20000}]){
        const from={xMm:3000,zMm:3000};if(index.reachable(from,to))expect(nav.path(from,to,input.workerRadiusMm)).not.toBeNull();
      }
    }
  });

  it('rejects invalid inputs and non-finite or out-of-bounds endpoints',()=>{
    expect(()=>new GenerationResourceAccess({...options(),cellMm:1})).toThrow('INVALID_RESOURCE_ACCESS_INDEX');
    expect(()=>new GenerationResourceAccess({...options(),bounds:{minXMm:15000,maxXMm:14000}})).toThrow('INVALID_RESOURCE_ACCESS_INDEX');
    const index=new GenerationResourceAccess(options());
    expect(index.reachable({xMm:NaN,zMm:3000},{xMm:3000,zMm:3000})).toBe(false);
    expect(index.reachable({xMm:-1,zMm:3000},{xMm:3000,zMm:3000})).toBe(false);
  });
  it('reaches ordinary work faces inside deposits spaced three metres apart on the generation lattice',()=>{
    const deposits=Array.from({length:36},(_,index)=>wall(`ore_${index}`,10000+index%6*3000,10000+Math.floor(index/6)*3000,1300,1300));
    const input={widthMm:36000,heightMm:36000,obstacles:deposits,workerRadiusMm:350,cellMm:1000};
    const from={xMm:3000,zMm:16000},to={xMm:14800,zMm:16000};
    expect(new GenerationResourceAccess(input).reachable(from,to)).toBe(true);
    expect(new Navigation(input.widthMm,input.heightMm,deposits).path(from,to,350)).not.toBeNull();
  });
});
