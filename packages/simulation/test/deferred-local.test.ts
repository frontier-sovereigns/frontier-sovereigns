import {describe,expect,it,vi} from 'vitest';
import {LocalAvoidance,UnitSpatialIndex,type LocalPathQuery,type LocalPathResult} from '../src/movement.js';
import {Navigation} from '../src/navigation.js';
import {createOwnedNavigation} from '../src/owned-navigation.js';

function fixture(){
  const local=new LocalAvoidance('deferred-v1'),nav=new Navigation(32000,32000,[]),neighbors=new UnitSpatialIndex();
  const body={id:'worker',xMm:8000,zMm:8000,radiusMm:350},target={xMm:14000,zMm:8000};
  neighbors.set(body);neighbors.set({id:'blocker',xMm:8800,zMm:8000,radiusMm:450});
  const step=(tick:number,orderRevision=1)=>{local.beginTick(tick,1);return local.step(body,target,200,nav,neighbors,nav,()=>true,undefined,[target],false,orderRevision);};
  const dispatch=(tick=1)=>local.prepareDeferredQueries('p1',1,[{body,target,remainingPath:[target],orderRevision:1}],neighbors,()=>true,1,tick);
  return {local,nav,neighbors,body,target,step,dispatch};
}
function answer(query:LocalPathQuery):LocalPathResult{return {query,destination:{...query.target},points:[{xMm:8000,zMm:7000},{xMm:14000,zMm:7000},{xMm:14000,zMm:8000}]};}

