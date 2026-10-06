import { describe, expect, it } from 'vitest';
import { balance, buildings, units, type BuildingId, type GameplayCommand, type Position, type PublicPlayer, type UnitId } from '@frontier/shared';
import { createSimulation, createReplayRecording, exportSimulationSave, replayCheckpoint, ReplayRunner, restoreSimulation, restoreLiveSimulation, sealSimulationCapture, simulationChecksum, type Building, type EngineIdentity, type Entity, type Simulation, type TaskState, type Unit } from '../src/index.js';
import { Navigation, PathBudgetExceededError, type Obstacle } from '../src/navigation.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { ApproachReservations, UnitSpatialIndex } from '../src/movement.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { PathScheduler, type PathSchedulerState } from '../src/path-scheduler.js';

const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}];

interface ApproachInternals {
  approachDestination(unit:Unit,target:Entity,requireRoute?:boolean):Position|undefined;
  bounds(target:Entity):{halfWidth:number;halfHeight:number};
  planningNav(playerId:string):Navigation;
  refreshPlanningNav(playerId:string):Navigation;
  planningNavigations:Map<string,{revision:number}>;
  reservations(playerId:string):ApproachReservations;
  occupied(point:Position,radius:number,except:string,viewer:string):boolean;
  admissionNav(playerId:string):Navigation;
  task(unit:Unit,state:TaskState,reason?:string):void;
}
/** Previous eager routing is retained only to reproduce the exhausted admission
 * budget regression. Incremental work routes may intentionally choose another face. */
function eagerApproach(sim:Simulation,unit:Unit,target:Entity,requireRoute=false):Position|undefined {
  const internal=sim as unknown as ApproachInternals,bounds=internal.bounds(target),radius=units[unit.typeId].collisionRadiusM*1000,margin=radius+500,points:Position[]=[],nav=internal.planningNav(unit.ownerId);
  const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
  for(let x=-bounds.halfWidth;x<=bounds.halfWidth;x+=1000)points.push({xMm:target.xMm+x,zMm:target.zMm-bounds.halfHeight-margin},{xMm:target.xMm+x,zMm:target.zMm+bounds.halfHeight+margin});
  for(let z=-bounds.halfHeight;z<=bounds.halfHeight;z+=1000)points.push({xMm:target.xMm-bounds.halfWidth-margin,zMm:target.zMm+z},{xMm:target.xMm+bounds.halfWidth+margin,zMm:target.zMm+z});
  points.sort((a,b)=>distance(a,unit)-distance(b,unit));
  const key=target.kind==='unit'?`${target.id}_${Math.round(target.xMm/500)}_${Math.round(target.zMm/500)}`:target.id,reservations=internal.reservations(unit.ownerId);
  const legal=(point:Position)=>nav.free(point,radius)&&!internal.occupied(point,radius,unit.id,unit.ownerId)&&reservations.available(unit.id,point,radius);
  if(!requireRoute)return reservations.claim(unit.id,key,radius,points,legal);
  const revision=internal.planningNavigations.get(unit.ownerId)!.revision,prior=unit.approachGoal;
  if(prior?.key===key&&prior.revision===revision){
    if(prior.point&&legal(prior.point)&&unit.pathBlockedRevision===undefined)return reservations.claim(unit.id,key,radius,[prior.point],legal);
    if(!prior.point&&sim.state.tick<(prior.retryAtTick??0))return undefined;
  }
  reservations.release(unit.id);
  try{
    const path=internal.admissionNav(unit.ownerId).pathToAny(unit,points.filter(legal),radius),point=path?.at(-1);
    unit.approachGoal={key,revision,...(point?{point:{...point}}:{retryAtTick:sim.state.tick+balance.rules.simulationHz})};
    if(point&&unit.pathBlockedRevision!==undefined){delete unit.pathBlockedRevision;delete unit.pathBlockedNeighbors;unit.lastProgressTick=sim.state.tick;unit.repathAtTick=sim.state.tick;}
    return point?reservations.claim(unit.id,key,radius,[point],legal):undefined;
  }catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;unit.approachGoal={key,revision,retryAtTick:sim.state.tick+1};internal.task(unit,'blocked','PATH_BUSY');return undefined;}
}

