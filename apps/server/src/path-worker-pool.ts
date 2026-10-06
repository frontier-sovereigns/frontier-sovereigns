import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serialize } from 'node:v8';
import { captureNativeSerializedPathCheckpoint, deserializePathCheckpoint, type SerializedPathCheckpoint, type NativeSerializedPathCheckpoint } from '../../../packages/simulation/src/checkpoint-native.js';
export { deserializePathCheckpoint, type SerializedPathCheckpoint } from '../../../packages/simulation/src/checkpoint-native.js';
import { computeWorkerEnvironment } from './compute-worker-environment.js';
import { MAX_SAVE_BYTES } from './save-store.js';
import { measurePathCoordinator, mergePathReplies, mergePathStates, partitionPathState, pathGeometryEntries, type PathPlanningBatch, type PathPlanningCapturedReply, type PathPlanningExecutor, type PathPlanningGeometry, type PathPlanningReply, type PathPlanningServiceReply } from '../../../packages/simulation/src/parallel-path-scheduler.js';
import type { PathSchedulerState } from '../../../packages/simulation/src/path-scheduler.js';

interface Checkpoint {state:PathSchedulerState;geometry:PathPlanningGeometry[];batchId:number}
export interface PathWorkerTiming {workerStartedAtMs:number;workerFinishedAtMs:number}
interface PathTraceRow {
  kind:'request'|'coordinator';operation:string;startedAtMs:number;finishedAtMs?:number;elapsedMs?:number;
  requestId?:number;generation?:number;threadId?:number;profiles?:number;batchId?:number;tick?:number;
  postReturnedAtMs?:number;workerStartedAtMs?:number;workerFinishedAtMs?:number;workerElapsedMs?:number;dispatchToWorkerMs?:number;returnToCoordinatorMs?:number;
  outcome?:'completed'|'error'|'timeout'|'closed'|'worker-failure'|'post-failure';
  operations?:number;geometryUpdates?:number;obstacleUpserts?:number;localQueries?:number;grantedCredits?:number;checkpointTasks?:number;
}
interface Pending {resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;trace?:PathTraceRow}
interface Slot {profiles:string[];worker:Worker;generation:number;threadId:number;nextId:number;pending:Map<number,Pending>;checkpoint:Checkpoint;geometry:PathPlanningGeometry[];history:PathPlanningBatch[];recoveries:number;failed?:Error}
const traceNow=()=>Number(process.hrtime.bigint())/1e6;
export interface PathWorkerPoolOptions {workerCount?:number;checkpointEvery?:number;timeoutMs?:number;recoveryTimeoutMs?:number;startupTimeoutMs?:number;performanceDiagnostics?:boolean}

/** Internal Node transport only. Never a save format or an ownership claim. */
export function serializePathCheckpoint(state:PathSchedulerState):SerializedPathCheckpoint {
  const encoded=serialize(state);
  if(!encoded.byteLength||encoded.byteLength>MAX_SAVE_BYTES)throw new Error('PATH_CAPTURE_TOO_LARGE');
  // V8 returns a Buffer which may have a nonzero offset or pooled backing store.
  // Copy bytes once into an exact fixed allocation, safe to detach on postMessage.
  const data=new ArrayBuffer(encoded.byteLength);new Uint8Array(data).set(encoded);
  return {format:'path-state-v8-v1',data,byteLength:data.byteLength};
}

