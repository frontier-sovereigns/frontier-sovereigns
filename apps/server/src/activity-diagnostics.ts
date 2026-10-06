import { balance, type CommittedUnitActionKind, type ResourceBank, type SimulationActivityWindow } from '@frontier/shared';

interface ActivityState {
  matchId:string;matchEpoch:number;tick:number;
  factions:readonly {id:string}[];
  economies:Record<string,{collected:ResourceBank}>;
  entities:Record<string,{id:string;kind:string;ownerId:string|null;hp:number}>;
}
interface ActivityAction {id:string;playerId:string;kind:CommittedUnitActionKind}
interface FrameActivity {fromTick:number;toTick:number;actions:readonly (ActivityAction&{ticks:number})[]}
const resources=['food','wood','gold','stone'] as const;
const emptyBank=():ResourceBank=>({food:0,wood:0,gold:0,stone:0});

/** One bounded 60-second accumulator and one completed result; no saved/game state. */
export class ActivityDiagnostics {
  private matchId='';
  private epoch=-1;
  private fromTick=0;
  private lastTick=0;
  private active=new Map<string,Set<string>>();
  private counts=new Map<string,SimulationActivityWindow['actionTicks']>();
  private collected=new Map<string,ResourceBank>();
  private last?:SimulationActivityWindow;
  private readonly windowTicks=60*balance.rules.simulationHz;

  private begin(state:ActivityState):void {
    this.fromTick=this.lastTick=state.tick;this.active.clear();this.counts.clear();this.collected.clear();
    for(const {id}of state.factions){this.active.set(id,new Set());this.counts.set(id,{});this.collected.set(id,{...state.economies[id]!.collected});}
  }
  /** Call before stepping and on diagnostic reads, so rollback/epoch gaps never combine. */
  synchronize(state:ActivityState):void {
    if(state.matchId!==this.matchId||state.matchEpoch!==this.epoch||state.tick!==this.lastTick){
      this.matchId=state.matchId;this.epoch=state.matchEpoch;this.last=undefined;this.begin(state);
    }
  }
  /** Call exactly after each committed step. Repeated observations are harmless. */
  observe(state:ActivityState,actions:readonly ActivityAction[]):void {
    this.observeFrame(state,{fromTick:state.tick-1,toTick:state.tick,actions:actions.map(action=>({...action,ticks:1}))});
  }
  /** Receives actual per-unit/action counts across one committed frame. Missing
   * frames invalidate coverage; idle time or a retained pose earns no credit. */
  observeFrame(state:ActivityState,frame:FrameActivity):void {
    if(state.matchId===this.matchId&&state.matchEpoch===this.epoch&&state.tick===this.lastTick)return;
    const span=frame.toTick-frame.fromTick;
    if(state.matchId!==this.matchId||state.matchEpoch!==this.epoch||frame.fromTick!==this.lastTick||frame.toTick!==state.tick||!Number.isSafeInteger(span)||span<1||span>6||state.tick-this.fromTick>this.windowTicks||frame.actions.some(action=>!Number.isSafeInteger(action.ticks)||action.ticks<1||action.ticks>span)){
      if(state.matchId===this.matchId&&state.matchEpoch===this.epoch&&state.tick===this.lastTick)return;
      this.synchronize(state);return;
    }
    this.lastTick=state.tick;
    for(const action of frame.actions){const active=this.active.get(action.playerId),counts=this.counts.get(action.playerId);if(!active||!counts)continue;active.add(action.id);counts[action.kind]=(counts[action.kind]??0)+action.ticks;}
    if(state.tick-this.fromTick!==this.windowTicks)return;
    const survivors=new Map(state.factions.map(faction=>[faction.id,{total:0,active:0}]));
    for(const entity of Object.values(state.entities))if(entity.kind==='unit'&&entity.hp>0&&entity.ownerId){const count=survivors.get(entity.ownerId);if(count){count.total++;if(this.active.get(entity.ownerId)!.has(entity.id))count.active++;}}
    const actionTicks:SimulationActivityWindow['actionTicks']={};
    const factions=state.factions.map(({id})=>{
      const counts=this.counts.get(id)!,depositedMilli=emptyBank(),before=this.collected.get(id)!;
      for(const resource of resources)depositedMilli[resource]=state.economies[id]!.collected[resource]-before[resource];
      for(const [kind,count]of Object.entries(counts))actionTicks[kind as CommittedUnitActionKind]=(actionTicks[kind as CommittedUnitActionKind]??0)+count;
      const surviving=survivors.get(id)!;
      return {playerId:id,uniqueActiveUnits:this.active.get(id)!.size,activeSurvivingUnits:surviving.active,survivingUnits:surviving.total,actionTicks:{...counts},depositedMilli};
    });
    this.last={matchId:this.matchId,matchEpoch:this.epoch,fromTick:this.fromTick,toTick:state.tick,actionTicks,factions};this.begin(state);
  }
  snapshot(state:ActivityState):SimulationActivityWindow|undefined {
    this.synchronize(state);return this.last?structuredClone(this.last):undefined;
  }
}
