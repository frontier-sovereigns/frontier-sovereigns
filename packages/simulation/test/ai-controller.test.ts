import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, units, contentHash, type AiGoal, type GameplayCommand, type UnitId, type BuildingId, type PlayerView, type ViewEntity, type ResourceBank, type Position } from '@frontier/shared';
import { createSimulation, createLiveSimulation, createReplayRecording, exportSimulationSave, restoreSimulation, exportReplay, replayCheckpoint, ReplayRunner, Simulation, type Building, type Unit, type Entity, type ResourceNode, type EngineIdentity } from '../src/index.js';
import { applyCommanderPatches, applyGoalReceipt, createCommanderState, type CommanderState } from '../src/ai-controller.js';
import { commanderCommands } from '../src/ai-policy.js';
import * as commanderPolicy from '../src/ai-policy.js';
import { desiredGoalCommands, aiFortifyPlacementCells } from '../src/ai-executor.js';
import { fallbackCommands } from '../src/fallback.js';
import { buildingCommand, caretakerCommands, emptyCaretakerMemory } from '../src/caretaker.js';
import * as caretakerPolicy from '../src/caretaker.js';
import { Navigation, PathBudgetExceededError } from '../src/navigation.js';
import { AiDecisionContext, knownNavigation, scoutDestination } from '../src/ai-exploration.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { fortifyCommands, markFortifyQueued, type FortifyMemory } from '../src/fortify-planner.js';
import { fortifyViewObstacle, resolveFortifyGeometry, resolveFortifyScreen, validFortifyLayout, fortifyLayoutSignature } from '../src/fortify-geometry.js';
import { developmentBuildings, type AiDispatch } from '../src/ai-observation.js';
import { validateCommanderMemory, validateSimulationSavePayload } from '../src/save-schema.js';

const identity:EngineIdentity={engineBuildHash:'6'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function simulation(controllers=false,difficulty:'easy'|'medium'|'hard'='medium'){return createSimulation({matchId:'commander',seed:'m6-commander',controllers,sharedVision:false,factions:[{id:'blue',name:'Blue',teamId:'allies',kind:'ai',difficulty,personality:'marshal',color:'#3388ff'},{id:'ally',name:'Ally',teamId:'allies',kind:'human',color:'#55dd88'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}]});}
function fixture(){const sim=simulation();sim.state.entities={};sim.state.map.terrain=[];sim.state.navigationRevision++;for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}let nonce=0;
  const structure=(typeId:BuildingId,xMm:number,zMm:number,ownerId='blue'):Building=>{const def=buildings[typeId],entity:Building={id:`building_${++nonce}`,kind:'building',ownerId,typeId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,grantedHp:def.maxHp,rotation:0,work:def.buildSeconds*2000,required:def.buildSeconds*2000,queue:[],cooldown:0};sim.state.entities[entity.id]=entity;sim.state.navigationRevision++;return entity;};
  const unit=(typeId:UnitId,xMm:number,zMm:number,ownerId='blue'):Unit=>{const def=units[typeId],entity:Unit={id:`unit_${++nonce}`,kind:'unit',ownerId,typeId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',...(typeId==='trebuchet'?{deploymentState:'packed' as const}:{})};sim.state.entities[entity.id]=entity;return entity;};
  const home=structure('town_center',80000,80000),barracks=structure('barracks',98000,80000),mill=structure('mill',65000,78000),lumber=structure('lumber_camp',66000,92000),mine=structure('mining_camp',80000,98000);structure('town_center',220000,220000,'ally');structure('town_center',280000,280000,'red');for(let i=0;i<8;i++)structure('house',40000+i*6000,50000);
  const workers=Array.from({length:6},(_,i)=>unit('villager',76000+i*1500,90000)),scout=unit('scout',92000,94000);sim.state.economies.blue!.age=4;sim.state.economies.blue!.resources={food:6000000,wood:6000000,gold:6000000,stone:6000000};sim.step();return {sim,structure,unit,home,barracks,mill,lumber,mine,workers,scout};
}
type CommandSimulation=Pick<Simulation,'state'|'view'|'command'|'prepareAiRequest'|'completeAiRequest'>;
function plan(sim:CommandSimulation,goals:(dispatch:AiDispatch)=>AiGoal[],chatIds:string[]=[]){const dispatch=sim.prepareAiRequest('blue',`request_${sim.state.controllers.blue!.observationNonce+1}`,chatIds);const response=sim.completeAiRequest(dispatch.binding,{kind:'plan',plan:{schemaVersion:1,observationId:dispatch.binding.observationId,strategy:'Bounded desired state',goals:goals(dispatch),message:null}});expect(response.accepted).toBe(true);return {dispatch,response};}
function send(sim:CommandSimulation,command:GameplayCommand){const sequence=sim.state.economies.blue!.lastClientSequence+1;return sim.command('blue',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`goal_${sequence}`,clientSequence:sequence,command},'ai');}
function execute(sim:CommandSimulation){const state=sim.state.controllers.blue!,proposals=desiredGoalCommands(sim.view('blue'),state);return proposals.map(proposal=>{const receipt=send(sim,proposal.command);if(proposal.goalKey)applyGoalReceipt(state,proposal.goalKey,proposal.command,receipt);return {command:proposal.command,receipt};});}
const ref=(dispatch:AiDispatch,kind:string)=>Object.values(dispatch.references).find(reference=>reference.kind===kind)!.ref;

describe('conquest maintenance',()=>{
  it('assigns idle squad members and later reinforcements without restarting a travelling member',()=>{
    const {sim,unit}=fixture(),first=unit('militia',114000,120000);sim.step();
    plan(sim,()=>[{kind:'army_order',squadRef:'army-main',order:'rally',targetRef:'frontier-east'}]);
    const firstOrder=execute(sim)[0];expect(firstOrder?.receipt.status).toBe('accepted');const revision=first.orderRevision,orders=structuredClone(first.orders),second=unit('militia',116000,120000);
    sim.step(20);const state=sim.state.controllers.blue!,view=sim.view('blue');
    expect(state.planReferences['army-main']).toMatchObject({entityIds:[first.id]});
    const actions=desiredGoalCommands(view,state);expect(actions).toMatchObject([{command:{kind:'move',unitIds:[second.id]}}]);
    expect(send(sim,actions[0]!.command).status).toBe('accepted');expect(first.orderRevision).toBe(revision);expect(first.orders).toEqual(orders);expect(second.orders[0]?.kind).toBe('move');
  });
  it('keeps queued, engaged, garrisoned and manually held reinforcements out of standing missions',()=>{
    const {sim,unit}=fixture();for(let i=0;i<6;i++)unit('militia',114000+i*1000,120000);sim.step();plan(sim,()=>[{kind:'army_order',squadRef:'army-main',order:'rally',targetRef:'frontier-east'}]);
    const state=sim.state.controllers.blue!,view=sim.view('blue'),members=view.entities.filter(entity=>entity.typeId==='militia');view.tick+=40;state.plan!.goals[0]!.lastIssuedTick=1;
    members[0]!.order='move';members[0]!.taskState='moving';members[1]!.queuedOrderCount=1;members[2]!.visualAction={kind:'attack',startedTick:view.tick,durationTicks:20};members[3]!.garrisonedIn='owned_carrier';
    const actions=desiredGoalCommands(view,state,undefined,new Set([members[4]!.id]));expect(actions).toMatchObject([{command:{kind:'move',unitIds:[members[5]!.id]}}]);
  });
  it('bounds reinforcement orders to the unit-command limit and admits the next idle batch',()=>{
    const {sim,unit}=fixture();unit('militia',114000,120000);sim.step();plan(sim,()=>[{kind:'army_order',squadRef:'army-main',order:'rally',targetRef:'frontier-east'}]);
    const state=sim.state.controllers.blue!,view=sim.view('blue'),soldier=view.entities.find(entity=>entity.typeId==='militia')!;view.tick+=40;state.plan!.goals[0]!.lastIssuedTick=1;
    for(let index=0;index<200;index++)view.entities.push({...soldier,id:`reinforcement_${index}`});
    const first=desiredGoalCommands(view,state)[0]!.command;if(first.kind!=='move')throw new Error('MISSING_REINFORCEMENT_ORDER');expect(first.unitIds).toHaveLength(200);
    for(const id of first.unitIds)view.entities.find(entity=>entity.id===id)!.order='move';
    expect(desiredGoalCommands(view,state)).toMatchObject([{command:{kind:'move',unitIds:['reinforcement_199']}}]);
  });
  it('packs an idle deployed reinforcement before routing it without restarting its marching escort',()=>{
    const {sim,unit}=fixture();unit('militia',114000,120000);unit('trebuchet',116000,120000);sim.step();plan(sim,()=>[{kind:'army_order',squadRef:'army-main',order:'rally',targetRef:'frontier-east'}]);
    const state=sim.state.controllers.blue!,view=sim.view('blue'),siege=view.entities.find(entity=>entity.typeId==='trebuchet')!,escort=view.entities.find(entity=>entity.typeId==='militia')!;view.tick+=40;state.plan!.goals[0]!.lastIssuedTick=1;siege.deploymentState='deployed';escort.order='move';escort.taskState='moving';
    expect(desiredGoalCommands(view,state)).toMatchObject([{command:{kind:'pack',unitIds:[siege.id]}}]);siege.deploymentState='packing';expect(desiredGoalCommands(view,state)).toEqual([]);siege.deploymentState='packed';expect(desiredGoalCommands(view,state)).toMatchObject([{command:{kind:'move',unitIds:[siege.id]}}]);
  });
  it('retains fulfilled defensive assignments instead of sending their idle members on autonomous conquest',()=>{
    const {sim,unit,home}=fixture();for(let i=0;i<12;i++)unit('militia',home.xMm+7500+i*100,home.zMm+7500);sim.state.tick=24000;sim.step();plan(sim,d=>[{kind:'army_order',squadRef:'army-main',order:'defend',targetRef:ref(d,'own_base')}]);
    const view=sim.view('blue'),state=sim.state.controllers.blue!;view.tick=24020;view.entities.push({id:'remembered_base',kind:'building',typeId:'town_center',ownerId:'red',xMm:170000,zMm:100000,hp:2400,maxHp:2400,progress:1,ghost:true,lastSeenTick:22000});state.plan!.goals[0]!.status='fulfilled';state.nextScoutTick=50000;
    commanderCommands(view,state);expect(state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='attack_target'||command.kind==='attack_move')).toEqual([]);
  });
  it('keeps idle offensive reinforcements available for an observed attack on their workers',()=>{
    const {sim,unit}=fixture();unit('militia',114000,120000);sim.state.tick=24000;sim.step();plan(sim,()=>[{kind:'army_order',squadRef:'army-main',order:'attack',targetRef:'frontier-east'}]);
    const view=sim.view('blue'),state=sim.state.controllers.blue!;view.entities.push({id:'observed_raider',kind:'unit',typeId:'militia',ownerId:'red',xMm:76000,zMm:91000,hp:40,maxHp:40});
    expect(desiredGoalCommands(view,state)).toEqual([]);expect(state.plan!.goals[0]).toMatchObject({status:'pending',reason:'LOCAL_DEFENSE_REQUIRED'});
  });
  it('reports invented anchor aliases as rejected goals while retaining valid work and recovery feedback',()=>{
    const {sim}=fixture(),{response}=plan(sim,()=>[{kind:'develop',anchorRef:'own_base',targetAge:4},{kind:'ensure_units',unitType:'militia',targetCount:1}]);
    expect(response).toMatchObject({code:'PLAN_PARTIALLY_ACCEPTED',rejections:[{key:'development',code:'INVALID_ANCHOR'}]});expect(execute(sim).map(item=>item.command.kind)).toEqual(['train']);
    expect(sim.state.controllers.blue!.reason).toBe('INVALID_GOALS_REJECTED');expect(sim.state.controllers.blue!.memory.facts.some(fact=>fact.text.includes('INVALID_ANCHOR')&&fact.text.includes('references[].ref'))).toBe(true);
  });
  it('uses actual worker targets to recover age food in a model plan despite stale assignment memory',()=>{
    const {sim}=fixture();plan(sim,()=>[{kind:'economy',targetVillagers:6,weights:{food:0,wood:0,gold:100,stone:0}}]);
    const view=sim.view('blue'),state=sim.state.controllers.blue!,workers=view.entities.filter(entity=>entity.typeId==='villager'&&entity.ownerId==='blue');view.self.age=3;view.self.resources={food:200,wood:10000,gold:10000,stone:10000};
    view.entities.push({id:'known_gold',kind:'resource',typeId:'gold_mine',ownerId:null,xMm:78000,zMm:93000,hp:1,maxHp:1,resource:'gold',amount:1000},{id:'known_food',kind:'resource',typeId:'forage_patch',ownerId:null,xMm:78000,zMm:95000,hp:1,maxHp:1,resource:'food',amount:1000});
    for(const worker of workers){worker.order='gather';worker.workTargetId='known_gold';worker.cargo={resource:null,amount:0};state.assignments![worker.id]='food';}
    const actions=desiredGoalCommands(view,state);expect(actions).toMatchObject([{command:{kind:'gather',unitIds:[workers[0]!.id],targetId:'known_food'}}]);expect(workers.slice(1).every(worker=>state.assignments![worker.id]==='gold')).toBe(true);
  });
  it('blocks previously valid lost-base anchors instead of silently redirecting construction',()=>{
    const {sim,home}=fixture();plan(sim,d=>[{kind:'ensure_building',buildingType:'blacksmith',targetCount:1,anchorRef:ref(d,'own_base')},{kind:'develop',targetAge:4,anchorRef:ref(d,'own_base')}]);delete sim.state.entities[home.id];sim.state.navigationRevision++;sim.step();
    expect(execute(sim)).toEqual([]);expect(sim.state.controllers.blue!.plan!.goals.every(goal=>goal.status==='blocked'&&goal.reason==='BASE_RECOVERY_REQUIRED')).toBe(true);
  });
  it('reserves military population against oversized model worker goals without deleting existing villagers',()=>{
    const {sim,unit,structure}=fixture();for(let index=0;index<14;index++)structure('house',30000+index*8000,35000);for(let index=6;index<60;index++)unit('villager',20000+index%10*1500,20000+Math.floor(index/10)*1500);sim.step();
    plan(sim,()=>[{kind:'economy',weights:{food:25,wood:25,gold:25,stone:25},targetVillagers:120},{kind:'ensure_units',unitType:'villager',targetCount:150},{kind:'ensure_units',unitType:'militia',targetCount:8}]);
    const actions=execute(sim);expect(actions.some(action=>action.command.kind==='train'&&action.command.unitType==='villager')).toBe(false);
    expect(actions.some(action=>action.command.kind==='train'&&action.command.unitType==='militia'&&action.receipt.status==='accepted')).toBe(true);
    expect(sim.state.controllers.blue!.plan!.goals.find(goal=>goal.goal.kind==='ensure_units'&&goal.goal.unitType==='villager')).toMatchObject({status:'pending',reason:'MILITARY_POPULATION_RESERVED'});
    expect(Object.values(sim.state.entities).filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager')).toHaveLength(60);
  });
  it('sends an unassigned army toward a remembered enemy Town Center without renewing active paths or stealing held units',()=>{
    const {sim,unit}=fixture();for(let index=0;index<12;index++)unit('militia',110000+index*1000,100000);sim.step();
    const view=sim.view('blue');view.tick=24000;view.entities.push({id:'remembered_base',kind:'building',typeId:'town_center',ownerId:'red',xMm:170000,zMm:100000,hp:2400,maxHp:2400,progress:1,ghost:true,lastSeenTick:22000});
    const army=view.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='militia'),protectedId=army[0]!.id;army[1]!.order='attack_move';army[1]!.taskState='moving';
    const state=createCommanderState(view.matchId,view.playerId);state.mode='model';state.nextScoutTick=50000;
    commanderCommands(view,state,undefined,new Set([protectedId]));
    const attack=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='attack_move'&&command.target.zMm===100000);
    expect(attack).toMatchObject({kind:'attack_move'});if(attack?.kind!=='attack_move')throw new Error('MISSING_CONQUEST_ORDER');expect(attack.target.xMm).toBeLessThan(170000);expect(attack.target.xMm).toBeGreaterThan(150000);expect(attack.unitIds).not.toContain(protectedId);expect(attack.unitIds).not.toContain(army[1]!.id);
  });
  it('trains affordable food-free military despite an empty food bank',()=>{
    const {sim,structure}=fixture();const range=structure('archery_range',110000,80000);sim.step();const view=sim.view('blue');view.self.resources={food:0,wood:500,gold:500,stone:0};
    const memory=emptyCaretakerMemory();view.tick=20;caretakerCommands(view,memory,{targetWorkers:6,desiredUnitType:'archer',armyTarget:8,allowStrategic:false,scoutAllowed:false});
    expect(memory.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'train',buildingId:range.id,unitType:'archer',quantity:1});
  });
  it.each([false,true])('executes its conquest order through ordinary admission and wins after the last enemy Town Center falls (own base lost=%s)',lost=>{
    const {sim,home,unit,structure}=fixture();if(lost)delete sim.state.entities[home.id];for(let index=0;index<(lost?4:10);index++)unit('militia',119000,75000+index*1100);
    for(const entity of Object.values(sim.state.entities))if(entity.ownerId==='red')delete sim.state.entities[entity.id];
    const target=structure('town_center',130000,80000,'red');target.hp=30;sim.state.tick=24000;sim.step(10);
    const state=sim.state.controllers.blue!;state.mode='model';state.nextScoutTick=50000;state.nextStrategicTick=0;commanderCommands(sim.view('blue'),state);
    expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual(expect.objectContaining({kind:'attack_target',targetId:target.id}));
    sim.step(Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz));
    const due=commanderCommands(sim.view('blue'),state).filter(proposal=>proposal.command.kind==='attack_target');expect(due).toHaveLength(1);
    expect(send(sim,due[0]!.command).status).toBe('accepted');const hp=target.hp;
    for(let tick=0;tick<240&&sim.state.status!=='FINISHED';tick++)sim.step();expect(target.hp).toBeLessThan(hp);expect(sim.state.status).toBe('FINISHED');expect(sim.state.result?.winnerTeamId).toBe('allies');
  });
  it('keeps a lone surviving soldier out of an autonomous fortress assault after losing its base',()=>{
    const {sim,home,unit}=fixture();delete sim.state.entities[home.id];unit('militia',110000,100000);sim.step();
    const view=sim.view('blue');view.tick=24000;view.entities.push({id:'remembered_fortress',kind:'building',typeId:'fortress',ownerId:'red',xMm:170000,zMm:100000,hp:3000,maxHp:3000,progress:1,ghost:true,lastSeenTick:22000});
    const state=createCommanderState(view.matchId,view.playerId);commanderCommands(view,state);
    expect(state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='attack_move'||command.kind==='attack_target')).toEqual([]);
  });
  it('constructs and completes a paid defensive screen segment while retaining its broad bypasses',()=>{
    const {sim,home,unit}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.ownerId==='blue'&&entity.kind==='building'&&entity.id!==home.id)delete sim.state.entities[entity.id];
    for(const x of [60000,80000,100000])for(const z of [60000,80000,100000])unit('scout',x,z);sim.state.navigationRevision++;sim.step();
    const goal={kind:'fortify' as const,anchorRef:home.id,material:'palisade' as const,radiusM:18},memory:FortifyMemory={goalKey:`blue:${home.id}:palisade:18`};
    expect(resolveFortifyScreen(sim.view('blue'),goal,memory,{remaining:100000,used:0}).status).toBe('ready');
    sim.state.economies.blue!.resources.wood=buildings.palisade_wall.cost.wood*balance.rules.resourceScale;
    const proposal=fortifyCommands(sim.view('blue'),goal,memory).commands[0]!;expect(proposal).toMatchObject({kind:'build_wall',cells:[expect.any(Object)]});
    expect(send(sim,proposal).status).toBe('accepted');markFortifyQueued(memory,proposal,sim.state.tick);expect(sim.state.economies.blue!.resources.wood).toBe(0);
    const wall=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall')!;
    for(let tick=0;tick<900&&wall.work<wall.required;tick++)sim.step();expect(wall.work).toBe(wall.required);
    expect(resolveFortifyScreen(sim.view('blue'),goal,memory,{remaining:100000,used:0}).status).toBe('ready');
  });
});

describe('complete model-directed development',()=>{
  it('constructs missing market and research prerequisites before progressing toward Empire Age',()=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;
    plan(sim,d=>[{kind:'develop',anchorRef:ref(d,'own_base'),targetAge:4}]);
    const before=sim.state.economies.blue!.resources.wood,first=execute(sim);expect(first).toHaveLength(1);expect(first[0]).toMatchObject({command:{kind:'build',buildingType:'market'},receipt:{status:'accepted'}});expect(sim.state.economies.blue!.resources.wood).toBe(before-buildings.market.cost.wood*1000);
    expect(execute(sim)).toEqual([]);expect(validateCommanderMemory(sim.state.controllers.blue,'blue',sim.state.tick)).toBe(true);
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.state.controllers.blue!.plan).toEqual(sim.state.controllers.blue!.plan);
  });
  it('finishes all four ages, ordinary infrastructure and every upgrade through ordinary paid work',()=>{
    const initial=fixture();initial.sim.state.economies.blue!.age=1;initial.sim.state.economies.blue!.resources={food:50000000,wood:50000000,gold:50000000,stone:50000000};
    // Initial capital and an explored fixture are the only allowances. Every new
    // foundation, completed building, age and technology below uses real commands.
    for(let z=40000;z<=120000;z+=20000)for(let x=40000;x<=120000;x+=20000)initial.unit('scout',x,z);initial.sim.step();
    const sim=new Simulation({...initial.sim.options,authoritativeIntervalMs:300},initial.sim.capture());
    const renew=()=>plan(sim,d=>[{kind:'develop',anchorRef:ref(d,'own_base'),targetAge:4}]);renew();
    const actions:GameplayCommand[]=[];
    for(let frame=0;frame<5000;frame++){
      if(frame&&frame%100===0)renew();
      if(frame%4===0){const accepted=execute(sim);for(const action of accepted){expect(action.receipt.status,JSON.stringify(action)).toBe('accepted');actions.push(action.command);}}
      if(sim.state.controllers.blue!.plan!.goals[0]!.status==='fulfilled')break;
      sim.advanceFrame();
    }
    expect(sim.state.economies.blue!.age).toBe(4);expect(new Set(sim.state.economies.blue!.technologies)).toEqual(new Set(balance.technologies.map(technology=>technology.id)));
    for(const definition of developmentBuildings)expect(Object.values(sim.state.entities).some(entity=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId===definition.id&&entity.work>=entity.required),definition.id).toBe(true);
    expect(actions.filter(action=>action.kind==='advance_age').map(action=>action.targetAge)).toEqual([2,3,4]);expect(actions.filter(action=>action.kind==='research')).toHaveLength(balance.technologies.length);expect(sim.state.controllers.blue!.plan!.goals[0]!.status).toBe('fulfilled');
  },60000);
  it('gives a smaller missing building a paid placement turn after a larger site cannot fit',()=>{
    const {sim,home,barracks,structure,workers,unit}=fixture();delete sim.state.entities[barracks.id];
    for(const [index,definition]of developmentBuildings.entries())if(!['barracks','blacksmith'].includes(definition.id)&&!Object.values(sim.state.entities).some(entity=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId===definition.id))structure(definition.id,160000+index%4*16000,140000+Math.floor(index/4)*16000);
    sim.state.economies.blue!.technologies=balance.technologies.filter(technology=>!technology.id.startsWith('forging_')).map(technology=>technology.id);
    // Walkable slopes leave exactly one flat 6x6m site in the bounded search.
    // A barracks needs 8x8m; the blacksmith fits without relaxing any clearance.
    const plot={xMm:112000,zMm:84000,widthMm:6000,depthMm:6000},width=sim.state.widthMm,height=sim.state.heightMm;
    sim.state.map.terrain=[{id:'slope_west',kind:'hill',xMm:0,zMm:0,widthMm:plot.xMm,depthMm:height,elevationMm:1000},{id:'slope_east',kind:'hill',xMm:plot.xMm+plot.widthMm,zMm:0,widthMm:width-plot.xMm-plot.widthMm,depthMm:height,elevationMm:1000},{id:'slope_north',kind:'hill',xMm:plot.xMm,zMm:0,widthMm:plot.widthMm,depthMm:plot.zMm,elevationMm:1000},{id:'slope_south',kind:'hill',xMm:plot.xMm,zMm:plot.zMm+plot.depthMm,widthMm:plot.widthMm,depthMm:height-plot.zMm-plot.depthMm,elevationMm:1000}];
    workers[0]!.xMm=112000;workers[0]!.zMm=92000;unit('scout',108000,84000);unit('scout',122000,90000);sim.state.navigationRevision++;sim.step();
    const observed=sim.view('blue'),eligible=observed.entities.filter(entity=>entity.typeId==='villager'&&entity.ownerId==='blue');
    expect(buildingCommand(observed,'barracks',home,eligible)).toBeUndefined();expect(buildingCommand(observed,'blacksmith',home,eligible)).toMatchObject({kind:'build',buildingType:'blacksmith',originCell:{x:56,z:42}});
    const renew=()=>plan(sim,d=>[{kind:'develop',anchorRef:ref(d,'own_base'),targetAge:4}]);renew();const bank=sim.state.economies.blue!.resources.wood,placement=vi.spyOn(caretakerPolicy,'buildingCommand');
    try{
      expect(execute(sim)).toEqual([]);expect(placement.mock.calls.map(call=>call[1])).toEqual(['barracks']);expect(sim.state.economies.blue!.resources.wood).toBe(bank);expect(sim.state.controllers.blue!.plan!.goals[0]!.candidateIndex).toBe(1);
      renew();placement.mockClear();sim.step(balance.rules.simulationHz);const purchased=execute(sim);
      expect(placement.mock.calls.map(call=>call[1])).toEqual(['blacksmith']);expect(purchased).toMatchObject([{command:{kind:'build',buildingType:'blacksmith'},receipt:{status:'accepted'}}]);expect(sim.state.economies.blue!.resources.wood).toBe(bank-buildings.blacksmith.cost.wood*balance.rules.resourceScale);
      expect(Object.values(sim.state.entities).filter(entity=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='blacksmith')).toHaveLength(1);
    }finally{placement.mockRestore();}
  });
  it('builds an absent military producer instead of permanently waiting for it',()=>{
    const {sim}=fixture();plan(sim,()=>[{kind:'ensure_units',unitType:'catapult',targetCount:1}]);const first=execute(sim);
    expect(first).toMatchObject([{command:{kind:'build',buildingType:'siege_workshop'},receipt:{status:'accepted'}}]);
    expect(execute(sim)).toEqual([]);
  });
  it('buys a requested final upgrade through its preceding technology levels exactly once',()=>{
    const {sim}=fixture();const renew=()=>plan(sim,()=>[{kind:'research',technologyId:'forestry_3'}]);renew();const purchases:string[]=[];
    for(let seconds=0;seconds<300;seconds++){if(seconds&&seconds%30===0)renew();for(const action of execute(sim)){expect(action.receipt.status).toBe('accepted');if(action.command.kind==='research')purchases.push(action.command.technologyId);}if(sim.state.economies.blue!.technologies.includes('forestry_3'))break;sim.step(balance.rules.simulationHz);}
    expect(purchases).toEqual(['forestry_1','forestry_2','forestry_3']);expect(sim.state.economies.blue!.technologies).toEqual(expect.arrayContaining(purchases));
  });
  it('creates the missing research building without charging the final upgrade early',()=>{
    const {sim}=fixture();plan(sim,()=>[{kind:'research',technologyId:'masonry'}]);const first=execute(sim);expect(first).toMatchObject([{command:{kind:'build',buildingType:'university'},receipt:{status:'accepted'}}]);expect(sim.state.economies.blue!.technologies).not.toContain('masonry');
  });
  it('honors manually reserved workers and research buildings during full development',()=>{
    const {sim,workers,lumber}=fixture();sim.state.economies.blue!.age=2;plan(sim,d=>[{kind:'develop',anchorRef:ref(d,'own_base'),targetAge:4}]);
    expect(desiredGoalCommands(sim.view('blue'),sim.state.controllers.blue!,undefined,new Set(workers.map(worker=>worker.id)))).toEqual([]);
    sim.state.economies.blue!.age=4;plan(sim,()=>[{kind:'research',technologyId:'forestry_3'}]);expect(desiredGoalCommands(sim.view('blue'),sim.state.controllers.blue!,undefined,new Set([lumber.id]))).toEqual([]);expect(sim.state.controllers.blue!.plan!.goals[0]!.reason).toBe('MANUAL_CONTROL');
  });
  it('keeps paid gate approaches after goal expiry and releases fully destroyed layouts',()=>{
    const {sim,home}=fixture(),view=sim.view('blue'),state=createCommanderState(view.matchId,view.playerId);state.mode='model';
    const cells:Array<{x:number;z:number}>=[];for(let x=31;x<49;x++)cells.push({x,z:31});for(let z=31;z<49;z++)cells.push({x:49,z});for(let x=49;x>31;x--)cells.push({x,z:49});for(let z=49;z>31;z--)cells.push({x:31,z});
    const gates=[{originCell:{x:39,z:31},rotation:0 as const},{originCell:{x:39,z:49},rotation:0 as const},{originCell:{x:31,z:39},rotation:90 as const},{originCell:{x:49,z:39},rotation:90 as const}],layout={cells,gates,origin:{xMm:home.xMm,zMm:home.zMm},signature:fortifyLayoutSignature(cells,gates)};expect(validFortifyLayout(layout)).toBe(true);
    state.fortifications.expired={layout,layoutCommitted:true};expect(aiFortifyPlacementCells(view,state)).toEqual([]);
    const gate:ViewEntity={id:'paid_gate',kind:'building',typeId:'wooden_gate',ownerId:'blue',xMm:81000,zMm:63000,rotation:0,hp:1,maxHp:buildings.wooden_gate.maxHp,progress:.1};view.entities.push(gate);expect(aiFortifyPlacementCells(view,state)).toContainEqual({x:39,z:33});
    gate.ownerId='red';expect(aiFortifyPlacementCells(view,state)).toEqual([]);gate.ownerId='blue';view.entities.pop();expect(aiFortifyPlacementCells(view,state)).toEqual([]);
  });
});

