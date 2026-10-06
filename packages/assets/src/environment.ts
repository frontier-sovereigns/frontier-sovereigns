import { architecturalMaterials } from './buildings.js';
import { assetNode, quaternionFromEuler, type AssetLibraryBuilder } from './geometry.js';
import type { AssetBlueprint, AssetClip, AssetNode, Vec3 } from './types.js';

/** Small original modules are instanced by the map renderer; no private map seed is used. */
export function generateEnvironmentAssets(library:AssetLibraryBuilder):AssetBlueprint[]{
  architecturalMaterials(library);
  library.material({id:'fs_flame',baseColor:[1,.40,.08,.9],emissive:[.8,.18,.02],roughness:1});
  library.material({id:'fs_smoke',baseColor:[.30,.32,.30,.42],roughness:1});
  library.material({id:'fs_dust',baseColor:[.68,.59,.40,.5],roughness:1});
  library.material({id:'fs_fog',baseColor:[.14,.22,.24,.8],roughness:1});
  library.material({id:'fs_ore_host',baseColor:[.28,.31,.29,1],roughness:.94});
  const result:AssetBlueprint[]=[],box=library.box([1,1,1]);
  const author=(id:string,build:(add:(name:string,shape:string|[string|null,string|null,string|null],material:string,position:Vec3,scale?:Vec3,rotation?:Vec3,detail?:number)=>string,nodes:AssetNode[],clips:AssetClip[])=>void,bounds:AssetBlueprint['bounds']={min:[-2,-.25,-2],max:[2,5,2]})=>{
    const nodes:AssetNode[]=[assetNode('root')],clips:AssetClip[]=[];let serial=0;
    const add=(name:string,shape:string|[string|null,string|null,string|null],material:string,position:Vec3,scale:Vec3=[1,1,1],rotation:Vec3=[0,0,0],detail=2)=>{const nodeId=`${name}_${serial++}`,geometry=(typeof shape==='string'?[shape,shape,shape]:shape).map((item,index)=>index>detail?null:item) as [string|null,string|null,string|null];nodes.push(assetNode(nodeId,{parentId:'root',position,scale,rotation:quaternionFromEuler(...rotation),mesh:{geometry,materialId:`fs_${material}`}}));return nodeId;};
    build(add,nodes,clips);result.push({id,kind:'environment',variants:[{key:'default',nodes}],clips,sockets:{},bounds});
  };
  for(const [id,material]of [['grass_terrain','leaf'],['dirt_terrain','soil'],['stone_terrain','stone']] as const)author(id,add=>{
    add('ground_tile',box,material,[0,-.03,0],[2,.06,2]);
    if(id==='grass_terrain')for(let i=0;i<14;i++)add('grass_blade',library.extrudeConvex([[-.025,0],[.035,0],[.08,.23]],.018),i%2?'leaf':'leaf_light',[Math.sin(i*2.4)*.83,0,Math.cos(i*1.8)*.83],[1,1,1],[0,i*.6,0],i%4?0:1);
    else for(let i=0;i<7;i++)add('ground_grit',library.ellipsoid([.08,.04,.07],2,4),id==='dirt_terrain'?'wood_light':'stone_light',[Math.sin(i*2.4)*.8,.025,Math.cos(i*1.9)*.8],[1,1,1],[0,i,0],i%2?0:1);
  },{min:[-1,-.06,-1],max:[1,.3,1]});
  author('water_surface',(add,_nodes,clips)=>{add('water_plane',box,'water',[0,-.06,0],[2,.08,2]);const crest=add('wave_crest',box,'canvas',[0,-.01,0],[1.4,.008,.02],[0,.15,0],1);clips.push({id:'idle',durationSeconds:3,loop:true,tracks:[{nodeId:crest,property:'position',times:[0,1.5,3],values:[[0,-.015,-.45],[0,.005,.45],[0,-.015,-.45]]}]});},{min:[-1,-.12,-1],max:[1,.1,1]});
  for(const id of ['tree_oak','tree_pine','tree_round_canopy'])author(id,add=>{
    add('root_flare',[library.revolve([[.35,0],[.20,.35],[.14,2.8]],8),library.revolve([[.32,0],[.15,2.8]],5),library.revolve([[.30,0],[.15,2.8]],3)],'wood_dark',[0,0,0]);
    if(id==='tree_pine')for(let layer=0;layer<4;layer++){const radius=1.38-layer*.25;add('conifer_whorl',[library.revolve([[radius,0],[radius*.8,.25],[0,1.5]],9),library.revolve([[radius,0],[0,1.5]],6),library.revolve([[radius,0],[0,1.5]],4)],layer%2?'pine':'leaf',[0,1.4+layer*.65,0]);}
    else{const round=id==='tree_round_canopy';for(let i=0;i<(round?5:7);i++){const angle=i*2.399,r=i===0?0:.65;add('leaf_crown',[library.ellipsoid([1.1,round?.94:.78,1.05],4,8),library.ellipsoid([1.15,round?1:.82,1.1],3,6),library.ellipsoid([1.25,1.05,1.2],2,5)],i%2?'leaf_light':'leaf',[Math.cos(angle)*r,2.8+(i%3)*.43,Math.sin(angle)*r],[1,1,1],[0,angle,0],i>2?0:i>0?1:2);if(i>0)add('branch',library.revolve([[.09,0],[.04,1.2]],5),'wood',[0,1.9,0],[1,1,1],[.5*Math.cos(angle),0,.5*Math.sin(angle)],0);}}
  },{min:[-1.9,0,-1.9],max:[1.9,5,1.9]});
  author('forage_patch',add=>{for(let i=0;i<5;i++){const x=Math.sin(i*2.4)*.65,z=Math.cos(i*2.4)*.65;add('berry_bush',[library.ellipsoid([.55,.48,.53],3,6),library.ellipsoid([.55,.48,.53],2,5),library.ellipsoid([.60,.5,.57],2,4)],'leaf',[x,.45,z],[1,1,1],[0,i,0],i>2?0:2);for(let j=0;j<3;j++)add('berry',library.ellipsoid([.07,.075,.07],2,4),'berry',[x+Math.sin(j*2)*.32,.8,z+Math.cos(j*2)*.32],[1,1,1],[0,0,0],0);}},{min:[-1.3,-.05,-1.3],max:[1.3,1.1,1.3]});
  for(const id of ['gold_deposit','stone_quarry'])author(id,add=>{for(let i=0;i<7;i++){
    const x=Math.cos(i*2.399)*Math.sqrt(i/7)*1.1,z=Math.sin(i*2.399)*Math.sqrt(i/7)*1.1,size=.65+(i%3)*.2,detail=i>3?0:i>1?1:2;
    add('rock_outcrop',[library.ellipsoid([size,size*.7,size*.8],3,6),library.ellipsoid([size,size*.7,size*.8],2,5),library.ellipsoid([size,size*.7,size*.8],2,4)],id==='gold_deposit'?'ore_host':'stone',[x,size*.48,z],[1,1,1],[.12,i*.7,.1],detail);
    // The facets project through the host rock's actual upper surface. Their lower
    // halves remain embedded, rather than leaving isolated floating gold strips.
    if(id==='gold_deposit')add('exposed_gold_vein',[library.ellipsoid([size*.62,size*.16,size*.2],3,6),library.ellipsoid([size*.62,size*.16,size*.2],2,5),library.ellipsoid([size*.62,size*.16,size*.2],2,4)],'gold',[x,size*1.14,z],[1,1,1],[.12,i*.7,.1],detail);
  }},{min:[-2,-.25,-2],max:[2,1.6,2]});
  author('cliff',add=>{add('stratified_rock_face',library.extrudeConvex([[-1,0],[1,0],[.9,2],[-.8,2.2]],2),'stone',[0,0,0]);for(let i=0;i<6;i++)add('cliff_stratum',box,i%2?'stone_light':'stone',[0,.32+i*.32,-1.005],[1.85,.07,.07],[0,0,.025*(i%2)],i%2?0:1);},{min:[-1,0,-1.1],max:[1,2.3,1.1]});
  author('ramp',add=>{add('walkable_slope',library.extrudeConvex([[-1,0],[1,0],[1,1]],2),'soil',[0,0,0]);for(const side of [-1,1])add('ramp_rock_edge',library.extrudeConvex([[-1,0],[1,0],[1,1.1]],.12),'stone',[0,0,side*.97],[1,1,1],[0,0,0],1);},{min:[-1,0,-1.1],max:[1,1.2,1.1]});
  author('bridge',add=>{add('crossing_deck',box,'stone_light',[0,.2,0],[6,.4,4]);for(const side of [-1,1]){add('bridge_parapet',box,'stone',[0,.65,side*1.9],[6,.5,.2]);for(let i=-2;i<=2;i++)add('bridge_bollard',box,'stone_light',[i*1.2,1,side*1.9],[.3,.3,.32],[0,0,0],i%2?0:1);}for(const x of [-2,2])add('bridge_pier',box,'stone',[x,-.65,0],[.65,1.7,3.1]);},{min:[-3,-1.5,-2.1],max:[3,1.2,2.1]});
  for(const id of ['farm_growing','farm_exhausted'])author(id,add=>{add('tilled_module',box,id==='farm_exhausted'?'food_exhausted':'soil',[0,.06,0],[2,.12,2]);for(let i=0;i<6;i++){add('furrow',box,id==='farm_exhausted'?'food_exhausted':'wood_dark',[0,.14,(i-2.5)*.3],[1.9,.04,.04],[0,0,0],i%2?0:2);for(let j=0;j<6;j++)add(id==='farm_growing'?'wheat':'stubble',library.revolve([[.035,0],[.065,id==='farm_growing'?.35:.07],[0,id==='farm_growing'?.65:.12]],3),id==='farm_exhausted'?'food_exhausted':'grain',[(j-2.5)*.3,.16,(i-2.5)*.3],[1,1,1],[0,0,0],i%3===0&&j%3===0?2:i%2===0&&j%2===0?1:0);}},{min:[-1,0,-1],max:[1,.9,1]});
  for(const id of ['wall_end_cap','wall_corner'])author(id,add=>{add('connector_pier',box,'stone',[0,1.3,0],[.7,2.6,.7]);add('connector_cap',box,'stone_light',[0,2.72,0],[.85,.24,.85]);if(id==='wall_corner'){add('corner_return',box,'stone',[.6,1.1,0],[1.2,2.2,.6]);add('corner_return',box,'stone',[0,1.1,.6],[.6,2.2,1.2]);}for(const y of [.6,1.2,1.8])add('connector_course',box,'stone_light',[0,y,-.36],[.65,.07,.04],[0,0,0],0);},{min:[-.5,0,-.5],max:[1.25,3,1.25]});
  author('arrow',add=>{add('arrow_shaft',box,'wood_light',[0,0,0],[.035,.035,.9]);add('arrowhead',library.extrudeConvex([[-.09,0],[.09,0],[0,.22]],.025),'iron',[0,0,.45],[1,1,1],[Math.PI/2,0,0]);for(const angle of [0,Math.PI/2])add('fletching',box,'canvas',[0,0,-.35],[.17,.02,.2],[0,0,angle],1);},{min:[-.12,-.12,-.5],max:[.12,.12,.75]});
  for(const id of ['catapult_stone','trebuchet_stone'])author(id,add=>{const r=id==='catapult_stone'?.34:.45;add('siege_projectile',[library.ellipsoid([r,r*.93,r],3,7),library.ellipsoid([r,r*.93,r],2,5),library.ellipsoid([r,r*.93,r],2,4)],'stone',[0,0,0]);},{min:[-.5,-.5,-.5],max:[.5,.5,.5]});
  author('rubble',add=>{for(let i=0;i<9;i++)add('rubble_fragment',[library.ellipsoid([.5,.23,.4],3,5),library.ellipsoid([.5,.23,.4],2,4),box],i%3?'stone':'char',[Math.sin(i*2.4)*1.2,.2,Math.cos(i*1.9)*1.2],[1,1,1],[0,i*.6,.15],i>4?0:i>2?1:2);add('broken_timber',box,'char',[0,.3,0],[2.7,.14,.18],[0,.7,.06]);},{min:[-1.8,-.35,-1.8],max:[1.8,.7,1.8]});
  author('construction_scaffold',add=>{for(const x of [-1,1])for(const z of [-.4,.4])add('scaffold_pole',box,'wood',[x,1.3,z],[.12,2.6,.12]);add('scaffold_platform',box,'wood_light',[0,2,.0],[2.2,.13,1]);add('scaffold_brace',box,'wood_dark',[0,1.1,-.45],[.1,2.8,.1],[0,0,.72],1);for(let i=0;i<6;i++)add('scaffold_rung',box,'wood_light',[-.75,.4+i*.3,-.5],[.35,.08,.1],[0,0,0],0);},{min:[-1.2,0,-.6],max:[1.2,2.7,.6]});
  for(const id of ['smoke','fire','dust'])author(id,(add,_nodes,clips)=>{
    const shape=id==='fire'?[library.revolve([[.4,0],[.27,.7],[0,1.3]],7),library.revolve([[.4,0],[0,1.3]],5),library.revolve([[.4,0],[0,1.3]],3)] as [string,string,string]:[library.ellipsoid([.45,.38,.45],3,6),library.ellipsoid([.45,.38,.45],2,5),library.ellipsoid([.45,.38,.45],2,4)] as [string,string,string];
    for(let i=0;i<3;i++){const position:Vec3=[(i-1)*.32,.15+i*.15,0],node=add('effect_lobe',shape,id==='fire'?'flame':id,position,[1,1,1],[0,i,0],i===2?0:2);clips.push({id:`pulse_${i}`,durationSeconds:1.4,loop:true,tracks:[{nodeId:node,property:'position',times:[0,.7,1.4],values:[position,[position[0]+.12,position[1]+(id==='dust'?.25:1),.1],position]},{nodeId:node,property:'scale',times:[0,.7,1.4],values:[[.4,.5,.4],[1.2,id==='fire'?1.1:.9,1.2],[.4,.5,.4]]}]});}
    clips.push({id:'idle',durationSeconds:1.4,loop:true,tracks:clips.flatMap(clip=>clip.tracks)});
  },{min:[-1.1,-.25,-.6],max:[1.1,3,.6]});
  author('fog_mask',add=>add('fog_surface',box,'fog',[0,.005,0],[2,.01,2]),{min:[-1,0,-1],max:[1,.02,1]});
  return result;
}
