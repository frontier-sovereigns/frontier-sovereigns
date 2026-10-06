import { beforeAll, describe, expect, it } from 'vitest';
import requirements from '../../../data/asset-requirements.json';
import { balance, units, buildings } from '../../shared/src/content.js';
import { sha256 } from '../../shared/src/hash.js';
import { assertAssetBundle, assetNode, chooseVariant, createAssetLibrary, generateBuildingAssets, generateEnvironmentAssets, generateUnitAssets, inspectAssetPose, posedAssetPoint, quaternionFromEuler, sampleAssetPose, validateAssetBundle } from '../src/index.js';
import type { AssetAction, AssetBlueprint, AssetBundle, AssetPoseContext, AssetState, AssetVariant, Lod, Vec3 } from '../src/types.js';

let bundle:AssetBundle;
beforeAll(()=>{const library=createAssetLibrary();bundle=library.finish([...generateBuildingAssets(library),...generateEnvironmentAssets(library),...generateUnitAssets(library)]);assertAssetBundle(bundle);});
const pose=(asset:AssetBlueprint,variant:AssetVariant,context:AssetPoseContext,clip?:string,time=0)=>inspectAssetPose(bundle,asset,variant,context,clip,time);
const signature=(value:ReturnType<typeof inspectAssetPose>)=>sha256(JSON.stringify(value.meshes.map(mesh=>({material:mesh.materialId,positions:mesh.positions.map(number=>Math.round(number*1e6)),indices:mesh.indices}))));
const contextFor=(state:string,lod:Lod):AssetPoseContext=>({lod,state:(state==='open'||state==='closed'?'complete':state) as AssetState,progress:state==='construction'?.45:state==='foundation'?0:1,gate:state==='open'?'open':'closed',farm:'ready',damage:state==='damaged'?.65:0});
function realGeometry(value:ReturnType<typeof inspectAssetPose>,label:string){
  expect(value.triangles,label).toBeGreaterThan(0);expect(value.meshes.length,label).toBeGreaterThan(0);
  for(let axis=0;axis<3;axis++){expect(Number.isFinite(value.bounds.min[axis]),label).toBe(true);expect(value.bounds.max[axis]! - value.bounds.min[axis]!,label).toBeGreaterThan(.001);}
  for(const mesh of value.meshes){expect(mesh.positions.every(Number.isFinite),label).toBe(true);for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i]!*3,b=mesh.indices[i+1]!*3,c=mesh.indices[i+2]!*3,p=mesh.positions,u=[p[b]!-p[a]!,p[b+1]!-p[a+1]!,p[b+2]!-p[a+2]!],v=[p[c]!-p[a]!,p[c+1]!-p[a+1]!,p[c+2]!-p[a+2]!];if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)<1e-10)throw new Error(`DEGENERATE_POSED_TRIANGLE:${label}:${mesh.nodeId}`);}}
}

