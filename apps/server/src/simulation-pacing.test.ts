import { describe, expect, it } from 'vitest';
import { SimulationPacing, type OverloadPolicy } from './simulation-pacing.js';
const normalCadence={movementTier:0,movementDecisionIntervalMs:50,publicationIntervalMs:100,tierChanges:0,lastTierChange:null,memoryRecoveryBlocked:false};

describe('authoritative wall-clock pacing', () => {
  it('starts at the original fixed-step cadence and ignores debt at the overload boundary', () => {
    const pacing = new SimulationPacing(50);
    expect(pacing.snapshot()).toEqual({ policy: 'adaptive', speedPercent: 100, tickIntervalMs: 50,
      reductions: 0, selfPaced: false, deferredWallMs: 0, lastReduction: null, recoveries:0,lastRecovery:null,...normalCadence });
    expect(pacing.speed).toBe(1);
    expect(pacing.maximumCatchUpSteps).toBe(4);
    for (const debt of [0, 50, 1000, 2000]) expect(pacing.review(10000, debt, 12)).toBe('none');
    expect(pacing.snapshot().speedPercent).toBe(100);
    expect(pacing.review(10000, 2000.1, 12)).toBe('reduced');
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 90, reductions: 1,
      lastReduction: { tick: 12, fromPercent: 100, toPercent: 90, debtMs: 2000.1 } });
    expect(pacing.tickIntervalMs).toBeCloseTo(50 / 0.9);
  });

  it('reduces in ten percentage-point stages, with at least two seconds between reviews', () => {
    const pacing = new SimulationPacing(50);
    for (let stage = 1; stage <= 9; stage++) {
      const now = (stage - 1) * 2000;
      expect(pacing.review(now, 2500, stage)).toBe('reduced');
      expect(pacing.snapshot().speedPercent).toBe(100 - stage * 10);
      expect(pacing.snapshot().reductions).toBe(stage);
      expect(pacing.tickIntervalMs).toBeCloseTo(50 / (1 - stage / 10));
      expect(pacing.maximumCatchUpSteps).toBe(4);
      expect(pacing.review(now + 1999, 9999, stage)).toBe('none');
    }
    expect(pacing.speed).toBe(0.1);
  });

  it('retains the current speed while a large existing backlog is draining', () => {
    const pacing = new SimulationPacing(50);
    expect(pacing.review(0, 4000, 1)).toBe('reduced');
    expect(pacing.review(2000, 3600, 2)).toBe('none');
    expect(pacing.review(4000, 3200, 3)).toBe('none');
    expect(pacing.review(6000, 2800, 4)).toBe('none');
    expect(pacing.review(8000, 2400, 5)).toBe('none');
    expect(pacing.review(10000, 2000, 6)).toBe('none');
    expect(pacing.review(12000, 0, 7)).toBe('none');
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 90, reductions: 1, selfPaced: false });
    // A new overload after recovery is reviewed independently of the old backlog.
    expect(pacing.review(14000, 2050, 8)).toBe('reduced');
    expect(pacing.snapshot().speedPercent).toBe(80);
  });

  it('continues reducing if a backlog stops draining or only improves by one nominal tick', () => {
    const pacing = new SimulationPacing(50);
    expect(pacing.review(0, 4000, 1)).toBe('reduced');
    expect(pacing.review(2000, 3900, 2)).toBe('none');
    expect(pacing.review(4000, 3900, 3)).toBe('reduced');
    expect(pacing.review(6000, 3850, 4)).toBe('reduced');
    expect(pacing.review(8000, 3900, 5)).toBe('reduced');
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 60, reductions: 4 });
  });

  it('does not infer recovery from zero debt without advancing callback evidence', () => {
    const pacing = new SimulationPacing(50);
    pacing.review(0, 2100, 1);
    pacing.review(2000, 2200, 2);
    for (let second = 4; second <= 3600; second += 2) {
      expect(pacing.review(second * 1000, 0, second)).toBe('none');
    }
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 80, reductions: 2, selfPaced: false });
  });

  it('resets the review window after a manual pause while preserving the reduced speed and history', () => {
    const pacing = new SimulationPacing(50);
    pacing.review(10000, 2400, 100);
    const before = pacing.snapshot();
    pacing.resume();
    expect(pacing.snapshot()).toEqual(before);
    expect(pacing.review(10001, 2300, 101)).toBe('reduced');
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 80, reductions: 2,
      lastReduction: { tick: 101, fromPercent: 90, toPercent: 80, debtMs: 2300 } });
  });

  it('keeps all scheduled debt until the emergency floor is reached', () => {
    const pacing = new SimulationPacing(50);
    pacing.review(0, 2100, 1);
    expect(pacing.boundDeadline(10, 5000)).toBe(10);
    expect(pacing.snapshot().deferredWallMs).toBe(0);
    for (let stage = 2; stage <= 9; stage++) pacing.review((stage - 1) * 2000, 2100, stage);
    expect(pacing.snapshot().speedPercent).toBe(10);
    expect(pacing.boundDeadline(20, 5000)).toBe(20);
    expect(pacing.snapshot().deferredWallMs).toBe(0);
  });

  it('continues at the ten-percent floor with one step per callback and explicitly accounts for deferred wall time', () => {
    const pacing = new SimulationPacing(50);
    for (let stage = 1; stage <= 9; stage++) pacing.review((stage - 1) * 2000, 2100, stage);
    expect(pacing.review(17999, 2200, 10)).toBe('none');
    expect(pacing.review(18000, 2200, 10)).toBe('self-paced');
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 10, reductions: 9, selfPaced: true });
    expect(pacing.maximumCatchUpSteps).toBe(1);
    expect(pacing.tickIntervalMs).toBe(500);
    expect(pacing.boundDeadline(1000, 3400)).toBe(3400);
    expect(pacing.boundDeadline(3900, 4100)).toBe(4100);
    expect(pacing.boundDeadline(4600, 4400)).toBe(4600);
    expect(pacing.boundDeadline(4600, 4600)).toBe(4600);
    expect(pacing.snapshot().deferredWallMs).toBe(2600);
    expect(pacing.review(20000, 99999, 11)).toBe('none');
    expect(pacing.review(22000, 0, 12)).toBe('none');
    pacing.resume();
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 10, reductions: 9, selfPaced: true, deferredWallMs: 2600 });
    expect(pacing.maximumCatchUpSteps).toBe(1);
  });

  it('resets the pacing owner for a new or restored match', () => {
    const pacing = new SimulationPacing(50);
    for (let stage = 1; stage <= 10; stage++) pacing.review((stage - 1) * 2000, 2100, stage);
    pacing.boundDeadline(0, 3000);
    pacing.reset();
    expect(pacing.snapshot()).toEqual(new SimulationPacing(50).snapshot());
    expect(pacing.maximumCatchUpSteps).toBe(4);
    expect(pacing.review(18001, 2100, 0)).toBe('reduced');
  });

  it('preserves the strict legacy pause threshold for qualification runs', () => {
    const pacing = new SimulationPacing(50, 'pause');
    expect(pacing.review(0, 2000, 1)).toBe('none');
    expect(pacing.review(0, 2000.01, 1)).toBe('pause');
    expect(pacing.review(1, 3000, 2)).toBe('pause');
    expect(pacing.review(2001, 4000, 3)).toBe('pause');
    expect(pacing.boundDeadline(0, 4000)).toBe(0);
    expect(pacing.snapshot()).toEqual({ policy: 'pause', speedPercent: 100, tickIntervalMs: 50,
      reductions: 0, selfPaced: false, deferredWallMs: 0, lastReduction: null, recoveries:0,lastRecovery:null,...normalCadence });
    pacing.resume(); pacing.reset();
    expect(pacing.review(3000, 2100, 4)).toBe('pause');
  });

  it('detaches diagnostics snapshots so callers cannot change the pacing owner', () => {
    const pacing = new SimulationPacing(50);
    pacing.review(0, 2100, 20);
    const snapshot = pacing.snapshot();
    snapshot.speedPercent = 10;
    snapshot.reductions = 100;
    snapshot.deferredWallMs = 99999;
    snapshot.selfPaced = true;
    snapshot.lastReduction!.toPercent = 1;
    snapshot.lastReduction!.debtMs = 0;
    expect(pacing.snapshot()).toEqual({ policy: 'adaptive', speedPercent: 90, tickIntervalMs: 50 / 0.9,
      reductions: 1, selfPaced: false, deferredWallMs: 0,
      lastReduction: { tick: 20, fromPercent: 100, toPercent: 90, debtMs: 2100 },recoveries:0,lastRecovery:null,...normalCadence });
    expect(pacing.maximumCatchUpSteps).toBe(4);
  });

  it('settles at a sustainable stage for 57 ms simulation plus 18 ms publication every other tick', () => {
    const pacing = new SimulationPacing(50), reductions: number[] = [], tailDebt: number[] = [];
    let now = 0, deadline = 50, ticks = 0, callbacks = 0, largestDebt = 0;
    // This is deterministic clock arithmetic, not a machine speed benchmark.
    // Follow the worker's bounded catch-up loop and preserve every fixed game tick.
    while (ticks < 1800 && callbacks++ < 2000) {
      now = Math.max(now, deadline);
      const callbackNow = now, debt = Math.max(0, callbackNow - deadline);
      largestDebt = Math.max(largestDebt, debt);
      const action = pacing.review(callbackNow, debt, ticks);
      expect(action).not.toBe('pause');
      expect(action).not.toBe('self-paced');
      if (action === 'reduced') reductions.push(pacing.snapshot().speedPercent);
      deadline = pacing.boundDeadline(deadline, callbackNow);
      for (let step = 0; step < pacing.maximumCatchUpSteps && callbackNow >= deadline && ticks < 1800; step++) {
        ticks++;
        now += 57 + (ticks % 2 === 0 ? 18 : 0);
        deadline += pacing.tickIntervalMs;
      }
      deadline = pacing.boundDeadline(deadline, now);
      if (ticks >= 1600) tailDebt.push(Math.max(0, now - deadline));
    }
    expect(ticks).toBe(1800);
    expect(reductions).toEqual([90, 80, 70]);
    expect(largestDebt).toBeGreaterThan(2000);
    expect(largestDebt).toBeLessThan(3000);
    expect(tailDebt.length).toBeGreaterThan(100);
    expect(Math.max(...tailDebt)).toBeLessThan(100);
    expect(pacing.snapshot()).toMatchObject({ speedPercent: 70, reductions: 3, selfPaced: false, deferredWallMs: 0 });
    expect(pacing.review(now + 3600000, 0, ticks)).toBe('none');
    expect(pacing.speed).toBe(0.7);
  });

  it('recovers one stage only after thirty seconds of headroom for the faster rate',()=>{
    const pacing=new SimulationPacing(50);
    for(let stage=1;stage<=9;stage++)pacing.review((stage-1)*2000,2100,stage);
    expect(pacing.review(18000,2100,10)).toBe('self-paced');
    pacing.boundDeadline(0,20000);
    for(let sample=0;sample<60;sample++){
      const now=20000+sample*500;pacing.observeCallback(now,150,1,0);
      expect(pacing.review(now,0,sample+10)).toBe('none');
    }
    pacing.observeCallback(50000,150,1,0);
    expect(pacing.review(50000,0,70)).toBe('recovered');
    expect(pacing.snapshot()).toMatchObject({speedPercent:20,selfPaced:false,deferredWallMs:20000,recoveries:1,lastRecovery:{tick:70,fromPercent:10,toPercent:20}});
    expect(pacing.review(50010,0,70)).toBe('none');
    // 150 ms was safe at 20%, but lacks the margin required for 30% (133 ms).
    for(let sample=1;sample<=150;sample++){pacing.observeCallback(50000+sample*250,150,1,0);expect(pacing.review(50000+sample*250,0,70+sample)).toBe('none');}
    expect(pacing.speed).toBe(.2);
    expect(pacing.review(90000,2500,221)).toBe('reduced');
    expect(pacing.speed).toBe(.1);
  });

  it('counts publication/checkpoint and other callback costs, and restarts evidence after pauses or gaps',()=>{
    const pacing=new SimulationPacing(50);pacing.review(0,2500,1);
    const sample=(at:number)=>{pacing.observeCallback(at,20,1,0);return pacing.review(at,0,Math.floor(at/50));};
    for(let now=100;now<=30000;now+=50)expect(sample(now)).toBe('none');
    pacing.observeCallback(30025,2559,0,0); // checkpoint/control capture, no extra tick
    expect(sample(30100)).toBe('none');
    for(let now=30150;now<=60050;now+=50)expect(sample(now)).toBe('none');
    pacing.resume(); // paused wall time is never recovery evidence
    expect(sample(90000)).toBe('none');
    for(let now=90050;now<=119950;now+=50)expect(sample(now)).toBe('none');
    expect(sample(130000)).toBe('none'); // long scheduling gap
    for(let now=130050;now<=159950;now+=50)expect(sample(now)).toBe('none');
    expect(sample(160000)).toBe('recovered');expect(pacing.speed).toBe(1);
  });

  it('does not use separate small callbacks to hide a busy coordinator or persistent debt',()=>{
    const pacing=new SimulationPacing(50);pacing.review(0,2500,1);
    for(let now=100;now<=60000;now+=60){
      pacing.observeCallback(now-30,25,0,0);pacing.observeCallback(now,25,1,0);
      expect(pacing.review(now,0,now)).toBe('none');
    }
    for(let now=61000;now<=95000;now+=60){pacing.observeCallback(now,10,1,51);expect(pacing.review(now,51,now)).toBe('none');}
    expect(pacing.snapshot()).toMatchObject({speedPercent:90,recoveries:0});
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects invalid nominal tick interval %s', tickMs => {
    expect(() => new SimulationPacing(tickMs)).toThrow('INVALID_TICK_INTERVAL');
  });

  it('rejects an unsupported policy', () => {
    expect(() => new SimulationPacing(50, 'unknown' as OverloadPolicy)).toThrow('INVALID_OVERLOAD_POLICY');
  });
});

