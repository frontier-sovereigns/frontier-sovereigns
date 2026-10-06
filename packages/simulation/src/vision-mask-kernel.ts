import { terrainLineOfSight, type TerrainObstacle } from '@frontier/shared';

/** A sealed perception phase contains geometry and vision sources, never a live world. */
export interface VisionMaskSource {id:string;xMm:number;zMm:number;radius:number;kind?:'unit'|'building'}
export interface VisionMaskGroup {key:string;sources:readonly VisionMaskSource[]}
export interface VisionMaskFrame {
  width:number;height:number;gridMm:number;cacheKey:string;blockerRevision:number;
  blockers:readonly TerrainObstacle[];groups:readonly VisionMaskGroup[];
}
export interface VisionMaskResult {key:string;mask:Uint8Array;visible:number[]}
interface Stamp {xMm:number;zMm:number;radius:number;wordPairs:Uint32Array;cellCount:number;witness?:VisionMaskSource;coverage?:BuildingWitnesses}
interface BuildingWitnesses {sources:readonly VisionMaskSource[];clear:Map<string,{source:VisionMaskSource;clear:boolean}>;candidates:Map<string,VisionMaskSource>;buckets:Map<string,VisionMaskSource[]>;cellMm:number}
interface GroupMask {counts:Uint32Array;mask:Uint8Array;words:Uint32Array;changedWords:Set<number>;contributions:number;published?:VisionMaskResult;publishedWords?:Uint32Array;sources?:VisionMaskGroup;witnesses?:BuildingWitnesses}
const EMPTY_WORD_PAIRS=new Uint32Array();
const immutableSources=new WeakSet<VisionMaskSource>(),immutableGroups=new WeakSet<VisionMaskGroup>();
const sourceKinds=new WeakMap<VisionMaskSource,'unit'|'building'>(),groupBuildings=new WeakMap<VisionMaskGroup,readonly VisionMaskSource[]>();
const MAX_WITNESS_CANDIDATES=32;
// Within this conservative native bound, every squared integer distance below
// is exact in a JS number. Nonintegral or larger public fixtures use the oracle.
const witnessCoordinates=(source:VisionMaskSource)=>Number.isSafeInteger(source.xMm)&&Number.isSafeInteger(source.zMm)&&Number.isSafeInteger(source.radius)&&Math.abs(source.xMm)<=1000000&&Math.abs(source.zMm)<=1000000&&source.radius<=1000000;
/** Fresh scalar snapshots only. A frozen caller object or proxy is not a proof. */
export function immutableVisionSource(id:string,xMm:number,zMm:number,radius:number,nativeKind?:'unit'|'building'):VisionMaskSource {
  if(typeof id!=='string'||!Number.isFinite(xMm)||!Number.isFinite(zMm)||!Number.isFinite(radius)||radius<=0)throw new Error('INVALID_IMMUTABLE_VISION_SOURCE');
  const source=Object.freeze({id,xMm,zMm,radius,...(nativeKind?{kind:nativeKind}:{})});immutableSources.add(source);if(nativeKind==='unit'||nativeKind==='building')sourceKinds.set(source,nativeKind);return source;
}
export function immutableVisionGroup(key:string,sources:readonly VisionMaskSource[]):VisionMaskGroup {
  if(typeof key!=='string')throw new Error('INVALID_IMMUTABLE_VISION_GROUP');
  const owned:VisionMaskSource[]=[],buildings:VisionMaskSource[]=[],ids=new Set<string>();
  for(const source of sources){if(!immutableSources.has(source)||ids.has(source.id))throw new Error('INVALID_IMMUTABLE_VISION_GROUP');ids.add(source.id);owned.push(source);if(sourceKinds.get(source)==='building')buildings.push(source);}
  const group=Object.freeze({key,sources:Object.freeze(owned)});immutableGroups.add(group);groupBuildings.set(group,Object.freeze(buildings));return group;
}
/** Only our deeply frozen scalar snapshots may cross an arbitrary callback
 * without copying. Object.freeze on an external object is not this certificate. */
