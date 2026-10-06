import { describe, expect, it,vi } from 'vitest';
import { balance, buildings, effectiveBuilding, effectiveUnit, technologies, units, type BuildingId, type Position, type TechnologyId, type UnitId } from '@frontier/shared';
import { activeCombatant, advanceCombat, CombatSpatialIndex, NativeCombatTimeline, createCombatOwnerFilter, createNativeCombatOwnerFilterScope, inAttackRange, type Combatant } from '../src/combat.js';
import { updateEngagements, type OrderContext } from '../src/orders.js';
import type { Building, Entity, SimulationState, Unit } from '../src/state.js';
import { createSimulation, createLiveSimulation, Simulation } from '../src/index.js';

const centerDistance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
describe('native frame-local combat deadlines',()=>{
  it.each([false,true])('uses the firing turret cooldown for its observed attack, including native deadlines=%s',native=>{
    const carrier=unit('carrier','crown_colossus'),target=unit('target','knight','red',44000);carrier.cooldown=9;carrier.weaponCooldowns=[1];target.cooldown=100;
    const run=harness([carrier,target]),roster=Object.values(run.state.entities),timeline=native?NativeCombatTimeline.create(run.state,roster,100,106):undefined;
    if(native)expect(timeline).toBeDefined();run.state.tick=101;advanceCombat(run.context,timeline);timeline?.flush();
    const duration=Math.ceil(units.crown_colossus.turret!.attackCooldownSeconds*balance.rules.simulationHz);
    expect(run.launches).toEqual([{id:'carrier',xMm:target.xMm,zMm:target.zMm,duration}]);
    expect(run.state.entities.carrier).toMatchObject({cooldown:8,weaponCooldowns:[duration]});
    expect(run.state.projectiles).toHaveLength(1);expect(run.state.projectiles[0]).toMatchObject({kind:'arrow',sourceId:'carrier',targetId:'target',attack:{attack:units.crown_colossus.turret!.attack}});
  });
  it('keeps a completely idle frame on the generic lane without allocating a deadline roster',()=>{
    const idle=harness([unit('idle')]),before=NativeCombatTimeline.diagnostics().frames;
    expect(NativeCombatTimeline.create(idle.state,Object.values(idle.state.entities),100,106)).toBeUndefined();expect(NativeCombatTimeline.diagnostics().frames).toBe(before);
  });
  it('materializes only reached actor counters when a due definition throws midway through combat',()=>{
    const first=unit('before'),throws=unit('throws'),last=unit('after');first.cooldown=last.cooldown=9;throws.cooldown=1;
    const native=harness([first,throws,last]),scalar=harness([first,throws,last]),roster=Object.values(native.state.entities),timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;native.context.entities=()=>roster;
    for(const run of [native,scalar]){const original=run.context.definition;run.context.definition=entity=>{if(entity.id==='throws')throw new Error('EXPECTED_COMBAT_FAILURE');return original(entity);};run.state.tick++;}
    expect(()=>advanceCombat(native.context,timeline)).toThrow('EXPECTED_COMBAT_FAILURE');expect(()=>advanceCombat(scalar.context)).toThrow('EXPECTED_COMBAT_FAILURE');
    timeline.flush();expect(native.state).toEqual(scalar.state);expect((native.state.entities.before as Unit).cooldown).toBe(8);expect((native.state.entities.after as Unit).cooldown).toBe(9);
  });
  it.each(['impact','hit'] as const)('keeps exact cooldown progress when a %s effect throws before/after all launches',stage=>{
    const target=unit('target');target.cooldown=9;const native=harness([target]),scalar=harness([target]);
    for(const run of [native,scalar]){run.state.projectiles=[{id:'impact',kind:'arrow',ownerId:'red',sourceId:'enemy',targetId:'target',from:{xMm:33000,zMm:32000},aim:{xMm:32000,zMm:32000},launchTick:100,hitTick:101,attack:{attack:1,attackType:'pierce',bonusDamage:{}}}];run.context.effect=kind=>{if(kind===stage)throw new Error('EXPECTED_EFFECT_FAILURE');};}
    const roster=Object.values(native.state.entities),timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;native.context.entities=()=>roster;
    native.state.tick=scalar.state.tick=101;expect(()=>advanceCombat(native.context,timeline)).toThrow('EXPECTED_EFFECT_FAILURE');expect(()=>advanceCombat(scalar.context)).toThrow('EXPECTED_EFFECT_FAILURE');timeline.flush();
    expect(native.state).toEqual(scalar.state);expect((native.state.entities.target as Unit).cooldown).toBe(stage==='impact'?9:8);
  });
  it('actually omits cooling definition work and future impact passes while materializing exact counters',()=>{
    const actor=unit('cooling');actor.cooldown=9;actor.orders=[{kind:'move',target:{xMm:50000,zMm:32000}}];
    const native=harness([actor]),scalar=harness([actor]),roster=Object.values(native.state.entities);
    const calls={native:0,scalar:0};for(const [name,run]of [['native',native],['scalar',scalar]] as const){const original=run.context.definition;run.context.definition=entity=>{calls[name]++;return original(entity);};}
    const projectile={id:'later',kind:'arrow' as const,ownerId:'blue',sourceId:'cooling',targetId:'missing',from:{xMm:32000,zMm:32000},aim:{xMm:64000,zMm:32000},launchTick:100,hitTick:120,attack:{attack:1,attackType:'pierce' as const,bonusDamage:{}}};
    native.state.projectiles=[structuredClone(projectile)];scalar.state.projectiles=[structuredClone(projectile)];
    const before=NativeCombatTimeline.diagnostics(),timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;native.context.entities=()=>roster;
    for(let tick=101;tick<=106;tick++){native.state.tick=scalar.state.tick=tick;advanceCombat(native.context,timeline);advanceCombat(scalar.context);}
    expect((native.state.entities.cooling as Unit).cooldown).toBe(9);timeline.flush();
    expect(native.state).toEqual(scalar.state);expect(calls).toEqual({native:0,scalar:6});
    const after=NativeCombatTimeline.diagnostics();expect(after.skippedCooldownContacts-before.skippedCooldownContacts).toBe(6);expect(after.skippedProjectileContacts-before.skippedProjectileContacts).toBe(6);
  });
  it.each(['garrison','defeat','owner','death'] as const)('pauses and resumes exact elapsed counters on %s eligibility changes',kind=>{
    const actor=unit('clock');actor.cooldown=12;
    const native=harness([actor]),scalar=harness([actor]),roster=Object.values(native.state.entities),timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;native.context.entities=()=>roster;
    for(let tick=101;tick<=106;tick++){
      for(const run of [native,scalar]){
        const current=run.state.entities.clock as Unit;
        if(tick===102){if(kind==='garrison')current.garrisonedIn='shelter';if(kind==='defeat')run.state.economies.blue!.defeated=true;if(kind==='owner')current.ownerId='fallen';if(kind==='death')current.hp=0;}
        if(tick===105){delete current.garrisonedIn;current.ownerId='blue';current.hp=current.maxHp;run.state.economies.blue!.defeated=false;}
        if(run===native&&(tick===102||tick===105))timeline.notify(current);
      }
      native.state.tick=scalar.state.tick=tick;advanceCombat(native.context,timeline);advanceCombat(scalar.context);
    }
    timeline.flush();expect(native.state).toEqual(scalar.state);expect((native.state.entities.clock as Unit).cooldown).toBe(9);
  });
  it('keeps launch order, live research/range checks, newly born actors and due projectile impacts exact',()=>{
    const victim=unit('victim','villager','red',35500);victim.hp=victim.maxHp=1000;victim.cooldown=50;victim.orders=[{kind:'move',target:{xMm:90000,zMm:32000}}];
    const actors=Array.from({length:6},(_,i)=>{const actor=unit(`archer_${i}`);actor.cooldown=6-i;actor.orders=[{kind:'attack',targetId:victim.id}];return actor;});
    const native=harness([...actors,victim]),scalar=harness([...actors,victim]);let roster=Object.values(native.state.entities);native.context.entities=()=>roster;
    const timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;
    for(let tick=101;tick<=106;tick++){
      if(tick===103)for(const run of [native,scalar])run.upgradedOwners.add('blue');
      if(tick===104)for(const run of [native,scalar]){const born=unit('born');born.cooldown=1;born.orders=[{kind:'attack',targetId:victim.id}];run.state.entities.born=born;}
      if(tick===104)roster=Object.values(native.state.entities);
      native.state.tick=scalar.state.tick=tick;advanceCombat(native.context,timeline);advanceCombat(scalar.context);
      expect(native.launches).toEqual(scalar.launches);expect(native.state.projectiles).toEqual(scalar.state.projectiles);expect(native.state.entities.victim!.hp).toBe(scalar.state.entities.victim!.hp);
    }
    timeline.flush();expect(native.state).toEqual(scalar.state);expect(native.launches.map(launch=>launch.id)).toEqual(['archer_5','archer_4','archer_3','archer_2','born','archer_1','archer_0']);
  });
  it('keeps overdue impact insertion order and simultaneous damage before materializing a partial frame',()=>{
    const target=unit('target','villager','red');target.cooldown=15;
    const native=harness([target]),scalar=harness([target]);
    for(const run of [native,scalar])run.state.projectiles=[99,100,103,106,140].map((hitTick,index)=>({id:`impact_${index}`,kind:'arrow',ownerId:'blue',sourceId:`source_${index}`,targetId:'target',from:{xMm:31000,zMm:32000},aim:{xMm:32000,zMm:32000},launchTick:90,hitTick,attack:{attack:1,attackType:'pierce',bonusDamage:{}}}));
    const roster=Object.values(native.state.entities);native.context.entities=()=>roster;const timeline=NativeCombatTimeline.create(native.state,roster,100,106)!;
    for(let tick=101;tick<=103;tick++){native.state.tick=scalar.state.tick=tick;advanceCombat(native.context,timeline);advanceCombat(scalar.context);expect(native.state.projectiles).toEqual(scalar.state.projectiles);}
    timeline.flush();expect(native.state).toEqual(scalar.state);expect((native.state.entities.target as Unit).lastAttackerId).toBe('source_2');expect((native.state.entities.target as Unit).cooldown).toBe(12);
  });
});
function unit(id:string,typeId:UnitId='archer',ownerId='blue',xMm=32000,zMm=32000):Unit {
  const definition=units[typeId];
  return {id,kind:'unit',typeId,ownerId,xMm,zMm,hp:definition.maxHp,maxHp:definition.maxHp,orders:[],path:[],pathRevision:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'defensive',repathAtTick:0,...(definition.deploySeconds?{deploymentState:'deployed' as const}:{})};
}
function building(id:string,typeId:BuildingId,ownerId='red',xMm=32000,zMm=32000,rotation:Building['rotation']=0):Building {
  const definition=buildings[typeId],work=definition.buildSeconds*balance.rules.simulationHz*100;
  return {id,kind:'building',typeId,ownerId,xMm,zMm,rotation,hp:definition.maxHp,maxHp:definition.maxHp,work,required:work,grantedHp:definition.maxHp,queue:[],cooldown:0};
}
function halfSize(entity:Combatant):[number,number] {
  if(entity.kind==='unit'){const radius=units[entity.typeId].collisionRadiusM*1000;return [radius,radius];}
  let [width,height]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[width,height]=[height,width];
  return [width*balance.rules.buildingGridM*500,height*balance.rules.buildingGridM*500];
}
function boundaryDistance(point:Position,target:Combatant):number {
  const [width,height]=halfSize(target);return Math.hypot(Math.max(0,Math.abs(point.xMm-target.xMm)-width),Math.max(0,Math.abs(point.zMm-target.zMm)-height));
}
function combatDistance(a:Combatant,b:Combatant):number {
  if(a.kind==='unit'&&b.kind==='unit')return Math.max(0,centerDistance(a,b)-(units[a.typeId].collisionRadiusM+units[b.typeId].collisionRadiusM)*1000);
  if(a.kind==='unit')return Math.max(0,boundaryDistance(a,b)-units[a.typeId].collisionRadiusM*1000);
  if(b.kind==='unit')return Math.max(0,boundaryDistance(b,a)-units[b.typeId].collisionRadiusM*1000);
  const [aw,ah]=halfSize(a),[bw,bh]=halfSize(b);return Math.hypot(Math.max(0,Math.abs(a.xMm-b.xMm)-aw-bw),Math.max(0,Math.abs(a.zMm-b.zMm)-ah-bh));
}
type Launch={id:string;xMm:number;zMm:number;duration:number};
function harness(entities:Entity[]){
  // These pure phase tests need no map generation, simulation stepping or persisted fixture.
  const state={tick:100,factions:['blue','green','red','fallen'].map(id=>({id,teamId:id==='green'?'blue':id})),entities:Object.fromEntries(entities.map(entity=>[entity.id,structuredClone(entity)])),economies:Object.fromEntries(['blue','green','red','fallen'].map(id=>[id,{defeated:id==='fallen'}])),projectiles:[]} as unknown as SimulationState;
  const hidden=new Set<string>(),blockedMelee=new Set<string>(),launches:Launch[]=[],cancelled:string[]=[],visibilityCalls:string[]=[];
  const definitions=new Map<string,ReturnType<OrderContext['definition']>>(),upgradedOwners=new Set<string>();let nonce=0;
  const context:OrderContext={
    state,entities:()=>Object.values(state.entities),id:()=>`projectile_${++nonce}`,
    hostile:(a,b)=>b!==null&&(a==='blue'||a==='green'?'allies':a)!==(b==='blue'||b==='green'?'allies':b),
    visible:(playerId,point)=>{const id=(point as Entity).id;visibilityCalls.push(`${playerId}:${id}`);return !hidden.has(`${playerId}:${id}`)&&!('garrisonedIn'in point&&point.garrisonedIn);},
    complete:entity=>entity.kind==='building'&&entity.work>=entity.required,distance:combatDistance,pointDistance:boundaryDistance,
    meleeClear:(a,b)=>!blockedMelee.has(`${a.id}:${b.id}`),effect:()=>{},
    action:(entity,_kind,duration,aim)=>launches.push({id:entity.id,...aim,duration}),
    definition:entity=>{const key=`${entity.ownerId}:${entity.kind}:${entity.typeId}:${upgradedOwners.has(entity.ownerId)}`,prior=definitions.get(key);if(prior)return prior;const completed=upgradedOwners.has(entity.ownerId)?Object.keys(technologies) as TechnologyId[]:[];const definition=entity.kind==='unit'?effectiveUnit(entity.typeId,completed):effectiveBuilding(entity.typeId,completed);definitions.set(key,definition);return definition;},
    workReachable:()=>true,exitPosition:()=>undefined,task:()=>{},cancelPath:entity=>{cancelled.push(entity.id);entity.path=[];entity.orderRevision=(entity.orderRevision??0)+1;},
  };
  return {context,state,hidden,blockedMelee,launches,cancelled,visibilityCalls,upgradedOwners};
}

