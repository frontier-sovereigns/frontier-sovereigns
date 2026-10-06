import { expect, it, vi } from 'vitest';
import { AiScheduler, type AiDriver, type AiRenewalState, type SchedulingState } from './ai-scheduler.js';
import { defaultEndpointSettings, EndpointClient, EndpointConfiguration, EndpointError } from './ai-endpoint.js';
import { buildAiPrompt, type AiDispatch, type AiRequestBinding } from '../../../packages/simulation/src/ai-observation.js';
import * as aiObservation from '../../../packages/simulation/src/ai-observation.js';
import { validateEndpointDiagnosticsResponse } from '@frontier/shared';

function harness(count = 5, concurrency = 2) {
  let now = 1000;
  const config = new EndpointConfiguration('runtime-data/unused-scheduler-config');
  const settings = { ...defaultEndpointSettings(), baseUrl: 'http://model.invalid/custom/v1', model: 'mock-model', maxConcurrent: concurrency, intervalSeconds: { easy: 10, medium: 10, hard: 10 }, timeoutSeconds: 1 };
  const state: SchedulingState = { matchId: 'test', matchEpoch: 1, tick: 0, status: 'RUNNING', commanders: Array.from({ length: count }, (_, index) => ({ playerId: `ai_${index}`, difficulty: 'hard', generation: 1, alive: true, nextStrategicTick: 0, mode: 'fallback' })) };
  const preparations: { playerId: string; tick: number; chats: string[] }[] = [], accepted: AiRequestBinding[] = [], failures: string[] = [];
  const calls: { playerId: string; observationId: string; mode:string; resolve: (response: Response) => void }[] = [];
  let serial = 0;
  const driver: AiDriver = {
    async aiSchedulingState() { return structuredClone(state); },
    async prepareAiRequest(playerId, requestId, chats) {
      preparations.push({ playerId, tick: state.tick, chats });
      const binding = { matchId: state.matchId, matchEpoch: state.matchEpoch, playerId, requestId, observationId: `obs_${++serial}`, observedTick: state.tick, controllerGeneration: state.commanders.find(item => item.playerId === playerId)!.generation };
      const bank = { food: 100, wood: 100, gold: 100, stone: 100 };
      return { binding, references: {}, observation: { schemaVersion: 1, identity: binding, player: { id: playerId, teamId: playerId, name: playerId, difficulty: 'hard', personality: 'builder' }, objective: { kind: 'conquest', opposingTeams: 1 }, economy: { age: 1, bank, incomePerMinute: bank, population: { used: 7, reserved: 0, cap: 10, limit: 120 }, workerTargetLimit: 60, workers: {} }, army: {}, buildings: [], production: [], legalTechnologies: [], references: [], resources: [], enemies: { visibleComposition: {}, lastKnownThreats: [] }, emergencies: [], goals: [], previousReceipts: [], memory: { facts: [], summary: '' }, requests: chats.map(requestId=>({requestId,senderId:'human',recipientId:playerId,text:'Defend',tick:state.tick,verified:false})) } } as AiDispatch;
    },
    async completeAiRequest(binding, result) { if (result.kind === 'failure') { failures.push(result.code); return { accepted: false, code: result.code }; } accepted.push(binding); return { accepted: true, code: 'PLAN_ACCEPTED' }; },
    async invalidateAiRequests() {},
  };
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    const body=JSON.parse(String(init.body)),observation = JSON.parse(body.messages[1].content);
    return new Promise<Response>(resolve => calls.push({ playerId: observation.identity.playerId, observationId: observation.identity.observationId, mode:body.response_format?.type??'prompt_json',resolve }));
  }) as typeof fetch;
  const scheduler = new AiScheduler(config, () => now, snapshot => new EndpointClient(snapshot.settings, snapshot.apiKey, fetcher));
  const ok = (index: number) => calls[index]!.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, observationId: calls[index]!.observationId, strategy: 'Test', goals: [], message: null }) } }] })));
  return { state, calls, preparations, accepted, failures, scheduler, config, settings, driver, ok, advance(ms: number) { now += ms; }, async start() { await config.load({ AI_BASE_URL: settings.baseUrl, AI_MODEL: settings.model, AI_MAX_CONCURRENT: String(concurrency), AI_TIMEOUT_SECONDS: '1', AI_INTERVAL_EASY_SECONDS: '10', AI_INTERVAL_MEDIUM_SECONDS: '10', AI_INTERVAL_HARD_SECONDS: '10' }); await scheduler.setDriver(driver); } };
}

// Model a worker which installs at acceptance, reports current simulation ticks,
// and owns the plan's immutable acceptance/expiry anchors independently of wall time.
function reportAcceptedPlans(h:ReturnType<typeof harness>,ttlTicks:number) {
  const complete=h.driver.completeAiRequest,read=h.driver.aiSchedulingState;
  h.driver.completeAiRequest=async(binding,result)=>{
    const reply=await complete(binding,result);if(!reply.accepted)return reply;
    const commander=h.state.commanders.find(item=>item.playerId===binding.playerId)!;
    commander.renewal={matchId:binding.matchId,matchEpoch:binding.matchEpoch,playerId:binding.playerId,controllerGeneration:binding.controllerGeneration,tick:h.state.tick,status:h.state.status,alive:true,mode:'model',reason:'VALID_PLAN',plan:{generation:(commander.renewal?.plan?.generation??0)+1,acceptedTick:h.state.tick,expiresTick:h.state.tick+ttlTicks},statistics:{modelReadyTicks:0,fallbackTicks:0,inferenceFailures:0}};
    return {...reply,renewal:structuredClone(commander.renewal)};
  };
  h.driver.aiSchedulingState=async()=>{
    const state=await read();for(const commander of state.commanders)if(commander.renewal){commander.renewal.tick=state.tick;commander.renewal.status=state.status;commander.renewal.matchEpoch=state.matchEpoch;}return state;
  };
}

it('attributes queue, acceptance and failure stages independently across all eight controllers and retains them through pauses',async()=>{
  const h=harness(8,2),prepare=h.driver.prepareAiRequest,complete=h.driver.completeAiRequest;
  h.driver.prepareAiRequest=async(...args)=>{if(args[0]==='ai_2')throw new Error('WORKER_TIMEOUT');return prepare(...args);};
  h.driver.completeAiRequest=async(binding,result)=>{if(binding.playerId==='ai_4'&&result.kind==='plan')throw new Error('WORKER_TIMEOUT');return complete(binding,result);};
  try{
    await h.start();await h.scheduler.poll(true);h.advance(10000);
    let answered=0;
    for(let turn=0;turn<20;turn++){
      await h.scheduler.poll();await new Promise<void>(resolve=>setImmediate(resolve));
      expect(h.scheduler.diagnostics().active).toBeLessThanOrEqual(2);
      while(answered<h.calls.length){const call=h.calls[answered]!;h.advance(25);if(call.playerId==='ai_3')call.resolve(new Response('{}',{status:503}));else h.ok(answered);answered++;}
      await new Promise<void>(resolve=>setImmediate(resolve));
      if(h.scheduler.diagnostics().completed+h.scheduler.diagnostics().failed===8)break;
    }
    const diagnostics=h.scheduler.diagnostics();expect(diagnostics).toMatchObject({completed:5,failed:3,active:0});expect(diagnostics.commanders).toHaveLength(8);
    const rows=new Map(diagnostics.commanders.map(row=>[row.playerId,row.requests!]));
    for(let index=0;index<8;index++){
      const row=rows.get(`ai_${index}`)!;expect(row.queueSamples).toBe(1);expect(row.completed+row.failed).toBe(1);
      const stage=index===2?'preparation':index===3?'endpoint':index===4?'application':undefined;
      expect(row.failed).toBe(stage?1:0);
      for(const key of ['preparation','endpoint','application'] as const)expect(row.stages[key].failures).toBe(key===stage?1:0);
    }
    expect(rows.get('ai_2')!.stages.preparation.timeouts).toBe(1);expect(rows.get('ai_4')!.stages.application.timeouts).toBe(1);
    h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();
    expect(h.scheduler.diagnostics().commanders.map(row=>row.requests)).toEqual(diagnostics.commanders.map(row=>row.requests));
    expect(h.scheduler.diagnostics().pending).toBe(0);h.state.status='RUNNING';await h.scheduler.poll(true);
    expect(h.scheduler.diagnostics().commanders.map(row=>row.requests)).toEqual(diagnostics.commanders.map(row=>row.requests));
    rows.get('ai_0')!.stages.endpoint.failures=999;expect(h.scheduler.diagnostics().commanders[0]!.requests!.stages.endpoint.failures).toBe(0);
    h.scheduler.configurationChanged();await h.scheduler.poll(true);expect(h.scheduler.diagnostics().commanders.every(row=>row.requests!.completed===0&&row.requests!.failed===0)).toBe(true);
  }finally{await h.scheduler.close();}
});

