import { describe, expect, it } from 'vitest';
import { balance, buildings, terrainObstacles, units, type BuildingId, type GameplayCommand, type PublicPlayer, type UnitId } from '@frontier/shared';
import { createSimulation, createReplayRecording, exportSimulationSave, replayCheckpoint, ReplayRunner, restoreSimulation, simulationChecksum, type Building, type Unit } from '../src/index.js';
import { Navigation } from '../src/navigation.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { fortifyCommands, type FortifyMemory } from '../src/fortify-planner.js';
import { fortifyViewObstacle } from '../src/fortify-geometry.js';

const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}];
function fixture(extraFaction?:PublicPlayer){
  const sim=createSimulation({factions:extraFaction?[...factions,extraFaction]:factions,seed:'m3-fortification-physical',matchId:'fortification',controllers:false});
  const initial=Object.values(sim.state.entities),buildingTemplate=initial.find((e):e is Building=>e.kind==='building')!,unitTemplate=initial.find((e):e is Unit=>e.kind==='unit')!;
  // Explicit bounded physical scenario, with real admission, spending, work and movement.
  sim.state.entities={};sim.state.widthMm=100000;sim.state.heightMm=100000;sim.state.map.terrain=[];
  function addBuilding(id:string,typeId:BuildingId,xMm:number,zMm:number,ownerId='a'){
    const def=buildings[typeId],building:Building={...structuredClone(buildingTemplate),id,typeId,xMm,zMm,ownerId,hp:def.maxHp,maxHp:def.maxHp,work:1,required:1,grantedHp:def.maxHp,queue:[],rotation:0};sim.state.entities[id]=building;sim.state.navigationRevision++;return building;
  }
  function addUnit(id:string,typeId:UnitId,xMm:number,zMm:number,ownerId='a'){
    const def=units[typeId],unit:Unit={...structuredClone(unitTemplate),id,typeId,xMm,zMm,ownerId,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],stance:'stand_ground',cargo:{resource:null,amount:0}};sim.state.entities[id]=unit;return unit;
  }
  addBuilding('home','town_center',50000,50000);addBuilding('enemy_home','town_center',80000,85000,'b');
  if(extraFaction)addBuilding('third_home','town_center',85000,15000,extraFaction.id);
  const worker=addUnit('worker','villager',42000,42000);let sequence=0;
  const issue=(command:GameplayCommand,owner='a',commandId?:string)=>sim.command(owner,{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:commandId??`command_${++sequence}`,clientSequence:sequence,command});
  sim.step();return {sim,worker,addBuilding,addUnit,issue};
}
function until(sim:ReturnType<typeof createSimulation>,condition:()=>boolean,limit=3000){for(let tick=0;tick<limit&&!condition()&&sim.state.status==='RUNNING';tick++)sim.step();expect(condition()).toBe(true);}
const identity={engineBuildHash:'4'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function paidWallDetour(){
  const scenario=fixture(),{sim,worker,addBuilding,addUnit,issue}=scenario;
  Object.assign(sim.state.entities.home!,{xMm:20000,zMm:20000});Object.assign(worker,{xMm:57000,zMm:43000});
  sim.state.map.terrain=[
    {id:'upper_barrier',kind:'cliff',xMm:49000,zMm:0,widthMm:2000,depthMm:40000,elevationMm:3000},
    {id:'lower_barrier',kind:'cliff',xMm:49000,zMm:46000,widthMm:2000,depthMm:34000,elevationMm:3000},
  ];
  const gate=addBuilding('detour_gate','wooden_gate',50000,43000);gate.rotation=90;gate.gateMode='OPEN';gate.gateOpen=true;
  addUnit('wall_observer','scout',43000,43000);sim.state.navigationRevision++;sim.step();
  const bank=sim.state.economies.a!.resources.wood;
  expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:22,z:21}],queued:false}).status).toBe('accepted');
  const wall=sim.state.entities[worker.orders[0]!.targetId!] as Building;
  expect(sim.state.economies.a!.resources.wood).toBe(bank-buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
  // Reproduce the old runtime target-selection boundary after a segment
  // finished. The paid order and foundation remain authoritative; save checks
  // below happen only after an ordinary tick repairs this historic boundary.
  delete worker.orders[0]!.targetId;
  expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}).status).toBe('accepted');
  sim.drainJournal();return {...scenario,gate,wall};
}
function boundedWallStep(sim:ReturnType<typeof createSimulation>){
  sim.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
  const budget=sim.state.pathAdmission?.a;expect(budget?.tick===sim.state.tick?budget.used:0).toBe(0);
}

