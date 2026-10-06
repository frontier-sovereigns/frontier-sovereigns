import type { ClientCommandEnvelope, CommandReceipt, PlayerView, ViewEntity } from '@frontier/shared';
import type { Scene } from '@babylonjs/core/scene';

type Boundary = Pick<PlayerView,'matchId'|'matchEpoch'|'playerId'>;
type DeliveryTiming = 'messageGap'|'completeViewGap'|'advancingViewGap'|'parseAndValidation'|'worldApply'|'applyToRender'|'monitorLateness';
/** Always-on numeric evidence only. No entities, commands, chat or server secrets
 * are retained or uploaded. A finished match's bounded history survives in this tab. */
export class BrowserDeliveryDiagnostics {
  private identity?:Boundary;
  private lastMessage?:number;
  private lastComplete?:number;
  private lastAdvance?:number;
  private lastMonitor?:number;
  private tick?:number;
  private pendingRender?:{sequence:number;atMs:number};
  private delayed=false;
  private metrics:Partial<Record<DeliveryTiming,{samples:number;latestMs:number;maxMs:number}>>={};
  private gaps:Array<{at:string;tick:number;thresholdMs:number;completeViewAgeMs:number;advancingViewAgeMs:number|null;messageAgeMs:number|null;monitorLatenessMs:number;hidden:boolean}>=[];
  private episodes=0;
  constructor(private readonly now=()=>performance.now(),private readonly wall=()=>Date.now()){}
  private record(key:DeliveryTiming,value:number):void{
    if(!Number.isFinite(value)||value<0)return;
    const prior=this.metrics[key];this.metrics[key]={samples:Math.min(Number.MAX_SAFE_INTEGER,(prior?.samples??0)+1),latestMs:value,maxMs:Math.max(prior?.maxMs??0,value)};
  }
  boundary():void{this.identity=undefined;this.lastMessage=undefined;this.lastComplete=undefined;this.lastAdvance=undefined;this.lastMonitor=undefined;this.tick=undefined;this.pendingRender=undefined;this.delayed=false;}
  message(atMs=this.now()):void{if(this.lastMessage!==undefined)this.record('messageGap',atMs-this.lastMessage);this.lastMessage=atMs;}
  validated(durationMs:number):void{this.record('parseAndValidation',durationMs);}
  applied(view:PlayerView,applyStartedMs:number):void{
    const atMs=this.now();
    if(this.identity&&!sameBoundary(this.identity,view))this.boundary();
    this.record('worldApply',atMs-applyStartedMs);
    if(view.status!=='RUNNING'){this.boundary();return;}
    this.identity={matchId:view.matchId,matchEpoch:view.matchEpoch,playerId:view.playerId};
    // Validation completed before World.setView started. Use that same boundary
    // as the connection warning, so expensive world application stays visible.
    if(this.lastComplete!==undefined)this.record('completeViewGap',applyStartedMs-this.lastComplete);
    this.lastComplete=applyStartedMs;this.delayed=false;
    if(this.tick===undefined||view.tick>this.tick){if(this.lastAdvance!==undefined)this.record('advancingViewGap',applyStartedMs-this.lastAdvance);this.lastAdvance=applyStartedMs;this.tick=view.tick;}
    // Keep the oldest unrendered view until a subsequent completed draw covers it.
    this.pendingRender??={sequence:view.sequence,atMs};
  }
  rendered(view:PlayerView):void{
    if(this.pendingRender&&this.identity&&sameBoundary(this.identity,view)&&view.sequence>=this.pendingRender.sequence){this.record('applyToRender',this.now()-this.pendingRender.atMs);this.pendingRender=undefined;}
  }
  poll(thresholdMs:number,hidden:boolean):void{
    const now=this.now(),late=this.lastMonitor===undefined?0:Math.max(0,now-this.lastMonitor-250);this.lastMonitor=now;this.record('monitorLateness',late);
    if(this.lastComplete===undefined||now-this.lastComplete<=thresholdMs||this.delayed)return;
    this.delayed=true;this.episodes++;
    this.gaps.push({at:new Date(this.wall()).toISOString(),tick:this.tick!,thresholdMs,completeViewAgeMs:now-this.lastComplete,advancingViewAgeMs:this.lastAdvance===undefined?null:now-this.lastAdvance,messageAgeMs:this.lastMessage===undefined?null:now-this.lastMessage,monitorLatenessMs:late,hidden});
    if(this.gaps.length>32)this.gaps.shift();
  }
  report(){return {scope:'this-browser-tab',clock:'durations: performance.now; episode dates: local browser wall clock',renderBoundary:'Babylon after-render; not GPU completion or display scanout',episodes:this.episodes,metrics:structuredClone(this.metrics),recentGaps:this.gaps.map(row=>({...row}))};}
}
export const browserDeliveryDiagnostics=new BrowserDeliveryDiagnostics();
type Outcome = 'pending'|'rendered'|'rejected'|'cancelled'|'timed-out'|'boundary-censored'|'ineligible'|'overflow';
/** Only own objects actually submitted by AssetRenderer belong in this list. */
export interface ResponseRenderEntity {id:string;xMm:number;zMm:number;clip:string;gatePose?:number}
interface UnitProbe {
  id:string;xMm:number;zMm:number;gate:boolean;
  receivedAtMs?:number;appliedAtMs?:number;actionTick?:number;actionSequence?:number;actionKind?:string;
  firstMotionAtMs?:number;renderedAtMs?:number;blocked?:string;
}
interface Observation {tick:number;sequence:number;watermark:number;receivedAtMs:number;appliedAtMs:number;entities:ViewEntity[];rendered?:Array<ResponseRenderEntity&{atMs:number}>}
interface Row extends Boundary {
  commandId:string;clientSequence:number;kind:string;case:string;issuedAtMs:number;issuedTick:number;
  outcome:Outcome;reason?:string;gatewayReceivedAtMs?:number;receipt?:{status:CommandReceipt['status'];code?:string;tick:number;sequence:number;atMs:number};
  requested:number;eligible:number;excluded:Record<string,number>;units:UnitProbe[];
  affected:string[];replaces:boolean;observations:Observation[];
}
const sameBoundary=(a:Boundary,b:Boundary)=>a.matchId===b.matchId&&a.matchEpoch===b.matchEpoch&&a.playerId===b.playerId;
const distance=(a:{xMm:number;zMm:number},b:{xMm:number;zMm:number})=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const ownLive=(entity:ViewEntity,playerId:string)=>entity.ownerId===playerId&&!entity.ghost&&entity.hp>0;
const copyEvidence=(entity:ViewEntity):ViewEntity=>({id:entity.id,kind:entity.kind,typeId:entity.typeId,ownerId:entity.ownerId,xMm:entity.xMm,zMm:entity.zMm,hp:entity.hp,maxHp:entity.maxHp,
  ...(entity.order===undefined?{}:{order:entity.order}),...(entity.taskState===undefined?{}:{taskState:entity.taskState}),...(entity.blockedReason===undefined?{}:{blockedReason:entity.blockedReason}),
  ...(entity.garrisonedIn===undefined?{}:{garrisonedIn:entity.garrisonedIn}),...(entity.visualAction?{visualAction:{...entity.visualAction}}:{}),...(entity.gateMode?{gateMode:entity.gateMode}:{}),...(entity.gateOpen===undefined?{}:{gateOpen:entity.gateOpen})});

