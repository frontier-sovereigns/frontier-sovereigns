import { describe,expect,it,vi } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { once } from 'node:events';
import { createSimulation,createLiveSimulation,restoreLiveSimulation,exportSimulationSave,exportReplay,ReplayRunner,replayCheckpoint,sealSimulationCapture,Simulation,type Unit,type Building,type ResourceNode,type EngineIdentity,type Entity,type SimulationState,type SimulationSavePayload } from './index.js';
import { balance,buildings,units,type GameplayCommand,type PublicPlayer } from '@frontier/shared';
import type { PathPlanningExecutor } from './parallel-path-scheduler.js';
import { createLiveSimulationFacade,detachLiveSimulationRead } from './live-simulation-owner.js';
import { createNativeCommandBatch } from './command-admission-native.js';
import { createNativeProjectionScope,nativeProjectionHeader } from './recipient-projection-native.js';
import type { ProjectionPatch } from './recipient-projection.js';
import { validateSimulationSavePayload } from './save-schema.js';
import { ActiveWorkRoster } from './active-work-roster.js';
import { createNativeCheckpointScope,createNativePathCheckpointScope,postNativeCheckpoint,captureNativeSerializedPathCheckpoint,claimNativeSerializedPathCheckpoint,decodeNativeSerializedPathCheckpoint,discardNativeSerializedPathCheckpoint,hydrateNativeCheckpointMessage } from './checkpoint-native.js';
import { PathWorkerService,serializePathCheckpoint } from '../../../apps/server/src/path-worker-pool.js';
import { changedVisionMaskWords,immutableVisionGroup,immutableVisionSource,type VisionMaskFrame } from './vision-mask-kernel.js';

function fixture(){
  const raw={
    state:{tick:0,entities:{tree:{kind:'resource',amount:100,forest:{cellMm:2000}}},factions:[{id:'a'},{id:'b'}],orders:[] as unknown[],statistics:{food:1}},
    options:{seed:'owned',factions:[{id:'a'}]},
    command(_player:string,input:unknown){raw.state.orders.push(input);return raw.state.statistics;},
    capture(){return raw.state;},
    async stepAsync(){raw.state.tick++;},
  };
  const facade=createLiveSimulationFacade(raw as unknown as Simulation);
  return {raw,facade,view:facade.state as unknown as typeof raw.state};
}

// Independent scalar specification of the established host diagnostic fields.
function hostWorldOracle(state:SimulationState){
  const entities=Object.values(state.entities),actors=entities.filter(entity=>entity.kind!=='resource'),workers=actors.filter((entity):entity is Unit=>entity.kind==='unit'),nodes=entities.filter((entity):entity is ResourceNode=>entity.kind==='resource');
  const factions=state.factions.map(faction=>{const owned=actors.filter(entity=>entity.ownerId===faction.id),army=owned.filter((entity):entity is Unit=>entity.kind==='unit'),structures=owned.filter((entity):entity is Building=>entity.kind==='building'),economy=state.economies[faction.id]!;return {playerId:faction.id,kind:faction.kind,age:economy.age,defeated:economy.defeated,units:army.length,population:army.reduce((sum,entity)=>sum+units[entity.typeId].population,0),nonWallBuildings:structures.filter(entity=>!buildings[entity.typeId].wallEquivalentCells).length,wallEquivalentCells:structures.reduce((sum,entity)=>sum+(buildings[entity.typeId].wallEquivalentCells??0),0),statistics:structuredClone(economy.statistics),collected:{...economy.collected}};});
  return {matchId:state.matchId,matchEpoch:state.matchEpoch,tick:state.tick,world:{units:workers.length,population:factions.reduce((sum,faction)=>sum+faction.population,0),resourceNodes:nodes.length,activeResourceNodes:nodes.filter(entity=>entity.amount>0).length,nonnegativeResources:nodes.every(entity=>entity.amount>=0)&&workers.every(entity=>entity.cargo.amount>=0)&&Object.values(state.economies).every(economy=>Object.values(economy.resources).every(value=>Number.isSafeInteger(value)&&value>=0)),factions},activity:{gathering:workers.filter(entity=>entity.taskState==='gathering').length,returning:workers.filter(entity=>entity.taskState==='returning').length,building:workers.filter(entity=>entity.taskState==='building').length,repairing:workers.filter(entity=>entity.taskState==='repairing').length,blocked:workers.filter(entity=>entity.taskState==='blocked').length,attackCooldownActive:actors.filter(entity=>entity.cooldown>0).length},positions:workers.map(entity=>({id:entity.id,xMm:entity.xMm,zMm:entity.zMm}))};
}

describe('detached host world diagnostics',()=>{
  it('matches every scalar field, samples current generic edits in one world enumeration, and never lends nested state',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'host-aggregate',matchId:'host-aggregate',controllers:false};
    const scalar=createSimulation(options),world=Object.values(scalar.state.entities),workers=world.filter((entity):entity is Unit=>entity.kind==='unit'),tree=world.find((entity):entity is ResourceNode=>entity.kind==='resource')!,home=world.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    for(const [index,taskState]of (['gathering','returning','building','repairing','blocked'] as const).entries())workers[index]!.taskState=taskState;
    workers[0]!.cooldown=9;home.cooldown=5;tree.amount=0;scalar.state.economies.a!.statistics.ageTicks['2']=42;
    const payload=scalar.capture(),live=createLiveSimulation(options,payload),expected=hostWorldOracle(scalar.state);
    expect(live.hostWorldDiagnostics()).toEqual(expected);expect(scalar.hostWorldDiagnostics()).toEqual(expected);
    const before=scalar.capture();
    for(const simulation of [scalar,live]){const sample=simulation.hostWorldDiagnostics();sample.positions[0]!.xMm=-999;sample.world.factions[0]!.statistics.ageTicks['2']=-1;sample.world.factions[0]!.collected.wood=-1;sample.world.factions.length=0;expect(simulation.hostWorldDiagnostics()).toEqual(expected);}
    expect(scalar.capture()).toEqual(before);expect(live.capture()).toEqual(before);
    // Generic callers may mutate records or install readers between samples.
    // Keep one current Object.values scan; do not retain a stale aggregate.
    tree.amount=-1;workers[0]!.cargo.amount=-1;workers[1]!.xMm+=1000;delete scalar.state.entities[workers[2]!.id];scalar.state.economies.b!.resources.food=1.5;
    const changed=hostWorldOracle(scalar.state),raw=scalar.state.entities;let enumerations=0,gets=0;
    scalar.state.entities=new Proxy(raw,{ownKeys(target){enumerations++;return Reflect.ownKeys(target);},get(target,key,receiver){gets++;return Reflect.get(target,key,receiver);}});
    expect(scalar.hostWorldDiagnostics()).toEqual(changed);expect(enumerations).toBe(1);expect(gets).toBe(Object.keys(raw).length);expect(changed.world.nonnegativeResources).toBe(false);
  });
});