describe('original building and environment geometry',()=>{
  it('contains exact catalogues with shared reusable geometry, all 62 legal ages and 966 state/LOD uses',()=>{
    expect(Object.values(bundle.assets).filter(asset=>asset.kind==='building').map(asset=>asset.id).sort()).toEqual(requirements.buildingAssets.map(asset=>asset.id).sort());
    expect(Object.values(bundle.assets).filter(asset=>asset.kind==='environment').map(asset=>asset.id).sort()).toEqual([...requirements.environmentAssets].sort());
    expect(requirements.buildingAssets.reduce((sum,item)=>sum+(buildings[item.id]!.minAge<=4?item.ages.filter(age=>age<=4).length:0),0)).toBe(62);
    expect(requirements.buildingAssets.filter(item=>buildings[item.id]!.minAge>=5)).toHaveLength(15);
    expect(requirements.buildingAssets.reduce((sum,item)=>sum+(buildings[item.id]!.minAge<=4?item.ages.filter(age=>age<=4).length:0)*item.requiredStates.length*item.requiredLods.length,0)).toBe(966);
    // State and team variation reuses mesh buffers; it does not duplicate 966 full scenes.
    expect(Object.keys(bundle.geometries).length).toBeLessThan(300);expect(Object.values(bundle.assets).reduce((sum,asset)=>sum+asset.variants.reduce((n,variant)=>n+variant.nodes.filter(node=>node.mesh).length,0),0)).toBeGreaterThan(Object.keys(bundle.geometries).length*20);
  });
  it('reproduces the same geometry, materials, transforms and clips from source',()=>{const library=createAssetLibrary();const again=library.finish([...generateBuildingAssets(library),...generateEnvironmentAssets(library),...generateUnitAssets(library)]);expect(JSON.stringify(again)).toBe(JSON.stringify(bundle));});
  for(const required of requirements.buildingAssets)it(`${required.id}: every legal age/state/LOD has real geometry and authored state changes`,()=>{
    const asset=bundle.assets[required.id]!;expect(asset.variants.map(variant=>variant.age)).toEqual(required.ages);
    const completeSignatures=new Set<string>();
    for(const age of required.ages){const variant=chooseVariant(asset,{age});
      for(const lod of required.requiredLods as Lod[]){const states=new Map<string,string>();
        for(const state of required.requiredStates){const value=pose(asset,variant,contextFor(state,lod),state==='open'||state==='closed'?'gate_open':undefined,state==='open'?.4:0);realGeometry(value,`${required.id}/${age}/${state}/${lod}`);expect(value.triangles).toBeLessThanOrEqual(['town_center','fortress','monument'].includes(required.id)?20000:10000);states.set(state,signature(value));for(let axis=0;axis<3;axis++){expect(value.bounds.min[axis]).toBeGreaterThanOrEqual(asset.bounds.min[axis]!-1e-6);expect(value.bounds.max[axis]).toBeLessThanOrEqual(asset.bounds.max[axis]!+1e-6);}}
        expect(new Set(['foundation','construction','complete','damaged','destroyed'].map(state=>states.get(state))).size,`${required.id}/${age}/${lod}`).toBe(5);
        if(states.has('open'))expect(states.get('open')).not.toBe(states.get('closed'));
      }
      const counts=([0,1,2] as Lod[]).map(lod=>pose(asset,variant,{lod}).triangles);expect(counts[1]!/counts[0]!).toBeLessThanOrEqual(.71);expect(counts[2]).toBeLessThan(counts[1]!);
      completeSignatures.add(signature(pose(asset,variant,{lod:0})));
      expect(variant.nodes.some(node=>node.mesh&&bundle.materials[node.mesh.materialId]!.heraldry),`${required.id}: recognizable team pattern`).toBe(true);
      const early=pose(asset,variant,{lod:0,state:'construction',progress:.1}),late=pose(asset,variant,{lod:0,state:'construction',progress:.9});expect(signature(early)).not.toBe(signature(late));
    }
    expect(completeSignatures.size,`${required.id}: all legal ages need an actual material/mesh change`).toBe(required.ages.length);
    const definition=buildings[required.id]!;expect(asset.collision).toEqual({kind:'footprint',widthM:definition.footprintCells[0]*balance.rules.buildingGridM,depthM:definition.footprintCells[1]*balance.rules.buildingGridM,...(definition.gatePassageWidthM?{gatePassageWidthM:definition.gatePassageWidthM}:{})});
  });
  it('farms visibly distinguish standing grain, cut fields, and construction instead of passive food growth',()=>{
    const asset=bundle.assets.farm!,variant=chooseVariant(asset,{age:4});for(const lod of [0,1,2] as Lod[]){const ready=pose(asset,variant,{lod,farm:'ready'}),exhausted=pose(asset,variant,{lod,farm:'exhausted'});expect(signature(ready)).not.toBe(signature(exhausted));expect(ready.bounds.max[1]).toBeGreaterThan(exhausted.bounds.max[1]!);}
  });
  it('renders orthogonal wall junctions and isolated end caps from actual panel geometry',()=>{
    for(const id of ['palisade_wall','stone_wall']){const asset=bundle.assets[id]!,variant=chooseVariant(asset,{age:4});for(const lod of [0,1,2] as Lod[]){const x=pose(asset,variant,{lod,wallMask:5}),z=pose(asset,variant,{lod,wallMask:10}),corner=pose(asset,variant,{lod,wallMask:3});expect(signature(x)).not.toBe(signature(z));expect(corner.triangles).toBeGreaterThan(x.triangles);}}
  });
  it('opens the same articulated leaves with at least the authoritative four-metre passage at every age and LOD',()=>{
    for(const id of ['wooden_gate','stone_gate']){const asset=bundle.assets[id]!;
      for(const variant of asset.variants)for(const lod of [0,1,2] as Lod[]){const open=pose(asset,variant,{lod,gate:'open'},'gate_open',.4),closed=pose(asset,variant,{lod,gate:'closed'},'gate_open',0);
        expect(open.meshes.map(mesh=>mesh.nodeId)).toEqual(closed.meshes.map(mesh=>mesh.nodeId));
        const intrusions=(value:typeof open)=>value.meshes.filter(mesh=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<mesh.positions.length;i+=3)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis]!,mesh.positions[i+axis]!);max[axis]=Math.max(max[axis]!,mesh.positions[i+axis]!);}return min[0]!<2-1e-6&&max[0]!>-2+1e-6&&min[1]!<3&&max[1]!>.2&&min[2]!<.9&&max[2]!>-.9;});
        expect(intrusions(open).map(mesh=>mesh.nodeId),`${id}/${variant.key}/${lod}`).toEqual([]);expect(intrusions(closed).some(mesh=>mesh.nodeId.startsWith('gate_leaf'))).toBe(true);
      }
    }
  });
  it('wide gates preserve eight metres of visible ground clearance for colossal units at every age and LOD',()=>{
    for(const id of ['bastion_gate','runestone_gate','titan_gate','eternal_gate']){const asset=bundle.assets[id]!;for(const variant of asset.variants)for(const lod of [0,1,2] as Lod[]){const open=pose(asset,variant,{lod,gate:'open'},'gate_open',.7),intrusions=open.meshes.filter(mesh=>{const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];for(let i=0;i<mesh.positions.length;i+=3)for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis]!,mesh.positions[i+axis]!);max[axis]=Math.max(max[axis]!,mesh.positions[i+axis]!);}return min[0]!<4-1e-6&&max[0]!>-4+1e-6&&min[1]!<4&&max[1]!>.2&&min[2]!<.9&&max[2]!>-.9;});expect(intrusions.map(mesh=>mesh.nodeId),`${id}/${variant.key}/${lod}`).toEqual([]);}}
  });
  for(const id of requirements.environmentAssets)it(`${id}: every environment LOD contains finite non-flat geometry`,()=>{const asset=bundle.assets[id]!,variant=asset.variants[0]!;for(const lod of [0,1,2] as Lod[])realGeometry(pose(asset,variant,{lod},asset.clips.some(clip=>clip.id==='idle')?'idle':undefined,.4),`${id}/${lod}`);});
  it('samples all visible smoke/fire/dust lobes together rather than declaring an unused effect clip',()=>{
    for(const id of ['smoke','fire','dust']){const asset=bundle.assets[id]!,variant=asset.variants[0]!;for(const lod of [0,1,2] as Lod[])expect(signature(pose(asset,variant,{lod},'idle',.1))).not.toBe(signature(pose(asset,variant,{lod},'idle',.7)));}
  });
  it('exposes substantial gold ore on the actual top surface at every LOD, distinct from stone',()=>{
    const gold=bundle.assets.gold_deposit!,stone=bundle.assets.stone_quarry!;
    for(const lod of [0,1,2] as Lod[]){
      const value=pose(gold,gold.variants[0]!,{lod}),triangles=value.meshes.flatMap(mesh=>Array.from({length:mesh.indices.length/3},(_,index)=>({material:mesh.materialId,points:mesh.indices.slice(index*3,index*3+3).map(vertex=>mesh.positions.slice(vertex*3,vertex*3+3))})));
      let occupied=0,exposedGold=0;
      // Orthographic top rays choose the highest actual triangle, so a material
      // merely declared in the scene or buried below stone cannot pass this check.
      for(let iz=0;iz<48;iz++)for(let ix=0;ix<48;ix++){
        const x=value.bounds.min[0]!+(ix+.5)/48*(value.bounds.max[0]!-value.bounds.min[0]!),z=value.bounds.min[2]!+(iz+.5)/48*(value.bounds.max[2]!-value.bounds.min[2]!);
        let height=-Infinity,material='';
        for(const triangle of triangles){const [a,b,c]=triangle.points,den=(b![2]!-c![2]!)*(a![0]!-c![0]!)+(c![0]!-b![0]!)*(a![2]!-c![2]!);if(Math.abs(den)<1e-12)continue;
          const u=((b![2]!-c![2]!)*(x-c![0]!)+(c![0]!-b![0]!)*(z-c![2]!))/den,v=((c![2]!-a![2]!)*(x-c![0]!)+(a![0]!-c![0]!)*(z-c![2]!))/den,w=1-u-v;
          if(Math.min(u,v,w)<-1e-9)continue;const y=u*a![1]!+v*b![1]!+w*c![1]!;if(y>height){height=y;material=triangle.material;}
        }
        if(material){occupied++;if(material==='fs_gold')exposedGold++;}
      }
      expect(occupied).toBeGreaterThan(100);expect(exposedGold/occupied,`Visible gold surface at LOD ${lod}`).toBeGreaterThan(.06);
      expect(pose(stone,stone.variants[0]!,{lod}).meshes.some(mesh=>mesh.materialId==='fs_gold')).toBe(false);
      expect(signature(value)).not.toBe(signature(pose(stone,stone.variants[0]!,{lod})));
    }
  });
});

