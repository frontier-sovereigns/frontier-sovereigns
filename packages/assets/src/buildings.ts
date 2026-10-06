import { balance, buildings } from '../../shared/src/content.js';
import { assetNode, quaternionFromEuler, type AssetLibraryBuilder } from './geometry.js';
import type { AssetBlueprint, AssetClip, AssetNode, AssetState, AssetVariant, AssetVisibility, Vec3 } from './types.js';

const intact:AssetState[]=['construction','complete','damaged'];
export function architecturalMaterials(library:AssetLibraryBuilder){
  const colors:Record<string,[number,number,number,number]>={wood:[.40,.27,.15,1],wood_light:[.64,.46,.25,1],wood_dark:[.22,.17,.12,1],stone:[.57,.59,.52,1],stone_light:[.73,.73,.64,1],plaster:[.86,.79,.60,1],thatch:[.68,.55,.29,1],tile:[.48,.25,.18,1],slate:[.25,.37,.38,1],iron:[.28,.34,.34,1],bronze:[.72,.55,.25,1],shadow:[.12,.17,.16,1],soil:[.34,.24,.14,1],grain:[.77,.62,.24,1],char:[.19,.16,.14,1],canvas:[.87,.83,.66,1],water:[.24,.49,.56,.85],leaf:[.31,.46,.24,1],leaf_light:[.47,.59,.28,1],pine:[.19,.35,.27,1],gold:[.83,.65,.25,1],berry:[.67,.22,.18,1]};
  for(const [id,baseColor]of Object.entries(colors))library.material({id:`fs_${id}`,baseColor,roughness:.9});
  library.material({id:'fs_team',baseColor:[1,1,1,1],teamTint:true,roughness:.85});
  library.material({id:'fs_heraldry',baseColor:[1,1,1,1],teamTint:true,heraldry:true,roughness:.85});
  for(const [id,shade]of [['thatch',1],['tile',.92],['slate',.8]] as const)library.material({id:`fs_${id}_team`,baseColor:[shade,shade,shade,1],teamTint:true,roughness:.9});
  library.material({id:'fs_food_exhausted',baseColor:[.294,.173,.102,1],roughness:1});
  library.material({id:'fs_rune',baseColor:[.52,.72,.63,1],emissive:[.09,.18,.12],roughness:.8});
}
class Architecture {
  readonly nodes:AssetNode[]=[assetNode('root')];readonly clips:AssetClip[]=[];
  private serial=0;readonly unitBox:string;
  constructor(readonly library:AssetLibraryBuilder,readonly type:string,readonly age:number,readonly width:number,readonly depth:number){this.unitBox=library.box([1,1,1]);}
  node(name:string,position:Vec3=[0,0,0],parentId='root',visibility?:AssetVisibility){const id=`${name}_${this.serial++}`;this.nodes.push(assetNode(id,{parentId,position,...(visibility?{visibility}:{})}));return id;}
  mesh(name:string,geometry:string|[string|null,string|null,string|null],material:string,position:Vec3,scale:Vec3=[1,1,1],options:{parentId?:string;visibility?:AssetVisibility;rotation?:Vec3;detail?:0|1|2}={}){
    const id=`${name}_${this.serial++}`,levels: [string|null,string|null,string|null]=typeof geometry==='string'?[geometry,options.detail===0?null:geometry,options.detail!==undefined&&options.detail<2?null:geometry]:geometry.map((item,index)=>options.detail!==undefined&&index>options.detail?null:item) as [string|null,string|null,string|null];
    this.nodes.push(assetNode(id,{parentId:options.parentId??'root',position,scale,rotation:options.rotation?quaternionFromEuler(...options.rotation):[0,0,0,1],mesh:{geometry:levels,materialId:`fs_${material}`},visibility:options.visibility??{states:intact,progress:[.15,1]}}));return id;
  }
  box(name:string,size:Vec3,position:Vec3,material:string,options:Parameters<Architecture['mesh']>[5]={}){return this.mesh(name,this.unitBox,material,position,size,options);}
  post(name:string,position:Vec3,height:number,radius=.15,material='wood',options:Parameters<Architecture['mesh']>[5]={}){return this.mesh(name,[this.library.revolve([[radius,0],[radius,height]],8),this.library.revolve([[radius,0],[radius,height]],5),this.library.revolve([[radius,0],[radius,height]],3)],material,position,[1,1,1],options);}
  roof(name:string,x:number,z:number,width:number,depth:number,y:number,rise:number){
    const material=this.age===1?'thatch_team':this.age>=4?'slate_team':'tile_team';
    this.mesh(name,this.library.extrudeConvex([[-width/2,0],[width/2,0],[0,rise]],depth),material,[x,y,z],[1,1,1],{visibility:{states:['construction','complete'],progress:[.64,1]}});
    this.mesh(`${name}_broken`,this.library.extrudeConvex([[-width/2,0],[-width*.15,rise*.7],[0,rise],[width*.12,0]],depth*.8),material,[x,y,z],[1,1,1],{visibility:{states:['damaged']}});
    for(const side of [-1,1])for(const dz of [-depth*.35,depth*.35])this.box('exposed_roof_beam',[width*.56,.12,.14],[x+side*width*.23,y+rise*.45,z+dz],'char',{visibility:{states:['damaged']},rotation:[0,0,-side*Math.atan2(rise,width/2)]});
  }
  hall(name:string,x:number,z:number,width:number,depth:number,height:number){
    this.box(`${name}_walls`,[width,height,depth],[x,height/2+.16,z],this.age===1?'wood_light':this.age===2?'plaster':'stone_light',{visibility:{states:intact,progress:[.2,1]}});
    this.roof(`${name}_gable`,x,z,width+.12,depth+.12,height+.16,Math.min(width*.42,2));
    const front=z-depth/2-.018;
    this.box('door_recess',[Math.min(1,width*.3),1.45,.045],[x,.9,front],'shadow',{visibility:{states:intact,progress:[.38,1]}});
    for(const side of [-1,1]){
      this.box('door_jamb',[.14,1.65,.14],[x+side*Math.min(.58,width*.18),.97,front],'wood_dark',{detail:1});
      for(const fraction of [.2,.4])this.box('window_shutter',[.42,.58,.07],[x+side*width*fraction,height*.62,front],'shadow',{detail:0});
      for(const fraction of [-.46,-.22,0,.22,.46])this.box('timber_frame',[.13,height,.16],[x+width*fraction,height/2+.16,z+side*(depth/2+.025)],this.age>=3?'stone':'wood_dark',{detail:fraction===0?1:0});
      this.box('lintel_course',[width,.16,.14],[x,height*.72,z+side*(depth/2+.035)],this.age>=4?'bronze':'wood_dark',{detail:1});
    }
    if(this.age>=3)for(const dx of [-width/2+.1,width/2-.1])for(const dz of [-depth/2+.1,depth/2-.1])this.box('masonry_quoin',[.34,height+.15,.34],[x+dx,height/2+.17,z+dz],'stone',{detail:1});
    if(this.age===4)this.box('dressed_stone_frieze',[width,.18,.16],[x,height+.02,front-.045],'bronze',{detail:0});
  }
  banner(x:number,z:number,height:number){this.post('standard_pole',[x,0,z],height,.055,'wood_dark',{detail:1});this.box('heraldic_standard',[.65,.9,.055],[x+.24,height-.55,z],'heraldry');}
  tower(name:string,x:number,z:number,radius:number,height:number,round=false){
    if(round)this.mesh(name,[this.library.revolve([[radius,0],[radius,height]],10),this.library.revolve([[radius,0],[radius,height]],6),this.library.revolve([[radius,0],[radius,height]],4)],this.age<3?'wood_light':'stone',[x,.15,z]);
    else this.box(name,[radius*2,height,radius*2],[x,height/2+.15,z],this.age<3?'wood_light':'stone');
    this.box('tower_band',[radius*2+.12,.3,radius*2+.12],[x,height-.15,z],'team');
    for(let i=0;i<8;i++){const angle=i*Math.PI/4;this.box('tower_merlon',[.38,.52,.38],[x+Math.cos(angle)*radius*.84,height+.41,z+Math.sin(angle)*radius*.84],'stone_light',{detail:i%2===0?1:0});}
    this.box('tower_arrow_slit',[.13,.7,.035],[x,height*.63,z-radius-.02],'shadow',{detail:1});
  }
  foundations(){
    const w=this.width,d=this.depth;
    this.box('plinth',[w*.98,.18,d*.98],[0,.09,0],this.type==='farm'?'soil':'stone',{visibility:{states:['foundation',...intact]}});
    // The perimeter remains readable from every camera angle and at every LOD,
    // including roofless farms and connected defensive structures.
    const trim=Math.min(.35,Math.min(w,d)*.12),ownership={states:['foundation',...intact]} satisfies AssetVisibility;
    for(const side of [-1,1]){
      this.box('ownership_border',[w,this.type.endsWith('_gate')?.16:.24,trim],[0,this.type.endsWith('_gate')?.09:.23,side*(d-trim)/2],'team',{visibility:ownership});
      this.box('ownership_border',[trim,.24,d-trim*2],[side*(w-trim)/2,.23,0],'team',{visibility:ownership});
    }
    this.box('ownership_heraldry',[this.type.endsWith('_gate')?.7:Math.min(1.4,w*.42),.6,.065],[this.type.endsWith('_gate')?-(this.width/2-.5):0,.48,this.type.endsWith('_gate')&&(buildings[this.type]?.minAge??1)>=5?-d/2-.06:-d*.49],'heraldry',{visibility:ownership});
    for(const x of [-w*.43,w*.43])for(const z of [-d*.43,d*.43])this.post('survey_stake',[x,0,z],.65,.08,'wood_light',{visibility:{states:['foundation']}});
    for(const side of [-1,1]){
      this.box('construction_platform',[w*.88,.12,.45],[0,1.85,side*d*.44],'wood_light',{visibility:{states:['construction']}});
      for(const x of [-w*.42,0,w*.42])this.box('scaffold_upright',[.1,2.2,.1],[x,1.1,side*d*.44],'wood',{visibility:{states:['construction']},detail:x===0?0:2});
      this.box('scaffold_diagonal',[.1,2.65,.1],[side*w*.25,1.15,-d*.44],'wood',{visibility:{states:['construction']},rotation:[0,0,side*.5],detail:1});
    }
    for(let i=0;i<9;i++){const a=i*2.399,r=Math.sqrt((i+.5)/9),x=Math.cos(a)*w*.35*r,z=Math.sin(a)*d*.35*r;
      this.mesh('broken_masonry',[this.library.ellipsoid([.6,.28,.5],3,5),this.library.ellipsoid([.6,.28,.5],2,4),this.unitBox],'stone',[x,.22,z],[1+(i%3)*.23,1,1],{visibility:{states:['destroyed']},rotation:[0,i*.71,0],detail:i>4?0:i>2?1:2});
    }
    this.box('fallen_roof_beam',[w*.65,.17,.2],[0,.19,d*.13],'char',{visibility:{states:['destroyed']},rotation:[0,.48,.03]});
    this.box('damage_scar',[this.type.endsWith('_gate')?.65:Math.max(.5,w*.18),.6,.08],[this.type.endsWith('_gate')?-(this.width/2-.5):-w*.18,.57,-d*.49],'char',{visibility:{states:['damaged']}});
  }
}

