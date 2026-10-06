import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeWorkerEnvironment } from './compute-worker-environment.js';
import { isImmutableVisionGroup, VisionMaskKernel, type VisionMaskFrame, type VisionMaskGroup, type VisionMaskSource, type VisionMaskResult } from '../../../packages/simulation/src/vision-mask-kernel.js';
import { sameVisionBinding, visionExchangeKey, visionGeometryKey, type VisionPhaseBinding, type VisionSourceExchange, type VisionWorkerRequest, type VisionWorkerResponse, type VisionWorkerTiming } from './vision-worker-protocol.js';
import { diagnosticNow } from './performance-diagnostics.js';
export type { VisionPhaseBinding } from './vision-worker-protocol.js';

const TIMING_HISTORY_LIMIT=96;
const TIMING_INITIAL_HISTORY=8;
export interface VisionLaneTiming {
  generation:number;batch:number;binding:VisionPhaseBinding;lane:number;threadId:number;
  groupCount:number;sourceCount:number;geometryTransferred:boolean;firstRequest:boolean;
  coordinatorDispatchAtMs:number;coordinatorPostedAtMs?:number;coordinatorReceivedAtMs?:number;
  worker?:VisionWorkerTiming;fallbackStartedAtMs?:number;fallbackEndedAtMs?:number;
  outcome:'pending'|'returned'|'recovered'|'recovery-failed'|'closed';
}
/** A lane is not the phase critical path. Post duration overlaps outbound time;
 * lane intervals overlap other lanes. Never sum either as coordinator CPU time. */
