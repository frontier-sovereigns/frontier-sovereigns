import { describe, expect, it } from 'vitest';
import { balance, type GameplayCommand, type PublicPlayer } from '@frontier/shared';
import { createSimulation, type Simulation, type Unit, type Building, type ResourceNode } from '../src/index.js';
import { Navigation, PathBudgetExceededError } from '../src/navigation.js';
import { buildingCommand } from '../src/caretaker.js';

const factions:PublicPlayer[]=[{id:'p1',name:'Blue',teamId:'one',color:'#3388ff',kind:'human'},{id:'p2',name:'Red',teamId:'two',color:'#ee7744',kind:'human'}];
function world(){return createSimulation({seed:'m1-regression',secretIdKey:'fixture-secret',matchId:'test',factions});}
function send(sim:Simulation,playerId:string,command:GameplayCommand,id?:string){const sequence=sim.state.economies[playerId]!.lastClientSequence+1;return sim.command(playerId,{protocolVersion:2,matchId:'test',matchEpoch:sim.state.matchEpoch,clientCommandId:id??`cmd_${sequence}`,clientSequence:sequence,command});}
const ownUnits=(sim:Simulation,p='p1')=>Object.values(sim.state.entities).filter((e):e is Unit=>e.kind==='unit'&&e.ownerId===p);
const tc=(sim:Simulation,p='p1')=>Object.values(sim.state.entities).find(e=>e.typeId==='town_center'&&e.ownerId===p) as Building;