/** Independent whole-roster selection under the same explicit stance policy. */
function referenceEngagements(context:OrderContext):void {
  const combatants=context.entities!().filter(activeCombatant),knownEnemies=new Map<string,typeof combatants>();
  for(const unit of combatants){
    if(unit.kind!=='unit'||context.state.economies[unit.ownerId]!.defeated)continue;
    const order=unit.orders[0];if(order?.kind==='attack'||order?.kind==='attack_ground'||order?.kind==='move'){delete unit.engagement;continue;}
    if(units[unit.typeId].deploySeconds&&unit.deploymentState!=='deployed'&&!order){delete unit.engagement;continue;}
    const attackMoving=order?.kind==='attack_move'||order?.kind==='patrol',economic=Boolean(order&&!attackMoving),military=!units[unit.typeId].tags.includes('worker'),idleMilitary=!order&&military,acquisitionMm=Math.max(units[unit.typeId].visionM,!economic&&military?balance.rules.combatAcquisitionRadiusM:0)*1000;
    const previous=unit.engagement;
    if(previous){
      const target=context.state.entities[previous.targetId],leash=acquisitionMm;
      const retain=target&&activeCombatant(target)&&context.hostile(unit.ownerId,target.ownerId)&&context.visible(unit.ownerId,target)&&(unit.stance!=='stand_ground'||inAttackRange(context,unit,target))&&(unit.stance!=='defensive'||centerDistance(target,previous.anchor)<=leash);
      if(retain){previous.lastKnown={xMm:target.xMm,zMm:target.zMm};continue;}delete unit.engagement;context.cancelPath(unit);
      if(idleMilitary&&unit.stance==='defensive'&&centerDistance(unit,previous.anchor)>100){unit.orders.push({kind:'move',target:{...previous.anchor}});context.task(unit,'moving');continue;}
    }
    let enemies=knownEnemies.get(unit.ownerId);if(!enemies){enemies=combatants.filter(target=>context.hostile(unit.ownerId,target.ownerId)&&context.visible(unit.ownerId,target));knownEnemies.set(unit.ownerId,enemies);}
    const mayChase=!economic&&unit.stance!=='stand_ground'&&(attackMoving||unit.stance==='aggressive'||idleMilitary);
    const retaliation=unit.lastAttackerId&&unit.lastDamagedTick!==undefined&&context.state.tick-unit.lastDamagedTick<=Math.ceil(units[unit.typeId].attackCooldownSeconds*balance.rules.simulationHz)*2?unit.lastAttackerId:undefined;
    const target=enemies.filter(enemy=>(!economic&&inAttackRange(context,unit,enemy))||((mayChase||enemy.id===retaliation)&&unit.stance!=='stand_ground'&&centerDistance(unit,enemy)<=acquisitionMm)).sort((a,b)=>centerDistance(a,unit)-centerDistance(b,unit))[0];
    if(target){unit.engagement={targetId:target.id,lastKnown:{xMm:target.xMm,zMm:target.zMm},anchor:{xMm:unit.xMm,zMm:unit.zMm}};context.cancelPath(unit);}
  }
}
/** Independent full-roster oracle. Weapon profiles come from content; target
 * selection never uses the production spatial index or its range predicate. */