export function visionLaneIntervals(row:VisionLaneTiming){
  const stamps=[row.coordinatorDispatchAtMs,row.worker?.workerReceivedAtMs,row.worker?.workerComputeStartedAtMs,
    row.worker?.workerComputeEndedAtMs,row.worker?.workerResultPostStartedAtMs,row.coordinatorReceivedAtMs];
  if(stamps.some(stamp=>stamp===undefined||!Number.isFinite(stamp))||stamps.some((stamp,index)=>index>0&&stamp! < stamps[index-1]!)||
    row.coordinatorPostedAtMs===undefined||!Number.isFinite(row.coordinatorPostedAtMs)||row.coordinatorPostedAtMs<row.coordinatorDispatchAtMs||row.coordinatorPostedAtMs>row.coordinatorReceivedAtMs!)return undefined;
  const [dispatch,receipt,computeStart,computeEnd,resultPost,received]=stamps as number[];
  return {coordinatorPostMs:row.coordinatorPostedAtMs-dispatch!,dispatchToWorkerReceiptMs:receipt!-dispatch!,workerPreparationMs:computeStart!-receipt!,
    workerComputeWallMs:computeEnd!-computeStart!,workerResultPreparationMs:resultPost!-computeEnd!,resultBoundaryToCoordinatorReceiptMs:received!-resultPost!,
    dispatchToCoordinatorReceiptMs:received!-dispatch!};
}
type LaneIntervals=NonNullable<ReturnType<typeof visionLaneIntervals>>;
interface VisionPhaseTiming {
  batch:number;binding:VisionPhaseBinding;startedAtMs:number;sealedAtMs?:number;dispatchedAtMs?:number;resolvedAtMs?:number;completedAtMs?:number;
  groupCount:number;sourceCount:number;outcome:'pending'|'completed'|'failed';
}
class VisionTimingDiagnostics {
  readonly lanes:VisionLaneTiming[]=[];
  readonly phases:VisionPhaseTiming[]=[];
  private laneCompleted=0;
  private recovered=0;
  private missingOrInvalidWorkerTiming=0;
  private completedPhases=0;
  private phaseWallMs=0;
  private omittedLanes=0;
  private omittedPhases=0;
  private laneTotals:Partial<LaneIntervals>={};
  beginLane(row:VisionLaneTiming){this.lanes.push(row);if(this.lanes.length>TIMING_HISTORY_LIMIT){this.lanes.splice(TIMING_INITIAL_HISTORY,1);this.omittedLanes++;}return row;}
  beginPhase(row:VisionPhaseTiming){this.phases.push(row);if(this.phases.length>TIMING_HISTORY_LIMIT){this.phases.splice(TIMING_INITIAL_HISTORY,1);this.omittedPhases++;}return row;}
  endLane(row:VisionLaneTiming):void {
    this.laneCompleted++;
    if(row.outcome==='recovered'||row.outcome==='recovery-failed')this.recovered++;
    if(row.outcome!=='returned')return;
    const intervals=visionLaneIntervals(row);
    if(!intervals){this.missingOrInvalidWorkerTiming++;return;}
    for(const key of Object.keys(intervals) as (keyof LaneIntervals)[])this.laneTotals[key]=(this.laneTotals[key]??0)+intervals[key];
  }
  endPhase(row:VisionPhaseTiming):void {this.completedPhases++;this.phaseWallMs+=row.completedAtMs!-row.startedAtMs;}
  snapshot(){return {enabled:true as const,timingQualificationEligible:false as const,clock:'host-monotonic-hrtime-ms',historyLimit:TIMING_HISTORY_LIMIT,
    historyPolicy:{first:TIMING_INITIAL_HISTORY,latest:TIMING_HISTORY_LIMIT-TIMING_INITIAL_HISTORY,omittedLanes:this.omittedLanes,omittedPhases:this.omittedPhases},
    scope:'Wall-clock intervals, not CPU. Lane intervals overlap across workers. Coordinator post duration overlaps dispatch-to-worker-receipt. Receipt follows deserialization; result-boundary-to-coordinator-receipt includes result serialization, transport and coordinator scheduling. First request dispatch-to-receipt may include cold worker startup. Only phase wall totals describe non-overlapping pool calls; caller vision preparation/commit are outside the pool.',
    totals:{laneCompleted:this.laneCompleted,recovered:this.recovered,missingOrInvalidWorkerTiming:this.missingOrInvalidWorkerTiming,
      laneIntervalSumsMs:{...this.laneTotals},completedPhases:this.completedPhases,phaseWallMs:this.phaseWallMs},
    recentLanes:this.lanes.map(row=>({...row,binding:{...row.binding},...(row.worker?{worker:{...row.worker,...(row.worker.kernelWork?{kernelWork:{...row.worker.kernelWork}}:{})}}:{}),intervals:visionLaneIntervals(row)})),
    recentPhases:this.phases.map(row=>({...row,binding:{...row.binding}}))};}
}

interface Pending {
  generation:number;batch:number;binding:VisionPhaseBinding;frame:VisionMaskFrame;
  exchangeKey:string;sources:VisionSourceExchange;
  timer:NodeJS.Timeout;resolve:(value:VisionMaskResult[])=>void;reject:(error:Error)=>void;
  timing?:VisionLaneTiming;
}
interface SourceGroup {group:VisionMaskGroup;byId:Map<string,VisionMaskSource>}
interface ResultRevision {revision:number;result:VisionMaskResult}
interface Lane {
  worker:Worker;generation:number;geometryKey:string;pending?:Pending;failed:boolean;fallback:VisionMaskKernel;
  exchangeKey:string;sourceRevision:number;groups:readonly VisionMaskGroup[];results:Map<string,ResultRevision>;
  retryAtMs?:number;
}