it('does not attribute late cancelled stage measurements to replacement model settings',async()=>{
  const h=harness(1,1);
  try{
    await h.start();await h.scheduler.poll();await new Promise<void>(resolve=>setImmediate(resolve));expect(h.calls).toHaveLength(1);
    h.scheduler.configurationChanged();await new Promise<void>(resolve=>setImmediate(resolve));await h.scheduler.poll(true);
    h.ok(0);await new Promise<void>(resolve=>setImmediate(resolve));
    const diagnostics=h.scheduler.diagnostics();expect(diagnostics.commanders[0]!.requests).toMatchObject({completed:0,failed:0,queueSamples:0});
    for(const stage of ['preparation','endpoint','application'] as const)expect(diagnostics.stages![stage]).toMatchObject({samples:0,failures:0,timeouts:0});
  }finally{await h.scheduler.close();}
});

it('budgets endpoint inference after preparation and applies the answer with a separate bounded worker wait',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness(1,1);
  let releasePrepare!:()=>void,releaseApply!:()=>void;const prepare=h.driver.prepareAiRequest,complete=h.driver.completeAiRequest;
  h.driver.prepareAiRequest=async(...args)=>{await new Promise<void>(resolve=>{releasePrepare=resolve;});return prepare(...args);};
  h.driver.completeAiRequest=async(...args)=>{if(args[1].kind==='plan')await new Promise<void>(resolve=>{releaseApply=resolve;});return complete(...args);};
  try{
    await h.start();await h.scheduler.poll();await vi.advanceTimersByTimeAsync(900);h.advance(900);expect(h.calls).toHaveLength(0);
    releasePrepare();await vi.advanceTimersByTimeAsync(0);expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(900);h.advance(900);h.ok(0);await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(900);h.advance(900);releaseApply();await vi.advanceTimersByTimeAsync(0);
    expect(h.scheduler.diagnostics()).toMatchObject({active:0,completed:1,failed:0,stages:{preparation:{durationMs:{max:900}},endpoint:{durationMs:{max:900}},application:{durationMs:{max:900}}}});
    expect(h.config.snapshot().settings.timeoutSeconds).toBe(1);
  }finally{await h.scheduler.close();vi.useRealTimers();}
});

it('accounts for initial prompt formatting in preparation without consuming the endpoint budget',async()=>{
  const h=harness(1,1),prepare=h.driver.prepareAiRequest,format=aiObservation.buildAiPrompt;
  h.driver.prepareAiRequest=async(...args)=>{h.advance(75);return prepare(...args);};
  const formatting=vi.spyOn(aiObservation,'buildAiPrompt').mockImplementation((...args)=>{h.advance(125);return format(...args);});
  try{
    await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
    h.advance(200);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(1);
    expect(formatting).toHaveBeenCalledOnce();
    expect(h.scheduler.diagnostics()).toMatchObject({failed:0,latencyMs:{max:400},stages:{preparation:{samples:1,durationMs:{max:200}},endpoint:{samples:1,durationMs:{max:200}},application:{durationMs:{max:0}}}});
    expect(h.config.snapshot().settings.timeoutSeconds).toBe(1);
  }finally{await h.scheduler.close();formatting.mockRestore();}
});

it('rejects a synchronous initial prompt overrun before contacting the model and releases its binding',async()=>{
  const h=harness(1,1),format=aiObservation.buildAiPrompt;
  const formatting=vi.spyOn(aiObservation,'buildAiPrompt').mockImplementation((...args)=>{h.advance(15001);return format(...args);});
  try{
    await h.start();await h.scheduler.poll();await expect.poll(()=>h.scheduler.diagnostics().failed).toBe(1);
    expect(h.calls).toHaveLength(0);expect(h.accepted).toHaveLength(0);expect(h.failures).toEqual(['AI_PREPARATION_TIMEOUT']);
    expect(h.scheduler.diagnostics()).toMatchObject({active:0,recentFailures:[{code:'AI_PREPARATION_TIMEOUT',stage:'preparation'}],stages:{preparation:{samples:1,durationMs:{max:15001},failures:1,timeouts:1},endpoint:{samples:0}}});
  }finally{await h.scheduler.close();formatting.mockRestore();}
});

it.each(['AI_PLAN_SCHEMA_INVALID','AI_PLAN_OBSERVATION_MISMATCH','private response credential'])('exposes only an allowlisted invalid-plan category (%s)',async diagnosticCode=>{
  const h=harness(1,1),complete=h.driver.completeAiRequest;
  h.driver.completeAiRequest=async(binding,result)=>result.kind==='plan'?{accepted:false,code:'INVALID_AI_PLAN',diagnosticCode:diagnosticCode as 'AI_PLAN_SCHEMA_INVALID'}:complete(binding,result);
  try{
    await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().failed).toBe(1);
    const scheduler=h.scheduler.diagnostics(),code=diagnosticCode.startsWith('AI_PLAN_')?diagnosticCode:'INVALID_AI_PLAN';
    expect(scheduler).toMatchObject({recentFailures:[{playerId:'ai_0',code,stage:'application'}],commanders:[{lastStatus:code,requests:{failed:1,stages:{application:{failures:1}}}}]});
    expect(JSON.stringify(scheduler)).not.toContain('private response');
    expect(validateEndpointDiagnosticsResponse({endpoint:{configured:true,mode:'schema',status:'ready'},scheduler,simulation:null,process:{rssMiB:120}})).toBe(true);
  }finally{await h.scheduler.close();}
});

it.each(['preparation','endpoint','application'] as const)('bounds a hung %s stage and records its failure without leaking upstream text',async stage=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness(1,1),prepare=h.driver.prepareAiRequest,complete=h.driver.completeAiRequest;let releasePrepare:(()=>void)|undefined;
  if(stage==='preparation')h.driver.prepareAiRequest=async(...args)=>{await new Promise<void>(resolve=>{releasePrepare=resolve;});return prepare(...args);};
  if(stage==='application')h.driver.completeAiRequest=async(...args)=>args[1].kind==='plan'?new Promise(()=>{}):complete(...args);
  try{
    await h.start();await h.scheduler.poll();await vi.advanceTimersByTimeAsync(0);
    if(stage==='application'){h.ok(0);await vi.advanceTimersByTimeAsync(0);}
    const delay=stage==='endpoint'?1000:15000;h.advance(delay);await vi.advanceTimersByTimeAsync(delay);
    const code=stage==='endpoint'?'TIMEOUT':stage==='preparation'?'AI_PREPARATION_TIMEOUT':'AI_APPLICATION_TIMEOUT';
    expect(h.scheduler.diagnostics()).toMatchObject({active:0,failed:1,recentFailures:[{code,stage}],stages:{[stage]:{failures:1,timeouts:1}},commanders:[{requests:{failed:1,stages:{[stage]:{failures:1,timeouts:1}}}}]});
    expect(h.scheduler.diagnostics().consecutiveFailures).toBe(stage==='endpoint'?1:0);
    if(releasePrepare){releasePrepare();await vi.advanceTimersByTimeAsync(0);expect(h.calls).toHaveLength(0);expect(h.failures).toEqual(['AI_PREPARATION_TIMEOUT']);}
  }finally{await h.scheduler.close();vi.useRealTimers();}
});

it('does not overwrite an already accepted plan when its acknowledgement arrives after the application deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness(1,1);let activeBinding:AiRequestBinding|undefined,acceptedPlan=false,release!:()=>void,cleanup=0;const prepare=h.driver.prepareAiRequest;
  h.driver.prepareAiRequest=async(...args)=>{const dispatch=await prepare(...args);activeBinding=dispatch.binding;return dispatch;};
  h.driver.completeAiRequest=async(binding,result)=>{
    if(result.kind==='failure'){cleanup++;if(activeBinding?.requestId!==binding.requestId)return {accepted:false,code:'STALE_AI_RESPONSE'};activeBinding=undefined;return {accepted:false,code:result.code};}
    if(activeBinding?.requestId!==binding.requestId)return {accepted:false,code:'STALE_AI_RESPONSE'};
    acceptedPlan=true;activeBinding=undefined;await new Promise<void>(resolve=>{release=resolve;});return {accepted:true,code:'PLAN_ACCEPTED'};
  };
  try{await h.start();await h.scheduler.poll();await vi.advanceTimersByTimeAsync(0);h.ok(0);await vi.advanceTimersByTimeAsync(0);expect(acceptedPlan).toBe(true);
    h.advance(15000);await vi.advanceTimersByTimeAsync(15000);expect(h.scheduler.diagnostics()).toMatchObject({completed:0,failed:1,recentFailures:[{code:'AI_APPLICATION_TIMEOUT',stage:'application'}]});expect(cleanup).toBe(1);expect(acceptedPlan).toBe(true);
    release();await vi.advanceTimersByTimeAsync(0);expect(h.scheduler.diagnostics().completed).toBe(0);expect(acceptedPlan).toBe(true);
  }finally{await h.scheduler.close();vi.useRealTimers();}
});

