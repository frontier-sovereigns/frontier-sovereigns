import {describe,expect,it} from 'vitest';
import {balance,buildings,technologies,units,validatePlayerView,terrainObstacles,type PublicPlayer,type GameplayCommand} from '@frontier/shared';
import {Navigation} from '../src/navigation.js';
import {ApproachReservations,LocalAvoidance,UnitSpatialIndex} from '../src/movement.js';
import {ActiveWorkRoster} from '../src/active-work-roster.js';
import {VisionMaskKernel} from '../src/vision-mask-kernel.js';
import {NativeCombatTimeline} from '../src/combat.js';
import {Simulation,createSimulation,createLiveSimulation,exportReplay,ReplayRunner,replayCheckpoint,sealSimulationCapture,restoreSimulation,type Building,type Unit,type Entity,type EngineIdentity} from '../src/index.js';
import {PathWorkerPool,PathWorkerService} from '../../../apps/server/src/path-worker-pool.js';
import {type PathPlanningExecutor} from '../src/parallel-path-scheduler.js';
import {WorkerCallbackDiagnostics,WorkerSimulationStageDiagnostics} from '../../../apps/server/src/performance-diagnostics.js';
import {validateSimulationSavePayload,validateJournalEvent} from '../src/save-schema.js';

const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ee5533'}];
const identity:EngineIdentity={engineBuildHash:'f'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function fixture(players=factions){
  const options={factions:players,seed:'coarse-frame',matchId:'coarse-frame',controllers:false,sharedVision:false},base=createSimulation(options),entities=Object.values(base.state.entities);
  base.state.map.terrain=[];base.state.entities={};
  for(const faction of players){
    const home=entities.find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center'&&entity.ownerId===faction.id)!;
    home.xMm=faction.id==='a'||faction.id==='c'?30000:base.state.widthMm-30000;home.zMm=faction.id==='a'?30000:base.state.heightMm-30000;base.state.entities[home.id]=home;
    const worker=entities.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager'&&entity.ownerId===faction.id)!;
    worker.xMm=home.xMm+10000;worker.zMm=home.zMm;worker.autoGather=false;worker.stance='stand_ground';base.state.entities[worker.id]=worker;
  }
  base.state.navigationRevision++;base.step();
  return {options,payload:base.capture()};
}
function addGate(setup:ReturnType<typeof fixture>,ownerId='a',remainingWork=0){
  const home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId===ownerId)!,definition=buildings.wooden_gate,required=definition.buildSeconds*balance.rules.simulationHz*100;
  const gate:Building={...structuredClone(home),id:'retained_gate',typeId:'wooden_gate',xMm:70000,zMm:30000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required-remainingWork,required,gateMode:'AUTO',gateOpen:false,queue:[]};
  setup.payload.state.entities[gate.id]=gate;setup.payload.state.navigationRevision++;return gate;
}
function move(sim:Simulation|ReturnType<typeof createLiveSimulation>){
  const worker=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
  const sequence=sim.state.economies.a!.lastClientSequence+1;
  expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`move_${sequence}`,clientSequence:sequence,command:{kind:'move',unitIds:[worker.id],target:{xMm:75000,zMm:30000},queued:false}}).status).toBe('accepted');
  return worker.id;
}
function stalledFixture(repair=false){
  const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
  const home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,target=repair?{xMm:home.xMm+6850,zMm:home.zMm}:{xMm:75000,zMm:worker.zMm};
  worker.orderRevision=3;worker.lastProgressTick=setup.payload.state.tick;worker.pathRequestId='retained_pending';worker.path=[];
  worker.orders=repair?[{kind:'repair',targetId:home.id,manualOrder:true}]:[{kind:'move',target,manualOrder:true}];
  if(repair){home.hp-=100;worker.approachGoal={key:home.id,revision:setup.payload.runtime.planningProfiles.find(([profile])=>profile==='a')![1].revision,point:target};}
  const request={id:worker.pathRequestId,unitId:worker.id,profile:'a',orderRevision:worker.orderRevision,from:{xMm:worker.xMm,zMm:worker.zMm},target,radiusMm:units.villager.collisionRadiusM*1000,enqueuedTick:setup.payload.state.tick,workClass:'interactive' as const};
  setup.payload.runtime.pathScheduler.tasks.push({...request,stage:'direct',lineStep:1,lineSteps:Math.max(1,Math.ceil(Math.hypot(target.xMm-worker.xMm,target.zMm-worker.zMm)/250))});
  setup.payload.runtime.pathScheduler.priority??={tick:setup.payload.state.tick,profiles:{}};
  expect(validateSimulationSavePayload(setup.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
  return {sim:new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload),id:worker.id,oldPoint:target};
}
function unscheduledWorkOracle(sim:Simulation):void{
  const target=sim as unknown as Record<string,unknown>;
  for(const name of ['continueFrameWorkWait','continueFrameMovementWait','frameTransitDropoff']){
    const original=target[name],wrapper=()=>name==='frameTransitDropoff'?undefined:false;target[name]=wrapper;
    // Keep the same frame/knowledge cadence while disabling only the derived
    // scheduling proof under test. The ordinary task/event implementation runs.
    expect(sim.registerFramePlanningDiagnostic(name,original,wrapper)).toBeTypeOf('function');
  }
}
function workSchedulingCounts(sim:Simulation){return (sim as unknown as {frameWorkSchedulingCounts:{transit:number;resourceWait:number;moveWait:number;workFaceWait:number;pinnedDropoffs:number}}).frameWorkSchedulingCounts;}
function pendingWorkRouteFixture(kind:'gather'|'deposit'|'build'|'repair'|'reseed'){
  const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
  setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';setup.payload.state.tick=120;
  for(const [,saved]of setup.payload.runtime.localAvoidance)saved.deferred={version:1,nextRequestId:1,jobs:[]};
  const definition=buildings[kind==='reseed'?'farm':'house'],required=definition.buildSeconds*balance.rules.simulationHz*100;
  const target:Entity=kind==='gather'?{id:'pending_work_target',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:45000,zMm:30000,hp:1,maxHp:1,amount:250000}:kind==='deposit'?home:{...structuredClone(home),id:'pending_work_target',typeId:kind==='reseed'?'farm':'house',xMm:48000,zMm:30000,hp:kind==='repair'?definition.maxHp-100:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:kind==='build'?0:required,required,queue:[],...(kind==='reseed'?{foodRemaining:0,reseedWork:0,reseedRequired:10000}:{})};
  setup.payload.state.entities[target.id]=target;setup.payload.state.navigationRevision++;
  worker.orders=[kind==='gather'||kind==='deposit'?{kind:'gather',targetId:kind==='deposit'?'old_resource':target.id,phase:kind,manualOrder:true,...(kind==='deposit'?{dropOffId:home.id}:{})}:{kind,targetId:target.id,manualOrder:true}];
  worker.orderRevision=3;worker.lastProgressTick=1;if(kind==='deposit')worker.cargo={resource:'wood',amount:5000};
  for(const [index,offset]of [[700,0],[-700,0],[0,700],[0,-700]].entries()){const blocker:Unit={...structuredClone(worker),id:`work_route_blocker_${index}`,xMm:worker.xMm+offset[0]!,zMm:worker.zMm+offset[1]!,orders:[],path:[],cargo:{resource:null,amount:0}};setup.payload.state.entities[blocker.id]=blocker;}
  const options={...setup.options,authoritativeIntervalMs:300 as const},primed=new Simulation(options,setup.payload),internal=primed as unknown as {updateVision():void;approachDestination(unit:Unit,target:Entity,requireRoute:boolean):{xMm:number;zMm:number}|undefined};internal.updateVision();
  const current=primed.state.entities[worker.id] as Unit,point=internal.approachDestination(current,primed.state.entities[target.id]!,true)!;expect(point).toBeDefined();current.path=[{...point}];current.pathDestination={...point};current.lastProgressTick=1;
  return {options,payload:primed.capture(),id:worker.id,targetId:target.id,point};
}
function workFlightFixture(kind:'gather'|'deposit'){
  const setup=pendingWorkRouteFixture(kind);
  for(const id of Object.keys(setup.payload.state.entities))if(id.startsWith('work_route_blocker_'))delete setup.payload.state.entities[id];
  return setup;
}

describe('native gather and deposit work flights',()=>{
  it.each([{kind:'gather',tier:1},{kind:'gather',tier:2},{kind:'deposit',tier:1},{kind:'deposit',tier:2}] as const)('reuses ready $kind travel across commits at tier$tier while keeping exact contacts, cold saves and replay',async({kind,tier})=>{
    const setup=workFlightFixture(kind),normal=createLiveSimulation(setup.options,setup.payload),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);
    live.setMovementCadenceTier(tier);scalar.setMovementCadenceTier(tier);
    for(let frame=0;frame<3;frame++){
      const end=live.state.tick+(tier===1?18:12);
      // Compare equal game time: tier1 commits9 quanta, tier2 commits12,
      // while the normal profile still commits6 per authority boundary.
      for(const sim of [normal,live,scalar])while(sim.state.tick<end){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture()).toEqual(scalar.capture());expect(live.state.entities).toEqual(normal.state.entities);expect(live.state.economies).toEqual(normal.state.economies);expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    }
    expect(live.movementDecisionDiagnostics().full).toBeLessThan(normal.movementDecisionDiagnostics().full);
    expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(normal.movementDecisionDiagnostics().reused);
    const cold=createLiveSimulation(setup.options,live.capture());
    for(let frame=0;frame<10;frame++){
      for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    }
    if(kind==='gather')expect((live.state.entities[setup.id] as Unit).cargo.amount).toBeGreaterThan(0);
    else expect(live.state.economies.a!.resources.wood).toBe(setup.payload.state.economies.a!.resources.wood+5000);
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each(['gather','deposit'] as const)('uses bounded %s flights with exact arrivals, economy, actions, cold save and replay',async kind=>{
    const setup=workFlightFixture(kind),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.workFlightDiagnostics();
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    const counts=Simulation.workFlightDiagnostics();expect(counts.prepared).toBeGreaterThan(before.prepared);expect(counts.used).toBeGreaterThan(before.used);
    expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    const cold=createLiveSimulation(setup.options,live.capture());
    for(let frame=0;frame<12;frame++){
      for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());expect(live.view('a')).toEqual(scalar.view('a'));
    }
    const worker=live.state.entities[setup.id] as Unit;
    if(kind==='gather'){expect(worker.cargo.amount).toBeGreaterThan(0);expect(live.committedFrameActions().actions.some(action=>action.id===worker.id&&action.kind==='gather_wood')).toBe(true);}
    else expect(live.state.economies.a!.resources.wood).toBe(setup.payload.state.economies.a!.resources.wood+5000);
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each(['epoch','order'] as const)('discards a work flight after an explicit %s boundary change',async change=>{
    const setup=workFlightFixture('gather'),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.workFlightDiagnostics().used;
    for(const sim of [live,scalar])sim.setMovementCadenceTier(2);
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(Simulation.workFlightDiagnostics().used).toBeGreaterThan(before);
    for(const sim of [live,scalar]){
      if(change==='epoch')sim.invalidateEpoch();
      else expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'replace_work_flight',clientSequence:1,command:{kind:'move',unitIds:[setup.id],target:{xMm:40000,zMm:40000},queued:false}}).status).toBe('accepted');
      sim.advanceFrame();await sim.synchronizeCapture();
    }
    expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each([100,500])('rechecks resource depletion of %s on the original contact before continuing a prepared work flight',async amount=>{
    const setup=workFlightFixture('gather'),worker=setup.payload.state.entities[setup.id] as Unit,target=setup.payload.state.entities[setup.targetId]!;
    if(target.kind!=='resource')throw new Error('RESOURCE_FIXTURE_REQUIRED');target.amount=amount;
    const gatherer:Unit={...structuredClone(worker),id:'flight_resource_finisher',xMm:target.xMm+1200,zMm:target.zMm,orders:[{kind:'gather',targetId:target.id,phase:'gather',manualOrder:true}],path:[],orderRevision:0};delete gatherer.approachGoal;delete gatherer.pathDestination;setup.payload.state.entities[gatherer.id]=gatherer;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.workFlightDiagnostics().prepared;
    for(const sim of [live,scalar])sim.setMovementCadenceTier(2);
    for(let frame=0;frame<(amount===100?1:2);frame++){
      for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
      // At600ms,500milliwood lasts beyond the first12-contact frame; the
      // original250 fixture now correctly depletes inside that first commit.
      if(amount===500&&frame===0)expect((live.state.entities[target.id] as typeof target).amount).toBeGreaterThan(0);
    }
    expect(Simulation.workFlightDiagnostics().prepared).toBeGreaterThan(before);expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    expect((live.state.entities[target.id] as typeof target).amount).toBe(0);expect((live.state.entities[gatherer.id] as Unit).cargo.amount).toBe(amount);expect((live.state.entities[worker.id] as Unit).cargo.amount).toBe(0);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('invalidates work flights when a gate completes during the frame without skipping the original work guards',async()=>{
    const setup=workFlightFixture('gather'),gate=addGate(setup,'a',300),worker=setup.payload.state.entities[setup.id] as Unit;
    const builder:Unit={...structuredClone(worker),id:'work_flight_gate_builder',xMm:gate.xMm,zMm:gate.zMm+1600,orders:[{kind:'build',targetId:gate.id,manualOrder:true}],path:[],orderRevision:0};delete builder.approachGoal;delete builder.pathDestination;setup.payload.state.entities[builder.id]=builder;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.workFlightDiagnostics().used;
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect((live.state.entities[gate.id] as Building).work).toBe(gate.required);expect(Simulation.workFlightDiagnostics().used).toBeGreaterThan(before);expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(1);expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
  });
  it('retains the scalar fallback when local straight-flight helpers have been replaced',async()=>{
    const setup=workFlightFixture('gather'),original=LocalAvoidance.prototype.prepareStraightFlight,before=Simulation.workFlightDiagnostics();
    LocalAvoidance.prototype.prepareStraightFlight=()=>{throw new Error('UNTRUSTED_WORK_FLIGHT');};
    try{const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(Simulation.workFlightDiagnostics()).toEqual(before);}finally{LocalAvoidance.prototype.prepareStraightFlight=original;}
  });
  it('invalidates a deposit work flight when a trained unit exits during the same frame',async()=>{
    const setup=workFlightFixture('deposit'),primed=new Simulation(setup.options,setup.payload),home=primed.state.entities[setup.targetId] as Building;
    expect(primed.command('a',{protocolVersion:2,matchId:primed.state.matchId,matchEpoch:primed.state.matchEpoch,clientCommandId:'work_flight_birth',clientSequence:1,command:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}}).status).toBe('accepted');home.queue[0]!.required=3;
    const payload=primed.capture(),live=createLiveSimulation(setup.options,payload),scalar=new Simulation(setup.options,payload),before=Simulation.workFlightDiagnostics().used;
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(Simulation.workFlightDiagnostics().used).toBeGreaterThan(before);expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    const worker=live.state.entities[setup.id] as Unit,spawn=Object.values(live.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.id!==worker.id)!;expect(spawn).toBeDefined();expect(Math.hypot(worker.xMm-spawn.xMm,worker.zMm-spawn.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);
    const cold=createLiveSimulation(setup.options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());
  });
  it('preserves current collision and detour credits when opposite traffic enters a gather route',async()=>{
    const setup=workFlightFixture('gather'),opposite=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!,destination={xMm:35000,zMm:30000};
    opposite.xMm=44000;opposite.zMm=30000;opposite.orders=[{kind:'move',target:destination,manualOrder:true}];opposite.path=[{...destination}];opposite.pathDestination={...destination};
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),live=createLiveSimulation(setup.options,payload),scalar=new Simulation(setup.options,payload),before=Simulation.workFlightDiagnostics().used;
    for(const sim of [live,scalar])sim.setMovementCadenceTier(2);
    for(let frame=0;frame<3;frame++){
      for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());const worker=live.state.entities[setup.id] as Unit,other=live.state.entities[opposite.id] as Unit;expect(Math.hypot(worker.xMm-other.xMm,worker.zMm-other.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);
    }
    expect(Simulation.workFlightDiagnostics().used).toBeGreaterThan(before);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
});

describe('native elapsed combat frames',()=>{
  function combatFixture(){
    const setup=fixture();setup.payload.options.authoritativeIntervalMs=300;
    const template=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    template.cooldown=20;
    for(let index=0;index<38;index++){
      const def=units.archer,actor:Unit={...structuredClone(template),id:`clock_archer_${index}`,typeId:'archer',xMm:60000+index%8*1000,zMm:60000+Math.floor(index/8)*1000,hp:def.maxHp,maxHp:def.maxHp,cooldown:index===27||index===28?4:index<6?index+1:30,orders:[{kind:'attack',targetId:'clock_enemy',manualOrder:true}],path:[]};setup.payload.state.entities[actor.id]=actor;
    }
    const def=units.knight;setup.payload.state.entities.clock_enemy={...structuredClone(template),id:'clock_enemy',ownerId:'b',typeId:'knight',xMm:65000,zMm:66000,hp:def.maxHp,maxHp:def.maxHp,cooldown:30,orders:[],path:[]};
    return {...setup,options:{...setup.options,authoritativeIntervalMs:300 as const}};
  }
  it('skips native cooling contacts across bit31/32 while keeping exact scalar, cold and journal replay state',async()=>{
    const setup=combatFixture(),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=NativeCombatTimeline.diagnostics();
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    const counts=NativeCombatTimeline.diagnostics();expect(counts.frames-before.frames).toBe(1);expect(counts.skippedCooldownContacts-before.skippedCooldownContacts).toBeGreaterThan(180);
    expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    // The four original actors precede these entries, so indices27/28 straddle
    // the actual native deadline wheel's31/32 boundary at the same launch tick.
    expect(live.state.projectiles.filter(projectile=>['clock_archer_27','clock_archer_28'].includes(projectile.sourceId)).map(projectile=>projectile.sourceId)).toEqual(['clock_archer_27','clock_archer_28']);
    const cold=createLiveSimulation(setup.options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each([1,2] as const)('retains native combat deadlines at adaptive tier%s with exact ordinary events and cold replay',async tier=>{
    const setup=combatFixture(),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=NativeCombatTimeline.diagnostics();
    for(const sim of [live,scalar]){sim.setMovementCadenceTier(tier);sim.advanceFrame();await sim.synchronizeCapture();}
    expect(live.state.tick-setup.payload.state.tick).toBe(tier===1?9:12);expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    const counts=NativeCombatTimeline.diagnostics();expect(counts.frames-before.frames).toBe(1);expect(counts.skippedCooldownContacts-before.skippedCooldownContacts).toBeGreaterThan(180);
    const cold=createLiveSimulation(setup.options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(cold.capture()).toEqual(live.capture());expect(live.capture()).toEqual(scalar.capture());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('materializes cooldowns at a partial-frame victory boundary and retains generic hook observations',async()=>{
    const setup=combatFixture(),start=setup.payload.state.tick;
    for(const entity of Object.values(setup.payload.state.entities))if(entity.ownerId==='b')delete setup.payload.state.entities[entity.id];
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=NativeCombatTimeline.diagnostics().frames;
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(live.state.tick).toBe(start+1);expect(live.state.status).toBe('FINISHED');expect(NativeCombatTimeline.diagnostics().frames-before).toBe(1);expect(live.capture()).toEqual(scalar.capture());
    const fresh=combatFixture(),generic=new Simulation(fresh.options,fresh.payload),internal=generic as unknown as {advanceCombat:(context:unknown)=>void},original=internal.advanceCombat,seen:number[]=[];
    internal.advanceCombat=context=>{seen.push((generic.state.entities.clock_archer_37 as Unit).cooldown);original(context);};const count=NativeCombatTimeline.diagnostics().frames;generic.advanceFrame();
    expect(seen).toEqual([30,29,28,27,26,25]);expect(NativeCombatTimeline.diagnostics().frames).toBe(count);
  });
  it('keeps cooldowns frozen for garrisoned and defeated actors and wakes actual garrison arrivals',async()=>{
    const setup=combatFixture(),home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const actor=setup.payload.state.entities.clock_archer_37 as Unit;actor.xMm=home.xMm+6850;actor.zMm=home.zMm;actor.cooldown=30;actor.orders=[{kind:'garrison',targetId:home.id,manualOrder:true}];
    const occupant=setup.payload.state.entities.clock_archer_36 as Unit;occupant.garrisonedIn=home.id;occupant.xMm=home.xMm;occupant.zMm=home.zMm;occupant.orders=[];home.garrisoned=[occupant.id];
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect((live.state.entities[occupant.id] as Unit).cooldown).toBe(30);expect((live.state.entities[actor.id] as Unit).garrisonedIn).toBe(home.id);expect((live.state.entities[actor.id] as Unit).cooldown).toBe(30);
  });
  it('revokes native deadline ownership when its constructor or methods are replaced',()=>{
    const setup=combatFixture(),live=createLiveSimulation(setup.options,setup.payload),before=NativeCombatTimeline.diagnostics().frames,original=NativeCombatTimeline.create;
    NativeCombatTimeline.create=(...args)=>original(...args);
    try{live.advanceFrame();expect(NativeCombatTimeline.diagnostics().frames).toBe(before);}finally{NativeCombatTimeline.create=original;}
  });
});

describe('native within-frame movement index reconciliation',()=>{
  function setupIndex(){
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    return {...setup,options:{...setup.options,authoritativeIntervalMs:300 as const},worker,home};
  }
  async function compare(live:ReturnType<typeof createLiveSimulation>,scalar:Simulation){
    live.advanceFrame();scalar.advanceFrame();await live.synchronizeCapture();await scalar.synchronizeCapture();expect(live.capture()).toEqual(scalar.capture());for(const faction of factions)expect(live.view(faction.id)).toEqual(scalar.view(faction.id));
  }
  function send(pair:readonly (Simulation|ReturnType<typeof createLiveSimulation>)[],command:GameplayCommand){
    const first=pair[0]!,sequence=first.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2 as const,matchId:first.state.matchId,matchEpoch:first.state.matchEpoch,clientCommandId:`index_${sequence}`,clientSequence:sequence,command};
    for(const sim of pair)expect(sim.command('a',envelope).status).toBe('accepted');
  }
  it('reconciles once and skips five redundant actor passes while preserving movement, cold restore and replay',async()=>{
    const setup=setupIndex(),target={xMm:75000,zMm:30000};setup.worker.orders=[{kind:'move',target,manualOrder:true}];setup.worker.path=[target];setup.worker.pathDestination=target;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.movementRosterDiagnostics();await compare(live,scalar);
    const after=Simulation.movementRosterDiagnostics();expect(after.reconciled-before.reconciled).toBe(1);expect(after.reused-before.reused).toBe(5);expect(after.unitsVisited-before.unitsVisited).toBe(2);expect((live.state.entities[setup.worker.id] as Unit).xMm).toBeGreaterThan(setup.worker.xMm);
    const cold=createLiveSimulation(setup.options,live.capture());await compare(live,scalar);cold.advanceFrame();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('reseeds after a same-frame training birth and still separates opposite moving bodies',async()=>{
    const setup=setupIndex(),target={xMm:46000,zMm:45000},otherTarget={xMm:39000,zMm:45000},other:Unit={...structuredClone(setup.worker),id:'indexed_opposite',xMm:45000,zMm:45000,orders:[{kind:'move',target:otherTarget,manualOrder:true}],path:[otherTarget],pathDestination:otherTarget};
    setup.worker.zMm=45000;setup.worker.orders=[{kind:'move',target,manualOrder:true}];setup.worker.path=[target];setup.worker.pathDestination=target;setup.payload.state.entities[other.id]=other;
    setup.home.queue=[{id:'index_birth',kind:'train',typeId:'villager',originalCost:{...units.villager.cost},work:0,required:3,reserved:true,started:true,state:'active'}];
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.movementRosterDiagnostics();await compare(live,scalar);
    expect(Simulation.movementRosterDiagnostics().reconciled-before.reconciled).toBe(2);expect(Simulation.movementRosterDiagnostics().reused-before.reused).toBeGreaterThan(0);expect(live.state.economies.a!.statistics.unitsTrained).toBe(setup.payload.state.economies.a!.statistics.unitsTrained+1);
    for(let frame=0;frame<3;frame++){await compare(live,scalar);const a=live.state.entities[setup.worker.id] as Unit,b=live.state.entities[other.id] as Unit;expect(Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);}
  });
  it('updates garrison entry and later ungarrison immediately without changing actor membership',async()=>{
    const setup=setupIndex();setup.worker.xMm=setup.home.xMm+6750;setup.worker.zMm=setup.home.zMm;setup.worker.orders=[{kind:'garrison',targetId:setup.home.id,manualOrder:true}];
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.movementRosterDiagnostics();await compare(live,scalar);
    expect((live.state.entities[setup.worker.id] as Unit).garrisonedIn).toBe(setup.home.id);expect(Simulation.movementRosterDiagnostics().reconciled-before.reconciled).toBe(1);expect(Simulation.movementRosterDiagnostics().reused-before.reused).toBe(5);
    send([live,scalar],{kind:'ungarrison',buildingId:setup.home.id,unitIds:[setup.worker.id]});await compare(live,scalar);expect((live.state.entities[setup.worker.id] as Unit).garrisonedIn).toBeUndefined();
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each([false,true])('reconciles combat deaths before destroyed-garrison exits, including blocked ejection=%s',async trapped=>{
    const setup=setupIndex(),radius=units.villager.collisionRadiusM*1000,half=buildings.town_center.footprintCells[0]!*balance.rules.buildingGridM*500;
    setup.home.demolitionTick=setup.payload.state.tick+3;
    const occupant:Unit={...structuredClone(setup.worker),id:'indexed_occupant',xMm:setup.home.xMm,zMm:setup.home.zMm,garrisonedIn:setup.home.id,orders:[],path:[]};setup.home.garrisoned=[occupant.id];setup.payload.state.entities[occupant.id]=occupant;
    const corpse:Unit={...structuredClone(setup.worker),id:'indexed_dying_exit_blocker',xMm:setup.home.xMm-half,zMm:setup.home.zMm+half+radius+500,hp:1,orders:[],path:[]};setup.payload.state.entities[corpse.id]=corpse;
    setup.payload.state.projectiles=[{id:'indexed_lethal_impact',kind:'arrow',ownerId:'b',sourceId:'prior_enemy',targetId:corpse.id,from:{xMm:corpse.xMm,zMm:corpse.zMm+1000},aim:{xMm:corpse.xMm,zMm:corpse.zMm},launchTick:setup.payload.state.tick,hitTick:setup.payload.state.tick+3,attack:{attack:1000,attackType:'pierce',bonusDamage:{}}}];
    if(trapped){let sequence=0;const block=(xMm:number,zMm:number)=>{const id=`indexed_exit_tree_${sequence++}`;setup.payload.state.entities[id]={id,kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm,zMm,hp:1,maxHp:1,amount:250000};};for(let offset=-half;offset<=half;offset+=1000){block(setup.home.xMm+offset,setup.home.zMm+half+radius+500);block(setup.home.xMm+offset,setup.home.zMm-half-radius-500);block(setup.home.xMm+half+radius+500,setup.home.zMm+offset);block(setup.home.xMm-half-radius-500,setup.home.zMm+offset);}setup.payload.state.navigationRevision++;}
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.movementRosterDiagnostics();await compare(live,scalar);
    expect(live.state.entities[setup.home.id]).toBeUndefined();expect(live.state.entities[corpse.id]).toBeUndefined();expect(Simulation.movementRosterDiagnostics().reconciled-before.reconciled).toBeGreaterThan(1);expect(Simulation.movementRosterDiagnostics().reused-before.reused).toBeGreaterThan(0);
    if(trapped)expect(live.state.entities[occupant.id]).toBeUndefined();else expect(live.state.entities[occupant.id]).toMatchObject({xMm:corpse.xMm,zMm:corpse.zMm,hp:occupant.hp-Math.ceil(occupant.maxHp*balance.rules.garrisonEjectionDamageFraction)});
    const cold=createLiveSimulation(setup.options,live.capture());await compare(live,scalar);cold.advanceFrame();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('uses current displacement for gate opening and resets the proof at epoch and public-step boundaries',async()=>{
    const setup=setupIndex(),gate=addGate(setup),reach=buildings.wooden_gate.autoOpenDistanceM!*1000+units.villager.collisionRadiusM*1000;
    setup.worker.xMm=gate.xMm;setup.worker.zMm=gate.zMm+buildings.wooden_gate.footprintCells[1]!*balance.rules.buildingGridM*500+reach+200;
    const target={xMm:gate.xMm,zMm:gate.zMm-10000};setup.worker.orders=[{kind:'move',target,manualOrder:true}];setup.worker.path=[target];setup.worker.pathDestination=target;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.movementRosterDiagnostics();await compare(live,scalar);expect((live.state.entities[gate.id] as Building).gateOpen).toBe(true);expect(Simulation.movementRosterDiagnostics().reconciled-before.reconciled).toBe(1);
    for(const sim of [live,scalar])sim.invalidateEpoch();const next=Simulation.movementRosterDiagnostics();await compare(live,scalar);expect(Simulation.movementRosterDiagnostics().reconciled-next.reconciled).toBe(1);expect(Simulation.movementRosterDiagnostics().reused-next.reused).toBe(5);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
    const outside=Simulation.movementRosterDiagnostics();for(const sim of [live,scalar]){await sim.stepAsync();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(Simulation.movementRosterDiagnostics()).toEqual(outside);
  });
  it('keeps generic mutable hooks and permanently revoked owners on the original per-contact reconciliation',async()=>{
    const setup=setupIndex(),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);await compare(live,scalar);
    const prototype=Simulation.prototype as unknown as {all():Entity[]},original=prototype.all,before=Simulation.movementRosterDiagnostics();
    prototype.all=function(){return original.call(this);};
    try{await compare(live,scalar);expect(Simulation.movementRosterDiagnostics()).toEqual(before);}finally{prototype.all=original;}
    await compare(live,scalar);expect(Simulation.movementRosterDiagnostics()).toEqual(before);
    const mutable=new Simulation(setup.options,setup.payload),internal=mutable as unknown as {advanceTransitions(state:Simulation['state'],entities?:readonly Entity[]):void},transition=internal.advanceTransitions;internal.advanceTransitions=function(state,entities){const unit=state.entities[setup.worker.id] as Unit;unit.xMm+=100;transition.call(this,state,entities);};mutable.advanceFrame();expect((mutable.state.entities[setup.worker.id] as Unit).xMm).toBe(setup.worker.xMm+600);expect(Simulation.movementRosterDiagnostics()).toEqual(before);
  });
  it('drops frame proofs after terminal and exceptional partial frames before a subsequent frame',async()=>{
    const terminal=setupIndex();for(const entity of Object.values(terminal.payload.state.entities))if(entity.ownerId==='b')delete terminal.payload.state.entities[entity.id];const done=createLiveSimulation(terminal.options,terminal.payload),reference=new Simulation(terminal.options,terminal.payload),before=Simulation.movementRosterDiagnostics();await compare(done,reference);expect(done.state.status).toBe('FINISHED');expect(Simulation.movementRosterDiagnostics().reused-before.reused).toBe(0);
    // Unsupported saved content deliberately throws after the native frame has
    // seeded its index. Recovery uses an ordinary validated cancel-job command.
    const setup=setupIndex();setup.home.queue=[{id:'indexed_bad_saved_job',kind:'train',typeId:'missing_type' as 'villager',originalCost:{...units.villager.cost},work:0,required:1,reserved:true,started:true,state:'active'}];
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);for(const sim of [live,scalar])expect(()=>sim.advanceFrame()).toThrow();send([live,scalar],{kind:'cancel_job',buildingId:setup.home.id,jobId:'indexed_bad_saved_job'});
    const next=Simulation.movementRosterDiagnostics();await compare(live,scalar);expect(Simulation.movementRosterDiagnostics().reconciled-next.reconciled).toBe(1);expect(Simulation.movementRosterDiagnostics().reused-next.reused).toBe(5);
  });
});

describe('300ms normal-speed committed frames',()=>{
  it.each([false,true])('cold-restores and replays a saved deferred congestion timer through current traffic and legal yielding (five-second fallback: %s)',async aged=>{
    const setup=fixture(),original=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    const startTick=aged?125:65;delete setup.payload.state.entities[original.id];setup.payload.state.tick=startTick;setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';
    for(const [,saved]of setup.payload.runtime.localAvoidance)saved.deferred={version:1,nextRequestId:1,jobs:[]};
    const targetA={xMm:51000,zMm:45000},targetB={xMm:40000,zMm:45000},a:Unit={...structuredClone(original),id:'jam_a',xMm:45000,zMm:45000,orders:[{kind:'move',target:targetA,manualOrder:true}],path:[targetA],pathDestination:targetA,orderRevision:1,lastProgressTick:1},b:Unit={...structuredClone(a),id:'jam_b',xMm:45700,orders:[{kind:'move',target:targetB,manualOrder:true}],path:[targetB],pathDestination:targetB};
    const traffic:Unit={...structuredClone(a),id:'jam_traffic',xMm:45500,zMm:46800,orders:[{kind:'move',target:{xMm:49000,zMm:46800},manualOrder:true}],path:[{xMm:49000,zMm:46800}],pathDestination:{xMm:49000,zMm:46800}};
    for(const unit of [a,b,traffic])setup.payload.state.entities[unit.id]=unit;
    const local=new LocalAvoidance('deferred-v1'),neighbors=new UnitSpatialIndex(),nav=new Navigation(setup.payload.state.widthMm,setup.payload.state.heightMm,[]),radius=units.villager.collisionRadiusM*1000,speed=Math.round(units.villager.moveSpeedMps*1000/balance.rules.simulationHz),candidates=[a,b].map((unit,index)=>({body:{id:unit.id,xMm:unit.xMm,zMm:unit.zMm,radiusMm:radius},target:index?targetB:targetA,remainingPath:[index?targetB:targetA],orderRevision:1}));
    for(const candidate of candidates)neighbors.set(candidate.body);neighbors.set({id:traffic.id,xMm:traffic.xMm,zMm:traffic.zMm,radiusMm:radius});
    const contact=(tick:number)=>{local.beginTick(tick,8);for(const candidate of candidates)expect(local.step(candidate.body,candidate.target,speed,nav,neighbors,nav,()=>true,undefined,candidate.remainingPath,false,1)).toBeUndefined();};
    contact(1);local.admitDeferredResults(local.prepareDeferredQueries('a',1,candidates,neighbors,()=>true,8,1).map(query=>({query,points:[]})),2,nav);contact(2);contact(startTick-1);local.admitDeferredResults(local.prepareDeferredQueries('a',1,candidates,neighbors,()=>true,8,startTick-1).map(query=>({query,points:[]})),startTick,nav);
    const saved=local.exportState();saved.tick=startTick;expect(saved.routes.every(([,route])=>route.stableSinceTick===2)).toBe(true);setup.payload.runtime.localAvoidance.find(([owner])=>owner==='a')![1]=saved;
    // A one-millimetre blocker move invalidates the three-second signature;
    // the other actor's persisted pose/order wait still exceeds five seconds.
    if(aged)a.xMm--;
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),scalar=new Simulation(options,setup.payload),cold=createLiveSimulation(options,structuredClone(setup.payload)),before=ActiveWorkRoster.diagnostics().created;
    for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(ActiveWorkRoster.diagnostics().created).toBe(before+2);expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());
    const moved=live.state.entities[b.id] as Unit;expect(moved.xMm).toBeGreaterThan(b.xMm);expect(moved.lastProgressTick).toBeGreaterThan(startTick);expect(moved.orders[0]!.manualOrder).toBe(true);
    expect(live.capture().runtime.localAvoidance.find(([owner])=>owner==='a')![1].routes.find(([id])=>id===b.id)![1].yield?.requesterId).toBe(a.id);
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each(['gather','deposit','build','repair','reseed'] as const)('retains positive %s route preparation during a local detour without duplicate contact credits, and preserves cold replay',async kind=>{
    const setup=pendingWorkRouteFixture(kind),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=ActiveWorkRoster.diagnostics().created;
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(ActiveWorkRoster.diagnostics().created).toBe(before+1);expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);expect(live.movementDecisionDiagnostics().full).toBeLessThan(scalar.movementDecisionDiagnostics().full);
    expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());expect(live.committedFrameActions().actions.some(action=>action.id===setup.id)).toBe(false);
    const worker=live.state.entities[setup.id] as Unit;expect(worker.path).toEqual([setup.point]);expect(worker.lastProgressTick).toBe(1);expect(worker.blockedReason).toBe('PATH_BUSY');expect(worker.orders[0]!.manualOrder).toBe(true);
    expect(live.capture().runtime.localAvoidance.find(([id])=>id==='a')![1].deferred!.jobs).toHaveLength(1);
    const cold=createLiveSimulation(setup.options,live.capture());for(let frame=0;frame<3;frame++){
      const full=live.movementDecisionDiagnostics().full,reused=live.movementDecisionDiagnostics().reused;
      for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
      // Only the warm native owner retains the derived proof. Every contact
      // still runs once, with the identical saved local credits/results/state.
      expect(live.movementDecisionDiagnostics().full).toBe(full);expect(live.movementDecisionDiagnostics().reused-reused).toBe(6);
      expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    }
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each([1200,2200])('wakes retained local-detour work preparation when another actor enters the arrival face from %s mm away',async offset=>{
    const setup=pendingWorkRouteFixture('repair'),worker=setup.payload.state.entities[setup.id] as Unit;
    const occupant:Unit={...structuredClone(worker),id:'work_route_face_occupant',xMm:setup.point.xMm,zMm:setup.point.zMm+offset,orders:[{kind:'move',target:{...setup.point},manualOrder:true}],path:[{...setup.point}],pathDestination:{...setup.point},orderRevision:0};delete occupant.approachGoal;setup.payload.state.entities[occupant.id]=occupant;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);
    if(offset===2200)expect((live.state.entities[setup.id] as Unit).approachGoal?.point).toEqual(setup.point);
    const cold=createLiveSimulation(setup.options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect((live.state.entities[setup.id] as Unit).approachGoal?.point).not.toEqual(setup.point);
  });
  it.each(['epoch','order'] as const)('invalidates persistent stationary work preparation on a boundary %s change',async change=>{
    const setup=pendingWorkRouteFixture('repair'),live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}
    const full=live.movementDecisionDiagnostics().full;
    for(const sim of [live,scalar]){
      if(change==='epoch')sim.invalidateEpoch();
      else expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'replace_wait',clientSequence:1,command:{kind:'repair',unitIds:[setup.id],targetId:setup.targetId,queued:false}}).status).toBe('accepted');
      sim.advanceFrame();await sim.synchronizeCapture();
    }
    expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(full);expect(live.capture()).toEqual(scalar.capture());expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('keeps custom reservation helpers on scalar work-route preparation',async()=>{
    const setup=pendingWorkRouteFixture('deposit'),original=ApproachReservations.prototype.matchesClaim,before=ActiveWorkRoster.diagnostics().created;
    ApproachReservations.prototype.matchesClaim=()=>{throw new Error('CUSTOM_RESERVATION_PROOF_MUST_NOT_RUN');};
    try{
      const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);
      for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(live.movementDecisionDiagnostics().reused).toBe(0);expect(ActiveWorkRoster.diagnostics().created).toBe(before);
    }finally{ApproachReservations.prototype.matchesClaim=original;}
  });
  it.each(['unit','moving unit','building'] as const)('keeps lazy native ranged arrival reservations exact for a %s across cold save and replay',async kind=>{
    const setup=fixture(),attacker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,enemy=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!;
    setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';for(const [,saved]of setup.payload.runtime.localAvoidance)saved.deferred={version:1,nextRequestId:1,jobs:[]};
    attacker.typeId='archer';attacker.hp=attacker.maxHp=units.archer.maxHp;attacker.xMm=40000;attacker.zMm=30000;enemy.xMm=49000;enemy.zMm=30000;enemy.cooldown=1000;
    let target:Unit|Building=enemy;
    if(kind==='moving unit'){enemy.orders=[{kind:'move',target:{xMm:52000,zMm:30000},manualOrder:true}];enemy.path=[{xMm:52000,zMm:30000}];enemy.pathDestination={xMm:52000,zMm:30000};}
    if(kind==='building'){const home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='b')!;target={...structuredClone(home),id:'lazy_attack_building',xMm:53000,zMm:30000,rotation:90,cooldown:1000};setup.payload.state.entities[target.id]=target;setup.payload.state.navigationRevision++;}
    attacker.orders=[{kind:'attack',targetId:target.id,manualOrder:true}];attacker.path=[];
    const options={...setup.options,authoritativeIntervalMs:300 as const},primed=new Simulation(options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),live=createLiveSimulation(options,payload),scalar=new Simulation(options,payload);
    const before=ActiveWorkRoster.diagnostics().created;
    for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(ActiveWorkRoster.diagnostics().created).toBeGreaterThan(before);
    expect(live.capture().runtime.approachReservations.find(([owner])=>owner==='a')?.[1].some(([id])=>id===attacker.id)).toBe(true);
    const cold=createLiveSimulation(options,live.capture());
    for(let frame=0;frame<3;frame++){
      for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(cold.capture()).toEqual(live.capture());expect(live.view('a')).toEqual(scalar.view('a'));
    }
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('keeps admitted routes when the first deferred contact credit is exhausted past the old stall deadline',async()=>{
    const setup=fixture(),original=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,movers:Unit[]=[];
    setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';setup.payload.state.tick=120;
    for(const [,saved]of setup.payload.runtime.localAvoidance)saved.deferred={version:1,nextRequestId:1,jobs:[]};
    delete setup.payload.state.entities[original.id];
    // Two factions share eight contact credits: the fifth mover must survive
    // its first credit wait without inventing progress or discarding its route.
    for(let ordinal=0;ordinal<5;ordinal++){
      const worker:Unit={...structuredClone(original),id:`credit_wait_${ordinal}`,xMm:45000,zMm:45000+ordinal*10000,lastProgressTick:1,orderRevision:3},target={xMm:65000,zMm:worker.zMm};worker.orders=[{kind:'move',target,manualOrder:true}];worker.path=[target];worker.pathDestination=target;movers.push(worker);setup.payload.state.entities[worker.id]=worker;
      for(const [index,offset]of [[700,0],[-700,0],[0,700],[0,-700]].entries()){const blocker:Unit={...structuredClone(worker),id:`credit_blocker_${ordinal}_${index}`,xMm:worker.xMm+offset[0]!,zMm:worker.zMm+offset[1]!,orders:[],path:[]};delete blocker.pathDestination;setup.payload.state.entities[blocker.id]=blocker;}
    }
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(const sim of [live,reference]){sim.advanceFrame();for(const prior of movers){const current=sim.state.entities[prior.id] as Unit;expect(current.path,prior.id).toEqual(prior.path);expect(current.lastProgressTick).toBe(1);expect(current.pathBlockedRevision).toBeUndefined();expect(current.blockedReason).toBe('PATH_BUSY');}await sim.synchronizeCapture();}
    expect(live.capture()).toEqual(reference.capture());expect(live.stalledPlanningCandidates().map(row=>row.unitId).sort()).toEqual(movers.map(row=>row.id).sort());
  });
  it('retains an admitted global route while deferred local work waits, and cold-restores every recorded real-worker admission',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:worker.xMm+20000,zMm:worker.zMm};
    setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';setup.payload.state.tick=120;
    for(const [,saved]of setup.payload.runtime.localAvoidance)saved.deferred={version:1,nextRequestId:1,jobs:[]};
    worker.orders=[{kind:'move',target,manualOrder:true}];worker.orderRevision=3;worker.lastProgressTick=1;worker.path=[target];worker.pathDestination=target;
    for(const [index,offset]of [[700,0],[-700,0],[0,700],[0,-700]].entries()){const blocker:Unit={...structuredClone(worker),id:`deferred_blocker_${index}`,xMm:worker.xMm+offset[0]!,zMm:worker.zMm+offset[1]!,orders:[],path:[]};delete blocker.pathDestination;setup.payload.state.entities[blocker.id]=blocker;}
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload),service=new PathWorkerService({workerCount:2,performanceDiagnostics:true});
    const executor:PathPlanningExecutor={initialize:(...args)=>service.initialize(...args),advance:batch=>service.advance(batch),capture:()=>service.capture(),dispose:()=>service.dispose(),advanceService:(first,_maximum,groups)=>service.advanceService(first,1,groups?.slice(0,1)),stopServiceAfterCurrent:()=>service.stopServiceAfterCurrent()};
    await live.attachPlanningExecutor(executor);
    try{
      for(let frame=0;frame<4;frame++){
        live.advanceFrame();reference.advanceFrame();
        const pending=live.state.entities[worker.id] as Unit;expect(pending.path).toEqual([target]);expect(pending.lastProgressTick).toBe(1);expect(pending.taskState).toBe('moving');expect(pending.blockedReason).toBe('PATH_BUSY');expect(pending.pathBlockedRevision).toBeUndefined();expect({xMm:pending.xMm,zMm:pending.zMm}).toEqual({xMm:worker.xMm,zMm:worker.zMm});
        expect(live.stalledPlanningCandidates()).toContainEqual(expect.objectContaining({unitId:worker.id,orderRevision:3,progressTick:1}));
        await live.synchronizeCapture();await reference.synchronizeCapture();const capture=live.capture();expect(validateSimulationSavePayload(capture),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);expect(capture).toEqual(reference.capture());
        const cold=createLiveSimulation(options,capture);expect(cold.capture()).toEqual(capture);
        const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(capture);
      }
      expect(service.diagnostics().trace!.rows.some(row=>row.kind==='request'&&row.operation==='advance'&&(row.localQueries??0)>0)).toBe(true);
      expect(live.journalEvents().filter(event=>event.kind==='planning_service_admit').every(event=>event.kind==='planning_service_admit'&&event.leases===1)).toBe(true);
      const cold=createLiveSimulation(options,live.capture());for(const sim of [live,reference,cold]){sim.advanceFrame();await sim.synchronizeCapture();}expect(cold.capture()).toEqual(live.capture());expect(reference.capture()).toEqual(live.capture());
    }finally{await service.dispose();}
  },20000);
  it('prefetches local detours on real workers while keeping committed state, cold saves and replay identical',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:worker.xMm+20000,zMm:worker.zMm};worker.orders=[{kind:'move',target,manualOrder:true}];worker.path=[target];worker.pathDestination=target;
    for(const [index,offset]of [[700,0],[-700,0],[0,700],[0,-700]].entries()){const blocker:Unit={...structuredClone(worker),id:`prefetch_blocker_${index}`,xMm:worker.xMm+offset[0]!,zMm:worker.zMm+offset[1]!,orders:[],path:[]};delete blocker.pathDestination;setup.payload.state.entities[blocker.id]=blocker;}
    // A capture without the versioned mode deliberately retains its historical
    // synchronous local fallback; new games use the deferred contract above.
    expect(setup.payload.options.localPlanningMode).toBeUndefined();
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload),service=new PathWorkerService({workerCount:2,performanceDiagnostics:true});await live.attachPlanningExecutor(service);
    try{
      for(let frame=0;frame<3;frame++){for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());}
      expect(service.diagnostics().trace!.rows.some(row=>row.kind==='request'&&row.operation==='advance'&&(row.localQueries??0)>0)).toBe(true);
      const cold=createLiveSimulation(options,live.capture());for(const item of [live,reference,cold]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(cold.capture()).toEqual(reference.capture());
      const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
    }finally{await service.dispose();}
  },15000);
  it('retains actual activity from every contact slice and detaches the host evidence',()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:worker.xMm+400,zMm:worker.zMm};
    // Begin with the same admitted route: planner cadence is not activity evidence.
    worker.orders=[{kind:'move',target}];worker.path=[{...target}];worker.pathDestination={...target};
    const coarse=new Simulation({...setup.options,authoritativeIntervalMs:300},structuredClone(setup.payload)),scalar=new Simulation({...setup.options,authoritativeIntervalMs:50},structuredClone(setup.payload));
    const id=worker.id,fromTick=coarse.state.tick,expected=new Map<string,number>();
    for(let tick=0;tick<6;tick++){scalar.step();for(const action of scalar.committedUnitActions()){const key=`${action.id}:${action.kind}`;expected.set(key,(expected.get(key)??0)+1);}}
    coarse.advanceFrame();const evidence=coarse.committedFrameActions();
    expect({fromTick:evidence.fromTick,toTick:evidence.toTick}).toEqual({fromTick,toTick:fromTick+6});
    expect(new Map(evidence.actions.map(action=>[`${action.id}:${action.kind}`,action.ticks]))).toEqual(expected);
    expect(evidence.actions.some(action=>action.id===id&&action.kind==='move'&&action.ticks>0&&action.ticks<6)).toBe(true);
    expect(coarse.committedUnitActions().some(action=>action.id===id)).toBe(false);
    evidence.actions[0]!.ticks=999;evidence.actions.length=0;
    expect(new Map(coarse.committedFrameActions().actions.map(action=>[`${action.id}:${action.kind}`,action.ticks]))).toEqual(expected);
    const native=createLiveSimulation({...setup.options,authoritativeIntervalMs:300},structuredClone(setup.payload));
    native.advanceFrame();
    expect(new Map(native.committedFrameActions().actions.map(action=>[`${action.id}:${action.kind}`,action.ticks]))).toEqual(expected);
  });
  it.each(['opposing mover','arrival','following shortcut'] as const)('keeps a shorter native flight exact through a nearby %s, epoch change, cold restore and replay',async scenario=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target=scenario==='arrival'?{xMm:41000,zMm:worker.zMm}:scenario==='following shortcut'?{xMm:52500,zMm:worker.zMm+1000}:{xMm:75000,zMm:worker.zMm};
    worker.orders=[{kind:'move',target,formation:{id:'short_flight',center:{...target},anchor:{...target}}}];worker.path=scenario==='following shortcut'?[{xMm:70000,zMm:worker.zMm},{...target}]:[{...target}];worker.pathDestination={...target};
    if(scenario==='opposing mover'){const other:Unit={...structuredClone(worker),id:'short_flight_opposite',xMm:43000,orders:[{kind:'move',target:{xMm:36000,zMm:worker.zMm}}],path:[{xMm:36000,zMm:worker.zMm}],pathDestination:{xMm:36000,zMm:worker.zMm}};setup.payload.state.entities[other.id]=other;}
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),scalar=new Simulation(options,setup.payload);
    for(let frame=0;frame<3;frame++){
      for(const sim of [live,scalar]){sim.advanceFrame();await sim.synchronizeCapture();}expect(live.capture()).toEqual(scalar.capture());expect(live.view('a')).toEqual(scalar.view('a'));expect(live.committedFrameActions()).toEqual(scalar.committedFrameActions());
      if(frame===0){expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);if(scenario==='following shortcut')expect((live.state.entities[worker.id] as Unit).path[0]).toEqual(target);if(scenario==='opposing mover'){const first=live.state.entities[worker.id] as Unit,second=live.state.entities.short_flight_opposite as Unit;expect(Math.hypot(first.xMm-second.xMm,first.zMm-second.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);}for(const sim of [live,scalar])sim.invalidateEpoch();}
    }
    if(scenario==='arrival')expect((live.state.entities[worker.id] as Unit).orders).toEqual([]);
    const cold=createLiveSimulation(options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}expect(cold.capture()).toEqual(live.capture());expect(scalar.capture()).toEqual(live.capture());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each([
    {kind:'move' as const,formation:false,intermediate:false},
    {kind:'move' as const,formation:true,intermediate:false},
    {kind:'attack_move' as const,formation:true,intermediate:false},
    {kind:'patrol' as const,formation:true,intermediate:false},
    {kind:'move' as const,formation:true,intermediate:true},
    {kind:'attack_move' as const,formation:true,intermediate:true},
    {kind:'patrol' as const,formation:true,intermediate:true},
  ])('commits isolated free flight at every original event time with exact fog, save and replay state ($kind, formation $formation, intermediate $intermediate)',async({kind,formation,intermediate})=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:75001,zMm:45333};worker.orders=[{kind,target,...(formation?{formation:{id:'flight_formation',center:{...target},anchor:{...target}}}:{}),...(kind==='patrol'?{points:[{xMm:worker.xMm,zMm:worker.zMm},{...target}],pointIndex:1}:{})}];worker.path=intermediate?[{xMm:60000,zMm:45000},{...target}]:[{...target}];worker.pathDestination={...target};
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(let frame=0;frame<3;frame++){
      live.advanceFrame();reference.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());expect(live.view('a')).toEqual(reference.view('a'));
      if(frame===0){expect(live.movementDecisionDiagnostics()).toMatchObject({full:1,reused:5});expect(reference.movementDecisionDiagnostics().full).toBe(6);}
    }
    const captured=live.capture(),cold=createLiveSimulation(options,captured);live.advanceFrame();cold.advanceFrame();await live.synchronizeCapture();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each(['arrival','shortcut'] as const)('keeps an intermediate waypoint %s inside its original contact slice',async boundary=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:75000,zMm:worker.zMm};
    worker.orders=[{kind:'move',target,formation:{id:'waypoint_formation',center:{...target},anchor:{...target}}}];worker.path=boundary==='arrival'?[{xMm:worker.xMm+400,zMm:worker.zMm},{...target}]:[{xMm:70000,zMm:worker.zMm},{xMm:worker.xMm+12400,zMm:worker.zMm},{...target}];worker.pathDestination={...target};
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);live.advanceFrame();reference.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());expect(live.view('a')).toEqual(reference.view('a'));
    expect((live.state.entities[worker.id] as Unit).path[0]!.xMm).toBe(boundary==='arrival'?target.xMm:worker.xMm+12400);expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(1);
  });
  it.each(['attack_move','patrol'] as const)('interrupts formation %s free flight at the original enemy-acquisition slice',async kind=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,enemy=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!,target={xMm:75000,zMm:worker.zMm};
    worker.typeId='scout';worker.hp=worker.maxHp=units.scout.maxHp;worker.stance='aggressive';worker.orders=[{kind,target,formation:{id:'engaging_formation',center:{...target},anchor:{...target}},...(kind==='patrol'?{points:[{xMm:worker.xMm,zMm:worker.zMm},{...target}],pointIndex:1}:{})}];worker.path=[{...target}];worker.pathDestination={...target};enemy.xMm=worker.xMm+16750;enemy.zMm=worker.zMm;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload);
    for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(live.view('a')).toEqual(reference.view('a'));
    // Quantized fog first permits acquisition after the fourth 300 mm move;
    // matching only the frame endpoint would miss this interruption time.
    expect((live.state.entities[worker.id] as Unit).engagement).toMatchObject({targetId:enemy.id,anchor:{xMm:worker.xMm+1200,zMm:worker.zMm}});expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(1);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('invalidates formation free flight when a gate completes in a contact slice',async()=>{
    const setup=fixture(),gate=addGate(setup,'a',300),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={xMm:75000,zMm:worker.zMm},builder:Unit={...structuredClone(worker),id:'flight_gate_builder',xMm:gate.xMm,zMm:gate.zMm+1600,orders:[{kind:'build',targetId:gate.id,manualOrder:true}]};setup.payload.state.entities[builder.id]=builder;
    worker.orders=[{kind:'move',target,formation:{id:'gate_flight',center:{...target},anchor:{...target}}}];worker.path=[{...target}];worker.pathDestination={...target};
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}
    expect((live.state.entities[gate.id] as Building).work).toBe(gate.required);expect(live.capture()).toEqual(reference.capture());expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(1);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it.each(['move','attack_move','patrol'] as const)('invalidates formation %s free flight for a production exit inside the corridor before committing that slice',async kind=>{
    const setup=fixture(),primed=new Simulation(setup.options,setup.payload),home=Object.values(primed.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,worker=Object.values(primed.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,exit=(primed as unknown as {exitPosition(building:Building,typeId:string):{xMm:number;zMm:number}}).exitPosition(home,'villager');
    worker.xMm=exit.xMm-1000;worker.zMm=exit.zMm;const target={xMm:exit.xMm+20000,zMm:exit.zMm};worker.orders=[{kind,target,formation:{id:'spawn_flight',center:{...target},anchor:{...target}},...(kind==='patrol'?{points:[{xMm:worker.xMm,zMm:worker.zMm},{...target}],pointIndex:1}:{})}];worker.path=[{...target}];
    expect(primed.command('a',{protocolVersion:2,matchId:primed.state.matchId,matchEpoch:primed.state.matchEpoch,clientCommandId:'flight_spawn',clientSequence:1,command:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}}).status).toBe('accepted');home.queue[0]!.required=3;(primed as unknown as {updateVision():void}).updateVision();
    const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload);live.advanceFrame();reference.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());
    const mover=live.state.entities[worker.id] as Unit,spawn=Object.values(live.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.id!==worker.id)!;expect(spawn).toBeDefined();expect(Math.hypot(mover.xMm-spawn.xMm,mover.zMm-spawn.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);
  });
  it.each(['gather','deposit'] as const)('sleeps unchanged %s travel but wakes exact work/task/actions on arrival, with cold-save and replay parity',async kind=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    setup.payload.state.entities.travel_tree={id:'travel_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:worker.xMm+3000,zMm:worker.zMm,hp:1,maxHp:1,amount:250000};setup.payload.state.navigationRevision++;
    worker.orders=[{kind:'gather',targetId:'travel_tree',phase:kind==='deposit'?'deposit':'gather',...(kind==='deposit'?{dropOffId:home.id}:{})}];
    worker.path=[{xMm:kind==='deposit'?home.xMm+6750:worker.xMm+1500,zMm:worker.zMm}];
    if(kind==='deposit')worker.cargo={resource:'wood',amount:5000};
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),sim=new Simulation(options,payload),reference=new Simulation(options,payload),instrumented=new Simulation(options,payload),profiler=new WorkerSimulationStageDiagnostics(()=>0);
    unscheduledWorkOracle(reference);profiler.install(instrumented as unknown as Record<string,unknown>);
    try{
      for(let frame=0;frame<6;frame++){
        for(const item of [live,sim,reference,instrumented])item.advanceFrame();
        for(const item of [live,sim,reference,instrumented])await item.synchronizeCapture();
        const expected=reference.capture();for(const item of [live,sim,instrumented])expect(item.capture()).toEqual(expected);
      }
      expect(kind==='gather'?workSchedulingCounts(sim).transit:workSchedulingCounts(sim).pinnedDropoffs).toBeGreaterThan(0);
      const after=sim.state.entities[worker.id] as Unit;
      if(kind==='gather')expect(after.cargo.amount).toBeGreaterThan(0);else expect(sim.state.economies.a!.resources.wood).toBeGreaterThan(payload.state.economies.a!.resources.wood);
      const captured=sim.capture(),restored=restoreSimulation(sealSimulationCapture(captured,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(captured);
      const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(captured);
    }finally{profiler.restore();}
  });
  it.each([false,true])('sleeps ordinary pending movement only until boundary admission and preserves task state and exact replay (formation: %s)',async formation=>{
    const initial=stalledFixture(),payload=initial.sim.capture(),worker=payload.state.entities[initial.id] as Unit;
    if(formation)worker.orders[0]!.formation={id:'pending_formation',center:{...initial.oldPoint},anchor:{...initial.oldPoint}};
    const options={...payload.options,factions:payload.state.factions,seed:payload.state.map.seed,matchId:payload.state.matchId,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live])item.advanceFrame();
    expect(workSchedulingCounts(sim).moveWait).toBeGreaterThanOrEqual(4);
    for(const item of [sim,reference,live])await item.synchronizeCapture();expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const before=(sim.state.entities[initial.id] as Unit).xMm;
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}
    expect((sim.state.entities[initial.id] as Unit).xMm).toBeGreaterThan(before);expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it('sleeps newly requested validated group routes immediately and preserves manual replacement before stale ready paths are consumed',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,second:Unit={...structuredClone(worker),id:'second_marcher',zMm:worker.zMm+3000};setup.payload.state.entities[second.id]=second;
    const options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,setup.payload),reference=new Simulation(options,setup.payload),live=createLiveSimulation(options,setup.payload),pair=[sim,reference,live];unscheduledWorkOracle(reference);
    for(const item of pair){expect(item.command('a',{protocolVersion:2,matchId:item.state.matchId,matchEpoch:item.state.matchEpoch,clientCommandId:'group_wait',clientSequence:1,command:{kind:'move',unitIds:[worker.id,second.id],target:{xMm:75000,zMm:30000},queued:false}}).status).toBe('accepted');item.advanceFrame();}
    expect(workSchedulingCounts(sim).moveWait).toBe(10);
    for(const item of pair)await item.synchronizeCapture();expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const saved=sim.capture();expect(validateSimulationSavePayload(saved),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    for(const id of [worker.id,second.id]){const unit=saved.state.entities[id] as Unit;expect(unit.orders[0]).toMatchObject({manualOrder:true,formation:{checkedRevision:expect.any(Number)}});expect(unit.pathRequestId).toBeDefined();expect(unit.path).toEqual([]);}
    const cold=createLiveSimulation(options,saved),next={xMm:20000,zMm:50000};
    for(const item of [...pair,cold]){expect(item.command('a',{protocolVersion:2,matchId:item.state.matchId,matchEpoch:item.state.matchEpoch,clientCommandId:'replace_group_member',clientSequence:2,command:{kind:'move',unitIds:[worker.id],target:next,queued:false}}).status).toBe('accepted');item.advanceFrame();await item.synchronizeCapture();}
    for(const item of [sim,live,cold])expect(item.capture()).toEqual(reference.capture());
    const replaced=sim.state.entities[worker.id] as Unit;expect(replaced.orders[0]).toMatchObject({manualOrder:true,target:next});expect(replaced.pathDestination).toEqual(next);expect(replaced.path).toEqual([]);expect(replaced.pathRequestId).not.toBe((saved.state.entities[worker.id] as Unit).pathRequestId);
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it('wakes pending formations when gate completion changes planning geometry inside the frame',async()=>{
    const setup=fixture(),gate=addGate(setup,'a',300),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,second:Unit={...structuredClone(worker),id:'second_gate_marcher',zMm:worker.zMm+3000},builder:Unit={...structuredClone(worker),id:'gate_builder',xMm:gate.xMm,zMm:gate.zMm+1600,orders:[{kind:'build',targetId:gate.id,manualOrder:true}]};
    setup.payload.state.entities[second.id]=second;setup.payload.state.entities[builder.id]=builder;
    const options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,setup.payload),reference=new Simulation(options,setup.payload),live=createLiveSimulation(options,setup.payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){expect(item.command('a',{protocolVersion:2,matchId:item.state.matchId,matchEpoch:item.state.matchEpoch,clientCommandId:'gate_group_wait',clientSequence:1,command:{kind:'move',unitIds:[worker.id,second.id],target:{xMm:75000,zMm:30000},queued:false}}).status).toBe('accepted');item.advanceFrame();await item.synchronizeCapture();}
    expect((sim.state.entities[gate.id] as Building).work).toBe(gate.required);expect(workSchedulingCounts(sim).moveWait).toBeGreaterThan(0);expect(workSchedulingCounts(sim).moveWait).toBeLessThan(10);
    expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const revision=sim.capture().runtime.planningProfiles.find(([id])=>id==='a')![1].revision;for(const id of [worker.id,second.id])expect((sim.state.entities[id] as Unit).orders[0]!.formation!.checkedRevision).toBe(revision);
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it.each(['gather','deposit','build','repair'] as const)('retains a positive pending %s work face without repeating movement decisions and keeps exact save/replay',async kind=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const tree={id:'waiting_tree',kind:'resource' as const,typeId:'tree_oak',resource:'wood' as const,ownerId:null,xMm:worker.xMm+5000,zMm:worker.zMm,hp:1,maxHp:1,amount:250000};setup.payload.state.entities[tree.id]=tree;
    if(kind==='build'){const definition=buildings.house;setup.payload.state.entities.waiting_house={...structuredClone(home),id:'waiting_house',typeId:'house',xMm:worker.xMm+10000,hp:1,maxHp:definition.maxHp,grantedHp:1,work:0,required:definition.buildSeconds*balance.rules.simulationHz*100,queue:[]};}
    if(kind==='repair')home.hp-=100;
    worker.orders=[kind==='build'||kind==='repair'?{kind,targetId:kind==='build'?'waiting_house':home.id,manualOrder:true}:{kind:'gather',targetId:tree.id,phase:kind,manualOrder:true}];if(kind==='deposit')worker.cargo={resource:'wood',amount:5000};setup.payload.state.navigationRevision++;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live])item.advanceFrame();expect(workSchedulingCounts(sim).workFaceWait).toBe(5);if(kind==='deposit')expect(workSchedulingCounts(sim).pinnedDropoffs).toBeGreaterThan(0);
    for(const item of [sim,reference,live])await item.synchronizeCapture();expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const saved=sim.capture(),cold=createLiveSimulation(options,saved);expect(validateSimulationSavePayload(saved),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);expect((saved.state.entities[worker.id] as Unit).orders[0]!.manualOrder).toBe(true);
    for(const item of [sim,reference,live,cold]){item.advanceFrame();await item.synchronizeCapture();}for(const item of [sim,live,cold])expect(item.capture()).toEqual(reference.capture());
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it.each([false,true])('keeps sequential deposit face claims and generic callbacks exact when reusing a selected native approach (pinned: %s)',async pinned=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.lumber_camp,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const camp:Building={...structuredClone(home),id:'shared_dropoff',typeId:'lumber_camp',xMm:60000,zMm:30000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required,required,queue:[]};
    worker.xMm=50000;worker.zMm=30000;worker.cargo={resource:'wood',amount:5000};worker.orders=[{kind:'gather',targetId:'deposit_source',phase:'deposit',manualOrder:true,...(pinned?{dropOffId:camp.id}:{})}];worker.path=pinned?[{xMm:56000,zMm:30000}]:[];
    const other:Unit={...structuredClone(worker),id:'second_deposit_worker',zMm:32000,path:pinned?[{xMm:56000,zMm:32000}]:[]};setup.payload.state.entities[other.id]=other;setup.payload.state.entities[camp.id]=camp;setup.payload.state.entities.deposit_source={id:'deposit_source',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:50000,zMm:35000,hp:1,maxHp:1,amount:250000};setup.payload.state.navigationRevision++;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload),counts=ActiveWorkRoster.diagnostics();
    const internal=reference as unknown as {approachDestination(unit:Unit,target:Entity,route?:boolean,replace?:boolean):{xMm:number;zMm:number}|undefined},original=internal.approachDestination,calls:string[]=[];
    internal.approachDestination=function(unit,target,route,replace){calls.push(unit.id);return original.call(reference,unit,target,route,replace);};const remove=reference.registerFramePlanningDiagnostic('approachDestination',original,internal.approachDestination)!;
    try{
      for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}
      expect(ActiveWorkRoster.diagnostics().created).toBe(counts.created+1);expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());
      for(const unit of [worker,other])expect(calls.filter(id=>id===unit.id)).toHaveLength(2);
      const slots=live.capture().runtime.approachReservations.find(([id])=>id==='a')![1].filter(([id])=>id===worker.id||id===other.id);expect(slots).toHaveLength(2);expect(slots[0]![1].position).not.toEqual(slots[1]![1].position);expect(slots.every(([,slot])=>slot.targetId===camp.id)).toBe(true);
      const cold=createLiveSimulation(options,live.capture());for(const item of [live,reference,cold]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(cold.capture()).toEqual(reference.capture());
      const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
    }finally{remove();internal.approachDestination=original;}
  });
  it.each(['own','allied','enemy'] as const)('handles a pending deposit when a nearby %s camp completes without a navigation revision',async relation=>{
    const players=relation==='allied'?[...factions.map(faction=>({...faction,teamId:'a'})),{id:'c',name:'C',teamId:'c',kind:'human' as const,color:'#ffcc11'}]:factions;
    const setup=fixture(players),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.lumber_camp,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const camp:Building={...structuredClone(home),id:'finishing_camp',ownerId:relation==='own'?'a':'b',typeId:'lumber_camp',xMm:worker.xMm+4000,zMm:worker.zMm,hp:definition.maxHp-1,maxHp:definition.maxHp,grantedHp:definition.maxHp-1,work:required-300,required,queue:[]};
    const builder:Unit={...structuredClone(worker),id:'camp_builder',ownerId:camp.ownerId,xMm:camp.xMm+4000,zMm:camp.zMm,orders:[{kind:'build',targetId:camp.id,manualOrder:true}]};setup.payload.state.entities[camp.id]=camp;setup.payload.state.entities[builder.id]=builder;setup.payload.state.entities.deposit_tree={id:'deposit_tree',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:worker.xMm,zMm:worker.zMm+5000,hp:1,maxHp:1,amount:250000};
    worker.orders=[{kind:'gather',targetId:'deposit_tree',phase:'deposit',manualOrder:true}];worker.cargo={resource:'wood',amount:5000};setup.payload.state.navigationRevision++;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}expect(workSchedulingCounts(sim).workFaceWait).toBeGreaterThan(0);expect(sim.state.navigationRevision).toBe(payload.state.navigationRevision);expect((sim.state.entities[camp.id] as Building).work).toBe(required);expect((sim.state.entities[worker.id] as Unit).cargo.amount).toBe(relation==='enemy'?5000:0);expect(sim.state.economies.a!.resources.wood).toBe(payload.state.economies.a!.resources.wood+(relation==='enemy'?0:5000));
    expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it('wakes a pending repair face when a moving unit occupies its reserved arrival point',async()=>{
    const setup=stalledFixture(true),payload=setup.sim.capture(),worker=payload.state.entities[setup.id] as Unit,point={...setup.oldPoint},blocker:Unit={...structuredClone(worker),id:'work_face_blocker',xMm:point.xMm,zMm:point.zMm+1000,orders:[{kind:'move',target:point}],path:[point],orderRevision:0};
    delete blocker.pathRequestId;delete blocker.approachGoal;payload.state.entities[blocker.id]=blocker;
    const options={...payload.options,factions:payload.state.factions,seed:payload.state.map.seed,matchId:payload.state.matchId,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}expect(workSchedulingCounts(sim).workFaceWait).toBeGreaterThan(0);
    const next=sim.state.entities[setup.id] as Unit;expect(next.approachGoal!.point).not.toEqual(point);expect(next.pathRequestId).not.toBe('retained_pending');expect(next.approachGoal!.failedPoints).toBeUndefined();expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
  });
  it.each(['gather','build','repair','reseed'] as const)('reuses positive %s contact without inventing movement and preserves cancellation, actions, save and replay',async kind=>{
    const schedulingBefore=ActiveWorkRoster.diagnostics();
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,typeId=kind==='reseed'?'farm':'house',definition=buildings[typeId],required=definition.buildSeconds*balance.rules.simulationHz*100;
    const target:Entity=kind==='gather'?{id:'contact_target',kind:'resource' as const,typeId:'tree_oak',resource:'wood' as const,ownerId:null,xMm:60000,zMm:30000,hp:1,maxHp:1,amount:250000}:{...structuredClone(home),id:'contact_target',typeId,xMm:60000,zMm:30000,hp:kind==='repair'?definition.maxHp-100:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:kind==='build'?0:required,required,queue:[],...(kind==='reseed'?{foodRemaining:0,reseedWork:0,reseedRequired:10000}:{})};
    setup.payload.state.entities[target.id]=target;setup.payload.state.navigationRevision++;worker.xMm=target.xMm+(kind==='gather'?1000:definition.footprintCells[0]*balance.rules.buildingGridM*500+units.villager.collisionRadiusM*1000+500);worker.zMm=target.zMm;worker.orders=[{kind,targetId:target.id,manualOrder:true,...(kind==='gather'?{phase:'gather' as const}:{})}];worker.pathRequestId='contact_pending';worker.orderRevision=1;
    setup.payload.runtime.pathScheduler.tasks.push({id:'contact_pending',unitId:worker.id,profile:'a',orderRevision:1,from:{xMm:worker.xMm,zMm:worker.zMm},target:{xMm:75000,zMm:30000},radiusMm:units.villager.collisionRadiusM*1000,stage:'direct',lineStep:1,lineSteps:100});
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload);
    for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());expect(live.committedFrameActions().actions.some(action=>action.id===worker.id&&action.kind==='move')).toBe(false);expect(live.movementDecisionDiagnostics().full).toBe(0);expect(reference.movementDecisionDiagnostics().full).toBe(6);expect(live.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);
    const scheduling=ActiveWorkRoster.diagnostics();expect(scheduling.created).toBe(schedulingBefore.created+1);expect(scheduling.sleeps).toBeGreaterThan(schedulingBefore.sleeps);expect(scheduling.visits-schedulingBefore.visits).toBeLessThan(12);if(kind==='gather')expect(scheduling.contacts).toBeGreaterThan(schedulingBefore.contacts);
    const captured=live.capture();expect(validateSimulationSavePayload(captured),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const cold=createLiveSimulation(options,captured);
    const retained=ActiveWorkRoster.diagnostics();
    for(const item of [live,reference,cold]){const contacts=ActiveWorkRoster.diagnostics().contacts;item.advanceFrame();await item.synchronizeCapture();if(kind==='gather'&&item!==reference)expect(ActiveWorkRoster.diagnostics().contacts).toBeGreaterThan(contacts);}expect(live.capture()).toEqual(reference.capture());expect(cold.capture()).toEqual(reference.capture());
    // Warm work membership survives a commit/capture; only the cold owner
    // allocates a roster. Contacts still earn precisely the scalar work credit.
    expect(ActiveWorkRoster.diagnostics().created).toBe(retained.created+1);
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
    for(const item of [live,reference,cold]){const owner=item.state.entities[worker.id] as Unit;expect(item.command('a',{protocolVersion:2,matchId:item.state.matchId,matchEpoch:item.state.matchEpoch,clientCommandId:'leave_work_contact',clientSequence:1,command:{kind:'move',unitIds:[worker.id],target:{xMm:owner.xMm+1500,zMm:owner.zMm},queued:false}}).status).toBe('accepted');item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(cold.capture()).toEqual(reference.capture());expect((live.state.entities[worker.id] as Unit).orders[0]!.kind).toBe('move');
  });
  it.each(['full cargo','depleted resource','destroyed target'] as const)('wakes positive work contact after %s and keeps the exact ordinary transition',async event=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const target=event==='destroyed target'?{...structuredClone(home),id:'ending_contact',xMm:60000,zMm:30000,hp:home.maxHp-100,demolitionTick:setup.payload.state.tick+3}:{id:'ending_contact',kind:'resource' as const,typeId:'tree_oak',resource:'wood' as const,ownerId:null,xMm:60000,zMm:30000,hp:1,maxHp:1,amount:event==='depleted resource'?100:250000};
    setup.payload.state.entities[target.id]=target;setup.payload.state.navigationRevision++;worker.xMm=target.xMm+(event==='destroyed target'?6750:1000);worker.zMm=target.zMm;worker.orders=[{kind:event==='destroyed target'?'repair':'gather',targetId:target.id,manualOrder:true,...(event!=='destroyed target'?{phase:'gather' as const}:{})}];if(event==='full cargo')worker.cargo={resource:'wood',amount:balance.rules.carryCapacity*1000-100};
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload);for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}
    expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());expect(live.movementDecisionDiagnostics().full).toBeLessThan(reference.movementDecisionDiagnostics().full);const after=live.state.entities[worker.id] as Unit;if(event==='destroyed target'){expect(live.state.entities[target.id]).toBeUndefined();expect(after.orders).toEqual([]);}else{expect(after.orders[0]!.phase).toBe('deposit');expect(live.movementDecisionDiagnostics().full).toBeGreaterThan(0);}
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('keeps an occupied farm blocked instead of treating a stationary worker as active contact',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.farm,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const farm:Building={...structuredClone(home),id:'claimed_farm',typeId:'farm',xMm:60000,zMm:30000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required,required,foodRemaining:10000,farmerId:'assigned_farmer',queue:[]};worker.xMm=farm.xMm+definition.footprintCells[0]*balance.rules.buildingGridM*500+850;worker.zMm=farm.zMm;worker.orders=[{kind:'gather',targetId:farm.id,phase:'gather'}];const farmer:Unit={...structuredClone(worker),id:'assigned_farmer',xMm:worker.xMm+10000,path:[]};setup.payload.state.entities[farm.id]=farm;setup.payload.state.entities[farmer.id]=farmer;setup.payload.state.navigationRevision++;
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());expect(live.state.entities[worker.id]).toMatchObject({taskState:'blocked',blockedReason:'FARM_OCCUPIED',cargo:{amount:0}});
  });
  it('wakes dormant gatherers on both sides of a depletion event in exact actor order across bitset words',async()=>{
    const setup=fixture(),earlier=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,target={id:'shared_short_tree',kind:'resource' as const,typeId:'tree_oak',resource:'wood' as const,ownerId:null,xMm:60000,zMm:30000,hp:1,maxHp:1,amount:75};
    earlier.xMm=51000;earlier.zMm=30000;earlier.orders=[{kind:'gather',targetId:target.id,phase:'gather',manualOrder:true}];earlier.path=[{xMm:58500,zMm:30000}];
    const filler=(index:number):Unit=>({...structuredClone(earlier),id:`inert_${index}`,xMm:30000+(index%15)*1500,zMm:50000+Math.floor(index/15)*1500,orders:[],path:[]});for(let index=0;index<30;index++){const unit=filler(index);setup.payload.state.entities[unit.id]=unit;}
    const active:Unit={...structuredClone(earlier),id:'active_contact',xMm:61000,path:[]};setup.payload.state.entities[active.id]=active;
    for(let index=30;index<61;index++){const unit=filler(index);setup.payload.state.entities[unit.id]=unit;}
    const later:Unit={...structuredClone(earlier),id:'later_gatherer',xMm:69000,path:[{xMm:61500,zMm:30000}]};setup.payload.state.entities[later.id]=later;setup.payload.state.entities[target.id]=target;setup.payload.state.entities.next_tree={...target,id:'next_tree',xMm:65000,zMm:33000,amount:250000};setup.payload.state.navigationRevision++;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload),before=ActiveWorkRoster.diagnostics();
    for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());expect((live.state.entities[target.id] as {amount:number}).amount).toBe(0);
    const jobs=live.capture().runtime.pathScheduler.tasks,early=jobs.find(job=>job.unitId===earlier.id)!,late=jobs.find(job=>job.unitId===later.id)!;expect(late.enqueuedTick).toBe(payload.state.tick+4);expect(early.enqueuedTick).toBe(payload.state.tick+5);
    const counts=ActiveWorkRoster.diagnostics();expect(counts.created).toBe(before.created+1);expect(counts.sleeps-before.sleeps).toBeGreaterThan(60);expect(counts.contacts).toBeGreaterThan(before.contacts);expect(counts.visits-before.visits).toBeLessThan(65*6);
    const cold=createLiveSimulation(options,live.capture());for(const item of [live,reference,cold]){item.advanceFrame();await item.synchronizeCapture();}expect(live.capture()).toEqual(reference.capture());expect(cold.capture()).toEqual(reference.capture());const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('refreshes an active gather job on a midframe research completion without changing resource rounding',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.lumber_camp,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const research=technologies.forestry_1!,researchRequired=research.researchSeconds*balance.rules.simulationHz;
    const camp:Building={...structuredClone(home),id:'research_camp',typeId:'lumber_camp',xMm:30000,zMm:50000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required,required,queue:[{id:'midframe_forestry',kind:'research',typeId:'forestry_1',originalCost:{...research.cost},work:researchRequired-3,required:researchRequired,reserved:false,started:true,state:'active'}]};setup.payload.state.entities[camp.id]=camp;setup.payload.state.economies.a!.age=2;
    setup.payload.state.entities.research_tree={id:'research_tree',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:worker.xMm+1000,zMm:worker.zMm,hp:1,maxHp:1,amount:250000};setup.payload.state.navigationRevision++;worker.orders=[{kind:'gather',targetId:'research_tree',phase:'gather',manualOrder:true}];
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload),before=ActiveWorkRoster.diagnostics();for(const item of [live,reference]){item.advanceFrame();await item.synchronizeCapture();}
    expect(live.state.economies.a!.technologies).toContain('forestry_1');expect(live.capture()).toEqual(reference.capture());expect(live.committedFrameActions()).toEqual(reference.committedFrameActions());expect(ActiveWorkRoster.diagnostics().contacts).toBeGreaterThan(before.contacts);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('sleeps pending resource searches between service admissions and wakes on the admitted route',async()=>{
    const initial=stalledFixture(),payload=initial.sim.capture(),worker=payload.state.entities[initial.id] as Unit,tree={id:'pending_tree',kind:'resource' as const,typeId:'tree',resource:'wood' as const,ownerId:null,xMm:worker.xMm+5000,zMm:worker.zMm,hp:1,maxHp:1,amount:250000};
    payload.state.entities[tree.id]=tree;payload.state.navigationRevision++;worker.orders=[];worker.resourceSearch={purpose:'idle',targetIds:[tree.id],index:0};
    const request=payload.runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)!,point={xMm:tree.xMm-1500,zMm:tree.zMm};request.target=point;request.lineSteps=Math.ceil(Math.hypot(point.xMm-worker.xMm,point.zMm-worker.zMm)/250);worker.approachGoal={key:tree.id,revision:payload.runtime.planningProfiles.find(([id])=>id==='a')![1].revision,point};
    const options={...payload.options,factions:payload.state.factions,seed:payload.state.map.seed,matchId:payload.state.matchId,authoritativeIntervalMs:300 as const},primed=new Simulation(options,payload);(primed as unknown as {updateVision():void}).updateVision();const ready=primed.capture(),sim=new Simulation(options,ready),reference=new Simulation(options,ready),live=createLiveSimulation(options,ready);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}
    expect(workSchedulingCounts(sim).resourceWait).toBeGreaterThanOrEqual(4);expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}
    expect((sim.state.entities[worker.id] as Unit).resourceSearch).toBeUndefined();expect((sim.state.entities[worker.id] as Unit).orders[0]).toMatchObject({kind:'gather',targetId:tree.id});expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
  });
  it.each(['depleted resource','completed repair'] as const)('wakes transit work on a %s in the same frame',async event=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const target=event==='depleted resource'?{id:'wake_target',kind:'resource' as const,typeId:'tree',resource:'wood' as const,ownerId:null,xMm:worker.xMm+8000,zMm:worker.zMm,hp:1,maxHp:1,amount:1}:{...structuredClone(home),id:'wake_target',xMm:worker.xMm+12000,hp:home.maxHp-1,repairCredits:{a:999}};
    setup.payload.state.entities[target.id]=target;setup.payload.state.navigationRevision++;
    worker.orders=[event==='depleted resource'?{kind:'gather',targetId:target.id,phase:'gather'}:{kind:'repair',targetId:target.id}];worker.path=[{xMm:target.xMm-(event==='depleted resource'?1500:6750),zMm:worker.zMm}];
    const helper:Unit={...structuredClone(worker),id:'contact_worker',xMm:target.xMm+(event==='depleted resource'?1000:6750),path:[]};setup.payload.state.entities[helper.id]=helper;
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}
    expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
    const subject=sim.state.entities[worker.id] as Unit;expect((sim as unknown as {frameWorkWaits:WeakMap<Unit,unknown>}).frameWorkWaits.has(subject)).toBe(true);
    if(event==='depleted resource'){expect((sim.state.entities[target.id] as {amount:number}).amount).toBe(0);expect(subject.orders[0]?.targetId).not.toBe(target.id);}else{expect(sim.state.entities[target.id]!.hp).toBe(home.maxHp);expect(subject.orders).toEqual([]);}
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);runner.advanceTo(sim.state.tick);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
  it('wakes a retained deposit journey when its camp disappears and keeps the alternate-dropoff decision exact',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.lumber_camp,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const camp:Building={...structuredClone(home),id:'vanishing_camp',typeId:'lumber_camp',xMm:worker.xMm+10000,zMm:worker.zMm,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required,required,demolitionTick:setup.payload.state.tick+3,queue:[]};setup.payload.state.entities[camp.id]=camp;
    setup.payload.state.entities.deposit_tree={id:'deposit_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:worker.xMm,zMm:worker.zMm+4000,hp:1,maxHp:1,amount:250000};setup.payload.state.navigationRevision++;
    worker.orders=[{kind:'gather',targetId:'deposit_tree',phase:'deposit',dropOffId:camp.id}];worker.cargo={resource:'wood',amount:5000};worker.path=[{xMm:camp.xMm-4000,zMm:camp.zMm}];
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),options={...setup.options,authoritativeIntervalMs:300 as const},sim=new Simulation(options,payload),reference=new Simulation(options,payload),live=createLiveSimulation(options,payload);unscheduledWorkOracle(reference);
    for(const item of [sim,reference,live]){item.advanceFrame();await item.synchronizeCapture();}
    expect(workSchedulingCounts(sim).pinnedDropoffs).toBeGreaterThan(0);expect(sim.state.entities[camp.id]).toBeUndefined();expect((sim.state.entities[worker.id] as Unit).orders[0]?.dropOffId).toBe(home.id);
    expect(sim.capture()).toEqual(reference.capture());expect(live.capture()).toEqual(reference.capture());
  });
  it.each([false,true])('flushes final-slice discovery before background input/save/replay (terminal partial frame: %s)',async terminal=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,slices=terminal?3:6,step=Math.round(units.scout.moveSpeedMps*1000/balance.rules.simulationHz),treeX=61000;
    worker.typeId='scout';worker.hp=worker.maxHp=units.scout.maxHp;worker.xMm=treeX-units.scout.visionM*1000-slices*step+Math.floor(step/2);worker.zMm=31000;worker.orders=[];worker.path=[];
    setup.payload.state.entities.final_tree={id:'final_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:treeX,zMm:31000,hp:1,maxHp:1,amount:250000};setup.payload.state.navigationRevision++;
    if(terminal){
      setup.payload.state.tick=balance.rules.monumentHoldSeconds*balance.rules.simulationHz-slices;
      const home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.monument,required=definition.buildSeconds*balance.rules.simulationHz*100;
      setup.payload.state.entities.winning_monument={...structuredClone(home),id:'winning_monument',typeId:'monument',xMm:100000,zMm:100000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required,required,monumentCompletedTick:0,queue:[]};
    }
    const primed=new Simulation(setup.options,setup.payload);(primed as unknown as {updateVision():void}).updateVision();const payload=primed.capture(),moving=payload.state.entities[worker.id] as Unit;
    moving.orders=[{kind:'move',target:{xMm:treeX-1000,zMm:31000},manualOrder:true}];moving.path=[{xMm:treeX-1000,zMm:31000}];
    const options={...setup.options,monumentVictory:terminal,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,payload),reference=new Simulation(options,payload),instrumented=new Simulation(options,payload),profiler=new WorkerSimulationStageDiagnostics(()=>0),refreshTicks:number[]=[],internal=reference as unknown as {refreshPlanningNav(id:string):Navigation},original=internal.refreshPlanningNav;
    profiler.install(instrumented as unknown as Record<string,unknown>);
    const contactReference=new Simulation({...options,authoritativeIntervalMs:50},payload);contactReference.step(slices-1);expect(contactReference.state.vision.a!.memory.final_tree).toBeUndefined();contactReference.step();expect(contactReference.state.vision.a!.memory.final_tree).toBeDefined();
    internal.refreshPlanningNav=function(id){refreshTicks.push(reference.state.tick);return original.call(reference,id);};const remove=reference.registerPlanningRefreshDiagnostic(original,internal.refreshPlanningNav)!;
    try{
      expect(live.view('a').entities.some(entity=>entity.id==='final_tree')).toBe(false);expect(live.state.vision.a!.memory.final_tree).toBeUndefined();
      reference.advanceFrame();live.advanceFrame();profiler.beginCallback();const callback=new WorkerCallbackDiagnostics(()=>0).begin('timer');callback.measure('coreStep',()=>profiler.step(instrumented.state,()=>instrumented.advanceFrame()));expect(profiler.finishCallback(callback.finish()).steps[0]!.metrics.prepareMovement.calls).toBe(1);expect(live.state.tick).toBe(payload.state.tick+slices);expect(live.state.status).toBe(terminal?'FINISHED':'RUNNING');
      // Discovery occurs on the final contact slice, after its movement phase.
      expect(live.state.vision.a!.memory.final_tree!.lastSeenTick).toBe(live.state.tick);
      expect([...new Set(refreshTicks)]).toEqual([payload.state.tick+1,payload.state.tick+slices]);
      await live.synchronizeCapture();await reference.synchronizeCapture();await instrumented.synchronizeCapture();const captured=live.capture();expect(captured).toEqual(reference.capture());expect(instrumented.capture()).toEqual(captured);
      expect(captured.runtime.planningProfiles.find(([id])=>id==='a')![1].obstacles.some(([,obstacle])=>obstacle.id==='final_tree')).toBe(true);
      const restored=restoreSimulation(sealSimulationCapture(captured,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(captured);
      const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(captured);
    }finally{remove();internal.refreshPlanningNav=original;profiler.restore();}
  });
  it('starts local avoidance credits exactly once per contact slice, including conservative custom-hook execution',()=>{
    const setup=fixture(),sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload),internal=sim as unknown as {avoidance(id:string):{beginTick(tick:number,budget?:number):void}},avoidance=internal.avoidance('a'),original=avoidance.beginTick,ticks:number[]=[];
    avoidance.beginTick=function(tick,budget){ticks.push(tick);return original.call(avoidance,tick,budget);};
    try{sim.advanceFrame();expect(ticks).toEqual(Array.from({length:6},(_,index)=>setup.payload.state.tick+index+1));}finally{avoidance.beginTick=original;}
  });
  it('reuses native navigation preparation across unchanged committed frames with exact conservative parity',async()=>{
    const setup=fixture(),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(let frame=0;frame<4;frame++){
      live.advanceFrame();reference.advanceFrame();
      if(frame>0){expect(live.frameDiagnostics().phases.navigationPreparation).toBeUndefined();expect(reference.frameDiagnostics().phases.navigationPreparation).toBeDefined();}
      await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());
    }
  });
  it('refreshes a retained native profile when a closed AUTO gate becomes locked without a physical revision',async()=>{
    const setup=fixture(),gate=addGate(setup),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(const sim of [live,reference])sim.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();
    const before=live.capture(),obstacles=(capture:ReturnType<Simulation['capture']>)=>capture.runtime.planningProfiles.find(([id])=>id==='a')![1].obstacles.filter(([,obstacle])=>obstacle.id===gate.id);
    expect(obstacles(before)).toHaveLength(2);expect((live.state.entities[gate.id] as Building).gateOpen).toBe(false);
    for(const sim of [live,reference])expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:1,clientCommandId:'lock_retained_gate',clientSequence:1,command:{kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}}).status).toBe('accepted');
    for(const sim of [live,reference])sim.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();
    expect(live.state.navigationRevision).toBe(before.state.navigationRevision);expect(live.frameDiagnostics().phases.navigationPreparation).toBeDefined();expect(obstacles(live.capture())).toHaveLength(1);expect(live.capture()).toEqual(reference.capture());
  });
  it('refreshes retained AUTO-gate policy after an allied owner surrenders while the match continues',async()=>{
    const setup=fixture([...factions,{id:'c',name:'C',teamId:'a',kind:'human',color:'#33dd66'}]),gate=addGate(setup,'c'),options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(const sim of [live,reference])sim.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();
    const before=live.capture(),obstacles=(capture:ReturnType<Simulation['capture']>)=>capture.runtime.planningProfiles.find(([id])=>id==='c')![1].obstacles.filter(([,obstacle])=>obstacle.id===gate.id);expect(obstacles(before)).toHaveLength(2);
    for(const sim of [live,reference]){sim.adminSurrender('c');expect(sim.state.status).toBe('RUNNING');sim.advanceFrame();}
    await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.state.navigationRevision).toBe(before.state.navigationRevision);expect(obstacles(live.capture())).toHaveLength(1);expect(live.capture()).toEqual(reference.capture());
  });
  it('keeps retained navigation exact when an incomplete AUTO gate completes during the next frame',async()=>{
    const setup=fixture(),gate=addGate(setup,'a',700),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    worker.xMm=gate.xMm;worker.zMm=gate.zMm+1600;worker.orders=[{kind:'build',targetId:gate.id,manualOrder:true}];
    const options={...setup.options,authoritativeIntervalMs:300 as const},live=createLiveSimulation(options,setup.payload),reference=new Simulation(options,setup.payload);
    for(let frame=0;frame<2;frame++){for(const sim of [live,reference])sim.advanceFrame();await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());expect((live.state.entities[gate.id] as Building).work>=gate.required).toBe(frame===1);}
    expect(live.frameDiagnostics().phases.navigationPreparation).toBeDefined();
  });
  it('advances six game quanta per frame and preserves gathering/production rates and depletion',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    setup.payload.state.entities.food={id:'food',kind:'resource',typeId:'forage',resource:'food',ownerId:null,xMm:worker.xMm+1000,zMm:worker.zMm,hp:1,maxHp:1,amount:1000};
    worker.orders=[{kind:'gather',targetId:'food',phase:'gather'}];setup.payload.state.navigationRevision++;
    const reference=new Simulation(setup.options,setup.payload),coarse=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);
    for(const sim of [reference,coarse]){const home=Object.values(sim.state.entities).find(entity=>entity.kind==='building'&&entity.ownerId==='a')!;expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:1,clientCommandId:'train',clientSequence:1,command:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}}).status).toBe('accepted');}
    const start=coarse.state.tick;
    for(let frame=0;frame<10;frame++){reference.step(6);coarse.advanceFrame();}
    expect(coarse.state.tick-start).toBe(60);expect(coarse.state.frameRevision).toBe(10);
    const ownHome=(sim:Simulation)=>Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    expect(ownHome(coarse).queue[0]!.work).toBe(ownHome(reference).queue[0]!.work);
    expect(coarse.state.entities.food).toEqual(reference.state.entities.food);
    expect((coarse.state.entities[worker.id] as Unit).cargo).toEqual((reference.state.entities[worker.id] as Unit).cargo);
    await coarse.synchronizeCapture();expect(validateSimulationSavePayload(coarse.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
  });
  it('publishes exact authorized visual transitions within a frame and never retains them in ghost or save memory',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const definition=buildings.house,required=definition.buildSeconds*balance.rules.simulationHz*100;
    setup.payload.state.entities.visual_foundation={...structuredClone(home),id:'visual_foundation',typeId:'house',xMm:48000,zMm:30000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:required-100,required,queue:[]};
    worker.xMm=45000;worker.orders=[{kind:'build',targetId:'visual_foundation',manualOrder:true}];worker.path=[];
    const gate=addGate(setup);gate.gateMode='OPEN';setup.payload.state.navigationRevision++;
    const options={...setup.options,authoritativeIntervalMs:300 as const},reference=new Simulation(options,setup.payload),live=createLiveSimulation(options,setup.payload),scalar=new Simulation({...setup.options,authoritativeIntervalMs:50},setup.payload);
    const observations=new Map<number,Map<string,ReturnType<typeof scalar.view>['entities'][number]>>();
    for(let index=0;index<=6;index++){if(index)scalar.step();observations.set(scalar.state.tick,new Map(scalar.view('a').entities.map(entity=>[entity.id,entity])));}
    reference.advanceFrame();live.advanceFrame();const current=live.view('a');expect(current).toEqual(reference.view('a'));expect(validatePlayerView(current),JSON.stringify(validatePlayerView.errors)).toBe(true);
    const builder=current.entities.find(entity=>entity.id===worker.id)!,gateView=current.entities.find(entity=>entity.id===gate.id)!;
    expect(builder.visualTrace!.points.some(point=>point.visualAction?.kind==='build')).toBe(true);expect(builder.visualAction?.kind).toBe('idle');
    expect(gateView.visualTrace!.points.find(point=>point.gateOpen)?.tick).toBe(setup.payload.state.tick+1);
    for(const entity of [builder,gateView]){const trace=entity.visualTrace!;expect(trace.complete).toBe(true);expect(trace.fromTick).toBe(setup.payload.state.tick);expect(trace.points.length).toBeLessThanOrEqual(7);for(const point of trace.points){const observed=observations.get(point.tick)!.get(entity.id)!;expect(point.visualAction).toEqual(observed.visualAction);expect(point.gateOpen).toBe(observed.gateOpen);}}
    expect(current.entities.some(entity=>entity.ownerId==='b')).toBe(false);
    await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());expect(JSON.stringify(live.capture())).not.toContain('visualTrace');
    const forged=live.capture();Object.values(forged.state.vision.a!.memory)[0]!.visualTrace=gateView.visualTrace;expect(validateSimulationSavePayload(forged)).toBe(false);
    const cold=new Simulation(options,live.capture());expect(cold.view('a').entities.every(entity=>entity.visualTrace===undefined)).toBe(true);
    cold.advanceFrame();live.advanceFrame();expect(live.view('a')).toEqual(cold.view('a'));
  });
  it.each([0,1,2] as const)('publishes adaptive tier%s past motion at normal movement rate and excludes hidden enemies',async tier=>{
    const setup=fixture(),sim=createLiveSimulation({...setup.options,authoritativeIntervalMs:300},setup.payload),id=move(sim);
    sim.setMovementCadenceTier(tier);const interval=([300,450,600] as const)[tier],quanta=interval/50;
    for(let frame=0;frame<6;frame++)sim.advanceFrame();
    const view=sim.view('a'),entity=view.entities.find(entity=>entity.id===id)!;
    expect(validatePlayerView(view)).toBe(true);expect(view.authoritativeIntervalMs).toBe(interval);expect(view.publicationIntervalMs).toBe(interval);expect(sim.authoritativeFrameIntervalMs).toBe(interval);
    expect(view.committedTimeMs).toBe(sim.state.tick*50);expect(entity.motionTrace!.points.length).toBeGreaterThanOrEqual(2);expect(entity.motionTrace!.points.length).toBeLessThanOrEqual(quanta+1);
    const points=entity.motionTrace!.points;expect(points.at(-1)!.xMm-points[0]!.xMm).toBe(quanta*Math.round(units.villager.moveSpeedMps*1000/balance.rules.simulationHz));
    expect(view.entities.some(entity=>entity.ownerId==='b')).toBe(false);
    await sim.synchronizeCapture();
  });
  it('replays recorded background admissions and preserves a cold save exactly',async()=>{
    const setup=fixture(),sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);move(sim);
    for(let frame=0;frame<8;frame++)sim.advanceFrame();
    await sim.synchronizeCapture();const capture=sim.capture();
    const restored=restoreSimulation(sealSimulationCapture(capture,identity),identity,{preserveEpoch:true});
    expect(restored.capture()).toEqual(capture);
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);
    expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(capture);
    sim.advanceFrame();restored.advanceFrame();await sim.synchronizeCapture();await restored.synchronizeCapture();expect(restored.capture()).toEqual(sim.capture());
  });
  it.each([['compute pool',PathWorkerPool],['autonomous service',PathWorkerService]] as const)('does not await the %s during a frame and journals save-barrier admission',async(_name,Executor)=>{
    const setup=fixture(),sim=createLiveSimulation({...setup.options,authoritativeIntervalMs:300},setup.payload),pool=new Executor({workerCount:2});
    try{
      await sim.attachPlanningExecutor(pool);move(sim);
      for(let frame=0;frame<8;frame++){await sim.advanceFrameAsync();await new Promise<void>(resolve=>setImmediate(resolve));}
      expect(sim.state.tick).toBe(setup.payload.state.tick+48);
      expect(sim.journalEvents().some(event=>event.kind==='planning_service_start')).toBe(true);
      await sim.synchronizeCapture();
      expect(sim.journalEvents().at(-1)?.kind).toBe('planning_service_admit');
      const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);
      expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
    }finally{await pool.dispose();}
  });
  it('does not advance time or revision while paused',()=>{
    const setup=fixture(),sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);sim.setStatus('PAUSED');const tick=sim.state.tick,revision=sim.state.frameRevision;
    sim.advanceFrame();expect(sim.state.tick).toBe(tick);expect(sim.state.frameRevision).toBe(revision);
  });
  it('normalizes coarse replay seeks to committed frames and budgets actual 50 ms game quanta',async()=>{
    const setup=fixture(),sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload),start=sim.state.tick;
    for(let index=0;index<4;index++)sim.advanceFrame();await sim.synchronizeCapture();
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);
    expect(runner.advanceTo(start+1)).toMatchObject({tick:start,done:true});
    expect(runner.advanceTo(start+7)).toMatchObject({tick:start+6,done:true});
    expect(()=>runner.advanceTo(sim.state.tick,5)).toThrow('REPLAY_BUDGET_BELOW_FRAME');
    expect(runner.advanceTo(sim.state.tick,7)).toMatchObject({tick:start+12,done:false});
    expect(runner.advanceTo(sim.state.tick,7)).toMatchObject({tick:start+18,done:false});
    expect(runner.advanceTo(sim.state.tick,7)).toMatchObject({tick:start+24,done:true});
    expect(runner.advanceTo(start+7)).toMatchObject({tick:start+6,done:true});
  });
  it('records adaptive authority changes, clears obsolete trace bounds, cold-restores and seeks changing replay boundaries',async()=>{
    const setup=workFlightFixture('gather'),options=setup.options,live=createLiveSimulation(options,setup.payload),scalar=new Simulation(options,setup.payload),start=live.state.tick;
    const vision=new VisionMaskKernel();live.attachVisionExecutor(async frame=>vision.computeRetained(frame));
    let expected=start;
    for(const tier of [0,1,2,1,0] as const){
      for(const sim of [live,scalar]){
        sim.setMovementCadenceTier(tier);
        if(tier!==0||expected>start)expect(sim.view('a').entities.every(entity=>!entity.motionTrace&&!entity.visualTrace)).toBe(true);
        if(sim===live)await sim.advanceFrameAsync();else sim.advanceFrame();await sim.synchronizeCapture();
      }
      expected+=([6,9,12] as const)[tier];expect(live.state.tick).toBe(expected);expect(live.capture()).toEqual(scalar.capture());expect(validatePlayerView(live.view('a'))).toBe(true);
      if(expected===start+6)expect(live.view('a').entities.some(entity=>entity.motionTrace!==undefined)).toBe(true);
    }
    const cold=createLiveSimulation(options,live.capture());for(const sim of [live,scalar,cold]){sim.setMovementCadenceTier(2);sim.advanceFrame();await sim.synchronizeCapture();}
    expect(live.authoritativeFrameIntervalMs).toBe(600);expect(cold.capture()).toEqual(live.capture());expect(live.capture()).toEqual(scalar.capture());
    const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);
    expect(runner.advanceTo(start+7)).toMatchObject({tick:start+6,done:true});expect(runner.simulation.authoritativeFrameIntervalMs).toBe(450);
    expect(runner.advanceTo(start+16)).toMatchObject({tick:start+15,done:true});expect(runner.simulation.authoritativeFrameIntervalMs).toBe(600);
    expect(runner.advanceTo(start+28)).toMatchObject({tick:start+27,done:true});expect(runner.simulation.authoritativeFrameIntervalMs).toBe(450);
    expect(runner.advanceTo(start+14)).toMatchObject({tick:start+6,done:true});expect(()=>runner.advanceTo(live.state.tick,8)).toThrow('REPLAY_BUDGET_BELOW_FRAME');
    expect(runner.advanceTo(live.state.tick,9)).toMatchObject({tick:start+15,done:false});expect(runner.advanceTo(live.state.tick,12)).toMatchObject({tick:start+27,done:false});
    expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('amortizes frame preparation and planner submission at equal game time across adaptive cadences',async()=>{
    const setup=workFlightFixture('gather'),runs=[0,1,2].map(tier=>{const sim=createLiveSimulation(setup.options,setup.payload);sim.setMovementCadenceTier(tier as 0|1|2);return sim;}),start=setup.payload.state.tick;
    const frames:number[]=[],submissions:number[]=[];
    for(const sim of runs){const revision=sim.state.frameRevision??0;while(sim.state.tick<start+36){sim.advanceFrame();await sim.synchronizeCapture();}
      frames.push((sim.state.frameRevision??0)-revision);submissions.push(sim.journalEvents().filter(event=>event.kind==='planning_service_start').length);
      expect(sim.state.tick).toBe(start+36);expect(sim.state.entities).toEqual(runs[0]!.state.entities);expect(sim.state.economies).toEqual(runs[0]!.state.economies);
    }
    expect(frames).toEqual([6,4,3]);expect(submissions).toEqual([6,4,3]);
  });
  it.each([0,1,2] as const)('keeps opposing allied movers separated at every contact sample inside adaptive tier%s',async tier=>{
    const setup=fixture(),one=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    one.orders=[{kind:'move',target:{xMm:48000,zMm:30000}}];one.path=[{xMm:48000,zMm:30000}];
    const two:Unit={...structuredClone(one),id:'opposite',xMm:41600,orders:[{kind:'move',target:{xMm:36000,zMm:30000}}],path:[{xMm:36000,zMm:30000}]};setup.payload.state.entities[two.id]=two;
    const sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);sim.setMovementCadenceTier(tier);sim.advanceFrame();
    const view=sim.view('a'),first=view.entities.find(entity=>entity.id===one.id)!.motionTrace!.points,second=view.entities.find(entity=>entity.id===two.id)!.motionTrace!.points;
    const at=(points:typeof first,tick:number)=>{const right=points.find(point=>point.tick>=tick)!;const left=points.filter(point=>point.tick<=tick).at(-1)!;const ratio=right.tick===left.tick?0:(tick-left.tick)/(right.tick-left.tick);return {xMm:left.xMm+(right.xMm-left.xMm)*ratio,zMm:left.zMm+(right.zMm-left.zMm)*ratio};};
    for(let tick=first[0]!.tick;tick<=first.at(-1)!.tick;tick++){const a=at(first,tick),b=at(second,tick);expect(Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*2000);}
    expect(first.at(-1)!.xMm).toBeGreaterThan(first[0]!.xMm);await sim.synchronizeCapture();
  });
  it.each([0,1,2] as const)('checks physical barriers inside adaptive tier%s even when a retained route crosses a newly known ridge',async tier=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    worker.xMm=59000;worker.orders=[{kind:'move',target:{xMm:66000,zMm:30000}}];worker.path=[{xMm:66000,zMm:30000}];
    setup.payload.state.map.terrain=[{id:'new_ridge',kind:'ridge',xMm:60000,zMm:25000,widthMm:2000,depthMm:10000,elevationMm:14000}];setup.payload.state.navigationRevision++;
    const sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload),nav=new Navigation(sim.state.widthMm,sim.state.heightMm,terrainObstacles(sim.state.map.terrain));
    sim.setMovementCadenceTier(tier);sim.advanceFrame();const points=sim.view('a').entities.find(entity=>entity.id===worker.id)!.motionTrace!.points;expect(points.length).toBeGreaterThanOrEqual(2);expect(points.length).toBeLessThanOrEqual(13);
    for(let index=1;index<points.length;index++)expect(nav.clearLine(points[index-1]!,points[index]!,units.villager.collisionRadiusM*1000)).toBe(true);
    expect(points.at(-1)!.xMm).toBeLessThan(60000);await sim.synchronizeCapture();
  });
  it.each([0,1,2] as const)('drops buffered enemy motion immediately when visibility ends during adaptive tier%s',async tier=>{
    const setup=fixture(),enemy=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!;
    enemy.typeId='scout';enemy.hp=enemy.maxHp=units.scout.maxHp;enemy.xMm=48500;enemy.zMm=30000;enemy.orders=[{kind:'move',target:{xMm:60000,zMm:30000}}];enemy.path=[{xMm:60000,zMm:30000}];
    const sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);sim.setMovementCadenceTier(tier);(sim as unknown as {updateVision():void}).updateVision();
    const live=createLiveSimulation({...setup.options,authoritativeIntervalMs:300},sim.capture());expect(sim.view('a').entities.some(entity=>entity.id===enemy.id)).toBe(true);sim.advanceFrame();live.advanceFrame();
    const view=sim.view('a');expect(view.entities.some(entity=>entity.id===enemy.id)).toBe(false);
    expect(JSON.stringify(view.entities)).not.toContain(enemy.id);expect(live.view('a')).toEqual(view);await sim.synchronizeCapture();await live.synchronizeCapture();expect(live.capture()).toEqual(sim.capture());
    // The following begin-frame reuses an existing perception snapshot. A
    // concealed unit must not recover its previous visible motion history.
    sim.advanceFrame();live.advanceFrame();expect(live.view('a')).toEqual(sim.view('a'));expect(JSON.stringify(live.view('a').entities)).not.toContain(enemy.id);await sim.synchronizeCapture();await live.synchronizeCapture();
  });
  it('keeps garrison disappearance and later emergence traces exact with retained actor membership',async()=>{
    const setup=fixture(),worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    worker.xMm=home.xMm+6750;worker.zMm=home.zMm;worker.orders=[{kind:'garrison',targetId:home.id}];worker.path=[];
    const options={...setup.options,authoritativeIntervalMs:300 as const},reference=new Simulation(options,setup.payload),live=createLiveSimulation(options,setup.payload);
    for(let frame=0;frame<2;frame++){
      reference.advanceFrame();live.advanceFrame();expect(live.view('a')).toEqual(reference.view('a'));expect((live.state.entities[worker.id] as Unit).garrisonedIn).toBe(home.id);expect(live.view('a').entities.find(entity=>entity.id===worker.id)!.motionTrace).toBeUndefined();expect(live.view('a').entities.find(entity=>entity.id===worker.id)!.visualTrace).toBeUndefined();
    }
    for(const sim of [reference,live])expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'trace_ungarrison',clientSequence:1,command:{kind:'ungarrison',buildingId:home.id,unitIds:[worker.id]}}).status).toBe('accepted');
    reference.advanceFrame();live.advanceFrame();expect((live.state.entities[worker.id] as Unit).garrisonedIn).toBeUndefined();expect(live.view('a')).toEqual(reference.view('a'));expect(live.view('a').entities.find(entity=>entity.id===worker.id)!.motionTrace?.points[0]!.tick).toBe(setup.payload.state.tick+13);
    await reference.synchronizeCapture();await live.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);runner.advanceTo(live.state.tick);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('reports wall-age pending movement without discarding useful search progress and replays the boundary exactly',async()=>{
    const {sim,id}=stalledFixture(),before=sim.capture(),proposal=sim.stalledPlanningCandidates()[0]!;
    expect(proposal).toMatchObject({unitId:id,requestId:'retained_pending',orderRevision:3});
    expect(sim.recoverStalledPlanning([{...proposal,orderRevision:2}])).toBe(0);
    expect(sim.recoverStalledPlanning([proposal])).toBe(1);await sim.synchronizeCapture();
    const capture=sim.capture(),worker=sim.state.entities[id] as Unit;
    expect(worker.pathRequestId).toBe('retained_pending');expect(worker.blockedReason).toBe('PATH_BUSY');expect(worker.orders).toEqual(before.state.entities[id]!.kind==='unit'?(before.state.entities[id] as Unit).orders:[]);
    expect(capture.runtime.pathScheduler).toEqual(before.runtime.pathScheduler);
    expect(sim.journalEvents().at(-1)?.kind).toBe('planning_stall_recovery');
    const event=sim.journalEvents().at(-1)!;expect(validateJournalEvent(event)).toBe(true);expect(validateJournalEvent({...event,proposals:[proposal,proposal]})).toBe(false);expect(validateJournalEvent({...event,proposals:[{...proposal,progressTick:sim.state.tick+1}]})).toBe(false);
    const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(capture);
  });
  it('rotates a stalled repair face only to a legal alternate while preserving the authorized order and economy',async()=>{
    const {sim,id,oldPoint}=stalledFixture(true),worker=sim.state.entities[id] as Unit,before=structuredClone({orders:worker.orders,cargo:worker.cargo,economy:sim.state.economies.a});
    expect(sim.recoverStalledPlanning(sim.stalledPlanningCandidates())).toBe(1);
    expect(worker.approachGoal!.point).toBeDefined();expect(worker.approachGoal!.point).not.toEqual(oldPoint);expect(worker.approachGoal!.failedPoints).toContainEqual(oldPoint);expect(worker.pathRequestId).toBeUndefined();
    expect({orders:worker.orders,cargo:worker.cargo,economy:sim.state.economies.a}).toEqual(before);expect(worker.orders[0]!.manualOrder).toBe(true);
    const nav=(sim as unknown as {planningNav(profile:string):Navigation}).planningNav('a');expect(nav.free(worker.approachGoal!.point!,units.villager.collisionRadiusM*1000)).toBe(true);
    await sim.synchronizeCapture();const capture=sim.capture(),runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);runner.advanceTo(sim.state.tick);expect(runner.simulation.capture()).toEqual(capture);
  });
  it('preserves a pending repair frontier when no other authorized face is free',async()=>{
    const {sim,id,oldPoint}=stalledFixture(true),worker=sim.state.entities[id] as Unit,internal=sim as unknown as {planningNav(profile:string):Navigation},originalNav=internal.planningNav.bind(sim),nav=originalNav('a');
    const onlyCurrentFace=new Proxy({} as Navigation,{get:(_object,property)=>property==='free'?((point:{xMm:number;zMm:number})=>point.xMm===oldPoint.xMm&&point.zMm===oldPoint.zMm):typeof Reflect.get(nav,property)==='function'?Reflect.get(nav,property).bind(nav):Reflect.get(nav,property)});
    internal.planningNav=()=>onlyCurrentFace;
    expect(sim.recoverStalledPlanning(sim.stalledPlanningCandidates())).toBe(1);
    expect(worker.pathRequestId).toBe('retained_pending');expect(worker.approachGoal!.point).toEqual(oldPoint);expect(worker.approachGoal!.failedPoints).toBeUndefined();expect(worker.blockedReason).toBe('PATH_BUSY');
    internal.planningNav=originalNav;await sim.synchronizeCapture();expect(sim.capture().runtime.pathScheduler.tasks[0]!.lineStep).toBe(1);
  });
});

