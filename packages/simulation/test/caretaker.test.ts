import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, units, contentHash, validateClientCommand, terrainBuildable, placementAreaDiscovered, type PlayerView, type ViewEntity, type UnitId, type GameplayCommand, type BuildingId, type Position, type Cell } from '@frontier/shared';
import { caretakerCommands, emptyCaretakerMemory, buildingCommand, missingAgeBuildings, ageProgressionReserve, campExpansionAllowed, baseRecoveryCommand, constructionAvoidCells, unstaffedFoundationCommand, type RulePolicyOptions } from '../src/caretaker.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { createCommanderState } from '../src/ai-controller.js';
import { commanderCommands } from '../src/ai-policy.js';
import { fallbackCommands } from '../src/fallback.js';
import * as fallbackPolicy from '../src/fallback.js';
import { fortifyPlacementCellLimit } from '../src/fortify-geometry.js';
import { aiBuildingClearanceMm } from '../src/ai-exploration.js';
import { createSimulation, exportSimulationSave, restoreSimulation, exportReplay, replayCheckpoint, ReplayRunner, type Simulation, type Unit, type Building, type EngineIdentity } from '../src/index.js';

const identity:EngineIdentity={engineBuildHash:'3'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function unit(id:string,typeId:UnitId,ownerId='blue',xMm=60000,zMm=60000):ViewEntity{return {id,kind:'unit',typeId,ownerId,xMm,zMm,hp:units[typeId].maxHp,maxHp:units[typeId].maxHp,order:'idle'};}
function structure(id:string,typeId:string,xMm:number,zMm:number):ViewEntity{return {id,kind:'building',typeId,ownerId:'blue',xMm,zMm,hp:buildings[typeId].maxHp,maxHp:buildings[typeId].maxHp,progress:1,queue:[]};}
function observation():PlayerView{return {protocolVersion:2,contentHash,matchId:'caretaker',matchEpoch:1,tick:10,sequence:10,playerId:'blue',status:'RUNNING',map:{widthMm:120000,heightMm:120000,fogCellMm:2000},self:{populationLimit:120,lastCommandSequence:0,resources:{food:2000,wood:2000,gold:2000,stone:1000},age:2,population:24,populationCap:60,reservedPopulation:0,technologies:[],autoReseed:false},players:[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}],entities:[structure('home','town_center',40000,40000),structure('barracks','barracks',56000,42000),structure('range','archery_range',68000,42000),structure('mill','mill',24000,40000),structure('lumber','lumber_camp',26000,56000),structure('mine','mining_camp',44000,56000),...Array.from({length:20},(_,i)=>({...unit(`worker_${i}`,'villager','blue',35000+i*800,65000),order:'gather'})),unit('soldier_a','militia'),unit('soldier_b','militia','blue',62000,60000),unit('soldier_c','militia','blue',64000,60000),{id:'forage',kind:'resource',typeId:'forage_patch',ownerId:null,xMm:20000,zMm:20000,hp:1,maxHp:1,resource:'food',amount:1200}],fog:{visible:Array.from({length:3600},(_,i)=>i),explored:Array.from({length:3600},(_,i)=>i)}};}
function placementFog(view:PlayerView,sites:Cell[],width=3,depth=3):number[]{const halo=Math.ceil(balance.rules.treeBuildingClearanceM*1000/view.map.fogCellMm),columns=view.map.widthMm/view.map.fogCellMm;return [...new Set(sites.flatMap(site=>Array.from({length:(width+halo*2)*(depth+halo*2)},(_,index)=>(site.z-halo+Math.floor(index/(width+halo*2)))*columns+site.x-halo+index%(width+halo*2))))];}
function delayed(view:PlayerView){const memory=emptyCaretakerMemory();expect(caretakerCommands(view,memory)).toEqual([]);view.tick=25;expect(caretakerCommands(view,memory)).toEqual([]);view.tick=26;return {commands:caretakerCommands(view,memory),memory};}
function simulation(){return createSimulation({matchId:'control',seed:'caretaker-control',controllers:false,caretakerEnabled:true,sharedVision:false,factions:[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]});}
function send(sim:Simulation,command:GameplayCommand,source:'human'|'caretaker'='human'){const sequence=sim.state.economies.blue!.lastClientSequence+1;return sim.command('blue',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`control_${sequence}`,clientSequence:sequence,command},source);}

describe('D108 economic recovery',()=>{
  function ready(){const view=observation();view.entities.push(structure('market','market',92000,90000),structure('smith','blacksmith',108000,90000));return view;}
  it('saves food and gold for a ready age instead of renewing optional military spending',()=>{
    const view=ready();view.self.resources={food:700,wood:4100,gold:4500,stone:3500};
    expect(ageProgressionReserve(view)).toEqual(balance.ages.find(age=>age.id===3)!.cost);
    const memory=emptyCaretakerMemory();caretakerCommands(view,memory,{targetWorkers:20,scoutAllowed:false,desiredUnitType:'militia'});
    expect(memory.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='train')).toBe(false);
    view.self.resources.food=800;view.tick+=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;caretakerCommands(view,memory,{targetWorkers:20,scoutAllowed:false,desiredUnitType:'militia'});
    expect(memory.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'advance_age',townCenterId:'home',targetAge:3});
  });
  it('allows one immediate defense purchase under an observed nearby attack',()=>{
    const view=ready();view.self.resources={food:200,wood:4100,gold:4500,stone:3500};view.entities.push(unit('invader','militia','red',46000,46000));
    const memory=emptyCaretakerMemory();caretakerCommands(view,memory,{targetWorkers:20,scoutAllowed:false,desiredUnitType:'militia'});
    expect(memory.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'train',buildingId:'barracks',unitType:'militia',quantity:1});
  });
  it('bounds camp purchases by useful workforce including unpaid camp purchases',()=>{
    const view=ready();expect(campExpansionAllowed(view,'lumber_camp')).toBe(true);
    view.entities.push(structure('camp3','lumber_camp',92000,30000),structure('camp4','mining_camp',106000,30000));expect(campExpansionAllowed(view,'mining_camp')).toBe(false);expect(campExpansionAllowed(view,'market')).toBe(true);
    view.entities.pop();expect(campExpansionAllowed(view,'mining_camp',[{kind:'build',buildingType:'lumber_camp',builderIds:['worker_0'],originCell:{x:40,z:40},rotation:0,queued:false}])).toBe(false);
    for(const entity of view.entities)if(entity.typeId==='mining_camp')entity.typeId='lumber_camp';view.entities.push(structure('camp5','lumber_camp',106000,30000));expect(campExpansionAllowed(view,'mining_camp')).toBe(true);expect(campExpansionAllowed(view,'lumber_camp')).toBe(false);expect(campExpansionAllowed(view,'mining_camp',[{kind:'build',buildingType:'mining_camp',builderIds:['worker_0'],originCell:{x:40,z:40},rotation:0,queued:false}])).toBe(false);
  });
  it.each([false,true])('moves only an unprotected idle unit away from a blocked exit (protected=%s)',protectedUnit=>{
    const view=ready();view.self.age=4;view.entities=view.entities.filter(entity=>!entity.id.startsWith('soldier'));view.entities.push(unit('exit_blocker','militia','blue',73000,42000));
    view.entities.find(entity=>entity.id==='range')!.queue=[{id:'paid_archer',kind:'train',typeId:'archer',progress:1,state:'exit_blocked',started:true,blockedReason:'EXIT_BLOCKED'}];
    const memory=emptyCaretakerMemory();caretakerCommands(view,memory,{targetWorkers:20,allowMilitaryProduction:false,scoutAllowed:false,...(protectedUnit?{protectedEntityIds:new Set(['exit_blocker'])}:{})});
    const clear=memory.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes('exit_blocker'));
    expect(Boolean(clear)).toBe(!protectedUnit);expect(view.entities.find(entity=>entity.id==='range')!.queue).toHaveLength(1);
  });
});

