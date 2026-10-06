import { generateLegendaryUnits } from './legendary-units.js';
import { units } from '../../shared/src/content.js';
import { assetNode, quaternionFromEuler as q, type AssetLibraryBuilder } from './geometry.js';
import type { AssetAction, AssetBlueprint, AssetClip, AssetNode, AssetTrack, AssetVariant, Quat, Vec3 } from './types.js';

/** Original articulated models: a cedar-and-bronze frontier culture, authored in metres.
 * Geometry is shared across all rigs, ages and team colours. No external art is used. */
export function generateUnitAssets(lib: AssetLibraryBuilder): AssetBlueprint[] {
  const mat = (id: string, color: [number, number, number, number], flags = {}) => lib.material({ id: `unit_${id}`, baseColor: color, roughness: .8, ...flags });
  const cloth = mat('cloth', [.72,.77,.67,1], {teamTint:true}), banner = mat('heraldry',[1,1,1,1],{teamTint:true,heraldry:true});
  const skin = mat('skin',[.73,.49,.32,1]), leather = mat('leather',[.24,.19,.13,1]), wood = mat('cedar',[.39,.27,.15,1]);
  const iron = mat('iron',[.47,.53,.53,1]), bronze = mat('bronze',[.7,.52,.24,1]), ivory = mat('linen',[.81,.79,.64,1]);
  const mane = mat('mane',[.15,.16,.15,1]), horse = mat('horse',[.41,.31,.23,1]), stone = mat('stone',[.45,.48,.43,1]);
  const sphere = [lib.ellipsoid([1,1,1],6,10),lib.ellipsoid([1,1,1],4,7),lib.ellipsoid([1,1,1],2,4)] as [string,string,string];
  const box = lib.box([1,1,1]), cylinder = [12,6,4].map(n=>lib.revolve([[0,-.5],[.5,-.5],[.5,.5],[0,.5]],n)) as [string,string,string];
  const tunic = [10,7,4].map(n=>lib.revolve([[0,-.45],[.32,-.45],[.23,.05],[.29,.4],[.19,.46],[0,.46]],n)) as [string,string,string];
  const blade = lib.extrudeConvex([[-.09,-.5],[.09,-.5],[.07,.38],[0,.62],[-.07,.38]],.045);
  const shield = [12,8,5].map(n=>lib.revolve([[0,-.05],[.36,-.05],[.4,0],[.29,.12],[0,.15]],n)) as [string,string,string];
  const ids = ['villager','scout','militia','spearman','archer','skirmisher','light_cavalry','knight','battering_ram','catapult','trebuchet'];
  const make = (id:string):AssetBlueprint => {
    const siege = ['battering_ram','catapult','trebuchet'].includes(id), mounted = ['scout','light_cavalry','knight'].includes(id);
    const variants:AssetVariant[]=[];
    for (const age of [1,2,3,4,5,6,7,8] as const) for (const tier of (['militia','spearman','archer'].includes(id) ? ['base','veteran','elite'] : id==='knight' ? ['base','elite'] : ['base']) as ('base'|'veteran'|'elite')[]) {
      const nodes:AssetNode[]=[assetNode('rig')];
      const joint=(name:string,parent:string,position:Vec3,rotation:Quat=q(0,0,0))=>nodes.push(assetNode(name,{parentId:parent,position,rotation}));
      const part=(name:string,parent:string,geometry:string|[string,string,string],materialId:string,position:Vec3,scale:Vec3,rotation:Quat=q(0,0,0),detail=false,visibility?:AssetNode['visibility'])=>nodes.push(assetNode(name,{parentId:parent,position,scale,rotation,mesh:{geometry: typeof geometry==='string'?[geometry,geometry,detail?null:geometry]:[geometry[0],geometry[1],detail?null:geometry[2]],materialId},...(visibility?{visibility}:{})}));
      if (!siege) {
        joint('body','rig',[0,mounted?.87:0,0]);
        part('tunic','body',tunic,cloth,[0,1.05,0],[1,.88,.78]);
        part('belt','body',cylinder,leather,[0,.91,0],[.51,.085,.4]);
        part('buckle','body',box,bronze,[0,.91,.218],[.11,.09,.04],q(0,0,0),true);
        joint('head','body',[0,1.61,0]);
        part('face','head',sphere,skin,[0,0,0],[.185,.225,.17]);
        part('nose','head',sphere,skin,[0,-.01,.175],[.05,.06,.05],q(0,0,0),true);
        part('hair','head',sphere,mane,[0,.115,-.035],[.19,.13,.17]);
        for (const sign of [-1,1]) {
          const side=sign<0?'left':'right'; joint(`${side}_arm`,'body',[sign*.32,1.38,0]);
          part(`${side}_sleeve`,`${side}_arm`,sphere,cloth,[0,-.16,0],[.13,.2,.13]);
          joint(`${side}_forearm`,`${side}_arm`,[0,-.31,0]);
          part(`${side}_wrist`,`${side}_forearm`,sphere,skin,[0,-.16,0],[.083,.18,.085]);
          part(`${side}_hand`,`${side}_forearm`,sphere,skin,[0,-.32,.01],[.09,.095,.09]);
          joint(`${side}_leg`,'body',[sign*.145,.66,0],mounted?q(-.4,0,sign*.2):q(0,0,0));
          part(`${side}_trouser`,`${side}_leg`,sphere,leather,[0,-.17,0],[.13,.22,.14]);
          joint(`${side}_knee`,`${side}_leg`,[0,-.32,0]);
          part(`${side}_boot`,`${side}_knee`,sphere,leather,[0,-.14,.045],[.105,.2,.18]);
        }
        part('chest_mark','body',box,banner,[0,1.22,.238],[.3,.29,.025],q(0,0,0),true);
        if (id==='villager') {
          part('apron','body',box,ivory,[0,.86,.225],[.34,.48,.045]);
          part('sun_hat','head',cylinder,wood,[0,.19,0],[.62,.065,.57]);
          part('hat_crown','head',tunic,wood,[0,.27,0],[.55,.21,.48]);
          const work:AssetAction[]=['attack','gather_wood','mine','build','repair'];
          part('tool_handle','right_forearm',cylinder,wood,[0,-.34,.25],[.05,.8,.05],q(Math.PI/2,0,0),false,{actions:work});
          part('axe_head','right_forearm',blade,iron,[0,-.31,.63],[2,.33,2],q(0,0,Math.PI/2),false,{actions:['attack','gather_wood']});
          part('pick_head','right_forearm',box,iron,[0,-.33,.64],[.56,.075,.075],q(0,0,.12),false,{actions:['mine']});
          part('mallet_head','right_forearm',cylinder,wood,[0,-.34,.6],[.24,.35,.24],q(0,0,Math.PI/2),false,{actions:['build','repair']});
          part('food_basket','body',tunic,wood,[0,.87,.45],[.76,.43,.58],q(0,0,0),false,{actions:['gather_food']});
          part('cargo_bundle','body',sphere,ivory,[0,1.05,.53],[.34,.27,.28],q(0,0,0),false,{actions:['carry']});
          part('cargo_binding','body',box,leather,[0,1.05,.8],[.055,.42,.018],q(0,0,0),true,{actions:['carry']});
        } else {
          const sword=['militia','light_cavalry','knight'].includes(id), spear=['spearman','skirmisher','scout'].includes(id);
          if(sword){ part('sword','right_forearm',blade,iron,[0,-.32,.5],[1,1,1],q(Math.PI/2,0,0));part('sword_guard','right_forearm',box,bronze,[0,-.32,.07],[.29,.045,.05]); }
          if(spear){part('spear_shaft','right_forearm',cylinder,wood,[0,-.25,.48],[.055,id==='spearman'?2.6:1.9,.055],q(Math.PI/2,0,0));part('spear_tip','right_forearm',blade,iron,[0,-.25,id==='spearman'?1.92:1.54],[1,.45,1],q(Math.PI/2,0,0));}
          if(id==='archer'){
            joint('bow','left_forearm',[0,-.3,.2]);
            for(const sign of [-1,1])part(`bow_limb_${sign}`,'bow',cylinder,wood,[0,sign*.25,.06],[.055,.58,.055],q(sign*.4,0,0));
            part('bow_string','bow',cylinder,ivory,[0,0,-.07],[.012,1.05,.012],q(0,0,0),true);
            part('quiver','body',cylinder,leather,[.18,1.05,-.27],[.21,.65,.19],q(0,0,-.3));
            for(const offset of [-.06,0,.06])part(`arrow_${offset}`,'body',cylinder,ivory,[.18+offset,1.4,-.27],[.025,.52,.025],q(0,0,-.3),true);
          }else if(id!=='scout') {
            part('shield','left_forearm',shield,cloth,[-.09,-.22,.09],[1,1,1],q(0,0,Math.PI/2));
            part('shield_boss','left_forearm',sphere,bronze,[-.24,-.22,.09],[.1,.12,.12],q(0,0,0),true);
          }
          if(id==='knight'||tier!=='base'||age>=3){part('helmet','head',sphere,iron,[0,.1,0],[.207,.19,.19]);part('helmet_rim','head',cylinder,bronze,[0,.09,0],[.43,.055,.39]);}
          if(tier!=='base'||id==='knight')part('breastplate','body',sphere,iron,[0,1.19,.07],[.275,.3,.21]);
          if(tier==='elite'){part('crest','head',blade,bronze,[0,.35,0],[.8,.47,2],q(0,Math.PI/2,0));for(const sign of [-1,1])part(`elite_shoulder_${sign}`,'body',sphere,bronze,[sign*.33,1.43,0],[.19,.11,.2]);}
          if(age>=2)part('collar','body',cylinder,ivory,[0,1.42,0],[.39,.11,.3],q(0,0,0),true);
          if(age>=4)part('ceremonial_cloak','body',tunic,cloth,[0,1.15,-.15],[1,.75,.35]);
        }
        if(mounted){
          part('horse_torso','rig',sphere,horse,[0,1.03,0],[.39,.4,.88]);
          part('saddle','rig',sphere,leather,[0,1.37,-.1],[.43,.13,.45]);
          part('saddle_cloth','rig',tunic,banner,[0,1.17,-.08],[1.5,.45,1.15]);
          joint('horse_neck','rig',[0,1.24,.66],q(.34,0,0));
          part('horse_neck_shape','horse_neck',sphere,horse,[0,.3,.05],[.23,.48,.3]);
          part('horse_head','horse_neck',sphere,horse,[0,.56,.24],[.2,.2,.38]);
          part('horse_mane','horse_neck',box,mane,[0,.25,-.23],[.13,.7,.12],q(0,0,0),true);
          for(const sign of [-1,1]){part(`horse_ear_${sign}`,'horse_neck',sphere,horse,[sign*.11,.83,.16],[.055,.15,.055]);for(const end of [-1,1]){
            const name=`horse_leg_${sign}_${end}`;joint(name,'rig',[sign*.27,1,end*.58]);part(`${name}_upper`,name,sphere,horse,[0,-.27,0],[.105,.31,.12]);part(`${name}_hoof`,name,box,mane,[0,-.79,.015],[.16,.2,.22]);part(`${name}_lower`,name,cylinder,horse,[0,-.59,0],[.105,.36,.12]);
          }}
          joint('tail','rig',[0,1.2,-.83],q(.3,0,0));part('tail_hair','tail',sphere,mane,[0,-.37,-.12],[.12,.48,.14]);
          if(id==='knight')part('horse_barding','rig',tunic,iron,[0,1,.35],[1.5,.6,1.2]);
        }
      } else {
        // The catapult cup is the rear of the machine. Keep the root's shared
        // +Z travel/aim convention while turning the entire articulated chassis,
        // so the throwing stroke (and rolling wheels) also faces forward.
        joint('chassis','rig',[0,0,0],q(0,id==='catapult'?Math.PI:0,0));
        for(const sign of [-1,1])part(`runner_${sign}`,'chassis',box,wood,[sign*.59,.63,0],[.22,.23,2.65]);
        for(const z of [-.9,0,.9])part(`crossbeam_${z}`,'chassis',box,wood,[0,.63,z],[1.4,.19,.18]);
        for(const sign of [-1,1])for(const end of [-1,1]){
          const name=`wheel_${sign}_${end}`;joint(name,'chassis',[sign*.81,.48,end*.94],q(0,0,Math.PI/2));part(`${name}_rim`,name,cylinder,leather,[0,0,0],[.88,.18,.88]);part(`${name}_hub`,name,cylinder,bronze,[0,sign*.12,0],[.2,.25,.2]);for(const spoke of [0,1])part(`${name}_spoke_${spoke}`,name,box,wood,[0,sign*.105,0],[.74,.045,.085],q(0,spoke*Math.PI/2,0),true);
        }
        if(id==='battering_ram'){
          for(const sign of [-1,1])for(const z of [-.85,.85])part(`support_${sign}_${z}`,'chassis',box,wood,[sign*.58,1.2,z],[.17,1.1,.16],q(0,0,sign*.15));
          const roof=lib.extrudeConvex([[-.95,0],[0,.6],[.95,0]],2.85);part('armored_roof','chassis',roof,cloth,[0,1.61,0],[1,1,1]);
          joint('ram','chassis',[0,1.08,0]);part('ram_log','ram',cylinder,wood,[0,0,.25],[.43,3.6,.43],q(Math.PI/2,0,0));part('ram_head','ram',sphere,iron,[0,0,2.06],[.32,.31,.3]);
          for(const z of [-.8,.8])part(`suspension_${z}`,'chassis',cylinder,leather,[0,1.49,z],[.035,.65,.035]);
        }else{
          const high=id==='trebuchet',height=high?2.72:1.5;
          for(const sign of [-1,1]){part(`frame_${sign}`,'chassis',box,wood,[sign*.53,height/2+.55,0],[.22,height,.27],q(0,0,sign*.13));part(`brace_${sign}`,'chassis',box,wood,[sign*.48,1,.38],[.16,1.4,.16],q(-.5,0,sign*.2));}
          part('axle','chassis',cylinder,iron,[0,height,0],[.15,1.45,.15],q(0,0,Math.PI/2));
          joint('arm','chassis',[0,height,0],q(high?-.92:-.4,0,0));part('throwing_beam','arm',box,wood,[0,0,high?.3:.45],[.19,.21,high?3.9:2.15]);
          if(high){part('counterweight','arm',box,stone,[0,-.36,-1.35],[.74,.84,.58]);part('sling','arm',cylinder,leather,[0,-.22,2.17],[.04,.68,.04],q(.8,0,0));part('sling_pouch','arm',sphere,leather,[0,-.49,2.38],[.25,.08,.25]);}
          else {part('spoon','arm',sphere,wood,[0,.07,1.43],[.34,.14,.35]);part('ammunition','arm',sphere,stone,[0,.25,1.43],[.25,.24,.25]);part('torsion_bundle','chassis',cylinder,ivory,[0,1.1,-.45],[.4,1.1,.4],q(0,0,Math.PI/2));}
        }
        part('siege_banner','chassis',box,banner,[.71,1.17,-.39],[.025,.55,.75]);
        if(age>=4)for(const sign of [-1,1])part(`imperial_fitting_${sign}`,'chassis',box,bronze,[sign*.6,.72,0],[.25,.055,1.3],q(0,0,0),true);
      }
      if(age>=5)part('legendary_heraldic_band',siege?'chassis':'body',box,age>=6?bronze:ivory,[0,siege?.9:1.3,siege?-.4:.25],[.3+(age-5)*.04,.11,.04],q(0,0,0),true);
      variants.push({key:`age_${age}_${tier}`,age,tier,nodes});
    }
    return {id,kind:'unit',variants,clips:unitClips(id,mounted,siege),sockets:{root:'rig',...(siege?{weapon:id==='battering_ram'?'ram':'arm'}:{weapon:'right_forearm',head:'head'})},bounds:{min:[siege?-1.2:-.85,0,siege?-2.7:mounted?-1.5:-1.1],max:[siege?1.2:.85,siege?5.5:mounted?3.5:2.4,siege?3.2:2.5]},collision:{kind:'circle',radiusM:units[id]!.collisionRadiusM}};
  };
  return [...ids.map(make), ...generateLegendaryUnits(lib)];
}