/** A bounded persistent pool. Faction grants are assigned before dispatch, never by arrival order. */
export class PathWorkerPool implements PathPlanningExecutor {
  private slots:Slot[]=[];
  private generation=0;
  private closed=false;
  private busy=false;
  private readonly count:number;
  private readonly checkpointEvery:number;
  private readonly timeoutMs:number;
  private readonly recoveryTimeoutMs:number;
  private readonly startupTimeoutMs:number;
  private readonly performanceTrace:{rows:PathTraceRow[];omitted:number;ignoredReplies:number}|undefined;
  private disposal:Promise<void>|undefined;
  constructor(options:PathWorkerPoolOptions={}){
    this.count=options.workerCount??2;this.checkpointEvery=options.checkpointEvery??64;this.timeoutMs=options.timeoutMs??2000;
    this.recoveryTimeoutMs=options.recoveryTimeoutMs??8000;this.startupTimeoutMs=options.startupTimeoutMs??10000;
    if(options.performanceDiagnostics)this.performanceTrace={rows:[],omitted:0,ignoredReplies:0};
    if(!Number.isSafeInteger(this.count)||this.count<1||this.count>8||!Number.isSafeInteger(this.checkpointEvery)||this.checkpointEvery<1||this.checkpointEvery>256||!Number.isSafeInteger(this.timeoutMs)||this.timeoutMs<50||this.timeoutMs>3000||!Number.isSafeInteger(this.recoveryTimeoutMs)||this.recoveryTimeoutMs<50||this.recoveryTimeoutMs>8000||!Number.isSafeInteger(this.startupTimeoutMs)||this.startupTimeoutMs<50||this.startupTimeoutMs>10000)throw new Error('INVALID_PATH_POOL_OPTIONS');
  }
  private recordTrace(row:PathTraceRow):void {
    const trace=this.performanceTrace;if(!trace)return;
    // Preserve the initial startup prefix as well as the latest completed work.
    if(trace.rows.length===256){trace.rows.splice(16,1);trace.omitted++;}trace.rows.push(row);
  }
  private coordinatorTrace(operation:string,startedAtMs:number|undefined,slot?:Slot,batchId?:number):void {
    if(startedAtMs===undefined)return;const finishedAtMs=traceNow();
    this.recordTrace({kind:'coordinator',operation,startedAtMs,finishedAtMs,elapsedMs:finishedAtMs-startedAtMs,...(slot?{generation:slot.generation,threadId:slot.threadId,profiles:slot.profiles.length}:{}),...(batchId===undefined?{}:{batchId})});
  }
  private finishTrace(pending:Pending,outcome:NonNullable<PathTraceRow['outcome']>,timing?:PathWorkerTiming,receivedAtMs?:number):void {
    const row=pending.trace;if(!row)return;delete pending.trace;
    const finishedAtMs=receivedAtMs??traceNow();row.finishedAtMs=finishedAtMs;row.elapsedMs=finishedAtMs-row.startedAtMs;row.outcome=outcome;
    if(timing&&Number.isFinite(timing.workerStartedAtMs)&&Number.isFinite(timing.workerFinishedAtMs)&&timing.workerStartedAtMs>=row.startedAtMs&&timing.workerFinishedAtMs>=timing.workerStartedAtMs&&timing.workerFinishedAtMs<=finishedAtMs){
      row.workerStartedAtMs=timing.workerStartedAtMs;row.workerFinishedAtMs=timing.workerFinishedAtMs;row.workerElapsedMs=timing.workerFinishedAtMs-timing.workerStartedAtMs;row.dispatchToWorkerMs=timing.workerStartedAtMs-row.startedAtMs;row.returnToCoordinatorMs=finishedAtMs-timing.workerFinishedAtMs;
    }
    this.recordTrace(row);
  }
  /** One operation owns one deadline, including checkpoint/restart/history replay.
   * Two later vision barriers still fit below the bridge's 15-second RPC limit. */
  private async beforeDeadline<T>(operation:Promise<T>,deadline:number):Promise<T>{
    let timer:NodeJS.Timeout|undefined;
    try{
      const remaining=deadline-performance.now();if(remaining<=0){void operation.catch(()=>{});throw new Error('PATH_COMPUTE_DEADLINE_EXCEEDED');}
      const result=await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('PATH_COMPUTE_DEADLINE_EXCEEDED')),remaining);})]);
      if(performance.now()>=deadline)throw new Error('PATH_COMPUTE_DEADLINE_EXCEEDED');return result;
    }finally{if(timer)clearTimeout(timer);}
  }
  private spawn(slot:Slot):void{
    const startedAtMs=this.performanceTrace?traceNow():undefined;
    const generation=++this.generation,built=new URL('./path-worker.js',import.meta.url),env=computeWorkerEnvironment();
    const data={generation,...(this.performanceTrace?{performanceDiagnostics:true}:{})};
    const worker=existsSync(fileURLToPath(built))?new Worker(built,{workerData:data,env,execArgv:[]}):new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./path-worker.ts',import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,{eval:true,workerData:data,env,execArgv:[]});
    slot.worker=worker;slot.generation=generation;slot.threadId=worker.threadId;slot.failed=undefined;
    this.coordinatorTrace('workerSpawn',startedAtMs,slot);
    const failed=(error:Error)=>{if(slot.generation!==generation||this.closed)return;slot.failed=error;for(const pending of slot.pending.values()){clearTimeout(pending.timer);this.finishTrace(pending,'worker-failure');pending.reject(error);}slot.pending.clear();};
    worker.on('error',failed);worker.on('exit',code=>failed(new Error(`PATH_WORKER_EXIT_${code}`)));
    worker.on('message',(message:{id:number;generation:number;threadId:number;value?:unknown;error?:string;timing?:PathWorkerTiming})=>{
      const receivedAtMs=this.performanceTrace?traceNow():undefined;
      if(slot.generation!==generation||message.generation!==generation||this.closed){if(this.performanceTrace)this.performanceTrace.ignoredReplies++;return;}
      const pending=slot.pending.get(message.id);if(!pending){if(this.performanceTrace)this.performanceTrace.ignoredReplies++;return;}slot.pending.delete(message.id);clearTimeout(pending.timer);slot.threadId=message.threadId;
      this.finishTrace(pending,message.error?'error':'completed',message.timing,receivedAtMs);
      if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.value);
    });
  }
  private request<T>(slot:Slot,message:Record<string,unknown>,deadline:number,timeoutMs=this.timeoutMs):Promise<T>{
    if(this.closed)return Promise.reject(new Error('PATH_POOL_CLOSED'));if(slot.failed)return Promise.reject(slot.failed);
    const remaining=deadline-performance.now();if(remaining<=0)return Promise.reject(new Error('PATH_COMPUTE_DEADLINE_EXCEEDED'));
    const id=++slot.nextId,generation=slot.generation;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{slot.pending.delete(id);this.finishTrace(pending,'timeout');reject(new Error(remaining<=timeoutMs?'PATH_COMPUTE_DEADLINE_EXCEEDED':'PATH_WORKER_TIMEOUT'));},Math.min(timeoutMs,remaining));
      const pending:Pending={resolve,reject,timer};
      if(this.performanceTrace){const batch=message.type==='advance'?message.batch as PathPlanningBatch:undefined;pending.trace={kind:'request',operation:String(message.type),requestId:id,generation,threadId:slot.threadId,profiles:slot.profiles.length,batchId:batch?.batchId??(typeof message.batchId==='number'?message.batchId:slot.history.at(-1)?.batchId??slot.checkpoint.batchId),...(batch?.tick===undefined?{}:{tick:batch.tick}),startedAtMs:traceNow(),operations:batch?.operations.length??0,geometryUpdates:batch?.geometry.length??(message.type==='initialize'?slot.checkpoint.geometry.length:0),obstacleUpserts:batch?.geometry.reduce((sum,update)=>sum+update.upserts.length,0)??0,localQueries:batch?.localQueries?.length??0,grantedCredits:batch?.grants.reduce((sum,grant)=>sum+grant.nodeBudget,0)??0,...(message.type==='initialize'?{checkpointTasks:slot.checkpoint.state.tasks.length}:{})};}
      slot.pending.set(id,pending);try{if(pending.trace)pending.trace.startedAtMs=traceNow();slot.worker.postMessage({...message,id,generation});if(pending.trace)pending.trace.postReturnedAtMs=traceNow();}catch(error){slot.pending.delete(id);clearTimeout(timer);if(pending.trace)pending.trace.postReturnedAtMs=traceNow();this.finishTrace(pending,'post-failure');reject(error);}
    });
  }
  async initialize(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]):Promise<PathPlanningReply>{
    if(this.closed||this.slots.length||!profiles.length||new Set(profiles).size!==profiles.length)throw new Error('INVALID_PATH_POOL_INITIALIZATION');
    const startedAtMs=this.performanceTrace?traceNow():undefined;
    const groups=Array.from({length:Math.min(this.count,profiles.length)},()=>[] as string[]);
    [...profiles].sort().forEach((profile,index)=>groups[index%groups.length]!.push(profile));
    this.slots=groups.map(owned=>{
      const checkpoint={state:partitionPathState(state,owned),geometry:structuredClone(geometry.filter(item=>owned.includes(item.profile))),batchId:0};
      const slot={profiles:owned,worker:undefined as unknown as Worker,generation:0,threadId:0,nextId:0,pending:new Map(),checkpoint,geometry:structuredClone(checkpoint.geometry),history:[],recoveries:0} satisfies Slot;
      this.spawn(slot);return slot;
    });
    this.coordinatorTrace('initializePreparation',startedAtMs);
    const deadline=performance.now()+this.startupTimeoutMs;
    try{const replies=await this.beforeDeadline(Promise.all(this.slots.map(slot=>this.request<PathPlanningReply>(slot,{type:'initialize',profiles:slot.profiles,...slot.checkpoint},deadline,this.startupTimeoutMs))),deadline),mergeStartedAtMs=this.performanceTrace?traceNow():undefined,result=mergePathReplies(0,replies);this.coordinatorTrace('initializeMerge',mergeStartedAtMs);return result;}
    catch(error){void this.dispose().catch(()=>{});throw error;}
  }
  private batchFor(slot:Slot,batch:PathPlanningBatch):PathPlanningBatch{
    const startedAtMs=this.performanceTrace?traceNow():undefined;
    const result={batchId:batch.batchId,grants:batch.grants.filter(grant=>slot.profiles.includes(grant.profile)),operations:batch.operations.filter(operation=>slot.profiles.includes(operation.type==='request'?operation.request.profile:operation.profile)),geometry:batch.geometry.filter(update=>slot.profiles.includes(update.profile)),localQueries:batch.localQueries?.filter(query=>slot.profiles.includes(query.profile)),tick:batch.tick,...(batch.observeRestarts?{observeRestarts:true as const}:{})};
    this.coordinatorTrace('batchPartition',startedAtMs,slot,batch.batchId);return result;
  }
  private async recover(slot:Slot,deadline:number):Promise<void>{
    if(this.closed)throw new Error('PATH_POOL_CLOSED');
    if(performance.now()>=deadline)throw new Error('PATH_COMPUTE_DEADLINE_EXCEEDED');
    // Invalidate before termination so late replies cannot acquire replacement ownership.
    slot.generation=++this.generation;await this.beforeDeadline(slot.worker.terminate(),deadline);if(this.closed)throw new Error('PATH_POOL_CLOSED');this.spawn(slot);slot.recoveries++;
    await this.request(slot,{type:'initialize',profiles:slot.profiles,...slot.checkpoint},deadline);
    for(const batch of slot.history){const reply=await this.request<PathPlanningReply>(slot,{type:'advance',batch},deadline);if(reply.batchId!==batch.batchId)throw new Error('STALE_PATH_BATCH');}
  }
  private async recoverable<T>(slot:Slot,message:Record<string,unknown>,deadline:number):Promise<T>{
    try{return await this.request<T>(slot,message,deadline);}catch(error){if(this.closed)throw error;await this.recover(slot,deadline);return this.request<T>(slot,message,deadline);}
  }
  private rememberGeometry(slot:Slot,batch:PathPlanningBatch):void{
    const startedAtMs=this.performanceTrace?traceNow():undefined;
    for(const update of batch.geometry){
      const index=slot.geometry.findIndex(item=>item.profile===update.profile),prior=index<0?undefined:slot.geometry[index];
      const obstacles=new Map(update.replace?[]:prior?pathGeometryEntries(prior.obstacles):[]);
      // Retained geometry is privately owned and replaced, never edited. Copy
      // changed obstacles once so checkpoints can share unchanged records.
      for(const id of update.removed)obstacles.delete(id);for(const [key,obstacle] of update.upserts)obstacles.set(key,{...obstacle});
      const geometry={profile:update.profile,revision:update.revision,widthMm:update.widthMm,heightMm:update.heightMm,obstacles:update.order.map(key=>obstacles.get(key)!)};
      if(index<0)slot.geometry.push(geometry);else slot.geometry[index]=geometry;
    }
    this.coordinatorTrace('geometryRetention',startedAtMs,slot,batch.batchId);
  }
  private async checkpoint(slot:Slot,deadline:number):Promise<PathSchedulerState>{
    // Acknowledged checkpoints already contain this exact worker state. No
    // worker can advance without adding history or replacing this checkpoint.
    if(!slot.history.length)return slot.checkpoint.state;
    const state=await this.recoverable<PathSchedulerState>(slot,{type:'capture'},deadline);
    const startedAtMs=this.performanceTrace?traceNow():undefined;
    const batchId=slot.history.at(-1)?.batchId??slot.checkpoint.batchId;
    slot.checkpoint={state,geometry:slot.geometry.slice(),batchId};slot.history=[];this.coordinatorTrace('checkpointRetention',startedAtMs,slot,batchId);return state;
  }
  advance(batch:PathPlanningBatch):Promise<PathPlanningReply>{return this.advanceWithCheckpoint(batch,false).then(value=>value.reply);}
  advanceAndCapture(batch:PathPlanningBatch):Promise<PathPlanningCapturedReply>{
    if(batch.grants.length||batch.localQueries?.length)return Promise.reject(new Error('PATH_CAPTURE_REQUIRES_ZERO_CREDITS'));
    return this.advanceWithCheckpoint(batch,true).then(value=>({reply:value.reply,state:value.state!}));
  }
  advanceAndSerializeCapture(batch:PathPlanningBatch):Promise<{reply:PathPlanningReply;serialized:SerializedPathCheckpoint}>{
    if(batch.grants.length||batch.localQueries?.length)return Promise.reject(new Error('PATH_CAPTURE_REQUIRES_ZERO_CREDITS'));
    return this.advanceWithCheckpoint(batch,'serialized').then(value=>({reply:value.reply,serialized:value.serialized!}));
  }
  private serializeMergedCheckpoint(states:readonly PathSchedulerState[]):SerializedPathCheckpoint {
    const mergeStarted=this.performanceTrace?traceNow():undefined,merged=mergePathStates(states);this.coordinatorTrace('captureMerge',mergeStarted);
    const serializeStarted=this.performanceTrace?traceNow():undefined,serialized=serializePathCheckpoint(merged);this.coordinatorTrace('captureSerialize',serializeStarted);return serialized;
  }
  private async advanceWithCheckpoint(batch:PathPlanningBatch,capture:boolean|'serialized'):Promise<{reply:PathPlanningReply;state?:PathSchedulerState;serialized?:SerializedPathCheckpoint}>{
    if(this.closed||!this.slots.length)throw new Error('PATH_POOL_CLOSED');if(this.busy)throw new Error('PATH_BATCH_IN_PROGRESS');this.busy=true;
    const deadline=performance.now()+this.recoveryTimeoutMs;
    try{
      const replies=await this.beforeDeadline(Promise.all(this.slots.map(async slot=>{
        const owned=this.batchFor(slot,batch),checkpoint=capture||slot.history.length+1>=this.checkpointEvery;
        const response=await this.recoverable<PathPlanningReply|PathPlanningCapturedReply>(slot,{type:'advance',batch:owned,...(checkpoint?{checkpoint:true}:{})},deadline);
        const reply=checkpoint?(response as PathPlanningCapturedReply).reply:response as PathPlanningReply;
        if(reply.batchId!==batch.batchId)throw new Error('STALE_PATH_BATCH');
        this.rememberGeometry(slot,owned);
        if(checkpoint){
          // Commit only the acknowledged post-advance state. A dropped reply
          // recovers the old checkpoint/history before retrying this grant.
          const startedAtMs=this.performanceTrace?traceNow():undefined;
          slot.checkpoint={state:(response as PathPlanningCapturedReply).state,geometry:slot.geometry.slice(),batchId:batch.batchId};slot.history=[];
          this.coordinatorTrace('checkpointRetention',startedAtMs,slot,batch.batchId);
        }else slot.history.push({...owned,localQueries:[]});
        return reply;
      })),deadline);const mergeStartedAtMs=this.performanceTrace?traceNow():undefined,reply=mergePathReplies(batch.batchId,replies);
      const states=capture?this.slots.map(slot=>slot.checkpoint.state):undefined;
      const result={reply,...(capture==='serialized'?{serialized:this.serializeMergedCheckpoint(states!)}:capture?{state:structuredClone(mergePathStates(states!))}:{})};
      this.coordinatorTrace('batchMerge',mergeStartedAtMs,undefined,batch.batchId);return result;
    }catch(error){void this.dispose().catch(()=>{});throw error;}finally{this.busy=false;}
  }
  capture():Promise<PathSchedulerState>{return this.captureWith(states=>structuredClone(mergePathStates(states)));}
  serializeCapture():Promise<SerializedPathCheckpoint>{return this.captureWith(states=>this.serializeMergedCheckpoint(states),'captureAssembly');}
  private async captureWith<T>(encode:(states:readonly PathSchedulerState[])=>T,traceOperation='captureMerge'):Promise<T>{
    if(this.closed||!this.slots.length)throw new Error('PATH_POOL_CLOSED');if(this.busy)throw new Error('PATH_BATCH_IN_PROGRESS');this.busy=true;
    const deadline=performance.now()+this.recoveryTimeoutMs;
    try{const states=await this.beforeDeadline(Promise.all(this.slots.map(slot=>this.checkpoint(slot,deadline))),deadline),startedAtMs=this.performanceTrace?traceNow():undefined,result=encode(states);this.coordinatorTrace(traceOperation,startedAtMs);return result;}catch(error){void this.dispose().catch(()=>{});throw error;}finally{this.busy=false;}
  }
  private traceSnapshot(){
    const trace=this.performanceTrace;if(!trace)return;
    const capturedAtMs=traceNow(),active=this.slots.flatMap(slot=>[...slot.pending.values()].flatMap(pending=>pending.trace?[{...pending.trace,ageMs:capturedAtMs-pending.trace.startedAtMs}]:[]));
    const available=256-active.length,rows=trace.rows.length<=available?trace.rows:[...trace.rows.slice(0,16),...trace.rows.slice(-(available-16))];
    return {clock:'Number(process.hrtime.bigint()) / 1e6; same-host monotonic milliseconds',scope:'Elapsed wall time, not CPU. Requests and coordinator spans can overlap across workers; initializePreparation contains workerSpawn. Never sum overlapping rows into a serial total. Whole worker advance includes geometry, operations, scheduler, local queries and reply preparation. Dispatch includes postMessage cloning, queueing and cold startup; return includes reply cloning and receiver scheduling.',limit:256,startupRows:16,capturedAtMs,omitted:trace.omitted+trace.rows.length-rows.length,ignoredReplies:trace.ignoredReplies,rows:rows.map(row=>({...row})),active};
  }
  diagnostics(){const trace=this.traceSnapshot();return {workerCount:this.slots.length,workers:this.slots.map(slot=>({threadId:slot.threadId,generation:slot.generation,profiles:slot.profiles.length,acknowledgedBatch:slot.history.at(-1)?.batchId??slot.checkpoint.batchId,retainedBatches:slot.history.length,recoveries:slot.recoveries})),...(trace?{trace}:{})};}
  async dispose():Promise<void>{
    if(this.disposal)return this.disposal;this.closed=true;
    for(const slot of this.slots)for(const pending of slot.pending.values()){clearTimeout(pending.timer);this.finishTrace(pending,'closed');pending.reject(new Error('PATH_POOL_CLOSED'));}for(const slot of this.slots)slot.pending.clear();
    this.disposal=Promise.all(this.slots.map(slot=>slot.worker.terminate())).then(()=>{});return this.disposal;
  }
  close():Promise<void>{return this.dispose();}
}

