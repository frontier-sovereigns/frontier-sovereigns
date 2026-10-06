import { parentPort } from 'node:worker_threads';
import { immutableVisionGroup, immutableVisionSource, VisionMaskKernel, type VisionMaskFrame, type VisionMaskGroup, type VisionMaskResult, type VisionMaskSource } from '../../../packages/simulation/src/vision-mask-kernel.js';
import { visionExchangeKey, visionGeometryKey, type VisionSourceExchange, type VisionResultExchange, type VisionWorkerRequest, type VisionWorkerResponse, type VisionWorkerTiming } from './vision-worker-protocol.js';
import { diagnosticNow } from './performance-diagnostics.js';

if(!parentPort)throw new Error('VISION_WORKER_PORT_REQUIRED');
const port=parentPort,kernel=new VisionMaskKernel();
let geometry:VisionMaskFrame['blockers']=[],geometryKey='';
let exchangeKey='',sourceRevision=0,groups:readonly VisionMaskGroup[]=[];
let resultRevisions=new Map<string,{revision:number;result:VisionMaskResult}>();
// Native immutable certificates do not survive IPC. Recreate them from the
// worker-owned scalar payload, preserving unchanged source identities on deltas.
const sealSource=(source:VisionMaskSource)=>immutableVisionSource(source.id,source.xMm,source.zMm,source.radius,source.kind);

function orderedGroups(current:Map<string,VisionMaskGroup>,order:readonly string[]):VisionMaskGroup[]{
  if(order.length!==current.size||new Set(order).size!==order.length)throw new Error('VISION_SOURCE_GROUP_ORDER');
  return order.map(key=>{const group=current.get(key);if(!group)throw new Error('VISION_SOURCE_GROUP_MISSING');return group;});
}
/** Source arrays/records are exclusively owned by this worker after IPC. Updates
 * replace affected arrays, so a rejected update cannot partially alter a baseline. */
function applySources(update:VisionSourceExchange,key:string):readonly VisionMaskGroup[]{
  if(update.mode==='full'){
    if(update.baseRevision!==0||update.revision!==1)throw new Error('VISION_SOURCE_REVISION');
    if(new Set(update.groups.map(group=>group.key)).size!==update.groups.length||update.groups.some(group=>new Set(group.sources.map(source=>source.id)).size!==group.sources.length))throw new Error('VISION_SOURCE_DUPLICATE');
    return update.groups.map(group=>immutableVisionGroup(group.key,group.sources.map(sealSource)));
  }
  if(key!==exchangeKey||update.baseRevision!==sourceRevision||update.revision!==sourceRevision+1||!Number.isSafeInteger(update.revision))throw new Error('VISION_SOURCE_BASE_MISMATCH');
  const next=new Map(groups.map(group=>[group.key,group]));
  for(const key of update.removed)if(!next.delete(key))throw new Error('VISION_SOURCE_REMOVE_MISSING');
  const changed=new Set<string>();
  for(const change of update.groups){
    if(changed.has(change.key))throw new Error('VISION_SOURCE_DUPLICATE');changed.add(change.key);
    const previous=next.get(change.key),sources=new Map(previous?.sources.map(source=>[source.id,source]));
    for(const id of change.removed)if(!sources.delete(id))throw new Error('VISION_SOURCE_REMOVE_MISSING');
    const upserts=new Set<string>();
    for(const source of change.upserts){if(upserts.has(source.id))throw new Error('VISION_SOURCE_DUPLICATE');upserts.add(source.id);sources.set(source.id,sealSource(source));}
    const order=change.order??previous?.sources.map(source=>source.id);
    if(!order||order.length!==sources.size||new Set(order).size!==order.length)throw new Error('VISION_SOURCE_ORDER');
    next.set(change.key,immutableVisionGroup(change.key,order.map(id=>{const source=sources.get(id);if(!source)throw new Error('VISION_SOURCE_MISSING');return source;})));
  }
  return orderedGroups(next,update.order??groups.map(group=>group.key));
}
port.on('message',(request:VisionWorkerRequest)=>{
  if(request.type!=='vision')return;
  const {generation,batch,binding}=request;
  const timing:VisionWorkerTiming|undefined=request.diagnosticTiming?{workerReceivedAtMs:diagnosticNow()}:undefined;
  try{
    const key=visionGeometryKey(request.frame);
    if(request.geometry!==undefined){geometry=request.geometry;geometryKey=key;}
    if(geometryKey!==key)throw new Error('VISION_GEOMETRY_MISSING');
    if(request.exchangeKey!==visionExchangeKey(request.frame,binding))throw new Error('VISION_EXCHANGE_BINDING');
    const nextGroups=applySources(request.sources,request.exchangeKey);
    if(request.sources.mode==='full')resultRevisions=new Map();
    groups=nextGroups;exchangeKey=request.exchangeKey;sourceRevision=request.sources.revision;
    if(timing)timing.workerComputeStartedAtMs=diagnosticNow();
    const retained=kernel.computeRetained({...request.frame,blockers:geometry,groups});
    if(timing){timing.workerComputeEndedAtMs=diagnosticNow();timing.kernelWork=kernel.workSnapshot();}
    const results:VisionResultExchange[]=[],nextResults=new Map<string,{revision:number;result:VisionMaskResult}>(),transfers:ArrayBuffer[]=[];
    for(const result of retained){
      const previous=resultRevisions.get(result.key),baseRevision=previous?.revision??0;
      if(previous?.result===result){results.push({key:result.key,baseRevision,revision:baseRevision});nextResults.set(result.key,previous);}
      else{
        const mask=result.mask.slice(),revision=baseRevision+1;
        results.push({key:result.key,baseRevision,revision,result:{mask,visible:result.visible}});transfers.push(mask.buffer as ArrayBuffer);
        nextResults.set(result.key,{revision,result});
      }
    }
    resultRevisions=nextResults;
    const response:VisionWorkerResponse={type:'vision-result',generation,batch,binding,exchangeKey,sourceBaseRevision:request.sources.baseRevision,sourceRevision,results};
    if(timing){response.diagnosticTiming=timing;timing.workerResultPostStartedAtMs=diagnosticNow();}
    port.postMessage(response,transfers);
  }catch(error){
    const response:VisionWorkerResponse={type:'vision-result',generation,batch,binding,exchangeKey:request.exchangeKey,sourceBaseRevision:request.sources.baseRevision,sourceRevision:request.sources.revision,error:error instanceof Error?error.message:'VISION_WORKER_FAILED'};
    if(timing){response.diagnosticTiming=timing;timing.workerResultPostStartedAtMs=diagnosticNow();}
    port.postMessage(response);
  }
});