function referenceLaunches(context:OrderContext):Launch[] {
  const {state}=context,combatants=context.entities!().filter(activeCombatant),visibleHostiles=new Map<string,Combatant[]>(),result:Launch[]=[];
  for(const attacker of combatants){
    if(state.economies[attacker.ownerId]!.defeated)continue;
    const base=context.definition(attacker),turret='turret'in base?base.turret:undefined,ports='weaponPorts'in base?base.weaponPorts??1:turret?2:1;
    if(attacker.kind==='building'&&!context.complete(attacker)||attacker.kind==='unit'&&('deploySeconds'in base&&base.deploySeconds&&attacker.deploymentState!=='deployed'||units[attacker.typeId].mobileGarrisonCapacity&&(attacker.path.length||attacker.taskState==='moving'&&attacker.lastProgressTick===state.tick)))continue;
    const order=attacker.kind==='unit'?attacker.orders[0]:undefined;
    if(attacker.kind==='unit'&&order&&(order.kind==='move'||(!['attack','attack_ground','attack_move','patrol'].includes(order.kind)&&!attacker.engagement)))continue;
    for(let port=0;port<ports;port++){
    const definition=port&&turret?{...base,...turret,minRangeM:0,windupSeconds:0,ammunitionCost:undefined}:base;
    const remaining=port?(attacker.weaponCooldowns?.[port-1]??0):attacker.cooldown;
    if(remaining>1||!definition.attack)continue;
    const minimum=('minRangeM'in definition?definition.minRangeM:0)*1000,maximum=definition.rangeM*1000,inRange=(target:Combatant)=>{const range=combatDistance(attacker,target);return range>=minimum&&range<=maximum;};
    const ground=order?.kind==='attack_ground'?order.target:undefined,targetId=order?.kind==='attack'?order.targetId:attacker.kind==='unit'?attacker.engagement?.targetId:undefined;
    let target=targetId?state.entities[targetId]:undefined;if(target&&!activeCombatant(target))target=undefined;
    if(!target&&!ground){let enemies=visibleHostiles.get(attacker.ownerId);if(!enemies){enemies=combatants.filter(t=>context.hostile(attacker.ownerId,t.ownerId)&&context.visible(attacker.ownerId,t));visibleHostiles.set(attacker.ownerId,enemies);}target=enemies.filter(inRange).sort((a,b)=>centerDistance(a,attacker)-centerDistance(b,attacker)||(ports>1?(a.id<b.id?-1:a.id>b.id?1:0):0))[0];}
    let aim:Position;
    if(ground){if(!('areaDamageBands'in definition)||!definition.areaDamageBands)continue;const distance=Math.max(0,centerDistance(attacker,ground)-(attacker.kind==='unit'?units[attacker.typeId].collisionRadiusM*1000:0));if(distance<definition.minRangeM*1000||distance>definition.rangeM*1000)continue;aim=ground;}
    else{if(!target||!activeCombatant(target)||!context.visible(attacker.ownerId,target)||!context.hostile(attacker.ownerId,target.ownerId)||!inRange(target))continue;if(definition.projectileSpeedMps===0&&!context.meleeClear(attacker,target))continue;aim=target;}
    if(attacker.kind==='unit'&&'ammunitionCost'in definition&&definition.ammunitionCost&&context.ammunition&&!context.ammunition(attacker,false))continue;
    // Starting a windup is not a launch. Later-age tests cover its due event.
    if(attacker.kind==='unit'&&definition.projectileSpeedMps>0&&'windupSeconds'in definition&&definition.windupSeconds)continue;
    result.push({id:attacker.id,xMm:aim.xMm,zMm:aim.zMm,duration:Math.ceil(definition.attackCooldownSeconds*balance.rules.simulationHz)});
    }
  }
  return result;
}
function compareEngagements(actual:ReturnType<typeof harness>,reference:ReturnType<typeof harness>):void {
  updateEngagements(actual.context);referenceEngagements(reference.context);expect(actual.state.entities).toEqual(reference.state.entities);expect(actual.cancelled).toEqual(reference.cancelled);
}
function compareCombat(actual:ReturnType<typeof harness>,reference:ReturnType<typeof harness>):void {
  const expected=referenceLaunches(reference.context);advanceCombat(actual.context);expect(actual.launches).toEqual(expected);
}

/** Legacy per-query Set ownership, independently using the unchanged spatial
 * buckets and existing test geometry. Also specifies eligibility call order. */
function legacyNearest(index:CombatSpatialIndex,roster:readonly Combatant[],origin:Combatant,reach:number,eligible:(entity:Combatant)=>boolean):Combatant|undefined {
  const rows=(index as unknown as {rows:Map<number,Map<number,number[]>>}).rows,[width,height]=halfSize(origin),seen=new Set<number>();let best:Combatant|undefined,bestDistance=Infinity,bestIndex=Infinity;
  for(let z=Math.floor((origin.zMm-height-reach)/16000);z<=Math.floor((origin.zMm+height+reach)/16000);z++){
    const row=rows.get(z);if(!row)continue;
    for(let x=Math.floor((origin.xMm-width-reach)/16000);x<=Math.floor((origin.xMm+width+reach)/16000);x++)for(const ordinal of row.get(x)??[]){
      if(seen.has(ordinal))continue;seen.add(ordinal);const candidate=roster[ordinal]!;if(!eligible(candidate))continue;
      const distance=centerDistance(candidate,origin);if(distance<bestDistance||distance===bestDistance&&ordinal<bestIndex){best=candidate;bestDistance=distance;bestIndex=ordinal;}
    }
  }
  return best;
}

