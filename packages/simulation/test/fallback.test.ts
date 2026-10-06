import { describe, expect, it } from 'vitest';
import { balance, buildings, contentHash, units, terrainObstacles, resourcePlacementBounds, validateClientCommand, type GameplayCommand, type PlayerView, type ResourceType, type ViewEntity } from '@frontier/shared';
import { effectiveEconomyWeights, fallbackCommands, type FallbackMemory, type FallbackOptions } from '../src/fallback.js';
import { createSimulation, exportSimulationSave, restoreSimulation, type EngineIdentity } from '../src/index.js';
import { Navigation } from '../src/navigation.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { aiBuildingClearanceMm, AiDecisionContext } from '../src/ai-exploration.js';

const memory=():FallbackMemory=>({sequence:0,scoutIndex:0,buildAttempt:0});
function object(id:string,kind:ViewEntity['kind'],typeId:string,xMm:number,zMm:number):ViewEntity{return {id,kind,typeId,ownerId:kind==='resource'?null:'bot',xMm,zMm,hp:100,maxHp:100,...(kind==='building'?{progress:1,queue:[]}:{})};}
function view():PlayerView {
  const workers=Array.from({length:8},(_,i)=>({...object(`worker_${i}`,'unit','villager',45000+i*1600,58000),order:'idle',cargo:{resource:null,amount:0}}));
  const nodes=(['food','wood','gold','stone'] as ResourceType[]).map((resource,i)=>({...object(`known_${resource}`,'resource',resource==='food'?'forage_patch':resource==='wood'?'tree_oak':resource==='gold'?'gold_deposit':'stone_quarry',30000+i*15000,35000),resource,amount:resource==='food'?1200:1000}));
  return {protocolVersion:2,contentHash,matchId:'fallback',matchEpoch:1,tick:100,sequence:100,playerId:'bot',status:'RUNNING',map:{widthMm:100000,heightMm:100000,fogCellMm:2000},self:{populationLimit:120,lastCommandSequence:0,resources:{food:0,wood:250,gold:100,stone:150},age:1,population:8,populationCap:15,reservedPopulation:0,autoReseed:false},players:[{id:'bot',name:'Fallback',teamId:'bot_team',color:'#123456',kind:'ai',difficulty:'easy'},{id:'opponent',name:'Opponent',teamId:'opponent_team',color:'#abcdef',kind:'human'}],entities:[object('home','building','town_center',50000,50000),object('barracks','building','barracks',68000,52000),...workers,...nodes],fog:{visible:Array.from({length:2500},(_,i)=>i),explored:Array.from({length:2500},(_,i)=>i)}};
}

describe('scoped fallback placement',()=>{
  const grid=balance.rules.buildingGridM*1000;
  const area={left:-32000,top:-32000,right:160000,bottom:160000};
  it('builds on discovered land without sight while preserving remembered resource exclusion',()=>{
    const observation=view();observation.entities.find(entity=>entity.id==='known_food')!.amount=0;observation.fog.visible=[];
    const options={scoutAllowed:false,economyOnly:true},first=fallbackCommands(observation,memory(),options).find(command=>command.kind==='build');expect(first).toMatchObject({buildingType:'farm'});if(first?.kind!=='build')throw new Error('MISSING_DISCOVERED_SITE');
    const [w,h]=buildings.farm.footprintCells,halo=Math.ceil(aiBuildingClearanceMm/grid),columns=observation.map.widthMm/grid;
    observation.fog.explored=Array.from({length:(w+halo*2)*(h+halo*2)},(_,index)=>(first.originCell.z-halo+Math.floor(index/(w+halo*2)))*columns+first.originCell.x-halo+index%(w+halo*2));
    expect(fallbackCommands(observation,memory(),options).find(command=>command.kind==='build')).toEqual(first);
    observation.entities.push({...object('remembered_tree','resource','tree_oak',(first.originCell.x+w/2)*grid,(first.originCell.z+h/2)*grid),resource:'wood',amount:250,ghost:true});
    const scope=new AiDecisionContext(observation);try{expect(fallbackCommands(observation,memory(),options).some(command=>command.kind==='build')).toBe(false);expect(fallbackCommands(observation,memory(),options,scope).some(command=>command.kind==='build')).toBe(false);}finally{scope.close();}
  });
  const scalar=(observation:PlayerView,left:number,top:number,right:number,bottom:number)=>observation.entities.some(entity=>{
    if(entity.ghost&&entity.kind==='unit'||entity.kind==='resource'&&(entity.amount??0)===0)return false;
    let [width,depth]=entity.kind==='building'?buildings[entity.typeId].footprintCells:[1,1];if(entity.rotation===90||entity.rotation===270)[width,depth]=[depth,width];
    const gap=entity.kind==='building'?aiBuildingClearanceMm:0,bounds=entity.kind==='resource'?resourcePlacementBounds(entity,balance.rules.treeBuildingClearanceM*1000):{halfWidth:width!*grid/2+gap,halfHeight:depth!*grid/2+gap};
    return entity.xMm+bounds.halfWidth>left&&entity.xMm-bounds.halfWidth<right&&entity.zMm+bounds.halfHeight>top&&entity.zMm-bounds.halfHeight<bottom;
  });

  it('matches the independent rectangle oracle at tangencies, bucket edges and mixed observed footprints',()=>{
    const observation=view();observation.entities=[{...object('square','unit','villager',20000,20000),garrisonedIn:'home'}];
    let scope=new AiDecisionContext(observation),occupied=scope.fallbackPlacement(observation,area)!;
    expect(occupied(20000+grid/2,19000,22000+grid/2,21000)).toBe(false);
    // Fallback currently uses a square and includes garrisoned occupants. Neither
    // caretaker's circular radius nor its garrison exclusion may leak in here.
    expect(occupied(20000+grid/2-1,20000+grid/2-1,22000,22000)).toBe(true);scope.close();
    observation.entities.push({...object('ghost','building','town_center',60000,60000),ghost:true},{...object('empty','resource','tree',70000,60000),resource:'wood',amount:0},
      ...Array.from({length:1200},(_,index):ViewEntity=>({...object(`rectangle_${index}`,index%13===0?'building':index%11===0?'unit':'resource',index%13===0?'barracks':index%11===0?'archer':'tree',-30000+(index*7919)%190000,-30000+(index*3571)%190000),rotation:index%2?90:270,...(index%13&&index%11?{resource:'wood' as const,amount:index%17?250:0,...(index%3?{}:{forest:{patchId:'rectangles',cellMm:6000}})}:{}),...(index%19?{}:{ghost:true})})));
    // Duplicate IDs remain separate observed footprints, just as Array.some.
    observation.entities.push({...object('ghost','unit','militia',130000,130000)});
    scope=new AiDecisionContext(observation);occupied=scope.fallbackPlacement(observation,area)!;
    for(let index=0;index<2200;index++){
      const left=-32000+(index*719)%180000,top=-32000+(index*337)%180000,width=[1,500,2000,7999,8000,10000][index%6]!,height=[1,999,2000,8000][index%4]!;
      expect(occupied(left,top,left+width,top+height),`query ${index}`).toBe(scalar(observation,left,top,left+width,top+height));
    }
    const overlay={...observation,entities:observation.entities.map(entity=>({...entity,order:'idle'}))};scope.inherit(observation,overlay);
    expect(scope.fallbackPlacement(overlay,{...area})).toBe(occupied);scope.close();expect(scope.fallbackPlacement(observation,area)).toBeUndefined();
    observation.entities=[{...object('now_empty','resource','tree',20000,20000),resource:'wood',amount:0}];scope=new AiDecisionContext(observation);
    expect(scope.fallbackPlacement(observation,area)!(19000,19000,21000,21000)).toBe(false);scope.close();
  });

  it('avoids repeated observation traversal for the existing625 candidate bound',()=>{
    const observation=view();let positionReads=0;
    observation.entities=Array.from({length:1000},(_,index)=>({...object(`distant_${index}`,'resource','tree',130000+(index%10)*2000,100000+Math.floor(index/10)*400),resource:'wood' as const,amount:250}));
    for(const entity of observation.entities){const x=entity.xMm;Object.defineProperty(entity,'xMm',{enumerable:true,get(){positionReads++;return x;}});}
    const scope=new AiDecisionContext(observation),occupied=scope.fallbackPlacement(observation,area)!;
    const prepared=positionReads;expect(prepared).toBeLessThanOrEqual(observation.entities.length*4);
    for(let z=0;z<25;z++)for(let x=0;x<25;x++)expect(occupied(x*2000,z*2000,x*2000+6000,z*2000+6000)).toBe(false);
    expect(positionReads).toBe(prepared);positionReads=0;
    for(let z=0;z<25;z++)for(let x=0;x<25;x++)expect(scalar(observation,x*2000,z*2000,x*2000+6000,z*2000+6000)).toBe(false);
    expect(positionReads).toBeGreaterThanOrEqual(625*observation.entities.length);scope.close();
  });

  it('preserves exact fallback commands and memory for housing, barracks, farms and contour alternatives',()=>{
    let builds=0,outerBuilds=0;
    for(const needed of ['house','barracks','farm'])for(const density of [0,1])for(const contour of [false,true])for(const attempt of [0,3,127]){
      const observation=view();observation.self.resources={food:500,wood:500,gold:200,stone:200};
      if(needed==='house')observation.self.population=14;
      if(needed==='barracks')observation.entities=observation.entities.filter(entity=>entity.id!=='barracks');
      if(needed==='farm')observation.entities.find(entity=>entity.id==='known_food')!.amount=0;
      for(let index=0;index<500;index++)observation.entities.push({...object(`forest_${index}`,'resource','tree',density?30000+(index%25)*1600:120000+(index%25)*2000,density?70000+Math.floor(index/25)*1500:120000+Math.floor(index/25)*2000),resource:'wood',amount:index%11?250:0,...(index%7?{}:{ghost:true}),...(index%3?{}:{forest:{patchId:'placement_forest',cellMm:2000}})});
      const home=observation.entities.find(entity=>entity.id==='home')!,avoid=contour?Array.from({length:121},(_,index)=>({x:Math.floor(home.xMm/grid)-10+index%11*2,z:Math.floor(home.zMm/grid)-10+Math.floor(index/11)*2})):[];
      const options={scoutAllowed:false,economyOnly:true,avoidBuildingCells:avoid},before=structuredClone(observation),reference={...memory(),buildAttempt:attempt},actual=structuredClone(reference),scope=new AiDecisionContext(observation);
      const expected=fallbackCommands(observation,reference,options),commands=fallbackCommands(observation,actual,options,scope);scope.close();
      expect(commands).toEqual(expected);expect(actual).toEqual(reference);expect(observation).toEqual(before);
      const build=commands.find(command=>command.kind==='build');if(build?.kind==='build'){expect(build.buildingType).toBe(needed);builds++;if(Math.abs(build.originCell.x-Math.floor(home.xMm/grid))>10||Math.abs(build.originCell.z-Math.floor(home.zMm/grid))>10)outerBuilds++;}
    }
    expect(builds).toBeGreaterThan(24);expect(outerBuilds).toBeGreaterThan(0);
  });
});

