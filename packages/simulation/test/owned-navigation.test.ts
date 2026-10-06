import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, MAX_WORLD_ENTITIES, terrainObstacles, type GameplayCommand, type Position, type PublicPlayer, type TerrainRegion } from '@frontier/shared';
import { createSimulation, createLiveSimulation, Simulation, type Unit, type Entity, type Building, type ResourceNode } from '../src/index.js';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from '../src/navigation.js';
import { createOwnedNavigation, createOwnedNavigationRevision, withOwnedNavigationBudget } from '../src/owned-navigation.js';
import { formationTargets } from '../src/movement.js';

// The cache covers every admitted entity plus bounded terrain/memory overhead.
// Exercise overflow at the current capacity, not the pre-Ages-V-VIII ceiling.
const staticRecordLimit = MAX_WORLD_ENTITIES + 4096;

function evaluate(nav:Navigation,budget:NavigationWorkBudget,remaining:number,used:number,query:(navigation:Navigation)=>unknown){
  budget.remaining=remaining;budget.used=used;let answer:unknown,error:string|undefined;
  try{answer=query(nav);}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error=`${cause.name}:${cause.message}`;}
  return {answer,error,remaining:budget.remaining,used:budget.used};
}

function kernelPrototype():{freeUncached:Navigation['free'];clearLineUncached:Navigation['clearLine']} {
  return Object.getPrototypeOf(createOwnedNavigation(20000,20000,[]));
}

interface LegacyKnowledgeFrame {entities:Entity[];knownStatic:Map<string,Entity[]>;planning?:Map<string,Navigation>}
interface LegacyNavigationInternals {
  all():Entity[];visible(playerId:string,point:Position):boolean;
  nav():Navigation;planningNav(playerId:string):Navigation;admissionNav(playerId:string):Navigation;
  knownStatic(playerId:string):Entity[];entityObstacles(entity:Entity,playerId:string):Obstacle[];
  knownObstacles(playerId:string):Obstacle[];refreshPlanningNav(playerId:string):Navigation;
  movementFrame:LegacyKnowledgeFrame|undefined;workFrame:{knowledge?:LegacyKnowledgeFrame}|undefined;
  planningNavigations:Map<string,{navigation:Navigation;obstacles:Map<string,Obstacle>;revision:number}>;
  pathScheduler:{invalidate(profile:string,regions:{xMm:number;zMm:number;widthMm:number;depthMm:number}[]):void};
  lastPathWork:unknown;
}

/** Independent pre-retention oracle, pinned to the navigation-preparation baseline.
 * Scalar visibility deliberately bypasses the candidate's retained membership and
 * combined-roster caches. Geometry reconciliation/diff order is the old algorithm. */
function installLegacyNavigation(sim:Simulation,generic=false):LegacyNavigationInternals{
  const internal=sim as unknown as LegacyNavigationInternals;
  internal.knownStatic=playerId=>{
    let frame=internal.movementFrame;
    if(!frame&&internal.workFrame){internal.workFrame.knowledge??={entities:internal.all(),knownStatic:new Map()};frame=internal.workFrame.knowledge;}
    const cached=frame?.knownStatic.get(playerId);if(cached)return cached;
    const current=(frame?.entities??internal.all()).filter(entity=>entity.kind!=='unit'&&(entity.ownerId===playerId||internal.visible(playerId,entity))),ids=new Set(current.map(entity=>entity.id));
    for(const memory of Object.values(sim.state.vision[playerId]!.memory))if(!ids.has(memory.id)&&!internal.visible(playerId,memory))current.push(memory as Entity);
    frame?.knownStatic.set(playerId,current);return current;
  };
  internal.knownObstacles=playerId=>[...terrainObstacles(sim.state.map.terrain),...internal.knownStatic(playerId).flatMap(entity=>internal.entityObstacles(entity,playerId))];
  internal.refreshPlanningNav=playerId=>{
    const cached=internal.movementFrame?.planning?.get(playerId);if(cached)return cached;
    const known=internal.knownObstacles(playerId),prior=internal.planningNavigations.get(playerId);
    if(prior&&known.length===prior.navigation.obstacles.length&&known.every((obstacle,index)=>{const old=prior.navigation.obstacles[index]!;return old.id===obstacle.id&&old.xMm===obstacle.xMm&&old.zMm===obstacle.zMm&&old.halfWidth===obstacle.halfWidth&&old.halfHeight===obstacle.halfHeight;})){internal.movementFrame?.planning?.set(playerId,prior.navigation);return prior.navigation;}
    const counts=new Map<string,number>(),next=new Map<string,Obstacle>(known.map(obstacle=>{const index=counts.get(obstacle.id)??0;counts.set(obstacle.id,index+1);return [`${obstacle.id}:${index}`,obstacle] as const;})),changed:Obstacle[]=[];
    if(prior){
      for(const [id,obstacle]of next){const previous=prior.obstacles.get(id);if(!previous||previous.xMm!==obstacle.xMm||previous.zMm!==obstacle.zMm||previous.halfWidth!==obstacle.halfWidth||previous.halfHeight!==obstacle.halfHeight){changed.push(obstacle);if(previous)changed.push(previous);}}
      for(const [id,obstacle]of prior.obstacles)if(!next.has(id))changed.push(obstacle);
      if(!changed.length){internal.movementFrame?.planning?.set(playerId,prior.navigation);return prior.navigation;}
    }
    const navigation=createOwnedNavigation(sim.state.widthMm,sim.state.heightMm,known);internal.planningNavigations.set(playerId,{navigation,obstacles:next,revision:(prior?.revision??0)+1});
    if(prior&&changed.length)internal.pathScheduler.invalidate(playerId,changed.map(obstacle=>({xMm:obstacle.xMm-obstacle.halfWidth,zMm:obstacle.zMm-obstacle.halfHeight,widthMm:obstacle.halfWidth*2,depthMm:obstacle.halfHeight*2})));
    internal.movementFrame?.planning?.set(playerId,navigation);return navigation;
  };
  if(generic){
    const plain=new WeakMap<Navigation,Navigation>(),converted=new WeakSet<Navigation>();
    const convert=(nav:Navigation)=>{if(converted.has(nav))return nav;let value=plain.get(nav);if(!value){value=new Navigation(nav.widthMm,nav.heightMm,nav.obstacles,nav.maxSearchNodes,nav.cellMm,nav.workBudget);plain.set(nav,value);converted.add(value);}return value;};
    const physical=internal.nav;internal.nav=()=>convert(physical.call(sim));
    for(const key of ['planningNav','refreshPlanningNav','admissionNav'] as const){const original=internal[key];internal[key]=playerId=>convert(original.call(sim,playerId));}
  }
  return internal;
}

describe('outside-tick entity enumeration',()=>{
  const entity=(id:string):ResourceNode=>({id,kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:1000,zMm:1000,hp:1,maxHp:1,amount:1000});
  function read(candidate:boolean,mode:'plain'|'proxy'|'reordered-proxy',throws=false){
    const calls:string[]=[],symbol=Symbol('hidden'),target=Object.create({beta:entity('inherited_beta'),inherited:entity('inherited')}) as Record<string,Entity>;
    target['10']=entity('ten');Object.defineProperty(target,'2',{enumerable:true,configurable:true,get(){
      calls.push('getter:2');if(throws)throw new Error('ENUMERATION_GETTER');
      delete target.beta;Object.defineProperty(target,'alpha',{enumerable:false});target.replaced=entity('new_replacement');Object.defineProperty(target,'hidden',{enumerable:true});target.added=entity('added_after_keys');return entity('two');
    }});
    target.beta=entity('deleted_beta');target.alpha=entity('alpha');target.replaced=entity('old_replacement');
    Object.defineProperty(target,'hidden',{value:entity('newly_enumerable'),enumerable:false,configurable:true});
    Object.defineProperty(target,symbol,{enumerable:true,configurable:true,get(){calls.push('symbol:get');throw new Error('SYMBOL_SHOULD_NOT_BE_READ');}});
    const record=mode==='plain'?target:new Proxy(target,{
      ownKeys(value){calls.push('ownKeys');const keys=Reflect.ownKeys(value);return mode==='reordered-proxy'?keys.reverse():keys;},
      getOwnPropertyDescriptor(value,key){calls.push(`descriptor:${String(key)}`);return Reflect.getOwnPropertyDescriptor(value,key);},
      get(value,key,receiver){calls.push(`get:${String(key)}`);return Reflect.get(value,key,receiver);},
    });
    let ids:string[]|undefined,error:string|undefined;
    try{
      const values=candidate?(Simulation.prototype as unknown as LegacyNavigationInternals).all.call({state:{entities:record},tickFrame:undefined} as unknown as LegacyNavigationInternals):Object.values(record);
      ids=values.map(value=>value.id);
    }catch(cause){error=`${(cause as Error).name}:${(cause as Error).message}`;}
    return {ids,error,calls};
  }

  it.each(['plain','proxy','reordered-proxy'] as const)('matches Object.values live descriptor/Get semantics for %s records',mode=>{
    const actual=read(true,mode);expect(actual).toEqual(read(false,mode));expect(actual.error).toBeUndefined();
    expect(actual.ids).not.toContain('inherited');expect(actual.ids).not.toContain('inherited_beta');expect(actual.ids).not.toContain('added_after_keys');expect(actual.calls).not.toContain('symbol:get');
    if(mode!=='reordered-proxy')expect(actual.ids).toEqual(['two','ten','new_replacement','newly_enumerable']);
  });

  it.each(['plain','proxy'] as const)('preserves getter exceptions and stops enumeration at the same point for %s records',mode=>{
    const actual=read(true,mode,true);expect(actual).toEqual(read(false,mode,true));expect(actual.error).toBe('Error:ENUMERATION_GETTER');expect(actual.calls).not.toContain('get:10');
  });
});

