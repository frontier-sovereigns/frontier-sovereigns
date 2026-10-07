import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Navigation, navigationConnectors, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from '../src/navigation.js';
import { PathScheduler, CORNER_OBSTACLE_LIMIT, CORNER_POINT_LIMIT, CORNER_WORK_LIMIT, CORNER_SWEEP_MM, validCornerPathSearch, type PathRequest, type PathResult, type PathSchedulerState } from '../src/path-scheduler.js';
import { ApproachReservations, UnitSpatialIndex, LocalAvoidance, formationTargets, separatedStep } from '../src/movement.js';

describe('numeric dynamic spatial buckets',()=>{
  it('keeps persistent synchronized queries identical to a rebuilt roster after movement, shrinkage, deaths and garrisoning',()=>{
    const persistent=new UnitSpatialIndex(),start=Array.from({length:40},(_,index)=>({id:`unit_${index}`,xMm:1000+index*550,zMm:4000+(index%3)*1000,radiusMm:index===0?1500:350}));
    const rosters=[start,start.map(body=>body.id==='unit_0'?{...body,radiusMm:200}:body),start.filter((_,index)=>index%3!==0).map(body=>({...body,xMm:body.xMm+4500})),[],start];
    for(const roster of rosters){persistent.synchronize(roster);const rebuilt=new UnitSpatialIndex();for(const body of roster)rebuilt.set(body);for(const point of start)for(const reach of [0,1200,8000]){expect(persistent.nearby(point,reach)).toEqual(rebuilt.nearby(point,reach));expect(persistent.free(point,350,point.id)).toBe(rebuilt.free(point,350,point.id));expect(persistent.clearLine(point,{xMm:point.xMm+500,zMm:point.zMm+500},350,point.id)).toBe(rebuilt.clearLine(point,{xMm:point.xMm+500,zMm:point.zMm+500},350,point.id));}}
  });
  it('keeps signed boundary and fallback cells collision-free through moves and removals',()=>{
    const index=new UnitSpatialIndex(),values=[-4097,-4096,-1,0,4095,4096],bodies=values.flatMap((x,ix)=>values.map((z,iz)=>({id:`body_${ix}_${iz}`,xMm:x*4000+100,zMm:z*4000+100,radiusMm:350}))),live=new Map(bodies.map(body=>[body.id,body]));
    for(const body of bodies)index.set(body);
    const verify=()=>{for(const point of bodies)for(const distance of [0,4000,7000])expect(index.nearby(point,distance)).toEqual([...live.values()].filter(body=>Math.hypot(body.xMm-point.xMm,body.zMm-point.zMm)<=distance+body.radiusMm).sort((a,b)=>a.id.localeCompare(b.id)));};
    verify();const moved={...bodies[0]!,xMm:4096*4000+100,zMm:-4000+100};index.set(moved);live.set(moved.id,moved);index.delete(bodies[1]!.id);live.delete(bodies[1]!.id);verify();
  });
});
import type { Position } from '@frontier/shared';

describe('bounded exact endpoint bridges',()=>{
  // Public geometry/position from the tutorial's authorized tick-486 view.
  // This is a narrow-lane witness, not a reconstruction of the earlier command.
  const from={xMm:117691,zMm:197588},target={xMm:120850,zMm:190000},radius=350;
  const obstacles:Obstacle[]=[...Array.from({length:6},(_,index)=>({id:`berry_${index}`,xMm:114000+index%3*2200,zMm:196500+Math.floor(index/3)*2200,halfWidth:650,halfHeight:650})),{id:'proposed_house',xMm:118000,zMm:190000,halfWidth:2000,halfHeight:2000}];
  const navigation=(budget?:NavigationWorkBudget,nodes=30000)=>new Navigation(256000,256000,obstacles,nodes,1000,budget);
  function legal(nav:Navigation,start:Position,points:Position[]|null){expect(points).not.toBeNull();let previous=start;for(const point of points!){expect(nav.clearLine(previous,point,radius),`${JSON.stringify(previous)} -> ${JSON.stringify(point)}`).toBe(true);previous=point;}}
  it('finds a bent route out of a legal berry lane with no direct metre-lattice connector',()=>{
    const nav=navigation(),center=(cell:number)=>({xMm:cell%256*1000,zMm:Math.floor(cell/256)*1000});expect(nav.free(from,radius)).toBe(true);expect(navigationConnectors(nav,from,radius,1000,center)).toEqual([]);
    expect(nav.clearLine(from,{xMm:119450,zMm:from.zMm},radius)).toBe(true);expect(nav.clearLine({xMm:119450,zMm:from.zMm},target,radius)).toBe(true);
    const route=nav.path(from,target,radius);legal(nav,from,route);expect(route!.at(-1)).toEqual(target);const reverse=nav.path(target,from,radius);legal(nav,target,reverse);expect(reverse!.at(-1)).toEqual(from);
  });
  it('charges bridge queries to the original admission cap and search-node allowance',()=>{
    const budget={remaining:50000,used:0},nav=navigation(budget),route=nav.path(from,target,radius);legal(navigation(),from,route);expect(budget.remaining+budget.used).toBe(50000);expect(budget.used).toBeGreaterThan(0);
    const exhausted={remaining:10,used:0};expect(()=>navigation(exhausted).path(from,target,radius)).toThrow(PathBudgetExceededError);expect(exhausted).toEqual({remaining:0,used:10});expect(navigation(undefined,1).path(from,target,radius)).toBeNull();
  });
  it('advances at most one endpoint expansion per existing credit and preserves pending and completed chains through cold continuation',()=>{
    const nav=navigation(),scheduler=new PathScheduler(()=>nav,['p']),request:PathRequest={id:'bridge',unitId:'worker',profile:'p',orderRevision:1,from,target,radiusMm:radius};scheduler.request(request);
    for(let index=0;index<100;index++){scheduler.advance(1);if(scheduler.exportState().tasks[0]!.startBridge)break;}
    const before=scheduler.exportState();expect(before.tasks[0]!.startBridge).toBeDefined();scheduler.advance(1);const state=scheduler.exportState();expect(state.tasks[0]!.startBridge!.cursor).toBe(before.tasks[0]!.startBridge!.cursor+1);
    const restored=new PathScheduler(()=>nav,['p']);restored.importState(JSON.parse(JSON.stringify(state)));
    for(let index=0;index<50;index++){expect(restored.advance(256)).toEqual(scheduler.advance(256));expect(JSON.stringify(restored.exportState())).toBe(JSON.stringify(scheduler.exportState()));if(scheduler.exportState().tasks[0]!.result)break;}
    const result=scheduler.take('worker',1);expect(restored.take('worker',1)).toEqual(result);expect(result?.status).toBe('ready');if(result?.status==='ready'){legal(nav,from,result.points);expect(result.points.at(-1)).toEqual(target);}
  });
  it('invalidates completed bent endpoint chains and retains exact blocked outcomes',()=>{
    const nav=navigation(),scheduler=new PathScheduler(()=>nav,['p']),request:PathRequest={id:'bridge',unitId:'worker',profile:'p',orderRevision:1,from:target,target:from,radiusMm:radius};scheduler.request(request);
    for(let index=0;index<20;index++){scheduler.advance(4000);if(scheduler.exportState().tasks[0]!.result)break;}const task=scheduler.exportState().tasks[0]!;expect(task.result?.status).toBe('ready');expect(task.endRoutes?.length).toBeGreaterThan(0);
    scheduler.invalidate('p',[{xMm:118000,zMm:197500,widthMm:100,depthMm:100}]);expect(scheduler.exportState().tasks[0]!.stage).toBe('direct');
    const sealed=new Navigation(256000,256000,[...obstacles,{id:'sealed',xMm:from.xMm,zMm:from.zMm,halfWidth:400,halfHeight:400}]);expect(sealed.path(from,target,radius)).toBeNull();
  });
});

/** Original string-bucket geometry oracle. The production path search dispatches
 * to these unchanged free/clearLine rules, retaining its actual budget behavior. */
