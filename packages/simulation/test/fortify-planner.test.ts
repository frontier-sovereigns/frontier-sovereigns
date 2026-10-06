import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, PROTOCOL_VERSION, contentHash, type PlayerView, type ViewEntity, type Cell } from '@frontier/shared';
import { fortifyCommands, fortifyControllerCommands, markFortifyQueued, type FortifyMemory } from '../src/fortify-planner.js';
import { fortifyViewObstacle, resolveFortifyGeometry, validFortifyLayout, fortifyLayoutSignature, fortifyPlacementCells, fortifyPlacementCellLimit, fortifyPlanCellLimit, resolveFortifyScreen, validFortifyScreen, matchesFortifyScreenEntity, fortifyScreenPlacementCells } from '../src/fortify-geometry.js';
import { Navigation, PathBudgetExceededError } from '../src/navigation.js';
import { buildingCommand } from '../src/caretaker.js';
import { fallbackCommands } from '../src/fallback.js';
import { fortificationObstacles } from '../src/fortifications.js';
import { createCommanderState } from '../src/ai-controller.js';
import { validateCommanderMemory } from '../src/save-schema.js';

function fixture():PlayerView{
  const entity=(id:string,typeId:string,xMm:number,zMm:number):ViewEntity=>({id,typeId,xMm,zMm,kind:typeId==='villager'?'unit':'building',ownerId:'a',hp:100,maxHp:100,progress:1,order:'idle'});
  return {protocolVersion:PROTOCOL_VERSION,contentHash,matchId:'planner',matchEpoch:1,tick:0,sequence:0,playerId:'a',status:'RUNNING',map:{widthMm:200000,heightMm:200000,fogCellMm:2000,terrain:[]},self:{populationLimit:120,lastCommandSequence:0,resources:{food:200,wood:250,gold:100,stone:150},age:1,population:1,populationCap:10,reservedPopulation:0},players:[{id:'a',name:'A',teamId:'a',kind:'ai',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8844'}],entities:[entity('home','town_center',100000,100000),entity('worker','villager',100000,110000)],fog:{visible:Array.from({length:10000},(_,i)=>i),explored:Array.from({length:10000},(_,i)=>i)}};
}
const goal={kind:'fortify' as const,anchorRef:'home',material:'palisade' as const,radiusM:18};
describe('Legendary fortification families',()=>{
  function legendaryFixture(){const view=fixture();view.rulesetId='legendary_ages_v1';view.maxAge=8;view.self.age=8;view.self.resources={food:10000,wood:10000,gold:10000,stone:10000};view.self.technologies=['citadel_engineering','runic_engineering','colossal_engineering','eternal_engineering'];return view;}
  it.each(['bastion','runestone','titan','eternal'] as const)('plans legal broad %s gates with five occupied wall cells',material=>{
    const view=legendaryFixture(),memory:FortifyMemory={},result=fortifyCommands(view,{...goal,material},memory);
    expect(result.status,result.reason).toBe('building');expect(result.commands[0]).toMatchObject({kind:'build',buildingType:material+'_gate'});
    expect(memory.layout?.gates).toHaveLength(4);expect(memory.layout!.gates.every(gate=>gate.widthCells===5)).toBe(true);expect(validFortifyLayout(memory.layout!)).toBe(true);
    expect(fortifyPlacementCells(memory.layout!).length).toBe(memory.layout!.cells.length+80);
    expect(result.commands[0]).not.toHaveProperty('widthCells');
  });
  it('keeps requirements authoritative before expensive geometry planning',()=>{
    const view=legendaryFixture();view.self.technologies=[];
    expect(fortifyCommands(view,{...goal,material:'eternal'},{})).toMatchObject({status:'blocked',reason:'TECHNOLOGY_REQUIRED',commands:[]});
    view.rulesetId='classic_v1';view.maxAge=4;
    expect(fortifyCommands(view,{...goal,material:'bastion'},{})).toMatchObject({status:'blocked',reason:'AGE_REQUIRED',commands:[]});
  });
  it('upgrades existing matching defenses sequentially and waits for the paid upgrade',()=>{
    const view=legendaryFixture(),memory:FortifyMemory={},initial={...goal,material:'bastion' as const};
    expect(fortifyCommands(view,initial,memory).status).toBe('building');const layout=memory.layout!;
    const holes=new Set(layout.gates.flatMap(gate=>Array.from({length:5},(_,index)=>`${gate.originCell.x+(gate.rotation===0?index:0)},${gate.originCell.z+(gate.rotation===90?index:0)}`)));
    for(const [index,cell]of layout.cells.entries())if(!holes.has(`${cell.x},${cell.z}`))view.entities.push({id:'wall_'+index,kind:'building',typeId:'bastion_wall',ownerId:'a',xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,hp:2500,maxHp:2500,progress:1});
    for(const [index,gate]of layout.gates.entries())view.entities.push({id:'gate_'+index,kind:'building',typeId:'bastion_gate',ownerId:'a',xMm:(gate.originCell.x+(gate.rotation===0?2.5:.5))*2000,zMm:(gate.originCell.z+(gate.rotation===90?2.5:.5))*2000,hp:4000,maxHp:4000,progress:1,rotation:gate.rotation,gateMode:'AUTO',gateOpen:false});
    expect(fortifyCommands(view,initial,memory).status).toBe('complete');
    const next={...goal,material:'eternal' as const},upgrade=fortifyCommands(view,next,memory).commands[0]!;
    expect(upgrade).toMatchObject({kind:'upgrade_structure',targetTypeId:'runestone_wall'});if(upgrade.kind!=='upgrade_structure')throw new Error('EXPECTED_UPGRADE');
    expect(upgrade.buildingIds.length).toBeGreaterThan(0);expect(upgrade.buildingIds.length).toBeLessThanOrEqual(64);
    view.entities.find(entity=>entity.id===upgrade.buildingIds[0])!.upgrade={jobId:'paid',targetTypeId:'runestone_wall',progress:.1,started:true,state:'active'};
    expect(fortifyCommands(view,next,memory)).toEqual({status:'waiting',commands:[],reason:'UPGRADE_IN_PROGRESS'});
  });
  it('keeps old narrow gates intact while finding a legal later-age defense',()=>{
    const view=legendaryFixture(),memory:FortifyMemory={},initial={...goal,material:'stone' as const};
    expect(fortifyCommands(view,initial,memory).status).toBe('building');const layout=memory.layout!;
    const holes=new Set(layout.gates.flatMap(gate=>Array.from({length:3},(_,i)=>`${gate.originCell.x+(gate.rotation===0?i:0)},${gate.originCell.z+(gate.rotation===90?i:0)}`)));
    for(const [i,cell]of layout.cells.entries())if(!holes.has(`${cell.x},${cell.z}`))view.entities.push({id:'old_wall_'+i,kind:'building',typeId:'stone_wall',ownerId:'a',xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,hp:1600,maxHp:1600,progress:1});
    for(const [i,gate]of layout.gates.entries())view.entities.push({id:'old_gate_'+i,kind:'building',typeId:'stone_gate',ownerId:'a',xMm:(gate.originCell.x+(gate.rotation===0?1.5:.5))*2000,zMm:(gate.originCell.z+(gate.rotation===90?1.5:.5))*2000,rotation:gate.rotation,hp:2400,maxHp:2400,progress:1,gateMode:'AUTO',gateOpen:false});
    expect(fortifyCommands(view,initial,memory).status).toBe('complete');const before=structuredClone(view),result=fortifyCommands(view,{...goal,material:'bastion'},memory);
    expect(view).toEqual(before);expect(result.status,result.reason).toBe('building');
    for(const command of result.commands){expect(command.kind).not.toBe('replace_gate');if(command.kind==='upgrade_structure')expect(command.buildingIds.some(id=>id.startsWith('old_gate'))).toBe(false);if(command.kind==='build')expect(command.buildingType).toBe('bastion_gate');}
  });
  it('requires every cell of a wide gate to belong to its saved straight contour',()=>{
    const view=legendaryFixture(),memory:FortifyMemory={};fortifyCommands(view,{...goal,material:'bastion'},memory);
    const layout=structuredClone(memory.layout!);layout.gates[0]!.originCell.x-=20;layout.signature=fortifyLayoutSignature(layout.cells,layout.gates);
    expect(validFortifyLayout(layout)).toBe(false);
  });
});
it('limits repeated controller proof preparation while preserving the actionable failure and changed goal',()=>{
  const view=fixture(),memory:FortifyMemory={};view.fog.visible=[];view.fog.explored=[];
  const resolve=vi.spyOn(Navigation.prototype,'clearLine');
  try{
    const first=fortifyControllerCommands(view,goal,memory);expect(first.status).toBe('blocked');expect(memory.nextPlanningTick).toBe(5*balance.rules.simulationHz);
    const before=structuredClone(memory);resolve.mockClear();view.tick=balance.rules.simulationHz;
    expect(fortifyControllerCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:before.blockedGeometry?.reason??first.reason,commands:[]});expect(memory).toEqual(before);expect(resolve).not.toHaveBeenCalled();
    const restored=structuredClone(memory);view.fog.explored=fixture().fog.explored;view.fog.visible=view.fog.explored;view.tick=5*balance.rules.simulationHz;
    expect(fortifyControllerCommands(view,goal,restored).status).toBe('building');expect(restored.nextPlanningTick).toBeUndefined();
    view.tick=balance.rules.simulationHz;expect(fortifyControllerCommands(view,{...goal,material:'stone'},memory)).toMatchObject({status:'blocked',reason:'AGE_REQUIRED'});
  }finally{resolve.mockRestore();}
});
function paidFixture(){
  const view=fixture(),memory:FortifyMemory={},first=fortifyCommands(view,goal,memory).commands[0]!;if(first.kind!=='build')throw new Error('MISSING_GATE');
  view.entities.push({id:'paid_gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:(first.originCell.x+(first.rotation===0?1.5:.5))*2000,zMm:(first.originCell.z+(first.rotation===90?1.5:.5))*2000,rotation:first.rotation,hp:600,maxHp:600,progress:1});
  expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(memory.layoutCommitted).toBe(true);
  const cells=(gate:{originCell:{x:number;z:number};rotation:number})=>Array.from({length:3},(_,index)=>({x:gate.originCell.x+(gate.rotation===0?index:0),z:gate.originCell.z+(gate.rotation===90?index:0)}));
  const fog=(cell:{x:number;z:number})=>cell.z*100+cell.x;
  return {view,memory,cells,fog};
}
function sandwichedWallFixture(){
  const view=fixture(),memory:FortifyMemory={};fortifyCommands(view,goal,memory);
  for(const [index,gate]of memory.layout!.gates.entries())view.entities.push({id:`paid_gate_${index}`,kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:(gate.originCell.x+(gate.rotation===0?1.5:.5))*2000,zMm:(gate.originCell.z+(gate.rotation===90?1.5:.5))*2000,rotation:gate.rotation,hp:600,maxHp:600,progress:1,gateMode:'AUTO',gateOpen:false});
  // Keep this work-face test about connected defenses; ordinary structures now
  // require streets and must reject this entire cramped layout before search.
  for(const [side,xs,zs]of [['north',[91000,93000,95000],[77000,79000,81000]],['south',[95000,97000,99000],[85000,87000,89000]]] as const)for(const xMm of xs)for(const zMm of zs)view.entities.push({id:`${side}_${xMm}_${zMm}`,kind:'building',typeId:'palisade_wall',ownerId:'a',xMm,zMm,hp:800,maxHp:800,progress:1});
  return {view,memory,run:Array.from({length:8},(_,index)=>({x:41+index,z:41}))};
}
describe('M3 filtered desired-state fortification planner',()=>{
  it('uses a discovered frontage when a complete ring reaches unexplored ground',()=>{
    const view=fixture(),memory:FortifyMemory={};view.fog.visible=[];view.fog.explored=view.fog.explored.filter(cell=>{const x=(cell%100+.5)*2000,z=(Math.floor(cell/100)+.5)*2000;return x>=70000&&x<=130000&&z>=90000&&z<=140000;});
    expect(resolveFortifyGeometry(view,goal,{}, {remaining:100000,used:0})).toMatchObject({status:'blocked',reason:'RING_NOT_EXPLORED'});
    expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build_wall',material:'palisade'});expect(memory.screen).toBeDefined();expect(memory.layout).toBeUndefined();
  });
  it.each([false,true])('anchors a wall frontage to a mountain while retaining its broad other bypass (vertical=%s)',vertical=>{
    const view=fixture(),cells=Array.from({length:6},(_,index)=>({x:vertical?40:50+index,z:vertical?50+index:40})),screen={cells,origin:{xMm:100000,zMm:100000},signature:fortifyLayoutSignature(cells,[])},memory:FortifyMemory={screen,layoutCommitted:true};
    view.map.terrain=[{id:'mountain',kind:'ridge',xMm:vertical?72000:80000,zMm:vertical?80000:72000,widthMm:vertical?16000:20000,depthMm:vertical?20000:16000,elevationMm:3000}];
    view.fog.visible=[];view.fog.explored=view.fog.explored.filter(cell=>{const x=(cell%100+.5)*2000,z=(Math.floor(cell/100)+.5)*2000;return !(vertical?x>=72000&&x<88000&&z>=80000&&z<100000:x>=80000&&x<100000&&z>=72000&&z<88000);});
    const result=resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0});expect(result.status,result.status==='ready'?'':result.reason).toBe('ready');expect(memory.screen!.cells).toEqual(cells);
    view.entities.push({id:'bypass_blocker',kind:'building',typeId:'house',ownerId:'a',xMm:vertical?81000:118000,zMm:vertical?118000:81000,hp:600,maxHp:600,progress:1});
    expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0})).toMatchObject({status:'blocked',reason:'SCREEN_ACCESS_BLOCKED'});
  });
  it('selects nearby mountain faces without allowing a wall to seal two mountain ends',()=>{
    const view=fixture();view.map.terrain=[{id:'ridge',kind:'ridge',xMm:80000,zMm:72000,widthMm:20000,depthMm:16000,elevationMm:3000}];
    const memory:FortifyMemory={},result=resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0});expect(result.status).toBe('ready');
    const cells=memory.screen!.cells;expect(cells.some(cell=>cell.x===50||cell.x===39||cell.z===44||cell.z===35)).toBe(true);
    const joined=Array.from({length:6},(_,index)=>({x:50+index,z:40}));memory.screen={cells:joined,origin:{xMm:100000,zMm:100000},signature:fortifyLayoutSignature(joined,[])};memory.layoutCommitted=true;
    view.map.terrain.push({id:'other_ridge',kind:'ridge',xMm:112000,zMm:72000,widthMm:16000,depthMm:16000,elevationMm:3000});
    expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0})).toMatchObject({status:'blocked',reason:'SCREEN_ACCESS_BLOCKED'});
  });
  it('purchases an explored frontage without redundant visibility scouting',()=>{
    const view=fixture(),memory:FortifyMemory={};
    view.entities.push({id:'crowded_north',kind:'building',typeId:'town_center',ownerId:'a',xMm:100000,zMm:80000,hp:2400,maxHp:2400,progress:1});view.fog.visible=[];
    const proposed=fortifyCommands(view,goal,memory);expect(proposed.commands[0]).toMatchObject({kind:'build_wall',material:'palisade'});expect(memory.screen).toBeDefined();expect(proposed.commands.some(command=>command.kind==='move')).toBe(false);
    const commander=createCommanderState(view.matchId,view.playerId);commander.fortifications.fallback=memory;expect(validateCommanderMemory(commander,view.playerId,view.tick)).toBe(true);
  });
  it('proves screen connectivity locally without global resource-route searches or depletion restarts',()=>{
    const view=fixture(),memory:FortifyMemory={goalKey:'a:home:palisade:18'};
    for(let i=0;i<400;i++)view.entities.push({id:`distant_tree_${i}`,kind:'resource',typeId:'tree_oak',ownerId:null,xMm:20000+i%20*1500,zMm:20000+Math.floor(i/20)*1500,hp:1,maxHp:1,amount:250,resource:'wood'});
    expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0}).status).toBe('ready');
    const paths=vi.spyOn(Navigation.prototype,'pathToAny');
    try{expect(fortifyCommands(view,goal,memory).commands[0]?.kind).toBe('build_wall');expect(paths).not.toHaveBeenCalled();view.entities.at(-1)!.amount=0;expect(fortifyCommands(view,goal,memory).commands[0]?.kind).toBe('build_wall');expect(paths).not.toHaveBeenCalled();}
    finally{paths.mockRestore();}
  });
  it('uses a short frontage with two broad bypasses when a crowded settlement prevents a full ring',()=>{
    const view=fixture(),memory:FortifyMemory={};view.entities.push({id:'north_expansion',kind:'building',typeId:'town_center',ownerId:'a',xMm:100000,zMm:80000,hp:2400,maxHp:2400,progress:1});
    expect(resolveFortifyGeometry(view,goal,{}, {remaining:100000,used:0}).status).toBe('blocked');
    const budget={remaining:100000,used:0},result=fortifyCommands(view,goal,memory,budget);
    expect(result.status,result.reason).toBe('building');expect(result.commands[0]).toMatchObject({kind:'build_wall',material:'palisade'});expect(memory.screen).toBeDefined();expect(memory.layout).toBeUndefined();expect(memory.blockedGeometry).toBeUndefined();expect(validFortifyScreen(memory.screen!)).toBe(true);expect(memory.routesValid).toBe(true);expect(budget.used).toBeLessThanOrEqual(100000);
    expect(fortifyScreenPlacementCells(memory.screen!)).toHaveLength(162);
    const screen=memory.screen!,horizontal=screen.cells[0]!.z===screen.cells[1]!.z,minX=Math.min(...screen.cells.map(cell=>cell.x))*2000,minZ=Math.min(...screen.cells.map(cell=>cell.z))*2000,obstacles=view.entities.filter(entity=>entity.kind==='building').map(fortifyViewObstacle);
    const after=new Navigation(view.map.widthMm,view.map.heightMm,[...obstacles,...screen.cells.map((cell,index)=>({id:`screen_${index}`,xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,halfWidth:1000,halfHeight:1000}))]);
    for(const along of [-6000,18000]){const center={xMm:minX+(horizontal?along:1000),zMm:minZ+(horizontal?1000:along)};expect(after.clearLine({xMm:center.xMm-(horizontal?0:7000),zMm:center.zMm-(horizontal?7000:0)},{xMm:center.xMm+(horizontal?0:7000),zMm:center.zMm+(horizontal?7000:0)},6000)).toBe(true);}
  });
  it('retains a paid screen, resumes its foundation, and rejects narrowing its bypass',()=>{
    const view=fixture(),memory:FortifyMemory={goalKey:'a:home:palisade:18'};expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0}).status).toBe('ready');
    const screen=structuredClone(memory.screen!),cell=screen.cells[0]!,wall:ViewEntity={id:'paid_screen',kind:'building',typeId:'palisade_wall',ownerId:'a',xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,hp:100,maxHp:250,progress:.2};view.entities.push(wall);
    expect(matchesFortifyScreenEntity(screen,'palisade',wall)).toBe(true);expect(matchesFortifyScreenEntity(screen,'stone',wall)).toBe(false);
    expect(fortifyCommands(view,goal,memory).commands).toEqual([{kind:'continue_build',builderIds:['worker'],foundationId:wall.id,queued:false}]);expect(memory.layoutCommitted).toBe(true);expect(memory.screen).toEqual(screen);
    const state=createCommanderState(view.matchId,view.playerId);state.fortifications.fallback=memory;expect(validateCommanderMemory(state,'a',view.tick)).toBe(true);
    const restored=JSON.parse(JSON.stringify(state));expect(validateCommanderMemory(restored,'a',view.tick)).toBe(true);expect(fortifyCommands(view,goal,restored.fortifications.fallback)).toEqual(fortifyCommands(view,goal,memory));
    restored.fortifications.fallback.screen.cells[1]={...screen.cells[0]};restored.fortifications.fallback.screen.signature=fortifyLayoutSignature(restored.fortifications.fallback.screen.cells,[]);expect(validateCommanderMemory(restored,'a',view.tick)).toBe(false);
    wall.progress=1;const lane=fortifyScreenPlacementCells(screen)[51]!;view.entities.push({id:'lane_blocker',kind:'building',typeId:'house',ownerId:'a',xMm:(lane.x+.5)*2000,zMm:(lane.z+.5)*2000,hp:600,maxHp:600,progress:1});
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'SCREEN_ACCESS_BLOCKED',commands:[]});expect(memory.screen).toEqual(screen);
  });
  it('never treats hidden screen footprints or tree-occupied sites as permission to construct',()=>{
    const view=fixture(),memory:FortifyMemory={goalKey:'a:home:palisade:18'};view.fog.visible=[];view.fog.explored=[];expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0})).toMatchObject({status:'blocked',reason:'SCREEN_NO_LEGAL_SITE'});expect(memory.screen).toBeUndefined();
    view.fog.explored=fixture().fog.explored;view.fog.visible=view.fog.explored;expect(resolveFortifyScreen(view,goal,memory,{remaining:100000,used:0}).status).toBe('ready');const selected=structuredClone(memory.screen!),cell=selected.cells[2]!;
    view.entities.push({id:'tree_at_screen',kind:'resource',typeId:'wood_oak',ownerId:null,xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,hp:1,maxHp:1,resource:'wood',amount:250,forest:{patchId:'known_forest',cellMm:3000}});
    const replacement=fortifyCommands(view,goal,memory);for(const command of replacement.commands)if(command.kind==='build_wall')expect(command.cells).not.toContainEqual(cell);
    expect(validFortifyScreen({...selected,cells:selected.cells.slice(1)})).toBe(false);expect(validFortifyScreen({...selected,signature:'0'.repeat(64)})).toBe(false);
  });
  it('keeps a four-meter street when extending walls beside an ordinary building',()=>{
    const {view,memory}=paidFixture(),house:ViewEntity={id:'street_neighbor',kind:'building',typeId:'house',ownerId:'a',xMm:100000,zMm:76000,hp:600,maxHp:600,progress:1};view.entities.push(house);
    expect(fortifyCommands(view,goal,memory).status).toBe('building');
    house.zMm++;expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'RING_OCCUPIED',commands:[]});
    house.zMm--;expect(fortifyCommands(view,goal,memory).status).toBe('building');
  });
  it('blocks a committed wall layout at an observed forest edge until that cell is depleted',()=>{
    const {view,memory}=paidFixture();
    const tree:ViewEntity={id:'forest_at_wall',kind:'resource',typeId:'tree_oak',ownerId:null,xMm:90000,zMm:80750,hp:1,maxHp:1,resource:'wood',amount:100,forest:{patchId:'known_patch',cellMm:balance.maps.forestNavigationCellM*1000}};
    view.entities.push(tree);
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'RING_OCCUPIED',commands:[]});
    tree.amount=0;expect(fortifyCommands(view,goal,memory).status).toBe('building');
  });
  it.each([false,true])('preserves gate access in both orientations at the full wall cap for routine buildings (paid=%s)',paid=>{
    const cells:Cell[]=[];for(let along=0;along<40;along++)cells.push({x:30+along,z:30});for(let along=0;along<40;along++)cells.push({x:70,z:30+along});for(let along=0;along<40;along++)cells.push({x:70-along,z:70});for(let along=0;along<40;along++)cells.push({x:30,z:70-along});
    const gates=[{originCell:{x:49,z:30},rotation:0 as const},{originCell:{x:70,z:49},rotation:90 as const},{originCell:{x:49,z:70},rotation:0 as const},{originCell:{x:30,z:49},rotation:90 as const}],layout={cells,gates,origin:{xMm:100000,zMm:100000},signature:fortifyLayoutSignature(cells,gates)};
    expect(validFortifyLayout(layout)).toBe(true);expect(cells).toHaveLength(fortifyPlanCellLimit);const before=structuredClone(layout),preference=fortifyPlacementCells(layout);expect(preference).toHaveLength(fortifyPlanCellLimit+4*3*4);expect(preference.length).toBeLessThanOrEqual(fortifyPlacementCellLimit);expect(preference.slice(0,cells.length)).toEqual(cells);
    for(const gate of [gates[1]!,gates[2]!]){
      const view=fixture();view.self.age=2;const vertical=gate.rotation===90,center={xMm:(gate.originCell.x+(vertical?.5:1.5))*2000,zMm:(gate.originCell.z+(vertical?1.5:.5))*2000},anchor={xMm:(gate.originCell.x+(vertical?1:0))*2000,zMm:(gate.originCell.z+(vertical?0:1))*2000};
      const observedGate:ViewEntity={id:'owned_gate',kind:'building',ownerId:'a',typeId:'wooden_gate',...center,rotation:gate.rotation,hp:600,maxHp:600,progress:1,gateMode:'AUTO',gateOpen:false};if(paid)view.entities.push(observedGate);
      const worker=view.entities[1]!,ordinary=buildingCommand(view,'market',anchor,[worker],0,cells),preferred=buildingCommand(view,'market',anchor,[worker],0,preference);expect(ordinary?.kind).toBe('build');expect(preferred?.kind).toBe('build');if(ordinary?.kind!=='build'||preferred?.kind!=='build')throw new Error('MISSING_ROUTINE_SITE');
      const start={xMm:center.xMm-(vertical?1850:0),zMm:center.zMm-(vertical?0:1850)},end={xMm:center.xMm+(vertical?1850:0),zMm:center.zMm+(vertical?0:1850)};
      const gateBoxes=fortificationObstacles({...observedGate,typeId:'wooden_gate',ownerId:'a',rotation:gate.rotation,work:1,required:1},'a',(a,b)=>a!==b);
      const passage=(command:typeof preferred)=>new Navigation(view.map.widthMm,view.map.heightMm,[...gateBoxes,{id:'market',xMm:(command.originCell.x+2)*2000,zMm:(command.originCell.z+2)*2000,halfWidth:4000,halfHeight:4000}]).clearLine(start,end,350);
      expect(passage(ordinary)).toBe(true);expect(passage(preferred)).toBe(true);
      // Make the two ordinary farm options explicit. The first uses the same
      // outward landing; the second is legal but farther from the home anchor.
      const near={x:anchor.xMm/2000,z:anchor.zMm/2000},far={x:near.x+(vertical?4:0),z:near.z+(vertical?0:4)},home=view.entities[0]!;home.xMm=(near.x-20)*2000;home.zMm=(near.z-20)*2000;view.entities.push({...home,id:'barracks',typeId:'barracks',xMm:20000,zMm:20000});
      const halo=Math.ceil(balance.rules.treeBuildingClearanceM/balance.rules.buildingGridM),width=3+halo*2;view.fog.visible=[near,far].flatMap(site=>Array.from({length:width*width},(_,index)=>(site.z-halo+Math.floor(index/width))*100+site.x-halo+index%width));view.fog.explored=[...view.fog.visible];view.self.populationCap=120;view.self.resources.wood=buildings.farm.cost.wood;
      const farm=(avoidBuildingCells:Cell[])=>fallbackCommands(view,{sequence:0,scoutIndex:0,buildAttempt:0},{scoutAllowed:false,avoidBuildingCells}).find(command=>command.kind==='build'&&command.buildingType==='farm');
      expect(farm(cells)).toMatchObject({originCell:{x:near.x+(vertical?2:0),z:near.z+(vertical?0:2)}});expect(farm(preference)).toMatchObject({originCell:far});
    }
    expect(layout).toEqual(before);
  });
  it('selects the largest ordered wall prefix with ordinary work faces before adjacent proposals box a site',()=>{
    const {view,memory,run}=sandwichedWallFixture(),before=structuredClone(view),budget={remaining:100000,used:0};
    const result=fortifyCommands(view,goal,memory,budget);expect(result).toMatchObject({status:'building',commands:[{kind:'build_wall',cells:run.slice(0,7)}]});
    expect(budget.used).toBeGreaterThan(0);expect(budget.used).toBeLessThanOrEqual(100000);expect(view).toEqual(before);expect(memory.routesValid).toBe(true);expect(memory.routeFailure).toBeUndefined();expect(memory.pendingUntilTick).toBeUndefined();
    // Only endpoint occupancy changes; the static resource proof remains valid.
    view.entities.push({...view.entities[1]!,id:'work_face_a',xMm:96850,zMm:82000},{...view.entities[1]!,id:'work_face_b',xMm:96850,zMm:83000});
    const occupied=fortifyCommands(view,goal,memory);expect(occupied.commands[0]).toMatchObject({kind:'build_wall',cells:run.slice(0,6)});expect(memory.routesValid).toBe(true);
  });
  it('retains existing paid neighbors when a singleton has no remaining work face',()=>{
    const {view,memory,run}=sandwichedWallFixture();for(const [index,cell]of run.entries())if(index!==6)view.entities.push({id:`existing_wall_${index}`,kind:'building',typeId:'palisade_wall',ownerId:'a',xMm:(cell.x+.5)*2000,zMm:(cell.z+.5)*2000,hp:450,maxHp:450,progress:1});
    expect(fortifyCommands(view,goal,memory)).toEqual({status:'waiting',commands:[],reason:'BUILD_ACCESS_BLOCKED'});expect(memory.routesValid).toBe(true);expect(memory.routeFailure).toBeUndefined();expect(memory.pendingUntilTick).toBeUndefined();
  });
  it('uses only observed openings for allied gates with a private unknown mode',()=>{
    const {view,memory,run}=sandwichedWallFixture();view.players.push({id:'ally',name:'Ally',teamId:'a',kind:'human',color:'#55dd88'});
    view.entities=view.entities.filter(entity=>!entity.id.startsWith('north_'));const gate:ViewEntity={id:'north_gate',kind:'building',typeId:'wooden_gate',ownerId:'ally',xMm:95000,zMm:81000,rotation:0,gateOpen:false,hp:600,maxHp:600,progress:1};view.entities.push(gate);
    expect(gate.gateMode).toBeUndefined();expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build_wall',cells:run.slice(0,7)});
    gate.gateOpen=true;expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build_wall',cells:run});
    gate.ownerId='a';gate.gateMode='AUTO';gate.gateOpen=false;expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build_wall',cells:run});
    gate.gateMode='LOCKED';expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build_wall',cells:run.slice(0,7)});
  });
  it('returns only an already validated shorter prefix when the shared access budget expires',()=>{
    const {view,memory,run}=sandwichedWallFixture();fortifyCommands(view,goal,memory);
    const measured={remaining:100000,used:0};expect(fortifyCommands(view,goal,memory,measured).commands[0]).toMatchObject({cells:run.slice(0,7)});
    const before=structuredClone(memory),partial={remaining:measured.used-1,used:0};expect(fortifyCommands(view,goal,memory,partial).commands[0]).toMatchObject({cells:run.slice(0,6)});expect(partial).toEqual({remaining:0,used:measured.used-1});expect(memory).toEqual(before);
    const empty={remaining:0,used:0};expect(fortifyCommands(view,goal,memory,empty)).toEqual({status:'waiting',commands:[],reason:'VALIDATING_BUILD_ACCESS'});expect(empty.used).toBe(0);expect(memory).toEqual(before);
  });
  it('issues affordable ordinary commands once while waiting for their observed result',()=>{
    const view=fixture(),memory:FortifyMemory={};const first=fortifyCommands(view,goal,memory);
    expect(first.status).toBe('building');expect(first.commands).toHaveLength(1);expect(first.commands[0]?.kind).toBe('build');
    expect(memory.pendingUntilTick).toBeUndefined();expect(memory.lastSignature).toBeUndefined();expect(fortifyCommands(view,goal,memory)).toEqual(first);
    markFortifyQueued(memory,first.commands[0]!,view.tick);
    expect(fortifyCommands(view,goal,memory)).toEqual({status:'waiting',commands:[]});
    expect(view.self.resources.wood).toBe(250);expect(view.entities).toHaveLength(2);
  });
  it('reports visibility, age and wall-cap obstacles without issuing a placement loop',()=>{
    const view=fixture();view.fog.visible=[];view.fog.explored=[];expect(fortifyCommands(view,goal,{})).toMatchObject({status:'blocked',reason:'RING_NOT_EXPLORED',commands:[]});
    view.fog.explored=fixture().fog.explored;view.fog.visible=view.fog.explored;expect(fortifyCommands(view,{...goal,material:'stone'},{})).toMatchObject({status:'blocked',reason:'AGE_REQUIRED'});
    expect(fortifyCommands(view,{...goal,radiusM:60},{})).toMatchObject({status:'blocked',reason:'GEOMETRY_WORK_LIMIT'});
  });
  it('keeps known resource access and selects a nearby contour around an occupied square',()=>{
    const view=fixture();view.entities.push({id:'ore',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:130000,zMm:100000,hp:1,maxHp:1,resource:'gold',amount:1500});
    expect(fortifyCommands(view,goal,{}).status).toBe('building');
    view.entities[2]!.xMm=119000;view.entities[2]!.zMm=101000;const memory:FortifyMemory={};expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(validFortifyLayout(memory.layout!)).toBe(true);expect(memory.layout!.cells).not.toContainEqual({x:59,z:50});
  });
  it('charges contour graph visits to the same bounded invocation budget before route proof',()=>{
    const view=fixture(),memory:FortifyMemory={};view.entities.push({id:'square_blocker',kind:'building',typeId:'house',ownerId:'a',xMm:124000,zMm:101000,hp:600,maxHp:600,progress:1});
    const partial={remaining:10,used:0};expect(fortifyCommands(view,goal,memory,partial)).toMatchObject({status:'waiting',reason:'VALIDATING_FORTIFICATION_LAYOUT',commands:[]});expect(partial).toEqual({remaining:0,used:10});expect(memory.layout).toBeUndefined();
    const fresh={remaining:100000,used:0};expect(fortifyCommands(view,goal,memory,fresh).status).toBe('building');expect(fresh.used).toBeGreaterThan(10);expect(fresh.used).toBeLessThanOrEqual(100000);expect(fresh.remaining+fresh.used).toBe(100000);expect(memory.routesValid).toBe(true);
  });
  it('continues an interrupted gate foundation instead of paying for another',()=>{
    const view=fixture(),memory:FortifyMemory={},first=fortifyCommands(view,goal,memory).commands[0]!;
    if(first.kind!=='build')throw new Error('MISSING_GATE');
    view.tick=41;view.entities.push({id:'gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:(first.originCell.x+1.5)*2000,zMm:(first.originCell.z+.5)*2000,rotation:first.rotation,hp:60,maxHp:buildings.wooden_gate.maxHp,progress:.25});
    expect(fortifyCommands(view,goal,memory).commands).toEqual([{kind:'continue_build',builderIds:['worker'],foundationId:'gate',queued:false}]);
    view.entities[1]!.order='build';view.entities[1]!.taskState='blocked';view.entities.push({...view.entities[1]!,id:'free_helper',xMm:102000,order:'idle',taskState:'idle'});
    expect(fortifyCommands(view,goal,memory).commands).toEqual([{kind:'continue_build',builderIds:['free_helper'],foundationId:'gate',queued:false}]);expect(view.entities[1]!.order).toBe('build');
    view.entities[1]!.taskState='building';view.entities[1]!.workTargetId='unrelated_house';expect(fortifyCommands(view,goal,memory).commands).toEqual([{kind:'continue_build',builderIds:['free_helper'],foundationId:'gate',queued:false}]);
    view.entities.at(-1)!.queuedOrderCount=1;expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'waiting',reason:'BUILDERS_BUSY',commands:[]});
  });
  it('bounds resource-route validation by charged work across updates',()=>{
    const view=fixture(),memory:FortifyMemory={};for(let index=0;index<6;index++)view.entities.push({id:`tree_${index}`,kind:'resource',typeId:'tree',ownerId:null,xMm:130000+index*2000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:100});
    const measured={remaining:100000,used:0};expect(fortifyCommands(view,goal,{},measured).status).toBe('building');
    const allowance=Math.max(1,Math.floor(measured.used/2)),partial={remaining:allowance,used:0};
    expect(fortifyCommands(view,goal,memory,partial)).toMatchObject({status:'waiting',reason:'VALIDATING_RESOURCE_ROUTES',commands:[]});expect(partial).toEqual({remaining:0,used:allowance});
    expect(memory.routesValid).toBe(false);expect(memory.validatedResources).toBeLessThan(6);
    const continuation={remaining:100000,used:0};expect(fortifyCommands(view,goal,memory,continuation).status).toBe('building');expect(memory.routesValid).toBe(true);expect(continuation.used).toBeLessThanOrEqual(100000);
  });
  it('preserves accessible outer trees without rejecting an already inaccessible interior forest node',()=>{
    const view=fixture(),memory:FortifyMemory={};
    for(const [index,[xMm,zMm]]of [[134000,100000],[132650,100000],[135350,100000],[134000,98650],[134000,101350]].entries())view.entities.push({id:`dense_tree_${index}`,kind:'resource',typeId:'tree',ownerId:null,xMm:xMm!,zMm:zMm!,hp:1,maxHp:1,resource:'wood',amount:150});
    const before=structuredClone(view),firstBudget={remaining:100000,used:0};
    const result=fortifyCommands(view,goal,memory,firstBudget);expect(result.status).toBe('building');expect(result.commands[0]?.kind).toBe('build');
    expect(memory.validatedResources).toBe(5);expect(firstBudget.used).toBeGreaterThan(0);expect(firstBudget.used).toBeLessThanOrEqual(100000);expect(memory.routesValid).toBe(true);expect(view).toEqual(before);
  });
  it('gets past buried forest records within the existing work allowance before ordinary depletion restarts proof',()=>{
    const view=fixture(),memory:FortifyMemory={},trees:ViewEntity[]=[];
    for(let z=0;z<16;z++)for(let x=0;x<16;x++)trees.push({id:`belt_${x}_${z}`,kind:'resource',typeId:'wood_oak',ownerId:null,xMm:130000+x*3000,zMm:76000+z*3000,hp:1,maxHp:1,resource:'wood',amount:250,forest:{patchId:'dense_belt',cellMm:3000}});
    // Map resource ordering need not put accessible edges before buried trees.
    const interior=(tree:ViewEntity)=>tree.xMm>130000&&tree.xMm<175000&&tree.zMm>76000&&tree.zMm<121000;
    trees.sort((a,b)=>Number(interior(b))-Number(interior(a)));view.entities.push(...trees);
    const budget={remaining:100000,used:0},result=fortifyCommands(view,goal,memory,budget);
    expect(result.status).not.toBe('blocked');expect(memory.validatedResources).toBeGreaterThanOrEqual(14*14);expect(budget.used).toBeLessThanOrEqual(100000);
    const oldKey=memory.geometryKey;trees.find(tree=>tree.xMm===130000&&tree.zMm===76000)!.amount=0;
    const changed={remaining:100000,used:0},after=fortifyCommands(view,goal,memory,changed);
    expect(after.status).not.toBe('blocked');expect(memory.geometryKey).not.toBe(oldKey);expect(memory.validatedResources).toBeGreaterThanOrEqual(14*14);expect(changed.used).toBeLessThanOrEqual(100000);
  });
  it('waits for an available work budget and memoizes a real full-budget route failure',()=>{
    const view=fixture(),memory:FortifyMemory={};view.entities.push({id:'ore',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:130000,zMm:100000,hp:1,maxHp:1,resource:'gold',amount:1500});
    const before=structuredClone(view),budget={remaining:0,used:0};
    expect(fortifyCommands(view,goal,memory,budget)).toEqual({status:'waiting',reason:'VALIDATING_RESOURCE_ROUTES',commands:[]});
    expect(view).toEqual(before);expect(budget.used).toBe(0);
    expect(resolveFortifyGeometry(view,goal,memory,{remaining:100000,used:0}).status).toBe('ready');
    const path=vi.spyOn(Navigation.prototype,'pathToAny').mockImplementation(()=>{throw new PathBudgetExceededError();});
    try{expect(fortifyCommands(view,goal,memory).reason).toBe('ANCHOR_APPROACH_LIMIT');const nextBudget={remaining:100000,used:0};expect(fortifyCommands(view,goal,memory,nextBudget).reason).toBe('ANCHOR_APPROACH_LIMIT');expect(nextBudget.used).toBe(0);expect(path).toHaveBeenCalledTimes(1);}finally{path.mockRestore();}
    view.entities.pop();expect(fortifyCommands(view,goal,memory).status).toBe('building');
  });
  it('selects an eligible builder without hiding reserved units and waits without a phantom dispatch when all are busy',()=>{
    const view=fixture(),memory:FortifyMemory={};view.entities.push({...view.entities[1]!,id:'available_worker',xMm:102000,zMm:112000});const before=structuredClone(view);
    expect(fortifyCommands(view,goal,memory,undefined,new Set(['available_worker'])).commands[0]).toMatchObject({builderIds:['available_worker']});
    const proof=structuredClone(memory);expect(fortifyCommands(view,goal,memory,undefined,new Set())).toEqual({status:'waiting',commands:[],reason:'BUILDERS_BUSY'});expect(memory).toEqual(proof);expect(memory.pendingUntilTick).toBeUndefined();expect(view).toEqual(before);
  });
  it('retains a fixed face proof when workers move and restarts when that face becomes obstructed',()=>{
    const view=fixture(),memory:FortifyMemory={};for(let index=0;index<6;index++)view.entities.push({id:`origin_tree_${index}`,kind:'resource',typeId:'tree',ownerId:null,xMm:130000+index*2000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:100});
    expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(memory.validatedResources).toBe(6);const originalKey=memory.geometryKey;
    expect(fortifyCommands(view,goal,memory).commands).toHaveLength(1);const retainedBudget={remaining:0,used:0};expect(fortifyCommands(view,goal,memory,retainedBudget).commands).toHaveLength(1);expect(memory.geometryKey).toBe(originalKey);expect(memory.pendingUntilTick).toBeUndefined();expect(retainedBudget.used).toBe(0);
    const origin=structuredClone(memory.layout!.origin);view.entities[1]!.xMm+=1000;expect(fortifyCommands(view,goal,memory).commands).toHaveLength(1);expect(memory.geometryKey).toBe(originalKey);expect(memory.layout!.origin).toEqual(origin);
    view.entities.push({id:'face_house',kind:'building',typeId:'house',ownerId:'a',...origin,hp:600,maxHp:600,progress:1});const path=vi.spyOn(Navigation.prototype,'pathToAny');
    try{expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(path).toHaveBeenCalled();}finally{path.mockRestore();}
    expect(memory.geometryKey).not.toBe(originalKey);expect(memory.layout!.origin).not.toEqual(origin);expect(memory.validatedResources).toBe(6);expect(memory.routesValid).toBe(true);expect(memory.lastSignature).toBeUndefined();
  });
  it('persists a successful baseline before an interrupted proposed phase without repeating it',()=>{
    const view=fixture(),memory:FortifyMemory={goalKey:'a:home:palisade:18'};view.entities.push({id:'remote_ore',kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:180000,zMm:140000,hp:1,maxHp:1,resource:'gold',amount:1000});
    const geometry=resolveFortifyGeometry(view,goal,memory,{remaining:100000,used:0});if(geometry.status!=='ready')throw new Error(geometry.reason);
    const ore=view.entities.at(-1)!,box=fortifyViewObstacle(ore),targets=[{xMm:ore.xMm-box.halfWidth-900,zMm:ore.zMm},{xMm:ore.xMm+box.halfWidth+900,zMm:ore.zMm},{xMm:ore.xMm,zMm:ore.zMm-box.halfHeight-900},{xMm:ore.xMm,zMm:ore.zMm+box.halfHeight+900}],baseline={remaining:100000,used:0};
    const known=new Navigation(view.map.widthMm,view.map.heightMm,geometry.knownObstacles,30000,1000,baseline),proposed=new Navigation(view.map.widthMm,view.map.heightMm,[...geometry.knownObstacles,...geometry.proposedObstacles],30000,1000,baseline);
    for(const face of geometry.anchorFaces){expect(known.pathToAny(geometry.layout.origin,[face],350)).not.toBeNull();expect(proposed.pathToAny(geometry.layout.origin,[face],350)).not.toBeNull();}
    expect(known.pathToAny(geometry.layout.origin,targets,350)).not.toBeNull();
    const budget={remaining:baseline.used,used:0};expect(fortifyCommands(view,goal,memory,budget)).toMatchObject({status:'waiting',reason:'VALIDATING_RESOURCE_ROUTES'});expect(memory).toMatchObject({validatedResources:0,proofPhase:'proposed',routesValid:false});expect(budget.used).toBe(baseline.used);
    const next={remaining:200000,used:0},path=vi.spyOn(Navigation.prototype,'pathToAny');try{expect(fortifyCommands(view,goal,memory,next).status).toBe('building');expect(path).toHaveBeenCalledTimes(1);expect(next.used).toBeLessThanOrEqual(100000);expect(memory.routesValid).toBe(true);expect(memory.proofPhase).toBeUndefined();}finally{path.mockRestore();}
  });
  it('blocks a split free anchor approach instead of skipping resources in its other component',()=>{
    const view=fixture(),memory:FortifyMemory={};view.map.terrain=[{id:'approach_north',kind:'cliff',xMm:88000,zMm:92000,widthMm:8000,depthMm:2000,elevationMm:2000},{id:'approach_south',kind:'cliff',xMm:88000,zMm:106000,widthMm:8000,depthMm:2000,elevationMm:2000},{id:'approach_west',kind:'cliff',xMm:88000,zMm:92000,widthMm:2000,depthMm:16000,elevationMm:2000}];view.entities.push({id:'east_food',kind:'resource',typeId:'forage_bush',ownerId:null,xMm:130000,zMm:100000,hp:1,maxHp:1,resource:'food',amount:100});
    expect(fortifyCommands(view,goal,memory)).toEqual({status:'blocked',commands:[],reason:'ANCHOR_APPROACH_UNPROVEN'});expect(memory.layout!.origin).toEqual({xMm:93100,zMm:100000});expect(memory.validatedResources).toBe(0);expect(memory.validatedFaces).toBe(1);expect(memory.pendingUntilTick).toBeUndefined();
  });
  it('retains paid contour geometry while units defer placement and foundations finish',()=>{
    const view=fixture(),memory:FortifyMemory={};view.entities.push({id:'square_blocker',kind:'building',typeId:'house',ownerId:'a',xMm:124000,zMm:101000,hp:600,maxHp:600,progress:1});
    const first=fortifyCommands(view,goal,memory).commands[0]!;if(first.kind!=='build')throw new Error('MISSING_GATE');const layout=structuredClone(memory.layout!),proof=memory.geometryKey;
    view.entities.push({id:'paid_gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:(first.originCell.x+(first.rotation===0?1.5:.5))*2000,zMm:(first.originCell.z+(first.rotation===90?1.5:.5))*2000,rotation:first.rotation,hp:100,maxHp:1000,progress:.3});view.entities[1]!.order='build';
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'waiting',reason:'BUILDERS_BUSY'});expect(memory.layoutCommitted).toBe(true);expect(memory.layout).toEqual(layout);
    view.entities[1]!.order='idle';expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'continue_build',foundationId:'paid_gate'});view.entities.at(-1)!.progress=1;
    for(const [index,gate]of layout.gates.entries())view.entities.push({...view.entities[1]!,id:`traffic_${index}`,xMm:(gate.originCell.x+(gate.rotation===0?1.5:.5))*2000,zMm:(gate.originCell.z+(gate.rotation===90?1.5:.5))*2000});
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'waiting',reason:'SITE_OCCUPIED'});expect(memory.layout).toEqual(layout);expect(memory.geometryKey).toBe(proof);
    view.entities=view.entities.filter(entity=>!entity.id.startsWith('traffic_'));expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build'});expect(memory.layout).toEqual(layout);
    view.entities.push({id:'new_blocker',kind:'building',typeId:'house',ownerId:'a',xMm:(layout.cells[8]!.x+.5)*2000,zMm:(layout.cells[8]!.z+.5)*2000,hp:600,maxHp:600,progress:1});expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'RING_OCCUPIED'});expect(memory.layout).toEqual(layout);const failure=structuredClone(memory.blockedGeometry);expect(fortifyCommands(view,goal,memory).commands).toEqual([]);expect(memory.blockedGeometry).toEqual(failure);
  });
  it('retains paid partial-sight proof and purchases the first explored gate',()=>{
    const {view,memory,cells,fog}=paidFixture(),layout=structuredClone(memory.layout!),proof=memory.geometryKey,hidden=new Set([fog(layout.cells[0]!),fog(cells(layout.gates[1]!)[2]!)]);view.fog.visible=view.fog.visible.filter(id=>!hidden.has(id));const before=structuredClone(view),path=vi.spyOn(Navigation.prototype,'pathToAny');
    try{const result=fortifyCommands(view,goal,memory);expect(result.status).toBe('building');const command=result.commands[0]!;expect(command.kind).toBe('build');if(command.kind!=='build')throw new Error('MISSING_VISIBLE_GATE');expect({originCell:command.originCell,rotation:command.rotation}).toEqual(layout.gates[1]);expect(cells(command).every(cell=>view.fog.explored.includes(fog(cell)))).toBe(true);expect(path).not.toHaveBeenCalled();}finally{path.mockRestore();}
    expect(memory.layout).toEqual(layout);expect(memory.geometryKey).toBe(proof);expect(memory.routesValid).toBe(true);expect(memory.blockedGeometry).toBeUndefined();expect(view).toEqual(before);
  });
  it('keeps paid and unpaid discovered layouts usable after all current sight is lost',()=>{
    const {view,memory}=paidFixture(),layout=structuredClone(memory.layout!);view.fog.visible=[];
    expect(fortifyCommands(view,goal,memory).commands[0]).toMatchObject({kind:'build',buildingType:'wooden_gate'});expect(memory.layout).toEqual(layout);
    view.entities=view.entities.filter(entity=>entity.id!=='paid_gate');const unpaid=structuredClone(memory);delete unpaid.layoutCommitted;delete unpaid.layoutKey;
    expect(fortifyCommands(view,goal,unpaid).commands[0]).toMatchObject({kind:'build',buildingType:'wooden_gate'});
    view.fog.explored=[];expect(fortifyCommands(view,goal,unpaid)).toMatchObject({status:'blocked',commands:[],reason:'RING_NOT_EXPLORED'});
  });
  it('does not bypass a visible blocked or unaffordable gate through partial-sight wall fallback',()=>{
    const {view,memory,cells,fog}=paidFixture(),layout=memory.layout!,remaining=layout.gates.slice(1),hidden=new Set(remaining.slice(1).flatMap(cells).map(fog));view.fog.visible=view.fog.visible.filter(id=>!hidden.has(id));const gate=remaining[0]!;
    for(const [index,site]of remaining.entries())view.entities.push({...view.entities[1]!,id:'gate_traffic_'+index,xMm:(site.originCell.x+(site.rotation===0?1.5:.5))*2000,zMm:(site.originCell.z+(site.rotation===90?1.5:.5))*2000});
    expect(fortifyCommands(view,goal,memory)).toEqual({status:'waiting',commands:[],reason:'SITE_OCCUPIED'});
    view.entities=view.entities.filter(entity=>!entity.id.startsWith('gate_traffic'));view.self.resources.wood=buildings.palisade_wall.cost.wood;expect(fortifyCommands(view,goal,memory)).toEqual({status:'waiting',commands:[],reason:'INSUFFICIENT_RESOURCES'});
  });
  it('requires every paid contour cell to be explored even with unchanged current sight',()=>{
    const {view,memory,fog}=paidFixture(),missing=fog(memory.layout!.cells[0]!);view.fog.visible=view.fog.visible.filter(id=>id!==missing);view.fog.explored=view.fog.explored.filter(id=>id!==missing);
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',commands:[],reason:'RING_NOT_EXPLORED'});
    view.fog.explored.push(missing);expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(memory.blockedGeometry).toBeUndefined();
  });
  it('invalidates a paid layout clearance failure when its missing halo is explored',()=>{
    const {view,memory,fog}=paidFixture(),wall=memory.layout!.cells[0]!,missing=fog({x:wall.x-2,z:wall.z});
    view.fog.visible=view.fog.visible.filter(id=>id!==missing);view.fog.explored=view.fog.explored.filter(id=>id!==missing);
    expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',commands:[],reason:'RING_NOT_EXPLORED'});
    view.fog.explored.push(missing);expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(memory.blockedGeometry).toBeUndefined();
  });
  it('reproves changed known resources and respects remembered or revealed obstructions under partial sight',()=>{
    const {view,memory,fog}=paidFixture(),layout=structuredClone(memory.layout!),originalKey=memory.geometryKey,hidden=layout.cells[0]!;view.fog.visible=view.fog.visible.filter(id=>id!==fog(hidden));
    for(let index=0;index<6;index++)view.entities.push({id:`known_resource_${index}`,kind:'resource',typeId:'wood_oak',ownerId:null,xMm:130000+index*2000,zMm:100000,hp:1,maxHp:1,resource:'wood',amount:100,ghost:true});
    const path=vi.spyOn(Navigation.prototype,'pathToAny');try{expect(fortifyCommands(view,goal,memory).status).toBe('building');expect(path).toHaveBeenCalled();}finally{path.mockRestore();}
    expect(memory.geometryKey).not.toBe(originalKey);expect(memory.validatedResources).toBe(6);expect(memory.routesValid).toBe(true);
    view.entities.push({id:'known_obstruction',kind:'building',typeId:'house',ownerId:'b',xMm:(hidden.x+.5)*2000,zMm:(hidden.z+.5)*2000,hp:600,maxHp:600,ghost:true});expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'RING_OCCUPIED',commands:[]});
    view.entities.at(-1)!.ghost=false;view.fog.visible.push(fog(hidden));expect(fortifyCommands(view,goal,memory)).toMatchObject({status:'blocked',reason:'RING_OCCUPIED',commands:[]});expect(memory.layout).toEqual(layout);
  });
});
