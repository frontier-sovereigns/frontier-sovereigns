import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, units, type BuildingId, type GameplayCommand, type PublicPlayer, type ResourceType } from '@frontier/shared';
import { createSimulation, createLiveSimulation, Simulation, exportSimulationSave, restoreSimulation, type Building, type Unit, type ResourceNode } from '../src/index.js';
import type { PathScheduler } from '../src/path-scheduler.js';
import { canTransact, emptyBank, refund, transact } from '../src/economy.js';
import { Navigation, type Obstacle } from '../src/navigation.js';

const factions:PublicPlayer[]=[{id:'p1',name:'Blue',teamId:'one',color:'#3388ff',kind:'human'},{id:'ally',name:'Green',teamId:'one',color:'#33ff88',kind:'human'},{id:'p2',name:'Red',teamId:'two',color:'#ee7744',kind:'human'}];
function fixture(){
  const sim=createSimulation({seed:'economy-fixture',matchId:'economy',factions,controllers:false});
  // These isolated mechanics fixtures deliberately position entities; the separate
  // legal-command conquest and browser tests retain ordinary generated starts.
  // A generated rival can now start inside the mechanics arena. Preserve its
  // complete faction when clearing that space, or the first step wins by conquest
  // and every later economy command is correctly rejected as MATCH_FINISHED.
  sim.state.map.terrain=[];
  for(const e of Object.values(sim.state.entities)){
    if(e.kind==='resource')delete sim.state.entities[e.id];
    else if(e.xMm<100000&&e.zMm<100000)e.xMm+=sim.state.widthMm-100000;
  }
  for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
  sim.state.navigationRevision++;return sim;
}
const workers=(sim:Simulation,owner='p1')=>Object.values(sim.state.entities).filter((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'&&e.ownerId===owner);
function workerAt(sim:Simulation,x=43000,z=50000,owner='p1',index=0){const worker=workers(sim,owner)[index]!;worker.xMm=x;worker.zMm=z;worker.path=[];return worker;}
function structure(sim:Simulation,typeId:BuildingId='mill',x=50000,z=50000,owner='p1',complete=true):Building{
  const def=buildings[typeId],required=def.buildSeconds*20*100;
  const building:Building={id:`fixture_${typeId}_${Object.keys(sim.state.entities).length}`,kind:'building',ownerId:owner,typeId,xMm:x,zMm:z,hp:complete?def.maxHp:Math.floor(def.maxHp*.1),maxHp:def.maxHp,rotation:0,work:complete?required:0,required,grantedHp:complete?def.maxHp:Math.floor(def.maxHp*.1),queue:[],cooldown:0,...(typeId==='farm'?{foodRemaining:350000}:{})};
  sim.state.entities[building.id]=building;sim.state.navigationRevision++;return building;
}
function node(sim:Simulation,resource:ResourceType,x=50000,z=50000,amount=100000):ResourceNode{const e:ResourceNode={id:`fixture_resource_${Object.keys(sim.state.entities).length}`,kind:'resource',ownerId:null,typeId:resource==='wood'?'tree_oak':resource==='gold'?'gold_deposit':resource==='stone'?'stone_quarry':'forage_patch',resource,amount,xMm:x,zMm:z,hp:1,maxHp:1};sim.state.entities[e.id]=e;sim.state.navigationRevision++;return e;}
function send(sim:Simulation,command:GameplayCommand,owner='p1'){const sequence=sim.state.economies[owner]!.lastClientSequence+1;return sim.command(owner,{protocolVersion:2,matchId:'economy',matchEpoch:1,clientCommandId:`${owner}_${sequence}`,clientSequence:sequence,command});}
function reach(sim:Simulation,worker:Unit,building:Building,side=-1){worker.xMm=building.xMm+side*(buildings[building.typeId].footprintCells[0]*1000+850);worker.zMm=building.zMm;worker.path=[];sim.step();}

describe('M2 atomic resource ledger and refunds',()=>{
  it('preflights every resource and rejects unsafe-integer overflow without partial changes',()=>{
    const sim=fixture(),eco=sim.state.economies.p1!,before=structuredClone(eco),delta={food:-1000,wood:Number.MAX_SAFE_INTEGER,gold:0,stone:0};
    expect(canTransact(eco,delta)).toBe(false);expect(transact(eco,delta,'test',0)).toBe(false);expect(eco).toEqual(before);
    expect(refund({food:0,wood:100,gold:0,stone:0},0,100,.75).wood).toBe(75000);
    expect(refund({food:0,wood:100,gold:0,stone:0},40,100,.75).wood).toBe(45000);
    expect(refund({food:50,wood:0,gold:0,stone:0},40,100,.75).food).toBe(22000);
  });
  it('admits exactly one of two unaffordable purchases with precise missing resources',()=>{
    const sim=fixture(),tc=Object.values(sim.state.entities).find(e=>e.ownerId==='p1'&&e.typeId==='town_center') as Building;
    sim.state.economies.p1!.resources.food=50000;
    expect(send(sim,{kind:'train',buildingId:tc.id,unitType:'villager',quantity:1}).status).toBe('accepted');
    const rejected=send(sim,{kind:'train',buildingId:tc.id,unitType:'villager',quantity:1});
    expect(rejected.code).toBe('INSUFFICIENT_RESOURCES');expect(rejected.missingResources?.food).toBe(50);expect(tc.queue).toHaveLength(1);expect(sim.state.economies.p1!.resources.food).toBe(0);
  });
  it('refunds unstarted and 40-percent jobs using the authoritative ledger',()=>{
    const sim=fixture(),tc=Object.values(sim.state.entities).find(e=>e.ownerId==='p1'&&e.typeId==='town_center') as Building;
    send(sim,{kind:'train',buildingId:tc.id,unitType:'villager',quantity:2});
    expect(send(sim,{kind:'cancel_job',buildingId:tc.id,jobId:tc.queue[1]!.id}).status).toBe('accepted');
    sim.step(160);expect(tc.queue[0]!.work/tc.queue[0]!.required).toBe(.4);
    expect(send(sim,{kind:'cancel_job',buildingId:tc.id,jobId:tc.queue[0]!.id}).status).toBe('accepted');
    expect(sim.view('p1').self.resources.food).toBe(172);expect(sim.state.economies.p1!.ledger.filter(e=>e.reason==='production_refund').map(e=>e.deltaMilli)).toEqual([50000,22000]);expect(sim.view('p1').self.reservedPopulation).toBe(0);
  });
  it('refunds canceled foundations but neither destroyed buildings nor producer queues',()=>{
    const sim=fixture(),a=structure(sim,'mill',50000,50000,'p1',false),b=structure(sim,'mill',65000,50000,'p1',false);b.work=b.required*.4;
    const initial=sim.state.economies.p1!.resources.wood;send(sim,{kind:'cancel_foundation',foundationId:a.id});send(sim,{kind:'cancel_foundation',foundationId:b.id});expect(sim.state.economies.p1!.resources.wood-initial).toBe(120000);
    const tc=Object.values(sim.state.entities).find(e=>e.ownerId==='p1'&&e.typeId==='town_center') as Building;send(sim,{kind:'train',buildingId:tc.id,unitType:'villager',quantity:1});const bank=structuredClone(sim.state.economies.p1!.resources);tc.hp=0;structure(sim,'mill',50000,50000,'p1',false).hp=0;sim.step();expect(sim.state.economies.p1!.resources).toEqual(bank);expect(sim.view('p1').self.reservedPopulation).toBe(0);
  });
  it('uses Market lots only after the explicit Age II fixture and charges tribute fees atomically',()=>{
    const sim=fixture(),market=structure(sim,'market');
    expect(send(sim,{kind:'market_trade',marketId:market.id,side:'buy',resource:'wood',lots:1}).code).toBe('AGE_REQUIRED');
    sim.state.economies.p1!.age=2;sim.state.economies.p1!.resources.gold=260000;
    expect(send(sim,{kind:'market_trade',marketId:market.id,side:'buy',resource:'wood',lots:2}).status).toBe('accepted');expect(sim.view('p1').self.resources).toMatchObject({wood:450,gold:0});
    send(sim,{kind:'market_trade',marketId:market.id,side:'sell',resource:'wood',lots:1});expect(sim.view('p1').self.resources).toMatchObject({wood:350,gold:60});
    send(sim,{kind:'tribute',recipientId:'ally',resource:'wood',amount:100});expect(sim.view('p1').self.resources.wood).toBe(240);expect(sim.view('ally').self.resources.wood).toBe(350);
    sim.state.economies.ally!.resources.wood=Number.MAX_SAFE_INTEGER;const before=structuredClone(sim.state.economies.p1!);
    expect(send(sim,{kind:'tribute',recipientId:'ally',resource:'wood',amount:1}).code).toBe('RESOURCE_LIMIT');expect(sim.state.economies.p1!.resources).toEqual(before.resources);expect(sim.state.economies.p1!.ledger).toEqual(before.ledger);
    expect(send(sim,{kind:'tribute',recipientId:'p2',resource:'wood',amount:1}).code).toBe('INVALID_RECIPIENT');
  });
});

describe('M2 physical construction, farming and repair',()=>{
  it.each(['empty','sealed'] as const)('keeps %s opportunistic idle searches quiet while a real exhausted gather order still reports depletion',mode=>{
    const sim=fixture(),worker=workerAt(sim,50000,50000);sim.state.entities={[worker.id]:worker};sim.state.map.terrain=[];for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',43000,43000);structure(sim,'town_center',250000,250000,'p2');
    if(mode==='sealed'){
      node(sim,'gold',55000,50000,200000);
      for(const offset of [-2000,0,2000]){structure(sim,'palisade_wall',55000+offset,48000,'p1');structure(sim,'palisade_wall',55000+offset,52000,'p1');}structure(sim,'palisade_wall',53000,50000,'p1');structure(sim,'palisade_wall',57000,50000,'p1');
    }
    const bank=structuredClone(sim.state.economies.p1!.resources);sim.step(400);
    expect(worker).toMatchObject({xMm:50000,zMm:50000,cargo:{resource:null,amount:0}});expect(sim.state.economies.p1!.resources).toEqual(bank);expect(sim.state.economies.p1!.notifications.filter(notice=>notice.entityId===worker.id)).toEqual([]);
    const tree=node(sim,'wood',50000,52000,65);sim.step();expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false}).status).toBe('accepted');
    for(let tick=0;tick<400&&!sim.state.economies.p1!.notifications.some(notice=>notice.entityId===worker.id&&notice.code==='RESOURCE_DEPLETED');tick++)sim.step();
    expect(tree.amount).toBe(0);expect(worker.cargo.amount).toBe(0);expect(sim.state.economies.p1!.collected.wood).toBe(65);expect(sim.state.economies.p1!.notifications.filter(notice=>notice.entityId===worker.id&&notice.code==='RESOURCE_DEPLETED')).toHaveLength(1);
    sim.step(300);expect(sim.state.economies.p1!.notifications.filter(notice=>notice.entityId===worker.id&&notice.code==='RESOURCE_DEPLETED')).toHaveLength(1);
  });
  it('keeps disabled practice AI idle while human villagers still acquire resources',()=>{
    const sim=createSimulation({seed:'quiet-idle-work',matchId:'economy',controllers:false,factions:[factions[0]!,{...factions[2]!,kind:'ai'}]}),human=workers(sim)[0]!,opponent=workers(sim,'p2')[0]!;
    sim.state.entities={[human.id]:human,[opponent.id]:opponent};sim.state.map.terrain=[];for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    human.xMm=50000;human.zMm=50000;opponent.xMm=150000;opponent.zMm=150000;
    structure(sim,'town_center',43000,43000);structure(sim,'town_center',143000,143000,'p2');const own=node(sim,'gold',52000,50000,200000),quiet=node(sim,'gold',152000,150000,200000),bank=structuredClone(sim.state.economies.p2!.resources);
    sim.step(600);expect(own.amount).toBeLessThan(200000);expect(sim.state.economies.p1!.collected.gold).toBeGreaterThan(0);expect(quiet.amount).toBe(200000);expect(opponent).toMatchObject({xMm:150000,zMm:150000,orders:[],cargo:{resource:null,amount:0}});expect(opponent.resourceSearch).toBeUndefined();expect(sim.state.economies.p2!.resources).toEqual(bank);
  });
  it('cancels a defeated worker pending resource handoff and restores the resulting save',()=>{
    const sim=fixture(),worker=workerAt(sim,50000,50000);sim.state.entities={[worker.id]:worker};sim.state.map.terrain=[];for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',43000,50000);structure(sim,'town_center',250000,250000,'p2');const depleted=node(sim,'gold',51000,50000,30);node(sim,'gold',55000,50000,200000);sim.step();
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:depleted.id,queued:false}).status).toBe('accepted');for(let tick=0;tick<200&&!worker.resourceSearch;tick++)sim.step();expect(worker.resourceSearch?.purpose).toBe('depleted');sim.step();expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(true);
    expect(send(sim,{kind:'surrender'}).status).toBe('accepted');expect(worker.resourceSearch).toBeUndefined();expect(worker.orders).toEqual([]);expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);
    const identity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(sim.capture());sim.step(20);restored.step(20);expect(restored.capture()).toEqual(sim.capture());
  });
  it('lets every villager in a crowded group gold command obtain cargo and deposit without overlaps',()=>{
    const sim=fixture(),selected=workers(sim);for(let index=6;index<12;index++)selected.push({...structuredClone(selected[0]!),id:`crowded_gold_${index}`});
    sim.state.entities=Object.fromEntries(selected.map(worker=>[worker.id,worker]));sim.state.map.terrain=[];for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',35000,50000);structure(sim,'town_center',250000,250000,'p2');const deposits=[node(sim,'gold',50000,50000,1000000),node(sim,'gold',53000,50000,1000000),node(sim,'gold',50000,53000,1000000)];
    selected.forEach((worker,index)=>{worker.xMm=46000-(index%3)*1000;worker.zMm=46000+Math.floor(index/3)*1000;worker.orders=[];worker.path=[];worker.autoGather=false;});sim.step();
    expect(send(sim,{kind:'gather',unitIds:selected.map(worker=>worker.id),targetId:deposits[0]!.id,queued:false}).status).toBe('accepted');
    const gathered=new Set<string>();let overlap=false;for(let tick=0;tick<1200;tick++){sim.step();for(const worker of selected){if(worker.cargo.resource==='gold'&&worker.cargo.amount>0)gathered.add(worker.id);if(selected.some(other=>other!==worker&&Math.hypot(worker.xMm-other.xMm,worker.zMm-other.zMm)<700))overlap=true;}}
    expect(overlap).toBe(false);expect(gathered.size).toBe(selected.length);expect(sim.state.economies.p1!.collected.gold).toBeGreaterThanOrEqual(120000);expect(3000000-deposits.reduce((sum,entry)=>sum+entry.amount,0)).toBe(sim.state.economies.p1!.collected.gold+selected.reduce((sum,worker)=>sum+worker.cargo.amount,0));
  });
  it('automatically gathers nearby visible resources after idle, but respects stop, hold and queued movement',()=>{
    const sim=fixture(),selected=workers(sim);sim.state.entities=Object.fromEntries(selected.map(worker=>[worker.id,worker]));sim.state.map.terrain=[];
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',40000,50000);structure(sim,'town_center',250000,250000,'p2');const gold=node(sim,'gold',50000,50000,200000);
    selected.forEach((worker,index)=>{worker.xMm=47000;worker.zMm=46000+index*1500;worker.orders=[];worker.path=[];});sim.step();
    const [active,stopped,held,moving,queued,legacy]=selected;
    send(sim,{kind:'stop',unitIds:[stopped!.id]});send(sim,{kind:'hold_position',unitIds:[held!.id]});
    send(sim,{kind:'move',unitIds:[moving!.id,queued!.id],target:{xMm:70000,zMm:47000},queued:false});send(sim,{kind:'move',unitIds:[queued!.id],target:{xMm:73000,zMm:47000},queued:true});
    // An old save without the optional opt-in must not restart historically stopped units.
    delete (legacy as Unit&{autoGather?:boolean}).autoGather;
    const stopPose={xMm:stopped!.xMm,zMm:stopped!.zMm},holdPose={xMm:held!.xMm,zMm:held!.zMm};
    sim.step(500);
    expect(sim.state.economies.p1!.collected.gold).toBeGreaterThan(0);expect(active!.orders[0]).toMatchObject({kind:'gather',targetId:gold.id});
    expect(stopped).toMatchObject({...stopPose,orders:[],cargo:{resource:null,amount:0}});expect(held).toMatchObject({...holdPose,orders:[],cargo:{resource:null,amount:0}});expect(legacy!.orders).toEqual([]);
    expect(moving!.xMm).toBeGreaterThan(65000);expect(queued!.xMm).toBeGreaterThan(65000);expect(moving!.cargo.amount).toBe(0);expect(queued!.cargo.amount).toBe(0);
    expect(200000-gold.amount).toBe(sim.state.economies.p1!.collected.gold+selected.reduce((sum,worker)=>sum+worker.cargo.amount,0));
    const identity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});
    expect(restored.capture()).toEqual(sim.capture());sim.step(40);restored.step(40);expect(restored.capture()).toEqual(sim.capture());
  });
  it('keeps idle acquisition inside visible nearby reachable resources and cancels pending work on stop',()=>{
    const sim=fixture(),worker=workerAt(sim,50000,50000);sim.state.entities={[worker.id]:worker};sim.state.map.terrain=[];
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',20000,20000);structure(sim,'town_center',250000,250000,'p2');structure(sim,'watchtower',68000,50000);
    const sealed=node(sim,'gold',55000,50000,200000),hidden=node(sim,'wood',39000,50000,200000),distant=node(sim,'gold',65000,50000,200000);
    for(const offset of [-2000,0,2000]){structure(sim,'palisade_wall',55000+offset,48000,'p1');structure(sim,'palisade_wall',55000+offset,52000,'p1');}structure(sim,'palisade_wall',53000,50000,'p1');structure(sim,'palisade_wall',57000,50000,'p1');
    sim.step();expect(sim.view('p1').entities.some(entity=>entity.id===hidden.id)).toBe(false);expect(sim.view('p1').entities.some(entity=>entity.id===distant.id&&!entity.ghost)).toBe(true);
    sim.step(4);expect(worker.resourceSearch).toBeDefined();expect(worker.resourceSearch!.targetIds).toEqual([sealed.id]);
    const identity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});
    const queued=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true}),queuedWorker=queued.state.entities[worker.id] as Unit;
    expect(send(queued,{kind:'move',unitIds:[worker.id],target:{xMm:48000,zMm:50000},queued:true}).status).toBe('accepted');expect(queuedWorker.resourceSearch).toBeUndefined();expect(queuedWorker.orders).toHaveLength(1);expect(queuedWorker.orders[0]?.kind).toBe('move');
    const queuedRestored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(queued,identity))),identity,{preserveEpoch:true});queued.step(10);queuedRestored.step(10);expect(queuedRestored.capture()).toEqual(queued.capture());expect(queuedWorker.xMm).toBeLessThan(50000);expect(queuedWorker.cargo.amount).toBe(0);
    expect(restored.capture()).toEqual(sim.capture());sim.step(500);restored.step(500);expect(restored.capture()).toEqual(sim.capture());
    expect(worker).toMatchObject({xMm:50000,zMm:50000,cargo:{resource:null,amount:0}});expect([sealed.amount,hidden.amount,distant.amount]).toEqual([200000,200000,200000]);
    for(let tick=0;tick<120&&!worker.resourceSearch;tick++)sim.step();expect(worker.resourceSearch).toBeDefined();
    send(sim,{kind:'stop',unitIds:[worker.id]});expect(worker.resourceSearch).toBeUndefined();expect(sim.capture().runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);sim.step(100);expect(worker.orders).toEqual([]);expect(worker.autoGather).toBe(false);
  });
  it('continues depleted gold through bounded resumable route proof and preserves the pending search in saves',()=>{
    const sim=fixture(),worker=workerAt(sim,50000,50000);sim.state.entities={[worker.id]:worker};sim.state.map.terrain=[];
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',43000,50000);structure(sim,'town_center',250000,250000,'p2');
    const depleted=node(sim,'gold',51000,50000,30),sealed=node(sim,'gold',55000,50000,200000),reachable=node(sim,'gold',61000,50000,200000);
    for(const offset of [-2000,0,2000]){structure(sim,'palisade_wall',55000+offset,48000,'p1');structure(sim,'palisade_wall',55000+offset,52000,'p1');}structure(sim,'palisade_wall',53000,50000,'p1');structure(sim,'palisade_wall',57000,50000,'p1');
    // A friendly observer makes both alternatives legally known, including the enclosed nearer one.
    structure(sim,'watchtower',64000,55000);sim.step();expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:depleted.id,queued:false}).status).toBe('accepted');
    const syncSearch=vi.spyOn(Navigation.prototype,'pathToAny');
    try{
      sim.step(40);const identity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});
      expect(restored.capture()).toEqual(sim.capture());
      for(let tick=0;tick<1600;tick++){sim.step();restored.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);if(tick%200===0)expect(restored.capture()).toEqual(sim.capture());}
      expect(syncSearch).not.toHaveBeenCalled();expect(sealed.amount).toBe(200000);expect(reachable.amount).toBeLessThan(200000);expect(sim.state.economies.p1!.collected.gold).toBeGreaterThan(30);
      expect(400030-depleted.amount-sealed.amount-reachable.amount).toBe(sim.state.economies.p1!.collected.gold+worker.cargo.amount);expect(restored.capture()).toEqual(sim.capture());
    }finally{syncSearch.mockRestore();}
  });
  it('uses reachable tight forage gaps for six workers within the existing 650-food deadline',()=>{
    const sim=fixture(),selected=workers(sim);sim.state.entities=Object.fromEntries(selected.map(worker=>[worker.id,worker]));sim.state.map.terrain=[];
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    structure(sim,'town_center',130000,188000);structure(sim,'house',118000,182000);structure(sim,'mill',139000,187000);structure(sim,'lumber_camp',133000,199000);structure(sim,'town_center',250000,250000,'p2');
    // Exact3x2 food geometry from the retained M4 browser failure. Start poses
    // are its earlier2400-tick sample, with an ordinary fresh gather command.
    // This is a mechanics fixture, not an identity-modified replay or save.
    const forage=[];for(const z of [194500,196700])for(const x of [116000,118200,120400])forage.push(node(sim,'food',x,z,200000));
    const positions=[[138652,166050],[142953,187031],[138200,165037],[121195,173114],[136700,164027],[124846,195006]];
    selected.forEach((worker,i)=>{[worker.xMm,worker.zMm]=positions[i]!;worker.orders=[];worker.path=[];worker.cargo={resource:null,amount:0};});sim.state.economies.p1!.resources.food=200000;sim.step();
    const initial=sim.state.economies.p1!.collected.food;expect(send(sim,{kind:'gather',unitIds:selected.map(worker=>worker.id),targetId:forage[1]!.id,queued:false}).status).toBe('accepted');
    let elapsed=0,peakGatherers=0,violation:string|undefined;const gathered=new Set<string>();
    for(;elapsed<240*balance.rules.simulationHz&&sim.state.economies.p1!.resources.food<650000;elapsed++){
      const before=selected.map(worker=>({xMm:worker.xMm,zMm:worker.zMm}));
      const obstacles:Obstacle[]=Object.values(sim.state.entities).flatMap(entity=>entity.kind==='building'?[{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth:buildings[entity.typeId].footprintCells[0]*1000,halfHeight:buildings[entity.typeId].footprintCells[1]*1000}]:entity.kind==='resource'&&entity.amount>0?[{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth:650,halfHeight:650}]:[]);
      const geometry=new Navigation(sim.state.widthMm,sim.state.heightMm,obstacles);sim.step();
      for(const [index,worker]of selected.entries()){
        const radius=units.villager.collisionRadiusM*1000;if(!geometry.clearLine(before[index]!,worker,radius))violation??=`static collision at${elapsed}:${worker.id}`;
        if(selected.some(other=>other!==worker&&Math.hypot(worker.xMm-other.xMm,worker.zMm-other.zMm)<radius*2))violation??=`unit overlap at${elapsed}:${worker.id}`;
        if(worker.cargo.resource==='food'&&worker.cargo.amount>0)gathered.add(worker.id);
      }
      if(forage[1]!.amount>0)peakGatherers=Math.max(peakGatherers,selected.filter(worker=>worker.taskState==='gathering').length);
    }
    console.info(`M4 forage fixture: ${sim.state.economies.p1!.resources.food/1000}food at${elapsed}ticks, ${peakGatherers}simultaneous gatherers before first depletion, ${gathered.size}/6workers collected.`);
    expect(violation).toBeUndefined();expect(gathered.size).toBe(6);expect(peakGatherers).toBeGreaterThanOrEqual(4);expect(sim.state.economies.p1!.resources.food).toBeGreaterThanOrEqual(650000);
    expect(forage.reduce((sum,entry)=>sum+200000-entry.amount,0)).toBe(sim.state.economies.p1!.collected.food-initial+selected.reduce((sum,worker)=>sum+worker.cargo.amount,0));
  });
  it('retries available forage work slots after waiting and repeatedly returns from the drop-off',()=>{
    const sim=fixture(),tc=structure(sim,'town_center',50000,50000);structure(sim,'house',40000,50000);structure(sim,'house',38000,44000);
    const forage=[];for(const z of [56500,58700])for(const x of [36000,38200,40400])forage.push(node(sim,'food',x,z,200000));
    const selected=workers(sim),positions=[[43997,43100],[44296,40862],[41753,39213],[44980,43083],[45991,43116],[43150,54000]];
    selected.forEach((worker,i)=>{[worker.xMm,worker.zMm]=positions[i]!;worker.path=[];});sim.step();
    const initial=sim.state.economies.p1!.collected.food;
    expect(send(sim,{kind:'gather',unitIds:selected.map(e=>e.id),targetId:forage[1]!.id,queued:false}).status).toBe('accepted');
    const gathered=new Set<string>();for(let tick=0;tick<3000;tick++){sim.step();for(const worker of selected)if(worker.cargo.resource==='food'&&worker.cargo.amount>0)gathered.add(worker.id);}
    expect(sim.state.economies.p1!.collected.food-initial).toBeGreaterThanOrEqual(80000);
    expect(gathered.size).toBe(selected.length);
    expect(forage.reduce((sum,entry)=>sum+(200000-entry.amount),0)).toBe(sim.state.economies.p1!.collected.food-initial+selected.reduce((sum,worker)=>sum+worker.cargo.amount,0));
    expect(sim.state.economies.p1!.ledger.filter(entry=>entry.reason==='deposit'&&entry.resource==='food'&&entry.entityId===tc.id).length).toBeGreaterThanOrEqual(8);
  });
  it('keeps the original roomy resource face when it already provides a route',()=>{
    const sim=fixture();structure(sim,'town_center',50000,50000);const food=node(sim,'food',60000,50000,200000),worker=workerAt(sim,57000,50000);sim.step();
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:food.id,queued:false}).status).toBe('accepted');sim.step();
    expect(worker.pathDestination).toEqual({xMm:58500,zMm:50350});
  });
  it('cannot use tighter resource faces through an observed closed wall enclosure',()=>{
    const sim=fixture();structure(sim,'town_center',40000,50000);const food=node(sim,'food',50000,50000,200000),worker=workerAt(sim,47000,55000);
    for(const offset of [-2000,0,2000]){structure(sim,'palisade_wall',50000+offset,48000,'p2');structure(sim,'palisade_wall',50000+offset,52000,'p2');}structure(sim,'palisade_wall',48000,50000,'p2');structure(sim,'palisade_wall',52000,50000,'p2');sim.step();
    expect(sim.view('p1').entities.some(entity=>entity.id===food.id&&!entity.ghost)).toBe(true);const before={xMm:worker.xMm,zMm:worker.zMm,food:food.amount};
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:food.id,queued:false}).status).toBe('accepted');sim.step(200);
    expect({xMm:worker.xMm,zMm:worker.zMm,food:food.amount}).toEqual(before);expect(worker.cargo.amount).toBe(0);expect(worker.blockedReason).toBe('PATH_BLOCKED');
  });
  it.each([1,2,3,4,5,6])('applies the builder curve with %i physical workers and retains damage',count=>{
    const sim=fixture(),building=structure(sim,'mill',50000,50000,'p1',false),selected=workers(sim).slice(0,count);
    selected.forEach((worker,i)=>{worker.xMm=building.xMm-3000+i*1100;worker.zMm=building.zMm+buildings.mill.footprintCells[1]*1000+850;});sim.step();
    expect(send(sim,{kind:'continue_build',builderIds:selected.map(e=>e.id),foundationId:building.id,queued:false}).status).toBe('accepted');building.hp-=20;
    sim.step(20);expect(building.work).toBe(Math.round(balance.rules.constructionWorkerMultipliers[Math.min(count,5)-1]!*2000));expect(building.hp).toBe(building.grantedHp-20);
    selected.forEach(worker=>{worker.zMm+=20000;worker.path=[];});const work=building.work;sim.step();expect(building.work).toBe(work);
    if(count===1){selected[0]!.xMm=47000;selected[0]!.zMm=53850;selected[0]!.path=[];sim.step(700);expect(building.work).toBe(building.required);expect(building.hp).toBe(building.maxHp-20);}
  });
  it('permits one active farmer and conserves the 350-food pool before banking',()=>{
    const sim=fixture(),farm=structure(sim,'farm'),a=workerAt(sim),b=workerAt(sim,57000,50000,'p1',1);reach(sim,a,farm);reach(sim,b,farm,1);
    send(sim,{kind:'gather',unitIds:[a.id,b.id],targetId:farm.id,queued:false});const bank=sim.state.economies.p1!.resources.food;sim.step(20);
    expect(a.cargo.amount+b.cargo.amount).toBe(750);expect(farm.foodRemaining).toBe(349250);expect(sim.state.economies.p1!.resources.food).toBe(bank);expect(b.blockedReason).toBe('FARM_OCCUPIED');expect(sim.view('p1').entities.find(e=>e.id===farm.id)?.farmerAssigned).toBe(true);
  });
  it('debounces occupied-farm notifications while an extra worker is still approaching',()=>{
    const sim=fixture(),farm=structure(sim,'farm'),a=workerAt(sim),b=workerAt(sim,59000,50000,'p1',1);reach(sim,a,farm);
    send(sim,{kind:'gather',unitIds:[a.id,b.id],targetId:farm.id,queued:false});sim.step(30);
    expect(sim.state.economies.p1!.notifications.filter(n=>n.entityId===b.id&&n.code==='FARM_OCCUPIED')).toHaveLength(1);
  });
  it('charges reseeding once, requires actual work, and resumes interrupted paid work',()=>{
    const sim=fixture(),farm=structure(sim,'farm'),worker=workerAt(sim);farm.foodRemaining=0;reach(sim,worker,farm);
    send(sim,{kind:'set_auto_reseed',enabled:true});send(sim,{kind:'gather',unitIds:[worker.id],targetId:farm.id,queued:false});sim.step();
    expect(sim.view('p1').self.resources.wood).toBe(190);sim.step(100);expect(farm.reseedWork).toBe(10000);
    send(sim,{kind:'stop',unitIds:[worker.id]});sim.step(100);expect(farm.reseedWork).toBe(10000);
    expect(send(sim,{kind:'reseed_farm',farmId:farm.id,builderId:worker.id}).status).toBe('accepted');sim.step(299);expect(farm.foodRemaining).toBe(0);sim.step();expect(farm.foodRemaining).toBe(350000);expect(sim.view('p1').self.resources.wood).toBe(190);expect(sim.state.economies.p1!.ledger.filter(e=>e.reason==='farm_reseed')).toHaveLength(1);
  });
  it('keeps an exhausted farm recoverable while wood is unavailable',()=>{
    const sim=fixture(),farm=structure(sim,'farm'),worker=workerAt(sim);farm.foodRemaining=0;reach(sim,worker,farm);sim.state.economies.p1!.resources.wood=59000;
    send(sim,{kind:'set_auto_reseed',enabled:true});send(sim,{kind:'gather',unitIds:[worker.id],targetId:farm.id,queued:false});sim.step(40);
    expect(farm.reseedRequired).toBeUndefined();expect(farm.foodRemaining).toBe(0);expect(sim.view('p1').self.resources.wood).toBe(59);expect(worker.blockedReason).toBe('INSUFFICIENT_RESOURCES');
    transact(sim.state.economies.p1!,{...emptyBank(),wood:1000},'fixture',sim.state.tick);sim.step();expect(farm.reseedRequired).toBe(40000);expect(sim.view('p1').self.resources.wood).toBe(0);
  });
  it('repairs proportionally, caps HP and keeps each allied contributor responsible for its bank',()=>{
    const sim=fixture(),mill=structure(sim,'mill'),a=workerAt(sim),ally=workerAt(sim,57000,50000,'ally');mill.hp=mill.maxHp-100;reach(sim,a,mill);reach(sim,ally,mill,1);
    sim.state.economies.p1!.resources.wood=0;send(sim,{kind:'repair',unitIds:[a.id],targetId:mill.id,queued:false});send(sim,{kind:'repair',unitIds:[ally.id],targetId:mill.id,queued:false},'ally');const before=sim.state.economies.ally!.resources.wood;
    sim.step(20);expect(mill.hp).toBe(mill.maxHp-90);expect(sim.state.economies.p1!.resources.wood).toBe(0);expect(sim.state.economies.ally!.resources.wood).toBeLessThan(before);
    sim.state.economies.p1!.resources.wood=100000;sim.step(300);expect(mill.hp).toBe(mill.maxHp);const spent=sim.state.economies.p1!.spent.wood+sim.state.economies.ally!.spent.wood;expect(spent).toBeLessThanOrEqual(100*50000/mill.maxHp);expect(spent).toBeGreaterThan(0);
  });
  it('excludes five unfunded repairers from the efficiency cap and allows partial affordable HP',()=>{
    const sim=fixture(),mill=structure(sim,'mill'),unfunded=workers(sim).slice(0,5),ally=workerAt(sim,54000,50000,'ally');mill.hp-=100;
    unfunded.forEach((worker,index)=>{worker.xMm=47000+index*1100;worker.zMm=53850;});reach(sim,ally,mill,1);sim.state.economies.p1!.resources.wood=0;
    send(sim,{kind:'repair',unitIds:unfunded.map(w=>w.id),targetId:mill.id,queued:false});send(sim,{kind:'repair',unitIds:[ally.id],targetId:mill.id,queued:false},'ally');sim.step(20);expect(mill.hp).toBe(mill.maxHp-90);
    send(sim,{kind:'stop',unitIds:[ally.id]},'ally');sim.state.economies.p1!.resources.wood=63;mill.repairCredits={p1:900};const before=mill.hp;sim.step();expect(mill.hp).toBe(before+1);expect(sim.state.economies.p1!.resources.wood).toBe(1);
  });
  it('waits three seconds before demolition and gives no refund',()=>{
    const sim=fixture(),mill=structure(sim,'mill'),bank=structuredClone(sim.state.economies.p1!.resources);expect(send(sim,{kind:'demolish',buildingId:mill.id}).status).toBe('accepted');sim.step(59);expect(sim.state.entities[mill.id]).toBeDefined();sim.step();expect(sim.state.entities[mill.id]).toBeUndefined();expect(sim.state.economies.p1!.resources).toEqual(bank);
  });
});