function approachFixture():Simulation {
  const sim=createSimulation({factions,seed:'approach-equivalence',matchId:'approach-equivalence',controllers:false}),initial=Object.values(sim.state.entities);
  const template=initial.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!;
  const home=initial.find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center'&&entity.ownerId==='a')!,enemy=initial.find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center'&&entity.ownerId==='b')!;
  sim.state.entities={};sim.state.widthMm=100000;sim.state.heightMm=100000;sim.state.map.terrain=[];
  for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};}
  for(const [building,xMm,zMm]of [[home,30000,30000],[enemy,85000,85000]] as const){Object.assign(building,{xMm,zMm});sim.state.entities[building.id]=building;}
  for(const [id,xMm,zMm]of [['worker',20000,30000],['neighbor',20000,33000]] as const)sim.state.entities[id]={...structuredClone(template),id,ownerId:'a',xMm,zMm,orders:[],path:[],cargo:{resource:null,amount:0}};
  sim.state.entities.wood={id:'wood',kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:100000,xMm:22000,zMm:22000,hp:1,maxHp:1};
  sim.state.navigationRevision++;sim.step();
  // The direct helper calls below run outside the movement phase, so synchronize
  // its planning geometry with the vision refreshed by this fixture's first tick.
  for(const faction of factions)(sim as unknown as ApproachInternals).refreshPlanningNav(faction.id);
  return sim;
}

const identity:EngineIdentity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function send(sim:Simulation,command:GameplayCommand){const sequence=sim.state.economies.a!.lastClientSequence+1;return sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`work_${sequence}`,clientSequence:sequence,command});}
function longApproachFixture():Simulation {
  const sim=approachFixture(),worker=sim.state.entities.worker as Unit,observer=sim.state.entities.neighbor as Unit;
  sim.state.widthMm=320000;sim.state.heightMm=320000;
  // The endpoints reproduce the 208.865 m remembered-gold journey from the
  // ordinary Hard trace. This explicit public cliff supplies a bounded detour.
  Object.assign(worker,{xMm:231150,zMm:177000});Object.assign(observer,{xMm:30500,zMm:241000});
  Object.assign(sim.state.entities.wood!,{typeId:'gold_deposit',resource:'gold',xMm:30500,zMm:235000,amount:240000});
  sim.state.map.terrain=[{id:'detour',kind:'cliff',xMm:140000,zMm:170000,widthMm:2000,depthMm:120000,elevationMm:3000}];
  sim.state.navigationRevision++;sim.step();
  (sim as unknown as ApproachInternals).refreshPlanningNav('a');return sim;
}
function pendingBuildFixture(){
  const sim=longApproachFixture(),home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,definition=buildings.house;
  const foundation:Building={...structuredClone(home),id:'pending_house',typeId:'house',xMm:30500,zMm:235000,hp:1,maxHp:definition.maxHp,grantedHp:1,work:0,required:definition.buildSeconds*balance.rules.simulationHz*100,queue:[]};
  delete sim.state.entities.wood;sim.state.entities[foundation.id]=foundation;sim.state.navigationRevision++;
  for(const entity of Object.values(sim.state.entities))if(entity.kind==='unit'){entity.autoGather=false;entity.stance='stand_ground';}
  sim.configureAssistant('a',{modelId:'test',enabled:true,reserve:{food:0,wood:0,gold:0,stone:0}});sim.step();
  const command={kind:'continue_build' as const,builderIds:['worker'],foundationId:foundation.id,queued:false};
  expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'initial_build',clientSequence:1,command},'ai').status).toBe('accepted');sim.step();
  // Retain a small, real paid frontier at the first pending boundary. Ordinary
  // production credits solve this isolated fixture before the third tick.
  (sim as unknown as {pathScheduler:PathScheduler}).pathScheduler.advance(16,sim.state.tick);
  expect(sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId==='worker')?.stage).not.toBe('done');expect((sim.state.entities.worker as Unit).pathRequestId,JSON.stringify({worker:sim.state.entities.worker,task:sim.capture().runtime.pathScheduler.tasks})).toBeDefined();
  return {sim,command};
}