describe('articulated unit meshes',()=>{
  it('authored projectile socket heights match the data at launch for later siege, the mobile turret and citadels',()=>{
    for(const definition of [...Object.values(units),...Object.values(buildings)].filter(definition=>definition.minAge>=5&&(definition.projectileLaunchHeightM||'turret'in definition&&definition.turret))){
      const asset=bundle.assets[definition.id]!,turret='turret'in definition?definition.turret:undefined,height=turret?.projectileLaunchHeightM??definition.projectileLaunchHeightM!;
      for(const variant of asset.variants){const clip=asset.kind==='unit'?(turret?'turret':'attack'):undefined,poses=sampleAssetPose(asset,variant,clip,0,{lod:0,action:clip as AssetAction|undefined}),point=posedAssetPoint([0,0,0],asset.sockets.projectile!,variant,poses);expect(Math.abs(point[1]-height),definition.id+'/'+variant.key).toBeLessThanOrEqual(.0005);}
    }
  });
  it('siege stones remain in their slings during windup and disappear only on release, retaining real finite poses',()=>{
    for(const id of ['warwolf_trebuchet','rune_catapult','worldbreaker_trebuchet']){const asset=bundle.assets[id]!,variant=asset.variants[0]!,stone=id==='rune_catapult'?'rune_boulder':'sling_boulder',windup=sampleAssetPose(asset,variant,'windup',.5,{lod:0,action:'windup'}),released=sampleAssetPose(asset,variant,'attack',.15,{lod:0,action:'attack'});expect(windup.find(node=>node.nodeId===stone)?.visible).toBe(true);expect(released.find(node=>node.nodeId===stone)?.visible).toBe(false);realGeometry(pose(asset,variant,{lod:0,action:'attack'},'attack',.15),id+'/released');}
  });
  it('keeps the catapult cup behind +Z travel and throws forward at every age and LOD',()=>{
    const asset=bundle.assets.catapult!;
    for(const variant of asset.variants)for(const lod of [0,1,2] as Lod[]){
      // Inspect actual mesh bounds, including the hierarchy and animated joints.
      const center=(clip:string,time:number)=>{const mesh=pose(asset,variant,{lod,action:clip as AssetAction},clip,time).meshes.find(mesh=>mesh.nodeId==='ammunition')!;return [0,1,2].map(axis=>{const values=mesh.positions.filter((_,index)=>index%3===axis);return (Math.min(...values)+Math.max(...values))/2;});};
      for(const clip of ['idle','move'])for(const time of [0,.25,.7])expect(center(clip,time)[2],`${variant.key}/${lod}/${clip}: stored stone is rearward`).toBeLessThan(-1);
      const loaded=center('attack',.35),releasing=center('attack',.44);
      expect(releasing[2]!-loaded[2]!,`${variant.key}/${lod}: forward throw`).toBeGreaterThan(.4);
      expect(releasing[1]!-loaded[1]!,`${variant.key}/${lod}: rising throw`).toBeGreaterThan(1);
      for(const sign of [-1,1])for(const end of [-1,1]){
        const wheel=`wheel_${sign}_${end}`,before=sampleAssetPose(asset,variant,'move',0,{lod,action:'move'}),after=sampleAssetPose(asset,variant,'move',.01,{lod,action:'move'});
        // Local +X is the wheel's top at rest: its surface must roll forward.
        const first=posedAssetPoint([.44,0,0],wheel,variant,before),next=posedAssetPoint([.44,0,0],wheel,variant,after);
        expect(next[2]-first[2],`${variant.key}/${lod}/${wheel}: forward rolling`).toBeGreaterThan(0);
      }
    }
  });
  for(const required of requirements.unitAssets)it(`${required.id}: required actions deform visible meshes at all three LODs`,()=>{
    const asset=bundle.assets[required.id]!;expect(asset.kind).toBe('unit');
    for(const action of required.requiredAnimations){const clip=asset.clips.find(item=>item.id===action);expect(clip,`${required.id}/${action}`).toBeDefined();
      for(const lod of required.requiredLods as Lod[]){const variant=chooseVariant(asset,{age:4,tier:'elite'}),context={lod,action:action as AssetAction};const samples=[0,.19,.43,.71].map(fraction=>pose(asset,variant,context,action,clip!.durationSeconds*fraction));for(const value of samples)realGeometry(value,`${required.id}/${action}/${lod}`);
        if(action==='packed'){expect(signature(samples[0]!)).not.toBe(signature(pose(asset,variant,{lod,action:'deploy'},'deploy',4)));}else expect(new Set(samples.map(signature)).size,`${required.id}/${action}/${lod}`).toBeGreaterThan(1);
      }
    }
    const limit=['battering_ram','catapult','trebuchet'].includes(required.id)?6000:['scout','light_cavalry','knight'].includes(required.id)?5000:2500;
    for(const variant of asset.variants){const values=([0,1,2] as Lod[]).map(lod=>pose(asset,variant,{lod}));expect(values[0]!.triangles).toBeLessThanOrEqual(limit);expect(values[1]!.triangles).toBeLessThan(values[0]!.triangles);expect(values[2]!.triangles).toBeLessThan(values[1]!.triangles);for(const value of values)for(let axis=0;axis<3;axis++){expect(value.bounds.min[axis]).toBeGreaterThanOrEqual(asset.bounds.min[axis]!-1e-6);expect(value.bounds.max[axis]).toBeLessThanOrEqual(asset.bounds.max[axis]!+1e-6);}}
    expect(asset.collision).toEqual({kind:'circle',radiusM:units[required.id]!.collisionRadiusM});
    expect(asset.variants.every(variant=>variant.nodes.some(node=>node.mesh&&bundle.materials[node.mesh.materialId]!.teamTint))).toBe(true);
  });
  it('covers 192 required unit action/LOD uses and keeps pose sampling immutable',()=>{expect(requirements.unitAssets.filter(item=>units[item.id]!.minAge<=4).reduce((sum,item)=>sum+item.requiredAnimations.length*item.requiredLods.length,0)).toBe(192);const asset=bundle.assets.villager!,original=JSON.stringify(asset);sampleAssetPose(asset,asset.variants[0]!,'move',.3,{lod:0});expect(JSON.stringify(asset)).toBe(original);});
});