describe('scoped controller decision inputs',()=>{
  it('matches every authorized view field while reusing private static observations across current fog and actor changes',()=>{
    const {sim,workers,scout,home,structure}=fixture();
    const tree:ResourceNode={id:'decision_tree',kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:250000,xMm:workers[0]!.xMm+1000,zMm:workers[0]!.zMm+2000,hp:1,maxHp:1,forest:{patchId:'decision_forest',cellMm:2000}};
    const hidden:ResourceNode={...tree,id:'decision_hidden',xMm:240000,zMm:100000};
    sim.state.entities[tree.id]=tree;sim.state.entities[hidden.id]=hidden;sim.state.navigationRevision++;sim.step();
    sim.state.vision.blue!.memory[hidden.id]={id:hidden.id,kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:100,xMm:hidden.xMm,zMm:hidden.zMm,hp:1,maxHp:1,forest:{...hidden.forest!},lastSeenTick:0};
    // Exercise the private owner-only reader directly; these controlled changes
    // below use the same roster invalidation and memory refresh as game writes.
    const internals=sim as unknown as {liveOwned:boolean;controllerView(playerId:string):PlayerView;invalidateEntityRoster(staticChanged?:boolean):void;updateVision():void;controllerProfiler?:{observation(view:PlayerView):void}};
    internals.liveOwned=true;
    const read=()=>{const before=sim.capture(),actual=internals.controllerView('blue');expect(actual).toEqual(sim.view('blue'));expect(sim.capture()).toEqual(before);return actual;};
    const first=read(),second=read();
    expect(first.entities.find(entity=>entity.id===tree.id)).toBe(second.entities.find(entity=>entity.id===tree.id));
    expect(first.entities.find(entity=>entity.id===hidden.id)).toBe(second.entities.find(entity=>entity.id===hidden.id));
    expect(first.map).toBe(second.map);expect(first.fog.visible).toBe(second.fog.visible);expect(first.fog.explored).toBe(second.fog.explored);
    expect(first.entities.find(entity=>entity.id===hidden.id)).toMatchObject({ghost:true,amount:100});
    tree.amount=125000;hidden.amount=0;const depleted=read();
    expect(depleted.entities.find(entity=>entity.id===tree.id)).toMatchObject({amount:125});
    expect(first.entities.find(entity=>entity.id===tree.id)).toMatchObject({amount:250});
    expect(depleted.entities.find(entity=>entity.id===hidden.id)).toMatchObject({ghost:true,amount:100});
    // A positive sub-unit remainder still has collision and must never publish
    // zero. Exercise both private live-resource reuse and ordinary projection.
    tree.amount=1;internals.updateVision();expect(read().entities.find(entity=>entity.id===tree.id)).toMatchObject({amount:1});
    expect(sim.state.vision.blue!.memory[tree.id]).toMatchObject({amount:1});
    expect(depleted.entities.find(entity=>entity.id===tree.id)).toMatchObject({amount:125});
    tree.amount=0;sim.state.navigationRevision++;internals.updateVision();expect(read().entities.find(entity=>entity.id===tree.id)).toMatchObject({amount:0});
    expect(sim.state.vision.blue!.memory[tree.id]).toMatchObject({amount:0});
    tree.amount=125000;sim.state.navigationRevision++;internals.updateVision();
    workers[0]!.garrisonedIn=home.id;home.garrisoned=[workers[0]!.id];home.queue=[{id:'decision_train',kind:'train',typeId:'villager',originalCost:{food:50,wood:0,gold:0,stone:0},work:1,required:20,reserved:true,started:true,state:'active'}];
    expect(read().entities.find(entity=>entity.id===workers[0]!.id)?.garrisonedIn).toBe(home.id);
    const added=structure('house',115000,90000);internals.invalidateEntityRoster(true);
    expect(read().entities.some(entity=>entity.id===added.id)).toBe(true);
    scout.xMm=hidden.xMm-1000;scout.zMm=hidden.zMm;internals.updateVision();
    expect(read().entities.find(entity=>entity.id===hidden.id)).toMatchObject({amount:0});
    expect(read().entities.find(entity=>entity.id===hidden.id)?.ghost).toBeUndefined();
    scout.xMm=92000;scout.zMm=94000;internals.updateVision();
    const concealed=read();expect(concealed.entities.find(entity=>entity.id===hidden.id)).toMatchObject({ghost:true,amount:0});
    hidden.amount=500000;expect(read().entities.find(entity=>entity.id===hidden.id)).toMatchObject({ghost:true,amount:0});
    const publicCopy=sim.view('blue');publicCopy.entities.find(entity=>entity.id===tree.id)!.amount=999;publicCopy.fog.visible.length=0;publicCopy.map.terrain!.length=0;
    expect(read().entities.find(entity=>entity.id===tree.id)?.amount).toBe(125);
    // External observation hooks receive fully detached values, not the private
    // policy's retained copies. A custom public reader still runs unchanged.
    internals.controllerProfiler={observation:()=>{}};const diagnostic=internals.controllerView('blue');
    expect(diagnostic.map).not.toBe(concealed.map);expect(diagnostic.fog.visible).not.toBe(concealed.fog.visible);
    delete internals.controllerProfiler;internals.liveOwned=false;
  });

  it('preserves live-factory commander commands, journal and complete state against the public reference',async()=>{
    const {sim,workers}=fixture();
    for(let index=0;index<32;index++){const tree:ResourceNode={id:`memory_low_${index}`,kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:0,xMm:workers[0]!.xMm+index*20,zMm:workers[0]!.zMm+200,hp:1,maxHp:1};sim.state.entities[tree.id]=tree;}
    sim.state.navigationRevision++;sim.step();
    const options={...sim.options,controllers:true,authoritativeIntervalMs:300 as const},payload=sim.capture();
    const scalar=new Simulation(options,payload),live=createLiveSimulation(options,payload);
    let commands=0;
    for(let frame=0;frame<8;frame++){
      scalar.advanceFrame();live.advanceFrame();await scalar.synchronizeCapture();await live.synchronizeCapture();
      expect(live.capture()).toEqual(scalar.capture());
      expect(live.journalEvents()).toEqual(scalar.journalEvents());
      for(const faction of sim.state.factions)expect(live.view(faction.id)).toEqual(scalar.view(faction.id));
      commands+=scalar.state.commandLog.length;
    }
    expect(commands).toBeGreaterThan(0);expect(live.state.controllers.blue!.sequence).toBeGreaterThan(0);
    expect(live.state.controllers.blue!.memory.facts.some(fact=>fact.kind==='resource_warning')).toBe(true);
  });

  it('preserves proposals and complete commander memory against uncached policy across ages, difficulty, expiry and protected work',()=>{
    const {sim,workers}=fixture();plan(sim,()=>[{kind:'economy',targetVillagers:12,weights:{food:50,wood:30,gold:15,stone:5}},{kind:'ensure_units',unitType:'militia',targetCount:4}]);
    const original=sim.view('blue'),memory=structuredClone(sim.state.controllers.blue!),protectedIds=new Set([workers[0]!.id]);
    for(let index=0;index<600;index++)original.entities.push({id:`context_tree_${index}`,kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:120000+(index%30)*2500,zMm:30000+Math.floor(index/30)*2500,hp:1,maxHp:1,amount:250,forest:{patchId:'context_forest',cellMm:2500}});
    for(const difficulty of ['easy','medium','hard'] as const)for(const age of [1,2,3,4] as const)for(const tick of [20,21,40]){
      const view=structuredClone(original);view.tick=tick;view.authoritativeIntervalMs=300;view.players[0]!.difficulty=difficulty;view.self.age=age;view.self.resources={food:age===1?2:800,wood:age===2?2:800,gold:age===3?2:800,stone:200};
      const actual=structuredClone(memory),expected=structuredClone(memory);for(const state of [actual,expected]){state.nextStrategicTick=0;state.nextScoutTick=0;if(tick===40){state.plan!.expiresTick=40;for(const goal of state.plan!.goals)goal.expiresTick=40;}}
      const before=JSON.stringify(view),scope=new AiDecisionContext(view);
      const commands=commanderCommands(view,actual,undefined,protectedIds,scope),reference=commanderCommands(view,expected,undefined,protectedIds);scope.close();
      expect(JSON.stringify(commands)).toBe(JSON.stringify(reference));expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));expect(JSON.stringify(view)).toBe(before);
      expect(scope.roster(view)).toBeUndefined();expect(scope.navigation(view)).toBeUndefined();
    }
  });
  it('shares one geometry root for explicit nongeometric overlays but preserves independent probe work and exhaustion',()=>{
    const {sim}=fixture(),view=sim.view('blue'),scope=new AiDecisionContext(view),geometry=scope.navigation(view)!;
    const overlay={...view,entities:view.entities.map(entity=>entity.ownerId===view.playerId&&entity.kind==='unit'?{...entity,order:'move' as const}:entity)};
    scope.inherit(view,overlay);expect(scope.navigation(overlay)).toBe(geometry);expect(scope.roster(overlay)).not.toBe(scope.roster(view));
    expect(geometry.obstacles).toEqual(knownNavigation(view).obstacles);
    for(const limit of [3,100,8000]){
      const budget={remaining:limit,used:0},referenceBudget={remaining:limit,used:0},query=scope.query(overlay,geometry,512,budget)!,reference=new Navigation(view.map.widthMm,view.map.heightMm,geometry.obstacles,512,1000,referenceBudget);
      const apply=(nav:Navigation)=>{try{return {line:nav.clearLine({xMm:70000,zMm:80000},{xMm:90000,zMm:80000},350),path:nav.path({xMm:70000,zMm:80000},{xMm:90000,zMm:80000},350)};}catch(error){if(error instanceof PathBudgetExceededError)return 'exhausted';throw error;}};
      expect(apply(query)).toEqual(apply(reference));expect(budget).toEqual(referenceBudget);
      const nextBudget={remaining:limit,used:0},next=scope.query(view,geometry,512,nextBudget)!;expect(next.workBudget).not.toBe(query.workBudget);expect(nextBudget).toEqual({remaining:limit,used:0});
    }
    const scout=view.entities.find(entity=>entity.typeId==='scout')!,before=JSON.stringify(view);
    expect(scoutDestination(view,scout,[],geometry,0,undefined,scope)).toEqual(scoutDestination(view,scout,[],knownNavigation(view),0));expect(JSON.stringify(view)).toBe(before);
    const unrelated=structuredClone(view);expect(scope.navigation(unrelated)).toBeUndefined();scope.close();expect(scope.query(view,geometry,512,{remaining:8000,used:0})).toBeUndefined();
  });
  it('rebuilds geometry in the next decision and retains duplicate observation occurrences',()=>{
    const {sim}=fixture(),view=sim.view('blue'),resource:ViewEntity={id:'duplicate_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:140000,zMm:140000,hp:1,maxHp:1,amount:250};view.entities.push(resource,resource,{...resource});
    const first=new AiDecisionContext(view),roster=first.roster(view)!;expect(roster.resources.filter(entity=>entity.id===resource.id)).toHaveLength(3);expect(roster.resources.at(-3)).toBe(roster.resources.at(-2));expect(roster.resources.at(-1)).not.toBe(resource);
    const geometry=first.navigation(view)!;first.close();resource.amount=0;
    const next=new AiDecisionContext(view);expect(next.roster(view)!.resources.filter(entity=>entity.id===resource.id)).toHaveLength(1);expect(next.navigation(view)).not.toBe(geometry);expect(next.navigation(view)!.obstacles).toEqual(knownNavigation(view).obstacles);next.close();
  });
});

describe('compatible strategic renewal',()=>{
  it.each(['schema','observation'] as const)('retains an authorized unexpired plan after an invalid %s renewal without extending its lifetime',category=>{
    const {sim}=fixture();plan(sim,()=>[{kind:'economy',targetVillagers:12,weights:{food:50,wood:30,gold:15,stone:5}}]);
    const state=sim.state.controllers.blue!,before=structuredClone(state.plan),refs=structuredClone(state.planReferences),pending=structuredClone(state.pending);
    const dispatch=sim.prepareAiRequest('blue','invalid_replacement');
    const invalid=category==='schema'?{private_schema_field:'private model text'}:{schemaVersion:1,observationId:'private_observation_id',strategy:'private model text',goals:[],message:null};
    const result=sim.completeAiRequest(dispatch.binding,{kind:'plan',plan:invalid});
    expect(result).toMatchObject({accepted:false,code:'INVALID_AI_PLAN',diagnosticCode:category==='schema'?'AI_PLAN_SCHEMA_INVALID':'AI_PLAN_OBSERVATION_MISMATCH'});
    expect(JSON.stringify(result)).not.toContain('private');
    expect(state.mode).toBe('model');expect(state.reason).toBe('INVALID_REPLACEMENT_RETAINED');expect(state.plan).toEqual(before);expect(state.planReferences).toEqual(refs);expect(state.pending).toEqual(pending);expect(state.activeRequest).toBeUndefined();
  });
  it.each(['expired','revoked'] as const)('does not restore a %s old plan after an invalid renewal',condition=>{
    const {sim}=fixture();plan(sim,()=>[{kind:'economy',targetVillagers:12,weights:{food:50,wood:30,gold:15,stone:5}}]);
    const state=sim.state.controllers.blue!;if(condition==='expired')state.plan!.expiresTick=sim.state.tick;else state.mode='fallback';
    const dispatch=sim.prepareAiRequest('blue',`invalid_${condition}`);sim.completeAiRequest(dispatch.binding,{kind:'plan',plan:null});
    expect(state.mode).toBe('fallback');expect(state.reason).toBe('INVALID_AI_PLAN');
  });
  it('preserves the original reaction deadline and one unpaid purchase through repeated compatible plans and cold restore',()=>{
    const {sim,barracks}=fixture();const goal={kind:'ensure_units' as const,unitType:'militia' as const,targetCount:1};plan(sim,()=>[goal]);const memory=sim.state.controllers.blue!,key=memory.plan!.goals[0]!.key;
    const delayed={observedTick:sim.state.tick,executeTick:sim.state.tick+40,commands:[{kind:'train' as const,buildingId:barracks.id,unitType:'militia' as const,quantity:1}],goalKey:key,planGeneration:memory.planGeneration};memory.pending=[structuredClone(delayed)];
    for(let index=0;index<3;index++){plan(sim,()=>[goal]);expect(memory.pending).toEqual([{...delayed,planGeneration:memory.planGeneration}]);}
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.state.controllers.blue!.pending).toEqual(memory.pending);
    sim.options.controllers=true;restored.options.controllers=true;const before=sim.state.economies.blue!.resources.food;sim.step(40);restored.step(40);expect(restored.capture()).toEqual(sim.capture());
    const purchases=sim.state.commandLog.filter(item=>item.envelope.command.kind==='train'&&item.envelope.command.unitType==='militia');expect(purchases).toHaveLength(1);expect(purchases[0]!.tick).toBe(delayed.executeTick);expect(sim.state.economies.blue!.resources.food).toBeLessThanOrEqual(before-units.militia.cost.food*balance.rules.resourceScale);
  });
  it.each(['goal','target','expiry','generation','removal'] as const)('discards an unpaid proposal after incompatible %s changes',change=>{
    const {sim,workers,home,barracks}=fixture();let anchor='';plan(sim,d=>{anchor=ref(d,'own_base');return [{kind:'ensure_building',buildingType:'house',targetCount:20,anchorRef:anchor}];});const memory=sim.state.controllers.blue!,key=memory.plan!.goals[0]!.key;
    memory.pending=[{observedTick:sim.state.tick,executeTick:sim.state.tick+40,commands:[{kind:'build',buildingType:'house',builderIds:[workers[0]!.id],originCell:{x:20,z:20},rotation:0,queued:false}],goalKey:key,planGeneration:memory.planGeneration}];
    if(change==='expiry')memory.plan!.goals[0]!.expiresTick=sim.state.tick;
    if(change==='generation')memory.pending[0]!.planGeneration=0;
    const d=sim.prepareAiRequest('blue','incompatible_renewal');if(change==='target'){const actual=memory.activeRequest!.references[anchor]!;expect(actual.kind).toBe('own_base');Object.assign(actual,{entityId:barracks.id,position:{xMm:barracks.xMm,zMm:barracks.zMm}});expect(home.id).not.toBe(barracks.id);}
    const response=sim.completeAiRequest(d.binding,{kind:'plan',plan:{schemaVersion:1,observationId:d.binding.observationId,strategy:'Renew',goals:change==='removal'?[]:[{kind:'ensure_building',buildingType:'house',targetCount:change==='goal'?21:20,anchorRef:anchor}],message:null}});
    expect(response.accepted).toBe(true);expect(memory.pending).toEqual([]);
  });
});

describe('lazy Hard tactical geometry',()=>{
  const body=(id:string,typeId:UnitId,xMm:number,zMm:number,ownerId='blue',order:ViewEntity['order']='idle'):ViewEntity=>({id,kind:'unit',typeId,ownerId,xMm,zMm,hp:units[typeId].maxHp,maxHp:units[typeId].maxHp,order});
  function observation(actors:ViewEntity[]=[]){
    const view:PlayerView={protocolVersion:2,contentHash,matchId:'lazy_tactical_geometry',matchEpoch:1,tick:20,sequence:0,playerId:'blue',status:'RUNNING',map:{widthMm:256000,heightMm:256000,fogCellMm:2000,terrain:[]},self:{populationLimit:120,lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:4,population:actors.filter(actor=>actor.ownerId==='blue').length,populationCap:120,reservedPopulation:0,autoReseed:true},players:[{id:'blue',name:'Blue',teamId:'blue',kind:'ai',difficulty:'hard',personality:'marshal',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ff8844'}],entities:[{id:'home',kind:'building',typeId:'town_center',ownerId:'blue',xMm:64000,zMm:64000,hp:buildings.town_center.maxHp,maxHp:buildings.town_center.maxHp,rotation:0,progress:1,queue:[]},...actors],fog:{visible:[],explored:[]}};
    const probe:ViewEntity={id:'known_geometry_probe',kind:'resource',typeId:'tree',ownerId:null,xMm:220000,zMm:220000,hp:1,maxHp:1,resource:'wood',amount:1000};let reads=0;
    // No workers/build placement exist in these observations. Reading this
    // distant resource's coordinate therefore certifies actual geometry creation.
    Object.defineProperty(probe,'xMm',{enumerable:true,configurable:true,get:()=>{reads++;return 220000;}});view.entities.push(probe);
    const state=createCommanderState(view.matchId,view.playerId);state.nextStrategicTick=100000;state.nextScoutTick=100000;
    return {view,state,reads:()=>reads,reset:()=>{reads=0;}};
  }
  it.each(['no bodies','busy scout','scout cooldown','reserved scout','distant ranged target'] as const)('keeps due-command order and exact state without preparing unused geometry: %s',scenario=>{
    const scout=body('scout','scout',120000,120000),archer=body('archer','archer',120000,120000,'blue','move'),enemy=body('distant_enemy','militia',180000,180000,'red');
    const actors=scenario==='no bodies'?[]:scenario==='distant ranged target'?[archer,enemy]:[scout],f=observation(actors);
    if(scenario==='busy scout'){scout.order='move';scout.taskState='moving';f.state.nextScoutTick=0;}
    if(scenario==='reserved scout')f.state.nextScoutTick=0;
    const first:GameplayCommand={kind:'set_auto_reseed',enabled:true},second:GameplayCommand={kind:'stop',unitIds:['already_paid_order']},future={observedTick:1,executeTick:100,commands:[{kind:'move' as const,unitIds:[scenario==='reserved scout'?scout.id:'future_order'],target:{xMm:124000,zMm:120000},queued:false}]};
    f.state.pending=[{observedTick:0,executeTick:20,commands:[first]},{observedTick:0,executeTick:19,commands:[second]},future];
    const expected=structuredClone(f.state),before=structuredClone(f.view);expected.pending=[structuredClone(future)];
    if(scenario==='reserved scout')expected.nextScoutTick=f.view.tick+balance.ai.rulePolicies.hard.scoutIntervalSeconds*balance.rules.simulationHz;
    if(scenario==='distant ranged target')expected.seenEnemies[enemy.id]={firstSeenTick:20,lastSeenTick:20,typeId:enemy.typeId};
    // A busy scout still consumes the existing scout cadence; no policy changes.
    if(scenario==='busy scout')expected.nextScoutTick=f.view.tick+balance.ai.rulePolicies.hard.scoutIntervalSeconds*balance.rules.simulationHz;
    f.reset();const clear=vi.spyOn(Navigation.prototype,'clearLine');
    try{expect(commanderCommands(f.view,f.state)).toEqual([{command:first},{command:second}]);expect(f.reads()).toBe(0);expect(clear).not.toHaveBeenCalled();expect(JSON.stringify(f.state)).toBe(JSON.stringify(expected));expect(f.view).toEqual(before);}
    finally{clear.mockRestore();}
  });
  it('shares one geometry across ordered kites and a flank, retaining delayed admission and input ownership',()=>{
    const archers=[body('archer_a','archer',120000,120000,'blue','move'),body('archer_b','archer',120000,121000,'blue','move')],raider=body('raider','knight',160000,130000),enemy=body('melee_enemy','militia',122000,120000,'red'),worker=body('enemy_worker','villager',160000,120000,'red');enemy.hp=1;
    const f=observation([...archers,raider,enemy,worker]),before=structuredClone(f.view),original=Navigation.prototype.clearLine,queries:{navigation:Navigation;from:Position;to:Position;radius:number}[]=[];
    const clear=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,from,to,radius,ignored){if(this.maxSearchNodes===2048)queries.push({navigation:this,from:{xMm:from.xMm,zMm:from.zMm},to:{...to},radius});return original.call(this,from,to,radius,ignored);});
    const expected:GameplayCommand[]=[{kind:'move',unitIds:['archer_a'],target:{xMm:117000,zMm:120000},queued:false},{kind:'move',unitIds:['archer_b'],target:{xMm:117317,zMm:122342},queued:false},{kind:'attack_move',unitIds:['raider'],target:{xMm:166000,zMm:120000},queued:false}];
    try{
      f.reset();expect(commanderCommands(f.view,f.state)).toEqual([]);expect(f.reads()).toBe(1);expect(queries.map(({from,to,radius})=>({from,to,radius}))).toEqual(expected.map((command,index)=>({from:{xMm:[...archers,raider][index]!.xMm,zMm:[...archers,raider][index]!.zMm},to:'target'in command?command.target:undefined,radius:units[index<2?'archer':'knight'].collisionRadiusM*1000})));
      expect(new Set(queries.map(query=>query.navigation)).size).toBe(1);const firstNavigation=queries[0]!.navigation;expect(f.state.pending).toEqual(expected.map(command=>({observedTick:20,executeTick:20+Math.ceil(balance.ai.difficulty.hard.reactionDelaySeconds*balance.rules.simulationHz),commands:[command]})));expect(f.view).toEqual(before);
      // Hard's reaction delay is also one tactical interval. The existing
      // policy probes ranged retreat geometry before rejecting reserved orders.
      f.view.tick=f.state.pending[0]!.executeTick;const dueBefore=structuredClone(f.view);queries.length=0;f.reset();expect(commanderCommands(f.view,f.state)).toEqual(expected.map(command=>({command})));expect(f.state.pending).toEqual([]);expect(f.reads()).toBe(1);expect(queries.map(query=>query.to)).toEqual(expected.slice(0,2).map(command=>'target'in command?command.target:undefined));expect(new Set(queries.map(query=>query.navigation)).size).toBe(1);expect(queries[0]!.navigation).not.toBe(firstNavigation);expect(f.view).toEqual(dueBefore);
      // The next decision owns fresh geometry, never a stale cache across calls.
      f.view.tick=40;queries.length=0;f.reset();commanderCommands(f.view,f.state);expect(f.reads()).toBe(1);expect(new Set(queries.map(query=>query.navigation)).size).toBe(1);expect(queries[0]!.navigation).not.toBe(firstNavigation);
    }finally{clear.mockRestore();}
  });
  it('keeps the first legal unexplored scout direction and original bounded query allowance',()=>{
    const scout=body('scout','scout',120000,120000),f=observation([scout]);f.state.nextScoutTick=0;
    const before=structuredClone(f.view),original=Navigation.prototype.clearLine,queries:{from:Position;to:Position;radius:number;limit:number;allowance:number|undefined}[]=[];
    const clear=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,from,to,radius,ignored){queries.push({from:{xMm:from.xMm,zMm:from.zMm},to:{...to},radius,limit:this.maxSearchNodes,allowance:this.workBudget?.remaining});return original.call(this,from,to,radius,ignored);});
    try{
      f.reset();expect(commanderCommands(f.view,f.state)).toEqual([]);expect(f.reads()).toBe(1);expect(queries).toEqual([{from:{xMm:120000,zMm:120000},to:{xMm:92000,zMm:120000},radius:units.scout.collisionRadiusM*1000,limit:512,allowance:8000}]);
      expect(f.state.pending).toEqual([{observedTick:20,executeTick:20+Math.ceil(balance.ai.difficulty.hard.reactionDelaySeconds*balance.rules.simulationHz),commands:[{kind:'move',unitIds:['scout'],target:{xMm:92000,zMm:120000},queued:false}]}]);expect(f.state.scoutIndex).toBe(1);expect(f.view).toEqual(before);
    }finally{clear.mockRestore();}
  });
});