describe('AT-21 authoritative group navigation',()=>{
  it('retains paid pending construction searches across same-target retries, manual takeover, cold owners and replay',()=>{
    const {sim,command}=pendingBuildFixture(),save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const live=restoreLiveSimulation(save,identity,{preserveEpoch:true}),cold=restoreSimulation(save,identity,{preserveEpoch:true});sim.drainJournal();
    for(let retry=0;retry<4;retry++){
      const source=retry===3?'human' as const:'ai' as const,sequence=source==='human'?1:retry+2;
      const input={protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`retry_${retry}`,clientSequence:sequence,command};
      const before=sim.capture().runtime.pathScheduler,worker=sim.state.entities.worker as Unit,request=worker.pathRequestId,revision=worker.orderRevision;
      expect(request).toBeDefined();const receipt=sim.command('a',input,source);expect(receipt.status).toBe('accepted');expect(live.command('a',input,source)).toEqual(receipt);expect(cold.command('a',input,source)).toEqual(receipt);
      expect(sim.capture().runtime.pathScheduler).toEqual(before);expect(worker.pathRequestId).toBe(request);expect(worker.orderRevision).toBe(revision);
    }
    expect((sim.state.entities.worker as Unit).orders[0]!.manualOrder).toBe(true);expect(sim.assistantState('a').protectedEntityIds).toEqual(expect.arrayContaining(['worker',command.foundationId]));
    for(let tick=0;tick<12;tick++){sim.step();live.step();cold.step();expect(live.capture()).toEqual(sim.capture());expect(cold.capture()).toEqual(sim.capture());}
    const replay=new ReplayRunner(createReplayRecording(save,sim.drainJournal().events,[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(sim));
  });
  it('still replaces changed, blocked, wall and engaged construction orders and appends queued retries normally',()=>{
    const {sim:initial,command}=pendingBuildFixture(),save=exportSimulationSave(initial,identity);
    for(const mode of ['target','blocked','wall','engaged','tail','queued'] as const){
      const sim=restoreSimulation(save,identity,{preserveEpoch:true}),worker=sim.state.entities.worker as Unit,revision=worker.orderRevision!,request=worker.pathRequestId;
      const next={...command,builderIds:[...command.builderIds]};
      if(mode==='target'){const other={...structuredClone(sim.state.entities[command.foundationId] as Building),id:'other_foundation',xMm:40000};sim.state.entities[other.id]=other;next.foundationId=other.id;}
      if(mode==='blocked'){worker.taskState='blocked';worker.blockedReason='PATH_BLOCKED';}
      if(mode==='wall')worker.orders[0]!.wallTargets=[command.foundationId];
      if(mode==='engaged')worker.engagement={targetId:'neighbor',lastKnown:{xMm:30500,zMm:241000},anchor:{xMm:worker.xMm,zMm:worker.zMm}};
      if(mode==='tail')worker.orders.push({kind:'move',target:{xMm:10000,zMm:10000}});
      if(mode==='queued')next.queued=true;
      expect(send(sim,next).status).toBe('accepted');
      if(mode==='queued'){expect(worker.orders).toHaveLength(2);expect(worker.pathRequestId).toBe(request);expect(worker.orderRevision).toBe(revision);}
      else{expect(worker.orders).toHaveLength(1);expect(worker.pathRequestId).toBeUndefined();expect(worker.orderRevision).toBe(revision+1);expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);}
    }
  });
  it('accepts paid construction by all six observed tutorial workers, including the narrow berry worksite, and replays completion',()=>{
    const sim=approachFixture(),template=structuredClone(sim.state.entities.worker as Unit),homes=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building');
    sim.state.entities={};sim.state.widthMm=384000;sim.state.heightMm=384000;
    for(const home of homes){Object.assign(home,home.ownerId==='a'?{xMm:128000,zMm:190000}:{xMm:330000,zMm:330000});sim.state.entities[home.id]=home;}
    const houseDefinition=buildings.house,oldHouse:Building={...structuredClone(homes[0]!),id:'old_house',ownerId:'a',typeId:'house',xMm:116000,zMm:184000,hp:houseDefinition.maxHp,maxHp:houseDefinition.maxHp,grantedHp:houseDefinition.maxHp,work:1,required:1};sim.state.entities[oldHouse.id]=oldHouse;
    const positions=[[121132,196600],[119686,197327],[119900,199050],[122438,197068],[117808,200270],[118750,197600]] as const;
    const workers=positions.map(([xMm,zMm],index)=>{const worker:Unit={...structuredClone(template),id:`tutorial_worker_${index}`,xMm,zMm,orders:[],path:[],cargo:{resource:null,amount:0}};sim.state.entities[worker.id]=worker;return worker;});
    for(const zMm of [196500,198700])for(const xMm of [114000,116200,118400]){const id=`berry_${xMm}_${zMm}`;sim.state.entities[id]={id,kind:'resource',ownerId:null,typeId:'forage_patch',resource:'food',amount:200000,xMm,zMm,hp:1,maxHp:1};}
    for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};}sim.state.navigationRevision++;sim.step();sim.drainJournal();
    const own=sim.view('a');expect(own.entities.filter(entity=>entity.kind==='resource'&&!entity.ghost)).toHaveLength(6);
    const before=sim.state.economies.a!.resources.wood,receipt=send(sim,{kind:'build',builderIds:workers.map(worker=>worker.id),buildingType:'house',originCell:{x:58,z:94},rotation:0,queued:false});
    expect(receipt.status,JSON.stringify(receipt)).toBe('accepted');expect(sim.state.economies.a!.resources.wood).toBe(before-houseDefinition.cost.wood*1000);
    const created=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='house'&&entity.id!==oldHouse.id)!;
    sim.step();expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===workers[5]!.id&&task.stage!=='done')).toBe(true);
    const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});sim.drainJournal();
    const physical=new Navigation(sim.state.widthMm,sim.state.heightMm,Object.values(sim.state.entities).flatMap(entity=>entity.kind==='building'?fortificationObstacles(entity):entity.kind==='resource'?[{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth:650,halfHeight:650}]:[]));
    let reachedWorksite=false;
    for(let tick=0;tick<1600&&created.work<created.required;tick++){
      const prior=workers.map(worker=>({xMm:worker.xMm,zMm:worker.zMm}));sim.step();restored.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
      for(const [index,worker]of workers.entries())expect(physical.clearLine(prior[index]!,worker,350),`worker${index} tick${tick}`).toBe(true);
      reachedWorksite||=workers[5]!.taskState==='building';if(tick%20===0)expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));
    }
    expect(created.work).toBe(created.required);expect(reachedWorksite).toBe(true);expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));
    const replay=new ReplayRunner(createReplayRecording(save,sim.drainJournal().events,[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(sim));
  },30000);

  it('reserves work faces without admission searches and reselects after occupancy or target geometry changes',()=>{
    const sim=approachFixture(),internal=sim as unknown as ApproachInternals,worker=sim.state.entities.worker as Unit,neighbor=sim.state.entities.neighbor as Unit;
    const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.ownerId==='a'&&entity.typeId==='town_center')!,before=structuredClone(sim.state.pathAdmission);
    const first=internal.approachDestination(worker,home,true)!;expect(first).toBeDefined();expect(internal.approachDestination(worker,home,true)).toEqual(first);
    expect(sim.state.pathAdmission).toEqual(before);
    Object.assign(neighbor,first);const changed=internal.approachDestination(worker,home,true)!;expect(changed).not.toEqual(first);
    home.xMm+=10000;home.rotation=90;sim.state.navigationRevision++;internal.refreshPlanningNav('a');
    const moved=internal.approachDestination(worker,home,true)!;expect(moved).not.toEqual(changed);expect(moved.xMm).toBeGreaterThan(changed.xMm);
    expect(sim.state.pathAdmission).toEqual(before);
    expect(send(sim,{kind:'gather',unitIds:['worker'],targetId:'wood',queued:false}).status).toBe('accepted');
    sim.step(800);expect(sim.state.economies.a!.collected.wood).toBeGreaterThan(0);
  },30000);

  it('resumes a 209 metre work detour instead of spending 50000 admission checks each tick',()=>{
    const baseline=longApproachFixture(),sim=longApproachFixture(),worker=sim.state.entities.worker as Unit;
    expect(eagerApproach(baseline,baseline.state.entities.worker as Unit,baseline.state.entities.wood!,true)).toBeUndefined();
    expect(baseline.state.pathAdmission!.a!.used).toBe(50000);expect((baseline.state.entities.worker as Unit).blockedReason).toBe('PATH_BUSY');
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:'wood',queued:false}).status).toBe('accepted');
    const start={xMm:worker.xMm,zMm:worker.zMm},nav=(sim as unknown as ApproachInternals).planningNav('a'),radius=units[worker.typeId].collisionRadiusM*1000;let pendingTicks=0,sawSearchProgress=false;
    for(let tick=0;tick<2400&&!worker.cargo.amount;tick++){
      const prior={xMm:worker.xMm,zMm:worker.zMm};sim.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);expect(sim.state.pathAdmission!.a!.used).toBe(0);expect(nav.clearLine(prior,worker,radius)).toBe(true);
      if(tick<100){const task=sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id);if(task){pendingTicks++;expect(worker.taskState).toBe('moving');expect(worker.blockedReason).toBeUndefined();}else if(pendingTicks&&sim.pathDiagnostics().work>0&&worker.path.length)sawSearchProgress=true;}
    }
    // A bounded corner route can now complete at the second boundary; it must
    // still resume a previously pending request without eager admission work.
    expect(pendingTicks).toBeGreaterThan(0);expect(sawSearchProgress).toBe(true);expect(Math.hypot(worker.xMm-start.xMm,worker.zMm-start.zMm)).toBeGreaterThan(200000);expect(worker.cargo.resource).toBe('gold');expect(worker.cargo.amount).toBeGreaterThan(0);
  },30000);

  it('restores and replays a pending work search with exact continuation and bounded failed-face data',()=>{
    const sim=longApproachFixture(),worker=sim.state.entities.worker as Unit;sim.drainJournal();
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:'wood',queued:false}).status).toBe('accepted');sim.step();
    // Capture actual partial work before ordinary credits finish this route.
    (sim as unknown as {pathScheduler:PathScheduler}).pathScheduler.advance(16,sim.state.tick);
    expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id&&task.stage!=='done')).toBe(true);
    const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});sim.drainJournal();
    for(let tick=0;tick<40;tick++){sim.step();restored.step();expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));}
    const recording=createReplayRecording(save,sim.drainJournal().events,[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(sim));
    const payload=structuredClone(save.payload),savedWorker=payload.state.entities.worker as Unit;savedWorker.approachGoal!.failedPoints=[{xMm:1000,zMm:1000}];expect(validateSimulationSavePayload(payload)).toBe(true);
    savedWorker.approachGoal!.failedPoints.push({xMm:1000,zMm:1000});expect(validateSimulationSavePayload(payload)).toBe(false);
    savedWorker.approachGoal!.failedPoints=[{...savedWorker.approachGoal!.point!}];expect(validateSimulationSavePayload(payload)).toBe(false);
    savedWorker.approachGoal!.failedPoints=[{xMm:payload.state.widthMm+1,zMm:1000}];expect(validateSimulationSavePayload(payload)).toBe(false);
    savedWorker.approachGoal!.failedPoints=Array.from({length:100},(_,index)=>({xMm:index*1000,zMm:1000}));expect(validateSimulationSavePayload(payload)).toBe(false);
  },30000);

  it.each([false,true])('restores and replays unchecked and failed late-cache search boundaries (intersecting sets: %s)',intersecting=>{
    const fixture=approachFixture(),internal=fixture as unknown as ApproachInternals,home=Object.values(fixture.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    Object.assign(home,{xMm:70000,zMm:80000});Object.assign(fixture.state.entities.wood!,{xMm:85000,zMm:10000});
    Object.assign(fixture.state.entities.worker!,{xMm:8000,zMm:intersecting?14500:24000});Object.assign(fixture.state.entities.neighbor!,{xMm:10000,zMm:intersecting?15500:24000});
    fixture.state.map.terrain=[{id:'detour',kind:'cliff',xMm:31000,zMm:6000,widthMm:2000,depthMm:36000,elevationMm:3000},{id:'post',kind:'cliff',xMm:8650,zMm:intersecting?13500:22500,widthMm:700,depthMm:3000,elevationMm:3000}];fixture.state.navigationRevision++;fixture.step();for(const faction of factions)internal.refreshPlanningNav(faction.id);
    const scheduler=new PathScheduler(profile=>internal.planningNav(profile),['a','b']);
    for(const [id,target]of [['worker',{xMm:56000,zMm:24000}],['neighbor',{xMm:56500,zMm:24500}]] as const){
      const unit=fixture.state.entities[id] as Unit;unit.orders=[{kind:'move',target}];unit.orderRevision=1;unit.taskState='moving';unit.pathRequestId=`pending_${id}`;unit.pathDestination={...target};unit.lastProgressTick=fixture.state.tick;
      scheduler.request({id:unit.pathRequestId,unitId:id,profile:'a',orderRevision:1,from:{xMm:unit.xMm,zMm:unit.zMm},target,radiusMm:units.villager.collisionRadiusM*1000});
    }
    const live=scheduler as unknown as {tasks:Map<string,PathSchedulerState['tasks'][number]>};
    const snapshots:PathSchedulerState[]=[];
    for(let work=0;work<128000;work+=32){scheduler.advance(32);if([...live.tasks.values()].every(task=>task.stage==='fine')){snapshots.push(scheduler.exportState());break;}}
    expect(snapshots).toHaveLength(1);expect(snapshots[0]!.routes).toEqual([]);
    for(let work=0;work<128000;work++){scheduler.advance(1);if([...live.tasks.values()].some(task=>task.stage==='fine'&&task.lateCacheChecked)){snapshots.push(scheduler.exportState());break;}}
    expect(snapshots).toHaveLength(2);
    if(intersecting){const waiting=snapshots[1]!.tasks.find(task=>task.lateCacheChecked)!;expect(waiting.cacheKey).not.toBe(snapshots[1]!.routes[0]![0]);}
    // Offline initial checkpoints use actual bounded scheduler work and the same
    // authorized geometry. Every continuation below runs ordinary simulation ticks.
    for(const state of snapshots){
      const payload=fixture.capture();payload.runtime.pathScheduler=state;expect(validateSimulationSavePayload(payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
      const save=sealSimulationCapture(payload,identity),a=restoreSimulation(save,identity,{preserveEpoch:true}),b=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});
      for(let tick=0;tick<25;tick++){
        const before=Object.fromEntries(['worker','neighbor'].map(id=>{const unit=a.state.entities[id]!;return [id,{xMm:unit.xMm,zMm:unit.zMm}];}));a.step();b.step();expect(simulationChecksum(b)).toBe(simulationChecksum(a));
        for(const id of ['worker','neighbor'])expect(internal.planningNav('a').clearLine(before[id]!,a.state.entities[id]!,units.villager.collisionRadiusM*1000)).toBe(true);
      }
      const replay=new ReplayRunner(createReplayRecording(save,a.drainJournal().events,[replayCheckpoint(a)],a.state.tick,a.state.eventOrdinal),identity);expect(replay.advanceTo(a.state.tick).done).toBe(true);expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(a));
    }
    const invalid=fixture.capture();invalid.runtime.pathScheduler=structuredClone(snapshots[1]!);const checked=invalid.runtime.pathScheduler.tasks.find(task=>task.lateCacheChecked)!;
    (checked as {lateCacheChecked:unknown}).lateCacheChecked=false;expect(validateSimulationSavePayload(invalid)).toBe(false);checked.lateCacheChecked=true;delete checked.cacheKey;expect(validateSimulationSavePayload(invalid)).toBe(false);
    if(intersecting){const oversized=fixture.capture();oversized.runtime.pathScheduler=structuredClone(snapshots[1]!);const [key,route]=oversized.runtime.pathScheduler.routes[0]!;oversized.runtime.pathScheduler.routes=Array.from({length:513},(_,index)=>{const radiusMm=1000+index;return [`${route.profile}:${radiusMm}:${key.slice(`${route.profile}:${route.radiusMm}:`.length)}`,{...structuredClone(route),radiusMm}];});expect(validateSimulationSavePayload(oversized)).toBe(false);oversized.runtime.pathScheduler.routes.pop();expect(validateSimulationSavePayload(oversized),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);}
  },30000);

  it('replaces an occupied pending endpoint before installing the old result',()=>{
    const sim=longApproachFixture(),worker=sim.state.entities.worker as Unit,neighbor=sim.state.entities.neighbor as Unit;
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:'wood',queued:false}).status).toBe('accepted');sim.step();
    (sim as unknown as {pathScheduler:PathScheduler}).pathScheduler.advance(16,sim.state.tick);
    const prior=sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)!;expect(prior.stage).not.toBe('done');
    Object.assign(neighbor,prior.target);sim.step();
    const replacement=sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)!;
    expect(replacement.id).not.toBe(prior.id);expect(replacement.target).not.toEqual(prior.target);expect(worker.path).toEqual([]);expect(worker.approachGoal!.point).toEqual(replacement.target);expect(worker.approachGoal!.failedPoints).toBeUndefined();
    // Occupancy is temporary, and does not become a permanent failed-face entry.
    expect(sim.state.pathAdmission!.a!.used).toBe(0);expect(worker.taskState).toBe('moving');
  });

  it('keeps pending own work routes and views identical when only hidden enemy geometry differs',()=>{
    const a=longApproachFixture(),b=longApproachFixture(),pair=[a,b];
    const template=Object.values(b.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='b')!;
    b.state.entities.hidden_wall={...structuredClone(template),id:'hidden_wall',typeId:'palisade_wall',xMm:185000,zMm:190000};b.state.navigationRevision++;
    for(const sim of pair)expect(send(sim,{kind:'gather',unitIds:['worker'],targetId:'wood',queued:false}).status).toBe('accepted');
    for(let tick=0;tick<60;tick++){
      a.step();b.step();expect(b.view('a')).toEqual(a.view('a'));
      const own=(sim:Simulation)=>sim.capture().runtime.pathScheduler.tasks.filter(task=>task.profile==='a');expect(own(b)).toEqual(own(a));expect(b.state.entities.worker).toEqual(a.state.entities.worker);
    }
    expect(b.view('a').entities.some(entity=>entity.id==='hidden_wall')).toBe(false);
  },30000);

  it('tries another face after a completed unreachable search and restores that exclusion while repairing',()=>{
    const sim=approachFixture(),internal=sim as unknown as ApproachInternals,worker=sim.state.entities.worker as Unit;
    const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.ownerId==='a'&&entity.typeId==='town_center')!,box=internal.bounds(home),left=home.xMm-box.halfWidth;
    home.hp-=100;
    // A U-shaped cliff and the building enclose the nearest west face. The
    // building's north/east/south approaches remain physically reachable.
    sim.state.map.terrain=[
      {id:'pocket_west',kind:'cliff',xMm:left-2500,zMm:home.zMm-box.halfHeight-2000,widthMm:500,depthMm:box.halfHeight*2+4000,elevationMm:3000},
      {id:'pocket_north',kind:'cliff',xMm:left-2500,zMm:home.zMm-box.halfHeight-500,widthMm:3500,depthMm:1000,elevationMm:3000},
      {id:'pocket_south',kind:'cliff',xMm:left-2500,zMm:home.zMm+box.halfHeight-500,widthMm:3500,depthMm:1000,elevationMm:3000},
    ];sim.state.navigationRevision++;sim.step();
    expect(send(sim,{kind:'repair',unitIds:[worker.id],targetId:home.id,queued:false}).status).toBe('accepted');
    let failed:Position|undefined,restored:Simulation|undefined,continued=0;const initialHp=home.hp;
    for(let tick=0;tick<2400&&home.hp===initialHp;tick++){
      const prior={xMm:worker.xMm,zMm:worker.zMm};sim.step();
      expect(internal.planningNav('a').clearLine(prior,worker,units.villager.collisionRadiusM*1000)).toBe(true);
      if(restored&&continued++<30){restored.step();expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));}else restored=undefined;
      if(!failed&&worker.approachGoal?.failedPoints?.length){
        failed={...worker.approachGoal.failedPoints[0]!};expect(worker.taskState).toBe('moving');
        const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);restored=restoreSimulation(save,identity,{preserveEpoch:true});
      }
    }
    expect(failed).toBeDefined();expect(home.hp,JSON.stringify({unit:{x:worker.xMm,z:worker.zMm,goal:worker.approachGoal,reason:worker.blockedReason},tasks:sim.capture().runtime.pathScheduler.tasks.map(task=>({stage:task.stage,from:task.from,target:task.target}))})).toBeGreaterThan(initialHp);expect(worker.approachGoal?.point).not.toEqual(failed);
  },30000);

  it('keeps a return trip pinned and cycles past an unreachable nearer dropoff without dropping its cargo',()=>{
    const sim=approachFixture(),worker=sim.state.entities.worker as Unit,home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.ownerId==='a'&&entity.typeId==='town_center')!;
    home.xMm=50000;const definition=buildings.lumber_camp;
    const depot:Building={...structuredClone(home),id:'far_depot',typeId:'lumber_camp',xMm:10000,zMm:70000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:definition.buildSeconds*2000,required:definition.buildSeconds*2000};sim.state.entities[depot.id]=depot;
    sim.state.map.terrain=[{id:'divide',kind:'cliff',xMm:35000,zMm:0,widthMm:1000,depthMm:100000,elevationMm:3000}];sim.state.navigationRevision++;sim.step();
    const cargo=(units.villager.carryCapacity??balance.rules.carryCapacity)*1000;worker.cargo={resource:'wood',amount:cargo};expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:'wood',queued:false}).status).toBe('accepted');
    let pinned=false,pending=0;
    for(let tick=0;tick<1800&&sim.state.economies.a!.collected.wood===0;tick++){
      sim.step();if(worker.orders[0]?.dropOffId===depot.id)pinned=true;
      if(pinned&&worker.cargo.amount){expect(worker.orders[0]?.dropOffId).toBe(depot.id);expect(worker.taskState).toBe('returning');pending++;}
      expect(sim.state.pathAdmission!.a!.used).toBe(0);expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
    }
    expect(pinned).toBe(true);expect(pending).toBeGreaterThan(5);expect(sim.state.economies.a!.collected.wood).toBe(cargo);expect(worker.cargo.amount).toBe(0);
  },30000);

  it('routes a 166-population mixed army through an AUTO gate and around actual resource nodes',()=>{
    const sim=createSimulation({factions,seed:'m3-hundred-unit-gate',matchId:'group-navigation',populationLimit:200,controllers:false});
    const initial=Object.values(sim.state.entities),buildingTemplate=initial.find((entity):entity is Building=>entity.kind==='building')!,unitTemplate=initial.find((entity):entity is Unit=>entity.kind==='unit')!;
    // Explicit navigation capacity fixture: entities are placed directly, then all
    // movement and gate decisions use ordinary commands and simulation ticks.
    // This does not claim the army was economically produced from a standard start.
    sim.state.entities={};sim.state.widthMm=100000;sim.state.heightMm=100000;sim.state.map.terrain=[];
    sim.state.economies.a!.age=3;
    for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};}
    function addBuilding(id:string,typeId:BuildingId,xMm:number,zMm:number,ownerId='a'):Building{
      const definition=buildings[typeId],building:Building={...structuredClone(buildingTemplate),id,typeId,xMm,zMm,ownerId,hp:definition.maxHp,maxHp:definition.maxHp,work:1,required:1,grantedHp:definition.maxHp,queue:[],rotation:0};sim.state.entities[id]=building;return building;
    }
    addBuilding('home','town_center',15000,93000);addBuilding('opponent_home','town_center',85000,93000,'b');
    for(let i=0;i<38;i++)addBuilding(`house_${i}`,'house',50000+i%8*6000,58000+Math.floor(i/8)*6000);
    for(let i=0;i<50;i++)if(i<18||i>20)addBuilding(`wall_${i}`,'palisade_wall',40000,1000+i*2000);
    const gate=addBuilding('gate','wooden_gate',40000,39000);gate.rotation=90;gate.gateMode='AUTO';gate.gateOpen=false;
    const resources:Obstacle[]=[];
    for(let z=0;z<4;z++)for(let x=0;x<3;x++){const node={id:`wood_${x}_${z}`,typeId:'tree_oak',kind:'resource' as const,ownerId:null,resource:'wood' as const,xMm:52000+x*2000,zMm:36000+z*2000,hp:1,maxHp:1,amount:100000};sim.state.entities[node.id]=node;resources.push({id:node.id,xMm:node.xMm,zMm:node.zMm,halfWidth:450,halfHeight:450});}
    const army=Array.from({length:100},(_,i)=>{
      const typeId:UnitId=(['militia','scout','battering_ram'] as const)[i%3]!,definition=units[typeId],unit:Unit={...structuredClone(unitTemplate),id:`army_${String(i).padStart(3,'0')}`,typeId,ownerId:'a',xMm:10000+i%10*2000,zMm:29000+Math.floor(i/10)*2000,hp:definition.maxHp,maxHp:definition.maxHp,orders:[],path:[],stance:'stand_ground',cargo:{resource:null,amount:0}};sim.state.entities[unit.id]=unit;return unit;
    });
    const population=army.reduce((sum,unit)=>sum+units[unit.typeId].population,0);expect(population).toBe(166);expect(population).toBeLessThanOrEqual(200);
    sim.state.navigationRevision++;sim.step();expect(gate.gateOpen).toBe(false);
    const command:GameplayCommand={kind:'move',unitIds:army.map(unit=>unit.id),target:{xMm:70000,zMm:39000},queued:false};
    expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'march',clientSequence:1,command}).status).toBe('accepted');
    expect(sim.view('a').entities.some(entity=>entity.id.startsWith('wood_'))).toBe(false);
    const destinations=new Map(army.map(unit=>[unit.id,{...unit.orders[0]!.target!}])),initialDestinations=structuredClone(destinations),reassigned=new Set<string>();let sawOpen=false,ticks=0;
    for(;ticks<6000&&army.some(unit=>unit.orders.length);ticks++){
      const prior=new Map(army.map(unit=>[unit.id,{xMm:unit.xMm,zMm:unit.zMm}]));sim.step();sawOpen||=Boolean(gate.gateOpen);
      for(const unit of army){const current=unit.orders[0]?.target,previous=destinations.get(unit.id)!;if(current&&(current.xMm!==previous.xMm||current.zMm!==previous.zMm)){
        const known=new Set(sim.view('a').entities.filter(entity=>entity.kind==='resource'&&!entity.ghost).map(entity=>entity.id)),radius=units[unit.typeId].collisionRadiusM*1000;
        expect(resources.some(obstacle=>known.has(obstacle.id)&&Math.hypot(Math.max(0,Math.abs(previous.xMm-obstacle.xMm)-obstacle.halfWidth),Math.max(0,Math.abs(previous.zMm-obstacle.zMm)-obstacle.halfHeight))<radius),'A formation slot changed before its obstruction was observed').toBe(true);
        expect(unit.orders[0]!.formation?.center).toEqual(command.target);const original=initialDestinations.get(unit.id)!;expect(Math.hypot(current.xMm-original.xMm,current.zMm-original.zMm)).toBeLessThanOrEqual(16000);destinations.set(unit.id,{...current});reassigned.add(unit.id);
      }}
      const structures=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building').flatMap(building=>fortificationObstacles(building)),physical=new Navigation(sim.state.widthMm,sim.state.heightMm,[...structures,...resources]),index=new UnitSpatialIndex();
      for(const unit of army){const radiusMm=units[unit.typeId].collisionRadiusM*1000;expect(physical.clearLine(prior.get(unit.id)!,unit,radiusMm),`Static collision at ${unit.id} tick ${ticks}`).toBe(true);expect(index.free(unit,radiusMm),`Unit collision at ${unit.id} tick ${ticks}`).toBe(true);index.set({id:unit.id,xMm:unit.xMm,zMm:unit.zMm,radiusMm});}
    }
    expect(sawOpen).toBe(true);
    expect(reassigned.has('army_050')).toBe(true);expect(reassigned.has('army_060')).toBe(false);
    expect(army.filter(unit=>unit.orders.length===0).length,JSON.stringify({ticks,stuck:army.filter(unit=>unit.orders.length).slice(0,8).map(unit=>({id:unit.id,x:unit.xMm,z:unit.zMm,path:unit.path.slice(0,2),orders:unit.orders,reason:unit.blockedReason,revision:unit.pathBlockedRevision,neighbors:unit.pathBlockedNeighbors}))})).toBe(100);
    for(const unit of army){const target=destinations.get(unit.id)!;expect(unit.xMm).toBeGreaterThan(42000);expect(Math.hypot(unit.xMm-target.xMm,unit.zMm-target.zMm)).toBeLessThanOrEqual(100);}
    expect(sim.state.economies.a!.statistics.unitsLost).toBe(0);expect(sim.state.status).toBe('RUNNING');
    console.info(JSON.stringify({scenario:'AT-21',seed:'m3-hundred-unit-gate',units:army.length,population,ticks,reassigned:[...reassigned]}));
  },180000);
});
