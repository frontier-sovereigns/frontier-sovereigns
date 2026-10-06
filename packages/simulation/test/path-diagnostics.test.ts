import { describe, expect, it } from 'vitest';
import { Navigation } from '../src/navigation.js';
import { PathScheduler, type PathRequest } from '../src/path-scheduler.js';

const request:PathRequest={id:'path1',unitId:'u1',orderRevision:1,from:{xMm:1000,zMm:1000},target:{xMm:8000,zMm:1000},radiusMm:350,profile:'p1'};
const changed={xMm:3000,zMm:800,widthMm:100,depthMm:400};
function fixture(){let tick=10,ms=100;const nav=new Navigation(64000,64000,[]),scheduler=new PathScheduler(()=>nav);scheduler.enablePathDiagnostics({tick:()=>tick,now:()=>ms});return {scheduler,nav,set:(nextTick:number,nextMs:number)=>{tick=nextTick;ms=nextMs;}};}

describe('A0 private planning lifecycle census',()=>{
  it('leaves reports, results, saved frontiers and cold continuation exact',()=>{
    const nav=new Navigation(64000,64000,[{id:'wall',xMm:32000,zMm:24000,halfWidth:1000,halfHeight:18000}]);
    const control=new PathScheduler(()=>nav),observed=new PathScheduler(()=>nav);let tick=0,ms=0;
    expect(control.pathDiagnostics()).toBeUndefined();observed.enablePathDiagnostics({tick:()=>tick,now:()=>ms});
    const route={...request,from:{xMm:8000,zMm:24000},target:{xMm:56000,zMm:24000}};control.request(route);observed.request(route);
    let cold:PathScheduler|undefined;
    for(tick=1;tick<=180;tick++){
      ms+=tick%7?50:230;
      const expected=control.advance(128);expect(observed.advance(128)).toEqual(expected);if(cold)expect(cold.advance(128)).toEqual(expected);
      const result=control.take('u1',1);expect(observed.take('u1',1)).toEqual(result);if(cold)expect(cold.take('u1',1)).toEqual(result);
      if(tick===25){cold=new PathScheduler(()=>nav);cold.enablePathDiagnostics({tick:()=>tick,now:()=>ms});cold.importState(observed.exportState());expect(cold.pathDiagnostics()!.pendingAges.originalTicks.unknown).toBe(1);}
      if(tick%25===0||tick===180){expect(observed.exportState()).toEqual(control.exportState());if(cold)expect(cold.exportState()).toEqual(control.exportState());observed.pathDiagnostics();}
    }
    expect(JSON.stringify(observed.exportState())).not.toMatch(/originalTicks|observedTicks|pathCensus|pathDiagnostics/);
  });
  it('preserves original age across relevant invalidation and separates restart age, readiness and take',()=>{
    const {scheduler,set}=fixture();scheduler.request(request);scheduler.advance(3);set(14,160);
    scheduler.invalidate('p1',[{xMm:40000,zMm:40000,widthMm:100,depthMm:100}]);expect(scheduler.pathDiagnostics()!.counts.restarts).toBe(0);
    scheduler.invalidate('p1',[changed]);let report=scheduler.pathDiagnostics()!;
    expect(report.counts).toMatchObject({requests:1,restarts:1,invalidations:1});expect(report.pendingAges.originalTicks.oldest).toBe(4);expect(report.pendingAges.originalMs.oldest).toBe(60);expect(report.pendingAges.restartTicks.oldest).toBe(0);
    set(18,310);scheduler.advance(100);scheduler.advance(100);report=scheduler.pathDiagnostics()!;
    expect(report.counts.ready).toBe(1);expect(report.active).toMatchObject({pending:0,ready:1});expect(report.completionAges.readyAges.originalTicks.oldest).toBe(8);expect(report.completionAges.readyAges.restartMs.oldest).toBe(150);
    set(19,390);expect(scheduler.take('u1',1)?.status).toBe('ready');report=scheduler.pathDiagnostics()!;expect(report.counts.takenReady).toBe(1);expect(report.active.total).toBe(0);expect(report.events.at(-1)).toMatchObject({kind:'taken-ready',originalTicks:9,restartTicks:5,originalMs:290});
  });
  it('records cancellation, supersession and blocked outcomes without counting ignored or stale requests',()=>{
    const {scheduler,set}=fixture();scheduler.request(request);scheduler.request(request);scheduler.request({...request,id:'stale',orderRevision:0});expect(scheduler.take('u1',1)?.status).toBe('pending');
    set(12,200);scheduler.request({...request,id:'replacement',orderRevision:2});scheduler.cancel('u1');scheduler.cancel('u1');expect(scheduler.take('u1',2)).toBeUndefined();
    scheduler.request({...request,id:'blocked',target:{xMm:0,zMm:0}});scheduler.advance(1);expect(scheduler.take('u1',1)?.status).toBe('blocked');
    const report=scheduler.pathDiagnostics()!;expect(report.counts).toMatchObject({requests:3,superseded:1,canceled:1,pendingTakes:1,missingTakes:1,blocked:1,takenBlocked:1,ready:0});expect(report.completionAges).toMatchObject({samples:1,blocked:1,ready:0});
    expect(report.events.find(event=>event.kind==='superseded')).toMatchObject({id:'path1',originalTicks:2});
  });
  it('marks pre-observation age unknown for existing and restored tasks, including later restarts',()=>{
    let tick=70,ms=3500;const scheduler=new PathScheduler(()=>new Navigation(64000,64000,[]));scheduler.request(request);scheduler.advance(2);
    scheduler.enablePathDiagnostics({tick:()=>tick,now:()=>ms});const saved=scheduler.exportState();tick=80;ms=4000;
    let report=scheduler.pathDiagnostics()!;expect(report.pendingAges.originalTicks).toMatchObject({known:0,unknown:1,oldest:null});expect(report.pendingAges.observedTicks.oldest).toBe(10);
    scheduler.importState(saved);tick=90;ms=4500;report=scheduler.pathDiagnostics()!;
    expect(report.counts).toMatchObject({observedExisting:1,observedRestored:1,discardedOnRestore:1});expect(report.pendingAges.originalMs.unknown).toBe(1);expect(report.pendingAges.observedMs.oldest).toBe(500);
    scheduler.invalidate('p1',[changed]);tick=92;ms=4600;report=scheduler.pathDiagnostics()!;
    expect(report.pendingAges.originalTicks.unknown).toBe(1);expect(report.pendingAges.restartTicks.oldest).toBe(2);expect(report.pendingAges.observedTicks.oldest).toBe(12);expect(scheduler.exportState().tasks[0]!.lineStep).toBe(0);
  });
  it('reports candidate demand without combining knowledge profiles or body radii',()=>{
    const {scheduler}=fixture();
    const inputs=[{}, {},{profile:'p2'},{radiusMm:550},{target:{xMm:9000,zMm:1000}},{target:{xMm:18000,zMm:1000}}];
    for(const [i,change]of inputs.entries())scheduler.request({...request,...change,id:`path${i}`,unitId:`u${i}`});
    const report=scheduler.pathDiagnostics()!;expect(report.demand).toMatchObject({compatibilityProven:false,exactGoalGroups:5,exactGoalSharedRequests:2,regionGoalGroups:4,regionGoalSharedRequests:3});
    expect(report.demand.largestExactGoals[0]).toMatchObject({profile:'p1',radiusMm:350,requests:2});expect(report.demand.largestRegions[0]).toMatchObject({profile:'p1',radiusMm:350,requests:3});
    report.demand.largestExactGoals[0]!.requests=900;report.events[0]!.id='mutated';expect(scheduler.pathDiagnostics()!.demand.largestExactGoals[0]!.requests).toBe(2);expect(scheduler.pathDiagnostics()!.events[0]!.id).toBe('path0');
  });
  it('bounds outstanding tracking, retained events and completion samples, with explicit omissions',()=>{
    const {scheduler}=fixture();for(let i=0;i<4098;i++)scheduler.request({...request,id:`path${i}`,unitId:`u${i}`});
    let report=scheduler.pathDiagnostics()!;expect(report.active).toMatchObject({total:4098,tracked:4096,untracked:2,pending:4096});expect(report.counts.trackingDropped).toBe(2);expect(report.events).toHaveLength(256);expect(report.eventsOverwritten).toBe(4098-256);
    for(let i=0;i<4098;i++)scheduler.cancel(`u${i}`);report=scheduler.pathDiagnostics()!;expect(report.counts.canceled).toBe(4098);expect(report.active.total).toBe(0);
    for(let i=0;i<520;i++){scheduler.request({...request,id:`done${i}`,target:request.from});scheduler.advance(1);scheduler.take('u1',1);}
    report=scheduler.pathDiagnostics()!;expect(report.completionAges).toMatchObject({samples:512,overwritten:8,ready:512});expect(report.events).toHaveLength(256);expect(report.events.every((event,index,all)=>index===0||event.sequence===all[index-1]!.sequence+1)).toBe(true);
  });
  it('makes invalid diagnostic clocks explicit without throwing into gameplay or inventing negative ages',()=>{
    const nav=new Navigation(64000,64000,[]),control=new PathScheduler(()=>nav),observed=new PathScheduler(()=>nav);let value=10;
    observed.enablePathDiagnostics({tick:()=>value,now:()=>{throw new Error('diagnostic clock failed');}});control.request(request);observed.request(request);value=3;
    expect(observed.pathDiagnostics()!.pendingAges.originalTicks).toMatchObject({known:0,unknown:1});expect(observed.advance(100)).toEqual(control.advance(100));expect(observed.take('u1',1)).toEqual(control.take('u1',1));expect(observed.exportState()).toEqual(control.exportState());
    const report=observed.pathDiagnostics()!;expect(report.counts.invalidClockReads).toBeGreaterThan(0);expect(report.completionAges.ages.originalMs.unknown).toBe(1);
  });
});