it('contains synchronous cleanup errors from a preparation that finishes after its deadline',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const h=harness(1,1),prepare=h.driver.prepareAiRequest;let release!:()=>void,cleanups=0;
  h.driver.prepareAiRequest=async(...args)=>{await new Promise<void>(resolve=>{release=resolve;});return prepare(...args);};
  h.driver.completeAiRequest=()=>{cleanups++;throw new Error('private upstream detail');};
  try{await h.start();await h.scheduler.poll();h.advance(15000);await vi.advanceTimersByTimeAsync(15000);expect(h.scheduler.diagnostics()).toMatchObject({active:0,failed:1,recentFailures:[{code:'AI_PREPARATION_TIMEOUT'}]});
    release();await vi.advanceTimersByTimeAsync(0);expect(cleanups).toBe(1);expect(h.calls).toHaveLength(0);expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('private upstream');
  }finally{await h.scheduler.close();vi.useRealTimers();}
});

it('paces healthy periodic renewals by game progress while urgent requests and failed recovery use wall time',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,1800);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(1);
  h.advance(10000);h.state.tick=20;await h.scheduler.poll();expect(h.calls).toHaveLength(1);expect(h.scheduler.renewalPolicyDiagnostics().gameProgressRate).toBe(.1);
  h.advance(80000);h.state.tick=180;await h.scheduler.poll();expect(h.calls).toHaveLength(1);
  h.advance(10000);h.state.tick=200;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
  h.calls[1]!.resolve(new Response('{}',{status:500}));await expect.poll(()=>h.scheduler.diagnostics().failed).toBe(1);
  const interval=h.scheduler.diagnostics().commanders[0]!.intervalSeconds;h.advance(interval*1000);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(3);
  h.ok(2);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(2);expect(h.scheduler.urgent('ai_0','chat_fresh')).toBe(true);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(4);h.ok(3);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(3);await h.scheduler.close();
});

it('renews two Easy commanders before each 90-second expiry despite a 120-second configured interval',async()=>{
  const h=harness(2,1);for(const commander of h.state.commanders)commander.difficulty='easy';
  reportAcceptedPlans(h,1800);const complete=h.driver.completeAiRequest,renewals:{playerId:string;tick:number;previousExpiry:number|null}[]=[];
  h.driver.completeAiRequest=async(binding,result)=>{
    const previousExpiry=h.state.commanders.find(item=>item.playerId===binding.playerId)!.renewal?.plan?.expiresTick??null;
    const reply=await complete(binding,result);if(reply.accepted)renewals.push({playerId:binding.playerId,tick:h.state.tick,previousExpiry});return reply;
  };
  await h.start();await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'45',AI_INTERVAL_EASY_SECONDS:'120',AI_INTERVAL_MEDIUM_SECONDS:'45',AI_INTERVAL_HARD_SECONDS:'30'});
  const due=new Map<number,number>();let seen=0;
  // Ten minutes of fake wall/simulation time, with one-second polls and a serial
  // endpoint taking seventeen seconds. No live inference or wall-clock soak.
  for(let second=0;second<=600;second++){
    if(second)h.advance(1000);h.state.tick=second*20;
    for(const [index,at] of due)if(at===second){h.ok(index);due.delete(index);}
    await new Promise<void>(resolve=>setImmediate(resolve));
    for(const commander of h.state.commanders)if(commander.renewal?.plan)expect(commander.renewal.plan.expiresTick).toBeGreaterThan(h.state.tick);
    await h.scheduler.poll();await new Promise<void>(resolve=>setImmediate(resolve));
    while(seen<h.calls.length)due.set(seen++,second+17);
    expect(h.scheduler.diagnostics().active).toBeLessThanOrEqual(1);
  }
  for(const commander of h.state.commanders)expect(renewals.filter(item=>item.playerId===commander.playerId).length).toBeGreaterThanOrEqual(5);
  for(const renewal of renewals)if(renewal.previousExpiry!==null)expect(renewal.tick).toBeLessThan(renewal.previousExpiry);
  expect(h.config.snapshot().settings.intervalSeconds.easy).toBe(120);
  expect(h.scheduler.diagnostics()).toMatchObject({failed:0,recentFailures:[]});
  for(const [index] of due)h.ok(index);await new Promise<void>(resolve=>setImmediate(resolve));await h.scheduler.close();
});

it.each(['INVALID_AI_PLAN','AI_PLAN_SCHEMA_INVALID','AI_PLAN_OBSERVATION_MISMATCH','INVALID_JSON','OUTPUT_TRUNCATED'] as const)('gives one fresh bounded recovery request for %s, then restores adaptive backoff and circuit protection',async code=>{
  const h=harness(1,1),complete=h.driver.completeAiRequest;let reject=true;
  const invalidPlan=code==='INVALID_AI_PLAN'||code==='AI_PLAN_SCHEMA_INVALID'||code==='AI_PLAN_OBSERVATION_MISMATCH';
  if(invalidPlan)h.driver.completeAiRequest=async(binding,result)=>result.kind==='plan'&&reject?{accepted:false,code:'INVALID_AI_PLAN',...(code==='AI_PLAN_SCHEMA_INVALID'||code==='AI_PLAN_OBSERVATION_MISMATCH'?{diagnosticCode:code}:{})}:complete(binding,result);
  await h.start();await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'45',AI_INTERVAL_EASY_SECONDS:'120',AI_INTERVAL_MEDIUM_SECONDS:'120',AI_INTERVAL_HARD_SECONDS:'120'});
  const fail=(index:number)=>invalidPlan?h.ok(index):h.calls[index]!.resolve(new Response(JSON.stringify({choices:[{finish_reason:code==='OUTPUT_TRUNCATED'?'length':'stop',message:{content:'private invalid output'}}]})));
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);fail(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({intervalSeconds:10,lastStatus:code});
  h.advance(9999);await h.scheduler.poll();expect(h.calls).toHaveLength(1);
  h.advance(1);h.state.tick=200;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
  expect(h.calls[1]!.observationId).not.toBe(h.calls[0]!.observationId);expect(h.preparations[1]!.tick).toBe(200);
  fail(1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({intervalSeconds:120});
  h.advance(119999);await h.scheduler.poll();expect(h.calls).toHaveLength(2);
  h.advance(1);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(3);fail(2);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({circuit:'open',consecutiveFailures:3,retryAfterMs:30000});
  h.advance(30000);await h.scheduler.poll();expect(h.calls).toHaveLength(3);
  h.advance(90000);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(4);expect(h.scheduler.diagnostics().circuit).toBe('half_open');
  reject=false;h.ok(3);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({completed:1,failed:3,circuit:'closed'});
  expect(h.scheduler.diagnostics().recentFailures?.map(item=>item.code)).toEqual([code,code,code]);await h.scheduler.close();
});

it('keeps the first content recovery latency-aware instead of retrying immediately on a slow endpoint',async()=>{
  const h=harness(2,1);await h.start();await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'45',AI_INTERVAL_EASY_SECONDS:'120',AI_INTERVAL_MEDIUM_SECONDS:'120',AI_INTERVAL_HARD_SECONDS:'120'});
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.advance(20000);
  h.calls[0]!.resolve(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'private'}}]})));
  await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({intervalSeconds:50,lastStatus:'OUTPUT_TRUNCATED'});
  h.advance(10000);await h.scheduler.poll();expect(h.calls).toHaveLength(1);await h.scheduler.close();
});

