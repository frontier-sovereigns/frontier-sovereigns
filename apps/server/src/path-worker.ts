import { parentPort, threadId, workerData } from 'node:worker_threads';
import { createNativePathPlanningKernel, type PathPlanningBatch, type PathPlanningGeometry } from '../../../packages/simulation/src/parallel-path-scheduler.js';
import type { PathSchedulerState } from '../../../packages/simulation/src/path-scheduler.js';
import type { PathWorkerTiming } from './path-worker-pool.js';

type Request={id:number;generation:number;type:'initialize';profiles:string[];state:PathSchedulerState;geometry:PathPlanningGeometry[];batchId:number}|{id:number;generation:number;type:'advance';batch:PathPlanningBatch;checkpoint?:true}|{id:number;generation:number;type:'capture'};
if(!parentPort)throw new Error('PATH_WORKER_REQUIRES_PARENT');
let kernel:ReturnType<typeof createNativePathPlanningKernel>|undefined;
const traceNow=()=>Number(process.hrtime.bigint())/1e6;
parentPort.on('message',(request:Request)=>{
  if(request.generation!==workerData.generation)return;
  const startedAtMs=workerData.performanceDiagnostics===true?traceNow():undefined;
  try{
    let value:unknown;
    if(request.type==='initialize'){
      kernel=createNativePathPlanningKernel(request.profiles,request.state,request.geometry);kernel.restoreBatch(request.batchId);value=kernel.reply();
    }else{
      if(!kernel)throw new Error('PATH_WORKER_NOT_INITIALIZED');
      if(request.type==='advance'){
        const reply=kernel.advance(request.batch);
        if(request.checkpoint){kernel.postCheckpoint(parentPort!,{id:request.id,generation:request.generation,threadId,...(startedAtMs===undefined?{}:{startedAtMs})},reply);return;}
        value=reply;
      }else{kernel.postCheckpoint(parentPort!,{id:request.id,generation:request.generation,threadId,...(startedAtMs===undefined?{}:{startedAtMs})});return;}
    }
    const reply:{id:number;generation:number;threadId:number;value:unknown;timing?:PathWorkerTiming}={id:request.id,generation:request.generation,threadId,value};
    if(startedAtMs!==undefined)reply.timing={workerStartedAtMs:startedAtMs,workerFinishedAtMs:traceNow()};parentPort!.postMessage(reply);
  }catch(error){const reply:{id:number;generation:number;threadId:number;error:string;timing?:PathWorkerTiming}={id:request.id,generation:request.generation,threadId,error:error instanceof Error?error.message:'PATH_WORKER_FAILURE'};if(startedAtMs!==undefined)reply.timing={workerStartedAtMs:startedAtMs,workerFinishedAtMs:traceNow()};parentPort!.postMessage(reply);}
});
