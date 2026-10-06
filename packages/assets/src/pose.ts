import type { AssetBlueprint, AssetClip, AssetNode, AssetPoseContext, AssetTrack, AssetVariant, AssetVisibility, Quat, Vec3 } from './types.js';
export interface LocalAssetPose {nodeId:string;position:Vec3;rotation:Quat;scale:Vec3;visible:boolean}
export function chooseVariant(asset:AssetBlueprint,appearance:{age?:number;tier?:string}={}):AssetVariant {
  const tier=appearance.tier??'base',age=appearance.age??1;
  const eligible=asset.variants.filter(variant=>!variant.tier||variant.tier===tier);
  const candidates=eligible.length?eligible:asset.variants.filter(variant=>!variant.tier||variant.tier==='base');
  const ordered=[...candidates].sort((a,b)=>(a.age??0)-(b.age??0));
  const found=ordered.filter(variant=>(variant.age??0)<=age).at(-1)??ordered[0];
  if(!found)throw new Error(`MISSING_ASSET_VARIANT:${asset.id}`);return found;
}
export function visibleAssetNode(rule:AssetVisibility|undefined,context:AssetPoseContext):boolean {
  if(!rule)return true;
  const state=context.state??'complete',progress=context.progress??1,damage=context.damage??(state==='damaged'?.65:0);
  return (!rule.states||rule.states.includes(state))&&(!rule.progress||progress>=rule.progress[0]&&progress<=rule.progress[1])&&(!rule.damage||damage>=rule.damage[0]&&damage<=rule.damage[1])&&(!rule.gate||rule.gate===(context.gate??'closed'))&&(!rule.farm||rule.farm.includes(context.farm??'ready'))&&(!rule.wallMask||rule.wallMask.includes(context.wallMask??5))&&(!rule.actions||rule.actions.includes(context.action??'idle'))&&(!rule.cargo||Boolean(context.cargo&&rule.cargo.includes(context.cargo)));
}
export function sampleAssetTrack(track:AssetTrack,seconds:number):Vec3|Quat {
  let right=track.times.findIndex(time=>time>=seconds);if(right<0)right=track.times.length-1;
  const left=Math.max(0,right-1),a=track.values[left]!,b=track.values[right]!,duration=track.times[right]!-track.times[left]!,t=duration?Math.max(0,Math.min(1,(seconds-track.times[left]!)/duration)):0;
  if(track.property!=='rotation')return a.map((value,index)=>value+(b[index]!-value)*t) as Vec3;
  let dot=a.reduce((sum,value,index)=>sum+value*b[index]!,0),sign=1;if(dot<0){dot=-dot;sign=-1;}
  const theta=Math.acos(Math.min(1,dot)),denominator=Math.sin(theta),wa=denominator>1e-6?Math.sin((1-t)*theta)/denominator:1-t,wb=denominator>1e-6?Math.sin(t*theta)/denominator:t;
  const result=a.map((value,index)=>wa*value+wb*b[index]!*sign),length=Math.hypot(...result);return result.map(value=>value/length) as Quat;
}
export function sampleAssetPose(asset:AssetBlueprint,variant:AssetVariant,clipId:string|undefined,timeSeconds:number,context:AssetPoseContext):LocalAssetPose[] {
  const poses=variant.nodes.map(node=>({nodeId:node.id,position:[...node.position] as Vec3,rotation:[...node.rotation] as Quat,scale:[...node.scale] as Vec3,visible:visibleAssetNode(node.visibility,context)})),byId=new Map(poses.map(pose=>[pose.nodeId,pose]));
  const clip=clipId?asset.clips.find(item=>item.id===clipId):undefined;
  if(clip){const time=clip.loop?((timeSeconds%clip.durationSeconds)+clip.durationSeconds)%clip.durationSeconds:Math.max(0,Math.min(clip.durationSeconds,timeSeconds));for(const track of clip.tracks){const pose=byId.get(track.nodeId);if(pose)(pose[track.property] as number[])=sampleAssetTrack(track,time);}}
  const nodes=new Map(variant.nodes.map(node=>[node.id,node])),complete=new Set<string>(),visiting=new Set<string>();
  const inherit=(node:AssetNode):void=>{if(complete.has(node.id))return;if(visiting.has(node.id))throw new Error('ASSET_NODE_CYCLE');visiting.add(node.id);if(node.parentId){const parent=nodes.get(node.parentId);if(!parent)throw new Error('MISSING_ASSET_PARENT');inherit(parent);byId.get(node.id)!.visible&&=byId.get(parent.id)!.visible;}visiting.delete(node.id);complete.add(node.id);};
  for(const node of variant.nodes)inherit(node);return poses;
}
export function rotateAssetPoint(point:Vec3,rotation:Quat):Vec3 {
  const [x,y,z,w]=rotation,[px,py,pz]=point,tx=2*(y*pz-z*py),ty=2*(z*px-x*pz),tz=2*(x*py-y*px);
  return [px+w*tx+y*tz-z*ty,py+w*ty+z*tx-x*tz,pz+w*tz+x*ty-y*tx];
}
/** Inspection helper: transform a real vertex through the posed hierarchy. */
export function posedAssetPoint(point:Vec3,nodeId:string,variant:AssetVariant,poses:LocalAssetPose[]):Vec3 {
  const nodes=new Map(variant.nodes.map(node=>[node.id,node])),local=new Map(poses.map(pose=>[pose.nodeId,pose]));let current:string|undefined=nodeId,result=[...point] as Vec3;
  while(current){const pose=local.get(current);if(!pose)throw new Error('MISSING_ASSET_POSE');result=rotateAssetPoint(result.map((value,index)=>value*pose.scale[index]!) as Vec3,pose.rotation).map((value,index)=>value+pose.position[index]!) as Vec3;current=nodes.get(current)!.parentId;}return result;
}