describe('synchronous controller view geometry',()=>{
  interface ViewInternals {
    controllerViewFrame?:{current?:{world:readonly Entity[];geometry:unknown};verify?:boolean};
    all():Entity[];visible(playerId:string,entity:Position):boolean;
    asView(entity:Entity,own:boolean,playerId:string):ViewEntity;
    viewFromRoster(playerId:string,world:readonly Entity[],geometry?:unknown):PlayerView;
    updateVision():void;advanceCommander(playerId:string):void;
    apply(playerId:string,command:GameplayCommand):string|undefined;
    addBuilding(ownerId:string,typeId:BuildingId,position:Position,rotation:Building['rotation'],completed?:boolean):Building;
  }
  const internals=(sim:Simulation)=>sim as unknown as ViewInternals;
  function setup(sharedVision=false){
    const f=fixture(),{sim}=f;sim.options.controllers=true;sim.options.sharedVision=sharedVision;
    Object.assign(sim.state.factions.find(faction=>faction.id==='blue')!,{difficulty:'easy'});
    Object.assign(sim.state.factions.find(faction=>faction.id==='ally')!,{kind:'ai',difficulty:'easy',personality:'marshal'});sim.state.control.ally!.mode='ai';delete sim.state.control.ally!.assistant;
    // An allied observer sees the test worksite in both sharing configurations.
    f.unit('scout',95000,94000,'ally');sim.setControlMode('red','caretaker');
    internals(sim).updateVision();
    const hidden=Object.values(sim.state.entities).find(entity=>entity.ownerId==='red'&&entity.kind==='building')!;
    sim.state.vision.blue!.memory[hidden.id]={...internals(sim).asView(hidden,false,'blue'),lastSeenTick:sim.state.tick};
    for(const id of ['blue','ally']){const memory=sim.state.controllers[id]!;memory.nextScoutTick=memory.nextStrategicTick=100000;memory.pending=[{observedTick:sim.state.tick,executeTick:sim.state.tick+1,commands:[{kind:'set_auto_reseed',enabled:true}]}];}
    sim.state.control.red!.memory.nextStrategicTick=100000;sim.state.control.red!.memory.pending=[{observedTick:sim.state.tick,executeTick:sim.state.tick+1,commands:[{kind:'set_auto_reseed',enabled:true}]}];return f;
  }
  /** Independent legacy entry: the established scalar visible() predicate is
   * used for every static, with no packed geometry or shared frame. */
  function scalarViews(sim:Simulation):void{sim.view=playerId=>internals(sim).viewFromRoster(playerId,internals(sim).all());}
  function recordViews(sim:Simulation){
    const rows:{view:PlayerView;geometry:unknown}[]=[],originalCommander=commanderPolicy.commanderCommands,originalCaretaker=caretakerPolicy.caretakerCommands;
    const record=(view:PlayerView)=>rows.push({view:structuredClone(view),geometry:internals(sim).controllerViewFrame?.current?.geometry});
    const commander=vi.spyOn(commanderPolicy,'commanderCommands').mockImplementation((view,state,profiler,protectedIds)=>{record(view);return originalCommander(view,state,profiler,protectedIds);});
    const caretaker=vi.spyOn(caretakerPolicy,'caretakerCommands').mockImplementation((view,state,options,profiler)=>{record(view);return originalCaretaker(view,state,options,profiler);});
    return {rows,restore:()=>{commander.mockRestore();caretaker.mockRestore();}};
  }
  it.each([false,true])('shares only geometry across actual AI and caretaker observations, preserving scalar views, cold continuation and replay (shared=%s)',shared=>{
    const {sim}=setup(shared),initial=exportSimulationSave(sim,identity),reference=restoreSimulation(initial,identity,{preserveEpoch:true});scalarViews(reference);sim.drainJournal();reference.drainJournal();
    const observed=recordViews(sim);
    try{
      sim.step();const actual=observed.rows.splice(0);reference.step();const expected=observed.rows.splice(0);
      expect(actual.map(row=>row.view.playerId)).toEqual(['blue','ally','red']);expect(actual.map(row=>row.view)).toEqual(expected.map(row=>row.view));
      expect(actual[0]!.geometry).toBeDefined();expect(actual.every(row=>row.geometry===actual[0]!.geometry)).toBe(true);
      expect(actual[0]!.view.entities.some(entity=>entity.ghost)).toBe(true);expect(actual[2]!.view.entities).not.toEqual(actual[0]!.view.entities);
      expect(internals(sim).controllerViewFrame).toBeUndefined();expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));
      const cold=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
      for(let tick=0;tick<8;tick++){sim.step();reference.step();cold.step();expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));expect(JSON.stringify(cold.capture())).toBe(JSON.stringify(sim.capture()));}
      const replay=new ReplayRunner(createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(JSON.stringify(replay.simulation.capture())).toBe(JSON.stringify(sim.capture()));
    }finally{observed.restore();}
  });
  it.each(['build','cancel_foundation','replace_wall_with_gate'] as const)('rebuilds spans after actual %s admission before the next commander',kind=>{
    const f=setup(),{sim}=f,worker=f.workers.at(-1)!;let command:GameplayCommand,removed:string[]=[];
    // Observe the full construction-clearance halo without standing in the new footprint.
    if(kind!=='cancel_foundation')Object.assign(f.scout,{xMm:94000,zMm:107000});
    if(kind==='build')command={kind:'build',buildingType:'house',builderIds:[worker.id],originCell:{x:44,z:51},rotation:0,queued:false};
    else if(kind==='cancel_foundation'){const foundation=f.structure('house',90000,104000);foundation.work=0;foundation.pendingConstruction={clearanceMm:4000,blocked:true};removed=[foundation.id];command={kind:'cancel_foundation',foundationId:foundation.id};}
    else {const walls=[0,1,2].map(index=>f.structure('palisade_wall',93000+index*2000,105000));removed=walls.map(wall=>wall.id);command={kind:'replace_wall_with_gate',builderIds:[worker.id],wallIds:removed,queued:false};}
    internals(sim).updateVision();sim.state.controllers.blue!.pending[0]!.commands=[command];
    const reference=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});scalarViews(reference);const observed=recordViews(sim);
    try{
      sim.step();const actual=observed.rows.splice(0);reference.step();const expected=observed.rows.splice(0);
      expect(sim.state.controllers.blue!.memory.recentReceipts.at(-1)).toMatchObject({status:'accepted',code:'OK'});
      expect(actual.map(row=>row.view)).toEqual(expected.map(row=>row.view));expect(actual[1]!.geometry).not.toBe(actual[0]!.geometry);expect(actual[2]!.geometry).toBe(actual[1]!.geometry);
      for(const id of removed){expect(sim.state.entities[id]).toBeUndefined();expect(actual[1]!.view.entities.some(entity=>entity.id===id&&!entity.ghost)).toBe(false);}
      if(kind!=='cancel_foundation')expect(actual[1]!.view.entities.some(entity=>entity.ownerId==='blue'&&entity.typeId===(kind==='build'?'house':'wooden_gate')&&entity.progress===0)).toBe(true);
      expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));
    }finally{observed.restore();}
  });
  it.each(['command','apply','addBuilding'] as const)('reconciles public in-place geometry edits made by an overridden %s hook',method=>{
    const f=setup(),{sim}=f,house=f.structure('house',90000,104000);
    // The second house retains a four-metre gap; its entire placement halo is observed.
    if(method==='addBuilding')Object.assign(f.scout,{xMm:102000,zMm:109000});
    internals(sim).updateVision();
    if(method==='addBuilding')sim.state.controllers.blue!.pending[0]!.commands=[{kind:'build',buildingType:'house',builderIds:[f.workers.at(-1)!.id],originCell:{x:48,z:52},rotation:0,queued:false}];
    const reference=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});scalarViews(reference);
    const install=(world:Simulation)=>{
      const internal=internals(world),mutate=()=>{const entity=world.state.entities[house.id] as Building;entity.xMm=world.state.widthMm-20000;entity.zMm=world.state.heightMm-20000;entity.rotation=90;};
      if(method==='command'){const original=world.command;world.command=function(...args){const result=original.apply(this,args);if(args[0]==='blue')mutate();return result;};}
      else if(method==='apply'){const original=internal.apply;internal.apply=function(...args){const result=original.apply(world,args);if(args[0]==='blue')mutate();return result;};}
      else{const original=internal.addBuilding;internal.addBuilding=function(...args){const result=original.apply(world,args);if(args[0]==='blue')mutate();return result;};}
    };install(sim);install(reference);const observed=recordViews(sim);
    try{sim.step();const actual=observed.rows.splice(0);reference.step();const expected=observed.rows.splice(0);expect(sim.state.controllers.blue!.memory.recentReceipts.at(-1)?.status).toBe('accepted');expect(actual.map(row=>row.view)).toEqual(expected.map(row=>row.view));expect(actual[1]!.geometry).not.toBe(actual[0]!.geometry);expect(actual[1]!.view.entities.some(entity=>entity.id===house.id&&!entity.ghost)).toBe(false);expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));}
    finally{observed.restore();}
  });
  it('retains exact unit visibility and live DTO values through a read-only diagnostic-style command wrapper',()=>{
    const {sim}=setup(),original=sim.command;sim.command=function(...args){return original.apply(this,args);};
    const reference=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});scalarViews(reference);const observed=recordViews(sim);
    try{sim.step();const actual=observed.rows.splice(0);reference.step();const expected=observed.rows.splice(0);expect(actual.map(row=>row.view)).toEqual(expected.map(row=>row.view));expect(actual.every(row=>row.geometry===actual[0]!.geometry)).toBe(true);expect(actual[0]!.view.self.autoReseed).toBe(false);expect(sim.view('blue').self.autoReseed).toBe(true);expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));}
    finally{observed.restore();}
  });
  it('keeps unit garrison visibility and building HP live while unchanged static spans are shared',()=>{
    const {sim,home,workers}=setup(),unitId=workers[0]!.id,reference=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});scalarViews(reference);
    const install=(world:Simulation)=>{const original=world.command;world.command=function(...args){const result=original.apply(this,args);if(args[0]==='blue'){const host=world.state.entities[home.id] as Building,unit=world.state.entities[unitId] as Unit;host.hp--;host.garrisoned=[unit.id];unit.garrisonedIn=host.id;}return result;};};install(sim);install(reference);const observed=recordViews(sim);
    try{sim.step();const actual=observed.rows.splice(0);reference.step();const expected=observed.rows.splice(0);expect(actual.map(row=>row.view)).toEqual(expected.map(row=>row.view));expect(actual.every(row=>row.geometry===actual[0]!.geometry)).toBe(true);expect(actual[0]!.view.entities.some(entity=>entity.id===unitId)).toBe(true);expect(actual[1]!.view.entities.some(entity=>entity.id===unitId)).toBe(false);expect(actual[1]!.view.entities.find(entity=>entity.id===home.id)?.hp).toBe(home.maxHp-1);expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));}
    finally{observed.restore();}
  });
  it.each(['view','visible','all','viewFromRoster','asView'] as const)('preserves scalar behavior when %s is overridden',method=>{
    const {sim}=setup(),target=sim as unknown as Record<string,unknown>,original=target[method] as (...args:unknown[])=>unknown;target[method]=function(...args:unknown[]){return original.apply(sim,args);};
    const observed=recordViews(sim);try{sim.step();expect(observed.rows).toHaveLength(3);expect(observed.rows.every(row=>row.geometry===undefined)).toBe(true);expect(internals(sim).controllerViewFrame).toBeUndefined();}finally{observed.restore();}
  });
  it('clears the private frame after a thrown controller and reads later direct fixture edits freshly',()=>{
    const f=setup(),{sim}=f,original=internals(sim).advanceCommander;let captured:unknown;
    internals(sim).advanceCommander=function(playerId){if(playerId==='ally'){captured=internals(sim).controllerViewFrame?.current;throw new Error('CONTROLLER_FIXTURE_FAILURE');}return original.call(sim,playerId);};
    expect(()=>sim.step()).toThrow('CONTROLLER_FIXTURE_FAILURE');expect(captured).toBeDefined();expect(internals(sim).controllerViewFrame).toBeUndefined();
    f.home.xMm+=2000;f.home.rotation=90;const expected=internals(sim).viewFromRoster('blue',internals(sim).all());expect(Simulation.prototype.view.call(sim,'blue')).toEqual(expected);
  });
  it('reconciles direct static edits between views inside a public replay callback',()=>{
    const f=setup(),{sim}=f,house=f.structure('house',90000,104000,'red');internals(sim).updateVision();let calls=0;
    sim.enableReplay(()=>{
      calls++;const before=sim.view('blue'),geometry=internals(sim).controllerViewFrame?.current?.geometry;
      expect(before.entities.some(entity=>entity.id===house.id&&!entity.ghost)).toBe(true);expect(geometry).toBeDefined();
      house.xMm=sim.state.widthMm-20000;house.zMm=sim.state.heightMm-20000;house.rotation=90;
      const after=sim.view('blue'),expected=internals(sim).viewFromRoster('blue',internals(sim).all());
      expect(after).toEqual(expected);expect(after.entities.some(entity=>entity.id===house.id&&!entity.ghost)).toBe(false);expect(internals(sim).controllerViewFrame?.current?.geometry).not.toBe(geometry);
      expect(before.entities.find(entity=>entity.id===house.id)?.xMm).toBe(90000);
    });
    sim.step();expect(calls).toBe(1);expect(internals(sim).controllerViewFrame).toBeUndefined();
  });
});

