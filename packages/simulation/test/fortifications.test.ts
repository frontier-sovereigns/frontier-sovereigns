import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, units, validateContent, type BuildingId, type GameplayCommand, type Position } from '@frontier/shared';
import { Navigation, PathBudgetExceededError } from '../src/navigation.js';
import { advanceGates, fortificationBounds, fortificationObstacles, planFortification, validWallPath, type FortificationContext } from '../src/fortifications.js';
import type { Building, Entity, SimulationState, Unit } from '../src/state.js';
import { createSimulation, Simulation } from '../src/index.js';
import { UnitSpatialIndex } from '../src/movement.js';

function building(id:string,typeId:BuildingId,xMm:number,zMm:number,ownerId='a'):Building{
  const def=buildings[typeId];return {id,typeId,xMm,zMm,ownerId,kind:'building',rotation:0,hp:def.maxHp,maxHp:def.maxHp,work:1,required:1,grantedHp:def.maxHp,queue:[],cooldown:0};
}
function unit(id:string,xMm:number,zMm:number,ownerId='a'):Unit{return {id,typeId:'villager',kind:'unit',ownerId,xMm,zMm,hp:units.villager.maxHp,maxHp:units.villager.maxHp,orders:[],path:[],pathRevision:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'defensive',repathAtTick:0};}
function fixture(){
  // Isolated physical/admission fixture: no production, controllers or debug command API.
  const worker=unit('worker',42000,42000);
  const state={tick:0,widthMm:100000,heightMm:100000,entities:{worker},economies:{a:{age:3,defeated:false,resources:{food:1000000,wood:1000000,gold:1000000,stone:1000000}},b:{age:3,defeated:false}},map:{terrain:[]}} as unknown as SimulationState;
  const hostile=(a:string,b:string|null)=>a!==b;
  const ctx:FortificationContext={state,visible:()=>true,bounds:e=>e.kind==='building'?fortificationBounds(e):{halfWidth:400,halfHeight:400},obstacles:[],canApproach:(u,b,nav)=>{
    const bounds=fortificationBounds(b),margin=units[u.typeId].collisionRadiusM*1000+500;
    const points=[{xMm:b.xMm-bounds.halfWidth-margin,zMm:b.zMm},{xMm:b.xMm+bounds.halfWidth+margin,zMm:b.zMm},{xMm:b.xMm,zMm:b.zMm-bounds.halfHeight-margin},{xMm:b.xMm,zMm:b.zMm+bounds.halfHeight+margin}];
    for(const point of points){const path=nav.path(u,point,units[u.typeId].collisionRadiusM*1000);if(path)return path;}return null;
  }};
  return {state,ctx,worker,hostile};
}
const walls:Extract<GameplayCommand,{kind:'build_wall'}>={kind:'build_wall',builderIds:['worker'],material:'palisade',cells:[{x:25,z:25},{x:26,z:25},{x:27,z:25}],queued:false};

/** Pinned pre-index gate phase. Keep the independent ordered living-unit scans:
 * using the candidate's helper here would conceal broad-phase omissions. */
