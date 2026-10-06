/** Qualification evidence only; this module neither changes nor samples a game. */
export interface QualificationMemorySample {
  elapsedMs:number;
  workerHeapMiB:number;
  processRssMiB:number;
  runnerHeapMiB:number;
}
export type QualificationMemoryStatus='no_sustained_growth_detected'|'sustained_growth'|'growth_requires_review'|'insufficient_samples'|'insufficient_gc_evidence';
export const QUALIFICATION_MEMORY_CRITERIA={
  warmupMs:300_000,windowMs:300_000,minimumCompleteWindows:10,minimumDistinctSecondsPerWindow:240,maximumSampleGapMs:10_000,
  lowWaterQuantile:0.1,recentWindows:6,minimumGcLikeEvents:2,gcMinimumDropMiB:2,gcMinimumDropFraction:0.05,gcEventSeparationMs:60_000,
  minimumFitR2:0.7,worker:{minimumIncreaseMiB:16,minimumIncreaseFraction:0.1,minimumSlopeMiBPerMinute:0.5},
  rss:{minimumIncreaseMiB:64,minimumIncreaseFraction:0.1,minimumSlopeMiBPerMinute:2},
  maximumSamples:20_000,maximumElapsedMs:86_400_000,
} as const;
type Measurements=Omit<QualificationMemorySample,'elapsedMs'>;
export interface MemoryWindowStatistics {min:number;p10:number;median:number;p90:number;max:number}
export interface QualificationMemoryWindow {
  fromMs:number;toMs:number;distinctSeconds:number;maximumGapMs:number;sufficientCoverage:boolean;
  workerHeapMiB:MemoryWindowStatistics|null;processRssMiB:MemoryWindowStatistics|null;runnerHeapMiB:MemoryWindowStatistics|null;
}
export interface MemoryTrend {
  windowCount:number;fromMs:number|null;toMs:number|null;
  slopeMiBPerMinute:number|null;r2:number|null;initialLowWaterMiB:number|null;finalLowWaterMiB:number|null;increaseMiB:number|null;increaseToleranceMiB:number|null;
  assessment:'within_measurement_tolerance'|'sustained_growth'|'growth_requires_review'|'insufficient_windows';
}
export interface MemoryTrendPair {all:MemoryTrend;recent:MemoryTrend;earlierGrowthObserved:boolean}
export interface QualificationMemoryAssessment {
  status:QualificationMemoryStatus;reasons:string[];criteria:typeof QUALIFICATION_MEMORY_CRITERIA;
  coverage:{completeWindowCount:number;sufficientWindowCount:number;allCompleteWindowsCovered:boolean;sufficient:boolean;fromMs:number;toMs:number;partialWindowMs:number};
  completeWindows:QualificationMemoryWindow[];
  worker:MemoryTrendPair;rss:MemoryTrendPair;runner:MemoryTrendPair;
  gcLikeEvents:{elapsedMs:number;previousHeapMiB:number;heapMiB:number;dropMiB:number;dropFraction:number}[];
  interpretation:{lowWater:string;gc:string;rss:string;runner:string;scope:string};
}
const metrics=['workerHeapMiB','processRssMiB','runnerHeapMiB'] as const;
const C=QUALIFICATION_MEMORY_CRITERIA;
function quantile(sorted:readonly number[],fraction:number):number {return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!;}
function median(values:readonly number[]):number {const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;}
function statistics(samples:readonly QualificationMemorySample[],metric:keyof Measurements):MemoryWindowStatistics|null {
  if(!samples.length)return null;const values=samples.map(sample=>sample[metric]).sort((a,b)=>a-b);
  return {min:values[0]!,p10:quantile(values,.1),median:median(values),p90:quantile(values,.9),max:values.at(-1)!};
}
function trend(windows:readonly QualificationMemoryWindow[],metric:keyof Measurements,criteria:typeof C.worker|typeof C.rss):MemoryTrend {
  const points=windows.flatMap(window=>window[metric]?[{x:(window.fromMs+window.toMs)/120_000,y:window[metric]!.p10,fromMs:window.fromMs,toMs:window.toMs}]:[]);
  if(points.length<2)return {windowCount:points.length,fromMs:points[0]?.fromMs??null,toMs:points.at(-1)?.toMs??null,slopeMiBPerMinute:null,r2:null,initialLowWaterMiB:null,finalLowWaterMiB:null,increaseMiB:null,increaseToleranceMiB:null,assessment:'insufficient_windows'};
  const meanX=points.reduce((sum,point)=>sum+point.x,0)/points.length,meanY=points.reduce((sum,point)=>sum+point.y,0)/points.length;
  const xx=points.reduce((sum,point)=>sum+(point.x-meanX)**2,0),xy=points.reduce((sum,point)=>sum+(point.x-meanX)*(point.y-meanY),0);
  const slope=xy/xx,variance=points.reduce((sum,point)=>sum+(point.y-meanY)**2,0),residual=points.reduce((sum,point)=>sum+(point.y-(meanY+slope*(point.x-meanX)))**2,0);
  const r2=variance===0?1:Math.max(0,Math.min(1,1-residual/variance));
  const initial=median(points.slice(0,2).map(point=>point.y)),final=median(points.slice(-2).map(point=>point.y)),increase=final-initial;
  const tolerance=Math.max(criteria.minimumIncreaseMiB,initial*criteria.minimumIncreaseFraction);
  const assessment=increase<=tolerance?'within_measurement_tolerance':slope>criteria.minimumSlopeMiBPerMinute&&r2>=C.minimumFitR2?'sustained_growth':'growth_requires_review';
  return {windowCount:points.length,fromMs:points[0]!.fromMs,toMs:points.at(-1)!.toMs,slopeMiBPerMinute:slope,r2,initialLowWaterMiB:initial,finalLowWaterMiB:final,increaseMiB:increase,increaseToleranceMiB:tolerance,assessment};
}
function pairedTrend(windows:readonly QualificationMemoryWindow[],metric:keyof Measurements,criteria:typeof C.worker|typeof C.rss):MemoryTrendPair {
  const all=trend(windows,metric,criteria),recent=trend(windows.slice(-C.recentWindows),metric,criteria);
  return {all,recent,earlierGrowthObserved:all.increaseMiB!==null&&all.increaseToleranceMiB!==null&&all.increaseMiB>all.increaseToleranceMiB};
}

