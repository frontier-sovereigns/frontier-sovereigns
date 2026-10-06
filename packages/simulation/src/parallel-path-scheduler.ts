import type { TerrainRectangle } from '@frontier/shared';
import { Navigation, type Obstacle } from './navigation.js';
import { createOwnedNavigation } from './owned-navigation.js';
import { createNativePathCheckpointScope, claimNativeSerializedPathCheckpoint, decodeNativeSerializedPathCheckpoint, discardNativeSerializedPathCheckpoint, type NativeSerializedPathCheckpoint, type NativePathCheckpoint } from './checkpoint-native.js';
import { PathPlanningCensus, summarizePathQueue, type PathQueueTask } from './path-diagnostics.js';
import { computeLocalPathQuery, type LocalPathQuery, type LocalPathResult } from './movement.js';
import { PathScheduler, PATH_TASK_LIMIT, canonicalPathState, pathProfileGrants, preparePathCheckpointMessage, postPathCheckpointMessage, discardPathCheckpointMessage, type PreparedPathCheckpointMessage, type PathCheckpointEnvelope, type PathDiagnosticClock, type PathPlanningDiagnostics, type PathProfileGrant, type PathRequest, type PathResult, type PathSchedulerState, type PathTaskMirror, type PathWorkReport, type RegionStamp } from './path-scheduler.js';
import { SharedPathJobs } from './shared-path-jobs.js';
import { MessagePort } from 'node:worker_threads';

export interface PathPlanningGeometry {profile:string;revision:number;widthMm:number;heightMm:number;obstacles:readonly Obstacle[]}
export interface PathGeometryUpdate {profile:string;revision:number;widthMm:number;heightMm:number;upserts:[string,Obstacle][];removed:string[];order:string[];replace?:true}
/** Gate posts intentionally share their building ID. Occurrences remain distinct. */
export function pathGeometryEntries(obstacles:readonly Obstacle[]):[string,Obstacle][]{
  const occurrences=new Map<string,number>();return obstacles.map(obstacle=>{const occurrence=occurrences.get(obstacle.id)??0;occurrences.set(obstacle.id,occurrence+1);return [`${obstacle.id}:${occurrence}`,obstacle];});
}
export type PathPlanningOperation = {type:'request';request:PathRequest}|{type:'cancel';profile:string;unitId:string}|{type:'invalidate';profile:string;rectangles:TerrainRectangle[]};
export interface PathPlanningBatch {batchId:number;grants:PathProfileGrant[];operations:PathPlanningOperation[];geometry:PathGeometryUpdate[];localQueries?:LocalPathQuery[];tick?:number;observeRestarts?:true}
export interface PathPlanningReply {batchId:number;report:PathWorkReport;mirrors:PathTaskMirror[];localResults?:LocalPathResult[];restarted?:string[]}
export interface PathPlanningCapturedReply {reply:PathPlanningReply;state:PathSchedulerState}
/** An autonomous owner retains the intermediate mirrors privately. Every small
 * grant still has its own report and acknowledgement; only the last mirror is
 * transferred to the simulation for one recorded boundary admission. */
export interface PathPlanningServiceReply {leases:{batchId:number;report:PathWorkReport}[];reply:PathPlanningReply}
/** Only admission is authoritative. These bounded grant records let replay run
 * the same frozen-boundary work without consulting worker completion timing. */
export interface PathServiceAdmission {leases:{batchId:number;grants:PathProfileGrant[];tick?:number;report:PathWorkReport}[];report:PathWorkReport}
export interface PathPlanningExecutor {
  initialize(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]):Promise<PathPlanningReply>;
  advance(batch:PathPlanningBatch):Promise<PathPlanningReply>;
  advanceService?(first:PathPlanningBatch,maxLeases:number,localQueryLeases?:readonly (readonly LocalPathQuery[])[]):Promise<PathPlanningServiceReply>;
  stopServiceAfterCurrent?():void;
  /** Optional single barrier for a boundary's zero-credit operations and save. */
  advanceAndCapture?(batch:PathPlanningBatch):Promise<PathPlanningCapturedReply>;
  capture():Promise<PathSchedulerState>;
  /** Optional owned-byte lane. Only native completed-boundary captures select it. */
  captureNativeCheckpoint?():Promise<NativeSerializedPathCheckpoint>;
  advanceAndCaptureNative?(batch:PathPlanningBatch):Promise<{reply:PathPlanningReply;checkpoint:NativeSerializedPathCheckpoint}>;
  dispose():Promise<void>;
  diagnostics?():unknown;
  /** Host-only elapsed cost of synchronous coordinator return processing. Never
   * includes planner waiting or receives authority-bearing objects/callbacks. */
  observeCoordinatorWork?(elapsedMs:number):void;
  /** Replay-only executor; frozen work runs when its recorded admission count
   * is known. Never used by the live worker pool. */
  advanceSynchronous?(batch:PathPlanningBatch):PathPlanningReply;
  captureSynchronous?():PathSchedulerState;
}

