import { describe, expect, it } from 'vitest';
import { units, type Position } from '@frontier/shared';
import { Simulation, createSimulation, type Building, type Unit } from '../src/index.js';
import { ApproachReservations,LocalAvoidance,UnitSpatialIndex, type MovementBody } from '../src/movement.js';
import { Navigation } from '../src/navigation.js';
import { createOwnedNavigation } from '../src/owned-navigation.js';

/** Independent pre-storage semantics: owned body copies and lexical queries. */
class ReferenceIndex extends UnitSpatialIndex {
  private readonly reference=new Map<string,MovementBody>();
  private retained=new Set<string>();
  override update(id:string,xMm:number,zMm:number,radiusMm:number):void{this.reference.set(id,{id,xMm,zMm,radiusMm});this.retained.add(id);}
  override set(body:MovementBody):void{this.update(body.id,body.xMm,body.zMm,body.radiusMm);}
  override body(id:string):MovementBody|undefined{return this.reference.get(id);}
  override delete(id:string):void{this.reference.delete(id);}
  override beginRoster():void{this.retained.clear();}
  override endRoster():void{for(const id of this.reference.keys())if(!this.retained.has(id))this.reference.delete(id);}
  override nearby(point:Position,reach:number):MovementBody[]{return [...this.reference.values()].filter(body=>Math.hypot(body.xMm-point.xMm,body.zMm-point.zMm)<=reach+body.radiusMm).sort((a,b)=>a.id.localeCompare(b.id));}
  override withNearby<T>(point:Position,reach:number,consume:(bodies:readonly MovementBody[])=>T):T{return consume(this.nearby(point,reach));}
  override free(point:Position,radius:number,except?:string):boolean{return !this.nearby(point,radius).some(body=>body.id!==except&&Math.hypot(body.xMm-point.xMm,body.zMm-point.zMm)<radius+body.radiusMm);}
  override clearLine(from:Position,to:Position,radius:number,except?:string):boolean{const dx=to.xMm-from.xMm,dz=to.zMm-from.zMm,length2=dx*dx+dz*dz;return !this.nearby(from,Math.sqrt(length2)+radius).some(body=>{if(body.id===except)return false;const t=length2?Math.max(0,Math.min(1,((body.xMm-from.xMm)*dx+(body.zMm-from.zMm)*dz)/length2)):0;return Math.hypot(from.xMm+dx*t-body.xMm,from.zMm+dz*t-body.zMm)<radius+body.radiusMm;});}
}
type Internals={movementUnits:UnitSpatialIndex;addUnit(ownerId:string,typeId:'villager',point:Position):Unit};
function fixture():Simulation{
  const sim=createSimulation({matchId:'movement-storage',seed:'movement-storage',controllers:false,factions:[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'}]});
  const prior=Object.values(sim.state.entities),template=prior.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!;
  const buildings=prior.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center');
  sim.state.entities={};sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const [index,building]of buildings.entries()){building.xMm=30000+index*70000;building.zMm=30000;sim.state.entities[building.id]=building;}
  for(let index=0;index<4;index++){const unit:Unit={...structuredClone(template),id:`worker_${index}`,ownerId:'a',xMm:39000,zMm:26000+index*2400,autoGather:false,stance:'stand_ground',orders:[],path:[]};sim.state.entities[unit.id]=unit;}
  for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
  sim.step();return sim;
}
function assertRoster(sim:Simulation):void{
  const index=(sim as unknown as Internals).movementUnits,expected=Object.values(sim.state.entities).filter((entity):entity is Unit=>entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn).map(entity=>({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,radiusMm:units[entity.typeId].collisionRadiusM*1000})).sort((a,b)=>a.id.localeCompare(b.id));
  expect(index.nearby({xMm:sim.state.widthMm/2,zMm:sim.state.heightMm/2},sim.state.widthMm+sim.state.heightMm)).toEqual(expected);
}

describe('persistent numeric movement ownership',()=>{
  it('proves an unchanged positive work reservation without recreating a released or replaced claim',()=>{
    const reservations=new ApproachReservations(),point={xMm:1000,zMm:2000};reservations.claim('worker','target',350,[point],()=>true);const before=reservations.exportState();
    expect(reservations.matchesClaim('worker','target',350,{...point})).toBe(true);expect(reservations.matchesClaim('worker','other',350,point)).toBe(false);expect(reservations.matchesClaim('worker','target',351,point)).toBe(false);expect(reservations.matchesClaim('worker','target',350,{...point,xMm:1001})).toBe(false);expect(reservations.exportState()).toEqual(before);
    const cold=new ApproachReservations();cold.importState(before);expect(cold.matchesClaim('worker','target',350,point)).toBe(true);cold.release('worker');expect(cold.matchesClaim('worker','target',350,point)).toBe(false);cold.claim('worker','other',350,[point],()=>true);expect(cold.matchesClaim('worker','target',350,point)).toBe(false);
  });
  it('keeps exact fractions, signed fallback coordinates, lexical order and stale-handle rejection across slot growth/reuse',()=>{
    const index=new UnitSpatialIndex(),reference=new ReferenceIndex();
    for(let i=0;i<300;i++){const body={id:`unit_${i}`,xMm:i*300.25,zMm:(i%4)*350.5,radiusMm:i%3?350.25:900.5};index.set(body);reference.set(body);}
    for(const point of [{xMm:0,zMm:0},{xMm:8000,zMm:1000},{xMm:80000,zMm:600}]){expect(index.nearby(point,4500)).toEqual(reference.nearby(point,4500));expect(index.clearLine(point,{xMm:point.xMm+5000,zMm:point.zMm+2000},350.25)).toBe(reference.clearLine(point,{xMm:point.xMm+5000,zMm:point.zMm+2000},350.25));}
    const handle=index.handle('unit_2')!,body=index.resolve(handle)!,snapshot=index.nearby(body,0);
    index.update('unit_2',-4097*4000-.125,4096*4000+.25,150.75,7);
    expect(index.resolve(handle)).toBe(body);expect(index.body('unit_2')).toMatchObject({xMm:-4097*4000-.125,radiusMm:150.75});expect(snapshot.find(value=>value.id==='unit_2')!.xMm).toBe(600.5);
    index.delete('unit_2');expect(index.resolve(handle)).toBeUndefined();index.update('replacement',1000,1000,350);
    expect(index.handle('replacement')!.slot).toBe(handle.slot);expect(index.handle('replacement')!.generation).toBeGreaterThan(handle.generation);expect(index.resolve(handle)).toBeUndefined();
  });
  it('reuses retained bodies and nested query scratch without leaking query lifetime',()=>{
    const index=new UnitSpatialIndex();for(const id of ['unit_2','unit_10','unit_1'])index.update(id,1000,1000,350);
    const body=index.body('unit_2');index.update('unit_2',1000,1000,350,8);expect(index.body('unit_2')).toBe(body);
    let prior:readonly MovementBody[]|undefined;
    index.withNearby({xMm:1000,zMm:1000},10,outer=>{prior=outer;expect(outer.map(value=>value.id)).toEqual(['unit_1','unit_10','unit_2']);index.withNearby({xMm:0,zMm:0},0,inner=>{expect(inner).not.toBe(outer);expect(inner).toHaveLength(0);});expect(outer).toHaveLength(3);});
    index.withNearby({xMm:1000,zMm:1000},10,next=>expect(next).toBe(prior));
    expect(index.free({xMm:1700,zMm:1000},350)).toBe(true);expect(index.free({xMm:1699,zMm:1000},350)).toBe(false);
  });
  it('maintains immediate spawn, garrison/ejection, death, external replacement and cold restoration occupancy',()=>{
    const sim=fixture(),internal=sim as unknown as Internals,home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const spawned=internal.addUnit('a','villager',{xMm:46000,zMm:32000});spawned.autoGather=false;expect(internal.movementUnits.body(spawned.id)).toMatchObject({xMm:46000,zMm:32000});
    const worker=sim.state.entities.worker_0 as Unit;worker.xMm=home.xMm+6700;worker.zMm=home.zMm;worker.orders=[{kind:'garrison',targetId:home.id}];
    for(let tick=0;tick<60&&!worker.garrisonedIn;tick++)sim.step();expect(worker.garrisonedIn).toBe(home.id);expect(internal.movementUnits.body(worker.id)).toBeUndefined();assertRoster(sim);
    home.pendingUngarrison=[worker.id];sim.step();expect(worker.garrisonedIn).toBeUndefined();assertRoster(sim);
    spawned.hp=0;sim.step();expect(internal.movementUnits.body(spawned.id)).toBeUndefined();
    const stale=internal.movementUnits.handle(worker.id)!;delete sim.state.entities[worker.id];sim.state.entities.replacement={...structuredClone(worker),id:'replacement',xMm:47000,zMm:30000};
    (sim.state.entities.worker_1 as Unit).xMm=48000;sim.step();expect(internal.movementUnits.resolve(stale)).toBeUndefined();assertRoster(sim);
    const replaced=internal.movementUnits.handle('worker_1')!;sim.state.entities.worker_1={...structuredClone(sim.state.entities.worker_1!),xMm:49000};sim.step();expect(internal.movementUnits.resolve(replaced)).toBeUndefined();assertRoster(sim);
    const restored=new Simulation(sim.options,sim.capture());sim.step(2);restored.step(2);assertRoster(restored);expect(restored.capture()).toEqual(sim.capture());
  });
  it('preserves complete movement/capture results against copied-body collision semantics',()=>{
    const actual=fixture(),reference=new Simulation(actual.options,actual.capture());(reference as unknown as Internals).movementUnits=new ReferenceIndex();
    for(const sim of [actual,reference])for(const entity of Object.values(sim.state.entities))if(entity.kind==='unit'){entity.orders=[{kind:'move',target:{xMm:48000,zMm:29000}}];entity.path=[];}
    for(let tick=0;tick<80;tick++){actual.step();reference.step();if(tick%10===0){assertRoster(actual);expect(actual.capture()).toEqual(reference.capture());}}
    expect(actual.capture()).toEqual(reference.capture());
  });
});

describe('lazy native attack arrival candidates',()=>{
  it('constructs candidates only after a prior slot fails, with identical legality and reservation order',()=>{
    const lazy=new ApproachReservations(),eager=new ApproachReservations(),points=[{xMm:1000,zMm:1000},{xMm:3000,zMm:1000},{xMm:5000,zMm:1000}];
    let prepared=0,blocked=-1;
    const claim=(id:string,key:string)=>{
      const left:number[]=[],right:number[]=[],actual=lazy.claimLazy(id,key,350,()=>{prepared++;return points;},point=>{left.push(point.xMm);return point.xMm!==blocked;});
      const expected=eager.claim(id,key,350,points,point=>{right.push(point.xMm);return point.xMm!==blocked;});
      expect(actual).toEqual(expected);expect(left).toEqual(right);expect(lazy.exportState()).toEqual(eager.exportState());return actual;
    };
    expect(claim('first','target')).toEqual(points[0]);for(let i=0;i<6;i++)expect(claim('first','target')).toEqual(points[0]);expect(prepared).toBe(1);
    expect(claim('second','target')).toEqual(points[1]);expect(prepared).toBe(2);
    blocked=1000;expect(claim('first','target')).toEqual(points[2]);expect(prepared).toBe(3);
    expect(claim('first','target-moved')).toEqual(points[2]);expect(prepared).toBe(4);
    const cold=new ApproachReservations();cold.importState(lazy.exportState());expect(cold.claimLazy('first','target-moved',350,()=>{throw new Error('UNNEEDED_CANDIDATES');},()=>true)).toEqual(points[2]);
  });
  it.each(['unit','building','ground'] as const)('retains exact %s arrival positions through target keys, range research and current slot invalidation',kind=>{
    type Probe={liveOwned:boolean;coarseFrame:boolean;attackDestination(unit:Unit,target:Unit|Building|Position):Position|undefined;planningNav(owner:string):Navigation;occupied(point:Position,radius:number,except?:string,viewer?:string):boolean;combatDistance(a:Unit|Building,b:Unit|Building):number;reservations(owner:string):ApproachReservations};
    function setup(native:boolean){
      const sim=fixture(),probe=sim as unknown as Probe,attacker=sim.state.entities.worker_0 as Unit;attacker.typeId='archer';attacker.xMm=40000;attacker.zMm=30000;
      const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
      const target:Unit|Building|Position=kind==='ground'?{xMm:70000,zMm:30000}:kind==='unit'?{...structuredClone(attacker),id:'attack_target',ownerId:'b',xMm:70000,zMm:30000}:{...structuredClone(home),id:'attack_target',ownerId:'b',xMm:70000,zMm:30000,rotation:90};
      let calculations=0,occupied:Position|undefined,nav=new Navigation(sim.state.widthMm,sim.state.heightMm,[]);const combat=probe.combatDistance.bind(sim);
      // Controlled private component evidence; factory-owned frame/cold/replay
      // parity is exercised separately in coarse-frame.test.ts.
      probe.liveOwned=native;probe.coarseFrame=true;probe.planningNav=()=>nav;probe.occupied=point=>Boolean(occupied&&point.xMm===occupied.xMm&&point.zMm===occupied.zMm);probe.combatDistance=(a,b)=>{calculations++;return combat(a,b);};
      return {sim,probe,attacker,target,count:()=>calculations,block:(point:Position)=>{occupied=point;},wall:(point:Position)=>{nav=new Navigation(sim.state.widthMm,sim.state.heightMm,[{id:'new-wall',...point,halfWidth:100,halfHeight:100}]);}};
    }
    const native=setup(true),scalar=setup(false),claim=()=>{const actual=native.probe.attackDestination(native.attacker,native.target),expected=scalar.probe.attackDestination(scalar.attacker,scalar.target);expect(actual).toEqual(expected);expect(native.probe.reservations('a').exportState()).toEqual(scalar.probe.reservations('a').exportState());return actual!;};
    const first=claim();expect(first).toBeDefined();for(let i=0;i<6;i++)expect(claim()).toEqual(first);
    if(kind!=='ground'){expect(native.count()).toBe(32);expect(scalar.count()).toBe(224);}
    for(const item of [native,scalar])item.target.xMm+=200;
    const within=claim();if(kind!=='ground')expect(within).toEqual(first);
    for(const item of [native,scalar]){item.target.xMm+=400;item.sim.state.economies.a!.technologies.push('fletching_1');item.sim.state.economies.a!.researchRevision++;}
    const moved=claim();expect(moved).not.toEqual(first);
    for(const item of [native,scalar])item.block(moved);const replacement=claim();expect(replacement).not.toEqual(moved);
    for(const item of [native,scalar])item.wall(replacement);expect(claim()).not.toEqual(replacement);
  });
});

describe('short certified movement corridors',()=>{
  it.each(['neighbor','wall','arrival'] as const)('proves two exact contact positions when the full five-step corridor is unsafe near a %s',reason=>{
    const obstacles=reason==='wall'?[{id:'distant_wall',xMm:9350,zMm:8000,halfWidth:50,halfHeight:3000}]:[],navigation=createOwnedNavigation(40000,40000,obstacles),index=new UnitSpatialIndex(),avoidance=new LocalAvoidance(),speed=200,target={xMm:reason==='arrival'?9100:20000,zMm:8000};let body={id:'mover',xMm:8000,zMm:8000,radiusMm:350};index.set(body);
    if(reason==='neighbor')index.set({id:'approaching',xMm:11000,zMm:10000,radiusMm:350});
    avoidance.beginTick(1,0);const first=avoidance.step(body,target,speed,navigation,index)!;expect(first).toEqual({xMm:8200,zMm:8000});body={...body,...first};index.set(body);
    const before=avoidance.exportState();expect(avoidance.prepareStraightFlight(body,target,speed,5,600,navigation,index)).toBeUndefined();
    const prefix=avoidance.prepareStraightFlight(body,target,speed,2,600,navigation,index)!;expect(prefix).toEqual([{xMm:8400,zMm:8000},{xMm:8600,zMm:8000}]);expect(avoidance.exportState()).toEqual(before);
    const scalar=new LocalAvoidance();scalar.importState(before);
    for(const [offset,point]of prefix.entries()){
      if(reason==='neighbor'){const neighbor=index.body('approaching')!,dx=body.xMm-neighbor.xMm,dz=body.zMm-neighbor.zMm,distance=Math.hypot(dx,dz);index.set({...neighbor,xMm:neighbor.xMm+Math.round(dx/distance*600),zMm:neighbor.zMm+Math.round(dz/distance*600)});}
      scalar.beginTick(2+offset,0);avoidance.beginTick(2+offset,0);expect(scalar.step(body,target,speed,navigation,index)).toEqual(point);expect(avoidance.continueProvenStraight(body,target,point)).toBe(true);expect(avoidance.exportState()).toEqual(scalar.exportState());expect(navigation.clearLine(body,point,body.radiusMm)).toBe(true);expect(index.clearLine(body,point,body.radiusMm,body.id)).toBe(true);body={...body,...point};index.set(body);
    }
  });
});

describe('native direct-step collision batches',()=>{
  const scratch=(index:UnitSpatialIndex)=>(index as unknown as {directSweepScratch:number[][]}).directSweepScratch;
  const scalar=(index:UnitSpatialIndex,body:MovementBody,choices:readonly Position[],navigation:Navigation)=>choices.find(point=>navigation.clearLine(body,point,body.radiusMm)&&index.clearLine(body,point,body.radiusMm,body.id));

  it('keeps strict tangency, zero-length and floor/ceil candidate order exact with one bounded scratch',()=>{
    const navigation=createOwnedNavigation(40000,40000,[]),index=new UnitSpatialIndex(),body={id:'mover',xMm:10000,zMm:10000,radiusMm:350};index.set(body);index.set({id:'blocker',xMm:10850,zMm:10000,radiusMm:350});
    const choices=[{xMm:10151,zMm:10000},{xMm:10150,zMm:10000},{xMm:10150,zMm:10001},{xMm:10149,zMm:10000}];
    expect(index.firstClearCandidate(body,choices,navigation,true)).toBe(choices[1]);expect(scalar(index,body,choices,navigation)).toBe(choices[1]);expect(scratch(index)).toEqual([[]]);
    const retained=scratch(index)[0];
    for(const radiusMm of [0,350,351,350.5])for(const candidates of [[{xMm:10000,zMm:10000},{xMm:10001,zMm:10000}],choices,[{xMm:10150,zMm:10001},{xMm:10150,zMm:9999}]]){
      const current={...body,radiusMm};expect(index.firstClearCandidate(current,candidates,navigation,true)).toEqual(scalar(index,current,candidates,navigation));
    }
    expect(scratch(index)[0]).toBe(retained);
  });

  it('matches the independent sweep oracle at signed cell edges and after radius, removal and spawn changes',()=>{
    const navigation=createOwnedNavigation(80000,80000,[{id:'wall',xMm:20000,zMm:20000,halfWidth:750,halfHeight:3000}]),index=new UnitSpatialIndex(),reference=new ReferenceIndex();
    for(let i=0;i<40;i++){const body={id:`neighbor_${i}`,xMm:3500+(i*977)%18000,zMm:3500+(i*571)%18000,radiusMm:[0,350,900][i%3]!};index.set(body);reference.set(body);}
    for(let i=0;i<80;i++){
      const body={id:'mover',xMm:[3999,4000,7999,8000,15999][i%5]!+(i%3),zMm:4000+(i*433)%16000,radiusMm:[0,350,900][i%3]!},choices=Array.from({length:4},(_,choice)=>({xMm:body.xMm+149+(choice%2),zMm:body.zMm-100+Math.floor(choice/2)}));index.set(body);reference.set(body);
      expect(index.firstClearCandidate(body,choices,navigation,true)).toEqual(scalar(reference,body,choices,navigation));
      if(i===30){index.delete('neighbor_3');reference.delete('neighbor_3');index.update('neighbor_4',8100,4000,1700);reference.update('neighbor_4',8100,4000,1700);}
      if(i===50){const spawn={id:'new',xMm:8000,zMm:4000,radiusMm:2000};index.set(spawn);reference.set(spawn);}
    }
    expect(scratch(index)).toEqual([[]]);
  });

  it('retains exact static-first calls and mutations for custom navigation and collision readers',()=>{
    function run(native:boolean){
      const events:string[]=[],index=new UnitSpatialIndex(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},choices=[{xMm:8100,zMm:8000},{xMm:8101,zMm:8000},{xMm:8102,zMm:8000}],original=index.clearLine;
      index.set(body);
      const navigation=new Navigation(40000,40000,[]);
      navigation.clearLine=(_from,to)=>{events.push(`static:${to.xMm}`);index.set({id:'changing',xMm:to.xMm+699,zMm:8000,radiusMm:350});if(to.xMm===8102)index.delete('changing');return to.xMm!==8100;};
      index.clearLine=function(from,to,radius,except){events.push(`dynamic:${to.xMm}`);return original.call(this,from,to,radius,except);};
      const result=native?index.firstClearCandidate(body,choices,navigation,true):scalar(index,body,choices,navigation);
      return {result,events,scratch:scratch(index)};
    }
    const expected=run(false);expect(expected.events).toEqual(['static:8100','static:8101','dynamic:8101','static:8102','dynamic:8102']);expect(run(true)).toEqual(expected);
    const owned=createOwnedNavigation(40000,40000,[]),index=new UnitSpatialIndex(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},calls:number[]=[];
    index.clearLine=(_from,to)=>{calls.push(to.xMm);return calls.length===2;};
    expect(index.firstClearCandidate(body,[{xMm:8001,zMm:8000},{xMm:8002,zMm:8000}],owned,true)).toEqual({xMm:8002,zMm:8000});expect(calls).toEqual([8001,8002]);expect(scratch(index)).toEqual([]);
  });

  it('does not swallow custom failures or change budgeted query charges',()=>{
    const body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},choices=[{xMm:8100,zMm:8000},{xMm:8101,zMm:8000}],events:string[]=[],index=new UnitSpatialIndex(),navigation=new Navigation(40000,40000,[]);
    navigation.clearLine=(_from,to)=>{events.push(`static:${to.xMm}`);if(to.xMm===8101)throw new Error('CUSTOM_SWEEP');return false;};
    expect(()=>index.firstClearCandidate(body,choices,navigation,true)).toThrow('CUSTOM_SWEEP');expect(events).toEqual(['static:8100','static:8101']);expect(scratch(index)).toEqual([]);
    const budgets=[{remaining:100,used:0},{remaining:100,used:0}],left=createOwnedNavigation(40000,40000,[],30000,1000,budgets[0]),right=createOwnedNavigation(40000,40000,[],30000,1000,budgets[1]);
    expect(index.firstClearCandidate(body,choices,left,true)).toEqual(scalar(index,body,choices,right));expect(budgets[0]).toEqual(budgets[1]);expect(scratch(index)).toEqual([]);
  });

  it('preserves accessor IDs and accessor/proxy candidate arrays on the scalar fallback',()=>{
    const navigation=createOwnedNavigation(40000,40000,[]);
    for(const variant of ['id','candidate','proxy'] as const){
      function run(native:boolean){
        const reads:string[]=[],index=new UnitSpatialIndex(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350};
        index.set(body);index.set({id:'blocker',xMm:8799,zMm:8000,radiusMm:350});
        let choices:Position[]=[{xMm:8100,zMm:8000},{xMm:8000,zMm:8100}];
        if(variant==='id')Object.defineProperty(body,'id',{get(){reads.push('id');return 'mover';},enumerable:true});
        if(variant==='candidate'){const first=choices[0]!;Object.defineProperty(choices,'0',{get(){reads.push('candidate');return first;},enumerable:true,configurable:true});}
        if(variant==='proxy')choices=new Proxy(choices,{get(target,key,receiver){reads.push(String(key));return Reflect.get(target,key,receiver);}});
        const result=native?index.firstClearCandidate(body,choices,navigation,true):scalar(index,body,choices,navigation);
        return {result,reads,scratch:scratch(index)};
      }
      expect(run(true),variant).toEqual(run(false));
    }
  });

  it('keeps direct-sweep scratch isolated inside nested ordinary queries and fresh after overflow',()=>{
    const navigation=createOwnedNavigation(40000,40000,[]),index=new UnitSpatialIndex(),body={id:'mover',xMm:8000,zMm:8000,radiusMm:350},choices=[{xMm:8100,zMm:8001},{xMm:8101,zMm:8000}];index.set(body);index.set({id:'nearby',xMm:10000,zMm:8000,radiusMm:350});
    index.withNearby(body,3000,outer=>{const before=outer.map(value=>({...value}));const next=index.firstClearCandidate(body,choices,navigation,true)!;expect(next).toEqual(scalar(index,body,choices,navigation));index.withNearby(body,100,inner=>expect(inner).not.toBe(outer));expect(outer).toEqual(before);expect(scratch(index)).toEqual([[]]);});
    for(let i=0;i<2201;i++)index.set({id:`crowd_${i}`,xMm:body.xMm,zMm:body.zMm,radiusMm:1});
    expect(index.firstClearCandidate(body,choices,navigation,true)).toEqual(scalar(index,body,choices,navigation));expect(scratch(index)).toEqual([[]]);
    for(let i=0;i<2201;i++)index.delete(`crowd_${i}`);
    expect(index.firstClearCandidate(body,choices,navigation,true)).toBe(choices[0]);
  });

  it('preserves local avoidance state and integer positions through blocked steps and continuations',()=>{
    const navigation=createOwnedNavigation(40000,40000,[]),normal=new LocalAvoidance(),batched=new LocalAvoidance(),left=new UnitSpatialIndex(),right=new UnitSpatialIndex(),target={xMm:20000,zMm:15113};let body={id:'mover',xMm:8000,zMm:8000,radiusMm:350};
    for(const index of [left,right]){index.set(body);index.set({id:'blocker',xMm:8800,zMm:8450,radiusMm:350});}
    for(let tick=1;tick<=24;tick++){
      normal.beginTick(tick,0);batched.beginTick(tick,0);
      if(tick===12)for(const index of [left,right])index.delete('blocker');
      const expected=normal.step(body,target,151,navigation,left),continued=tick>12?batched.continueStraight(body,target,151,navigation,right,true):undefined;
      const next=continued??batched.step(body,target,151,navigation,right,navigation,undefined,undefined,undefined,true);
      expect(next).toEqual(expected);expect(batched.exportState()).toEqual(normal.exportState());
      if(next){body={...body,...next};left.set(body);right.set(body);}
    }
  });
});
