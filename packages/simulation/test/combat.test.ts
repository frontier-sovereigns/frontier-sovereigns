import { describe, expect, it } from 'vitest';
import { balance, buildings, units, type BuildingId, type GameplayCommand, type UnitId } from '@frontier/shared';
import { createSimulation, type Building, type Simulation, type Unit } from '../src/index.js';
import { attackSnapshot, damageAmount, advanceCombat, NativeCombatTimeline, type CombatContext } from '../src/combat.js';
import type { SimulationState } from '../src/state.js';

function fixture(monumentVictory=false,withAlly=false){
  const sim=createSimulation({seed:'m3-combat-fixture',matchId:'combat',controllers:false,monumentVictory,factions:[{id:'blue',name:'Blue',teamId:'blue',color:'#3388ff',kind:'human'},{id:'red',name:'Red',teamId:'red',color:'#ff7733',kind:'human'},...(withAlly?[{id:'green',name:'Green',teamId:'blue',color:'#33aa66',kind:'human' as const}]:[])]});
  for(const entity of Object.values(sim.state.entities))if(entity.xMm<110000&&entity.zMm>45000&&entity.zMm<110000)delete sim.state.entities[entity.id];sim.state.navigationRevision++;return sim;
}
function unit(sim:Simulation,typeId:UnitId,owner='blue',x=45000,z=60000):Unit{
  const template=Object.values(sim.state.entities).find((e):e is Unit=>e.kind==='unit'&&e.ownerId===owner)!,def=units[typeId];
  const result:Unit={...structuredClone(template),id:`fixture_unit_${Object.keys(sim.state.entities).length}`,typeId,ownerId:owner,xMm:x,zMm:z,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],cooldown:0,stance:'stand_ground',cargo:{resource:null,amount:0},orderRevision:0,...(typeId==='trebuchet'?{deploymentState:'packed' as const}:{})};sim.state.entities[result.id]=result;return result;
}
function building(sim:Simulation,typeId:BuildingId='town_center',owner='blue',x=50000,z=60000):Building{
  const def=buildings[typeId],result:Building={id:`fixture_building_${Object.keys(sim.state.entities).length}`,kind:'building',ownerId:owner,typeId,xMm:x,zMm:z,hp:def.maxHp,maxHp:def.maxHp,rotation:0,work:def.buildSeconds*2000,required:def.buildSeconds*2000,grantedHp:def.maxHp,queue:[],cooldown:0};sim.state.entities[result.id]=result;sim.state.navigationRevision++;return result;
}
function send(sim:Simulation,command:GameplayCommand,owner='blue'){const sequence=sim.state.economies[owner]!.lastClientSequence+1;return sim.command(owner,{protocolVersion:2,matchId:'combat',matchEpoch:sim.state.matchEpoch,clientCommandId:`${owner}_${sequence}`,clientSequence:sequence,command});}
const hp=(sim:Simulation,id:string)=>sim.state.entities[id]?.hp??0;
/** The worksite was scouted earlier. Current enemy visibility stays untouched. */
function discoverWorksite(sim:Simulation,owner='blue'):void {
  const cells=new Set(sim.state.vision[owner]!.explored),grid=balance.rules.fogGridM*1000,width=sim.state.widthMm/grid;
  for(let z=48000;z<=85000;z+=grid)for(let x=40000;x<=75000;x+=grid)cells.add(Math.floor(z/grid)*width+Math.floor(x/grid));
  sim.state.vision[owner]!.explored=[...cells].sort((a,b)=>a-b);
}