describe('versioned nonblocking local detours',()=>{
  it('certifies only a current stationary local wait without consuming credits, answers or retry age',()=>{
    const f=fixture(),matches=()=>f.local.matchesPendingLocal(f.body,f.target,undefined,[f.target],1);
    expect(matches()).toBe(false);f.step(1);const queued=f.local.exportState();expect(matches()).toBe(true);expect(f.local.exportState()).toEqual(queued);
    const query=f.dispatch()[0]!;expect(matches()).toBe(true);f.local.admitDeferredResults([answer(query)],2);const ready=f.local.exportState();expect(matches()).toBe(true);expect(f.local.exportState()).toEqual(ready);
    expect(f.local.matchesPendingLocal({...f.body,xMm:f.body.xMm+1},f.target,undefined,[f.target],1)).toBe(false);
    expect(f.local.matchesPendingLocal({...f.body,radiusMm:f.body.radiusMm+1},f.target,undefined,[f.target],1)).toBe(false);
    expect(f.local.matchesPendingLocal(f.body,f.target,undefined,[f.target],2)).toBe(false);
    expect(f.local.matchesPendingLocal(f.body,{...f.target,xMm:f.target.xMm+1},undefined,[f.target],1)).toBe(false);
    expect(f.local.matchesPendingLocal(f.body,f.target,f.target,[f.target],1)).toBe(false);
    expect(f.local.matchesPendingLocal(f.body,f.target,undefined,[],1)).toBe(false);
    expect(f.local.exportState()).toEqual(ready);f.local.invalidateDeferredEpoch();expect(matches()).toBe(false);
  });
  it('queues a paid compact request without any synchronous path search, retaining pending state through a long wait',()=>{
    const f=fixture(),path=vi.spyOn(Navigation.prototype,'path').mockImplementation(()=>{throw new Error('SYNC_PATH_FORBIDDEN');});
    try{
      expect(f.step(1)).toBeUndefined();expect(f.local.exportState().searches).toBe(0);
      const saved=f.local.exportState();expect(saved.deferred!.jobs).toHaveLength(1);expect(saved.deferred!.jobs[0]![1]).toMatchObject({status:'queued',firstTick:1,queuedTick:1});
      expect(JSON.stringify(saved)).not.toContain('neighbors');
      for(let tick=2;tick<=130;tick++)expect(f.step(tick)).toBeUndefined();
      expect(path).not.toHaveBeenCalled();expect(f.local.pendingLocal('worker')).toBe(true);
      expect(f.local.deferredDiagnostics(130)).toMatchObject({queued:1,oldestWaitTicks:129,prepared:0,used:0});
    }finally{path.mockRestore();}
  });
  it('keeps credit-starved movers pending beyond five seconds and eventually serves them in stable fair order',()=>{
    const local=new LocalAvoidance('deferred-v1'),nav=new Navigation(64000,64000,[]),neighbors=new UnitSpatialIndex();
    const movers=Array.from({length:120},(_,index)=>({id:`m${String(index).padStart(3,'0')}`,xMm:8000,zMm:8000,radiusMm:350})),target={xMm:14000,zMm:8000};
    neighbors.set({id:'blocker',xMm:8800,zMm:8000,radiusMm:450});
    for(let tick=1;tick<=120;tick++){local.beginTick(tick,1);for(const body of movers)local.step(body,target,200,nav,neighbors,nav,()=>true,undefined,[target],false,1);if(tick===101){expect(local.pendingLocal(movers[119]!.id)).toBe(true);expect(local.pendingLocalRequests()).toHaveLength(120);expect(local.deferredDiagnostics()).toMatchObject({waitingForCredit:19,oldestWaitTicks:100});}}
    expect(local.deferredDiagnostics()).toMatchObject({waitingForCredit:0,queued:120});
    const queries=local.prepareDeferredQueries('p1',1,movers.map(body=>({body,target,remainingPath:[target],orderRevision:1})),neighbors,()=>true,120,120);
    expect(queries.map(query=>query.body.id)).toEqual(movers.map(body=>body.id));
  });
  it('uses a historical authorized-neighbor hint while the current physical sweep still blocks an occupied first segment',()=>{
    const f=fixture();f.step(1);const query=f.dispatch()[0]!;
    // Historical blocker moved, and another body occupies the advised first leg.
    f.neighbors.update('blocker',8801,8000,450);f.neighbors.set({id:'new-blocker',xMm:8000,zMm:7200,radiusMm:450});
    f.local.admitDeferredResults([answer(query)],2);expect(f.step(2)).toBeUndefined();
    expect(f.local.deferredDiagnostics()).toMatchObject({used:1,retry:1});
    f.neighbors.delete('new-blocker');const next=f.step(3)!;expect(next).toEqual({xMm:8000,zMm:7800});
    expect(f.neighbors.clearLine(f.body,next,f.body.radiusMm,f.body.id)).toBe(true);expect(f.local.pendingLocal('worker')).toBe(false);
  });
  it.each(['order','origin','radius','goal','static','age'] as const)('rejects a stale %s binding without moving on a worker answer',kind=>{
    const f=fixture();f.step(1);const query=f.dispatch()[0]!;f.local.admitDeferredResults([answer(query)],2);
    let revision=1,tick=2;
    if(kind==='order')revision=2;
    if(kind==='origin'){f.body.xMm+=1;f.neighbors.set(f.body);}
    if(kind==='radius'){f.body.radiusMm+=1;f.neighbors.set(f.body);}
    if(kind==='goal')f.target.xMm+=1000;
    if(kind==='static')f.nav.obstacles.push({id:'new-wall',xMm:8000,zMm:7300,halfWidth:500,halfHeight:100});
    if(kind==='age')tick=42;
    // Navigation's immutable obstacle index must be rebuilt for real geometry.
    const nav=kind==='static'?new Navigation(32000,32000,f.nav.obstacles):f.nav;
    f.local.beginTick(tick,1);expect(f.local.step(f.body,f.target,200,nav,f.neighbors,nav,()=>true,undefined,[f.target],false,revision)).toBeUndefined();
    expect(f.local.deferredDiagnostics()).toMatchObject({used:0});
    expect(f.local.pendingLocal('worker')).toBe(true);
  });
  it('empty or malformed answers remain bounded retries, alternate resolution and preserve waiting age',()=>{
    const f=fixture();f.step(1);const query=f.dispatch()[0]!;
    f.local.admitDeferredResults([{query,destination:f.target,points:[{xMm:Number.NaN,zMm:1}]}],2);
    expect(f.step(2)).toBeUndefined();expect(f.local.exportState().deferred!.jobs[0]![1].status).toBe('retry');
    expect(f.step(12)).toBeUndefined();const second=f.dispatch(12)[0]!;expect(second.cellMm).toBe(1000);expect(second.localRequestId).not.toBe(query.localRequestId);
    f.local.admitDeferredResults([{query:second,points:[]}],13);expect(f.step(13)).toBeUndefined();
    expect(f.local.exportState().deferred!.jobs[0]![1].firstTick).toBe(1);expect(f.local.exportState().routes[0]![1].nextSearchCellMm).toBe(250);
    expect(f.local.pendingLocalRequests()[0]!.requestId).toBe('local_detour_v1');
  });
  it.each(['fraction','infinite','negative','outside','accessor','oversize'] as const)('rejects malformed %s guidance before it enters saved ready state',kind=>{
    const f=fixture();f.step(1);const query=f.dispatch()[0]!,reply=answer(query);
    if(kind==='fraction')reply.points[0]!.xMm=.5;
    if(kind==='infinite')reply.points[0]!.xMm=Infinity;
    if(kind==='negative')reply.points[0]!.xMm=-1;
    if(kind==='outside')reply.points[0]!.xMm=32001;
    if(kind==='accessor')Object.defineProperty(reply.points[0]!,'xMm',{get(){throw new Error('UNTRUSTED_GETTER');}});
    if(kind==='oversize')reply.points=Array.from({length:2049},()=>({xMm:8000,zMm:7000}));
    expect(()=>f.local.admitDeferredResults([reply],2,f.nav)).not.toThrow();expect(f.local.exportState().deferred!.jobs[0]![1].ready!.points).toEqual([]);
    expect(f.local.deferredDiagnostics()).toMatchObject({admitted:1,discarded:1,used:0});
  });
  it('cold saved ready guidance has identical contact behavior and bounded prefix guidance does not consume the goal',()=>{
    const f=fixture();f.step(1);const query=f.dispatch()[0]!;
    const points=Array.from({length:140},(_,index)=>({xMm:8000,zMm:7990-index*5}));
    f.local.admitDeferredResults([{query,destination:f.target,points}],2);
    const saved=f.local.exportState(),cold=new LocalAvoidance('deferred-v1');cold.importState(saved);
    expect(saved.deferred!.jobs[0]![1].ready!.points).toHaveLength(128);
    f.local.beginTick(2,1);cold.beginTick(2,1);
    const next=f.local.step(f.body,f.target,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.target],false,1);
    expect(cold.step(f.body,f.target,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.target],false,1)).toEqual(next);
    expect(cold.exportState()).toEqual(f.local.exportState());expect(f.local.exportState().routes[0]![1].target).toEqual(f.target);
  });
  it('epoch cancellation cannot admit an old reply into a fresh request serial',()=>{
    const f=fixture();f.step(1);const old=f.dispatch()[0]!;f.local.invalidateDeferredEpoch();
    f.step(2);const current=f.dispatch(2)[0]!;expect(current.localRequestId).toBeGreaterThan(old.localRequestId!);
    f.local.admitDeferredResults([answer(old)],3);expect(f.local.exportState().deferred!.jobs[0]![1]).toMatchObject({status:'queued',requestId:current.localRequestId});
    expect(f.local.deferredDiagnostics()).toMatchObject({admitted:0,used:0});
  });
  it('freezes only the nearest 128 currently authorized neighbors, preserving deterministic order and compact queued intents',()=>{
    const f=fixture();f.step(1);for(let i=0;i<180;i++)f.neighbors.set({id:`n${String(i).padStart(3,'0')}`,xMm:10000+i,zMm:9000,radiusMm:50});
    f.neighbors.set({id:'hidden',xMm:8050,zMm:8050,radiusMm:50});
    const query=f.local.prepareDeferredQueries('p1',1,[{body:f.body,target:f.target,remainingPath:[f.target],orderRevision:1}],f.neighbors,id=>id!=='hidden',1,1)[0]!;
    expect(query.neighbors).toHaveLength(128);expect(query.neighbors.some(value=>value.id==='hidden')).toBe(false);expect(query.neighbors[0]!.id).toBe('blocker');
    expect(JSON.stringify(f.local.exportState())).not.toContain('neighbors');
  });
  it('journaled wall-age recovery invalidates an old answer without clearing the global intent or resetting progress age',()=>{
    const f=fixture();f.step(1);const old=f.dispatch()[0]!;
    expect(f.local.retryPendingLocal('worker')).toBe(true);f.local.admitDeferredResults([answer(old)],2);expect(f.local.deferredDiagnostics()).toMatchObject({retry:1,admitted:0});
    f.step(2);expect(f.local.exportState().deferred!.jobs[0]![1]).toMatchObject({status:'queued',firstTick:1,queuedTick:2});
    expect(f.local.exportState().routes[0]![1].target).toEqual(f.target);
  });
});

