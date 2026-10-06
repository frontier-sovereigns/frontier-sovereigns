import { useEffect, useRef, useState } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { AssetAction, AssetBundle, AssetState, FarmAppearance, Lod } from '@frontier/assets';
import { TEAM_IDENTITIES, balance, units, buildings, ages } from '@frontier/shared';
import { AssetRenderer, loadAssetBundle, type AssetInstance } from './AssetRenderer';
import './asset-gallery.css';

const title=(id:string)=>id.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
type Board='individual'|'actions'|'settlement'|'units'|'environment'|'army250'|'army500';
interface PoseLabel {text:string;position:Vector3}
interface GallerySettings {asset:string;age:number;tier:string;action:string;state:AssetState;farm:FarmAppearance;gate:boolean;wallMask:number;progress:number;damage:number;lod:Lod;team:number;playing:boolean;board:Board;quality:'low'|'medium'|'high'}
const initial:GallerySettings={asset:'villager',age:1,tier:'base',action:'idle',state:'complete',farm:'ready',gate:false,wallMask:5,progress:.5,damage:.65,lod:0,team:0,playing:true,board:'individual',quality:'high'};

/** Public asset inspection fixtures. This page has no match, commands, or hidden state. */
export default function AssetGallery({onClose}:{onClose?:()=>void}) {
  const canvas=useRef<HTMLCanvasElement>(null),labelElements=useRef<(HTMLSpanElement|null)[]>([]),runtime=useRef<{engine:Engine;scene:Scene;camera:ArcRotateCamera;renderer:AssetRenderer;instances:AssetInstance[];settings:GallerySettings;time:number;frameTimes:number[];labels:PoseLabel[];orthoHeight:number}|null>(null);
  const [fullCanvas,setFullCanvas]=useState(false),[poseLabels,setPoseLabels]=useState<PoseLabel[]>([]);
  const [bundle,setBundle]=useState<AssetBundle|null>(null),[settings,setSettings]=useState(initial),[error,setError]=useState(''),[metrics,setMetrics]=useState({instances:0,batches:0,visibleParts:0,triangles:0,cpuMs:0,drawnUnits:0,drawnStructures:0,fps:0,medianFps:0,p95FrameMs:0,longFrames:0,frames:0});
  useEffect(()=>{
    const abort=new AbortController();let cleanup=()=>{};
    void loadAssetBundle(abort.signal).then(assets=>{
      if(abort.signal.aborted||!canvas.current)return;
      if(!canvas.current.getContext('webgl2'))throw new Error('Asset inspection requires WebGL2.');
      const engine=new Engine(canvas.current,true,{preserveDrawingBuffer:true}),scene=new Scene(engine);scene.clearColor=new Color4(.075,.12,.12,1);
      const camera=new ArcRotateCamera('asset-inspection',-.75,1.05,6,new Vector3(0,1,0),scene);camera.attachControl(canvas.current,true);camera.minZ=.1;camera.lowerRadiusLimit=2;camera.upperRadiusLimit=180;camera.wheelPrecision=15;
      const sky=new HemisphericLight('inspection-sky',Vector3.Up(),scene);sky.intensity=.8;const sun=new DirectionalLight('inspection-sun',new Vector3(-.7,-1,.5),scene);sun.intensity=.9;
      const ground=CreateGround('inspection-plinth',{width:500,height:500},scene),material=new StandardMaterial('plinth',scene);material.diffuseColor=new Color3(.27,.32,.26);material.specularColor=Color3.Black();ground.material=material;
      const renderer=new AssetRenderer(scene,assets),entry={engine,scene,camera,renderer,instances:[] as AssetInstance[],settings:initial,time:0,frameTimes:[] as number[],labels:[] as PoseLabel[],orthoHeight:20};runtime.current=entry;setBundle(assets);
      const resize=()=>engine.resize(),observer=new ResizeObserver(resize);observer.observe(canvas.current);window.addEventListener('resize',resize);
      const interval=window.setInterval(()=>{const sorted=[...entry.frameTimes].sort((a,b)=>a-b),percentile=(p:number)=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]??0;setMetrics({...renderer.metrics,fps:Math.round(engine.getFps()*10)/10,medianFps:sorted.length?Math.round(10000/Math.max(1,percentile(.5)))/10:0,p95FrameMs:Math.round(percentile(.95)*10)/10,longFrames:entry.frameTimes.filter(frame=>frame>50).length,frames:sorted.length});},1000);
      engine.runRenderLoop(()=>{
        entry.frameTimes.push(engine.getDeltaTime());if(entry.frameTimes.length>600)entry.frameTimes.shift();
        const current=entry.settings;if(current.playing)entry.time+=Math.min(engine.getDeltaTime(),100)/1000;
        ground.setEnabled(current.board!=='actions');
        if(current.board==='actions'){
          const aspect=engine.getRenderWidth()/engine.getRenderHeight();camera.orthoTop=entry.orthoHeight/2;camera.orthoBottom=-entry.orthoHeight/2;camera.orthoLeft=-entry.orthoHeight*aspect/2;camera.orthoRight=entry.orthoHeight*aspect/2;
        }
        for(const instance of current.board==='actions'?[]:entry.instances){const clip=current.action==='none'&&current.board==='individual'?undefined:instance.asset.clips.find(c=>c.id===(current.board==='individual'?current.action:'move'))??instance.asset.clips.find(c=>c.id==='idle');
          instance.clip=instance.asset.id.endsWith('_gate')?'gate_open':clip?.id;instance.seconds=instance.asset.id.endsWith('_gate')?(current.gate?instance.asset.clips.find(c=>c.id==='gate_open')?.durationSeconds??1:0):clip?(clip.loop?entry.time:entry.time%(clip.durationSeconds+1)):0;
        }
        renderer.render(camera.position);scene.render();
        if(current.board==='actions'&&canvas.current){const viewport=camera.viewport.toGlobal(canvas.current.clientWidth,canvas.current.clientHeight);for(let i=0;i<entry.labels.length;i++){const element=labelElements.current[i];if(element){const point=Vector3.Project(entry.labels[i]!.position,Matrix.IdentityReadOnly,scene.getTransformMatrix(),viewport);element.style.left=`${point.x}px`;element.style.top=`${point.y}px`;}}}
      });
      cleanup=()=>{observer.disconnect();window.removeEventListener('resize',resize);window.clearInterval(interval);renderer.dispose();scene.dispose();engine.dispose();runtime.current=null;};
    }).catch(cause=>{if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'The asset library could not be loaded.');});
    return()=>{abort.abort();cleanup();};
  },[]);
  useEffect(()=>{
    const run=runtime.current;if(!run||!bundle)return;run.settings=settings;run.time=0;run.frameTimes=[];
    for(const instance of run.instances)instance.root.dispose();run.instances=[];run.labels=[];setPoseLabels([]);
    run.camera.mode=Camera.PERSPECTIVE_CAMERA;run.camera.beta=1.05;
    if(settings.board==='actions'){
      const selected=bundle.assets[settings.asset]!,team=TEAM_IDENTITIES[settings.team]!,clips=selected.clips,rows=Math.ceil(clips.length/2),height=Math.max(3.8,selected.bounds.max[1]+1.6),width=Math.max(3.2,selected.bounds.max[1]+.4),horizontal=new Vector3(-Math.sin(.85),0,Math.cos(.85));
      for(let action=0;action<clips.length;action++)for(let phase=0;phase<4;phase++){
        const clip=clips[action]!,fraction=phase===3?(clip.loop?.75:1):phase*.25,instance=run.renderer.create(selected.id,{age:settings.age,tier:settings.tier,color:team.color,pattern:settings.team});
        instance.forcedLod=settings.lod;instance.context={lod:settings.lod,state:'complete',progress:1,action:clip.id as AssetAction};instance.clip=clip.id;instance.seconds=clip.durationSeconds*fraction;
        const column=action%2*4+phase,x=(column-3.5)*width+(action%2?width*.3:-width*.3),y=((rows-1)/2-Math.floor(action/2))*height-selected.bounds.max[1]*.4;
        instance.root.position.copyFrom(horizontal.scale(x));instance.root.position.y=y;run.instances.push(instance);
        const position=instance.root.position.add(new Vector3(0,-.55,0));run.labels.push({text:`${title(clip.id)} · ${Math.round(fraction*100)}%`,position});
      }
      run.camera.alpha=.85;run.camera.beta=Math.PI/2;run.camera.target.setAll(0);run.camera.radius=80;run.camera.mode=Camera.ORTHOGRAPHIC_CAMERA;
      run.orthoHeight=Math.max(rows*height+1,9*width/(run.engine.getRenderWidth()/run.engine.getRenderHeight()));setPoseLabels([...run.labels]);return;
    }
    const board=settings.board,all=Object.values(bundle.assets),choices=board==='individual'?[bundle.assets[settings.asset]!]:board==='settlement'?all.filter(a=>a.kind==='building'&&(buildings[a.id]?.minAge??1)<=settings.age):board==='environment'?all.filter(a=>a.kind==='environment'):all.filter(a=>a.kind==='unit'&&(units[a.id]?.minAge??1)<=settings.age);
    const army=board==='army250'||board==='army500',count=board==='army500'?500:board==='army250'?300:choices.length,columns=board==='individual'?1:army?Math.ceil(Math.sqrt(count)):Math.ceil(Math.sqrt(choices.length)),spacing=army?2.2:board==='settlement'?(settings.age>=5?30:18):settings.age>=5?19:7;
    for(let i=0;i<count;i++){
      const asset=board==='army250'&&i>=250?bundle.assets[['house','house','house','farm','barracks','archery_range','stable','watchtower','town_center','blacksmith'][(i-250)%10]!]!:choices[i%choices.length]!,team=TEAM_IDENTITIES[army?i%11:settings.team]!,instance=run.renderer.create(asset.id,{age:settings.age,tier:settings.tier,color:team.color,pattern:army?i%11:settings.team});
      instance.forcedLod=settings.lod;instance.context={lod:settings.lod,state:settings.state,progress:settings.state==='foundation'?0:settings.state==='construction'?settings.progress:1,damage:settings.state==='damaged'?settings.damage:0,farm:settings.farm,gate:settings.gate?'open':'closed',wallMask:settings.wallMask,action:(board==='individual'?settings.action:'move') as AssetAction};
      instance.root.position.set((i%columns-(columns-1)/2)*spacing,0,(Math.floor(i/columns)-(Math.ceil(count/columns)-1)/2)*spacing);instance.root.rotation.y=board==='individual'?0:.3;
      if(board==='army250'){const cell=i<250?Math.floor(i/5):i-250;instance.root.position.set((cell%10-4.5)*12+(i<250?(i%5-2)*1.05:0),0,(Math.floor(cell/10)-2)*12+(i<250?-4.8:1));}
      run.instances.push(instance);
    }
    const selected=bundle.assets[settings.asset]!,size=Math.max(...selected.bounds.max.map((v,i)=>v-selected.bounds.min[i]!));
    run.camera.alpha=(board==='individual'?selected.kind==='unit':board==='units'||army)?.85:-.85;
    run.camera.target.set(0,board==='individual'?size*.35:0,0);run.camera.radius=board==='individual'?Math.max(5,size*2):board==='army250'?190:columns*spacing*1.75;run.camera.upperRadiusLimit=Math.max(180,run.camera.radius*1.5);
  },[bundle,settings.asset,settings.age,settings.tier,settings.action,settings.state,settings.farm,settings.gate,settings.wallMask,settings.progress,settings.damage,settings.lod,settings.team,settings.board]);
  useEffect(()=>{const run=runtime.current;if(run){run.settings=settings;run.renderer.quality=settings.quality;run.engine.setHardwareScalingLevel(1/({low:.65,medium:.85,high:1}[settings.quality]));}},[bundle,settings]);
  const patch=(value:Partial<GallerySettings>)=>setSettings(current=>({...current,...value})),asset=bundle?.assets[settings.asset];
  return <main className={`asset-gallery${fullCanvas?' asset-gallery-full':''}`}><aside className="asset-gallery-controls" data-gameplay-hotkeys="suspend"><div className="eyebrow">Original 3D library</div><h1>The frontier atelier</h1><p>Host-loaded geometry, joint animation and three detail levels. These are isolated visual fixtures, outside a match.</p><button onClick={()=>onClose?onClose():location.assign('/')}>Return to frontier</button>
    {error?<p role="alert">{error}</p>:!bundle?<p role="status">Verifying the host asset library…</p>:<>
      <label>Inspection scene<select aria-label="Inspection scene" value={settings.board} onChange={e=>patch({board:e.target.value as Board,asset:e.target.value==='actions'&&asset?.kind!=='unit'?'villager':settings.asset})}><option value="individual">Individual asset</option><option value="actions">Unit action pose board</option><option value="units">All military families</option><option value="settlement">All building families</option><option value="environment">All environment assets</option><option value="army250">250 units + 50 structures</option><option value="army500">500-unit render fixture</option></select></label>
      <label>Asset<select aria-label="Asset" value={settings.asset} onChange={e=>patch({asset:e.target.value,age:Math.max(settings.age,[...Object.values(units),...Object.values(buildings)].find(def=>def.id===e.target.value)?.minAge??1),action:'idle',board:settings.board==='actions'&&bundle.assets[e.target.value]?.kind==='unit'?'actions':'individual'})}>{(['unit','building','environment'] as const).map(kind=><optgroup key={kind} label={title(kind)}>{Object.values(bundle.assets).filter(a=>a.kind===kind).map(a=><option key={a.id} value={a.id}>{title(a.id)}</option>)}</optgroup>)}</select></label>
      <div className="asset-gallery-pair"><label>Observed age<select aria-label="Observed age" value={settings.age} onChange={e=>patch({age:Number(e.target.value)})}>{Object.values(ages).map(a=><option value={a.id} key={a.id} disabled={settings.board==='individual'&&a.id<([...Object.values(units),...Object.values(buildings)].find(def=>def.id===settings.asset)?.minAge??1)}>{a.name}</option>)}</select></label><label>Upgrade tier<select aria-label="Upgrade tier" value={settings.tier} onChange={e=>patch({tier:e.target.value})}><option value="base">Base</option><option value="veteran">Veteran</option><option value="elite">Elite</option></select></label></div>
      <label>Animation<select aria-label="Animation" disabled={settings.board==='actions'} value={settings.action} onChange={e=>patch({action:e.target.value})}><option value="none">Rest pose</option>{asset?.clips.map(clip=><option key={clip.id} value={clip.id}>{title(clip.id)} · {clip.durationSeconds}s</option>)}</select></label>
      <div className="asset-gallery-pair"><label>Detail level<select aria-label="Detail level" value={settings.lod} onChange={e=>patch({lod:Number(e.target.value) as Lod})}><option value="0">LOD 0 · near</option><option value="1">LOD 1 · middle</option><option value="2">LOD 2 · far</option></select></label><label>Graphics quality<select aria-label="Graphics quality" value={settings.quality} onChange={e=>patch({quality:e.target.value as GallerySettings['quality']})}><option>high</option><option>medium</option><option>low</option></select></label></div>
      <label>Faction heraldry<select aria-label="Faction heraldry" value={settings.team} onChange={e=>patch({team:Number(e.target.value)})}>{TEAM_IDENTITIES.map((team,i)=><option value={i} key={team.name}>{i+1} · {team.name}</option>)}</select></label>
      <label>Structure state<select aria-label="Structure state" value={settings.state} onChange={e=>patch({state:e.target.value as AssetState})}>{['foundation','construction','complete','damaged','destroyed'].map(s=><option key={s}>{s}</option>)}</select></label>
      {settings.state==='construction'&&<label>Construction progress<input aria-label="Construction progress" type="range" min="0" max="1" step=".05" value={settings.progress} onChange={e=>patch({progress:Number(e.target.value)})}/></label>}
      <div className="asset-gallery-pair"><label>Farm state<select aria-label="Farm state" value={settings.farm} onChange={e=>patch({farm:e.target.value as FarmAppearance})}><option>ready</option><option>exhausted</option><option>reseeding</option></select></label><label>Wall joins<select aria-label="Wall joins" value={settings.wallMask} onChange={e=>patch({wallMask:Number(e.target.value)})}><option value="5">Straight</option><option value="3">Corner</option><option value="7">T junction</option><option value="15">Cross</option><option value="1">End cap</option></select></label></div>
      <label className="asset-gallery-check"><input type="checkbox" checked={settings.gate} onChange={e=>patch({gate:e.target.checked})}/>Open gate</label><label className="asset-gallery-check"><input type="checkbox" checked={settings.playing} onChange={e=>patch({playing:e.target.checked})}/>Play animation</label>
      <button onClick={()=>{if(runtime.current)runtime.current.frameTimes=[];}}>Reset frame sample</button>
      <output data-testid="asset-metrics" data-profile={JSON.stringify({...metrics,settings,canvas:canvas.current?{css:{width:canvas.current.clientWidth,height:canvas.current.clientHeight},drawingBuffer:{width:canvas.current.width,height:canvas.current.height}}:null,camera:runtime.current?{alpha:runtime.current.camera.alpha,beta:runtime.current.camera.beta,radius:runtime.current.camera.radius,target:runtime.current.camera.target.asArray()}:null})}>{metrics.instances} assets · {metrics.batches} batches · {metrics.visibleParts} posed parts · {metrics.triangles.toLocaleString()} triangles · {metrics.fps} FPS · {metrics.cpuMs} ms pose/upload<br/>{metrics.drawnUnits} units + {metrics.drawnStructures} structures in view<br/>{metrics.medianFps} median FPS · {metrics.p95FrameMs} ms p95 · {metrics.longFrames}/{metrics.frames} frames over 50ms</output>
      <p className="asset-gallery-note">Render measurements describe this browser and inspection scene. They do not qualify full multiplayer capacity or model performance.</p>
    </>}
  </aside><section className="asset-gallery-stage"><canvas ref={canvas} aria-label="Interactive generated 3D asset inspection"/><div className="asset-gallery-toolbar"><button onClick={()=>setFullCanvas(current=>!current)}>{fullCanvas?'Show inspection controls':'Use full canvas'}</button>{fullCanvas&&<button onClick={()=>{if(runtime.current)runtime.current.frameTimes=[];}}>Reset frame sample</button>}</div>{settings.board==='actions'&&<div className="asset-gallery-pose-labels">{poseLabels.map((label,index)=><span key={index} ref={element=>{labelElements.current[index]=element;}}>{label.text}</span>)}</div>}<div className="asset-gallery-caption"><span>{settings.board==='individual'?title(settings.asset):settings.board==='actions'?`${title(settings.asset)} · ${asset?.clips.length??0} actions, four sampled poses`:settings.board==='settlement'?`${ages[settings.age]?.name} settlement · ${Object.values(bundle?.assets??{}).filter(asset=>asset.kind==='building'&&(buildings[asset.id]?.minAge??1)<=settings.age).length} available types`:settings.board==='army250'?'250 units + 50 structures':title(settings.board)}</span><small>{settings.board==='actions'?'Fixed joint poses at 0%, 25%, 50% and 75% (loops) or 100% (one-shot clips).':'Drag to orbit · Wheel to zoom · Actual WebGL2 geometry'}</small></div></section></main>;
}