function scalarGates(state:SimulationState,hostile:(a:string,b:string|null)=>boolean,all:readonly Entity[]=Object.values(state.entities)){
  const living=all.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn),changed:{id:string;xMm:number;zMm:number;halfWidth:number;halfHeight:number}[]=[];
  for(const gate of all){
    if(gate.kind!=='building'||!buildings[gate.typeId].defaultGateMode)continue;
    const def=buildings[gate.typeId];let [width,height]=def.footprintCells;if(gate.rotation===90||gate.rotation===270)[width,height]=[height,width];
    const bounds={halfWidth:width*balance.rules.buildingGridM*500,halfHeight:height*balance.rules.buildingGridM*500},mode=gate.gateMode??def.defaultGateMode!;gate.gateMode=mode;
    const completed=gate.work>=gate.required,active=completed&&!state.economies[gate.ownerId]!.defeated;
    const nearby=active&&living.some(unit=>!hostile(gate.ownerId,unit.ownerId)&&!state.economies[unit.ownerId]!.defeated&&Math.hypot(Math.max(0,Math.abs(unit.xMm-gate.xMm)-bounds.halfWidth),Math.max(0,Math.abs(unit.zMm-gate.zMm)-bounds.halfHeight))<=def.autoOpenDistanceM!*1000+units[unit.typeId].collisionRadiusM*1000);
    if(nearby)gate.gateCloseAfterTick=state.tick+Math.ceil(def.autoCloseDelaySeconds!*balance.rules.simulationHz);
    let shouldOpen=Boolean(active&&(mode==='OPEN'||mode==='AUTO'&&(nearby||gate.gateOpen&&state.tick<(gate.gateCloseAfterTick??0))));
    const vertical=gate.rotation===90||gate.rotation===270,passageHalf=def.gatePassageWidthM!*500;
    if(gate.gateOpen&&!shouldOpen&&living.some(unit=>{const radius=units[unit.typeId].collisionRadiusM*1000;return Math.abs(unit.xMm-gate.xMm)<(vertical?bounds.halfWidth:passageHalf)+radius&&Math.abs(unit.zMm-gate.zMm)<(vertical?passageHalf:bounds.halfHeight)+radius;}))shouldOpen=true;
    if(Boolean(gate.gateOpen)!==shouldOpen){gate.gateOpen=shouldOpen;changed.push({id:gate.id,xMm:gate.xMm,zMm:gate.zMm,...bounds});}
  }
  return changed;
}

function gateIndex(state:SimulationState){
  const index=new UnitSpatialIndex();
  index.synchronize(Object.values(state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn).map(entity=>({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,radiusMm:units[entity.typeId].collisionRadiusM*1000})));
  return index;
}