describe('native deferred failed-direct collision witnesses',()=>{
  function setup(){
    const local=new LocalAvoidance('deferred-v1'),scalar=new LocalAvoidance('deferred-v1');
    const body={id:'worker',xMm:8000,zMm:8000,radiusMm:350},target={xMm:14000,zMm:8000},neighbors=new UnitSpatialIndex();
    neighbors.set(body);neighbors.set({id:'blocker',xMm:8800,zMm:8000,radiusMm:450});
    const current={nav:createOwnedNavigation(32000,32000,[]),neighbors,speed:200,order:1};
    function step(tick:number){
      local.beginTick(tick,1,true);scalar.beginTick(tick,1);
      const actual=local.step(body,target,current.speed,current.nav,current.neighbors,current.nav,()=>true,undefined,[target],true,current.order);
      const expected=scalar.step(body,target,current.speed,current.nav,current.neighbors,current.nav,()=>true,undefined,[target],false,current.order);
      expect(actual).toEqual(expected);expect(local.exportState()).toEqual(scalar.exportState());return actual;
    }
    step(0); // The first blocked contact establishes its ordinary local job.
    return {local,scalar,body,target,current,step};
  }
  it('reuses an actual failed sweep through unrelated motion while preserving all pending credit and saved state',()=>{
    const f=setup();expect(f.step(1)).toBeUndefined();expect(f.local.directFailureDiagnostics()).toEqual({prepared:1,used:0,pending:1});
    f.current.neighbors.set({id:'unrelated',xMm:17000,zMm:17000,radiusMm:350});
    for(let tick=2;tick<=12;tick++){f.current.neighbors.update('unrelated',17000+tick,17000,350);expect(f.step(tick)).toBeUndefined();}
    expect(f.local.directFailureDiagnostics()).toEqual({prepared:1,used:11,pending:1});
    expect(f.local.deferredDiagnostics()).toMatchObject({queued:1,oldestWaitTicks:12,used:0});
    expect(f.local.madeProgress(f.body.id)).toBe(false);expect(JSON.stringify(f.local.exportState())).not.toContain('failures');
  });
  it.each(['blocker-move','blocker-delete','blocker-reuse','blocker-radius','requester-move','requester-radius','target','speed','order','navigation','index'] as const)('invalidates the witnessed %s without diverging from ordinary contact behavior',change=>{
    const f=setup();f.step(1);f.step(2);expect(f.local.directFailureDiagnostics().used).toBe(1);
    if(change==='blocker-move')f.current.neighbors.update('blocker',10000,8000,450);
    if(change==='blocker-delete')f.current.neighbors.delete('blocker');
    if(change==='blocker-reuse'){const old=f.current.neighbors.handle('blocker')!;f.current.neighbors.delete('blocker');f.current.neighbors.set({id:'replacement',xMm:8800,zMm:8000,radiusMm:450});expect(f.current.neighbors.handle('replacement')!.slot).toBe(old.slot);}
    if(change==='blocker-radius')f.current.neighbors.update('blocker',8800,8000,100);
    if(change==='requester-move')f.body.xMm++;
    if(change==='requester-radius')f.body.radiusMm++;
    if(change==='target')f.target.zMm+=1000;
    if(change==='speed')f.current.speed=100;
    if(change==='order')f.current.order++;
    if(change==='navigation')f.current.nav=createOwnedNavigation(32000,32000,[]);
    if(change==='index'){const replacement=new UnitSpatialIndex();replacement.set(f.body);replacement.set({id:'blocker',xMm:8800,zMm:8000,radiusMm:450});f.current.neighbors=replacement;}
    f.step(3);expect(f.local.directFailureDiagnostics().used).toBe(1);
  });
  it('retains all four rounded-choice witnesses and refreshes an owned static obstruction after geometry changes',()=>{
    const f=setup();f.target.zMm=14000;f.current.neighbors.update('blocker',8570,8570,450);
    expect(f.step(1)).toBeUndefined();expect(f.step(2)).toBeUndefined();expect(f.local.directFailureDiagnostics()).toMatchObject({prepared:1,used:1});
    const failures=(f.local as unknown as {failedDirectSteps:Map<string,{failures:unknown[]}>}).failedDirectSteps.get('worker')!.failures;
    expect(failures).toHaveLength(4);
    f.current.neighbors.delete('blocker');f.current.nav=createOwnedNavigation(32000,32000,[{id:'wall',xMm:8550,zMm:8550,halfWidth:300,halfHeight:300}]);
    expect(f.step(3)).toBeUndefined();expect(f.step(4)).toBeUndefined();expect(f.local.directFailureDiagnostics()).toMatchObject({prepared:2,used:2});
    f.current.nav=createOwnedNavigation(32000,32000,[]);expect(f.step(5)).toBeDefined();expect(f.local.directFailureDiagnostics().pending).toBe(0);
  });
  it('checks numeric collision storage when a public retained body was mutated independently',()=>{
    const f=setup();f.step(1);f.step(2);const retained=f.current.neighbors.body('blocker')!;
    f.current.neighbors.update('blocker',10000,8000,450);
    retained.xMm=8800; // Public body() aliases are not authoritative sweep data.
    expect(f.step(3)).toEqual({xMm:8200,zMm:8000});expect(f.local.directFailureDiagnostics()).toMatchObject({used:1,pending:0});
  });
  it('continues admitted-answer, retry and cold-restoration transitions when the direct query is reused',()=>{
    const f=setup();f.step(1);
    const queries=[f.local,f.scalar].map(local=>local.prepareDeferredQueries('p1',1,[{body:f.body,target:f.target,remainingPath:[f.target],orderRevision:1}],f.current.neighbors,()=>true,1,1)[0]!);
    [f.local,f.scalar].forEach((local,index)=>local.admitDeferredResults([{query:queries[index]!,points:[]}],2));
    const cold=new LocalAvoidance('deferred-v1');cold.importState(f.local.exportState());
    expect(f.step(2)).toBeUndefined();expect(f.local.directFailureDiagnostics().used).toBe(1);expect(f.local.exportState().deferred!.jobs[0]![1].status).toBe('retry');
    cold.beginTick(2,1,true);expect(cold.step(f.body,f.target,200,f.current.nav,f.current.neighbors,f.current.nav,()=>true,undefined,[f.target],true,1)).toBeUndefined();expect(cold.exportState()).toEqual(f.local.exportState());expect(cold.directFailureDiagnostics().used).toBe(0);
    expect(f.step(12)).toBeUndefined();expect(f.local.exportState().deferred!.jobs[0]![1]).toMatchObject({status:'queued',firstTick:0,cellMm:1000});
    const nextQueries=[f.local,f.scalar].map(local=>local.prepareDeferredQueries('p1',1,[{body:f.body,target:f.target,remainingPath:[f.target],orderRevision:1}],f.current.neighbors,()=>true,1,12)[0]!);
    [f.local,f.scalar].forEach((local,index)=>local.admitDeferredResults([answer(nextQueries[index]!)],13));
    expect(f.step(13)).toEqual({xMm:8000,zMm:7800});expect(f.local.directFailureDiagnostics().pending).toBe(0);expect(f.local.deferredDiagnostics()).toMatchObject({used:1});
  });
  it.each(['static-reader','dynamic-reader','index-reader','generic-navigation','budget','revoked'] as const)('preserves ordinary queries under %s and drops old proofs',kind=>{
    const f=setup();f.step(1);f.step(2);let calls=0,restore=()=>{};
    if(kind==='static-reader'){const original=f.current.nav.clearLine,spy=vi.spyOn(Object.getPrototypeOf(f.current.nav),'clearLine').mockImplementation(function(this:Navigation,...args:unknown[]){calls++;return original.apply(this,args as Parameters<Navigation['clearLine']>);});restore=()=>spy.mockRestore();}
    try{
    if(kind==='dynamic-reader'){const original=f.current.neighbors.clearLine.bind(f.current.neighbors);f.current.neighbors.clearLine=(...args)=>{calls++;return original(...args);};}
    if(kind==='index-reader'){const original=f.current.neighbors.directFailuresUnchanged;f.current.neighbors.directFailuresUnchanged=(...args)=>{calls++;return original.apply(f.current.neighbors,args);};}
    if(kind==='generic-navigation')f.current.nav=new Navigation(32000,32000,[]);
    if(kind==='budget')f.current.nav=createOwnedNavigation(32000,32000,[],30000,1000,{remaining:100000,used:0});
    if(kind==='revoked'){
      f.local.beginTick(3,1);f.scalar.beginTick(3,1);
      expect(f.local.step(f.body,f.target,200,f.current.nav,f.current.neighbors,f.current.nav,()=>true,undefined,[f.target],false,1)).toEqual(f.scalar.step(f.body,f.target,200,f.current.nav,f.current.neighbors,f.current.nav,()=>true,undefined,[f.target],false,1));expect(f.local.exportState()).toEqual(f.scalar.exportState());
    }else f.step(3);
    expect(f.local.directFailureDiagnostics()).toMatchObject({used:1,pending:0});
    if(kind==='static-reader'||kind==='dynamic-reader')expect(calls).toBeGreaterThan(0);
    if(kind==='index-reader')expect(calls).toBe(0);
    }finally{restore();}
  });
  it('releases proof storage on cancellation, epoch reset and import without retaining authority in saves',()=>{
    for(const reset of ['release','epoch','import'] as const){const f=setup();f.step(1);f.step(2);const saved=f.local.exportState();if(reset==='release')f.local.release(f.body.id);if(reset==='epoch')f.local.invalidateDeferredEpoch();if(reset==='import')f.local.importState(saved);expect(f.local.directFailureDiagnostics().pending).toBe(0);}
  });
});

