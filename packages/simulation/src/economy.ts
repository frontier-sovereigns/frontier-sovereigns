import { balance, type ResourceBank } from '@frontier/shared';
import type { Economy } from './state.js';

export const resourceTypes=balance.resourceOrder;
export const emptyBank=():ResourceBank=>({food:0,wood:0,gold:0,stone:0});
export function scaledCost(cost:ResourceBank,quantity=1):ResourceBank{
  const result=emptyBank();for(const resource of resourceTypes)result[resource]=cost[resource]*balance.rules.resourceScale*quantity;return result;
}
export function missingResources(economy:Economy,costMilli:ResourceBank):ResourceBank{
  const result=emptyBank();for(const resource of resourceTypes)result[resource]=Math.ceil(Math.max(0,costMilli[resource]-economy.resources[resource])/balance.rules.resourceScale);return result;
}
export function canTransact(economy:Economy,delta:ResourceBank):boolean{return resourceTypes.every(r=>Number.isSafeInteger(delta[r])&&Number.isSafeInteger(economy.resources[r]+delta[r])&&economy.resources[r]+delta[r]>=0);}
/** One atomic resource mutation. Ledger records contain only that owner's bank. */
export function transact(economy:Economy,delta:ResourceBank,reason:string,tick:number,entityId?:string):boolean{
  if(!canTransact(economy,delta))return false;
  for(const resource of resourceTypes){
    const amount=delta[resource];if(!amount)continue;
    economy.resources[resource]+=amount;
    if(amount<0)economy.spent[resource]-=amount;
    if(reason==='deposit')economy.collected[resource]+=amount;
    // Coalesce repair bank changes for the same building/resource within one simulation second.
    let previous:Economy['ledger'][number]|undefined;
    if(reason==='repair')for(let i=economy.ledger.length-1;i>=0;i--)if(economy.ledger[i]!.resource===resource){previous=economy.ledger[i];break;}
    const prior=previous?.reason===reason&&previous.entityId===entityId&&Math.floor(previous.tick/balance.rules.simulationHz)===Math.floor(tick/balance.rules.simulationHz)?previous:undefined;
    if(prior){prior.deltaMilli+=amount;prior.balanceMilli=economy.resources[resource];prior.tick=tick;}
    else economy.ledger.push({tick,reason,resource,deltaMilli:amount,balanceMilli:economy.resources[resource],...(entityId?{entityId}:{})});
  }
  return true;
}
export function debit(economy:Economy,costMilli:ResourceBank,reason:string,tick:number,entityId?:string):boolean{
  const delta=emptyBank();for(const resource of resourceTypes)delta[resource]=-costMilli[resource];return transact(economy,delta,reason,tick,entityId);
}
/** Refunds floor to whole resources before converting to internal thousandths. */
export function refund(cost:ResourceBank,work:number,required:number,fraction:number):ResourceBank{
  const result=emptyBank();for(const resource of resourceTypes)result[resource]=Math.floor(cost[resource]*Math.max(0,required-work)*fraction/required)*balance.rules.resourceScale;return result;
}