describe('M2 cargo, visibility and work barriers',()=>{
  it('hides units behind cliffs, reveals them through ramp openings, and sees through walls',()=>{
    const sim=fixture(),worker=workerAt(sim,48000,50000),enemy=workerAt(sim,54000,50000,'p2');
    sim.state.map.terrain.push({id:'sight_cliff',kind:'cliff',xMm:50500,zMm:40000,widthMm:1000,depthMm:20000,elevationMm:6000});sim.state.navigationRevision++;sim.step();
    expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(false);
    sim.state.map.terrain.push({id:'sight_ramp',kind:'ramp',xMm:50000,zMm:47000,widthMm:2000,depthMm:6000,axis:'x',startElevationMm:0,endElevationMm:6000});sim.state.navigationRevision++;sim.step();expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(true);
    structure(sim,'palisade_wall',51000,50000);sim.step();expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(true);expect(worker.hp).toBe(worker.maxHp);
  });
  it('rejects a discovered sloped foundation and accepts nearby flat terrain without a hidden-state error',()=>{
    const sim=fixture(),worker=workerAt(sim,50000,50000),scout=Object.values(sim.state.entities).find(entity=>entity.ownerId==='p1'&&entity.typeId==='scout')!;
    // Discover both complete placement halos. The villager's 9m sight alone
    // cannot reveal their far fog cells; that would test discovery, not slope.
    scout.xMm=50000;scout.zMm=52000;sim.step();
    sim.state.map.terrain.push({id:'placement_hill',kind:'hill',xMm:51000,zMm:48000,widthMm:6000,depthMm:6000,elevationMm:1500});sim.state.navigationRevision++;sim.step();const bank=sim.view('p1').self.resources.wood;
    expect(send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:26,z:24},rotation:0,queued:false}).code).toBe('PLACEMENT_BLOCKED');expect(sim.view('p1').self.resources.wood).toBe(bank);
    expect(send(sim,{kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:22,z:24},rotation:0,queued:false}).status).toBe('accepted');
  });
  it.each(['gold','stone'] as const)('mines and physically deposits %s at a mining camp',resource=>{
    const sim=fixture(),camp=structure(sim,'mining_camp',43000,50000),ore=node(sim,resource,51000,50000),worker=workerAt(sim,48000,50000);sim.step();const initial=ore.amount,bank=sim.state.economies.p1!.resources[resource];
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:ore.id,queued:false}).status).toBe('accepted');sim.step(600);
    expect(sim.state.economies.p1!.resources[resource]).toBeGreaterThan(bank);expect(initial-ore.amount).toBe(sim.state.economies.p1!.resources[resource]-bank+worker.cargo.amount);expect(sim.state.economies.p1!.ledger.some(e=>e.reason==='deposit'&&e.entityId===camp.id)).toBe(true);
    expect(sim.view('p1').self.incomePerMinute?.[resource]).toBe(Math.floor(sim.state.economies.p1!.collected[resource]/1000*1200/sim.state.tick));
  });
  it('reroutes cargo when its selected drop-off is destroyed during return travel',()=>{
    const sim=fixture(),first=structure(sim,'lumber_camp',55000,50000),second=structure(sim,'lumber_camp',39000,50000),tree=node(sim,'wood',49000,55000),worker=workerAt(sim,48000,50000);sim.step();worker.cargo={resource:'wood',amount:10000};const bank=sim.state.economies.p1!.resources.wood;
    send(sim,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false});sim.step(4);expect(worker.orders[0]?.dropOffId).toBe(first.id);expect(worker.cargo.amount).toBe(10000);first.hp=0;sim.step(160);
    expect(sim.state.economies.p1!.resources.wood-bank).toBe(10000);expect(sim.state.economies.p1!.ledger.some(e=>e.reason==='deposit'&&e.entityId===second.id)).toBe(true);
  });
  it.each([50,300] as const)('abandons a completed trip to the only destroyed drop-off without losing cargo (%i ms)',async interval=>{
    const base=fixture(),worker=workerAt(base,50000,50000);worker.autoGather=false;
    for(const entity of Object.values(base.state.entities))if(entity.ownerId!=='p2'&&entity.id!==worker.id)delete base.state.entities[entity.id];
    const camp=structure(base,'lumber_camp',42000,50000),tree=node(base,'wood',52000,50000);base.step();
    worker.cargo={resource:'wood',amount:10000};
    expect(send(base,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false}).status).toBe('accepted');base.step();
    // Complete real scheduler work before movement consumes it, as a worker reply
    // can arrive just before a building dies at the next authoritative boundary.
    const scheduler=(base as unknown as {pathScheduler:PathScheduler}).pathScheduler;scheduler.advance(4000,base.state.tick);
    const payload=base.capture();expect(payload.runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)).toMatchObject({stage:'done',result:{status:'ready'}});
    delete payload.state.entities[camp.id];delete payload.state.vision.p1!.memory[camp.id];payload.state.navigationRevision++;
    payload.options.authoritativeIntervalMs=interval;
    const options={...payload.options,factions,seed:'economy-fixture',matchId:'economy',controllers:false,authoritativeIntervalMs:interval};
    const sim=interval===300?createLiveSimulation(options,payload):new Simulation(options,payload),bank=sim.state.economies.p1!.resources.wood;
    sim.advanceFrame();await sim.synchronizeCapture();let saved=sim.capture(),current=saved.state.entities[worker.id] as Unit;
    expect(current).toMatchObject({xMm:worker.xMm,zMm:worker.zMm,cargo:{resource:'wood',amount:10000},orders:[{kind:'gather',targetId:tree.id,phase:'deposit'}]});
    expect(current.path).toEqual([]);expect(current.pathRequestId).toBeUndefined();expect(current.pathDestination).toBeUndefined();expect(current.approachGoal).toBeUndefined();expect(current.orders[0]?.dropOffId).toBeUndefined();
    expect(saved.runtime.pathScheduler.tasks.some(task=>task.unitId===worker.id)).toBe(false);expect(saved.state.economies.p1!.resources.wood).toBe(bank);
    // A newly completed nearby camp re-enables the same cargo/order after a cold
    // continuation; neither recovery nor the obsolete route may mint resources.
    const replacement={...camp,id:'replacement_dropoff',xMm:worker.xMm-2850,zMm:worker.zMm};saved.state.entities[replacement.id]=replacement;saved.state.navigationRevision++;
    const resumed=interval===300?createLiveSimulation(options,saved):new Simulation(options,saved);resumed.advanceFrame();await resumed.synchronizeCapture();saved=resumed.capture();current=saved.state.entities[worker.id] as Unit;
    expect(current.cargo.amount).toBeLessThan(10000);expect(saved.state.economies.p1!.resources.wood-bank).toBe(10000);expect(saved.state.economies.p1!.ledger.filter(entry=>entry.reason==='deposit'&&entry.entityId===replacement.id)).toHaveLength(1);
  });
  it.each([50,300] as const)('cancels the completed route of a destroyed foundation before a queued move (%i ms)',async interval=>{
    const base=fixture(),worker=workerAt(base,50000,50000);worker.autoGather=false;
    const foundation=structure(base,'house',42000,50000,'p1',false);base.step();
    expect(send(base,{kind:'continue_build',builderIds:[worker.id],foundationId:foundation.id,queued:false}).status).toBe('accepted');base.step();
    const scheduler=(base as unknown as {pathScheduler:PathScheduler}).pathScheduler;scheduler.advance(4000,base.state.tick);
    expect(base.capture().runtime.pathScheduler.tasks.find(task=>task.unitId===worker.id)).toMatchObject({stage:'done',result:{status:'ready'}});
    const target={xMm:60000,zMm:50000};expect(send(base,{kind:'move',unitIds:[worker.id],target,queued:true}).status).toBe('accepted');
    const payload=base.capture(),revision=worker.orderRevision!;delete payload.state.entities[foundation.id];delete payload.state.vision.p1!.memory[foundation.id];payload.state.navigationRevision++;
    const options={...payload.options,factions,seed:'economy-fixture',matchId:'economy',controllers:false,authoritativeIntervalMs:interval},sim=interval===300?createLiveSimulation(options,payload):new Simulation(options,payload);
    sim.advanceFrame();await sim.synchronizeCapture();const saved=sim.capture(),current=saved.state.entities[worker.id] as Unit;
    expect(current.orders).toHaveLength(1);expect(current.orders[0]).toMatchObject({kind:'move',target,manualOrder:true});expect(current.orderRevision).toBeGreaterThan(revision);
    expect(current.pathDestination).toEqual(target);expect(current.xMm).toBeGreaterThanOrEqual(worker.xMm);
    expect(saved.runtime.pathScheduler.tasks.filter(task=>task.unitId===worker.id).every(task=>task.orderRevision===current.orderRevision&&task.target.xMm===target.xMm)).toBe(true);
  });
  it('deposits old wood at an allied camp into the worker bank before mining gold',()=>{
    const sim=fixture(),camp=structure(sim,'lumber_camp',50000,50000,'ally'),gold=node(sim,'gold',53000,57000),worker=workerAt(sim);reach(sim,worker,camp);worker.cargo={resource:'wood',amount:7000};const allyBank=sim.state.economies.ally!.resources.wood,ownBank=sim.state.economies.p1!.resources.wood;
    expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:gold.id,queued:false}).status).toBe('accepted');sim.step();expect(sim.state.economies.p1!.resources.wood-ownBank).toBe(7000);expect(sim.state.economies.ally!.resources.wood).toBe(allyBank);expect(worker.cargo.amount).toBe(0);sim.step(200);expect(worker.cargo.resource).toBe('gold');expect(worker.cargo.amount).toBeGreaterThan(0);
  });
  it('records lost cargo on death without banking it',()=>{
    const sim=fixture(),worker=workerAt(sim),tree=node(sim,'wood',45000,50000,3000);sim.step();send(sim,{kind:'gather',unitIds:[worker.id],targetId:tree.id,queued:false});sim.step(120);const carried=worker.cargo.amount,bank=sim.state.economies.p1!.resources.wood;expect(carried).toBeGreaterThan(0);worker.hp=0;sim.step();expect(sim.state.economies.p1!.resources.wood).toBe(bank);expect(sim.state.economies.p1!.lostCargo.wood).toBe(carried);expect(tree.amount+carried).toBe(3000);
  });
  it('does not choose unseen deposits and pursues stale resource memory without learning hidden depletion',()=>{
    const sim=fixture(),worker=workerAt(sim,49000,50000),a=node(sim,'wood',50000,50000,0),hidden=node(sim,'wood',70000,50000,50000);sim.step();worker.orders=[{kind:'gather',targetId:a.id,phase:'gather'}];sim.step();expect(worker.orders).toHaveLength(0);expect(worker.blockedReason).toBe('RESOURCE_DEPLETED');
    sim.state.vision.p1!.memory[hidden.id]={id:hidden.id,kind:'resource',ownerId:null,typeId:hidden.typeId,xMm:hidden.xMm,zMm:hidden.zMm,hp:1,maxHp:1,resource:'wood',amount:50};hidden.amount=0;worker.orders=[{kind:'gather',targetId:a.id,phase:'gather'}];worker.path=[];
    for(let tick=0;tick<200&&worker.orders[0]?.targetId!==hidden.id;tick++){sim.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);}
    expect(worker.orders[0]?.targetId).toBe(hidden.id);expect(worker.taskState).toBe('moving');expect(sim.view('p1').entities.find(entity=>entity.id===hidden.id)).toMatchObject({ghost:true,amount:50});
  });
  it.each(['gather','build','repair'] as const)('blocks %s work through an intervening solid wall',kind=>{
    const sim=fixture(),worker=workerAt(sim,47500,50000),target=kind==='gather'?node(sim,'wood',49000,50000):structure(sim,'mill',51500,50000,'p1',kind==='repair');
    if(target.kind==='building'&&kind==='repair')target.hp-=100;sim.step();
    const before=target.kind==='resource'?target.amount:kind==='build'?target.work:target.hp;
    const command:GameplayCommand=kind==='gather'?{kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false}:kind==='build'?{kind:'continue_build',builderIds:[worker.id],foundationId:target.id,queued:false}:{kind:'repair',unitIds:[worker.id],targetId:target.id,queued:false};
    expect(send(sim,command).status).toBe('accepted');
    // A thin physical barrier fits inside interaction range without overlapping
    // either entity. The same order must work once the barrier is removed.
    sim.state.map.terrain.push({id:'work_barrier',kind:'cliff',xMm:48000,zMm:40000,widthMm:400,depthMm:20000,elevationMm:6000});sim.state.navigationRevision++;
    sim.step();expect(target.kind==='resource'?target.amount:kind==='build'?target.work:target.hp).toBe(before);
    sim.state.map.terrain=sim.state.map.terrain.filter(t=>t.id!=='work_barrier');sim.state.navigationRevision++;worker.xMm=47500;worker.zMm=50000;worker.path=[];sim.step(4);
    if(target.kind==='resource')expect(target.amount).toBeLessThan(before);else expect(kind==='build'?target.work:target.hp).toBeGreaterThan(before);
  });
});