describe('combat query visitation ownership',()=>{
  function roster(){
    const origin=unit('origin','archer','blue',16000,16000),earlier=unit('z_first','villager','red',21000,16000),later=unit('a_later','villager','red',11000,16000),wide=building('wide','fortress','red',16000,16000);
    return {origin,entities:[earlier,later,origin,wide,{...earlier},wide] as Combatant[]};
  }
  it('matches legacy eligibility order once per roster entry, including duplicate IDs/references and cross-bucket ties',()=>{
    const {origin,entities}=roster(),index=new CombatSpatialIndex(entities);
    for(const reach of [0,16000,48000,16000]){
      const actualCalls:Combatant[]=[],expectedCalls:Combatant[]=[],predicate=(entity:Combatant)=>entity.kind==='unit'&&entity.ownerId==='red';
      const actual=index.nearest(origin,reach,entity=>{actualCalls.push(entity);return predicate(entity);}),expected=legacyNearest(index,entities,origin,reach,entity=>{expectedCalls.push(entity);return predicate(entity);});
      expect(actual).toBe(expected);expect(actual).toBe(entities[0]);expect(actualCalls).toEqual(expectedCalls);expect(actualCalls).toHaveLength(entities.length);expect(actualCalls.filter(entity=>entity===entities[3])).toHaveLength(2);
    }
  });
  it('preserves live position reads after eligibility and during later queries',()=>{
    const run=(legacy:boolean)=>{
      const {origin,entities}=roster(),index=new CombatSpatialIndex(entities),calls:string[]=[];
      const nearest=(eligible:(entity:Combatant)=>boolean)=>legacy?legacyNearest(index,entities,origin,48000,eligible):index.nearest(origin,48000,eligible);
      const selected=nearest(entity=>{calls.push(entity.id);if(entity===entities[0])entity.xMm=origin.xMm+100;if(entity===entities[1])entity.zMm=origin.zMm+500;return entity.kind==='unit'&&entity.ownerId==='red';});
      const later=nearest(entity=>{calls.push(`later:${entity.id}`);return entity.kind==='unit'&&entity.ownerId==='red';});
      return {selected:entities.indexOf(selected!),later:entities.indexOf(later!),calls,entities};
    };
    expect(run(false)).toEqual(run(true));
  });
  it('isolates recursive eligibility queries and restores ownership after nested and outer exceptions',()=>{
    const run=(legacy:boolean)=>{
      const {origin,entities}=roster(),index=new CombatSpatialIndex(entities),calls:string[]=[],results:number[]=[];
      const nearest=(eligible:(entity:Combatant)=>boolean)=>legacy?legacyNearest(index,entities,origin,48000,eligible):index.nearest(origin,48000,eligible);
      let nested=false,deep=false;
      results.push(entities.indexOf(nearest(entity=>{
        calls.push(`outer:${entity.id}`);
        if(!nested){nested=true;results.push(entities.indexOf(nearest(inner=>{
          calls.push(`inner:${inner.id}`);
          if(!deep){deep=true;expect(()=>nearest(last=>{calls.push(`throw:${last.id}`);throw new Error('NESTED_ELIGIBILITY');})).toThrow('NESTED_ELIGIBILITY');}
          return inner.kind==='building';
        })!));}
        return entity.kind==='unit'&&entity.ownerId==='red';
      })!));
      expect(()=>nearest(entity=>{calls.push(`outer_throw:${entity.id}`);throw new Error('OUTER_ELIGIBILITY');})).toThrow('OUTER_ELIGIBILITY');
      results.push(entities.indexOf(nearest(entity=>{calls.push(`recovered:${entity.id}`);return entity.ownerId==='red';})!));
      if(!legacy)expect((index as unknown as {queryDepth:number}).queryDepth).toBe(0);
      return {calls,results};
    };
    expect(run(false)).toEqual(run(true));
  });
  it('clears Uint32 marks on rollover without advancing them inside recursive queries',()=>{
    const {origin,entities}=roster(),index=new CombatSpatialIndex(entities),privateIndex=index as unknown as {queryGeneration:number;visited:Uint32Array;queryDepth:number};
    privateIndex.queryGeneration=0xfffffffe;let nested=false;
    index.nearest(origin,48000,()=>{if(!nested){nested=true;index.nearest(origin,48000,()=>true);expect(privateIndex.queryGeneration).toBe(0xffffffff);}return true;});
    expect(privateIndex.queryDepth).toBe(0);privateIndex.visited.fill(1);
    const actualCalls:string[]=[],expectedCalls:string[]=[],actual=index.nearest(origin,48000,entity=>{actualCalls.push(entity.id);return true;}),expected=legacyNearest(index,entities,origin,48000,entity=>{expectedCalls.push(entity.id);return true;});
    expect(actual).toBe(expected);expect(actualCalls).toEqual(expectedCalls);expect(actualCalls).toHaveLength(entities.length);expect(privateIndex.queryGeneration).toBe(1);expect(privateIndex.queryDepth).toBe(0);
  });
});

describe('phase-owned allied combat bucket exclusion',()=>{
  const factions=[{id:'blue',teamId:'allies'},{id:'green',teamId:'allies'},{id:'red',teamId:'red'},{id:'fallen',teamId:'fallen'}];
  const hostile=(ownerId:string)=>ownerId==='red'||ownerId==='fallen';

  it('actually skips wholly allied buckets while generic queries preserve every eligibility callback',()=>{
    const origin=unit('origin','archer','blue',32000,32000),roster:Combatant[]=[origin,...Array.from({length:32},(_,index)=>unit(`ally_${index}`,'militia',index%2?'blue':'green',12000+index%8*6000,12000+Math.floor(index/8)*8000)),building('wide_ally','fortress','green',32000,32000)];
    const filter=createCombatOwnerFilter(factions);expect(filter).toBeDefined();const index=new CombatSpatialIndex(roster,filter),optimized:string[]=[],generic:string[]=[],expected:string[]=[];
    expect(index.nearest(origin,64000,entity=>{optimized.push(entity.id);return hostile(entity.ownerId);},'blue')).toBeUndefined();expect(optimized).toEqual([]);
    expect(index.nearest(origin,64000,entity=>{generic.push(entity.id);return hostile(entity.ownerId);})).toBeUndefined();
    expect(legacyNearest(index,roster,origin,64000,entity=>{expected.push(entity.id);return hostile(entity.ownerId);})).toBeUndefined();
    expect(generic).toEqual(expected);expect(generic).toHaveLength(roster.length);
  });

  it('preserves hostile traversal, duplicate ordinals and stable nearest ties in mixed buckets',()=>{
    const origin=unit('origin','archer','blue',16000,16000),first=unit('z_first','villager','red',21000,16000),later=unit('a_later','villager','red',11000,16000),wide=building('wide','wooden_gate','green',32000,16000,90);
    const roster:Combatant[]=[first,later,origin,wide,first,unit('distant_ally','militia','green',44000,16000)];
    const index=new CombatSpatialIndex(roster,createCombatOwnerFilter(factions)),actual:string[]=[],expected:string[]=[];
    const picked=index.nearest(origin,48000,entity=>{if(hostile(entity.ownerId))actual.push(entity.id);return hostile(entity.ownerId);},'blue');
    const scalar=legacyNearest(index,roster,origin,48000,entity=>{if(hostile(entity.ownerId))expected.push(entity.id);return hostile(entity.ownerId);});
    expect(picked).toBe(first);expect(picked).toBe(scalar);expect(actual).toEqual(expected);expect(actual.filter(id=>id==='z_first')).toHaveLength(2);
  });

  it('keeps exact fog, weapon minima, rotated gates and footprint tangency after bucket exclusion',()=>{
    const filter=createCombatOwnerFilter(factions);
    for(const actorType of ['militia','archer','trebuchet'] as const)for(const rotation of [0,90,180,270] as const)for(const delta of [-1,0,1]){
      const actor=unit('actor',actorType),gate=building('gate','wooden_gate','red',32000,32000,rotation),ally=building('ally','fortress','green',5000,32000),hidden=unit('hidden','villager','red',33000,32000),fixture=harness([actor,gate,ally,hidden]);
      fixture.hidden.add('blue:hidden');const target=fixture.state.entities.gate as Building,attacker=fixture.state.entities.actor as Unit,definition=fixture.context.definition(attacker);
      for(const range of [definition.rangeM,'minRangeM'in definition?definition.minRangeM:0]){
        target.xMm=attacker.xMm+halfSize(target)[0]+units[actorType].collisionRadiusM*1000+range*1000+delta;
        const roster=fixture.context.entities!().filter(activeCombatant),index=new CombatSpatialIndex(roster,filter),eligible=(entity:Combatant)=>fixture.context.hostile('blue',entity.ownerId)&&fixture.context.visible('blue',entity)&&inAttackRange(fixture.context,attacker,entity);
        expect(index.nearest(attacker,definition.rangeM*1000,eligible,'blue')).toBe(legacyNearest(index,roster,attacker,definition.rangeM*1000,eligible));
      }
    }
  });

  it('retains the generic path for unknown owners, malformed owner fields and malformed faction tables',()=>{
    const filter=createCombatOwnerFilter(factions);
    for(const mode of ['unknown-query','unknown-actor','accessor-actor'] as const){
      const origin=unit('origin'),other=unit('other','villager','green',35000,32000);let reads=0;
      if(mode==='unknown-actor')other.ownerId='missing';
      if(mode==='accessor-actor')Object.defineProperty(other,'ownerId',{enumerable:true,get(){reads++;throw new Error('OWNER_ACCESSOR');}});
      const roster=[origin,other],index=new CombatSpatialIndex(roster,filter),actual:string[]=[],expected:string[]=[];
      expect(index.nearest(origin,20000,entity=>{actual.push(entity.id);return false;},mode==='unknown-query'?'missing':'blue')).toBeUndefined();
      legacyNearest(index,roster,origin,20000,entity=>{expected.push(entity.id);return false;});expect(actual).toEqual(expected);expect(actual).toHaveLength(2);expect(reads).toBe(0);
    }
    let reads=0;const accessor={id:'blue',get teamId():string{reads++;throw new Error('TEAM_ACCESSOR');}};
    expect(createCombatOwnerFilter([accessor])).toBeUndefined();expect(reads).toBe(0);
    expect(createCombatOwnerFilter([{id:'blue',teamId:'a'},{id:'blue',teamId:'b'}])).toBeUndefined();
    expect(createCombatOwnerFilter(Array.from({length:12},(_,index)=>({id:`p${index}`,teamId:`t${index}`})))).toBeUndefined();
  });

  it('rebuilds owner relations for each new phase after team, ownership and lifetime changes',()=>{
    const teams=structuredClone(factions),origin=unit('origin'),other=unit('other','militia','green',35000,32000),gate=building('gate','wooden_gate','red',40000,32000);let roster:Combatant[]=[origin,other,gate];
    const query=()=>{const index=new CombatSpatialIndex(roster,createCombatOwnerFilter(teams)),eligible=(entity:Combatant)=>teams.find(faction=>faction.id===entity.ownerId)!.teamId!==teams[0]!.teamId;return index.nearest(origin,20000,eligible,'blue')?.id;};
    expect(query()).toBe('gate');teams[1]!.teamId='red';expect(query()).toBe('other');other.ownerId='blue';expect(query()).toBe('gate');
    gate.ownerId='green';teams[1]!.teamId='allies';expect(query()).toBeUndefined();teams[1]!.teamId='red';expect(query()).toBe('gate');
    gate.hp=0;roster=roster.filter(activeCombatant);expect(query()).toBeUndefined();const born=unit('born','militia','red',34000,32000);roster.push(born);expect(query()).toBe('born');
  });
});