describe('live abandoned economy recovery',()=>{
  const options:RulePolicyOptions={allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false};
  const queued=(memory:ReturnType<typeof emptyCaretakerMemory>)=>memory.pending.flatMap(batch=>batch.commands);
  function blocked(){const view=observation(),memory=emptyCaretakerMemory(),site={...structure('blocked_plan','archery_range',96000,90000),progress:0,pendingConstruction:true,blockedReason:'PLACEMENT_BLOCKED'};view.entities.push(site);return {view,memory,site};}
  it.each((['caretaker','commander'] as const).flatMap(driver=>[false,true].flatMap(noHome=>(['physical','cleared','blocked','gone','foreign','protected'] as const).map(condition=>({driver,noHome,condition})))))('revalidates delayed cancellation for $driver with noHome=$noHome and $condition site',({driver,noHome,condition})=>{
    const {view,site}=blocked(),memory=createCommanderState(view.matchId,view.playerId),move:GameplayCommand={kind:'move',unitIds:['worker_0'],target:{xMm:80000,zMm:80000},queued:false},cancel:GameplayCommand={kind:'cancel_foundation',foundationId:site.id};if(noHome)view.entities=view.entities.filter(entity=>entity.id!=='home');view.tick=40;
    memory.pending=[{observedTick:24,executeTick:40,commands:[cancel,move]}];if(condition==='physical'){delete (site as ViewEntity).pendingConstruction;site.progress=.1;}if(condition==='cleared')delete (site as ViewEntity).blockedReason;if(condition==='gone')view.entities=view.entities.filter(entity=>entity!==site);if(condition==='foreign')site.ownerId='red';const protectedIds=condition==='protected'?new Set([site.id]):undefined,before=structuredClone(view);
    const due=driver==='caretaker'?caretakerCommands(view,memory,{...options,protectedEntityIds:protectedIds}):commanderCommands(view,memory,undefined,protectedIds).map(proposal=>proposal.command);expect(due.filter(command=>command.kind==='cancel_foundation')).toEqual(condition==='blocked'?[cancel]:[]);expect(due.find(command=>command.kind==='move'&&command.unitIds.includes('worker_0'))).toBe(move);expect(view).toEqual(before);expect(memory.pending.every(batch=>batch.executeTick>view.tick)).toBe(true);
  });
  it('retries an abandoned paid plan once per interval, then cancels only an unmaterialized blocked site and avoids its footprint',()=>{
    const {view,memory,site}=blocked(),workers=view.entities.filter(entity=>entity.typeId==='villager');
    expect(unstaffedFoundationCommand(site,workers,new Set())).toBeUndefined();
    caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toHaveLength(1);expect(queued(memory).some(command=>command.kind==='cancel_foundation')).toBe(false);
    memory.pending=[];view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
    view.tick+=Math.max(60,balance.ai.difficulty.medium.strategicIntervalSeconds*3)*balance.rules.simulationHz;memory.pending=[];caretakerCommands(view,memory,options);
    expect(queued(memory).filter(command=>command.kind==='cancel_foundation')).toEqual([{kind:'cancel_foundation',foundationId:site.id}]);
    const cells=constructionAvoidCells(view,memory);expect(cells).toHaveLength(buildings.archery_range.footprintCells[0]*buildings.archery_range.footprintCells[1]);
    view.entities=view.entities.filter(entity=>entity!==site);const action=buildingCommand(view,'archery_range',site,workers,0,cells);expect(action?.kind).toBe('build');if(action?.kind!=='build')throw new Error('NO_RELOCATION');expect(cells).not.toContainEqual(action.originCell);
    view.tick+=180*balance.rules.simulationHz;expect(constructionAvoidCells(view,memory)).toEqual([]);
  });
  it.each(['physical','protected_site','protected_builder','queued_builder','block_cleared'] as const)('does not cancel a %s site during recovery',condition=>{
    const {view,memory,site}=blocked(),worker=view.entities.find(entity=>entity.id==='worker_0')!,protectedEntityIds=new Set<string>();
    if(condition==='physical')delete (site as ViewEntity).pendingConstruction;
    if(condition==='protected_site')protectedEntityIds.add(site.id);
    if(['protected_builder','queued_builder'].includes(condition)){worker.order='build';worker.workTargetId=site.id;worker.taskState='blocked';worker.blockedReason='PLACEMENT_BLOCKED';if(condition==='protected_builder')protectedEntityIds.add(worker.id);if(condition==='queued_builder')worker.queuedOrderCount=1;}
    caretakerCommands(view,memory,{...options,protectedEntityIds});memory.pending=[];view.tick+=Math.max(60,balance.ai.difficulty.medium.strategicIntervalSeconds*3)*balance.rules.simulationHz;if(condition==='block_cleared')delete (site as ViewEntity).blockedReason;caretakerCommands(view,memory,{...options,protectedEntityIds});expect(queued(memory).some(command=>command.kind==='cancel_foundation')).toBe(false);
  });
  it('can cancel an impossible pending home without discarding its emergency builder cargo',()=>{
    const {view,memory,site}=blocked(),worker=view.entities.find(entity=>entity.id==='worker_0')!;view.entities=view.entities.filter(entity=>entity.id!=='home');site.typeId='town_center';worker.order='build';worker.workTargetId=site.id;worker.cargo={resource:'wood',amount:35};
    caretakerCommands(view,memory,options);memory.pending=[];view.tick+=Math.max(60,balance.ai.difficulty.medium.strategicIntervalSeconds*3)*balance.rules.simulationHz;caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([{kind:'cancel_foundation',foundationId:site.id}]);expect(worker.cargo).toEqual({resource:'wood',amount:35});
  });
  it('retries the same stalled emergency home builder at a bounded cadence',()=>{
    const {view,memory,site}=blocked(),worker=view.entities.find(entity=>entity.id==='worker_0')!;view.entities=view.entities.filter(entity=>entity.id!=='home');site.typeId='town_center';delete (site as ViewEntity).pendingConstruction;delete (site as ViewEntity).blockedReason;worker.order='build';worker.workTargetId=site.id;worker.taskState='blocked';worker.blockedReason='PATH_BLOCKED';worker.cargo={resource:'wood',amount:35};
    memory.construction={destroyed_site:{progress:0,lastProgressTick:0,builders:{}},[site.id]:{progress:0,lastProgressTick:0,builders:{gone_worker:{xMm:1000,zMm:1000,lastMovedTick:0}}}};
    caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([{kind:'continue_build',foundationId:site.id,builderIds:[worker.id],queued:false}]);expect(Object.keys(memory.construction)).toEqual([site.id]);expect(Object.keys(memory.construction[site.id]!.builders)).toEqual([worker.id]);memory.pending=[];view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([]);expect(worker.cargo).toEqual({resource:'wood',amount:35});
  });
  it('rebuilds a lost Town Center while all workers carry cargo and retains manual protection',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.entities=view.entities.filter(entity=>entity.typeId!=='town_center');view.self.age=4;
    for(const worker of view.entities.filter(entity=>entity.typeId==='villager')){worker.cargo={resource:'wood',amount:35};worker.order='gather';worker.taskState='blocked';worker.blockedReason='NO_REACHABLE_DROP_OFF';}
    const before=structuredClone(view);caretakerCommands(view,memory,{...options,protectedEntityIds:new Set(['worker_0'])});const action=queued(memory).find(command=>command.kind==='build');expect(action).toMatchObject({kind:'build',buildingType:'town_center'});if(action?.kind!=='build')throw new Error('NO_RECOVERY');expect(action.builderIds).not.toContain('worker_0');expect(view).toEqual(before);
    const workers=view.entities.filter(entity=>entity.typeId==='villager');expect(baseRecoveryCommand(view,workers,new Set(),new Set(workers.map(worker=>worker.id)))).toBeUndefined();
  });
  it('buys a cheaper missing cargo dropoff when a Town Center is not affordable',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.entities=view.entities.filter(entity=>entity.kind!=='building');view.self.resources={food:0,wood:buildings.lumber_camp.cost.wood,gold:0,stone:0};
    for(const worker of view.entities.filter(entity=>entity.typeId==='villager'))worker.cargo={resource:'wood',amount:35};
    caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([expect.objectContaining({kind:'build',buildingType:'lumber_camp'})]);
  });
  it('resumes an orphaned emergency cargo camp without buying another dropoff',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.entities=view.entities.filter(entity=>entity.kind!=='building');view.self.resources={food:0,wood:0,gold:0,stone:0};view.entities.push({...structure('paid_dropoff','lumber_camp',80000,90000),progress:.1});for(const worker of view.entities.filter(entity=>entity.typeId==='villager'))worker.cargo={resource:'wood',amount:35};
    caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([expect.objectContaining({kind:'continue_build',foundationId:'paid_dropoff'})]);
  });
  it('tries a small cargo dropoff when affordable Town Center footprints are undiscovered',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.entities=view.entities.filter(entity=>entity.kind!=='building');view.fog.explored=placementFog(view,[{x:15,z:28}],3,3);view.fog.visible=[];
    for(const worker of view.entities.filter(entity=>entity.typeId==='villager'))worker.cargo={resource:'wood',amount:35};
    caretakerCommands(view,memory,options);expect(queued(memory)).toEqual([expect.objectContaining({kind:'build',buildingType:'lumber_camp'})]);
  });
  it('completes paid emergency Town Center construction and deposits preserved cargo through ordinary commands',()=>{
    const sim=simulation();sim.state.entities=Object.fromEntries(Object.entries(sim.state.entities).filter(([,entity])=>entity.ownerId!=='blue'||entity.kind!=='building'));sim.state.economies.blue!.resources={food:2000000,wood:2000000,gold:2000000,stone:2000000};sim.state.navigationRevision++;
    const carriers=Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='villager');for(const worker of carriers)worker.cargo={resource:'wood',amount:35000};
    sim.step();const view=sim.view('blue'),workers=view.entities.filter(entity=>entity.typeId==='villager'),command=baseRecoveryCommand(view,workers,new Set());expect(command?.kind).toBe('build');if(command?.kind!=='build')throw new Error('NO_HOME_SITE');
    const before={...sim.state.economies.blue!.resources},cargo=carriers.map(worker=>({...worker.cargo}));expect(send(sim,command).status).toBe('accepted');
    for(const resource of balance.resourceOrder)expect(sim.state.economies.blue!.resources[resource]).toBe(before[resource]-buildings.town_center.cost[resource]*balance.rules.resourceScale);expect(carriers.map(worker=>worker.cargo)).toEqual(cargo);
    const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='town_center')!;
    for(let tick=0;tick<(buildings.town_center.buildSeconds+100)*balance.rules.simulationHz&&home.work<home.required;tick++)sim.step();expect(home.work).toBe(home.required);
    const worker=carriers.find(worker=>worker.id===command.builderIds[0])!,resource=sim.view('blue').entities.find(entity=>entity.kind==='resource'&&entity.resource==='wood'&&(entity.amount??0)>0);expect(resource).toBeDefined();
    const banked=sim.state.economies.blue!.resources.wood,remaining=worker.cargo.amount;expect(remaining).toBeGreaterThan(0);expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:resource!.id,queued:false}).status).toBe('accepted');
    for(let tick=0;tick<60*balance.rules.simulationHz&&sim.state.economies.blue!.resources.wood===banked;tick++)sim.step();expect(sim.state.economies.blue!.resources.wood).toBeGreaterThanOrEqual(banked+remaining);
  },30000);
  it('protects next-age food while construction prerequisites remain unpaid',()=>{
    const view=observation();expect(missingAgeBuildings(view)).not.toEqual([]);expect(ageProgressionReserve(view).food).toBe(balance.ages.find(age=>age.id===3)!.cost.food);
  });
  it('reserves delayed farm reseed cost and continues a funded renewal despite age construction reserves',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.self.autoReseed=true;view.self.resources={food:0,wood:buildings.farm.reseedCost!.wood,gold:0,stone:0};view.entities=view.entities.filter(entity=>entity.id!=='forage');view.entities.push({...structure('empty_farm','farm',90000,90000),resource:'food',amount:0,farmState:'exhausted',farmerAssigned:false});
    caretakerCommands(view,memory,options);expect(queued(memory)).toContainEqual(expect.objectContaining({kind:'reseed_farm',farmId:'empty_farm'}));
    memory.pending=[{observedTick:view.tick,executeTick:view.tick+100,commands:[{kind:'reseed_farm',farmId:'other_farm',builderId:'worker_0'}]}];view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='reseed_farm')).toHaveLength(1);
  });
  it('builds local food infrastructure instead of treating remote disclosed forage as an infinite local supply',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.self.resources.food=400;const forage=view.entities.find(entity=>entity.id==='forage')!;forage.xMm=110000;forage.zMm=110000;
    caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory).filter(command=>command.kind==='build')).toEqual([expect.objectContaining({buildingType:'farm'})]);
  });
  it('preserves bounded construction recovery memory in cold saves and rejects future or oversized entries',()=>{
    const sim=simulation(),memory=sim.state.control.blue!.memory;memory.construction={old_site:{progress:0,lastProgressTick:sim.state.tick,builders:{},blockedSinceTick:sim.state.tick}};
    memory.constructionAvoid=[{typeId:'house',position:{xMm:20000,zMm:20000},rotation:0,untilTick:sim.state.tick+180*balance.rules.simulationHz}];
    const save=exportSimulationSave(sim,identity),restored=restoreSimulation(save,identity,{preserveEpoch:true});expect(restored.state.control.blue!.memory).toEqual(memory);
    const future=structuredClone(save.payload);future.state.control.blue!.memory.construction!.old_site!.blockedSinceTick=future.state.tick+1;expect(validateSimulationSavePayload(future)).toBe(false);
    const many=structuredClone(save.payload);many.state.control.blue!.memory.constructionAvoid=Array.from({length:9},()=>structuredClone(memory.constructionAvoid![0]!));expect(validateSimulationSavePayload(many)).toBe(false);
  });
});

describe('demand-ranked camp expansion',()=>{
  type Demand={id:string;resource:'wood'|'gold'|'stone';xMm:number;zMm:number;workers:number};
  const options:RulePolicyOptions={targetWorkers:0,allowMilitaryProduction:false,scoutAllowed:false};
  function prepared(demand:Demand[]){
    const view=observation();view.self.age=4;view.map.widthMm=400000;view.map.heightMm=400000;view.fog.visible=Array.from({length:40000},(_,index)=>index);view.fog.explored=[...view.fog.visible];
    const workers=view.entities.filter(entity=>entity.typeId==='villager');let next=0;
    for(const node of demand){view.entities.push({id:node.id,kind:'resource',typeId:node.resource==='wood'?'tree':`${node.resource}_deposit`,ownerId:null,xMm:node.xMm,zMm:node.zMm,hp:1,maxHp:1,resource:node.resource,amount:1000});for(let count=0;count<node.workers;count++)workers[next++]!.workTargetId=node.id;}
    return view;
  }
  function camps(view:PlayerView,extra:RulePolicyOptions={},memory=emptyCaretakerMemory()){
    caretakerCommands(view,memory,{...options,...extra});
    return memory.pending.flatMap(batch=>batch.commands).filter((command):command is Extract<GameplayCommand,{kind:'build'}>=>command.kind==='build'&&['lumber_camp','mining_camp'].includes(command.buildingType));
  }
  const near=(command:Extract<GameplayCommand,{kind:'build'}>,node:Position)=>Math.hypot(command.originCell.x*2000-node.xMm,command.originCell.z*2000-node.zMm)<16000;
  it('prioritizes worker travel burden over resource enumeration order',()=>{
    const wood:Demand={id:'first_wood',resource:'wood',xMm:140000,zMm:60000,workers:2},gold:Demand={id:'busy_gold',resource:'gold',xMm:220000,zMm:220000,workers:8},stone:Demand={id:'stone',resource:'stone',xMm:80000,zMm:260000,workers:4},view=prepared([wood,gold,stone]),before=structuredClone(view),commands=camps(view);
    expect(commands).toHaveLength(1);expect(commands[0]!.buildingType).toBe('mining_camp');expect(near(commands[0]!,gold)).toBe(true);expect(view).toEqual(before);
  });
  it('uses stable resource IDs to break equal travel-burden ties',()=>{
    const later:Demand={id:'z_gold',resource:'gold',xMm:200000,zMm:56000,workers:3},first:Demand={id:'a_stone',resource:'stone',xMm:44000,zMm:212000,workers:3},commands=camps(prepared([later,first]));
    expect(commands).toHaveLength(1);expect(near(commands[0]!,first)).toBe(true);
  });
  it('tries a third distinct deposit when earlier sites are reserved, clustering adjacent mining demand',()=>{
    const first:Demand={id:'first_gold',resource:'gold',xMm:280000,zMm:280000,workers:6},neighbor:Demand={...first,id:'nearby_gold',xMm:284000,workers:5},second:Demand={id:'second_gold',resource:'gold',xMm:280000,zMm:80000,workers:4},third:Demand={id:'third_stone',resource:'stone',xMm:80000,zMm:260000,workers:3};
    const avoidBuildingCells=[first,second].flatMap(node=>Array.from({length:729},(_,index)=>({x:node.xMm/2000-26+(index%27)*2,z:node.zMm/2000-26+Math.floor(index/27)*2}))),commands=camps(prepared([first,neighbor,second,third]),{avoidBuildingCells});
    expect(commands).toHaveLength(1);expect(near(commands[0]!,third)).toBe(true);
  });
  it('checks the actual camp type so a capped lumber economy may still buy its first mining camp',()=>{
    const node:Demand={id:'needed_gold',resource:'gold',xMm:220000,zMm:220000,workers:4},view=prepared([node]);view.entities=view.entities.filter(entity=>entity.typeId!=='mining_camp');
    for(let index=0;index<3;index++)view.entities.push(structure(`extra_lumber_${index}`,'lumber_camp',30000+index*12000,100000));
    expect(campExpansionAllowed(view,'lumber_camp')).toBe(false);expect(campExpansionAllowed(view,'mining_camp')).toBe(true);
    expect(camps(view)).toMatchObject([{buildingType:'mining_camp'}]);
  });
  it.each(['protected','hidden','depleted','age','foundation','held','pending_build'] as const)('retains the %s restriction on optional camp purchases',condition=>{
    const view=prepared([{id:'demand',resource:'gold',xMm:220000,zMm:220000,workers:4}]),node=view.entities.find(entity=>entity.id==='demand')!,memory=emptyCaretakerMemory(),extra:RulePolicyOptions={};
    if(condition==='protected')extra.protectedEntityIds=new Set(['worker_0','worker_1','worker_2','worker_3']);
    if(condition==='hidden')node.ghost=true;if(condition==='depleted')node.amount=0;if(condition==='age')view.self.age=2;
    if(condition==='foundation')view.entities.push({...structure('paid_farm','farm',90000,90000),progress:.2});
    if(condition==='held')extra.reservedWorkerIds=view.entities.filter(entity=>entity.typeId==='villager').map(entity=>entity.id);
    if(condition==='pending_build')memory.pending=[{observedTick:0,executeTick:100,commands:[{kind:'build',buildingType:'house',builderIds:['worker_5'],originCell:{x:40,z:40},rotation:0,queued:false}]}];
    expect(camps(view,extra,memory)).toEqual([]);
  });
});