/** A small dispatch owner keeps the existing persistent compute pool busy while
 * the simulation thread integrates its synchronous frame. It receives only path
 * geometry/requests, never endpoint settings, credentials or the world state. */
export class PathWorkerService implements PathPlanningExecutor {
  private readonly worker:Worker;
  private nextId=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private closed=false;
  private failed:Error|undefined;
  private activeService:number|undefined;
  private stoppingService:{id:number;timer:NodeJS.Timeout}|undefined;
  private disposal:Promise<void>|undefined;
  private latest:ReturnType<PathWorkerPool['diagnostics']>={workerCount:0,workers:[]};
  constructor(private readonly options:PathWorkerPoolOptions={},readonly observeCoordinatorWork?: (elapsedMs:number)=>void){
    const built=new URL('./path-service-worker.js',import.meta.url),env=computeWorkerEnvironment();
    this.worker=existsSync(fileURLToPath(built))?new Worker(built,{env,execArgv:[]}):new Worker(`import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./path-service-worker.ts',import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,{eval:true,env,execArgv:[]});
    const fail=(error:Error)=>measurePathCoordinator(this,()=>{if(this.closed)return;this.failed=error;for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();});
    this.worker.on('error',fail);this.worker.on('exit',code=>fail(new Error(`PATH_SERVICE_EXIT_${code}`)));
    this.worker.on('message',(message:{id:number;value?:unknown;error?:string;diagnostics?:ReturnType<PathWorkerPool['diagnostics']>})=>measurePathCoordinator(this,()=>{
      const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);
      if(message.diagnostics)this.latest=message.diagnostics;
      if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.value);
    }));
  }
  private request<T>(type:string,payload:Record<string,unknown>={},timeoutMs=this.options.recoveryTimeoutMs??8000):Promise<T>{
    if(this.closed)return Promise.reject(new Error('PATH_POOL_CLOSED'));if(this.failed)return Promise.reject(this.failed);
    const id=++this.nextId;if(type==='service')this.activeService=id;
    return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('PATH_SERVICE_TIMEOUT'));void this.dispose();},timeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,type,...payload});}catch(error){this.pending.delete(id);clearTimeout(timer);reject(error);}
    }).finally(()=>measurePathCoordinator(this,()=>{if(this.activeService===id)this.activeService=undefined;if(this.stoppingService?.id===id){clearTimeout(this.stoppingService.timer);this.stoppingService=undefined;}}));
  }
  initialize(profiles:readonly string[],state:PathSchedulerState,geometry:readonly PathPlanningGeometry[]):Promise<PathPlanningReply>{
    return this.request<PathPlanningReply>('initialize',{profiles,state,geometry,options:this.options},(this.options.startupTimeoutMs??10000)+2000).catch(error=>{void this.dispose();throw error;});
  }
  advance(batch:PathPlanningBatch):Promise<PathPlanningReply>{return this.request('advance',{batch});}
  advanceAndCapture(batch:PathPlanningBatch):Promise<PathPlanningCapturedReply>{
    return this.request<{reply:PathPlanningReply;serialized:SerializedPathCheckpoint}>('advanceAndCapture',{batch}).then(value=>measurePathCoordinator(this,()=>({reply:value.reply,state:deserializePathCheckpoint(value.serialized)})));
  }
  advanceAndCaptureNative(batch:PathPlanningBatch):Promise<{reply:PathPlanningReply;checkpoint:NativeSerializedPathCheckpoint}>{
    return this.request<{reply:PathPlanningReply;serialized:SerializedPathCheckpoint}>('advanceAndCapture',{batch}).then(value=>measurePathCoordinator(this,()=>({reply:value.reply,checkpoint:captureNativeSerializedPathCheckpoint(value.serialized)})));
  }
  advanceService(first:PathPlanningBatch,maxLeases:number,localQueryLeases?:readonly (readonly import('../../../packages/simulation/src/movement.js').LocalPathQuery[])[]):Promise<PathPlanningServiceReply>{
    if(!Number.isSafeInteger(maxLeases)||maxLeases<1||maxLeases>60)return Promise.reject(new Error('INVALID_PATH_SERVICE_LEASE_LIMIT'));
    // This is the pre-existing per-lease deadline multiplied by a bounded series,
    // not a larger compute lease. A save/late frame stops after the current one.
    return this.request('service',{first,maxLeases,localQueryLeases},(this.options.recoveryTimeoutMs??8000)*maxLeases+1000);
  }
  stopServiceAfterCurrent():void{
    if(this.closed||this.activeService===undefined||this.stoppingService?.id===this.activeService)return;
    const id=this.activeService;
    // A checkpoint waits for only the current lease, never the whole series.
    // Repeated overdue frame polls must not move this deadline into the future.
    const timer=setTimeout(()=>{
      const error=this.failed=new Error('PATH_SERVICE_STOP_TIMEOUT');
      for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(error);}this.pending.clear();
      void this.dispose();
    },(this.options.recoveryTimeoutMs??8000)+1000);
    this.stoppingService={id,timer};this.worker.postMessage({type:'stop',serviceId:id});
  }
  capture():Promise<PathSchedulerState>{return this.request<SerializedPathCheckpoint>('capture').then(value=>measurePathCoordinator(this,()=>deserializePathCheckpoint(value)));}
  captureNativeCheckpoint():Promise<NativeSerializedPathCheckpoint>{return this.request<SerializedPathCheckpoint>('capture').then(value=>measurePathCoordinator(this,()=>captureNativeSerializedPathCheckpoint(value)));}
  diagnostics(){return {...this.latest,serviceThreadId:this.worker.threadId,servicePending:this.activeService!==undefined};}
  dispose():Promise<void>{
    if(this.disposal)return this.disposal;
    if(this.stoppingService){clearTimeout(this.stoppingService.timer);this.stoppingService=undefined;}
    // Ask the owner to join both compute children first. A bounded fallback
    // terminates its entire worker environment if the service itself has failed.
    const closing=this.request('close',{},1000);this.closed=true;
    for(const [id,pending]of this.pending)if(id!==this.nextId){clearTimeout(pending.timer);pending.reject(new Error('PATH_POOL_CLOSED'));this.pending.delete(id);}
    this.disposal=closing.catch(()=>{}).then(async()=>{await this.worker.terminate();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('PATH_POOL_CLOSED'));}this.pending.clear();});return this.disposal;
  }
  close():Promise<void>{return this.dispose();}
}