type Build=(a:Architecture)=>void;
const designs:Record<string,Build>={
  town_center:a=>{a.hall('civic_hall',0,1,7.6,6.5,3.1);a.hall('council_wing',-4,-1.4,3,4.6,2.5);a.hall('council_wing',4,-1.4,3,4.6,2.5);a.tower('bell_lantern',0,1,1.15,5.1,true);a.roof('lantern_roof',0,1,2.8,2.8,5.7,1.4);a.banner(-2.4,-4.8,3.4);for(const x of [-2,0,2])a.post('porch_column',[x,0,-3.5],2.6,.15,'wood',{detail:1});a.box('civic_steps',[5,.3,1.1],[0,.15,-4.2],'stone_light');},
  house:a=>{a.hall('cottage',0,.1,3.5,3.15,1.9);a.box('chimney',[.52,2.8,.55],[.94,1.55,.75],'stone');a.box('woodpile',[.8,.38,.46],[-1.15,.35,-1.48],'wood',{detail:0});},
  mill:a=>{a.tower('mill_shaft',.2,.65,1.55,3.5,true);a.roof('mill_cap',.2,.65,3.6,3.6,3.7,1.5);const parent='mill_sails';a.nodes.push(assetNode(parent,{parentId:'root',position:[.2,3.45,-1.12]}));for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5]){const id=a.node('sail_arm',[0,0,0],parent);a.nodes.find(node=>node.id===id)!.rotation=quaternionFromEuler(0,0,angle);a.box('sail_cloth',[.65,1.45,.08],[.25,1.45,0],'canvas',{parentId:id});a.box('sail_spar',[.12,2.55,.12],[0,1.2,0],'wood',{parentId:id});}a.clips.push({id:'idle',durationSeconds:8,loop:true,tracks:[{nodeId:parent,property:'rotation',times:[0,2,4,6,8],values:[0,.5,1,1.5,2].map(angle=>quaternionFromEuler(0,0,angle*Math.PI))}]});a.hall('grain_store',-1.85,1.1,1.8,3.1,1.4);},
  lumber_camp:a=>{a.hall('saw_shelter',0,1.35,5,2.35,2.1);for(let row=0;row<3;row++)for(let i=0;i<4-row;i++)a.mesh('stacked_log',[a.library.revolve([[.28,-1.8],[.28,1.8]],8),a.library.revolve([[.28,-1.8],[.28,1.8]],5),a.library.revolve([[.28,-1.8],[.28,1.8]],3)],'wood_light',[-.9+i*.58,.4+row*.48,-1.55],[1,1,1],{rotation:[0,0,Math.PI/2],detail:row===2?0:2});a.box('saw_bench',[2.5,.65,.5],[.2,.42,-.45],'wood_dark');a.box('saw_blade',[2.6,.12,.07],[.2,.83,-.45],'iron',{detail:1});},
  mining_camp:a=>{a.hall('miners_office',-1.1,1.1,2.7,3,1.9);for(const x of [.4,2.3])a.post('gantry_post',[x,0,-1.1],3,.16);a.box('gantry_beam',[2.2,.24,.3],[1.35,2.9,-1.1],'wood_dark');a.mesh('ore_bucket',a.library.revolve([[.48,0],[.62,.8]],7),'iron',[1.3,.25,-1.1]);a.post('hoist_rope',[1.3,1.05,-1.1],1.8,.035,'wood_dark',{detail:1});for(let i=0;i<4;i++)a.mesh('ore_sorting_pile',a.library.ellipsoid([.45,.38,.42],2,5),'stone',[.3+i*.5,.36,1.8],[1,1,1],{detail:1});},
  farm:a=>{for(let row=0;row<8;row++){a.box('irrigation_furrow',[5.55,.07,.1],[0,.22,(row-3.5)*.65],'wood_dark',{detail:row%2?0:2});for(let column=0;column<8;column++){const detail=(row%4===0&&column%4===0)?2:(row%2===0&&column%2===0)?1:0;a.mesh('grain_sheaf',a.library.revolve([[.07,0],[.1,.45],[.03,.75]],4),'grain',[(column-3.5)*.65,.22,(row-3.5)*.65],[1,1,1],{detail,visibility:{states:intact,progress:[.5,1],farm:['ready']}});a.box('cut_stubble',[.07,.1,.07],[(column-3.5)*.65,.27,(row-3.5)*.65],'thatch',{detail,visibility:{states:intact,farm:['exhausted','reseeding']}});}}if(a.age>=2)for(const x of [-2.8,2.8])a.box('field_border',[.15,.2,5.7],[x,.24,0],a.age>=3?'stone':'wood_light');if(a.age===4)a.box('stone_water_channel',[5.5,.12,.26],[0,.24,-2.7],'water');},
  barracks:a=>{a.hall('long_training_hall',0,1,6.9,4.8,2.8);a.roof('entry_porch',0,-2.1,2.8,1.8,2,1);for(const x of [-2.8,-1.9,1.9,2.8]){a.post('weapon_rack_spear',[x,0,-2.65],2.25,.045,'wood_light',{detail:1});a.mesh('rack_spearhead',a.library.revolve([[.12,0],[0,.38]],4),'iron',[x,2.25,-2.65],[1,1,1],{detail:0});}a.banner(-3.3,-3.1,3.6);},
  archery_range:a=>{a.hall('archers_lodge',-2.4,.8,2.6,5.4,2.4);for(const z of [-2.4,0,2.4]){a.post('target_stand',[2.2,0,z],1.3,.09);a.mesh('straw_target',[a.library.revolve([[.72,-.13],[.72,.13]],12),a.library.revolve([[.72,-.13],[.72,.13]],8),a.library.revolve([[.72,-.13],[.72,.13]],5)],'thatch',[2.2,1.4,z],[1,1,1],{rotation:[0,0,Math.PI/2]});a.mesh('target_centre',a.library.revolve([[.21,-.015],[.21,.015]],8),'berry',[2.04,1.4,z],[1,1,1],{rotation:[0,0,Math.PI/2],detail:1});}a.box('range_shooting_line',[.1,.04,6.2],[-.3,.23,0],'canvas');},
  stable:a=>{a.hall('stable_barn',0,1.7,6.8,3.6,2.7);for(const x of [-2.3,0,2.3])a.box('stall_opening',[1.5,1.7,.055],[x,1.05,-.13],'shadow');for(const x of [-3.4,3.4]){for(const z of [-3,-1.7])a.post('paddock_post',[x,0,z],1.2,.09);for(const y of [.5,1])a.box('paddock_rail',[.13,.1,3.1],[x,y,-1.8],'wood_light',{detail:1});}a.box('horse_trough',[2,.42,.65],[0,.4,-2.7],'wood_dark');a.box('trough_water',[1.75,.05,.45],[0,.63,-2.7],'water',{detail:1});},
  blacksmith:a=>{a.hall('forge_hall',-.65,.65,3.8,3.8,2.3);a.box('forge_stack',[1.2,4.4,1.2],[1.95,2.2,1.5],'stone');a.box('chimney_mouth',[.83,.06,.83],[1.95,4.42,1.5],'shadow');a.box('anvil_foot',[.55,.45,.6],[.4,.45,-1.8],'wood_dark');a.box('anvil_table',[1.05,.3,.45],[.4,.8,-1.8],'iron');a.mesh('anvil_horn',a.library.revolve([[.16,0],[0,.55]],5),'iron',[.9,.8,-1.8],[1,1,1],{rotation:[0,0,-Math.PI/2],detail:1});a.box('bellows',[.8,.22,.65],[-1.2,.75,-1.5],'wood',{detail:0});},
  market:a=>{a.tower('market_clock',0,.75,.9,3.7,true);for(const side of [-1,1]){a.hall('storehouse',side*2.5,1.8,2,2.8,1.8);a.box('stall_counter',[2.5,.65,1],[side*2.1,.6,-1.8],'wood_light');a.roof('cloth_stall',side*2.1,-1.8,2.8,2,2.05,.5);a.box('awning_stripe',[.45,.08,2.05],[side*2.1,2.35,-1.8],'team');for(const x of [-1,1])a.post('awning_post',[side*2.1+x*1.2,0,-2.6],2.05,.07);for(let i=0;i<3;i++)a.mesh('market_basket',a.library.revolve([[.26,0],[.34,.38]],6),'thatch',[side*2.1+(i-1)*.6,.95,-1.8],[1,1,1],{detail:0});}a.banner(0,-2.4,3.2);},
  siege_workshop:a=>{a.hall('assembly_hall',-1,1.2,6.8,5.5,3.2);a.box('workshop_aperture',[3.6,2.4,.06],[-1,1.42,-1.58],'shadow');for(const x of [3,4.3])a.post('crane_trestle',[x,0,-1.5],3.6,.18);a.box('lifting_jib',[3.1,.24,.24],[3.1,3.45,-1.5],'wood_dark');for(const z of [-2.7,0,2.7])a.mesh('spare_siege_wheel',[a.library.revolve([[.85,-.13],[.85,.13]],12),a.library.revolve([[.85,-.13],[.85,.13]],8),a.library.revolve([[.85,-.13],[.85,.13]],5)],'wood',[3.4,.9,z],[1,1,1],{rotation:[0,0,Math.PI/2]});},
  university:a=>{a.hall('library_wing',0,2.4,7.2,2.5,2.8);for(const x of [-2.9,2.9])a.hall('cloister_wing',x,-.4,1.45,4.2,2.3);for(const x of [-1.6,0,1.6])a.post('arcade_column',[x,0,-2.65],2.4,.13,'stone_light',{detail:1});a.box('arcade_entablature',[6.7,.35,.65],[0,2.5,-2.65],'stone');a.mesh('observatory_dome',[a.library.revolve([[1.15,0],[1.05,.6],[.6,1.05],[0,1.2]],12),a.library.revolve([[1.15,0],[.8,.9],[0,1.2]],8),a.library.revolve([[1.15,0],[0,1.2]],5)],'slate',[0,3.55,2.3]);a.box('courtyard_dais',[1.4,.25,1.4],[0,.27,0],'stone_light');},
  watchtower:a=>{a.tower('watch_shaft',0,0,1.25,4.6,true);a.roof('watch_canopy',0,0,3.5,3.5,5.12,1.25);a.banner(1.2,-1.2,3.6);for(const y of [.8,1.7,2.6,3.5])a.box('ladder_rung',[.65,.1,.16],[0,y,-1.27],'wood_light',{detail:0});},
  fortress:a=>{a.hall('citadel_keep',0,1,6,5.5,5);for(const x of [-4.65,4.65])for(const z of [-4.65,4.65])a.tower('corner_bastion',x,z,1.1,4.7,true);for(const side of [-1,1]){a.box('curtain_wall',[.8,3.5,9.8],[side*4.7,1.9,0],'stone');a.box('rear_curtain',[9.8,3.5,.8],[0,1.9,side*4.7],'stone');for(let i=-3;i<=3;i++)a.box('curtain_merlon',[.5,.5,.85],[i*1.2,3.9,-4.7],'stone_light',{detail:i%2===0?1:0});}a.box('fortress_portal',[2.3,2.8,.06],[0,1.55,-5.12],'shadow');a.banner(0,-3.1,6.6);},
  monument:a=>{for(let step=0;step<4;step++)a.box('ceremonial_terrace',[13-step*2,.65,13-step*2],[0,.5+step*.65,0],step%2?'stone':'stone_light');a.mesh('sovereign_obelisk',[a.library.revolve([[1.15,0],[.85,5.6],[0,7]],8),a.library.revolve([[1.15,0],[.85,5.6],[0,7]],6),a.library.revolve([[1.15,0],[.85,5.6],[0,7]],4)],'stone_light',[0,2.9,0]);a.mesh('bronze_crown',a.library.revolve([[1.05,0],[1.35,.45],[.8,.7]],8),'bronze',[0,7.45,0]);for(const x of [-5.8,5.8])for(const z of [-5.8,5.8]){a.post('ceremonial_column',[x,.9,z],3.3,.3,'stone');a.banner(x,z,4.9);}for(let i=-3;i<=3;i++)a.box('ceremonial_stair',[4,.16,1],[0,.12+(i+3)*.15,-6.9+(i+3)*.65],'stone_light',{detail:0});},
};
/** Vertical spectacle stays inside the authoritative plot. Decorations use shared
 * meshes and disappear at distance; none are separate simulation actors. */