class StringBucketNavigation extends Navigation {
  private readonly originalBuckets=new Map<string,Obstacle[]>();
  constructor(widthMm:number,heightMm:number,obstacles:Obstacle[],maxSearchNodes=30000,cellMm=1000,workBudget?:NavigationWorkBudget,base?:StringBucketNavigation){
    super(widthMm,heightMm,obstacles,maxSearchNodes,cellMm,workBudget,base);
    if(base)for(const [key,bucket]of base.originalBuckets)this.originalBuckets.set(key,bucket);
    const copied=new Set<string>();
    for(const obstacle of obstacles)for(let z=Math.floor((obstacle.zMm-obstacle.halfHeight)/8000);z<=Math.floor((obstacle.zMm+obstacle.halfHeight)/8000);z++)for(let x=Math.floor((obstacle.xMm-obstacle.halfWidth)/8000);x<=Math.floor((obstacle.xMm+obstacle.halfWidth)/8000);x++){
      const key=`${x},${z}`;let bucket=this.originalBuckets.get(key)??[];if(base&&!copied.has(key)){bucket=[...bucket];copied.add(key);}bucket.push(obstacle);this.originalBuckets.set(key,bucket);
    }
  }
  override withAdditionalObstacles(obstacles:Obstacle[],maxSearchNodes=this.maxSearchNodes,cellMm=this.cellMm,workBudget?:NavigationWorkBudget):StringBucketNavigation{return new StringBucketNavigation(this.widthMm,this.heightMm,obstacles,maxSearchNodes,cellMm,workBudget,this);}
  private chargeOriginal():void{if(!this.workBudget)return;if(this.workBudget.remaining<=0)throw new PathBudgetExceededError();this.workBudget.remaining--;this.workBudget.used++;}
  override free(point:Position,radius:number,ignoredId?:string):boolean {
    if(point.xMm<radius||point.zMm<radius||point.xMm>this.widthMm-radius||point.zMm>this.heightMm-radius)return false;
    for(let z=Math.floor((point.zMm-radius)/8000);z<=Math.floor((point.zMm+radius)/8000);z++)for(let x=Math.floor((point.xMm-radius)/8000);x<=Math.floor((point.xMm+radius)/8000);x++){
      this.chargeOriginal();
      if(this.originalBuckets.get(`${x},${z}`)?.some(obstacle=>{
        this.chargeOriginal();if(obstacle.id===ignoredId)return false;if(obstacle.circle)return Math.hypot(point.xMm-obstacle.xMm,point.zMm-obstacle.zMm)<obstacle.halfWidth+radius;
        const dx=Math.max(0,Math.abs(point.xMm-obstacle.xMm)-obstacle.halfWidth),dz=Math.max(0,Math.abs(point.zMm-obstacle.zMm)-obstacle.halfHeight);
        return radius?dx*dx+dz*dz<radius*radius:Math.abs(point.xMm-obstacle.xMm)<obstacle.halfWidth&&Math.abs(point.zMm-obstacle.zMm)<obstacle.halfHeight;
      }))return false;
    }
    return true;
  }
  override clearLine(from:Position,to:Position,radius:number,ignoredId?:string):boolean {
    if(!this.free(from,radius,ignoredId)||!this.free(to,radius,ignoredId))return false;
    const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length2=dx*dx+dz*dz,seen=new Set<Obstacle>();
    const circle=(x:number,z:number,size:number)=>{const t=length2?Math.max(0,Math.min(1,((x-from.xMm)*dx+(z-from.zMm)*dz)/length2)):0;return Math.hypot(from.xMm+dx*t-x,from.zMm+dz*t-z)<size;};
    const rectangle=(left:number,top:number,right:number,bottom:number)=>{
      let enter=0,leave=1;
      if(dx===0){if(from.xMm<=left||from.xMm>=right)return false;}else{const a=(left-from.xMm)/dx,b=(right-from.xMm)/dx;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
      if(dz===0){if(from.zMm<=top||from.zMm>=bottom)return false;}else{const a=(top-from.zMm)/dz,b=(bottom-from.zMm)/dz;enter=Math.max(enter,Math.min(a,b));leave=Math.min(leave,Math.max(a,b));if(enter>=leave)return false;}
      return enter<leave;
    };
    for(let z=Math.floor((Math.min(from.zMm,to.zMm)-radius)/8000);z<=Math.floor((Math.max(from.zMm,to.zMm)+radius)/8000);z++)for(let x=Math.floor((Math.min(from.xMm,to.xMm)-radius)/8000);x<=Math.floor((Math.max(from.xMm,to.xMm)+radius)/8000);x++){
      this.chargeOriginal();for(const obstacle of this.originalBuckets.get(`${x},${z}`)??[]){
        if(obstacle.id===ignoredId||seen.has(obstacle))continue;seen.add(obstacle);this.chargeOriginal();
        if(obstacle.circle){if(circle(obstacle.xMm,obstacle.zMm,radius+obstacle.halfWidth))return false;continue;}
        const left=obstacle.xMm-obstacle.halfWidth,right=obstacle.xMm+obstacle.halfWidth,top=obstacle.zMm-obstacle.halfHeight,bottom=obstacle.zMm+obstacle.halfHeight;
        if(rectangle(left-radius,top,right+radius,bottom)||rectangle(left,top-radius,right,bottom+radius)||(radius>0&&(circle(left,top,radius)||circle(right,top,radius)||circle(left,bottom,radius)||circle(right,bottom,radius))))return false;
      }
    }
    return true;
  }
}

const request={id:'path1',unitId:'u1',orderRevision:1,from:{xMm:8000,zMm:24000},target:{xMm:56000,zMm:24000},radiusMm:350,profile:'p1'};
const barriers:Obstacle[]=[{id:'wall',xMm:32000,zMm:24000,halfWidth:1000,halfHeight:18000}];
describe('shared coarse geometry repair',()=>{
  const ridge:Obstacle={id:'ridge',xMm:64000,zMm:64000,halfWidth:1000,halfHeight:40000};
  const requests=Array.from({length:2},(_,index):PathRequest=>({id:`shared_${index}`,unitId:`shared_${index}`,profile:'p1',orderRevision:1,from:{xMm:8000+index*1000,zMm:24000},target:{xMm:120000,zMm:24000},radiusMm:350,workClass:'routine',enqueuedTick:7}));
  function prepared(){
    let nav=new Navigation(128000,128000,[ridge]);const scheduler=new PathScheduler(()=>nav,['p1']);for(const item of requests)scheduler.request(item);
    for(let batch=0;batch<1500;batch++){scheduler.advance(32);if(Object.keys(scheduler.exportState().sharedJobs!.registry.jobs[0]?.frontier.coarse.scores??{}).length>=8)break;}
    const saved=scheduler.exportState();expect(saved.sharedJobs!.registry.jobs).toHaveLength(1);expect(Object.keys(saved.sharedJobs!.registry.jobs[0]!.frontier.coarse.scores).length).toBeGreaterThanOrEqual(8);
    return {scheduler,saved,navigation:()=>nav,setObstacles:(obstacles:Obstacle[])=>{nav=new Navigation(128000,128000,obstacles);}};
  }
  it('keeps independent paid branches across obstacle addition/removal and resumes a cold save exactly',()=>{
    const fixture=prepared(),{scheduler,saved}=fixture,job=saved.sharedJobs!.registry.jobs[0]!,frontier=job.frontier;
    const endpointRegions=new Set([...frontier.startComponents,...frontier.endComponents].map(key=>key.slice(0,key.lastIndexOf(','))));
    const edited=Object.keys(frontier.coarse.scores).find(key=>!endpointRegions.has(key.slice(0,key.lastIndexOf(','))))!,[x,z]=edited.split(',').map(Number);
    const post:Obstacle={id:'building_or_tree',xMm:x!*16000+8000,zMm:z!*16000+8000,halfWidth:400,halfHeight:400},rectangle={xMm:post.xMm-400,zMm:post.zMm-400,widthMm:800,depthMm:800};
    fixture.setObstacles([ridge,post]);const nav=fixture.navigation(),free=nav.free.bind(nav);let queries=0;nav.free=(...args)=>{queries++;return free(...args);};
    scheduler.invalidate('p1',[rectangle]);expect(queries).toBe(0);
    const repaired=scheduler.exportState(),next=repaired.sharedJobs!.registry.jobs[0]!;
    expect(next.id).toBe(job.id);expect(next.geometryRevision).toBe(1);expect(next.frontier.coarse.scores[edited]).toBeUndefined();
    const unsafe=new Set<string>();for(const key of Object.keys(frontier.coarse.scores)){let cursor:string|undefined=key;while(cursor!==undefined){if(cursor.slice(0,cursor.lastIndexOf(','))===`${x},${z}`){unsafe.add(key);break;}cursor=frontier.coarse.parents[cursor];}}
    for(const [key,score] of Object.entries(frontier.coarse.scores))if(unsafe.has(key))expect(next.frontier.coarse.scores[key]).toBeUndefined();else expect(next.frontier.coarse.scores[key]).toBe(score);
    expect(repaired.tasks.every(task=>task.enqueuedTick===7&&!task.prepareEndpoints)).toBe(true);
    const cold=new PathScheduler(fixture.navigation,['p1']);cold.importState(JSON.parse(JSON.stringify(repaired)));
    // Removal, like addition, can change region component labels. Retain only
    // branches whose parent proofs are still valid, never old label identity.
    fixture.setObstacles([ridge]);for(const planner of [scheduler,cold])planner.invalidate('p1',[rectangle]);
    expect(scheduler.exportState().sharedJobs!.registry.jobs[0]!.id).toBe(job.id);
    for(let batch=0;batch<300;batch++){expect(cold.advance(512)).toEqual(scheduler.advance(512));expect(cold.exportState()).toEqual(scheduler.exportState());if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}
    for(const item of requests){const result=scheduler.take(item.unitId,1)!;expect(cold.take(item.unitId,1)).toEqual(result);assertClear(fixture.navigation(),item.from,result);}
  });
  it('discards affected shared branches when a gate closes and never returns a route through it',()=>{
    const fixture=prepared(),{scheduler,saved}=fixture,job=saved.sharedJobs!.registry.jobs[0]!;
    const gate:Obstacle={id:'closed_gate',xMm:64000,zMm:64000,halfWidth:1000,halfHeight:64000};fixture.setObstacles([gate]);
    scheduler.invalidate('p1',[{xMm:63000,zMm:0,widthMm:2000,depthMm:128000}]);
    expect(scheduler.exportState().sharedJobs!.registry.jobs[0]!.id).toBe(job.id);
    for(let batch=0;batch<400;batch++){scheduler.advance(512);if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}
    for(const item of requests)expect(scheduler.take(item.unitId,1)?.status).toBe('blocked');
  });
  it('starts fresh endpoint proofs after a tree is added beside a shared member destination',()=>{
    const fixture=prepared(),{scheduler}=fixture,post:Obstacle={id:'destination_tree',...requests[0]!.target,halfWidth:650,halfHeight:650};fixture.setObstacles([ridge,post]);
    scheduler.invalidate('p1',[{xMm:post.xMm-650,zMm:post.zMm-650,widthMm:1300,depthMm:1300}]);
    const state=scheduler.exportState();expect(state.sharedJobs!.registry.jobs).toHaveLength(0);expect(state.tasks.every(task=>task.prepareEndpoints&&task.enqueuedTick===7&&task.orderRevision===1)).toBe(true);
    for(let batch=0;batch<100;batch++){scheduler.advance(512);if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}
    for(const item of requests)expect(scheduler.take(item.unitId,1)?.status).toBe('blocked');
  });
});
describe('bounded long-route corner planning',()=>{
  const obstacle={id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000},from={xMm:16000,zMm:80000},target={xMm:144000,zMm:80000};
  const item:PathRequest={id:'long_route',unitId:'long_unit',profile:'p1',orderRevision:1,from,target,radiusMm:850};
  function create(obstacles:Obstacle[]=[obstacle]){const nav=new Navigation(192000,160000,obstacles);return {nav,scheduler:new PathScheduler(()=>nav,['p1','p2'])};}
  it('retains corner credits across unrelated resource edits with exact cold continuation',()=>{
    const sources=Array.from({length:CORNER_OBSTACLE_LIMIT},(_,index)=>({...obstacle,id:`ridge_${index}`})),far={id:'far_tree',xMm:180000,zMm:140000,halfWidth:350,halfHeight:350};
    let nav=new Navigation(192000,160000,[...sources,far]);const scheduler=new PathScheduler(()=>nav,['p1']);scheduler.request(item);
    for(let credit=0;credit<800;credit++){scheduler.advance(1);if(scheduler.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
    const before=scheduler.exportState().tasks[0]!;expect(before.corner?.phase).toBe('search');expect(before.corner!.work).toBeGreaterThan(CORNER_OBSTACLE_LIMIT);
    nav=new Navigation(192000,160000,sources);scheduler.invalidate('p1',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);expect(scheduler.exportState().tasks[0]).toEqual(before);
    const cold=new PathScheduler(()=>nav,['p1']);cold.importState(JSON.parse(JSON.stringify(scheduler.exportState())));
    for(let batch=0;batch<40;batch++){
      nav=new Navigation(192000,160000,batch%2?[...sources,far]:sources);
      for(const planner of [scheduler,cold])planner.invalidate('p1',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);
      expect(cold.advance(128)).toEqual(scheduler.advance(128));expect(cold.exportState()).toEqual(scheduler.exportState());
      const task=scheduler.exportState().tasks[0]!;if(task.corner)expect(validCornerPathSearch(task,nav.widthMm,nav.heightMm,nav.obstacles)).toBe(true);if(task.result)break;
    }
    assertClear(nav,from,scheduler.take(item.unitId,1)!,850);
  });
  it('abandons stale candidate provenance once and completes despite continuing distant geometry churn',()=>{
    const far={id:'removed_tree',xMm:180000,zMm:140000,halfWidth:350,halfHeight:350};let nav=new Navigation(192000,160000,[obstacle,far]);
    const scheduler=new PathScheduler(()=>nav,['p1']);scheduler.request(item);
    for(let credit=0;credit<800;credit++){scheduler.advance(1);if(scheduler.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
    expect(scheduler.exportState().tasks[0]!.corner?.phase).toBe('search');
    nav=new Navigation(192000,160000,[obstacle]);let queries=0;const free=nav.free.bind(nav);nav.free=(...args)=>{queries++;return free(...args);};
    scheduler.invalidate('p1',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);expect(queries).toBe(0);
    expect(scheduler.exportState().tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true,starts:[],ends:[]});expect(scheduler.exportState().tasks[0]!.corner).toBeUndefined();
    const cold=new PathScheduler(()=>nav,['p1']);cold.importState(JSON.parse(JSON.stringify(scheduler.exportState())));
    let work=0;for(let batch=0;batch<800;batch++){
      nav=new Navigation(192000,160000,batch%2?[obstacle,far]:[obstacle]);
      for(const planner of [scheduler,cold])planner.invalidate('p1',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);
      const report=scheduler.advance(128);work+=report.work;expect(cold.advance(128)).toEqual(report);expect(cold.exportState()).toEqual(scheduler.exportState());
      const task=scheduler.exportState().tasks[0]!;expect(['direct','corner']).not.toContain(task.stage);if(task.result)break;
    }
    expect(work).toBeLessThan(800*128);assertClear(nav,from,scheduler.take(item.unitId,1)!,850);
  });
  it('retains early region preparation for distant edits, but discards dependencies touched at an endpoint',()=>{
    let nav=new Navigation(192000,160000,[obstacle]);const scheduler=new PathScheduler(()=>nav,['p1']),short={...item,target:{xMm:80000,zMm:80000}};scheduler.request(short);
    for(let credit=0;credit<400;credit++){scheduler.advance(1);const task=scheduler.exportState().tasks[0]!;if(task.stage==='coarse'&&!task.coarse&&scheduler.exportState().regions.some(region=>region.cursor>3))break;}
    const before=scheduler.exportState();expect(before.tasks[0]!.stage).toBe('coarse');expect(before.tasks[0]!.coarse).toBeUndefined();
    scheduler.invalidate('p1',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);expect(scheduler.exportState().tasks).toEqual(before.tasks);expect(scheduler.exportState().regions).toEqual(before.regions);
    nav=new Navigation(192000,160000,[obstacle,{id:'endpoint_post',xMm:19000,zMm:80000,halfWidth:350,halfHeight:350}]);
    scheduler.invalidate('p1',[{xMm:18650,zMm:79650,widthMm:700,depthMm:700}]);expect(scheduler.exportState().tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true});
    assertClear(nav,from,finish(scheduler,item.unitId),850);
  });
  it('drops a corner frontier when a newly disclosed obstacle intersects a candidate leg',()=>{
    let nav=new Navigation(192000,160000,[obstacle]);const scheduler=new PathScheduler(()=>nav,['p1']);scheduler.request(item);
    for(let credit=0;credit<800;credit++){scheduler.advance(1);if(scheduler.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
    const candidate=scheduler.exportState().tasks[0]!.corner!.points[2]!,post={id:'new_post',...candidate,halfWidth:200,halfHeight:200};nav=new Navigation(192000,160000,[obstacle,post]);
    scheduler.invalidate('p1',[{xMm:post.xMm-200,zMm:post.zMm-200,widthMm:400,depthMm:400}]);
    expect(scheduler.exportState().tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true});expect(scheduler.exportState().tasks[0]!.corner).toBeUndefined();
    assertClear(nav,from,finish(scheduler,item.unitId),850);
  });
  it.each(['coarse','fine'] as const)('keeps an invalidated initialized %s request past its spent shortcuts across cold restoration',stage=>{
    let nav=new Navigation(128000,128000,barriers);const scheduler=new PathScheduler(()=>nav,['p1']);
    const owned={...request,workClass:'routine' as const,enqueuedTick:31};scheduler.request(owned);
    for(let batch=0;batch<1000;batch++){
      scheduler.advance(16);const task=scheduler.exportState().tasks[0]!;
      if(task.stage===stage&&task.coarse&&(stage==='coarse'?Object.keys(task.coarse.scores).length>1:task.fine!==undefined))break;
    }
    const before=scheduler.exportState(),task=before.tasks[0]!;expect(task.stage).toBe(stage);expect(task.coarse).toBeDefined();
    const farPrepared=before.regions.filter(region=>region.x>0);
    const post={id:'new_endpoint_post',xMm:11000,zMm:24000,halfWidth:400,halfHeight:400};nav=new Navigation(128000,128000,[...barriers,post]);
    scheduler.invalidate('p1',[{xMm:10600,zMm:23600,widthMm:800,depthMm:800}]);
    const restarted=scheduler.exportState();expect(restarted.tasks[0]).toMatchObject({id:owned.id,orderRevision:1,enqueuedTick:31,stage:'coarse',prepareEndpoints:true,starts:[],ends:[]});
    for(const key of ['coarse','fine','corner','currentComponent','edgeCursor','currentCell','neighborCursor','corridor','cacheKey','startComponents','endComponents'])expect(Object.hasOwn(restarted.tasks[0]!,key)).toBe(false);
    for(const region of farPrepared)expect(restarted.regions).toContainEqual(region);
    const cold=new PathScheduler(()=>nav,['p1']);cold.importState(JSON.parse(JSON.stringify(restarted)));
    for(let batch=0;batch<1000;batch++){
      const distant={xMm:120000,zMm:120000,widthMm:100,depthMm:100};scheduler.invalidate('p1',[distant]);cold.invalidate('p1',[distant]);
      expect(cold.advance(128)).toEqual(scheduler.advance(128));expect(cold.exportState()).toEqual(scheduler.exportState());
      const current=scheduler.exportState().tasks[0]!;expect(['direct','corner']).not.toContain(current.stage);if(current.result)break;
    }
    const result=scheduler.take(owned.unitId,1)!;expect(cold.take(owned.unitId,1)).toEqual(result);assertClear(nav,owned.from,result);
  });
  it('does not accept an old fine-search route after a new wall seals its destination',()=>{
    let nav=new Navigation(64000,64000,barriers);const scheduler=new PathScheduler(()=>nav,['p1']);scheduler.request(request);
    for(let batch=0;batch<1000;batch++){scheduler.advance(16);if(scheduler.exportState().tasks[0]!.stage==='fine')break;}
    expect(scheduler.exportState().tasks[0]!.stage).toBe('fine');
    nav=new Navigation(64000,64000,[...barriers,{id:'sealed',xMm:48000,zMm:32000,halfWidth:1000,halfHeight:32000}]);
    scheduler.invalidate('p1',[{xMm:47000,zMm:0,widthMm:2000,depthMm:64000}]);
    expect(scheduler.exportState().tasks[0]!.stage).toBe('coarse');expect(finish(scheduler).status).toBe('blocked');
  });
  it('repairs edited coarse branches without dropping unaffected parent proofs or querying geometry outside grants',()=>{
    let nav=new Navigation(64000,64000,barriers);const scheduler=new PathScheduler(()=>nav,['p1']);scheduler.request(request);
    for(let batch=0;batch<2000;batch++){scheduler.advance(4);const task=scheduler.exportState().tasks[0]!;if(task.stage==='coarse'&&Object.keys(task.coarse?.scores??{}).length>=5)break;}
    const before=scheduler.exportState().tasks[0]!;expect(before.stage).toBe('coarse');
    const endpoints=new Set([...before.startComponents!,...before.endComponents!].map(key=>key.slice(0,key.lastIndexOf(','))));
    const edited=Object.keys(before.coarse!.scores).find(key=>!endpoints.has(key.slice(0,key.lastIndexOf(','))))!;
    expect(edited).toBeDefined();const [x,z]=edited.split(',').map(Number),post={id:'new-middle-post',xMm:x!*16000+8000,zMm:z!*16000+8000,halfWidth:400,halfHeight:400};
    nav=new Navigation(64000,64000,[...barriers,post]);let queries=0;const free=nav.free.bind(nav);nav.free=(...args)=>{queries++;return free(...args);};
    scheduler.invalidate('p1',[{xMm:post.xMm-400,zMm:post.zMm-400,widthMm:800,depthMm:800}]);expect(queries).toBe(0);
    const after=scheduler.exportState().tasks[0]!;expect(after.stage).toBe('coarse');expect(after.prepareEndpoints).toBeUndefined();expect(after.coarse!.scores[edited]).toBeUndefined();
    for(const start of before.startComponents!)expect(after.coarse!.scores[start]).toBe(before.coarse!.scores[start]);
    const cold=new PathScheduler(()=>nav,['p1']);cold.importState(JSON.parse(JSON.stringify(scheduler.exportState())));
    for(let batch=0;batch<1000;batch++){expect(cold.advance(128)).toEqual(scheduler.advance(128));expect(cold.exportState()).toEqual(scheduler.exportState());if(scheduler.exportState().tasks[0]!.result)break;}
    const result=scheduler.take(request.unitId,1)!;expect(cold.take(request.unitId,1)).toEqual(result);assertClear(nav,request.from,result);
  });
  it('proves a bent siege route with one short sweep per credit and cold-continuation parity',()=>{
    const {nav,scheduler}=create();scheduler.request(item);const original=nav.clearLine.bind(nav);let calls=0,maxSpan=0;
    nav.clearLine=(a,b,radius,id)=>{calls++;maxSpan=Math.max(maxSpan,Math.hypot(b.xMm-a.xMm,b.zMm-a.zMm));return original(a,b,radius,id);};
    let cold:PathScheduler|undefined,cornerSeen=false,work=0;
    for(let index=0;index<7000;index++){
      calls=0;const report=scheduler.advance(2);expect(report.work).toBeLessThanOrEqual(1);expect(calls).toBeLessThanOrEqual(1);work+=report.work;
      const state=scheduler.exportState(),task=state.tasks[0]!;
      if(cold){expect(cold.advance(2)).toEqual(report);expect(cold.exportState()).toEqual(state);}
      if(task.corner){cornerSeen=true;expect(validCornerPathSearch(task,nav.widthMm,nav.heightMm,nav.obstacles)).toBe(true);if(!cold&&task.corner.sweepStep!>1){cold=new PathScheduler(()=>nav,['p1','p2']);cold.importState(JSON.parse(JSON.stringify(state)));}}
      if(task.result)break;
    }
    expect(cornerSeen).toBe(true);expect(cold).toBeDefined();expect(maxSpan).toBeLessThanOrEqual(CORNER_SWEEP_MM+.000001);expect(work).toBeLessThan(4600);
    const saved=scheduler.exportState();expect(saved.regions).toEqual([]);expect(saved.routes).toEqual([]);expect(saved.tasks[0]!.cacheKey).toBeUndefined();
    const result=scheduler.take(item.unitId,1);expect(cold!.take(item.unitId,1)).toEqual(result);expect(result?.status).toBe('ready');if(result?.status!=='ready')return;
    expect(result.points.length).toBeGreaterThan(1);let previous=from;for(const point of result.points){expect(original(previous,point,850)).toBe(true);previous=point;}expect(previous).toEqual(target);
  });
  it('invalidates bent completed legs outside the direct-line box, and rejects stale orders',()=>{
    let {nav,scheduler}=create();scheduler.request(item);scheduler.advance(12000);const saved=scheduler.exportState(),result=saved.tasks[0]!.result;expect(result?.status).toBe('ready');if(result?.status!=='ready')return;
    expect(scheduler.taskMirrors()[0]!.direct).toBe(false);const point=result.points[0]!;expect(Math.abs(point.zMm-from.zMm)).toBeGreaterThan(16000);
    const changed={xMm:point.xMm-100,zMm:point.zMm-100,widthMm:200,depthMm:200};scheduler.invalidate('p1',[changed]);expect(scheduler.exportState().tasks[0]!.stage).toBe('direct');expect(scheduler.isCurrent('p1',result.regions)).toBe(false);
    scheduler.request({...item,id:'newer',orderRevision:2,target:{xMm:20000,zMm:80000}});scheduler.request(item);expect(scheduler.take(item.unitId,1)).toBeUndefined();scheduler.advance(100);expect(scheduler.take(item.unitId,2)?.status).toBe('ready');
    scheduler.request({...item,id:'cancelled',orderRevision:3});scheduler.cancel(item.unitId);expect(scheduler.advance(12000).work).toBe(0);
  });
  it('keeps fixed-profile work independent of hidden requests and falls back after bounded candidate exhaustion',()=>{
    const a=create(),b=create();a.scheduler.request(item);b.scheduler.request(item);for(let index=0;index<8;index++)b.scheduler.request({...item,id:`hidden_${index}`,unitId:`hidden_${index}`,profile:'p2'});
    for(let tick=0;tick<15;tick++){a.scheduler.advance(256);b.scheduler.advance(256);expect(b.scheduler.exportState().tasks.find(task=>task.profile==='p1')).toEqual(a.scheduler.exportState().tasks[0]);}
    const blocked=create([{...obstacle,zMm:80000,halfHeight:80000}]);blocked.scheduler.request(item);let collected=false;
    for(let step=0;step<300;step++){blocked.scheduler.advance(2);const task=blocked.scheduler.exportState().tasks[0]!;collected||=task.stage==='corner';if(collected&&task.stage!=='corner'){expect(task.stage).toBe('coarse');expect(task.result).toBeUndefined();break;}}
    expect(collected).toBe(true);
    const many=create([{id:'left',xMm:142000,zMm:80000,halfWidth:500,halfHeight:5500},{id:'right',xMm:146000,zMm:80000,halfWidth:500,halfHeight:5500},{id:'top',xMm:144000,zMm:75000,halfWidth:2500,halfHeight:500},{id:'bottom',xMm:144000,zMm:85000,halfWidth:2500,halfHeight:500},...Array.from({length:400},(_,index)=>({id:`post_${index}`,xMm:22000+index%20*5000,zMm:22000+Math.floor(index/20)*5000,halfWidth:300,halfHeight:300}))]);many.scheduler.request(item);
    let cornerWork=0,coarse=false;for(let index=0;index<CORNER_WORK_LIMIT+1000;index++){many.scheduler.advance(2);const task=many.scheduler.exportState().tasks[0]!;if(task.corner){cornerWork=Math.max(cornerWork,task.corner.work);expect(task.corner.obstacleCursor).toBeLessThanOrEqual(CORNER_OBSTACLE_LIMIT);expect(task.corner.points.length).toBeLessThanOrEqual(CORNER_POINT_LIMIT+2);}else if(cornerWork){coarse=task.stage==='coarse';break;}}
    expect(cornerWork).toBeLessThanOrEqual(CORNER_WORK_LIMIT);expect(coarse).toBe(true);
  });
});
function finish(scheduler:PathScheduler,unit='u1',revision=1):PathResult {
  for(let tick=0;tick<1000;tick++){const report=scheduler.advance(128);expect(report.work).toBeLessThanOrEqual(128);const result=scheduler.take(unit,revision);if(result&&result.status!=='pending')return result;}
  throw new Error('Path request did not finish within its bounded fixture');
}
function assertClear(nav:Navigation,from:{xMm:number;zMm:number},result:PathResult,radius=350){expect(result.status).toBe('ready');if(result.status!=='ready')return;let prior=from;for(const point of result.points){expect(nav.clearLine(prior,point,radius)).toBe(true);prior=point;}}

describe('M7 narrow worksite lattice connectors',()=>{
  const from={xMm:118750,zMm:197600},target={xMm:118000,zMm:185000},radius=350;
  const berries:Obstacle[]=[196500,198700].flatMap(zMm=>[114000,116200,118400].map(xMm=>({id:`berry_${xMm}_${zMm}`,xMm,zMm,halfWidth:650,halfHeight:650})));
  const center=(id:number)=>({xMm:id%384*1000,zMm:Math.floor(id/384)*1000});
  function originalConnectors(nav:Navigation,point:Position){
    const result:number[]=[],cx=Math.floor(point.xMm/1000),cz=Math.floor(point.zMm/1000);
    for(let z=cz-1;z<=cz+1;z++)for(let x=cx-1;x<=cx+1;x++)if(x>=0&&z>=0&&x<384&&z<384){const id=z*384+x,p=center(id);if(nav.free(p,radius)&&nav.clearLine(point,p,radius))result.push(id);}
    return result.sort((a,b)=>Math.hypot(center(a).xMm-point.xMm,center(a).zMm-point.zMm)-Math.hypot(center(b).xMm-point.xMm,center(b).zMm-point.zMm)||a-b);
  }
  it.each([false,true])('proves a complete route into and out of the captured berry gap (reverse=%s)',reverse=>{
    const nav=new Navigation(384000,384000,berries),a=reverse?target:from,b=reverse?from:target;
    expect(nav.free(from,radius)).toBe(true);expect(nav.clearLine(from,{xMm:120000,zMm:197600},radius)).toBe(true);
    expect(originalConnectors(nav,from)).toEqual([]);expect(nav.clearLine(a,b,radius)).toBe(false);
    const connectors=navigationConnectors(nav,from,radius,1000,center).map(center);
    expect(connectors).toEqual([{xMm:121000,zMm:198000},{xMm:121000,zMm:197000}]);
    const path=nav.path(a,b,radius);expect(path).not.toBeNull();let prior=a;for(const point of path!){expect(nav.clearLine(prior,point,radius)).toBe(true);prior=point;}expect(prior).toEqual(b);
    const scheduler=new PathScheduler(()=>nav);scheduler.request({...request,from:a,target:b});assertClear(nav,a,finish(scheduler));
  });
  it('retains the original nine-query sequence and exact work charges when any neighboring connector exists',()=>{
    class TracedNavigation extends Navigation {
      queries:unknown[]=[];
      override free(point:Position,size:number,ignored?:string){this.queries.push(['free',point,size,ignored]);return super.free(point,size,ignored);}
      override clearLine(a:Position,b:Position,size:number,ignored?:string){this.queries.push(['line',a,b,size,ignored]);return super.clearLine(a,b,size,ignored);}
    }
    for(const point of [target,{xMm:350,zMm:350},{xMm:120250,zMm:197600}]){
      const a={remaining:10000,used:0},b={remaining:10000,used:0},nav=new TracedNavigation(384000,384000,berries,30000,1000,a),legacy=new TracedNavigation(384000,384000,berries,30000,1000,b);
      const expected=originalConnectors(legacy,point);expect(expected.length).toBeGreaterThan(0);
      expect(navigationConnectors(nav,point,radius,1000,center)).toEqual(expected);expect(nav.queries).toEqual(legacy.queries);expect(a).toEqual(b);
    }
  });
  it('bounds the fallback to49 candidate cells and nine sorted legal connectors without crossing sealed walls',()=>{
    const walls:Obstacle[]=[{id:'right',xMm:120000,zMm:197600,halfWidth:400,halfHeight:5000},{id:'left',xMm:112500,zMm:197600,halfWidth:400,halfHeight:5000}],open=new Navigation(384000,384000,[...berries,...walls]);
    expect(open.free(from,radius)).toBe(true);expect(navigationConnectors(open,from,radius,1000,center)).toEqual([]);
    // Two side walls leave both ends open. The endpoint bridge now correctly
    // follows the legal narrow lane to the north; absence of a straight lattice
    // connector alone must never be mistaken for physical enclosure.
    const path=open.path(from,target,radius);expect(path).not.toBeNull();let prior=from;for(const point of path!){expect(open.clearLine(prior,point,radius)).toBe(true);prior=point;}expect(prior).toEqual(target);
    const openScheduler=new PathScheduler(()=>open);openScheduler.request({...request,from,target});assertClear(open,from,finish(openScheduler));
    const nav=new Navigation(384000,384000,[...berries,...walls,...[192600,202600].map(zMm=>({id:`cap_${zMm}`,xMm:116250,zMm,halfWidth:4150,halfHeight:400}))]);
    expect(nav.free(from,radius)).toBe(true);expect(nav.free(target,radius)).toBe(true);expect(nav.clearLine({xMm:117250,zMm:195000},target,radius)).toBe(false);expect(nav.path(from,target,radius)).toBeNull();
    const scheduler=new PathScheduler(()=>nav);scheduler.request({...request,from,target});expect(finish(scheduler).status).toBe('blocked');
    // Isolated tiny posts block the nine original lattice nodes but leave many
    // distinct, swept-clear outer connectors. The saved endpoint cap stays nine.
    const posts:Obstacle[]=[];for(let z=4000;z<=6000;z+=1000)for(let x=4000;x<=6000;x+=1000)posts.push({id:`${x}_${z}`,xMm:x,zMm:z,halfWidth:40,halfHeight:40,circle:true});
    const gaps=new Navigation(384000,384000,posts),point={xMm:5500,zMm:5500},queried=new Set<number>();
    const cells=navigationConnectors(gaps,point,100,1000,id=>{queried.add(id);return center(id);});expect(cells).toHaveLength(9);expect(queried.size).toBeLessThanOrEqual(49);
    for(const cell of cells)expect(gaps.clearLine(point,center(cell),100)).toBe(true);
  });
  it('keeps exact admission exhaustion and never returns a partial escape proof',()=>{
    const budget={remaining:50000,used:0},nav=new Navigation(384000,384000,berries,30000,1000,budget),path=nav.path(from,target,radius),cost=budget.used;
    expect(path).not.toBeNull();expect(cost).toBeGreaterThan(9);expect(cost).toBeLessThan(50000);
    for(const remaining of [0,1,8,40,cost-1]){budget.remaining=remaining;budget.used=17;expect(()=>nav.path(from,target,radius)).toThrow(PathBudgetExceededError);expect(budget).toEqual({remaining:0,used:17+remaining});}
    budget.remaining=cost;budget.used=17;expect(nav.path(from,target,radius)).toEqual(path);expect(budget).toEqual({remaining:0,used:17+cost});
  });
  it('proves the actual cached connector from an expanded worksite without mutating the shared route',()=>{
    const nav=new Navigation(384000,384000,[...berries,{id:'detour',xMm:122000,zMm:191000,halfWidth:900,halfHeight:1800}]),scheduler=new PathScheduler(()=>nav);
    const source={...request,from:{xMm:126000,zMm:197600},target};expect(nav.clearLine(source.from,target,radius)).toBe(false);scheduler.request(source);assertClear(nav,source.from,finish(scheduler));
    const cached=scheduler.exportState().routes;expect(cached).toHaveLength(1);
    const local=navigationConnectors(nav,from,radius,1000,center).map(center);expect(local).not.toContainEqual(cached[0]![1].points[0]);
    scheduler.request({...request,id:'worksite_join',unitId:'worksite',from,target});const result=finish(scheduler,'worksite');assertClear(nav,from,result);
    expect(scheduler.advance(0).cacheHits).toBe(1);expect(scheduler.exportState().routes).toEqual(cached);
    if(result.status!=='ready')throw new Error('MISSING_JOIN');result.points[0]!.xMm=0;result.regions[0]!.revision=99;expect(scheduler.exportState().routes).toEqual(cached);
  });
  it('restores a pending expanded-connector search and includes connector footprint regions in invalidation',()=>{
    const shift={xMm:9000,zMm:11000},a={xMm:from.xMm+shift.xMm,zMm:from.zMm+shift.zMm},b={xMm:target.xMm+shift.xMm,zMm:target.zMm+shift.zMm};
    const nav=new Navigation(384000,384000,berries.map(obstacle=>({...obstacle,xMm:obstacle.xMm+shift.xMm,zMm:obstacle.zMm+shift.zMm}))),scheduler=new PathScheduler(()=>nav,['p1','p2']);scheduler.request({...request,from:a,target:b});
    for(let i=0;i<100&&scheduler.exportState().tasks[0]!.stage==='direct';i++)scheduler.advance(1);
    const saved=scheduler.exportState();expect(saved.tasks[0]!.stage).toBe('coarse');expect(saved.tasks[0]!.starts!.length).toBeGreaterThan(0);expect(saved.tasks[0]!.starts!.length).toBeLessThanOrEqual(9);
    const restored=new PathScheduler(()=>nav,['p1','p2']);restored.importState(JSON.parse(JSON.stringify(saved)));
    for(let i=0;i<1000;i++){const left=scheduler.advance(32),right=restored.advance(32);expect(left.work).toBeLessThanOrEqual(32);expect(right).toEqual(left);if(left.ready)break;}
    expect(restored.exportState()).toEqual(scheduler.exportState());const done=scheduler.exportState(),result=done.tasks[0]!.result!;assertClear(nav,a,result);
    if(result.status!=='ready')throw new Error('MISSING_READY_ROUTE');expect(result.regions.some(stamp=>stamp.region==='8,12')).toBe(true);expect(done.tasks[0]!.corridor).toContain('8,12');
    const change={xMm:130000,zMm:204000,widthMm:100,depthMm:100};scheduler.invalidate('p2',[change]);expect(scheduler.exportState().tasks).toEqual(done.tasks);expect(scheduler.isCurrent('p1',result.regions)).toBe(true);
    scheduler.invalidate('p1',[change]);expect(scheduler.exportState().tasks[0]!.stage).toBe('direct');expect(scheduler.isCurrent('p1',result.regions)).toBe(false);
    const pending=new PathScheduler(()=>nav,['p1','p2']);pending.importState(saved);pending.invalidate('p1',[change]);expect(pending.exportState().tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true,starts:[],ends:[]});
  });
});

describe('M3 persistent hierarchical navigation',()=>{
  it('matches original buckets through deep overlays, root misses, aliases, long sweeps and partial budgets',()=>{
    const shared:Obstacle={id:'shared',xMm:8000,zMm:8000,halfWidth:4000,halfHeight:2000};
    const obstacles:Obstacle[]=[shared,shared,{id:'root_only',xMm:100000,zMm:12000,halfWidth:2500,halfHeight:1250},{id:'signed',xMm:-100,zMm:30000,halfWidth:350,halfHeight:3000}];
    const left={remaining:0,used:0},right={remaining:0,used:0},base=new Navigation(128000,128000,obstacles,64,1000,left),original=new StringBucketNavigation(128000,128000,obstacles,64,1000,right);
    let actual=base,reference=original;
    for(let layer=0;layer<32;layer++){
      const extra:Obstacle={id:`layer_${layer}`,xMm:24000+(layer%4)*16000,zMm:24000+Math.floor(layer/4)*8000,halfWidth:layer%2?350:700,halfHeight:350,...(layer%2?{circle:true}:{})};
      const added=layer%4===0?[shared,extra,extra]:[extra];
      actual=actual.withAdditionalObstacles(added,64,layer%2?250:1000,left);reference=reference.withAdditionalObstacles(added,64,layer%2?250:1000,right);
    }
    const rootBuckets=(base as unknown as {buckets:Map<number|string,Obstacle[]>}).buckets;
    expect((actual as unknown as {inheritedBuckets:unknown}).inheritedBuckets).toBe(rootBuckets);
    expect(actual.obstacles).toEqual(reference.obstacles);expect(actual.obstacles[0]).toBe(actual.obstacles[1]);
    const points:Position[]=[{xMm:2000,zMm:30000},{xMm:4000,zMm:14000},{xMm:24000,zMm:24000},{xMm:100000,zMm:12000},{xMm:110000,zMm:110000},{xMm:120000,zMm:2000}];
    const query=(nav:Navigation,budget:NavigationWorkBudget,remaining:number,operation:(nav:Navigation)=>unknown)=>{
      budget.remaining=remaining;budget.used=11;let answer:unknown,error:string|undefined;
      try{answer=operation(nav);}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error=cause.message;}
      return {answer,error,remaining:budget.remaining,used:budget.used};
    };
    for(const remaining of [0,1,2,3,5,8,32,100000])for(const point of points)for(const radius of [0,350,850])for(const ignored of [undefined,'shared']){
      for(const operation of [(nav:Navigation)=>nav.free(point,radius,ignored),(nav:Navigation)=>nav.clearLine(point,points[4]!,radius,ignored),(nav:Navigation)=>nav.clearLine(points[4]!,point,radius,ignored)])
        expect(query(actual,left,remaining,operation)).toEqual(query(reference,right,remaining,operation));
    }
    shared.halfHeight=2500;
    const genericMutation=(nav:Navigation)=>nav.clearLine({xMm:4000,zMm:10500},{xMm:12000,zMm:10500},0);
    expect(query(actual,left,100000,genericMutation)).toEqual(query(reference,right,100000,genericMutation));
    expect(query(base,left,100000,nav=>nav.free({xMm:24000,zMm:24000},350))).toMatchObject({answer:true});
    expect(query(actual,left,100000,nav=>nav.free({xMm:24000,zMm:24000},350))).toMatchObject({answer:false});
  });

  it('shares a fixed root without observing later source-array membership or changing generic object aliases',()=>{
    const shared:Obstacle={id:'source',xMm:6000,zMm:6000,halfWidth:500,halfHeight:500},input=[shared,shared],base=new Navigation(64000,64000,input),reference=new StringBucketNavigation(64000,64000,input);
    const phantom:Obstacle={id:'array_only',xMm:40000,zMm:40000,halfWidth:500,halfHeight:500};input.push(phantom);
    const child=base.withAdditionalObstacles([]),expected=reference.withAdditionalObstacles([]);
    expect(child.obstacles).toEqual(expected.obstacles);expect(child.obstacles).toContain(phantom);
    // Generic Navigation has always fixed membership at construction, while
    // allowing referenced obstacle geometry to change in its original buckets.
    expect(child.free(phantom,350)).toBe(true);expect(child.free(phantom,350)).toBe(expected.free(phantom,350));
    shared.halfWidth=2500;
    expect(child.free({xMm:4000,zMm:6000},350)).toBe(false);expect(base.free({xMm:4000,zMm:6000},350)).toBe(false);
    const grandchild=child.withAdditionalObstacles([shared]);expect(grandchild.obstacles[0]).toBe(grandchild.obstacles.at(-1));
    expect((grandchild as unknown as {inheritedBuckets:unknown}).inheritedBuckets).toBe((base as unknown as {buckets:unknown}).buckets);
  });


  it('matches original string buckets through overlays, duplicate obstacle identities and every tested budget boundary',()=>{
    const shared:Obstacle={id:'shared',xMm:8000,zMm:8000,halfWidth:4000,halfHeight:2000},obstacles:Obstacle[]=[shared,shared,{id:'negative',xMm:-100,zMm:14000,halfWidth:250,halfHeight:2000},{id:'circle',xMm:16000,zMm:16000,halfWidth:550,halfHeight:550,circle:true},{id:'thin',xMm:8000.125,zMm:22000,halfWidth:.25,halfHeight:2000}];
    const left={remaining:0,used:0},right={remaining:0,used:0},numeric=new Navigation(64000,64000,obstacles,80,1000,left),original=new StringBucketNavigation(64000,64000,obstacles,80,1000,right);
    const extra:Obstacle={id:'extra',xMm:16000,zMm:22000,halfWidth:350,halfHeight:350,circle:true},overlay=numeric.withAdditionalObstacles([shared,extra],80,1000,left),reference=original.withAdditionalObstacles([shared,extra],80,1000,right),nested=overlay.withAdditionalObstacles([{id:'nested',xMm:25000,zMm:18000,halfWidth:800,halfHeight:800}],80,1000,left),nestedReference=reference.withAdditionalObstacles([{id:'nested',xMm:25000,zMm:18000,halfWidth:800,halfHeight:800}],80,1000,right);
    const points:Position[]=[{xMm:0,zMm:14000},{xMm:4000,zMm:12000},{xMm:7999.875,zMm:22000},{xMm:12000,zMm:8000},{xMm:16000,zMm:16000},{xMm:16000,zMm:22000},{xMm:25000,zMm:18000}];
    const evaluate=(nav:Navigation,budget:NavigationWorkBudget,remaining:number,query:(navigation:Navigation)=>unknown)=>{
      budget.remaining=remaining;budget.used=0;let result:unknown,error:string|undefined;try{result=query(nav);}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error=cause.message;}return {result,error,...budget};
    };
    for(const [actual,expected]of [[numeric,original],[overlay,reference],[nested,nestedReference]] as const)for(const remaining of [0,1,2,3,5,8,32,100000]){
      for(const [index,point]of points.entries())for(const radius of [0,350,850])for(const ignored of [undefined,'shared']){
        const other=points[(index+1)%points.length]!;
        expect(evaluate(actual,left,remaining,nav=>nav.free(point,radius,ignored))).toEqual(evaluate(expected,right,remaining,nav=>nav.free(point,radius,ignored)));
        expect(evaluate(actual,left,remaining,nav=>nav.clearLine(point,other,radius,ignored))).toEqual(evaluate(expected,right,remaining,nav=>nav.clearLine(point,other,radius,ignored)));
      }
      expect(evaluate(actual,left,remaining,nav=>nav.path({xMm:2000,zMm:8000},{xMm:14000,zMm:8000},350))).toEqual(evaluate(expected,right,remaining,nav=>nav.path({xMm:2000,zMm:8000},{xMm:14000,zMm:8000},350)));
      expect(evaluate(actual,left,remaining,nav=>nav.pathToAny({xMm:16000,zMm:24000},[{xMm:16000,zMm:22000},{xMm:18000,zMm:24000}],350))).toEqual(evaluate(expected,right,remaining,nav=>nav.pathToAny({xMm:16000,zMm:24000},[{xMm:16000,zMm:22000},{xMm:18000,zMm:24000}],350)));
    }
    left.remaining=right.remaining=100000;expect(numeric.free(extra,350)).toBe(true);expect(overlay.free(extra,350)).toBe(false);expect(overlay.free({xMm:25000,zMm:18000},350)).toBe(true);expect(nested.free({xMm:25000,zMm:18000},350)).toBe(false);
    expect(numeric.obstacles).toEqual(obstacles);expect(overlay.obstacles).toEqual([...obstacles,shared,extra]);
    shared.halfHeight=2500;left.remaining=right.remaining=100000;
    expect(numeric.clearLine({xMm:4000,zMm:10500},{xMm:12000,zMm:10500},0)).toBe(original.clearLine({xMm:4000,zMm:10500},{xMm:12000,zMm:10500},0));
  });

  it('keeps numeric and fallback bucket domains distinct at signed and fractional boundaries',()=>{
    const edge=4096*8000,obstacles:Obstacle[]=[
      {id:'negative-fast-alias',xMm:(-4096+.125)*8000,zMm:9000,halfWidth:300,halfHeight:300},
      {id:'negative-fallback',xMm:(-4096-.125)*8000,zMm:9000,halfWidth:300,halfHeight:300},
      {id:'positive-fallback',xMm:edge+1000,zMm:1000,halfWidth:300,halfHeight:300},
      {id:'fractional-x-edge',xMm:edge-.125,zMm:8000,halfWidth:.25,halfHeight:550},
      {id:'fractional-z-edge',xMm:8000,zMm:edge+.125,halfWidth:550,halfHeight:.25},
      {id:'negative-z',xMm:8000,zMm:-edge-.125,halfWidth:550,halfHeight:.25},
    ];
    const left={remaining:0,used:0},right={remaining:0,used:0},numeric=new Navigation(edge+16000,edge+16000,obstacles,80,1000,left),original=new StringBucketNavigation(edge+16000,edge+16000,obstacles,80,1000,right);
    const evaluate=(nav:Navigation,budget:NavigationWorkBudget,remaining:number,query:(navigation:Navigation)=>unknown)=>{budget.remaining=remaining;budget.used=0;let result:unknown,error:string|undefined;try{result=query(nav);}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error=cause.message;}return {result,error,...budget};};
    const points:Position[]=[{xMm:edge+1000,zMm:1000},{xMm:edge-.125,zMm:8000},{xMm:edge+.125,zMm:8000},{xMm:8000,zMm:edge-.125},{xMm:8000,zMm:edge+.125},{xMm:-edge,zMm:9000}];
    for(const remaining of [0,1,2,3,4,8,32,100000])for(const point of points)for(const radius of [0,.125,350]){
      expect(evaluate(numeric,left,remaining,nav=>nav.free(point,radius))).toEqual(evaluate(original,right,remaining,nav=>nav.free(point,radius)));
      const from={xMm:point.xMm-1000,zMm:point.zMm-1000},to={xMm:point.xMm+1000,zMm:point.zMm+1000};
      expect(evaluate(numeric,left,remaining,nav=>nav.clearLine(from,to,radius))).toEqual(evaluate(original,right,remaining,nav=>nav.clearLine(from,to,radius)));
    }
    left.remaining=100000;left.used=0;expect(numeric.free(points[0]!,0)).toBe(false);expect(left.used).toBe(2);
    for(const remaining of [0,1,3,8,100000])expect(evaluate(numeric,left,remaining,nav=>nav.path({xMm:edge-1000,zMm:12000},{xMm:edge+1000,zMm:12000},350))).toEqual(evaluate(original,right,remaining,nav=>nav.path({xMm:edge-1000,zMm:12000},{xMm:edge+1000,zMm:12000},350)));
  });

  it('routes through region components around an obstruction within per-tick work budgets',()=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav);scheduler.request(request);
    expect(scheduler.advance(1).work).toBe(1);expect(scheduler.take('u1',1)?.status).toBe('pending');
    const result=finish(scheduler);assertClear(nav,request.from,result);if(result.status==='ready')expect(result.points.some(point=>point.zMm>42000||point.zMm<6000)).toBe(true);
  });
  it('does not confuse disconnected components within one coarse region',()=>{
    const nav=new Navigation(32000,32000,[{id:'sealed',xMm:8000,zMm:16000,halfWidth:1000,halfHeight:16000}]),scheduler=new PathScheduler(()=>nav);
    scheduler.request({...request,from:{xMm:3000,zMm:8000},target:{xMm:13000,zMm:8000}});
    expect(finish(scheduler).status).toBe('blocked');
  });
  it('honors radius clearance and samples narrow barriers between grid centers',()=>{
    const obstacles=[{id:'west',xMm:16000,zMm:7250,halfWidth:300,halfHeight:7250},{id:'east',xMm:16000,zMm:24250,halfWidth:300,halfHeight:7750}];
    const nav=new Navigation(32000,32000,obstacles),scheduler=new PathScheduler(()=>nav);
    scheduler.request({...request,from:{xMm:3000,zMm:15500},target:{xMm:29000,zMm:15500},radiusMm:350});
    assertClear(nav,{xMm:3000,zMm:15500},finish(scheduler));
    const closed=new Navigation(32000,32000,[{id:'thin',xMm:16000,zMm:16000,halfWidth:50,halfHeight:16000}]),other=new PathScheduler(()=>closed);
    other.request({...request,from:{xMm:10000,zMm:15500},target:{xMm:22000,zMm:15500}});expect(finish(other).status).toBe('blocked');
  });
  it('routes an off-center siege body through a physically legal two-meter breach',()=>{
    const wall=Array.from({length:50},(_,x)=>({id:`wall_${x}`,xMm:1000+x*2000,zMm:49000,halfWidth:1000,halfHeight:1000})).filter((_wall,x)=>x!==25);
    const nav=new Navigation(100000,100000,wall),scheduler=new PathScheduler(()=>nav),from={xMm:51953,zMm:45402},target={xMm:51000,zMm:58000};
    expect(nav.clearLine(from,target,850)).toBe(false);expect(nav.path(from,target,850)).not.toBeNull();
    scheduler.request({...request,from,target,radiusMm:850});const result=finish(scheduler);assertClear(nav,from,result,850);
    if(result.status==='ready')expect(result.points.some(point=>point.xMm===51000)).toBe(true);
  });
  it('connects a physically legal infantry destination between two-meter resource rows',()=>{
    const obstacles:Obstacle[]=[{id:'north',xMm:40000,zMm:18500,halfWidth:1000,halfHeight:18500},{id:'south',xMm:40000,zMm:70500,halfWidth:1000,halfHeight:29500}];
    for(let z=0;z<4;z++)for(let x=0;x<3;x++)obstacles.push({id:`wood_${x}_${z}`,xMm:52000+x*2000,zMm:36000+z*2000,halfWidth:450,halfHeight:450});
    const nav=new Navigation(100000,100000,obstacles),scheduler=new PathScheduler(()=>nav),from={xMm:13957,zMm:41314},target={xMm:52000,zMm:41000};
    expect(nav.free(target,350)).toBe(true);expect(nav.clearLine(from,target,350)).toBe(false);expect(nav.path(from,target,350)).not.toBeNull();
    scheduler.request({...request,from,target});assertClear(nav,from,finish(scheduler));
  });
  it('discards cancelled and superseded path work',()=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav);scheduler.request(request);scheduler.advance(100);scheduler.cancel('u1');scheduler.advance(10000);expect(scheduler.take('u1',1)).toBeUndefined();
    scheduler.request(request);scheduler.advance(50);scheduler.request({...request,id:'path2',orderRevision:2,target:{xMm:10000,zMm:26000}});
    expect(scheduler.take('u1',1)).toBeUndefined();const result=finish(scheduler,'u1',2);expect(result.status).toBe('ready');if(result.status==='ready')expect(result.points.at(-1)).toEqual({xMm:10000,zMm:26000});
  });
  it('exports and restores a partially expanded search without changing results or work timing',()=>{
    const nav=new Navigation(64000,64000,barriers),a=new PathScheduler(()=>nav);a.request(request);a.advance(800);
    const b=new PathScheduler(()=>nav);b.importState(JSON.parse(JSON.stringify(a.exportState())));
    for(let tick=0;tick<500;tick++){expect(b.advance(91)).toEqual(a.advance(91));const ar=a.take('u1',1),br=b.take('u1',1);expect(br).toEqual(ar);if(ar?.status!=='pending'){expect(ar?.status).toBe('ready');break;}}
  });
  it('retains a long direct sweep across unrelated observations and restarts for an intersecting change',()=>{
    let nav=new Navigation(320000,320000,[]);const scheduler=new PathScheduler(()=>nav,['p1','p2']);
    const long={...request,from:{xMm:231150,zMm:177000},target:{xMm:30500,zMm:235000}};scheduler.request(long);
    for(let tick=0;tick<10;tick++){
      scheduler.advance(40);const before=scheduler.exportState().tasks[0]!.lineStep;
      scheduler.invalidate('p1',[{xMm:20000+tick*2000,zMm:20000,widthMm:1000,depthMm:1000}]);
      expect(scheduler.exportState().tasks[0]!.lineStep).toBe(before);
    }
    nav=new Navigation(320000,320000,[{id:'new_wall',xMm:140000,zMm:205000,halfWidth:1000,halfHeight:10000}]);
    scheduler.invalidate('p1',[{xMm:139000,zMm:195000,widthMm:2000,depthMm:20000}]);expect(scheduler.exportState().tasks[0]!.lineStep).toBe(0);
    assertClear(nav,long.from,finish(scheduler));
  });
  it('invalidates only affected known-profile routes and opens a real breach',()=>{
    let nav=new Navigation(64000,64000,[{id:'wall',xMm:32000,zMm:32000,halfWidth:1000,halfHeight:32000}]);
    const scheduler=new PathScheduler(()=>nav);scheduler.request(request);expect(finish(scheduler).status).toBe('blocked');
    nav=new Navigation(64000,64000,[{id:'north',xMm:32000,zMm:11000,halfWidth:1000,halfHeight:11000},{id:'south',xMm:32000,zMm:45000,halfWidth:1000,halfHeight:19000}]);
    scheduler.invalidate('p1',[{xMm:31000,zMm:22000,widthMm:2000,depthMm:4000}]);scheduler.request({...request,id:'breach',orderRevision:2});const result=finish(scheduler,'u1',2);assertClear(nav,request.from,result);
    if(result.status==='ready'){scheduler.invalidate('other',[{xMm:0,zMm:0,widthMm:64000,depthMm:64000}]);expect(scheduler.isCurrent('p1',result.regions)).toBe(true);scheduler.invalidate('p1',[{xMm:31000,zMm:22000,widthMm:2000,depthMm:4000}]);expect(scheduler.isCurrent('p1',result.regions)).toBe(false);}
  });
  it('reuses a compatible cached route without accumulating past arrival destinations',()=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav);scheduler.request(request);const first=finish(scheduler);expect(first.status).toBe('ready');
    scheduler.request({...request,id:'group2',unitId:'u2',from:{xMm:8500,zMm:24500},target:{xMm:56500,zMm:24500}});assertClear(nav,{xMm:8500,zMm:24500},finish(scheduler,'u2'));
    expect(scheduler.advance(0).cacheHits).toBeGreaterThan(0);
  });
  it('keeps own path completion timing independent of hidden enemy request volume',()=>{
    const nav=new Navigation(64000,64000,barriers),a=new PathScheduler(()=>nav,['p1','p2']),b=new PathScheduler(()=>nav,['p1','p2']);a.request(request);b.request(request);
    for(let i=0;i<100;i++)b.request({...request,id:`enemy${i}`,unitId:`enemy${i}`,profile:'p2'});
    for(let tick=0;tick<1000;tick++){a.advance(512);b.advance(512);const ar=a.take('u1',1),br=b.take('u1',1);expect(br).toEqual(ar);if(ar?.status==='ready')return;}throw new Error('Own request did not finish');
  });
});