describe('M6 authoritative desired-state execution',()=>{
  it('spends the exact unit cost without reserving impossible housing at the public population limit',()=>{
    const {sim,structure,unit}=fixture();sim.options.populationLimit=80;const range=structure('archery_range',130000,80000);
    // Isolate housing reservation from the independent emergency farm reserve:
    // this faction already has a visible local source of food.
    sim.state.entities.local_food={id:'local_food',kind:'resource',typeId:'forage_patch',ownerId:null,xMm:76000,zMm:96000,hp:1,maxHp:1,resource:'food',amount:1000000};sim.state.navigationRevision++;
    for(let i=0;i<6;i++)structure('house',120000+i*6000,190000);
    for(let i=0;i<70;i++)unit('villager',20000+i%10*2000,170000+Math.floor(i/10)*2000);
    sim.state.economies.blue!.resources={food:0,wood:units.archer.cost.wood*1000,gold:units.archer.cost.gold*1000,stone:0};sim.step();
    expect(sim.view('blue').self).toMatchObject({population:77,populationCap:80,populationLimit:80});plan(sim,()=>[{kind:'ensure_units',unitType:'archer',targetCount:1}]);
    expect(execute(sim)).toMatchObject([{command:{kind:'train',unitType:'archer',quantity:1},receipt:{status:'accepted'}}]);expect(sim.state.economies.blue!.resources.wood).toBe(0);expect(range.queue).toHaveLength(1);
  });
  it('uses an available Scout after a real garrison admission without repeatedly ordering the contained unit',()=>{
    const {sim,home,scout,unit}=fixture();scout.xMm=home.xMm+6800;scout.zMm=home.zMm;const available=unit('scout',50000,140000);sim.step();
    expect(send(sim,{kind:'garrison',unitIds:[scout.id],targetId:home.id,queued:false}).status).toBe('accepted');sim.step();expect(scout.garrisonedIn).toBe(home.id);
    const view=sim.view('blue'),command=fallbackCommands(view,{sequence:0,scoutIndex:0,buildAttempt:0}).find(command=>command.kind==='move');expect(command).toMatchObject({kind:'move',unitIds:[available.id]});
    expect(send(sim,command!).status).toBe('accepted');expect(scout.garrisonedIn).toBe(home.id);expect(available.orders[0]?.kind).toBe('move');
  });
  it('charges a desired unit total once including paid queues across repeated plans',()=>{
    const {sim,barracks}=fixture(),before=sim.state.economies.blue!.resources.food;
    plan(sim,()=>[{kind:'ensure_units',unitType:'militia',targetCount:2}]);expect(execute(sim)).toMatchObject([{command:{kind:'train',quantity:2},receipt:{status:'accepted'}}]);expect(barracks.queue).toHaveLength(2);
    plan(sim,()=>[{kind:'ensure_units',unitType:'militia',targetCount:2}]);sim.step(20);expect(execute(sim)).toEqual([]);expect(sim.state.economies.blue!.resources.food).toBe(before-2*units.militia.cost.food*1000);expect(restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true}).capture()).toEqual(sim.capture());
    sim.step(units.militia.trainSeconds*20*2);execute(sim);expect(sim.state.controllers.blue!.plan!.goals[0]!.status).toBe('fulfilled');expect(barracks.queue).toHaveLength(0);
  });
  it('reserves a due Hard decision until admission so the same tactical tick cannot buy it twice',()=>{
    const {sim,structure}=fixture(),stable=structure('stable',130000,80000);sim.state.factions[0]!.difficulty='hard';sim.options.controllers=true;plan(sim,()=>[{kind:'ensure_units',unitType:'knight',targetCount:2}]);sim.step(40);expect(stable.queue.filter(job=>job.kind==='train'&&job.typeId==='knight')).toHaveLength(2);expect(sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='train'&&entry.envelope.command.unitType==='knight')).toHaveLength(1);
  });
  it('counts an existing foundation toward building totals and preserves paid progress when replaced',()=>{
    const {sim}=fixture();plan(sim,d=>[{kind:'ensure_building',buildingType:'blacksmith',targetCount:1,anchorRef:ref(d,'own_base')}]);const first=execute(sim);expect(first[0]?.receipt.status).toBe('accepted');const site=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='blacksmith')!;expect(site).toBeDefined();const bank=sim.state.economies.blue!.resources.wood;
    plan(sim,d=>[{kind:'ensure_building',buildingType:'blacksmith',targetCount:1,anchorRef:ref(d,'own_base')}]);sim.step(20);expect(execute(sim).every(item=>item.command.kind!=='build')).toBe(true);expect(sim.state.economies.blue!.resources.wood).toBe(bank);
    for(let i=0;i<400&&site.work===0;i++)sim.step();expect(site.work).toBeGreaterThan(0);const progress=site.work;plan(sim,()=>[{kind:'ensure_units',unitType:'militia',targetCount:0}]);expect(sim.state.entities[site.id]).toBe(site);expect(site.work).toBe(progress);
  });
  it('shares actual age and research producer queues, completing only after ordinary work',()=>{
    const {sim,home,lumber,structure}=fixture();sim.state.economies.blue!.age=2;structure('market',110000,110000);structure('blacksmith',130000,110000);plan(sim,()=>[{kind:'research',technologyId:'forestry_1'},{kind:'advance_age',targetAge:3}]);expect(execute(sim).every(item=>item.receipt.status==='accepted')).toBe(true);expect(home.queue[0]?.kind).toBe('age');expect(lumber.queue[0]?.kind).toBe('research');expect(sim.state.economies.blue!.age).toBe(2);expect(sim.state.economies.blue!.technologies).not.toContain('forestry_1');
    sim.step(801);execute(sim);expect(sim.state.controllers.blue!.plan!.goals[0]!.status).toBe('fulfilled');sim.step(1600);execute(sim);expect(sim.state.economies.blue!.age).toBe(3);expect(sim.state.economies.blue!.technologies).toContain('forestry_1');expect(sim.state.controllers.blue!.plan!.goals[1]!.status).toBe('expired');
  });
  it('expands a renewed age goal into paid prerequisite construction and reaches Fortress through ordinary queues',()=>{
    const {sim,home,unit}=fixture();unit('scout',60000,110000);sim.step();sim.state.economies.blue!.age=2;const initialView=sim.view('blue'),unrelated=buildingCommand(initialView,'lumber_camp',home,initialView.entities.filter(entity=>entity.typeId==='villager'&&entity.ownerId==='blue'))!;expect(send(sim,unrelated).status).toBe('accepted');const initial={...sim.state.economies.blue!.resources};
    plan(sim,()=>[{kind:'advance_age',targetAge:3}]);const first=execute(sim);expect(first).toEqual([expect.objectContaining({command:expect.objectContaining({kind:'build',buildingType:'market'}),receipt:expect.objectContaining({status:'accepted'})})]);
    // Each renewed request is the same typed model goal. No construction work,
    // resource income, completed prerequisites, or research progress is injected.
    for(let elapsed=0;elapsed<360*balance.rules.simulationHz&&sim.state.economies.blue!.age<3;elapsed+=20){sim.step(20);if(elapsed%600===0)plan(sim,()=>[{kind:'advance_age',targetAge:3}]);expect(execute(sim).every(item=>item.receipt.status==='accepted')).toBe(true);}
    const purchases=sim.state.commandLog.map(entry=>entry.envelope.command).filter(command=>command.kind==='build');expect(purchases.map(command=>command.buildingType)).toEqual(['lumber_camp','market','blacksmith']);expect(sim.state.economies.blue!.age).toBe(3);expect(home.queue).toEqual([]);
    for(const resource of balance.resourceOrder)expect(sim.state.economies.blue!.resources[resource]).toBe(initial[resource]-(buildings.market.cost[resource]+buildings.blacksmith.cost[resource]+balance.ages[2]!.cost[resource])*balance.rules.resourceScale);
  },30000);
  it('reserves an exact affordable Fortress age behind a paid villager before optional spending',()=>{
    const {sim,home,structure}=fixture(),age=balance.ages[2]!,memory=emptyCaretakerMemory();sim.state.economies.blue!.age=2;structure('market',110000,110000);structure('blacksmith',130000,110000);
    sim.state.economies.blue!.resources=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,(age.cost[resource]+units.villager.cost[resource])*balance.rules.resourceScale])) as ResourceBank;expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');const paidId=home.queue[0]!.id;sim.step(9);
    caretakerCommands(sim.view('blue'),memory,{targetWorkers:40,scoutAllowed:false});expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='advance_age')).toEqual([{kind:'advance_age',townCenterId:home.id,targetAge:3}]);
    sim.step(Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz));const due=caretakerCommands(sim.view('blue'),memory,{targetWorkers:40,scoutAllowed:false});for(const command of due)expect(send(sim,command).status).toBe('accepted');expect(home.queue.map(job=>job.kind)).toEqual(['train','age']);expect(home.queue[0]!.id).toBe(paidId);expect(sim.state.economies.blue!.resources).toEqual({food:0,wood:0,gold:0,stone:0});
  });
  it('prioritizes age dependencies over optional goals and preserves protected builders/foundations',()=>{
    const {sim,workers,structure}=fixture();sim.state.economies.blue!.age=2;plan(sim,d=>[{kind:'ensure_building',buildingType:'lumber_camp',targetCount:2,anchorRef:ref(d,'own_base')},{kind:'advance_age',targetAge:3}]);
    const view=sim.view('blue'),state=sim.state.controllers.blue!,protectedIds=new Set(workers.map(worker=>worker.id));expect(desiredGoalCommands(view,state,undefined,protectedIds)).toEqual([]);
    protectedIds.delete(workers[0]!.id);const proposals=desiredGoalCommands(view,state,undefined,protectedIds);expect(proposals.map(proposal=>proposal.command)).toEqual([expect.objectContaining({kind:'build',buildingType:'market',builderIds:[workers[0]!.id]})]);
    const site=structure('market',90000,110000);site.work=0;sim.step();protectedIds.clear();protectedIds.add(site.id);const next=desiredGoalCommands(sim.view('blue'),state,undefined,protectedIds);expect(next.some(proposal=>proposal.command.kind==='continue_build'&&proposal.command.foundationId===site.id)).toBe(false);expect(state.plan!.goals.find(goal=>goal.kind==='advance_age')!.reason).toBe('MANUAL_CONTROL');
  });
  it('does not purchase the same age dependency twice when a plan also ensures that building',()=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;plan(sim,d=>[{kind:'ensure_building',buildingType:'market',targetCount:1,anchorRef:ref(d,'own_base')},{kind:'advance_age',targetAge:3}]);const proposals=execute(sim);expect(proposals.map(proposal=>proposal.command)).toEqual([expect.objectContaining({kind:'build',buildingType:'market'})]);expect(proposals[0]!.receipt.status).toBe('accepted');
  });
  it.each([false,true])('reserves unpaid prerequisites across fresh camp-only model plans without an age goal (surplus=%s)',surplus=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources.wood=(buildings.market.cost.wood+buildings.blacksmith.cost.wood+(surplus?1000:0))*balance.rules.resourceScale;
    for(let attempt=0;attempt<3;attempt++){
      plan(sim,d=>[{kind:'ensure_building',buildingType:'lumber_camp',targetCount:2,anchorRef:ref(d,'own_base')}]);
      expect(desiredGoalCommands(sim.view('blue'),sim.state.controllers.blue!)).toEqual([]);expect(sim.state.controllers.blue!.plan!.goals[0]!.reason).toBe('AGE_PREREQUISITES_REQUIRED');
    }
    sim.step(9);const memory=sim.state.controllers.blue!;commanderCommands(sim.view('blue'),memory);
    const purchases=memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='build');expect(purchases.map(command=>command.buildingType)).toEqual(['market']);expect(send(sim,purchases[0]!).status).toBe('accepted');
  });
  it('keeps a requested age prerequisite affordable when optional research would consume its wood',()=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources.wood=buildings.market.cost.wood*balance.rules.resourceScale;
    plan(sim,()=>[{kind:'research',technologyId:'forestry_1'}]);expect(execute(sim)).toEqual([]);
    sim.step(9);commanderCommands(sim.view('blue'),sim.state.controllers.blue!);expect(sim.state.controllers.blue!.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual(['market']);
  });
  it('recovers a zero-worker economy with one real Villager purchase despite missing prerequisite wood',()=>{
    const {sim,home,workers}=fixture();for(const worker of workers)delete sim.state.entities[worker.id];sim.state.navigationRevision++;sim.state.economies.blue!.age=2;
    sim.state.economies.blue!.resources={food:units.villager.cost.food*balance.rules.resourceScale,wood:0,gold:0,stone:0};sim.step(9);const memory=emptyCaretakerMemory();
    caretakerCommands(sim.view('blue'),memory,{targetWorkers:6,allowMilitaryProduction:false,scoutAllowed:false});expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='train')).toEqual([{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}]);
    sim.step(Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz));const due=caretakerCommands(sim.view('blue'),memory,{targetWorkers:6,allowMilitaryProduction:false,scoutAllowed:false});for(const command of due)expect(send(sim,command).status).toBe('accepted');
    expect(home.queue).toEqual([expect.objectContaining({kind:'train',typeId:'villager'})]);expect(sim.state.economies.blue!.resources).toEqual({food:0,wood:0,gold:0,stone:0});
  });
  it('permits a model purchase that spends no reserved prerequisite wood',()=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources.wood=0;expect(units.militia.cost.wood).toBe(0);plan(sim,()=>[{kind:'ensure_units',unitType:'militia',targetCount:1}]);
    const proposals=execute(sim);expect(proposals.map(item=>item.command)).toEqual([expect.objectContaining({kind:'train',unitType:'militia',quantity:1})]);expect(proposals[0]!.receipt.status).toBe('accepted');
  });
  it('reserves only unpaid prerequisites and releases optional construction once their foundations are paid',()=>{
    const {sim,structure}=fixture();sim.state.economies.blue!.age=2;for(const type of ['market','blacksmith'] as const){const site=structure(type,type==='market'?110000:130000,110000);site.work=0;}
    sim.state.economies.blue!.resources.wood=buildings.lumber_camp.cost.wood*balance.rules.resourceScale;sim.step();plan(sim,d=>[{kind:'ensure_building',buildingType:'lumber_camp',targetCount:2,anchorRef:ref(d,'own_base')}]);
    const proposals=execute(sim);expect(proposals.map(item=>item.command)).toEqual([expect.objectContaining({kind:'build',buildingType:'lumber_camp'})]);expect(proposals[0]!.receipt.status).toBe('accepted');
  });
  it('defers fallback fortification expansion until unpaid age prerequisites have builders and funding',()=>{
    const {sim}=fixture();sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources.wood=1000*balance.rules.resourceScale;sim.step(9);const memory=sim.state.controllers.blue!;expect(memory.mode).toBe('fallback');
    commanderCommands(sim.view('blue'),memory);const commands=memory.pending.flatMap(batch=>batch.commands);expect(commands.some(command=>command.kind==='build_wall')).toBe(false);expect(commands.filter(command=>command.kind==='build').map(command=>command.buildingType)).toEqual(['market']);
  });
  it.each([false,true])('creates the remaining Empire dependency through ordinary admission (workshop=%s)',hasWorkshop=>{
    const {sim,structure,unit}=fixture();sim.state.economies.blue!.age=3;if(hasWorkshop)structure('siege_workshop',100000,110000);unit('scout',60000,110000);sim.step();plan(sim,()=>[{kind:'advance_age',targetAge:4}]);const proposals=execute(sim);expect(proposals.map(proposal=>proposal.command)).toEqual([expect.objectContaining({kind:'build',buildingType:hasWorkshop?'university':'siege_workshop'})]);expect(proposals[0]!.receipt.status).toBe('accepted');
  });
  it('round-trips bounded construction recovery observations and rejects future progress ticks',()=>{
    const {sim,workers,structure}=fixture(),site=structure('market',90000,110000),state=sim.state.controllers.blue!;site.work=0;
    state.construction={[site.id]:{progress:0,lastProgressTick:sim.state.tick,builders:{[workers[0]!.id]:{xMm:workers[0]!.xMm,zMm:workers[0]!.zMm,lastMovedTick:sim.state.tick}},helperId:workers[1]!.id,retryAtTick:sim.state.tick+100}};
    expect(validateCommanderMemory(state,'blue',sim.state.tick)).toBe(true);const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.state.controllers.blue!.construction).toEqual(state.construction);
    const invalid=structuredClone(state);invalid.construction![site.id]!.builders[workers[0]!.id]!.lastMovedTick++;expect(validateCommanderMemory(invalid,'blue',sim.state.tick)).toBe(false);
  });
  it('uses cumulative tribute credit across repeated autonomous plans and distinct trusted human requests',()=>{
    const {sim}=fixture(),before=sim.state.economies.ally!.resources.wood;const tribute=(amount:number)=>(d:AiDispatch):AiGoal[]=>[{kind:'tribute',allyRef:ref(d,'ally'),resource:'wood',amount}];
    plan(sim,tribute(100));expect(execute(sim)[0]?.receipt.status).toBe('accepted');plan(sim,tribute(100));sim.step(20);expect(execute(sim)).toEqual([]);plan(sim,tribute(150));sim.step(20);expect(execute(sim)[0]?.command).toMatchObject({kind:'tribute',amount:50});expect(sim.state.economies.ally!.resources.wood).toBe(before+150000);
    for(const requestId of ['human_one','human_two']){expect(sim.acceptAiChat({requestId,senderId:'ally',recipientId:'blue',text:'Please send 100 wood',tick:sim.state.tick,verified:false}).accepted).toBe(true);plan(sim,tribute(100),[requestId]);sim.step(20);expect(execute(sim)[0]?.receipt.status).toBe('accepted');plan(sim,tribute(100),[requestId]);sim.step(20);expect(execute(sim)).toEqual([]);}
    expect(sim.state.economies.ally!.resources.wood).toBe(before+350000);
  });
  it('rejects conflicting normalized goals and foreign references while keeping unrelated goals executable',()=>{
    const {sim}=fixture();const {response}=plan(sim,d=>[{kind:'ensure_building',buildingType:'house',targetCount:10,anchorRef:ref(d,'own_base')},{kind:'ensure_building',buildingType:'house',targetCount:11,anchorRef:ref(d,'own_base')},{kind:'scout',zoneRef:'foreign_frontier'},{kind:'ensure_units',unitType:'militia',targetCount:1}]);expect(response.goals.filter(goal=>goal.status==='rejected').map(goal=>goal.reason)).toEqual(['CONFLICTING_GOALS','INVALID_ZONE']);expect(execute(sim).map(item=>item.command.kind)).toEqual(['train']);
  });
  it('keeps insufficient-resource goals pending, expires unpaid proposals and never debits a negative bank',()=>{
    const {sim}=fixture();sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:0};plan(sim,()=>[{kind:'ensure_units',unitType:'knight',targetCount:2}]);expect(execute(sim)).toEqual([]);expect(sim.state.controllers.blue!.plan!.goals[0]?.status).toBe('pending');const memory=sim.state.controllers.blue!,expiry=memory.plan!.expiresTick;memory.pending=[{observedTick:expiry-1,executeTick:expiry,commands:[{kind:'set_auto_reseed',enabled:true}],goalKey:memory.plan!.goals[0]!.key,planGeneration:memory.plan!.generation}];const view=sim.view('blue');view.tick=expiry;expect(commanderCommands(view,memory).some(item=>item.command.kind==='set_auto_reseed')).toBe(false);expect(memory.plan!.goals[0]!.status).toBe('expired');expect(sim.state.economies.blue!.resources).toEqual({food:0,wood:0,gold:0,stone:0});
  });
  it('issues economy and scouting through real gather/move commands and reports travel before arrival',()=>{
    const {sim,workers,scout}=fixture();const node={id:'known_food',kind:'resource' as const,typeId:'forage_patch',ownerId:null,xMm:76000,zMm:95000,hp:1,maxHp:1,resource:'food' as const,amount:1000000};sim.state.entities[node.id]=node;sim.state.navigationRevision++;sim.step();plan(sim,d=>[{kind:'economy',weights:{food:100,wood:0,gold:0,stone:0},targetVillagers:6},{kind:'scout',zoneRef:ref(d,'frontier')}]);const outcomes=execute(sim);expect(outcomes.map(item=>item.command.kind)).toContain('gather');expect(outcomes.map(item=>item.command.kind)).toContain('move');expect(outcomes.every(item=>item.receipt.status==='accepted')).toBe(true);expect(workers.some(worker=>worker.orders[0]?.kind==='gather')).toBe(true);expect(scout.orders[0]?.kind).toBe('move');expect(sim.state.controllers.blue!.plan!.goals.find(goal=>goal.kind==='scout')!.status).toBe('pending');
  });
  it('accepts a fallback cooperation preset without inference, correlates completion and rejects malformed chat atomically',()=>{
    const {sim}=fixture(),before=sim.capture(),bad={requestId:'bad',senderId:'ally',recipientId:'blue',text:'   ',tick:sim.state.tick,verified:false as const};expect(sim.acceptAiChat(bad)).toEqual({accepted:false,code:'INVALID_AI_CHAT'});expect(sim.capture()).toEqual(before);
    const request={...bad,requestId:'preset',text:'Send 100 wood',intent:{action:'tribute' as const,resource:'wood' as const,amount:100}};expect(sim.acceptAiChat(request).accepted).toBe(true);expect(sim.drainAiMessages()).toMatchObject([{requestId:'preset',status:'planned'}]);expect(execute(sim)[0]?.receipt.status).toBe('accepted');expect(sim.state.controllers.blue!.plan!.goals[0]?.status).toBe('fulfilled');expect(sim.acceptAiChat(request).code).toBe('DUPLICATE_CHAT');expect(execute(sim)).toEqual([]);
  });
  it('retains an Easy preset through routine replies before its real reaction delay and restores/replays the one payment',()=>{
    const sim=simulation(true,'easy'),before=sim.state.economies.ally!.resources.wood;sim.step(18);
    expect(sim.acceptAiChat({requestId:'delayed_preset',senderId:'ally',recipientId:'blue',text:'Send 10 wood',tick:18,verified:false,intent:{action:'tribute',resource:'wood',amount:10}}).accepted).toBe(true);
    const goal=structuredClone(sim.state.controllers.blue!.plan!.goals[0]!);sim.step(2);const scheduled=structuredClone(sim.state.controllers.blue!.pending.find(batch=>batch.goalKey===goal.key)!);expect(scheduled).toMatchObject({observedTick:20,executeTick:60,commands:[{kind:'tribute',amount:10}]});
    sim.step(6);plan(sim,()=>[]);sim.step(14);plan(sim,()=>[]);
    const memory=sim.state.controllers.blue!;expect(memory.plan!.goals).toHaveLength(1);expect(memory.plan!.goals[0]).toMatchObject({source:'preset',acceptedTick:18,expiresTick:1818,correlationId:'delayed_preset'});expect(memory.pending.find(batch=>batch.goalKey===goal.key)).toEqual({...scheduled,planGeneration:memory.planGeneration});expect(sim.state.economies.ally!.resources.wood).toBe(before);
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});sim.step(19);restored.step(19);expect(sim.state.economies.ally!.resources.wood).toBe(before);sim.step();restored.step();expect(restored.capture()).toEqual(sim.capture());expect(sim.state.economies.ally!.resources.wood).toBe(before+10000);expect(sim.state.commandLog.filter(event=>event.envelope.command.kind==='tribute')).toHaveLength(1);
    expect(sim.drainAiMessages().filter(message=>message.requestId==='delayed_preset').map(message=>message.status)).toEqual(['planned','completed']);restored.drainAiMessages();expect(restored.capture()).toEqual(sim.capture());
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('NO_INFERENCE'));try{const replay=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(replay.advanceTo(60).done).toBe(true);expect(replay.simulation.capture()).toEqual(sim.capture());expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
  });
  it('rejects model tribute overlap without attributing an older preset to a new chat request',()=>{
    const {sim}=fixture();sim.acceptAiChat({requestId:'typed',senderId:'ally',recipientId:'blue',text:'Send 10 wood',tick:sim.state.tick,verified:false,intent:{action:'tribute',resource:'wood',amount:10}});const prior=structuredClone(sim.state.controllers.blue!.plan!.goals[0]);
    sim.acceptAiChat({requestId:'natural',senderId:'ally',recipientId:'blue',text:'Please send wood',tick:sim.state.tick,verified:false});const {response}=plan(sim,d=>[{kind:'tribute',allyRef:ref(d,'ally'),resource:'wood',amount:10}],['natural']);
    expect(response).toMatchObject({accepted:true,code:'PLAN_PARTIALLY_ACCEPTED',rejections:[{code:'PRESET_CONFLICT'}],message:{requestId:'natural',status:'declined'}});expect(sim.state.controllers.blue!.plan!.goals).toEqual([prior]);expect(sim.state.controllers.blue!.memory.facts.some(fact=>fact.kind==='owned_event'&&fact.text.startsWith('PRESET_CONFLICT'))).toBe(true);
    const routine=plan(sim,d=>[{kind:'tribute',allyRef:ref(d,'ally'),resource:'wood',amount:10},{kind:'ensure_units',unitType:'militia',targetCount:1}]);expect(routine.response.rejections?.[0]?.code).toBe('PRESET_CONFLICT');expect(execute(sim).map(item=>item.command.kind)).toEqual(['tribute','train']);expect(Object.values(sim.state.controllers.blue!.tributeCredits)).toEqual([10]);
  });
  it('preserves frozen preset squad and target references, replacing them only for a new typed army request',()=>{
    const {sim,unit}=fixture(),first=unit('militia',114000,120000);sim.step();const request={requestId:'army_first',senderId:'ally',recipientId:'blue',text:'Attack the ping',tick:sim.state.tick,verified:false as const,intent:{action:'attack_ping' as const,position:{xMm:140000,zMm:150000}}};expect(sim.acceptAiChat(request).accepted).toBe(true);const frozen=structuredClone(sim.state.controllers.blue!.plan!.goals[0]!.frozenReferences),second=unit('militia',118000,120000);sim.step();plan(sim,()=>[]);
    expect(sim.state.controllers.blue!.plan!.goals[0]!.frozenReferences).toEqual(frozen);expect(sim.state.controllers.blue!.planReferences['army-main']).toMatchObject({entityIds:[first.id,second.id]});expect(execute(sim)[0]?.command).toMatchObject({kind:'attack_move',unitIds:[first.id],target:{xMm:140000,zMm:150000}});
    expect(sim.acceptAiChat({...request,requestId:'army_second',tick:sim.state.tick,intent:{action:'attack_ping',position:{xMm:170000,zMm:150000}}}).accepted).toBe(true);expect(sim.state.controllers.blue!.plan!.goals).toHaveLength(1);expect(sim.state.controllers.blue!.plan!.goals[0]).toMatchObject({correlationId:'army_second',frozenReferences:{'army-main':{entityIds:[first.id,second.id]}}});expect(sim.drainAiMessages().some(message=>message.requestId==='army_first'&&message.status==='expired')).toBe(true);
  });
  it('keeps the eight-goal bound and original deadlines when further plans exceed committed capacity',()=>{
    const {sim}=fixture();for(let index=0;index<8;index++)sim.acceptAiChat({requestId:`typed_${index}`,senderId:'ally',recipientId:'blue',text:'Send 10 wood',tick:sim.state.tick,verified:false,intent:{action:'tribute',resource:'wood',amount:10}});
    const memory=sim.state.controllers.blue!,prior=structuredClone(memory.plan),pending=structuredClone(memory.pending);expect(prior!.goals).toHaveLength(8);const dispatch=sim.prepareAiRequest('blue','over_capacity');expect(sim.completeAiRequest(dispatch.binding,{kind:'plan',plan:{schemaVersion:1,observationId:dispatch.binding.observationId,strategy:'New ordinary goal',goals:[{kind:'ensure_units',unitType:'militia',targetCount:1}],message:null}}).code).toBe('AI_GOAL_CAPACITY');expect(memory.plan).toEqual(prior);expect(memory.pending).toEqual(pending);
    sim.acceptAiChat({requestId:'typed_ninth',senderId:'ally',recipientId:'blue',text:'Send 10 wood',tick:sim.state.tick,verified:false,intent:{action:'tribute',resource:'wood',amount:10}});expect(memory.plan).toEqual(prior);expect(sim.drainAiMessages()).toContainEqual(expect.objectContaining({requestId:'typed_ninth',status:'declined',text:expect.stringContaining('capacity')}));
    sim.step();plan(sim,()=>[]);expect(memory.plan!.goals.map(goal=>goal.expiresTick)).toEqual(prior!.goals.map(goal=>goal.expiresTick));const view=sim.view('blue');view.tick=prior!.goals[0]!.expiresTick;commanderCommands(view,memory);expect(memory.plan!.goals.every(goal=>goal.status==='expired')).toBe(true);expect(memory.pending.some(batch=>batch.goalKey)).toBe(false);
  });
  it('executes defend/attack orders against authorized targets and does not claim a living target destroyed',()=>{
    const {sim,unit,structure}=fixture(),soldier=unit('militia',114000,120000),target=structure('house',118000,120000,'red');sim.step();plan(sim,d=>[{kind:'army_order',squadRef:ref(d,'squad'),order:'attack',targetRef:ref(d,'enemy_memory')}]);const first=execute(sim);expect(first[0]?.command).toMatchObject({kind:'attack_target',targetId:target.id});expect(first[0]?.receipt.status).toBe('accepted');expect(soldier.orders[0]?.kind).toBe('attack');sim.step(20);execute(sim);expect(target.hp).toBeGreaterThan(0);expect(sim.state.controllers.blue!.plan!.goals[0]!.status).not.toBe('fulfilled');
  });
  it('executes a fortify goal through one ordinary gate purchase and prevents duplicate spending',()=>{
    const {sim,unit}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&['barracks','mill','lumber_camp','mining_camp'].includes(entity.typeId))delete sim.state.entities[entity.id];sim.state.navigationRevision++;for(let z=56000;z<=106000;z+=10000)for(let x=56000;x<=106000;x+=10000)unit('scout',x,z);sim.step();plan(sim,d=>[{kind:'fortify',anchorRef:ref(d,'own_base'),material:'palisade',radiusM:18}]);const before=sim.state.economies.blue!.resources.wood,first=execute(sim);expect(first[0]?.command,JSON.stringify(sim.state.controllers.blue!.plan!.goals)).toMatchObject({kind:'build',buildingType:'wooden_gate'});expect(first[0]?.receipt.status).toBe('accepted');sim.step(20);expect(execute(sim)).toEqual([]);expect(sim.state.economies.blue!.resources.wood).toBe(before-buildings.wooden_gate.cost.wood*1000);
  });
  it('reports a correlated multi-goal request complete only after every accepted goal completes',()=>{
    const sim=simulation(true),request={requestId:'multi_goal',senderId:'ally',recipientId:'blue',text:'Send wood and prepare five militia.',tick:0,verified:false as const};sim.acceptAiChat(request);plan(sim,d=>[{kind:'tribute',allyRef:ref(d,'ally'),resource:'wood',amount:10},{kind:'ensure_units',unitType:'militia',targetCount:5}],[request.requestId]);sim.step(40);expect(sim.state.controllers.blue!.plan!.goals.find(goal=>goal.kind==='tribute')!.status).toBe('fulfilled');expect(sim.state.controllers.blue!.plan!.goals.find(goal=>goal.kind==='ensure_units')!.status).not.toBe('fulfilled');expect(sim.drainAiMessages().some(message=>message.status==='completed')).toBe(false);
  });
});

