import {describe,expect,it} from 'vitest';
import {balance,buildings,units,PROTOCOL_VERSION,validatePlayerView,type GameplayCommand,type BuildingId,type UnitId} from '@frontier/shared';
import {createSimulation,createLiveSimulation,Simulation,type Building,type Unit} from '../src/index.js';
import {exportSimulationSave,restoreSimulation,restoreLiveSimulation} from '../src/persistence.js';
import {validateSimulationSavePayload} from '../src/save-schema.js';

let serial=0;
const hz=balance.rules.simulationHz;
function building(sim:Simulation,typeId:BuildingId,xMm:number,zMm:number,ownerId='a'):Building{const def=buildings[typeId],entity:Building={id:`discovered_${++serial}`,kind:'building',typeId,ownerId,xMm,zMm,rotation:0,hp:def.maxHp,maxHp:def.maxHp,work:def.buildSeconds*hz*100,required:def.buildSeconds*hz*100,grantedHp:def.maxHp,queue:[],cooldown:0};sim.state.entities[entity.id]=entity;sim.state.navigationRevision++;return entity;}
function unit(sim:Simulation,typeId:UnitId,xMm:number,zMm:number,ownerId='a'):Unit{const def=units[typeId],entity:Unit={id:`discovered_${++serial}`,kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground'};sim.state.entities[entity.id]=entity;return entity;}
function fixture(){const sim=createSimulation({seed:'construction-discovery',controllers:false,matchId:'discovered',factions:[{id:'a',name:'A',kind:'human',teamId:'a',color:'#0088ff'},{id:'b',name:'B',kind:'human',teamId:'b',color:'#ee5533'}]});sim.state.entities={};sim.state.map.terrain=[];sim.state.widthMm=120000;sim.state.heightMm=120000;sim.state.navigationRevision++;for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];vision.visible=[];}for(const economy of Object.values(sim.state.economies)){economy.resources={food:100000000,wood:100000000,gold:100000000,stone:100000000};}building(sim,'town_center',14000,14000);building(sim,'town_center',105000,105000,'b');const worker=unit(sim,'villager',18000,22000),scout=unit(sim,'scout',50000,50000);sim.step();delete sim.state.entities[scout.id];sim.step();return{sim,worker};}
function send(sim:Simulation,command:GameplayCommand,playerId='a'){const n=sim.state.economies[playerId]!.lastClientSequence+1;return sim.command(playerId,{protocolVersion:PROTOCOL_VERSION,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientSequence:n,clientCommandId:`${playerId}_${n}`,command});}
function place(sim:Simulation,worker:Unit){return send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:24,z:24},rotation:0,queued:false});}
function site(sim:Simulation){return Object.values(sim.state.entities).find((e):e is Building=>e.kind==='building'&&e.typeId==='house'&&e.ownerId==='a')!;}
const identity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};