/** Opt-in evidence, never command authority. All timestamps share one browser
 * performance clock. Accepted idle commands are matched conservatively using
 * existing own-order/action clocks and the command watermark, not enemy state. */
export class BrowserResponseDiagnostics {
  private active=new Map<string,Row>();
  private history:Row[]=[];
  private lastRendered?:Boundary&{sequence:number;atMs:number;entities:Map<string,ResponseRenderEntity>};
  private identity?:Boundary;
  private nextCase?:string;
  private totals={issued:0,eligible:0,gatewayReceived:0,accepted:0,rejected:0,acted:0,applied:0,appliedUnits:0,firstMotion:0,rendered:0,renderedUnits:0,cancelled:0,timedOut:0,boundaryCensored:0,ineligible:0,overflow:0,historyOmitted:0,lateOrUnknownReceipts:0,observedBlockedUnits:0};
  constructor(private readonly now:()=>number=()=>performance.now(),readonly timeoutMs=10000){if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error('INVALID_RESPONSE_TIMEOUT');}
  labelNext(label:string):void{if(!/^[a-z0-9][a-z0-9 _-]{0,47}$/i.test(label))throw new Error('INVALID_RESPONSE_LABEL');this.nextCase=label;}
  private finish(row:Row,outcome:Exclude<Outcome,'pending'>,reason?:string):void{
    if(row.outcome!=='pending')return;row.outcome=outcome;row.reason=reason;row.observations=[];this.active.delete(row.commandId);
    const key={rendered:'rendered',rejected:'rejected',cancelled:'cancelled','timed-out':'timedOut','boundary-censored':'boundaryCensored',ineligible:'ineligible',overflow:'overflow'} as const;
    // Rejected totals count receipts, including those received after censorship.
    if(outcome!=='rejected')this.totals[key[outcome]]++;
    this.history.push(row);if(this.history.length>256){this.history.shift();this.totals.historyOmitted++;}
  }
  boundary(reason:string):void{for(const row of [...this.active.values()])this.finish(row,'boundary-censored',reason);this.lastRendered=undefined;this.identity=undefined;}
  poll():void{const now=this.now();for(const row of [...this.active.values()])if(now-row.issuedAtMs>=this.timeoutMs)this.finish(row,'timed-out','deadline-without-complete-rendered-coverage');}
  issue(envelope:ClientCommandEnvelope,view:PlayerView):void{
    this.poll();if(this.identity&&!sameBoundary(this.identity,view))this.boundary('recipient-or-epoch-change');this.identity={matchId:view.matchId,matchEpoch:view.matchEpoch,playerId:view.playerId};
    const command=envelope.command,ids='unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:command.kind==='set_gate_mode'?[command.gateId]:[];
    const own=new Map(view.entities.filter(entity=>ownLive(entity,view.playerId)).map(entity=>[entity.id,entity]));
    const gate=command.kind==='set_gate_mode'&&command.mode==='OPEN',supported=gate||command.kind==='move'||command.kind==='attack_move'||command.kind==='gather';
    const row:Row={...this.identity,commandId:envelope.clientCommandId,clientSequence:envelope.clientSequence,kind:command.kind,case:this.nextCase??(gate?'gate-opening':`${command.kind}${ids.length>1?'-group':''}`),issuedAtMs:this.now(),issuedTick:view.tick,outcome:'pending',requested:ids.length,eligible:0,excluded:{},units:[],affected:ids.filter(id=>own.has(id)).slice(0,200),replaces:command.kind==='set_gate_mode'||command.kind!=='set_stance'&&command.kind!=='ungarrison'&&(!('queued'in command)||!command.queued),observations:[]};
    this.nextCase=undefined;this.totals.issued++;
    if(this.active.size>=64){this.finish(row,'overflow','active-command-capacity');return;}
    const exclude=(reason:string)=>{row.excluded[reason]=(row.excluded[reason]??0)+1;};
    if(!supported||'queued'in command&&command.queued||ids.length>200)exclude(!supported?'unsupported-command':ids.length>200?'group-limit':'queued-order');
    else for(const id of ids){
      const entity=own.get(id),rendered=this.lastRendered?.entities.get(id);
      if(!entity){exclude('not-live-own-object');continue;}
      if([...this.active.values()].some(prior=>prior.affected.includes(id))){exclude('earlier-command-pending');continue;}
      if(!this.lastRendered||!sameBoundary(this.lastRendered,view)||this.lastRendered.sequence!==view.sequence||this.now()-this.lastRendered.atMs>250||!rendered||distance(entity,rendered)>1){exclude('no-current-rendered-idle-baseline');continue;}
      if(gate){if(entity.kind!=='building'||!entity.typeId.endsWith('_gate')||entity.gateMode!=='LOCKED'||entity.gateOpen!==false||(entity.progress??1)<1||(rendered.gatePose??1)>0){exclude('gate-not-locked-and-closed');continue;}}
      else if(entity.kind!=='unit'||entity.garrisonedIn||entity.order!=='idle'||entity.taskState!=='idle'||entity.visualAction?.kind!=='idle'||(entity.queuedOrderCount??0)!==0||rendered.clip!=='idle'||command.kind==='gather'&&(entity.cargo?.amount??0)>0){exclude('prior-order-or-action');continue;}
      row.units.push({id,xMm:entity.xMm,zMm:entity.zMm,gate});
    }
    row.eligible=row.units.length;if(row.eligible)this.totals.eligible++;this.active.set(row.commandId,row);
  }
  gatewayReceived(commandId:string,sequence:number,receivedAtMs=this.now()):void {
    const row=this.active.get(commandId);
    if(!row||row.clientSequence!==sequence||row.gatewayReceivedAtMs!==undefined||row.receipt)return;
    row.gatewayReceivedAtMs=receivedAtMs;this.totals.gatewayReceived++;
  }
  receipt(receipt:CommandReceipt,receivedAtMs=this.now()):void{
    this.poll();const row=this.active.get(receipt.clientCommandId)??this.history.find(row=>row.commandId===receipt.clientCommandId);
    if(!row){this.totals.lateOrUnknownReceipts++;return;}if(row.receipt)return;
    row.receipt={status:receipt.status,code:receipt.code,tick:receipt.tick,sequence:receipt.sequence,atMs:receivedAtMs};
    if(receipt.status==='rejected'){this.totals.rejected++;this.finish(row,'rejected',receipt.code);return;}
    this.totals.accepted++;
    if(row.replaces)for(const prior of [...this.active.values()])if(prior!==row&&sameBoundary(prior,row)&&prior.clientSequence<row.clientSequence&&prior.units.some(unit=>row.affected.includes(unit.id)))this.finish(prior,'cancelled','accepted-replacement-command');
    if(row.outcome!=='pending')return;
    if(receipt.sequence!==row.clientSequence){this.finish(row,'boundary-censored','receipt-sequence-mismatch');return;}
    if(!row.eligible){this.finish(row,'ineligible','no-attributable-own-action');return;}
    const pending=row.observations;row.observations=[];for(const observation of pending){this.observe(row,observation);for(const rendered of observation.rendered??[])this.creditRender(row,observation.sequence,observation.watermark,new Map([[rendered.id,rendered]]),rendered.atMs);}
  }
  /** Called only after a complete recipient view has passed ViewStream validation
   * and World.setView. receivedAtMs is the final contributing WS message's arrival. */
  applied(view:PlayerView,receivedAtMs:number):void{
    this.poll();if(this.identity&&!sameBoundary(this.identity,view))this.boundary('recipient-or-epoch-change');
    this.identity={matchId:view.matchId,matchEpoch:view.matchEpoch,playerId:view.playerId};
    if(view.status!=='RUNNING'){this.boundary(`status-${view.status.toLowerCase()}`);return;}
    const appliedAtMs=this.now(),own=new Map(view.entities.filter(entity=>ownLive(entity,view.playerId)).map(entity=>[entity.id,entity]));
    for(const row of [...this.active.values()]){
      if(!sameBoundary(row,view))continue;
      const observation:Observation={tick:view.tick,sequence:view.sequence,watermark:view.self.lastCommandSequence,receivedAtMs,appliedAtMs,entities:row.units.flatMap(unit=>{const entity=own.get(unit.id);return entity?[copyEvidence(entity)]:[];})};
      if(!row.receipt){if(row.observations.length===4){this.finish(row,'boundary-censored','pre-receipt-observation-overflow');continue;}row.observations.push(observation);}else this.observe(row,observation);
    }
  }
  private observe(row:Row,view:Observation):void{
    if(row.outcome!=='pending'||row.receipt?.status!=='accepted'||view.tick<=row.receipt.tick||view.watermark<row.clientSequence)return;
    if(view.watermark!==row.clientSequence){this.finish(row,'boundary-censored','later-command-watermark');return;}
    for(const unit of row.units){
      const entity=view.entities.find(entity=>entity.id===unit.id);
      if(!entity||entity.garrisonedIn){this.finish(row,'boundary-censored','own-object-unavailable');return;}
      if(entity.blockedReason&&!unit.blocked){unit.blocked=entity.blockedReason;this.totals.observedBlockedUnits++;}
      if(unit.gate){if(entity.gateMode!=='OPEN'){this.finish(row,'boundary-censored','gate-mode-no-longer-matches');return;}if(!entity.gateOpen)continue;}
      else{
        if(entity.order!==row.kind){this.finish(row,'boundary-censored','own-order-no-longer-matches');return;}
        const action=entity.visualAction;
        if(!action||action.startedTick<=row.receipt.tick)continue; // Existing movement cannot prove this command acted.
        const movement=action.kind==='move'||action.kind==='carry';
        const gathering=row.kind==='gather'&&['gather_food','gather_wood','mine'].includes(action.kind);
        if(!gathering&&!(movement&&distance(unit,entity)>1))continue;
        if(movement&&unit.firstMotionAtMs===undefined){if(!row.units.some(unit=>unit.firstMotionAtMs!==undefined))this.totals.firstMotion++;unit.firstMotionAtMs=view.appliedAtMs;}
      }
      if(unit.appliedAtMs===undefined){if(!row.units.some(unit=>unit.appliedAtMs!==undefined)){this.totals.acted++;this.totals.applied++;}this.totals.appliedUnits++;unit.receivedAtMs=view.receivedAtMs;unit.appliedAtMs=view.appliedAtMs;unit.actionTick=view.tick;unit.actionSequence=view.sequence;unit.actionKind=unit.gate?'gate_open':entity.visualAction!.kind;}
    }
  }
  /** Called after Babylon's after-render observable, never at RAF scheduling or
   * authoritative receipt. Submitted geometry is not a GPU fence/scanout proof. */
  rendered(view:PlayerView,entities:readonly ResponseRenderEntity[]):void{
    this.poll();const atMs=this.now(),ownIds=new Set(view.entities.filter(entity=>ownLive(entity,view.playerId)).map(entity=>entity.id));
    const submitted=new Map(entities.filter(entity=>ownIds.has(entity.id)).slice(0,400).map(entity=>[entity.id,{...entity}]));
    this.lastRendered={matchId:view.matchId,matchEpoch:view.matchEpoch,playerId:view.playerId,sequence:view.sequence,atMs,entities:submitted};
    for(const row of [...this.active.values()]){
      if(!sameBoundary(row,view))continue;
      if(!row.receipt){
        const observation=row.observations.find(observation=>observation.sequence===view.sequence);
        if(observation)for(const unit of row.units){
          if(observation.rendered?.some(rendered=>rendered.id===unit.id))continue;
          const entity=observation.entities.find(entity=>entity.id===unit.id),visible=submitted.get(unit.id),kind=unit.gate?'gate_open':entity?.visualAction?.kind;
          if(visible&&kind&&this.matchesRender(unit,visible,kind))(observation.rendered??=[]).push({...visible,atMs});
        }
      }else this.creditRender(row,view.sequence,view.self.lastCommandSequence,submitted,atMs);
    }
  }
  private matchesRender(unit:UnitProbe,visible:ResponseRenderEntity,kind:string):boolean{return visible.clip===kind&&(unit.gate?(visible.gatePose??0)>0:!['move','carry'].includes(kind)||distance(visible,unit)>1);}
  private creditRender(row:Row,sequence:number,watermark:number,submitted:Map<string,ResponseRenderEntity>,atMs:number):void{
    if(row.outcome!=='pending'||row.receipt?.status!=='accepted'||watermark!==row.clientSequence)return;
    for(const unit of row.units){
      if(unit.appliedAtMs===undefined||unit.renderedAtMs!==undefined||sequence<unit.actionSequence!)continue;
      const visible=submitted.get(unit.id);if(!visible||!this.matchesRender(unit,visible,unit.actionKind!))continue;
      unit.renderedAtMs=atMs;this.totals.renderedUnits++;
    }
    if(row.units.length&&row.units.every(unit=>unit.renderedAtMs!==undefined))this.finish(row,'rendered');
  }
  report(){
    this.poll();const rows=[...this.history,...this.active.values()].map(({observations:_observations,affected:_affected,replaces:_replaces,...row})=>structuredClone(row));
    const first=(values:(number|undefined)[])=>{const known=values.filter((value):value is number=>value!==undefined);return known.length?Math.min(...known):undefined;};
    const samples=rows.map(row=>({commandId:row.commandId,case:row.case,outcome:row.outcome,requested:row.requested,eligible:row.eligible,applied:row.units.filter(unit=>unit.appliedAtMs!==undefined).length,rendered:row.units.filter(unit=>unit.renderedAtMs!==undefined).length,
      gatewayReceivedMs:row.gatewayReceivedAtMs===undefined?undefined:row.gatewayReceivedAtMs-row.issuedAtMs,authoritativeDecisionMs:row.receipt===undefined?undefined:row.receipt.atMs-row.issuedAtMs,
      firstReceivedMs:first(row.units.map(unit=>unit.receivedAtMs===undefined?undefined:unit.receivedAtMs-row.issuedAtMs)),firstAppliedMs:first(row.units.map(unit=>unit.appliedAtMs===undefined?undefined:unit.appliedAtMs-row.issuedAtMs)),firstMotionMs:first(row.units.map(unit=>unit.firstMotionAtMs===undefined?undefined:unit.firstMotionAtMs-row.issuedAtMs)),firstRenderedMs:first(row.units.map(unit=>unit.renderedAtMs===undefined?undefined:unit.renderedAtMs-row.issuedAtMs)),completeRenderedMs:row.outcome==='rendered'?Math.max(...row.units.map(unit=>unit.renderedAtMs!-row.issuedAtMs)):undefined}));
    return {version:1,clock:'browser performance.now',timingQualificationEligible:false,renderBoundary:'Babylon after-render, submitted own geometry; GPU completion/display scanout unmeasured',attribution:'accepted nonqueued own idle-order transition; exact command watermark and post-receipt action clock; ambiguous activity excluded',countMeaning:'acted/applied count commands whose own authorized action was observed at application, not a server wall timestamp; firstMotion excludes stationary gather/gate actions; observedBlockedUnits is not proof of unreachable work',limits:{active:64,history:256,unitsPerCommand:200,preReceiptViews:4,timeoutMs:this.timeoutMs},counts:{...this.totals,pending:this.active.size},rows,samples};
  }
}

