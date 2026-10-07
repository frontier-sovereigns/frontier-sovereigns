import { afterEach, expect, it, vi } from 'vitest';
import { ArcRotateCamera, Color3, Matrix, Mesh, NullEngine, PickingInfo, Ray, Scene, StandardMaterial, TransformNode, Vector3, Viewport } from '@babylonjs/core';
import { balance, buildings, contentHash, resolveRuleset, type AgeId, type Cell, type PlayerView, type ViewEntity } from '@frontier/shared';
import { World, cameraPanDirections, configureRtsCameraControls, type WorldTarget } from './World';
import { ArcRotateCameraPointersInput } from '@babylonjs/core/Cameras/Inputs/arcRotateCameraPointersInput';
import { createAssetLibrary, generateUnitAssets, generateBuildingAssets, generateEnvironmentAssets, posedAssetPoint, sampleAssetPose } from '@frontier/assets';
import { AssetRenderer, type AssetInstance } from './AssetRenderer';
import { MotionTrack } from './MotionTrack';
import { replayPlaybackStep, replayViewCompatible } from './ReplayPanel';
import { defaultPreferences } from './preferences';
const library = createAssetLibrary(), bundle = library.finish([...generateUnitAssets(library), ...generateBuildingAssets(library), ...generateEnvironmentAssets(library)]);

const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });
function harness(assetBundle = bundle) {
  const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
  // Only platform initialization is replaced. All object creation, filtered snapshot
  // updates, selection, fog, and upgrade code execute through the production World.
  const world = Object.create(World.prototype) as World;
  const internals = { assets: new AssetRenderer(scene, assetBundle), engine, scene, camera: new ArcRotateCamera('test-camera', 0, 0.8, 45, Vector3.Zero(), scene), preview: new TransformNode('preview', scene), materials: new Map(), shadows: { addShadowCaster() {} }, rendered: new Map<string, { root: TransformNode; ring: { isEnabled(): boolean }; healthFill: { scaling: Vector3 } }>(), selected: [] as string[], view: null, lastFog: '', projectiles: new Map(), projectilePool: [], effects: new Map(), seenEffects: new Set(), pingMeshes: new Map<string, TransformNode>(), wallPreview: [] as Mesh[], keys: new Set<string>(), preferences: defaultPreferences(), onSelection() {}, onPlacementHint() {} };
  Object.assign(world, internals); return { world, internals, scene };
}
function view(entities: ViewEntity[]): PlayerView { return { protocolVersion: 2, contentHash: 'isolated-render-fixture', matchId: 'render-fixture', matchEpoch: 1, tick: 0, sequence: 0, playerId: 'me', status: 'RUNNING', map: { widthMm: 40000, heightMm: 40000, fogCellMm: 4000 }, self: { lastCommandSequence: 0, resources: { food: 0, wood: 0, gold: 0, stone: 0 }, age: 1, population: 1, populationCap: 15, populationLimit: 120, reservedPopulation: 0 }, players: [{ id: 'me', name: 'Mine', teamId: 'one', kind: 'human', color: '#8ac6bd', age: 1 }, { id: 'enemy', name: 'Other', teamId: 'two', kind: 'human', color: '#cd9376', age: 1 }], entities, fog: { visible: Array.from({ length: 100 }, (_, i) => i), explored: Array.from({ length: 100 }, (_, i) => i) } }; }
const entity = (typeId: string, kind: 'building' | 'unit', id = typeId): ViewEntity => ({ id, kind, typeId, ownerId: 'me', xMm: 16000, zMm: 16000, hp: 30, maxHp: 100, progress: 1, visualAge: 1, visualTier: 'base' });

it('keeps static resource drawing and picking while removing display-frame pose copies', () => {
  const {world, internals} = harness();
  const resources = ['tree_oak', 'tree_pine', 'tree_round_canopy', 'forage_patch', 'gold_deposit', 'stone_quarry'].map((typeId, index): ViewEntity => ({id: typeId, typeId, kind: 'resource', ownerId: null, xMm: 10000 + index * 4000, zMm: 16000, hp: 1, maxHp: 1, resource: typeId.startsWith('tree') ? 'wood' : typeId === 'forage_patch' ? 'food' : typeId === 'gold_deposit' ? 'gold' : 'stone', amount: 250}));
  const snapshot = view([...resources, {...entity('villager', 'unit'), xMm: 32000, zMm: 28000}]);
  const display = world as unknown as {animateEntities(now: number, coarse: boolean, presentationMs: number): void};
  world.setView(snapshot); world.setStreamActive(true);
  const entries = resources.map(resource => internals.rendered.get(resource.id)!);
  const assets = entries.map(entry => internals.assets.instances.get(entry.root)!);
  // Natural meshes have gaps between leaves/berries/ore; a center ray need not
  // hit. Find a real surface first, then preserve that exact picking result.
  const rays = resources.map((resource, index) => [-1.5, -1, -.5, 0, .5, 1, 1.5].flatMap(x => [-1.5, -1, -.5, 0, .5, 1, 1.5].map(z => new Ray(new Vector3(resource.xMm / 1000 + x, 12, resource.zMm / 1000 + z), new Vector3(0, -1, 0)))).find(ray => internals.assets.pickDistance(assets[index]!, ray) !== null));
  resources.forEach((resource, index) => expect(rays[index], `${resource.typeId} has a pickable surface`).toBeDefined());
  const hits = assets.map((asset, index) => internals.assets.pickDistance(asset, rays[index]!));
  const draw = () => {internals.assets.render(new Vector3(20, 30, 20)); const {instances, batches, visibleParts, triangles} = internals.assets.metrics; return {instances, batches, visibleParts, triangles};};
  const drawn = draw(); expect(drawn.visibleParts).toBeGreaterThan(0);
  const appearance = assets.map(asset => asset.appearance), context = assets.map(asset => asset.context);
  const update = vi.spyOn(internals.assets, 'update');
  for (let frame = 0; frame < 10; frame++) display.animateEntities(performance.now() + frame * 16, false, 0);
  // All six resource types formerly incurred one pose/context update per frame:
  // 60 redundant calls eliminated, while ten live-unit updates still execute.
  expect(update).toHaveBeenCalledTimes(10);
  expect(update.mock.calls.every(([asset]) => asset.asset.id === 'villager')).toBe(true);
  expect(draw()).toEqual(drawn);
  assets.forEach((asset, index) => {expect(asset.appearance).toBe(appearance[index]); expect(asset.context).toBe(context[index]); expect(internals.assets.pickDistance(asset, rays[index]!)).toBe(hits[index]);});
  world.select([resources[0]!.id]); expect(entries[0]!.ring.isEnabled()).toBe(true);
  world.setView({...snapshot, tick: 6, entities: snapshot.entities.map(item => item.id === 'tree_oak' ? {...item, ghost: true, lastSeenTick: 0} : item)});
  expect(assets[0]!.appearance.ghost).toBe(true);
  update.mockClear(); for (let frame = 0; frame < 10; frame++) display.animateEntities(performance.now() + frame * 16, false, 0);
  expect(update.mock.calls.some(([asset]) => asset.asset.id.startsWith('tree'))).toBe(false);
  // A committed authorized depletion removes art immediately; no stale static
  // frame cache can retain it. Unobserved depletion is not inferred in a ghost.
  world.setView({...snapshot, tick: 12, entities: snapshot.entities.map(item => item.id === 'tree_oak' ? {...item, amount: 0} : item)});
  expect(internals.rendered.has('tree_oak')).toBe(false); expect(entries[0]!.root.isDisposed()).toBe(true);
  expect(internals.assets.instances.has(entries[0]!.root)).toBe(false);
  world.setView({...snapshot, tick: 18, entities: [], fog: {visible: [], explored: snapshot.fog.explored}});
  expect(internals.rendered.size).toBe(0); expect(entries.every(entry => entry.root.isDisposed())).toBe(true);
});

it('continues display-frame animation if a resource asset contains an animated track', () => {
  const base = bundle.assets.forage_patch!, nodeId = base.variants[0]!.nodes[1]!.id;
  const animated = {...base, clips: [{id: 'idle', durationSeconds: 1, loop: true, tracks: [{nodeId, property: 'position' as const, times: [0, 1], values: [[0, 0, 0], [0, 1, 0]] as [number, number, number][]}]}]};
  const {world, internals} = harness({...bundle, assets: {...bundle.assets, forage_patch: animated}});
  world.setView(view([{id: 'forage', typeId: 'forage_patch', kind: 'resource', ownerId: null, xMm: 16000, zMm: 16000, hp: 1, maxHp: 1, resource: 'food', amount: 100}]));
  const update = vi.spyOn(internals.assets, 'update');
  (world as unknown as {animateEntities(now: number, coarse: boolean, presentationMs: number): void}).animateEntities(performance.now(), false, 0);
  expect(update).toHaveBeenCalledTimes(1); expect(update.mock.calls[0]![0].asset.id).toBe('forage_patch');
});

