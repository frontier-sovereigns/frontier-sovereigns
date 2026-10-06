import { sha256 } from '../../shared/src/hash.js';
import type { AssetBlueprint, AssetBundle, AssetMaterial, AssetNode, GeometryBuffer, Quat, Vec3 } from './types.js';

export function quaternionFromEuler(x:number,y:number,z:number):Quat {
  const sx=Math.sin(x/2),cx=Math.cos(x/2),sy=Math.sin(y/2),cy=Math.cos(y/2),sz=Math.sin(z/2),cz=Math.cos(z/2);
  return [sx*cy*cz-cx*sy*sz,cx*sy*cz+sx*cy*sz,cx*cy*sz-sx*sy*cz,cx*cy*cz+sx*sy*sz];
}
export function assetNode(id:string,options:Partial<Omit<AssetNode,'id'>>={}):AssetNode {
  return {id,position:[0,0,0],rotation:[0,0,0,1],scale:[1,1,1],...options};
}
function flatGeometry(points:Vec3[],faces:number[][]):GeometryBuffer {
  const result:GeometryBuffer={positions:[],normals:[],indices:[],uvs:[]};
  for(const face of faces)for(let index=1;index<face.length-1;index++){
    const a=points[face[0]!]!,b=points[face[index]!]!,c=points[face[index+1]!]!;
    const u=b.map((value,i)=>value-a[i]!),v=c.map((value,i)=>value-a[i]!);
    const n:Vec3=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],length=Math.hypot(...n);
    if(length<1e-12)continue; // Collapsed pole edges in revolved/ellipsoid surfaces.
    const start=result.positions.length/3;
    for(const point of [a,b,c]){result.positions.push(...point);result.normals.push(...n.map(value=>value/length));}
    result.indices.push(start,start+1,start+2);
    // A box/banner quad spans one complete heraldic pattern, not one repeated
    // pattern per triangle. Fan triangles share matching texture coordinates.
    const uv=(vertex:number):[number,number]=>face.length===4?([[0,0],[1,0],[1,1],[0,1]] as [number,number][])[vertex]!:face.length===3?([[0,0],[1,0],[.5,1]] as [number,number][])[vertex]!:[.5+.5*Math.cos(vertex*Math.PI*2/face.length),.5+.5*Math.sin(vertex*Math.PI*2/face.length)];
    for(const vertex of [0,index,index+1])result.uvs!.push(...uv(vertex));
  }
  return result;
}
function positive(values:number[]){if(values.some(value=>!Number.isFinite(value)||value<=0))throw new Error('INVALID_GEOMETRY_DIMENSION');}
export class AssetLibraryBuilder {
  private readonly buffers:Record<string,GeometryBuffer>={};
  private readonly palette:Record<string,AssetMaterial>={};
  geometry(buffer:GeometryBuffer):string {
    if(!buffer.positions.length||buffer.positions.length%3||buffer.normals.length!==buffer.positions.length||!buffer.indices.length||buffer.indices.length%3||[...buffer.positions,...buffer.normals,...(buffer.uvs??[])].some(value=>!Number.isFinite(value))||buffer.indices.some(index=>!Number.isSafeInteger(index)||index<0||index>=buffer.positions.length/3))throw new Error('INVALID_GEOMETRY_BUFFER');
    const id=`geometry_${sha256(JSON.stringify(buffer)).slice(0,32)}`;
    this.buffers[id]??=structuredClone(buffer);return id;
  }
  material(definition:AssetMaterial):string {
    if(this.palette[definition.id]&&JSON.stringify(this.palette[definition.id])!==JSON.stringify(definition))throw new Error(`CONFLICTING_ASSET_MATERIAL:${definition.id}`);
    this.palette[definition.id]??=structuredClone(definition);return definition.id;
  }
  box(size:Vec3):string {
    positive(size);const [x,y,z]=size.map(value=>value/2) as Vec3;
    return this.geometry(flatGeometry([[-x,-y,-z],[x,-y,-z],[x,-y,z],[-x,-y,z],[-x,y,-z],[x,y,-z],[x,y,z],[-x,y,z]],[[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[0,3,7,4],[1,5,6,2]]));
  }
  ellipsoid(radii:Vec3,rings:number,sectors:number):string {
    positive(radii);if(!Number.isSafeInteger(rings)||rings<2||!Number.isSafeInteger(sectors)||sectors<3)throw new Error('INVALID_GEOMETRY_SEGMENTS');
    const points:Vec3[]=[],faces:number[][]=[];
    for(let ring=0;ring<=rings;ring++){const phi=Math.PI*ring/rings;for(let sector=0;sector<sectors;sector++){const theta=2*Math.PI*sector/sectors;points.push([radii[0]*Math.sin(phi)*Math.cos(theta),radii[1]*Math.cos(phi),radii[2]*Math.sin(phi)*Math.sin(theta)]);}}
    for(let ring=0;ring<rings;ring++)for(let sector=0;sector<sectors;sector++){const next=(sector+1)%sectors,a=ring*sectors+sector,b=ring*sectors+next,c=(ring+1)*sectors+next,d=(ring+1)*sectors+sector;faces.push([a,b,c,d]);}
    return this.geometry(flatGeometry(points,faces));
  }
  revolve(profile:[number,number][],segments:number):string {
    if(profile.length<2||profile.some(([radius,y])=>!Number.isFinite(radius)||radius<0||!Number.isFinite(y))||!Number.isSafeInteger(segments)||segments<3)throw new Error('INVALID_REVOLVED_PROFILE');
    const points:Vec3[]=[],faces:number[][]=[];
    for(const [radius,y]of profile)for(let i=0;i<segments;i++){const angle=i*Math.PI*2/segments;points.push([Math.cos(angle)*radius,y,Math.sin(angle)*radius]);}
    for(let row=0;row<profile.length-1;row++)for(let i=0;i<segments;i++){const next=(i+1)%segments;faces.push([row*segments+i,(row+1)*segments+i,(row+1)*segments+next,row*segments+next]);}
    for(const row of [0,profile.length-1]){const centre=points.length;points.push([0,profile[row]![1],0]);for(let i=0;i<segments;i++){const next=(i+1)%segments;faces.push(row===0?[centre,row*segments+i,row*segments+next]:[centre,row*segments+next,row*segments+i]);}}
    return this.geometry(flatGeometry(points,faces));
  }
  extrudeConvex(outline:[number,number][],depth:number):string {
    positive([depth]);if(outline.length<3||outline.some(point=>point.some(value=>!Number.isFinite(value))))throw new Error('INVALID_EXTRUSION');
    let area=0;for(let i=0;i<outline.length;i++){const a=outline[i]!,b=outline[(i+1)%outline.length]!;area+=a[0]*b[1]-b[0]*a[1];}if(Math.abs(area)<1e-10)throw new Error('DEGENERATE_EXTRUSION');
    const shape=area>0?outline:[...outline].reverse(),points:Vec3[]=[];
    for(const z of [-depth/2,depth/2])for(const [x,y]of shape)points.push([x,y,z]);
    const count=shape.length,faces:number[][]=[Array.from({length:count},(_,i)=>count-1-i),Array.from({length:count},(_,i)=>count+i)];
    for(let i=0;i<count;i++)faces.push([i,(i+1)%count,(i+1)%count+count,i+count]);return this.geometry(flatGeometry(points,faces));
  }
  finish(blueprints:AssetBlueprint[]):AssetBundle {
    const assets:Record<string,AssetBlueprint>={};for(const blueprint of blueprints){if(Object.hasOwn(assets,blueprint.id))throw new Error(`DUPLICATE_ASSET:${blueprint.id}`);assets[blueprint.id]=structuredClone(blueprint);}
    return {schemaVersion:1,geometries:structuredClone(this.buffers),materials:structuredClone(this.palette),assets};
  }
}
export function createAssetLibrary():AssetLibraryBuilder{return new AssetLibraryBuilder();}