function unitClips(id:string,mounted:boolean,siege:boolean):AssetClip[]{
  const rotate=(nodeId:string,times:number[],angles:Vec3[]):AssetTrack=>({nodeId,property:'rotation',times,values:angles.map(v=>q(...v))});
  const move=(nodeId:string,times:number[],values:Vec3[]):AssetTrack=>({nodeId,property:'position',times,values});
  const clip=(name:string,duration:number,tracks:AssetTrack[],loop=true):AssetClip=>({id:name,durationSeconds:duration,loop,tracks});
  const root=siege?'chassis':'body',height=mounted?.87:0;
  const idle=clip('idle',2.8,[move(root,[0,1.4,2.8],[[0,height,0],[0,height+.018,0],[0,height,0]])]);
  const walking:AssetTrack[]=[move(root,[0,.25,.5,.75,1],[[0,height,0],[0,height+.055,0],[0,height,0],[0,height+.055,0],[0,height,0]])];
  if(siege){for(const sign of [-1,1])for(const end of [-1,1])walking.push(rotate(`wheel_${sign}_${end}`,[0,.25,.5,.75,1],[[0,0,Math.PI/2],[0,Math.PI/2,Math.PI/2],[0,Math.PI,Math.PI/2],[0,Math.PI*1.5,Math.PI/2],[0,Math.PI*2,Math.PI/2]]));}
  else if(mounted){for(const sign of [-1,1])for(const end of [-1,1])walking.push(rotate(`horse_leg_${sign}_${end}`,[0,.25,.5,.75,1],[[sign*end*.5,0,0],[0,0,0],[-sign*end*.5,0,0],[0,0,0],[sign*end*.5,0,0]]));walking.push(rotate('tail',[0,.5,1],[[.3,0,-.13],[.3,0,.13],[.3,0,-.13]]));}
  else for(const sign of [-1,1]){const side=sign<0?'left':'right';walking.push(rotate(`${side}_leg`,[0,.5,1],[[sign*.55,0,0],[-sign*.55,0,0],[sign*.55,0,0]]),rotate(`${side}_arm`,[0,.5,1],[[-sign*.3,0,0],[sign*.3,0,0],[-sign*.3,0,0]]));}
  let attack:AssetTrack[];
  if(id==='battering_ram')attack=[move('ram',[0,.28,.45,1],[[0,1.08,0],[0,1.08,-.35],[0,1.08,.5],[0,1.08,0]])];
  else if(siege)attack=[rotate('arm',[0,.35,.45,.7,1],[[id==='trebuchet'?-.92:-.4,0,0],[.35,0,0],[-1.3,0,0],[-1.3,0,0],[id==='trebuchet'?-.92:-.4,0,0]])];
  else if(id==='archer')attack=[rotate('left_arm',[0,.2,.7,1],[[-.8,0,0],[-1.55,0,0],[-1.55,0,0],[-.8,0,0]]),rotate('right_arm',[0,.45,.7,1],[[-.7,0,0],[-1,.8,-.7],[-1.2,-.1,-.2],[-.7,0,0]])];
  else attack=[rotate('right_arm',[0,.3,.45,.75,1],[[-.25,0,0],[-2.3,0,-.3],[-.75,0,.2],[-.5,0,0],[-.25,0,0]]),rotate('body',[0,.3,.5,1],[[0,0,0],[0,-.2,0],[.12,.25,0],[0,0,0]])];
  const result=[idle,clip('move',1,walking),clip('attack',1,attack,false),clip('hit',.36,[rotate('rig',[0,.12,.36],[[0,0,0],[-.12,0,.14],[0,0,0]])],false),clip('death',1.4,[rotate('rig',[0,.45,1.1,1.4],[[0,0,0],[0,0,.35],[0,0,1.5],[0,0,1.57]]),move('rig',[0,1.4],[[0,0,0],[0,.12,0]])],false)];
  if(id==='villager'){
    for(const action of ['gather_wood','mine','build','repair']){const duration=action==='mine'?1.3:action==='repair'?.8:1;const work=attack.map(track=>({...structuredClone(track),times:track.times.map(time=>time*duration)}));result.push(clip(action,duration,work));}
    result.push(clip('gather_food',1.5,[rotate('body',[0,.5,1,1.5],[[.2,0,0],[.65,0,0],[.65,0,0],[.2,0,0]]),rotate('right_arm',[0,.5,1,1.5],[[-.7,0,0],[-1.1,0,0],[-1.1,0,0],[-.7,0,0]])]));
    result.push(clip('carry',1,[...walking.filter(track=>!track.nodeId.endsWith('_arm')),rotate('left_arm',[0,1],[[-1,0,-.2],[-1,0,-.2]]),rotate('right_arm',[0,1],[[-1,0,.2],[-1,0,.2]])]));
  }
  if(id==='trebuchet')result.push(clip('packed',1,[rotate('arm',[0,1],[[0,0,0],[0,0,0]])]),clip('deploy',4,[rotate('arm',[0,4],[[0,0,0],[-.92,0,0]])],false),clip('pack',3,[rotate('arm',[0,3],[[-.92,0,0],[0,0,0]])],false));
  return result;
}