describe('M8 fine-search plateau ordering',()=>{
  type Task=PathSchedulerState['tasks'][number];
  const obstacle:Obstacle={id:'post',xMm:23000,zMm:23000,halfWidth:500,halfHeight:500};
  const plateau:PathRequest={...request,id:'plateau',from:{xMm:18000,zMm:18000},target:{xMm:29000,zMm:29000}};
  function readyForFine(nav:Navigation,item=plateau){
    const scheduler=new PathScheduler(()=>nav);scheduler.request(item);
    for(let work=0;work<20000;work++){expect(scheduler.advance(1).work).toBe(1);const state=scheduler.exportState();if(state.tasks[0]?.stage==='fine')return {scheduler,state};}
    throw new Error('PLATEAU_FIXTURE_DID_NOT_ENTER_FINE_SEARCH');
  }
  function graph(nav:Navigation,task:Task){
    const width=Math.floor(nav.widthMm/1000),height=Math.floor(nav.heightMm/1000),corridor=new Set(task.corridor);
    const point=(cell:number)=>({xMm:cell%width*1000,zMm:Math.floor(cell/width)*1000});
    const neighbors=(cell:number)=>{
      const x=cell%width,z=Math.floor(cell/width),from=point(cell),result:number[]=[];
      for(const [dx,dz]of [[0,-1],[-1,0],[1,0],[0,1]]){const nx=x+dx!,nz=z+dz!,next=nz*width+nx,to=point(next);
        if(nx>=0&&nz>=0&&nx<width&&nz<height&&corridor.has(`${Math.floor(nx/16)},${Math.floor(nz/16)}`)&&nav.free(to,task.radiusMm)&&nav.clearLine(from,to,task.radiusMm))result.push(next);
      }
      return result;
    };
    return {point,neighbors};
  }
  // Independent FIFO shortest-edge oracle, including each ordinary start
  // connector's Euclidean cost. This fixture has integer-metre goals, so h=0
  // for all end cells; no global shortest-physical-route claim is made.
  function shortestCost(nav:Navigation,task:Task):number{
    const {point,neighbors}=graph(nav,task),ends=new Set(task.ends);let best=Infinity;
    for(const start of task.starts!){const queue=[start],distances=new Map([[start,0]]);
      for(let index=0;index<queue.length;index++){const cell=queue[index]!,distance=distances.get(cell)!;
        if(ends.has(cell)){const p=point(start);best=Math.min(best,distance+Math.hypot(p.xMm-task.from.xMm,p.zMm-task.from.zMm)/1000);break;}
        for(const next of neighbors(cell))if(!distances.has(next)){distances.set(next,distance+1);queue.push(next);}
      }
    }
    return best;
  }
  // A sorted-array A* oracle retains the old f/lexical rule without sharing the
  // production binary heap or its comparator implementation.
  function legacyFine(nav:Navigation,task:Task){
    const {point,neighbors}=graph(nav,task),open=structuredClone(task.fine!.heap),scores=new Map(Object.entries(task.fine!.scores)),closed=new Set<string>(),ends=new Set(task.ends);
    for(let count=0;count<20000&&open.length;count++){
      open.sort((a,b)=>a.score-b.score||(a.key<b.key?-1:a.key>b.key?1:0));const current=open.shift()!;if(closed.has(current.key))continue;
      const cell=Number(current.key),cost=scores.get(current.key)!;if(ends.has(cell))return {cost,closed:closed.size};closed.add(current.key);
      for(const next of neighbors(cell)){const key=String(next);if(closed.has(key)||cost+1>=(scores.get(key)??Infinity))continue;
        scores.set(key,cost+1);const p=point(next),h=Math.max(0,Math.abs(p.xMm-task.target.xMm)/1000-1)+Math.max(0,Math.abs(p.zMm-task.target.zMm)/1000-1);open.push({key,score:cost+1+h});
      }
    }
    throw new Error('LEGACY_PLATEAU_ORACLE_EXHAUSTED');
  }
  function completeFine(scheduler:PathScheduler){
    for(let work=0;work<20000;work++){expect(scheduler.advance(1).work).toBe(1);const task=scheduler.exportState().tasks[0]!;if(task.stage==='done')return task;}
    throw new Error('FINE_SEARCH_FIXTURE_EXHAUSTED');
  }
  function finalCost(nav:Navigation,task:Task):number{
    if(task.result?.status!=='ready')throw new Error('FINE_SEARCH_NOT_READY');
    const goal=task.result.points.at(-2)!;return task.fine!.scores[String(goal.zMm/1000*Math.floor(nav.widthMm/1000)+goal.xMm/1000)]!;
  }
  it('crosses a measured equal-f plateau with the same shortest graph cost and clear route',()=>{
    const nav=new Navigation(64000,64000,[obstacle]),{scheduler,state}=readyForFine(nav),initial=state.tasks[0]!,legacy=legacyFine(nav,initial),cost=shortestCost(nav,initial);
    expect(initial.corridor).toEqual(['1,1']);expect(nav.clearLine(plateau.from,plateau.target,350)).toBe(false);
    const completed=completeFine(scheduler);assertClear(nav,plateau.from,completed.result!);expect(finalCost(nav,completed)).toBeCloseTo(cost,12);expect(legacy.cost).toBeCloseTo(cost,12);
    // The sealed prechange fixture expanded98 cells; independent legacy search
    // reproduces it. Goal-directed ties expand18, without changing the budget.
    expect(legacy.closed).toBe(98);expect(Object.keys(completed.fine!.closed)).toHaveLength(18);
  });
  it.each([
    [{xMm:18000,zMm:18000},{xMm:29000,zMm:29000}],
    [{xMm:29000,zMm:29000},{xMm:18000,zMm:18000}],
    [{xMm:18000,zMm:29000},{xMm:29000,zMm:18000}],
    [{xMm:29000,zMm:18000},{xMm:18000,zMm:29000}],
  ])('preserves the graph optimum across grid-key directions (%j to %j)',(from,target)=>{
    const nav=new Navigation(64000,64000,[obstacle]),{scheduler,state}=readyForFine(nav,{...plateau,from,target}),cost=shortestCost(nav,state.tasks[0]!);
    const completed=completeFine(scheduler);expect(finalCost(nav,completed)).toBeCloseTo(cost,12);assertClear(nav,from,completed.result!);
  });
  it.each([350,550,850])('keeps off-grid endpoints and mixed-radius collision proofs (%imm)',radiusMm=>{
    const nav=new Navigation(64000,64000,[obstacle]),item={...plateau,radiusMm,from:{xMm:18231,zMm:18479},target:{xMm:28713,zMm:29387}}, {scheduler}=readyForFine(nav,item);
    const completed=completeFine(scheduler);assertClear(nav,item.from,completed.result!,radiusMm);if(completed.result?.status==='ready')expect(completed.result.points.at(-1)).toEqual(item.target);
  });
  it.each([0,1,2,3])('restores the exact heap and continuation at fine neighbor boundary %i',extra=>{
    const nav=new Navigation(64000,64000,[obstacle]),{scheduler}=readyForFine(nav);scheduler.advance(extra);const saved=scheduler.exportState(),task=saved.tasks[0]!;
    expect(task.fine!.heap.length).toBeGreaterThan(1);expect(task.neighborCursor).toBe(extra||undefined);
    const restored=new PathScheduler(()=>nav);restored.importState(JSON.parse(JSON.stringify(saved)));expect(restored.exportState()).toEqual(saved);
    for(let tick=0;tick<100;tick++){
      const budget=[0,1,2,7,11,19][tick%6]!,left=scheduler.advance(budget),right=restored.advance(budget);
      expect(left.work).toBeLessThanOrEqual(budget);expect(right).toEqual(left);expect(restored.exportState()).toEqual(scheduler.exportState());
      if(left.ready){const a=scheduler.take('u1',1),b=restored.take('u1',1);expect(b).toEqual(a);assertClear(nav,plateau.from,a!);return;}
    }
    throw new Error('RESTORED_FINE_FIXTURE_DID_NOT_FINISH');
  });
});