describe('M6 isolated request lifecycles and replay',()=>{
  it('rejects malformed or cross-match commander patches before changing replay state',()=>{
    const sim=simulation();sim.enableReplay(()=>undefined);const before=sim.capture();for(const patches of [[{path:['memory','matchId'],value:'foreign_match'}],[{path:['__proto__','polluted'],value:true}],[{path:['mode'],value:'omniscient'}],[{path:['pending',1],value:{}}]])expect(()=>sim.applyJournalEvent({ordinal:1,tick:0,phase:'boundary',kind:'commander_patch',playerId:'blue',patches})).toThrow('INVALID_COMMANDER_PATCH');expect(sim.capture()).toEqual(before);expect(({} as Record<string,unknown>).polluted).toBeUndefined();
  });
  it('rejects wrong observation, stale generations, late responses, paused and finished results',()=>{
    const sim=simulation(),dispatch=sim.prepareAiRequest('blue','one');expect(()=>sim.prepareAiRequest('blue','two')).toThrow('AI_REQUEST_IN_FLIGHT');const result={kind:'plan' as const,plan:{schemaVersion:1,observationId:dispatch.binding.observationId,strategy:'Test',goals:[],message:null}};
    expect(sim.completeAiRequest({...dispatch.binding,observationId:'forged'},result).code).toBe('STALE_AI_RESPONSE');sim.invalidateAiRequests();expect(sim.completeAiRequest(dispatch.binding,result).code).toBe('STALE_AI_RESPONSE');const paused=sim.prepareAiRequest('blue','paused');sim.setStatus('PAUSED');expect(sim.completeAiRequest(paused.binding,result).code).toBe('STALE_AI_RESPONSE');sim.setStatus('RUNNING');const expired=sim.prepareAiRequest('blue','expired');sim.state.tick+=1201;expect(sim.completeAiRequest(expired.binding,result).code).toBe('AI_OBSERVATION_EXPIRED');expect(sim.state.controllers.blue!.inferenceFailures).toBe(1);const terminal=sim.prepareAiRequest('blue','terminal');sim.endAsDraw();expect(sim.completeAiRequest(terminal.binding,result).code).toBe('STALE_AI_RESPONSE');
  });
  it('restores an in-flight binding exactly for replay and invalidates it for a new live epoch',()=>{
    const sim=simulation(true);sim.step(12);const dispatch=sim.prepareAiRequest('blue','saved'),save=exportSimulationSave(sim,identity),exact=restoreSimulation(save,identity,{preserveEpoch:true});expect(exact.capture()).toEqual(sim.capture());const live=restoreSimulation(save,identity);expect(live.state.controllers.blue!.activeRequest).toBeUndefined();expect(live.completeAiRequest(dispatch.binding,{kind:'failure',code:'TIMEOUT'}).code).toBe('STALE_AI_RESPONSE');
    expect(sim.completeAiRequest(dispatch.binding,{kind:'failure',code:'TIMEOUT'}).accepted).toBe(false);exact.completeAiRequest(dispatch.binding,{kind:'failure',code:'TIMEOUT'});for(let i=0;i<30;i++){sim.step();exact.step();expect(exact.capture()).toEqual(sim.capture());}
    const recording=exportReplay(sim,identity,[replayCheckpoint(sim)]),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('NO_INFERENCE'));try{const replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(sim.capture());expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
  });
  it('keeps actual five-Hard-commander normal and rich-chat journals compact and exactly replayable',()=>{
    for(const rich of [false,true]){
      const factions=Array.from({length:11},(_,index)=>({id:index<5?`ai${index}`:`h${index-5}`,name:`Faction ${index}`,teamId:index===10?'enemy':'allies',kind:index<5?'ai' as const:'human' as const,color:`#${(0x102030+index*0x10203).toString(16).padStart(6,'0')}`,...(index<5?{difficulty:'hard' as const,personality:'marshal' as const}:{})}));
      const sim=createSimulation({factions,matchId:rich?'rich_journal':'normal_journal',seed:'m6-journal-volume',controllers:true,sharedVision:false});
      if(rich)for(const player of factions.slice(0,5))for(let index=0;index<32;index++)expect(sim.acceptAiChat({requestId:`chat_${player.id}_${index}`,senderId:'h0',recipientId:player.id,text:'Unverified allied request. '.repeat(18),tick:0,verified:false}).accepted).toBe(true);
      const initial=exportSimulationSave(sim,identity),prior=structuredClone(sim.state.controllers);sim.drainJournal();sim.step(60);const events=sim.journalEvents(),bytes=Buffer.byteLength(JSON.stringify(events)),patches=events.filter(event=>event.kind==='commander_patch');let fullBytes=0;
      for(const event of events){if(event.kind==='commander_patch'){prior[event.playerId]=applyCommanderPatches(prior[event.playerId]!,event.patches) as CommanderState;fullBytes+=Buffer.byteLength(JSON.stringify({...event,kind:'commander_memory',patches:undefined,memory:prior[event.playerId]}));}else fullBytes+=Buffer.byteLength(JSON.stringify(event));}
      expect(patches.length).toBeGreaterThan(0);if(rich)expect(bytes).toBeLessThan(fullBytes/3);
      const recording=createReplayRecording(initial,events,[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(sim.capture());
      console.info(`M6 journal ${rich?'rich-chat':'normal'}: 11 factions / 5 Hard AI / 60 ticks, ${events.length} events, ${patches.length} patches, actual ${bytes} bytes, equivalent snapshots ${fullBytes} bytes; exact replay passed.`);
    }
  },60000);
});

describe('bounded resource handoffs',()=>{
  function allocation(){
    const {sim}=fixture(),view=sim.view('blue');view.tick=20;view.players[0]!.difficulty='hard';view.self.resources={food:0,wood:0,gold:0,stone:0};view.self.autoReseed=true;
    const workers=view.entities.filter(entity=>entity.typeId==='villager'&&entity.ownerId==='blue');workers.forEach((worker,index)=>Object.assign(worker,{xMm:100000+index*1500,zMm:100000,order:'gather',taskState:'blocked',blockedReason:'PATH_BLOCKED',cargo:{resource:null,amount:0}}));
    const source:ViewEntity={id:'remembered_wood',kind:'resource',typeId:'tree',ownerId:null,xMm:140000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:250,ghost:true,lastSeenTick:1};
    view.entities=[...view.entities.filter(entity=>entity.typeId==='town_center'&&entity.ownerId==='blue'),...workers,source];
    const state=createCommanderState(view.matchId,view.playerId);state.assignments=Object.fromEntries(workers.map(worker=>[worker.id,'gold']));state.nextStrategicTick=100000;state.nextScoutTick=100000;return {sim,view,state,workers,source};
  }
  const commands=(state:CommanderState)=>state.pending.flatMap(batch=>batch.commands);
  const selectedBy=(command:GameplayCommand,id:string)=>'unitIds'in command?command.unitIds.includes(id):'builderIds'in command?command.builderIds.includes(id):'builderId'in command&&command.builderId===id;
  it.each([false,true])('does not cancel at the exact unarmed mining-camp stop geometry (ghost=%s)',ghost=>{
    const {view,state,source,workers}=allocation();commanderCommands(view,state);const worker=workers.find(worker=>worker.id===state.resourceHandoff!.workerId)!;state.pending=[];
    // Isolate the observed camp-only predicate. The complete historical view
    // also contains a remembered armed TC, which is a separate valid hazard.
    view.tick=24840;view.players[0]!.difficulty='medium';Object.assign(worker,{xMm:230006,zMm:170977,hp:35,maxHp:35,order:'move',taskState:'moving'});
    Object.assign(source,{typeId:'wood_oak',xMm:271000,zMm:183000});Object.assign(state.resourceHandoff!,{issuedTick:24040,expiresTick:27116,lastProgressTick:24830,lastPosition:{xMm:228356,zMm:170977},target:{xMm:268850,zMm:180850}});
    view.entities.push({id:'observed_mining_camp',kind:'building',typeId:'mining_camp',ownerId:'red',xMm:239000,zMm:175000,hp:buildings.mining_camp.maxHp,maxHp:buildings.mining_camp.maxHp,progress:1,...(ghost?{ghost:true,lastSeenTick:24000}:{})});
    expect(Math.hypot(worker.xMm-239000,worker.zMm-175000)).toBeLessThan(10000);expect(buildings.mining_camp.attack??0).toBe(0);
    const before=structuredClone(view);commanderCommands(view,state);expect(state.resourceHandoff).toMatchObject({workerId:worker.id,lastProgressTick:24840});expect(commands(state).filter(command=>selectedBy(command,worker.id))).toEqual([]);expect(view).toEqual(before);
  });
  it.each(['visible','remembered','distant_remembered'] as const)('checks the %s armed footprint before delegating an exhausted corridor',condition=>{
    const {view,state}=allocation(),far=condition==='distant_remembered';view.entities.push({id:'armed_corridor_tc',kind:'building',typeId:'town_center',ownerId:'red',xMm:120000,zMm:far?125000:114000,hp:buildings.town_center.maxHp,maxHp:buildings.town_center.maxHp,progress:1,...(condition==='visible'?{}:{ghost:true,lastSeenTick:1})});
    const originalLine=Navigation.prototype.clearLine,originalPath=Navigation.prototype.path;let probes=0,used=0;
    const line=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['clearLine']>){return this.maxSearchNodes===512?false:originalLine.apply(this,args);});
    const path=vi.spyOn(Navigation.prototype,'path').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['path']>){if(this.maxSearchNodes!==512)return originalPath.apply(this,args);probes++;this.workBudget!.used+=this.workBudget!.remaining;this.workBudget!.remaining=0;used=this.workBudget!.used;throw new PathBudgetExceededError();});
    try{const before=structuredClone(view);commanderCommands(view,state);expect(probes).toBe(1);expect(used).toBe(8000);expect(Boolean(state.resourceHandoff)).toBe(far);expect(commands(state).filter(command=>command.kind==='move')).toHaveLength(far?1:0);expect(view).toEqual(before);}finally{path.mockRestore();line.mockRestore();}
  });
  it.each(['visible','remembered','defeated','allied'] as const)('reconciles a worker inside the %s armed footprint threat correctly',condition=>{
    const {view,state,workers}=allocation();commanderCommands(view,state);const worker=workers.find(worker=>worker.id===state.resourceHandoff!.workerId)!;state.pending=[];Object.assign(worker,{xMm:100000,zMm:100000,order:'move',taskState:'moving'});view.tick=30;
    if(condition==='defeated')view.players.find(player=>player.id==='red')!.defeated=true;
    view.entities.push({id:'nearby_tc',kind:'building',typeId:'town_center',ownerId:condition==='allied'?'ally':'red',xMm:114000,zMm:100000,hp:buildings.town_center.maxHp,maxHp:buildings.town_center.maxHp,progress:1,...(condition==='remembered'||condition==='defeated'?{ghost:true,lastSeenTick:1}:{})});
    // The old 10m center check missed this legal 8m shot from the TC footprint.
    const halfWidth=buildings.town_center.footprintCells[0]*balance.rules.buildingGridM*500;expect(14000-halfWidth-units.villager.collisionRadiusM*1000).toBeLessThan(buildings.town_center.rangeM!*1000);
    commanderCommands(view,state);const hazardous=condition==='visible'||condition==='remembered';expect(state.resourceHandoff===undefined).toBe(hazardous);expect(commands(state).filter(command=>command.kind==='stop'&&command.unitIds.includes(worker.id))).toHaveLength(hazardous?1:0);
  });
  it('keeps a publicly defeated armed structure as physical navigation geometry',()=>{
    const {view,state,source}=allocation();view.players.find(player=>player.id==='red')!.defeated=true;view.entities.push({id:'inert_blocking_tc',kind:'building',typeId:'town_center',ownerId:'red',xMm:source.xMm,zMm:source.zMm,hp:buildings.town_center.maxHp,maxHp:buildings.town_center.maxHp,progress:1,ghost:true,lastSeenTick:1});
    const original=Navigation.prototype.free;let checked=0;const free=vi.spyOn(Navigation.prototype,'free').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['free']>){const result=original.apply(this,args);if(this.maxSearchNodes===512){expect(this.obstacles.some(obstacle=>obstacle.id==='inert_blocking_tc')).toBe(true);expect(result).toBe(false);checked++;}return result;});
    try{commanderCommands(view,state);expect(checked).toBe(8);expect(state.resourceHandoff).toBeUndefined();}finally{free.mockRestore();}
  });
  it('keeps the same remembered armed hazard when its unobserved building is destroyed',()=>{
    const {sim,scout,structure}=fixture();sim.state.factions[0]!.difficulty='hard';sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:0};sim.state.economies.blue!.autoReseed=true;
    const source={id:'guarded_memory_wood',kind:'resource' as const,typeId:'wood_oak',ownerId:null,xMm:190000,zMm:100000,hp:1,maxHp:1,resource:'wood' as const,amount:250000};sim.state.entities[source.id]=source;const enemy=structure('town_center',180000,112000,'red');Object.assign(scout,{xMm:185000,zMm:96000});sim.step();expect(sim.view('blue').entities.find(entity=>entity.id===enemy.id)).toMatchObject({typeId:'town_center',ownerId:'red'});expect(sim.view('blue').entities.find(entity=>entity.id===source.id)).toMatchObject({resource:'wood',amount:250});
    expect(send(sim,{kind:'move',unitIds:[scout.id],target:{xMm:185000,zMm:60000},queued:false}).status).toBe('accepted');sim.step(200);
    const other=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});delete other.state.entities[enemy.id];(other.state.entities[source.id] as typeof source).amount=0;other.state.navigationRevision++;sim.step(3);other.step(3);
    const left=sim.view('blue'),right=other.view('blue');expect(left.entities.find(entity=>entity.id===enemy.id)).toMatchObject({ghost:true,typeId:'town_center'});expect(left.entities.find(entity=>entity.id===source.id)).toMatchObject({ghost:true,amount:250});expect(right).toEqual(left);
    const a=createCommanderState(sim.state.matchId,'blue'),b=createCommanderState(sim.state.matchId,'blue');a.nextScoutTick=b.nextScoutTick=100000;a.nextStrategicTick=b.nextStrategicTick=100000;commanderCommands(left,a);commanderCommands(right,b);expect(a.resourceHandoff).toBeUndefined();expect(b).toEqual(a);
  });
  it.each(['route_exhausted','endpoint_exhausted','endpoint_blocked','visible_source','null_route','dangerous_corridor','dangerous_endpoint','unsafe_then_exhausted','full_queue'] as const)('bounds delegated handoff behavior for %s',condition=>{
    const {view,state,source}=allocation(),before=structuredClone(view),assignments=structuredClone(state.assignments);
    if(condition==='visible_source')source.ghost=false;
    if(condition==='full_queue')state.pending=Array.from({length:59},(_,index)=>({observedTick:1,executeTick:1000,commands:[{kind:'move' as const,unitIds:[`reserved_${index}`],target:{xMm:10000,zMm:10000},queued:false}]}));
    if(['dangerous_corridor','dangerous_endpoint','unsafe_then_exhausted'].includes(condition))view.entities.push({id:'observed_danger',kind:'unit',typeId:'militia',ownerId:'red',xMm:condition==='dangerous_endpoint'?140000:120000,zMm:condition==='unsafe_then_exhausted'?120000:100000,hp:70,maxHp:70});
    const original={free:Navigation.prototype.free,line:Navigation.prototype.clearLine,path:Navigation.prototype.path},budgets=new Set<NonNullable<Navigation['workBudget']>>();let pathCalls=0;
    const exhaust=(nav:Navigation):never=>{const budget=nav.workBudget!;budget.used+=budget.remaining;budget.remaining=0;throw new PathBudgetExceededError();};
    const free=vi.spyOn(Navigation.prototype,'free').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['free']>){if(this.maxSearchNodes===512&&this.workBudget){budgets.add(this.workBudget);if(condition==='endpoint_exhausted')return exhaust(this);if(condition==='endpoint_blocked')return false;}return original.free.apply(this,args);});
    const line=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['clearLine']>){return this.maxSearchNodes===512?false:original.line.apply(this,args);});
    const path=vi.spyOn(Navigation.prototype,'path').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['path']>){if(this.maxSearchNodes!==512)return original.path.apply(this,args);pathCalls++;if(condition==='null_route')return null;if(condition==='unsafe_then_exhausted'&&pathCalls===1)return [{xMm:120000,zMm:120000},args[1]];return exhaust(this);});
    try{
      commanderCommands(view,state);expect(budgets.size).toBe(1);expect([...budgets].every(budget=>budget.used+budget.remaining===8000)).toBe(true);
      if(condition==='route_exhausted'){
        expect(state.resourceHandoff).toMatchObject({resourceId:source.id,phase:'move'});const workerId=state.resourceHandoff!.workerId;expect(commands(state).filter(command=>selectedBy(command,workerId))).toHaveLength(1);
        commanderCommands(view,state);expect(commands(state).filter(command=>selectedBy(command,workerId))).toHaveLength(1);expect(pathCalls).toBe(1);expect(view).toEqual(before);
      }else{expect(state.resourceHandoff).toBeUndefined();expect(state.assignments).toEqual(assignments);}
      if(['endpoint_exhausted','endpoint_blocked','dangerous_endpoint'].includes(condition))expect(pathCalls).toBe(0);
      if(condition==='unsafe_then_exhausted')expect(pathCalls).toBe(2);
    }finally{path.mockRestore();line.mockRestore();free.mockRestore();}
  });
  it('keeps a failed unsafe-corridor cooldown and rotates to another eligible idle origin',()=>{
    const {view,state,workers}=allocation(),ordered=[...workers].sort((a,b)=>a.id.localeCompare(b.id));for(const worker of workers){worker.order='idle';worker.taskState='idle';delete state.assignments![worker.id];}Object.assign(ordered[0]!,{xMm:100000,zMm:140000});
    view.entities.push({id:'corridor_danger',kind:'unit',typeId:'militia',ownerId:'red',xMm:120000,zMm:120000,hp:70,maxHp:70});
    const originalLine=Navigation.prototype.clearLine,originalPath=Navigation.prototype.path;let probes=0;
    const line=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['clearLine']>){return this.maxSearchNodes===512?false:originalLine.apply(this,args);});
    const path=vi.spyOn(Navigation.prototype,'path').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['path']>){if(this.maxSearchNodes!==512)return originalPath.apply(this,args);probes++;this.workBudget!.used+=this.workBudget!.remaining;this.workBudget!.remaining=0;throw new PathBudgetExceededError();});
    try{commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();expect(state.resourceHandoffCooldown?.untilTick).toBe(620);view.tick=615;commanderCommands(view,state);expect(probes).toBe(1);view.tick=620;commanderCommands(view,state);expect(probes).toBe(2);expect(state.resourceHandoff?.workerId).toBe(ordered[1]!.id);expect(commands(state).filter(command=>command.kind==='move')).toHaveLength(1);}finally{path.mockRestore();line.mockRestore();}
  });
  it('delegates an exhausted remembered trip through pending save/replay and ordinary reveal gather deposit',()=>{
    const {sim,structure,scout,workers,lumber}=fixture(),pair=workers.slice(0,2).sort((a,b)=>a.id.localeCompare(b.id));
    for(const worker of workers.slice(2))delete sim.state.entities[worker.id];Object.assign(pair[0]!,{xMm:113150,zMm:172000});Object.assign(pair[1]!,{xMm:113970,zMm:167151});
    structure('mining_camp',117000,171000);for(const x of [115000,117000,121000,123000,125000,127000,129000,131000])structure('palisade_wall',x,175000);for(const z of [177000,179000])structure('palisade_wall',115000,z);
    const sources=Array.from({length:30},(_,index)=>({id:'rotation_wood_'+index,kind:'resource' as const,typeId:'wood_oak',ownerId:null,xMm:271000+Math.floor(index/5)*3000,zMm:180000+index%5*3000,hp:1,maxHp:1,resource:'wood' as const,amount:100000}));for(const source of sources)sim.state.entities[source.id]=source;sim.state.navigationRevision++;
    Object.assign(lumber,{xMm:264000,zMm:166000});Object.assign(scout,{xMm:278500,zMm:186000});sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:0};sim.state.economies.blue!.autoReseed=true;sim.step();
    expect(sim.view('blue').entities.filter(entity=>sources.some(source=>source.id===entity.id)&&!entity.ghost)).toHaveLength(30);expect(send(sim,{kind:'move',unitIds:[scout.id],target:{xMm:278500,zMm:160000},queued:false}).status).toBe('accepted');sim.step(200);
    expect(sim.view('blue').entities.filter(entity=>sources.some(source=>source.id===entity.id)&&entity.ghost)).toHaveLength(30);
    const memory=sim.state.controllers.blue!;memory.nextStrategicTick=100000;memory.nextScoutTick=100000;sim.options.controllers=true;
    const policy=balance.ai.difficulty.medium,tactical=policy.tacticalIntervalSeconds*balance.rules.simulationHz,initial=exportSimulationSave(sim,identity);sim.drainJournal();
    const hidden=restoreSimulation(initial,identity,{preserveEpoch:true});(hidden.state.entities[sources[0]!.id] as typeof sources[number]).amount=0;const enemy=structuredClone(pair[0]!);Object.assign(enemy,{id:'hidden_rotation_enemy',ownerId:'red',xMm:sources[0]!.xMm,zMm:sources[0]!.zMm});hidden.state.entities[enemy.id]=enemy;hidden.state.navigationRevision++;
    const budgets=new Set<NonNullable<Navigation['workBudget']>>(),free=Navigation.prototype.free,spy=vi.spyOn(Navigation.prototype,'free').mockImplementation(function(this:Navigation,point,radius,ignored){if(this.maxSearchNodes===512&&this.workBudget)budgets.add(this.workBudget);return free.call(this,point,radius,ignored);});
    try{
      const untilDecision=tactical-sim.state.tick%tactical;sim.step(untilDecision);hidden.step(untilDecision);expect(budgets.size).toBe(2);expect([...budgets].every(budget=>budget.used===8000&&budget.remaining===0)).toBe(true);
      expect(memory.resourceHandoff).toMatchObject({workerId:pair[0]!.id,resourceId:sources[0]!.id,resource:'wood',phase:'move'});expect(hidden.state.controllers.blue).toEqual(memory);expect(hidden.view('blue')).toEqual(sim.view('blue'));
      const move={kind:'move' as const,unitIds:[pair[0]!.id],target:{xMm:268850,zMm:177850},queued:false};expect(commands(memory)).toEqual([move]);expect(pair[0]!.orders).toEqual([]);
      const restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(restored.capture()).toEqual(sim.capture());
      for(const world of [sim,restored,hidden])world.step(Math.ceil(policy.reactionDelaySeconds*balance.rules.simulationHz));expect(sim.state.commandLog.at(-1)?.envelope.command).toEqual(move);expect(memory.memory.recentReceipts.at(-1)?.status).toBe('accepted');expect(pair[0]!.orders[0]?.kind).toBe('move');expect(restored.capture()).toEqual(sim.capture());expect(hidden.view('blue')).toEqual(sim.view('blue'));
      expect(sim.state.commandLog.filter(entry=>entry.envelope.command.kind==='move'&&entry.envelope.command.unitIds.includes(pair[0]!.id))).toHaveLength(1);
      let sawScheduler=false,sawVisibleGather=false,sawDeposit=false,commandCursor=sim.state.commandLog.length;for(let tick=0;tick<2400&&!sawDeposit;tick++){
        const cargo={...pair[0]!.cargo},collected=sim.state.economies.blue!.collected.wood;sim.step();restored.step();sawScheduler ||= !!pair[0]!.pathRequestId;
        sawDeposit ||= cargo.resource==='wood'&&cargo.amount>0&&pair[0]!.cargo.amount===0&&sim.state.economies.blue!.collected.wood>=collected+cargo.amount;
        for(const admitted of sim.state.commandLog.slice(commandCursor)){const command=admitted.envelope.command;if(command.kind==='gather'&&command.unitIds.includes(pair[0]!.id)){expect(sim.view('blue').entities.find(entity=>entity.id===command.targetId)?.ghost).not.toBe(true);sawVisibleGather=true;}}commandCursor=sim.state.commandLog.length;
      }
      expect(sawScheduler).toBe(true);expect(sawVisibleGather).toBe(true);expect(sawDeposit).toBe(true);expect(restored.capture()).toEqual(sim.capture());expect(pair.every(worker=>worker.hp>0)).toBe(true);
      const replay=new ReplayRunner(createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(replay.simulation.capture()).toEqual(sim.capture());
    }finally{spy.mockRestore();}
  },60000);
  it.each(['easy','medium','hard'] as const)('advances the stable %s idle priority class exactly once per tactical-aligned cooldown',difficulty=>{
    const {view,state,workers}=allocation(),policy=balance.ai.difficulty[difficulty],interval=policy.strategicIntervalSeconds*balance.rules.simulationHz,tactical=policy.tacticalIntervalSeconds*balance.rules.simulationHz;
    view.players[0]!.difficulty=difficulty;const ordered=[...workers].sort((a,b)=>a.id.localeCompare(b.id)),peers=ordered.slice(-2);for(const worker of peers){worker.order='idle';worker.taskState='idle';delete state.assignments![worker.id];}
    expect(Number.isInteger(tactical)).toBe(true);expect(interval%tactical).toBe(0);
    for(let attempt=0;attempt<4;attempt++){const memory=structuredClone(state),observed=structuredClone(view);observed.tick=tactical+attempt*interval;memory.resourceHandoffCooldown={resourceId:'prior_probe',untilTick:observed.tick};commanderCommands(observed,memory);expect(memory.resourceHandoff?.workerId).toBe(peers[attempt%peers.length]!.id);expect(Object.keys(memory).some(key=>/rotation|cursor/i.test(key))).toBe(false);}
  });
  it('hands off one blocked surplus worker to missing remembered wood and preserves it through housekeeping',()=>{
    const {view,state,workers,source}=allocation(),before=structuredClone(view);commanderCommands(view,state);const active=state.resourceHandoff!;
    expect(active).toMatchObject({resource:'wood',resourceId:source.id,phase:'move'});expect(commands(state).filter(command=>selectedBy(command,active.workerId))).toEqual([{kind:'move',unitIds:[active.workerId],target:active.target,queued:false}]);expect(view).toEqual(before);
    const worker=workers.find(worker=>worker.id===active.workerId)!;view.tick=25;expect(commanderCommands(view,state).filter(proposal=>selectedBy(proposal.command,worker.id))).toHaveLength(1);
    worker.order='move';worker.taskState='moving';view.tick=30;worker.xMm+=1500;commanderCommands(view,state);
    expect(state.resourceHandoff?.workerId).toBe(worker.id);expect(state.assignments?.[worker.id]).toBe('wood');expect(commands(state).some(command=>selectedBy(command,worker.id))).toBe(false);
    source.ghost=false;view.tick=35;commanderCommands(view,state);expect(state.resourceHandoff?.phase).toBe('gather');expect(commands(state).filter(command=>selectedBy(command,worker.id))).toEqual([{kind:'gather',unitIds:[worker.id],targetId:source.id,queued:false}]);
    view.tick=40;expect(commanderCommands(view,state).filter(proposal=>selectedBy(proposal.command,worker.id))).toHaveLength(1);worker.order='gather';worker.taskState='gathering';worker.cargo={resource:'wood',amount:1};worker.xMm=source.xMm-1500;worker.zMm=source.zMm;view.tick=45;commanderCommands(view,state);
    expect(state.resourceHandoff).toBeUndefined();expect(state.assignments?.[worker.id]).toBe('wood');
  });
  it.each(['food','wood','gold','stone'] as const)('uses a current visible %s source before a closer remembered source',resource=>{
    const {view,state,source}=allocation();source.resource=resource;source.typeId=resource==='food'?'forage_patch':resource==='wood'?'tree':`${resource}_deposit`;
    state.assignments=Object.fromEntries(Object.keys(state.assignments!).map(id=>[id,resource==='gold'?'stone':'gold']));
    view.entities.push({...source,id:'visible_source',xMm:180000,ghost:false});commanderCommands(view,state);
    expect(state.resourceHandoff).toMatchObject({phase:'gather',resource,resourceId:'visible_source'});expect(commands(state).filter(command=>command.kind==='gather')).toHaveLength(1);
  });
  it.each(['builder','reseeder','farmer','cargo','queued_order','pending','due'] as const)('does not take a %s away from paid work or an existing reservation',condition=>{
    for(const attempt of [0,1]){const {view,state,workers}=allocation(),worker=[...workers].sort((a,b)=>a.id.localeCompare(b.id))[attempt]!;view.tick+=attempt*balance.ai.difficulty.hard.strategicIntervalSeconds*balance.rules.simulationHz;
    if(condition==='builder')worker.order='build';else if(condition==='reseeder')worker.order='reseed';else if(condition==='cargo')worker.cargo={resource:'gold',amount:1};else if(condition==='queued_order')worker.queuedOrderCount=1;
    else if(condition==='farmer'){state.farmAssignments={reserved_farm:worker.id};view.entities.push({id:'reserved_farm',kind:'building',typeId:'farm',ownerId:'blue',xMm:115000,zMm:110000,hp:450,maxHp:450,progress:1,farmState:'exhausted',resource:'food',amount:0,farmerAssigned:true});}
    else state.pending=[{observedTick:1,executeTick:condition==='due'?view.tick:view.tick+20,commands:[{kind:'move',unitIds:[worker.id],target:{xMm:90000,zMm:110000},queued:false}]}];
    commanderCommands(view,state);expect(state.resourceHandoff).toBeDefined();expect(state.resourceHandoff!.workerId).not.toBe(worker.id);
    }
  });
  it('does not reserve a worker or change assignments when the proposal queue is full',()=>{
    const {view,state}=allocation(),before=structuredClone(state.assignments);state.pending=Array.from({length:59},(_,index)=>({observedTick:1,executeTick:1000,commands:[{kind:'move' as const,unitIds:[`prior_${index}`],target:{xMm:10000,zMm:10000},queued:false}]}));
    commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();expect(state.assignments).toEqual(before);expect(commands(state).some(command=>command.kind==='move'&&!command.unitIds[0]!.startsWith('prior_'))).toBe(false);
  });
  it('keeps routine empty model replies but yields to an actually enqueued building goal',()=>{
    const {view,state,workers}=allocation();commanderCommands(view,state);const worker=workers.find(worker=>worker.id===state.resourceHandoff!.workerId)!;state.pending=[];worker.order='move';worker.taskState='moving';
    state.plan={generation:1,strategy:'Routine',acceptedTick:20,expiresTick:2000,goals:[]};state.planGeneration=1;state.mode='model';view.tick=30;commanderCommands(view,state);expect(state.resourceHandoff?.workerId).toBe(worker.id);
    view.entities.push({id:'paid_house',kind:'building',typeId:'house',ownerId:'blue',xMm:110000,zMm:110000,hp:60,maxHp:600,progress:.1});state.plan.goals=[{key:'building:house',kind:'ensure_building',goal:{kind:'ensure_building',buildingType:'house',targetCount:1,anchorRef:'home'},status:'accepted',acceptedTick:30,expiresTick:2000,candidateIndex:0,attempts:0}];
    // A traveling handoff is not an idle/gathering foundation helper. A nearer
    // available builder continues the site without cancelling the resource trip.
    view.entities=view.entities.sort((a,b)=>Number(b.id===worker.id)-Number(a.id===worker.id));view.tick=35;commanderCommands(view,state);
    expect(commands(state).some(command=>command.kind==='continue_build'&&!command.builderIds.includes(worker.id))).toBe(true);expect(state.resourceHandoff?.workerId).toBe(worker.id);
    // Once the handoff worker is actually available, an admitted building goal
    // may take it over; other workers retain their explicit queued intentions.
    state.pending=[];worker.order='idle';for(const other of workers)if(other.id!==worker.id)other.queuedOrderCount=1;view.tick=45;commanderCommands(view,state);
    expect(commands(state)).toContainEqual({kind:'continue_build',builderIds:[worker.id],foundationId:'paid_house',queued:false});expect(state.resourceHandoff).toBeUndefined();
  });
  it('honors a model economy zero weight instead of restoring the personality wood allocation',()=>{
    const {view,state}=allocation();state.planGeneration=1;state.plan={generation:1,strategy:'Food',acceptedTick:1,expiresTick:2000,goals:[{key:'economy',kind:'economy',goal:{kind:'economy',weights:{food:100,wood:0,gold:0,stone:0},targetVillagers:6},status:'accepted',acceptedTick:1,expiresTick:2000,candidateIndex:0,attempts:0}]};
    commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();
  });
  it('cancels a traveling handoff when a new model economy explicitly removes its resource',()=>{
    const {view,state,workers}=allocation();commanderCommands(view,state);const workerId=state.resourceHandoff!.workerId;state.pending=[];workers.find(worker=>worker.id===workerId)!.order='move';
    state.planGeneration=1;state.plan={generation:1,strategy:'Food',acceptedTick:20,expiresTick:2000,goals:[{key:'economy',kind:'economy',goal:{kind:'economy',weights:{food:100,wood:0,gold:0,stone:0},targetVillagers:6},status:'accepted',acceptedTick:20,expiresTick:2000,candidateIndex:0,attempts:0}]};view.tick=25;
    commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();expect(commands(state)).toContainEqual({kind:'stop',unitIds:[workerId]});
  });
  it('chooses a closer ready owned farm for food and excludes a pending reseed claim',()=>{
    for(const claimed of [false,true]){const {view,state,source,workers}=allocation();source.resource='food';source.typeId='forage_patch';source.ghost=false;
      const farm:ViewEntity={id:'handoff_farm',kind:'building',typeId:'farm',ownerId:'blue',xMm:115000,zMm:100000,hp:450,maxHp:450,progress:1,farmState:'ready',resource:'food',amount:350,farmerAssigned:false};view.entities.push(farm);
      if(claimed)state.pending=[{observedTick:1,executeTick:40,commands:[{kind:'reseed_farm',farmId:farm.id,builderId:workers.at(-1)!.id}]}];
      commanderCommands(view,state);expect(state.resourceHandoff?.resourceId).toBe(claimed?source.id:farm.id);if(!claimed)expect(state.farmAssignments?.[farm.id]).toBe(state.resourceHandoff!.workerId);
    }
  });
  it.each(['depleted','missing','visible_enemy'] as const)('cancels a newly %s destination before its unpaid move is admitted',condition=>{
    const {view,state,source}=allocation();commanderCommands(view,state);const workerId=state.resourceHandoff!.workerId;
    if(condition==='depleted'){source.ghost=false;source.amount=0;}else if(condition==='missing')view.entities=view.entities.filter(entity=>entity.id!==source.id);else view.entities.push({id:'danger',kind:'unit',typeId:'archer',ownerId:'red',xMm:source.xMm,zMm:source.zMm,hp:40,maxHp:40});
    view.tick=25;const due=commanderCommands(view,state);expect(due.some(proposal=>proposal.command.kind==='move'&&proposal.command.unitIds.includes(workerId))).toBe(false);expect(commands(state)).toContainEqual({kind:'stop',unitIds:[workerId]});expect(state.resourceHandoff).toBeUndefined();
  });
  it('uses observed progress and a bounded cooldown without treating a blocked route as hidden depletion',()=>{
    const {view,state,workers,source}=allocation();commanderCommands(view,state);const worker=workers.find(worker=>worker.id===state.resourceHandoff!.workerId)!;state.pending=[];worker.order='move';worker.taskState='blocked';
    view.tick=600;worker.xMm+=2000;commanderCommands(view,state);expect(state.resourceHandoff?.lastProgressTick).toBe(600);
    view.tick=1200;commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();expect(source.amount).toBe(250);expect(state.resourceHandoffCooldown).toEqual({resourceId:source.id,untilTick:1800});
    state.pending=[];worker.order='idle';worker.taskState='idle';view.tick=1205;commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();
  });
  it('ignores remembered mobile enemies but does not send a worker past a currently visible enemy',()=>{
    const {view,state,source}=allocation(),hidden=structuredClone(view);hidden.entities.push({id:'old_enemy',kind:'unit',typeId:'archer',ownerId:'red',xMm:120000,zMm:100000,hp:40,maxHp:40,ghost:true,lastSeenTick:1});
    commanderCommands(view,state);const other=createCommanderState(view.matchId,view.playerId);Object.assign(other,{assignments:Object.fromEntries(view.entities.filter(entity=>entity.typeId==='villager').map(worker=>[worker.id,'gold'])),nextStrategicTick:100000,nextScoutTick:100000});commanderCommands(hidden,other);expect(other.resourceHandoff).toEqual(state.resourceHandoff);
    const danger=allocation();danger.view.entities.push({id:'enemy_at_source',kind:'unit',typeId:'archer',ownerId:'red',xMm:source.xMm,zMm:source.zMm,hp:40,maxHp:40});commanderCommands(danger.view,danger.state);expect(danger.state.resourceHandoff).toBeUndefined();
  });
  it('stops an ongoing trip as its worker approaches a newly visible enemy without inventing its unreported path',()=>{
    const {view,state,workers}=allocation();commanderCommands(view,state);const worker=workers.find(worker=>worker.id===state.resourceHandoff!.workerId)!;state.pending=[];worker.order='move';worker.taskState='moving';worker.xMm=100000;worker.zMm=100000;
    view.entities.push({id:'new_route_enemy',kind:'unit',typeId:'militia',ownerId:'red',xMm:120000,zMm:100000,hp:70,maxHp:70});view.tick=30;commanderCommands(view,state);
    // Only the initial checked route and current endpoint proximity are known;
    // the policy has no private path trace for the accepted movement command.
    expect(state.resourceHandoff?.workerId).toBe(worker.id);expect(commands(state).some(command=>command.kind==='stop')).toBe(false);
    worker.xMm=112000;view.tick=35;commanderCommands(view,state);expect(state.resourceHandoff).toBeUndefined();expect(commands(state)).toContainEqual({kind:'stop',unitIds:[worker.id]});
  });
  it('makes identical handoffs from paired worlds with hidden depletion and a hidden enemy',()=>{
    const {sim,scout}=fixture();sim.state.factions[0]!.difficulty='hard';sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:0};sim.state.economies.blue!.autoReseed=true;
    const source={id:'private_trip_wood',kind:'resource' as const,typeId:'tree',ownerId:null,xMm:170000,zMm:90000,hp:1,maxHp:1,resource:'wood' as const,amount:250000};sim.state.entities[source.id]=source;sim.state.navigationRevision++;scout.xMm=source.xMm;scout.zMm=source.zMm+5000;sim.step();expect(send(sim,{kind:'move',unitIds:[scout.id],target:{xMm:240000,zMm:90000},queued:false}).status).toBe('accepted');sim.step(200);
    const other=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});(other.state.entities[source.id] as typeof source).amount=0;
    const enemy=structuredClone(Object.values(other.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!);Object.assign(enemy,{id:'unseen_enemy',ownerId:'red',xMm:source.xMm,zMm:source.zMm});other.state.entities[enemy.id]=enemy;other.state.navigationRevision++;
    sim.step(3);other.step(3);const left=sim.view('blue'),right=other.view('blue');expect(right).toEqual(left);expect(left.entities.find(entity=>entity.id===source.id)).toMatchObject({ghost:true,amount:250});
    const a=createCommanderState(sim.state.matchId,'blue'),b=createCommanderState(sim.state.matchId,'blue');a.nextScoutTick=b.nextScoutTick=100000;a.nextStrategicTick=b.nextStrategicTick=100000;commanderCommands(left,a);commanderCommands(right,b);expect(a.resourceHandoff?.phase).toBe('move');expect(b).toEqual(a);
  });
  it('rejects malformed saved handoffs and foreign worker or out-of-map replay references',()=>{
    const {sim,view,state,workers}=allocation();commanderCommands(view,state);expect(validateCommanderMemory(state,'blue',view.tick)).toBe(true);
    for(const patch of [{phase:'teleport'},{issuedTick:view.tick+1},{lastProgressTick:view.tick+1},{expiresTick:1},{target:{xMm:NaN,zMm:0}},{hiddenAmount:999}]){const bad=structuredClone(state);Object.assign(bad.resourceHandoff!,patch);expect(validateCommanderMemory(bad,'blue',view.tick)).toBe(false);}
    // Match the actual fixture tick for the structural save and replay boundary.
    const active=structuredClone(state.resourceHandoff!);active.issuedTick=sim.state.tick;active.lastProgressTick=sim.state.tick;sim.state.controllers.blue!.resourceHandoff=active;const payload=sim.capture();expect(validateSimulationSavePayload(payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const foreign=Object.values(sim.state.entities).find(entity=>entity.ownerId==='red')!;for(const change of [{workerId:foreign.id},{target:{xMm:sim.state.widthMm+1,zMm:1}}]){const bad=structuredClone(payload);Object.assign(bad.state.controllers.blue!.resourceHandoff!,change);expect(validateSimulationSavePayload(bad)).toBe(false);}
    sim.enableReplay(()=>undefined);const before=sim.capture();for(const change of [{workerId:foreign.id},{target:{xMm:sim.state.widthMm+1,zMm:1}}])expect(()=>sim.applyJournalEvent({ordinal:sim.state.eventOrdinal+1,tick:sim.state.tick,phase:'boundary',kind:'commander_patch',playerId:'blue',patches:[{path:['resourceHandoff'],value:{...active,...change}}]})).toThrow('INVALID_COMMANDER_PATCH');expect(sim.capture()).toEqual(before);expect(workers).toHaveLength(6);
  });
  it('executes remembered move then freshly visible gather, and restores/replays the real trip exactly',()=>{
    const {sim,scout,workers}=fixture();sim.state.factions[0]!.difficulty='hard';sim.state.economies.blue!.resources={food:0,wood:0,gold:0,stone:0};sim.state.economies.blue!.autoReseed=true;
    const source={id:'remote_trip_wood',kind:'resource' as const,typeId:'tree',ownerId:null,xMm:170000,zMm:90000,hp:1,maxHp:1,resource:'wood' as const,amount:250000};sim.state.entities[source.id]=source;sim.state.navigationRevision++;scout.xMm=source.xMm;scout.zMm=source.zMm+5000;sim.step();expect(sim.view('blue').entities.find(entity=>entity.id===source.id)?.ghost).not.toBe(true);
    expect(send(sim,{kind:'move',unitIds:[scout.id],target:{xMm:240000,zMm:90000},queued:false}).status).toBe('accepted');sim.step(200);expect(sim.view('blue').entities.find(entity=>entity.id===source.id)?.ghost).toBe(true);
    const memory=sim.state.controllers.blue!;memory.nextStrategicTick=100000;memory.nextScoutTick=100000;sim.options.controllers=true;const initial=exportSimulationSave(sim,identity);sim.drainJournal();
    let copy:Simulation|undefined,sawMove=false,sawGather=false,workerId='';
    for(let tick=0;tick<1500&&!sawGather;tick++){
      sim.step();copy?.step();const handoff=sim.state.controllers.blue!.resourceHandoff;
      if(handoff?.phase==='move'){sawMove=true;workerId=handoff.workerId;if(!copy&&sim.state.entities[workerId]!.xMm>100000){copy=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(copy.capture()).toEqual(sim.capture());}}
      if(workerId){const worker=sim.state.entities[workerId] as Unit;sawGather=worker.cargo.resource==='wood'&&worker.cargo.amount>0;}
    }
    expect(sawMove).toBe(true);expect(copy).toBeDefined();expect(sawGather).toBe(true);expect(copy!.capture()).toEqual(sim.capture());expect(workers.every(worker=>worker.hp>0)).toBe(true);
    const commands=sim.state.commandLog.map(entry=>entry.envelope.command);expect(commands.some(command=>command.kind==='gather'&&command.targetId===source.id)).toBe(true);expect(sim.state.controllers.blue!.memory.recentReceipts.every(receipt=>receipt.status==='accepted')).toBe(true);
    const replay=new ReplayRunner(createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(replay.simulation.capture()).toEqual(sim.capture());
  },30000);
});

describe('AI missing-scout replacement through ordinary simulation',()=>{
  function missingScout(){
    const rig=fixture(),{sim,unit,scout,workers}=rig;delete sim.state.entities[scout.id];
    for(let index=workers.length;index<balance.ai.rulePolicies.medium.targetWorkers;index++)unit('villager',70000+(index%5)*1500,104000+Math.floor(index/5)*1500);
    const source={id:'scout_discovered_wood',kind:'resource' as const,typeId:'wood_oak',ownerId:null,xMm:120000,zMm:116000,hp:1,maxHp:1,resource:'wood' as const,amount:250000};sim.state.entities[source.id]=source;sim.state.navigationRevision++;
    // A controlled unexplored frontier makes this a replacement/discovery
    // integration test, independent of the generator's incidental first route.
    // No source entity enters memory before ordinary scout sight discovers it.
    const cell=balance.rules.fogGridM*1000,width=sim.state.widthMm/cell,height=sim.state.heightMm/cell;sim.state.vision.blue!.explored=Array.from({length:width*height},(_,id)=>id).filter(id=>Math.hypot((id%width+.5)*cell-source.xMm,(Math.floor(id/width)+.5)*cell-source.zMm)>10000);
    sim.state.economies.blue!.resources={food:units.scout.cost.food*balance.rules.resourceScale,wood:0,gold:0,stone:0};sim.state.economies.blue!.autoReseed=true;
    const memory=sim.state.controllers.blue!;memory.nextStrategicTick=100000;memory.nextScoutTick=0;memory.scoutIndex=1;sim.step();expect(sim.view('blue').entities.some(entity=>entity.id===source.id)).toBe(false);
    return {...rig,source,memory};
  }
  it('keeps a model worker proposal and its due producer reservation ahead of a replacement Scout',()=>{
    const {sim,memory}=missingScout();sim.state.economies.blue!.resources.food=1000000;const view=sim.view('blue');view.tick=10;
    memory.mode='model';memory.planGeneration=1;memory.plan={generation:1,strategy:'Replace worker first',acceptedTick:0,expiresTick:2000,goals:[{key:'units:villager',kind:'ensure_units',goal:{kind:'ensure_units',unitType:'villager',targetCount:balance.ai.rulePolicies.medium.targetWorkers+1},status:'accepted',acceptedTick:0,expiresTick:2000,candidateIndex:0,attempts:0}]};
    commanderCommands(view,memory);expect(memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='train')).toEqual([{kind:'train',buildingId:view.entities.find(entity=>entity.typeId==='town_center'&&entity.ownerId==='blue')!.id,unitType:'villager',quantity:1}]);
    view.tick+=Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz);expect(commanderCommands(view,memory).filter(proposal=>proposal.command.kind==='train')).toMatchObject([{command:{kind:'train',unitType:'villager',quantity:1}}]);expect(memory.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='train'&&command.unitType==='scout')).toBe(false);
  });
  it('pays for one missing Scout, explores unknown wood, gathers and deposits with exact pending save/replay',()=>{
    const {sim,home,source,memory}=missingScout();sim.options.controllers=true;const initial=exportSimulationSave(sim,identity),beforeQueue=restoreSimulation(initial,identity,{preserveEpoch:true}),hidden=restoreSimulation(initial,identity,{preserveEpoch:true});
    (hidden.state.entities[source.id] as typeof source).amount=0;const unseen=structuredClone(Object.values(hidden.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!);Object.assign(unseen,{id:'unobserved_scout_test_enemy',ownerId:'red',xMm:source.xMm,zMm:source.zMm});hidden.state.entities[unseen.id]=unseen;hidden.state.navigationRevision++;sim.drainJournal();
    const policy=balance.ai.difficulty.medium,cadence=policy.tacticalIntervalSeconds*balance.rules.simulationHz,toDecision=cadence-sim.state.tick%cadence;
    for(const world of [sim,beforeQueue,hidden])world.step(toDecision);expect(beforeQueue.capture()).toEqual(sim.capture());expect(hidden.view('blue')).toEqual(sim.view('blue'));expect(hidden.state.controllers.blue).toEqual(memory);
    const planned=memory.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='train'&&command.unitType==='scout');expect(planned).toEqual([{kind:'train',buildingId:home.id,unitType:'scout',quantity:1}]);expect(home.queue).toEqual([]);expect(sim.state.economies.blue!.resources.food).toBe(units.scout.cost.food*balance.rules.resourceScale);
    const pendingCopy=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});for(const world of [sim,beforeQueue,pendingCopy,hidden])world.step(Math.ceil(policy.reactionDelaySeconds*balance.rules.simulationHz));
    expect(beforeQueue.capture()).toEqual(sim.capture());expect(pendingCopy.capture()).toEqual(sim.capture());expect(hidden.view('blue')).toEqual(sim.view('blue'));expect(hidden.state.controllers.blue).toEqual(memory);
    expect(home.queue).toMatchObject([{kind:'train',typeId:'scout'}]);expect(sim.state.economies.blue!.resources.food).toBe(0);expect(sim.state.economies.blue!.spent.food).toBe(units.scout.cost.food*balance.rules.resourceScale);
    let scoutId='',sawScoutMove=false,sawVisibleSource=false,sawGather=false,sawDeposit=false,commandCursor=sim.state.commandLog.length;
    for(let tick=0;tick<3000&&!sawDeposit;tick++){
      const collected=sim.state.economies.blue!.collected.wood;sim.step();pendingCopy.step();const scout=Object.values(sim.state.entities).find(entity=>entity.ownerId==='blue'&&entity.typeId==='scout');if(scout)scoutId=scout.id;
      for(const event of sim.state.commandLog.slice(commandCursor)){const command=event.envelope.command;
        if(command.kind==='move'&&command.unitIds.includes(scoutId))sawScoutMove=true;
        if(command.kind==='gather'&&command.targetId===source.id){expect(sim.view('blue').entities.find(entity=>entity.id===source.id)).toMatchObject({resource:'wood',amount:expect.any(Number)});expect(sim.view('blue').entities.find(entity=>entity.id===source.id)?.ghost).not.toBe(true);sawGather=true;}
      }commandCursor=sim.state.commandLog.length;
      sawVisibleSource ||= sim.state.vision.blue!.memory[source.id]!==undefined;sawDeposit ||= sim.state.economies.blue!.collected.wood>collected;
    }
    expect(scoutId).not.toBe('');expect(sawScoutMove).toBe(true);expect(sawVisibleSource,JSON.stringify({scout:sim.state.entities[scoutId],sawGather,sawDeposit})).toBe(true);expect(sawGather).toBe(true);expect(sawDeposit).toBe(true);expect(pendingCopy.capture()).toEqual(sim.capture());
    expect(sim.state.commandLog.filter(event=>event.playerId==='blue'&&event.envelope.command.kind==='train'&&event.envelope.command.unitType==='scout')).toHaveLength(1);
    expect(sim.state.economies.blue!.ledger.filter(entry=>entry.resource==='food'&&entry.reason==='training').reduce((sum,entry)=>sum-entry.deltaMilli,0)).toBe(units.scout.cost.food*balance.rules.resourceScale);
    const replay=new ReplayRunner(createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(replay.simulation.capture()).toEqual(sim.capture());
  },60000);
});