describe('local building placement occupancy',()=>{
  it('uses explored ground without current sight and retains remembered static blockers',()=>{
    const view=observation(),anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)];view.entities=[];view.fog.visible=[];view.fog.explored=placementFog(view,[{x:20,z:20}]);
    expect(buildingCommand(view,'farm',anchor,workers)).toMatchObject({kind:'build',buildingType:'farm',originCell:{x:20,z:20}});
    for(const kind of ['building','resource'] as const){
      view.entities=[kind==='building'?{...structure('remembered','house',43000,43000),ownerId:'red',ghost:true}:{id:'remembered',kind:'resource',typeId:'tree',ownerId:null,xMm:43000,zMm:43000,hp:1,maxHp:1,resource:'wood',amount:250,ghost:true}];
      expect(buildingCommand(view,'farm',anchor,workers)).toBeUndefined();
    }
    view.entities=[];view.fog.explored=[];expect(buildingCommand(view,'farm',anchor,workers)).toBeUndefined();
  });
  it('spaces a proposed gate from ordinary houses while permitting connected defense pieces',()=>{
    const view=observation(),anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)];
    for(const type of ['house','palisade_wall'] as const){const existing=structure('neighbor',type,40000,40000);view.entities=[existing];const command=buildingCommand(view,'wooden_gate',anchor,workers);expect(command?.kind).toBe('build');if(command?.kind!=='build')throw new Error('MISSING_GATE_SITE');const [w,h]=buildings[type].footprintCells,[cw,ch]=buildings.wooden_gate.footprintCells,left=command.originCell.x*2000,top=command.originCell.z*2000,gap=Math.max(left-(existing.xMm+w*1000),existing.xMm-w*1000-(left+cw*2000),top-(existing.zMm+h*1000),existing.zMm-h*1000-(top+ch*2000));expect(gap).toBeGreaterThanOrEqual(0);if(type==='house')expect(gap).toBeGreaterThanOrEqual(aiBuildingClearanceMm);else expect(gap).toBeLessThan(aiBuildingClearanceMm);}
  });
  it.each(['town_center','house','barracks','market','farm','wooden_gate'] as const)('leaves two clear build-grid cells beside an existing %s and a delayed foundation',type=>{
    const view=observation();view.self.age=4;const anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)],existing={...structure('neighbor',type,40000,40000),rotation:90 as const};view.entities=[existing];
    const first=buildingCommand(view,'market',anchor,workers);expect(first?.kind).toBe('build');if(first?.kind!=='build')throw new Error('MISSING_SPACED_SITE');
    const check=(command:Extract<GameplayCommand,{kind:'build'}>,neighbor:ViewEntity)=>{let [w,h]=buildings[neighbor.typeId].footprintCells;if(neighbor.rotation===90||neighbor.rotation===270)[w,h]=[h,w];const [cw,ch]=buildings[command.buildingType].footprintCells,grid=balance.rules.buildingGridM*1000,left=command.originCell.x*grid,top=command.originCell.z*grid,gap=Math.max(left-(neighbor.xMm+w*grid/2),neighbor.xMm-w*grid/2-(left+cw*grid),top-(neighbor.zMm+h*grid/2),neighbor.zMm-h*grid/2-(top+ch*grid));expect(gap).toBeGreaterThanOrEqual(aiBuildingClearanceMm);};
    check(first,existing);
    const second=buildingCommand(view,'blacksmith',anchor,workers,0,[],[first]);expect(second?.kind).toBe('build');if(second?.kind!=='build')throw new Error('MISSING_SECOND_SITE');check(second,existing);
    const [w,h]=buildings[first.buildingType].footprintCells;check(second,{...structure('pending','market',(first.originCell.x+w/2)*2000,(first.originCell.z+h/2)*2000),progress:0});
  });
  it('keeps narrow invisible alternatives unavailable instead of consuming the only reserved approach',()=>{
    const view=observation(),anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)];view.entities=[];view.fog.visible=[];
    view.fog.visible=placementFog(view,[{x:20,z:20}]);view.fog.explored=[...view.fog.visible];
    expect(buildingCommand(view,'farm',anchor,workers)).toMatchObject({originCell:{x:20,z:20}});
    expect(buildingCommand(view,'farm',anchor,workers,0,[{x:20,z:20}])).toBeUndefined();
    const laterLayout=[...Array.from({length:fortifyPlacementCellLimit},()=>({x:0,z:0})),{x:20,z:20}];
    expect(buildingCommand(view,'farm',anchor,workers,0,laterLayout)).toBeUndefined();
  });
  it('wraps retries through a small visible set without reusing a reserved approach',()=>{
    const view=observation(),anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)],sites=[{x:20,z:20},{x:32,z:20}];view.entities=[];view.fog.visible=placementFog(view,sites);view.fog.explored=[...view.fog.visible];
    for(const [attempt,index]of [[0,0],[1,1],[2,0],[3,1],[31,1]] as const)expect(buildingCommand(view,'farm',anchor,workers,attempt)).toMatchObject({originCell:sites[index]});
    expect(buildingCommand(view,'farm',anchor,workers,31,[sites[0]!])).toMatchObject({originCell:sites[1]});
    expect(buildingCommand(view,'farm',anchor,workers,31,sites)).toBeUndefined();
  });
  // Independent scalar implementation with the same street-clearance policy.
  // Full occupant scans detect broad-phase omissions and candidate reranking.
  function scalar(view:PlayerView,typeId:BuildingId,anchor:Position,workers:ViewEntity[],candidateIndex=0,avoidBuildingCells:readonly Cell[]=[]):GameplayCommand|undefined {
    const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
    if(!workers.length||buildings[typeId].minAge>view.self.age)return;
    if(!buildings[typeId].wallEquivalentCells&&view.entities.filter(entity=>entity.ownerId===view.playerId&&entity.kind==='building'&&!buildings[entity.typeId].wallEquivalentCells).length>=balance.rules.maxNonWallBuildingsPerPlayer)return;
    const definition=buildings[typeId],grid=balance.rules.buildingGridM*1000,[width,depth]=definition.footprintCells,explored=new Set(view.fog.explored),fogWidth=view.map.widthMm/view.map.fogCellMm;
    const candidates:Position[]=[],outer:Position[]=[];
    for(let z=-10;z<=10;z+=2)for(let x=-10;x<=10;x+=2)candidates.push({xMm:(Math.floor(anchor.xMm/grid)+x)*grid,zMm:(Math.floor(anchor.zMm/grid)+z)*grid});
    candidates.sort((a,b)=>distance(a,anchor)-distance(b,anchor));
    for(let z=-24;z<=24;z+=2)for(let x=-24;x<=24;x+=2)if(Math.abs(x)>10||Math.abs(z)>10)outer.push({xMm:(Math.floor(anchor.xMm/grid)+x)*grid,zMm:(Math.floor(anchor.zMm/grid)+z)*grid});
    outer.sort((a,b)=>distance(a,anchor)-distance(b,anchor));candidates.push(...outer);
    const avoid=avoidBuildingCells.slice(0,fortifyPlacementCellLimit*balance.ai.maxGoals),offset=candidateIndex%32;
    const proposal=(point:Position|undefined):GameplayCommand|undefined=>{if(!point)return;const worker=[...workers].sort((a,b)=>distance(a,point)-distance(b,point))[0]!;return {kind:'build',buildingType:typeId as Extract<GameplayCommand,{kind:'build'}>['buildingType'],builderIds:[worker.id],originCell:{x:point.xMm/grid,z:point.zMm/grid},rotation:0,queued:false};};
    const legalSites:Position[]=[];
    for(const point of candidates){
      const right=point.xMm+width*grid,bottom=point.zMm+depth*grid;if(point.xMm<0||point.zMm<0||right>view.map.widthMm||bottom>view.map.heightMm)continue;
      if(!terrainBuildable(view.map.terrain??[],{...point,widthMm:width*grid,depthMm:depth*grid}))continue;
      if(!placementAreaDiscovered({...point,widthMm:width*grid,depthMm:depth*grid},view.map.widthMm,view.map.heightMm,view.map.fogCellMm,Math.max(balance.rules.treeBuildingClearanceM*1000,aiBuildingClearanceMm),(x,z)=>explored.has(Math.floor(z/view.map.fogCellMm)*fogWidth+Math.floor(x/view.map.fogCellMm)),view.map.terrain??[]))continue;
      if(view.entities.some(entity=>{if(entity.ghost&&entity.kind==='unit'||entity.kind==='resource'&&(entity.amount??0)===0||entity.garrisonedIn)return false;if(entity.kind==='unit'){const radius=units[entity.typeId].collisionRadiusM*1000,dx=Math.max(point.xMm-entity.xMm,0,entity.xMm-right),dz=Math.max(point.zMm-entity.zMm,0,entity.zMm-bottom);return dx*dx+dz*dz<radius*radius;}const size=entity.kind==='building'?buildings[entity.typeId].footprintCells:[1,1],rotated=entity.rotation===90||entity.rotation===270,gap=entity.kind==='building'&&buildings[typeId].wallEquivalentCells&&buildings[entity.typeId].wallEquivalentCells?0:aiBuildingClearanceMm,resourceHalf=entity.resource==='wood'?Math.max(balance.rules.treeBuildingClearanceM*1000,(entity.forest?.cellMm??0)/2):balance.rules.nonTreeBuildingClearanceM*1000,bounds=entity.kind==='resource'?{halfWidth:resourceHalf,halfHeight:resourceHalf}:{halfWidth:(rotated?size[1]!:size[0]!)*grid/2+gap,halfHeight:(rotated?size[0]!:size[1]!)*grid/2+gap};return entity.xMm+bounds.halfWidth>point.xMm&&entity.xMm-bounds.halfWidth<right&&entity.zMm+bounds.halfHeight>point.zMm&&entity.zMm-bounds.halfHeight<bottom;}))continue;
      const street=definition.wallEquivalentCells?0:aiBuildingClearanceMm;
      if(avoid.some(cell=>cell.x*grid>=point.xMm-street&&cell.x*grid<right+street&&cell.z*grid>=point.zMm-street&&cell.z*grid<bottom+street))continue;
      legalSites.push(point);if(legalSites.length<=offset)continue;return proposal(point);
    }
    return proposal(legalSites.length?legalSites[offset%legalSites.length]:undefined);
  }
  function freeze(value:unknown):void {if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
  it('matches scalar site and worker choices across mixed footprints, visibility, aliases and contour preferences without mutation',()=>{
    let randomState=83;const random=(limit:number)=>{randomState=(Math.imul(randomState,1664525)+1013904223)>>>0;return randomState%limit;};
    for(let scenario=0;scenario<8;scenario++){
      const view=observation();view.self.age=4;
      for(let index=0;index<180;index++){
        const xMm=2000+random(116000),zMm=2000+random(116000),mode=index%6;
        const entity:ViewEntity=mode===0?{...structure(`site_${index}`,index%2?'wooden_gate':'market',xMm,zMm),rotation:([0,90,180,270] as const)[index%4]!}:mode===1?unit(`body_${index}`,(['villager','scout','trebuchet'] as const)[index%3]!,index%2?'red':'blue',xMm,zMm):{id:`deposit_${index}`,kind:'resource',typeId:mode===2?'tree':'gold_deposit',ownerId:null,xMm,zMm,hp:1,maxHp:1,resource:mode===2?'wood':'gold',amount:mode===4?0:100,...(mode===2?{forest:{patchId:'known',cellMm:balance.maps.forestNavigationCellM*1000}}:{})};
        if(index%13===0)entity.ghost=true;if(index%19===0&&entity.kind==='unit')entity.garrisonedIn='home';view.entities.push(entity);
      }
      view.entities.push(view.entities[2]!,{...view.entities[2]!,xMm:100000});
      if(scenario%2)view.fog.visible=view.fog.visible.filter(cell=>cell%60<47&&Math.floor(cell/60)<52);
      view.map.terrain=[{id:'ridge',kind:'ridge',xMm:70000,zMm:20000,widthMm:8000,depthMm:50000,elevationMm:18000}];
      const anchor={xMm:scenario%3?40000:4000,zMm:scenario%3?40000:4000},workers=[unit('first_tie','villager','blue',18000,20000),unit('second_tie','villager','blue',18000,20000)],avoid=Array.from({length:30},(_,index)=>({x:14+index%10,z:16+Math.floor(index/10)})),before=JSON.stringify(view);freeze(view);freeze(workers);freeze(avoid);
      for(const type of ['farm','market','wooden_gate'] as const)for(const attempt of [0,3,31,33])for(const reserved of [[],avoid])expect(buildingCommand(view,type,anchor,workers,attempt,reserved)).toEqual(scalar(view,type,anchor,workers,attempt,reserved));
      expect(JSON.stringify(view)).toBe(before);
    }
  });
  it('preserves exact tangency for units, rotated buildings and every resource edge, reopening depleted sites',()=>{
    const anchor={xMm:40000,zMm:40000},workers=[unit('builder','villager','blue',10000,10000)],grid=balance.rules.buildingGridM*1000,[width,depth]=buildings.farm.footprintCells,right=anchor.xMm+width*grid,centerZ=anchor.zMm+depth*grid/2;
    const occupants=[...(['villager','scout','trebuchet'] as const).map(type=>unit(type,type,'red',right+units[type].collisionRadiusM*1000,centerZ)),{...structure('gate','wooden_gate',right+1000+aiBuildingClearanceMm,centerZ),rotation:90 as const},...(['wood','food','gold','stone'] as const).map(resource=>({id:resource,kind:'resource' as const,typeId:resource==='wood'?'tree':'stone_deposit',ownerId:null,xMm:right+(resource==='wood'?Math.max(balance.maps.forestNavigationCellM*500,balance.rules.treeBuildingClearanceM*1000):balance.rules.nonTreeBuildingClearanceM*1000),zMm:centerZ,hp:1,maxHp:1,resource,amount:100,...(resource==='wood'?{forest:{patchId:'edge',cellMm:balance.maps.forestNavigationCellM*1000}}:{})}))];
    for(const occupant of occupants){const view=observation();view.entities=[occupant];view.fog.visible=placementFog(view,[{x:20,z:20}],width,depth);view.fog.explored=[...view.fog.visible];
      expect(buildingCommand(view,'farm',anchor,workers)).toEqual(scalar(view,'farm',anchor,workers));expect(buildingCommand(view,'farm',anchor,workers)).toMatchObject({kind:'build',originCell:{x:20,z:20}});
      occupant.xMm--;expect(buildingCommand(view,'farm',anchor,workers)).toEqual(scalar(view,'farm',anchor,workers));expect(buildingCommand(view,'farm',anchor,workers)).toBeUndefined();
      if(occupant.kind==='resource'){occupant.amount=0;expect(buildingCommand(view,'farm',anchor,workers)).toEqual(scalar(view,'farm',anchor,workers));expect(buildingCommand(view,'farm',anchor,workers)).toMatchObject({kind:'build',originCell:{x:20,z:20}});}
    }
  });
  it('reads dense resource geometry once instead of once per rejected candidate',()=>{
    const view=observation(),anchor={xMm:60000,zMm:60000},workers=[unit('builder','villager','blue',60000,60000)];view.entities=[];
    const add=(id:string,xMm:number,zMm:number)=>view.entities.push({id,kind:'resource',typeId:'tree',ownerId:null,xMm,zMm,hp:1,maxHp:1,resource:'wood',amount:100,forest:{patchId:'dense',cellMm:balance.maps.forestNavigationCellM*1000}});
    for(let index=0;index<2400;index++)add(`distant_${index}`,116000+index%3,116000+index%5);
    for(let z=12000;z<=108000;z+=4000)for(let x=12000;x<=108000;x+=4000)add(`forest_${x}_${z}`,x,z);
    let reads=0;for(const entity of view.entities){const x=entity.xMm;Object.defineProperty(entity,'xMm',{enumerable:true,get(){reads++;return x;}});}
    const expected=scalar(view,'farm',anchor,workers),scalarReads=reads;reads=0;const actual=buildingCommand(view,'farm',anchor,workers),indexedReads=reads;
    expect(actual).toEqual(expected);expect(actual).toBeUndefined();expect(scalarReads).toBeGreaterThan(view.entities.length*100);expect(indexedReads).toBe(view.entities.length);expect(indexedReads*100).toBeLessThan(scalarReads);
  });
});