describe('native phase-bound combat roster capability',()=>{
  const factions=[{id:'blue',teamId:'allies'},{id:'green',teamId:'allies'},{id:'red',teamId:'red'}];
  function countActorAudit(roster:readonly Combatant[],construct:()=>CombatSpatialIndex){
    const actors=new Set(roster),read=Object.getOwnPropertyDescriptor;let audits=0;
    const spy=vi.spyOn(Object,'getOwnPropertyDescriptor').mockImplementation((value,key)=>{if(actors.has(value as Combatant)&&['ownerId','kind','typeId','xMm','zMm','rotation'].includes(String(key)))audits++;return read(value,key);});
    try{return {index:construct(),audits};}finally{spy.mockRestore();}
  }
  it('omits actual per-actor descriptor audits only for the exact privately certified phase roster',()=>{
    const origin=unit('origin'),enemy=unit('enemy','villager','red',35000,32000),roster=[origin,enemy],mint=createNativeCombatOwnerFilterScope(),native=mint(factions,'combat',roster)!;
    const owned=countActorAudit(roster,()=>new CombatSpatialIndex(roster,native,'combat')),generic=countActorAudit(roster,()=>new CombatSpatialIndex(roster,createCombatOwnerFilter(factions),'combat'));
    expect(owned.audits).toBe(0);expect(generic.audits).toBe(roster.length*6);
    const select=(index:CombatSpatialIndex)=>index.nearest(origin,20000,candidate=>candidate.ownerId==='red','blue');expect(select(owned.index)).toBe(enemy);expect(select(generic.index)).toBe(enemy);
    expect(countActorAudit(roster,()=>new CombatSpatialIndex(roster,native,'combat')).audits).toBe(roster.length*6);
  });
  it.each(['phase','missing-phase','copied-roster','superseded'] as const)('audits a %s mismatch and permanently consumes the attempted capability',mismatch=>{
    const roster=[unit('origin'),unit('enemy','villager','red',35000,32000)],mint=createNativeCombatOwnerFilterScope(),filter=mint(factions,'engagement',roster)!;
    if(mismatch==='superseded')mint(factions,'combat',roster);
    const input=mismatch==='copied-roster'?[...roster]:roster,phase=mismatch==='phase'?'combat':mismatch==='missing-phase'?undefined:'engagement';
    expect(countActorAudit(roster,()=>new CombatSpatialIndex(input,filter,phase)).audits).toBe(roster.length*6);
    expect(countActorAudit(roster,()=>new CombatSpatialIndex(roster,filter,'engagement')).audits).toBe(roster.length*6);
  });
  it('keeps malformed generic actors on the audited path even when a caller supplies the phase name',()=>{
    const origin=unit('origin'),other=unit('other','villager','green',35000,32000);let reads=0;Object.defineProperty(other,'ownerId',{get(){reads++;throw new Error('GENERIC_OWNER_GETTER');}});
    const roster=[origin,other],index=new CombatSpatialIndex(roster,createCombatOwnerFilter(factions),'engagement'),calls:string[]=[];
    expect(index.nearest(origin,20000,candidate=>{calls.push(candidate.id);return false;},'blue')).toBeUndefined();expect(calls).toEqual(['origin','other']);expect(reads).toBe(0);
  });
  it('takes a fresh phase snapshot after movement, owner/team changes, garrison and death',()=>{
    const teams=structuredClone(factions),origin=unit('origin'),first=unit('z_first','villager','red',35000,32000),second=unit('a_second','villager','red',29000,32000),mint=createNativeCombatOwnerFilterScope();let roster=[origin,first,second];
    const select=(phase:'engagement'|'combat')=>{const owned=new CombatSpatialIndex(roster,mint(teams,phase,roster),phase),generic=new CombatSpatialIndex(roster,createCombatOwnerFilter(teams)),eligible=(candidate:Combatant)=>teams.find(faction=>faction.id===candidate.ownerId)!.teamId!==teams[0]!.teamId;expect(owned.nearest(origin,20000,eligible,'blue')).toBe(generic.nearest(origin,20000,eligible,'blue'));return owned.nearest(origin,20000,eligible,'blue');};
    expect(select('engagement')).toBe(first);first.xMm+=1000;expect(select('combat')).toBe(second);second.ownerId='green';expect(select('engagement')).toBe(first);teams[1]!.teamId='red';expect(select('combat')).toBe(second);
    second.garrisonedIn='home';roster=roster.filter(activeCombatant);expect(select('engagement')).toBe(first);first.hp=0;roster=roster.filter(activeCombatant);expect(select('combat')).toBeUndefined();
  });
});