describe('M3 atomic fortification admission',()=>{
  it('admits the 1600th reserved wall cell and rejects a 1601st cell atomically',()=>{
    const {state,ctx}=fixture();for(let i=0;i<1599;i++)state.entities[`cap_${i}`]=building(`cap_${i}`,'palisade_wall',1000+(i%40)*2000,1000+Math.floor(i/40)*2000);
    const command={...walls,cells:[{x:44,z:44}]},before=structuredClone(state),accepted=planFortification(ctx,'a',command);expect('error'in accepted).toBe(false);expect(state).toEqual(before);
    state.entities.cap_last=building('cap_last','palisade_wall',81000,81000);const atCap=structuredClone(state);expect(planFortification(ctx,'a',command)).toEqual({error:'WALL_LIMIT'});expect(state).toEqual(atCap);
  });
  it('permits one orthogonal bend and rejects diagonal, duplicates, multiple bends and oversized paths',()=>{
    expect(validWallPath([{x:1,z:1},{x:2,z:1},{x:2,z:2}])).toBe(true);
    expect(validWallPath([{x:1,z:1},{x:2,z:2}])).toBe(false);
    expect(validWallPath([{x:1,z:1},{x:1,z:1}])).toBe(false);
    expect(validWallPath([{x:1,z:1},{x:2,z:1},{x:2,z:2},{x:3,z:2}])).toBe(false);
    const {ctx}=fixture();let pathCalls=0;ctx.canApproach=()=>{pathCalls++;return [];};
    expect(planFortification(ctx,'a',{...walls,cells:Array.from({length:65},(_,x)=>({x,z:25}))})).toEqual({error:'INVALID_WALL_PATH'});expect(pathCalls).toBe(0);
  });
  it('checks the whole batch without mutating its world, even when only the last cell is occupied',()=>{
    const {state,ctx}=fixture();state.entities.enemy=unit('enemy',55000,51000,'b');const before=structuredClone(state);
    expect(planFortification(ctx,'a',walls)).toEqual({error:'PLACEMENT_BLOCKED'});expect(state).toEqual(before);
    delete state.entities.enemy;const plan=planFortification(ctx,'a',walls);expect('error'in plan).toBe(false);
    if('error'in plan)throw new Error(plan.error);expect(plan.create).toHaveLength(3);expect(plan.cost.wood).toBe(buildings.palisade_wall.cost.wood*3);expect(Object.values(state.entities)).toHaveLength(1);
  });
  it('uses the actual unit circle at footprint corners instead of a hidden bounding-box corner',()=>{
    const {state,ctx}=fixture(),enemy=unit('enemy',49700,49700,'b');state.entities.enemy=enemy;
    expect('error'in planFortification(ctx,'a',walls)).toBe(false);
    enemy.xMm=enemy.zMm=49800;expect(planFortification(ctx,'a',walls)).toEqual({error:'PLACEMENT_BLOCKED'});
  });
  it('shares one admission work budget across every site and remains atomic on exhaustion',()=>{
    const {state,ctx}=fixture(),before=structuredClone(state);ctx.workBudget={remaining:4,used:0};
    expect(()=>planFortification(ctx,'a',walls)).toThrow(PathBudgetExceededError);expect(ctx.workBudget).toEqual({remaining:0,used:4});expect(state).toEqual(before);
  });
  it('admits an affordable 64-cell batch within one faction allowance using real path checks',()=>{
    const {state,ctx}=fixture();state.widthMm=200000;state.heightMm=200000;ctx.workBudget={remaining:50000,used:0};
    const plan=planFortification(ctx,'a',{...walls,cells:Array.from({length:64},(_,index)=>({x:25+index,z:25}))});
    expect('error'in plan).toBe(false);if('error'in plan)throw new Error(plan.error);
    expect(plan.create).toHaveLength(64);expect(plan.cost.wood).toBe(buildings.palisade_wall.cost.wood*64);expect(plan.assignments[0]?.siteIndices).toHaveLength(64);
    expect(ctx.workBudget.used).toBeGreaterThan(0);expect(ctx.workBudget.used).toBeLessThan(50000);
    console.log(`M3 visible flat 64-cell wall admission: ${ctx.workBudget.used}/50000 spatial operations`);
  });
  it('reuses owned matching endpoint walls without charges and retains unfinished endpoint work',()=>{
    const {state,ctx}=fixture();state.entities.start=building('start','palisade_wall',51000,51000);state.entities.end=building('end','palisade_wall',55000,51000);(state.entities.end as Building).work=0;
    ctx.obstacles=Object.values(state.entities).filter((e):e is Building=>e.kind==='building').flatMap(e=>fortificationObstacles(e));
    const plan=planFortification(ctx,'a',walls);expect('error'in plan).toBe(false);if('error'in plan)throw new Error(plan.error);
    expect(plan.create).toHaveLength(1);expect(plan.cost.wood).toBe(buildings.palisade_wall.cost.wood);expect(plan.existingTargetIds).toEqual(['end']);
    state.entities.middle=building('middle','palisade_wall',53000,51000);expect(planFortification(ctx,'a',walls)).toEqual({error:'PLACEMENT_BLOCKED'});
  });
  it('rejects hidden footprints before inspecting their occupancy',()=>{
    const {state,ctx}=fixture();ctx.visible=(_id,p)=>p.xMm<55000;
    expect(planFortification(ctx,'a',walls)).toEqual({error:'PLACEMENT_UNAVAILABLE'});
    state.entities.hidden=building('hidden','house',57000,51000,'b');expect(planFortification(ctx,'a',walls)).toEqual({error:'PLACEMENT_UNAVAILABLE'});
  });
  it('enforces age, affordability and the wall-equivalent population-independent limit',()=>{
    const {state,ctx}=fixture();state.economies.a!.age=1;expect(planFortification(ctx,'a',{...walls,material:'stone'})).toEqual({error:'AGE_REQUIRED'});
    state.economies.a!.resources.wood=0;expect(planFortification(ctx,'a',walls)).toMatchObject({error:'INSUFFICIENT_RESOURCES',cost:{wood:buildings.palisade_wall.cost.wood*3}});
    state.economies.a!.resources.wood=1000000;for(let i=0;i<balance.rules.maxWallEquivalentCellsPerPlayer;i++)state.entities[`old_${i}`]=building(`old_${i}`,'palisade_wall',1000,1000);
    expect(planFortification(ctx,'a',walls)).toEqual({error:'WALL_LIMIT'});
  });
  it('rejects inaccessible proposed work positions with no partial debit or foundation',()=>{
    const {state,ctx}=fixture();ctx.canApproach=()=>null;const before=structuredClone(state);
    expect(planFortification(ctx,'a',walls)).toEqual({error:'NO_PATH'});expect(state).toEqual(before);
  });
  it('replaces exactly three completed matching straight walls at full gate cost',()=>{
    const {state,ctx}=fixture();for(let index=0;index<3;index++)state.entities[`wall_${index}`]=building(`wall_${index}`,'palisade_wall',51000+index*2000,51000);
    const command:Extract<GameplayCommand,{kind:'replace_wall_with_gate'}>={kind:'replace_wall_with_gate',builderIds:['worker'],wallIds:['wall_2','wall_0','wall_1'],queued:false};
    const plan=planFortification(ctx,'a',command);expect('error'in plan).toBe(false);if('error'in plan)throw new Error(plan.error);
    expect(plan.create).toEqual([{typeId:'wooden_gate',position:{xMm:53000,zMm:51000},rotation:0}]);expect(plan.cost).toEqual(buildings.wooden_gate.cost);expect(plan.removeIds).toEqual(command.wallIds);
    const wall=state.entities.wall_1 as Building;
    for(const invalid of [{ownerId:'b'},{typeId:'stone_wall' as const},{work:0},{zMm:53000}]){const saved=structuredClone(wall);Object.assign(wall,invalid);expect(planFortification(ctx,'a',command)).toEqual({error:'INVALID_GATE_REPLACEMENT'});Object.assign(wall,saved);}
  });
});