describe('M8 late compatible route reuse',()=>{
  const pair:PathRequest[]=[
    {...request,from:{xMm:15000,zMm:24000},target:{xMm:47000,zMm:24000}},
    {...request,id:'path2',unitId:'u2',from:{xMm:16000,zMm:24000},target:{xMm:48000,zMm:24000}},
  ];
  const partial:PathRequest[]=[
    {...request,from:{xMm:14500,zMm:24000},target:{xMm:46500,zMm:24000}},
    {...request,id:'partial2',unitId:'u2',from:{xMm:15500,zMm:24000},target:{xMm:47500,zMm:24000}},
  ];
  function until(scheduler:PathScheduler,predicate:(state:Pick<PathSchedulerState,'tasks'|'routes'>)=>boolean,budget=32):PathSchedulerState {
    // Observe private phase membership without cloning thousands of search cells
    // after every single work step; capture the detached state only at the boundary.
    const internals=scheduler as unknown as {tasks:Map<string,PathSchedulerState['tasks'][number]>;routes:Map<string,PathSchedulerState['routes'][number][1]>};
    for(let work=0;work<128000;work+=budget){const report=scheduler.advance(budget);expect(report.work).toBeLessThanOrEqual(budget);if(predicate({tasks:[...internals.tasks.values()],routes:[...internals.routes]}))return scheduler.exportState();}
    throw new Error('Bounded route fixture did not reach its expected phase');
  }
  function bothFine(scheduler:PathScheduler,ids=['u1','u2']){return until(scheduler,state=>ids.every(id=>state.tasks.find(task=>task.unitId===id)?.stage==='fine'));}

  it('canonicalizes only key component sets and reuses a peer route after both requests already entered fine search',()=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav,['p1','p2']);for(const item of pair)scheduler.request(item);
    const pending=bothFine(scheduler),[a,b]=pending.tasks;
    expect(pending.routes).toEqual([]);expect(pending.tasks.every(task=>!task.lateCacheChecked)).toBe(true);expect(a!.startComponents).not.toEqual(b!.startComponents);expect([...a!.startComponents!].sort()).toEqual([...b!.startComponents!].sort());expect(a!.cacheKey).toBe(b!.cacheKey);
    const done=until(scheduler,state=>state.tasks.every(task=>task.stage==='done'));
    expect(done.tasks.filter(task=>task.lateCacheChecked)).toHaveLength(1);expect(scheduler.advance(0).cacheHits).toBe(1);expect(done.routes).toHaveLength(1);
    for(const item of pair){const result=scheduler.take(item.unitId,item.orderRevision)!;assertClear(nav,item.from,result);if(result.status==='ready')expect(result.points.at(-1)).toEqual(item.target);}
    const cachedBefore=structuredClone(done.routes);done.tasks[0]!.result={status:'blocked',id:'mutated',orderRevision:999};done.routes[0]![1].points[0]!.xMm=1;
    expect(scheduler.exportState().routes).toEqual(cachedBefore);
  });

  it.each(['start','end'] as const)('tries a blocked late %s connector once and preserves the checked decision through restoration',side=>{
    const nav=new Navigation(64000,64000,[...barriers,{id:'local_post',xMm:side==='start'?9000:55000,zMm:24000,halfWidth:350,halfHeight:1500}]),scheduler=new PathScheduler(()=>nav,['p1','p2']);
    const first={...request,...(side==='end'?{target:{xMm:54000,zMm:24000}}:{})},second={...request,id:'path2',unitId:'u2',from:side==='start'?{xMm:10000,zMm:24000}:{xMm:8500,zMm:24500},target:side==='start'?{xMm:56500,zMm:24500}:{xMm:56000,zMm:24000}},original=nav.clearLine.bind(nav),connectorCalls=new Map<string,number>();
    nav.clearLine=(from,to,radius,ignored)=>{if([first,second].some(item=>item.from.xMm===from.xMm&&item.from.zMm===from.zMm||item.target.xMm===to.xMm&&item.target.zMm===to.zMm)&&Math.hypot(from.xMm-to.xMm,from.zMm-to.zMm)>1600){const key=`${from.xMm},${from.zMm}:${to.xMm},${to.zMm}`;connectorCalls.set(key,(connectorCalls.get(key)??0)+1);}return original(from,to,radius,ignored);};
    scheduler.request(first);scheduler.request(second);expect(bothFine(scheduler).routes).toEqual([]);
    const checked=until(scheduler,state=>state.tasks.some(task=>task.stage==='fine'&&task.lateCacheChecked),1),waiting=checked.tasks.find(task=>task.stage==='fine'&&task.lateCacheChecked)!;
    expect(checked.routes).toHaveLength(1);const cached=checked.routes[0]![1],from=side==='start'?waiting.from:cached.points.at(-1)!,to=side==='start'?cached.points[0]!:waiting.target,key=`${from.xMm},${from.zMm}:${to.xMm},${to.zMm}`;
    expect(original(from,to,waiting.radiusMm)).toBe(false);expect(connectorCalls.get(key)).toBe(1);expect(waiting.currentCell).toBeUndefined();expect(waiting.neighborCursor).toBeUndefined();
    const restored=new PathScheduler(()=>nav,['p1','p2']);restored.importState(JSON.parse(JSON.stringify(checked)));
    for(let tick=0;tick<2000;tick++){expect(restored.advance(37)).toEqual(scheduler.advance(37));expect(restored.exportState()).toEqual(scheduler.exportState());if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}
    expect(connectorCalls.get(key)).toBe(1);for(const item of [first,second])assertClear(nav,item.from,scheduler.take(item.unitId,1)!);
  });

  it('retains the same own completion ticks and solved paths with hidden work in another profile',()=>{
    const nav=new Navigation(64000,64000,barriers),a=new PathScheduler(()=>nav,['p1','p2']),b=new PathScheduler(()=>nav,['p1','p2']);for(const item of pair){a.request(item);b.request(item);}
    for(let index=0;index<20;index++)b.request({...pair[index%2]!,id:`hidden_${index}`,unitId:`hidden_${index}`,profile:'p2'});
    let completed=0;
    for(let tick=0;tick<2000&&completed<pair.length;tick++){
      a.advance(128);b.advance(128);
      for(const item of pair){const expected=a.take(item.unitId,1),actual=b.take(item.unitId,1);expect(actual).toEqual(expected);if(expected?.status==='ready'){completed++;assertClear(nav,item.from,expected);}}
      const own=(scheduler:PathScheduler)=>{const state=scheduler.exportState();return {tasks:state.tasks.filter(task=>task.profile==='p1'),routes:state.routes.filter(([,route])=>route.profile==='p1'),regions:state.regions.filter(region=>region.profile==='p1'),cursor:state.profileCursors!.p1};};expect(own(b)).toEqual(own(a));
    }
    expect(completed).toBe(2);expect(a.advance(0).cacheHits).toBe(1);
  });

  it('rejects foreign profile, radius, component keys and stale stamps before trying late connectors',()=>{
    const nav=new Navigation(64000,64000,barriers),source=new PathScheduler(()=>nav,['p1','p2']);for(const item of pair)source.request(item);const pending=bothFine(source);
    const solved=until(source,state=>state.routes.length>0,1),entry=solved.routes[0]!;
    for(const mutate of [
      (value:typeof entry)=>{value[1].profile='p2';},
      (value:typeof entry)=>{value[1].radiusMm=550;},
      (value:typeof entry)=>{value[0]+=';unrelated_component';},
      (value:typeof entry)=>{value[1].regions[0]!.revision++;},
    ]){
      const state=structuredClone(pending),route=structuredClone(entry);mutate(route);state.routes=[route];state.tasks=state.tasks.slice(0,1);const scheduler=new PathScheduler(()=>nav,['p1','p2']);scheduler.importState(state);
      scheduler.advance(8);expect(scheduler.advance(0).cacheHits).toBe(0);expect(scheduler.take(state.tasks[0]!.unitId,1)?.status).toBe('pending');
    }
  });

  it('discards late routes on geometry invalidation and order cancellation',()=>{
    let nav=new Navigation(64000,64000,barriers);const scheduler=new PathScheduler(()=>nav,['p1','p2']);for(const item of pair)scheduler.request(item);bothFine(scheduler);const saved=until(scheduler,state=>state.routes.length>0,1);
    const pending=saved.tasks.find(task=>task.stage==='fine')!;expect(pending).toBeDefined();
    nav=new Navigation(64000,64000,[{id:'sealed',xMm:32000,zMm:32000,halfWidth:1000,halfHeight:32000}]);scheduler.invalidate('p1',[{xMm:31000,zMm:0,widthMm:2000,depthMm:64000}]);
    expect(scheduler.exportState().routes).toEqual([]);expect(scheduler.exportState().tasks.every(task=>task.stage===(task.unitId===pending.unitId?'coarse':'direct')&&!task.lateCacheChecked)).toBe(true);
    scheduler.cancel(pair[0]!.unitId);const item=pair[1]!;scheduler.request({...item,id:'replacement',orderRevision:2,target:{xMm:18000,zMm:25000}});expect(scheduler.take(item.unitId,1)).toBeUndefined();
    const result=finish(scheduler,item.unitId,2);assertClear(nav,item.from,result);if(result.status==='ready')expect(result.points.at(-1)).toEqual({xMm:18000,zMm:25000});expect(scheduler.take(pair[0]!.unitId,1)).toBeUndefined();
  });

  it.each(['p1','p1:variant:350'])('indexes intersecting component sets for %s without caching reused arrival chains',profile=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav),requests=partial.map(item=>({...item,profile}));for(const item of requests)scheduler.request(item);
    const pending=bothFine(scheduler),[a,b]=pending.tasks;expect(pending.routes).toEqual([]);expect(a!.cacheKey).not.toBe(b!.cacheKey);for(const field of ['startComponents','endComponents'] as const){expect(a![field]).not.toEqual(b![field]);expect(a![field]!.some(component=>b![field]!.includes(component))).toBe(true);}
    const cached=until(scheduler,state=>state.routes.length===1,1),native=structuredClone(cached.routes),restored=new PathScheduler(()=>nav);restored.importState(JSON.parse(JSON.stringify(cached)));
    for(let tick=0;tick<1000;tick++){expect(restored.advance(37)).toEqual(scheduler.advance(37));expect(restored.exportState()).toEqual(scheduler.exportState());if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}
    expect(scheduler.advance(0).cacheHits).toBe(1);expect(scheduler.exportState().routes).toEqual(native);expect(scheduler.exportState().tasks.filter(task=>task.lateCacheChecked)).toHaveLength(1);
    for(const item of requests)assertClear(nav,item.from,scheduler.take(item.unitId,1)!);
    for(const [index,[xMm,targetX]]of [[14500,46500],[15500,46500],[14500,47500],[15500,47500]].entries()){
      const item={...request,id:`alias_${index}`,unitId:`alias_${index}`,profile,from:{xMm:xMm!,zMm:24000},target:{xMm:targetX!,zMm:24000}};scheduler.request(item);const result=finish(scheduler,item.unitId);assertClear(nav,item.from,result);if(result.status==='ready'){expect(result.points).toHaveLength(native[0]![1].points.length+1);expect(result.points.at(-1)).toEqual(item.target);}expect(scheduler.exportState().routes).toEqual(native);
    }
  });

  it('keeps intersecting-cache completion and work timing independent of hidden profile requests',()=>{
    const nav=new Navigation(64000,64000,barriers),a=new PathScheduler(()=>nav,['p1','p2']),b=new PathScheduler(()=>nav,['p1','p2']);for(const item of partial){a.request(item);b.request(item);}for(let index=0;index<20;index++)b.request({...partial[index%2]!,profile:'p2',id:`hidden_partial_${index}`,unitId:`hidden_partial_${index}`});
    let completed=0;for(let tick=0;tick<2000&&completed<2;tick++){expect(a.advance(128).work).toBeLessThanOrEqual(128);expect(b.advance(128).work).toBeLessThanOrEqual(128);for(const item of partial){const expected=a.take(item.unitId,1),actual=b.take(item.unitId,1);expect(actual).toEqual(expected);if(expected?.status==='ready'){completed++;assertClear(nav,item.from,expected);}}const own=(scheduler:PathScheduler)=>{const state=scheduler.exportState();return {tasks:state.tasks.filter(task=>task.profile==='p1'),routes:state.routes.filter(([,route])=>route.profile==='p1'),regions:state.regions.filter(region=>region.profile==='p1'),cursor:state.profileCursors!.p1};};expect(own(b)).toEqual(own(a));}
    expect(completed).toBe(2);expect(a.advance(0).cacheHits).toBe(1);
  });

  it('ignores malformed, foreign, differently sized and stale compatible entries without exposing a ready path',()=>{
    const nav=new Navigation(64000,64000,barriers),source=new PathScheduler(()=>nav);for(const item of partial)source.request(item);const pending=bothFine(source),solved=until(source,state=>state.routes.length>0,1),entry=solved.routes[0]!,waiting=solved.tasks.find(task=>task.stage==='fine')!;
    expect(waiting.cacheKey).not.toBe(entry[0]);const parts=entry[0].slice(`${entry[1].profile}:${entry[1].radiusMm}:`.length).split(':');
    for(const mutate of [
      (value:typeof entry)=>{value[1].profile='p2';},(value:typeof entry)=>{value[1].radiusMm=550;},(value:typeof entry)=>{value[1].regions[0]!.revision++;},
      ...['unrelated_component','0,0,256','00,0,0','9007199254740992,0,0'].map(component=>(value:typeof entry)=>{value[0]=`p1:350:${parts[0]}:${parts[1]};${component}`;}),
      (value:typeof entry)=>{value[0]=`p1:350:${parts[0]}:${parts[1]};${parts[1]!.split(';')[0]}`;},
      (value:typeof entry)=>{value[0]=`p1:350:${parts[0]}:${parts[1]}:0,0,0`;},
      (value:typeof entry)=>{value[0]=`p1:350:${parts[0]}:${Array.from({length:10},(_,index)=>`0,0,${index}`).join(';')}`;},
    ]){const state=structuredClone(pending),route=structuredClone(entry);mutate(route);state.routes=[route];state.tasks=state.tasks.filter(task=>task.unitId===waiting.unitId);const scheduler=new PathScheduler(()=>nav);scheduler.importState(state);expect(scheduler.advance(8).work).toBe(8);expect(scheduler.advance(0).cacheHits).toBe(0);expect(scheduler.take(waiting.unitId,1)?.status).toBe('pending');}
  });

  it.each(['start','end'] as const)('attempts a blocked intersecting %s connector only once across restoration',side=>{
    const nav=new Navigation(64000,64000,[...barriers,{id:'compatible_post',xMm:side==='start'?9000:46500,zMm:side==='start'?15000:24000,halfWidth:side==='start'?350:150,halfHeight:1500}]),scheduler=new PathScheduler(()=>nav);
    const items=side==='start'?[{...request,from:{xMm:8000,zMm:14500}},{...request,id:'compatible2',unitId:'u2',from:{xMm:10000,zMm:15500},target:{xMm:56500,zMm:24500}}]:[{...request,target:{xMm:46000,zMm:24000}},{...request,id:'compatible2',unitId:'u2',from:{xMm:8500,zMm:24500},target:{xMm:48000,zMm:24000}}];
    for(const item of items)scheduler.request(item);bothFine(scheduler);const saved=until(scheduler,state=>state.routes.length>0,1),waiting=saved.tasks.find(task=>task.stage==='fine')!,entry=saved.routes[0]!;expect(waiting.cacheKey).not.toBe(entry[0]);const from=side==='start'?waiting.from:entry[1].points.at(-1)!,to=side==='start'?entry[1].points[0]!:waiting.target,original=nav.clearLine.bind(nav);expect(original(from,to,350)).toBe(false);let checks=0;
    nav.clearLine=(a,b,radius,ignored)=>{if(a.xMm===from.xMm&&a.zMm===from.zMm&&b.xMm===to.xMm&&b.zMm===to.zMm)checks++;return original(a,b,radius,ignored);};
    const checked=until(scheduler,state=>Boolean(state.tasks.find(task=>task.unitId===waiting.unitId)?.lateCacheChecked),1);expect(checks).toBe(1);expect(checked.tasks.find(task=>task.unitId===waiting.unitId)?.stage).toBe('fine');const restored=new PathScheduler(()=>nav);restored.importState(JSON.parse(JSON.stringify(checked)));
    for(let tick=0;tick<2000;tick++){expect(restored.advance(37)).toEqual(scheduler.advance(37));expect(restored.exportState()).toEqual(scheduler.exportState());if(scheduler.exportState().tasks.every(task=>task.stage==='done'))break;}expect(checks).toBe(1);for(const item of items)assertClear(nav,item.from,scheduler.take(item.unitId,1)!);
  });

  it('does not index disconnected labels as compatible merely because their coarse regions overlap',()=>{
    const nav=new Navigation(64000,64000,[...barriers,{id:'partition',xMm:32000,zMm:8000,halfWidth:32000,halfHeight:350}]),scheduler=new PathScheduler(()=>nav),source={...request,from:{xMm:14500,zMm:7000},target:{xMm:46500,zMm:7000}};scheduler.request(source);assertClear(nav,source.from,finish(scheduler));const entry=scheduler.exportState().routes[0]!;expect(entry).toBeDefined();
    const below={...request,id:'below',unitId:'below',from:{xMm:15500,zMm:9000},target:{xMm:47500,zMm:9000}};scheduler.request(below);const state=until(scheduler,state=>state.tasks[0]?.stage==='fine'),task=state.tasks[0]!,native=entry[0].slice('p1:350:'.length).split(':')[0]!.split(';');expect(task.startComponents!.some(component=>native.some(other=>component.slice(0,component.lastIndexOf(','))===other.slice(0,other.lastIndexOf(','))))).toBe(true);expect(task.startComponents!.some(component=>native.includes(component))).toBe(false);expect(task.lateCacheChecked).toBeUndefined();assertClear(nav,below.from,finish(scheduler,below.unitId));expect(scheduler.advance(0).cacheHits).toBe(0);
  });

  it('preserves exact-key priority and deterministic bucket insertion order after import',()=>{
    const nav=new Navigation(64000,64000,barriers),items=[{...partial[0]!,from:partial[1]!.from},{...partial[0]!},{...partial[0]!,target:partial[1]!.target},{...partial[1]!}],states=items.map(item=>{const scheduler=new PathScheduler(()=>nav);scheduler.request(item);finish(scheduler,item.unitId);return scheduler.exportState();});
    for(const exact of [false,true]){const seed=structuredClone(states[0]!);seed.routes=states.slice(0,exact?4:3).map(state=>state.routes[0]!);const original=structuredClone(seed.routes),a=new PathScheduler(()=>nav),b=new PathScheduler(()=>nav);a.importState(seed);a.request(partial[1]!);a.advance(17);b.importState(JSON.parse(JSON.stringify(a.exportState())));let result:PathResult|undefined;for(let tick=0;tick<1000;tick++){expect(a.advance(37)).toEqual(b.advance(37));const left=a.take('u2',1),right=b.take('u2',1);expect(right).toEqual(left);expect(b.exportState()).toEqual(a.exportState());if(left?.status==='ready'){result=left;break;}}assertClear(nav,partial[1]!.from,result!);if(result?.status==='ready')expect(result.points).toEqual([...original[exact?3:0]![1].points,partial[1]!.target]);expect(a.exportState().routes).toEqual(original);}
  });

  it('prunes derived pairs on per-profile eviction and invalidation without retaining deleted entries',()=>{
    const nav=new Navigation(64000,64000,barriers),source=new PathScheduler(()=>nav);source.request(partial[0]!);finish(source);const seed=source.exportState(),native=structuredClone(seed.routes[0]!);seed.routes=[native,...Array.from({length:511},(_,index):PathSchedulerState['routes'][number]=>{const route=structuredClone(native[1]);route.radiusMm=1001+index;return [native[0].replace('p1:350:',`p1:${route.radiusMm}:`),route];}),[native[0].replace('p1:','p2:'),{...structuredClone(native[1]),profile:'p2'}]];
    // The injected large-body caches carry their canonical clearance metadata.
    // Rejected imports must still leave the entire accepted state unchanged.
    seed.invalidationClearances={p1:1511};
    const scheduler=new PathScheduler(()=>nav);scheduler.importState(seed);const oversized=structuredClone(seed);oversized.routes.push([native[0].replace('p1:350:','p1:9999:'),{...structuredClone(native[1]),radiusMm:9999}]);expect(()=>scheduler.importState(oversized)).toThrow('INVALID_PATH_STATE');expect(scheduler.exportState()).toEqual(seed);
    const wider={...partial[0]!,id:'wide',unitId:'wide',radiusMm:550};scheduler.request(wider);assertClear(nav,wider.from,finish(scheduler,wider.unitId),550);const state=scheduler.exportState();expect(state.routes.filter(([,route])=>route.profile==='p1')).toHaveLength(512);expect(state.routes.filter(([,route])=>route.profile==='p2')).toHaveLength(1);expect(state.routes.some(([key])=>key===native[0])).toBe(false);
    const index=(scheduler as unknown as {routeComponents:Map<string,Map<number,Map<string,Map<string,Set<string>>>> >}).routeComponents;expect(index.get('p1')?.has(350)).toBe(false);let entries=0;for(const profile of index.values())for(const radius of profile.values())for(const ends of radius.values())for(const keys of ends.values())entries+=keys.size;expect(entries).toBeLessThanOrEqual(state.routes.length*81);
    const endIndex=(scheduler as unknown as {routeEnds:Map<string,Map<number,Map<string,Map<string,readonly string[]>>>>}).routeEnds;expect(endIndex.get('p1')?.has(350)).toBe(false);let endEntries=0;for(const profile of endIndex.values())for(const radius of profile.values())for(const keys of radius.values())endEntries+=keys.size;expect(endEntries).toBeLessThanOrEqual(state.routes.length*9);
    const rebuilt=new PathScheduler(()=>nav);rebuilt.importState(JSON.parse(JSON.stringify(state)));expect((rebuilt as unknown as {routeEnds:typeof endIndex}).routeEnds).toEqual(endIndex);
    scheduler.request({...partial[1]!,id:'after_eviction'});until(scheduler,state=>state.tasks.find(task=>task.unitId==='u2')?.stage==='fine');expect(scheduler.advance(0).cacheHits).toBe(0);expect(scheduler.exportState().tasks.find(task=>task.unitId==='u2')?.lateCacheChecked).toBeUndefined();
    scheduler.invalidate('p1',[{xMm:0,zMm:0,widthMm:64000,depthMm:64000}]);expect(index.has('p1')).toBe(false);expect(index.has('p2')).toBe(true);expect(endIndex.has('p1')).toBe(false);expect(endIndex.has('p2')).toBe(true);expect(scheduler.exportState().routes.map(([,route])=>route.profile)).toEqual(['p2']);
  });
});

