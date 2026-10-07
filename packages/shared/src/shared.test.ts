import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { AnySchemaObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { isSafeJson, protect } from './validation-safety.js';
import { validateEndpointDiagnosticsResponse } from './validation.js';
import type { EndpointDiagnosticsResponse } from './types.js';
import { MAX_WORLD_ENTITIES } from './types.js';
import validCommand from '../../../examples/client-command.valid.json';
import validPlan from '../../../examples/ai-plan.valid.json';
import invalidPlan from '../../../examples/ai-plan.invalid-extra-field.json';
import { balance, buildings, canonicalJson, contentHash, parseClientSocketMessage, sha256, TEAM_IDENTITIES, technologies, units, validateAiPlan, validateBootstrap, validateClientCommand, validateConsistentPlayerView, validateContent, validateHostRecoveryResponse, validateJoin, validateLoaded, validateLobbyConfig, validateReady, validateRejoinInviteResponse, validateSessionResponse, validatePlayerView, validatePlayerViewDelta, validateReplayStepResponse, validateServerSocketMessage, validateTeamAssignmentRequest, type PlayerView } from './index.js';

it('admits exactly the catalogue gate replacement spans and rejects duplicate wall references',()=>{
  for(const length of [0,1,2,3,4,5,6,64]){
    const envelope={...validCommand,command:{kind:'replace_wall_with_gate',builderIds:['builder'],wallIds:Array.from({length},(_,index)=>`wall_${index}`),queued:false}};
    expect(validateClientCommand(envelope),`${length} wall references`).toBe(length===3||length===5);
  }
  for(const length of [3,5])expect(validateClientCommand({...validCommand,command:{kind:'replace_wall_with_gate',builderIds:['builder'],wallIds:Array.from({length},()=> 'duplicate_wall'),queued:false}})).toBe(false);
  expect(new Set(Object.values(buildings).filter(definition=>definition.defaultGateMode).map(definition=>definition.wallEquivalentCells))).toEqual(new Set([3,5]));
});

describe('increased aggregate structure capacity',()=>{
  it('retains bounded commands and special caps while permitting tenfold aggregate construction',()=>{
    expect(balance.rules.maxNonWallBuildingsPerPlayer).toBe(800);
    expect(balance.rules.maxWallEquivalentCellsPerPlayer).toBe(1600);
    expect(MAX_WORLD_ENTITIES).toBe(60600);
    expect(balance.rules.maxWallSegmentsPerCommand).toBe(64);
    expect(buildings.grand_citadel.familyCap).toBe(2);
    expect(buildings.ward_spire.maxPerPlayer).toBe(4);
  });
});

describe('host-only application payload diagnostics contract',()=>{
  const fixture=():EndpointDiagnosticsResponse=>({endpoint:{configured:false,mode:'unprobed',status:'UNAVAILABLE'},scheduler:{active:0,pending:0,concurrency:1,circuit:'closed',retryAfterMs:0,consecutiveFailures:0,completed:0,failed:0,latencyMs:{p50:0,p95:0,max:0},queueDelayMs:{p50:0,p95:0,max:0},promptTokens:null,completionTokens:null,prefillMs:null,generationMs:null,commanders:[]},simulation:null,process:{rssMiB:1},transport:{scope:'websocket_application_payload_enqueued',windowMs:10000,clients:[{playerId:'human_one',connections:2,totalBytes:3500,bytesPerSecond:350},{playerId:null,connections:1,totalBytes:120,bytesPerSecond:12}]}});
  it('accepts explicit bounded payload measurements and older diagnostics without the optional field',()=>{
    const value=fixture();expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    delete value.transport;expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    value.transport={scope:'websocket_application_payload_enqueued',windowMs:10000,clients:[]};expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
  });
  it('admits bounded gateway delivery timings but rejects payloads, invalid timings and excess writes',()=>{
    const value=fixture();value.publicationDelivery={scope:'gateway_publication_socket_callbacks',channels:[{channelId:1,playerId:'human_one',offeredViews:2,completedViews:1,offeredSequence:2,completedSequence:1,offerAgeMs:0,lastWriteAgeMs:2,completedAgeMs:300,maxOfferIntervalMs:300,maxCompletedIntervalMs:null,pendingSocketWrites:4,oldestSocketWriteMs:5,lastSocketCallbackMs:3,maxSocketCallbackMs:3,bufferedBytes:1024,lastLongGap:null}]};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [(row:any)=>{row.payload='secret';},(row:any)=>{row.offerAgeMs=-1;},(row:any)=>{row.maxCompletedIntervalMs=Infinity;},(row:any)=>{row.pendingSocketWrites=5;},(row:any)=>{row.offeredSequence=.5;}]){
      const copy=structuredClone(value);change(copy.publicationDelivery!.channels[0]);expect(validateEndpointDiagnosticsResponse(copy)).toBe(false);
    }
    value.publicationDelivery.channels=Array.from({length:129},()=>value.publicationDelivery!.channels[0]!);expect(validateEndpointDiagnosticsResponse(value)).toBe(false);
  });
  it('admits bounded native frame phase diagnostics and300ms reduced-speed intervals without accepting private or arbitrary fields',()=>{
    const value=fixture();value.simulation={tick:12,tickMs:{p50:210,p95:240,p99:280,max:310},callbackMs:{p50:220,p95:245,p99:285,max:315},callbackSamples:100,cycleMs:{p50:240,p95:270,p99:310,max:345},cycleSamples:99,debtMs:0,overrunWarning:false,frame:{frameRevision:2,committedTimeMs:600,authoritativeIntervalMs:300,phases:{total:210,movement:150,navigationPreparation:50,work:10,combat:8}},pacing:{authoritativeIntervalMs:300,policy:'adaptive',speedPercent:10,tickIntervalMs:3000,reductions:9,selfPaced:false,deferredWallMs:0,lastReduction:null}};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [
      (item:any)=>{item.simulation.frame.phases.privateWorld={};},
      (item:any)=>{item.simulation.frame.phases.movement=-1;},
      (item:any)=>{item.simulation.frame.phases.total=Infinity;},
      (item:any)=>{item.simulation.frame.frameRevision=.5;},
      (item:any)=>{item.simulation.frame.authoritativeIntervalMs=200;},
      (item:any)=>{item.simulation.callbackSamples=1201;},
      (item:any)=>{item.simulation.callbackMs.p99=-1;},
      (item:any)=>{item.simulation.cycleSamples=1201;},
      (item:any)=>{item.simulation.cycleSamples=.5;},
      (item:any)=>{item.simulation.cycleMs.p99=-1;},
      (item:any)=>{item.simulation.cycleMs.max=Infinity;},
      (item:any)=>{item.simulation.cycleMs.privateWorld={};},
      (item:any)=>{item.simulation.pacing.tickIntervalMs=3001;},
      (item:any)=>{item.simulation.pacing.tickIntervalMs=50;},
      (item:any)=>{delete item.simulation.pacing.authoritativeIntervalMs;},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
  });
  it('rejects private payload fields, invalid numeric measurements, unbounded rows and ambiguous scope',()=>{
    for(const change of [
      (value:any)=>{value.transport.clients[0].sessionToken='private';},
      (value:any)=>{value.transport.clients[0].payload='private';},
      (value:any)=>{value.transport.clients[0].totalBytes=-1;},
      (value:any)=>{value.transport.clients[0].totalBytes=.5;},
      (value:any)=>{value.transport.clients[0].bytesPerSecond=Infinity;},
      (value:any)=>{value.transport.clients[0].connections=0;},
      (value:any)=>{value.transport.clients[0].playerId='not a public id';},
      (value:any)=>{value.transport.clients=Array.from({length:8},()=>value.transport.clients[0]);},
      (value:any)=>{value.transport.scope='wire_bytes';},
      (value:any)=>{value.transport.windowMs=0;},
    ]){const value=fixture();change(value);expect(validateEndpointDiagnosticsResponse(value)).toBe(false);}
  });
  it('admits only aggregate local-detour evidence and rejects route, neighbor and invalid counter fields',()=>{
    const value=fixture();value.simulation={tick:12,tickMs:{p50:0,p95:0,max:0},debtMs:0,overrunWarning:false,frame:{frameRevision:2,committedTimeMs:600,authoritativeIntervalMs:300,phases:{},localPlanning:{mode:'deferred-v1',waitingForCredit:3,queued:2,inflight:1,ready:0,retry:1,oldestWaitMs:300,prepared:8,admitted:4,used:2,discarded:1}}};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [
      (local:any)=>{local.neighbors=[];},(local:any)=>{local.points=[];},(local:any)=>{local.requestId='private';},
      (local:any)=>{local.queued=2201;},(local:any)=>{local.waitingForCredit=-1;},(local:any)=>{local.used=.5;},
      (local:any)=>{local.oldestWaitMs=Infinity;},(local:any)=>{local.mode='unversioned';},(local:any)=>{delete local.admitted;},
    ]){const invalid=structuredClone(value);change(invalid.simulation!.frame!.localPlanning);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
  });
  it('accepts bounded host compute state and rejects secrets, invalid thread IDs and oversized queues',()=>{
    const value=fixture(),lane={mode:'threads' as const,threadIds:[2,3],pending:2,recoveries:1,degraded:false};
    value.compute={publication:{...lane,threadIds:[4]}};
    value.simulation={tick:8,tickMs:{p50:12,p95:15,max:16},debtMs:0,overrunWarning:false,compute:{planning:lane,vision:{mode:'inline',threadIds:[],pending:0,recoveries:0,degraded:false},boundaryQueued:2}};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    const maximumPlanning=structuredClone(value);
    // Eight compute owners plus their dedicated dispatch service are real
    // distinct threads; the diagnostics contract must report all nine.
    maximumPlanning.simulation!.compute!.planning.threadIds=Array.from({length:9},(_,index)=>index+1);
    expect(validateEndpointDiagnosticsResponse(maximumPlanning)).toBe(true);
    for(const change of [
      (item:any)=>{item.compute.publication.apiKey='private';},
      (item:any)=>{item.simulation.compute.planning.geometry=[];},
      (item:any)=>{item.simulation.compute.planning.threadIds=[-1];},
      (item:any)=>{item.simulation.compute.planning.threadIds=[2,2];},
      (item:any)=>{item.simulation.compute.planning.threadIds=Array.from({length:10},(_,index)=>index+1);},
      (item:any)=>{item.simulation.compute.boundaryQueued=4097;},
      (item:any)=>{item.compute.publication.pending=Infinity;},
      (item:any)=>{item.compute.publication.recoveries=-1;},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
  });
  it('validates bounded production overload history without accepting state or credentials',()=>{
    const value=fixture(),callback={operation:'timer',tick:1,endTick:2,epoch:1,durationMs:51,gapBeforeMs:0,phasesMs:{commandDrain:5,coreStep:40,activityProjection:1,viewAssemblyPost:2,journalCheckpoint:1,other:2}};
    value.simulation={tick:2,tickMs:{p50:40,p95:40,max:40},debtMs:0,overrunWarning:false,runtime:{historyLimit:16,callbackCount:22,boundaryYields:1,recentCallbacks:[callback],lastOverload:{tick:2,epoch:1,debtMs:2001,boundaryQueued:16,pendingCommands:2,precedingCallbacks:[callback],precedingAdvancingCallbacks:[callback]}}};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [
      (item:any)=>{item.simulation.runtime.recentCallbacks=Array(17).fill(callback);},
      (item:any)=>{item.simulation.runtime.lastOverload.precedingAdvancingCallbacks=Array(17).fill(callback);},
      (item:any)=>{item.simulation.runtime.lastOverload.entities=[];},
      (item:any)=>{item.simulation.runtime.recentCallbacks[0].apiKey='private';},
      (item:any)=>{item.simulation.runtime.lastOverload.debtMs=Infinity;},
      (item:any)=>{item.simulation.runtime.recentCallbacks[0].phasesMs.coreStep=-1;},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
  });
  it('validates private pacing evidence and keeps it optional for older diagnostics',()=>{
    const value=fixture();
    value.simulation={tick:20,tickMs:{p50:60,p95:65,max:70},debtMs:10,overrunWarning:false,pacing:{policy:'adaptive',speedPercent:90,tickIntervalMs:50/.9,reductions:1,selfPaced:false,deferredWallMs:0,lastReduction:{tick:19,fromPercent:100,toPercent:90,debtMs:2001}}};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [
      (item:any)=>{item.simulation.pacing.speedPercent=9;},
      (item:any)=>{item.simulation.pacing.speedPercent=101;},
      (item:any)=>{item.simulation.pacing.tickIntervalMs=501;},
      (item:any)=>{item.simulation.pacing.reductions=-1;},
      (item:any)=>{item.simulation.pacing.deferredWallMs=Infinity;},
      (item:any)=>{item.simulation.pacing.selfPaced='true';},
      (item:any)=>{item.simulation.pacing.policy='hide_overload';},
      (item:any)=>{item.simulation.pacing.lastReduction.debtMs=-1;},
      (item:any)=>{item.simulation.pacing.lastReduction.privateState={};},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
    value.simulation.pacing={policy:'pause',speedPercent:100,tickIntervalMs:50,reductions:0,selfPaced:false,deferredWallMs:0,lastReduction:null};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    delete value.simulation.pacing;expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
  });
  it.each([300,450,600] as const)('accepts actual %sms frame diagnostics and keeps legacy cadence bounds strict',interval=>{
    const value=fixture();
    value.simulation={tick:60,tickMs:{p50:150,p95:180,max:220},debtMs:0,overrunWarning:false,
      callbackMs:{p50:170,p95:210,max:250},callbackSamples:10,frame:{frameRevision:10,committedTimeMs:3000,authoritativeIntervalMs:300,phases:{work:25,movement:40,perception:20,total:150}},
      pacing:{authoritativeIntervalMs:300,policy:'adaptive',speedPercent:100,tickIntervalMs:300,reductions:0,selfPaced:false,deferredWallMs:0,lastReduction:null,movementDecisionIntervalMs:300,publicationIntervalMs:300,memoryRecoveryBlocked:false}};
    value.simulation.frame!.authoritativeIntervalMs=interval;
    Object.assign(value.simulation.pacing!,{authoritativeIntervalMs:interval,publicationIntervalMs:interval,movementDecisionIntervalMs:interval,tickIntervalMs:interval});
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    value.simulation.pacing!.speedPercent=10;value.simulation.pacing!.tickIntervalMs=interval*10;value.simulation.pacing!.memoryRecoveryBlocked=true;
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    value.simulation.pacing!.tickIntervalMs=interval*10+1;expect(validateEndpointDiagnosticsResponse(value)).toBe(false);
    value.simulation.pacing!.tickIntervalMs=interval-1;expect(validateEndpointDiagnosticsResponse(value)).toBe(false);
    value.simulation.pacing!.tickIntervalMs=interval*10;
    value.simulation.pacing!.authoritativeIntervalMs=50;expect(validateEndpointDiagnosticsResponse(value)).toBe(false);
  });
  it('validates host renewal estimates with explicit unknowns and bounded commander rows',()=>{
    const value=fixture();value.scheduler.renewal={estimateSource:'joint_queue_to_acceptance',samples:3,warmup:false,commanders:[{playerId:'ai_one',leadMs:4500,remainingPlanTicks:120,estimatedDeadlineFeasible:false,nextDueInMs:2000}]};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    value.scheduler.renewal.commanders[0]={playerId:'ai_one',leadMs:null,remainingPlanTicks:null,estimatedDeadlineFeasible:null,nextDueInMs:2000};
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    const combined=structuredClone(value);combined.scheduler.renewal!.samples=4096;
    combined.scheduler.renewal!.commanders=Array.from({length:11},(_,i)=>({...value.scheduler.renewal!.commanders[0]!,playerId:`commander_${i}`}));
    expect(validateEndpointDiagnosticsResponse(combined)).toBe(true);
    for(const change of [
      (item:any)=>{item.scheduler.renewal.commanders[0].prompt='private';},
      (item:any)=>{item.scheduler.renewal.samples=4097;},
      (item:any)=>{item.scheduler.renewal.commanders=Array(12).fill(item.scheduler.renewal.commanders[0]);},
      (item:any)=>{item.scheduler.renewal.commanders[0].remainingPlanTicks=-1;},
      (item:any)=>{item.scheduler.renewal.commanders[0].nextDueInMs=NaN;},
      (item:any)=>{item.scheduler.renewal.estimateSource='sum_of_percentiles';},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
  });
  it('accepts bounded model failure history and rejects private or malformed entries',()=>{
    const value=fixture();value.scheduler.recentFailures=[];
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    value.scheduler.recentFailures=Array.from({length:16},(_,index)=>({playerId:'ai_one',code:'OUTPUT_TRUNCATED',at:1000+index}));
    expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
    for(const change of [
      (item:any)=>{item.scheduler.recentFailures.push(item.scheduler.recentFailures[0]);},
      (item:any)=>{item.scheduler.recentFailures[0].at=-1;},
      (item:any)=>{item.scheduler.recentFailures[0].at=NaN;},
      (item:any)=>{item.scheduler.recentFailures[0].playerId='private player text';},
      (item:any)=>{item.scheduler.recentFailures[0].code='upstream private response';},
      (item:any)=>{item.scheduler.recentFailures[0].prompt='private';},
      (item:any)=>{item.scheduler.recentFailures[0].apiKey='private';},
    ]){const invalid=structuredClone(value);change(invalid);expect(validateEndpointDiagnosticsResponse(invalid)).toBe(false);}
    delete value.scheduler.recentFailures;expect(validateEndpointDiagnosticsResponse(value)).toBe(true);
  });
});

describe('owned JSON parsing safety',()=>{
  it('matches descriptor capture for parsed JSON, including dangerous keys, overflow and exact depth/node boundaries',()=>{
    const validator=protect(new Ajv2020().compile(true),undefined,128);
    const texts=['null','true','0','-0','1.25','1e308','1e309','-1e309','"constructor"','[]','{}','{"a":[null,true,0,"text",{}]}',
      '{"__proto__":{}}','{"a":{"prototype":0}}','{"a":[{"constructor":null}]}','{"\\u005f_proto__":0}',
      '['.repeat(32)+'0'+']'.repeat(32),'['.repeat(33)+'0'+']'.repeat(33),
      '['+new Array(127).fill('0').join(',')+']','['+new Array(128).fill('0').join(',')+']',
      '{"a":1,"a":2}'];
    for(const text of texts){
      const parsed:unknown=JSON.parse(text),expected=validator.capture(parsed,{enumerableOnly:true});
      expect(validator.parseJson(text,10000),text).toEqual(expected);
    }
    expect(validator.parseJson('['.repeat(32)+'0'+']'.repeat(32),10000)).toBeDefined();
    expect(validator.parseJson('['.repeat(33)+'0'+']'.repeat(33),10000)).toBeUndefined();
    const small=protect(new Ajv2020().compile(true),undefined,3);
    expect(small.parseJson('[0,1]',100)).toEqual([0,1]);expect(small.parseJson('[0,1,2]',100)).toBeUndefined();
    expect(small.parseJson('{"a":0,"b":1}',100)).toEqual({a:0,b:1});expect(small.parseJson('{"a":0,"b":1,"c":2}',100)).toBeUndefined();
  });
  it('bounds UTF-8 before parsing and never coerces non-string objects or runs their hooks',()=>{
    const validator=protect(new Ajv2020().compile(true));let hooks=0;
    const hostile={toString(){hooks++;throw new Error('private');},toJSON(){hooks++;throw new Error('private');}};
    const proxy=new Proxy(hostile,{get(){hooks++;throw new Error('private');}}),revoked=Proxy.revocable({},{});revoked.revoke();
    for(const input of [hostile,proxy,revoked.proxy,new String('0'),null,undefined,0,Symbol('private')])expect(validator.parseJson(input,100)).toBeUndefined();
    expect(hooks).toBe(0);
    expect(validator.parseJson('"\u754c"',5)).toBe('\u754c');expect(validator.parseJson('"\ud83c\udff0"',6)).toBe('\ud83c\udff0');
    const parse=vi.spyOn(JSON,'parse');
    try{
      expect(validator.parseJson('"\u754c"',4)).toBeUndefined();expect(validator.errors?.[0]?.keyword).toBe('maxBytes');
      expect(validator.parseJson(' '.repeat(101),100)).toBeUndefined();expect(parse).not.toHaveBeenCalled();
    }finally{parse.mockRestore();}
    for(const malformed of ['', '{', '[0,]', 'undefined', 'NaN'])expect(validator.parseJson(malformed,100)).toBeUndefined();
  });
  it('uses the same compiled and semantic checks while returning a separately owned tree each time',()=>{
    const compiled=new Ajv2020().compile<{value:number}>({type:'object',required:['value'],additionalProperties:false,properties:{value:{type:'integer',minimum:0}}});
    const validator=protect(compiled,input=>input.value%2===0);
    for(const text of ['{"value":2}','{"value":3}','{"value":-2}','{"value":2,"private":1}','{"value":"2"}']){
      expect(validator.parseJson(text,100)).toEqual(validator.capture(JSON.parse(text),{enumerableOnly:true}));
    }
    const first=validator.parseJson('{"value":2}',100)!;first.value=99;
    expect(validator.parseJson('{"value":2}',100)).toEqual({value:2});
  });
});

describe('AT-03 content integrity', () => {
  it('shares eleven separated immutable color and heraldry identities',()=>{
    expect(TEAM_IDENTITIES).toHaveLength(11);expect(new Set(TEAM_IDENTITIES.map(identity=>identity.color)).size).toBe(11);expect(new Set(TEAM_IDENTITIES.map(identity=>identity.name)).size).toBe(11);expect(Object.isFrozen(TEAM_IDENTITIES)).toBe(true);expect(TEAM_IDENTITIES.every(Object.isFrozen)).toBe(true);
    // This guards against another cluster of near-identical pastel colors. The
    // separate heraldic patterns remain necessary for color-vision accessibility.
    const colors=TEAM_IDENTITIES.map(identity=>[1,3,5].map(offset=>parseInt(identity.color.slice(offset,offset+2),16)));
    for(let i=0;i<colors.length;i++)for(let j=i+1;j<colors.length;j++)expect(Math.hypot(...colors[i]!.map((channel,index)=>channel-colors[j]![index]!))).toBeGreaterThan(80);
  });
  it('loads the full stable catalog and computes browser-compatible SHA256', () => {
    expect(balance.ages).toHaveLength(4);
    expect(balance.units).toHaveLength(11);
    expect(balance.buildings).toHaveLength(20);
    expect(balance.technologies).toHaveLength(29);
    expect(Object.keys(units)).toHaveLength(19);
    expect(Object.keys(buildings)).toHaveLength(35);
    expect(Object.keys(technologies)).toHaveLength(41);
    expect(() => validateContent(balance)).not.toThrow();
    expect(contentHash).toBe(createHash('sha256').update(canonicalJson(balance)).digest('hex'));
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('')).toBe(createHash('sha256').update('').digest('hex'));
    expect(sha256('Frontier 文明')).toBe(createHash('sha256').update('Frontier 文明').digest('hex'));
    expect(canonicalJson({b:2,a:1})).toBe(canonicalJson({a:1,b:2}));
  });
  it.each([
    ['duplicate content IDs', (data:any) => { data.units[1].id = data.units[0].id; }],
    ['duplicate ages', (data:any) => { data.ages[1].id = 1; }],
    ['negative costs', (data:any) => { data.units[0].cost.food = -1; }],
    ['fractional costs', (data:any) => { data.units[0].cost.food = 1.5; }],
    ['nonfinite numbers', (data:any) => { data.rules.simulationHz = Infinity; }],
    ['missing combat acquisition radius', (data:any) => { delete data.rules.combatAcquisitionRadiusM; }],
    ['zero combat acquisition radius', (data:any) => { data.rules.combatAcquisitionRadiusM = 0; }],
    ['unbounded combat acquisition radius', (data:any) => { data.rules.combatAcquisitionRadiusM = 65; }],
    ['missing idle gathering radius', (data:any) => { delete data.rules.idleGatherRadiusM; }],
    ['zero idle gathering radius', (data:any) => { data.rules.idleGatherRadiusM = 0; }],
    ['unbounded idle gathering radius', (data:any) => { data.rules.idleGatherRadiusM = 65; }],
    ['unknown fields', (data:any) => { data.units[0].paidBonus = 3; }],
    ['unknown resources', (data:any) => { data.units[0].cost.mana = 3; }],
    ['missing resource quantities', (data:any) => { delete data.maps.resourceNodes; }],
    ['fractional resource quantities', (data:any) => { data.maps.resourceNodes.starting.wood = 300.5; }],
    ['zero resource quantities', (data:any) => { data.maps.resourceNodes.expansion.food = 0; }],
    ['empty generated resource nodes', (data:any) => { data.maps.spawnResourceMinimum.wood = 0; }],
    ['fractional generated resource yields', (data:any) => { data.maps.resourceNodes.starting.gold = 49; }],
    ['unbounded forest metadata patches', (data:any) => { data.maps.resourceNodes.forestPatchLimit = 300; }],
    ['missing forest belt rules', (data:any) => { delete data.maps.forestBelts; }],
    ['thin forest belts', (data:any) => { data.maps.forestBelts.minimumDepthM = 3; }],
    ['inverted forest belt depths', (data:any) => { data.maps.forestBelts.minimumDepthM = 27; }],
    ['unaligned forest belt depths', (data:any) => { data.maps.forestBelts.targetDepthM = 23; }],
    ['single forest belt opening', (data:any) => { data.maps.forestBelts.minimumOpenings = 1; }],
    ['unbounded forest belt openings', (data:any) => { data.maps.forestBelts.preferredOpenings = 4; }],
    ['resource quantities exceeding the world limit', (data:any) => { data.maps.resourceNodes.starting.wood = 3000; }],
    ['missing producers', (data:any) => { data.units[0].producedAt = 'unlisted'; }],
    ['unreachable producers', (data:any) => { data.buildings[0].minAge = 4; }],
    ['broken production references', (data:any) => { data.buildings[0].produces = ['militia']; }],
    ['unknown prerequisite', (data:any) => { data.technologies[0].prerequisites = ['unlisted']; }],
    ['cyclic prerequisites', (data:any) => { data.technologies[0].prerequisites = ['forestry_2']; }],
    ['unknown modifiers', (data:any) => { data.technologies[0].effects[0].stat = 'freeGold'; }],
    ['unknown modifier target', (data:any) => { data.technologies[0].effects[0].targets = ['unlisted']; }],
    ['ineligible modifier target', (data:any) => { data.technologies[0].effects[0].targets = ['house']; }],
    ['impossible footprint', (data:any) => { data.buildings[0].footprintCells = [0, 3]; }],
    ['broken manifest reference', (data:any) => { data.buildings[0].id = 'unlisted'; }],
    ['impossible age prerequisite', (data:any) => { data.ages[1].prerequisites[0].types = ['monument']; }],
    ['difficulty stat advantage', (data:any) => { data.ai.difficulty.hard.resourceMultiplier = 2; }],
    ['difficulty fog advantage', (data:any) => { data.ai.difficulty.hard.omniscient = true; }],
  ])('rejects %s', (_name, mutate) => {
    const data = structuredClone(balance); mutate(data);
    expect(() => validateContent(data)).toThrow();
  });
});

describe('M5 host-only recovery and lobby contracts',()=>{
  it('validates bounded save summaries, truthful warnings and ephemeral rejoin responses',()=>{
    const save={id:'manual_1790000000000_abcdef0123456789',kind:'manual',label:'Evening campaign',createdAt:'2026-09-19T10:00:00.000Z',tick:1200,bytes:50000};
    const response={saves:[save],warnings:[{id:save.id,code:'SAVE_CORRUPT'}],persistence:{lastSave:save,journalHealthy:false,lastError:'SAVE_WRITE_FAILED'},disconnected:[{playerId:'p1',seconds:181,decisionRequired:true,mode:'caretaker'}],restoreSlots:[{playerId:'p1',name:'Player',hostPlayer:false,claimed:false}],pauseRequests:[{playerId:'p1',timestamp:1790000000000}]};
    expect(validateHostRecoveryResponse(response)).toBe(true);expect(validateHostRecoveryResponse({...response,saves:[{...save,path:'private/save.json'}]})).toBe(false);expect(validateHostRecoveryResponse({...response,saves:[{...save,bytes:-1}]})).toBe(false);expect(validateHostRecoveryResponse({...response,restoreSlots:[{...response.restoreSlots[0],token:'secret'}]})).toBe(false);
    const invite={playerId:'p1',token:'a'.repeat(43),expiresAt:1790000000000};expect(validateRejoinInviteResponse(invite)).toBe(true);expect(validateRejoinInviteResponse({...invite,token:'short'})).toBe(false);expect(validateRejoinInviteResponse({...invite,host:true})).toBe(false);
  });
  it('keeps public lobby choices finite without placing the host seed in ordinary settings',()=>{
    expect(validateLobbyConfig({mapSize:'large',startingResourcePreset:'standard',pauseWhenNoHumans:true,teamPreset:'six_vs_five',caretakerEnabled:true})).toBe(true);
    for(const invalid of [{mapSize:'infinite'},{startingResourcePreset:'rich'},{hostSeed:'private'},{teamPreset:'omniscient'},{pauseWhenNoHumans:'yes'}])expect(validateLobbyConfig(invalid)).toBe(false);
  });
});

describe('AT-37 schema admission', () => {
  it('loads and validates in a browser bundle with runtime code generation disabled', async () => {
    const bundled=await build({stdin:{contents:`import { validateClientCommand, balance, contentHash, effectiveUnit, effectiveGatherRates } from './packages/shared/src/index.ts'; if (!validateClientCommand(${JSON.stringify(validCommand)})) throw new Error('Invalid example'); if (effectiveUnit('villager',['wheelbarrow','hand_cart']).carryCapacity !== 25 || effectiveGatherRates(['forestry_1','forestry_2','forestry_3']).wood !== .9425) throw new Error('Invalid modifiers'); globalThis.contractCheck = [balance.units.length, contentHash];`,resolveDir:process.cwd()},bundle:true,format:'iife',platform:'browser',write:false});
    const sandbox:Record<string,unknown>={TextEncoder,structuredClone};
    runInNewContext(bundled.outputFiles[0]!.text,sandbox,{contextCodeGeneration:{strings:false,wasm:false}});
    expect(sandbox.contractCheck).toEqual([11,contentHash]);
  });
  it('accepts supplied command and AI examples and rejects the supplied extra field', () => {
    expect(validateClientCommand(validCommand)).toBe(true);
    expect(validateAiPlan(validPlan)).toBe(true);
    expect(validateAiPlan(invalidPlan)).toBe(false);
  });
  it.each([
    ['unknown envelope field', (data:any) => { data.resources = 10000; }],
    ['unknown nested field', (data:any) => { data.command.target.yMm = 0; }],
    ['negative coordinates', (data:any) => { data.command.target.xMm = -1; }],
    ['nonfinite coordinates', (data:any) => { data.command.target.xMm = NaN; }],
    ['fractional coordinates', (data:any) => { data.command.target.xMm = 0.5; }],
    ['string coordinates', (data:any) => { data.command.target.xMm = '42'; }],
    ['duplicate units', (data:any) => { data.command.unitIds = ['same','same']; }],
    ['unbounded selections', (data:any) => { data.command.unitIds = Array.from({length:201},(_,i)=>`u-${i}`); }],
    ['unsafe sequence', (data:any) => { data.clientSequence = 9007199254740992; }],
    ['obsolete protocol', (data:any) => { data.protocolVersion = 1; }],
    ['unknown protocol', (data:any) => { data.protocolVersion = 3; }],
    ['negative train count', (data:any) => { data.command = {kind:'train',buildingId:'b1',unitType:'militia',quantity:-1}; }],
    ['wall overlimit', (data:any) => { data.command = {kind:'build_wall',builderIds:['u1'],material:'palisade',cells:Array.from({length:65},(_,x)=>({x,z:1})),queued:false}; }],
  ])('rejects %s before mutation', (_name, mutate) => {
    const data = structuredClone(validCommand); mutate(data);
    const before = structuredClone(data);
    expect(validateClientCommand(data)).toBe(false);
    expect(data).toEqual(before);
  });
  it('rejects prototype keys, custom prototypes, accessors, deep and oversized input', () => {
    expect(validateClientCommand(JSON.parse('{"__proto__":{}}'))).toBe(false);
    expect(validateClientCommand(Object.create(validCommand))).toBe(false);
    const accessor = { get command() { throw new Error('must not evaluate'); } };
    expect(validateClientCommand(accessor)).toBe(false);
    const deep:any = {}; let next=deep; for(let i=0;i<40;i++) {next.value={};next=next.value;}
    expect(validateClientCommand(deep)).toBe(false);
    expect(parseClientSocketMessage(' '.repeat(16385))).toBeUndefined();
    expect(parseClientSocketMessage('{invalid')).toBeUndefined();
    expect(parseClientSocketMessage(JSON.stringify(validCommand))).toEqual(validCommand);
  });
  it('checks nonenumerable data and exact nested budgets without executing accessors',()=>{
    const value=Object.create(null) as Record<string,unknown>;value.public={items:[1,2]};Object.defineProperty(value,'private',{value:true,enumerable:false});
    expect(isSafeJson(value,0,{remaining:6})).toBe(true);expect(isSafeJson(value,0,{remaining:5})).toBe(false);
    for(const key of ['__proto__','prototype','constructor']){const dangerous={};Object.defineProperty(dangerous,key,{value:0,enumerable:false});expect(isSafeJson(dangerous)).toBe(false);}
    for(const child of [NaN,Infinity,undefined,()=>0]){const invalid={};Object.defineProperty(invalid,'hidden',{value:child,enumerable:false});expect(isSafeJson(invalid)).toBe(false);}
    let getterCalls=0;const accessor={};Object.defineProperty(accessor,'hidden',{get(){getterCalls++;return 1;},enumerable:false});expect(isSafeJson(accessor)).toBe(false);
    const array=[1,2];Object.defineProperty(array,1,{get(){getterCalls++;return 2;},enumerable:true});expect(isSafeJson(array)).toBe(false);expect(getterCalls).toBe(0);
    expect(isSafeJson([,2])).toBe(false);expect(isSafeJson(Object.assign([1,2],{extra:3}))).toBe(false);
    let deep:unknown=null;for(let i=0;i<32;i++)deep={nested:deep};expect(isSafeJson(deep)).toBe(true);expect(isSafeJson({nested:deep})).toBe(false);
  });
  it('uses the same safety budget and schema semantics for detached capture',()=>{
    const compiled=Object.assign((value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null,{errors:null}) as ValidateFunction<Record<string,unknown>>;
    const value=Object.create(null) as Record<string,unknown>;value.public={items:[1,2]};Object.defineProperty(value,'private',{value:true,enumerable:false});Object.assign(value,{[Symbol('ignored JSON symbol')]:()=>0});
    const capture=protect(compiled,undefined,6),copy=capture.capture(value)!;expect(copy).not.toBe(value);expect(copy.public).not.toBe(value.public);expect(Object.getPrototypeOf(copy)).toBe(null);expect(Object.getOwnPropertyDescriptor(copy,'private')).toMatchObject({value:true,enumerable:false});expect(Object.getOwnPropertySymbols(copy)).toEqual([]);
    expect(protect(compiled,undefined,5).capture(value)).toBeUndefined();expect(capture(value)).toBe(true);
    const plan=structuredClone(validPlan),captured=validateAiPlan.capture(plan);expect(captured).toEqual(plan);plan.strategy='later caller mutation';expect(captured!.strategy).not.toBe(plan.strategy);
    const invalid={...structuredClone(validPlan),goals:[{kind:'economy',weights:{food:39,wood:30,gold:20,stone:10},targetVillagers:36}]};expect(validateAiPlan(invalid)).toBe(false);expect(validateAiPlan.capture(invalid)).toBeUndefined();
  });
  it('validates strict HTTP and control socket contracts', () => {
    expect(validateBootstrap({token:'abc-123'})).toBe(true);
    expect(validateJoin({name:'Player',inviteCode:'abcdef'})).toBe(true);
    expect(validateJoin({name:' ',inviteCode:'abcdef'})).toBe(false);
    expect(validateReady({ready:true})).toBe(true);
    expect(validateReady({ready:1})).toBe(false);
    expect(validateLobbyConfig({aiCount:5})).toBe(true);
    expect(validateLobbyConfig({aiCount:6})).toBe(false);
    expect(validateLobbyConfig({seed:'secret'})).toBe(false);
    expect(validateLoaded({contentHash,matchId:'match',matchEpoch:1})).toBe(true);
    expect(parseClientSocketMessage('{"type":"resync"}')).toEqual({type:'resync'});
    expect(parseClientSocketMessage('{"type":"resync","playerId":"enemy"}')).toBeUndefined();
  });
  it('requires meaningful economy weights', () => {
    const plan=structuredClone(validPlan) as any; plan.goals[0].weights.food=0;
    expect(validateAiPlan(plan)).toBe(false);
  });
  it('validates exact team assignment requests without accepting authority or match fields',()=>{
    expect(validateTeamAssignmentRequest({playerId:'p1',teamId:'team1'})).toBe(true);
    for(const request of [{playerId:'p1'},{playerId:'p1',teamId:''},{playerId:'p1',teamId:'team1',host:true},{playerId:'p1',teamId:'team1',matchId:'other'},JSON.parse('{"playerId":"p1","teamId":"team1","__proto__":{}}')])expect(validateTeamAssignmentRequest(request)).toBe(false);
  });
  it('decodes session/lobby responses with exact fields', () => {
    const session = {protocolVersion:2,contentHash,csrfToken:'',host:false,lobby:{status:'SETUP',players:[],settings:{aiCount:1,mapType:'open_frontier',populationLimit:120,sharedVision:true},canStart:false}};
    expect(validateSessionResponse(session)).toBe(true);
    expect(validateSessionResponse({...session,endpointApiKey:'not-a-real-secret'})).toBe(false);
    expect(validateSessionResponse({...session,lobby:{...session.lobby,seed:'private'}})).toBe(false);
    expect(validateServerSocketMessage({type:'lobby',lobby:session.lobby})).toBe(true);
    expect(validateServerSocketMessage({type:'lobby',lobby:{...session.lobby,players:[{id:'ai1',name:'Alder',teamId:'team1',color:'#aabbcc',kind:'ai',hostPlayer:false,ready:true,connected:true,difficulty:'easy',personality:'builder'}]}})).toBe(true);
  });
  it('decodes bounded maximum map fog while rejecting unknown snapshot fields', () => {
    const view:PlayerView={protocolVersion:2,contentHash,matchId:'test',matchEpoch:1,tick:0,sequence:0,playerId:'p1',status:'RUNNING',map:{widthMm:640000,heightMm:640000,fogCellMm:2000},self:{lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:1,population:0,populationCap:15,populationLimit:120,reservedPopulation:0},players:[],entities:[],fog:{visible:[],explored:Array.from({length:102400},(_,i)=>i)}};
    expect(validatePlayerView(view)).toBe(true);
    for(const populationLimit of [80,120,200])expect(validatePlayerView({...view,self:{...view.self,populationLimit}})).toBe(true);
    for(const populationLimit of [0,79,81,121,201,'120',null])expect(validatePlayerView({...view,self:{...view.self,populationLimit}})).toBe(false);
    const {populationLimit:_populationLimit,...missingLimit}=view.self;expect(validatePlayerView({...view,self:missingLimit})).toBe(false);
    expect(validateServerSocketMessage({type:'snapshot',view})).toBe(true);
    expect(validatePlayerView({...view,worldSeed:'hidden'})).toBe(false);
    expect(validatePlayerView({...view,self:{...view.self,resources:{...view.self.resources,food:-1}}})).toBe(false);
    expect(validatePlayerView({...view,entities:[{id:'u1',kind:'unit',typeId:'villager',ownerId:'p1',xMm:1,zMm:2,hp:35,maxHp:35,pathToHiddenEnemy:[1,2]}]})).toBe(false);
  });
  it('decodes bounded M2 public terrain and economy details without private generation or worker records',()=>{
    const view:PlayerView={protocolVersion:2,contentHash,matchId:'test',matchEpoch:1,tick:10,sequence:10,playerId:'p1',status:'RUNNING',map:{widthMm:384000,heightMm:384000,fogCellMm:2000,type:'river_divide',generatorVersion:'2.0.0',terrain:[{id:'ramp',kind:'ramp',xMm:12000,zMm:12000,widthMm:12000,depthMm:18000,axis:'z',startElevationMm:6000,endElevationMm:0}]},self:{lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:1,population:7,populationCap:15,populationLimit:120,reservedPopulation:0,autoReseed:true,idleWorkers:1,incomePerMinute:{food:0,wood:0,gold:0,stone:0},notifications:[{id:'note1',tick:10,code:'FARM_EXHAUSTED',entityId:'farm1'}],recentLedger:[{tick:10,reason:'BUILD',resource:'wood',deltaMilli:-60000,balanceMilli:0,entityId:'farm1'}]},players:[],entities:[{id:'farm1',kind:'building',typeId:'farm',ownerId:'p1',xMm:20000,zMm:20000,hp:300,maxHp:300,resource:'food',amount:350,farmState:'ready',farmerAssigned:true},{id:'worker1',kind:'unit',typeId:'villager',ownerId:'p1',xMm:22000,zMm:22000,hp:35,maxHp:35,taskState:'gathering',queuedOrderCount:2}],fog:{visible:[],explored:[]}};
    expect(validatePlayerView(view)).toBe(true);
    expect(validateServerSocketMessage({type:'receipt',receipt:{status:'rejected',clientCommandId:'c1',tick:10,sequence:3,code:'INSUFFICIENT_RESOURCES',missingResources:{food:0,wood:10,gold:0,stone:0}}})).toBe(true);
    const ridge={id:'public_ridge',kind:'ridge',xMm:96000,zMm:96000,widthMm:48000,depthMm:64000,elevationMm:18000};
    expect(validatePlayerView({...view,map:{...view.map,generatorVersion:'5.0.0',terrain:[ridge]}})).toBe(true);
    expect(validatePlayerView({...view,map:{...view.map,terrain:[{...ridge,privateSpawnId:'enemy'}]}})).toBe(false);
    expect(validatePlayerView({...view,map:{...view.map,broadRoutes:{verifiedPairs:1}}})).toBe(false);
    expect(validatePlayerView({...view,map:{...view.map,seed:'secret'}})).toBe(false);
    expect(validatePlayerView({...view,map:{...view.map,spawns:[]}})).toBe(false);
    expect(validatePlayerView({...view,map:{...view.map,terrain:[{...view.map.terrain![0],endElevationMm:Infinity}]}})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[0],farmerId:'hiddenWorker'}]})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[1],queuedOrderCount:17}]})).toBe(false);
  });
  it('decodes M3 visible combat and final results without projectile tracking secrets',()=>{
    const zero={food:0,wood:0,gold:0,stone:0};
    const view:PlayerView={protocolVersion:2,contentHash,matchId:'combat',matchEpoch:1,tick:30,sequence:30,playerId:'p1',status:'FINISHED',map:{widthMm:384000,heightMm:384000,fogCellMm:2000},self:{lastCommandSequence:0,resources:zero,age:4,population:0,populationCap:15,populationLimit:120,reservedPopulation:0},players:[],entities:[{id:'treb',kind:'unit',typeId:'trebuchet',ownerId:'p1',xMm:10000,zMm:10000,hp:180,maxHp:180,deploymentState:'deploying',deploymentProgress:.5,garrisonedIn:'castle'}],fog:{visible:[],explored:[]},projectiles:[{id:'arrow1',kind:'arrow',xMm:11000,zMm:10000,yMm:2500}],effects:[{id:'impact1',tick:30,kind:'impact',projectileKind:'arrow',xMm:12000,zMm:10000}],monuments:[{id:'monument1',ownerId:'p2',xMm:200000,zMm:200000,remainingTicks:300}],result:{winnerTeamId:'team1',reason:'conquest',durationTicks:30,statistics:[{playerId:'p1',collected:zero,spent:zero,lostCargo:zero,unitsTrained:0,unitsLost:0,buildingsBuilt:0,buildingsLost:0,ageTicks:{'1':0,'2':5,'3':10,'4':20},fallbackTicks:30,modelReadyTicks:0,inferenceFailures:0}]}};
    expect(validatePlayerView(view)).toBe(true);
    expect(validateLobbyConfig({monumentVictory:true})).toBe(true);expect(validateLobbyConfig({monumentVictory:'yes'})).toBe(false);
    for(const field of ['targetId','ownerId','aimXmm','targetPosition'])expect(validatePlayerView({...view,projectiles:[{...view.projectiles![0],[field]:'hidden'}]})).toBe(false);
    expect(validatePlayerView({...view,monuments:[{...view.monuments![0],hp:1000}]})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[0],deploymentProgress:1.01}]})).toBe(false);
    expect(validatePlayerView({...view,result:{...view.result,statistics:[{...view.result!.statistics![0],unitsLost:-1}]}})).toBe(false);
    expect(validatePlayerView({...view,result:{...view.result,statistics:[{...view.result!.statistics![0],ageTicks:{'5':21,'8':30}}]}})).toBe(true);
    expect(validatePlayerView({...view,result:{...view.result,statistics:[{...view.result!.statistics![0],ageTicks:{'9':31}}]}})).toBe(false);
  });
  it('decodes M4 typed queues, own technologies, public ages and observed visual variants strictly',()=>{
    const view:PlayerView={protocolVersion:2,contentHash,matchId:'ages',matchEpoch:1,tick:30,sequence:30,playerId:'p1',status:'RUNNING',map:{widthMm:384000,heightMm:384000,fogCellMm:2000},self:{lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:2,population:7,populationCap:15,populationLimit:120,reservedPopulation:1,technologies:['wheelbarrow']},players:[{id:'p2',name:'Opponent',teamId:'other',kind:'human',color:'#aabbcc',age:4}],entities:[{id:'tc',kind:'building',typeId:'town_center',ownerId:'p1',xMm:20000,zMm:20000,hp:2400,maxHp:2400,visualAge:2,queue:[{id:'train',kind:'train',typeId:'villager',progress:.1,state:'active',started:true},{id:'research',kind:'research',typeId:'hand_cart',progress:0,state:'waiting',started:false},{id:'age',kind:'age',typeId:'age_3',progress:0,state:'prerequisite_blocked',started:false,blockedReason:'AGE_PREREQUISITES_MISSING'}]},{id:'ghost',kind:'building',typeId:'barracks',ownerId:'p2',xMm:200000,zMm:200000,hp:1400,maxHp:1400,visualAge:2,ghost:true,lastSeenTick:10},{id:'soldier',kind:'unit',typeId:'militia',ownerId:'p1',xMm:30000,zMm:20000,hp:65,maxHp:70,visualAge:2,visualTier:'veteran'}],fog:{visible:[],explored:[]},ageAnnouncements:[{playerId:'p2',age:4,tick:20}]};
    expect(validatePlayerView(view)).toBe(true);expect(validateServerSocketMessage({type:'snapshot',view})).toBe(true);
    const invalidJobs=[{id:'bad',typeId:'villager',progress:0,state:'waiting'},{id:'bad',kind:'train',typeId:'masonry',progress:0,state:'waiting'},{id:'bad',kind:'research',typeId:'villager',progress:0,state:'waiting'},{id:'bad',kind:'age',typeId:'age_1',progress:0,state:'waiting'},{id:'bad',kind:'age',typeId:'age_3',progress:0,state:'prerequisite_blocked'}];
    for(const job of invalidJobs)expect(validatePlayerView({...view,entities:[{...view.entities[0],queue:[job]}]})).toBe(false);
    for(const job of [{...view.entities[0]!.queue![0],state:'prerequisite_blocked',blockedReason:'PREREQUISITES_REQUIRED'},{...view.entities[0]!.queue![1],state:'population_blocked'},{...view.entities[0]!.queue![2],state:'exit_blocked'}])expect(validatePlayerView({...view,entities:[{...view.entities[0],queue:[job]}]})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[0],queue:[{...view.entities[0]!.queue![1],state:'prerequisite_blocked',blockedReason:'PREREQUISITES_REQUIRED'}]}]})).toBe(true);
    for(const technologies of [['unknown'],['wheelbarrow','wheelbarrow']])expect(validatePlayerView({...view,self:{...view.self,technologies}})).toBe(false);
    expect(validatePlayerView({...view,players:[{...view.players[0],technologies:['masonry']}]})).toBe(false);
    for(const age of [5,6,7,8])expect(validatePlayerView({...view,players:[{...view.players[0],age}]})).toBe(true);
    expect(validatePlayerView({...view,players:[{...view.players[0],age:9}]})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[1],visualAge:0}]})).toBe(false);
    expect(validatePlayerView({...view,entities:[{...view.entities[2],visualTier:'legendary'}]})).toBe(false);
    expect(validatePlayerView({...view,ageAnnouncements:[{playerId:'p2',age:1,tick:20}]})).toBe(false);
    expect(validatePlayerView({...view,ageAnnouncements:Array.from({length:77},()=>view.ageAnnouncements![0])})).toBe(true);
    expect(validatePlayerView({...view,ageAnnouncements:Array.from({length:78},()=>view.ageAnnouncements![0])})).toBe(false);
    expect(validatePlayerView({...view,ageAnnouncements:[{...view.ageAnnouncements![0],researchQueue:['masonry']}]})).toBe(false);
  });
});


