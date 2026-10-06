import { describe,expect,it,vi } from 'vitest';
import { terrainLineOfSight,terrainVisionBlockers } from '@frontier/shared';
import { changedVisionMaskWords,immutableVisionGroup,immutableVisionSource,VisionMaskKernel,type VisionMaskFrame,type VisionMaskResult,type VisionMaskSource } from './vision-mask-kernel.js';

/** Independent scalar oracle: no stamps, bit words or cached group buffers. */
function scalar(frame:VisionMaskFrame):VisionMaskResult[]{
  return frame.groups.map(group=>{
    const mask=new Uint8Array(frame.width*frame.height),visible:number[]=[];
    for(const source of group.sources)for(let z=0;z<frame.height;z++)for(let x=0;x<frame.width;x++){
      const point={xMm:(x+.5)*frame.gridMm,zMm:(z+.5)*frame.gridMm},dx=point.xMm-source.xMm,dz=point.zMm-source.zMm;
      if(dx*dx+dz*dz<=source.radius*source.radius&&terrainLineOfSight(frame.blockers,source,point))mask[z*frame.width+x]=1;
    }
    for(let cell=0;cell<mask.length;cell++)if(mask[cell])visible.push(cell);
    return {key:group.key,mask,visible};
  });
}
function fixture():VisionMaskFrame {
  return {width:53,height:37,gridMm:1000,cacheKey:'vision-fixture',blockerRevision:0,blockers:terrainVisionBlockers([
    {id:'cliff',kind:'cliff',xMm:17000,zMm:0,widthMm:2000,depthMm:37000,elevationMm:2000},
    {id:'ramp',kind:'ramp',axis:'x',xMm:17000,zMm:13000,widthMm:2000,depthMm:4000,startElevationMm:0,endElevationMm:2000},
  ]),groups:Array.from({length:11},(_,group)=>({key:`player:${group}`,sources:Array.from({length:8},(_,index)=>({id:`source-${group}-${index}`,xMm:(group*3721+index*9949)%55000-1000,zMm:(group*8871+index*3749)%39000-1000,radius:4000+index*500}))}))};
}

