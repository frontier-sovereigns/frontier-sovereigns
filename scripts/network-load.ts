import { randomBytes, createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile, readdir, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { NetworkObserver, impairmentRandom, type Login, type ObserverMode, type ObserverMeasurement } from './network-observer.js';
import { createGameServer } from '../apps/server/src/server.js';
import { engineIdentity } from '../apps/server/src/build-info.js';
import { SaveStore } from '../apps/server/src/save-store.js';
import { ReplayStore } from '../apps/server/src/replay-store.js';
import { defaultEndpointSettings, EndpointConfiguration } from '../apps/server/src/ai-endpoint.js';
import { validateSave, type SaveEnvelope } from '@frontier/simulation';
import { capacityTimingContract, capacityTimingMetrics, createCapacityFixture, type CapacityFixture } from './load-fixture.js';
import { createQualificationEndpoint, type QualificationEndpoint } from './qualification-endpoint.js';
import { assessQualificationMemory } from './qualification-memory.js';
import { assertQualificationReceiptReplay, qualificationReceiptWaitReady, verifyTerminalReplay, retainTerminalReplayEvidence } from './qualification-replay.js';
import { balance, contentHash, validateJoin, validateLobbyState, validateEndpointDiagnosticsResponse, validateHostRecoveryResponse, type EndpointDiagnosticsResponse, type HostRecoveryResponse, type LobbyState, type PublicPlayer } from '@frontier/shared';

// Examples: pnpm test:network-load -- --seconds=60 --drop=0.01 --latency-ms=40 --jitter-ms=10 --seed=37
// Impairment discards application replication frames AFTER TCP delivery. It is not packet loss.
declare const __PROFILE_EXECUTION__: 'bundled-production' | undefined;
const execution = typeof __PROFILE_EXECUTION__ === 'string' ? __PROFILE_EXECUTION__ : 'source-tsx';
const argumentsByName=new Map(process.argv.slice(2).filter(argument=>argument!=='--').map(argument=>{const match=/^--([a-z-]+)=(.+)$/.exec(argument);if(!match)throw new Error('USE_NAMED_EQUALS_ARGUMENTS');return [match[1]!,match[2]!] as const;}));
for(const name of argumentsByName.keys())if(!['seconds','drop','latency-ms','jitter-ms','seed','map','profile','population','endpoint','model-location','outage-start','outage-seconds','stall-probability','stall-ms','performance-diagnostics','observers','publication-preparation','snapshot-encoding','forest','frame-ms','retain-data'].includes(name))throw new Error(`UNKNOWN_OPTION:${name}`);
function setting(name:string,fallback:number,min:number,max:number,integer=true){const value=Number(argumentsByName.get(name)??fallback);if(!Number.isFinite(value)||integer&&!Number.isInteger(value)||value<min||value>max)throw new Error(`INVALID_OPTION:${name}`);return value;}
const seconds=setting('seconds',60,10,7200),drop=setting('drop',0,0,.2,false),latencyMs=setting('latency-ms',0,0,500),jitterMs=setting('jitter-ms',0,0,250),seed=setting('seed',37,0,4294967295),mapType=argumentsByName.get('map')??'open_frontier';
const stallProbability=setting('stall-probability',0,0,.1,false),stallMs=setting('stall-ms',250,1,5000);
// Six-process recovery/secrecy parity passed; inline is retained for named comparisons.
const observerMode=argumentsByName.get('observers')??'process';if(observerMode!=='inline'&&observerMode!=='process')throw new Error('INVALID_OPTION:observers');
const performanceDiagnosticsEnabled=setting('performance-diagnostics',0,0,1)===1;
// Optional host-only evidence retention after measurement and shutdown. This
// never changes gameplay, timing gates or which samples enter the report.
const retainData=setting('retain-data',0,0,1)===1;
const authoritativeIntervalMs=setting('frame-ms',300,50,300);if(authoritativeIntervalMs!==50&&authoritativeIntervalMs!==300)throw new Error('INVALID_OPTION:frame-ms');
const timingContract=capacityTimingContract(authoritativeIntervalMs);
// Qualification always measures normal game speed at the selected frame cadence. Ordinary play's
// adaptive continuity policy must not turn reduced-speed survival into a pass.
const overloadPolicy='pause' as const;
const publicationPreparation=argumentsByName.get('publication-preparation')??'json';if(publicationPreparation!=='json'&&publicationPreparation!=='owned'&&publicationPreparation!=='fog')throw new Error('INVALID_OPTION:publication-preparation');
const snapshotEncoding=argumentsByName.get('snapshot-encoding')??'native';if(snapshotEncoding!=='portable'&&snapshotEncoding!=='native')throw new Error('INVALID_OPTION:snapshot-encoding');
const profile=argumentsByName.get('profile')??'starting',populationLimit=setting('population',120,120,200);
const forest=setting('forest',0,0,1)===1;if(forest&&profile!=='capacity')throw new Error('FOREST_FIXTURE_REQUIRES_CAPACITY');
if(!['starting','capacity','playthrough'].includes(profile)||![120,200].includes(populationLimit))throw new Error('INVALID_CAPACITY_PROFILE');
if(profile==='capacity'&&mapType!=='open_frontier')throw new Error('CAPACITY_FIXTURE_REQUIRES_OPEN_FRONTIER');
const endpointMode=argumentsByName.get('endpoint')??'none',outageSeconds=setting('outage-seconds',endpointMode!=='none'&&seconds>=3600?300:0,0,1800),outageStart=setting('outage-start',Math.min(1200,Math.floor(seconds/3)),0,7200);
if(!['none','mock','real'].includes(endpointMode)||outageSeconds>0&&(endpointMode==='none'||outageStart+outageSeconds>=seconds))throw new Error('INVALID_ENDPOINT_OUTAGE_PROFILE');
if(mapType!=='open_frontier'&&mapType!=='river_divide')throw new Error('INVALID_OPTION:map');
const origin='http://127.0.0.1:3000',bootstrapToken=randomBytes(32).toString('base64url'),privateSeed=createHash('sha256').update(`network-map:${seed}:${mapType}`).digest('hex');
const modelLocation=argumentsByName.get('model-location')??'unknown';
if(!['this-host','remote','unknown'].includes(modelLocation))throw new Error('INVALID_OPTION:model-location');
// Record the actual bounded compute settings in both successful and censored runs.
// Counts change execution placement, never logical gameplay budgets.
const computeWorkers={path:Number(process.env.FRONTIER_PATH_WORKERS??2),vision:Number(process.env.FRONTIER_VISION_WORKERS??2),publication:Number(process.env.FRONTIER_PUBLICATION_WORKER??1)};
for(const [kind,count] of Object.entries(computeWorkers))if(!Number.isInteger(count)||count<0||count>(kind==='publication'?1:8))throw new Error(`INVALID_COMPUTE_WORKERS:${kind}`);
const configurationId=createHash('sha256').update(JSON.stringify({execution,authoritativeIntervalMs,seconds,drop,latencyMs,jitterMs,seed,mapType,profile,populationLimit,endpointMode,modelLocation,outageSeconds,outageStart,stallProbability,stallMs,performanceDiagnosticsEnabled,overloadPolicy,observerMode,publicationPreparation,snapshotEncoding,computeWorkers,...(forest?{forest:true}:{})})).digest('hex').slice(0,12);
const runId=`${Date.now()}-${randomBytes(4).toString('hex')}`;
const reportStem=`${profile}-${populationLimit}-${endpointMode}-${seed}-${seconds}s-${configurationId}-${execution}-${engineIdentity.engineBuildHash.slice(0,12)}-${runId}`;
const random=(client:number,stream:number,ordinal:number)=>impairmentRandom(seed,client,stream,ordinal);
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function requireThat(condition:unknown,code:string):asserts condition{if(!condition)throw new Error(code);}
interface ResponseBody {csrfToken:string;playerId?:string;host:boolean;lobby:LobbyState;code?:string;token?:string}
interface FixtureServerSave {game:SaveEnvelope;lobby:{settings:LobbyState['settings'];players:LobbyState['players'];hostSeed:string|null}}
const secrets=new Set<string>([bootstrapToken]);
let baseUrl='',failure:Error|undefined;
let hostLogin:Login|undefined;
const diagnosticSamples:{elapsedMs:number;diagnostics:EndpointDiagnosticsResponse|null;memory:NodeJS.MemoryUsage;observers:{pid:number;memory:NodeJS.MemoryUsage}[]}[]=[];
function hasNominalQualificationPacing(diagnostics:EndpointDiagnosticsResponse|null):boolean {
  const pacing=diagnostics?.simulation?.pacing;
  return pacing?.policy===overloadPolicy&&pacing.speedPercent===100&&pacing.tickIntervalMs===authoritativeIntervalMs
    &&pacing.reductions===0&&pacing.selfPaced===false&&pacing.deferredWallMs===0
    &&pacing.movementTier===0&&pacing.movementDecisionIntervalMs===authoritativeIntervalMs&&pacing.publicationIntervalMs===timingContract.publicationIntervalMs&&pacing.tierChanges===0;
}
function confirmedNominalPacing():boolean {
  return diagnosticSamples.length>0&&diagnosticSamples.every(sample=>hasNominalQualificationPacing(sample.diagnostics));
}
const intentionalPauses:{startedMs:number;endedMs:number}[]=[];
const persistenceSamples:{elapsedMs:number;autoTicks:number[];journalHealthy:boolean;warningCount:number;warnings:{id:string;code:string}[];lastError?:string}[]=[];
const observedAutoTicks=new Set<number>();
function observePersistence(value:HostRecoveryResponse,elapsedMs:number){
  const autoTicks=value.saves.filter(save=>save.kind==='auto').map(save=>save.tick).sort((a,b)=>a-b);
  for(const tick of autoTicks)observedAutoTicks.add(tick);
  persistenceSamples.push({elapsedMs:Math.round(elapsedMs),autoTicks,journalHealthy:value.persistence.journalHealthy,warningCount:value.warnings.length,warnings:value.warnings.map(({id,code})=>({id,code})),...(value.persistence.lastError?{lastError:value.persistence.lastError}:{})});
}
const activityWindows=new Map<string,NonNullable<NonNullable<EndpointDiagnosticsResponse['simulation']>['activityWindow']>>();
function rememberActivity(diagnostics:EndpointDiagnosticsResponse|null){const window=diagnostics?.simulation?.activityWindow;if(window)activityWindows.set(`${window.matchId}:${window.matchEpoch}:${window.fromTick}:${window.toTick}`,window);}
const distribution=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b),at=(q:number)=>sorted.length?sorted[Math.max(0,Math.ceil(sorted.length*q)-1)]!:null;return {samples:sorted.length,min:sorted[0]??null,p50:at(.5),p95:at(.95),p99:at(.99),max:sorted.at(-1)??null};};
function summarizeDiagnostics(elapsedMs:number,nominalUnits?:number){
  const simulations=diagnosticSamples.flatMap(sample=>sample.diagnostics?.simulation?[sample.diagnostics.simulation]:[]);
  let observedMs=0,nominalMs=0,below90PercentMs=0;
  for(let index=0;index<diagnosticSamples.length;index++){
    const sample=diagnosticSamples[index]!,units=sample.diagnostics?.simulation?.world?.units;if(units===undefined)continue;
    const duration=Math.max(0,(diagnosticSamples[index+1]?.elapsedMs??elapsedMs)-sample.elapsedMs);observedMs+=duration;
    if(nominalUnits&&units>=nominalUnits)nominalMs+=duration;
    if(nominalUnits&&units<nominalUnits*.9)below90PercentMs+=duration;
  }
  const firstWarm=diagnosticSamples.find(sample=>sample.elapsedMs>=300000),last=diagnosticSamples.at(-1);
  const heapGrowth=firstWarm?.diagnostics?.simulation?.memory&&last?.diagnostics?.simulation?.memory
    ?(last.diagnostics.simulation.memory.heapUsed-firstWarm.diagnostics.simulation.memory.heapUsed)/1048576:null;
  const metric=(read:(simulation:NonNullable<EndpointDiagnosticsResponse['simulation']>)=>number|undefined)=>distribution(simulations.flatMap(simulation=>{const value=read(simulation);return value===undefined?[]:[value];}));
  return {
    density:{nominalUnits:nominalUnits??null,units:metric(simulation=>simulation.world?.units),population:metric(simulation=>simulation.world?.population),resourceNodeEntities:metric(simulation=>simulation.world?.resourceNodes),activeResourceNodes:metric(simulation=>simulation.world?.activeResourceNodes),observedSeconds:observedMs/1000,atOrAboveNominalFraction:nominalUnits&&observedMs?nominalMs/observedMs:null,below90PercentSeconds:below90PercentMs/1000},
    activity:{note:'Counts can overlap; movement is observed position change since the preceding diagnostic sample.',moving:metric(simulation=>simulation.activity?.movingSinceLastSample),gathering:metric(simulation=>simulation.activity?.gathering),returning:metric(simulation=>simulation.activity?.returning),building:metric(simulation=>simulation.activity?.building),repairing:metric(simulation=>simulation.activity?.repairing),blocked:metric(simulation=>simulation.activity?.blocked),attackCooldown:metric(simulation=>simulation.activity?.attackCooldownActive)},
    timing:{note:authoritativeIntervalMs===300?'Rolling complete coordinator-cycle costs: exclusive advancing and intervening publication/RPC/checkpoint callbacks plus autonomous planner return processing, including awaited callback time; excludes idle gaps, startup and incomplete pause/epoch tails. Not pooled global percentiles.':'Historical50ms core-step percentiles; completecallback gates are separate.',rollingP95Ms:metric(simulation=>capacityTimingMetrics(simulation,timingContract.authoritativeIntervalMs)?.p95),rollingP99Ms:metric(simulation=>capacityTimingMetrics(simulation,timingContract.authoritativeIntervalMs)?.p99),retainedCycleSamples:metric(simulation=>simulation.cycleSamples),advancingCallbackP95Ms:metric(simulation=>simulation.callbackMs?.p95),advancingCallbackP99Ms:metric(simulation=>simulation.callbackMs?.p99),debtMs:metric(simulation=>simulation.debtMs)},
    path:{pending:metric(simulation=>simulation.path?.pending),blocked:metric(simulation=>simulation.path?.blocked),work:metric(simulation=>simulation.path?.work)},
    memory:{processRssMiB:distribution(diagnosticSamples.map(sample=>sample.memory.rss/1048576)),workerHeapMiB:metric(simulation=>simulation.memory?simulation.memory.heapUsed/1048576:undefined),workerHeapChangeSinceFiveMinutesMiB:heapGrowth,note:'Endpoint delta is not proof of steady state; inspect sampled GC cycles and sustained trend. Whole-process RSS includes gateway, simulation worker and harness; inline mode also includes observers. Process observer RSS is reported separately and excluded from the game-memory limit.'},
  };
}
async function hostDiagnostics(){
  if(!hostLogin)return null;
  const response=await fetch(`${baseUrl}/api/host/diagnostics`,{headers:{cookie:hostLogin.cookie},signal:AbortSignal.timeout(10000)});
  requireThat(response.ok,'HOST_DIAGNOSTICS_UNAVAILABLE');const value:unknown=await response.json();requireThat(validateEndpointDiagnosticsResponse(value),'HOST_DIAGNOSTICS_INVALID');return value;
}
async function post(path:string,payload:unknown,session?:Login):Promise<{body:ResponseBody;login?:Login}>{
  if(path==='/api/join')requireThat(validateJoin(payload),`INVALID_HARNESS_JOIN:${JSON.stringify(validateJoin.errors)}`);
  const timeoutMs=path==='/api/host/endpoint/test'?Math.max(20000,(Number(endpointProfile?.timeoutSeconds??45)+5)*1000):20000;
  const response=await fetch(`${baseUrl}${path}`,{method:'POST',headers:{origin,'content-type':'application/json',...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{})},body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)});
  const body=await response.json() as ResponseBody;requireThat(response.ok,`HTTP_${response.status}:${path}:${body.code??'FAILED'}`);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(cookie){secrets.add(cookie.split('=')[1]!);secrets.add(body.csrfToken);return {body,login:{cookie,csrf:body.csrfToken,playerId:body.playerId??'',host:body.host}};}
  return {body};
}
async function getHostJson(path:'/api/host/recovery',session:Login):Promise<HostRecoveryResponse>;
async function getHostJson(path:string,session:Login):Promise<unknown>;
async function getHostJson(path:string,session:Login){const response=await fetch(`${baseUrl}${path}`,{headers:{cookie:session.cookie},signal:AbortSignal.timeout(20000)});requireThat(response.ok,`HOST_READ_FAILED:${path}`);const value:unknown=await response.json();if(path==='/api/host/recovery')requireThat(validateHostRecoveryResponse(value),'HOST_RECOVERY_INVALID');return value;}
async function until(check:()=>boolean,timeoutMs:number,code:string){const deadline=performance.now()+timeoutMs;while(!check()){checkObservers();if(failure)throw failure;if(performance.now()>deadline)throw new Error(code);await sleep(20);}}
const temporaryRoot=resolve('runtime-data/network-loads');await mkdir(temporaryRoot,{recursive:true});const dataDir=await mkdtemp(join(temporaryRoot,'profile-'));
const replayEvidenceDirectory=join('runtime-data','qualification','terminal-replays',reportStem);
let terminalReplayRequested=false,terminalReplayEvidence:Awaited<ReturnType<typeof retainTerminalReplayEvidence>>|undefined;
const diskSamples:{elapsedMs:number;savesBytes:number;replaysBytes:number;saveFiles:number;replayFiles:number}[]=[];
async function sampleOwnedDisk(elapsedMs:number){
  const sample={elapsedMs:Math.round(elapsedMs),savesBytes:0,replaysBytes:0,saveFiles:0,replayFiles:0};
  for(const directory of ['saves','replays'] as const){
    const path=resolve(dataDir,directory),entries=await readdir(path,{withFileTypes:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
    for(const entry of entries)if(entry.isFile()){const stat=await lstat(join(path,entry.name));if(!stat.isFile())continue;if(directory==='saves'){sample.savesBytes+=stat.size;sample.saveFiles++;}else{sample.replaysBytes+=stat.size;sample.replayFiles++;}}
  }
  diskSamples.push(sample);return sample;
}
let server:Awaited<ReturnType<typeof createGameServer>>|undefined;const clients:NetworkObserver[]=[];
async function captureClientMeasurements(freeze=false):Promise<ObserverMeasurement[]>{
  const measurements=await Promise.allSettled(clients.map(client=>client.capture(freeze)));
  return measurements.map((result,index)=>{if(result.status==='fulfilled')return result.value;const client=clients[index]!,state=client.state;return {pid:client.pid??0,memory:state?.memory??{rss:0,heapTotal:0,heapUsed:0,external:0,arrayBuffers:0},metrics:client.metrics,unresolvedCount:client.unresolved.size,receipts:[...client.receipts],failureCode:client.failure?.message??'OBSERVER_CAPTURE_FAILED',view:client.view,playerId:client.session.playerId,hostPlayer:client.session.host,downstreamBins:[],rtts:[],largestFullViewBytes:0,measuredDurationMs:0};});
}
function observerMemory(){return clients.flatMap(client=>client.pid&&client.memory?[{pid:client.pid,memory:client.memory}]:[]);}
function checkObservers(){for(const client of clients)if(client.failure){failure??=client.failure;break;}}
function observer(session:Login,index:number){return new NetworkObserver(session,()=>({mode:observerMode as ObserverMode,baseUrl,origin,profile:profile as 'starting'|'capacity'|'playthrough',profileIndex:index,seed,performanceDiagnosticsEnabled,drop,latencyMs,jitterMs,stallProbability,stallMs,drill:fixture?.drills[session.playerId],inlineStampLookup:(playerId,matchId,epoch,sequence)=>server?.publicationStamp?.(playerId,matchId,epoch,sequence)}),execution);}
async function setImpairment(enabled:boolean){await Promise.all(clients.map(client=>client.operation({kind:'impair',enabled})));}
let measuredClientSnapshot:ObserverMeasurement[]|undefined,measuredFailureCode:string|null|undefined;
let measuredPerformanceDiagnostics:unknown;
let measuredEndpointSnapshot:ReturnType<QualificationEndpoint['diagnostics']>|null|undefined;
let fixture:CapacityFixture|undefined;
let qualificationEndpoint:QualificationEndpoint|undefined;
let endpointProfile:Record<string,unknown>|undefined;
const startup=performance.now();
const startupTimeline:{clock:string;sampleLimit:number;omittedSamples:number;events:{elapsedMs:number;stage:string;requestDurationMs:number;diagnostics:EndpointDiagnosticsResponse|null;errorCode?:string;observerPids:number[]}[]}={clock:'parent process performance.now relative to harness startup; diagnostic worker timings keep their documented clock domain',sampleLimit:256,omittedSamples:0,events:[]};
let startupStage='server-startup',startupSampler:NodeJS.Timeout|undefined,startupSampling:Promise<void>|undefined;
async function sampleStartup(){
  if(startupSampling)return startupSampling;const stage=startupStage,requestedAt=performance.now();
  startupSampling=(async()=>{let diagnostics:EndpointDiagnosticsResponse|null=null,errorCode:string|undefined;try{diagnostics=await hostDiagnostics();}catch{errorCode='STARTUP_DIAGNOSTIC_UNAVAILABLE';}
    const event={elapsedMs:Math.round(requestedAt-startup),stage,requestDurationMs:performance.now()-requestedAt,diagnostics,...(errorCode?{errorCode}:{}),observerPids:clients.flatMap(client=>client.pid?[client.pid]:[])};
    // Preserve the first startup record and the latest bounded tail; omissions are explicit.
    if(startupTimeline.events.length>=startupTimeline.sampleLimit){startupTimeline.events.splice(1,1);startupTimeline.omittedSamples++;}startupTimeline.events.push(event);
  })().finally(()=>{startupSampling=undefined;});return startupSampling;
}
async function stopStartupSampling(){if(startupSampler){clearInterval(startupSampler);startupSampler=undefined;}await startupSampling;}
const secrecyAudit={scope:'Trusted gateway audits all prohibited literals and host seed in already-serialized authorized view JSON and outbound frames; direct initial/resync views need an additional audit-only stringify. Observers inspect own credentials, forbidden fields and fog locally. Model credentials never enter observer IPC, argv or environment.',viewCalls:0,frameCalls:0,viewBytes:0,frameBytes:0,elapsedMs:0};
function auditPublishedText(text:string,view:boolean,host=false){const at=performance.now();try{for(const secret of secrets)requireThat(!text.includes(secret),view?'VIEW_CREDENTIAL_LEAK':'WIRE_CREDENTIAL_LEAK');if(view||!host)requireThat(!text.includes(privateSeed),view?'VIEW_CREDENTIAL_LEAK':'REMOTE_HOST_SEED_LEAK');}catch(error){failure??=error instanceof Error?error:new Error('PUBLISHED_SECRECY_ASSERTION_FAILED');}finally{secrecyAudit.elapsedMs+=performance.now()-at;if(view){secrecyAudit.viewCalls++;secrecyAudit.viewBytes+=Buffer.byteLength(text);}else{secrecyAudit.frameCalls++;secrecyAudit.frameBytes+=Buffer.byteLength(text);}}}
try{
  server=await createGameServer({bootstrapToken,dataDir,publicationPreparation,snapshotEncoding,overloadPolicy,authoritativeIntervalMs,allowedOrigins:[origin],inspectPublishedViewJson:text=>auditPublishedText(text,true),inspectOutboundFrame:(text,_playerId,host)=>auditPublishedText(text,false,host),...(performanceDiagnosticsEnabled?{performanceDiagnostics:true}: {})});await server.app.listen({host:'127.0.0.1',port:0});baseUrl=`http://127.0.0.1:${(server.app.server.address() as {port:number}).port}`;
  const bootstrap=await post('/api/bootstrap',{token:bootstrapToken});let host=bootstrap.login!;requireThat(host,'BOOTSTRAP_SESSION_MISSING');
  hostLogin=host;
  await sampleStartup();startupSampler=setInterval(()=>void sampleStartup(),1000);
  if(endpointMode==='none')await post('/api/host/endpoint',{settings:defaultEndpointSettings(),apiKey:null},host);
  else{
    let settings={...defaultEndpointSettings(),model:'qualification-synthetic'},apiKey:string|undefined;
    if(endpointMode==='real'){const configuration=new EndpointConfiguration(resolve(process.env.GAME_DATA_DIR??'runtime-data'));await configuration.load();requireThat(configuration.state().configured,'REAL_ENDPOINT_NOT_CONFIGURED');const snapshot=configuration.snapshot();settings=snapshot.settings;apiKey=snapshot.apiKey;if(apiKey)secrets.add(apiKey);}
    endpointProfile={provider:settings.providerProfile,model:settings.model,concurrency:settings.maxConcurrent,timeoutSeconds:settings.timeoutSeconds,inputTokenBudget:settings.inputTokenBudget,maxOutputTokens:settings.maxOutputTokens,intervalSeconds:settings.intervalSeconds,maxAdaptiveIntervalSeconds:settings.maxAdaptiveIntervalSeconds,location:endpointMode==='mock'?'in-process synthetic responder':modelLocation==='this-host'?'operator-confirmed inference on this computer':modelLocation==='remote'?'operator-confirmed inference on another computer':'existing endpoint; physical location not established'};
    if(outageSeconds>0)requireThat(seconds-outageStart-outageSeconds>=settings.maxAdaptiveIntervalSeconds*2+settings.timeoutSeconds*2+30,'OUTAGE_PROFILE_NEEDS_RECOVERY_WINDOW');
    qualificationEndpoint=await createQualificationEndpoint({mode:endpointMode as 'mock'|'real',settings,...(apiKey?{apiKey}:{})});secrets.add(qualificationEndpoint.apiKey);
    await post('/api/host/endpoint',{settings:qualificationEndpoint.settings,apiKey:qualificationEndpoint.apiKey},host);
    const probe=await post('/api/host/endpoint/test',{listModels:true},host);requireThat((probe.body as unknown as {success:boolean}).success,'QUALIFICATION_ENDPOINT_PROBE_FAILED');
  }
  await post('/api/host/lobby',{teamPreset:profile==='capacity'?'free_for_all':'six_vs_five',aiCount:5,mapSize:'large',mapType,populationLimit,sharedVision:false,caretakerEnabled:false},host);await post('/api/host/seed',{seed:privateSeed},host);
  for(let i=0;i<5;i++){const joined=await post('/api/join',{name:`Network remote ${i+1}`,inviteCode:bootstrap.body.lobby.inviteCode});requireThat(joined.login?.playerId,'PLAYER_SESSION_MISSING');clients.push(observer(joined.login,i));}
  const hostJoin=await post('/api/join',{name:'Network host',hostPlayer:true,inviteCode:bootstrap.body.lobby.inviteCode},host);host.playerId=hostJoin.body.playerId!;clients.push(observer(host,5));
  if(profile==='capacity'){
    const lobby=hostJoin.body.lobby,factions:PublicPlayer[]=lobby.players.map(({id,name,teamId,color,pattern,kind,hostPlayer,difficulty,personality})=>({id,name,teamId,color,pattern,kind,...(hostPlayer===undefined?{}:{hostPlayer}),...(difficulty===undefined?{}:{difficulty}),...(personality===undefined?{}:{personality})}));
    fixture=createCapacityFixture({factions,identity:engineIdentity,populationLimit:populationLimit as 120|200,seed:privateSeed,controllers:true,forest,authoritativeIntervalMs});
    const record:FixtureServerSave={game:fixture.save,lobby:{settings:lobby.settings,players:lobby.players,hostSeed:privateSeed}};
    const store=new SaveStore<FixtureServerSave>(resolve(dataDir,'saves'),(value:unknown):value is FixtureServerSave=>{try{const save=value as FixtureServerSave;return !!validateSave(save.game,engineIdentity)&&validateLobbyState({status:'PAUSED',...save.lobby,canStart:false});}catch{return false;}});
    const saved=await store.save(record,{kind:'manual',label:'Explicit synthetic maximum-capacity fixture',tick:0});
    startupStage='fixture-restore';await sampleStartup();await post('/api/host/load',{saveId:saved.id,confirmed:true},host);
    for(const client of clients){const invitation=await post('/api/host/rejoin-invite',{playerId:client.session.playerId},host);requireThat(invitation.body.token,'FIXTURE_REJOIN_INVITE_MISSING');secrets.add(invitation.body.token);const reclaimed=await post('/api/rejoin',{token:invitation.body.token},client.session);requireThat(reclaimed.login?.playerId,'FIXTURE_REJOIN_FAILED');client.session=reclaimed.login;if(client.session.host){host=client.session;hostLogin=host;}}
    startupStage='observer-connect';await Promise.all(clients.map(client=>client.connect()));startupStage='before-resume';await sampleStartup();await post('/api/host/pause',{paused:false},host);startupStage='running-setup';
  }else{
    startupStage='observer-connect';await Promise.all(clients.map(client=>client.connect()));for(const client of clients)await post('/api/ready',{ready:true},client.session);startupStage='before-start';await sampleStartup();await post('/api/host/start',{},host);startupStage='running-setup';
  }
  await until(()=>clients.every(client=>client.view?.status==='RUNNING'),20000,'START_TIMEOUT');
  const purchases=await Promise.all(clients.map((client,index)=>client.purchase(index===0))),expectedFood=purchases.map(item=>item.expectedFood),firstCommands=purchases.map(item=>item.envelope);
  const receiptReady=(ready:()=>boolean,phase:'setup'|'reconnect'='setup')=>qualificationReceiptWaitReady(clients.map((client,index)=>({expected:firstCommands[index]!,observed:client.view})),ready,phase);
  await until(()=>receiptReady(()=>clients.every((client,index)=>index===0?client.metrics.deliberatelyDroppedReceipts===1&&client.view?.self.resources.food===expectedFood[0]:client.receipts.get(firstCommands[index]!.clientCommandId)?.length===1)),10000,'FIRST_RECEIPT_TIMEOUT');
  const pendingClient=clients[0]!,lostReceiptStarted=performance.now(),pendingPlayerId=pendingClient.session.playerId;
  requireThat(pendingClient.unresolved.size===1&&!pendingClient.receipts.get(firstCommands[0]!.clientCommandId)?.length,'LOST_RECEIPT_NOT_PENDING');
  await pendingClient.disconnect();const pendingRotated=await post('/api/reconnect',{},pendingClient.session);requireThat(pendingRotated.login?.playerId===pendingPlayerId,'LOST_RECEIPT_RECONNECT_FAILED');pendingClient.session=pendingRotated.login!;await pendingClient.connect();
  await until(()=>receiptReady(()=>pendingClient.metrics.unresolvedReplays===1&&pendingClient.receipts.get(firstCommands[0]!.clientCommandId)?.length===1&&pendingClient.view?.self.resources.food===expectedFood[0]),10000,'LOST_RECEIPT_REPLAY_TIMEOUT');
  const lostReceiptRecoveryMs=performance.now()-lostReceiptStarted;requireThat(Number(pendingClient.unresolved.size)===0,'LOST_RECEIPT_REPLAY_STILL_PENDING');
  requireThat(clients.every((client,index)=>client.view?.matchEpoch===firstCommands[index]!.matchEpoch),'SETUP_EPOCH_CHANGED_DURING_RECEIPT_RECOVERY');
  for(const [index,client]of clients.entries()){const receipt=client.receipts.get(firstCommands[index]!.clientCommandId)![0]!;requireThat(receipt.status==='accepted',`PURCHASE_REJECTED:${/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.code??'')?receipt.code:'UNKNOWN'}`);await client.send(firstCommands[index]!);}
  await until(()=>receiptReady(()=>clients.every((client,index)=>client.receipts.get(firstCommands[index]!.clientCommandId)?.length===2&&client.view?.self.resources.food===expectedFood[index])),10000,'DUPLICATE_RECEIPT_TIMEOUT');
  for(const [index,client]of clients.entries()){const receipts=client.receipts.get(firstCommands[index]!.clientCommandId)!;assertQualificationReceiptReplay(receipts[0]!,receipts[1]!,'setup');if(!fixture)requireThat(!client.view!.enemyAiVisible,'STARTING_ENEMY_VISIBILITY');}
  startupStage='setup-complete';await sampleStartup();await stopStartupSampling();
  await Promise.all(clients.map(client=>client.operation({kind:'measure'})));
  const started=performance.now(),cpuStart=process.cpuUsage(),startTick=clients[0]!.view!.tick;let nextOrders=0,nextProgress=10000,reconnected=false,explicitResync=false,reconnectRecoveryMs=0,resyncRecoveryMs=0,duplicateAfterReconnect=false;
  let savedRecovery:{oldEpoch:number;newEpoch:number;tick:number;elapsedMs:number}|undefined;
  let chatDelivered=false;
  const chatTexts=clients.map((_,index)=>`Qualification chat ${configurationId} ${index+1}`);
  let nextDiagnostics=0,nextDiskSample=0,nextPersistenceSample=65000,lastProgressTick=startTick,lastProgressAt=0;
  let outageStartedAt:number|undefined,outageEndedAt:number|undefined,outageEndedWallTime:number|undefined;
  const expectedAiIds=clients[0]!.view!.players.filter(player=>player.kind==='ai').map(player=>player.id);
  const aiPolicies=clients[0]!.view!.players.filter(player=>player.kind==='ai').map(({id,difficulty,personality})=>({playerId:id,difficulty,personality}));
  console.log(JSON.stringify({event:'network_load_started',overloadPolicy,observerMode,observerPids:clients.map(client=>client.pid),profile,description:fixture?'synthetic late-game capacity; autonomous AI may reduce occupancy':'ordinary starting settlements over loopback',provenance:fixture?.provenance,humans:6,ai:5,aiPolicies,seconds,mapType,impairment:{kind:'application replication-frame drop after TCP delivery; NOT TCP packet loss',dropProbability:drop,oneWayDelayMs:latencyMs,jitterMs,headOfLineStallProbability:stallProbability,headOfLineStallMs:stallMs,seed},setupMs:Math.round(started-startup)}));
  while(performance.now()-started<seconds*1000){
    checkObservers();if(failure)throw failure;const elapsed=performance.now()-started;
    if(qualificationEndpoint&&outageSeconds>0){
      if(outageStartedAt===undefined&&elapsed>=outageStart*1000){qualificationEndpoint.setOutage(true);outageStartedAt=elapsed;console.log(JSON.stringify({event:'owned_proxy_outage_started',elapsedMs:Math.round(elapsed),plannedSeconds:outageSeconds,endpointMode}));}
      if(outageStartedAt!==undefined&&outageEndedAt===undefined&&elapsed>=outageStartedAt+outageSeconds*1000){qualificationEndpoint.setOutage(false);outageEndedAt=elapsed;outageEndedWallTime=Date.now();console.log(JSON.stringify({event:'owned_proxy_outage_ended',elapsedMs:Math.round(elapsed),actualSeconds:(elapsed-outageStartedAt)/1000}));}
    }
    if(elapsed>=nextDiagnostics){nextDiagnostics=elapsed+1000;const diagnostics=await hostDiagnostics();diagnosticSamples.push({elapsedMs:Math.round(elapsed),diagnostics,memory:process.memoryUsage(),observers:observerMemory()});rememberActivity(diagnostics);requireThat(hasNominalQualificationPacing(diagnostics),'QUALIFICATION_PACING_NOT_STRICT');requireThat(diagnostics?.simulation?.world?.nonnegativeResources,'NEGATIVE_OR_MISSING_RESOURCE_DIAGNOSTICS');requireThat((diagnostics.simulation.path?.work??Infinity)<=timingContract.pathWorkPerFrame,'PATH_WORK_BUDGET_EXCEEDED');requireThat(diagnostics.scheduler.active<=diagnostics.scheduler.concurrency,'MODEL_CONCURRENCY_EXCEEDED');requireThat(diagnostics.simulation.status!=='PAUSED','AUTHORITATIVE_DIAGNOSTIC_PAUSED');requireThat(diagnostics.simulation.debtMs<=2000,'AUTHORITATIVE_TICK_DEBT_EXCEEDED');if(diagnostics.simulation.tick>lastProgressTick){lastProgressTick=diagnostics.simulation.tick;lastProgressAt=elapsed;}requireThat(diagnostics.simulation.status!=='RUNNING'||elapsed-lastProgressAt<=2000,'AUTHORITATIVE_TICKS_FROZEN');}
    if(elapsed>=nextDiskSample){nextDiskSample=elapsed+30000;await sampleOwnedDisk(elapsed);}
    if(elapsed>=nextPersistenceSample){nextPersistenceSample=elapsed+120000;observePersistence(await getHostJson('/api/host/recovery',host),performance.now()-started);}
    requireThat(!clients.some(client=>client.view?.status==='PAUSED'),`AUTHORITATIVE_PAUSE:${clients.find(client=>client.view?.status==='PAUSED')?.view?.tick}`);
    if(profile==='playthrough'&&clients.some(client=>client.view?.status==='FINISHED'))break;
    requireThat(!clients.some(client=>client.view?.status==='FINISHED'),`MATCH_FINISHED_BEFORE_REQUESTED_DURATION:${clients.find(client=>client.view?.status==='FINISHED')?.view?.tick}`);
    if(!chatDelivered&&elapsed>=2000){
      for(const [index,client]of clients.entries()){
        await sleep(latencyMs+random(index,5,1)*jitterMs);
        await post('/api/chat',{channel:'all',text:chatTexts[index]},client.session);
      }
      await until(()=>clients.every(client=>chatTexts.every((text,index)=>client.communication?.messages.some(message=>message.text===text&&message.source==='human'&&message.channel==='all'&&message.senderId===clients[index]!.session.playerId))),10000,'IMPAIRED_CHAT_DELIVERY_TIMEOUT');
      chatDelivered=true;
    }
    if(elapsed>=nextOrders){
      nextOrders=elapsed+2000;
      await Promise.all(clients.map(client=>client.operation({kind:'orders'})));
    }
    if(!explicitResync&&elapsed>=Math.min(5000,seconds*250)){
      explicitResync=true;const start=performance.now(),counts=clients.map(client=>client.metrics.fullSnapshots);await Promise.all(clients.map(client=>client.resync()));await until(()=>clients.every((client,index)=>client.metrics.fullSnapshots>counts[index]!&&client.view),10000,'EXPLICIT_RESYNC_TIMEOUT');resyncRecoveryMs=performance.now()-start;
    }
    if(!reconnected&&elapsed>=Math.min(25000,seconds*550)){
      reconnected=true;const client=clients[0]!,start=performance.now(),oldCookie=client.session.cookie,playerId=client.session.playerId;await client.disconnect();const rotated=await post('/api/reconnect',{},client.session);requireThat(rotated.login&&rotated.login.cookie!==oldCookie&&rotated.login.playerId===playerId,'RECONNECT_AUTHORITY_MISMATCH');client.session=rotated.login;await client.connect();await until(()=>receiptReady(()=>Boolean(client.view?.status==='RUNNING'),'reconnect'),10000,'RECONNECT_SNAPSHOT_TIMEOUT');reconnectRecoveryMs=performance.now()-start;
      const command=firstCommands[0]!,count=client.receipts.get(command.clientCommandId)!.length;await client.send(command);await until(()=>receiptReady(()=>client.receipts.get(command.clientCommandId)!.length>count,'reconnect'),10000,'RECONNECT_RECEIPT_TIMEOUT');const receipts=client.receipts.get(command.clientCommandId)!;assertQualificationReceiptReplay(receipts[0]!,receipts.at(-1)!,'reconnect');duplicateAfterReconnect=true;
    }
    if(profile==='playthrough'&&!savedRecovery&&elapsed>=Math.min(900000,seconds*500)){
      const recoveryStarted=performance.now();await setImpairment(false);await post('/api/host/pause',{paused:true},host);await until(()=>clients.every(client=>client.view?.status==='PAUSED'),10000,'SAVE_PAUSE_TIMEOUT');
      const oldEpoch=clients[0]!.view!.matchEpoch,label=`Qualification recovery ${seed}`,before=clients.map(client=>({playerId:client.session.playerId,resources:{...client.view!.self.resources}}));
      // Pausing stops gameplay, but an ordinary autosave may still be writing.
      // Retry only its explicit busy response; disk/auth/validation errors retain
      // their original failure and each HTTP attempt keeps its existing timeout.
      const saveDeadline=performance.now()+10000;
      for(;;){
        try{await post('/api/host/save',{name:label},host);break;}
        catch(error){
          if(!(error instanceof Error)||error.message!=='HTTP_409:/api/host/save:SAVE_BUSY'||performance.now()>=saveDeadline)throw error;
          requireThat(clients.every(client=>client.view?.status==='PAUSED'),'SAVE_RETRY_REQUIRES_PAUSED');await sleep(100);
        }
      }
      const listing=await getHostJson('/api/host/recovery',host);const saved=listing.saves.find(item=>item.label===label);requireThat(saved,'SAVE_NOT_LISTED');
      for(const client of clients)await client.disconnect();await post('/api/host/load',{saveId:saved.id,confirmed:true},host);
      for(const client of clients){const invitation=await post('/api/host/rejoin-invite',{playerId:client.session.playerId},host);requireThat(invitation.body.token,'RECOVERY_INVITE_MISSING');secrets.add(invitation.body.token);const reclaimed=await post('/api/rejoin',{token:invitation.body.token},client.session);requireThat(reclaimed.login?.playerId,'RECOVERY_REJOIN_FAILED');client.session=reclaimed.login;if(client.session.host){host=client.session;hostLogin=host;}}
      await Promise.all(clients.map(client=>client.connect()));await until(()=>clients.every(client=>client.view?.status==='PAUSED'),10000,'RECOVERY_PAUSED_VIEW_TIMEOUT');
      for(const client of clients){requireThat(client.view!.matchEpoch>oldEpoch,'RESTORE_EPOCH_DID_NOT_ADVANCE');requireThat(JSON.stringify(client.view!.self.resources)===JSON.stringify(before.find(item=>item.playerId===client.session.playerId)!.resources),'RESTORE_BANK_CHANGED');}
      const newEpoch=clients[0]!.view!.matchEpoch;await post('/api/host/pause',{paused:false},host);await until(()=>clients.every(client=>client.view?.status==='RUNNING'),10000,'RESTORE_RESUME_TIMEOUT');await setImpairment(true);
      savedRecovery={oldEpoch,newEpoch,tick:saved.tick,elapsedMs:Math.round(performance.now()-recoveryStarted)};
      intentionalPauses.push({startedMs:recoveryStarted-started,endedMs:performance.now()-started});lastProgressTick=clients[0]!.view!.tick;lastProgressAt=performance.now()-started;
      console.log(JSON.stringify({event:'full_match_save_recovery',...savedRecovery}));
    }
    if(elapsed>=nextProgress){nextProgress=elapsed+10000;console.log(JSON.stringify({event:'network_load_progress',elapsedMs:Math.round(elapsed),ticks:clients.map(client=>client.view?.tick??null),receivedFrames:clients.reduce((sum,client)=>sum+client.metrics.receivedFrames,0),droppedFrames:clients.reduce((sum,client)=>sum+client.metrics.droppedReplicationFrames,0)}));}
    await sleep(25);
  }
  if(profile==='capacity'&&seconds>=3600){
    const baselineTick=diagnosticSamples[0]?.diagnostics?.simulation?.tick;
    requireThat(baselineTick!==undefined,'SOAK_DIAGNOSTIC_BASELINE_MISSING');
    await until(()=>clients.every(client=>(client.view?.tick??0)>=baselineTick+seconds*balance.rules.simulationHz),5000,'SIXTY_MINUTES_OF_SIMULATION_NOT_REACHED');
  }
  await setImpairment(false);const finalCounts=clients.map(client=>client.metrics.fullSnapshots);await Promise.all(clients.map(client=>client.resync(true)));await until(()=>clients.every((client,index)=>client.metrics.fullSnapshots>finalCounts[index]!&&(client.view?.status==='RUNNING'||profile==='playthrough'&&client.view?.status==='FINISHED')),10000,'FINAL_RECOVERY_TIMEOUT');
  await until(()=>clients.every(client=>client.unresolved.size===0),10000,'UNRESOLVED_COMMANDS_AT_COMPLETION');
  const finalDiagnostics=await hostDiagnostics();diagnosticSamples.push({elapsedMs:Math.round(performance.now()-started),diagnostics:finalDiagnostics,memory:process.memoryUsage(),observers:observerMemory()});rememberActivity(finalDiagnostics);requireThat(hasNominalQualificationPacing(finalDiagnostics),'QUALIFICATION_PACING_NOT_STRICT');
  let terminalReplay:{recordings:{id:string;startTick:number;endTick:number;bytes:number}[];warnings:{id:string;code:string}[]}|undefined;
  if(profile==='playthrough'&&clients[0]?.view?.status==='FINISHED'){
    terminalReplayRequested=true;
    terminalReplay=await getHostJson('/api/host/replays',host) as NonNullable<typeof terminalReplay>;
    requireThat(terminalReplay.recordings.some(recording=>recording.endTick===clients[0]!.view!.tick&&recording.startTick===(savedRecovery?.tick??0)),'TERMINAL_REPLAY_NOT_FINALIZED');
  }
  const persistence=await getHostJson('/api/host/recovery',host);observePersistence(persistence,performance.now()-started);
  await sampleOwnedDisk(performance.now()-started);
  if(performanceDiagnosticsEnabled)measuredPerformanceDiagnostics=await server.performanceDiagnostics!();
  // Each observer freezes its own counters before responding. Process-local
  // durations are retained; no simultaneous cross-process clock is assumed.
  const measuredClients=measuredClientSnapshot=await captureClientMeasurements(true);checkObservers();const liveFailureCode=measuredFailureCode=failure?.message??null;
  const elapsed=performance.now()-started,cpu=process.cpuUsage(cpuStart),measuredRss=process.memoryUsage().rss,rtts=measuredClients.flatMap(client=>client.rtts).sort((a,b)=>a-b),percentile=(fraction:number)=>rtts.length?rtts[Math.min(rtts.length-1,Math.floor(rtts.length*fraction))]:null;
  const telemetry=measuredClients.flatMap(client=>client.telemetry?[client.telemetry]:[]);
  if(liveFailureCode)throw new Error(liveFailureCode);
  requireThat(reconnected&&explicitResync&&duplicateAfterReconnect,'RECOVERY_SCENARIOS_INCOMPLETE');requireThat(measuredClients.every(client=>client.view!.tick>startTick&&client.metrics.deltas>0&&client.metrics.secrecyChecks>0),'NO_LIVE_REPLICATION_PROGRESS');
  const measuredSeconds=elapsed/1000,completedBins=Math.floor(measuredSeconds),bandwidth=measuredClients.map(client=>{const clientSeconds=client.measuredDurationMs/1000,clientBins=Math.floor(clientSeconds);const samples=Array.from({length:clientBins},(_,index)=>(client.downstreamBins[index]??0)/1024).sort((a,b)=>a-b);return {playerId:client.playerId,measuredSeconds:clientSeconds,completedOneSecondBins:clientBins,meanDownstreamKiBps:client.downstreamBins.reduce((sum,bytes)=>sum+bytes,0)/1024/clientSeconds,p95DownstreamKiBps:samples[Math.min(samples.length-1,Math.floor(samples.length*.95))]??0,maxDownstreamKiBps:samples.at(-1)??0,largestFullViewBytes:client.largestFullViewBytes,oneSecondDownstreamBytes:Array.from({length:clientBins},(_,index)=>client.downstreamBins[index]??0)};});
  const summary=summarizeDiagnostics(elapsed,fixture?.provenance.expectedUnits);
  const memoryAssessment=assessQualificationMemory(diagnosticSamples.flatMap(sample=>sample.diagnostics?.simulation?.memory?[{elapsedMs:sample.elapsedMs,workerHeapMiB:sample.diagnostics.simulation.memory.heapUsed/1048576,processRssMiB:sample.memory.rss/1048576,runnerHeapMiB:sample.memory.heapUsed/1048576}]:[]),elapsed);
  const outageSamples=diagnosticSamples.filter(sample=>outageStartedAt!==undefined&&sample.elapsedMs>=outageStartedAt&&sample.elapsedMs<=(outageEndedAt??elapsed));
  const recoveredAiIds=expectedAiIds.filter(id=>diagnosticSamples.some(sample=>sample.diagnostics?.scheduler.commanders.some(commander=>commander.playerId===id&&outageEndedWallTime!==undefined&&(commander.lastAcceptedAt??0)>=outageEndedWallTime)));
  const modelReadyAiIds=expectedAiIds.filter(id=>diagnosticSamples.some(sample=>sample.diagnostics?.scheduler.commanders.some(commander=>commander.playerId===id&&commander.lastAcceptedAt!==null&&commander.lastAcceptedAt!==undefined)));
  const firstOutage=outageSamples[0]?.diagnostics?.simulation,lastOutage=outageSamples.at(-1)?.diagnostics?.simulation;
  const outageTickProgress=firstOutage&&lastOutage?lastOutage.tick-firstOutage.tick:0;
  const outageWallMs=outageSamples.length>1?outageSamples.at(-1)!.elapsedMs-outageSamples[0]!.elapsedMs:0;
  const outagePauseMs=outageSamples.length>1?intentionalPauses.reduce((sum,pause)=>sum+Math.max(0,Math.min(outageSamples.at(-1)!.elapsedMs,pause.endedMs)-Math.max(outageSamples[0]!.elapsedMs,pause.startedMs)),0):0;
  const outageObservedMs=outageWallMs-outagePauseMs;
  const outageIncomeAiIds=expectedAiIds.filter(id=>{const before=firstOutage?.world?.factions.find(faction=>faction.playerId===id),after=lastOutage?.world?.factions.find(faction=>faction.playerId===id);return before&&after&&balance.resourceOrder.some(resource=>after.collected[resource]>before.collected[resource]);});
  const postRecovery=expectedAiIds.map(playerId=>{const accepted=[...new Set(diagnosticSamples.flatMap(sample=>sample.diagnostics?.scheduler.commanders.flatMap(commander=>commander.playerId===playerId&&outageEndedWallTime!==undefined&&(commander.lastAcceptedAt??0)>=outageEndedWallTime?[commander.lastAcceptedAt!]:[])??[]))].sort((a,b)=>a-b);return {playerId,observedAcceptedPlans:accepted.length,lastAcceptedAt:accepted.at(-1)??null,lastAcceptanceAgeMs:accepted.length?Date.now()-accepted.at(-1)!:null};});
  const maximumAcceptanceAgeMs=(Number(endpointProfile?.maxAdaptiveIntervalSeconds??120)*2+Number(endpointProfile?.timeoutSeconds??120)+30)*1000;
  const recoverySustained=postRecovery.every(item=>item.observedAcceptedPlans>=2&&item.lastAcceptanceAgeMs!==null&&item.lastAcceptanceAgeMs<=maximumAcceptanceAgeMs);
  const fallbackAiIds=expectedAiIds.filter(id=>{const before=firstOutage?.world?.factions.find(faction=>faction.playerId===id),after=lastOutage?.world?.factions.find(faction=>faction.playerId===id);return before&&after&&after.statistics.fallbackTicks>before.statistics.fallbackTicks;});
  const endpoint=measuredEndpointSnapshot=structuredClone(qualificationEndpoint?.diagnostics()??null);
  const outage={requestedSeconds:outageSeconds,startedMs:outageStartedAt??null,endedMs:outageEndedAt??null,actualSeconds:outageStartedAt!==undefined&&outageEndedAt!==undefined?(outageEndedAt-outageStartedAt)/1000:null,outageTickProgress,outageWallMs,outagePauseMs,outageObservedMs,outageIncomeAiIds,fallbackAiIds,recoveredAiIds,postRecovery,recoverySustained,completed:outageSeconds===0||outageEndedAt!==undefined&&outageObservedMs>0&&Math.abs(outageObservedMs-outageTickProgress*50)<=2000&&outageIncomeAiIds.length===5&&fallbackAiIds.length===5&&recoveredAiIds.length===5&&recoverySustained&&(endpoint?.outageRejected??0)>0};
  // End live measurements before replay work. Keep the portable host-only recording
  // outside the disposable test directory so the checksum result can be reproduced.
  let terminalReplayVerification:(Awaited<ReturnType<typeof verifyTerminalReplay>>&{recordingId:string;archivePath:string;recordingChecksum:string})|undefined;
  if(terminalReplay){
    const final=measuredClients[0]!.view!,chosen=terminalReplay.recordings.find(recording=>recording.endTick===final.tick&&recording.startTick===(savedRecovery?.tick??0));
    requireThat(chosen&&final.result,'TERMINAL_REPLAY_NOT_FINALIZED');
    terminalReplayEvidence=await retainTerminalReplayEvidence({sourceDirectory:join(dataDir,'replays'),archiveDirectory:replayEvidenceDirectory,preferredId:chosen.id});
    const archived=terminalReplayEvidence.files.find(file=>file.name===`${chosen.id}.json`);requireThat(archived,'TERMINAL_REPLAY_EVIDENCE_NOT_RETAINED');
    const library=new ReplayStore(replayEvidenceDirectory,engineIdentity),{recording}=await library.read(chosen.id);
    const archivePath=archived.archivePath;
    console.log(JSON.stringify({event:'terminal_replay_verification_started',recordingId:chosen.id,startTick:chosen.startTick,endTick:chosen.endTick}));
    terminalReplayVerification={...await verifyTerminalReplay(recording,engineIdentity,{matchId:final.matchId,matchEpoch:final.matchEpoch,tick:final.tick,result:final.result}),recordingId:chosen.id,archivePath,recordingChecksum:recording.checksum};
    console.log(JSON.stringify({event:'terminal_replay_verification_finished',...terminalReplayVerification}));
  }
  const playthroughChecks={allFourAges:telemetry.length===6&&telemetry.every(item=>['1','2','3','4'].every(age=>item.ageTicks[age]!==undefined)),upgrades:measuredClients.every(client=>client.view?.self.technologies?.includes('forestry_3')),completedFarm:telemetry.some(item=>item.evidence.completedFarm.met),completedWall:telemetry.some(item=>item.evidence.completedWall.met),completedGate:telemetry.some(item=>item.evidence.completedGate.met),resourceDepletion:telemetry.some(item=>item.evidence.resourceDepletion.met),naturalNodeDepletion:telemetry.some(item=>item.evidence.naturalNodeDepletion.met),fortificationBreach:telemetry.some(item=>item.evidence.fortificationBreach.met),saveRecovery:!!savedRecovery,finished:measuredClients[0]?.view?.status==='FINISHED'};
  const playthroughComplete=Object.values(playthroughChecks).every(Boolean);
  const firstSample=diagnosticSamples[0]!,lastSample=diagnosticSamples.at(-1)!;
  const sampledTickProgress=(lastSample.diagnostics?.simulation?.tick??0)-(firstSample.diagnostics?.simulation?.tick??0);
  const pauseMs=intentionalPauses.reduce((sum,pause)=>sum+Math.max(0,Math.min(lastSample.elapsedMs,pause.endedMs)-Math.max(firstSample.elapsedMs,pause.startedMs)),0);
  const sampledRunMs=lastSample.elapsedMs-firstSample.elapsedMs-pauseMs;
  const completeMinuteWindows:{fromMs:number;toMs:number;advancingMs:number;gameTimeFraction:number}[]=[];
  let windowStart=0;
  for(let end=0;end<diagnosticSamples.length;end++){
    const last=diagnosticSamples[end]!;
    while(windowStart+1<end&&diagnosticSamples[windowStart+1]!.elapsedMs<=last.elapsedMs-60000)windowStart++;
    const first=diagnosticSamples[windowStart]!,paused=intentionalPauses.reduce((sum,pause)=>sum+Math.max(0,Math.min(last.elapsedMs,pause.endedMs)-Math.max(first.elapsedMs,pause.startedMs)),0),advancingMs=last.elapsedMs-first.elapsedMs-paused;
    if(advancingMs>=60000&&first.diagnostics?.simulation&&last.diagnostics?.simulation)completeMinuteWindows.push({fromMs:first.elapsedMs,toMs:last.elapsedMs,advancingMs,gameTimeFraction:(last.diagnostics.simulation.tick-first.diagnostics.simulation.tick)*50/advancingMs});
  }
  const progress={sampledTickProgress,sampledRunMs,intentionalPauses,observedHz:sampledRunMs>0?sampledTickProgress/(sampledRunMs/1000):0,observedFrameHz:sampledRunMs>0?sampledTickProgress/timingContract.frameTicks/(sampledRunMs/1000):0,gameTimeFraction:sampledRunMs>0?sampledTickProgress*50/sampledRunMs:0,completeMinuteWindows,missingSimulationMs:sampledRunMs-sampledTickProgress*50};
  const windows=[...activityWindows.values()];
  const minuteTicks=60*balance.rules.simulationHz,firstWindow=windows[0],lastWindow=windows.at(-1),roster=measuredClients[0]!.view!.players.map(player=>player.id).sort().join(',');
  const coverage={expectedCompleteMinuteWindows:Math.floor(sampledTickProgress/minuteTicks),completeDurations:windows.every(window=>window.toTick-window.fromTick===minuteTicks),sameMatchAndEpoch:windows.every(window=>window.matchId===firstWindow?.matchId&&window.matchEpoch===firstWindow?.matchEpoch),fullFactionRoster:windows.every(window=>window.factions.map(faction=>faction.playerId).sort().join(',')===roster),consecutive:windows.every((window,index)=>index===0||windows[index-1]!.toTick===window.fromTick),uncoveredPrefixTicks:firstWindow?Math.max(0,firstWindow.fromTick-(firstSample.diagnostics?.simulation?.tick??0)):sampledTickProgress,uncoveredSuffixTicks:lastWindow?Math.max(0,(lastSample.diagnostics?.simulation?.tick??0)-lastWindow.toTick):sampledTickProgress};
  const minuteCoverageComplete=windows.length>=coverage.expectedCompleteMinuteWindows&&coverage.completeDurations&&coverage.sameMatchAndEpoch&&coverage.fullFactionRoster&&coverage.consecutive&&coverage.uncoveredPrefixTicks===0&&coverage.uncoveredSuffixTicks<minuteTicks;
  const requiredAutoTicks:number[]=[];
  for(let tick=(Math.floor(startTick/minuteTicks)+1)*minuteTicks;tick<=(finalDiagnostics?.simulation?.tick??0)-5*balance.rules.simulationHz;tick+=minuteTicks)requiredAutoTicks.push(tick);
  const autosaveContinuity={intervalTicks:minuteTicks,ioGraceSeconds:5,observedTicks:[...observedAutoTicks].sort((a,b)=>a-b),requiredTicks:requiredAutoTicks,missingTicks:requiredAutoTicks.filter(tick=>!observedAutoTicks.has(tick))};
  const capacityActivity={coverage,minuteCoverageComplete,completedMinuteWindows:windows.length,windows,everySurvivingUnitActiveEachMinute:windows.length>0&&windows.every(window=>window.factions.every(faction=>faction.activeSurvivingUnits===faction.survivingUnits)),everyFactionDepositsEachMinute:windows.length>0&&windows.every(window=>window.factions.every(faction=>balance.resourceOrder.some(resource=>faction.depositedMilli[resource]>0)))};
  const nominalSimulationPacing=confirmedNominalPacing();
  const checks={nominalSimulationPacing,observerCaptureComplete:measuredClients.every(client=>!client.failureCode),observerProcessesDistinct:observerMode==='inline'||new Set(measuredClients.map(client=>client.pid)).size===6&&measuredClients.every(client=>client.pid!==process.pid),timingQualificationEligible:!performanceDiagnosticsEnabled&&nominalSimulationPacing,steadyTickProgress:sampledTickProgress>0&&(authoritativeIntervalMs===300?progress.gameTimeFraction>=.99&&progress.completeMinuteWindows.every(window=>window.gameTimeFraction>=.95):Math.abs(progress.missingSimulationMs)<=2000),measuredActivity:!fixture||elapsed<60000||capacityActivity.minuteCoverageComplete&&capacityActivity.everySurvivingUnitActiveEachMinute&&capacityActivity.everyFactionDepositsEachMinute,persistenceHealthy:persistenceSamples.every(sample=>sample.journalHealthy&&!sample.lastError&&sample.warningCount===0),autosaveAdvanced:elapsed<65000||requiredAutoTicks.length>0&&autosaveContinuity.missingTicks.length===0,durationOrCompletedMatch:elapsed>=seconds*1000||profile==='playthrough'&&playthroughComplete,liveReplication:true,chatDelivered,configuredFrameDropsExercised:drop===0||measuredClients.some(client=>client.metrics.droppedReplicationFrames>0),configuredStreamStallsExercised:stallProbability===0||measuredClients.some(client=>client.metrics.headOfLineStalls>0),configuredDeliveryDelayExercised:latencyMs===0||measuredClients.every(client=>client.metrics.maxQueuedDeliveryMs>=latencyMs),sessionReconnect:reconnected&&duplicateAfterReconnect,explicitResync,nonnegativeResources:diagnosticSamples.every(sample=>sample.diagnostics?.simulation?.world?.nonnegativeResources),outageRecovery:outage.completed,nominalCapacity:!fixture||summary.density.atOrAboveNominalFraction===1,gameplay:profile!=='playthrough'||playthroughComplete,terminalReplay:profile!=='playthrough'||terminalReplayVerification?.passed===true,timing:(summary.timing.rollingP95Ms.max??Infinity)<=timingContract.p95Ms&&(summary.timing.rollingP99Ms.max??Infinity)<=timingContract.p99Ms,memoryWithin4GiB:(summary.memory.processRssMiB.max??Infinity)<=4096,memorySteady:seconds<3600||memoryAssessment.status==='no_sustained_growth_detected',meanBandwidth:bandwidth.every(view=>view.meanDownstreamKiBps<=250),fiveModelContexts:endpointMode==='none'||modelReadyAiIds.length===5};
  const requestedQualification=seconds>=3600,localChecksPassed=Object.values(checks).every(Boolean);
  const qualification={capacityAndSoak:profile==='capacity'&&observerMode==='process'&&requestedQualification&&localChecksPassed&&endpointMode==='real'&&outageSeconds>=300&&sampledTickProgress>=72000&&capacityActivity.completedMinuteWindows>=60,playthrough:profile==='playthrough'&&playthroughComplete&&checks.nominalSimulationPacing&&checks.liveReplication&&checks.sessionReconnect&&checks.explicitResync&&checks.nonnegativeResources&&checks.persistenceHealthy&&checks.outageRecovery&&checks.chatDelivered&&checks.terminalReplay,fullAcceptance:false};
  const qualificationPassed=profile==='capacity'?qualification.capacityAndSoak:profile==='playthrough'?qualification.playthrough:false;
  const report={event:'network_profile_recorded',execution,authoritativeIntervalMs,timingContract,overloadPolicy,observerMode,publicationPreparation,snapshotEncoding,computeWorkers,forest,observerProcesses:measuredClients.map(client=>({pid:client.pid,playerId:client.playerId,memory:client.memory,measuredDurationMs:client.measuredDurationMs})),startupTimeline,secrecyAudit,timingQualificationEligible:!performanceDiagnosticsEnabled&&nominalSimulationPacing,performanceDiagnostics:measuredPerformanceDiagnostics,configurationId,runId,profile,requestedQualification,qualificationPassed,qualification,progress,capacityActivity,localChecksPassed,checks,scope:'Six authenticated scripted loopback sessions and five autonomous AI. In-order whole-stream delivery stalls model head-of-line delay; no kernel TCP packets are dropped. Application frame discard is separate. No browser FPS or separate physical-client qualification.',endpointMode,endpointProfile,endpoint,aiPolicies,modelReadyAiIds,outage,summary,memoryAssessment,persistence:{...persistence.persistence,saveWarnings:persistence.warnings,saveCount:persistence.saves.length,diskSamples,terminalReplay,terminalReplayVerification,terminalReplayEvidence:terminalReplayRequested?terminalReplayEvidence:undefined,samples:persistenceSamples,autosaveContinuity},diagnosticSampling:'Approximately one wall-clock second; 300ms complete coordinator-cycle quantiles and legacy50ms core quantiles are rolling worker windows, not pooled global quantiles. Whole-process memory includes gateway, game worker and runner; inline mode also includes observers. Process observers are reported separately.',diagnosticSamples,bandwidth:{includes:'actual received WebSocket message payload bytes, including deliberately discarded application frames; excludes TCP/TLS headers',completedOneSecondBins:completedBins,worstViewP95KiBps:Math.max(...bandwidth.map(view=>view.p95DownstreamKiBps)),views:bandwidth},provenance:fixture?.provenance,playthrough:profile==='playthrough'?{participants:'six scripted human sessions and five autonomous AI; not six real people',telemetry,savedRecovery,result:measuredClients[0]?.view?.result??null,checks:playthroughChecks,complete:playthroughComplete,censored:!playthroughComplete}:undefined,contentHash,engineBuildHash:engineIdentity.engineBuildHash,runtime:engineIdentity.runtimeProfile,hardware:{os:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryMiB:Math.round(os.totalmem()/1048576)},humans:6,ai:5,mapType,populationLimit,requestedSeconds:seconds,durationMs:Math.round(elapsed),cpuTimeMs:Math.round((cpu.user+cpu.system)/1000),rssMiB:Math.round(measuredRss/1048576),liveMeasurement:{closedBeforeTerminalReplay:true,failureCode:liveFailureCode},firstTick:startTick,lastTicks:measuredClients.map(client=>client.view!.tick),impairment:{applicationReplicationFrameDropProbability:drop,oneWayDelayMs:latencyMs,jitterMs,headOfLineStallProbability:stallProbability,headOfLineStallMs:stallMs,seed},recovery:{allClientChatMessagesDelivered:chatDelivered,lostPaidReceiptReplayedExactlyOnce:true,lostReceiptRecoveryMs:Math.round(lostReceiptRecoveryMs),explicitResyncMs:Math.round(resyncRecoveryMs),rotatedSessionReconnectMs:Math.round(reconnectRecoveryMs),duplicatePurchasesVerified:6,duplicateReceiptAfterReconnect:duplicateAfterReconnect},receiptRoundTripMs:{p50:percentile(.5),p95:percentile(.95),max:rtts.at(-1)??null},clients:measuredClients.map(client=>({playerId:client.playerId,hostPlayer:client.hostPlayer,...client.metrics,...(performanceDiagnosticsEnabled?{deliveryDiagnostics:client.deliveryDiagnostics}:{}),latestPopulation:client.view!.self.population,latestTick:client.view!.tick}))};
  await mkdir('runtime-data/qualification',{recursive:true});const reportPath=`runtime-data/qualification/network-${reportStem}.json`;await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({event:report.event,execution,overloadPolicy,configurationId,runId,engineBuildHash:engineIdentity.engineBuildHash,reportPath,requestedQualification,qualificationPassed,localChecksPassed,checks,summary,outage},null,2));
  if(!localChecksPassed)process.exitCode=1;else if(requestedQualification&&!qualificationPassed)process.exitCode=2;

}catch(error){
  startupStage='failure';if(startupSampler){await sampleStartup();await stopStartupSampling();}
  // Capture failures before archival awaits; if live measurement already closed,
  // preserve that same client interval instead of including replay-time traffic.
  const failedClients=measuredClientSnapshot??await captureClientMeasurements(true),failedAt=Math.round(performance.now()-startup);
  const liveFailureCode=measuredClientSnapshot?measuredFailureCode:failure?.message??null;
  const failedEndpoint=measuredEndpointSnapshot===undefined?structuredClone(qualificationEndpoint?.diagnostics()??null):measuredEndpointSnapshot;
  const code=error instanceof Error?error.message:'UNKNOWN_FAILURE';
  if(performanceDiagnosticsEnabled&&measuredPerformanceDiagnostics===undefined)measuredPerformanceDiagnostics=await server?.performanceDiagnostics?.().catch(()=>null);
  const latestDiagnostics=measuredClientSnapshot?diagnosticSamples.at(-1)?.diagnostics??null:await hostDiagnostics().catch(()=>null);
  if(terminalReplayRequested&&!terminalReplayEvidence?.files.length)terminalReplayEvidence=await retainTerminalReplayEvidence({sourceDirectory:join(dataDir,'replays'),archiveDirectory:replayEvidenceDirectory});
  const nominalSimulationPacing=confirmedNominalPacing()&&hasNominalQualificationPacing(latestDiagnostics);
  const report={event:'network_load_failed',execution,authoritativeIntervalMs,timingContract,overloadPolicy,observerMode,publicationPreparation,snapshotEncoding,computeWorkers,forest,provenance:fixture?.provenance,observerProcesses:failedClients.map(client=>({pid:client.pid,playerId:client.playerId,memory:client.memory})),startupTimeline,secrecyAudit,timingQualificationEligible:!performanceDiagnosticsEnabled&&nominalSimulationPacing,performanceDiagnostics:measuredPerformanceDiagnostics,configurationId,runId,profile,populationLimit,contentHash,engineBuildHash:engineIdentity.engineBuildHash,runtime:engineIdentity.runtimeProfile,hardware:{os:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryMiB:Math.round(os.totalmem()/1048576)},diskSamples,elapsedSinceStartupMs:failedAt,endpointMode,endpoint:failedEndpoint,code,requestedSeconds:seconds,seed,mapType,diagnosticSamples,latestDiagnostics,liveMeasurement:{closedBeforeFailure:!!measuredClientSnapshot,failureCode:liveFailureCode},terminalReplayEvidence:terminalReplayRequested?terminalReplayEvidence:undefined,clients:failedClients.map(client=>({playerId:client.playerId,...client.metrics,...(performanceDiagnosticsEnabled?{deliveryDiagnostics:client.deliveryDiagnostics}:{}),lastTick:client.view?.tick,lastMatchEpoch:client.view?.matchEpoch,status:client.view?.status,downstreamBins:client.downstreamBins}))};
  await mkdir('runtime-data/qualification',{recursive:true});const reportPath=`runtime-data/qualification/network-failed-${reportStem}.json`;await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.error(JSON.stringify({event:report.event,execution,overloadPolicy,configurationId,runId,engineBuildHash:engineIdentity.engineBuildHash,reportPath,code:report.code}));process.exitCode=1;
}
finally{
  await stopStartupSampling();for(const client of clients)await client.shutdown();await server?.app.close();await qualificationEndpoint?.close();
  const target=resolve(dataDir),within=relative(temporaryRoot,target);if(!within||within.startsWith('..')||isAbsolute(within))throw new Error('UNSAFE_PROFILE_CLEANUP');
  if(retainData)console.log(JSON.stringify({event:'network_load_retained_data',runId,engineBuildHash:engineIdentity.engineBuildHash,dataDirectory:target,scope:'Private host diagnostics: saves and journals contain authoritative hidden state; not browser/public artifacts.'}));
  else await rm(target,{recursive:true,force:true});
}