it('bounds allowlisted failure history, retains it across success/pause/epoch, and isolates returned snapshots',async()=>{
  const h=harness(1,1);await h.start();
  for(let index=0;index<17;index++){
    if(index)h.scheduler.urgent('ai_0','chat_failure');await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(index*2+1);
    h.calls[index*2]!.resolve(new Response('{}',{status:500}));await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    h.scheduler.urgent('ai_0','chat_recovery');await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(index*2+2);h.ok(index*2+1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);h.advance(1000);
  }
  const history=h.scheduler.diagnostics().recentFailures!;expect(history).toHaveLength(16);expect(history[0]).toEqual({playerId:'ai_0',code:'ENDPOINT_FAILURE',at:2000,stage:'endpoint'});
  history[0]!.code='MUTATED';expect(h.scheduler.diagnostics().recentFailures![0]!.code).toBe('ENDPOINT_FAILURE');
  h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();expect(h.scheduler.diagnostics().recentFailures).toHaveLength(16);
  h.state.status='RUNNING';h.advance(9000);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(35);h.ok(34);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics().recentFailures).toHaveLength(16);await h.scheduler.close();expect(h.scheduler.diagnostics().recentFailures).toEqual([]);
});

it.each(['match','driver','config'])('clears failure history on a new %s without changing the model service',async change=>{
  const h=harness(1,1);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.calls[0]!.resolve(new Response('{}',{status:500}));await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);expect(h.scheduler.diagnostics().recentFailures).toHaveLength(1);
  h.state.status='PAUSED';
  if(change==='match'){h.state.matchId='another';await h.scheduler.poll();}
  else if(change==='driver')await h.scheduler.setDriver({...h.driver});
  else await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:'another'});
  expect(h.scheduler.diagnostics().recentFailures).toEqual([]);await h.scheduler.close();
});

it.each([false,true])('never publishes arbitrary uppercase exception text (EndpointError=%s)',async endpointError=>{
  const h=harness(1,1);h.driver.prepareAiRequest=async()=>{throw endpointError?new EndpointError('PRIVATE_UPSTREAM_CREDENTIAL'):new Error('PRIVATE_UPSTREAM_CREDENTIAL');};
  await h.start();await h.scheduler.poll();await expect.poll(()=>h.scheduler.diagnostics().failed).toBe(1);
  expect(h.scheduler.diagnostics()).toMatchObject({recentFailures:[{playerId:'ai_0',code:'INFERENCE_FAILED',at:1000}],commanders:[{lastStatus:'INFERENCE_FAILED'}]});
  expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('PRIVATE_UPSTREAM');await h.scheduler.close();
});

it('does not record stale cancelled completion failures after an endpoint version change',async()=>{
  const h=harness(1,1);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:'another'});
  h.calls[0]!.resolve(new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'private'}}]})));
  await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({completed:0,failed:0,recentFailures:[]});expect(h.failures).toEqual([]);await h.scheduler.close();
});

it('Q1 renews before plan expiry using joint latency and a polling margin while keeping the minimum completion cooldown',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,900);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(30000);h.state.tick=600;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.renewalPolicyDiagnostics()).toMatchObject({samples:1,jointLatencyMs:{p95:30000},commanders:[{nominalDueAtMs:69000,nextDueAtMs:45000,notBeforeAtMs:41000,estimatedExpiresAtMs:76000,leadMs:31000,estimatedDeadlineFeasible:true}]});
  expect(h.scheduler.diagnostics().renewal).toEqual({estimateSource:'joint_queue_to_acceptance',samples:1,warmup:true,commanders:[{playerId:'ai_0',leadMs:31000,remainingPlanTicks:900,estimatedDeadlineFeasible:true,nextDueInMs:14000}]});
  const plan=structuredClone(h.state.commanders[0]!.renewal!.plan);
  h.advance(13950);h.state.tick=879;await h.scheduler.poll();expect(h.calls).toHaveLength(1);
  h.advance(50);h.state.tick=880;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
  expect(h.state.commanders[0]!.renewal!.plan).toEqual(plan);expect(h.preparations[1]!.tick).toBe(880);
  h.ok(1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.close();
});

it('Q1 measures queue through application acknowledgement jointly and reports infeasible renewal without inventing freshness',async()=>{
  const h=harness(2,1);reportAcceptedPlans(h,400);const complete=h.driver.completeAiRequest;let release:(()=>void)|undefined;
  h.driver.completeAiRequest=async(binding,result)=>{if(binding.playerId==='ai_1'&&result.kind==='plan')await new Promise<void>(resolve=>{release=resolve;});return complete(binding,result);};
  await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(5000);h.state.tick=100;await h.scheduler.poll();expect(h.scheduler.diagnostics().pending).toBe(1);
  h.advance(5000);h.state.tick=200;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);h.advance(3000);h.state.tick=260;h.ok(1);await expect.poll(()=>Boolean(release)).toBe(true);
  h.advance(7000);h.state.tick=400;release!();await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({queueDelayMs:{max:5000},latencyMs:{max:10000}});
  const policy=h.scheduler.renewalPolicyDiagnostics();expect(policy).toMatchObject({samples:2,jointLatencyMs:{p95:15000}});
  expect(policy.commanders.find(item=>item.playerId==='ai_1')).toMatchObject({leadMs:16000,notBeforeAtMs:31000,nextDueAtMs:31000,estimatedExpiresAtMs:41000,estimatedDeadlineFeasible:false});
  await h.scheduler.close();
});

it('Q1 expired plans never bypass the successful floor or failed adaptive backoff and do not create retry storms',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,0);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(30000);h.state.tick=600;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  for(let i=0;i<4;i++)await h.scheduler.poll();expect(h.calls).toHaveLength(1);expect(h.scheduler.diagnostics().pending).toBe(0);
  h.advance(9950);h.state.tick=799;await h.scheduler.poll();expect(h.calls).toHaveLength(1);
  h.advance(50);h.state.tick=800;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
  h.calls[1]!.resolve(new Response('{}',{status:500}));await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({notBeforeAtMs:79000,nextDueAtMs:79000});
  for(let i=0;i<4;i++)await h.scheduler.poll();expect(h.calls).toHaveLength(2);expect(h.scheduler.diagnostics().pending).toBe(0);
  h.advance(37950);h.state.tick=1559;await h.scheduler.poll();expect(h.calls).toHaveLength(2);
  h.advance(50);h.state.tick=1560;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(3);
  h.ok(2);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.close();
});

it('Q1 preserves FIFO service for five commanders when expired plans repeatedly become eligible',async()=>{
  const h=harness(5,1);reportAcceptedPlans(h,0);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  for(let index=0;index<5;index++){
    h.advance(10000);h.state.tick+=200;await h.scheduler.poll();expect(h.scheduler.diagnostics().active).toBe(1);
    h.ok(index);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(index+2);
  }
  expect(h.calls.map(item=>item.playerId)).toEqual(['ai_0','ai_1','ai_2','ai_3','ai_4','ai_0']);
  expect(h.preparations[5]!.tick).toBe(1000);h.ok(5);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.close();
});

it('Q1 keeps warmup bounded, then uses measured joint samples and clears them on endpoint changes',async()=>{
  const h=harness(5,1);reportAcceptedPlans(h,1800);await h.start();
  await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'120',AI_INTERVAL_EASY_SECONDS:'10',AI_INTERVAL_MEDIUM_SECONDS:'10',AI_INTERVAL_HARD_SECONDS:'10'});
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({leadMs:120000,estimatedDeadlineFeasible:false});
  for(let index=1;index<3;index++){expect(h.scheduler.urgent('ai_0',`chat_${index}`)).toBe(true);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(index+1);h.advance(100);h.ok(index);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);}
  expect(h.scheduler.renewalPolicyDiagnostics()).toMatchObject({samples:3,jointLatencyMs:{max:100}});expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({leadMs:2000});
  await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:'another-model',AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'1',AI_INTERVAL_EASY_SECONDS:'10',AI_INTERVAL_MEDIUM_SECONDS:'10',AI_INTERVAL_HARD_SECONDS:'10'});
  await h.scheduler.poll();expect(h.calls).toHaveLength(3);expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(0);expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({leadMs:6000});await h.scheduler.close();
});

it('Q1 uses the uncapped joint service estimate for feasibility even when the scheduling lead is capped',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,4800);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(130000);h.state.tick=2600;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.renewalPolicyDiagnostics()).toMatchObject({jointLatencyMs:{p95:130000},commanders:[{leadMs:120000,estimatedExpiresAtMs:371000,nextDueAtMs:251000,estimatedDeadlineFeasible:false}]});
  expect(h.scheduler.diagnostics().renewal!.commanders[0]).toEqual({playerId:'ai_0',leadMs:120000,remainingPlanTicks:4800,estimatedDeadlineFeasible:false,nextDueInMs:120000});await h.scheduler.close();
});