function unexploredCorner(observation:PlayerView):PlayerView {
  observation.fog.explored=observation.fog.explored.filter(cell=>cell%50<44||Math.floor(cell/50)>=18);observation.fog.visible=[...observation.fog.explored];return observation;
}
/** The old seven-point patrol never reaches this unexplored north-east pocket. */
function strandedEconomy():PlayerView {
  const observation=view();observation.self.resources={food:0,wood:0,gold:0,stone:0};observation.self.autoReseed=true;
  for(const entity of observation.entities)if(entity.kind==='resource')entity.amount=0;
  observation.entities.push(...Array.from({length:20},(_,index)=>({...object(`empty_farm_${index}`,'building','farm',12000+(index%5)*6000,65000+Math.floor(index/5)*6000),resource:'food' as const,amount:0,farmerAssigned:false})));
  return unexploredCorner(observation);
}

describe('D108 shortage priorities',()=>{
  const preferred={food:50,wood:30,gold:15,stone:5};
  it.each([{food:2,wood:4128,gold:4589,stone:3531},{food:5290,wood:26,gold:58,stone:3500}])('shifts gathering toward actual shortages without mutating model preferences: %j',resources=>{
    const observation=view();observation.self.age=2;observation.self.resources=resources;const weights=effectiveEconomyWeights(observation,preferred);
    expect(Object.values(weights).reduce((sum,value)=>sum+value,0)).toBe(100);
    if(resources.food===2){expect(weights.food).toBeGreaterThan(75);expect(weights.wood).toBeLessThan(preferred.wood);}else{expect(weights.wood+weights.gold).toBeGreaterThan(75);expect(weights.food).toBeLessThan(preferred.food);}
    expect(preferred).toEqual({food:50,wood:30,gold:15,stone:5});
  });
  it('reassigns at most one surplus gatherer while preserving cargo and protected orders',()=>{
    const observation=view();observation.self.resources={food:2,wood:4128,gold:4589,stone:3531};const state=memory();state.assignments={};
    for(const worker of observation.entities.filter(entity=>entity.typeId==='villager')){worker.order='gather';state.assignments[worker.id]='wood';}
    observation.entities.find(entity=>entity.id==='worker_0')!.cargo={resource:'wood',amount:5};
    const commands=fallbackCommands(observation,state,{scoutAllowed:false,protectedEntityIds:new Set(['worker_1'])});
    const food=commands.filter(command=>command.kind==='gather'&&command.targetId==='known_food');expect(food).toHaveLength(1);expect(food[0]).toMatchObject({unitIds:['worker_2']});
    expect(commands.filter(command=>command.kind==='gather')).toHaveLength(1);
  });
});

describe('live late-age food recovery',()=>{
  it('retains a nonzero food allocation even when a zero-food model plan has no accumulated surplus yet',()=>{
    const observation=view();observation.self.resources={food:0,wood:0,gold:0,stone:0};const weights=effectiveEconomyWeights(observation,{food:0,wood:50,gold:25,stone:25});expect(weights.food).toBeGreaterThan(0);expect(weights.wood).toBeGreaterThan(0);expect(Object.values(weights).reduce((sum,value)=>sum+value,0)).toBe(100);
  });
  it.each([4,5,6] as const)('targets the next age food price in age %s, including a zero-food model preference',age=>{
    const observation=view();observation.rulesetId='legendary_ages_v1';observation.maxAge=8;observation.startingResourcePreset='long_war';observation.self.age=age;observation.self.resources={food:500,wood:50000,gold:50000,stone:50000};
    const preferred={food:0,wood:50,gold:25,stone:25},weights=effectiveEconomyWeights(observation,preferred);expect(weights.food).toBeGreaterThan(65);expect(Object.values(weights).reduce((sum,value)=>sum+value,0)).toBe(100);expect(preferred.food).toBe(0);
  });
  it('reconciles observed model worker jobs before shifting one safe surplus gatherer to food',()=>{
    const observation=view(),state=memory();observation.self.age=3;observation.self.resources={food:500,wood:50000,gold:50000,stone:50000};state.assignments={};
    for(const worker of observation.entities.filter(entity=>entity.typeId==='villager')){worker.order='gather';worker.workTargetId='known_wood';state.assignments[worker.id]='food';}
    observation.entities.find(entity=>entity.id==='worker_0')!.cargo={resource:'wood',amount:5};const before=structuredClone(observation);
    const commands=fallbackCommands(observation,state,{economyOnly:true,scoutAllowed:false,protectedEntityIds:new Set(['worker_1'])});expect(commands.filter(command=>command.kind==='gather'&&command.targetId==='known_food')).toEqual([{kind:'gather',unitIds:['worker_2'],targetId:'known_food',queued:false}]);expect(state.assignments.worker_3).toBe('wood');expect(state.assignments.worker_1).toBe('food');expect(observation).toEqual(before);
  });
});