describe('explicitly owned navigation geometry',()=>{
  it('rejects separated owned swept bounds after exact charges while preserving tangencies and fallback arithmetic',()=>{
    const obstacles:Obstacle[]=[{id:'far_rectangle',xMm:4000,zMm:6500,halfWidth:450,halfHeight:450},{id:'far_circle',xMm:5000,zMm:6500,halfWidth:450,halfHeight:450,circle:true}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(16000,16000,obstacles,80,1000,left),scalar=new Navigation(16000,16000,obstacles,80,1000,right),from={xMm:1000,zMm:1000},to={xMm:7000,zMm:1000};
    const hypot=vi.spyOn(Math,'hypot');
    try{
      const expected=evaluate(scalar,right,10000,7,nav=>nav.clearLine(from,to,350,'absent')),scalarCalls=hypot.mock.calls.length;hypot.mockClear();
      expect(evaluate(owned,left,10000,7,nav=>nav.clearLine(from,to,350,'absent'))).toEqual(expected);expect(hypot.mock.calls.length).toBeLessThan(scalarCalls);
    }finally{hypot.mockRestore();}
    for(const radius of [0,350,350.25,-1])for(const offset of [-0.000001,0,0.000001])for(const remaining of [0,1,2,3,5,8,10000]){
      const a={xMm:1000,zMm:6050-radius+offset},b={xMm:7000,zMm:a.zMm};
      expect(evaluate(owned,left,remaining,3,nav=>nav.clearLine(a,b,radius,'absent'))).toEqual(evaluate(scalar,right,remaining,3,nav=>nav.clearLine(a,b,radius,'absent')));
    }
  });
  it('uses only the legal formation prefix for canonical unbudgeted owned geometry and retains exact budget/custom behavior',()=>{
    const bodies=Array.from({length:20},(_,index)=>({id:`formation_body_${index}`,xMm:10000+index*1000,zMm:10000,radiusMm:400})),target={xMm:30000,zMm:30000},owned=createOwnedNavigation(64000,64000,[]),scalar=new Navigation(64000,64000,[]),trace:Position[]=[];
    const original=scalar.free;scalar.free=function(point,radius,ignored){trace.push({...point});return original.call(this,point,radius,ignored);};
    const expected=formationTargets(bodies,target,scalar);expect(trace.length).toBeGreaterThan(bodies.length);expect([...formationTargets(bodies,target,owned)]).toEqual([...expected]);
    // Observe cache warmness only after placement, without replacing the owned
    // predicate while its canonical prefix capability is being selected.
    const kernel=kernelPrototype(),miss=vi.spyOn(kernel,'freeUncached');
    try{expect(owned.free(trace[0]!,1450)).toBe(true);expect(miss).not.toHaveBeenCalled();expect(owned.free(trace[bodies.length]!,1450)).toBe(true);expect(miss).toHaveBeenCalledTimes(1);}finally{miss.mockRestore();}
    for(const remaining of [0,2,25,10000]){
      const left={remaining:0,used:0},right={remaining:0,used:0},budgeted=withOwnedNavigationBudget(owned,left),reference=new Navigation(64000,64000,[],30000,1000,right);
      expect(evaluate(budgeted,left,remaining,11,nav=>[...formationTargets(bodies,target,nav)])).toEqual(evaluate(reference,right,remaining,11,nav=>[...formationTargets(bodies,target,nav)]));
    }
    const custom=createOwnedNavigation(64000,64000,[]),prototype=Object.getPrototypeOf(custom) as Navigation,prior=prototype.free;let calls=0;
    prototype.free=function(point,radius,ignored){calls++;return prior.call(this,point,radius,ignored);};
    try{expect([...formationTargets(bodies,target,custom)]).toEqual([...expected]);expect(calls).toBe(trace.length);}finally{prototype.free=prior;}
  });
  it.each([1000,250])('retains captured aliases and cold/warm exact budget exhaustion through flattened %i mm overlays',cellMm=>{
    const source:Obstacle={id:'captured',xMm:8000,zMm:8000,halfWidth:1000,halfHeight:2000},left={remaining:0,used:0},right={remaining:0,used:0};
    const base=createOwnedNavigation(64000,64000,[source,source,{id:'root_only',xMm:52000,zMm:52000,halfWidth:1000,halfHeight:1000}],64,cellMm,left);
    let owned=base;
    for(let layer=0;layer<16;layer++)owned=owned.withAdditionalObstacles([owned.obstacles[0]!,{id:`extra_${layer}`,xMm:16000+(layer%4)*8000,zMm:16000+Math.floor(layer/4)*8000,halfWidth:350,halfHeight:350,circle:true}],64,cellMm,left);
    expect(Object.isFrozen(owned)).toBe(true);expect(Object.isFrozen(owned.obstacles)).toBe(true);
    expect(owned.obstacles[0]).toBe(owned.obstacles[1]);expect(owned.obstacles[0]).toBe(owned.obstacles[3]);
    source.xMm=30000;source.halfWidth=6000;
    expect(owned.obstacles[0]).toMatchObject({xMm:8000,halfWidth:1000});
    // Flat generic reconstruction is the independent charged-work oracle here;
    // the string-bucket tests separately cover overlay-map implementation parity.
    const reference=new Navigation(64000,64000,owned.obstacles,64,cellMm,right);
    const points:Position[]=[{xMm:4000,zMm:6000},{xMm:16000,zMm:16000},{xMm:52000,zMm:52000},{xMm:48000,zMm:8000},{xMm:4250,zMm:6250}];
    const operations=points.flatMap(point=>[
      (nav:Navigation)=>nav.free(point,350),
      (nav:Navigation)=>nav.clearLine(point,{xMm:point.xMm+1000,zMm:point.zMm},350),
      (nav:Navigation)=>nav.clearLine({xMm:point.xMm+1000,zMm:point.zMm},point,350),
      (nav:Navigation)=>nav.clearLine(point,{xMm:56000,zMm:8000},350,'captured'),
    ]);
    for(let pass=0;pass<2;pass++)for(const operation of operations)for(const remaining of [0,1,2,3,5,8,16,100000])
      expect(evaluate(owned,left,remaining,7,operation)).toEqual(evaluate(reference,right,remaining,7,operation));
    // A fresh wrapper must share only completed exact costs; partial queries
    // above cannot become false cheap successes after cold owner reconstruction.
    const rebound=withOwnedNavigationBudget(owned,left,64,cellMm);
    for(const operation of operations)for(const remaining of [0,1,2,8,100000])
      expect(evaluate(rebound,left,remaining,0,operation)).toEqual(evaluate(reference,right,remaining,0,operation));
  });


  it('matches ordered bucket work for identity aliases, repeated IDs and nested or sibling overlays',()=>{
    let seed=0x519ace;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
    const originals:Obstacle[]=Array.from({length:72},(_,index)=>({id:`body_${index%11}`,xMm:2000+Math.floor(random()*60000),zMm:2000+Math.floor(random()*60000),halfWidth:100+Math.floor(random()*8500),halfHeight:100+Math.floor(random()*6500),circle:index%3===0}));
    originals.splice(7,0,originals[0]!,originals[0]!);originals.push(originals[4]!);
    const base=createOwnedNavigation(64000,64000,originals),extra:Obstacle={id:'body_0',xMm:16000,zMm:24000,halfWidth:9500,halfHeight:9500},overlay=base.withAdditionalObstacles([base.obstacles[0]!,extra,extra]),nested=overlay.withAdditionalObstacles([base.obstacles[4]!,overlay.obstacles.at(-1)!,{...extra,id:'other',circle:true}]),sibling=base.withAdditionalObstacles([{...extra,xMm:48000}]);
    // A caller mutation cannot change packed values in either existing owner.
    extra.xMm=32000;originals[0]!.halfWidth=20000;
    const queries:Array<(nav:Navigation)=>unknown>=[];
    for(let index=0;index<90;index++){
      const point={xMm:random()*64000,zMm:random()*64000},to={xMm:random()*64000,zMm:random()*64000},radius=[0,0.25,350,850,4096][index%5]!,ignored=index%3===0?`body_${index%11}`:undefined;
      queries.push(nav=>nav.free(point,radius,ignored),nav=>nav.clearLine(point,to,radius,ignored),nav=>nav.clearLine(to,point,radius,ignored));
    }
    for(const owner of [base,overlay,nested,sibling]){
      const left={remaining:0,used:0},right={remaining:0,used:0},actual=withOwnedNavigationBudget(owner,left,80,250),reference=new Navigation(64000,64000,owner.obstacles,80,250,right);
      for(let repeat=0;repeat<2;repeat++)for(const query of queries)for(const remaining of [0,1,7,10000])expect(evaluate(actual,left,remaining,19,query)).toEqual(evaluate(reference,right,remaining,19,query));
    }
    expect(overlay.obstacles[0]).toBe(overlay.obstacles[originals.length]);expect(overlay.obstacles.at(-1)).toBe(overlay.obstacles.at(-2));
  });

  it('preserves explicit generic construction over an owned base and subsequent mutable overlays',()=>{
    const wall:Obstacle={id:'wall',xMm:12000,zMm:16000,halfWidth:1000,halfHeight:7000},owner=createOwnedNavigation(32000,32000,[wall,wall]),overlay=owner.withAdditionalObstacles([owner.obstacles[0]!,{...wall,xMm:20000,id:'next'}]),dynamic:Obstacle={id:'body',xMm:7000,zMm:16000,halfWidth:500,halfHeight:500,circle:true},left={remaining:0,used:0},right={remaining:0,used:0},actual=new Navigation(32000,32000,[dynamic,dynamic],80,250,left,overlay),reference=new Navigation(32000,32000,[...overlay.obstacles,dynamic,dynamic],80,250,right);
    expect(actual.obstacles).toEqual(reference.obstacles);expect(actual.obstacles[0]).toBe(actual.obstacles[2]);
    const query=(nav:Navigation)=>nav.clearLine({xMm:4000,zMm:16000},{xMm:28000,zMm:16000},350,'wall');
    for(const xMm of [7000,8000,10000]){dynamic.xMm=xMm;for(const remaining of [0,1,2,8,1000])expect(evaluate(actual,left,remaining,3,query)).toEqual(evaluate(reference,right,remaining,3,query));}
    const next=actual.withAdditionalObstacles([owner.obstacles[0]!,dynamic]),plain=reference.withAdditionalObstacles([owner.obstacles[0]!,dynamic]);
    for(const ignored of [undefined,'wall','next','body'])expect(next.clearLine({xMm:4000,zMm:16000},{xMm:28000,zMm:16000},350,ignored)).toBe(plain.clearLine({xMm:4000,zMm:16000},{xMm:28000,zMm:16000},350,ignored));
  });

  it('retains floating tangencies, signed and fallback bucket boundaries, and every partial ledger',()=>{
    for(const origin of [0,32760000,32768000]){
      const source:Obstacle={id:'same',xMm:origin+8000,zMm:16000,halfWidth:2000,halfHeight:8000},circle:Obstacle={id:'same',xMm:origin+15000,zMm:16000,halfWidth:500,halfHeight:500,circle:true},obstacles=[source,source,circle,{...circle}],left={remaining:0,used:0},right={remaining:0,used:0},actual=createOwnedNavigation(70000000,40000,obstacles,80,250,left),reference=new Navigation(70000000,40000,obstacles,80,250,right);
      const queries:Array<(nav:Navigation)=>unknown>=[];
      for(const offset of [-0.000001,0,0.000001])for(const radius of [0,0.25,350,850])for(const ignored of [undefined,'same','absent']){
        const point={xMm:source.xMm+source.halfWidth+radius+offset,zMm:source.zMm},a={xMm:origin+1000,zMm:24000+radius+offset},b={xMm:origin+20000,zMm:a.zMm};
        queries.push(nav=>nav.free(point,radius,ignored),nav=>nav.free({xMm:circle.xMm+circle.halfWidth+radius+offset,zMm:circle.zMm},radius,ignored),nav=>nav.clearLine(a,b,radius,ignored),nav=>nav.clearLine(b,a,radius,ignored));
      }
      for(const query of queries){const complete=evaluate(reference,right,10000,23,query);expect(evaluate(actual,left,10000,23,query)).toEqual(complete);for(let remaining=0;remaining<=complete.used-23;remaining++)expect(evaluate(actual,left,remaining,23,query)).toEqual(evaluate(reference,right,remaining,23,query));}
    }
  });

  it('releases shared query scratch after failure and isolates reentrant budget queries',()=>{
    const obstacle:Obstacle={id:'wall',xMm:12000,zMm:16000,halfWidth:1000,halfHeight:5000},owner=createOwnedNavigation(32000,32000,[obstacle,obstacle]),plain=new Navigation(32000,32000,owner.obstacles),from={xMm:4000,zMm:16000},to={xMm:24000,zMm:16000},innerFrom={xMm:4000,zMm:23000},innerTo={xMm:24000,zMm:23000},innerExpected=plain.clearLine(innerFrom,innerTo,350,'absent');
    const run=(owned:boolean,remaining:number)=>{
      let stored=remaining,active=false,nested=0;const budget:NavigationWorkBudget={used:0,get remaining(){if(!active&&budget.used>=7){active=true;try{expect((owned?owner:plain).clearLine(innerFrom,innerTo,350,'absent')).toBe(innerExpected);nested++;}finally{active=false;}}return stored;},set remaining(value){stored=value;}};
      const nav=owned?withOwnedNavigationBudget(owner,budget):new Navigation(32000,32000,owner.obstacles,30000,1000,budget);let answer:boolean|undefined,error:string|undefined;try{answer=nav.clearLine(from,to,350,'absent');}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error=cause.message;}
      return {answer,error,remaining:stored,used:budget.used,nested};
    };
    for(let repeat=0;repeat<3;repeat++)for(let remaining=0;remaining<30;remaining++)expect(run(true,remaining)).toEqual(run(false,remaining));
    expect(run(true,100).nested).toBeGreaterThan(0);expect(run(true,100).answer).toBe(false);
  });


  it('retains exact endpoint-bridge admission charges across cold and warm geometry caches',()=>{
    const obstacles:Obstacle[]=[...Array.from({length:6},(_,index)=>({id:`berry_${index}`,xMm:114000+index%3*2200,zMm:196500+Math.floor(index/3)*2200,halfWidth:650,halfHeight:650})),{id:'proposed_house',xMm:118000,zMm:190000,halfWidth:2000,halfHeight:2000}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(256000,256000,obstacles,30000,1000,left),generic=new Navigation(256000,256000,obstacles,30000,1000,right),from={xMm:117691,zMm:197588},target={xMm:120850,zMm:190000};
    for(let repeat=0;repeat<2;repeat++)for(const allowance of [0,10,1000,50000])for(const query of [(nav:Navigation)=>nav.path(from,target,350),(nav:Navigation)=>nav.path(target,from,350)])expect(evaluate(owned,left,allowance,17,query)).toEqual(evaluate(generic,right,allowance,17,query));
  });
  it('captures aliases without freezing caller geometry and retains generic mutation behavior',()=>{
    const source:Obstacle={id:'mutable',xMm:6000,zMm:6000,halfWidth:500,halfHeight:500},input=[source,source],generic=new Navigation(20000,20000,input),owned=createOwnedNavigation(20000,20000,input),point={xMm:4000,zMm:6000};
    expect(owned.obstacles[0]).toBe(owned.obstacles[1]);expect(owned.obstacles[0]).not.toBe(source);expect(Object.isFrozen(owned.obstacles)).toBe(true);expect(Object.isFrozen(owned.obstacles[0])).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);expect(Object.isFrozen(source)).toBe(false);expect(owned.free(point,350)).toBe(true);expect(generic.free(point,350)).toBe(true);
    source.halfWidth=2500;expect(generic.free(point,350)).toBe(false);expect(owned.free(point,350)).toBe(true);expect(createOwnedNavigation(20000,20000,input).free(point,350)).toBe(false);
    expect(Reflect.set(owned,'widthMm',1000)).toBe(false);expect(owned.widthMm).toBe(20000);
    // A mutable source passed again to an overlay is captured at its new value;
    // only already-owned immutable objects may keep their identity across layers.
    const overlay=owned.withAdditionalObstacles([source,source]);expect(overlay.obstacles[2]).toBe(overlay.obstacles[3]);expect(overlay.obstacles[2]).not.toBe(owned.obstacles[0]);expect(overlay.free(point,350)).toBe(false);
  });

  it.each([{cellMm:1000,point:{xMm:4000,zMm:6000}},{cellMm:250,point:{xMm:4250,zMm:6250}}])('learns exact costs only from completed admission and preserves warm exhaustion at $cellMm mm',({cellMm,point})=>{
    const source:Obstacle={id:'shared',xMm:6000,zMm:6000,halfWidth:500,halfHeight:500},owned=createOwnedNavigation(20000,20000,[source,source],30000,cellMm),budget={remaining:0,used:0},other={remaining:0,used:0},admission=withOwnedNavigationBudget(owned,budget,30000,cellMm),reference=new Navigation(20000,20000,[source,source],30000,cellMm,other),spy=vi.spyOn(kernelPrototype(),'freeUncached');
    try{
      expect(owned.free(point,350)).toBe(true);const warmCalls=spy.mock.calls.length;expect(owned.free(point,350)).toBe(true);expect(spy.mock.calls.length).toBe(warmCalls);
      expect(evaluate(admission,budget,2,17,nav=>nav.free(point,350))).toEqual(evaluate(reference,other,2,17,nav=>nav.free(point,350)));
      const beforeRetry=spy.mock.calls.length;expect(evaluate(admission,budget,3,17,nav=>nav.free(point,350))).toEqual({answer:true,error:undefined,remaining:0,used:20});expect(spy.mock.calls.length).toBe(beforeRetry+1);
      for(const remaining of [0,1,2,3,4,100]){
        const before=spy.mock.calls.length,actual=evaluate(admission,budget,remaining,17,nav=>nav.free(point,350));expect(spy.mock.calls.length).toBe(before);
        expect(actual).toEqual(evaluate(reference,other,remaining,17,nav=>nav.free(point,350)));
      }
      // A fresh budget owner shares the same immutable geometry and known cost.
      const nextBudget={remaining:3,used:11},next=withOwnedNavigationBudget(owned,nextBudget,30000,cellMm),before=spy.mock.calls.length;expect(next.free(point,350)).toBe(true);expect(nextBudget).toEqual({remaining:0,used:14});expect(spy.mock.calls.length).toBe(before);
      for(const [remaining,used]of [[2.5,17.25],[-1,3],[Infinity,17],[NaN,17],[5,Number.MAX_SAFE_INTEGER]] as const)expect(evaluate(admission,budget,remaining,used,nav=>nav.free(point,350))).toEqual(evaluate(reference,other,remaining,used,nav=>nav.free(point,350)));
    }finally{spy.mockRestore();}
  });

  it('matches free, swept geometry and path answers with exact budget ledgers on cold and warm queries',()=>{
    const shared:Obstacle={id:'wall',xMm:8000,zMm:9000,halfWidth:500,halfHeight:3000},obstacles:Obstacle[]=[shared,shared,{id:'body',xMm:14000,zMm:14000,halfWidth:850,halfHeight:850,circle:true},{id:'edge',xMm:-50,zMm:9000,halfWidth:200,halfHeight:1000}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(24000,24000,obstacles,80,1000,left),generic=new Navigation(24000,24000,obstacles,80,1000,right);
    const points:Position[]=[{xMm:0,zMm:9000},{xMm:6000,zMm:9000},{xMm:8000,zMm:6000},{xMm:10000,zMm:9000},{xMm:14000,zMm:14000},{xMm:16000,zMm:15000}];
    for(let repeat=0;repeat<2;repeat++)for(const remaining of [0,1,2,3,8,32,100000])for(const [index,point]of points.entries())for(const radius of [0,350,850]){
      const other=points[(index+1)%points.length]!;
      for(const query of [(nav:Navigation)=>nav.free(point,radius),(nav:Navigation)=>nav.clearLine(point,other,radius),(nav:Navigation)=>nav.clearLine(point,other,radius,'wall')])expect(evaluate(owned,left,remaining,7,query)).toEqual(evaluate(generic,right,remaining,7,query));
    }
    for(let repeat=0;repeat<2;repeat++)for(const remaining of [0,1,8,128,100000])for(const query of [(nav:Navigation)=>nav.path({xMm:5000,zMm:9000},{xMm:11000,zMm:9000},350),(nav:Navigation)=>nav.pathToAny({xMm:14000,zMm:17000},[{xMm:14000,zMm:14000},{xMm:17000,zMm:17000}],350)])expect(evaluate(owned,left,remaining,7,query)).toEqual(evaluate(generic,right,remaining,7,query));
  });

  it('matches quarter-grid local detours, swept collisions and exact work on cold and warm caches',()=>{
    const wall:Obstacle={id:'wall',xMm:8250,zMm:8250,halfWidth:250,halfHeight:750},obstacles:Obstacle[]=[wall,wall,{id:'body',xMm:12500,zMm:8250,halfWidth:500,halfHeight:500,circle:true}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(20000,20000,obstacles,512,250,left),generic=new Navigation(20000,20000,obstacles,512,250,right);
    const from={xMm:6750,zMm:8250},target={xMm:9750,zMm:8250},points:Position[]=[from,target,{xMm:7500,zMm:8250},{xMm:8000,zMm:8250},{xMm:13500,zMm:8250},{xMm:13250,zMm:8250},{xMm:13500.25,zMm:8250},{xMm:250,zMm:8250}];
    for(let repeat=0;repeat<2;repeat++)for(const remaining of [0,1,2,3,8,32,100000])for(const [index,point]of points.entries())for(const radius of [350,500,850]){
      const next=points[(index+1)%points.length]!;
      for(const query of [(nav:Navigation)=>nav.free(point,radius),(nav:Navigation)=>nav.clearLine(point,next,radius),(nav:Navigation)=>nav.clearLine(point,next,radius,'wall')])expect(evaluate(owned,left,remaining,13,query)).toEqual(evaluate(generic,right,remaining,13,query));
    }
    for(let repeat=0;repeat<2;repeat++)for(const remaining of [0,1,8,128,1024,100000])for(const query of [(nav:Navigation)=>nav.path(from,target,350),(nav:Navigation)=>nav.pathToAny(from,[{xMm:8250,zMm:8250},target],350)])expect(evaluate(owned,left,remaining,13,query)).toEqual(evaluate(generic,right,remaining,13,query));
    const physical=new Navigation(20000,20000,obstacles,512,250),route=physical.path(from,target,350)!;
    expect(route.length).toBeGreaterThan(1);expect(route.at(-1)).toEqual(target);expect(physical.clearLine(from,target,350)).toBe(false);
    let anchor=from;for(const point of route){expect(physical.clearLine(anchor,point,350)).toBe(true);anchor=point;}
    // Exact tangency stays legal; a quarter-metre step toward the circle collides.
    expect(physical.free({xMm:13500,zMm:8250},500)).toBe(true);expect(physical.free({xMm:13250,zMm:8250},500)).toBe(false);
  });

  it.each([1000,250])('isolates fresh overlay caches and immutable obstacle aliases at %i mm',cellMm=>{
    const body:Obstacle={id:'body',xMm:12000,zMm:12000,halfWidth:500,halfHeight:500},base=createOwnedNavigation(30000,30000,[body],80,cellMm),point={xMm:16000+(cellMm===250?250:0),zMm:16000},spy=vi.spyOn(kernelPrototype(),'freeUncached');
    try{
      expect(base.free(point,350)).toBe(true);const baseCalls=spy.mock.calls.length;
      const overlay=base.withAdditionalObstacles([base.obstacles[0]!,{id:'new',...point,halfWidth:500,halfHeight:500}],80,250),nested=overlay.withAdditionalObstacles([{id:'next',xMm:20000,zMm:20000,halfWidth:500,halfHeight:500}],80,250);
      expect(overlay.obstacles[0]).toBe(overlay.obstacles[1]);expect(overlay.free(point,350)).toBe(false);expect(spy.mock.calls.length).toBe(baseCalls+1);expect(overlay.free(point,350)).toBe(false);expect(spy.mock.calls.length).toBe(baseCalls+1);
      expect(base.free(point,350)).toBe(true);expect(spy.mock.calls.length).toBe(baseCalls+1);expect(nested.free(point,350)).toBe(false);expect(spy.mock.calls.length).toBe(baseCalls+2);
      expect(overlay.free({xMm:20000,zMm:20000},350)).toBe(true);expect(nested.free({xMm:20000,zMm:20000},350)).toBe(false);
      const genericBase=new Navigation(30000,30000,[body]),genericOverlay=genericBase.withAdditionalObstacles([body,{id:'new',...point,halfWidth:500,halfHeight:500}],80,250),left={remaining:100000,used:0},right={remaining:100000,used:0};
      const budgeted=withOwnedNavigationBudget(overlay,left,80,250),reference=withOwnedNavigationBudget(genericOverlay,right,80,250);
      const query=(nav:Navigation)=>nav.clearLine({xMm:9000,zMm:10000},{xMm:15000,zMm:10000},350);
      expect(evaluate(budgeted,left,100000,0,query)).toEqual(evaluate(reference,right,100000,0,query));expect(evaluate(budgeted,left,100000,0,query)).toEqual(evaluate(reference,right,100000,0,query));
    }finally{spy.mockRestore();}
  });

  it.each([1000,250])('bounds mixed cache retention to8192 FIFO keys and bypasses unsupported forms at %i mm',cellMm=>{
    const owned=createOwnedNavigation(640000,640000,[],30000,cellMm),spy=vi.spyOn(kernelPrototype(),'freeUncached'),point=(index:number)=>({xMm:10000+index%128*1000+(cellMm===250&&index%2?250:0),zMm:10000+Math.floor(index/128)*1000});
    try{
      for(let index=0;index<8192;index++)expect(owned.free(point(index),350)).toBe(true);
      const calls=spy.mock.calls.length;expect(owned.free(point(0),350)).toBe(true);expect(spy.mock.calls.length).toBe(calls);
      expect(owned.free(point(8192),350)).toBe(true);expect(spy.mock.calls.length).toBe(calls+1);
      expect(owned.free(point(0),350)).toBe(true);expect(spy.mock.calls.length).toBe(calls+2);
      const queries:[Position,number,string?][]=[[{xMm:10000.5,zMm:10000},350],[{xMm:10125,zMm:10000},350],[point(0),0],[point(0),4096],[point(0),350.5],[point(0),350,''],[{xMm:10250,zMm:10000},350,'ignored'],[{xMm:640250,zMm:10000},350],[{xMm:-250,zMm:10000},350],[{xMm:NaN,zMm:10000},350]];
      for(const [where,radius,ignored]of queries){const before=spy.mock.calls.length;owned.free(where,radius,ignored);owned.free(where,radius,ignored);expect(spy.mock.calls.length).toBe(before+2);}
    }finally{spy.mockRestore();}
  });

  it('keeps numeric key dimensions distinct at their coordinate and radius limits',()=>{
    const obstacle:Obstacle={id:'corner',xMm:640000,zMm:1000,halfWidth:100,halfHeight:100},left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(642000,642000,[obstacle],80,1000,left),generic=new Navigation(642000,642000,[obstacle],80,1000,right);
    for(let repeat=0;repeat<2;repeat++)for(const point of [{xMm:640000,zMm:1000},{xMm:0,zMm:2000},{xMm:1000,zMm:640000},{xMm:1000,zMm:0}])for(const radius of [1,2,350,4095,4096])for(const remaining of [0,1,2,3,100])expect(evaluate(owned,left,remaining,9,nav=>nav.free(point,radius))).toEqual(evaluate(generic,right,remaining,9,nav=>nav.free(point,radius)));
  });

  it('separates quarter and metre numeric domains and prevents coordinate or radius rollover aliases',()=>{
    const obstacles:Obstacle[]=[{id:'whole',xMm:10000,zMm:10000,halfWidth:100,halfHeight:100}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(650000,650000,obstacles,80,250,left),generic=new Navigation(650000,650000,obstacles,80,250,right);
    // Without domain separation, (radius350,10m,10m) and this radius21 quarter
    // query both encode as143814770. The first is blocked and the second is free.
    const cases:[Position,number,boolean][]=[[{xMm:10000,zMm:10000},350,false],[{xMm:453750,zMm:593500},21,true],
      [{xMm:640000,zMm:1250},1,true],[{xMm:0,zMm:1500},1,false],
      [{xMm:1250,zMm:640000},1,true],[{xMm:1250,zMm:0},2,false],
      [{xMm:639750,zMm:640000},4095,true],[{xMm:640000,zMm:639750},4095,true]];
    for(let repeat=0;repeat<2;repeat++)for(const [point,radius,answer]of cases){
      expect(evaluate(owned,left,100,9,nav=>nav.free(point,radius))).toEqual({...evaluate(generic,right,100,9,nav=>nav.free(point,radius)),answer});
      for(const remaining of [0,1,2,3,100])expect(evaluate(owned,left,remaining,9,nav=>nav.free(point,radius))).toEqual(evaluate(generic,right,remaining,9,nav=>nav.free(point,radius)));
    }
  });

  it('never stores a partial quarter query and bypasses quarter caching for other cell sizes',()=>{
    const obstacle:Obstacle={id:'body',xMm:6000,zMm:6000,halfWidth:500,halfHeight:500},point={xMm:4250,zMm:6250},budget={remaining:0,used:0},owned=createOwnedNavigation(20000,20000,[obstacle,obstacle],80,250,budget),spy=vi.spyOn(kernelPrototype(),'freeUncached');
    try{
      for(let repeat=0;repeat<2;repeat++){const before=spy.mock.calls.length;expect(evaluate(owned,budget,2,5,nav=>nav.free(point,350))).toEqual({answer:undefined,error:'PathBudgetExceededError:PATH_BUSY',remaining:0,used:7});expect(spy.mock.calls.length).toBe(before+1);}
      expect(evaluate(owned,budget,3,5,nav=>nav.free(point,350))).toEqual({answer:true,error:undefined,remaining:0,used:8});const complete=spy.mock.calls.length;
      expect(evaluate(owned,budget,2,5,nav=>nav.free(point,350))).toEqual({answer:undefined,error:'PathBudgetExceededError:PATH_BUSY',remaining:0,used:7});expect(spy.mock.calls.length).toBe(complete);
      for(const cellMm of [125,500,1000,2000]){
        const other={remaining:0,used:0},wrapper=withOwnedNavigationBudget(owned,other,80,cellMm),before=spy.mock.calls.length;
        for(let repeat=0;repeat<2;repeat++)expect(evaluate(wrapper,other,3,5,nav=>nav.free(point,350))).toEqual({answer:true,error:undefined,remaining:0,used:8});
        expect(spy.mock.calls.length).toBe(before+2);
      }
      const shared={remaining:3,used:5},wrapper=withOwnedNavigationBudget(owned,shared,80,250),before=spy.mock.calls.length;expect(wrapper.free(point,350)).toBe(true);expect(shared).toEqual({remaining:0,used:8});expect(spy.mock.calls.length).toBe(before);
    }finally{spy.mockRestore();}
  });

  it('matches complete cardinal sweeps and exact exhaustion in both directions on cold and warm caches',()=>{
    const wall:Obstacle={id:'wall',xMm:10500,zMm:10000,halfWidth:100,halfHeight:100},obstacles:Obstacle[]=[wall,wall,{id:'circle',xMm:12500,zMm:10000,halfWidth:100,halfHeight:100,circle:true}],left={remaining:0,used:0},right={remaining:0,used:0},owned=createOwnedNavigation(20000,20000,obstacles,80,250,left),generic=new Navigation(20000,20000,obstacles,80,250,right);
    const segments:[Position,Position][]=[
      [{xMm:10000,zMm:10000},{xMm:11000,zMm:10000}],
      [{xMm:12000,zMm:10000},{xMm:13000,zMm:10000}],
      [{xMm:10000,zMm:11000},{xMm:11000,zMm:11000}],
      [{xMm:11000,zMm:9000},{xMm:11000,zMm:10000}],
      [{xMm:0,zMm:1000},{xMm:1000,zMm:1000}],
    ];
    const physical=new Navigation(20000,20000,obstacles);expect(physical.free(segments[0]![0],350)).toBe(true);expect(physical.free(segments[0]![1],350)).toBe(true);expect(physical.clearLine(...segments[0]!,350)).toBe(false);
    for(let repeat=0;repeat<3;repeat++)for(const [a,b]of segments)for(const [from,to]of [[a,b],[b,a]])for(const radius of [1,350,850])for(const remaining of [0,1,2,3,4,6,8,12,16,100]){
      const query=(nav:Navigation)=>nav.clearLine(from!,to!,radius);
      expect(evaluate(owned,left,remaining,11,query)).toEqual(evaluate(generic,right,remaining,11,query));
    }
  });

  it('learns a sweep charge after unbudgeted warming and never stores partial sweeps',()=>{
    const obstacle:Obstacle={id:'remote',xMm:14000,zMm:14000,halfWidth:100,halfHeight:100},from={xMm:10000,zMm:10000},to={xMm:11000,zMm:10000},owned=createOwnedNavigation(20000,20000,[obstacle]),left={remaining:0,used:0},right={remaining:0,used:0},budgeted=withOwnedNavigationBudget(owned,left),generic=new Navigation(20000,20000,[obstacle],30000,1000,right),spy=vi.spyOn(kernelPrototype(),'clearLineUncached');
    try{
      expect(owned.clearLine(from,to,350)).toBe(true);const first=spy.mock.calls.length;expect(owned.clearLine(from,to,350)).toBe(true);expect(spy.mock.calls.length).toBe(first);
      const query=(nav:Navigation)=>nav.clearLine(from,to,350),complete=evaluate(generic,right,100,7,query),charge=complete.used-7;
      expect(charge).toBeGreaterThan(1);
      for(let repeat=0;repeat<2;repeat++){const before=spy.mock.calls.length;expect(evaluate(budgeted,left,charge-1,7,query)).toEqual({answer:undefined,error:'PathBudgetExceededError:PATH_BUSY',remaining:0,used:7+charge-1});expect(spy.mock.calls.length).toBe(before+1);}
      expect(evaluate(budgeted,left,100,7,query)).toEqual(complete);
      for(const remaining of [0,charge-1,charge,charge+1]){const before=spy.mock.calls.length,actual=evaluate(budgeted,left,remaining,7,query);expect(spy.mock.calls.length).toBe(before);expect(actual).toEqual(evaluate(generic,right,remaining,7,query));}
    }finally{spy.mockRestore();}
  });

  it('shares the existing FIFO capacity across point and sweep domains without aliasing',()=>{
    const owned=createOwnedNavigation(640000,640000,[],30000,250),point=(index:number)=>({xMm:10000+index%128*1000,zMm:10000+Math.floor(index/128)*1000}),free=vi.spyOn(kernelPrototype(),'freeUncached'),line=vi.spyOn(kernelPrototype(),'clearLineUncached');
    try{
      for(let index=0;index<8192;index++)expect(owned.free(point(index),350)).toBe(true);
      const pointCalls=free.mock.calls.length;expect(owned.clearLine(point(0),point(1),350)).toBe(true);expect(free.mock.calls.length).toBe(pointCalls);
      // Inserting a sweep evicts the oldest point; this is still one8192-key cache.
      expect(owned.free(point(0),350)).toBe(true);expect(free.mock.calls.length).toBe(pointCalls+1);
      const sweepCalls=line.mock.calls.length;expect(owned.clearLine(point(0),point(1),350)).toBe(true);expect(line.mock.calls.length).toBe(sweepCalls);
      for(let index=8192;index<16384;index++)owned.free(point(index),350);
      expect(owned.clearLine(point(0),point(1),350)).toBe(true);expect(line.mock.calls.length).toBe(sweepCalls+1);
      // Quarter positions and positive point keys stay separate from sweeps.
      for(const where of [point(0),{xMm:10250,zMm:10000}])expect(owned.free(where,350)).toBe(true);
    }finally{free.mockRestore();line.mockRestore();}
  });

  it('isolates cardinal sweep overlays and bypasses unsupported or ignored queries',()=>{
    const from={xMm:10000,zMm:10000},to={xMm:11000,zMm:10000},owned=createOwnedNavigation(642000,642000,[]),source:Obstacle={id:'new',xMm:10500,zMm:10000,halfWidth:100,halfHeight:100},spy=vi.spyOn(kernelPrototype(),'clearLineUncached');
    try{
      expect(owned.clearLine(from,to,350)).toBe(true);const overlay=owned.withAdditionalObstacles([source]);expect(overlay.clearLine(from,to,350)).toBe(false);source.xMm=15000;
      expect(overlay.clearLine(from,to,350)).toBe(false);expect(owned.clearLine(from,to,350)).toBe(true);expect(createOwnedNavigation(642000,642000,[source]).clearLine(from,to,350)).toBe(true);
      const cases:[Position,Position,number,string?][]=[[from,to,350,'new'],[from,{xMm:12000,zMm:10000},350],[from,{xMm:11000,zMm:11000},350],[from,{xMm:10250,zMm:10000},350],[{xMm:10250,zMm:10000},{xMm:11250,zMm:10000},350],[from,to,350.5],[from,to,0],[from,to,4096],[{xMm:640000,zMm:10000},{xMm:641000,zMm:10000},350]];
      for(const [a,b,radius,ignored]of cases){const before=spy.mock.calls.length;overlay.clearLine(a,b,radius,ignored);overlay.clearLine(a,b,radius,ignored);expect(spy.mock.calls.length).toBe(before+2);}
    }finally{spy.mockRestore();}
  });

  it('retains complete simulation and recipient views against generic navigation, including cold restore',()=>{
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}],options={factions,seed:'owned-nav-equivalence',matchId:'owned-nav-equivalence',controllers:false,sharedVision:false},owned=createSimulation(options),reference=createSimulation(options);
    installLegacyNavigation(reference,true);
    const compare=(a:Simulation,b:Simulation)=>{
      expect(JSON.stringify(a.capture())).toBe(JSON.stringify(b.capture()));
      expect(JSON.stringify(a.views(['a','b']))).toBe(JSON.stringify(b.views(['a','b'])));
      // cacheHits is a cumulative diagnostic omitted from scheduler save state;
      // cold owners restart that counter. Per-step logical work remains exact.
      const {cacheHits:_aHits,...aWork}=a.pathDiagnostics(),{cacheHits:_bHits,...bWork}=b.pathDiagnostics();
      expect(aWork).toEqual(bWork);
    };
    // No constructor-side refresh may eagerly replace the saved empty profiles.
    compare(owned,reference);expect((owned as unknown as LegacyNavigationInternals).planningNavigations.size).toBe(0);
    const issue=(sim:Simulation,command:GameplayCommand)=>{const sequence=sim.state.economies.a!.lastClientSequence+1;return sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`cache_${sequence}`,clientSequence:sequence,command});};
    const workers=Object.values(owned.state.entities).filter((entity):entity is Unit=>entity.ownerId==='a'&&entity.kind==='unit'&&entity.typeId==='villager'),wood=owned.view('a').entities.find(entity=>entity.kind==='resource'&&entity.resource==='wood')!;
    const gather:GameplayCommand={kind:'gather',unitIds:workers.slice(0,3).map(worker=>worker.id),targetId:wood.id,queued:false},move:GameplayCommand={kind:'move',unitIds:workers.slice(3).map(worker=>worker.id),target:{xMm:owned.state.widthMm/2,zMm:owned.state.heightMm/2},queued:false};
    for(const command of [gather,move])expect(issue(owned,command)).toEqual(issue(reference,command));
    for(let tick=0;tick<160;tick++){owned.step();reference.step();if(tick%8===0)compare(owned,reference);}
    compare(owned,reference);const restored=new Simulation(owned.options,owned.capture()),restoredReference=new Simulation(reference.options,reference.capture());installLegacyNavigation(restoredReference,true);
    expect(JSON.stringify(restored.capture())).toBe(JSON.stringify(restoredReference.capture()));
    for(let tick=0;tick<80;tick++){owned.step();reference.step();restored.step();restoredReference.step();if(tick%8===0){compare(owned,reference);compare(owned,restored);compare(owned,restoredReference);}}
    compare(owned,reference);compare(owned,restored);compare(owned,restoredReference);expect(owned.state.pathAdmission!.a!.used).toBe(reference.state.pathAdmission!.a!.used);
  },30000);
});