describe('Explored construction authority',()=>{
  it.each([50,300,600] as const)('walks out of a queued wall footprint and preserves paid work and queued movement at %ims',interval=>{
    const {sim,worker}=fixture(),destination={xMm:49000,zMm:49000},after={xMm:44000,zMm:44000},before={...sim.state.economies.a!.resources};
    expect(send(sim,{kind:'move',unitIds:[worker.id],target:destination,queued:false}).status).toBe('accepted');
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24}],queued:true}).status).toBe('accepted');
    expect(send(sim,{kind:'move',unitIds:[worker.id],target:after,queued:true}).status).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall');
    expect(walls).toHaveLength(3);expect(walls.every(wall=>wall.pendingConstruction)).toBe(true);
    sim.state.movementCadenceTier=interval===600?2:0;
    const payload=sim.capture(),live=interval===50?undefined:createLiveSimulation({...payload.options,authoritativeIntervalMs:300,factions:payload.state.factions,matchId:payload.state.matchId},payload);
    let entered=false,currentWorker=worker,currentWalls=walls;
    for(let tick=0;tick<1600&&currentWorker.orders.length;tick+=interval/50){
      if(live)live.advanceFrame();else sim.step();
      const state=live?.state??sim.state;currentWorker=state.entities[worker.id] as Unit;currentWalls=walls.map(wall=>state.entities[wall.id] as Building);
      entered||=currentWorker.orders[0]?.kind==='build'&&currentWalls.some(wall=>wall.pendingConstruction&&Math.abs(currentWorker.xMm-wall.xMm)<1000&&Math.abs(currentWorker.zMm-wall.zMm)<1000);
      for(const wall of currentWalls)if(!wall.pendingConstruction){const dx=Math.max(0,Math.abs(currentWorker.xMm-wall.xMm)-1000),dz=Math.max(0,Math.abs(currentWorker.zMm-wall.zMm)-1000);expect(Math.hypot(dx,dz)).toBeGreaterThanOrEqual(units.villager.collisionRadiusM*1000);}
    }
    expect(entered).toBe(true);expect(currentWalls.every(wall=>wall.work===wall.required)).toBe(true);expect(currentWorker.orders).toEqual([]);
    expect(Math.hypot(currentWorker.xMm-after.xMm,currentWorker.zMm-after.zMm)).toBeLessThanOrEqual(100);
    expect((live?.state??sim.state).economies.a!.resources).toEqual({...before,wood:before.wood-3*buildings.palisade_wall.cost.wood*balance.rules.resourceScale});
  });
  it('shares a paid wall batch when a teammate receives a different order without stealing that order',()=>{
    const {sim,worker}=fixture(),other=unit(sim,'villager',19000,22000);
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id,other.id],material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24}],queued:false}).status).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'),ids=walls.map(wall=>wall.id).sort(),bank={...sim.state.economies.a!.resources};
    expect([...worker.orders[0]!.wallTargets!].sort()).toEqual(ids);expect([...other.orders[0]!.wallTargets!].sort()).toEqual(ids);
    expect(send(sim,{kind:'move',unitIds:[other.id],target:{xMm:24000,zMm:20000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<1600&&!walls.every(wall=>wall.work===wall.required);tick++)sim.step();
    expect(walls.every(wall=>wall.work===wall.required)).toBe(true);expect(Math.hypot(other.xMm-24000,other.zMm-20000)).toBeLessThanOrEqual(100);expect(other.orders).toEqual([]);expect(sim.state.economies.a!.resources).toEqual(bank);
  });
  it('works around a stopped friendly occupant, then resumes its paid segment after the owner moves it',()=>{
    const {sim,worker}=fixture(),blocker=unit(sim,'scout',19000,22000);
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24}],queued:false}).status).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'),blocked=walls.find(wall=>wall.xMm===49000)!,others=walls.filter(wall=>wall!==blocked),bank={...sim.state.economies.a!.resources};
    expect(send(sim,{kind:'move',unitIds:[blocker.id],target:{xMm:49000,zMm:49000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<400&&blocker.orders.length;tick++)sim.step();
    expect(blocker.orders).toEqual([]);expect(send(sim,{kind:'stop',unitIds:[blocker.id]}).status).toBe('accepted');
    const stopped={xMm:blocker.xMm,zMm:blocker.zMm};
    for(let tick=0;tick<1200&&!others.every(wall=>wall.work===wall.required);tick++){sim.step();expect({xMm:blocker.xMm,zMm:blocker.zMm}).toEqual(stopped);}
    expect(others.every(wall=>wall.work===wall.required),JSON.stringify({worker,walls:walls.map(wall=>({id:wall.id,xMm:wall.xMm,work:wall.work,required:wall.required,pending:wall.pendingConstruction}))})).toBe(true);expect(blocked.work).toBe(0);expect(blocked.pendingConstruction).toBeDefined();expect(worker.orders[0]?.wallTargets).toContain(blocked.id);
    expect(send(sim,{kind:'move',unitIds:[blocker.id],target:{xMm:44000,zMm:42000},queued:false}).status).toBe('accepted');
    for(let tick=0;tick<500&&blocked.work<blocked.required;tick++)sim.step();
    expect(blocked.work).toBe(blocked.required);expect(sim.state.economies.a!.resources).toEqual(bank);
  });
  it('recovers nearby orphaned paid walls at 600ms across a cold save without moving held or pinned units',async()=>{
    const {sim,worker}=fixture();
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24},{x:27,z:24}],queued:false}).status).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'),bank={...sim.state.economies.a!.resources};
    const pinnedWall=walls.pop()!;delete sim.state.control.a!.assistant!.releaseAfterIdle[pinnedWall.id];
    expect(send(sim,{kind:'hold_position',unitIds:[worker.id]}).status).toBe('accepted');
    const helper=unit(sim,'villager',45000,44000),pinned=unit(sim,'villager',47000,44000),foreign=unit(sim,'villager',51000,57000,'b');
    helper.stance='defensive';helper.autoGather=true;pinned.autoGather=true;
    expect(send(sim,{kind:'set_stance',unitIds:[pinned.id],stance:'defensive'}).status).toBe('accepted');
    expect(send(sim,{kind:'hold_position',unitIds:[foreign.id]},'b').status).toBe('accepted');
    const held=[worker,pinned,foreign].map(entity=>({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,orders:structuredClone(entity.orders)}));
    expect(sim.state.control.a!.assistant!.protectedEntityIds).toContain(pinned.id);
    sim.state.movementCadenceTier=2;const payload=sim.capture(),live=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,factions:payload.state.factions,matchId:payload.state.matchId},payload);
    live.advanceFrame();await live.synchronizeCapture();const saved=exportSimulationSave(live,identity);
    expect(validateSimulationSavePayload(saved.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const cold=restoreLiveSimulation(saved,identity,{preserveEpoch:true});
    for(let frame=0;frame<180&&!walls.every(wall=>{const current=live.state.entities[wall.id] as Building;return current.work===current.required;});frame++){
      live.advanceFrame();cold.advanceFrame();
      for(const before of held){const current=live.state.entities[before.id] as Unit;expect({id:current.id,xMm:current.xMm,zMm:current.zMm,orders:current.orders}).toEqual(before);}
    }
    expect(walls.every(wall=>{const current=live.state.entities[wall.id] as Building;return current.work===current.required;})).toBe(true);
    expect(live.state.economies.a!.resources).toEqual(bank);expect(live.state.control.a!.assistant!.protectedEntityIds).toContain(pinned.id);
    expect((live.state.entities[pinnedWall.id] as Building).work).toBe(0);expect(live.state.control.a!.assistant!.protectedEntityIds).toContain(pinnedWall.id);
    await live.synchronizeCapture();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());
  });
  it('retries two formerly occupied wall sites without alternating away from their expired retry targets',()=>{
    const {sim,worker}=fixture();
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24}],queued:false}).status).toBe('accepted');
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'),middle=walls.find(wall=>wall.xMm===51000)!;
    // Legal post-admission occupancy of nonphysical plans isolates the retry
    // boundary; the preceding case already exercises actual scout travel.
    const blockers=[unit(sim,'scout',49000,49000),unit(sim,'scout',53000,49000)];
    expect(send(sim,{kind:'stop',unitIds:blockers.map(blocker=>blocker.id)}).status).toBe('accepted');
    for(let tick=0;tick<1000&&(!walls.filter(wall=>wall!==middle).every(wall=>wall.pendingConstruction?.blocked)||middle.work<middle.required);tick++)sim.step();
    expect(middle.work).toBe(middle.required);expect(walls.filter(wall=>wall!==middle).every(wall=>wall.pendingConstruction?.blocked)).toBe(true);
    for(const [index,blocker] of blockers.entries())expect(send(sim,{kind:'move',unitIds:[blocker.id],target:{xMm:44000+index*4000,zMm:42000},queued:false}).status).toBe('accepted');
    const revision=worker.orderRevision??0;
    for(let tick=0;tick<600&&!walls.every(wall=>wall.work===wall.required);tick++)sim.step();
    expect(walls.every(wall=>wall.work===wall.required)).toBe(true);expect((worker.orderRevision??0)-revision).toBeLessThan(20);
  });
  it('redirects workers beyond the construction efficiency cap to other paid segments',()=>{
    const {sim}=fixture(),crew=[...[-650,50,750].flatMap(dx=>[unit(sim,'villager',49000+dx,47650),unit(sim,'villager',49000+dx,50350)]),unit(sim,'villager',47650,49000)];
    expect(send(sim,{kind:'build_wall',builderIds:crew.map(worker=>worker.id),material:'palisade',cells:[{x:24,z:24},{x:25,z:24},{x:26,z:24}],queued:false}).status).toBe('accepted');
    const first=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'&&entity.xMm===49000)!,initiallyAssigned=crew.filter(worker=>worker.orders[0]?.targetId===first.id);
    expect(initiallyAssigned.length).toBeGreaterThan(balance.rules.constructionWorkerMultipliers.length);
    let reassigned=false;for(let tick=0;tick<40&&!reassigned;tick++){sim.step();reassigned=first.work<first.required&&initiallyAssigned.some(worker=>worker.orders[0]?.kind==='build'&&worker.orders[0].targetId!==first.id);}
    expect(reassigned).toBe(true);expect(first.work).toBeGreaterThan(0);expect(first.work).toBeLessThan(first.required);
  });
  it('admits the same paid hidden site with or without an undisclosed obstruction, without revealing it',()=>{
    for(const obstructed of [false,true]){const {sim,worker}=fixture();if(obstructed)building(sim,'house',50000,50000,'b');unit(sim,'scout',55000,50000,'b');sim.step();const visibleBefore=[...sim.state.vision.a!.visible],bank=sim.state.economies.a!.resources.wood;expect(place(sim,worker).status).toBe('accepted');const planned=site(sim);expect(planned.pendingConstruction).toEqual({clearanceMm:0});expect(bank-sim.state.economies.a!.resources.wood).toBe(buildings.house.cost.wood*balance.rules.resourceScale);sim.step();expect(sim.state.vision.a!.visible).toEqual(visibleBefore);const own=sim.view('a'),foreign=sim.view('b');expect(own.entities.find(e=>e.id===planned.id)?.pendingConstruction).toBe(true);expect(foreign.entities.some(e=>e.id===planned.id)).toBe(false);expect(validatePlayerView(own),JSON.stringify(validatePlayerView.errors)).toBe(true);expect(validatePlayerView(foreign),JSON.stringify(validatePlayerView.errors)).toBe(true);}
  });
  it('keeps a remembered obstruction authoritative for admission without consulting its hidden current existence',()=>{
    const {sim,worker}=fixture(),enemy=building(sim,'house',50000,50000,'b'),observer=unit(sim,'scout',50000,55000);sim.step();delete sim.state.entities[observer.id];sim.step();delete sim.state.entities[enemy.id];sim.state.navigationRevision++;const bank={...sim.state.economies.a!.resources};expect(place(sim,worker).code).toBe('PLACEMENT_BLOCKED');expect(sim.state.economies.a!.resources).toEqual(bank);expect(site(sim)).toBeUndefined();
  });
  it('rejects an undiscovered footprint before changing banks or creating a site',()=>{
    const {sim,worker}=fixture(),bank={...sim.state.economies.a!.resources},count=Object.keys(sim.state.entities).length;expect(send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:40,z:12},rotation:0,queued:false}).code).toBe('PLACEMENT_UNAVAILABLE');expect(sim.state.economies.a!.resources).toEqual(bank);expect(Object.keys(sim.state.entities)).toHaveLength(count);
  });
  it('activates only at real worker contact and retains native frame/save behavior',()=>{
    const {sim,worker}=fixture();expect(place(sim,worker).status).toBe('accepted');const planned=site(sim),capture=sim.capture();expect(validateSimulationSavePayload(capture),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(capture);worker.xMm=47400;worker.zMm=50000;worker.path=[];delete worker.pathRequestId;const contact=sim.capture(),live=createLiveSimulation({...contact.options,authoritativeIntervalMs:300,factions:contact.state.factions,matchId:contact.state.matchId},contact),scalar=new Simulation({...contact.options,authoritativeIntervalMs:50,factions:contact.state.factions,matchId:contact.state.matchId},contact);live.advanceFrame();scalar.step(6);const built=live.state.entities[planned.id] as Building;expect(built.pendingConstruction).toBeUndefined();expect(built.work).toBeGreaterThan(0);expect(live.state.entities).toEqual(scalar.state.entities);expect(live.state.vision.a!.visible.length).toBeGreaterThan(capture.state.vision.a!.visible.length);
  });
  it('waits on a newly encountered obstacle and retries without spending again',()=>{
    const {sim,worker}=fixture();building(sim,'house',51500,50000,'b');expect(place(sim,worker).status).toBe('accepted');const planned=site(sim),bank={...sim.state.economies.a!.resources};worker.xMm=47400;worker.zMm=50000;worker.path=[];delete worker.pathRequestId;sim.step();expect(planned.pendingConstruction?.blocked).toBe(true);expect(planned.work).toBe(0);expect(sim.view('a').entities.find(e=>e.id===planned.id)?.blockedReason).toBe('PLACEMENT_BLOCKED');for(const e of Object.values(sim.state.entities))if(e.ownerId==='b'&&e.typeId==='house')delete sim.state.entities[e.id];sim.state.navigationRevision++;sim.step(hz+1);expect(planned.pendingConstruction).toBeUndefined();expect(planned.work).toBeGreaterThan(0);expect(sim.state.economies.a!.resources).toEqual(bank);
  });
  it('returns all reserved resources when the owner cancels an unmaterialized site',()=>{
    const {sim,worker}=fixture(),before={...sim.state.economies.a!.resources};expect(place(sim,worker).status).toBe('accepted');const planned=site(sim);expect(send(sim,{kind:'cancel_foundation',foundationId:planned.id}).status).toBe('accepted');expect(sim.state.entities[planned.id]).toBeUndefined();expect(sim.state.economies.a!.resources).toEqual(before);
  });
  it('retains a blocked native site and its bounded retry schedule across a cold save',async()=>{
    const {sim,worker}=fixture();building(sim,'house',51500,50000,'b');expect(place(sim,worker).status).toBe('accepted');const planned=site(sim);worker.xMm=47400;worker.zMm=50000;worker.path=[];delete worker.pathRequestId;const payload=sim.capture(),live=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,factions:payload.state.factions,matchId:payload.state.matchId},payload);live.advanceFrame();expect((live.state.entities[planned.id] as Building).pendingConstruction?.blocked).toBe(true);await live.synchronizeCapture();const cold=restoreLiveSimulation(exportSimulationSave(live,identity),identity,{preserveEpoch:true});for(let i=0;i<4;i++){live.advanceFrame();cold.advanceFrame();}await live.synchronizeCapture();await cold.synchronizeCapture();expect(cold.capture()).toEqual(live.capture());expect((live.state.entities[planned.id] as Building).work).toBe(0);expect((live.state.entities[planned.id] as Building).pendingConstruction!.retryAtTick).toBeGreaterThan(live.state.tick);expect(live.view('b').entities.some(e=>e.id===planned.id)).toBe(false);
  });
  it('allows exact mountain contact but never terrain overlap or partially undiscovered wall batches',()=>{
    const {sim,worker}=fixture();sim.state.map.terrain=[{id:'ridge',kind:'ridge',xMm:40000,zMm:30000,widthMm:10000,depthMm:30000,elevationMm:6000}];sim.state.navigationRevision++;worker.xMm=37300;worker.zMm=41000;sim.step();expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:19,z:20}],queued:false}).status).toBe('accepted');expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:20,z:20}],queued:false}).code).toBe('PLACEMENT_BLOCKED');const before={...sim.state.economies.a!.resources};expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:Array.from({length:12},(_,i)=>({x:19,z:21+i})),queued:false}).code).toBe('PLACEMENT_UNAVAILABLE');expect(sim.state.economies.a!.resources).toEqual(before);
  });
});
