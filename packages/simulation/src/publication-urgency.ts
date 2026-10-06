import type { PlayerView, VisualAction } from '@frontier/shared';

interface PublishedObservation {
  epoch:number;status:PlayerView['status'];mask:Uint8Array;sourceMask?:Uint8Array;
  actions:Map<string,VisualAction>;urgent:boolean;
}
/** Presentation scheduling only: inputs must already be recipient-authorized.
 * Actions contain observed work, never orders, targets, world entities or hidden
 * deaths. Merely checking urgency does not acknowledge a publication.
 */
export class PublicationUrgency {
  private readonly publishedRecipients=new Map<string,PublishedObservation>();

  pending(playerId:string,actions:Readonly<Record<string,VisualAction>>,mask:Uint8Array,status:PlayerView['status'],epoch:number,immutableMask=false):boolean {
    const prior=this.publishedRecipients.get(playerId);
    if(!prior)return true;
    if(prior.urgent)return true;
    const urgent=()=>{prior.urgent=true;return true;};
    if(prior.epoch!==epoch||prior.status!==status||prior.mask.length!==mask.length)return urgent();
    // Only an exclusive simulation owner may certify unchanged mask identity.
    // Generic/custom callers compare against the detached published snapshot,
    // including when they edit the same Uint8Array in place.
    if(!immutableMask||prior.sourceMask!==mask)for(let cell=0;cell<prior.mask.length;cell++)if(prior.mask[cell]&&!mask[cell])return urgent();
    for(const [id,previous]of prior.actions){
      const current=Object.hasOwn(actions,id)?actions[id]:undefined;
      if(!current||current.kind!==previous.kind)return urgent();
      // Facing-only changes while travelling are ordinary pose updates. Every
      // newly committed observed attack remains prompt, including repeat shots.
      if(current.kind==='attack'&&(current.startedTick!==previous.startedTick||current.durationTicks!==previous.durationTicks||current.facingMilliRad!==previous.facingMilliRad))return urgent();
    }
    // A newly observed attacker need not have existed in the prior roster.
    for(const id in actions)if(Object.hasOwn(actions,id)&&actions[id]!.kind==='attack'&&!prior.actions.has(id))return urgent();
    return false;
  }

  /** Call only after successfully building/exporting this recipient's offered
   * publication. Filtering/candidate selection/credit requests are not offers. */
  published(playerId:string,actions:Readonly<Record<string,VisualAction>>,mask:Uint8Array,status:PlayerView['status'],epoch:number,immutableMask=false):void {
    const detached=new Map<string,VisualAction>();
    for(const id in actions)if(Object.hasOwn(actions,id)){const action=actions[id]!;detached.set(id,{kind:action.kind,startedTick:action.startedTick,...(action.durationTicks!==undefined?{durationTicks:action.durationTicks}:{}),...(action.facingMilliRad!==undefined?{facingMilliRad:action.facingMilliRad}:{})});}
    this.publishedRecipients.set(playerId,{epoch,status,mask:mask.slice(),...(immutableMask?{sourceMask:mask}:{}),actions:detached,urgent:false});
  }

  reset(playerId?:string):void { if(playerId===undefined)this.publishedRecipients.clear();else this.publishedRecipients.delete(playerId); }
}