/**
 * Conservative review thresholds, not proof of leak freedom or new game budgets.
 * Five-minute p10 values reduce transient allocation/GC peaks; the final 30 minutes
 * decide stability, while the complete history preserves earlier settling growth.
 * Missing coverage, absent GC evidence, or unresolved whole-process RSS growth must
 * leave qualification pending. The caller separately checks duration and the 4 GiB cap.
 */
export function assessQualificationMemory(input:readonly QualificationMemorySample[],elapsedMs:number):QualificationMemoryAssessment {
  if(!Array.isArray(input)||input.length>C.maximumSamples||!Number.isFinite(elapsedMs)||elapsedMs<0||elapsedMs>C.maximumElapsedMs)throw new Error('INVALID_MEMORY_ASSESSMENT_INPUT');
  for(const sample of input)if(!sample||!Number.isFinite(sample.elapsedMs)||sample.elapsedMs<0||sample.elapsedMs>elapsedMs||metrics.some(metric=>!Number.isFinite(sample[metric])||sample[metric]<0))throw new Error('INVALID_MEMORY_SAMPLE');
  const sorted=[...input].sort((a,b)=>a.elapsedMs-b.elapsedMs),count=Math.max(0,Math.floor((elapsedMs-C.warmupMs)/C.windowMs));
  const toMs=C.warmupMs+count*C.windowMs,completeWindows:QualificationMemoryWindow[]=[];
  const seconds=new Map<number,QualificationMemorySample>();
  // At most one measurement per second contributes, so duplicate polling cannot
  // manufacture coverage or change quantile weighting. Keep the latest in the bin.
  for(const sample of sorted)if(sample.elapsedMs>=C.warmupMs&&sample.elapsedMs<toMs)seconds.set(Math.floor(sample.elapsedMs/1000),sample);
  const observed=[...seconds.values()];let cursor=0;
  for(let index=0;index<count;index++){
    const fromMs=C.warmupMs+index*C.windowMs,endMs=fromMs+C.windowMs,samples:QualificationMemorySample[]=[];
    while(cursor<observed.length&&observed[cursor]!.elapsedMs<endMs)samples.push(observed[cursor++]!);
    let maximumGapMs=samples.length?Math.max(samples[0]!.elapsedMs-fromMs,endMs-samples.at(-1)!.elapsedMs):C.windowMs;
    for(let i=1;i<samples.length;i++)maximumGapMs=Math.max(maximumGapMs,samples[i]!.elapsedMs-samples[i-1]!.elapsedMs);
    completeWindows.push({fromMs,toMs:endMs,distinctSeconds:samples.length,maximumGapMs,sufficientCoverage:samples.length>=C.minimumDistinctSecondsPerWindow&&maximumGapMs<=C.maximumSampleGapMs,
      workerHeapMiB:statistics(samples,'workerHeapMiB'),processRssMiB:statistics(samples,'processRssMiB'),runnerHeapMiB:statistics(samples,'runnerHeapMiB')});
  }
  const allCompleteWindowsCovered=completeWindows.length>0&&completeWindows.every(window=>window.sufficientCoverage),sufficient=completeWindows.length>=C.minimumCompleteWindows&&allCompleteWindowsCovered;
  const worker=pairedTrend(completeWindows,'workerHeapMiB',C.worker),rss=pairedTrend(completeWindows,'processRssMiB',C.rss),runner=pairedTrend(completeWindows,'runnerHeapMiB',C.worker);
  const gcLikeEvents:QualificationMemoryAssessment['gcLikeEvents']=[];let lastGc=-Infinity;
  for(let index=1;index<observed.length;index++){
    const prior=observed[index-1]!,sample=observed[index]!,drop=prior.workerHeapMiB-sample.workerHeapMiB;
    if(sample.elapsedMs-prior.elapsedMs>C.maximumSampleGapMs||sample.elapsedMs-lastGc<C.gcEventSeparationMs||drop<Math.max(C.gcMinimumDropMiB,prior.workerHeapMiB*C.gcMinimumDropFraction))continue;
    gcLikeEvents.push({elapsedMs:sample.elapsedMs,previousHeapMiB:prior.workerHeapMiB,heapMiB:sample.workerHeapMiB,dropMiB:drop,dropFraction:prior.workerHeapMiB?drop/prior.workerHeapMiB:0});lastGc=sample.elapsedMs;
  }
  const reasons:string[]=[];let status:QualificationMemoryStatus;
  if(!sufficient){status='insufficient_samples';if(completeWindows.length<C.minimumCompleteWindows)reasons.push('INSUFFICIENT_COMPLETE_WINDOWS');if(!allCompleteWindowsCovered)reasons.push('INCOMPLETE_SAMPLE_COVERAGE');}
  else if(worker.recent.assessment==='sustained_growth'){status='sustained_growth';reasons.push('SUSTAINED_WORKER_HEAP_GROWTH');}
  else if(worker.recent.assessment==='growth_requires_review'||['sustained_growth','growth_requires_review'].includes(rss.recent.assessment)){
    status='growth_requires_review';if(worker.recent.assessment==='growth_requires_review')reasons.push('WORKER_HEAP_GROWTH_REQUIRES_REVIEW');
    if(['sustained_growth','growth_requires_review'].includes(rss.recent.assessment))reasons.push('WHOLE_PROCESS_RSS_GROWTH');
    if(['sustained_growth','growth_requires_review'].includes(runner.recent.assessment))reasons.push('RUNNER_HEAP_GROWTH_OBSERVED');
  }else if(gcLikeEvents.length<C.minimumGcLikeEvents){status='insufficient_gc_evidence';reasons.push('INSUFFICIENT_GC_LIKE_EVENTS');}
  else {status='no_sustained_growth_detected';if(worker.earlierGrowthObserved||rss.earlierGrowthObserved)reasons.push('EARLIER_GROWTH_SETTLED_IN_FINAL_WINDOWS');}
  return {status,reasons,criteria:C,coverage:{completeWindowCount:completeWindows.length,sufficientWindowCount:completeWindows.filter(window=>window.sufficientCoverage).length,allCompleteWindowsCovered,sufficient,fromMs:C.warmupMs,toMs,partialWindowMs:Math.max(0,elapsedMs-toMs)},completeWindows,worker,rss,runner,gcLikeEvents,
    interpretation:{lowWater:'Per-window p10; tolerances are review thresholds, not promised memory budgets.',gc:'GC-like observed heap drops are evidence of collection cycles, not instrumented GC events.',rss:'Whole-process RSS includes the worker, host, and six scripted client observers; persistent growth needs review even with flat worker heap.',runner:'Runner-isolate heap is reported alongside RSS. No subtraction or exact native-memory attribution is claimed.',scope:'No sustained growth detected within this sampled workload and these thresholds is not proof of leak freedom. Duration, gameplay coverage, and the 4 GiB limit are separate gates.'}};
}