describe('caretaker economic fallback boundary',()=>{
  it.each(['easy','medium','hard'] as const)('retains complete %s command and memory ordering when discarded fallback branches are skipped',difficulty=>{
    const original=fallbackCommands,policy=balance.ai.difficulty[difficulty],cadence=policy.tacticalIntervalSeconds*balance.rules.simulationHz,delay=Math.ceil(policy.reactionDelaySeconds*balance.rules.simulationHz);
    let discardedTrain=0,discardedAttack=0;
    for(const scenario of ['ordinary','farm-reservations','scout-housing'] as const){
      const source=observation(),actual=emptyCaretakerMemory(),expected=emptyCaretakerMemory(),options:RulePolicyOptions={difficulty,allowStrategic:false,allowMilitaryProduction:true,targetWorkers:24,scoutAllowed:true};
      source.entities.push(unit('visible_threat','knight','red',54000,54000));
      if(scenario==='farm-reservations'){
        source.entities=source.entities.filter(entity=>entity.id!=='forage');for(const worker of source.entities.filter(entity=>entity.typeId==='villager'))worker.order='idle';
        const farm={...structure('reserved_farm','farm',35000,80000),resource:'food' as const,amount:500,farmerAssigned:false};source.entities.push(farm,farm,{...farm,id:'other_farm',xMm:43000});
        for(const state of [actual,expected])state.pending=[{observedTick:0,executeTick:cadence,commands:[{kind:'gather',unitIds:['worker_0'],targetId:farm.id,queued:false}]},{observedTick:0,executeTick:cadence+100,commands:[{kind:'train',buildingId:'home',unitType:'villager',quantity:1},{kind:'reseed_farm',builderId:'worker_1',farmId:'other_farm'}]}];
      }
      if(scenario==='scout-housing'){source.entities.push({...unit('scout','scout','blue',80000,80000),taskState:'blocked'});source.self.population=source.self.populationCap-1;}
      const before=structuredClone(source);
      for(const tick of [cadence,cadence+delay,2*cadence+delay,3*cadence+2*delay]){
        const current={...source,tick},actualCommands=caretakerCommands(current,actual,options);
        // Reproduce the previous caller contract: generate the full fallback
        // proposal list and let caretaker's unchanged filter discard branches.
        const spy=vi.spyOn(fallbackPolicy,'fallbackCommands').mockImplementation((view,state,configured)=>{
          const {economyOnly:_economyOnly,...priorOptions}=configured??{},commands=original(view,state,priorOptions);
          discardedTrain+=commands.filter(command=>command.kind==='train').length;discardedAttack+=commands.filter(command=>command.kind==='attack_target').length;return commands;
        });
        try{expect(actualCommands).toEqual(caretakerCommands(current,expected,options));expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));expect(source).toEqual(before);}
        finally{spy.mockRestore();}
      }
    }
    expect(discardedTrain).toBeGreaterThan(0);expect(discardedAttack).toBeGreaterThan(0);
  });
});

describe('caretaker observation ownership',()=>{
  function objectGraph(value:unknown,seen=new Set<object>()):Set<object>{if(value===null||typeof value!=='object'||seen.has(value))return seen;seen.add(value);for(const nested of Object.values(value))objectGraph(nested,seen);return seen;}
  function freezeGraph<T>(value:T):T{for(const object of objectGraph(value))Object.freeze(object);return value;}
  function legacyObservation(view:PlayerView,commands:GameplayCommand[],options:RulePolicyOptions):PlayerView{
    // Independent eager-copy reference for the observation the previous policy
    // supplied to fallback. This deliberately retains its assignment behavior.
    const result=structuredClone(view),selected=(command:GameplayCommand):string[]=>'unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:'builderId'in command?[command.builderId]:[];
    result.players.find(player=>player.id===view.playerId)!.difficulty=options.difficulty??'medium';
    const locked=new Set([...commands.flatMap(selected),...(options.reservedWorkerIds??[])]);
    for(const entity of result.entities)if(entity.ownerId===view.playerId&&locked.has(entity.id)){const command=commands.find(command=>selected(command).includes(entity.id));if(command)entity.order=command.kind==='gather'?'gather':command.kind==='build'||command.kind==='continue_build'?'build':command.kind==='reseed_farm'?'reseed':'move';}
    for(const command of commands)if(command.kind==='gather'||command.kind==='reseed_farm'){const farmId=command.kind==='gather'?command.targetId:command.farmId,farm=result.entities.find(entity=>entity.id===farmId&&entity.typeId==='farm');if(farm)farm.farmerAssigned=true;}
    return result;
  }
  it.each(['easy','medium','hard'] as const)('matches the eager-copy %s reservation observation with aliased records and frozen nested inputs',difficulty=>{
    const view=observation(),memory=emptyCaretakerMemory(),worker=view.entities.find(entity=>entity.id==='worker_0')!,farm={...structure('reserved_farm','farm',82000,85000),resource:'food' as const,amount:500,farmerAssigned:false},foreign={...farm,id:'foreign_farm',ownerId:'red',ghost:true};
    view.tick=balance.ai.difficulty[difficulty].tacticalIntervalSeconds*balance.rules.simulationHz;view.players[0]!.difficulty='hard';view.players.push(view.players[0]!);worker.order='idle';worker.cargo={resource:'wood',amount:2};view.entities.push(worker,farm,farm,{...farm},foreign,unit('foreign_worker','villager','red'));
    const due:GameplayCommand[]=[{kind:'gather',unitIds:['worker_0'],targetId:farm.id,queued:false},{kind:'move',unitIds:['foreign_worker'],target:{xMm:90000,zMm:90000},queued:false}],pending:GameplayCommand[]=[{kind:'continue_build',builderIds:['worker_1'],foundationId:'foundation',queued:false},{kind:'reseed_farm',builderId:'worker_2',farmId:farm.id},{kind:'gather',unitIds:['worker_3'],targetId:foreign.id,queued:false},{kind:'build',builderIds:['worker_4'],buildingType:'house',originCell:{x:40,z:40},rotation:0,queued:false},{kind:'move',unitIds:['worker_0','worker_5'],target:{xMm:90000,zMm:90000},queued:false}];
    memory.pending=[{observedTick:0,executeTick:view.tick+100,commands:pending},{observedTick:0,executeTick:view.tick,commands:due}];
    const options:RulePolicyOptions={difficulty,allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false,reservedWorkerIds:['worker_6'],avoidBuildingCells:[{x:40,z:40}]},before=structuredClone(view),expected=legacyObservation(view,[...due,...pending],options),originalFallback=fallbackCommands;
    freezeGraph(view);freezeGraph(options);let observed:PlayerView|undefined;
    const spy=vi.spyOn(fallbackPolicy,'fallbackCommands').mockImplementation((observation,state,configured)=>{observed=observation;expect(observation).toEqual(expected);return originalFallback(observation,state,configured);});
    try{
      const returned=caretakerCommands(view,memory,options);expect(returned).toEqual(due);expect(returned[0]).toBe(due[0]);expect(returned[1]).toBe(due[1]);expect(spy).toHaveBeenCalledTimes(1);expect(view).toEqual(before);
      const copies=observed!.entities.filter(entity=>entity.id===farm.id);expect(copies).toHaveLength(3);expect(copies[0]).toBe(copies[1]);expect(copies[0]).not.toBe(copies[2]);expect(copies[2]!.farmerAssigned).toBe(false);
      const workers=observed!.entities.filter(entity=>entity.id===worker.id);expect(workers[0]).toBe(workers[1]);expect(workers[0]!.order).toBe('gather');expect(observed!.players[0]).toBe(observed!.players.at(-1));expect(observed!.entities.find(entity=>entity.id==='foreign_worker')!.order).toBe('idle');expect(observed!.entities.find(entity=>entity.id==='worker_6')!.order).toBe('gather');expect(observed!.entities.find(entity=>entity.id===foreign.id)!.farmerAssigned).toBe(true);
    }finally{spy.mockRestore();}
  });
  it.each(['retreat','scout','expansion','farm'] as const)('keeps fresh %s commands and commander memory detached from source and option objects',scenario=>{
    const view=observation(),memory=emptyCaretakerMemory(),options:RulePolicyOptions={targetWorkers:0,allowMilitaryProduction:false,allowStrategic:scenario==='expansion',scoutAllowed:scenario==='scout',avoidBuildingCells:[{x:18,z:18}]};
    if(scenario==='retreat'){for(const entity of view.entities)if(entity.id.startsWith('soldier'))entity.hp=10;view.entities.push(unit('danger','knight','red',68000,60000));}
    if(scenario==='scout'){view.entities.push(unit('scout','scout','blue',80000,80000));view.fog.explored=view.fog.explored.filter(cell=>cell%60<48);view.fog.visible=[...view.fog.explored];}
    if(scenario==='expansion')view.entities.push({id:'remote_gold',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:94000,zMm:90000,hp:1,maxHp:1,resource:'gold',amount:1500});
    if(scenario==='farm')view.entities=view.entities.filter(entity=>['home','barracks','worker_0'].includes(entity.id));
    const before=structuredClone(view),optionBefore=structuredClone(options),inputObjects=objectGraph(options,objectGraph(view));freezeGraph(view);freezeGraph(options);
    expect(caretakerCommands(view,memory,options)).toEqual([]);const planned=memory.pending.flatMap(batch=>batch.commands),positionCommand=planned.find(command=>scenario==='retreat'||scenario==='scout'?command.kind==='move':command.kind==='build');
    expect(positionCommand,scenario).toBeDefined();for(const object of objectGraph(memory))expect(inputObjects.has(object)).toBe(false);
    const savedCommands=structuredClone(planned),dueTick=memory.pending[0]!.executeTick,returned=caretakerCommands({...view,tick:dueTick},memory,options);expect(returned).toEqual(savedCommands);for(const object of objectGraph(returned))expect(inputObjects.has(object)).toBe(false);
    for(const command of returned){if(command.kind==='move'){command.target.xMm=-1;command.unitIds.push('changed');}if(command.kind==='build'){command.originCell.x=-1;command.builderIds.push('changed');}}
    expect(view).toEqual(before);expect(options).toEqual(optionBefore);
  });
  it('keeps direct building proposals detached from caller-owned anchor, workers, and avoid cells',()=>{
    const view=observation(),home=view.entities.find(entity=>entity.id==='home')!,workers=view.entities.filter(entity=>entity.typeId==='villager'),avoid=[{x:18,z:18}],before=structuredClone(view),inputObjects=objectGraph(avoid,objectGraph(workers,objectGraph(view)));
    freezeGraph(view);freezeGraph(workers);freezeGraph(avoid);const command=buildingCommand(view,'farm',home,workers,0,avoid);expect(command?.kind).toBe('build');if(command?.kind!=='build')throw new Error('Missing visible farm site');
    for(const object of objectGraph(command))expect(inputObjects.has(object)).toBe(false);command.originCell.x=-1;command.builderIds.push('changed');expect(view).toEqual(before);expect(avoid).toEqual([{x:18,z:18}]);
  });
  it('preserves due-command identity when no tactical evaluation or completed home is available',()=>{
    for(const withoutHome of [false,true]){const view=observation(),memory=emptyCaretakerMemory(),command:GameplayCommand={kind:'move',unitIds:['worker_0'],target:{xMm:80000,zMm:80000},queued:false};if(withoutHome)view.entities=view.entities.filter(entity=>entity.id!=='home');else view.tick=9;memory.pending=[{observedTick:0,executeTick:view.tick,commands:[command]}];const before=structuredClone(view);freezeGraph(view);const returned=caretakerCommands(view,memory);expect(returned).toEqual([command]);expect(returned[0]).toBe(command);
      if(withoutHome){expect(memory.pending).toHaveLength(1);const batch=memory.pending[0]!;expect(batch.executeTick).toBe(view.tick+Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz));expect(batch.commands).toEqual([expect.objectContaining({kind:'build',buildingType:'town_center'})]);const build=batch.commands[0]!;if(build.kind!=='build')throw new Error('NO_HOME_RECOVERY');expect(build.builderIds).not.toContain('worker_0');}else expect(memory.pending).toEqual([]);expect(view).toEqual(before);}
  });
});

