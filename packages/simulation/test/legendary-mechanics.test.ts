import {describe,expect,it} from 'vitest';
import {balance,buildings,units,technologies,effectiveUnit,effectiveBuilding,legendaryExpansion,resolveRuleset,structureUpgrade,PROTOCOL_VERSION,type BuildingId,type UnitId,type GameplayCommand,type MaximumAge,type ResourceBank} from '@frontier/shared';
import {createSimulation,createLiveSimulation,Simulation,type Unit,type Building} from '../src/index.js';
import {WardSystem,absorbWard} from '../src/legendary-mechanics.js';
import {exportSimulationSave,restoreSimulation} from '../src/persistence.js';
import {validateSimulationSavePayload} from '../src/save-schema.js';
import {fortificationObstacles} from '../src/fortifications.js';
import {Navigation} from '../src/navigation.js';
import {damageAmount,projectilePosition} from '../src/combat.js';
import {PathScheduler} from '../src/path-scheduler.js';
import {constructionReconnaissance,caretakerCommands,emptyCaretakerMemory} from '../src/caretaker.js';

const hz=balance.rules.simulationHz,scale=balance.rules.resourceScale;
let serial=0;
/** Mechanical encounters intentionally author age/banks and units; gameplay
 * commands, paid jobs, fog, collisions and event ordering remain the real code. */