it('Q1 preserves an accepted deadline when an earlier empty-plan read completes later at the same simulation tick',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,900);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  const before=structuredClone(h.state);before.commanders[0]!.renewal={matchId:before.matchId,matchEpoch:before.matchEpoch,playerId:'ai_0',controllerGeneration:1,tick:0,status:'RUNNING',alive:true,mode:'fallback',reason:'ENDPOINT_UNAVAILABLE',plan:null,statistics:{modelReadyTicks:0,fallbackTicks:0,inferenceFailures:0}};
  const read=h.driver.aiSchedulingState;let release:((state:SchedulingState)=>void)|undefined;h.driver.aiSchedulingState=()=>new Promise(resolve=>{release=resolve;});const polling=h.scheduler.poll();
  h.advance(30000);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:45000,expiresTick:900});
  release!(before);await polling;expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:45000,expiresTick:900});expect(h.calls).toHaveLength(1);
  h.driver.aiSchedulingState=read;await h.scheduler.close();
});

it('Q1 rejects malformed or foreign expiry metadata and ignores late older snapshots within the same binding',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,900);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(30000);h.state.tick=600;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  const read=h.driver.aiSchedulingState,valid=await read();
  for(const change of [
    (item:AiRenewalState)=>{item.matchId='foreign';},(item:AiRenewalState)=>{item.matchEpoch++;},(item:AiRenewalState)=>{item.playerId='ai_other';},(item:AiRenewalState)=>{item.controllerGeneration++;},
    (item:AiRenewalState)=>{item.tick=NaN;},(item:AiRenewalState)=>{item.plan!.expiresTick=Infinity;},(item:AiRenewalState)=>{item.plan!.acceptedTick=601;},
  ]){
    const invalid=structuredClone(valid);change(invalid.commanders[0]!.renewal!);h.driver.aiSchedulingState=async()=>invalid;
    await h.scheduler.poll();expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:69000});expect(h.calls).toHaveLength(1);
  }
  h.driver.aiSchedulingState=async()=>structuredClone(valid);await h.scheduler.poll();expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:45000});
  const old=structuredClone(valid);old.tick=599;old.commanders[0]!.renewal!.tick=599;old.commanders[0]!.renewal!.plan={generation:1,acceptedTick:0,expiresTick:599};h.driver.aiSchedulingState=async()=>old;
  await h.scheduler.poll();expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:45000,tick:600,expiresTick:1500});
  h.driver.aiSchedulingState=read;h.state.commanders[0]!.generation++;await h.scheduler.poll();expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:69000});expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).not.toHaveProperty('expiresTick');
  h.state.commanders[0]!.renewal={...structuredClone(valid.commanders[0]!.renewal!),controllerGeneration:2,plan:{generation:1,acceptedTick:600,expiresTick:800}};
  await h.scheduler.poll();expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({nextDueAtMs:41000,planGeneration:1,expiresTick:800});
  await h.scheduler.close();
});

it('Q1 preserves same-match renewal history without crediting a cancelled old-epoch response',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,400);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(20000);h.state.tick=400;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  h.advance(18000);h.state.tick=760;h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();h.advance(60000);await h.scheduler.poll();expect(h.calls).toHaveLength(1);
  h.state.status='RUNNING';await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(1);
  h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();h.ok(1);await new Promise<void>(resolve=>setImmediate(resolve));
  expect(h.scheduler.diagnostics().commanders).toMatchObject([{pending:false,lastStatus:'MATCH_NOT_RUNNING',lastAcceptedAt:21000,lastLatencyMs:20000,requests:{completed:1,failed:0}}]);
  expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(1);expect(h.accepted).toHaveLength(1);
  h.state.status='RUNNING';h.advance(1001);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(3);h.ok(2);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  expect(h.accepted.at(-1)!.matchEpoch).toBe(3);expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(2);await h.scheduler.close();
});

it('renews all eight commanders after resume without repeating the initial 120-second stagger',async()=>{
  const h=harness(8,2);reportAcceptedPlans(h,1800);await h.start();
  await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'2',AI_TIMEOUT_SECONDS:'1',AI_INTERVAL_HARD_SECONDS:'120'});
  try{
    await h.scheduler.poll(true);h.advance(120000);h.state.tick=2400;
    for(let round=0;round<4;round++){
      await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe((round+1)*2);expect(h.scheduler.diagnostics().active).toBe(2);
      h.ok(round*2);h.ok(round*2+1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    }
    expect(h.scheduler.diagnostics().commanders.every(row=>row.lastAcceptedAt===121000&&row.requests!.completed===1)).toBe(true);
    // Four Pilots occupy the early positions, four host AIs the late ones. All
    // have one game second left; the pause must not add 60–105 seconds to bots.
    h.advance(89000);h.state.tick=4180;h.state.status='PAUSED';h.state.matchEpoch++;
    for(const commander of h.state.commanders){commander.generation++;commander.renewal!.controllerGeneration=commander.generation;}
    await h.scheduler.poll();h.advance(60000);
    expect(h.scheduler.diagnostics()).toMatchObject({active:0,pending:0});expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(8);
    expect(h.scheduler.diagnostics().commanders.every(row=>row.lastAcceptedAt===121000)).toBe(true);
    h.state.status='RUNNING';await h.scheduler.poll(true);expect(h.scheduler.diagnostics().pending).toBe(8);
    expect(h.scheduler.diagnostics().renewal!.commanders.every(row=>row.nextDueInMs===0)).toBe(true);
    for(let round=0;round<4;round++){
      await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(8+(round+1)*2);expect(h.scheduler.diagnostics().active).toBe(2);
      h.ok(8+round*2);h.ok(9+round*2);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    }
    expect(h.calls.slice(8).map(call=>call.playerId)).toEqual(h.state.commanders.map(row=>row.playerId));
    expect(h.accepted.slice(8).every(binding=>binding.matchEpoch===2&&binding.controllerGeneration===2&&binding.observedTick===4180)).toBe(true);
    expect(h.scheduler.diagnostics().commanders.every(row=>row.requests!.completed===2&&row.lastAcceptedAt===270000)).toBe(true);
    await h.scheduler.poll();expect(h.calls).toHaveLength(16);
  }finally{await h.scheduler.close();}
});

it('preserves expired-plan urgency when the plan is removed, while keeping failure backoff across a pause',async()=>{
  const h=harness(1,1);reportAcceptedPlans(h,0);await h.start();
  try{
    await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    h.state.commanders[0]!.renewal!.plan=null;h.state.commanders[0]!.renewal!.reason='PLAN_EXPIRED';h.state.tick=200;h.advance(10000);
    await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
    h.calls[1]!.resolve(new Response('{}',{status:503}));await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();h.state.status='RUNNING';h.state.tick++;h.advance(1000);await h.scheduler.poll();
    expect(h.calls).toHaveLength(2);expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({notBeforeAtMs:31000,nextDueAtMs:31000});
    h.advance(18999);await h.scheduler.poll();expect(h.calls).toHaveLength(2);
    h.advance(1);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(3);h.ok(2);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  }finally{await h.scheduler.close();}
});

it('queues restored expired plans without applying a new-faction cooldown',async()=>{
  const h=harness(8,2);await h.start();
  try{
    await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'2',AI_TIMEOUT_SECONDS:'1',AI_INTERVAL_HARD_SECONDS:'120'});
    h.state.tick=10000;
    for(const commander of h.state.commanders)commander.renewal={matchId:h.state.matchId,matchEpoch:h.state.matchEpoch,playerId:commander.playerId,controllerGeneration:commander.generation,tick:h.state.tick,status:'RUNNING',alive:true,mode:'fallback',reason:'PLAN_EXPIRED',plan:null,statistics:{modelReadyTicks:0,fallbackTicks:0,inferenceFailures:0}};
    await h.scheduler.poll(true);expect(h.scheduler.diagnostics()).toMatchObject({active:0,pending:8});
    expect(h.scheduler.diagnostics().commanders.every(row=>row.lastAcceptedAt===null&&row.requests!.completed===0)).toBe(true);
    await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);expect(h.scheduler.diagnostics().active).toBe(2);
    h.ok(0);h.ok(1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  }finally{await h.scheduler.close();}
});

