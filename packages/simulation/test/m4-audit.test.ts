import { describe, expect, it } from 'vitest';
import { balance, buildings, units, technologies, validatePlayerView, type BuildingId, type ClientCommandEnvelope, type GameplayCommand, type ResourceBank, type TechnologyId, type UnitId } from '@frontier/shared';
import { createSimulation, type Building, type ProductionJob, type Simulation, type Unit } from '../src/index.js';

const hz=balance.rules.simulationHz,scale=balance.rules.resourceScale;
const zero=():ResourceBank=>({food:0,wood:0,gold:0,stone:0});
const counters=new WeakMap<Simulation,number>();
function id(sim:Simulation){const next=(counters.get(sim)??0)+1;counters.set(sim,next);return `audit_${next}`;}
function building(sim:Simulation,typeId:BuildingId,xMm:number,zMm:number,ownerId='blue',complete=true):Building{
  const def=buildings[typeId],required=def.buildSeconds*hz*100,hp=complete?def.maxHp:Math.floor(def.maxHp*balance.rules.foundationStartingHpFraction);
  const entity:Building={id:id(sim),kind:'building',typeId,ownerId,xMm,zMm,hp,maxHp:def.maxHp,rotation:0,work:complete?required:0,required,grantedHp:hp,queue:[],cooldown:0};
  sim.state.entities[entity.id]=entity;sim.state.navigationRevision++;return entity;
}
function unit(sim:Simulation,typeId:UnitId,xMm:number,zMm:number,ownerId='blue'):Unit{
  const def=units[typeId],entity:Unit={id:id(sim),kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground'};
  sim.state.entities[entity.id]=entity;return entity;
}
function fixture(age=4){
  const sim=createSimulation({seed:'m4-independent-audit',matchId:'m4-audit',controllers:false,factions:[{id:'blue',name:'Blue',teamId:'blue',color:'#3388ff',kind:'human'},{id:'red',name:'Red',teamId:'red',color:'#ee5533',kind:'human'}]});
  // These are explicit mechanics fixtures, not the separate standard-start,
  // ordinary-resource four-age scenario. Research progress is never granted.
  sim.state.entities={};sim.state.widthMm=120000;sim.state.heightMm=120000;sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};}
  for(const economy of Object.values(sim.state.economies)){economy.age=age;economy.resources={food:10000000,wood:10000000,gold:10000000,stone:10000000};}
  const home=building(sim,'town_center',16000,16000),enemy=building(sim,'town_center',105000,105000),worker=unit(sim,'villager',82000,30000);
  enemy.ownerId='red';sim.step();return {sim,home,enemy,worker};
}
function envelope(sim:Simulation,command:GameplayCommand,owner='blue'):ClientCommandEnvelope{
  const sequence=sim.state.economies[owner]!.lastClientSequence+1;return {protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${owner}_${sequence}`,clientSequence:sequence,command};
}
function send(sim:Simulation,command:GameplayCommand,owner='blue'){return sim.command(owner,envelope(sim,command,owner));}
function enqueue(sim:Simulation,producer:Building,technologyId:TechnologyId){const receipt=send(sim,{kind:'research',buildingId:producer.id,technologyId});expect(receipt.status,receipt.code).toBe('accepted');return producer.queue.at(-1)!;}

describe('independent M4 command, lifecycle and privacy audit',()=>{
  it('pays and completes all 29 real research jobs with exact FIFO durations while enemy memories stay unchanged',()=>{
    const {sim,home}=fixture(),producers=new Map<BuildingId,Building>([['town_center',home]]);
    for(const typeId of new Set(balance.technologies.map(tech=>tech.researchedAt))){if(producers.has(typeId))continue;const index=producers.size;producers.set(typeId,building(sim,typeId,16000+(index%3)*22000,16000+Math.floor(index/3)*22000));}
    const militia=unit(sim,'militia',18000,82000),scout=unit(sim,'scout',23000,82000),siege=unit(sim,'battering_ram',28000,82000);
    const barracks=producers.get('barracks')!,observer=unit(sim,'scout',barracks.xMm+9000,barracks.zMm,'red');sim.step();
    const observed=sim.view('red').entities.find(entity=>entity.id===barracks.id)!;expect(observed.hp).toBe(buildings.barracks.maxHp);expect(observed.ghost).not.toBe(true);
    observer.xMm=105000;observer.zMm=92000;sim.step();const memory=structuredClone(sim.view('red').entities.find(entity=>entity.id===barracks.id)!);expect(memory.ghost).toBe(true);
    const total=zero();for(const tech of balance.technologies)for(const resource of balance.resourceOrder)total[resource]+=tech.cost[resource]*scale;
    sim.state.economies.blue!.resources={...total};
    const records=new Map<TechnologyId,{job:ProductionJob;startedTick?:number;completedTick?:number}>(),begin=sim.state.tick;
    while(sim.state.economies.blue!.technologies.length<balance.technologies.length&&sim.state.tick-begin<18000){
      const completed=new Set(sim.state.economies.blue!.technologies);
      for(const technology of balance.technologies){
        if(records.has(technology.id)||!technology.prerequisites.every(prerequisite=>completed.has(prerequisite)))continue;
        const producer=producers.get(technology.researchedAt)!;if(producer.queue.length>=balance.rules.queueWaitingLimit+1)continue;
        const command=envelope(sim,{kind:'research',buildingId:producer.id,technologyId:technology.id}),before={...sim.state.economies.blue!.resources};
        const receipt=sim.command('blue',command);expect(receipt.status,`${technology.id}: ${receipt.code}`).toBe('accepted');
        const job=producer.queue.at(-1)!;expect(job).toMatchObject({kind:'research',typeId:technology.id,required:technology.researchSeconds*hz,originalCost:technology.cost,work:0,started:false,reserved:false});
        for(const resource of balance.resourceOrder)expect(before[resource]-sim.state.economies.blue!.resources[resource]).toBe(technology.cost[resource]*scale);
        const paid={...sim.state.economies.blue!.resources},length=producer.queue.length;expect(sim.command('blue',command)).toEqual(receipt);expect(sim.state.economies.blue!.resources).toEqual(paid);expect(producer.queue).toHaveLength(length);
        records.set(technology.id,{job});
      }
      sim.step();
      for(const [technologyId,record] of records){if(record.job.started&&record.startedTick===undefined)record.startedTick=sim.state.tick;if(record.completedTick===undefined&&sim.state.economies.blue!.technologies.includes(technologyId))record.completedTick=sim.state.tick;}
      if(sim.state.tick===begin+1){expect(validatePlayerView(sim.view('blue'))).toBe(true);expect(validatePlayerView(sim.view('red'))).toBe(true);}
    }
    expect(sim.state.status).toBe('RUNNING');expect(records.size).toBe(29);expect(sim.state.economies.blue!.technologies).toEqual(balance.technologies.map(tech=>tech.id).sort());
    for(const [technologyId,record] of records){expect(record.startedTick,technologyId).toBeDefined();expect(record.completedTick,technologyId).toBe(record.startedTick!+technologies[technologyId].researchSeconds*hz-1);expect(record.job.work).toBe(record.job.required);}
    expect(sim.state.tick-begin).toBe(14400);expect(sim.state.economies.blue!.resources).toEqual(zero());expect(sim.state.economies.blue!.researchRevision).toBe(29);expect([...producers.values()].every(producer=>producer.queue.length===0)).toBe(true);
    expect(sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='research')).toHaveLength(29);
    const ledger=zero();for(const entry of sim.state.economies.blue!.ledger)if(entry.reason==='research')ledger[entry.resource]-=entry.deltaMilli;expect(ledger).toEqual(total);
    expect(militia).toMatchObject({hp:85,maxHp:85});expect(scout).toMatchObject({hp:45,maxHp:45});expect(siege).toMatchObject({hp:units.battering_ram.maxHp,maxHp:units.battering_ram.maxHp});expect(barracks.maxHp).toBe(buildings.barracks.maxHp*1.2);
    const own=sim.view('blue'),enemy=sim.view('red');expect(validatePlayerView(own)).toBe(true);expect(validatePlayerView(enemy)).toBe(true);expect(enemy.entities.find(entity=>entity.id===barracks.id)).toEqual(memory);expect(enemy.self.technologies).toEqual([]);expect(enemy.entities.filter(entity=>entity.ownerId==='blue').every(entity=>entity.queue===undefined)).toBe(true);
    const enemyJson=JSON.stringify(enemy);for(const technology of balance.technologies)expect(enemyJson).not.toContain(technology.id);
  },45000);

  it('rejects queued prerequisites and foreign, wrong or unfinished producers without a purchase',()=>{
    const {sim,home}=fixture(),camp=building(sim,'lumber_camp',38000,16000),unfinished=building(sim,'lumber_camp',60000,16000,'blue',false),foreign=building(sim,'lumber_camp',105000,85000,'red');sim.step();
    const before={...sim.state.economies.blue!.resources};
    for(const [buildingId,code] of [[home.id,'INVALID_PRODUCER'],[unfinished.id,'INVALID_PRODUCER'],[foreign.id,'INVALID_REFERENCE']] as const)expect(send(sim,{kind:'research',buildingId,technologyId:'forestry_1'}).code).toBe(code);
    expect(sim.state.economies.blue!.resources).toEqual(before);expect([home,camp,unfinished,foreign].every(producer=>producer.queue.length===0)).toBe(true);
    const first=enqueue(sim,camp,'forestry_1'),paid={...sim.state.economies.blue!.resources};expect(send(sim,{kind:'research',buildingId:camp.id,technologyId:'forestry_2'}).code).toBe('PREREQUISITES_REQUIRED');expect(sim.state.economies.blue!.resources).toEqual(paid);expect(camp.queue.map(job=>job.id)).toEqual([first.id]);
    sim.step(first.required);expect(sim.state.economies.blue!.technologies).toEqual(['forestry_1']);expect(enqueue(sim,camp,'forestry_2').typeId).toBe('forestry_2');
  });

  it('preserves fractional wood already earned when a paid Forestry I job completes between gathering ticks',()=>{
    const {sim,worker}=fixture(2),camp=building(sim,'lumber_camp',38000,16000);
    worker.xMm=79000;worker.zMm=80000;
    const tree={id:'audit_tree',kind:'resource' as const,typeId:'tree',ownerId:null,resource:'wood' as const,amount:100000,xMm:80000,zMm:80000,hp:1,maxHp:1};sim.state.entities[tree.id]=tree;sim.state.navigationRevision++;
    sim.step();const paid=enqueue(sim,camp,'forestry_1');sim.step(paid.required-2);expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false}).status).toBe('accepted');
    sim.step();expect(paid.work).toBe(paid.required-1);expect(worker.cargo).toEqual({resource:'wood',amount:32});expect(worker.gatherRemainder).toBe(10000);
    sim.step();expect(sim.state.economies.blue!.technologies).toEqual(['forestry_1']);expect(worker.cargo).toEqual({resource:'wood',amount:69});expect(worker.gatherRemainder).toBe(17500);expect(tree.amount+worker.cargo.amount).toBe(100000);
  });

  it('loses a started age job with its producer and permits the same next age at a surviving Town Center',()=>{
    const {sim,home}=fixture(1),replacement=building(sim,'town_center',38000,16000);building(sim,'mill',60000,16000);building(sim,'lumber_camp',16000,38000);
    const age=balance.ages.find(entry=>entry.id===2)!;sim.state.economies.blue!.resources=zero();for(const resource of balance.resourceOrder)sim.state.economies.blue!.resources[resource]=age.cost[resource]*scale*2;
    expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:2}).status).toBe('accepted');const abandoned=home.queue[0]!;sim.step();expect(abandoned.work).toBe(1);const paid={...sim.state.economies.blue!.resources};home.hp=0;sim.step();
    expect(sim.state.entities[home.id]).toBeUndefined();expect(sim.state.economies.blue!.resources).toEqual(paid);expect(sim.state.economies.blue!.age).toBe(1);expect(sim.state.ageAnnouncements).toEqual([]);
    expect(send(sim,{kind:'advance_age',townCenterId:replacement.id,targetAge:2}).status).toBe('accepted');expect(sim.state.economies.blue!.resources).toEqual(zero());sim.step(age.researchSeconds*hz);
    expect(abandoned.work).toBe(1);expect(sim.state.economies.blue!.age).toBe(2);expect(sim.state.ageAnnouncements).toEqual([{playerId:'blue',age:2,tick:sim.state.tick}]);expect(sim.state.economies.blue!.statistics.ageTicks[2]).toBe(sim.state.tick);
  });
});
