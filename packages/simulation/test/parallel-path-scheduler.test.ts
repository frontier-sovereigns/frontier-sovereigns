import { describe, expect, it, vi } from 'vitest';
import { PathWorkerPool, PathWorkerService, serializePathCheckpoint, deserializePathCheckpoint, type SerializedPathCheckpoint } from '../../../apps/server/src/path-worker-pool.js';
import { MAX_SAVE_BYTES } from '../../../apps/server/src/save-store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { computeWorkerEnvironment } from '../../../apps/server/src/compute-worker-environment.js';
import { Navigation, type Obstacle } from '../src/navigation.js';
import { PathScheduler, preparePathCheckpointMessage, type PathRequest } from '../src/path-scheduler.js';
import { PersistentPathPlanningKernel, createNativePathPlanningKernel, RemotePathScheduler, mergePathReplies, mergePathStates, partitionPathState, type PathPlanningBatch, type PathPlanningExecutor, type PathPlanningGeometry, type PathPlanningReply } from '../src/parallel-path-scheduler.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { LocalAvoidance, UnitSpatialIndex, type LocalPathCandidate, type LocalPathQuery } from '../src/movement.js';
import { units, type PublicPlayer } from '@frontier/shared';
import { Simulation, type Building, type ResourceNode, type Unit } from '../src/index.js';
import { createNativeCheckpointScope,postNativeCheckpoint,hydrateNativeCheckpointMessage } from '../src/checkpoint-native.js';

const profiles=['p3','p1','p4','p2'];
const walls:Obstacle[]=[{id:'wall',xMm:32000,zMm:23000,halfWidth:400,halfHeight:23000}];
const geometries=():PathPlanningGeometry[]=>profiles.map(profile=>({profile,revision:1,widthMm:64000,heightMm:64000,obstacles:structuredClone(walls)}));
const request=(profile:string,index=0):PathRequest=>({id:`r_${profile}_${index}`,unitId:`u_${profile}_${index}`,profile,orderRevision:1,from:{xMm:8000+index*1000,zMm:8000},target:{xMm:56000,zMm:48000},radiusMm:350});
function inline(geometry=geometries()){return new PathScheduler(profile=>{const value=geometry.find(item=>item.profile===profile)!;return new Navigation(value.widthMm,value.heightMm,[...value.obstacles]);},profiles);}

