import type { AssetBundle } from './types.js';

function fail(code:string):never{throw new Error(`INVALID_ASSET:${code}`);}
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&!['__proto__','prototype','constructor'].includes(value);
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=100000;
const record=(value:unknown):value is Record<string,any>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null));
function object(value:unknown,required:string[],optional:string[]=[]):asserts value is Record<string,any>{
  if(!record(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))fail('OBJECT_FIELDS');
}
function array(value:unknown,max:number,min=0):asserts value is any[]{if(!Array.isArray(value)||value.length<min||value.length>max||Object.keys(value).length!==value.length)fail('ARRAY_BOUND');}
function vector(value:unknown,length:number,quaternion=false):void{array(value,length,length);if(!value.every(finite)||quaternion&&Math.abs(Math.hypot(...value)-1)>1e-5)fail('TRANSFORM');}
function enums(value:unknown,allowed:readonly unknown[],max=allowed.length):void{array(value,max,1);if(new Set(value).size!==value.length||value.some(item=>!allowed.includes(item)))fail('ENUM');}
function optionalBoolean(value:Record<string,any>,key:string):void{if(key in value&&typeof value[key]!=='boolean')fail('BOOLEAN');}
const actions=['idle','move','attack','hit','death','gather_food','gather_wood','mine','build','repair','carry','packed','deploy','pack','windup','turret'];
function visibility(value:unknown):void{
  object(value,[],['states','progress','damage','gate','farm','wallMask','actions','cargo']);
  if(value.states)enums(value.states,['foundation','construction','complete','damaged','destroyed']);
  for(const key of ['progress','damage'])if(key in value){vector(value[key],2);if(value[key][0]<0||value[key][1]>1||value[key][0]>value[key][1])fail('VISIBILITY_RANGE');}
  if('gate'in value&&!['open','closed'].includes(value.gate))fail('GATE_STATE');
  if(value.farm)enums(value.farm,['ready','exhausted','reseeding']);if(value.wallMask)enums(value.wallMask,Array.from({length:16},(_,index)=>index));
  if(value.actions)enums(value.actions,actions);if(value.cargo)enums(value.cargo,['food','wood','gold','stone']);
}

