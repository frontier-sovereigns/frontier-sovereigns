import {describe,expect,it} from 'vitest';
import {ActiveWorkRoster} from './active-work-roster.js';
import {Simulation} from './index.js';
import {balance,buildings,units,type PublicPlayer} from '@frontier/shared';
import type {Building,Entity,Unit} from './state.js';
const unit=(id:string,ownerId='a')=>({id,ownerId,kind:'unit'}) as Unit;
describe('bounded frame work wake ordering',()=>{
  it('expires frame sleeps while retaining active contact subscriptions and generations',()=>{
    const gatherer=unit('gatherer'),traveller=unit('traveller'),waiting=unit('waiting'),roster=ActiveWorkRoster.create([gatherer,traveller,waiting],100)!;
    roster.watch(gatherer,['tree'],[2]);roster.watch(traveller,['tree'],[2],'travel');roster.watch(waiting,['other_tree'],[3],'pending');
    const generation=roster.generation(gatherer.id),before=ActiveWorkRoster.diagnostics().created;
    roster.beginFrame(106);expect(roster.frame).toBe(106);expect([...roster.due()]).toEqual([gatherer,traveller,waiting]);expect(roster.generation(gatherer.id)).toBe(generation);expect(ActiveWorkRoster.diagnostics().created).toBe(before);
    const travelGeneration=roster.generation(traveller.id);roster.beginFrame(106);expect(roster.generation(traveller.id)).toBe(travelGeneration);
    roster.wakeTarget('other_tree');expect(roster.generation(gatherer.id)).toBe(generation);roster.wakeTarget('tree');expect(roster.generation(gatherer.id)).toBe(generation!+1);
  });
  it('wakes later workers in this pass and earlier workers only in the next pass',()=>{
    const a=unit('a'),b=unit('b'),c=unit('c'),roster=ActiveWorkRoster.create([a,b,c],100)!;
    roster.watch(a,['tree'],[],'pending');roster.watch(c,['tree'],[],'pending');
    const visited:string[]=[];
    for(const worker of roster.due()){visited.push(worker.id);if(worker===b)roster.wakeTarget('tree');}
    expect(visited).toEqual(['b','c']);expect([...roster.due()].map(worker=>worker.id)).toEqual(['a','b','c']);
  });
  it('crosses bitset word boundaries in original actor order',()=>{
    const workers=Array.from({length:70},(_,index)=>unit(String(index))),roster=ActiveWorkRoster.create(workers,100)!;
    for(const worker of workers)roster.watch(worker,[],[],'inert');
    for(const index of [69,32,31,0,63])roster.wake(String(index));
    expect([...roster.due()].map(worker=>worker.id)).toEqual(['0','31','32','63','69']);
  });
  it('invalidates only subscribed current-recipient fog cells',()=>{
    const a=unit('a'),b=unit('b','b'),roster=ActiveWorkRoster.create([a,b],100)!;
    roster.watch(a,['tree'],[2],'travel');roster.watch(b,['tree'],[2],'travel');
    const before=new Uint8Array([0,0,1,0]),unrelated=new Uint8Array([1,0,1,0]),after=new Uint8Array([1,0,0,0]);
    const generation=roster.generation('a');roster.observeVisibility('a',before,unrelated);expect([...roster.due()]).toEqual([]);expect(roster.generation('a')).toBe(generation);
    roster.observeVisibility('a',unrelated,after);expect([...roster.due()]).toEqual([a]);expect(roster.generation('a')).toBeGreaterThan(generation!);
  });
  it('keeps unknown/oversized subscriptions active and clears obsolete targets',()=>{
    const worker=unit('a'),roster=ActiveWorkRoster.create([worker],100)!;
    roster.watch(worker,['old_tree'],[0],'pending');roster.watch(worker,['new_tree'],[1],'pending');roster.wakeTarget('old_tree');expect([...roster.due()]).toEqual([]);
    expect(roster.watch(worker,['new_tree'],Array.from({length:19},(_,i)=>i),'pending')).toBe(false);expect([...roster.due()]).toEqual([worker]);
    expect(ActiveWorkRoster.create(Array.from({length:2201},(_,i)=>unit(String(i))),100)).toBeUndefined();
  });
});

