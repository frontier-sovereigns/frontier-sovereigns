import { parentPort, threadId } from 'node:worker_threads';
import { PathWorkerPool, type PathWorkerPoolOptions } from './path-worker-pool.js';
import type { PathPlanningBatch, PathPlanningGeometry, PathPlanningServiceReply } from '../../../packages/simulation/src/parallel-path-scheduler.js';
import type { PathSchedulerState } from '../../../packages/simulation/src/path-scheduler.js';
import type { LocalPathQuery } from '../../../packages/simulation/src/movement.js';

type Request={id:number;type:'initialize';profiles:string[];state:PathSchedulerState;geometry:PathPlanningGeometry[];options:PathWorkerPoolOptions}
  |{id:number;type:'advance'|'advanceAndCapture';batch:PathPlanningBatch}
  |{id:number;type:'service';first:PathPlanningBatch;maxLeases:number;localQueryLeases?:LocalPathQuery[][]}
  |{id:number;type:'capture'|'close'}|{type:'stop';serviceId:number};
if(!parentPort)throw new Error('PATH_SERVICE_REQUIRES_PARENT');
let pool:PathWorkerPool|undefined,busy=false,closing=false,active:{id:number;stop:boolean}|undefined;
const diagnostics=()=>({serviceThreadId:threadId,...pool?.diagnostics()});
parentPort.on('message',(request:Request)=>{
  if(request.type==='stop'){if(active?.id===request.serviceId)active.stop=true;return;}
  if(request.type==='close'){
    closing=true;if(active)active.stop=true;
    void (async()=>{try{await pool?.dispose();parentPort!.postMessage({id:request.id,value:true,diagnostics:diagnostics()});}finally{parentPort!.close();}})();return;
  }
  if(busy||closing){parentPort!.postMessage({id:request.id,error:'PATH_BATCH_IN_PROGRESS'});return;}
  busy=true;
  void (async()=>{
    try{
      let value:unknown,transfer:ArrayBuffer[]=[];
      if(request.type==='initialize'){
        if(pool)throw new Error('INVALID_PATH_POOL_INITIALIZATION');
        pool=new PathWorkerPool(request.options);value=await pool.initialize(request.profiles,request.state,request.geometry);
      }else{
        if(!pool)throw new Error('PATH_WORKER_NOT_INITIALIZED');
        if(request.type==='service'){
          if(!Number.isSafeInteger(request.maxLeases)||request.maxLeases<1||request.maxLeases>60)throw new Error('INVALID_PATH_SERVICE_LEASE_LIMIT');
          if(request.localQueryLeases&&(request.localQueryLeases.length>request.maxLeases||request.localQueryLeases.flat().length>2200))throw new Error('LOCAL_PATH_QUERY_LIMIT');
          const service={id:request.id,stop:false};active=service;
          const leases:PathPlanningServiceReply['leases']=[],localResults:NonNullable<PathPlanningServiceReply['reply']['localResults']>=[];let reply:PathPlanningServiceReply['reply']|undefined;
          try{
            for(let index=0;index<request.maxLeases&&!closing;index++){
              if(index&&service.stop)break;
              const batch:PathPlanningBatch={...request.first,batchId:request.first.batchId+index,operations:index?[]:request.first.operations,geometry:index?[]:request.first.geometry,localQueries:request.localQueryLeases?.[index]??(index?[]:request.first.localQueries)};
              // Preserve the existing all-owner barrier, grant shares, recovery
              // log and checkpoint after every small lease. Only this service
              // thread dispatches the next lease; simulation callbacks do not.
              reply=await pool.advance(batch);leases.push({batchId:reply.batchId,report:reply.report});localResults.push(...reply.localResults??[]);
            }
            if(!reply)throw new Error('PATH_SERVICE_WITHOUT_REPLY');
            value={leases,reply:{...reply,localResults}} satisfies PathPlanningServiceReply;
          }finally{active=undefined;}
        }else if(request.type==='advance')value=await pool.advance(request.batch);
        else if(request.type==='advanceAndCapture'){const captured=await pool.advanceAndSerializeCapture(request.batch);value=captured;transfer=[captured.serialized.data];}
        else{const captured=await pool.serializeCapture();value=captured;transfer=[captured.data];}
      }
      if(!closing)parentPort!.postMessage({id:request.id,value,diagnostics:diagnostics()},transfer);
    }catch(error){if(!closing)parentPort!.postMessage({id:request.id,error:error instanceof Error?error.message:'PATH_SERVICE_FAILURE',diagnostics:diagnostics()});}
    finally{busy=false;}
  })();
});
parentPort.on('close',()=>{closing=true;void pool?.dispose();});