function legendaryBuilding(a:Architecture){
  const tier=buildings[a.type]!.minAge-5;
  if(a.type.endsWith('_citadel')){
    const height=[24,30,38,48][tier]!, crown=tier===3;
    a.hall('great_hall',0,1,10,9,9+tier*2);
    for(const x of [-7.1,7.1])for(const z of [-7.1,7.1]){
      a.tower('great_corner_keep',x,z,2.1,12+tier*4,tier%2===1);
      a.banner(x,z,14+tier*4);
      if(tier>=2)a.mesh('guardian_head',a.library.ellipsoid([.8,1.4,.8],3,6),'stone_light',[x,8,z-2.05],[1,1,1],{detail:1});
    }
    for(const side of [-1,1]){
      a.box('layered_curtain',[1.1,8+tier,14],[side*8.2,4+tier/2,0],'stone');
      a.box('gallery_roof',[1.35,.6,14],[side*8.2,8.4+tier,0],'slate_team');
      for(let i=-3;i<=3;i++)a.box('curtain_tooth',[1.2,.9,.9],[side*8.2,9+tier,i*2],'stone_light',{detail:Math.abs(i)%2?0:1});
      a.box('rear_curtain',[14,7+tier,1.1],[0,3.5+tier/2,side*8.2],'stone');
    }
    // Each stage changes the skyline: broad keep, octagonal rune tower,
    // paired guardian pinnacles, then an open eight-point crown.
    const shaft=height-(crown?7:4);
    a.tower('central_sovereign_keep',0,1,2.6,shaft,tier===1||crown);
    if(tier===0)a.roof('high_keep_roof',0,1,5.6,5.6,shaft+.5,3.3);
    else if(tier===1)a.mesh('runic_cap',a.library.revolve([[2.7,0],[1.9,1.5],[0,3.2]],8),'rune',[0,shaft+.5,1]);
    else if(tier===2)for(const x of [-1.7,1.7])a.mesh('guardian_pinnacle',a.library.revolve([[.85,0],[.65,2.6],[0,3.6]],6),'stone_light',[x,shaft+.4,1]);
    else for(let i=0;i<8;i++){const angle=i*Math.PI/4;a.mesh('crown_point',a.library.revolve([[.55,0],[.4,4.8],[0,6.4]],5),'bronze',[Math.cos(angle)*2.15,shaft+.3,1+Math.sin(angle)*2.15]);}
    a.box('broad_citadel_portal',[5,5,.08],[0,2.7,-8.8],'shadow');
    for(const x of [-3,3])a.box('portal_buttress',[1.1,8,1.3],[x,4,-8.2],'stone_light');
    a.box('citadel_standard',[2.2,4,.09],[0,shaft*.72,-1.65],'heraldry');
    if(tier>=1)for(let i=0;i<4;i++)a.box('carved_rune_seam',[.17,2.5,.06],[(i-1.5)*.8,shaft*.52,-1.64],'rune',{detail:1});
  }else if(a.type==='great_siege_yard'){
    a.hall('siege_assembly_hall',0,2.3,14.7,6.6,7.4);
    a.box('giant_exit',[8.3,6.4,.08],[0,3.35,-1.06],'shadow');
    for(const x of [-6.7,6.7])a.post('gantry_column',[x,0,-3.5],10,.4,'wood_dark');
    a.box('great_hoist',[14.2,.65,.65],[0,9.6,-3.5],'wood');
    for(const x of [-4.8,4.8]){a.post('hoist_chain',[x,5.3,-3.5],4.2,.07,'iron',{detail:1});a.mesh('great_spare_wheel',[12,7,4].map(n=>a.library.revolve([[1.6,-.18],[1.6,.18]],n)) as [string,string,string],'wood_light',[x,1.65,-3.5],[1,1,1],{rotation:[0,0,Math.PI/2]});}
    for(const x of [-2,0,2])a.mesh('ammunition_stock',a.library.ellipsoid([.7,.7,.7],3,6),'stone',[x,.85,4.8], [1,1,1],{detail:1});
    a.banner(6.8,4.7,9);
  }else if(a.type==='rune_forge'){
    a.hall('carvers_hall',-1,1,6.3,7.4,4.6);a.box('stone_furnace',[2.3,8,2.5],[3.1,4,2.7],'stone');
    a.box('furnace_mouth',[1.1,1.3,.07],[3.1,1.8,1.42],'rune');
    for(const x of [-3,0,3]){a.box('rune_slab',[1.6,2.1,.55],[x,1.15,-3.5],'stone_light',{rotation:[.15,0,0]});a.box('carved_glyph',[.14,1.25,.06],[x,1.2,-3.82],'rune',{detail:0});}
    a.box('great_anvil',[2,.55,.8],[0,1,-1.6],'iron');a.box('bellows',[1.3,.5,1],[-2,.6,-1.5],'wood_light');a.banner(-3.8,3.7,5.8);
  }else if(a.type==='ward_spire'){
    a.mesh('exposed_runestone',[8,5,3].map(n=>a.library.revolve([[1.35,0],[1.15,2],[.72,10],[.35,12],[0,13]],n)) as [string,string,string],'stone_light',[0,.2,0]);
    for(let i=0;i<4;i++){const angle=i*Math.PI/2+Math.PI/8;a.box('rune_inscription',[.13,3,.055],[Math.sin(angle)*.86,7,Math.cos(angle)*.86],'rune',{rotation:[-Math.atan(.43/8),angle,0],detail:1});}
    a.mesh('open_crown',[8,4,4].map(n=>a.library.revolve([[.6,0],[1.3,.4],[.8,.8]],n)) as [string,string,string],'bronze',[0,10.1,0]);a.banner(-1.4,-1.2,3.3);
    for(let face=0;face<4;face++)for(let line=0;line<5;line++){const angle=face*Math.PI/2+Math.PI/8,y=3+line*.6,radius=(1.15-(y-2.2)*.43/8)*Math.cos(Math.PI/8)+.035;a.box('engraved_ward_script',[.5,.075,.045],[Math.sin(angle)*radius,y,Math.cos(angle)*radius],'rune',{rotation:[-Math.atan(.43/8),angle,0],detail:0});}
  }else throw new Error(`MISSING_LEGENDARY_BUILDING:${a.type}`);
}
function legendaryFortification(a:Architecture){
  const tier=buildings[a.type]!.minAge-5,height=5+tier*2,runic=tier>0;
  if(a.type.endsWith('_gate')){
    const opening=buildings[a.type]!.gatePassageWidthM!,post=(a.width-opening)/2;
    for(const sign of [-1,1]){
      const x=sign*(opening/2+post/2);
      a.box('wide_gate_pier',[post-.04,height+3,a.depth*.95],[x,(height+3)/2,0],'stone');
      a.box('gate_keep_crown',[post+.1,height*.22,a.depth+.1],[x,height+3,0],'team');
      if(tier>=2)a.mesh('gate_guardian_face',a.library.ellipsoid([post*.38,.7,.2],3,5),'stone_light',[x,height+1,-a.depth/2-.18],[1,1,1],{detail:1});
      if(buildings[a.type]!.attack>0)a.box('gate_arrow_slit',[.13,.7,.035],[x,(height+3)*.65,-a.depth/2-.04],'shadow',{detail:1});
      const id=sign<0?'gate_left':'gate_right';a.nodes.push(assetNode(id,{parentId:'root',position:[sign*(opening/2+.15),0,0],visibility:{states:intact,progress:[.6,1]}}));
      a.box('wide_gate_leaf',[opening/2+.15,height-.2,.18],[-sign*(opening/4+.075),height/2,0],'wood_dark',{parentId:id});
      for(const y of [1,height/2,height-1])a.box('great_gate_binding',[opening/2,.2,.2],[-sign*opening/4,y,0],runic?'rune':'iron',{parentId:id,detail:1});
      for(let plank=0;plank<8;plank++)a.box('great_gate_plank_seam',[.035,height-.3,.025],[-sign*(.3+plank*.5),height/2,-.11],'shadow',{parentId:id,detail:0});
      for(let course=0;course<5;course++)a.box('pier_masonry_joint',[post*.9,.055,.035],[x,.8+course*(height+1)/5,-a.depth*.49],'shadow',{detail:0});
    }
    a.box('wide_gate_arch',[a.width,1,a.depth],[0,height+1,0],'stone_light');a.box('gate_heraldry',[1.2,1.3,.08],[0,height+1,-a.depth/2-.05],'heraldry');
    a.clips.push({id:'gate_open',durationSeconds:.7,loop:false,tracks:[{nodeId:'gate_left',property:'rotation',times:[0,.7],values:[[0,0,0,1],quaternionFromEuler(0,-Math.PI/2,0)]},{nodeId:'gate_right',property:'rotation',times:[0,.7],values:[[0,0,0,1],quaternionFromEuler(0,Math.PI/2,0)]}]});
  }else for(const axis of [0,1]){
    const masks=Array.from({length:16},(_,mask)=>mask).filter(mask=>axis===0?!!(mask&5)||mask===0:!!(mask&10)),parent=a.node('legendary_wall_run');
    const node=a.nodes.find(n=>n.id===parent)!;node.rotation=quaternionFromEuler(0,axis*Math.PI/2,0);node.visibility={wallMask:masks};
    a.box('great_wall_core',[2,height,1.45],[0,height/2,0],'stone',{parentId:parent});
    a.box('buttressed_wall_foot',[2,.6,1.9],[0,.35,0],'stone_light',{parentId:parent});
    a.box('gallery_band',[2,.35,1.65],[0,height-.7,0],'team',{parentId:parent});
    for(const x of [-.65,0,.65])a.box('great_crenellation',[.4,.85,1.55],[x,height+.4,0],'stone_light',{parentId:parent,detail:x===0?1:0});
    for(let i=0;i<5+tier;i++)a.box('stone_course',[1.9,.045,.045],[0,.8+i*(height-1.5)/(5+tier),-.76],'shadow',{parentId:parent,detail:0});
    if(runic)a.box('wall_rune',[.13,1.5,.055],[0,height*.55,-.76],'rune',{parentId:parent,detail:1});
  }
}
function fortification(a:Architecture){
  if(a.age>=5&& !['stone_wall','palisade_wall','wooden_gate','stone_gate'].includes(a.type)){legendaryFortification(a);return;}
  const stone=a.type.startsWith('stone'),material=stone?'stone':'wood_light';
  if(a.type.endsWith('_gate')){
    const passage=balance.buildings.find(item=>item.id===a.type)!.gatePassageWidthM!,post=(a.width-passage)/2;
    for(const sign of [-1,1]){
      a.box('gate_pier',[post,3.5,a.depth*.9],[sign*(passage/2+post/2),1.9,0],material);
      const id=sign<0?'gate_left':'gate_right';a.nodes.push(assetNode(id,{parentId:'root',position:[sign*2.125,0,0],visibility:{states:intact,progress:[.6,1]}}));
      a.box('gate_leaf',[2.125,2.65,.18],[-sign*1.0625,1.48,0],stone?'wood_dark':'wood',{parentId:id});
      for(const y of [.65,1.7,2.5])a.box('gate_iron_binding',[2.1,.12,.2],[-sign*1.05,y,0],'iron',{parentId:id,detail:y===1.7?1:0});
      for(let i=0;i<6;i++)a.box('gate_board',[.035,2.57,.025],[-sign*(.2+i*.34),1.48,-.106],'wood_dark',{parentId:id,detail:0});
    }
    a.box('gate_architrave',[a.width,.42,a.depth*.9],[0,3.7,0],'team');a.box('gate_heraldry',[.7,.9,.08],[0,3.75,-a.depth*.47],'heraldry');
    for(const sign of [-1,1])a.box('pier_cap',[.9,.3,a.depth],[sign*2.5,3.85,0],stone?'stone_light':'wood',{detail:1});
    if(a.age>=2)for(const sign of [-1,1])a.box('age_pier_strap',[.85,.18,.08],[sign*2.5,2,-a.depth*.48],a.age===4?'bronze':'iron',{detail:1});
    if(a.age>=3)for(const sign of [-1,1])a.box('dressed_pier_foot',[.96,.4,a.depth*.94],[sign*2.5,.38,0],'stone_light');
    a.clips.push({id:'gate_open',durationSeconds:.4,loop:false,tracks:[{nodeId:'gate_left',property:'rotation',times:[0,.4],values:[[0,0,0,1],quaternionFromEuler(0,-Math.PI/2,0)]},{nodeId:'gate_right',property:'rotation',times:[0,.4],values:[[0,0,0,1],quaternionFromEuler(0,Math.PI/2,0)]}]});
  }else for(const axis of [0,1]){
    const masks=Array.from({length:16},(_,mask)=>mask).filter(mask=>axis===0?Boolean(mask&5)||mask===0:Boolean(mask&10)),parent=a.node('wall_run');a.nodes.find(node=>node.id===parent)!.rotation=quaternionFromEuler(0,axis*Math.PI/2,0);a.nodes.find(node=>node.id===parent)!.visibility={wallMask:masks};
    if(stone){
      for(let lod=0;lod<3;lod++){const count=[4,2,1][lod]!;for(let row=0;row<count;row++)for(let column=0;column<count;column++){const geometry:[string|null,string|null,string|null]=[null,null,null];geometry[lod]=a.unitBox;a.mesh('ashlar_block',geometry,row%2?'stone':'stone_light',[(column+.5)*2/count-1,.15+(row+.5)*2.3/count,0],[2/count-.015,2.3/count-.015,.8],{parentId:parent,visibility:{states:intact,progress:[.2+.6*row/count,1]}});}for(let i=0;i<[4,2,1][lod]!;i++){const geometry:[string|null,string|null,string|null]=[null,null,null];geometry[lod]=a.unitBox;a.mesh('battlement',geometry,'stone_light',[(i+.5)*2/[4,2,1][lod]!-1,2.68,0],[.32,.42,.82],{parentId:parent,visibility:{states:intact,progress:[.85,1]}});}}
    }else for(let lod=0;lod<3;lod++){const count=[10,6,3][lod]!;for(let i=0;i<count;i++){const geometry:[string|null,string|null,string|null]=[null,null,null];geometry[lod]=a.library.revolve([[.14,0],[.14,2.25],[0,2.65]],lod===0?6:4);a.mesh('sharpened_stake',geometry,'wood_light',[(i+.5)*2/count-1,.15,0],[1,1,1],{parentId:parent,visibility:{states:intact,progress:[.2+.65*i/count,1]}});}}
    for(const y of [.7,1.7])a.box('wall_crossbrace',[2,y===1.7?.3:.16,.17],[0,y,.26],y===1.7?'team':stone?'stone':'wood_dark',{parentId:parent,...(y===.7?{detail:1 as const}:{})});
    if(a.age>=2)a.box('age_wall_binding',[1.75,.12,.1],[0,1.22,.43],a.age===4?'bronze':'iron',{parentId:parent,detail:1});
    if(a.age>=3)a.box('dressed_wall_foot',[1.95,.35,.86],[0,.32,0],'stone_light',{parentId:parent});
  }
}
export function generateBuildingAssets(library:AssetLibraryBuilder):AssetBlueprint[]{
  architecturalMaterials(library);
  return Object.values(buildings).map(definition=>{
    const width=definition.footprintCells[0]*balance.rules.buildingGridM,depth=definition.footprintCells[1]*balance.rules.buildingGridM,variants:AssetVariant[]=[];let clips:AssetClip[]=[];
    for(let age=definition.minAge;age<=8;age++){
      const author=new Architecture(library,definition.id,age,width,depth);author.foundations();
      if(definition.id.endsWith('_wall')||definition.id.endsWith('_gate'))fortification(author);else if(definition.minAge>=5)legendaryBuilding(author);else{const design=designs[definition.id];if(!design)throw new Error(`MISSING_BUILDING_DESIGN:${definition.id}`);design(author);}
      if(age>=2&&!['farm'].includes(definition.id)&&!definition.id.endsWith('_wall')&&!definition.id.endsWith('_gate'))author.box('age_header',[Math.min(width*.6,3),.15,.13],[0,.42,-depth*.48],age>=4?'bronze':age===3?'stone_light':'wood_dark',{detail:1});
      if(age===4&&!definition.id.endsWith('_wall')&&!definition.id.endsWith('_gate')&&definition.id!=='farm')author.banner(width*.36,depth*.35,3.8);
      if(age>=5)for(let i=0;i<age-4;i++)author.box('legendary_age_inlay',[.15,.35,.055],[(i-(age-5)/2)*.32,.58,-depth*.475],age>=6?'rune':'bronze',{detail:1});
      if(age>=5&&definition.minAge<5&&!definition.id.endsWith('_wall')&&!definition.id.endsWith('_gate')){author.banner(width*.36,depth*.35,3.8+(age-4)*.3);if(age>=7)for(const x of [-width*.38,width*.38])author.post('civilian_stone_buttress',[x,0,depth*.37],1.7+(age-7)*.4,.16,'stone_light',{detail:1});}
      variants.push({key:`age_${age}`,age:age as AssetVariant['age'],nodes:author.nodes});if(!clips.length)clips=author.clips;
    }
    const legendaryHeight=definition.id.endsWith('_citadel')?({grand_citadel:24,runic_citadel:30,titan_citadel:38,eternal_citadel:48} as Record<string,number>)[definition.id]!+.8:definition.minAge>=5?18:undefined;
    return {id:definition.id,kind:'building',variants,clips,sockets:definition.id.endsWith('_citadel')?{projectile:variants[0]!.nodes.filter(node=>node.id.startsWith('tower_arrow_slit_')).at(-1)!.id}:definition.id.endsWith('_gate')?{gate_left:'gate_left',gate_right:'gate_right',...(definition.projectileLaunchHeightM?{projectile:variants[0]!.nodes.find(node=>node.id.startsWith('gate_arrow_slit_'))!.id}:{})}:definition.id==='mill'?{mill_sails:'mill_sails'}:{},bounds:{min:[-width/2-.4,-.35,-depth/2-.4],max:[width/2+.4,legendaryHeight??(definition.id==='monument'?10.1:definition.id==='town_center'?7.3:definition.id==='fortress'?7.5:6.6),definition.id.endsWith('_gate')?Math.max(2.3,(definition.gatePassageWidthM??4)/2+.25):depth/2+.4]},collision:{kind:'footprint',widthM:width,depthM:depth,...(definition.id.endsWith('_gate')?{gatePassageWidthM:definition.gatePassageWidthM}:{})}} as AssetBlueprint;
  });
}
