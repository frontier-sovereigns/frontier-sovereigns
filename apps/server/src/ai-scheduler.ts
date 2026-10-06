import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { balance, type Difficulty, type EndpointDiagnosticsResponse } from '@frontier/shared';
import { buildAiPrompt, type AiDispatch, type AiRequestBinding } from '../../../packages/simulation/src/ai-observation.js';
import type { AiPlanRejectionCode } from '../../../packages/simulation/src/ai-controller.js';
import { EndpointClient, EndpointError, type EndpointConfigSource, type CompletionResult, type CompletionTelemetry, type EndpointMessages, type OutputMode } from './ai-endpoint.js';

/** Private worker acknowledgement metadata; never part of the browser protocol. */
export interface AiRenewalState {matchId:string;matchEpoch:number;playerId:string;controllerGeneration:number;tick:number;status:string;alive:boolean;mode:'model'|'fallback';reason:string;plan:null|{generation:number;acceptedTick:number;expiresTick:number};statistics:{modelReadyTicks:number;fallbackTicks:number;inferenceFailures:number}}
export interface SchedulingState {
  matchId: string; matchEpoch: number; tick: number; status: string;
  commanders: { playerId: string; modelId?: string; difficulty: Difficulty; generation: number; alive: boolean; nextStrategicTick: number; mode: 'model' | 'fallback'; renewal?:AiRenewalState }[];
}
export interface AiCompletion { accepted: boolean; code: string; diagnosticCode?:AiPlanRejectionCode; renewal?:AiRenewalState; message?: { recipientId: string; text: string; requestId?: string; status: 'planned' | 'declined' | 'completed' | 'blocked' | 'expired' } }
export interface AiDriver {
  aiSchedulingState(): Promise<SchedulingState>;
  prepareAiRequest(playerId: string, requestId: string, chatRequestIds: string[]): Promise<AiDispatch>;
  completeAiRequest(binding: AiRequestBinding, result: { kind: 'plan'; plan: unknown } | { kind: 'failure'; code: string }): Promise<AiCompletion>;
  invalidateAiRequests(reason: string, playerIds?: string[]): Promise<unknown>;
}
export interface AiAdmissionLease { release(cancelled: boolean): void; setDeadline?(deadline:number):void }
export interface AiAdmission {
  acquire(request: { playerId?: string; queuedAt: number; deadline: number }): AiAdmissionLease | undefined;
  cancelPending(playerId?: string): void;
}
type Commander = { playerId: string; generation: number; difficulty: Difficulty; mode: 'model' | 'fallback'; nextDueAt: number; nominalDueAt:number; renewalNotBefore:number; intervalSeconds: number; lastStatus: string; lastLatencyMs: number | null; lastAcceptedAt: number | null; pending?: { queuedAt: number; requestId?: string; traceId?:number }; failures: number;
  renewalWatermark?:{tick:number;planGeneration:number;acceptedTick:number;expiresTick:number};
  renewalSchedule?:{planGeneration:number;tick:number;expiresTick:number;estimatedExpiresAtMs:number;leadMs:number;estimatedDeadlineFeasible:boolean} };
type Active = { controller: AbortController; deadline: number; queuedAt:number; version: number; driver: AiDriver; binding?: AiRequestBinding; invalidated: boolean; traceId?:number; traceScope?:string; admission?: AiAdmissionLease };
export const percentiles = (values: readonly number[]) => { const sorted = [...values].sort((a, b) => a - b); return { p50: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0, p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, p99: sorted[Math.max(0, Math.ceil(sorted.length * .99) - 1)] ?? 0, max: sorted.at(-1) ?? 0 }; };
const boundedSample = (list: number[], value: number) => { list.push(Math.round(value * 100) / 100); if (list.length > 256) list.shift(); };
export const AI_REQUEST_STAGES=['preparation','endpoint','application'] as const;
type RequestStage=typeof AI_REQUEST_STAGES[number];
type StageSamples=Record<RequestStage,{durations:number[];failures:number;timeouts:number}>;
type CommanderSamples={completed:number;failed:number;queues:number[];stages:StageSamples};
const stageSamples=():StageSamples=>({preparation:{durations:[],failures:0,timeouts:0},endpoint:{durations:[],failures:0,timeouts:0},application:{durations:[],failures:0,timeouts:0}});
const stageDiagnostics=(samples:StageSamples)=>Object.fromEntries(AI_REQUEST_STAGES.map(stage=>[stage,{samples:samples[stage].durations.length,durationMs:percentiles(samples[stage].durations),failures:samples[stage].failures,timeouts:samples[stage].timeouts}])) as NonNullable<EndpointDiagnosticsResponse['scheduler']['stages']>;
// Match the native bridge's bounded RPC lifetime. These waits are separate from
// the operator-configured HTTP budget, and never extend a request's authority.
const workerWaitMs=15000;
function boundedWait<T>(operation:Promise<T>,timeoutMs:number,code:string,signal:AbortSignal,onTimeout?:()=>void):Promise<T>{
  return new Promise((resolve,reject)=>{let settled=false;const finish=(accept:boolean,value:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);accept?resolve(value as T):reject(value);};
    const cancel=()=>finish(false,new EndpointError('CANCELLED')),timer=setTimeout(()=>{onTimeout?.();finish(false,new EndpointError(code));},timeoutMs);timer.unref?.();
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();operation.then(value=>finish(true,value),error=>finish(false,error));
  });
}
const localFailureCodes = new Set(['AI_PREPARATION_TIMEOUT','AI_APPLICATION_TIMEOUT','CHAT_INPUT_BUDGET', 'AI_INPUT_BUDGET_TOO_SMALL', 'INPUT_BODY_LIMIT', 'INPUT_TOKEN_LIMIT', 'INVALID_AI_INPUT_BUDGET', 'INVALID_TOKENIZER_RESULT', 'INVALID_AI_REQUEST', 'AI_GOAL_CAPACITY', 'STALE_AI_RESPONSE', 'AI_OBSERVATION_EXPIRED', 'AI_UNAVAILABLE', 'AI_REQUEST_IN_FLIGHT', 'AI_NOT_AT_BOUNDARY', 'WORKER_UNAVAILABLE', 'WORKER_TIMEOUT', 'SERVER_BUSY']);
// Only fixed endpoint/controller codes may cross into host diagnostics or replay.
// An uppercase-looking upstream exception is still untrusted text.
const invalidPlanCodes = new Set<AiPlanRejectionCode>(['AI_PLAN_SCHEMA_INVALID','AI_PLAN_OBSERVATION_MISMATCH']);
const failureCodes = new Set([...localFailureCodes, ...invalidPlanCodes, 'NOT_CONFIGURED', 'INVALID_PROVIDER_SCHEMA', 'REDIRECT_REJECTED', 'RESPONSE_TOO_LARGE', 'INVALID_ENDPOINT_RESPONSE', 'INVALID_JSON', 'TIMEOUT', 'CANCELLED', 'CONNECTION_FAILED', 'UNAUTHORIZED', 'MODEL_OR_ROUTE_UNAVAILABLE', 'RATE_LIMITED', 'REQUEST_UNSUPPORTED', 'ENDPOINT_FAILURE', 'OUTPUT_TRUNCATED', 'UNSUPPORTED_MODEL_OUTPUT', 'INVALID_STRUCTURED_OUTPUT', 'MODEL_SECRET_REFLECTION', 'INVALID_AI_PLAN', 'INVALID_AI_VIEW', 'AI_BINDING_MISMATCH', 'AI_REFERENCE_LIMIT', 'INVALID_AI_OUTPUT_BUDGET', 'INFERENCE_FAILED']);
const retryableContentFailures = new Set(['INVALID_AI_PLAN', ...invalidPlanCodes, 'INVALID_JSON', 'OUTPUT_TRUNCATED']);
const renewalCooldownMs = 10000, renewalPollMarginMs = 1000;
const failureCode = (error: unknown): string => { const code = error instanceof EndpointError ? error.code : error instanceof Error ? error.message : ''; return failureCodes.has(code) ? code : 'INFERENCE_FAILED'; };
function reflectsCredential(value: unknown, credential: string): boolean {
  if (!credential) return false;
  const pending: unknown[] = [value];
  while (pending.length) { const item = pending.pop(); if (typeof item === 'string' && item.includes(credential)) return true;
    if (Array.isArray(item)) { for (const field of item) pending.push(field); } else if (item && typeof item === 'object') for (const [key, field] of Object.entries(item)) { if (key.includes(credential)) return true; pending.push(field); }
  } return false;
}

