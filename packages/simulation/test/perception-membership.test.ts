import { describe, expect, it } from 'vitest';
import { balance, units, type ViewEntity } from '@frontier/shared';
import { Simulation, createSimulation, type Building, type Entity, type ResourceNode, type Unit } from '../src/index.js';
import { PerceptionMembership } from '../src/perception-membership.js';
import { updateObservedActions, type CommittedAction } from '../src/observed-actions.js';
import type { VisionMaskResult } from '../src/vision-mask-kernel.js';

interface ScalarInternals {visibilityMasks:Map<string,Uint8Array>;committedActions:Map<string,CommittedAction>;visible(playerId:string,entity:Entity|ViewEntity):boolean;asView(entity:Entity,own:boolean,playerId:string):ViewEntity;visionGroup(playerId:string):string;commitVision(results:VisionMaskResult[]):void;observeActions():void}
/** Previous complete per-recipient derivation, independent of dependency caches. */
function scalar(sim:Simulation):void{
  const internal=sim as unknown as ScalarInternals;
  internal.commitVision=results=>{
    const groups=new Map(results.map(result=>[result.key,result]));
    for(const faction of sim.state.factions)internal.visibilityMasks.set(faction.id,groups.get(internal.visionGroup(faction.id))!.mask);
    for(const faction of sim.state.factions){
      const vision=sim.state.vision[faction.id]!,result=groups.get(internal.visionGroup(faction.id))!;
      vision.explored=[...new Set([...vision.explored,...result.visible])].sort((a,b)=>a-b);vision.visible=[...result.visible];
      for(const id of Object.keys(vision.memory))if(!sim.state.entities[id]&&internal.visible(faction.id,vision.memory[id]!))delete vision.memory[id];
      for(const entity of Object.values(sim.state.entities))if(entity.kind!=='unit'&&entity.ownerId!==faction.id&&internal.visible(faction.id,entity)){const view=internal.asView(entity,false,faction.id);view.lastSeenTick=sim.state.tick;vision.memory[entity.id]=view;}
    }
  };
  internal.observeActions=()=>updateObservedActions(sim.state,internal.committedActions,(playerId,entity)=>internal.visible(playerId,entity),Object.values(sim.state.entities));
}
function fixture(shared=true):Simulation{
  const sim=createSimulation({matchId:'incremental-perception',seed:'incremental-perception',sharedVision:shared,controllers:false,factions:[{id:'a',name:'A',teamId:'allies',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'enemy',kind:'human',color:'#ff8844'},{id:'c',name:'C',teamId:'allies',kind:'human',color:'#33ff88'}]}),prior=Object.values(sim.state.entities);
  const template=prior.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='scout')!,wood=prior.find((entity):entity is ResourceNode=>entity.kind==='resource'&&entity.resource==='wood')!;
  sim.state.entities={};sim.state.widthMm=120000;sim.state.heightMm=120000;sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const [index,home]of prior.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center').entries()){home.xMm=20000+index*40000;home.zMm=100000;sim.state.entities[home.id]=home;}
  for(const [id,ownerId,xMm,zMm]of [['scout_a','a',40000,40000],['scout_b','b',56000,40000],['scout_c','c',80000,40000]] as const){sim.state.entities[id]={...structuredClone(template),id,ownerId,xMm,zMm,stance:'stand_ground',autoGather:false,orders:[],path:[],cargo:{resource:null,amount:0}};}
  for(let index=0;index<8;index++){const node={...structuredClone(wood),id:`wood_${index}`,xMm:40000+index*3000,zMm:47000,amount:100000};sim.state.entities[node.id]=node;}
  for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
  sim.step();return sim;
}
function mutate(sim:Simulation,tick:number):void{
  const unit=sim.state.entities.scout_a as Unit,node=sim.state.entities.wood_2 as ResourceNode;
  if(tick===5){unit.cargo={resource:'wood',amount:7000};node.amount-=1500;node.hp=0;}
  if(tick===10){unit.orders=[{kind:'move',target:{xMm:45000,zMm:35000}}];}
  if(tick===35){unit.orders=[];unit.path=[];unit.cargo={resource:null,amount:0};}
  if(tick===50){const other=sim.state.entities.scout_c as Unit;other.ownerId='b';}
  if(tick===65){unit.xMm=15000;unit.zMm=40000;}
  if(tick===80){node.amount=0;(sim.state.entities.scout_b as Unit).hp=0;sim.state.navigationRevision++;}
  if(tick===95){unit.xMm=40000;unit.zMm=40000;}
  if(tick===110){const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;unit.garrisonedIn=home.id;home.garrisoned=[unit.id];unit.xMm=home.xMm;unit.zMm=home.zMm;}
  if(tick===130){const home=sim.state.entities[unit.garrisonedIn!] as Building;home.pendingUngarrison=[unit.id];}
  if(tick===150){const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='c')!;home.hp-=17;sim.state.economies.c!.age=2;}
}

