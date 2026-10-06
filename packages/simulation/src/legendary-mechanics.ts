import { balance, buildings, legendaryExpansion } from '@frontier/shared';
import type { Building, Entity, SimulationState } from './state.js';

/** Native ownership certifies membership through explicit construction, age and
 * static mutation hooks. The public mutable reference path rechecks its actors.
 * Recovery walks only assigned targets (at most 24 per faction), never all walls. */
export class WardSystem {
  private relevant:Building[]=[];
  private signature='';
  private revision:number|undefined;
  private dirty=true;
  private assigned:Building[]=[];
  invalidate():void{this.dirty=true;}
  advance(state:SimulationState,actors:readonly Entity[],recover=true,nativeRevision?:number):void {
    if(state.rulesetId!=='legendary_ages_v1')return;
    if(nativeRevision!==undefined){
      if(this.dirty||this.revision!==nativeRevision){this.revision=nativeRevision;this.rebuild(state,actors);}
    }else{
      const signature=actors.filter((e):e is Building=>e.kind==='building').map(b=>`${b.id}:${b.typeId}:${b.ownerId}:${b.xMm}:${b.zMm}:${b.hp>0&&b.work>=b.required&&!state.economies[b.ownerId]!.defeated}`).join('|')+';'+state.factions.map(f=>state.economies[f.id]!.age).join(',');
      if(this.dirty||signature!==this.signature){this.signature=signature;this.rebuild(state,actors);}
    }
    if(!recover)return;
    const hz=balance.rules.simulationHz,quiet=legendaryExpansion.wards.quietSeconds*hz;
    for(const b of this.assigned){const ward=b.ward;if(!ward||state.tick-ward.quietSinceTick<quiet||ward.current>=ward.max)continue;const row=legendaryExpansion.wards.byAge[String(Math.min(8,state.economies[b.ownerId]!.age)) as '6'|'7'|'8'];if(!row)continue;ward.recoveryRemainder+=row.recoveryPerSecond;const addition=Math.floor(ward.recoveryRemainder/hz);ward.recoveryRemainder%=hz;ward.current=Math.min(ward.max,ward.current+addition);}
  }
  private rebuild(state:SimulationState,actors:readonly Entity[]):void{
    this.dirty=false;this.relevant=actors.filter((e):e is Building=>e.kind==='building'&&(e.typeId==='ward_spire'||Boolean(buildings[e.typeId].wardEligible)));this.assign(state);
  }
  private assign(state:SimulationState):void {
    const cell=legendaryExpansion.wards.radiusM*1000,buckets=new Map<string,Building[]>(),spires:Building[]=[],eligible:Building[]=[];
    for(const b of this.relevant){if(b.hp<=0||b.work<b.required||state.economies[b.ownerId]!.defeated)continue;if(b.typeId==='ward_spire'){spires.push(b);continue;}eligible.push(b);const key=`${Math.floor(b.xMm/cell)},${Math.floor(b.zMm/cell)}`;const bucket=buckets.get(key)??[];bucket.push(b);buckets.set(key,bucket);}
    const assigned=new Set<string>(),rank=(b:Building)=>buildings[b.typeId].family==='citadel'?0:buildings[b.typeId].defaultGateMode?1:2;
    for(const spire of spires.sort((a,b)=>a.id.localeCompare(b.id))){const candidates:Building[]=[];for(let z=Math.floor(spire.zMm/cell)-1;z<=Math.floor(spire.zMm/cell)+1;z++)for(let x=Math.floor(spire.xMm/cell)-1;x<=Math.floor(spire.xMm/cell)+1;x++)for(const b of buckets.get(`${x},${z}`)??[])if(b.ownerId===spire.ownerId&&!assigned.has(b.id)&&Math.hypot(b.xMm-spire.xMm,b.zMm-spire.zMm)<=cell)candidates.push(b);
      candidates.sort((a,b)=>rank(a)-rank(b)||Math.hypot(a.xMm-spire.xMm,a.zMm-spire.zMm)-Math.hypot(b.xMm-spire.xMm,b.zMm-spire.zMm)||a.id.localeCompare(b.id));
      for(const b of candidates.slice(0,legendaryExpansion.wards.maxTargets)){const row=legendaryExpansion.wards.byAge[String(Math.min(8,state.economies[b.ownerId]!.age)) as '6'|'7'|'8'];if(!row)continue;const maximum=rank(b)===0?row.citadel:rank(b)===1?row.gate:row.wall;assigned.add(b.id);if(b.ward?.supportId===spire.id){b.ward.max=maximum;b.ward.current=Math.min(maximum,b.ward.current);}else b.ward={supportId:spire.id,current:0,max:maximum,quietSinceTick:state.tick,recoveryRemainder:0};}
    }
    for(const b of this.relevant)if(!assigned.has(b.id))delete b.ward;
    this.assigned=eligible.filter(b=>assigned.has(b.id));
  }
}
/** Called in stable attack-event order before simultaneous physical HP damage. */
export function absorbWard(target:Building,damage:number,multiplier:number,tick:number,projectile:boolean):number {
  const ward=target.ward;if(!ward)return damage;ward.quietSinceTick=tick;ward.recoveryRemainder=0;
  if(!projectile||ward.current<=0)return damage;
  const blocked=Math.min(damage,Math.ceil(ward.current/multiplier));ward.current=Math.max(0,ward.current-blocked*multiplier);return damage-blocked;
}