describe('native static-building visibility witnesses',()=>{
  const building=(id='town',x=12000,z=12000,r=9000)=>immutableVisionSource(id,x,z,r,'building');
  const unit=(x=12000,z=12000,r=2500,id='unit')=>immutableVisionSource(id,x,z,r,'unit');
  const frame=(sources:readonly VisionMaskSource[],key='allies'):VisionMaskFrame=>({width:32,height:24,gridMm:1000,cacheKey:'building-witness',blockerRevision:0,blockers:[],groups:[immutableVisionGroup(key,sources)]});
  it('avoids moving-unit rasterization under a current building while retaining exact scalar visibility',()=>{
    const kernel=new VisionMaskKernel(),town=building(),initial=frame([unit(),town]),first=kernel.computeRetained(initial)[0]!,old=structuredClone(first);
    expect(first).toEqual(scalar(initial)[0]);expect(kernel.workSnapshot()).toEqual({rasterizedSources:1,coveredSources:1,witnessChecks:1});
    for(let step=1;step<=12;step++){
      const input=frame([unit(12000+step*137,12000-step*97),town]);
      expect(kernel.computeRetained(input)).toEqual(scalar(input));expect(kernel.computeRetained(input)[0]).toBe(first);
      // The second call above reused the entire group; the next changed contact
      // must still suppress current unit geometry, with no radius-cell walk.
      const next=frame([unit(12000+step*139,12000-step*101),town]);kernel.computeRetained(next);
      expect(kernel.workSnapshot()).toEqual({rasterizedSources:0,coveredSources:1,witnessChecks:1});
    }
    expect(first).toEqual(old);
  });
  it('restores the exact stamp on same-contact departure, tangent, building removal and reentry',()=>{
    const kernel=new VisionMaskKernel(),town=building();
    const check=(input:VisionMaskFrame,covered:number)=>{expect(kernel.computeRetained(input)).toEqual(scalar(input));expect(kernel.workSnapshot().coveredSources).toBe(covered);};
    check(frame([unit(),town]),1);check(frame([unit(19000),town]),0);check(frame([unit(),town]),1);
    check(frame([unit(18500),town]),0);check(frame([unit(),town]),1);
    check(frame([unit()]),0);expect(kernel.workSnapshot().rasterizedSources).toBe(1);check(frame([unit(),town]),1);
    check(frame([unit(),building('town',12000,12000,2000)]),0);
    check(frame([unit(),building('town',28000)]),0);
    check(frame([unit(),town]),1);check(frame([town]),0);check(frame([unit(),town]),1);
  });
  it('rejects an occluded enclosing disk and rechecks unchanged sources on geometry changes',()=>{
    const kernel=new VisionMaskKernel(),town=building('town',10000,12000,10000),soldier=unit(16000,12000,3000),open=frame([soldier,town]);
    expect(kernel.computeRetained(open)).toEqual(scalar(open));expect(kernel.workSnapshot().coveredSources).toBe(1);
    const blocked={...open,blockerRevision:1,blockers:[{id:'ridge',xMm:13000,zMm:12000,halfWidth:500,halfHeight:10000}]};
    const actual=kernel.computeRetained(blocked);expect(actual).toEqual(scalar(blocked));expect(kernel.workSnapshot()).toMatchObject({coveredSources:0,rasterizedSources:2});
    const beyondRidge=12*32+16;expect(actual[0]!.visible).toContain(beyondRidge);
    expect(scalar({...blocked,groups:[immutableVisionGroup('allies',[town])]})[0]!.visible).not.toContain(beyondRidge);
    expect(kernel.computeRetained(open)).toEqual(scalar(open));expect(kernel.workSnapshot().coveredSources).toBe(1);
    for(const input of [{...open,width:27},{...open,gridMm:1250},{...open,cacheKey:'other-map'}]){expect(kernel.computeRetained(input)).toEqual(scalar(input));expect(kernel.workSnapshot().rasterizedSources).toBe(1);}
  });
  it('never witnesses through other groups, moving units or unclassified generic sources',()=>{
    const kernel=new VisionMaskKernel(),town=building(),soldier=unit(),input=frame([soldier,town]);kernel.computeRetained(input);
    const split={...input,groups:[immutableVisionGroup('allies',[soldier]),immutableVisionGroup('enemy',[town])]};
    expect(kernel.computeRetained(split)).toEqual(scalar(split));expect(kernel.workSnapshot().coveredSources).toBe(0);
    const moving=frame([soldier,immutableVisionSource('town',12000,12000,9000,'unit')]);expect(kernel.computeRetained(moving)).toEqual(scalar(moving));expect(kernel.workSnapshot().coveredSources).toBe(0);
    kernel.computeRetained(input);const generic=structuredClone(input);expect(kernel.computeRetained(generic)).toEqual(scalar(generic));expect(kernel.workSnapshot()).toMatchObject({coveredSources:0,rasterizedSources:1});
    generic.groups[0]!.sources[0]!.xMm=28000;expect(kernel.computeRetained(generic)).toEqual(scalar(generic));
    expect(kernel.computeRetained(input)).toEqual(scalar(input));expect(kernel.workSnapshot().coveredSources).toBe(1);
  });
  it('bounds new candidate checks but tests the previous current witness before the cap',()=>{
    const kernel=new VisionMaskKernel(),town=building(),soldier=unit(),decoys=Array.from({length:40},(_,i)=>building(`decoy-${i}`,4000,4000,1000));
    kernel.computeRetained(frame([soldier,town]));
    const crowded=frame([soldier,...decoys,town]);expect(kernel.computeRetained(crowded)).toEqual(scalar(crowded));expect(kernel.workSnapshot()).toMatchObject({coveredSources:1,witnessChecks:1});
    const cold=new VisionMaskKernel();expect(cold.computeRetained(crowded)).toEqual(scalar(crowded));expect(cold.workSnapshot()).toMatchObject({coveredSources:0,witnessChecks:32});
    const restored=new VisionMaskKernel();expect(restored.computeRetained(frame([soldier,town]))).toEqual(scalar(frame([soldier,town])));
  });
  it('retains positive and negative decisions for unchanged poses under the exact same building set',()=>{
    const kernel=new VisionMaskKernel(),town=building(),inside=unit(),outside=unit(22000,12000,2500,'outside');
    const first=frame([inside,outside,town]);expect(kernel.computeRetained(first)).toEqual(scalar(first));expect(kernel.workSnapshot()).toMatchObject({coveredSources:1,witnessChecks:2});
    // Fresh group identity forces the reconciliation loop; no stationary source
    // should pay the bucket/candidate search again for the unchanged building set.
    const same=frame([inside,outside,town]);expect(kernel.computeRetained(same)).toEqual(scalar(same));expect(kernel.workSnapshot()).toEqual({rasterizedSources:0,coveredSources:1,witnessChecks:0});
    const wider=frame([inside,outside,building('town',12000,12000,15000)]);expect(kernel.computeRetained(wider)).toEqual(scalar(wider));expect(kernel.workSnapshot()).toMatchObject({coveredSources:2,witnessChecks:2});
    const narrowed=frame([inside,outside,town]);expect(kernel.computeRetained(narrowed)).toEqual(scalar(narrowed));expect(kernel.workSnapshot()).toMatchObject({coveredSources:1,witnessChecks:2});
  });
  it('falls back for nonintegral or overflowing caller-created classifications',()=>{
    const kernel=new VisionMaskKernel(),fractional=frame([unit(12000.25),building()]);expect(kernel.computeRetained(fractional)).toEqual(scalar(fractional));expect(kernel.workSnapshot().coveredSources).toBe(0);
    const huge=frame([unit(1500,1500,1000),building('huge',1.1e155,1500,1e155)]);
    expect(kernel.computeRetained(huge)).toEqual(new VisionMaskKernel().computeRetained(structuredClone(huge)));expect(kernel.workSnapshot().coveredSources).toBe(0);expect(kernel.computeRetained(huge)[0]!.visible.length).toBeGreaterThan(0);
  });
});

