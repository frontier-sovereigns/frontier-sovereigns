/** Original asset recipes. Metres, Y up, +Z forward; rotations are XYZW quaternions. */
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Lod = 0 | 1 | 2;
export type AssetAction = 'idle'|'move'|'attack'|'hit'|'death'|'gather_food'|'gather_wood'|'mine'|'build'|'repair'|'carry'|'packed'|'deploy'|'pack'|'windup'|'turret';
export type AssetState = 'foundation'|'construction'|'complete'|'damaged'|'destroyed';
export type FarmAppearance = 'ready'|'exhausted'|'reseeding';
export interface GeometryBuffer {positions:number[];normals:number[];indices:number[];uvs?:number[]}
export interface AssetMaterial {
  id:string;baseColor:[number,number,number,number];teamTint?:boolean;heraldry?:boolean;
  emissive?:Vec3;roughness?:number;textureId?:string;
}
export interface AssetVisibility {
  states?:AssetState[];progress?:[number,number];damage?:[number,number];gate?:'open'|'closed';
  farm?:FarmAppearance[];wallMask?:number[];actions?:AssetAction[];cargo?:('food'|'wood'|'gold'|'stone')[];
}
export interface AssetNode {
  id:string;parentId?:string;position:Vec3;rotation:Quat;scale:Vec3;
  mesh?:{geometry:[string|null,string|null,string|null];materialId:string};visibility?:AssetVisibility;
}
export type AssetTrack = {nodeId:string;property:'position'|'scale';times:number[];values:Vec3[]}
  |{nodeId:string;property:'rotation';times:number[];values:Quat[]};
export interface AssetClip {id:string;durationSeconds:number;loop:boolean;tracks:AssetTrack[]}
export interface AssetVariant {key:string;age?:1|2|3|4|5|6|7|8;tier?:'base'|'veteran'|'elite';nodes:AssetNode[]}
export interface AssetBlueprint {
  id:string;kind:'unit'|'building'|'environment';variants:AssetVariant[];clips:AssetClip[];
  sockets:Record<string,string>;
  /** Rest/selection envelope used for logical picking and gallery framing.
   * Animated weapons/corpses can extend outside it; posed draw batches have their
   * own visibility policy, and this box is not an animated frustum bound. */
  bounds:{min:Vec3;max:Vec3};
  collision?:{kind:'circle';radiusM:number}|{kind:'footprint';widthM:number;depthM:number;gatePassageWidthM?:number};
}
export interface AssetBundle {
  schemaVersion:1;geometries:Record<string,GeometryBuffer>;materials:Record<string,AssetMaterial>;assets:Record<string,AssetBlueprint>;
}
export interface AssetPoseContext {
  lod:Lod;state?:AssetState;progress?:number;damage?:number;gate?:'open'|'closed';farm?:FarmAppearance;
  wallMask?:number;action?:AssetAction;cargo?:'food'|'wood'|'gold'|'stone';
}