describe('AI missing-scout replacement',()=>{
  const options={maintainScout:true,allowStrategic:false,allowMilitaryProduction:false,targetWorkers:20,scoutAllowed:false};
  const scouts=(commands:GameplayCommand[])=>commands.filter(command=>command.kind==='train'&&command.unitType==='scout');
  const queued=(memory:ReturnType<typeof emptyCaretakerMemory>)=>memory.pending.flatMap(batch=>batch.commands);
  function missing(){const view=observation();view.players[0]!.kind='ai';view.self.resources={food:units.scout.cost.food,wood:0,gold:0,stone:0};view.self.autoReseed=true;return {view,memory:emptyCaretakerMemory(),home:view.entities.find(entity=>entity.id==='home')!};}
  it.each(['easy','medium','hard'] as const)('queues one affordable %s scout in every age at the ordinary reaction delay',difficulty=>{
    for(const age of [1,2,3,4] as const){const {view,memory}=missing(),policy=balance.ai.difficulty[difficulty],cadence=policy.tacticalIntervalSeconds*balance.rules.simulationHz,delay=Math.ceil(policy.reactionDelaySeconds*balance.rules.simulationHz);view.self.age=age;view.tick=cadence;
      const before=structuredClone(view);expect(caretakerCommands(view,memory,{...options,difficulty})).toEqual([]);expect(scouts(queued(memory)),`age ${age}`).toEqual([{kind:'train',buildingId:'home',unitType:'scout',quantity:1}]);expect(memory.pending.find(batch=>scouts(batch.commands).length)?.executeTick).toBe(cadence+delay);expect(view).toEqual(before);
      view.tick=cadence+delay-1;expect(caretakerCommands(view,memory,{...options,difficulty})).toEqual([]);expect(scouts(queued(memory))).toHaveLength(1);
      view.tick=cadence+delay;expect(scouts(caretakerCommands(view,memory,{...options,difficulty}))).toHaveLength(1);expect(scouts(queued(memory))).toHaveLength(0);
    }
  });
  it.each(['human_default','human_optin','ai_optout','live','garrisoned','paid_scout','foundation','busy_producer','food','population','reserved_population'] as const)('refuses missing-scout replacement for %s',condition=>{
    const {view,memory,home}=missing();let configured={...options};
    if(condition.startsWith('human')){view.players[0]!.kind='human';configured.maintainScout=condition==='human_optin';}else if(condition==='ai_optout')configured.maintainScout=false;
    else if(condition==='live'||condition==='garrisoned')view.entities.push({...unit('existing_scout','scout'),...(condition==='garrisoned'?{garrisonedIn:home.id}:{})});
    else if(condition==='foundation')home.progress=.9;
    else if(condition==='busy_producer'||condition==='paid_scout'){home.queue=[{id:'paid_job',kind:'train',typeId:condition==='paid_scout'?'scout':'villager',progress:.5,state:'active'}];view.self.reservedPopulation=1;}
    else if(condition==='food')view.self.resources.food=units.scout.cost.food-1;
    else if(condition==='population')view.self.populationCap=view.self.population;
    else if(condition==='reserved_population'){view.self.populationCap=view.self.population+1;view.self.reservedPopulation=1;}
    caretakerCommands(view,memory,configured);expect(scouts(queued(memory))).toEqual([]);
  });
  it.each([false,true])('honors pending and due producer/scout reservations without duplicate unpaid training (due=%s)',due=>{
    for(const command of [{kind:'train',buildingId:'home',unitType:'villager',quantity:1},{kind:'advance_age',townCenterId:'home',targetAge:4},{kind:'train',buildingId:'second_home',unitType:'scout',quantity:1}] as GameplayCommand[]){
      const {view,memory}=missing();view.entities.push(structure('second_home','town_center',85000,85000));view.self.age=3;view.self.resources={food:5000,wood:0,gold:5000,stone:0};
      // Reserve both producers when exercising a home reservation. A Scout
      // already queued elsewhere must suppress replacement globally by itself.
      const prior:GameplayCommand[]=command.kind==='train'&&command.unitType==='scout'?[command]:[command,{kind:'train',buildingId:'second_home',unitType:'villager',quantity:1}];
      memory.pending=[{observedTick:0,executeTick:due?view.tick:view.tick+100,commands:prior}];const returned=caretakerCommands(view,memory,options);
      expect(returned).toEqual(due?prior:[]);expect(scouts(queued(memory))).toEqual(due?[]:scouts(prior));
    }
  });
  it.each([false,true])('counts full pending/due train quantities against spare population and bank (due=%s)',due=>{
    for(const spare of [3,4]){const {view,memory}=missing();view.self.populationCap=view.self.population+spare;view.self.resources={food:1000,wood:0,gold:1000,stone:0};memory.pending=[{observedTick:0,executeTick:due?view.tick:view.tick+100,commands:[{kind:'train',buildingId:'barracks',unitType:'militia',quantity:3}]}];caretakerCommands(view,memory,options);expect(scouts(queued(memory))).toHaveLength(spare===4?1:0);}
    const {view,memory}=missing();view.self.resources.gold=units.militia.cost.gold;memory.pending=[{observedTick:0,executeTick:due?view.tick:view.tick+100,commands:[{kind:'train',buildingId:'barracks',unitType:'militia',quantity:1}]}];caretakerCommands(view,memory,options);expect(scouts(queued(memory))).toHaveLength(0);
  });
  it('counts paid reserved population once and yields to same-call worker and military production',()=>{
    const paid=missing();paid.home.queue=[];paid.view.entities.find(entity=>entity.id==='barracks')!.queue=[{id:'paid_military',kind:'train',typeId:'militia',progress:.5,state:'active'}];paid.view.self.reservedPopulation=1;paid.view.self.populationCap=paid.view.self.population+2;caretakerCommands(paid.view,paid.memory,options);expect(scouts(queued(paid.memory))).toHaveLength(1);
    const worker=missing();caretakerCommands(worker.view,worker.memory,{...options,targetWorkers:21});expect(queued(worker.memory).filter(command=>command.kind==='train')).toEqual([{kind:'train',buildingId:'home',unitType:'villager',quantity:1}]);
    for(const spare of [1,2]){const military=missing();military.view.self.resources={food:1000,wood:0,gold:1000,stone:0};military.view.self.populationCap=military.view.self.population+spare;caretakerCommands(military.view,military.memory,{...options,allowMilitaryProduction:true,desiredUnitType:'militia',armyTarget:4});expect(queued(military.memory)).toContainEqual({kind:'train',buildingId:'barracks',unitType:'militia',quantity:1});expect(scouts(queued(military.memory))).toHaveLength(spare===2?1:0);}
  });
  it('leaves a same-call affordable age ahead of exploration even with spare scout food',()=>{
    const {view,memory}=missing(),age=balance.ages.find(age=>age.id===2)!;view.self.age=1;view.self.resources={...age.cost,food:age.cost.food+units.scout.cost.food};view.self.technologies=balance.technologies.map(technology=>technology.id);
    caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory)).toContainEqual({kind:'advance_age',townCenterId:'home',targetAge:2});expect(scouts(queued(memory))).toEqual([]);
  });
});