it.each(Object.values(buildings).filter(building=>building.minAge>=5).map(building=>[building.id,building.minAge] as const))('keeps selected %s roofs opaque and pickable at age %s', (typeId,age)=>{
  const {world,internals,scene}=harness(),building={...entity(typeId,'building'),hp:100,visualAge:age as AgeId},snapshot=view([building]);
  world.setView(snapshot);const entry=internals.rendered.get(building.id)!,asset=internals.assets.instances.get(entry.root)!;
  const ray=new Ray(new Vector3(16,asset.asset.bounds.max[1]+3,16),new Vector3(0,-1,0));
  const draw=()=>{internals.assets.render(world.camera.position);return scene.meshes.filter(mesh=>mesh.name.startsWith('batch-')&&mesh.isEnabled()&&(mesh as Mesh).thinInstanceCount>0).map(mesh=>({name:mesh.material!.name,alpha:(mesh.material as StandardMaterial).alpha,count:(mesh as Mesh).thinInstanceCount})).sort((a,b)=>a.name.localeCompare(b.name));};
  const before=draw(),hit=internals.assets.pickDistance(asset,ray);
  expect(before.length).toBeGreaterThan(0);expect(before.filter(material=>material.name.startsWith('art-fs_team:')).every(material=>material.alpha===1)).toBe(true);expect(hit).not.toBeNull();
  world.select([building.id]);
  expect(entry.ring.isEnabled()).toBe(true);expect(asset.appearance.roofFade).toBe(false);expect(draw()).toEqual(before);expect(internals.assets.pickDistance(asset,ray)).toBe(hit);
  // The following authoritative view retains the same
  // stable root, batched materials and visible roof instead of a cutaway.
  world.setView({...snapshot,tick:6});expect(internals.rendered.get(building.id)!.root).toBe(entry.root);expect(draw()).toEqual(before);
  world.select([]);expect(entry.ring.isEnabled()).toBe(false);expect(draw()).toEqual(before);
});
it('restores an opaque tall roof when selecting its building after a nearby ground unit',()=>{
  const {world,internals}=harness(),building={...entity('grand_citadel','building'),hp:100,visualAge:5 as const},worker={...entity('villager','unit'),xMm:28000},snapshot=view([building,worker]);
  world.setView(snapshot);const asset=internals.assets.instances.get(internals.rendered.get(building.id)!.root)!;
  world.select([worker.id]);expect(asset.appearance.roofFade).toBe(true);
  world.select([building.id]);expect(asset.appearance.roofFade).toBe(false);
  world.select([worker.id]);expect(asset.appearance.roofFade).toBe(true);
  world.select([]);expect(asset.appearance.roofFade).toBe(false);
  world.select([worker.id]);world.setView({...snapshot,tick:6,entities:[building,{...worker,garrisonedIn:building.id}]});expect(asset.appearance.roofFade).toBe(false);
});
it('replay compatibility follows the recorded eight-age identity and still accepts supported four-age saves',()=>{
  const snapshot=view([]);snapshot.contentHash=contentHash;expect(replayViewCompatible(snapshot)).toBe(true);
  const current=resolveRuleset('legendary_ages_v1',8,'long_war');Object.assign(snapshot,{rulesetId:current.rulesetId,maxAge:current.maxAge,startingResourcePreset:current.startingResourcePreset,contentHash:current.contentHash});expect(replayViewCompatible(snapshot)).toBe(true);
  snapshot.contentHash=contentHash;expect(replayViewCompatible(snapshot)).toBe(false);
});
it('renders observed Crown turret recoil from its first secondary cooldown without replacing movement',()=>{
  const {world,internals}=harness(),carrier={...entity('crown_colossus','unit'),visualAge:8 as const,weaponCooldowns:[0]},snapshot=view([carrier]);world.setView(snapshot);
  const firing={...carrier,weaponCooldowns:[80],visualAction:{kind:'attack' as const,startedTick:10,durationTicks:80}};world.setView({...snapshot,tick:10,entities:[firing]});
  const rendered=internals.rendered.get(carrier.id)! as unknown as {asset:AssetInstance};expect(rendered.asset.clip).toBe('turret');
  world.setView({...snapshot,tick:11,entities:[{...firing,weaponCooldowns:[79],visualAction:{kind:'move',startedTick:11}}]});expect(rendered.asset.clip).toBe('move');
});

it.each([0,Math.PI/2,Math.PI,-Math.PI/2])('faces the catapult away from its loaded stone for movement and a different attack bearing (%s)',heading=>{
  const {world,internals}=harness(),catapult=entity('catapult','unit'),snapshot=view([catapult]);
  world.setView(snapshot);
  const direction=new Vector3(Math.sin(heading),0,Math.cos(heading));
  const moved={...catapult,xMm:catapult.xMm+Math.round(direction.x*1000),zMm:catapult.zMm+Math.round(direction.z*1000),visualAction:{kind:'move' as const,startedTick:2}};
  world.setView({...snapshot,tick:2,entities:[moved]});
  const entry=internals.rendered.get(catapult.id)! as unknown as {root:TransformNode;asset:AssetInstance};
  const cupOffset=()=>{
    const asset=entry.asset.asset!,variant=entry.asset.variant,poses=sampleAssetPose(asset,variant,entry.asset.clip,entry.asset.seconds,{lod:0,action:entry.asset.clip as 'move'|'attack'});
    return Vector3.TransformNormal(Vector3.FromArray(posedAssetPoint([0,0,0],'ammunition',variant,poses)),entry.root.computeWorldMatrix(true));
  };
  expect(entry.asset.clip).toBe('move');expect(Vector3.Dot(cupOffset(),direction)).toBeLessThan(-1);
  // The authorized attack bearing is independent of the preceding travel path.
  const aim=heading+Math.PI/2,shotDirection=new Vector3(Math.sin(aim),0,Math.cos(aim)),shot={id:'catapult-shot',kind:'stone' as const,xMm:moved.xMm+Math.round(shotDirection.x*600),zMm:moved.zMm+Math.round(shotDirection.z*600),yMm:2100};
  world.setView({...snapshot,tick:4,entities:[{...moved,visualAction:{kind:'attack',startedTick:4,durationTicks:20,facingMilliRad:Math.round(aim*1000)}}],projectiles:[shot]});
  expect(entry.asset.clip).toBe('attack');expect(Vector3.Dot(cupOffset(),shotDirection)).toBeLessThan(-1);
  const renderedShot=internals.projectiles.get(shot.id).mesh as TransformNode,shotOffset=renderedShot.position.subtract(new Vector3(moved.xMm/1000,renderedShot.position.y,moved.zMm/1000));
  expect(Vector3.Dot(cupOffset(),shotOffset)).toBeLessThan(0);
});

it('replay playback advances complete 300ms frames instead of repeatedly requesting an uncommitted tick',()=>{
  const startTick=900,endTick=948,tickMs=1000/balance.rules.simulationHz,frameTicks=300/tickMs;
  let cursor=startTick,elapsedMs=0;
  for(let request=0;request<8;request++){
    const next=replayPlaybackStep(cursor,endTick,300);
    // ReplayRunner seeks only committed frames, except the terminal frame.
    const returned=next.targetTick===endTick?endTick:startTick+Math.floor((next.targetTick-startTick)/frameTicks)*frameTicks;
    expect(returned).toBeGreaterThan(cursor);expect(next.intervalMs).toBe(300);
    elapsedMs+=next.intervalMs;cursor=returned;
  }
  expect(cursor).toBe(endTick);expect(elapsedMs).toBe((endTick-startTick)*tickMs);
});
it('replay playback uses the current profile and clamps its pacing to a short terminal frame',()=>{
  expect(replayPlaybackStep(900,948,50)).toEqual({targetTick:902,intervalMs:100});
  expect(replayPlaybackStep(900,948)).toEqual({targetTick:902,intervalMs:100});
  expect(replayPlaybackStep(900,948,300)).toEqual({targetTick:906,intervalMs:300});
  expect(replayPlaybackStep(900,948,450)).toEqual({targetTick:909,intervalMs:450});
  expect(replayPlaybackStep(900,948,600)).toEqual({targetTick:912,intervalMs:600});
  expect(replayPlaybackStep(0,100,50)).toEqual({targetTick:2,intervalMs:100});
  expect(replayPlaybackStep(942,945,300)).toEqual({targetTick:945,intervalMs:150});
  expect(replayPlaybackStep(942,945,600)).toEqual({targetTick:945,intervalMs:150});
  expect(replayPlaybackStep(944,945,50)).toEqual({targetTick:945,intervalMs:50});
  expect(replayPlaybackStep(945,945,300)).toEqual({targetTick:945,intervalMs:0});
});

it.each([100,150,200] as const)('applies %sms publication buffering to rendered movers/projectiles while selection, health and camera remain immediate',interval=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),unit=entity('villager','unit'),snapshot={...view([unit]),publicationIntervalMs:interval};
  try{
    for(const [tick,received,xMm] of [[0,1000,16000],[4,1200,18000],[8,1400,20000]]){clock.mockReturnValue(received!);world.setView({...snapshot,tick:tick!,entities:[{...unit,xMm:xMm!,hp:tick===8?10:30}],projectiles:[{id:'shot',kind:'arrow',xMm:xMm!,yMm:2000,zMm:16000}]});}
    const entry=internals.rendered.get(unit.id)! as unknown as {motion:MotionTrack;root:TransformNode;ring:Mesh;healthFill:{scaling:Vector3}},projectile=internals.projectiles.get('shot') as {motion:MotionTrack};
    expect(entry.motion.delayMs).toBe(interval===100?125:interval);expect(projectile.motion.delayMs).toBe(entry.motion.delayMs);expect(entry.motion.sample(1400).x).toBeCloseTo(20-entry.motion.delayMs/100);expect(projectile.motion.sample(1400).x).toBeCloseTo(20-entry.motion.delayMs/100);
    expect(entry.healthFill.scaling.x).toBe(.1);world.select([unit.id]);expect(entry.ring.isEnabled()).toBe(true);world.focus(22000,24000);expect(world.camera.target.x).toBe(22);expect(world.camera.target.z).toBe(24);
    world.setView({...snapshot,tick:9,publicationIntervalMs:undefined,entities:[unit],projectiles:[{id:'shot',kind:'arrow',xMm:16000,yMm:2000,zMm:16000}]},true);expect(entry.motion.delayMs).toBe(125);expect(entry.motion.sample(5000)).toMatchObject({x:16,y:0,z:16});expect(projectile.motion.delayMs).toBe(125);
  }finally{clock.mockRestore();}
});
it('removes concealed and dead draws immediately at reduced publication cadence without buffering fog or health',()=>{
  const {world,internals}=harness(),unit={...entity('militia','unit','enemy_unit'),ownerId:'enemy'},snapshot={...view([unit]),publicationIntervalMs:200 as const,projectiles:[{id:'shot',kind:'arrow' as const,xMm:16000,yMm:2000,zMm:16000}]};
  world.setView(snapshot);const root=internals.rendered.get(unit.id)!.root,projectile=internals.projectiles.get('shot').mesh as TransformNode;
  world.setView({...snapshot,tick:1,entities:[],projectiles:[],fog:{visible:[],explored:snapshot.fog.explored}});expect(root.isDisposed()).toBe(true);expect(internals.rendered.has(unit.id)).toBe(false);expect(projectile.isEnabled()).toBe(false);expect(internals.projectiles.size).toBe(0);
});

