import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, terrainLineOfSight, terrainVisionBlockers, units, type BuildingId, type Position, type PublicPlayer, type ViewEntity } from '@frontier/shared';
import { createSimulation, createLiveSimulation, exportReplay, replayCheckpoint, ReplayRunner, exportSimulationSave, restoreSimulation, Simulation, type Building, type Entity, type Unit, type EngineIdentity } from '../src/index.js';
import type { PerceptionMembership } from '../src/perception-membership.js';
import { immutableVisionGroup, immutableVisionSource, VisionMaskKernel, type VisionMaskFrame, type VisionMaskResult, type VisionMaskGroup } from '../src/vision-mask-kernel.js';
import { updateObservedActions, type CommittedAction } from '../src/observed-actions.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';

const factions:PublicPlayer[]=[
  {id:'blue',name:'Blue',teamId:'allies',color:'#3388ff',kind:'human'},
  {id:'green',name:'Green',teamId:'allies',color:'#338844',kind:'human'},
  {id:'red',name:'Red',teamId:'enemy',color:'#ee5533',kind:'human'},
];
const fixture=(sharedVision:boolean)=>createSimulation({matchId:'fog-cache',seed:'fog-cache-31',secretIdKey:'fog-test-key',factions,controllers:false,sharedVision});
const refresh=(sim:Simulation)=>(sim as unknown as {updateVision():void}).updateVision();
const cache=(sim:Simulation)=>new Map([...(sim as unknown as {visionKernel:{stamps:Map<string,Map<string,unknown>>}}).visionKernel.stamps.values()].flatMap(group=>[...group]));
/** Deliberately retains the original set-based per-faction algorithm as an oracle. */
function referenceFog(sim:Simulation,playerId:string):number[]{
  const grid=balance.rules.fogGridM*1000,width=Math.floor(sim.state.widthMm/grid),height=Math.floor(sim.state.heightMm/grid),seen=new Set<number>();
  const faction=sim.state.factions.find(player=>player.id===playerId)!,blockers=terrainVisionBlockers(sim.state.map.terrain);
  for(const entity of Object.values(sim.state.entities)){
    if(entity.kind==='resource')continue;
    const owner=sim.state.factions.find(player=>player.id===entity.ownerId)!;
    if(entity.ownerId!==playerId&&(!(sim.options.sharedVision??true)||owner.teamId!==faction.teamId))continue;
    const radius=(entity.kind==='unit'?units[entity.typeId].visionM:buildings[entity.typeId].visionM)*1000;
    const nearby=blockers.filter(blocker=>Math.abs(blocker.xMm-entity.xMm)<=blocker.halfWidth+radius&&Math.abs(blocker.zMm-entity.zMm)<=blocker.halfHeight+radius);
    for(let z=Math.max(0,Math.floor((entity.zMm-radius)/grid));z<Math.min(height,Math.ceil((entity.zMm+radius)/grid));z++)for(let x=Math.max(0,Math.floor((entity.xMm-radius)/grid));x<Math.min(width,Math.ceil((entity.xMm+radius)/grid));x++){
      const point={xMm:(x+.5)*grid,zMm:(z+.5)*grid};
      if(Math.hypot(point.xMm-entity.xMm,point.zMm-entity.zMm)<=radius&&(!nearby.length||terrainLineOfSight(nearby,entity,point)))seen.add(z*width+x);
    }
  }
  return [...seen].sort((a,b)=>a-b);
}
const alive=(sim:Simulation)=>Object.values(sim.state.entities).filter((entity):entity is Exclude<Entity,{kind:'resource'}>=>entity.kind!=='resource');
interface VisionCommitInternals {
  prepareVision():VisionMaskFrame;commitVision(results:VisionMaskResult[]):void;visionGroup(playerId:string):string;
  visionKernel:VisionMaskKernel;visibilityMasks:Map<string,Uint8Array>;visible(playerId:string,point:Position):boolean;
  asView(entity:Entity,own:boolean,playerId:string):ViewEntity;observeActions():void;committedActions:Map<string,CommittedAction>;
}
const retainedRefresh=(sim:Simulation)=>{const internal=sim as unknown as VisionCommitInternals;internal.commitVision(internal.visionKernel.computeRetained(internal.prepareVision()));};
/** Original bitmap union also specifies the public-fixture behavior of invalid
 * indices: typed-array writes ignore out-of-range and noninteger entries. */
function referenceExplored(prior:readonly number[],mask:Uint8Array):number[]{
  const explored=new Uint8Array(mask.length),result:number[]=[];
  for(const cell of prior)explored[cell]=1;
  for(let cell=0;cell<mask.length;cell++)if(explored[cell]||mask[cell])result.push(cell);
  return result;
}
/** Independent pre-cache commit/action algorithm for complete cold continuation. */
function scalarVisionCommit(sim:Simulation):void{
  const internal=sim as unknown as VisionCommitInternals;
  internal.commitVision=results=>{
    const groups=new Map(results.map(result=>[result.key,result]));
    for(const faction of sim.state.factions)internal.visibilityMasks.set(faction.id,groups.get(internal.visionGroup(faction.id))!.mask);
    for(const faction of sim.state.factions){
      const result=groups.get(internal.visionGroup(faction.id))!,vision=sim.state.vision[faction.id]!;
      vision.explored=referenceExplored(vision.explored,result.mask);vision.visible=[...result.visible];
      for(const id of Object.keys(vision.memory))if(!sim.state.entities[id]&&internal.visible(faction.id,vision.memory[id]!))delete vision.memory[id];
      for(const entity of Object.values(sim.state.entities))if(entity.kind!=='unit'&&entity.ownerId!==faction.id&&internal.visible(faction.id,entity)){
        const memory=internal.asView(entity,false,faction.id);memory.lastSeenTick=sim.state.tick;vision.memory[entity.id]=memory;
      }
    }
  };
  internal.observeActions=()=>updateObservedActions(sim.state,internal.committedActions,(playerId,entity)=>internal.visible(playerId,entity),Object.values(sim.state.entities));
}
interface VisibilityInternals {
  visibilityMasks:Map<string,Uint8Array>;
  visible(playerId:string,point:Position):boolean;
  knownStatic(playerId:string):Entity[];
  advanceMovement():void;
  asView(entity:Entity,own:boolean,playerId:string):ViewEntity;
  movementFrame:unknown;
}
interface WorkVisibilityInternals extends VisibilityInternals {
  advanceWork():void;
  gather(unit:Unit,order:Unit['orders'][number]):void;
  dropoffs(unit:Unit):Building[];
  workFrame:{knowledge?:{knownBuildings?:Map<string,Building[]>;staticIndexed?:boolean;staticFootprints?:unknown}}|undefined;
  invalidateEntityRoster():void;
  addBuilding(ownerId:string,typeId:BuildingId,position:Position,rotation:Building['rotation'],completed:boolean):Building;
}
/** Original membership algorithm, independent of the transient packed geometry. */
function referenceKnownStatic(sim:Simulation,playerId:string):Entity[]{
  const internal=sim as unknown as VisibilityInternals,current=Object.values(sim.state.entities).filter(entity=>entity.kind!=='unit'&&(entity.ownerId===playerId||internal.visible(playerId,entity))),ids=new Set(current.map(entity=>entity.id));
  for(const memory of Object.values(sim.state.vision[playerId]!.memory))if(!ids.has(memory.id)&&!internal.visible(playerId,memory))current.push(memory as Entity);
  return current;
}
function referenceDropoffs(sim:Simulation,unit:Unit):Building[]{
  const team=sim.state.factions.find(faction=>faction.id===unit.ownerId)!.teamId;
  return referenceKnownStatic(sim,unit.ownerId).filter((entity):entity is Building=>entity.kind==='building'&&('progress'in entity?entity.progress===1:entity.work>=entity.required)&&sim.state.factions.find(faction=>faction.id===entity.ownerId)!.teamId===team&&!sim.state.economies[entity.ownerId]!.defeated&&buildings[entity.typeId].dropOffResources.includes(unit.cargo.resource!)).sort((a,b)=>Math.hypot(a.xMm-unit.xMm,a.zMm-unit.zMm)-Math.hypot(b.xMm-unit.xMm,b.zMm-unit.zMm));
}
function checkMovementKnowledge(sim:Simulation):void {
  const internal=sim as unknown as VisibilityInternals,original=internal.knownStatic,called=new Set<string>();
  internal.knownStatic=function(playerId){const actual=original.call(sim,playerId);expect(actual).toEqual(referenceKnownStatic(sim,playerId));called.add(playerId);return actual;};
  try{internal.advanceMovement();}finally{internal.knownStatic=original;}
  expect(called).toEqual(new Set(factions.map(faction=>faction.id)));expect(internal.movementFrame).toBeUndefined();
}

