import { units } from '../../shared/src/content.js';
import { assetNode, quaternionFromEuler as q, type AssetLibraryBuilder } from './geometry.js';
import type { AssetBlueprint, AssetClip, AssetNode, AssetTrack, AssetVariant, Vec3 } from './types.js';

/** Original articulated siege and living stone. Cosmetic crews, ropes and keeps
 * share geometry and are never additional authoritative entities. */
export function generateLegendaryUnits(lib:AssetLibraryBuilder):AssetBlueprint[]{
  const box=lib.box([1,1,1]),round=[10,6,4].map(n=>lib.revolve([[.5,-.5],[.5,.5]],n)) as [string,string,string];
  const rock=[lib.ellipsoid([1,1,1],4,8),lib.ellipsoid([1,1,1],3,5),lib.ellipsoid([1,1,1],2,4)] as [string,string,string];
  const mat=(id:string,color:[number,number,number,number],extra={})=>lib.material({id:`legend_${id}`,baseColor:color,roughness:.85,...extra});
  const stone=mat('stone',[.51,.55,.48,1]),light=mat('cut_stone',[.73,.75,.65,1]),wood=mat('oak',[.35,.23,.12,1]),iron=mat('iron',[.24,.28,.29,1]),gold=mat('bronze',[.68,.48,.21,1]),rope=mat('rope',[.69,.60,.41,1]),scar=mat('fractured_stone',[.19,.23,.21,1]);
  const team=mat('team',[1,1,1,1],{teamTint:true}),heraldry=mat('heraldry',[1,1,1,1],{teamTint:true,heraldry:true}),rune=mat('rune',[.55,.72,.63,1],{emissive:[.08,.16,.1]});
  return Object.values(units).filter(def=>def.minAge>=5).map(def=>{
    const id=def.id,giant=id==='stone_warden'||id==='crown_colossus',crown=id==='crown_colossus',ram=id.endsWith('_ram'),treb=id.endsWith('_trebuchet'),world=id==='worldbreaker_trebuchet',ballista=id==='wardbreaker_ballista';
    const r=def.collisionRadiusM,s=r/(giant?1.6:1.3),height=giant?(crown?16:9):treb?(world?14:9):ram?(id==='colossus_ram'?7:3.8):4;
    const nodes:AssetNode[]=[assetNode('rig')];
    const joint=(name:string,parent:string,position:Vec3,rotation:Vec3=[0,0,0])=>nodes.push(assetNode(name,{parentId:parent,position,rotation:q(...rotation)}));
    const part=(name:string,parent:string,size:Vec3,pos:Vec3,materialId:string,geometry:string|[string,string,string]=box,detail:0|1|2=2,rotation:Vec3=[0,0,0])=>nodes.push(assetNode(name,{parentId:parent,position:pos,scale:size,rotation:q(...rotation),mesh:{geometry:typeof geometry==='string'?[geometry,detail===0?null:geometry,detail<2?null:geometry]:[geometry[0],detail===0?null:geometry[1],detail<2?null:geometry[2]],materialId}}));
    joint('body','rig',[0,0,0]);
    if(giant){
      const h=crown?9:6;
      part('carved_torso','body',[2.1*s,2.5*s,1.45*s],[0,h*.65,0],stone,rock);
      part('breast_rune','body',[.17,1.5*s,.06],[0,h*.7,1.42*s],rune,box,1);part('waist_course','body',[2.6*s,.4*s,1.8*s],[0,h*.4,0],gold);
      for(const sign of [-1,1]){
        const side=sign<0?'left':'right';joint(`${side}_leg`,'body',[sign*.8*s,h*.37,0]);
        part(`${side}_stone_thigh`,`${side}_leg`,[.63*s,h*.17,.68*s],[0,-h*.10,0],stone,rock);
        part(`${side}_greave`,`${side}_leg`,[.86*s,h*.18,.95*s],[0,-h*.23,.08*s],light);part(`${side}_foot`,`${side}_leg`,[1.1*s,.5*s,1.75*s],[0,-h*.33,.35*s],stone);
        joint(`${side}_arm`,'body',[sign*1.45*s,h*.81,0]);part(`${side}_shoulder`,`${side}_arm`,[.7*s,.6*s,.85*s],[0,0,0],light,rock);
        part(`${side}_forearm`,`${side}_arm`,[.68*s,1.8*s,.8*s],[sign*.15*s,-1.15*s,0],stone);part(`${side}_fist`,`${side}_arm`,[.8*s,.8*s,.8*s],[sign*.15*s,-2.2*s,.1*s],light,rock);
      }
      part('guardian_head','body',[.7*s,.9*s,.65*s],[0,h+.15*s,0],light,rock);
      for(const sign of [-1,1])part(`carved_eye_${sign}`,'body',[.18*s,.1*s,.05],[sign*.28*s,h+.2*s,.64*s],rune,box,1);
      part('maul_shaft','right_arm',[.18*s,3*s,.18*s],[.15*s,-2*s,.5*s],wood);part('stone_maul','right_arm',[1.3*s,.9*s,.9*s],[.15*s,-.6*s,.5*s],stone);
      if(crown){
        part('shoulder_keep','body',[3.3*s,2.2,2.7*s],[0,h+1.2,0],stone);
        for(const x of [-1,1])for(const z of [-1,1]){part(`crown_tower_${x}_${z}`,'body',[.65*s,3.5,.65*s],[x*1.2*s,h+1.7,z*s],light);part(`crown_merlon_${x}_${z}`,'body',[.72*s,.5,.72*s],[x*1.2*s,h+3.7,z*s],gold,box,1);}
        joint('turret','body',[0,h+2.7,.7*s]);part('turret_crossbow','turret',[1.8,.15,.3],[0,0,0],wood);part('turret_bolt','turret',[.09,.09,1.7],[0,0,.7],iron,box,1);
        part('passenger_portal','body',[1.0*s,1.5,.06],[0,h+.7,-1.36*s],iron);part('passenger_ladder','body',[.85*s,4,.13],[0,h-1.5,-1.4*s],wood,box,1);
        for(let i=0;i<8;i++)part(`ladder_rung_${i}`,'body',[.9*s,.09,.17],[0,h-3.2+i*.45,-1.49*s],rope,box,0);
      }
      part('guardian_heraldry','body',[.9*s,1.6*s,.06],[-.7*s,h*.7,1.45*s],heraldry);
      for(let i=0;i<3;i++){part(`fracture_${i}`,'body',[.065*s,.65*s,.06],[(.3+i*.16)*s,h*.65-i*.4,1.45*s],scar,box,1,[0,0,i%2?.32:-.28]);nodes.at(-1)!.visibility={damage:[.3,1]};}
    }else{
      const length=r*2.9,w=r*1.35;
      for(const sign of [-1,1])part(`oak_runner_${sign}`,'body',[.26*s,.38*s,length],[sign*w*.62,.85*s,0],wood);
      for(let i=-1;i<=1;i++)part(`crossbeam_${i}`,'body',[w*1.4,.25*s,.26*s],[0,.88*s,i*length*.3],iron);
      for(const sign of [-1,1])for(let i=0;i<(r>2?3:2);i++){
        const name=`wheel_${sign}_${i}`,z=(i-(r>2?1:.5))*length*.48;joint(name,'body',[sign*w*.78,.58*s,z],[0,0,Math.PI/2]);
        part(`${name}_rim`,name,[1.13*s,.25*s,1.13*s],[0,0,0],iron,round);part(`${name}_hub`,name,[.35*s,.31*s,.35*s],[0,0,0],gold,round,1);
        for(let spoke=0;spoke<3;spoke++)part(`${name}_spoke_${spoke}`,name,[.94*s,.055*s,.12*s],[0,-.15*s,0],wood,box,0,[0,spoke*Math.PI/3,0]);
      }
      if(ram){
        for(const sign of [-1,1])for(const z of [-length*.32,length*.32])part(`ram_stanchion_${sign}_${z}`,'body',[.22*s,1.8*s,.22*s],[sign*w*.54,1.8*s,z],wood);
        part('iron_roof','body',[1,1,1],[0,2.6*s,0],iron,lib.extrudeConvex([[-w*.75,0],[0,1.1*s],[w*.75,0]],length*.93));
        for(let i=-2;i<=2;i++)part(`roof_rib_${i}`,'body',[w*1.4,.12*s,.15*s],[0,3.1*s,i*length*.18],gold,box,1);
        joint('weapon','body',[0,1.7*s,0]);part('great_ram_beam','weapon',[.5*s,.5*s,length*1.18],[0,0,.2*s],wood);part('carved_beast_head','weapon',[.68*s,.65*s,.7*s],[0,0,length*.64],iron,rock);
        for(const z of [-length*.3,length*.3])part(`suspension_chain_${z}`,'body',[.055*s,1.2*s,.055*s],[0,2.25*s,z],iron,box,1);
        for(const sign of [-1,1]){part(`crew_head_${sign}`,'weapon',[.17*s,.19*s,.17*s],[sign*w*.37,-.25*s,-.3*s],rope,rock,0);part(`crew_tunic_${sign}`,'weapon',[.25*s,.5*s,.25*s],[sign*w*.37,-.7*s,-.3*s],team,box,0);}
      }else if(ballista){
        part('torsion_stock','body',[.42*s,.45*s,length],[0,1.65*s,0],wood);joint('weapon','body',[0,1.95*s,0]);
        for(const sign of [-1,1]){part(`bow_arm_${sign}`,'weapon',[w*.75,.15*s,.21*s],[sign*w*.35,0,.1*s],wood,box,2,[0,sign*.2,0]);part(`torsion_rope_${sign}`,'body',[.3*s,.75*s,.3*s],[sign*w*.62,1.85*s,0],rope,round,1);}
        part('engraved_bolt','weapon',[.15*s,.15*s,length*.9],[0,.2*s,.6*s],rune);part('bolt_head','weapon',[.3*s,.3*s,.45*s],[0,.2*s,length*.62],iron,rock);
      }else{
        const pivot=height*.60;
        for(const sign of [-1,1]){part(`great_trestle_${sign}`,'body',[.38*s,pivot,.4*s],[sign*w*.55,pivot/2+.6*s,0],wood,box,2,[0,0,sign*.11]);part(`diagonal_brace_${sign}`,'body',[.25*s,pivot*.85,.26*s],[sign*w*.47,pivot*.46,-.55*s],iron,box,1,[-.32,0,0]);}
        joint('weapon','body',[0,pivot,0],[-.65,0,0]);part('throwing_arm','weapon',[.28*s,.35*s,length*1.45],[0,0,-length*.20],wood);
        if(treb){part('hanging_counterweight','weapon',[1.2*s,1.5*s,1*s],[0,-.6*s,length*.38],stone);joint('rope','weapon',[0,-.2*s,-length*.75]);part('sling_rope','rope',[.05*s,1.5*s,.05*s],[0,-.6*s,0],rope,box,1);part('sling_boulder','rope',[.55*s,.55*s,.55*s],[0,-1.35*s,0],world?rune:stone,rock);}
        else{part('rune_boulder','weapon',[.5*s,.5*s,.5*s],[0,.3*s,-length*.85],rune,rock);part('torsion_bundle','body',[.4*s,w,.4*s],[0,pivot*.75,0],rope,round,1,[0,0,Math.PI/2]);}
      }
      part('team_siege_banner','body',[.045,1.15*s,1*s],[w*.62,1.7*s,-length*.25],heraldry);
    }
    const move=(nodeId:string,times:number[],values:Vec3[]):AssetTrack=>({nodeId,property:'position',times,values});
    const rotate=(nodeId:string,times:number[],values:Vec3[]):AssetTrack=>({nodeId,property:'rotation',times,values:values.map(v=>q(...v))});
    const clip=(id:string,durationSeconds:number,tracks:AssetTrack[],loop=false):AssetClip=>({id,durationSeconds,tracks,loop});
    const gait:AssetTrack[]=[move('body',[0,.6,1.2],[[0,0,0],[0,giant?.09:.035,0],[0,0,0]])];
    if(giant)for(const sign of [-1,1])gait.push(rotate(`${sign<0?'left':'right'}_leg`,[0,.6,1.2],[[sign*.25,0,0],[-sign*.25,0,0],[sign*.25,0,0]]));
    else for(const node of nodes.filter(n=>/^wheel_-?1_[0-2]$/.test(n.id)))gait.push(rotate(node.id,[0,.3,.6,.9,1.2],Array.from({length:5},(_,i)=>[0,i*Math.PI/2,Math.PI/2] as Vec3)));
    const attack:AssetTrack[]=giant?[rotate('right_arm',[0,.5,.7,1.2],[[-.2,0,0],[-1.7,0,-.15],[.4,0,.2],[-.2,0,0]])]:ram?[move('weapon',[0,.5,.7,1.2],[[0,1.7*s,0],[0,1.7*s,-.5*s],[0,1.7*s,.5*s],[0,1.7*s,0]])]:ballista?[move('weapon',[0,.15,.7,1.2],[[0,1.95*s,0],[0,1.95*s,-.3*s],[0,1.95*s,-.3*s],[0,1.95*s,0]])]:[rotate('weapon',[0,.15,.7,1.2],[[.65,0,0],[.65,0,0],[-.65,0,0],[-.65,0,0]])];
    if(treb||id==='rune_catapult'){nodes.find(node=>node.id===(treb?'sling_boulder':'rune_boulder'))!.visibility={actions:['idle','move','hit','death','packed','deploy','pack','windup']};if(treb)attack.push(rotate('rope',[0,.2,.7,1.2],[[1.5,0,0],[.8,0,0],[0,0,0],[0,0,0]]));}
    const clips=[clip('idle',3,[move('body',[0,1.5,3],[[0,0,0],[0,.018,0],[0,0,0]])],true),clip('move',1.2,gait,true),clip('attack',1.2,attack),clip('hit',.5,[rotate('rig',[0,.15,.5],[[0,0,0],[-.045,0,.04],[0,0,0]])]),clip('death',2.8,[rotate('rig',[0,1,2.8],[[0,0,0],[.1,0,.2],[0,0,1.55]]),move('rig',[0,2.8],[[0,0,0],[0,.2,0]])])];
    if(def.windupSeconds)clips.push(clip('windup',def.windupSeconds,[rotate('weapon',[0,def.windupSeconds],[[-.65,0,0],[-.9,0,0]])]));
    if(treb)clips.push(clip('packed',1,[rotate('weapon',[0,1],[[0,0,0],[0,0,0]])],true),clip('deploy',def.deploySeconds??6,[rotate('weapon',[0,def.deploySeconds??6],[[0,0,0],[-.65,0,0]])]),clip('pack',def.packSeconds??4,[rotate('weapon',[0,def.packSeconds??4],[[-.65,0,0],[0,0,0]])]));
    if(crown)clips.push(clip('turret',.7,[move('turret',[0,.15,.7],[[0,11.7,.7*s],[0,11.7,.55*s],[0,11.7,.7*s]])]));
    const variants:AssetVariant[]=[];for(let age=def.minAge;age<=8;age++)variants.push({key:`age_${age}_base`,age:age as AssetVariant['age'],tier:'base',nodes:structuredClone(nodes)});
    return {id,kind:'unit',variants,clips,sockets:{root:'rig',weapon:giant?'right_arm':'weapon',...(def.projectileLaunchHeightM?{projectile:treb?'sling_boulder':ballista?'engraved_bolt':'rune_boulder'}:{}),...(crown?{turret:'turret',projectile:'turret_bolt',passengerEntry:'passenger_portal'}:{})},bounds:{min:[-r*2.5,-.5,-r*4],max:[r*2.5,height+5,r*4]},collision:{kind:'circle',radiusM:r}};
  });
}
