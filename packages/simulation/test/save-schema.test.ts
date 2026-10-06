import { beforeAll, describe, expect, it } from 'vitest';
import { createSimulation, restoreSimulation, sealSimulationCapture, type EngineIdentity, type SimulationSavePayload, type Unit } from '../src/index.js';
import { validateCommanderMemory, validateJournalEvent, validateSimulationSavePayload } from '../src/save-schema.js';
import { Navigation } from '../src/navigation.js';
import { PathScheduler, CORNER_WORK_LIMIT, CORNER_SWEEP_MM } from '../src/path-scheduler.js';
import type { JournalEvent } from '../src/persistence-types.js';

let initial:SimulationSavePayload;
beforeAll(()=>{initial=createSimulation({seed:'save-validation',matchId:'strict_save',controllers:false,factions:[{id:'a',name:'A',teamId:'a',color:'#aabbcc',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ccddee',kind:'human'}]}).capture();});
function valid(payload:SimulationSavePayload){expect(validateSimulationSavePayload(payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);}

describe('strict host-only simulation save boundary',()=>{
  function localJobPayload(status:'credit'|'queued'|'retry'|'ready'='queued'){
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    payload.options.authoritativeIntervalMs=300;payload.options.localPlanningMode='deferred-v1';
    for(const [,state]of payload.runtime.localAvoidance)state.deferred={version:1,nextRequestId:1,jobs:[]};
    const target={xMm:worker.xMm+1000,zMm:worker.zMm},local=payload.runtime.localAvoidance.find(([id])=>id==='a')![1];
    local.routes=[[worker.id,{target:{...target},points:[],retryTick:0}]];
    local.deferred={version:1,nextRequestId:2,jobs:[[worker.id,{requestId:1,orderRevision:worker.orderRevision??0,body:{id:worker.id,xMm:worker.xMm,zMm:worker.zMm,radiusMm:350},target,remainingPath:[{...target}],cellMm:250,queuedTick:0,firstTick:0,status,...(status==='ready'?{dispatchedTick:0,ready:{tick:0,destination:{...target},points:[{...target}]}}:{})}]]};
    return payload;
  }
  it.each(['credit','queued','retry','ready'] as const)('retains compact %s local-detour authority through cold saves without worker neighbor snapshots',status=>{
    const payload=localJobPayload(status);valid(payload);
    const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
    expect(restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true}).capture()).toEqual(payload);
    const encoded=JSON.stringify(payload.runtime.localAvoidance);expect(encoded).not.toContain('neighbors');expect(encoded).not.toContain('geometryRevision');
  });
  it('preserves legacy saves and stale local inputs for authoritative revalidation instead of silently discarding them',()=>{
    valid(initial);const legacy=structuredClone(initial);legacy.options.authoritativeIntervalMs=300;valid(legacy);
    const payload=localJobPayload('ready'),local=payload.runtime.localAvoidance.find(([id])=>id==='a')![1],job=local.deferred!.jobs[0]![1];
    payload.state.tick=100;local.tick=100;job.body.xMm++;job.body.radiusMm=500;job.target.zMm++;valid(payload);
    // An expired admitted answer is harmless saved data: current execution
    // checks finite age/order/geometry before using it. Save validation must not
    // fail merely because a late boundary retained such an answer.
    expect(job.ready!.tick).toBeLessThan(payload.state.tick-40);
  });
  it.each([
    ['missing mode',(p:any,l:any)=>{delete p.options.localPlanningMode;}],
    ['missing queue payload',(_p:any,l:any)=>{delete l.deferred;}],
    ['50ms mode',(p:any)=>{p.options.authoritativeIntervalMs=50;}],
    ['unsupported version',(_p:any,l:any)=>{l.deferred.version=2;}],
    ['reused serial',(_p:any,l:any)=>{l.deferred.nextRequestId=1;}],
    ['duplicate jobs',(_p:any,l:any)=>{l.deferred.jobs.push(structuredClone(l.deferred.jobs[0]));}],
    ['wrong body identity',(_p:any,_l:any,j:any)=>{j.body.id='another_unit';}],
    ['foreign owner',(p:any,l:any)=>{const unit=Object.values<any>(p.state.entities).find(e=>e.kind==='unit'&&e.ownerId==='b');l.deferred.jobs[0][0]=unit.id;l.deferred.jobs[0][1].body.id=unit.id;}],
    ['wrong order',(_p:any,_l:any,j:any)=>{j.orderRevision++;}],
    ['missing route',(_p:any,l:any)=>{l.routes=[];}],
    ['future queue',(_p:any,_l:any,j:any)=>{j.queuedTick=1;}],
    ['reversed wait age',(_p:any,_l:any,j:any)=>{j.firstTick=1;}],
    ['inflight worker state',(_p:any,_l:any,j:any)=>{j.status='inflight';j.dispatchedTick=0;}],
    ['queued dispatch',(_p:any,_l:any,j:any)=>{j.dispatchedTick=0;}],
    ['unpaid dispatch',(_p:any,_l:any,j:any)=>{j.status='credit';j.dispatchedTick=0;}],
    ['hidden query snapshot',(_p:any,_l:any,j:any)=>{j.neighbors=[];}],
    ['oversized route hint',(_p:any,_l:any,j:any)=>{j.remainingPath=Array.from({length:7},()=>({...j.target}));}],
    ['outside map',(p:any,_l:any,j:any)=>{j.target.xMm=p.state.widthMm+1;}],
    ['ready without answer',(_p:any,_l:any,j:any)=>{j.status='ready';j.dispatchedTick=0;}],
    ['retry with answer',(_p:any,_l:any,j:any)=>{j.status='retry';j.ready={tick:0,points:[]};}],
  ])('rejects invalid deferred local authority: %s',(_label,mutate)=>{
    const payload=localJobPayload(),local=payload.runtime.localAvoidance.find(([id])=>id==='a')![1];mutate(payload,local,local.deferred!.jobs[0]![1]);expect(validateSimulationSavePayload(payload)).toBe(false);
  });
  it.each([
    ['missing dispatch',(_p:any,j:any)=>{delete j.dispatchedTick;}],
    ['future dispatch',(_p:any,j:any)=>{j.dispatchedTick=1;}],
    ['future admission',(_p:any,j:any)=>{j.ready.tick=1;}],
    ['missing destination',(_p:any,j:any)=>{delete j.ready.destination;}],
    ['oversized answer',(_p:any,j:any)=>{j.ready.points=Array.from({length:129},()=>({...j.target}));}],
    ['outside-map answer',(p:any,j:any)=>{j.ready.points[0].zMm=p.state.heightMm+1;}],
  ])('rejects invalid admitted local answers: %s',(_label,mutate)=>{
    const payload=localJobPayload('ready'),job=payload.runtime.localAvoidance.find(([id])=>id==='a')![1].deferred!.jobs[0]![1];mutate(payload,job);expect(validateSimulationSavePayload(payload)).toBe(false);
  });
  it('keeps local service replay admissions bounded to explicit committed lease events',()=>{
    for(const kind of ['planning_service_start','planning_service_admit'])for(const leases of [1,6,60]){
      const event={ordinal:1,tick:0,phase:'boundary',kind,leases};expect(validateJournalEvent(event)).toBe(true);
      for(const patch of [{phase:'controllers'},{leases:0},{leases:61},{leases:1.5},{localResults:[]},{neighbors:[]}])expect(validateJournalEvent({...event,...patch})).toBe(false);
    }
  });
  it('requires a bounded authoritative movement cadence and admits its journal only at a boundary',()=>{
    for(const tier of [0,1,2,3] as const){const payload=structuredClone(initial);payload.state.movementCadenceTier=tier;valid(payload);expect(validateJournalEvent({ordinal:1,tick:0,phase:'boundary',kind:'movement_cadence',tier})).toBe(true);}
    for(const tier of [-1,4,.5,'1',null,undefined,NaN,Infinity]){
      const payload=structuredClone(initial);Object.assign(payload.state,{movementCadenceTier:tier});expect(validateSimulationSavePayload(payload)).toBe(false);
      expect(validateJournalEvent({ordinal:1,tick:0,phase:'boundary',kind:'movement_cadence',tier})).toBe(false);
    }
    const missing=structuredClone(initial);delete (missing.state as Partial<typeof missing.state>).movementCadenceTier;expect(validateSimulationSavePayload(missing)).toBe(false);
    for(const patch of [{phase:'controllers'},{playerId:'a'},{reason:'wall-clock decision'},{tier:3,privateRoutes:[]}])expect(validateJournalEvent({ordinal:1,tick:0,phase:'boundary',kind:'movement_cadence',tier:1,...patch})).toBe(false);
  });
  it('restores deferred coarse preparation after changed corner sources and rejects mixed stale frontiers',()=>{
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,ridge={id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000};
    let obstacles=[ridge],nav=new Navigation(payload.state.widthMm,payload.state.heightMm,obstacles);const scheduler=new PathScheduler(()=>nav,['a','b']);
    scheduler.request({id:'deferred_coarse',unitId:worker.id,profile:'a',orderRevision:0,from:{xMm:16000,zMm:80000},target:{xMm:144000,zMm:80000},radiusMm:850});
    for(let credit=0;credit<800;credit++){scheduler.advance(2);if(scheduler.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
    const oldCorner=structuredClone(scheduler.exportState().tasks[0]!.corner!);expect(oldCorner.phase).toBe('search');
    obstacles=[ridge,{id:'far_tree',xMm:180000,zMm:140000,halfWidth:350,halfHeight:350}];nav=new Navigation(payload.state.widthMm,payload.state.heightMm,obstacles);scheduler.invalidate('a',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);
    payload.runtime.planningProfiles.find(([id])=>id==='a')![1]={revision:2,obstacles:obstacles.map(obstacle=>[obstacle.id,obstacle])};payload.runtime.pathScheduler=scheduler.exportState();
    expect(payload.runtime.pathScheduler.tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true});valid(payload);
    const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(payload);
    for(const mutate of [(task:any)=>{task.corner=oldCorner;},(task:any)=>{task.stage='direct';},(task:any)=>{task.starts=[1];},(task:any)=>{task.startComponents=[];},(task:any)=>{task.prepareEndpoints=false;}]){const invalid=structuredClone(payload);mutate(invalid.runtime.pathScheduler.tasks[0]);expect(validateSimulationSavePayload(invalid)).toBe(false);}
    const cold=new PathScheduler(()=>nav,['a','b']);cold.importState(restored.capture().runtime.pathScheduler);expect(cold.advance(2)).toEqual(scheduler.advance(2));expect(cold.exportState()).toEqual(scheduler.exportState());payload.runtime.pathScheduler=scheduler.exportState();valid(payload);
  });
  it('validates and restores bounded corner-search progress and rejects forged candidates, cursors and frontiers',()=>{
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    const obstacles=[{id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000}],nav=new Navigation(payload.state.widthMm,payload.state.heightMm,obstacles),scheduler=new PathScheduler(()=>nav,['a','b']);
    payload.runtime.planningProfiles.find(([id])=>id==='a')![1]={revision:1,obstacles:obstacles.map(obstacle=>[obstacle.id,obstacle])};
    scheduler.request({id:'saved_corner',unitId:worker.id,profile:'a',orderRevision:0,from:{xMm:16000,zMm:80000},target:{xMm:144000,zMm:80000},radiusMm:850});
    for(let step=0;step<500;step++){scheduler.advance(2);const task=scheduler.exportState().tasks[0]!;if(task.corner){payload.runtime.pathScheduler=scheduler.exportState();valid(payload);}if(task.corner?.sweepStep!>2)break;}
    payload.runtime.pathScheduler=scheduler.exportState();expect(payload.runtime.pathScheduler.tasks[0]!.corner?.sweepStep).toBeGreaterThan(2);valid(payload);
    const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(payload);
    for(const mutate of [
      (task:any)=>{task.corner.points[2].xMm++;},(task:any)=>{task.corner.obstacleCursor=257;},(task:any)=>{task.corner.work=CORNER_WORK_LIMIT+1;},
      (task:any)=>{task.corner.sweepStep=task.corner.sweepSteps;},(task:any)=>{task.corner.current=1;},(task:any)=>{task.corner.parents[0]=0;},
      (task:any)=>{task.corner.scores[2]=0;task.corner.parents[2]=2;},(task:any)=>{task.stage='direct';},(task:any)=>{delete task.corner;},
      (task:any)=>{task.starts=[];task.ends=[];},(task:any)=>{task.corner.closed[0]=false;},
      (task:any)=>{task.corner.work=task.corner.obstacleCursor+1;},
      (task:any)=>{const corner=task.corner,index=corner.points.findIndex((point:any,i:number)=>i>1&&!nav.clearLine(task.from,point,task.radiusMm));expect(index).toBeGreaterThan(1);corner.parents[index]=0;corner.scores[index]=Math.hypot(corner.points[index].xMm-task.from.xMm,corner.points[index].zMm-task.from.zMm);corner.work=CORNER_WORK_LIMIT;},
      (task:any)=>{const corner=task.corner,index=corner.points.findIndex((point:any,i:number)=>i>1&&!nav.clearLine(task.from,point,task.radiusMm));corner.edgeCursor=index;corner.sweepSteps=Math.ceil(Math.hypot(corner.points[index].xMm-task.from.xMm,corner.points[index].zMm-task.from.zMm)/CORNER_SWEEP_MM);corner.sweepStep=corner.sweepSteps-1;corner.work=CORNER_WORK_LIMIT;},
    ]){const invalid=structuredClone(payload);mutate(invalid.runtime.pathScheduler.tasks[0]);expect(validateSimulationSavePayload(invalid)).toBe(false);}
    const cold=new PathScheduler(()=>nav,['a','b']);cold.importState(restored.capture().runtime.pathScheduler);
    for(let batch=0;batch<24;batch++){expect(cold.advance(512)).toEqual(scheduler.advance(512));expect(cold.exportState()).toEqual(scheduler.exportState());payload.runtime.pathScheduler=scheduler.exportState();valid(payload);if(payload.runtime.pathScheduler.tasks[0]!.result)break;}
    expect(payload.runtime.pathScheduler.tasks[0]!.result?.status).toBe('ready');expect(payload.runtime.pathScheduler.regions).toEqual([]);
  });
  it('retains one owned recovery explorer through saves and rejects foreign or malformed identities',()=>{
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find(entity=>entity.ownerId==='a'&&entity.typeId==='villager')!;
    for(const memory of [payload.state.controllers.a!,payload.state.control.a!.memory])memory.explorerId=worker.id;
    valid(payload);const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
    expect(restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true}).capture()).toEqual(payload);
    for(const field of ['controllers','control'] as const){
      const copy=structuredClone(payload),memory=field==='controllers'?copy.state.controllers.a!:copy.state.control.a!.memory;
      memory.explorerId=Object.values(copy.state.entities).find(entity=>entity.ownerId==='b'&&entity.typeId==='villager')!.id;expect(validateSimulationSavePayload(copy)).toBe(false);
      memory.explorerId='';expect(validateSimulationSavePayload(copy)).toBe(false);
      memory.explorerId='removed_worker';valid(copy);
    }
  });
  it('validates incomplete and finished endpoint bridges, cold-restores their progress and rejects invalid parent or route chains',()=>{
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,from={xMm:117691,zMm:197588},target={xMm:120850,zMm:190000};
    const obstacles=[...Array.from({length:6},(_,index)=>({id:`berry_${index}`,xMm:114000+index%3*2200,zMm:196500+Math.floor(index/3)*2200,halfWidth:650,halfHeight:650})),{id:'proposed_house',xMm:118000,zMm:190000,halfWidth:2000,halfHeight:2000}],nav=new Navigation(payload.state.widthMm,payload.state.heightMm,obstacles),scheduler=new PathScheduler(()=>nav,['a','b']);
    scheduler.request({id:'bridge_save',unitId:worker.id,orderRevision:0,profile:'a',from,target,radiusMm:350});
    for(let index=0;index<100;index++){scheduler.advance(2);if(scheduler.exportState().tasks[0]!.startBridge?.cursor)break;}
    payload.runtime.pathScheduler=scheduler.exportState();expect(payload.runtime.pathScheduler.tasks[0]!.startBridge!.cursor).toBeGreaterThan(0);payload.runtime.planningProfiles.find(([profile])=>profile==='a')![1]={revision:1,obstacles:obstacles.map((obstacle,index)=>[`${obstacle.id}:${index}`,obstacle])};valid(payload);
    const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true});expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(payload));
    for(const mutate of [
      (value:SimulationSavePayload)=>{const bridge=value.runtime.pathScheduler.tasks[0]!.startBridge!;bridge.parents[String(bridge.queue[0])]=bridge.queue[0]!;},
      (value:SimulationSavePayload)=>{const bridge=value.runtime.pathScheduler.tasks[0]!.startBridge!;bridge.cursor=bridge.queue.length+1;},
      (value:SimulationSavePayload)=>{const bridge=value.runtime.pathScheduler.tasks[0]!.startBridge!;bridge.queue.push(bridge.queue[0]!);},
      (value:SimulationSavePayload)=>{value.runtime.pathScheduler.tasks[0]!.startBridge!.cells.push(1);},
    ]){const corrupted=structuredClone(payload);mutate(corrupted);expect(validateSimulationSavePayload(corrupted)).toBe(false);}
    const cold=new PathScheduler(()=>nav,['a','b']);cold.importState(restored.capture().runtime.pathScheduler);
    for(let index=0;index<40;index++){expect(cold.advance(512)).toEqual(scheduler.advance(512));expect(JSON.stringify(cold.exportState())).toBe(JSON.stringify(scheduler.exportState()));payload.runtime.pathScheduler=scheduler.exportState();valid(payload);if(payload.runtime.pathScheduler.tasks[0]!.result)break;}
    expect(payload.runtime.pathScheduler.tasks[0]!.result?.status).toBe('ready');expect(payload.runtime.pathScheduler.tasks[0]!.startRoutes?.length).toBeGreaterThan(0);
    const corrupt=structuredClone(payload);corrupt.runtime.pathScheduler.tasks[0]!.startRoutes![0]!.points.at(-1)!.xMm++;expect(validateSimulationSavePayload(corrupt)).toBe(false);
  });
  it('validates and cold-restores an active shared frontier and rejects corrupted member and dependency authority',()=>{
    const payload=structuredClone(initial),workers=Object.values(payload.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'),obstacles=[{id:'shared_barrier',xMm:32000,zMm:23000,halfWidth:400,halfHeight:23000}],nav=new Navigation(payload.state.widthMm,payload.state.heightMm,obstacles),scheduler=new PathScheduler(()=>nav,['a','b']);
    for(let index=0;index<3;index++)scheduler.request({id:`shared_${index}`,unitId:workers[index]!.id,orderRevision:0,profile:'a',from:{xMm:8000+index*1000,zMm:8000},target:{xMm:56000,zMm:52000},radiusMm:350,workClass:index===0?'interactive':'routine',enqueuedTick:0});
    for(let tick=1;tick<180;tick++){scheduler.advance(256,tick);if(scheduler.exportState().sharedJobs!.registry.jobs.length)break;}
    payload.runtime.pathScheduler=scheduler.exportState();expect(payload.runtime.pathScheduler.sharedJobs!.registry.jobs.length).toBeGreaterThan(0);payload.state.tick=payload.runtime.pathScheduler.priority!.tick;payload.runtime.planningProfiles.find(([profile])=>profile==='a')![1]={revision:1,obstacles:obstacles.map((obstacle,index)=>[`${obstacle.id}:${index}`,obstacle])};valid(payload);
    const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(sealSimulationCapture(payload,identity),identity,{preserveEpoch:true});expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(payload));
    const cold=new PathScheduler(()=>nav,['a','b']);cold.importState(restored.capture().runtime.pathScheduler);for(let tick=payload.state.tick+1;tick<payload.state.tick+12;tick++){expect(cold.advance(256,tick)).toEqual(scheduler.advance(256,tick));expect(JSON.stringify(cold.exportState())).toBe(JSON.stringify(scheduler.exportState()));}
    for(const mutate of [
      (value:SimulationSavePayload)=>{value.runtime.pathScheduler.sharedJobs!.registry.jobs[0]!.members[0]!.request.orderRevision++;},
      (value:SimulationSavePayload)=>{value.runtime.pathScheduler.sharedJobs!.registry.jobs[0]!.dependencies=[];},
      (value:SimulationSavePayload)=>{value.runtime.pathScheduler.sharedJobs!.registry.jobs[0]!.frontier.profile='b';},
      (value:SimulationSavePayload)=>{const frontier=value.runtime.pathScheduler.sharedJobs!.registry.jobs[0]!.frontier;const key=Object.keys(frontier.coarse.scores)[0]!;frontier.coarse.parents[key]=key;},
      (value:SimulationSavePayload)=>{value.runtime.pathScheduler.sharedJobs!.registry.jobs[0]!.members[0]!.request.enqueuedTick=value.state.tick+1;},
    ]){const corrupted=structuredClone(payload);mutate(corrupted);expect(validateSimulationSavePayload(corrupted)).toBe(false);}
  });
  it('accepts legacy idle workers and bounded resource search state but rejects invalid cursors and purposes',()=>{
    const value=structuredClone(initial),worker=Object.values(value.state.entities).find((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'&&e.ownerId==='a')!;
    delete worker.autoGather;valid(value);worker.autoGather=false;valid(value);worker.autoGather=true;worker.resourceSearch={purpose:'idle',targetIds:['remembered_resource'],index:0};valid(value);
    worker.resourceSearch.index=2;expect(validateSimulationSavePayload(value)).toBe(false);worker.resourceSearch.index=0;worker.resourceSearch.targetIds.push('remembered_resource');expect(validateSimulationSavePayload(value)).toBe(false);
    worker.resourceSearch.targetIds=['remembered_resource'];worker.resourceSearch.purpose='depleted';expect(validateSimulationSavePayload(value)).toBe(false);worker.orders=[{kind:'gather',targetId:'depleted_resource',phase:'gather'}];valid(value);
    worker.resourceSearch.purpose='idle';expect(validateSimulationSavePayload(value)).toBe(false);
  });
  it('accepts legacy local retries and both search resolutions while rejecting invented phases',()=>{
    const value=structuredClone(initial),unit=Object.values(value.state.entities).find((e):e is Unit=>e.kind==='unit'&&e.ownerId==='a')!;
    const local=value.runtime.localAvoidance.find(([id])=>id==='a')![1];
    local.routes=[[unit.id,{target:{xMm:unit.xMm,zMm:unit.zMm},points:[],retryTick:10}]];
    valid(value);
    for(const nextSearchCellMm of [250,1000] as const){local.routes[0]![1].nextSearchCellMm=nextSearchCellMm;valid(value);}
    for(const invalid of [0,500,2048,'250',null]){const copy=structuredClone(value);(copy.runtime.localAvoidance.find(([id])=>id==='a')![1].routes[0]![1] as any).nextSearchCellMm=invalid;expect(validateSimulationSavePayload(copy)).toBe(false);}
  });
  it('accepts a complete real initial capture and retains its insertion order without mutation',()=>{const value=structuredClone(initial),text=JSON.stringify(value);valid(value);expect(JSON.stringify(value)).toBe(text);});
  it.each([
    ['unknown outer field',(value:any)=>{value.modelKey='forbidden';}],
    ['missing resolved default',(value:any)=>{delete value.options.sharedVision;}],
    ['missing map size',(value:any)=>{delete value.options.mapSize;}],
    ['private legacy cache duplicate',(value:any)=>{value.state.navigation=value.runtime.pathScheduler;}],
    ['missing faction economy',(value:any)=>{delete value.state.economies.b;}],
    ['foreign faction economy',(value:any)=>{value.state.economies.c=value.state.economies.b;}],
    ['repeated runtime profile',(value:any)=>{value.runtime.planningProfiles[1]=value.runtime.planningProfiles[0];}],
    ['missing empty helper',(value:any)=>{value.runtime.localAvoidance.pop();}],
    ['unknown nested option',(value:any)=>{value.runtime.localAvoidance[0][1].ignoreEnemies=true;}],
    ['bad content hash',(value:any)=>{value.contentHash='0'.repeat(64);}],
    ['seed mismatch',(value:any)=>{value.options.seed='different';}],
    ['nonfinite state',(value:any)=>{value.state.tick=Infinity;}],
    ['negative ledger balance',(value:any)=>{value.state.economies.a.resources.wood=-1;}],
    ['unknown research',(value:any)=>{value.state.economies.a.technologies=['free_resources'];}],
    ['repeated research',(value:any)=>{value.state.economies.a.technologies=['forestry_1','forestry_1'];value.state.economies.a.researchRevision=2;}],
    ['missing controller memory',(value:any)=>{delete value.state.control.a.memory.pending;}],
    ['model authority on a human slot',(value:any)=>{value.state.controllers.a.mode='model';}],
    ['unknown owner',(value:any)=>{Object.values<any>(value.state.entities).find(entity=>entity.kind==='unit').ownerId='foreign';}],
    ['unknown unit ID',(value:any)=>{Object.values<any>(value.state.entities).find(entity=>entity.kind==='unit').typeId='future_tank';}],
    ['mismatched entity dictionary key',(value:any)=>{Object.values<any>(value.state.entities)[0].id='replacement';}],
    ['duplicate explored cell',(value:any)=>{value.state.vision.a.explored=[1,1];}],
    ['visible unexplored cell',(value:any)=>{value.state.vision.a.explored=[];value.state.vision.a.visible=[1];}],
    ['mutable unit fog memory',(value:any)=>{value.state.vision.a.memory.secret={id:'secret',ownerId:'b',kind:'unit',typeId:'scout',hp:45,maxHp:45,xMm:10000,zMm:10000};}],
    ['private queues in enemy fog memory',(value:any)=>{value.state.vision.a.memory.secret={id:'secret',ownerId:'b',kind:'building',typeId:'house',hp:600,maxHp:600,xMm:10000,zMm:10000,queue:[]};}],
    ['admission accounting mismatch',(value:any)=>{value.state.pathAdmission.a.remaining--;}],
    ['unknown save format',(value:any)=>{value.schemaVersion=2;}],
  ])('rejects %s',(_name,mutate)=>{const value=structuredClone(initial);mutate(value);expect(validateSimulationSavePayload(value)).toBe(false);});
  it('rejects prototype keys and accessors without executing them',()=>{
    const value=structuredClone(initial);Object.defineProperty(value.state.economies,'__proto__',{value:{},enumerable:true});expect(validateSimulationSavePayload(value)).toBe(false);
    let called=false;const another=structuredClone(initial);Object.defineProperty(another.options,'seed',{get(){called=true;return 'save-validation';},enumerable:true});expect(validateSimulationSavePayload(another)).toBe(false);expect(called).toBe(false);
  });
  it('accepts legitimately stale target references awaiting the next simulation cleanup',()=>{
    const value=structuredClone(initial),worker=Object.values(value.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    worker.orders=[{kind:'gather',targetId:'destroyed_unseen',lastKnown:{xMm:10000,zMm:10000}}];worker.lastAttackerId='already_dead';valid(value);
  });
  it('validates interrupted search heaps, FIFO cursors, and region floods at successive work boundaries',()=>{
    const payload=structuredClone(initial),worker=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    const nav=new Navigation(payload.state.widthMm,payload.state.heightMm,[{id:'barrier',xMm:30000,zMm:20000,halfWidth:1000,halfHeight:18000}]),scheduler=new PathScheduler(()=>nav,['a','b']);
    scheduler.request({id:'pending_path',unitId:worker.id,orderRevision:0,profile:'a',from:{xMm:10000,zMm:10000},target:{xMm:50000,zMm:10000},radiusMm:350});
    for(const work of [1,80,500,1500,4000]){scheduler.advance(work);payload.runtime.pathScheduler=scheduler.exportState();valid(payload);}
    const corrupted=structuredClone(payload),search=corrupted.runtime.pathScheduler.tasks[0]!.coarse!;search.scores['0,0,0']=0;search.scores['0,0,1']=1;search.parents['0,0,0']='0,0,1';search.parents['0,0,1']='0,0,0';expect(validateSimulationSavePayload(corrupted)).toBe(false);
    const duplicate=structuredClone(payload);duplicate.runtime.pathScheduler.tasks.push(structuredClone(duplicate.runtime.pathScheduler.tasks[0]!));expect(validateSimulationSavePayload(duplicate)).toBe(false);
    const missing=structuredClone(payload);delete missing.runtime.pathScheduler.tasks[0]!.endComponents;expect(validateSimulationSavePayload(missing)).toBe(false);
    const malformedCursor=structuredClone(payload);malformedCursor.runtime.pathScheduler.tasks[0]!.currentComponent='not_a_component';malformedCursor.runtime.pathScheduler.tasks[0]!.edgeCursor=0;expect(validateSimulationSavePayload(malformedCursor)).toBe(false);
  });
  it('uses a host save budget large enough for more than a million bounded path-cache labels',()=>{
    const value=structuredClone(initial);value.state.widthMm=value.state.heightMm=640000;value.options.mapSize='large';
    value.runtime.pathScheduler.regions=Array.from({length:4000},(_,index)=>{const radiusMm=[350,550,850][Math.floor(index/1600)]!,cell=index%1600,x=cell%40,z=Math.floor(cell/40);return {key:`a:${radiusMm}:${x},${z}`,profile:'a',radiusMm,x,z,labels:Array<number>(256).fill(0),cursor:256,frontier:[],frontierCursor:0,label:0,complete:true};});
    valid(value);
  });
  it('persists one failed end-join decision and rejects false flags or flags outside fine completion state',()=>{
    const payload=structuredClone(initial),workers=Object.values(payload.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a');
    const nav=new Navigation(payload.state.widthMm,payload.state.heightMm,[{id:'wall',xMm:32000,zMm:24000,halfWidth:1000,halfHeight:18000},{id:'join_post',xMm:16000,zMm:24000,halfWidth:150,halfHeight:1500}]),scheduler=new PathScheduler(()=>nav,['a','b']);
    const waiting={id:'saved_join',unitId:workers[0]!.id,orderRevision:0,profile:'a',from:{xMm:8000,zMm:24000},target:{xMm:56000,zMm:24000},radiusMm:350},source={...waiting,id:'saved_native',unitId:workers[1]!.id,from:{xMm:24000,zMm:24000},target:{xMm:55500,zMm:24000}};
    scheduler.request(waiting);scheduler.request(source);const tasks=(scheduler as unknown as {tasks:Map<string,typeof payload.runtime.pathScheduler.tasks[number]>}).tasks;
    for(let work=0;work<128000&&!tasks.get(waiting.unitId)?.endJoinChecked;work+=16)scheduler.advance(16);
    payload.runtime.pathScheduler=scheduler.exportState();const checked=payload.runtime.pathScheduler.tasks.find(task=>task.unitId===waiting.unitId)!;expect(checked.endJoinChecked).toBe(true);expect(checked.stage).toBe('fine');expect(checked.lateCacheChecked).toBeUndefined();valid(payload);
    const restored=new PathScheduler(()=>nav,['a','b']);restored.importState(JSON.parse(JSON.stringify(payload.runtime.pathScheduler)));for(let i=0;i<5;i++){expect(restored.advance(31)).toEqual(scheduler.advance(31));expect(restored.exportState()).toEqual(scheduler.exportState());}
    for(const mutate of [
      (task:any)=>{task.endJoinChecked=false;},(task:any)=>{task.endJoinChecked=1;},
      (task:any)=>{task.stage='direct';},(task:any)=>{task.stage='coarse';},
      (task:any)=>{delete task.fine;},(task:any)=>{delete task.cacheKey;},
    ]){const corrupted=structuredClone(payload);mutate(corrupted.runtime.pathScheduler.tasks.find(task=>task.unitId===waiting.unitId));expect(validateSimulationSavePayload(corrupted)).toBe(false);}
    for(let work=0;work<128000&&tasks.get(waiting.unitId)?.stage!=='done';work+=128)scheduler.advance(128);
    payload.runtime.pathScheduler=scheduler.exportState();expect(payload.runtime.pathScheduler.tasks.find(task=>task.unitId===waiting.unitId)?.stage).toBe('done');valid(payload);
  });
  it('restores a native suffix join before and after its complete proved result without adding saved selector state',()=>{
    const payload=structuredClone(initial),workers=Object.values(payload.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'),nav=new Navigation(payload.state.widthMm,payload.state.heightMm,[{id:'north_wall',xMm:32000,zMm:21000,halfWidth:1000,halfHeight:21000}]);
    const source={id:'saved_suffix_native',unitId:workers[0]!.id,orderRevision:0,profile:'a',from:{xMm:8000,zMm:24000},target:{xMm:56000,zMm:24000},radiusMm:350},waiting={...source,id:'saved_suffix',unitId:workers[1]!.id,from:{xMm:8000,zMm:60000}},native=new PathScheduler(()=>nav,['a','b']);native.request(source);
    const nativeRoutes=(native as unknown as {routes:Map<string,unknown>}).routes;for(let work=0;work<128000&&!nativeRoutes.size;work+=128)native.advance(128);
    const routes=native.exportState().routes;expect(routes).toHaveLength(1);expect(Math.hypot(routes[0]![1].points[0]!.xMm-waiting.from.xMm,routes[0]![1].points[0]!.zMm-waiting.from.zMm)).toBeGreaterThan(32000);
    const scheduler=new PathScheduler(()=>nav,['a','b']);scheduler.request(waiting);const tasks=(scheduler as unknown as {tasks:Map<string,typeof payload.runtime.pathScheduler.tasks[number]>}).tasks;
    for(let work=0;work<128000&&tasks.get(waiting.unitId)?.stage!=='fine';work++)scheduler.advance(2);
    const pending=scheduler.exportState();expect(pending.tasks[0]!.stage).toBe('fine');pending.routes=routes;scheduler.importState(pending);payload.runtime.pathScheduler=scheduler.exportState();valid(payload);
    const resumed=new PathScheduler(()=>nav,['a','b']);resumed.importState(JSON.parse(JSON.stringify(payload.runtime.pathScheduler)));expect(resumed.advance(2)).toEqual(scheduler.advance(2));expect(resumed.exportState()).toEqual(scheduler.exportState());
    payload.runtime.pathScheduler=scheduler.exportState();const completed=payload.runtime.pathScheduler.tasks[0]!;expect(completed.stage).toBe('done');expect(completed.endJoinChecked).toBe(true);expect(completed.lateCacheChecked).toBeUndefined();valid(payload);
    const restoredReady=new PathScheduler(()=>nav,['a','b']);restoredReady.importState(JSON.parse(JSON.stringify(payload.runtime.pathScheduler)));const result=scheduler.take(waiting.unitId,0);expect(restoredReady.take(waiting.unitId,0)).toEqual(result);expect(result?.status).toBe('ready');if(result?.status!=='ready')throw Error('MISSING_SAVED_SUFFIX');
    const startIndex=routes[0]![1].points.findIndex(point=>point.xMm===result.points[0]!.xMm&&point.zMm===result.points[0]!.zMm);expect(startIndex).toBeGreaterThan(0);expect(startIndex).toBeLessThan(8);expect(result.points).toEqual([...routes[0]![1].points.slice(startIndex),waiting.target]);
    let prior=waiting.from;for(const point of result.points){expect(nav.clearLine(prior,point,350)).toBe(true);prior=point;}expect(scheduler.exportState().routes).toEqual(routes);
  });
});

describe('strict replay journal records',()=>{
  it.each(['controller_memory','commander_memory','commander_patch','caretaker_memory'] as const)('validates exploration recovery memory before applying %s',kind=>{
    const identity:EngineIdentity={engineBuildHash:'b'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},simulation=restoreSimulation(sealSimulationCapture(structuredClone(initial),identity),identity,{preserveEpoch:true});
    simulation.enableReplay(()=>undefined);
    const own=Object.values(initial.state.entities).find(entity=>entity.ownerId==='a'&&entity.typeId==='villager')!,foreign=Object.values(initial.state.entities).find(entity=>entity.ownerId==='b'&&entity.typeId==='villager')!,scout=Object.values(initial.state.entities).find(entity=>entity.ownerId==='a'&&entity.typeId==='scout')!;
    const memory={...structuredClone(initial.state.controllers.a!),explorerId:own.id,scoutRoute:{target:{xMm:1000,zMm:1000},issuedTick:0}};
    const event=(candidate:typeof memory):JournalEvent=>{
      const base={ordinal:simulation.state.eventOrdinal+1,tick:simulation.state.tick,phase:'boundary' as const,playerId:'a'};
      if(kind==='commander_patch')return {...base,kind,patches:[{path:[],value:candidate}]};
      if(kind==='caretaker_memory')return {...base,kind,memory:{...structuredClone(initial.state.control.a!.memory),explorerId:candidate.explorerId,scoutRoute:candidate.scoutRoute}};
      return {...base,kind,memory:candidate};
    };
    const before=simulation.capture();
    for(const candidate of [
      {...memory,explorerId:foreign.id}, {...memory,explorerId:scout.id},
      {...memory,scoutRoute:{...memory.scoutRoute,issuedTick:1}},
      {...memory,scoutRoute:{...memory.scoutRoute,target:{xMm:simulation.state.widthMm+1,zMm:1000}}},
      {...memory,scoutRoute:{...memory.scoutRoute,target:{xMm:1000,zMm:simulation.state.heightMm+1}}},
    ]){
      if(candidate.scoutRoute.issuedTick>0){expect(validateCommanderMemory(candidate,'a',0)).toBe(false);if(kind!=='commander_patch')expect(validateJournalEvent(event(candidate))).toBe(false);}
      expect(()=>simulation.applyJournalEvent(event(candidate))).toThrow(kind==='caretaker_memory'?'INVALID_CARETAKER_MEMORY':'INVALID_COMMANDER_PATCH');
      expect(simulation.capture()).toEqual(before);
    }
    expect(validateJournalEvent(event(memory))).toBe(true);expect(()=>simulation.applyJournalEvent(event(memory))).not.toThrow();
    const restored=kind==='caretaker_memory'?simulation.state.control.a!.memory:simulation.state.controllers.a!;
    expect(restored).toMatchObject({explorerId:own.id,scoutRoute:memory.scoutRoute});
    // Removed explorers are legitimate between a unit death and the next policy pulse.
    expect(()=>simulation.applyJournalEvent(event({...memory,explorerId:'removed_worker'}))).not.toThrow();
  });
  it('bounds compact commander patches and validates the complete detached result',()=>{
    const event={ordinal:1,tick:0,phase:'controllers',kind:'commander_patch',playerId:'a',patches:[{path:['nextStrategicTick'],value:20}]};
    expect(validateJournalEvent(event)).toBe(true);
    expect(validateJournalEvent({...event,patches:[{path:[],value:initial.state.controllers.a}]})).toBe(true);
    for(const patches of [[],Array.from({length:257},()=>event.patches[0]),[{path:['constructor'],value:1}],[{path:['memory','__proto__'],value:1}],[{path:Array(13).fill('memory'),value:1}],[{path:[-1],value:1}],[{path:['mode'],value:undefined}],[{path:['reason'],value:Infinity}],[{path:['reason'],value:'雪'.repeat(90000)}]])expect(validateJournalEvent({...event,patches})).toBe(false);
    const memory=structuredClone(initial.state.controllers.a!);expect(validateCommanderMemory(memory,'a',0)).toBe(true);expect(validateCommanderMemory(memory,'b',0)).toBe(false);
    expect(validateCommanderMemory({...memory,mode:'invented'},'a',0)).toBe(false);
    memory.memory.facts=[{id:'claim',tick:0,expiresTick:20,kind:'ally_request',provenance:'human_claim',confidence:'observed',sourcePlayerId:'b',text:'Invented verification'}];expect(validateCommanderMemory(memory,'a',0)).toBe(false);
  });
  it('validates every supported event kind without storing malformed submitted command data',()=>{
    const base={ordinal:1,tick:0,phase:'boundary' as const},receipt={status:'rejected' as const,clientCommandId:'request',code:'INVALID_REFERENCE',tick:0,sequence:1};
    const events=[{...base,kind:'command',playerId:'a',envelope:{protocolVersion:2,matchId:'strict_save',matchEpoch:1,clientCommandId:'request',clientSequence:1,command:{kind:'stop',unitIds:['missing']}},receipt,source:'human'},
      {...base,kind:'invalid_command',playerId:'a',receipt}, {...base,kind:'status',status:'PAUSED'}, {...base,kind:'epoch',epoch:2}, {...base,kind:'draw'}, {...base,kind:'admin_surrender',playerId:'a'},
      {...base,kind:'controller_memory',playerId:'a',memory:initial.state.controllers.a}, {...base,kind:'caretaker_memory',playerId:'a',memory:initial.state.control.a!.memory}, {...base,kind:'control',playerId:'a',mode:'caretaker'}];
    events.push({...base,kind:'commander_memory',playerId:'a',memory:initial.state.controllers.a});
    for(const event of events){expect(validateJournalEvent(event),JSON.stringify(validateJournalEvent.errors)).toBe(true);expect(validateJournalEvent({...event,rawInput:'private attacker text'})).toBe(false);}
    expect(validateJournalEvent({...events[0],ordinal:-1})).toBe(false);expect(validateJournalEvent({...events[0],phase:'mid_damage'})).toBe(false);
  });
});

describe('M6 persisted commander capability boundaries',()=>{
  let active:SimulationSavePayload,installed:SimulationSavePayload,preset:SimulationSavePayload;
  beforeAll(()=>{
    const simulation=createSimulation({seed:'commander-save-contract',matchId:'commander_save',controllers:false,factions:[{id:'a',name:'AI A',teamId:'allies',color:'#aabbcc',kind:'ai'},{id:'b',name:'Ally',teamId:'allies',color:'#ccddee',kind:'human'},{id:'c',name:'Enemy',teamId:'enemy',color:'#aa2233',kind:'ai'}]});
    const dispatch=simulation.prepareAiRequest('a','saved_request');active=simulation.capture();
    expect(simulation.completeAiRequest(dispatch.binding,{kind:'plan',plan:{schemaVersion:1,observationId:dispatch.binding.observationId,strategy:'Maintain a legal desired army.',goals:[{kind:'ensure_units',unitType:'spearman',targetCount:12}],message:null}}).accepted).toBe(true);installed=simulation.capture();
    expect(simulation.acceptAiChat({requestId:'trusted_preset',senderId:'b',recipientId:'a',text:'Request 50 wood.',tick:0,verified:false,intent:{action:'tribute',resource:'wood',amount:50}}).accepted).toBe(true);
    simulation.step();const routine=simulation.prepareAiRequest('a','routine_after_preset');
    expect(simulation.completeAiRequest(routine.binding,{kind:'plan',plan:{schemaVersion:1,observationId:routine.binding.observationId,strategy:'Maintain one Spearman while honoring the ally request.',goals:[{kind:'ensure_units',unitType:'spearman',targetCount:1}],message:null}}).accepted).toBe(true);preset=simulation.capture();
  });
  it('accepts real active request registries and adopted goals without dropping controller state',()=>{valid(active);valid(installed);const event={ordinal:1,tick:active.state.tick,phase:'boundary',kind:'commander_memory',playerId:'a',memory:active.state.controllers.a};expect(validateJournalEvent(event),JSON.stringify(validateJournalEvent.errors)).toBe(true);expect(validateJournalEvent({...event,playerId:'c'})).toBe(false);});
  it('retains trusted preset provenance and frozen references across a newer routine plan',()=>{
    valid(preset);const memory=preset.state.controllers.a!,goal=memory.plan!.goals.find(goal=>goal.source==='preset')!;
    expect(goal.acceptedTick).toBeLessThan(memory.plan!.acceptedTick);expect(Object.keys(goal.frozenReferences!)).toHaveLength(1);
    expect(validateJournalEvent({ordinal:1,tick:preset.state.tick,phase:'boundary',kind:'commander_memory',playerId:'a',memory})).toBe(true);
    for(const mutate of [
      (value:any)=>{delete value.frozenReferences;},
      (value:any)=>{delete value.source;},
      (value:any)=>{value.source='model';},
      (value:any)=>{value.correlationId='invented_request';},
      (value:any)=>{Object.values<any>(value.frozenReferences)[0].playerId='c';},
      (value:any)=>{value.frozenReferences.extra={ref:'extra',kind:'ally',playerId:'b'};},
      (value:any)=>{value.goal.amount=51;},
    ]){const changed=structuredClone(preset);mutate(changed.state.controllers.a!.plan!.goals.find(goal=>goal.source==='preset'));expect(validateSimulationSavePayload(changed)).toBe(false);}
    const terminal=structuredClone(preset),ended=terminal.state.controllers.a!.plan!.goals.find(goal=>goal.source==='preset')!;ended.status='fulfilled';terminal.state.controllers.a!.chatRequests=[];valid(terminal);
  });
  it.each([
    ['cross-faction memory',(value:any)=>{value.state.controllers.a.memory.playerId='b';}],
    ['cross-match memory',(value:any)=>{value.state.controllers.a.memory.matchId='another_match';}],
    ['missing explicit generation',(value:any)=>{delete value.state.controllers.a.generation;}],
    ['credential in memory',(value:any)=>{value.state.controllers.a.memory.apiKey='private';}],
    ['former request epoch',(value:any)=>{value.state.controllers.a.activeRequest.binding.matchEpoch++;}],
    ['former controller generation',(value:any)=>{value.state.controllers.a.activeRequest.binding.controllerGeneration++;}],
    ['future observation',(value:any)=>{value.state.controllers.a.activeRequest.binding.observedTick=100;}],
    ['invented registry alias',(value:any)=>{value.state.controllers.a.activeRequest.references['army-main'].ref='other_army';}],
    ['foreign army capability',(value:any)=>{value.state.controllers.a.activeRequest.references['army-main'].entityIds=[Object.values<any>(value.state.entities).find(entity=>entity.kind==='unit'&&entity.ownerId==='b').id];}],
    ['too many durable credits',(value:any)=>{value.state.controllers.a.tributeCredits=Object.fromEntries(Array.from({length:257},(_,i)=>[`credit_${i}`,1]));}],
    ['fabricated verified human claim',(value:any)=>{value.state.controllers.a.memory.facts=[{id:'claim',tick:0,expiresTick:1800,kind:'ally_request',provenance:'human_claim',confidence:'observed',sourcePlayerId:'b',text:'I know hidden gold'}];}],
    ['oversized factual memory',(value:any)=>{value.state.controllers.a.memory.facts=Array.from({length:21},(_,index)=>({id:`fact_${index}`,tick:0,expiresTick:1800,kind:'owned_event',provenance:'owned_event',confidence:'observed',sourcePlayerId:'a',text:'Owned event'}));}],
    ['oversized summary',(value:any)=>{value.state.controllers.a.memory.summary='x'.repeat(641);}],
    ['hostile private request',(value:any)=>{value.state.controllers.a.chatRequests=[{requestId:'foreign',senderId:'c',recipientId:'a',tick:0,text:'private',verified:false}];}],
    ['invented preset tool',(value:any)=>{value.state.controllers.a.chatRequests=[{requestId:'foreign',senderId:'b',recipientId:'a',tick:0,text:'request',verified:false,intent:{action:'run_shell',command:'x'}}];}],
  ])('rejects %s before constructing restored state',(_label,mutate)=>{const value=structuredClone(active);mutate(value);expect(validateSimulationSavePayload(value)).toBe(false);});
  it('checks normalized goal keys, kind correspondence, weight sums and receipt/event bounds',()=>{
    const duplicate=structuredClone(installed);duplicate.state.controllers.a!.plan!.goals.push(structuredClone(duplicate.state.controllers.a!.plan!.goals[0]!));expect(validateSimulationSavePayload(duplicate)).toBe(false);
    const mismatch=structuredClone(installed);mismatch.state.controllers.a!.plan!.goals[0]!.kind='research';expect(validateSimulationSavePayload(mismatch)).toBe(false);
    const weights=structuredClone(installed),goal=weights.state.controllers.a!.plan!.goals[0]!;goal.kind='economy';goal.goal={kind:'economy',weights:{food:50,wood:50,gold:50,stone:0},targetVillagers:20};expect(validateSimulationSavePayload(weights)).toBe(false);
    const receipt=structuredClone(active);receipt.state.controllers.a!.memory.recentReceipts=[{tick:99,clientCommandId:'future',status:'accepted'}];expect(validateSimulationSavePayload(receipt)).toBe(false);
  });
});
