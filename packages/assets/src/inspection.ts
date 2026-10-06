import { rotateAssetPoint, sampleAssetPose } from './pose.js';
import type { AssetBlueprint, AssetBundle, AssetPoseContext, AssetVariant, Vec3 } from './types.js';

export interface PosedMesh {nodeId:string;geometryId:string;materialId:string;positions:number[];indices:number[]}
/** Actual posed vertex output used by geometry QA/exporters, independent of Babylon. */
export function inspectAssetPose(bundle:AssetBundle,asset:AssetBlueprint,variant:AssetVariant,context:AssetPoseContext,clipId?:string,timeSeconds=0):{meshes:PosedMesh[];triangles:number;bounds:{min:Vec3;max:Vec3}}{
  const poses=sampleAssetPose(asset,variant,clipId,timeSeconds,context),local=new Map(poses.map(pose=>[pose.nodeId,pose])),nodes=new Map(variant.nodes.map(node=>[node.id,node]));
  // Affine basis composition also preserves non-uniform scale beneath rotated parents.
  type Basis={origin:Vec3;x:Vec3;y:Vec3;z:Vec3};const world=new Map<string,Basis>();
  const transform=(point:Vec3,basis:Basis):Vec3=>point.map((_,axis)=>basis.origin[axis]!+point[0]*basis.x[axis]!+point[1]*basis.y[axis]!+point[2]*basis.z[axis]!) as Vec3;
  const basis=(id:string):Basis=>{const cached=world.get(id);if(cached)return cached;const pose=local.get(id)!,parentId=nodes.get(id)!.parentId,parent=parentId?basis(parentId):undefined;
    let origin=pose.position,x=rotateAssetPoint([pose.scale[0],0,0],pose.rotation),y=rotateAssetPoint([0,pose.scale[1],0],pose.rotation),z=rotateAssetPoint([0,0,pose.scale[2]],pose.rotation);
    if(parent){origin=transform(origin,parent);const direction=(value:Vec3)=>transform(value,{...parent,origin:[0,0,0]});x=direction(x);y=direction(y);z=direction(z);}const result={origin,x,y,z};world.set(id,result);return result;};
  const meshes:PosedMesh[]=[],min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];let triangles=0;
  for(const node of variant.nodes){const geometryId=node.mesh?.geometry[context.lod];if(!geometryId||!local.get(node.id)!.visible)continue;const geometry=bundle.geometries[geometryId]!,matrix=basis(node.id),positions:number[]=[];
    for(let i=0;i<geometry.positions.length;i+=3){const point=transform(geometry.positions.slice(i,i+3) as Vec3,matrix);positions.push(...point);for(let axis=0;axis<3;axis++){min[axis]=Math.min(min[axis]!,point[axis]!);max[axis]=Math.max(max[axis]!,point[axis]!);}}
    meshes.push({nodeId:node.id,geometryId,materialId:node.mesh!.materialId,positions,indices:geometry.indices});triangles+=geometry.indices.length/3;
  }
  return{meshes,triangles,bounds:{min,max}};
}