describe('native pending deposit membership',()=>{
  type Probe={liveOwned:boolean;coarseFrame:boolean;frameDeferredKnowledge:boolean;liveStaticRevision:number;liveDepositBuildings?:{revision:number;buildings:Building[]};pendingDepositContact(unit:Unit):boolean;invalidateEntityRoster(statics?:boolean):void;checkLiveOwnership():void;actors():Entity[];visible(owner:string,target:Entity):boolean;boundaryDistance(unit:Unit,target:Entity):number;complete(target:Entity):boolean;hostile(a:string,b:string|null):boolean;dropoffs(unit:Unit,ordered?:boolean):Building[]};
  function fixture(){
    const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'team',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'rival',kind:'human',color:'#ee5533'}];
    const sim=new Simulation({factions,seed:'deposit-membership',matchId:'deposit-membership',controllers:false}),probe=sim as unknown as Probe;
    const initial=Object.values(sim.state.entities),worker=initial.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a')!,home=initial.find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const definition=buildings.lumber_camp,required=definition.buildSeconds*balance.rules.simulationHz*100;
    const camp:Building={...structuredClone(home),id:'contact_camp',typeId:'lumber_camp',xMm:30000,zMm:30000,work:required,required,queue:[]};
    worker.xMm=camp.xMm;worker.zMm=camp.zMm+definition.footprintCells[1]*1000+700;worker.cargo={resource:'wood',amount:1000};
    const unrelated=Array.from({length:300},(_,index):Unit=>({...structuredClone(worker),id:`unrelated_${index}`,xMm:100000,zMm:100000}));
    sim.state.entities=Object.fromEntries([worker,camp,...unrelated].map(entity=>[entity.id,entity]));probe.invalidateEntityRoster(true);
    sim.state.factions[1]!.teamId='team';
    // Exercise the private membership component with controlled native inputs;
    // full factory ownership/parity is covered by coarse-frame/live-owner tests.
    probe.liveOwned=true;probe.coarseFrame=true;probe.frameDeferredKnowledge=true;
    let actorScans=0;const actors=probe.actors.bind(sim);probe.actors=()=>{actorScans++;return actors();};
    const visible=new Set<string>();probe.visible=(_owner,target)=>visible.has(target.id);
    const scalar=()=>Object.values(sim.state.entities).some(drop=>drop.kind==='building'&&buildings[drop.typeId].dropOffResources.includes(worker.cargo.resource!)&&probe.boundaryDistance(worker,drop)<=units.villager.collisionRadiusM*1000+1100&&probe.complete(drop)&&!probe.hostile(worker.ownerId,drop.ownerId)&&!sim.state.economies[drop.ownerId]!.defeated&&(drop.ownerId===worker.ownerId||probe.visible(worker.ownerId,drop)));
    return {sim,probe,worker,camp,visible,scalar,actorScans:()=>actorScans};
  }
  it('reuses only dropoff membership while current completion, cargo and geometry remain live',()=>{
    const {sim,probe,worker,camp,scalar,actorScans}=fixture(),revision=sim.state.navigationRevision;
    camp.work=camp.required-1;expect(probe.pendingDepositContact(worker)).toBe(scalar());expect(probe.pendingDepositContact(worker)).toBe(false);
    expect(actorScans()).toBe(1);expect(probe.liveDepositBuildings?.buildings).toEqual([camp]);
    camp.work=camp.required;expect(sim.state.navigationRevision).toBe(revision);expect(probe.pendingDepositContact(worker)).toBe(true);
    worker.cargo.resource='gold';expect(probe.pendingDepositContact(worker)).toBe(scalar());expect(probe.pendingDepositContact(worker)).toBe(false);
    worker.cargo.resource='wood';camp.xMm+=10000;expect(probe.pendingDepositContact(worker)).toBe(scalar());expect(probe.pendingDepositContact(worker)).toBe(false);
    camp.xMm-=10000;expect(probe.pendingDepositContact(worker)).toBe(true);expect(actorScans()).toBe(1);
  });
  it('rechecks allied visibility, owner policy and defeat without rebuilding static membership',()=>{
    const {sim,probe,worker,camp,visible,scalar,actorScans}=fixture();camp.ownerId='b';
    expect(probe.pendingDepositContact(worker)).toBe(false);visible.add(camp.id);expect(probe.pendingDepositContact(worker)).toBe(scalar());expect(probe.pendingDepositContact(worker)).toBe(true);
    sim.state.factions[1]!.teamId='rival';expect(probe.pendingDepositContact(worker)).toBe(false);sim.state.factions[1]!.teamId='team';
    sim.state.economies.b!.defeated=true;expect(probe.pendingDepositContact(worker)).toBe(false);sim.state.economies.b!.defeated=false;
    visible.delete(camp.id);expect(probe.pendingDepositContact(worker)).toBe(false);camp.ownerId='a';expect(probe.pendingDepositContact(worker)).toBe(scalar());expect(probe.pendingDepositContact(worker)).toBe(true);expect(actorScans()).toBe(1);
  });
  it('releases removed references immediately and rebuilds after static insertion, but not unit insertion',()=>{
    const {sim,probe,worker,camp,actorScans}=fixture();expect(probe.pendingDepositContact(worker)).toBe(true);
    sim.state.entities.new_unit={...structuredClone(worker),id:'new_unit'};probe.invalidateEntityRoster();expect(probe.pendingDepositContact(worker)).toBe(true);expect(actorScans()).toBe(1);
    delete sim.state.entities[camp.id];probe.invalidateEntityRoster(true);expect(probe.liveDepositBuildings).toBeUndefined();expect(probe.pendingDepositContact(worker)).toBe(false);
    const replacement={...structuredClone(camp),id:'replacement_camp'};sim.state.entities[replacement.id]=replacement;probe.invalidateEntityRoster(true);expect(probe.pendingDepositContact(worker)).toBe(true);expect(probe.liveDepositBuildings?.buildings).toEqual([replacement]);expect(actorScans()).toBe(3);
  });
  it('clears membership on ownership revocation and retains the generic dropoff path',()=>{
    const {probe,worker,camp}=fixture();expect(probe.pendingDepositContact(worker)).toBe(true);
    const prototype=Simulation.prototype as unknown as {complete(target:Entity):boolean},original=prototype.complete;prototype.complete=function(target){return original.call(this,target);};
    try{probe.checkLiveOwnership();}finally{prototype.complete=original;}
    expect(probe.liveOwned).toBe(false);expect(probe.liveDepositBuildings).toBeUndefined();
    let genericCalls=0;probe.dropoffs=()=>{genericCalls++;return [camp];};expect(probe.pendingDepositContact(worker)).toBe(true);probe.dropoffs=()=>{genericCalls++;return [];};expect(probe.pendingDepositContact(worker)).toBe(false);expect(genericCalls).toBe(2);expect(probe.liveDepositBuildings).toBeUndefined();
  });
});