describe('M3 deterministic damage and projectiles',()=>{
  it('does not damage or arm a pending blueprint through arrows or area impact',()=>{
    const make=(id:string,xMm:number):Building=>({id,kind:'building',typeId:'watchtower',ownerId:'red',xMm,zMm:10000,rotation:0,hp:100,maxHp:700,work:0,required:100,grantedHp:100,cooldown:0,queue:[]});
    const site=make('planned',10000),physical=make('physical',12000);site.pendingConstruction={clearanceMm:0};
    const common={ownerId:'blue',sourceId:'shooter',from:{xMm:1000,zMm:10000},aim:{xMm:10000,zMm:10000},launchTick:0,hitTick:1,attack:attackSnapshot(units.catapult)};
    const state={tick:1,factions:[{id:'red',teamId:'red'}],economies:{red:{defeated:false}},entities:{planned:site,physical},projectiles:[{...common,id:'arrow',kind:'arrow',targetId:site.id},{...common,id:'stone',kind:'stone',bands:[{radiusM:4,multiplier:1}]}]} as unknown as SimulationState;
    const effects:string[]=[],actions:string[]=[];
    const context:CombatContext={state,id:()=>'',hostile:(a,b)=>a!==b,visible:()=>true,complete:()=>false,distance:()=>0,pointDistance:(a,b)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm),meleeClear:()=>true,effect:(_kind,point)=>effects.push(`${point.xMm},${point.zMm}`),action:entity=>actions.push(entity.id),definition:entity=>buildings[entity.typeId]};
    advanceCombat(context);expect(site.hp).toBe(100);expect(physical.hp).toBeLessThan(100);expect(actions).toEqual([]);expect(state.projectiles).toEqual([]);
  });
  it('retains native combat deadlines beyond the former 16384 actor boundary',()=>{
    const actors:Building[]=Array.from({length:16385},(_,index)=>({id:`house_${index}`,kind:'building',typeId:'house',ownerId:'blue',xMm:1000,zMm:1000,rotation:0,hp:100,maxHp:900,work:1,required:1,grantedHp:100,cooldown:2,queue:[]}));
    const state={tick:0,factions:[{id:'blue',teamId:'blue'}],economies:{blue:{defeated:false}},projectiles:[]} as unknown as SimulationState;
    const timeline=NativeCombatTimeline.create(state,actors,0,6);expect(timeline).toBeDefined();
    expect(timeline!.attackers(actors,1)).toHaveLength(0);expect(timeline!.attackers(actors,2)).toHaveLength(actors.length);
  });
  it('rejects own and same-team building attacks atomically and never deals allied melee damage',()=>{
    const sim=fixture(false,true),soldier=unit(sim,'militia'),own=building(sim,'house','blue',48000),allied=building(sim,'house','green',48000,66000);sim.step();
    const before={orders:structuredClone(soldier.orders),path:structuredClone(soldier.path),revision:soldier.orderRevision,bank:structuredClone(sim.state.economies.blue!.resources)};
    for(const target of [own,allied])expect(send(sim,{kind:'attack_target',unitIds:[soldier.id],targetId:target.id,queued:false})).toMatchObject({status:'rejected',code:'INVALID_TARGET'});
    expect({orders:soldier.orders,path:soldier.path,revision:soldier.orderRevision,bank:sim.state.economies.blue!.resources}).toEqual(before);
    sim.step(80);expect(own.hp).toBe(own.maxHp);expect(allied.hp).toBe(allied.maxHp);expect(soldier.hp).toBe(soldier.maxHp);expect(sim.state.projectiles.some(p=>p.sourceId===soldier.id)).toBe(false);
  });
  it.each(['unit','building'] as const)('does not damage a newly allied %s with an already launched arrow',kind=>{
    const sim=fixture(false,true),archer=unit(sim,'archer'),target=kind==='unit'?unit(sim,'knight','red',50000):building(sim,'house','red',50000);target.cooldown=10000;
    sim.step();const projectile=sim.state.projectiles.find(p=>p.sourceId===archer.id&&p.kind==='arrow');expect(projectile).toBeDefined();const health=target.hp;
    // Fixture-only affiliation change isolates impact-time friendship. Normal
    // locked-team commands cannot perform this change after a legal launch.
    target.ownerId='green';sim.step(projectile!.hitTick-sim.state.tick);expect(target.hp).toBe(health);expect(sim.state.projectiles.some(p=>p.id===projectile!.id)).toBe(false);
  });
  it('preserves allied building HP when a legal siege ground shot hits nearby hostile buildings',()=>{
    const sim=fixture(false,true),catapult=unit(sim,'catapult','blue',45000,64000),allied=building(sim,'house','green',52000,60000),enemy=building(sim,'house','red',52000,68000);
    catapult.cooldown=10000;sim.step();expect(send(sim,{kind:'attack_ground',unitIds:[catapult.id],target:{xMm:52000,zMm:64000},queued:false}).status).toBe('accepted');catapult.cooldown=0;sim.step();const shot=sim.state.projectiles.find(p=>p.kind==='stone'&&p.sourceId===catapult.id)!;expect(shot).toBeDefined();expect(shot.aim).toEqual({xMm:52000,zMm:64000});const before=enemy.hp;
    sim.step(shot.hitTick-sim.state.tick);expect(allied.hp).toBe(allied.maxHp);expect(enemy.hp).toBeLessThan(before);
  });
  it('uses named class bonuses and matching armor, with minimum one damage',()=>{
    expect(damageAmount(attackSnapshot(units.spearman),units.knight)).toBe(18);
    expect(damageAmount(attackSnapshot(units.skirmisher),units.archer)).toBe(8);
    expect(damageAmount(attackSnapshot(units.battering_ram),buildings.town_center)).toBe(115);
    expect(damageAmount(attackSnapshot(units.villager),buildings.fortress)).toBe(1);
  });
  it('enforces the exact spear cooldown and applies simultaneous lethal exchanges',()=>{
    const sim=fixture(),spear=unit(sim,'spearman'),knight=unit(sim,'knight','red',47500);knight.cooldown=10000;sim.step();
    expect(knight.hp).toBe(knight.maxHp-18);sim.step(35);expect(knight.hp).toBe(knight.maxHp-18);sim.step();expect(knight.hp).toBe(knight.maxHp-36);
    const a=unit(sim,'militia','blue',60000),b=unit(sim,'militia','red',61500);a.hp=b.hp=6;sim.step();expect(sim.state.entities[a.id]).toBeUndefined();expect(sim.state.entities[b.id]).toBeUndefined();expect(spear.hp).toBe(spear.maxHp);
  });
  it('keeps a legally launched arrow target-locked without revealing hidden movement',()=>{
    const sim=fixture(),archer=unit(sim,'archer'),victim=unit(sim,'knight','red',50000);victim.cooldown=10000;sim.step();
    expect(sim.state.projectiles).toHaveLength(1);const projectile=sim.state.projectiles[0]!,aim={...projectile.aim};
    victim.xMm=80000;victim.zMm=80000;sim.step();expect(sim.view('blue').entities.some(e=>e.id===victim.id)).toBe(false);expect(projectile.aim).toEqual(aim);
    for(const viewProjectile of sim.view('blue').projectiles??[]){expect(viewProjectile).not.toHaveProperty('targetId');expect(viewProjectile).not.toHaveProperty('aim');expect(viewProjectile).not.toHaveProperty('sourceId');}
    sim.step(projectile.hitTick-sim.state.tick);expect(victim.hp).toBe(victim.maxHp-2);expect(sim.view('blue').effects?.some(effect=>effect.xMm===victim.xMm&&effect.zMm===victim.zMm)).toBe(false);expect(archer.hp).toBe(archer.maxHp);
  });
  it('does not redirect an arrow when its target dies before arrival',()=>{
    const sim=fixture(),archer=unit(sim,'archer'),target=unit(sim,'knight','red',50000),nearby=unit(sim,'knight','red',52000);target.cooldown=nearby.cooldown=10000;sim.step();const hitTick=sim.state.projectiles[0]!.hitTick;target.hp=0;sim.step(hitTick-sim.state.tick);expect(nearby.hp).toBe(nearby.maxHp);expect(sim.state.projectiles.every(p=>p.kind!=='arrow'||p.targetId!==target.id)).toBe(true);expect(archer.cooldown).toBeGreaterThan(0);
  });
  it('keeps identical visible arrow flight when an unseen target dies before impact',()=>{
    const create=(dies:boolean)=>{const sim=fixture();unit(sim,'archer');const target=unit(sim,'knight','red',50000);target.cooldown=10000;sim.step();target.xMm=80000;target.zMm=80000;if(dies)target.hp=0;return sim;};
    const living=create(false),dead=create(true),hitTick=living.state.projectiles[0]!.hitTick;
    while(living.state.tick<hitTick){living.step();dead.step();expect(dead.view('blue').projectiles).toEqual(living.view('blue').projectiles);}
    expect(dead.state.projectiles).toHaveLength(0);
  });
  it('lands catapult damage at the impact point with full/half bands and no friendly fire',()=>{
    const sim=fixture(),catapult=unit(sim,'catapult'),full=unit(sim,'knight','red',52000),half=unit(sim,'knight','red',53500),outside=unit(sim,'knight','red',54500),friendly=unit(sim,'militia','blue',52000,60750);for(const e of [full,half,outside,friendly])e.cooldown=10000;
    sim.step();expect(send(sim,{kind:'attack_ground',unitIds:[catapult.id],target:{xMm:52000,zMm:60000},queued:false}).status).toBe('accepted');sim.step();const stone=sim.state.projectiles.find(p=>p.kind==='stone')!;
    const before={full:full.hp,half:half.hp,outside:outside.hp,friendly:friendly.hp};sim.step(stone.hitTick-sim.state.tick);
    expect(full.hp).toBe(before.full-40);expect(half.hp).toBe(before.half-20);expect(outside.hp).toBe(before.outside);expect(friendly.hp).toBe(before.friendly);
  });
  it('requires explored ground and minimum range before siege can launch',()=>{
    const sim=fixture(),catapult=unit(sim,'catapult'),enemy=unit(sim,'knight','red',47000);enemy.cooldown=10000;sim.step();expect(sim.state.projectiles).toHaveLength(0);
    expect(send(sim,{kind:'attack_ground',unitIds:[catapult.id],target:{xMm:10000,zMm:10000},queued:false}).code).toBe('TARGET_UNEXPLORED');
    expect(send(sim,{kind:'attack_ground',unitIds:[catapult.id],target:{xMm:47000,zMm:60000},queued:false}).status).toBe('accepted');sim.step();expect(sim.state.projectiles).toHaveLength(0);
  });
  it('retains a physical deployment/packing transition across stop and changed orders',()=>{
    const sim=fixture(),trebuchet=unit(sim,'trebuchet');sim.step();expect(send(sim,{kind:'deploy',unitIds:[trebuchet.id]}).status).toBe('accepted');sim.step(40);expect(trebuchet.deploymentState).toBe('deploying');
    send(sim,{kind:'stop',unitIds:[trebuchet.id]});sim.step(39);expect(trebuchet.deploymentState).toBe('deploying');sim.step();expect(trebuchet.deploymentState).toBe('deployed');
    send(sim,{kind:'move',unitIds:[trebuchet.id],target:{xMm:50000,zMm:60000},queued:false});sim.step();expect(trebuchet.deploymentState).toBe('packing');const position={x:trebuchet.xMm,z:trebuchet.zMm};
    send(sim,{kind:'deploy',unitIds:[trebuchet.id]});sim.step(59);expect(trebuchet.deploymentState).toBe('packing');expect({x:trebuchet.xMm,z:trebuchet.zMm}).toEqual(position);sim.step();expect(trebuchet.deploymentState).toBe('deploying');sim.step(79);expect(trebuchet.deploymentState).toBe('deploying');sim.step();expect(trebuchet.deploymentState).toBe('deployed');
  });
  it('fires a deployed trebuchet at an impact location with its building bonus',()=>{
    const sim=fixture(),trebuchet=unit(sim,'trebuchet'),target=building(sim,'house','red',58000);sim.step();send(sim,{kind:'deploy',unitIds:[trebuchet.id]});sim.step(80);expect(trebuchet.deploymentState).toBe('deployed');
    expect(send(sim,{kind:'attack_target',unitIds:[trebuchet.id],targetId:target.id,queued:false}).status).toBe('accepted');sim.step();const stone=sim.state.projectiles.find(p=>p.kind==='stone')!;expect(stone).toBeDefined();sim.step(stone.hitTick-sim.state.tick);expect(target.hp).toBe(target.maxHp-200);
  });
  it('does not report hidden ground-attack victims or reveal old effects on later exploration',()=>{
    const sim=fixture(),catapult=unit(sim,'catapult'),observer=unit(sim,'scout','blue',52000,66000),victim=unit(sim,'villager','red',52000);victim.cooldown=10000;
    sim.state.map.terrain.push({id:'combat_cliff',kind:'cliff',xMm:48000,zMm:50000,widthMm:1000,depthMm:20000,elevationMm:3000});sim.state.navigationRevision++;sim.step();
    expect(sim.view('blue').entities.some(e=>e.id===victim.id)).toBe(true);observer.xMm=35000;observer.zMm=85000;sim.step();expect(sim.view('blue').entities.some(e=>e.id===victim.id)).toBe(false);
    expect(send(sim,{kind:'attack_ground',unitIds:[catapult.id],target:{xMm:52000,zMm:60000},queued:false}).status).toBe('accepted');sim.step();const stone=sim.state.projectiles.find(p=>p.kind==='stone')!;expect(stone).toBeDefined();sim.step(stone.hitTick-sim.state.tick);
    expect(sim.state.entities[victim.id]).toBeUndefined();expect(sim.view('blue').effects?.some(e=>e.xMm===52000&&e.zMm===60000)).toBe(false);expect(sim.view('blue')).not.toHaveProperty('statistics');
    observer.xMm=52000;observer.zMm=66000;sim.step();expect(sim.view('blue').effects?.some(e=>e.xMm===52000&&e.zMm===60000)).toBe(false);
  });
});