describe('native resource observation scheduling',()=>{
  type Node=Extract<Entity,{kind:'resource'}>;
  interface Internals extends VisionCommitInternals {liveOwned:boolean;beginFrame():void;endFrame():void;checkLiveOwnership():void;frameChangedResources:Set<Node>;frameResourceObservations:Map<string,unknown>}
  function pair(){
    const actual=fixture(true),options={...actual.options,authoritativeIntervalMs:300 as const},payload=actual.capture(),expected=new Simulation(options,payload);
    scalarVisionCommit(expected);const internal=actual as unknown as Internals;internal.liveOwned=true;
    internal.beginFrame();(expected as unknown as Internals).beginFrame();
    const node=Object.values(actual.state.entities).find((e):e is Node=>e.kind==='resource')!,count=Math.floor(actual.state.widthMm/2000)*Math.floor(actual.state.heightMm/2000);
    const commit=(tick:number,seen=true)=>{for(const sim of [actual,expected]){sim.state.tick=tick;const i=sim as unknown as Internals,keys=[...new Set(sim.state.factions.map(f=>i.visionGroup(f.id)))];i.commitVision(keys.map(key=>{const mask=new Uint8Array(count).fill(seen?1:0);return {key,mask,visible:seen?Array.from({length:count},(_,n)=>n):[]};}));}};
    return {actual,expected,internal,node,commit};
  }
  it('retains prior completed payload/tick on concealment, including a repeated same-tick observation',()=>{
    const {actual,expected,internal,node,commit}=pair();commit(10);commit(11);commit(12);
    expect(actual.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(10);
    // Gathering precedes current visibility. A newly hidden mutation must not
    // become an observed amount, even though its dirty notification is present.
    for(const sim of [actual,expected])(sim.state.entities[node.id] as Node).amount=0;internal.frameChangedResources.add(node);commit(13,false);
    expect(actual.state.vision.blue!.memory[node.id]).toEqual(expected.state.vision.blue!.memory[node.id]);expect(actual.state.vision.blue!.memory[node.id]!.amount).toBeGreaterThan(0);expect(actual.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(12);
    commit(13,true);expect(actual.state.vision.blue!.memory[node.id]).toMatchObject({amount:0,lastSeenTick:13});commit(13,false);
    expect(actual.state.vision.blue!.memory[node.id]).toMatchObject({amount:0,lastSeenTick:13});
    internal.endFrame();(expected as unknown as Internals).endFrame();expect(actual.state.vision).toEqual(expected.state.vision);
    expect(actual.state.vision.blue!.memory[node.id]).not.toBe(actual.state.vision.green!.memory[node.id]);
  });
  it('updates changed visible payloads and clears accepted resource actions without touching hidden payloads',()=>{
    const {actual,expected,internal,node,commit}=pair();
    for(const sim of [actual,expected])sim.state.vision.blue!.actions[node.id]={kind:'idle',startedTick:0,durationTicks:1};commit(10);
    expect(actual.state.vision.blue!.memory[node.id]!.visualAction).toBeDefined();
    for(const sim of [actual,expected])delete sim.state.vision.blue!.actions[node.id];commit(11);expect(actual.state.vision.blue!.memory[node.id]!.visualAction).toBeUndefined();
    for(const sim of [actual,expected])(sim.state.entities[node.id] as Node).amount=42000;internal.frameChangedResources.add(node);commit(12);expect(actual.state.vision.blue!.memory[node.id]).toMatchObject({amount:42,lastSeenTick:12});
    commit(13);internal.endFrame();(expected as unknown as Internals).endFrame();expect(actual.state.vision).toEqual(expected.state.vision);
  });
  it('cold-loads a schema-valid resource action and removes it on the same contact as the scalar observer',async()=>{
    const source=fixture(true),options={...source.options,authoritativeIntervalMs:300 as const},payload=source.capture();payload.options.authoritativeIntervalMs=300;
    const node=source.view('blue').entities.find(e=>e.kind==='resource')!,action={kind:'idle' as const,startedTick:payload.state.tick};payload.state.vision.blue!.actions[node.id]=action;payload.state.vision.blue!.memory[node.id]!.visualAction={...action};
    expect(validateSimulationSavePayload(payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const native=createLiveSimulation(options,payload),scalar=new Simulation(options,payload);scalarVisionCommit(scalar);const before=Simulation.resourceObservationDiagnostics();
    native.advanceFrame();scalar.advanceFrame();await native.synchronizeCapture();await scalar.synchronizeCapture();expect(native.capture()).toEqual(scalar.capture());expect(native.state.vision.blue!.memory[node.id]!.visualAction).toBeUndefined();expect(Simulation.resourceObservationDiagnostics().deferred).toBeGreaterThan(before.deferred);
  });
  it.each(['serialize','capture','revoke'] as const)('materializes completed observations before %s using captured canonical flush operations',boundary=>{
    const {actual,expected,internal,node,commit}=pair();commit(10);commit(11);commit(12);expect(actual.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(10);
    if(boundary==='serialize')expect(actual.serializeState().vision.blue!.memory[node.id]!.lastSeenTick).toBe(12);
    else if(boundary==='capture')expect(actual.capture().state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(12);
    else if(boundary==='revoke'){
      const prototype=Simulation.prototype as unknown as {flushResourceObservations():void},original=prototype.flushResourceObservations;let calls=0;prototype.flushResourceObservations=()=>{calls++;throw new Error('UNTRUSTED_FLUSH');};
      try{internal.checkLiveOwnership();expect(calls).toBe(0);expect(internal.liveOwned).toBe(false);}finally{prototype.flushResourceObservations=original;}
    }
    expect(actual.state.vision).toEqual(expected.state.vision);expect(internal.frameResourceObservations.size).toBe(boundary==='revoke'?0:factions.length);
    internal.endFrame();(expected as unknown as Internals).endFrame();
  });
  it('retains resource cursors across frame and capture boundaries without replaying unchanged observations',()=>{
    const {actual,expected,internal,node,commit}=pair(),other=expected as unknown as Internals;
    // Exhausted nodes still belong to recipient history, but do not need a new
    // payload comparison merely because another authoritative frame began.
    for(const sim of [actual,expected])(sim.state.entities[node.id] as Node).amount=0;
    commit(10);commit(11);internal.endFrame();other.endFrame();
    const counts=Simulation.resourceObservationDiagnostics(),rosters=new Map(internal.frameResourceObservations);
    expect(actual.state.vision).toEqual(expected.state.vision);
    actual.capture();actual.serializeState();
    expect(Simulation.resourceObservationDiagnostics()).toEqual(counts);
    for(const [id,cursor]of rosters)expect(internal.frameResourceObservations.get(id)).toBe(cursor);
    internal.beginFrame();other.beginFrame();commit(12);commit(13);
    expect(Simulation.resourceObservationDiagnostics().refreshed).toBe(counts.refreshed);
    internal.endFrame();other.endFrame();
    expect(actual.state.vision).toEqual(expected.state.vision);expect(actual.state.vision.blue!.memory[node.id]).toMatchObject({amount:0,lastSeenTick:13});
    // A concealment in the next frame must retain the last completed contact,
    // even when capture has already materialized that observation.
    actual.capture();internal.beginFrame();other.beginFrame();commit(14);commit(15,false);
    expect(actual.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(14);
    internal.endFrame();other.endFrame();expect(actual.state.vision).toEqual(expected.state.vision);
  });
  it('retains pending resource action refreshes through frame and save boundaries',()=>{
    const {actual,expected,internal,node,commit}=pair(),other=expected as unknown as Internals;
    for(const sim of [actual,expected])sim.state.vision.blue!.actions[node.id]={kind:'idle',startedTick:10};
    commit(10);internal.endFrame();other.endFrame();actual.capture();actual.serializeState();
    expect(internal.frameChangedResources.has(node)).toBe(true);
    for(const sim of [actual,expected])delete sim.state.vision.blue!.actions[node.id];
    internal.beginFrame();other.beginFrame();commit(11);internal.endFrame();other.endFrame();
    expect(actual.state.vision.blue!.memory[node.id]!.visualAction).toBeUndefined();expect(actual.state.vision).toEqual(expected.state.vision);
  });
  it('resets retained resource cursors on epoch changes and scalar-step fallback',()=>{
    const {actual,expected,internal,node,commit}=pair(),other=expected as unknown as Internals;
    commit(10);internal.endFrame();other.endFrame();const counts=Simulation.resourceObservationDiagnostics();
    for(const sim of [actual,expected])sim.state.matchEpoch++;
    internal.beginFrame();other.beginFrame();commit(11);internal.endFrame();other.endFrame();
    expect(Simulation.resourceObservationDiagnostics().refreshed).toBeGreaterThan(counts.refreshed);
    // A non-frame vision commit uses the established eager observer and drops
    // any old deferred cursor before the next coarse frame can begin.
    commit(12);expect(internal.frameResourceObservations.size).toBe(0);
    expect(actual.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(12);expect(actual.state.vision).toEqual(expected.state.vision);
  });
  it('flushes a real native partial-frame victory and a later phase exception at the last completed observation',async()=>{
    const source=fixture(true),options={...source.options,authoritativeIntervalMs:300 as const},payload=source.capture();payload.options.authoritativeIntervalMs=300;
    const terminal=structuredClone(payload);for(const entity of Object.values(terminal.state.entities))if(entity.ownerId==='red')delete terminal.state.entities[entity.id];
    const native=createLiveSimulation(options,terminal),scalar=new Simulation(options,terminal),before=Simulation.resourceObservationDiagnostics();scalarVisionCommit(scalar);
    native.advanceFrame();scalar.advanceFrame();await native.synchronizeCapture();await scalar.synchronizeCapture();expect(native.state.status).toBe('FINISHED');expect(native.state.tick).toBe(terminal.state.tick+1);expect(native.capture()).toEqual(scalar.capture());expect(Simulation.resourceObservationDiagnostics().deferred).toBeGreaterThan(before.deferred);
    const failing=createLiveSimulation(options,payload),start=Simulation.resourceObservationDiagnostics().deferred,baseNow=performance.now.bind(performance);let thrown=false,completed=-1;
    const clock=vi.spyOn(performance,'now').mockImplementation(()=>{if(!thrown&&failing.state.tick===payload.state.tick+3&&Simulation.resourceObservationDiagnostics().deferred>start){thrown=true;completed=failing.state.tick;throw new Error('AFTER_COMPLETED_RESOURCE_OBSERVATION');}return baseNow();});
    try{expect(()=>failing.advanceFrame()).toThrow('AFTER_COMPLETED_RESOURCE_OBSERVATION');}finally{clock.mockRestore();}
    // The injected clock first runs at tick3 before vision. Determine the
    // completed phase from the materialized memory, not the partially begun tick.
    expect(thrown).toBe(true);expect(completed).toBe(payload.state.tick+3);const saved=failing.capture();
    for(const id of factions.map(f=>f.id))for(const entity of failing.view(id).entities)if(entity.kind==='resource'&&!entity.ghost)expect(saved.state.vision[id]!.memory[entity.id]!.lastSeenTick).toBe(payload.state.tick+2);
    expect(Simulation.resourceObservationDiagnostics().materialized).toBeGreaterThan(before.materialized);
  });
  it('conceals a real moving scout resource at the exact intermediate contact and keeps hidden memory unchanged',async()=>{
    const source=fixture(true),options={...source.options,authoritativeIntervalMs:300 as const},node=Object.values(source.state.entities).find((e):e is Node=>e.kind==='resource'&&e.resource==='wood')!,scout=alive(source).find((e):e is Unit=>e.kind==='unit'&&e.ownerId==='blue'&&e.typeId==='scout')!;
    for(const entity of Object.values(source.state.entities)){
      if(entity.kind==='resource'){if(entity!==node)delete source.state.entities[entity.id];continue;}
      entity.xMm=entity.ownerId==='red'?180000:20000;entity.zMm=20000;if(entity.kind==='unit'){entity.orders=[];entity.path=[];entity.autoGather=false;entity.stance='stand_ground';}
    }
    node.xMm=116000;node.zMm=100000;delete node.forest;scout.xMm=100000;scout.zMm=100000;scout.orders=[{kind:'move',target:{xMm:90000,zMm:100000},manualOrder:true}];scout.path=[{xMm:90000,zMm:100000}];scout.pathDestination={...scout.path[0]!};
    source.state.map.terrain=[];source.state.navigationRevision++;for(const vision of Object.values(source.state.vision)){vision.visible=[];vision.explored=[];vision.memory={};vision.actions={};}refresh(source);
    const payload=source.capture();payload.options.authoritativeIntervalMs=300;expect(payload.state.vision.blue!.memory[node.id]).toBeDefined();
    const native=createLiveSimulation(options,payload),scalar=new Simulation(options,payload);scalarVisionCommit(scalar);const before=Simulation.resourceObservationDiagnostics();
    native.advanceFrame();scalar.advanceFrame();await native.synchronizeCapture();await scalar.synchronizeCapture();expect(native.capture()).toEqual(scalar.capture());
    expect((native.state.entities[scout.id] as Unit).xMm).toBe(98200);expect(native.view('blue').entities.find(e=>e.id===node.id)?.ghost).toBe(true);expect(native.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(payload.state.tick+3);
    expect(Simulation.resourceObservationDiagnostics().deferred-before.deferred).toBeGreaterThan(Simulation.resourceObservationDiagnostics().refreshed-before.refreshed);
    const memory=JSON.parse(JSON.stringify(native.state.vision.blue!.memory[node.id]));native.advanceFrame();await native.synchronizeCapture();expect(native.state.vision.blue!.memory[node.id]).toEqual(memory);
  });
  it('reduces actual private-owner visits while preserving scalar, cold-save and journal replay state',async()=>{
    const source=fixture(true),options={...source.options,authoritativeIntervalMs:300 as const},worker=Object.values(source.state.entities).find((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'&&e.ownerId==='blue')!,node=Object.values(source.state.entities).find((e):e is Node=>e.kind==='resource'&&e.resource==='wood')!;
    node.xMm=worker.xMm+1000;node.zMm=worker.zMm;delete node.forest;node.amount=100000;source.state.navigationRevision++;refresh(source);
    const payload=source.capture();payload.options.authoritativeIntervalMs=300;
    expect(validateSimulationSavePayload(payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
    const native=createLiveSimulation(options,payload),expected=new Simulation(options,payload);scalarVisionCommit(expected);
    const before=Simulation.resourceObservationDiagnostics();native.advanceFrame();expected.advanceFrame();await native.synchronizeCapture();await expected.synchronizeCapture();
    const after=Simulation.resourceObservationDiagnostics(),observations=after.deferred-before.deferred,refreshes=after.refreshed-before.refreshed;
    expect(observations).toBeGreaterThan(0);expect(refreshes).toBeGreaterThan(0);expect(refreshes*3).toBeLessThan(observations);expect(after.materialized-before.materialized).toBeGreaterThan(0);
    expect(native.capture()).toEqual(expected.capture());expect(native.views(factions.map(f=>f.id))).toEqual(expected.views(factions.map(f=>f.id)));
    const saved=native.capture(),cold=createLiveSimulation(options,saved),identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},recording=exportReplay(native,identity,[replayCheckpoint(native)]),replay=new ReplayRunner(recording,identity);
    expect(replay.advanceTo(native.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(saved);
    const command={protocolVersion:2 as const,matchId:options.matchId,matchEpoch:saved.state.matchEpoch,clientCommandId:'resource-scheduled-gather',clientSequence:1,command:{kind:'gather' as const,unitIds:[worker.id],targetId:node.id,queued:false}};
    for(const simulation of [native,cold,expected])expect(simulation.command('blue',command).status).toBe('accepted');
    for(let frame=0;frame<3;frame++){for(const simulation of [native,cold,expected]){simulation.advanceFrame();await simulation.synchronizeCapture();}expect(cold.capture()).toEqual(native.capture());expect(expected.capture()).toEqual(native.capture());}
    expect((native.state.entities[node.id] as Node).amount).toBeLessThan((payload.state.entities[node.id] as Node).amount);
    const finalReplay=new ReplayRunner(exportReplay(native,identity,[replayCheckpoint(native)]),identity);expect(finalReplay.advanceTo(native.state.tick).done).toBe(true);expect(finalReplay.simulation.capture()).toEqual(native.capture());
  },60000);
});

describe('immutable native vision-source groups',()=>{
  function frame(groups:readonly VisionMaskGroup[]):VisionMaskFrame{return {width:17,height:13,gridMm:2000,cacheKey:'immutable-sources',blockerRevision:0,blockers:[],groups};}
  it('skips unchanged immutable source lookups while generic groups keep exact mutable behavior',()=>{
    const source=immutableVisionSource('source',12000,12000,9000),group=immutableVisionGroup('blue',[source]),input=frame([group]),kernel=new VisionMaskKernel(),first=kernel.computeRetained(input);
    const stamps=(kernel as unknown as {stamps:Map<string,Map<string,unknown>>}).stamps.get('blue')!,original=stamps.get;let reads=0;
    stamps.get=function(id:string){reads++;return original.call(this,id);};
    expect(kernel.computeRetained(input)).toEqual(first);expect(reads).toBe(0);
    const mutable=structuredClone(input);expect(kernel.computeRetained(mutable)).toEqual(first);expect(reads).toBe(1);
    mutable.groups[0]!.sources[0]!.xMm+=4000;const changed=kernel.computeRetained(mutable);expect(reads).toBe(2);expect(changed).toEqual(new VisionMaskKernel().computeRetained(mutable));expect(changed[0]!.visible).not.toEqual(first[0]!.visible);
    expect(kernel.computeRetained(input)).toEqual(first);expect(reads).toBe(3);kernel.computeRetained(input);expect(reads).toBe(3);
    expect(()=>Reflect.set(source,'xMm',99)).not.toThrow();expect(source.xMm).toBe(12000);expect(Object.isFrozen(group.sources)).toBe(true);
    expect(()=>immutableVisionGroup('fake',[{...source}])).toThrow('INVALID_IMMUTABLE_VISION_GROUP');expect(()=>immutableVisionGroup('duplicate',[source,source])).toThrow('INVALID_IMMUTABLE_VISION_GROUP');
  });
  it('never trusts caller-frozen accessor/proxy groups and rebuilds immutable sources on geometry revision',()=>{
    let pose=12000;const source=Object.freeze({id:'source',get xMm(){return pose;},zMm:12000,radius:9000}),group=Object.freeze({key:'blue',sources:Object.freeze([source])}),input=frame([group]),kernel=new VisionMaskKernel(),before=kernel.computeRetained(input);
    pose+=4000;expect(kernel.computeRetained(input)).toEqual(new VisionMaskKernel().computeRetained(input));expect(kernel.computeRetained(input)[0]!.visible).not.toEqual(before[0]!.visible);
    const proxy=new Proxy(group,{});pose+=1000;expect(kernel.computeRetained(frame([proxy]))).toEqual(new VisionMaskKernel().computeRetained(frame([proxy])));expect(()=>immutableVisionGroup('unbranded',[new Proxy(immutableVisionSource('proxy',0,0,3000),{})])).toThrow('INVALID_IMMUTABLE_VISION_GROUP');
    const owned=frame([immutableVisionGroup('blue',[immutableVisionSource('owned',12000,12000,9000)])]),first=kernel.computeRetained(owned),oldMask=first[0]!.mask.slice();
    const blocked={...owned,blockerRevision:1,blockers:[{id:'cliff',xMm:15000,zMm:12000,halfWidth:1000,halfHeight:13000}]};
    expect(kernel.computeRetained(blocked)).toEqual(new VisionMaskKernel().computeRetained(blocked));expect(kernel.computeRetained(blocked)[0]!.visible).not.toEqual(first[0]!.visible);expect(first[0]!.mask).toEqual(oldMask);
    for(const changed of [{...blocked,width:18},{...blocked,cacheKey:'cold-map'},{...blocked,gridMm:1000}])expect(kernel.computeRetained(changed)).toEqual(new VisionMaskKernel().computeRetained(changed));
  });
  it('reuses stationary native source/group identities and copies only the moving group without retaining old poses',()=>{
    const sim=fixture(false),internal=sim as unknown as VisionCommitInternals&{liveOwned:boolean};internal.liveOwned=true;
    const first=internal.prepareVision(),snapshot=structuredClone(first),same=internal.prepareVision();expect(same.groups).toBe(first.groups);
    const actor=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue')!;actor.xMm+=237;actor.zMm-=139;
    const moved=internal.prepareVision();expect(moved.groups).not.toBe(first.groups);
    for(let index=0;index<first.groups.length;index++){
      const old=first.groups[index]!,next=moved.groups[index]!;
      if(old.key==='player:blue'){expect(next).not.toBe(old);for(let source=0;source<old.sources.length;source++){if(old.sources[source]!.id===actor.id){expect(next.sources[source]).not.toBe(old.sources[source]);expect(next.sources[source]).toMatchObject({xMm:actor.xMm,zMm:actor.zMm});}else expect(next.sources[source]).toBe(old.sources[source]);}}
      else expect(next).toBe(old);
    }
    expect(first).toEqual(snapshot);expect(internal.prepareVision().groups).toBe(moved.groups);
    const results=internal.visionKernel.computeRetained(moved);for(const result of results)expect(result.visible).toEqual(referenceFog(sim,result.key.slice('player:'.length)));
  });
  it('rebuilds native source membership/group policy and clears failed captures without changing fog inclusion rules',()=>{
    const sim=fixture(true),internal=sim as unknown as VisionCommitInternals&{liveOwned:boolean;liveVisionSources:unknown;invalidateEntityRoster(staticChanged?:boolean):void};internal.liveOwned=true;
    const check=()=>{const input=internal.prepareVision(),results=internal.visionKernel.computeRetained(input);expect(results).toEqual(new VisionMaskKernel().computeRetained(structuredClone(input)));for(const faction of sim.state.factions)expect(results.find(result=>result.key===internal.visionGroup(faction.id))!.visible).toEqual(referenceFog(sim,faction.id));return input;};
    const first=check(),actor=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue')!;
    actor.garrisonedIn='source-fixture';actor.hp=0;expect(check().groups).toBe(first.groups);delete actor.garrisonedIn;actor.hp=actor.maxHp;
    actor.typeId='scout';actor.xMm+=2000;check();actor.ownerId='red';check();
    const born={...structuredClone(actor),id:'vision-source-birth'};sim.state.entities[born.id]=born;internal.invalidateEntityRoster();check();delete sim.state.entities[born.id];internal.invalidateEntityRoster();check();
    sim.state.factions.find(faction=>faction.id==='green')!.teamId='separated';check();sim.state.factions.reverse();check();
    const old=check();sim.state.matchEpoch++;expect(check().groups).not.toBe(old.groups);sim.state.widthMm+=2000;check();
    const x=actor.xMm;Object.defineProperty(actor,'xMm',{configurable:true,get(){throw new Error('VISION_SOURCE_CAPTURE_FAILED');}});
    try{expect(check).toThrow('VISION_SOURCE_CAPTURE_FAILED');expect(internal.liveVisionSources).toBeUndefined();}finally{Object.defineProperty(actor,'xMm',{configurable:true,enumerable:true,writable:true,value:x});}check();
    internal.liveOwned=false;const generic=check();actor.xMm+=1000;const next=check();expect(next.groups).not.toBe(generic.groups);
  });
  it('uses building witnesses in native source preparation without changing current fog or actor inclusion',()=>{
    const sim=fixture(false),internal=sim as unknown as VisionCommitInternals&{liveOwned:boolean;invalidateEntityRoster(staticChanged?:boolean):void};internal.liveOwned=true;
    sim.state.map.terrain=[];sim.state.navigationRevision++;
    const town=alive(sim).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='town_center')!,worker=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='villager')!;
    worker.xMm=town.xMm;worker.zMm=town.zMm;
    const check=()=>{const results=internal.visionKernel.computeRetained(internal.prepareVision());for(const faction of sim.state.factions)expect(results.find(result=>result.key===internal.visionGroup(faction.id))!.visible).toEqual(referenceFog(sim,faction.id));return internal.visionKernel.workSnapshot();};
    expect(check().coveredSources).toBeGreaterThan(0);worker.xMm+=139;worker.zMm-=97;
    expect(check()).toMatchObject({rasterizedSources:0});expect(internal.visionKernel.workSnapshot().coveredSources).toBeGreaterThan(0);
    // Keep existing source inclusion and secrecy rules exactly, even where these
    // status fields do not themselves remove an actor from the vision roster.
    worker.garrisonedIn=town.id;worker.hp=0;sim.state.economies.blue!.defeated=true;check();
    delete worker.garrisonedIn;worker.hp=worker.maxHp;sim.state.economies.blue!.defeated=false;
    worker.xMm+=30000;expect(check().rasterizedSources).toBe(1);worker.xMm=town.xMm;check();
    delete sim.state.entities[town.id];internal.invalidateEntityRoster(true);check();
    worker.ownerId='red';internal.invalidateEntityRoster();check();sim.state.factions.find(faction=>faction.id==='red')!.teamId='allies';check();
    internal.liveOwned=false;expect(check().coveredSources).toBe(0);
  });
});

describe('native static-only knowledge reconciliation certificates',()=>{
  type NativeInternals=WorkVisibilityInternals&{
    liveOwned:boolean;liveWorld:Entity[]|undefined;liveActors:Entity[];perceptionWorld:readonly Entity[]|undefined;
    staticKnowledgeCertificate:unknown;perceptionMembership:PerceptionMembership;
    invalidateEntityRoster(staticChanged?:boolean):void;observeActions():void;formationNavigation(playerId:string):unknown;
  };
  function nativeFixture(){
    const sim=fixture(false),internal=sim as unknown as NativeInternals;
    // Exercise the private ownership seam without exporting it through the real
    // facade. Public factory continuation is checked independently below.
    internal.liveOwned=true;refresh(sim);
    const read=()=>{internal.workFrame={};try{const value=internal.knownStatic('blue');expect(value).toEqual(referenceKnownStatic(sim,'blue'));return value;}finally{internal.workFrame=undefined;}};
    return {sim,internal,read};
  }
  it('skips actor pose scans after a committed vision phase without certifying stale actor visibility',()=>{
    const {sim,internal,read}=nativeFixture(),before=internal.perceptionMembership.inventory().reconciled;
    const actor=internal.liveActors.find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='red')!;
    expect(internal.staticKnowledgeCertificate).toBeDefined();read();read();expect(internal.perceptionMembership.inventory().reconciled).toBe(before);
    actor.xMm+=3000;actor.garrisonedIn='hidden-fixture';internal.perceptionWorld=undefined;
    read();expect(internal.perceptionMembership.inventory().reconciled).toBe(before);expect(internal.perceptionWorld).toBeUndefined();
    // Boundary formation preparation may use the static proof but cannot mark
    // a moved/garrisoned actor's old footprint current for observations.
    internal.formationNavigation('blue');expect(internal.perceptionWorld).toBeUndefined();expect(internal.perceptionMembership.inventory().reconciled).toBe(before);
    internal.observeActions();expect(internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(before);
    expect(internal.perceptionMembership.actors('player:blue','blue')).not.toContain(actor);expect(sim.state.vision.blue!.actions[actor.id]).toBeUndefined();
    const committed=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBe(committed);
  });
  it('invalidates on roster, physical geometry, current masks, recipient order, dimensions and epoch changes',()=>{
    const {sim,internal,read}=nativeFixture();
    const verify=()=>{const before=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(before);const after=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBe(after);};
    const unit=internal.liveActors.find((entity):entity is Unit=>entity.kind==='unit')!,born={...structuredClone(unit),id:'certificate_birth'};sim.state.entities[born.id]=born;internal.invalidateEntityRoster();verify();
    delete sim.state.entities[born.id];internal.invalidateEntityRoster();verify();
    const building=internal.addBuilding('blue','wooden_gate',{xMm:120000,zMm:120000},0,true);verify();
    building.rotation=90;sim.state.navigationRevision++;verify();building.gateOpen=true;sim.state.navigationRevision++;verify();
    const tree=read().find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource')!;tree.amount=0;sim.state.navigationRevision++;verify();
    // Live fields remain current even when membership/footprints are unchanged.
    const before=internal.perceptionMembership.inventory().reconciled;building.hp--;building.work--;tree.amount=5;expect(read()).toContain(building);expect(read().find(entity=>entity.id===tree.id)).toBe(tree);expect(internal.perceptionMembership.inventory().reconciled).toBe(before);
    building.ownerId='red';internal.invalidateEntityRoster(true);verify();delete sim.state.entities[building.id];internal.invalidateEntityRoster(true);verify();
    internal.visibilityMasks.set('blue',new Uint8Array(internal.visibilityMasks.get('blue')!.length));verify();
    sim.state.factions.reverse();verify();sim.state.matchEpoch++;verify();
    sim.state.widthMm+=2000;refresh(sim);read();const previous=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBe(previous);
    // A new group must commit its actual current mask before it can be retained.
    (sim.options as {sharedVision:boolean}).sharedVision=true;refresh(sim);read();const shared=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBe(shared);
  });
  it('drops partial reconciliation proofs and keeps generic mutable fixtures eager',()=>{
    const {sim,internal,read}=nativeFixture(),actor=internal.liveActors.find((entity):entity is Unit=>entity.kind==='unit')!;
    const x=actor.xMm;sim.state.navigationRevision++;
    Object.defineProperty(actor,'xMm',{configurable:true,get(){throw new Error('CERTIFICATE_PARTIAL_SCAN');}});
    try{expect(read).toThrow('CERTIFICATE_PARTIAL_SCAN');expect(internal.staticKnowledgeCertificate).toBeUndefined();}finally{Object.defineProperty(actor,'xMm',{configurable:true,writable:true,enumerable:true,value:x});}
    const before=internal.perceptionMembership.inventory().reconciled;read();expect(internal.perceptionMembership.inventory().reconciled).toBeGreaterThan(before);
    internal.liveOwned=false;const tree=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource'&&internal.visible('blue',entity))!;
    const current=internal.perceptionMembership.inventory().reconciled;read();read();expect(internal.perceptionMembership.inventory().reconciled-current).toBe(Object.keys(sim.state.entities).length*2);expect(internal.staticKnowledgeCertificate).toBeUndefined();
    tree.xMm=(tree.xMm+sim.state.widthMm/2)%sim.state.widthMm;internal.visibilityMasks.set('blue',new Uint8Array(internal.visibilityMasks.get('blue')!.length));read();
  });
  it('preserves native/scalar fog, static knowledge and complete cold/replay continuation',async()=>{
    const source=fixture(false),options={...source.options,authoritativeIntervalMs:300 as const},payload=source.capture(),native=createLiveSimulation(options,payload),reference=new Simulation(options,payload);
    (reference as unknown as VisibilityInternals).knownStatic=playerId=>referenceKnownStatic(reference,playerId);
    const view=native.view('blue'),worker=view.entities.find(entity=>entity.typeId==='villager'&&entity.ownerId==='blue')!,node=view.entities.find(entity=>entity.kind==='resource'&&entity.resource==='wood')!;
    const envelope={protocolVersion:2 as const,matchId:options.matchId,matchEpoch:payload.state.matchEpoch,clientCommandId:'static-certificate-gather',clientSequence:1,command:{kind:'gather' as const,unitIds:[worker.id],targetId:node.id,queued:false}};
    expect(native.command('blue',envelope)).toEqual(reference.command('blue',envelope));
    for(let frame=0;frame<4;frame++){native.advanceFrame();reference.advanceFrame();await native.synchronizeCapture();await reference.synchronizeCapture();expect(native.capture()).toEqual(reference.capture());expect(native.views(factions.map(f=>f.id))).toEqual(reference.views(factions.map(f=>f.id)));}
    const saved=native.capture(),cold=createLiveSimulation(options,saved),identity:EngineIdentity={engineBuildHash:'9'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},recording=exportReplay(native,identity,[replayCheckpoint(native)]),replay=new ReplayRunner(recording,identity);
    expect(replay.advanceTo(native.state.tick).done).toBe(true);expect(replay.simulation.capture()).toEqual(saved);
    for(const simulation of [native,cold,reference]){simulation.advanceFrame();await simulation.synchronizeCapture();}expect(cold.capture()).toEqual(native.capture());expect(reference.capture()).toEqual(native.capture());
  });
});

describe('derived visibility masks and stamps',()=>{
  it.each([false,true])('keeps phase-local static memberships identical to scalar continuation with sharedVision=%s',sharedVision=>{
    const sim=fixture(sharedVision),reference=new Simulation(sim.options,sim.capture()),ids=factions.map(faction=>faction.id);
    (reference as unknown as VisibilityInternals).knownStatic=playerId=>referenceKnownStatic(reference,playerId);
    for(const playerId of ['blue','green']){
      const view=sim.view(playerId),worker=view.entities.find(entity=>entity.typeId==='villager'&&entity.ownerId===playerId)!,node=view.entities.find(entity=>entity.kind==='resource'&&entity.resource==='wood')!;
      const envelope={protocolVersion:2 as const,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`membership_${playerId}`,clientSequence:1,command:{kind:'gather' as const,unitIds:[worker.id],targetId:node.id,queued:false}};
      expect(sim.command(playerId,envelope)).toEqual(reference.command(playerId,envelope));
    }
    const resource=Object.values(sim.state.entities).find(entity=>entity.kind==='resource')!,house=Object.values(sim.state.entities).find(entity=>entity.kind==='building'&&entity.typeId==='house')!;
    let addedId:string|undefined;
    for(let tick=0;tick<40;tick++){
      if(tick===10)for(const current of [sim,reference]){
        const node=current.state.entities[resource.id]!;node.xMm+=137;node.zMm-=291;if(node.kind==='resource'){node.resource='gold';node.typeId='gold_deposit';node.amount=0;}
        const building=current.state.entities[house.id]!;if(building.kind==='building')building.rotation=90;
      }
      if(tick===20)for(const current of [sim,reference])addedId=(current as unknown as WorkVisibilityInternals).addBuilding('blue','house',{xMm:120000,zMm:120000},0,false).id;
      if(tick===30)for(const current of [sim,reference]){delete current.state.entities[addedId!];current.state.navigationRevision++;}
      sim.step();reference.step();expect(sim.capture()).toEqual(reference.capture());expect(sim.views(ids)).toEqual(reference.views(ids));expect(sim.pathDiagnostics()).toEqual(reference.pathDiagnostics());expect(sim.drainJournal()).toEqual(reference.drainJournal());
    }
    // Direct public edits between phases must use fresh geometry and membership.
    const internal=sim as unknown as WorkVisibilityInternals;
    expect(internal.workFrame).toBeUndefined();expect(internal.movementFrame).toBeUndefined();
    for(const id of ids)expect(internal.knownStatic(id)).toEqual(referenceKnownStatic(sim,id));
  });

  it('retains scalar membership for externally expanded rosters instead of truncating faction bits',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals;
    while(sim.state.factions.length<17){const index=sim.state.factions.length,id=`external_${index}`;sim.state.factions.push({...factions[0]!,id});sim.state.vision[id]={visible:[],explored:[],memory:{},actions:{}};}
    const id=sim.state.factions.at(-1)!.id,mask=new Uint8Array(Math.floor(sim.state.widthMm/2000)*Math.floor(sim.state.heightMm/2000));mask.fill(1);internal.visibilityMasks.set(id,mask);
    internal.workFrame={};try{expect(internal.knownStatic(id)).toEqual(referenceKnownStatic(sim,id));expect(internal.knownStatic(id).some(entity=>entity.kind==='resource')).toBe(true);}finally{internal.workFrame=undefined;}
  });

  it('reuses reconciled static membership without packing footprints or appending memory to its retained roster',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals&{perceptionMembership:PerceptionMembership};
    const hidden=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='red'&&!internal.visible('blue',entity))!;
    expect(hidden).toBeDefined();sim.state.vision.blue!.memory[hidden.id]={...internal.asView(hidden,false,'blue'),lastSeenTick:0};
    let retained:readonly Entity[];
    internal.workFrame={};try{
      const actual=internal.knownStatic('blue');retained=internal.perceptionMembership.statics('player:blue','blue');
      expect(actual).toEqual(referenceKnownStatic(sim,'blue'));expect(actual).not.toBe(retained);expect(actual.some(entity=>entity.id===hidden.id)).toBe(true);expect(retained.some(entity=>entity.id===hidden.id)).toBe(false);
      expect(internal.workFrame.knowledge?.staticIndexed).toBe(true);expect(internal.workFrame.knowledge?.staticFootprints).toBeUndefined();
    }finally{internal.workFrame=undefined;}
    const resource=retained!.find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource')!;resource.amount--;
    internal.workFrame={};try{
      expect(internal.knownStatic('blue')).toEqual(referenceKnownStatic(sim,'blue'));expect(internal.perceptionMembership.statics('player:blue','blue')).toBe(retained!);
      expect(internal.workFrame.knowledge?.staticFootprints).toBeUndefined();
    }finally{internal.workFrame=undefined;}
  });

  it.each(['different','missing'] as const)('falls back to recipient ownership when an allied mask is %s',mode=>{
    const sim=fixture(true),internal=sim as unknown as WorkVisibilityInternals,size=Math.floor(sim.state.widthMm/2000)*Math.floor(sim.state.heightMm/2000);
    if(mode==='missing')internal.visibilityMasks.delete('blue');else internal.visibilityMasks.set('blue',new Uint8Array(size));internal.visibilityMasks.set('green',new Uint8Array(size).fill(1));
    internal.workFrame={};try{
      expect(internal.knownStatic('blue')).toEqual(referenceKnownStatic(sim,'blue'));expect(internal.knownStatic('green')).toEqual(referenceKnownStatic(sim,'green'));
      expect(internal.workFrame.knowledge?.staticIndexed).toBe(false);expect(internal.workFrame.knowledge?.staticFootprints).toBeDefined();
    }finally{internal.workFrame=undefined;}
  });

  it('reconciles a new building between work knowledge and movement even within the same tick',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals,phases=sim as unknown as {tickFrame:{entities?:Entity[]}|undefined;prepareMovement(knowledge:unknown):void;movementFrame:{entities:Entity[];knownStatic:Map<string,Entity[]>}|undefined};
    phases.tickFrame={};internal.workFrame={};
    try{
      const before=internal.knownStatic('blue'),knowledge=internal.workFrame.knowledge,oldEntities=phases.tickFrame.entities;
      internal.workFrame=undefined;const added=internal.addBuilding('blue','house',{xMm:120000,zMm:120000},0,false);
      phases.prepareMovement(knowledge);
      expect(phases.movementFrame!.entities).not.toBe(oldEntities);expect(before).not.toContain(added);expect(phases.movementFrame!.knownStatic.get('blue')).toContain(added);
      expect(phases.movementFrame!.knownStatic.get('blue')).toEqual(referenceKnownStatic(sim,'blue'));
    }finally{internal.workFrame=undefined;phases.movementFrame=undefined;phases.tickFrame=undefined;}
  });

  it('reconciles replacement masks and in-place entity geometry within a retained world array',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals,phases=sim as unknown as {tickFrame:{entities?:Entity[]}|undefined},fog=balance.rules.fogGridM*1000,columns=Math.floor(sim.state.widthMm/fog),size=columns*Math.floor(sim.state.heightMm/fog);
    const node=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource'&&internal.visible('blue',entity))!;
    const read=()=>{internal.workFrame={};try{const result=internal.knownStatic('blue');expect(result).toEqual(referenceKnownStatic(sim,'blue'));return result;}finally{internal.workFrame=undefined;}};
    phases.tickFrame={};try{
      expect(read()).toContain(node);const retainedWorld=phases.tickFrame.entities;
      // Masks are immutable private phase outputs; fixture changes replace them.
      internal.visibilityMasks.set('blue',new Uint8Array(size));expect(read()).not.toContain(node);
      const mask=new Uint8Array(size);mask[Math.floor(node.zMm/fog)*columns+Math.floor(node.xMm/fog)]=1;internal.visibilityMasks.set('blue',mask);expect(read()).toContain(node);
      node.xMm=(node.xMm+sim.state.widthMm/2)%sim.state.widthMm;expect(read()).not.toContain(node);expect(phases.tickFrame.entities).toBe(retainedWorld);
    }finally{internal.workFrame=undefined;phases.tickFrame=undefined;}
  });

  it('matches uncached work through concurrent returns, depletion, retargeting and newly completed drop-offs',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals;
    const unitTemplate=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager')!;
    const buildingTemplate=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building')!;
    sim.state.entities={};sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const faction of factions)sim.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};
    const building=(id:string,xMm:number,zMm:number,ownerId='blue',complete=true)=>{
      const def=buildings.lumber_camp,required=def.buildSeconds*balance.rules.simulationHz*100,work=complete?required:required-100;
      const entity:Building={...structuredClone(buildingTemplate),id,ownerId,typeId:'lumber_camp',xMm,zMm,rotation:0,maxHp:def.maxHp,hp:def.maxHp-1,grantedHp:def.maxHp-1,work,required,queue:[]};sim.state.entities[id]=entity;return entity;
    };
    const resource=(id:string,xMm:number,zMm:number,amount:number)=>{
      const entity:Extract<Entity,{kind:'resource'}>={id,kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',xMm,zMm,amount,hp:1,maxHp:1};sim.state.entities[id]=entity;return entity;
    };
    const worker=(id:string,xMm:number,zMm:number,targetId:string,cargo=0,kind:'gather'|'build'='gather')=>{
      const entity:Unit={...structuredClone(unitTemplate),id,ownerId:'blue',xMm,zMm,orders:[{kind,targetId,...(kind==='gather'?{phase:cargo?'deposit' as const:'gather' as const}:{})}],path:[],cargo:{resource:cargo?'wood':null,amount:cargo},gatherRemainder:0};sim.state.entities[id]=entity;return entity;
    };
    const own=building('work_own',20000,20000),ally=building('work_ally',50000,20000,'green'),finishing=building('work_finishing',60000,40000,'blue',false),hidden=building('work_hidden',90000,90000,'green');
    const depleted=resource('work_depleted',30000,30000,20),next=resource('work_next',34000,30000,100000),source=resource('work_source',20000,30000,100000);
    const margin=buildings.lumber_camp.footprintCells[0]*1000+850;
    const ownReturn=worker('work_return_own',own.xMm-margin,own.zMm,source.id,7000);
    worker('work_depleter',depleted.xMm-900,depleted.zMm,depleted.id);
    const retarget=worker('work_retarget',depleted.xMm-1200,depleted.zMm+2000,depleted.id);
    const alliedReturn=worker('work_return_ally',ally.xMm-margin,ally.zMm,source.id,9000);
    worker('work_builder',finishing.xMm,finishing.zMm+margin,finishing.id,0,'build');
    const waitingReturn=worker('work_return_finishing',finishing.xMm-margin,finishing.zMm,source.id,12000);
    worker('work_return_far',75000,75000,source.id,5000);
    refresh(sim);
    sim.state.vision.blue!.memory[hidden.id]={...internal.asView(hidden,false,'blue'),lastSeenTick:0};
    const hiddenMemory=structuredClone(sim.state.vision.blue!.memory[hidden.id]);
    const reference=new Simulation(sim.options,sim.capture()),uncached=reference as unknown as WorkVisibilityInternals;
    uncached.knownStatic=playerId=>referenceKnownStatic(reference,playerId);
    uncached.dropoffs=unit=>referenceDropoffs(reference,unit);
    const original=internal.knownStatic,phaseArrays:Entity[][]=[];
    internal.knownStatic=function(playerId){const actual=original.call(sim,playerId);expect(actual).toEqual(referenceKnownStatic(sim,playerId));if(playerId==='blue')phaseArrays.push(actual);return actual;};
    const originalDropoffs=internal.dropoffs,buildingArrays:Building[][]=[];
    internal.dropoffs=function(unit){const actual=originalDropoffs.call(sim,unit);expect(actual).toEqual(referenceDropoffs(sim,unit));const candidates=internal.workFrame?.knowledge?.knownBuildings?.get(unit.ownerId);if(candidates)buildingArrays.push(candidates);return actual;};
    const ownBank=sim.state.economies.blue!.resources.wood,allyBank=sim.state.economies.green!.resources.wood;
    internal.advanceWork();uncached.advanceWork();
    expect(sim.capture()).toEqual(reference.capture());expect(sim.views(factions.map(f=>f.id))).toEqual(reference.views(factions.map(f=>f.id)));
    expect(phaseArrays.length).toBeGreaterThanOrEqual(5);expect(phaseArrays.every(entries=>entries===phaseArrays[0])).toBe(true);
    expect(buildingArrays.length).toBeGreaterThanOrEqual(4);expect(buildingArrays.every(entries=>entries===buildingArrays[0])).toBe(true);expect(buildingArrays[0]).toContain(finishing);expect(buildingArrays[0]!.every(entity=>entity.kind==='building')).toBe(true);
    expect(depleted.amount).toBe(0);expect(retarget.orders[0]?.targetId).toBe(depleted.id);expect(retarget.resourceSearch).toMatchObject({purpose:'depleted',index:0});expect(retarget.resourceSearch!.targetIds[0]).toBe(next.id);
    expect(ownReturn.cargo.amount).toBe(0);expect(alliedReturn.cargo.amount).toBe(0);expect(sim.state.economies.blue!.resources.wood-ownBank).toBe(16000);expect(sim.state.economies.green!.resources.wood).toBe(allyBank);
    expect(finishing.work).toBe(finishing.required);expect(waitingReturn.cargo.amount).toBe(12000);expect(sim.state.vision.blue!.memory[hidden.id]).toEqual(hiddenMemory);expect(internal.workFrame).toBeUndefined();
    const priorArray=phaseArrays[0],priorBuildings=buildingArrays[0];phaseArrays.length=0;buildingArrays.length=0;
    internal.advanceWork();uncached.advanceWork();
    // Unchanged membership now retains its live-reference roster across phases;
    // completion/depletion still affect work and freshly selected drop-offs.
    expect(waitingReturn.cargo.amount).toBe(0);expect(phaseArrays[0]).toBe(priorArray);expect(buildingArrays[0]).not.toBe(priorBuildings);expect(sim.capture()).toEqual(reference.capture());
    // A boundary removal outside vision must still leave the authorized memory.
    delete sim.state.entities[hidden.id];delete reference.state.entities[hidden.id];sim.state.navigationRevision++;reference.state.navigationRevision++;
    internal.advanceWork();uncached.advanceWork();
    expect(sim.capture()).toEqual(reference.capture());expect(sim.state.vision.blue!.memory[hidden.id]).toEqual(hiddenMemory);expect(internal.workFrame).toBeUndefined();
    internal.advanceMovement();uncached.advanceMovement();
    expect(sim.capture()).toEqual(reference.capture());expect(sim.views(factions.map(f=>f.id))).toEqual(reference.views(factions.map(f=>f.id)));expect(internal.movementFrame).toBeUndefined();
    // Ordinary ticks carry the completed work phase's knowledge into movement.
    // Compare the whole continuation with independent uncached membership and
    // drop-off selection, including the prior depletion/completion mutations.
    for(let tick=0;tick<200&&(tick<3||retarget.orders[0]?.targetId!==next.id);tick++){sim.step();reference.step();expect(sim.pathDiagnostics().work).toBeLessThanOrEqual(4000);expect(reference.pathDiagnostics().work).toBeLessThanOrEqual(4000);expect(sim.capture()).toEqual(reference.capture());expect(sim.views(factions.map(f=>f.id))).toEqual(reference.views(factions.map(f=>f.id)));}
    expect(retarget.orders[0]?.targetId).toBe(next.id);expect(retarget.resourceSearch).toBeUndefined();
  });

  it('invalidates work knowledge on membership changes and always clears it after a failed phase',()=>{
    const sim=fixture(false),internal=sim as unknown as WorkVisibilityInternals;
    const worker=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='villager')!;
    const node=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource')!;
    worker.orders=[{kind:'gather',targetId:node.id,phase:'deposit'}];worker.cargo={resource:'wood',amount:5000};
    const original=internal.gather;let added:Building|undefined;
    internal.gather=function(){
      const before=internal.knownStatic('blue');
      internal.dropoffs(worker);const priorBuildings=internal.workFrame?.knowledge?.knownBuildings?.get('blue');
      added=internal.addBuilding('blue','lumber_camp',{xMm:worker.xMm+20000,zMm:worker.zMm},0,true);
      const after=internal.knownStatic('blue');expect(after).not.toBe(before);expect(after).toContain(added);expect(after).toEqual(referenceKnownStatic(sim,'blue'));
      expect(internal.dropoffs(worker)).toContain(added);const currentBuildings=internal.workFrame?.knowledge?.knownBuildings?.get('blue');expect(currentBuildings).not.toBe(priorBuildings);
      added.work=0;expect(internal.dropoffs(worker)).not.toContain(added);added.work=added.required;expect(internal.dropoffs(worker)).toContain(added);
      worker.cargo.resource='food';expect(internal.dropoffs(worker)).not.toContain(added);worker.cargo.resource='wood';
      sim.state.economies.blue!.defeated=true;expect(internal.dropoffs(worker)).not.toContain(added);sim.state.economies.blue!.defeated=false;
      expect(internal.workFrame?.knowledge?.knownBuildings?.get('blue')).toBe(currentBuildings);expect(internal.dropoffs(worker)).toEqual(referenceDropoffs(sim,worker));
      delete sim.state.entities[added.id];internal.invalidateEntityRoster();expect(internal.knownStatic('blue')).not.toContain(added);expect(internal.dropoffs(worker)).not.toContain(added);
      throw new Error('WORK_PHASE_FIXTURE_FAILURE');
    };
    expect(()=>internal.advanceWork()).toThrow('WORK_PHASE_FIXTURE_FAILURE');expect(internal.workFrame).toBeUndefined();internal.gather=original;
    sim.state.entities[added!.id]=added!;
    expect(internal.knownStatic('blue')).toContain(added);expect(internal.knownStatic('blue')).toEqual(referenceKnownStatic(sim,'blue'));
    internal.advanceWork();expect(internal.workFrame).toBeUndefined();
  });

  it('matches legacy footprints in batched views and movement across edges, every building rotation and in-place edits',()=>{
    const sim=fixture(false),internal=sim as unknown as VisibilityInternals,ids=factions.map(faction=>faction.id),fog=balance.rules.fogGridM*1000;
    const template=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building')!,worker=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit')!;
    sim.state.entities={};sim.state.widthMm=32000;sim.state.heightMm=28000;sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const faction of factions){sim.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};const owned={...structuredClone(worker),id:`packed_worker_${faction.id}`,ownerId:faction.id,xMm:7999,zMm:8001,orders:[],path:[]};sim.state.entities[owned.id]=owned;}
    for(const [index,typeId]of (Object.keys(buildings) as BuildingId[]).entries())for(const rotation of [0,90,180,270] as const){
      const definition=buildings[typeId],entity:Building={...structuredClone(template),id:`packed_${typeId}_${rotation}`,ownerId:factions[index%factions.length]!.id,typeId,rotation,xMm:[0,999,2000,31999][rotation/90]!,zMm:[27999,1999,14000,0][rotation/90]!,hp:definition.maxHp,maxHp:definition.maxHp,work:definition.buildSeconds*2000,required:definition.buildSeconds*2000,queue:[]};sim.state.entities[entity.id]=entity;
    }
    for(const resource of ['food','wood','gold','stone'] as const)for(const [index,xMm]of [0,450,650,1999,2000,32000].entries()){
      const entity:Extract<Entity,{kind:'resource'}>={id:`packed_${resource}_${index}`,kind:'resource',typeId:resource==='wood'?'wood_oak':resource,ownerId:null,resource,amount:index%2?0:100000,xMm,zMm:[0,1999,2000,14001,27999,28000][index]!,hp:1,maxHp:1};sim.state.entities[entity.id]=entity;
    }
    for(let round=0;round<9;round++){
      const columns=Math.floor(sim.state.widthMm/fog),rows=Math.floor(sim.state.heightMm/fog);
      for(const [index,id]of ids.entries()){
        const mask=new Uint8Array(columns*rows),visible:number[]=[];
        for(let cell=0;cell<mask.length;cell++)if(round===1||round>1&&(cell*17+round*31+index*13)%23<4){mask[cell]=1;visible.push(cell);}
        internal.visibilityMasks.set(id,mask);sim.state.vision[id]!.visible=visible;sim.state.vision[id]!.explored=[...visible];
      }
      const expected=ids.map(id=>sim.view(id));expect(sim.views(ids)).toEqual(expected);expect(sim.views(['red','blue','red'])).toEqual([expected[2],expected[0],expected[2]]);checkMovementKnowledge(sim);
      // Deliberately mutate geometry without a navigation revision: every new
      // phase must read it afresh, not depend on a persistent cache's invalidation.
      for(const entity of Object.values(sim.state.entities)){
        entity.xMm=(entity.xMm+137)%sim.state.widthMm;entity.zMm=(entity.zMm+291)%sim.state.heightMm;
        if(entity.kind==='building')entity.rotation=((entity.rotation+90)%360) as Building['rotation'];
        if(entity.kind==='resource'){entity.resource=entity.resource==='wood'?'gold':'wood';entity.amount=entity.amount?0:100000;}
      }
      if(round===3){sim.state.widthMm+=fog;sim.state.heightMm+=fog;}
      if(round===5){delete sim.state.entities.packed_house_0;const added={...structuredClone(template),id:'packed_added_between_phases',ownerId:'red',xMm:12000,zMm:12000};sim.state.entities[added.id]=added;}
    }
  });

  it('refreshes packed live-static memory exactly as the legacy predicate while retaining hidden old observations',()=>{
    const sim=fixture(false),internal=sim as unknown as VisibilityInternals,ids=factions.map(faction=>faction.id);sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const entity of alive(sim)){entity.xMm=entity.ownerId==='blue'?30000:200000;entity.zMm=entity.ownerId==='blue'?30000:200000;}
    const observer=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!,enemy=alive(sim).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='red'&&entity.typeId==='house')!;
    enemy.xMm=90000;enemy.zMm=90000;
    const resource:Extract<Entity,{kind:'resource'}>={id:'packed_observed_resource',kind:'resource',typeId:'wood_oak',ownerId:null,resource:'wood',amount:100000,xMm:90550,zMm:91550,hp:1,maxHp:1};sim.state.entities[resource.id]=resource;
    const check=()=>{
      const prior=Object.fromEntries(ids.map(id=>[id,structuredClone(sim.state.vision[id]!.memory)]));refresh(sim);
      for(const id of ids){
        const expected=prior[id]!;
        for(const [key,memory]of Object.entries(expected))if(!sim.state.entities[key]&&internal.visible(id,memory))delete expected[key];
        for(const entity of Object.values(sim.state.entities))if(entity.kind!=='unit'&&entity.ownerId!==id&&internal.visible(id,entity))expected[entity.id]={...internal.asView(entity,false,id),lastSeenTick:sim.state.tick};
        expect(sim.state.vision[id]!.memory).toEqual(expected);
      }
      expect(sim.views(ids)).toEqual(ids.map(id=>sim.view(id)));checkMovementKnowledge(sim);
    };
    observer.xMm=90000;observer.zMm=82000;check();const old=structuredClone(sim.state.vision.blue!.memory[resource.id]);expect(old).toBeDefined();
    observer.xMm=30000;observer.zMm=30000;check();resource.amount=0;resource.resource='gold';resource.xMm+=137;enemy.rotation=90;enemy.hp--;check();expect(sim.state.vision.blue!.memory[resource.id]).toEqual(old);
    delete sim.state.entities[enemy.id];check();expect(sim.state.vision.blue!.memory[enemy.id]).toBeDefined();
    observer.xMm=90000;observer.zMm=82000;check();expect(sim.state.vision.blue!.memory[enemy.id]).toBeUndefined();expect(sim.state.vision.blue!.memory[resource.id]).toMatchObject({amount:0,resource:'gold',xMm:resource.xMm});
  });

  it('publishes batched recipients as independent viewpoints and observes membership changes at the next boundary',()=>{
    const sim=fixture(false),ids=factions.map(faction=>faction.id),expected=ids.map(id=>sim.view(id));
    expect(sim.views(ids)).toEqual(expected);expect(sim.views([])).toEqual([]);
    const [first,second]=sim.views(['blue','blue']);expect(first).toEqual(second);
    first!.self.resources.wood=99999;first!.entities.length=0;first!.fog.visible.length=0;
    expect(second).toEqual(expected[0]);expect(sim.views(ids)).toEqual(expected);
    const house=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'building'}>=>entity.kind==='building'&&entity.ownerId==='blue'&&entity.typeId==='house')!;
    const added={...structuredClone(house),id:'batch_added_house'};sim.state.entities[added.id]=added;
    let current=sim.views(ids);expect(current).toEqual(ids.map(id=>sim.view(id)));
    expect(current[0]!.entities.some(entity=>entity.id===added.id)).toBe(true);
    expect(expected[0]!.entities.some(entity=>entity.id===added.id)).toBe(false);
    delete sim.state.entities[added.id];current=sim.views(ids);
    expect(current).toEqual(ids.map(id=>sim.view(id)));expect(current[0]!.entities.some(entity=>entity.id===added.id)).toBe(false);
    const before=sim.capture();expect(()=>sim.views(['blue','unknown_player','red'])).toThrow('NOT_AUTHORIZED');expect(sim.capture()).toEqual(before);
  });

  it('restores lazy static visibility for standalone batches without sharing recipient payloads or old phase geometry',()=>{
    const sim=fixture(false),internal=sim as unknown as VisibilityInternals,template=alive(sim).find((entity):entity is Building=>entity.kind==='building')!;
    sim.state.widthMm=8000;sim.state.heightMm=8000;sim.state.map.terrain=[];sim.state.entities={};
    for(const [index,faction]of factions.entries()){
      const house={...structuredClone(template),id:`lazy_${faction.id}`,ownerId:faction.id,typeId:'house' as const,xMm:2000+index*2000,zMm:2000,rotation:0 as const,queue:[]};sim.state.entities[house.id]=house;
      sim.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};
    }
    const node:Extract<Entity,{kind:'resource'}>={id:'lazy_tree',kind:'resource',typeId:'tree',ownerId:null,resource:'wood',amount:100000,xMm:1999,zMm:4000,hp:1,maxHp:1};sim.state.entities[node.id]=node;
    const blue=new Uint8Array(16),red=new Uint8Array(16);blue[5]=1;red[10]=1;
    internal.visibilityMasks.set('blue',blue);internal.visibilityMasks.set('green',blue);internal.visibilityMasks.set('red',red);
    const ids=['red','blue','green','red'],first=sim.views(ids);expect(first).toEqual(ids.map(id=>sim.view(id)));
    first[0]!.entities.length=0;first[1]!.self.resources.food=9999;expect(sim.views(ids)).toEqual(ids.map(id=>sim.view(id)));
    blue.fill(0);red.fill(1);node.xMm=6500;(sim.state.entities.lazy_green as Building).rotation=90;
    const next=sim.views(ids);expect(next).toEqual(ids.map(id=>sim.view(id)));expect(next[0]!.entities.some(entity=>entity.id===node.id)).toBe(true);
    expect(next[1]!.entities.some(entity=>entity.id===node.id)).toBe(false);
  });

  it.each(['instance','prototype'] as const)('keeps scalar batch visibility when a %s reader changes a later recipient mask',mode=>{
    const sim=fixture(false),internal=sim as unknown as VisibilityInternals,prototype=Simulation.prototype as unknown as VisibilityInternals,template=alive(sim).find((entity):entity is Building=>entity.kind==='building')!;
    sim.state.widthMm=8000;sim.state.heightMm=8000;sim.state.map.terrain=[];sim.state.entities={};
    for(const faction of factions){const house={...structuredClone(template),id:`hook_${faction.id}`,ownerId:faction.id,xMm:2000,zMm:2000,queue:[]};sim.state.entities[house.id]=house;sim.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};internal.visibilityMasks.set(faction.id,new Uint8Array(16));}
    const owner=mode==='instance'?internal:prototype,original=owner.asView;
    owner.asView=function(entity,own,playerId){const result=original.call(this,entity,own,playerId);if(playerId==='blue')this.visibilityMasks.get('red')!.fill(1);return result;};
    try{
      const ids=['blue','green','red'],expected=ids.map(id=>sim.view(id));for(const mask of internal.visibilityMasks.values())mask.fill(0);
      expect(sim.views(ids)).toEqual(expected);expect(expected[2]!.entities.some(entity=>entity.id==='hook_blue')).toBe(true);
    }finally{if(mode==='prototype')prototype.asView=original;else delete (internal as unknown as Record<string,unknown>).asView;}
  });

  it('retains unchanged source stamps across gates, depletion and foundations but invalidates exact changed cliff geometry',()=>{
    const sim=fixture(false),source=alive(sim)[0]!;source.xMm=60000;source.zMm=60000;sim.state.map.terrain=[];sim.state.navigationRevision++;refresh(sim);
    const matchesReference=()=>{for(const faction of factions)expect(sim.state.vision[faction.id]!.visible).toEqual(referenceFog(sim,faction.id));};
    const original=cache(sim).get(source.id),building=alive(sim).find((entity):entity is Extract<Entity,{kind:'building'}>=>entity.kind==='building')!;
    const gate:Extract<Entity,{kind:'building'}>={...building,id:'cache_gate',typeId:'wooden_gate',xMm:90000,zMm:90000,rotation:0,gateMode:'AUTO',gateOpen:false};sim.state.entities[gate.id]=gate;sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).toBe(original);matchesReference();
    const gateStamp=cache(sim).get(gate.id);gate.gateOpen=true;sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).toBe(original);expect(cache(sim).get(gate.id)).toBe(gateStamp);matchesReference();
    const resource=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource')!;resource.amount=0;sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).toBe(original);matchesReference();
    const foundation:Extract<Entity,{kind:'building'}>={...building,id:'cache_foundation',typeId:'house',xMm:70000,zMm:95000,work:0,queue:[]};sim.state.entities[foundation.id]=foundation;sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).toBe(original);expect(cache(sim).has(foundation.id)).toBe(true);matchesReference();
    delete sim.state.entities[foundation.id];sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).toBe(original);expect(cache(sim).has(foundation.id)).toBe(false);matchesReference();
    source.xMm+=137;source.zMm-=291;refresh(sim);let prior=cache(sim).get(source.id);expect(prior).not.toBe(original);expect(cache(sim).get(gate.id)).toBe(gateStamp);matchesReference();
    const cliff={id:'in_place_cliff',kind:'cliff' as const,xMm:65000,zMm:40000,widthMm:1000,depthMm:40000,elevationMm:3000};sim.state.map.terrain.push(cliff);sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).not.toBe(prior);matchesReference();
    prior=cache(sim).get(source.id);cliff.xMm+=1000;sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).not.toBe(prior);matchesReference();
    prior=cache(sim).get(source.id);sim.state.map.terrain.push({id:'in_place_ramp',kind:'ramp',xMm:65500,zMm:55000,widthMm:2000,depthMm:10000,axis:'x',startElevationMm:0,endElevationMm:3000});sim.state.navigationRevision++;refresh(sim);expect(cache(sim).get(source.id)).not.toBe(prior);matchesReference();
    prior=cache(sim).get(source.id);sim.state.map.terrain=structuredClone(sim.state.map.terrain);refresh(sim);expect(cache(sim).get(source.id)).toBe(prior);matchesReference();
    sim.state.map.terrain=sim.state.map.terrain.filter(region=>region.kind!=='cliff');refresh(sim);expect(cache(sim).get(source.id)).not.toBe(prior);matchesReference();
  });

  it('retains missing hidden static memory until its last footprint is observed again',()=>{
    const sim=fixture(false);sim.state.map.terrain=[];sim.state.navigationRevision++;
    for(const entity of alive(sim)){entity.xMm=entity.ownerId==='blue'?30000:250000;entity.zMm=entity.ownerId==='blue'?30000:250000;}
    const observer=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!,enemy=alive(sim).find(entity=>entity.kind==='building'&&entity.ownerId==='red'&&entity.typeId==='house')!;
    enemy.xMm=90000;enemy.zMm=90000;observer.xMm=90000;observer.zMm=82000;refresh(sim);expect(sim.view('blue').entities.some(entity=>entity.id===enemy.id&&!entity.ghost)).toBe(true);
    const remembered=structuredClone(sim.state.vision.blue!.memory[enemy.id]);observer.xMm=30000;observer.zMm=30000;refresh(sim);const hidden=sim.view('blue');expect(hidden.entities).toContainEqual(expect.objectContaining({id:enemy.id,ghost:true}));
    delete sim.state.entities[enemy.id];sim.state.navigationRevision++;refresh(sim);expect(sim.state.vision.blue!.memory[enemy.id]).toEqual(remembered);expect(sim.view('blue')).toEqual(hidden);
    observer.xMm=90000;observer.zMm=82000;refresh(sim);expect(sim.state.vision.blue!.memory[enemy.id]).toBeUndefined();expect(sim.view('blue').entities.some(entity=>entity.id===enemy.id)).toBe(false);
  });

  it('keeps static footprints recipient-specific across fog changes, relocation, rotation and map dimensions',()=>{
    const sim=fixture(false),fog=balance.rules.fogGridM*1000,buildingGrid=balance.rules.buildingGridM*1000;
    const internal=sim as unknown as {visible(playerId:string,point:Position):boolean;visibilityMasks:Map<string,Uint8Array>};
    const entity:ViewEntity={id:'observed-static',kind:'resource',typeId:'wood_oak',ownerId:null,xMm:20450,zMm:20550,hp:1,maxHp:1,resource:'wood',amount:100};
    const check=()=>{
      const width=Math.floor(sim.state.widthMm/fog),height=Math.floor(sim.state.heightMm/fog),expected:number[]=[];
      // Independent cell-by-cell occupied-footprint oracle. Building samples retain
      // the established cell-center policy; resource rectangles intersect cells.
      let halfWidth:number,halfHeight:number;
      if(entity.kind==='resource')halfWidth=halfHeight=entity.resource==='wood'?450:650;
      else{let [w,h]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];halfWidth=w*buildingGrid/2;halfHeight=h*buildingGrid/2;}
      for(let z=0;z<height;z++)for(let x=0;x<width;x++){
        const occupied=entity.kind==='resource'?x*fog<entity.xMm+halfWidth&&(x+1)*fog>entity.xMm-halfWidth&&z*fog<entity.zMm+halfHeight&&(z+1)*fog>entity.zMm-halfHeight:(x+.5)*fog>=entity.xMm-halfWidth&&(x+.5)*fog<entity.xMm+halfWidth&&(z+.5)*fog>=entity.zMm-halfHeight&&(z+.5)*fog<entity.zMm+halfHeight;
        if(occupied)expected.push(z*width+x);
      }
      const blue=new Uint8Array(width*height),green=new Uint8Array(width*height);internal.visibilityMasks.set('blue',blue);internal.visibilityMasks.set('green',green);
      expect(internal.visible('blue',entity)).toBe(false);expect(expected.length).toBeGreaterThan(0);
      for(const cell of expected){blue[cell]=1;expect(internal.visible('blue',entity)).toBe(true);expect(internal.visible('green',entity)).toBe(false);blue[cell]=0;expect(internal.visible('blue',entity)).toBe(false);green[cell]=1;expect(internal.visible('green',entity)).toBe(true);green[cell]=0;}
      const neighbor=expected[0]!-1;if(!expected.includes(neighbor)){blue[neighbor]=1;expect(internal.visible('blue',entity)).toBe(false);}
      return expected;
    };
    check();entity.resource='gold';check();entity.xMm+=2000;entity.zMm+=2000;check();
    entity.kind='building';entity.typeId='wooden_gate';entity.ownerId='red';entity.xMm=21000;entity.zMm=21000;entity.rotation=0;delete entity.resource;
    check();entity.rotation=90;check();entity.typeId='town_center';entity.xMm=22000;entity.zMm=22000;check();
    sim.state.widthMm+=fog;sim.state.heightMm+=fog;check();
    const ghost={...entity,ghost:true};expect(internal.visible('blue',ghost)).toBe(internal.visible('blue',entity));
  });

  it.each([true,false])('matches the uncached algorithm under sharedVision=%s, exact subcell movement and terrain changes',sharedVision=>{
    const sim=fixture(sharedVision),sources=alive(sim);
    sources.forEach((entity,index)=>{entity.xMm=40000+index*1107;entity.zMm=60000+(index%7)*1879;});
    // Shared teammates are separated enough to reveal different cells, with a
    // cliff and real ramp opening intersecting several vision disks.
    for(const entity of sources.filter(entity=>entity.ownerId==='green'))entity.xMm+=60000;
    sim.state.map.terrain=[{id:'cliff',kind:'cliff',xMm:50000,zMm:40000,widthMm:1000,depthMm:50000,elevationMm:3000},{id:'ramp',kind:'ramp',xMm:49000,zMm:62000,widthMm:3000,depthMm:4000,axis:'x',startElevationMm:0,endElevationMm:3000}];
    sim.state.navigationRevision++;
    for(let round=0;round<6;round++){
      const prior=Object.fromEntries(factions.map(faction=>[faction.id,sim.state.vision[faction.id]!.explored]));
      refresh(sim);
      for(const faction of factions){
        const expected=referenceFog(sim,faction.id),vision=sim.state.vision[faction.id]!;
        expect(vision.visible).toEqual(expected);
        expect(vision.explored).toEqual([...new Set([...prior[faction.id]!,...expected])].sort((a,b)=>a-b));
      }
      if(sharedVision)expect(sim.state.vision.blue!.visible).toEqual(sim.state.vision.green!.visible);
      else expect(sim.state.vision.blue!.visible).not.toEqual(sim.state.vision.green!.visible);
      // Alternates stationary reuse and movement smaller than a fog cell.
      if(round%2===0){sources[0]!.xMm+=137;sources[0]!.zMm-=291;}
      if(round===2){sim.state.map.terrain=[];sim.state.navigationRevision++;}
      if(round===4){sim.state.map.terrain=[{id:'replacement',kind:'cliff',xMm:103000,zMm:40000,widthMm:1000,depthMm:60000,elevationMm:3000}];}
    }
  });

  it('evicts disappeared sources and rebuilds every derived stamp when map identity changes',()=>{
    const sim=fixture(false);refresh(sim);const source=alive(sim)[0]!,old=cache(sim).get(source.id);
    refresh(sim);expect(cache(sim).get(source.id)).toBe(old);
    delete sim.state.entities[source.id];refresh(sim);expect(cache(sim).has(source.id)).toBe(false);expect(cache(sim).size).toBe(alive(sim).length);
    for(const faction of factions)expect(sim.state.vision[faction.id]!.visible).toEqual(referenceFog(sim,faction.id));
    const remaining=alive(sim)[0]!,before=cache(sim).get(remaining.id);sim.state.map.seed+='-identity';refresh(sim);
    expect(cache(sim).get(remaining.id)).not.toBe(before);
    for(const faction of factions)expect(sim.state.vision[faction.id]!.visible).toEqual(referenceFog(sim,faction.id));
  });

  it('merges sparse discovery exactly and keeps teammate arrays detached after noncanonical history and source removal',()=>{
    const sim=fixture(true),grid=balance.rules.fogGridM*1000,cells=Math.floor(sim.state.widthMm/grid)*Math.floor(sim.state.heightMm/grid);
    for(const faction of factions)sim.state.vision[faction.id]!.explored=[cells-1,7,3,7,0];
    const check=()=>{
      const prior=Object.fromEntries(factions.map(faction=>[faction.id,[...sim.state.vision[faction.id]!.explored]]));
      refresh(sim);
      for(const faction of factions){
        const expected=referenceFog(sim,faction.id),vision=sim.state.vision[faction.id]!;
        expect(vision.visible).toEqual(expected);
        expect(vision.explored).toEqual([...new Set([...prior[faction.id]!,...expected])].sort((a,b)=>a-b));
      }
      expect(sim.state.vision.blue!.visible).not.toBe(sim.state.vision.green!.visible);
      expect(sim.state.vision.blue!.explored).not.toBe(sim.state.vision.green!.explored);
    };
    check();
    for(const source of alive(sim)){source.xMm+=137;source.zMm+=291;}check();
    const copy=sim.capture(),restored=new Simulation(sim.options,copy);refresh(restored);
    for(const faction of factions)expect(restored.state.vision[faction.id]).toEqual(sim.state.vision[faction.id]);
    for(const source of alive(sim))delete sim.state.entities[source.id];check();
    for(const faction of factions)expect(sim.state.vision[faction.id]!.visible).toEqual([]);
  });

  it('repairs mutable public fog arrays against retained private masks, including holes and signed zero',()=>{
    const sim=fixture(true),internal=sim as unknown as VisionCommitInternals,fog=balance.rules.fogGridM*1000,size=Math.floor(sim.state.widthMm/fog)*Math.floor(sim.state.heightMm/fog);
    const scout=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!;scout.xMm=fog/2;scout.zMm=fog/2;
    const check=()=>{
      const prior=Object.fromEntries(factions.map(({id})=>[id,[...sim.state.vision[id]!.explored]]));retainedRefresh(sim);
      for(const {id}of factions){const vision=sim.state.vision[id]!,mask=internal.visibilityMasks.get(id)!;expect(vision.visible).toEqual(referenceFog(sim,id));expect(vision.explored).toEqual(referenceExplored(prior[id]!,mask));}
    };
    check();const blue=sim.state.vision.blue!,green=sim.state.vision.green!,visible=blue.visible,explored=blue.explored,greenVisible=green.visible,greenExplored=green.explored;
    check();expect(blue.visible).toBe(visible);expect(blue.explored).toBe(explored);
    const results=internal.visionKernel.computeRetained(internal.prepareVision()),owned=results.find(result=>result.key===internal.visionGroup('blue'))!,privateVisible=[...owned.visible],privateMask=owned.mask.slice();
    expect(blue.visible).not.toBe(owned.visible);expect(blue.explored).not.toBe(owned.visible);expect(blue.visible[0]).toBe(0);
    blue.visible[0]=-0;blue.explored.push(size+3,-1,1.5,NaN,7,7);
    expect(owned.visible).toEqual(privateVisible);expect(owned.mask).toEqual(privateMask);check();expect(Object.is(blue.visible[0],0)).toBe(true);
    expect(green.visible).toBe(greenVisible);expect(green.explored).toBe(greenExplored);
    delete blue.visible[1];delete blue.explored[1];check();
    blue.visible=[];blue.explored=[];check();expect(blue.explored).toEqual(blue.visible);
    blue.visible=[...blue.visible].reverse();blue.explored=[size-1,7,0,7];check();
    // Canonical explored history retains the baseline merge's signed zero; only
    // noncanonical history takes the bitmap-normalizing fallback above.
    blue.explored=[-0,...blue.explored.filter(cell=>cell!==0)];retainedRefresh(sim);
    expect(Object.is(blue.explored[0],-0)).toBe(true);expect(blue.explored.slice(1)).toEqual(referenceExplored(blue.explored,internal.visibilityMasks.get('blue')!).slice(1));
  });

  it('detaches caller-created cross-recipient and visible-explored aliases after an unchanged phase',()=>{
    const sim=fixture(true);retainedRefresh(sim);retainedRefresh(sim);
    const blue=sim.state.vision.blue!,green=sim.state.vision.green!;
    const check=()=>{
      const prior=Object.fromEntries(factions.map(({id})=>[id,[...sim.state.vision[id]!.explored]]));retainedRefresh(sim);
      const internal=sim as unknown as VisionCommitInternals;
      for(const {id}of factions){expect(sim.state.vision[id]!.visible).toEqual(referenceFog(sim,id));expect(sim.state.vision[id]!.explored).toEqual(referenceExplored(prior[id]!,internal.visibilityMasks.get(id)!));}
      const arrays=factions.flatMap(({id})=>[sim.state.vision[id]!.visible,sim.state.vision[id]!.explored]);expect(new Set(arrays).size).toBe(arrays.length);
    };
    blue.visible=green.visible;blue.explored=green.explored;check();
    blue.explored=blue.visible;green.visible=blue.visible;check();
    const shared=[...blue.visible];blue.visible=shared;green.visible=shared;blue.explored=shared;green.explored=shared;check();
    const other=[...green.visible],history=[...blue.explored];blue.visible.length=0;expect(green.visible).toEqual(other);expect(blue.explored).toEqual(history);check();
  });

  it.each([true,false])('keeps unchanged-mask static observations and hidden disappearance scalar-exact (shared=%s)',sharedVision=>{
    const sim=fixture(sharedVision),internal=sim as unknown as VisionCommitInternals,ids=factions.map(faction=>faction.id);sim.state.map.terrain=[];sim.state.navigationRevision++;
    const membership=(sim as unknown as {perceptionMembership:PerceptionMembership}).perceptionMembership;
    for(const entity of alive(sim)){entity.xMm=entity.ownerId==='blue'?30000:200000;entity.zMm=entity.ownerId==='blue'?30000:200000;}
    const observer=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!,template=alive(sim).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='red')!;
    observer.xMm=90000;observer.zMm=82000;
    const gate:Building={...structuredClone(template),id:'retained_observation_gate',ownerId:'red',typeId:'wooden_gate',xMm:90000,zMm:90000,rotation:0,hp:100,maxHp:buildings.wooden_gate.maxHp,work:100,required:100,gateMode:'AUTO',gateOpen:false,queue:[]};
    const node:Extract<Entity,{kind:'resource'}>={id:'retained_observation_node',kind:'resource',typeId:'wood_oak',ownerId:null,xMm:90550,zMm:91550,hp:1,maxHp:1,resource:'wood',amount:100000};
    sim.state.entities[gate.id]=gate;sim.state.entities[node.id]=node;
    const check=()=>{
      const prior=Object.fromEntries(ids.map(id=>[id,structuredClone(sim.state.vision[id]!.memory)]));retainedRefresh(sim);
      const sharedRosters=new Map<string,readonly Entity[]>();
      for(const id of ids){
        const expected=prior[id]!;
        for(const key of Object.keys(expected))if(!sim.state.entities[key]&&internal.visible(id,expected[key]!))delete expected[key];
        for(const entity of Object.values(sim.state.entities))if(entity.kind!=='unit'&&entity.ownerId!==id&&internal.visible(id,entity)){const memory=internal.asView(entity,false,id);memory.lastSeenTick=sim.state.tick;expected[entity.id]=memory;}
        expect(JSON.stringify(sim.state.vision[id]!.memory)).toBe(JSON.stringify(expected));
        const key=internal.visionGroup(id),roster=membership.visibleStatics(key);
        expect(roster).toEqual(Object.values(sim.state.entities).filter(entity=>entity.kind!=='unit'&&internal.visible(id,entity)));
        if(sharedRosters.has(key))expect(roster).toBe(sharedRosters.get(key));else sharedRosters.set(key,roster);
      }
    };
    check();const visible=sim.state.vision.blue!.visible,explored=sim.state.vision.blue!.explored,mask=internal.visibilityMasks.get('blue');
    if(sharedVision){
      expect(sim.state.vision.blue!.memory[node.id]).not.toBe(sim.state.vision.green!.memory[node.id]);
      sim.state.vision.blue!.actions[gate.id]={kind:'attack',startedTick:sim.state.tick,durationTicks:6};check();
      expect(sim.state.vision.blue!.memory[gate.id]!.visualAction?.kind).toBe('attack');expect(sim.state.vision.green!.memory[gate.id]!.visualAction).toBeUndefined();
      delete sim.state.vision.blue!.actions[gate.id];check();
    }
    sim.state.tick+=7;gate.hp--;gate.gateOpen=true;node.amount=42000;check();
    expect(internal.visibilityMasks.get('blue')).toBe(mask);expect(sim.state.vision.blue!.visible).toBe(visible);expect(sim.state.vision.blue!.explored).toBe(explored);
    expect(sim.state.vision.blue!.memory[gate.id]).toMatchObject({hp:99,gateOpen:true,lastSeenTick:sim.state.tick});expect(sim.state.vision.blue!.memory[node.id]!.lastSeenTick).toBe(sim.state.tick);
    if(sharedVision)expect(sim.state.vision.green!.memory[gate.id]!.lastSeenTick).toBe(sim.state.tick);
    sim.state.factions.find(faction=>faction.id==='green')!.teamId='separated';sim.state.tick++;check();
    expect(sim.state.vision.green!.visible).not.toEqual(sim.state.vision.blue!.visible);
    const greenMemory=structuredClone(sim.state.vision.green!.memory[gate.id]);sim.state.tick++;gate.ownerId='green';check();
    // Changing ownership does not rewrite an old hidden observation using live
    // private fields, and own-entity exclusion matches the previous scalar loop.
    expect(sim.state.vision.green!.memory[gate.id]).toEqual(greenMemory);
    gate.ownerId='red';observer.xMm=30000;observer.zMm=30000;sim.state.tick++;check();
    const remembered=structuredClone(sim.state.vision.blue!.memory[gate.id]),rememberedNode=structuredClone(sim.state.vision.blue!.memory[node.id]);
    sim.state.tick++;node.amount=0;gate.hp--;delete sim.state.entities[gate.id];check();
    expect(sim.state.vision.blue!.memory[gate.id]).toEqual(remembered);expect(sim.state.vision.blue!.memory[node.id]).toEqual(rememberedNode);
    observer.xMm=90000;observer.zMm=82000;sim.state.tick++;check();
    expect(sim.state.vision.blue!.memory[gate.id]).toBeUndefined();expect(sim.state.vision.blue!.memory[node.id]).toMatchObject({amount:0,lastSeenTick:sim.state.tick});
  });

  it('matches independent bitmap/scalar commits through warm asynchronous phases and cold continuation',async()=>{
    const actual=fixture(true),expected=new Simulation(actual.options,actual.capture());scalarVisionCommit(expected);
    const attach=(sim:Simulation)=>{const kernel=new VisionMaskKernel();sim.attachVisionExecutor(async frame=>kernel.computeRetained(frame));};attach(actual);
    let cold:Simulation|undefined;
    for(let tick=0;tick<48;tick++){
      for(const sim of [actual,expected,...(cold?[cold]:[])]){
        const blue=sim.state.vision.blue!,green=sim.state.vision.green!;
        if(tick===2){blue.visible.reverse();blue.explored.push(-1,NaN,1.5,999999,7,7);}
        if(tick===5){green.visible=blue.visible;green.explored=blue.explored;}
        if(tick===10)sim.state.factions.find(faction=>faction.id==='green')!.teamId='separated';
        if(tick===18){const scout=alive(sim).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!;scout.xMm+=1700;scout.zMm+=500;}
        if(tick===30){delete blue.visible[0];delete blue.explored[0];}
        if(tick===36)sim.state.factions.find(faction=>faction.id==='green')!.teamId='allies';
      }
      await actual.stepAsync();expected.step();if(cold)await cold.stepAsync();
      expect(JSON.stringify(actual.capture())).toBe(JSON.stringify(expected.capture()));
      for(const {id}of factions)expect(JSON.stringify(actual.view(id))).toBe(JSON.stringify(expected.view(id)));
      if(cold){expect(JSON.stringify(cold.capture())).toBe(JSON.stringify(expected.capture()));for(const {id}of factions)expect(JSON.stringify(cold.view(id))).toBe(JSON.stringify(expected.view(id)));}
      if(tick===23){cold=new Simulation(actual.options,actual.capture());expect(cache(cold).size).toBe(0);attach(cold);expect(cold.capture()).toEqual(actual.capture());}
    }
  },60000);

  it('reconciles a shared resource payload once while retaining independent mutable observations',()=>{
    const sim=fixture(true),internal=sim as unknown as VisionCommitInternals;
    const node=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource'&&internal.visible('blue',entity))!;
    expect(internal.visible('green',node)).toBe(true);retainedRefresh(sim);
    let amount=node.amount,reads=0;Object.defineProperty(node,'amount',{configurable:true,enumerable:true,get(){reads++;return amount;},set(value:number){amount=value;}});
    try{
      sim.state.tick++;retainedRefresh(sim);expect(reads).toBe(1);
      const blue=sim.state.vision.blue!.memory[node.id]!,green=sim.state.vision.green!.memory[node.id]!;
      expect(blue).not.toBe(green);expect(blue.lastSeenTick).toBe(sim.state.tick);expect(green.lastSeenTick).toBe(sim.state.tick);
      if(blue.forest)expect(blue.forest).not.toBe(green.forest);
      green.amount=-1;green.hp=-1;if(green.forest)green.forest.patchId='edited-observation';
      sim.state.vision.green!.actions[node.id]={kind:'idle',startedTick:sim.state.tick,durationTicks:1};
      sim.state.tick++;retainedRefresh(sim);
      expect(sim.state.vision.blue!.memory[node.id]).toBe(blue);
      const expected=internal.asView(node,false,'green');expected.lastSeenTick=sim.state.tick;
      expect(JSON.stringify(sim.state.vision.green!.memory[node.id])).toBe(JSON.stringify(expected));
      expect(blue.visualAction).toBeUndefined();
      amount=0;node.xMm+=101;node.hp=0;sim.state.tick++;retainedRefresh(sim);
      for(const id of ['blue','green'])expect(sim.state.vision[id]!.memory[node.id]).toMatchObject({amount:0,hp:0,xMm:node.xMm,lastSeenTick:sim.state.tick});
    }finally{Object.defineProperty(node,'amount',{configurable:true,enumerable:true,writable:true,value:amount});}
  });

  it.each(['instance','prototype'] as const)('keeps custom %s static-memory hooks on scalar reads',scope=>{
    const sim=fixture(true),internal=sim as unknown as VisionCommitInternals&{refreshStaticMemory(entity:Entity,playerId:string):ViewEntity};
    const node=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource'&&internal.visible('blue',entity))!;
    retainedRefresh(sim);const holder=scope==='instance'?internal:Simulation.prototype as unknown as typeof internal,original=holder.refreshStaticMemory;
    holder.refreshStaticMemory=function(entity,playerId){const observation=original.call(this,entity,playerId);if(entity===node&&playerId==='blue')node.amount=0;return observation;};
    try{
      const before=Math.floor(node.amount/balance.rules.resourceScale);expect(before).toBeGreaterThan(0);sim.state.tick++;retainedRefresh(sim);
      expect(sim.state.vision.blue!.memory[node.id]!.amount).toBe(before);expect(sim.state.vision.green!.memory[node.id]!.amount).toBe(0);
    }finally{if(scope==='instance')delete (internal as unknown as Record<string,unknown>).refreshStaticMemory;else holder.refreshStaticMemory=original;}
  });

  it('reconciles extra mutable forest fields without treating equal core fields as equal payloads',()=>{
    const sim=fixture(true),internal=sim as unknown as VisionCommitInternals;
    const node=Object.values(sim.state.entities).find((entity):entity is Extract<Entity,{kind:'resource'}>=>entity.kind==='resource'&&Boolean(entity.forest)&&internal.visible('blue',entity))!;
    expect(node).toBeDefined();retainedRefresh(sim);
    Object.assign(sim.state.vision.green!.memory[node.id]!.forest!,{extra:'stale'});sim.state.tick++;retainedRefresh(sim);
    expect(sim.state.vision.green!.memory[node.id]!.forest).toEqual(node.forest);
    Object.assign(node.forest!,{extra:'source'});sim.state.tick++;retainedRefresh(sim);
    expect(sim.state.vision.blue!.memory[node.id]!.forest).toEqual(node.forest);expect(sim.state.vision.green!.memory[node.id]!.forest).toEqual(node.forest);
    expect(sim.state.vision.blue!.memory[node.id]!.forest).not.toBe(sim.state.vision.green!.memory[node.id]!.forest);
  });

  it('enumerates high bits and a partial final fog word exactly through source movement, removal and cold restoration',()=>{
    const sim=fixture(true),cellMm=balance.rules.fogGridM*1000,template=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='scout')!;
    sim.state.widthMm=9*cellMm;sim.state.heightMm=7*cellMm;sim.state.map.terrain=[];sim.state.navigationRevision++;sim.state.entities={};
    for(const ownerId of ['blue','green']){const source:Unit={...structuredClone(template),id:`word_source_${ownerId}`,ownerId,xMm:9*cellMm/2,zMm:7*cellMm/2,orders:[],path:[]};sim.state.entities[source.id]=source;}
    for(const faction of factions)sim.state.vision[faction.id]={visible:[],explored:[62,31,31,0],memory:{},actions:{}};
    const check=(subject:Simulation)=>{
      const prior=Object.fromEntries(factions.map(faction=>[faction.id,[...subject.state.vision[faction.id]!.explored]]));refresh(subject);
      for(const faction of factions){const expected=referenceFog(subject,faction.id),vision=subject.state.vision[faction.id]!;expect(vision.visible).toEqual(expected);expect(vision.visible.every(cell=>cell>=0&&cell<63)).toBe(true);expect(vision.explored).toEqual([...new Set([...prior[faction.id]!,...expected])].sort((a,b)=>a-b));}
      expect(subject.state.vision.blue!.visible).not.toBe(subject.state.vision.green!.visible);expect(subject.state.vision.blue!.explored).not.toBe(subject.state.vision.green!.explored);
    };
    check(sim);expect(sim.state.vision.blue!.visible).toEqual(Array.from({length:63},(_,index)=>index));expect(sim.state.vision.blue!.visible).toEqual(expect.arrayContaining([0,31,32,62]));expect(sim.state.vision.red!.visible).toEqual([]);
    const restored=new Simulation(sim.options,sim.capture());expect(cache(restored).size).toBe(0);check(restored);expect(restored.capture()).toEqual(sim.capture());
    const views=restored.views(['blue','green']),before=restored.capture();views[0]!.fog.visible.length=0;views[0]!.fog.explored.push(999999);expect(restored.capture()).toEqual(before);expect(views[1]!.fog.visible).toHaveLength(63);
    for(const subject of [sim,restored]){for(const source of alive(subject)){source.xMm=cellMm;source.zMm=cellMm/2;}check(subject);expect(subject.state.vision.blue!.visible).not.toContain(62);}
    expect(restored.capture()).toEqual(sim.capture());
    for(const subject of [sim,restored]){for(const source of alive(subject))delete subject.state.entities[source.id];check(subject);for(const faction of factions)expect(subject.state.vision[faction.id]!.visible).toEqual([]);}
    expect(restored.capture()).toEqual(sim.capture());
  });

  it('keeps separated fog rows exact when sight moves and the same source changes recipient group',()=>{
    const sim=fixture(true),template=alive(sim).find((entity):entity is Unit=>entity.kind==='unit')!;
    sim.state.widthMm=140000;sim.state.heightMm=18000;sim.state.map.terrain=[];sim.state.navigationRevision++;sim.state.entities={};
    const source:Unit={...structuredClone(template),id:'sparse_row_source',ownerId:'blue',typeId:'militia',hp:units.militia.maxHp,maxHp:units.militia.maxHp,xMm:63000,zMm:9000,orders:[],path:[]};sim.state.entities[source.id]=source;
    for(const faction of factions)sim.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};
    const check=()=>{
      const prior=Object.fromEntries(factions.map(faction=>[faction.id,[...sim.state.vision[faction.id]!.explored]]));refresh(sim);
      for(const faction of factions){const expected=referenceFog(sim,faction.id),view=sim.view(faction.id);expect(view.fog.visible).toEqual(expected);expect(view.fog.explored).toEqual([...new Set([...prior[faction.id]!,...expected])].sort((a,b)=>a-b));}
    };
    check();const first=[...sim.view('blue').fog.visible];
    expect(first).toEqual(expect.arrayContaining([31,32]));expect(first.some((cell,index)=>index>0&&cell-first[index-1]!>32)).toBe(true);
    expect(sim.view('green').fog.visible).toEqual(first);expect(sim.view('red').fog.visible).toEqual([]);
    source.xMm+=137;source.zMm-=291;check();expect(sim.view('blue').fog.visible).not.toEqual(first);
    sim.state.map.terrain=[{id:'sparse_row_cliff',kind:'cliff',xMm:65000,zMm:0,widthMm:2000,depthMm:18000,elevationMm:3000}];sim.state.navigationRevision++;
    const beforeCliff=sim.view('blue').fog.visible.length;check();expect(sim.view('blue').fog.visible.length).toBeLessThan(beforeCliff);
    const observed=[...sim.view('blue').fog.visible];source.ownerId='red';check();
    expect(sim.view('red').fog.visible).toEqual(observed);expect(sim.view('blue').fog.visible).toEqual([]);expect(sim.view('green').fog.visible).toEqual([]);
    expect(sim.view('blue').fog.explored).toEqual(expect.arrayContaining(observed));
  });

  it('keeps returned snapshots isolated while stationary observed actions are reused internally',()=>{
    const sim=fixture(false);sim.step(2);const before=sim.capture(),expected=sim.view('blue'),snapshot=sim.view('blue');
    const worker=snapshot.entities.find(entity=>entity.ownerId==='blue'&&entity.typeId==='villager')!;
    expect(worker.visualAction).toBeDefined();worker.visualAction!.startedTick=99999;worker.cargo!.amount=999;worker.xMm=0;
    snapshot.self.resources.food=999;snapshot.self.technologies!.push('forestry_1');snapshot.players[0]!.name='changed';snapshot.fog.visible.length=0;snapshot.fog.explored.push(999999);
    snapshot.map.terrain!.push({id:'fake',kind:'water',xMm:0,zMm:0,widthMm:1000,depthMm:1000,elevationMm:0});
    expect(sim.capture()).toEqual(before);expect(sim.view('blue')).toEqual(expected);
    sim.step();expect(sim.view('blue').entities.find(entity=>entity.id===worker.id)!.visualAction!.startedTick).toBeLessThan(99999);
  });

  it('rebuilds only derived caches on restore and resumes exact authorized views and state',()=>{
    const sim=fixture(true),worker=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='blue'&&entity.typeId==='scout')!;
    const receipt=sim.command('blue',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:1,clientCommandId:'move',clientSequence:1,command:{kind:'move',unitIds:[worker.id],queued:false,target:{xMm:worker.xMm+6000,zMm:worker.zMm+4000}}});expect(receipt.status).toBe('accepted');sim.step(3);
    const identity={engineBuildHash:'8'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}},restored=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});
    expect(cache(restored).size).toBe(0);expect(restored.capture()).toEqual(sim.capture());
    for(let tick=0;tick<5;tick++){
      for(const faction of factions)expect(restored.view(faction.id)).toEqual(sim.view(faction.id));
      sim.step();restored.step();expect(restored.capture()).toEqual(sim.capture());
    }
  });
});