describe('M3 gates use physical clearance for every faction',()=>{
  it('rejects gate content with a missing passage or impossible endposts',()=>{
    for(const width of [undefined,0,6,8]){const data=structuredClone(balance),gate=data.buildings.find(entry=>entry.id==='wooden_gate')!;if(width===undefined)delete gate.gatePassageWidthM;else gate.gatePassageWidthM=width;expect(()=>validateContent(data)).toThrow();}
    const data=structuredClone(balance);delete data.buildings.find(entry=>entry.id==='stone_gate')!.defaultGateMode;expect(()=>validateContent(data)).toThrow('Invalid gate geometry');
  });
  it('opens AUTO for friendly traffic, never for enemy traffic alone',()=>{
    const {state,worker,hostile}=fixture(),gate=building('gate','wooden_gate',50000,50000);state.entities.gate=gate;worker.xMm=80000;worker.zMm=80000;
    state.entities.enemy=unit('enemy',50000,55000,'b');expect(advanceGates(state,hostile)).toEqual([]);expect(gate.gateOpen).toBeFalsy();
    worker.xMm=50000;worker.zMm=55000;expect(advanceGates(state,hostile)).toHaveLength(1);expect(gate.gateOpen).toBe(true);
    const open=new Navigation(100000,100000,fortificationObstacles(gate));expect(open.clearLine({xMm:50000,zMm:46000},{xMm:50000,zMm:54000},550)).toBe(true);
    expect(fortificationObstacles(gate,'b',hostile)).toEqual(fortificationObstacles(gate));
  });
  it('retains an occupied passage when locked and closes once an enemy leaves it',()=>{
    const {state,worker,hostile}=fixture(),gate=building('gate','wooden_gate',50000,50000);state.entities.gate=gate;gate.gateOpen=true;gate.gateMode='LOCKED';worker.xMm=80000;worker.zMm=80000;
    const enemy=unit('enemy',50000,50000,'b');state.entities.enemy=enemy;expect(advanceGates(state,hostile)).toHaveLength(0);expect(gate.gateOpen).toBe(true);
    enemy.zMm=55000;expect(advanceGates(state,hostile)).toHaveLength(1);expect(gate.gateOpen).toBe(false);
  });
  it('waits the data-defined two-second AUTO delay, while OPEN stays open without traffic',()=>{
    const {state,worker,hostile}=fixture(),gate=building('gate','wooden_gate',50000,50000);state.entities.gate=gate;worker.xMm=50000;worker.zMm=55000;
    advanceGates(state,hostile);worker.xMm=80000;worker.zMm=80000;state.tick=39;advanceGates(state,hostile);expect(gate.gateOpen).toBe(true);
    state.tick=40;advanceGates(state,hostile);expect(gate.gateOpen).toBe(false);gate.gateMode='OPEN';advanceGates(state,hostile);expect(gate.gateOpen).toBe(true);
  });
  it('keeps foundations solid and gives both orientations the same four-meter opening',()=>{
    for(const rotation of [0,90] as const){const gate=building('gate','stone_gate',50000,50000);gate.rotation=rotation;gate.gateOpen=true;
      const nav=new Navigation(100000,100000,fortificationObstacles(gate));expect(nav.free(gate,1900)).toBe(true);expect(nav.free(gate,2100)).toBe(false);
      gate.work=0;const foundation=new Navigation(100000,100000,fortificationObstacles(gate));expect(foundation.free(gate,350)).toBe(false);
    }
  });
  it('allows only friendly AUTO route planning to anticipate an opening',()=>{
    const {hostile}=fixture(),gate=building('gate','wooden_gate',50000,50000);
    expect(new Navigation(100000,100000,fortificationObstacles(gate,'a',hostile)).free(gate,550)).toBe(true);
    expect(new Navigation(100000,100000,fortificationObstacles(gate,'b',hostile)).free(gate,550)).toBe(false);
    expect(new Navigation(100000,100000,fortificationObstacles(gate)).free(gate,550)).toBe(false);
    gate.gateMode='LOCKED';expect(new Navigation(100000,100000,fortificationObstacles(gate,'a',hostile)).free(gate,550)).toBe(false);
  });
  it('cannot be opened by a garrisoned unit or a defeated owner',()=>{
    const {state,worker,hostile}=fixture(),gate=building('gate','wooden_gate',50000,50000);state.entities.gate=gate;worker.xMm=50000;worker.zMm=55000;worker.garrisonedIn='town';advanceGates(state,hostile);expect(gate.gateOpen).toBeFalsy();
    delete worker.garrisonedIn;state.economies.a!.defeated=true;gate.gateMode='OPEN';advanceGates(state,hostile);expect(gate.gateOpen).toBeFalsy();
  });
});