describe('M3 orders and garrisons',()=>{
  it('automatically pursues and attacks a nearby observed enemy in default defensive military stance',()=>{
    const sim=fixture(),soldier=unit(sim,'militia'),enemy=unit(sim,'villager','red',56000),observer=unit(sim,'scout','blue',56000,65000);soldier.stance='defensive';enemy.cooldown=observer.cooldown=10000;
    sim.step(2);expect(sim.view('blue').entities.some(entity=>entity.id===enemy.id&&!entity.ghost)).toBe(true);expect(soldier.engagement?.targetId).toBe(enemy.id);expect(soldier.orders).toEqual([]);
    sim.step(160);expect(soldier.xMm).toBeGreaterThan(45000);expect(hp(sim,enemy.id)).toBeLessThan(enemy.maxHp);
  });
  it('does not acquire a nearby enemy hidden behind a cliff in default defensive military stance',()=>{
    const sim=fixture(),soldier=unit(sim,'militia'),enemy=unit(sim,'villager','red',52000);soldier.stance='defensive';enemy.cooldown=10000;
    // Terrain rectangles use the north-west corner, not a centered footprint.
    sim.state.map.terrain.push({id:'acquisition_cliff',kind:'cliff',xMm:48000,zMm:50000,widthMm:1000,depthMm:20000,elevationMm:3000});sim.state.navigationRevision++;sim.step(20);
    expect(sim.view('blue').entities.some(entity=>entity.id===enemy.id)).toBe(false);expect(soldier.engagement).toBeUndefined();expect(soldier.xMm).toBe(45000);expect(enemy.hp).toBe(enemy.maxHp);
  });
  it('resumes an attack-move destination after fighting without consuming queued commands',()=>{
    const sim=fixture(),soldier=unit(sim,'militia'),enemy=unit(sim,'villager','red',48000);soldier.stance='defensive';enemy.hp=3;enemy.cooldown=10000;sim.step();
    send(sim,{kind:'attack_move',unitIds:[soldier.id],target:{xMm:55000,zMm:60000},queued:false});send(sim,{kind:'move',unitIds:[soldier.id],target:{xMm:57000,zMm:60000},queued:true});sim.step(160);
    expect(sim.state.entities[enemy.id]).toBeUndefined();expect(soldier.xMm).toBeGreaterThan(50000);sim.step(180);expect(soldier.orders).toHaveLength(0);expect(Math.abs(soldier.xMm-57000)).toBeLessThanOrEqual(100);
  });
  it('patrols repeatedly and keeps stand-ground units from chasing out-of-range enemies',()=>{
    const sim=fixture(),guard=unit(sim,'militia'),enemy=unit(sim,'villager','red',52000);enemy.cooldown=10000;sim.step(40);expect(guard.xMm).toBe(45000);
    send(sim,{kind:'patrol',unitIds:[guard.id],points:[{xMm:45000,zMm:65000},{xMm:45000,zMm:70000}],queued:false});sim.step(150);expect(guard.orders[0]?.kind).toBe('patrol');expect(guard.zMm).toBeGreaterThan(60000);send(sim,{kind:'stop',unitIds:[guard.id]});const stopped={x:guard.xMm,z:guard.zMm};sim.step(30);expect({x:guard.xMm,z:guard.zMm}).toEqual(stopped);
  });
  it('garrisons only eligible owned units, heals at one HP/second, and hides occupants',()=>{
    const sim=fixture(),town=building(sim),worker=unit(sim,'villager','blue',43000),ram=unit(sim,'battering_ram','blue',42000,63000),enemy=unit(sim,'scout','red',62000);enemy.cooldown=10000;worker.hp=20;sim.step();
    expect(send(sim,{kind:'garrison',unitIds:[worker.id,ram.id],targetId:town.id,queued:false}).code).toBe('INVALID_TARGET');expect(worker.orders).toHaveLength(0);
    expect(send(sim,{kind:'garrison',unitIds:[worker.id],targetId:town.id,queued:false}).status).toBe('accepted');sim.step();expect(worker.garrisonedIn).toBe(town.id);expect(town.garrisoned).toEqual([worker.id]);const health=worker.hp;sim.step(19);expect(worker.hp).toBe(health);sim.step();expect(worker.hp).toBe(health+1);
    expect(sim.view('blue').entities.find(e=>e.id===worker.id)?.garrisonedIn).toBe(town.id);expect(sim.view('red').entities.some(e=>e.id===worker.id)).toBe(false);expect(send(sim,{kind:'attack_target',unitIds:[enemy.id],targetId:worker.id,queued:false},'red').code).toBe('INVALID_REFERENCE');
  });
  it('ejects surviving occupants on destruction with exact quarter-max-HP damage',()=>{
    const sim=fixture(),town=building(sim),worker=unit(sim,'villager','blue',43000);sim.step();send(sim,{kind:'garrison',unitIds:[worker.id],targetId:town.id,queued:false});sim.step();town.hp=0;sim.step();
    expect(worker.garrisonedIn).toBeUndefined();expect(worker.hp).toBe(35-Math.ceil(35*.25));expect(sim.state.entities[worker.id]).toBeDefined();expect(Math.abs(worker.xMm-town.xMm)>6000||Math.abs(worker.zMm-town.zMm)>6000).toBe(true);
  });
  it('does not let an occupant killed by ejection damage block the only exit for the next survivor',()=>{
    const sim=fixture(),town=building(sim),first=unit(sim,'villager','blue',43000),second=unit(sim,'villager','blue',43000,61000);sim.step();
    send(sim,{kind:'garrison',unitIds:[first.id,second.id],targetId:town.id,queued:false});sim.step();expect(town.garrisoned).toEqual([first.id,second.id]);first.hp=1;
    const exits:{x:number;z:number}[]=[];for(let offset=-6000;offset<=6000;offset+=1000)exits.push({x:town.xMm+offset,z:town.zMm+6850},{x:town.xMm+offset,z:town.zMm-6850});for(let offset=-6000;offset<=6000;offset+=1000)exits.push({x:town.xMm+6850,z:town.zMm+offset},{x:town.xMm-6850,z:town.zMm+offset});
    for(const point of exits.slice(1))unit(sim,'villager','blue',point.x,point.z);town.hp=0;sim.step();
    expect(sim.state.entities[first.id]).toBeUndefined();expect(sim.state.entities[second.id]).toBeDefined();expect(second.garrisonedIn).toBeUndefined();expect(second.hp).toBe(26);expect({x:second.xMm,z:second.zMm}).toEqual(exits[0]);
  });
  it('keeps gate policy private while showing the physical open state',()=>{
    const sim=fixture(),gate=building(sim,'wooden_gate','red',50000),observer=unit(sim,'scout','blue',45000);gate.gateMode='LOCKED';gate.gateOpen=false;sim.step();
    expect(sim.view('blue').entities.find(e=>e.id===gate.id)).toMatchObject({gateOpen:false});expect(sim.view('blue').entities.find(e=>e.id===gate.id)).not.toHaveProperty('gateMode');expect(sim.view('red').entities.find(e=>e.id===gate.id)?.gateMode).toBe('LOCKED');expect(observer.hp).toBe(observer.maxHp);
  });
  it('bases foundation work-slot planning on observed units only',()=>{
    const create=(hiddenBlocker:boolean)=>{const sim=fixture(),worker=unit(sim,'villager','blue',50000,76000);unit(sim,'villager','blue',50000,53000);const enemy=hiddenBlocker?unit(sim,'villager','red',50000,62850):undefined;sim.step();discoverWorksite(sim);return {sim,worker,enemy};};
    const a=create(false),b=create(true);expect(b.sim.view('blue').entities.some(e=>e.ownerId==='red')).toBe(false);
    const journey=(worker:Unit)=>({x:worker.xMm,z:worker.zMm,path:worker.path,goal:worker.approachGoal});
    expect(b.sim.view('blue')).toEqual(a.sim.view('blue'));expect(journey(b.worker)).toEqual(journey(a.worker));
    for(const {sim,worker} of [a,b])expect(send(sim,{kind:'build',buildingType:'house',builderIds:[worker.id],originCell:{x:24,z:29},rotation:0,queued:false}).status).toBe('accepted');
    expect(b.sim.view('blue')).toEqual(a.sim.view('blue'));expect(b.sim.view('blue').entities.some(e=>e.id===b.enemy!.id)).toBe(false);
    // An explored-fog blueprint supplies no vision. Its builder must physically
    // approach before the hidden unit can influence the selected work slot.
    a.sim.step();b.sim.step();expect(journey(b.worker)).toEqual(journey(a.worker));
    const hiddenChoice={...b.worker.approachGoal!.point!};expect(hiddenChoice).toEqual({xMm:b.enemy!.xMm,zMm:b.enemy!.zMm});
    expect(b.sim.view('blue').entities.some(e=>e.id===b.enemy!.id)).toBe(false);
    expect(b.sim.view('blue').entities.some(e=>e.typeId==='house'&&e.pendingConstruction)).toBe(true);
    for(let tick=0;tick<200&&!b.sim.view('blue').entities.some(e=>e.id===b.enemy!.id);tick++){
      a.sim.step();b.sim.step();expect(journey(b.worker)).toEqual(journey(a.worker));
      if(!b.sim.view('blue').entities.some(e=>e.id===b.enemy!.id))expect(b.sim.view('blue')).toEqual(a.sim.view('blue'));
    }
    expect(b.sim.view('blue').entities.some(e=>e.id===b.enemy!.id)).toBe(true);
    a.sim.step();b.sim.step();expect(a.worker.approachGoal!.point).toEqual(hiddenChoice);expect(b.worker.approachGoal!.point).not.toEqual(hiddenChoice);expect(b.worker.path).toEqual([]);
    const radius=units.villager.collisionRadiusM*1000,arrival=b.worker.approachGoal!.point!;
    expect(Math.hypot(arrival.xMm-b.enemy!.xMm,arrival.zMm-b.enemy!.zMm)).toBeGreaterThanOrEqual(radius*2);
    for(let tick=0;tick<10;tick++){b.sim.step();expect(Math.hypot(b.worker.xMm-b.enemy!.xMm,b.worker.zMm-b.enemy!.zMm)).toBeGreaterThanOrEqual(radius*2);}
    expect(b.worker.path.at(-1)).toEqual(arrival);expect(b.worker.zMm).toBeLessThan(76000);
  });
  it('authorizes partial circular visibility without exposing a bounding-box-only corner',()=>{
    const create=(hiddenX:number,hiddenZ:number)=>{const sim=fixture(),observer=unit(sim,'villager'),partial=unit(sim,'villager','red',54200,64200),hidden=unit(sim,'villager','red',hiddenX,hiddenZ);sim.step();return {sim,observer,partial,hidden};};
    const a=create(54300,64300),b=create(56500,66500),view=a.sim.view('blue'),width=view.map.widthMm/view.map.fogCellMm;
    expect(view.fog.visible).not.toContain(Math.floor(a.partial.zMm/2000)*width+Math.floor(a.partial.xMm/2000));expect(view.entities.some(e=>e.id===a.partial.id)).toBe(true);expect(view.entities.some(e=>e.id===a.hidden.id)).toBe(false);expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));
    expect(send(a.sim,{kind:'attack_target',unitIds:[a.observer.id],targetId:a.partial.id,queued:false}).status).toBe('accepted');expect(send(a.sim,{kind:'attack_target',unitIds:[a.observer.id],targetId:a.hidden.id,queued:false}).code).toBe('INVALID_REFERENCE');
  });
  it('allows a foundation beside an unseen bounding-box corner but rejects a visible circle overlap',()=>{
    for(const [coordinate,expected]of [[54300,'accepted'],[54200,'rejected']] as const){const sim=fixture(),worker=unit(sim,'villager'),enemy=unit(sim,'villager','red',coordinate,coordinate+10000);sim.step();discoverWorksite(sim);expect(sim.view('blue').entities.some(e=>e.id===enemy.id)).toBe(expected==='rejected');const receipt=send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:25,z:30},rotation:0,queued:false});expect(receipt.status).toBe(expected);if(expected==='rejected')expect(receipt.code).toBe('PLACEMENT_BLOCKED');}
  });
  it('reveals an observed resource footprint while retaining hidden quantities in last-seen memory',()=>{
    const create=()=>{const sim=fixture(),worker=unit(sim,'villager'),observer=unit(sim,'scout','blue',55000,67000);for(const [id,coordinate]of [['partial_resource',54300],['hidden_resource',54500]] as const)sim.state.entities[id]={id,kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:1000000,xMm:coordinate,zMm:coordinate+10000,hp:1,maxHp:1};sim.state.navigationRevision++;sim.step();observer.xMm=35000;observer.zMm=90000;sim.step();return {sim,worker};};
    const a=create(),b=create(),partial=a.sim.state.entities.partial_resource!,view=a.sim.view('blue');expect(view.fog.visible).not.toContain(Math.floor(partial.zMm/2000)*(view.map.widthMm/2000)+Math.floor(partial.xMm/2000));expect(view.entities.find(e=>e.id===partial.id)?.ghost).toBeUndefined();expect(view.entities.find(e=>e.id==='hidden_resource')).toMatchObject({ghost:true,amount:1000});const hidden=b.sim.state.entities.hidden_resource!;if(hidden.kind==='resource')hidden.amount=0;b.sim.state.navigationRevision++;
    a.sim.step();b.sim.step();expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));expect(send(a.sim,{kind:'build',builderIds:[a.worker.id],buildingType:'house',originCell:{x:25,z:30},rotation:0,queued:false}).code).toBe('PLACEMENT_BLOCKED');
  });
  it('does not use an unseen enclosure when automatically selecting the next known resource',()=>{
    const create=(enclosed:boolean)=>{
      const sim=fixture(),worker=unit(sim,'villager'),observer=unit(sim,'scout','blue',65000,63000);
      for(const [id,x,z] of [['depleted',46200,60000],['next',65000,60000],['alternate',69000,65000]] as const)sim.state.entities[id]={id,kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:1000000,xMm:x,zMm:z,hp:1,maxHp:1};sim.state.navigationRevision++;sim.step();observer.xMm=35000;observer.zMm=90000;sim.step();send(sim,{kind:'gather',unitIds:[worker.id],targetId:'depleted',queued:false});
      if(enclosed)for(let offset=-2000;offset<=2000;offset+=2000){building(sim,'palisade_wall','red',65000+offset,58000);building(sim,'palisade_wall','red',65000+offset,62000);building(sim,'palisade_wall','red',63000,60000+offset);building(sim,'palisade_wall','red',67000,60000+offset);}
      const source=sim.state.entities.depleted!;if(source.kind==='resource')source.amount=0;sim.state.navigationRevision++;return {sim,worker};
    };
    const a=create(false),b=create(true);
    // Automatic successor proof is incremental. Both knowledge-equivalent worlds
    // must make the same bounded decision before the unseen enclosure is reached.
    for(let tick=0;tick<200&&a.worker.orders[0]?.targetId!=='next';tick++){
      a.sim.step();b.sim.step();expect(a.worker.orders).toEqual(b.worker.orders);expect({x:a.worker.xMm,z:a.worker.zMm,path:a.worker.path}).toEqual({x:b.worker.xMm,z:b.worker.zMm,path:b.worker.path});expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));expect(a.sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);expect(b.sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);
    }
    expect(a.worker.orders[0]?.targetId).toBe('next');expect(b.worker.orders[0]?.targetId).toBe('next');
    for(let tick=0;tick<10;tick++){a.sim.step();b.sim.step();expect(a.worker.orders[0]?.targetId).toBe('next');expect(b.worker.orders[0]?.targetId).toBe('next');expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));}
  });
  it('bounds preflight work per faction and tick without charging a rejected command',()=>{
    const sim=fixture(),worker=unit(sim,'villager'),other=unit(sim,'villager','red',65000),farm=building(sim,'farm','blue',55000,75000);sim.step();discoverWorksite(sim);discoverWorksite(sim,'red');sim.state.pathAdmission={blue:{tick:sim.state.tick,remaining:0,used:50000}};
    const before=structuredClone(sim.state.economies.blue!.resources),count=Object.keys(sim.state.entities).length;
    expect(send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:24,z:29},rotation:0,queued:false}).code).toBe('PATH_BUSY');expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'palisade',cells:[{x:24,z:30}],queued:false}).code).toBe('PATH_BUSY');expect(send(sim,{kind:'reseed_farm',builderId:worker.id,farmId:farm.id}).code).toBe('PATH_BUSY');expect(farm.reseedRequired).toBeUndefined();expect(sim.state.economies.blue!.resources).toEqual(before);expect(Object.keys(sim.state.entities)).toHaveLength(count);
    expect(send(sim,{kind:'build',builderIds:[other.id],buildingType:'house',originCell:{x:34,z:29},rotation:0,queued:false},'red').status).toBe('accepted');expect(sim.serializeState().pathAdmission?.blue).toMatchObject({remaining:0,used:50000});sim.step();expect(send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:24,z:29},rotation:0,queued:false}).status).toBe('accepted');expect(sim.state.pathAdmission.blue!.used).toBeGreaterThan(0);
  });
  it('defers automatic resource retargeting safely when its faction exhausts the current allowance',()=>{
    const sim=fixture(),worker=unit(sim,'villager');for(const [id,x]of [['source',46200],['successor',50000]] as const)sim.state.entities[id]={id,kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:1000000,xMm:x,zMm:60000,hp:1,maxHp:1};sim.state.navigationRevision++;sim.step();send(sim,{kind:'gather',unitIds:[worker.id],targetId:'source',queued:false});const source=sim.state.entities.source!;if(source.kind==='resource')source.amount=0;sim.state.navigationRevision++;sim.state.pathAdmission={blue:{tick:sim.state.tick+1,remaining:0,used:50000}};
    expect(()=>sim.step()).not.toThrow();expect(worker.orders[0]?.targetId).toBe('source');expect(worker.blockedReason).toBe('PATH_BUSY');
    for(let tick=0;tick<200&&worker.orders[0]?.targetId!=='successor';tick++){sim.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);}
    expect(worker.orders[0]?.targetId).toBe('successor');
  });
  it('retries a blocked movement when a nearby observed blocking unit moves away',()=>{
    const sim=fixture(),mover=unit(sim,'villager'),blocker=unit(sim,'villager','blue',50000);
    // Seal both map edges so a legal detour around a finite cliff cannot bypass the stopped unit.
    sim.state.map.terrain.push({id:'corridor_north',kind:'cliff',xMm:0,zMm:50000,widthMm:sim.state.widthMm,depthMm:9500,elevationMm:3000},{id:'corridor_south',kind:'cliff',xMm:0,zMm:60500,widthMm:sim.state.widthMm,depthMm:10000,elevationMm:3000});sim.state.navigationRevision++;sim.step();send(sim,{kind:'move',unitIds:[mover.id],target:{xMm:60000,zMm:60000},queued:false});sim.step(300);expect(mover.blockedReason).toBe('PATH_BLOCKED');expect(blocker).toMatchObject({xMm:50000,zMm:60000,orders:[]});
    send(sim,{kind:'move',unitIds:[blocker.id],target:{xMm:68000,zMm:60000},queued:false});sim.step(250);expect(mover.orders).toHaveLength(0);expect(Math.abs(mover.xMm-60000)).toBeLessThanOrEqual(100);expect(Math.abs(mover.zMm-60000)).toBeLessThanOrEqual(100);
  });
  it('relocates only a newly observed blocked formation slot without taking another member slot',()=>{
    const sim=fixture(),army=[unit(sim,'militia'),unit(sim,'militia','blue',46000),unit(sim,'militia','blue',47000)];sim.step();const center={xMm:60000,zMm:80000};send(sim,{kind:'move',unitIds:army.map(unit=>unit.id),target:center,queued:false});const original=army.map(unit=>({...unit.orders[0]!.target!})),formationId=army[0]!.orders[0]!.formation!.id;
    sim.state.entities.unknown_tree={id:'unknown_tree',kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:1000000,...original[0]!,hp:1,maxHp:1};sim.state.navigationRevision++;sim.step();expect(army.map(unit=>unit.orders[0]!.target)).toEqual(original);
    unit(sim,'scout','blue',original[0]!.xMm+8000,original[0]!.zMm+3000);sim.step(2);const replacement=army[0]!.orders[0]!.target!;expect(replacement).not.toEqual(original[0]);expect(army.slice(1).map(unit=>unit.orders[0]!.target)).toEqual(original.slice(1));expect(army[0]!.orders[0]!.formation).toMatchObject({id:formationId,center,anchor:original[0]});expect(Math.hypot(replacement.xMm-original[0]!.xMm,replacement.zMm-original[0]!.zMm)).toBeLessThanOrEqual(16000);
    for(const destination of original.slice(1))expect(Math.hypot(replacement.xMm-destination.xMm,replacement.zMm-destination.zMm)).toBeGreaterThanOrEqual(900);const saved=sim.serializeState().entities[army[0]!.id] as Unit;expect(saved.orders[0]!.formation).toEqual(army[0]!.orders[0]!.formation);send(sim,{kind:'stop',unitIds:[army[0]!.id]});expect(army[0]!.orders).toHaveLength(0);expect(army[1]!.orders[0]!.formation!.id).toBe(formationId);
  });
  it('enforces garrison capacity atomically and releases an owned unit from an allied host',()=>{
    const sim=fixture(),town=building(sim),occupants:Array<Unit>=[];sim.state.economies.blue!.age=4;
    for(let index=0;index<15;index++)occupants.push(unit(sim,'militia','blue',43000,55000+index*750));const excess=unit(sim,'villager','blue',42000);sim.step();
    expect(send(sim,{kind:'garrison',unitIds:[...occupants.map(unit=>unit.id),excess.id],targetId:town.id,queued:false}).code).toBe('GARRISON_FULL');expect(occupants.every(unit=>unit.orders.length===0)).toBe(true);
    send(sim,{kind:'garrison',unitIds:occupants.map(unit=>unit.id),targetId:town.id,queued:false});sim.step(160);expect(town.garrisoned).toHaveLength(15);expect(send(sim,{kind:'garrison',unitIds:[excess.id],targetId:town.id,queued:false}).code).toBe('GARRISON_FULL');
    // The host changes to an allied owner without transferring ownership of occupants.
    sim.state.factions.find(faction=>faction.id==='red')!.teamId='blue';town.ownerId='red';
    expect(send(sim,{kind:'ungarrison',buildingId:town.id,unitIds:[occupants[0]!.id]}).status).toBe('accepted');sim.step();expect(occupants[0]!.garrisonedIn).toBeUndefined();expect(occupants[0]!.ownerId).toBe('blue');
  });
  it('rejects queued wall work beyond sixteen orders without charging or placing sites',()=>{
    const sim=fixture(),worker=unit(sim,'villager');sim.state.economies.blue!.age=4;sim.step();
    for(let index=0;index<16;index++)expect(send(sim,{kind:'move',unitIds:[worker.id],target:{xMm:45000+index*500,zMm:64000},queued:true}).status).toBe('accepted');
    const before={bank:structuredClone(sim.state.economies.blue!.resources),ids:Object.keys(sim.state.entities)};
    expect(send(sim,{kind:'build_wall',builderIds:[worker.id],material:'stone',cells:[{x:24,z:30}],queued:true}).code).toBe('ORDER_QUEUE_FULL');expect(sim.state.economies.blue!.resources).toEqual(before.bank);expect(Object.keys(sim.state.entities)).toEqual(before.ids);expect(worker.orders).toHaveLength(16);
    send(sim,{kind:'stop',unitIds:[worker.id]});expect(worker.orders).toHaveLength(0);expect(worker.path).toHaveLength(0);
  });
  it('pursues a lost unit through its last observed position without following hidden coordinates',()=>{
    const create=(hiddenX:number)=>{const sim=fixture(),hunter=unit(sim,'militia'),victim=unit(sim,'villager','red',60000),observer=unit(sim,'scout','blue',60000,66000);victim.cooldown=10000;sim.step();expect(send(sim,{kind:'attack_target',unitIds:[hunter.id],targetId:victim.id,queued:false}).status).toBe('accepted');observer.xMm=35000;observer.zMm=90000;sim.step();victim.xMm=hiddenX;victim.zMm=90000;return {sim,hunter};};
    const a=create(80000),b=create(100000);for(let tick=0;tick<120;tick++){a.sim.step();b.sim.step();expect({x:a.hunter.xMm,z:a.hunter.zMm,orders:a.hunter.orders}).toEqual({x:b.hunter.xMm,z:b.hunter.zMm,orders:b.hunter.orders});}expect(a.hunter.orders).toHaveLength(0);expect(a.hunter.xMm).toBeGreaterThan(45000);expect(a.hunter.xMm).toBeLessThan(60000);
  });
  it('retains pending route work while its currently observed attack target moves',()=>{
    const sim=fixture(),hunter=unit(sim,'militia'),target=unit(sim,'villager','red',75000);unit(sim,'scout','blue',80000,65000);sim.state.map.terrain.push({id:'long_pursuit_cliff',kind:'cliff',xMm:60000,zMm:0,widthMm:2000,depthMm:280000,elevationMm:3000});sim.state.navigationRevision++;sim.step();
    expect(send(sim,{kind:'attack_target',unitIds:[hunter.id],targetId:target.id,queued:false}).status).toBe('accepted');expect(send(sim,{kind:'move',unitIds:[target.id],target:{xMm:75000,zMm:68000},queued:false},'red').status).toBe('accepted');sim.step();const request=hunter.pathRequestId;expect(request).toBeDefined();let movedWhilePending=false;
    for(let tick=0;tick<30&&hunter.pathRequestId;tick++){sim.step();if(hunter.pathRequestId){expect(hunter.pathRequestId).toBe(request);movedWhilePending||=target.zMm>61000;}}
    expect(movedWhilePending).toBe(true);expect(hunter.orders[0]?.targetId).toBe(target.id);
  });
  it('keeps ungarrison blocked behind solid surrounding walls and kills trapped occupants on destruction',()=>{
    const sim=fixture(),town=building(sim),worker=unit(sim,'villager','blue',43000);sim.step();send(sim,{kind:'garrison',unitIds:[worker.id],targetId:town.id,queued:false});sim.step();
    for(let offset=-6000;offset<=6000;offset+=2000){building(sim,'palisade_wall','blue',town.xMm+offset,town.zMm-7000);building(sim,'palisade_wall','blue',town.xMm+offset,town.zMm+7000);building(sim,'palisade_wall','blue',town.xMm-7000,town.zMm+offset);building(sim,'palisade_wall','blue',town.xMm+7000,town.zMm+offset);}
    expect(send(sim,{kind:'ungarrison',buildingId:town.id,unitIds:[worker.id]}).status).toBe('accepted');sim.step(10);expect(worker.garrisonedIn).toBe(town.id);expect(worker.blockedReason).toBe('EXIT_BLOCKED');town.hp=0;sim.step();expect(sim.state.entities[worker.id]).toBeUndefined();
  });
});

