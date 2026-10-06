import { balance, type CommandReceipt, type PlayerView, type Position } from '@frontier/shared';

export const AI_FACT_LIMIT = 20;
export const AI_RECEIPT_LIMIT = 20;
export const AI_SUMMARY_LIMIT = 640;
export interface AiFact {
  id:string; tick:number; expiresTick:number;
  kind:'enemy_seen'|'resource_warning'|'owned_event'|'ally_request'|'request_outcome';
  provenance:'observation'|'owned_event'|'human_claim'|'team_ping';
  confidence:'observed'|'unverified'; sourcePlayerId:string; text:string;
  entityId?:string; position?:Position; requestId?:string;
}
export interface AiReceiptMemory {tick:number;clientCommandId:string;status:'accepted'|'rejected';code?:string;goalKey?:string}
export interface AiMemory {matchId:string;playerId:string;facts:AiFact[];summary:string;recentReceipts:AiReceiptMemory[]}
export function boundedAiText(value:string,limit:number):string {return value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,limit);}
export function createAiMemory(matchId:string,playerId:string):AiMemory {return {matchId,playerId,facts:[],summary:'',recentReceipts:[]};}
export function assertAiMemoryIdentity(view:PlayerView,memory:AiMemory):void {
  if(memory.matchId!==view.matchId||memory.playerId!==view.playerId)throw new Error('AI_MEMORY_IDENTITY_MISMATCH');
}
function summarize(memory:AiMemory):void {
  memory.summary=memory.facts.slice(-8).map(fact=>`${fact.confidence==='unverified'?'Unverified claim':'Observed'} at tick ${fact.tick}: ${fact.text}`).join(' | ').slice(0,AI_SUMMARY_LIMIT);
}
/** Only the authority can append facts. The model has no memory-writing tool. */
export function recordAiFact(memory:AiMemory,fact:AiFact):void {
  appendAiFact(memory,fact);summarize(memory);
}
function appendAiFact(memory:AiMemory,fact:AiFact):void {
  const claimed=fact.provenance==='human_claim'||fact.provenance==='team_ping';
  if(!Number.isSafeInteger(fact.tick)||fact.tick<0||!Number.isSafeInteger(fact.expiresTick)||fact.expiresTick<fact.tick
    ||claimed&&fact.confidence!=='unverified'||!claimed&&(fact.confidence!=='observed'||fact.sourcePlayerId!==memory.playerId))throw new Error('INVALID_AI_FACT_PROVENANCE');
  const copy:AiFact={id:boundedAiText(fact.id,96),tick:fact.tick,expiresTick:fact.expiresTick,kind:fact.kind,provenance:fact.provenance,confidence:fact.confidence,sourcePlayerId:fact.sourcePlayerId,text:boundedAiText(fact.text,240),
    ...(fact.entityId?{entityId:fact.entityId}:{}),...(fact.position?{position:{...fact.position}}:{}),...(fact.requestId?{requestId:fact.requestId}:{})};
  if(!copy.id||!copy.text)throw new Error('INVALID_AI_FACT');
  memory.facts=memory.facts.filter(existing=>existing.id!==copy.id);memory.facts.push(copy);
  memory.facts.sort((a,b)=>a.tick-b.tick||(a.id<b.id?-1:a.id>b.id?1:0));
  memory.facts=memory.facts.slice(-AI_FACT_LIMIT);
}
export function recordAiReceipt(memory:AiMemory,receipt:CommandReceipt,goalKey?:string):void {
  const item:AiReceiptMemory={tick:receipt.tick,clientCommandId:receipt.clientCommandId,status:receipt.status,...(receipt.code?{code:boundedAiText(receipt.code,96)}:{}),...(goalKey?{goalKey:boundedAiText(goalKey,256)}:{})};
  memory.recentReceipts=memory.recentReceipts.filter(prior=>prior.clientCommandId!==item.clientCommandId);memory.recentReceipts.push(item);memory.recentReceipts=memory.recentReceipts.slice(-AI_RECEIPT_LIMIT);
}
/** Reads only current authorized observations and owned notifications. Hidden disappearance is not death. */
export function refreshAiMemory(view:PlayerView,memory:AiMemory):void {
  refreshMemory(view,memory,recordAiFact);
}
/** Internal native-owner path: inputs have no external accessors or observers.
 * Keep every insertion's validation, replacement, ordering and 20-fact bound;
 * only postpone rebuilding the derived summary until the synchronous refresh ends.
 */
export function refreshOwnedAiMemory(view:PlayerView,memory:AiMemory):void {
  let appended=false;
  try{refreshMemory(view,memory,(target,fact)=>{appendAiFact(target,fact);appended=true;});}
  catch(error){if(appended)summarize(memory);throw error;}
}
function refreshMemory(view:PlayerView,memory:AiMemory,record:(memory:AiMemory,fact:AiFact)=>void):void {
  assertAiMemoryIdentity(view,memory);
  const self=view.players.find(player=>player.id===view.playerId);if(!self)throw new Error('INVALID_AI_VIEW');
  memory.facts=memory.facts.filter(fact=>fact.tick<=view.tick&&fact.expiresTick>view.tick);
  const lifetime=90*balance.rules.simulationHz;
  for(const entity of view.entities) {
    if(entity.ghost)continue;
    if(entity.ownerId&&entity.ownerId!==view.playerId&&view.players.find(player=>player.id===entity.ownerId)?.teamId!==self.teamId)
      record(memory,{id:`seen_${entity.id}`,kind:'enemy_seen',tick:view.tick,expiresTick:view.tick+lifetime,provenance:'observation',confidence:'observed',sourcePlayerId:view.playerId,text:`Saw ${entity.typeId}`,entityId:entity.id,position:{xMm:entity.xMm,zMm:entity.zMm}});
    if(entity.resource!==undefined&&(entity.amount??0)<100)
      record(memory,{id:`resource_${entity.id}`,kind:'resource_warning',tick:view.tick,expiresTick:view.tick+lifetime,provenance:'observation',confidence:'observed',sourcePlayerId:view.playerId,text:`${entity.resource} has ${entity.amount??0} remaining`,entityId:entity.id,position:{xMm:entity.xMm,zMm:entity.zMm}});
  }
  for(const notice of view.self.notifications??[])if(notice.tick<=view.tick&&view.tick-notice.tick<lifetime)
    record(memory,{id:notice.id,kind:'owned_event',tick:notice.tick,expiresTick:notice.tick+lifetime,provenance:'owned_event',confidence:'observed',sourcePlayerId:view.playerId,text:notice.code,...(notice.entityId?{entityId:notice.entityId}:{})});
  memory.recentReceipts=memory.recentReceipts.filter(receipt=>receipt.tick<=view.tick).slice(-AI_RECEIPT_LIMIT);summarize(memory);
}