describe('M8 bounded end-component route joins',()=>{
  type Task=PathSchedulerState['tasks'][number];type Entry=PathSchedulerState['routes'][number];
  const sourceRequest={...request,id:'native',unitId:'native',from:{xMm:24000,zMm:24000},target:{xMm:55500,zMm:24000}};
  let pending:PathSchedulerState,native:Entry;
  function until(scheduler:PathScheduler,predicate:(tasks:Task[],routes:Entry[])=>boolean,budget=1):PathSchedulerState {
    const internal=scheduler as unknown as {tasks:Map<string,Task>;routes:Map<string,Entry[1]>};
    for(let work=0;work<128000;work+=budget){expect(scheduler.advance(budget).work).toBeLessThanOrEqual(budget);if(predicate([...internal.tasks.values()],[...internal.routes]))return scheduler.exportState();}
    throw new Error('End-join fixture exceeded bounded work');
  }
  function atFine(nav:Navigation,item:PathRequest=request){const scheduler=new PathScheduler(()=>nav);scheduler.request(item);return until(scheduler,tasks=>tasks[0]?.stage==='fine');}
  function solved(nav:Navigation,item:PathRequest=sourceRequest):Entry {const scheduler=new PathScheduler(()=>nav);scheduler.request(item);assertClear(nav,item.from,finish(scheduler,item.unitId),item.radiusMm);return scheduler.exportState().routes[0]!;}
  function restored(nav:Navigation,state=pending,routes=[native]){const scheduler=new PathScheduler(()=>nav);scheduler.importState({...structuredClone(state),routes:structuredClone(routes)});return scheduler;}
  beforeAll(()=>{const nav=new Navigation(64000,64000,barriers);pending=atFine(nav);native=solved(nav);expect(native).toBeDefined();expect(pending.tasks[0]!.startComponents).not.toContain(native[0].slice('p1:350:'.length).split(':')[0]);});

  it('joins simultaneous different-start searches using one complete native route without recaching arrivals',()=>{
    const nav=new Navigation(64000,64000,barriers),scheduler=new PathScheduler(()=>nav);scheduler.request(request);scheduler.request(sourceRequest);
    const fine=until(scheduler,tasks=>tasks.every(task=>task.stage==='fine'));expect(fine.routes).toEqual([]);
    const done=until(scheduler,tasks=>tasks.every(task=>task.stage==='done'),37),joined=done.tasks.find(task=>task.endJoinChecked)!;
    expect(joined).toBeDefined();expect(joined.lateCacheChecked).toBeUndefined();expect(scheduler.advance(0).cacheHits).toBe(1);expect(done.routes).toHaveLength(1);
    expect(joined.result?.status).toBe('ready');if(joined.result?.status==='ready')expect(joined.result.points).toEqual([...done.routes[0]![1].points,joined.target]);
    for(const item of [request,sourceRequest])assertClear(nav,item.from,scheduler.take(item.unitId,1)!);
    const before=structuredClone(done.routes);for(let index=0;index<3;index++){const item={...request,id:`join_${index}`,unitId:`join_${index}`,target:{xMm:56000+index*100,zMm:24000}};scheduler.request(item);assertClear(nav,item.from,finish(scheduler,item.unitId));expect(scheduler.exportState().routes).toEqual(before);}
  });

  it('chooses the nearest capped prefix entry deterministically and observes the first-four cutoff',()=>{
    const nav=new Navigation(64000,64000,barriers),ends=native[0].slice('p1:350:'.length).split(':')[1]!;
    const farther:Entry=[`p1:350:0,3,0:${ends}`,{...structuredClone(native[1]),points:[...Array.from({length:8},()=>({xMm:8000,zMm:57000})),...structuredClone(native[1].points)]}];
    assertClear(nav,farther[1].points[0]!,{status:'ready',id:'proof',orderRevision:1,points:farther[1].points,regions:[]});
    const firstFour=Array.from({length:4},(_,index):Entry=>[`p1:350:0,3,${index}:${ends}`,structuredClone(farther[1])]);
    const limited=restored(nav,pending,[...firstFour,native]);expect(limited.advance(1).work).toBe(1);const checked=limited.exportState();expect(checked.tasks[0]!.endJoinChecked).toBe(true);expect(checked.tasks[0]!.stage).toBe('fine');expect(checked.tasks[0]!.lateCacheChecked).toBeUndefined();
    const resumed=restored(nav,JSON.parse(JSON.stringify(checked)),checked.routes);for(let i=0;i<8;i++){expect(resumed.advance(13)).toEqual(limited.advance(13));expect(resumed.exportState()).toEqual(limited.exportState());}expect(limited.advance(0).cacheHits).toBe(0);
    const nearer:Entry=[`p1:350:1,1,255:${ends}`,{...structuredClone(native[1]),points:[{xMm:20000,zMm:24000},...structuredClone(native[1].points)]}];
    const entries=[native,nearer],a=restored(nav,pending,entries),b=restored(nav,JSON.parse(JSON.stringify(pending)),entries);expect(b.advance(1)).toEqual(a.advance(1));expect(b.exportState()).toEqual(a.exportState());
    const result=a.take('u1',1)!;assertClear(nav,request.from,result);if(result.status==='ready')expect(result.points).toEqual([...nearer[1].points,request.target]);expect(a.exportState().routes).toEqual(entries);
  });

  it.each(['profile','radius','label','malformed','stale'] as const)('rejects %s end metadata before a connector proof',kind=>{
    const nav=new Navigation(64000,64000,barriers),entry=structuredClone(native),sections=entry[0].slice('p1:350:'.length).split(':');
    if(kind==='profile'){entry[1].profile='p2';entry[0]=entry[0].replace('p1:','p2:');}
    if(kind==='radius'){entry[1].radiusMm=550;entry[0]=entry[0].replace(':350:',':550:');}
    if(kind==='label')entry[0]=`p1:350:${sections[0]}:3,1,255`;
    if(kind==='malformed')entry[0]+=';unrelated_component';
    if(kind==='stale')entry[1].regions[0]!.revision++;
    const scheduler=restored(nav,pending,[entry]),original=nav.clearLine.bind(nav);let longChecks=0;nav.clearLine=(from,to,radius,ignored)=>{if(Math.hypot(from.xMm-to.xMm,from.zMm-to.zMm)>1600)longChecks++;return original(from,to,radius,ignored);};
    expect(scheduler.advance(1).work).toBe(1);expect(scheduler.take('u1',1)?.status).toBe('pending');expect(longChecks).toBe(0);expect(scheduler.advance(0).cacheHits).toBe(0);
  });

  it('does not use end-only joining for an already intersecting start set',()=>{
    const nav=new Navigation(64000,64000,barriers),state=structuredClone(pending),entry=structuredClone(native);state.tasks[0]!.lateCacheChecked=true;
    entry[0]=`p1:350:${state.tasks[0]!.startComponents!.join(';')}:${state.tasks[0]!.endComponents!.join(';')}`;
    const scheduler=restored(nav,state,[entry]),original=nav.clearLine.bind(nav);let checks=0;nav.clearLine=(...args)=>{checks++;return original(...args);};scheduler.advance(1);
    expect(checks).toBe(0);expect(scheduler.exportState().tasks[0]!.endJoinChecked).toBe(true);expect(scheduler.take('u1',1)?.status).toBe('pending');
  });

  it.each(['start','end'] as const)('tries a blocked %s connector once, including after save restoration',side=>{
    const post={id:'join_post',xMm:side==='start'?16000:55000,zMm:24000,halfWidth:150,halfHeight:1500},nav=new Navigation(64000,64000,[...barriers,post]);
    const item=side==='end'?{...sourceRequest,target:{xMm:54000,zMm:24000}}:sourceRequest,entry=solved(nav,item),state=atFine(nav),scheduler=restored(nav,state,[entry]);
    const from=side==='start'?request.from:entry[1].points.at(-1)!,to=side==='start'?entry[1].points[0]!:request.target,original=nav.clearLine.bind(nav);expect(original(from,to,350)).toBe(false);let checks=0;
    nav.clearLine=(a,b,radius,ignored)=>{if(a.xMm===from.xMm&&a.zMm===from.zMm&&b.xMm===to.xMm&&b.zMm===to.zMm)checks++;return original(a,b,radius,ignored);};
    expect(scheduler.advance(1).work).toBe(1);expect(checks).toBe(1);const checked=scheduler.exportState();expect(checked.tasks[0]!.endJoinChecked).toBe(true);expect(checked.tasks[0]!.lateCacheChecked).toBeUndefined();expect(checked.tasks[0]!.stage).toBe('fine');
    const resumed=restored(nav,JSON.parse(JSON.stringify(checked)),checked.routes);for(let i=0;i<8;i++){expect(resumed.advance(37)).toEqual(scheduler.advance(37));expect(resumed.exportState()).toEqual(scheduler.exportState());}expect(checks).toBe(1);assertClear(nav,request.from,finish(scheduler));
  });

  it('retains later exact reuse after a failed join and retains original exact priority',()=>{
    const nav=new Navigation(64000,64000,[...barriers,{id:'post',xMm:16000,zMm:24000,halfWidth:150,halfHeight:1500}]),entry=solved(nav),state=atFine(nav),scheduler=restored(nav,state,[entry]);scheduler.advance(1);
    const checked=scheduler.exportState();expect(checked.tasks[0]!.endJoinChecked).toBe(true);expect(checked.tasks[0]!.lateCacheChecked).toBeUndefined();const exact=solved(nav,request);expect(exact[0]).toBe(checked.tasks[0]!.cacheKey);
    const resumed=restored(nav,checked,[entry,exact]);resumed.advance(1);expect(resumed.exportState().tasks[0]!.lateCacheChecked).toBe(true);const result=resumed.take('u1',1)!;assertClear(nav,request.from,result);if(result.status==='ready')expect(result.points).toEqual([...exact[1].points,request.target]);
    const priority=restored(nav,state,[entry,exact]);priority.advance(1);expect(priority.exportState().tasks[0]!.endJoinChecked).toBeUndefined();expect(priority.exportState().tasks[0]!.lateCacheChecked).toBe(true);
  });

  it('stamps a briefly crossed connector region and invalidates a joined result before it is taken',()=>{
    let nav=new Navigation(64000,64000,barriers);const source={...sourceRequest,from:{xMm:24000,zMm:34000}},item={...request,from:{xMm:8000,zMm:8000}},entry=solved(nav,source),state=atFine(nav,item),scheduler=new PathScheduler(()=>nav);scheduler.importState({...state,routes:[entry]});
    const first=entry[1].points[0]!,sampled=new Set<string>(),steps=Math.ceil(Math.hypot(first.xMm-item.from.xMm,first.zMm-item.from.zMm)/8000);for(let i=0;i<=steps;i++)sampled.add(`${Math.floor((item.from.xMm+(first.xMm-item.from.xMm)*i/steps)/16000)},${Math.floor((item.from.zMm+(first.zMm-item.from.zMm)*i/steps)/16000)}`);
    expect(sampled.has('0,1')).toBe(false);expect(entry[1].corridor).not.toContain('0,1');expect(scheduler.advance(1).work).toBe(1);const joined=scheduler.exportState().tasks[0]!;expect(joined.stage).toBe('done');expect(joined.corridor).toContain('0,1');expect(joined.result?.status).toBe('ready');if(joined.result?.status!=='ready')throw Error('Join failed');expect(joined.result.regions.map(stamp=>stamp.region)).toContain('0,1');assertClear(nav,item.from,joined.result);
    const restoredScheduler=new PathScheduler(()=>nav);restoredScheduler.importState(JSON.parse(JSON.stringify(scheduler.exportState())));for(const value of [scheduler,restoredScheduler])value.invalidate('p2',[{xMm:14700,zMm:17000,widthMm:1,depthMm:1}]);expect(scheduler.exportState().tasks[0]!.stage).toBe('done');
    const xMm=14700,zMm=Math.round(item.from.zMm+(first.zMm-item.from.zMm)*(xMm-item.from.xMm)/(first.xMm-item.from.xMm)),post={id:'revealed_join_post',xMm,zMm,halfWidth:10,halfHeight:10};expect(xMm+1010).toBeLessThan(16000);expect(zMm-1010).toBeGreaterThan(16000);
    nav=new Navigation(64000,64000,[...barriers,post]);expect(nav.clearLine(item.from,first,350)).toBe(false);const changed={xMm:xMm-10,zMm:zMm-10,widthMm:20,depthMm:20};scheduler.invalidate('p1',[changed]);restoredScheduler.invalidate('p1',[changed]);expect(restoredScheduler.exportState()).toEqual(scheduler.exportState());
    expect(scheduler.exportState().tasks[0]!.stage).toBe('direct');expect(scheduler.exportState().tasks[0]!.endJoinChecked).toBeUndefined();expect(scheduler.isCurrent('p1',joined.result.regions)).toBe(false);expect(scheduler.exportState().routes).toEqual([entry]);assertClear(nav,item.from,finish(scheduler));
  });

  it.each([350,850,350.25])('includes corner touches and the body footprint for radius %s',radiusMm=>{
    const nav=new Navigation(64000,64000,barriers),source={...sourceRequest,radiusMm},entry=solved(nav,source),first=entry[1].points[0]!,item={...request,from:{xMm:32000-first.xMm,zMm:32000-first.zMm},radiusMm},scheduler=restored(nav,atFine(nav,item),[entry]);scheduler.advance(1);const result=scheduler.take('u1',1)!;assertClear(nav,item.from,result,radiusMm);if(result.status!=='ready')return;
    const names=new Set(result.regions.map(stamp=>stamp.region));expect((first.xMm+item.from.xMm)/2).toBe(16000);expect((first.zMm+item.from.zMm)/2).toBe(16000);expect(names.has('0,1')).toBe(true);expect(names.has('1,0')).toBe(true);
    // Independent coverage oracle: every sampled body footprint's intersecting
    // region must be stamped, including the exact grid-corner point.
    for(let sample=0;sample<=200;sample++){const t=sample/200,x=item.from.xMm+(first.xMm-item.from.xMm)*t,z=item.from.zMm+(first.zMm-item.from.zMm)*t;
      for(let rz=0;rz<4;rz++)for(let rx=0;rx<4;rx++){const dx=Math.max(0,rx*16000-x,x-(rx+1)*16000),dz=Math.max(0,rz*16000-z,z-(rz+1)*16000);if(dx*dx+dz*dz<=radiusMm*radiusMm)expect(names.has(`${rx},${rz}`)).toBe(true);}}
  });

  it('preserves joined timing and state independently of hidden-profile orders and resets decisions on cancellation',()=>{
    const nav=new Navigation(64000,64000,barriers),a=new PathScheduler(()=>nav,['p1','p2']),b=new PathScheduler(()=>nav,['p1','p2']);for(const item of [request,sourceRequest]){a.request(item);b.request(item);}for(let i=0;i<10;i++)b.request({...sourceRequest,id:`hidden_join_${i}`,unitId:`hidden_join_${i}`,profile:'p2'});
    let ready=0;for(let tick=0;tick<1000&&ready<2;tick++){expect(a.advance(128).work).toBeLessThanOrEqual(128);expect(b.advance(128).work).toBeLessThanOrEqual(128);for(const item of [request,sourceRequest]){const result=a.take(item.unitId,1);expect(b.take(item.unitId,1)).toEqual(result);if(result?.status==='ready'){ready++;assertClear(nav,item.from,result);}}const own=(scheduler:PathScheduler)=>{const state=scheduler.exportState();return {tasks:state.tasks.filter(task=>task.profile==='p1'),routes:state.routes.filter(([,route])=>route.profile==='p1'),cursor:state.profileCursors!.p1};};expect(own(b)).toEqual(own(a));}expect(ready).toBe(2);expect(a.advance(0).cacheHits).toBe(1);
    const scheduler=restored(nav);scheduler.advance(1);scheduler.cancel('u1');scheduler.request({...request,id:'replacement',orderRevision:2});const task=scheduler.exportState().tasks[0]!;expect(task.stage).toBe('direct');expect(task.endJoinChecked).toBeUndefined();expect(scheduler.take('u1',1)).toBeUndefined();
  });

  describe('bounded native route suffixes',()=>{
    const wall={id:'north_wall',xMm:32000,zMm:21000,halfWidth:1000,halfHeight:21000},source={...request,id:'suffix_native',unitId:'suffix_native'},waiting={...request,id:'suffix',unitId:'suffix',from:{xMm:8000,zMm:60000}};
    let state:PathSchedulerState,entry:Entry,index:number;
    const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
    beforeAll(()=>{
      const nav=new Navigation(64000,64000,[wall]);entry=solved(nav,source);state=atFine(nav,waiting);
      expect(nav.clearLine(waiting.from,waiting.target,350)).toBe(false);expect(distance(waiting.from,entry[1].points[0]!)).toBeGreaterThan(32000);
      const choices=entry[1].points.slice(1,8).map((point,offset)=>({point,index:offset+1,distance:distance(waiting.from,point)})).filter(point=>point.distance<=32000).sort((a,b)=>a.distance-b.distance||a.index-b.index);
      expect(choices.length).toBeGreaterThan(0);index=choices[0]!.index;expect(nav.clearLine(waiting.from,entry[1].points[index]!,350)).toBe(true);
      const starts=entry[0].slice('p1:350:'.length).split(':')[0]!.split(';');expect(state.tasks[0]!.startComponents!.some(component=>starts.includes(component))).toBe(false);
    });

    it('proves only the two endpoint connectors and returns a detached complete native suffix without recaching',()=>{
      const nav=new Navigation(64000,64000,[wall]),scheduler=restored(nav,state,[entry]),original=nav.clearLine.bind(nav),calls:Array<[Position,Position]>=[];
      nav.clearLine=(from,to,radius,ignored)=>{calls.push([{...from},{...to}]);return original(from,to,radius,ignored);};
      expect(scheduler.advance(1).work).toBe(1);expect(calls).toEqual([[waiting.from,entry[1].points[index]!],[entry[1].points.at(-1)!,waiting.target]]);
      const finished=scheduler.exportState().tasks[0]!;expect(finished.endJoinChecked).toBe(true);expect(finished.lateCacheChecked).toBeUndefined();expect(scheduler.advance(0).cacheHits).toBe(1);
      const result=scheduler.take(waiting.unitId,1)!;assertClear(nav,waiting.from,result);if(result.status!=='ready')throw Error('MISSING_SUFFIX');expect(result.points).toEqual([...entry[1].points.slice(index),waiting.target]);
      expect(scheduler.exportState().routes).toEqual([entry]);result.points[0]!.xMm=0;result.regions[0]!.revision++;expect(scheduler.exportState().routes).toEqual([entry]);
    });

    it('keeps an eligible first-point route ahead of a nearer suffix',()=>{
      const nav=new Navigation(64000,64000,[wall]),primary=solved(nav,{...source,from:{xMm:24000,zMm:32000}});
      expect(distance(waiting.from,primary[1].points[0]!)).toBeLessThanOrEqual(32000);expect(distance(waiting.from,primary[1].points[0]!)).toBeGreaterThan(distance(waiting.from,entry[1].points[index]!));
      const scheduler=restored(nav,state,[entry,primary]);scheduler.advance(1);const result=scheduler.take(waiting.unitId,1)!;assertClear(nav,waiting.from,result);if(result.status!=='ready')throw Error('MISSING_PRIMARY');expect(result.points).toEqual([...primary[1].points,waiting.target]);
    });

    it('bounds route and waypoint prefixes before proof and persists a consumed no-candidate decision',()=>{
      const nav=new Navigation(64000,64000,[wall]),parts=entry[0].slice('p1:350:'.length).split(':'),far=entry[1].points[0]!;
      const padded:Entry=[entry[0],{...structuredClone(entry[1]),points:[...Array.from({length:8},()=>({...far})),...structuredClone(entry[1].points.slice(index))]}];
      const firstFour=Array.from({length:4},(_,i):Entry=>[`p1:350:0,0,${i}:${parts[1]}`,structuredClone(padded[1])]);expect(new Set([...firstFour,entry].map(([key])=>key)).size).toBe(5);
      const scheduler=restored(nav,state,[...firstFour,entry]),original=nav.clearLine.bind(nav);let calls=0;nav.clearLine=(...args)=>{calls++;return original(...args);};
      expect(scheduler.advance(1).work).toBe(1);expect(calls).toBe(0);const checked=scheduler.exportState();expect(checked.tasks[0]!.endJoinChecked).toBe(true);expect(checked.tasks[0]!.stage).toBe('fine');
      const resumed=restored(nav,JSON.parse(JSON.stringify(checked)),checked.routes);for(const budget of [0,1,17,128]){expect(resumed.advance(budget)).toEqual(scheduler.advance(budget));expect(resumed.exportState()).toEqual(scheduler.exportState());}
      expect(scheduler.advance(0).cacheHits).toBe(0);
      const eighth:Entry=[entry[0],{...structuredClone(entry[1]),points:[...Array.from({length:7},()=>({...far})),...structuredClone(entry[1].points.slice(index))]}],eligible=restored(nav,state,[eighth]);eligible.advance(1);const result=eligible.take(waiting.unitId,1)!;assertClear(nav,waiting.from,result);if(result.status!=='ready')throw Error('MISSING_EIGHTH_POINT_SUFFIX');expect(result.points).toEqual([...entry[1].points.slice(index),waiting.target]);
    });

    it('retains suffix selection and fixed-share timing independently of hidden-profile work',()=>{
      const nav=new Navigation(64000,64000,[wall]),saved={...structuredClone(state),routes:[structuredClone(entry)]},a=new PathScheduler(()=>nav,['p1','p2']),b=new PathScheduler(()=>nav,['p1','p2']);a.importState(saved);b.importState(saved);
      for(let i=0;i<6;i++)b.request({...waiting,id:`hidden_suffix_${i}`,unitId:`hidden_suffix_${i}`,profile:'p2'});
      for(const budget of [0,1,2,7]){expect(a.advance(budget).work).toBeLessThanOrEqual(budget);expect(b.advance(budget).work).toBeLessThanOrEqual(budget);const own=(scheduler:PathScheduler)=>{const value=scheduler.exportState();return {tasks:value.tasks.filter(task=>task.profile==='p1'),routes:value.routes.filter(([,route])=>route.profile==='p1'),cursor:value.profileCursors!.p1};};expect(own(b)).toEqual(own(a));}
      const result=a.take(waiting.unitId,1)!;expect(b.take(waiting.unitId,1)).toEqual(result);assertClear(nav,waiting.from,result);expect(a.advance(0).cacheHits).toBe(1);
    });

    it.each(['start','end'] as const)('attempts a blocked suffix %s connector once and keeps exact-cache retry independent',side=>{
      const first=entry[1].points[index]!,last=entry[1].points.at(-1)!,target=side==='end'?{xMm:last.xMm+2000,zMm:last.zMm}:waiting.target,item={...waiting,target};
      const from=side==='start'?item.from:last,to=side==='start'?first:target,post={id:'suffix_post',xMm:Math.round((from.xMm+to.xMm)/2),zMm:Math.round((from.zMm+to.zMm)/2),halfWidth:10,halfHeight:10};
      const nav=new Navigation(64000,64000,[wall,post]),pending=atFine(nav,item),scheduler=restored(nav,pending,[entry]),original=nav.clearLine.bind(nav);expect(original(from,to,350)).toBe(false);let proofCalls=0;
      nav.clearLine=(a,b,radius,ignored)=>{if(a.xMm===from.xMm&&a.zMm===from.zMm&&b.xMm===to.xMm&&b.zMm===to.zMm)proofCalls++;return original(a,b,radius,ignored);};
      expect(scheduler.advance(1).work).toBe(1);expect(proofCalls).toBe(1);const checked=scheduler.exportState();expect(checked.tasks[0]!.endJoinChecked).toBe(true);expect(checked.tasks[0]!.lateCacheChecked).toBeUndefined();expect(checked.tasks[0]!.stage).toBe('fine');
      const resumed=restored(nav,JSON.parse(JSON.stringify(checked)),checked.routes);for(const budget of [0,1,7,19]){expect(resumed.advance(budget)).toEqual(scheduler.advance(budget));expect(resumed.exportState()).toEqual(scheduler.exportState());}expect(proofCalls).toBe(1);
      const exact=solved(nav,item),retry=restored(nav,checked,[entry,exact]);retry.advance(1);expect(retry.exportState().tasks[0]!.lateCacheChecked).toBe(true);assertClear(nav,item.from,retry.take(item.unitId,1)!);
    });

    it('stamps the actual later-point connector, then invalidates original and restored ready results without altering the native cache',()=>{
      let nav=new Navigation(64000,64000,[wall]);const scheduler=new PathScheduler(()=>nav);scheduler.importState({...structuredClone(state),routes:[structuredClone(entry)]});scheduler.advance(1);
      const ready=scheduler.exportState(),task=ready.tasks[0]!,first=entry[1].points[index]!;expect(task.result?.status).toBe('ready');if(task.result?.status!=='ready')throw Error('MISSING_SUFFIX');
      expect(entry[1].corridor).not.toContain('1,3');expect(Math.max(waiting.from.xMm,entry[1].points[0]!.xMm)+350).toBeLessThan(16000);
      expect(task.corridor).toContain('1,3');expect(task.result.regions.map(stamp=>stamp.region)).toContain('1,3');
      const xMm=19000,zMm=Math.round(waiting.from.zMm+(first.zMm-waiting.from.zMm)*(xMm-waiting.from.xMm)/(first.xMm-waiting.from.xMm));expect(zMm-1010).toBeGreaterThan(48000);expect(zMm+1010).toBeLessThan(64000);
      const resumed=new PathScheduler(()=>nav);resumed.importState(JSON.parse(JSON.stringify(ready)));const post={id:'revealed_suffix_post',xMm,zMm,halfWidth:10,halfHeight:10};nav=new Navigation(64000,64000,[wall,post]);expect(nav.clearLine(waiting.from,first,350)).toBe(false);
      const changed={xMm:xMm-10,zMm:zMm-10,widthMm:20,depthMm:20};scheduler.invalidate('p2',[changed]);resumed.invalidate('p2',[changed]);expect(scheduler.exportState().tasks[0]!.stage).toBe('done');
      scheduler.invalidate('p1',[changed]);resumed.invalidate('p1',[changed]);expect(resumed.exportState()).toEqual(scheduler.exportState());expect(scheduler.exportState().tasks[0]!.stage).toBe('direct');expect(scheduler.isCurrent('p1',task.result.regions)).toBe(false);expect(scheduler.exportState().routes).toEqual([entry]);
      // cacheHits is an operational cumulative counter, intentionally outside
      // saved scheduler state; compare its increments after restoration.
      const hitOffset=scheduler.advance(0).cacheHits-resumed.advance(0).cacheHits;let completed=false;for(let work=0;work<128000;work+=128){const left=scheduler.advance(128),right=resumed.advance(128);expect({...right,cacheHits:right.cacheHits+hitOffset}).toEqual(left);expect(resumed.exportState()).toEqual(scheduler.exportState());const result=scheduler.take(waiting.unitId,1);expect(resumed.take(waiting.unitId,1)).toEqual(result);if(result?.status==='ready'){assertClear(nav,waiting.from,result);completed=true;break;}}expect(completed).toBe(true);
    });
  });
});