it.each([false,true])('retains failure backoff when a pause interrupts its worker acknowledgement (rejected=%s)',async rejected=>{
  const h=harness(1,1),complete=h.driver.completeAiRequest;let release:(()=>void)|undefined;
  h.driver.completeAiRequest=async(binding,result)=>{
    if(result.kind==='failure')await new Promise<void>((resolve,reject)=>{release=()=>rejected?reject(new Error('WORKER_TIMEOUT')):resolve();});
    return complete(binding,result);
  };
  await h.start();
  try{
    await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
    h.calls[0]!.resolve(new Response('{}',{status:503}));await expect.poll(()=>Boolean(release)).toBe(true);
    expect(h.scheduler.diagnostics()).toMatchObject({failed:1,completed:0});
    h.state.status='PAUSED';h.state.matchEpoch++;await h.scheduler.poll();await new Promise<void>(resolve=>setImmediate(resolve));
    expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({lastStatus:'MATCH_NOT_RUNNING',lastAcceptedAt:null,requests:{failed:1,completed:0}});
    h.advance(1001);h.state.tick=1;h.state.status='RUNNING';await h.scheduler.poll();
    // The one-second provider lease is over, but the twenty-second failure
    // cooldown must survive even though its worker acknowledgement is still held.
    expect(h.scheduler.diagnostics()).toMatchObject({active:0,pending:0});expect(h.calls).toHaveLength(1);
    expect(h.scheduler.renewalPolicyDiagnostics().commanders[0]).toMatchObject({notBeforeAtMs:21000,nextDueAtMs:21000});
    release!();await new Promise<void>(resolve=>setImmediate(resolve));
    expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({lastAcceptedAt:null,requests:{failed:1,completed:0}});
    h.advance(18998);await h.scheduler.poll();expect(h.calls).toHaveLength(1);
    h.advance(1);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);h.ok(1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    expect(h.accepted).toHaveLength(1);expect(h.accepted[0]!.matchEpoch).toBe(2);
  }finally{release?.();await h.scheduler.close();}
});

it.each(['match','driver','config'])('resets acceptance history and renewal estimates for a new %s',async change=>{
  const h=harness(1,1);reportAcceptedPlans(h,1800);await h.start();
  try{
    await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
    expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({lastAcceptedAt:1000,requests:{completed:1}});
    if(change==='match'){h.state.matchId='new_match';delete h.state.commanders[0]!.renewal;}
    else if(change==='driver')await h.scheduler.setDriver({...h.driver});
    else h.scheduler.configurationChanged();
    await h.scheduler.poll(true);
    expect(h.scheduler.diagnostics().commanders[0]).toMatchObject({lastAcceptedAt:null,requests:{completed:0,failed:0}});
    expect(h.scheduler.renewalPolicyDiagnostics().samples).toBe(0);
  }finally{await h.scheduler.close();}
});

it('records private joint renewal latency and exact worker acceptance metadata without changing completion-delay cadence',async()=>{
  const h=harness(1,1);expect(h.scheduler.renewalDiagnostics()).toBeUndefined();let mono=0;h.scheduler.enableRenewalDiagnostics(()=>mono);await h.start();
  const complete=h.driver.completeAiRequest;h.driver.completeAiRequest=async(binding,result)=>({...await complete(binding,result),renewal:{matchId:h.state.matchId,matchEpoch:h.state.matchEpoch,playerId:binding.playerId,controllerGeneration:binding.controllerGeneration,status:h.state.status,alive:true,tick:h.state.tick,mode:'model',reason:'VALID_PLAN',plan:{generation:1,acceptedTick:h.state.tick,expiresTick:h.state.tick+1800},statistics:{modelReadyTicks:0,fallbackTicks:h.state.tick,inferenceFailures:0}}});
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.state.tick=20;h.advance(1000);mono+=1000;h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(1);
  const first=h.scheduler.renewalDiagnostics()!;expect(first.events.map(event=>event.kind)).toEqual(['queued','dispatch','observation','endpoint_start','endpoint_end','application_ack','accepted','settled']);expect(first.events[6]).toMatchObject({atMs:1000,renewal:{tick:20,plan:{acceptedTick:20,expiresTick:1820}}});expect(first.events[7]).toMatchObject({nextDueWallAtMs:12000,intervalSeconds:10});
  // The next request remains due ten seconds after completion, not start.
  h.advance(9999);mono+=9999;await h.scheduler.poll();expect(h.calls).toHaveLength(1);h.advance(1);mono++;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);h.ok(1);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(2);await h.scheduler.close();
});
it('bounds renewal traces, keeps omissions explicit, and preserves the public diagnostics shape',async()=>{
  const h=harness(1,1);h.scheduler.enableRenewalDiagnostics(()=>0);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);for(let index=0;index<4200;index++)h.scheduler.urgent('ai_0',`chat_${index}`);const trace=h.scheduler.renewalDiagnostics()!;expect(trace.events).toHaveLength(4096);expect(trace.omittedEvents).toBeGreaterThan(0);expect(h.scheduler.diagnostics()).not.toHaveProperty('aiRenewals');h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.close();
});

it('does not take an extra trace configuration snapshot when tracing is disabled',async()=>{
  const h=harness(1,1);await h.start();const original=h.config.snapshot.bind(h.config);let watch=false,copies=0,observed:number|undefined;
  h.config.snapshot=()=>{if(watch)copies++;return original();};
  h.driver.completeAiRequest=async()=>{watch=true;return {accepted:true,code:'PLAN_ACCEPTED',message:{recipientId:'human',text:'Ready',status:'planned'}};};
  h.scheduler.onMessage=()=>{observed=copies;watch=false;};await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>observed).toBe(1);expect(h.scheduler.renewalDiagnostics()).toBeUndefined();await h.scheduler.close();
});

it.each([false,true])('records terminal failure completion acknowledgement or RPC error (%s)',async rpcFails=>{
  const h=harness(1,1);let mono=0;h.scheduler.enableRenewalDiagnostics(()=>mono);await h.start();
  h.driver.completeAiRequest=async(binding,result)=>{expect(result.kind).toBe('failure');if(rpcFails)throw new Error('WORKER_TIMEOUT');return {accepted:false,code:'RATE_LIMIT',renewal:{matchId:binding.matchId,matchEpoch:binding.matchEpoch,playerId:binding.playerId,controllerGeneration:binding.controllerGeneration,tick:20,status:'RUNNING',alive:true,mode:'fallback',reason:'RATE_LIMIT',plan:null,statistics:{modelReadyTicks:0,fallbackTicks:20,inferenceFailures:1}}};};
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.advance(40);mono=40;h.calls[0]!.resolve(new Response('{}',{status:429}));await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  const trace=h.scheduler.renewalDiagnostics()!,kinds=trace.events.map(event=>event.kind);expect(kinds).toEqual(['queued','dispatch','observation','endpoint_start','endpoint_end','failure_application_start',rpcFails?'failure_application_error':'failure_application_ack','settled']);
  expect(trace.events[6]).toMatchObject({binding:{playerId:'ai_0',observedTick:0},...(rpcFails?{code:'REQUEST_ERROR'}:{accepted:false,renewal:{mode:'fallback',tick:20}})});expect(trace.events[7]).toMatchObject({failed:true,intervalSeconds:20,nextDueWallAtMs:21040});expect(trace.active).toEqual([]);expect(trace.pending).toEqual([]);await h.scheduler.close();
});

it('captures live pending and in-flight work and records queued defeat as a terminal cancellation',async()=>{
  const h=harness(2,1);let mono=0;h.scheduler.enableRenewalDiagnostics(()=>mono);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  h.advance(5000);mono=5000;await h.scheduler.poll();const before=h.scheduler.renewalDiagnostics()!;expect(before).toMatchObject({schemaVersion:2,capturedAtMs:5000,capturedWallAtMs:6000});expect(before.pending).toEqual([{traceId:2,scope:'test/1',playerId:'ai_1'}]);expect(before.active).toEqual([{traceId:1,scope:'test/1',playerId:'ai_0',invalidated:false}]);
  h.state.commanders[1]!.alive=false;await h.scheduler.poll();const after=h.scheduler.renewalDiagnostics()!;expect(after.pending).toEqual([]);expect(after.events.at(-1)).toMatchObject({kind:'pending_cancelled',traceId:2,playerId:'ai_1',reason:'COMMANDER_DEFEATED'});h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);await h.scheduler.close();
});

it('keeps endpoint negotiation attempts separate from one scheduler service interval',async()=>{
  const h=harness(1,1);h.scheduler.enableRenewalDiagnostics(()=>0);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.calls[0]!.resolve(new Response('{}',{status:400}));await expect.poll(()=>h.calls.length).toBe(2);h.ok(1);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  const events=h.scheduler.renewalDiagnostics()!.events;expect(events.filter(e=>e.kind==='dispatch')).toHaveLength(1);expect(events.filter(e=>e.kind==='endpoint_start').map(e=>e.attempt)).toEqual([0,1]);expect(events.filter(e=>e.kind==='endpoint_end').map(e=>e.outcome)).toEqual(['error','ok']);await h.scheduler.close();
});