describe('exact vision mask kernel',()=>{
  it('packs unobstructed fractional circle rows exactly across word edges and tangencies',()=>{
    for(const width of [1,7,31,32,33,65])for(const offset of [-500.125,0,.125,500,999.875])for(const radius of [.125,500,Math.sqrt(2)*1000,2500.125,9000]){
      const frame:VisionMaskFrame={width,height:9,gridMm:1000,cacheKey:'span-oracle',blockerRevision:0,blockers:[],groups:[{key:'one',sources:[{id:'moving',xMm:width*500+offset,zMm:4500+offset,radius}]}]};
      expect(new VisionMaskKernel().computeRetained(frame)).toEqual(scalar(frame));
    }
  });
  it('certifies changed words only against the exact private predecessor including rebuild removals',()=>{
    const kernel=new VisionMaskKernel(),frame:VisionMaskFrame={width:65,height:11,gridMm:1000,cacheKey:'delta-proof',blockerRevision:0,blockers:[],groups:[{key:'one',sources:[{id:'moving',xMm:5500,zMm:5500,radius:4000}]}]};
    let previous=kernel.computeRetained(frame)[0]!.mask;
    const first=previous;
    for(const [xMm,blockerRevision]of [[6500,0],[49500,0],[5500,1],[9500,1]] as const){
      const changedFrame={...frame,blockerRevision,groups:[{key:'one',sources:[{...frame.groups[0]!.sources[0]!,xMm}]}]},next=kernel.computeRetained(changedFrame)[0]!.mask;
      expect(next).toEqual(scalar(changedFrame)[0]!.mask);
      const words=changedVisionMaskWords(previous,next)!;expect(words).toBeDefined();expect(Object.isFrozen(words)).toBe(true);
      for(let cell=0;cell<next.length;cell++)if(next[cell]!==previous[cell])expect(words).toContain(cell>>>5);
      expect(changedVisionMaskWords(previous.slice(),next)).toBeUndefined();
      expect(changedVisionMaskWords(previous,kernel.compute(changedFrame)[0]!.mask)).toBeUndefined();
      if(previous!==first)expect(changedVisionMaskWords(first,next)).toBeUndefined();
      previous=next;
    }
    const empty=kernel.computeRetained({...frame,blockerRevision:2,groups:[{key:'one',sources:[]}]})[0]!.mask,removed=changedVisionMaskWords(previous,empty)!;
    for(let cell=0;cell<previous.length;cell++)if(previous[cell])expect(removed).toContain(cell>>>5);
    expect(empty.some(Boolean)).toBe(false);
  });
  it('retains read-only result identities for unchanged unions and owns public writable/transferable copies',()=>{
    const frame=fixture(),kernel=new VisionMaskKernel(),first=kernel.computeRetained(frame),before=structuredClone(first);
    const unchanged=kernel.computeRetained(structuredClone(frame));
    for(let index=0;index<first.length;index++){expect(unchanged[index]).toBe(first[index]);expect(Object.isFrozen(first[index])).toBe(true);expect(Object.isFrozen(first[index]!.visible)).toBe(true);}
    const publicOne=kernel.compute(frame),publicTwo=kernel.compute(frame);
    expect(publicOne).toEqual(before);expect(publicTwo).toEqual(before);
    for(let index=0;index<first.length;index++){expect(publicOne[index]).not.toBe(first[index]);expect(publicOne[index]!.mask.buffer).not.toBe(first[index]!.mask.buffer);expect(publicTwo[index]!.mask.buffer).not.toBe(publicOne[index]!.mask.buffer);expect(publicOne[index]!.visible).not.toBe(first[index]!.visible);}
    publicOne[0]!.mask.fill(0);publicOne[0]!.visible.length=0;
    structuredClone(publicTwo,{transfer:publicTwo.map(result=>result.mask.buffer as ArrayBuffer)});
    expect(publicTwo.every(result=>result.mask.byteLength===0)).toBe(true);expect(kernel.computeRetained(frame)).toEqual(before);expect(kernel.computeRetained(frame)[0]).toBe(first[0]);expect(kernel.compute(frame)).toEqual(before);
  });
  it('keeps identical unions across overlapping movement, compensation and dense contributor removal',()=>{
    const large={id:'large',xMm:15500,zMm:15500,radius:12000},small={id:'small',xMm:15500,zMm:15500,radius:1000};
    const frame:VisionMaskFrame={width:32,height:32,gridMm:1000,cacheKey:'retained-union',blockerRevision:0,blockers:[],groups:[{key:'team',sources:[large,small]}]};
    const kernel=new VisionMaskKernel(),first=kernel.computeRetained(frame)[0]!,original=structuredClone(first);
    const covered={...frame,groups:[{key:'team',sources:[large,{...small,xMm:16500,zMm:16500}]}]};expect(kernel.computeRetained(covered)[0]).toBe(first);expect(kernel.computeRetained(covered)).toEqual(scalar(covered));
    const dense={...frame,groups:[{key:'team',sources:Array.from({length:80},(_,index)=>({...large,id:`dense-${index}`}))}]};expect(kernel.computeRetained(dense)[0]).toBe(first);
    const sparse={...frame,groups:[{key:'team',sources:[large]}]};expect(kernel.computeRetained(sparse)[0]).toBe(first);expect(kernel.computeRetained(sparse)).toEqual(scalar(sparse));
    const separate={...frame,groups:[{key:'team',sources:[{...small,id:'a',xMm:5500,zMm:5500},{...small,id:'b',xMm:25500,zMm:25500}]}]};
    const prior=kernel.computeRetained(separate)[0]!,swap={...frame,groups:[{key:'team',sources:separate.groups[0]!.sources.map((source,index)=>({...separate.groups[0]!.sources[1-index]!,id:source.id}))}]};
    expect(kernel.computeRetained(swap)[0]).toBe(prior);expect(kernel.computeRetained(swap)).toEqual(scalar(swap));expect(first).toEqual(original);
    const one={...frame,groups:[{key:'team',sources:swap.groups[0]!.sources.slice(0,1)}]};expect(kernel.computeRetained(one)[0]).not.toBe(prior);expect(kernel.computeRetained(one)).toEqual(scalar(one));
  });
  it('retains exact same-mask geometry rebuilds and reorders results without retaining retired groups',()=>{
    const frame=fixture(),kernel=new VisionMaskKernel(),first=kernel.computeRetained(frame);
    const reordered={...frame,blockerRevision:1,groups:[...frame.groups].reverse()},second=kernel.computeRetained(reordered);
    expect(second).toEqual(scalar(reordered));for(let index=0;index<second.length;index++)expect(second[index]).toBe(first[first.length-1-index]);
    const changed={...reordered,blockerRevision:2,blockers:[]},next=kernel.computeRetained(changed),expected=scalar(changed);
    expect(next).toEqual(expected);for(let index=0;index<next.length;index++){const same=expected[index]!.mask.every((value,cell)=>value===second[index]!.mask[cell]);if(same)expect(next[index]).toBe(second[index]);else expect(next[index]).not.toBe(second[index]);}
    kernel.computeRetained({...changed,groups:changed.groups.slice(1)});const restored=kernel.computeRetained(changed);expect(restored[0]).not.toBe(next[0]);for(let index=1;index<restored.length;index++)expect(restored[index]).toBe(next[index]);
    const resized={...changed,width:31,height:20,gridMm:1250},smaller=kernel.computeRetained(resized);expect(smaller).toEqual(scalar(resized));for(let index=0;index<smaller.length;index++)expect(smaller[index]).not.toBe(restored[index]);
  });
  it('preserves last duplicate-source membership and distinct sequential duplicate-group snapshots',()=>{
    const a={id:'same-source',xMm:2500,zMm:2500,radius:1500},b={...a,xMm:8500,zMm:8500};
    const frame:VisionMaskFrame={width:12,height:12,gridMm:1000,cacheKey:'duplicates',blockerRevision:0,blockers:[],groups:[{key:'same-group',sources:[a]},{key:'same-group',sources:[a,b]}]};
    const kernel=new VisionMaskKernel(),result=kernel.computeRetained(frame),expected=scalar({...frame,groups:[{key:'same-group',sources:[a]},{key:'same-group',sources:[b]}]});
    expect(result).toEqual(expected);expect(result[0]).not.toBe(result[1]);expect(result[0]!.mask.buffer).not.toBe(result[1]!.mask.buffer);
    const old=structuredClone(result);kernel.computeRetained({...frame,groups:[{key:'same-group',sources:[]}]});expect(result).toEqual(old);expect(kernel.compute(frame)).toEqual(expected);
  });
  it('matches independent scalar output for 1200 warm frames and 600 independent cold continuations',()=>{
    const kernel=new VisionMaskKernel();let cold:VisionMaskKernel|undefined,prior=new Map<string,VisionMaskResult>();
    for(let tick=1;tick<=1800;tick++){
      const phase=Math.floor(tick/4),blocked=Math.floor(tick/200)%2===1;
      const frame:VisionMaskFrame={width:18,height:15,gridMm:1000,cacheKey:'retained-oracle',blockerRevision:blocked?1:0,blockers:blocked?terrainVisionBlockers([{id:'cliff',kind:'cliff',xMm:9000,zMm:0,widthMm:1000,depthMm:11000,elevationMm:2000}]):[],groups:Array.from({length:3},(_,index)=>({key:`team-${(index+phase)%3}`,sources:Array.from({length:4-(phase+index)%3},(_,source)=>({id:`source-${source}`,xMm:(phase*419+index*1901+source*3301)%18000-250,zMm:(phase*311+index*977+source*2503)%15000-250,radius:2000+source*750.5}))})).filter((_,index)=>tick%23!==0||index!==2)};
      const expected=scalar(frame),actual=kernel.computeRetained(frame);expect(actual).toEqual(expected);if(cold)expect(cold.computeRetained(frame)).toEqual(expected);
      for(const result of actual){const old=prior.get(result.key);if(!old)continue;const same=result.mask.every((value,cell)=>value===old.mask[cell]);if(same)expect(result).toBe(old);else expect(result).not.toBe(old);}
      prior=new Map(actual.map(result=>[result.key,result]));
      if(tick===1200){cold=new VisionMaskKernel();expect(cold.computeRetained(frame)).toEqual(expected);}
    }
  });
  it('matches scalar cell centers, radius edges, cliff occlusion and ramp passages for eleven factions',()=>{
    const frame=fixture();expect(new VisionMaskKernel().compute(frame)).toEqual(scalar(frame));
  });
  it('preserves sorted cells across sign bits, partial final words and overlapping allied sources',()=>{
    const frame:VisionMaskFrame={width:35,height:3,gridMm:1000,cacheKey:'word-edges',blockerRevision:0,blockers:[],groups:[
      {key:'team:allies',sources:[{id:'a',xMm:30500,zMm:1500,radius:4000},{id:'b',xMm:34000,zMm:1000,radius:2500}]},
      {key:'team:empty',sources:[]},
    ]};
    const result=new VisionMaskKernel().compute(frame);expect(result).toEqual(scalar(frame));
    expect(result[0]!.visible).toContain(31);expect(result[0]!.visible).toContain(32);expect(result[0]!.visible).toContain(104);
    expect(result[1]!.visible).toEqual([]);
  });
  it('invalidates moved, upgraded, removed, ejected and transferred sources without lingering fog',()=>{
    const kernel=new VisionMaskKernel(),frame=fixture();kernel.compute(frame);
    const changed=structuredClone(frame),groups=changed.groups.map(group=>({...group,sources:[...group.sources]}));
    groups[0]!.sources[0]={...groups[0]!.sources[0]!,xMm:51000,zMm:35000,radius:12000};
    groups[0]!.sources.splice(1,2);groups[1]!.sources.push({id:'ejected',xMm:40000,zMm:5000,radius:6000});
    groups[2]!.sources.push(groups[1]!.sources.shift()!);groups.splice(5,1);
    changed.groups=groups;expect(kernel.compute(changed)).toEqual(scalar(changed));
    expect(kernel.compute(frame)).toEqual(scalar(frame));
  });
  it('rebuilds derived stamps for terrain and map changes and matches cold continuation',()=>{
    const kernel=new VisionMaskKernel(),frame=fixture();kernel.compute(frame);
    const changed={...frame,blockerRevision:1,blockers:[]};
    expect(kernel.compute(changed)).toEqual(scalar(changed));
    const resized={...changed,cacheKey:'new-map',width:31,height:20,gridMm:1250};
    expect(kernel.compute(resized)).toEqual(new VisionMaskKernel().compute(resized));
    expect(kernel.compute(resized)).toEqual(scalar(resized));
  });
  it('does not retain writable result buffers or mutate source frames',()=>{
    const frame=fixture(),before=structuredClone(frame),kernel=new VisionMaskKernel(),first=kernel.compute(frame);
    first[0]!.mask.fill(0);first[0]!.visible.length=0;
    expect(kernel.compute(frame)).toEqual(scalar(frame));expect(frame).toEqual(before);
  });
  it('keeps overlapping vision until the last source leaves each cell',()=>{
    const kernel=new VisionMaskKernel(),source={id:'a',xMm:12500,zMm:14500,radius:5500};
    const frame:VisionMaskFrame={width:41,height:33,gridMm:1000,cacheKey:'overlap',blockerRevision:0,blockers:[],groups:[{key:'team',sources:[source,{...source,id:'b'}]}]};
    const initial=kernel.compute(frame);
    const one={...frame,groups:[{key:'team',sources:[source]}]};expect(kernel.compute(one)).toEqual(initial);
    const moved={...frame,groups:[{key:'team',sources:[{...source,xMm:22000},{...source,id:'b'}]}]};
    expect(kernel.compute(moved)).toEqual(scalar(moved));
    const movedOnly={...frame,groups:[{key:'team',sources:[{...source,xMm:22000}]}]};expect(kernel.compute(movedOnly)).toEqual(scalar(movedOnly));
    const empty={...frame,groups:[{key:'team',sources:[]}]};expect(kernel.compute(empty)).toEqual(scalar(empty));expect(kernel.compute(empty)[0]!.mask.some(Boolean)).toBe(false);
  });
  it('does no source membership work for unchanged frames and releases dead sources and retired groups',()=>{
    const frame=fixture(),kernel=new VisionMaskKernel(),internals=kernel as unknown as {updateSource(group:unknown,previous:Uint32Array,next:Uint32Array):void;stamps:Map<string,Map<string,unknown>>;masks:Map<string,unknown>};
    const update=vi.spyOn(internals,'updateSource');kernel.compute(frame);expect(update).toHaveBeenCalledTimes(88);
    const retained=internals.masks.get(frame.groups[0]!.key);update.mockClear();expect(kernel.compute(structuredClone(frame))).toEqual(scalar(frame));expect(update).not.toHaveBeenCalled();
    expect(internals.masks.get(frame.groups[0]!.key)).toBe(retained);
    const only={...frame,groups:[{key:frame.groups[0]!.key,sources:[]}]};expect(kernel.compute(only)).toEqual(scalar(only));
    expect(update).toHaveBeenCalledTimes(8);expect(internals.stamps.size).toBe(1);expect(internals.stamps.get(only.groups[0]!.key)!.size).toBe(0);expect(internals.masks.size).toBe(1);
    kernel.compute({...frame,groups:[]});expect(internals.stamps.size).toBe(0);expect(internals.masks.size).toBe(0);
  });
  it('removes old owner-group contributions, rebuilds on geometry changes and survives result transfer',()=>{
    const kernel=new VisionMaskKernel(),frame=fixture();kernel.compute(frame);
    const moved={...frame,groups:[{key:'new-owner',sources:frame.groups[0]!.sources},{key:frame.groups[0]!.key,sources:[]}]};
    const result=kernel.compute(moved);expect(result).toEqual(scalar(moved));
    structuredClone(result,{transfer:result.map(group=>group.mask.buffer as ArrayBuffer)});
    expect(result.every(group=>group.mask.byteLength===0)).toBe(true);expect(kernel.compute(moved)).toEqual(scalar(moved));
    const changed={...moved,blockerRevision:1,blockers:[]};expect(kernel.compute(changed)).toEqual(scalar(changed));expect(kernel.compute(changed)).toEqual(new VisionMaskKernel().compute(changed));
  });
  it('rebuilds dense source churn exactly, then resumes sparse updates with correct overlap counts',()=>{
    const sources=Array.from({length:80},(_,index)=>({id:`source-${index}`,xMm:15500,zMm:15500,radius:12000}));
    const frame:VisionMaskFrame={width:32,height:32,gridMm:1000,cacheKey:'dense-churn',blockerRevision:0,blockers:[],groups:[{key:'team',sources}]};
    const kernel=new VisionMaskKernel(),internals=kernel as unknown as {rebuildGroup(group:unknown,stamps:Iterable<unknown>):void};
    const rebuild=vi.spyOn(internals,'rebuildGroup');expect(kernel.compute(frame)).toEqual(scalar(frame));expect(rebuild).not.toHaveBeenCalled();
    const survivors={...frame,groups:[{key:'team',sources:sources.slice(0,2)}]};
    expect(kernel.compute(survivors)).toEqual(scalar(survivors));expect(rebuild).toHaveBeenCalledTimes(1);
    const moved={...frame,groups:[{key:'team',sources:[{...sources[0]!,xMm:18000},sources[1]!]}]};
    expect(kernel.compute(moved)).toEqual(scalar(moved));expect(rebuild).toHaveBeenCalledTimes(1);
    expect(kernel.compute(frame)).toEqual(new VisionMaskKernel().compute(frame));
    const empty={...frame,groups:[{key:'team',sources:[]}]};
    expect(kernel.compute(empty)).toEqual(scalar(empty));expect(rebuild).toHaveBeenCalledTimes(2);
    expect(kernel.compute(survivors)).toEqual(scalar(survivors));
  });
});