export function isImmutableVisionGroup(group:VisionMaskGroup):boolean{return immutableGroups.has(group);}
const maskChanges=new WeakMap<Uint8Array,{previous:WeakRef<Uint8Array>;words:readonly number[]}>();
/** A private kernel publication proves the changed-word set only against its
 * exact predecessor. Public writable copies and transferred masks have no proof.
 * Weak predecessor references avoid retaining a chain of historical fog maps. */
export function changedVisionMaskWords(previous:Uint8Array,next:Uint8Array):readonly number[]|undefined {
  const change=maskChanges.get(next);return change?.previous.deref()===previous?change.words:undefined;
}
/** Reconstruct a private changed-word proof after a worker/callback boundary.
 * Both buffers must already be privately owned by the caller. Compute the proof
 * from actual bytes, never from an external list of purported changed cells. */
export function retainTransferredVisionChanges(previous:Uint8Array,next:Uint8Array):void {
  if(previous===next||previous.length!==next.length)return;
  const changed:number[]=[];
  for(let start=0;start<next.length;start+=32){const end=Math.min(next.length,start+32);for(let cell=start;cell<end;cell++)if(previous[cell]!==next[cell]){changed.push(start>>>5);break;}}
  maskChanges.set(next,{previous:new WeakRef(previous),words:Object.freeze(changed)});
}

/** Exact, synchronous kernel shared by threaded play, replay and failure recovery.
 * Caches are derived only: they do not affect work grants or any saved game state.
 * compute() results exclusively own their buffers and may be transferred.
 * computeRetained() exposes immutable-by-contract internal publications instead.
 */
export class VisionMaskKernel {
  private geometryKey='';
  private stamps=new Map<string,Map<string,Stamp>>();
  private masks=new Map<string,GroupMask>();
  private work={rasterizedSources:0,coveredSources:0,witnessChecks:0};

  /** Derived, bounded counters for the most recent call; never saved or sent. */
  workSnapshot():Readonly<typeof this.work>{return {...this.work};}

  private buildingWitnesses(group:VisionMaskGroup,mask:GroupMask,blockers:readonly TerrainObstacle[]):BuildingWitnesses {
    const sources=groupBuildings.get(group)!,prior=mask.witnesses;
    if(prior&&sources.length===prior.sources.length&&sources.every((source,index)=>source===prior.sources[index]))return prior;
    const clear:BuildingWitnesses['clear']=new Map(),candidates:BuildingWitnesses['candidates']=new Map();let cellMm=1;
    for(const source of sources){
      const old=prior?.clear.get(source.id),unoccluded=old?.source===source?old.clear:!blockers.some(blocker=>Math.abs(blocker.xMm-source.xMm)<=blocker.halfWidth+source.radius&&Math.abs(blocker.zMm-source.zMm)<=blocker.halfHeight+source.radius);
      clear.set(source.id,{source,clear:unoccluded});
      if(unoccluded&&witnessCoordinates(source)){candidates.set(source.id,source);cellMm=Math.max(cellMm,source.radius);}
    }
    const buckets:BuildingWitnesses['buckets']=new Map();
    for(const source of candidates.values()){const key=`${Math.floor(source.xMm/cellMm)}:${Math.floor(source.zMm/cellMm)}`,bucket=buckets.get(key)??[];bucket.push(source);buckets.set(key,bucket);}
    return mask.witnesses={sources,clear,candidates,buckets,cellMm};
  }

