import type { PathRequest, PathWorkClass } from './path-scheduler.js';
import { PlanningWorkCensus, PlanningOverlapCensus, planningCompatibility, planningTaskDetails, type DiagnosticTask, type PlanningTaskDetails } from './planning-work-diagnostics.js';

/** Private, opt-in diagnostics. None of these values participate in scheduling or saves. */
export interface PathDiagnosticClock {tick:()=>number;now:()=>number}
interface Stamp {tick:number|null;ms:number|null}
interface Ages {originalTicks:number|null;originalMs:number|null;restartTicks:number|null;restartMs:number|null;observedTicks:number|null;observedMs:number|null}
type Outcome='request'|'restart'|'ready'|'blocked'|'taken-ready'|'taken-blocked'|'cancel'|'superseded'|'observe-existing'|'observe-restored';
interface Tracked {request:PathRequest;original:Stamp;restart:Stamp;observed:Stamp;status:'pending'|'ready'|'blocked';details?:PlanningTaskDetails}
export interface PathDiagnosticEvent extends Ages {sequence:number;kind:Outcome;tick:number|null;ms:number|null;id:string;unitId:string;orderRevision:number;profile:string}
export interface Distribution {known:number;unknown:number;p50:number|null;p95:number|null;oldest:number|null}
type AgeDistributions=Record<keyof Ages,Distribution>;
interface GoalGroup {profile:string;radiusMm:number;xMm:number;zMm:number;requests:number}
const TRACK_LIMIT=4096,EVENT_LIMIT=256,SAMPLE_LIMIT=512,GROUP_LIMIT=16,REGION_MM=16000;
const emptyStamp=():Stamp=>({tick:null,ms:null});
const age=(current:number|null,start:number|null)=>current===null||start===null||current<start?null:current-start;
export interface PathQueueTask {request:PathRequest;status:'pending'|'ready'|'blocked'}
interface QueueCounts {pending:number;ready:number;blocked:number}
export interface PathQueueSummary extends QueueCounts {
  scope:'host-private-current-requests';tick:number|null;total:number;
  attemptScope:'unobserved'|'scheduler-events'|'coordinator-committed-events';
  ageScope:'Pending requests only; original enqueue tick survives restore; attempt age is unknown before observation. Class counts use declared class; agedRoutine is promoted service.';
  profiles:{profile:string;pending:number;ready:number;blocked:number;classes:{workClass:PathWorkClass;pending:number;ready:number;blocked:number;agedRoutine:number;requestAgeTicks:Distribution;attemptAgeTicks:Distribution}[]}[];
  omittedProfiles:number;omittedRequests:number;
}
/** Called only when host diagnostics are requested, never during a planning grant. */
export function summarizePathQueue(tasks:Iterable<PathQueueTask>,tick:number,census?:PathPlanningCensus):PathQueueSummary {
  const now=Number.isSafeInteger(tick)&&tick>=0?tick:null;
  type Row=QueueCounts&{agedRoutine:number;requestAges:(number|null)[];attemptAges:(number|null)[]};
  const profiles=new Map<string,Map<PathWorkClass,Row>>(),omittedProfiles=new Set<string>();
  const result:PathQueueSummary={scope:'host-private-current-requests',tick:now,total:0,pending:0,ready:0,blocked:0,attemptScope:census?census.collection==='coordinator-observation'?'coordinator-committed-events':'scheduler-events':'unobserved',ageScope:'Pending requests only; original enqueue tick survives restore; attempt age is unknown before observation. Class counts use declared class; agedRoutine is promoted service.',profiles:[],omittedProfiles:0,omittedRequests:0};
  for(const {request,status}of tasks){
    result.total++;result[status]++;
    let classes=profiles.get(request.profile);
    if(!classes){if(profiles.size>=11){omittedProfiles.add(request.profile);result.omittedRequests++;continue;}classes=new Map();profiles.set(request.profile,classes);}
    const workClass=request.workClass??'interactive';let row=classes.get(workClass);
    if(!row){row={pending:0,ready:0,blocked:0,agedRoutine:0,requestAges:[],attemptAges:[]};classes.set(workClass,row);}row[status]++;
    if(status==='pending'){
      const starts=census?.ageStarts(request.unitId),requestAge=age(now,request.enqueuedTick??starts?.requestTick??null);
      if(workClass==='routine'&&requestAge!==null&&requestAge>=40)row.agedRoutine++;
      if(row.requestAges.length<TRACK_LIMIT){row.requestAges.push(requestAge);row.attemptAges.push(age(now,starts?.attemptTick??null));}
    }
  }
  const distribution=(values:readonly (number|null)[],total:number):Distribution=>{const known=values.filter((value):value is number=>value!==null).sort((a,b)=>a-b);return {known:known.length,unknown:total-known.length,p50:known.length?known[Math.ceil(known.length*.5)-1]!:null,p95:known.length?known[Math.ceil(known.length*.95)-1]!:null,oldest:known.at(-1)??null};};
  for(const [profile,classes]of [...profiles].sort(([a],[b])=>a<b?-1:a>b?1:0)){
    const counts:QueueCounts={pending:0,ready:0,blocked:0};
    const rows=(['interactive','routine','optional'] as const).map(workClass=>{const row=classes.get(workClass)??{pending:0,ready:0,blocked:0,agedRoutine:0,requestAges:[],attemptAges:[]};counts.pending+=row.pending;counts.ready+=row.ready;counts.blocked+=row.blocked;return {workClass,pending:row.pending,ready:row.ready,blocked:row.blocked,agedRoutine:row.agedRoutine,requestAgeTicks:distribution(row.requestAges,row.pending),attemptAgeTicks:distribution(row.attemptAges,row.pending)};});
    result.profiles.push({profile,...counts,classes:rows});
  }
  result.omittedProfiles=omittedProfiles.size;return result;
}
function ages(record:Tracked,stamp:Stamp):Ages{return {originalTicks:age(stamp.tick,record.original.tick),originalMs:age(stamp.ms,record.original.ms),restartTicks:age(stamp.tick,record.restart.tick),restartMs:age(stamp.ms,record.restart.ms),observedTicks:age(stamp.tick,record.observed.tick),observedMs:age(stamp.ms,record.observed.ms)};}
function distributions(values:readonly Ages[]):AgeDistributions {
  const result={} as AgeDistributions;
  for(const key of ['originalTicks','originalMs','restartTicks','restartMs','observedTicks','observedMs'] as const){
    const sorted=values.flatMap(value=>value[key]===null?[]:[value[key]!]).sort((a,b)=>a-b);
    result[key]={known:sorted.length,unknown:values.length-sorted.length,p50:sorted.length?sorted[Math.ceil(sorted.length*.5)-1]!:null,p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]!:null,oldest:sorted.at(-1)??null};
  }
  return result;
}
class Ring<T> {
  private values:T[]=[];private cursor=0;overwritten=0;
  constructor(private readonly capacity:number){}
  push(value:T):void{if(this.values.length<this.capacity)this.values.push(value);else{this.values[this.cursor]=value;this.cursor=(this.cursor+1)%this.capacity;this.overwritten++;}}
  snapshot():T[]{return this.values.length<this.capacity?[...this.values]:[...this.values.slice(this.cursor),...this.values.slice(0,this.cursor)];}
}
export interface PathPlanningDiagnostics {
  scope:'host-private-opt-in';tick:number|null;ms:number|null;
  collection:'inline-instrumented'|'coordinator-observation';executionAvailable:boolean;
  limits:{trackedRequests:number;lifecycleEvents:number;completionSamples:number;reportedGoalGroups:number};
  counts:{requests:number;restarts:number;ready:number;blocked:number;takenReady:number;takenBlocked:number;pendingTakes:number;missingTakes:number;canceled:number;superseded:number;invalidations:number;observedExisting:number;observedRestored:number;discardedOnRestore:number;trackingDropped:number;invalidClockReads:number};
  active:{total:number;tracked:number;untracked:number;pending:number;ready:number;blocked:number};
  pendingAges:AgeDistributions;untakenReadyAges:AgeDistributions;
  completionAges:{samples:number;overwritten:number;ready:number;blocked:number;ages:AgeDistributions;readyAges:AgeDistributions;blockedAges:AgeDistributions};
  demand:{scope:'tracked-pending-candidates-only';compatibilityProven:false;exactGoalGroups:number;exactGoalSharedRequests:number;regionGoalGroups:number;regionGoalSharedRequests:number;largestExactGoals:GoalGroup[];largestRegions:GoalGroup[]};
  events:PathDiagnosticEvent[];eventsOverwritten:number;
  execution:ReturnType<PlanningWorkCensus['snapshot']>;compatibility:ReturnType<typeof planningCompatibility>;overlap:ReturnType<PlanningOverlapCensus['snapshot']>;
}