describe('M6 policy differences without bonuses or extra knowledge',()=>{
  function view(difficulty:'easy'|'medium'|'hard',personality:'builder'|'raider'|'marshal'|'steward'|'diplomat'='marshal'):PlayerView{const rig=fixture(),view=rig.sim.view('blue');view.players[0]!.difficulty=difficulty;view.players[0]!.personality=personality;view.tick=20;return view;}
  function foodAllocation(workerCount=2){
    const observation=view('hard','raider'),workers=observation.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager').slice(0,workerCount);
    workers.forEach((worker,index)=>{worker.xMm=100000+index*1500;worker.zMm=100000;worker.order='idle';worker.taskState='idle';});
    const farm:ViewEntity={id:'local_farm',kind:'building',typeId:'farm',ownerId:'blue',xMm:110000,zMm:100000,hp:buildings.farm.maxHp,maxHp:buildings.farm.maxHp,progress:1,resource:'food',amount:350,farmState:'ready',farmerAssigned:false};
    const forage:ViewEntity={id:'distant_food',kind:'resource',typeId:'forage_patch',ownerId:null,xMm:250000,zMm:100000,hp:1,maxHp:1,resource:'food',amount:1000};
    observation.entities=[...observation.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='town_center'),...workers,farm,forage];observation.self.resources={food:0,wood:0,gold:0,stone:0};observation.self.autoReseed=true;
    const state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=100000;state.nextScoutTick=100000;
    return {observation,state,workers,farm,forage};
  }
  const fillProposalQueue=(state:CommanderState)=>{state.pending=Array.from({length:59},(_,index)=>({observedTick:1,executeTick:1000,commands:[{kind:'move' as const,unitIds:[`previous_unit_${index}`],target:{xMm:10000,zMm:10000},queued:false}]}));};
  it('allocates personality food to the nearer owned farm and reserves it through fallback',()=>{
    const {observation,state,workers,farm,forage}=foodAllocation(),before=structuredClone(observation);commanderCommands(observation,state);
    const gathers=state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='gather');
    expect(gathers).toEqual([{kind:'gather',unitIds:[workers[0]!.id],targetId:farm.id,queued:false},{kind:'gather',unitIds:[workers[1]!.id],targetId:forage.id,queued:false}]);
    expect(state.farmAssignments).toEqual({[farm.id]:workers[0]!.id});expect(state.assignments?.[workers[0]!.id]).toBe('food');expect(observation).toEqual(before);
  });
  it('retains personality distance ordering when natural food is nearer than a ready farm',()=>{
    const {observation,state,workers,forage}=foodAllocation(1);forage.xMm=101000;commanderCommands(observation,state);
    expect(state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='gather')).toEqual([{kind:'gather',unitIds:[workers[0]!.id],targetId:forage.id,queued:false}]);expect(state.farmAssignments).toEqual({});
  });
  it.each(['occupied','exhausted','foundation','enemy','ghost','reseeding'] as const)('excludes a %s farm from personality food allocation',condition=>{
    const {observation,state,farm,forage}=foodAllocation(1);
    if(condition==='occupied')farm.farmerAssigned=true;else if(condition==='exhausted'){farm.amount=0;farm.farmState='exhausted';}else if(condition==='foundation')farm.progress=.5;else if(condition==='enemy')farm.ownerId='red';else if(condition==='ghost')farm.ghost=true;else farm.farmState='reseeding';
    commanderCommands(observation,state);expect(state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='gather').map(command=>command.targetId)).toEqual([forage.id]);expect(state.farmAssignments).toEqual({});
  });
  it.each(['gather','reseed_farm'] as const)('reserves the farm and worker for pending and due %s proposals',kind=>{
    for(const due of [false,true]){
      const {observation,state,workers,farm,forage}=foodAllocation(),command:GameplayCommand=kind==='gather'?{kind,unitIds:[workers[0]!.id],targetId:farm.id,queued:false}:{kind,farmId:farm.id,builderId:workers[0]!.id};
      state.farmAssignments={[farm.id]:workers[0]!.id};state.pending=[{observedTick:1,executeTick:due?observation.tick:40,commands:[command]}];
      const returned=commanderCommands(observation,state),all=[...returned.map(proposal=>proposal.command),...state.pending.flatMap(batch=>batch.commands)];
      expect(all.filter(item=>item.kind==='gather'&&item.targetId===farm.id||item.kind==='reseed_farm'&&item.farmId===farm.id)).toEqual([command]);
      expect(all.filter(item=>'unitIds'in item&&item.unitIds.includes(workers[0]!.id)||'builderId'in item&&item.builderId===workers[0]!.id)).toEqual([command]);
      expect(all).toContainEqual({kind:'gather',unitIds:[workers[1]!.id],targetId:forage.id,queued:false});
    }
  });
  it('keeps a returning farmer reservation and releases it after a failed assignment',()=>{
    const {observation,state,workers,farm,forage}=foodAllocation();workers[0]!.order='gather';workers[0]!.taskState='returning';state.farmAssignments={[farm.id]:workers[0]!.id};state.assignments={[workers[0]!.id]:'food'};
    commanderCommands(observation,state);expect(state.farmAssignments?.[farm.id]).toBe(workers[0]!.id);expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'gather',unitIds:[workers[1]!.id],targetId:forage.id,queued:false});
    state.pending=[];workers[0]!.taskState='blocked';workers[0]!.blockedReason='FARM_OCCUPIED';observation.tick=40;commanderCommands(observation,state);
    expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'gather',unitIds:[workers[1]!.id],targetId:farm.id,queued:false});expect(state.farmAssignments?.[farm.id]).toBe(workers[1]!.id);
  });
  it.each(['missing','idle','changed_pending'] as const)('releases a %s farm reservation before assigning another worker',condition=>{
    const {observation,state,workers,farm}=foodAllocation();state.farmAssignments={[farm.id]:condition==='missing'?'dead_worker':workers[0]!.id};
    if(condition==='changed_pending'){workers[0]!.order='gather';state.pending=[{observedTick:1,executeTick:40,commands:[{kind:'move',unitIds:[workers[0]!.id],target:{xMm:120000,zMm:100000},queued:false}]}];}
    commanderCommands(observation,state);const worker=condition==='changed_pending'?workers[1]!:workers[0]!;
    expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual({kind:'gather',unitIds:[worker.id],targetId:farm.id,queued:false});expect(state.farmAssignments?.[farm.id]).toBe(worker.id);
  });
  it('does not leave phantom food or farm assignments when the personality proposal queue is full',()=>{
    const {observation,state,workers,farm}=foodAllocation(1);fillProposalQueue(state);commanderCommands(observation,state);
    // The reserved final batch remains available to caretaker. A rejected
    // personality proposal must not make its farm unavailable to that batch.
    const gathers=state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='gather');expect(gathers).toEqual([{kind:'gather',unitIds:[workers[0]!.id],targetId:farm.id,queued:false}]);expect(state.farmAssignments).toEqual({[farm.id]:workers[0]!.id});
    const goldOnly=foodAllocation(1);goldOnly.observation.entities=goldOnly.observation.entities.filter(entity=>entity.id!==goldOnly.farm.id);goldOnly.forage.resource='gold';goldOnly.forage.typeId='gold_deposit';fillProposalQueue(goldOnly.state);commanderCommands(goldOnly.observation,goldOnly.state);
    expect(goldOnly.state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='gather')).toBe(false);expect(goldOnly.state.assignments?.[goldOnly.workers[0]!.id]).toBeUndefined();
  });
  it('does not advance the Hard scouting cursor when a full proposal queue rejects its move',()=>{
    const observation=view('hard'),scout=observation.entities.find(entity=>entity.typeId==='scout')!,state=createCommanderState(observation.matchId,observation.playerId);scout.xMm=50000;scout.zMm=140000;scout.order='idle';state.nextStrategicTick=10000;fillProposalQueue(state);
    commanderCommands(observation,state);expect(state.scoutIndex).toBe(0);expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toBe(false);
  });
  it.each(['easy','medium','hard'] as const)('preserves %s scouting cursor during its cooldown and advances only its enabled planner',difficulty=>{
    const observation=view(difficulty),scout=observation.entities.find(entity=>entity.typeId==='scout')!,state=createCommanderState(observation.matchId,observation.playerId);
    scout.xMm=50000;scout.zMm=140000;scout.order='idle';state.nextScoutTick=80;state.nextStrategicTick=10000;
    for(const tick of [20,40,60]){observation.tick=tick;commanderCommands(observation,state);expect(state.scoutIndex).toBe(0);expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toBe(false);}
    observation.tick=80;commanderCommands(observation,state);const move=state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
    expect(move).toHaveLength(1);expect(state.scoutIndex).toBe(1);
    if(difficulty==='hard')expect(move[0]).toMatchObject({target:{xMm:22000,zMm:140000}});
  });
  it('continues Hard frontier exploration beyond the old four-corner loop and discovers only physically visible remote resources',()=>{
    const {sim,scout}=fixture();sim.state.factions[0]!.difficulty='hard';scout.xMm=150000;scout.zMm=150000;
    for(const [resource,zMm]of [['wood',145000],['gold',155000]] as const)sim.state.entities[`remote_${resource}`]={id:`remote_${resource}`,kind:'resource',typeId:resource==='wood'?'tree':'gold_deposit',ownerId:null,xMm:122000,zMm,hp:1,maxHp:1,resource,amount:1000000};
    sim.state.navigationRevision++;sim.step(4);const before=sim.view('blue'),state=createCommanderState(sim.state.matchId,'blue'),destinations:{xMm:number;zMm:number}[]=[],counts:number[]=[];state.nextStrategicTick=10000;
    expect(before.entities.some(entity=>entity.id.startsWith('remote_'))).toBe(false);
    for(let tick=0;tick<1650;tick++){
      const observation=sim.view('blue');for(const proposal of commanderCommands(observation,state))if(proposal.command.kind==='move'&&proposal.command.unitIds.includes(scout.id)){
        expect(send(sim,proposal.command).status).toBe('accepted');destinations.push(proposal.command.target);counts.push(observation.fog.explored.length);
      }sim.step();
    }
    const after=sim.view('blue');expect(destinations.length).toBeGreaterThanOrEqual(8);expect(new Set(destinations.map(point=>`${point.xMm},${point.zMm}`)).size).toBe(destinations.length);
    expect(destinations.some(point=>Math.hypot(point.xMm-150000,point.zMm-150000)>60000)).toBe(true);expect(counts[7]!).toBeGreaterThan(counts[3]!+400);expect(after.fog.explored.length).toBeGreaterThan(before.fog.explored.length+1200);
    expect(after.entities.filter(entity=>entity.id.startsWith('remote_')).map(entity=>entity.id).sort()).toEqual(['remote_gold','remote_wood']);
  });
  it('preserves a progressing Hard Scout route through multiple scout intervals and reconsiders a public blockage',()=>{
    const observation=view('hard'),scout=observation.entities.find(entity=>entity.typeId==='scout')!,state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=10000;scout.order='move';scout.taskState='moving';scout.xMm=150000;scout.zMm=150000;
    for(const tick of [20,180,340]){observation.tick=tick;commanderCommands(observation,state);expect(state.scoutIndex).toBe(0);expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toBe(false);}
    observation.tick=500;scout.taskState='blocked';scout.blockedReason='STATIC_OBSTRUCTION';commanderCommands(observation,state);expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toBe(true);expect(state.scoutIndex).toBe(1);
  });
  it('routes Hard exploration around a known closed gate when the only novel cells lie beyond it',()=>{
    const {sim,structure,scout}=fixture();sim.state.factions[0]!.difficulty='hard';scout.xMm=50000;scout.zMm=140000;const gate=structure('wooden_gate',44000,140000);gate.rotation=90;gate.gateMode='LOCKED';gate.gateOpen=false;sim.step(4);
    const observation=sim.view('blue'),width=observation.map.widthMm/observation.map.fogCellMm,height=observation.map.heightMm/observation.map.fogCellMm;observation.fog.explored=Array.from({length:width*height},(_,id)=>id).filter(id=>!(id%width===11&&Math.floor(id/width)===70));
    const state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=10000;commanderCommands(observation,state);const proposal=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
    expect(proposal?.kind).toBe('move');if(proposal?.kind!=='move')throw Error('SCOUT_MOVE_MISSING');const nav=new Navigation(sim.state.widthMm,sim.state.heightMm,fortificationObstacles(gate)),radius=units.scout.collisionRadiusM*1000;
    expect(nav.clearLine(scout,proposal.target,radius)).toBe(false);expect(send(sim,proposal).status).toBe('accepted');
    for(let tick=0;tick<200&&scout.orders.length;tick++){const before={xMm:scout.xMm,zMm:scout.zMm};sim.step();expect(nav.clearLine(before,scout,radius)).toBe(true);}
    expect(Math.hypot(scout.xMm-proposal.target.xMm,scout.zMm-proposal.target.zMm)).toBeLessThanOrEqual(100);expect(scout.orders).toEqual([]);expect(gate.gateOpen).toBe(false);
  });
  it('prioritizes unexplored Hard frontiers over stale enemy revisits and avoids visible threats',()=>{
    const observation=view('hard'),scout=observation.entities.find(entity=>entity.typeId==='scout')!;scout.xMm=150000;scout.zMm=150000;observation.tick=1000;
    observation.entities.push({id:'old_enemy',kind:'building',typeId:'house',ownerId:'red',xMm:180000,zMm:180000,hp:600,maxHp:600,ghost:true,lastSeenTick:1},{id:'visible_threat',kind:'unit',typeId:'militia',ownerId:'red',xMm:130000,zMm:150000,hp:70,maxHp:70});
    const state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=10000;commanderCommands(observation,state);const proposal=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
    expect(proposal).toMatchObject({kind:'move',target:{xMm:150000,zMm:122000}});expect(observation.entities.find(entity=>entity.id==='old_enemy')!.lastSeenTick).toBe(1);
    observation.fog.explored=Array.from({length:observation.map.widthMm*observation.map.heightMm/observation.map.fogCellMm**2},(_,id)=>id);const revisiting=createCommanderState(observation.matchId,observation.playerId);revisiting.nextStrategicTick=10000;commanderCommands(observation,revisiting);expect(revisiting.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toMatchObject({target:{xMm:192000,zMm:192000}});
  });
  it('bounds failed Hard frontier route work and defers without a partial command',()=>{
    const observation=view('hard'),scout=observation.entities.find(entity=>entity.typeId==='scout')!;scout.xMm=150000;scout.zMm=150000;
    observation.map.terrain=[{id:'north',kind:'water',xMm:130000,zMm:130000,widthMm:40000,depthMm:2000,elevationMm:0},{id:'south',kind:'water',xMm:130000,zMm:168000,widthMm:40000,depthMm:2000,elevationMm:0},{id:'west',kind:'water',xMm:130000,zMm:130000,widthMm:2000,depthMm:40000,elevationMm:0},{id:'east',kind:'water',xMm:168000,zMm:130000,widthMm:2000,depthMm:40000,elevationMm:0}];
    const budgets=new Set<{remaining:number;used:number}>(),original=Navigation.prototype.clearLine,probe=vi.spyOn(Navigation.prototype,'clearLine').mockImplementation(function(this:Navigation,...args:Parameters<Navigation['clearLine']>){if(this.workBudget)budgets.add(this.workBudget);return original.apply(this,args);});
    try{const state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=10000;commanderCommands(observation,state);expect(budgets.size).toBe(1);expect([...budgets][0]).toEqual({remaining:0,used:8000});expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))).toBe(false);expect(state.scoutIndex).toBe(0);expect(state.nextScoutTick).toBe(180);}finally{probe.mockRestore();}
  });
  it('rotates bounded Hard frontier probes so inaccessible high-gain choices cannot starve a reachable frontier',()=>{
    const observation=view('hard'),scout=observation.entities.find(entity=>entity.typeId==='scout')!;scout.xMm=150000;scout.zMm=150000;
    // The retained public-barrier waypoint optimization can route around a
    // finite strip. Close both ends at the map bounds so these tempting west
    // frontiers really are unreachable; opacity also prevents near-bank sight.
    observation.map.terrain=[{id:'long_barrier',kind:'ridge',xMm:138000,zMm:0,widthMm:4000,depthMm:observation.map.heightMm,elevationMm:18000}];const width=observation.map.widthMm/observation.map.fogCellMm,height=observation.map.heightMm/observation.map.fogCellMm;
    observation.fog.explored=Array.from({length:width*height},(_,id)=>id).filter(id=>{const x=(id%width+.5)*2000,z=(Math.floor(id/width)+.5)*2000;return !(x>=110000&&x<=132000&&z>=110000&&z<=190000)&&!(x===191000&&z===151000);});
    const state=createCommanderState(observation.matchId,observation.playerId);state.nextStrategicTick=10000;let proposal:GameplayCommand|undefined,decisions=0;
    for(let tick=20;tick<20+160*16&&!proposal;tick+=160){observation.tick=tick;commanderCommands(observation,state);decisions++;proposal=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));}
    expect(decisions).toBeGreaterThan(1);expect(decisions).toBeLessThanOrEqual(16);expect(proposal?.kind).toBe('move');if(proposal?.kind!=='move')throw Error('REACHABLE_FRONTIER_STARVED');expect(proposal.target.xMm,JSON.stringify(proposal)).toBeGreaterThan(scout.xMm);expect(state.scoutIndex).toBe(1);
  });
  it.each([0,90] as const)('plans and traverses a publicly open gate at rotation %s with ordinary Scout movement',rotation=>{
    const {sim,structure,scout}=fixture();sim.state.factions[0]!.difficulty='hard';scout.xMm=50000;scout.zMm=140000;
    const gate=structure('wooden_gate',rotation===90?44000:50000,rotation===90?140000:134000);gate.rotation=rotation;gate.gateMode='OPEN';gate.gateOpen=true;sim.step(4);
    const state=createCommanderState(sim.state.matchId,'blue');state.scoutIndex=rotation===90?0:1;state.nextStrategicTick=10000;const observation=sim.view('blue'),width=observation.map.widthMm/observation.map.fogCellMm,height=observation.map.heightMm/observation.map.fogCellMm;
    // Leave the next unexplored cell across the opening; nearby gate vision
    // otherwise legitimately makes a different direction more informative.
    const frontierCell=rotation===90?70*width+9:54*width+25;observation.fog.explored=Array.from({length:width*height},(_,id)=>id).filter(id=>id!==frontierCell);commanderCommands(observation,state);
    const target=rotation===90?{xMm:22000,zMm:140000}:{xMm:50000,zMm:112000},proposal=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
    expect(proposal).toEqual({kind:'move',unitIds:[scout.id],target,queued:false});
    sim.step(5);const due=commanderCommands(sim.view('blue'),state).find(proposal=>proposal.command.kind==='move'&&proposal.command.unitIds.includes(scout.id));expect(due?.command).toEqual(proposal);expect(send(sim,due!.command).status).toBe('accepted');
    const nav=new Navigation(sim.state.widthMm,sim.state.heightMm,fortificationObstacles(gate)),radius=units.scout.collisionRadiusM*1000;
    for(let tick=0;tick<160&&scout.orders.length;tick++){const before={xMm:scout.xMm,zMm:scout.zMm};sim.step();expect(nav.clearLine(before,scout,radius)).toBe(true);}
    expect(Math.hypot(scout.xMm-target.xMm,scout.zMm-target.zMm)).toBeLessThanOrEqual(100);expect(scout.orders).toEqual([]);
  });
  it('keeps closed gates, foundations and gate posts blocked without inventing allied modes',()=>{
    const base=view('hard'),scout=base.entities.find(entity=>entity.typeId==='scout')!;scout.xMm=50000;scout.zMm=140000;
    const gate={id:'observed_gate',kind:'building' as const,typeId:'wooden_gate',ownerId:'blue',xMm:44000,zMm:140000,hp:600,maxHp:600,progress:1,rotation:90 as const,gateMode:'OPEN' as const,gateOpen:true};base.entities.push(gate);
    const west={xMm:22000,zMm:140000},chosen=(input:PlayerView)=>{const state=createCommanderState(input.matchId,input.playerId);state.nextStrategicTick=10000;commanderCommands(input,state);return state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));};
    expect(chosen(base)).toMatchObject({target:west});
    const closed=structuredClone(base);Object.assign(closed.entities.find(entity=>entity.id===gate.id)!,{gateMode:'LOCKED',gateOpen:false});expect(chosen(closed)).not.toEqual(expect.objectContaining({target:west}));
    const unfinished=structuredClone(base);unfinished.entities.find(entity=>entity.id===gate.id)!.progress=.5;expect(chosen(unfinished)).not.toEqual(expect.objectContaining({target:west}));
    const post=structuredClone(base);post.entities.find(entity=>entity.id===gate.id)!.zMm-=2500;expect(chosen(post)).not.toEqual(expect.objectContaining({target:west}));
    const allied=structuredClone(closed),alliedGate=allied.entities.find(entity=>entity.id===gate.id)!;alliedGate.ownerId='ally';delete alliedGate.gateMode;
    expect(chosen(allied)).not.toEqual(expect.objectContaining({target:west}));alliedGate.gateOpen=true;expect(chosen(allied)).toMatchObject({target:west});
    // Only the owner's explicitly observed AUTO mode licenses anticipated opening.
    const automatic=structuredClone(closed);automatic.entities.find(entity=>entity.id===gate.id)!.gateMode='AUTO';expect(chosen(automatic)).toMatchObject({target:west});
  });
  it.each([['easy',40],['medium',16],['hard',5]] as const)('uses %s observation delay of %i ticks', (difficulty,delay)=>{const observation=view(difficulty),state=createCommanderState(observation.matchId,observation.playerId),before=structuredClone(observation);expect(commanderCommands(observation,state)).toEqual([]);expect(state.pending.length).toBeGreaterThan(0);expect(state.pending.every(batch=>batch.executeTick===20+delay)).toBe(true);expect(observation).toEqual(before);observation.tick=20+delay-1;expect(commanderCommands(observation,state)).toEqual([]);observation.tick=20+delay;expect(commanderCommands(observation,state).length).toBeGreaterThan(0);});
  it('uses preferred compositions for Easy and observed cavalry counters for Medium and Hard',()=>{
    for(const difficulty of ['easy','medium','hard'] as const){const observation=view(difficulty,'raider');observation.entities.push({id:'visible_knight',kind:'unit',typeId:'knight',ownerId:'red',xMm:94000,zMm:90000,hp:100,maxHp:100});const state=createCommanderState(observation.matchId,observation.playerId);commanderCommands(observation,state);const training=state.pending.flatMap(batch=>batch.commands).filter(command=>command.kind==='train');expect(training.some(command=>command.unitType==='spearman')).toBe(difficulty!=='easy');}
  });
  it('changes five actual resource preferences while leaving the same physical view unchanged',()=>{
    const selected:Record<string,string>={};for(const personality of ['builder','raider','marshal','steward','diplomat'] as const){const observation=view('medium',personality);for(const resource of balance.resourceOrder)observation.entities.push({id:resource,kind:'resource',typeId:resource==='food'?'forage_patch':resource==='wood'?'tree':`${resource}_deposit`,ownerId:null,xMm:85000,zMm:94000,hp:1,maxHp:1,resource,amount:1000});const state=createCommanderState(observation.matchId,observation.playerId);commanderCommands(observation,state);const first=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='gather');expect(first?.kind).toBe('gather');if(first?.kind==='gather')selected[personality]=first.targetId;}
    expect(selected.builder).toBe('wood');expect(selected.raider).toBe('food');expect(selected.steward).toBe('food');expect(Object.keys(selected)).toHaveLength(5);
  });
  it('applies five personality infrastructure/cooperation policies through real command proposals',()=>{
    const expected={builder:'watchtower',raider:'stable',marshal:'archery_range',steward:'market',diplomat:'market'};
    for(const personality of Object.keys(expected) as (keyof typeof expected)[]){const observation=view('medium',personality),state=createCommanderState(observation.matchId,observation.playerId);commanderCommands(observation,state);const proposals=state.pending.flatMap(batch=>batch.commands);expect(proposals.some(command=>command.kind==='build'&&command.buildingType===expected[personality]),personality).toBe(true);expect(proposals.some(command=>command.kind==='tribute')).toBe(personality==='diplomat');}
  });
  it('uses Hard focus fire, at most six safe kites, and siege deployment without resetting active attack paths',()=>{
    const observation=view('hard'),state=createCommanderState(observation.matchId,observation.playerId);
    for(let i=0;i<8;i++)observation.entities.push({id:`archer_${i}`,kind:'unit',typeId:'archer',ownerId:'blue',xMm:150000+i*500,zMm:150000,hp:40,maxHp:40,order:'idle'});
    observation.entities.push({id:'fighter',kind:'unit',typeId:'militia',ownerId:'blue',xMm:151000,zMm:158000,hp:70,maxHp:70,order:'idle'},{id:'already_attacking',kind:'unit',typeId:'militia',ownerId:'blue',xMm:153000,zMm:158000,hp:70,maxHp:70,order:'attack'},{id:'low_enemy',kind:'unit',typeId:'knight',ownerId:'red',xMm:153000,zMm:150000,hp:20,maxHp:100},{id:'healthy_enemy',kind:'unit',typeId:'militia',ownerId:'red',xMm:153000,zMm:153000,hp:70,maxHp:70},{id:'treb',kind:'unit',typeId:'trebuchet',ownerId:'blue',xMm:180000,zMm:180000,hp:100,maxHp:100,order:'idle',deploymentState:'packed'},{id:'enemy_house',kind:'building',typeId:'house',ownerId:'red',xMm:190000,zMm:180000,hp:600,maxHp:600,progress:1});
    commanderCommands(observation,state);const proposals=state.pending.flatMap(batch=>batch.commands),kites=proposals.filter(command=>command.kind==='move'&&command.unitIds.some(id=>id.startsWith('archer_')));expect(kites).toHaveLength(6);expect(proposals.some(command=>command.kind==='attack_target'&&command.targetId==='low_enemy'&&command.unitIds.includes('fighter'))).toBe(true);expect(proposals.some(command=>'unitIds'in command&&command.unitIds.includes('already_attacking'))).toBe(false);expect(proposals).toContainEqual({kind:'deploy',unitIds:['treb']});
  });
  it('keeps Easy planned base assaults before minute eight separate from self-defense',()=>{
    for(const defending of [false,true]){const observation=view('easy'),state=createCommanderState(observation.matchId,observation.playerId),home=observation.entities.find(entity=>entity.typeId==='town_center')!;observation.entities.push({id:'soldier',kind:'unit',typeId:'militia',ownerId:'blue',xMm:120000,zMm:120000,hp:70,maxHp:70,order:'idle'},{id:'enemy',kind:'building',typeId:'house',ownerId:'red',xMm:defending?home.xMm+18000:180000,zMm:defending?home.zMm:180000,hp:600,maxHp:600});commanderCommands(observation,state);expect(state.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='attack_target'&&command.targetId==='enemy')).toBe(defending);}
  });
});

