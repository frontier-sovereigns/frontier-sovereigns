import { describe, expect, it } from 'vitest';
import { balance, buildings, units, technologies, legendaryExpansion, effectiveFarmCapacity, effectiveUnit, unitVisualTier, type BuildingId, type GameplayCommand, type TechnologyId, type UnitId } from '@frontier/shared';
import { createSimulation, type Building, type Simulation, type Unit } from '../src/index.js';
import { Progression } from '../src/progression.js';

const hz=balance.rules.simulationHz,scale=balance.rules.resourceScale;
const fixtureIds=new WeakMap<Simulation,number>();
function nextId(sim:Simulation){const next=(fixtureIds.get(sim)??0)+1;fixtureIds.set(sim,next);return `fixture_${next}`;}
function fixture(age=1,later=false){
  const sim=createSimulation({...(later?{rulesetId:'legendary_ages_v1' as const,maxAge:8 as const,startingResourcePreset:'standard' as const}:{}),seed:'progression-fixture',matchId:'progression',controllers:false,factions:[{id:'blue',name:'Blue',teamId:'blue',color:'#3388ff',kind:'human'},{id:'red',name:'Red',teamId:'red',color:'#ee5533',kind:'human'}]});
  // Explicit mechanical fixtures; the separate ordinary-resource progression
  // scenario retains generated starts and never supplies banks, ages or work.
  sim.state.entities={};sim.state.widthMm=120000;sim.state.heightMm=120000;sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
  for(const economy of Object.values(sim.state.economies)){economy.age=age;economy.resources={food:10000000,wood:10000000,gold:10000000,stone:10000000};}
  const home=structure(sim,'town_center',24000,24000),enemy=structure(sim,'town_center',100000,100000,'red'),worker=unit(sim,'villager',35000,32000);sim.step();return {sim,home,enemy,worker};
}
function structure(sim:Simulation,typeId:BuildingId,xMm=50000,zMm=50000,ownerId='blue',complete=true):Building{
  const def=buildings[typeId],required=def.buildSeconds*hz*100,hp=complete?def.maxHp:Math.floor(def.maxHp*.1),building:Building={id:nextId(sim),kind:'building',typeId,ownerId,xMm,zMm,hp,maxHp:def.maxHp,rotation:0,work:complete?required:0,required,grantedHp:hp,queue:[],cooldown:0,...(typeId==='farm'?{foodRemaining:350000}:{})};sim.state.entities[building.id]=building;sim.state.navigationRevision++;return building;
}
function unit(sim:Simulation,typeId:UnitId,xMm=40000,zMm=40000,ownerId='blue'):Unit{
  const def=units[typeId],result:Unit={id:nextId(sim),kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground'};sim.state.entities[result.id]=result;return result;
}
function send(sim:Simulation,command:GameplayCommand,owner='blue'){const sequence=sim.state.economies[owner]!.lastClientSequence+1;return sim.command(owner,{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${owner}_${sequence}`,clientSequence:sequence,command});}
function prerequisites(sim:Simulation,targetAge:2|3|4,owner='blue'):Building[]{
  const required=balance.ages.find(age=>age.id===targetAge)!.prerequisites.flatMap(p=>p.kind==='completed_buildings'?p.types:p.types.slice(0,p.count));return required.map((type,index)=>structure(sim,type,50000+index*12000,20000,owner));
}
function research(sim:Simulation,producer:Building,id:TechnologyId){const receipt=send(sim,{kind:'research',buildingId:producer.id,technologyId:id},producer.ownerId);expect(receipt.status,receipt.code).toBe('accepted');return producer.queue.at(-1)!;}

describe('M4 authoritative age and shared producer queues',()=>{
  it.each([2,3,4] as const)('pays the exact Age %i cost and completes on its catalogue tick without granting technologies',age=>{
    const {sim,home}=fixture(age-1),definition=balance.ages.find(entry=>entry.id===age)!;prerequisites(sim,age);const wall=structure(sim,'palisade_wall',44000,42000);wall.hp-=10;
    sim.state.economies.blue!.resources={food:definition.cost.food*scale,wood:0,gold:definition.cost.gold*scale,stone:0};
    expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:age}).status).toBe('accepted');const job=home.queue[0]!,id=job.id,start=sim.state.tick;
    expect(job).toMatchObject({kind:'age',typeId:`age_${age}`,originalCost:definition.cost,required:definition.researchSeconds*hz,reserved:false});expect(sim.view('blue').self.resources).toEqual({food:0,wood:0,gold:0,stone:0});
    sim.step(job.required-1);expect(sim.state.economies.blue!.age).toBe(age-1);expect(home.queue[0]!.id).toBe(id);expect(sim.view('blue').self.reservedPopulation).toBe(0);
    sim.step();expect(sim.state.economies.blue!.age).toBe(age);expect(home.queue).toHaveLength(0);expect(sim.view('blue').self.technologies).toEqual([]);expect(wall).toMatchObject({typeId:'palisade_wall',hp:buildings.palisade_wall.maxHp-10});
    expect(sim.view('red').ageAnnouncements).toEqual([{playerId:'blue',age,tick:start+definition.researchSeconds*hz}]);expect(sim.state.economies.blue!.statistics.ageTicks[age]).toBe(sim.state.tick);
  });
  it('requires distinct completed prerequisite types and rejects skipping, pending duplicates and shortfalls atomically',()=>{
    const {sim,home}=fixture(),second=structure(sim,'town_center',76000,24000);structure(sim,'mill');structure(sim,'mill',62000);
    const before=structuredClone(sim.state.economies.blue!.resources);expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:3}).code).toBe('INVALID_AGE');expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2}).code).toBe('PREREQUISITES_REQUIRED');expect(home.queue).toHaveLength(0);expect(sim.state.economies.blue!.resources).toEqual(before);
    const camp=structure(sim,'lumber_camp',74000,50000,'blue',false);expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2}).code).toBe('PREREQUISITES_REQUIRED');camp.work=camp.required;
    sim.state.economies.blue!.resources.food=549999;const missing=send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2});expect(missing.code).toBe('INSUFFICIENT_RESOURCES');expect(missing.missingResources?.food).toBe(1);expect(home.queue).toHaveLength(0);
    sim.state.economies.blue!.resources.food=550000;expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2}).status).toBe('accepted');const paid=structuredClone(sim.state.economies.blue!.resources);expect(send(sim,{kind:'advance_age',townCenterId:second.id,targetAge:2}).code).toBe('AGE_PENDING');expect(sim.state.economies.blue!.resources).toEqual(paid);expect(second.queue).toHaveLength(0);
  });
  it('shares six FIFO slots across training, research and ages and refunds captured costs exactly',()=>{
    const {sim,home}=fixture(2);prerequisites(sim,3);
    send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});const technology=research(sim,home,'wheelbarrow');send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:3});send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:3});
    expect(home.queue.map(job=>job.kind)).toEqual(['train','research','age','train','train','train']);const bank=structuredClone(sim.state.economies.blue!.resources);expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:2}).code).toBe('QUEUE_FULL');expect(sim.state.economies.blue!.resources).toEqual(bank);
    sim.step();expect(sim.view('blue').self.reservedPopulation).toBe(1);expect(home.queue.slice(1).every(job=>job.work===0&&!job.reserved)).toBe(true);send(sim,{kind:'cancel_job',buildingId:home.id,jobId:home.queue[0]!.id});
    sim.step(technology.required*.4);expect(technology.work/technology.required).toBe(.4);expect(sim.view('blue').self.reservedPopulation).toBe(0);const waitingAge=home.queue[1]!,before=structuredClone(sim.state.economies.blue!.resources);
    send(sim,{kind:'cancel_job',buildingId:home.id,jobId:waitingAge.id});expect(sim.state.economies.blue!.resources.food-before.food).toBe(800000);expect(sim.state.economies.blue!.resources.gold-before.gold).toBe(300000);
    const paid=structuredClone(sim.state.economies.blue!.resources);send(sim,{kind:'cancel_job',buildingId:home.id,jobId:technology.id});expect(sim.state.economies.blue!.resources.food-paid.food).toBe(67000);expect(sim.state.economies.blue!.resources.wood-paid.wood).toBe(22000);expect(sim.state.economies.blue!.technologies).toEqual([]);
    research(sim,home,'wheelbarrow');
  });
  it('blocks a waiting age after prerequisite loss, then starts after replacement and ignores later prerequisite loss',()=>{
    const {sim,home}=fixture(),required=prerequisites(sim,2);send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2});const job=home.queue[1]!;
    required[0]!.hp=0;sim.step(units.villager.trainSeconds*hz+1);expect(job).toMatchObject({work:0,started:false,reserved:false,state:'prerequisite_blocked',blockedReason:'PREREQUISITES_REQUIRED'});expect(sim.view('blue').entities.find(e=>e.id===home.id)!.queue![0]).toMatchObject({kind:'age',blockedReason:'PREREQUISITES_REQUIRED'});
    structure(sim,required[0]!.typeId,required[0]!.xMm,required[0]!.zMm);sim.step();expect(job).toMatchObject({work:1,started:true,state:'active'});required[1]!.hp=0;sim.step(job.required-1);expect(sim.state.economies.blue!.age).toBe(2);
  });
  it('keeps a population-blocked training head ahead of paid research and permits its unstarted full refund',()=>{
    const {sim,home}=fixture(2);for(let index=0;index<9;index++)unit(sim,'villager',10000+index*1000,40000);send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});const job=research(sim,home,'wheelbarrow');sim.step(20);
    expect(home.queue[0]!.state).toBe('population_blocked');expect(job).toMatchObject({work:0,started:false,reserved:false});const bank=structuredClone(sim.state.economies.blue!.resources);send(sim,{kind:'cancel_job',buildingId:home.id,jobId:job.id});expect(sim.state.economies.blue!.resources.food-bank.food).toBe(150000);expect(sim.state.economies.blue!.resources.wood-bank.wood).toBe(50000);
  });
  it('cleans pending jobs after producer destruction and defeat without refunds or completion',()=>{
    const {sim,home}=fixture(2),first=structure(sim,'lumber_camp'),second=structure(sim,'lumber_camp',65000);const job=research(sim,first,'forestry_1');expect(send(sim,{kind:'research',buildingId:second.id,technologyId:'forestry_1'}).code).toBe('RESEARCH_PENDING');
    sim.step();const bank=structuredClone(sim.state.economies.blue!.resources);first.hp=0;sim.step();expect(sim.state.entities[first.id]).toBeUndefined();expect(sim.state.economies.blue!.resources).toEqual(bank);expect(sim.state.economies.blue!.technologies).toEqual([]);expect(job.work).toBe(1);research(sim,second,'forestry_1');
    prerequisites(sim,3);send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:3});send(sim,{kind:'surrender'});expect(second.queue).toHaveLength(0);expect(home.queue).toHaveLength(0);expect(sim.view('blue').self.reservedPopulation).toBe(0);expect(sim.state.economies.blue!.technologies).toEqual([]);
  });
});

describe('M4 upgrades, exact arithmetic and observation',()=>{
  it('keeps derived visual tiers equal to researched content across faction revisions and cold reconstruction',()=>{
    const {sim}=fixture(4),progression=new Progression(sim.state),types=balance.units.map(unit=>unit.id);
    const check=()=>{
      const cold=new Progression(structuredClone(sim.state));
      for(const playerId of ['blue','red'])for(const type of types){
        const expected=unitVisualTier(type,sim.state.economies[playerId]!.technologies);
        expect(progression.visualTier(playerId,type)).toBe(expected);expect(cold.visualTier(playerId,type)).toBe(expected);
      }
    };
    check();
    for(const id of ['veteran_militia','elite_militia','veteran_archer','elite_archer','elite_knight'] as const){progression.completeResearch('blue',id);check();}
    progression.completeResearch('red','veteran_militia');check();
    expect(progression.visualTier('blue','militia')).toBe('elite');expect(progression.visualTier('red','militia')).toBe('veteran');
  });
  it('upgrades injured existing and future trained units once while preserving identity, orders and active cooldowns',()=>{
    const {sim}=fixture(3),barracks=structure(sim,'barracks'),existing=unit(sim,'militia',40000,60000),unaffected=unit(sim,'battering_ram',44000,60000);existing.hp-=7;existing.cooldown=4000;const id=existing.id,order={kind:'move' as const,target:{xMm:40000,zMm:61000}};existing.orders=[order];const job=research(sim,barracks,'veteran_militia');send(sim,{kind:'train',buildingId:barracks.id,unitType:'militia',quantity:1});sim.step(job.required);
    expect(existing).toMatchObject({id,maxHp:70,hp:63,cooldown:4000-job.required});expect(unaffected.maxHp).toBe(units.battering_ram.maxHp);expect(sim.state.economies.blue!.technologies).toEqual(['veteran_militia']);expect(send(sim,{kind:'research',buildingId:barracks.id,technologyId:'veteran_militia'}).code).toBe('ALREADY_RESEARCHED');
    sim.step(units.militia.trainSeconds*hz);const future=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='militia'&&entity.id!==id)!;expect(future).toMatchObject({maxHp:70,hp:70});expect(sim.view('blue').entities.find(e=>e.id===id)?.visualTier).toBe('veteran');
  });
  it('preserves foundation progress and combat damage plus exact repair debt through Masonry',()=>{
    const {sim,worker}=fixture(3),university=structure(sim,'university',70000,65000),foundation=structure(sim,'house',52000,52000,'blue',false),completed=structure(sim,'house',64000,52000);foundation.work=foundation.required/2;foundation.grantedHp=330;foundation.hp=300;completed.hp=570;completed.repairDenominator=600;completed.repairRemainders={blue:{food:0,wood:1,gold:0,stone:0}};
    const work=foundation.work,id=foundation.id,job=research(sim,university,'masonry');sim.step(job.required);expect(foundation).toMatchObject({id,work,maxHp:720,grantedHp:396,hp:366});expect(completed).toMatchObject({maxHp:720,hp:690,grantedHp:720,repairDenominator:3600});expect(completed.repairRemainders!.blue!.wood).toBe(6);
    worker.xMm=completed.xMm-2850;worker.zMm=completed.zMm;sim.step();const bank=sim.state.economies.blue!.resources.wood;send(sim,{kind:'repair',unitIds:[worker.id],targetId:completed.id,queued:false});sim.step(2);const numerator=6+Math.round(buildings.house.cost.wood*scale*balance.rules.repairFullHpCostFraction)*5;expect(completed.hp).toBe(691);expect(bank-sim.state.economies.blue!.resources.wood).toBe(Math.floor(numerator/3600));expect(completed.repairRemainders!.blue!.wood).toBe(numerator%3600);
    worker.xMm=foundation.xMm-2850;worker.zMm=foundation.zMm;send(sim,{kind:'continue_build',builderIds:[worker.id],foundationId:id,queued:false});sim.step(Math.ceil((foundation.required-work)/100));expect(foundation).toMatchObject({maxHp:720,hp:690,grantedHp:720});
    // Observe the complete resource-clearance halo before testing the new
    // foundation's upgraded HP; a builder's partial sight is insufficient.
    unit(sim,'scout',94000,30000);worker.xMm=82000;worker.zMm=28000;worker.orders=[];sim.step();const purchase=send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:43,z:14},rotation:0,queued:false});expect(purchase.status,purchase.code).toBe('accepted');const future=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='house'&&entity.id!==foundation.id&&entity.id!==completed.id)!;expect(future).toMatchObject({maxHp:720,hp:72,grantedHp:72,work:0});
  });
  it.each([['wood',1885],['gold',1560],['stone',1560],['forage',1400],['farm',1950]] as const)('retains exact upgraded %s gathering without losing fractional milli-resources', (resource,expected)=>{
    const {sim,worker}=fixture(4),progression=new Progression(sim.state);for(const technology of balance.technologies)progression.completeResearch('blue',technology.id);worker.xMm=resource==='farm'?37150:39000;worker.zMm=40000;
    const node=resource==='farm'?structure(sim,'farm',40000,40000):{id:'resource',kind:'resource' as const,typeId:'fixture_resource',ownerId:null,hp:1,maxHp:1,xMm:40000,zMm:40000,resource:resource==='forage'?'food' as const:resource,amount:100000};if(node.kind==='resource'){sim.state.entities[node.id]=node;sim.state.navigationRevision++;}
    sim.step();expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:node.id,queued:false}).status).toBe('accepted');sim.step(20);if(resource==='wood'){expect(worker.cargo.amount).toBe(942);expect(worker.gatherRemainder).toBe(10000);}sim.step(20);expect(worker.cargo.amount).toBe(expected);expect(worker.gatherRemainder).toBe(0);expect(sim.view('blue').self.technologies).toHaveLength(29);
  });
  it('uses upgraded carrying and speed for current and future villagers',()=>{
    const {sim,home,worker}=fixture(3),progression=new Progression(sim.state);progression.completeResearch('blue','wheelbarrow');progression.completeResearch('blue','hand_cart');worker.xMm=40000;worker.zMm=40000;sim.step();send(sim,{kind:'move',unitIds:[worker.id],target:{xMm:45000,zMm:40000},queued:false});sim.step();const before=worker.xMm;sim.step();expect(worker.xMm-before).toBe(180);
    send(sim,{kind:'stop',unitIds:[worker.id]});worker.xMm=39000;worker.zMm=40000;const tree={id:'carry_tree',kind:'resource' as const,typeId:'tree',ownerId:null,resource:'wood' as const,amount:100000,xMm:40000,zMm:40000,hp:1,maxHp:1};sim.state.entities[tree.id]=tree;sim.state.navigationRevision++;sim.step();send(sim,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false});sim.step(750);expect(worker.cargo.amount).toBeGreaterThan(20000);expect(worker.cargo.amount).toBeLessThanOrEqual(25000);
    send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});sim.step(units.villager.trainSeconds*hz);expect(effectiveUnit('villager',sim.state.economies.blue!.technologies)).toMatchObject({moveSpeedMps:3.6,carryCapacity:25});
  });
  it('keeps launched damage snapshots while applying new target armor at impact and upgraded range on later shots',()=>{
    const {sim}=fixture(4),archer=unit(sim,'archer',50000,60000),victim=unit(sim,'militia',55000,60000,'red');victim.cooldown=10000;sim.step();const projectile=sim.state.projectiles.find(p=>p.sourceId===archer.id)!;expect(projectile.attack.attack).toBe(4);const progression=new Progression(sim.state);progression.completeResearch('blue','fletching_1');progression.completeResearch('red','melee_armor_1');sim.step(projectile.hitTick-sim.state.tick);expect(victim.hp).toBe(units.militia.maxHp-2);expect(projectile.attack.attack).toBe(4);
    const distant=unit(sim,'militia',57000,60000,'red');victim.xMm=90000;victim.zMm=20000;archer.cooldown=0;sim.step();const next=sim.state.projectiles.find(p=>p.sourceId===archer.id)!;expect(next.attack.attack).toBe(5);expect(next.kind==='arrow'&&next.targetId).toBe(distant.id);
  });
  it('announces an enemy age without updating hidden building visual age, HP or research state',()=>{
    const {sim,enemy}=fixture(),required=prerequisites(sim,2,'red'),house=structure(sim,'house',70000,80000,'red'),observer=unit(sim,'scout',62000,80000);sim.step();expect(sim.view('blue').entities.find(e=>e.id===house.id)?.visualAge).toBe(1);observer.xMm=15000;observer.zMm=45000;sim.step();const ghost=sim.view('blue').entities.find(e=>e.id===house.id)!;
    send(sim,{kind:'advance_age',townCenterId:enemy.id,targetAge:2},'red');sim.step(90*hz);const view=sim.view('blue');expect(view.players.find(p=>p.id==='red')?.age).toBe(2);expect(view.entities.find(e=>e.id===house.id)).toEqual(ghost);expect(view.self.technologies).toEqual([]);expect(view.entities.filter(e=>e.ownerId==='red').every(e=>e.queue===undefined)).toBe(true);expect(required).toHaveLength(2);
    observer.xMm=62000;observer.zMm=80000;sim.step();expect(sim.view('blue').entities.find(e=>e.id===house.id)).toMatchObject({visualAge:2,hp:600});
  });
});


describe('continued-age progression admission',()=>{
  it('blocks an unstarted fifth age on prerequisite loss, then preserves started research rules',()=>{
    const {sim,home}=fixture(4,true);structure(sim,'fortress',70000,70000);structure(sim,'university',50000,70000);const market=structure(sim,'market',75000,25000);
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:5}).status).toBe('accepted');
    const job=home.queue[1]!;sim.step();home.queue[0]!.work=home.queue[0]!.required-1;market.hp=0;sim.step(2);
    expect(job).toMatchObject({work:0,started:false,state:'prerequisite_blocked'});
    structure(sim,'market',75000,25000);sim.step();expect(job.started).toBe(true);for(const entity of Object.values(sim.state.entities))if(entity.typeId==='market')entity.hp=0;
    job.work=job.required-1;sim.step();expect(sim.state.economies.blue!.age).toBe(5);
    structure(sim,'grand_citadel',65000,70000);structure(sim,'great_siege_yard',90000,60000);
    expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:6}).status).toBe('accepted');sim.step();const bank={...sim.state.economies.blue!.resources};home.hp=0;sim.step();expect(sim.state.economies.blue!.age).toBe(5);expect(sim.state.economies.blue!.resources).toEqual(bank);expect(sim.state.entities[home.id]).toBeUndefined();
  });
  it('purchases all twelve later technologies once without refilling an existing farm',()=>{
    const {sim}=fixture(8,true);sim.state.economies.blue!.resources={food:100000000,wood:100000000,gold:100000000,stone:100000000};
    const producers=new Map(['university','blacksmith','market','rune_forge'].map((type,index)=>[type,structure(sim,type as BuildingId,50000+index*20000,70000)]));
    const farm=structure(sim,'farm',100000,40000);farm.foodRemaining=123000;
    for(const definition of legendaryExpansion.technologies){
      const producer=producers.get(definition.researchedAt)!;expect(producer,definition.id).toBeDefined();const before={...sim.state.economies.blue!.resources},job=research(sim,producer,definition.id);
      for(const resource of balance.resourceOrder)expect(before[resource]-sim.state.economies.blue!.resources[resource],definition.id).toBe(definition.cost[resource]*scale);
      sim.step();expect(job.started,definition.id).toBe(true);job.work=job.required-1;sim.step();expect(sim.state.economies.blue!.technologies).toContain(definition.id);expect(send(sim,{kind:'research',buildingId:producer.id,technologyId:definition.id}).code).toBe('ALREADY_RESEARCHED');expect(farm.foodRemaining).toBe(123000);
    }
    expect(sim.state.economies.blue!.technologies).toHaveLength(12);expect(effectiveFarmCapacity(sim.state.economies.blue!.technologies)).toBe(750);
    const current=new Progression(sim.state),cold=new Progression(structuredClone(sim.state));for(const type of Object.keys(units) as UnitId[])expect(current.unit('blue',type)).toEqual(cold.unit('blue',type));
  });
  it('rejects an unaffordable mixed structure batch without partial upgrades or spending',()=>{
    const {sim}=fixture(8,true),walls=[structure(sim,'stone_wall',50000,50000),structure(sim,'stone_wall',54000,50000)];
    sim.state.economies.blue!.technologies=['citadel_engineering'];sim.state.economies.blue!.researchRevision++;sim.step();sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:1};const bank={...sim.state.economies.blue!.resources};
    expect(send(sim,{kind:'upgrade_structure',buildingIds:walls.map(wall=>wall.id),targetTypeId:'bastion_wall'}).code).toBe('INSUFFICIENT_RESOURCES');expect(walls.every(wall=>wall.typeId==='stone_wall'&&!wall.upgrade)).toBe(true);expect(sim.state.economies.blue!.resources).toEqual(bank);
  });
});