describe('M3 victory and final statistics',()=>{
  it('keeps Monument victory optional and uses a single uninterrupted 600-second hold',()=>{
    const sim=fixture(true),monument=building(sim,'monument');sim.step();const start=monument.monumentCompletedTick!;sim.state.tick=start+11999;sim.setStatus('PAUSED');sim.step(100);expect(sim.state.tick).toBe(start+11999);sim.setStatus('RUNNING');sim.step();expect(sim.state.result?.winnerTeamId).toBe('blue');expect(sim.state.result?.reason).toBe('monument');
    const ordinary=fixture(false);building(ordinary,'monument').monumentCompletedTick=0;ordinary.state.tick=12000;ordinary.step();expect(ordinary.state.status).toBe('RUNNING');
  });
  it('announces public monument positions without revealing their hidden HP and resolves a same-tick draw',()=>{
    const sim=fixture(true),blue=building(sim,'monument','blue',50000),red=building(sim,'monument','red',80000);sim.step();
    const notice=sim.view('blue').monuments!.find(m=>m.id===red.id)!;expect(notice).toMatchObject({xMm:80000,remainingTicks:12000});expect(notice).not.toHaveProperty('hp');sim.state.tick=12000;sim.step();expect(sim.state.result).toMatchObject({winnerTeamId:null,reason:'simultaneous_monuments'});expect(blue.hp).toBe(blue.maxHp);
  });
  it('resets a destroyed Monument and ends a confirmed administrative draw with final-only statistics',()=>{
    const sim=fixture(true),monument=building(sim,'monument');sim.step();sim.state.tick=11000;monument.hp=0;sim.step();const replacement=building(sim,'monument');sim.step();expect(replacement.monumentCompletedTick).toBe(sim.state.tick);expect(sim.view('red').monuments?.[0]?.remainingTicks).toBe(12000);
    const town=Object.values(sim.state.entities).find(e=>e.ownerId==='blue'&&e.typeId==='town_center')!;send(sim,{kind:'train',buildingId:town.id,unitType:'villager',quantity:1});sim.step(400);expect(sim.view('blue').result).toBeUndefined();sim.endAsDraw();expect(sim.state.result).toMatchObject({winnerTeamId:null,reason:'administrative_draw'});expect(sim.state.result?.statistics.find(s=>s.playerId==='blue')).toMatchObject({unitsTrained:1,buildingsLost:1,spent:{food:50}});expect(JSON.parse(JSON.stringify(sim.serializeState()))).toEqual(sim.serializeState());
  });
});
