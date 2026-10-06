import { balance, units, type Position, type VisualAction } from '@frontier/shared';
import type { Entity, SimulationState } from './state.js';

export type CommittedAction=Pick<VisualAction,'kind'|'durationTicks'|'facingMilliRad'>&{recipients?:string[]};
export interface ObservationUnitCells {ranges:Int32Array;cells:number[]}
/** Synchronous-phase geometry only. Recipient masks and visibility answers are
 * never retained; the regular membership cache already owns the normal path. */
export function observationUnitCells(actors:readonly Entity[],widthMm:number,heightMm:number):ObservationUnitCells {
  const ranges=new Int32Array(actors.length*2),cells:number[]=[],grid=balance.rules.fogGridM*1000,width=Math.floor(widthMm/grid),height=Math.floor(heightMm/grid);
  const dimensions=Number.isSafeInteger(width)&&Number.isSafeInteger(height)&&width>0&&height>0&&width*height<=0x7fffffff;
  for(let index=0;index<actors.length;index++){
    const entity=actors[index]!;if(entity.kind!=='unit')continue;
    const offset=index*2;ranges[offset]=-1;
    const definition=units[entity.typeId],radius=definition?definition.collisionRadiusM*1000:NaN;
    if(!dimensions||!Number.isFinite(entity.xMm)||!Number.isFinite(entity.zMm)||!Number.isFinite(radius)||radius<0||radius>grid)continue;
    const center=Math.floor(entity.zMm/grid)*width+Math.floor(entity.xMm/grid);if(!Number.isSafeInteger(center))continue;
    ranges[offset]=cells.length;
    // Preserve the original unbounded center-first linear index, including aliases.
    cells.push(center);
    for(let z=Math.max(0,Math.floor((entity.zMm-radius)/grid));z<=Math.min(height-1,Math.floor((entity.zMm+radius)/grid));z++)for(let x=Math.max(0,Math.floor((entity.xMm-radius)/grid));x<=Math.min(width-1,Math.floor((entity.xMm+radius)/grid));x++){
      const dx=Math.max(x*grid-entity.xMm,0,entity.xMm-(x+1)*grid),dz=Math.max(z*grid-entity.zMm,0,entity.zMm-(z+1)*grid);
      if(dx*dx+dz*dz<=radius*radius)cells.push(z*width+x);
    }
    ranges[offset+1]=cells.length;
  }
  return {ranges,cells};
}
export function visibleObservedUnit(entity:Entity,index:number,geometry:ObservationUnitCells,mask:Uint8Array|undefined,fallback:()=>boolean):boolean {
  if(entity.kind!=='unit'||geometry.ranges[index*2]===-1)return fallback();
  if(entity.garrisonedIn||!mask)return false;
  for(let offset=geometry.ranges[index*2]!;offset<geometry.ranges[index*2+1]!;offset++)if(mask[geometry.cells[offset]!])return true;
  return false;
}
/** Quantized actual work/launch orientation: 0 points +Z, +1571 points +X. */
export function committedFacing(from:Position,to:Position):Pick<VisualAction,'facingMilliRad'>{
  return from.xMm===to.xMm&&from.zMm===to.zMm?{}:{facingMilliRad:Math.round(Math.atan2(to.xMm-from.xMm,to.zMm-from.zMm)*1000)};
}
/** Tick-local committed work, never orders or hidden history. Visibility receives the ordinal in the non-resource roster. */
export function updateObservedActions(state:SimulationState,committed:ReadonlyMap<string,CommittedAction>,visible:(playerId:string,entity:Entity,actorIndex:number)=>boolean,world:readonly Entity[]=Object.values(state.entities)):void {
  const entities=world.filter(entity=>entity.kind!=='resource');
  for(const faction of state.factions){
    const vision=state.vision[faction.id]!,prior=vision.actions,next:typeof prior={};
    for(let index=0;index<entities.length;index++){
      const entity=entities[index]!;
      if(entity.ownerId!==faction.id&&(!visible(faction.id,entity,index)||entity.kind==='unit'&&entity.garrisonedIn))continue;
      const occurrence=committed.get(entity.id),action=occurrence&&(!occurrence.recipients||occurrence.recipients.includes(faction.id))?occurrence:undefined,previous=prior[entity.id];
      const kind=action?.kind??(entity.kind==='unit'&&entity.cargo.amount>0?'carry':'idle');
      let observation:VisualAction;
      const facing=action?.facingMilliRad===undefined?{}:{facingMilliRad:action.facingMilliRad};
      if(action?.kind==='attack')observation={kind:'attack',startedTick:state.tick,durationTicks:action.durationTicks!,...facing};
      else if(!action&&previous?.kind==='attack'&&state.tick<previous.startedTick+previous.durationTicks!)observation=previous;
      else observation=previous?.kind===kind?(action?.facingMilliRad===undefined||previous.facingMilliRad===action.facingMilliRad?previous:{...previous,...facing}):{kind,startedTick:state.tick,...facing};
      next[entity.id]=observation;
      // Static ghost snapshots freeze the last actual authorized pose.
      if(vision.memory[entity.id]&&(entity.ownerId!==faction.id||visible(faction.id,entity,index)))vision.memory[entity.id]!.visualAction={...observation};
    }
    vision.actions=next;
  }
}