function fixture(maxAge:MaximumAge=8,monumentVictory=false){
  const sim=createSimulation({rulesetId:'legendary_ages_v1',maxAge,monumentVictory,startingResourcePreset:'standard',seed:'legendary-mechanics',matchId:'legendary',controllers:false,factions:[{id:'a',name:'A',kind:'human',teamId:'a',color:'#0088ff'},{id:'b',name:'B',kind:'human',teamId:'b',color:'#ee5533'}]});
  sim.state.entities={};sim.state.widthMm=120000;sim.state.heightMm=120000;sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];vision.visible=[];}
  for(const economy of Object.values(sim.state.economies)){economy.age=maxAge;economy.resources={food:100000000,wood:100000000,gold:100000000,stone:100000000};economy.technologies=Object.values(technologies).filter(t=>t.minAge<=maxAge).map(t=>t.id);economy.researchRevision=economy.technologies.length;}
  const home=building(sim,'town_center',14000,14000),enemy=building(sim,'town_center',105000,105000,'b');
  return {sim,home,enemy};
}
function building(sim:Simulation,typeId:BuildingId,xMm:number,zMm:number,ownerId='a'):Building{const def=buildings[typeId],b:Building={id:`legendary_${++serial}`,kind:'building',typeId,ownerId,xMm,zMm,rotation:0,hp:def.maxHp,maxHp:def.maxHp,work:def.buildSeconds*hz*100,required:def.buildSeconds*hz*100,grantedHp:def.maxHp,queue:[],cooldown:0};sim.state.entities[b.id]=b;sim.state.navigationRevision++;return b;}
function unit(sim:Simulation,typeId:UnitId,xMm:number,zMm:number,ownerId='a'):Unit{const def=units[typeId],u:Unit={id:`legendary_${++serial}`,kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',...(def.deploySeconds?{deploymentState:'packed' as const}:{})};sim.state.entities[u.id]=u;return u;}
function send(sim:Simulation,command:GameplayCommand,playerId='a'){const sequence=sim.state.economies[playerId]!.lastClientSequence+1;return sim.command(playerId,{protocolVersion:PROTOCOL_VERSION,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${playerId}_${sequence}`,clientSequence:sequence,command});}
const identity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};

describe('Legendary authoritative mechanics',()=>{
  it('gates age caps and legally purchases each sequential later age with exact costs',()=>{
    const {sim,home}=fixture();sim.state.economies.a!.age=4;
    for(const type of ['fortress','university','market','grand_citadel','great_siege_yard','runic_citadel','rune_forge','ward_spire','titan_citadel'] as BuildingId[])building(sim,type,60000+(serial%3)*15000,10000+(serial%4)*14000);
    for(const targetAge of [5,6,7,8] as const){const definition=resolveRuleset('legendary_ages_v1',8,'standard').ages.find(a=>a.id===targetAge)!,before={...sim.state.economies.a!.resources};expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge}).status).toBe('accepted');for(const resource of balance.resourceOrder)expect(before[resource]-sim.state.economies.a!.resources[resource]).toBe(definition.cost[resource]*scale);expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge}).code).toBe('AGE_PENDING');home.queue[0]!.work=home.queue[0]!.required-1;home.queue[0]!.started=true;sim.step();expect(sim.state.economies.a!.age).toBe(targetAge);}
    const capped=fixture(4);expect(send(capped.sim,{kind:'advance_age',townCenterId:capped.home.id,targetAge:5}).code).toBe('INVALID_AGE');
  });
  it('atomically admits paid upgrades, waits for actual builders, preserves damage and refunds a canceled waiting job',()=>{
    const {sim}=fixture(),wall=building(sim,'stone_wall',40000,40000),worker=unit(sim,'villager',41350,40000);worker.orders=[{kind:'move',target:{xMm:41350,zMm:40000}}];wall.hp-=80;sim.step();worker.orders=[{kind:'patrol',points:[{xMm:41350,zMm:40000},{xMm:41350,zMm:41000}],pointIndex:0}];
    const before={...sim.state.economies.a!.resources},cost=structureUpgrade('stone_wall','bastion_wall')!;
    expect(send(sim,{kind:'upgrade_structure',buildingIds:[wall.id,wall.id],targetTypeId:'bastion_wall'}).code).toBe('INVALID_COMMAND');expect(sim.state.economies.a!.resources).toEqual(before);
    expect(send(sim,{kind:'upgrade_structure',buildingIds:[wall.id],targetTypeId:'bastion_wall'}).status).toBe('accepted');expect(wall.upgrade?.started).toBe(false);expect(wall.upgrade?.work).toBe(0);expect(before.stone-sim.state.economies.a!.resources.stone).toBe(cost.cost.stone*scale);
    const jobId=wall.upgrade!.id;expect(send(sim,{kind:'cancel_job',buildingId:wall.id,jobId}).status).toBe('accepted');expect(sim.state.economies.a!.resources).toEqual(before);
    expect(send(sim,{kind:'upgrade_structure',buildingIds:[wall.id],targetTypeId:'bastion_wall'}).status).toBe('accepted');expect(send(sim,{kind:'continue_build',builderIds:[worker.id],foundationId:wall.id,queued:false}).status).toBe('accepted');sim.step();expect(wall.upgrade!.work).toBeGreaterThan(0);expect(wall.typeId).toBe('stone_wall');wall.upgrade!.work=wall.upgrade!.required-1;sim.step();expect(wall.typeId).toBe('bastion_wall');expect(wall.maxHp-wall.hp).toBe(80);expect(wall.upgrade).toBeUndefined();
  });
  it('reserves giant caps when queued, preserves blocked exits and rechecks Rune Forge at job start',()=>{
    const {sim}=fixture(),yard=building(sim,'great_siege_yard',40000,40000),forge=building(sim,'rune_forge',60000,40000);sim.step();
    expect(send(sim,{kind:'train',buildingId:yard.id,unitType:'worldbreaker_trebuchet',quantity:1}).status).toBe('accepted');expect(send(sim,{kind:'train',buildingId:yard.id,unitType:'worldbreaker_trebuchet',quantity:1}).code).toBe('UNIT_LIMIT');forge.hp=0;sim.step();expect(yard.queue[0]!.state).toBe('prerequisite_blocked');expect(yard.queue[0]!.reserved).toBe(false);expect(send(sim,{kind:'cancel_job',buildingId:yard.id,jobId:yard.queue[0]!.id}).status).toBe('accepted');
    building(sim,'rune_forge',60000,40000);expect(send(sim,{kind:'train',buildingId:yard.id,unitType:'worldbreaker_trebuchet',quantity:1}).status).toBe('accepted');
  });
  it('produces every added unit through the paid authoritative queue',()=>{
    const {sim}=fixture(),yard=building(sim,'great_siege_yard',40000,40000);building(sim,'rune_forge',60000,40000);for(let i=0;i<8;i++)building(sim,'house',20000+i*7000,80000);sim.step();
    for(const definition of legendaryExpansion.units){
      expect(send(sim,{kind:'train',buildingId:yard.id,unitType:definition.id,quantity:1}).status,definition.id).toBe('accepted');sim.step();const job=yard.queue[0]!;expect(job.started,definition.id).toBe(true);job.work=job.required-1;sim.step();const produced=Object.values(sim.state.entities).find((e):e is Unit=>e.kind==='unit'&&e.typeId===definition.id);expect(produced,definition.id).toBeDefined();expect(yard.queue).toHaveLength(0);if(produced)delete sim.state.entities[produced.id];
    }
  });
  it('keeps eight-meter gates physically clear for giants and rejects narrow old gates',()=>{
    const {sim}=fixture(),wide=building(sim,'bastion_gate',50000,50000),narrow=building(sim,'stone_gate',70000,50000);wide.gateOpen=narrow.gateOpen=true;
    const nav=new Navigation(120000,120000,[...fortificationObstacles(wide),...fortificationObstacles(narrow)]),radius=units.crown_colossus.collisionRadiusM*1000;
    expect(nav.clearLine({xMm:50000,zMm:40000},{xMm:50000,zMm:60000},radius)).toBe(true);expect(nav.clearLine({xMm:70000,zMm:40000},{xMm:70000,zMm:60000},radius)).toBe(false);
  });
  it('retains giant shared planning and resumes its saved frontier after a safe geometry edit',()=>{
    const ridge={id:'ridge',xMm:64000,zMm:64000,halfWidth:1000,halfHeight:40000};let nav=new Navigation(128000,128000,[ridge]);const planner=new PathScheduler(()=>nav,['a']),requests=[0,1].map(i=>({id:`giant_${i}`,unitId:`giant_${i}`,profile:'a',orderRevision:1,from:{xMm:8000+i*1000,zMm:24000},target:{xMm:120000,zMm:24000},radiusMm:2600,workClass:'routine' as const,enqueuedTick:7}));for(const request of requests)planner.request(request);
    for(let i=0;i<1500;i++){planner.advance(32);if(Object.keys(planner.exportState().sharedJobs?.registry.jobs[0]?.frontier.coarse.scores??{}).length>=8)break;}
    const job=planner.exportState().sharedJobs?.registry.jobs[0];expect(job).toBeDefined();expect(job!.frontier.radiusMm).toBe(2600);
    nav=new Navigation(128000,128000,[ridge,{id:'remote_tree',xMm:116000,zMm:116000,halfWidth:1000,halfHeight:1000}]);planner.invalidate('a',[{xMm:115000,zMm:115000,widthMm:2000,depthMm:2000}]);const saved=planner.exportState();expect(saved.sharedJobs?.registry.jobs[0]?.id).toBe(job!.id);const cold=new PathScheduler(()=>nav,['a']);cold.importState(structuredClone(saved));
    for(let i=0;i<350;i++){expect(cold.advance(512)).toEqual(planner.advance(512));if(planner.exportState().tasks.every(task=>task.stage==='done'))break;}expect(cold.exportState()).toEqual(planner.exportState());for(const request of requests){const route=planner.take(request.unitId,1);expect(route?.status).toBe('ready');if(route?.status==='ready'){let previous=request.from;for(const point of route.points){expect(nav.clearLine(previous,point,2600)).toBe(true);previous=point;}}}
  });
  it('bounds nonstacking ward assignments, observes a quiet interval and uses the exact depletion overflow',()=>{
    const {sim}=fixture(),spire=building(sim,'ward_spire',50000,50000),spire2=building(sim,'ward_spire',52000,50000),citadel=building(sim,'eternal_citadel',50000,65000);for(let i=0;i<14;i++)building(sim,'eternal_wall',40000+i*2000,50000);const wards=new WardSystem(),roster=Object.values(sim.state.entities);wards.advance(sim.state,roster);expect(citadel.ward?.current).toBe(0);expect(Object.values(sim.state.entities).filter(e=>e.kind==='building'&&e.ward)).toHaveLength(12);expect(spire.ward).toBeUndefined();expect(spire2.ward).toBeUndefined();
    for(let i=0;i<20*hz;i++){sim.state.tick++;wards.advance(sim.state,roster);}expect(citadel.ward!.current).toBeGreaterThan(0);citadel.ward!.current=5;expect(absorbWard(citadel,10,3,sim.state.tick,true)).toBe(8);expect(citadel.ward!.current).toBe(0);citadel.ward!.current=100;expect(absorbWard(citadel,10,3,sim.state.tick,false)).toBe(10);expect(citadel.ward!.current).toBe(100);
  });
  it('charges Worldbreaker stone only on actual launch and preserves cooldown when wind-up is canceled',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,40000);engine.deploymentState='deployed';building(sim,'house',65000,40000,'b');unit(sim,'scout',65000,44000);sim.step();const before=sim.state.economies.a!.resources.stone;expect(engine.windup).toBeDefined();expect(sim.state.economies.a!.resources.stone).toBe(before);send(sim,{kind:'stop',unitIds:[engine.id]});expect(engine.windup).toBeUndefined();expect(engine.cooldown).toBeGreaterThan(0);engine.cooldown=0;sim.step();const launchTick=engine.windup!.launchTick;sim.step(launchTick-sim.state.tick);expect(sim.state.economies.a!.resources.stone).toBe(before-40000);expect(sim.state.projectiles.filter(p=>p.sourceId===engine.id)).toHaveLength(1);
  });
  it('retains authored launch heights after shooter death and a cold save without changing impact timing',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,40000);engine.deploymentState='deployed';const target=building(sim,'house',65000,40000,'b');unit(sim,'scout',65000,44000).cooldown=10000;
    sim.step();sim.step(engine.windup!.launchTick-sim.state.tick);const shot=sim.state.projectiles.find(projectile=>projectile.sourceId===engine.id)!;
    expect(shot.launchHeightMm).toBe(12629);expect(projectilePosition(shot,sim.state).yMm).toBe(12629);
    const legacy={...shot};delete legacy.launchHeightMm;expect(projectilePosition(legacy,sim.state).yMm).toBe(1500);
    expect(shot.hitTick-shot.launchTick).toBe(Math.ceil(25000/(units.worldbreaker_trebuchet!.projectileSpeedMps*1000)*hz));
    const malformed=sim.capture();malformed.state.projectiles[0]!.launchHeightMm=100001;expect(validateSimulationSavePayload(malformed)).toBe(false);
    engine.hp=0;sim.step();expect(sim.state.entities[engine.id]).toBeUndefined();expect(sim.state.projectiles).toContainEqual(shot);
    const cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true}),hp=target.hp;
    while(sim.state.tick<shot.hitTick){expect(projectilePosition(cold.state.projectiles.find(projectile=>projectile.id===shot.id)!,cold.state)).toEqual(projectilePosition(shot,sim.state));sim.step();cold.step();}
    expect(cold.capture()).toEqual(sim.capture());expect(sim.state.projectiles.some(projectile=>projectile.id===shot.id)).toBe(false);expect(sim.state.entities[target.id]?.hp??0).toBeLessThan(hp);
    const turretCase=fixture(),carrier=unit(turretCase.sim,'crown_colossus',40000,40000);unit(turretCase.sim,'stone_warden',51000,40000,'b').cooldown=10000;turretCase.sim.step();expect(turretCase.sim.state.projectiles.find(projectile=>projectile.sourceId===carrier.id)?.launchHeightMm).toBe(11700);
    const citadelCase=fixture(),citadel=building(citadelCase.sim,'grand_citadel',40000,40000);unit(citadelCase.sim,'stone_warden',52000,40000,'b').cooldown=10000;citadelCase.sim.step();const ports=citadelCase.sim.state.projectiles.filter(projectile=>projectile.sourceId===citadel.id);expect(ports).toHaveLength(buildings.grand_citadel!.weaponPorts!);expect(ports.every(projectile=>projectile.launchHeightMm===12600)).toBe(true);
  });
  it('permits mobile boarding only explicitly, retains heal schedule and forbids workers/nesting',()=>{
    const {sim}=fixture(),carrier=unit(sim,'crown_colossus',50000,50000),passenger=unit(sim,'spearman',53300,50000),worker=unit(sim,'villager',50000,53300);passenger.hp-=10;passenger.garrisonHealTicks=7;sim.step();expect(passenger.garrisonedIn).toBeUndefined();expect(send(sim,{kind:'garrison',unitIds:[worker.id],targetId:carrier.id,queued:false}).code).toBe('INVALID_TARGET');expect(send(sim,{kind:'garrison',unitIds:[passenger.id],targetId:carrier.id,queued:false}).status).toBe('accepted');sim.step();expect(passenger.garrisonedIn).toBe(carrier.id);expect(passenger.garrisonHealTicks).toBe(7);expect(carrier.garrisoned).toEqual([passenger.id]);expect(send(sim,{kind:'garrison',unitIds:[carrier.id],targetId:carrier.id,queued:false}).code).toBe('INVALID_TARGET');expect(send(sim,{kind:'ungarrison',buildingId:carrier.id,unitIds:[passenger.id]}).status).toBe('accepted');sim.step();expect(passenger.garrisonedIn).toBeUndefined();expect(passenger.garrisonHealTicks).toBe(8);
  });
  it('saves paid upgrade and ward states without Classic reinterpretation or duplicate debit',()=>{
    const {sim}=fixture(),spire=building(sim,'ward_spire',50000,50000),wall=building(sim,'runestone_wall',55000,50000);sim.step();expect(wall.ward?.supportId).toBe(spire.id);expect(send(sim,{kind:'upgrade_structure',buildingIds:[wall.id],targetTypeId:'titan_wall'}).status).toBe('accepted');const capture=sim.capture();expect(validateSimulationSavePayload(capture),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(capture);expect(restored.state.economies.a!.resources).toEqual(sim.state.economies.a!.resources);
  });
  it('keeps multiple weapon cooldowns equivalent in native 300ms frames and scalar events',()=>{
    const {sim}=fixture();building(sim,'grand_citadel',40000,40000);const target=unit(sim,'stone_warden',52000,40000,'b');target.cooldown=10000;sim.step();const payload=sim.capture();const coarse=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,localPlanningMode:undefined,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload),scalar=new Simulation({...payload.options,authoritativeIntervalMs:50,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload);
    for(let frame=0;frame<8;frame++){coarse.advanceFrame();scalar.step(6);expect(coarse.state.entities).toEqual(scalar.state.entities);expect(coarse.state.projectiles).toEqual(scalar.state.projectiles);}
  });
  it('admits a newly upgraded citadel into an existing spire without granting free ward',()=>{
    const {sim}=fixture(),spire=building(sim,'ward_spire',40000,40000),citadel=building(sim,'grand_citadel',55000,40000),worker=unit(sim,'villager',44350,40000);sim.step();expect(citadel.ward).toBeUndefined();
    expect(send(sim,{kind:'upgrade_structure',buildingIds:[citadel.id],targetTypeId:'runic_citadel'}).status).toBe('accepted');citadel.upgrade!.work=citadel.upgrade!.required-1;citadel.upgrade!.started=true;
    // Complete on a real builder contact in the native owner, preserving its
    // cached actor roster through the type change.
    worker.xMm=44350;const payload=sim.capture(),live=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,factions:payload.state.factions,matchId:payload.state.matchId},payload);live.advanceFrame();const result=live.state.entities[citadel.id] as Building;
    expect(result.typeId).toBe('runic_citadel');expect(result.ward?.supportId).toBe(spire.id);expect(result.ward?.current).toBe(0);
  });
  it('withholds launch and stone debit when ammunition is spent during wind-up',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,40000);engine.deploymentState='deployed';building(sim,'house',65000,40000,'b');unit(sim,'scout',65000,44000);sim.step();const deadline=engine.windup!.launchTick;sim.state.economies.a!.resources.stone=39000;sim.step(deadline-sim.state.tick);
    expect(sim.state.projectiles.some(p=>p.sourceId===engine.id)).toBe(false);expect(sim.state.economies.a!.resources.stone).toBe(39000);expect(engine.cooldown).toBeGreaterThan(0);expect(engine.blockedReason).toBe('OUT_OF_AMMUNITION');
  });
  it('hides ammunition, wind-up aim, support IDs and hidden landing warnings from enemies',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,40000);engine.deploymentState='deployed';building(sim,'house',65000,40000,'b');unit(sim,'scout',43000,44000,'b');unit(sim,'scout',65000,44000);const spire=building(sim,'ward_spire',40000,50000),wall=building(sim,'runestone_wall',45000,50000);sim.step();
    const enemy=sim.view('b'),observed=enemy.entities.find(e=>e.id===engine.id),defense=enemy.entities.find(e=>e.id===wall.id);expect(observed).toBeDefined();expect(observed?.ammoAffordable).toBeUndefined();expect(observed?.windup?.aim).toBeUndefined();expect(defense?.ward?.supportId).toBeUndefined();expect(sim.view('a').entities.find(e=>e.id===wall.id)?.ward?.supportId).toBe(spire.id);
    const p={id:'warning_probe',kind:'stone' as const,sourceId:engine.id,sourceTypeId:'worldbreaker_trebuchet' as const,ownerId:'a',from:{xMm:42000,zMm:44000},aim:{xMm:105000,zMm:20000},launchTick:sim.state.tick,hitTick:sim.state.tick+100,attack:{attack:650,attackType:'crush' as const,bonusDamage:{}},bands:[{radiusM:8,multiplier:1}]};sim.state.projectiles.push(p);
    const hidden=sim.view('b').projectiles?.find(p=>p.id==='warning_probe');expect(hidden).toBeDefined();expect(hidden?.impactWarning).toBeUndefined();p.aim={xMm:44000,zMm:44000};expect(sim.view('b').projectiles?.find(p=>p.id==='warning_probe')?.impactWarning?.radiusMm).toBe(8000);
  });
});


describe('large-site reconnaissance and engineering priority',()=>{
  it('earns current site visibility outside a Grand Citadel, preserves orders and admits an ordinary build',()=>{
    const {sim,home}=fixture(),scout=unit(sim,'scout',27000,17000);scout.stance='defensive';
    for(let i=0;i<12;i++){const worker=unit(sim,'villager',26000+(i%4)*2000,22000+Math.floor(i/4)*2000);worker.stance='defensive';}
    sim.step();const memory=emptyCaretakerMemory(),protectedId=Object.values(sim.state.entities).find(entity=>entity.typeId==='villager')!.id,protectedIds=new Set([protectedId]);let built=false,issuedMoves=0,stableMoves=0;
    for(let tick=0;tick<1800&&!built;tick++){
      if(tick%20===0){const view=sim.view('a'),commands=constructionReconnaissance(view,memory,'grand_citadel',home,{protectedIds});
        if(memory.constructionRecon)expect(memory.constructionRecon.members.every(member=>member.id!==protectedId)).toBe(true);
        for(const command of commands){if(command.kind==='move')issuedMoves++;const result=send(sim,command);expect(result.status,JSON.stringify({command,result})).toBe('accepted');if(command.kind==='build')built=true;}
        if(memory.constructionRecon&&commands.length===0&&memory.constructionRecon.members.some(member=>sim.state.entities[member.id]?.kind==='unit'&&(sim.state.entities[member.id] as Unit).orders[0]?.kind==='move'))stableMoves++;
      }
      sim.step();
    }
    expect(built).toBe(true);expect(issuedMoves).toBeGreaterThan(0);expect(issuedMoves).toBeLessThanOrEqual(16);expect(stableMoves).toBeGreaterThan(0);
    expect(Object.values(sim.state.entities).some(entity=>entity.typeId==='grand_citadel')).toBe(true);
    // Memory remains a strict cold-restorable controller record while releasing.
    sim.state.controllers.a!.constructionRecon=memory.constructionRecon;const saved=exportSimulationSave(sim,identity);expect(validateSimulationSavePayload(sim.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);expect(restoreSimulation(saved,identity).state.controllers.a!.constructionRecon).toEqual(memory.constructionRecon);
  },20000);
  it('buys required engineering before the citadel reserve can block advancement',()=>{
    const {sim}=fixture(),university=building(sim,'university',42000,16000);for(let i=0;i<6;i++)unit(sim,'villager',24000+i*2000,28000);sim.state.economies.a!.age=5;sim.state.economies.a!.technologies=[];sim.state.economies.a!.researchRevision++;
    sim.state.economies.a!.resources=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,technologies.citadel_engineering.cost[resource]*scale])) as ResourceBank;
    // Isolate the construction/research reserve from the separate emergency-food
    // recovery policy: food already covers the next age's actual price.
    sim.state.economies.a!.resources.food=resolveRuleset('legendary_ages_v1',8,'standard').ages.find(age=>age.id===6)!.cost.food*scale;sim.step();const view=sim.view('a');view.tick=10000;
    const memory=emptyCaretakerMemory();caretakerCommands(view,memory,{allowMilitaryProduction:false,targetWorkers:6});const commands=memory.pending.flatMap(batch=>batch.commands);
    expect(commands).toContainEqual({kind:'research',buildingId:university.id,technologyId:'citadel_engineering'});expect(commands.some(command=>command.kind==='build'&&command.buildingType==='grand_citadel')).toBe(false);
  });
});


describe('later-age contact counters and victory eligibility',()=>{
  it.each([['spearman','stone_warden',2800],['knight','worldbreaker_trebuchet',3500]] as const)('eight fully upgraded %s destroy an unescorted %s while continuously in contact', (attackerType,targetType,radius)=>{
    const {sim}=fixture(),target=unit(sim,targetType,50000,50000,'b'),attackers:Unit[]=[],definition=effectiveUnit(attackerType,sim.state.economies.a!.technologies);
    if(targetType==='worldbreaker_trebuchet')target.deploymentState='deployed';
    const targetDefinition=effectiveUnit(targetType,sim.state.economies.b!.technologies);target.hp=target.maxHp=targetDefinition.maxHp;
    for(let i=0;i<8;i++){const angle=i*Math.PI/4,attacker=unit(sim,attackerType,50000+Math.round(Math.cos(angle)*radius),50000+Math.round(Math.sin(angle)*radius));attacker.hp=attacker.maxHp=definition.maxHp;attackers.push(attacker);}
    const original=attackers.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm}));sim.step();expect(send(sim,{kind:'attack_target',unitIds:attackers.map(unit=>unit.id),targetId:target.id,queued:false}).status).toBe('accepted');
    // Real damage, retaliation, cooldowns and death processing. Both forces
    // deliberately start stationary in legal contact, without escort/pathing.
    for(let ticks=0;ticks<2400&&sim.state.entities[target.id];ticks+=10)sim.step(10);
    expect(sim.state.entities[target.id]).toBeUndefined();expect(attackers.some(unit=>sim.state.entities[unit.id])).toBe(true);
    for(const position of original){const survivor=sim.state.entities[position.id];if(survivor)expect({id:survivor.id,xMm:survivor.xMm,zMm:survivor.zMm}).toEqual(position);}
  });
  it('gates Monument admission and the unchanged hold to the selected maximum age',()=>{
    for(const cap of [5,8] as const){const {sim}=fixture(cap,true),worker=unit(sim,'villager',38000,48000);for(const [x,z]of [[35000,48000],[61000,48000],[48000,35000],[48000,61000]])unit(sim,'scout',x!,z!);sim.step();
      const command:GameplayCommand={kind:'build',buildingType:'monument',builderIds:[worker.id],originCell:{x:20,z:20},rotation:0,queued:false};sim.state.economies.a!.age=cap-1 as 4|7;
      expect(send(sim,command).code).toBe('AGE_REQUIRED');sim.state.economies.a!.age=cap;expect(send(sim,command).status).toBe('accepted');
      const monument=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='monument')!;for(let i=0;i<100&&!monument.work;i++)sim.step();monument.work=monument.required-1;sim.step();expect(monument.work).toBe(monument.required);const completed=monument.monumentCompletedTick!;
      sim.state.tick=completed+balance.rules.monumentHoldSeconds*hz-1;sim.state.economies.a!.age=cap-1 as 4|7;sim.step();expect(sim.state.status).toBe('RUNNING');sim.state.economies.a!.age=cap;sim.step();expect(sim.state.result).toMatchObject({winnerTeamId:'a',reason:'monument'});
    }
    const {sim}=fixture(8,true);building(sim,'eternal_citadel',50000,50000);sim.state.tick=balance.rules.monumentHoldSeconds*hz;sim.step();expect(sim.state.status).toBe('RUNNING');
  });
  it('counts garrisoned military for Conquest even after the last town center falls',()=>{
    const {sim,home}=fixture(),fortress=building(sim,'fortress',50000,50000),soldier=unit(sim,'spearman',59000,50000);sim.step();expect(send(sim,{kind:'garrison',unitIds:[soldier.id],targetId:fortress.id,queued:false}).status).toBe('accepted');for(let i=0;i<100&&!soldier.garrisonedIn;i++)sim.step();expect(soldier.garrisonedIn).toBe(fortress.id);home.hp=0;sim.step();expect(sim.state.economies.a!.defeated).toBe(false);expect(sim.state.status).toBe('RUNNING');soldier.hp=0;sim.step();expect(sim.state.result).toMatchObject({winnerTeamId:'b',reason:'conquest'});
  });
});


describe('late siege blocked work, fixed impacts and cold continuation',()=>{
  it('retains a paid blocked Worldbreaker exit and releases its reserved population exactly once after cold load',()=>{
    const {sim}=fixture(),yard=building(sim,'great_siege_yard',40000,40000);building(sim,'rune_forge',70000,40000);building(sim,'house',85000,40000);building(sim,'house',85000,50000);const blockers:Building[]=[];
    for(let p=29000;p<=51000;p+=2000)for(const [x,z]of [[p,29000],[p,51000],[29000,p],[51000,p]])if(!blockers.some(b=>b.xMm===x&&b.zMm===z))blockers.push(building(sim,'stone_wall',x!,z!));
    sim.step();expect(send(sim,{kind:'train',buildingId:yard.id,unitType:'worldbreaker_trebuchet',quantity:1}).status).toBe('accepted');sim.step();const job=yard.queue[0]!;expect(job.reserved).toBe(true);job.work=job.required-1;sim.step();expect(job.state).toBe('exit_blocked');expect(sim.view('a').self.reservedPopulation).toBe(14);expect(send(sim,{kind:'train',buildingId:yard.id,unitType:'worldbreaker_trebuchet',quantity:1}).code).toBe('UNIT_LIMIT');
    expect(validateSimulationSavePayload(sim.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
    for(const world of [sim,cold]){for(const blocker of blockers)world.state.entities[blocker.id]!.hp=0;world.step(2);expect((world.state.entities[yard.id] as Building).queue).toHaveLength(0);expect(world.view('a').self.reservedPopulation).toBe(0);expect(world.view('a').self.population).toBe(14);expect(Object.values(world.state.entities).filter(e=>e.typeId==='worldbreaker_trebuchet')).toHaveLength(1);}
    expect(cold.capture()).toEqual(sim.capture());
  });
  it('lands one Worldbreaker hit per collision shape in the correct band, without allied damage, after cold load',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,50000);engine.deploymentState='deployed';engine.cooldown=10000;
    const citadel=building(sim,'eternal_citadel',80000,50000,'b');citadel.cooldown=10000;citadel.weaponCooldowns=[10000,10000,10000];
    const walls=[53000,55000,58000,60500].map(z=>building(sim,'eternal_wall',68000,z,'b')),ally=unit(sim,'spearman',65000,50000);unit(sim,'scout',68000,63000).cooldown=10000;ally.cooldown=10000;sim.step();
    expect(send(sim,{kind:'attack_ground',unitIds:[engine.id],target:{xMm:68000,zMm:50000},queued:false}).status).toBe('accepted');engine.cooldown=0;sim.step();sim.step(engine.windup!.launchTick-sim.state.tick);const projectile=sim.state.projectiles.find(p=>p.sourceId===engine.id)!;expect(projectile).toBeDefined();
    const before=new Map([citadel,...walls,ally].map(e=>[e.id,e.hp])),cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true}),remaining=projectile.hitTick-sim.state.tick;
    sim.step(remaining);cold.step(remaining);expect(cold.capture()).toEqual(sim.capture());
    for(const [entity,multiplier]of [[citadel,1],[walls[0]!,1],[walls[1]!,.5],[walls[2]!,.25]] as const)expect(before.get(entity.id)!-entity.hp).toBe(damageAmount(projectile.attack,effectiveBuilding(entity.typeId,sim.state.economies.b!.technologies),multiplier));
    expect(walls[3]!.hp).toBe(before.get(walls[3]!.id));expect(ally.hp).toBe(before.get(ally.id));
  });
  it('keeps deployment/packing deadlines through rapid orders and lets observed troops leave a fixed impact',()=>{
    const {sim}=fixture(),engine=unit(sim,'worldbreaker_trebuchet',40000,40000),target=unit(sim,'knight',70000,40000,'b');unit(sim,'scout',70000,44000).cooldown=10000;target.cooldown=10000;sim.step();
    expect(send(sim,{kind:'deploy',unitIds:[engine.id]}).status).toBe('accepted');sim.step(60);expect(engine.deploymentState).toBe('deploying');const cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
    for(const world of [sim,cold]){send(world,{kind:'stop',unitIds:[engine.id]});send(world,{kind:'deploy',unitIds:[engine.id]});world.step(179);expect((world.state.entities[engine.id] as Unit).deploymentState).toBe('deploying');world.step();expect((world.state.entities[engine.id] as Unit).deploymentState).toBe('deployed');}
    expect(cold.capture()).toEqual(sim.capture());send(sim,{kind:'stop',unitIds:[engine.id]});engine.cooldown=0;delete engine.windup;
    expect(send(sim,{kind:'attack_ground',unitIds:[engine.id],target:{xMm:48000,zMm:40000},queued:false}).status).toBe('accepted');sim.step();expect(engine.windup).toBeUndefined();expect(sim.state.projectiles).toHaveLength(0);
    expect(send(sim,{kind:'attack_target',unitIds:[engine.id],targetId:target.id,queued:false}).status).toBe('accepted');for(let i=0;i<800&&!engine.windup;i++)sim.step();expect(engine.windup,JSON.stringify({state:engine.deploymentState,order:engine.orders[0],cooldown:engine.cooldown,x:engine.xMm,z:engine.zMm})).toBeDefined();const deadline=engine.windup!.launchTick;sim.step(deadline-sim.state.tick);const shot=sim.state.projectiles.find(p=>p.sourceId===engine.id)!;expect(shot.aim).toEqual({xMm:70000,zMm:40000});const hp=target.hp;
    expect(send(sim,{kind:'move',unitIds:[target.id],target:{xMm:70000,zMm:65000},queued:false},'b').status).toBe('accepted');sim.step(shot.hitTick-sim.state.tick);expect(target.hp).toBe(hp);expect(target.zMm).toBeGreaterThan(49000);
    const position={xMm:engine.xMm,zMm:engine.zMm};send(sim,{kind:'move',unitIds:[engine.id],target:{xMm:45000,zMm:40000},queued:false});sim.step();expect(engine.deploymentState).toBe('packing');send(sim,{kind:'deploy',unitIds:[engine.id]});sim.step(199);expect(engine.deploymentState).toBe('packing');expect({xMm:engine.xMm,zMm:engine.zMm}).toEqual(position);sim.step();expect(engine.deploymentState).toBe('deploying');
  });
  it('replays ward recharge, active structure completion and mobile passenger evacuation without changed outcomes',()=>{
    const {sim}=fixture(),spire=building(sim,'ward_spire',30000,50000),wall=building(sim,'runestone_wall',35000,50000),worker=unit(sim,'villager',37000,50000),carrier=unit(sim,'crown_colossus',80000,60000),passenger=unit(sim,'spearman',83300,60000);sim.step();
    expect(send(sim,{kind:'upgrade_structure',buildingIds:[wall.id],targetTypeId:'titan_wall'}).status).toBe('accepted');expect(send(sim,{kind:'continue_build',builderIds:[worker.id],foundationId:wall.id,queued:false}).status).toBe('accepted');expect(send(sim,{kind:'garrison',unitIds:[passenger.id],targetId:carrier.id,queued:false}).status).toBe('accepted');sim.step(10);expect(passenger.garrisonedIn).toBe(carrier.id);wall.upgrade!.work=wall.upgrade!.required-100;sim.state.tick=500;wall.ward!.quietSinceTick=0;carrier.hp=0;
    expect(validateSimulationSavePayload(sim.capture()),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);const cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});sim.step(60);cold.step(60);expect(cold.capture()).toEqual(sim.capture());expect(wall.typeId).toBe('titan_wall');expect(wall.ward!.current).toBeGreaterThan(0);expect(sim.state.entities[carrier.id]).toBeUndefined();expect(passenger.garrisonedIn).toBeUndefined();expect(passenger.hp).toBe(passenger.maxHp-Math.ceil(passenger.maxHp*.25));expect(spire.hp).toBeGreaterThan(0);
  });
  it('lets contact siege bypass a charged ward, destroys its support and breaches Eternal defenses through ordinary attacks',()=>{
    const {sim}=fixture(),wall=building(sim,'eternal_wall',70000,50000,'b'),spire=building(sim,'ward_spire',75000,56000,'b'),ram=unit(sim,'colossus_ram',66000,50000),engine=unit(sim,'worldbreaker_trebuchet',42000,52000);engine.deploymentState='deployed';engine.cooldown=10000;ram.cooldown=10000;unit(sim,'scout',68000,60000);sim.step();expect(wall.ward?.supportId).toBe(spire.id);wall.ward!.current=wall.ward!.max;
    const wardBefore=wall.ward!.current,hpBefore=wall.hp;expect(send(sim,{kind:'attack_target',unitIds:[ram.id],targetId:wall.id,queued:false}).status).toBe('accepted');ram.cooldown=0;sim.step();expect(wall.hp).toBeLessThan(hpBefore);expect(wall.ward!.current).toBe(wardBefore);expect(send(sim,{kind:'move',unitIds:[ram.id],target:{xMm:60000,zMm:50000},queued:false}).status).toBe('accepted');
    expect(send(sim,{kind:'attack_target',unitIds:[engine.id],targetId:spire.id,queued:false}).status).toBe('accepted');engine.cooldown=0;for(let i=0;i<900&&sim.state.entities[spire.id];i++)sim.step();expect(sim.state.entities[spire.id]).toBeUndefined();expect(sim.state.entities[wall.id]).toBeDefined();if(sim.state.entities[wall.id]){expect(wall.ward).toBeUndefined();expect(send(sim,{kind:'attack_target',unitIds:[engine.id,ram.id],targetId:wall.id,queued:false}).status).toBe('accepted');for(let i=0;i<1800&&sim.state.entities[wall.id];i++)sim.step();}expect(sim.state.entities[wall.id]).toBeUndefined();expect(sim.state.result).toBeUndefined();
  });
});


it('preserves staggered weapon cooldowns through a real mid-frame citadel upgrade on the native lane',()=>{
  const {sim}=fixture(),citadel=building(sim,'runic_citadel',40000,40000),builder=unit(sim,'villager',50800,40000),target=unit(sim,'stone_warden',70000,40000,'b');target.cooldown=10000;citadel.cooldown=92;citadel.weaponCooldowns=[33,59,91];citadel.hp-=80;sim.step();
  expect(send(sim,{kind:'upgrade_structure',buildingIds:[citadel.id],targetTypeId:'titan_citadel'}).status).toBe('accepted');expect(send(sim,{kind:'continue_build',builderIds:[builder.id],foundationId:citadel.id,queued:false}).status).toBe('accepted');citadel.upgrade!.work=citadel.upgrade!.required-480;
  const before={primary:citadel.cooldown,secondary:[...citadel.weaponCooldowns]},payload=sim.capture(),coarse=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,localPlanningMode:undefined,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload),scalar=new Simulation({...payload.options,authoritativeIntervalMs:50,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload);
  coarse.advanceFrame();scalar.step(6);expect(coarse.state.entities).toEqual(scalar.state.entities);expect(coarse.state.projectiles).toEqual(scalar.state.projectiles);const upgraded=coarse.state.entities[citadel.id] as Building;expect(upgraded.typeId).toBe('titan_citadel');expect(upgraded.maxHp-upgraded.hp).toBe(80);expect(upgraded.cooldown).toBe(before.primary-6);expect(upgraded.weaponCooldowns).toEqual(before.secondary.map(value=>value-6));
});


it('arms upgraded Titan gate ports only on the next legal event with native/scalar agreement',()=>{
  const {sim}=fixture(),gate=building(sim,'runestone_gate',40000,40000),builder=unit(sim,'villager',40000,41800),target=unit(sim,'stone_warden',40000,48000,'b');target.cooldown=10000;sim.step();
  expect(send(sim,{kind:'upgrade_structure',buildingIds:[gate.id],targetTypeId:'titan_gate'}).status).toBe('accepted');expect(send(sim,{kind:'continue_build',builderIds:[builder.id],foundationId:gate.id,queued:false}).status).toBe('accepted');gate.upgrade!.work=gate.upgrade!.required-480;
  const payload=sim.capture(),coarse=createLiveSimulation({...payload.options,authoritativeIntervalMs:300,localPlanningMode:undefined,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload),scalar=new Simulation({...payload.options,authoritativeIntervalMs:50,factions:payload.state.factions,seed:'legendary-mechanics',matchId:payload.state.matchId},payload);
  coarse.advanceFrame();scalar.step(6);expect(coarse.state.entities).toEqual(scalar.state.entities);expect(coarse.state.projectiles).toEqual(scalar.state.projectiles);expect((coarse.state.entities[gate.id] as Building).typeId).toBe('titan_gate');const shots=coarse.state.projectiles.filter(projectile=>projectile.sourceId===gate.id);expect(shots).toHaveLength(2);expect(shots.every(projectile=>projectile.launchTick===payload.state.tick+4)).toBe(true);
});

it('lets an AI Pilot owner cancel a paid Legendary foundation and protects its site',()=>{
  const {sim}=fixture(),worker=unit(sim,'villager',40000,34000);unit(sim,'scout',40000,32000);building(sim,'rune_forge',60000,60000);
  sim.configureAssistant('a',{modelId:'host',enabled:true,reserve:{food:0,wood:0,gold:0,stone:0}});sim.step();
  const before={...sim.state.economies.a!.resources},command:GameplayCommand={kind:'build',buildingType:'ward_spire',originCell:{x:19,z:19},rotation:0,builderIds:[worker.id],queued:false};
  const built=send(sim,command);expect(built.status,JSON.stringify(built)).toBe('accepted');const foundation=Object.values(sim.state.entities).find(entity=>entity.typeId==='ward_spire') as Building;expect(foundation).toBeDefined();
  expect(send(sim,{kind:'cancel_foundation',foundationId:foundation.id}).status).toBe('accepted');expect(sim.state.entities[foundation.id]).toBeUndefined();
  for(const resource of balance.resourceOrder)expect(sim.state.economies.a!.resources[resource]).toBe(before[resource]-buildings.ward_spire.cost[resource]*scale+Math.floor(buildings.ward_spire.cost[resource]*balance.rules.unfinishedCancelRefundFraction)*scale);
  expect(sim.state.control.a!.assistant!.cancelledSites).toContainEqual({xMm:38000,zMm:38000,expiresTick:sim.state.tick+balance.ai.goalTtlSeconds*hz});expect(sim.state.control.a!.assistant!.protectedEntityIds).toContain(worker.id);
});