describe('M1 authoritative economy and admission',()=>{
  it('starts from catalog resources, seven units, one house and a town center',()=>{
    const sim=world(),view=sim.view('p1');
    expect(view.self.resources).toEqual(balance.start.resources);expect(view.self.population).toBe(7);expect(view.self.populationCap).toBe(15);
    expect(view.entities.filter(e=>e.ownerId==='p2')).toHaveLength(0);
    expect(JSON.stringify(view)).not.toContain('fixture-secret');
  });
  it('debits and creates one training job across duplicates and rejects ID reuse',()=>{
    const sim=world(),building=tc(sim),input={protocolVersion:2,matchId:'test',matchEpoch:1,clientCommandId:'train_once',clientSequence:1,command:{kind:'train',buildingId:building.id,unitType:'villager',quantity:1}};
    const receipt=sim.command('p1',input);expect(receipt.status).toBe('accepted');
    expect(sim.command('p1',input)).toEqual(receipt);expect(building.queue).toHaveLength(1);expect(sim.view('p1').self.resources.food).toBe(150);
    expect(sim.command('p1',{...input,command:{...input.command,quantity:2}}).code).toBe('COMMAND_ID_REUSED');
    sim.step(400);expect(ownUnits(sim)).toHaveLength(8);expect(building.queue).toHaveLength(0);expect(sim.command('p1',input)).toEqual(receipt);
  });
  it('rejects foreign ownership, invisible references, and unaffordable atomic batches',()=>{
    const sim=world(),enemy=ownUnits(sim,'p2')[0]!;
    expect(send(sim,'p1',{kind:'move',unitIds:[enemy.id],target:{xMm:5000,zMm:5000},queued:false}).code).toBe('INVALID_REFERENCE');
    expect(send(sim,'p1',{kind:'attack_target',unitIds:[ownUnits(sim)[0]!.id],targetId:enemy.id,queued:false}).code).toBe('INVALID_REFERENCE');
    expect(send(sim,'p1',{kind:'attack_target',unitIds:[ownUnits(sim)[0]!.id],targetId:'unknown',queued:false}).code).toBe('INVALID_REFERENCE');
    expect(send(sim,'p1',{kind:'train',buildingId:tc(sim).id,unitType:'villager',quantity:5}).code).toBe('INSUFFICIENT_RESOURCES');
    expect(sim.view('p1').self.resources.food).toBe(200);expect(tc(sim).queue).toHaveLength(0);
  });
  it('walks around the town center, fills cargo, deposits and conserves wood',()=>{
    const sim=world(),worker=ownUnits(sim)[0]!,nodeView=sim.view('p1').entities.find(e=>e.resource==='wood')!,node=sim.state.entities[nodeView.id] as ResourceNode;
    const initial=node.amount,bank=sim.state.economies.p1!.resources.wood;
    expect(send(sim,'p1',{kind:'gather',unitIds:[worker.id],targetId:node.id,queued:false}).status).toBe('accepted');
    sim.step();expect(worker.cargo.amount).toBe(0);expect(sim.state.economies.p1!.resources.wood).toBe(bank);
    sim.step(1600);
    expect(sim.state.economies.p1!.resources.wood,JSON.stringify(worker)).toBeGreaterThan(bank);
    expect(initial-node.amount).toBe(sim.state.economies.p1!.resources.wood-bank+worker.cargo.amount);
    expect(node.amount).toBeGreaterThanOrEqual(0);
  });
  it('builds a solid house using actual travel/work and only then adds capacity',()=>{
    const sim=world(),base=tc(sim),worker=ownUnits(sim)[0]!;
    // Choose from actual disclosed, clear land; fixed offsets are no longer
    // valid when the generated starting area contains denser resource patches.
    const view=sim.view('p1'),proposal=buildingCommand(view,'house',base,[view.entities.find(entity=>entity.id===worker.id)!]);expect(proposal).toBeDefined();
    const result=send(sim,'p1',proposal!);
    expect(result.status,result.code).toBe('accepted');expect(sim.view('p1').self.resources.wood).toBe(220);expect(sim.view('p1').self.populationCap).toBe(15);
    const house=sim.state.entities[worker.orders[0]!.targetId!] as Building;
    sim.step(900);
    expect(house.work,JSON.stringify(worker)).toBe(house.required);expect(house.hp).toBe(house.maxHp);expect(sim.view('p1').self.populationCap).toBe(20);
  });
  it('rejects hidden/occupied footprints without spending',()=>{
    const sim=world(),base=tc(sim),worker=ownUnits(sim)[0]!,before=sim.view('p1').self.resources;
    expect(send(sim,'p1',{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:base.xMm/2000,z:base.zMm/2000},rotation:0,queued:false}).code).toBe('PLACEMENT_BLOCKED');
    expect(send(sim,'p1',{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:0,z:0},rotation:0,queued:false}).code).toBe('PLACEMENT_UNAVAILABLE');
    expect(sim.view('p1').self.resources).toEqual(before);
  });
  it('builds a barracks and trains catalog militia',()=>{
    const sim=world(),base=tc(sim),worker=ownUnits(sim)[0]!;
    const view=sim.view('p1'),proposal=buildingCommand(view,'barracks',base,[view.entities.find(entity=>entity.id===worker.id)!]);expect(proposal).toBeDefined();
    const result=send(sim,'p1',proposal!);
    expect(result.status,result.code).toBe('accepted');sim.step(1600);
    const barracks=Object.values(sim.state.entities).find(e=>e.ownerId==='p1'&&e.typeId==='barracks') as Building;
    expect(barracks.work).toBe(barracks.required);
    expect(send(sim,'p1',{kind:'train',buildingId:barracks.id,unitType:'militia',quantity:1}).status).toBe('accepted');sim.step(500);
    expect(ownUnits(sim).some(e=>e.typeId==='militia')).toBe(true);expect(sim.view('p1').self.resources.gold).toBe(80);
  });
  it('reserves the final population slot across producers and preserves it after housing loss',()=>{
    const sim=world(),base=tc(sim),template=ownUnits(sim)[0]!;
    for(let i=0;i<7;i++)sim.state.entities[`fixture_unit_${i}`]={...structuredClone(template),id:`fixture_unit_${i}`,xMm:180000+i*1500,zMm:210000};
    const barracks:Building={...structuredClone(base),id:'fixture_barracks',typeId:'barracks',xMm:160000,queue:[]};sim.state.entities[barracks.id]=barracks;sim.state.navigationRevision++;
    expect(send(sim,'p1',{kind:'train',buildingId:base.id,unitType:'villager',quantity:1}).status).toBe('accepted');
    expect(send(sim,'p1',{kind:'train',buildingId:barracks.id,unitType:'militia',quantity:1}).status).toBe('accepted');sim.step();
    expect(base.queue[0]!.reserved).toBe(true);expect(barracks.queue[0]!.state).toBe('population_blocked');
    const house=Object.values(sim.state.entities).find(e=>e.ownerId==='p1'&&e.typeId==='house')!;house.hp=0;sim.step(399);
    expect(ownUnits(sim)).toHaveLength(15);expect(sim.view('p1').self.populationCap).toBe(10);expect(barracks.queue[0]!.reserved).toBe(false);
  });
  it('never duplicates the final resource remainder between competing workers',()=>{
    const sim=world(),[a,b]=ownUnits(sim),nodeView=sim.view('p1').entities.find(e=>e.resource==='food')!,node=sim.state.entities[nodeView.id] as ResourceNode;
    node.amount=3000;a!.xMm=node.xMm-1400;a!.zMm=node.zMm;b!.xMm=node.xMm+1400;b!.zMm=node.zMm;
    const initial=sim.state.economies.p1!.resources.food;
    expect(send(sim,'p1',{kind:'gather',unitIds:[a!.id,b!.id],targetId:node.id,queued:false}).status).toBe('accepted');sim.step(90);
    expect(node.amount).toBe(0);expect(a!.cargo.amount+b!.cargo.amount+sim.state.economies.p1!.resources.food-initial).toBe(3000);
  });
});