it('uses wall-clock cadence when a running simulation advances slowly without dispatching during pause', async () => {
  const h = harness(1, 1); await h.start();
  await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.ok(0); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  h.state.tick = 40; h.advance(9999); await h.scheduler.poll(); expect(h.calls).toHaveLength(1);
  h.advance(1); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2);
  expect(h.preparations[1]!.tick).toBe(40);
  await h.scheduler.poll(); expect(h.calls).toHaveLength(2);
  h.ok(1); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  h.state.status = 'PAUSED'; h.advance(60000); await h.scheduler.poll(); expect(h.calls).toHaveLength(2);
  h.state.status = 'RUNNING'; h.state.matchEpoch++; await h.scheduler.poll();
  await expect.poll(() => h.calls.length).toBe(3); h.ok(2);
  await expect.poll(() => h.accepted.length).toBe(3); expect(h.accepted[2]!.matchEpoch).toBe(2);
  await h.scheduler.close();
});

it('negotiates prompted JSON within one binding and remembers the successful mode for fresh requests',async()=>{
  const h=harness(1,1);await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);
  expect(h.calls[0]!.mode).toBe('json_schema');h.calls[0]!.resolve(new Response('{}',{status:400}));await expect.poll(()=>h.calls.length).toBe(2);
  expect(h.calls[1]!.mode).toBe('json_object');h.calls[1]!.resolve(new Response('{}',{status:400}));await expect.poll(()=>h.calls.length).toBe(3);
  expect(h.calls[2]!.mode).toBe('prompt_json');expect(new Set(h.calls.map(call=>call.observationId)).size).toBe(1);expect(h.preparations).toHaveLength(1);expect(h.scheduler.diagnostics().active).toBe(1);
  h.ok(2);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(1);expect(h.config.state().capability.mode).toBe('prompt_json');
  h.state.tick=220;h.advance(11000);await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(4);expect(h.calls[3]!.mode).toBe('prompt_json');expect(h.calls[3]!.observationId).not.toBe(h.calls[2]!.observationId);
  h.ok(3);await expect.poll(()=>h.scheduler.diagnostics().completed).toBe(2);expect(h.failures).toEqual([]);await h.scheduler.close();
});

it('bounds five isolated contexts, coalesces urgent requests, and prepares fresh observations only when dispatched', async () => {
  const h = harness(); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.state.tick = 300; h.advance(10000); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2);
  expect(h.scheduler.diagnostics()).toMatchObject({ active: 2, pending: 3 });
  for (let i = 0; i < 10; i++) h.scheduler.urgent('ai_0', `chat_${i}`);
  await h.scheduler.poll(); expect(h.calls.length).toBe(2); expect(h.scheduler.diagnostics().pending).toBe(4);
  h.ok(0); h.ok(1); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  h.state.tick = 320; await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(4);
  expect(h.preparations.slice(2).every(item => item.tick === 320)).toBe(true); expect(new Set(h.calls.slice(2).map(item => item.playerId)).size).toBe(2);
  h.ok(2); h.ok(3); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(6);
  h.ok(4); h.ok(5); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  expect(new Set(h.preparations.map(item => item.playerId)).size).toBe(5); expect(h.preparations.filter(item => item.chats.length).map(item => item.chats)).toEqual([['chat_9']]);
  expect(new Set(h.accepted.map(binding => binding.observationId)).size).toBe(6); expect(h.scheduler.diagnostics().commanders.every(item => item.lastAcceptedAt === 11000)).toBe(true); await h.scheduler.close();
});

it('opens after three failures, honors Retry-After, allows one half-open probe, and recovers', async () => {
  const h = harness(5, 5); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.state.tick = 1000; h.advance(10000); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(5);
  for (let i = 0; i < 5; i++) h.calls[i]!.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '40' } }));
  await expect.poll(() => h.scheduler.diagnostics().failed).toBe(5); expect(h.scheduler.diagnostics()).toMatchObject({ circuit: 'open', active: 0, retryAfterMs: 40000 });
  h.state.tick = 10000; h.advance(31000); await h.scheduler.poll(); expect(h.calls.length).toBe(5);
  h.advance(10000); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(6); expect(h.scheduler.diagnostics()).toMatchObject({ circuit: 'half_open', active: 1 });
  await h.scheduler.poll(); expect(h.calls.length).toBe(6); h.ok(5); await expect.poll(() => h.scheduler.diagnostics().circuit).toBe('closed');
  await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(10); for (let i = 6; i < 10; i++) h.ok(i);
  await expect.poll(() => h.scheduler.diagnostics().active).toBe(0); expect(h.scheduler.diagnostics().completed).toBe(5); await h.scheduler.close();
});

it('discards late paused/old-epoch results and reserves cancelled provider slots until their deadline', async () => {
  const h = harness(1, 1); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.state.status = 'PAUSED'; h.state.matchEpoch++; await h.scheduler.poll(); h.ok(0);
  expect(h.scheduler.diagnostics().commanders).toMatchObject([{pending:false,lastStatus:'MATCH_NOT_RUNNING',lastAcceptedAt:null,requests:{completed:0,failed:0}}]); expect(h.accepted).toHaveLength(0);
  h.state.status = 'RUNNING'; h.state.tick = 10; await h.scheduler.poll(); expect(h.calls).toHaveLength(1); expect(h.scheduler.diagnostics().active).toBe(1);
  h.advance(1001); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2); h.ok(1); await expect.poll(() => h.accepted.length).toBe(1);
  expect(h.accepted[0]!.matchEpoch).toBe(2); await h.scheduler.close();
});

it('does not dispatch unconfigured endpoints and shares capacity with explicit capability probes', async () => {
  const h = harness(1, 1); await h.config.load({}); await h.scheduler.setDriver(h.driver); await h.scheduler.poll(); expect(h.calls).toHaveLength(0); expect(h.scheduler.diagnostics().commanders[0]!.lastStatus).toBe('NOT_CONFIGURED');
  await h.start(); h.state.commanders[0]!.nextStrategicTick = 99999; await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  await expect(h.scheduler.probe(false)).rejects.toMatchObject({ code: 'ENDPOINT_BUSY' }); h.ok(0); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0); await h.scheduler.close();
});

it('suppresses completion callbacks invalidated while the worker acknowledgement is pending', async () => {
  const h=harness(1,1);await h.start();
  let acknowledge:((value:{accepted:boolean;code:string;message:{recipientId:string;text:string;status:'planned'}})=>void)|undefined;
  h.driver.completeAiRequest=async (_binding,result)=>result.kind==='failure'?{accepted:false,code:result.code}:new Promise(resolve=>{acknowledge=resolve;});
  const messages:unknown[]=[];h.scheduler.onMessage=(_playerId,message)=>messages.push(message);
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>Boolean(acknowledge)).toBe(true);
  await h.scheduler.setDriver({...h.driver});
  acknowledge!({accepted:true,code:'PLAN_ACCEPTED',message:{recipientId:'same_slot_in_new_match',text:'Old private strategy',status:'planned'}});
  await expect.poll(()=>h.scheduler.diagnostics().latencyMs.max).toBe(0);
  // Drain the acknowledgement continuation without advancing fake wall time.
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(messages).toEqual([]);expect(h.scheduler.diagnostics()).toMatchObject({completed:0,failed:0});
  expect(h.config.state().capability.status).not.toBe('PLAN_ACCEPTED');await h.scheduler.close();
});

it('releases core request bindings after a transient scheduling-state RPC failure', async () => {
  const h=harness(1,1),prepare=h.driver.prepareAiRequest,complete=h.driver.completeAiRequest;
  let bound=false,failNextRead=false;
  h.driver.prepareAiRequest=async (...args)=>{if(bound)throw new Error('AI_REQUEST_IN_FLIGHT');const value=await prepare(...args);bound=true;return value;};
  h.driver.completeAiRequest=async (...args)=>{bound=false;return complete(...args);};
  h.driver.invalidateAiRequests=async ()=>{bound=false;h.state.commanders[0]!.generation++;};
  h.driver.aiSchedulingState=async ()=>{if(failNextRead){failNextRead=false;throw new Error('WORKER_TIMEOUT');}return structuredClone(h.state);};
  await h.start();await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);expect(bound).toBe(true);
  failNextRead=true;await h.scheduler.poll();expect(bound).toBe(false);h.ok(0);
  await new Promise<void>(resolve=>setImmediate(resolve));expect(h.scheduler.diagnostics().commanders[0]?.lastStatus).toBe('WORKER_UNAVAILABLE');
  h.advance(10001);h.state.tick=400;await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(2);
  h.ok(1);await expect.poll(()=>h.accepted.length).toBe(1);expect(bound).toBe(false);await h.scheduler.close();
});

