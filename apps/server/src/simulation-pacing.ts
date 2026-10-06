import { COARSE_MOVEMENT_DECISION_TICKS } from '@frontier/shared';

export type OverloadPolicy = 'adaptive' | 'pause';
type MovementTier = 0 | 1 | 2 | 3;
type TierReason = 'sustained_overload' | 'headroom' | 'recovery_failed';

/** Bounded game-time frames with separate wall pacing and expensive-work cadence.
 * The worker journals tier changes at a boundary; no game time is discarded. */
export class SimulationPacing {
  private speedPercent = 100;
  private reductions = 0;
  private selfPaced = false;
  private deferredWallMs = 0;
  private reviewedAt = -Infinity;
  private reviewedDebt: number | undefined;
  private lastReduction: { tick: number; fromPercent: number; toPercent: number; debtMs: number } | null = null;
  private recoveries = 0;
  private lastRecovery: { tick: number; fromPercent: number; toPercent: number } | null = null;
  private recoverySamples: { at:number; cost:number; frames:number; debt:number; queued:number; planningBlocked:boolean }[] = [];
  private speedTrial: { previous:number; startedAt:number } | undefined;
  private speedRetryAfter = 0;
  private lastSampleAt: number | undefined;
  private pendingCallbackMs = 0;
  private latestQueuedWorkAgeMs = 0;
  private memoryRecoveryBlocked = false;
  private movementTier: MovementTier = 0;
  private tierChanges = 0;
  private lastTierChange: { tick:number; fromTier:MovementTier; toTier:MovementTier; reason:TierReason } | null = null;
  private slowSince: number | undefined;
  private lastPressureAt: number | undefined;
  private slowTicks = 0;
  private slowWindowMs = 60000;
  private lastAdvancingAt: number | undefined;
  private cadenceCallbackMs = 0;
  private cadenceHealthySince: number | undefined;
  private cadenceHealthyTicks = 0;
  private tierRetryAfter = 0;
  private tierTrial: { previous:MovementTier; startedAt:number; poorSince?:number; poorTicks:number } | undefined;
  readonly debtLimitMs = 2000;
  readonly reviewIntervalMs = 2000;
  readonly recoveryWindowMs = 30000;