  private coveringBuilding(source:VisionMaskSource,previous:VisionMaskSource|undefined,witnesses:BuildingWitnesses):VisionMaskSource|undefined {
    if(!witnesses.candidates.size||!witnessCoordinates(source))return;
    const covers=(building:VisionMaskSource)=>{this.work.witnessChecks++;const remaining=building.radius-source.radius;return remaining>0&&(building.xMm-source.xMm)**2+(building.zMm-source.zMm)**2<remaining*remaining;};
    if(previous&&witnesses.candidates.get(previous.id)===previous&&covers(previous))return previous;
    const x=Math.floor(source.xMm/witnesses.cellMm),z=Math.floor(source.zMm/witnesses.cellMm);let checked=0;
    for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++)for(const building of witnesses.buckets.get(`${x+dx}:${z+dz}`)??[]){
      if(building===previous)continue;
      if(checked++===MAX_WITNESS_CANDIDATES)return;
      if(covers(building))return building;
    }
  }

  private rebuildGroup(group:GroupMask,stamps:Iterable<Stamp>):void {
    for(let word=0;word<group.words.length;word++)if(group.words[word])group.changedWords.add(word);
    group.counts.fill(0);group.mask.fill(0);group.words.fill(0);
    for(const stamp of stamps)this.updateSource(group,EMPTY_WORD_PAIRS,stamp.wordPairs);
  }

  /** Apply only changed membership. A moving source commonly keeps most of its
   * cells, so unchanged bits neither decrement nor increment the shared count. */
  private updateSource(group:GroupMask,previous:Uint32Array,next:Uint32Array):void {
    let oldIndex=0,newIndex=0;
    while(oldIndex<previous.length||newIndex<next.length){
      const oldWord=oldIndex<previous.length?previous[oldIndex]!:Infinity,newWord=newIndex<next.length?next[newIndex]!:Infinity;
      const word=Math.min(oldWord,newWord),oldBits=oldWord===word?previous[oldIndex+1]!:0,newBits=newWord===word?next[newIndex+1]!:0;
      if(oldWord===word)oldIndex+=2;if(newWord===word)newIndex+=2;
      let removed=oldBits&~newBits,added=newBits&~oldBits;
      while(removed){
        const bit=removed&-removed,cell=word*32+31-Math.clz32(bit),count=group.counts[cell]!;
        if(!count)throw new Error('VISION_COUNT_UNDERFLOW');
        group.counts[cell]=count-1;
        if(count===1){group.mask[cell]=0;group.words[word]=group.words[word]!&~bit;group.changedWords.add(word);}
        removed&=removed-1;
      }
      while(added){
        const bit=added&-added,cell=word*32+31-Math.clz32(bit),count=group.counts[cell]!;
        if(count===0xffffffff)throw new Error('VISION_COUNT_OVERFLOW');
        group.counts[cell]=count+1;
        if(!count){group.mask[cell]=1;group.words[word]=group.words[word]!|bit;group.changedWords.add(word);}
        added&=added-1;
      }
    }
  }

  /** Independent writable/transferable results, preserving the original API. */
  compute(frame:VisionMaskFrame):VisionMaskResult[] {
    return this.computeRetained(frame).map(result=>({key:result.key,mask:result.mask.slice(),visible:result.visible.slice()}));
  }

  /** Private read-only publications. Never mutate or detach these mask buffers.
   * Result, mask and visible identities survive an exactly unchanged final union,
   * including overlapping source moves. Returned result-list order follows frame.
   * Published buffers never alias the mutable contribution/count working buffers. */
  computeRetained(frame:VisionMaskFrame):VisionMaskResult[] {
    this.work={rasterizedSources:0,coveredSources:0,witnessChecks:0};
    const {width,height,gridMm,blockers}=frame;
    const geometryKey=JSON.stringify([frame.cacheKey,frame.blockerRevision,width,height,gridMm]);
    let previousMasks:Map<string,GroupMask>|undefined;
    if(geometryKey!==this.geometryKey){this.geometryKey=geometryKey;this.stamps.clear();previousMasks=this.masks;this.masks=new Map();}
    const activeGroups=new Set<string>(),results:VisionMaskResult[]=[];
    for(const group of frame.groups){
      activeGroups.add(group.key);
      let stamps=this.stamps.get(group.key);
      if(!stamps){stamps=new Map();this.stamps.set(group.key,stamps);}
      let groupMask=this.masks.get(group.key);
      // Only internally created immutable snapshots can skip source lookup and
      // removal bookkeeping. A geometry change replaces masks above, so it can
      // never reuse the prior visibility union merely from source identity.
      const immutable=immutableGroups.has(group);
      if(immutable&&groupMask?.sources===group&&groupMask.published){results.push(groupMask.published);continue;}
      if(groupMask)delete groupMask.sources;
      const rebuilt=!groupMask;
      if(!groupMask){const size=width*height,previous=previousMasks?.get(group.key);groupMask={counts:new Uint32Array(size),mask:new Uint8Array(size),words:new Uint32Array(Math.ceil(size/32)),changedWords:new Set(),contributions:0,...(previous?.published?.mask.length===size?{published:previous.published,publishedWords:previous.publishedWords}:{})};this.masks.set(group.key,groupMask);}
      const witnesses=immutable?this.buildingWitnesses(group,groupMask,blockers):undefined;
      groupMask.changedWords.clear();
      const live=new Set<string>(),changes:{previous:Uint32Array;next:Uint32Array}[]=[];
      let minimumChangedCells=0;
      for(const source of group.sources){
        live.add(source.id);
        let stamp=stamps.get(source.id);
        const unchanged=!!stamp&&stamp.xMm===source.xMm&&stamp.zMm===source.zMm&&stamp.radius===source.radius;
        const coverage=witnesses&&sourceKinds.get(source)==='unit'?witnesses:undefined;
        const witness=coverage?(unchanged&&stamp!.coverage===coverage?stamp!.witness:this.coveringBuilding(source,stamp?.witness,coverage)):undefined;
        if(witness){
          this.work.coveredSources++;
          // A current, unoccluded building disk contains the unit's entire disk.
          // Its contribution alone proves the exact union; retain no unit cells.
          // Reconsider this even for stationary units when building/group/terrain
          // changes, rather than allowing a removed witness to hide a source.
          if(stamp&&!stamp.witness){changes.push({previous:stamp.wordPairs,next:EMPTY_WORD_PAIRS});minimumChangedCells+=stamp.cellCount;groupMask.contributions-=stamp.cellCount;}
          if(!stamp||stamp.witness!==witness||!unchanged||stamp.coverage!==coverage)stamps.set(source.id,{xMm:source.xMm,zMm:source.zMm,radius:source.radius,wordPairs:EMPTY_WORD_PAIRS,cellCount:0,witness,coverage});
          continue;
        }
        if(!stamp||stamp.witness||!unchanged){
          this.work.rasterizedSources++;
          const wordPairs:number[]=[],radius=source.radius,squared=radius*radius;let cellCount=0;
          const nearby=blockers.filter(blocker=>Math.abs(blocker.xMm-source.xMm)<=blocker.halfWidth+radius&&Math.abs(blocker.zMm-source.zMm)<=blocker.halfHeight+radius);
          for(let z=Math.max(0,Math.floor((source.zMm-radius)/gridMm));z<Math.min(height,Math.ceil((source.zMm+radius)/gridMm));z++){
            const zMm=(z+.5)*gridMm,dz=zMm-source.zMm;
            if(!nearby.length){
              // Exact circle rows are contiguous. Pack whole bit spans rather
              // than allocating/testing every interior cell of every source.
              const remaining=squared-dz*dz;if(remaining<0)continue;
              const reach=Math.sqrt(remaining),minimum=Math.max(0,Math.floor((source.xMm-radius)/gridMm)),maximum=Math.min(width,Math.ceil((source.xMm+radius)/gridMm))-1;
              let first=Math.max(minimum,Math.ceil((source.xMm-reach)/gridMm-.5)),last=Math.min(maximum,Math.floor((source.xMm+reach)/gridMm-.5));
              const inside=(x:number)=>((x+.5)*gridMm-source.xMm)**2+dz*dz<=squared;
              // Preserve the scalar inequality at floating point tangencies.
              while(first<=last&&!inside(first))first++;while(last>=first&&!inside(last))last--;
              if(first>minimum&&inside(first-1))first--;if(last<maximum&&inside(last+1))last++;
              if(first>last)continue;cellCount+=last-first+1;
              const end=z*width+last;
              for(let cell=z*width+first;cell<=end;){const word=cell>>>5,low=cell&31,high=Math.min(31,end-word*32),bits=((0xffffffff>>> (31-high))&(0xffffffff<<low))>>>0,lastPair=wordPairs.length-2;
                if(lastPair>=0&&wordPairs[lastPair]===word)wordPairs[lastPair+1]=(wordPairs[lastPair+1]!|bits)>>>0;else wordPairs.push(word,bits);
                cell=word*32+high+1;
              }
              continue;
            }
            for(let x=Math.max(0,Math.floor((source.xMm-radius)/gridMm));x<Math.min(width,Math.ceil((source.xMm+radius)/gridMm));x++){
              const xMm=(x+.5)*gridMm,dx=xMm-source.xMm;
              if(dx*dx+dz*dz<=squared&&(!nearby.length||terrainLineOfSight(nearby,source,{xMm,zMm}))){
                cellCount++;
                const cell=z*width+x,word=cell>>>5,bit=(1<<(cell&31))>>>0,last=wordPairs.length-2;
                if(last>=0&&wordPairs[last]===word)wordPairs[last+1]=(wordPairs[last+1]!|bit)>>>0;
                else wordPairs.push(word,bit);
              }
            }
          }
          const previous=stamp?.wordPairs??EMPTY_WORD_PAIRS;
          // A lower bound avoids a second bit-difference walk just to choose the
          // algorithm. Disjoint source disks have no common cell centers.
          const previousCells=stamp?.cellCount??0;
          const disjoint=stamp&&(stamp.xMm-source.xMm)**2+(stamp.zMm-source.zMm)**2>(stamp.radius+radius)**2;
          minimumChangedCells+=disjoint?previousCells+cellCount:Math.abs(previousCells-cellCount);
          groupMask.contributions+=cellCount-previousCells;
          stamp={xMm:source.xMm,zMm:source.zMm,radius:source.radius,wordPairs:Uint32Array.from(wordPairs),cellCount,...(coverage?{coverage}:{})};
          changes.push({previous,next:stamp.wordPairs});
          stamps.set(source.id,stamp);
        }else if(coverage)stamp.coverage=coverage;else delete stamp.coverage;
      }
      for(const [id,stamp]of stamps)if(!live.has(id)){changes.push({previous:stamp.wordPairs,next:EMPTY_WORD_PAIRS});minimumChangedCells+=stamp.cellCount;groupMask.contributions-=stamp.cellCount;stamps.delete(id);}
      // Dense removals, radius changes or disjoint movement can cost more than
      // rebuilding all surviving contributions. Include every cleared array cell
      // in the bound; ordinary overlapping movement keeps the sparse delta path.
      const rebuildCells=groupMask.contributions+groupMask.counts.length+groupMask.mask.length+groupMask.words.length;
      if(minimumChangedCells>rebuildCells)this.rebuildGroup(groupMask,stamps.values());
      else for(const change of changes)this.updateSource(groupMask,change.previous,change.next);
      const {words}=groupMask;
      let same=!!groupMask.published;
      if(same&&(rebuilt||changes.length)){
        const prior=groupMask.publishedWords!;
        if(prior.length!==words.length)same=false;
        else if(rebuilt){for(let word=0;word<words.length;word++)if(prior[word]!==words[word]){same=false;groupMask.changedWords.add(word);}}
        else for(const word of groupMask.changedWords)if(prior[word]!==words[word]){same=false;break;}
      }
      if(!same){
        const visible:number[]=[];
        for(let word=0;word<words.length;word++){
          let bits=words[word]!;
          while(bits){visible.push(word*32+31-Math.clz32(bits&-bits));bits&=bits-1;}
        }
        Object.freeze(visible);
        const previous=groupMask.published?.mask;
        groupMask.published=Object.freeze({key:group.key,mask:groupMask.mask.slice(),visible});
        if(previous&&previous.length===groupMask.published.mask.length)maskChanges.set(groupMask.published.mask,{previous:new WeakRef(previous),words:Object.freeze([...groupMask.changedWords].sort((a,b)=>a-b))});
        groupMask.publishedWords=words.slice();
      }
      if(immutable)groupMask.sources=group;
      results.push(groupMask.published!);
    }
    for(const key of this.stamps.keys())if(!activeGroups.has(key)){this.stamps.delete(key);this.masks.delete(key);}
    return results;
  }
}
