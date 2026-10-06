import type {PlanningStallCandidate} from '../../../packages/simulation/src/persistence-types.js';
interface StallEntry {candidate:PlanningStallCandidate;since:number;progressSince:number}

/** Wall time is only a proposal trigger. The simulation validates and journals
 * every recovery, so replay never depends on this clock or an expired timer. */
export class PlanningStallMonitor {
  private entries=new Map<string,StallEntry>();
  private epoch:string|number|undefined;
  private previousNow:number|undefined;
  private nextPlayer=0;
  private omitted=false;
  constructor(private readonly delayMs=30000){if(!Number.isFinite(delayMs)||delayMs<=0)throw new Error('INVALID_PLANNING_STALL_DELAY');}
  reset():void{this.entries.clear();this.epoch=undefined;this.previousNow=undefined;this.nextPlayer=0;this.omitted=false;}
  /** A retry proposal is not progress. Only physical progress, a replacement,
   * or a request leaving the pending set can clear this wall-time evidence. */
  get recoveryBlocked():boolean{return this.previousNow===undefined||this.omitted||[...this.entries.values()].some(entry=>this.previousNow!-entry.progressSince>=this.delayMs);}
  observe(candidates:readonly PlanningStallCandidate[],now:number,epoch:string|number):PlanningStallCandidate[]{
    if(!Number.isFinite(now)||now<0)throw new Error('INVALID_PLANNING_STALL_TIME');
    if(this.epoch!==epoch||this.previousNow!==undefined&&now<this.previousNow)this.reset();
    this.epoch=epoch;this.previousNow=now;
    this.omitted=candidates.length>2200;
    const current=new Set<string>();
    for(const candidate of candidates.slice(0,2200)){
      if(current.has(candidate.unitId))continue;current.add(candidate.unitId);
      const prior=this.entries.get(candidate.unitId),old=prior?.candidate;
      if(!old||old.requestId!==candidate.requestId||old.orderRevision!==candidate.orderRevision||old.progressTick!==candidate.progressTick||old.playerId!==candidate.playerId)this.entries.set(candidate.unitId,{candidate:{...candidate},since:now,progressSince:now});
    }
    for(const unitId of this.entries.keys())if(!current.has(unitId))this.entries.delete(unitId);
    const players=[...new Set([...this.entries.values()].map(entry=>entry.candidate.playerId))].sort(),expired=new Map<string,StallEntry[]>();
    for(const player of players)expired.set(player,[]);
    for(const entry of this.entries.values())if(now-entry.since>=this.delayMs)expired.get(entry.candidate.playerId)!.push(entry);
    const result:PlanningStallCandidate[]=[];
    while(players.length&&result.length<16){
      let selected=false;
      for(let visited=0;visited<players.length;visited++){
        const player=players[this.nextPlayer%players.length]!;this.nextPlayer=(this.nextPlayer+1)%players.length;
        const entry=expired.get(player)!.shift();if(!entry)continue;
        result.push({...entry.candidate});entry.since=now;selected=true;break;
      }
      if(!selected)break;
    }
    return result;
  }
}