/** Instrument only synchronous return/copy work, preserving operation results
 * and failures even when an optional diagnostic observer itself throws. */
export function measurePathCoordinator<T>(executor:Pick<PathPlanningExecutor,'observeCoordinatorWork'>,operation:()=>T):T{
  const observe=executor.observeCoordinatorWork;if(!observe)return operation();
  const began=performance.now();
  try{return operation();}finally{const elapsed=performance.now()-began;try{if(Number.isFinite(elapsed)&&elapsed>=0)observe.call(executor,elapsed);}catch{/* Diagnostics cannot change planner behavior. */}}
}

export function partitionPathState(state:PathSchedulerState,profiles:readonly string[]):PathSchedulerState{
  const own=new Set(profiles);
  const shared=state.sharedJobs;
  return canonicalPathState(structuredClone({version:1,tasks:state.tasks.filter(task=>own.has(task.profile)),regions:state.regions.filter(region=>own.has(region.profile)),routes:state.routes.filter(([,route])=>own.has(route.profile)),revisions:Object.fromEntries(Object.entries(state.revisions).filter(([key])=>own.has(key.slice(0,key.lastIndexOf(':'))))),cursor:state.cursor,profileCursors:Object.fromEntries(Object.entries(state.profileCursors??{}).filter(([profile])=>own.has(profile))),...(state.priority?{priority:{tick:state.priority.tick,profiles:Object.fromEntries(Object.entries(state.priority.profiles).filter(([profile])=>own.has(profile)))}}:{}),...(shared?{sharedJobs:{geometryVersions:Object.fromEntries(Object.entries(shared.geometryVersions).filter(([profile])=>own.has(profile))),registry:{version:1,serials:Object.fromEntries(Object.entries(shared.registry.serials).filter(([profile])=>own.has(profile))),waiting:shared.registry.waiting.filter(member=>own.has(member.request.profile)),jobs:shared.registry.jobs.filter(job=>own.has(job.frontier.profile))}}}:{})}));
}
export function mergePathStates(states:readonly PathSchedulerState[]):PathSchedulerState{
  const priorities=states.flatMap(state=>state.priority?[state.priority]:[]);
  const shared=states.flatMap(state=>state.sharedJobs?[state.sharedJobs]:[]),compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  return canonicalPathState({version:1,tasks:states.flatMap(state=>state.tasks),regions:states.flatMap(state=>state.regions),routes:states.flatMap(state=>state.routes),revisions:Object.assign({},...states.map(state=>state.revisions)),cursor:0,profileCursors:Object.assign({},...states.map(state=>state.profileCursors??{})),...(priorities.length?{priority:{tick:Math.max(...priorities.map(priority=>priority.tick)),profiles:Object.assign({},...priorities.map(priority=>priority.profiles))}}:{}),...(shared.length?{sharedJobs:{geometryVersions:Object.assign({},...shared.map(value=>value.geometryVersions)),registry:{version:1,serials:Object.fromEntries(Object.entries(Object.assign({},...shared.map(value=>value.registry.serials)) as Record<string,number>).sort(([a],[b])=>compare(a,b))),waiting:shared.flatMap(value=>value.registry.waiting).sort((a,b)=>compare(a.request.profile,b.request.profile)),jobs:shared.flatMap(value=>value.registry.jobs).sort((a,b)=>compare(a.frontier.profile,b.frontier.profile))}}}:{})});
}
export function mergePathReplies(batchId:number,replies:readonly PathPlanningReply[]):PathPlanningReply{
  if(replies.some(reply=>reply.batchId!==batchId))throw new Error('STALE_PATH_BATCH');
  const report:PathWorkReport={work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0};
  for(const reply of replies)for(const key of Object.keys(report) as (keyof PathWorkReport)[])report[key]+=reply.report[key];
  return {batchId,report,mirrors:replies.flatMap(reply=>reply.mirrors).sort((a,b)=>a.request.profile<b.request.profile?-1:a.request.profile>b.request.profile?1:0),localResults:replies.flatMap(reply=>reply.localResults??[]),...(replies.some(reply=>reply.restarted)?{restarted:replies.flatMap(reply=>reply.restarted??[])}:{})};
}