describe('persistent authorized static obstacle records',()=>{
  type Internals={knownStatic(playerId:string):Entity[];entityObstacles(entity:Entity,playerId:string):Obstacle[];knownObstacles(playerId:string):Obstacle[];refreshPlanningNav(playerId:string):Navigation;planningGeometries():{profile:string;revision:number;widthMm:number;heightMm:number;obstacles:readonly Obstacle[]}[];knownObstacleRecords:Map<string,{records:Map<string,{obstacles:Obstacle[]}>}>;pathScheduler:{invalidate(profile:string,regions:{xMm:number;zMm:number;widthMm:number;depthMm:number}[]):void}};
  const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}];
  const resource=(id='cached_resource'):ResourceNode=>({id,kind:'resource',typeId:'gold_mine',ownerId:null,xMm:20000,zMm:20000,hp:1,maxHp:1,resource:'wood',amount:1000});
  const gate=():Building=>({id:'cached_gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:20000,zMm:20000,rotation:0,hp:100,maxHp:100,work:100,required:100,grantedHp:100,queue:[],cooldown:0,gateMode:'AUTO',gateOpen:false});
  function fixture(initial:Entity[]){
    const sim=createSimulation({factions,seed:'known-obstacle-records',matchId:'known-obstacle-records',controllers:false,sharedVision:false}),internal=sim as unknown as Internals;
    let roster=initial;internal.knownStatic=()=>roster;
    const actual=(playerId='a')=>internal.knownObstacles(playerId);
    const expected=(playerId='a')=>[...terrainObstacles(sim.state.map.terrain),...roster.flatMap(entity=>internal.entityObstacles(entity,playerId))];
    const entities=(playerId='a')=>actual(playerId).filter(obstacle=>roster.some(entity=>entity.id===obstacle.id));
    return {sim,internal,actual,expected,entities,setRoster:(next:Entity[])=>{roster=next;}};
  }

  it('retains the complete ordered obstacle array without changing old immutable snapshots',()=>{
    const first=resource('first'),second={...resource('second'),xMm:26000},f=fixture([first,second]),before=f.actual(),snapshot=structuredClone(before);
    expect(Object.isFrozen(before)).toBe(true);expect(before.every(Object.isFrozen)).toBe(true);expect(f.actual()).toBe(before);
    first.amount--;expect(f.actual()).toBe(before);
    f.setRoster([{...first},{...second}]);expect(f.actual()).toBe(before);
    const nav=f.internal.refreshPlanningNav('a'),revision=f.internal.planningGeometries()[0]!.revision;
    // A permutation changes the ordered source list but the legacy occurrence
    // diff keeps the existing navigation and its original insertion order.
    f.setRoster([second,first]);const reordered=f.actual();expect(reordered).not.toBe(before);expect(reordered).toEqual(f.expected());
    expect(f.internal.refreshPlanningNav('a')).toBe(nav);expect(f.internal.planningGeometries()[0]!.revision).toBe(revision);expect(f.actual()).toBe(reordered);
    second.xMm+=2000;const changed=f.actual();expect(changed).not.toBe(reordered);expect(changed).toEqual(f.expected());
    expect(f.internal.refreshPlanningNav('a')).not.toBe(nav);expect(before).toEqual(snapshot);expect(Object.isFrozen(changed)).toBe(true);
    f.setRoster([]);const empty=f.actual();expect(empty).toEqual(terrainObstacles(f.sim.state.map.terrain));expect(f.actual()).toBe(empty);expect(before).toEqual(snapshot);
  });

  it('reconciles mutable terrain and ordered bridge/ramp cuts even inside one work frame',()=>{
    const f=fixture([]),water:TerrainRegion={id:'water',kind:'water',xMm:10000,zMm:12000,widthMm:18000,depthMm:14000,elevationMm:-1000},bridge:TerrainRegion={id:'bridge',kind:'bridge',xMm:17000,zMm:10000,widthMm:2000,depthMm:18000,elevationMm:0},cliff:TerrainRegion={id:'cliff',kind:'cliff',xMm:35000,zMm:10000,widthMm:8000,depthMm:18000,elevationMm:3000},ramp:TerrainRegion={id:'ramp',kind:'ramp',xMm:33000,zMm:18000,widthMm:12000,depthMm:3000,axis:'x',startElevationMm:0,endElevationMm:3000};
    f.sim.state.map.terrain=[water,bridge,cliff,ramp];const internal=f.sim as unknown as LegacyNavigationInternals;
    internal.workFrame={knowledge:{entities:[],knownStatic:new Map()}};
    const original=f.actual(),snapshot=structuredClone(original),globalRevision=f.sim.state.navigationRevision;
    expect(original).toEqual(f.expected());expect(f.actual()).toBe(original);
    water.elevationMm=-2500;expect(f.actual()).toBe(original);
    for(const change of [()=>{bridge.xMm+=1000;},()=>{ramp.depthMm+=1000;},()=>{water.widthMm+=2000;},()=>{cliff.id='changed_cliff';},()=>{f.sim.state.map.terrain=[ramp,cliff,bridge,water];},()=>{f.sim.state.map.terrain.splice(2,1);}]){
      const previous=f.actual();change();const next=f.actual();expect(next).toEqual(f.expected());expect(next).not.toBe(previous);expect(f.actual()).toBe(next);expect(f.sim.state.navigationRevision).toBe(globalRevision);expect(original).toEqual(snapshot);
    }
    internal.workFrame=undefined;
  });

  it('never treats an overridden mutable obstacle array as certified geometry',()=>{
    const f=fixture([]),reference=fixture([]),obstacle:Obstacle={id:'mutable_override',xMm:22000,zMm:20000,halfWidth:500,halfHeight:500},source=[obstacle],referenceSource=structuredClone(source),legacy=installLegacyNavigation(reference.sim);
    f.internal.knownObstacles=()=>source;legacy.knownObstacles=()=>referenceSource;
    const first=f.internal.refreshPlanningNav('a'),snapshot=structuredClone(first.obstacles),revision=f.internal.planningGeometries()[0]!.revision,invalidate=vi.spyOn(f.internal.pathScheduler,'invalidate');
    legacy.refreshPlanningNav('a');
    const legacyInvalidate=vi.spyOn(legacy.pathScheduler,'invalidate');
    const compareLegacy=(actual:Navigation)=>{expect(actual.obstacles).toEqual(legacy.refreshPlanningNav('a').obstacles);expect(f.internal.planningGeometries()).toEqual(reference.internal.planningGeometries());expect(invalidate.mock.calls).toEqual(legacyInvalidate.mock.calls);};
    try{
      expect(f.internal.refreshPlanningNav('a')).toBe(first);expect(Object.isFrozen(source)).toBe(false);expect(Object.isFrozen(obstacle)).toBe(false);
      // Keep the ARRAY identity while replacing its entry. The legacy diff map
      // aliases entries, so an in-place object mutation is not this contract.
      source[0]={...obstacle,xMm:24000};referenceSource[0]={...source[0]};const moved=f.internal.refreshPlanningNav('a');expect(moved).not.toBe(first);expect(moved.obstacles[0]!.xMm).toBe(24000);expect(first.obstacles).toEqual(snapshot);expect(f.internal.planningGeometries()[0]!.revision).toBe(revision+1);expect(invalidate).toHaveBeenCalledTimes(1);compareLegacy(moved);
      const second={...obstacle,id:'second_override',zMm:25000};source.push(second);referenceSource.push({...second});const added=f.internal.refreshPlanningNav('a');expect(added.obstacles).toHaveLength(2);expect(added).not.toBe(moved);compareLegacy(added);
      source.splice(0,1);referenceSource.splice(0,1);const removed=f.internal.refreshPlanningNav('a');expect(removed.obstacles.map(item=>item.id)).toEqual(['second_override']);compareLegacy(removed);
    }finally{invalidate.mockRestore();legacyInvalidate.mockRestore();}
  });

  it('retains combined static rosters only for the same ordered live and hidden-memory references',()=>{
    const sim=createSimulation({factions,seed:'retained-known-roster',matchId:'retained-known-roster',controllers:false,sharedVision:false}),own=gate(),visibleNode=resource('visible'),hiddenOne={...resource('hidden_one'),xMm:40000},hiddenTwo={...resource('hidden_two'),xMm:50000};
    type RosterInternals={knownStatic(playerId:string):Entity[];visible(playerId:string,point:Position):boolean;movementFrame:(LegacyKnowledgeFrame&{staticIndexed:boolean})|undefined;perceptionMembership:{statics(key:string,ownerId:string):readonly Entity[]}};
    const internal=sim as unknown as RosterInternals,memory=sim.state.vision.a!.memory;
    for(const key of Object.keys(memory))delete memory[key];
    let members:Entity[]=[own,visibleNode];internal.perceptionMembership.statics=()=>members;internal.visible=(_playerId,point)=>point.xMm<25000;
    const remember=(key:string,entity:Entity)=>{memory[key]=entity as unknown as (typeof memory)[string];};
    const phase=()=>{
      internal.movementFrame={entities:members,knownStatic:new Map(),planning:new Map(),staticIndexed:true};
      const current=[...members],ids=new Set(current.map(entity=>entity.id));for(const observation of Object.values(memory))if(!ids.has(observation.id)&&!internal.visible('a',observation))current.push(observation as Entity);
      const actual=internal.knownStatic('a');expect(actual).toEqual(current);current.forEach((entity,index)=>expect(actual[index]).toBe(entity));expect(internal.knownStatic('a')).toBe(actual);return actual;
    };
    remember('one',hiddenOne);remember('two',hiddenTwo);const initial=phase(),initialRefs=[...initial];expect(phase()).toBe(initial);
    const replacement={...hiddenOne};remember('one',replacement);const replaced=phase();expect(replaced).not.toBe(initial);expect(replaced[2]).toBe(replacement);expect(initial).toEqual(initialRefs);expect(initial[2]).toBe(hiddenOne);
    delete memory.one;remember('one',replacement);const reordered=phase();expect(reordered.slice(2)).toEqual([hiddenTwo,replacement]);expect(reordered).not.toBe(replaced);expect(phase()).toBe(reordered);
    // Current IDs suppress memories; remembered duplicate IDs must not suppress
    // each other, including two keys containing the exact same object.
    remember('owned_alias',{...own,xMm:60000});remember('duplicate',replacement);remember('duplicate_copy',{...replacement});const duplicates=phase();expect(duplicates.filter(entity=>entity.id===replacement.id)).toHaveLength(3);expect(duplicates[3]).toBe(duplicates[4]);expect(duplicates.filter(entity=>entity.id===own.id)).toHaveLength(1);
    replacement.xMm=20000;const observed=phase();expect(observed.filter(entity=>entity===replacement)).toHaveLength(0);expect(observed.filter(entity=>entity.id===replacement.id)).toHaveLength(1);
    delete memory.duplicate_copy;const removed=phase();expect(removed.slice(2)).toEqual([hiddenTwo]);expect(phase()).toBe(removed);
    const newVisible={...visibleNode,amount:4321};members=[newVisible,own];const replacedMember=phase();expect(replacedMember[0]).toBe(newVisible);expect(replacedMember[1]).toBe(own);expect(replacedMember).not.toBe(removed);
    for(const key of Object.keys(memory))delete memory[key];expect(phase()).toEqual(members);internal.movementFrame=undefined;
  });

  it('reuses unchanged source geometry and replaces resources on depletion, bound-kind and direct fixture mutation',()=>{
    const node=resource(),f=fixture([node]),first=f.entities()[0]!;
    expect(f.actual()).toEqual(f.expected());expect(Object.isFrozen(first)).toBe(true);
    node.amount--;expect(f.entities()[0]).toBe(first);
    node.resource='gold';const gold=f.entities()[0]!;expect(gold).not.toBe(first);expect(gold.halfWidth).toBe(650);expect(first.halfWidth).toBe(450);
    node.resource='stone';expect(f.entities()[0]).toBe(gold);
    node.amount=0;expect(f.entities()).toEqual([]);expect(f.actual()).toEqual(f.expected());
    node.amount=50;const renewed=f.entities()[0]!;expect(renewed).not.toBe(gold);
    node.xMm+=4000;const moved=f.entities()[0]!;expect(moved).not.toBe(renewed);expect(renewed.xMm).toBe(20000);expect(moved.xMm).toBe(24000);
    // Public mutable fixtures may replace a record without bumping navigationRevision.
    f.setRoster([{...node,zMm:27000}]);expect(f.actual()).toEqual(f.expected());expect(f.entities()[0]!.zMm).toBe(27000);
  });

  it('retains worker geometry descriptors only after exact profile reconciliation and preserves prior snapshots',()=>{
    const node=resource(),building=gate(),f=fixture([node,building]);f.internal.refreshPlanningNav('a');
    const first=f.internal.planningGeometries(),initial=structuredClone(first),navigationRevision=f.sim.state.navigationRevision;
    expect(f.internal.planningGeometries()[0]).toBe(first[0]);expect(Object.isFrozen(first[0]!.obstacles)).toBe(true);
    node.amount--;f.internal.refreshPlanningNav('a');expect(f.internal.planningGeometries()[0]).toBe(first[0]);
    // Completion changes AUTO planning passage without a global revision bump.
    building.work--;f.internal.refreshPlanningNav('a');const incomplete=f.internal.planningGeometries();
    expect(f.sim.state.navigationRevision).toBe(navigationRevision);expect(incomplete[0]).not.toBe(first[0]);expect(incomplete[0]!.revision).toBeGreaterThan(first[0]!.revision);expect(incomplete[0]!.obstacles.filter(obstacle=>obstacle.id===building.id)).toHaveLength(1);expect(first).toEqual(initial);
    expect(incomplete[1]).toBe(first[1]);building.work++;f.internal.refreshPlanningNav('a');const completed=f.internal.planningGeometries();expect(completed[0]!.obstacles.filter(obstacle=>obstacle.id===building.id)).toHaveLength(2);
    node.amount=0;f.internal.refreshPlanningNav('a');const depleted=f.internal.planningGeometries();expect(depleted[0]).not.toBe(completed[0]);expect(depleted[0]!.obstacles.some(obstacle=>obstacle.id===node.id)).toBe(false);
    const width=f.sim.state.widthMm;f.sim.state.widthMm+=2000;const resized=f.internal.planningGeometries();expect(resized[0]).not.toBe(depleted[0]);expect(resized[0]!.revision).toBe(depleted[0]!.revision);expect(resized[0]!.widthMm).toBe(width+2000);expect(depleted[0]!.widthMm).toBe(width);
  });

  it('matches gate type, rotation, physical opening, mode, exact completion, defeat and team inputs',()=>{
    const building=gate(),f=fixture([building]);
    for(const typeId of ['wooden_gate','stone_gate'] as const)for(const rotation of [0,90,180,270] as const)for(const gateMode of ['AUTO','LOCKED','OPEN'] as const)for(const gateOpen of [false,true])for(const incomplete of [false,true])for(const defeated of [false,true]){
      Object.assign(building,{typeId,rotation,gateMode,gateOpen,work:incomplete?99:100});f.sim.state.economies.a!.defeated=defeated;
      for(const sameTeam of [false,true]){
        f.sim.state.factions.find(player=>player.id==='b')!.teamId=sameTeam?'a':'b';
        for(const playerId of ['a','b']){expect(f.actual(playerId)).toEqual(f.expected(playerId));const first=f.entities(playerId);expect(f.entities(playerId)).toEqual(first);for(let i=0;i<first.length;i++)expect(f.entities(playerId)[i]).toBe(first[i]);}
      }
    }
    Object.assign(building,{typeId:'wooden_gate',rotation:0,gateMode:'AUTO',gateOpen:false,work:100});f.sim.state.economies.a!.defeated=false;
    const before=f.entities();expect(before).toHaveLength(2);expect(before[0]).not.toBe(before[1]);expect(before[0]!.id).toBe(before[1]!.id);
    building.gateMode='LOCKED';expect(f.entities()).toHaveLength(1);expect(f.actual()).toEqual(f.expected());expect(before[0]!.xMm).toBeLessThan(before[1]!.xMm);
    building.gateMode='AUTO';building.rotation=90;const vertical=f.entities();expect(vertical[0]!.zMm).toBeLessThan(vertical[1]!.zMm);expect(vertical[0]!.xMm).toBe(vertical[1]!.xMm);
  });

  it('reuses recreated authorized memory without reading hidden live geometry or inventing completion',()=>{
    const live=gate();live.ownerId='b';const f=fixture([]);f.sim.state.entities[live.id]=live;
    // The authorized memory has no private work/required/gateMode. Preserve the
    // existing undefined < undefined result rather than deriving from progress.
    const memory={id:live.id,kind:'building',typeId:live.typeId,ownerId:'b',xMm:30000,zMm:31000,rotation:90,hp:100,maxHp:100,progress:.1,gateOpen:true} as unknown as Entity;
    f.setRoster([memory]);const remembered=f.entities();expect(remembered).toHaveLength(2);expect(f.actual()).toEqual(f.expected());
    for(const gateMode of ['LOCKED','AUTO','OPEN'] as const){Object.assign(live,{gateMode,xMm:57000,zMm:59000,rotation:0,work:1,gateOpen:false});f.setRoster([{...memory}]);expect(f.actual()).toEqual(f.expected());for(let i=0;i<remembered.length;i++)expect(f.entities()[i]).toBe(remembered[i]);}
    // A live observation replaces memory only when it is in the current roster.
    f.setRoster([live]);expect(f.actual()).toEqual(f.expected());expect(f.entities()[0]!.xMm).toBe(57000);
    f.setRoster([{...memory}]);expect(f.actual()).toEqual(f.expected());expect(f.entities()).toEqual(remembered);
  });

  it('retains old bounds for invalidation and prunes disappearing IDs without changing source order',()=>{
    const first=resource('first'),second={...resource('second'),xMm:26000},f=fixture([first,second]);
    f.internal.refreshPlanningNav('a');const before=f.entities(),invalidate=vi.spyOn(f.internal.pathScheduler,'invalidate');
    try{
      first.xMm+=4000;f.internal.refreshPlanningNav('a');expect(invalidate).toHaveBeenCalled();
      const regions=invalidate.mock.calls.at(-1)![1];expect(regions).toContainEqual({xMm:19550,zMm:19550,widthMm:900,depthMm:900});expect(regions).toContainEqual({xMm:23550,zMm:19550,widthMm:900,depthMm:900});expect(before[0]!.xMm).toBe(20000);
      f.setRoster([second,first]);expect(f.entities().map(obstacle=>obstacle.id)).toEqual(['second','first']);expect(f.actual()).toEqual(f.expected());
      f.setRoster([second]);f.actual();expect(f.internal.knownObstacleRecords.get('a')!.records.has('first')).toBe(false);
      f.setRoster([]);f.actual();expect(f.internal.knownObstacleRecords.get('a')!.records.size).toBe(0);
    }finally{invalidate.mockRestore();}
  });

  it('keeps duplicate source occurrences distinct with exact generic collision charges',()=>{
    const node=resource(),f=fixture([node,node]);const actual=f.entities();expect(actual).toHaveLength(2);expect(actual[0]).not.toBe(actual[1]);
    const left={remaining:0,used:0},right={remaining:0,used:0},a=new Navigation(64000,64000,f.actual(),30000,1000,left),b=new Navigation(64000,64000,f.expected(),30000,1000,right);
    for(const remaining of [0,1,2,3,10,100])expect(evaluate(a,left,remaining,7,nav=>nav.free({xMm:23000,zMm:20000},350))).toEqual(evaluate(b,right,remaining,7,nav=>nav.free({xMm:23000,zMm:20000},350)));
    f.setRoster([node,{...node,xMm:24000}]);expect(f.actual()).toEqual(f.expected());expect(f.entities().map(obstacle=>obstacle.xMm)).toEqual([20000,24000]);
  });

  it('bounds retained records while emitting overflow geometry and pruning to the current roster',()=>{
    const roster=Array.from({length:staticRecordLimit+1},(_,i)=>({...resource('bounded_'+i),xMm:10000+i%128*1000,zMm:10000+Math.floor(i/128)*1000})),f=fixture(roster);
    // Avoid fixture.entities(), whose deliberate small-fixture ID membership check is quadratic.
    expect(f.actual().filter(obstacle=>obstacle.id.startsWith('bounded_'))).toHaveLength(roster.length);
    expect(f.internal.knownObstacleRecords.get('a')!.records.size).toBe(staticRecordLimit);
    const survivor=roster.at(-1)!;f.setRoster([survivor]);expect(f.actual()).toEqual(f.expected());expect(f.internal.knownObstacleRecords.get('a')!.records.size).toBeLessThanOrEqual(1);
    f.actual();expect(f.internal.knownObstacleRecords.get('a')!.records.size).toBe(1);
    f.setRoster([]);f.actual();expect(f.internal.knownObstacleRecords.get('a')!.records.size).toBe(0);
  });
});