/** Bounded observation state; snapshot scans at most TRACK_LIMIT records, never scheduler frontiers. */
export class PathPlanningCensus {
  private records=new Map<string,Tracked>();
  private events=new Ring<PathDiagnosticEvent>(EVENT_LIMIT);
  private completions=new Ring<{status:'ready'|'blocked';ages:Ages}>(SAMPLE_LIMIT);
  private sequence=0;private restartingUnit:string|undefined;
  private counts={requests:0,restarts:0,ready:0,blocked:0,takenReady:0,takenBlocked:0,pendingTakes:0,missingTakes:0,canceled:0,superseded:0,invalidations:0,observedExisting:0,observedRestored:0,discardedOnRestore:0,trackingDropped:0,invalidClockReads:0};
  readonly execution:PlanningWorkCensus;
  private readonly overlap=new PlanningOverlapCensus();
  constructor(private readonly clock:PathDiagnosticClock,readonly collection:PathPlanningDiagnostics['collection']='inline-instrumented'){this.execution=new PlanningWorkCensus(clock);}
  ageStarts(unitId:string):{requestTick:number|null;attemptTick:number|null}|undefined {const record=this.records.get(unitId);return record?{requestTick:record.original.tick,attemptTick:record.restart.tick}:undefined;}
  progressed(task:DiagnosticTask):void{
    const record=this.records.get(task.unitId);if(!record)return;
    const prior=record.details;
    // Component arrays are established together with cacheKey once, then stay
    // immutable for this task. Restart/restore replaces the observation record.
    // Copy/group only at those metadata boundaries, not every charged work unit.
    if(prior&&prior.stage===task.stage&&prior.cacheKey===task.cacheKey){
      prior.directRemaining=Number.isSafeInteger(task.lineSteps)&&Number.isSafeInteger(task.lineStep)&&task.lineSteps!>=task.lineStep!?task.lineSteps!-task.lineStep!:null;return;
    }
    record.details=planningTaskDetails(task);this.overlap.update(record.request,record.details,task.stage!=='done');
  }
  private stamp():Stamp {
    let tick:number|null=null,ms:number|null=null;
    try{const value=this.clock.tick();if(Number.isSafeInteger(value)&&value>=0)tick=value;else this.counts.invalidClockReads++;}catch{this.counts.invalidClockReads++;}
    try{const value=this.clock.now();if(Number.isFinite(value)&&value>=0)ms=value;else this.counts.invalidClockReads++;}catch{this.counts.invalidClockReads++;}
    return {tick,ms};
  }
  private emit(kind:Outcome,request:PathRequest,record:Tracked|undefined,stamp:Stamp):void {
    const unknown:Ages={originalTicks:null,originalMs:null,restartTicks:null,restartMs:null,observedTicks:null,observedMs:null};
    this.events.push({sequence:++this.sequence,kind,...stamp,id:request.id.slice(0,160),unitId:request.unitId.slice(0,160),orderRevision:request.orderRevision,profile:request.profile.slice(0,160),...(record?ages(record,stamp):unknown)});
  }
  private track(request:PathRequest,stamp:Stamp,known:boolean,status:Tracked['status']='pending'):Tracked|undefined {
    if(this.records.size>=TRACK_LIMIT){this.counts.trackingDropped++;return;}
    // Copy only identity/endpoint fields: observed tasks also carry large mutable search frontiers.
    const {id,unitId,orderRevision,profile,radiusMm}=request;
    const original=known?{...stamp}:emptyStamp();if(request.enqueuedTick!==undefined){original.tick=request.enqueuedTick;if(request.enqueuedTick!==stamp.tick)original.ms=null;}
    const record:Tracked={request:{id,unitId,orderRevision,profile,radiusMm,from:{...request.from},target:{...request.target},...(request.workClass!==undefined?{workClass:request.workClass,enqueuedTick:request.enqueuedTick}:{})},original,restart:known?{...stamp}:emptyStamp(),observed:stamp,status};this.records.set(request.unitId,record);return record;
  }
  observe(tasks:Iterable<PathRequest&{stage:string;result?:{status:string}}>,restored:boolean):void {
    if(restored){this.counts.discardedOnRestore+=this.records.size;this.records.clear();this.overlap.clearActive();this.restartingUnit=undefined;}
    const stamp=this.stamp();
    for(const task of tasks){const status=task.stage==='done'&&task.result?.status==='ready'?'ready':task.stage==='done'&&task.result?.status==='blocked'?'blocked':'pending';
      if(restored)this.counts.observedRestored++;else this.counts.observedExisting++;
      const record=this.track(task,stamp,false,status);if(record){record.details=planningTaskDetails(task);this.overlap.update(record.request,record.details,status==='pending');}this.emit(restored?'observe-restored':'observe-existing',task,record,stamp);
    }
  }
  requested(request:PathRequest,replaced:boolean):void {
    const stamp=this.stamp(),prior=this.records.get(request.unitId),restart=this.restartingUnit===request.unitId;this.restartingUnit=undefined;
    if(restart){this.overlap.remove(request.unitId);this.counts.restarts++;if(prior){prior.restart=stamp;prior.status='pending';delete prior.details;this.emit('restart',request,prior,stamp);}else{const record=this.track(request,stamp,false);if(record)record.restart=stamp;this.emit('restart',request,record,stamp);}return;}
    if(replaced)this.counts.superseded++;
    if(prior){this.emit('superseded',prior.request,prior,stamp);this.records.delete(request.unitId);this.overlap.remove(request.unitId);}
    this.counts.requests++;const record=this.track(request,stamp,true);if(record)record.details=planningTaskDetails({...request,stage:'direct'});this.emit('request',request,record,stamp);
  }
  invalidated(unitId:string):void{this.counts.invalidations++;this.restartingUnit=unitId;}
  prepareRestart(unitId:string):void{this.restartingUnit=unitId;}
  restarted(request:PathRequest):void{this.restartingUnit=request.unitId;this.requested(request,false);}
  completed(request:PathRequest,status:'ready'|'blocked'):void {
    this.overlap.remove(request.unitId);
    this.counts[status]++;const record=this.records.get(request.unitId),stamp=this.stamp();
    if(record){record.status=status;this.completions.push({status,ages:ages(record,stamp)});}this.emit(status,request,record,stamp);
  }
  taken(request:PathRequest|undefined,status:'pending'|'ready'|'blocked'|'missing'):void {
    if(status==='missing'){this.counts.missingTakes++;return;}if(status==='pending'){this.counts.pendingTakes++;return;}
    if(status==='ready')this.counts.takenReady++;else this.counts.takenBlocked++;
    if(request){const record=this.records.get(request.unitId);this.emit(status==='ready'?'taken-ready':'taken-blocked',request,record,this.stamp());this.records.delete(request.unitId);this.overlap.remove(request.unitId);}
  }
  canceled(request:PathRequest):void {this.counts.canceled++;const record=this.records.get(request.unitId);this.emit('cancel',request,record,this.stamp());this.records.delete(request.unitId);this.overlap.remove(request.unitId);}
  snapshot(total:number):PathPlanningDiagnostics {
    const stamp={...this.stamp(),collection:this.collection,executionAvailable:this.collection==='inline-instrumented'},pending:Ages[]=[],ready:Ages[]=[],exact=new Map<string,GoalGroup>(),regions=new Map<string,GoalGroup>();let blocked=0;
    for(const record of this.records.values()){
      if(record.status==='ready'){ready.push(ages(record,stamp));continue;}if(record.status==='blocked'){blocked++;continue;}pending.push(ages(record,stamp));
      const {profile,radiusMm,target}=record.request;
      for(const [map,xMm,zMm]of [[exact,target.xMm,target.zMm],[regions,Math.floor(target.xMm/REGION_MM)*REGION_MM,Math.floor(target.zMm/REGION_MM)*REGION_MM]] as const){
        const key=JSON.stringify([profile,radiusMm,xMm,zMm]),group=map.get(key);if(group)group.requests++;else map.set(key,{profile,radiusMm,xMm,zMm,requests:1});
      }
    }
    const shared=(map:Map<string,GoalGroup>)=>[...map.values()].reduce((sum,group)=>sum+(group.requests>1?group.requests:0),0);
    const largest=(map:Map<string,GoalGroup>)=>[...map.values()].sort((a,b)=>b.requests-a.requests||a.profile.localeCompare(b.profile)||a.radiusMm-b.radiusMm||a.xMm-b.xMm||a.zMm-b.zMm).slice(0,GROUP_LIMIT);
    const completed=this.completions.snapshot(),completedReady=completed.filter(value=>value.status==='ready').map(value=>value.ages),completedBlocked=completed.filter(value=>value.status==='blocked').map(value=>value.ages);
    return {scope:'host-private-opt-in',...stamp,limits:{trackedRequests:TRACK_LIMIT,lifecycleEvents:EVENT_LIMIT,completionSamples:SAMPLE_LIMIT,reportedGoalGroups:GROUP_LIMIT},counts:{...this.counts},active:{total,tracked:this.records.size,untracked:Math.max(0,total-this.records.size),pending:pending.length,ready:ready.length,blocked},pendingAges:distributions(pending),untakenReadyAges:distributions(ready),completionAges:{samples:completed.length,overwritten:this.completions.overwritten,ready:completedReady.length,blocked:completedBlocked.length,ages:distributions(completed.map(value=>value.ages)),readyAges:distributions(completedReady),blockedAges:distributions(completedBlocked)},demand:{scope:'tracked-pending-candidates-only',compatibilityProven:false,exactGoalGroups:exact.size,exactGoalSharedRequests:shared(exact),regionGoalGroups:regions.size,regionGoalSharedRequests:shared(regions),largestExactGoals:largest(exact),largestRegions:largest(regions)},execution:this.execution.snapshot(),compatibility:planningCompatibility([...this.records.values()].filter(record=>record.status==='pending')),overlap:this.overlap.snapshot(),events:structuredClone(this.events.snapshot()),eventsOverwritten:this.events.overwritten};
  }
}