/** Strict browser-safe decoder. Validates actual buffers, references and hierarchy; no generated code/eval. */
export function assertAssetBundle(input:unknown):asserts input is AssetBundle {
  // Reject cyclic/accessor/prototype-bearing values before reading nested fields. JSON downloads are plain data.
  let remaining=3_000_000;const visiting=new Set<object>();
  const safe=(value:unknown,depth:number):void=>{
    if(--remaining<0||depth>24)fail('JSON_BOUND');
    if(value===null||typeof value==='boolean'||typeof value==='string')return;if(typeof value==='number'){if(!Number.isFinite(value))fail('NONFINITE');return;}
    if(typeof value!=='object'||(!Array.isArray(value)&&!record(value))||visiting.has(value))fail('JSON_TYPE');
    visiting.add(value);for(const key of Object.keys(value)){if(['__proto__','prototype','constructor'].includes(key))fail('UNSAFE_KEY');const property=Object.getOwnPropertyDescriptor(value,key);if(!property||!('value'in property))fail('ACCESSOR');safe(property.value,depth+1);}visiting.delete(value);
  };safe(input,0);
  object(input,['schemaVersion','geometries','materials','assets']);if(input.schemaVersion!==1)fail('VERSION');
  for(const [key,max]of [['geometries',4096],['materials',256],['assets',128]] as const)if(!record(input[key])||Object.keys(input[key]).length===0||Object.keys(input[key]).length>max)fail('DICTIONARY_BOUND');
  for(const [key,raw]of Object.entries(input.geometries)){
    if(!id(key))fail('GEOMETRY_ID');object(raw,['positions','normals','indices'],['uvs']);array(raw.positions,300000,9);array(raw.normals,300000,9);array(raw.indices,300000,3);
    if(raw.positions.length%3||raw.indices.length%3||raw.normals.length!==raw.positions.length||!raw.positions.every(finite)||!raw.normals.every(finite))fail('BUFFER_LENGTH');
    const vertices=raw.positions.length/3;if(raw.indices.some((index:number)=>!Number.isInteger(index)||index<0||index>=vertices))fail('INDEX');
    if(raw.uvs){array(raw.uvs,200000,6);if(raw.uvs.length!==vertices*2||!raw.uvs.every(finite))fail('UV');}
    for(let i=0;i<raw.normals.length;i+=3)if(Math.abs(Math.hypot(raw.normals[i],raw.normals[i+1],raw.normals[i+2])-1)>1e-5)fail('NORMAL');
    for(let i=0;i<raw.indices.length;i+=3){const a=raw.indices[i]*3,b=raw.indices[i+1]*3,c=raw.indices[i+2]*3,p=raw.positions;
      const u=[p[b]-p[a],p[b+1]-p[a+1],p[b+2]-p[a+2]],v=[p[c]-p[a],p[c+1]-p[a+1],p[c+2]-p[a+2]],cross=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];
      if(Math.hypot(...cross)<1e-10)fail('DEGENERATE_TRIANGLE');
      if(cross[0]!*raw.normals[a]+cross[1]!*raw.normals[a+1]+cross[2]!*raw.normals[a+2]<=0)fail('REVERSED_NORMAL');
    }
  }
  for(const [key,raw]of Object.entries(input.materials)){
    object(raw,['id','baseColor'],['teamTint','heraldry','emissive','roughness','textureId']);if(!id(key)||raw.id!==key)fail('MATERIAL_ID');vector(raw.baseColor,4);if(raw.baseColor.some((value:number)=>value<0||value>1))fail('COLOR');
    optionalBoolean(raw,'teamTint');optionalBoolean(raw,'heraldry');if(raw.emissive){vector(raw.emissive,3);if(raw.emissive.some((value:number)=>value<0))fail('EMISSIVE');}
    if('roughness'in raw&&(!finite(raw.roughness)||raw.roughness<0||raw.roughness>1))fail('ROUGHNESS');if('textureId'in raw&&!id(raw.textureId))fail('TEXTURE_ID');
  }
  for(const [key,raw]of Object.entries(input.assets)){
    object(raw,['id','kind','variants','clips','sockets','bounds'],['collision']);if(raw.id!==key||!id(key)||!['unit','building','environment'].includes(raw.kind))fail('ASSET_ID');
    array(raw.variants,64,1);array(raw.clips,64);object(raw.bounds,['min','max']);vector(raw.bounds.min,3);vector(raw.bounds.max,3);if(raw.bounds.min.some((value:number,index:number)=>value>=raw.bounds.max[index]))fail('BOUNDS');
    if(!record(raw.sockets)||Object.keys(raw.sockets).length>32||Object.entries(raw.sockets).some(([socket,node])=>!id(socket)||!id(node)))fail('SOCKETS');
    const variantKeys=new Set<string>(),variantNodes:Set<string>[]=[];
    for(const variant of raw.variants){
      object(variant,['key','nodes'],['age','tier']);if(!id(variant.key)||variantKeys.has(variant.key))fail('VARIANT_KEY');variantKeys.add(variant.key);
      if('age'in variant&&![1,2,3,4,5,6,7,8].includes(variant.age))fail('AGE');if('tier'in variant&&!['base','veteran','elite'].includes(variant.tier))fail('TIER');array(variant.nodes,1024,1);
      const nodes=new Map<string,any>();let meshCount=0;
      for(const node of variant.nodes){
        object(node,['id','position','rotation','scale'],['parentId','mesh','visibility']);if(!id(node.id)||nodes.has(node.id))fail('NODE_ID');nodes.set(node.id,node);if('parentId'in node&&!id(node.parentId))fail('PARENT');
        vector(node.position,3);vector(node.rotation,4,true);vector(node.scale,3);if(node.scale.some((value:number)=>value<=0))fail('BASE_SCALE');
        if(node.visibility)visibility(node.visibility);
        if(node.mesh){meshCount++;object(node.mesh,['geometry','materialId']);array(node.mesh.geometry,3,3);if(!Object.hasOwn(input.materials,node.mesh.materialId)||node.mesh.geometry.every((geometry:unknown)=>geometry===null)||node.mesh.geometry.some((geometry:unknown)=>geometry!==null&&(!id(geometry)||!Object.hasOwn(input.geometries,geometry))))fail('MESH_REFERENCE');}
      }
      if(!meshCount)fail('EMPTY_VARIANT');
      for(const node of nodes.values()){const chain=new Set<string>();let current=node;while(current){if(chain.has(current.id))fail('NODE_CYCLE');chain.add(current.id);if(current.parentId&&!nodes.has(current.parentId))fail('MISSING_PARENT');current=current.parentId?nodes.get(current.parentId):undefined;}}
      if(Object.values(raw.sockets).some(socket=>!nodes.has(socket as string)))fail('MISSING_SOCKET');variantNodes.push(new Set(nodes.keys()));
    }
    const clips=new Set<string>();
    for(const clip of raw.clips){
      object(clip,['id','durationSeconds','loop','tracks']);if(!id(clip.id)||clips.has(clip.id)||!finite(clip.durationSeconds)||clip.durationSeconds<=0||clip.durationSeconds>120||typeof clip.loop!=='boolean')fail('CLIP');clips.add(clip.id);array(clip.tracks,256,1);const channels=new Set<string>();
      for(const track of clip.tracks){object(track,['nodeId','property','times','values']);if(!id(track.nodeId)||variantNodes.some(nodes=>!nodes.has(track.nodeId))||!['position','rotation','scale'].includes(track.property))fail('TRACK_REFERENCE');const channel=`${track.nodeId}:${track.property}`;if(channels.has(channel))fail('DUPLICATE_TRACK');channels.add(channel);
        array(track.times,128,2);array(track.values,128,2);if(track.times.length!==track.values.length||track.times[0]!==0||track.times.some((time:number,index:number)=>!finite(time)||time<0||time>clip.durationSeconds||index>0&&time<=track.times[index-1]))fail('KEYFRAMES');
        for(const value of track.values){vector(value,track.property==='rotation'?4:3,track.property==='rotation');if(track.property==='scale'&&value.some((part:number)=>part<0))fail('ANIMATED_SCALE');}
      }
    }
    if(raw.collision){if(raw.collision.kind==='circle'){object(raw.collision,['kind','radiusM']);if(!finite(raw.collision.radiusM)||raw.collision.radiusM<=0)fail('COLLISION');}else{object(raw.collision,['kind','widthM','depthM'],['gatePassageWidthM']);if(raw.collision.kind!=='footprint'||!finite(raw.collision.widthM)||!finite(raw.collision.depthM)||raw.collision.widthM<=0||raw.collision.depthM<=0||'gatePassageWidthM'in raw.collision&&(!finite(raw.collision.gatePassageWidthM)||raw.collision.gatePassageWidthM<=0||raw.collision.gatePassageWidthM>=raw.collision.widthM))fail('COLLISION');}}
  }
}
export function validateAssetBundle(input:unknown):input is AssetBundle{try{assertAssetBundle(input);return true;}catch{return false;}}