/** Observe an actual completed scene draw, and remove the observer even when
 * rendering throws or is skipped. A diagnostic callback cannot break rendering. */
export function observeResponseRender(scene:Scene,render:()=>void,complete:()=>void):void{
  let completed=false;const observer=scene.onAfterRenderObservable.addOnce(()=>{completed=true;});
  try{render();if(completed){try{complete();}catch{/* Diagnostic-only failure. */}}}finally{scene.onAfterRenderObservable.remove(observer);}
}
let current:BrowserResponseDiagnostics|undefined,last:BrowserResponseDiagnostics|undefined,faults=0;
export const browserResponseProbe={
  get enabled(){return current!==undefined;},
  observe(action:(probe:BrowserResponseDiagnostics)=>void):void{if(current)try{action(current);}catch{faults++;try{current.boundary('diagnostic-failure');}catch{}last=current;current=undefined;}},
};
export const browserResponseDiagnostics=Object.freeze({
  enable(options:{timeoutMs?:number}={}){current?.boundary('recording-restarted');last=current=new BrowserResponseDiagnostics(undefined,options.timeoutMs);faults=0;return 'Browser-local response recording enabled';},
  disable(){current?.boundary('recording-disabled');last=current??last;current=undefined;},
  labelNext(label:string){current?.labelNext(label);},
  report(){return {enabled:current!==undefined,faults,evidence:(current??last)?.report()??null};},
});
declare global {interface Window {frontierResponseDiagnostics:typeof browserResponseDiagnostics;frontierDeliveryDiagnostics:{report:()=>ReturnType<BrowserDeliveryDiagnostics['report']>}}}
if(typeof window!=='undefined'){
  Object.defineProperty(window,'frontierResponseDiagnostics',{value:browserResponseDiagnostics,configurable:true});
  Object.defineProperty(window,'frontierDeliveryDiagnostics',{value:Object.freeze({report:()=>browserDeliveryDiagnostics.report()}),configurable:true});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='visible')browserResponseProbe.observe(probe=>probe.boundary('document-hidden'));});
}