describe('M3 actual wall and gate command path',()=>{
  it('builds a defensive screen through ordinary commands and preserves its wide bypasses across save and replay',()=>{
    const {sim,addBuilding,addUnit,issue}=fixture();addBuilding('north_expansion','town_center',50000,30000);
    for(let z=20000;z<=80000;z+=12000)for(let x=20000;x<=80000;x+=12000)addUnit(`observer_${x}_${z}`,'scout',x,z);
    sim.step();const memory:FortifyMemory={},goal={kind:'fortify' as const,anchorRef:'home',material:'palisade' as const,radiusM:18};sim.state.controllers.a!.fortifications.fallback=memory;
    const result=fortifyCommands(sim.view('a'),goal,memory);expect(result.status,result.reason).toBe('building');expect(memory.screen).toBeDefined();const screen=structuredClone(memory.screen!),command=result.commands[0]!;
    expect(command.kind).toBe('build_wall');if(command.kind!=='build_wall')throw new Error('EXPECTED_SCREEN_WALLS');expect(command.cells).toHaveLength(6);
    const bank=sim.state.economies.a!.resources.wood,receipt=issue(command);expect(receipt.status,receipt.code).toBe('accepted');expect(sim.state.economies.a!.resources.wood).toBe(bank-6*buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    sim.step(20);fortifyCommands(sim.view('a'),goal,memory);expect(memory.layoutCommitted).toBe(true);
    const saved=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(saved.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const restored=restoreSimulation(JSON.parse(JSON.stringify(saved)),identity,{preserveEpoch:true});sim.drainJournal();
    const finished=()=>Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall').every(wall=>wall.work===wall.required);
    for(let tick=0;tick<1600&&!finished();tick++){sim.step();restored.step();}
    expect(finished()).toBe(true);expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));expect(restored.state.controllers.a!.fortifications.fallback?.screen).toEqual(screen);
    const replay=new ReplayRunner(createReplayRecording(saved,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(sim));
    const horizontal=screen.cells[0]!.z===screen.cells[1]!.z,minX=Math.min(...screen.cells.map(cell=>cell.x))*2000,minZ=Math.min(...screen.cells.map(cell=>cell.z))*2000,nav=new Navigation(sim.state.widthMm,sim.state.heightMm,sim.view('a').entities.filter(entity=>entity.kind==='building').map(fortifyViewObstacle));
    for(const along of [-6000,18000]){const center={xMm:minX+(horizontal?along:1000),zMm:minZ+(horizontal?1000:along)};expect(nav.clearLine({xMm:center.xMm-(horizontal?0:7000),zMm:center.zMm-(horizontal?7000:0)},{xMm:center.xMm+(horizontal?0:7000),zMm:center.zMm+(horizontal?7000:0)},6000)).toBe(true);}
  },30000);
  it('reevaluates an AUTO gate after team changes and faction replacement between steps',()=>{
    const {sim,addBuilding,addUnit}=fixture({id:'c',name:'C',teamId:'c',color:'#44aa66',kind:'human'});
    const gate=addBuilding('boundary_gate','wooden_gate',50000,70000);gate.gateMode='AUTO';gate.gateOpen=false;
    const visitor=addUnit('visitor','villager',50000,75000,'b');visitor.autoGather=false;
    sim.step();expect(gate.gateOpen).toBe(false);
    const index=sim.state.factions.findIndex(faction=>faction.id==='b');sim.state.factions[index]!.teamId='a';
    sim.step();expect(sim.state.status).toBe('RUNNING');expect(gate.gateOpen).toBe(true);
    sim.state.factions[index]={...sim.state.factions[index]!,teamId:'b'};
    const delay=Math.ceil(buildings.wooden_gate.autoCloseDelaySeconds!*balance.rules.simulationHz);
    sim.step(delay-1);expect(gate.gateOpen).toBe(true);
    sim.step();expect(sim.state.status).toBe('RUNNING');expect(gate.gateOpen).toBe(false);
    expect({xMm:visitor.xMm,zMm:visitor.zMm}).toEqual({xMm:50000,zMm:75000});
  });
  it('retains a pending wall face across a gate detour without runtime admission searches, cold restore or replay drift',()=>{
    const {sim,worker,wall}=paidWallDetour();
    boundedWallStep(sim);const first=structuredClone(worker.approachGoal?.point),request=worker.pathRequestId;
    expect(first).toBeDefined();expect(request).toBeDefined();
    const firstTask=sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)!;expect(firstTask.stage).not.toBe('done');
    let pendingTicks=0,progressed=false;
    for(let tick=0;tick<20;tick++){
      boundedWallStep(sim);const task=sim.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id);
      if(task&&task.stage!=='done'){pendingTicks++;expect(worker.pathRequestId).toBe(request);expect(worker.approachGoal?.point).toEqual(first);progressed||=JSON.stringify(task)!==JSON.stringify(firstTask);}
      if(pendingTicks>=3&&progressed)break;
    }
    expect(pendingTicks).toBeGreaterThan(1);expect(progressed).toBe(true);expect(worker.blockedReason).toBeUndefined();
    const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});sim.drainJournal();
    const physical=new Navigation(sim.state.widthMm,sim.state.heightMm,[...terrainObstacles(sim.state.map.terrain),...Object.values(sim.state.entities).flatMap(entity=>entity.kind==='building'?fortificationObstacles(entity):[])]);
    let traversedDetour=false;
    for(let tick=0;tick<1800&&wall.work<wall.required;tick++){
      const prior={xMm:worker.xMm,zMm:worker.zMm};boundedWallStep(sim);restored.step();traversedDetour||=worker.zMm>80000;
      expect(physical.clearLine(prior,worker,units.villager.collisionRadiusM*1000)).toBe(true);
      if(tick%25===0)expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));
    }
    expect(traversedDetour).toBe(true);expect(wall.work).toBe(wall.required);expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));
    const replay=new ReplayRunner(createReplayRecording(save,sim.drainJournal().events,[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);
    expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(simulationChecksum(replay.simulation)).toBe(simulationChecksum(sim));
  },30000);
  it('keeps queued movement behind paid wall work, replans when its gate opens, and Stop cancels the pending search',()=>{
    const {sim,worker,gate,wall,issue}=paidWallDetour();boundedWallStep(sim);
    expect(worker.pathRequestId).toBeDefined();
    expect(issue({kind:'move',unitIds:[worker.id],target:{xMm:57000,zMm:47000},queued:true}).status).toBe('accepted');
    expect(worker.orders.map(order=>order.kind)).toEqual(['build','move']);
    boundedWallStep(sim);expect(worker.orders[0]?.kind).toBe('build');
    expect(issue({kind:'stop',unitIds:[worker.id]}).status).toBe('accepted');
    expect(worker.orders).toEqual([]);expect(worker.pathRequestId).toBeUndefined();expect(worker.approachGoal).toBeUndefined();
    expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);
    const stopped={xMm:worker.xMm,zMm:worker.zMm};for(let tick=0;tick<10;tick++)boundedWallStep(sim);expect({xMm:worker.xMm,zMm:worker.zMm}).toEqual(stopped);expect(wall.work).toBe(0);
    expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'OPEN'}).status).toBe('accepted');boundedWallStep(sim);
    const bank=sim.state.economies.a!.resources.wood;
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:22,z:21}],queued:false}).status).toBe('accepted');
    expect(sim.state.economies.a!.resources.wood).toBe(bank);
    expect(issue({kind:'move',unitIds:[worker.id],target:{xMm:57000,zMm:47000},queued:true}).status).toBe('accepted');
    for(let tick=0;tick<600&&worker.orders.length;tick++){boundedWallStep(sim);if(wall.work<wall.required)expect(worker.orders[0]?.kind).toBe('build');}
    expect(wall.work).toBe(wall.required);expect(worker.orders).toEqual([]);expect(Math.hypot(worker.xMm-57000,worker.zMm-47000)).toBeLessThanOrEqual(100);
  },30000);
  it('continues to a reachable later wall after the nearest site is sealed, then retries it after a gate opens',()=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();Object.assign(sim.state.entities.home!,{xMm:20000,zMm:20000});Object.assign(worker,{xMm:38000,zMm:43000});
    for(const zMm of [39000,47000])for(const xMm of [43000,45000,47000,49000])addBuilding(`ring_${xMm}_${zMm}`,'palisade_wall',xMm,zMm);
    addBuilding('east_45000','palisade_wall',49000,45000);
    const gate=addBuilding('sealed_gate','wooden_gate',43000,43000);gate.rotation=90;gate.gateMode='OPEN';gate.gateOpen=true;
    addUnit('outside_observer','scout',56000,43000);const closer=addUnit('closer','villager',56000,39000);sim.step();
    const receipt=issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:23,z:21},{x:24,z:21},{x:25,z:21}],queued:false});expect(receipt.status,JSON.stringify(receipt)).toBe('accepted');
    const paid=worker.orders[0]!.wallTargets!.map(id=>sim.state.entities[id] as Building),nearest=paid.find(wall=>wall.xMm===47000)!,outside=paid.filter(wall=>wall.xMm===51000);
    // The batch is reachable when admitted. A second paid command closes the
    // remaining ring gap while locking the gate seals its nearest target.
    const close=issue({kind:'build_wall',builderIds:[closer.id],material:'palisade',cells:[{x:24,z:20}],queued:false});expect(close.status,JSON.stringify(close)).toBe('accepted');
    expect(worker.orders[0]!.targetId).toBe(nearest.id);expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}).status).toBe('accepted');
    let failedFaceSaved=false,rotationSaved=false,continuation:ReturnType<typeof createSimulation>|undefined,remainingChecks=0;
    for(let tick=0;tick<2200&&!outside.every(wall=>wall.work===wall.required);tick++){
      boundedWallStep(sim);expect(nearest.work).toBe(0);
      if(continuation){continuation.step();expect(simulationChecksum(continuation)).toBe(simulationChecksum(sim));if(--remainingChecks===0)continuation=undefined;}
      const failed=!failedFaceSaved&&worker.orders[0]?.targetId===nearest.id&&Boolean(worker.approachGoal?.failedPoints?.length);
      const rotated=!rotationSaved&&worker.orders[0]?.targetId!==nearest.id;
      if(!continuation&&(failed||rotated)){
        const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
        continuation=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});remainingChecks=8;
        if(failed)failedFaceSaved=true;if(rotated)rotationSaved=true;
      }
    }
    expect(failedFaceSaved).toBe(true);expect(rotationSaved).toBe(true);
    expect(outside.every(wall=>wall.work===wall.required),JSON.stringify({worker,paid:paid.map(wall=>({id:wall.id,work:wall.work,required:wall.required}))})).toBe(true);
    expect(worker.orders[0]?.wallTargets).toContain(nearest.id);
    expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'OPEN'}).status).toBe('accepted');
    for(let tick=0;tick<1000&&nearest.work<nearest.required;tick++)boundedWallStep(sim);
    expect(nearest.work).toBe(nearest.required);
  },30000);
  it('saves and restores the exact tick a paid batch segment completes before the next target is selected',()=>{
    const {sim,worker,issue}=fixture();
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:20},{x:25,z:20},{x:26,z:20}],queued:false}).status).toBe('accepted');
    const first=sim.state.entities[worker.orders[0]!.targetId!] as Building;
    for(let tick=0;tick<600&&first.work<first.required;tick++)boundedWallStep(sim);
    expect(first.work).toBe(first.required);expect(worker.orders[0]?.kind).toBe('build');
    const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});
    for(let tick=0;tick<20;tick++){boundedWallStep(sim);restored.step();expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));}
    expect(worker.orders[0]?.targetId).not.toBe(first.id);
  });
  it('waits while all wall work faces are occupied and completes the same paid order when the workers move away',()=>{
    const {sim,worker,addUnit,issue}=fixture();
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:20}],queued:false}).status).toBe('accepted');
    const wall=sim.state.entities[worker.orders[0]!.targetId!] as Building,positions:{xMm:number;zMm:number}[]=[];
    for(const offset of [-1000,0,1000])positions.push({xMm:wall.xMm+offset,zMm:wall.zMm-1850},{xMm:wall.xMm+offset,zMm:wall.zMm+1850},{xMm:wall.xMm-1850,zMm:wall.zMm+offset},{xMm:wall.xMm+1850,zMm:wall.zMm+offset});
    const blockers=positions.map((point,index)=>addUnit(`face_${index}`,'villager',point.xMm,point.zMm)),bank=sim.state.economies.a!.resources.wood;
    for(let tick=0;tick<25;tick++)boundedWallStep(sim);
    expect(wall.work).toBe(0);expect(worker.orders[0]?.targetId).toBe(wall.id);expect(worker.approachGoal?.point).toBeUndefined();expect(worker.pathRequestId).toBeUndefined();
    expect(issue({kind:'move',unitIds:blockers.map(blocker=>blocker.id),target:{xMm:65000,zMm:60000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<900&&wall.work<wall.required;tick++){
      boundedWallStep(sim);for(const blocker of blockers)expect(Math.hypot(worker.xMm-blocker.xMm,worker.zMm-blocker.zMm)).toBeGreaterThanOrEqual(700);
    }
    expect(wall.work).toBe(wall.required);expect(sim.state.economies.a!.resources.wood).toBe(bank);
  },30000);
  it('records a persistent physical wall-work stall as a failed face, restores it, and recovers when the blockade moves',()=>{
    const {sim,worker,addUnit,issue}=fixture(),origin={xMm:worker.xMm,zMm:worker.zMm};
    const blockers=Array.from({length:8},(_,index)=>{const angle=index*Math.PI/4;return addUnit(`ring_worker_${index}`,'villager',origin.xMm+Math.round(Math.cos(angle)*1000),origin.zMm+Math.round(Math.sin(angle)*1000));});
    sim.step();expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:20}],queued:false}).status).toBe('accepted');
    const wall=sim.state.entities[worker.orders[0]!.targetId!] as Building,startTick=sim.state.tick;
    for(let tick=0;tick<350&&!worker.approachGoal?.failedPoints?.length;tick++){
      boundedWallStep(sim);for(const blocker of blockers)expect(Math.hypot(worker.xMm-blocker.xMm,worker.zMm-blocker.zMm)).toBeGreaterThanOrEqual(700);
    }
    expect(worker.approachGoal?.failedPoints?.length,JSON.stringify(worker)).toBeGreaterThan(0);expect(sim.state.tick-startTick).toBeGreaterThanOrEqual(5*balance.rules.simulationHz);
    expect(wall.work).toBe(0);expect(worker.blockedReason).toBe('PATH_BLOCKED');expect(worker.approachGoal?.point).toBeUndefined();expect(worker.pathRequestId).toBeUndefined();
    const save=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const restored=restoreSimulation(JSON.parse(JSON.stringify(save)),identity,{preserveEpoch:true});
    for(let tick=0;tick<20;tick++){boundedWallStep(sim);restored.step();expect(simulationChecksum(restored)).toBe(simulationChecksum(sim));}
    expect(issue({kind:'move',unitIds:blockers.map(blocker=>blocker.id),target:{xMm:65000,zMm:60000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<900&&wall.work<wall.required;tick++)boundedWallStep(sim);
    expect(wall.work).toBe(wall.required);
  },30000);
  it('keeps pending wall decisions and authorized packets identical when an unseen enemy building changes',()=>{
    const {sim,worker}=paidWallDetour();boundedWallStep(sim);const other=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});
    const template=other.state.entities.enemy_home as Building,definition=buildings.house;
    other.state.entities.hidden_house={...structuredClone(template),id:'hidden_house',typeId:'house',xMm:60000,zMm:90000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,queue:[]};other.state.navigationRevision++;
    expect(other.view('a').entities.some(entity=>entity.id==='hidden_house')).toBe(false);
    for(let tick=0;tick<40;tick++){
      boundedWallStep(sim);boundedWallStep(other);expect(other.view('a')).toEqual(sim.view('a'));
      const counterpart=other.state.entities[worker.id] as Unit;expect(counterpart.orders).toEqual(worker.orders);expect(counterpart.approachGoal).toEqual(worker.approachGoal);expect(counterpart.path).toEqual(worker.path);
      expect(other.capture().runtime.pathScheduler.tasks.filter(task=>task.profile==='a')).toEqual(sim.capture().runtime.pathScheduler.tasks.filter(task=>task.profile==='a'));
      expect(JSON.stringify(other.view('a'))).not.toMatch(/wallTargets|approachGoal|failedPoints|pathRequestId|hidden_house/);
    }
  },30000);
  it.each(['a','b'])('escapes a building-sized stopped-worker blockade owned by%s to complete a paid wall',blockerOwner=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();
    // The ordinary seed137 paid-wall failure, translated by(-100m,-150m).
    // The idle350mm worker seals the entire2m TC/lumber-camp passage; the
    // builder must backtrack around a building while moving traffic continues.
    const home=sim.state.entities.home as Building;home.xMm=30000;home.zMm=42000;
    worker.xMm=36373;worker.zMm=47716;
    for(const [id,typeId,xMm,zMm]of [
      ['east_camp','lumber_camp',41000,45000],['north_house','house',40000,36000],
      ['south_house','house',40000,52000],['far_camp','lumber_camp',47000,49000],
      ['west_house','house',32000,56000],['far_house','house',48000,40000],
      ['north_barracks','barracks',30000,30000],['west_farm','farm',21000,49000],
    ] as const)addBuilding(id,typeId,xMm,zMm);
    const stopped=[
      addUnit('stopped_front','villager',36998,47370,blockerOwner),addUnit('stopped_south','villager',36000,48870),
      addUnit('stopped_southwest','villager',35000,48850),addUnit('stopped_west','villager',34002,48872),
    ];
    const traffic=addUnit('moving_traffic','villager',38027,48392);
    addUnit('wall_observer','scout',23000,28000);sim.state.navigationRevision++;sim.step();
    const before=sim.state.economies.a!.resources.wood;
    const receipt=issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:11,z:12}],queued:false});
    expect(receipt.status,receipt.code).toBe('accepted');
    expect(sim.state.economies.a!.resources.wood).toBe(before-buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    const wall=Object.values(sim.state.entities).find((e):e is Building=>e.kind==='building'&&e.typeId==='palisade_wall')!;
    expect(wall.work).toBe(0);
    for(const owner of ['a','b']){const ids=stopped.filter(unit=>unit.ownerId===owner).map(unit=>unit.id);if(ids.length)expect(issue({kind:'stop',unitIds:ids},owner).status).toBe('accepted');}
    expect(issue({kind:'patrol',unitIds:[traffic.id],points:[{xMm:39000,zMm:49000},{xMm:38027,zMm:48392}],queued:false}).status).toBe('accepted');
    const staticPositions=stopped.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm}));
    let movingTicks=0,firstWork:number|undefined,restored:ReturnType<typeof createSimulation>|undefined;
    const identity={engineBuildHash:'4'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
    for(let tick=0;tick<1800&&wall.work<wall.required;tick++){
      const prior={xMm:worker.xMm,zMm:worker.zMm},trafficPrior={xMm:traffic.xMm,zMm:traffic.zMm};sim.step();
      if(restored){restored.step();expect(restored.state.entities[worker.id]).toEqual(worker);expect(restored.state.entities[wall.id]).toEqual(wall);if(tick%50===0)expect(restored.capture()).toEqual(sim.capture());}
      else if(tick===10){restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(sim.capture());}
      if(traffic.xMm!==trafficPrior.xMm||traffic.zMm!==trafficPrior.zMm)movingTicks++;
      if(wall.work>0&&firstWork===undefined)firstWork=sim.state.tick;
      const nav=new Navigation(sim.state.widthMm,sim.state.heightMm,Object.values(sim.state.entities).flatMap(e=>e.kind==='building'?fortificationObstacles(e):[]));
      expect(nav.clearLine(prior,worker,units.villager.collisionRadiusM*1000)).toBe(true);
      for(const unit of [...stopped,traffic])expect(Math.hypot(worker.xMm-unit.xMm,worker.zMm-unit.zMm)).toBeGreaterThanOrEqual((units.villager.collisionRadiusM+units[unit.typeId].collisionRadiusM)*1000);
    }
    expect(stopped.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm}))).toEqual(staticPositions);
    expect(movingTicks).toBeGreaterThan(20);
    expect(wall.work,JSON.stringify({firstWork,movingTicks,worker:{xMm:worker.xMm,zMm:worker.zMm,taskState:worker.taskState,blockedReason:worker.blockedReason,path:worker.path},required:wall.required})).toBe(wall.required);
    expect(restored?.capture()).toEqual(sim.capture());
    console.info('Paid wall blockade completion',{blockerOwner,firstWork,completedTick:sim.state.tick,movingTicks});
  },30000);
  it('matches uncached traversal through controller construction, cancellation, birth and death',()=>{
    const cached=fixture(),reference=fixture();
    (reference.sim as unknown as {all:()=>unknown[]}).all=()=>Object.values(reference.sim.state.entities);
    for(const scenario of [cached,reference]){
      const {sim,worker,issue}=scenario;
      scenario.addUnit('roster_victim','scout',74000,80000,'b');
      sim.enableReplay(()=>{
        if(sim.state.tick===2)expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:20,z:19}],queued:false}).status).toBe('accepted');
        if(sim.state.tick===3){const wall=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall')!;expect(issue({kind:'cancel_foundation',foundationId:wall.id}).status).toBe('accepted');}
        if(sim.state.tick===4)expect(issue({kind:'train',buildingId:'home',unitType:'villager',quantity:1}).status).toBe('accepted');
      });
    }
    for(let tick=2;tick<=9;tick++){
      for(const {sim} of [cached,reference]){
        // Bounded fixture: reach the paid production completion and a death in this tick.
        if(tick===5){const job=(sim.state.entities.home as Building).queue[0]!;job.work=job.required-1;}
        if(tick===7)sim.state.entities.roster_victim!.hp=0;
        sim.step();
      }
      expect(cached.sim.capture()).toEqual(reference.sim.capture());
      for(const faction of factions)expect(cached.sim.view(faction.id)).toEqual(reference.sim.view(faction.id));
      if(tick===5)expect(cached.sim.view('a').entities.filter(entity=>entity.kind==='unit'&&entity.ownerId==='a')).toHaveLength(2);
      if(tick===7)expect(cached.sim.state.entities.roster_victim).toBeUndefined();
    }
    // A boundary insertion must be visible immediately, before any further step.
    cached.addUnit('boundary_insert','scout',43000,44000);
    expect(cached.sim.view('a').entities.some(entity=>entity.id==='boundary_insert')).toBe(true);
  });
  it('invalidates movement-phase geometry before same-tick foundation creation and cancellation commands',()=>{
    const {sim,worker,addUnit,issue}=fixture(),army=[addUnit('cache_scout','scout',38111,33360),addUnit('cache_spear','spearman',35071,33439)];sim.step();const tick=sim.state.tick;
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:20,z:19}],queued:false}).status).toBe('accepted');
    const wall=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall')!;
    const move:GameplayCommand={kind:'move',unitIds:army.map(unit=>unit.id),target:{xMm:41000,zMm:39000},queued:false};expect(issue(move).status).toBe('accepted');
    const profile=()=>sim.capture().runtime.planningProfiles.find(([id])=>id==='a')![1];expect(profile().obstacles.some(([,obstacle])=>obstacle.id===wall.id)).toBe(true);
    const blocked=new Navigation(sim.state.widthMm,sim.state.heightMm,fortificationObstacles(wall));for(const unit of army)expect(blocked.free(unit.orders[0]!.target!,units[unit.typeId].collisionRadiusM*1000)).toBe(true);
    expect(issue({kind:'cancel_foundation',foundationId:wall.id}).status).toBe('accepted');expect(issue(move).status).toBe('accepted');expect(profile().obstacles.some(([,obstacle])=>obstacle.id===wall.id)).toBe(false);expect(sim.state.tick).toBe(tick);
  });
  it.each([
    {name:'complete nominal fit',target:{xMm:28571,zMm:39439},scout:{xMm:24111,zMm:33360},spear:{xMm:21071,zMm:33439}},
    {name:'partial nominal fit at the rounded browser click',target:{xMm:27714,zMm:39645},scout:{xMm:31452,zMm:21713},spear:{xMm:33880,zMm:21907}},
  ])('moves a scout and spearman into compact interior slots through an AUTO gate: $name',({target,scout,spear})=>{
    const {sim,addBuilding,addUnit,issue}=fixture();
    // The browser's authorized 5x5 enclosure and click, translated onto this flat scenario.
    for(let z=37000;z<=45000;z+=2000)for(let x=25000;x<=33000;x+=2000){if(x!==25000&&x!==33000&&z!==37000&&z!==45000)continue;if(z===37000&&x>25000&&x<33000)continue;addBuilding(`ring_${x}_${z}`,'palisade_wall',x,z);}
    const gate=addBuilding('entry','wooden_gate',29000,37000);gate.gateMode='AUTO';gate.gateOpen=false;
    const army=[addUnit('scout','scout',scout.xMm,scout.zMm),addUnit('spear','spearman',spear.xMm,spear.zMm)];sim.step();
    expect(issue({kind:'move',unitIds:army.map(unit=>unit.id),target,queued:false}).status).toBe('accepted');
    const interior=(point:{xMm:number;zMm:number})=>point.xMm>26000&&point.xMm<32000&&point.zMm>38000&&point.zMm<44000;
    expect(army.every(unit=>interior(unit.orders[0]!.target!))).toBe(true);const goals=army.map(unit=>({...unit.orders[0]!.target!}));let opened=false;
    for(let tick=0;tick<600&&army.some(unit=>unit.orders.length);tick++){
      const before=army.map(unit=>({xMm:unit.xMm,zMm:unit.zMm}));sim.step();opened||=Boolean(gate.gateOpen);
      expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
      const nav=new Navigation(sim.state.widthMm,sim.state.heightMm,Object.values(sim.state.entities).flatMap(entity=>entity.kind==='building'?fortificationObstacles(entity):[]));
      for(const [index,unit]of army.entries())expect(nav.clearLine(before[index]!,unit,units[unit.typeId].collisionRadiusM*1000)).toBe(true);
      expect(Math.hypot(army[0]!.xMm-army[1]!.xMm,army[0]!.zMm-army[1]!.zMm)).toBeGreaterThanOrEqual((units.scout.collisionRadiusM+units.spearman.collisionRadiusM)*1000);
    }
    expect(opened).toBe(true);for(const [index,unit]of army.entries()){expect(interior(unit)).toBe(true);expect(unit.orders).toEqual([]);expect(Math.hypot(unit.xMm-goals[index]!.xMm,unit.zMm-goals[index]!.zMm)).toBeLessThanOrEqual(100);}
  });
  it.each(['split','exterior'] as const)('closes a visible U with %s builders using one bounded admission proof',side=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();sim.state.widthMm=200000;sim.state.heightMm=200000;
    worker.xMm=128000;worker.zMm=175000;
    const builders=[worker,addUnit('inside_middle','villager',128000,177000),addUnit('inside_bottom','villager',128000,179000),addUnit('outside_top','villager',135000,174000),addUnit('outside_middle','villager',135000,177000),addUnit('outside_bottom','villager',135000,180000)];
    for(let x=62;x<=66;x++)for(const z of [86,90])addBuilding(`ring_${x}_${z}`,'palisade_wall',x*2000+1000,z*2000+1000);
    for(let z=87;z<=89;z++)addBuilding(`ring_66_${z}`,'palisade_wall',133000,z*2000+1000);
    addUnit('interior_observer','scout',130000,177000);sim.step();
    const selected=side==='split'?builders:builders.slice(3),bank=sim.state.economies.a!.resources.wood,command:GameplayCommand={kind:'build_wall',builderIds:selected.map(builder=>builder.id),material:'palisade',cells:Array.from({length:5},(_,index)=>({x:62,z:90-index})),queued:false};
    const receipt=issue(command);expect(receipt.status,receipt.code).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall');expect(walls).toHaveLength(16);
    expect(sim.state.economies.a!.resources.wood).toBe(bank-3*buildings.palisade_wall.cost.wood*balance.rules.resourceScale);expect(selected.every(builder=>builder.orders.length===1)).toBe(true);
    expect(sim.state.pathAdmission?.a?.used).toBeLessThanOrEqual(50000);expect(sim.command('a',sim.state.commandLog.at(-1)!.envelope)).toEqual(receipt);
    const navigation=new Navigation(sim.state.widthMm,sim.state.heightMm,Object.values(sim.state.entities).flatMap(entity=>entity.kind==='building'?fortificationObstacles(entity):[])),worked=new Set<string>();
    for(let tick=0;tick<2400&&!walls.every(wall=>wall.work>=wall.required);tick++){
      const previous=selected.map(builder=>({xMm:builder.xMm,zMm:builder.zMm}));sim.step();
      for(const [index,builder]of selected.entries()){expect(navigation.clearLine(previous[index]!,builder,units.villager.collisionRadiusM*1000)).toBe(true);if(builder.taskState==='building')worked.add(builder.id);}
      const budget=sim.state.pathAdmission?.a;expect(budget?.tick===sim.state.tick?budget.used:0).toBe(0);expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
    }
    expect(walls.every(wall=>wall.work>=wall.required)).toBe(true);if(side==='exterior')expect([...worked].sort()).toEqual(selected.map(builder=>builder.id).sort());
  });
  it('accepts the full 64-cell limit once with visible sites and the bounded admission allowance',()=>{
    const {sim,worker,addUnit,issue}=fixture();sim.state.widthMm=200000;sim.state.heightMm=200000;
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    for(let x=50000;x<=182000;x+=12000)addUnit(`observer_${x}`,'scout',x,22000);
    const cost=64*buildings.palisade_wall.cost.wood*balance.rules.resourceScale;sim.state.economies.a!.resources.wood=cost;sim.step();
    const command:GameplayCommand={kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:Array.from({length:64},(_,index)=>({x:25+index,z:7})),queued:false};
    const receipt=issue(command);expect(receipt.status,receipt.code).toBe('accepted');
    expect(sim.state.economies.a!.resources.wood).toBe(0);expect(Object.values(sim.state.entities).filter(entity=>entity.typeId==='palisade_wall')).toHaveLength(64);expect(worker.orders).toHaveLength(1);
    expect(sim.command('a',sim.state.commandLog.at(-1)!.envelope)).toEqual(receipt);expect(sim.state.economies.a!.resources.wood).toBe(0);
    expect(sim.state.pathAdmission?.a?.used).toBeLessThanOrEqual(50000);
    console.info('M3 actual 64-cell command admission',{used:sim.state.pathAdmission!.a!.used,allowance:50000});
  });
  it('builds a complete atomic chain, charges a duplicate once, then replaces three walls without a free hole',()=>{
    const {sim,worker,issue}=fixture(),bank=sim.state.economies.a!.resources.wood;
    const command:GameplayCommand={kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:20},{x:25,z:20},{x:26,z:20}],queued:false};
    const receipt=issue(command);expect(receipt.status).toBe('accepted');
    const envelope=sim.state.commandLog.at(-1)!.envelope;expect(sim.command('a',envelope)).toEqual(receipt);
    expect(sim.state.economies.a!.resources.wood).toBe(bank-3*buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall');expect(walls).toHaveLength(3);expect(worker.orders).toHaveLength(1);
    until(sim,()=>walls.every(wall=>wall.work>=wall.required));
    expect(issue({kind:'replace_wall_with_gate',builderIds:[worker.id],wallIds:walls.map(wall=>wall.id),queued:false}).status).toBe('accepted');
    const gate=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='wooden_gate')!;
    expect(gate.work).toBe(0);expect(gate.gateOpen).toBeFalsy();expect(walls.every(wall=>!sim.state.entities[wall.id])).toBe(true);
    expect(sim.state.economies.a!.resources.wood).toBe(bank-(3*buildings.palisade_wall.cost.wood+buildings.wooden_gate.cost.wood)*balance.rules.resourceScale);
    until(sim,()=>gate.work>=gate.required);expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}).status).toBe('accepted');sim.step();expect(gate.gateOpen).toBe(false);
  });
  it('rejects an illegal last wall cell without creating any earlier cells or spending',()=>{
    const {sim,worker,addBuilding,issue}=fixture();addBuilding('occupied','palisade_wall',53000,41000,'b');sim.step();const bank=sim.state.economies.a!.resources.wood,count=Object.keys(sim.state.entities).length;
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:20},{x:25,z:20},{x:26,z:20}],queued:false}).code).toBe('PLACEMENT_BLOCKED');
    expect(Object.keys(sim.state.entities)).toHaveLength(count);expect(sim.state.economies.a!.resources.wood).toBe(bank);
  });
  it('stops a real ram at a closed wall, destroys a segment, and then traverses its breach',()=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();worker.xMm=20000;worker.zMm=20000;
    const home=sim.state.entities.home as Building;home.zMm=25000;
    for(let x=0;x<50;x++)addBuilding(`barrier_${x}`,'palisade_wall',x*2000+1000,49000,'b');
    const ram=addUnit('ram','battering_ram',51000,42000),target=sim.state.entities.barrier_25 as Building;
    sim.step();expect(issue({kind:'move',unitIds:[ram.id],target:{xMm:51000,zMm:58000},queued:false}).status).toBe('accepted');
    sim.step(150);expect(ram.zMm).toBeLessThan(48000-units.battering_ram.collisionRadiusM*1000);expect(target.hp).toBe(target.maxHp);
    expect(issue({kind:'attack_target',unitIds:[ram.id],targetId:target.id,queued:false}).status).toBe('accepted');
    until(sim,()=>!sim.state.entities[target.id],2500);const revision=sim.state.navigationRevision;
    expect(issue({kind:'move',unitIds:[ram.id],target:{xMm:51000,zMm:58000},queued:false}).status).toBe('accepted');
    until(sim,()=>Math.hypot(ram.xMm-51000,ram.zMm-58000)<500,2500);expect(sim.state.navigationRevision).toBeGreaterThanOrEqual(revision);
  });
  it('moves an army through its friendly gate, stops at enemy walls, and crosses a real siege breach',()=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();worker.xMm=20000;worker.zMm=20000;(sim.state.entities.home as Building).zMm=15000;
    for(let x=0;x<50;x++){
      if(x<24||x>26)addBuilding(`owned_${x}`,'palisade_wall',x*2000+1000,39000);
      addBuilding(`enemy_${x}`,'palisade_wall',x*2000+1000,59000,'b');
    }
    const gate=addBuilding('army_gate','wooden_gate',51000,39000),types:UnitId[]=['militia','spearman','battering_ram','scout','militia','spearman'];
    const army=types.map((type,index)=>addUnit(`army_${index}`,type,43000+index*4000,30000)),ram=army[2]!,ids=army.map(unit=>unit.id),barrier=sim.state.entities.enemy_25 as Building;
    sim.step();expect(issue({kind:'move',unitIds:ids,target:{xMm:51000,zMm:47000},queued:false}).status).toBe('accepted');
    let opened=false;for(let tick=0;tick<1800&&!army.every(unit=>unit.orders.length===0);tick++){sim.step();opened||=Boolean(gate.gateOpen);}
    expect(opened).toBe(true);expect(army.every(unit=>unit.zMm>41000&&unit.orders.length===0),JSON.stringify(army.map(unit=>({id:unit.id,x:unit.xMm,z:unit.zMm,blocked:unit.blockedReason})))).toBe(true);
    expect(issue({kind:'move',unitIds:ids,target:{xMm:51000,zMm:71000},queued:false}).status).toBe('accepted');sim.step(200);
    expect(army.every(unit=>unit.zMm<=58000-units[unit.typeId].collisionRadiusM*1000)).toBe(true);expect(barrier.hp).toBe(barrier.maxHp);
    issue({kind:'stop',unitIds:ids});expect(issue({kind:'attack_target',unitIds:[ram.id],targetId:barrier.id,queued:false}).status).toBe('accepted');until(sim,()=>!sim.state.entities[barrier.id],1800);
    expect(issue({kind:'move',unitIds:ids,target:{xMm:51000,zMm:71000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<2400&&!army.every(unit=>unit.zMm>61000&&unit.orders.length===0);tick++)sim.step();
    expect(army.every(unit=>unit.zMm>61000&&unit.orders.length===0),JSON.stringify(army.map(unit=>({id:unit.id,x:unit.xMm,z:unit.zMm,path:unit.path,orders:unit.orders,blocked:unit.blockedReason,lastProgress:unit.lastProgressTick,blockedRevision:unit.pathBlockedRevision})))).toBe(true);
  },30000);
  it('admits enemies through a physically opened AUTO gate and delays locking until the passage clears',()=>{
    const {sim,worker,addBuilding,addUnit,issue}=fixture();worker.xMm=20000;worker.zMm=20000;(sim.state.entities.home as Building).zMm=25000;
    for(let x=0;x<50;x++)if(x<24||x>26)addBuilding(`friendly_wall_${x}`,'palisade_wall',x*2000+1000,49000);
    const gate=addBuilding('gate','wooden_gate',51000,49000),friendly=addUnit('friendly','scout',57000,35000),enemy=addUnit('enemy','scout',51000,55000,'b');sim.step();
    expect(issue({kind:'move',unitIds:[enemy.id],target:{xMm:51000,zMm:49000},queued:false},'b').status).toBe('accepted');sim.step(150);
    expect(gate.gateOpen).toBeFalsy();expect(enemy.zMm).toBeGreaterThan(50000);
    expect(issue({kind:'move',unitIds:[friendly.id],target:{xMm:57000,zMm:44500},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<1200&&Math.hypot(enemy.xMm-51000,enemy.zMm-49000)>=100;tick++)sim.step();
    expect(Math.hypot(enemy.xMm-51000,enemy.zMm-49000),JSON.stringify({gate:gate.gateOpen,friendly:{x:friendly.xMm,z:friendly.zMm,orders:friendly.orders,reason:friendly.blockedReason},enemy:{x:enemy.xMm,z:enemy.zMm,orders:enemy.orders,reason:enemy.blockedReason}})).toBeLessThan(100);expect(gate.gateOpen).toBe(true);
    expect(issue({kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'}).status).toBe('accepted');sim.step(20);expect(gate.gateOpen).toBe(true);
    expect(issue({kind:'move',unitIds:[enemy.id],target:{xMm:51000,zMm:41000},queued:false},'b').status).toBe('accepted');
    until(sim,()=>enemy.zMm<46000,1200);sim.step();expect(gate.gateOpen).toBe(false);
  });
  it('retains explored wall plans after their only observing scout dies, without granting new sight',()=>{
    const {sim,worker,addUnit,issue}=fixture();const scout=addUnit('observer','scout',80000,20000);scout.hp=1;addUnit('enemy_knight','knight',81800,20000,'b');
    sim.step();expect(sim.state.entities[scout.id]).toBeUndefined();
    const before=sim.view('a'),cell=12*(sim.state.widthMm/(balance.rules.fogGridM*1000))+40;
    expect(before.fog.visible).not.toContain(cell);expect(before.fog.explored).toContain(cell);
    const bank=sim.state.economies.a!.resources.wood;
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:40,z:12}],queued:false}).status).toBe('accepted');
    const wall=sim.state.entities[worker.orders[0]!.targetId!] as Building;
    expect(wall.pendingConstruction).toEqual({clearanceMm:0});expect(wall.work).toBe(0);
    expect(sim.state.economies.a!.resources.wood).toBe(bank-buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    expect(sim.view('a').fog.visible).toEqual(before.fog.visible);expect(sim.view('b').entities.some(entity=>entity.id===wall.id)).toBe(false);
    const reserved=sim.state.economies.a!.resources.wood;
    expect(issue({kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:5,z:5}],queued:false}).code).toBe('PLACEMENT_UNAVAILABLE');
    expect(sim.state.economies.a!.resources.wood).toBe(reserved);
  });
});
