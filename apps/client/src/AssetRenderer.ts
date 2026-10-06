import { Matrix, Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Frustum } from '@babylonjs/core/Maths/math.frustum';
import { Ray } from '@babylonjs/core/Culling/ray';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { Scene } from '@babylonjs/core/scene';
import type { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import { assertAssetBundle, chooseVariant, sampleAssetPose, sampleAssetTrack, visibleAssetNode, type AssetBlueprint, type AssetBundle, type AssetClip, type AssetPoseContext, type AssetVariant, type Lod } from '@frontier/assets';
import { contentHash, assetCatalogContentHash } from '@frontier/shared';
import { sha256 } from '../../../packages/shared/src/hash';
import requirements from '../../../data/asset-requirements.json';

export interface AssetAppearance { age?: number; tier?: string; color?: string; pattern?: number; ghost?: boolean; opacity?: number; depletedFood?: boolean; roofFade?:boolean }
interface PoseNode { local: Matrix; world: Matrix; position: Vector3; rotation: Quaternion; scale: Vector3; visible: boolean; parent: number }
export interface AssetInstance {
  readonly root: TransformNode; asset: AssetBlueprint; variant: AssetVariant;
  appearance: AssetAppearance; context: AssetPoseContext; clip?: string; seconds: number;
  forcedLod?: Lod; pickable: boolean; nodes: PoseNode[]; signature: string;
}
interface Batch { mesh: Mesh; capacity: number; matrices: Float32Array; count: number; used: number }
export interface AssetDrawEvidence {clip:string;sampleTime:number;drawn:boolean}

/** Fetch the original geometry from this host, with manifest/content integrity checked
 * before a player sends the server's loaded acknowledgement. No fallback model exists. */
export async function loadAssetBundle(signal?: AbortSignal): Promise<AssetBundle> {
  const response = await fetch('/asset-manifest.json', { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('The host asset manifest could not be loaded.');
  const manifest = await response.json() as { schemaVersion?: number; contentHash?: string; catalogContentHash?:string; bundle?: { path?: string; sha256?: string; bytes?: number } };
  if (manifest.schemaVersion !== 2 || manifest.contentHash !== contentHash || manifest.catalogContentHash!==assetCatalogContentHash || !manifest.bundle || !/^\/art\/[a-z0-9_.-]+\.json$/.test(manifest.bundle.path ?? '') || !/^[a-f0-9]{64}$/.test(manifest.bundle.sha256 ?? '') || !Number.isSafeInteger(manifest.bundle.bytes) || manifest.bundle.bytes! > 64 * 1024 * 1024) throw new Error('The host assets do not match this version of the game.');
  const assetResponse = await fetch(manifest.bundle.path!, { signal });
  if (!assetResponse.ok) throw new Error('The host 3D asset library could not be loaded.');
  const text = await assetResponse.text();
  if (new TextEncoder().encode(text).length !== manifest.bundle.bytes || sha256(text) !== manifest.bundle.sha256) throw new Error('The 3D asset integrity check failed. Reload after the host rebuilds its assets.');
  const bundle: unknown = JSON.parse(text);
  assertAssetBundle(bundle);
  for (const id of [...requirements.unitAssets.map(asset=>asset.id),...requirements.buildingAssets.map(asset=>asset.id),...requirements.environmentAssets]) if(!bundle.assets[id]) throw new Error(`The host asset library is incomplete: ${id}`);
  return bundle;
}

/** One stable logical root per entity; geometry and GPU draw calls are shared across
 * posed parts. Thin instances carry the actual joint matrices, including all LODs. */
export class AssetRenderer {
  readonly instances = new Map<TransformNode, AssetInstance>();
  private readonly sources = new Map<string, Mesh>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly batches = new Map<string, Batch>();
  private frame = 0;
  private cpuMs = 0;
  private drawnUnits = 0;
  private drawnStructures = 0;
  quality: 'low'|'medium'|'high' = 'high';
  reducedMotion = false;
  constructor(readonly scene: Scene, readonly bundle: AssetBundle, private readonly shadows?: ShadowGenerator) {}

  /** Upgrade a model while preserving the logical entity root, selection and
   * motion history. Shared source meshes and batched rendering remain intact. */
  replace(instance:AssetInstance,id:string):void {
    if(instance.asset.id===id)return;
    const asset=this.bundle.assets[id];if(!asset)throw new Error(`Missing required 3D asset: ${id}`);
    instance.asset=asset;instance.signature='';instance.variant=chooseVariant(asset,instance.appearance);instance.nodes=[];
    this.update(instance,instance.appearance,instance.context,instance.clip,instance.seconds);
  }
  create(id: string, appearance: AssetAppearance = {}, parent?: TransformNode): AssetInstance {
    const asset = this.bundle.assets[id];
    if (!asset) throw new Error(`Missing required 3D asset: ${id}`);
    const root = new TransformNode(id, this.scene); root.parent = parent ?? null;
    const instance: AssetInstance = { root, asset, variant: chooseVariant(asset, appearance), appearance, context: { lod: 0 }, seconds: 0, pickable: true, nodes: [], signature: '' };
    this.instances.set(root, instance); root.onDisposeObservable.add(() => this.instances.delete(root));
    this.update(instance, appearance); return instance;
  }

  update(instance: AssetInstance, appearance: AssetAppearance, context: Partial<AssetPoseContext> = {}, clip?: string, seconds = instance.seconds): void {
    instance.appearance = { ...instance.appearance, ...appearance }; instance.context = { ...instance.context, ...context }; instance.clip = clip; instance.seconds = seconds;
    const signature = `${instance.appearance.age ?? 1}:${instance.appearance.tier ?? 'base'}`;
    const variant = instance.signature === signature ? instance.variant : chooseVariant(instance.asset, instance.appearance);
    if (instance.signature !== signature || !instance.nodes.length) {
      instance.signature = signature;
      instance.variant = variant; const indices = new Map(variant.nodes.map((node,index)=>[node.id,index]));
      instance.nodes = variant.nodes.map(node=>({local:Matrix.Identity(),world:Matrix.Identity(),position:Vector3.FromArray(node.position),rotation:Quaternion.FromArray(node.rotation),scale:Vector3.FromArray(node.scale),visible:true,parent:node.parentId?indices.get(node.parentId)!:-1}));
      instance.root.metadata = { ...instance.root.metadata, appearance: `${instance.asset.id}:${signature}`, assetVariant: variant.key };
    }
  }

  /** Pointer-only narrow phase. The catalogue envelope covers every age, so empty
   * space above an early roof must not intercept a visible entity behind it. */
  pickDistance(instance: AssetInstance, ray: Ray, limit = Infinity): number | null {
    const clip = instance.asset.clips.find(entry => entry.id === instance.clip);
    const time = this.reducedMotion && ['idle', 'move', 'carry'].includes(instance.clip ?? '') ? 0 : clip?.loop ? instance.seconds % clip.durationSeconds : Math.max(0, Math.min(clip?.durationSeconds ?? 0, instance.seconds));
    const poses = sampleAssetPose(instance.asset, instance.variant, instance.clip, Math.round(time * 30) / 30, instance.context);
    const matrices = new Map<string, Matrix>(), indices = new Map(instance.variant.nodes.map((node, index) => [node.id, index]));
    const root = instance.root.computeWorldMatrix(true), a = Vector3.Zero(), b = Vector3.Zero(), c = Vector3.Zero();
    const matrixAt = (index: number): Matrix => {
      const node = instance.variant.nodes[index]!, cached = matrices.get(node.id); if (cached) return cached;
      const pose = poses[index]!, local = Matrix.Compose(Vector3.FromArray(pose.scale), Quaternion.FromArray(pose.rotation), Vector3.FromArray(pose.position));
      const matrix = local.multiply(node.parentId ? matrixAt(indices.get(node.parentId)!) : root); matrices.set(node.id, matrix); return matrix;
    };
    let nearest = limit, found = false;
    for (let index = 0; index < instance.variant.nodes.length; index++) {
      const node = instance.variant.nodes[index]!, geometryId = node.mesh?.geometry[instance.context.lod];
      if (!geometryId || !poses[index]!.visible) continue;
      const matrix = matrixAt(index); if (Math.abs(matrix.determinant()) < 1e-12) continue;
      if(instance.appearance.roofFade&&matrix.m[13]!>instance.root.getAbsolutePosition().y+6)continue;
      const inverse = matrix.clone().invert(), localRay = new Ray(Vector3.TransformCoordinates(ray.origin, inverse), Vector3.TransformNormal(ray.direction, inverse));
      const geometry = this.bundle.geometries[geometryId]!;
      for (let triangle = 0; triangle < geometry.indices.length; triangle += 3) {
        Vector3.FromArrayToRef(geometry.positions, geometry.indices[triangle]! * 3, a);
        Vector3.FromArrayToRef(geometry.positions, geometry.indices[triangle + 1]! * 3, b);
        Vector3.FromArrayToRef(geometry.positions, geometry.indices[triangle + 2]! * 3, c);
        const hit = localRay.intersectsTriangle(a, b, c);
        if (hit && hit.distance >= 0 && hit.distance < nearest) { nearest = hit.distance; found = true; }
      }
    }
    return found ? nearest : null;
  }

  private material(id: string, appearance: AssetAppearance, depletedFood = false): StandardMaterial {
    const definition = this.bundle.materials[id]!;
    const opacity = Math.max(0,Math.min(1,Math.round((appearance.opacity ?? 1)*8)/8));
    // Empty food remains recognizable in the filtered view without changing its
    // geometry or hiding a farm's faction trim. Replenishment reuses normal batches.
    const depleted = depletedFood && !definition.teamTint;
    const key = `${id}:${definition.teamTint ? appearance.color ?? '' : ''}:${definition.heraldry ? `${appearance.pattern ?? 0}:${this.quality}` : ''}:${appearance.ghost ? 'ghost' : opacity}:${depleted ? 'empty-food' : ''}`;
    let material = this.materials.get(key); if (material) return material;
    material = new StandardMaterial(`art-${key}`,this.scene);
    const base = depleted ? Color3.FromArray(this.bundle.materials.fs_food_exhausted!.baseColor) : definition.teamTint ? Color3.FromHexString(appearance.color ?? '#8ac6bd').multiply(Color3.FromArray(definition.baseColor)) : Color3.FromArray(definition.baseColor);
    material.diffuseColor = base; material.specularColor.setAll(.08); material.alpha = (appearance.ghost ? .32 : opacity) * definition.baseColor[3];
    if (definition.emissive) material.emissiveColor = Color3.FromArray(definition.emissive);
    if (definition.heraldry && typeof document !== 'undefined') {
      const resolution={low:32,medium:64,high:128}[this.quality],texture = new DynamicTexture(`heraldry-${key}`,{width:resolution,height:resolution},this.scene,false), context=texture.getContext(), pattern=appearance.pattern??0;
      context.scale(resolution/64,resolution/64);
      context.fillStyle=base.toHexString();context.fillRect(0,0,64,64);const linear=base.toLinearSpace(),ink=linear.r*.2126+linear.g*.7152+linear.b*.0722>.18?'#152623':'#fff8df';context.strokeStyle=ink;context.fillStyle=ink;context.lineWidth=7;
      const line=(x:number,y:number,a:number,b:number)=>{context.beginPath();context.moveTo(x,y);context.lineTo(a,b);context.stroke();};
      if(pattern===0)line(8,56,56,8);else if(pattern===1){line(32,7,32,57);line(7,32,57,32);}else if(pattern===2){line(8,46,32,17);line(32,17,56,46);}else if(pattern===3){for(const y of [15,32,49])line(7,y,57,y);}else if(pattern===4){line(9,9,55,55);line(55,9,9,55);}else if(pattern===5){for(const x of [17,32,47])for(const y of [17,32,47]){context.beginPath();context.arc(x,y,4,0,Math.PI*2);context.fill();}}else if(pattern===6){context.beginPath();context.moveTo(32,8);context.lineTo(56,32);context.lineTo(32,56);context.lineTo(8,32);context.closePath();context.stroke();}else if(pattern===7){line(9,53,26,53);line(26,53,26,33);line(26,33,43,33);line(43,33,43,11);}else if(pattern===8){for(let i=0;i<8;i++)line(32+Math.cos(i*Math.PI/4)*10,32+Math.sin(i*Math.PI/4)*10,32+Math.cos(i*Math.PI/4)*25,32+Math.sin(i*Math.PI/4)*25);}else if(pattern===9){context.beginPath();context.moveTo(32,8);context.lineTo(56,54);context.lineTo(8,54);context.closePath();context.stroke();}else for(const radius of [10,22]){context.beginPath();context.arc(32,32,radius,0,Math.PI*2);context.stroke();}
      texture.update(); material.diffuseTexture=texture;material.diffuseColor=Color3.White();
    }
    this.materials.set(key,material);return material;
  }

  private batch(geometryId:string,material:StandardMaterial,shadow:boolean):Batch {
    const key=`${geometryId}:${material.uniqueId}:${shadow}`;
    let batch=this.batches.get(key);if(batch)return batch;
    let source=this.sources.get(geometryId);
    if(!source){
      const data=this.bundle.geometries[geometryId]!;source=new Mesh(`source-${geometryId}`,this.scene);const vertex=new VertexData();vertex.positions=data.positions;vertex.normals=data.normals;
      // Recipes use outward mathematical cross-product normals. Babylon's default
      // left-handed front-face convention requires the opposite triangle winding.
      const indices=[...data.indices];for(let i=0;i<indices.length;i+=3){const second=indices[i+1]!;indices[i+1]=indices[i+2]!;indices[i+2]=second;}vertex.indices=indices;
      if(data.uvs)vertex.uvs=data.uvs;vertex.applyToMesh(source);source.setEnabled(false);source.isPickable=false;this.sources.set(geometryId,source);
    }
    const mesh=source.clone(`batch-${key}`,null,true)!;
    // Babylon stores world0..3 attributes on Geometry. Each material batch needs its
    // own attribute set; sharing that Geometry would overwrite another batch's poses.
    // All entities in this batch still share one vertex/index allocation and draw call.
    mesh.makeGeometryUnique();mesh.setEnabled(true);mesh.material=material;mesh.isPickable=false;mesh.receiveShadows=true;mesh.alwaysSelectAsActiveMesh=true;mesh.doNotSyncBoundingInfo=true;
    batch={mesh,capacity:16,matrices:new Float32Array(16*16),count:0,used:0};mesh.thinInstanceSetBuffer('matrix',batch.matrices,16,false);mesh.thinInstanceCount=0;
    if(shadow)this.shadows?.addShadowCaster(mesh);this.batches.set(key,batch);return batch;
  }

  /** Call once before scene.render(). Animation time is supplied by World from the
   * filtered tick; this renderer never runs gameplay clocks or reads enemy orders. */
  render(cameraPosition:Vector3,submitted?:Map<AssetInstance,AssetDrawEvidence>):(()=>void)|undefined {
    const started = performance.now();
    submitted?.clear();
    const diagnosticBatches=submitted?new Map<Batch,Array<{pose:AssetDrawEvidence;remaining:number}>>():undefined;
    this.drawnUnits=0;this.drawnStructures=0;
    this.frame++;for(const batch of this.batches.values())batch.count=0;
    // This pass precedes scene.render. Refresh the cache-aware matrices after a
    // camera jump so culling and the scene draw use the same current viewpoint.
    const camera=this.scene.activeCamera;
    if(camera){camera.getViewMatrix();camera.getProjectionMatrix();}
    const planes=camera?Frustum.GetPlanes(camera.getTransformationMatrix()):null;
    let shadowUnits=0;
    const localPoses = new Map<string,{geometry:string;materialId:string;matrix:Matrix}[]>(), frameMaterials = new Map<string,Map<string,StandardMaterial>>(), world = Matrix.Identity();
    for(const instance of this.instances.values()){
      if(!instance.root.isEnabled())continue;
      const origin=instance.root.getAbsolutePosition(),distance=Vector3.Distance(cameraPosition,origin);
      const rootMatrix=instance.root.computeWorldMatrix(true),bounds=instance.asset.bounds;
      if(planes){
        const center=Vector3.TransformCoordinates(new Vector3(...bounds.min.map((value,index)=>(value+bounds.max[index]!)/2) as [number,number,number]),rootMatrix);
        const scale=Math.max(Math.hypot(rootMatrix.m[0]!,rootMatrix.m[1]!,rootMatrix.m[2]!),Math.hypot(rootMatrix.m[4]!,rootMatrix.m[5]!,rootMatrix.m[6]!),Math.hypot(rootMatrix.m[8]!,rootMatrix.m[9]!,rootMatrix.m[10]!));
        // Static bounds are selection volumes. Additional height and two metres
        // conservatively include raised weapons, fallen rigs and nearby shadows.
        const radius=(Math.hypot(...bounds.max.map((value,index)=>value-bounds.min[index]!))/2+(bounds.max[1]-bounds.min[1])+2)*scale;
        if(planes.some(plane=>plane.dotCoordinate(center)<-radius))continue;
      }
      if(instance.asset.kind==='unit')this.drawnUnits++;else if(instance.asset.kind==='building')this.drawnStructures++;
      const lod: Lod = instance.forcedLod ?? (distance>(this.quality==='low'?40:85)?2:distance>(this.quality==='high'?48:30)?1:0);
      instance.context.lod=lod;
      const clip:AssetClip|undefined=instance.asset.clips.find(c=>c.id===instance.clip);
      const time=this.reducedMotion && (instance.clip==='idle'||instance.clip==='move'||instance.clip==='carry')?0:clip?.loop?instance.seconds%clip.durationSeconds:Math.max(0,Math.min(clip?.durationSeconds??0,instance.seconds));
      const context=instance.context, sampleTime=Math.round(time*30)/30;
      const poseKey=`${instance.asset.id}:${instance.variant.key}:${lod}:${clip?.id??''}:${sampleTime}:${context.state}:${context.progress}:${context.damage}:${context.farm}:${context.gate}:${context.wallMask}:${context.action}:${context.cargo}`;
      let parts=localPoses.get(poseKey);
      if(!parts){
        const tracks=clip?new Map(clip.tracks.map(track=>[`${track.nodeId}:${track.property}`,track])):null,nodes=instance.variant.nodes,resolved=new Set<number>();
        const resolve=(index:number):void=>{
          if(resolved.has(index))return;const node=nodes[index]!,pose=instance.nodes[index]!;
          pose.position.copyFromFloats(...node.position);pose.rotation.copyFromFloats(...node.rotation);pose.scale.copyFromFloats(...node.scale);pose.visible=visibleAssetNode(node.visibility,context);
          for(const property of ['position','rotation','scale'] as const){const track=tracks?.get(`${node.id}:${property}`);if(track){const values=sampleAssetTrack(track,sampleTime);if(property==='rotation')pose.rotation.copyFromFloats(values[0],values[1],values[2],values[3]!);else pose[property].copyFromFloats(values[0],values[1],values[2]);}}
          Matrix.ComposeToRef(pose.scale,pose.rotation,pose.position,pose.local);
          if(pose.parent>=0){resolve(pose.parent);pose.local.multiplyToRef(instance.nodes[pose.parent]!.world,pose.world);pose.visible&&=instance.nodes[pose.parent]!.visible;}else pose.world.copyFrom(pose.local);
          resolved.add(index);
        };
        parts=[];for(let i=0;i<nodes.length;i++){const node=nodes[i]!,geometry=node.mesh?.geometry[lod];if(!geometry)continue;resolve(i);if(instance.nodes[i]!.visible)parts.push({geometry,materialId:node.mesh!.materialId,matrix:instance.nodes[i]!.world.clone()});}
        localPoses.set(poseKey,parts);
      }
      const appearance=instance.appearance,depletedFood=appearance.depletedFood??(instance.asset.id==='farm'&&(context.farm==='exhausted'||context.farm==='reseeding')),materialKey=`${appearance.color}:${appearance.pattern}:${appearance.ghost}:${Math.round((appearance.opacity??1)*8)}:${depletedFood}:${this.quality}:${!!appearance.roofFade}`;
      let palette=frameMaterials.get(materialKey);if(!palette){palette=new Map();frameMaterials.set(materialKey,palette);}
      const shadow=this.quality!=='low'&&!instance.appearance.ghost&&lod===0&&(instance.asset.kind!=='unit'||shadowUnits++<80);
      const instanceBatches=submitted?new Set<Batch>():undefined;
      for(const part of parts){
        const fade=appearance.roofFade&&part.matrix.m[13]!>6,key=part.materialId+(fade?':roof':'');
        let material=palette.get(key);if(!material){material=this.material(part.materialId,fade?{...appearance,opacity:.25}:appearance,depletedFood);palette.set(key,material);}
        const batch=this.batch(part.geometry,material,shadow);
        instanceBatches?.add(batch);
        if(batch.count>=batch.capacity){batch.capacity*=2;const matrix=new Float32Array(batch.capacity*16);matrix.set(batch.matrices);batch.matrices=matrix;batch.mesh.thinInstanceSetBuffer('matrix',matrix,16,false);}
        part.matrix.multiplyToRef(rootMatrix,world);world.copyToArray(batch.matrices,batch.count++*16);batch.used=this.frame;
      }
      if(parts.length&&submitted&&instanceBatches&&diagnosticBatches){
        const pose:AssetDrawEvidence={clip:clip?.id??'idle',sampleTime,drawn:false},proof={pose,remaining:instanceBatches.size};submitted.set(instance,pose);
        for(const batch of instanceBatches){let proofs=diagnosticBatches.get(batch);if(!proofs){proofs=[];diagnosticBatches.set(batch,proofs);}proofs.push(proof);}
      }

    }
    for(const [key,batch] of this.batches){batch.mesh.thinInstanceCount=batch.count;batch.mesh.setEnabled(batch.count>0);if(batch.count)batch.mesh.thinInstanceBufferUpdated('matrix');else if(this.frame-batch.used>600){this.shadows?.removeShadowCaster(batch.mesh);batch.mesh.dispose();this.batches.delete(key);}}
    this.cpuMs = performance.now()-started;
    if(diagnosticBatches){
      // CPU buffer preparation alone is insufficient: an unready material can
      // skip its draw while the scene still reaches onAfterRender. Every visible
      // part must pass the actual main-scene draw seam, excluding shadow passes.
      const cleanup:Array<()=>void>=[];
      for(const [batch,proofs] of diagnosticBatches){let seen=false;const observer=batch.mesh.onBeforeDrawObservable.add(()=>{
        if(seen||this.scene._isInIntermediateRendering())return;seen=true;for(const proof of proofs)if(--proof.remaining===0)proof.pose.drawn=true;
      });cleanup.push(()=>batch.mesh.onBeforeDrawObservable.remove(observer));}
      return ()=>{for(const remove of cleanup)remove();};
    }
  }
  get metrics():{instances:number;batches:number;visibleParts:number;triangles:number;cpuMs:number;drawnUnits:number;drawnStructures:number}{let visibleParts=0,triangles=0;for(const batch of this.batches.values()){visibleParts+=batch.count;triangles+=batch.count*batch.mesh.getTotalIndices()/3;}return {instances:this.instances.size,batches:[...this.batches.values()].filter(b=>b.count>0).length,visibleParts,triangles,cpuMs:Math.round(this.cpuMs*100)/100,drawnUnits:this.drawnUnits,drawnStructures:this.drawnStructures};}
  dispose():void {for(const instance of this.instances.values())instance.root.dispose();for(const batch of this.batches.values())batch.mesh.dispose();for(const source of this.sources.values())source.dispose();for(const material of this.materials.values())material.dispose(true,true);this.instances.clear();this.batches.clear();this.sources.clear();this.materials.clear();}
}