describe('canonical simulation combat owner filtering',()=>{
  type Internals={hostile(a:string,b:string|null):boolean;orderContext():OrderContext;updateVision():void;nav():unknown};
  function simulation(){
    const sim=createSimulation({factions:[{id:'blue',name:'Blue',teamId:'allies',color:'#3388ff',kind:'human'},{id:'green',name:'Green',teamId:'allies',color:'#44bb55',kind:'human'},{id:'red',name:'Red',teamId:'red',color:'#ee5533',kind:'human'}],seed:'combat-owner-buckets',matchId:'combat-owner-buckets',controllers:false,sharedVision:false});
    const entities:Entity[]=[building('home_blue','town_center','blue',15000,15000),building('home_green','town_center','green',85000,15000),building('home_red','town_center','red',85000,85000),unit('actor','archer','blue',48000,48000),unit('ally','militia','green',50000,48000),unit('z_first','villager','red',54000,48000),unit('a_later','villager','red',42000,48000),building('gate','wooden_gate','red',56000,56000,90)];
    for(const entity of entities)if(entity.kind==='unit'){entity.stance='stand_ground';entity.autoGather=false;if(entity.id!=='actor')entity.cooldown=1000;}
    sim.state.entities=Object.fromEntries(entities.map(entity=>[entity.id,entity]));sim.state.widthMm=sim.state.heightMm=100000;sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
    (sim as unknown as Internals).updateVision();sim.drainJournal();return sim;
  }
  function scalar(sim:Simulation):void {const internal=sim as unknown as Internals,original=internal.hostile;internal.hostile=(a,b)=>original.call(sim,a,b);}
  function equal(actual:Simulation,expected:Simulation,cold?:Simulation):void {
    const recipients=expected.state.factions.map(faction=>faction.id),capture=JSON.stringify(expected.capture()),views=JSON.stringify(expected.views(recipients)),journal=expected.drainJournal();
    for(const sim of [actual,...(cold?[cold]:[])]){expect(JSON.stringify(sim.capture())).toBe(capture);expect(JSON.stringify(sim.views(recipients))).toBe(views);expect(sim.drainJournal()).toEqual(journal);}
  }

  it.each([50,300] as const)('keeps owned combat identical to scalar phases and cold continuation at %i ms',async interval=>{
    const setup=simulation(),options={...setup.options,authoritativeIntervalMs:interval},payload=setup.capture();
    payload.options.authoritativeIntervalMs=interval;
    const target=payload.state.entities.z_first as Unit;target.hp=2;
    const live=createLiveSimulation(options,payload),reference=new Simulation(options,payload);
    let cold:ReturnType<typeof createLiveSimulation>|undefined;
    for(let frame=0;frame<18;frame++){
      live.advanceFrame();reference.advanceFrame();cold?.advanceFrame();
      await live.synchronizeCapture();await reference.synchronizeCapture();await cold?.synchronizeCapture();
      const expected=reference.capture();expect(live.capture()).toEqual(expected);if(cold)expect(cold.capture()).toEqual(expected);
      const ids=options.factions.map(faction=>faction.id);expect(live.views(ids)).toEqual(reference.views(ids));
      if(frame===8)cold=createLiveSimulation(options,expected);
    }
    expect(live.state.entities.z_first).toBeUndefined();
    expect(live.state.entities.ally!.hp).toBe(live.state.entities.ally!.maxHp);
  });

  it('uses the private factory capability to omit actor ownership descriptor audits in real phases',async()=>{
    const setup=simulation(),payload=setup.capture(),options={...setup.options,authoritativeIntervalMs:300 as const};payload.options.authoritativeIntervalMs=300;
    const live=createLiveSimulation(options,payload),reference=new Simulation(options,payload),read=Object.getOwnPropertyDescriptor;
    const advance=(sim:Simulation|ReturnType<typeof createLiveSimulation>)=>{
      let audits=0;const spy=vi.spyOn(Object,'getOwnPropertyDescriptor').mockImplementation((value,key)=>{if(key==='ownerId'&&value&&typeof value==='object'&&read(value,'id')?.value==='actor')audits++;return read(value,key);});
      try{sim.advanceFrame();return audits;}finally{spy.mockRestore();}
    };
    expect(advance(live)).toBe(0);expect(advance(reference)).toBeGreaterThan(0);await live.synchronizeCapture();await reference.synchronizeCapture();expect(live.capture()).toEqual(reference.capture());
  });

  it('revokes the owned combat shortcut when a later nearest hook changes phase behavior',()=>{
    const setup=simulation(),payload=setup.capture(),live=createLiveSimulation(setup.options,payload),reference=new Simulation(setup.options,payload);
    const nearest=CombatSpatialIndex.prototype.nearest;let calls=0;
    CombatSpatialIndex.prototype.nearest=function(origin,reach,eligible,ownerId){calls++;return nearest.call(this,origin,reach,eligible,ownerId);};
    try{live.step(4);reference.step(4);expect(calls).toBeGreaterThan(0);expect(live.capture()).toEqual(reference.capture());}
    finally{CombatSpatialIndex.prototype.nearest=nearest;}
    live.step(4);reference.step(4);expect(live.capture()).toEqual(reference.capture());
  });

  it('matches scalar captures, views and journals through owner/team changes and cold continuation',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);let cold:Simulation|undefined;
    for(const sim of [actual,expected]){const internal=sim as unknown as Internals;internal.nav();const context=internal.orderContext(),roster=context.entities!().filter(activeCombatant);for(const phase of ['engagement','combat'] as const)expect(Boolean(context.ownerFilter?.(phase,roster))).toBe(sim===actual);}
    for(let tick=0;tick<32;tick++){
      for(const sim of [actual,expected,...(cold?[cold]:[])]){
        if(tick===5)sim.state.factions[1]!.teamId='red';
        if(tick===9){(sim.state.entities.ally as Unit).ownerId='blue';(sim.state.entities.gate as Building).ownerId='green';}
        if(tick===14){sim.state.factions[1]!.teamId='red';sim.state.factions[2]!.teamId='allies';}
        if(tick===18){sim.state.factions[1]!.teamId='allies';sim.state.factions[2]!.teamId='red';}
        if(tick===22){const target=sim.state.entities.z_first as Unit;target.garrisonedIn='home_red';(sim.state.entities.home_red as Building).garrisoned=[target.id];}
        if(tick===25){const target=sim.state.entities.z_first as Unit;delete target.garrisonedIn;target.xMm=54000;target.zMm=48000;(sim.state.entities.home_red as Building).garrisoned=[];}
        if(tick===28){sim.state.entities.a_later!.hp=0;const born=unit('born','villager','red',53000,49000);born.autoGather=false;born.stance='stand_ground';born.cooldown=1000;sim.state.entities.born=born;}
        sim.step();
      }
      equal(actual,expected,cold);if(tick===12)cold=new Simulation(actual.options,actual.capture());
    }
    expect(actual.state.tick).toBe(32);
  });

  it('reads a fresh alliance snapshot for combat after engagement selection using the same context',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    const contexts=[actual,expected].map(sim=>(sim as unknown as Internals).orderContext());
    for(let index=0;index<2;index++){
      const sim=[actual,expected][index]!,context=contexts[index]!;(sim as unknown as Internals).nav();expect(Boolean(context.ownerFilter?.('engagement',context.entities!().filter(activeCombatant)))).toBe(index===0);updateEngagements(context);
      const actor=sim.state.entities.actor as Unit;delete actor.engagement;actor.cooldown=0;sim.state.factions[2]!.teamId='allies';sim.state.factions[1]!.teamId='red';expect(Boolean(context.ownerFilter?.('combat',context.entities!().filter(activeCombatant)))).toBe(index===0);advanceCombat(context);
    }
    equal(actual,expected);expect(actual.state.projectiles.find(projectile=>projectile.sourceId==='actor')).toMatchObject({kind:'arrow',targetId:'ally'});
  });

  it('rejects an accessor context state without reading it during certification',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);const reads:number[]=[];
    for(const sim of [actual,expected]){
      const context=(sim as unknown as Internals).orderContext(),roster=context.entities!().filter(activeCombatant),state=context.state;let count=0;
      Object.defineProperty(context,'state',{enumerable:true,configurable:true,get(){count++;return state;}});
      expect(context.ownerFilter?.('engagement',roster)).toBeUndefined();expect(context.ownerFilter?.('combat',roster)).toBeUndefined();expect(count).toBe(0);
      updateEngagements(context);advanceCombat(context);reads.push(count);
    }
    expect(reads[0]).toBeGreaterThan(0);expect(reads[0]).toBe(reads[1]);equal(actual,expected);
  });

  it('keeps a mutating nearest prototype hook scalar before it changes alliance membership',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(const sim of [actual,expected])sim.state.factions[2]!.teamId='allies';
    const original=CombatSpatialIndex.prototype.nearest,touched=new Set<Simulation>();let active:Simulation|undefined;
    const initial=(actual as unknown as Internals).orderContext();expect(initial.ownerFilter?.('engagement',initial.entities!().filter(activeCombatant))).toBeDefined();
    CombatSpatialIndex.prototype.nearest=function(origin,reach,eligible,ownerId){
      if(active&&!touched.has(active)){touched.add(active);active.state.factions[1]!.teamId='red';}
      return original.call(this,origin,reach,eligible,ownerId);
    };
    try{
      for(const sim of [actual,expected]){
        active=sim;const context=(sim as unknown as Internals).orderContext(),roster=context.entities!().filter(activeCombatant);
        expect(context.ownerFilter?.('engagement',roster)).toBeUndefined();updateEngagements(context);advanceCombat(context);
      }
      expect(touched.size).toBe(2);expect((actual.state.entities.actor as Unit).engagement?.targetId).toBe('ally');equal(actual,expected);
    }finally{CombatSpatialIndex.prototype.nearest=original;}
  });

  it.each(['context','instance','prototype'] as const)('preserves a custom %s hostility callback instead of skipping its friendly targets',mode=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);let calls=0;
    const prototype=Simulation.prototype as unknown as Internals,original=prototype.hostile;
    const custom=(a:string,b:string|null)=>{calls++;return a==='blue'&&b==='green';};
    if(mode==='prototype')prototype.hostile=custom;
    try{
      for(const sim of [actual,expected]){
        const internal=sim as unknown as Internals;if(mode==='instance')internal.hostile=custom;
        const context=internal.orderContext();if(mode==='context')context.hostile=custom;else if(mode==='prototype'&&sim===expected)delete (internal as unknown as Record<string,unknown>).hostile;
        expect(context.ownerFilter?.('engagement',context.entities!().filter(activeCombatant))).toBeUndefined();
        updateEngagements(context);advanceCombat(context);
      }
      expect(calls).toBeGreaterThan(0);equal(actual,expected);expect((actual.state.entities.actor as Unit).engagement?.targetId).toBe('ally');
    }finally{prototype.hostile=original;}
  });

  it('keeps first-match faction lookup exact through same-context roster and owner-ID changes',()=>{
    const sim=simulation(),context=(sim as unknown as Internals).orderContext();
    const result=(read:()=>boolean)=>{try{return {value:read()};}catch(error){return {error:(error as Error).name,message:(error as Error).message};}};
    const verify=()=>{for(const a of ['blue','green','red','missing'])for(const b of [null,'blue','green','red','missing'])expect(result(()=>context.hostile(a,b))).toEqual(result(()=>b!==null&&sim.state.factions.find(faction=>faction.id===a)!.teamId!==sim.state.factions.find(faction=>faction.id===b)!.teamId));};
    verify();sim.state.factions[2]!.teamId='allies';verify();
    sim.state.factions.unshift({...sim.state.factions[0]!,teamId:'duplicate-first'});verify();
    sim.state.factions.reverse();verify();sim.state.factions[0]!.id='missing';verify();
    sim.state.factions=sim.state.factions.map(faction=>({...faction,teamId:`new-${faction.id}`}));verify();
    sim.state.factions=sim.state.factions.filter(faction=>faction.id!=='blue');verify();
  });

  it.each(['instance','prototype'] as const)('observes a later %s hostility hook and its removal within one context',scope=>{
    const sim=simulation(),context=(sim as unknown as Internals).orderContext(),target=(scope==='instance'?sim:Simulation.prototype) as unknown as Internals,original=target.hostile;
    expect(context.hostile('blue','green')).toBe(false);let calls=0;
    target.hostile=(a,b)=>{calls++;return a==='blue'&&b==='green';};
    try{expect(context.hostile('blue','green')).toBe(true);expect(context.hostile('blue','red')).toBe(false);expect(calls).toBe(2);}
    finally{if(scope==='prototype')target.hostile=original;else delete (target as unknown as Record<string,unknown>).hostile;}
    expect(context.hostile('blue','green')).toBe(false);expect(context.hostile('blue','red')).toBe(true);
  });
});