describe('native phase role rosters',()=>{
  function setupRoles(){
    const setup=fixture(),home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,worker=Object.values(setup.payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!;
    const add=(id:string,typeId:Building['typeId'],xMm:number,zMm:number)=>{const def=buildings[typeId],required=def.buildSeconds*balance.rules.simulationHz*100,building:Building={...structuredClone(home),id,typeId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,grantedHp:def.maxHp,work:required,required,queue:[],...(typeId==='farm'?{foodRemaining:10000}:{})};setup.payload.state.entities[id]=building;return building;};
    const farm=add('role_farm','farm',52000,52000),gate=addGate(setup);
    const trebuchet:Unit={...structuredClone(worker),id:'role_trebuchet',typeId:'trebuchet',xMm:90000,zMm:20000,hp:units.trebuchet.maxHp,maxHp:units.trebuchet.maxHp,deploymentState:'deploying',transitionTicks:8,transitionRequired:8,desiredDeployment:'packed'};setup.payload.state.entities[trebuchet.id]=trebuchet;
    for(let index=0;index<24;index++)add(`role_house_${index}`,'house',10000+(index%8)*10000,85000+Math.floor(index/8)*10000);
    for(let index=0;index<128;index++){const id=`role_tree_${index}`;setup.payload.state.entities[id]={id,kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:1000+(index%32)*3000,zMm:setup.payload.state.heightMm-14000+Math.floor(index/32)*3000,hp:1,maxHp:1,amount:250000};}
    setup.payload.state.navigationRevision++;return {...setup,options:{...setup.options,authoritativeIntervalMs:300 as const},home,worker,farm,gate,trebuchet,add};
  }
  async function compare(live:ReturnType<typeof createLiveSimulation>,scalar:Simulation){
    live.advanceFrame();scalar.advanceFrame();await live.synchronizeCapture();await scalar.synchronizeCapture();expect(live.capture()).toEqual(scalar.capture());for(const player of factions)expect(live.view(player.id)).toEqual(scalar.view(player.id));
  }
  function send(live:ReturnType<typeof createLiveSimulation>,scalar:Simulation,command:GameplayCommand){
    const sequence=scalar.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2 as const,matchId:scalar.state.matchId,matchEpoch:scalar.state.matchEpoch,clientCommandId:`phase_role_${sequence}`,clientSequence:sequence,command},receipt=scalar.command('a',envelope);expect(receipt.status,JSON.stringify(receipt)).toBe('accepted');expect(live.command('a',envelope)).toEqual(receipt);
  }
  it('visits only current role candidates while retaining exact gates, chained transitions, production, cold restore and replay',async()=>{
    const setup=setupRoles();setup.home.queue=[{id:'role_pending_train',kind:'train',typeId:'villager',originalCost:{...units.villager.cost},work:0,required:units.villager.trainSeconds*balance.rules.simulationHz,reserved:true,started:true,state:'active'}];setup.farm.farmerId=setup.worker.id;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),before=Simulation.phaseRosterDiagnostics();
    await compare(live,scalar);const after=Simulation.phaseRosterDiagnostics();
    expect(after.rebuilt-before.rebuilt).toBe(1);for(const key of ['gates','transitions','production','farms'] as const)expect(after[key]-before[key]).toBe(6);
    // Six contact boundaries plus the final geometry flush visit the one gate,
    // not the 24 unrelated houses, other actors or 128 resource nodes.
    expect(after.planningGates-before.planningGates).toBe(7);
    expect((live.state.entities[setup.home.id] as Building).queue[0]!.work).toBe(6);expect((live.state.entities[setup.farm.id] as Building).farmerId).toBeUndefined();expect((live.state.entities[setup.trebuchet.id] as Unit).transitionTicks).toBe(2);
    const cold=createLiveSimulation(setup.options,live.capture());await compare(live,scalar);cold.advanceFrame();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());expect((live.state.entities[setup.trebuchet.id] as Unit).deploymentState).toBe('packing');
    expect(validateSimulationSavePayload(live.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const runner=new ReplayRunner(exportReplay(live,identity,[replayCheckpoint(live)]),identity);expect(runner.advanceTo(live.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(live.capture());
  });
  it('wakes warm production membership for train, research and age commands and clears cancelled queues',async()=>{
    const setup=setupRoles();setup.payload.state.economies.a!.age=2;setup.payload.state.economies.a!.resources={food:10000000,wood:10000000,gold:10000000,stone:10000000};setup.add('role_market','market',60000,65000);setup.add('role_blacksmith','blacksmith',80000,65000);
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload);await compare(live,scalar);
    const home=()=>scalar.state.entities[setup.home.id] as Building;
    for(const command of [{kind:'train',buildingId:setup.home.id,unitType:'villager',quantity:1},{kind:'research',buildingId:setup.home.id,technologyId:'wheelbarrow'},{kind:'advance_age',townCenterId:setup.home.id,targetAge:3}] as const){
      send(live,scalar,command);const before=Simulation.phaseRosterDiagnostics().production;await compare(live,scalar);expect(Simulation.phaseRosterDiagnostics().production-before).toBe(6);expect(home().queue[0]!.work).toBe(6);
      send(live,scalar,{kind:'cancel_job',buildingId:setup.home.id,jobId:home().queue[0]!.id});const cleared=Simulation.phaseRosterDiagnostics().production;await compare(live,scalar);expect(Simulation.phaseRosterDiagnostics().production).toBe(cleared);expect(home().queue).toHaveLength(0);
    }
  });
  it('keeps active producers in world order across population reservation, completion and actor insertion',async()=>{
    const setup=setupRoles();
    // Two queues contend for the one remaining population slot. Completing the
    // first queue invalidates the actor roster without skipping the later one.
    for(const [id,entity]of Object.entries(setup.payload.state.entities))if(entity.kind==='building'&&entity.ownerId==='a'&&id!==setup.home.id)delete setup.payload.state.entities[id];
    delete setup.payload.state.entities[setup.trebuchet.id];
    const producer=setup.add('role_second_producer','town_center',80000,50000),population=buildings.town_center.populationProvided*2;
    for(let index=1;index<population-1;index++){const unit={...structuredClone(setup.worker),id:`role_population_${index}`,xMm:10000+index*2000,zMm:70000};setup.payload.state.entities[unit.id]=unit;}
    const job=(id:string):Building['queue'][number]=>({id,kind:'train',typeId:'villager',originalCost:{food:50,wood:0,gold:0,stone:0},work:0,required:1,reserved:false,started:false,state:'waiting'});setup.home.queue=[job('role_first')];producer.queue=[job('role_second')];setup.payload.state.navigationRevision++;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),trained=setup.payload.state.economies.a!.statistics.unitsTrained;await compare(live,scalar);
    expect(live.state.economies.a!.statistics.unitsTrained).toBe(trained+1);expect((live.state.entities[setup.home.id] as Building).queue).toHaveLength(0);expect((live.state.entities[producer.id] as Building).queue[0]!.state).toBe('population_blocked');
    const cold=createLiveSimulation(setup.options,live.capture());await compare(live,scalar);cold.advanceFrame();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());
  });
  it('retains production order across bit 31/32, simultaneous completions and removal of a queued producer',async()=>{
    const setup=setupRoles();let count=Object.values(setup.payload.state.entities).filter(entity=>entity.kind==='building').length;
    while(count<33){setup.add(`role_padding_${count}`,'town_center',110000+(count%2)*16000,20000+Math.floor((count-28)/2)*16000);count++;}
    const structures=Object.values(setup.payload.state.entities).filter((entity):entity is Building=>entity.kind==='building'),first=structures[31]!,second=structures[32]!,required=units.villager.trainSeconds*balance.rules.simulationHz;
    const job=(id:string,work=required-1):Building['queue'][number]=>({id,kind:'train',typeId:'villager',originalCost:{...units.villager.cost},work,required,reserved:true,started:true,state:'active'});
    first.queue=[job('role_word31')];second.queue=[job('role_word32'),job('role_later32',0)];second.demolitionTick=setup.payload.state.tick+2;
    const live=createLiveSimulation(setup.options,setup.payload),scalar=new Simulation(setup.options,setup.payload),trained=setup.payload.state.economies.a!.statistics.unitsTrained;await compare(live,scalar);
    expect(live.state.economies.a!.statistics.unitsTrained).toBe(trained+2);expect((live.state.entities[first.id] as Building).queue).toHaveLength(0);expect(live.state.entities[second.id]).toBeUndefined();
    const before=Simulation.phaseRosterDiagnostics().production;await compare(live,scalar);expect(Simulation.phaseRosterDiagnostics().production).toBe(before);
  });
  it.each(['before','after'] as const)('keeps prototype/custom readers on scalar phase scans when ownership is revoked %s warming',async when=>{
    const setup=setupRoles(),prototype=Simulation.prototype as unknown as {all():Entity[]},original=prototype.all;let reads=0;
    const hook=function(this:unknown){reads++;return original.call(this);};let live:ReturnType<typeof createLiveSimulation>,scalar:Simulation;
    try{
      if(when==='before')prototype.all=hook;
      live=createLiveSimulation(setup.options,setup.payload);scalar=new Simulation(setup.options,setup.payload);
      if(when==='after'){await compare(live,scalar);prototype.all=hook;}
      const before=Simulation.phaseRosterDiagnostics();await compare(live,scalar);expect(reads).toBeGreaterThan(0);expect(Simulation.phaseRosterDiagnostics()).toEqual(before);
    }finally{prototype.all=original;}
  });
});