function smallBundle():AssetBundle{const library=createAssetLibrary(),geometry=library.box([1,1,1]);library.material({id:'stone',baseColor:[.5,.5,.5,1]});return library.finish([{id:'fixture',kind:'environment',variants:[{key:'base',nodes:[assetNode('root'),assetNode('child',{parentId:'root',mesh:{geometry:[geometry,geometry,geometry],materialId:'stone'}})]}],clips:[{id:'move',durationSeconds:1,loop:true,tracks:[{nodeId:'child',property:'position',times:[0,1],values:[[0,0,0],[0,1,0]]}]}],sockets:{root:'root'},bounds:{min:[-1,-1,-1],max:[1,2,1]}}]);}
describe('strict geometry decoder rejects broken actual assets',()=>{
  const mutations:Record<string,(value:AssetBundle)=>void>={
    'nonfinite vertex':value=>{Object.values(value.geometries)[0]!.positions[0]=NaN;},
    'out-of-range index':value=>{Object.values(value.geometries)[0]!.indices[0]=1e9;},
    'degenerate triangle':value=>{const geometry=Object.values(value.geometries)[0]!;geometry.indices[1]=geometry.indices[0]!;},
    'invalid normal':value=>{Object.values(value.geometries)[0]!.normals[0]=7;},
    'missing material':value=>{value.assets.fixture!.variants[0]!.nodes[1]!.mesh!.materialId='missing';},
    'missing geometry':value=>{value.assets.fixture!.variants[0]!.nodes[1]!.mesh!.geometry[1]='missing';},
    'empty all LODs':value=>{value.assets.fixture!.variants[0]!.nodes[1]!.mesh!.geometry=[null,null,null];},
    'parent cycle':value=>{value.assets.fixture!.variants[0]!.nodes[0]!.parentId='child';},
    'missing parent':value=>{value.assets.fixture!.variants[0]!.nodes[1]!.parentId='missing';},
    'duplicate node':value=>{value.assets.fixture!.variants[0]!.nodes.push(structuredClone(value.assets.fixture!.variants[0]!.nodes[1]!));},
    'invalid quaternion':value=>{value.assets.fixture!.variants[0]!.nodes[1]!.rotation=[0,0,0,0];},
    'missing animated node':value=>{value.assets.fixture!.clips[0]!.tracks[0]!.nodeId='missing';},
    'time beyond clip':value=>{value.assets.fixture!.clips[0]!.tracks[0]!.times[1]=2;},
    'duplicate times':value=>{value.assets.fixture!.clips[0]!.tracks[0]!.times[1]=0;},
    'invalid UV count':value=>{Object.values(value.geometries)[0]!.uvs=[0,0];},
    'unknown metadata':value=>{(value.assets.fixture as unknown as Record<string,unknown>).final=true;},
  };
  for(const [name,mutate]of Object.entries(mutations))it(name,()=>{const value=smallBundle();expect(validateAssetBundle(value)).toBe(true);mutate(value);expect(validateAssetBundle(value)).toBe(false);});
  it('detects a static required action by sampling actual transformed vertices',()=>{const value=smallBundle(),asset=value.assets.fixture!;asset.clips[0]!.tracks[0]!.values=[[0,0,0],[0,0,0]];expect(validateAssetBundle(value)).toBe(true);const a=inspectAssetPose(value,asset,asset.variants[0]!,{lod:0},'move',0),b=inspectAssetPose(value,asset,asset.variants[0]!,{lod:0},'move',.5);expect(signature(a)).toBe(signature(b));});
  it('composes quaternion hierarchy transforms with nonuniform scale against a known vertex',()=>{const value=smallBundle(),asset=value.assets.fixture!,variant=asset.variants[0]!;variant.nodes[0]!.rotation=quaternionFromEuler(0,Math.PI/2,0);variant.nodes[0]!.position=[4,2,3];variant.nodes[1]!.position=[1,0,0];variant.nodes[1]!.scale=[2,1,1];const result=inspectAssetPose(value,asset,variant,{lod:0});expect(result.bounds.min[0]).toBeCloseTo(3.5);expect(result.bounds.max[0]).toBeCloseTo(4.5);expect(result.bounds.min[2]).toBeCloseTo(1);expect(result.bounds.max[2]).toBeCloseTo(3);});
  it('maps each heraldic box face across one continuous quad instead of repeating the pattern on both triangles',()=>{const geometry=Object.values(smallBundle().geometries)[0]!;for(let face=0;face<6;face++)expect(geometry.uvs!.slice(face*12,face*12+12)).toEqual([0,0,1,0,1,1,0,0,1,1,0,1]);});
});
