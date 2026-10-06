import { afterEach,describe,expect,it,vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { immutableVisionGroup,immutableVisionSource,VisionMaskKernel,type VisionMaskFrame } from '../../../packages/simulation/src/vision-mask-kernel.js';
import { VisionWorkerPool,visionLaneIntervals,type VisionLaneTiming } from './vision-worker-pool.js';
import type { VisionWorkerRequest,VisionWorkerResponse } from './vision-worker-protocol.js';

const pools:VisionWorkerPool[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.close()));});
const pool=(size=2,timeoutMs=15000,performanceDiagnostics=false)=>{const result=new VisionWorkerPool({size,timeoutMs,performanceDiagnostics});pools.push(result);return result;};
const binding={matchId:'vision-match',matchEpoch:3,tick:19,phase:'pre-combat'};
function fixture():VisionMaskFrame {
  return {width:60,height:45,gridMm:1000,cacheKey:'map',blockerRevision:0,blockers:[{id:'cliff',xMm:22000,zMm:15000,halfWidth:1000,halfHeight:12000}],
    groups:Array.from({length:11},(_,group)=>({key:`player:${group}`,sources:Array.from({length:12},(_,index)=>({id:`${group}-${index}`,xMm:(group*3817+index*11939)%60000,zMm:(group*7919+index*731)%45000,radius:5000+index*300}))}))};
}
function smallFixture():VisionMaskFrame {
  return {width:16,height:12,gridMm:1000,cacheKey:'small',blockerRevision:0,blockers:[],groups:[
    {key:'allies-a',sources:[{id:'a',xMm:3500,zMm:4500,radius:2000}]},
    {key:'allies-b',sources:[{id:'b',xMm:11500,zMm:7500,radius:2000}]},
  ]};
}
function lanes(value:VisionWorkerPool):{worker:Worker;generation:number;pending?:{batch:number;generation:number}}[]{
  return (value as unknown as {lanes:{worker:Worker;generation:number;pending?:{batch:number;generation:number}}[]}).lanes;
}

