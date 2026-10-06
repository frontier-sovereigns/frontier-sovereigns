import { describe, expect, it, vi } from 'vitest';
import { buildings, units, validatePlayerView, type BuildingId, type GameplayCommand, type Position, type ResourceType, type UnitId, type VisualAction } from '@frontier/shared';
import { createSimulation, createLiveSimulation, createReplayRecording, exportReplay, exportSimulationSave, restoreSimulation, replayCheckpoint, ReplayRunner, Simulation, type SimulationState, type Entity, type Unit, type Building, type EngineIdentity } from '../src/index.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { ObservedActionCache, observationUnitCells, visibleObservedUnit, updateObservedActions, type CommittedAction } from '../src/observed-actions.js';

const identity:EngineIdentity={engineBuildHash:'7'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function fixture(){
  const sim=createSimulation({matchId:'visuals',seed:'m7-observed',controllers:false,sharedVision:false,factions:['blue','red','green'].map(id=>({id,name:id,kind:'human',teamId:id,color:'#123456'}))});
  sim.state.entities={};sim.state.map.terrain=[];sim.state.navigationRevision++;for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.actions={};vision.explored=[];}
  let nonce=0;
  const unit=(typeId:UnitId,ownerId='blue',xMm=100000,zMm=100000):Unit=>{const def=units[typeId],entity:Unit={id:`actor_${++nonce}`,kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',...(typeId==='trebuchet'?{deploymentState:'packed' as const}:{})};sim.state.entities[entity.id]=entity;return entity;};
  const building=(typeId:BuildingId,ownerId='blue',xMm=40000,zMm=40000):Building=>{const def=buildings[typeId],entity:Building={id:`structure_${++nonce}`,kind:'building',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,grantedHp:def.maxHp,rotation:0,work:def.buildSeconds*2000,required:def.buildSeconds*2000,queue:[],cooldown:0};sim.state.entities[entity.id]=entity;sim.state.navigationRevision++;return entity;};
  for(const [index,owner]of ['blue','red','green'].entries())building('town_center',owner,40000+index*120000,320000);
  return {sim,unit,building};
}
function send(sim:Simulation,owner:string,command:GameplayCommand){const sequence=sim.state.economies[owner]!.lastClientSequence+1;return sim.command(owner,{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${owner}_${sequence}`,clientSequence:sequence,command});}
const visible=(sim:Simulation,id:string,owner='blue')=>sim.view(owner).entities.find(entity=>entity.id===id)!;
interface ObservationInternals {
  committedActions:Map<string,CommittedAction>;
  observeActions():void;
  updateVision():void;
  visible(playerId:string,entity:Position):boolean;
}
/** Previous action reducer, with its original live visibility calls as the oracle. */
function referenceObservedActions(state:SimulationState,committed:ReadonlyMap<string,CommittedAction>,canSee:(playerId:string,entity:Entity)=>boolean):void {
  const entities=Object.values(state.entities).filter(entity=>entity.kind!=='resource');
  for(const faction of state.factions){
    const vision=state.vision[faction.id]!,prior=vision.actions,next:typeof prior={};
    for(const entity of entities){
      if(entity.ownerId!==faction.id&&(!canSee(faction.id,entity)||entity.kind==='unit'&&entity.garrisonedIn))continue;
      const occurrence=committed.get(entity.id),action=occurrence&&(!occurrence.recipients||occurrence.recipients.includes(faction.id))?occurrence:undefined,previous=prior[entity.id];
      const kind=action?.kind??(entity.kind==='unit'&&entity.cargo.amount>0?'carry':'idle');let observation:VisualAction;
      const facing=action?.facingMilliRad===undefined?{}:{facingMilliRad:action.facingMilliRad};
      if(action?.kind==='attack')observation={kind:'attack',startedTick:state.tick,durationTicks:action.durationTicks!,...facing};
      else if(!action&&previous?.kind==='attack'&&state.tick<previous.startedTick+previous.durationTicks!)observation=previous;
      else observation=previous?.kind===kind?(action?.facingMilliRad===undefined||previous.facingMilliRad===action.facingMilliRad?previous:{...previous,...facing}):{kind,startedTick:state.tick,...facing};
      next[entity.id]=observation;
      if(vision.memory[entity.id]&&(entity.ownerId!==faction.id||canSee(faction.id,entity)))vision.memory[entity.id]!.visualAction={...observation};
    }
    vision.actions=next;
  }
}

describe('native authorized action dictionary retention',()=>{
  function ownedFixture(){
    const rig=fixture(),internal=rig.sim as unknown as ObservationInternals,cache=new ObservedActionCache(),rosters=new Map<string,readonly Entity[]>();
    const check=(actions:[string,CommittedAction][]=[])=>{
      internal.updateVision();const committed=new Map(actions),state=rig.sim.state,expected=structuredClone(state),world=Object.values(state.entities).filter(entity=>entity.kind!=='resource');
      referenceObservedActions(expected,committed,(playerId,entity)=>internal.visible(playerId,entity));
      for(const faction of state.factions){const next=world.filter(entity=>entity.ownerId===faction.id||internal.visible(faction.id,entity)&&!(entity.kind==='unit'&&entity.garrisonedIn)),prior=rosters.get(faction.id);if(!prior||prior.length!==next.length||prior.some((entity,index)=>entity!==next[index]))rosters.set(faction.id,next);}
      cache.updateOwned(state,committed,playerId=>rosters.get(playerId)!,(playerId,entity)=>internal.visible(playerId,entity));
      expect(state.vision).toEqual(expected.vision);expect(JSON.stringify(state.vision)).toBe(JSON.stringify(expected.vision));
      return state.vision.blue!.actions;
    };
    return {...rig,internal,cache,rosters,check};
  }
  it('retains unchanged dictionary identity while applying real actions, cargo, attack expiry and private recipient restrictions',()=>{
    const rig=ownedFixture(),observer=rig.unit('scout','blue',90000,100000),worker=rig.unit('villager','red'),tower=rig.building('watchtower','red',102000,100000);observer.cooldown=1000;
    rig.sim.state.tick=10;const dictionary=rig.check();expect(dictionary[worker.id]).toEqual({kind:'idle',startedTick:10});
    rig.sim.state.tick++;expect(rig.check([[worker.id,{kind:'mine',facingMilliRad:1571}],[tower.id,{kind:'attack',durationTicks:3,facingMilliRad:0,recipients:['red']}]] )).toBe(dictionary);expect(dictionary[tower.id]!.kind).toBe('idle');expect(rig.sim.state.vision.red!.actions[tower.id]!.kind).toBe('attack');
    rig.sim.state.tick++;worker.cargo={resource:'gold',amount:4000};expect(rig.check()).toBe(dictionary);expect(dictionary[worker.id]).toEqual({kind:'carry',startedTick:12});
    rig.sim.state.tick++;expect(rig.check([[tower.id,{kind:'attack',durationTicks:3,facingMilliRad:1571,recipients:['blue','red']}]] )).toBe(dictionary);expect(dictionary[tower.id]!.startedTick).toBe(13);
    rig.sim.state.tick=15;expect(rig.check()).toBe(dictionary);expect(dictionary[tower.id]!.kind).toBe('attack');
    rig.sim.state.tick=16;worker.cargo={resource:null,amount:0};expect(rig.check()).toBe(dictionary);expect(dictionary[worker.id]).toEqual({kind:'idle',startedTick:16});expect(dictionary[tower.id]).toEqual({kind:'idle',startedTick:16});
    const generic=new ObservedActionCache(),before=rig.sim.state.vision.blue!.actions;generic.update(rig.sim.state,new Map(),id=>rig.rosters.get(id)!,(id,e)=>rig.internal.visible(id,e));expect(rig.sim.state.vision.blue!.actions).not.toBe(before);const second=rig.sim.state.vision.blue!.actions;generic.update(rig.sim.state,new Map(),id=>rig.rosters.get(id)!,(id,e)=>rig.internal.visible(id,e));expect(rig.sim.state.vision.blue!.actions).not.toBe(second);
  });
  it('rebuilds on conceal/reveal, garrison, ownership, death, new actors and canonical roster reordering without advancing hidden ghost poses',()=>{
    const rig=ownedFixture(),observer=rig.unit('scout','blue',90000,100000),worker=rig.unit('villager','red'),tower=rig.building('watchtower','red',102000,100000);rig.sim.state.tick=20;
    const visibleDictionary=rig.check([[tower.id,{kind:'attack',durationTicks:3,recipients:['blue','red']}] ]),ghost=structuredClone(rig.sim.state.vision.blue!.memory[tower.id]);
    observer.xMm=40000;observer.zMm=40000;rig.sim.state.tick++;const hidden=rig.check([[tower.id,{kind:'attack',durationTicks:4,recipients:['red']}] ]);expect(hidden).not.toBe(visibleDictionary);expect(hidden[worker.id]).toBeUndefined();expect(hidden[tower.id]).toBeUndefined();expect(rig.sim.state.vision.blue!.memory[tower.id]).toEqual(ghost);
    observer.xMm=90000;observer.zMm=100000;rig.sim.state.tick++;const revealed=rig.check();expect(revealed).not.toBe(hidden);expect(revealed[tower.id]).toEqual({kind:'idle',startedTick:22});
    worker.garrisonedIn=tower.id;const contained=rig.check();expect(contained).not.toBe(revealed);expect(contained[worker.id]).toBeUndefined();expect(rig.sim.state.vision.red!.actions[worker.id]).toBeDefined();delete worker.garrisonedIn;const emerged=rig.check();expect(emerged).not.toBe(contained);expect(emerged[worker.id]).toBeDefined();
    worker.ownerId='blue';worker.xMm=300000;worker.zMm=300000;const owned=rig.check();expect(owned[worker.id]).toBeDefined();worker.ownerId='red';const foreign=rig.check();expect(foreign).not.toBe(owned);expect(foreign[worker.id]).toBeUndefined();
    delete rig.sim.state.entities[tower.id];const died=rig.check();expect(died[tower.id]).toBeUndefined();const added=rig.building('house','red',102000,100000),born=rig.check();expect(born).not.toBe(died);expect(born[added.id]).toBeDefined();
    delete rig.sim.state.entities[observer.id];rig.sim.state.entities[observer.id]=observer;const reordered=rig.check();expect(reordered).not.toBe(born);expect(Object.keys(reordered).at(-1)).toBe(observer.id);
  });
  it('rebuilds after replaced dictionaries, epochs, state restoration and return from the generic path',()=>{
    const rig=ownedFixture();rig.unit('villager');rig.sim.state.tick=30;const before=rig.check();
    rig.sim.state.vision.blue!.actions={...before,foreign_stale:{kind:'idle',startedTick:0}};const replaced=rig.sim.state.vision.blue!.actions;expect(rig.check()).not.toBe(replaced);expect(rig.sim.state.vision.blue!.actions.foreign_stale).toBeUndefined();
    const prior=rig.sim.state.vision.blue!.actions;rig.sim.state.matchEpoch++;expect(rig.check()).not.toBe(prior);
    const restored=structuredClone(rig.sim.state),expected=structuredClone(restored),actors=Object.values(restored.entities).filter(entity=>entity.kind!=='resource'),visible=(id:string,entity:Entity)=>rig.internal.visible(id,entity);referenceObservedActions(expected,new Map(),visible);
    const snapshot=restored.vision.blue!.actions;rig.cache.updateOwned(restored,new Map(),id=>actors.filter(e=>e.ownerId===id||visible(id,e)&&!(e.kind==='unit'&&e.garrisonedIn)),visible);expect(restored.vision).toEqual(expected.vision);expect(restored.vision.blue!.actions).not.toBe(snapshot);
    rig.cache.update(rig.sim.state,new Map(),id=>rig.rosters.get(id)!,visible);const generic=rig.sim.state.vision.blue!.actions;expect(rig.check()).not.toBe(generic);
  });
  it('matches complete native/scalar coarse frames through combat death, cold restore and replay',async()=>{
    const rig=fixture(),attacker=rig.unit('militia','blue',100000,100000),victim=rig.unit('villager','red',101500,100000),observer=rig.unit('scout','green',93000,100000);victim.hp=1;victim.cooldown=observer.cooldown=1000;
    // The hand-built fixture clears explored cells; commit current fog before
    // sealing its initial state so every visible cell is legitimately explored.
    (rig.sim as unknown as ObservationInternals).updateVision();
    const options={...rig.sim.options,authoritativeIntervalMs:300 as const},payload=rig.sim.capture(),live=createLiveSimulation(options,payload),scalar=createLiveSimulation(options,payload);
    // The comparison remains the independent mutable implementation; native
    // dictionary identity is not part of the saved/replayed gameplay contract.
    const referenceCoarse=new Simulation(options,payload);
    for(let frame=0;frame<3;frame++){live.advanceFrame();referenceCoarse.advanceFrame();await live.synchronizeCapture();await referenceCoarse.synchronizeCapture();expect(live.capture()).toEqual(referenceCoarse.capture());for(const faction of payload.state.factions)expect(live.view(faction.id)).toEqual(referenceCoarse.view(faction.id));}
    expect(live.state.entities[victim.id]).toBeUndefined();expect(live.state.vision.blue!.actions[attacker.id]).toBeDefined();
    const saved=live.capture(),cold=createLiveSimulation(options,saved);expect(validateSimulationSavePayload(saved)).toBe(true);expect(cold.capture()).toEqual(saved);
    const recording=exportReplay(live,identity,[replayCheckpoint(live)]);expect(validateSimulationSavePayload(recording.initial.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(live.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(saved);
    for(const sim of [live,cold,referenceCoarse]){sim.advanceFrame();await sim.synchronizeCapture();}expect(cold.capture()).toEqual(live.capture());expect(referenceCoarse.capture()).toEqual(live.capture());
    // A prototype edit revokes the factory proof permanently; no owned method
    // should run after the fallback has been selected.
    const owned=vi.spyOn(ObservedActionCache.prototype,'updateOwned');try{scalar.advanceFrame();expect(owned).not.toHaveBeenCalled();}finally{owned.mockRestore();}
  });
});

describe('restored phase-local observation unit geometry',()=>{
  it('matches center-first scalar visibility across every catalog radius, grid tangency and off-grid alias',()=>{
    const {sim,unit}=fixture(),actor=unit('villager','red'),internal=sim as unknown as ObservationInternals&{visibilityMasks:Map<string,Uint8Array>};
    sim.state.widthMm=8000;sim.state.heightMm=6000;const mask=new Uint8Array(12);internal.visibilityMasks.set('blue',mask);
    for(const typeId of Object.keys(units) as UnitId[]){
      actor.typeId=typeId;const radius=units[typeId].collisionRadiusM*1000,coordinates=[-radius,-0.25,0,2000-radius,2000-radius+0.25,1999.75,2000,2000+radius,6000,8000.25];
      for(const xMm of coordinates)for(const zMm of coordinates){
        Object.assign(actor,{xMm,zMm});const geometry=observationUnitCells([actor],8000,6000);
        // Giant bodies exceed the packed one-cell-radius fast path. They must
        // retain scalar visibility, not invent a truncated packed footprint.
        if(radius<=2000)expect(geometry.cells[0]).toBe(Math.floor(zMm/2000)*4+Math.floor(xMm/2000));
        else {expect(geometry.ranges[0]).toBe(-1);expect(geometry.cells).toEqual([]);}
        for(let cell=-1;cell<mask.length;cell++){
          mask.fill(0);if(cell>=0)mask[cell]=1;
          expect(visibleObservedUnit(actor,0,geometry,mask,()=>internal.visible('blue',actor))).toBe(internal.visible('blue',actor));
        }
      }
    }
  });
  it('reads current masks and garrison state while unsupported geometry retains scalar results and errors',()=>{
    const {sim,unit}=fixture(),actor=unit('villager','red',2000,2000),internal=sim as unknown as ObservationInternals&{visibilityMasks:Map<string,Uint8Array>};
    sim.state.widthMm=8000;sim.state.heightMm=6000;const mask=new Uint8Array(12),geometry=observationUnitCells([actor],8000,6000);internal.visibilityMasks.set('blue',mask);
    const current=()=>visibleObservedUnit(actor,0,geometry,internal.visibilityMasks.get('blue'),()=>internal.visible('blue',actor));
    expect(current()).toBe(false);mask[5]=1;expect(current()).toBe(true);actor.garrisonedIn='container';expect(current()).toBe(false);delete actor.garrisonedIn;
    internal.visibilityMasks.delete('blue');expect(current()).toBe(false);internal.visibilityMasks.set('blue',mask);
    const evaluate=(run:()=>boolean)=>{try{return {value:run()};}catch(error){return {error:(error as Error).name,message:(error as Error).message};}};
    for(const xMm of [NaN,Infinity,-Infinity,Number.MAX_VALUE]){
      actor.xMm=xMm;const fallback=observationUnitCells([actor],8000,6000);expect(fallback.ranges[0]).toBe(-1);
      expect(evaluate(()=>visibleObservedUnit(actor,0,fallback,mask,()=>internal.visible('blue',actor)))).toEqual(evaluate(()=>internal.visible('blue',actor)));
    }
    actor.xMm=2000;actor.typeId='unknown_fixture_type' as UnitId;const unknown=observationUnitCells([actor],8000,6000);
    expect(unknown.ranges[0]).toBe(-1);expect(visibleObservedUnit(actor,0,unknown,mask,()=>internal.visible('blue',actor))).toBe(true);
    mask.fill(0);expect(evaluate(()=>visibleObservedUnit(actor,0,unknown,mask,()=>internal.visible('blue',actor)))).toEqual(evaluate(()=>internal.visible('blue',actor)));
  });
  it('preserves scalar observations for duplicate actor occurrences and same-tick geometry changes',()=>{
    const {sim,unit}=fixture(),actor=unit('villager','red',102000,100000);unit('scout','blue',100000,100000);
    const internal=sim as unknown as ObservationInternals;internal.updateVision();sim.state.entities.alias_actor=actor;
    const check=()=>{const expected=structuredClone(sim.state);referenceObservedActions(expected,internal.committedActions,(playerId,entity)=>internal.visible(playerId,entity));internal.observeActions();expect(sim.state.vision).toEqual(expected.vision);};
    internal.committedActions.set(actor.id,{kind:'mine',facingMilliRad:1571});check();
    actor.xMm=260000;actor.zMm=260000;check();actor.xMm=102000;actor.zMm=100000;actor.garrisonedIn='external';check();delete actor.garrisonedIn;check();
  });
});

describe('M7 committed recipient-observed visual actions',()=>{
  it('keeps indexed visibility aligned to the actor roster when resources are interleaved',()=>{
    const {sim,unit,building}=fixture();
    const resource:Extract<Entity,{kind:'resource'}>={id:'interleaved_resource',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:100000,zMm:100000,hp:1,maxHp:1,amount:100000};
    sim.state.entities[resource.id]=resource;unit('villager');building('wooden_gate','red');sim.state.entities.another_resource={...resource,id:'another_resource'};unit('scout','green');
    const actors=Object.values(sim.state.entities).filter(entity=>entity.kind!=='resource'),calls:number[]=[];
    updateObservedActions(sim.state,new Map(),(_player,entity,index)=>{expect(actors[index]).toBe(entity);calls.push(index);return false;});
    expect(new Set(calls)).toEqual(new Set(actors.map((_entity,index)=>index)));
  });
  it('matches legacy action and ghost memory across fresh geometry, masks, retained attacks and recipient restrictions',()=>{
    const {sim,unit,building}=fixture(),internal=sim as unknown as ObservationInternals;
    unit('scout','blue',90000,100000);const worker=unit('villager','red'),gate=building('wooden_gate','red',101000,100000),tower=building('watchtower','red',103000,100000);
    sim.state.entities.middle_resource={id:'middle_resource',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:102000,zMm:102000,hp:1,maxHp:1,amount:100000};const host=building('town_center','red',106000,100000),contained=unit('villager','red',106000,100000);contained.garrisonedIn=host.id;host.garrisoned=[contained.id];
    internal.updateVision();sim.state.tick=20;
    const check=(actions:[string,CommittedAction][]=[])=>{
      internal.committedActions=new Map(actions);const expected=structuredClone(sim.state);
      referenceObservedActions(expected,internal.committedActions,(playerId,entity)=>internal.visible(playerId,entity));internal.observeActions();
      expect(sim.state.vision).toEqual(expected.vision);expect(sim.state.entities).toEqual(expected.entities);
    };
    check([[worker.id,{kind:'gather_wood',facingMilliRad:1571}],[gate.id,{kind:'attack',durationTicks:5,facingMilliRad:0,recipients:['red','blue']}],[tower.id,{kind:'attack',durationTicks:5,facingMilliRad:-1571,recipients:['red']}]]);
    expect(visible(sim,gate.id).visualAction).toEqual({kind:'attack',startedTick:20,durationTicks:5,facingMilliRad:0});expect(visible(sim,tower.id).visualAction?.kind).toBe('idle');expect(sim.state.vision.blue!.actions[contained.id]).toBeUndefined();
    sim.state.tick++;worker.cargo={resource:'gold',amount:4000};check();expect(visible(sim,worker.id).visualAction).toEqual({kind:'carry',startedTick:21});expect(visible(sim,gate.id).visualAction?.startedTick).toBe(20);
    sim.state.tick++;check([[worker.id,{kind:'mine',facingMilliRad:0}]]);const remembered=structuredClone(sim.state.vision.blue!.memory[gate.id]);
    // Same-tick edits must not reuse the prior action phase's packed geometry.
    gate.rotation=90;gate.xMm=200000;gate.zMm=200000;worker.xMm=200000;worker.zMm=200000;check([[gate.id,{kind:'attack',durationTicks:5,facingMilliRad:3142,recipients:['red']}],[worker.id,{kind:'build',facingMilliRad:3142}]]);
    expect(sim.state.vision.blue!.actions[gate.id]).toBeUndefined();expect(sim.state.vision.blue!.memory[gate.id]).toEqual(remembered);expect(sim.state.vision.blue!.actions[worker.id]).toBeUndefined();
    gate.xMm=101000;gate.zMm=100000;worker.xMm=100000;worker.zMm=100000;check();expect(visible(sim,gate.id).visualAction).toEqual({kind:'idle',startedTick:22});expect(visible(sim,worker.id).visualAction).toEqual({kind:'carry',startedTick:22});
    const added=building('house','red',105000,100000);delete sim.state.entities[tower.id];delete contained.garrisonedIn;contained.xMm=100000;check();expect(sim.state.vision.blue!.actions[added.id]).toBeDefined();expect(sim.state.vision.blue!.actions[tower.id]).toBeUndefined();expect(sim.state.vision.blue!.actions[contained.id]).toBeDefined();
    sim.state.tick=30;internal.updateVision();check();expect(sim.state.vision.blue!.actions[gate.id]?.kind).toBe('idle');
  });
  it('matches the legacy reducer after real combat death, garrison ejection and post-death fog refresh',()=>{
    const create=()=>{
      const rig=fixture(),town=rig.building('town_center','red',100000,100000),occupant=rig.unit('villager','red',100000,100000),ram=rig.unit('battering_ram','blue',93000,100000),observer=rig.unit('scout','blue',150000,150000),enemy=rig.unit('militia','red',151500,150000);
      town.hp=1;town.cooldown=1000;occupant.garrisonedIn=town.id;town.garrisoned=[occupant.id];observer.hp=1;observer.cooldown=1000;enemy.stance='stand_ground';return {...rig,town,occupant,ram,observer};
    };
    const actual=create(),old=create(),reference=old.sim as unknown as ObservationInternals;
    reference.observeActions=()=>referenceObservedActions(old.sim.state,reference.committedActions,(playerId,entity)=>reference.visible(playerId,entity));
    for(let tick=0;tick<4;tick++){actual.sim.step();old.sim.step();expect(actual.sim.state).toEqual(old.sim.state);for(const owner of ['blue','red','green'])expect(actual.sim.view(owner)).toEqual(old.sim.view(owner));}
    expect(actual.sim.state.entities[actual.town.id]).toBeUndefined();expect(actual.occupant.garrisonedIn).toBeUndefined();expect(actual.sim.state.entities[actual.observer.id]).toBeUndefined();expect(actual.sim.state.effects.some(effect=>effect.kind==='death'&&effect.entityId===actual.town.id)).toBe(true);
  });

  it('starts moving only after actual displacement and leaves a blocked order idle',()=>{
    const {sim,unit,building}=fixture(),walker=unit('villager');sim.step();expect(visible(sim,walker.id).visualAction?.kind).toBe('idle');
    expect(sim.committedUnitActions()).toEqual([]);
    expect(send(sim,'blue',{kind:'move',unitIds:[walker.id],target:{xMm:105000,zMm:100000},queued:false}).status).toBe('accepted');expect(visible(sim,walker.id).visualAction?.kind).toBe('idle');for(let i=0;i<40&&walker.xMm===100000;i++){sim.step();expect(visible(sim,walker.id).visualAction?.kind).toBe(walker.xMm===100000?'idle':'move');}expect(walker.xMm).toBeGreaterThan(100000);expect(visible(sim,walker.id).visualAction).toEqual({kind:'move',startedTick:sim.state.tick});
    const committed=sim.committedUnitActions();expect(committed).toEqual([{id:walker.id,playerId:'blue',kind:'move'}]);committed[0]!.kind='attack';expect(sim.committedUnitActions()[0]!.kind).toBe('move');
    send(sim,'blue',{kind:'stop',unitIds:[walker.id]});sim.step();expect(visible(sim,walker.id).visualAction?.kind).toBe('idle');expect(sim.committedUnitActions()).toEqual([]);
    const sealed=unit('villager','blue',150000,150000);for(let offset=-4000;offset<=4000;offset+=2000){building('palisade_wall','blue',150000+offset,146000);building('palisade_wall','blue',150000+offset,154000);if(Math.abs(offset)<4000){building('palisade_wall','blue',146000,150000+offset);building('palisade_wall','blue',154000,150000+offset);}}sim.step();
    expect(send(sim,'blue',{kind:'move',unitIds:[sealed.id],target:{xMm:165000,zMm:150000},queued:false}).status).toBe('accepted');sim.step(25);expect({x:sealed.xMm,z:sealed.zMm}).toEqual({x:150000,z:150000});expect(visible(sim,sealed.id).visualAction?.kind).toBe('idle');expect(sim.committedUnitActions()).toEqual([]);
  });
  it.each([['food','gather_food'],['wood','gather_wood'],['gold','mine'],['stone','mine']] as const)('shows committed %s work without enemy cargo or target details',(resource,kind)=>{
    const {sim,unit}=fixture(),worker=unit('villager','red'),observer=unit('scout','blue',90000,100000);observer.cooldown=10000;const node={id:'visible_resource',kind:'resource' as const,typeId:resource==='food'?'forage_patch':resource==='wood'?'tree':`${resource}_deposit`,ownerId:null,xMm:101500,zMm:100000,hp:1,maxHp:1,resource:resource as ResourceType,amount:1000000};sim.state.entities[node.id]=node;sim.state.navigationRevision++;sim.step();
    expect(send(sim,'red',{kind:'gather',unitIds:[worker.id],targetId:node.id,queued:false}).status).toBe('accepted');expect(visible(sim,worker.id).visualAction?.kind).toBe('idle');sim.step();expect(worker.cargo.amount).toBeGreaterThan(0);expect(visible(sim,worker.id).visualAction).toEqual({kind,startedTick:2,facingMilliRad:1571});expect(visible(sim,worker.id)).not.toHaveProperty('cargo');expect(visible(sim,worker.id)).not.toHaveProperty('order');
    send(sim,'red',{kind:'stop',unitIds:[worker.id]});sim.step();expect(visible(sim,worker.id).visualAction?.kind).toBe('carry');expect(visible(sim,worker.id).visualAction).not.toHaveProperty('resource');
    expect(sim.committedUnitActions()).toEqual([]);
  });
  it('shows actual foundation work and funded repair rather than work intent',()=>{
    const {sim,unit,building}=fixture(),worker=unit('villager'),house=building('house','blue',104000,100000);unit('scout','blue',92000,100000);sim.step();
    expect(send(sim,'blue',{kind:'build',buildingType:'house',builderIds:[worker.id],originCell:{x:47,z:49},rotation:0,queued:false}).status).toBe('accepted');expect(visible(sim,worker.id).visualAction?.kind).toBe('idle');
    let built=false;for(let i=0;i<150;i++){sim.step();if(visible(sim,worker.id).visualAction?.kind==='build'){built=true;break;}}expect(built).toBe(true);expect(visible(sim,worker.id).visualAction?.facingMilliRad).toBe(-1571);send(sim,'blue',{kind:'stop',unitIds:[worker.id]});worker.xMm=100900;worker.zMm=100000;house.hp-=20;sim.state.economies.blue!.resources.wood=0;sim.step();
    expect(send(sim,'blue',{kind:'repair',unitIds:[worker.id],targetId:house.id,queued:false}).status).toBe('accepted');sim.step(2);expect(visible(sim,worker.id).visualAction?.kind).toBe('idle');expect(visible(sim,worker.id).visualAction).not.toHaveProperty('facingMilliRad');expect(worker.blockedReason).toBe('INSUFFICIENT_RESOURCES');sim.state.economies.blue!.resources.wood=100000;sim.step();expect(visible(sim,worker.id).visualAction?.kind).toBe('repair');expect(visible(sim,worker.id).visualAction?.facingMilliRad).toBe(1571);
  });
  it('emits legal attack, visible hit and newly observed death appearances at the occurrence tick',()=>{
    const {sim,unit}=fixture(),attacker=unit('militia'),victim=unit('villager','red',101500);victim.hp=1;victim.cooldown=10000;sim.step();expect(visible(sim,attacker.id).visualAction).toEqual({kind:'attack',startedTick:1,durationTicks:Math.ceil(units.militia.attackCooldownSeconds*20),facingMilliRad:1571});expect(sim.state.entities[victim.id]).toBeUndefined();
    expect(sim.view('blue').effects?.filter(effect=>effect.entityId===victim.id)).toEqual([expect.objectContaining({kind:'hit',tick:1,entityId:victim.id,typeId:'villager',ownerId:'red',visualAge:1,visualTier:'base'}),expect.objectContaining({kind:'death',tick:1,entityId:victim.id,typeId:'villager',ownerId:'red',visualAge:1,visualTier:'base'})]);expect(sim.view('green').effects).toEqual([]);
    expect(sim.committedUnitActions()).toContainEqual({id:attacker.id,playerId:'blue',kind:'attack'});sim.step();expect(visible(sim,attacker.id).visualAction?.startedTick).toBe(1);expect(validatePlayerView(sim.view('blue'))).toBe(true);expect(sim.committedUnitActions()).toEqual([]);
  });
  it('updates actual stationary work bearing without restarting the observed work clock or revealing a queued target',()=>{
    const {sim,unit}=fixture(),worker=unit('villager','red'),observer=unit('scout','blue',90000,100000);observer.cooldown=10000;
    const nodes=[{id:'east_gold',xMm:101500,zMm:100000},{id:'north_gold',xMm:100000,zMm:101500}].map(point=>({...point,kind:'resource' as const,typeId:'gold_deposit',ownerId:null,hp:1,maxHp:1,resource:'gold' as const,amount:1000000}));
    for(const node of nodes)sim.state.entities[node.id]=node;sim.state.navigationRevision++;sim.step();
    send(sim,'red',{kind:'gather',unitIds:[worker.id],targetId:nodes[0]!.id,queued:false});sim.step();const first=visible(sim,worker.id).visualAction!;expect(first).toEqual({kind:'mine',startedTick:2,facingMilliRad:1571});
    send(sim,'red',{kind:'gather',unitIds:[worker.id],targetId:nodes[1]!.id,queued:false});expect(visible(sim,worker.id).visualAction).toEqual(first);
    sim.step();expect(visible(sim,worker.id).visualAction).toEqual({...first,facingMilliRad:0});expect({x:worker.xMm,z:worker.zMm}).toEqual({x:100000,z:100000});
    send(sim,'red',{kind:'stop',unitIds:[worker.id]});sim.step();expect(visible(sim,worker.id).visualAction).toEqual({kind:'carry',startedTick:4});
  });
  it('changes stationary attack bearing only when the next legal strike commits',()=>{
    const {sim,unit}=fixture(),attacker=unit('militia'),east=unit('knight','red',101500,100000),north=unit('knight','red',100000,101500);east.cooldown=north.cooldown=10000;
    sim.step();const first=visible(sim,attacker.id).visualAction!;expect(first.facingMilliRad).toBe(1571);
    expect(send(sim,'blue',{kind:'attack_target',unitIds:[attacker.id],targetId:north.id,queued:false}).status).toBe('accepted');expect(visible(sim,attacker.id).visualAction).toEqual(first);
    sim.step();expect(visible(sim,attacker.id).visualAction).toEqual(first);
    for(let tick=0;tick<40&&visible(sim,attacker.id).visualAction?.startedTick===first.startedTick;tick++)sim.step();
    expect(visible(sim,attacker.id).visualAction).toEqual({kind:'attack',startedTick:sim.state.tick,durationTicks:first.durationTicks,facingMilliRad:0});expect(north.hp).toBeLessThan(north.maxHp);
  });
  it('does not reveal hidden attack history when a unit enters vision or becomes visible again',()=>{
    const create=(attacks:boolean)=>{const rig=fixture(),observer=rig.unit('scout','blue',40000,40000),actor=rig.unit('militia','red',200000,180000),victim=rig.unit('knight','green',201500,180000);victim.cooldown=10000;if(!attacks)actor.cooldown=10000;rig.sim.step(3);victim.xMm=280000;observer.xMm=188000;observer.zMm=180000;rig.sim.step();return {...rig,observer,actor};};
    const a=create(true),b=create(false);expect(visible(a.sim,a.actor.id).visualAction).toEqual({kind:'idle',startedTick:4});expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));
    a.observer.xMm=b.observer.xMm=40000;a.observer.zMm=b.observer.zMm=40000;a.sim.step();b.sim.step();expect(a.sim.state.vision.blue!.actions[a.actor.id]).toBeUndefined();a.sim.step(2);b.sim.step(2);a.observer.xMm=b.observer.xMm=188000;a.observer.zMm=b.observer.zMm=180000;a.sim.step();b.sim.step();expect(visible(a.sim,a.actor.id).visualAction).toEqual({kind:'idle',startedTick:8});expect(a.sim.view('blue')).toEqual(b.sim.view('blue'));
  });
  it('does not disclose a contained enemy victim through an already launched arrow hit',()=>{
    const {sim,unit,building}=fixture(),archer=unit('archer','blue',95000,100000),victim=unit('villager','red',101000,100000),town=building('town_center','red',108000,100000);sim.step();const shot=sim.state.projectiles.find(projectile=>projectile.kind==='arrow'&&projectile.sourceId===archer.id)!;expect(shot).toBeDefined();
    expect(send(sim,'red',{kind:'garrison',unitIds:[victim.id],targetId:town.id,queued:false}).status).toBe('accepted');sim.step();expect(victim.garrisonedIn).toBe(town.id);sim.step(shot.hitTick-sim.state.tick);expect(sim.view('blue').effects?.some(effect=>effect.entityId===victim.id)).toBe(false);expect(sim.view('blue').entities.some(entity=>entity.id===victim.id)).toBe(false);expect(sim.view('red').effects?.some(effect=>effect.entityId===victim.id&&effect.kind==='hit')).toBe(true);
  });
  it.each([['archer','arrow'],['catapult','stone']] as const)('identifies a real %s impact without exposing launch or target metadata',(typeId,projectileKind)=>{
    const {sim,unit}=fixture(),attacker=unit(typeId),victim=unit('knight','red',105500);victim.cooldown=10000;sim.step();
    const shot=sim.state.projectiles.find(projectile=>projectile.sourceId===attacker.id)!;expect(shot.kind).toBe(projectileKind);sim.step(shot.hitTick-sim.state.tick);
    const view=sim.view('blue'),impact=view.effects!.find(effect=>effect.kind==='impact')!;
    expect(impact).toEqual({id:expect.any(String),tick:shot.hitTick,kind:'impact',projectileKind,...(projectileKind==='stone'?{typeId}:{}),xMm:victim.xMm,zMm:victim.zMm});expect(victim.hp).toBeLessThan(victim.maxHp);expect(sim.view('green').effects).toEqual([]);expect(validatePlayerView(view)).toBe(true);
    const missing=structuredClone(view);delete missing.effects!.find(effect=>effect.kind==='impact')!.projectileKind;expect(validatePlayerView(missing)).toBe(false);
    const wrongKind=structuredClone(view);wrongKind.effects!.find(effect=>effect.kind==='hit')!.projectileKind=projectileKind;expect(validatePlayerView(wrongKind)).toBe(false);
    const payload=sim.capture();expect(validateSimulationSavePayload(payload)).toBe(true);delete payload.state.effects.find(effect=>effect.kind==='impact')!.projectileKind;expect(validateSimulationSavePayload(payload)).toBe(false);
  });
  it('strictly decodes observed poses and complete victim appearances without private action fields',()=>{
    const {sim,unit}=fixture(),attacker=unit('militia'),victim=unit('villager','red',101500);victim.cooldown=10000;sim.step();const view=sim.view('blue');expect(validatePlayerView(view)).toBe(true);
    for(const action of [{kind:'attack',startedTick:1,durationTicks:0},{kind:'gather_wood',startedTick:1,targetId:'hidden'},{kind:'move',startedTick:1,durationTicks:4},{kind:'secret_order',startedTick:1},...['idle','move','carry'].map(kind=>({kind,startedTick:1,facingMilliRad:0})),...[3143,-3143,.5].map(facingMilliRad=>({kind:'build',startedTick:1,facingMilliRad}))]){const broken=structuredClone(view);broken.entities.find(entity=>entity.id===attacker.id)!.visualAction=action as never;expect(validatePlayerView(broken)).toBe(false);}
    const incomplete=structuredClone(view),hit=incomplete.effects!.find(effect=>effect.kind==='hit')!;delete hit.entityId;expect(validatePlayerView(incomplete)).toBe(false);const impact=structuredClone(view);impact.effects![0]!.kind='impact';expect(validatePlayerView(impact)).toBe(false);
  });
  it('freezes the action and age of an unobserved building ghost',()=>{
    const {sim,unit,building}=fixture(),tower=building('watchtower','red',100000,100000),observer=unit('scout','blue',106000,100000);observer.cooldown=10000;sim.step();const observed=visible(sim,tower.id);expect(observed.visualAction?.kind).toBe('attack');observer.xMm=140000;sim.step();sim.state.economies.red!.age=2;sim.step(50);const ghost=visible(sim,tower.id);expect(ghost.ghost).toBe(true);expect(ghost.visualAction).toEqual(observed.visualAction);expect(ghost.visualAge).toBe(1);expect(ghost.lastSeenTick).toBe(1);
  });
  it('restores action timing exactly and replays committed work without model calls',()=>{
    const {sim,unit}=fixture(),attacker=unit('militia'),victim=unit('knight','red',101500);victim.cooldown=10000;sim.step();const initial=exportSimulationSave(sim,identity);sim.drainJournal();const copy=restoreSimulation(initial,identity,{preserveEpoch:true});expect(copy.capture()).toEqual(sim.capture());
    for(let i=0;i<35;i++){sim.step();copy.step();expect(copy.view('blue')).toEqual(sim.view('blue'));}expect(copy.capture()).toEqual(sim.capture());const saved=sim.capture();saved.state.vision.blue!.actions[attacker.id]!.startedTick=sim.state.tick+1;expect(validateSimulationSavePayload(saved)).toBe(false);const badFacing=sim.capture();badFacing.state.vision.blue!.actions[attacker.id]!.facingMilliRad=3143;expect(validateSimulationSavePayload(badFacing)).toBe(false);
    const recording=createReplayRecording(initial,sim.journalEvents(),[replayCheckpoint(sim)],sim.state.tick,sim.state.eventOrdinal),network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('NO_INFERENCE'));try{const replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(sim.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(sim.capture());expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
    sim.setStatus('PAUSED');const frozen=sim.view('blue');sim.step(100);expect(sim.view('blue')).toEqual(frozen);
  });
});