describe('M5 observed Medium caretaker policy',()=>{
  it.each([false,true])('reserves a pending or due continuation before choosing another orphan builder (due=%s)',due=>{
    const view=observation(),memory=emptyCaretakerMemory(),command:GameplayCommand={kind:'continue_build',builderIds:['worker_0'],foundationId:'paid_farm',queued:false};
    view.players[0]!.kind='ai';view.players[0]!.difficulty='hard';view.entities.push({...structure('paid_farm','farm',50000,75000),progress:.3325});
    view.tick=10;memory.pending=[{observedTick:5,executeTick:due?10:15,commands:[command]}];
    const commands=caretakerCommands(view,memory,{difficulty:'hard',allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false});
    expect(commands.filter(command=>command.kind==='continue_build')).toEqual(due?[command]:[]);expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='continue_build')).toEqual(due?[]:[command]);
  });
  it.each([false,true])('reserves a pending or due helper without assigning a third builder (due=%s)',due=>{
    const view=observation(),memory=emptyCaretakerMemory(),command:GameplayCommand={kind:'continue_build',builderIds:['worker_0'],foundationId:'paid_farm',queued:false};
    view.players[0]!.kind='ai';view.players[0]!.difficulty='hard';view.entities.push({...structure('paid_farm','farm',50000,75000),progress:.25});const original=view.entities.find(entity=>entity.id==='worker_1')!;original.order='build';original.taskState='blocked';original.blockedReason='PATH_BLOCKED';view.entities.find(entity=>entity.id==='worker_0')!.order='idle';view.entities.find(entity=>entity.id==='worker_2')!.order='idle';
    memory.pending=[{observedTick:5,executeTick:due?view.tick:view.tick+100,commands:[command]}];const before=structuredClone(view),commands=caretakerCommands(view,memory,{difficulty:'hard',allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false});
    expect(commands.filter(command=>command.kind==='continue_build')).toEqual(due?[command]:[]);expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='continue_build')).toEqual(due?[]:[command]);expect(view).toEqual(before);
  });
  it.each(['ai','caretaker'] as const)('completes a paid farm with one %s helper while its original builder remains physically blocked',controller=>{
    const sim=createSimulation({matchId:'blocked_farm',seed:'caretaker-blocked-farm',controllers:false,caretakerEnabled:true,sharedVision:false,factions:[{id:'blue',name:'Blue',teamId:'blue',kind:controller==='ai'?'ai':'human',difficulty:'medium',personality:'builder',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]}),native=Object.values(sim.state.entities),home=native.find((entity):entity is Building=>entity.ownerId==='blue'&&entity.typeId==='town_center')!,enemy=native.find(entity=>entity.ownerId==='red'&&entity.typeId==='town_center')!,template=native.find((entity):entity is Unit=>entity.ownerId==='blue'&&entity.typeId==='villager')!;
    home.xMm=80000;home.zMm=80000;const unit=(id:string,typeId:UnitId,xMm:number,zMm:number):Unit=>({...structuredClone(template),id,typeId,xMm,zMm,hp:units[typeId].maxHp,maxHp:units[typeId].maxHp,orders:[],path:[],stance:'stand_ground'});
    const original=unit('blocked_builder','villager',85000,100000),helpers=[unit('helper_a','villager',90000,110000),unit('helper_b','villager',100000,110000)],scout=unit('watching_scout','scout',98000,112000),ring=[[85700,100000],[84300,100000],[85000,100700],[85000,99300]].map(([x,z],index)=>unit(`stationary_${index}`,'spearman',x!,z!));
    // Explicit stationary unit geometry blocks the worker, while the paid site
    // has normal static access. After purchase, no unit is moved, work added,
    // or bank changed by the fixture.
    sim.state.entities=Object.fromEntries([home,enemy,original,...helpers,scout,...ring].map(entity=>[entity.id,entity]));sim.state.map.terrain=[];sim.state.navigationRevision++;for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}sim.step();
    expect(send(sim,{kind:'stop',unitIds:ring.map(unit=>unit.id)}).status).toBe('accepted');const ringBefore=ring.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm})),beforeWood=sim.state.economies.blue!.resources.wood;
    expect(send(sim,{kind:'build',buildingType:'farm',builderIds:[original.id],originCell:{x:46,z:50},rotation:0,queued:false}).status).toBe('accepted');expect(sim.state.economies.blue!.resources.wood).toBe(beforeWood-buildings.farm.cost.wood*balance.rules.resourceScale);
    const farm=Object.values(sim.state.entities).find((entity):entity is Building=>entity.typeId==='farm')!;for(let tick=0;tick<1200&&original.blockedReason!=='PATH_BLOCKED';tick++)sim.step();expect(sim.view('blue').entities.find(entity=>entity.id===original.id)).toMatchObject({order:'build',taskState:'blocked',blockedReason:'PATH_BLOCKED'});expect(farm.work).toBe(0);const originalOrder=structuredClone(original.orders);
    if(controller==='ai')sim.options.controllers=true;else sim.setControlMode('blue','caretaker');let maximumBuilders=0;
    for(let tick=0;tick<180&&!sim.state.commandLog.some(entry=>entry.envelope.command.kind==='continue_build');tick++){sim.step();maximumBuilders=Math.max(maximumBuilders,Object.values(sim.state.entities).filter(entity=>entity.kind==='unit'&&entity.orders[0]?.kind==='build'&&entity.orders[0]?.targetId===farm.id).length);}
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
    for(let tick=0;tick<1200&&farm.work<farm.required;tick++){expect(original.orders).toEqual(originalOrder);sim.step();restored.step();maximumBuilders=Math.max(maximumBuilders,Object.values(sim.state.entities).filter(entity=>entity.kind==='unit'&&entity.orders[0]?.kind==='build'&&entity.orders[0]?.targetId===farm.id).length);if(tick%100===0)expect(restored.capture()).toEqual(sim.capture());}
    expect(farm.work).toBe(farm.required);expect(maximumBuilders).toBe(2);expect({xMm:original.xMm,zMm:original.zMm}).toEqual({xMm:85000,zMm:100000});expect(ring.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm}))).toEqual(ringBefore);
    const assists=sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='continue_build'&&entry.envelope.command.foundationId===farm.id);expect(assists).toHaveLength(1);expect(assists[0]!.envelope.command).toMatchObject({builderIds:[expect.stringMatching(/^helper_/) ]});
    const purchases=sim.state.commandLog.filter(entry=>entry.playerId==='blue').map(entry=>entry.envelope.command).filter(command=>command.kind==='build');expect(purchases.filter(command=>command.buildingType==='farm')).toHaveLength(1);
    // Age prerequisites may now proceed beside this unrelated paid farm. Match
    // every construction debit to an accepted purchase, retaining no-double-pay.
    expect(sim.state.economies.blue!.ledger.filter(entry=>entry.reason==='construction'&&entry.resource==='wood').reduce((sum,entry)=>sum+entry.deltaMilli,0)).toBe(-purchases.reduce((sum,command)=>sum+buildings[command.buildingType].cost.wood,0)*balance.rules.resourceScale);expect(restored.capture()).toEqual(sim.capture());
  },30000);
  it.each(['ai','caretaker'] as const)('resumes an interrupted paid farm through the full %s controller without buying it again',controller=>{
    const sim=createSimulation({matchId:'orphan_farm',seed:'caretaker-orphan-farm',controllers:false,caretakerEnabled:true,sharedVision:false,factions:[{id:'blue',name:'Blue',teamId:'blue',kind:controller==='ai'?'ai':'human',difficulty:'medium',personality:'builder',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]});
    const view=sim.view('blue'),home=view.entities.find(entity=>entity.ownerId==='blue'&&entity.typeId==='town_center')!,workers=view.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager');
    const proposal=buildingCommand(view,'farm',home,workers);expect(proposal?.kind).toBe('build');if(proposal?.kind!=='build')throw new Error('Missing ordinary farm site');
    const initialWood=sim.state.economies.blue!.resources.wood;expect(send(sim,proposal).status).toBe('accepted');
    expect(sim.state.economies.blue!.resources.wood).toBe(initialWood-buildings.farm.cost.wood*balance.rules.resourceScale);
    const farm=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='farm')!;
    for(let tick=0;tick<1200&&farm.work<1000;tick++)sim.step();expect(farm.work).toBeGreaterThan(0);expect(farm.work).toBeLessThan(farm.required);
    expect(send(sim,{kind:'stop',unitIds:proposal.builderIds}).status).toBe('accepted');const interruptedWork=farm.work,interruptedTick=sim.state.tick;
    expect(Object.values(sim.state.entities).some(entity=>entity.kind==='unit'&&entity.orders.some(order=>order.kind==='build'&&order.targetId===farm.id))).toBe(false);
    if(controller==='ai')sim.options.controllers=true;else sim.setControlMode('blue','caretaker');
    for(let tick=0;tick<120&&!sim.state.commandLog.some(entry=>entry.envelope.command.kind==='continue_build'&&entry.envelope.command.foundationId===farm.id);tick++)sim.step();
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
    for(let tick=0;tick<1800&&farm.work<farm.required;tick++){sim.step();restored.step();if(tick%100===0)expect(restored.capture()).toEqual(sim.capture());}
    expect(farm.work,`paid farm stayed at ${interruptedWork}/${farm.required} after tick ${interruptedTick}`).toBe(farm.required);
    const resumed=sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='continue_build'&&entry.envelope.command.foundationId===farm.id);expect(resumed).toHaveLength(1);
    expect(sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='build'&&entry.envelope.command.buildingType==='farm'&&entry.tick<=resumed[0]!.tick)).toHaveLength(1);
    const purchases=sim.state.commandLog.filter(entry=>entry.playerId==='blue'&&entry.tick<=resumed[0]!.tick).map(entry=>entry.envelope.command).filter(command=>command.kind==='build');expect(sim.state.economies.blue!.ledger.filter(entry=>entry.reason==='construction'&&entry.tick<=resumed[0]!.tick&&entry.resource==='wood').reduce((sum,entry)=>sum+entry.deltaMilli,0)).toBe(-purchases.reduce((sum,command)=>sum+buildings[command.buildingType].cost.wood,0)*balance.rules.resourceScale);
    expect(restored.capture()).toEqual(sim.capture());
  },30000);
  it('queues affordable Hard age research behind a paid replacement worker and completes both ordinary jobs',()=>{
    const sim=simulation(),home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='town_center')!;
    for(const [index,typeId]of (['barracks','lumber_camp'] as const).entries()){const definition=buildings[typeId],required=definition.buildSeconds*balance.rules.simulationHz*100;sim.state.entities[`age_prerequisite_${typeId}`]={id:`age_prerequisite_${typeId}`,kind:'building',typeId,ownerId:'blue',xMm:home.xMm+20000,zMm:home.zMm+(index?20000:-20000),hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,rotation:0,work:required,required,queue:[],cooldown:0};}
    const age=balance.ages.find(age=>age.id===2)!,scale=balance.rules.resourceScale;sim.state.economies.blue!.resources={food:(age.cost.food+units.villager.cost.food*2)*scale,wood:0,gold:age.cost.gold*scale,stone:0};sim.state.navigationRevision++;
    const workersBefore=Object.values(sim.state.entities).filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager').length;expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');const workerJob=home.queue[0]!.id;sim.step(5);
    const memory=emptyCaretakerMemory(),options={difficulty:'hard' as const,targetWorkers:36,allowMilitaryProduction:false,scoutAllowed:false};expect(caretakerCommands(sim.view('blue'),memory,options)).toEqual([]);expect(memory.nextStrategicTick).toBe(5+balance.ai.difficulty.hard.strategicIntervalSeconds*balance.rules.simulationHz);
    expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='advance_age')).toEqual([{kind:'advance_age',townCenterId:home.id,targetAge:2}]);expect(memory.pending.find(batch=>batch.commands.some(command=>command.kind==='advance_age'))!.executeTick).toBe(10);
    sim.step(4);expect(caretakerCommands(sim.view('blue'),memory,options)).toEqual([]);sim.step();const due=caretakerCommands(sim.view('blue'),memory,options).find(command=>command.kind==='advance_age')!;expect(due).toBeDefined();const before={...sim.state.economies.blue!.resources},paid=structuredClone(home.queue[0]);expect(send(sim,due).status).toBe('accepted');
    expect(home.queue[0]).toEqual(paid);expect(home.queue.map(job=>job.kind)).toEqual(['train','age']);expect(home.queue[0]!.id).toBe(workerJob);expect(sim.state.economies.blue!.resources).toEqual({food:before.food-age.cost.food*scale,wood:before.wood,gold:before.gold-age.cost.gold*scale,stone:before.stone});
    sim.step(home.queue[0]!.required-home.queue[0]!.work);expect(sim.state.economies.blue!.age).toBe(1);expect(Object.values(sim.state.entities).filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager')).toHaveLength(workersBefore+1);expect(home.queue[0]?.kind).toBe('age');
    sim.step(age.researchSeconds*balance.rules.simulationHz);expect(sim.state.economies.blue!.age).toBe(2);expect(home.queue).toEqual([]);
  });
  it('counts observed and proposed producer slots and suppresses queued, pending and due age duplicates',()=>{
    const base=observation();base.self.age=1;const capacity=balance.rules.queueWaitingLimit+1,options={difficulty:'hard' as const,targetWorkers:36,allowMilitaryProduction:false,scoutAllowed:false};
    const planned=(observed:number,pending:GameplayCommand[]=[],due=false,queuedAge=false)=>{const view=structuredClone(base),home=view.entities.find(entity=>entity.id==='home')!,memory=emptyCaretakerMemory();home.queue=Array.from({length:observed},(_,index)=>({id:`queued_${index}`,kind:'train' as const,typeId:'villager' as const,progress:0,state:'waiting' as const}));if(queuedAge)home.queue.push({id:'existing_age',kind:'age',typeId:'age_2',progress:0,state:'waiting'});if(pending.length)memory.pending=[{observedTick:0,executeTick:due?view.tick:view.tick+100,commands:pending}];const returned=caretakerCommands(view,memory,options);return {commands:memory.pending.flatMap(batch=>batch.commands),returned};};
    const train=(quantity:number):GameplayCommand=>({kind:'train',buildingId:'home',unitType:'villager',quantity}),age:GameplayCommand={kind:'advance_age',townCenterId:'home',targetAge:2};
    expect(planned(capacity).commands.some(command=>command.kind==='advance_age')).toBe(false);
    expect(planned(capacity-1,[train(1)]).commands.some(command=>command.kind==='advance_age')).toBe(false);
    expect(planned(0,[train(capacity)]).commands.some(command=>command.kind==='advance_age')).toBe(false);
    expect(planned(0,[train(capacity-1)]).commands.filter(command=>command.kind==='advance_age')).toHaveLength(1);
    const empty=planned(0);expect(empty.commands).toContainEqual(train(1));expect(empty.commands.filter(command=>command.kind==='advance_age')).toHaveLength(1);
    expect(planned(1,[],false,true).commands.some(command=>command.kind==='advance_age')).toBe(false);expect(planned(1,[age]).commands.filter(command=>command.kind==='advance_age')).toHaveLength(1);
    const returning=planned(1,[age],true);expect(returning.returned).toContainEqual(age);expect(returning.commands.some(command=>command.kind==='advance_age')).toBe(false);
  });
  it('does not double-spend due replacement costs when deciding whether the next age is affordable',()=>{
    const view=observation();view.self.age=1;view.self.resources={...balance.ages.find(age=>age.id===2)!.cost};const memory=emptyCaretakerMemory();memory.pending=[{observedTick:0,executeTick:view.tick,commands:[{kind:'train',buildingId:'home',unitType:'villager',quantity:1}]}];
    expect(caretakerCommands(view,memory,{difficulty:'hard',targetWorkers:0,allowMilitaryProduction:false,scoutAllowed:false})).toMatchObject([{kind:'train',unitType:'villager'}]);expect(memory.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='advance_age')).toBe(false);
  });
  it('leaves a wide street at the nearest site when a village has space',()=>{
    const view=observation();view.entities=view.entities.filter(entity=>['home','worker_0'].includes(entity.id));
    const home=view.entities.find(entity=>entity.id==='home')!,workers=view.entities.filter(entity=>entity.typeId==='villager');
    // Move beyond the old touching site to reserve two full grid cells.
    expect(buildingCommand(view,'market',home,workers)).toMatchObject({kind:'build',buildingType:'market',originCell:{x:26,z:20}});
  });
  it('prefers routine sites outside contour cells without changing visible occupants',()=>{
    const view=observation();view.entities=view.entities.filter(entity=>['home','worker_0'].includes(entity.id));const before=structuredClone(view),home=view.entities[0]!,workers=view.entities.filter(entity=>entity.typeId==='villager');
    const ordinary=buildingCommand(view,'market',home,workers);if(ordinary?.kind!=='build')throw new Error('MISSING_SITE');const avoid=[ordinary.originCell],preferred=buildingCommand(view,'market',home,workers,0,avoid);
    expect(preferred?.kind).toBe('build');if(preferred?.kind!=='build')throw new Error('MISSING_PREFERRED_SITE');const [width,depth]=buildings.market.footprintCells;
    expect(avoid.some(cell=>cell.x>=preferred.originCell.x&&cell.x<preferred.originCell.x+width&&cell.z>=preferred.originCell.z&&cell.z<preferred.originCell.z+depth)).toBe(false);expect(view).toEqual(before);
  });
  it('defers construction when its only visible economy site occupies a reserved passage',()=>{
    const view=observation();view.entities=view.entities.filter(entity=>['home','worker_0','barracks'].includes(entity.id));const home=view.entities[0]!,workers=view.entities.filter(entity=>entity.typeId==='villager'),original=fallbackCommands(view,emptyCaretakerMemory(),{scoutAllowed:false}).find(command=>command.kind==='build'&&command.buildingType==='farm');
    if(original?.kind!=='build')throw new Error('MISSING_FARM_SITE');const [width,depth]=buildings.farm.footprintCells,columns=view.map.widthMm/view.map.fogCellMm;view.fog.visible=placementFog(view,[original.originCell],width,depth);view.fog.explored=[...view.fog.visible];const before=structuredClone(view),avoid=[original.originCell];
    expect(buildingCommand(view,'farm',home,workers,0,avoid)).toBeUndefined();
    expect(buildingCommand(view,'farm',home,workers,1,[])).toEqual(original);expect(buildingCommand(view,'farm',home,workers,1,avoid)).toBeUndefined();
    expect(fallbackCommands(view,emptyCaretakerMemory(),{scoutAllowed:false,avoidBuildingCells:avoid}).some(command=>command.kind==='build')).toBe(false);expect(view).toEqual(before);
  });
  it('uses the actual rotated gate footprint when selecting and paying for a neighboring farm',()=>{
    const sim=simulation(),original=Object.values(sim.state.entities),home=original.find((entity):entity is Building=>entity.ownerId==='blue'&&entity.typeId==='town_center')!,worker=original.find((entity):entity is Unit=>entity.ownerId==='blue'&&entity.typeId==='villager')!,scout=original.find((entity):entity is Unit=>entity.ownerId==='blue'&&entity.typeId==='scout')!,enemy=original.find(entity=>entity.ownerId==='red'&&entity.typeId==='town_center')!;
    // Explicit completed geometry; the farm below uses the normal starting bank
    // and actual construction. The 90-degree gate occupies x90–92m, z92–98m.
    home.xMm=80000;home.zMm=80000;worker.xMm=88000;worker.zMm=90000;scout.xMm=98000;scout.zMm=86000;
    const completed=(id:string,typeId:'wooden_gate'|'barracks',xMm:number,zMm:number):Building=>{const def=buildings[typeId],required=def.buildSeconds*balance.rules.simulationHz*100;return {...home,id,typeId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,grantedHp:def.maxHp,work:required,required,queue:[]};};
    const gate=completed('rotated_gate','wooden_gate',91000,95000);gate.rotation=90;gate.gateMode='AUTO';gate.gateOpen=false;
    const barracks=completed('completed_barracks','barracks',115000,110000);sim.state.entities=Object.fromEntries([home,worker,scout,{...scout,id:'clearance_scout',xMm:90000,zMm:100000},enemy,gate,barracks].map(entity=>[entity.id,entity]));sim.state.map.terrain=[];sim.state.navigationRevision++;for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}sim.step();
    const blocked={x:44,z:48},legal={x:48,z:46},before=sim.state.economies.blue!.resources.wood;
    expect(send(sim,{kind:'build',buildingType:'farm',builderIds:[worker.id],originCell:blocked,rotation:0,queued:false})).toMatchObject({status:'rejected',code:'PLACEMENT_BLOCKED'});expect(sim.state.economies.blue!.resources.wood).toBe(before);
    const view=sim.view('blue'),columns=view.map.widthMm/view.map.fogCellMm,cells=placementFog(view,[blocked,legal]);expect(cells.every(cell=>view.fog.visible.includes(cell))).toBe(true);view.fog.visible=cells;view.fog.explored=[...cells];
    const proposal=fallbackCommands(view,emptyCaretakerMemory(),{scoutAllowed:false}).find(command=>command.kind==='build'&&command.buildingType==='farm');expect(proposal).toMatchObject({kind:'build',originCell:legal});if(proposal?.kind!=='build')throw new Error('MISSING_ROTATED_GATE_SITE');
    expect(send(sim,proposal).status).toBe('accepted');expect(sim.state.economies.blue!.resources.wood).toBe(before-buildings.farm.cost.wood*balance.rules.resourceScale);
    const farm=Object.values(sim.state.entities).find((entity):entity is Building=>entity.typeId==='farm')!;for(let tick=0;tick<1400&&farm.work<farm.required;tick++)sim.step();expect(farm.work).toBe(farm.required);expect(sim.state.economies.blue!.resources.wood).toBe(before-buildings.farm.cost.wood*balance.rules.resourceScale);
  });
  it.each(['caretaker','fallback'] as const)('keeps %s farm proposals outside full forest cells until observed depletion',policy=>{
    const view=observation();view.entities=view.entities.filter(entity=>['home','worker_0','barracks'].includes(entity.id));
    const home=view.entities[0]!,workers=view.entities.filter(entity=>entity.typeId==='villager');
    const propose=()=>policy==='caretaker'?buildingCommand(view,'farm',home,workers):fallbackCommands(view,emptyCaretakerMemory(),{scoutAllowed:false}).find(command=>command.kind==='build'&&command.buildingType==='farm');
    const original=propose();if(original?.kind!=='build')throw new Error('MISSING_FARM_SITE');
    const [width,depth]=buildings.farm.footprintCells,grid=balance.rules.buildingGridM*1000;
    const tree:ViewEntity={id:'forest_edge',kind:'resource',typeId:'tree_oak',ownerId:null,hp:1,maxHp:1,resource:'wood',amount:100,xMm:(original.originCell.x+width)*grid+1000,zMm:original.originCell.z*grid+depth*grid/2,forest:{patchId:'observed_patch',cellMm:balance.maps.forestNavigationCellM*1000}};
    view.entities.push(tree);
    const replacement=propose();expect(replacement?.kind).toBe('build');if(replacement?.kind!=='build')throw new Error('MISSING_CLEAR_SITE');
    expect(replacement.originCell).not.toEqual(original.originCell);
    const half=tree.forest!.cellMm/2,left=replacement.originCell.x*grid,top=replacement.originCell.z*grid;
    expect(tree.xMm+half>left&&tree.xMm-half<left+width*grid&&tree.zMm+half>top&&tree.zMm-half<top+depth*grid).toBe(false);
    tree.amount=0;expect(propose()).toEqual(original);
  });
  it('expands beyond a crowded village while preserving streets and reserved approaches',()=>{
    const view=observation();view.entities=view.entities.filter(entity=>['home','worker_0'].includes(entity.id));view.entities.push(structure('barracks','barracks',90000,40000));
    for(let z=24000;z<=52000;z+=4000)for(let x=24000;x<=52000;x+=4000){if(x+4000>34000&&x<46000&&z+4000>34000&&z<46000)continue;view.entities.push(structure(`house_${x}_${z}`,'house',x+2000,z+2000));}
    view.fog.visible=[];for(let z=9;z<=31;z++)for(let x=9;x<=31;x++)view.fog.visible.push(z*60+x);const localFog=[...view.fog.visible],outer={x:20,z:38};view.fog.visible.push(...placementFog(view,[outer]));view.fog.explored=[...view.fog.visible];
    const farm=(avoidBuildingCells:Cell[]=[])=>fallbackCommands(view,emptyCaretakerMemory(),{scoutAllowed:false,avoidBuildingCells}).find(command=>command.kind==='build'&&command.buildingType==='farm');
    const before=structuredClone(view);expect(farm()).toMatchObject({kind:'build',originCell:outer});expect(farm([outer])).toBeUndefined();expect(view).toEqual(before);
    view.fog.visible=localFog;view.fog.explored=[...localFog];expect(farm()).toBeUndefined();view.fog.visible=before.fog.visible;view.fog.explored=[...view.fog.visible];view.map.terrain=[{id:'outer_slope',kind:'hill',xMm:outer.x*2000,zMm:outer.z*2000,widthMm:6000,depthMm:6000,elevationMm:1000}];expect(farm()).toBeUndefined();
  });
  it.each([false,true])('reserves pending or due wall construction before caretaker farm purchases (due=%s)',due=>{
    const view=observation();view.entities=view.entities.filter(entity=>entity.id!=='forage');const memory=emptyCaretakerMemory(),wall:GameplayCommand={kind:'build_wall',builderIds:['worker_0'],material:'palisade',cells:[{x:35,z:35}],queued:false};memory.pending=[{observedTick:0,executeTick:due?view.tick:view.tick+100,commands:[wall]}];const before=structuredClone(view);
    const returned=caretakerCommands(view,memory,{allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false});expect(returned).toEqual(due?[wall]:[]);expect(memory.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='build')).toBe(false);expect(view).toEqual(before);
  });
  it('pays for and completes age prerequisites outside a congested village through ordinary commands',()=>{
    // Explicit geometry/age/bank fixture, not an ordinary-resource progression claim.
    // Subsequent construction, movement, spending and age work use real admission.
    const sim=simulation(),home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='town_center')!;
    home.xMm=80000;home.zMm=80000;
    // This fixture isolates crowded farms from the map's separately tested forest placement.
    for(const entity of Object.values(sim.state.entities))if(entity.kind==='resource')delete sim.state.entities[entity.id];sim.state.map.terrain=[];
    const workers=Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='villager'),scout=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!;
    workers.forEach((worker,index)=>{worker.xMm=90000+index*1600;worker.zMm=46000;worker.stance='stand_ground';});scout.xMm=80000;scout.zMm=42000;scout.stance='stand_ground';
    for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&entity.ownerId==='blue'&&entity.id!==home.id){entity.xMm=160000;entity.zMm=80000;}
    const half=buildings.town_center.footprintCells.map(value=>value*1000),farmDefinition=buildings.farm,required=farmDefinition.buildSeconds*balance.rules.simulationHz*100;
    let serial=0;
    for(let z=56000;z<104000;z+=6000)for(let x=56000;x<104000;x+=6000){
      if(x+6000>home.xMm-half[0]!&&x<home.xMm+half[0]!&&z+6000>home.zMm-half[1]!&&z<home.zMm+half[1]!)continue;
      const farm:Building={id:`congestion_farm_${++serial}`,kind:'building',typeId:'farm',ownerId:'blue',xMm:x+3000,zMm:z+3000,hp:farmDefinition.maxHp,maxHp:farmDefinition.maxHp,rotation:0,work:required,required,grantedHp:farmDefinition.maxHp,queue:[],cooldown:0,foodRemaining:farmDefinition.foodCapacity!*balance.rules.resourceScale};sim.state.entities[farm.id]=farm;
    }
    sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources={food:2000000,wood:2000000,gold:1000000,stone:0};sim.state.navigationRevision++;sim.step();
    const firstView=sim.view('blue'),initialWorkers=firstView.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager');
    const first=buildingCommand(firstView,'market',firstView.entities.find(entity=>entity.id===home.id)!,initialWorkers);
    expect(first?.kind).toBe('build');if(first?.kind!=='build')throw new Error('Missing expanded market site');
    expect(Math.max(Math.abs(first.originCell.x-40),Math.abs(first.originCell.z-40))).toBeGreaterThan(10);
    // A filtered-view planner still cannot use unobserved outer land.
    const concealed=structuredClone(firstView),columns=concealed.map.widthMm/concealed.map.fogCellMm;
    concealed.fog.visible=concealed.fog.visible.filter(cell=>{const x=cell%columns*concealed.map.fogCellMm,z=Math.floor(cell/columns)*concealed.map.fogCellMm;return x>=60000&&x<100000&&z>=60000&&z<100000;});
    expect(buildingCommand(concealed,'market',home,initialWorkers)?.kind).toBe('build');concealed.fog.explored=[...concealed.fog.visible];expect(buildingCommand(concealed,'market',home,initialWorkers)).toBeUndefined();
    for(const typeId of ['market','blacksmith'] as const){
      const view=sim.view('blue'),proposal=typeId==='market'?first:buildingCommand(view,typeId,view.entities.find(entity=>entity.id===home.id)!,view.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager'));
      expect(proposal?.kind).toBe('build');if(proposal?.kind!=='build')throw new Error('Missing expanded prerequisite site');
      const before=sim.state.economies.blue!.resources.wood,receipt=send(sim,proposal);expect(receipt.status,receipt.code).toBe('accepted');
      expect(sim.state.economies.blue!.resources.wood).toBe(before-buildings[typeId].cost.wood*balance.rules.resourceScale);
      const foundation=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId===typeId)!;
      expect(foundation.work).toBe(0);
      for(let tick=0;tick<(buildings[typeId].buildSeconds+60)*balance.rules.simulationHz&&foundation.work<foundation.required;tick++)sim.step();
      expect(sim.view('blue').entities.find(entity=>entity.id===foundation.id)?.progress).toBe(1);
    }
    const age=balance.ages.find(age=>age.id===3)!,before={...sim.view('blue').self.resources};
    expect(send(sim,{kind:'advance_age',townCenterId:home.id,targetAge:3}).status).toBe('accepted');
    expect(sim.view('blue').self.resources).toEqual({food:before.food-age.cost.food,wood:before.wood-age.cost.wood,gold:before.gold-age.cost.gold,stone:before.stone-age.cost.stone});
    sim.step(age.researchSeconds*balance.rules.simulationHz);expect(sim.view('blue').self.age).toBe(3);
  },30000);
  it('does not consume scouting destinations through discarded cooldown proposals',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.entities.push(unit('scout','scout','blue',80000,80000));
    view.fog.explored=view.fog.explored.filter(cell=>cell%60<48);view.fog.visible=[...view.fog.explored];
    const options={allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false};
    for(const tick of [10,20,30,40]){view.tick=tick;caretakerCommands(view,memory,options);expect(memory.scoutIndex).toBe(0);expect(memory.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes('scout'))).toBe(false);}
    view.tick=50;caretakerCommands(view,memory,{...options,scoutAllowed:true});expect(memory.scoutIndex).toBe(1);
    const pending=memory.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes('scout'));expect(pending).toMatchObject({kind:'move',unitIds:['scout'],queued:false});
    const fresh=emptyCaretakerMemory();caretakerCommands(view,fresh,{...options,scoutAllowed:true});expect(fresh.pending.flatMap(batch=>batch.commands)).toContainEqual(pending);
    view.tick=66;expect(caretakerCommands(view,memory,options)).toContainEqual(pending);expect(memory.scoutIndex).toBe(1);
  });
  it('keeps proactive housing buffers separate from the actual configured capacity',()=>{
    const view=observation();view.self.population=27;view.self.populationCap=30;view.self.populationLimit=120;
    const options={allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false};
    const normal=emptyCaretakerMemory(),proactive=emptyCaretakerMemory(),before=structuredClone(view);
    caretakerCommands(view,normal,{...options,housingBuffer:2});caretakerCommands(view,proactive,{...options,housingBuffer:3});
    expect(normal.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='build'&&command.buildingType==='house')).toBe(false);
    expect(proactive.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='build'&&command.buildingType==='house')).toBe(true);expect(view).toEqual(before);
    view.self.population=120;view.self.populationCap=120;const capped=emptyCaretakerMemory();caretakerCommands(view,capped,{...options,housingBuffer:5});
    expect(capped.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='build'&&command.buildingType==='house')).toBe(false);
  });
  it('uses the 0.5-second decision cadence and 0.8-second delay without duplicating pending production',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.tick=9;expect(caretakerCommands(view,memory)).toEqual([]);expect(memory.pending).toHaveLength(0);view.tick=10;expect(caretakerCommands(view,memory)).toEqual([]);view.tick=20;expect(caretakerCommands(view,memory)).toEqual([]);
    expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='train')).toHaveLength(1);view.tick=25;expect(caretakerCommands(view,memory)).toEqual([]);view.tick=26;const commands=caretakerCommands(view,memory);expect(commands.some(command=>command.kind==='train'&&command.unitType==='archer')).toBe(true);
    for(const [i,command]of commands.entries())expect(validateClientCommand({protocolVersion:2,matchId:'caretaker',matchEpoch:1,clientCommandId:`c_${i}`,clientSequence:i+1,command})).toBe(true);
  });
  it.each([['knight','spearman'],['archer','skirmisher']] as const)('reacts to observed %s with %s production and defense of workers', (enemyType,counter)=>{
    const view=observation();view.entities.push(unit('visible_enemy',enemyType,'red',70000,65000));const {commands,memory}=delayed(view);expect(commands.some(command=>command.kind==='train'&&command.unitType===counter)).toBe(true);expect(commands.some(command=>command.kind==='attack_target'&&command.targetId==='visible_enemy')).toBe(true);expect(memory.seenEnemies.visible_enemy.typeId).toBe(enemyType);
  });
  it('retreats a damaged group and does not target remembered or absent enemies',()=>{
    const view=observation();for(const entity of view.entities)if(entity.id.startsWith('soldier'))entity.hp=10;view.entities.push(unit('danger','knight','red',68000,60000));const {commands}=delayed(view);expect(commands.find(command=>command.kind==='move'&&command.unitIds.includes('soldier_a'))).toMatchObject({kind:'move',unitIds:['soldier_a','soldier_b','soldier_c']});expect(commands.some(command=>command.kind==='attack_target')).toBe(false);
    const hidden=observation();hidden.entities.push({...unit('remembered','knight','red',68000,60000),ghost:true});const state=emptyCaretakerMemory(),before=structuredClone(hidden);caretakerCommands(hidden,state);expect(hidden).toEqual(before);expect(state.seenEnemies).toEqual({});expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='attack_target')).toBe(false);
  });
  it('plans demanded resource expansion and routine upgrades at the 45-second strategic interval',()=>{
    const view=observation();view.self.age=4;view.entities.find(entity=>entity.id==='worker_0')!.workTargetId='remote_gold';view.entities.push({id:'remote_gold',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:94000,zMm:90000,hp:1,maxHp:1,resource:'gold',amount:1500});const {commands,memory}=delayed(view);
    expect(commands.some(command=>command.kind==='build'&&command.buildingType==='mining_camp'&&command.originCell.x>30)).toBe(true);expect(commands.some(command=>command.kind==='research'&&command.technologyId==='forestry_1')).toBe(true);expect(memory.nextStrategicTick).toBe(10+45*balance.rules.simulationHz);
  });
});