describe('gate queries through the phase-owned unit index',()=>{
  it('uses an ordered gate-only roster without touching resources and preserves the full-world body fallback',()=>{
    for(const indexed of [false,true]){
      const {state,worker,hostile}=fixture(),gate=building('role_gate','wooden_gate',50000,50000);state.entities[gate.id]=gate;worker.xMm=50000;worker.zMm=55000;
      const node:Entity={id:'gate_role_resource',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:2000,zMm:2000,hp:1,maxHp:1,amount:250000};state.entities[node.id]=node;
      const expected=structuredClone(state),all=Object.values(state.entities),index=indexed?gateIndex(state):undefined;let kindReads=0;Object.defineProperty(node,'kind',{enumerable:true,configurable:true,get:()=>{kindReads++;return 'resource';}});
      expect(advanceGates(state,hostile,all,index,[gate])).toEqual(scalarGates(expected,hostile));expect(gate).toEqual(expected.entities[gate.id]);expect(gate.gateOpen).toBe(true);expect(indexed?kindReads===0:kindReads>0).toBe(true);
      gate.gateMode='LOCKED';(expected.entities[gate.id] as Building).gateMode='LOCKED';worker.zMm=50000;(expected.entities.worker as Unit).zMm=50000;
      expect(advanceGates(state,hostile,all,indexed?gateIndex(state):undefined,[gate])).toEqual(scalarGates(expected,hostile));expect(gate).toEqual(expected.entities[gate.id]);expect(gate.gateOpen).toBe(true);
      worker.zMm=80000;(expected.entities.worker as Unit).zMm=80000;
      expect(advanceGates(state,hostile,all,indexed?gateIndex(state):undefined,[gate])).toEqual(scalarGates(expected,hostile));expect(gate).toEqual(expected.entities[gate.id]);expect(gate.gateOpen).toBe(false);
    }
  });
  function compare(state:SimulationState){
    const expected=structuredClone(state),hostile=(a:string,b:string|null)=>a!==b;
    const actual=advanceGates(state,hostile,Object.values(state.entities),gateIndex(state));
    expect(actual).toEqual(scalarGates(expected,hostile));expect(state).toEqual(expected);return actual;
  }

  it('matches scalar rounded opening and strict anti-crush boundaries at every orientation',()=>{
    for(const gateType of ['wooden_gate','stone_gate'] as const)for(const rotation of [0,90,180,270] as const)for(const unitType of ['villager','scout','battering_ram','trebuchet'] as const)for(const offset of [-.000001,0,.000001]){
      const {state,worker}=fixture(),gate=building('gate',gateType,50000,50000);gate.rotation=rotation;state.entities.gate=gate;worker.typeId=unitType;
      const def=buildings[gateType],bounds=fortificationBounds(gate),radius=units[unitType].collisionRadiusM*1000,reach=def.autoOpenDistanceM!*1000+radius;
      // At a rounded corner the square bounding box alone is insufficient.
      worker.xMm=gate.xMm+bounds.halfWidth+reach/Math.SQRT2+offset;worker.zMm=gate.zMm+bounds.halfHeight+reach/Math.SQRT2+offset;
      compare(state);if(offset<0)expect(gate.gateOpen).toBe(true);if(offset>0)expect(Boolean(gate.gateOpen)).toBe(false);
      // Anti-crush is deliberately rectangular and uses strict inequalities;
      // it retains even a defeated enemy at the far corner of the passage.
      gate.gateMode='LOCKED';gate.gateOpen=true;worker.ownerId='b';state.economies.b!.defeated=true;
      const vertical=rotation===90||rotation===270,halfPassage=def.gatePassageWidthM!*500;
      worker.xMm=gate.xMm+(vertical?bounds.halfWidth:halfPassage)+radius+offset;
      worker.zMm=gate.zMm+(vertical?halfPassage:bounds.halfHeight)+radius+offset;
      compare(state);expect(gate.gateOpen).toBe(offset<0);
    }
  });

  it('retains timer writes, eligibility and changed-region order independently of spatial query order',()=>{
    for(const mode of ['AUTO','OPEN','LOCKED'] as const)for(const eligibility of ['living','dead','garrisoned','defeated','enemy'] as const)for(const complete of [false,true]){
      const {state,worker}=fixture(),first=building('z_gate','wooden_gate',50000,50000),second=building('a_gate','stone_gate',50000,60000);
      state.entities={z_gate:first,worker,a_gate:second};first.gateMode=second.gateMode=mode;first.gateOpen=second.gateOpen=true;first.work=second.work=complete?1:0;
      Object.assign(worker,{xMm:50000,zMm:55000});if(eligibility==='dead')worker.hp=0;if(eligibility==='garrisoned')worker.garrisonedIn='fixture_home';if(eligibility==='defeated')state.economies.a!.defeated=true;if(eligibility==='enemy')worker.ownerId='b';
      state.tick=7;compare(state);
      if(complete&&eligibility==='living')expect(first.gateCloseAfterTick).toBe(7+Math.ceil(buildings.wooden_gate.autoCloseDelaySeconds!*balance.rules.simulationHz));
      worker.xMm=worker.zMm=90000;
      for(const tick of [46,47,48]){state.tick=tick;const changed=compare(state);expect(changed.map(row=>row.id)).toEqual(['z_gate','a_gate'].filter(id=>changed.some(row=>row.id===id)));}
    }
  });

  it('falls back to scalar outcomes for nonfinite gate geometry without entering an index query',()=>{
    for(const value of [NaN,Infinity,-Infinity]){
      const {state}=fixture(),gate=building('gate','wooden_gate',value,50000);gate.gateOpen=true;gate.gateMode='LOCKED';state.entities.gate=gate;
      const expected=structuredClone(state),index=gateIndex(state),query=vi.spyOn(index,'withNearby');
      try{expect(advanceGates(state,(a,b)=>a!==b,Object.values(state.entities),index)).toEqual(scalarGates(expected,(a,b)=>a!==b));expect(state).toEqual(expected);expect(query).not.toHaveBeenCalled();}
      finally{query.mockRestore();}
    }
  });

  function simulation(thirdFaction=false){
    const sim=createSimulation({factions:[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'},...(thirdFaction?[{id:'c',name:'C',teamId:'c',color:'#88ff44',kind:'human' as const}]:[])],seed:'indexed-gates',matchId:'indexed-gates',controllers:false,sharedVision:false});
    const worker=unit('worker',50000,55000),gate=building('gate','wooden_gate',50000,50000);worker.stance='stand_ground';worker.autoGather=false;
    sim.state.entities={home_a:building('home_a','town_center',15000,15000),home_b:building('home_b','town_center',85000,85000,'b'),gate,worker};
    if(thirdFaction)sim.state.entities.home_c=building('home_c','town_center',85000,15000,'c');
    sim.state.widthMm=100000;sim.state.heightMm=100000;sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
    sim.drainJournal();return sim;
  }
  type GateInternals={advanceGates:typeof advanceGates;advanceTransitions(state:SimulationState,all?:readonly Entity[]):void;updateMovementUnit(unit:Unit):void;hostile(a:string,b:string|null):boolean;movementUnits:UnitSpatialIndex};
  const scalar=(sim:Simulation)=>{(sim as unknown as GateInternals).advanceGates=scalarGates;};
  const equal=(actual:Simulation,expected:Simulation,cold?:Simulation)=>{
    const recipients=expected.state.factions.map(faction=>faction.id),capture=JSON.stringify(expected.capture()),views=JSON.stringify(expected.views(recipients)),journal=expected.drainJournal();
    for(const sim of [actual,...(cold?[cold]:[])]){expect(JSON.stringify(sim.capture())).toBe(capture);expect(JSON.stringify(sim.views(recipients))).toBe(views);expect(sim.drainJournal()).toEqual(journal);}
  };

  it('matches full phase captures, journals and views through real passage and cold continuation',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(const sim of [actual,expected])expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:'gate_passage',clientSequence:1,command:{kind:'move',unitIds:['worker'],target:{xMm:50000,zMm:43000},queued:false}}).status).toBe('accepted');
    let cold:Simulation|undefined,sawOpen=false,sawClosed=false;
    for(let tick=0;tick<180;tick++){
      for(const sim of [actual,expected,...(cold?[cold]:[])]){
        const gate=sim.state.entities.gate as Building;
        if(tick===110){gate.gateMode='LOCKED';Object.assign(sim.state.entities.worker!,{xMm:80000,zMm:80000,orders:[],path:[]});}
        if(tick===145)gate.gateMode='OPEN';
        if(tick===160){gate.gateMode='AUTO';gate.gateCloseAfterTick=sim.state.tick;}
        sim.step();
      }
      sawOpen||=Boolean((actual.state.entities.gate as Building).gateOpen);if(tick>=110)sawClosed||=!(actual.state.entities.gate as Building).gateOpen;
      equal(actual,expected,cold);
      if(tick===85){expect(actual.state.entities.worker!.zMm).toBeLessThan(50000);cold=new Simulation(actual.options,actual.capture());}
    }
    expect(sawOpen).toBe(true);expect(sawClosed).toBe(true);
  },30000);

  it.each(['alias','duplicate-id','noncanonical-key','transition','hostile','unit-update'] as const)('preserves the independent scalar phase for %s compatibility',mode=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(const sim of [actual,expected]){
      const internal=sim as unknown as GateInternals,worker=sim.state.entities.worker as Unit;
      if(mode==='alias')sim.state.entities.alias=worker;
      if(mode==='duplicate-id')sim.state.entities.alias={...worker,xMm:90000,zMm:90000};
      if(mode==='noncanonical-key'){delete sim.state.entities.worker;sim.state.entities.alias=worker;}
      if(mode==='transition'){
        worker.xMm=worker.zMm=90000;const original=internal.advanceTransitions;
        internal.advanceTransitions=(state,all)=>{original(state,all);worker.xMm=50000;worker.zMm=55000;internal.advanceTransitions=original;};
      }
      if(mode==='hostile'){
        worker.xMm=worker.zMm=90000;const original=internal.hostile;
        internal.hostile=(a,b)=>{worker.xMm=50000;worker.zMm=55000;return original.call(internal,a,b);};
      }
      if(mode==='unit-update'){
        worker.xMm=worker.zMm=90000;const original=internal.updateMovementUnit;
        internal.updateMovementUnit=entity=>{original.call(internal,entity);if(entity===worker){worker.xMm=50000;worker.zMm=55000;}};
      }
    }
    const internal=actual as unknown as GateInternals,original=internal.advanceGates,passed:(UnitSpatialIndex|undefined)[]=[];
    const wrapper:typeof advanceGates=(state,hostile,all,index)=>{passed.push(index);return original(state,hostile,all,index);};internal.advanceGates=wrapper;
    const dispose=actual.registerGatePhaseDiagnostic('advanceGates',original,wrapper);expect(dispose).toBeTypeOf('function');
    try{actual.step();expected.step();equal(actual,expected);expect((actual.state.entities.gate as Building).gateOpen).toBe(true);expect(passed).toEqual([undefined]);}
    finally{dispose?.();internal.advanceGates=original;}
  });

  it('uses the reconciled index only while its original diagnostic registration is live',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    const internal=actual as unknown as GateInternals,original=internal.advanceGates,passed:(UnitSpatialIndex|undefined)[]=[];
    const wrapper:typeof advanceGates=(state,hostile,all,index)=>{passed.push(index);return original(state,hostile,all,index);};internal.advanceGates=wrapper;
    expect(actual.registerGatePhaseDiagnostic('advanceGates',scalarGates,wrapper)).toBeUndefined();
    const dispose=actual.registerGatePhaseDiagnostic('advanceGates',original,wrapper);expect(dispose).toBeTypeOf('function');
    try{
      actual.step();expected.step();equal(actual,expected);expect(passed[0]).toBe(internal.movementUnits);
      dispose!();actual.step();expected.step();equal(actual,expected);expect(passed[1]).toBeUndefined();
    }finally{dispose?.();internal.advanceGates=original;}
  });

  it('keeps malformed distant owner errors on the original scalar evaluation path',()=>{
    for(const malformed of ['faction','economy'] as const){
      const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
      for(const sim of [actual,expected]){
        const worker=sim.state.entities.worker as Unit;worker.xMm=worker.zMm=90000;
        if(malformed==='faction')worker.ownerId='missing';
        else{worker.ownerId='b';sim.state.factions[1]!.teamId='a';delete sim.state.economies.b;}
      }
      const failure=(sim:Simulation)=>{try{sim.step();return undefined;}catch(error){return {name:(error as Error).name,message:(error as Error).message};}};
      const reference=failure(expected);expect(reference?.name).toBe('TypeError');expect(failure(actual)).toEqual(reference);
      expect(JSON.stringify(actual.capture())).toBe(JSON.stringify(expected.capture()));
    }
  });

  it('reconciles same-tick team, garrison and owner changes before the next ordinary gate phase',()=>{
    const actual=simulation(true),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(const sim of [actual,expected]){(sim.state.entities.worker as Unit).ownerId='b';(sim.state.entities.gate as Building).gateMode='AUTO';}
    actual.step();expected.step();equal(actual,expected);expect(Boolean((actual.state.entities.gate as Building).gateOpen)).toBe(false);
    for(const sim of [actual,expected])sim.state.factions[1]!.teamId='a';
    actual.step();expected.step();equal(actual,expected);expect((actual.state.entities.gate as Building).gateOpen).toBe(true);
    for(const sim of [actual,expected]){(sim.state.entities.worker as Unit).garrisonedIn='home_b';const gate=sim.state.entities.gate as Building;gate.gateMode='LOCKED';}
    actual.step();expected.step();equal(actual,expected);expect((actual.state.entities.gate as Building).gateOpen).toBe(false);
    // Garrison advancement moved the worker to home_b. Place the released
    // fixture worker near the gate again before testing its changed owner.
    for(const sim of [actual,expected]){const worker=sim.state.entities.worker as Unit;delete worker.garrisonedIn;worker.xMm=50000;worker.zMm=55000;(sim.state.entities.gate as Building).ownerId='b';(sim.state.entities.gate as Building).gateMode='AUTO';}
    actual.step();expected.step();equal(actual,expected);expect((actual.state.entities.gate as Building).gateOpen).toBe(true);
  });

  it('rejects a prototype hostility hook even when it restores itself during evaluation',()=>{
    const actual=simulation(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(const sim of [actual,expected])Object.assign(sim.state.entities.worker!,{xMm:90000,zMm:90000});
    const prototype=Simulation.prototype as unknown as GateInternals,original=prototype.hostile;
    const install=()=>{prototype.hostile=function(this:GateInternals,a,b){const sim=this as unknown as Simulation;Object.assign(sim.state.entities.worker!,{xMm:50000,zMm:55000});prototype.hostile=original;return original.call(this,a,b);};};
    try{install();actual.step();install();expected.step();equal(actual,expected);expect((actual.state.entities.gate as Building).gateOpen).toBe(true);}
    finally{prototype.hostile=original;}
  });
});