describe('equivalent snapshot schema compilation',()=>{
  let source:typeof import('./validation-compiler.js');
  let legacyOwner:ReturnType<typeof protect>,optimizedOwner:ReturnType<typeof protect>;
  let legacyAction:ReturnType<typeof protect>,optimizedAction:ReturnType<typeof protect>;
  const generated={validatePlayerView,validatePlayerViewDelta,validateServerSocketMessage,validateReplayStepResponse};
  type Boundary=keyof typeof generated;
  const unfactored={} as Record<Boundary,ReturnType<typeof protect>>;
  let unfactoredViewCodeLength=0;
  const unit=(ownerId:unknown='p1')=>({id:'worker',kind:'unit',typeId:'villager',ownerId,xMm:1000,zMm:1000,hp:35,maxHp:35});
  const packet=(entity:unknown)=>({protocolVersion:2,contentHash,matchId:'schema-equivalence',matchEpoch:1,tick:10,sequence:10,playerId:'p1',status:'RUNNING',map:{widthMm:32000,heightMm:32000,fogCellMm:2000},self:{lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:1,population:1,populationCap:15,populationLimit:120,reservedPopulation:0},players:[],entities:[entity],fog:{visible:[],explored:[]}});
  beforeAll(async()=>{
    source=await import('./validation-compiler.js');
    const baseline=new Ajv2020({strict:true,allErrors:false,ownProperties:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
    // The previous nullable representation is independent of the new union type.
    legacyOwner=protect(baseline.compile({anyOf:[{type:'string',minLength:1,maxLength:96,pattern:'^[A-Za-z0-9_-]+$'},{type:'null'}]}));
    optimizedOwner=protect(source.ajv.compile(source.saveSchemaFragments.entity.properties.ownerId as import('ajv').AnySchema));
    // Keep every old branch constraint, without the new dispatch annotation/type.
    legacyAction=protect(baseline.compile({oneOf:structuredClone(source.saveSchemaFragments.visualAction.oneOf)}));
    optimizedAction=protect(source.ajv.compile(source.saveSchemaFragments.visualAction));
    const originalCompiler=new Ajv2020({strict:true,allErrors:false,discriminator:true,ownProperties:true,coerceTypes:false,useDefaults:false,removeAdditional:false});
    // Restore the former embedded entity/fog at each view boundary, independently of the private ref graph.
    const embed=(schema:unknown):unknown=>{
      if(Array.isArray(schema))return schema.map(embed);
      if(!schema||typeof schema!=='object')return schema;
      const value=schema as Record<string,unknown>;
      if(value.$ref==='urn:frontier:private-view:entity:v1')return structuredClone(source.saveSchemaFragments.entity);
      if(value.$ref==='urn:frontier:private-view:fog:v1')return {type:'object',additionalProperties:false,properties:{visible:{type:'array',items:{type:'integer',minimum:0,maximum:102399},maxItems:102400},explored:{type:'array',items:{type:'integer',minimum:0,maximum:102399},maxItems:102400}},required:['visible','explored']};
      return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,embed(child)]));
    };
    for(const name of Object.keys(generated) as Boundary[]){
      const schema=embed(source.ajv.getSchema(`urn:frontier:compiled:${name}`)!.schema) as AnySchemaObject;
      delete schema.$id;
      const compiled=originalCompiler.compile(schema);
      if(name==='validatePlayerView')unfactoredViewCodeLength=compiled.toString().length;
      unfactored[name]=protect(compiled,undefined,1000000);
    }
  });
  const assertPacket=(entity:unknown,expected:boolean)=>{
    const view=packet(entity);
    expect(unfactored.validatePlayerView(view)).toBe(expected);
    expect(source.validatePlayerView(view)).toBe(expected);
    expect(validatePlayerView(view)).toBe(expected);
    expect(validateServerSocketMessage({type:'snapshot',view})).toBe(expected);
  };
  const assertAction=(action:unknown,expected:boolean)=>{
    expect(legacyAction(action)).toBe(expected);
    expect(optimizedAction(action)).toBe(expected);
    assertPacket({...unit(),visualAction:action},expected);
  };
  it('preserves nullable owner IDs, required presence, exact lengths and token syntax',()=>{
    for(const owner of [null,'p1','A_9-x','a'.repeat(96)]){
      expect(legacyOwner(owner)).toBe(true);expect(optimizedOwner(owner)).toBe(true);assertPacket(unit(owner),true);
    }
    for(const owner of ['', 'a'.repeat(97), 'has space', 'line\nbreak', '\u4e2d',0,false,{},[],undefined,NaN,Infinity]){
      expect(legacyOwner(owner)).toBe(false);expect(optimizedOwner(owner)).toBe(false);
      assertPacket({...unit(),ownerId:owner},false);
    }
    const {ownerId:_ownerId,...missing}=unit();assertPacket(missing,false);
  });
  it('accepts every action tag with unchanged integer and optional-facing boundaries',()=>{
    for(const startedTick of [0,Number.MAX_SAFE_INTEGER]){
      for(const kind of ['idle','move','carry'])assertAction({kind,startedTick},true);
      for(const kind of ['gather_food','gather_wood','mine','build','repair']){
        assertAction({kind,startedTick},true);
        for(const facingMilliRad of [-3142,0,3142])assertAction({kind,startedTick,facingMilliRad},true);
      }
      for(const durationTicks of [1,1200]){
        assertAction({kind:'attack',startedTick,durationTicks},true);
        for(const facingMilliRad of [-3142,0,3142])assertAction({kind:'attack',startedTick,durationTicks,facingMilliRad},true);
      }
    }
  });
  it('rejects missing, nonstring or unknown tags and every invalid branch field',()=>{
    for(const action of [null,[],true,1,'idle',{}, {kind:'invented',startedTick:0},{kind:null,startedTick:0},{kind:1,startedTick:0}])assertAction(action,false);
    const kinds=['idle','move','carry','gather_food','gather_wood','mine','build','repair','attack'];
    for(const kind of kinds){
      const valid={kind,startedTick:0,...(kind==='attack'?{durationTicks:1}:{})};
      const {startedTick:_tick,...missingTick}=valid;assertAction(missingTick,false);
      const {kind:_kind,...missingKind}=valid;assertAction(missingKind,false);
      for(const startedTick of [-1,.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'0',null])assertAction({...valid,startedTick},false);
      for(const field of ['targetId','sourceId','reasoning','hiddenPosition'])assertAction({...valid,[field]:'private'},false);
      if(['idle','move','carry'].includes(kind)){
        assertAction({...valid,facingMilliRad:0},false);assertAction({...valid,durationTicks:1},false);
      }else{
        for(const facingMilliRad of [-3143,3143,.5,NaN,Infinity,'0',null])assertAction({...valid,facingMilliRad},false);
        if(kind!=='attack')assertAction({...valid,durationTicks:1},false);
      }
    }
    for(const durationTicks of [undefined,0,1201,.5,NaN,Infinity,'1',null])assertAction({kind:'attack',startedTick:0,durationTicks},false);
  });
  it('retains accessor/prototype rejection and detached capture around optimized checks',()=>{
    let calls=0;
    const accessor={startedTick:0};Object.defineProperty(accessor,'kind',{enumerable:true,get(){calls++;return 'idle';}});
    for(const action of [accessor,Object.create({kind:'idle',startedTick:0}),JSON.parse('{"kind":"idle","startedTick":0,"__proto__":{}}')])assertAction(action,false);
    const entity=unit();Object.defineProperty(entity,'ownerId',{enumerable:true,get(){calls++;return 'p1';}});assertPacket(entity,false);
    expect(calls).toBe(0);
    const value=packet({...unit(),visualAction:{kind:'build',startedTick:2,facingMilliRad:3142}});
    const copy=source.validatePlayerView.capture(value,{enumerableOnly:true})!;
    expect(copy).toEqual(value);expect(copy.entities[0]).not.toBe(value.entities[0]);
    (value.entities[0] as {visualAction:{facingMilliRad:number}}).visualAction.facingMilliRad=-3142;
    expect(copy.entities[0]!.visualAction!.facingMilliRad).toBe(3142);
  });
  it('keeps foreign private fields outside consistent recipient snapshots',()=>{
    const foreign={...unit('p2'),visualAction:{kind:'attack',startedTick:10,durationTicks:20}};
    expect(validateConsistentPlayerView(packet(foreign))).toBe(true);
    expect(validateConsistentPlayerView(packet({...foreign,queue:[]}))).toBe(false);
    assertPacket({...foreign,visualAction:{...foreign.visualAction,targetId:'hidden'}},false);
  });
  it('uses the discriminator-enabled compiler for save and journal fragments too',async()=>{
    expect(source.ajv.opts.discriminator).toBe(true);expect(source.ajv.opts.ownProperties).toBe(true);
    const save=await import('../../simulation/src/save-schema.js');
    expect(save.validateSimulationSavePayload({})).toBe(false);
    expect(save.validateJournalEvent({})).toBe(false);
  });
  it('shares compiled entity/action functions while leaving raw save fragments self-contained',()=>{
    expect(source.ajv.opts.inlineRefs).toBe(true);
    const view=source.ajv.getSchema('urn:frontier:compiled:validatePlayerView')!;
    const entity=source.ajv.getSchema('urn:frontier:private-view:entity:v1')!;
    const action=source.ajv.getSchema('urn:frontier:private-view:action:v1')!;
    expect(view.source!.validateCode).toContain(`${entity.source!.validateName}(`);
    expect(entity.source!.validateCode).toContain(`${action.source!.validateName}(`);
    expect(view.source!.validateCode.length).toBeLessThan(unfactoredViewCodeLength);
    expect(source.saveSchemaFragments.entity.properties.visualAction).toBe(source.saveSchemaFragments.visualAction);
    expect(JSON.stringify(source.saveSchemaFragments)).not.toContain('urn:frontier:private-view:');
  });
  it('shares a small fog validator while keeping all cell checks inline and the unfactored acceptance rules',()=>{
    const view=source.ajv.getSchema('urn:frontier:compiled:validatePlayerView')!,fog=source.ajv.getSchema('urn:frontier:private-view:fog:v1')!,cell=source.ajv.getSchema('urn:frontier:private-view:fog-cell:v1')!;
    expect(source.ajv.opts.inlineRefs).toBe(true);
    expect(view.source!.validateCode).toContain(`${fog.source!.validateName}(`);
    expect(fog.source!.validateCode).not.toContain(`${cell.source!.validateName}(`);
    expect(fog.source!.validateCode.length).toBeLessThan(10000);
    const dense=Array.from({length:102400},(_,index)=>index);
    const cases:[unknown,boolean][]=[
      [{visible:[],explored:[]},true],[{visible:[102399,0],explored:[0,102399]},true],
      // Schema validation preserves its existing acceptance; consistency still rejects duplicates separately.
      [{visible:[0,0],explored:[0]},true],[{visible:dense,explored:dense},true],
      [{visible:[],explored:[] as number[],hiddenCells:[1]},false],[{visible:[]},false],[{explored:[]},false],[null,false],
      [{visible:{0:0,length:1},explored:[0]},false],[{visible:[],explored:[...dense,0]},false],
      [JSON.parse('{"visible":[],"explored":[],"__proto__":{}}'),false],
      ...[-1,102400,.25,'0',null,NaN,Infinity,undefined].flatMap(value=>[[{visible:[value],explored:[]},false],[{visible:[],explored:[value]},false]] as [unknown,boolean][]),
    ];
    for(const [value,expected] of cases){
      const view={...packet(unit()),map:{widthMm:640000,heightMm:640000,fogCellMm:2000},fog:value};
      const checks:[Boundary,unknown][]=[['validatePlayerView',view],['validateServerSocketMessage',{type:'snapshot',view}],['validateReplayStepResponse',{replayId:`replay_1000000000000_${'a'.repeat(16)}`,startTick:0,endTick:20,tick:10,done:false,view}]];
      for(const [name,input] of checks){
        expect(unfactored[name](input)).toBe(expected);expect(source[name](input)).toBe(expected);expect(generated[name](input)).toBe(expected);
      }
    }
    for(const field of ['visible','explored'] as const){
      const view={...packet(unit()),fog:{visible:[],explored:[],[field]:[102400]}};
      for(const validate of [unfactored.validatePlayerView,source.validatePlayerView,generated.validatePlayerView]){
        expect(validate(view)).toBe(false);expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({instancePath:`/fog/${field}/0`,keyword:'maximum'})]));
      }
    }
  });
  it('preserves entity and action checks across snapshots, both delta arrays, sockets and replay steps',()=>{
    const worker={...unit(),visualAction:{kind:'mine',startedTick:10,facingMilliRad:-3142},cargo:{resource:'gold',amount:2.5}};
    const queue=[{id:'job',kind:'research',typeId:'forestry_1',progress:0,state:'prerequisite_blocked',blockedReason:'AGE_REQUIRED'}];
    const town={...unit(),id:'tc',kind:'building',typeId:'town_center',queue,visualAge:2,progress:1};
    const resource={...unit(null),id:'gold',kind:'resource',typeId:'gold_deposit',resource:'gold',amount:1000};
    const cases:[unknown,boolean][]=[
      [worker,true],[town,true],[resource,true],
      [{...town,ghost:true,lastSeenTick:2},true],
      [{...worker,visualAction:{kind:'mine',startedTick:10,facingMilliRad:3143}},false],
      [{...worker,visualAction:{kind:'attack',startedTick:10}},false],
      [{...worker,visualAction:{kind:'mine',startedTick:10,targetId:'hidden'}},false],
      [{...town,queue:[{...queue[0],state:'exit_blocked'}]},false],
      [{...resource,amount:Infinity},false],[{...worker,hiddenOrders:[]},false],
    ];
    for(const [entity,expected] of cases){
      const view=packet(entity),{entities:_entities,fog:_fog,...header}=view;
      const delta={...header,baseSequence:9,creates:[entity],updates:[],conceals:[],removals:[],fog:{visibleAdded:[],visibleRemoved:[],exploredAdded:[]}};
      const checks:[Boundary,unknown][]=[
        ['validatePlayerView',view],['validatePlayerViewDelta',delta],['validatePlayerViewDelta',{...delta,creates:[],updates:[entity]}],
        ['validateServerSocketMessage',{type:'snapshot',view}],['validateServerSocketMessage',{type:'delta',delta}],
        ['validateReplayStepResponse',{replayId:`replay_1000000000000_${'a'.repeat(16)}`,startTick:0,endTick:20,tick:10,done:false,view}],
      ];
      for(const [name,value] of checks){
        expect(unfactored[name](value)).toBe(expected);expect(source[name](value)).toBe(expected);expect(generated[name](value)).toBe(expected);
      }
    }
  });
  it('preserves the entity limit error path used by prepared snapshot admission',()=>{
    const view={...packet(unit()),entities:Array.from({length:MAX_WORLD_ENTITIES},(_,index)=>({...unit(),id:`unit_${index}`}))};
    const validators=[unfactored.validatePlayerView,source.validatePlayerView,validatePlayerView];
    for(const validate of validators)expect(validate(view)).toBe(true);
    view.entities.push({...unit(),id:'unit_over_limit'});
    for(const validate of validators){
      expect(validate(view)).toBe(false);
      expect(validate.errors).toEqual(expect.arrayContaining([expect.objectContaining({instancePath:'/entities',keyword:'maxItems'})]));
    }
  });
});