describe('incremental authoritative perception dependencies',()=>{
  it('keeps planned sites owner-only and detects activation without rescanning static resources',()=>{
    const membership=new PerceptionMembership(),site:Building={id:'planned_site',ownerId:'a',kind:'building',typeId:'house',xMm:8000,zMm:8000,rotation:0,hp:90,maxHp:900,work:0,required:100,grantedHp:90,cooldown:0,queue:[],pendingConstruction:{clearanceMm:0}};
    const resources:ResourceNode[]=Array.from({length:32},(_,index)=>({id:`resource_${index}`,kind:'resource',ownerId:null,typeId:'gold_deposit',resource:'gold',xMm:1000+index%8*2000,zMm:18000+Math.floor(index/8)*2000,hp:1,maxHp:1,amount:100000}));
    const world:Entity[]=[site,...resources],actors=[site],mask=new Uint8Array(16*16).fill(1),results=[{key:'all',mask}];
    expect(membership.synchronizeOwned(world,actors,32000,32000,1)).toBe(true);membership.commit(results);
    expect(membership.visible('all',site.id)).toBe(false);expect(membership.actors('all','a')).toContain(site);expect(membership.actors('all','b')).not.toContain(site);
    const before=membership.inventory().reconciled;delete site.pendingConstruction;
    expect(membership.synchronizeOwned(world,actors,32000,32000,1)).toBe(true);membership.commit(results);
    expect(membership.inventory().reconciled-before).toBe(1);expect(membership.visible('all',site.id)).toBe(true);expect(membership.actors('all','b')).toContain(site);
    site.pendingConstruction={clearanceMm:0};expect(membership.synchronizeOwned(world,actors,32000,32000,1)).toBe(true);membership.commit(results);
    expect(membership.visible('all',site.id)).toBe(false);expect(membership.actors('all','b')).not.toContain(site);expect(membership.statics('all','a')).toContain(site);
  });
  it('reuses completed native perception for repeated publication while retaining exact recipient views',async()=>{
    const source=fixture(),options={...source.options,authoritativeIntervalMs:300 as const},payload=source.capture(),actual=new Simulation(options,payload),expected=new Simulation(options,payload);
    const internal=actual as unknown as {liveOwned:boolean;perceptionMembership:PerceptionMembership};internal.liveOwned=true;
    for(const sim of [actual,expected]){sim.advanceFrame();await sim.synchronizeCapture();}
    const before=internal.perceptionMembership.inventory().reconciled;
    for(let sequence=1;sequence<=3;sequence++){
      const requests=actual.state.factions.map(faction=>({playerId:faction.id,sequence}));
      expect(actual.publicationProjections(requests)).toEqual(expected.publicationProjections(requests));
    }
    expect(internal.perceptionMembership.inventory().reconciled).toBe(before);
    expect(actual.capture()).toEqual(expected.capture());
  });
  it('reconciles boundary publication after an epoch change or a new static roster',async()=>{
    const source=fixture(),options={...source.options,authoritativeIntervalMs:300 as const},payload=source.capture(),actual=new Simulation(options,payload),expected=new Simulation(options,payload);
    type Internal={liveOwned:boolean;perceptionMembership:PerceptionMembership;addBuilding(owner:string,type:'house',point:{xMm:number;zMm:number},rotation:0,complete:boolean):Building};
    const internal=actual as unknown as Internal;internal.liveOwned=true;
    for(const sim of [actual,expected]){sim.advanceFrame();await sim.synchronizeCapture();}
    const before=internal.perceptionMembership.inventory().reconciled;
    for(const sim of [actual,expected])sim.invalidateEpoch();
    const requests=actual.state.factions.map(faction=>({playerId:faction.id,sequence:1}));
    expect(actual.publicationProjections(requests)).toEqual(expected.publicationProjections(requests));
    expect(internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(before);
    for(const sim of [actual,expected]){sim.advanceFrame();await sim.synchronizeCapture();}
    const afterFrame=internal.perceptionMembership.inventory().reconciled;
    for(const sim of [actual,expected])(sim as unknown as Internal).addBuilding('a','house',{xMm:34000,zMm:100000},0,false);
    expect(actual.publicationProjections(requests.map(request=>({...request,sequence:2})))).toEqual(expected.publicationProjections(requests.map(request=>({...request,sequence:2}))));
    expect(internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(afterFrame);
    expect(actual.capture()).toEqual(expected.capture());
  });
  it('schedules entered and dirty resources in world order without consuming another recipient cursor',()=>{
    const sim=fixture(true),index=new PerceptionMembership(),tree=sim.state.entities.wood_0 as ResourceNode,building=Object.values(sim.state.entities).find((e):e is Building=>e.kind==='building')!;
    const a={...tree,id:'observation_a',xMm:20000,zMm:20000},b={...building,id:'observation_building',xMm:40000,zMm:20000},c={...tree,id:'observation_c',xMm:60000,zMm:20000},world:Entity[]=[a,b,c];
    expect(index.synchronize(world,120000,120000)).toBe(true);const all=new Uint8Array(3600).fill(1);index.commit([{key:'shared',mask:all}]);
    const first=index.resourceObservations('shared',undefined,new Set());expect(first.observations).toEqual(world);expect(first.resources).toEqual([a,c]);
    // Generic reads and same-mask commits leave recipient-specific deltas intact.
    index.visibleStatics('shared');index.commit([{key:'shared',mask:all}]);
    const unchanged=index.resourceObservations('shared',first.resources,new Set());expect(unchanged.resources).toBe(first.resources);expect(unchanged.observations).toEqual([b]);expect(unchanged.exited).toEqual([]);
    const changed=index.resourceObservations('shared',first.resources,new Set([a,c]));expect(changed.observations).toEqual(world);
    const hidden=all.slice();for(let z=0;z<60;z++)for(let x=0;x<20;x++)hidden[z*60+x]=0;index.commit([{key:'shared',mask:hidden}]);
    const compared=index.inventory().resourceCompared;
    for(let recipient=0;recipient<2;recipient++){const next=index.resourceObservations('shared',first.resources,new Set([a,c]));expect(next.exited).toEqual([a]);expect(next.observations).toEqual([b,c]);}
    expect(index.inventory().resourceCompared-compared).toBe(1);
    const next=index.resourceObservations('shared',first.resources,new Set());index.commit([{key:'shared',mask:all}]);expect(index.resourceObservations('shared',next.resources,new Set()).observations).toEqual([a,b]);
    // An older recipient missed both transitions. Its unsupported cursor uses
    // the conservative set comparison and must not fabricate a new entry.
    expect(index.resourceObservations('shared',first.resources,new Set()).observations).toEqual([b]);
  });
  it('reconciles removed/replaced resource identities and building-only changes without invalidating resource rosters',()=>{
    const sim=fixture(false),index=new PerceptionMembership(),tree=sim.state.entities.wood_0 as ResourceNode,building=Object.values(sim.state.entities).find((e):e is Building=>e.kind==='building')!,mask=new Uint8Array(3600).fill(1);
    let world:Entity[]=[tree,building];index.synchronize(world,120000,120000);index.commit([{key:'a',mask}]);const first=index.resourceObservations('a',undefined,new Set());
    building.xMm+=4000;index.synchronize(world,120000,120000);index.commit([{key:'a',mask}]);expect(index.resourceObservations('a',first.resources,new Set()).resources).toBe(first.resources);
    const replacement={...tree};world=[replacement,building];index.synchronize(world,120000,120000);index.commit([{key:'a',mask}]);const replaced=index.resourceObservations('a',first.resources,new Set([tree]));expect(replaced.exited).toEqual([tree]);expect(replaced.observations).toEqual(world);
    world=[building];index.synchronize(world,120000,120000);index.commit([{key:'a',mask}]);const removed=index.resourceObservations('a',replaced.resources,new Set([replacement]));expect(removed.exited).toEqual([replacement]);expect(removed.observations).toEqual([building]);
  });
  function assertScalarMembers(index:PerceptionMembership,sim:Simulation,world:Entity[],mask:Uint8Array):void{
    const internal=sim as unknown as ScalarInternals;internal.visibilityMasks.set('a',mask);
    index.commit([{key:'oracle',mask}]);
    // Independent established visibility predicate, plus explicit owned membership.
    expect(index.members('oracle')).toEqual(world.filter(entity=>internal.visible('a',entity)));
    expect(index.visibleStatics('oracle')).toEqual(world.filter(entity=>entity.kind!=='unit'&&internal.visible('a',entity)));
    for(const owner of ['a','b','c']){
      expect(index.recipients('oracle',owner)).toEqual(world.filter(entity=>entity.ownerId===owner||internal.visible('a',entity)));
      expect(index.actors('oracle',owner)).toEqual(world.filter(entity=>entity.kind!=='resource'&&(entity.ownerId===owner||internal.visible('a',entity))));
      expect(index.statics('oracle',owner)).toEqual(world.filter(entity=>entity.kind!=='unit'&&(entity.ownerId===owner||internal.visible('a',entity))));
    }
  }
  it('retains static roster identity through native unit births and deaths while matching full current fog and cold order',()=>{
    const sim=fixture(false),owned=new PerceptionMembership(),full=new PerceptionMembership(),template=sim.state.entities.wood_0 as ResourceNode;
    const original=Object.values(sim.state.entities).filter(entity=>entity.kind!=='resource'),unit=original.find((entity):entity is Unit=>entity.kind==='unit')!;
    const trees=Array.from({length:4640},(_,index)=>({...template,id:`lifetime_tree_${index}`,xMm:4000+index%20*1000,zMm:4000+Math.floor(index/20)%20*1000}));
    let world:Entity[]=[...original,...trees],mask=new Uint8Array(60*60).fill(1),revision=1;
    const check=(visits:number)=>{
      const actors=world.filter(entity=>entity.kind!=='resource'),before=owned.inventory().reconciled;
      expect(owned.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm,revision)).toBe(true);expect(owned.inventory().reconciled-before).toBe(visits);
      expect(full.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);
      for(const index of [owned,full])index.commit([{key:'lifetime',mask}]);
      expect(owned.members('lifetime')).toEqual(full.members('lifetime'));expect(owned.visibleStatics('lifetime')).toEqual(full.visibleStatics('lifetime'));
      for(const playerId of ['a','b','c'])for(const select of ['actors','statics','recipients'] as const)expect(owned[select]('lifetime',playerId)).toEqual(full[select]('lifetime',playerId));
      expect(owned.inventory().entities).toBe(world.length);expect(owned.inventory().cells).toBe(full.inventory().cells);
    };
    check(world.length);const staticRoster=owned.visibleStatics('lifetime'),perOwner=['a','b','c'].map(id=>owned.statics('lifetime',id));
    world=world.filter(entity=>entity!==unit);check(original.length-1);
    expect(owned.visibleStatics('lifetime')).toBe(staticRoster);for(const [i,id]of ['a','b','c'].entries())expect(owned.statics('lifetime',id)).toBe(perOwner[i]);
    const born:Unit={...structuredClone(unit),id:'lifetime_birth',ownerId:'b',xMm:56000,zMm:40000};world=[...world,born];check(original.length);
    expect(owned.visibleStatics('lifetime')).toBe(staticRoster);for(const [i,id]of ['a','b','c'].entries())expect(owned.statics('lifetime',id)).toBe(perOwner[i]);
    // New fog and real current motion still change authorized actor membership.
    mask=new Uint8Array(60*60);for(let z=0;z<60;z++)for(let x=0;x<30;x++)mask[z*60+x]=1;check(original.length);expect(owned.actors('lifetime','a')).toContain(born);
    born.xMm=95000;check(original.length);expect(owned.actors('lifetime','a')).not.toContain(born);expect(owned.actors('lifetime','b')).toContain(born);
    born.xMm=56000;born.garrisonedIn='host';check(original.length);expect(owned.actors('lifetime','a')).not.toContain(born);delete born.garrisonedIn;check(original.length);expect(owned.actors('lifetime','a')).toContain(born);
    const cold=new PerceptionMembership();expect(cold.synchronizeOwned(world,world.filter(entity=>entity.kind!=='resource'),sim.state.widthMm,sim.state.heightMm,revision)).toBe(true);cold.commit([{key:'lifetime',mask}]);
    expect(cold.members('lifetime')).toEqual(owned.members('lifetime'));for(const id of ['a','b','c'])expect(cold.recipients('lifetime',id)).toEqual(owned.recipients('lifetime',id));
    const removed=trees[0]!;world=world.filter(entity=>entity!==removed);revision++;check(world.length);expect(owned.visibleStatics('lifetime')).not.toContain(removed);
  });
  it('uses full reconciliation for static revisions, nonappend actor order and resumed ownership after a generic mutation',()=>{
    const sim=fixture(false),index=new PerceptionMembership();let world=Object.values(sim.state.entities),revision=1;
    const mask=new Uint8Array(60*60).fill(1),check=(visits:number)=>{const before=index.inventory().reconciled;expect(index.synchronizeOwned(world,world.filter(entity=>entity.kind!=='resource'),sim.state.widthMm,sim.state.heightMm,revision)).toBe(true);expect(index.inventory().reconciled-before).toBe(visits);assertScalarMembers(index,sim,world,mask);};
    check(world.length);const template=world.find((entity):entity is Unit=>entity.kind==='unit')!;
    world=[{...structuredClone(template),id:'nonappend_actor'},...world];check(world.length);
    const building=world.find((entity):entity is Building=>entity.kind==='building')!,tree=world.find((entity):entity is ResourceNode=>entity.kind==='resource')!;
    building.rotation=90;tree.xMm+=7000;revision++;world=[...world];check(world.length);
    tree.zMm+=5000;expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);check(world.length);
    // Omitting the native static revision preserves the legacy full-world
    // reconciliation when externally mutable callers replace their world.
    world=[...world,{...structuredClone(template),id:'generic_birth'}];const before=index.inventory().reconciled;
    expect(index.synchronizeOwned(world,world.filter(entity=>entity.kind!=='resource'),sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(index.inventory().reconciled-before).toBe(world.length);assertScalarMembers(index,sim,world,mask);
  });
  it('reconciles only actors in an exclusively owned stable world while preserving full-scan membership',()=>{
    const sim=fixture(false),owned=new PerceptionMembership(),full=new PerceptionMembership();
    let world=Object.values(sim.state.entities),actors=world.filter(entity=>entity.kind!=='resource'),mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    const check=(expectedVisits:number)=>{
      const before=owned.inventory().reconciled;
      expect(owned.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);
      expect(owned.inventory().reconciled-before).toBe(expectedVisits);
      expect(full.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);
      for(const index of [owned,full])index.commit([{key:'same',mask}]);
      expect(owned.members('same')).toEqual(full.members('same'));expect(owned.visibleStatics('same')).toEqual(full.visibleStatics('same'));
      for(const playerId of ['a','b','c']){
        expect(owned.actors('same',playerId)).toEqual(full.actors('same',playerId));
        expect(owned.statics('same',playerId)).toEqual(full.statics('same',playerId));
        expect(owned.recipients('same',playerId)).toEqual(full.recipients('same',playerId));
      }
      expect(owned.inventory().entities).toBe(world.length);expect(owned.inventory().cells).toBe(full.inventory().cells);
    };
    check(world.length);const staticRoster=owned.visibleStatics('same');check(actors.length);expect(owned.visibleStatics('same')).toBe(staticRoster);
    const unit=sim.state.entities.scout_a as Unit,enemy=sim.state.entities.scout_b as Unit,home=actors.find((entity):entity is Building=>entity.kind==='building')!;
    unit.xMm+=7000;enemy.zMm+=9000;check(actors.length);
    mask=mask.slice();for(let cell=0;cell<mask.length;cell+=3)mask[cell]=0;check(actors.length);
    unit.garrisonedIn=home.id;check(actors.length);unit.ownerId='b';check(actors.length);delete unit.garrisonedIn;check(actors.length);
    home.rotation=90;home.ownerId='c';check(actors.length);
    // Actor traversal order cannot reorder the canonical world/recipient views.
    actors=[...actors].reverse();check(actors.length);
    const resource=world.find((entity):entity is ResourceNode=>entity.kind==='resource')!;resource.amount=0;check(actors.length);
    world=[{...unit,id:'owned_new_unit'},...world.filter(entity=>entity!==enemy&&entity!==resource)].reverse();actors=world.filter(entity=>entity.kind!=='resource');check(world.length);check(actors.length);
    sim.state.widthMm+=2000;mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);check(world.length);check(actors.length);
  });

  it('invalidates owned reuse after generic direct resource reconciliation or a failed actor scan',()=>{
    const sim=fixture(false),index=new PerceptionMembership(),world=Object.values(sim.state.entities),actors=world.filter(entity=>entity.kind!=='resource'),mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    expect(index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,world,mask);
    const resource=world.find((entity):entity is ResourceNode=>entity.kind==='resource')!;resource.xMm+=3000;resource.resource='gold';
    expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,world,mask);
    let before=index.inventory().reconciled;expect(index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(index.inventory().reconciled-before).toBe(world.length);
    before=index.inventory().reconciled;expect(index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(index.inventory().reconciled-before).toBe(actors.length);
    const duplicate=[actors[0]!,actors[0]!,...actors.slice(2)];expect(index.synchronizeOwned(world,duplicate,sim.state.widthMm,sim.state.heightMm)).toBe(false);
    before=index.inventory().reconciled;expect(index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(index.inventory().reconciled-before).toBe(world.length);assertScalarMembers(index,sim,world,mask);
    const actor=actors[0]!,xMm=actor.xMm;Object.defineProperty(actor,'xMm',{configurable:true,enumerable:true,get(){throw new Error('OWNED_READ_FAILED');}});
    try{expect(()=>index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toThrow('OWNED_READ_FAILED');}
    finally{Object.defineProperty(actor,'xMm',{configurable:true,enumerable:true,writable:true,value:xMm});}
    before=index.inventory().reconciled;expect(index.synchronizeOwned(world,actors,sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(index.inventory().reconciled-before).toBe(world.length);assertScalarMembers(index,sim,world,mask);
  });
  it('retains the ordered visible-plus-owned recipient union and invalidates its exact dependencies',()=>{
    const sim=fixture(false),internal=sim as unknown as ScalarInternals,index=new PerceptionMembership(),size=(sim.state.widthMm/(balance.rules.fogGridM*1000))**2;
    const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,unit=sim.state.entities.scout_a as Unit,enemy=sim.state.entities.scout_b as Unit,node=sim.state.entities.wood_0 as ResourceNode;
    let world:Entity[]=[node,unit,home,enemy],mask=new Uint8Array(size).fill(1);
    const reconcile=()=>{
      internal.visibilityMasks.set('a',mask);expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'recipient',mask}]);
      for(const owner of ['a','b'])expect(index.recipients('recipient',owner)).toEqual(world.filter(entity=>entity.ownerId===owner||internal.visible('a',entity)));
      return index.recipients('recipient','a');
    };
    let prior=reconcile();expect(prior).toEqual(world);expect(prior.filter(entity=>entity.id===home.id)).toHaveLength(1);expect(reconcile()).toBe(prior);
    // Presentation-only changes remain live without rebuilding membership.
    unit.hp=0;unit.cargo={resource:'gold',amount:7000};expect(reconcile()).toBe(prior);expect(prior[1]).toBe(unit);
    unit.garrisonedIn=home.id;prior=reconcile();expect(prior).toContain(unit);expect(index.recipients('recipient','b')).not.toContain(unit);
    mask=new Uint8Array(size);prior=reconcile();expect(prior).toEqual([unit,home]);expect(index.recipients('missing','a')).toEqual([unit,home]);
    enemy.ownerId='a';let current=reconcile();expect(current).not.toBe(prior);expect(current).toEqual([unit,home,enemy]);
    prior=current;world=[enemy,node,home,unit];current=reconcile();expect(current).not.toBe(prior);expect(current).toEqual([enemy,home,unit]);
    prior=current;world[0]={...enemy,hp:enemy.hp-1};current=reconcile();expect(current).not.toBe(prior);expect(current[0]).toBe(world[0]);
    world=world.slice(1);reconcile();expect(index.recipients('recipient','a')).toEqual([home,unit]);
    mask=new Uint8Array(size).fill(1);current=reconcile();expect(current).toEqual(world);
    const cold=new PerceptionMembership();cold.synchronize(world,sim.state.widthMm,sim.state.heightMm);cold.commit([{key:'recipient',mask}]);expect(cold.recipients('recipient','a')).toEqual(current);
    index.commit([]);expect(index.recipients('recipient','a')).toEqual([home,unit]);
  });
  it('preserves partial duplicate-ID failure, then prunes and orders the next valid scan exactly',()=>{
    const sim=fixture(),index=new PerceptionMembership(),world=Object.values(sim.state.entities),mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,world,mask);
    const changed={...world.find(entity=>entity.id==='wood_0')!,xMm:64000},added={...changed,id:'partial_new'},before=index.inventory();
    // The prefix is reconciled before the duplicate causes fallback. Unvisited
    // previous records survive, matching the original retained-Set algorithm.
    expect(index.synchronize([added,changed,{...changed}],sim.state.widthMm,sim.state.heightMm)).toBe(false);
    expect(index.inventory().reconciled-before.reconciled).toBe(2);expect(index.inventory().entities).toBe(world.length+1);
    const valid=[added,...world.filter(entity=>!['wood_0','wood_1'].includes(entity.id)).reverse(),changed];
    expect(index.synchronize(valid,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,valid,mask);expect(index.inventory().entities).toBe(valid.length);
    const cold=new PerceptionMembership();expect(cold.synchronize(valid,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(cold,sim,valid,mask);
    expect(index.members('oracle')).toEqual(cold.members('oracle'));expect(index.inventory().cells).toBe(cold.inventory().cells);
    // Reuse the same ID again in a later successful scan; no visit mark may leak.
    const restored=[world.find(entity=>entity.id==='wood_1')!,...valid.slice(1)];expect(index.synchronize(restored,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,restored,mask);
  });
  it('does not prune on a thrown source read and recovers on a subsequent valid scan',()=>{
    const sim=fixture(),index=new PerceptionMembership(),world=Object.values(sim.state.entities),mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    index.synchronize(world,sim.state.widthMm,sim.state.heightMm);assertScalarMembers(index,sim,world,mask);
    const source=world.find(entity=>entity.id==='wood_0')!,bad={...source},added={...source,id:'before_read_failure'},before=index.inventory();
    Object.defineProperty(bad,'xMm',{enumerable:true,get:()=>{throw new Error('FIXTURE_SOURCE_READ');}});
    expect(()=>index.synchronize([added,bad],sim.state.widthMm,sim.state.heightMm)).toThrow('FIXTURE_SOURCE_READ');
    expect(index.inventory().reconciled-before.reconciled).toBe(2);expect(index.inventory().entities).toBe(world.length+1);
    const valid=[...world].reverse();expect(index.synchronize(valid,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,valid,mask);expect(index.inventory().entities).toBe(world.length);
    const untouched=index.inventory();expect(index.synchronize(valid,0,sim.state.heightMm)).toBe(false);expect(index.inventory()).toEqual(untouched);
    expect(index.synchronize(valid,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,valid,mask);
  });
  it('safely reuses scan generations after rollover and clears old marks across dimension changes',()=>{
    const sim=fixture(),index=new PerceptionMembership(),world=Object.values(sim.state.entities),mask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    index.synchronize(world,sim.state.widthMm,sim.state.heightMm);assertScalarMembers(index,sim,world,mask);
    const privateIndex=index as unknown as {scanGeneration:number;records:Map<string,{observed:number}>};privateIndex.scanGeneration=Number.MAX_SAFE_INTEGER;
    // A record left over from a failed ancient scan can have the upcoming mark.
    // Resetting all marks before wrap must still remove that absent record.
    for(const record of privateIndex.records.values())record.observed=Number.MAX_SAFE_INTEGER;
    privateIndex.records.get(world.at(-1)!.id)!.observed=1;
    const smaller=world.slice(0,-1);expect(index.synchronize(smaller,sim.state.widthMm,sim.state.heightMm)).toBe(true);expect(privateIndex.scanGeneration).toBe(1);expect(index.inventory().entities).toBe(smaller.length);assertScalarMembers(index,sim,smaller,mask);
    sim.state.widthMm+=2000;sim.state.heightMm+=2000;const largerMask=new Uint8Array((sim.state.widthMm/2000)*(sim.state.heightMm/2000)).fill(1);
    expect(index.synchronize([world[0]!,world[0]!],sim.state.widthMm,sim.state.heightMm)).toBe(false);expect(index.inventory().entities).toBe(1);
    expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);assertScalarMembers(index,sim,world,largerMask);
    const cold=new PerceptionMembership();cold.synchronize(world,sim.state.widthMm,sim.state.heightMm);assertScalarMembers(cold,sim,world,largerMask);expect(index.inventory().cells).toBe(cold.inventory().cells);
  });
  it('includes an enemy circle tangent to a visible fog cell while its center remains hidden',()=>{
    const sim=fixture(false),unit=sim.state.entities.scout_b as Unit,fog=balance.rules.fogGridM*1000,columns=sim.state.widthMm/fog,radius=units[unit.typeId].collisionRadiusM*1000;
    unit.xMm=50000-radius;unit.zMm=41000;const visibleCell=Math.floor(unit.zMm/fog)*columns+25,mask=new Uint8Array(columns*columns);mask[visibleCell]=1;
    const internal=sim as unknown as ScalarInternals;internal.visibilityMasks.set('a',mask);
    const index=new PerceptionMembership();index.synchronize(Object.values(sim.state.entities),sim.state.widthMm,sim.state.heightMm);index.commit([{key:'a',mask}]);
    expect(mask[Math.floor(unit.zMm/fog)*columns+Math.floor(unit.xMm/fog)]).toBe(0);expect(internal.visible('a',unit)).toBe(true);expect(index.visible('a',unit.id)).toBe(true);expect(index.actors('a','a').some(entity=>entity.id===unit.id)).toBe(true);
    unit.xMm--;index.synchronize(Object.values(sim.state.entities),sim.state.widthMm,sim.state.heightMm);index.commit([{key:'a',mask:mask.slice()}]);expect(internal.visible('a',unit)).toBe(false);expect(index.visible('a',unit.id)).toBe(false);
    unit.xMm++;unit.garrisonedIn='host';index.synchronize(Object.values(sim.state.entities),sim.state.widthMm,sim.state.heightMm);index.commit([{key:'a',mask:mask.slice()}]);expect(index.actors('a','a').some(entity=>entity.id===unit.id)).toBe(false);expect(index.actors('a','b').some(entity=>entity.id===unit.id)).toBe(true);
    // The original lower loop bound excludes a cell touched only on its upper
    // edge. Retain this directional boundary rule exactly, including fixtures.
    delete unit.garrisonedIn;unit.xMm=50000+radius;const lower=mask.slice();lower[visibleCell]=0;lower[visibleCell-1]=1;internal.visibilityMasks.set('a',lower);
    index.synchronize(Object.values(sim.state.entities),sim.state.widthMm,sim.state.heightMm);index.commit([{key:'a',mask:lower}]);expect(internal.visible('a',unit)).toBe(false);expect(index.visible('a',unit.id)).toBe(false);
  });
  it('rechecks only affected cells or changed footprints and preserves canonical static/unit membership',()=>{
    const sim=fixture(),world=Object.values(sim.state.entities),index=new PerceptionMembership(),fog=balance.rules.fogGridM*1000,columns=sim.state.widthMm/fog,size=columns*columns;
    const mask=new Uint8Array(size),cell=Math.floor(47000/fog)*columns+Math.floor(40000/fog);mask[cell]=1;
    expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'one',mask}]);const first=index.inventory().rechecked;
    index.synchronize(world,sim.state.widthMm,sim.state.heightMm);index.commit([{key:'one',mask:mask.slice()}]);expect(index.inventory().rechecked).toBe(first);
    const changed=mask.slice();changed[cell]=0;index.commit([{key:'one',mask:changed}]);expect(index.inventory().rechecked-first).toBeGreaterThan(0);expect(index.inventory().rechecked-first).toBeLessThan(world.length);expect(index.members('one')).toEqual([]);
    const wood=sim.state.entities.wood_0 as ResourceNode;wood.xMm+=20000;index.synchronize(world,sim.state.widthMm,sim.state.heightMm);index.commit([{key:'one',mask}]);expect(index.visible('one',wood.id)).toBe(false);
    const smaller=world.filter(entity=>entity.id!=='wood_1');index.synchronize(smaller,sim.state.widthMm,sim.state.heightMm);index.commit([{key:'two',mask}]);expect(index.inventory().groups).toBe(1);expect(index.inventory().entities).toBe(smaller.length);
  });
  it('retains static rosters through unit movement, garrison, ownership, replacement and unit-only reorder',()=>{
    const sim=fixture(false),internal=sim as unknown as ScalarInternals,index=new PerceptionMembership(),columns=sim.state.widthMm/(balance.rules.fogGridM*1000),size=columns**2;
    let mask=new Uint8Array(size).fill(1);
    const buildings=Object.values(sim.state.entities).filter((entity):entity is Building=>entity.kind==='building'),first=sim.state.entities.scout_a as Unit,second=sim.state.entities.scout_b as Unit;
    let world:Entity[]=[...buildings,sim.state.entities.wood_0!,first,second];
    const reconcile=()=>{
      for(const id of ['a','b'])internal.visibilityMasks.set(id,mask);
      expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'shared',mask}]);
      expect(index.members('shared')).toEqual(world.filter(entity=>internal.visible('a',entity)));
      for(const id of ['a','b']){
        expect(index.actors('shared',id)).toEqual(world.filter(entity=>entity.kind!=='resource'&&(entity.ownerId===id||internal.visible(id,entity))));
        expect(index.statics('shared',id)).toEqual(world.filter(entity=>entity.kind!=='unit'&&(entity.ownerId===id||internal.visible(id,entity))));
      }
    };
    reconcile();const a=index.statics('shared','a'),b=index.statics('shared','b'),visible=index.visibleStatics('shared');
    const stable=()=>{reconcile();expect(index.statics('shared','a')).toBe(a);expect(index.statics('shared','b')).toBe(b);expect(index.visibleStatics('shared')).toBe(visible);};
    first.xMm+=8000;first.zMm+=6000;stable();
    mask=mask.slice();for(let z=21;z<=24;z++)for(let x=22;x<=25;x++)mask[z*columns+x]=0;stable();
    first.garrisonedIn=buildings[0]!.id;stable();
    first.ownerId='b';stable();
    world=[...world.slice(0,-2),second,first];stable();
    delete first.garrisonedIn;stable();
    world[world.length-1]={...first,hp:first.hp-1};stable();
    world.pop();stable();
    world.push({...first,id:'new_owned_unit',ownerId:'a'});stable();
  });
  it('retains live actor and recipient rosters across visible unit movement but updates actual fog crossings',()=>{
    const sim=fixture(false),index=new PerceptionMembership(),internal=sim as unknown as ScalarInternals,world=Object.values(sim.state.entities),fog=balance.rules.fogGridM*1000,columns=sim.state.widthMm/fog;
    let mask=new Uint8Array(columns*columns).fill(1);
    const own=sim.state.entities.scout_a as Unit,enemy=sim.state.entities.scout_b as Unit;
    const reconcile=()=>{internal.visibilityMasks.set('a',mask);expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'a',mask}]);};
    reconcile();const actors=index.actors('a','a'),recipients=index.recipients('a','a'),members=index.members('a');
    for(let step=0;step<4;step++){
      own.xMm+=fog;enemy.zMm+=fog;own.hp--;mask=mask.slice();reconcile();
      expect(index.actors('a','a')).toBe(actors);expect(index.recipients('a','a')).toBe(recipients);expect(index.members('a')).toBe(members);
      expect(actors.find(entity=>entity.id===own.id)).toBe(own);
    }
    // Moving the enemy into hidden cells must still remove it even when the
    // same immutable fog mask is reused across the movement boundary.
    mask=new Uint8Array(columns*columns);for(let z=0;z<columns;z++)for(let x=0;x<30;x++)mask[z*columns+x]=1;
    reconcile();const visible=index.actors('a','a');expect(visible).toContain(enemy);
    enemy.xMm=90000;reconcile();expect(index.actors('a','a')).not.toBe(visible);expect(index.actors('a','a')).not.toContain(enemy);
    enemy.xMm=56000;reconcile();expect(index.actors('a','a')).toContain(enemy);
    enemy.garrisonedIn='enemy_host';reconcile();expect(index.actors('a','a')).not.toContain(enemy);expect(index.actors('a','b')).toContain(enemy);
    delete enemy.garrisonedIn;reconcile();expect(index.actors('a','a')).toContain(enemy);
    expect(index.recipients('a','a')).toEqual(world.filter(entity=>entity.ownerId==='a'||internal.visible('a',entity)));
  });
  it('builds actor rosters without visiting thousands of resource records and retains them through resource-only reveals',()=>{
    const sim=fixture(false),index=new PerceptionMembership(),internal=sim as unknown as ScalarInternals,fog=balance.rules.fogGridM*1000,columns=sim.state.widthMm/fog;
    const template=sim.state.entities.wood_0 as ResourceNode,actors=Object.values(sim.state.entities).filter(entity=>entity.kind!=='resource');
    const resources=Array.from({length:4640},(_,i)=>({...template,id:`dense_wood_${i}`,xMm:4000+i%20*1000,zMm:4000+Math.floor(i/20)%20*1000})),world:Entity[]=[...resources,...actors];
    const mask=new Uint8Array(columns*columns).fill(1);expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'a',mask}]);
    const records=(index as unknown as {records:Map<string,unknown>}).records,originalGet=records.get;let resourceReads=0,actorReads=0;
    records.get=function(id:string){if(id.startsWith('dense_wood_'))resourceReads++;else actorReads++;return originalGet.call(this,id);};
    try{
      const roster=index.actors('a','a');expect(roster).toEqual(actors);expect(resourceReads).toBe(0);expect(actorReads).toBe(actors.length);
      // Fog changes covering only resources leave every actor disclosure and
      // actor order untouched, so they must not discard the reusable roster.
      const changed=mask.slice();for(let z=0;z<15;z++)for(let x=0;x<15;x++)changed[z*columns+x]=0;
      index.commit([{key:'a',mask:changed}]);resourceReads=0;actorReads=0;
      expect(index.actors('a','a')).toBe(roster);expect(resourceReads).toBe(0);expect(actorReads).toBe(0);
      internal.visibilityMasks.set('a',changed);expect(index.recipients('a','a')).toEqual(world.filter(entity=>entity.ownerId==='a'||internal.visible('a',entity)));
      // A visible resource may change kind in place; that must join the actor
      // index using stored old metadata, even though its reference is retained.
      const changedKind=resources[0]!;Object.assign(changedKind,{...actors.find(entity=>entity.kind==='unit')!,id:changedKind.id,ownerId:'b',xMm:56000,zMm:40000});
      index.synchronize(world,sim.state.widthMm,sim.state.heightMm);index.commit([{key:'a',mask:changed}]);expect(index.actors('a','a')).toContain(changedKind);
    }finally{records.get=originalGet;}
  });
  it('invalidates static membership and order for mutable static geometry, references, ownership, kind and lifetime',()=>{
    const sim=fixture(false),internal=sim as unknown as ScalarInternals,index=new PerceptionMembership(),fog=balance.rules.fogGridM*1000,columns=sim.state.widthMm/fog;
    let mask=new Uint8Array(columns*columns).fill(1);
    const building=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!,node=sim.state.entities.wood_0 as ResourceNode,unit=sim.state.entities.scout_a as Unit;
    let world:Entity[]=[building,node,unit];
    const reconcile=()=>{
      for(const id of ['a','b'])internal.visibilityMasks.set(id,mask);
      expect(index.synchronize(world,sim.state.widthMm,sim.state.heightMm)).toBe(true);index.commit([{key:'shared',mask}]);
      expect(index.members('shared')).toEqual(world.filter(entity=>internal.visible('a',entity)));
      for(const id of ['a','b']){
        expect(index.actors('shared',id)).toEqual(world.filter(entity=>entity.kind!=='resource'&&(entity.ownerId===id||internal.visible(id,entity))));
        expect(index.statics('shared',id)).toEqual(world.filter(entity=>entity.kind!=='unit'&&(entity.ownerId===id||internal.visible(id,entity))));
      }
      return index.statics('shared','a');
    };
    let prior=reconcile();node.xMm+=8000;let current=reconcile();expect(current).not.toBe(prior);
    prior=current;world=[node,building,unit];current=reconcile();expect(current).not.toBe(prior);expect(current.map(entity=>entity.id)).toEqual([node.id,building.id]);
    prior=current;world[0]={...node,hp:0};current=reconcile();expect(current).not.toBe(prior);expect(current[0]).toBe(world[0]);
    // Hidden owned buildings remain known; ownership can change without either
    // the fog mask or the entity reference changing.
    mask=new Uint8Array(columns*columns);current=reconcile();expect(current).toEqual([building]);
    building.ownerId='b';current=reconcile();expect(current).toEqual([]);expect(index.statics('shared','b')).toEqual([building]);
    // Mutate the same object across kinds: removal must use the stored old kind,
    // because the canonical object's kind has already changed.
    const changed=world[1]!;Object.assign(changed,{...unit,id:building.id,ownerId:'b'});reconcile();expect(index.statics('shared','b')).toEqual([]);
    Object.assign(changed,{...building,id:building.id,kind:'building',typeId:'house',ownerId:'a',rotation:0});reconcile();expect(index.statics('shared','a')).toEqual([changed]);
    const removed=world[1]!;world=[world[0]!,world[2]!];reconcile();expect(index.statics('shared','a')).toEqual([]);
    world.push({...removed});reconcile();expect(index.statics('shared','a')).toEqual([world.at(-1)]);
    // A newly visible resource must enter the static roster even if unit masks
    // previously changed without invalidating it.
    mask=new Uint8Array(columns*columns);mask[Math.floor(node.zMm/fog)*columns+Math.floor(node.xMm/fog)]=1;
    reconcile();expect(index.statics('shared','b')).toContain(world[0]);
  });
  it.each([true,false])('preserves complete scalar JSON captures/views and cold continuation (shared=%s)',shared=>{
    const actual=fixture(shared),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    const assertRecipients=(sim:Simulation)=>{
      const internal=sim as unknown as ScalarInternals&{perceptionMembership:PerceptionMembership},reference=expected as unknown as ScalarInternals,world=Object.values(expected.state.entities);
      for(const faction of sim.state.factions)expect(internal.perceptionMembership.recipients(internal.visionGroup(faction.id),faction.id)).toEqual(world.filter(entity=>entity.ownerId===faction.id||reference.visible(faction.id,entity)));
    };
    for(let tick=0;tick<1200;tick++){
      mutate(actual,tick);mutate(expected,tick);actual.step();expected.step();
      expect(JSON.stringify(actual.capture())).toBe(JSON.stringify(expected.capture()));
      for(const faction of actual.state.factions)expect(JSON.stringify(actual.view(faction.id))).toBe(JSON.stringify(expected.view(faction.id)));
      assertRecipients(actual);
    }
    const cold=new Simulation(actual.options,actual.capture());
    for(let tick=0;tick<600;tick++){actual.step();expected.step();cold.step();expect(JSON.stringify(actual.capture())).toBe(JSON.stringify(expected.capture()));expect(JSON.stringify(cold.capture())).toBe(JSON.stringify(expected.capture()));assertRecipients(actual);assertRecipients(cold);}
  },120000);
  it('keeps authorized attack pulses, expiry and carried/idle transitions exact with unchanged fog',()=>{
    const actual=fixture(),expected=new Simulation(actual.options,actual.capture());scalar(expected);
    for(let tick=0;tick<12;tick++){
      for(const sim of [actual,expected]){const internal=sim as unknown as ScalarInternals;sim.state.tick++;internal.committedActions.clear();if(tick===0||tick===3)internal.committedActions.set('scout_a',{kind:'attack',durationTicks:6,facingMilliRad:500,recipients:['a']});if(tick===7)(sim.state.entities.scout_a as Unit).cargo={resource:'wood',amount:1};if(tick===10)(sim.state.entities.scout_a as Unit).cargo={resource:null,amount:0};internal.observeActions();}
      expect(JSON.stringify(actual.capture())).toBe(JSON.stringify(expected.capture()));
    }
  });
});