describe('deferred actual-blocker recovery timing',()=>{
  function jam(native=true){
    const local=new LocalAvoidance('deferred-v1'),neighbors=new UnitSpatialIndex(),nav=createOwnedNavigation(32000,32000,[{id:'north-gate-wall',xMm:10000,zMm:6000,halfWidth:5000,halfHeight:300},{id:'south-gate-wall',xMm:10000,zMm:10000,halfWidth:5000,halfHeight:300}]);
    const a={id:'a',xMm:8000,zMm:8000,radiusMm:350},b={id:'b',xMm:8700,zMm:8000,radiusMm:350},targets=[{xMm:14000,zMm:8000},{xMm:3000,zMm:8000}],bodies=[a,b];
    const state={order:1,pending:[] as LocalPathQuery[],positions:[] as {tick:number;id:string;xMm:number;zMm:number}[],reply:(query:LocalPathQuery,_tick:number):LocalPathResult=>({query,points:[]})};
    function step(tick:number){
      neighbors.set({id:'traffic',xMm:8500+(tick%2)*40,zMm:9300,radiusMm:100});for(const body of bodies)neighbors.set(body);
      local.admitDeferredResults(state.pending.map(query=>state.reply(query,tick)),tick,nav);state.pending=[];local.beginTick(tick,8,native);
      for(const [index,body]of bodies.entries()){
        const from={...body},next=local.step(body,targets[index]!,200,nav,neighbors,nav,()=>true,undefined,[targets[index]!],native,state.order);
        if(next){expect(nav.clearLine(from,next,body.radiusMm)).toBe(true);expect(neighbors.clearLine(from,next,body.radiusMm,body.id)).toBe(true);Object.assign(body,next);neighbors.set(body);state.positions.push({tick,id:body.id,...next});}
      }
      state.pending=local.prepareDeferredQueries('same-faction',1,bodies.map((body,index)=>({body,target:targets[index]!,remainingPath:[targets[index]!],orderRevision:state.order})),neighbors,()=>true,8,tick);
    }
    return {local,neighbors,nav,a,b,bodies,targets,state,step,native};
  }
  it('recovers opposing same-faction movers at an open gate despite unrelated nearby traffic, with exact cold/native continuation',()=>{
    const warm=jam(),scalar=jam(false);for(let tick=1;tick<=46;tick++){warm.step(tick);scalar.step(tick);expect(warm.local.exportState()).toEqual(scalar.local.exportState());}
    expect(warm.state.positions).toEqual([]);expect(warm.local.exportState().routes.every(([,route])=>route.stableSinceTick===2)).toBe(true);
    const saved=warm.local.exportState();expect(saved.deferred!.jobs.every(([,job])=>job.status!=='inflight')).toBe(true);
    const cold=jam();cold.local.importState(saved);Object.assign(cold.a,warm.a);Object.assign(cold.b,warm.b);
    for(let tick=47;tick<=85;tick++){for(const f of [warm,scalar,cold])f.step(tick);expect(warm.local.exportState()).toEqual(scalar.local.exportState());expect(cold.local.exportState()).toEqual(warm.local.exportState());expect(cold.bodies).toEqual(warm.bodies);}
    expect(warm.state.positions[0]).toMatchObject({tick:68,id:'b'});expect(warm.state.positions[0]!.xMm).toBeGreaterThan(8700);expect(warm.state.positions.some(point=>point.id==='a')).toBe(true);
    expect(warm.local.exportState().routes.find(([id])=>id==='b')![1].yield?.requesterId).toBe('a');
  });
  it.each(['blocker-micro-motion','changing-admitted-guide'] as const)('bounds stationary recovery under %s without bypassing the paid reply cadence',cause=>{
    const warm=jam(),scalar=jam(false),configure=(f:ReturnType<typeof jam>)=>{if(cause==='changing-admitted-guide')f.state.reply=(query,tick)=>query.body.id==='b'?{query,destination:{...query.target},points:tick%2?[{xMm:query.target.xMm,zMm:query.target.zMm+1},{...query.target}]:[{...query.target}]}:{query,points:[]};};
    for(const f of [warm,scalar])configure(f);
    const step=(f:ReturnType<typeof jam>,tick:number)=>{if(cause==='blocker-micro-motion')f.a.xMm=7998+tick%2;f.step(tick);};
    for(let tick=1;tick<=90;tick++){step(warm,tick);step(scalar,tick);expect(warm.local.exportState()).toEqual(scalar.local.exportState());}
    expect(warm.state.positions).toEqual([]);const saved=warm.local.exportState(),route=saved.routes.find(([id])=>id==='b')![1];expect(route.stableSinceTick).toBeGreaterThan(60);expect(saved.deferred!.jobs.find(([id])=>id==='b')![1].firstTick).toBe(1);
    const cold=jam();configure(cold);cold.local.importState(saved);Object.assign(cold.a,warm.a);Object.assign(cold.b,warm.b);
    for(let tick=91;tick<=110;tick++){for(const f of [warm,scalar,cold])step(f,tick);expect(warm.local.exportState()).toEqual(scalar.local.exportState());expect(cold.local.exportState()).toEqual(warm.local.exportState());expect(cold.bodies).toEqual(warm.bodies);if(tick===100)expect(warm.state.positions).toEqual([]);}
    const moved=warm.state.positions.find(point=>point.id==='b')!;expect(moved).toMatchObject({tick:101});expect(moved.xMm).toBeGreaterThan(8700);expect(warm.local.exportState().routes.find(([id])=>id==='b')![1].yield?.requesterId).toBe('a');
  });
  it.each(['actual-displacement','new-order'] as const)('restarts the five-second wait after %s despite continued blocker micro-motion',change=>{
    const f=jam();for(let tick=1;tick<=94;tick++){f.a.xMm=7998+tick%2;f.step(tick);}expect(f.state.positions).toEqual([]);
    if(change==='actual-displacement')f.b.xMm++;else f.state.order++;
    for(let tick=95;tick<=135;tick++){f.a.xMm=7998+tick%2;f.step(tick);}expect(f.state.positions).toEqual([]);
    const saved=f.local.exportState(),job=saved.deferred!.jobs.find(([id])=>id==='b')![1];expect(job.firstTick).toBeGreaterThanOrEqual(95);expect(job.body.xMm).toBe(f.b.xMm);expect(job.orderRevision).toBe(f.state.order);expect(saved.routes.find(([id])=>id==='b')![1].yield).toBeUndefined();
  });
  it.each(['credit','queued','inflight'] as const)('does not turn an old %s job into an unadmitted recovery attempt',status=>{
    const f=jam();f.step(1);const saved=f.local.exportState();for(const [,job]of saved.deferred!.jobs){job.status=status;delete job.ready;if(status!=='inflight')delete job.dispatchedTick;}
    f.local.importState(saved);f.local.beginTick(200,status==='credit'?0:8,true);
    for(const [index,body]of f.bodies.entries())expect(f.local.step(body,f.targets[index]!,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.targets[index]!],true,1)).toBeUndefined();
    expect(f.local.exportState().routes.every(([,route])=>route.yield===undefined&&route.stableSinceTick===undefined)).toBe(true);expect(f.local.exportState().deferred!.jobs.every(([,job])=>job.status===status)).toBe(true);
  });
  it.each(['neighborhood-limit','encoded-stamp-limit'] as const)('keeps an aged admitted retry conservative at the %s',limit=>{
    const f=jam();for(let tick=1;tick<=100;tick++){f.a.xMm=7998+tick%2;f.step(tick);}expect(f.state.positions).toEqual([]);
    f.local.admitDeferredResults(f.state.pending.filter(query=>query.body.id==='b').map(query=>({query,points:[]})),101,f.nav);f.local.beginTick(101,8,true);
    const stamp=vi.spyOn(f.neighbors,'blockingStamp').mockReturnValue(limit==='encoded-stamp-limit'?'\\'.repeat(32768):undefined),nearby=vi.spyOn(f.neighbors,'withNearby');
    try{expect(f.local.step(f.b,f.targets[1]!,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.targets[1]!],true,1)).toBeUndefined();expect(nearby).not.toHaveBeenCalled();const route=f.local.exportState().routes.find(([id])=>id==='b')![1];expect(route.stableSinceTick).toBe(101);expect(route.neighborStamp).toBeUndefined();expect(route.yield).toBeUndefined();}finally{stamp.mockRestore();nearby.mockRestore();}
  });
  it.each(['blocker-position','blocker-radius','blocker-id','requester-position','requester-radius','order','target'] as const)('restarts recovery after an actual %s change',change=>{
    const f=jam();for(let tick=1;tick<=35;tick++)f.step(tick);
    if(change==='blocker-position')f.a.xMm++;
    if(change==='blocker-radius')f.a.radiusMm++;
    if(change==='blocker-id'){f.neighbors.delete(f.a.id);f.local.release(f.a.id);f.a.id='aa';}
    if(change==='requester-position')f.b.xMm--;
    if(change==='requester-radius')f.b.radiusMm++;
    if(change==='order')f.state.order++;
    if(change==='target')f.targets[1]!.xMm--;
    for(let tick=36;tick<=50;tick++)f.step(tick);
    const route=f.local.exportState().routes.find(([id])=>id==='b')![1];expect(route.stableSinceTick).toBeGreaterThan(35);expect(route.yield).toBeUndefined();expect(f.state.positions).toEqual([]);
  });
  it('clears accumulated recovery age immediately after actual displacement',()=>{
    const f=jam();for(let tick=1;tick<=35;tick++)f.step(tick);f.a.xMm=5000;f.neighbors.set(f.a);f.local.beginTick(36,8,true);
    const next=f.local.step(f.b,f.targets[1]!,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.targets[1]!],true,1);expect(next).toEqual({xMm:8500,zMm:8000});
    const route=f.local.exportState().routes.find(([id])=>id==='b')![1];expect(route.neighborStamp).toBeUndefined();expect(route.stableSinceTick).toBeUndefined();expect(f.local.pendingLocal('b')).toBe(false);
  });
  it('never makes another faction or an inactive route a yielding requester',()=>{
    const f=jam();for(let tick=1;tick<=35;tick++)f.step(tick);f.local.release('a');
    for(let tick=36;tick<=100;tick++){
      f.local.admitDeferredResults(f.state.pending.filter(query=>query.body.id==='b').map(query=>({query,points:[]})),tick,f.nav);f.local.beginTick(tick,8,true);
      f.local.step(f.b,f.targets[1]!,200,f.nav,f.neighbors,f.nav,()=>true,undefined,[f.targets[1]!],true,1);
      f.state.pending=f.local.prepareDeferredQueries('same-faction',1,[{body:f.b,target:f.targets[1]!,remainingPath:[f.targets[1]!],orderRevision:1}],f.neighbors,()=>true,1,tick);
    }
    expect(f.local.exportState().routes.find(([id])=>id==='b')![1].yield).toBeUndefined();expect(f.a.xMm).toBe(8000);
  });
  it('bounds signatures, excludes hidden bodies, and reads current numeric collision storage',()=>{
    const index=new UnitSpatialIndex(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},choices=[{xMm:8200,zMm:8000}];index.set(body);index.set({id:'blocker',xMm:8800,zMm:8000,radiusMm:450});index.set({id:'hidden',xMm:8800,zMm:8000,radiusMm:450});
    const stamp=index.blockingStamp(body,choices,id=>id!=='hidden')!;expect(stamp).toContain('blocker');expect(stamp).not.toContain('hidden');index.body('blocker')!.xMm=16000;expect(index.blockingStamp(body,choices,id=>id!=='hidden')).toBe(stamp);
    index.update('blocker',16000,8000,450);expect(index.blockingStamp(body,choices,id=>id!=='hidden')).toBe('[]');
    for(let i=0;i<129;i++)index.set({id:`dense_${i}`,xMm:8800,zMm:8000,radiusMm:450});expect(index.blockingStamp(body,choices,()=>true)).toBeUndefined();
  });
  it('keeps legacy synchronous recovery timing and reader calls unchanged',()=>{
    const local=new LocalAvoidance(),nav=new Navigation(32000,32000,[]),neighbors=new UnitSpatialIndex(),body={id:'b',xMm:8700,zMm:8000,radiusMm:350},target={xMm:3000,zMm:8000};neighbors.set(body);neighbors.set({id:'a',xMm:8000,zMm:8000,radiusMm:350});
    const path=vi.spyOn(Navigation.prototype,'path').mockReturnValue(null),stamp=vi.spyOn(neighbors,'blockingStamp').mockImplementation(()=>{throw new Error('LEGACY_READER_MUST_NOT_RUN');});
    try{for(let tick=1;tick<=100;tick++){neighbors.set({id:'traffic',xMm:8500+tick,zMm:9300,radiusMm:100});local.beginTick(tick,8);expect(local.step(body,target,200,nav,neighbors)).toBeUndefined();}expect(local.exportState().routes[0]![1].stableSinceTick).toBe(91);expect(stamp).not.toHaveBeenCalled();}finally{path.mockRestore();stamp.mockRestore();}
  });
});