describe('common live obstacles within movement preparation',()=>{
  type Internals=LegacyNavigationInternals&{prepareMovement():void;visibilityMasks:Map<string,Uint8Array>;movementObstaclePreparation:Map<Entity,unknown>|undefined;movementDependencyPreparation:{preparedCount:number;complete:boolean;created:Set<Entity>}|undefined;movementObstacleSources:Map<Entity,{subscribers:Set<string>}>;movementObstacleCertificates:Map<string,unknown>;knownObstacleRecords:Map<string,{records:Map<string,{seen:boolean;obstacles:Obstacle[]}>}>};
  function fixture(){
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'allies',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'allies',color:'#33ff88',kind:'human'},{id:'c',name:'C',teamId:'enemy',color:'#ff8844',kind:'human'}];
    const sim=createSimulation({factions,seed:'common-movement-obstacles',matchId:'common-movement-obstacles',controllers:false,sharedVision:false});
    const node:ResourceNode={id:'common_gold',kind:'resource',typeId:'gold_mine',resource:'gold',ownerId:null,xMm:20000,zMm:20000,hp:1,maxHp:1,amount:100000};
    const gate:Building={id:'common_gate',kind:'building',typeId:'wooden_gate',ownerId:'a',xMm:26000,zMm:20000,rotation:0,hp:100,maxHp:100,work:100,required:100,grantedHp:100,queue:[],cooldown:0,gateMode:'AUTO',gateOpen:false};
    const hidden={...node,id:'hidden_gold',xMm:90000};
    sim.state.entities={[node.id]:node,[gate.id]:gate,[hidden.id]:hidden};sim.state.map.terrain=[];
    const internal=sim as unknown as Internals,fogMm=balance.rules.fogGridM*1000,width=Math.floor(sim.state.widthMm/fogMm),height=Math.floor(sim.state.heightMm/fogMm);
    for(const id of ['a','b','c']){
      const mask=new Uint8Array(width*height);
      for(let z=0;z<40000/fogMm;z++)for(let x=0;x<40000/fogMm;x++)mask[z*width+x]=1;
      if(id==='c')for(let z=18000/fogMm;z<22000/fogMm;z++)for(let x=88000/fogMm;x<92000/fogMm;x++)mask[z*width+x]=1;
      internal.visibilityMasks.set(id,mask);sim.state.vision[id]!.memory={};
    }
    const phase=()=>{internal.prepareMovement();expect(internal.movementObstaclePreparation).toBeUndefined();expect(internal.movementDependencyPreparation).toBeUndefined();return new Map([...internal.planningNavigations].map(([id,profile])=>[id,profile.navigation.obstacles]));};
    const compare=(actual:Map<string,Obstacle[]>)=>{for(const id of ['a','b','c'])expect(actual.get(id)).toEqual(internal.knownStatic(id).flatMap(entity=>internal.entityObstacles(entity,id)));internal.movementFrame=undefined;};
    return {sim,internal,node,gate,hidden,phase,compare};
  }

  it('fuses bounded native row transitions while keeping hidden memory detached from a changing live source',()=>{
    const f=fixture(),reference=fixture(),internal=f.internal as unknown as {liveOwned:boolean;invalidateEntityRoster(staticChanged:boolean):void;liveDepletedResources:Set<ResourceNode>;movementObstacleCertificates:Map<string,{rows:Map<string,{entity:Entity;record:unknown;source?:unknown;geometry?:unknown}>}>};
    installLegacyNavigation(reference.sim);
    const phase=()=>{const actual=f.phase();expect(actual).toEqual(reference.phase());f.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;return actual;};
    // Exercise the private reconciliation owner directly so derived row identity
    // is observable. Real facade command/save parity is covered independently.
    internal.liveOwned=true;internal.invalidateEntityRoster(true);phase();
    const rows=internal.movementObstacleCertificates.get('a')!.rows,unchanged=rows.get(f.node.id)!,source=f.internal.movementObstacleSources.get(f.node)!;
    const added={...f.node,id:'native_added',xMm:32000};f.sim.state.entities[added.id]=added;reference.sim.state.entities[added.id]={...added};internal.invalidateEntityRoster(true);phase();
    expect(internal.movementObstacleCertificates.get('a')!.rows).toBe(rows);expect(rows.get(f.node.id)).toBe(unchanged);expect(rows.has(added.id)).toBe(true);
    const visible=f.internal.visibilityMasks.get('a')!.slice(),hidden=visible.slice(),fogMm=balance.rules.fogGridM*1000,columns=Math.floor(f.sim.state.widthMm/fogMm);
    const conceal=(mask:Uint8Array)=>{for(let z=18000/fogMm;z<22000/fogMm;z++)for(let x=18000/fogMm;x<22000/fogMm;x++)mask[z*columns+x]=0;};
    conceal(hidden);for(const item of [f,reference]){item.sim.state.vision.a!.memory[item.node.id]={...item.node,amount:100,lastSeenTick:item.sim.state.tick};item.internal.visibilityMasks.set('a',hidden.slice());}phase();
    expect(internal.movementObstacleCertificates.get('a')!.rows).toBe(rows);expect(rows.get(f.node.id)!.source).toBeUndefined();expect(source.subscribers).toEqual(new Set(['b','c']));
    const remembered=rows.get(f.node.id)!,otherRows=internal.movementObstacleCertificates.get('b')!.rows,previousGeometry=otherRows.get(f.node.id)!.geometry;
    f.node.amount=0;reference.node.amount=0;internal.liveDepletedResources.add(f.node);f.sim.state.navigationRevision++;reference.sim.state.navigationRevision++;
    const depleted=phase();expect(depleted.get('a')!.some(obstacle=>obstacle.id===f.node.id)).toBe(true);expect(depleted.get('b')!.some(obstacle=>obstacle.id===f.node.id)).toBe(false);
    expect(rows.get(f.node.id)).toBe(remembered);expect(internal.movementObstacleCertificates.get('b')!.rows).toBe(otherRows);expect(otherRows.get(f.node.id)!.source).toBe(source);expect(otherRows.get(f.node.id)!.geometry).not.toBe(previousGeometry);
    for(const item of [f,reference])item.internal.visibilityMasks.set('a',visible.slice());const revealed=phase();expect(revealed.get('a')!.some(obstacle=>obstacle.id===f.node.id)).toBe(false);
    expect(rows.get(f.node.id)!.source).toBe(source);expect(source.subscribers).toEqual(new Set(['b','c','a']));
    for(const item of [f,reference])for(const id of ['a','b','c']){delete item.sim.state.vision[id]!.memory[item.node.id];const mask=item.internal.visibilityMasks.get(id)!.slice();conceal(mask);item.internal.visibilityMasks.set(id,mask);}
    phase();expect(f.internal.movementObstacleSources.has(f.node)).toBe(false);expect(rows.has(f.node.id)).toBe(false);
  });

  it('checks only mutable native local geometry while hidden resources retain exact reveal and replacement behavior',()=>{
    const candidate=fixture(),reference=fixture(),internal=candidate.internal as unknown as {liveOwned:boolean;invalidateEntityRoster(staticChanged:boolean):void;movementObstacleCertificates:Map<string,{local:{id:string}[];localChecks?:{id:string}[]}>};
    installLegacyNavigation(reference.sim);
    for(const item of [candidate,reference])for(let index=0;index<128;index++){
      const resource={...item.node,id:`remembered_${index}`,xMm:100000+(index%8)*1500,zMm:100000+Math.floor(index/8)*1500};item.sim.state.entities[resource.id]=resource;
      for(const id of ['a','b','c'])item.sim.state.vision[id]!.memory[resource.id]={...resource,amount:100,lastSeenTick:0};
    }
    internal.liveOwned=true;internal.invalidateEntityRoster(true);
    const phase=()=>{const actual=candidate.phase();expect(actual).toEqual(reference.phase());candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;return actual;};phase();
    const certificate=internal.movementObstacleCertificates.get('a')!;expect(certificate.local.filter(row=>row.id.startsWith('remembered_'))).toHaveLength(128);expect(certificate.localChecks!.some(row=>row.id.startsWith('remembered_'))).toBe(false);expect(certificate.localChecks!.some(row=>row.id===candidate.gate.id)).toBe(true);
    const records=candidate.internal.knownObstacleRecords.get('a')!.records,lookup=vi.spyOn(records,'get');
    try{
      phase();expect(lookup.mock.calls.some(([id])=>id.startsWith('remembered_'))).toBe(false);lookup.mockClear();
      // Hidden depletion cannot alter the last observed barrier geometry.
      for(const item of [candidate,reference]){(item.sim.state.entities.remembered_0 as ResourceNode).amount=0;item.sim.state.navigationRevision++;}
      const hidden=phase();expect(hidden.get('a')!.some(obstacle=>obstacle.id==='remembered_0')).toBe(true);expect(lookup.mock.calls.some(([id])=>id==='remembered_0')).toBe(false);
      // Native gate policy remains mutable and must still be checked now.
      for(const item of [candidate,reference]){item.gate.gateMode='LOCKED';item.gate.gateOpen=false;item.sim.state.navigationRevision++;}phase();
      // Newly visible resources replace the known roster; the exhausted one
      // disappears, while other resources use current authorized geometry.
      const original=candidate.internal.visibilityMasks.get('a')!.slice();for(const item of [candidate,reference]){const mask=original.slice();mask.fill(1);item.internal.visibilityMasks.set('a',mask);}
      const revealed=phase();expect(revealed.get('a')!.some(obstacle=>obstacle.id==='remembered_0')).toBe(false);
      for(const item of [candidate,reference]){const resource=item.sim.state.entities.remembered_0 as ResourceNode;item.sim.state.vision.a!.memory[resource.id]={...resource,amount:0,lastSeenTick:1};item.internal.visibilityMasks.set('a',original.slice());}
      const concealed=phase();expect(concealed.get('a')!.some(obstacle=>obstacle.id==='remembered_0')).toBe(false);
      // Mutable public fixtures keep scalar reads even with an unchanged tick,
      // roster and navigation revision; this path has no native certificate.
      const scalar=fixture(),memory={...scalar.hidden,id:'mutable_memory',xMm:100000,zMm:100000,amount:100,lastSeenTick:0};scalar.sim.state.vision.a!.memory[memory.id]=memory;
      scalar.compare(scalar.phase());memory.amount=0;expect(scalar.phase().get('a')!.some(obstacle=>obstacle.id===memory.id)).toBe(false);scalar.internal.movementFrame=undefined;
    }finally{lookup.mockRestore();candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
  });

  it('avoids full navigation Map comparison for native live-memory reorderings but invalidates changed geometry and policy',()=>{
    const f=fixture(),reference=fixture(),internal=f.internal as unknown as {liveOwned:boolean;invalidateEntityRoster(staticChanged:boolean):void;liveDepletedResources:Set<ResourceNode>};
    installLegacyNavigation(reference.sim);
    for(const item of [f,reference])for(let index=0;index<128;index++){
      const node={...item.node,id:`stable_geometry_${index}`,xMm:24000+(index%8)*1500,zMm:24000+Math.floor(index/8)*700};item.sim.state.entities[node.id]=node;
    }
    internal.liveOwned=true;internal.invalidateEntityRoster(true);
    const phase=()=>{const actual=f.phase();expect(actual).toEqual(reference.phase());f.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;};phase();
    const profile=f.internal.planningNavigations.get('a')!,lookup=vi.spyOn(profile.obstacles,'get'),visible=f.internal.visibilityMasks.get('a')!.slice(),hidden=visible.slice(),fogMm=balance.rules.fogGridM*1000,columns=Math.floor(f.sim.state.widthMm/fogMm);
    for(let z=18000/fogMm;z<22000/fogMm;z++)for(let x=18000/fogMm;x<22000/fogMm;x++)hidden[z*columns+x]=0;
    try{
      for(const item of [f,reference]){item.sim.state.vision.a!.memory[item.node.id]={...item.node,amount:100,lastSeenTick:item.sim.state.tick};item.internal.visibilityMasks.set('a',hidden.slice());}
      phase();expect(f.internal.planningNavigations.get('a')).toBe(profile);expect(lookup).not.toHaveBeenCalled();
      // Concealed depletion is not new recipient knowledge and must not change
      // that faction's navigation, even while visible factions lose the shape.
      f.node.amount=0;reference.node.amount=0;internal.liveDepletedResources.add(f.node);f.sim.state.navigationRevision++;reference.sim.state.navigationRevision++;phase();
      expect(f.internal.planningNavigations.get('a')).toBe(profile);expect(lookup).not.toHaveBeenCalled();
      for(const item of [f,reference])item.internal.visibilityMasks.set('a',visible.slice());phase();
      expect(lookup).toHaveBeenCalled();expect(f.internal.planningNavigations.get('a')!.revision).toBe(profile.revision+1);expect(f.internal.planningNavigations.get('a')!.navigation.obstacles.some(obstacle=>obstacle.id===f.node.id)).toBe(false);
      const gateRevision=f.internal.planningNavigations.get('a')!.revision;
      for(const item of [f,reference])item.gate.gateMode='LOCKED';phase();expect(f.internal.planningNavigations.get('a')!.revision).toBe(gateRevision+1);
      // Revoked/public ownership cannot reuse a private geometry identity for
      // direct fixture edits without a revision notification.
      internal.liveOwned=false;for(const item of [f,reference])item.sim.state.entities.stable_geometry_0!.xMm+=1000;phase();
      expect(f.internal.planningNavigations.get('a')!.revision).toBe(gateRevision+2);
    }finally{lookup.mockRestore();}
  });

  it('reconciles every native source after the bounded row transition set overflows',()=>{
    const f=fixture(),internal=f.internal as unknown as {liveOwned:boolean;invalidateEntityRoster(staticChanged:boolean):void;movementObstacleCertificates:Map<string,{rows:Map<string,unknown>}>};
    internal.liveOwned=true;internal.invalidateEntityRoster(true);f.compare(f.phase());const rows=internal.movementObstacleCertificates.get('a')!.rows,retained=f.internal.movementObstacleSources.get(f.node)!;
    for(let index=0;index<257;index++){const node={...f.node,id:`native_batch_${index}`,xMm:10000+(index%16)*1000,zMm:10000+Math.floor(index/16)*1000};f.sim.state.entities[node.id]=node;}
    internal.invalidateEntityRoster(true);const result=f.phase();f.compare(result);
    const current=internal.movementObstacleCertificates.get('a')!.rows;expect(current).not.toBe(rows);expect(current.size).toBe(259);expect(result.get('a')!.filter(obstacle=>obstacle.id.startsWith('native_batch_'))).toHaveLength(257);
    expect(f.internal.movementObstacleSources.get(f.node)).toBe(retained);expect(retained.subscribers).toEqual(new Set(['a','b','c']));
  });

  it('reads a shared live resource once per phase and preserves same-tick mutable work and admission reads',()=>{
    const f=fixture();let amount=f.node.amount,reads=0;
    Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,get(){reads++;return amount;},set(value:number){amount=value;}});
    try{
      const first=f.phase(),obstacles=['a','b','c'].map(id=>f.internal.knownObstacleRecords.get(id)!.records.get(f.node.id)!.obstacles);
      // Each Navigation owns a detached copy; preparation shares its immutable
      // source payload before that ownership boundary.
      expect(obstacles[0]).toHaveLength(1);expect(obstacles[1]).toBe(obstacles[0]);expect(obstacles[2]).toBe(obstacles[0]);expect(Object.isFrozen(obstacles[0])).toBe(true);expect(Object.isFrozen(obstacles[0]![0])).toBe(true);f.compare(first);
      reads=0;const retained=f.phase();expect(reads).toBe(1);f.compare(retained);
      // Preparation's scope must already be gone, even while its movement frame
      // remains alive. A same-tick mutable query sees depletion immediately.
      f.phase();amount=0;
      expect(f.internal.knownObstacles('b').some(obstacle=>obstacle.id===f.node.id)).toBe(false);f.internal.movementFrame=undefined;
      f.internal.workFrame={knowledge:{entities:Object.values(f.sim.state.entities),knownStatic:new Map()}};
      amount=100000;expect(f.internal.admissionNav('b').obstacles.some(obstacle=>obstacle.id===f.node.id)).toBe(true);
      amount=0;expect(f.internal.admissionNav('b').obstacles.some(obstacle=>obstacle.id===f.node.id)).toBe(false);
      f.gate.gateMode='LOCKED';expect(f.internal.admissionNav('b').obstacles.filter(obstacle=>obstacle.id===f.gate.id)).toHaveLength(1);
      f.gate.gateMode='AUTO';expect(f.internal.admissionNav('b').obstacles.filter(obstacle=>obstacle.id===f.gate.id)).toHaveLength(2);
      expect(f.sim.state.tick).toBe(0);
    }finally{Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,writable:true,value:amount});f.internal.movementFrame=undefined;f.internal.workFrame=undefined;}
  });

  it('keeps detached same-ID memories and gate authority separate from shared live fields',()=>{
    const f=fixture(),remember=(id:string,xMm:number)=>{f.sim.state.vision[id]!.memory.observation={...f.hidden,xMm,amount:100000} as unknown as (typeof f.sim.state.vision)[string]['memory'][string];};
    remember('a',70000);remember('b',80000);
    const first=f.phase();expect(first.get('a')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(70000);expect(first.get('b')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(80000);expect(first.get('c')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(90000);f.compare(first);
    for(const [mode,open,work,defeated,counts]of [
      ['AUTO',false,100,false,[2,2,1]],['AUTO',false,99,false,[1,1,1]],['AUTO',false,100,true,[1,1,1]],
      ['LOCKED',false,100,false,[1,1,1]],['OPEN',true,100,false,[2,2,2]],
    ] as const){
      Object.assign(f.gate,{gateMode:mode,gateOpen:open,work});f.sim.state.economies.a!.defeated=defeated;
      const result=f.phase();expect(['a','b','c'].map(id=>result.get(id)!.filter(obstacle=>obstacle.id===f.gate.id).length)).toEqual(counts);f.compare(result);
    }
    f.hidden.amount=0;const depleted=f.phase();expect(depleted.get('c')!.some(obstacle=>obstacle.id===f.hidden.id)).toBe(false);
    expect(depleted.get('a')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(70000);expect(depleted.get('b')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(80000);f.compare(depleted);
    remember('a',75000);f.sim.state.vision.b!.memory.observation!.amount=0;
    const changed=f.phase();expect(changed.get('a')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(75000);expect(changed.get('b')!.some(obstacle=>obstacle.id===f.hidden.id)).toBe(false);f.compare(changed);
  });

  it('preserves duplicate live occurrences and releases preparation ownership after an exception',()=>{
    const f=fixture();f.sim.state.entities.alias=f.node;
    const result=f.phase();for(const id of ['a','b','c']){const duplicates=result.get(id)!.filter(obstacle=>obstacle.id===f.node.id);expect(duplicates).toHaveLength(2);expect(duplicates[0]).not.toBe(duplicates[1]);}f.compare(result);
    expect(f.internal.movementObstacleCertificates.size).toBe(0);expect(f.internal.movementObstacleSources.size).toBe(0);
    const original=f.internal.refreshPlanningNav,failed=vi.spyOn(f.internal,'refreshPlanningNav').mockImplementation(playerId=>{const value=original.call(f.internal,playerId);if(playerId==='b')throw new Error('test preparation failure');return value;});
    try{expect(()=>f.internal.prepareMovement()).toThrow('test preparation failure');expect(f.internal.movementObstaclePreparation).toBeUndefined();}
    finally{failed.mockRestore();f.internal.movementFrame=undefined;}
    f.node.amount=0;expect(f.internal.knownObstacles('a').some(obstacle=>obstacle.id===f.node.id)).toBe(false);f.compare(f.phase());
    delete f.sim.state.entities.alias;f.compare(f.phase());expect(f.internal.movementObstacleCertificates.size).toBe(3);
  });

  it('preserves new duplicate occurrences when one profile record cache is full and another can share',()=>{
    const f=fixture();f.compare(f.phase());
    const records=f.internal.knownObstacleRecords.get('a')!.records,prior=records.get(f.node.id)!;
    for(let index=0;records.size<staticRecordLimit;index++)records.set(`retired_${index}`,{...prior});
    const added={...f.node,id:'new_overflow_source',xMm:32000};
    f.sim.state.entities[added.id]=added;f.sim.state.entities.overflow_alias=added;
    const actual=f.phase();
    expect(records.has(added.id)).toBe(false);expect(f.internal.knownObstacleRecords.get('b')!.records.has(added.id)).toBe(true);
    expect(f.internal.movementObstacleCertificates.size).toBe(0);expect(f.internal.movementObstacleSources.size).toBe(0);
    for(const id of ['a','b']){
      const obstacles=actual.get(id)!,duplicates=obstacles.filter(obstacle=>obstacle.id===added.id);
      expect(duplicates).toHaveLength(2);expect(duplicates[0]).not.toBe(duplicates[1]);
      const expected=f.internal.knownStatic(id).flatMap(entity=>f.internal.entityObstacles(entity,id));expect(obstacles).toEqual(expected);
      const left={remaining:0,used:0},right={remaining:0,used:0},owned=new Navigation(f.sim.state.widthMm,f.sim.state.heightMm,obstacles,30000,1000,left),reference=new Navigation(f.sim.state.widthMm,f.sim.state.heightMm,expected,30000,1000,right);
      for(const remaining of [0,1,2,3,10,100])expect(evaluate(owned,left,remaining,7,nav=>nav.free({xMm:35000,zMm:20000},350))).toEqual(evaluate(reference,right,remaining,7,nav=>nav.free({xMm:35000,zMm:20000},350)));
    }
    f.internal.movementFrame=undefined;
  });

  it('matches independent legacy preparation and invalidation after exact public dependency changes',()=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    for(const f of [candidate,reference])f.sim.state.entities.common_house={...f.gate,id:'common_house',typeId:'house',xMm:34000,zMm:24000};
    const compare=()=>{
      expect(candidate.phase()).toEqual(reference.phase());
      // Leave the candidate's mutation hooks canonical so this exercises its
      // dependency owner. Captures include exact region revisions/cursors;
      // the earlier scalar-diff test separately records invalidation call order.
      expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));
      expect(JSON.stringify(candidate.sim.views(['a','b','c']))).toBe(JSON.stringify(reference.sim.views(['a','b','c'])));
      candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;
    };
    const changes:((f:ReturnType<typeof fixture>)=>void)[]=[
      f=>{f.node.amount--;},
      f=>{f.node.xMm+=2000;},
      f=>{f.node.resource='wood';f.node.forest={cellMm:2000,patchId:'fixture_forest'};},
      f=>{f.node.forest!.cellMm=4000;},
      f=>{const house=f.sim.state.entities.common_house as Building;house.typeId='barracks';house.rotation=90;house.work--;},
      f=>{const house=f.sim.state.entities.common_house as Building;house.rotation=270;house.work++;},
      f=>{f.node.amount=0;},
      f=>{f.node.amount=100000;f.gate.work--;},
      f=>{f.gate.work++;f.sim.state.factions[1]!.teamId='enemy';},
      f=>{f.sim.state.economies.a!.defeated=true;},
      f=>{f.sim.state.economies.a!.defeated=false;f.gate.gateMode='OPEN';f.gate.gateOpen=true;f.gate.rotation=90;},
      f=>{f.sim.state.entities[f.node.id]={...f.node,xMm:32000};},
      f=>{const entities=f.sim.state.entities;f.sim.state.entities={[f.hidden.id]:entities[f.hidden.id]!,[f.gate.id]:entities[f.gate.id]!,[f.node.id]:entities[f.node.id]!};},
      f=>{f.sim.state.map.terrain=[{id:'dependency_ridge',kind:'cliff',xMm:40000,zMm:40000,widthMm:6000,depthMm:2000,elevationMm:2000}];},
      f=>{f.sim.state.map.terrain[0]!.widthMm=8000;},
      f=>{delete f.sim.state.entities[f.node.id];},
    ];
    try{compare();compare();for(const change of changes){change(candidate);change(reference);compare();compare();}}
    finally{candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
  });

  it('skips warm common occurrence lookup while still reconciling current source fields',()=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());
    const lookups=['a','b','c'].map(id=>vi.spyOn(f.internal.knownObstacleRecords.get(id)!.records,'get'));
    let amount=f.node.amount,reads=0;Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,get(){reads++;return amount;},set(value:number){amount=value;}});
    try{
      const first=f.phase();expect(reads).toBe(1);
      for(const lookup of lookups)expect(lookup.mock.calls.filter(([id])=>id===f.node.id)).toHaveLength(0);
      for(const lookup of lookups)lookup.mockClear();reads=0;amount--;
      const unchanged=f.phase();expect(reads).toBe(1);expect(unchanged).toEqual(first);
      for(const lookup of lookups)expect(lookup.mock.calls.filter(([id])=>id===f.node.id)).toHaveLength(0);
      amount=0;const depleted=f.phase();for(const id of ['a','b','c'])expect(depleted.get(id)!.some(obstacle=>obstacle.id===f.node.id)).toBe(false);
      f.compare(depleted);
    }finally{lookups.forEach(lookup=>lookup.mockRestore());Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,writable:true,value:amount});f.internal.movementFrame=undefined;}
  });

  it('keeps a warm preparation sparse and visits retained sources only for mandatory reconciliation',()=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    expect(candidate.phase()).toEqual(reference.phase());candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;
    const owner=candidate.internal.movementObstacleSources,values=vi.spyOn(owner,'values'),entries=vi.spyOn(owner,Symbol.iterator),original=candidate.internal.refreshPlanningNav;
    const observations:{playerId:string;prepared:number;temporary:number;created:number;complete:boolean}[]=[];
    const wrapper=(playerId:string)=>{const value=original.call(candidate.internal,playerId),active=candidate.internal.movementDependencyPreparation!;observations.push({playerId,prepared:active.preparedCount,temporary:candidate.internal.movementObstaclePreparation!.size,created:active.created.size,complete:active.complete});return value;};
    candidate.internal.refreshPlanningNav=wrapper;const dispose=candidate.sim.registerPlanningRefreshDiagnostic(original,wrapper)!;
    try{
      expect(candidate.phase()).toEqual(reference.phase());
      expect(observations).toEqual(['a','b','c'].map(playerId=>({playerId,prepared:2,temporary:0,created:0,complete:true})));
      expect(owner.size).toBe(2);expect(values).toHaveBeenCalledTimes(1);expect(entries).not.toHaveBeenCalled();
      expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));
      expect(JSON.stringify(candidate.sim.views(['a','b','c']))).toBe(JSON.stringify(reference.sim.views(['a','b','c'])));
    }finally{dispose();candidate.internal.refreshPlanningNav=original;values.mockRestore();entries.mockRestore();candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
  });

  it('hands prepared geometry to a later newly authorized profile without counting or reading it twice',()=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    for(const f of [candidate,reference]){
      const originalA=f.internal.visibilityMasks.get('a')!,originalC=f.internal.visibilityMasks.get('c')!;
      f.internal.visibilityMasks.set('a',originalC);f.internal.visibilityMasks.set('c',originalA);
      f.phase();f.internal.movementFrame=undefined;
      f.internal.visibilityMasks.set('a',originalA);f.internal.visibilityMasks.set('c',originalC);
    }
    let reads=0;const amount=candidate.hidden.amount;Object.defineProperty(candidate.hidden,'amount',{configurable:true,enumerable:true,get(){reads++;return amount;}});
    const original=candidate.internal.refreshPlanningNav,observations:{playerId:string;prepared:number;sparse:boolean;subscribers:string[]|undefined}[]=[];
    const wrapper=(playerId:string)=>{const value=original.call(candidate.internal,playerId);observations.push({playerId,prepared:candidate.internal.movementDependencyPreparation!.preparedCount,sparse:candidate.internal.movementObstaclePreparation!.has(candidate.hidden),subscribers:candidate.internal.movementObstacleSources.get(candidate.hidden)?[...candidate.internal.movementObstacleSources.get(candidate.hidden)!.subscribers]:undefined});return value;};
    candidate.internal.refreshPlanningNav=wrapper;const dispose=candidate.sim.registerPlanningRefreshDiagnostic(original,wrapper)!;
    try{
      expect(candidate.phase()).toEqual(reference.phase());expect(reads).toBe(1);
      expect(observations).toEqual([{playerId:'a',prepared:2,sparse:true,subscribers:undefined},{playerId:'b',prepared:2,sparse:true,subscribers:undefined},{playerId:'c',prepared:2,sparse:true,subscribers:['c']}]);
      expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));
    }finally{dispose();candidate.internal.refreshPlanningNav=original;Object.defineProperty(candidate.hidden,'amount',{configurable:true,enumerable:true,writable:true,value:amount});candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
  });

  it('counts the retained union toward the source bound even when its temporary map is empty',()=>{
    const f=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    const nodes=Array.from({length:staticRecordLimit},(_,index)=>({...f.node,id:`prepared_bound_${index}`}));
    f.sim.state.entities=Object.fromEntries(nodes.map(entity=>[entity.id,entity]));reference.sim.state.entities=structuredClone(f.sim.state.entities);
    expect(f.phase()).toEqual(reference.phase());f.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;
    expect(f.internal.movementObstacleSources.size).toBe(staticRecordLimit);
    const added={...f.node,id:'prepared_overflow',xMm:23000};f.sim.state.entities[added.id]=added;reference.sim.state.entities[added.id]=structuredClone(added);
    const original=f.internal.refreshPlanningNav,observations:{prepared:number;temporary:number;hasNew:boolean}[]=[];
    const wrapper=(playerId:string)=>{const value=original.call(f.internal,playerId);if(playerId==='a')observations.push({prepared:f.internal.movementDependencyPreparation!.preparedCount,temporary:f.internal.movementObstaclePreparation!.size,hasNew:f.internal.movementObstaclePreparation!.has(added)});return value;};
    f.internal.refreshPlanningNav=wrapper;const dispose=f.sim.registerPlanningRefreshDiagnostic(original,wrapper)!;
    try{
      const actual=f.phase(),expected=reference.phase();expect(actual).toEqual(expected);expect(actual.get('a')).toHaveLength(staticRecordLimit+1);
      expect(observations).toEqual([{prepared:staticRecordLimit,temporary:0,hasNew:false}]);
      expect(f.internal.movementObstacleCertificates.size).toBe(0);expect(f.internal.movementObstacleSources.size).toBe(0);
      const left={remaining:0,used:0},right={remaining:0,used:0},owned=new Navigation(f.sim.state.widthMm,f.sim.state.heightMm,actual.get('a')!,30000,1000,left),scalar=new Navigation(reference.sim.state.widthMm,reference.sim.state.heightMm,expected.get('a')!,30000,1000,right);
      for(const allowance of [0,1,2,17,staticRecordLimit,staticRecordLimit+1,staticRecordLimit+1000])expect(evaluate(owned,left,allowance,7,nav=>nav.free({xMm:21600,zMm:20000},350))).toEqual(evaluate(scalar,right,allowance,7,nav=>nav.free({xMm:21600,zMm:20000},350)));
    }finally{dispose();f.internal.refreshPlanningNav=original;f.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
  },30000);

  it.each([false,true])('cleans a partially certified orphan and preserves exact retry behavior (late failure=%s)',fail=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    for(const f of [candidate,reference]){
      f.phase();f.internal.movementFrame=undefined;
      const added={...f.node,id:'newly_authorized',xMm:50000};f.sim.state.entities[added.id]=added;
      const fogMm=balance.rules.fogGridM*1000,columns=Math.floor(f.sim.state.widthMm/fogMm),mask=f.internal.visibilityMasks.get('a')!.slice();mask[Math.floor(added.zMm/fogMm)*columns+Math.floor(added.xMm/fogMm)]=1;f.internal.visibilityMasks.set('a',mask);
      const ghost={...f.hidden,id:'duplicate_memory',xMm:70000};f.sim.state.vision.a!.memory.first=ghost as unknown as (typeof f.sim.state.vision)[string]['memory'][string];f.sim.state.vision.a!.memory.second={...ghost,xMm:80000} as unknown as (typeof f.sim.state.vision)[string]['memory'][string];
    }
    const added=candidate.sim.state.entities.newly_authorized!,original=candidate.internal.refreshPlanningNav,oldReference=reference.internal.refreshPlanningNav;let sawOrphan=false;
    const wrapper=(playerId:string)=>{const value=original.call(candidate.internal,playerId);if(playerId==='a'){const source=candidate.internal.movementObstacleSources.get(added);sawOrphan=Boolean(source&&!source.subscribers.size);expect(candidate.internal.movementDependencyPreparation!.created.has(added)).toBe(true);}if(fail&&playerId==='b')throw new Error('late profile failure');return value;};
    candidate.internal.refreshPlanningNav=wrapper;const dispose=candidate.sim.registerPlanningRefreshDiagnostic(original,wrapper)!;
    if(fail)reference.internal.refreshPlanningNav=playerId=>{const value=oldReference.call(reference.internal,playerId);if(playerId==='b')throw new Error('late profile failure');return value;};
    try{
      if(fail){expect(()=>candidate.phase()).toThrow('late profile failure');expect(()=>reference.phase()).toThrow('late profile failure');expect(candidate.internal.movementObstacleSources.size).toBe(0);expect(candidate.internal.movementObstacleCertificates.size).toBe(0);}
      else{expect(candidate.phase()).toEqual(reference.phase());expect([...candidate.internal.movementObstacleSources.get(candidate.node)!.subscribers]).toEqual(['b','c']);expect(candidate.internal.movementObstacleSources.has(candidate.hidden)).toBe(true);}
      expect(sawOrphan).toBe(true);expect(candidate.internal.movementObstacleSources.has(added)).toBe(false);expect(candidate.internal.movementDependencyPreparation).toBeUndefined();expect(candidate.internal.movementObstaclePreparation).toBeUndefined();
      expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));
    }finally{dispose();candidate.internal.refreshPlanningNav=original;reference.internal.refreshPlanningNav=oldReference;candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;}
    for(const f of [candidate,reference]){delete f.sim.state.vision.a!.memory.second;f.sim.state.entities.newly_authorized!.xMm+=1000;}
    expect(candidate.phase()).toEqual(reference.phase());expect(candidate.internal.movementObstacleSources.get(added)!.subscribers).toEqual(new Set(['a']));
    expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));
    expect(JSON.stringify(candidate.sim.views(['a','b','c']))).toBe(JSON.stringify(reference.sim.views(['a','b','c'])));
    candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;
  });

  it('retains subscriptions after an identical fully reconciled mutable read outside preparation',()=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());
    const certificate=f.internal.movementObstacleCertificates.get('a'),records=f.internal.knownObstacleRecords.get('a')!.records,lookup=vi.spyOn(records,'get');
    try{
      f.internal.knownObstacles('a');expect(lookup.mock.calls.some(([id])=>id===f.node.id)).toBe(true);lookup.mockClear();
      expect(f.internal.movementObstacleCertificates.get('a')).toBe(certificate);
      f.internal.workFrame={knowledge:{entities:Object.values(f.sim.state.entities),knownStatic:new Map()}};
      f.internal.admissionNav('a');f.internal.workFrame=undefined;
      expect(lookup.mock.calls.some(([id])=>id===f.node.id)).toBe(true);expect(f.internal.movementObstacleCertificates.get('a')).toBe(certificate);lookup.mockClear();
      const refreshed=f.phase();expect(lookup.mock.calls.some(([id])=>id===f.node.id)).toBe(false);f.compare(refreshed);lookup.mockClear();
      f.compare(f.phase());expect(lookup.mock.calls.filter(([id])=>id===f.node.id)).toHaveLength(0);
    }finally{lookup.mockRestore();f.internal.movementFrame=undefined;f.internal.workFrame=undefined;}
  });

  it('diffs changed profile subscriptions without releasing unchanged common sources',()=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());
    const source=f.internal.movementObstacleSources.get(f.node)!,added=vi.spyOn(source.subscribers,'add'),removed=vi.spyOn(source.subscribers,'delete');
    try{
      f.sim.state.entities.new_visible_gold={...f.node,id:'new_visible_gold',xMm:32000};
      f.compare(f.phase());
      expect(f.internal.movementObstacleSources.get(f.node)).toBe(source);expect(added).not.toHaveBeenCalled();expect(removed).not.toHaveBeenCalled();
      // One profile loses sight. Retained allied/enemy subscribers keep their
      // original owner while exactly that recipient releases its subscription.
      const mask=f.internal.visibilityMasks.get('a')!.slice(),fogMm=balance.rules.fogGridM*1000,columns=Math.floor(f.sim.state.widthMm/fogMm);
      for(let z=18000/fogMm;z<22000/fogMm;z++)for(let x=18000/fogMm;x<22000/fogMm;x++)mask[z*columns+x]=0;
      f.internal.visibilityMasks.set('a',mask);f.compare(f.phase());
      expect(added).not.toHaveBeenCalled();expect(removed.mock.calls).toEqual([['a']]);expect(source.subscribers).toEqual(new Set(['b','c']));
    }finally{added.mockRestore();removed.mockRestore();f.internal.movementFrame=undefined;}
  });

  it('preserves legacy geometry, revisions and captures after mutable admission changes',()=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    const compare=()=>{
      expect(candidate.phase()).toEqual(reference.phase());
      expect(candidate.sim.capture()).toEqual(reference.sim.capture());
      candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;
    };
    const changes:((f:ReturnType<typeof fixture>)=>void)[]=[
      f=>{f.node.amount--;},
      f=>{f.node.amount=0;},
      f=>{f.node.amount=100000;f.gate.gateMode='LOCKED';},
      f=>{f.gate.gateMode='AUTO';f.gate.work--;},
      f=>{f.gate.work++;f.gate.rotation=90;},
      f=>{f.sim.state.vision.a!.memory.observation={...f.hidden,xMm:70000} as unknown as (typeof f.sim.state.vision)['a']['memory'][string];},
      f=>{f.sim.state.vision.a!.memory.observation!.xMm+=2000;},
      f=>{f.sim.state.entities[f.node.id]={...f.node,xMm:30000};},
      f=>{f.sim.state.map.terrain=[{id:'admission_ridge',kind:'cliff',xMm:40000,zMm:40000,widthMm:6000,depthMm:2000,elevationMm:2000}];},
      f=>{f.sim.state.map.terrain[0]!.widthMm=8000;},
      f=>{delete f.sim.state.entities[f.node.id];delete f.sim.state.vision.a!.memory.observation;},
    ];
    compare();compare();
    for(const change of changes){
      change(candidate);change(reference);
      expect(candidate.internal.admissionNav('a').obstacles).toEqual(reference.internal.admissionNav('a').obstacles);
      compare();compare();
    }
  });

  it('revokes only the affected certificate on interrupted scalar reconciliation and custom readers',()=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());
    const b=f.internal.movementObstacleCertificates.get('b'),work=f.gate.work;
    Object.defineProperty(f.gate,'work',{configurable:true,enumerable:true,get(){throw new Error('admission source failure');}});
    try{
      f.node.amount=0;expect(()=>f.internal.knownObstacles('a')).toThrow('admission source failure');
      expect(f.internal.movementObstacleCertificates.has('a')).toBe(false);expect(f.internal.movementObstacleCertificates.get('b')).toBe(b);
    }finally{Object.defineProperty(f.gate,'work',{configurable:true,enumerable:true,writable:true,value:work});}
    f.compare(f.phase());f.compare(f.phase());
    const original=f.internal.knownStatic;f.internal.knownStatic=playerId=>original.call(f.internal,playerId);
    try{f.internal.knownObstacles('a');expect(f.internal.movementObstacleCertificates.has('a')).toBe(false);}
    finally{f.internal.knownStatic=original;}
    f.compare(f.phase());
  });

  it('permits only the explicitly registered original refresh diagnostic wrapper to retain ownership',()=>{
    const f=fixture(),original=f.internal.refreshPlanningNav,active:boolean[]=[];
    const wrapper=(playerId:string)=>{active.push(Boolean(f.internal.movementDependencyPreparation));return original.call(f.internal,playerId);};
    f.internal.refreshPlanningNav=wrapper;
    expect(f.sim.registerPlanningRefreshDiagnostic(()=>undefined,wrapper)).toBeUndefined();
    const dispose=f.sim.registerPlanningRefreshDiagnostic(original,wrapper);expect(dispose).toBeTypeOf('function');
    try{
      f.compare(f.phase());f.compare(f.phase());expect(active).toEqual([true,true,true,true,true,true]);
      const lookup=vi.spyOn(f.internal.knownObstacleRecords.get('a')!.records,'get');
      try{f.compare(f.phase());expect(lookup.mock.calls.filter(([id])=>id===f.node.id)).toHaveLength(0);}finally{lookup.mockRestore();}
      dispose!();active.length=0;f.compare(f.phase());expect(active).toEqual([false,false,false]);expect(f.internal.movementObstacleCertificates.size).toBe(0);
    }finally{dispose?.();f.internal.refreshPlanningNav=original;f.internal.movementFrame=undefined;}
  });

  it('keeps a memory alias recipient-owned and revokes live subscriptions when sight changes',()=>{
    const f=fixture();
    // Matching both ID and object identity is insufficient: a hidden object can
    // be present only through the public, mutable observation collection.
    f.sim.state.vision.a!.memory.observation=f.hidden as unknown as (typeof f.sim.state.vision)[string]['memory'][string];
    f.sim.state.vision.b!.memory.observation={...f.hidden,xMm:80000} as unknown as (typeof f.sim.state.vision)[string]['memory'][string];
    f.compare(f.phase());f.compare(f.phase());
    let amount=f.hidden.amount,reads=0;Object.defineProperty(f.hidden,'amount',{configurable:true,enumerable:true,get(){reads++;return amount;},set(value:number){amount=value;}});
    try{
      const warm=f.phase();expect(reads).toBe(2);expect([...f.internal.movementObstacleSources.get(f.hidden)!.subscribers]).toEqual(['c']);f.compare(warm);
      f.hidden.amount=0;const depleted=f.phase();expect(depleted.get('a')!.some(obstacle=>obstacle.id===f.hidden.id)).toBe(false);expect(depleted.get('b')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(80000);f.compare(depleted);
      f.hidden.amount=100000;delete f.sim.state.vision.a!.memory.observation;
      const lost=f.internal.visibilityMasks.get('c')!.slice();lost.fill(0);f.internal.visibilityMasks.set('c',lost);
      const hidden=f.phase();expect(hidden.get('a')!.some(obstacle=>obstacle.id===f.hidden.id)).toBe(false);expect(hidden.get('c')!.some(obstacle=>obstacle.id===f.hidden.id)).toBe(false);f.compare(hidden);
      expect(f.internal.movementObstacleSources.has(f.hidden)).toBe(false);
      const visible=f.internal.visibilityMasks.get('a')!.slice(),columns=Math.floor(f.sim.state.widthMm/(balance.rules.fogGridM*1000));
      visible[Math.floor(f.hidden.zMm/(balance.rules.fogGridM*1000))*columns+Math.floor(f.hidden.xMm/(balance.rules.fogGridM*1000))]=1;f.internal.visibilityMasks.set('a',visible);
      const observed=f.phase();expect(observed.get('a')!.find(obstacle=>obstacle.id===f.hidden.id)!.xMm).toBe(90000);f.compare(observed);
    }finally{Object.defineProperty(f.hidden,'amount',{configurable:true,enumerable:true,writable:true,value:amount});f.internal.movementFrame=undefined;}
  });

  it('matches real build, cancellation and wall replacement admissions across warm ownership',()=>{
    const candidate=fixture(),reference=fixture();installLegacyNavigation(reference.sim);
    for(const f of [candidate,reference]){
      f.sim.state.entities.builder={id:'builder',kind:'unit',typeId:'villager',ownerId:'a',xMm:12000,zMm:12000,hp:50,maxHp:50,orders:[],path:[],pathRevision:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'defensive',repathAtTick:0};
      f.sim.state.economies.a!.age=4;for(const resource of ['food','wood','gold','stone'] as const)f.sim.state.economies.a!.resources[resource]=1000000;
      f.sim.state.vision.a!.explored=[...f.internal.visibilityMasks.get('a')!.entries()].filter(([,seen])=>seen).map(([cell])=>cell);
    }
    const phase=()=>{expect(candidate.phase()).toEqual(reference.phase());expect(JSON.stringify(candidate.sim.capture())).toBe(JSON.stringify(reference.sim.capture()));candidate.internal.movementFrame=undefined;reference.internal.movementFrame=undefined;};
    let sequence=0;
    const issue=(command:GameplayCommand)=>{
      sequence++;const input={protocolVersion:2,matchId:candidate.sim.state.matchId,matchEpoch:candidate.sim.state.matchEpoch,clientCommandId:`dependency_${sequence}`,clientSequence:sequence,command};
      const actual=candidate.sim.command('a',input),expected=reference.sim.command('a',input);expect(actual).toEqual(expected);expect(actual.status,JSON.stringify(actual)).toBe('accepted');phase();phase();
    };
    // Keep the house and its access halo clear of the gold deposit at (20m,20m).
    phase();phase();issue({kind:'build',builderIds:['builder'],buildingType:'house',originCell:{x:4,z:7},rotation:0,queued:false});
    const foundation=Object.values(candidate.sim.state.entities).find(entity=>entity.kind==='building'&&entity.typeId==='house')!;
    issue({kind:'cancel_foundation',foundationId:foundation.id});
    issue({kind:'build_wall',builderIds:['builder'],material:'palisade',cells:[{x:14,z:14},{x:15,z:14},{x:16,z:14}],queued:false});
    const wallIds=Object.values(candidate.sim.state.entities).filter(entity=>entity.kind==='building'&&entity.typeId==='palisade_wall').map(entity=>entity.id);
    expect(wallIds).toHaveLength(3);
    for(const f of [candidate,reference])for(const id of wallIds){const wall=f.sim.state.entities[id] as Building;wall.work=wall.required;}
    phase();issue({kind:'replace_wall_with_gate',builderIds:['builder'],wallIds,queued:false});
    expect(wallIds.every(id=>!candidate.sim.state.entities[id])).toBe(true);
    expect(candidate.sim.state.pathAdmission!.a!.used).toBe(reference.sim.state.pathAdmission!.a!.used);
  });

  it.each(['instance','prototype'] as const)('keeps %s reader mutation on the scalar profile boundary',scope=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());
    const target=scope==='instance'?f.internal:Simulation.prototype as unknown as Internals,original=target.refreshPlanningNav;
    const hook=vi.spyOn(target,'refreshPlanningNav').mockImplementation(function(this:Internals,playerId:string){
      const value=original.call(this,playerId);if(this===f.internal&&playerId==='a')f.node.xMm+=2000;return value;
    });
    try{
      const result=f.phase();
      expect(result.get('a')!.find(obstacle=>obstacle.id===f.node.id)!.xMm).toBe(20000);
      expect(result.get('b')!.find(obstacle=>obstacle.id===f.node.id)!.xMm).toBe(22000);
      expect(result.get('c')!.find(obstacle=>obstacle.id===f.node.id)!.xMm).toBe(22000);
    }finally{hook.mockRestore();f.internal.movementFrame=undefined;}
    f.compare(f.phase());
  });

  it('discards an interrupted exact reconciliation before the next mutable query and phase',()=>{
    const f=fixture();f.compare(f.phase());f.compare(f.phase());let amount=f.node.amount;
    Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,get(){throw new Error('dependency source failure');}});
    try{expect(()=>f.internal.prepareMovement()).toThrow('dependency source failure');expect(f.internal.movementObstaclePreparation).toBeUndefined();expect(f.internal.movementDependencyPreparation).toBeUndefined();expect(f.internal.movementObstacleCertificates.size).toBe(0);expect(f.internal.movementObstacleSources.size).toBe(0);}
    finally{amount=0;Object.defineProperty(f.node,'amount',{configurable:true,enumerable:true,writable:true,value:amount});}
    expect(f.internal.knownObstacles('b').some(obstacle=>obstacle.id===f.node.id)).toBe(false);
    f.internal.movementFrame=undefined;f.compare(f.phase());f.node.amount=100000;f.compare(f.phase());
  });
  type FormationInternals=Internals&{
    formationKnowledge?:{entities:Entity[];knownStatic:Map<string,Entity[]>;staticIndexed?:boolean};
    formationTargets:(...args:unknown[])=>Map<string,Position>;
    perceptionWorld?:readonly Entity[];
    perceptionMembership:{inventory():{reconciled:number}};
    registerPlanningRefreshDiagnostic(original:unknown,wrapper:unknown):(()=>void)|undefined;
  };
  function formationFixture(){
    const f=fixture(),internal=f.internal as FormationInternals;
    f.node.typeId='gold_deposit';f.hidden.typeId='gold_deposit';
    for(const [index,id]of ['a','b','c'].entries()){
      const mask=internal.visibilityMasks.get(id)!;f.sim.state.vision[id]!.visible=Array.from(mask.entries()).filter(([,visible])=>visible).map(([cell])=>cell);f.sim.state.vision[id]!.explored=[...f.sim.state.vision[id]!.visible];
      const home:Building={...structuredClone(f.gate),id:`formation_home_${id}`,typeId:'town_center',ownerId:id,xMm:10000+index*50000,zMm:33000+index*24000};delete home.gateMode;delete home.gateOpen;f.sim.state.entities[home.id]=home;
    }
    for(const [index,id]of ['formation_one','formation_two'].entries())f.sim.state.entities[id]={id,kind:'unit',typeId:'villager',ownerId:'a',xMm:12000+index*2500,zMm:12000,hp:50,maxHp:50,orders:[],path:[],pathRevision:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',repathAtTick:0,orderRevision:0} satisfies Unit;
    f.sim.state.economies.a!.age=4;for(const resource of balance.resourceOrder)f.sim.state.economies.a!.resources[resource]=1000000;
    return {...f,internal};
  }
  function compareFormation(left:Simulation,right:Simulation){
    expect(JSON.stringify(left.capture())).toBe(JSON.stringify(right.capture()));expect(JSON.stringify(left.views(['a','b','c']))).toBe(JSON.stringify(right.views(['a','b','c'])));
    expect(left.journalEvents()).toEqual(right.journalEvents());expect(left.state.pathAdmission).toEqual(right.state.pathAdmission);
  }
  function formationPair(){
    const candidate=formationFixture(),reference=formationFixture();installLegacyNavigation(reference.sim);
    const issue=(command:GameplayCommand)=>{
      const sequence=candidate.sim.state.economies.a!.lastClientSequence+1,input={protocolVersion:2,matchId:candidate.sim.state.matchId,matchEpoch:candidate.sim.state.matchEpoch,clientCommandId:`formation_${sequence}`,clientSequence:sequence,command};
      const actual=candidate.sim.command('a',input),expected=reference.sim.command('a',input);expect(actual).toEqual(expected);expect(actual.status).toBe('accepted');compareFormation(candidate.sim,reference.sim);
      expect(candidate.internal.formationKnowledge).toBeUndefined();expect(reference.internal.formationKnowledge).toBeUndefined();return actual;
    };
    const order=(kind:'move'|'attack_move'='move'):GameplayCommand=>({kind,unitIds:['formation_one','formation_two'],target:{xMm:32000,zMm:31000},queued:false});
    return {candidate,reference,issue,order};
  }
  it('indexes each ordinary formation refresh independently and matches legacy admissions across same-tick edits and cold continuation',()=>{
    const {candidate,reference,issue,order}=formationPair(),frames:object[]=[],original=candidate.internal.refreshPlanningNav,consumer=candidate.internal.formationTargets;
    const wrapper=(playerId:string)=>{const navigation=original.call(candidate.internal,playerId),frame=candidate.internal.formationKnowledge;if(frame){expect(frame.staticIndexed).toBe(true);expect(frame.knownStatic.has(playerId)).toBe(true);frames.push(frame);}return navigation;};
    candidate.internal.refreshPlanningNav=wrapper;const dispose=candidate.internal.registerPlanningRefreshDiagnostic(original,wrapper);expect(dispose).toBeTypeOf('function');
    candidate.internal.formationTargets=(...args)=>{expect(candidate.internal.formationKnowledge).toBeUndefined();return consumer.apply(candidate.internal,args);};
    const before=candidate.internal.perceptionMembership.inventory().reconciled;
    try{
      issue(order());expect(frames).toHaveLength(1);expect(candidate.internal.perceptionMembership.inventory().reconciled-before).toBe(Object.keys(candidate.sim.state.entities).length);
      const mutate=(change:(f:ReturnType<typeof formationFixture>)=>void)=>{for(const f of [candidate,reference])change(f);issue(order(frames.length%2?'attack_move':'move'));};
      mutate(f=>{f.gate.gateMode='LOCKED';});mutate(f=>{f.gate.gateMode='AUTO';f.gate.work--;});mutate(f=>{f.gate.work=f.gate.required;f.gate.gateOpen=true;});
      mutate(f=>{f.sim.state.vision.a!.memory.observation={id:f.hidden.id,kind:'resource',typeId:'gold_deposit',ownerId:null,xMm:70000,zMm:20000,hp:1,maxHp:1,resource:'gold',amount:100,lastSeenTick:0};});
      mutate(f=>{f.hidden.xMm+=4000;f.hidden.amount=0;});mutate(f=>{f.sim.state.vision.a!.memory.observation={...f.sim.state.vision.a!.memory.observation!,xMm:74000};});
      mutate(f=>{f.node.amount=0;});mutate(f=>{f.sim.state.entities[f.node.id]={...f.node,amount:100000,zMm:24000};});
      mutate(f=>{f.sim.state.map.terrain=[{id:'formation_water',kind:'water',xMm:28000,zMm:26000,widthMm:2000,depthMm:2000,elevationMm:-1000}];});
      issue({kind:'build',builderIds:['formation_one'],buildingType:'house',originCell:{x:7,z:7},rotation:0,queued:false});issue(order('attack_move'));
      const foundation=Object.values(candidate.sim.state.entities).find(entity=>entity.kind==='building'&&entity.typeId==='house')!;expect(foundation).toBeDefined();issue({kind:'cancel_foundation',foundationId:foundation.id});issue(order());
      expect(candidate.sim.state.tick).toBe(0);expect(new Set(frames).size).toBe(frames.length);expect(frames.length).toBeGreaterThan(10);
    }finally{dispose?.();candidate.internal.refreshPlanningNav=original;candidate.internal.formationTargets=consumer;}
    const cold=new Simulation(candidate.sim.options,candidate.sim.capture()),coldReference=new Simulation(reference.sim.options,reference.sim.capture());installLegacyNavigation(coldReference);
    const sequence=candidate.sim.state.economies.a!.lastClientSequence+1,input={protocolVersion:2,matchId:candidate.sim.state.matchId,matchEpoch:candidate.sim.state.matchEpoch,clientCommandId:`formation_${sequence}`,clientSequence:sequence,command:order('attack_move')};
    const expected=candidate.sim.command('a',input);for(const sim of [reference.sim,cold,coldReference])expect(sim.command('a',input)).toEqual(expected);
    compareFormation(candidate.sim,reference.sim);compareFormation(cold,coldReference);expect(cold.capture()).toEqual(candidate.sim.capture());
    for(let tick=0;tick<4;tick++){for(const sim of [candidate.sim,reference.sim,cold,coldReference])sim.step();compareFormation(candidate.sim,reference.sim);compareFormation(cold,coldReference);expect(cold.capture()).toEqual(candidate.sim.capture());}
  });
  it.each(['instance','prototype'] as const)('keeps custom %s formation-refresh mutations on the scalar path',scope=>{
    const {candidate,reference,issue,order}=formationPair(),target=(scope==='prototype'?Simulation.prototype:candidate.internal) as unknown as FormationInternals,original=target.refreshPlanningNav,referenceRefresh=reference.internal.refreshPlanningNav;
    const before=candidate.internal.perceptionMembership.inventory().reconciled;
    target.refreshPlanningNav=function(this:FormationInternals,playerId:string){if(this===candidate.internal){expect(candidate.internal.formationKnowledge).toBeUndefined();candidate.node.amount=0;}return original.call(this,playerId);};
    reference.internal.refreshPlanningNav=playerId=>{expect(reference.internal.formationKnowledge).toBeUndefined();reference.node.amount=0;return referenceRefresh.call(reference.internal,playerId);};
    try{issue(order('attack_move'));expect(candidate.internal.perceptionMembership.inventory().reconciled).toBe(before);}
    finally{if(scope==='prototype')target.refreshPlanningNav=original;else delete (candidate.internal as unknown as Record<string,unknown>).refreshPlanningNav;reference.internal.refreshPlanningNav=referenceRefresh;}
    issue(order());expect(candidate.internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(before);
  });
  it('clears a canonical formation frame after a source-read exception and preserves the next command',()=>{
    const {candidate,reference,issue,order}=formationPair();let sawFrame=false;
    for(const f of [candidate,reference])Object.defineProperty(f.gate,'work',{configurable:true,enumerable:true,get(){if(f===candidate)sawFrame=Boolean(f.internal.formationKnowledge);throw new Error('formation source failure');}});
    const input={protocolVersion:2,matchId:candidate.sim.state.matchId,matchEpoch:candidate.sim.state.matchEpoch,clientCommandId:'formation_1',clientSequence:1,command:order()};
    try{for(const f of [candidate,reference]){expect(()=>f.sim.command('a',input)).toThrow('formation source failure');expect(f.internal.formationKnowledge).toBeUndefined();}expect(sawFrame).toBe(true);}
    finally{for(const f of [candidate,reference])Object.defineProperty(f.gate,'work',{configurable:true,enumerable:true,writable:true,value:100});}
    compareFormation(candidate.sim,reference.sim);issue(order('attack_move'));
  });
  it.each(['duplicate','incoherent allied masks','missing mask','short mask','long mask'] as const)('retains the unframed legacy formation fallback for %s',condition=>{
    const {candidate,reference,issue,order}=formationPair(),active:boolean[]=[],original=candidate.internal.refreshPlanningNav;
    const masks=new Map([candidate,reference].map(f=>[f,f.internal.visibilityMasks.get('a')!]));
    for(const f of [candidate,reference]){
      if(condition==='duplicate')f.sim.state.entities.duplicate=f.node;
      else if(condition==='incoherent allied masks')f.sim.options.sharedVision=true;
      else if(condition==='missing mask')f.internal.visibilityMasks.delete('a');
      else if(condition==='short mask')f.internal.visibilityMasks.set('a',masks.get(f)!.slice(0,-1));
      else{
        const columns=Math.floor(f.sim.state.widthMm/(balance.rules.fogGridM*1000)),extended=new Uint8Array(masks.get(f)!.length+columns*3);extended.set(masks.get(f)!);extended.fill(1,masks.get(f)!.length);f.internal.visibilityMasks.set('a',extended);
        f.sim.state.entities.offgrid_house={...structuredClone(f.gate),id:'offgrid_house',typeId:'house',ownerId:'b',xMm:10000,zMm:f.sim.state.heightMm+2000};
      }
    }
    const wrapper=(playerId:string)=>{active.push(Boolean(candidate.internal.formationKnowledge));return original.call(candidate.internal,playerId);};candidate.internal.refreshPlanningNav=wrapper;
    const dispose=candidate.internal.registerPlanningRefreshDiagnostic(original,wrapper);expect(dispose).toBeTypeOf('function');
    try{
      issue(order());expect(active).toEqual([false]);active.length=0;
      if(condition==='long mask')expect(candidate.internal.planningNavigations.get('a')!.navigation.obstacles.some(obstacle=>obstacle.id==='offgrid_house')).toBe(true);
      for(const f of [candidate,reference]){if(condition==='duplicate')delete f.sim.state.entities.duplicate;else if(condition==='incoherent allied masks')f.internal.visibilityMasks.set('b',f.internal.visibilityMasks.get('a')!);else{f.internal.visibilityMasks.set('a',masks.get(f)!);delete f.sim.state.entities.offgrid_house;}}
      issue(order('attack_move'));expect(active).toEqual([true]);
    }finally{dispose?.();candidate.internal.refreshPlanningNav=original;}
  });
  it.each(['unknown unit type','throwing unit position'] as const)('preserves scalar formation success when unused actor indexing encounters %s',condition=>{
    const {candidate,reference,order}=formationPair(),active:boolean[]=[],original=candidate.internal.refreshPlanningNav;let positionReads=0;
    for(const f of [candidate,reference]){
      const unrelated={...structuredClone(f.sim.state.entities.formation_one as Unit),id:'unrelated_actor',ownerId:'b',xMm:200000,zMm:200000};
      if(condition==='unknown unit type')unrelated.typeId='unrecognized_unit' as Unit['typeId'];else Object.defineProperty(unrelated,'xMm',{configurable:true,enumerable:true,get(){positionReads++;throw new Error('unused actor position');}});
      f.sim.state.entities[unrelated.id]=unrelated;f.internal.perceptionWorld=f.internal.all();
    }
    const wrapper=(playerId:string)=>{active.push(Boolean(candidate.internal.formationKnowledge));return original.call(candidate.internal,playerId);};candidate.internal.refreshPlanningNav=wrapper;
    const dispose=candidate.internal.registerPlanningRefreshDiagnostic(original,wrapper);expect(dispose).toBeTypeOf('function');
    const input={protocolVersion:2,matchId:candidate.sim.state.matchId,matchEpoch:candidate.sim.state.matchEpoch,clientCommandId:'formation_1',clientSequence:1,command:order('attack_move')};
    try{
      const actual=candidate.sim.command('a',input),expected=reference.sim.command('a',input);expect(actual).toEqual(expected);expect(actual.status).toBe('accepted');expect(active).toEqual([false]);
      expect(candidate.internal.perceptionWorld).toBeUndefined();expect(candidate.internal.formationKnowledge).toBeUndefined();if(condition==='throwing unit position')expect(positionReads).toBeGreaterThan(0);
    }finally{dispose?.();candidate.internal.refreshPlanningNav=original;for(const f of [candidate,reference])delete f.sim.state.entities.unrelated_actor;}
    compareFormation(candidate.sim,reference.sim);
  });
});