describe('phase-local combat candidate filtering',()=>{
  it('matches circular body boundaries and attacks from the edge of a large building',()=>{
    for(const typeId of Object.keys(units) as UnitId[])for(const otherId of Object.keys(units) as UnitId[]){
      const h=harness([unit('actor',typeId),unit('target',otherId,'red')]),actor=h.state.entities.actor as Unit,target=h.state.entities.target as Unit,range=h.context.definition(actor).rangeM*1000;
      for(const delta of [-1,0,1])for(const diagonal of [false,true]){
        const reach=range+(units[typeId].collisionRadiusM+units[otherId].collisionRadiusM)*1000+delta;
        target.xMm=actor.xMm+(diagonal?reach/Math.SQRT2:reach);target.zMm=actor.zMm+(diagonal?reach/Math.SQRT2:0);
        const roster=h.context.entities!().filter(activeCombatant),eligible=(entity:Combatant)=>entity.ownerId==='red'&&inAttackRange(h.context,actor,entity);
        expect(new CombatSpatialIndex(roster).nearest(actor,range,eligible)?.id).toBe(roster.filter(eligible)[0]?.id);
      }
    }
    for(const typeId of ['town_center','fortress'] as const)for(const delta of [-1,0,1]){
      const actor=building('actor',typeId,'blue'),target=unit('target','scout','red');target.cooldown=100;
      target.xMm=actor.xMm+halfSize(actor)[0]+buildings[typeId].rangeM*1000+units.scout.collisionRadiusM*1000+delta;
      const actual=harness([actor,target]),reference=harness([actor,target]);compareCombat(actual,reference);expect(actual.launches).toHaveLength(delta<=0?1:0);
    }
  });
  it('matches whole-roster range selection at circle/rotated footprint/minimum-range boundaries with effective ranges',()=>{
    for(const typeId of Object.keys(units) as UnitId[])for(const targetType of ['wooden_gate','town_center','fortress','monument'] as const)for(const rotation of [0,90,180,270] as const){
      const actor=unit('actor',typeId),target=building('target',targetType,'red',32000,32000,rotation),h=harness([actor,target]);h.upgradedOwners.add('blue');
      const attacker=h.state.entities.actor as Unit,victim=h.state.entities.target as Building,definition=h.context.definition(attacker),[width,height]=halfSize(victim),radius=units[typeId].collisionRadiusM*1000;
      for(const delta of [-1,0,1])for(const axis of ['x','z','diagonal'] as const){
        const reach=definition.rangeM*1000+radius+delta;
        victim.xMm=32000+(axis==='z'?0:width+(axis==='diagonal'?reach/Math.SQRT2:reach));victim.zMm=32000+(axis==='x'?0:height+(axis==='diagonal'?reach/Math.SQRT2:reach));
        const roster=h.context.entities!().filter(activeCombatant),eligible=(entity:Combatant)=>h.context.hostile('blue',entity.ownerId)&&h.context.visible('blue',entity)&&inAttackRange(h.context,attacker,entity);
        expect(new CombatSpatialIndex(roster).nearest(attacker,definition.rangeM*1000,eligible)?.id).toBe(roster.filter(eligible).sort((a,b)=>centerDistance(a,attacker)-centerDistance(b,attacker))[0]?.id);
      }
      if('minRangeM'in definition)for(const delta of [-1,0,1]){
        victim.xMm=32000+width+radius+definition.minRangeM*1000+delta;victim.zMm=32000;
        const roster=h.context.entities!().filter(activeCombatant),eligible=(entity:Combatant)=>entity.ownerId==='red'&&inAttackRange(h.context,attacker,entity);
        expect(new CombatSpatialIndex(roster).nearest(attacker,definition.rangeM*1000,eligible)?.id).toBe(roster.filter(eligible)[0]?.id);
      }
    }
  });
  it('preserves roster ties across buckets and does not substitute another target after a blocked melee ray',()=>{
    const actor=unit('actor','archer','blue',16000,16000),first=unit('z_first','villager','red',21000,16000),later=unit('a_later','villager','red',11000,16000);first.cooldown=later.cooldown=100;
    const actual=harness([actor,first,later]),reference=harness([actor,first,later]);compareCombat(actual,reference);
    expect(actual.state.projectiles[0]).toMatchObject({kind:'arrow',targetId:'z_first'});
    const melee=unit('actor','militia','blue',16000,16000),nearest=unit('nearest','villager','red',17000,16000),alternative=unit('alternative','villager','red',17500,16000);nearest.cooldown=alternative.cooldown=100;
    const blocked=harness([melee,nearest,alternative]),old=harness([melee,nearest,alternative]);blocked.blockedMelee.add('actor:nearest');old.blockedMelee.add('actor:nearest');compareCombat(blocked,old);expect(blocked.launches).toEqual([]);
  });
  it('matches whole-roster selection across mixed stances, orders, fog, dead/contained units, defeated owners and foundations',()=>{
    const types=Object.keys(units) as UnitId[];
    for(let variant=0;variant<12;variant++){
      const entities:Entity[]=[];
      for(let index=0;index<70;index++){
        const actor=unit(`actor_${index}`,types[(index+variant)%types.length]!,(['blue','red','green','fallen'] as const)[index%4],16000+(index%10)*2400+variant*37,16000+Math.floor(index/10)*2500+variant*53);
        actor.stance=(['defensive','aggressive','stand_ground'] as const)[(index+variant)%3];actor.cooldown=index%4;
        switch((index+variant)%8){case 1:actor.orders=[{kind:'gather',targetId:'resource'}];break;case 2:actor.orders=[{kind:'attack_move',target:{xMm:50000,zMm:50000}}];break;case 3:actor.orders=[{kind:'move',target:{xMm:50000,zMm:50000}}];break;case 4:actor.orders=[{kind:'attack',targetId:`actor_${(index+1)%70}`}];break;case 5:actor.orders=[{kind:'repair',targetId:'tower'}];break;case 6:actor.orders=[{kind:'patrol',points:[{xMm:10000,zMm:10000},{xMm:50000,zMm:50000}]}];break;}
        if(index%9===0){actor.lastAttackerId=`actor_${(index+1)%70}`;actor.lastDamagedTick=100-Math.ceil(units[actor.typeId].attackCooldownSeconds*balance.rules.simulationHz)*2+(variant%3)-1;}
        if(index%13===0)actor.hp=0;if(index%17===0)actor.garrisonedIn='tower';if(units[actor.typeId].deploySeconds&&index%2===0)actor.deploymentState='packed';
        if(index%11===0)actor.engagement={targetId:`actor_${(index+1)%70}`,lastKnown:{xMm:0,zMm:0},anchor:{xMm:actor.xMm,zMm:actor.zMm}};
        entities.push(actor);
      }
      entities.push(building('tower','watchtower','blue',22000,20000),building('foundation','watchtower','red',22000,25000),building('gate','wooden_gate','red',26000,18000,(variant%4*90) as Building['rotation']));(entities.at(-2) as Building).work=0;
      for(const phase of ['engagements','combat'] as const){
        const actual=harness(entities),reference=harness(entities);
        for(const h of [actual,reference]){h.upgradedOwners.add('blue');for(let index=0;index<70;index++)if((index+variant)%5===0)h.hidden.add(`blue:actor_${index}`);}
        if(phase==='engagements')compareEngagements(actual,reference);else compareCombat(actual,reference);
      }
    }
  });
  it('retains existing economic engagements and acquires only timely eligible retaliation',()=>{
    for(const mode of ['none','retaliate','expired','stand_ground','retained'] as const){
      const worker=unit('worker','villager'),enemy=unit('enemy','militia','red',35000,32000);worker.orders=[{kind:'gather',targetId:'resource'}];enemy.orders=[{kind:'move',target:{xMm:40000,zMm:40000}}];
      if(mode!=='none'){worker.lastAttackerId='enemy';worker.lastDamagedTick=mode==='expired'?0:100;}
      if(mode==='stand_ground')worker.stance='stand_ground';if(mode==='retained')worker.engagement={targetId:'enemy',lastKnown:{xMm:0,zMm:0},anchor:{xMm:32000,zMm:32000}};
      const actual=harness([worker,enemy]),reference=harness([worker,enemy]);compareEngagements(actual,reference);
      expect((actual.state.entities.worker as Unit).engagement?.targetId).toBe(mode==='retaliate'||mode==='retained'?'enemy':undefined);
      if(mode==='none'||mode==='expired'||mode==='stand_ground')expect(actual.visibilityCalls).toEqual([]);
    }
  });
  it('keeps defeated survivors targetable while excluding dead and contained units',()=>{
    const actor=unit('actor'),dead=unit('dead','villager','red',33000,32000),contained=unit('contained','villager','red',34000,32000),fallen=unit('fallen','archer','fallen',36000,32000);
    dead.hp=0;contained.garrisonedIn='tower';
    const actual=harness([actor,dead,contained,fallen]),reference=harness([actor,dead,contained,fallen]);compareEngagements(actual,reference);expect((actual.state.entities.actor as Unit).engagement?.targetId).toBe('fallen');
    compareCombat(actual,reference);expect(actual.launches.map(launch=>launch.id)).toEqual(['actor']);expect(actual.state.projectiles[0]).toMatchObject({kind:'arrow',targetId:'fallen'});
  });
  it('rebuilds candidates after movement, changed fog, garrison/death and same-tick creation between phases',()=>{
    const actor=unit('actor','archer'),old=unit('old','villager','red',37000,32000),newlySeen=unit('new','villager','red',100000,32000);old.cooldown=newlySeen.cooldown=100;
    const actual=harness([actor,old,newlySeen]),reference=harness([actor,old,newlySeen]);for(const h of [actual,reference]){h.hidden.add('blue:old');h.hidden.add('blue:new');}compareEngagements(actual,reference);expect((actual.state.entities.actor as Unit).engagement).toBeUndefined();
    for(const h of [actual,reference]){h.state.entities.new!.xMm=36500;h.hidden.delete('blue:old');h.hidden.delete('blue:new');(h.state.entities.old as Unit).garrisonedIn='tower';const dead=unit('dead','villager','red',33000,32000);dead.hp=0;h.state.entities.dead=dead;h.state.entities.created=building('created','house','red',39000,32000);}
    compareCombat(actual,reference);expect(actual.state.projectiles[0]).toMatchObject({kind:'arrow',targetId:'new'});
  });
  it('prunes distant fog queries while producing the same engagement and launch',()=>{
    const actor=unit('actor','archer'),near=unit('near','villager','red',37000,32000);near.cooldown=100;near.orders=[{kind:'move',target:{xMm:50000,zMm:32000}}];
    const entities:Entity[]=[actor,near,...Array.from({length:400},(_,index)=>building(`remote_${index}`,'house','red',200000+index%20*4000,200000+Math.floor(index/20)*4000))];
    for(const phase of ['engagements','combat'] as const){const actual=harness(entities),reference=harness(entities);if(phase==='engagements')compareEngagements(actual,reference);else compareCombat(actual,reference);expect(reference.visibilityCalls.length).toBeGreaterThan(400);expect(actual.visibilityCalls.length).toBeLessThan(10);}
  });
});