describe('resource-starvation frontier recovery',()=>{
  it('discovers wood in the twelve-tree pocket and assigns gather orders beyond the obsolete patrol route',()=>{
    const observation=strandedEconomy(),state=memory(),scout:ViewEntity={...object('scout','unit','scout',70000,70000),order:'idle'};observation.entities.push(scout);
    // Only this fixture's observation producer holds these trees. The planner
    // receives a tree for the first time after its chosen scout route reveals it.
    const hidden=Array.from({length:12},(_,index)=>({...object(`unseen_tree_${index}`,'resource','tree_oak',97000,5000+index*2000),resource:'wood' as const,amount:250}));
    let discovered=0,gathered=false;
    for(let round=0;round<32&&!gathered;round++){
      const before=structuredClone(observation),commands=fallbackCommands(observation,state,{economyOnly:true});expect(observation).toEqual(before);
      gathered=commands.some(command=>command.kind==='gather'&&hidden.some(tree=>tree.id===command.targetId));
      for(const command of commands)if(command.kind==='gather')expect(observation.entities.some(entity=>entity.id===command.targetId&&!entity.ghost&&(entity.amount??0)>0)).toBe(true);
      const move=commands.find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
      if(move?.kind==='move'){
        scout.xMm=move.target.xMm;scout.zMm=move.target.zMm;
        const explored=new Set(observation.fog.explored);
        for(let cell=0;cell<2500;cell++)if(Math.hypot((cell%50)*2000+1000-scout.xMm,Math.floor(cell/50)*2000+1000-scout.zMm)<=units.scout.visionM*1000)explored.add(cell);
        observation.fog.explored=[...explored].sort((a,b)=>a-b);observation.fog.visible=[...observation.fog.explored];
        for(const tree of hidden)if(explored.has(Math.floor(tree.zMm/2000)*50+Math.floor(tree.xMm/2000))&&!observation.entities.some(entity=>entity.id===tree.id)){observation.entities.push(tree);discovered++;}
      }
      observation.tick+=balance.rules.simulationHz*5;
    }
    expect(discovered).toBeGreaterThan(0);expect(gathered).toBe(true);
  });
  it.each(['idle','unfunded_farm'] as const)('sends one %s worker to explore when there is no Scout or known wood',condition=>{
    const observation=strandedEconomy(),state=memory();
    if(condition==='unfunded_farm')for(const worker of observation.entities.filter(entity=>entity.typeId==='villager')){worker.order='gather';worker.taskState='blocked';worker.blockedReason='INSUFFICIENT_RESOURCES';state.assignments??={};state.assignments[worker.id]='food';}
    const moves=fallbackCommands(observation,state,{economyOnly:true}).filter(command=>command.kind==='move');
    expect(moves).toHaveLength(1);expect(moves[0]!.unitIds).toHaveLength(1);expect(observation.entities.find(entity=>entity.id===moves[0]!.unitIds[0])?.typeId).toBe('villager');
  });
  it('releases unfunded farmers to newly observed wood while preserving a reserved farmer',()=>{
    const observation=strandedEconomy(),state=memory(),workers=observation.entities.filter(entity=>entity.typeId==='villager');
    for(const worker of workers){worker.order='gather';worker.taskState='blocked';worker.blockedReason='INSUFFICIENT_RESOURCES';state.assignments??={};state.assignments[worker.id]='food';}
    observation.entities.push({...object('discovered_wood','resource','tree_oak',70000,40000),resource:'wood',amount:2500});
    const commands=fallbackCommands(observation,state,{reservedWorkerIds:[workers[0]!.id],economyOnly:true}),gathers=commands.filter((command):command is Extract<GameplayCommand,{kind:'gather'}>=>command.kind==='gather'&&command.targetId==='discovered_wood');
    expect(gathers.length).toBeGreaterThan(0);expect(gathers.every(command=>!command.unitIds.includes(workers[0]!.id))).toBe(true);expect(gathers.flatMap(command=>command.unitIds).every(id=>state.assignments?.[id]==='wood')).toBe(true);
  });
  it('does not commandeer queued, contained, reserved, busy, or cargo-returning workers for rescue scouting',()=>{
    const observation=strandedEconomy(),workers=observation.entities.filter(entity=>entity.typeId==='villager');
    workers[0]!.queuedOrderCount=1;workers[1]!.garrisonedIn='home';workers[3]!.order='build';workers[4]!.order='reseed';workers[5]!.order='attack_target';workers[6]!.cargo={resource:'wood',amount:10};
    const commands=fallbackCommands(observation,memory(),{reservedWorkerIds:[workers[2]!.id],economyOnly:true});
    expect(commands.filter(command=>command.kind==='move')).toMatchObject([{kind:'move',unitIds:[workers[7]!.id]}]);
    workers[7]!.order='repair';expect(fallbackCommands(observation,memory(),{reservedWorkerIds:[workers[2]!.id],economyOnly:true}).some(command=>command.kind==='move')).toBe(false);
  });
  it('tries a different frontier after a blocked route and preserves that progress through JSON memory restoration',()=>{
    const observation=strandedEconomy(),state=memory(),scout:ViewEntity={...object('scout','unit','scout',70000,70000),order:'idle'};observation.entities.push(scout);
    const first=fallbackCommands(observation,state).find(command=>command.kind==='move');expect(first?.kind).toBe('move');if(first?.kind!=='move')throw new Error('MISSING_FRONTIER_MOVE');
    scout.order='move';scout.taskState='blocked';scout.blockedReason='PATH_BLOCKED';observation.tick+=balance.rules.simulationHz*5;
    const restored=JSON.parse(JSON.stringify(state)) as FallbackMemory,second=fallbackCommands(observation,state).find(command=>command.kind==='move');
    expect(second?.kind).toBe('move');if(second?.kind!=='move')throw new Error('MISSING_ALTERNATE_MOVE');expect(second.target).not.toEqual(first.target);
    expect(fallbackCommands(observation,restored).find(command=>command.kind==='move')).toEqual(second);expect(restored).toEqual(state);
  });
  it('does not send emergency worker scouts when all land is already explored or scouting is disabled',()=>{
    const observation=strandedEconomy();expect(fallbackCommands(observation,memory(),{scoutAllowed:false}).some(command=>command.kind==='move')).toBe(false);
    observation.fog.explored=Array.from({length:2500},(_,cell)=>cell);observation.fog.visible=[...observation.fog.explored];
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='move')).toBe(false);
  });
  it('leaves a queued or reserved Scout alone and selects an available Scout instead',()=>{
    const observation=strandedEconomy();observation.entities.push({...object('queued_scout','unit','scout',70000,70000),order:'idle',queuedOrderCount:1},{...object('reserved_scout','unit','scout',70000,70000),order:'idle'},{...object('available_scout','unit','scout',70000,70000),order:'idle'});
    expect(fallbackCommands(observation,memory(),{reservedWorkerIds:['reserved_scout']}).filter(command=>command.kind==='move')).toMatchObject([{kind:'move',unitIds:['available_scout']}]);
  });
  it('retains one worker explorer across movement pulses and restored planner memory',()=>{
    const observation=strandedEconomy(),state=memory(),first=fallbackCommands(observation,state).find(command=>command.kind==='move');
    if(first?.kind!=='move')throw new Error('MISSING_WORKER_EXPLORER');
    const explorer=observation.entities.find(entity=>entity.id===first.unitIds[0])!;
    // A delayed own move reserves the still-idle explorer before admission.
    expect(fallbackCommands(observation,state,{reservedWorkerIds:[explorer.id]}).filter(command=>command.kind==='move')).toEqual([]);
    explorer.order='move';
    for(let pulse=0;pulse<6;pulse++){observation.tick+=balance.rules.simulationHz*5;expect(fallbackCommands(observation,state).filter(command=>command.kind==='move')).toEqual([]);}
    const restored=JSON.parse(JSON.stringify(state)) as FallbackMemory;explorer.order='idle';explorer.xMm=first.target.xMm;explorer.zMm=first.target.zMm;
    const next=fallbackCommands(observation,state).find(command=>command.kind==='move');expect(next).toMatchObject({kind:'move',unitIds:[explorer.id]});
    expect(fallbackCommands(observation,restored).find(command=>command.kind==='move')).toEqual(next);expect(restored).toEqual(state);
  });
  it.each(['garrisoned','queued','cargo','protected'] as const)('selects a new recovery worker when the previous explorer is now %s',condition=>{
    const observation=strandedEconomy(),state=memory(),first=fallbackCommands(observation,state).find(command=>command.kind==='move');
    if(first?.kind!=='move')throw new Error('MISSING_WORKER_EXPLORER');
    const prior=observation.entities.find(entity=>entity.id===first.unitIds[0])!,options:FallbackOptions={};observation.tick+=100;
    if(condition==='garrisoned')prior.garrisonedIn='home';else if(condition==='queued')prior.queuedOrderCount=1;else if(condition==='cargo')prior.cargo={resource:'wood',amount:10};else options.protectedEntityIds=new Set([prior.id]);
    const next=fallbackCommands(observation,state,options).find(command=>command.kind==='move');expect(next?.kind).toBe('move');if(next?.kind!=='move')throw new Error('MISSING_REPLACEMENT_EXPLORER');expect(next.unitIds).toHaveLength(1);expect(next.unitIds).not.toContain(prior.id);
  });
  it('lets an old blocked route become eligible again instead of permanently blacklisting it',()=>{
    const observation=strandedEconomy(),state=memory(),scout:ViewEntity={...object('scout','unit','scout',70000,70000),order:'idle'};observation.entities.push(scout);
    expect(fallbackCommands(observation,state).some(command=>command.kind==='move')).toBe(true);expect(state.scoutRoute).toBeDefined();
    scout.order='move';scout.taskState='blocked';scout.blockedReason='PATH_BLOCKED';observation.tick+=61*balance.rules.simulationHz;
    const freshRetry=JSON.parse(JSON.stringify(state)) as FallbackMemory;delete freshRetry.scoutRoute;
    const retry=fallbackCommands(observation,state).find(command=>command.kind==='move');expect(retry?.kind).toBe('move');expect(retry).toEqual(fallbackCommands(observation,freshRetry).find(command=>command.kind==='move'));
  });
});

