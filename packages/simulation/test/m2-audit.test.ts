import { describe, expect, it } from 'vitest';
import { balance, buildings, units, type GameplayCommand, type PublicPlayer } from '@frontier/shared';
import { createSimulation, type Building, type Unit } from '../src/index.js';
import { fallbackCommands, type FallbackMemory } from '../src/fallback.js';

const factions:PublicPlayer[]=[
  {id:'p1',name:'One',teamId:'allies',color:'#3388ff',kind:'human'},
  {id:'p2',name:'Two',teamId:'allies',color:'#33aa66',kind:'human'},
  {id:'p3',name:'Three',teamId:'enemy',color:'#ee7744',kind:'human'},
];
function alliedWork(kind:'gather'|'repair'){
  const sim=createSimulation({seed:'m2-hidden-work',secretIdKey:'fixture-key',matchId:'audit',factions,sharedVision:false,controllers:false});
  const all=Object.values(sim.state.entities),worker=all.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='p1'&&entity.typeId==='villager')!;
  const home=all.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p1'&&entity.typeId==='town_center')!;
  const target=all.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p2'&&entity.typeId==='house')!;
  target.typeId='farm';target.maxHp=buildings.farm.maxHp;target.hp=target.maxHp-100;target.foodRemaining=350000;sim.state.navigationRevision++;
  worker.xMm=target.xMm+5500;worker.zMm=target.zMm;sim.step();
  expect(sim.view('p1').entities.find(entity=>entity.id===target.id)?.ghost).not.toBe(true);
  const command:GameplayCommand={kind,unitIds:[worker.id],targetId:target.id,queued:false};
  expect(sim.command('p1',{protocolVersion:2,matchId:'audit',matchEpoch:1,clientCommandId:'work',clientSequence:1,command}).status).toBe('accepted');
  worker.xMm=home.xMm+14000;worker.zMm=home.zMm+14000;worker.path=[];sim.step();
  expect(sim.view('p1').entities.find(entity=>entity.id===target.id)?.ghost).toBe(true);
  return {sim,worker,target};
}