/** Transport-independent owner of persistent profile geometry, search heaps and caches. */
export class PersistentPathPlanningKernel {
  private readonly scheduler:PathScheduler;
  private readonly geometries=new Map<string,{revision:number;navigation:Navigation;obstacles:Map<string,Obstacle>}>();
  private lastBatch=0;
  constructor(private readonly profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]){
    if(!profiles.length||new Set(profiles).size!==profiles.length)throw new Error('INVALID_PATH_PROFILES');
    this.scheduler=new PathScheduler(profile=>{const value=this.geometries.get(profile);if(!value)throw new Error('MISSING_PATH_GEOMETRY');return value.navigation;},profiles);
    for(const value of geometry){const entries=pathGeometryEntries(value.obstacles);this.updateGeometry({...value,upserts:entries,removed:[],order:entries.map(([key])=>key),replace:true});}
    if(profiles.some(profile=>!this.geometries.has(profile)))throw new Error('MISSING_PATH_GEOMETRY');
    this.scheduler.importState(partitionPathState(state,profiles));
  }
  private updateGeometry(update:PathGeometryUpdate):void{
    if(!this.profiles.includes(update.profile)||!Number.isSafeInteger(update.revision)||update.revision<0||update.widthMm<=0||update.heightMm<=0)throw new Error('INVALID_PATH_GEOMETRY');
    const prior=this.geometries.get(update.profile);
    if(prior&&update.revision<prior.revision)throw new Error('STALE_PATH_GEOMETRY');
    const obstacles=update.replace?new Map<string,Obstacle>():new Map(prior?.obstacles);
    for(const id of update.removed)obstacles.delete(id);
    for(const [key,obstacle] of update.upserts)obstacles.set(key,{...obstacle});
    if(update.order.length!==obstacles.size||new Set(update.order).size!==obstacles.size||update.order.some(key=>!obstacles.has(key)))throw new Error('INVALID_PATH_GEOMETRY_ORDER');
    const ordered=new Map(update.order.map(key=>[key,obstacles.get(key)!]));
    this.geometries.set(update.profile,{revision:update.revision,obstacles:ordered,navigation:createOwnedNavigation(update.widthMm,update.heightMm,[...ordered.values()])});
  }
  reply():PathPlanningReply{return {batchId:this.lastBatch,report:this.scheduler.advanceProfiles([]),mirrors:this.scheduler.taskMirrors()};}
  advance(batch:PathPlanningBatch):PathPlanningReply{
    if(!Number.isSafeInteger(batch.batchId)||batch.batchId!==this.lastBatch+1)throw new Error('STALE_PATH_BATCH');
    for(const update of batch.geometry)this.updateGeometry(update);
    for(const operation of batch.operations){
      const profile=operation.type==='request'?operation.request.profile:operation.profile;
      if(!this.profiles.includes(profile))throw new Error('FOREIGN_PATH_OPERATION');
      if(operation.type==='request')this.scheduler.request(operation.request);
      else if(operation.type==='cancel')this.scheduler.cancel(operation.unitId);
      else this.scheduler.invalidate(operation.profile,operation.rectangles);
    }
    const restarted=batch.observeRestarts?new Set<string>():undefined;
    if(restarted)this.scheduler.observeAttemptRestarts(unitId=>restarted.add(unitId));
    let report:PathWorkReport;try{report=this.scheduler.advanceProfiles(batch.grants,batch.tick);}finally{this.scheduler.observeAttemptRestarts(undefined);}
    const localResults:LocalPathResult[]=[];
    if((batch.localQueries?.length??0)>this.profiles.length*8)throw new Error('LOCAL_PATH_QUERY_LIMIT');
    for(const query of batch.localQueries??[]){const geometry=this.geometries.get(query.profile);if(!geometry||geometry.revision!==query.geometryRevision)throw new Error('STALE_LOCAL_PATH_GEOMETRY');localResults.push(computeLocalPathQuery(query,geometry.navigation));}
    this.lastBatch=batch.batchId;
    return {batchId:this.lastBatch,report,mirrors:this.scheduler.taskMirrors(),localResults,...(restarted?.size?{restarted:[...restarted]}:{})};
  }
  exportState():PathSchedulerState{return this.scheduler.exportState();}
  postNativeCheckpoint(port:MessagePort,message:PreparedPathCheckpointMessage):void{this.scheduler.postNativeCheckpoint(port,message);}
  /** The transport restores acknowledged checkpoint sequence before replaying its bounded log. */
  restoreBatch(batchId:number):void{if(!Number.isSafeInteger(batchId)||batchId<0)throw new Error('INVALID_PATH_BATCH');this.lastBatch=batchId;}
}

const checkpointKernelPrototypes=[PersistentPathPlanningKernel.prototype,PathScheduler.prototype,SharedPathJobs.prototype,Navigation.prototype,Object.getPrototypeOf(createOwnedNavigation(1000,1000,[]))].map(prototype=>({prototype,parent:Object.getPrototypeOf(prototype),entries:Reflect.ownKeys(prototype).map(key=>({key,expected:Object.getOwnPropertyDescriptor(prototype,key)!}))}));
const checkpointKernelSurfaceCurrent=()=>checkpointKernelPrototypes.every(({prototype,parent,entries})=>{
  if(Object.getPrototypeOf(prototype)!==parent||Reflect.ownKeys(prototype).length!==entries.length)return false;
  // Retain the descriptor table once; do not allocate five whole descriptor
  // maps and enumerate them again on every ordinary worker lease.
  return entries.every(({key,expected})=>{const actual=Object.getOwnPropertyDescriptor(prototype,key);return actual&&actual.value===expected.value&&actual.get===expected.get&&actual.set===expected.set&&actual.configurable===expected.configurable&&actual.enumerable===expected.enumerable&&actual.writable===expected.writable;});
});
const checkpointKernelClone=globalThis.structuredClone;
const checkpointKernelHasRef=Function.prototype.call.bind(MessagePort.prototype.hasRef) as (port:MessagePort)=>boolean;
/** Compute-worker owner. The kernel/scheduler never leave this closure; inputs
 * already crossed the worker IPC boundary and retained request/geometry fields
 * are detached by their canonical methods. No additional per-advance copy.
 * Any observed custom helper permanently selects the detached export fallback. */