describe('orphaned farm recovery after wood discovery',()=>{
  function recoveredWood(){
    const observation=view(),state=memory();observation.self.autoReseed=true;observation.self.resources={food:0,wood:60,gold:0,stone:0};
    observation.entities=observation.entities.filter(entity=>entity.kind!=='resource'||entity.resource==='wood');
    const farm:ViewEntity={...object('empty_farm','building','farm',25000,60000),resource:'food',amount:0,farmState:'exhausted',farmerAssigned:false};observation.entities.push(farm);
    const workers=observation.entities.filter(entity=>entity.typeId==='villager');state.assignments={};for(const worker of workers){worker.order='gather';state.assignments[worker.id]='wood';}
    return {observation,state,farm,workers};
  }
  it('restarts one orphaned empty farm when wood gatherers can pay the full reseed cost',()=>{
    const {observation,state,farm}=recoveredWood(),before=structuredClone(observation),commands=fallbackCommands(observation,state,{economyOnly:true}),reseeds=commands.filter(command=>command.kind==='reseed_farm');
    expect(reseeds).toHaveLength(1);const reseed=reseeds[0]!;expect(reseed.farmId).toBe(farm.id);expect(state.assignments?.[reseed.builderId]).toBe('food');expect(state.farmAssignments?.[farm.id]).toBe(reseed.builderId);
    expect(commands.some(command=>command.kind==='build'||command.kind==='gather'&&command.unitIds.includes(reseed.builderId)||command.kind==='move'&&command.unitIds.includes(reseed.builderId))).toBe(false);expect(observation).toEqual(before);
    const farmer=observation.entities.find(entity=>entity.id===reseed.builderId)!;farmer.order='reseed';farm.farmState='reseeding';farm.farmerAssigned=true;farm.reseedProgress=.1;
    expect(fallbackCommands(observation,state,{economyOnly:true}).some(command=>command.kind==='reseed_farm')).toBe(false);
  });
  it.each(['occupied','reserved','paid_reseed','foundation','foreign','setting_off','reserve_bank','protected_farm','reserved_farm'] as const)('does not issue an orphan reseed for %s',condition=>{
    const {observation,state,farm,workers}=recoveredWood(),options:FallbackOptions={economyOnly:true};
    if(condition==='occupied')farm.farmerAssigned=true;else if(condition==='reserved'){state.farmAssignments={[farm.id]:workers[0]!.id};state.assignments![workers[0]!.id]='food';}else if(condition==='paid_reseed'){farm.farmState='reseeding';farm.reseedProgress=.5;workers[0]!.order='reseed';}else if(condition==='foundation')farm.progress=.5;else if(condition==='foreign')farm.ownerId='opponent';else if(condition==='setting_off')observation.self.autoReseed=false;else if(condition==='protected_farm')options.protectedEntityIds=new Set([farm.id]);else if(condition==='reserved_farm')options.reservedWorkerIds=[farm.id];else observation.self.resources.wood=59;
    expect(fallbackCommands(observation,state,options).some(command=>command.kind==='reseed_farm')).toBe(false);
  });
  it.each(['protected','reserved','cargo','queued','garrisoned','paid_builder','paid_reseed','combat'] as const)('preserves a %s worker instead of assigning it to an orphan farm',condition=>{
    const {observation,state,workers}=recoveredWood(),worker=workers[0]!,options:FallbackOptions={economyOnly:true};observation.entities=observation.entities.filter(entity=>entity.typeId!=='villager'||entity.id===worker.id);
    if(condition==='protected')options.protectedEntityIds=new Set([worker.id]);else if(condition==='reserved')options.reservedWorkerIds=[worker.id];else if(condition==='cargo')worker.cargo={resource:'wood',amount:10};else if(condition==='queued')worker.queuedOrderCount=1;else if(condition==='garrisoned')worker.garrisonedIn='home';else if(condition==='paid_builder')worker.order='build';else if(condition==='paid_reseed')worker.order='reseed';else worker.order='attack_target';
    expect(fallbackCommands(observation,state,options).some(command=>command.kind==='reseed_farm')).toBe(false);
  });
  it('chooses another empty farm instead of letting a protected farm mask all recovery options',()=>{
    const {observation,state,farm}=recoveredWood(),available={...farm,id:'available_farm',xMm:35000};observation.entities.push(available);
    expect(fallbackCommands(observation,state,{economyOnly:true,protectedEntityIds:new Set([farm.id])}).filter(command=>command.kind==='reseed_farm')).toMatchObject([{kind:'reseed_farm',farmId:available.id}]);
  });
});