  constructor(readonly nominalTickMs: number, readonly policy: OverloadPolicy = 'adaptive') {
    if (!Number.isFinite(nominalTickMs) || nominalTickMs <= 0) throw new Error('INVALID_TICK_INTERVAL');
    if (policy !== 'adaptive' && policy !== 'pause') throw new Error('INVALID_OVERLOAD_POLICY');
  }
  /** The constructor selects the coarse/legacy profile; a coarse tier changes
   * real game-time work per commit, not just the delay between identical steps. */
  get frameIntervalMs(): number { return this.nominalTickMs>=300?COARSE_MOVEMENT_DECISION_TICKS[this.movementTier]*50:this.nominalTickMs; }
  get tickIntervalMs(): number { return this.frameIntervalMs * 100 / this.speedPercent; }
  get speed(): number { return this.speedPercent / 100; }
  get maximumCatchUpSteps(): number { return this.selfPaced||this.nominalTickMs>=300 ? 1 : 4; }
  get cadenceTier(): MovementTier { return this.movementTier; }
  private get maximumMovementTier():MovementTier { return this.nominalTickMs>=300?2:3; }
  private get minimumCadenceFrames():number { return Math.max(8,Math.ceil(3000/this.frameIntervalMs)); }
  get needsPlanningRecoveryEvidence():boolean { return this.policy==='adaptive'&&(this.speedPercent<100||this.speedTrial!==undefined||this.movementTier>0||this.tierTrial!==undefined); }
  get publicationIntervalMs(): 100|150|200|300|450|600 { return this.nominalTickMs>=300?this.frameIntervalMs as 300|450|600:this.movementTier < 2 ? 100 : this.movementTier === 2 ? 150 : 200; }
  reset(tier:MovementTier = 0): void {
    if (!Number.isInteger(tier) || tier < 0 || tier > 3) throw new Error('INVALID_MOVEMENT_CADENCE');
    this.speedPercent = 100; this.reductions = 0; this.selfPaced = false;
    this.movementTier = this.policy === 'pause' ? 0 : Math.min(tier,this.maximumMovementTier) as MovementTier; this.tierChanges = 0; this.lastTierChange = null; this.tierRetryAfter = 0;
    this.deferredWallMs = 0; this.lastReduction = null; this.recoveries = 0; this.lastRecovery = null; this.speedRetryAfter=0; this.resume();
  }
  /** Manual pauses do not accumulate work and do not restore an unsafe speed. */
  resume(): void { this.reviewedAt = -Infinity; this.reviewedDebt = undefined; this.clearHeadroom(); this.lastSampleAt = undefined; this.clearCadenceEvidence(); this.slowWindowMs = 60000; this.tierTrial = undefined; this.speedTrial=undefined;this.latestQueuedWorkAgeMs=0;this.memoryRecoveryBlocked=false; }
  private clearHeadroom(): void { this.recoverySamples=[]; this.pendingCallbackMs = 0; }
  private recoveryHealthy(nowMs:number):boolean {
    const samples=this.recoverySamples,first=samples[0],last=samples.at(-1);
    if(this.memoryRecoveryBlocked||!first||!last||nowMs-first.at<this.recoveryWindowMs||nowMs-last.at>Math.max(1000,this.tickIntervalMs*2))return false;
    const nextInterval=this.frameIntervalMs*100/Math.min(100,this.speedPercent+10),frames=samples.reduce((sum,sample)=>sum+sample.frames,0);
    // At600ms and10% speed only six advancing samples fit a30s window.
    // Keep a full elapsed window without demanding an impossible sample count.
    const minimumSamples=Math.max(4,Math.min(8,Math.floor(this.recoveryWindowMs/this.tickIntervalMs)+1));
    if(frames<Math.max(minimumSamples,Math.ceil(this.recoveryWindowMs/this.tickIntervalMs/2)))return false;
    const p95=(values:number[])=>values.sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1]!;
    const commandLimit=this.nominalTickMs>=300?650:this.nominalTickMs;
    return samples.reduce((sum,sample)=>sum+sample.cost,0)/frames<=nextInterval*.8 &&
      p95(samples.map(sample=>sample.cost/sample.frames))<=nextInterval &&
      p95(samples.map(sample=>sample.debt))<=this.frameIntervalMs &&
      samples.every(sample=>sample.debt<this.debtLimitMs/2) && last.debt<=this.frameIntervalMs &&
      p95(samples.map(sample=>sample.queued))<=commandLimit && last.queued<=commandLimit &&
      !samples.some(sample=>sample.planningBlocked);
  }
  private clearCadenceEvidence():void { this.slowSince=undefined;this.lastPressureAt=undefined;this.slowTicks=0;this.lastAdvancingAt=undefined;this.cadenceCallbackMs=0;this.cadenceHealthySince=undefined;this.cadenceHealthyTicks=0; }
  private observeCadence(nowMs:number,durationMs:number,advancedTicks:number,debtMs:number,planningBacklog:boolean):void {
    this.cadenceCallbackMs += durationMs;
    if (!advancedTicks) {
      if (durationMs > this.frameIntervalMs * .8 || debtMs > this.frameIntervalMs) { this.cadenceHealthySince=undefined;this.cadenceHealthyTicks=0; }
      return;
    }
    const cost=this.cadenceCallbackMs;this.cadenceCallbackMs=0;
    // Expensive callbacks account for elapsed time, including checkpoint/RPC
    // work since the last advance. Only an unexplained gap is idle evidence.
    if(this.lastAdvancingAt!==undefined&&(nowMs<this.lastAdvancingAt||nowMs-this.lastAdvancingAt-cost>Math.max(1000,this.tickIntervalMs*4))){this.clearCadenceEvidence();this.slowWindowMs=60000;this.tierTrial=undefined;}
    this.lastAdvancingAt=nowMs;
    const nextSpeedBudget=this.frameIntervalMs*100/Math.min(100,this.speedPercent+10)*.8*advancedTicks;
    const hasHeadroom=cost<=nextSpeedBudget&&debtMs<=this.frameIntervalMs;
    // A late timer or stale debt alone does not prove expensive simulation work.
    if(this.speedPercent<100&&!hasHeadroom&&cost>this.frameIntervalMs*.8*advancedTicks){this.slowSince??=nowMs;this.lastPressureAt=nowMs;}
    else if(this.speedPercent===100||this.lastPressureAt===undefined||nowMs-this.lastPressureAt>Math.max(1000,this.tickIntervalMs*4)){this.slowSince=undefined;this.lastPressureAt=undefined;this.slowTicks=0;}
    if(this.slowSince!==undefined)this.slowTicks+=advancedTicks;
    // A larger frame being affordable does not prove a smaller one affordable.
    // Require conservative measured headroom against the next finer interval.
    const finerFrame=this.nominalTickMs>=300?COARSE_MOVEMENT_DECISION_TICKS[Math.max(0,this.movementTier-1)]!*50:this.nominalTickMs;
    const nominalHealthy=this.speedPercent===100&&hasHeadroom&&!planningBacklog;
    if(nominalHealthy&&cost<=finerFrame*.8*advancedTicks){this.cadenceHealthySince??=nowMs;this.cadenceHealthyTicks+=advancedTicks;}
    else {this.cadenceHealthySince=undefined;this.cadenceHealthyTicks=0;}
    if(this.tierTrial){
      if(nominalHealthy){delete this.tierTrial.poorSince;this.tierTrial.poorTicks=0;}
      else {this.tierTrial.poorSince??=nowMs;this.tierTrial.poorTicks+=advancedTicks;}
      if(nominalHealthy&&nowMs-this.tierTrial.startedAt>=30000)this.tierTrial=undefined;
    }
  }
  private changeTier(tier:MovementTier,reason:TierReason,nowMs:number,tick:number):'tier-changed' {
    const previous=this.movementTier;this.movementTier=tier;this.tierChanges++;
    this.lastTierChange={tick,fromTier:previous,toTier:tier,reason};
    this.clearCadenceEvidence();this.clearHeadroom();
    this.slowWindowMs=reason==='sustained_overload'?30000:60000;
    this.tierTrial=reason==='headroom'?{previous,startedAt:nowMs,poorTicks:0}:undefined;
    if(reason==='recovery_failed')this.tierRetryAfter=nowMs+60000;
    return 'tier-changed';
  }
  /** Include all coordinator callbacks, publication, checkpoints and awaited
   * compute in recovery evidence. Idle timer polls alone cannot earn recovery. */
  observeCallback(nowMs: number, durationMs: number, advancedTicks: number, debtMs: number, queuedWorkAgeMs = 0, planningBacklog = false, memoryPressure = false): void {
    if (this.policy !== 'adaptive') return;
    if (![nowMs,durationMs,advancedTicks,debtMs,queuedWorkAgeMs].every(Number.isFinite) || durationMs < 0 || debtMs < 0 || queuedWorkAgeMs < 0 || !Number.isSafeInteger(advancedTicks) || advancedTicks < 0) { this.clearHeadroom();this.clearCadenceEvidence();return; }
    this.latestQueuedWorkAgeMs=queuedWorkAgeMs;
    this.memoryRecoveryBlocked=memoryPressure;
    if(memoryPressure)this.clearHeadroom();
    this.observeCadence(nowMs,durationMs,advancedTicks,Math.max(debtMs,queuedWorkAgeMs),planningBacklog||memoryPressure);
    if (this.speedPercent === 100&&!this.speedTrial) return;
    this.pendingCallbackMs += durationMs;
    const nextSpeedInterval=this.frameIntervalMs*100/Math.min(100,this.speedPercent+10);
    if (debtMs >= this.debtLimitMs/2 || this.pendingCallbackMs >= Math.max(this.debtLimitMs,nextSpeedInterval)) {
      this.clearHeadroom(); this.lastSampleAt = nowMs; return;
    }
    if (!advancedTicks) return;
    if (this.lastSampleAt !== undefined && (nowMs < this.lastSampleAt || nowMs - this.lastSampleAt > Math.max(1000,this.tickIntervalMs * 4))) {this.clearHeadroom();if(this.speedTrial)this.speedTrial.startedAt=nowMs;}
    this.lastSampleAt = nowMs;
    this.recoverySamples.push({at:nowMs,cost:this.pendingCallbackMs,frames:advancedTicks,debt:debtMs,queued:queuedWorkAgeMs,planningBlocked:planningBacklog});
    // Retain one crossing sample to prove a complete rolling window. Samples
    // are bounded even when callers run an optional fast profile.
    while(this.recoverySamples.length>1&&this.recoverySamples[1]!.at<=nowMs-this.recoveryWindowMs)this.recoverySamples.shift();
    if(this.recoverySamples.length>4096)this.recoverySamples.splice(0,this.recoverySamples.length-4096);
    this.pendingCallbackMs = 0;
  }
  review(nowMs: number, debtMs: number, tick: number): 'none' | 'pause' | 'reduced' | 'self-paced' | 'recovered' | 'tier-changed' {
    const recent=this.lastAdvancingAt!==undefined&&nowMs>=this.lastAdvancingAt&&nowMs-this.lastAdvancingAt<=Math.max(1000,this.tickIntervalMs*2);
    if(this.policy==='adaptive'&&this.speedTrial){
      const commandLimit=this.nominalTickMs>=300?650:this.nominalTickMs;
      if(debtMs>=this.debtLimitMs/2||this.latestQueuedWorkAgeMs>commandLimit*2||this.memoryRecoveryBlocked){
        const fromPercent=this.speedPercent;this.speedPercent=this.speedTrial.previous;this.speedTrial=undefined;this.speedRetryAfter=nowMs+60000;this.reductions++;
        this.lastReduction={tick,fromPercent,toPercent:this.speedPercent,debtMs};this.reviewedAt=nowMs;this.reviewedDebt=debtMs;this.clearHeadroom();return 'reduced';
      }
      if(recent&&nowMs-this.speedTrial.startedAt>=10000)this.speedTrial=undefined;
    }
    if(this.policy==='adaptive'&&recent&&this.tierTrial&&(debtMs>this.debtLimitMs||this.tierTrial.poorSince!==undefined&&nowMs-this.tierTrial.poorSince>=5000&&this.tierTrial.poorTicks>=Math.max(2,Math.ceil(500/this.frameIntervalMs))))return this.changeTier(this.tierTrial.previous,'recovery_failed',nowMs,tick);
    // One adjustment per review boundary; restore game speed before finer work.
    if(this.policy==='adaptive'&&recent&&this.lastPressureAt!==undefined&&nowMs-this.lastPressureAt<=Math.max(1000,this.tickIntervalMs*2)&&this.slowSince!==undefined&&nowMs-this.slowSince>=this.slowWindowMs&&this.slowTicks>=this.minimumCadenceFrames&&this.movementTier<this.maximumMovementTier)return this.changeTier((this.movementTier+1) as MovementTier,'sustained_overload',nowMs,tick);
    if(this.policy==='adaptive'&&recent&&this.speedPercent===100&&this.movementTier>0&&!this.tierTrial&&nowMs>=this.tierRetryAfter&&debtMs<=this.frameIntervalMs&&this.cadenceHealthySince!==undefined&&nowMs-this.cadenceHealthySince>=60000&&this.cadenceHealthyTicks>=this.minimumCadenceFrames)return this.changeTier((this.movementTier-1) as MovementTier,'headroom',nowMs,tick);
    if (debtMs <= this.debtLimitMs) {
      if (debtMs <= this.frameIntervalMs) this.reviewedDebt = undefined;
      if (this.policy === 'adaptive' && this.speedPercent < 100 && !this.speedTrial && nowMs>=this.speedRetryAfter && debtMs <= this.frameIntervalMs && this.recoveryHealthy(nowMs)) {
        const fromPercent = this.speedPercent; this.speedPercent += 10; this.recoveries++;
        this.selfPaced = false; this.reviewedAt = -Infinity; this.reviewedDebt = undefined;
        this.lastRecovery = { tick, fromPercent, toPercent:this.speedPercent }; this.clearHeadroom();this.speedTrial={previous:fromPercent,startedAt:nowMs};
        return 'recovered';
      }
      return 'none';
    }
    this.clearHeadroom();
    if (this.policy === 'pause') return 'pause';
    if (this.selfPaced || nowMs - this.reviewedAt < this.reviewIntervalMs) return 'none';
    const previousDebt = this.reviewedDebt;
    this.reviewedDebt = debtMs; this.reviewedAt = nowMs;
    // An existing backlog can remain large while the new rate is catching up.
    // Give a draining schedule time to recover rather than cutting every review.
    if (previousDebt !== undefined && debtMs < previousDebt - this.frameIntervalMs) return 'none';
    if (this.speedPercent > 10) {
      const fromPercent = this.speedPercent; this.speedPercent -= 10; this.reductions++;
      this.lastReduction = { tick, fromPercent, toPercent: this.speedPercent, debtMs };
      return 'reduced';
    }
    // At the 10% floor, continue one committed tick at a time. Record wall time
    // deferred by this emergency scheduling policy instead of accumulating an
    // infinite catch-up loop or reporting discarded debt as recovered capacity.
    this.selfPaced = true;
    return 'self-paced';
  }
  boundDeadline(deadlineMs: number, nowMs: number): number {
    if (!this.selfPaced || nowMs <= deadlineMs) return deadlineMs;
    this.deferredWallMs += nowMs - deadlineMs;
    return nowMs;
  }
  snapshot() {
    return { policy: this.policy, speedPercent: this.speedPercent, tickIntervalMs: this.tickIntervalMs,
      reductions: this.reductions, selfPaced: this.selfPaced, deferredWallMs: this.deferredWallMs,
      lastReduction: this.lastReduction ? { ...this.lastReduction } : null,
      recoveries:this.recoveries,lastRecovery:this.lastRecovery ? {...this.lastRecovery} : null,memoryRecoveryBlocked:this.memoryRecoveryBlocked,
      movementTier:this.movementTier,movementDecisionIntervalMs:this.nominalTickMs>=300?COARSE_MOVEMENT_DECISION_TICKS[this.movementTier]*50:Math.max(this.nominalTickMs,(this.movementTier+1)*50),
      publicationIntervalMs:this.publicationIntervalMs,tierChanges:this.tierChanges,
      lastTierChange:this.lastTierChange?{...this.lastTierChange}:null };
  }
}