describe('adaptive movement cadence governor',()=>{
  it('requires sixty seconds of advancing compute pressure, then reduces one tier per thirty seconds',()=>{
    const pacing=new SimulationPacing(50);pacing.review(0,2100,0);
    const changes:{at:number;tier:number}[]=[];
    for(let at=100;at<=150500;at+=100){
      // Every other callback is cheap: publication/other work is intermittent.
      pacing.observeCallback(at,at%200===100?70:10,1,0);
      const result=pacing.review(at,0,at/100);
      if(result==='tier-changed')changes.push({at,tier:pacing.cadenceTier});
      else expect(result).toBe('none');
    }
    expect(changes).toEqual([{at:60100,tier:1},{at:90300,tier:2},{at:120500,tier:3}]);
    expect(pacing.snapshot()).toMatchObject({speedPercent:90,movementTier:3,movementDecisionIntervalMs:200,publicationIntervalMs:200,tierChanges:3});
  });
  it('does not count idle time, manual pauses, stale evidence, or scheduling debt without expensive work',()=>{
    const pacing=new SimulationPacing(50);pacing.review(0,2100,0);
    expect(pacing.review(600000,0,0)).toBe('none');
    for(let at=0;at<59000;at+=100){pacing.observeCallback(at,70,1,0);pacing.review(at,0,at/100);}
    pacing.resume();
    for(let at=60000;at<119000;at+=100){pacing.observeCallback(at,70,1,0);expect(pacing.review(at,0,at/100)).toBe('none');}
    pacing.observeCallback(130000,70,1,0);expect(pacing.review(130000,0,1300)).toBe('none');
    pacing.resume();
    for(let at=140000;at<220000;at+=100){pacing.observeCallback(at,5,1,60);expect(pacing.review(at,60,at/100)).toBe('none');}
    expect(pacing.cadenceTier).toBe(0);
  });
  it('restores game speed first and then tries a finer tier after sixty healthy seconds',()=>{
    const pacing=new SimulationPacing(50);pacing.reset(2);pacing.review(0,2100,0);
    for(let at=100;at<30100;at+=50){pacing.observeCallback(at,20,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    pacing.observeCallback(30100,20,1,0);expect(pacing.review(30100,0,602)).toBe('recovered');
    expect(pacing.snapshot()).toMatchObject({speedPercent:100,movementTier:2,tierChanges:0});
    for(let at=30150;at<90150;at+=50){pacing.observeCallback(at,20,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    pacing.observeCallback(90150,20,1,0);expect(pacing.review(90150,0,1803)).toBe('tier-changed');
    expect(pacing.snapshot()).toMatchObject({speedPercent:100,movementTier:1,lastTierChange:{reason:'headroom',tick:1803}});
  });
  it('returns an unsuccessful finer-tier trial to the stable tier and prevents rapid retry',()=>{
    const pacing=new SimulationPacing(50);pacing.reset(3);
    for(let at=0;at<=60000;at+=50){pacing.observeCallback(at,20,1,0);pacing.review(at,0,at/50);}
    expect(pacing.cadenceTier).toBe(2);
    for(let at=60050;at<=65050;at+=50){pacing.observeCallback(at,45,1,0);pacing.review(at,0,at/50);}
    expect(pacing.snapshot()).toMatchObject({speedPercent:100,movementTier:3,tierChanges:2,lastTierChange:{reason:'recovery_failed'}});
    for(let at=65100;at<125100;at+=50){pacing.observeCallback(at,20,1,0);expect(pacing.review(at,0,at/50)).toBe('none');}
    pacing.observeCallback(125100,20,1,0);expect(pacing.review(125100,0,2502)).toBe('tier-changed');
    const snapshot=pacing.snapshot();snapshot.lastTierChange!.toTier=0;
    expect(pacing.cadenceTier).toBe(2);expect(pacing.snapshot().lastTierChange!.toTier).toBe(2);
  });
  it('accounts for non-advancing callback cost and keeps strict qualification at normal cadence',()=>{
    const pacing=new SimulationPacing(50);pacing.review(0,2100,0);
    for(let at=100;at<=60100;at+=100){pacing.observeCallback(at-5,50,0,0);pacing.observeCallback(at,10,1,0);pacing.review(at,0,at/100);}
    expect(pacing.cadenceTier).toBe(1);
    const strict=new SimulationPacing(50,'pause');strict.reset(3);
    for(let at=0;at<=90000;at+=100){strict.observeCallback(at,500,1,0);expect(strict.review(at,0,at)).toBe('none');}
    expect(strict.cadenceTier).toBe(0);expect(strict.review(90001,2001,900)).toBe('pause');
  });
  it('cannot recover game speed or finer cadence while admitted work remains old in the queue',()=>{
    const pacing=new SimulationPacing(50);pacing.reset(2);pacing.review(0,2100,0);
    for(let at=0;at<=90000;at+=100){pacing.observeCallback(at,10,1,0,75);expect(pacing.review(at,0,at)).toBe('none');}
    expect(pacing.snapshot()).toMatchObject({speedPercent:90,movementTier:2});
    pacing.reset(2);
    for(let at=0;at<=90000;at+=100){pacing.observeCallback(at,10,1,0,75);expect(pacing.review(at,0,at)).toBe('none');}
    expect(pacing.cadenceTier).toBe(2);
  });
  it('requires useful planning progress before recovering speed and then finer cadence',()=>{
    const pacing=new SimulationPacing(50);pacing.reset(2);pacing.review(0,2100,0);
    for(let at=100;at<=120100;at+=50){pacing.observeCallback(at,20,1,0,0,true);pacing.review(at,0,at);}
    expect(pacing.snapshot()).toMatchObject({speedPercent:90,recoveries:0,movementTier:2,tierChanges:0});
    expect(pacing.needsPlanningRecoveryEvidence).toBe(true);
    for(let at=120150;at<=210200;at+=50){pacing.observeCallback(at,20,1,0,0,false);pacing.review(at,0,at);}
    expect(pacing.snapshot()).toMatchObject({movementTier:1,lastTierChange:{reason:'headroom'}});
  });
  it.each([false,true])('distinguishes sustained multi-second callback work from an idle gap (checkpoint=%s)',checkpoint=>{
    const pacing=new SimulationPacing(50);
    for(let at=0;at<=16000;at+=2000)pacing.review(at,2100,0);
    expect(pacing.speed).toBe(.1);
    let tick=0;
    for(let at=20000;at<=167500;at+=2500){
      if(checkpoint)pacing.observeCallback(at-50,2450,0,0);
      pacing.observeCallback(at,checkpoint?50:2500,1,0);
      expect(pacing.review(at,0,++tick)).toBe(tick===60?'tier-changed':'none');
    }
    expect(pacing.snapshot()).toMatchObject({speedPercent:10,movementTier:1,tierChanges:1});
  });
});

describe('normal-speed 300 ms frame recovery',()=>{
  it('includes autonomous coordinator return costs in recovery instead of earning headroom from the core callback alone',()=>{
    const alone=new SimulationPacing(300),withReturns=new SimulationPacing(300);
    for(const pacing of [alone,withReturns])expect(pacing.review(0,2100,0)).toBe('reduced');
    for(let sample=0;sample<=100;sample++){
      const now=1000+sample*350;
      withReturns.observeCallback(now-200,120,0,0);
      for(const pacing of [alone,withReturns]){pacing.observeCallback(now,200,1,0);pacing.review(now,0,sample*6);}
    }
    expect(alone.snapshot()).toMatchObject({speedPercent:100,recoveries:1});
    expect(withReturns.snapshot()).toMatchObject({speedPercent:90,recoveries:0});
  });
  it('inhibits recovery under memory pressure and rolls back a trial without stopping play',()=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    for(let at=100;at<=60100;at+=300){pacing.observeCallback(at,180,1,0,0,false,true);expect(pacing.review(at,0,at)).not.toBe('recovered');}
    expect(pacing.snapshot()).toMatchObject({speedPercent:90,memoryRecoveryBlocked:true});
    for(let at=60400;at<=90700;at+=300){pacing.observeCallback(at,180,1,0);pacing.review(at,0,at);}
    expect(pacing.speed).toBe(1);
    pacing.observeCallback(91000,180,1,0,0,false,true);
    expect(pacing.review(91000,0,1806)).toBe('reduced');expect(pacing.speed).toBe(.9);
  });
  it('keeps actual coarse frame cadence separate from emergency game speed',()=>{
    const pacing=new SimulationPacing(300);pacing.reset(3);
    expect(pacing.snapshot()).toMatchObject({speedPercent:100,tickIntervalMs:600,movementTier:2,movementDecisionIntervalMs:600,publicationIntervalMs:600});
    expect(pacing.frameIntervalMs).toBe(600);
    expect(pacing.maximumCatchUpSteps).toBe(1);
    pacing.review(0,2100,6);expect(pacing.tickIntervalMs).toBeCloseTo(600/.9);
    expect(pacing.maximumCatchUpSteps).toBe(1);expect(new SimulationPacing(50).maximumCatchUpSteps).toBe(4);
    expect(pacing.snapshot()).toMatchObject({movementDecisionIntervalMs:600,publicationIntervalMs:600});
  });
  it('extends real coarse frames and publication to 450 then 600ms after sustained work pressure',()=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    const transitions:number[]=[];
    for(let at=100;at<=120100;at+=600){pacing.observeCallback(at,600,1,0);if(pacing.review(at,0,at)==='tier-changed')transitions.push(pacing.frameIntervalMs);}
    expect(transitions).toEqual([450,600]);
    expect(pacing.snapshot()).toMatchObject({movementTier:2,movementDecisionIntervalMs:600,publicationIntervalMs:600,speedPercent:90});
    expect(pacing.tickIntervalMs).toBeCloseTo(600/.9);
    const strict=new SimulationPacing(300,'pause');strict.reset(3);expect(strict.snapshot()).toMatchObject({movementTier:0,movementDecisionIntervalMs:300});
  });
  it('retains an affordable600ms frame when the450ms target lacks measured headroom',()=>{
    const pacing=new SimulationPacing(300);pacing.reset(2);
    for(let at=0;at<=180000;at+=600){pacing.observeCallback(at,400,1,0);expect(pacing.review(at,0,at/50)).toBe('none');}
    expect(pacing.frameIntervalMs).toBe(600);expect(pacing.speed).toBe(1);
  });
  it('recovers600 to450 to300 only after sustained evidence and rolls an unsafe trial back',()=>{
    const pacing=new SimulationPacing(300);pacing.reset(2);
    for(let at=0;at<=60000;at+=600){pacing.observeCallback(at,300,1,0);pacing.review(at,0,at/50);}
    expect(pacing.frameIntervalMs).toBe(450);
    // The450ms frame fits; it need not already fit the subsequent300ms tier.
    for(let at=60450;at<=121200;at+=450){pacing.observeCallback(at,300,1,0);expect(pacing.review(at,0,at/50)).toBe('none');}
    for(let at=121650;at<=182400;at+=450){pacing.observeCallback(at,200,1,0);pacing.review(at,0,at/50);}
    expect(pacing.frameIntervalMs).toBe(300);
    for(let at=182700;at<=188100;at+=300){pacing.observeCallback(at,300,1,0);pacing.review(at,0,at/50);}
    expect(pacing.frameIntervalMs).toBe(450);
    expect(pacing.snapshot().lastTierChange?.reason).toBe('recovery_failed');
  });
  it('uses the selected game-time span to recover speed without treating longer deadlines as idle',()=>{
    const pacing=new SimulationPacing(300);pacing.reset(2);pacing.review(0,2100,12);
    for(let at=1000;at<=31000;at+=600){pacing.observeCallback(at,350,1,0);pacing.review(at,0,at/50);}
    expect(pacing.speed).toBe(1);expect(pacing.frameIntervalMs).toBe(600);
    expect(pacing.snapshot()).toMatchObject({recoveries:1,publicationIntervalMs:600,tickIntervalMs:600});
  });
  it('recovers through occasional slow frames using rolling mean and p95 rather than a perfect streak',()=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    for(let at=100;at<30100;at+=300){pacing.observeCallback(at,at===15100?420:190,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    pacing.observeCallback(30100,190,1,0);expect(pacing.review(30100,0,606)).toBe('recovered');expect(pacing.speed).toBe(1);
  });
  it('rolls back an unsafe speed trial before two seconds debt, then waits a full cooldown',()=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    for(let at=100;at<=30100;at+=300){pacing.observeCallback(at,190,1,0);pacing.review(at,0,at);}
    expect(pacing.speed).toBe(1);pacing.observeCallback(30400,500,1,1100);expect(pacing.review(30400,1100,612)).toBe('reduced');expect(pacing.speed).toBe(.9);
    for(let at=30700;at<90400;at+=300){pacing.observeCallback(at,180,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    pacing.observeCallback(90400,180,1,0);expect(pacing.review(90400,0,1806)).toBe('recovered');
  });
  it('has sufficient samples to recover at the 10% floor without requiring 60 slow frames',()=>{
    const pacing=new SimulationPacing(300);for(let stage=0;stage<9;stage++)pacing.review(stage*2000,2100,stage*6);
    expect(pacing.speed).toBe(.1);
    for(let at=20000;at<50000;at+=3000){pacing.observeCallback(at,900,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    pacing.observeCallback(50000,900,1,0);expect(pacing.review(50000,0,66)).toBe('recovered');expect(pacing.speed).toBe(.2);
  });
  it.each([{tier:1,interval:450,cost:1700},{tier:2,interval:600,cost:2200}] as const)('recovers actual$interval ms frames from10% with affordable multi-second work',({tier,interval,cost})=>{
    const pacing=new SimulationPacing(300);pacing.reset(tier);
    for(let stage=0;stage<9;stage++)pacing.review(stage*2000,2100,stage*6);
    expect(pacing.speed).toBe(.1);
    const step=interval*10,first=20000;
    for(let at=first;at<first+30000;at+=step){pacing.observeCallback(at,cost,1,0);expect(pacing.review(at,0,at)).toBe('none');}
    const last=first+Math.ceil(30000/step)*step;
    pacing.observeCallback(last,cost,1,0);expect(pacing.review(last,0,600)).toBe('recovered');
    expect(pacing.speed).toBe(.2);expect(pacing.frameIntervalMs).toBe(interval);
  });
  it('rolls back when a non-advancing capture stalls commands and resets the cost window',()=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    for(let at=100;at<=30100;at+=300){pacing.observeCallback(at,180,1,0);pacing.review(at,0,at);}
    expect(pacing.speed).toBe(1);pacing.observeCallback(32600,2200,0,0,1400);
    expect(pacing.review(32600,0,606)).toBe('reduced');expect(pacing.speed).toBe(.9);
  });
  it.each(['expensive','old_commands','starved_planner'] as const)('does not recover an unhealthy rolling window: %s',condition=>{
    const pacing=new SimulationPacing(300);pacing.review(0,2100,6);
    for(let at=100;at<=60100;at+=300){pacing.observeCallback(at,condition==='expensive'?250:180,1,0,condition==='old_commands'?700:0,condition==='starved_planner');expect(pacing.review(at,0,at)).not.toBe('recovered');}
    expect(pacing.speed).toBe(.9);
  });
});