describe('owned physical navigation revisions',()=>{
  type Physical={liveOwned:boolean;navigationCache:Navigation|undefined;physicalObstacleRecords:Map<Entity,{obstacles:Obstacle[]}>;nav():Navigation;obstacles():Obstacle[];physicalObstacles():Obstacle[];invalidateEntityRoster(staticChanged:boolean):void};
  const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
  function fixture(){
    const options={factions,seed:'physical-revisions',matchId:'physical-revisions',controllers:false,sharedVision:false},sim=createSimulation(options),internal=sim as unknown as Physical;
    sim.state.entities={};sim.state.map.terrain=[{id:'physical_water',kind:'water',xMm:40000,zMm:10000,widthMm:2000,depthMm:12000,elevationMm:-1000}];
    const tree:ResourceNode={id:'physical_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:10000,zMm:15000,hp:1,maxHp:1,amount:1000};
    const forest:ResourceNode={...tree,id:'physical_forest',xMm:14000,forest:{cellMm:2000,patchId:'belt'}},gold:ResourceNode={...tree,id:'physical_gold',xMm:18000,typeId:'gold_mine',resource:'gold'};
    const make=(id:string,typeId:Building['typeId'],xMm:number,zMm:number):Building=>({id,kind:'building',typeId,ownerId:'a',xMm,zMm,rotation:0,hp:buildings[typeId].maxHp,maxHp:buildings[typeId].maxHp,grantedHp:buildings[typeId].maxHp,work:1000,required:1000,queue:[],cooldown:0});
    const gate=make('physical_gate','wooden_gate',22000,24000),house=make('physical_house','house',32000,24000);gate.gateMode='AUTO';gate.gateOpen=false;
    for(const entity of [tree,forest,gold,gate,house])sim.state.entities[entity.id]=entity;
    sim.state.vision.a!.visible=[];sim.state.vision.a!.memory.remembered_only={...tree,id:'remembered_only',xMm:50000,lastSeenTick:0};
    internal.liveOwned=true;internal.invalidateEntityRoster(true);sim.state.navigationRevision++;
    return {options,sim,internal,tree,forest,gold,gate,house,make};
  }
  it('reuses unchanged physical shapes and keeps prior snapshots exact through live geometry transitions',()=>{
    const f=fixture(),snapshots:{navigation:Navigation;obstacles:Obstacle[]}[]=[],counts:number[]=[];
    const check=()=>{
      const entries=f.internal.obstacles(),prior=f.internal.physicalObstacleRecords,navigation=f.internal.nav();counts.push([...f.internal.physicalObstacleRecords].filter(([entity,record])=>prior.get(entity)===record).length);
      expect(navigation.obstacles).toEqual(entries);expect(navigation.obstacles.some(entry=>entry.id==='remembered_only')).toBe(false);
      const scalar=new Navigation(f.sim.state.widthMm,f.sim.state.heightMm,entries);
      for(const position of [{xMm:10000,zMm:15000},{xMm:14000,zMm:15000},{xMm:22000,zMm:24000},{xMm:32000,zMm:24000},{xMm:35000,zMm:36000}]){expect(navigation.free(position,350)).toBe(scalar.free(position,350));expect(navigation.clearLine({xMm:3000,zMm:3000},position,350)).toBe(scalar.clearLine({xMm:3000,zMm:3000},position,350));}
      for(const old of snapshots)expect(old.navigation.obstacles).toEqual(old.obstacles);
      snapshots.push({navigation,obstacles:structuredClone(navigation.obstacles)});return navigation;
    };
    const first=check();expect(f.internal.nav()).toBe(first);expect(first.obstacles.filter(row=>row.id===f.gate.id)).toHaveLength(1);
    f.tree.amount=500;f.sim.state.navigationRevision++;const unchanged=check();expect(counts.at(-1)).toBe(5);expect(unchanged.obstacles.every((row,index)=>row===first.obstacles[index])).toBe(true);
    f.tree.amount=0;f.sim.state.navigationRevision++;const depleted=check();expect(counts.at(-1)).toBe(4);expect(depleted.free(f.tree,350)).toBe(true);expect(first.free(f.tree,350)).toBe(false);
    f.gate.gateOpen=true;f.sim.state.navigationRevision++;const opened=check();expect(opened.obstacles.filter(row=>row.id===f.gate.id)).toHaveLength(2);expect(opened.free(f.gate,350)).toBe(true);expect(first.free(f.gate,350)).toBe(false);
    f.gate.rotation=90;f.sim.state.navigationRevision++;const rotated=check();const posts=rotated.obstacles.filter(row=>row.id===f.gate.id);expect(posts[0]!.xMm).toBe(posts[1]!.xMm);expect(posts[0]!.zMm).not.toBe(posts[1]!.zMm);
    f.gate.work=999;f.sim.state.navigationRevision++;expect(check().obstacles.filter(row=>row.id===f.gate.id)).toHaveLength(1);
    f.gate.work=1000;f.sim.state.navigationRevision++;expect(check().obstacles.filter(row=>row.id===f.gate.id)).toHaveLength(2);
    f.gate.gateMode='LOCKED';f.sim.state.navigationRevision++;check();expect(counts.at(-1)).toBe(5);
    f.house.hp=0;f.house.demolitionTick=f.sim.state.tick;f.sim.state.navigationRevision++;expect(check().obstacles.some(row=>row.id===f.house.id)).toBe(true);
    delete f.sim.state.entities[f.house.id];f.internal.invalidateEntityRoster(true);f.sim.state.navigationRevision++;check();expect(f.internal.physicalObstacleRecords.has(f.house)).toBe(false);
    const addition=f.make('physical_new','house',35000,36000);f.sim.state.entities[addition.id]=addition;f.internal.invalidateEntityRoster(true);f.sim.state.navigationRevision++;const created=check();expect(created.free(addition,350)).toBe(false);expect(first.free(addition,350)).toBe(true);
    f.forest.forest!.cellMm=1000;f.sim.state.navigationRevision++;check();
    const cold=new Simulation(f.options,f.sim.capture()) as unknown as Physical;cold.liveOwned=true;cold.invalidateEntityRoster(true);expect(cold.nav().obstacles).toEqual(f.internal.nav().obstacles);
  });
  it.each(['duplicate','over limit'] as const)('falls back without dropping any physical occurrence when the cache encounters %s',condition=>{
    const f=fixture();f.internal.nav();
    if(condition==='duplicate')f.sim.state.entities.alias=f.tree;
    else for(let index=0;index<staticRecordLimit+1;index++)f.sim.state.entities[`extra_${index}`]={...f.tree,id:`extra_${index}`,xMm:50000+(index%10)*1000,zMm:50000+Math.floor(index/100)*1000};
    f.internal.invalidateEntityRoster(true);f.sim.state.navigationRevision++;const expected=f.internal.obstacles(),actual=f.internal.nav();expect(actual.obstacles).toEqual(expected);expect(f.internal.physicalObstacleRecords.size).toBe(0);
    if(condition==='duplicate'){
      const rows=actual.obstacles.filter(row=>row.id===f.tree.id);expect(rows).toHaveLength(2);expect(rows[0]).not.toBe(rows[1]);
      f.sim.state.navigationRevision++;expect(f.internal.nav().obstacles).toEqual(expected);expect(f.internal.physicalObstacleRecords.size).toBe(0);
      delete f.sim.state.entities.alias;f.internal.invalidateEntityRoster(true);f.sim.state.navigationRevision++;
      expect(f.internal.nav().obstacles).toEqual(f.internal.obstacles());expect(f.internal.physicalObstacleRecords.size).toBe(5);
    }else expect(actual.obstacles.length).toBeGreaterThan(staticRecordLimit);
  });
  it.each(['before','after'] as const)('keeps replaced physical-cache hooks off the native path %s live factory creation',async when=>{
    const options={factions,seed:'physical-ownership',matchId:'physical-ownership',controllers:false,authoritativeIntervalMs:300 as const},initial=createSimulation({...options,authoritativeIntervalMs:50}),payload=initial.capture(),scalar=new Simulation(options,payload),prototype=Simulation.prototype as unknown as Physical,original=prototype.physicalObstacles,hook=vi.fn(function(this:Physical){return original.call(this);});
    let live:ReturnType<typeof createLiveSimulation>|undefined;
    try{if(when==='after')live=createLiveSimulation(options,payload);prototype.physicalObstacles=hook;live??=createLiveSimulation(options,payload);live.advanceFrame();scalar.advanceFrame();await live.synchronizeCapture();await scalar.synchronizeCapture();expect(hook).not.toHaveBeenCalled();expect(live.capture()).toEqual(scalar.capture());}
    finally{prototype.physicalObstacles=original;}
  });
});

describe('bounded immutable navigation revisions',()=>{
  const immutable=(entries:Obstacle[])=>Object.freeze(entries.map(entry=>Object.freeze(entry))) as unknown as Obstacle[];
  const obstacle=(id:string,xMm:number,zMm=6000):Obstacle=>({id,xMm,zMm,halfWidth:650,halfHeight:650});
  it('retains immutable records beyond the former 16384 obstacle ceiling',()=>{
    const initial=immutable(Array.from({length:16385},(_,index)=>({id:`shape_${index}`,xMm:1000+index%200*3000,zMm:1000+Math.floor(index/200)*3000,halfWidth:100,halfHeight:100})));
    const before=createOwnedNavigationRevision(undefined,640000,640000,initial),old=initial.at(-1)!,next=immutable([...initial.slice(0,-1),{...old,xMm:old.xMm+500}]);
    const after=createOwnedNavigationRevision(before,640000,640000,next);
    expect(after.obstacles[0]).toBe(before.obstacles[0]);expect(after.obstacles[16383]).toBe(before.obstacles[16383]);
    expect(before.free(old,100)).toBe(false);expect(after.free(old,100)).toBe(true);expect(after.free(next.at(-1)!,100)).toBe(false);
  });
  function parity(owned:Navigation,entries:Obstacle[]){
    const left={remaining:0,used:0},right={remaining:0,used:0},actual=withOwnedNavigationBudget(owned,left),scalar=new Navigation(32000,32000,entries,30000,1000,right);
    for(const remaining of [0,1,2,4,10,10000])for(const query of [
      (nav:Navigation)=>nav.free({xMm:6000,zMm:6000},350),
      (nav:Navigation)=>nav.free({xMm:18000,zMm:7000},350),
      (nav:Navigation)=>nav.clearLine({xMm:1000,zMm:6000},{xMm:29000,zMm:6000},350),
      (nav:Navigation)=>nav.clearLine({xMm:29000,zMm:6000},{xMm:1000,zMm:6000},350),
      (nav:Navigation)=>nav.clearLine({xMm:1000,zMm:5000},{xMm:1000,zMm:29000},350,'gate'),
    ])expect(evaluate(actual,left,remaining,17,query)).toEqual(evaluate(scalar,right,remaining,17,query));
  }
  it('retains old admitted geometry and reuses unchanged immutable records through insertions and removals',()=>{
    const initial=immutable([obstacle('tree_a',6000),obstacle('tree_b',18000),{...obstacle('stone',26000),circle:true}]),before=createOwnedNavigationRevision(undefined,32000,32000,initial);
    const afterSources=immutable([initial[0]!,obstacle('tree_new',12000),initial[2]!]),after=createOwnedNavigationRevision(before,32000,32000,afterSources);
    expect(after.obstacles[0]).toBe(before.obstacles[0]);expect(after.obstacles[2]).toBe(before.obstacles[2]);
    expect(before.obstacles.map(row=>row.id)).toEqual(['tree_a','tree_b','stone']);
    expect(before.free({xMm:18000,zMm:6000},350)).toBe(false);expect(after.free({xMm:18000,zMm:6000},350)).toBe(true);
    parity(before,initial);parity(after,afterSources);
  });
  it('preserves two gate-post occurrences with repeated IDs and resets formerly cached clear answers',()=>{
    const tree=Object.freeze(obstacle('tree',22000)),initial=immutable([tree]),before=createOwnedNavigationRevision(undefined,32000,32000,initial);
    expect(before.free({xMm:6000,zMm:6000},350)).toBe(true);
    const posts=immutable([obstacle('gate',6000),obstacle('gate',10000),tree]),after=createOwnedNavigationRevision(before,32000,32000,posts);
    expect(after.free({xMm:6000,zMm:6000},350)).toBe(false);expect(before.free({xMm:6000,zMm:6000},350)).toBe(true);
    expect(after.obstacles[2]).toBe(before.obstacles[0]);parity(after,posts);
    const closed=immutable([{...obstacle('gate',8000),halfWidth:3500},tree]),closedNav=createOwnedNavigationRevision(after,32000,32000,closed);
    parity(closedNav,closed);parity(after,posts);
  });
  it('falls back without altering order, alias deduplication, or mutable snapshot semantics',()=>{
    const first=Object.freeze(obstacle('same',6000)),second=Object.freeze(obstacle('same',18000)),initial=immutable([first,second]),before=createOwnedNavigationRevision(undefined,32000,32000,initial);
    const reversed=immutable([second,first]),after=createOwnedNavigationRevision(before,32000,32000,reversed);parity(after,reversed);
    const aliases=Object.freeze([first,first,second]) as unknown as Obstacle[],aliasNav=createOwnedNavigationRevision(after,32000,32000,aliases);parity(aliasNav,aliases);
    const mutable=[obstacle('mutable',6000)],old=createOwnedNavigationRevision(undefined,32000,32000,mutable);
    mutable[0]!.xMm=18000;const next=createOwnedNavigationRevision(old,32000,32000,mutable);
    expect(old.obstacles[0]!.xMm).toBe(6000);expect(next.obstacles[0]!.xMm).toBe(18000);parity(next,mutable);
  });
  it.each(['array proxy','source proxy','source accessor'] as const)('preserves the original constructor reads for an unsupported %s',mode=>{
    const read=(candidate:boolean)=>{
      const calls:string[]=[],plain=obstacle('observed',6000);
      if(mode==='source accessor')Object.defineProperty(plain,'xMm',{enumerable:true,get(){calls.push('xMm');return 6000;}});
      Object.freeze(plain);
      const source=mode==='source proxy'?new Proxy(plain,{ownKeys(value){calls.push('keys');return Reflect.ownKeys(value);},getOwnPropertyDescriptor(value,key){calls.push(`descriptor:${String(key)}`);return Reflect.getOwnPropertyDescriptor(value,key);},get(value,key,receiver){calls.push(`get:${String(key)}`);return Reflect.get(value,key,receiver);}}):plain;
      const list=Object.freeze([source]) as unknown as Obstacle[],input=mode==='array proxy'?new Proxy(list,{get(value,key,receiver){calls.push(`get:${String(key)}`);return Reflect.get(value,key,receiver);}}):list;
      const result=candidate?createOwnedNavigationRevision(undefined,32000,32000,input):createOwnedNavigation(32000,32000,input);
      return {calls,obstacles:result.obstacles,answer:result.free({xMm:6000,zMm:6000},350)};
    };
    expect(read(true)).toEqual(read(false));
  });
  it('keeps every obstacle when the bounded edit batch requires a complete reconstruction',()=>{
    const initial=immutable([obstacle('kept',30000,30000)]),before=createOwnedNavigationRevision(undefined,32000,32000,initial),many=immutable([...Array.from({length:257},(_,index)=>obstacle(`new_${index}`,1000+(index%16)*1500,1000+Math.floor(index/16)*1500)),initial[0]!]),after=createOwnedNavigationRevision(before,32000,32000,many);
    expect(after.obstacles).toHaveLength(258);expect(before.obstacles).toHaveLength(1);parity(after,many);
  });
});
