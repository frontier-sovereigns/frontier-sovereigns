import { expect, it } from 'vitest';
import { balance, buildings, terrainObstacles, units, type GameplayCommand, type Position, type PublicPlayer, type TerrainRegion, type UnitId } from '@frontier/shared';
import { createSimulation, exportSimulationSave, restoreSimulation, simulationChecksum, type Building, type EngineIdentity, type ResourceNode, type Simulation, type Unit } from '../src/index.js';
import { Navigation } from '../src/navigation.js';
import { UnitSpatialIndex } from '../src/movement.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { resourceWorkBounds } from '../src/forest-navigation.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { knownNavigation, scoutDestination } from '../src/ai-exploration.js';

const identity:EngineIdentity={engineBuildHash:'d'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const factions:PublicPlayer[]=[
  {id:'a',name:'A',kind:'human',teamId:'allies',color:'#0072f5'},
  {id:'b',name:'B',kind:'human',teamId:'allies',color:'#f07800'},
  {id:'c',name:'C',kind:'human',teamId:'other',color:'#d42c7b'},
];
const ridge=(id:string,xMm:number,zMm:number,widthMm:number,depthMm:number):TerrainRegion=>({id,kind:'ridge',xMm,zMm,widthMm,depthMm,elevationMm:14000});
const radius=(unit:Unit)=>units[unit.typeId].collisionRadiusM*1000;
function unit(id:string,typeId:UnitId,ownerId:string,xMm:number,zMm:number):Unit {
  const definition=units[typeId];
  return {id,kind:'unit',typeId,ownerId,xMm,zMm,hp:definition.maxHp,maxHp:definition.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',autoGather:false,...(typeId==='trebuchet'?{deploymentState:'packed' as const}:{})};
}
function building(id:string,typeId:Building['typeId'],ownerId:string,xMm:number,zMm:number):Building {
  const definition=buildings[typeId];
  return {id,kind:'building',typeId,ownerId,xMm,zMm,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,work:definition.buildSeconds*2000,required:definition.buildSeconds*2000,rotation:0,queue:[],cooldown:0};
}
function fixture(terrain:TerrainRegion[]) {
  const simulation=createSimulation({matchId:'barrier-gameplay',seed:'barrier-gameplay',factions,controllers:false,sharedVision:false,populationLimit:200});
  simulation.state.widthMm=simulation.state.heightMm=192000;
  simulation.state.map.terrain=terrain;simulation.state.entities={};
  for(const [id,xMm,zMm] of [['a',20000,170000],['b',168000,170000],['c',168000,20000]] as const){
    const home=building(`${id}_home`,'town_center',id,xMm,zMm);simulation.state.entities[home.id]=home;
  }
  for(const vision of Object.values(simulation.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
  simulation.state.navigationRevision++;
  return simulation;
}
function refresh(simulation:Simulation) {
  simulation.state.navigationRevision++;
  (simulation as unknown as {updateVision():void}).updateVision();
}
function command(simulation:Simulation,playerId:string,command:GameplayCommand) {
  const sequence=simulation.state.economies[playerId]!.lastClientSequence+1;
  const receipt=simulation.command(playerId,{protocolVersion:2,matchId:simulation.state.matchId,matchEpoch:simulation.state.matchEpoch,clientCommandId:`barrier_${playerId}_${sequence}`,clientSequence:sequence,command});
  expect(receipt.status,JSON.stringify(receipt)).toBe('accepted');
}
function physical(simulation:Simulation) {
  return new Navigation(simulation.state.widthMm,simulation.state.heightMm,[...terrainObstacles(simulation.state.map.terrain),...Object.values(simulation.state.entities).flatMap(entity=>entity.kind==='building'?fortificationObstacles(entity):entity.kind==='resource'&&entity.amount>0?[{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,...resourceWorkBounds(entity)}]:[])]);
}

it('moves opposing allied columns of mixed infantry, cavalry and packed siege through a 48m valley without static clipping or permanent jams',()=>{
  // Synthetic capacity setup; the real command, formation, collision and movement
  // code advances every unit. This does not claim these armies were economically trained.
  const simulation=fixture([ridge('north',64000,0,48000,72000),ridge('south',64000,120000,48000,72000)]);
  const columns=['a','b'].map(ownerId=>Array.from({length:16},(_,index)=>{
    const typeId=(['militia','scout','battering_ram','trebuchet'] as const)[index%4]!;
    const body=unit(`${ownerId}_${index}`,typeId,ownerId,(ownerId==='a'?36000:136000)+index%4*4000,90000+Math.floor(index/4)*4000);
    simulation.state.entities[body.id]=body;return body;
  }));
  refresh(simulation);const navigation=physical(simulation),army=columns.flat();
  for(const [index,column] of columns.entries())command(simulation,index===0?'a':'b',{kind:'move',unitIds:column.map(body=>body.id),target:{xMm:index===0?142000:42000,zMm:96000},queued:false});
  const destinations=new Map(army.map(body=>[body.id,{...body.orders[0]!.target!}]));
  let tick=0;
  for(;tick<3200&&army.some(body=>body.orders.length);tick++){
    const before=army.map(body=>({xMm:body.xMm,zMm:body.zMm}));simulation.step();
    const occupancy=new UnitSpatialIndex();
    for(const [index,body] of army.entries()){
      expect(navigation.clearLine(before[index]!,body,radius(body)),`${body.id} crossed a static barrier at tick ${tick}`).toBe(true);
      expect(occupancy.free(body,radius(body)),`${body.id} overlapped another unit at tick ${tick}`).toBe(true);
      occupancy.set({id:body.id,xMm:body.xMm,zMm:body.zMm,radiusMm:radius(body)});
    }
  }
  expect(army.filter(body=>body.orders.length).map(body=>({id:body.id,reason:body.blockedReason,position:[body.xMm,body.zMm]}))).toEqual([]);
  for(const body of army){const destination=destinations.get(body.id)!;expect(Math.hypot(body.xMm-destination.xMm,body.zMm-destination.zMm)).toBeLessThanOrEqual(100);}
  expect(simulation.state.status).toBe('RUNNING');
},60000);

it('routes packed siege around an impassable ridge and a player wall, retaining identical pending movement after save/restore',()=>{
  const simulation=fixture([ridge('detour',80000,64000,24000,48000)]),siege=unit('siege','trebuchet','a',65000,88000);
  simulation.state.entities[siege.id]=siege;
  // Deliberate player construction may close a route; it never makes the natural
  // ridge walkable. Leave a broad southern alternative around both obstacles.
  for(let zMm=53000;zMm<64000;zMm+=2000){const wall=building(`wall_${zMm}`,'palisade_wall','a',81000,zMm);simulation.state.entities[wall.id]=wall;}
  refresh(simulation);const navigation=physical(simulation);
  expect(navigation.free({xMm:92000,zMm:88000},radius(siege))).toBe(false);
  expect(navigation.clearLine(siege,{xMm:124000,zMm:88000},radius(siege))).toBe(false);
  command(simulation,'a',{kind:'move',unitIds:[siege.id],target:{xMm:124000,zMm:88000},queued:false});
  simulation.step(3);expect(siege.orders.length).toBeGreaterThan(0);
  const saved=exportSimulationSave(simulation,identity);
  expect(validateSimulationSavePayload(saved.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
  const restored=restoreSimulation(JSON.parse(JSON.stringify(saved)),identity,{preserveEpoch:true});
  expect(restored.state.map.terrain).toEqual(simulation.state.map.terrain);
  for(let tick=0;tick<2400&&siege.orders.length;tick++){
    const before={xMm:siege.xMm,zMm:siege.zMm};simulation.step();
    expect(navigation.clearLine(before,siege,radius(siege))).toBe(true);
    if(tick<60){restored.step();expect(simulationChecksum(restored)).toBe(simulationChecksum(simulation));}
  }
  expect(siege.orders).toEqual([]);expect(Math.hypot(siege.xMm-124000,siege.zMm-88000)).toBeLessThanOrEqual(100);
},30000);

it('harvests a forest belt beside a ridge from its open edge, then exposes a real passage only after tree depletion',()=>{
  const simulation=fixture([ridge('woodland_backing',80000,40000,16000,60000)]),worker=unit('worker','villager','a',76000,105000);
  simulation.state.entities[worker.id]=worker;
  const depot=building('depot','lumber_camp','a',62000,104000);simulation.state.entities[depot.id]=depot;
  const trees:ResourceNode[]=Array.from({length:3},(_,index)=>({id:`edge_tree_${index}`,kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:1000,xMm:78500+index*3000,zMm:101500,hp:1,maxHp:1,forest:{patchId:'b'.repeat(64),cellMm:3000}}));
  for(const tree of trees)simulation.state.entities[tree.id]=tree;
  refresh(simulation);const target=trees[1]!,edge={xMm:target.xMm,zMm:103600};
  expect(physical(simulation).free(target,radius(worker))).toBe(false);
  expect(physical(simulation).free(edge,radius(worker))).toBe(true);
  command(simulation,'a',{kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false});
  let gathered=false;
  for(let tick=0;tick<800&&target.amount>0;tick++){
    const before={xMm:worker.xMm,zMm:worker.zMm},navigation=physical(simulation);simulation.step();
    expect(navigation.clearLine(before,worker,radius(worker))).toBe(true);
    gathered||=worker.cargo.amount>0;
  }
  expect(gathered).toBe(true);expect(target.amount).toBe(0);
  expect(physical(simulation).free(target,radius(worker))).toBe(true);
  expect(physical(simulation).free({xMm:target.xMm,zMm:98000},radius(worker))).toBe(false);
  expect(trees.some(tree=>tree.amount>0)).toBe(true);
});

it('explores an unseen wooded frontier beyond a ridge using only the permitted observation and ordinary scout movement',()=>{
  const simulation=fixture([ridge('exploration_divide',78000,68000,24000,56000)]),scout=unit('explorer','scout','a',63000,96000);
  simulation.state.entities[scout.id]=scout;
  const tree:ResourceNode={id:'hidden_wood',kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:3000*balance.rules.resourceScale,xMm:114000,zMm:96000,hp:1,maxHp:1,forest:{patchId:'c'.repeat(64),cellMm:3000}};
  simulation.state.entities[tree.id]=tree;
  const cell=balance.rules.fogGridM*1000,width=simulation.state.widthMm/cell;
  simulation.state.vision.a!.explored=Array.from({length:width*width},(_,index)=>index).filter(index=>index%width<51||index%width>62||Math.floor(index/width)<40||Math.floor(index/width)>55);
  refresh(simulation);expect(simulation.view('a').entities.some(entity=>entity.id===tree.id)).toBe(false);
  let discovered=false,issued=0;
  for(let tick=0;tick<2200&&!discovered;tick++){
    if(!scout.orders.length&&tick%balance.rules.simulationHz===0){
      const view=simulation.view('a'),target=scoutDestination(view,scout,[],knownNavigation(view),issued++);
      if(target)command(simulation,'a',{kind:'move',unitIds:[scout.id],target,queued:false});
    }
    const before:Position={xMm:scout.xMm,zMm:scout.zMm};simulation.step();
    expect(physical(simulation).clearLine(before,scout,radius(scout))).toBe(true);
    discovered=simulation.view('a').entities.some(entity=>entity.id===tree.id&&!entity.ghost);
  }
  expect(issued).toBeGreaterThan(0);expect(discovered,JSON.stringify({issued,position:[scout.xMm,scout.zMm],orders:scout.orders,blocked:scout.blockedReason,commands:simulation.state.commandLog.slice(-4)})).toBe(true);
  expect(simulation.state.commandLog.every(row=>row.envelope.command.kind==='move')).toBe(true);
},30000);