describe('bounded detached navigation service',()=>{
  it('posts an owned compute checkpoint with one IPC copy and the exact detached public state order',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState(),owned=createNativePathPlanningKernel(profiles,state,geometry),reference=new PersistentPathPlanningKernel(profiles,state,geometry),channel=new MessageChannel();
    const batch:PathPlanningBatch={batchId:1,operations:profiles.map(profile=>({type:'request',request:request(profile)})),geometry:[],grants:profiles.map(profile=>({profile,nodeBudget:1024}))};
    const reply=owned.advance(batch);expect(reply).toEqual(reference.advance(batch));const expected=reference.exportState(),before=PathScheduler.nativeCheckpointDiagnostics().posted;
    const clone=structuredClone;let fullCopies=0;const spy=vi.spyOn(globalThis,'structuredClone').mockImplementation(((value:unknown,options?:StructuredSerializeOptions)=>{if(value&&typeof value==='object'&&'tasks'in value&&'regions'in value&&'routes'in value)fullCopies++;return clone(value,options);}) as typeof structuredClone);
    try{
      const incoming=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:12,generation:3,threadId:4,startedAtMs:Number(process.hrtime.bigint())/1e6},reply);const message=(await incoming)[0];
      expect(fullCopies).toBe(0);expect(PathScheduler.nativeCheckpointDiagnostics().posted).toBe(before+1);expect(message).toMatchObject({id:12,generation:3,threadId:4,value:{reply,state:expected}});expect(message.timing.workerFinishedAtMs).toBeGreaterThanOrEqual(message.timing.workerStartedAtMs);expect(JSON.stringify(message.value.state)).toBe(JSON.stringify(expected));
      const saved=owned.exportState();expect(fullCopies).toBe(1);saved.tasks.length=0;message.value.state.regions.length=0;message.value.state.tasks[0].from.xMm=-1;expect(owned.exportState()).toEqual(expected);
      const next:PathPlanningBatch={batchId:2,operations:[],geometry:[],grants:profiles.map(profile=>({profile,nodeBudget:64}))};owned.advance(next);reference.advance(next);
      const second=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:13,generation:3,threadId:4});expect((await second)[0].value).toEqual(reference.exportState());expect(expected).not.toEqual(reference.exportState());
    }finally{spy.mockRestore();channel.port1.close();channel.port2.close();}
  });
  it('permanently falls back to detached compute checkpoints after an observed custom scheduler helper',async()=>{
    const geometry=geometries(),owned=createNativePathPlanningKernel(profiles,inline(geometry).exportState(),geometry),channel=new MessageChannel(),original=PathScheduler.prototype.exportState,before=PathScheduler.nativeCheckpointDiagnostics().posted;let calls=0;
    PathScheduler.prototype.exportState=function(){calls++;return original.call(this);};
    try{const incoming=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:1,generation:0,threadId:0});expect((await incoming)[0].value.version).toBe(1);expect(calls).toBe(1);expect(PathScheduler.nativeCheckpointDiagnostics().posted).toBe(before);}finally{PathScheduler.prototype.exportState=original;}
    try{const incoming=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:2,generation:0,threadId:0});expect((await incoming)[0].value).toEqual(owned.exportState());expect(PathScheduler.nativeCheckpointDiagnostics().posted).toBe(before);}finally{channel.port1.close();channel.port2.close();}
  });
  it('detaches compute checkpoint initialization and mirror corridors and rejects changed prototype ancestry',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState();state.tasks.push({...request('p1'),stage:'direct',lineStep:0,lineSteps:192,corridor:['0,0','1,0']});
    const owned=createNativePathPlanningKernel(profiles,state,geometry),expected=owned.exportState(),mirror=owned.reply();
    (mirror.mirrors[0]!.usedRegions as string[]).push('private_corridor_mutation');mirror.mirrors[0]!.request.from.xMm=-1;state.tasks.length=0;geometry[0]!.obstacles[0]!.xMm=-1;expect(owned.exportState()).toEqual(expected);
    const channel=new MessageChannel(),parent=Object.getPrototypeOf(PathScheduler.prototype),before=PathScheduler.nativeCheckpointDiagnostics().posted;
    Object.setPrototypeOf(PathScheduler.prototype,Object.create(parent));
    try{const incoming=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:1,generation:0,threadId:0});expect((await incoming)[0].value).toEqual(expected);expect(PathScheduler.nativeCheckpointDiagnostics().posted).toBe(before);}finally{Object.setPrototypeOf(PathScheduler.prototype,parent);channel.port1.close();channel.port2.close();}
  });
  it('keeps compute checkpoint ports intrinsic and preserves state after metadata and native send failures',async()=>{
    const geometry=geometries(),owned=createNativePathPlanningKernel(profiles,inline(geometry).exportState(),geometry),channel=new MessageChannel(),expected=owned.exportState(),before=PathScheduler.nativeCheckpointDiagnostics().posted;
    try{
      expect(()=>owned.postCheckpoint({postMessage(){throw new Error('CUSTOM_PORT_CALLED');}} as never,{id:1,generation:0,threadId:0})).toThrow('INVALID_NATIVE_CHECKPOINT_PORT');expect(()=>owned.postCheckpoint(channel.port1,{id:-1,generation:0,threadId:0})).toThrow('INVALID_PATH_CHECKPOINT_ENVELOPE');expect(()=>owned.postCheckpoint(channel.port1,{id:1,generation:0,threadId:0},{invalid:()=>{}} as never)).toThrow();expect(owned.exportState()).toEqual(expected);expect(PathScheduler.nativeCheckpointDiagnostics().posted).toBe(before);
      channel.port1.postMessage=()=>{throw new Error('CUSTOM_PORT_CALLED');};const incoming=once(channel.port2,'message');owned.postCheckpoint(channel.port1,{id:2,generation:0,threadId:0});expect((await incoming)[0].value).toEqual(expected);
      // The direct internal emitter never retains a borrowed graph even if the
      // intrinsic structured clone rejects a corrupt unsupported private row.
      const scheduler=inline(geometry),internal=scheduler as unknown as {revisions:Record<string,unknown>};internal.revisions.invalid=()=>{};
      const failed=preparePathCheckpointMessage({id:3,generation:0,threadId:0});expect(()=>scheduler.postNativeCheckpoint(channel.port1,failed)).toThrow();delete internal.revisions.invalid;expect(()=>scheduler.postNativeCheckpoint(channel.port1,failed)).toThrow('INVALID_PATH_CHECKPOINT_MESSAGE');
      const recovered=once(channel.port2,'message');scheduler.postNativeCheckpoint(channel.port1,preparePathCheckpointMessage({id:4,generation:0,threadId:0}));expect((await recovered)[0].value).toEqual(scheduler.exportState());
    }finally{channel.port1.close();channel.port2.close();}
  });
  it('observes pending and admitted global requests without consuming a result or changing planner state',()=>{
    const geometry=geometries().map(value=>({...value,obstacles:[]})),remote=RemotePathScheduler.createSynchronous(profiles,inline(geometry).exportState(),geometry),value=request('p1');
    expect(remote.hasRequest(value.unitId)).toBe(false);remote.request(value);expect(remote.hasRequest(value.unitId)).toBe(true);
    expect(remote.take(value.unitId,2)).toBeUndefined();expect(remote.hasRequest(value.unitId)).toBe(true);
    expect(remote.startServiceLeases(4000,geometry,1,1)).toBe(true);expect(remote.admitServiceLeases(1)).toBeDefined();
    remote.synchronizeCaptureSynchronous(geometry);const snapshot=remote.exportState();expect(remote.hasRequest(value.unitId)).toBe(true);expect(remote.exportState()).toEqual(snapshot);
    expect(remote.take(value.unitId,1)?.status).toBe('ready');expect(remote.hasRequest(value.unitId)).toBe(false);
  });
  it('emits native checkpoint handles from synchronized real-service prefixes and revokes them on planner changes',async()=>{
    const geometry=geometries(),state=inline().exportState(),service=new PathWorkerService({workerCount:2}),channel=new MessageChannel(),scope=createNativeCheckpointScope();
    const executor:PathPlanningExecutor={initialize:(...args)=>service.initialize(...args),advance:batch=>service.advance(batch),capture:()=>service.capture(),advanceAndCapture:batch=>service.advanceAndCapture(batch),dispose:()=>service.dispose(),advanceService:(first,_maximum,groups)=>service.advanceService(first,1,groups?.slice(0,1)),stopServiceAfterCurrent:()=>service.stopServiceAfterCurrent()};
    const remote=await RemotePathScheduler.create(profiles,state,geometry,executor);
    const payload=new Simulation({seed:'native-path',matchId:'native-path',controllers:false,factions:profiles.map(id=>({id,name:id,teamId:id,color:'#3388ff',kind:'human' as const}))}).capture(),{pathScheduler:_path,...runtime}=payload.runtime,body={...payload,runtime};
    try{
      remote.request(request('p1'));expect(()=>remote.nativeCheckpoint()).toThrow('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');
      expect(remote.startServiceLeases(64,geometry,1,6)).toBe(true);const admission=await remote.drainServiceLeases();expect(admission!.leases).toHaveLength(1);await remote.synchronizeCapture(geometry);const expected=remote.exportState();
      const incoming=once(channel.port2,'message'),handle=scope.prepare(body,remote.nativeCheckpoint());postNativeCheckpoint(handle,channel.port1,{type:'reply',id:1});const captured=(await incoming)[0].value.runtime.pathScheduler;expect(captured).toEqual(expected);captured.tasks.length=0;expect(remote.exportState()).toEqual(expected);
      const stale=scope.prepare(body,remote.nativeCheckpoint());remote.cancel(request('p1').unitId);expect(()=>postNativeCheckpoint(stale,channel.port1,{type:'reply',id:2})).toThrow('INVALID_NATIVE_CHECKPOINT');expect(()=>remote.nativeCheckpoint()).toThrow('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');
      await remote.synchronizeCapture(geometry);expect(remote.exportState().tasks).toHaveLength(0);
      const disposed=scope.prepare(body,remote.nativeCheckpoint());await remote.dispose();expect(()=>postNativeCheckpoint(disposed,channel.port1,{type:'reply',id:3})).toThrow('INVALID_NATIVE_CHECKPOINT');expect(()=>remote.nativeCheckpoint()).toThrow('PATH_EXECUTOR_CLOSED');
    }finally{scope.close();await remote.dispose();channel.port1.close();channel.port2.close();}
  },15000);
  it('uses exact fixed buffers for serialized checkpoints and rejects malformed or shared backing',()=>{
    const state=inline().exportState(),packet=serializePathCheckpoint(state);
    expect(packet.format).toBe('path-state-v8-v1');expect(packet.data).toBeInstanceOf(ArrayBuffer);expect(packet.byteLength).toBe(packet.data.byteLength);expect(deserializePathCheckpoint(packet)).toEqual(state);
    const invalid:unknown[]=[null,{...packet,format:'unknown'},{...packet,byteLength:packet.byteLength-1},{...packet,byteLength:MAX_SAVE_BYTES+1},{...packet,data:new SharedArrayBuffer(packet.byteLength)},{...packet,data:new Uint8Array(packet.data).subarray(1)},serializePathCheckpoint({} as never),{...packet,data:new ArrayBuffer(packet.byteLength)}];
    const resizable=new (ArrayBuffer as unknown as new(length:number,options:{maxByteLength:number})=>ArrayBuffer)(packet.byteLength,{maxByteLength:packet.byteLength+1});invalid.push({...packet,data:resizable});
    for(const value of invalid)expect(()=>deserializePathCheckpoint(value)).toThrow('INVALID_PATH_CAPTURE_ENCODING');
    const transferred=structuredClone(packet,{transfer:[packet.data]});expect(packet.data.byteLength).toBe(0);expect(deserializePathCheckpoint(transferred)).toEqual(state);expect(()=>deserializePathCheckpoint(packet)).toThrow('INVALID_PATH_CAPTURE_ENCODING');
  });
  it('retains opaque real-service checkpoints across zero-credit updates and admitted prefixes without using raw capture APIs',async()=>{
    const geometry=geometries(),expected=inline(geometry),service=new PathWorkerService({workerCount:2}),scope=createNativeCheckpointScope(),channel=new MessageChannel();
    const rawCapture=vi.spyOn(service,'capture'),rawCombined=vi.spyOn(service,'advanceAndCapture'),nativeCapture=vi.spyOn(service,'captureNativeCheckpoint'),nativeCombined=vi.spyOn(service,'advanceAndCaptureNative');
    const remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,service),payload=new Simulation({seed:'native-opaque-service',matchId:'native-opaque-service',controllers:false,factions:profiles.map(id=>({id,name:id,teamId:id,color:'#3388ff',kind:'human' as const}))}).capture(),{pathScheduler:_path,...runtime}=payload.runtime,body={...payload,runtime};
    const post=async()=>{const incoming=once(channel.port2,'message');postNativeCheckpoint(scope.prepare(body,remote.nativeCheckpoint()),channel.port1,{type:'reply',id:1});const packet=(await incoming)[0];expect(packet.type).toBe('native-checkpoint');return (hydrateNativeCheckpointMessage(packet) as {value:{runtime:{pathScheduler:ReturnType<typeof expected.exportState>}}}).value.runtime.pathScheduler;};
    try{
      const value=request('p1');remote.request(value);expected.request(value);expected.advanceProfiles([]);await remote.synchronizeCapture(geometry,true);expect(nativeCombined).toHaveBeenCalledTimes(1);expect(await post()).toEqual(expected.exportState());expect(remote.exportState()).toEqual(expected.exportState());
      remote.startServiceLeases(64,geometry,1,1);const admitted=await remote.drainServiceLeases();expect(admitted!.leases).toHaveLength(1);expected.advanceProfiles(admitted!.leases[0]!.grants,1);await remote.synchronizeCapture(geometry,true);expect(nativeCapture).toHaveBeenCalledTimes(1);expect(await post()).toEqual(expected.exportState());
      const stale=scope.prepare(body,remote.nativeCheckpoint());remote.cancel(value.unitId);expected.cancel(value.unitId);expect(()=>postNativeCheckpoint(stale,channel.port1,{type:'reply',id:2})).toThrow('INVALID_NATIVE_CHECKPOINT');expect(()=>remote.exportState()).toThrow('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');expected.advanceProfiles([]);await remote.synchronizeCapture(geometry,true);expect(await post()).toEqual(expected.exportState());
      const detached=remote.exportState();detached.regions.length=0;detached.routes.length=0;expect(await post()).toEqual(expected.exportState());expect(rawCapture).not.toHaveBeenCalled();expect(rawCombined).not.toHaveBeenCalled();
    }finally{await remote.dispose();scope.close();channel.port1.close();channel.port2.close();vi.restoreAllMocks();}
  },15000);
  it('serializes acknowledged pool checkpoints without cloning the merged graph or lending recovery state',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({workerCount:2,checkpointEvery:8,performanceDiagnostics:true});
    await pool.initialize(profiles,expected.exportState(),geometry);
    try{
      const requests=profiles.map(profile=>request(profile));for(const item of requests)expected.request(item);
      const grants=profiles.map(profile=>({profile,nodeBudget:64}));const first=await pool.advance({batchId:1,operations:requests.map(item=>({type:'request' as const,request:item})),geometry:[],grants});expect(first.report).toEqual(expected.advanceProfiles(grants));
      // Synchronize the recovery checkpoint, then distinguish byte serialization
      // from an extra main-thread structuredClone of the whole graph.
      const before=await pool.capture(),clone=structuredClone;let graphCopies=0;
      const spy=vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{const record=value as {version?:number;tasks?:unknown;regions?:unknown}|null;if(record?.version===1&&Array.isArray(record.tasks)&&Array.isArray(record.regions))graphCopies++;return clone(value,options);});
      let packet:SerializedPathCheckpoint;
      try{packet=await pool.serializeCapture();expect(graphCopies).toBe(0);await pool.capture();expect(graphCopies).toBe(1);}finally{spy.mockRestore();}
      const received=structuredClone(packet!,{transfer:[packet!.data]}),decoded=deserializePathCheckpoint(received);expect(decoded).toEqual(before);decoded.tasks[0]!.target.xMm=-1;decoded.regions.length=0;new Uint8Array(received.data).fill(0);expect(await pool.capture()).toEqual(before);
      const slots=(pool as unknown as {slots:{worker:{terminate():Promise<number>}}[]}).slots;await slots[0]!.worker.terminate();
      expected.cancel(request('p2').unitId);
      const captured=await pool.advanceAndSerializeCapture({batchId:2,operations:[{type:'cancel',profile:'p2',unitId:request('p2').unitId}],geometry:[],grants:[]});
      expect(captured.reply.report).toEqual(expected.advanceProfiles([]));expect(deserializePathCheckpoint(captured.serialized)).toEqual(expected.exportState());expect(pool.diagnostics().workers.some(worker=>worker.recoveries===1)).toBe(true);
      const returned=deserializePathCheckpoint(captured.serialized);returned.tasks.length=0;expect(await pool.capture()).toEqual(expected.exportState());
      expect(pool.diagnostics().trace!.rows.some(row=>row.operation==='captureSerialize')).toBe(true);
      await expect(pool.advanceAndSerializeCapture({batchId:3,operations:[],geometry:[],grants:[{profile:'p1',nodeBudget:1}]})).rejects.toThrow('PATH_CAPTURE_REQUIRES_ZERO_CREDITS');
    }finally{await pool.dispose();}
  },15000);
  it('roundtrips both real-service serialized capture paths through the unchanged detached graph API',async()=>{
    const geometry=geometries(),expected=inline(geometry),service=new PathWorkerService({workerCount:2,performanceDiagnostics:true}),wire:unknown[]=[];
    const worker=(service as unknown as {worker:{on(event:'message',callback:(message:{value?:unknown})=>void):void}}).worker;worker.on('message',message=>{wire.push(message.value);});
    await service.initialize(profiles,expected.exportState(),geometry);
    try{
      const item=request('p1');expected.request(item);
      const combined=await service.advanceAndCapture({batchId:1,operations:[{type:'request',request:item}],geometry:[],grants:[]});expect(combined.reply.report).toEqual(expected.advanceProfiles([]));expect(combined.state).toEqual(expected.exportState());
      combined.state.tasks[0]!.target.xMm=-1;combined.state.tasks.length=0;
      const captured=await service.capture();expect(captured).toEqual(expected.exportState());captured.tasks[0]!.from.xMm=-1;expect(await service.capture()).toEqual(expected.exportState());
      const packets=wire.flatMap(value=>{const item=value as {format?:string;serialized?:SerializedPathCheckpoint};return item?.format==='path-state-v8-v1'?[value as SerializedPathCheckpoint]:item?.serialized?[item.serialized]:[];});
      expect(packets).toHaveLength(3);for(const packet of packets){expect(packet.data).toBeInstanceOf(ArrayBuffer);expect(packet.data.byteLength).toBe(packet.byteLength);expect(packet).not.toHaveProperty('tasks');}
      expect(service.diagnostics().trace!.rows.some(row=>row.operation==='captureSerialize')).toBe(true);
      await expect(service.advanceAndCapture({batchId:2,operations:[],geometry:[],grants:[{profile:'p1',nodeBudget:1}]})).rejects.toThrow('PATH_CAPTURE_REQUIRES_ZERO_CREDITS');expect(await service.capture()).toEqual(expected.exportState());
    }finally{await service.dispose();}
  },15000);
  it.each(['service','pool'] as const)('requeues unexecuted deferred detours after a real %s prefix and serves every profile in original waiting order',async mode=>{
    const geometry=profiles.map(profile=>({profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]})),state=inline(geometry).exportState(),service=mode==='service'?new PathWorkerService({workerCount:2,performanceDiagnostics:true}):new PathWorkerPool({workerCount:2,performanceDiagnostics:true});
    // Deliberately acknowledge one real compute lease per series. This makes
    // the partial-prefix case independent of the test machine's wall clock.
    const executor:PathPlanningExecutor=service instanceof PathWorkerService?{initialize:(...args)=>service.initialize(...args),advance:batch=>service.advance(batch),capture:()=>service.capture(),dispose:()=>service.dispose(),advanceService:(first,_maximum,groups)=>service.advanceService(first,1,groups?.slice(0,1)),stopServiceAfterCurrent:()=>service.stopServiceAfterCurrent()}:service;
    const live=await RemotePathScheduler.create(profiles,state,geometry,executor),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry),nav=new Navigation(64000,64000,[]);
    const owners=profiles.map(profile=>{
      const avoidance=new LocalAvoidance('deferred-v1'),neighbors=new UnitSpatialIndex(),candidates:LocalPathCandidate[]=[];avoidance.beginTick(1,8);
      for(let index=0;index<3;index++){const body={id:`${profile}_waiting_${index}`,xMm:8000,zMm:8000+index*12000,radiusMm:350},target={xMm:14000,zMm:body.zMm};neighbors.set(body);neighbors.set({id:`${profile}_blocker_${index}`,xMm:9000,zMm:body.zMm,radiusMm:350});candidates.push({body,target,orderRevision:7});expect(avoidance.step(body,target,800,nav,neighbors,nav,()=>true,undefined,undefined,false,7)).toBeUndefined();}
      neighbors.set({id:'hidden_enemy',xMm:8050,zMm:8000,radiusMm:350});return {profile,avoidance,neighbors,candidates};
    });
    const served:string[]=[];
    try{
      for(let series=0;series<3;series++){
        const groups:LocalPathQuery[][]=Array.from({length:3-series},()=>[]);
        for(const owner of owners){const queries=owner.avoidance.prepareDeferredQueries(owner.profile,1,owner.candidates,owner.neighbors,id=>id!=='hidden_enemy',3,2+series);expect(queries).toHaveLength(3-series);expect(queries.every(query=>query.neighbors.every(neighbor=>neighbor.id!=='hidden_enemy'))).toBe(true);queries.forEach((query,index)=>groups[index]!.push(query));}
        for(const scheduler of [live,replay])expect(scheduler.startServiceLeases(64,geometry,2+series,groups.length,[],groups)).toBe(true);
        const admission=(await live.drainServiceLeases())!;expect(admission.leases).toHaveLength(1);expect(replay.admitServiceLeases(1)).toEqual(admission);
        const results=live.takeLocalResults();expect(results).toEqual(replay.takeLocalResults());expect(results.map(result=>result.query.body.id).sort()).toEqual(profiles.map(profile=>`${profile}_waiting_${series}`).sort());served.push(...results.map(result=>result.query.body.id));
        for(const owner of owners){owner.avoidance.admitDeferredResults(results.filter(result=>result.query.profile===owner.profile),3+series);const jobs=owner.avoidance.exportState().deferred!.jobs;expect(jobs.every(([,job])=>job.firstTick===1)).toBe(true);expect(jobs.filter(([,job])=>job.status==='ready')).toHaveLength(series+1);expect(jobs.filter(([,job])=>job.status==='queued')).toHaveLength(2-series);expect(jobs.some(([,job])=>job.status==='inflight')).toBe(false);}
      }
      expect(new Set(served).size).toBe(12);await live.synchronizeCapture();replay.synchronizeCaptureSynchronous();expect(live.exportState()).toEqual(replay.exportState());
      const rows=service.diagnostics().trace!.rows.filter(row=>row.kind==='request'&&row.operation==='advance');expect(rows.reduce((sum,row)=>sum+(row.localQueries??0),0)).toBe(12);expect([...new Set(rows.map(row=>row.batchId))]).toEqual([1,2,3]);
    }finally{await live.dispose();await replay.dispose();}
  },15000);
  it.each(['service','pool'] as const)('retains first-lease local prefetch through six %s leases with exact cold/replay fallback',async mode=>{
    const geometry=geometries(),nav=new Navigation(64000,64000,[...walls]),state=inline(geometry).exportState(),executor=mode==='service'?new PathWorkerService({workerCount:2,performanceDiagnostics:true}):new PathWorkerPool({workerCount:2,performanceDiagnostics:true}),live=await RemotePathScheduler.create(profiles,state,geometry,executor),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry);
    const body={id:'prefetched',xMm:8000,zMm:8000,radiusMm:350},blocker={id:'blocker',xMm:9000,zMm:8000,radiusMm:350},target={xMm:14000,zMm:8000},neighbors=new UnitSpatialIndex(),parallel=new LocalAvoidance();neighbors.set(body);neighbors.set(blocker);parallel.beginTick(1,0);parallel.step(body,target,800,nav,neighbors);parallel.beginTick(2,1);
    const before=parallel.exportState(),queries=parallel.prepareServiceQueries('p1',1,[{body,target}],neighbors,()=>true,8,1);expect(queries).toHaveLength(1);expect(parallel.exportState()).toEqual(before);
    try{
      for(const scheduler of [live,replay])expect(scheduler.startServiceLeases(64,geometry,2,6,queries)).toBe(true);
      for(let turn=0;turn<200&&!live.serviceStatus().ready;turn++)await new Promise(resolve=>setTimeout(resolve,10));
      const admission=live.admitServiceLeases()!;expect(admission.leases).toHaveLength(6);expect(replay.admitServiceLeases(6)).toEqual(admission);
      const results=live.takeLocalResults();expect(results).toHaveLength(1);expect(replay.takeLocalResults()).toEqual(results);expect(live.takeLocalResults()).toEqual([]);
      const rows=executor.diagnostics().trace!.rows.filter(row=>row.kind==='request'&&row.operation==='advance');expect(rows.reduce((sum,row)=>sum+(row.localQueries??0),0)).toBe(1);expect(rows.filter(row=>row.localQueries).every(row=>row.batchId===1)).toBe(true);
      parallel.installParallelResults(results,nav,1,8);parallel.beginTick(3,1,true);expect(parallel.parallelDiagnostics().pending).toBe(1);
      const cold=new LocalAvoidance();cold.importState(before);cold.beginTick(3,1);const expected=cold.step(body,target,800,nav,neighbors);expect(parallel.step(body,target,800,nav,neighbors)).toEqual(expected);expect(parallel.exportState()).toEqual(cold.exportState());expect(parallel.parallelDiagnostics().used).toBe(1);
      await live.synchronizeCapture();replay.synchronizeCaptureSynchronous();expect(live.exportState()).toEqual(replay.exportState());
    }finally{await live.dispose();await replay.dispose();}
  },15000);
  it('prepares bounded retry lookahead in waiting-age order without spending contact credits',()=>{
    const nav=new Navigation(64000,64000,[]),avoidance=new LocalAvoidance(),neighbors=new UnitSpatialIndex(),target={xMm:30000,zMm:8000},bodies=Array.from({length:5},(_,index)=>({id:`waiting_${index}`,xMm:8000+index*1000,zMm:8000,radiusMm:350}));for(const body of bodies)neighbors.set(body);
    avoidance.importState({tick:100,searches:0,routes:bodies.map((body,index)=>[body.id,{target,points:[],retryTick:index===3?107:101+index,lastProgress:false}]),waiting:bodies.slice(0,4).map((body,index)=>[body.id,{firstTick:[30,10,20,5][index]!,lastTick:100}]),grants:[]});
    const before=avoidance.exportState(),candidates=bodies.map(body=>({body,target})).reverse(),queries=avoidance.prepareServiceQueries('p1',1,candidates,neighbors,()=>true,106,2);expect(queries.map(query=>query.body.id)).toEqual(['waiting_1','waiting_2']);expect(avoidance.exportState()).toEqual(before);expect(candidates.map(candidate=>candidate.body.id)).toEqual(bodies.map(body=>body.id).reverse());
    expect(()=>avoidance.prepareServiceQueries('p1',1,candidates,neighbors,()=>true,112,2)).not.toThrow();expect(()=>avoidance.prepareServiceQueries('p1',1,candidates,neighbors,()=>true,113,2)).toThrow('INVALID_LOCAL_PREFETCH_BOUND');expect(()=>avoidance.prepareServiceQueries('p1',1,candidates,neighbors,()=>true,106,9)).toThrow('INVALID_LOCAL_PREFETCH_BOUND');
  });
  it.each(['unchanged','neighbor','geometry','target','expired','generic'] as const)('retains prefetched retry only until eligible and recomputes exactly on %s inputs',change=>{
    const profile='p1',nav=new Navigation(64000,64000,[]),geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],remote=RemotePathScheduler.createSynchronous([profile],new PathScheduler(()=>nav,[profile]).exportState(),geometry),neighbors=new UnitSpatialIndex(),parallel=new LocalAvoidance(),cold=new LocalAvoidance(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},blocker={id:'blocker',xMm:9000,zMm:8000,radiusMm:350},target={xMm:14000,zMm:8000};neighbors.set(body);neighbors.set(blocker);
    parallel.importState({tick:2,searches:0,routes:[[body.id,{target,points:[],retryTick:5,lastProgress:false}]],waiting:[[body.id,{firstTick:1,lastTick:2}]],grants:[]});cold.importState(parallel.exportState());
    const queries=parallel.prepareServiceQueries(profile,1,[{body,target}],neighbors,()=>true,8,1);remote.startServiceLeases(64,geometry,2,3,queries);remote.admitServiceLeases(3);const current=change==='geometry'?new Navigation(64000,64000,[{id:'far',xMm:60000,zMm:60000,halfWidth:100,halfHeight:100}]):nav;
    parallel.installParallelResults(remote.takeLocalResults(),current,change==='geometry'?2:1,change==='expired'?4:8);
    for(let tick=3;tick<5;tick++){parallel.beginTick(tick,1,change!=='generic');cold.beginTick(tick,1);expect(parallel.step(body,target,800,current,neighbors)).toEqual(cold.step(body,target,800,current,neighbors));expect(parallel.exportState()).toEqual(cold.exportState());}
    if(change==='neighbor')neighbors.set({...blocker,zMm:8100});const destination=change==='target'?{...target,zMm:8100}:target;
    parallel.beginTick(5,1,change!=='generic');cold.beginTick(5,1);expect(parallel.step(body,destination,800,current,neighbors)).toEqual(cold.step(body,destination,800,current,neighbors));expect(parallel.exportState()).toEqual(cold.exportState());expect(parallel.parallelDiagnostics().used).toBe(change==='unchanged'?1:0);expect(parallel.parallelDiagnostics().pending).toBe(0);
    const restored=new LocalAvoidance();restored.importState(parallel.exportState());expect(restored.parallelDiagnostics()).toEqual({used:0,pending:0});
  });
  it('dispatches all six small leases on its service thread while the simulation caller is blocked',async()=>{
    const measured:number[]=[],geometry=geometries(),state=inline(geometry).exportState(),service=new PathWorkerService({workerCount:2,performanceDiagnostics:true},elapsed=>{measured.push(elapsed);}),live=await RemotePathScheduler.create(profiles,state,geometry,service),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry);
    try{
      measured.length=0;
      for(const scheduler of [live,replay]){scheduler.request(request('p1'));expect(scheduler.startServiceLeases(64,geometry,6,6)).toBe(true);}
      // Deliberately prevent this caller from processing any worker replies.
      // Child dispatch timestamps prove the service did not need those turns.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
      const unblockedAt=Number(process.hrtime.bigint())/1e6;
      for(let turn=0;turn<100&&!live.serviceStatus().ready;turn++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(measured.length).toBeGreaterThanOrEqual(4);expect(measured.every(value=>Number.isFinite(value)&&value>=0)).toBe(true);
      const admission=live.admitServiceLeases()!;expect(admission.leases).toHaveLength(6);expect(replay.admitServiceLeases(6)).toEqual(admission);
      const diagnostics=service.diagnostics(),advances=diagnostics.trace!.rows.filter(row=>row.kind==='request'&&row.operation==='advance');
      expect(diagnostics.workerCount).toBe(2);expect(diagnostics.serviceThreadId).toBeGreaterThan(0);
      expect(diagnostics.workers.every(worker=>worker.threadId!==diagnostics.serviceThreadId)).toBe(true);
      expect(advances).toHaveLength(12);expect(advances.every(row=>row.workerFinishedAtMs!<unblockedAt)).toBe(true);
      expect([...new Set(advances.map(row=>row.batchId))]).toEqual([1,2,3,4,5,6]);
      await live.synchronizeCapture();replay.synchronizeCaptureSynchronous();expect(live.exportState()).toEqual(replay.exportState());
    }finally{await live.dispose();await replay.dispose();}
  },15000);
  it('measures synchronous service-result retention without charging planner wait or changing admission state',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState(),samples:number[]=[];let kernel:PersistentPathPlanningKernel|undefined,complete!:(value:any)=>void,submitted!:PathPlanningBatch,now=0;
    const executor:PathPlanningExecutor={initialize:async(owners,saved,sources)=>{kernel=new PersistentPathPlanningKernel(owners,saved,sources);return kernel.reply();},advance:async batch=>kernel!.advance(batch),advanceService:batch=>{submitted=batch;return new Promise(resolve=>{complete=resolve;});},capture:async()=>kernel!.exportState(),dispose:async()=>{},observeCoordinatorWork:elapsed=>{samples.push(elapsed);throw new Error('DIAGNOSTIC_OBSERVER');}};
    const live=await RemotePathScheduler.create(profiles,state,geometry,executor),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry),originalClone=structuredClone;
    const clock=vi.spyOn(performance,'now').mockImplementation(()=>now),clone=vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{if(Array.isArray(value)&&value[0]?.nodeBudget!==undefined)now+=4;return originalClone(value,options);});
    try{
      for(const scheduler of [live,replay]){scheduler.request(request('p1'));scheduler.startServiceLeases(64,geometry,6,2);}
      const first=kernel!.advance(submitted),last=kernel!.advance({...submitted,batchId:submitted.batchId+1,geometry:[],operations:[]});now+=5000;expect(samples).toEqual([]);
      complete({leases:[{batchId:first.batchId,report:first.report},{batchId:last.batchId,report:last.report}],reply:last});await Promise.resolve();
      expect(samples).toEqual([8,0]);expect(live.serviceStatus().ready).toBe(true);expect(live.admitServiceLeases()).toEqual(replay.admitServiceLeases(2));
      await live.synchronizeCapture();replay.synchronizeCaptureSynchronous();expect(live.exportState()).toEqual(replay.exportState());
    }finally{clock.mockRestore();clone.mockRestore();await live.dispose();await replay.dispose();}
  });
  it('stops an autonomous sixty-lease series at an acknowledged lease and preserves newer commands through capture/replay',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState(),service=new PathWorkerService({workerCount:2,checkpointEvery:2}),live=await RemotePathScheduler.create(profiles,state,geometry,service),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry);
    try{
      const first=request('p1'),newer={...first,id:'autonomous-replacement',orderRevision:2,target:{xMm:14000,zMm:8000}};
      for(const scheduler of [live,replay]){scheduler.request(first);scheduler.startServiceLeases(64,geometry,6,60);scheduler.request(newer);scheduler.request(request('p2'));scheduler.cancel(request('p2').unitId);}
      const admission=(await live.drainServiceLeases())!;expect(admission.leases.length).toBeGreaterThanOrEqual(1);expect(admission.leases.length).toBeLessThan(60);
      expect(replay.admitServiceLeases(admission.leases.length)).toEqual(admission);
      expect(live.take(first.unitId,1)).toBeUndefined();expect(live.take(first.unitId,2)).toMatchObject({status:'pending',id:newer.id});
      await live.synchronizeCapture(geometry);replay.synchronizeCaptureSynchronous(geometry);expect(live.exportState()).toEqual(replay.exportState());
      const cold=await RemotePathScheduler.create(profiles,live.exportState(),geometry,new PathWorkerService({workerCount:1}));
      try{for(const scheduler of [live,cold])scheduler.startServiceLeases(64,geometry,12,1);expect((await cold.drainServiceLeases())!.report).toEqual((await live.drainServiceLeases())!.report);await cold.synchronizeCapture();await live.synchronizeCapture();expect(cold.exportState()).toEqual(live.exportState());}finally{await cold.dispose();}
      await live.dispose();await live.dispose();expect(service.diagnostics().serviceThreadId).toBe(-1);
    }finally{await live.dispose();await replay.dispose();}
  },20000);
  it('terminates the service compute children when their owner exits abruptly',async()=>{
    // Run in a separate process: an orphaned ref'ed child worker would prevent
    // natural process exit and trigger the bounded subprocess deadline.
    const script=`import {PathWorkerService} from ${JSON.stringify(new URL('../../../apps/server/src/path-worker-pool.ts',import.meta.url).href)};\nimport {PathScheduler} from ${JSON.stringify(new URL('../src/path-scheduler.ts',import.meta.url).href)};\nimport {Navigation} from ${JSON.stringify(new URL('../src/navigation.ts',import.meta.url).href)};\nconst profiles=['a','b'],geometry=profiles.map(profile=>({profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]})),state=new PathScheduler(()=>new Navigation(64000,64000,[]),profiles).exportState(),service=new PathWorkerService({workerCount:2});await service.initialize(profiles,state,geometry);if(service.diagnostics().workers.length!==2)throw new Error('MISSING_COMPUTE_CHILDREN');await service.worker.terminate();console.log('service-owner-and-children-exited');`;
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{timeout:15000,env:computeWorkerEnvironment()});
    expect(result.stdout.trim()).toBe('service-owner-and-children-exited');
  },20000);
  it('bounds a stalled autonomous save barrier without extending its deadline on repeated stop requests',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState(),service=new PathWorkerService({workerCount:1,recoveryTimeoutMs:50}),remote=await RemotePathScheduler.create(profiles,state,geometry,service);
    const worker=(service as unknown as {worker:{postMessage(value:unknown):void}}).worker,post=worker.postMessage.bind(worker);
    // Drop one caller-owned transport dispatch, leaving a real service owner
    // alive but unable to complete this request. No production fault RPC exists.
    worker.postMessage=value=>{if((value as {type?:string}).type!=='service')post(value);};
    let repeat:NodeJS.Timeout|undefined;
    try{
      remote.startServiceLeases(64,geometry,6,60);const saving=remote.drainServiceLeases();
      repeat=setInterval(()=>remote.stopServiceAfterCurrent(),25);
      await expect(saving).rejects.toThrow('PATH_SERVICE_STOP_TIMEOUT');
      clearInterval(repeat);repeat=undefined;
      await remote.dispose();expect(service.diagnostics().serviceThreadId).toBe(-1);
    }finally{if(repeat)clearInterval(repeat);worker.postMessage=post;await remote.dispose();}
  },15000);

  it.each(['save','boundary'] as const)('stops a sixty-lease series after its current acknowledgement for a %s and replays exactly that partial admission',async mode=>{
    const geometry=geometries(),state=inline(geometry).exportState();let kernel:PersistentPathPlanningKernel|undefined;
    const pending:{batch:PathPlanningBatch;resolve:(reply:PathPlanningReply)=>void}[]=[];
    const executor:PathPlanningExecutor={initialize:async(owners,saved,sources)=>{kernel=new PersistentPathPlanningKernel(owners,saved,sources);return kernel.reply();},advance:batch=>new Promise(resolve=>pending.push({batch,resolve})),capture:async()=>kernel!.exportState(),dispose:async()=>{}};
    const live=await RemotePathScheduler.create(profiles,state,geometry,executor),replay=RemotePathScheduler.createSynchronous(profiles,state,geometry);
    try{
      for(const scheduler of [live,replay]){scheduler.request(request('p1'));scheduler.startServiceLeases(64,geometry,6,60);}
      for(let index=0;index<2;index++){const current=pending.shift()!;current.resolve(kernel!.advance(current.batch));await Promise.resolve();}
      expect(pending).toHaveLength(1);const saving=mode==='save'?live.drainServiceLeases():undefined;
      if(mode==='boundary'){expect(live.stopServiceAfterCurrent()).toBe(true);expect(live.admitServiceLeases()).toBeUndefined();expect(live.serviceStatus().ready).toBe(false);}
      const current=pending.shift()!;current.resolve(kernel!.advance(current.batch));await Promise.resolve();
      const admission=(saving?await saving:live.admitServiceLeases())!;expect(admission.leases).toHaveLength(3);expect(pending).toHaveLength(0);
      expect(replay.admitServiceLeases(3)).toEqual(admission);
      await live.synchronizeCapture();replay.synchronizeCaptureSynchronous();expect(replay.exportState()).toEqual(live.exportState());
    }finally{await live.dispose();await replay.dispose();}
  });
  it('runs six small frozen leases while orders remain responsive and admits only the recorded boundary',async()=>{
    const geometry=geometries(),expected=inline(geometry);let kernel:PersistentPathPlanningKernel|undefined;
    const pending:{batch:PathPlanningBatch;resolve:(reply:PathPlanningReply)=>void}[]=[],seen:PathPlanningBatch[]=[];
    const executor:PathPlanningExecutor={initialize:async(owners,state,sources)=>{kernel=new PersistentPathPlanningKernel(owners,state,sources);return kernel.reply();},advance:batch=>new Promise(resolve=>{seen.push(batch);pending.push({batch,resolve});}),capture:async()=>kernel!.exportState(),dispose:async()=>{}};
    const remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,executor);
    const replay=RemotePathScheduler.createSynchronous(profiles,expected.exportState(),geometry);
    const initial={...request('p1'),target:{xMm:10000,zMm:8000}};
    try{
      for(const scheduler of [expected,remote,replay])scheduler.request(initial);
      expect(remote.startServiceLeases(64,geometry,6)).toBe(true);expect(replay.startServiceLeases(64,geometry,6)).toBe(true);
      expect(remote.startServiceLeases(64,geometry,6)).toBe(false);expect(remote.admitServiceLeases()).toBeUndefined();
      expect(remote.take(initial.unitId,1)?.status).toBe('pending');expect(replay.take(initial.unitId,1)?.status).toBe('pending');
      const newer={...initial,id:'new-order',orderRevision:2,target:{xMm:14000,zMm:8000}};
      for(const scheduler of [remote,replay]){scheduler.request(newer);scheduler.request(request('p2'));scheduler.cancel(request('p2').unitId);}
      const reports=[];for(let index=0;index<6;index++){
        expect(pending).toHaveLength(1);const next=pending.shift()!;reports.push(expected.advance(64,6));next.resolve(kernel!.advance(next.batch));await Promise.resolve();
      }
      expect(pending).toHaveLength(0);expect(seen).toHaveLength(6);expect(seen[0]!.operations).toHaveLength(1);expect(seen.slice(1).every(batch=>!batch.operations.length&&!batch.geometry.length)).toBe(true);
      expect(remote.serviceStatus()).toEqual({pending:true,ready:true,completedLeases:6});
      expect(remote.take(initial.unitId,1)).toBeUndefined();expect(remote.take(initial.unitId,2)).toMatchObject({status:'pending',id:'new-order'});
      const admission=remote.admitServiceLeases()!;expect(replay.admitServiceLeases()).toEqual(admission);
      expect(admission.leases.map(lease=>lease.report)).toEqual(reports);expect(admission.leases.map(lease=>lease.batchId)).toEqual([1,2,3,4,5,6]);expect(admission.report.work).toBe(reports.reduce((sum,report)=>sum+report.work,0));
      expect(remote.take(initial.unitId,2)).toMatchObject({status:'pending',id:'new-order'});expect(remote.take(request('p2').unitId,1)).toBeUndefined();
      expected.request(newer);expected.request(request('p2'));expected.cancel(request('p2').unitId);
      const capturing=remote.synchronizeCapture(geometry);const flush=pending.shift()!;flush.resolve(kernel!.advance(flush.batch));await capturing;
      replay.synchronizeCaptureSynchronous(geometry);expect(remote.exportState()).toEqual(expected.exportState());expect(replay.exportState()).toEqual(remote.exportState());
    }finally{await remote.dispose();await replay.dispose();}
  });
  it('rejects stale ready geometry before admission and requires explicit admission before a save',()=>{
    const geometry=geometries(),reference=inline(geometry),remote=RemotePathScheduler.createSynchronous(profiles,reference.exportState(),geometry),item={...request('p1'),target:{xMm:10000,zMm:8000}};
    remote.request(item);remote.startServiceLeases(64,geometry,6,2);
    expect(()=>remote.synchronizeCaptureSynchronous()).toThrow('PATH_SERVICE_REQUIRES_ADMISSION');
    const value=geometry.find(item=>item.profile==='p1')!;value.revision++;value.obstacles=[...value.obstacles,{id:'new-post',xMm:9000,zMm:8000,halfWidth:200,halfHeight:200}];
    remote.invalidate('p1',[{xMm:8800,zMm:7800,widthMm:400,depthMm:400}]);
    expect(remote.admitServiceLeases()!.leases).toHaveLength(2);expect(remote.take(item.unitId,1)?.status).toBe('pending');
    remote.synchronizeCaptureSynchronous(geometry);const saved=remote.exportState();expect(saved.tasks[0]!.result).toBeUndefined();expect(saved.tasks[0]!.stage).toBe('direct');
    const cold=RemotePathScheduler.createSynchronous(profiles,saved,geometry);cold.startServiceLeases(4000,geometry,12);remote.startServiceLeases(4000,geometry,12);
    // A restored executor begins a fresh transport sequence, but deterministic
    // work and current legal geometry must produce exactly the same route.
    expect(cold.admitServiceLeases()!.report).toEqual(remote.admitServiceLeases()!.report);
    expect(cold.take(item.unitId,1)).toEqual(remote.take(item.unitId,1));
    cold.synchronizeCaptureSynchronous();remote.synchronizeCaptureSynchronous();expect(cold.exportState()).toEqual(remote.exportState());
  });
  it('bounds frozen lease counts and never leaks a rejection as an unhandled background promise',async()=>{
    const geometry=geometries(),state=inline(geometry).exportState(),executor:PathPlanningExecutor={initialize:async()=>({batchId:0,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]}),advance:async()=>{throw new Error('FIXTURE_WORKER_FAILED');},capture:async()=>state,dispose:async()=>{}};
    const remote=await RemotePathScheduler.create(profiles,state,geometry,executor);
    try{
      expect(()=>remote.startServiceLeases(64,geometry,6,61)).toThrow('INVALID_PATH_SERVICE_LEASE_LIMIT');expect(remote.startServiceLeases(64,geometry,6,1)).toBe(true);
      await expect(remote.drainServiceLeases()).rejects.toThrow('FIXTURE_WORKER_FAILED');expect(()=>remote.admitServiceLeases()).toThrow('FIXTURE_WORKER_FAILED');
    }finally{await remote.dispose();}
  });
});