describe('bounded fortification dispatch and affordability',()=>{
  function view():PlayerView{
    const structure=(id:string,typeId:BuildingId,xMm:number,zMm:number):ViewEntity=>({id,typeId,kind:'building',ownerId:'blue',xMm,zMm,hp:buildings[typeId].maxHp,maxHp:buildings[typeId].maxHp,progress:1,rotation:0,queue:[]});
    return {protocolVersion:2,contentHash,matchId:'fortify_policy',matchEpoch:1,tick:20,sequence:0,playerId:'blue',status:'RUNNING',map:{widthMm:200000,heightMm:200000,fogCellMm:2000,terrain:[]},self:{populationLimit:120,lastCommandSequence:0,resources:{food:0,wood:4,gold:0,stone:30},age:3,population:6,populationCap:120,reservedPopulation:0},players:[{id:'blue',name:'Blue',teamId:'blue',kind:'ai',difficulty:'medium',personality:'builder',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ff8844'}],entities:[structure('home','town_center',100000,100000),...(['lumber_camp','barracks','watchtower','university','siege_workshop'] as const).map((type,index)=>structure(type,type,30000+index*16000,30000)),...Array.from({length:6},(_,index):ViewEntity=>({id:`worker_${index}`,kind:'unit',typeId:'villager',ownerId:'blue',xMm:100000+index*1500,zMm:110000,hp:50,maxHp:50,order:'gather'}))],fog:{visible:Array.from({length:10000},(_,index)=>index),explored:Array.from({length:10000},(_,index)=>index)}};
  }
  function memory(observation:PlayerView){const state=createCommanderState(observation.matchId,observation.playerId);state.nextScoutTick=100000;return state;}
  // Actual local food prevents emergency farms from preempting the wall policy
  // under test; remembered/remote food no longer proves a sustainable village.
  function foodAvailable(observation:PlayerView){observation.entities.push({id:'available_forage',kind:'resource',typeId:'forage_patch',ownerId:null,xMm:126000,zMm:100000,hp:1,maxHp:1,resource:'food',amount:1000});}
  function fortification(commands:GameplayCommand[]){return commands.filter(command=>command.kind==='build_wall'||command.kind==='build'&&['wooden_gate','stone_gate'].includes(command.buildingType));}
  function desired(observation:PlayerView){const state=memory(observation);state.mode='model';state.nextStrategicTick=100000;state.planGeneration=1;state.planReferences={base:{ref:'base',kind:'own_base',entityId:'home',position:{xMm:100000,zMm:100000}}};state.plan={generation:1,strategy:'Fortify',acceptedTick:0,expiresTick:1800,goals:[{key:'fortify:home',kind:'fortify',status:'accepted',acceptedTick:0,expiresTick:1800,goal:{kind:'fortify',anchorRef:'base',material:'stone',radiusM:18},candidateIndex:0,attempts:0}]};return state;}
  it('defends an exposed economy in model mode across personalities without requiring a model fortify goal',()=>{
    for(const personality of ['builder','raider','marshal','steward','diplomat'] as const){
      const observation=view(),state=memory(observation);observation.players[0]!.personality=personality;state.mode='model';
      state.plan={generation:1,strategy:'Maintain economy',acceptedTick:0,expiresTick:1800,goals:[]};
      observation.entities.push({id:'observed_raider',kind:'unit',typeId:'light_cavalry',ownerId:'red',xMm:132000,zMm:120000,hp:100,maxHp:100,order:'idle'});
      const before=structuredClone(observation);commanderCommands(observation,state);
      expect(fortification(state.pending.flatMap(batch=>batch.commands)),personality).toMatchObject([{kind:'build',buildingType:'stone_gate'}]);
      expect(state.mode).toBe('model');expect(observation).toEqual(before);
    }
  });
  it('does not start discretionary defenses for unthreatened non-builder economies or seize human-held builders',()=>{
    const observation=view(),state=memory(observation);observation.players[0]!.personality='marshal';state.mode='model';commanderCommands(observation,state);
    expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);expect(state.fortifications.fallback).toBeUndefined();
    const held=view(),pilot=memory(held);held.players[0]!.kind='human';pilot.mode='model';
    commanderCommands(held,pilot,undefined,new Set(held.entities.filter(entity=>entity.typeId==='villager').map(entity=>entity.id)));
    expect(fortification(pilot.pending.flatMap(batch=>batch.commands))).toEqual([]);
  });
  it('keeps explicit model fortification exclusive and uses palisades when stone is unavailable',()=>{
    const observation=view(),state=desired(observation);state.nextStrategicTick=0;commanderCommands(observation,state);
    expect(state.fortifications.fallback).toBeUndefined();expect(fortification(state.pending.flatMap(batch=>batch.commands))).toHaveLength(1);
    const fulfilled=view(),completed=desired(fulfilled);completed.nextStrategicTick=0;completed.plan!.goals[0]!.status='fulfilled';commanderCommands(fulfilled,completed);expect(completed.fortifications.fallback).toBeUndefined();
    const scarce=view(),fallback=memory(scarce);foodAvailable(scarce);scarce.self.resources={food:1000,wood:500,gold:1000,stone:0};commanderCommands(scarce,fallback);
    expect(fortification(fallback.pending.flatMap(batch=>batch.commands))).toMatchObject([{kind:'build',buildingType:'wooden_gate'}]);
  });
  it('can defend beside one staffed optional foundation without redirecting that builder',()=>{
    const observation=view(),state=memory(observation);state.mode='model';
    observation.entities.push({id:'ongoing_market',kind:'building',typeId:'market',ownerId:'blue',xMm:150000,zMm:150000,hp:100,maxHp:buildings.market.maxHp,progress:.2});
    observation.entities.find(entity=>entity.id==='worker_0')!.order='build';
    observation.entities.find(entity=>entity.id==='worker_0')!.workTargetId='ongoing_market';
    commanderCommands(observation,state);
    expect(fortification(state.pending.flatMap(batch=>batch.commands))).toMatchObject([{kind:'build',buildingType:'stone_gate',builderIds:['worker_1']}]);
    expect(state.pending.flatMap(batch=>batch.commands).filter(command=>'builderIds' in command).every(command=>!command.builderIds.includes('worker_0'))).toBe(true);
  });
  it('keeps automatic fortification placement reservations while model assistance is active',()=>{
    const observation=view(),state=memory(observation);commanderCommands(observation,state);expect(state.fortifications.fallback?.layout).toBeDefined();
    const before=aiFortifyPlacementCells(observation,state);state.mode='model';expect(aiFortifyPlacementCells(observation,state)).toEqual(before);expect(before.length).toBeGreaterThan(0);
  });
  it('reserves the last farm wood instead of spending it on discretionary defenses',()=>{
    const observation=view(),state=memory(observation);state.mode='model';observation.self.age=4;observation.self.resources={food:0,wood:buildings.farm.cost.wood,gold:0,stone:30};
    commanderCommands(observation,state);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);
    expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual(expect.objectContaining({kind:'build',buildingType:'farm'}));
  });
  it('uses the actual stone gate and wall prices with low wood while retaining the early-age threshold',()=>{
    for(const stone of [29,30]){const observation=view(),state=memory(observation);observation.self.resources.stone=stone;commanderCommands(observation,state);const commands=fortification(state.pending.flatMap(batch=>batch.commands));expect(commands).toHaveLength(stone===30?1:0);if(stone===30)expect(commands[0]).toMatchObject({kind:'build',buildingType:'stone_gate'});else expect(state.fortifications.fallback?.pendingUntilTick).toBeUndefined();expect(observation.self.resources).toEqual({food:0,wood:4,gold:0,stone});}
    const observation=view(),state=memory(observation);state.fortifications.fallback={};fortifyCommands(observation,{kind:'fortify',anchorRef:'home',material:'stone',radiusM:18},state.fortifications.fallback,undefined,new Set());observation.self.resources.stone=buildings.stone_wall.cost.stone;for(const [index,[xMm,zMm,rotation]]of [[101000,83000,0],[101000,119000,0],[83000,101000,90],[119000,101000,90]].entries())observation.entities.push({id:`gate_${index}`,kind:'building',typeId:'stone_gate',ownerId:'blue',xMm:xMm!,zMm:zMm!,rotation:rotation as 0|90,hp:buildings.stone_gate.maxHp,maxHp:buildings.stone_gate.maxHp,progress:1});commanderCommands(observation,state);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toMatchObject([{kind:'build_wall',material:'stone',cells:[expect.any(Object)]}]);
    for(const wood of [499,500]){const early=view(),earlyState=memory(early);foodAvailable(early);early.self.age=1;early.self.resources.food=200;early.self.resources.wood=wood;early.entities=early.entities.filter(entity=>entity.typeId!=='university');commanderCommands(early,earlyState);expect(fortification(earlyState.pending.flatMap(batch=>batch.commands))).toHaveLength(wood===500?1:0);}
  });
  it('subtracts pending and due wall costs before scheduling stone fortification without changing due order',()=>{
    for(const due of [false,true]){const observation=view(),state=memory(observation),prior:GameplayCommand={kind:'build_wall',builderIds:['worker_0'],material:'stone',cells:[{x:10,z:10},{x:11,z:10},{x:12,z:10}],queued:false};observation.self.resources.stone=3*buildings.stone_wall.cost.stone+buildings.stone_gate.cost.stone-1;state.pending=[{observedTick:0,executeTick:due?20:100,commands:[prior]}];const returned=commanderCommands(observation,state);expect(returned.map(proposal=>proposal.command)).toEqual(due?[prior]:[]);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual(due?[]:[prior]);expect(state.fortifications.fallback?.pendingUntilTick).toBeUndefined();}
  });
  it('uses an unreserved builder and records no dispatch when every builder is reserved',()=>{
    for(const all of [false,true]){const observation=view(),state=memory(observation),ids=all?Array.from({length:6},(_,index)=>`worker_${index}`):['worker_0'];state.pending=[{observedTick:0,executeTick:100,commands:[{kind:'move',unitIds:ids,target:{xMm:100000,zMm:110000},queued:false}]}];commanderCommands(observation,state);const commands=fortification(state.pending.flatMap(batch=>batch.commands));expect(commands).toHaveLength(all?0:1);if(all)expect(state.fortifications.fallback?.pendingUntilTick).toBeUndefined();else{expect(commands[0]).toMatchObject({builderIds:['worker_1']});expect(state.fortifications.fallback?.lastSignature).toBe(JSON.stringify(commands[0]));}}
  });
  it('retains infrastructure priority when its builder is reserved earlier in the same strategic decision',()=>{
    const observation=view(),state=memory(observation);observation.entities=observation.entities.filter(entity=>entity.typeId!=='lumber_camp');observation.self.resources={food:100,wood:500,gold:0,stone:30};commanderCommands(observation,state);expect(state.pending.flatMap(batch=>batch.commands)).toContainEqual(expect.objectContaining({kind:'build',buildingType:'lumber_camp'}));expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);expect(state.fortifications.fallback).toBeUndefined();
  });
  it('completes cheap route proofs within the work allowance and retains paid material below the starting threshold',()=>{
    const observation=view(),state=memory(observation);for(let index=0;index<6;index++)observation.entities.push({id:`known_tree_${index}`,kind:'resource',typeId:'tree',ownerId:null,xMm:130000+index*2000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:100});
    commanderCommands(observation,state);expect(state.fortifications.fallback).toMatchObject({validatedResources:6,routesValid:true});expect(fortification(state.pending.flatMap(batch=>batch.commands))).toHaveLength(1);expect(state.nextStrategicTick).toBeGreaterThan(observation.tick);
    const early=view(),earlyState=memory(early);foodAvailable(early);early.self.age=1;early.self.resources.food=200;early.self.resources.wood=500;early.entities=early.entities.filter(entity=>entity.typeId!=='university');commanderCommands(early,earlyState);const command=fortification(earlyState.pending.flatMap(batch=>batch.commands))[0]!;if(command.kind!=='build')throw new Error('MISSING_GATE');
    earlyState.pending=[];early.tick=80;early.self.age=3;early.self.resources.wood=100;early.self.resources.stone=0;early.entities.push({id:'paid_ring',kind:'building',typeId:'wooden_gate',ownerId:'blue',xMm:(command.originCell.x+(command.rotation===0?1.5:.5))*2000,zMm:(command.originCell.z+(command.rotation===90?1.5:.5))*2000,rotation:command.rotation,hp:100,maxHp:600,progress:.25});
    const builder=early.entities.find(entity=>entity.id===command.builderIds[0])!;builder.order='build';commanderCommands(early,earlyState);expect(earlyState.pending.flatMap(batch=>batch.commands).some(command=>command.kind==='continue_build')).toBe(false);
    builder.order='idle';early.tick+=10;commanderCommands(early,earlyState);expect(earlyState.pending.flatMap(batch=>batch.commands)).toContainEqual(expect.objectContaining({kind:'continue_build',builderIds:[expect.stringMatching(/^worker_/)],foundationId:'paid_ring',queued:false}));expect(earlyState.fortifications.fallback?.goalKey).toBe('blue:home:palisade:18');
  });
  it('continues fortification proof while multiple unrelated foundations suspend new defense purchases',()=>{
    const observation=view(),state=memory(observation);for(let index=0;index<10;index++)observation.entities.push({id:`proof_tree_${index}`,kind:'resource',typeId:'tree',ownerId:null,xMm:130000+index*2000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:100});
    state.fortifications.fallback={};for(let attempt=0;attempt<4&&!state.fortifications.fallback.routesValid;attempt++)fortifyCommands(observation,{kind:'fortify',anchorRef:'home',material:'stone',radiusM:18},state.fortifications.fallback,undefined,new Set());expect(state.fortifications.fallback.validatedResources).toBe(10);const layout=structuredClone(state.fortifications.fallback.layout);state.nextStrategicTick=100000;
    observation.entities.push({id:'paid_farm',kind:'building',typeId:'farm',ownerId:'blue',xMm:150000,zMm:130000,hp:1,maxHp:buildings.farm.maxHp,progress:.1,rotation:0});observation.entities.find(entity=>entity.id==='worker_0')!.order='build';const before=structuredClone(observation);
    observation.entities.push({...observation.entities.find(entity=>entity.id==='paid_farm')!,id:'paid_other_farm',xMm:170000});before.entities=structuredClone(observation.entities);
    for(const tick of [30,40,50]){observation.tick=tick;commanderCommands(observation,state);expect(state.fortifications.fallback?.validatedResources).toBeLessThanOrEqual(10);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);expect(state.fortifications.fallback?.pendingUntilTick).toBeUndefined();}
    expect(state.fortifications.fallback?.routesValid).toBe(true);expect(state.fortifications.fallback?.layout).toEqual(layout);expect({...observation,tick:before.tick}).toEqual(before);
    observation.entities.find(entity=>entity.id==='paid_farm')!.progress=1;observation.entities.find(entity=>entity.id==='paid_other_farm')!.progress=1;observation.tick=80;commanderCommands(observation,state);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toMatchObject([{kind:'build',buildingType:'stone_gate',builderIds:['worker_1']}]);
  });
  it('coordinates same-call camp and farm placement with the newly selected fortification contour',()=>{
    const overlaps=(command:Extract<GameplayCommand,{kind:'build'}>,cells:{x:number;z:number}[])=>{const [width,depth]=buildings[command.buildingType].footprintCells;return cells.some(cell=>cell.x>=command.originCell.x&&cell.x<command.originCell.x+width&&cell.z>=command.originCell.z&&cell.z<command.originCell.z+depth);};
    for(const type of ['lumber_camp','farm'] as const){
      const observation=view(),state=memory(observation);observation.self.resources.wood=type==='lumber_camp'?200:buildings.farm.cost.wood;
      for(let index=0;index<6;index++)observation.entities.push({id:`site_resource_${index}`,kind:'resource',typeId:type==='lumber_camp'?'tree':'forage_patch',ownerId:null,xMm:index===0&&type==='lumber_camp'?114000:130000+index*2000,zMm:index===0&&type==='lumber_camp'?110000:100000,hp:1,maxHp:1,resource:type==='lumber_camp'?'wood':'food',amount:10});
      if(type==='lumber_camp'){
        observation.entities.find(entity=>entity.id==='worker_0')!.workTargetId='site_resource_0';observation.self.resources.food=units.villager.cost.food*2;
        // Retain six disclosed route-proof resources, with one supplying local
        // food so this camp-placement case has no competing famine repair.
        Object.assign(observation.entities.find(entity=>entity.id==='site_resource_5')!,{typeId:'forage_patch',resource:'food',xMm:126000,zMm:100000,amount:1000});
      }
      // Independent ordinary proposals expose the original same-decision conflict.
      const proof:FortifyMemory={};fortifyCommands(observation,{kind:'fortify',anchorRef:'home',material:'stone',radiusM:18},proof,undefined,new Set());expect(proof.layout).toBeDefined();const cells=proof.layout!.cells;
      let ordinary:GameplayCommand|undefined;
      if(type==='lumber_camp')ordinary=buildingCommand(observation,type,observation.entities.find(entity=>entity.id==='site_resource_0')!,observation.entities.filter(entity=>entity.typeId==='villager'));
      else for(let attempt=0;attempt<121;attempt++){const proposed=fallbackCommands(observation,{sequence:0,scoutIndex:0,buildAttempt:attempt},{scoutAllowed:false}).find(command=>command.kind==='build'&&command.buildingType==='farm');if(proposed?.kind==='build'&&overlaps(proposed,cells)){ordinary=proposed;state.buildAttempt=attempt;break;}}
      expect(ordinary?.kind).toBe('build');if(ordinary?.kind!=='build')throw new Error('MISSING_CONFLICT_SITE');expect(overlaps(ordinary,cells),JSON.stringify({type,ordinary,cells})).toBe(true);const before=structuredClone(observation);
      commanderCommands(observation,state);expect(state.fortifications.fallback?.layout?.signature).toBe(proof.layout!.signature);expect(state.fortifications.fallback?.validatedResources).toBe(6);
      const proposed=state.pending.flatMap(batch=>batch.commands).find(command=>command.kind==='build'&&command.buildingType===type);expect(proposed?.kind,JSON.stringify({type,commands:state.pending.flatMap(batch=>batch.commands)})).toBe('build');if(proposed?.kind!=='build')throw new Error('MISSING_ECONOMY_SITE');expect(overlaps(proposed,cells)).toBe(false);expect(observation).toEqual(before);expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);
      if(type==='farm'){
        // An unpaid proof that hit its bounded route limit must not reserve land.
        const failed=memory(observation);failed.buildAttempt=state.buildAttempt-1;failed.fortifications.fallback=structuredClone(proof);failed.fortifications.fallback.routeFailure='RESOURCE_ROUTE_LIMIT';failed.nextStrategicTick=100000;
        commanderCommands(observation,failed);expect(failed.pending.flatMap(batch=>batch.commands)).toContainEqual(ordinary);expect(failed.fortifications.fallback.layoutCommitted).toBeUndefined();
      }
    }
  });
  it('keeps a paid gate passage open when ordinary infrastructure selects a neighboring market',()=>{
    // A paid enclosure with clear streets: the unsafe market branch must fail
    // atomically, while the controller-selected market pays and preserves traffic.
    const {sim,structure,unit}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.ownerId==='blue'||entity.kind==='resource')delete sim.state.entities[entity.id];
    const home=structure('town_center',130000,192000);
    for(const z of [168000,188000,208000])for(const x of [106000,126000,146000,166000])unit('scout',x,z);
    const workers=Array.from({length:6},(_,index)=>unit('villager',120000+index*4000,165000)),scout=unit('scout',155000,187000);
    workers[0]!.xMm=154000;workers[0]!.zMm=194000;
    for(let index=0;index<5;index++)sim.state.entities[`outside_tree_${index}`]={id:`outside_tree_${index}`,kind:'resource',typeId:'tree_oak',ownerId:null,xMm:163000,zMm:181000+index*3000,hp:1,maxHp:1,resource:'wood',amount:100000};
    sim.state.factions[0]!.personality='builder';sim.state.economies.blue!.age=2;sim.state.economies.blue!.resources=Object.fromEntries(balance.resourceOrder.map(resource=>[resource,balance.start.resources[resource]*balance.rules.resourceScale])) as ResourceBank;sim.state.navigationRevision++;sim.step();
    const goal={kind:'fortify' as const,anchorRef:home.id,material:'palisade' as const,radiusM:18},corners=[[74,87],[74,105],[56,105],[56,87],[74,87]],cells:{x:number;z:number}[]=[];
    for(let index=0;index<corners.length-1;index++){const start=corners[index]!,end=corners[index+1]!,dx=Math.sign(end[0]!-start[0]!),dz=Math.sign(end[1]!-start[1]!);for(let x=start[0]!,z=start[1]!;x!==end[0]||z!==end[1];x+=dx,z+=dz)cells.push({x,z});}
    const gates=[{originCell:{x:64,z:87},rotation:0 as const},{originCell:{x:74,z:95},rotation:90 as const},{originCell:{x:64,z:105},rotation:0 as const},{originCell:{x:56,z:95},rotation:90 as const}],memory:FortifyMemory={goalKey:`blue:${home.id}:palisade:18`,layout:{cells,gates,origin:{xMm:123100,zMm:192000},signature:fortifyLayoutSignature(cells,gates)}};expect(validFortifyLayout(memory.layout!)).toBe(true);
    for(let round=0;round<10&&!memory.routesValid;round++)fortifyCommands(sim.view('blue'),goal,memory,undefined,new Set());expect(memory.routesValid).toBe(true);
    const site=memory.layout!.gates.find(gate=>gate.rotation===90&&gate.originCell.x*2000>home.xMm)!,builder=workers.at(-1)!;
    const gatePosition={xMm:(site.originCell.x+.5)*2000,zMm:(site.originCell.z+1.5)*2000};builder.xMm=gatePosition.xMm-1850;builder.zMm=gatePosition.zMm;sim.step();
    const gateCommand:GameplayCommand={kind:'build',buildingType:'wooden_gate',builderIds:[builder.id],...site,queued:false},beforeGate=sim.state.economies.blue!.resources.wood;
    expect(send(sim,gateCommand).status).toBe('accepted');expect(sim.state.economies.blue!.resources.wood).toBe(beforeGate-buildings.wooden_gate.cost.wood*1000);markFortifyQueued(memory,gateCommand,sim.state.tick);
    const gate=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='wooden_gate')!;for(let tick=0;tick<800&&gate.work<gate.required;tick++)sim.step();expect(gate.work).toBe(gate.required);
    const blocked=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true}),beforeBad=blocked.state.economies.blue!.resources.wood,unsafe:GameplayCommand={kind:'build',buildingType:'market',builderIds:[builder.id],originCell:{x:75,z:95},rotation:0,queued:false};expect(send(blocked,unsafe).status).toBe('rejected');expect(blocked.state.economies.blue!.resources.wood).toBe(beforeBad);expect(Object.values(blocked.state.entities).some(entity=>entity.typeId==='market')).toBe(false);
    sim.state.controllers.blue!.fortifications.fallback=memory;sim.state.controllers.blue!.nextStrategicTick=0;sim.state.controllers.blue!.nextScoutTick=100000;sim.step(10-sim.state.tick%10);const beforeDecision=sim.view('blue');
    // Observe the real controller's placement policy without forcing its next
    // economic priority. Exercise a market request using those exact options.
    const observedPolicy=vi.spyOn(caretakerPolicy,'caretakerCommands');let placementCells:NonNullable<caretakerPolicy.RulePolicyOptions['avoidBuildingCells']>=[];
    try{commanderCommands(beforeDecision,sim.state.controllers.blue!);placementCells=observedPolicy.mock.calls.at(-1)?.[2]?.avoidBuildingCells??[];}finally{observedPolicy.mockRestore();}
    const preferred=buildingCommand(beforeDecision,'market',beforeDecision.entities.find(entity=>entity.id===home.id)!,beforeDecision.entities.filter(entity=>entity.ownerId==='blue'&&entity.typeId==='villager'),0,placementCells);expect(preferred?.kind).toBe('build');if(preferred?.kind!=='build')throw new Error('MISSING_PREFERRED_MARKET');
    const beforeMarket=sim.state.economies.blue!.resources.wood;expect(send(sim,preferred).status).toBe('accepted');expect(sim.state.economies.blue!.resources.wood).toBe(beforeMarket-buildings.market.cost.wood*1000);
    const preferredMemory:FortifyMemory={goalKey:memory.goalKey!,layout:structuredClone(memory.layout!),layoutCommitted:true};for(let round=0;round<10&&!preferredMemory.routesValid;round++){const result=fortifyCommands(sim.view('blue'),goal,preferredMemory,undefined,new Set());expect(result.status,result.reason).not.toBe('blocked');}expect(preferredMemory.routesValid).toBe(true);
    const market=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='market')!;for(let tick=0;tick<2600&&market.work<market.required;tick++)sim.step();expect(market.work).toBe(market.required);
    const target={xMm:gate.xMm+4000,zMm:gate.zMm},traveler=builder;expect(send(sim,{kind:'move',unitIds:[traveler.id],target:{xMm:gate.xMm-1850,zMm:gate.zMm},queued:false}).status).toBe('accepted');for(let tick=0;tick<1000&&Math.hypot(traveler.xMm-(gate.xMm-1850),traveler.zMm-gate.zMm)>500;tick++)sim.step();
    expect(Math.hypot(traveler.xMm-(gate.xMm-1850),traveler.zMm-gate.zMm)).toBeLessThan(500);expect(send(sim,{kind:'move',unitIds:[traveler.id],target,queued:false}).status).toBe('accepted');let crossed=false;for(let tick=0;tick<500&&Math.hypot(traveler.xMm-target.xMm,traveler.zMm-target.zMm)>500;tick++){sim.step();if(gate.gateOpen&&Math.abs(traveler.xMm-gate.xMm)<1000&&Math.abs(traveler.zMm-gate.zMm)<1000)crossed=true;}expect(crossed).toBe(true);expect(Math.hypot(traveler.xMm-target.xMm,traveler.zMm-target.zMm)).toBeLessThan(500);expect(scout.hp).toBeGreaterThan(0);
  },30000);
  it('saves and replays exact baseline and proposed proof phases and rejects forged saved cycles',()=>{
    for(const phase of ['baseline','proposed'] as const){
      const {sim,home,unit}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&['barracks','mill','lumber_camp','mining_camp'].includes(entity.typeId))delete sim.state.entities[entity.id];sim.state.navigationRevision++;
      for(const z of [54000,80000,106000])for(const x of [54000,80000,106000])unit('scout',x,z);
      sim.state.entities.known_ore={id:'known_ore',kind:'resource',ownerId:null,typeId:'gold_deposit',xMm:108000,zMm:94000,hp:1,maxHp:1,resource:'gold',amount:1000000};sim.step();
      const observed=sim.view('blue'),goal={kind:'fortify' as const,anchorRef:home.id,material:'palisade' as const,radiusM:18},memory:FortifyMemory={goalKey:`blue:${home.id}:palisade:18`};sim.state.controllers.blue!.fortifications.fallback=memory;
      const geometry=resolveFortifyGeometry(observed,goal,memory,{remaining:100000,used:0});if(geometry.status!=='ready')throw new Error(geometry.reason);const ore=observed.entities.find(entity=>entity.id==='known_ore')!,box=fortifyViewObstacle(ore),budget={remaining:100000,used:0};
      const targets=[{xMm:ore.xMm-box.halfWidth-900,zMm:ore.zMm},{xMm:ore.xMm+box.halfWidth+900,zMm:ore.zMm},{xMm:ore.xMm,zMm:ore.zMm-box.halfHeight-900},{xMm:ore.xMm,zMm:ore.zMm+box.halfHeight+900}],known=new Navigation(observed.map.widthMm,observed.map.heightMm,geometry.knownObstacles,30000,1000,budget),proposed=new Navigation(observed.map.widthMm,observed.map.heightMm,[...geometry.knownObstacles,...geometry.proposedObstacles],30000,1000,budget);
      for(const face of geometry.anchorFaces){expect(known.pathToAny(geometry.layout.origin,[face],350)).not.toBeNull();expect(proposed.pathToAny(geometry.layout.origin,[face],350)).not.toBeNull();}const faceWork=budget.used;expect(known.pathToAny(geometry.layout.origin,targets,350)).not.toBeNull();
      expect(fortifyCommands(observed,goal,memory,{remaining:phase==='baseline'?faceWork:budget.used,used:0})).toMatchObject({status:'waiting',reason:'VALIDATING_RESOURCE_ROUTES'});expect(memory).toMatchObject({proofPhase:phase,validatedFaces:4});expect(validateCommanderMemory(sim.state.controllers.blue,'blue',sim.state.tick)).toBe(true);
      const forged=structuredClone(sim.state.controllers.blue!);forged.fortifications.fallback!.layout!.cells[1]={...forged.fortifications.fallback!.layout!.cells[0]!};expect(validateCommanderMemory(forged,'blue',sim.state.tick)).toBe(false);
      const saved=exportSimulationSave(sim,identity),restored=restoreSimulation(saved,identity,{preserveEpoch:true});sim.drainJournal();sim.step(20);restored.step(20);expect(restored.capture()).toEqual(sim.capture());expect(restored.state.controllers.blue!.fortifications.fallback!.proofPhase).toBe(phase);
      const replay=new ReplayRunner(createReplayRecording(saved,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(replay.simulation.capture()).toEqual(sim.capture());
      const originalResult=fortifyCommands(sim.view('blue'),goal,sim.state.controllers.blue!.fortifications.fallback!),restoredResult=fortifyCommands(restored.view('blue'),goal,restored.state.controllers.blue!.fortifications.fallback!);expect(restoredResult).toEqual(originalResult);expect(restored.state.controllers.blue!.fortifications.fallback).toEqual(sim.state.controllers.blue!.fortifications.fallback);
    }
  },30000);
  it('rejects a self-boxing wall batch atomically and completes its access-aware paid prefix',()=>{
    const {sim,home,unit,structure,workers}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&['barracks','mill','lumber_camp','mining_camp'].includes(entity.typeId))delete sim.state.entities[entity.id];sim.state.navigationRevision++;
    for(const z of [50000,70000,90000,110000])for(const x of [50000,70000,90000,110000])unit('scout',x,z);sim.step();
    const goal={kind:'fortify' as const,anchorRef:home.id,material:'palisade' as const,radiusM:18},memory:FortifyMemory={};expect(fortifyCommands(sim.view('blue'),goal,memory).commands[0]?.kind).toBe('build');
    // Connected defense blocks reproduce the former camp/farm obstruction union.
    // Ordinary structures must now leave streets; these seven new walls still
    // prove atomic admission, exact payment and completion beside joined walls.
    for(const site of memory.layout!.gates){const gate=structure('wooden_gate',(site.originCell.x+(site.rotation===0?1.5:.5))*2000,(site.originCell.z+(site.rotation===90?1.5:.5))*2000);gate.rotation=site.rotation;gate.gateMode='AUTO';gate.gateOpen=false;}
    const neighbors:Building[]=[];for(const [xs,zs]of [[[71000,73000,75000],[57000,59000,61000]],[[75000,77000,79000],[65000,67000,69000]]])for(const x of xs!)for(const z of zs!)neighbors.push(structure('palisade_wall',x,z));unit('scout',68000,53000);const cells=Array.from({length:8},(_,index)=>({x:31+index,z:31})),worker=workers[0]!;sim.step();
    const beforeBank=structuredClone(sim.state.economies.blue!.resources),beforeIds=Object.keys(sim.state.entities),full:GameplayCommand={kind:'build_wall',builderIds:[worker.id],material:'palisade',cells,queued:false};
    expect(send(sim,full)).toMatchObject({status:'rejected',code:'NO_PATH'});expect(sim.state.economies.blue!.resources).toEqual(beforeBank);expect(Object.keys(sim.state.entities)).toEqual(beforeIds);
    sim.step();const result=fortifyCommands(sim.view('blue'),goal,memory,undefined,new Set([worker.id])),command=result.commands[0]!;
    expect(command).toEqual({...full,cells:cells.slice(0,7)});expect(memory.routesValid).toBe(true);expect(memory.routeFailure).toBeUndefined();expect(send(sim,command)).toMatchObject({status:'accepted'});
    const walls=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='palisade_wall'&&!beforeIds.includes(entity.id));expect(walls).toHaveLength(7);expect(sim.state.economies.blue!.resources.wood).toBe(beforeBank.wood-7*buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    const checkedIds=new Set([...neighbors.map(wall=>wall.id),...walls.map(wall=>wall.id)]),clearanceObstacles=sim.view('blue').entities.filter(entity=>checkedIds.has(entity.id)).map(fortifyViewObstacle);expect(clearanceObstacles).toHaveLength(neighbors.length+7);
    const radius=units.villager.collisionRadiusM*1000;let elapsed=0;while(elapsed<3000&&walls.some(wall=>wall.work<wall.required)){
      sim.step(20);elapsed+=20;
      for(const box of clearanceObstacles){const dx=Math.max(Math.abs(worker.xMm-box.xMm)-box.halfWidth,0),dz=Math.max(Math.abs(worker.zMm-box.zMm)-box.halfHeight,0);expect(dx*dx+dz*dz,JSON.stringify({elapsed,worker,obstacle:box.id})).toBeGreaterThanOrEqual(radius*radius);}
    }
    expect(walls.every(wall=>wall.work>=wall.required),JSON.stringify({elapsed,worker,walls:walls.map(wall=>({xMm:wall.xMm,work:wall.work,required:wall.required}))})).toBe(true);expect(sim.state.economies.blue!.resources.wood).toBe(beforeBank.wood-7*buildings.palisade_wall.cost.wood*balance.rules.resourceScale);
    expect(sim.state.commandLog.filter(event=>event.envelope.command.kind==='build_wall')).toHaveLength(1);
  },30000);
  it('constructs real paid asymmetric gates and walls, preserves traffic and ignores hidden enemy changes',()=>{
    const {sim,home,unit,structure,workers}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&['barracks','mill','lumber_camp','mining_camp'].includes(entity.typeId))delete sim.state.entities[entity.id];sim.state.navigationRevision++;
    // Obstruct the nominal north edge while leaving room for a four-meter detour.
    structure('house',83000,58000);for(const z of [50000,70000,90000,110000])for(const x of [50000,70000,90000,110000])unit('scout',x,z);sim.step();
    const goal={kind:'fortify' as const,anchorRef:home.id,material:'palisade' as const,radiusM:18},memory:FortifyMemory={},before=sim.state.economies.blue!.resources.wood,seen=new Set<string>();sim.state.controllers.blue!.fortifications.fallback=memory;
    const authorized=sim.view('blue'),hidden=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});hidden.state.economies.red!.resources.wood+=200000;Object.values(hidden.state.entities).find(entity=>entity.ownerId==='red')!.hp-=10;
    const equivalent:FortifyMemory={};expect(hidden.view('blue')).toEqual(authorized);expect(fortifyCommands(hidden.view('blue'),goal,equivalent)).toEqual(fortifyCommands(authorized,goal,memory));expect(equivalent).toEqual(memory);expect(validFortifyLayout(memory.layout!)).toBe(true);expect(memory.layout!.cells.some(cell=>cell.z!==31&&cell.z!==49&&cell.x!==31&&cell.x!==49)).toBe(true);
    const layout=structuredClone(memory.layout!);let paid=0,gateSave=false;
    for(let cycle=0;cycle<260;cycle++){
      const result=fortifyCommands(sim.view('blue'),goal,memory);expect(result.status).not.toBe('blocked');
      for(const command of result.commands){const receipt=send(sim,command);expect(receipt.status,JSON.stringify({command,receipt})).toBe('accepted');markFortifyQueued(memory,command,sim.state.tick);if(command.kind==='build')paid+=buildings[command.buildingType].cost.wood*1000;else if(command.kind==='build_wall')paid+=command.cells.length*buildings.palisade_wall.cost.wood*1000;}
      sim.step(20);expect(memory.layout).toEqual(layout);for(const entity of Object.values(sim.state.entities))if(entity.typeId==='wooden_gate')seen.add(entity.id);
      if(!gateSave&&seen.size){expect(restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true}).capture()).toEqual(sim.capture());gateSave=true;}
      if(Object.values(sim.state.entities).some(entity=>entity.kind==='building'&&entity.typeId==='palisade_wall'&&entity.work>=entity.required))break;
    }
    expect(seen.size).toBe(4);expect(sim.state.economies.blue!.resources.wood).toBe(before-paid);expect(Object.values(sim.state.entities).some(entity=>entity.kind==='building'&&entity.typeId==='palisade_wall'&&entity.work>=entity.required)).toBe(true);
    const gate=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='wooden_gate'&&entity.work>=entity.required)!;expect(gate).toBeDefined();
    // Move the ordinary worker from an interior point through the completed gate.
    const target={xMm:gate.xMm+(gate.rotation===90?(gate.xMm>home.xMm?4000:-4000):0),zMm:gate.zMm+(gate.rotation===0?(gate.zMm>home.zMm?4000:-4000):0)},approach={xMm:2*gate.xMm-target.xMm,zMm:2*gate.zMm-target.zMm},traveler=workers.find(worker=>worker.orders[0]?.kind!=='build')!;
    const knownGeometry=sim.view('blue').entities.filter(entity=>entity.kind!=='unit').map(fortifyViewObstacle),knownNav=new Navigation(sim.state.widthMm,sim.state.heightMm,knownGeometry);expect(knownNav.free(approach,units.villager.collisionRadiusM*1000)).toBe(true);expect(knownNav.free(target,units.villager.collisionRadiusM*1000)).toBe(true);
    expect(send(sim,{kind:'move',unitIds:[traveler.id],target:approach,queued:false}).status).toBe('accepted');for(let tick=0;tick<600&&Math.hypot(traveler.xMm-approach.xMm,traveler.zMm-approach.zMm)>500;tick++)sim.step();expect(Math.hypot(traveler.xMm-approach.xMm,traveler.zMm-approach.zMm),JSON.stringify({gate:{x:gate.xMm,z:gate.zMm,rotation:gate.rotation},approach,traveler})).toBeLessThan(500);
    expect(send(sim,{kind:'move',unitIds:[traveler.id],target,queued:false}).status).toBe('accepted');let throughOpenPassage=false;for(let tick=0;tick<600&&Math.hypot(traveler.xMm-target.xMm,traveler.zMm-target.zMm)>500;tick++){sim.step();if(Math.abs(traveler.xMm-gate.xMm)<1500&&Math.abs(traveler.zMm-gate.zMm)<1500&&gate.gateOpen)throughOpenPassage=true;}
    expect(throughOpenPassage).toBe(true);expect(Math.hypot(traveler.xMm-target.xMm,traveler.zMm-target.zMm)).toBeLessThan(500);expect(memory.layout).toEqual(layout);
  },30000);
  it('commits model dispatch only after final enqueue and retains the completed proof when the queue rejects it',()=>{
    const observation=view(),state=desired(observation);observation.entities.push({id:'known_ore',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:130000,zMm:100000,hp:1,maxHp:1,resource:'gold',amount:1000});state.pending=Array.from({length:59},()=>({observedTick:0,executeTick:100,commands:[{kind:'set_auto_reseed' as const,enabled:true}]}));commanderCommands(observation,state);const proof=state.fortifications['fortify:home']!;expect(state.plan!.goals[0]).toMatchObject({status:'pending',reason:'COMMAND_QUEUE_FULL'});expect(proof.routesValid).toBe(true);expect(proof.pendingUntilTick).toBeUndefined();expect(proof.lastSignature).toBeUndefined();expect(fortification(state.pending.flatMap(batch=>batch.commands))).toEqual([]);const geometryKey=proof.geometryKey;
    state.pending.pop();observation.tick=30;commanderCommands(observation,state);const commands=fortification(state.pending.flatMap(batch=>batch.commands));expect(commands).toHaveLength(1);expect(proof.geometryKey).toBe(geometryKey);expect(proof.pendingUntilTick).toBe(70);expect(proof.lastSignature).toBe(JSON.stringify(commands[0]));
  });
  it('restores before and after enqueue and replays one actual low-wood stone gate purchase exactly',()=>{
    const {sim,unit,structure}=fixture();for(const entity of Object.values(sim.state.entities))if(entity.kind==='building'&&['barracks','mill','lumber_camp','mining_camp'].includes(entity.typeId))delete sim.state.entities[entity.id];for(const [index,type]of (['lumber_camp','barracks','watchtower','university','siege_workshop'] as const).entries())structure(type,30000+index*18000,28000);sim.state.navigationRevision++;for(let z=56000;z<=106000;z+=10000)for(let x=56000;x<=106000;x+=10000)unit('scout',x,z);sim.state.factions[0]!.personality='builder';sim.state.economies.blue!.age=3;sim.state.economies.blue!.resources={food:0,wood:4000,gold:0,stone:buildings.stone_gate.cost.stone*1000};sim.state.controllers.blue!.nextScoutTick=100000;sim.step();sim.options.controllers=true;
    const initial=exportSimulationSave(sim,identity),beforeQueue=restoreSimulation(initial,identity,{preserveEpoch:true});sim.drainJournal();const untilDecision=10-sim.state.tick;sim.step(untilDecision);beforeQueue.step(untilDecision);expect(beforeQueue.capture()).toEqual(sim.capture());const scheduled=sim.state.controllers.blue!.pending.find(batch=>fortification(batch.commands).length)!;expect(scheduled.commands[0]).toMatchObject({kind:'build',buildingType:'stone_gate'});expect(sim.state.economies.blue!.resources.stone).toBe(buildings.stone_gate.cost.stone*1000);expect(sim.state.controllers.blue!.fortifications.fallback?.lastSignature).toBe(JSON.stringify(scheduled.commands[0]));
    const afterQueue=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});const toAdmission=scheduled.executeTick-sim.state.tick;sim.step(toAdmission);beforeQueue.step(toAdmission);afterQueue.step(toAdmission);expect(afterQueue.capture()).toEqual(sim.capture());expect(beforeQueue.capture()).toEqual(sim.capture());expect(sim.state.economies.blue!.resources).toEqual({food:0,wood:4000,gold:0,stone:0});expect(sim.state.commandLog.filter(event=>fortification([event.envelope.command]).length)).toHaveLength(1);const foundation=Object.values(sim.state.entities).find(entity=>entity.typeId==='stone_gate') as Building;expect(foundation).toBeDefined();
    const afterAdmission=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});for(let attempt=0;attempt<40&&foundation.work===0;attempt++){sim.step(20);afterQueue.step(20);afterAdmission.step(20);}expect(afterQueue.capture()).toEqual(sim.capture());expect(afterAdmission.capture()).toEqual(sim.capture());expect(foundation.work).toBeGreaterThan(0);expect(sim.state.commandLog.filter(event=>fortification([event.envelope.command]).length)).toHaveLength(1);
    const replay=new ReplayRunner(createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),identity);while(!replay.advanceTo(sim.state.tick).done){}expect(replay.simulation.capture()).toEqual(sim.capture());
  },30000);
});