describe('construction recovery and age priorities',()=>{
  const options:RulePolicyOptions={allowStrategic:false,allowMilitaryProduction:false,targetWorkers:0,scoutAllowed:false};
  const queued=(memory:ReturnType<typeof emptyCaretakerMemory>)=>memory.pending.flatMap(batch=>batch.commands);
  function stalled(){
    const view=observation(),memory=emptyCaretakerMemory(),foundation={...structure('stalled_camp','lumber_camp',95000,95000),progress:0},builder=view.entities.find(entity=>entity.id==='worker_0')!;
    builder.order='build';builder.workTargetId=foundation.id;builder.taskState='moving';view.entities.push(foundation);
    return {view,memory,foundation,builder};
  }
  it('uses catalogue Empire prerequisites and retains a paid alternative for Settlement',()=>{
    const view=observation();view.self.age=3;expect(missingAgeBuildings(view)).toEqual(['siege_workshop','university']);view.entities.push(structure('siege','siege_workshop',90000,90000));expect(missingAgeBuildings(view)).toEqual(['university']);view.entities.push(structure('university','university',100000,100000));expect(missingAgeBuildings(view)).toEqual([]);
    view.self.age=1;view.entities=view.entities.filter(entity=>entity.typeId==='town_center'||entity.typeId==='barracks'||entity.typeId==='villager');view.entities.push({...structure('paid_mine','mining_camp',90000,90000),progress:.25});expect(missingAgeBuildings(view)).toEqual(['mining_camp']);view.entities.find(entity=>entity.id==='paid_mine')!.progress=1;expect(missingAgeBuildings(view)).toEqual([]);
  });
  it('keeps discovered but unworked remote resources from creating optional camps',()=>{
    const view=observation();view.self.age=4;view.entities.push({id:'unworked_gold',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:94000,zMm:90000,hp:1,maxHp:1,resource:'gold',amount:1500});
    const memory=emptyCaretakerMemory();caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory).some(command=>command.kind==='build'&&command.buildingType==='mining_camp')).toBe(false);
  });
  it.each(['remembered','allied_dropoff','protected_worker'] as const)('does not expand camps for a %s resource demand',condition=>{
    const view=observation(),memory=emptyCaretakerMemory();view.self.age=4;view.entities.push({id:'remote_gold',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:94000,zMm:90000,hp:1,maxHp:1,resource:'gold',amount:1500,...(condition==='remembered'?{ghost:true}:{})});view.entities.find(entity=>entity.id==='worker_0')!.workTargetId='remote_gold';
    if(condition==='allied_dropoff'){view.players[1]!.teamId='blue';view.entities.push({...structure('allied_mine','mining_camp',100000,100000),ownerId:'red'});}
    caretakerCommands(view,memory,{...options,allowStrategic:true,...(condition==='protected_worker'?{protectedEntityIds:new Set(['worker_0'])}:{})});expect(queued(memory).some(command=>command.kind==='build'&&command.buildingType==='mining_camp')).toBe(false);
  });
  it('builds missing age prerequisites ahead of demanded camps despite an unrelated paid foundation',()=>{
    const {view,memory}=stalled();view.entities.push({id:'remote_gold',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:94000,zMm:90000,hp:1,maxHp:1,resource:'gold',amount:1500});view.entities.find(entity=>entity.id==='worker_1')!.workTargetId='remote_gold';
    caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory).filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual(['market']);
  });
  it('does not duplicate a paid prerequisite while another prerequisite is missing',()=>{
    const {view,memory,foundation}=stalled();foundation.typeId='market';caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory).filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual(['blacksmith']);
  });
  it('protects a partially funded prerequisite budget from optional military and research purchases',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.self.resources.wood=buildings.market.cost.wood;
    caretakerCommands(view,memory,{...options,allowStrategic:true,allowMilitaryProduction:true,desiredUnitType:'archer',armyTarget:20});
    expect(queued(memory).filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual(['market']);
    expect(queued(memory).some(command=>command.kind==='train'||command.kind==='research')).toBe(false);
  });
  it('does not block non-wood purchases merely because prerequisite wood is missing',()=>{
    const view=observation(),memory=emptyCaretakerMemory();view.self.resources.wood=0;expect(units.militia.cost.wood).toBe(0);
    caretakerCommands(view,memory,{...options,allowMilitaryProduction:true,desiredUnitType:'militia',armyTarget:20});
    expect(queued(memory)).toContainEqual({kind:'train',buildingId:'barracks',unitType:'militia',quantity:1});
  });
  it.each(['housing','food'] as const)('keeps emergency %s construction ahead of age prerequisites',need=>{
    const {view,memory}=stalled();if(need==='housing')view.self.populationCap=view.self.population;else{view.entities=view.entities.filter(entity=>entity.id!=='forage');view.self.resources.food=0;}
    caretakerCommands(view,memory,{...options,allowStrategic:true});expect(queued(memory).filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual([need==='housing'?'house':'farm']);
  });
  it('uses a nearer helper after a moving builder makes no observed progress, then retries only that helper',()=>{
    const {view,memory,foundation,builder}=stalled(),delay=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;
    caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
    view.tick+=delay;caretakerCommands(view,memory,options);const action=queued(memory).find(command=>command.kind==='continue_build')!;expect(action).toMatchObject({kind:'continue_build',foundationId:foundation.id});if(action.kind!=='continue_build')throw new Error('NO_HELPER');expect(action.builderIds).not.toContain(builder.id);
    const helper=view.entities.find(entity=>entity.id===action.builderIds[0])!;helper.order='build';helper.workTargetId=foundation.id;helper.taskState='moving';memory.pending=[];view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
    view.tick+=delay;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([action]);
  });
  it.each(['motion','construction'] as const)('resets stalled observation on actual %s progress',progress=>{
    const {view,memory,foundation,builder}=stalled(),delay=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;
    caretakerCommands(view,memory,options);view.tick+=delay-10;if(progress==='motion')builder.xMm+=100;else foundation.progress=.1;caretakerCommands(view,memory,options);
    view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
  });
  it('retries the stalled original builder when no spare worker exists, retaining the same bounded recovery identity',()=>{
    const {view,memory,foundation,builder}=stalled(),delay=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;
    view.entities=view.entities.filter(entity=>entity.typeId!=='villager'||entity.id===builder.id);
    caretakerCommands(view,memory,options);view.tick+=delay;caretakerCommands(view,memory,options);
    const action={kind:'continue_build',builderIds:[builder.id],foundationId:foundation.id,queued:false};expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([action]);
    expect(memory.construction![foundation.id]!.helperId).toBe(builder.id);memory.pending=[];view.tick+=10;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
    view.tick+=delay;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([action]);
  });
  it.each(['queued','cargo'] as const)('does not retry a stalled original with %s work when no spare worker exists',condition=>{
    const {view,memory,builder}=stalled();view.entities=view.entities.filter(entity=>entity.typeId!=='villager'||entity.id===builder.id);if(condition==='queued')builder.queuedOrderCount=1;else builder.cargo={resource:'wood',amount:5};
    caretakerCommands(view,memory,options);view.tick+=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;caretakerCommands(view,memory,options);expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([]);
  });
  it.each(['foundation','builder','all_helpers'] as const)('does not take over protected %s during stalled recovery',protectedKind=>{
    const {view,memory,foundation,builder}=stalled(),protectedEntityIds=new Set(protectedKind==='foundation'?[foundation.id]:protectedKind==='builder'?[builder.id]:view.entities.filter(entity=>entity.typeId==='villager'&&entity.id!==builder.id).map(entity=>entity.id));
    caretakerCommands(view,memory,{...options,protectedEntityIds});view.tick+=balance.ai.difficulty.medium.strategicIntervalSeconds*balance.rules.simulationHz;caretakerCommands(view,memory,{...options,protectedEntityIds});expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual(protectedKind==='all_helpers'?[{kind:'continue_build',builderIds:[builder.id],foundationId:foundation.id,queued:false}]:[]);
  });
  it('recognizes another foundation\'s builder without blocking an orphan, and prunes completed records',()=>{
    const {view,memory,foundation}=stalled(),orphan={...structure('orphan_market','market',70000,80000),progress:.1};view.entities.push(orphan);caretakerCommands(view,memory,options);
    expect(queued(memory).filter(command=>command.kind==='continue_build')).toEqual([expect.objectContaining({foundationId:orphan.id})]);expect(Object.keys(memory.construction!)).toHaveLength(2);
    memory.pending=[];foundation.progress=1;orphan.progress=1;view.tick+=10;caretakerCommands(view,memory,options);expect(memory.construction).toEqual({});
  });
});