describe('persistent parallel path ownership',()=>{
  it.each(['request','region','route','ordinary'] as const)('keeps coordinator and planner invalidation stamps identical for %s clearance',async source=>{
    const profile='p1',owners=[profile],nav=new Navigation(64000,64000,[]),reference=new PathScheduler(()=>nav,owners),state=reference.exportState();
    const giant={...request(profile),id:'giant',unitId:'giant',radiusMm:2400,from:{xMm:40000,zMm:40000},target:{xMm:48000,zMm:40000}};
    if(source==='request')state.tasks.push({...giant,stage:'direct',lineStep:0,lineSteps:32});
    if(source==='region')state.regions.push({key:`${profile}:2400:0,0`,profile,radiusMm:2400,x:0,z:0,labels:Array(256).fill(-2),cursor:0,frontier:[],frontierCursor:0,label:0,complete:false});
    if(source==='route')state.routes.push([`${profile}:2400:0,0,0:1,0,0`,{profile,radiusMm:2400,points:[{xMm:24000,zMm:8000}],regions:[{region:'0,0',revision:0},{region:'1,0',revision:0}],corridor:['0,0','1,0']}]);
    reference.importState(state);
    const geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],remote=RemotePathScheduler.createSynchronous(owners,state,geometry),small={...request(profile),target:{xMm:12000,zMm:8000}},rect={xMm:18000,zMm:18000,widthMm:100,depthMm:100};
    try{
      for(const scheduler of [reference,remote]){scheduler.request(small);scheduler.invalidate(profile,[rect]);}
      remote.synchronizeCaptureSynchronous(geometry);expect(remote.exportState()).toEqual(reference.exportState());
      const stamp={region:'0,0',revision:source==='ordinary'?0:1};expect(remote.isCurrent(profile,[stamp])).toBe(true);
      // A real ready result must remain usable on the next movement callback.
      reference.advance(128);await remote.advanceAsync(128,geometry);const answer=remote.take(small.unitId,1);
      expect(answer).toEqual(reference.take(small.unitId,1));expect(answer?.status).toBe('ready');
      if(answer?.status==='ready')expect(remote.isCurrent(profile,answer.regions)).toBe(true);
      remote.synchronizeCaptureSynchronous();const saved=remote.exportState(),cold=RemotePathScheduler.createSynchronous(owners,JSON.parse(JSON.stringify(saved)),geometry);
      try{cold.invalidate(profile,[rect]);cold.synchronizeCaptureSynchronous();const next=cold.exportState();expect(cold.isCurrent(profile,[{region:'0,0',revision:next.revisions[`${profile}:0,0`]??0}])).toBe(true);}finally{await cold.dispose();}
    }finally{await remote.dispose();}
  });
  it('freezes invalidation clearance before later requests and retains it after cancellation',async()=>{
    const profile='p1',nav=new Navigation(64000,64000,[]),geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],remote=RemotePathScheduler.createSynchronous([profile],new PathScheduler(()=>nav,[profile]).exportState(),geometry),rect={xMm:18000,zMm:18000,widthMm:100,depthMm:100};
    try{
      remote.invalidate(profile,[rect]);
      remote.request({...request(profile),radiusMm:2400});remote.cancel(request(profile).unitId);
      remote.synchronizeCaptureSynchronous();const saved=remote.exportState();expect(saved.invalidationClearances).toEqual({[profile]:2400});expect(saved.tasks).toEqual([]);expect(saved.regions).toEqual([]);expect(saved.routes).toEqual([]);
      const cold=RemotePathScheduler.createSynchronous([profile],JSON.parse(JSON.stringify(saved)),geometry);
      try{for(const scheduler of [remote,cold]){scheduler.invalidate(profile,[rect]);scheduler.synchronizeCaptureSynchronous();}expect(cold.exportState()).toEqual(remote.exportState());}finally{await cold.dispose();}
      const revisions=remote.exportState().revisions;expect(revisions[`${profile}:0,0`]).toBe(1);expect(revisions[`${profile}:1,1`]).toBe(2);
      expect(remote.isCurrent(profile,[{region:'0,0',revision:1},{region:'1,1',revision:2}])).toBe(true);
    }finally{await remote.dispose();}
  });
  it('rejects stale service results across queued giant-envelope edits and replays the same admission',async()=>{
    const profile='p1',owners=[profile],nav=new Navigation(64000,64000,[]),state=new PathScheduler(()=>nav,owners).exportState();
    state.regions.push({key:`${profile}:2400:0,0`,profile,radiusMm:2400,x:0,z:0,labels:Array(256).fill(-2),cursor:0,frontier:[],frontierCursor:0,label:0,complete:false});
    const geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}];let kernel:PersistentPathPlanningKernel|undefined;
    const pending:{batch:PathPlanningBatch;resolve:(reply:PathPlanningReply)=>void}[]=[];
    const executor:PathPlanningExecutor={initialize:async(profiles,saved,geometries)=>{kernel=new PersistentPathPlanningKernel(profiles,saved,geometries);return kernel.reply();},advance:batch=>new Promise(resolve=>pending.push({batch,resolve})),capture:async()=>kernel!.exportState(),dispose:async()=>{}};
    const live=await RemotePathScheduler.create(owners,state,geometry,executor),replay=RemotePathScheduler.createSynchronous(owners,state,geometry),item={...request(profile),target:{xMm:12000,zMm:8000}};
    try{
      for(const scheduler of [live,replay]){scheduler.request(item);scheduler.startServiceLeases(64,geometry,6,1);scheduler.invalidate(profile,[{xMm:18000,zMm:18000,widthMm:100,depthMm:100}]);}
      const next=pending.shift()!;next.resolve(kernel!.advance(next.batch));await Promise.resolve();
      expect(live.admitServiceLeases()).toEqual(replay.admitServiceLeases(1));expect(live.take(item.unitId,1)?.status).toBe('pending');expect(replay.take(item.unitId,1)?.status).toBe('pending');
      const flush=live.synchronizeCapture();const queued=pending.shift()!;expect(queued.batch.operations).toContainEqual({type:'invalidate',profile,rectangles:[{xMm:18000,zMm:18000,widthMm:100,depthMm:100}],clearanceMm:2400});queued.resolve(kernel!.advance(queued.batch));await flush;replay.synchronizeCaptureSynchronous();expect(live.exportState()).toEqual(replay.exportState());
      const advancing=live.advanceAsync(64,geometry),work=pending.shift()!;work.resolve(kernel!.advance(work.batch));await advancing;await replay.advanceAsync(64,geometry);
      const answer=live.take(item.unitId,1);expect(answer).toEqual(replay.take(item.unitId,1));expect(answer?.status).toBe('ready');if(answer?.status==='ready')expect(live.isCurrent(profile,answer.regions)).toBe(true);
    }finally{await live.dispose();await replay.dispose();}
  });
  it('validates explicit giant clearance before invalidating and supports legacy queued edits',()=>{
    const profile='p1',nav=new Navigation(64000,64000,[]),reference=new PathScheduler(()=>nav,[profile]);reference.request({...request(profile),radiusMm:2400});
    const before=reference.exportState(),rect={xMm:18000,zMm:18000,widthMm:100,depthMm:100};
    for(const clearance of [1000,NaN,Infinity]){expect(()=>reference.invalidate(profile,[rect],clearance)).toThrow('INVALID_PATH_CLEARANCE');expect(reference.exportState()).toEqual(before);}
    const kernel=new PersistentPathPlanningKernel([profile],before,[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}]);kernel.advance({batchId:1,grants:[],geometry:[],operations:[{type:'invalidate',profile,rectangles:[rect]}]});reference.invalidate(profile,[rect]);expect(kernel.exportState()).toEqual(reference.exportState());
  });
  it('keeps giant-envelope stamps current through a real worker checkpoint and recovery',async()=>{
    const profile='p1',owners=[profile],geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],nav=new Navigation(64000,64000,[]),reference=new PathScheduler(()=>nav,owners);reference.request({...request(profile),id:'giant',unitId:'giant',radiusMm:2400,target:{xMm:12000,zMm:8000}});
    const pool=new PathWorkerPool({workerCount:1,checkpointEvery:1}),remote=await RemotePathScheduler.create(owners,reference.exportState(),geometry,pool),small={...request(profile),target:{xMm:11000,zMm:8000}};
    try{
      for(const scheduler of [reference,remote]){scheduler.request(small);scheduler.invalidate(profile,[{xMm:18000,zMm:18000,widthMm:100,depthMm:100}]);}
      reference.advance(64);await remote.advanceAsync(64,geometry);const answer=remote.take(small.unitId,1);expect(answer).toEqual(reference.take(small.unitId,1));expect(answer?.status).toBe('ready');if(answer?.status==='ready')expect(remote.isCurrent(profile,answer.regions)).toBe(true);
      await remote.synchronizeCapture();expect(remote.exportState()).toEqual(reference.exportState());
      await (pool as unknown as {slots:{worker:{terminate():Promise<number>}}[]}).slots[0]!.worker.terminate();
      const rect={xMm:18000,zMm:18000,widthMm:100,depthMm:100};for(const scheduler of [reference,remote])scheduler.invalidate(profile,[rect]);await remote.synchronizeCapture();expect(remote.exportState()).toEqual(reference.exportState());expect(remote.isCurrent(profile,[{region:'0,0',revision:2}])).toBe(true);expect(pool.diagnostics().workers[0]!.recoveries).toBe(1);
    }finally{await remote.dispose();}
  });
  it('combines zero-credit boundary edits and capture in one native request per partition',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({workerCount:2}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    const posts:{type:string;checkpoint?:boolean;batch?:{grants:unknown[]}}[]=[];
    const slots=(pool as unknown as {slots:{worker:{postMessage(message:any):void}}[]}).slots;
    for(const slot of slots){const send=slot.worker.postMessage.bind(slot.worker);slot.worker.postMessage=message=>{posts.push(message);send(message);};}
    try{
      for(const scheduler of [expected,remote]){scheduler.request(request('p1'));scheduler.request(request('p2'));scheduler.cancel(request('p2').unitId);}
      const disclosed={id:'far-tree',xMm:62000,zMm:1000,halfWidth:350,halfHeight:350};
      geometry[0]={...geometry[0]!,revision:2,obstacles:[...geometry[0]!.obstacles,disclosed]};
      for(const scheduler of [expected,remote])scheduler.invalidate(geometry[0].profile,[{xMm:61650,zMm:650,widthMm:700,depthMm:700}]);
      const before=expected.exportState();await remote.synchronizeCapture(geometry);
      expect(remote.exportState()).toEqual(before);expect(remote.exportState().profileCursors).toEqual({});
      expect(posts).toHaveLength(2);expect(posts.every(message=>message.type==='advance'&&message.checkpoint===true&&message.batch!.grants.length===0)).toBe(true);
      await remote.synchronizeCapture(geometry);expect(posts).toHaveLength(2);
      const captured=await pool.capture();captured.tasks[0]!.target.xMm=999999;captured.regions.length=0;
      expect(await pool.capture()).toEqual(before);expect(remote.exportState()).toEqual(before);expect(posts).toHaveLength(2);
      await expect(pool.advanceAndCapture({batchId:2,operations:[],geometry:[],grants:[{profile:'p1',nodeBudget:1}]})).rejects.toThrow('PATH_CAPTURE_REQUIRES_ZERO_CREDITS');
    }finally{await remote.dispose();}
  });

  it('keeps separate zero-credit advance and capture for executors without the optional combined operation',async()=>{
    const geometry=geometries(),expected=inline(geometry);let kernel:PersistentPathPlanningKernel|undefined,advances=0,captures=0;
    const executor:PathPlanningExecutor={
      initialize:async(owners,state,sources)=>{kernel=new PersistentPathPlanningKernel(owners,state,sources);return kernel.reply();},
      advance:async batch=>{advances++;expect(batch.grants).toEqual([]);return kernel!.advance(batch);},
      capture:async()=>{captures++;return kernel!.exportState();},dispose:async()=>{},
    };
    const remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,executor);
    try{
      for(const scheduler of [expected,remote])scheduler.request(request('p1'));
      await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect({advances,captures}).toEqual({advances:1,captures:1});
      await remote.synchronizeCapture();expect({advances,captures}).toEqual({advances:1,captures:1});
    }finally{await remote.dispose();}
  });

  it('piggybacks bounded periodic recovery checkpoints on acknowledged native advances',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({workerCount:2,checkpointEvery:2}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    const posts:{type:string;checkpoint?:boolean;batch?:{batchId:number}}[]=[];
    const slots=(pool as unknown as {slots:{worker:{postMessage(message:any):void}}[]}).slots;
    for(const slot of slots){const send=slot.worker.postMessage.bind(slot.worker);slot.worker.postMessage=message=>{posts.push(message);send(message);};}
    try{
      for(const scheduler of [expected,remote])for(const profile of profiles)scheduler.request(request(profile));
      for(let tick=1;tick<=6;tick++){
        expect(await remote.advanceAsync(16,geometry,[],tick)).toEqual(expected.advance(16,tick));
        expect(pool.diagnostics().workers.every(worker=>worker.retainedBatches<2&&worker.acknowledgedBatch===tick)).toBe(true);
      }
      expect(posts).toHaveLength(12);expect(posts.every(message=>message.type==='advance')).toBe(true);
      expect(posts.filter(message=>message.checkpoint).map(message=>message.batch!.batchId)).toEqual([2,2,4,4,6,6]);
      await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(posts).toHaveLength(12);
      const captured=await pool.capture();captured.tasks[0]!.from.xMm=999999;
      expect(await pool.capture()).toEqual(expected.exportState());expect(posts).toHaveLength(12);
    }finally{await remote.dispose();}
  });

  it('captures boundary geometry before invalidating corner provenance, without advancing or charging work',async()=>{
    const owners=['a'],ridge={id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000},sources=Array.from({length:256},(_,index)=>({...ridge,id:`ridge_${index}`}));
    let nav=new Navigation(192000,160000,sources);
    const expected=new PathScheduler(()=>nav,owners),geometry:PathPlanningGeometry[]=[{profile:'a',revision:1,widthMm:nav.widthMm,heightMm:nav.heightMm,obstacles:sources}];
    expected.request({id:'boundary_corner',unitId:'scout',profile:'a',orderRevision:1,from:{xMm:16000,zMm:80000},target:{xMm:144000,zMm:80000},radiusMm:850});
    for(let credit=0;credit<800;credit++){expected.advance(1);if(expected.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
    expect(expected.exportState().tasks[0]!.corner?.phase).toBe('search');
    const remote=await RemotePathScheduler.create(owners,expected.exportState(),geometry,new PathWorkerPool({workerCount:1}));let cold:RemotePathScheduler|undefined;
    try{
      // Newly seen earlier-ordinal geometry changes the source prefix outside
      // every proved corner/edge. Capture occurs before the next movement tick.
      const disclosed={id:'earlier_tree',xMm:180000,zMm:140000,halfWidth:350,halfHeight:350};geometry[0]={...geometry[0]!,revision:2,obstacles:[disclosed,...sources]};nav=new Navigation(192000,160000,[...geometry[0].obstacles]);
      const change={xMm:179650,zMm:139650,widthMm:700,depthMm:700};expected.invalidate('a',[change]);remote.invalidate('a',[change]);
      const before=expected.exportState();expect(before.tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true});
      await remote.synchronizeCapture(geometry);expect(remote.exportState()).toEqual(before);expect(expected.exportState()).toEqual(before);
      cold=await RemotePathScheduler.create(owners,remote.exportState(),geometry,new PathWorkerPool({workerCount:1}));
      for(let batch=0;batch<300;batch++){
        const report=expected.advance(512);expect(await remote.advanceAsync(512,geometry)).toEqual(report);expect(await cold.advanceAsync(512,geometry)).toEqual(report);
        const task=expected.exportState().tasks[0]!;expect(['direct','corner']).not.toContain(task.stage);if(task.result)break;
      }
      const result=expected.take('scout',1);expect(remote.take('scout',1)).toEqual(result);expect(cold.take('scout',1)).toEqual(result);expect(result?.status).toBe('ready');
      if(result?.status==='ready'){let from={xMm:16000,zMm:80000};for(const point of result.points){expect(nav.clearLine(from,point,850)).toBe(true);from=point;}}
    }finally{await remote.dispose();await cold?.dispose();}
  });
  it('keeps changed corner sources in coarse preparation across worker restore and continuing distant edits',async()=>{
    const owners=['a'],ridge={id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000},far={id:'far_tree',xMm:180000,zMm:140000,halfWidth:350,halfHeight:350};let nav=new Navigation(192000,160000,[ridge]);
    const geometry=[{profile:'a',revision:1,widthMm:192000,heightMm:160000,obstacles:[ridge]}],expected=new PathScheduler(()=>nav,owners),remote=await RemotePathScheduler.create(owners,expected.exportState(),geometry,new PathWorkerPool({workerCount:1}));let cold:RemotePathScheduler|undefined;
    try{
      for(const scheduler of [expected,remote])scheduler.request({id:'long',unitId:'scout',profile:'a',orderRevision:1,from:{xMm:16000,zMm:80000},target:{xMm:144000,zMm:80000},radiusMm:850});
      for(let batch=0;batch<20;batch++){expect(await remote.advanceAsync(16,geometry)).toEqual(expected.advance(16));if(expected.exportState().tasks[0]!.corner?.sweepStep!>1)break;}
      expect(expected.exportState().tasks[0]!.corner?.phase).toBe('search');geometry[0]!.revision++;geometry[0]!.obstacles=[ridge,far];nav=new Navigation(192000,160000,geometry[0]!.obstacles);
      for(const scheduler of [expected,remote])scheduler.invalidate('a',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);
      expect(remote.take('scout',1)?.status).toBe('pending');expect(await remote.advanceAsync(0,geometry)).toEqual(expected.advance(0));await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(remote.exportState().tasks[0]).toMatchObject({stage:'coarse',prepareEndpoints:true});
      cold=await RemotePathScheduler.create(owners,remote.exportState(),geometry,new PathWorkerPool({workerCount:2}));
      for(let batch=0;batch<300;batch++){
        geometry[0]!.revision++;geometry[0]!.obstacles=batch%2?[ridge,far]:[ridge];nav=new Navigation(192000,160000,geometry[0]!.obstacles);
        for(const scheduler of [expected,remote,cold])scheduler.invalidate('a',[{xMm:179650,zMm:139650,widthMm:700,depthMm:700}]);
        const report=expected.advance(512);expect(await remote.advanceAsync(512,geometry)).toEqual(report);expect(await cold.advanceAsync(512,geometry)).toEqual(report);
        await remote.synchronizeCapture();await cold.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(cold.exportState()).toEqual(expected.exportState());
        const task=expected.exportState().tasks[0]!;expect(['direct','corner']).not.toContain(task.stage);if(task.result)break;
      }
      const result=expected.take('scout',1);expect(remote.take('scout',1)).toEqual(result);expect(cold.take('scout',1)).toEqual(result);expect(result?.status).toBe('ready');
      if(result?.status==='ready'){let previous={xMm:16000,zMm:80000};for(const point of result.points){expect(nav.clearLine(previous,point,850)).toBe(true);previous=point;}}
    }finally{await remote.dispose();await cold?.dispose();}
  });
  it('keeps bent corner searches identical across worker pools, cold restore and off-direct-leg invalidation',async()=>{
    const owners=['a','b'],obstacles=[{id:'ridge',xMm:72000,zMm:80000,halfWidth:4000,halfHeight:24000}],nav=new Navigation(192000,160000,obstacles),geometry=owners.map(profile=>({profile,revision:1,widthMm:nav.widthMm,heightMm:nav.heightMm,obstacles})),expected=new PathScheduler(()=>nav,owners);
    const remote=await RemotePathScheduler.create(owners,expected.exportState(),geometry,new PathWorkerPool({workerCount:2}));let cold:RemotePathScheduler|undefined;
    try{
      for(const scheduler of [expected,remote])for(const profile of owners)scheduler.request({id:`corner_${profile}`,unitId:`scout_${profile}`,profile,orderRevision:1,from:{xMm:16000,zMm:80000},target:{xMm:144000,zMm:80000},radiusMm:850});
      for(let batch=0;batch<20;batch++){expect(await remote.advanceAsync(64,geometry)).toEqual(expected.advance(64));if(expected.exportState().tasks.every(task=>task.corner?.sweepStep!>0))break;}
      const saved=expected.exportState();expect(saved.tasks.every(task=>task.stage==='corner')).toBe(true);await remote.synchronizeCapture();expect(remote.exportState()).toEqual(saved);
      cold=await RemotePathScheduler.create(owners,saved,geometry,new PathWorkerPool({workerCount:1}));
      for(let batch=0;batch<30;batch++){const report=expected.advance(512);expect(await remote.advanceAsync(512,geometry)).toEqual(report);expect(await cold.advanceAsync(512,geometry)).toEqual(report);await remote.synchronizeCapture();await cold.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(cold.exportState()).toEqual(expected.exportState());if(expected.exportState().tasks.every(task=>task.result))break;}
      const result=expected.exportState().tasks[0]!.result;expect(result?.status).toBe('ready');if(result?.status!=='ready')return;
      const point=result.points[0]!,rectangle={xMm:point.xMm-100,zMm:point.zMm-100,widthMm:200,depthMm:200};expect(Math.abs(point.zMm-80000)).toBeGreaterThan(16000);
      for(const scheduler of [expected,remote,cold])scheduler.invalidate('a',[rectangle]);expect(remote.take('scout_a',1)?.status).toBe('pending');expect(cold.take('scout_a',1)?.status).toBe('pending');
      const report=expected.advance(0);expect(await remote.advanceAsync(0,geometry)).toEqual(report);expect(await cold.advanceAsync(0,geometry)).toEqual(report);await remote.synchronizeCapture();await cold.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(cold.exportState()).toEqual(expected.exportState());
    }finally{await remote.dispose();await cold?.dispose();}
  });
  it('preserves eager authorized geometry history with empty and completed queues across threaded cold continuation',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}];
    const reference=new Simulation({factions,seed:'idle-navigation-history',matchId:'idle-navigation-history',controllers:false,sharedVision:false});
    for(const [id,entity]of Object.entries(reference.state.entities))if(entity.kind!=='building')delete reference.state.entities[id];
    reference.state.map.terrain=[];reference.state.navigationRevision++;
    for(const vision of Object.values(reference.state.vision)){vision.memory={};vision.visible=[];vision.explored=[];vision.actions={};}
    // The current start layout has a Town Center ending at z=50m here; keep
    // this navigation-history fixture outside that real footprint plus radius.
    for(const [id,ownerId,xMm,zMm]of [['idle_a','a',45000,54000],['idle_b','b',250000,250000]] as const){
      const unit:Unit={id,ownerId,xMm,zMm,kind:'unit',typeId:'scout',hp:units.scout.maxHp,maxHp:units.scout.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',autoGather:false};
      reference.state.entities[id]=unit;
    }
    const gate:Building={id:'idle_gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:55000,zMm:50000,rotation:0,hp:100,maxHp:100,work:100,required:100,grantedHp:100,queue:[],cooldown:0,gateMode:'LOCKED',gateOpen:false};
    reference.state.entities[gate.id]=gate;
    for(const [id,xMm,zMm]of [['visible_gold',49000,53000],['hidden_gold',248000,253000]] as const){
      const resource:ResourceNode={id,kind:'resource',typeId:'gold_mine',ownerId:null,xMm,zMm,hp:1,maxHp:1,resource:'gold',amount:100000};reference.state.entities[id]=resource;
    }
    // Prime actual fog and profile history before attaching the remote scheduler.
    reference.step(2);
    const threaded=new Simulation(reference.options,reference.capture()),pool=new PathWorkerPool({workerCount:2});
    let cold:Simulation|undefined,coldPool:PathWorkerPool|undefined;
    const active=()=>cold?[reference,threaded,cold]:[reference,threaded];
    const scheduler=(sim:Simulation)=>(sim as unknown as {pathScheduler:PathScheduler|RemotePathScheduler}).pathScheduler;
    const profile=(sim:Simulation,id:string)=>sim.capture().runtime.planningProfiles.find(([owner])=>owner===id)![1];
    const boundary=async()=>{
      reference.step();await threaded.stepAsync();if(cold)await cold.stepAsync();
      for(const sim of active().slice(1)){
        await sim.synchronizeCapture();expect(sim.capture()).toEqual(reference.capture());expect(sim.pathDiagnostics()).toEqual(reference.pathDiagnostics());
        expect(sim.views(['a','b'])).toEqual(reference.views(['a','b']));expect(sim.state.pathAdmission).toEqual(reference.state.pathAdmission);
      }
    };
    try{
      await threaded.attachPlanningExecutor(pool);
      expect(reference.capture().runtime.pathScheduler.tasks).toEqual([]);
      expect(reference.view('a').entities.some(entity=>entity.id==='hidden_gold')).toBe(false);
      const initial=profile(reference,'a');
      // An empty request queue must not postpone an authorized gate change.
      for(const sim of active())(sim.state.entities.idle_gate as Building).gateMode='AUTO';
      await boundary();expect(profile(reference,'a').revision).toBeGreaterThan(initial.revision);
      expect(reference.capture().runtime.pathScheduler.tasks).toEqual([]);
      for(const sim of active())for(const owner of ['a','b']){
        const unit=sim.state.entities[`idle_${owner}`] as Unit;
        scheduler(sim).request({id:`retained_${owner}`,unitId:unit.id,profile:owner,orderRevision:0,from:{xMm:unit.xMm,zMm:unit.zMm},target:owner==='a'?{xMm:46000,zMm:54000}:{xMm:0,zMm:0},radiusMm:units.scout.collisionRadiusM*1000,workClass:'routine',enqueuedTick:sim.state.tick});
      }
      await boundary();
      expect(reference.pathDiagnostics()).toMatchObject({pending:0,ready:1,blocked:1});
      cold=new Simulation(reference.options,threaded.capture());coldPool=new PathWorkerPool({workerCount:1});await cold.attachPlanningExecutor(coldPool);
      const beforeHidden=profile(reference,'a'),beforeOwner=profile(reference,'b');
      for(const sim of active())(sim.state.entities.hidden_gold as ResourceNode).amount=0;
      await boundary();expect(profile(reference,'a')).toEqual(beforeHidden);expect(profile(reference,'b').revision).toBeGreaterThan(beforeOwner.revision);
      for(const mutate of [
        (sim:Simulation)=>{(sim.state.entities.visible_gold as ResourceNode).amount=0;},
        (sim:Simulation)=>{(sim.state.entities.idle_gate as Building).work=50;},
        (sim:Simulation)=>{(sim.state.entities.idle_gate as Building).work=100;},
        (sim:Simulation)=>{(sim.state.entities.idle_gate as Building).gateMode='LOCKED';},
      ]){
        const before=profile(reference,'a').revision;for(const sim of active())mutate(sim);
        await boundary();expect(profile(reference,'a').revision).toBeGreaterThan(before);expect(reference.pathDiagnostics()).toMatchObject({pending:0,ready:1,blocked:1});
      }
      for(const owner of ['a','b']){
        const result=scheduler(reference).take(`idle_${owner}`,0);expect(result?.status).toBe(owner==='a'?'ready':'blocked');
        expect(scheduler(threaded).take(`idle_${owner}`,0)).toEqual(result);expect(scheduler(cold).take(`idle_${owner}`,0)).toEqual(result);
      }
      await boundary();expect(reference.capture().runtime.pathScheduler.tasks).toEqual([]);
      expect(pool.diagnostics().workers.every(worker=>worker.recoveries===0&&worker.threadId>0)).toBe(true);
      expect(coldPool.diagnostics().workers).toHaveLength(1);
    }finally{await pool.close();await coldPool?.close();}
  },30000);

  it('traces actual worker wall intervals without changing grants, capture or disclosing request geometry',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({performanceDiagnostics:true,workerCount:2}),creating=RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    const startup=pool.diagnostics().trace!;expect(startup.active.length).toBe(2);expect(startup.active.every(row=>row.operation==='initialize'&&row.ageMs>=0)).toBe(true);
    const remote=await creating;
    try{
      for(const profile of profiles){expected.request(request(profile));remote.request(request(profile));}
      const query={profile:'p1',geometryRevision:1,body:{id:'private_local_body',xMm:8000,zMm:8000,radiusMm:350},target:{xMm:14000,zMm:8000},cellMm:250 as const,neighbors:[]};
      for(let tick=1;tick<=8;tick++)expect(await remote.advanceAsync(16,geometry,tick===1?[query]:[],tick)).toEqual(expected.advance(16,tick));
      await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));
      const trace=pool.diagnostics().trace!,rows=trace.rows.filter(row=>row.kind==='request');expect(trace.active).toEqual([]);expect(trace.omitted).toBe(0);
      expect(rows.some(row=>row.operation==='initialize')).toBe(true);expect(rows.some(row=>row.operation==='capture')).toBe(true);expect(rows.some(row=>row.operation==='advance'&&row.localQueries===1)).toBe(true);
      expect(new Set(rows.map(row=>row.threadId)).size).toBe(2);
      for(const row of rows){expect(row.outcome).toBe('completed');expect(row.postReturnedAtMs).toBeGreaterThanOrEqual(row.startedAtMs);expect(row.workerStartedAtMs).toBeGreaterThanOrEqual(row.startedAtMs);expect(row.workerFinishedAtMs).toBeGreaterThanOrEqual(row.workerStartedAtMs!);expect(row.finishedAtMs).toBeGreaterThanOrEqual(row.workerFinishedAtMs!);expect(row.elapsedMs).toBeCloseTo(row.dispatchToWorkerMs!+row.workerElapsedMs!+row.returnToCoordinatorMs!,6);}
      expect(trace.scope).toContain('not CPU');expect(trace.scope).toContain('cold startup');expect(JSON.stringify(trace)).not.toMatch(/private_local_body|r_p1|u_p1|"p1"|xMm|zMm|radiusMm|halfWidth/);
      trace.rows[0]!.startedAtMs=-1;expect(pool.diagnostics().trace!.rows[0]!.startedAtMs).toBeGreaterThan(0);expect(JSON.stringify(remote.exportState())).not.toContain('workerStartedAtMs');
    }finally{await remote.dispose();}
  });
  it('bounds trace retention while preserving the startup prefix and keeps normal mode trace-free',async()=>{
    const geometry=geometries().map(item=>({...item,obstacles:[]})),expected=inline(geometry),pool=new PathWorkerPool({performanceDiagnostics:true,workerCount:1,checkpointEvery:256}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    try{
      const prefix=pool.diagnostics().trace!.rows.slice();
      for(let tick=1;tick<=80;tick++)expect(await remote.advanceAsync(0,geometry,[],tick)).toEqual(expected.advance(0,tick));
      const trace=pool.diagnostics().trace!;expect(trace.rows.length).toBeLessThanOrEqual(256);expect(trace.omitted).toBeGreaterThan(0);expect(trace.rows.slice(0,prefix.length)).toEqual(prefix);expect(trace.rows.some(row=>row.batchId===80)).toBe(true);
      await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));
    }finally{await remote.dispose();}
    const off=new PathWorkerPool();try{expect(off.diagnostics()).not.toHaveProperty('trace');}finally{await off.close();}
  });
  it('preserves pending bent endpoint bridges and exact routes through two-worker and one-worker cold continuation',async()=>{
    const owners=['a','b'],from={xMm:117691,zMm:197588},target={xMm:120850,zMm:190000},obstacles=[...Array.from({length:6},(_,index)=>({id:`berry_${index}`,xMm:114000+index%3*2200,zMm:196500+Math.floor(index/3)*2200,halfWidth:650,halfHeight:650})),{id:'proposed_house',xMm:118000,zMm:190000,halfWidth:2000,halfHeight:2000}],nav=new Navigation(256000,256000,obstacles),geometry=owners.map(profile=>({profile,revision:1,widthMm:256000,heightMm:256000,obstacles})),expected=new PathScheduler(()=>nav,owners);
    const remote=await RemotePathScheduler.create(owners,expected.exportState(),geometry,new PathWorkerPool({workerCount:2}));let cold:RemotePathScheduler|undefined;
    try{
      for(const scheduler of [expected,remote])for(const profile of owners)scheduler.request({id:`bridge_${profile}`,unitId:`worker_${profile}`,profile,orderRevision:1,from:profile==='a'?from:target,target:profile==='a'?target:from,radiusMm:350});
      for(let index=0;index<100;index++){expected.advance(2);await remote.advanceAsync(2,geometry);if(expected.exportState().tasks.every(task=>task.startBridge?.cursor||task.endBridge?.cursor))break;}
      const saved=expected.exportState();expect(saved.tasks.every(task=>task.startBridge?.cursor||task.endBridge?.cursor)).toBe(true);await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(saved));
      cold=await RemotePathScheduler.create(owners,JSON.parse(JSON.stringify(saved)),geometry,new PathWorkerPool({workerCount:1}));
      for(let index=0;index<40;index++){const report=expected.advance(512);expect(await remote.advanceAsync(512,geometry)).toEqual(report);expect(await cold.advanceAsync(512,geometry)).toEqual(report);await remote.synchronizeCapture();await cold.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));expect(JSON.stringify(cold.exportState())).toBe(JSON.stringify(expected.exportState()));if(expected.exportState().tasks.every(task=>task.result))break;}
      for(const profile of owners){const result=expected.take(`worker_${profile}`,1);expect(remote.take(`worker_${profile}`,1)).toEqual(result);expect(cold.take(`worker_${profile}`,1)).toEqual(result);expect(result?.status).toBe('ready');if(result?.status==='ready'){let prior=profile==='a'?from:target;for(const point of result.points){expect(nav.clearLine(prior,point,350)).toBe(true);prior=point;}expect(prior).toEqual(profile==='a'?target:from);}}
    }finally{await remote.dispose();await cold?.dispose();}
  });
  it('reports actual classified queue ages and lifecycle outcomes without changing threaded state',async()=>{
    const geometry=geometries().map(item=>({...item,obstacles:[]})),expected=inline(geometry),control=inline(geometry);
    const remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,new PathWorkerPool());let tick=10,ms=1000;
    expected.enablePathDiagnostics({tick:()=>tick,now:()=>ms});remote.enablePathDiagnostics({tick:()=>tick,now:()=>ms});
    try{
      const inputs=profiles.flatMap(profile=>(['interactive','routine','optional'] as const).map((workClass,index)=>({...request(profile,index),workClass,enqueuedTick:10})));
      for(const item of inputs)for(const scheduler of [expected,control,remote])scheduler.request(item);
      expect(remote.queueSummary(tick)).toEqual({...expected.queueSummary(tick),attemptScope:'coordinator-committed-events'});expect(remote.queueSummary(tick).pending).toBe(12);
      expect(remote.pathDiagnostics()).toMatchObject({collection:'coordinator-observation',executionAvailable:false,counts:{requests:12},active:{pending:12}});
      tick=11;ms=1050;expect(await remote.advanceAsync(4,geometry,[],tick)).toEqual(expected.advance(4,tick));control.advance(4,tick);
      tick=45;ms=3000;const affected={xMm:8000,zMm:8000,widthMm:3000,depthMm:100};for(const scheduler of [expected,control,remote])scheduler.invalidate('p1',[affected]);
      tick=50;ms=3500;const summary=remote.queueSummary(tick);expect(summary).toEqual({...expected.queueSummary(tick),attemptScope:'coordinator-committed-events'});
      const routine=summary.profiles.find(profile=>profile.profile==='p1')!.classes.find(row=>row.workClass==='routine')!;
      expect(routine).toMatchObject({pending:1,agedRoutine:1,requestAgeTicks:{oldest:40,p95:40},attemptAgeTicks:{oldest:5,p95:5}});
      expect(remote.pathDiagnostics()!.counts.restarts).toBe(expected.pathDiagnostics()!.counts.restarts);
      for(const scheduler of [expected,control,remote])scheduler.cancel(inputs[0]!.unitId);
      const blocked={...request('p3',4),id:'blocked',unitId:'blocked',target:{xMm:0,zMm:0},workClass:'interactive' as const,enqueuedTick:50};for(const scheduler of [expected,control,remote])scheduler.request(blocked);
      expected.advance(4000,tick);control.advance(4000,tick);await remote.advanceAsync(4000,geometry,[],tick);
      expect(remote.queueSummary(tick)).toEqual({...expected.queueSummary(tick),attemptScope:'coordinator-committed-events'});expect(remote.queueSummary(tick)).toMatchObject({pending:0,ready:11,blocked:1});
      for(const item of [...inputs,blocked])expect(remote.take(item.unitId,item.orderRevision)).toEqual(expected.take(item.unitId,item.orderRevision));
      for(const item of [...inputs,blocked])control.take(item.unitId,item.orderRevision);
      expect(remote.pathDiagnostics()!.counts).toMatchObject({canceled:1,takenReady:11,takenBlocked:1,ready:11,blocked:1});expect(remote.queueSummary(tick).total).toBe(0);
      await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(control.exportState()));expect(JSON.stringify(expected.exportState())).toBe(JSON.stringify(control.exportState()));
      expect(JSON.stringify(remote.exportState())).not.toMatch(/requestAgeTicks|attemptAgeTicks|pathCensus|coordinator-observation/);
    }finally{await remote.dispose();}
  });
  it('retains known enqueue age after cold restore while honestly marking prior attempt and wall age unknown',async()=>{
    const geometry=geometries().map(item=>({...item,obstacles:[]})),original=inline(geometry);original.request({...request('p1'),workClass:'routine',enqueuedTick:5});original.advance(1,6);
    const saved=original.exportState(),remote=await RemotePathScheduler.create(profiles,saved,geometry,new PathWorkerPool({workerCount:1}));let tick=50;
    try{
      expect(remote.pathDiagnostics()).toBeUndefined();expect(remote.queueSummary(tick).profiles[0]!.classes[1]!).toMatchObject({requestAgeTicks:{oldest:45},attemptAgeTicks:{unknown:1,oldest:null}});
      remote.enablePathDiagnostics({tick:()=>tick,now:()=>5000});expect(remote.pathDiagnostics()).toMatchObject({pendingAges:{originalTicks:{oldest:45},originalMs:{unknown:1},restartTicks:{unknown:1}}});
      expect(remote.exportState()).toEqual(saved);
      remote.invalidate('p1',[{xMm:8000,zMm:8000,widthMm:100,depthMm:100}]);tick=53;
      expect(remote.queueSummary(tick).profiles[0]!.classes[1]!).toMatchObject({requestAgeTicks:{oldest:48},attemptAgeTicks:{oldest:3,unknown:0}});
      await remote.synchronizeCapture();expect(remote.pathDiagnostics()!.counts).toMatchObject({requests:0,restarts:1,invalidations:1});
      expect(remote.queueSummary(tick).pending).toBe(1);
    }finally{await remote.dispose();}
  });
  it('automatically shares a coarse frontier once, preserves it across partitions and keeps each subscriber fine path legal',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({checkpointEvery:8}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    let saved:ReturnType<PathScheduler['exportState']>|undefined;
    try{
      for(const scheduler of [expected,remote])for(const profile of ['p1','p2'])for(let index=0;index<3;index++)scheduler.request({...request(profile,index),target:{xMm:56000,zMm:52000},workClass:index===0?'interactive':'routine',enqueuedTick:0});
      for(let tick=1;tick<180;tick++){
        const report=expected.advance(256,tick);expect(await remote.advanceAsync(256,geometry,[],tick)).toEqual(report);
        const state=expected.exportState();if(state.sharedJobs!.registry.jobs.length){saved=state;break;}
      }
      expect(saved?.sharedJobs?.registry.jobs.length).toBeGreaterThan(0);await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(saved));
      const restored=await RemotePathScheduler.create(profiles,JSON.parse(JSON.stringify(saved)),geometry,new PathWorkerPool({workerCount:1}));
      try{
        const waiting=saved!.sharedJobs!.registry.jobs[0]!.members[0]!.request;
        for(const scheduler of [expected,remote,restored])scheduler.cancel(waiting.unitId);
        const untouched={xMm:60000,zMm:5000,widthMm:100,depthMm:100};for(const scheduler of [expected,remote,restored])scheduler.invalidate(waiting.profile==='p1'?'p4':'p3',[untouched]);
        for(let tick=(saved!.priority?.tick??0)+1;tick<(saved!.priority?.tick??0)+100;tick++){
          expected.advance(4000,tick);await remote.advanceAsync(4000,geometry,[],tick);await restored.advanceAsync(4000,geometry,[],tick);
          for(const profile of ['p1','p2'])for(let index=0;index<3;index++){
            const item=request(profile,index),result=expected.take(item.unitId,1);expect(remote.take(item.unitId,1)).toEqual(result);expect(restored.take(item.unitId,1)).toEqual(result);
            if(result?.status==='ready'){let prior=item.from;const nav=new Navigation(64000,64000,walls);for(const point of result.points){expect(nav.clearLine(prior,point,item.radiusMm)).toBe(true);prior=point;}}
          }
          if(!expected.exportState().tasks.length)break;
        }
        expect(expected.exportState().tasks).toHaveLength(0);await remote.synchronizeCapture();await restored.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));expect(JSON.stringify(restored.exportState())).toBe(JSON.stringify(expected.exportState()));
      }finally{await restored.dispose();}
    }finally{await remote.dispose();}
  });
  it('does not dispatch speculative detours for units already making progress',()=>{
    const navigation=new Navigation(64000,64000,[]),neighbors=new UnitSpatialIndex(),avoidance=new LocalAvoidance(),body={id:'moving',xMm:8000,zMm:8000,radiusMm:350},target={xMm:14000,zMm:8000};neighbors.set(body);avoidance.beginTick(1,1);expect(avoidance.step(body,target,200,navigation,neighbors)).toBeDefined();avoidance.beginTick(2,1);expect(avoidance.prepareParallelQueries('p1',1,[{body,target}],navigation,neighbors,()=>true)).toEqual([]);
  });
  it('retains repaired shared search progress across actual worker partitions, geometry churn and cold continuation',async()=>{
    const geometry=geometries(),expected=inline(geometry),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,new PathWorkerPool({workerCount:2}));
    let restored:RemotePathScheduler|undefined;
    try{
      for(const scheduler of [expected,remote])for(let index=0;index<2;index++)scheduler.request({...request('p1',index),target:{xMm:56000,zMm:52000},workClass:'routine',enqueuedTick:0});
      for(let tick=1;tick<200;tick++){
        expect(await remote.advanceAsync(256,geometry,[],tick)).toEqual(expected.advance(256,tick));
        if(Object.keys(expected.exportState().sharedJobs!.registry.jobs[0]?.frontier.coarse.scores??{}).length>=4)break;
      }
      const prior=expected.exportState(),job=prior.sharedJobs!.registry.jobs[0]!;expect(job).toBeDefined();
      const endpoints=new Set([...job.frontier.startComponents,...job.frontier.endComponents].map(key=>key.slice(0,key.lastIndexOf(','))));
      const edited=Object.keys(job.frontier.coarse.scores).find(key=>!endpoints.has(key.slice(0,key.lastIndexOf(','))))!,[x,z]=edited.split(',').map(Number);
      const obstacle:Obstacle={id:'new_tree',xMm:x!*16000+8000,zMm:z!*16000+8000,halfWidth:350,halfHeight:350},rectangle={xMm:obstacle.xMm-350,zMm:obstacle.zMm-350,widthMm:700,depthMm:700};
      geometry.find(item=>item.profile==='p1')!.obstacles=[...geometry.find(item=>item.profile==='p1')!.obstacles,obstacle];geometry.find(item=>item.profile==='p1')!.revision++;
      for(const scheduler of [expected,remote])scheduler.invalidate('p1',[rectangle]);
      expect(await remote.advanceAsync(0,geometry)).toEqual(expected.advance(0));await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());
      const repaired=expected.exportState();expect(repaired.sharedJobs!.registry.jobs[0]!.id).toBe(job.id);expect(repaired.sharedJobs!.registry.jobs[0]!.frontier.coarse.scores[edited]).toBeUndefined();
      restored=await RemotePathScheduler.create(profiles,JSON.parse(JSON.stringify(repaired)),geometry,new PathWorkerPool({workerCount:1}));
      geometry.find(item=>item.profile==='p1')!.obstacles=structuredClone(walls);geometry.find(item=>item.profile==='p1')!.revision++;
      for(const scheduler of [expected,remote,restored])scheduler.invalidate('p1',[rectangle]);
      for(let batch=0;batch<100;batch++){
        const report=expected.advance(2048);expect(await remote.advanceAsync(2048,geometry)).toEqual(report);expect(await restored.advanceAsync(2048,geometry)).toEqual(report);
        if(expected.exportState().tasks.every(task=>task.stage==='done'))break;
      }
      for(let index=0;index<2;index++){
        const item=request('p1',index),result=expected.take(item.unitId,1);expect(remote.take(item.unitId,1)).toEqual(result);expect(restored.take(item.unitId,1)).toEqual(result);expect(result?.status).toBe('ready');
        if(result?.status==='ready'){let prior=item.from;const nav=new Navigation(64000,64000,walls);for(const point of result.points){expect(nav.clearLine(prior,point,item.radiusMm)).toBe(true);prior=point;}}
      }
      await remote.synchronizeCapture();await restored.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(restored.exportState()).toEqual(expected.exportState());
    }finally{await restored?.dispose();await remote.dispose();}
  });
  it('bounds configured faction queues to the supported maximum active unit count',()=>{
    const scheduler=new PathScheduler(()=>new Navigation(64000,64000,[]),['p1']);
    for(let index=0;index<2200;index++)scheduler.request({...request('p1'),id:`r${index}`,unitId:`u${index}`,workClass:'routine',enqueuedTick:0});
    expect(()=>scheduler.request({...request('p1'),id:'overflow',unitId:'overflow',workClass:'interactive',enqueuedTick:1})).toThrow('PATH_TASK_LIMIT');expect(scheduler.exportState().tasks).toHaveLength(2200);
    scheduler.cancel('u0');scheduler.request({...request('p1'),id:'replacement',unitId:'replacement',workClass:'interactive',enqueuedTick:1});expect(scheduler.exportState().tasks).toHaveLength(2200);
  });
  it('persists weighted class service, aging and faction isolation across actual worker capture and restore',async()=>{
    const geometry=geometries().map(item=>({...item,obstacles:[]})),expected=inline(geometry),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,new PathWorkerPool());
    try{
      for(const scheduler of [expected,remote])for(const profile of profiles)for(const [index,workClass]of (['interactive','routine','optional'] as const).entries())scheduler.request({...request(profile,index),workClass,enqueuedTick:0});
      for(let tick=1;tick<=4;tick++){const report=expected.advance(4,tick);expect(await remote.advanceAsync(4,geometry,[],tick)).toEqual(report);await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));}
      const own=expected.exportState().tasks.filter(task=>task.profile==='p1');expect(own.map(task=>task.lineStep)).toEqual([3,1,0]);
      const snapshot=expected.exportState(),restored=new PathScheduler(profile=>new Navigation(64000,64000,[]),profiles);restored.importState(snapshot);
      const change={xMm:8000,zMm:8000,widthMm:100,depthMm:100};for(const scheduler of [expected,restored,remote])scheduler.invalidate('p1',[change]);
      expect(expected.exportState().tasks.filter(task=>task.profile==='p1').every(task=>task.enqueuedTick===0)).toBe(true);
      for(const tick of [5,39,40,41,42]){expected.advance(8,tick);restored.advance(8,tick);await remote.advanceAsync(8,geometry,[],tick);expect(restored.exportState()).toEqual(expected.exportState());}
      await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));
      const aged=expected.exportState().tasks.filter(task=>task.profile==='p1');expect(aged.find(task=>task.workClass==='routine')!.lineStep).toBeGreaterThan(1);expect(aged.find(task=>task.workClass==='optional')!.lineStep).toBe(0);
      for(const scheduler of [expected,remote])for(const item of scheduler.exportState().tasks.filter(task=>task.workClass!=='optional'))scheduler.cancel(item.unitId);
      expected.advance(8,43);await remote.advanceAsync(8,geometry,[],43);await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));expect(expected.exportState().tasks.every(task=>task.lineStep>0)).toBe(true);
    }finally{await remote.dispose();}
  });
  it('preserves both real open-gate posts sharing a building ID through geometry updates and worker recovery',async()=>{
    const gate={id:'gate',typeId:'wooden_gate' as const,ownerId:'p1',xMm:32000,zMm:32000,rotation:0 as const,work:1,required:1,gateMode:'OPEN' as const,gateOpen:true};
    const posts=fortificationObstacles(gate),geometry=geometries().map(item=>({...item,obstacles:posts})),expected=inline(geometry),pool=new PathWorkerPool({checkpointEvery:2}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    expect(posts).toHaveLength(2);expect(posts[0]!.id).toBe(posts[1]!.id);
    try{
      for(let turn=0;turn<3;turn++){
        const target=geometry[0]!.obstacles[0]!;
        for(const scheduler of [expected,remote])scheduler.request({...request('p1'),id:`gate_${turn}`,orderRevision:turn+1,target:{xMm:target.xMm,zMm:target.zMm}});
        expected.advance(4000);await remote.advanceAsync(4000,geometry);expect(expected.take(request('p1').unitId,turn+1)?.status).toBe('blocked');expect(remote.take(request('p1').unitId,turn+1)?.status).toBe('blocked');
        if(turn===0){for(const item of geometry){item.revision++;item.obstacles=[posts[1]!,posts[0]!];}for(const scheduler of [expected,remote])for(const profile of profiles)scheduler.invalidate(profile,[{xMm:28000,zMm:28000,widthMm:8000,depthMm:8000}]);}
        if(turn===1){const owned=pool as unknown as {slots:{worker:{terminate():Promise<number>}}[]};await owned.slots[0]!.worker.terminate();}
      }
      await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));
    }finally{await remote.dispose();}
  });
  it('preserves sorted faction grants, unfinished frontiers and completed results with one and two actual workers',async()=>{
    const geometry=geometries(),expected=inline(geometry),onePool=new PathWorkerPool({workerCount:1,checkpointEvery:5}),twoPool=new PathWorkerPool({workerCount:2,checkpointEvery:5});
    const one=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,onePool),two=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,twoPool);
    try{
      for(const profile of profiles)for(let index=0;index<2;index++)for(const scheduler of [expected,one,two])scheduler.request(request(profile,index));
      for(let tick=0;tick<24;tick++){
        const report=expected.advance(4000);expect(await one.advanceAsync(4000,geometry)).toEqual(report);expect(await two.advanceAsync(4000,geometry)).toEqual(report);
        for(const profile of profiles)for(let index=0;index<2;index++){const value=expected.take(request(profile,index).unitId,1);expect(one.take(request(profile,index).unitId,1)).toEqual(value);expect(two.take(request(profile,index).unitId,1)).toEqual(value);}
        if(tick%6===0){await one.synchronizeCapture();await two.synchronizeCapture();expect(one.exportState()).toEqual(expected.exportState());expect(two.exportState()).toEqual(expected.exportState());expect(JSON.stringify(one.exportState())).toBe(JSON.stringify(expected.exportState()));expect(JSON.stringify(two.exportState())).toBe(JSON.stringify(expected.exportState()));}
      }
      expect(onePool.diagnostics().workers).toHaveLength(1);expect(twoPool.diagnostics().workers).toHaveLength(2);
      expect(new Set(twoPool.diagnostics().workers.map(worker=>worker.threadId)).size).toBe(2);
      await two.synchronizeCapture();const saved=JSON.parse(JSON.stringify(two.exportState())),restored=await RemotePathScheduler.create(profiles,saved,geometry,new PathWorkerPool({workerCount:1}));
      try{expected.importState(saved);for(let tick=0;tick<8;tick++){expected.advance(4000);await restored.advanceAsync(4000,geometry);}await restored.synchronizeCapture();expect(restored.exportState()).toEqual(expected.exportState());}finally{await restored.dispose();}
    }finally{await one.dispose();await two.dispose();}
  });

  it('captures zero-grant requests and cancellations without creating profile cursors or charging work',async()=>{
    const geometry=geometries(),expected=inline(geometry),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,new PathWorkerPool());
    try{
      await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(remote.exportState().profileCursors).toEqual({});
      for(const scheduler of [expected,remote]){scheduler.request(request('p1'));scheduler.request(request('p2'));scheduler.cancel(request('p2').unitId);}
      expect(()=>remote.exportState()).toThrow('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(remote.exportState().profileCursors).toEqual({});
    }finally{await remote.dispose();}
  });

  it('mirrors synchronous invalidation and cancellation while applying immutable geometry deltas',async()=>{
    const geometry=geometries(),expected=inline(geometry),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,new PathWorkerPool());
    try{
      for(const scheduler of [expected,remote]){scheduler.request(request('p1'));scheduler.request({...request('p2'),target:{xMm:12000,zMm:12000}});}
      for(let tick=0;tick<4;tick++){expected.advance(4000);await remote.advanceAsync(4000,geometry);}
      const changed={id:'new-post',xMm:9000,zMm:9000,halfWidth:2000,halfHeight:2000},rect={xMm:7000,zMm:7000,widthMm:4000,depthMm:4000};
      geometry.find(item=>item.profile==='p1')!.revision++;geometry.find(item=>item.profile==='p1')!.obstacles=[...walls,changed];
      for(const scheduler of [expected,remote]){scheduler.invalidate('p1',[rect]);scheduler.cancel(request('p2').unitId);scheduler.request({...request('p2'),id:'replacement',orderRevision:2,target:{xMm:8000,zMm:20000}});}
      expect(remote.take(request('p1').unitId,1)).toEqual(expected.take(request('p1').unitId,1));expect(remote.take(request('p2').unitId,1)).toBeUndefined();
      expected.advance(4000);await remote.advanceAsync(4000,geometry);await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());
      expect(remote.isCurrent('p1',[{region:'0,0',revision:0}])).toBe(false);expect(remote.isCurrent('p2',[{region:'0,0',revision:0}])).toBe(true);
    }finally{await remote.dispose();}
  });

  it('recovers a terminated owned worker from its checkpoint and acknowledged batches without replaying committed grants twice',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool({checkpointEvery:3}),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    try{
      for(const scheduler of [expected,remote])for(const profile of profiles)scheduler.request(request(profile));
      for(let tick=0;tick<5;tick++){expected.advance(4000);await remote.advanceAsync(4000,geometry);}
      const owned=pool as unknown as {slots:{worker:{terminate():Promise<number>}}[]};await owned.slots[0]!.worker.terminate();
      for(let tick=0;tick<3;tick++){expected.advance(4000);await remote.advanceAsync(4000,geometry);}
      await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());expect(pool.diagnostics().workers[0]!.recoveries).toBe(1);expect(pool.diagnostics().workers.every(worker=>worker.retainedBatches===0)).toBe(true);
    }finally{await remote.dispose();}
  });

  it('waits for every predetermined partition and rejects mutation or capture during a batch',async()=>{
    const geometry=geometries(),expected=inline(geometry);let release:()=>void=()=>{};
    const kernels=profiles.map(profile=>new PersistentPathPlanningKernel([profile],partitionPathState(expected.exportState(),[profile]),geometry.filter(item=>item.profile===profile)));
    const executor:PathPlanningExecutor={
      initialize:async()=>mergePathReplies(0,kernels.map(kernel=>kernel.reply())),
      advance:async batch=>{const replies=kernels.map((kernel,index)=>kernel.advance({...batch,grants:batch.grants.filter(grant=>grant.profile===profiles[index]),geometry:batch.geometry.filter(update=>update.profile===profiles[index]),operations:batch.operations.filter(operation=>(operation.type==='request'?operation.request.profile:operation.profile)===profiles[index])}));await new Promise<void>(resolve=>{release=resolve;});return mergePathReplies(batch.batchId,replies.reverse());},
      capture:async()=>mergePathStates(kernels.map(kernel=>kernel.exportState())),dispose:async()=>{},
    };
    const remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,executor);for(const scheduler of [expected,remote])scheduler.request(request('p1'));
    const advancing=remote.advanceAsync(4000,geometry);expect(()=>remote.cancel(request('p1').unitId)).toThrow('PATH_BATCH_IN_PROGRESS');await expect(remote.synchronizeCapture()).rejects.toThrow('PATH_BATCH_IN_PROGRESS');release();await advancing;expected.advance(4000);await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());await remote.dispose();
  });

  it('ignores delayed replies from an obsolete worker generation instead of resurrecting canceled work',async()=>{
    const geometry=geometries(),expected=inline(geometry),pool=new PathWorkerPool(),remote=await RemotePathScheduler.create(profiles,expected.exportState(),geometry,pool);
    try{
      for(const scheduler of [expected,remote]){scheduler.request(request('p1'));scheduler.cancel(request('p1').unitId);scheduler.request({...request('p1'),id:'new_order',orderRevision:2});}
      const owned=pool as unknown as {slots:{worker:{postMessage(message:any):void;emit(name:string,message:unknown):boolean}}[]},worker=owned.slots[0]!.worker,post=worker.postMessage.bind(worker);
      worker.postMessage=(message:any)=>{if(message.type==='advance')queueMicrotask(()=>worker.emit('message',{id:message.id,generation:message.generation-1,threadId:-1,value:{batchId:message.batch.batchId,report:{work:999999},mirrors:[]}}));post(message);};
      const report=expected.advance(4000);expect(await remote.advanceAsync(4000,geometry)).toEqual(report);expect(remote.take(request('p1').unitId,1)).toBeUndefined();await remote.synchronizeCapture();expect(JSON.stringify(remote.exportState())).toBe(JSON.stringify(expected.exportState()));expect(pool.diagnostics().workers.every(item=>item.threadId>0&&item.recoveries===0)).toBe(true);
    }finally{await remote.dispose();}
  });

  it.each([false,true])('uses exact local-detour answers and falls back when moving neighbors invalidate them (changed=%s)',async changed=>{
    const profile='p1',nav=new Navigation(64000,64000,[]),geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],scheduler=new PathScheduler(()=>nav,[profile]),remote=await RemotePathScheduler.create([profile],scheduler.exportState(),geometry,new PathWorkerPool());
    const body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},blocker={id:'blocker',xMm:9000,zMm:8000,radiusMm:350},hidden={id:'hidden',xMm:12000,zMm:12000,radiusMm:350},target={xMm:14000,zMm:8000},neighbors=new UnitSpatialIndex(),expected=new LocalAvoidance(),parallel=new LocalAvoidance(),known=(id:string)=>id!=='hidden';
    for(const item of [body,blocker,hidden])neighbors.set(item);
    try{
      for(const avoidance of [expected,parallel]){avoidance.beginTick(1,0);avoidance.step(body,target,800,nav,neighbors,nav,known);avoidance.beginTick(2,1);}
      const before=parallel.exportState(),queries=parallel.prepareParallelQueries(profile,1,[{body,target}],nav,neighbors,known);expect(queries).toHaveLength(1);expect(queries[0]!.neighbors.map(item=>item.id)).toEqual(['blocker']);expect(parallel.exportState()).toEqual(before);
      await remote.advanceAsync(4000,geometry,queries);parallel.installParallelResults(remote.takeLocalResults(),nav,1);
      if(changed)neighbors.set({...blocker,zMm:8100});
      const position=expected.step(body,target,800,nav,neighbors,nav,known);expect(parallel.step(body,target,800,nav,neighbors,nav,known)).toEqual(position);expect(parallel.exportState()).toEqual(expected.exportState());expect(parallel.parallelDiagnostics().used).toBe(changed?0:1);
      if(position)expect(neighbors.clearLine(body,position,body.radiusMm,body.id)).toBe(true);
      parallel.beginTick(3,1);expect(parallel.parallelDiagnostics().pending).toBe(0);
    }finally{await remote.dispose();}
  });
});
