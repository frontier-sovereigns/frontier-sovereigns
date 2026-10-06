import { afterEach, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { createAssetLibrary, generateUnitAssets, generateBuildingAssets, generateEnvironmentAssets, sampleAssetPose, posedAssetPoint } from '@frontier/assets';
import { contentHash, assetCatalogContentHash, TEAM_IDENTITIES } from '@frontier/shared';
import { sha256 } from '../../../packages/shared/src/hash';
import { AssetRenderer, loadAssetBundle } from './AssetRenderer';
import { observeResponseRender } from './BrowserResponseDiagnostics';

const library=createAssetLibrary(),bundle=library.finish([...generateUnitAssets(library),...generateBuildingAssets(library),...generateEnvironmentAssets(library)]);
const engines:NullEngine[]=[];
afterEach(()=>{for(const engine of engines.splice(0))engine.dispose();vi.unstubAllGlobals();});
function renderer(){const engine=new NullEngine();engines.push(engine);return new AssetRenderer(new Scene(engine),bundle);}

function activeMaterials(art:AssetRenderer):StandardMaterial[]{return art.scene.meshes.filter(mesh=>mesh.name.startsWith('batch-')&&mesh.isEnabled()&&(mesh as Mesh).thinInstanceCount>0).map(mesh=>mesh.material as StandardMaterial);}

it('empty forage and farms turn brown independently, preserve ownership, and recover without material churn',()=>{
  const art=renderer(),forage=art.create('forage_patch'),farm=art.create('farm',{color:TEAM_IDENTITIES[0]!.color});
  forage.forcedLod=0;farm.forcedLod=0;
  const render=()=>{art.render(new Vector3(0,5,5));return activeMaterials(art);};
  const brown=Color3.FromArray(bundle.materials.fs_food_exhausted!.baseColor).toHexString();
  expect(render().filter(material=>material.name.startsWith('art-fs_leaf:')).map(material=>material.diffuseColor.toHexString())).not.toContain(brown);
  art.update(forage,{depletedFood:true});
  let materials=render();
  expect(materials.filter(material=>/art-fs_(leaf|berry):/.test(material.name)).every(material=>material.diffuseColor.toHexString()===brown)).toBe(true);
  expect(materials.some(material=>material.name.startsWith('art-fs_grain:')&&material.diffuseColor.toHexString()!==brown)).toBe(true);
  const freshForage=art.create('forage_patch');materials=render();
  expect(new Set(materials.filter(material=>material.name.startsWith('art-fs_leaf:')).map(material=>material.diffuseColor.toHexString()))).toEqual(new Set([brown,Color3.FromArray(bundle.materials.fs_leaf!.baseColor).toHexString()]));
  freshForage.root.dispose();
  art.update(farm,{depletedFood:true},{farm:'exhausted'});materials=render();
  expect(materials.some(material=>material.name.startsWith('art-fs_grain:'))).toBe(false);
  expect(materials.filter(material=>/art-fs_(soil|thatch|wood_dark):/.test(material.name)).every(material=>material.diffuseColor.toHexString()===brown)).toBe(true);
  expect(materials.some(material=>material.name.startsWith('art-fs_team:')&&material.diffuseColor.toHexString()===TEAM_IDENTITIES[0]!.color.toUpperCase())).toBe(true);
  art.update(farm,{depletedFood:true},{farm:'reseeding'});render();
  art.update(farm,{depletedFood:false},{farm:'ready'});materials=render();
  expect(materials.some(material=>material.name.startsWith('art-fs_grain:')&&material.diffuseColor.toHexString()!==brown)).toBe(true);
  const count=art.scene.materials.length;
  for(let i=0;i<4;i++){art.update(farm,{depletedFood:true},{farm:'exhausted'});render();art.update(farm,{depletedFood:false},{farm:'ready'});render();}
  expect(art.scene.materials.length).toBe(count);
  art.update(forage,{ghost:true});materials=render();
  expect(materials.filter(material=>/art-fs_(leaf|berry):/.test(material.name)).every(material=>material.alpha===.32&&material.diffuseColor.toHexString()===brown)).toBe(true);
  forage.root.setEnabled(false);farm.root.setEnabled(false);expect(render()).toHaveLength(0);
  // Gallery instances carry lifecycle context without gameplay resource fields.
  const galleryFarm=art.create('farm');
  art.update(galleryFarm,{}, {farm:'exhausted'});materials=render();
  expect(materials.filter(material=>/art-fs_(soil|thatch|wood_dark):/.test(material.name)).every(material=>material.diffuseColor.toHexString()===brown)).toBe(true);
  art.update(galleryFarm,{}, {farm:'ready'});materials=render();
  expect(materials.some(material=>material.name.startsWith('art-fs_grain:')&&material.diffuseColor.toHexString()!==brown)).toBe(true);
});

it('every building keeps visible faction surfaces at every LOD and age, including foundations, walls, gates, and farms',()=>{
  const art=renderer(),buildings=Object.values(bundle.assets).filter(asset=>asset.kind==='building');
  expect(buildings).toHaveLength(35);
  for(const asset of buildings){
    const own=art.create(asset.id,{color:TEAM_IDENTITIES[0]!.color}),ally=art.create(asset.id,{color:TEAM_IDENTITIES[1]!.color});
    ally.root.position.x=25;
    for(const variant of asset.variants)for(const lod of [0,1,2] as const)for(const state of ['foundation','complete','damaged'] as const){
      for(const instance of [own,ally]){instance.forcedLod=lod;art.update(instance,{age:variant.age},{state,progress:state==='foundation'?0:1,wallMask:15});}
      art.render(new Vector3(0,5,5));
      const colors=new Set(activeMaterials(art).filter(material=>material.name.startsWith('art-fs_team:')).map(material=>material.diffuseColor.toHexString()));
      expect(colors,`${asset.id}:${variant.key}:${lod}:${state}`).toEqual(new Set(TEAM_IDENTITIES.slice(0,2).map(identity=>identity.color.toUpperCase())));
    }
    own.root.dispose();ally.root.dispose();
  }
  const neutral=art.create('tree_oak',{color:TEAM_IDENTITIES[0]!.color});art.render(new Vector3(0,5,5));
  expect(activeMaterials(art).some(material=>material.name.startsWith('art-fs_team:'))).toBe(false);
  neutral.root.dispose();
});

it('response render evidence follows Babylon completion and only submitted visible geometry',async()=>{
  const art=renderer(),camera=new ArcRotateCamera('response-camera',-.8,.8,20,Vector3.Zero(),art.scene);
  const near=art.create('villager'),far=art.create('villager'),concealed=art.create('militia');
  far.root.position.x=500;concealed.root.setEnabled(false);near.clip='move';
  const submitted=new Map<import('./AssetRenderer').AssetInstance,import('./AssetRenderer').AssetDrawEvidence>();
  art.render(camera.position);await art.scene.whenReadyAsync();
  const release=art.render(camera.position,submitted);
  expect(submitted.has(near)).toBe(true);expect(submitted.has(far)).toBe(false);expect(submitted.has(concealed)).toBe(false);
  const order:string[]=[];art.scene.onAfterRenderObservable.addOnce(()=>order.push('babylon-completed'));
  expect(submitted.get(near)?.drawn).toBe(false);
  try{observeResponseRender(art.scene,()=>{order.push('render-start');art.scene.render();},()=>{order.push('response-observed');});}finally{release?.();}
  expect(submitted.get(near)?.drawn).toBe(true);
  expect(order).toEqual(['render-start','babylon-completed','response-observed']);
  const skipped=vi.fn();observeResponseRender(art.scene,()=>{},skipped);art.scene.render();expect(skipped).not.toHaveBeenCalled();
  expect(()=>observeResponseRender(art.scene,()=>{throw new Error('render-failed');},skipped)).toThrow('render-failed');
  art.scene.render();expect(skipped).not.toHaveBeenCalled();
  expect(()=>observeResponseRender(art.scene,()=>art.scene.render(),()=>{throw new Error('diagnostic-only');})).not.toThrow();
  const materials=new Set(art.scene.meshes.filter(mesh=>mesh.name.startsWith('batch-')).map(mesh=>mesh.material!));
  const restore=[...materials].map(material=>vi.spyOn(material,'isReadyForSubMesh').mockReturnValue(false));
  const unreadyCompleted=vi.fn(),releaseUnready=art.render(camera.position,submitted);try{observeResponseRender(art.scene,()=>art.scene.render(),unreadyCompleted);}finally{releaseUnready?.();for(const spy of restore)spy.mockRestore();}
  expect(unreadyCompleted).toHaveBeenCalledOnce();expect(submitted.get(near)?.drawn).toBe(false);
  art.scene.render();expect(submitted.get(near)?.drawn).toBe(false); // Unsubscribed evidence cannot be credited by later frames.
  near.root.setEnabled(false);const releaseEmpty=art.render(camera.position,submitted);expect(submitted.size).toBe(0);releaseEmpty?.();
  const gate=art.create('wooden_gate');gate.clip='gate_open';gate.seconds=.001;const releaseClosed=art.render(camera.position,submitted);
  expect(submitted.get(gate)).toMatchObject({clip:'gate_open',sampleTime:0});releaseClosed?.(); // Positive raw pose still submits closed geometry.
  gate.seconds=.02;const releaseOpen=art.render(camera.position,submitted);expect(submitted.get(gate)?.sampleTime).toBe(1/30);releaseOpen?.();
});

it('500 real articulated units share GPU batches, and all three LODs reduce actual submitted geometry',()=>{
  const art=renderer();
  for(let i=0;i<500;i++){const instance=art.create(['villager','militia','archer','knight','catapult'][i%5]!,{color:'#8ac6bd'});instance.root.position.set(i%25*2,0,Math.floor(i/25)*2);instance.forcedLod=0;instance.clip='move';instance.seconds=.25;}
  art.render(new Vector3(0,5,5));const near=art.metrics;
  expect(near.instances).toBe(500);expect(near.visibleParts).toBeGreaterThan(10000);expect(near.batches).toBeLessThan(150);
  const batches=art.scene.meshes.filter(mesh=>mesh.name.startsWith('batch-'));
  expect(new Set(batches.map(mesh=>(mesh as import('@babylonjs/core/Meshes/mesh').Mesh).geometry)).size).toBe(batches.length);
  for(const instance of art.instances.values())instance.forcedLod=1;art.render(new Vector3(0,5,5));const middle=art.metrics;
  for(const instance of art.instances.values())instance.forcedLod=2;art.render(new Vector3(0,5,5));const far=art.metrics;
  expect(middle.triangles).toBeLessThan(near.triangles);expect(far.triangles).toBeLessThan(middle.triangles);expect(far.visibleParts).toBeLessThan(near.visibleParts);
  // Concealment removes every corresponding part from the submitted buffers immediately.
  for(const instance of art.instances.values())instance.root.setEnabled(false);art.render(new Vector3(0,5,5));expect(art.metrics.visibleParts).toBe(0);expect(art.metrics.batches).toBe(0);
});
it('all 64 required unit actions contain genuine sampled joint transformations, with tools visible only for their observed action',()=>{
  const units=Object.values(bundle.assets).filter(asset=>asset.kind==='unit');expect(units).toHaveLength(19);expect(units.filter(unit=>(unit.variants[0]?.age??1)<=4).reduce((sum,unit)=>sum+unit.clips.length,0)).toBe(64);
  for(const unit of units)for(const clip of unit.clips){
    expect(clip.tracks.length,`${unit.id}:${clip.id}`).toBeGreaterThan(0);
    const variant=unit.variants[0]!,samples=[0,.2,.5,.8,1].map(f=>sampleAssetPose(unit,variant,clip.id,clip.durationSeconds*f,{lod:0,action:clip.id as 'idle'}));
    if(clip.id==='packed'){const weapon=unit.id==='trebuchet'?'arm':'weapon';expect(samples[0]!.find(node=>node.nodeId===weapon)!.rotation).not.toEqual(variant.nodes.find(node=>node.id===weapon)!.rotation);}
    else expect(new Set(samples.map(sample=>JSON.stringify(sample))).size,`${unit.id}:${clip.id}`).toBeGreaterThan(1);
  }
  const worker=bundle.assets.villager!,variant=worker.variants[0]!;
  const idle=sampleAssetPose(worker,variant,'idle',0,{lod:0,action:'idle'}),wood=sampleAssetPose(worker,variant,'gather_wood',.3,{lod:0,action:'gather_wood'}),mine=sampleAssetPose(worker,variant,'mine',.3,{lod:0,action:'mine'});
  expect(idle.find(node=>node.nodeId==='axe_head')!.visible).toBe(false);expect(wood.find(node=>node.nodeId==='axe_head')!.visible).toBe(true);expect(mine.find(node=>node.nodeId==='axe_head')!.visible).toBe(false);expect(mine.find(node=>node.nodeId==='pick_head')!.visible).toBe(true);
  expect(posedAssetPoint([0,0,0],'right_hand',variant,wood)).not.toEqual(posedAssetPoint([0,0,0],'right_hand',variant,idle));
});
it('reduced motion freezes locomotion joints while preserving observed attack animation',()=>{
  const art=renderer(),worker=art.create('villager');worker.forcedLod=0;
  const pose=(action:'move'|'attack',seconds:number)=>{
    art.update(worker,{}, {action},action,seconds);art.render(new Vector3(0,5,5));
    return worker.nodes.map(node=>Array.from(node.world.asArray()));
  };
  expect(pose('move',0)).not.toEqual(pose('move',.25));
  art.reducedMotion=true;
  expect(pose('move',.25)).toEqual(pose('move',.6));
  expect(pose('attack',0)).not.toEqual(pose('attack',.25));
  expect(art.metrics.visibleParts).toBeGreaterThan(0);
});
it('same-host asset loading rejects corruption instead of returning a placeholder model',async()=>{
  const text=JSON.stringify(bundle),manifest={schemaVersion:2,contentHash,catalogContentHash:assetCatalogContentHash,bundle:{path:'/art/frontier-assets.json',sha256:sha256(text),bytes:new TextEncoder().encode(text).length}};
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest))).mockResolvedValueOnce(new Response(text));vi.stubGlobal('fetch',fetch);
  expect(Object.keys((await loadAssetBundle()).assets)).toHaveLength(80);expect(fetch.mock.calls[1]![0]).toBe('/art/frontier-assets.json');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify(manifest))).mockResolvedValueOnce(new Response(text+' '));await expect(loadAssetBundle()).rejects.toThrow('integrity');
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({...manifest,contentHash:'old-version'})));await expect(loadAssetBundle()).rejects.toThrow('do not match');
});
it('per-asset frustum rejection avoids posing distant off-screen models and includes them after the camera moves',()=>{
  const art=renderer(),camera=new ArcRotateCamera('inspection',-.8,.8,20,Vector3.Zero(),art.scene),near=art.create('militia'),far=art.create('knight');
  far.root.position.x=500;camera.getViewMatrix();camera.getProjectionMatrix();art.render(camera.position);const first=art.metrics.visibleParts;
  expect(first).toBeGreaterThan(0);near.root.setEnabled(false);art.render(camera.position);expect(art.metrics.visibleParts).toBe(0);
  // A minimap/Home camera jump is applied before scene.render refreshes Babylon's
  // cached matrices. The very first asset pass must use the new viewpoint.
  camera.target.x=500;art.render(camera.position);expect(art.metrics.visibleParts).toBeGreaterThan(first);
});

it('structure upgrades retain the logical root, ownership and shared draw batching',()=>{
  const art=renderer(),instance=art.create('grand_citadel',{age:5,color:TEAM_IDENTITIES[0]!.color}),root=instance.root;
  root.position.set(10,0,20);art.update(instance,{}, {state:'damaged',damage:.3});art.render(new Vector3(10,20,40));
  art.replace(instance,'runic_citadel');
  expect(instance.root).toBe(root);expect(instance.root.position.asArray()).toEqual([10,0,20]);expect(instance.asset.id).toBe('runic_citadel');expect(instance.context.damage).toBe(.3);expect(instance.appearance.color).toBe(TEAM_IDENTITIES[0]!.color);
  art.update(instance,{roofFade:true});art.render(new Vector3(10,20,40));expect(activeMaterials(art).some(material=>material.alpha===.25)).toBe(true);
  art.update(instance,{roofFade:false});art.render(new Vector3(10,20,40));expect(activeMaterials(art).every(material=>material.alpha===1)).toBe(true);
});