describe('persistent parallel vision workers',()=>{
  it('retains native building coverage through worker deltas and invalidates a removed covering source',async()=>{
    const threads=pool(1,15000,true),town=immutableVisionSource('town',12000,12000,9000,'building');
    let frame:VisionMaskFrame={width:32,height:24,gridMm:1000,cacheKey:'worker-coverage',blockerRevision:0,blockers:[],groups:[immutableVisionGroup('owner',[town,immutableVisionSource('unit',12000,12000,2500,'unit')])]};
    expect(await threads.compute(frame,binding)).toEqual(new VisionMaskKernel().compute(structuredClone(frame)));
    let timings=threads.diagnostics().timing!.recentLanes;
    expect(timings.at(-1)!.worker!.kernelWork).toMatchObject({coveredSources:1,rasterizedSources:1});
    frame={...frame,groups:[immutableVisionGroup('owner',[town,immutableVisionSource('unit',12500,12000,2500,'unit')])]};
    expect(await threads.compute(frame,{...binding,tick:20})).toEqual(new VisionMaskKernel().compute(structuredClone(frame)));
    timings=threads.diagnostics().timing!.recentLanes;expect(timings.at(-1)!.worker!.kernelWork).toMatchObject({coveredSources:1,rasterizedSources:0});
    frame={...frame,groups:[immutableVisionGroup('owner',[frame.groups[0]!.sources[1]!])]};
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(new VisionMaskKernel().compute(structuredClone(frame)));
    timings=threads.diagnostics().timing!.recentLanes;expect(timings.at(-1)!.worker!.kernelWork).toMatchObject({coveredSources:0,rasterizedSources:1});
  });
  it('runs distinct actual threads and produces the same ordered full phase as one thread and inline execution',async()=>{
    const frame=fixture(),one=pool(1),two=pool(2),expected=new VisionMaskKernel().compute(frame);
    expect(await one.compute(frame,binding)).toEqual(expected);expect(await two.compute(frame,binding)).toEqual(expected);
    const ids=two.diagnostics().threadIds;expect(ids.every(id=>id>0)).toBe(true);expect(new Set(ids).size).toBe(2);
    const changed=structuredClone(frame);changed.groups=changed.groups.slice().reverse();
    expect(await two.compute(changed,{...binding,tick:20})).toEqual(new VisionMaskKernel().compute(changed));
    expect(two.diagnostics().threadIds).toEqual(ids);
  });
  it('retains terrain per worker until its bound revision changes',async()=>{
    const frame=fixture(),threads=pool();await threads.compute(frame,binding);expect(threads.diagnostics().geometryTransfers).toBe(2);
    await threads.compute(frame,{...binding,tick:20});expect(threads.diagnostics().geometryTransfers).toBe(2);
    const changed={...frame,blockerRevision:1,blockers:[]};
    expect(await threads.compute(changed,{...binding,tick:21})).toEqual(new VisionMaskKernel().compute(changed));
    expect(threads.diagnostics().geometryTransfers).toBe(4);
  });
  it('ignores stale epochs and batch replies and forbids overlapping perception phases',async()=>{
    const threads=pool(),frame=fixture(),pending=threads.compute(frame,binding),lane=lanes(threads)[0]!;
    const batch=lane.pending!;
    lane.worker.emit('message',{type:'vision-result',generation:batch.generation,batch:batch.batch,binding:{...binding,matchEpoch:2},results:[]});
    lane.worker.emit('message',{type:'vision-result',generation:batch.generation,batch:batch.batch-1,binding,results:[]});
    await expect(threads.compute(frame,binding)).rejects.toThrow('VISION_PHASE_IN_PROGRESS');
    expect(await pending).toEqual(new VisionMaskKernel().compute(frame));expect(threads.diagnostics().staleReplies).toBe(2);
  });
  it('recovers the identical sealed phase after a worker exit and replaces its thread for the next phase',async()=>{
    const threads=pool(),frame=fixture(),expected=new VisionMaskKernel().compute(frame),pending=threads.compute(frame,binding),lane=lanes(threads)[0]!,priorId=lane.worker.threadId;
    // Mutation after dispatch cannot change recovery or the other worker's input.
    frame.groups[0]!.sources[0]!.xMm=999999;frame.groups[0]!.sources[0]!.id='mutated';
    frame.blockers[0]!.xMm=999999;frame.width=1;frame.groups=[];await lane.worker.terminate();
    expect(await pending).toEqual(expected);expect(threads.diagnostics().recovered).toBe(1);
    const next=fixture();expect(await threads.compute(next,{...binding,tick:20})).toEqual(expected);
    expect(threads.diagnostics().threadIds[0]).not.toBe(priorId);
  });
  it('uses exact inline recovery on timeout and rejects outstanding work on shutdown',async()=>{
    const threads=pool(2,1),frame=fixture();
    expect(await threads.compute(frame,binding)).toEqual(new VisionMaskKernel().compute(frame));expect(threads.diagnostics().recovered).toBeGreaterThan(0);
    const closing=pool(),pending=closing.compute(frame,binding),rejection=expect(pending).rejects.toThrow('VISION_POOL_CLOSED');
    await closing.close();await rejection;await expect(closing.compute(frame,binding)).rejects.toThrow('VISION_POOL_CLOSED');
  });
  it('uses exact local contact phases during the coarse-frame worker retry cooldown',async()=>{
    const threads=new VisionWorkerPool({size:1,timeoutMs:1,retryDelayMs:5000});pools.push(threads);
    const frame=smallFixture();lanes(threads)[0]!.worker.postMessage=()=>{};
    expect(await threads.compute(frame,binding)).toEqual(new VisionMaskKernel().compute(frame));
    for(let tick=20;tick<26;tick++){
      frame.groups[0]!.sources[0]!.xMm+=250;
      expect(await threads.compute(frame,{...binding,tick})).toEqual(new VisionMaskKernel().compute(frame));
    }
    expect(threads.diagnostics()).toMatchObject({recovered:1,recoveryPhasesInline:6,completed:7});
  });
  it('recovers two consecutive dropped perception phases within the live RPC deadline allowance',async()=>{
    const threads=pool(1,100),frame=fixture(),expected=new VisionMaskKernel().compute(frame);
    const owned=threads as unknown as {spawn():{worker:Worker}},spawn=owned.spawn.bind(owned);
    owned.spawn=()=>{const lane=spawn();lane.worker.postMessage=()=>{};return lane;};
    lanes(threads)[0]!.worker.postMessage=()=>{};
    const started=performance.now();
    for(const phase of ['vision','post-death-vision']){
      // Dropping an actual worker request exercises the timer rather than an
      // immediate worker exit; the same-tick fallback remains exact.
      expect(await threads.compute(frame,{...binding,tick:21,phase})).toEqual(expected);
    }
    expect(threads.diagnostics().recovered).toBe(2);expect(performance.now()-started).toBeLessThan(1500);
  });
  it('leaves ordinary payloads and coordinator diagnostic clock reads absent when timing is disabled',async()=>{
    const threads=pool(1),frame=fixture(),lane=lanes(threads)[0]!,requests:VisionWorkerRequest[]=[],responses:VisionWorkerResponse[]=[];
    const post=lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
    lane.worker.on('message',(response:VisionWorkerResponse)=>responses.push(response));
    const clock=vi.spyOn(process.hrtime,'bigint');
    let calls:number;
    try{await threads.compute(frame,binding);calls=clock.mock.calls.length;}finally{clock.mockRestore();}
    expect(calls!).toBe(0);expect(requests).toHaveLength(1);expect(responses).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty('diagnosticTiming');expect(responses[0]).not.toHaveProperty('diagnosticTiming');
    expect(threads.diagnostics()).not.toHaveProperty('timing');
  });
  it('records phase-bound actual worker wall intervals without changing ordered visibility',async()=>{
    const threads=pool(2,15000,true),frame=fixture(),expected=new VisionMaskKernel().compute(frame);
    expect(await threads.compute(frame,binding)).toEqual(expected);
    const timing=threads.diagnostics().timing!;
    expect(timing.clock).toBe('host-monotonic-hrtime-ms');expect(timing.timingQualificationEligible).toBe(false);
    expect(timing.totals.missingOrInvalidWorkerTiming).toBe(0);expect(timing.totals.laneCompleted).toBe(2);
    expect(timing.recentLanes).toHaveLength(2);expect(timing.recentPhases).toHaveLength(1);
    const phase=timing.recentPhases[0]!;
    expect(phase.binding).toEqual(binding);expect(phase.groupCount).toBe(11);expect(phase.sourceCount).toBe(132);
    expect(phase.startedAtMs).toBeLessThanOrEqual(phase.sealedAtMs!);expect(phase.sealedAtMs!).toBeLessThanOrEqual(phase.dispatchedAtMs!);
    expect(phase.dispatchedAtMs!).toBeLessThanOrEqual(phase.resolvedAtMs!);expect(phase.resolvedAtMs!).toBeLessThanOrEqual(phase.completedAtMs!);
    for(const row of timing.recentLanes){
      expect(row.binding).toEqual(binding);expect(row.batch).toBe(phase.batch);expect(row.threadId).toBeGreaterThan(0);expect(row.outcome).toBe('returned');
      expect(row.firstRequest).toBe(true);
      expect(row.intervals).toBeDefined();expect(row.coordinatorDispatchAtMs).toBeGreaterThanOrEqual(phase.sealedAtMs!);
      expect(row.coordinatorReceivedAtMs!).toBeLessThanOrEqual(phase.resolvedAtMs!);
      const spans=row.intervals!;
      expect(spans.dispatchToWorkerReceiptMs+spans.workerPreparationMs+spans.workerComputeWallMs+spans.workerResultPreparationMs+spans.resultBoundaryToCoordinatorReceiptMs)
        .toBeCloseTo(spans.dispatchToCoordinatorReceiptMs,5);
    }
    // Returned diagnostics must not expose mutable ownership of retained rows.
    timing.recentLanes[0]!.binding.tick=-1;timing.recentLanes[0]!.worker!.workerReceivedAtMs=-1;
    expect(threads.diagnostics().timing!.recentLanes[0]!.binding.tick).toBe(binding.tick);
    expect(threads.diagnostics().timing!.recentLanes[0]!.worker!.workerReceivedAtMs).toBeGreaterThan(0);
  });
  it('keeps diagnostic histories bounded and records exact fallback without inventing worker timing',async()=>{
    const threads=pool(1,15000,true),frame:VisionMaskFrame={width:2,height:2,gridMm:1000,cacheKey:'tiny',blockerRevision:0,blockers:[],groups:[{key:'owner',sources:[{id:'u',xMm:1000,zMm:1000,radius:1000}]}]};
    // Change an actual source so each phase exercises the bounded worker history.
    for(let tick=0;tick<100;tick++){frame.groups[0]!.sources[0]!.xMm=1000+tick;await threads.compute(frame,{...binding,tick});}
    const timing=threads.diagnostics().timing!;
    expect(timing.recentLanes).toHaveLength(timing.historyLimit);expect(timing.recentPhases).toHaveLength(timing.historyLimit);
    expect(timing.totals.laneCompleted).toBe(100);expect(timing.totals.completedPhases).toBe(100);
    expect(timing.historyPolicy).toEqual({first:8,latest:88,omittedLanes:4,omittedPhases:4});
    expect(timing.recentLanes[0]!.firstRequest).toBe(true);expect(timing.recentLanes.slice(1).every(row=>!row.firstRequest)).toBe(true);
    expect(timing.recentLanes.slice(0,8).map(row=>row.binding.tick)).toEqual([0,1,2,3,4,5,6,7]);
    expect(timing.recentPhases.slice(0,8).map(row=>row.binding.tick)).toEqual([0,1,2,3,4,5,6,7]);
    expect(timing.recentLanes[8]!.binding.tick).toBe(12);expect(timing.recentPhases[8]!.binding.tick).toBe(12);
    expect(timing.recentLanes.at(-1)!.binding.tick).toBe(99);expect(timing.recentPhases.at(-1)!.binding.tick).toBe(99);
    const lane=lanes(threads)[0]!,original=lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage=()=>{throw new Error('test diagnostic recovery');};
    frame.groups[0]!.sources[0]!.xMm++;
    expect(await threads.compute(frame,{...binding,tick:101})).toEqual(new VisionMaskKernel().compute(frame));
    lane.worker.postMessage=original;
    const row=threads.diagnostics().timing!.recentLanes.at(-1)!;
    expect(row.outcome).toBe('recovered');expect(row.worker).toBeUndefined();expect(row.intervals).toBeUndefined();
    expect(row.fallbackEndedAtMs!).toBeGreaterThanOrEqual(row.fallbackStartedAtMs!);
    expect(threads.diagnostics().timing!.totals.recovered).toBe(1);
  });
  it('uses one host-clock chain while treating post duration as overlapping and rejecting invalid stamps',()=>{
    const row:VisionLaneTiming={generation:2,batch:3,binding,lane:0,threadId:9,groupCount:1,sourceCount:1,geometryTransferred:false,firstRequest:false,
      coordinatorDispatchAtMs:100,coordinatorPostedAtMs:150,worker:{workerReceivedAtMs:140,workerComputeStartedAtMs:145,workerComputeEndedAtMs:170,workerResultPostStartedAtMs:175},coordinatorReceivedAtMs:190,outcome:'returned'};
    // A receiver may run before the sending thread is scheduled to record its
    // post return. Subtracting post-return from worker receipt would be wrong.
    expect(visionLaneIntervals(row)).toEqual({coordinatorPostMs:50,dispatchToWorkerReceiptMs:40,workerPreparationMs:5,
      workerComputeWallMs:25,workerResultPreparationMs:5,resultBoundaryToCoordinatorReceiptMs:15,dispatchToCoordinatorReceiptMs:90});
    expect(visionLaneIntervals({...row,worker:{...row.worker!,workerComputeEndedAtMs:144}})).toBeUndefined();
    expect(visionLaneIntervals({...row,coordinatorReceivedAtMs:NaN})).toBeUndefined();
    expect(visionLaneIntervals({...row,worker:undefined})).toBeUndefined();
  });
  it('exchanges no stationary source records or masks and preserves immutable result identities',async()=>{
    const threads=pool(2),frame=smallFixture(),requests:VisionWorkerRequest[]=[],responses:VisionWorkerResponse[]=[];
    for(const lane of lanes(threads)){
      const post=lane.worker.postMessage.bind(lane.worker);
      lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
      lane.worker.on('message',(response:VisionWorkerResponse)=>responses.push(response));
    }
    const first=await threads.compute(frame,binding),next=await threads.compute(structuredClone(frame),{...binding,tick:20});
    expect(next).toEqual(new VisionMaskKernel().compute(frame));
    expect(next[0]).toBe(first[0]);expect(next[1]).toBe(first[1]);expect(next[0]!.mask).toBe(first[0]!.mask);expect(next[0]!.visible).toBe(first[0]!.visible);
    expect(requests.slice(0,2).every(request=>request.sources.mode==='full')).toBe(true);
    expect(requests).toHaveLength(2);expect(responses).toHaveLength(2);
    expect(threads.diagnostics()).toMatchObject({sourceFullFrames:2,sourceDeltaFrames:0,sourceRecordsSent:2,resultGroupsTransferred:2,resultGroupsReused:0,coordinatorGroupsReused:2,geometryTransfers:2});
    expect(Object.isFrozen(next[0])).toBe(true);expect(Object.isFrozen(next[0]!.visible)).toBe(true);
  });
  it('advances changed sources even when their final union is unchanged, then removes the covering source exactly',async()=>{
    const threads=pool(1),frame=smallFixture();frame.groups=frame.groups.slice(0,1);
    frame.groups[0]!.sources=[{id:'cover',xMm:8000,zMm:6000,radius:30000},{id:'small',xMm:3500,zMm:4500,radius:1000}];
    const requests:VisionWorkerRequest[]=[],lane=lanes(threads)[0]!,post=lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
    const first=await threads.compute(frame,binding);
    frame.groups[0]!.sources[1]!.xMm=12500;
    const moved=await threads.compute(frame,{...binding,tick:20});expect(moved[0]).toBe(first[0]);
    expect(requests[1]!.sources).toMatchObject({mode:'delta',baseRevision:1,revision:2,groups:[{key:'allies-a',upserts:[{id:'small',xMm:12500}],removed:[]}]});
    expect(requests[1]!.sources.groups[0]).not.toHaveProperty('order');
    frame.groups[0]!.sources=frame.groups[0]!.sources.slice(1);
    const uncovered=await threads.compute(frame,{...binding,tick:21});expect(uncovered).toEqual(new VisionMaskKernel().compute(frame));expect(uncovered[0]).not.toBe(first[0]);
    expect(requests[2]!.sources).toMatchObject({mode:'delta',groups:[{key:'allies-a',upserts:[],removed:['cover'],order:['small']}]});
    expect(first[0]!.mask.every(Boolean)).toBe(true);expect(first[0]!.visible).toHaveLength(16*12);
  });
  it('dispatches only changed vision lanes while unchanged groups keep exact immutable results',async()=>{
    const threads=pool(2,15000,true),frame=smallFixture(),requests:VisionWorkerRequest[]=[];
    for(const lane of lanes(threads)){
      const post=lane.worker.postMessage.bind(lane.worker);
      lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
    }
    const first=await threads.compute(frame,binding);
    frame.groups[1]!.sources[0]!.xMm=2500;
    const second=await threads.compute(frame,{...binding,tick:20});
    expect(second).toEqual(new VisionMaskKernel().compute(frame));
    expect(second[0]).toBe(first[0]);expect(second[1]).not.toBe(first[1]);expect(requests).toHaveLength(3);
    expect(requests[2]!.sources).toMatchObject({mode:'delta',baseRevision:1,revision:2,groups:[{key:'allies-b'}]});
    const repeated=await threads.compute(structuredClone(frame),{...binding,tick:20,phase:'post-death-vision'});
    expect(repeated[0]).toBe(second[0]);expect(repeated[1]).toBe(second[1]);expect(requests).toHaveLength(3);
    const diagnostics=threads.diagnostics();
    expect(diagnostics.coordinatorGroupsReused).toBe(3);
    expect(diagnostics.timing!.totals.completedPhases).toBe(3);
    expect(diagnostics.timing!.totals.laneCompleted).toBe(3);
    // Source mutations still require work, including after skipped revisions.
    frame.groups[0]!.sources[0]!.radius=5000;
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(new VisionMaskKernel().compute(frame));
    expect(requests[3]!.sources).toMatchObject({mode:'delta',baseRevision:1,revision:2});
  });
  it('does not wait for unused worker lanes and reconciles them when groups are added later',async()=>{
    const threads=pool(3),frame=smallFixture(),allGroups=frame.groups,requests:VisionWorkerRequest[]=[];
    frame.groups=allGroups.slice(0,1);
    for(const lane of lanes(threads)){
      const post=lane.worker.postMessage.bind(lane.worker);
      lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
    }
    expect(await threads.compute(frame,binding)).toEqual(new VisionMaskKernel().compute(frame));
    expect(requests).toHaveLength(1);expect(threads.diagnostics().emptyLanesSkipped).toBe(2);
    frame.groups=[];expect(await threads.compute(frame,{...binding,tick:20})).toEqual([]);
    expect(requests).toHaveLength(1);expect(threads.diagnostics().emptyLanesSkipped).toBe(5);
    frame.groups=allGroups;
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(new VisionMaskKernel().compute(frame));
    expect(requests).toHaveLength(3);expect(threads.diagnostics().recovered).toBe(0);
  });
  it('rebinds an empty lane after geometry and epoch changes and cannot reuse a failed idle lane',async()=>{
    const threads=pool(2),frame=smallFixture(),allGroups=frame.groups;
    await threads.compute(frame,binding);
    frame.groups=[];frame.blockerRevision++;frame.blockers=[{id:'new-cliff',xMm:6000,zMm:5000,halfWidth:900,halfHeight:5000}];
    const nextBinding={...binding,matchEpoch:binding.matchEpoch+1,tick:20};
    expect(await threads.compute(frame,nextBinding)).toEqual([]);
    frame.groups=allGroups;
    expect(await threads.compute(frame,{...nextBinding,tick:21})).toEqual(new VisionMaskKernel().compute(frame));
    expect(threads.diagnostics().geometryTransfers).toBe(4);
    const firstLane=lanes(threads)[0]!,oldId=firstLane.worker.threadId;
    await firstLane.worker.terminate();
    expect(await threads.compute(frame,{...nextBinding,tick:22})).toEqual(new VisionMaskKernel().compute(frame));
    expect(threads.diagnostics().threadIds[0]).not.toBe(oldId);
    expect(threads.diagnostics().sourceFullFrames).toBe(5);
  });
  it('preserves source and group order through lane migration, team reshuffle, removal and re-addition',async()=>{
    const threads=pool(2),frame=smallFixture(),oracle=new VisionMaskKernel();
    frame.groups[0]!.sources=[...frame.groups[0]!.sources,{id:'c',xMm:7500,zMm:4500,radius:1000}];
    const first=await threads.compute(frame,binding);expect(first).toEqual(oracle.compute(frame));
    frame.groups=frame.groups.slice().reverse();frame.groups[1]!.sources=frame.groups[1]!.sources.slice().reverse();
    expect(await threads.compute(frame,{...binding,tick:20})).toEqual(oracle.compute(frame));
    const moved=frame.groups[1]!.sources[0]!;frame.groups[1]!.sources=frame.groups[1]!.sources.slice(1);frame.groups[0]!.sources=[...frame.groups[0]!.sources,moved];
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(oracle.compute(frame));
    frame.groups=frame.groups.slice(0,1);expect(await threads.compute(frame,{...binding,tick:22})).toEqual(oracle.compute(frame));
    frame.groups=[];expect(await threads.compute(frame,{...binding,tick:23})).toEqual([]);
    const restored=smallFixture();expect(await threads.compute(restored,{...binding,tick:24})).toEqual(oracle.compute(restored));
    expect(threads.diagnostics().recovered).toBe(0);
  });
  it('sends full source and result baselines after epoch, match or geometry binding changes',async()=>{
    const threads=pool(1),frame=smallFixture(),requests:VisionWorkerRequest[]=[];let currentBinding={...binding};
    const lane=lanes(threads)[0]!,post=lane.worker.postMessage.bind(lane.worker);
    lane.worker.postMessage=(request:VisionWorkerRequest)=>{requests.push(request);post(request);};
    await threads.compute(frame,currentBinding);
    for(const change of ['epoch','match','map','blockers','dimensions']){
      currentBinding={...currentBinding,tick:currentBinding.tick+1};
      if(change==='epoch')currentBinding.matchEpoch++;
      if(change==='match')currentBinding.matchId='new-match';
      if(change==='map')frame.cacheKey='new-map';
      if(change==='blockers'){frame.blockerRevision++;frame.blockers=[{id:'wall',xMm:7000,zMm:6000,halfWidth:1000,halfHeight:4000}];}
      if(change==='dimensions')frame.width++;
      expect(await threads.compute(frame,currentBinding)).toEqual(new VisionMaskKernel().compute(frame));
      expect(requests.at(-1)!.sources.mode).toBe('full');expect(requests.at(-1)!.geometry).toBeDefined();
    }
    expect(threads.diagnostics()).toMatchObject({sourceFullFrames:6,sourceDeltaFrames:0,recovered:0});
  });
  it('rejects stale result revisions and worker source bases, recovers the sealed phase and restarts with full baselines',async()=>{
    const threads=pool(1),frame=smallFixture();let expected=new VisionMaskKernel().compute(frame);
    await threads.compute(frame,binding);
    const stale=lanes(threads)[0]!;
    stale.worker.postMessage=(request:VisionWorkerRequest)=>{
      stale.worker.emit('message',{type:'vision-result',generation:request.generation,batch:request.batch,binding:request.binding,
        exchangeKey:request.exchangeKey,sourceBaseRevision:request.sources.baseRevision,sourceRevision:request.sources.revision,
        results:frame.groups.map(group=>({key:group.key,baseRevision:999,revision:999}))} satisfies VisionWorkerResponse);
    };
    // Force work with a changed source; unchanged phases now reuse owned results.
    frame.groups[0]!.sources[0]!.xMm+=0.01;
    expected=new VisionMaskKernel().compute(frame);
    expect(await threads.compute(frame,{...binding,tick:20})).toEqual(expected);expect(threads.diagnostics().recovered).toBe(1);
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(expected);expect(threads.diagnostics().sourceFullFrames).toBe(2);
    const wrongBase=lanes(threads)[0]!,post=wrongBase.worker.postMessage.bind(wrongBase.worker);
    wrongBase.worker.postMessage=(request:VisionWorkerRequest)=>{post({...request,sources:{...request.sources,baseRevision:999}});};
    frame.groups[0]!.sources[0]!.xMm+=0.01;
    expected=new VisionMaskKernel().compute(frame);
    expect(await threads.compute(frame,{...binding,tick:22})).toEqual(expected);expect(threads.diagnostics().recovered).toBe(2);
    expect(await threads.compute(frame,{...binding,tick:23})).toEqual(expected);expect(threads.diagnostics().sourceFullFrames).toBe(3);
    expect(await threads.compute(frame,{...binding,tick:24})).toEqual(expected);
  });
  it('uses the ordered synchronous reference for duplicate source IDs or group keys without contaminating lane baselines',async()=>{
    const threads=pool(2),frame=smallFixture(),oracle=new VisionMaskKernel();await threads.compute(frame,binding);oracle.compute(frame);
    frame.groups[0]!.sources=[...frame.groups[0]!.sources,{...frame.groups[0]!.sources[0]!,xMm:12500}];
    expect(await threads.compute(frame,{...binding,tick:20})).toEqual(oracle.compute(frame));
    frame.groups=[...frame.groups,{key:'allies-a',sources:[{id:'d',xMm:1500,zMm:1500,radius:2000}]}];
    expect(await threads.compute(frame,{...binding,tick:21})).toEqual(oracle.compute(frame));
    const normal=smallFixture();expect(await threads.compute(normal,{...binding,tick:22})).toEqual(oracle.compute(normal));
    expect(threads.diagnostics()).toMatchObject({unusualFrames:2,recovered:0});
  });
});