const sameAction=(a:VisualAction|undefined,b:VisualAction|undefined):boolean=>a===b||Boolean(a&&b&&a.kind===b.kind&&a.startedTick===b.startedTick&&a.durationTicks===b.durationTicks&&a.facingMilliRad===b.facingMilliRad);
interface ActionEntry {observation:VisualAction;kind:VisualAction['kind']|undefined;duration:number|undefined;facing:number|undefined;carry:boolean;priorKind:VisualAction['kind'];started:number;observedDuration:number|undefined;observedFacing:number|undefined;refreshAt:number}
interface OwnedActions {state:SimulationState;epoch:number;vision:SimulationState['vision'][string];actors:readonly Entity[];actions:SimulationState['vision'][string]['actions']}
/** Derived dirty actor records. Scalar updateObservedActions remains the cold
 * oracle; authoritative clocks/poses retain exactly its ordering and semantics. */
export class ObservedActionCache {
  private entries=new Map<string,Map<string,ActionEntry>>();
  private changed=0;
  private reused=0;
  private owned=new Map<string,OwnedActions>();
  update(state:SimulationState,committed:ReadonlyMap<string,CommittedAction>,actors:(playerId:string)=>readonly Entity[],visible:(playerId:string,entity:Entity)=>boolean):void{
    this.owned.clear();this.apply(state,committed,actors,visible,false);
  }
  /** Exclusive simulation-owner path. Roster identity certifies exact authorized
   * membership/order; live actions, cargo, attack expiry and ghost poses still
   * update every contact slice. Mutable public callers keep update() above. */
  updateOwned(state:SimulationState,committed:ReadonlyMap<string,CommittedAction>,actors:(playerId:string)=>readonly Entity[],visible:(playerId:string,entity:Entity)=>boolean):void{
    try{this.apply(state,committed,actors,visible,true);}catch(error){this.owned.clear();throw error;}
  }
  private apply(state:SimulationState,committed:ReadonlyMap<string,CommittedAction>,actors:(playerId:string)=>readonly Entity[],visible:(playerId:string,entity:Entity)=>boolean,owned:boolean):void{
    const retained=new Set<string>();
    for(const faction of state.factions){
      retained.add(faction.id);let cache=this.entries.get(faction.id);if(!cache){cache=new Map();this.entries.set(faction.id,cache);}
      const vision=state.vision[faction.id]!,prior=vision.actions,roster=actors(faction.id),proof=owned?this.owned.get(faction.id):undefined;
      const retain=Boolean(proof&&proof.state===state&&proof.epoch===state.matchEpoch&&proof.vision===vision&&proof.actors===roster&&proof.actions===prior),next:typeof prior=retain?prior:{};
      for(const entity of roster){
        const occurrence=committed.get(entity.id),action=occurrence&&(!occurrence.recipients||occurrence.recipients.includes(faction.id))?occurrence:undefined,previous=prior[entity.id],carry=entity.kind==='unit'&&entity.cargo.amount>0,entry=cache.get(entity.id);
        let observation:VisualAction;
        if(entry&&previous===entry.observation&&previous.kind===entry.priorKind&&previous.startedTick===entry.started&&previous.durationTicks===entry.observedDuration&&previous.facingMilliRad===entry.observedFacing
          &&entry.kind===action?.kind&&entry.duration===action?.durationTicks&&entry.facing===action?.facingMilliRad&&entry.carry===carry&&state.tick<entry.refreshAt){observation=previous;this.reused++;}
        else{
          this.changed++;const kind=action?.kind??(carry?'carry':'idle'),facing=action?.facingMilliRad===undefined?{}:{facingMilliRad:action.facingMilliRad};
          if(action?.kind==='attack')observation={kind:'attack',startedTick:state.tick,durationTicks:action.durationTicks!,...facing};
          else if(!action&&previous?.kind==='attack'&&state.tick<previous.startedTick+previous.durationTicks!)observation=previous;
          else observation=previous?.kind===kind?(action?.facingMilliRad===undefined||previous.facingMilliRad===action.facingMilliRad?previous:{...previous,...facing}):{kind,startedTick:state.tick,...facing};
          cache.set(entity.id,{observation,kind:action?.kind,duration:action?.durationTicks,facing:action?.facingMilliRad,carry,priorKind:observation.kind,started:observation.startedTick,observedDuration:observation.durationTicks,observedFacing:observation.facingMilliRad,refreshAt:action?.kind==='attack'?state.tick+1:!action&&observation.kind==='attack'?observation.startedTick+observation.durationTicks!:Infinity});
        }
        if(!retain||previous!==observation)next[entity.id]=observation;
        const memory=vision.memory[entity.id];if(memory&&(entity.ownerId!==faction.id||visible(faction.id,entity))&&!sameAction(memory.visualAction,observation))memory.visualAction={...observation};
      }
      if(!retain){for(const id of cache.keys())if(!Object.hasOwn(next,id))cache.delete(id);vision.actions=next;}
      if(owned)this.owned.set(faction.id,{state,epoch:state.matchEpoch,vision,actors:roster,actions:next});
    }
    for(const id of this.entries.keys())if(!retained.has(id))this.entries.delete(id);
    for(const id of this.owned.keys())if(!retained.has(id))this.owned.delete(id);
  }
  inventory(){return {actors:[...this.entries.values()].reduce((count,entries)=>count+entries.size,0),changed:this.changed,reused:this.reused};}
}