/** Prior assignment policy, deliberately retaining repeated target concatenation,
 * filtering and stable sorting. Fixtures disable purchases and scouting so this
 * independent algorithm describes every returned command and memory mutation. */
function scalarEconomy(observation:PlayerView,state:FallbackMemory,options:FallbackOptions={}):GameplayCommand[]{
  const result:GameplayCommand[]=[],own=observation.entities.filter(entity=>entity.ownerId===observation.playerId),home=own.find(entity=>entity.typeId==='town_center');if(!home)return result;
  const workers=own.filter(entity=>entity.typeId==='villager'),reserved=new Set(options.reservedWorkerIds??[]),available=workers.filter(worker=>!reserved.has(worker.id));
  const targets=observation.entities.filter(entity=>entity.kind==='resource'&&!entity.ghost&&(entity.amount??0)>0),farms=own.filter(entity=>entity.typeId==='farm'),forage=targets.filter(entity=>entity.resource==='food').reduce((sum,entity)=>sum+(entity.amount??0),0);
  const assignments=state.assignments??(state.assignments={}),farmAssignments=state.farmAssignments??(state.farmAssignments={});
  for(const id of Object.keys(assignments))if(!workers.some(worker=>worker.id===id&&(reserved.has(id)||['gather','reseed'].includes(worker.order??''))))delete assignments[id];
  for(const [farmId,workerId]of Object.entries(farmAssignments))if(!farms.some(farm=>farm.id===farmId)||!workers.some(worker=>worker.id===workerId&&['gather','reseed'].includes(worker.order??'')&&worker.blockedReason!=='FARM_OCCUPIED'))delete farmAssignments[farmId];
  const assigned=new Set<string>(),claimedFarms=new Set<string>(),foundations=own.filter(entity=>entity.kind==='building'&&!entity.ghost&&(entity.progress??1)<1),unfinished=foundations[0],builders=workers.filter(worker=>worker.order==='build');
  const assist=foundations.length===1&&builders.length===1&&!reserved.has(builders[0]!.id)&&builders[0]!.taskState==='blocked'&&builders[0]!.blockedReason==='PATH_BLOCKED';
  if(unfinished&&!workers.some(worker=>worker.order==='reseed')&&(!builders.length||assist)){
    const builder=available.filter(worker=>!worker.garrisonedIn&&!worker.queuedOrderCount&&(assist?worker.order==='idle':['idle','gather'].includes(worker.order??'idle'))).sort((a,b)=>Math.hypot(a.xMm-unfinished.xMm,a.zMm-unfinished.zMm)-Math.hypot(b.xMm-unfinished.xMm,b.zMm-unfinished.zMm)||a.id.localeCompare(b.id))[0];
    if(builder){result.push({kind:'continue_build',builderIds:[builder.id],foundationId:unfinished.id,queued:false});assigned.add(builder.id);delete assignments[builder.id];for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===builder.id)delete farmAssignments[farmId];}
  }
  const gather=(worker:ViewEntity,target:ViewEntity)=>{
    result.push({kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false});assignments[worker.id]=target.resource!;assigned.add(worker.id);
    for(const [farmId,workerId]of Object.entries(farmAssignments))if(workerId===worker.id)delete farmAssignments[farmId];
    if(target.typeId==='farm'){claimedFarms.add(target.id);farmAssignments[target.id]=worker.id;}
  };
  const freeFarms=()=>farms.filter(farm=>farm.progress===1&&(farm.amount??0)>0&&!farm.farmerAssigned&&!farmAssignments[farm.id]&&!claimedFarms.has(farm.id));
  if(forage<250)for(const farm of freeFarms()){
    const worker=available.find(candidate=>!assigned.has(candidate.id)&&(candidate.order==='idle'||candidate.blockedReason==='FARM_OCCUPIED'))??available.find(candidate=>!assigned.has(candidate.id)&&candidate.order==='gather'&&assignments[candidate.id]!=='food');
    if(worker)gather(worker,farm);
  }
  const allocation:ResourceType[]=['wood','food','food','gold','wood','food','stone','food','wood','food'];
  const nearest=(worker:ViewEntity,resource:ResourceType)=>[...targets,...(resource==='food'?freeFarms():[])].filter(entity=>entity.resource===resource).sort((a,b)=>Math.hypot(a.xMm-worker.xMm,a.zMm-worker.zMm)-Math.hypot(b.xMm-worker.xMm,b.zMm-worker.zMm))[0];
  for(const [index,worker]of workers.entries())if(!reserved.has(worker.id)&&(worker.order==='idle'||worker.blockedReason==='FARM_OCCUPIED')&&!assigned.has(worker.id)){
    const resource=allocation[index%allocation.length]!,target=nearest(worker,resource)??nearest(worker,resource==='wood'?'food':'wood');if(target)gather(worker,target);
  }
  for(const resource of ['gold','stone'] as const)if(targets.some(entity=>entity.resource===resource)&&!Object.values(assignments).includes(resource)){
    const worker=available.find(candidate=>!assigned.has(candidate.id)&&candidate.order==='gather'&&assignments[candidate.id]==='wood'),target=worker&&nearest(worker,resource);if(worker&&target){gather(worker,target);break;}
  }
  if(farms.length&&!observation.self.autoReseed)result.push({kind:'set_auto_reseed',enabled:true});return result;
}

