import { describe, expect, it } from 'vitest';
import { assessQualificationMemory, type QualificationMemorySample } from '../scripts/qualification-memory.js';

const hour=3_600_000;
function samples(change:(second:number)=>Partial<Omit<QualificationMemorySample,'elapsedMs'>>=()=>({}),durationMs=hour):QualificationMemorySample[]{
  return Array.from({length:Math.floor(durationMs/1000)+1},(_,second)=>({elapsedMs:second*1000,
    workerHeapMiB:200+second%90/90*24+Math.sin(second/19)*.05,
    processRssMiB:500+second%60/60*12,
    runnerHeapMiB:100+second*.0005,...change(second)}));
}
describe('qualification memory evidence',()=>{
  it('recognizes a stable working set with real allocation/collection sawtooth cycles',()=>{
    const result=assessQualificationMemory(samples(),hour);
    expect(result.status).toBe('no_sustained_growth_detected');expect(result.coverage).toMatchObject({completeWindowCount:11,sufficientWindowCount:11,sufficient:true});
    expect(result.worker.recent.assessment).toBe('within_measurement_tolerance');expect(Math.abs(result.worker.recent.slopeMiBPerMinute!)).toBeLessThan(.02);
    expect(result.gcLikeEvents.length).toBeGreaterThan(20);expect(result.completeWindows.every(window=>window.distinctSeconds===300)).toBe(true);
    expect(result.interpretation.scope).toContain('not proof of leak freedom');
  });
  it('detects steady retained worker-heap growth despite repeated collections and a sub-4-GiB RSS',()=>{
    const result=assessQualificationMemory(samples(second=>({workerHeapMiB:200+second/60*3+second%90/90*24})),hour);
    expect(result.status).toBe('sustained_growth');expect(result.reasons).toContain('SUSTAINED_WORKER_HEAP_GROWTH');
    expect(result.worker.recent.slopeMiBPerMinute).toBeCloseTo(3,1);expect(result.worker.recent.r2!).toBeGreaterThan(.99);expect(result.rss.recent.assessment).toBe('within_measurement_tolerance');
  });
  it('retains early bounded settling growth while recognizing a stable final thirty minutes',()=>{
    const result=assessQualificationMemory(samples(second=>({workerHeapMiB:200+Math.min(second,1200)/60*4+second%90/90*24})),hour);
    expect(result.status).toBe('no_sustained_growth_detected');expect(result.worker.earlierGrowthObserved).toBe(true);
    expect(result.worker.all.increaseMiB!).toBeGreaterThan(40);expect(result.worker.recent.increaseMiB!).toBeLessThan(1);expect(result.reasons).toContain('EARLIER_GROWTH_SETTLED_IN_FINAL_WINDOWS');
  });
  it('requires a substantial post-warmup duration and cannot invent coverage from duplicate polls',()=>{
    expect(assessQualificationMemory(samples(()=>({}),1_800_000),1_800_000).status).toBe('insufficient_samples');
    const sparse=samples().filter(sample=>sample.elapsedMs%5000===0).flatMap(sample=>[sample,{...sample},{...sample},{...sample},{...sample}]);
    const result=assessQualificationMemory(sparse,hour);expect(result.status).toBe('insufficient_samples');expect(result.completeWindows[0]!.distinctSeconds).toBe(60);
    expect(result.coverage.allCompleteWindowsCovered).toBe(false);
  });
  it('rejects a long blind interval even when that window has enough distinct seconds',()=>{
    const result=assessQualificationMemory(samples().filter(sample=>sample.elapsedMs<1_810_000||sample.elapsedMs>1_831_000),hour);
    expect(result.status).toBe('insufficient_samples');const gap=result.completeWindows.find(window=>!window.sufficientCoverage)!;
    expect(gap.distinctSeconds).toBeGreaterThan(240);expect(gap.maximumGapMs).toBeGreaterThan(10_000);
  });
  it('does not claim collection-stable memory from a flat trace without collection evidence',()=>{
    const result=assessQualificationMemory(samples(()=>({workerHeapMiB:200})),hour);
    expect(result.status).toBe('insufficient_gc_evidence');expect(result.gcLikeEvents).toHaveLength(0);expect(result.worker.recent.r2).toBe(1);
  });
  it('requires review of RSS growth despite stable worker heap and separately exposes runner overhead',()=>{
    const result=assessQualificationMemory(samples(second=>({processRssMiB:500+second/60*4,runnerHeapMiB:100+second/60*3})),hour);
    expect(result.status).toBe('growth_requires_review');expect(result.worker.recent.assessment).toBe('within_measurement_tolerance');
    expect(result.reasons).toContain('WHOLE_PROCESS_RSS_GROWTH');expect(result.reasons).toContain('RUNNER_HEAP_GROWTH_OBSERVED');
    expect(result.rss.recent.slopeMiBPerMinute).toBeCloseTo(4,10);expect(result.runner.recent.slopeMiBPerMinute).toBeCloseTo(3,10);
    expect(result.interpretation.runner).toContain('No subtraction');
  });
  it('keeps a large non-linear late increase pending instead of treating a poor fit as stability',()=>{
    const result=assessQualificationMemory(samples(second=>({workerHeapMiB:200+(second>=3_000?70:0)+second%90/90*24})),hour);
    expect(['sustained_growth','growth_requires_review']).toContain(result.status);expect(result.worker.recent.increaseMiB!).toBeGreaterThan(60);
  });
  it('is deterministic for chronologically equivalent data without mutating the input',()=>{
    const forward=samples(),reverse=[...forward].reverse(),first={...reverse[0]!};
    expect(assessQualificationMemory(reverse,hour)).toEqual(assessQualificationMemory(forward,hour));expect(reverse[0]).toEqual(first);
  });
  it('rejects invalid measurements and bounds workload instead of hiding malformed evidence',()=>{
    for(const workerHeapMiB of [NaN,Infinity,-1])expect(()=>assessQualificationMemory([{elapsedMs:1000,workerHeapMiB,processRssMiB:1,runnerHeapMiB:1}],hour)).toThrow('INVALID_MEMORY_SAMPLE');
    expect(()=>assessQualificationMemory([{elapsedMs:hour+1,workerHeapMiB:1,processRssMiB:1,runnerHeapMiB:1}],hour)).toThrow('INVALID_MEMORY_SAMPLE');
    expect(()=>assessQualificationMemory([],Infinity)).toThrow('INVALID_MEMORY_ASSESSMENT_INPUT');
    expect(()=>assessQualificationMemory(Array(20_001).fill({elapsedMs:1,workerHeapMiB:1,processRssMiB:1,runnerHeapMiB:1}),hour)).toThrow('INVALID_MEMORY_ASSESSMENT_INPUT');
  });
});