describe('live simulation read-only owner interface',()=>{
  it('exposes only frozen allowlisted methods and live read views',async()=>{
    const {raw,facade,view}=fixture();
    expect(Object.isFrozen(facade)).toBe(true);expect(Object.getPrototypeOf(facade)).toBeNull();
    for(const key of ['random','knownStatic','enableReplay','applyJournalEvent','enablePlanningDiagnostics','registerPlanningRefreshDiagnostic','nativeCombatFilter','combatOwnerFilter','orderContext','constructor'])expect((facade as unknown as Record<string,unknown>)[key]).toBeUndefined();
    expect(facade.state).toBe(facade.state);expect(view.entities.tree).toBe(view.entities.tree);
    await facade.stepAsync();expect(view.tick).toBe(1);expect(raw.state.tick).toBe(1);
    expect(()=>{view.tick=99;}).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>{view.entities.tree.amount=0;}).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>Reflect.defineProperty(view.entities.tree,'amount',{value:0})).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>Reflect.deleteProperty(view.entities,'tree')).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>Object.setPrototypeOf(view,{})).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>Object.preventExtensions(view)).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(raw.state.entities.tree.amount).toBe(100);
  });

  it('blocks descriptor, prototype, getter, valueOf and frozen-source escapes',()=>{
    const {raw,facade,view}=fixture();Object.freeze(raw.state.entities.tree.forest);Object.freeze(raw.state.entities.tree);
    const descriptor=Object.getOwnPropertyDescriptor(view.entities,'tree')!;
    expect(descriptor.value).toBe(view.entities.tree);expect(descriptor.writable).toBe(false);
    expect(()=>{descriptor.value.forest.cellMm=8000;}).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(Object.getPrototypeOf(view.entities.tree)).toBeNull();expect((view.entities.tree as unknown as {constructor:unknown}).constructor).toBeUndefined();
    expect(view.entities.tree.valueOf()).toBe(view.entities.tree);
    const stateGetter=Object.getOwnPropertyDescriptor(facade,'state')!.get!;expect(stateGetter.call(raw)).toBe(view);
    const extra=raw.state as unknown as Record<string,unknown>;
    Object.defineProperty(extra,'alias',{enumerable:true,get:()=>raw.state.entities.tree});extra.toJSON=()=>raw;
    const safe=view as unknown as Record<string,unknown>;
    expect(Object.getOwnPropertyDescriptor(safe,'alias')!.get).toBeUndefined();expect(Object.getOwnPropertyDescriptor(safe,'alias')!.value).toBe(view.entities.tree);expect(safe.toJSON).toBeUndefined();
    expect(raw.state.entities.tree.forest.cellMm).toBe(2000);
  });

  it('keeps array callbacks, borrowed methods and iterator results inside the membrane',()=>{
    const {raw,view}=fixture(),factions=view.factions;
    expect(Array.isArray(factions)).toBe(true);expect(Object.getPrototypeOf(factions)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(factions,'length')!.value).toBe(2);
    expect(factions.map((faction,index,array)=>{expect(array).toBe(factions);expect(()=>{faction.id='changed';}).toThrow('LIVE_SIMULATION_READ_ONLY');return index;})).toEqual([0,1]);
    const item=factions.values().next().value!;expect(item).toBe(factions[0]);expect(()=>{item.id='changed';}).toThrow('LIVE_SIMULATION_READ_ONLY');
    const copy=Array.prototype.slice.call(factions) as typeof factions;expect(copy[0]).toBe(factions[0]);expect(()=>{copy[0]!.id='changed';}).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(()=>factions.push({id:'c'})).toThrow('LIVE_SIMULATION_READ_ONLY');expect(()=>Array.prototype.reverse.call(factions)).toThrow('LIVE_SIMULATION_READ_ONLY');
    expect(raw.state.factions).toEqual([{id:'a'},{id:'b'}]);
  });

  it('clones ordinary inputs before mutation and detaches even aliasing custom results',()=>{
    const {raw,facade}=fixture(),command={target:{xMm:1000}};
    const result=facade.command('a',command) as unknown as typeof raw.state.statistics;command.target.xMm=9000;result.food=99;
    expect(raw.state.orders).toEqual([{target:{xMm:1000}}]);expect(raw.state.statistics.food).toBe(1);
    const capture=facade.capture() as unknown as typeof raw.state;capture.entities.tree.amount=0;expect(raw.state.entities.tree.amount).toBe(100);
    expect(()=>facade.command('a',{callback:()=>undefined})).toThrow();expect(raw.state.orders).toHaveLength(1);
  });

  it('detaches mixed diagnostic aggregates for native serialization without cloning on reads',()=>{
    const {raw,view}=fixture(),aggregate={tick:view.tick,statistics:view.statistics,factions:view.factions.map(faction=>faction)};
    const detached=detachLiveSimulationRead(aggregate);expect(()=>structuredClone(detached)).not.toThrow();
    expect(detached).toEqual({tick:0,statistics:{food:1},factions:[{id:'a'},{id:'b'}]});
    detached.statistics.food=9;detached.factions[0]!.id='changed';expect(raw.state.statistics.food).toBe(1);expect(raw.state.factions[0]!.id).toBe('a');
  });

  it('guards method entry, input accessors and async settlement without rescanning on read views',async()=>{
    let guardCalls=0,changed=false,revoke=false;
    const guard=()=>{guardCalls++;if(changed)revoke=true;};
    const raw={state:{tick:0},options:{seed:'owned'},command:()=>{expect(revoke).toBe(true);return {status:'accepted'};},stepAsync:async()=>{await Promise.resolve();changed=true;}};
    const facade=createLiveSimulationFacade(raw as unknown as Simulation,guard);
    void facade.state;void facade.options;expect(guardCalls).toBe(0);
    const input={get changed(){changed=true;return 1;}};facade.command('a',input);expect(revoke).toBe(true);
    changed=false;revoke=false;await facade.stepAsync();expect(revoke).toBe(true);
  });

  it('detaches compute callback inputs and replies so attachments cannot retain simulation aliases',async()=>{
    let attached:PathPlanningExecutor|undefined,vision:Parameters<Simulation['attachVisionExecutor']>[0]|undefined;
    const raw={attachPlanningExecutor:async(executor:PathPlanningExecutor)=>{attached=executor;},attachVisionExecutor:(executor:typeof vision)=>{vision=executor;}};
    const facade=createLiveSimulationFacade(raw as unknown as Simulation),reply={batchId:1,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]};
    const executor={initialize:async()=>reply,advance:async(batch:unknown)=>{(batch as {batchId:number}).batchId=99;return reply;},capture:async()=>({tasks:[]}),dispose:async()=>{}} as unknown as PathPlanningExecutor;
    await facade.attachPlanningExecutor(executor);
    const batch={batchId:1,grants:[],operations:[],geometry:[]},returned=await attached!.advance(batch);expect(batch.batchId).toBe(1);reply.report.work=90;expect(returned.report.work).toBe(0);
    const results=[{key:'allies',visible:[1,2]}],frame={entities:[{xMm:1}]},binding={tick:1};
    facade.attachVisionExecutor((async(input:typeof frame,token:typeof binding)=>{input.entities[0]!.xMm=99;token.tick=99;return results;}) as unknown as Parameters<Simulation['attachVisionExecutor']>[0]);
    const received=await (vision as unknown as (input:typeof frame,token:typeof binding)=>Promise<typeof results>)(frame,binding);
    expect(frame.entities[0]!.xMm).toBe(1);expect(binding.tick).toBe(1);results[0]!.visible[0]=9;expect(received[0]!.visible[0]).toBe(1);
  });

  it('shares only certified immutable vision scalars and certifies privately copied result changes',async()=>{
    let attached:Parameters<Simulation['attachVisionExecutor']>[0]|undefined,received:VisionMaskFrame|undefined;
    const facade=createLiveSimulationFacade({attachVisionExecutor:(executor:typeof attached)=>{attached=executor;}} as unknown as Simulation);
    const group=immutableVisionGroup('a',[immutableVisionSource('town',1000,1000,4000,'building')]);
    const frame:VisionMaskFrame={width:8,height:8,gridMm:1000,cacheKey:'immutable-test',blockerRevision:1,blockers:[{id:'cliff',xMm:5000,zMm:5000,halfWidth:1000,halfHeight:1000}],groups:[group]};
    const binding={matchId:'immutable-test',matchEpoch:1,tick:1,phase:'vision'},mask=new Uint8Array(64);mask[1]=1;
    const result={key:'a',mask,visible:[1]};
    facade.attachVisionExecutor(async input=>{received=input;return [result];});
    const first=(await attached!(frame,binding))[0]!;
    expect(received!.groups[0]).toBe(group);expect(received!.blockers).not.toBe(frame.blockers);
    expect(()=>{received!.groups[0]!.sources[0]!.xMm=9000;}).toThrow();
    expect(()=>{received!.blockers[0]!.xMm=9000;}).toThrow();
    const blockers=received!.blockers;mask[40]=1;result.visible.push(40);
    const second=(await attached!(frame,{...binding,tick:2}))[0]!;
    expect(received!.blockers).toBe(blockers);expect(first.mask[40]).toBe(0);
    expect(changedVisionMaskWords(first.mask,second.mask)).toEqual([1]);
    mask.fill(0);result.visible.length=0;expect(second.mask[40]).toBe(1);expect(second.visible).toEqual([1,40]);
    frame.blockerRevision++;frame.blockers[0]!.xMm=7000;
    await attached!(frame,{...binding,tick:3});expect(received!.blockers).not.toBe(blockers);expect(received!.blockers[0]!.xMm).toBe(7000);
  });

  it('preserves optional combined planner capture without exposing callback input or checkpoint aliases',async()=>{
    let attached:PathPlanningExecutor|undefined;
    const facade=createLiveSimulationFacade({attachPlanningExecutor:async(value:PathPlanningExecutor)=>{attached=value;}} as unknown as Simulation);
    const result={reply:{batchId:1,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]},state:{version:1 as const,tasks:[],regions:[],routes:[],revisions:{},cursor:0}};
    const executor:PathPlanningExecutor={initialize:async()=>result.reply,advance:async()=>result.reply,capture:async()=>result.state,dispose:async()=>{},advanceAndCapture:async batch=>{batch.batchId=99;return result;}};
    await facade.attachPlanningExecutor(executor);
    const batch={batchId:1,grants:[],operations:[],geometry:[]},captured=await attached!.advanceAndCapture!(batch);
    expect(batch.batchId).toBe(1);result.reply.report.work=9;result.state.cursor=9;
    expect(captured.reply.report.work).toBe(0);expect(captured.state.cursor).toBe(0);
    const fallback={...executor};delete fallback.advanceAndCapture;await facade.attachPlanningExecutor(fallback);expect(attached!.advanceAndCapture).toBeUndefined();
  });

  it('detaches autonomous planning series and exposes its bounded stop signal',async()=>{
    let attached:PathPlanningExecutor|undefined,stops=0;
    const facade=createLiveSimulationFacade({attachPlanningExecutor:async(value:PathPlanningExecutor)=>{attached=value;}} as unknown as Simulation);
    const reply={batchId:1,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]},result={leases:[{batchId:1,report:{...reply.report}}],reply};
    const executor:PathPlanningExecutor={initialize:async()=>reply,advance:async()=>reply,capture:async()=>({version:1,tasks:[],regions:[],routes:[],revisions:{},cursor:0}),dispose:async()=>{},advanceService:async(batch,leases,groups)=>{batch.batchId=99;expect(leases).toBe(6);expect(groups).toHaveLength(2);groups![1]![0]!.body.xMm=99;groups![1]![0]!.neighbors[0]!.xMm=99;return result;},stopServiceAfterCurrent:()=>{stops++;}};
    await facade.attachPlanningExecutor(executor);
    const groups=[[],[{profile:'a',geometryRevision:1,body:{id:'u',xMm:1000,zMm:1000,radiusMm:350},target:{xMm:8000,zMm:1000},cellMm:250 as const,neighbors:[{id:'v',xMm:2000,zMm:1000,halfWidth:350,halfHeight:350,circle:true}],localRequestId:1,localOrderRevision:3}]];
    const batch={batchId:1,grants:[],operations:[],geometry:[]},captured=await attached!.advanceService!(batch,6,groups);
    expect(groups[1]![0]!.body.xMm).toBe(1000);expect(groups[1]![0]!.neighbors[0]!.xMm).toBe(2000);
    expect(batch.batchId).toBe(1);result.leases[0]!.report.work=9;result.reply.batchId=7;expect(captured.leases[0]!.report.work).toBe(0);expect(captured.reply.batchId).toBe(1);
    attached!.stopServiceAfterCurrent!();expect(stops).toBe(1);
  });

  it('accounts only detached planner return copying and preserves aliases and failures when timing observers throw',async()=>{
    let attached:PathPlanningExecutor|undefined,finish!:(value:unknown)=>void,now=0,guardCost=false;
    const samples:number[]=[],originalClone=structuredClone,reply={batchId:1,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]},result={leases:[{batchId:1,report:{...reply.report}}],reply};
    const clock=vi.spyOn(performance,'now').mockImplementation(()=>now),clone=vi.spyOn(globalThis,'structuredClone').mockImplementation((value,options)=>{if(value===result)now+=13;return originalClone(value,options);});
    const facade=createLiveSimulationFacade({attachPlanningExecutor:async(value:PathPlanningExecutor)=>{attached=value;}} as unknown as Simulation,()=>{if(guardCost)now+=3;});
    const executor:PathPlanningExecutor={initialize:async()=>reply,advance:async()=>reply,capture:async()=>({version:1,tasks:[],regions:[],routes:[],revisions:{},cursor:0}),dispose:async()=>{},advanceService:()=>new Promise(resolve=>{finish=resolve as (value:unknown)=>void;}),observeCoordinatorWork:duration=>{samples.push(duration);throw new Error('OBSERVER_ONLY');}};
    try{
      await facade.attachPlanningExecutor(executor);guardCost=true;const pending=attached!.advanceService!({batchId:1,grants:[],operations:[],geometry:[]},6);
      now+=5000;expect(samples).toEqual([]);finish(result);const received=await pending;
      expect(samples).toEqual([16]);result.reply.report.work=99;expect(received.reply.report.work).toBe(0);
      // Rejected planner replies retain the same error and still time cleanup.
      const rejected=attached!.advanceService!({batchId:2,grants:[],operations:[],geometry:[]},6);finish(Promise.reject(new Error('PLANNER_FAILED')));
      await expect(rejected).rejects.toThrow('PLANNER_FAILED');expect(samples.at(-1)).toBe(3);
      expect(typeof attached!.observeCoordinatorWork).toBe('function');
    }finally{clock.mockRestore();clone.mockRestore();}
  });

  it('retains only exactly equal privately copied vision masks across callback results',async()=>{
    let vision:Parameters<Simulation['attachVisionExecutor']>[0]|undefined;
    const facade=createLiveSimulationFacade({attachVisionExecutor:(value:typeof vision)=>{vision=value;}} as unknown as Simulation);
    const result={key:'a',mask:Uint8Array.of(1,0,1),visible:[0,2]};
    facade.attachVisionExecutor(async()=>[result]);
    const read=()=>vision!({width:3,height:1,gridMm:2000,cacheKey:'vision',blockerRevision:0,blockers:[],groups:[]},{matchId:'match',matchEpoch:1,tick:0,phase:'vision'});
    const first=(await read())[0]!,same=(await read())[0]!;expect(same).toBe(first);expect(same.mask).not.toBe(result.mask);
    result.mask[1]=1;result.visible=[0,1,2];const changed=(await read())[0]!;
    expect(changed).not.toBe(first);expect(first.mask).toEqual(Uint8Array.of(1,0,1));expect((await read())[0]).toBe(changed);
  });

  it('preserves only genuine opaque command and publication handle identities',()=>{
    const channel=new MessageChannel();
    try{
      const batch=createNativeCommandBatch(channel.port1,[]),scope=createNativeProjectionScope();
      const patch={header:{protocolVersion:2,contentHash:'content',matchId:'match',matchEpoch:1,playerId:'a',tick:0,sequence:1,status:'RUNNING'}} as ProjectionPatch;
      const token=scope.prepare(patch);let received:unknown;
      const raw={drainNativeCommands:(input:unknown)=>{received=input;},publicationTransfers:()=>[token]};
      const facade=createLiveSimulationFacade(raw as unknown as Simulation);facade.drainNativeCommands(batch);
      expect(received).toBe(batch);expect(facade.publicationTransfers([{playerId:'a',sequence:1}])[0]).toBe(token);expect(nativeProjectionHeader(token)).toEqual(patch.header);
      expect(Reflect.ownKeys(token)).toEqual([]);expect(Object.isFrozen(token)).toBe(true);scope.close();
    }finally{channel.port1.close();channel.port2.close();}
  });
});