function sourceExchange(groups:readonly VisionMaskGroup[],lane:Lane,exchangeKey:string):VisionSourceExchange {
  if(lane.exchangeKey!==exchangeKey||!lane.sourceRevision)return {mode:'full',baseRevision:0,revision:1,groups};
  const previous=new Map(lane.groups.map(group=>[group.key,group])),current=new Set(groups.map(group=>group.key));
  const update:Extract<VisionSourceExchange,{mode:'delta'}>={mode:'delta',baseRevision:lane.sourceRevision,revision:lane.sourceRevision+1,groups:[],removed:lane.groups.filter(group=>!current.has(group.key)).map(group=>group.key)};
  if(groups.length!==lane.groups.length||groups.some((group,index)=>group.key!==lane.groups[index]!.key))update.order=groups.map(group=>group.key);
  for(const group of groups){
    const before=previous.get(group.key);if(before===group)continue;
    const oldSources=new Map(before?.sources.map(source=>[source.id,source])),live=new Set(group.sources.map(source=>source.id));
    const upserts=group.sources.filter(source=>oldSources.get(source.id)!==source),removed=before?.sources.filter(source=>!live.has(source.id)).map(source=>source.id)??[];
    const order=!before||before.sources.length!==group.sources.length||group.sources.some((source,index)=>source.id!==before.sources[index]!.id)?group.sources.map(source=>source.id):undefined;
    update.groups.push({key:group.key,upserts,removed,...(order?{order}:{})});
  }
  return update;
}

/** Persistent perception workers. A complete phase is committed by the caller only
 * after every group returns; OS arrival order cannot select which fog is current.
 * Worker caches are disposable, so failure recomputes the identical sealed input.
 */
export class VisionWorkerPool {
  private lanes:Lane[]=[];
  private batch=0;
  private generation=0;
  private busy=false;
  private closed=false;
  private completed=0;
  private recovered=0;
  private staleReplies=0;
  private geometryTransfers=0;
  private timeoutMs:number;
  private geometry?:{key:string;blockers:VisionMaskFrame['blockers']};
  private timing?:VisionTimingDiagnostics;
  private sourceGroups=new Map<string,SourceGroup>();
  private inlineFallback=new VisionMaskKernel();
  private sourceFullFrames=0;
  private sourceDeltaFrames=0;
  private sourceRecordsSent=0;
  private resultGroupsTransferred=0;
  private resultGroupsReused=0;
  private coordinatorGroupsReused=0;
  private emptyLanesSkipped=0;
  private unusualFrames=0;
  private recoveryPhasesInline=0;
  private retryDelayMs:number;

  constructor(options:{size?:number;timeoutMs?:number;performanceDiagnostics?:boolean;retryDelayMs?:number}={}){
    const size=options.size??2;
    if(!Number.isInteger(size)||size<1||size>8)throw new Error('INVALID_VISION_POOL_SIZE');
    // A live tick may need two perception phases after its bounded path batch.
    this.timeoutMs=options.timeoutMs??2000;
    if(!Number.isFinite(this.timeoutMs)||this.timeoutMs<=0)throw new Error('INVALID_VISION_WORKER_TIMEOUT');
    this.retryDelayMs=options.retryDelayMs??0;
    if(!Number.isFinite(this.retryDelayMs)||this.retryDelayMs<0||this.retryDelayMs>30000)throw new Error('INVALID_VISION_WORKER_RETRY_DELAY');
    if(options.performanceDiagnostics)this.timing=new VisionTimingDiagnostics();
    for(let index=0;index<size;index++)this.lanes.push(this.spawn());
  }