it('uses certified 300ms turns and one continuous animation clock, clearing all traces on concealment',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000);
  const unit={...entity('villager','unit'),visualAction:{kind:'move' as const,startedTick:0}},base={...view([unit]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  const playback=world as unknown as {visualTick(now:number):number;animate(entry:unknown,now:number):void};
  try{
    world.setView(base);world.setStreamActive(true);
    const points=[{tick:0,xMm:16000,zMm:16000},{tick:2,xMm:17000,zMm:16000},{tick:4,xMm:17000,zMm:17000},{tick:6,xMm:17000,zMm:17000}];
    clock.mockReturnValue(1300);world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[{...unit,xMm:17000,zMm:17000,motionTrace:{complete:true,points}}],projectiles:[{id:'shot',kind:'stone',xMm:17000,yMm:2000,zMm:17000,motionTrace:{complete:true,points:points.map((point,index)=>({...point,yMm:[2000,3000,2500,2000][index]!}))}}]});
    const entry=internals.rendered.get(unit.id)! as unknown as {motion:MotionTrack;root:TransformNode;asset:{seconds:number;clip:string}},shot=internals.projectiles.get('shot') as {motion:MotionTrack;mesh:TransformNode};
    expect(entry.motion.delayMs).toBe(350);expect(entry.motion.sampleAt(150)).toEqual({x:17,y:0,z:16.5});expect(shot.motion.sampleAt(150)).toEqual({x:17,y:2.75,z:16.5});
    clock.mockReturnValue(1600);world.setView({...base,tick:12,committedTimeMs:600,frameRevision:2,entities:[{...unit,xMm:20000,zMm:17000,visualAction:{kind:'idle',startedTick:10},motionTrace:{complete:true,points:[{tick:6,xMm:17000,zMm:17000},{tick:10,xMm:20000,zMm:17000},{tick:12,xMm:20000,zMm:17000}]}}]});
    playback.animate(entry,1600);expect(entry.asset.seconds).toBeCloseTo(.25);expect(entry.asset.clip).toBe('move');
    playback.animate(entry,1700);expect(entry.asset.seconds).toBeCloseTo(.35);
    playback.animate(entry,1800);expect(entry.asset.seconds).toBeCloseTo(.45);expect(playback.visualTick(1800)).toBe(9);
    playback.animate(entry,1850);expect(entry.asset.clip).toBe('idle');expect(entry.asset.seconds).toBe(0);
    world.setView({...base,tick:18,committedTimeMs:900,frameRevision:3,entities:[],fog:{visible:[],explored:base.fog.explored}});
    expect(entry.root.isDisposed()).toBe(true);expect(internals.rendered.size).toBe(0);expect(internals.projectiles.size).toBe(0);
  }finally{clock.mockRestore();}
});

it('coarse snapshots without trace coverage hold instead of cutting across an unreported route',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),unit=entity('militia','unit');
  const base={...view([unit]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const};
  try{
    world.setView(base);clock.mockReturnValue(1300);world.setView({...base,tick:6,entities:[{...unit,xMm:22000,zMm:22000}]});
    const entry=internals.rendered.get(unit.id)! as unknown as {motion:MotionTrack};
    expect(entry.motion.sampleAt(150)).toEqual({x:16,y:0,z:16});expect(entry.motion.sampleAt(300)).toEqual({x:22,y:0,z:22});
    world.setView({...base,tick:0},true);expect(entry.motion.sampleAt(150)).toEqual({x:16,y:0,z:16});
  }finally{clock.mockRestore();}
});

it.each([450,600] as const)('presents certified %sms movement turns and projectile heights without inventing a route',interval=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),unit={...entity('villager','unit'),visualAction:{kind:'move' as const,startedTick:0}},ticks=interval/(1000/balance.rules.simulationHz);
  const base={...view([unit]),authoritativeIntervalMs:interval,publicationIntervalMs:interval,committedTimeMs:0,frameRevision:0};
  try{
    world.setView(base);world.setStreamActive(true);
    const points=[{tick:0,xMm:16000,zMm:16000},{tick:ticks/3,xMm:19000,zMm:16000},{tick:2*ticks/3,xMm:19000,zMm:19000},{tick:ticks,xMm:22000,zMm:19000}];
    clock.mockReturnValue(1000+interval);world.setView({...base,tick:ticks,committedTimeMs:interval,frameRevision:1,entities:[{...unit,xMm:22000,zMm:19000,motionTrace:{complete:true,points}}],projectiles:[{id:'shot',kind:'stone',xMm:22000,yMm:2000,zMm:19000,motionTrace:{complete:true,points:points.map((point,index)=>({...point,yMm:[2000,4000,3000,2000][index]!}))}}]});
    const entry=internals.rendered.get(unit.id)! as unknown as {motion:MotionTrack;root:TransformNode},shot=internals.projectiles.get('shot') as {motion:MotionTrack;mesh:TransformNode};
    expect(entry.motion.delayMs).toBe(interval+50);expect(shot.motion.delayMs).toBe(interval+50);
    expect(entry.motion.sampleAt(interval/6)).toEqual({x:17.5,y:0,z:16});expect(shot.motion.sampleAt(interval/6)).toEqual({x:17.5,y:3,z:16});
    expect(entry.motion.sampleAt(interval/2)).toEqual({x:19,y:0,z:17.5});expect(shot.motion.sampleAt(interval/2)).toEqual({x:19,y:3.5,z:17.5});
    clock.mockReturnValue(1000+interval+50+interval/6);expect(world.presentationTimeMs()).toBe(interval/6);
    clock.mockReturnValue(1000+2*interval);world.setView({...base,tick:2*ticks,committedTimeMs:2*interval,frameRevision:2,entities:[{...unit,xMm:26000,zMm:23000}]});
    expect(entry.motion.sampleAt(interval*1.5)).toEqual({x:22,y:0,z:19});expect(entry.motion.sampleAt(2*interval)).toEqual({x:26,y:0,z:23});
    expect(shot.mesh.isEnabled()).toBe(false);world.setView({...base,tick:3*ticks,committedTimeMs:3*interval,frameRevision:3,entities:[],fog:{visible:[],explored:base.fog.explored}});
    expect(entry.root.isDisposed()).toBe(true);expect(internals.rendered.size).toBe(0);
  }finally{clock.mockRestore();}
});

it.each([.9,.1])('scales live animation and effects at speed %s with a 100ms wall-clock limit and freezes paused/disconnected/remembered entities',speed=>{
  const {world,internals}=harness(),snapshot=view([{...entity('villager','unit'),visualAction:{kind:'move',startedTick:20}}]);
  snapshot.tick=20;snapshot.simulationSpeed=speed;world.setView(snapshot);world.setStreamActive(true);
  const playback=world as unknown as {receivedViewAt:number;visualTick(now:number):number;animate(entry:unknown,now:number):void};
  const entry=internals.rendered.get('villager')! as unknown as {entity:ViewEntity;asset:{seconds:number}};
  playback.receivedViewAt=1000;playback.animate(entry,1050);
  expect(entry.asset.seconds).toBeCloseTo(.05*speed);expect(playback.visualTick(1050)).toBeCloseTo(20+speed);
  playback.animate(entry,1100);expect(entry.asset.seconds).toBeCloseTo(.1*speed);expect(playback.visualTick(1100)).toBeCloseTo(20+2*speed);
  playback.animate(entry,10000);expect(entry.asset.seconds).toBeCloseTo(.1*speed);expect(playback.visualTick(10000)).toBeCloseTo(20+2*speed);
  snapshot.status='PAUSED';playback.animate(entry,1500);expect(entry.asset.seconds).toBe(0);expect(playback.visualTick(1500)).toBe(20);
  snapshot.status='RUNNING';world.setStreamActive(false);playback.animate(entry,1500);expect(entry.asset.seconds).toBe(0);
  world.setStreamActive(true);entry.entity={...entry.entity,ghost:true,lastSeenTick:21};playback.animate(entry,10000);expect(entry.asset.seconds).toBeCloseTo(.05);
  delete snapshot.simulationSpeed;entry.entity={...entry.entity,ghost:false};playback.animate(entry,1050);expect(entry.asset.seconds).toBeCloseTo(.05);
});