describe('nearby military acquisition and defensive return',()=>{
  it.each(['defensive','aggressive'] as const)('acquires a visible hostile at the configured radius in %s stance without extending weapon range',stance=>{
    for(const delta of [0,1]){
      const actor=unit('guard','militia'),enemy=unit('enemy','villager','red',actor.xMm+balance.rules.combatAcquisitionRadiusM*1000+delta),ally=building('ally','house','green',actor.xMm+3000);
      actor.stance=stance;enemy.cooldown=1000;const h=harness([actor,enemy,ally]);updateEngagements(h.context);
      expect((h.state.entities.guard as Unit).engagement?.targetId).toBe(delta===0?'enemy':undefined);
      expect((h.state.entities.guard as Unit).orders).toEqual([]);advanceCombat(h.context);expect(h.launches).toEqual([]);expect(h.state.entities.enemy!.hp).toBe(enemy.hp);
    }
  });
  it.each(['stand_ground','move','worker','gather','repair','garrison'] as const)('preserves the %s restriction against unsolicited pursuit',mode=>{
    const actor=unit('guard',mode==='worker'||mode==='gather'||mode==='repair'?'villager':'militia'),enemy=unit('enemy','villager','red',37000);
    if(mode==='stand_ground')actor.stance='stand_ground';
    if(mode==='move')actor.orders=[{kind:'move',target:{xMm:25000,zMm:32000}}];
    if(mode==='gather')actor.orders=[{kind:'gather',targetId:'tree'}];
    if(mode==='repair')actor.orders=[{kind:'repair',targetId:'allied_house'}];
    if(mode==='garrison')actor.orders=[{kind:'garrison',targetId:'town'}];
    const h=harness([actor,enemy]);updateEngagements(h.context);expect((h.state.entities.guard as Unit).engagement).toBeUndefined();expect((h.state.entities.guard as Unit).orders).toEqual(actor.orders);
  });
  it('uses only authorized visible candidates and preserves stand-ground retaliation within weapon range',()=>{
    const actor=unit('guard','militia'),hidden=unit('hidden','villager','red',35000),contained=unit('contained','villager','red',36000),visible=unit('visible','villager','red',42000);
    contained.garrisonedIn='enemy_town';const h=harness([actor,hidden,contained,visible]);h.hidden.add('blue:hidden');updateEngagements(h.context);expect((h.state.entities.guard as Unit).engagement?.targetId).toBe('visible');
    const standing=unit('standing','militia'),near=unit('near','villager','red',33500);standing.stance='stand_ground';near.cooldown=1000;
    const close=harness([standing,near]);updateEngagements(close.context);advanceCombat(close.context);expect(close.launches.map(e=>e.id)).toEqual(['standing']);expect((close.state.entities.standing as Unit).orders).toEqual([]);
  });
  it('returns to the original anchor instead of reacquiring a visible enemy from a creeping defensive leash',()=>{
    const actor=unit('guard','militia','blue',35000),enemy=unit('enemy','villager','red',45000),anchor={xMm:32000,zMm:32000};
    actor.engagement={targetId:enemy.id,lastKnown:{xMm:44000,zMm:32000},anchor};actor.path=[{xMm:44000,zMm:32000}];
    const h=harness([actor,enemy]);updateEngagements(h.context);const returned=h.state.entities.guard as Unit;
    expect(returned.engagement).toBeUndefined();expect(returned.orders).toEqual([{kind:'move',target:anchor}]);expect(returned.path).toEqual([]);expect(h.cancelled).toEqual(['guard']);
    h.state.tick++;updateEngagements(h.context);expect(returned.engagement).toBeUndefined();expect(returned.orders).toEqual([{kind:'move',target:anchor}]);
  });
  it('returns to the same known anchor when hidden targets move and leaves attack-move queues intact after target loss',()=>{
    const create=(xMm:number)=>{const actor=unit('guard','militia','blue',35000),enemy=unit('enemy','villager','red',xMm);actor.engagement={targetId:'enemy',lastKnown:{xMm:40000,zMm:32000},anchor:{xMm:32000,zMm:32000}};const h=harness([actor,enemy]);h.hidden.add('blue:enemy');return h;};
    const first=create(45000),second=create(180000);updateEngagements(first.context);updateEngagements(second.context);expect(first.state.entities.guard).toEqual(second.state.entities.guard);expect(first.cancelled).toEqual(second.cancelled);
    const actor=unit('moving','militia','blue',35000),enemy=unit('enemy','villager','red',40000);actor.orders=[{kind:'attack_move',target:{xMm:50000,zMm:32000}},{kind:'move',target:{xMm:55000,zMm:32000}}];actor.engagement={targetId:'enemy',lastKnown:{xMm:40000,zMm:32000},anchor:{xMm:32000,zMm:32000}};enemy.hp=0;
    const h=harness([actor,enemy]);updateEngagements(h.context);expect((h.state.entities.moving as Unit).engagement).toBeUndefined();expect((h.state.entities.moving as Unit).orders).toEqual(actor.orders);
  });
});