  private spawn():Lane {
    const built=new URL('./vision-worker.js',import.meta.url),env=computeWorkerEnvironment();
    const worker=existsSync(fileURLToPath(built))?new Worker(built,{env,execArgv:[]}):new Worker(
      `import('tsx/esm/api').then(({tsImport}) => tsImport(${JSON.stringify(new URL('./vision-worker.ts',import.meta.url).href)}, ${JSON.stringify(import.meta.url)}))`,
      {eval:true,env,execArgv:[]},
    );
    const lane:Lane={worker,generation:++this.generation,geometryKey:'',failed:false,fallback:new VisionMaskKernel(),exchangeKey:'',sourceRevision:0,groups:[],results:new Map()};
    worker.on('message',(message:VisionWorkerResponse)=>{
      const receivedAtMs=this.timing?diagnosticNow():undefined;
      const pending=lane.pending;
      if(!pending||message.type!=='vision-result'||message.generation!==pending.generation||message.batch!==pending.batch||!sameVisionBinding(message.binding,pending.binding)){
        this.staleReplies++;return;
      }
      if(pending.timing){pending.timing.coordinatorReceivedAtMs=receivedAtMs;if(message.diagnosticTiming)pending.timing.worker={...message.diagnosticTiming};}
      if(message.error||!message.results||message.exchangeKey!==pending.exchangeKey||message.sourceBaseRevision!==pending.sources.baseRevision||message.sourceRevision!==pending.sources.revision){this.recover(lane);return;}
      const expected=pending.frame.groups;
      if(message.results.length!==expected.length){this.recover(lane);return;}
      const nextResults=new Map<string,ResultRevision>(),results:VisionMaskResult[]=[];let transferred=0,reused=0;
      for(let index=0;index<expected.length;index++){
        const update=message.results[index]!,key=expected[index]!.key,previous=pending.sources.mode==='full'?undefined:lane.results.get(key),baseRevision=previous?.revision??0;
        if(update.key!==key||update.baseRevision!==baseRevision||!Number.isSafeInteger(update.revision)) {this.recover(lane);return;}
        if(update.result){
          if(update.revision!==baseRevision+1||!(update.result.mask instanceof Uint8Array)||update.result.mask.length!==pending.frame.width*pending.frame.height||!Array.isArray(update.result.visible)){this.recover(lane);return;}
          // Private immutable phase ownership: never publish or mutate this mask.
          // The worker transferred an independent copy, not its retained kernel.
          const result=Object.freeze({key,mask:update.result.mask,visible:Object.freeze(update.result.visible) as unknown as number[]});
          nextResults.set(key,{revision:update.revision,result});results.push(result);transferred++;
        }else{
          if(!previous||update.revision!==baseRevision){this.recover(lane);return;}
          nextResults.set(key,previous);results.push(previous.result);reused++;
        }
      }
      lane.exchangeKey=pending.exchangeKey;lane.sourceRevision=pending.sources.revision;lane.groups=pending.frame.groups;lane.results=nextResults;
      this.resultGroupsTransferred+=transferred;this.resultGroupsReused+=reused;
      clearTimeout(pending.timer);lane.pending=undefined;
      if(pending.timing){pending.timing.outcome='returned';this.timing!.endLane(pending.timing);}
      pending.resolve(results);
    });
    worker.on('error',()=>this.recover(lane));
    worker.on('exit',()=>{if(!this.closed)this.recover(lane);});
    return lane;
  }

  /** Seal only source scalars. Equal records and ordered arrays retain ownership;
   * callers may mutate every supplied object immediately after compute returns. */
  private sealGroups(groups:readonly VisionMaskGroup[]):{groups:VisionMaskGroup[];unusual:boolean}{
    const next=new Map<string,SourceGroup>(),sealed:VisionMaskGroup[]=[];let unusual=false;
    for(const group of groups){
      if(next.has(group.key))unusual=true;
      const previous=this.sourceGroups.get(group.key),sources:VisionMaskSource[]=[],byId=new Map<string,VisionMaskSource>();
      if(isImmutableVisionGroup(group)){
        const owned=previous?.group===group?previous:{group,byId:new Map(group.sources.map(source=>[source.id,source]))};
        next.set(group.key,owned);sealed.push(group);continue;
      }
      for(const source of group.sources){
        if(byId.has(source.id))unusual=true;
        const old=previous?.byId.get(source.id),owned=old&&old.xMm===source.xMm&&old.zMm===source.zMm&&old.radius===source.radius&&old.kind===source.kind?old:{id:source.id,xMm:source.xMm,zMm:source.zMm,radius:source.radius,...(source.kind?{kind:source.kind}:{})};
        sources.push(owned);byId.set(source.id,owned);
      }
      const unchanged=previous&&previous.group.sources.length===sources.length&&sources.every((source,index)=>source===previous.group.sources[index]);
      const owned=unchanged?previous:{group:{key:group.key,sources},byId};next.set(group.key,owned);sealed.push(owned.group);
    }
    this.sourceGroups=next;return {groups:sealed,unusual};
  }