export function createNativePathPlanningKernel(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]){
  const initial=checkpointKernelClone({profiles,state,geometry});
  let native=checkpointKernelSurfaceCurrent();
  const kernel=new PersistentPathPlanningKernel(initial.profiles,initial.state,initial.geometry);
  const check=()=>{native=native&&checkpointKernelSurfaceCurrent();return native;};
  return Object.freeze({
    advance(batch:PathPlanningBatch){check();try{return kernel.advance(batch);}finally{check();}},
    reply(){check();try{return kernel.reply();}finally{check();}},
    restoreBatch(batchId:number){check();kernel.restoreBatch(batchId);check();},
    exportState(){check();try{return kernel.exportState();}finally{check();}},
    postCheckpoint(port:MessagePort,envelope:PathCheckpointEnvelope,reply?:PathPlanningReply){
      try{checkpointKernelHasRef(port);}catch{throw new Error('INVALID_NATIVE_CHECKPOINT_PORT');}
      // Detach caller-controlled metadata before the last native-surface check.
      // Getter hooks cannot run between owned state assembly and intrinsic post.
      const message=preparePathCheckpointMessage(envelope,reply);
      try{if(check())kernel.postNativeCheckpoint(port,message);else postPathCheckpointMessage(port,message,kernel.exportState());}finally{discardPathCheckpointMessage(message);}
    },
  });
}