describe('private live factory gameplay parity',()=>{
  it.each([50,300] as const)('keeps fresh native combat and garrison rosters exact through spawn, death and visibility changes without touching finite resources (%sms)',async authoritativeIntervalMs=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'native-order-actors',matchId:'native-order-actors',controllers:false,sharedVision:false,authoritativeIntervalMs};
    const base=createSimulation({...options,authoritativeIntervalMs:50}),original=Object.values(base.state.entities),template=original.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!;
    base.state.widthMm=128000;base.state.heightMm=128000;base.state.map.terrain=[];base.state.entities={};
    const homes=original.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center');
    for(const home of homes){home.xMm=home.ownerId==='a'?20000:108000;home.zMm=home.xMm;home.garrisoned=[];home.pendingUngarrison=[];base.state.entities[home.id]=home;}
    const home=homes.find(entity=>entity.ownerId==='a')!;
    const add=(id:string,ownerId:string,typeId:Unit['typeId'],xMm:number,zMm:number,changes:Partial<Unit>={}):Unit=>{const entity:Unit={...structuredClone(template),id,ownerId,typeId,xMm,zMm,hp:units[typeId].maxHp,maxHp:units[typeId].maxHp,orders:[],path:[],autoGather:false,stance:'stand_ground',...changes};base.state.entities[id]=entity;return entity;};
    const soldier=add('combat_soldier','a','militia',60000,60000),enemy=add('combat_target','b','militia',61000,60000,{hp:1,cooldown:10});
    const visitor=add('garrison_visitor','a','villager',home.xMm+6750,home.zMm),hidden=add('hidden_enemy','b','militia',108000,90000);
    for(let index=0;index<64;index++){const id=`inert_resource_${index}`;base.state.entities[id]={id,kind:'resource',typeId:'gold_mine',resource:'gold',ownerId:null,xMm:4000+3000*(index%8),zMm:90000+3000*Math.floor(index/8),hp:1,maxHp:1,amount:100000+index};}
    base.state.navigationRevision++;(base as unknown as {updateVision():void}).updateVision();
    home.queue=[{id:'actor_spawn',kind:'train',typeId:'villager',originalCost:{food:50,wood:0,gold:0,stone:0},work:0,required:1,reserved:true,started:true,state:'active'}];
    const payload=base.capture(),scalar=new Simulation(options,payload),live=createLiveSimulation(options,payload),resources=Object.values(payload.state.entities).filter(entity=>entity.kind==='resource');
    const issue=(command:GameplayCommand)=>{const sequence=scalar.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:options.matchId,matchEpoch:scalar.state.matchEpoch,clientCommandId:`actors_${sequence}`,clientSequence:sequence,command};const expected=scalar.command('a',envelope);expect(live.command('a',envelope)).toEqual(expected);expect(expected.status,JSON.stringify(expected)).toBe('accepted');};
    expect(live.view('a').entities.some(entity=>entity.id===enemy.id)).toBe(true);expect(live.view('a').entities.some(entity=>entity.id===hidden.id)).toBe(false);
    issue({kind:'attack_target',unitIds:[soldier.id],targetId:enemy.id,queued:false});issue({kind:'garrison',unitIds:[visitor.id],targetId:home.id,queued:false});
    const advance=async()=>{scalar.advanceFrame();live.advanceFrame();await scalar.synchronizeCapture();await live.synchronizeCapture();expect(live.capture()).toEqual(scalar.capture());for(const faction of factions)expect(live.view(faction.id)).toEqual(scalar.view(faction.id));expect(Object.values(live.capture().state.entities).filter(entity=>entity.kind==='resource')).toEqual(resources);};
    await advance();expect(live.state.entities[enemy.id]).toBeUndefined();expect((live.state.entities[visitor.id] as Unit).garrisonedIn).toBe(home.id);expect(live.state.economies.a!.statistics.unitsTrained).toBe(payload.state.economies.a!.statistics.unitsTrained+1);expect(live.state.economies.b!.statistics.unitsLost).toBe(payload.state.economies.b!.statistics.unitsLost+1);
    expect(live.view('a').entities.some(entity=>entity.id===hidden.id)).toBe(false);expect(live.view('b').entities.some(entity=>entity.id===soldier.id)).toBe(false);
    issue({kind:'ungarrison',buildingId:home.id,unitIds:[visitor.id]});await advance();expect((live.state.entities[visitor.id] as Unit).garrisonedIn).toBeUndefined();
    const captured=live.capture(),cold=createLiveSimulation(options,captured);await advance();cold.advanceFrame();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());
  });

  it('keeps custom and accessor order contexts on their original full-world reader',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],sim=createSimulation({factions,seed:'generic-order-world',matchId:'generic-order-world',controllers:false});
    const internal=sim as unknown as {all():Entity[];orderContext():{entities():readonly Entity[]}},tree=Object.values(sim.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource')!,original=internal.all;
    let kindReads=0,worldReads=0;Object.defineProperty(tree,'kind',{enumerable:true,configurable:true,get:()=>{kindReads++;return 'resource';}});
    internal.all=function(){worldReads++;return original.call(this);};const context=internal.orderContext(),first=context.entities(),firstReads=kindReads;expect(first.includes(tree)).toBe(true);expect(worldReads).toBe(1);expect(firstReads).toBe(0);
    delete sim.state.entities[tree.id];const second=context.entities(),secondReads=kindReads;expect(second.includes(tree)).toBe(false);expect(worldReads).toBe(2);expect(secondReads).toBe(firstReads);
  });

  it.each([false,true])('preserves occupied exits through production, release, demolition and deaths (blocked: %s)',async blocked=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const options={factions,seed:'owned-occupied-exits',matchId:'owned-occupied-exits',controllers:false,authoritativeIntervalMs:300 as const};
    const initial=createSimulation({...options,authoritativeIntervalMs:50}),original=Object.values(initial.state.entities);
    const home=structuredClone(original.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a'&&entity.typeId==='town_center')!);
    const rival=structuredClone(original.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='b'&&entity.typeId==='town_center')!);
    const template=original.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.typeId==='villager')!;
    initial.state.widthMm=128000;initial.state.heightMm=128000;initial.state.map.terrain=[];initial.state.entities={};
    home.xMm=25000;home.zMm=25000;rival.xMm=108000;rival.zMm=108000;
    const doomed:Building={...structuredClone(home),id:'doomed_garrison',xMm:75000};
    for(const building of [home,rival,doomed])initial.state.entities[building.id]=building;
    const addUnit=(id:string,xMm:number,zMm:number,change:Partial<Unit>={}):Unit=>{
      const entity:Unit={...structuredClone(template),id,xMm,zMm,orders:[],path:[],autoGather:false,stance:'stand_ground',...change};initial.state.entities[id]=entity;return entity;
    };
    for(const building of [home,doomed]){
      building.garrisoned=[`${building.id}_one`,`${building.id}_two`];
      for(const id of building.garrisoned)addUnit(id,building.xMm,building.zMm,{garrisonedIn:building.id});
    }
    const half=buildings.town_center.footprintCells[0]*balance.rules.buildingGridM*500,radius=units.villager.collisionRadiusM*1000;
    const first={xMm:home.xMm-half,zMm:home.zMm+half+radius+500},second={xMm:first.xMm,zMm:home.zMm-half-radius-500};
    if(blocked){
      // Every legal perimeter candidate is occupied by a living unit. None of
      // those units moves or attacks; failed exits must remain blocked exactly.
      let next=0;
      for(let x=-half;x<=half;x+=1000)for(const z of [half+radius+500,-half-radius-500])addUnit(`exit_blocker_${next++}`,home.xMm+x,home.zMm+z);
      for(let z=-half;z<=half;z+=1000)for(const x of [half+radius+500,-half-radius-500])addUnit(`exit_blocker_${next++}`,home.xMm+x,home.zMm+z);
    }else addUnit('living_exit_blocker',second.xMm,second.zMm);
    for(const vision of Object.values(initial.state.vision)){vision.memory={};vision.visible=[];vision.explored=[];}
    initial.state.navigationRevision++;initial.step();
    const dead=addUnit('dead_exit_blocker',blocked?90000:first.xMm,blocked?25000:first.zMm,{hp:0});
    const job=(id:string):Building['queue'][number]=>({id,kind:'train',typeId:'villager',originalCost:{food:50,wood:0,gold:0,stone:0},work:0,required:1,reserved:true,started:true,state:'active'});
    home.queue=[job('home_train_one'),job('home_train_two'),job('home_train_three')];doomed.queue=[job('doomed_train')];doomed.demolitionTick=initial.state.tick+2;
    const payload=initial.capture(),scalar=new Simulation(options,payload),live=createLiveSimulation(options,payload),trained=payload.state.economies.a!.statistics.unitsTrained;
    expect(live.hostWorldDiagnostics()).toEqual(hostWorldOracle(scalar.state));
    // Queue release before the restored live owner has built a tick roster.
    // Its first production/release phase must synchronize existing occupants.
    const command={protocolVersion:2 as const,matchId:options.matchId,matchEpoch:initial.state.matchEpoch,clientCommandId:'release_before_tick',clientSequence:1,command:{kind:'ungarrison' as const,buildingId:home.id,unitIds:[...home.garrisoned!]}};
    expect(live.command('a',command)).toEqual(scalar.command('a',command));
    expect(scalar.state.entities[home.id]).toMatchObject({pendingUngarrison:home.garrisoned});
    for(let frame=0;frame<3;frame++){
      scalar.advanceFrame();live.advanceFrame();await scalar.synchronizeCapture();await live.synchronizeCapture();
      expect(live.capture()).toEqual(scalar.capture());expect(live.view('a')).toEqual(scalar.view('a'));expect(live.view('b')).toEqual(scalar.view('b'));
      expect(live.hostWorldDiagnostics()).toEqual(hostWorldOracle(scalar.state));
    }
    expect(live.state.entities[dead.id]).toBeUndefined();expect(live.state.entities[doomed.id]).toBeUndefined();
    for(const id of doomed.garrisoned!){const ejected=live.state.entities[id] as Unit;expect(ejected.garrisonedIn).toBeUndefined();expect(ejected.hp).toBeLessThan(ejected.maxHp);}
    const trainedUnits=Object.values(live.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&!Object.hasOwn(payload.state.entities,entity.id));
    if(blocked){
      expect((live.state.entities[home.id] as Building).queue[0]?.state).toBe('exit_blocked');
      expect(live.state.economies.a!.statistics.unitsTrained-trained).toBe(1);
      for(const id of home.garrisoned!)expect((live.state.entities[id] as Unit).garrisonedIn).toBe(home.id);
    }else{
      expect(live.state.economies.a!.statistics.unitsTrained-trained).toBe(4);
      expect(trainedUnits.some(unit=>unit.xMm===first.xMm&&unit.zMm===first.zMm)).toBe(true);
      for(const id of home.garrisoned!)expect((live.state.entities[id] as Unit).garrisonedIn).toBeUndefined();
    }
    const released=[...home.garrisoned!,...doomed.garrisoned!].map(id=>live.state.entities[id] as Unit).filter(unit=>!unit.garrisonedIn);
    const exterior=[...trainedUnits,...released];
    for(let i=0;i<exterior.length;i++)for(let j=i+1;j<exterior.length;j++)expect(Math.hypot(exterior[i]!.xMm-exterior[j]!.xMm,exterior[i]!.zMm-exterior[j]!.zMm)).toBeGreaterThanOrEqual(radius*2);
  });

  it('keeps coarse work knowledge exact while fog moves, clears destroyed memories and reveals statics',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const options={factions,seed:'coarse-memory-parity',matchId:'coarse-memory-parity',controllers:false,sharedVision:false,authoritativeIntervalMs:300 as const};
    const initial=createSimulation({...options,authoritativeIntervalMs:50}),all=Object.values(initial.state.entities);
    const scout=all.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='scout'&&entity.ownerId==='a')!,worker=all.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager'&&entity.ownerId==='a')!;
    initial.state.map.terrain=[];initial.state.entities={};
    for(const entity of all)if(entity.kind==='building'&&entity.typeId==='town_center'){
      entity.xMm=entity.ownerId==='a'?30000:initial.state.widthMm-30000;entity.zMm=entity.ownerId==='a'?30000:initial.state.heightMm-30000;initial.state.entities[entity.id]=entity;
    }
    scout.xMm=80000-units.scout.visionM*1000-4000;scout.zMm=80000;scout.stance='stand_ground';scout.autoGather=false;
    worker.xMm=50000;worker.zMm=30000;worker.autoGather=false;
    const tree:ResourceNode={id:'remembered_live_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:86000,zMm:80000,hp:1,maxHp:1,amount:200000};
    initial.state.entities[scout.id]=scout;initial.state.entities[worker.id]=worker;initial.state.entities[tree.id]=tree;
    initial.state.navigationRevision++;initial.step();
    initial.state.vision.a!.memory.gone_tree={id:'gone_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:80000,zMm:80000,hp:1,maxHp:1,amount:250,lastSeenTick:0};
    initial.state.vision.a!.memory[tree.id]={id:tree.id,kind:tree.kind,typeId:tree.typeId,resource:'wood',ownerId:null,xMm:tree.xMm,zMm:tree.zMm,hp:1,maxHp:1,amount:100,lastSeenTick:0};
    worker.cargo={resource:'wood',amount:10000};worker.orders=[{kind:'gather',targetId:tree.id,phase:'deposit'}];
    const payload=initial.capture(),scalar=new Simulation(options,payload),live=createLiveSimulation(options,payload);
    const envelope={protocolVersion:2 as const,matchId:options.matchId,matchEpoch:initial.state.matchEpoch,clientCommandId:'reveal_memories',clientSequence:1,command:{kind:'move' as const,unitIds:[scout.id],target:{xMm:tree.xMm-units.scout.visionM*1000+4000,zMm:tree.zMm},queued:false}};
    expect(live.command('a',envelope)).toEqual(scalar.command('a',envelope));expect(live.view('a').entities.find(entity=>entity.id==='gone_tree')?.ghost).toBe(true);
    const masks=new Set<string>();let emptySiteObserved=false,treeRevealed=false;
    for(let frame=0;frame<12;frame++){
      scalar.advanceFrame();live.advanceFrame();await scalar.synchronizeCapture();await live.synchronizeCapture();
      expect(live.capture()).toEqual(scalar.capture());expect(live.view('a')).toEqual(scalar.view('a'));expect(live.view('b')).toEqual(scalar.view('b'));
      const view=live.view('a');masks.add(view.fog.visible.join(','));
      emptySiteObserved ||= !Object.hasOwn(live.state.vision.a!.memory,'gone_tree');
      treeRevealed ||= view.entities.some(entity=>entity.id===tree.id&&!entity.ghost);
    }
    expect(masks.size).toBeGreaterThan(3);expect(emptySiteObserved).toBe(true);expect(treeRevealed).toBe(true);
    expect(live.state.vision.a!.memory.gone_tree).toBeUndefined();expect(live.view('a').entities.find(entity=>entity.id===tree.id)?.amount).toBe(200);
  });

  it.each([false,true])('keeps coarse work exact through depletion, archived nodes, gate changes and geometry removal (barrier: %s)',async barrier=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const options={factions,seed:'coarse-work-parity',matchId:'coarse-work-parity',controllers:false,sharedVision:false,authoritativeIntervalMs:300 as const};
    const initial=createSimulation({...options,authoritativeIntervalMs:50}),original=Object.values(initial.state.entities);
    const template=original.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager'&&entity.ownerId==='a')!;
    initial.state.map.terrain=[];initial.state.entities={};
    for(const entity of original)if(entity.kind==='building'&&entity.typeId==='town_center'){
      entity.xMm=entity.ownerId==='a'?30000:initial.state.widthMm-30000;entity.zMm=entity.ownerId==='a'?30000:initial.state.heightMm-30000;initial.state.entities[entity.id]=entity;
    }
    const addBuilding=(id:string,typeId:Building['typeId'],xMm:number,zMm:number,change:Partial<Building>={}):Building=>{
      const definition=buildings[typeId],entity:Building={id,kind:'building',typeId,ownerId:'a',xMm,zMm,hp:definition.maxHp,maxHp:definition.maxHp,rotation:0,work:1000,required:1000,grantedHp:definition.maxHp,queue:[],cooldown:0,...change};initial.state.entities[id]=entity;return entity;
    };
    const addWorker=(id:string,xMm:number,zMm:number,order:Unit['orders'][number],change:Partial<Unit>={}):Unit=>{
      const entity:Unit={...structuredClone(template),id,xMm,zMm,orders:[order],path:[],cargo:{resource:null,amount:0},gatherRemainder:0,autoGather:false,stance:'stand_ground',...change};initial.state.entities[id]=entity;return entity;
    };
    const tree:ResourceNode={id:'work_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:60000,zMm:40000,hp:1,maxHp:1,amount:100000};
    const gold:ResourceNode={...tree,id:'work_gold',typeId:'gold_mine',resource:'gold',xMm:80000,amount:100000};
    initial.state.entities[tree.id]=tree;initial.state.entities[gold.id]=gold;
    const lumberWorker=addWorker('lumber_worker',tree.xMm-1800,tree.zMm,{kind:'gather',targetId:tree.id,phase:'gather'});
    const miner=addWorker('miner',gold.xMm-1800,gold.zMm,{kind:'gather',targetId:gold.id,phase:'gather'});
    const farm=addBuilding('work_farm','farm',60000,60000,{foodRemaining:100000}),halfFarm=buildings.farm.footprintCells[0]*balance.rules.buildingGridM*500;
    addWorker('farmer',farm.xMm+halfFarm+600,farm.zMm,{kind:'gather',targetId:farm.id,phase:'gather'});
    const foundation=addBuilding('work_house','house',80000,60000,{work:0,hp:60,grantedHp:60});
    addWorker('builder',foundation.xMm+buildings.house.footprintCells[0]*balance.rules.buildingGridM*500+600,foundation.zMm,{kind:'build',targetId:foundation.id});
    const repaired=addBuilding('repair_house','house',100000,60000,{hp:buildings.house.maxHp-20});
    addWorker('repairer',repaired.xMm+buildings.house.footprintCells[0]*balance.rules.buildingGridM*500+600,repaired.zMm,{kind:'repair',targetId:repaired.id});
    const camp=addBuilding('work_dropoff','lumber_camp',60000,80000);
    const gate=addBuilding('archive_gate','wooden_gate',90000,90000,{gateMode:'LOCKED',gateOpen:false});
    // Exhausted resources remain serialized/fog history while the native
    // physical index contains only live obstacles. Put archived nodes beside
    // working and travelling actors, not just in an irrelevant distant corner.
    for(let index=0;index<512;index++){
      const resource=(['wood','food','gold','stone'] as const)[index%4]!,id=`archived_node_${index}`;
      initial.state.entities[id]={...tree,id,typeId:resource==='wood'?'tree':resource==='food'?'berry_bush':resource==='gold'?'gold_mine':'stone_mine',resource,amount:0,xMm:40000+(index%32)*2000,zMm:35000+Math.floor(index/32)*3000};
    }
    const depositor=addWorker('depositor',camp.xMm+buildings.lumber_camp.footprintCells[0]*balance.rules.buildingGridM*500+600,camp.zMm,{kind:'gather',targetId:tree.id,phase:'deposit'},{cargo:{resource:'wood',amount:1000}});
    initial.state.navigationRevision++;initial.step();
    // Changes are made before the live factory owns its detached state. No test
    // hooks can accidentally disable its private cache certification.
    gold.amount=2;farm.foodRemaining=2;foundation.work=foundation.required-200;camp.demolitionTick=initial.state.tick+3;
    lumberWorker.orders=[{kind:'gather',targetId:tree.id,phase:'gather'}];miner.orders=[{kind:'gather',targetId:gold.id,phase:'gather'}];
    depositor.cargo={resource:'wood',amount:1000};depositor.orders=[{kind:'gather',targetId:tree.id,phase:'deposit'}];depositor.path=[];
    addWorker('moving_depositor',camp.xMm+10000,camp.zMm+3000,{kind:'gather',targetId:tree.id,phase:'deposit'},{cargo:{resource:'wood',amount:1000},path:[{xMm:camp.xMm+5000,zMm:camp.zMm+3000}]});
    if(barrier)addBuilding('work_barrier','palisade_wall',tree.xMm-1000,tree.zMm,{demolitionTick:initial.state.tick+3});
    initial.state.navigationRevision++;
    const payload=initial.capture(),scalar=new Simulation(options,payload),live=createLiveSimulation(options,payload),before=scalar.state.economies.a!.collected.wood;
    for(let frame=0;frame<4;frame++){
      if(frame===1||frame===2){
        const sequence=scalar.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:options.matchId,matchEpoch:scalar.state.matchEpoch,clientCommandId:`archive_gate_${frame}`,clientSequence:sequence,command:{kind:'set_gate_mode',gateId:gate.id,mode:frame===1?'OPEN':'LOCKED'}};
        const receipt=scalar.command('a',envelope);expect(live.command('a',envelope)).toEqual(receipt);expect(receipt.status).toBe('accepted');
      }
      scalar.advanceFrame();live.advanceFrame();await scalar.synchronizeCapture();await live.synchronizeCapture();
      expect(live.capture()).toEqual(scalar.capture());
      expect(live.view('a')).toEqual(scalar.view('a'));expect(live.view('b')).toEqual(scalar.view('b'));
      expect(live.hostWorldDiagnostics()).toEqual(hostWorldOracle(scalar.state));
      expect((live.state.entities[gate.id] as Building).gateOpen).toBe(frame===1);
    }
    expect((live.state.entities[gold.id] as ResourceNode).amount,JSON.stringify(live.state.entities.miner)).toBe(0);
    expect((live.state.entities[farm.id] as Building).foodRemaining).toBe(0);
    expect((live.state.entities[foundation.id] as Building).work).toBe(foundation.required);
    expect((live.state.entities[repaired.id] as Building).hp).toBeGreaterThan(repaired.hp);
    expect(live.state.entities[camp.id]).toBeUndefined();expect(live.state.entities.work_barrier).toBeUndefined();
    if(!barrier)expect((live.state.entities[tree.id] as ResourceNode).amount).toBeLessThan(tree.amount);
    expect(live.state.economies.a!.collected.wood).toBeGreaterThanOrEqual(before+1000);
    expect((live.state.entities.moving_depositor as Unit).xMm).not.toBe((payload.state.entities.moving_depositor as Unit).xMm);
    const archived=(state:SimulationState)=>Object.values(state.entities).filter(entity=>entity.id.startsWith('archived_node_'));
    const saved=live.capture();expect(archived(saved.state)).toEqual(archived(payload.state));expect(archived(saved.state)).toHaveLength(512);
    const cold=createLiveSimulation(options,saved);
    for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(cold.capture()).toEqual(live.capture());expect(live.capture()).toEqual(scalar.capture());
    for(const playerId of ['a','b']){expect(cold.view(playerId)).toEqual(live.view(playerId));expect(live.view(playerId)).toEqual(scalar.view(playerId));}
  });

  it('hands off independent captures without aliasing live state, inputs or earlier snapshots',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const live=createLiveSimulation({factions,seed:'capture-ownership',matchId:'capture-ownership',controllers:false});
    const baseline=live.capture(),first=live.capture(),initial=live.initialCapture();
    first.state.tick=999;first.state.economies.a!.resources.food=0;
    const resource=Object.values(first.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource')!;resource.amount=0;
    first.runtime.pathScheduler.tasks.length=0;first.runtime.planningProfiles.length=0;
    initial.state.factions[0]!.name='changed';factions[0]!.name='input changed';
    expect(live.capture()).toEqual(baseline);
    expect(live.initialCapture().state.factions[0]!.name).toBe('A');
    live.setStatus('RUNNING');live.step();expect(baseline.state.tick).toBe(0);expect(live.capture().state.tick).toBe(1);
  });

  it('emits native checkpoints with exactly one IPC snapshot boundary, preserving public order and independent captures',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const options={factions,seed:'native-capture',matchId:'native-capture',controllers:false,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options),channel=new MessageChannel();
    try{
      live.setStatus('RUNNING');live.advanceFrame();await live.synchronizeCapture();const expected=live.capture();
      const incoming=once(channel.port2,'message'),clone=structuredClone;let worldCopies=0,pathCopies=0;
      const spy=vi.spyOn(globalThis,'structuredClone').mockImplementation((value,transfer)=>{const row=value as {entities?:unknown;factions?:unknown;version?:number;tasks?:unknown;regions?:unknown}|null;if(row?.entities&&row.factions)worldCopies++;if(row?.version===1&&Array.isArray(row.tasks)&&Array.isArray(row.regions))pathCopies++;return clone(value,transfer);});
      try{expect(live.postNativeCapture(channel.port1,{type:'checkpoint',autosave:true})).toBe(true);expect(worldCopies).toBe(0);expect(pathCopies).toBe(0);}finally{spy.mockRestore();}
      // Mutation happens before delivery but after the synchronous native copy.
      live.advanceFrame();await live.synchronizeCapture();
      const [packet]=await incoming;expect(packet.type).toBe('checkpoint');expect(packet.autosave).toBe(true);expect(packet.payload).toEqual(expected);expect(JSON.stringify(packet.payload)).toBe(JSON.stringify(expected));
      const current=live.capture();packet.payload.state.economies.a.resources.food=0;packet.payload.runtime.pathScheduler.tasks.length=0;packet.payload.runtime.planningProfiles.length=0;expect(live.capture()).toEqual(current);
      const next=once(channel.port2,'message');expect(live.postNativeCapture(channel.port1,{type:'reply',id:7})).toBe(true);expect(await next).toEqual([{id:7,value:current,error:undefined}]);expect(expected.state.tick).toBe(6);
    }finally{channel.port1.close();channel.port2.close();}
  });

  it('keeps real-service checkpoint bytes opaque until receipt with exact capture, cold save and replay parity',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'native-byte-capture',matchId:'native-byte-capture',controllers:false,authoritativeIntervalMs:300 as const};
    const identity:EngineIdentity={engineBuildHash:'7'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},live=createLiveSimulation(options),service=new PathWorkerService({workerCount:2}),channel=new MessageChannel();
    try{
      await live.attachPlanningExecutor(service);live.setPlanningServiceLeases(1);live.setStatus('RUNNING');await live.advanceFrameAsync();
      const clone=structuredClone;let pathGraphCopies=0;const spy=vi.spyOn(globalThis,'structuredClone').mockImplementation((value,transfer)=>{const item=value as {version?:number;tasks?:unknown;regions?:unknown}|null;if(item?.version===1&&Array.isArray(item.tasks)&&Array.isArray(item.regions))pathGraphCopies++;return clone(value,transfer);});
      let packet:any;
      try{await live.synchronizeCapture();const incoming=once(channel.port2,'message');expect(live.postNativeCapture(channel.port1,{type:'checkpoint',autosave:true})).toBe(true);packet=(await incoming)[0];expect(pathGraphCopies).toBe(0);}finally{spy.mockRestore();}
      expect(packet.type).toBe('native-checkpoint');expect(packet.body.runtime).not.toHaveProperty('pathScheduler');expect(packet.serialized.data).toBeInstanceOf(ArrayBuffer);
      const expected=live.capture(),received=hydrateNativeCheckpointMessage(packet) as {type:string;payload:SimulationSavePayload;autosave:boolean};
      expect(received).toEqual({type:'checkpoint',payload:expected,autosave:true});expect(JSON.stringify(received.payload)).toBe(JSON.stringify(expected));expect(validateSimulationSavePayload(received.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
      const cold=restoreLiveSimulation(sealSimulationCapture(received.payload,identity),identity,{preserveEpoch:true});expect(cold.capture()).toEqual(expected);
      const replay=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(replay.advanceTo(live.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(expected);
      // Receiver corruption cannot mutate cached bytes, and a repeat capture
      // neither advances a lease nor changes the journal boundary.
      new Uint8Array(packet.serialized.data).fill(0);received.payload.runtime.pathScheduler.tasks.length=0;received.payload.state.economies.a!.resources.food=0;
      const ordinal=live.state.eventOrdinal,next=once(channel.port2,'message');expect(live.postNativeCapture(channel.port1,{type:'reply',id:7})).toBe(true);
      expect(hydrateNativeCheckpointMessage((await next)[0])).toEqual({id:7,value:expected,error:undefined});expect(live.state.eventOrdinal).toBe(ordinal);expect(live.capture()).toEqual(expected);
      live.invalidateEpoch();await live.synchronizeCapture();const afterEpoch=once(channel.port2,'message');live.postNativeCapture(channel.port1,{type:'reply',id:8});const epochPacket=(await afterEpoch)[0];expect(epochPacket.binding.matchEpoch).toBe(expected.state.matchEpoch+1);expect((hydrateNativeCheckpointMessage(epochPacket) as {value:SimulationSavePayload}).value).toEqual(live.capture());
    }finally{await service.dispose();channel.port1.close();channel.port2.close();}
  },20000);

  it('consumes serialized checkpoint ownership without exposing buffers or trusting caller-owned handles',async()=>{
    const path={version:1 as const,tasks:[],regions:[],routes:[],revisions:{},cursor:0},packet=serializePathCheckpoint(path),alias=new Uint8Array(packet.data),first=captureNativeSerializedPathCheckpoint(packet);
    expect(packet.data.byteLength).toBe(0);expect(alias.byteLength).toBe(0);expect(Object.keys(first)).toEqual([]);expect(Object.isFrozen(first)).toBe(true);
    const claimed=claimNativeSerializedPathCheckpoint(first);expect(()=>decodeNativeSerializedPathCheckpoint(first)).toThrow('INVALID_NATIVE_CHECKPOINT');expect(()=>claimNativeSerializedPathCheckpoint({} as never)).toThrow('INVALID_NATIVE_CHECKPOINT');
    const a=decodeNativeSerializedPathCheckpoint(claimed);a.cursor=99;expect(decodeNativeSerializedPathCheckpoint(claimed)).toEqual(path);discardNativeSerializedPathCheckpoint(claimed);expect(()=>decodeNativeSerializedPathCheckpoint(claimed)).toThrow('INVALID_NATIVE_CHECKPOINT');
    const raw=serializePathCheckpoint(path);let hooks=0;const getter={format:raw.format,byteLength:raw.byteLength,get data(){hooks++;return raw.data;}};
    for(const value of [getter,new Proxy(raw,{ownKeys(){hooks++;return [];}}),{...raw,data:new SharedArrayBuffer(raw.byteLength)},{...raw,data:new Uint8Array(raw.data)},{...raw,byteLength:raw.byteLength+1}])expect(()=>captureNativeSerializedPathCheckpoint(value)).toThrow('INVALID_PATH_CAPTURE_ENCODING');
    expect(hooks).toBe(0);expect(raw.data.byteLength).toBe(raw.byteLength);
    let attached:PathPlanningExecutor|undefined,guards=0;const facade=createLiveSimulationFacade({attachPlanningExecutor:async(value:PathPlanningExecutor)=>{attached=value;}} as unknown as Simulation,()=>{guards++;});
    let offered= captureNativeSerializedPathCheckpoint(serializePathCheckpoint(path));const reply={batchId:1,report:{work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0},mirrors:[]};
    const executor:PathPlanningExecutor={initialize:async()=>reply,advance:async()=>reply,capture:async()=>path,dispose:async()=>{},captureNativeCheckpoint:async()=>offered,advanceAndCaptureNative:async batch=>{batch.batchId=99;return {reply,checkpoint:offered};}};
    await facade.attachPlanningExecutor(executor);const captured=await attached!.captureNativeCheckpoint!();expect(()=>decodeNativeSerializedPathCheckpoint(offered)).toThrow('INVALID_NATIVE_CHECKPOINT');expect(decodeNativeSerializedPathCheckpoint(captured)).toEqual(path);
    offered=captureNativeSerializedPathCheckpoint(serializePathCheckpoint(path));const batch={batchId:1,grants:[],operations:[],geometry:[]},result=await attached!.advanceAndCaptureNative!(batch);expect(batch.batchId).toBe(1);reply.report.work=9;expect(result.reply.report.work).toBe(0);expect(decodeNativeSerializedPathCheckpoint(result.checkpoint)).toEqual(path);expect(guards).toBeGreaterThan(3);
    discardNativeSerializedPathCheckpoint(captured);discardNativeSerializedPathCheckpoint(result.checkpoint);
  });

  it('binds serialized captures to the committed epoch, tick, ordinal and mode and consumes failed sends',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],payload=createSimulation({factions,seed:'native-byte-binding',matchId:'native-byte-binding',controllers:false}).capture();
    const {pathScheduler,...runtime}=payload.runtime,body={...payload,runtime},owner=captureNativeSerializedPathCheckpoint(serializePathCheckpoint(pathScheduler)),scope=createNativeCheckpointScope(),paths=createNativePathCheckpointScope(),channel=new MessageChannel();
    const prepare=()=>scope.prepare(body,paths.prepareSerialized(owner));
    try{
      const stale=prepare();body.state.tick++;expect(()=>postNativeCheckpoint(stale,channel.port1,{type:'reply',id:1})).toThrow('INVALID_NATIVE_CHECKPOINT');body.state.tick--;
      const incoming=once(channel.port2,'message'),handle=prepare(),constructor=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'constructor')!;let constructors=0;
      try{Object.defineProperty(ArrayBuffer.prototype,'constructor',{configurable:true,get(){constructors++;throw new Error('SPECIES_CALLBACK');}});postNativeCheckpoint(handle,channel.port1,{type:'reply',id:2});expect(constructors).toBe(0);}finally{Object.defineProperty(ArrayBuffer.prototype,'constructor',constructor);}
      const wire=(await incoming)[0];
      for(const [field,value]of [['matchId','another'],['matchEpoch',2],['tick',1],['eventOrdinal',1],['authoritativeIntervalMs',300],['localPlanningMode','deferred-v1']] as const){const changed=structuredClone(wire);changed.binding[field]=value;expect(()=>hydrateNativeCheckpointMessage(changed)).toThrow('INVALID_NATIVE_CHECKPOINT');}
      expect(hydrateNativeCheckpointMessage(wire)).toEqual({id:2,value:payload,error:undefined});
      const broken={...body,state:{...body.state,uncloneable:()=>undefined}},failed=scope.prepare(broken,paths.prepareSerialized(owner));expect(()=>postNativeCheckpoint(failed,channel.port1,{type:'reply',id:3})).toThrow();delete (broken.state as {uncloneable?:unknown}).uncloneable;expect(()=>postNativeCheckpoint(failed,channel.port1,{type:'reply',id:3})).toThrow('INVALID_NATIVE_CHECKPOINT');
      expect(decodeNativeSerializedPathCheckpoint(owner)).toEqual(pathScheduler);
    }finally{scope.close();paths.close();discardNativeSerializedPathCheckpoint(owner);channel.port1.close();channel.port2.close();}
  });

  it('cold-restores and replays native checkpoints without changing the committed journal boundary',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'native-cold',matchId:'native-cold',controllers:false,authoritativeIntervalMs:300 as const};
    const identity:EngineIdentity={engineBuildHash:'7'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},live=createLiveSimulation(options),channel=new MessageChannel();
    try{
      live.setStatus('RUNNING');for(let frame=0;frame<2;frame++){live.advanceFrame();await live.synchronizeCapture();}
      const ordinal=live.state.eventOrdinal,incoming=once(channel.port2,'message');expect(live.postNativeCapture(channel.port1,{type:'reply',id:1})).toBe(true);
      const saved=(await incoming)[0].value as SimulationSavePayload;expect(validateSimulationSavePayload(saved),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);expect(live.state.eventOrdinal).toBe(ordinal);
      const cold=restoreLiveSimulation(sealSimulationCapture(saved,identity),identity,{preserveEpoch:true});expect(cold.capture()).toEqual(saved);
      const replay=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(replay.advanceTo(live.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(saved);
      for(const item of [live,cold]){item.advanceFrame();await item.synchronizeCapture();}expect(cold.capture()).toEqual(live.capture());
    }finally{channel.port1.close();channel.port2.close();}
  });

  it('keeps native checkpoint capabilities one-use and rejects callback ports, envelope reentry and reuse after send failure',async()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],payload=createSimulation({factions,seed:'native-capability',matchId:'native-capability',controllers:false}).capture();
    const {pathScheduler,...runtime}=payload.runtime,body={...payload,runtime},scope=createNativeCheckpointScope(),pathScope=createNativePathCheckpointScope(),channel=new MessageChannel();
    const prepare=()=>scope.prepare(body,pathScope.prepare(pathScheduler));
    try{
      let calls=0;const handle=prepare();expect(()=>postNativeCheckpoint(handle,{hasRef(){calls++;return true;},postMessage(){calls++;}} as never,{type:'checkpoint',autosave:true})).toThrow('INVALID_NATIVE_CHECKPOINT_PORT');expect(calls).toBe(0);
      const proxy=new Proxy({type:'reply',id:1},{getOwnPropertyDescriptor(){calls++;return undefined;}});expect(()=>postNativeCheckpoint(handle,channel.port1,proxy as never)).toThrow('INVALID_NATIVE_CHECKPOINT_ENVELOPE');expect(calls).toBe(0);
      const accessor={type:'reply',get id(){calls++;return 1;}};expect(()=>postNativeCheckpoint(handle,channel.port1,accessor as never)).toThrow('INVALID_NATIVE_CHECKPOINT_ENVELOPE');expect(calls).toBe(0);
      // A user-installed port method cannot receive the private snapshot.
      Object.defineProperty(channel.port1,'postMessage',{value:()=>{calls++;throw new Error('CALLER_CALLBACK');},configurable:true});
      const incoming=once(channel.port2,'message');postNativeCheckpoint(handle,channel.port1,{type:'reply',id:3});expect((await incoming)[0].value).toEqual(payload);expect(calls).toBe(0);expect(()=>postNativeCheckpoint(handle,channel.port1,{type:'reply',id:3})).toThrow('INVALID_NATIVE_CHECKPOINT');
      const revoked=prepare();pathScope.invalidate();expect(()=>postNativeCheckpoint(revoked,channel.port1,{type:'reply',id:4})).toThrow('INVALID_NATIVE_CHECKPOINT');
      const broken={...body,state:{...body.state,uncloneable:()=>undefined}},failed=scope.prepare(broken,pathScope.prepare(pathScheduler));expect(()=>postNativeCheckpoint(failed,channel.port1,{type:'reply',id:5})).toThrow();delete (broken.state as {uncloneable?:unknown}).uncloneable;expect(()=>postNativeCheckpoint(failed,channel.port1,{type:'reply',id:5})).toThrow('INVALID_NATIVE_CHECKPOINT');
      const closed=prepare();scope.close();expect(()=>postNativeCheckpoint(closed,channel.port1,{type:'reply',id:6})).toThrow('INVALID_NATIVE_CHECKPOINT');expect(()=>scope.prepare(body,pathScope.prepare(pathScheduler))).toThrow('INVALID_NATIVE_CHECKPOINT');
    }finally{scope.close();pathScope.close();channel.port1.close();channel.port2.close();}
  });

  it('falls back from native checkpoint emission after factory ownership is revoked and for ordinary public simulations',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'native-revoked',matchId:'native-revoked',controllers:false},live=createLiveSimulation(options),generic=createSimulation(options),channel=new MessageChannel();
    try{
      expect(generic.postNativeCapture(channel.port1,{type:'reply',id:1})).toBe(false);
      const baseline=live.capture(),method=vi.spyOn(Simulation.prototype,'capture');try{expect(live.postNativeCapture(channel.port1,{type:'reply',id:2})).toBe(false);}finally{method.mockRestore();}
      expect(live.postNativeCapture(channel.port1,{type:'reply',id:3})).toBe(false);const detached=live.capture();expect(detached).toEqual(baseline);detached.state.tick=99;expect(live.capture()).toEqual(baseline);
    }finally{channel.port1.close();channel.port2.close();}
  });

  it('retains owned exploration through changing current fog while refreshing static sightings every contact slice',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'owned-exploration',matchId:'owned-exploration',controllers:false,sharedVision:false};
    const initial=createSimulation(options),all=Object.values(initial.state.entities),scout=all.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='scout'&&entity.ownerId==='a')!;
    initial.state.widthMm=64000;initial.state.heightMm=64000;initial.state.map.terrain=[];initial.state.entities={};
    for(const home of all.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center')){home.xMm=home.ownerId==='a'?10000:54000;home.zMm=54000;initial.state.entities[home.id]=home;}
    scout.xMm=9000;scout.zMm=16000;scout.stance='stand_ground';scout.orders=[];scout.path=[];initial.state.entities[scout.id]=scout;
    const tree:ResourceNode={id:'watched_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:12000,zMm:20000,hp:1,maxHp:1,amount:100000};initial.state.entities[tree.id]=tree;
    for(const faction of factions)initial.state.vision[faction.id]!.explored=Array.from({length:32*32},(_,cell)=>cell);
    initial.state.navigationRevision++;initial.step();
    const payload=initial.capture(),generic=new Simulation(options,payload),live=createLiveSimulation(options,payload),command={protocolVersion:2 as const,matchId:initial.state.matchId,matchEpoch:initial.state.matchEpoch,clientCommandId:'fog_move',clientSequence:1,command:{kind:'move' as const,unitIds:[scout.id],target:{xMm:24000,zMm:16000},queued:false}};
    expect(live.command('a',command).status).toBe('accepted');expect(generic.command('a',command).status).toBe('accepted');
    live.step();generic.step();const explored=live.state.vision.a!.explored,visible=live.state.vision.a!.visible;
    expect(explored).not.toBe(live.state.vision.b!.explored);
    for(let tick=0;tick<16;tick++){
      live.step();generic.step();expect(live.capture()).toEqual(generic.capture());expect(live.view('a')).toEqual(generic.view('a'));
      expect(live.state.vision.a!.explored).toBe(explored);expect(live.state.vision.a!.memory[tree.id]!.lastSeenTick).toBe(live.state.tick);
    }
    expect(live.state.vision.a!.visible).not.toBe(visible);expect((live.state.entities[scout.id] as Unit).xMm).toBeGreaterThan(scout.xMm);
  });

  it('keeps self-restoring constructor hooks on the conservative mutable path',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'live-owner-hook',matchId:'live-owner-hook',controllers:false};
    const prototype=Simulation.prototype as unknown as {all():Entity[]},original=prototype.all;let escaped:Simulation|undefined;
    prototype.all=function(this:Simulation){escaped=this;prototype.all=original;return original.call(this);};
    try{
      const live=createLiveSimulation(options),raw=escaped!,reference=new Simulation(options,raw.capture());
      const visible=new Set(live.view('a').entities.map(entity=>entity.id)),resource=Object.values(raw.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource'&&visible.has(entity.id))!;
      live.publicationProjections([{playerId:'a',sequence:1}]);reference.publicationProjections([{playerId:'a',sequence:1}]);
      resource.xMm+=1000;(reference.state.entities[resource.id] as ResourceNode).xMm+=1000;
      live.step();reference.step();expect(live.capture()).toEqual(reference.capture());expect(live.view('a')).toEqual(reference.view('a'));
      expect(live.publicationProjections([{playerId:'a',sequence:2}])).toEqual(reference.publicationProjections([{playerId:'a',sequence:2}]));
    }finally{prototype.all=original;}
  });

  it.each(['before','after'] as const)('revokes private work ownership for a replaced static roster factory %s live creation',async when=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}],options={factions,seed:'work-owner-hook',matchId:'work-owner-hook',controllers:false,authoritativeIntervalMs:300 as const};
    const initial=createSimulation(options);
    initial.state.map.terrain=[];
    for(const [id,entity]of Object.entries(initial.state.entities))if(entity.kind==='resource')delete initial.state.entities[id];else if(entity.kind==='unit'){entity.orders=[];entity.path=[];entity.autoGather=false;}
    initial.state.navigationRevision++;
    const payload=initial.capture(),reference=new Simulation(options,payload),original=ActiveWorkRoster.create;
    const hook=vi.fn((actors:readonly Entity[],frame:number)=>original.call(ActiveWorkRoster,actors,frame));
    let live:ReturnType<typeof createLiveSimulation>|undefined;
    try{
      if(when==='after')live=createLiveSimulation(options,payload);
      ActiveWorkRoster.create=hook;
      live??=createLiveSimulation(options,payload);
      live.advanceFrame();reference.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();
      // Calling the replacement would lend inaccessible authoritative records to
      // arbitrary code even if its return value is an otherwise valid roster.
      expect(hook).not.toHaveBeenCalled();expect(live.capture()).toEqual(reference.capture());
      ActiveWorkRoster.create=original;
      live.advanceFrame();reference.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();
      expect(live.capture()).toEqual(reference.capture());
    }finally{ActiveWorkRoster.create=original;}
  });

  it('matches generic commands, depletion, construction cancellation, publication and restored continuation',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
    const options={factions,seed:'live-owner-parity',matchId:'live-owner-parity',controllers:false,sharedVision:false};
    const initial=createSimulation(options),all=Object.values(initial.state.entities),homes=all.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center'),workers=all.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager');
    initial.state.map.terrain=[];initial.state.entities={};
    for(const entity of homes){entity.xMm=entity.ownerId==='a'?30000:initial.state.widthMm-30000;entity.zMm=entity.ownerId==='a'?30000:initial.state.heightMm-30000;initial.state.entities[entity.id]=entity;}
    for(let index=0;index<workers.length;index++){const entity=workers[index]!,home=homes.find(value=>value.ownerId===entity.ownerId)!;entity.xMm=home.xMm+10000;entity.zMm=home.zMm+(index%3)*3000;entity.autoGather=false;initial.state.entities[entity.id]=entity;}
    const worker=workers.find(entity=>entity.ownerId==='a')!,ore:ResourceNode={id:'live_owner_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:worker.xMm+1700+units.villager.collisionRadiusM*1000,zMm:worker.zMm,hp:1,maxHp:1,amount:1,forest:{cellMm:3000,patchId:'live_owned_forest'}};
    const hidden:ResourceNode={...ore,id:'live_owner_hidden_tree',xMm:90000,zMm:90000,amount:200000,forest:{cellMm:3000,patchId:'live_owned_hidden_forest'}},scout=all.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.typeId==='scout')!;
    scout.xMm=hidden.xMm-units.scout.visionM*1000-5000;scout.zMm=hidden.zMm;scout.stance='stand_ground';
    initial.state.entities[scout.id]=scout;initial.state.entities[ore.id]=ore;initial.state.entities[hidden.id]=hidden;
    initial.state.vision.a!.memory[hidden.id]={id:hidden.id,kind:hidden.kind,typeId:hidden.typeId,ownerId:null,xMm:hidden.xMm,zMm:hidden.zMm,hp:1,maxHp:1,resource:'wood',amount:100,lastSeenTick:0,forest:{...hidden.forest!}};
    initial.state.navigationRevision++;initial.step();
    const payload=initial.capture(),generic=new (initial.constructor as typeof Simulation)(options,payload),live=createLiveSimulation(options,payload);
    const issue=(command:GameplayCommand)=>{
      const sequence=generic.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:generic.state.matchId,matchEpoch:generic.state.matchEpoch,clientCommandId:`live_${sequence}`,clientSequence:sequence,command};
      const expected=generic.command('a',envelope),actual=live.command('a',envelope);expect(actual).toEqual(expected);return actual;
    };
    let sequence=0;
    const compare=()=>{
      expect(live.capture()).toEqual(generic.capture());
      for(const playerId of ['a','b'])expect(live.view(playerId)).toEqual(generic.view(playerId));
      const requests=['a','b'].map(playerId=>({playerId,sequence:++sequence}));
      expect(live.publicationProjections(requests)).toEqual(generic.publicationProjections(requests));
    };
    compare();expect(live.view('a').entities.find(entity=>entity.id===hidden.id)?.ghost).toBe(true);
    expect(issue({kind:'gather',unitIds:[worker.id],targetId:ore.id,queued:false}).status).toBe('accepted');
    for(let tick=0;tick<60&&(generic.state.entities[ore.id] as ResourceNode).amount>0;tick++){generic.step();live.step();compare();}
    expect((generic.state.entities[ore.id] as ResourceNode).amount,JSON.stringify(generic.state.entities[worker.id])).toBe(0);
    const builder=workers.filter(entity=>entity.ownerId==='a')[1]!,grid=balance.rules.buildingGridM*1000;
    // Place on the clear south side of the Town Center, whose sight includes
    // the entire clearance halo, rather than at the workers' visibility edge.
    const purchase=issue({kind:'build',builderIds:[builder.id],buildingType:'house',originCell:{x:Math.floor(32000/grid),z:Math.floor(36000/grid)},rotation:0,queued:false});expect(purchase.status,purchase.code).toBe('accepted');compare();
    const building=Object.values(generic.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='house')!;
    expect(issue({kind:'cancel_foundation',foundationId:building.id}).status).toBe('accepted');compare();
    expect(issue({kind:'move',unitIds:[scout.id],target:{xMm:hidden.xMm-units.scout.visionM*1000+2000,zMm:hidden.zMm},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<60&&generic.view('a').entities.find(entity=>entity.id===hidden.id)?.ghost;tick++){generic.step();live.step();compare();}
    const revealed=live.view('a').entities.find(entity=>entity.id===hidden.id)!;expect(revealed.ghost).not.toBe(true);expect(revealed.amount).toBe(200);
    const identity:EngineIdentity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},save=exportSimulationSave(live,identity);
    expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreLiveSimulation(save,identity,{preserveEpoch:true});
    for(let tick=0;tick<4;tick++){generic.step();live.step();restored.step();compare();expect(restored.capture()).toEqual(generic.capture());}
  });
});
