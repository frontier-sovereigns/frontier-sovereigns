import { balance, units, buildings, resolveRuleset, isContentAllowed, wallTypeForMaterial, sha256, validateAiPlan, type AiGoal, type AiPlan, type CommandReceipt, type GameplayCommand, type PlayerView, type Position, type ResourceType } from '@frontier/shared';
import { emptyCaretakerMemory, type CaretakerMemory } from './caretaker.js';
import { createAiMemory, recordAiFact, type AiMemory } from './ai-memory.js';
import type { AiChatRequest, AiGoalSummary, AiReferenceRegistry, AiRequestBinding } from './ai-observation.js';
import type { FortifyMemory } from './fortify-planner.js';

export interface AiGoalState extends AiGoalSummary {goal:AiGoal;correlationId?:string;source?:'preset';frozenReferences?:AiReferenceRegistry;lastIssuedTick?:number;lastSignature?:string;reportedStatus?:AiGoalSummary['status'];candidateIndex:number;attempts:number}
export interface InstalledAiPlan {generation:number;strategy:string;acceptedTick:number;expiresTick:number;goals:AiGoalState[]}
/** One ordinary worker trip, using only a previously authorized resource observation. */
export interface ResourceHandoff {workerId:string;resourceId:string;resource:ResourceType;phase:'move'|'gather';target:Position;issuedTick:number;expiresTick:number;lastProgressTick:number;lastPosition:Position}
export interface CommanderState extends CaretakerMemory {
  generation:number;observationNonce:number;planGeneration:number;nextScoutTick:number;
  memory:AiMemory;activeRequest?:{binding:AiRequestBinding;references:AiReferenceRegistry;chatRequestIds:string[]};
  plan?:InstalledAiPlan;fortifications:Record<string,FortifyMemory>;tributeCredits:Record<string,number>;
  planReferences:AiReferenceRegistry;
  chatRequests:AiChatRequest[];mode:'model'|'fallback';reason:string;
  inferenceFailures:number;outbox:AiMessage[];
  resourceHandoff?:ResourceHandoff;resourceHandoffCooldown?:{resourceId:string;untilTick:number};
  pending:(CaretakerMemory['pending'][number]&{goalKey?:string;planGeneration?:number})[];
}
export interface AiMessage {recipientId:string;text:string;requestId?:string;status:'planned'|'declined'|'completed'|'blocked'|'expired'}
export type AiPlanRejectionCode='AI_PLAN_SCHEMA_INVALID'|'AI_PLAN_OBSERVATION_MISMATCH';
export interface AiCompletion {accepted:boolean;code:string;diagnosticCode?:AiPlanRejectionCode;goals:AiGoalSummary[];rejections?:{key:string;code:string}[];message?:AiMessage}
export type AiRequestResult={kind:'plan';plan:unknown}|{kind:'failure';code:string};
export interface AiCommandProposal {command:GameplayCommand;goalKey?:string;planGeneration?:number}
/** Internal synchronous diagnostic seam; no clock, state or wire data is owned here. */
export type ControllerProfilePhase='priorClone'|'view'|'memoryRefresh'|'policy'|'caretakerClone'|'admission'|'journal';
export interface ControllerProfileContext {playerId:string;tick:number;epoch:number;tacticalPulse:boolean;pendingDue:boolean;expiredGoal:boolean}
export interface ControllerProfiler {
  commander<T>(context:ControllerProfileContext,operation:()=>T):T;
  measure<T>(phase:ControllerProfilePhase,operation:()=>T):T;
  observation(view:PlayerView):void;
}
export interface CommanderPatch {path:(string|number)[];value:unknown}
/** Structural patches preserve object insertion order; membership changes replace their container. */
export function commanderPatches(before:CommanderState,after:CommanderState):CommanderPatch[]{
  const patches:CommanderPatch[]=[];const walk=(a:unknown,b:unknown,path:(string|number)[])=>{
    if(Object.is(a,b))return;
    if(path.length<12&&a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
      const left=Object.keys(a),right=Object.keys(b);if(left.length===right.length&&left.every((key,index)=>key===right[index])){for(const key of left)walk((a as Record<string,unknown>)[key],(b as Record<string,unknown>)[key],[...path,Array.isArray(a)?Number(key):key]);return;}
    }
    patches.push({path,value:structuredClone(b)});
  };walk(before,after,[]);if(!patches.length)return patches;
  const full=[{path:[],value:after}];return structuredClone(patches.length>256||JSON.stringify(patches).length>JSON.stringify(full).length?full:patches);
}
/** Apply only to a detached clone. The caller validates the complete result before installation. */
export function applyCommanderPatches(before:CommanderState,patches:CommanderPatch[]):unknown{
  if(!Array.isArray(patches)||patches.length>256||Buffer.byteLength(JSON.stringify(patches),'utf8')>262144)throw new Error('INVALID_COMMANDER_PATCH');
  let next:unknown=structuredClone(before);const safe=(key:unknown)=>typeof key==='number'?Number.isSafeInteger(key)&&key>=0:typeof key==='string'&&key.length<=256&&!['__proto__','prototype','constructor'].includes(key);
  for(const patch of patches){if(!patch||!Array.isArray(patch.path)||patch.path.length>12||patch.path.some(key=>!safe(key))||patch.value===undefined)throw new Error('INVALID_COMMANDER_PATCH');
    if(!patch.path.length){next=structuredClone(patch.value);continue;}
    let parent=next;for(const key of patch.path.slice(0,-1)){if(!parent||typeof parent!=='object'||Array.isArray(parent)!==(typeof key==='number')||!Object.hasOwn(parent,key))throw new Error('INVALID_COMMANDER_PATCH');parent=(parent as Record<string|number,unknown>)[key];}
    const key=patch.path.at(-1)!;if(!parent||typeof parent!=='object'||Array.isArray(parent)!==(typeof key==='number')||!Object.hasOwn(parent,key))throw new Error('INVALID_COMMANDER_PATCH');(parent as Record<string|number,unknown>)[key]=structuredClone(patch.value);
  }return next;
}
export function createCommanderState(matchId:string,playerId:string):CommanderState{return {...emptyCaretakerMemory(),generation:1,observationNonce:0,planGeneration:0,nextScoutTick:0,memory:createAiMemory(matchId,playerId),planReferences:{},fortifications:{},tributeCredits:{},chatRequests:[],mode:'fallback',reason:'ENDPOINT_UNAVAILABLE',inferenceFailures:0,outbox:[]};}
export function goalSummaries(state:CommanderState):AiGoalSummary[]{return (state.plan?.goals??[]).map(({key,kind,status,reason,acceptedTick,expiresTick})=>({key,kind,status,...(reason?{reason}:{}),acceptedTick,expiresTick}));}
export function aiObservationId(matchId:string,playerId:string,generation:number,nonce:number){return `obs_${sha256(`${matchId}:${playerId}:${generation}:${nonce}`).slice(0,40)}`;}
export function goalKey(goal:AiGoal,references:AiReferenceRegistry,correlationId?:string):string {
  const ref=(name:string)=>{const value=Object.hasOwn(references,name)?references[name]:undefined;if(!value)return name;return 'entityId'in value?value.entityId:'playerId'in value?value.playerId:value.ref;};
  switch(goal.kind){case 'economy':return 'economy';case 'ensure_building':return `building:${goal.buildingType}`;case 'ensure_units':return `units:${goal.unitType}`;case 'research':return `research:${goal.technologyId}`;case 'advance_age':return 'age';case 'develop':return 'development';case 'army_order':return `army:${goal.squadRef}`;case 'scout':return `scout:${goal.zoneRef}`;case 'fortify':return `fortify:${ref(goal.anchorRef)}`;case 'tribute':return `tribute:${ref(goal.allyRef)}:${goal.resource}:${correlationId??'autonomous'}`;}
}
const equalBinding=(a:AiRequestBinding,b:AiRequestBinding)=>a.matchId===b.matchId&&a.matchEpoch===b.matchEpoch&&a.playerId===b.playerId&&a.requestId===b.requestId&&a.observationId===b.observationId&&a.observedTick===b.observedTick&&a.controllerGeneration===b.controllerGeneration;
export function bindingReason(view:PlayerView,state:CommanderState,binding:AiRequestBinding):string|undefined {
  if(view.status!=='RUNNING'||view.matchId!==binding.matchId||view.matchEpoch!==binding.matchEpoch||view.playerId!==binding.playerId||state.generation!==binding.controllerGeneration||!state.activeRequest||!equalBinding(state.activeRequest.binding,binding))return 'STALE_AI_RESPONSE';
  if(view.tick<binding.observedTick||view.tick-binding.observedTick>balance.ai.maxObservationAgeSeconds*balance.rules.simulationHz)return 'AI_OBSERVATION_EXPIRED';
  return undefined;
}
function referenceReason(view:PlayerView,goal:AiGoal,refs:AiReferenceRegistry):string|undefined {
  const content=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset);
  if((goal.kind==='advance_age'||goal.kind==='develop')&&goal.targetAge>content.maxAge)return 'MAX_AGE';
  const type=goal.kind==='ensure_building'?goal.buildingType:goal.kind==='ensure_units'?goal.unitType:goal.kind==='research'?goal.technologyId:goal.kind==='fortify'?wallTypeForMaterial(goal.material):undefined;
  if(type&&!isContentAllowed(type,content.rulesetId,content.maxAge))return 'CONTENT_NOT_IN_MATCH';
  if(goal.kind==='ensure_units'&&goal.targetCount>(units[goal.unitType].maxPerPlayer??Infinity))return 'UNIT_CAP';
  if(goal.kind==='ensure_building'&&goal.targetCount>(buildings[goal.buildingType].maxPerPlayer??buildings[goal.buildingType].familyCap??Infinity))return 'BUILDING_CAP';
  const resolve=(name:string,kinds:string[])=>Object.hasOwn(refs,name)&&kinds.includes(refs[name]!.kind)?refs[name]:undefined;
  if(goal.kind==='ensure_building'&&!resolve(goal.anchorRef,['own_base','ally_anchor','resource','frontier','team_ping']))return 'INVALID_ANCHOR';
  if(goal.kind==='fortify'||goal.kind==='develop'){const ref=resolve(goal.anchorRef,['own_base']);if(!ref||!('entityId'in ref)||!view.entities.some(entity=>entity.id===ref.entityId&&entity.kind==='building'&&entity.ownerId===view.playerId))return 'INVALID_ANCHOR';}
  if(goal.kind==='army_order'){
    const squad=resolve(goal.squadRef,['squad']);if(!squad||!('entityIds'in squad)||squad.entityIds.some(id=>{const entity=view.entities.find(entity=>entity.id===id);return entity&&entity.ownerId!==view.playerId;}))return 'INVALID_SQUAD';
    if(!resolve(goal.targetRef,['own_base','ally_anchor','enemy_memory','frontier','resource','team_ping']))return 'INVALID_TARGET_REF';
  }
  if(goal.kind==='scout'&&!resolve(goal.zoneRef,['frontier','enemy_memory','resource','team_ping']))return 'INVALID_ZONE';
  if(goal.kind==='tribute'){
    const ally=resolve(goal.allyRef,['ally']),self=view.players.find(player=>player.id===view.playerId);if(!ally||!('playerId'in ally)||ally.playerId===view.playerId||!view.players.some(player=>player.id===ally.playerId&&player.teamId===self?.teamId))return 'INVALID_ALLY';
  }
  return undefined;
}
function presetReferences(goal:AiGoal,references:AiReferenceRegistry):AiReferenceRegistry {
  const names=goal.kind==='tribute'?[goal.allyRef]:goal.kind==='army_order'?[goal.squadRef,goal.targetRef]:[];
  return Object.fromEntries(names.filter(name=>Object.hasOwn(references,name)).map(name=>[name,structuredClone(references[name]!)]));
}
function goalIntentSignature(goal:AiGoal,references:AiReferenceRegistry):string {
  const names=goal.kind==='ensure_building'||goal.kind==='fortify'||goal.kind==='develop'?['anchorRef']:goal.kind==='army_order'?['squadRef','targetRef']:goal.kind==='scout'?['zoneRef']:goal.kind==='tribute'?['allyRef']:[];
  const resolved:Record<string,unknown>={...goal};
  for(const name of names){const value=references[(goal as unknown as Record<string,string>)[name]!];resolved[name]=value?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='ref'&&key!=='lastSeenTick')):null;}
  const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,stable(child)])):value;
  return JSON.stringify(stable(resolved));
}
/** Compatible renewals preserve delayed unpaid commands; changed intentions are replaced. */
export function installAiPlan(view:PlayerView,state:CommanderState,binding:AiRequestBinding,input:unknown,options:{source?:'preset'}={}):AiCompletion {
  const stale=bindingReason(view,state,binding);if(stale)return {accepted:false,code:stale,goals:[]};
  const request=state.activeRequest!;delete state.activeRequest;
  const schemaValid=validateAiPlan(input);
  if(!schemaValid||input.observationId!==binding.observationId){
    // A failed renewal does not revoke a previously accepted intention. Its
    // original deadlines/references and ordinary command checks still apply;
    // no invalid response extends that authorization or clears paid work.
    const retained=state.mode==='model'&&state.plan&&state.plan.expiresTick>view.tick&&state.plan.goals.some(goal=>goal.expiresTick>view.tick&&!['fulfilled','rejected','expired'].includes(goal.status));
    state.mode=retained?'model':'fallback';state.reason=retained?'INVALID_REPLACEMENT_RETAINED':'INVALID_AI_PLAN';
    // Fixed categories only: schema errors may contain arbitrary response text,
    // field names or observation IDs and must not cross the worker boundary.
    return {accepted:false,code:'INVALID_AI_PLAN',diagnosticCode:schemaValid?'AI_PLAN_OBSERVATION_MISMATCH':'AI_PLAN_SCHEMA_INVALID',goals:retained?goalSummaries(state):[]};
  }
  const plan:AiPlan=input,correlationId=request.chatRequestIds.length===1?request.chatRequestIds[0]:undefined,expiresTick=view.tick+balance.ai.goalTtlSeconds*balance.rules.simulationHz;
  const keyed=plan.goals.map(goal=>({goal,key:goalKey(goal,request.references,goal.kind==='tribute'?correlationId:undefined)}));
  const conflicting=new Set(keyed.filter(item=>keyed.some(other=>other.key===item.key&&JSON.stringify(other.goal)!==JSON.stringify(item.goal))).map(item=>item.key));
  const priorGoals=state.plan?.goals??[],priorGeneration=state.plan?.generation,compatibleKeys=new Set<string>(),old=new Map(priorGoals.map(goal=>[goal.key,goal])),seen=new Set<string>(),incoming:AiGoalState[]=[],rejections:{key:string;code:string}[]=[];
  const preserved=priorGoals.filter(goal=>goal.source==='preset'&&goal.expiresTick>view.tick&&!['fulfilled','rejected','expired'].includes(goal.status)&&!(options.source==='preset'&&keyed.some(item=>item.key===goal.key)));
  const conflictKey=(goal:AiGoal,references:AiReferenceRegistry)=>goalKey(goal,references);
  for(const item of keyed){if(seen.has(item.key))continue;seen.add(item.key);const reason=conflicting.has(item.key)?'CONFLICTING_GOALS':referenceReason(view,item.goal,request.references),prior=old.get(item.key),retained=prior&&goalIntentSignature(prior.goal,prior.frozenReferences??state.planReferences)===goalIntentSignature(item.goal,request.references)?prior:undefined;
    // A model cannot turn a pending human tribute into an additional autonomous payment.
    if(options.source!=='preset'&&preserved.some(goal=>conflictKey(goal.goal,goal.frozenReferences!)===conflictKey(item.goal,request.references))){rejections.push({key:item.key,code:'PRESET_CONFLICT'});continue;}
    if(reason)rejections.push({key:item.key,code:reason});
    if(!reason&&retained&&retained.expiresTick>view.tick&&!['fulfilled','rejected','expired'].includes(retained.status))compatibleKeys.add(item.key);
    incoming.push({key:item.key,kind:item.goal.kind,goal:structuredClone(item.goal),status:reason?'rejected':retained?.status==='fulfilled'&&item.goal.kind==='tribute'?'fulfilled':'accepted',...(reason?{reason}:{}),acceptedTick:view.tick,expiresTick,candidateIndex:retained?.candidateIndex??0,attempts:retained?.attempts??0,...(retained?.lastIssuedTick!==undefined?{lastIssuedTick:retained.lastIssuedTick}:{}),...(retained?.lastSignature!==undefined?{lastSignature:retained.lastSignature}:{}),...(retained?.reportedStatus?{reportedStatus:retained.reportedStatus}:{}),...(correlationId?{correlationId}:{}),...(options.source==='preset'?{source:'preset' as const,frozenReferences:presetReferences(item.goal,request.references)}:{})});
  }
  const feedback=(code:string)=>recordAiFact(state.memory,{id:`plan_${binding.observationId}`,kind:'owned_event',provenance:'owned_event',confidence:'observed',sourcePlayerId:view.playerId,tick:view.tick,expiresTick,text:code});
  const trusted=correlationId?state.chatRequests.find(chat=>chat.requestId===correlationId):undefined;
  if(preserved.length+incoming.length>8){feedback('AI_GOAL_CAPACITY: accepted typed cooperation already occupies the available goal slots.');return {accepted:false,code:'AI_GOAL_CAPACITY',goals:goalSummaries(state),...(trusted?{message:{recipientId:trusted.senderId,requestId:trusted.requestId,status:'declined' as const,text:'The request exceeds the available goal capacity. Existing accepted cooperation continues.'}}:{})};}
  const goals=[...preserved,...incoming],preservedKeys=new Set(preserved.map(goal=>goal.key));
  for(const priorCorrelation of new Set(priorGoals.filter(goal=>goal.correlationId&&goal.correlationId!==correlationId&&!preservedKeys.has(goal.key)&&!['fulfilled','rejected','expired'].includes(goal.status)).map(goal=>goal.correlationId!))){const chat=state.chatRequests.find(chat=>chat.requestId===priorCorrelation);if(chat)state.outbox.push({recipientId:chat.senderId,requestId:chat.requestId,status:'expired',text:'The unpaid intentions were replaced by a newer plan. Already paid work continues.'});}state.outbox=state.outbox.slice(-32);
  state.plan={generation:++state.planGeneration,strategy:plan.strategy,acceptedTick:view.tick,expiresTick,goals};state.pending=state.pending.filter(batch=>batch.goalKey===undefined||batch.planGeneration===priorGeneration&&(preservedKeys.has(batch.goalKey)||compatibleKeys.has(batch.goalKey))).map(batch=>batch.goalKey?{...batch,planGeneration:state.planGeneration}:batch);state.mode='model';state.reason=rejections.some(rejection=>rejection.code==='PRESET_CONFLICT')?'PRESET_CONFLICT':rejections.length?'INVALID_GOALS_REJECTED':'VALID_PLAN';
  // Resolved references belong to this plan after the in-flight binding has been consumed.
  state.planReferences=structuredClone(request.references);
  if(rejections.length)feedback(`${rejections.some(rejection=>rejection.code==='PRESET_CONFLICT')?'PRESET_CONFLICT':'Rejected intentions'}: ${rejections.map(rejection=>`${rejection.key} (${rejection.code})`).join(', ')}. Use current references[].ref; rebuild a lost Town Center before develop/fortify.`.slice(0,240));
  const response:AiCompletion={accepted:true,code:rejections.length?'PLAN_PARTIALLY_ACCEPTED':'PLAN_ACCEPTED',goals:goalSummaries(state),...(rejections.length?{rejections}:{})},relevant=incoming.filter(goal=>goal.status!=='rejected');
  if(plan.message){const recipient=Object.hasOwn(request.references,plan.message.recipientRef)?request.references[plan.message.recipientRef]:undefined;if(recipient?.kind==='ally'&&'playerId'in recipient&&(!trusted||recipient.playerId===trusted.senderId))response.message={recipientId:recipient.playerId,text:plan.message.text,...(correlationId?{requestId:correlationId}:{}),status:relevant.length?'planned':'declined'};}
  if(trusted&&!response.message)response.message={recipientId:trusted.senderId,requestId:trusted.requestId,text:relevant.length?'The request is planned. Completion will be reported after the actions finish.':'The request could not be accepted.',status:relevant.length?'planned':'declined'};
  return response;
}
export function applyGoalReceipt(state:CommanderState,goalKey:string,command:GameplayCommand,receipt:CommandReceipt):void {
  const goal=state.plan?.goals.find(goal=>goal.key===goalKey);if(!goal)return;
  goal.lastIssuedTick=receipt.tick;goal.attempts++;
  if(receipt.status==='accepted'){
    goal.status='pending';delete goal.reason;if(command.kind==='tribute'){state.tributeCredits[goalKey]=(state.tributeCredits[goalKey]??0)+command.amount;goal.status='fulfilled';}
  }else{goal.reason=receipt.code??'COMMAND_REJECTED';goal.status=['INSUFFICIENT_RESOURCES','QUEUE_FULL','POPULATION_LIMIT','PATH_BUSY'].includes(receipt.code??'')?'pending':'blocked';if(command.kind==='build')goal.candidateIndex++;}
}