describe('M2 independent economy privacy audit',()=>{
  it('admits the 800th ordinary structure and atomically rejects the 801st',()=>{
    const sim=createSimulation({seed:'structure-cap-audit',matchId:'audit',factions,controllers:false});
    const entities=Object.values(sim.state.entities),worker=entities.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='p1'&&entity.typeId==='villager')!;
    const home=entities.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p1'&&entity.typeId==='town_center')!;
    const rival=entities.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p3'&&entity.typeId==='town_center')!;
    const observer=entities.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='p1'&&entity.typeId==='scout')!;Object.assign(observer,{xMm:50000,zMm:44000,orders:[],path:[]});
    Object.assign(worker,{xMm:42000,zMm:50000,orders:[],path:[]});Object.assign(home,{xMm:40000,zMm:40000});Object.assign(rival,{xMm:250000,zMm:250000});
    sim.state.entities={[worker.id]:worker,[observer.id]:observer,[home.id]:home,[rival.id]:rival};sim.state.map.terrain=[];sim.state.navigationRevision++;sim.step();
    // Isolated roster-cap fixture, not a generated settlement or load benchmark.
    // Remote colocated records make the purchase boundary independent of map packing.
    for(let index=1;index<799;index++){
      const id=`existing_house_${index}`,definition=buildings.house;
      sim.state.entities[id]={...structuredClone(home),id,typeId:'house',xMm:180000,zMm:180000,hp:definition.maxHp,maxHp:definition.maxHp,work:1,required:1,queue:[]};
    }
    sim.state.navigationRevision++;sim.state.economies.p1!.resources.wood=1000000;
    const command:GameplayCommand={kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:22,z:24},rotation:0,queued:false};
    const envelope={protocolVersion:2 as const,matchId:'audit',matchEpoch:1,clientCommandId:'structure_800',clientSequence:1,command};
    expect(balance.rules.maxNonWallBuildingsPerPlayer).toBe(800);
    expect(sim.command('p1',envelope)).toMatchObject({status:'accepted',code:'OK'});
    const owned=()=>Object.values(sim.state.entities).filter(entity=>entity.kind==='building'&&entity.ownerId==='p1');
    expect(owned()).toHaveLength(800);const paid=sim.state.economies.p1!.resources.wood;
    expect(sim.command('p1',envelope).status).toBe('accepted');expect(owned()).toHaveLength(800);expect(sim.state.economies.p1!.resources.wood).toBe(paid);
    const next={...envelope,clientCommandId:'structure_801',clientSequence:2,command:{...command,originCell:{x:26,z:24}}};
    expect(sim.command('p1',next).code).toBe('BUILDING_LIMIT');expect(owned()).toHaveLength(800);expect(sim.state.economies.p1!.resources.wood).toBe(paid);
  });
  it('does not disclose an allied farm destroyed outside vision through its assigned worker',()=>{
    const surviving=alliedWork('gather'),destroyed=alliedWork('gather');
    delete destroyed.sim.state.entities[destroyed.target.id];destroyed.sim.state.navigationRevision++;
    for(let tick=0;tick<40;tick++){
      surviving.sim.step();destroyed.sim.step();
      expect(destroyed.sim.view('p1')).toEqual(surviving.sim.view('p1'));
    }
    expect(destroyed.worker.orders[0]?.kind).toBe('gather');
  });
  it('does not disclose hidden allied repair completion through an assigned worker',()=>{
    const damaged=alliedWork('repair'),repaired=alliedWork('repair');
    repaired.target.hp=repaired.target.maxHp;
    for(let tick=0;tick<40;tick++){
      damaged.sim.step();repaired.sim.step();
      expect(repaired.sim.view('p1')).toEqual(damaged.sim.view('p1'));
    }
    expect(repaired.worker.orders[0]?.kind).toBe('repair');
  });
  it('holds a paid completed unit behind blocked exits and produces exactly one after an opening',()=>{
    const sim=createSimulation({seed:'m2-blocked-exits',matchId:'audit',factions,controllers:false});
    const entities=Object.values(sim.state.entities),tc=entities.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p1'&&entity.typeId==='town_center')!;
    const ownUnits=()=>Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='p1');
    for(const [index,worker]of ownUnits().entries()){worker.xMm=tc.xMm-24000+index*2000;worker.zMm=tc.zMm+30000;}
    let opening='';
    for(let offset=-8000;offset<=8000;offset+=2000)for(const side of ['north','south','west','east'] as const){
      const id=`barrier_${side}_${offset}`,xMm=tc.xMm+(side==='west'?-8000:side==='east'?8000:offset),zMm=tc.zMm+(side==='north'?-8000:side==='south'?8000:offset);
      sim.state.entities[id]={...structuredClone(tc),id,typeId:'palisade_wall',xMm,zMm,hp:buildings.palisade_wall.maxHp,maxHp:buildings.palisade_wall.maxHp,work:1,required:1,queue:[]};
      if(side==='south'&&offset===0)opening=id;
    }
    sim.state.navigationRevision++;
    const initialFood=sim.state.economies.p1!.resources.food;
    expect(sim.command('p1',{protocolVersion:2,matchId:'audit',matchEpoch:1,clientCommandId:'train',clientSequence:1,command:{kind:'train',buildingId:tc.id,unitType:'villager',quantity:1}}).status).toBe('accepted');
    sim.step(units.villager.trainSeconds*20+25);
    expect(ownUnits()).toHaveLength(7);expect(tc.queue).toHaveLength(1);expect(tc.queue[0]?.state).toBe('exit_blocked');
    expect(sim.view('p1').self.reservedPopulation).toBe(1);
    expect(sim.state.economies.p1!.resources.food).toBe(initialFood-units.villager.cost.food*1000);
    delete sim.state.entities[opening];sim.state.navigationRevision++;
    sim.step(25);
    expect(ownUnits()).toHaveLength(8);expect(tc.queue).toHaveLength(0);expect(sim.view('p1').self.reservedPopulation).toBe(0);
    expect(sim.state.economies.p1!.resources.food).toBe(initialFood-units.villager.cost.food*1000);
  });
  it('keeps the same planned farm reserved while its carrying worker actually returns other cargo',()=>{
    const sim=createSimulation({seed:'farm-reservation-audit',matchId:'audit',factions,controllers:false});
    const entities=Object.values(sim.state.entities),workers=entities.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='p1'&&entity.typeId==='villager');
    const home=entities.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='p1'&&entity.typeId==='town_center')!;
    // A focused cargo fixture: both plans and the resulting gather/deposit order use
    // the real authoritative command path and filtered observations.
    for(const entity of entities)if(entity.kind==='resource'&&entity.resource==='food')entity.amount=0;
    const farm:Building={...structuredClone(home),id:'reservation_farm',typeId:'farm',xMm:home.xMm-16000,zMm:home.zMm+18000,hp:buildings.farm.maxHp,maxHp:buildings.farm.maxHp,queue:[],foodRemaining:350000};
    sim.state.entities[farm.id]=farm;sim.state.navigationRevision++;
    const worker=workers[0]!;worker.xMm=home.xMm-18000;worker.zMm=home.zMm+25000;worker.cargo={resource:'wood',amount:10000};
    sim.step();
    const memory:FallbackMemory={sequence:0,scoutIndex:0,buildAttempt:0};
    const first=fallbackCommands(sim.view('p1'),memory),order=first.find(command=>command.kind==='gather'&&command.targetId===farm.id);
    expect(order?.kind).toBe('gather');if(order?.kind!=='gather')throw new Error('MISSING_FARM_ORDER');
    expect(order.unitIds).toEqual([worker.id]);
    expect(sim.command('p1',{protocolVersion:2,matchId:'audit',matchEpoch:1,clientCommandId:'planned-farm',clientSequence:1,command:order}).status).toBe('accepted');
    sim.step(20);
    expect(worker.orders[0]?.phase).toBe('deposit');expect(worker.cargo.resource).toBe('wood');
    expect(sim.view('p1').entities.find(entity=>entity.id===farm.id)?.farmerAssigned).toBe(false);
    const second=fallbackCommands(sim.view('p1'),memory);
    expect(second.some(command=>command.kind==='gather'&&command.targetId===farm.id)).toBe(false);
    expect(memory.farmAssignments?.[farm.id]).toBe(worker.id);
  });
});
