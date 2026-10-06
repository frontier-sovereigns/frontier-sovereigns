import { describe, expect, it, vi } from 'vitest';
import { MessageChannel, MessagePort } from 'node:worker_threads';
import { units, type PlayerView, type ViewEntity } from '@frontier/shared';
import { RecipientProjectionReceiver } from '../../../apps/server/src/recipient-projection-transfer.js';
import { Simulation, createSimulation, type Building, type Entity, type ResourceNode, type Unit } from './index.js';
import { RecipientProjection, type ProjectionPatch } from './recipient-projection.js';
import type { PerceptionMembership } from './perception-membership.js';
import { isNativeProjectionPort, nativeProjectionHeader, postNativeProjection, type NativeProjection } from './recipient-projection-native.js';

interface PublicationInternals {visibilityMasks:Map<string,Uint8Array>;perceptionMembership:PerceptionMembership;perceptionWorld?:readonly Entity[];stepping:boolean;visible(playerId:string,entity:Entity):boolean;observeActions():void}

function fixture(shared=false){
  const sim=createSimulation({matchId:'recipient-source',seed:'recipient-source',controllers:false,sharedVision:shared,factions:[{id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'},...(shared?[{id:'c',name:'C',teamId:'a',color:'#33ff88',kind:'human' as const}]:[])]}),prior=Object.values(sim.state.entities);
  const scout=structuredClone(prior.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='scout')!),worker=structuredClone(prior.find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!),wood=structuredClone(prior.find((entity):entity is ResourceNode=>entity.kind==='resource'&&entity.resource==='wood')!);
  const homes=prior.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center');sim.state.entities={};sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const [index,home]of homes.entries()){home.xMm=30000+index*(shared?90000:200000);home.zMm=30000+index*(shared?90000:200000);sim.state.entities[home.id]=home;}
  Object.assign(scout,{id:'observer',ownerId:'a',xMm:100000,zMm:100000,orders:[],path:[],stance:'stand_ground',autoGather:false});
  Object.assign(worker,{id:'foreign_worker',ownerId:'b',xMm:106000,zMm:100000,orders:[],path:[],stance:'stand_ground',autoGather:false});
  Object.assign(wood,{id:'known_tree',xMm:104000,zMm:103000,amount:100000});
  for(const entity of [scout,worker,wood])sim.state.entities[entity.id]=entity;
  sim.state.entities.hidden_tree={...structuredClone(wood),id:'hidden_tree',xMm:210000,zMm:210000};
  for(const vision of Object.values(sim.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}
  sim.step();return {sim,scout,worker,wood,home:homes.find(home=>home.ownerId==='a')!};
}
function receiver(){const value=new RecipientProjectionReceiver();value.reset(1);return value;}
function publish(sim:Simulation,target:RecipientProjectionReceiver,sequence:number,playerIds=['a','b']):{patch:ProjectionPatch;view:PlayerView}[]{
  return sim.publicationProjections(playerIds.map(playerId=>({playerId,sequence}))).map(patch=>{
    const view=target.receive({generation:1,patch},patch.header.playerId),expected=JSON.parse(JSON.stringify({...sim.view(patch.header.playerId),sequence}));
    expect(view).toEqual(expected);return {patch,view};
  });
}

describe('authorized persistent projection source',()=>{
  it('publishes the recorded movement tier cadence independently of presentation speed',()=>{
    const {sim}=fixture(),target=receiver();sim.setPresentationSpeed(.5);
    for(const [index,tier] of ([0,1,2,3,0] as const).entries()){
      sim.setMovementCadenceTier(tier);const interval=tier<2?100:tier===2?150:200;
      for(const {view} of publish(sim,target,index+1)){
        expect(view.publicationIntervalMs??100).toBe(interval);expect(view.simulationSpeed).toBe(.5);
        expect(view).not.toHaveProperty('movementCadenceTier');
      }
      expect(sim.capture().state.movementCadenceTier).toBe(tier);
    }
  });
  it('retains privately owned hidden payloads while observing timestamps, action replacement and reappearance',()=>{
    const cache=new RecipientProjection(),memory:ViewEntity={id:'remembered',kind:'resource',typeId:'tree',ownerId:null,xMm:10000,zMm:10000,hp:1,maxHp:1,resource:'wood',amount:250,lastSeenTick:10};
    cache.begin();cache.rememberedOwned(memory);const first=cache.prior(memory.id)!;
    cache.begin();cache.rememberedOwned(memory);expect(cache.prior(memory.id)).toBe(first);
    memory.lastSeenTick=20;cache.begin();cache.rememberedOwned(memory);const later=cache.prior(memory.id)!;
    expect(later.lastSeenTick).toBe(20);expect(first.lastSeenTick).toBe(10);
    memory.visualAction={kind:'idle',startedTick:20};cache.begin();cache.rememberedOwned(memory);expect(cache.prior(memory.id)?.visualAction).toEqual(memory.visualAction);expect(later.visualAction).toBeUndefined();
    // A visible entry replaces the retained ghost before fog hides it again.
    cache.begin();cache.entity({...memory,amount:100});expect(cache.prior(memory.id)?.ghost).toBeUndefined();
    cache.begin();cache.rememberedOwned(memory);expect(cache.prior(memory.id)?.ghost).toBe(true);expect(cache.prior(memory.id)?.amount).toBe(250);
    const changed={...memory,amount:0};cache.begin();cache.rememberedOwned(changed);expect(cache.prior(memory.id)?.amount).toBe(0);expect(first.amount).toBe(250);
  });
  it('keeps host presentation speed out of authoritative captures and publishes same-tick changes and removal',()=>{
    const {sim}=fixture(),target=receiver(),capture=sim.capture(),initial=sim.view('a');
    expect(initial).not.toHaveProperty('simulationSpeed');publish(sim,target,1);
    for(const [index,speed] of [.9,.1,1].entries()){
      sim.setPresentationSpeed(speed);
      const projected=publish(sim,target,index+2),ordinary=sim.views(['a','b']);
      for(const {patch,view} of projected){
        expect(view.simulationSpeed??1).toBe(speed);expect(patch.entities.upserts).toEqual([]);
        if(speed===1){expect(patch.removedFields).toContain('simulationSpeed');expect(view).not.toHaveProperty('simulationSpeed');}
        else expect(patch.fields.simulationSpeed).toBe(speed);
      }
      expect(ordinary.every(view=>(view.simulationSpeed??1)===speed)).toBe(true);
      expect(sim.capture()).toEqual(capture);
    }
    for(const speed of [NaN,Infinity,0,.09,1.01])expect(()=>sim.setPresentationSpeed(speed)).toThrow('INVALID_PRESENTATION_SPEED');
    expect(sim.view('a')).toEqual(initial);expect(sim.capture()).toEqual(capture);
  });
  it('shares detached public fields per canonical batch and detects same-tick public edits',()=>{
    const {sim}=fixture(true),target=receiver(),inputs=vi.spyOn(RecipientProjection.prototype,'finish');
    try{
      publish(sim,target,1,['a','b','c']);const first=inputs.mock.calls.map(([fields])=>fields);
      for(const field of ['map','players','monuments','ageAnnouncements'] as const){expect(first[0]![field]).toBe(first[1]![field]);expect(first[1]![field]).toBe(first[2]![field]);}
      expect(first[0]!.self).not.toBe(first[1]!.self);expect(first[0]!.fog).not.toBe(first[1]!.fog);
      inputs.mockClear();publish(sim,target,2,['c','a']);const stable=inputs.mock.calls.map(([fields])=>fields);
      for(const field of ['map','players','monuments','ageAnnouncements'] as const)expect(stable[0]![field]).toBe(first[0]![field]);
      sim.state.factions[0]!.name='Public roster edit';sim.state.economies.a!.age=2;
      sim.state.ageAnnouncements.push({playerId:'a',age:2,tick:sim.state.tick});
      inputs.mockClear();publish(sim,target,3,['a','b','c']);
      for(const field of ['players','ageAnnouncements'] as const){expect(inputs.mock.calls[0]![0][field]).not.toBe(first[0]![field]);expect(inputs.mock.calls[0]![0][field]).toBe(inputs.mock.calls[1]![0][field]);}
      expect(first[0]!.map.terrain).toEqual([]);expect(first[0]!.players[0]!.name).toBe('A');expect(first[0]!.ageAnnouncements).toEqual([]);
      // A mutable map must still be detected. Protocol map identity correctly
      // requires a fresh recipient base rather than accepting a live map edit.
      sim.state.map.terrain.push({id:'public_hill',kind:'hill',xMm:200000,zMm:200000,widthMm:10000,depthMm:10000,elevationMm:2000});
      const changed=sim.publicationProjections(['a','b','c'].map(playerId=>({playerId,sequence:4})));
      expect(()=>target.receive({generation:1,patch:changed[0]!},'a')).toThrow('PROJECTION_IDENTITY_MISMATCH');
      expect(first[0]!.map.terrain).toEqual([]);
      // Exported recipient packets cannot alias one another or the private base.
      const exportedHill=changed[0]!.fields.map!.terrain?.[0];
      if(exportedHill?.kind!=='hill')throw new Error('Expected the public hill fixture');
      exportedHill.elevationMm=9999;
      expect(changed[1]!.fields.map!.terrain?.[0]).toMatchObject({kind:'hill',elevationMm:2000});
      sim.resetPublication();expect(publish(sim,receiver(),5,['a'])[0]!.view.map.terrain?.[0]).toMatchObject({kind:'hill',elevationMm:2000});
    }finally{inputs.mockRestore();}
  });
  it('shares live resource DTOs only after recipient visibility and keeps observed actions separate',()=>{
    const {sim,wood}=fixture(),target=receiver(),inputs=vi.spyOn(RecipientProjection.prototype,'entity');
    try{
      publish(sim,target,1);let trees=inputs.mock.calls.filter(([entity])=>entity.id===wood.id).map(([entity])=>entity);
      expect(trees).toHaveLength(2);expect(trees[0]).toBe(trees[1]);const original=trees[0]!;
      inputs.mockClear();publish(sim,target,2);trees=inputs.mock.calls.filter(([entity])=>entity.id===wood.id).map(([entity])=>entity);
      expect(trees[0]).toBe(original);expect(trees[1]).toBe(original);
      wood.amount-=1000;sim.state.vision.b!.actions[wood.id]={kind:'gather_wood',startedTick:sim.state.tick};
      inputs.mockClear();publish(sim,target,3);trees=inputs.mock.calls.filter(([entity])=>entity.id===wood.id).map(([entity])=>entity);
      expect(trees[0]!.amount).toBe(99);expect(trees[1]!.amount).toBe(99);expect(trees[0]).not.toBe(trees[1]);expect(trees[0]!.visualAction).toBeUndefined();expect(trees[1]!.visualAction?.kind).toBe('gather_wood');expect(original.amount).toBe(100);
      delete sim.state.vision.b!.actions[wood.id];inputs.mockClear();publish(sim,target,4);
      trees=inputs.mock.calls.filter(([entity])=>entity.id===wood.id).map(([entity])=>entity);expect(trees[0]).toBe(trees[1]);expect(trees[1]!.visualAction).toBeUndefined();
    }finally{inputs.mockRestore();}
  });
  it('does not invoke a replaced common-field reader or trust its retained aliases after restoration',()=>{
    const {sim}=fixture(),target=receiver(),methods=sim as unknown as Record<string,Function>,original=methods.publicationBatch!,hook=vi.fn(original.bind(sim));
    methods.publicationBatch=hook;publish(sim,target,1);expect(hook).not.toHaveBeenCalled();delete methods.publicationBatch;
    const inputs=vi.spyOn(RecipientProjection.prototype,'finish');
    try{publish(sim,target,2);expect(inputs.mock.calls[0]![0].players).not.toBe(inputs.mock.calls[1]![0].players);}finally{inputs.mockRestore();}
  });
  it('reconciles once per boundary batch and preserves direct mutable inputs in scalar world order',()=>{
    const {sim,scout,worker,wood,home}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals,index=internal.perceptionMembership,before=index.inventory().reconciled;
    publish(sim,target,1);expect(index.inventory().reconciled-before).toBe(Object.keys(sim.state.entities).length);
    // No tick, navigation revision, or new fog mask accompanies these edits.
    wood.xMm=210000;wood.zMm=210000;wood.resource='gold';wood.typeId='gold_deposit';delete wood.forest;
    home.typeId='house';home.rotation=90;worker.ownerId='a';worker.garrisonedIn=home.id;worker.hp=0;worker.cargo={resource:'gold',amount:3000};
    sim.state.entities[scout.id]={...scout,xMm:108000,typeId:'villager',hp:units.villager.maxHp,maxHp:units.villager.maxHp};
    sim.state.entities=Object.fromEntries(Object.entries(sim.state.entities).reverse());
    const capture=JSON.stringify(sim.capture()),changed=publish(sim,target,2)[0]!.view;
    expect(changed.entities.find(entity=>entity.id===wood.id)).toMatchObject({ghost:true,resource:'wood'});
    expect(changed.entities.find(entity=>entity.id===worker.id)).toMatchObject({ownerId:'a',hp:0,garrisonedIn:home.id,cargo:{resource:'gold',amount:3}});
    expect(changed.entities.filter(entity=>!entity.ghost).map(entity=>entity.id)).toEqual(Object.values(sim.state.entities).filter(entity=>entity.ownerId==='a'||internal.visible('a',entity)).map(entity=>entity.id));
    expect(JSON.stringify(sim.capture())).toBe(capture);
    delete sim.state.entities[worker.id];delete sim.state.entities.hidden_tree;publish(sim,target,3);
    sim.state.entities[wood.id]={...wood,xMm:104000,zMm:103000};publish(sim,target,4);
  });
  it('retains every faction group across subset delivery and announces unseen monuments from the full world',()=>{
    const {sim,home}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals;
    sim.options.monumentVictory=true;const monument:Building={...structuredClone(home),id:'unseen_monument',typeId:'monument',ownerId:'b',xMm:220000,zMm:210000,work:0,required:0};sim.state.entities[monument.id]=monument;
    const capture=JSON.stringify(sim.capture()),view=publish(sim,target,1,['a'])[0]!.view;
    expect(view.entities.some(entity=>entity.id===monument.id)).toBe(false);expect(view.monuments!.map(row=>row.id)).toContain(monument.id);expect(internal.perceptionMembership.inventory().groups).toBe(2);
    for(const entity of Object.values(sim.state.entities))expect(internal.perceptionMembership.visible('player:b',entity.id)).toBe(internal.visible('b',entity));
    expect(JSON.stringify(sim.capture())).toBe(capture);internal.observeActions();publish(sim,target,2,['b']);expect(internal.perceptionMembership.inventory().groups).toBe(2);
  });
  it('uses exact old fallback for missing or incoherent shared masks and resumes coherent membership',()=>{
    const {sim}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals,index=internal.perceptionMembership,a=internal.visibilityMasks.get('a')!,b=internal.visibilityMasks.get('b')!;
    sim.options.sharedVision=true;sim.state.factions.find(faction=>faction.id==='b')!.teamId='a';let before=index.inventory().reconciled;
    publish(sim,target,1);expect(index.inventory().reconciled).toBe(before);
    internal.visibilityMasks.delete('b');publish(sim,target,2);expect(index.inventory().reconciled).toBe(before);
    internal.visibilityMasks.set('b',a);publish(sim,target,3);expect(index.inventory().reconciled-before).toBe(Object.keys(sim.state.entities).length);expect(index.inventory().groups).toBe(1);
    before=index.inventory().reconciled;internal.visibilityMasks.set('b',b);publish(sim,target,4);expect(index.inventory().reconciled).toBe(before);
  });
  it('preserves duplicate projection rejection, clears partial coherence, and repairs the next valid scan',()=>{
    const {sim,scout}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals;publish(sim,target,1);
    sim.state.entities.duplicate_key=scout;
    expect(()=>sim.publicationProjections([{playerId:'a',sequence:2},{playerId:'b',sequence:2}])).toThrow('DUPLICATE_PROJECTION_ENTITY');expect(internal.perceptionWorld).toBeUndefined();
    delete sim.state.entities.duplicate_key;publish(sim,target,3);expect(internal.perceptionMembership.inventory().entities).toBe(Object.keys(sim.state.entities).length);
  });
  it('preserves cold shared-team masks before their first coherent vision commit and keeps public fog live',()=>{
    const {sim}=fixture(true),cold=new Simulation(sim.options,sim.capture()),target=receiver(),internal=cold as unknown as PublicationInternals;
    expect(internal.visibilityMasks.get('a')).not.toBe(internal.visibilityMasks.get('c'));
    expect(internal.visibilityMasks.get('a')).toEqual(internal.visibilityMasks.get('c'));
    const before=internal.perceptionMembership.inventory().reconciled,capture=JSON.stringify(cold.capture());publish(cold,target,1,['a','b','c']);expect(internal.perceptionMembership.inventory().reconciled).toBe(before);expect(JSON.stringify(cold.capture())).toBe(capture);
    sim.step();cold.step();expect(JSON.stringify(cold.capture())).toBe(JSON.stringify(sim.capture()));
    const warm=publish(cold,target,2,['c','a']);expect(internal.visibilityMasks.get('a')).toBe(internal.visibilityMasks.get('c'));expect(internal.perceptionMembership.inventory().groups).toBe(2);
    const fog=cold.state.vision.a!;fog.visible=[...fog.visible].reverse();fog.explored=[...fog.explored].reverse();
    const mutated=publish(cold,target,3,['a'])[0]!.view;expect(mutated.fog.visible).toEqual(fog.visible);expect(mutated.fog.explored).toEqual(fog.explored);expect(mutated.entities).toEqual(warm[1]!.view.entities);
  });
  it.each(['all','visible','cell','viewFromRoster','asView','publicationEntity','population','complete','visionGroup'])('keeps the original fallback for an overridden %s reader',name=>{
    const {sim}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals,index=internal.perceptionMembership,methods=sim as unknown as Record<string,Function>,original=methods[name]!,before=index.inventory().reconciled;
    methods[name]=function(...args:unknown[]){return original.apply(sim,args);};
    publish(sim,target,1);expect(index.inventory().reconciled).toBe(before);
  });
  it('keeps packed-static override behavior and live unit selection inside a custom publication hook',()=>{
    const {sim,worker,wood,home}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals,index=internal.perceptionMembership,before=index.inventory().reconciled;
    internal.visible=()=>false;
    const oldViews=sim.views(['a','b']),patches=sim.publicationProjections([{playerId:'a',sequence:1},{playerId:'b',sequence:1}]);
    for(const [offset,patch]of patches.entries())expect(target.receive({generation:1,patch},patch.header.playerId)).toEqual(JSON.parse(JSON.stringify({...oldViews[offset]!,sequence:1})));
    expect(oldViews[0]!.entities.some(entity=>entity.id===wood.id&&!entity.ghost)).toBe(true);expect(oldViews[0]!.entities.some(entity=>entity.id===worker.id)).toBe(false);expect(index.inventory().reconciled).toBe(before);
    delete (internal as unknown as Record<string,unknown>).visible;
    worker.xMm=210000;const methods=sim as unknown as Record<string,Function>,original=methods.publicationEntity!;
    methods.publicationEntity=function(entity:Entity,...args:unknown[]){if(entity.id===home.id)worker.xMm=106000;return original.call(sim,entity,...args);};
    const changed=publish(sim,target,2)[0]!.view;expect(changed.entities.some(entity=>entity.id===worker.id)).toBe(true);expect(index.inventory().reconciled).toBe(before);
  });
  it('leaves in-phase publication scalar and ignores unrelated diagnostic stage wrappers at boundaries',()=>{
    const {sim}=fixture(),target=receiver(),internal=sim as unknown as PublicationInternals,index=internal.perceptionMembership,before=index.inventory().reconciled;
    internal.stepping=true;try{publish(sim,target,1);}finally{internal.stepping=false;}expect(index.inventory().reconciled).toBe(before);
    const methods=sim as unknown as Record<string,Function>,original=methods.advanceWork!;methods.advanceWork=function(...args:unknown[]){return original.apply(sim,args);};
    publish(sim,target,2);expect(index.inventory().reconciled-before).toBe(Object.keys(sim.state.entities).length);
  });
  it('reconstructs legacy snapshots exactly and emits no unchanged resource DTOs or fog',()=>{
    const {sim,wood}=fixture(),target=receiver(),capture=sim.capture(),first=publish(sim,target,1),firstSnapshot=structuredClone(first[0]!.view);
    const next=publish(sim,target,2);expect(next[0]!.patch.entities.upserts).toEqual([]);expect(next[0]!.patch.fields.fog).toBeUndefined();expect(next[0]!.patch.fields.map).toBeUndefined();
    expect(next[0]!.patch.entities.upserts.some(entity=>entity.id==='hidden_tree')).toBe(false);
    // Publication state is derived only, and each outgoing patch is detached.
    expect(sim.capture()).toEqual(capture);first[0]!.patch.entities.upserts.find(entity=>entity.id===wood.id)!.amount=0;
    const third=publish(sim,target,3);expect(third[0]!.view.entities.find(entity=>entity.id===wood.id)!.amount).toBe(100);expect(first[0]!.view).toEqual(firstSnapshot);
  });
  it('updates visible HP/cargo/action and removes owner-only optional fields even when fog stays fixed',()=>{
    const {sim,scout,wood}=fixture(),target=receiver();Object.assign(scout,{typeId:'villager',hp:units.villager.maxHp,maxHp:units.villager.maxHp});publish(sim,target,1);const fog=structuredClone(sim.view('a').fog);
    scout.hp-=3;scout.cargo={resource:'wood',amount:7000};scout.orders=[{kind:'gather',targetId:wood.id,forestIntentId:wood.id}];scout.taskState='blocked';scout.blockedReason='PATH_BLOCKED';wood.amount-=1500;
    const changed=publish(sim,target,2)[0]!;expect(changed.view.fog).toEqual(fog);expect(changed.patch.fields.fog).toBeUndefined();expect(changed.patch.entities.upserts.find(entity=>entity.id===scout.id)).toMatchObject({cargo:{resource:'wood',amount:7},forestIntentId:wood.id,workTargetId:wood.id,blockedReason:'PATH_BLOCKED'});
    scout.orders=[];scout.taskState='idle';delete scout.blockedReason;scout.cargo={resource:null,amount:0};
    const cleared=publish(sim,target,3)[0]!.view.entities.find(entity=>entity.id===scout.id)!;
    expect(cleared.forestIntentId).toBeUndefined();expect(cleared.workTargetId).toBeUndefined();expect(cleared.blockedReason).toBeUndefined();
    const other=sim.view('b').entities.find(entity=>entity.id===scout.id);if(other){expect(other.cargo).toBeUndefined();expect(other.forestIntentId).toBeUndefined();}
  });
  it('retains brief sightings across skipped publications and does not disclose hidden clearing or deaths',()=>{
    const {sim,scout,worker,wood}=fixture(),target=receiver();publish(sim,target,1);
    scout.xMm=180000;scout.zMm=100000;sim.step();
    const hidden=publish(sim,target,2)[0]!.view,ghost=hidden.entities.find(entity=>entity.id===wood.id)!;
    expect(ghost.ghost).toBe(true);expect(hidden.entities.some(entity=>entity.id===worker.id)).toBe(false);
    wood.amount=0;worker.hp=0;sim.state.navigationRevision++;sim.step();
    const unseen=publish(sim,target,3)[0]!;expect(unseen.view.entities.find(entity=>entity.id===wood.id)).toEqual(ghost);expect(unseen.patch.entities.removed).not.toContain(wood.id);expect(unseen.patch.entities.upserts.some(entity=>entity.id===wood.id||entity.id===worker.id)).toBe(false);
    // No publication during this reveal/hide pair: authoritative memory must
    // still carry the legitimate latest sighting to the next credited delivery.
    scout.xMm=100000;sim.step();scout.xMm=180000;sim.step();
    const brief=publish(sim,target,4)[0]!.view.entities.find(entity=>entity.id===wood.id)!;expect(brief).toMatchObject({ghost:true,amount:0});expect(brief.lastSeenTick).toBeGreaterThan(ghost.lastSeenTick!);
  });
  it('cold restore/reset and visibility-dependent optional field changes retain byte-equivalent JSON',()=>{
    const {sim,scout,home}=fixture(),target=receiver();publish(sim,target,1);
    scout.garrisonedIn=home.id;home.garrisoned=[scout.id];scout.xMm=home.xMm;scout.zMm=home.zMm;sim.step();
    const garrisoned=publish(sim,target,2)[0]!.view.entities.find(entity=>entity.id===scout.id)!;expect(garrisoned.garrisonedIn).toBe(home.id);
    home.pendingUngarrison=[scout.id];sim.step();const released=publish(sim,target,3)[0]!.view.entities.find(entity=>entity.id===scout.id)!;expect(released.garrisonedIn).toBeUndefined();
    const restored=new Simulation(sim.options,sim.capture()),coldTarget=receiver();expect(publish(restored,coldTarget,4).map(row=>row.view)).toEqual(publish(sim,target,4).map(row=>row.view));
    restored.resetPublication();coldTarget.reset(2);const patches=restored.publicationProjections([{playerId:'a',sequence:5}]);expect(patches[0]!.baseRevision).toBe(0);expect(coldTarget.receive({generation:2,patch:patches[0]!},'a')).toEqual(JSON.parse(JSON.stringify({...restored.view('a'),sequence:5})));
  });
  it('reuses the actual unchanged clean building input while preserving detached public packets',()=>{
    const {sim,home}=fixture(),target=receiver(),inputs=vi.spyOn(RecipientProjection.prototype,'entity');
    try{
      const first=publish(sim,target,1,['a'])[0]!,original=inputs.mock.calls.find(([entity])=>entity.id===home.id)![0],snapshot=structuredClone(first.view);
      inputs.mockClear();sim.state.tick++;
      const next=publish(sim,target,2,['a'])[0]!;
      expect(inputs.mock.calls.find(([entity])=>entity.id===home.id)![0]).toBe(original);
      expect(next.patch.entities.upserts.some(entity=>entity.id===home.id)).toBe(false);
      first.patch.entities.upserts.find(entity=>entity.id===home.id)!.hp=1;
      expect(original.hp).toBe(home.hp);expect(first.view).toEqual(snapshot);
      const cold=new Simulation(sim.options,sim.capture()),coldView=publish(cold,receiver(),3,['a'])[0]!.view;
      expect(publish(sim,target,3,['a'])[0]!.view).toEqual(coldView);
    }finally{inputs.mockRestore();}
  });
  it('matches fresh building views through same-tick base, gate and observed-action edits',()=>{
    const {sim,home}=fixture(),target=receiver(),gate:Building={...structuredClone(home),id:'projection_gate',typeId:'wooden_gate',gateMode:'AUTO',gateOpen:false};sim.state.entities[gate.id]=gate;
    let sequence=1;publish(sim,target,sequence++,['a']);
    const changes:(()=>void)[]=[
      ()=>{gate.xMm+=1000;},()=>{gate.zMm+=1000;},()=>{gate.hp--;},()=>{gate.maxHp++;},
      ()=>{gate.rotation=90;},()=>{gate.work=Math.floor(gate.required/2);},()=>{gate.required=0;},
      ()=>{sim.state.economies.a!.age=2;},()=>{gate.gateOpen=true;},()=>{delete gate.gateOpen;},
      ()=>{gate.gateMode='LOCKED';},()=>{delete gate.gateMode;},
      ()=>{sim.state.vision.a!.actions[gate.id]={kind:'build',startedTick:sim.state.tick};},
      ()=>{sim.state.vision.a!.actions[gate.id]!.facingMilliRad=1250;},
      ()=>{delete sim.state.vision.a!.actions[gate.id];},()=>{gate.typeId='house';},
    ];
    for(const change of changes){change();const capture=JSON.stringify(sim.capture()),row=publish(sim,target,sequence++,['a'])[0]!;expect(row.patch.entities.upserts.some(entity=>entity.id===gate.id)).toBe(true);expect(JSON.stringify(sim.capture())).toBe(capture);}
    const capture=JSON.stringify(sim.capture());sim.resetPublication('a');const reset=publish(sim,receiver(),sequence++,['a'])[0]!;expect(reset.patch.baseRevision).toBe(0);expect(JSON.stringify(sim.capture())).toBe(capture);
  });
  it('keeps owner queues, nested fields, demolition countdown and farm transitions fresh',()=>{
    const {sim,home,scout}=fixture(),target=receiver();let sequence=1;publish(sim,target,sequence++,['a']);
    const compare=()=>publish(sim,target,sequence++,['a'])[0]!.view.entities.find(entity=>entity.id===home.id)!;
    home.queue.push({id:'projection_job',kind:'train',typeId:'villager',work:0,required:100,originalCost:{food:0,wood:0,gold:0,stone:0},reserved:false,started:false,state:'waiting'});
    expect(compare().queue).toMatchObject([{id:'projection_job',progress:0,started:false}]);
    Object.assign(home.queue[0]!,{work:50,started:true,state:'exit_blocked',blockedReason:'EXIT_BLOCKED'});expect(compare().queue).toMatchObject([{progress:.5,started:true,state:'exit_blocked',blockedReason:'EXIT_BLOCKED'}]);
    home.queue=[];expect(compare().queue).toEqual([]);
    home.rally={xMm:home.xMm+3000,zMm:home.zMm};expect(compare().rally).toEqual(home.rally);home.rally.xMm+=1000;expect(compare().rally).toEqual(home.rally);delete home.rally;expect(compare().rally).toBeUndefined();
    home.garrisoned=[scout.id];scout.garrisonedIn=home.id;expect(compare().garrisoned).toEqual([scout.id]);home.garrisoned.length=0;delete scout.garrisonedIn;expect(compare().garrisoned).toEqual([]);delete home.garrisoned;expect(compare().garrisoned).toBeUndefined();
    home.demolitionTick=sim.state.tick+7;expect(compare().demolitionTicksRemaining).toBe(7);sim.state.tick++;expect(compare().demolitionTicksRemaining).toBe(6);delete home.demolitionTick;expect(compare().demolitionTicksRemaining).toBeUndefined();
    home.typeId='farm';home.foodRemaining=100000;expect(compare()).toMatchObject({resource:'food',amount:100,farmState:'ready',farmerAssigned:false});
    home.foodRemaining=0;home.farmerId=scout.id;expect(compare()).toMatchObject({amount:0,farmState:'exhausted',farmerAssigned:true});
    home.reseedRequired=100;home.reseedWork=25;expect(compare()).toMatchObject({farmState:'reseeding',reseedProgress:.25});home.reseedWork=50;expect(compare().reseedProgress).toBe(.5);
    delete home.reseedRequired;delete home.reseedWork;delete home.farmerId;home.typeId='town_center';const restored=compare();for(const field of ['resource','amount','farmState','farmerAssigned','reseedProgress'] as const)expect(restored[field]).toBeUndefined();
  });
  it('keeps reused enemy buildings separate from owner data and later hidden memory',()=>{
    const {sim,home,scout,worker}=fixture(),target=receiver(),foreign:Building={...structuredClone(home),id:'foreign_gate',typeId:'wooden_gate',ownerId:'b',xMm:106000,zMm:100000,gateOpen:false,gateMode:'LOCKED',rally:{xMm:110000,zMm:100000},garrisoned:[]};sim.state.entities[foreign.id]=foreign;sim.step();
    sim.state.vision.a!.actions[foreign.id]={kind:'build',startedTick:sim.state.tick};sim.state.vision.b!.actions[foreign.id]={kind:'build',startedTick:sim.state.tick,facingMilliRad:700};
    const inputs=vi.spyOn(RecipientProjection.prototype,'entity');try{
    const first=publish(sim,target,1),enemy=first[0]!.view.entities.find(entity=>entity.id===foreign.id)!,owner=first[1]!.view.entities.find(entity=>entity.id===foreign.id)!;
    const priorEnemyInput=inputs.mock.calls.find(([entity])=>entity.id===foreign.id)![0];inputs.mockClear();
    for(const field of ['queue','rally','garrisoned','gateMode'] as const)expect(enemy[field]).toBeUndefined();expect(owner.gateMode).toBe('LOCKED');expect(enemy.visualAction).not.toEqual(owner.visualAction);
    foreign.rally!.xMm+=2000;foreign.gateMode='OPEN';foreign.garrisoned!.push(worker.id);worker.garrisonedIn=foreign.id;
    foreign.queue.push({id:'hidden_queue',kind:'train',typeId:'villager',work:0,required:100,originalCost:{food:0,wood:0,gold:0,stone:0},reserved:false,started:false,state:'waiting'});
    const privateOnly=publish(sim,target,2);expect(privateOnly[0]!.patch.entities.upserts.some(entity=>entity.id===foreign.id)).toBe(false);expect(privateOnly[1]!.view.entities.find(entity=>entity.id===foreign.id)!.rally).toEqual(foreign.rally);
    expect(inputs.mock.calls.find(([entity])=>entity.id===foreign.id)![0]).toBe(priorEnemyInput);
    foreign.queue=[];
    scout.xMm=180000;sim.step();const ghost=publish(sim,target,3)[0]!.view.entities.find(entity=>entity.id===foreign.id)!;expect(ghost.ghost).toBe(true);
    foreign.hp-=10;foreign.gateOpen=true;foreign.ownerId='a';const acquired=publish(sim,target,4)[0]!.view.entities.find(entity=>entity.id===foreign.id)!;expect(acquired.ghost).toBeUndefined();expect(acquired.queue).toEqual([]);expect(acquired.gateOpen).toBe(true);
    foreign.ownerId='b';const hidden=publish(sim,target,5)[0]!.view.entities.find(entity=>entity.id===foreign.id)!;expect(hidden).toEqual(ghost);expect(hidden.rally).toBeUndefined();
    }finally{inputs.mockRestore();}
  });
});

describe('owned fog projection retention',()=>{
  it('retains unchanged explored cells without cloning and detects in-place visibility and exploration edits',()=>{
    const cache=new RecipientProjection(),visible=[1,2],explored=[1,2,3],first=cache.retainFog(visible,explored);
    expect(first.visible).not.toBe(visible);expect(first.explored).not.toBe(explored);expect(cache.retainFog([...visible],[...explored])).toBe(first);
    visible[0]=0;const moved=cache.retainFog(visible,explored);expect(moved.visible).toEqual([0,2]);expect(moved.visible).not.toBe(first.visible);expect(moved.explored).toBe(first.explored);expect(first.visible).toEqual([1,2]);
    explored.push(4);const discovered=cache.retainFog(visible,explored);expect(discovered.visible).toBe(moved.visible);expect(discovered.explored).toEqual([1,2,3,4]);expect(first.explored).toEqual([1,2,3]);
  });
  it('skips only certified unchanged inputs while keeping both retained arrays detached',()=>{
    const cache=new RecipientProjection(),visible=[1,2],explored=[1,2,3],first=cache.retainFogOwned(visible,explored),before=RecipientProjection.fogRetentionDiagnostics();
    expect(first.visible).not.toBe(visible);expect(first.explored).not.toBe(explored);
    expect(cache.retainFogOwned(visible,explored)).toBe(first);
    expect(RecipientProjection.fogRetentionDiagnostics().reusedInputs-before.reusedInputs).toBe(2);
    const moved=cache.retainFogOwned([0,2],explored);
    expect(moved.visible).toEqual([0,2]);expect(moved.visible).not.toBe(first.visible);expect(moved.explored).toBe(first.explored);
    expect(RecipientProjection.fogRetentionDiagnostics().reusedInputs-before.reusedInputs).toBe(3);
    const discovered=cache.retainFogOwned([0,2],[0,1,2,3,4]);
    expect(discovered.visible).toBe(moved.visible);expect(discovered.explored).toEqual([0,1,2,3,4]);expect(first).toEqual({visible:[1,2],explored:[1,2,3]});
  });
  it.each(['mutable','retain','epoch','close'] as const)('drops owned input certificates at the %s boundary',boundary=>{
    const cache=new RecipientProjection(),visible=[1,2],explored=[1,2,3],first=cache.retainFogOwned(visible,explored);
    if(boundary==='mutable')cache.retainFog(visible,explored);
    else if(boundary==='retain')cache.retain('fog',first);
    else if(boundary==='epoch')cache.invalidateExports();
    else cache.closeExports();
    // The previous owner's replacement-only contract has ended. Reusing its
    // references now must not revive an earlier equality certificate.
    visible[0]=0;explored.push(4);const before=RecipientProjection.fogRetentionDiagnostics().reusedInputs,next=cache.retainFogOwned(visible,explored);
    expect(next).toEqual({visible:[0,2],explored:[1,2,3,4]});expect(first).toEqual({visible:[1,2],explored:[1,2,3]});
    expect(RecipientProjection.fogRetentionDiagnostics().reusedInputs).toBe(before);
  });
});

describe('native one-use projection ownership',()=>{
  type Packet={type:'projection-view';playerId:string;publicationRequest:number;transfer:{generation:number;patch:ProjectionPatch}};
  const binding=(generation=1)=>({generation,publicationRequest:0});
  function deliver(handle:NativeProjection,channel:MessageChannel,generation=1):Promise<Packet>{
    const received=new Promise<Packet>(resolve=>channel.port2.once('message',resolve));
    postNativeProjection(handle,channel.port1,binding(generation));return received;
  }
  function close(channel:MessageChannel):void{channel.port1.close();channel.port2.close();}

  it('reuses actual native 300 ms fog inputs across recipients without borrowing IPC arrays or losing concealment and epoch changes',async()=>{
    const {sim}=fixture(true),payload=sim.capture();payload.options.authoritativeIntervalMs=300;
    const options={...sim.options,authoritativeIntervalMs:300 as const},live=Simulation.createLive(options,payload),scalar=new Simulation(options,payload),channel=new MessageChannel(),target=receiver(),counts=RecipientProjection.fogRetentionDiagnostics();
    let sequence=0,generation=1;
    const compare=async()=>{
      sequence++;const requests=['a','b','c'].map(playerId=>({playerId,sequence})),expected=scalar.publicationProjections(requests),handles=live.publicationTransfers(requests),views:PlayerView[]=[];
      for(const [index,handle]of handles.entries()){
        const packet=await deliver(handle,channel,generation);expect(packet.transfer.patch).toEqual(expected[index]);
        const view=target.receive(packet.transfer,packet.playerId);expect(view).toEqual(JSON.parse(JSON.stringify({...scalar.view(packet.playerId),sequence})));views.push(view);
      }
      return views;
    };
    const move=(zMm:number)=>{const clientSequence=scalar.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:options.matchId,matchEpoch:scalar.state.matchEpoch,clientCommandId:`owned_fog_${clientSequence}`,clientSequence,command:{kind:'move',unitIds:['observer'],target:{xMm:100000,zMm},queued:false}};expect(live.command('a',envelope)).toEqual(scalar.command('a',envelope));};
    const advance=async()=>{for(let frame=0;frame<18;frame++){for(const source of [live,scalar]){source.advanceFrame();await source.synchronizeCapture();}}};
    try{
      const initial=await compare(),saved=structuredClone(initial);await compare();
      expect(RecipientProjection.fogRetentionDiagnostics().calls-counts.calls).toBe(6);expect(RecipientProjection.fogRetentionDiagnostics().reusedInputs-counts.reusedInputs).toBe(6);
      move(124000);await advance();const hidden=await compare();expect(hidden[0]!.entities.find(entity=>entity.id==='known_tree')?.ghost).toBe(true);expect(hidden[0]!.entities.some(entity=>entity.id==='foreign_worker')).toBe(false);expect(hidden[0]!.fog.visible).not.toEqual(initial[0]!.fog.visible);
      move(100000);await advance();const revealed=await compare();expect(revealed[0]!.entities.find(entity=>entity.id==='known_tree')?.ghost).not.toBe(true);expect(revealed[0]!.entities.some(entity=>entity.id==='foreign_worker')).toBe(true);expect(initial).toEqual(saved);
      // Received arrays may be edited by the receiving owner; neither live state
      // nor a future cache base may retain those aliases.
      const fog=live.view('a').fog;revealed[0]!.fog.visible.length=0;revealed[0]!.fog.explored.push(0);expect(live.view('a').fog).toEqual(fog);
      for(const source of [live,scalar]){source.invalidateEpoch(2);source.resetPublication();}generation++;target.reset(generation);await compare();expect(live.capture()).toEqual(scalar.capture());
    }finally{close(channel);}
  });

  it('never reuses native fog inputs after a projection helper changes, even when restored',async()=>{
    const {sim}=fixture(),payload=sim.capture();payload.options.authoritativeIntervalMs=300;
    const live=Simulation.createLive({...sim.options,authoritativeIntervalMs:300},payload),channel=new MessageChannel(),target=receiver();
    try{
      const first=await deliver(live.publicationTransfers([{playerId:'a',sequence:1}])[0]!,channel);target.receive(first.transfer,'a');
      const before=RecipientProjection.fogRetentionDiagnostics(),hook=vi.spyOn(RecipientProjection.prototype,'retainFogOwned');
      try{const packet=await deliver(live.publicationTransfers([{playerId:'a',sequence:2}])[0]!,channel);expect(target.receive(packet.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...live.view('a'),sequence:2})));expect(hook).not.toHaveBeenCalled();}finally{hook.mockRestore();}
      const next=await deliver(live.publicationTransfers([{playerId:'a',sequence:3}])[0]!,channel);expect(target.receive(next.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...live.view('a'),sequence:3})));expect(RecipientProjection.fogRetentionDiagnostics()).toEqual(before);
    }finally{close(channel);}
  });

  it('transfers cadence changes and deletion atomically through native fields and rejects malformed intervals',async()=>{
    const {sim}=fixture(),channel=new MessageChannel(),target=receiver(),source=new RecipientProjection();
    try{
      for(const [index,cadence] of ([undefined,100,150,200,undefined] as const).entries()){
        const view={...sim.view('a'),sequence:index+1,simulationSpeed:.5};
        if(cadence===undefined)delete view.publicationIntervalMs;else view.publicationIntervalMs=cadence;
        const {entities,...fields}=view;source.begin();for(const entity of entities)source.entity(structuredClone(entity));
        const packet=await deliver(source.finishNative(fields),channel);
        if(cadence===150){const invalid=structuredClone(packet.transfer);Object.assign(invalid.patch.fields,{publicationIntervalMs:125});expect(()=>target.receive(invalid,'a')).toThrow('INVALID_PROJECTION_TRANSFER');}
        expect(target.receive(packet.transfer,'a')).toEqual(JSON.parse(JSON.stringify(view)));
        if(index===4)expect(packet.transfer.patch.removedFields).toContain('publicationIntervalMs');
      }
    }finally{close(channel);}
  });

  it('transfers reduced-speed metadata and its deletion through native projections without altering saved state',async()=>{
    const {sim}=fixture(),channel=new MessageChannel(),target=receiver(),capture=sim.capture();
    try{
      for(const [index,speed] of [1,.9,.1,1].entries()){
        sim.setPresentationSpeed(speed);
        const packet=await deliver(sim.publicationTransfers([{playerId:'a',sequence:index+1}])[0]!,channel);
        const view=target.receive(packet.transfer,packet.playerId);
        expect(view).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:index+1})));expect(view.simulationSpeed??1).toBe(speed);
        if(index===3)expect(packet.transfer.patch.removedFields).toContain('simulationSpeed');
        expect(sim.capture()).toEqual(capture);
      }
    }finally{close(channel);}
  });

  it('matches detached full, delta and reset patches exactly over a real MessageChannel',async()=>{
    const {sim}=fixture(),reference=new Simulation(sim.options,sim.capture()),channel=new MessageChannel(),target=receiver();
    const compare=async(sequence:number,generation=1)=>{
      const requests=['a','b'].map(playerId=>({playerId,sequence})),expected=reference.publicationProjections(requests),handles=sim.publicationTransfers(requests),packets:Packet[]=[];
      for(const [index,handle]of handles.entries()){
        expect(nativeProjectionHeader(handle)).toEqual(expected[index]!.header);
        const packet=await deliver(handle,channel,generation);packets.push(packet);
        expect(packet).toMatchObject({type:'projection-view',playerId:requests[index]!.playerId,publicationRequest:0,transfer:{generation}});
        expect(JSON.stringify(packet.transfer.patch)).toBe(JSON.stringify(expected[index]!));
        expect(target.receive(packet.transfer,packet.playerId)).toEqual(JSON.parse(JSON.stringify({...sim.view(packet.playerId),sequence})));
      }
      return packets;
    };
    try{
      const first=await compare(1);expect(first.every(packet=>packet.transfer.patch.baseRevision===0)).toBe(true);
      for(const source of [sim,reference]){(source.state.entities.known_tree as ResourceNode).amount-=1000;(source.state.entities.observer as Unit).hp--;}
      const changed=await compare(2);expect(changed[0]!.transfer.patch.entities.upserts.some(entity=>entity.id==='known_tree')).toBe(true);
      const unchanged=await compare(3);expect(unchanged.every(packet=>packet.transfer.patch.entities.upserts.length===0)).toBe(true);
      for(const source of [sim,reference]){source.invalidateEpoch(2);source.setStatus('PAUSED');source.resetPublication();}
      target.reset(2);const reset=await compare(4,2);expect(reset.every(packet=>packet.transfer.patch.baseRevision===0&&packet.transfer.patch.revision===1&&packet.transfer.patch.header.matchEpoch===2)).toBe(true);
      expect(JSON.stringify(sim.capture())).toBe(JSON.stringify(reference.capture()));
    }finally{close(channel);}
  });

  it('keeps transport and receiver mutations out of retained source and earlier publications',async()=>{
    const {sim,wood}=fixture(),channel=new MessageChannel(),firstTarget=receiver(),independentTarget=receiver();
    try{
      const first=await deliver(sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!,channel),firstSnapshot=structuredClone(first);
      const earlier=independentTarget.receive(first.transfer,'a'),earlierSnapshot=structuredClone(earlier),mutable=firstTarget.receive(first.transfer,'a');
      mutable.entities.find(entity=>entity.id===wood.id)!.amount=-1;mutable.fog.visible.length=0;
      first.transfer.patch.entities.upserts.find(entity=>entity.id===wood.id)!.amount=-2;first.transfer.patch.fields.fog!.visible.length=0;
      const next=await deliver(sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!,channel);
      expect(next.transfer.patch.entities.upserts).toEqual([]);expect(next.transfer.patch.fields.fog).toBeUndefined();
      expect(independentTarget.receive(next.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:2})));expect(earlier).toEqual(earlierSnapshot);expect(wood.amount).toBe(100000);
      wood.amount-=1000;const third=await deliver(sim.publicationTransfers([{playerId:'a',sequence:3}])[0]!,channel);
      expect(independentTarget.receive(third.transfer,'a').entities.find(entity=>entity.id===wood.id)!.amount).toBe(99);
      expect(earlier).toEqual(earlierSnapshot);expect(firstSnapshot.transfer.patch.entities.upserts.find(entity=>entity.id===wood.id)!.amount).toBe(100);
    }finally{close(channel);}
  });

  it('rejects forged ports and fake, cloned, consumed and stale handles without exposing a patch',async()=>{
    const {sim}=fixture(),channel=new MessageChannel();let intercepted:unknown;
    const fake={postMessage:(value:unknown)=>{intercepted=value;}},prototypeFake=Object.create(MessagePort.prototype) as MessagePort;
    try{
      expect(isNativeProjectionPort(channel.port1)).toBe(true);expect(isNativeProjectionPort(fake)).toBe(false);expect(isNativeProjectionPort(prototypeFake)).toBe(false);
      const handle=sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!,header=nativeProjectionHeader(handle);
      expect(Object.isFrozen(header)).toBe(true);expect(handle).not.toHaveProperty('fields');expect(handle).not.toHaveProperty('entities');expect(header).not.toHaveProperty('fields');
      for(const invalid of [{},structuredClone(handle)]){
        expect(()=>nativeProjectionHeader(invalid as NativeProjection)).toThrow('INVALID_NATIVE_PROJECTION');
        expect(()=>postNativeProjection(invalid as NativeProjection,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
      }
      for(const invalidPort of [fake,prototypeFake])expect(()=>postNativeProjection(handle,invalidPort as MessagePort,binding())).toThrow('INVALID_NATIVE_PROJECTION_PORT');
      expect(intercepted).toBeUndefined();await deliver(handle,channel);
      expect(()=>nativeProjectionHeader(handle)).toThrow('INVALID_NATIVE_PROJECTION');expect(()=>postNativeProjection(handle,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
      const obsolete=sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!;
      sim.publicationProjections([{playerId:'a',sequence:3}]);expect(()=>postNativeProjection(obsolete,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
      const reset=sim.publicationTransfers([{playerId:'a',sequence:4}])[0]!;sim.resetPublication('a');expect(()=>nativeProjectionHeader(reset)).toThrow('INVALID_NATIVE_PROJECTION');
      const epoch=sim.publicationTransfers([{playerId:'a',sequence:5}])[0]!;sim.invalidateEpoch(2);expect(()=>nativeProjectionHeader(epoch)).toThrow('INVALID_NATIVE_PROJECTION');expect(()=>postNativeProjection(epoch,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
    }finally{close(channel);}
  });

  it('invalidates only the superseded recipient and uses the captured native method instead of a port override',async()=>{
    const {sim}=fixture(),channel=new MessageChannel();let calls=0;
    Object.defineProperty(channel.port1,'postMessage',{configurable:true,get(){calls++;throw new Error('UNTRUSTED_PORT_OVERRIDE');}});
    try{
      const [a,b]=sim.publicationTransfers([{playerId:'a',sequence:1},{playerId:'b',sequence:1}]);
      sim.resetPublication('a');expect(()=>postNativeProjection(a!,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
      const packet=await deliver(b!,channel);expect(packet.playerId).toBe('b');expect(calls).toBe(0);
      const renewed=await deliver(sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!,channel);expect(renewed.transfer.patch.baseRevision).toBe(0);expect(calls).toBe(0);
    }finally{close(channel);}
  });

  it('consumes a handle before a native clone failure and requires a fresh publication after reset',async()=>{
    const {sim,home}=fixture(),channel=new MessageChannel();
    try{
      home.rally={xMm:home.xMm,zMm:home.zMm,uncloneable:()=>undefined} as unknown as NonNullable<Building['rally']>;
      const handle=sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!;
      expect(()=>postNativeProjection(handle,channel.port1,binding())).toThrow(/clone/i);
      expect(()=>nativeProjectionHeader(handle)).toThrow('INVALID_NATIVE_PROJECTION');expect(()=>postNativeProjection(handle,channel.port1,binding())).toThrow('INVALID_NATIVE_PROJECTION');
      delete home.rally;sim.resetPublication();const recovered=await deliver(sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!,channel,2),target=new RecipientProjectionReceiver();target.reset(2);
      expect(recovered.transfer.patch).toMatchObject({baseRevision:0,revision:1});expect(target.receive(recovered.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:2})));
    }finally{close(channel);}
  });

  it('detaches custom reader aliases before preparing a delayed native send',async()=>{
    const {sim,wood}=fixture(),channel=new MessageChannel(),expected=JSON.parse(JSON.stringify({...sim.view('a'),sequence:1})),methods=sim as unknown as Record<string,Function>,original=methods.asView!;
    let alias:PlayerView['entities'][number]|undefined;
    methods.asView=function(entity:Entity,...args:unknown[]){const view=original.call(sim,entity,...args);if(entity.id===wood.id)alias=view;return view;};
    try{
      const handle=sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!;expect(alias).toBeDefined();alias!.amount=0;alias!.xMm=0;
      const packet=await deliver(handle,channel);expect(receiver().receive(packet.transfer,'a')).toEqual(expected);expect(wood.amount).toBe(100000);expect(wood.xMm).toBe(104000);
      // The existing public API must also keep its detached ownership contract.
      const publicPatch=sim.publicationProjections([{playerId:'a',sequence:2}])[0]!;publicPatch.entities.upserts.find(entity=>entity.id===wood.id)!.amount=-1;
      expect(sim.view('a').entities.find(entity=>entity.id===wood.id)!.amount).toBe(100);
    }finally{close(channel);}
  });

  it.each([
    {scope:'instance',partialReset:false,playerId:'a'},
    {scope:'instance',partialReset:true,playerId:'b'},
    {scope:'prototype',partialReset:false,playerId:'a'},
  ])('retains detached ownership after a $scope reader is restored (partial reset=$partialReset)',async({scope,partialReset,playerId})=>{
    const {sim,wood}=fixture(),channel=new MessageChannel(),target=receiver(),methods=(scope==='prototype'?Simulation.prototype:sim) as unknown as Record<string,Function>,original=methods.asView!,aliases=new Map<string,PlayerView['entities'][number]>();
    const restore=()=>{if(scope==='prototype')methods.asView=original;else delete methods.asView;};
    let restoreClone:(()=>void)|undefined;
    methods.asView=function(this:Simulation,entity:Entity,own:boolean,recipient:string){const view=original.call(this,entity,own,recipient);if(entity.id===wood.id)aliases.set(recipient,view);return view;};
    try{
      const publicPatches=sim.publicationProjections([{playerId:'a',sequence:1},{playerId:'b',sequence:1}]);
      for(const patch of publicPatches)target.receive({generation:1,patch},patch.header.playerId);
      expect(aliases.has(playerId)).toBe(true);restore();if(partialReset)sim.resetPublication('a');
      const expected=JSON.parse(JSON.stringify({...sim.view(playerId),sequence:2}));
      // Observe the actual copy boundary without overriding a publication reader:
      // restoring a hook must not silently certify its surviving cache as private.
      const clone=vi.spyOn(globalThis,'structuredClone');restoreClone=()=>clone.mockRestore();
      const handle=sim.publicationTransfers([{playerId,sequence:2}])[0]!;
      expect(clone.mock.calls.some(([value])=>value&&typeof value==='object'&&'header'in value&&'entities'in value)).toBe(true);
      clone.mockRestore();restoreClone=undefined;
      aliases.get(playerId)!.amount=0;aliases.get(playerId)!.xMm=0;
      const packet=await deliver(handle,channel);expect(target.receive(packet.transfer,playerId)).toEqual(expected);expect(wood.amount).toBe(100000);
      expect(publicPatches.find(patch=>patch.header.playerId===playerId)!.entities.upserts.find(entity=>entity.id===wood.id)!.amount).toBe(100);
    }finally{restoreClone?.();restore();close(channel);}
  });

  it('preserves the prepared snapshot when canonical world data changes before native posting',async()=>{
    const {sim,wood,scout,home}=fixture(),channel=new MessageChannel();
    home.rally={xMm:home.xMm+2000,zMm:home.zMm};scout.cargo={resource:'wood',amount:1000};
    const expected=JSON.parse(JSON.stringify({...sim.view('a'),sequence:1})),handle=sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!;
    try{
      wood.amount-=1000;wood.xMm+=1000;home.rally.xMm+=2000;scout.cargo.amount=9000;
      sim.state.factions[0]!.name='Changed after preparation';sim.state.vision.a!.visible.length=0;sim.state.vision.a!.explored.length=0;
      sim.state.vision.a!.memory[wood.id]!.amount=0;sim.setStatus('PAUSED');
      const packet=await deliver(handle,channel);expect(receiver().receive(packet.transfer,'a')).toEqual(expected);
      expect(packet.transfer.patch.header.status).toBe('RUNNING');expect(sim.state.status).toBe('PAUSED');
    }finally{close(channel);}
  });
  it('keeps an unchanged building delta detached from mutations before native send and after reset',async()=>{
    const {sim,home}=fixture(),channel=new MessageChannel(),target=receiver();
    try{
      const first=await deliver(sim.publicationTransfers([{playerId:'a',sequence:1}])[0]!,channel),earlier=target.receive(first.transfer,'a'),earlierSnapshot=structuredClone(earlier);
      const expected=JSON.parse(JSON.stringify({...sim.view('a'),sequence:2})),unchanged=sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!;
      home.hp--;home.rotation=90;home.rally={xMm:home.xMm+2000,zMm:home.zMm};
      const second=await deliver(unchanged,channel);expect(second.transfer.patch.entities.upserts.some(entity=>entity.id===home.id)).toBe(false);expect(target.receive(second.transfer,'a')).toEqual(expected);expect(earlier).toEqual(earlierSnapshot);
      const fresh=JSON.parse(JSON.stringify({...sim.view('a'),sequence:3})),pending=sim.publicationTransfers([{playerId:'a',sequence:3}])[0]!;home.rally.xMm+=1000;
      const third=await deliver(pending,channel);expect(target.receive(third.transfer,'a')).toEqual(fresh);expect(earlier).toEqual(earlierSnapshot);
      sim.resetPublication();target.reset(2);const reset=await deliver(sim.publicationTransfers([{playerId:'a',sequence:4}])[0]!,channel,2);expect(reset.transfer.patch.baseRevision).toBe(0);expect(target.receive(reset.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:4})));
    }finally{close(channel);}
  });
  it.each(['instance','prototype'] as const)('does not reuse a building alias after restoring a custom %s reader',async scope=>{
    const {sim,home}=fixture(),channel=new MessageChannel(),target=receiver(),methods=(scope==='prototype'?Simulation.prototype:sim) as unknown as Record<string,Function>,original=methods.asView!;
    let alias:ViewEntity|undefined;const restore=()=>{if(scope==='prototype')methods.asView=original;else delete methods.asView;};
    methods.asView=function(this:Simulation,entity:Entity,...args:unknown[]){const view=original.call(this,entity,...args) as ViewEntity;if(entity.id===home.id)alias=view;return view;};
    const inputs=vi.spyOn(RecipientProjection.prototype,'entity');
    try{
      const first=sim.publicationProjections([{playerId:'a',sequence:1}])[0]!;target.receive({generation:1,patch:first},'a');expect(alias).toBeDefined();const retainedAlias=alias!;restore();
      const expected=JSON.parse(JSON.stringify({...sim.view('a'),sequence:2}));inputs.mockClear();const handle=sim.publicationTransfers([{playerId:'a',sequence:2}])[0]!;
      expect(inputs.mock.calls.find(([entity])=>entity.id===home.id)![0]).not.toBe(retainedAlias);
      retainedAlias.hp=1;retainedAlias.rotation=270;const packet=await deliver(handle,channel);expect(target.receive(packet.transfer,'a')).toEqual(expected);
      const next=await deliver(sim.publicationTransfers([{playerId:'a',sequence:3}])[0]!,channel);expect(target.receive(next.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:3})));
      sim.resetPublication();target.reset(2);inputs.mockClear();const reset=await deliver(sim.publicationTransfers([{playerId:'a',sequence:4}])[0]!,channel,2);target.receive(reset.transfer,'a');const clean=inputs.mock.calls.find(([entity])=>entity.id===home.id)![0];
      inputs.mockClear();const warm=await deliver(sim.publicationTransfers([{playerId:'a',sequence:5}])[0]!,channel,2);expect(inputs.mock.calls.find(([entity])=>entity.id===home.id)![0]).toBe(clean);expect(target.receive(warm.transfer,'a')).toEqual(JSON.parse(JSON.stringify({...sim.view('a'),sequence:5})));
    }finally{inputs.mockRestore();restore();close(channel);}
  });
});