  private recover(lane:Lane):void {
    if(this.closed)return;
    if(!lane.failed){lane.failed=true;lane.geometryKey='';lane.retryAtMs=performance.now()+this.retryDelayMs;void lane.worker.terminate();}
    const pending=lane.pending;
    if(!pending)return;
    clearTimeout(pending.timer);lane.pending=undefined;this.recovered++;
    if(pending.timing)pending.timing.fallbackStartedAtMs=diagnosticNow();
    try{pending.resolve(lane.fallback.compute(pending.frame));if(pending.timing)pending.timing.outcome='recovered';}
    catch(error){if(pending.timing)pending.timing.outcome='recovery-failed';pending.reject(error instanceof Error?error:new Error('VISION_RECOVERY_FAILED'));}
    finally{if(pending.timing){pending.timing.fallbackEndedAtMs=diagnosticNow();this.timing!.endLane(pending.timing);}}
  }

  async compute(frame:VisionMaskFrame,binding:VisionPhaseBinding):Promise<VisionMaskResult[]> {
    if(this.closed)throw new Error('VISION_POOL_CLOSED');
    if(this.busy)throw new Error('VISION_PHASE_IN_PROGRESS');
    this.busy=true;
    const phase=this.timing?.beginPhase({batch:this.batch+1,binding:{...binding},startedAtMs:diagnosticNow(),groupCount:frame.groups.length,
      sourceCount:frame.groups.reduce((sum,group)=>sum+group.sources.length,0),outcome:'pending'});
    try{
      // Own sources for deterministic recovery. Immutable terrain is cloned only
      // when its bound revision changes, then retained in every worker as well.
      const key=visionGeometryKey(frame);
      if(this.geometry?.key!==key)this.geometry={key,blockers:structuredClone(frame.blockers)};
      const sealed=this.sealGroups(frame.groups),snapshot:VisionMaskFrame={...frame,blockers:this.geometry.blockers,groups:sealed.groups},sealedBinding={...binding},batch=++this.batch;
      if(phase)phase.sealedAtMs=diagnosticNow();
      // The synchronous reference preserves ordered duplicate-ID behavior. Such
      // fixtures cannot be represented by keyed deltas and never alter lane bases.
      if(sealed.unusual){this.unusualFrames++;const result=this.inlineFallback.compute(snapshot);this.completed++;if(phase){phase.dispatchedAtMs=phase.resolvedAtMs=diagnosticNow();phase.outcome='completed';}return result;}
      const partitions=this.lanes.map(()=>[] as VisionMaskFrame['groups'][number][]);
      for(let index=0;index<snapshot.groups.length;index++)partitions[index%partitions.length]!.push(snapshot.groups[index]!);
      const work=partitions.map((groups,index)=>{
        let lane=this.lanes[index]!;
        // Empty lanes have no contribution to this phase. Their retained bases
        // remain private and are reconciled if groups are assigned again later.
        if(!groups.length){this.emptyLanesSkipped++;return Promise.resolve([] as VisionMaskResult[]);}
        const input:VisionMaskFrame={...snapshot,groups},exchangeKey=visionExchangeKey(input,sealedBinding);
        // sealGroups compared every source scalar against our private records.
        // With the same geometry and match/epoch, identical ordered groups give
        // exactly the same mask. No worker round trip or empty delta is needed.
        // A failed lane must recover before its publications can be reused.
        if(!lane.failed&&lane.geometryKey===key&&lane.exchangeKey===exchangeKey&&lane.sourceRevision>0&&
          lane.groups.length===groups.length&&groups.every((group,index)=>group===lane.groups[index])&&
          lane.results.size===groups.length&&groups.every(group=>lane.results.has(group.key))){
          this.coordinatorGroupsReused+=groups.length;
          return Promise.resolve(groups.map(group=>lane.results.get(group.key)!.result));
        }
        // A coarse authority frame can contain several dependent contact
        // phases. One broken lane must not impose its timeout on every slice;
        // exact local computation preserves play while a bounded retry waits.
        if(lane.failed&&performance.now()<(lane.retryAtMs??0)){this.recoveryPhasesInline++;return Promise.resolve(lane.fallback.computeRetained(input));}
        if(lane.failed){lane=this.spawn();this.lanes[index]=lane;}
        return new Promise<VisionMaskResult[]>((resolve,reject)=>{
          const timer=setTimeout(()=>this.recover(lane),this.timeoutMs);
          const sources=sourceExchange(groups,lane,exchangeKey);
          lane.pending={generation:lane.generation,batch,binding:sealedBinding,frame:input,exchangeKey,sources,timer,resolve,reject};
          const {blockers,groups:sourceGroups,...messageFrame}=input,key=visionGeometryKey(input);
          const request:VisionWorkerRequest={type:'vision',generation:lane.generation,batch,binding:sealedBinding,frame:messageFrame,exchangeKey,sources};
          const firstRequest=this.timing?lane.geometryKey==='':undefined;
          if(lane.geometryKey!==key||sources.mode==='full'){request.geometry=blockers;lane.geometryKey=key;this.geometryTransfers++;}
          if(sources.mode==='full'){this.sourceFullFrames++;this.sourceRecordsSent+=sourceGroups.reduce((sum,group)=>sum+group.sources.length,0);}
          else{this.sourceDeltaFrames++;this.sourceRecordsSent+=sources.groups.reduce((sum,group)=>sum+group.upserts.length,0);}
          const timing=this.timing?.beginLane({generation:lane.generation,batch,binding:sealedBinding,lane:index,threadId:lane.worker.threadId,
            groupCount:groups.length,sourceCount:groups.reduce((sum,group)=>sum+group.sources.length,0),geometryTransferred:request.geometry!==undefined,firstRequest:firstRequest!,
            coordinatorDispatchAtMs:diagnosticNow(),outcome:'pending'});
          if(timing){lane.pending!.timing=timing;request.diagnosticTiming=true;}
          try{lane.worker.postMessage(request);if(timing)timing.coordinatorPostedAtMs=diagnosticNow();}
          catch{if(timing)timing.coordinatorPostedAtMs=diagnosticNow();this.recover(lane);}
        });
      });
      if(phase)phase.dispatchedAtMs=diagnosticNow();
      const received=await Promise.all(work);
      if(phase)phase.resolvedAtMs=diagnosticNow();
      const results=received.flat(),byGroup=new Map(results.map(result=>[result.key,result]));
      this.completed++;
      const ordered=snapshot.groups.map(group=>byGroup.get(group.key)!);
      if(phase)phase.outcome='completed';
      return ordered;
    }finally{this.busy=false;if(phase){if(phase.outcome==='pending')phase.outcome='failed';phase.completedAtMs=diagnosticNow();this.timing!.endPhase(phase);}}
  }