describe('M5 caretaker authority and persistence',()=>{
  it('keeps existing tasks during disconnection and revokes only caretaker orders on return, retaining paid jobs',()=>{
    const sim=simulation(),worker=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager'&&entity.ownerId==='blue')!,home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center'&&entity.ownerId==='blue')!;
    const original={kind:'move' as const,unitIds:[worker.id],target:{xMm:worker.xMm+10000,zMm:worker.zMm},queued:false};expect(send(sim,original).status).toBe('accepted');const prior=structuredClone(worker.orders);sim.setControlMode('blue','disconnected');sim.step(2);expect(worker.orders).toEqual(prior);expect(sim.state.commandLog).toHaveLength(1);
    sim.setControlMode('blue','caretaker');expect(send(sim,{...original,target:{xMm:worker.xMm,zMm:worker.zMm+8000}},'caretaker').status).toBe('accepted');expect(worker.orders[0]!.authority).toEqual({kind:'caretaker',generation:1});expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'caretaker').status).toBe('accepted');const food=sim.state.economies.blue!.resources.food;
    expect(send(sim,{...original,queued:true,target:{xMm:worker.xMm+6000,zMm:worker.zMm+6000}}).status).toBe('accepted');send(sim,{kind:'set_auto_reseed',enabled:true},'caretaker');sim.setControlMode('blue','human');expect(worker.orders[0]).toEqual(prior[0]);expect(worker.orders).toHaveLength(2);expect(worker.orders.every(order=>!order.authority)).toBe(true);expect(home.queue).toHaveLength(1);expect(sim.state.economies.blue!.resources.food).toBe(food);expect(sim.state.economies.blue!.autoReseed).toBe(false);expect(sim.view('blue').players.find(player=>player.id==='blue')!.controlMode).toBe('human');
  });
  it('restores pending reactions exactly and replays takeover/reconnection without planner or endpoint calls',()=>{
    const sim=simulation();sim.setControlMode('blue','disconnected');sim.step(2);sim.setControlMode('blue','caretaker');sim.step(8);expect(sim.state.control.blue!.memory.pending.length).toBeGreaterThan(0);
    const save=JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),restored=restoreSimulation(save,identity,{preserveEpoch:true});expect(restored.capture()).toEqual(sim.capture());for(let i=0;i<35;i++){sim.step();restored.step();expect(restored.capture()).toEqual(sim.capture());}
    expect(sim.state.commandLog.some(entry=>entry.envelope.clientCommandId.startsWith('caretaker_'))).toBe(true);sim.setControlMode('blue','human');expect(sim.state.control.blue!.memory.pending).toHaveLength(0);expect(Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue').every(entity=>entity.orders.every(order=>!order.authority))).toBe(true);
    const recording=exportReplay(sim,identity,[replayCheckpoint(sim)]),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('NO_MODEL'));try{const runner=new ReplayRunner(recording,identity);expect(runner.advanceTo(sim.state.tick).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());expect(network).not.toHaveBeenCalled();expect(runner.simulation.state.factions.filter(faction=>faction.kind==='ai')).toHaveLength(0);}finally{network.mockRestore();}
  });
  it('applies host surrender while paused, resolves victory immediately and replays the administrative event',()=>{
    const sim=simulation();sim.setStatus('PAUSED');sim.adminSurrender('red');expect(sim.state.status).toBe('FINISHED');expect(sim.state.result!.winnerTeamId).toBe('blue');expect(sim.state.tick).toBe(0);const runner=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(runner.advanceTo(0).done).toBe(true);expect(runner.simulation.capture()).toEqual(sim.capture());
  });
});