describe('M1 physical rules and victory fixtures',()=>{
  it.each([[250,350,8000],[250,550,9000],[1000,350,1100],[1000,550,1100]])('finds a physical detour on a %imm grid at radius %imm within %i geometry checks',(cellMm,radius,maximumWork)=>{
    const obstacles=[{id:'wall',xMm:10000,zMm:10000,halfWidth:1000,halfHeight:5000}],from={xMm:6000,zMm:10000},target={xMm:14000,zMm:10000};
    const budget={remaining:maximumWork,used:0},navigation=new Navigation(20000,20000,obstacles,2048,cellMm,budget);
    const path=navigation.path(from,target,radius);
    expect(path?.at(-1)).toEqual(target);expect(path!.length).toBeGreaterThan(1);
    expect(budget.used).toBeGreaterThan(0);expect(budget.remaining).toBe(maximumWork-budget.used);
    const physical=new Navigation(20000,20000,obstacles);let prior=from;
    for(const point of path!){expect(physical.clearLine(prior,point,radius)).toBe(true);prior=point;}
    const exact={remaining:budget.used,used:17};
    expect(new Navigation(20000,20000,obstacles,2048,cellMm,exact).path(from,target,radius)).toEqual(path);
    expect(exact).toEqual({remaining:0,used:17+budget.used});
    const short={remaining:budget.used-1,used:17};
    expect(()=>new Navigation(20000,20000,obstacles,2048,cellMm,short).path(from,target,radius)).toThrow(PathBudgetExceededError);
    expect(short).toEqual({remaining:0,used:16+budget.used});
    const exhausted={remaining:1,used:0};
    expect(()=>new Navigation(20000,20000,obstacles,2048,cellMm,exhausted).path(from,target,radius)).toThrow(PathBudgetExceededError);
    expect(exhausted).toEqual({remaining:0,used:1});
    const sealed=new Navigation(20000,20000,[{...obstacles[0]!,halfHeight:10000}],2048,cellMm);
    expect(sealed.path(from,target,radius)).toBeNull();
  });
  it('finds a detour to an alternative work face without exhausting a nearer enclosed goal',()=>{
    const obstacles=[
      {id:'left',xMm:50000,zMm:50000,halfWidth:1000,halfHeight:3000},
      {id:'right',xMm:54000,zMm:50000,halfWidth:1000,halfHeight:3000},
      {id:'top',xMm:52000,zMm:48000,halfWidth:3000,halfHeight:1000},
      {id:'bottom',xMm:52000,zMm:52000,halfWidth:3000,halfHeight:1000},
    ],from={xMm:48000,zMm:50000},enclosed={xMm:52000,zMm:50000},reachable={xMm:56000,zMm:50000};
    const firstBudget={remaining:50000,used:0};
    expect(()=>new Navigation(100000,100000,obstacles,30000,1000,firstBudget).path(from,enclosed,400)).toThrow(PathBudgetExceededError);
    const budget={remaining:50000,used:0},nav=new Navigation(100000,100000,obstacles,30000,1000,budget);
    const route=nav.pathToAny(from,[enclosed,reachable],400);
    expect(route?.at(-1)).toEqual(reachable);expect(budget.remaining).toBeGreaterThan(0);
    const physical=new Navigation(100000,100000,obstacles);let previous=from;
    for(const point of route!){expect(physical.clearLine(previous,point,400)).toBe(true);previous=point;}
    expect(physical.pathToAny(from,[],400)).toBeNull();
    expect(physical.pathToAny(from,[{xMm:50000,zMm:50000}],400)).toBeNull();
  });
  it('ends pursuit after observing that an attacked unit left its last known location',()=>{
    const sim=world(),attacker=ownUnits(sim)[0]!,witness=ownUnits(sim)[1]!,enemy=ownUnits(sim,'p2')[0]!;
    attacker.xMm=40000;attacker.zMm=40000;witness.xMm=46000;witness.zMm=41000;enemy.xMm=47000;enemy.zMm=40000;sim.step();
    expect(send(sim,'p1',{kind:'attack_target',unitIds:[attacker.id],targetId:enemy.id,queued:false}).status).toBe('accepted');sim.step();enemy.hp=0;sim.step(2);expect(attacker.orders).toHaveLength(0);
  });
  it('routes around a solid obstruction with no diagonal corner cutting',()=>{
    const nav=new Navigation(20000,20000,[{id:'wall',xMm:10000,zMm:10000,halfWidth:2000,halfHeight:5000}]);
    const start={xMm:3000,zMm:10000},target={xMm:17000,zMm:10000},path=nav.path(start,target,550)!;
    expect(path.length).toBeGreaterThan(1);let prior=start;
    for(const point of path){expect(nav.clearLine(prior,point,550)).toBe(true);prior=point;}
    expect(nav.path(start,{xMm:10000,zMm:10000},350)).toBeNull();
  });
  it('applies same-tick lethal melee damage to both sides',()=>{
    const sim=world(),a=ownUnits(sim)[0]!,b=ownUnits(sim,'p2')[0]!;
    // This is a simultaneous-damage fixture, independent of generated ridges or
    // forest belts that may now occupy the fixed central duel coordinates.
    sim.state.map.terrain=[];
    for(const entity of Object.values(sim.state.entities))if(entity.kind!=='unit'&&Math.abs(entity.xMm-190500)<10000&&Math.abs(entity.zMm-190000)<10000)delete sim.state.entities[entity.id];
    sim.state.navigationRevision++;
    a.xMm=190000;a.zMm=190000;b.xMm=191000;b.zMm=190000;a.hp=3;b.hp=3;
    sim.step();expect(sim.state.entities[a.id]).toBeUndefined();expect(sim.state.entities[b.id]).toBeUndefined();
  });
  it('ends surrender on the next accounting tick and freezes afterward',()=>{
    const sim=world();expect(send(sim,'p2',{kind:'surrender'}).status).toBe('accepted');sim.step();
    expect(sim.view('p1').result?.winnerTeamId).toBe('one');const tick=sim.state.tick;sim.step(100);expect(sim.state.tick).toBe(tick);
    expect(send(sim,'p1',{kind:'surrender'}).code).toBe('MATCH_FINISHED');
  });
  it('ignores surviving inert houses in defeat and resolves simultaneous elimination as draw',()=>{
    const sim=world();for(const entity of Object.values(sim.state.entities))if(entity.kind==='unit'||entity.typeId==='town_center')entity.hp=0;
    sim.step();expect(sim.state.status).toBe('FINISHED');expect(sim.state.result?.winnerTeamId).toBeNull();
    expect(Object.values(sim.state.entities).some(e=>e.typeId==='house')).toBe(true);
  });
  it('keeps fallback gathering and building through the ordinary validated command path',()=>{
    const sim=createSimulation({seed:'fallback',matchId:'test',factions:[factions[0]!,{...factions[1]!,kind:'ai'}]});
    // Six starting villagers reserve the next age's actual food price before
    // optional growth. Prove eventual paid training, not the obsolete 100-second
    // deadline from before that policy; no banks, jobs or units are injected.
    for(let tick=0;tick<300*balance.rules.simulationHz&&ownUnits(sim,'p2').length<=7;tick++)sim.step();
    const eco=sim.state.economies.p2!;
    expect(eco.collected.food+eco.collected.wood).toBeGreaterThan(0);
    expect(sim.state.commandLog.some(e=>e.playerId==='p2'&&e.envelope.command.kind==='build')).toBe(true);
    expect(sim.state.commandLog.some(e=>e.playerId==='p2'&&e.envelope.command.kind==='train'&&e.envelope.command.unitType==='villager')).toBe(true);
    expect(ownUnits(sim,'p2').length).toBeGreaterThan(7);
    expect(sim.state.status).toBe('RUNNING');
  });
});