  diagnostics(){return {size:this.lanes.length,threadIds:this.lanes.map(lane=>lane.worker.threadId),busy:this.busy,completed:this.completed,recovered:this.recovered,staleReplies:this.staleReplies,geometryTransfers:this.geometryTransfers,
    sourceFullFrames:this.sourceFullFrames,sourceDeltaFrames:this.sourceDeltaFrames,sourceRecordsSent:this.sourceRecordsSent,resultGroupsTransferred:this.resultGroupsTransferred,resultGroupsReused:this.resultGroupsReused,
    coordinatorGroupsReused:this.coordinatorGroupsReused,emptyLanesSkipped:this.emptyLanesSkipped,unusualFrames:this.unusualFrames,recoveryPhasesInline:this.recoveryPhasesInline,
    ...(this.timing?{timing:this.timing.snapshot()}:{})};}

  async close():Promise<void> {
    if(this.closed)return;this.closed=true;
    for(const lane of this.lanes){const pending=lane.pending;if(pending){clearTimeout(pending.timer);lane.pending=undefined;if(pending.timing){pending.timing.outcome='closed';this.timing!.endLane(pending.timing);}pending.reject(new Error('VISION_POOL_CLOSED'));}}
    await Promise.all(this.lanes.map(lane=>lane.worker.terminate()));
  }
}