describe('M3 spatial movement helpers',()=>{
  it('routes around stopped bodies occupying two intermediate waypoints without moving either blocker',()=>{
    // Exact99/100 arrival failure exposed by the coarse-first comparison.
    const nav=new Navigation(80000,80000,[{id:'north-wall',xMm:40000,zMm:19000,halfWidth:1000,halfHeight:19000},{id:'south-wall',xMm:40000,zMm:61000,halfWidth:1000,halfHeight:19000},{id:'resource-patch',xMm:54000,zMm:40000,halfWidth:3000,halfHeight:4000}]);
    const body={id:'u053',xMm:38148,zMm:37902,radiusMm:850},blockers=[{id:'u045',xMm:45000,zMm:34000,radiusMm:350},{id:'u059',xMm:45000,zMm:38000,radiusMm:850}];
    const path=[{xMm:44000,zMm:39000},{xMm:45000,zMm:38000},{xMm:45000,zMm:42000}],target={...path[2]!},index=new UnitSpatialIndex(),avoidance=new LocalAvoidance();index.set(body);for(const blocker of blockers)index.set(blocker);
    expect(index.free(path[0]!,850,body.id)).toBe(false);expect(index.free(path[1]!,850,body.id)).toBe(false);expect(index.free(target,850,body.id)).toBe(true);
    const bounded=new LocalAvoidance();bounded.beginTick(0,1);
    expect(bounded.step(body,path[0]!,150,nav,index,nav,()=>true,path[1],[path[0]!,...Array<Position>(5).fill(path[1]!),target])).toBeUndefined();
    expect(bounded.exportState().routes[0]![1].points).toEqual([]);
    // A hidden body at the later point must not change authorized route choice;
    // physical occupancy remains a separate per-step collision check.
    const hiddenIndex=new UnitSpatialIndex();hiddenIndex.set(body);for(const blocker of blockers)hiddenIndex.set(blocker);hiddenIndex.set({id:'hidden',...target,radiusMm:350});
    const visibleOnly=new LocalAvoidance(),withHidden=new LocalAvoidance();visibleOnly.beginTick(0,1);withHidden.beginTick(0,1);
    expect(withHidden.step(body,path[0]!,150,nav,hiddenIndex,nav,id=>id!=='hidden',path[1],path)).toEqual(visibleOnly.step(body,path[0]!,150,nav,index,nav,()=>true,path[1],path));
    expect(withHidden.exportState()).toEqual(visibleOnly.exportState());
    for(let tick=0;tick<1000&&path.length;tick++){
      while(path.length>1&&nav.clearLine(body,path[1]!,850))path.shift();
      avoidance.beginTick(tick,1);
      const next=avoidance.step(body,path[0]!,150,nav,index,nav,()=>true,path[1],path);
      if(next){expect(nav.clearLine(body,next,850)).toBe(true);expect(index.clearLine(body,next,850,body.id)).toBe(true);Object.assign(body,next);index.set(body);if(Math.hypot(body.xMm-path[0]!.xMm,body.zMm-path[0]!.zMm)<=1)path.shift();}
    }
    expect({xMm:body.xMm,zMm:body.zMm}).toEqual(target);expect(path).toEqual([]);
    for(const blocker of blockers)expect(index.nearby(blocker,0).find(unit=>unit.id===blocker.id)).toEqual(blocker);
  });
  it('retains a full fine-search grant for a narrow detour requiring more than1024 nodes and restores its retry phase',()=>{
    const obstacles:Obstacle[]=[{id:'top',xMm:12000,zMm:6025,halfWidth:1000,halfHeight:6025},{id:'bottom',xMm:12000,zMm:22475,halfWidth:1000,halfHeight:9525}];
    const body={id:'mover',xMm:2000,zMm:4000,radiusMm:350},stopped={id:'stopped',xMm:2700,zMm:4000,radiusMm:350},target={xMm:22000,zMm:4000};
    const extra=[{id:stopped.id,xMm:stopped.xMm,zMm:stopped.zMm,halfWidth:350,halfHeight:350,circle:true}];
    const reference=new Navigation(24000,32000,obstacles);
    expect(reference.withAdditionalObstacles(extra,1024,250).path(body,target,350)).toBeNull();
    expect(reference.withAdditionalObstacles(extra,2048,250).path(body,target,350)).not.toBeNull();
    expect(reference.withAdditionalObstacles(extra,2048,1000).path(body,target,350)).toBeNull();
    const calls:{cellMm:number;limit:number}[]=[];
    class RecordedNavigation extends Navigation{override withAdditionalObstacles(obstacles:Obstacle[],maxSearchNodes=this.maxSearchNodes,cellMm=this.cellMm,workBudget?:NavigationWorkBudget){calls.push({cellMm,limit:maxSearchNodes});return super.withAdditionalObstacles(obstacles,maxSearchNodes,cellMm,workBudget);}}
    const nav=new RecordedNavigation(24000,32000,obstacles),index=new UnitSpatialIndex(),avoidance=new LocalAvoidance(),restored=new LocalAvoidance();
    index.set(body);index.set(stopped);
    const fresh=new LocalAvoidance();fresh.beginTick(0,1);expect(fresh.step(body,target,150,nav,index)).toBeDefined();
    expect(calls).toEqual([{cellMm:250,limit:2048}]);calls.length=0;
    // A previously failed fine search must not permanently reduce the next
    // fine grant after a coarse search finds that its lattice erases this gap.
    avoidance.importState({tick:0,searches:0,routes:[[body.id,{target,points:[],retryTick:0,nextSearchCellMm:1000}]],waiting:[],grants:[]});avoidance.beginTick(0,1);
    expect(avoidance.step(body,target,150,nav,index)).toBeUndefined();
    expect(avoidance.exportState().routes[0]![1].nextSearchCellMm).toBe(250);
    restored.importState(JSON.parse(JSON.stringify(avoidance.exportState())));
    for(let tick=1;tick<1000&&(body.xMm!==target.xMm||body.zMm!==target.zMm);tick++){
      const before={xMm:body.xMm,zMm:body.zMm};avoidance.beginTick(tick,1);restored.beginTick(tick,1);
      const next=avoidance.step(body,target,150,nav,index),copy=restored.step(body,target,150,reference,index);
      expect(copy).toEqual(next);expect(restored.exportState()).toEqual(avoidance.exportState());
      if(next){expect(nav.clearLine(before,next,350)).toBe(true);expect(index.clearLine(before,next,350,body.id)).toBe(true);Object.assign(body,next);index.set(body);}
    }
    expect({xMm:body.xMm,zMm:body.zMm}).toEqual(target);
    expect(calls.slice(0,2)).toEqual([{cellMm:1000,limit:2048},{cellMm:250,limit:2048}]);
    expect(calls.every(call=>call.limit===2048)).toBe(true);
    expect(index.nearby(stopped,0).find(unit=>unit.id===stopped.id)).toEqual(stopped);
  });
  it('reuses base obstacle buckets without changing overlay collision, path, work charges, or the base geometry',()=>{
    const obstacles=[{id:'wall',xMm:12000,zMm:10000,halfWidth:1000,halfHeight:6000},{id:'post',xMm:24000,zMm:10000,halfWidth:1000,halfHeight:3000}],neighbors=[{id:'body',xMm:18000,zMm:16000,halfWidth:550,halfHeight:550,circle:true}],base=new Navigation(40000,40000,obstacles);
    const a={remaining:1000000,used:0},b={remaining:1000000,used:0},overlay=base.withAdditionalObstacles(neighbors,2048,250,a),rebuilt=new Navigation(40000,40000,[...obstacles,...neighbors],2048,250,b);
    for(const radius of [0,350,550,850])for(let z=2000;z<=22000;z+=2000)for(let x=8000;x<=28000;x+=2000){const from={xMm:x,zMm:z},to={xMm:31000-x/3,zMm:27000-z/2};expect(overlay.free(from,radius)).toBe(rebuilt.free(from,radius));expect(overlay.clearLine(from,to,radius)).toBe(rebuilt.clearLine(from,to,radius));expect(a).toEqual(b);}
    expect(overlay.path({xMm:18000,zMm:22000},{xMm:18000,zMm:10000},350)).toEqual(rebuilt.path({xMm:18000,zMm:22000},{xMm:18000,zMm:10000},350));expect(a).toEqual(b);
    expect(base.free(neighbors[0]!,350)).toBe(true);expect(overlay.free(neighbors[0]!,350)).toBe(false);
    const extra={id:'second',xMm:19000,zMm:19000,halfWidth:350,halfHeight:350,circle:true},nested=overlay.withAdditionalObstacles([extra]);expect(nested.free(extra,350)).toBe(false);expect(overlay.free(extra,350)).toBe(true);expect(base.obstacles).toEqual(obstacles);expect(overlay.obstacles).toEqual([...obstacles,...neighbors]);
  });
  it('fairly serves persistent local requests beyond the retry window and restores their queue',()=>{
    const nav=new Navigation(80000,80000,[]),index=new UnitSpatialIndex(),a=new LocalAvoidance(),b=new LocalAvoidance(),bodies=Array.from({length:24},(_,i)=>({id:`mover_${String(i).padStart(2,'0')}`,xMm:10000,zMm:2000+i*2000,radiusMm:350}));
    for(const body of bodies){index.set(body);index.set({...body,id:`idle_${body.id}`,xMm:10700});}
    for(let tick=0;tick<30;tick++){
      a.beginTick(tick,1);if(tick>=7)b.beginTick(tick,1);
      for(const body of bodies){const target={xMm:10700,zMm:body.zMm},result=a.step(body,target,150,nav,index);expect(result).toBeUndefined();expect(a.madeProgress(body.id)).toBe(false);if(tick>=7)expect(b.step(body,target,150,nav,index)).toEqual(result);}
      if(tick===6)b.importState(JSON.parse(JSON.stringify(a.exportState())));if(tick>=7)expect(b.exportState()).toEqual(a.exportState());expect(a.exportState().searches).toBeGreaterThanOrEqual(0);
    }
    expect(a.exportState().routes.every(([,route])=>route.retryTick>0)).toBe(true);
    a.release('mover_23');expect(a.exportState().waiting.some(([id])=>id==='mover_23')).toBe(false);expect(a.exportState().routes.some(([id])=>id==='mover_23')).toBe(false);
  });
  it('takes a legal sub-meter sidestep between a wall and a circular neighbor',()=>{
    const nav=new Navigation(80000,80000,[{id:'wall',xMm:40000,zMm:19000,halfWidth:1000,halfHeight:19000}]),index=new UnitSpatialIndex(),body={id:'front',xMm:38000,zMm:38000,radiusMm:550},blocker={id:'neighbor',xMm:36746,zMm:38686,radiusMm:850},avoidance=new LocalAvoidance();index.set(body);index.set(blocker);
    const target={xMm:39000,zMm:39000};for(let tick=0;tick<60;tick++){avoidance.beginTick(tick);const step=avoidance.step(body,target,150,nav,index);if(step){expect(nav.clearLine(body,step,body.radiusMm)).toBe(true);expect(index.clearLine(body,step,body.radiusMm,body.id)).toBe(true);Object.assign(body,step);index.set(body);}}
    expect(body.xMm).toBe(target.xMm);expect(body.zMm).toBe(target.zMm);
  });
  it('rejects a two-millimeter rounded-corner clip that fixed sampling can miss',()=>{
    const nav=new Navigation(80000,80000,[{id:'resource',xMm:54000,zMm:40000,halfWidth:3000,halfHeight:4000}]),from={xMm:50650,zMm:44020},to={xMm:50670,zMm:44130};
    expect(nav.free(from,350)).toBe(true);expect(nav.free(to,350)).toBe(true);expect(nav.clearLine(from,to,350)).toBe(false);
    const path=nav.path(from,to,350);expect(path).not.toBeNull();let prior=from;for(const point of path!){expect(nav.clearLine(prior,point,350)).toBe(true);prior=point;}
  });
  it('moves one hundred mixed-size units through a four-meter gate and around resources',()=>{
    const nav=new Navigation(80000,80000,[{id:'north-wall',xMm:40000,zMm:19000,halfWidth:1000,halfHeight:19000},{id:'south-wall',xMm:40000,zMm:61000,halfWidth:1000,halfHeight:19000},{id:'resource-patch',xMm:54000,zMm:40000,halfWidth:3000,halfHeight:4000}]);
    const bodies=Array.from({length:100},(_,i)=>({id:`u${String(i).padStart(3,'0')}`,xMm:10000+i%10*2000,zMm:30000+Math.floor(i/10)*2000,radiusMm:[350,550,850][i%3]!,path:[] as {xMm:number;zMm:number}[],arrived:false}));
    const targets=formationTargets(bodies,{xMm:67000,zMm:40000},nav),scheduler=new PathScheduler(()=>nav),spatial=new UnitSpatialIndex(),avoidance=new LocalAvoidance();
    for(const body of bodies){spatial.set(body);scheduler.request({id:body.id,unitId:body.id,orderRevision:1,from:body,target:targets.get(body.id)!,radiusMm:body.radiusMm,profile:'p'});}
    for(let tick=0;tick<4000&&!bodies.every(body=>body.arrived);tick++){
      scheduler.advance(4096);avoidance.beginTick(tick);
      for(const body of [...bodies].sort((a,b)=>b.xMm-a.xMm||a.id.localeCompare(b.id))){
        if(body.arrived)continue;const result=scheduler.take(body.id,1);if(result?.status==='ready')body.path=result.points;
        while(body.path.length>1&&nav.clearLine(body,body.path[1]!,body.radiusMm))body.path.shift();
        const target=body.path[0];if(!target)continue;const step=avoidance.step(body,target,150,nav,spatial,nav,()=>true,body.path[1],body.path);
        if(step){Object.assign(body,step);spatial.set(body);expect(spatial.free(body,body.radiusMm,body.id)).toBe(true);if(Math.hypot(body.xMm-target.xMm,body.zMm-target.zMm)<=1)body.path.shift();if(!body.path.length)body.arrived=true;}
      }
    }
    expect(bodies.filter(body=>body.arrived).length,JSON.stringify({stuck:bodies.filter(body=>!body.arrived).sort((a,b)=>b.xMm-a.xMm).slice(0,6).map(body=>({...body,neighbors:spatial.nearby(body,8000).map(other=>({id:other.id,xMm:other.xMm,zMm:other.zMm,radiusMm:other.radiusMm})),route:avoidance.exportState().routes.find(([id])=>id===body.id)}))})).toBe(100);
  },45000);
  it('assigns distinct legal arrival slots to 100 mixed-size bodies',()=>{
    const nav=new Navigation(64000,64000,barriers),bodies=Array.from({length:100},(_,i)=>({id:`u${i}`,xMm:5000+i%10*2000,zMm:5000+Math.floor(i/10)*2000,radiusMm:[350,550,850][i%3]!}));
    const slots=formationTargets(bodies,{xMm:50000,zMm:48000},nav);expect(slots.size).toBe(100);
    for(const body of bodies){const point=slots.get(body.id)!;expect(nav.free(point,body.radiusMm)).toBe(true);for(const other of bodies)if(other.id!==body.id){const otherPoint=slots.get(other.id)!;expect(Math.hypot(point.xMm-otherPoint.xMm,point.zMm-otherPoint.zMm)).toBeGreaterThanOrEqual(body.radiusMm+other.radiusMm);}}
    expect([...formationTargets([...bodies].reverse(),{xMm:50000,zMm:48000},nav)]).toEqual([...slots]);
  });
  it('keeps a physically legal narrow destination usable when roomy formation clearance is unavailable',()=>{
    const nav=new Navigation(40000,40000,[{id:'left',xMm:9500,zMm:20000,halfWidth:9500,halfHeight:20000},{id:'right',xMm:30500,zMm:20000,halfWidth:9500,halfHeight:20000}]),bodies=Array.from({length:16},(_,i)=>({id:`u${i}`,xMm:20000,zMm:1000+i*2000,radiusMm:350}));
    const targets=formationTargets(bodies,{xMm:20000,zMm:20000},nav);expect(targets.size).toBe(16);for(const point of targets.values())expect(nav.free(point,350)).toBe(true);
  });
  it('keeps a compact group inside the requested enclosure instead of choosing roomy exterior parking',()=>{
    const obstacles=[];for(let z=177000;z<=185000;z+=2000)for(let x=125000;x<=133000;x+=2000){if(x!==125000&&x!==133000&&z!==177000&&z!==185000)continue;if(z===177000&&x>125000&&x<133000)continue;obstacles.push({id:`wall_${x}_${z}`,xMm:x,zMm:z,halfWidth:1000,halfHeight:1000});}
    obstacles.push(...[126500,131500].map(x=>({id:`post_${x}`,xMm:x,zMm:177000,halfWidth:500,halfHeight:1000})));
    const nav=new Navigation(384000,384000,obstacles),target={xMm:128571,zMm:179439},bodies=[{id:'scout',xMm:124111,zMm:173360,radiusMm:550},{id:'spear',xMm:121071,zMm:173439,radiusMm:350}];
    const slots=formationTargets(bodies,target,nav);expect(slots.size).toBe(2);
    for(const body of bodies){const point=slots.get(body.id)!;expect(point.xMm).toBeGreaterThan(126000);expect(point.xMm).toBeLessThan(132000);expect(point.zMm).toBeGreaterThan(178000);expect(point.zMm).toBeLessThan(184000);expect(nav.free(point,body.radiusMm)).toBe(true);expect(nav.path(body,point,body.radiusMm)).not.toBeNull();}
  });
  it('keeps a partially fitting formation near the actual rounded interior click',()=>{
    const obstacles:Obstacle[]=[];for(let z=175000;z<=183000;z+=2000)for(let x=131000;x<=139000;x+=2000){if(x!==131000&&x!==139000&&z!==175000&&z!==183000)continue;if(z===175000&&x>131000&&x<139000)continue;obstacles.push({id:`wall_${x}_${z}`,xMm:x,zMm:z,halfWidth:1000,halfHeight:1000});}
    obstacles.push(...[132500,137500].map(x=>({id:`post_${x}`,xMm:x,zMm:175000,halfWidth:500,halfHeight:1000})));
    const nav=new Navigation(384000,384000,obstacles),target={xMm:133714,zMm:177645},bodies=[{id:'scout',xMm:137452,zMm:159713,radiusMm:550},{id:'spear',xMm:139880,zMm:159907,radiusMm:350}];
    // These are the actual authorized minimap coordinates, not the ideal center:
    // only the eastern nominal slot has enough physical clearance for the scout.
    expect(nav.free({xMm:132214,zMm:177645},550)).toBe(false);expect(nav.free({xMm:135214,zMm:177645},550)).toBe(true);
    const slots=formationTargets(bodies,target,nav);expect(slots.size).toBe(2);expect([...formationTargets([...bodies].reverse(),target,nav)]).toEqual([...slots]);
    for(const body of bodies){const point=slots.get(body.id)!;expect(point.xMm).toBeGreaterThan(132000);expect(point.xMm).toBeLessThan(138000);expect(point.zMm).toBeGreaterThan(176000);expect(point.zMm).toBeLessThan(182000);expect(nav.free(point,body.radiusMm)).toBe(true);expect(nav.clearLine(target,point,body.radiusMm)).toBe(true);const path=nav.path(body,point,body.radiusMm);expect(path).not.toBeNull();let prior:Position=body;for(const next of path!){expect(nav.clearLine(prior,next,body.radiusMm)).toBe(true);prior=next;}}
    const [a,b]=[...slots.values()];expect(Math.hypot(a!.xMm-b!.xMm,a!.zMm-b!.zMm)).toBeGreaterThanOrEqual(900);
  });
  it.each([{xMm:20000,free:true},{xMm:19000,free:false}])('retains exterior slots when the whole compact group cannot fit at center $xMm',({xMm,free})=>{
    const nav=new Navigation(40000,40000,[{id:'west',xMm:19000,zMm:20000,halfWidth:500,halfHeight:1500},{id:'east',xMm:21000,zMm:20000,halfWidth:500,halfHeight:1500},{id:'north',xMm:20000,zMm:19000,halfWidth:1500,halfHeight:500},{id:'south',xMm:20000,zMm:21000,halfWidth:1500,halfHeight:500}]),target={xMm,zMm:20000},bodies=[{id:'a',xMm:10000,zMm:10000,radiusMm:350},{id:'b',xMm:12000,zMm:10000,radiusMm:350}];
    expect(nav.free(target,350)).toBe(free);const slots=formationTargets(bodies,target,nav);expect(slots.size).toBe(2);
    for(const point of slots.values()){expect(nav.free(point,350)).toBe(true);expect(nav.clearLine(target,point,350)).toBe(false);}
  });
  it('updates neighbor occupancy immediately and never takes a step through a unit or wall',()=>{
    const nav=new Navigation(20000,20000,[{id:'wall',xMm:11000,zMm:10000,halfWidth:500,halfHeight:5000}]),index=new UnitSpatialIndex(),a={id:'a',xMm:8000,zMm:10000,radiusMm:350},b={id:'b',xMm:8700,zMm:10000,radiusMm:350};index.set(a);index.set(b);
    const step=separatedStep(a,{xMm:15000,zMm:10000},150,nav,index);expect(step).toBeDefined();expect(Math.hypot(step!.xMm-b.xMm,step!.zMm-b.zMm)).toBeGreaterThanOrEqual(700);expect(nav.clearLine(a,step!,350)).toBe(true);
    index.set({...a,...step});expect(index.free(step!,350,'b')).toBe(false);index.delete('a');expect(index.free(step!,350,'b')).toBe(true);
  });
  it('reserves separate perimeter slots and releases them for a new order',()=>{
    const slots=new ApproachReservations(),positions=[{xMm:1000,zMm:1000},{xMm:2000,zMm:1000}];expect(slots.claim('a','tree',350,positions,()=>true)).toEqual(positions[0]);expect(slots.claim('b','tree',350,positions,()=>true)).toEqual(positions[1]);slots.release('a');expect(slots.claim('c','tree',350,positions,()=>true)).toEqual(positions[0]);
  });
  it('matches snapshot iteration for reservation tangency, self exclusion, reuse, release and restored slots',()=>{
    const direct=new ApproachReservations(),snapshot=new ApproachReservations();
    snapshot.available=(unitId,point,radiusMm)=>!snapshot.exportState().some(([id,slot])=>id!==unitId&&Math.hypot(slot.position.xMm-point.xMm,slot.position.zMm-point.zMm)<slot.radiusMm+radiusMm);
    const state:ReturnType<ApproachReservations['exportState']>=Array.from({length:40},(_,index)=>[`unit_${index}`,{targetId:`target_${index%3}`,position:{xMm:1000+index%8*2000,zMm:1000+Math.floor(index/8)*2000},radiusMm:index%2?350:850}]);
    direct.importState(state);snapshot.importState(state);
    for(const [id,slot]of state)for(const radius of [350,850])for(const offset of [-1,0,1]){
      const point={xMm:slot.position.xMm+slot.radiusMm+radius+offset,zMm:slot.position.zMm};
      for(const except of [id,'other'])expect(direct.available(except,point,radius)).toBe(snapshot.available(except,point,radius));
    }
    expect(direct.available('other',{xMm:1850+350,zMm:1000},350)).toBe(true);
    expect(direct.available('other',{xMm:1850+349,zMm:1000},350)).toBe(false);
    const candidates=Array.from({length:20},(_,index)=>({xMm:1000+index*1000,zMm:13000}));
    for(let index=0;index<16;index++){
      const id=`new_${index}`,radius=index%2?350:850,legal=(point:{xMm:number;zMm:number})=>point.xMm%3000!==0;
      expect(direct.claim(id,'work',radius,candidates,legal)).toEqual(snapshot.claim(id,'work',radius,candidates,legal));
      expect(direct.claim(id,'work',radius,[...candidates].reverse(),legal)).toEqual(snapshot.claim(id,'work',radius,[...candidates].reverse(),legal));
      if(index%3===0){direct.release(id);snapshot.release(id);}
      expect(direct.exportState()).toEqual(snapshot.exportState());
    }
  });
  it('keeps reservation axis rejection identical to exact fractional and unusual numeric circle queries',()=>{
    const reservations=new ApproachReservations(),radii=[-1,0,.125,350,850,Infinity,NaN],offsets=[-Infinity,-1000,-700,-.125,-0,.125,700,1000,Infinity,NaN];
    for(const storedRadius of radii){
      reservations.importState([['reserved',{targetId:'tree',position:{xMm:0,zMm:0},radiusMm:storedRadius}]]);
      for(const radius of radii)for(const xMm of offsets)for(const zMm of offsets){
        expect(reservations.available('other',{xMm,zMm},radius)).toBe(!(Math.hypot(-xMm,-zMm)<storedRadius+radius));
        expect(reservations.available('reserved',{xMm,zMm},radius)).toBe(true);
      }
    }
  });
  it('reads current reservation and query coordinates before radius, but skips hypot for distant faces',()=>{
    const reservations=new ApproachReservations(),reads:string[]=[],point={get xMm(){reads.push('query-x');return 10000;},get zMm(){reads.push('query-z');return 20000;}};
    const slot={targetId:'tree',get position(){reads.push('position');return {get xMm(){reads.push('slot-x');return 0;},get zMm(){reads.push('slot-z');return 0;}};},get radiusMm(){reads.push('radius');return 350;}};
    (reservations as unknown as {slots:Map<string,typeof slot>}).slots=new Map([['reserved',slot]]);
    const hypot=vi.spyOn(Math,'hypot');
    try{
      expect(reservations.available('other',point,350)).toBe(true);expect(hypot).not.toHaveBeenCalled();
      expect(reads).toEqual(['position','slot-x','query-x','position','slot-z','query-z','radius']);reads.length=0;
      expect(reservations.available('reserved',point,350)).toBe(true);expect(reads).toEqual([]);
      expect(reservations.available('other',{xMm:100,zMm:100},350)).toBe(false);expect(hypot).toHaveBeenCalledTimes(1);
    }finally{hypot.mockRestore();}
  });
});