/** Coordinator read mirror. Only immutable operations cross to the path owners. */
export class RemotePathScheduler {
  private mirrors=new Map<string,PathTaskMirror>();
  private revisions:Record<string,number>={};
  private geometry=new Map<string,PathPlanningGeometry>();
  private operations:PathPlanningOperation[]=[];
  private batchId=0;
  private busy=false;
  private disposed=false;
  private cachedSnapshot:PathSchedulerState|undefined;
  private cachedSerialized:NativeSerializedPathCheckpoint|undefined;
  private readonly nativeCheckpointScope=createNativePathCheckpointScope();
  private get cachedState():PathSchedulerState|undefined{return this.cachedSnapshot;}
  private set cachedState(value:PathSchedulerState|undefined){this.nativeCheckpointScope.invalidate();if(this.cachedSerialized)discardNativeSerializedPathCheckpoint(this.cachedSerialized);this.cachedSerialized=undefined;this.cachedSnapshot=value;}
  private retainSerialized(handle:NativeSerializedPathCheckpoint):void{const claimed=claimNativeSerializedPathCheckpoint(handle);this.cachedState=undefined;this.cachedSerialized=claimed;}
  private localResults:LocalPathResult[]=[];
  private pathCensus:PathPlanningCensus|undefined;
  private service:{done:boolean;promise:Promise<void>;maximumLeases:number;stopAfterCurrent?:true;runSynchronous?:(leases:number)=>void;admission:PathServiceAdmission;reply?:PathPlanningReply;error?:unknown}|undefined;
  private constructor(private readonly profiles:readonly string[],private readonly executor:PathPlanningExecutor){}
  static async create(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[],executor:PathPlanningExecutor):Promise<RemotePathScheduler>{
    const value=new RemotePathScheduler([...profiles],executor);
    value.revisions=structuredClone(state.revisions);value.cachedState=structuredClone(state);
    for(const item of geometry)value.geometry.set(item.profile,{...item,obstacles:item.obstacles.map(obstacle=>({...obstacle}))});
    value.accept(await executor.initialize(profiles,state,geometry),0);return value;
  }
  static createSynchronous(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]):RemotePathScheduler{
    const kernel=new PersistentPathPlanningKernel(profiles,state,geometry),executor:PathPlanningExecutor={initialize:async()=>kernel.reply(),advance:async batch=>kernel.advance(batch),advanceSynchronous:batch=>kernel.advance(batch),capture:async()=>kernel.exportState(),captureSynchronous:()=>kernel.exportState(),dispose:async()=>{}};
    const value=new RemotePathScheduler([...profiles],executor);value.revisions=structuredClone(state.revisions);value.cachedState=structuredClone(state);
    for(const item of geometry)value.geometry.set(item.profile,{...item,obstacles:item.obstacles.map(obstacle=>({...obstacle}))});value.accept(kernel.reply(),0);return value;
  }
  private assertMutable():void{if(this.disposed)throw new Error('PATH_EXECUTOR_CLOSED');if(this.busy)throw new Error('PATH_BATCH_IN_PROGRESS');}
  private changed(operation:PathPlanningOperation):void{if(this.operations.length>=100000)throw new Error('PATH_OPERATION_QUEUE_FULL');this.operations.push(operation);this.cachedState=undefined;}
  request(request:PathRequest):void{
    this.assertMutable();
    if(!request.id||!request.unitId||!this.profiles.includes(request.profile)||!Number.isSafeInteger(request.orderRevision)||request.orderRevision<0||!Number.isFinite(request.radiusMm)||request.radiusMm<=0||![request.from.xMm,request.from.zMm,request.target.xMm,request.target.zMm].every(Number.isSafeInteger))throw new Error('INVALID_PATH_REQUEST');
    if((request.workClass===undefined)!==(request.enqueuedTick===undefined)||request.workClass!==undefined&&(!['interactive','routine','optional'].includes(request.workClass)||!Number.isSafeInteger(request.enqueuedTick)||request.enqueuedTick!<0))throw new Error('INVALID_PATH_PRIORITY');
    const prior=this.mirrors.get(request.unitId);
    if(prior&&(prior.request.orderRevision>request.orderRevision||(prior.request.id===request.id&&prior.request.orderRevision===request.orderRevision)))return;
    if(!prior&&this.mirrors.size>=PATH_TASK_LIMIT)throw new Error('PATH_TASK_LIMIT');
    const owned=structuredClone(request);this.changed({type:'request',request:owned});
    this.mirrors.set(request.unitId,{request:owned,result:{status:'pending',id:request.id,orderRevision:request.orderRevision},direct:true,usedRegions:[],connectorRegions:[]});
    this.pathCensus?.requested(owned,!!prior);
  }
  cancel(unitId:string):void{
    this.assertMutable();const prior=this.mirrors.get(unitId);if(!prior)return;
    this.changed({type:'cancel',profile:prior.request.profile,unitId});this.mirrors.delete(unitId);this.pathCensus?.canceled(prior.request);
  }
  take(unitId:string,orderRevision:number):PathResult|undefined{
    this.assertMutable();const prior=this.mirrors.get(unitId);if(!prior||prior.request.orderRevision!==orderRevision){this.pathCensus?.taken(undefined,'missing');return;}
    const result=structuredClone(prior.result);this.pathCensus?.taken(prior.request,result.status);
    if(result.status!=='pending'){this.changed({type:'cancel',profile:prior.request.profile,unitId});this.mirrors.delete(unitId);}return result;
  }
  /** Non-consuming check for derived continuation proofs. An admitted global
   * answer must always reach the ordinary take/apply path before travel reuse. */
  hasRequest(unitId:string):boolean{return this.mirrors.has(unitId);}
  invalidate(profile:string,rectangles:readonly TerrainRectangle[]):void{
    this.assertMutable();if(!this.profiles.includes(profile))throw new Error('UNKNOWN_PATH_PROFILE');
    this.changed({type:'invalidate',profile,rectangles:structuredClone([...rectangles])});
    const changed=new Set<string>();
    for(const rect of rectangles)for(let z=Math.floor((rect.zMm-1000)/16000);z<=Math.floor((rect.zMm+rect.depthMm+1000)/16000);z++)for(let x=Math.floor((rect.xMm-1000)/16000);x<=Math.floor((rect.xMm+rect.widthMm+1000)/16000);x++)if(x>=0&&z>=0)changed.add(`${x},${z}`);
    for(const region of changed){const key=`${profile}:${region}`;this.revisions[key]=(this.revisions[key]??0)+1;}
    this.invalidateMirrors(profile,rectangles,changed);
  }
  private invalidateMirrors(profile:string,rectangles:readonly TerrainRectangle[],changed?:ReadonlySet<string>,diagnostics=true):void{
    if(!changed){const regions=new Set<string>();for(const rect of rectangles)for(let z=Math.floor((rect.zMm-1000)/16000);z<=Math.floor((rect.zMm+rect.depthMm+1000)/16000);z++)for(let x=Math.floor((rect.xMm-1000)/16000);x<=Math.floor((rect.xMm+rect.widthMm+1000)/16000);x++)if(x>=0&&z>=0)regions.add(`${x},${z}`);changed=regions;}
    for(const mirror of [...this.mirrors.values()])if(mirror.request.profile===profile){
      const task=mirror.request;
      // Only the worker owns the corner/endpoint preparation frontier. Its
      // stage-aware invalidation may retain progress or enter coarse planning;
      // a pending mirror cannot be consumed as a route, so await that reply
      // instead of inventing a direct-stage restart here.
      if(mirror.result.status==='pending'&&!mirror.direct)continue;
      if(mirror.direct&&!rectangles.some(rect=>rect.xMm<=Math.max(task.from.xMm,task.target.xMm)+task.radiusMm&&rect.xMm+rect.widthMm>=Math.min(task.from.xMm,task.target.xMm)-task.radiusMm&&rect.zMm<=Math.max(task.from.zMm,task.target.zMm)+task.radiusMm&&rect.zMm+rect.depthMm>=Math.min(task.from.zMm,task.target.zMm)-task.radiusMm))continue;
      if(!mirror.usedRegions.length||mirror.usedRegions.some(region=>changed.has(region))||mirror.result.status==='blocked'||mirror.connectorRegions.some(region=>changed.has(region))){
        this.mirrors.delete(task.unitId);this.mirrors.set(task.unitId,{request:task,result:{status:'pending',id:task.id,orderRevision:task.orderRevision},direct:true,usedRegions:[],connectorRegions:[]});
        if(diagnostics&&this.pathCensus){this.pathCensus.invalidated(task.unitId);this.pathCensus.requested(task,false);}
      }
    }
  }
  isCurrent(profile:string,stamps:readonly RegionStamp[]):boolean{return stamps.every(stamp=>(this.revisions[`${profile}:${stamp.region}`]??0)===stamp.revision);}
  private updates(geometry:readonly PathPlanningGeometry[]):PathGeometryUpdate[]{
    const updates:PathGeometryUpdate[]=[];
    for(const item of geometry){
      const prior=this.geometry.get(item.profile);if(prior?.revision===item.revision)continue;
      const old=new Map(prior?pathGeometryEntries(prior.obstacles):[]),entries=pathGeometryEntries(item.obstacles),next=new Set(entries.map(([key])=>key));
      updates.push({profile:item.profile,revision:item.revision,widthMm:item.widthMm,heightMm:item.heightMm,upserts:entries.filter(([key,obstacle])=>{const before=old.get(key);return !before||before.xMm!==obstacle.xMm||before.zMm!==obstacle.zMm||before.halfWidth!==obstacle.halfWidth||before.halfHeight!==obstacle.halfHeight||before.circle!==obstacle.circle;}).map(([key,obstacle])=>[key,{...obstacle}]),removed:[...old.keys()].filter(id=>!next.has(id)),order:entries.map(([key])=>key),...(!prior?{replace:true as const}:{})});
      this.geometry.set(item.profile,{...item,obstacles:item.obstacles.map(obstacle=>({...obstacle}))});
    }
    return updates;
  }
  private accept(reply:PathPlanningReply,expected:number,preserveQueued=false):void{
    if(reply.batchId!==expected)throw new Error('STALE_PATH_BATCH');
    if(this.pathCensus)for(const unitId of reply.restarted??[]){const prior=this.mirrors.get(unitId);if(prior)this.pathCensus.restarted(prior.request);}
    if(this.pathCensus)for(const mirror of reply.mirrors){
      const prior=this.mirrors.get(mirror.request.unitId);
      if(mirror.result.status!=='pending'&&(!prior||prior.result.status==='pending'))this.pathCensus.completed(mirror.request,mirror.result.status);
    }
    this.mirrors=new Map(reply.mirrors.map(mirror=>[mirror.request.unitId,mirror]));
    if(preserveQueued)for(const operation of this.operations){
      if(operation.type==='cancel')this.mirrors.delete(operation.unitId);
      else if(operation.type==='request'){const request=operation.request;this.mirrors.set(request.unitId,{request,result:{status:'pending',id:request.id,orderRevision:request.orderRevision},direct:true,usedRegions:[],connectorRegions:[]});}
      else this.invalidateMirrors(operation.profile,operation.rectangles,undefined,false);
    }
    this.localResults=reply.localResults??[];
  }
  private async run(grants:PathProfileGrant[],geometry:readonly PathPlanningGeometry[],localQueries:LocalPathQuery[]=[],tick?:number,capture=false,nativeCapture=false):Promise<PathWorkReport>{
    if(this.service)throw new Error('PATH_SERVICE_REQUIRES_ADMISSION');
    this.assertMutable();const updates=this.updates(geometry),batch:PathPlanningBatch={batchId:this.batchId+1,grants,operations:this.operations,geometry:updates,localQueries,tick,...(this.pathCensus?{observeRestarts:true}:{})};this.busy=true;
    try{
      const native=capture&&nativeCapture&&this.executor.advanceAndCaptureNative?await this.executor.advanceAndCaptureNative(batch):undefined;
      const captured=!native&&capture&&this.executor.advanceAndCapture?await this.executor.advanceAndCapture(batch):undefined;
      const reply=native?.reply??captured?.reply??await this.executor.advance(batch);
      this.accept(reply,batch.batchId);this.batchId=batch.batchId;this.operations=[];this.cachedState=captured?.state;if(native)this.retainSerialized(native.checkpoint);return reply.report;
    }finally{this.busy=false;}
  }
  advanceAsync(nodeBudget:number,geometry:readonly PathPlanningGeometry[],localQueries:LocalPathQuery[]=[],tick?:number):Promise<PathWorkReport>{return this.run(pathProfileGrants(this.profiles,nodeBudget),geometry,localQueries,tick);}
  /** Starts a bounded series of separately acknowledged, small leases against exactly
   * one committed input. Later orders/geometry remain queued for the next series.
   * The caller never waits in movement integration and must journal admission. */
  startServiceLeases(nodeBudget:number,geometry:readonly PathPlanningGeometry[],tick?:number,maxLeases=6,localQueries:readonly LocalPathQuery[]=[],localQueryLeases?:readonly (readonly LocalPathQuery[])[]):boolean{
    this.assertMutable();if(this.service)return false;
    if(!Number.isSafeInteger(maxLeases)||maxLeases<1||maxLeases>60)throw new Error('INVALID_PATH_SERVICE_LEASE_LIMIT');
    const source=localQueryLeases??[localQueries];
    if(source.length>maxLeases||source.flat().length>2200||localQueryLeases&&localQueries.length||source.some(queries=>queries.length>this.profiles.length*8||queries.some(query=>!this.profiles.includes(query.profile))||this.profiles.some(profile=>queries.filter(query=>query.profile===profile).length>8)))throw new Error('LOCAL_PATH_QUERY_LIMIT');
    const queryLeases=structuredClone(source.map(queries=>[...queries])),localResults:LocalPathResult[]=[];
    const grants=pathProfileGrants(this.profiles,nodeBudget),updates=this.updates(geometry),operations=this.operations;this.operations=[];this.cachedState=undefined;
    const zero:PathWorkReport={work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0};
    const service:NonNullable<RemotePathScheduler['service']>={done:false,promise:Promise.resolve(),maximumLeases:maxLeases,admission:{leases:[],report:zero}};this.service=service;
    const batch=(index:number):PathPlanningBatch=>({batchId:this.batchId+1,grants,operations:index?[]:operations,geometry:index?[]:updates,localQueries:queryLeases[index]??[],tick,...(this.pathCensus?{observeRestarts:true}:{})});
    const receive=(input:PathPlanningBatch,reply:PathPlanningReply)=>{
      if(reply.batchId!==input.batchId)throw new Error('STALE_PATH_BATCH');
      localResults.push(...reply.localResults??[]);
      this.batchId=input.batchId;service.reply={...reply,localResults};service.admission.leases.push({batchId:input.batchId,grants:structuredClone(grants),...(tick!==undefined?{tick}:{}),report:{...reply.report}});
      service.admission.report={...reply.report,work:service.admission.report.work+reply.report.work};
    };
    if(this.executor.advanceSynchronous){
      // A replay start can later be followed by a save which stopped a live
      // series early. Delay synchronous work until the recorded admission count
      // is known; never compute all sixty leases and try to rewind their state.
      service.runSynchronous=leases=>{try{for(let index=0;index<leases;index++){const input=batch(index);receive(input,this.executor.advanceSynchronous!(input));}}catch(error){service.error=error;}};service.done=true;
    }else service.promise=(async()=>{try{
      if(this.executor.advanceService){
        const first=batch(0),result=await this.executor.advanceService(first,maxLeases,queryLeases);
        measurePathCoordinator(this.executor,()=>{
        if(!Array.isArray(result.leases)||!result.leases.length||result.leases.length>maxLeases||result.leases.some((lease,index)=>lease.batchId!==first.batchId+index)||result.reply.batchId!==result.leases.at(-1)!.batchId)throw new Error('INVALID_PATH_SERVICE_REPLY');
        for(const lease of result.leases)receive({...first,batchId:lease.batchId},{batchId:lease.batchId,report:lease.report,mirrors:[]});
        service.reply=result.reply;
        });
      }else for(let index=0;index<maxLeases&&!this.disposed;index++){if(index&&service.stopAfterCurrent)break;const input=batch(index),reply=await this.executor.advance(input);measurePathCoordinator(this.executor,()=>receive(input,reply));}
    }catch(error){measurePathCoordinator(this.executor,()=>{service.error=error;});}finally{measurePathCoordinator(this.executor,()=>{service.done=true;});}})();
    return true;
  }
  serviceStatus():{pending:boolean;ready:boolean;completedLeases:number}{return {pending:!!this.service,ready:!!this.service?.done,completedLeases:this.service?.admission.leases.length??0};}
  /** End an overdue frozen series at its next acknowledgement without waiting
   * inside a commit. The next boundary can admit its actual bounded lease count. */
  stopServiceAfterCurrent():boolean{this.assertMutable();if(!this.service||this.service.done)return false;this.service.stopAfterCurrent=true;this.executor.stopServiceAfterCurrent?.();return true;}
  admitServiceLeases(expectedLeases?:number):PathServiceAdmission|undefined{
    this.assertMutable();const service=this.service;if(!service?.done)return;
    if(expectedLeases!==undefined&&(!Number.isSafeInteger(expectedLeases)||expectedLeases<1||expectedLeases>service.maximumLeases))throw new Error('INVALID_PATH_SERVICE_ADMISSION');
    if(service.runSynchronous){const run=service.runSynchronous;delete service.runSynchronous;run(expectedLeases??service.maximumLeases);}
    if(service.error)throw service.error;if(!service.reply)throw new Error('PATH_SERVICE_WITHOUT_REPLY');
    if(expectedLeases!==undefined&&expectedLeases!==service.admission.leases.length)throw new Error('PATH_SERVICE_ADMISSION_MISMATCH');
    this.accept(service.reply,service.reply.batchId,true);this.service=undefined;return structuredClone(service.admission);
  }
  async drainServiceLeases():Promise<PathServiceAdmission|undefined>{
    this.assertMutable();const service=this.service;if(!service)return;
    service.stopAfterCurrent=true;this.executor.stopServiceAfterCurrent?.();
    if(service.runSynchronous)return this.admitServiceLeases(1);
    await service.promise;return this.admitServiceLeases();
  }
  takeLocalResults():LocalPathResult[]{this.assertMutable();const result=this.localResults;this.localResults=[];return result;}
  advance(_nodeBudget:number):never{throw new Error('ASYNC_PATH_EXECUTOR_REQUIRED');}
  async synchronizeCapture(geometry:readonly PathPlanningGeometry[]=[],nativeCapture=false):Promise<void>{
    this.assertMutable();
    if(this.service)throw new Error('PATH_SERVICE_REQUIRES_ADMISSION');
    // Boundary admission can refresh geometry before the next movement batch.
    // Deliver that geometry before queued invalidations, including zero-credit
    // captures, so retained corner provenance is checked against the same world
    // as the saved coordinator profiles. Never spend path work during a save.
    if(this.operations.length||geometry.some(item=>this.geometry.get(item.profile)?.revision!==item.revision)){this.cachedState=undefined;await this.run([],geometry,[],undefined,true,nativeCapture);}
    if(this.cachedState||this.cachedSerialized)return;
    this.busy=true;try{if(nativeCapture&&this.executor.captureNativeCheckpoint)this.retainSerialized(await this.executor.captureNativeCheckpoint());else this.cachedState=await this.executor.capture();}finally{this.busy=false;}
  }
  synchronizeCaptureSynchronous(geometry:readonly PathPlanningGeometry[]=[]):void{
    this.assertMutable();if(this.service)throw new Error('PATH_SERVICE_REQUIRES_ADMISSION');if(!this.executor.advanceSynchronous||!this.executor.captureSynchronous)throw new Error('ASYNC_PATH_EXECUTOR_REQUIRED');
    if(this.operations.length||geometry.some(item=>this.geometry.get(item.profile)?.revision!==item.revision)){
      const batch:PathPlanningBatch={batchId:this.batchId+1,grants:[],operations:this.operations,geometry:this.updates(geometry)};
      const reply=this.executor.advanceSynchronous(batch);this.accept(reply,batch.batchId);this.batchId=batch.batchId;this.operations=[];this.cachedState=undefined;
    }
    this.cachedState??=this.executor.captureSynchronous();
  }
  exportState():PathSchedulerState{this.assertMutable();if(this.cachedSerialized)return decodeNativeSerializedPathCheckpoint(this.cachedSerialized);if(!this.cachedState)throw new Error('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');return structuredClone(this.cachedState);}
  /** Opaque, one-use native-IPC input; never a borrowed checkpoint accessor. */
  nativeCheckpoint():NativePathCheckpoint{this.assertMutable();if(this.cachedSerialized)return this.nativeCheckpointScope.prepareSerialized(this.cachedSerialized);if(!this.cachedState)throw new Error('PATH_CAPTURE_REQUIRES_SYNCHRONIZATION');return this.nativeCheckpointScope.prepare(this.cachedState);}
  importState(_state:PathSchedulerState):never{throw new Error('RECREATE_PATH_EXECUTOR_ON_RESTORE');}
  enablePathDiagnostics(clock:PathDiagnosticClock):void{
    this.assertMutable();this.pathCensus=new PathPlanningCensus(clock,'coordinator-observation');
    this.pathCensus.observe([...this.mirrors.values()].map(mirror=>({...mirror.request,stage:mirror.result.status==='pending'?mirror.direct?'direct':'unknown':'done',result:mirror.result})),false);
  }
  pathDiagnostics():PathPlanningDiagnostics|undefined{this.assertMutable();return this.pathCensus?.snapshot(this.mirrors.size);}
  queueSummary(tick:number){this.assertMutable();const mirrors=this.mirrors;return summarizePathQueue((function*():Generator<PathQueueTask>{for(const mirror of mirrors.values())yield {request:mirror.request,status:mirror.result.status};})(),tick,this.pathCensus);}
  pendingRequests():PathRequest[]{this.assertMutable();return [...this.mirrors.values()].filter(mirror=>mirror.result.status==='pending').map(mirror=>structuredClone(mirror.request));}
  diagnostics():unknown{return this.executor.diagnostics?.();}
  async dispose():Promise<void>{if(this.disposed)return;this.disposed=true;this.cachedState=undefined;this.nativeCheckpointScope.close();await this.executor.dispose();}
}