it('rocky ridges have visible relief wholly within collision bounds and an exactly matching fog surface',()=>{
  const {world,scene}=harness(),snapshot=view([]);
  snapshot.map.terrain=[{id:'range',kind:'ridge',xMm:7300,zMm:8100,widthMm:16000,depthMm:20000,elevationMm:12000}];
  snapshot.fog={visible:[],explored:[]};world.setView(snapshot);
  const ridge=scene.getMeshByName('rocky-ridge-range') as Mesh,positions=ridge.getVerticesData('position')!,colors=ridge.getVerticesData('color')!;
  expect(ridge.metadata.terrain).toBe(true);expect(ridge.isPickable).toBe(true);
  const tops:number[]=[];
  for(let i=0;i<positions.length;i+=3){
    expect(positions[i]!).toBeGreaterThanOrEqual(7.3-1e-6);expect(positions[i]!).toBeLessThanOrEqual(23.3+1e-6);
    expect(positions[i+2]!).toBeGreaterThanOrEqual(8.1-1e-6);expect(positions[i+2]!).toBeLessThanOrEqual(28.1+1e-6);
    expect(positions[i+1]!).toBeGreaterThanOrEqual(0);expect(positions[i+1]!).toBeLessThanOrEqual(12);tops.push(positions[i+1]!);
  }
  expect(Math.max(...tops)).toBeGreaterThan(8);expect(new Set(tops).size).toBeGreaterThan(15);
  for(let i=0;i<colors.length;i+=4){expect(Math.abs(colors[i]!-colors[i+1]!)).toBeCloseTo(.01,5);expect(colors[i]!).toBeGreaterThan(colors[i+2]!);}
  const fog=scene.getMeshByName('fog-of-war') as Mesh,mask=fog.getVerticesData('position')!,maskColors=fog.getVerticesData('color')!;
  const key=(x:number,y:number,z:number)=>`${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
  const maskPoints=new Set(Array.from({length:mask.length/3},(_,i)=>key(mask[i*3]!,mask[i*3+1]!,mask[i*3+2]!)));
  for(let i=0;i<positions.length;i+=3)expect(maskPoints.has(key(positions[i]!,positions[i+1]!+.08,positions[i+2]!))).toBe(true);
  // Public impassable rock stays readable; hidden ordinary ground stays opaque.
  for(let i=0;i<mask.length/3;i++)if(mask[i*3+1]!>1)expect(maskColors[i*4+3]).toBeCloseTo(.45,5);
  expect(maskColors[3]).toBe(1);
  // Clearing terrain fog must not fabricate any undiscovered forest or resource.
  world.setView({...snapshot,tick:1,fog:{visible:Array.from({length:100},(_,i)=>i),explored:Array.from({length:100},(_,i)=>i)}});
  expect((scene.getMeshByName('fog-of-war') as Mesh).getTotalVertices()).toBe(0);
  expect(scene.meshes.some(mesh=>mesh.name.includes('tree'))).toBe(false);
});

it('authorized natural food depletion removes its art while exhausted farms reseed and remembered farm colors stay frozen',()=>{
  const {world,internals,scene}=harness();
  const farm:ViewEntity={...entity('farm','building'),hp:100,resource:'food',amount:350,farmState:'ready'};
  const forage:ViewEntity={id:'forage',typeId:'forage_patch',kind:'resource',ownerId:null,xMm:24000,zMm:16000,hp:1,maxHp:1,resource:'food',amount:100};
  const remembered:ViewEntity={...farm,id:'remembered-farm',ownerId:'enemy',xMm:16000,zMm:24000,amount:0,farmState:'exhausted',ghost:true,lastSeenTick:1};
  const snapshot=view([farm,forage,remembered]),fog=structuredClone(snapshot.fog);
  const materials=()=>{
    internals.assets.render(new Vector3(16,30,16));
    return scene.meshes.filter(mesh=>mesh.name.startsWith('batch-')&&mesh.isEnabled()&&(mesh as Mesh).thinInstanceCount>0).map(mesh=>mesh.material as StandardMaterial);
  };
  const brown=Color3.FromArray(bundle.materials.fs_food_exhausted!.baseColor).toHexString();
  world.setView(snapshot);const farmRoot=internals.rendered.get(farm.id)!.root,memoryRoot=internals.rendered.get(remembered.id)!.root;
  expect(materials().some(material=>material.name.startsWith('art-fs_leaf:')&&material.diffuseColor.toHexString()!==brown)).toBe(true);
  world.setView({...snapshot,tick:2,entities:[{...farm,amount:0,farmState:'exhausted'},{...forage,amount:0},remembered]});
  let drawn=materials();
  expect(internals.rendered.has(forage.id)).toBe(false);
  expect(drawn.some(material=>material.name.startsWith('art-fs_leaf:'))).toBe(false);
  expect(drawn.filter(material=>material.name.startsWith('art-fs_soil:')).every(material=>material.diffuseColor.toHexString()===brown)).toBe(true);
  world.setView({...snapshot,tick:3,entities:[{...farm,amount:0,farmState:'reseeding'},{...forage,amount:0},remembered]});
  expect(materials().filter(material=>material.name.startsWith('art-fs_soil:')).every(material=>material.diffuseColor.toHexString()===brown)).toBe(true);
  world.setView({...snapshot,tick:400,entities:[farm,{...forage,amount:0},remembered]});drawn=materials();
  expect(internals.rendered.get(farm.id)!.root).toBe(farmRoot);expect(internals.rendered.get(remembered.id)!.root).toBe(memoryRoot);
  expect(drawn.some(material=>material.name.startsWith('art-fs_grain:')&&material.alpha===1&&material.diffuseColor.toHexString()!==brown)).toBe(true);
  expect(drawn.some(material=>material.name.startsWith('art-fs_soil:')&&material.alpha===.32&&material.diffuseColor.toHexString()===brown)).toBe(true);
  expect(snapshot.fog).toEqual(fog);
  world.setView({...snapshot,tick:401,entities:[farm,{...forage,amount:0}]});drawn=materials();
  expect(memoryRoot.isDisposed()).toBe(true);expect(drawn.some(material=>material.alpha===.32)).toBe(false);
});

it.each([['tree_oak','wood'],['tree_pine','wood'],['tree_round_canopy','wood'],['forage_patch','food'],['gold_deposit','gold'],['stone_quarry','stone']] as const)('removes exhausted %s art, picking and selection before building on its cleared site, and restores it on replay',(typeId,resource)=>{
  const {world,internals,scene}=harness(),selected=vi.fn();world.onSelection=selected;
  const tree:ViewEntity={id:'harvested-node',kind:'resource',typeId,ownerId:null,xMm:16000,zMm:16000,hp:1,maxHp:1,resource,amount:250},snapshot=view([tree]);
  world.setView(snapshot);internals.camera.target.set(16,0,16);
  const root=internals.rendered.get(tree.id)!.root,ring=internals.rendered.get(tree.id)!.ring as Mesh,health=root.getChildMeshes().find(mesh=>mesh.name==='health-background')!;
  const pick=vi.spyOn(scene,'pick').mockReturnValue(new PickingInfo()),ray=vi.spyOn(scene,'createPickingRay').mockReturnValue(new Ray(new Vector3(16,20,16),new Vector3(0,-1,0)));
  const parts=()=>{internals.assets.render(new Vector3(16,20,16));return internals.assets.metrics.visibleParts;};
  try{
    expect(parts()).toBeGreaterThan(0);expect(world.pick(0,0)?.id).toBe(tree.id);world.select([tree.id]);expect(ring.isEnabled()).toBe(true);
    const depleted={...snapshot,tick:2,entities:[{...tree,amount:0}]},before=JSON.stringify(depleted);world.setView(depleted);
    expect(root.isDisposed()).toBe(true);expect(ring.isDisposed()).toBe(true);expect(health.isDisposed()).toBe(true);
    expect(internals.rendered.has(tree.id)).toBe(false);expect(internals.assets.instances.has(root)).toBe(false);expect(parts()).toBe(0);expect(world.pick(0,0)).toBeNull();expect(selected).toHaveBeenLastCalledWith([]);
    world.select([tree.id]);expect(selected).toHaveBeenLastCalledWith([]);
    expect(JSON.stringify(depleted)).toBe(before);expect(depleted.entities[0]!.amount).toBe(0);
    const house={...entity('house','building'),hp:100};world.setView({...depleted,tick:4,entities:[...depleted.entities,house]});
    expect([...internals.assets.instances.values()].map(instance=>instance.asset.id)).toEqual(['house']);expect(parts()).toBeGreaterThan(0);
    world.setView({...snapshot,matchEpoch:2},true);
    expect(internals.rendered.get(tree.id)!.root).not.toBe(root);expect(parts()).toBeGreaterThan(0);expect(world.pick(0,0)?.id).toBe(tree.id);expect(internals.rendered.get(tree.id)!.ring.isEnabled()).toBe(false);
  }finally{pick.mockRestore();ray.mockRestore();}
});

it.each([['tree_oak','wood'],['forage_patch','food'],['gold_deposit','gold'],['stone_quarry','stone']] as const)('keeps unknown and remembered positive %s, omits initially empty nodes, and follows authorized fog removal and reappearance',(typeId,resource)=>{
  const {world,internals}=harness();
  const tree:ViewEntity={id:'remembered-node',kind:'resource',typeId,ownerId:null,xMm:16000,zMm:16000,hp:1,maxHp:1,resource,amount:120,ghost:true,lastSeenTick:1};
  const {amount:_amount,...unknown}=tree,empty={...tree,id:'initially-empty',amount:0},knownEmpty={...empty,id:'observed-empty',ghost:false};
  const snapshot={...view([tree,{...unknown,id:'unknown-amount'},empty,knownEmpty]),tick:10,fog:{visible:[],explored:[44]}},before=JSON.stringify(snapshot);
  world.setView(snapshot);const rememberedRoot=internals.rendered.get(tree.id)!.root;
  expect([...internals.rendered.keys()]).toEqual([tree.id,'unknown-amount']);expect(internals.assets.instances.get(rememberedRoot)!.appearance.ghost).toBe(true);
  world.setView({...snapshot,tick:20});expect(internals.rendered.get(tree.id)!.root).toBe(rememberedRoot);expect(JSON.stringify(snapshot)).toBe(before);
  world.setView({...snapshot,tick:21,entities:[]});expect(rememberedRoot.isDisposed()).toBe(true);expect(internals.rendered.size).toBe(0);
  world.setView({...snapshot,tick:22});expect(internals.rendered.get(tree.id)!.root).not.toBe(rememberedRoot);expect(internals.rendered.has('initially-empty')).toBe(false);
  world.setView({...snapshot,tick:23,entities:[{...tree,ghost:false,amount:0}]});expect(internals.rendered.size).toBe(0);
});

it('building and wall previews block disclosed forest cells and open after observed depletion',()=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();world.onPlacementHint=hints;world.setView(snapshot);world.setPlacement('house');
  const placement=world as unknown as {updatePlacement(target:WorldTarget):void;previewMesh:TransformNode;updateWall(target:WorldTarget,zFirst:boolean):void};
  placement.updatePlacement({xMm:12000,zMm:12000});
  const center=placement.previewMesh.position,half=buildings.house.footprintCells[0]*balance.rules.buildingGridM*500;
  const tree:ViewEntity={id:'forest-tree',kind:'resource',typeId:'tree_oak',ownerId:null,resource:'wood',amount:100,xMm:center.x*1000+half+1200,zMm:center.z*1000,hp:1,maxHp:1,forest:{patchId:'visible-patch',cellMm:balance.maps.forestNavigationCellM*1000}};
  world.setView({...snapshot,tick:1,entities:[tree]});expect(hints.mock.lastCall?.[0]).toContain('obstructs this site');
  world.setView({...snapshot,tick:2,entities:[{...tree,amount:0}]});expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  world.setPlacement('palisade_wall');placement.updateWall({xMm:8500,zMm:8500},false);
  const wallTree={...tree,xMm:11200,zMm:9000};world.setView({...snapshot,tick:3,entities:[wallTree]});expect(hints.mock.lastCall?.[0]).toContain('obstructed or unexplored');
  world.setView({...snapshot,tick:4,entities:[{...wallTree,amount:0}]});expect(hints.mock.lastCall?.[0]).not.toContain('obstructed or unexplored');
});

it.each([['house',0],['house',90],['market',0],['market',90],['siege_workshop',90]] as const)('%s preview at %s degrees rejects a tree canopy beyond the trunk, and opens after depletion or real clearance',(type,rotation)=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();world.onPlacementHint=hints;world.setView(snapshot);world.setPlacement(type);world.rotatePlacement(rotation);
  const placement=world as unknown as {updatePlacement(target:WorldTarget):void;previewMesh:TransformNode};
  placement.updatePlacement({xMm:12000,zMm:12000});
  const preview=placement.previewMesh,center=preview.position.clone(),footprint=preview.getChildMeshes().find(mesh=>mesh.name==='placement-footprint')!;
  const size=buildings[type].footprintCells,halfWidth=(rotation%180?size[1]:size[0])*balance.rules.buildingGridM*500;
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  // Ordinary tree: no forest-cell metadata. Its trunk clears the footprint by
  // 750mm, but its authored canopy would intersect the roof without this rule.
  const tree:ViewEntity={id:'canopy-tree',kind:'resource',typeId:'tree_oak',ownerId:null,resource:'wood',amount:250,xMm:center.x*1000+halfWidth+1200,zMm:center.z*1000,hp:1,maxHp:1};
  world.setView({...snapshot,tick:1,entities:[tree]});
  expect(hints.mock.lastCall?.[0]).toContain('obstructs this site');expect(footprint.material?.name).toBe('invalid-placement');
  world.setView({...snapshot,tick:2,entities:[{...tree,amount:0}]});
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');expect(footprint.material?.name).toBe('valid-placement');
  const clearTree={...tree,xMm:center.x*1000+halfWidth+balance.rules.treeBuildingClearanceM*1000+10};
  world.setView({...snapshot,tick:3,entities:[clearTree]});
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');expect(footprint.material?.name).toBe('valid-placement');
  expect(placement.previewMesh).toBe(preview);expect(preview.position.equals(center)).toBe(true);
});

it.each(['food','gold','stone'] as const)('farm and building previews reserve visible %s artwork and clear only after observed depletion',resource=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();world.onPlacementHint=hints;
  const placement=world as unknown as {updatePlacement(target:WorldTarget):void;previewMesh:TransformNode};
  for(const type of ['farm','house','wooden_gate'] as const)for(const rotation of [0,90]){
    world.setView(snapshot);world.setPlacement(type);world.rotatePlacement(rotation);placement.updatePlacement({xMm:12000,zMm:12000});
    const center=placement.previewMesh.position.clone(),size=buildings[type].footprintCells,half=(rotation%180?size[1]:size[0])*balance.rules.buildingGridM*500;
    const node:ViewEntity={id:'nearby-resource',kind:'resource',typeId:resource==='food'?'forage_patch':resource==='gold'?'gold_deposit':'stone_quarry',resource,ownerId:null,hp:1,maxHp:1,amount:100,xMm:center.x*1000+half+1000,zMm:center.z*1000};
    expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
    world.setView({...snapshot,tick:1,entities:[node]});expect(hints.mock.lastCall?.[0]).toContain('obstructs this site');
    world.setView({...snapshot,tick:2,entities:[{...node,amount:0}]});expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
    world.setView({...snapshot,tick:3,entities:[{...node,xMm:center.x*1000+half+4000}]});expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  }
});

it('wall preview reserves tree canopy clearance outside the trunk and rechecks depletion without pointer motion',()=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();snapshot.self.resources.wood=1000;world.onPlacementHint=hints;world.setView(snapshot);world.setPlacement('palisade_wall');
  const placement=world as unknown as {updateWall(target:WorldTarget,zFirst:boolean):void;wallPreview:Mesh[]};
  placement.updateWall({xMm:8500,zMm:8500},false);
  const segment=placement.wallPreview[0]!,half=balance.rules.buildingGridM*500,tree:ViewEntity={id:'wall-canopy',kind:'resource',typeId:'tree_round_canopy',ownerId:null,resource:'wood',amount:250,xMm:segment.position.x*1000+half+1200,zMm:segment.position.z*1000,hp:1,maxHp:1};
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible wall path');
  world.setView({...snapshot,tick:1,entities:[tree]});expect(hints.mock.lastCall?.[0]).toContain('obstructed or unexplored');expect(segment.material?.name).toBe('invalid-wall');
  world.setView({...snapshot,tick:2,entities:[{...tree,amount:0}]});expect(hints.mock.lastCall?.[0]).toContain('Clear visible wall path');expect(segment.material?.name).toBe('valid-wall');
  world.setView({...snapshot,tick:3,entities:[{...tree,xMm:segment.position.x*1000+half+balance.rules.treeBuildingClearanceM*1000+10}]});expect(hints.mock.lastCall?.[0]).toContain('Clear visible wall path');expect(segment.material?.name).toBe('valid-wall');
  expect(placement.wallPreview[0]).toBe(segment);
});

it('building preview permits explored clearance but rejects undiscovered clearance even when the footprint is visible',()=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();world.onPlacementHint=hints;
  // House footprint occupies fog cell(3,3); the adjacent cell(4,3) belongs to
  // its clearance halo. No hidden resource record is sent to this browser.
  world.setView({...snapshot,fog:{visible:snapshot.fog.visible.filter(cell=>cell!==34),explored:snapshot.fog.explored.filter(cell=>cell!==34)}});world.setPlacement('house');
  const placement=world as unknown as {updatePlacement(target:WorldTarget):void;previewMesh:TransformNode};
  placement.updatePlacement({xMm:12000,zMm:12000});
  expect(hints.mock.lastCall?.[0]).toContain('must be explored');
  const footprint=placement.previewMesh.getChildMeshes().find(mesh=>mesh.name==='placement-footprint')!;expect(footprint.material?.name).toBe('invalid-placement');
  world.setView({...snapshot,tick:1,fog:{...snapshot.fog,visible:[]}});expect(hints.mock.lastCall?.[0]).toContain('Explored site; builder will verify');expect(footprint.material?.name).toBe('valid-placement');
});

it('planned-site previews retain last-known static obstruction and permit only non-overlapping mountain anchoring',()=>{
  const {world}=harness(),snapshot=view([]),hints=vi.fn();snapshot.self.resources.wood=1000;world.onPlacementHint=hints;
  snapshot.map.fogCellMm=2000;snapshot.map.terrain=[{id:'mountain',kind:'ridge',xMm:10000,zMm:0,widthMm:10000,depthMm:40000,elevationMm:5000}];
  const explored=Array.from({length:400},(_,i)=>i).filter(i=>i%20<5);snapshot.fog={visible:[],explored};
  world.setView(snapshot);world.setPlacement('palisade_wall');
  const placement=world as unknown as {updateWall(target:WorldTarget,zFirst:boolean):void;wallPreview:Mesh[]};
  placement.updateWall({xMm:8500,zMm:8500},false);expect(hints.mock.lastCall?.[0]).toContain('Explored wall path');expect(placement.wallPreview[0]!.material?.name).toBe('valid-wall');
  const tree:ViewEntity={id:'remembered-tree',kind:'resource',typeId:'tree_round_canopy',ownerId:null,resource:'wood',amount:250,xMm:9000,zMm:9000,hp:1,maxHp:1,ghost:true,lastSeenTick:0};
  world.setView({...snapshot,tick:1,entities:[tree]});expect(placement.wallPreview[0]!.material?.name).toBe('invalid-wall');
  world.setView({...snapshot,tick:2,entities:[{...tree,amount:0}]});expect(placement.wallPreview[0]!.material?.name).toBe('valid-wall');
  placement.updateWall({xMm:10500,zMm:8500},false);expect(placement.wallPreview[0]!.material?.name).toBe('invalid-wall');
});

it('renders reserved construction as a translucent planned site and restores completed opacity without replacing art',()=>{
  const {world,internals}=harness(),site={...entity('house','building'),progress:0,pendingConstruction:true};world.setView(view([site]));
  const entry=internals.rendered.get(site.id)! as unknown as {asset:AssetInstance;root:TransformNode};expect(entry.asset.appearance.opacity).toBe(.4);const root=entry.root;
  world.setView({...view([{...site,pendingConstruction:undefined,progress:.1}]),tick:2});expect(entry.asset.appearance.opacity).toBe(1);expect(entry.root).toBe(root);
});

it('held building preview follows newer authorized obstacles and fog without pointer motion or replacing its geometry', () => {
  const { world } = harness(), worker = { ...entity('villager', 'unit'), xMm: 2000, zMm: 2000 }, snapshot = view([worker]);
  const hints = vi.fn(); world.onPlacementHint = hints;
  const placement = world as unknown as { updatePlacement(target: WorldTarget): void; previewMesh: TransformNode };
  const refresh = vi.spyOn(placement, 'updatePlacement');
  world.setView(snapshot); expect(refresh).not.toHaveBeenCalled();
  world.setPlacement('barracks');
  world.setView({ ...snapshot, tick: 1 }); expect(refresh).not.toHaveBeenCalled();
  // Enter the same production method as one pointermove, then only deliver views.
  placement.updatePlacement({ xMm: 12000, zMm: 12000 });
  const preview = placement.previewMesh, position = preview.position.clone(), footprint = preview.getChildMeshes().find(mesh => mesh.name === 'placement-footprint')!;
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  expect(footprint.material?.name).toBe('valid-placement');
  refresh.mockClear();
  const blockingWorker = { ...worker, xMm: position.x * 1000, zMm: position.z * 1000 };
  world.setView({ ...snapshot, tick: 2, entities: [blockingWorker] });
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(hints.mock.lastCall?.[0]).toContain('obstructs this site');
  expect(footprint.material?.name).toBe('invalid-placement');
  world.setView({ ...snapshot, tick: 3 });
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  const gold: ViewEntity = { id: 'visible-gold', kind: 'resource', typeId: 'gold_deposit', ownerId: null, resource: 'gold', xMm: blockingWorker.xMm, zMm: blockingWorker.zMm, hp: 1, maxHp: 1 };
  world.setView({ ...snapshot, tick: 4, entities: [worker, gold] });
  expect(hints.mock.lastCall?.[0]).toContain('obstructs this site');
  world.setView({ ...snapshot, tick: 5, fog: { visible: [], explored: snapshot.fog.explored } });
  expect(hints.mock.lastCall?.[0]).toContain('Explored site; builder will verify');
  expect(footprint.material?.name).toBe('valid-placement');
  world.setView({ ...snapshot, tick: 6 });
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible site');
  expect(footprint.material?.name).toBe('valid-placement');
  expect(placement.previewMesh).toBe(preview); expect(preview.position.equals(position)).toBe(true);
  world.setPlacement(null); refresh.mockClear(); hints.mockClear();
  world.setView({ ...snapshot, tick: 7, entities: [blockingWorker] });
  expect(refresh).not.toHaveBeenCalled(); expect(hints).not.toHaveBeenCalled(); expect(preview.isDisposed()).toBe(true);
});

it('held wall preview retains its bend and pooled segments while authorized bank and obstacles change', () => {
  const { world } = harness(), snapshot = view([]), hints = vi.fn(); world.onPlacementHint = hints;
  snapshot.self.resources.wood = 1000;
  world.setView(snapshot); world.setPlacement('palisade_wall');
  const placement = world as unknown as { updateWall(target: WorldTarget, zFirst: boolean): void; wallStart: Cell | null; wallCells: Cell[]; wallPreview: Mesh[] };
  placement.wallStart = { x: 4, z: 4 };
  placement.updateWall({ xMm: 12000, zMm: 12000 }, true);
  const path = [{ x: 4, z: 4 }, { x: 4, z: 5 }, { x: 4, z: 6 }, { x: 5, z: 6 }, { x: 6, z: 6 }], segments = [...placement.wallPreview];
  expect(placement.wallCells).toEqual(path); expect(hints.mock.lastCall?.[0]).toContain('Clear visible wall path');
  world.setView({ ...snapshot, tick: 1, self: { ...snapshot.self, resources: { ...snapshot.self.resources, wood: 0 } } });
  expect(hints.mock.lastCall?.[0]).toContain('Insufficient resources');
  expect(placement.wallCells).toEqual(path);
  const blockedCell = segments[1]!, worker = { ...entity('villager', 'unit'), xMm: blockedCell.position.x * 1000, zMm: blockedCell.position.z * 1000 };
  world.setView({ ...snapshot, tick: 2, entities: [worker] });
  expect(hints.mock.lastCall?.[0]).toContain('obstructed or unexplored cells'); expect(blockedCell.material?.name).toBe('invalid-wall');
  world.setView({ ...snapshot, tick: 3 });
  expect(hints.mock.lastCall?.[0]).toContain('Clear visible wall path'); expect(blockedCell.material?.name).toBe('valid-wall');
  expect(placement.wallCells).toEqual(path); expect(placement.wallPreview).toHaveLength(segments.length);
  segments.forEach((segment, index) => expect(placement.wallPreview[index]).toBe(segment));
  world.setPlacement(null); hints.mockClear();
  world.setView({ ...snapshot, tick: 4 });
  expect(hints).not.toHaveBeenCalled(); expect(segments.every(segment => segment.isDisposed())).toBe(true);
});

it.each([-Math.PI / 2.6, -Math.PI / 2, 0, Math.PI / 2, Math.PI])('camera pan follows screen left/right after rotation to %s', alpha => {
  const engine = new NullEngine(); engines.push(engine); const scene = new Scene(engine);
  const camera = new ArcRotateCamera('pan-camera', alpha, .82, 45, new Vector3(100, 0, 100), scene);
  const landmark = camera.target.clone(), directions = cameraPanDirections(alpha);
  const screen = (point: Vector3) => { camera.getViewMatrix(); camera.getProjectionMatrix(); return Vector3.Project(point, Matrix.Identity(), camera.getTransformationMatrix(), new Viewport(0, 0, engine.getRenderWidth(), engine.getRenderHeight())); };
  const center = screen(landmark);
  expect(screen(landmark.add(directions.right)).x).toBeGreaterThan(center.x);
  expect(screen(landmark.add(directions.forward)).y).toBeLessThan(center.y);
  // Right pan moves the viewport right, so a stationary landmark moves left.
  camera.target.addInPlace(directions.right.scale(3)); expect(screen(landmark).x).toBeLessThan(center.x - 1);
  camera.target.copyFrom(landmark).addInPlace(directions.right.scale(-3)); expect(screen(landmark).x).toBeGreaterThan(center.x + 1);
});

it('middle-pointer motion changes the rendered camera while left and right gestures retain their RTS roles', () => {
  const engine = new NullEngine(); engines.push(engine); engine.getDeltaTime = () => 1000 / 60;
  const scene = new Scene(engine);
  for (const button of [0, 2, 1]) {
    const camera = new ArcRotateCamera(`gesture-${button}`, -.8, .82, 45, Vector3.Zero(), scene);
    configureRtsCameraControls(camera);
    const pointer = camera.inputs.attached.pointers as ArcRotateCameraPointersInput, original = { alpha: camera.alpha, beta: camera.beta };
    const event = { button, ctrlKey: false, altKey: false, shiftKey: false } as PointerEvent;
    pointer.onButtonDown(event);
    pointer.onTouch(null, 130, 40); camera._checkInputs(); pointer.onButtonUp(event);
    if (button === 1) {
      expect(Math.abs(camera.alpha - original.alpha)).toBeGreaterThan(.01);
      expect(Math.abs(camera.beta - original.beta)).toBeGreaterThan(.005);
    } else { expect(camera.alpha).toBe(original.alpha); expect(camera.beta).toBe(original.beta); }
    expect(camera.target.equals(Vector3.Zero())).toBe(true);
    camera.dispose();
  }
});

it('picks the visible wall beyond a Founding Town Center instead of its empty all-age roof envelope', () => {
  const { world, internals } = harness();
  const tc = { ...entity('town_center', 'building'), xMm: 128000, zMm: 192000, hp: 2400, maxHp: 2400 };
  const wall = { ...entity('palisade_wall', 'building'), xMm: 129000, zMm: 203000, hp: 250, maxHp: 250 };
  const snapshot = view([tc, wall]); snapshot.map.widthMm = snapshot.map.heightMm = 384000;
  world.setView(snapshot); world.camera.alpha = -Math.PI / 2.6; world.camera.beta = .82; world.camera.radius = 45; world.focus(wall.xMm, wall.zMm);
  world.camera.getViewMatrix(); world.camera.getProjectionMatrix();
  const pixel = Vector3.Project(new Vector3(129, 1.5, 203), Matrix.Identity(), world.camera.getTransformationMatrix(), new Viewport(0, 0, internals.engine.getRenderWidth(), internals.engine.getRenderHeight()));
  const ray = internals.scene.createPickingRay(pixel.x, pixel.y, Matrix.Identity(), world.camera);
  expect(ray.intersectsBoxMinMax(new Vector3(121.6, -.35, 185.6), new Vector3(134.4, 7.3, 198.4))).toBe(true);
  const townAsset = internals.assets.instances.get(internals.rendered.get(tc.id)!.root)!;
  expect(internals.assets.pickDistance(townAsset, ray)).toBeNull();
  expect(world.pick(pixel.x, pixel.y)?.id).toBe(wall.id);
  const buildingPixel = Vector3.Project(new Vector3(128, 3, 192), Matrix.Identity(), world.camera.getTransformationMatrix(), new Viewport(0, 0, internals.engine.getRenderWidth(), internals.engine.getRenderHeight()));
  expect(world.pick(buildingPixel.x, buildingPixel.y)?.id).toBe(tc.id);
});

it('isolated renderer fixture preserves existing root, selection, queue, order, and authoritative damage through all four appearances', () => {
  const { world, internals } = harness();
  const tc = { ...entity('town_center', 'building'), queue: [{ kind: 'train', typeId: 'villager', id: 'paid-job', progress: 0.5, state: 'waiting', started: false } as const] };
  const unit = { ...entity('militia', 'unit'), order: 'patrol', queuedOrderCount: 2 };
  const snapshot = view([tc, unit]); world.setView(snapshot); world.select([tc.id, unit.id]);
  const original = internals.rendered.get(tc.id)!, originalUnit = internals.rendered.get(unit.id)!, camera = world.camera.target.clone();
  for (const age of [2, 3, 4] as const) {
    snapshot.self.age = age; tc.visualAge = age; unit.visualAge = age; unit.visualTier = age === 4 ? 'elite' : age === 3 ? 'veteran' : 'base';
    world.setView(snapshot);
    expect(internals.rendered.get(tc.id)).toBe(original); expect(internals.rendered.get(unit.id)).toBe(originalUnit);
    expect(original.ring.isEnabled()).toBe(true); expect(originalUnit.ring.isEnabled()).toBe(true); expect(original.healthFill.scaling.x).toBe(0.3);
    expect(world.camera.target.equals(camera)).toBe(true); expect(tc.queue[0]!.id).toBe('paid-job'); expect(unit.order).toBe('patrol'); expect(unit.queuedOrderCount).toBe(2);
    expect(original.root.metadata.appearance).toBe(`town_center:${age}:base`);
  }
  expect(internals.assets.instances.get(original.root)!.variant.nodes.some(node => node.id.startsWith('dressed_stone_frieze'))).toBe(true);
  expect(internals.assets.instances.get(originalUnit.root)!.variant.nodes.some(node => node.id === 'crest')).toBe(true);
});
it('isolated renderer fixture keeps unseen building appearance frozen across public enemy advancement and updates only on observation', () => {
  const { world, internals } = harness(), ghost = { ...entity('house', 'building', 'remembered-house'), ownerId: 'enemy', ghost: true, lastSeenTick: 10 };
  const snapshot = view([ghost]); world.setView(snapshot); const root = internals.rendered.get(ghost.id)!.root, module = internals.assets.instances.get(root)!.variant;
  snapshot.players[1]!.age = 4; snapshot.ageAnnouncements = [{ playerId: 'enemy', age: 4, tick: 30 }]; snapshot.tick = 40; world.setView(snapshot);
  expect(root.metadata.appearance).toBe('house:1:base'); expect(internals.assets.instances.get(root)!.variant).toBe(module);
  expect(internals.assets.instances.get(root)!.appearance.ghost).toBe(true);
  ghost.ghost = false; ghost.visualAge = 4; world.setView(snapshot);
  expect(internals.rendered.get(ghost.id)!.root).toBe(root); expect(root.metadata.appearance).toBe('house:4:base'); expect(internals.assets.instances.get(root)!.variant).not.toBe(module);
});
it('isolated renderer fixture covers every unit and structure age without replacing object roots', () => {
  const { world, internals } = harness(), entries = [...balance.buildings.map((definition) => entity(definition.id, 'building')), ...balance.units.map((definition) => entity(definition.id, 'unit'))], snapshot = view(entries);
  world.setView(snapshot); const roots = entries.map((entry) => internals.rendered.get(entry.id)!.root);
  for (const age of [2, 3, 4] as const) { for (const entry of entries) entry.visualAge = age; world.setView(snapshot); entries.forEach((entry, index) => expect(internals.rendered.get(entry.id)!.root).toBe(roots[index])); }
});
it('isolated replay fixture clears future effects when seeking backward and can replay an observed impact again', () => {
  const { world, internals, scene } = harness(), snapshot = view([entity('militia', 'unit')]);
  const effect = { id: 'impact_1', tick: 100, kind: 'impact' as const, projectileKind: 'stone' as const, xMm: 16000, zMm: 16000 };
  world.setView({ ...snapshot, tick: 100, effects: [effect] });
  const first = scene.getTransformNodeByName('visible-impact')!; expect(first).not.toBeNull();
  world.setView({ ...snapshot, tick: 20, effects: [] }, true);
  expect(first.isDisposed()).toBe(true); expect(internals.seenEffects.size).toBe(0);
  world.setView({ ...snapshot, tick: 100, effects: [effect] });
  expect(scene.getTransformNodeByName('visible-impact')).not.toBe(first); expect(internals.seenEffects.has(effect.id)).toBe(true);
});
it('authorized coordinate pings render and expire without revealing fog cells or creating entities', () => {
  const { world, internals } = harness(), snapshot = { ...view([]), fog: { visible: [], explored: [] } };
  world.setView(snapshot); const fog = structuredClone(snapshot.fog);
  world.setPings([{ id: 'ally-coordinate', tick: 10, expiresTick: 50, senderId: 'me', category: 'help', xMm: 23000, zMm: 18000 }], 20);
  const signal = internals.pingMeshes.get('ally-coordinate')!;
  expect(signal.position.x).toBe(23); expect(signal.getChildMeshes().every((mesh) => !mesh.isPickable)).toBe(true);
  expect(snapshot.fog).toEqual(fog); expect(internals.rendered.size).toBe(0);
  world.setPings([], 50); expect(signal.isDisposed()).toBe(true); expect(internals.pingMeshes.size).toBe(0);
});
it('concealment produces no corpse, while an authorized death appearance can instantiate without a cached live model', () => {
  const { world, internals, scene } = harness(), snapshot = view([entity('militia','unit')]);
  world.setView(snapshot);world.setView({...snapshot,tick:10,entities:[]});
  expect(internals.rendered.size).toBe(0);expect(scene.getTransformNodeByName('visible-death')).toBeNull();
  world.setView({...snapshot,tick:12,entities:[],effects:[{id:'observed-death',tick:12,kind:'death',entityId:'observed-knight',typeId:'knight',ownerId:'enemy',visualAge:4,visualTier:'elite',xMm:16000,zMm:16000}]});
  const corpse=scene.getTransformNodeByName('visible-death')!;expect(corpse).not.toBeNull();
  expect(internals.assets.instances.get(corpse)!.variant.key).toBe('age_4_elite');
  world.setView({...snapshot,tick:13,entities:[],fog:{visible:[],explored:snapshot.fog.explored},effects:[]});expect(corpse.isDisposed()).toBe(true);
});
it('observed gate transitions use the same leaves, freeze while paused or remembered, and initial open reveal invents no closure',()=>{
  const {world,internals}=harness(),gate={...entity('wooden_gate','building'),gateOpen:false},snapshot=view([gate]);
  world.setView(snapshot);const root=internals.rendered.get(gate.id)!.root,asset=internals.assets.instances.get(root)!;
  world.setView({...snapshot,tick:2,entities:[{...gate,gateOpen:true}]});expect(asset.seconds).toBeCloseTo(0,1);
  world.setView({...snapshot,tick:6,status:'PAUSED',entities:[{...gate,gateOpen:true}]});expect(asset.seconds).toBeCloseTo(.2,2);
  world.setView({...snapshot,tick:80,entities:[{...gate,gateOpen:true,ghost:true,lastSeenTick:6}]});expect(asset.seconds).toBeCloseTo(.2,2);
  world.setView({...snapshot,tick:100,entities:[{...gate,gateOpen:true}]},true);expect(asset.seconds).toBeCloseTo(.4,2);expect(internals.rendered.get(gate.id)!.root).toBe(root);
});
it('a stationary worker turns only to an authorized observed work bearing while retaining its root and action time',()=>{
  const {world,internals}=harness(),worker={...entity('villager','unit'),visualAction:{kind:'build' as const,startedTick:4,facingMilliRad:1571}},snapshot=view([worker]);
  world.setView({...snapshot,tick:8});const root=internals.rendered.get(worker.id)!.root;
  expect(root.rotation.y).toBeCloseTo(1.571,3);
  world.setView({...snapshot,tick:9,entities:[{...worker,visualAction:{...worker.visualAction,facingMilliRad:-1571}}]});
  expect(internals.rendered.get(worker.id)!.root).toBe(root);expect(root.rotation.y).toBeCloseTo(-1.571,3);expect(internals.assets.instances.get(root)!.clip).toBe('build');
});
it('coarse stationary work and attack facing follows presentation time without restarting work or revealing a later bearing early',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),worker={...entity('villager','unit'),visualAction:{kind:'build' as const,startedTick:0,facingMilliRad:0}};
  const base={...view([worker]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  const playback=world as unknown as {animate(entry:unknown,now:number,trajectoryFacing?:boolean):void};
  try{
    world.setView(base);world.setStreamActive(true);const entry=internals.rendered.get(worker.id)!,asset=internals.assets.instances.get(entry.root)!;
    clock.mockReturnValue(1300);world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[{...worker,visualAction:{...worker.visualAction,facingMilliRad:1571}}]});
    playback.animate(entry,1600);expect(entry.root.rotation.y).toBe(0);expect(asset.seconds).toBeCloseTo(.25);
    playback.animate(entry,1650);expect(entry.root.rotation.y).toBeCloseTo(1.571);expect(asset.seconds).toBeCloseTo(.3);expect(asset.clip).toBe('build');
    clock.mockReturnValue(1700);world.setView({...base,tick:12,committedTimeMs:600,frameRevision:2,entities:[{...worker,visualAction:{kind:'attack',startedTick:8,durationTicks:20,facingMilliRad:-1571}}]});
    playback.animate(entry,1750);expect(entry.root.rotation.y).toBeCloseTo(1.571);expect(asset.clip).toBe('build');
    playback.animate(entry,1850);expect(entry.root.rotation.y).toBeCloseTo(-1.571);expect(asset.clip).toBe('attack');expect(asset.seconds).toBe(0);
    expect(internals.rendered.get(worker.id)!.root).toBe(entry.root);expect(entry.root.position.asArray()).toEqual([16,0,16]);
  }finally{clock.mockRestore();}
});
it('coarse observed facing preserves a displayed movement bearing and freezes future turns while disconnected or paused',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),unit={...entity('militia','unit'),visualAction:{kind:'attack' as const,startedTick:0,durationTicks:20,facingMilliRad:1571}};
  const base={...view([unit]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  const playback=world as unknown as {animate(entry:unknown,now:number,trajectoryFacing?:boolean):void};
  try{
    world.setView(base);world.setStreamActive(true);const entry=internals.rendered.get(unit.id)!;
    entry.root.rotation.y=.75;playback.animate(entry,1000,true);expect(entry.root.rotation.y).toBe(.75);
    playback.animate(entry,1000);expect(entry.root.rotation.y).toBeCloseTo(1.571);
    clock.mockReturnValue(1300);world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[{...unit,visualAction:{...unit.visualAction,facingMilliRad:-1571}}]});
    world.setStreamActive(false);playback.animate(entry,5000);expect(entry.root.rotation.y).toBeCloseTo(1.571);
    world.setStreamActive(true);world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,status:'PAUSED',entities:[{...unit,visualAction:{...unit.visualAction,facingMilliRad:-1571}}]});
    playback.animate(entry,5000);expect(entry.root.rotation.y).toBeCloseTo(1.571);
  }finally{clock.mockRestore();}
});
it('coarse bearing history stays bounded and clears on epoch reset and concealment',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),unit={...entity('villager','unit'),visualAction:{kind:'build' as const,startedTick:0,facingMilliRad:0}};
  const base={...view([unit]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  try{
    world.setView(base);world.setStreamActive(true);
    for(let frame=1;frame<=20;frame++){clock.mockReturnValue(1000+frame*300);world.setView({...base,tick:frame*6,committedTimeMs:frame*300,frameRevision:frame,entities:[{...unit,visualAction:{...unit.visualAction,facingMilliRad:frame%2?1571:-1571}}]});}
    const entry=internals.rendered.get(unit.id)! as unknown as {root:TransformNode;actionHistory:{presentedTick?:number;facingMilliRad:number}[]};expect(entry.actionHistory).toHaveLength(16);
    clock.mockReturnValue(7100);world.setView({...base,matchEpoch:2},true);expect(entry.actionHistory).toHaveLength(1);expect(entry.actionHistory[0]!.presentedTick).toBeUndefined();expect(entry.root.rotation.y).toBe(0);
    world.setView({...base,matchEpoch:2,tick:6,committedTimeMs:300,frameRevision:1,entities:[],fog:{visible:[],explored:base.fog.explored}});expect(entry.root.isDisposed()).toBe(true);expect(internals.rendered.size).toBe(0);
    world.setView({...base,matchEpoch:2,tick:12,committedTimeMs:600,frameRevision:2});const revealed=internals.rendered.get(unit.id)! as unknown as typeof entry;expect(revealed.root).not.toBe(entry.root);expect(revealed.actionHistory).toHaveLength(1);expect(revealed.actionHistory[0]!.facingMilliRad).toBe(0);
  }finally{clock.mockRestore();}
});
it('plays multiple authorized actions and gate changes inside one coarse frame without exposing future poses',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000);
  const worker={...entity('villager','unit'),visualAction:{kind:'idle' as const,startedTick:0}},gate={...entity('wooden_gate','building'),gateOpen:false};
  const base={...view([worker,gate]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  const playback=world as unknown as {animate(entry:unknown,now:number):void};
  try{
    world.setView(base);world.setStreamActive(true);clock.mockReturnValue(1300);
    const mine={kind:'mine' as const,startedTick:2,facingMilliRad:1000},build={kind:'build' as const,startedTick:4,facingMilliRad:-1000},idle={kind:'idle' as const,startedTick:6};
    world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[{...worker,visualAction:idle,visualTrace:{complete:true,fromTick:0,points:[{tick:0,visualAction:worker.visualAction},{tick:2,visualAction:mine},{tick:4,visualAction:build},{tick:6,visualAction:idle}]}},{...gate,visualTrace:{complete:true,fromTick:0,points:[{tick:0,gateOpen:false},{tick:1,gateOpen:true},{tick:5,gateOpen:false},{tick:6,gateOpen:false}]}}]});
    const entry=internals.rendered.get(worker.id)!,asset=internals.assets.instances.get(entry.root)!,gateEntry=internals.rendered.get(gate.id)! as unknown as {gatePose:number};
    playback.animate(entry,1400);expect(asset.clip).toBe('idle');playback.animate(entry,1450);expect(asset.clip).toBe('mine');expect(entry.root.rotation.y).toBe(1);
    playback.animate(entry,1550);expect(asset.clip).toBe('build');expect(entry.root.rotation.y).toBe(-1);playback.animate(entry,1650);expect(asset.clip).toBe('idle');
    // A separate reset permits sampling the gate on the same advancing clock.
    world.setView(base,true);clock.mockReturnValue(1300);world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[worker,{...gate,visualTrace:{complete:true,fromTick:0,points:[{tick:0,gateOpen:false},{tick:1,gateOpen:true},{tick:5,gateOpen:false},{tick:6,gateOpen:false}]}}]});
    playback.animate(gateEntry,1350);expect(gateEntry.gatePose).toBe(0);playback.animate(gateEntry,1450);expect(gateEntry.gatePose).toBeGreaterThan(0);const opening=gateEntry.gatePose;
    playback.animate(gateEntry,1550);expect(gateEntry.gatePose).toBeGreaterThan(opening);playback.animate(gateEntry,1600);const beforeClose=gateEntry.gatePose;playback.animate(gateEntry,1650);expect(gateEntry.gatePose).toBeLessThan(beforeClose);
  }finally{clock.mockRestore();}
});
it('holds an incomplete visual interval until its committed endpoint and clears it on garrison and epoch reset',()=>{
  const {world,internals}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000),worker={...entity('villager','unit'),visualAction:{kind:'build' as const,startedTick:0,facingMilliRad:0}};
  const base={...view([worker]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  const playback=world as unknown as {animate(entry:unknown,now:number):void};
  try{
    world.setView(base);world.setStreamActive(true);clock.mockReturnValue(1300);const mine={kind:'mine' as const,startedTick:4,facingMilliRad:1000};
    world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[{...worker,visualAction:mine,visualTrace:{complete:false,fromTick:0,points:[{tick:4,visualAction:mine},{tick:6,visualAction:mine}]}}]});
    const entry=internals.rendered.get(worker.id)!,asset=internals.assets.instances.get(entry.root)!;playback.animate(entry,1550);expect(asset.clip).toBe('build');expect(entry.root.rotation.y).toBe(0);
    playback.animate(entry,1650);expect(asset.clip).toBe('mine');expect(entry.root.rotation.y).toBe(1);
    world.setView({...base,tick:12,committedTimeMs:600,frameRevision:2,entities:[{...worker,garrisonedIn:'home'}]});expect((entry as unknown as {actionHistory:unknown[]}).actionHistory).toHaveLength(1);
    world.setView({...base,matchEpoch:2},true);expect(world.presentationTimeMs()).toBe(0);expect((entry as unknown as {actionHistory:unknown[]}).actionHistory).toHaveLength(1);
  }finally{clock.mockRestore();}
});
it('samples authorized construction and production progress on the world clock and freezes before uncommitted outcomes',()=>{
  const {world}=harness(),clock=vi.spyOn(performance,'now').mockReturnValue(1000);
  const producer={...entity('town_center','building'),progress:.2,queue:[{id:'job',kind:'train' as const,typeId:'villager' as const,state:'active' as const,progress:.1}]};
  const base={...view([producer]),authoritativeIntervalMs:300 as const,publicationIntervalMs:300 as const,committedTimeMs:0,frameRevision:0};
  try{
    world.setView(base);world.setStreamActive(true);clock.mockReturnValue(1300);
    const current={...producer,progress:.5,queue:[{...producer.queue[0]!,progress:.4}]};world.setView({...base,tick:6,committedTimeMs:300,frameRevision:1,entities:[current]});
    clock.mockReturnValue(1450);expect(world.presentationProgress(producer.id)).toBeCloseTo(.3);expect(world.presentationProgress(producer.id,'job')).toBeCloseTo(.2);
    world.setStreamActive(false);clock.mockReturnValue(10000);expect(world.presentationProgress(producer.id)).toBeCloseTo(.3);expect(world.presentationProgress(producer.id,'job')).toBeCloseTo(.2);
    world.setStreamActive(true);expect(world.presentationProgress(producer.id)).toBe(.5);expect(world.presentationProgress(producer.id,'job')).toBe(.4);
    world.setView({...base,tick:12,committedTimeMs:600,frameRevision:2,entities:[{...current,queue:[{...current.queue[0]!,state:'population_blocked'}]}]});expect(world.presentationProgress(producer.id,'job')).toBe(.4);
    world.setView({...base,tick:18,committedTimeMs:900,frameRevision:3,entities:[{...current,queue:[]}]});expect(world.presentationProgress(producer.id,'job')).toBeUndefined();expect(base.self.resources.food).toBe(0);
    world.setView({...base,matchEpoch:2},true);expect(world.presentationProgress(producer.id)).toBe(.2);expect(world.presentationProgress(producer.id,'job')).toBe(.1);
    world.setView({...base,matchEpoch:2,entities:[]});expect(world.presentationProgress(producer.id)).toBeUndefined();
  }finally{clock.mockRestore();}
});

it('projectile pooling hides departed projectiles and reuses geometry roots only for subsequently authorized positions',()=>{
  const {world,internals}=harness(),snapshot=view([]),arrow={id:'arrow_1',kind:'arrow' as const,xMm:16000,yMm:2000,zMm:16000};
  world.setView({...snapshot,projectiles:[arrow]});const root=internals.projectiles.get(arrow.id).mesh as TransformNode;
  world.setView({...snapshot,tick:2,projectiles:[]});expect(root.isEnabled()).toBe(false);expect(internals.projectiles.size).toBe(0);
  world.setView({...snapshot,tick:4,projectiles:[{...arrow,id:'arrow_2',xMm:18000}]});expect(internals.projectiles.get('arrow_2').mesh).toBe(root);expect(root.isEnabled()).toBe(true);expect(internals.projectiles.get('arrow_2').to.x).toBe(18);
});
