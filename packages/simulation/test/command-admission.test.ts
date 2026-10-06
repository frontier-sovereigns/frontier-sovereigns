import { MessageChannel, MessagePort, receiveMessageOnPort } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { type ClientCommandEnvelope, type CommandReceipt, type GameplayCommand, type PublicPlayer } from '@frontier/shared';
import { createSimulation, createLiveSimulation, exportReplay, exportSimulationSave, replayCheckpoint, ReplayRunner, restoreSimulation, Simulation, type Building, type EngineIdentity, type ResourceNode, type Unit } from '../src/index.js';
import { createNativeCommandBatch, type NativeCommandBatch, type NativeCommandItem } from '../src/command-admission-native.js';
import type { Navigation } from '../src/navigation.js';
import { PersistentPathPlanningKernel, RemotePathScheduler, type PathPlanningExecutor } from '../src/parallel-path-scheduler.js';

const identity:EngineIdentity={engineBuildHash:'8'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const factions:PublicPlayer[]=[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}];
const simulation=()=>createSimulation({factions,seed:'native-command-admission',matchId:'native-command-admission',controllers:false,sharedVision:false});
const workers=(sim:Simulation,playerId='blue')=>Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId===playerId&&entity.typeId==='villager');
const home=(sim:Simulation,playerId='blue')=>Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId===playerId&&entity.typeId==='town_center')!;
interface Reply {id:number;value:CommandReceipt|undefined;error:string|undefined}
interface AdmissionInternals {
  knownObstacleRecords:Map<string,{seen:boolean}>;
  refreshPlanningNav(playerId:string):Navigation;
  setOrder(unit:Unit,order:unknown,queued:boolean):void;
  addBuilding(playerId:string,typeId:'wooden_gate',position:{xMm:number;zMm:number},rotation:0,completed:true):Building;
  visibilityMasks:Map<string,Uint8Array>;
}
function envelope(sim:Simulation,playerId:string,sequence:number,command:GameplayCommand):ClientCommandEnvelope {
  return {protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${playerId}_${sequence}`,clientSequence:sequence,command};
}
function move(sim:Simulation,sequence:number,playerId='blue',kind:'move'|'attack_move'='move',offset=0):ClientCommandEnvelope {
  const center=home(sim,playerId);
  return envelope(sim,playerId,sequence,{kind,unitIds:workers(sim,playerId).slice(0,2).map(unit=>unit.id),target:{xMm:center.xMm+12000+offset,zMm:center.zMm+14000},queued:false});
}
function item(id:number,playerId:string,command:unknown):NativeCommandItem{return {id,playerId,command};}
function received(port:MessagePort):Reply[]{const result:Reply[]=[];for(let message=receiveMessageOnPort(port);message;message=receiveMessageOnPort(port))result.push(message.message as Reply);return result;}
function drain(sim:Simulation,items:readonly NativeCommandItem[]):Reply[]{
  const channel=new MessageChannel();
  try{sim.drainNativeCommands(createNativeCommandBatch(channel.port1,items));const result=received(channel.port2);expect(result).toHaveLength(items.length);return result;}
  finally{channel.port1.close();channel.port2.close();}
}
/** The pre-batch worker loop: every ordinary command is independently admitted. */
function scalar(sim:Simulation,items:readonly NativeCommandItem[]):Reply[]{
  return items.map(input=>{
    if(input.requestExpiresAtMs!==undefined&&Number(process.hrtime.bigint())/1e6>=input.requestExpiresAtMs)return {id:input.id,value:undefined,error:'WORKER_TIMEOUT'};
    try{return {id:input.id,value:sim.command(input.playerId,input.command),error:undefined};}
    catch{return {id:input.id,value:undefined,error:'COMMAND_FAILED'};}
  });
}
function compare(candidate:Simulation,reference:Simulation):void {
  expect(JSON.stringify(candidate.capture())).toBe(JSON.stringify(reference.capture()));
  expect(candidate.journalEvents()).toEqual(reference.journalEvents());
  expect(candidate.views(factions.map(faction=>faction.id))).toEqual(reference.views(factions.map(faction=>faction.id)));
}
function inMemoryPlanning():PathPlanningExecutor {
  let kernel:PersistentPathPlanningKernel;
  return {
    initialize:async(profiles,state,geometry)=>{kernel=new PersistentPathPlanningKernel(profiles,state,geometry);return kernel.reply();},
    advance:async batch=>kernel.advance(batch),capture:async()=>kernel.exportState(),dispose:async()=>{},
  };
}

describe('owned native command drain',()=>{
  it.each([50,300] as const)('matches scalar authority through native-owned formation batches, fog changes and geometry barriers at %ims',async authoritativeIntervalMs=>{
    const prepared=createSimulation({factions,seed:'native-command-admission',matchId:'native-command-admission',controllers:false,sharedVision:false,authoritativeIntervalMs}),center=home(prepared);
    const add=(prepared as unknown as {addBuilding(playerId:string,typeId:string,point:{xMm:number;zMm:number},rotation:0,completed:boolean):Building}).addBuilding.bind(prepared);
    const gate=add('blue','wooden_gate',{xMm:center.xMm+10000,zMm:center.zMm},0,true),foundation=add('blue','house',{xMm:center.xMm-12000,zMm:center.zMm},0,false);
    const payload=prepared.capture(),candidate=createLiveSimulation(prepared.options,payload) as unknown as Simulation,reference=new Simulation(prepared.options,payload);
    const first=move(reference,1),duplicate=move(reference,2),reused=structuredClone(duplicate);if(reused.command.kind==='move')reused.command.target.xMm++;
    const foreign=envelope(reference,'blue',3,{kind:'move',unitIds:[workers(reference)[0]!.id,workers(reference,'red')[0]!.id],target:{xMm:140000,zMm:140000},queued:false});
    const items=[item(1,'blue',first),item(2,'blue',duplicate),item(3,'blue',duplicate),item(4,'blue',reused),item(5,'blue',foreign),item(6,'blue',{}),
      item(7,'red',move(reference,1,'red')),item(8,'red',move(reference,2,'red','attack_move')),
      item(9,'blue',envelope(reference,'blue',4,{kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'})),item(10,'blue',move(reference,5)),item(11,'blue',move(reference,6)),
      item(12,'blue',envelope(reference,'blue',7,{kind:'cancel_foundation',foundationId:foundation.id})),item(13,'blue',move(reference,8)),item(14,'blue',move(reference,9)),
      {...item(15,'blue',move(reference,10)),requestExpiresAtMs:Number(process.hrtime.bigint())/1e6-1},item(16,'blue',move(reference,10)),item(17,'blue',{...move(reference,11),matchEpoch:999})];
    const replies=drain(candidate,items);expect(replies).toEqual(scalar(reference,items));
    expect(replies.map(reply=>reply.error??reply.value?.code)).toEqual(['OK','OK','OK','COMMAND_ID_REUSED','INVALID_REFERENCE','INVALID_COMMAND','OK','OK','OK','OK','OK','OK','OK','OK','WORKER_TIMEOUT','OK','STALE_MATCH']);
    expect(candidate.state.entities[foundation.id]).toBeUndefined();await candidate.synchronizeCapture();await reference.synchronizeCapture();compare(candidate,reference);
    // Subsequent committed motion/fog and a cold load must not retain the old
    // boundary certificate or change path admission, receipts or replay data.
    for(let frame=0;frame<3;frame++){candidate.advanceFrame();reference.advanceFrame();await candidate.synchronizeCapture();await reference.synchronizeCapture();compare(candidate,reference);}
    const saved=candidate.capture(),cold=createLiveSimulation(prepared.options,saved) as unknown as Simulation;
    const next=[item(18,'blue',move(reference,11)),item(19,'blue',move(reference,12))],expected=scalar(reference,next);expect(drain(candidate,next)).toEqual(expected);expect(drain(cold,next)).toEqual(expected);
    await candidate.synchronizeCapture();await reference.synchronizeCapture();await cold.synchronizeCapture();compare(candidate,reference);expect(cold.capture()).toEqual(candidate.capture());
  });

  it('revokes native-owned formation reuse when a prototype reader becomes a custom hook',()=>{
    const prepared=simulation(),payload=prepared.capture(),candidate=createLiveSimulation(prepared.options,payload) as unknown as Simulation,reference=new Simulation(prepared.options,payload),prototype=Simulation.prototype as unknown as AdmissionInternals,original=prototype.refreshPlanningNav;
    const counts=new WeakMap<object,number>();let calls=0;prototype.refreshPlanningNav=function(playerId){calls++;counts.set(this,(counts.get(this)??0)+1);return original.call(this,playerId);};
    try{
      const items=[item(1,'blue',move(reference,1)),item(2,'blue',move(reference,2))];expect(drain(candidate,items)).toEqual(scalar(reference,items));
      expect(counts.get(reference)).toBe(2);expect(calls).toBe(4);compare(candidate,reference);
    }finally{prototype.refreshPlanningNav=original;}
  });

  it('matches independent scalar receipts, authority, deduplication, journals, saves and replay',()=>{
    const candidate=simulation(),reference=simulation(),first=move(candidate,1),second=move(candidate,2,'blue','attack_move',2000);
    const changed=structuredClone(second);if(changed.command.kind==='attack_move')changed.command.target.xMm++;
    const foreign=envelope(candidate,'blue',3,{kind:'move',unitIds:[workers(candidate)[0]!.id,workers(candidate,'red')[0]!.id],target:{xMm:140000,zMm:140000},queued:false});
    const stale={...move(candidate,6),matchEpoch:candidate.state.matchEpoch+1};
    const items=[item(1,'blue',first),item(2,'blue',second),item(3,'blue',second),item(4,'blue',changed),item(5,'blue',foreign),item(6,'blue',{}),item(7,'red',move(candidate,1,'red')),item(8,'blue',envelope(candidate,'blue',4,{kind:'set_auto_reseed',enabled:true})),item(9,'blue',move(candidate,5)),item(10,'blue',stale)];
    const replies=drain(candidate,items);expect(replies).toEqual(scalar(reference,items));
    expect(replies.map(reply=>reply.value?.code)).toEqual(['OK','OK','OK','COMMAND_ID_REUSED','INVALID_REFERENCE','INVALID_COMMAND','OK','OK','OK','STALE_MATCH']);compare(candidate,reference);
    const saved=exportSimulationSave(candidate,identity);expect(saved).toEqual(exportSimulationSave(reference,identity));const cold=restoreSimulation(JSON.parse(JSON.stringify(saved)),identity,{preserveEpoch:true});
    for(let tick=0;tick<8;tick++){candidate.step();reference.step();cold.step();compare(candidate,reference);expect(cold.capture()).toEqual(candidate.capture());}
    const replay=exportReplay(candidate,identity,[replayCheckpoint(candidate)]),runner=new ReplayRunner(replay,identity);expect(runner.advanceTo(candidate.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(candidate.capture());
    expect(candidate.drainJournal()).toEqual(reference.drainJournal());
  });

  it('actually skips repeated canonical navigation preparation only within a compatible player run',()=>{
    const candidate=simulation(),reference=simulation(),single=simulation(),a=candidate as unknown as AdmissionInternals,b=reference as unknown as AdmissionInternals;
    const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2,'blue','attack_move',2000))];
    scalar(single,items.slice(0,1));expect(drain(candidate,items)).toEqual(scalar(reference,items));
    // Read the existing reconstruction generation without installing callbacks:
    // two native moves reconstruct once; two independent scalar moves twice.
    const once=(single as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!.seen;
    expect(a.knownObstacleRecords.get('blue')!.seen).toBe(once);expect(b.knownObstacleRecords.get('blue')!.seen).toBe(!once);compare(candidate,reference);
    const next=[item(3,'blue',move(candidate,3))];expect(drain(candidate,next)).toEqual(scalar(reference,next));expect(a.knownObstacleRecords.get('blue')!.seen).toBe(!once);compare(candidate,reference);
  });

  it('retains actual reuse and exact scalar authority with the remote scheduler and async continuation',async()=>{
    const candidate=simulation(),reference=simulation(),single=simulation(),simulations=[candidate,reference,single];
    for(const sim of simulations)await sim.attachPlanningExecutor(inMemoryPlanning());
    try{
      for(const sim of simulations)expect((sim as unknown as {pathScheduler:unknown}).pathScheduler).toBeInstanceOf(RemotePathScheduler);
      const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2,'blue','attack_move',2000))];
      scalar(single,items.slice(0,1));expect(drain(candidate,items)).toEqual(scalar(reference,items));
      const once=(single as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!.seen;
      expect((candidate as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!.seen).toBe(once);
      expect((reference as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!.seen).toBe(!once);
      await candidate.synchronizeCapture();await reference.synchronizeCapture();compare(candidate,reference);
      for(let tick=0;tick<4;tick++){await candidate.stepAsync();await reference.stepAsync();await candidate.synchronizeCapture();await reference.synchronizeCapture();compare(candidate,reference);}
      const saved=exportSimulationSave(candidate,identity);expect(saved).toEqual(exportSimulationSave(reference,identity));
      const cold=restoreSimulation(JSON.parse(JSON.stringify(saved)),identity,{preserveEpoch:true});await cold.attachPlanningExecutor(inMemoryPlanning());simulations.push(cold);
      const next=[item(3,'blue',move(candidate,3)),item(4,'blue',move(candidate,4))],expected=scalar(reference,next);expect(drain(candidate,next)).toEqual(expected);expect(drain(cold,next)).toEqual(expected);
      for(const sim of [candidate,reference,cold])await sim.synchronizeCapture();compare(candidate,reference);
      expect(cold.capture()).toEqual(candidate.capture());expect(cold.views(factions.map(faction=>faction.id))).toEqual(candidate.views(factions.map(faction=>faction.id)));
      expect(cold.journalEvents()).toEqual(candidate.journalEvents().filter(event=>event.ordinal>saved.payload.state.eventOrdinal));
    }finally{for(const sim of simulations)await (sim as unknown as {pathScheduler:RemotePathScheduler}).pathScheduler.dispose();}
  });

  it.each(['nonmovement','gate','recipient'] as const)('invalidates shared navigation at an intervening %s command',barrier=>{
    const candidate=simulation(),reference=simulation(),center=home(candidate);
    const gate=(candidate as unknown as AdmissionInternals).addBuilding('blue','wooden_gate',{xMm:center.xMm+10000,zMm:center.zMm},0,true);(reference as unknown as AdmissionInternals).addBuilding('blue','wooden_gate',{xMm:center.xMm+10000,zMm:center.zMm},0,true);
    const middle=barrier==='recipient'?item(2,'red',move(candidate,1,'red')):item(2,'blue',envelope(candidate,'blue',2,barrier==='gate'?{kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}:{kind:'set_auto_reseed',enabled:true}));
    const items=[item(1,'blue',move(candidate,1)),middle,item(3,'blue',move(candidate,3))];expect(drain(candidate,items)).toEqual(scalar(reference,items));
    const actual=(candidate as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!,expected=(reference as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!;expect(actual.seen).toBe(expected.seen);expect(actual.seen).toBe(false);compare(candidate,reference);
  });

  it('reconciles direct geometry, terrain, memory, fog and lifetime edits between distinct drains',()=>{
    const candidate=simulation(),reference=simulation();let sequence=0;
    const blueHome=home(candidate),node=Object.values(candidate.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource'&&entity.resource==='wood'&&candidate.view('blue').entities.some(view=>view.id===entity.id))!;
    const gate=(candidate as unknown as AdmissionInternals).addBuilding('blue','wooden_gate',{xMm:blueHome.xMm+10000,zMm:blueHome.zMm},0,true);(reference as unknown as AdmissionInternals).addBuilding('blue','wooden_gate',{xMm:blueHome.xMm+10000,zMm:blueHome.zMm},0,true);
    const edits:((sim:Simulation)=>void)[]=[
      sim=>{(sim.state.entities[node.id] as ResourceNode).xMm+=1500;},
      sim=>{const resource=sim.state.entities[node.id] as ResourceNode;resource.amount=0;resource.forest={patchId:'admission_forest',cellMm:2000};},
      sim=>{sim.state.map.terrain=[{id:'admission_cliff',kind:'cliff',xMm:blueHome.xMm+8000,zMm:blueHome.zMm+8000,widthMm:2000,depthMm:6000,elevationMm:2000}];},
      sim=>{(sim.state.entities[gate.id] as Building).gateMode='LOCKED';},
      sim=>{const building=sim.state.entities[gate.id] as Building;building.gateOpen=true;building.rotation=90;},
      sim=>{const building=sim.state.entities[gate.id] as Building;building.gateOpen=false;building.gateMode='AUTO';building.ownerId='red';sim.state.factions[1]!.teamId='blue';},
      sim=>{sim.state.economies.red!.defeated=true;},
      sim=>{(sim.state.entities[gate.id] as Building).work--;},
      sim=>{sim.state.vision.blue!.memory.admission_hidden={id:'admission_hidden',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:sim.state.widthMm-10000,zMm:sim.state.heightMm-10000,hp:1,maxHp:1,resource:'gold',amount:20,lastSeenTick:0};},
      sim=>{sim.state.vision.blue!.memory.admission_hidden!.xMm-=4000;},
      sim=>{const mask=(sim as unknown as AdmissionInternals).visibilityMasks.get('blue')!.slice();mask.fill(0);(sim as unknown as AdmissionInternals).visibilityMasks.set('blue',mask);},
      sim=>{delete sim.state.entities[node.id];},
    ];
    const run=()=>{const items=[item(++sequence,'blue',move(candidate,sequence)),item(++sequence,'blue',move(candidate,sequence,'blue','attack_move',2000))];expect(drain(candidate,items)).toEqual(scalar(reference,items));compare(candidate,reference);};
    run();for(const edit of edits){edit(candidate);edit(reference);run();}
    const restoredCandidate=new Simulation(candidate.options,candidate.capture()),restoredReference=new Simulation(reference.options,reference.capture());const items=[item(++sequence,'blue',move(candidate,sequence)),item(++sequence,'blue',move(candidate,sequence,'blue','attack_move'))];expect(drain(restoredCandidate,items)).toEqual(scalar(restoredReference,items));compare(restoredCandidate,restoredReference);
  });

  it.each(['instance','prototype'] as const)('retains scalar behavior for a custom %s navigation reader that changes geometry',scope=>{
    const candidate=simulation(),reference=simulation(),node=Object.values(candidate.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource')!,methods=(scope==='prototype'?Simulation.prototype:candidate) as unknown as AdmissionInternals,original=methods.refreshPlanningNav;
    const counts=new WeakMap<Simulation,number>();
    const wrapper=function(this:Simulation,playerId:string){const count=(counts.get(this)??0)+1;counts.set(this,count);if(count===2)(this.state.entities[node.id] as ResourceNode).xMm+=3000;return original.call(this,playerId);};
    methods.refreshPlanningNav=wrapper;if(scope==='instance')(reference as unknown as AdmissionInternals).refreshPlanningNav=wrapper;
    try{const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))];expect(drain(candidate,items)).toEqual(scalar(reference,items));expect(counts.get(candidate)).toBe(2);compare(candidate,reference);}
    finally{if(scope==='prototype')methods.refreshPlanningNav=original;else{delete (candidate as unknown as Record<string,unknown>).refreshPlanningNav;delete (reference as unknown as Record<string,unknown>).refreshPlanningNav;}}
  });

  it('does not certify an overridden order writer that mutates a static source between moves',()=>{
    const candidate=simulation(),reference=simulation(),node=Object.values(candidate.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource')!;
    for(const sim of [candidate,reference]){const internal=sim as unknown as AdmissionInternals,original=internal.setOrder;let first=true;internal.setOrder=function(unit,order,queued){original.call(sim,unit,order,queued);if(first){first=false;(sim.state.entities[node.id] as ResourceNode).amount=0;}};}
    try{const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))];expect(drain(candidate,items)).toEqual(scalar(reference,items));compare(candidate,reference);}
    finally{for(const sim of [candidate,reference])delete (sim as unknown as Record<string,unknown>).setOrder;}
  });

  it('falls back for a nested scheduler cancellation hook and preserves its between-command mutation',()=>{
    const candidate=simulation(),reference=simulation(),visible=new Set(candidate.view('blue').entities.map(entity=>entity.id));
    const node=Object.values(candidate.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource'&&visible.has(entity.id))!;
    const counts=new Map<Simulation,number>(),restores:(()=>void)[]=[];
    for(const sim of [candidate,reference]){
      const shared=(sim as unknown as {pathScheduler:{sharedJobs:{cancel(unitId:string):void}}}).pathScheduler.sharedJobs,original=shared.cancel;
      shared.cancel=function(unitId){original.call(this,unitId);const count=(counts.get(sim)??0)+1;counts.set(sim,count);if(count===1)(sim.state.entities[node.id] as ResourceNode).xMm+=3000;};
      restores.push(()=>{delete (shared as unknown as Record<string,unknown>).cancel;});
    }
    try{
      const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))];expect(drain(candidate,items)).toEqual(scalar(reference,items));
      expect(counts.get(candidate)).toBe(4);expect(counts.get(reference)).toBe(4);
      expect((candidate as unknown as AdmissionInternals).knownObstacleRecords.get('blue')!.seen).toBe(false);compare(candidate,reference);
    }finally{for(const restore of restores)restore();}
    const next=[item(3,'blue',move(candidate,3)),item(4,'blue',move(candidate,4))];expect(drain(candidate,next)).toEqual(scalar(reference,next));compare(candidate,reference);
  });

  it('preserves scalar handling of duplicate static identities and an irrelevant throwing unit accessor',()=>{
    const candidate=simulation(),reference=simulation(),node=Object.values(candidate.state.entities).find((entity):entity is ResourceNode=>entity.kind==='resource')!;
    for(const sim of [candidate,reference])sim.state.entities.admission_alias=sim.state.entities[node.id]!;
    const first=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))];expect(drain(candidate,first)).toEqual(scalar(reference,first));compare(candidate,reference);
    let reads=0;for(const sim of [candidate,reference]){const malformed={...workers(sim,'red')[0]!,id:'irrelevant_accessor'};Object.defineProperty(malformed,'xMm',{enumerable:true,get(){reads++;throw new Error('IRRELEVANT_UNIT_READ');}});sim.state.entities[malformed.id]=malformed;}
    try{const next=[item(3,'blue',move(candidate,3)),item(4,'blue',move(candidate,4))];expect(drain(candidate,next)).toEqual(scalar(reference,next));expect(reads).toBe(0);}
    finally{delete candidate.state.entities.irrelevant_accessor;delete reference.state.entities.irrelevant_accessor;}
    compare(candidate,reference);
  });

  it('replies to an expired item without applying or journaling it and still admits later live items',()=>{
    const candidate=simulation(),reference=simulation(),now=Number(process.hrtime.bigint())/1e6,items=[{...item(1,'blue',move(candidate,1)),requestExpiresAtMs:now-1},{...item(2,'blue',move(candidate,2)),requestExpiresAtMs:now+60000},item(3,'blue',{})];
    const clock=vi.spyOn(process.hrtime,'bigint').mockReturnValue(0n);let replies:Reply[];
    try{replies=drain(candidate,items);}finally{clock.mockRestore();}
    expect(replies!).toEqual(scalar(reference,items));expect(replies![0]).toEqual({id:1,value:undefined,error:'WORKER_TIMEOUT'});expect(candidate.journalEvents()).toHaveLength(2);expect(candidate.state.commandLog).toHaveLength(1);expect(candidate.state.economies.blue!.lastClientSequence).toBe(2);compare(candidate,reference);
  });

  it('continues after a thrown command exactly like the original worker catch and clears the drain',()=>{
    const candidate=simulation(),reference=simulation();
    for(const sim of [candidate,reference]){const original=sim.command;sim.command=function(playerId,input,source){if((input as ClientCommandEnvelope).clientSequence===2)throw new Error('TEST_COMMAND_FAILURE');return original.call(sim,playerId,input,source);};}
    const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2)),item(3,'blue',move(candidate,3))];
    try{expect(drain(candidate,items)).toEqual(scalar(reference,items));compare(candidate,reference);}
    finally{delete (candidate as unknown as Record<string,unknown>).command;delete (reference as unknown as Record<string,unknown>).command;}
    const retry=[item(4,'blue',move(candidate,4)),item(5,'blue',move(candidate,5))];expect(drain(candidate,retry)).toEqual(scalar(reference,retry));compare(candidate,reference);
  });

  it.each(['PAUSED','FINISHED'] as const)('keeps ordinary %s command rejection without preparing navigation',status=>{
    const candidate=simulation(),reference=simulation();for(const sim of [candidate,reference])if(status==='PAUSED')sim.setStatus(status);else sim.endAsDraw();
    const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))],replies=drain(candidate,items);expect(replies).toEqual(scalar(reference,items));expect(replies.every(reply=>reply.value?.code===(status==='PAUSED'?'MATCH_PAUSED':'MATCH_FINISHED'))).toBe(true);expect((candidate as unknown as AdmissionInternals).knownObstacleRecords.size).toBe(0);compare(candidate,reference);
  });
});

describe('native command batch ownership and replies',()=>{
  it('detaches caller records before admission, exposes no borrowed items, and consumes once',()=>{
    const candidate=simulation(),reference=simulation(),channel=new MessageChannel(),items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))],expected=structuredClone(items),batch=createNativeCommandBatch(channel.port1,items);
    try{
      expect(Object.getPrototypeOf(batch)).toBeNull();expect(Reflect.ownKeys(batch)).toEqual([]);expect(Object.isFrozen(batch)).toBe(true);
      const command=items[0]!.command as ClientCommandEnvelope;if(command.command.kind==='move')command.command.target.xMm=1;items[1]!.playerId='red';items.length=0;
      candidate.drainNativeCommands(batch);expect(received(channel.port2)).toEqual(scalar(reference,expected));compare(candidate,reference);const before=JSON.stringify(candidate.capture());
      expect(()=>candidate.drainNativeCommands(batch)).toThrow('INVALID_NATIVE_COMMAND_BATCH');expect(JSON.stringify(candidate.capture())).toBe(before);expect(received(channel.port2)).toEqual([]);
      expect(()=>candidate.drainNativeCommands(Object.freeze(Object.create(null)) as NativeCommandBatch)).toThrow('INVALID_NATIVE_COMMAND_BATCH');expect(JSON.stringify(candidate.capture())).toBe(before);
    }finally{channel.port1.close();channel.port2.close();}
  });

  it('rejects fake ports and bypasses own/prototype IPC hooks before admitting the next command',()=>{
    const candidate=simulation(),reference=simulation(),fake={postMessage:vi.fn(),hasRef:vi.fn(()=>false)};
    expect(()=>createNativeCommandBatch(fake as unknown as MessagePort,[])).toThrow('INVALID_NATIVE_COMMAND_PORT');expect(fake.hasRef).not.toHaveBeenCalled();expect(fake.postMessage).not.toHaveBeenCalled();
    const channel=new MessageChannel(),prototype=vi.spyOn(MessagePort.prototype,'postMessage').mockImplementation(()=>{throw new Error('PROTOTYPE_IPC_HOOK');}),own=vi.fn(()=>{throw new Error('OWN_IPC_HOOK');});channel.port1.postMessage=own;
    try{const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))];candidate.drainNativeCommands(createNativeCommandBatch(channel.port1,items));expect(received(channel.port2)).toEqual(scalar(reference,items));expect(prototype).not.toHaveBeenCalled();expect(own).not.toHaveBeenCalled();compare(candidate,reference);}
    finally{delete (channel.port1 as unknown as Record<string,unknown>).postMessage;prototype.mockRestore();channel.port1.close();channel.port2.close();}
  });

  it('keeps original first-reply failure behavior without applying a command twice',()=>{
    const candidate=simulation(),reference=simulation(),channel=new MessageChannel(),original=candidate.command;let calls=0;
    candidate.command=function(playerId,input,source){const receipt=original.call(this,playerId,input,source);calls++;return calls===1?{...receipt,uncloneable:()=>undefined} as CommandReceipt:receipt;};
    const items=[item(1,'blue',move(candidate,1)),item(2,'blue',move(candidate,2))],batch=createNativeCommandBatch(channel.port1,items);
    try{
      const expected=scalar(reference,items);candidate.drainNativeCommands(batch);expect(received(channel.port2)).toEqual([{id:1,value:undefined,error:'COMMAND_FAILED'},expected[1]]);expect(calls).toBe(2);compare(candidate,reference);
      expect(()=>candidate.drainNativeCommands(batch)).toThrow('INVALID_NATIVE_COMMAND_BATCH');expect(calls).toBe(2);
    }finally{delete (candidate as unknown as Record<string,unknown>).command;channel.port1.close();channel.port2.close();}
  });
});