/** HTTP and wall-clock health are deliberately outside the deterministic simulation worker. */
export class AiScheduler {
  private driver?: AiDriver; private driverGeneration = 0; private key = ''; private state?: SchedulingState; private polling = false; private stopped = false;
  private commanders = new Map<string, Commander>(); private active = new Map<string, Active>(); private cancelledLeases: number[] = [];
  private latencies: number[] = []; private queues: number[] = []; private consecutiveFailures = 0; private completed = 0; private failed = 0;
  private renewalLatencies:number[]=[];private renewalVersion=-1;
  private recentFailures:{playerId:string;code:string;at:number;stage?:RequestStage}[]=[];private failureHistoryVersion=-1;
  private stages=stageSamples();
  // At most eleven independent histories; retain across pauses/epochs, reset on
  // new match/driver or model settings. No observations, responses or secrets.
  private commanderSamples=new Map<string,CommanderSamples>();
  private requestSamples(playerId:string):CommanderSamples {
    let samples=this.commanderSamples.get(playerId);
    if(!samples){if(this.commanderSamples.size>=11)this.commanderSamples.delete(this.commanderSamples.keys().next().value!);samples={completed:0,failed:0,queues:[],stages:stageSamples()};this.commanderSamples.set(playerId,samples);}
    return samples;
  }
  private requestDiagnostics(playerId:string){const samples=this.commanderSamples.get(playerId)??{completed:0,failed:0,queues:[],stages:stageSamples()};return {completed:samples.completed,failed:samples.failed,queueSamples:samples.queues.length,queueDelayMs:percentiles(samples.queues),stages:stageDiagnostics(samples.stages)};}
  private progress?:{tick:number;at:number;rate:number};
  private circuitUntil = 0; private rateUntil = 0; private halfOpen = false; private probeReservation = false; private tokenizerUnsupportedVersion = -1;
  private usage: { promptTokens: number | null; completionTokens: number | null; prefillMs: number | null; generationMs: number | null } = { promptTokens: null, completionTokens: null, prefillMs: null, generationMs: null };
  private usageTotals = { reportedRequests: 0, missingUsageRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private renewal?:{now:()=>number;originMs:number;serial:number;lastSampleMs:number;events:Record<string,unknown>[];states:Record<string,unknown>[];omittedEvents:number;omittedStates:number};
  /** Opt-in chronology only. Production renewal estimates do not require tracing. */
  enableRenewalDiagnostics(now:()=>number=()=>performance.now()){if(!this.renewal)this.renewal={now,originMs:now(),serial:0,lastSampleMs:-Infinity,events:[],states:[],omittedEvents:0,omittedStates:0};}
  private renewalEvent(kind:string,fields:Record<string,unknown>){const trace=this.renewal;if(!trace)return;const event={kind,atMs:trace.now()-trace.originMs,wallAtMs:this.now(),scope:this.key,...fields};if(trace.events.length<4096)trace.events.push(event);else trace.omittedEvents++;}
  private renewalState(state:SchedulingState){const trace=this.renewal;if(!trace)return;const atMs=trace.now()-trace.originMs;if(atMs-trace.lastSampleMs<1000)return;trace.lastSampleMs=atMs;const sample={atMs,wallAtMs:this.now(),scope:this.key,tick:state.tick,status:state.status,commanders:state.commanders.map(item=>({playerId:item.playerId,generation:item.generation,alive:item.alive,mode:item.mode,renewal:item.renewal??null}))};if(trace.states.length<8192)trace.states.push(sample);else trace.omittedStates++;}
  renewalDiagnostics(){const trace=this.renewal;if(!trace)return;return {schemaVersion:2,scope:'Private scheduler lifecycle. Application timestamps are gateway receipt of worker acknowledgements; exact worker ticks are separate. Endpoint attempts include HTTP transport/response parsing, not isolated model compute. Sampled state is not a continuous validity trace.',clock:'Gateway monotonic elapsed milliseconds plus scheduler wall-clock samples. Scheduled due timestamps use the existing wall clock.',capturedAtMs:trace.now()-trace.originMs,capturedWallAtMs:this.now(),simulationHz:balance.rules.simulationHz,observationAgeSeconds:balance.ai.maxObservationAgeSeconds,goalTtlSeconds:balance.ai.goalTtlSeconds,policy:this.renewalPolicyDiagnostics(),eventLimit:4096,stateLimit:8192,omittedEvents:trace.omittedEvents,omittedStates:trace.omittedStates,pending:[...this.commanders.values()].filter(item=>item.pending).map(item=>({traceId:item.pending!.traceId,scope:this.key,playerId:item.playerId})),active:[...this.active.entries()].map(([playerId,item])=>({traceId:item.traceId,scope:item.traceScope,playerId,invalidated:item.invalidated})),events:structuredClone(trace.events),states:structuredClone(trace.states)};}
  /** Host-private scheduling evidence; estimates never extend simulation authority. */
  renewalPolicyDiagnostics(){return {policy:'Successful periodic renewals follow game progress and plan-expiry lead; ten-second wall cooldown, one latency-aware content-failure retry, otherwise wall-clock adaptive backoff, FIFO dispatch. Urgent requests remain immediate.',estimateScope:'Successful queued-to-worker-acceptance acknowledgements include queue, preparation, endpoint and application. Remaining simulation ticks project using bounded observed game progress; expiry authority remains simulation-owned.',gameProgressRate:this.progress?.rate??1,samples:this.renewalLatencies.length,jointLatencyMs:percentiles(this.renewalLatencies),warmupSamples:3,commanders:[...this.commanders.values()].map(item=>({playerId:item.playerId,nominalDueAtMs:item.nominalDueAt,nextDueAtMs:item.nextDueAt,notBeforeAtMs:item.renewalNotBefore,...(item.renewalSchedule?{...item.renewalSchedule}:{})}))};}
  private observeProgress(tick:number):void {
    const now=this.now(),prior=this.progress;if(!prior||tick<prior.tick){this.progress={tick,at:now,rate:1};return;}
    if(now-prior.at<1000)return;
    const measured=Math.max(.01,Math.min(1,(tick-prior.tick)*1000/balance.rules.simulationHz/(now-prior.at)));
    this.progress={tick,at:now,rate:measured};
  }
  private renewalEstimate():{leadMs:number;estimateMs:number} {
    const settings=this.config.snapshot().settings,limit=settings.maxAdaptiveIntervalSeconds*1000;
    const measured=percentiles(this.renewalLatencies).p95,count=this.state?.commanders.filter(item=>item.alive).length??this.commanders.size;
    const warmup=settings.timeoutSeconds*1000*Math.max(1,Math.ceil(count/settings.maxConcurrent));
    // Until three successful complete lifecycles exist, retain a bounded timeout/
    // fair-round estimate. A one-second floor covers the ordinary polling cadence.
    const estimateMs=Math.max(1000,this.renewalLatencies.length<3?Math.max(warmup,measured):measured);
    return {leadMs:Math.min(limit,estimateMs+renewalPollMarginMs),estimateMs};
  }
  private scheduleRenewal(commander:Commander,value:AiRenewalState|undefined,expected:{matchId:string;matchEpoch:number;tick?:number}):void {
    const clear=()=>{commander.nextDueAt=commander.nominalDueAt;delete commander.renewalSchedule;};
    const integer=(input:unknown):input is number=>typeof input==='number'&&Number.isSafeInteger(input)&&input>=0;
    if(!value||value.matchId!==expected.matchId||value.matchEpoch!==expected.matchEpoch||value.playerId!==commander.playerId||value.controllerGeneration!==commander.generation||value.status!=='RUNNING'||value.alive!==true||!integer(value.tick)||expected.tick!==undefined&&value.tick!==expected.tick){clear();return;}
    const previous=commander.renewalWatermark,plan=value.plan;
    if(previous&&value.tick<previous.tick)return;
    if(!plan){
      if(previous&&value.tick===previous.tick)return;
      if(previous)previous.tick=value.tick;
      clear();
      // Expiry can remove the plan before the next poll. Losing its record must
      // not restore a later nominal interval; real completion/failure cooldowns
      // remain binding, including after a pause or a restored expired plan.
      if(commander.lastAcceptedAt!==null||value.reason==='PLAN_EXPIRED')commander.nextDueAt=Math.max(commander.renewalNotBefore,Math.min(commander.nominalDueAt,this.now()));
      return;
    }
    if(!integer(plan.generation)||plan.generation===0||!integer(plan.acceptedTick)||!integer(plan.expiresTick)||plan.acceptedTick>value.tick||plan.expiresTick<plan.acceptedTick){clear();return;}
    // A scheduling-state read and an application ACK can complete in either order.
    // An older snapshot must not replace a newer plan's local renewal deadline.
    if(previous&&(plan.generation<previous.planGeneration||plan.generation===previous.planGeneration&&(plan.acceptedTick!==previous.acceptedTick||plan.expiresTick!==previous.expiresTick)))return;
    const now=this.now(),{leadMs,estimateMs}=this.renewalEstimate(),rate=this.progress?.rate??1,remainingMs=Math.max(0,plan.expiresTick-value.tick)*1000/balance.rules.simulationHz/rate;
    const estimatedExpiresAtMs=now+remainingMs;if(!Number.isFinite(estimatedExpiresAtMs)){clear();return;}
    // Failed renewals keep real-time recovery/backoff. A healthy successful plan
    // should not be replaced repeatedly while its units barely advance in game time.
    let progressNotBefore=now;
    if(commander.lastAcceptedAt!==null&&commander.failures===0){
      const intervalTicks=commander.intervalSeconds*balance.rules.simulationHz;
      commander.nominalDueAt=now+Math.max(0,plan.acceptedTick+intervalTicks-value.tick)*1000/balance.rules.simulationHz/rate;
      const minimumProgress=Math.min(intervalTicks,Math.max(1,Math.floor((plan.expiresTick-plan.acceptedTick)/5)));
      progressNotBefore=now+Math.max(0,Math.min(plan.expiresTick,plan.acceptedTick+minimumProgress)-value.tick)*1000/balance.rules.simulationHz/rate;
    }
    commander.renewalWatermark={tick:value.tick,planGeneration:plan.generation,acceptedTick:plan.acceptedTick,expiresTick:plan.expiresTick};
    commander.nextDueAt=Math.max(commander.renewalNotBefore,progressNotBefore,Math.min(commander.nominalDueAt,estimatedExpiresAtMs-leadMs));
    commander.renewalSchedule={planGeneration:plan.generation,tick:value.tick,expiresTick:plan.expiresTick,estimatedExpiresAtMs,leadMs,estimatedDeadlineFeasible:Math.max(now,commander.nextDueAt)+estimateMs<=estimatedExpiresAtMs};
  }
  onMessage: (playerId: string, message: NonNullable<AiCompletion['message']>) => void = () => {};
  constructor(private readonly config: EndpointConfigSource, private readonly now: () => number = Date.now, private readonly clientFactory = (snapshot: ReturnType<EndpointConfigSource['snapshot']>) => new EndpointClient(snapshot.settings, snapshot.apiKey), private readonly admission?: AiAdmission) {}
  private leases() { this.cancelledLeases = this.cancelledLeases.filter(deadline => deadline > this.now()); return this.active.size + this.cancelledLeases.length + Number(this.probeReservation); }
  async setDriver(driver?: AiDriver) {
    const generation = ++this.driverGeneration;
    this.commanderSamples.clear();
    this.recentFailures=[];
    const previous = this.driver; this.driver = undefined; this.invalidate('MATCH_REPLACED');
    if (previous) await previous.invalidateAiRequests('MATCH_REPLACED').catch(() => {});
    if (generation !== this.driverGeneration || this.stopped && driver) return;
    this.key = ''; this.state = undefined; this.progress=undefined;this.commanders.clear(); this.renewalLatencies=[];this.renewalVersion=-1;this.driver = driver;
  }
  invalidate(reason = 'REQUEST_CANCELLED') {
    this.admission?.cancelPending();
    for (const active of this.active.values()) { if (active.invalidated) continue; active.invalidated = true; active.controller.abort(); }
    for (const [playerId, commander] of this.commanders) {
      if(this.renewal&&commander.pending)this.renewalEvent('pending_cancelled',{traceId:commander.pending.traceId,playerId:commander.playerId,reason});
      // Cancellation cleanup still owns its old object. Detach the retained
      // cadence/history so a late request cannot postpone renewal after resume.
      const retained = { ...commander, lastStatus: reason };
      delete retained.pending;
      delete retained.renewalWatermark;
      delete retained.renewalSchedule;
      this.commanders.set(playerId, retained);
    }
  }
  urgent(playerId: string, requestId: string): boolean {
    const commander = this.commanders.get(playerId); if (!commander || this.state?.status !== 'RUNNING') return false;
    const previous=commander.pending;commander.pending = { queuedAt: previous?.queuedAt ?? this.now(), requestId, ...(previous?.traceId===undefined?{}:{traceId:previous.traceId}) };
    if(this.renewal){commander.pending.traceId??=++this.renewal.serial;this.renewalEvent(previous?'urgent_coalesced':'queued',{traceId:commander.pending.traceId,playerId,source:'urgent',generation:commander.generation,dueWallAtMs:commander.pending.queuedAt,queuedWallAtMs:commander.pending.queuedAt});}return true;
  }
  invalidatePlayer(playerId: string, reason = 'CONTROLLER_CHANGED') {
    this.admission?.cancelPending(playerId);
    const active = this.active.get(playerId); if (active) { active.invalidated = true; active.controller.abort(); }
    const commander = this.commanders.get(playerId);
    if (this.renewal && commander?.pending) this.renewalEvent('pending_cancelled', { traceId: commander.pending.traceId, playerId, reason });
    this.commanders.delete(playerId);
  }
  configurationChanged() {
    this.invalidate('CONFIG_CHANGED'); this.commanders.clear();
    this.commanderSamples.clear();
    this.consecutiveFailures = 0; this.circuitUntil = 0; this.rateUntil = 0; this.halfOpen = false;
    this.recentFailures = []; this.latencies = []; this.queues = []; this.renewalLatencies = [];
    this.progress=undefined;this.stages=stageSamples();
  }
  async probe(listModels: boolean) {
    if (this.probeReservation || this.leases() >= this.config.snapshot().settings.maxConcurrent) throw new EndpointError('ENDPOINT_BUSY');
    const snapshot = this.config.snapshot(), admission = this.admission?.acquire({ queuedAt: this.now(), deadline: this.now() + snapshot.settings.timeoutSeconds * 1000 });
    if (this.admission && !admission) throw new EndpointError('ENDPOINT_BUSY');
    this.probeReservation = true;
    try { const result = await this.clientFactory(snapshot).probe(listModels); this.config.setCapability(result.mode, result.status, snapshot.version); return result; }
    finally { this.probeReservation = false; admission?.release(this.config.snapshot().version !== snapshot.version); }
  }
  pendingRequests(): { playerId: string; queuedAt: number }[] {
    if (this.stopped || this.state?.status !== 'RUNNING' || !this.config.state().configured || this.now() < this.circuitUntil || this.now() < this.rateUntil || this.probeReservation || this.halfOpen || this.circuitUntil && this.active.size || this.leases() >= this.config.snapshot().settings.maxConcurrent) return [];
    return [...this.commanders.values()].filter(item => item.pending && !this.active.has(item.playerId)).map(item => ({ playerId: item.playerId, queuedAt: item.pending!.queuedAt }));
  }
  measurementSamples() { return { latencies: [...this.latencies], queues: [...this.queues],stages:Object.fromEntries(AI_REQUEST_STAGES.map(stage=>[stage,{...this.stages[stage],durations:[...this.stages[stage].durations]}])) as typeof this.stages }; }
  async poll(queueOnly = false): Promise<void> {
    if (this.polling || this.stopped || !this.driver) return; this.polling = true;
    const driver = this.driver;
    try {
      const state = await driver.aiSchedulingState(); if (driver !== this.driver || this.stopped) return;
      const key = `${state.matchId}/${state.matchEpoch}`;
      const sameMatch = this.state?.matchId === state.matchId;
      if(this.state&&!sameMatch){this.recentFailures=[];this.commanderSamples.clear();}
      if (this.key !== key) {
        this.invalidate('EPOCH_CHANGED');
        // A pause changes request authority, not the lifetime of an accepted
        // plan. Reapplying the initial faction stagger here can delay the later
        // commanders past expiry on every resume. Preserve their real cooldown,
        // failure backoff and acceptance history, then recompute from fresh
        // authoritative renewal metadata. New matches still start independently.
        if (!sameMatch) { this.commanders.clear(); this.renewalLatencies=[]; }
        this.progress=undefined;this.key = key;
      }
      this.state = state;if(this.renewal)this.renewalState(state);
      const snapshot = this.config.snapshot(), settings = snapshot.settings;
      if(this.failureHistoryVersion!==snapshot.version){this.failureHistoryVersion=snapshot.version;this.recentFailures=[];}
      if (state.status !== 'RUNNING') { this.progress=undefined;this.invalidate('MATCH_NOT_RUNNING'); return; }
      this.observeProgress(state.tick);
      if(this.renewalVersion!==snapshot.version){this.renewalVersion=snapshot.version;this.renewalLatencies=[];}
      const present = new Set(state.commanders.map(item => item.playerId));
      for (const playerId of this.commanders.keys()) if (!present.has(playerId)) this.invalidatePlayer(playerId, 'CONTROLLER_REMOVED');
      for (const [index, item] of state.commanders.entries()) {
        if (!item.alive) { const pending=this.commanders.get(item.playerId)?.pending;if(this.renewal&&pending)this.renewalEvent('pending_cancelled',{traceId:pending.traceId,playerId:item.playerId,reason:'COMMANDER_DEFEATED'});this.commanders.delete(item.playerId); const active = this.active.get(item.playerId); if (active) { active.invalidated = true; active.controller.abort(); } continue; }
        let commander = this.commanders.get(item.playerId);
        if (!commander || commander.generation !== item.generation) {
          const active = this.active.get(item.playerId); if (active) { active.invalidated = true; active.controller.abort(); }
          const intervalSeconds = commander?.intervalSeconds ?? settings.intervalSeconds[item.difficulty];
          // Core nextStrategicTick schedules rule policy; endpoint cadence is independently host-configured.
          const nextDueAt = commander?.nextDueAt ?? this.now() + Math.floor(index * intervalSeconds * 1000 / Math.max(1, state.commanders.length));
          // A cooperation preset invalidates the binding, not the faction's established model cadence.
          // Initial staggering is a nominal due time, never a recovery cooldown:
          // an existing/expired authoritative plan can already need renewal.
          commander = { ...item, nextDueAt, nominalDueAt:commander?.nominalDueAt??nextDueAt,renewalNotBefore:commander?.renewalNotBefore??this.now(),intervalSeconds, lastStatus: commander?.lastStatus ?? (this.config.state().configured ? 'WAITING' : 'NOT_CONFIGURED'), lastLatencyMs: commander?.lastLatencyMs ?? null, failures: commander?.failures ?? 0, lastAcceptedAt: commander?.lastAcceptedAt ?? null, ...(commander?.pending ? { pending: commander.pending } : {}) };
          this.commanders.set(item.playerId, commander);
        }
        commander.mode = item.mode;
        if (commander.lastStatus === 'MATCH_NOT_RUNNING' || commander.lastStatus === 'EPOCH_CHANGED') commander.lastStatus = this.config.state().configured ? 'WAITING' : 'NOT_CONFIGURED';
        this.scheduleRenewal(commander,item.renewal,state);
        if (this.config.state().configured && this.now() >= commander.nextDueAt && !commander.pending && !this.active.has(item.playerId)){commander.pending = { queuedAt: this.now() };if(this.renewal){commander.pending.traceId=++this.renewal.serial;this.renewalEvent('queued',{traceId:commander.pending.traceId,playerId:commander.playerId,source:'periodic',generation:commander.generation,dueWallAtMs:commander.nextDueAt,queuedWallAtMs:commander.pending.queuedAt});}}
      }
      if (queueOnly) return;
      if (!this.config.state().configured || this.now() < this.circuitUntil || this.now() < this.rateUntil || this.probeReservation) return;
      if (this.circuitUntil && this.now() >= this.circuitUntil && this.active.size) return;
      const candidates = [...this.commanders.values()].filter(commander => commander.pending && !this.active.has(commander.playerId)).sort((a, b) => a.pending!.queuedAt - b.pending!.queuedAt || a.playerId.localeCompare(b.playerId));
      for (const commander of candidates) {
        if (this.leases() >= settings.maxConcurrent || this.halfOpen) break;
        const deadline = this.now() + workerWaitMs + settings.timeoutSeconds * 1000, admission = this.admission?.acquire({ playerId: commander.playerId, queuedAt: commander.pending!.queuedAt, deadline });
        if (this.admission && !admission) continue;
        if (this.circuitUntil) this.halfOpen = true;
        const queued = commander.pending!; delete commander.pending;
        const active: Active = { controller: new AbortController(), deadline, queuedAt:queued.queuedAt,version: snapshot.version, driver, invalidated: false, ...(admission ? { admission } : {}) };
        this.active.set(commander.playerId, active); commander.lastStatus = 'IN_FLIGHT'; boundedSample(this.queues, this.now() - queued.queuedAt);
        if(this.renewal){active.traceId=queued.traceId;active.traceScope=this.key;this.renewalEvent('dispatch',{traceId:active.traceId,playerId:commander.playerId,generation:commander.generation,queuedWallAtMs:queued.queuedAt,intervalSeconds:commander.intervalSeconds});}
        void this.dispatch(commander, active, queued.requestId);
      }
    } catch { this.invalidate('WORKER_UNAVAILABLE'); if (this.driver === driver) await driver.invalidateAiRequests('WORKER_UNAVAILABLE').catch(() => {}); }
    finally { this.polling = false; }
  }
  private async dispatch(commander: Commander, active: Active, requestId?: string) {
    const started = this.now(), snapshot = this.config.snapshot(), signal = active.controller.signal;
    const samples=this.requestSamples(commander.playerId),allStages=this.stages;
    boundedSample(samples.queues,Math.max(0,started-active.queuedAt));
    let failed = false, retryContentFailure = false, completion: CompletionResult | undefined, usageRecorded = false,acceptedRenewal:AiRenewalState|undefined;
    let currentStage:RequestStage='preparation';
    const measured=async<T>(stage:RequestStage,operation:(stageSignal:AbortSignal)=>Promise<T>):Promise<T>=>{
      currentStage=stage;const began=this.now(),endpoint=stage==='endpoint'?new AbortController():undefined,stageSignal=endpoint?AbortSignal.any([signal,endpoint.signal]):signal;
      const limit=endpoint?snapshot.settings.timeoutSeconds*1000:workerWaitMs,code=stage==='preparation'?'AI_PREPARATION_TIMEOUT':stage==='application'?'AI_APPLICATION_TIMEOUT':'TIMEOUT';
      try{
        // Arm before invoking the operation. Synchronous prompt work cannot be
        // preempted, so also reject a result which returns after its deadline.
        const result=await boundedWait(Promise.resolve().then(()=>operation(stageSignal)),limit,code,signal,()=>endpoint?.abort());
        if(stage==='preparation'&&this.now()-began>=limit)throw new EndpointError(code);return result;
      }
      finally{const elapsed=Math.max(0,this.now()-began);boundedSample(allStages[stage].durations,elapsed);boundedSample(samples.stages[stage].durations,elapsed);}
    };
    // Private numeric/code-only lifecycle metadata. No prompt, content or credential is retained.
    const traceEvent=this.renewal?(kind:string,fields:Record<string,unknown>={})=>this.renewalEvent(kind,{scope:active.traceScope,traceId:active.traceId,playerId:commander.playerId,...fields}):undefined;
    const traceBinding=()=>active.binding?{...active.binding}:null;
    const traceCode=(error:unknown)=>error instanceof EndpointError?failureCode(error):signal.aborted?'ABORTED':'REQUEST_ERROR';
    const ownsLease = () => !active.invalidated && this.driver === active.driver && this.config.snapshot().version === active.version && this.commanders.get(commander.playerId)===commander;
    const current = () => ownsLease() && !signal.aborted;
    const scheduleAfterRequest = (latencyP95Ms:number) => {
      const floor = snapshot.settings.intervalSeconds[commander.difficulty], latencyInterval = latencyP95Ms / 1000 * Math.max(1, this.commanders.size) / snapshot.settings.maxConcurrent * 1.25;
      commander.intervalSeconds = Math.min(snapshot.settings.maxAdaptiveIntervalSeconds, Math.max(floor, Math.ceil(latencyInterval), failed ? Math.min(snapshot.settings.maxAdaptiveIntervalSeconds, floor * (1 + commander.failures)) : floor));
      // One malformed/truncated response gets a fresh ordinary queued request.
      // Consecutive failures return to adaptive backoff; global rate/circuit limits
      // still apply, and this never recursively resubmits the same observation.
      if(retryContentFailure)commander.intervalSeconds=Math.min(commander.intervalSeconds,Math.max(renewalCooldownMs/1000,Math.ceil(latencyInterval)));
      // Failed retries keep wall time; successful renewals use game progress when
      // authoritative metadata is available after the application acknowledgement.
      commander.nominalDueAt=this.now()+commander.intervalSeconds*1000;
      commander.renewalNotBefore=this.now()+(failed?commander.intervalSeconds*1000:renewalCooldownMs);
      commander.nextDueAt=commander.nominalDueAt;delete commander.renewalSchedule;
    };
    const recordUsage = (telemetry: CompletionTelemetry | undefined) => {
      if (!telemetry || usageRecorded || !current()) return;
      usageRecorded = true;
      this.usage = { promptTokens: telemetry.promptTokens ?? null, completionTokens: telemetry.completionTokens ?? null, prefillMs: telemetry.prefillMs ?? null, generationMs: telemetry.generationMs ?? null };
      // Coverage concerns recognized plan-completion envelopes, accepted or rejected. Missing/partial usage is
      // unknown; transport failures, unparseable envelopes and explicit capability probes are not counted here.
      if (telemetry.promptTokens !== undefined && telemetry.completionTokens !== undefined && telemetry.totalTokens !== undefined) this.usageTotals.reportedRequests++; else this.usageTotals.missingUsageRequests++;
      this.usageTotals.promptTokens += telemetry.promptTokens ?? 0; this.usageTotals.completionTokens += telemetry.completionTokens ?? 0; this.usageTotals.totalTokens += telemetry.totalTokens ?? 0;
    };
    try {
      const promptOptions={outputTokenBudget:snapshot.settings.maxOutputTokens,sendHumanChat:snapshot.settings.sendHumanChat};
      let budget=snapshot.settings.inputTokenBudget,preparationWaiting=true,prepared:{dispatch:AiDispatch;prompt:ReturnType<typeof buildAiPrompt>};
      try{prepared=await measured('preparation',async()=>{
        const preparation=active.driver.prepareAiRequest(commander.playerId, `req_${randomBytes(12).toString('hex')}`, requestId ? [requestId] : []);
        // The native RPC itself expires at fifteen seconds. A custom/late driver
        // must still release its exact binding, never apply a late model response.
        void preparation.then(dispatch=>{active.binding=dispatch.binding;if(!preparationWaiting||!ownsLease())void boundedWait(active.driver.completeAiRequest(dispatch.binding,{kind:'failure',code:'AI_PREPARATION_TIMEOUT'}),workerWaitMs,'AI_APPLICATION_TIMEOUT',new AbortController().signal).catch(()=>{});}).catch(()=>{});
        const dispatch=await preparation;if(!current()||!preparationWaiting)throw new EndpointError('CANCELLED');
        return {dispatch,prompt:buildAiPrompt(dispatch,{inputTokenBudget:budget,...promptOptions})};
      });}finally{preparationWaiting=false;}
      const {dispatch}=prepared;let {prompt}=prepared;
      traceEvent?.('observation',{binding:traceBinding()});
      if (!current()) throw new EndpointError('CANCELLED');
      const client = this.clientFactory(snapshot), knownMode = this.config.state().capability.mode;
      let mode: Exclude<OutputMode, 'unprobed'> = knownMode === 'json_object' || knownMode === 'prompt_json' ? knownMode : 'schema';
      const messages = (): EndpointMessages => ({ system: prompt.messages[0]!.content, user: prompt.messages[1]!.content });
      active.deadline=this.now()+snapshot.settings.timeoutSeconds*1000;active.admission?.setDeadline?.(active.deadline);
      await measured('endpoint',async endpointSignal=>{
      if (snapshot.settings.providerProfile === 'llama_cpp' && this.tokenizerUnsupportedVersion !== snapshot.version) {
        for (let attempt = 0; attempt < 3; attempt++) {
          traceEvent?.('tokenizer_start',{attempt,mode});
          let count:number|undefined;
          try{count=await client.countInput(messages(),mode,endpointSignal);traceEvent?.('tokenizer_end',{attempt,mode,outcome:count===undefined?'unsupported':'ok'});}
          catch(error){traceEvent?.('tokenizer_end',{attempt,mode,outcome:'error',code:traceCode(error)});throw error;}
          if (count === undefined) { this.tokenizerUnsupportedVersion = snapshot.version; break; }
          if (count <= snapshot.settings.inputTokenBudget) break;
          if (attempt === 2) throw new EndpointError('INPUT_TOKEN_LIMIT');
          budget = Math.max(1, Math.floor(budget * snapshot.settings.inputTokenBudget / count * .9)); prompt = buildAiPrompt(dispatch, { inputTokenBudget: budget, ...promptOptions });
        }
      }
      if (requestId && !prompt.observation.requests.some(request => request.requestId === requestId)) throw new EndpointError('CHAT_INPUT_BUDGET');
      let endpointAttempt=0;
      for (;;) {
        if(endpointSignal.aborted||!current())throw new EndpointError('CANCELLED');
        const attempt=endpointAttempt++;traceEvent?.('endpoint_start',{attempt,mode});
        try { completion = await client.complete(messages(), mode, endpointSignal);traceEvent?.('endpoint_end',{attempt,mode,outcome:'ok'}); break; }
        catch (error) {
          traceEvent?.('endpoint_end',{attempt,mode,outcome:'error',code:traceCode(error)});
          if (!(error instanceof EndpointError) || error.code !== 'REQUEST_UNSUPPORTED' || mode === 'prompt_json') throw error;
          mode = mode === 'schema' ? 'json_object' : 'prompt_json';
        }
      }
      });
      if (!current()) throw new EndpointError('CANCELLED');
      recordUsage(completion);
      // A provider already receives its own authorization header; never let it reflect that credential into a save or chat.
      if (reflectsCredential(completion!.content, snapshot.apiKey)) throw new EndpointError('MODEL_SECRET_REFLECTION');
      const result = await measured('application',()=>active.driver.completeAiRequest(dispatch.binding, { kind: 'plan', plan: completion!.content }));
      traceEvent?.('application_ack',{binding:traceBinding(),accepted:result.accepted,code:result.code,current:current(),renewal:result.renewal??null});
      if (!current()) throw new EndpointError('CANCELLED');
      if (!result.accepted) throw new EndpointError(result.code==='INVALID_AI_PLAN'&&result.diagnosticCode&&invalidPlanCodes.has(result.diagnosticCode)?result.diagnosticCode:result.code);
      const jointMs=this.now()-active.queuedAt;if(Number.isFinite(jointMs)&&jointMs>=0)boundedSample(this.renewalLatencies,jointMs);
      acceptedRenewal=result.renewal;
      this.config.setCapability(mode, 'PLAN_ACCEPTED', snapshot.version); this.completed++; samples.completed++; commander.lastAcceptedAt = this.now(); this.consecutiveFailures = 0; this.circuitUntil = 0; commander.failures = 0; commander.lastStatus = result.code;
      traceEvent?.('accepted',{binding:traceBinding(),code:result.code,renewal:result.renewal??null});
      if (result.message) this.onMessage(commander.playerId, result.message);
    } catch (error) {
      if (error instanceof EndpointError) recordUsage(error.completionTelemetry);
      const code = !ownsLease() || signal.aborted ? 'CANCELLED' : failureCode(error),failureStage=currentStage;
      commander.lastStatus = code;
      if (code !== 'CANCELLED' && !active.invalidated) {
        failed = true; this.failed++; samples.failed++; commander.failures++;
        for(const stages of [allStages,samples.stages]){stages[failureStage].failures++;if(['TIMEOUT','WORKER_TIMEOUT','AI_PREPARATION_TIMEOUT','AI_APPLICATION_TIMEOUT'].includes(code))stages[failureStage].timeouts++;}
        retryContentFailure=commander.failures===1&&retryableContentFailures.has(code);
        this.recentFailures.push({playerId:commander.playerId,code,at:this.now(),stage:failureStage});if(this.recentFailures.length>16)this.recentFailures.shift();
        if (!localFailureCodes.has(code)) {
          this.consecutiveFailures++;
          if (error instanceof EndpointError && error.retryAfterMs) this.rateUntil = Math.max(this.rateUntil, this.now() + error.retryAfterMs);
          if (this.consecutiveFailures >= 3 || this.halfOpen) this.circuitUntil = this.now() + 30000;
          this.config.setCapability(this.config.state().capability.mode, code, active.version);
        }
        if(active.binding){
          // A pause can detach this commander while the failure ACK is pending.
          // Establish its real backoff first so the retained copy cannot retry as
          // soon as the cancelled provider lease expires. Normal settlement below
          // includes any additional application time if this binding stays current.
          const pendingLatencies=[...this.latencies];boundedSample(pendingLatencies,Math.max(0,this.now()-started));
          scheduleAfterRequest(percentiles(pendingLatencies).p95);
          traceEvent?.('failure_application_start',{binding:traceBinding(),code});
          await measured('application',()=>active.driver.completeAiRequest(active.binding!,{kind:'failure',code})).then(
            result=>traceEvent?.('failure_application_ack',{binding:traceBinding(),accepted:result.accepted,code:result.code,current:current(),renewal:result.renewal??null}),
            error=>traceEvent?.('failure_application_error',{binding:traceBinding(),code:traceCode(error)}),
          );
        }
      }
    } finally {
      const elapsed = Math.max(0, this.now() - started); boundedSample(this.latencies, elapsed); commander.lastLatencyMs = Math.round(elapsed);
      if (active.invalidated && active.deadline > this.now()) this.cancelledLeases.push(active.deadline);
      active.admission?.release(active.invalidated);
      if (this.active.get(commander.playerId) === active) this.active.delete(commander.playerId);
      this.halfOpen = false;
      scheduleAfterRequest(percentiles(this.latencies).p95);
      if(!failed&&acceptedRenewal&&current()&&this.commanders.get(commander.playerId)===commander)this.scheduleRenewal(commander,acceptedRenewal,active.binding!);
      if(this.renewal)this.renewalEvent('settled',{scope:active.traceScope,traceId:active.traceId,playerId:commander.playerId,status:commander.lastStatus,failed,invalidated:active.invalidated,nextDueWallAtMs:commander.nextDueAt,intervalSeconds:commander.intervalSeconds});
    }
  }
  diagnostics(): EndpointDiagnosticsResponse['scheduler'] {
    const snapshot = this.config.snapshot(), settings = snapshot.settings;
    if(this.failureHistoryVersion!==snapshot.version){this.failureHistoryVersion=snapshot.version;this.recentFailures=[];}
    const commanders:EndpointDiagnosticsResponse['scheduler']['commanders']=[...this.commanders.values()].map(commander=>({playerId:commander.playerId,mode:commander.mode,inFlight:this.active.has(commander.playerId),pending:Boolean(commander.pending),intervalSeconds:commander.intervalSeconds,lastStatus:commander.lastStatus,lastLatencyMs:commander.lastLatencyMs,lastAcceptedAt:commander.lastAcceptedAt,requests:this.requestDiagnostics(commander.playerId)}));
    // A pause invalidates requests, while cadence and acceptance history remain
    // inspectable. A newly attached paused match may not have local history yet.
    if(this.state?.status!=='RUNNING')for(const item of this.state?.commanders??[])if(!commanders.some(row=>row.playerId===item.playerId))commanders.push({playerId:item.playerId,mode:item.mode,inFlight:this.active.has(item.playerId),pending:false,intervalSeconds:settings.intervalSeconds[item.difficulty],lastStatus:'MATCH_NOT_RUNNING',lastLatencyMs:null,requests:this.requestDiagnostics(item.playerId)});
    return { active: this.leases(), pending: [...this.commanders.values()].filter(commander => commander.pending).length, concurrency: settings.maxConcurrent, circuit: this.halfOpen ? 'half_open' : this.circuitUntil ? 'open' : 'closed', retryAfterMs: Math.max(0, this.circuitUntil - this.now(), this.rateUntil - this.now()), consecutiveFailures: this.consecutiveFailures, completed: this.completed, failed: this.failed, latencyMs: percentiles(this.latencies), queueDelayMs: percentiles(this.queues), ...this.usage, usageTotals: { ...this.usageTotals },
      stages:stageDiagnostics(this.stages),
      recentFailures:this.recentFailures.map(item=>({...item})),
      renewal:{estimateSource:'joint_queue_to_acceptance',samples:this.renewalLatencies.length,warmup:this.renewalLatencies.length<3,commanders:[...this.commanders.values()].map(commander=>({playerId:commander.playerId,leadMs:commander.renewalSchedule?.leadMs??null,remainingPlanTicks:commander.renewalSchedule?Math.max(0,commander.renewalSchedule.expiresTick-commander.renewalSchedule.tick):null,estimatedDeadlineFeasible:commander.renewalSchedule?.estimatedDeadlineFeasible??null,nextDueInMs:Math.max(0,commander.nextDueAt-this.now())}))},
      commanders };
  }
  currentTick(fallback = 0) { return this.state?.tick ?? fallback; }
  async close() { this.stopped = true; await this.setDriver(); }
}