it('does not infer or credit a trusted chat request that the prompt budget removed', async () => {
  const h=harness(1,1),prepare=h.driver.prepareAiRequest;
  const sample=await prepare('ai_0','sample',[]),base=buildAiPrompt(sample,{inputTokenBudget:32000}).estimatedInputTokens;
  h.driver.prepareAiRequest=async (...args)=>{const dispatch=await prepare(...args);for(const request of dispatch.observation.requests)request.text='請'.repeat(500);return dispatch;};
  await h.start();await h.config.load({AI_BASE_URL:h.settings.baseUrl,AI_MODEL:h.settings.model,AI_MAX_CONCURRENT:'1',AI_TIMEOUT_SECONDS:'1',AI_INPUT_TOKEN_BUDGET:String(base+50),AI_INTERVAL_EASY_SECONDS:'10',AI_INTERVAL_MEDIUM_SECONDS:'10',AI_INTERVAL_HARD_SECONDS:'10'});
  await h.scheduler.poll();await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.scheduler.diagnostics().active).toBe(0);
  for(let index=0;index<3;index++){
    expect(h.scheduler.urgent('ai_0',`unseen_request_${index}`)).toBe(true);await h.scheduler.poll();await expect.poll(()=>h.failures.length).toBe(index+1);
  }
  expect(h.failures).toEqual(Array(3).fill('CHAT_INPUT_BUDGET'));expect(h.scheduler.diagnostics()).toMatchObject({failed:3,consecutiveFailures:0,circuit:'closed'});
  expect(h.config.state().capability.status).toBe('PLAN_ACCEPTED');expect(h.calls).toHaveLength(1);expect(h.accepted).toHaveLength(1);await h.scheduler.close();
});

it('keeps the newest worker when driver replacements overlap a delayed invalidation', async () => {
  const h=harness(1,1);await h.start();let release:(()=>void)|undefined,firstReads=0,secondReads=0;
  h.driver.invalidateAiRequests=async ()=>new Promise<void>(resolve=>{release=resolve;});
  const first:AiDriver={...h.driver,async aiSchedulingState(){firstReads++;return {...h.state,matchId:'first'};},async invalidateAiRequests(){}},second:AiDriver={...h.driver,async aiSchedulingState(){secondReads++;return {...h.state,matchId:'second'};},async invalidateAiRequests(){}};
  const replacing=h.scheduler.setDriver(first);await expect.poll(()=>Boolean(release)).toBe(true);
  await h.scheduler.setDriver(second);release!();await replacing;await h.scheduler.poll();
  expect(firstReads).toBe(0);expect(secondReads).toBe(1);await expect.poll(()=>h.calls.length).toBe(1);h.ok(0);await expect.poll(()=>h.accepted.length).toBe(1);await h.scheduler.close();
});

it('preserves routine model cadence when a cooperation preset changes the controller generation', async () => {
  const h = harness(1, 1); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.ok(0); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  h.state.tick = 3; h.state.commanders[0]!.generation++; await h.scheduler.poll();
  expect(h.calls).toHaveLength(1); expect(h.scheduler.diagnostics().pending).toBe(0);
  h.state.tick = 199; h.advance(9999); await h.scheduler.poll(); expect(h.calls).toHaveLength(1);
  h.state.tick = 200; h.advance(1); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2);
  h.ok(1); await expect.poll(() => h.accepted.length).toBe(2); await h.scheduler.close();
});

it('rejects a provider reflecting its authorization credential before memory, commands or chat receive it', async () => {
  const h = harness(1, 1); await h.start();
  await h.config.load({ AI_BASE_URL: h.settings.baseUrl, AI_MODEL: h.settings.model, AI_API_KEY: 'test-sensitive-"credential', AI_MAX_CONCURRENT: '1' });
  const messages: unknown[] = []; h.scheduler.onMessage = (_id, message) => messages.push(message);
  await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.calls[0]!.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, observationId: h.calls[0]!.observationId, strategy: 'Reflected test-sensitive-"credential', goals: [], message: null }) } }] })));
  await expect.poll(() => h.failures).toEqual(['MODEL_SECRET_REFLECTION']); expect(h.accepted).toHaveLength(0); expect(messages).toEqual([]);
  expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('test-sensitive'); await h.scheduler.close();
});

it.each(['OUTPUT_TRUNCATED', 'INVALID_JSON', 'INVALID_AI_PLAN', 'PLAN_ACCEPTED'] as const)('counts reported completion usage once for %s', async code => {
  const h = harness(1, 1), complete = h.driver.completeAiRequest;
  if (code === 'INVALID_AI_PLAN') h.driver.completeAiRequest = async (binding, result) => result.kind === 'plan' ? { accepted: false, code } : complete(binding, result);
  await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  const content = code === 'OUTPUT_TRUNCATED' || code === 'INVALID_JSON' ? 'private rejected model content' : JSON.stringify({ schemaVersion: 1, observationId: h.calls[0]!.observationId, strategy: 'Test', goals: [], message: null });
  h.calls[0]!.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: code === 'OUTPUT_TRUNCATED' ? 'length' : 'stop', message: { content } }], usage: { prompt_tokens: 125, completion_tokens: 75, total_tokens: 200 }, timings: { prompt_ms: 4, predicted_ms: 9 } })));
  await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({ completed: Number(code === 'PLAN_ACCEPTED'), failed: Number(code !== 'PLAN_ACCEPTED'), promptTokens: 125, completionTokens: 75, prefillMs: 4, generationMs: 9,
    usageTotals: { reportedRequests: 1, missingUsageRequests: 0, promptTokens: 125, completionTokens: 75, totalTokens: 200 } });
  expect(h.accepted).toHaveLength(Number(code === 'PLAN_ACCEPTED')); expect(h.failures).toEqual(code === 'PLAN_ACCEPTED' ? [] : [code]);
  expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('private rejected'); await h.scheduler.close();
});

it('counts partial or absent completion usage as unknown without inventing missing token totals', async () => {
  const h = harness(1, 1); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.calls[0]!.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{' } }], usage: { prompt_tokens: 0, completion_tokens: 512, total_tokens: '512' }, timings: { prompt_ms: 'private', predicted_ms: -1 } })));
  await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({ promptTokens: 0, completionTokens: 512, prefillMs: null, generationMs: null,
    usageTotals: { reportedRequests: 0, missingUsageRequests: 1, promptTokens: 0, completionTokens: 512, totalTokens: 0 } });
  h.state.tick = 1000; h.advance(20000); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2); h.ok(1);
  await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({ promptTokens: null, completionTokens: null,
    usageTotals: { reportedRequests: 0, missingUsageRequests: 2, promptTokens: 0, completionTokens: 512, totalTokens: 0 } });
  await h.scheduler.close();
});

it('excludes HTTP failures and unparseable envelopes from completion usage coverage', async () => {
  const h = harness(1, 1); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.calls[0]!.resolve(new Response(JSON.stringify({ usage: { prompt_tokens: 999, completion_tokens: 999, total_tokens: 1998 }, error: 'private' }), { status: 500 }));
  await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  h.state.tick = 1000; h.advance(20000); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(2);
  h.calls[1]!.resolve(new Response('{invalid outer JSON')); await expect.poll(() => h.scheduler.diagnostics().active).toBe(0);
  expect(h.scheduler.diagnostics()).toMatchObject({ failed: 2, usageTotals: { reportedRequests: 0, missingUsageRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  expect(h.failures).toEqual(['ENDPOINT_FAILURE', 'INVALID_JSON']); expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('private'); await h.scheduler.close();
});

it.each([false, true])('does not credit an invalidated binding with late completion telemetry (rejected=%s)', async rejected => {
  const h = harness(1, 1); await h.start(); await h.scheduler.poll(); await expect.poll(() => h.calls.length).toBe(1);
  h.state.status = 'PAUSED'; await h.scheduler.poll();
  h.calls[0]!.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: rejected ? 'length' : 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 125, completion_tokens: 75, total_tokens: 200 } })));
  await new Promise<void>(resolve=>setImmediate(resolve));expect(h.scheduler.diagnostics().commanders[0]?.lastStatus).toBe('MATCH_NOT_RUNNING');
  expect(h.scheduler.diagnostics()).toMatchObject({ completed: 0, failed: 0, usageTotals: { reportedRequests: 0, missingUsageRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
  expect(h.accepted).toEqual([]); expect(h.failures).toEqual([]); await h.scheduler.close();
});