describe('ordered fallback resource selection',()=>{
  function economicView(){const observation=view();observation.self.resources={food:0,wood:0,gold:0,stone:0};return observation;}
  function check(observation:PlayerView,state:FallbackMemory,expected:FallbackMemory,options:FallbackOptions={}){
    const before=structuredClone(observation),actual=fallbackCommands(observation,state,{...options,scoutAllowed:false}),reference=scalarEconomy(observation,expected,options);
    expect(actual).toEqual(reference);expect(JSON.stringify(state)).toBe(JSON.stringify(expected));expect(observation).toEqual(before);return actual;
  }
  it('keeps original source-order ties ahead of lexical IDs, including resource-before-farm ties',()=>{
    const observation=economicView(),workers=observation.entities.filter(entity=>entity.typeId==='villager');for(const worker of workers){worker.xMm=50000;worker.zMm=50000;}
    const targets:ViewEntity[]=[{...object('z_first','resource','tree_oak',49000,50000),resource:'wood',amount:500},{...object('a_second','resource','tree_oak',51000,50000),resource:'wood',amount:500},{...object('z_food','resource','forage_patch',51000,50000),resource:'food',amount:500},{...object('a_farm','building','farm',49000,50000),resource:'food',amount:500,farmerAssigned:false}];
    observation.entities=[...observation.entities.filter(entity=>entity.kind!=='resource'),targets[3]!,...targets.slice(0,3)];
    const first=check(observation,memory(),memory());expect(first.find(command=>command.kind==='gather'&&command.unitIds[0]===workers[0]!.id)).toMatchObject({targetId:'z_first'});expect(first.find(command=>command.kind==='gather'&&command.unitIds[0]===workers[1]!.id)).toMatchObject({targetId:'z_food'});
    observation.entities.splice(observation.entities.indexOf(targets[0]!),2,targets[1]!,targets[0]!);const reordered=check(observation,memory(),memory());expect(reordered.find(command=>command.kind==='gather'&&command.unitIds[0]===workers[0]!.id)).toMatchObject({targetId:'a_second'});
  });
  it('retains weighted worker positions, aliases, duplicate IDs and reservation-memory insertion order',()=>{
    const observation=economicView(),worker=observation.entities.find(entity=>entity.id==='worker_0')!,node=observation.entities.find(entity=>entity.resource==='wood')!;
    observation.entities.splice(observation.entities.indexOf(worker)+1,0,worker,{...worker,id:'worker_1',order:'gather'});observation.entities.push(node,{...node},{...node,resource:'food',amount:500},{...node,id:'hidden',ghost:true,xMm:worker.xMm,zMm:worker.zMm});
    const initial:FallbackMemory={sequence:7,scoutIndex:4,buildAttempt:3,assignments:{gone:'gold',worker_1:'wood',worker_3:'stone'},farmAssignments:{missing_farm:'worker_1'}};
    const actual=check(observation,structuredClone(initial),structuredClone(initial),{reservedWorkerIds:['worker_0','worker_3']});
    expect(actual.filter(command=>command.kind==='gather'&&command.unitIds.includes('worker_0'))).toEqual([]);expect(actual.filter(command=>command.kind==='gather'&&command.unitIds.includes('worker_1'))).toHaveLength(1);
  });
  it('re-evaluates evolving farm reservations and ore assignments across repeated observations',()=>{
    const observation=economicView(),state=memory(),expected=memory(),forage=observation.entities.find(entity=>entity.resource==='food')!;
    const first={...object('farm_first','building','farm',44000,57000),resource:'food' as const,amount:500,farmerAssigned:false},second={...first,id:'farm_second',xMm:62000};observation.entities.push(first,first,{...first},second);
    for(let round=0;round<6;round++){
      forage.amount=round<2?249:250;first.amount=round===3?0:500;first.farmerAssigned=round===4;
      const workers=observation.entities.filter(entity=>entity.typeId==='villager');for(const [index,worker]of workers.entries()){worker.order=round%2?'gather':'idle';worker.blockedReason=round===5&&index===1?'FARM_OCCUPIED':undefined;}
      check(observation,state,expected,{reservedWorkerIds:round===2?['worker_0']:[]});observation.tick+=20;
    }
  });
  it.each([NaN,Infinity,-Infinity])('retains stable-sort behavior for a nonfinite distance (%s)',coordinate=>{
    const observation=economicView(),wood=observation.entities.find(entity=>entity.resource==='wood')!;
    observation.entities.push({...wood,id:'finite_second',xMm:45000,zMm:58000},{...wood,id:'finite_third',xMm:46000,zMm:58000});wood.xMm=coordinate;
    check(observation,memory(),memory());observation.entities.reverse();check(observation,memory(),memory());
  });
  it('matches nonfinite middle candidates, overflowed distances and farms without a food resource',()=>{
    const observation=economicView(),wood=observation.entities.find(entity=>entity.resource==='wood')!;
    observation.entities.push({...wood,id:'middle_nan',xMm:NaN},{...wood,id:'overflow',xMm:Number.MAX_VALUE,zMm:Number.MAX_VALUE},{...wood,id:'finite_last',xMm:45000,zMm:58000});
    observation.entities.push({...object('nonfood_farm','building','farm',45000,58000),resource:'wood',amount:500,farmerAssigned:false},{...object('unspecified_farm','building','farm',45000,58000),amount:500,farmerAssigned:false});
    check(observation,memory(),memory());
  });
  it('skips only discarded train and attack proposals while preserving every remaining write and command',()=>{
    const observation=unexploredCorner(view());observation.self.resources={food:300,wood:500,gold:100,stone:0};observation.tick=10000;
    observation.entities.push({...object('militia_a','unit','militia',50000,50000),order:'idle'},{...object('militia_b','unit','militia',55000,50000),order:'idle'},{...object('opponent_a','unit','villager',65000,50000),ownerId:'opponent'},{...object('opponent_b','unit','villager',45000,50000),ownerId:'opponent'},{...object('scout','unit','scout',70000,70000),order:'idle'});
    observation.self.population=14;const before=structuredClone(observation),economic=memory(),complete=memory();
    const expected=fallbackCommands(observation,complete),actual=fallbackCommands(observation,economic,{economyOnly:true});
    expect(expected.some(command=>command.kind==='train')).toBe(true);expect(expected.filter(command=>command.kind==='attack_target')).toHaveLength(2);expect(expected.some(command=>command.kind==='build')).toBe(true);expect(expected.some(command=>command.kind==='move')).toBe(true);
    expect(actual).toEqual(expected.filter(command=>command.kind!=='train'&&command.kind!=='attack_target'));expect(JSON.stringify(economic)).toBe(JSON.stringify(complete));expect(economic.buildAttempt).toBeGreaterThan(0);expect(economic.scoutIndex).toBe(1);expect(observation).toEqual(before);
  });
  it('preserves the standalone militia sort order inherited from the preceding soldier',()=>{
    const observation=economicView();observation.tick=10000;
    observation.entities.push({...object('first_soldier','unit','militia',40000,50000),order:'idle'},{...object('second_soldier','unit','militia',45000,50000),order:'idle'},{...object('first_enemy_in_source','unit','villager',60000,50000),ownerId:'opponent'},{...object('nearest_to_first','unit','villager',30000,50000),ownerId:'opponent'});
    expect(fallbackCommands(observation,memory()).filter(command=>command.kind==='attack_target')).toEqual([
      {kind:'attack_target',unitIds:['first_soldier'],targetId:'nearest_to_first',queued:false},
      {kind:'attack_target',unitIds:['second_soldier'],targetId:'nearest_to_first',queued:false},
    ]);
  });
});
describe('M2 fallback economy from authorized observations',()=>{
  it('resumes only an owned orphan with an unreserved idle/gather worker, preserving queued and emergency duties',()=>{
    const observation=view(),state=memory(),workers=observation.entities.filter(entity=>entity.typeId==='villager');
    observation.entities.push({...object('paid_farm','building','farm',50000,70000),progress:.3325});
    for(const worker of workers)worker.order='repair';
    workers[0]!.order='attack_target';workers[1]!.order='gather';workers[1]!.queuedOrderCount=1;workers[2]!.order='idle';workers[2]!.garrisonedIn='home';workers[3]!.order='idle';
    observation.entities.push({...object('foreign_worker','unit','villager',50000,70000),ownerId:'opponent',order:'idle'});
    expect(fallbackCommands(observation,state,{reservedWorkerIds:[workers[3]!.id]}).some(command=>command.kind==='continue_build')).toBe(false);
    workers[4]!.order='gather';const before=structuredClone(observation),commands=fallbackCommands(observation,state,{reservedWorkerIds:[workers[3]!.id]});
    expect(commands.filter(command=>command.kind==='continue_build')).toEqual([{kind:'continue_build',builderIds:[workers[4]!.id],foundationId:'paid_farm',queued:false}]);
    expect(commands.filter(command=>'unitIds'in command&&command.unitIds.includes(workers[4]!.id))).toEqual([]);expect(observation).toEqual(before);
    observation.entities.find(entity=>entity.id==='paid_farm')!.ownerId='opponent';expect(fallbackCommands(observation,state).some(command=>command.kind==='continue_build')).toBe(false);
  });
  it.each(['build','reseed'] as const)('retains existing %s work without adding a third builder or a reseed helper',order=>{
    const observation=unexploredCorner(view()),state=memory(),worker=observation.entities.find(entity=>entity.typeId==='villager')!;
    observation.entities.push({...object('paid_farm','building','farm',50000,70000),progress:.3325},{...object('scout','unit','scout',70000,70000),order:'idle'});observation.self.resources.food=100;
    worker.order=order;worker.taskState='blocked';worker.blockedReason='PATH_BLOCKED';
    if(order==='build'){const backup=observation.entities.filter(entity=>entity.typeId==='villager')[1]!;backup.order='build';backup.taskState='blocked';backup.blockedReason='PATH_BLOCKED';}
    for(let round=0;round<4;round++){observation.tick+=20;const commands=fallbackCommands(observation,state);expect(commands.some(command=>command.kind==='continue_build'||command.kind==='build')).toBe(false);expect(commands.some(command=>command.kind==='gather')).toBe(true);expect(commands.some(command=>command.kind==='train')).toBe(true);expect(commands.some(command=>command.kind==='move')).toBe(true);}
  });
  it('adds one idle helper to a sole path-blocked builder while retaining its order and other work',()=>{
    const observation=view(),state=memory(),workers=observation.entities.filter(entity=>entity.typeId==='villager'),original=workers[0]!,helper=workers[1]!;
    observation.entities.push({...object('paid_farm','building','farm',50000,70000),progress:.25});for(const worker of workers)worker.order='repair';original.order='build';original.taskState='blocked';original.blockedReason='PATH_BLOCKED';helper.order='idle';state.assignments={[helper.id]:'wood'};
    const before=structuredClone(observation),commands=fallbackCommands(observation,state);
    expect(commands.filter(command=>command.kind==='continue_build')).toEqual([{kind:'continue_build',builderIds:[helper.id],foundationId:'paid_farm',queued:false}]);expect(commands.filter(command=>'unitIds'in command&&command.unitIds.includes(helper.id))).toEqual([]);expect(state.assignments[helper.id]).toBeUndefined();expect(observation).toEqual(before);
  });
  it.each(['working_builder','other_block','reserved_builder','two_foundations','two_builders','reseed','no_idle','reserved_helper','queued_helper','garrisoned_helper','combat_helper','gather_helper'] as const)('does not assign blocked-foundation assistance for %s',condition=>{
    const observation=view(),state=memory(),workers=observation.entities.filter(entity=>entity.typeId==='villager'),original=workers[0]!,helper=workers[1]!;for(const worker of workers)worker.order='repair';original.order='build';original.taskState='blocked';original.blockedReason='PATH_BLOCKED';helper.order='idle';
    observation.entities.push({...object('paid_farm','building','farm',50000,70000),progress:.25});const reservedWorkerIds:string[]=[];
    if(condition==='working_builder')original.taskState='building';else if(condition==='other_block')original.blockedReason='SITE_OCCUPIED';else if(condition==='reserved_builder')reservedWorkerIds.push(original.id);else if(condition==='two_foundations')observation.entities.push({...object('another_farm','building','farm',65000,70000),progress:.5});else if(condition==='two_builders')workers[2]!.order='build';else if(condition==='reseed')workers[2]!.order='reseed';else if(condition==='no_idle')helper.order='move';else if(condition==='reserved_helper')reservedWorkerIds.push(helper.id);else if(condition==='queued_helper')helper.queuedOrderCount=1;else if(condition==='garrisoned_helper')helper.garrisonedIn='home';else if(condition==='combat_helper')helper.order='attack_target';else helper.order='gather';
    observation.entities.push({...object('foreign_idle','unit','villager',50000,70000),ownerId:'opponent',order:'idle'});expect(fallbackCommands(observation,state,{reservedWorkerIds}).some(command=>command.kind==='continue_build')).toBe(false);
  });
  it('retains the next scouting destination while scouting is disabled, then emits it when enabled',()=>{
    const observation=unexploredCorner(view()),state=memory();observation.entities.push({...object('scout','unit','scout',70000,70000),order:'idle'});
    for(let cycle=0;cycle<4;cycle++){observation.tick+=20;expect(fallbackCommands(observation,state,{scoutAllowed:false}).some(command=>command.kind==='move')).toBe(false);expect(state.scoutIndex).toBe(0);}
    const enabled=fallbackCommands(observation,state,{scoutAllowed:true}).find(command=>command.kind==='move');
    expect(enabled).toMatchObject({kind:'move',unitIds:['scout'],queued:false});expect(state.scoutIndex).toBe(1);
    // Omitting the option still scouts, and disabling it did not consume a target.
    expect(fallbackCommands(observation,memory()).find(command=>command.kind==='move')).toEqual(enabled);
  });
  it.each([
    ['west',14000,50000],['east',86000,50000],['north',50000,14000],['south',50000,86000],
  ] as const)('keeps frontier destinations legal with a home at the %s map edge',(_edge,xMm,zMm)=>{
    const observation=unexploredCorner(view()),state=memory(),home=observation.entities.find(entity=>entity.id==='home')!,radius=units.scout.collisionRadiusM*1000;
    home.xMm=xMm;home.zMm=zMm;observation.entities.push({...object('scout','unit','scout',50000,50000),order:'idle'});const before=structuredClone(observation);
    for(let index=0;index<2;index++){
      const command=fallbackCommands(observation,state).find(command=>command.kind==='move');expect(command?.kind).toBe('move');if(command?.kind!=='move')throw new Error('MISSING_SCOUT_MOVE');
      expect(command).toMatchObject({unitIds:['scout'],queued:false});expect(state.scoutIndex).toBe(index+1);
      for(const [axis,limit]of [['xMm',observation.map.widthMm],['zMm',observation.map.heightMm]] as const){
        expect(Number.isInteger(command.target[axis])).toBe(true);expect(command.target[axis]-radius).toBeGreaterThanOrEqual(0);expect(command.target[axis]+radius).toBeLessThanOrEqual(limit);
      }
      expect(new Navigation(observation.map.widthMm,observation.map.heightMm,[]).free(command.target,radius)).toBe(true);
      expect(validateClientCommand({protocolVersion:2,matchId:observation.matchId,matchEpoch:1,clientCommandId:`edge_${index}`,clientSequence:index+1,command})).toBe(true);
    }
    expect(observation).toEqual(before);
  });
  it('stops issuing purposeless scout patrols after the entire map has been explored',()=>{
    const observation=view(),state=memory();
    observation.entities.push({...object('scout','unit','scout',70000,70000),order:'idle'});
    for(let index=0;index<8;index++){observation.tick+=100;expect(fallbackCommands(observation,state).some(command=>command.kind==='move')).toBe(false);expect(state.scoutIndex).toBe(0);}
  });
  it.each([0,1])('saves and cold-restores a real pending frontier move while avoiding blocked outbound corner %s',scoutIndex=>{
    const sim=createSimulation({matchId:`scout_boundary_${scoutIndex}`,seed:'scout-boundary-save',controllers:true,sharedVision:false,factions:[{id:'bot',name:'Bot',teamId:'bot',color:'#123456',kind:'ai',difficulty:'medium'},{id:'other',name:'Other',teamId:'other',color:'#abcdef',kind:'human'}]});
    const home=Object.values(sim.state.entities).find(entity=>entity.ownerId==='bot'&&entity.typeId==='town_center')!,scout=Object.values(sim.state.entities).find(entity=>entity.ownerId==='bot'&&entity.typeId==='scout')!,radius=units.scout.collisionRadiusM*1000;
    home.xMm=scoutIndex?sim.state.widthMm-14000:14000;home.zMm=scoutIndex?sim.state.heightMm-14000:14000;sim.state.controllers.bot!.scoutIndex=scoutIndex;
    sim.state.map.terrain=[{id:'blocked_scout_corner',kind:'water',xMm:scoutIndex?sim.state.widthMm-2000:0,zMm:scoutIndex?sim.state.heightMm-2000:0,widthMm:2000,depthMm:2000,elevationMm:-1000}];sim.state.navigationRevision++;
    for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.explored=[];}
    sim.step(balance.ai.difficulty.medium.tacticalIntervalSeconds*balance.rules.simulationHz);
    const controller=sim.state.controllers.bot!,batch=controller.pending.find(batch=>batch.commands.some(command=>command.kind==='move'&&command.unitIds.includes(scout.id))),command=batch?.commands.find(command=>command.kind==='move'&&command.unitIds.includes(scout.id));
    expect(controller.mode).toBe('fallback');expect(batch?.executeTick).toBeGreaterThan(sim.state.tick);expect(command).toMatchObject({kind:'move',unitIds:[scout.id],queued:false});
    if(command?.kind!=='move')throw new Error('MISSING_PENDING_SCOUT_MOVE');expect(new Navigation(sim.state.widthMm,sim.state.heightMm,terrainObstacles(sim.state.map.terrain)).free(command.target,radius)).toBe(true);
    const captured=sim.capture();expect(validateSimulationSavePayload(captured),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const identity:EngineIdentity={engineBuildHash:'7'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(JSON.parse(JSON.stringify(exportSimulationSave(sim,identity))),identity,{preserveEpoch:true});
    expect(restored.state.controllers.bot!.pending).toEqual(controller.pending);expect(restored.capture()).toEqual(captured);expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(captured));
    const throughAdmission=Math.ceil(balance.ai.difficulty.medium.reactionDelaySeconds*balance.rules.simulationHz)+1;sim.step(throughAdmission);restored.step(throughAdmission);expect(restored.capture()).toEqual(sim.capture());
  });
  it.each([120,200] as const)('does not purchase useless housing at the configured %s population limit',limit=>{
    const observation=view(),state=memory();observation.self.populationLimit=limit;observation.self.populationCap=limit;observation.self.population=limit;
    for(let round=0;round<4;round++){observation.tick+=20;expect(fallbackCommands(observation,state).filter(command=>command.kind==='build'&&command.buildingType==='house')).toEqual([]);}
    // A housing shortage at the same current supply remains actionable when the
    // configured ceiling is higher; the controller never infers it from a default.
    observation.self.populationLimit=200;observation.self.populationCap=20;observation.self.population=18;
    expect(fallbackCommands(observation,state).some(command=>command.kind==='build'&&command.buildingType==='house')).toBe(true);
  });
  it('counts the non-wall building limit without suppressing ordinary worker assignments',()=>{
    const observation=view();observation.entities=observation.entities.filter(entity=>entity.typeId!=='barracks');
    for(let i=1;i<balance.rules.maxNonWallBuildingsPerPlayer;i++)observation.entities.push(object(`existing_${i}`,'building','house',0,0));
    const commands=fallbackCommands(observation,memory());expect(commands.some(command=>command.kind==='build')).toBe(false);expect(commands.some(command=>command.kind==='gather')).toBe(true);
    observation.entities=observation.entities.filter(entity=>entity.id!==`existing_${balance.rules.maxNonWallBuildingsPerPlayer-1}`);
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='build'&&command.buildingType==='barracks')).toBe(true);
    observation.entities.push({...object('paid_foundation','building','house',20000,70000),progress:.1});
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='build')).toBe(false);
  });
  it('selects one available Scout after a contained Scout, and never moves contained or foreign Scouts',()=>{
    const observation=unexploredCorner(view());observation.entities.push({...object('contained','unit','scout',50000,50000),garrisonedIn:'home',order:'idle'}, {...object('available','unit','scout',70000,70000),order:'idle'}, {...object('foreign','unit','scout',15000,90000),ownerId:'opponent',order:'idle'});
    expect(fallbackCommands(observation,memory()).filter(command=>command.kind==='move')).toMatchObject([{kind:'move',unitIds:['available']}]);
    observation.entities.find(entity=>entity.id==='available')!.garrisonedIn='home';
    expect(fallbackCommands(observation,memory()).filter(command=>command.kind==='move')).toEqual([]);
  });
  it('allocates idle workers to all four known resources using valid command contracts',()=>{
    const observation=view(),commands=fallbackCommands(observation,memory());
    const gathering=commands.filter(command=>command.kind==='gather');
    expect(new Set(gathering.map(command=>observation.entities.find(entity=>entity.id===command.targetId)?.resource))).toEqual(new Set(['food','wood','gold','stone']));
    for(const [i,command] of commands.entries())expect(validateClientCommand({protocolVersion:2,matchId:'fallback',matchEpoch:1,clientCommandId:`command_${i}`,clientSequence:i+1,command})).toBe(true);
  });
  it('cannot target hidden or remembered ore absent from its authorized live entities',()=>{
    const observation=view();observation.entities=observation.entities.filter(entity=>entity.resource!=='gold');
    observation.entities.find(entity=>entity.resource==='stone')!.ghost=true;
    const commands=fallbackCommands(observation,memory());
    for(const command of commands)if(command.kind==='gather')expect(['known_food','known_wood']).toContain(command.targetId);
  });
  it('reserves only one worker per free farm and retains an assigned farmer during return travel',()=>{
    const observation=view();observation.entities=observation.entities.filter(entity=>entity.resource!=='food');
    observation.entities.push({...object('free_farm','building','farm',50000,70000),resource:'food',amount:350,farmerAssigned:false},{...object('working_farm','building','farm',40000,70000),resource:'food',amount:200,farmerAssigned:true});
    const commands=fallbackCommands(observation,memory());
    expect(commands.filter(command=>command.kind==='gather'&&command.targetId==='free_farm')).toHaveLength(1);
    expect(commands.filter(command=>command.kind==='gather'&&command.targetId==='working_farm')).toHaveLength(0);
    expect(commands.some(command=>command.kind==='set_auto_reseed'&&command.enabled)).toBe(true);
  });
  it('plans affordable farms when forage is depleted, respecting public water and slopes',()=>{
    const observation=view();observation.entities=observation.entities.filter(entity=>entity.resource!=='food');
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='build'&&command.buildingType==='farm')).toBe(true);
    observation.map.terrain=[{id:'water','kind':'water',xMm:0,zMm:0,widthMm:100000,depthMm:100000,elevationMm:-1000}];
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='build')).toBe(false);
    observation.map.terrain=[];observation.self.resources.wood=0;
    expect(fallbackCommands(observation,memory()).some(command=>command.kind==='build')).toBe(false);
  });
  it('retains a farm reservation across planner cycles while its worker deposits other cargo',()=>{
    const observation=view(),state=memory();observation.entities=observation.entities.filter(entity=>entity.resource!=='food');
    observation.self.resources.wood=0;
    observation.entities.push({...object('free_farm','building','farm',50000,70000),resource:'food',amount:350,farmerAssigned:false});
    const first=fallbackCommands(observation,state),farmOrder=first.find(command=>command.kind==='gather'&&command.targetId==='free_farm');
    expect(farmOrder?.kind).toBe('gather');if(farmOrder?.kind!=='gather')throw new Error('Missing farm order');
    const farmer=observation.entities.find(entity=>entity.id===farmOrder.unitIds[0])!;
    farmer.order='gather';farmer.taskState='returning';farmer.cargo={resource:'wood',amount:10};
    const second=fallbackCommands(observation,state);
    expect(second.filter(command=>command.kind==='gather'&&command.targetId==='free_farm')).toHaveLength(0);
    farmer.order='idle';farmer.cargo={resource:null,amount:0};
    expect(fallbackCommands(observation,state).filter(command=>command.kind==='gather'&&command.targetId==='free_farm')).toHaveLength(1);
  });
});
