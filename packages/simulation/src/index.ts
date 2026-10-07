import { createHash, createHmac } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { balance, buildings, units, technologies, resolveRuleset, structureUpgrade, PROTOCOL_VERSION, validateClientCommand, type ClientCommandEnvelope, type CommandReceipt, type PlayerView, type PublicPlayer, type Position, type ResourceType, type ResourceBank, type UnitId, type BuildingId, type GameplayCommand, type ViewEntity, type Rotation, type CommittedUnitActionKind, type AssistantPreferences, type AssistantStateResponse, type MovementCadenceTier } from '@frontier/shared';
import { Navigation, PathBudgetExceededError, type NavigationWorkBudget, type Obstacle } from './navigation.js';
import { createOwnedNavigation, createOwnedNavigationRevision, withOwnedNavigationBudget } from './owned-navigation.js';
import {ActiveWorkRoster} from './active-work-roster.js';
import { advanceManualProtection, assistantCommandReason, createAssistantControl, defaultAssistantPreferences, protectManualCommand } from './assistant.js';
import { commanderCommands } from './ai-policy.js';
import { AiDecisionContext, aiBuildingClearanceMm } from './ai-exploration.js';
import { controllerPulse, controllerMemoryPulse } from './controller-schedule.js';
import { aiObservationId, applyCommanderPatches, applyGoalReceipt, bindingReason, commanderPatches, createCommanderState, goalSummaries, installAiPlan, type AiCompletion, type AiMessage, type AiRequestResult, type AiCommandProposal, type CommanderState, type ControllerProfiler } from './ai-controller.js';
import { validateCommanderMemory } from './save-schema.js';
import { buildAiObservation, type AiChatRequest, type AiRequestBinding } from './ai-observation.js';
import { recordAiFact, recordAiReceipt, refreshAiMemory, refreshOwnedAiMemory } from './ai-memory.js';
import { generateMap, type GeneratedMap } from './map.js';
import { terrainObstacles, terrainBuildable, terrainVisionBlockers, resourcePlacementBounds, placementAreaDiscovered, MAX_WORLD_ACTORS, MAX_WORLD_ENTITIES, COARSE_MOVEMENT_DECISION_TICKS } from '@frontier/shared';
import { advanceCombat, projectilePosition, inAttackRange, CombatSpatialIndex, NativeCombatTimeline, createCombatOwnerFilter, createNativeCombatOwnerFilterScope, type Combatant, type CombatOwnerFilter } from './combat.js';
import { committedFacing, updateObservedActions, observationUnitCells, visibleObservedUnit, ObservedActionCache, type CommittedAction } from './observed-actions.js';
import { PerceptionMembership } from './perception-membership.js';
import { advanceTransitions, advanceGarrisons, beginTransition, canMove, ejectDestroyedGarrison, updateEngagements, garrisonCapacity, canBoard, type OrderContext } from './orders.js';
import { advanceGates, fortificationObstacles, isGate, planFortification } from './fortifications.js';
import { PathScheduler, type PathWorkReport } from './path-scheduler.js';
import { SharedPathJobs } from './shared-path-jobs.js';
import { RemotePathScheduler, type PathPlanningExecutor, type PathPlanningGeometry } from './parallel-path-scheduler.js';
import { changedVisionMaskWords, immutableVisionGroup, immutableVisionSource, VisionMaskKernel, type VisionMaskFrame, type VisionMaskGroup, type VisionMaskSource, type VisionMaskResult } from './vision-mask-kernel.js';
import { forestCandidates, resourceWorkBounds } from './forest-navigation.js';
import { RecipientProjection, type ProjectionPatch } from './recipient-projection.js';
import { PublicationUrgency } from './publication-urgency.js';
import type { NativeProjection } from './recipient-projection-native.js';
import { createNativeCheckpointScope, createNativePathCheckpointScope, discardNativePathCheckpoint, isNativeCheckpointPort, postNativeCheckpoint, type NativeCheckpointEnvelope } from './checkpoint-native.js';
import type { MessagePort } from 'node:worker_threads';
import { consumeNativeCommandBatch, type NativeCommandBatch, type NativeCommandItem } from './command-admission-native.js';
import { sameJson } from '../../shared/src/view-stream-kernel.js';
import { ApproachReservations, formationTargets, LocalAvoidance, UnitSpatialIndex, type LocalPathCandidate, type LocalPathQuery } from './movement.js';

import { SeededRandom } from './random.js';
import type { SimulationOptions, SimulationState, Unit, Building, Entity, ResourceNode, Order, TaskState } from './state.js';
import { emptyBank, scaledCost, transact, debit, refund, missingResources, canTransact } from './economy.js';
import { Progression, agePrerequisiteReason, researchPrerequisiteReason, contentPrerequisiteReason, rescaleRepairDenominator } from './progression.js';
import { caretakerCommands, emptyCaretakerMemory } from './caretaker.js';
import { JournalBuffer } from './journal.js';
import { WardSystem } from './legendary-mechanics.js';
import { createLiveSimulationFacade, type LiveSimulation } from './live-simulation-owner.js';
export type { LiveSimulation } from './live-simulation-owner.js';
import type { CommandSource, EffectiveSimulationOptions, JournalAction, JournalEvent, PlanningStallCandidate, SimulationSavePayload } from './persistence-types.js';
export { SeededRandom } from './random.js';
export type * from './state.js';
export type * from './persistence-types.js';
export type * from './ai-controller.js';
export type * from './ai-observation.js';
export { buildAiPrompt } from './ai-observation.js';
const R=balance.rules,scale=R.resourceScale,grid=R.buildingGridM*1000,fogGrid=R.fogGridM*1000;
const resources:ResourceType[]=['food','wood','gold','stone'];
const distance=(a:Position,b:Position)=>Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
// Private derived records cap memory; overflow recomputes geometry without omitting it.
const KNOWN_OBSTACLE_RECORD_LIMIT=MAX_WORLD_ENTITIES+4096;
interface NativePhaseRoster {
  gates:Building[];trebuchets:Unit[];mobileHosts:Unit[];farms:Building[];buildings:Building[];
  productionIndexes:Map<Building,number>;production:Uint32Array;
}
const phaseRosterCounts={rebuilt:0,gates:0,planningGates:0,transitions:0,production:0,farms:0};
const countPhaseRoster=(key:keyof typeof phaseRosterCounts,amount=1)=>{phaseRosterCounts[key]=Math.min(Number.MAX_SAFE_INTEGER,phaseRosterCounts[key]+amount);};
const workFlightCounts={prepared:0,used:0};
const movementRosterCounts={reconciled:0,reused:0,unitsVisited:0};
const countMovementRoster=(key:keyof typeof movementRosterCounts,amount=1)=>{movementRosterCounts[key]=Math.min(Number.MAX_SAFE_INTEGER,movementRosterCounts[key]+amount);};
const resourceObservationCounts={refreshed:0,deferred:0,materialized:0};
interface FrameResourceObservation {key:string;epoch:number;vision:SimulationState['vision'][string];resources:readonly ResourceNode[];tick:number;materializedTick?:number}
interface MovementDecision {
  tick:number;stagger:number;order:Order;orderRevision:number;phase:Order['phase'];targetId?:string;dropOffId?:string;
  target?:Position;targetX?:number;targetZ?:number;path:Position[];point:Position;following?:Position;length:number;
  pathDestination?:Position;regions:Unit['pathRegions'];approach:Unit['approachGoal'];approachPoint?:Position;
  profileRevision:number;physicalRevision:number;researchRevision:number;radius:number;speed:number;
  workTarget?:Entity;workX?:number;workZ?:number;workComplete?:boolean;workAvailable?:boolean;
  workRoute?:{frame:number;epoch:number;x:number;z:number;kind:Order['kind'];ownerId:string;typeId:Unit['typeId'];cargo:number;resource:Unit['cargo']['resource'];targetType:Entity['typeId'];targetOwner:Entity['ownerId'];halfWidth:number;halfHeight:number;pointX:number;pointZ:number;followingX?:number;followingZ?:number;destinationX?:number;destinationZ?:number;approachX:number;approachZ:number};
}
/** A no-work proof lasts only until the next authority boundary. Mutable target,
 * order and cargo eligibility are checked again before using it. */
interface FrameWorkWait {
  frame:number;order:Order|undefined;revision:number;target:Entity;phase:Order['phase'];
  cargo:number;resource:Unit['cargo']['resource'];research:number;
  search?:Unit['resourceSearch'];searchIndex?:number;requestId?:string;x:number;z:number;
}
interface FrameMovementWait {
  frame:number;order:Order;revision:number;requestId:string;target:Position;x:number;z:number;
  targetX:number;targetZ:number;profileRevision:number;physicalRevision:number;research:number;
  kind:Order['kind'];formation:Order['formation'];path:Position[];destination:Unit['pathDestination'];destinationX?:number;destinationZ?:number;
  ownerId:string;typeId:Unit['typeId'];
}
interface FrameWorkFaceWait {
  frame:number;order:Order;kind:Order['kind'];phase:Order['phase'];targetId?:string;dropOffId?:string;revision:number;requestId:string;
  ownerId:string;typeId:Unit['typeId'];x:number;z:number;cargo:number;resource:Unit['cargo']['resource'];research:number;physicalRevision:number;profileRevision:number;
  path:Position[];destination:Unit['pathDestination'];destinationX?:number;destinationZ?:number;
  target:Entity;targetType:Entity['typeId'];targetOwner:Entity['ownerId'];targetX:number;targetZ:number;halfWidth:number;halfHeight:number;
  approach:NonNullable<Unit['approachGoal']>;point:Position;pointX:number;pointZ:number;
}
interface FrameStraightFlight {
  frame:number;tick:number;order:Order;revision:number;ownerId:string;typeId:Unit['typeId'];
  kind:Order['kind'];formation:Order['formation'];path:Position[];length:number;point:Position;pointX:number;pointZ:number;following?:Position;followingX?:number;followingZ?:number;
  destination:Unit['pathDestination'];destinationX?:number;destinationZ?:number;regions:Unit['pathRegions'];target?:Position;targetX?:number;targetZ?:number;x:number;z:number;work?:MovementDecision;
  profileRevision:number;physicalRevision:number;research:string;topology:number;radius:number;points:Position[];
}
/** Inspect eligibility without evaluating a fixture's getters or Proxy traps. */
function admissionRecord(value:unknown):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||nodeTypes.isProxy(value))return false;
  const prototype=Object.getPrototypeOf(value);return prototype===Object.prototype||prototype===null;
}
function admissionFields(value:unknown,fields:readonly string[],scalar=false):boolean{
  if(!admissionRecord(value))return false;
  for(const field of fields){const descriptor=Object.getOwnPropertyDescriptor(value,field);if(!descriptor){if(field in value)return false;continue;}if(!('value'in descriptor)||typeof descriptor.value==='function'||scalar&&descriptor.value!==null&&typeof descriptor.value==='object')return false;}
  return true;
}
function admissionEntries(value:unknown):unknown[]|undefined{
  if(!admissionRecord(value)&&(!Array.isArray(value)||nodeTypes.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype))return;
  const keys=Reflect.ownKeys(value as object);if(keys.length>32768)return;
  const values:unknown[]=[];
  for(const key of keys){const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=='string'||!('value'in descriptor)||typeof descriptor.value==='function')return;if(!Array.isArray(value)||key!=='length')values.push(descriptor.value);}
  return values;
}
function admissionTree(value:unknown,seen=new Set<object>()):boolean{
  const pending=[value];
  while(pending.length){const current=pending.pop();if(current===null||typeof current!=='object'){if(typeof current==='function'||typeof current==='symbol')return false;continue;}
    if(seen.has(current))continue;if(seen.size>=32768)return false;seen.add(current);
    const entries=admissionEntries(current);if(!entries)return false;for(const entry of entries)pending.push(entry);
  }
  return true;
}
function admissionMethod(value:object,key:string,expected:unknown):boolean{
  if(nodeTypes.isProxy(value))return false;
  for(let current:object|null=value;current;current=Object.getPrototypeOf(current)){
    if(nodeTypes.isProxy(current))return false;
    const descriptor=Object.getOwnPropertyDescriptor(current,key);if(descriptor)return 'value'in descriptor&&descriptor.value===expected;
  }
  return false;
}
const admissionOwnedNavigationPrototype=Object.getPrototypeOf(createOwnedNavigation(0,0,[])) as object;
const admissionHelperSurfaces=new Map<object,PropertyDescriptorMap>([
  PathScheduler.prototype,RemotePathScheduler.prototype,SharedPathJobs.prototype,UnitSpatialIndex.prototype,
  ApproachReservations.prototype,LocalAvoidance.prototype,JournalBuffer.prototype,Navigation.prototype,
  admissionOwnedNavigationPrototype,
].map(prototype=>[prototype,Object.getOwnPropertyDescriptors(prototype)] as const));
const admissionHelperParents=new Map([...admissionHelperSurfaces.keys()].map(prototype=>[prototype,Object.getPrototypeOf(prototype)] as const));
const admissionHelperFunctions=new WeakMap<object,Map<string,unknown>>();
function rememberAdmissionHelper(value:object):void{
  const functions=new Map<string,unknown>();for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value)))if('value'in descriptor&&typeof descriptor.value==='function')functions.set(key,descriptor.value);
  admissionHelperFunctions.set(value,functions);
  const shared=Object.getOwnPropertyDescriptor(value,'sharedJobs');if(shared&&'value'in shared&&shared.value)rememberAdmissionHelper(shared.value);
}
function admissionPrototype(prototype:object):boolean{
  for(let current=prototype;current!==Object.prototype;current=Object.getPrototypeOf(current)){
    const original=admissionHelperSurfaces.get(current);if(!original)return false;
    if(Object.getPrototypeOf(current)!==admissionHelperParents.get(current))return false;
    const keys=Reflect.ownKeys(current);if(keys.length!==Reflect.ownKeys(original).length)return false;
    for(const key of keys){if(typeof key!=='string')return false;const actual=Object.getOwnPropertyDescriptor(current,key)!,expected=original[key];if(!expected||actual.value!==expected.value||actual.get!==expected.get||actual.set!==expected.set)return false;}
  }
  return true;
}
function admissionHelper(value:object):boolean{
  if(!value||nodeTypes.isProxy(value))return false;
  const prototype=Object.getPrototypeOf(value),surface=admissionHelperSurfaces.get(prototype);if(!surface||!admissionPrototype(prototype))return false;
  const callbacks=admissionHelperFunctions.get(value);
  for(const [key,descriptor]of Object.entries(Object.getOwnPropertyDescriptors(value))){
    if(!('value'in descriptor))return false;
    if(typeof descriptor.value==='function'&&callbacks?.get(key)!==descriptor.value)return false;
    if(nodeTypes.isProxy(descriptor.value))return false;
    if(nodeTypes.isMap(descriptor.value)||nodeTypes.isSet(descriptor.value)){if(Reflect.ownKeys(descriptor.value).length)return false;}
    if(key in surface&&descriptor.value!==surface[key]!.value)return false;
  }
  for(const [key,callback]of callbacks??[])if(Object.getOwnPropertyDescriptor(value,key)?.value!==callback)return false;
  return true;
}
const admissionTypedBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'buffer')!.get!;
interface KnownObstacleRecord {
  kind:Entity['kind'];typeId:string;xMm:number;zMm:number;rotation:Rotation|undefined;
  active:boolean;wood:boolean;forestCellMm:number;open:boolean;auto:boolean;incomplete:boolean;pending:boolean;
  seen:boolean;obstacles:Obstacle[];shared?:SharedObstacleRecord;
}
type SharedObstacleRecord=Readonly<Omit<KnownObstacleRecord,'seen'|'shared'>>;
interface MovementObstacleSource {entity:Entity;id:string;geometry:SharedObstacleRecord;subscribers:Set<string>;valid:boolean;preparedFor?:symbol}
interface MovementCertificateRow {entity:Entity;record:KnownObstacleRecord;source?:MovementObstacleSource;geometry?:SharedObstacleRecord}
interface MovementDependencyPreparation {
  widthMm:number;heightMm:number;token:symbol;complete:boolean;preparedCount:number;created:Set<Entity>;
}
interface MovementObstacleCertificate {
  known:Entity[];members:readonly Entity[];terrain:Obstacle[];obstacles:Obstacle[];recordCount:number;dirty:boolean;widthMm:number;heightMm:number;
  common:MovementObstacleSource[];local:{entity:Entity;id:string;record:KnownObstacleRecord}[];
  /** Native hidden resources have immutable geometry. Keep only mutable local
   * gates/building memories for repeated checks while the exact roster survives. */
  localChecks?:MovementObstacleCertificate['local'];
  rows?:Map<string,MovementCertificateRow>;
  /** Private per-source geometry identity, independent of live/memory ordering. */
  geometry?:object;
}
interface MovementCertificateDraft {
  playerId:string;prior:MovementObstacleCertificate;active:MovementDependencyPreparation;known:Entity[];members:readonly Entity[];terrain:Obstacle[];
  common:MovementObstacleSource[];local:MovementObstacleCertificate['local'];changes:Map<string,MovementCertificateRow|undefined>;created:Map<Entity,MovementObstacleSource>;count:number;
}
type KnownTerrainSource=Pick<SimulationState['map']['terrain'][number],'id'|'kind'|'xMm'|'zMm'|'widthMm'|'depthMm'>;
interface StaticFootprints {spans:Int32Array;columns:number;visibility?:{members:Uint16Array;masks:Map<Uint8Array,number>}}
type ControllerFootprintSource={entity:Entity;kind:Entity['kind'];xMm?:number;zMm?:number;typeId?:string;rotation?:Rotation;wood?:boolean;pending?:boolean};
interface ControllerViewGeometry {world:readonly Entity[];widthMm:number;heightMm:number;geometry:StaticFootprints;verifiedSources?:ControllerFootprintSource[]}
interface StaticKnowledgeFrame {entities:Entity[];staticFootprints?:StaticFootprints;staticIndexed?:boolean;knownStatic:Map<string,Entity[]>;staticMembers?:Map<string,Entity[]>;knownBuildings?:Map<string,Building[]>}
interface PlanningNavigation {navigation:Navigation;obstacles:Map<string,Obstacle>;revision:number;verifiedObstacles?:Obstacle[];verifiedGeometry?:object}
interface StaticMemorySample {observation:ViewEntity;forest?:{cellMm:number;patchId:string}}
/** Geometry only, scoped to one synchronous phase; no fog results survive it. */
function packStaticFootprints(world:readonly Entity[],widthMm:number,heightMm:number):StaticFootprints {
  const columns=Math.floor(widthMm/fogGrid),rows=Math.floor(heightMm/fogGrid),spans=new Int32Array(world.length*4);
  for(let index=0;index<world.length;index++){
    const entity=world[index]!,offset=index*4;
    if(entity.kind==='unit'||entity.kind==='building'&&entity.pendingConstruction){spans[offset]=1;continue;}
    if(entity.kind==='resource'){
      const radius=entity.resource==='wood'?450:650;
      spans[offset]=Math.max(0,Math.floor((entity.xMm-radius)/fogGrid));spans[offset+1]=Math.min(columns-1,Math.ceil((entity.xMm+radius)/fogGrid)-1);
      spans[offset+2]=Math.max(0,Math.floor((entity.zMm-radius)/fogGrid))*columns;spans[offset+3]=Math.min(rows-1,Math.ceil((entity.zMm+radius)/fogGrid)-1)*columns;
    }else{
      let [width,height]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[width,height]=[height,width];
      const firstX=entity.xMm-width*grid/2+fogGrid/2,firstZ=entity.zMm-height*grid/2+fogGrid/2;
      const minX=Math.floor(firstX/fogGrid),minZ=Math.floor(firstZ/fogGrid);
      // Preserve the established cell-center samples, including off-grid fixtures.
      const countX=Math.max(0,Math.ceil((entity.xMm+width*grid/2-firstX)/fogGrid)),countZ=Math.max(0,Math.ceil((entity.zMm+height*grid/2-firstZ)/fogGrid));
      spans[offset]=minX;spans[offset+1]=minX+countX-1;spans[offset+2]=minZ*columns;spans[offset+3]=(minZ+countZ-1)*columns;
    }
  }
  return {spans,columns};
}
function visibleStatic(geometry:StaticFootprints,index:number,seen:Uint8Array|undefined):boolean {
  if(!seen)return false;
  const bit=geometry.visibility?.masks.get(seen);if(bit!==undefined)return Boolean(geometry.visibility!.members[index]!&bit);
  const offset=index*4,spans=geometry.spans,minX=spans[offset]!,maxX=spans[offset+1]!,lastRow=spans[offset+3]!;
  for(let row=spans[offset+2]!;row<=lastRow;row+=geometry.columns)for(let x=minX;x<=maxX;x++)if(seen[row+x])return true;
  return false;
}
/** One standalone synchronous batch. Only footprint cells read recipient masks;
 * bit15 records invisible cells too, avoiding an eager full-map mask pass. */
function lazyStaticVisibility(geometry:StaticFootprints,playerIds:readonly string[],factions:readonly PublicPlayer[],masks:ReadonlyMap<string,Uint8Array>):StaticFootprints['visibility'] {
  if(geometry.columns<=0||!factions.length||factions.length>R.factionLimit||new Set(playerIds).size<2)return;
  const known=new Set(factions.map(faction=>faction.id));if(known.size!==factions.length||playerIds.some(id=>!known.has(id)))return;
  const groups=new Map<Uint8Array,number>();let size=0;
  for(const id of playerIds){const mask=masks.get(id);if(!mask)continue;if(nodeTypes.isProxy(mask)||Object.getPrototypeOf(mask)!==Uint8Array.prototype||nodeTypes.isSharedArrayBuffer(admissionTypedBuffer.call(mask)))return;if(!groups.has(mask))groups.set(mask,1<<groups.size);size=Math.max(size,mask.length);}
  if(size>2_000_000||groups.size>=16)return;
  const cells=new Uint16Array(size),members=new Uint16Array(geometry.spans.length/4),spans=geometry.spans;
  for(let index=0;index<members.length;index++){
    const offset=index*4;let bits=0;
    for(let row=spans[offset+2]!;row<=spans[offset+3]!;row+=geometry.columns)for(let x=spans[offset]!;x<=spans[offset+1]!;x++){
      const cell=row+x;if(cell<0||cell>=size)continue;let visible=cells[cell]!;
      if(!(visible&0x8000)){visible=0x8000;for(const [mask,bit]of groups)if(mask[cell])visible|=bit;cells[cell]=visible;}
      bits|=visible&0x7fff;
    }
    members[index]=bits;
  }
  return {members,masks:groups};
}

/** Merge discovered cells without scanning the entire map for every faction.
 * Restored or externally edited noncanonical arrays retain the original mask behavior. */
function mergeExploredCells(prior:readonly number[],visible:readonly number[],seen:Uint8Array):number[] {
  let previous=-1;
  for(const cell of prior){
    if(!Number.isSafeInteger(cell)||cell<0||cell>=seen.length||cell<=previous){
      const explored=new Uint8Array(seen.length),result:number[]=[];
      for(const entry of prior)explored[entry]=1;
      for(let index=0;index<seen.length;index++)if(seen[index]||explored[index])result.push(index);
      return result;
    }
    previous=cell;
  }
  let old=0,current=0;
  while(old<prior.length&&current<visible.length){
    const a=prior[old]!,b=visible[current]!;
    if(a<b)old++;else if(a===b){old++;current++;}else break;
  }
  if(current===visible.length)return prior.slice();
  const result=prior.slice(0,old);
  while(old<prior.length&&current<visible.length){
    const a=prior[old]!,b=visible[current]!;
    if(a<b){result.push(a);old++;}else if(b<a){result.push(b);current++;}else{result.push(a);old++;current++;}
  }
  while(old<prior.length)result.push(prior[old++]!);
  while(current<visible.length)result.push(visible[current++]!);
  return result;
}
/** Indexed reads deliberately reject holes and distinguish an edited -0. */
function sameFogCells(a:readonly number[],b:readonly number[]):boolean {
  if(a.length!==b.length)return false;
  for(let index=0;index<a.length;index++)if(!Object.is(a[index],b[index]))return false;
  return true;
}

/** Fixed-tick world, independent of rendering, sockets, disk and wall-clock time. */
export class Simulation {
  /** Enabled only for a newly constructed instance whose raw state never escapes. */
  private liveOwned=false;
  private liveWorld:Entity[]|undefined;
  private liveActors:Entity[]=[];
  /** Stable role membership only. Every scheduled visit still reads current
   * eligibility and applies the original 50 ms event, in world roster order. */
  private livePhaseRoster:NativePhaseRoster|undefined;
  static phaseRosterDiagnostics(){return {...phaseRosterCounts};}
  static workFlightDiagnostics(){return {...workFlightCounts};}
  static movementRosterDiagnostics(){return {...movementRosterCounts};}
  static resourceObservationDiagnostics(){return {...resourceObservationCounts};}
  private liveStaticRevision=0;
  private liveDepositBuildings:{revision:number;buildings:Building[]}|undefined;
  private readonly nativeCheckpointScope=createNativeCheckpointScope();
  private readonly nativeLocalPathCheckpointScope=createNativePathCheckpointScope();
  private liveResourceViews=new WeakMap<ResourceNode,{amount:number;view:ViewEntity}>();
  private liveMemorySources=new WeakMap<ViewEntity,ViewEntity>();
  /** Payloads remain detached and current whenever visible data changes. Only
   * unchanged visible resource timestamps wait until concealment/frame exit.
   * Retain each recipient's roster across frames: materializing its timestamps
   * must not make every unchanged tree look newly observed on the next frame. */
  private frameResourceObservations=new Map<string,FrameResourceObservation>();
  private frameChangedResources=new Set<ResourceNode>();
  private flushResourceObservations(reset=false):void{
    for(const observation of this.frameResourceObservations.values())if(observation.materializedTick!==observation.tick){
      for(const resource of observation.resources){const memory=observation.vision.memory[resource.id];if(memory){memory.lastSeenTick=Math.max(memory.lastSeenTick??0,observation.tick);resourceObservationCounts.materialized=Math.min(Number.MAX_SAFE_INTEGER,resourceObservationCounts.materialized+1);}}
      observation.materializedTick=observation.tick;
    }
    // Resource actions can disappear after the last vision phase. Keep their
    // pending refresh through save/frame flushes; only a reset discards it.
    if(reset){this.frameResourceObservations.clear();this.frameChangedResources.clear();}
  }
  private static readonly resourceObservationFlush=Simulation.prototype.flushResourceObservations;
  private liveMissingMemory=new Map<string,{revision:number;ids:Set<string>}>();
  private liveKnowledgeBindings=new Map<string,{members:readonly Entity[];mask:Uint8Array|undefined;revision:number}>();
  private liveGhosts=new Map<string,{members:readonly Entity[];mask:Uint8Array|undefined;revision:number;values:ViewEntity[]}>();
  private liveControllerGhosts=new WeakMap<ViewEntity,{tick:number|undefined;view:ViewEntity}>();
  private liveControllerFog=new Map<string,{visible:number[];explored:number[];fog:PlayerView['fog']}>();
  private liveMap:PlayerView['map']|undefined;
  private liveMovementResources=new Set<MovementObstacleSource>();
  private liveMovementActors=new Set<MovementObstacleSource>();
  private liveDepletedResources=new Set<ResourceNode>();
  static createLive(options:SimulationOptions,restored?:SimulationSavePayload):LiveSimulation {
    // Detach before certification: input getters cannot install a temporary
    // constructor hook and then leave an escaped instance certified as owned.
    const settings=structuredClone(options),payload=restored?structuredClone(restored):undefined;
    const canonical=canonicalLiveSurfaces();
    const simulation=new Simulation(settings,payload);
    simulation.liveOwned=canonical&&canonicalLiveSurfaces();
    const check=simulation.checkLiveOwnership;
    return createLiveSimulationFacade(simulation,()=>check.call(simulation),()=>simulation.liveOwned);
  }
  private checkLiveOwnership():void {
    if(!this.liveOwned||canonicalLiveSurfaces())return;
    if(this.frameCombatTimeline){Simulation.combatTimelineFlush.call(this.frameCombatTimeline);this.frameCombatTimeline=undefined;}
    Simulation.resourceObservationFlush.call(this,true);
    this.liveOwned=false;this.frameMovementIndex=undefined;this.activeWorkRoster=undefined;this.activeGatherJobs=new WeakMap();this.liveWorld=undefined;this.liveActors=[];this.livePhaseRoster=undefined;this.liveDepositBuildings=undefined;
    this.liveKnowledgeBindings.clear();this.liveGhosts.clear();this.liveMissingMemory.clear();this.liveControllerFog.clear();this.liveControllerGhosts=new WeakMap();
    this.liveExploredMasks.clear();
    this.liveResourceViews=new WeakMap();this.liveMemorySources=new WeakMap();this.liveMap=undefined;this.physicalObstacleRecords.clear();this.physicalObstacleRoster=undefined;this.staticKnowledgeCertificate=undefined;this.liveVisionSources=undefined;
  }
  readonly state:SimulationState;
  readonly options:SimulationOptions;
  readonly random:SeededRandom;
  private navigationCache:Navigation|undefined;
  private navigationVersion=-1;
  /** Actual physical shapes only; recipient fog/planning policy never enters it. */
  private physicalObstacleRecords=new Map<Entity,SharedObstacleRecord>();
  /** Private live geometry membership excludes the depleted-resource archive.
   * Insertion order remains canonical; depletion removes exactly that source. */
  private physicalObstacleRoster?:{revision:number;members:Set<Building|ResourceNode>};
  private visibilityMasks=new Map<string,Uint8Array>();
  /** Recipient-owned public arrays are checked against private phase results.
   * Neither identity alone nor mutable public fog can certify unchanged content. */
  private committedFog=new Map<string,{mask:Uint8Array;source:readonly number[];visible:number[];explored:number[];exploredBaseline:readonly number[]}>();
  private liveExploredMasks=new Map<string,{array:number[];mask:Uint8Array}>();
  private visionCacheKey='';
  private visionTerrain:SimulationState['map']['terrain']|undefined;
  private visionBlockers:Obstacle[]=[];
  private visionBlockersVersion=-1;
  private visionCheckedNavigationRevision=-1;
  private liveVisionSources:{actors:readonly Entity[];epoch:number;cacheKey:string;owners:{id:string;key:string}[];groups:readonly VisionMaskGroup[];slots:{entity:Entity;ownerId:string;typeId:string;group:number;index:number;source:VisionMaskSource}[]}|undefined;
  private frameCombatTimeline:NativeCombatTimeline|undefined;
  private frameCombatTimelineChecked=false;
  private static readonly combatTimelineFlush=NativeCombatTimeline.prototype.flush;
  private flushCombatTimeline():void{if(this.frameCombatTimeline){Simulation.combatTimelineFlush.call(this.frameCombatTimeline);this.frameCombatTimeline=undefined;}}
  private pendingMissing:ResourceBank|undefined;
  private planningNavigations=new Map<string,PlanningNavigation>();
  private planningGeometryCache=new Map<string,{profile:PlanningNavigation|undefined;value:PathPlanningGeometry}>();
  private knownObstacleRecords=new Map<string,{seen:boolean;records:Map<string,KnownObstacleRecord>;obstacles?:Obstacle[]}>();
  /** Sparse, phase-owned geometry for new or unsubscribed sources. Unchanged
   * subscribed geometry stays in its persistent owner instead of being copied. */
  private movementObstaclePreparation:Map<Entity,SharedObstacleRecord>|undefined;
  /** Disposable geometry dependencies, never a source of recipient knowledge. */
  private movementObstacleSources=new Map<Entity,MovementObstacleSource>();
  private movementObstacleCertificates=new Map<string,MovementObstacleCertificate>();
  private movementDependencyPreparation:MovementDependencyPreparation|undefined;
  private planningRefreshDiagnostic:unknown;
  /** One native, non-yielding command run; never a public callback lease. */
  private nativeAdmissionPreparation:{playerId:string;navigation?:Navigation}|undefined;
  private nativeAdmissionActive=false;
  private knownTerrain:{sources:KnownTerrainSource[];obstacles:Obstacle[]}|undefined;
  private knownStaticRecords=new Map<string,{members:readonly Entity[];ids:ReadonlySet<string>;combined:Entity[]}>();
  private pathScheduler:PathScheduler|RemotePathScheduler;
  private readonly visionKernel=new VisionMaskKernel();
  private visionExecutor:((frame:VisionMaskFrame,binding:{matchId:string;matchEpoch:number;tick:number;phase:string})=>Promise<VisionMaskResult[]>)|undefined;
  private stepping=false;
  /** One coarse commit contains only small mechanical/contact quanta. Planning
   * service, navigation preparation and publication are not repeated per quantum. */
  private coarseFrame=false;
  private frameNavigationRevision=-1;
  private frameNavigationPolicy='';
  private frameStaticMembers=new Map<string,readonly Entity[]>();
  private frameDeferredKnowledge=false;
  private framePlanningDiagnostics=new Map<string,unknown>();
  private frameTraces=new Map<string,Map<string,NonNullable<ViewEntity['motionTrace']>>>();
  private frameVisualTraces=new Map<string,Map<string,NonNullable<ViewEntity['visualTrace']>&{lastSampleTick:number}>>();
  /** A completed vision commit certifies actor membership at this exact event.
   * Restores and boundary roster/epoch changes must use scalar trace filtering. */
  private tracePerceptionSnapshot?:{world:readonly Entity[];tick:number;epoch:number;groups:{playerId:string;key:string;mask:Uint8Array}[]};
  private frameStartTick=0;
  private frameEndTick=0;
  /** Keep the native coarse profile fixed; its recorded tier selects the next
   * commit span without changing the 50 ms mechanical/contact event lattice. */
  get authoritativeFrameIntervalMs():50|300|450|600{return this.options.authoritativeIntervalMs===300?([300,450,600,600] as const)[this.state.movementCadenceTier]:50;}
  private planningServiceLeases:number|undefined;
  setPlanningServiceLeases(leases:number):void{if(this.stepping||!Number.isInteger(leases)||leases<1||leases>60)throw new Error('INVALID_PLANNING_SERVICE_LEASES');this.planningServiceLeases=leases;}
  private initializeFramePlanner():void{
    if(this.options.authoritativeIntervalMs!==300||this.pathScheduler instanceof RemotePathScheduler)return;
    this.pathScheduler=RemotePathScheduler.createSynchronous(this.state.factions.map(faction=>faction.id),this.pathScheduler.exportState(),this.planningGeometries());rememberAdmissionHelper(this.pathScheduler);
  }
  private admitFramePlanning(expectedLeases?:number):boolean{
    if(!(this.pathScheduler instanceof RemotePathScheduler))throw new Error('MISSING_FRAME_PLANNER');
    const admission=this.pathScheduler.admitServiceLeases(expectedLeases);
    if(!admission){if(expectedLeases!==undefined)throw new Error('REPLAY_PLANNING_ADMISSION_NOT_READY');this.pathScheduler.stopServiceAfterCurrent();return false;}
    if(expectedLeases!==undefined&&admission.leases.length!==expectedLeases)throw new Error('REPLAY_PLANNING_ADMISSION_MISMATCH');
    this.lastPathWork=admission.report;this.installFrameLocalPrefetch();this.record({kind:'planning_service_admit',leases:admission.leases.length});return true;
  }
  private startFramePlanning(leases:number):void{
    if(!(this.pathScheduler instanceof RemotePathScheduler))throw new Error('MISSING_FRAME_PLANNER');
    const idle=!this.pathScheduler.serviceStatus().pending,deferred=this.options.localPlanningMode==='deferred-v1';
    const groups=idle&&deferred?this.prepareFrameLocalJobs(leases):undefined;
    const queries=idle&&!deferred&&this.liveOwned?this.prepareFrameLocalPrefetch():[];
    if(this.pathScheduler.startServiceLeases(4000,this.planningGeometries(),this.state.tick,leases,queries,groups))this.record({kind:'planning_service_start',leases});
    else if(this.replayMode)throw new Error('REPLAY_PLANNING_SERVICE_BUSY');
  }
  private prepareFrameLocalJobs(leases:number):LocalPathQuery[][]{
    const candidates=new Map(this.state.factions.map(faction=>[faction.id,[] as LocalPathCandidate[]])),index=this.movementUnits;
    for(const entity of this.actors())if(entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn&&entity.path[0]&&!this.state.economies[entity.ownerId]!.defeated){const body=index.body(entity.id);if(body)candidates.get(entity.ownerId)!.push({body,target:entity.path[0],following:entity.path[1],remainingPath:entity.path,orderRevision:entity.orderRevision??0});}
    const share=Math.max(1,Math.floor(8/this.state.factions.length)),groups:LocalPathQuery[][]=Array.from({length:leases},()=>[]);
    for(const faction of this.state.factions){const profile=this.planningNavigations.get(faction.id);if(!profile)continue;
      const queries=this.avoidance(faction.id).prepareDeferredQueries(faction.id,profile.revision,candidates.get(faction.id)!,index,id=>{const entity=this.state.entities[id];return Boolean(entity&&(entity.ownerId===faction.id||this.visible(faction.id,entity)));},share*leases,this.state.tick);
      for(let lease=0;lease<leases;lease++)groups[lease]!.push(...queries.slice(lease*share,(lease+1)*share));
    }
    return groups;
  }
  /** Speculation never spends contact credits or becomes saved authority. Cold
   * restore and replay compute the identical answer through ordinary fallback. */
  private prepareFrameLocalPrefetch(){
    const candidates=new Map(this.state.factions.map(faction=>[faction.id,[] as LocalPathCandidate[]])),index=this.movementUnits;
    for(const entity of this.actors())if(entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn&&entity.path[0]&&!this.state.economies[entity.ownerId]!.defeated){const body=index.body(entity.id);if(body)candidates.get(entity.ownerId)!.push({body,target:entity.path[0],following:entity.path[1],remainingPath:entity.path});}
    const limit=Math.max(1,Math.floor(8/this.state.factions.length));
    return this.state.factions.flatMap(faction=>{const profile=this.planningNavigations.get(faction.id);return profile?this.avoidance(faction.id).prepareServiceQueries(faction.id,profile.revision,candidates.get(faction.id)!,index,id=>{const entity=this.state.entities[id];return Boolean(entity&&(entity.ownerId===faction.id||this.visible(faction.id,entity)));},this.state.tick+this.authoritativeFrameIntervalMs/50,limit):[];});
  }
  private installFrameLocalPrefetch():void{
    if(!(this.pathScheduler instanceof RemotePathScheduler))return;
    const results=this.pathScheduler.takeLocalResults();
    if(this.options.localPlanningMode==='deferred-v1'){for(const faction of this.state.factions)this.avoidance(faction.id).admitDeferredResults(results.filter(result=>result.query?.profile===faction.id),this.state.tick,this.state);return;}
    if(!this.liveOwned||!results.length)return;
    for(const faction of this.state.factions){const profile=this.planningNavigations.get(faction.id);if(profile)this.avoidance(faction.id).installParallelResults(results.filter(result=>result.query.profile===faction.id),profile.navigation,profile.revision,this.state.tick+this.authoritativeFrameIntervalMs/50);}
  }
  private frameCosts:Record<string,number>={};
  private frameMeasure<T>(name:string,operation:()=>T):T{const start=performance.now();try{return operation();}finally{this.frameCosts[name]=(this.frameCosts[name]??0)+performance.now()-start;}}
  frameDiagnostics(){
    const localPlanning=this.options.localPlanningMode==='deferred-v1'?{mode:'deferred-v1' as const,waitingForCredit:0,queued:0,inflight:0,ready:0,retry:0,oldestWaitMs:0,prepared:0,admitted:0,used:0,discarded:0}:undefined;
    if(localPlanning)for(const avoidance of this.localAvoidance.values()){
      const counts=avoidance.deferredDiagnostics(this.state.tick);if(!counts)continue;
      for(const key of ['waitingForCredit','queued','inflight','ready','retry','prepared','admitted','used','discarded'] as const)localPlanning[key]+=counts[key];
      localPlanning.oldestWaitMs=Math.max(localPlanning.oldestWaitMs,counts.oldestWaitTicks*1000/R.simulationHz);
    }
    return {frameRevision:this.state.frameRevision??0,committedTimeMs:this.state.tick*1000/R.simulationHz,authoritativeIntervalMs:this.authoritativeFrameIntervalMs,phases:{...this.frameCosts},...(localPlanning?{localPlanning}:{})};
  }
  private actors():Entity[]{const world=this.all();return this.liveOwned?this.liveActors:world.filter(entity=>entity.kind!=='resource');}
  private planningDiagnosticNow:(()=>number)|undefined;
  private lastPathWork:PathWorkReport={work:0,pending:0,ready:0,blocked:0,regionCount:0,cacheHits:0};
  private approachReservations=new Map<string,ApproachReservations>();
  private admissionNavigations=new Map<string,{navigation:Navigation;revision:number}>();
  /** Work changes live amounts/completion, but not positions or fog. Geometry is lazy. */
  private workFrame:{knowledge?:StaticKnowledgeFrame}|undefined;
  private workCoarseKnowledge?:{tick:number;revision:number;staticRevision:number;entities:Entity[];members:(readonly Entity[])[];knowledge:StaticKnowledgeFrame};
  private workReachability=new WeakMap<Unit,{tick:number;revision:number;target:Entity;order:Order|undefined;orderKind:Order['kind']|undefined;orderPhase:Order['phase'];orderRevision:number|undefined;path:Position[];unitType:Unit['typeId'];ownerId:string;research:number;targetOwner:Entity['ownerId'];targetType:Entity['typeId'];x:number;z:number;targetX:number;targetZ:number;halfWidth:number;halfHeight:number;width:number;height:number;reachable:boolean}>();
  private frameWorkWaits=new WeakMap<Unit,FrameWorkWait>();
  private frameMovementWaits=new WeakMap<Unit,FrameMovementWait>();
  private frameWorkFaceWaits=new WeakMap<Unit,FrameWorkFaceWait>();
  private frameWorkSchedulingCounts={transit:0,resourceWait:0,moveWait:0,workFaceWait:0,contact:0,pinnedDropoffs:0};
  private frameStraightFlights=new WeakMap<Unit,FrameStraightFlight>();
  private frameFlightResearch='';
  private frameFlightMaximumStep=0;
  /** One boundary formation refresh; never retained across a command mutation. */
  private formationKnowledge:StaticKnowledgeFrame|undefined;
  /** Valid only inside movement, where static geometry and fog do not change. */
  private movementFrame:(StaticKnowledgeFrame&{units:UnitSpatialIndex;planning:Map<string,Navigation>})|undefined;
  private readonly movementUnits=new UnitSpatialIndex();
  /** Native event hooks maintain positions, order versions and membership after
   * one full reconciliation. This proof is only for the current coarse frame;
   * it never certifies visibility, actor perception or a mutable public world. */
  private frameMovementIndex:{state:SimulationState;epoch:number;frame:number;world:readonly Entity[];index:UnitSpatialIndex}|undefined;
  private readonly perceptionMembership=new PerceptionMembership();
  private liveVisionActors?:{actors:readonly Entity[];members:Entity[]};
  private constructionOccupancy?:{state:SimulationState;revision:number;buckets:Map<string,Entity[]>};
  private readonly observedActionCache=new ObservedActionCache();
  private perceptionWorld:readonly Entity[]|undefined;
  /** Static queries can reuse a completed private membership commit even after
   * actors move. This certifies no actor position or current actor visibility. */
  private staticKnowledgeCertificate:{state:SimulationState;epoch:number;world:readonly Entity[];membership:PerceptionMembership;staticRevision:number;navigationRevision:number;width:number;height:number;groups:{playerId:string;key:string;mask:Uint8Array}[]}|undefined;
  /** Entity membership is stable between explicit insertions/removals within a tick. */
  private tickFrame:{entities?:Entity[];gateUnitsCanonical?:boolean}|undefined;
  private gatePhaseDiagnostics:Partial<Record<'advanceTransitions'|'advanceGates',unknown>>={};
  /** Static spans only; every recipient and presentation field remains live. */
  private controllerViewFrame:{current?:ControllerViewGeometry;verify?:boolean}|undefined;
  private localAvoidance=new Map<string,LocalAvoidance>();
  /** Derived proofs never survive restore and never authorize unswept movement. */
  private movementDecisions=new WeakMap<Unit,MovementDecision>();
  private movementDecisionCounts={full:0,reused:0,attempted:0};
  movementDecisionDiagnostics():{full:number;reused:number;attempted:number}{return {...this.movementDecisionCounts};}
  setMovementCadenceTier(tier:MovementCadenceTier):void{
    if(!Number.isInteger(tier)||tier<0||tier>3)throw new Error('INVALID_MOVEMENT_CADENCE_TIER');
    if(this.stepping||this.phase!=='boundary')throw new Error('MOVEMENT_CADENCE_REQUIRES_BOUNDARY');
    if(tier===this.state.movementCadenceTier)return;
    this.state.movementCadenceTier=tier;this.movementDecisions=new WeakMap();this.publicationUrgency.reset();
    // The next published cadence must not relabel an older, longer trace as a
    // shorter interval. Clients hold this boundary and receive fresh complete
    // history after the next commit; authority, fog and paths are untouched.
    this.frameTraces.clear();this.frameVisualTraces.clear();this.record({kind:'movement_cadence',tier});
  }
  private progression:Progression;
  private wards=new WardSystem();
  private phase:'boundary'|'controllers'='boundary';
  /** Set only by the private worker diagnostic installer; never captured. */
  private controllerProfiler:ControllerProfiler|undefined;
  private committedActions=new Map<string,CommittedAction>();
  private frameActivity=new Map<string,{id:string;playerId:string;kind:CommittedUnitActionKind;ticks:number}>();
  private frameActivityEndTick=-1;
  private commandSource:CommandSource|undefined;
  /** Original function slot permits opt-in worker profiling without module-global hooks. */
  private readonly formationTargets=formationTargets;
  private readonly advanceTransitions=advanceTransitions;
  private readonly advanceGates=advanceGates;
  private readonly updateEngagements=updateEngagements;
  private readonly advanceGarrisons=advanceGarrisons;
  private readonly advanceCombat=advanceCombat;
  private journal=new JournalBuffer();
  private replayControllerHook:(()=>void)|undefined;
  private replayMode=false;
  /** Wall-clock presentation metadata, never part of authoritative state or saves. */
  private presentationSpeed=1;
  setPresentationSpeed(speed:number):void {
    if(!Number.isFinite(speed)||speed<.1||speed>1)throw new Error('INVALID_PRESENTATION_SPEED');
    this.presentationSpeed=speed;
  }
  private initialPayload:SimulationSavePayload;
  private reservations(playerId:string):ApproachReservations{let reservations=this.approachReservations.get(playerId);if(!reservations){reservations=new ApproachReservations();this.approachReservations.set(playerId,reservations);}return reservations;}
  private avoidance(playerId:string):LocalAvoidance{let avoidance=this.localAvoidance.get(playerId);if(!avoidance){avoidance=new LocalAvoidance(this.options.localPlanningMode);this.localAvoidance.set(playerId,avoidance);if(this.planningDiagnosticNow)avoidance.enablePlanningDiagnostics({tick:()=>this.state.tick,now:this.planningDiagnosticNow});}return avoidance;}
  constructor(options:SimulationOptions,restored?:SimulationSavePayload) {
    if(options.factions.length<2||options.factions.length>R.factionLimit)throw new Error('INVALID_FACTION_COUNT');
    if(options.factions.some(f=>!/^[_A-Za-z0-9-]{1,96}$/.test(f.id)||Object.hasOwn(Object.prototype,f.id)||f.id==='prototype'))throw new Error('INVALID_FACTION_ID');
    if(new Set(options.factions.map(p=>p.id)).size!==options.factions.length)throw new Error('DUPLICATE_FACTION');
    if(new Set(options.factions.map(p=>p.teamId)).size<2)throw new Error('NEEDS_OPPOSING_TEAMS');
    if(![80,120,200].includes(options.populationLimit??R.defaultPopulationLimit))throw new Error('INVALID_POPULATION_LIMIT');
    this.options=structuredClone(options);const ruleset=resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset);this.options.rulesetId=ruleset.rulesetId;this.options.maxAge=ruleset.maxAge;this.options.startingResourcePreset=options.startingResourcePreset??ruleset.startingResourcePreset;
    if(restored){if(restored.options.localPlanningMode)this.options.localPlanningMode=restored.options.localPlanningMode;else delete this.options.localPlanningMode;}
    else if(this.options.authoritativeIntervalMs===300)this.options.localPlanningMode??='deferred-v1';
    if(this.options.localPlanningMode&&this.options.authoritativeIntervalMs!==300)throw new Error('INVALID_LOCAL_PLANNING_PROFILE');
    this.random=new SeededRandom(options.seed);
    if(restored){
      this.state=structuredClone(restored.state);this.state.movementCadenceTier??=0;this.random.state=this.state.randomState;
      // Legacy captures may omit identity metadata. Normalize it once so future
      // captures agree with resolved options without changing the old content.
      this.state.rulesetId=ruleset.rulesetId;this.state.maxAge=ruleset.maxAge;this.state.startingResourcePreset=this.options.startingResourcePreset;
      this.pathScheduler=new PathScheduler(profile=>this.planningNav(profile),restored.runtime.profileIds);this.progression=new Progression(this.state);
      for(const [playerId,profile]of restored.runtime.planningProfiles)if(profile.revision>0){const entries=structuredClone(profile.obstacles);this.planningNavigations.set(playerId,{revision:profile.revision,obstacles:new Map(entries),navigation:createOwnedNavigation(this.state.widthMm,this.state.heightMm,entries.map(([,obstacle])=>obstacle))});}
      this.pathScheduler.importState(restored.runtime.pathScheduler);
      rememberAdmissionHelper(this.pathScheduler);
      for(const [playerId,saved]of restored.runtime.approachReservations)this.reservations(playerId).importState(saved);
      for(const [playerId,saved]of restored.runtime.localAvoidance)this.avoidance(playerId).importState(saved);
      for(const faction of this.state.factions){const mask=new Uint8Array(Math.floor(this.state.widthMm/fogGrid)*Math.floor(this.state.heightMm/fogGrid));for(const cell of this.state.vision[faction.id]!.visible)mask[cell]=1;this.visibilityMasks.set(faction.id,mask);}
      this.initialPayload=this.capture();this.initializeFramePlanner();return;
    }
    const map=generateMap(this.options);
    this.state={rulesetId:ruleset.rulesetId,maxAge:ruleset.maxAge,startingResourcePreset:this.options.startingResourcePreset,matchId:options.matchId,matchEpoch:options.epoch??1,tick:0,sequence:0,randomState:this.random.state,movementCadenceTier:0,
      secretIdKey:options.secretIdKey??String(options.seed),entityNonce:0,status:'RUNNING',factions:structuredClone(options.factions),receipts:{},eventOrdinal:0,commandLog:[],
      entities:{},economies:{},vision:{},controllers:{},control:{},pathAdmission:{},widthMm:map.widthMm,heightMm:map.heightMm,map:{type:map.type,generatorVersion:map.generatorVersion,terrain:map.terrain,validation:map.validation,seed:map.seed},navigationRevision:0,projectiles:[],effects:[],ageAnnouncements:[]};
    this.pathScheduler=new PathScheduler(profile=>this.planningNav(profile),options.factions.map(faction=>faction.id));
    rememberAdmissionHelper(this.pathScheduler);
    this.progression=new Progression(this.state);
    this.initialize(map);this.updateVision();this.observeActions();this.initialPayload=this.capture();this.initializeFramePlanner();
  }
  private id():string{return `e_${createHmac('sha256',this.state.secretIdKey).update(`entity:${++this.state.entityNonce}`).digest('hex').slice(0,32)}`;}
  private all():Entity[]{
    if(this.liveOwned){
      if(!this.liveWorld){
        this.liveWorld=Object.values(this.state.entities);this.liveActors=this.liveWorld.filter(entity=>entity.kind!=='resource');
        this.livePhaseRoster=undefined;
        if(this.options.authoritativeIntervalMs===300&&this.liveActors.length<=MAX_WORLD_ACTORS){
          const gates:Building[]=[],trebuchets:Unit[]=[],mobileHosts:Unit[]=[],farms:Building[]=[],structures:Building[]=[],productionIndexes=new Map<Building,number>();
          for(const actor of this.liveActors){
            if(actor.kind==='building'){productionIndexes.set(actor,structures.length);structures.push(actor);if(isGate(actor))gates.push(actor);if(actor.typeId==='farm')farms.push(actor);}
            else if(actor.kind==='unit'){if(units[actor.typeId].deploySeconds)trebuchets.push(actor);if(units[actor.typeId].mobileGarrisonCapacity)mobileHosts.push(actor);}
          }
          const production=new Uint32Array(Math.ceil(structures.length/32));
          for(let index=0;index<structures.length;index++)if(structures[index]!.queue.length)production[index>>>5]!|=1<<(index&31);
          this.livePhaseRoster={gates,trebuchets,mobileHosts,farms,buildings:structures,productionIndexes,production};countPhaseRoster('rebuilt');
        }
      }
      if(this.tickFrame&&!this.tickFrame.entities){
        const prior=this.frameMovementIndex;
        if(this.coarseFrame&&prior?.state===this.state&&prior.epoch===this.state.matchEpoch&&prior.frame===this.frameStartTick&&prior.world===this.liveWorld&&prior.index===this.movementUnits)countMovementRoster('reused');
        else{
          // Clear before scanning so a failed reconciliation cannot retain a
          // proof for partially updated storage. Mutable/generic readers below
          // still reconcile at every original tick boundary.
          this.frameMovementIndex=undefined;let visited=0;
          this.movementUnits.beginRoster();for(const entity of this.liveActors)if(entity.kind==='unit'){this.updateMovementUnit(entity);visited++;}this.movementUnits.endRoster();
          if(this.coarseFrame){this.frameMovementIndex={state:this.state,epoch:this.state.matchEpoch,frame:this.frameStartTick,world:this.liveWorld,index:this.movementUnits};countMovementRoster('reconciled');countMovementRoster('unitsVisited',visited);}
        }
        this.tickFrame.entities=this.liveWorld;this.tickFrame.gateUnitsCanonical=true;
      }
      return this.liveWorld;
    }
    if(!this.tickFrame){
      // Object.values' exact own-key/descriptor/Get order, including live accessors.
      const record=this.state.entities,entities:Entity[]=[];
      for(const key of Reflect.ownKeys(record)){if(typeof key!=='string')continue;const descriptor=Object.getOwnPropertyDescriptor(record,key);if(descriptor?.enumerable)entities.push(record[key]!);}
      return entities;
    }
    if(this.tickFrame.entities)return this.tickFrame.entities;
    // Preserve the existing roster enumeration/order. Reconcile external fixture
    // edits here, without a second world scan or temporary MovementBody records.
    // Schema records and pure instrumentation getters are supported; field
    // accessors that themselves mutate gameplay state cannot certify an index.
    const entities:Entity[]=[],factionIds=new Set(this.state.factions.map(faction=>faction.id));this.tickFrame.gateUnitsCanonical=false;let canonicalUnits=true;this.movementUnits.beginRoster();
    for(const id in this.state.entities)if(Object.hasOwn(this.state.entities,id)){
      const entity=this.state.entities[id]!;entities.push(entity);
      // The scalar gate predicate reads hostility/economy before distance. A
      // malformed distant owner must therefore keep that original scalar path.
      if(entity.kind!=='resource'&&(!factionIds.has(entity.ownerId)||!Object.hasOwn(this.state.economies,entity.ownerId)||!this.state.economies[entity.ownerId]))canonicalUnits=false;
      if(entity.kind==='unit'){if(entity.id!==id)canonicalUnits=false;this.updateMovementUnit(entity);}
    }
    this.movementUnits.endRoster();this.tickFrame.gateUnitsCanonical=canonicalUnits;return this.tickFrame.entities=entities;
  }
  private updateMovementUnit(unit:Unit):void{if(unit.hp>0&&!unit.garrisonedIn)this.movementUnits.update(unit.id,unit.xMm,unit.zMm,units[unit.typeId].collisionRadiusM*1000,unit.orderRevision??0,unit);else this.movementUnits.delete(unit.id);}
  private invalidateEntityRoster(staticChanged=false):void{this.frameMovementIndex=undefined;this.liveWorld=undefined;this.livePhaseRoster=undefined;if(staticChanged){this.wards.invalidate();this.liveStaticRevision++;this.liveDepositBuildings=undefined;}if(this.tickFrame){this.tickFrame.entities=undefined;this.tickFrame.gateUnitsCanonical=false;}if(this.workFrame)delete this.workFrame.knowledge;}
  private phaseRoster():NativePhaseRoster|undefined{if(!this.liveOwned||!this.coarseFrame)return;this.all();return this.livePhaseRoster;}
  /** Queue mutations do not otherwise change entity membership. Rebuilding a
   * cold/native roster seeds these bits directly from the authoritative queues. */
  private updateProductionMembership(building:Building):void{
    if(!this.liveOwned)return;const roster=this.livePhaseRoster,index=roster?.productionIndexes.get(building);if(!roster||index===undefined)return;
    if(building.queue.length)roster.production[index>>>5]!|=1<<(index&31);else roster.production[index>>>5]!&=~(1<<(index&31));
  }
  private *productionCandidates(roster:NativePhaseRoster):IterableIterator<Building>{
    // The captured ordered roster matches the old phase-local array even when
    // completing a training job inserts an actor and invalidates later phases.
    for(let word=0;word<roster.production.length;word++){
      let remaining=roster.production[word]!;
      while(remaining){const bit=31-Math.clz32(remaining&-remaining);remaining&=~(1<<bit);const building=roster.buildings[word*32+bit];if(building){countPhaseRoster('production');yield building;}}
    }
  }
  private synchronizePerception(world:readonly Entity[]):boolean {
    // A failed or partial reconciliation invalidates the previous certificate.
    this.staticKnowledgeCertificate=undefined;
    return this.liveOwned?this.perceptionMembership.synchronizeOwned(world,this.liveActors,this.state.widthMm,this.state.heightMm,this.liveStaticRevision):this.perceptionMembership.synchronize(world,this.state.widthMm,this.state.heightMm);
  }
  private rememberStaticKnowledge(world:readonly Entity[]):void {
    if(!this.liveOwned||world!==this.liveWorld||this.state.factions.length>R.factionLimit)return;
    const groups:{playerId:string;key:string;mask:Uint8Array}[]=[],masks=new Map<string,Uint8Array>();
    const size=Math.floor(this.state.widthMm/fogGrid)*Math.floor(this.state.heightMm/fogGrid);
    for(const faction of this.state.factions){
      const key=this.visionGroup(faction.id),mask=this.visibilityMasks.get(faction.id);
      if(!mask||mask.length!==size||masks.has(key)&&masks.get(key)!==mask)return;
      masks.set(key,mask);groups.push({playerId:faction.id,key,mask});
    }
    this.staticKnowledgeCertificate={state:this.state,epoch:this.state.matchEpoch,world,membership:this.perceptionMembership,staticRevision:this.liveStaticRevision,navigationRevision:this.state.navigationRevision,width:this.state.widthMm,height:this.state.heightMm,groups};
  }
  private reusableStaticKnowledge(world:readonly Entity[]):boolean {
    const prior=this.staticKnowledgeCertificate;
    return this.liveOwned&&!!prior&&prior.state===this.state&&prior.epoch===this.state.matchEpoch&&prior.world===world&&world===this.liveWorld&&prior.membership===this.perceptionMembership&&prior.staticRevision===this.liveStaticRevision&&prior.navigationRevision===this.state.navigationRevision&&prior.width===this.state.widthMm&&prior.height===this.state.heightMm
      &&prior.groups.length===this.state.factions.length&&prior.groups.every((group,index)=>group.playerId===this.state.factions[index]!.id&&group.key===this.visionGroup(group.playerId)&&group.mask===this.visibilityMasks.get(group.playerId));
  }
  // Natural-node zero means physically exhausted. Round a positive fractional
  // remainder up so clients/controllers do not treat a still-solid node as gone.
  private liveResourceView(entity:ResourceNode):ViewEntity {
    const amount=Math.ceil(entity.amount/scale),prior=this.liveResourceViews.get(entity);
    if(prior?.amount===amount)return prior.view;
    const view:ViewEntity={id:entity.id,kind:entity.kind,typeId:entity.typeId,ownerId:entity.ownerId,xMm:entity.xMm,zMm:entity.zMm,hp:entity.hp,maxHp:entity.maxHp,resource:entity.resource,amount,...(entity.forest?{forest:structuredClone(entity.forest)}:{})};
    this.liveResourceViews.set(entity,{amount,view});return view;
  }
  private static readonly gatePhaseReaders=Object.freeze({guard:Simulation.prototype.canonicalGatePhaseReaders,all:Simulation.prototype.all,updateMovementUnit:Simulation.prototype.updateMovementUnit,hostile:Simulation.prototype.hostile,advanceTransitions,advanceGates});
  /** Only the host's explicitly owned timing wrappers preserve gate-phase proof. */
  registerGatePhaseDiagnostic(stage:'advanceTransitions'|'advanceGates',original:unknown,wrapper:unknown):(()=>void)|undefined {
    if(stage!=='advanceTransitions'&&stage!=='advanceGates')return;
    if(original!==Simulation.gatePhaseReaders[stage]||typeof wrapper!=='function'||this[stage]!==wrapper)return;
    this.gatePhaseDiagnostics[stage]=wrapper;
    return ()=>{if(this.gatePhaseDiagnostics[stage]===wrapper)delete this.gatePhaseDiagnostics[stage];};
  }
  private canonicalGatePhaseReaders():boolean {
    const original=Simulation.gatePhaseReaders;
    return this.all===original.all&&this.updateMovementUnit===original.updateMovementUnit&&this.hostile===original.hostile
      &&(this.advanceTransitions===original.advanceTransitions||this.advanceTransitions===this.gatePhaseDiagnostics.advanceTransitions)
      &&(this.advanceGates===original.advanceGates||this.advanceGates===this.gatePhaseDiagnostics.advanceGates);
  }
  private owned(playerId:string):Entity[]{const world=this.all();return (this.liveOwned?this.liveActors:world).filter(e=>e.ownerId===playerId);}
  private complete(e:Entity):boolean{return e.kind==='building'&&e.work>=e.required;}
  private initialize(map:GeneratedMap):void {
    this.state.factions.forEach(faction=>{
      const bank=emptyBank();for(const r of resources)bank[r]=balance.start.resources[r]*scale;
      this.state.economies[faction.id]={resources:bank,age:balance.start.age,defeated:false,collected:emptyBank(),spent:emptyBank(),lastClientSequence:0,autoReseed:false,ledger:[],lostCargo:emptyBank(),notifications:[],technologies:[],researchRevision:0,statistics:{unitsTrained:0,unitsLost:0,buildingsBuilt:0,buildingsLost:0,ageTicks:{1:0},fallbackTicks:0,modelReadyTicks:0,inferenceFailures:0}};
      this.state.vision[faction.id]={visible:[],explored:[],memory:{},actions:{}};
      this.state.controllers[faction.id]=createCommanderState(this.state.matchId,faction.id);
      this.state.control[faction.id]={mode:faction.kind==='ai'?'ai':'human',generation:0,memory:emptyCaretakerMemory(),suspendedOrders:{},...(faction.kind==='human'?{assistant:{...createAssistantControl(),preferences:{...defaultAssistantPreferences(),...faction.assistant}}}:{})};
      this.state.pathAdmission![faction.id]={tick:0,remaining:50000,used:0};
      const spawn=map.spawns.find(s=>s.playerId===faction.id)!;
      for(const building of spawn.buildings)this.addBuilding(faction.id,building.typeId,building.position,building.rotation,true);
      for(const unit of spawn.units)this.addUnit(faction.id,unit.typeId,unit.position);
    });
    for(const resource of map.resources)this.addResource(resource.resource,resource,resource.amount,resource.typeId);
    this.state.randomState=this.random.state;
  }
  private addBuilding(ownerId:string,typeId:BuildingId,position:Position,rotation:Rotation,completed=false,pendingConstruction?:Building['pendingConstruction']):Building {
    const def=this.progression.building(ownerId,typeId),initial=Math.floor(def.maxHp*R.foundationStartingHpFraction);
    const building:Building={id:this.id(),kind:'building',ownerId,typeId,...position,hp:completed?def.maxHp:initial,maxHp:def.maxHp,rotation,work:completed?def.buildSeconds*R.simulationHz*100:0,required:def.buildSeconds*R.simulationHz*100,grantedHp:completed?def.maxHp:initial,queue:[],cooldown:0,repairCredits:{},repairRemainders:{},...(typeId==='farm'?{foodRemaining:completed?def.foodCapacity!*scale:0}:{})};
    if(pendingConstruction)building.pendingConstruction=pendingConstruction;
    if(def.defaultGateMode){building.gateMode=def.defaultGateMode;building.gateOpen=false;}
    this.state.entities[building.id]=building;this.invalidateEntityRoster(true);this.state.navigationRevision++;return building;
  }
  private addUnit(ownerId:string,typeId:UnitId,position:Position):Unit {
    const def=this.progression.unit(ownerId,typeId),unit:Unit={id:this.id(),kind:'unit',ownerId,typeId,...position,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:this.state.navigationRevision,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'defensive',repathAtTick:0,orderRevision:0,...(typeId==='villager'?{autoGather:true}:{}),...(units[typeId].deploySeconds?{deploymentState:'packed' as const}:{})};
    this.state.entities[unit.id]=unit;this.updateMovementUnit(unit);this.invalidateEntityRoster();return unit;
  }
  private addResource(resource:ResourceType,position:Position&{forest?:ResourceNode['forest']},amount:number,typeId:string):void {
    const forest=position.forest?{cellMm:position.forest.cellMm,patchId:createHmac('sha256',this.state.secretIdKey).update(`forest:${position.forest.patchId}`).digest('hex')}:undefined;
    const e:ResourceNode={id:this.id(),kind:'resource',typeId,ownerId:null,xMm:position.xMm,zMm:position.zMm,hp:1,maxHp:1,resource,amount:Math.round(amount*scale),...(forest?{forest}:{})};this.state.entities[e.id]=e;this.invalidateEntityRoster(true);this.state.navigationRevision++;
  }
  step(ticks=1):void {
    if(!Number.isSafeInteger(ticks)||ticks<0)throw new Error('INVALID_TICKS');
    if(this.stepping)throw new Error('SIMULATION_STEP_IN_PROGRESS');
    if(this.pathScheduler instanceof RemotePathScheduler)throw new Error('ASYNC_PLANNING_REQUIRES_ASYNC_STEP');
    for(let i=0;i<ticks&&this.state.status==='RUNNING';i++){
      const phases=this.stepPhases();try{for(const phase of phases){if(phase.kind==='movement')this.advanceMovement(phase.knowledge);else this.updateVision();}}finally{phases.return();}
    }
  }
  /** Advance one recorded 300/450/600 ms authority frame. The 50 ms event lattice
   * preserves economic rounding and simultaneous damage without full planning
   * or publication per mechanical event. */
  advanceFrame():void{
    if((this.options.authoritativeIntervalMs??50)===50){this.step();return;}
    if(this.state.status!=='RUNNING')return;
    const began=performance.now();let completed=false;
    this.beginFrame();
    try{if(!this.replayMode)this.frameMeasure('planningAdmission',()=>this.admitFramePlanning());
    while(this.state.tick<this.frameEndTick&&this.state.status==='RUNNING'){
      const phases=this.stepPhases();try{for(const phase of phases){
        if(phase.kind==='movement')this.frameMeasure('movement',()=>this.advanceFrameMovement(phase.knowledge));
        else this.frameMeasure('perception',()=>this.updateVision());
      }}finally{phases.return();}
      this.frameMeasure('trace',()=>this.captureFrameTrace());
    }this.flushFramePlanningKnowledge();completed=true;}finally{
      let finalized=false;try{this.endFrame();finalized=true;}finally{if(!completed||!finalized||this.state.status!=='RUNNING'){this.activeWorkRoster=undefined;this.activeGatherJobs=new WeakMap();this.workCoarseKnowledge=undefined;this.workReachability=new WeakMap();}}
    }
    if(!this.replayMode&&this.state.status==='RUNNING')this.frameMeasure('planningService',()=>this.startFramePlanning(this.planningServiceLeases??this.authoritativeFrameIntervalMs/50));
    this.frameCosts.total=performance.now()-began;
  }
  async advanceFrameAsync():Promise<void>{
    if((this.options.authoritativeIntervalMs??50)===50){await this.stepAsync();return;}
    if(!this.visionExecutor){this.advanceFrame();return;}
    if(this.state.status!=='RUNNING')return;
    const began=performance.now();let completed=false;
    this.beginFrame();
    // The host holds its boundary gate throughout this entire frame. Vision
    // workers only receive sealed scalar sources; combat still waits for the
    // exact contact slice's complete fog before touching authoritative state.
    try{if(!this.replayMode)this.frameMeasure('planningAdmission',()=>this.admitFramePlanning());
      while(this.state.tick<this.frameEndTick&&this.state.status==='RUNNING'){
        const phases=this.stepPhases();try{for(const phase of phases){
          if(phase.kind==='movement')this.frameMeasure('movement',()=>this.advanceFrameMovement(phase.knowledge));
          else {const start=performance.now();try{await this.updateVisionAsync(phase.kind);}finally{this.frameCosts.perception=(this.frameCosts.perception??0)+performance.now()-start;}}
        }}finally{phases.return();}
        this.frameMeasure('trace',()=>this.captureFrameTrace());
      }
      this.flushFramePlanningKnowledge();completed=true;
    }finally{let finalized=false;try{this.endFrame();finalized=true;}finally{if(!completed||!finalized||this.state.status!=='RUNNING'){this.activeWorkRoster=undefined;this.activeGatherJobs=new WeakMap();this.workCoarseKnowledge=undefined;this.workReachability=new WeakMap();}}}
    if(!this.replayMode&&this.state.status==='RUNNING')this.frameMeasure('planningService',()=>this.startFramePlanning(this.planningServiceLeases??this.authoritativeFrameIntervalMs/50));
    this.frameCosts.total=performance.now()-began;
  }
  private beginFrame():void{
    if(this.stepping||this.coarseFrame)throw new Error('SIMULATION_STEP_IN_PROGRESS');
    this.frameMovementIndex=undefined;
    Simulation.resourceObservationFlush.call(this);
    this.frameCombatTimelineChecked=false;if(!this.liveOwned){this.activeWorkRoster=undefined;this.activeGatherJobs=new WeakMap();}this.frameCosts={};this.coarseFrame=true;this.frameStartTick=this.state.tick;this.frameEndTick=this.state.tick+this.authoritativeFrameIntervalMs/50;this.frameActivity.clear();this.frameActivityEndTick=-1;
    this.frameDeferredKnowledge=this.liveOwned||canonicalLiveSurfaces()&&Simulation.movementObstacleReaders.guard.call(this)&&Simulation.gatePhaseReaders.guard.call(this)&&Object.entries(Simulation.framePlanningReaders).every(([name,original])=>Reflect.get(this,name)===original||Reflect.get(this,name)===this.framePlanningDiagnostics.get(name));
    // Only the private live owner can retain this proof between commits. Generic
    // fixtures and custom hooks can mutate geometry without a revision marker.
    if(!this.liveOwned){this.frameNavigationRevision=-1;this.frameNavigationPolicy='';this.frameStaticMembers.clear();}this.frameTraces.clear();this.frameVisualTraces.clear();
    this.captureFrameTrace();
  }
  private endFrame():void{
    this.frameMovementIndex=undefined;
    try{this.flushCombatTimeline();}finally{Simulation.resourceObservationFlush.call(this);}
    this.frameActivityEndTick=this.state.tick;
    if(!this.liveOwned){this.activeWorkRoster=undefined;this.activeGatherJobs=new WeakMap();}this.coarseFrame=false;this.frameDeferredKnowledge=false;this.state.frameRevision=(this.state.frameRevision??0)+1;
    if(!this.liveOwned){this.frameNavigationRevision=-1;this.frameNavigationPolicy='';this.frameStaticMembers.clear();}
  }
  private captureFrameTrace():void{
    const roster=this.actors(),world=this.liveOwned?this.liveWorld:undefined,snapshot=this.tracePerceptionSnapshot;
    // Always refresh the initial sample scalarly: same-tick boundary controls
    // can relocate an existing actor without replacing the world array or fog.
    const indexed=this.liveOwned&&snapshot!==undefined&&world!==undefined&&this.state.tick>this.frameStartTick&&snapshot.world===world&&this.perceptionWorld===world&&snapshot.tick===this.state.tick&&snapshot.epoch===this.state.matchEpoch&&snapshot.groups.length===this.state.factions.length
      &&snapshot.groups.every((group,index)=>group.playerId===this.state.factions[index]!.id&&group.key===this.visionGroup(group.playerId)&&group.mask===this.visibilityMasks.get(group.playerId));
    const actors=indexed?undefined:roster.filter(entity=>entity.kind==='unit'&&!entity.garrisonedIn||entity.kind==='building'&&(isGate(entity)||buildings[entity.typeId].attack>0)),projectiles=this.state.projectiles.map(projectile=>({id:projectile.id,...projectilePosition(projectile,this.state)}));
    for(const faction of this.state.factions){
      let traces=this.frameTraces.get(faction.id);if(!traces){traces=new Map();this.frameTraces.set(faction.id,traces);}
      let visualTraces=this.frameVisualTraces.get(faction.id);if(!visualTraces){visualTraces=new Map();this.frameVisualTraces.set(faction.id,visualTraces);}
      const authorized=new Set<string>(),visualAuthorized=new Set<string>();
      const appendVisual=(entity:Unit|Building)=>{
        visualAuthorized.add(entity.id);let trace=visualTraces.get(entity.id);
        if(!trace){trace={complete:this.state.tick===this.frameStartTick,fromTick:this.frameStartTick,lastSampleTick:this.state.tick,points:[]};visualTraces.set(entity.id,trace);}
        const action=this.state.vision[faction.id]!.actions[entity.id],gateOpen=entity.kind==='building'?entity.gateOpen:undefined,last=trace.points.at(-1);
        trace.lastSampleTick=this.state.tick;
        // Most actors keep the same pose over a contact slice. Retain changes
        // only; publication adds the final authorized sample without six copies.
        if(!last||!sameJson(last.visualAction,action)||last.gateOpen!==gateOpen)trace.points.push({tick:this.state.tick,...(action?{visualAction:{...action}}:{}),...(gateOpen!==undefined?{gateOpen}:{})});
      };
      const append=(entity:Position&{id:string;yMm?:number})=>{
        authorized.add(entity.id);let trace=traces.get(entity.id);
        if(!trace){trace={complete:this.state.tick===this.frameStartTick,points:[]};traces.set(entity.id,trace);}
        trace.points.push({tick:this.state.tick,xMm:entity.xMm,zMm:entity.zMm,...('yMm'in entity?{yMm:entity.yMm}:{})});
        // Lossless constant-velocity compression. Retain every actual change of
        // direction, speed, altitude or stop; no geometric chord is invented.
        if(trace.points.length>=3){
          const length=trace.points.length,a=trace.points[length-3]!,b=trace.points[length-2]!,c=trace.points[length-1]!,ab=b.tick-a.tick,ac=c.tick-a.tick;
          if((b!.xMm-a!.xMm)*ac===(c!.xMm-a!.xMm)*ab&&(b!.zMm-a!.zMm)*ac===(c!.zMm-a!.zMm)*ab&&((b!.yMm??0)-(a!.yMm??0))*ac===((c!.yMm??0)-(a!.yMm??0))*ab)trace.points.splice(trace.points.length-2,1);
        }
        if(trace.points.length>16){trace.points.shift();trace.complete=false;}
      };
      // The committed index has already applied current recipient fog. Own
      // actors are included, so garrisoned units still need explicit exclusion.
      const members=indexed?this.perceptionMembership.actors(this.visionGroup(faction.id),faction.id):actors!;
      for(const entity of members){
        if(entity.kind==='unit'&&!entity.garrisonedIn&&(indexed||entity.ownerId===faction.id||this.visible(faction.id,entity))){append(entity);appendVisual(entity);}
        else if(entity.kind==='building'&&(isGate(entity)||buildings[entity.typeId].attack>0)&&(indexed||entity.ownerId===faction.id||this.visible(faction.id,entity)))appendVisual(entity);
      }
      // Projectiles have a moving point footprint and remain scalar. They are
      // never admitted through unit membership or remembered static records.
      for(const projectile of projectiles)if(this.visible(faction.id,projectile))append(projectile);
      for(const id of traces.keys())if(!authorized.has(id))traces.delete(id);
      for(const id of visualTraces.keys())if(!visualAuthorized.has(id))visualTraces.delete(id);
    }
  }
  private traceFor(playerId:string,id:string):ViewEntity['motionTrace']{
    const trace=this.frameTraces.get(playerId)?.get(id);
    // Stable stationary entities need no changing trace payload every300ms.
    // A newly revealed or stopped/moving entity retains its necessary history.
    if(trace?.complete&&trace.points.every(point=>point.xMm===trace.points[0]!.xMm&&point.zMm===trace.points[0]!.zMm&&point.yMm===trace.points[0]!.yMm))return undefined;
    return trace?.points.at(-1)?.tick===this.state.tick?structuredClone(trace):undefined;
  }
  private visualTraceFor(playerId:string,entity:Entity):ViewEntity['visualTrace']{
    if(this.options.authoritativeIntervalMs!==300||entity.kind==='resource'||entity.kind==='unit'&&entity.garrisonedIn)return;
    const trace=this.frameVisualTraces.get(playerId)?.get(entity.id),last=trace?.points.at(-1);
    if(!trace||!last||trace.lastSampleTick!==this.state.tick||trace.points.length>13||!sameJson(last.visualAction,this.state.vision[playerId]!.actions[entity.id])||last.gateOpen!==(entity.kind==='building'?entity.gateOpen:undefined))return;
    if(trace.complete&&trace.points.length===1)return;
    // Keep the authorized baseline, exact changes, and committed endpoint.
    // These are presentation poses only and never enter static ghost memory.
    const points=structuredClone(trace.points);if(last.tick!==this.state.tick)points.push({...structuredClone(last),tick:this.state.tick});
    if(points.length>13)return;
    return {complete:trace.complete,fromTick:trace.fromTick,points};
  }
  private advanceFrameMovement(knowledge?:StaticKnowledgeFrame):void{
    this.prepareFrameFlightLimits();
    // Static membership identity changes only on actual discovery/concealment;
    // moved sources do not themselves require rebuilding every known obstacle.
    // Gate completion and AUTO policy can change a recipient's planned passage
    // without opening the physical gate or incrementing navigationRevision.
    // Reconcile this small actor/faction policy set, never all resource records.
    const policy=this.framePlanningPolicy();
    const refreshAll=!this.frameDeferredKnowledge||this.frameNavigationRevision!==this.state.navigationRevision||this.frameNavigationPolicy!==policy||!this.perceptionWorld;
    // Ordinary new fog knowledge joins the next committed planner input. Every
    // physical sweep and visibility check below still uses the current world.
    const profiles=new Set(refreshAll?this.state.factions.map(faction=>faction.id):[]);
    if(profiles.size){
      this.frameMeasure('navigationPreparation',()=>this.prepareMovement(knowledge,profiles));
      this.frameNavigationRevision=this.state.navigationRevision;
      this.frameNavigationPolicy=policy;
      for(const faction of this.state.factions)this.frameStaticMembers.set(faction.id,this.perceptionMembership.statics(this.visionGroup(faction.id),faction.id));
    }else{
      const entities=this.all();
      this.movementFrame={...(knowledge?.entities===entities?knowledge:{entities,knownStatic:new Map<string,Entity[]>()}),units:this.movementUnits,planning:new Map()};
      for(const faction of this.state.factions)this.avoidance(faction.id).beginTick(this.state.tick,Math.max(1,Math.floor(8/this.state.factions.length)),this.liveOwned);
    }
    // A native service will supply ready paths at frame boundaries. Inline
    // fixtures retain bounded deterministic work until attached to that service.
    if(!(this.pathScheduler instanceof RemotePathScheduler)&&this.state.tick===this.frameStartTick+1)this.lastPathWork=this.frameMeasure('planning',()=>this.pathScheduler.advance(4000,this.state.tick));
    this.advanceMovement(undefined,true);
  }
  private framePlanningPolicy():string{
    // Native role membership is invalidated for births, deaths and upgrades.
    // Policy still reads every gate's live fields: completing an AUTO gate or
    // changing its owner/team can matter without a physical geometry revision.
    const roster=this.phaseRoster(),gates=roster?.gates??this.actors().filter((entity):entity is Building=>entity.kind==='building'&&isGate(entity));
    if(roster)countPhaseRoster('planningGates',gates.length);
    return JSON.stringify([this.state.factions.map(faction=>[faction.id,faction.teamId,this.state.economies[faction.id]!.defeated]),gates.map(gate=>[gate.id,gate.ownerId,gate.work>=gate.required,gate.gateMode,Boolean(gate.gateOpen)])]);
  }
  /** Flush after the last visibility/contact slice, including a terminal partial
   * frame, before background leases freeze their committed geometry. This must
   * never replenish local-avoidance credits or reuse pre-vision work knowledge. */
  private flushFramePlanningKnowledge():void{
    const policy=this.framePlanningPolicy(),refreshAll=!this.liveOwned||this.frameNavigationRevision!==this.state.navigationRevision||this.frameNavigationPolicy!==policy||!this.perceptionWorld;
    const profiles=new Set(this.state.factions.filter(faction=>refreshAll||this.frameStaticMembers.get(faction.id)!==this.perceptionMembership.statics(this.visionGroup(faction.id),faction.id)).map(faction=>faction.id));
    if(!profiles.size)return;
    try{
      this.frameMeasure('navigationPreparation',()=>this.prepareMovementGeometry(undefined,profiles));
      this.frameNavigationRevision=this.state.navigationRevision;this.frameNavigationPolicy=policy;
      for(const faction of this.state.factions)this.frameStaticMembers.set(faction.id,this.perceptionMembership.statics(this.visionGroup(faction.id),faction.id));
    }finally{this.movementFrame=undefined;}
  }
  private static readonly framePlanningReaders=Object.freeze({advanceWork:Simulation.prototype.advanceWork,gather:Simulation.prototype.gather,advanceResourceSearch:Simulation.prototype.advanceResourceSearch,knownTarget:Simulation.prototype.knownTarget,dropoffs:Simulation.prototype.dropoffs,workReachable:Simulation.prototype.workReachable,task:Simulation.prototype.task,complete:Simulation.prototype.complete,approachDestination:Simulation.prototype.approachDestination,continueFrameWorkWait:Simulation.prototype.continueFrameWorkWait,rememberFrameWorkWait:Simulation.prototype.rememberFrameWorkWait,frameTransitDropoff:Simulation.prototype.frameTransitDropoff,rememberFrameWorkFaceWait:Simulation.prototype.rememberFrameWorkFaceWait,framePendingWorkFace:Simulation.prototype.framePendingWorkFace,pendingDepositContact:Simulation.prototype.pendingDepositContact,continueFrameMovementWait:Simulation.prototype.continueFrameMovementWait,advanceProduction:Simulation.prototype.advanceProduction,advanceControllers:Simulation.prototype.advanceControllers,advanceCaretakers:Simulation.prototype.advanceCaretakers,advanceCommander:Simulation.prototype.advanceCommander,resolveDeaths:Simulation.prototype.resolveDeaths,evaluateVictory:Simulation.prototype.evaluateVictory,commitVision:Simulation.prototype.commitVision,updateVision:Simulation.prototype.updateVision,stepPhases:Simulation.prototype.stepPhases,advanceFrameMovement:Simulation.prototype.advanceFrameMovement,advanceMovement:Simulation.prototype.advanceMovement,prepareMovement:Simulation.prototype.prepareMovement,prepareMovementGeometry:Simulation.prototype.prepareMovementGeometry,framePlanningPolicy:Simulation.prototype.framePlanningPolicy,flushFramePlanningKnowledge:Simulation.prototype.flushFramePlanningKnowledge,command:Simulation.prototype.command,advanceCombat,advanceGarrisons,updateEngagements});
  /** Only canonical read-only timing wrappers may preserve the 300ms scheduling
   * contract. Custom hooks retain immediate conservative reconciliation. */
  registerFramePlanningDiagnostic(stage:string,original:unknown,wrapper:unknown):(()=>void)|undefined{
    if(!Object.hasOwn(Simulation.framePlanningReaders,stage)||Reflect.get(Simulation.framePlanningReaders,stage)!==original||typeof wrapper!=='function'||Reflect.get(this,stage)!==wrapper)return;
    this.framePlanningDiagnostics.set(stage,wrapper);return ()=>{if(this.framePlanningDiagnostics.get(stage)===wrapper)this.framePlanningDiagnostics.delete(stage);};
  }
  async stepAsync(ticks=1):Promise<void> {
    if(!Number.isSafeInteger(ticks)||ticks<0)throw new Error('INVALID_TICKS');
    if(this.stepping)throw new Error('SIMULATION_STEP_IN_PROGRESS');
    for(let i=0;i<ticks&&this.state.status==='RUNNING';i++){
      const phases=this.stepPhases();try{for(const phase of phases){
        if(phase.kind==='movement')await this.advanceMovementAsync(phase.knowledge);
        else if(this.visionExecutor)await this.updateVisionAsync(phase.kind);
        else this.updateVision();
      }}finally{phases.return();}
    }
  }
  private *stepPhases():Generator<{kind:'movement';knowledge:StaticKnowledgeFrame|undefined}|{kind:'vision'|'post-death-vision'},void,unknown> {
      this.stepping=true;this.tickFrame={};try{
      this.state.tick++;advanceManualProtection(this.state);this.committedActions.clear();
      // Record ownership before invoking any phase hook: a custom hook that
      // restores itself after moving a unit still cannot certify a stale index.
      const gatePhaseOwned=Simulation.gatePhaseReaders.guard.call(this);
      const roles=gatePhaseOwned?this.phaseRoster():undefined;
      this.frameMeasure('gates',()=>{if(roles)countPhaseRoster('transitions',roles.trebuchets.length);this.advanceTransitions(this.state,roles?.trebuchets??(this.coarseFrame?this.actors():this.all()));});
      const gateRoster=this.all(),gateFrame=this.tickFrame,gateUnits=gatePhaseOwned&&Simulation.gatePhaseReaders.guard.call(this)&&gateFrame?.gateUnitsCanonical&&gateFrame.entities===gateRoster?this.movementUnits:undefined;
      const gateCandidates=gateUnits&&this.liveOwned&&roles===this.livePhaseRoster?roles?.gates:undefined;
      const gateLookup=Simulation.factionLookupReaders.lookup.call(this);
      if(gateUnits){gateLookup.active=true;gateLookup.factions=Simulation.factionLookupReaders.snapshot.call(this);}
      try{this.frameMeasure('gates',()=>{if(gateCandidates)countPhaseRoster('gates',gateCandidates.length);if(this.advanceGates(this.state,gateLookup.hostile,gateRoster,gateUnits,gateCandidates).length)this.state.navigationRevision++;});}finally{gateLookup.active=false;gateLookup.factions=undefined;}
      this.frameMeasure('production',()=>this.advanceProduction());
      this.phase='controllers';this.controllerViewFrame=this.replayMode?{verify:true}:{};try{this.frameMeasure('controllers',()=>{if(this.replayMode)this.replayControllerHook?.();else{if(this.options.controllers!==false)this.advanceControllers();this.advanceCaretakers();}});}finally{this.controllerViewFrame=undefined;this.phase='boundary';}
      const context=this.orderContext();this.frameMeasure('engagement',()=>{Simulation.factionLookupReaders.run.call(this,context,'engagement');this.advanceGarrisons(context);});
      yield {kind:'movement',knowledge:this.frameMeasure('work',()=>this.advanceWork())};yield {kind:'vision'};this.frameMeasure('combat',()=>Simulation.factionLookupReaders.run.call(this,context,'combat'));if(this.resolveDeaths(false))yield {kind:'post-death-vision'};this.frameMeasure('observedActions',()=>{this.observeActions();this.evaluateVictory();this.retainFrameActivity();});
      this.state.effects=this.state.effects.filter(effect=>this.state.tick-effect.tick<=2*R.simulationHz).slice(-4096);
      if(this.state.tick%R.simulationHz===0)for(const [key,record]of Object.entries(this.state.receipts))if(this.state.tick-record.tick>=180*R.simulationHz)delete this.state.receipts[key];
      for(const faction of this.state.factions)if(this.commanderEligible(faction)&&!this.state.economies[faction.id]!.defeated){const statistics=this.state.economies[faction.id]!.statistics;if(this.state.controllers[faction.id]!.mode==='model')statistics.modelReadyTicks++;else statistics.fallbackTicks++;}
      }finally{this.tickFrame=undefined;this.movementFrame=undefined;this.stepping=false;}
  }
  async attachPlanningExecutor(executor:PathPlanningExecutor):Promise<void> {
    if(this.stepping||this.pathScheduler instanceof RemotePathScheduler&&this.options.authoritativeIntervalMs!==300)throw new Error('INVALID_PLANNING_ATTACH');
    if(this.pathScheduler instanceof RemotePathScheduler){if(this.pathScheduler.serviceStatus().pending)throw new Error('INVALID_PLANNING_ATTACH');this.pathScheduler.synchronizeCaptureSynchronous(this.planningGeometries());}
    this.pathScheduler=await RemotePathScheduler.create(this.state.factions.map(f=>f.id),this.pathScheduler.exportState(),this.planningGeometries(),executor);
    rememberAdmissionHelper(this.pathScheduler);
    if(this.planningDiagnosticNow)this.pathScheduler.enablePathDiagnostics({tick:()=>this.state.tick,now:this.planningDiagnosticNow});
  }
  attachVisionExecutor(executor:NonNullable<Simulation['visionExecutor']>):void {if(this.stepping)throw new Error('SIMULATION_STEP_IN_PROGRESS');this.visionExecutor=executor;}
  async synchronizeCapture():Promise<void> {
    if(this.stepping)throw new Error('SIMULATION_STEP_IN_PROGRESS');
    if(this.pathScheduler instanceof RemotePathScheduler){
      const admission=await this.pathScheduler.drainServiceLeases();if(admission){this.lastPathWork=admission.report;this.installFrameLocalPrefetch();this.record({kind:'planning_service_admit',leases:admission.leases.length});}
      await this.pathScheduler.synchronizeCapture(this.planningGeometries(),this.liveOwned);
    }
  }
  private planningGeometries():PathPlanningGeometry[]{
    const active=new Set<string>(),result=this.state.factions.map(f=>{
      active.add(f.id);const profile=this.planningNavigations.get(f.id),prior=this.planningGeometryCache.get(f.id),revision=profile?.revision??0;
      if(prior&&prior.profile===profile&&prior.value.revision===revision&&prior.value.widthMm===this.state.widthMm&&prior.value.heightMm===this.state.heightMm)return prior.value;
      const value=Object.freeze({profile:f.id,revision,widthMm:this.state.widthMm,heightMm:this.state.heightMm,obstacles:Object.freeze(profile?[...profile.obstacles.values()]:[])});
      this.planningGeometryCache.set(f.id,{profile,value});return value;
    });
    for(const id of this.planningGeometryCache.keys())if(!active.has(id))this.planningGeometryCache.delete(id);
    return result;
  }
  setStatus(status:SimulationState['status']):void{if(status!==this.state.status&&status!=='RUNNING')this.clearAiBindings('MATCH_NOT_RUNNING');this.state.status=status;this.record({kind:'status',status});}
  invalidateEpoch(epoch=this.state.matchEpoch+1):number{if(!Number.isSafeInteger(epoch)||epoch<=this.state.matchEpoch||epoch>2147483647)throw new Error('INVALID_EPOCH');for(const cache of this.publicationCaches.values())cache.invalidateExports();for(const economy of Object.values(this.state.economies))economy.lastClientSequence=0;this.clearAiBindings('EPOCH_CHANGED');for(const avoidance of this.localAvoidance.values())avoidance.invalidateDeferredEpoch();this.state.matchEpoch=epoch;this.record({kind:'epoch',epoch});return epoch;}
  endAsDraw():void{if(this.state.status!=='FINISHED')this.finish(null,'administrative_draw');this.record({kind:'draw'});}
  adminSurrender(playerId:string):void{if(!Object.hasOwn(this.state.economies,playerId))throw new Error('INVALID_FACTION');if(!['RUNNING','PAUSED'].includes(this.state.status))throw new Error('MATCH_NOT_ACTIVE');this.eliminate(playerId);this.evaluateVictory();this.record({kind:'admin_surrender',playerId});}
  private commanderEligible(faction:PublicPlayer):boolean {
    if(faction.kind==='ai')return true;
    const control=this.state.control[faction.id],preferences=control?.assistant?.preferences;
    return control?.mode==='human'&&Boolean(preferences?.enabled&&preferences.modelId);
  }
  private resetCommander(playerId:string,reason:string):void {
    const memory=this.state.controllers[playerId]!;
    memory.generation++;delete memory.activeRequest;delete memory.plan;memory.pending=[];memory.planReferences={};memory.fortifications={};
    delete memory.resourceHandoff;delete memory.resourceHandoffCooldown;memory.assignments={};memory.farmAssignments={};
    memory.mode='fallback';memory.reason=reason;memory.nextStrategicTick=this.state.tick;
  }
  configureAssistant(playerId:string,preferences:AssistantPreferences):AssistantStateResponse {
    if(this.phase!=='boundary')throw new Error('AI_NOT_AT_BOUNDARY');
    const faction=this.state.factions.find(player=>player.id===playerId);
    if(!faction||faction.kind!=='human')throw new Error('INVALID_HUMAN_SLOT');
    if(!preferences||typeof preferences.enabled!=='boolean'||preferences.modelId!==null&&(typeof preferences.modelId!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(preferences.modelId))||preferences.enabled&&!preferences.modelId||!preferences.reserve||resources.some(resource=>!Number.isSafeInteger(preferences.reserve[resource])||preferences.reserve[resource]<0||preferences.reserve[resource]>1_000_000))throw new Error('INVALID_ASSISTANT_PREFERENCES');
    const assistant=this.state.control[playerId]!.assistant??=createAssistantControl();
    // Explicit preferences never contain endpoint configuration or credentials.
    assistant.preferences={modelId:preferences.modelId,enabled:preferences.enabled,reserve:Object.fromEntries(resources.map(resource=>[resource,preferences.reserve[resource]])) as ResourceBank};
    faction.assistant={modelId:preferences.modelId,enabled:preferences.enabled};
    this.resetCommander(playerId,preferences.enabled?'ASSISTANT_CONFIGURED':'ASSISTANT_PAUSED');
    this.record({kind:'assistant',playerId,preferences:assistant.preferences});return this.assistantState(playerId);
  }
  assistantState(playerId:string):AssistantStateResponse {
    const faction=this.state.factions.find(player=>player.id===playerId);if(!faction||faction.kind!=='human')throw new Error('INVALID_HUMAN_SLOT');
    const assistant=this.state.control[playerId]!.assistant,preferences=assistant?.preferences??defaultAssistantPreferences();
    const status=!preferences.modelId?'manual':!preferences.enabled?'paused':this.state.status!=='RUNNING'?'paused':!this.commanderEligible(faction)?'unavailable':this.state.controllers[playerId]!.mode;
    return {preferences:structuredClone(preferences),status,protectedEntityIds:assistant?.protectedEntityIds.filter(id=>this.state.entities[id]?.ownerId===playerId)??[]};
  }
  releaseAssistantEntities(playerId:string,entityIds:string[]):AssistantStateResponse {
    if(this.phase!=='boundary')throw new Error('AI_NOT_AT_BOUNDARY');this.assistantState(playerId);
    if(!Array.isArray(entityIds)||entityIds.length>2200||entityIds.some(id=>typeof id!=='string'||this.state.entities[id]?.ownerId!==playerId))throw new Error('INVALID_REFERENCE');
    const assistant=this.state.control[playerId]!.assistant??=createAssistantControl(),released=new Set(entityIds);
    assistant.protectedEntityIds=assistant.protectedEntityIds.filter(id=>!released.has(id));for(const id of released)delete assistant.releaseAfterIdle[id];
    this.record({kind:'assistant_release',playerId,entityIds:[...released]});return this.assistantState(playerId);
  }
  setAiModel(playerId:string,modelId:string):void {
    if(this.phase!=='boundary')throw new Error('AI_NOT_AT_BOUNDARY');
    const faction=this.state.factions.find(player=>player.id===playerId);if(!faction||faction.kind!=='ai')throw new Error('INVALID_AI_SLOT');
    if(typeof modelId!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(modelId))throw new Error('INVALID_MODEL');
    faction.aiModelId=modelId;this.resetCommander(playerId,'MODEL_REPLACED');this.record({kind:'ai_model',playerId,modelId});
  }
  private clearAiBindings(reason:string,playerIds?:string[]):void{for(const faction of this.state.factions)if((faction.kind==='ai'||this.state.control[faction.id]?.assistant)&&(playerIds===undefined||playerIds.includes(faction.id))){const state=this.state.controllers[faction.id]!;state.generation++;delete state.activeRequest;if(state.mode==='fallback')state.reason=reason;}}
  invalidateAiRequests(reason='ENDPOINT_REPLACED',playerIds?:string[]):void{if(this.phase!=='boundary')throw new Error('AI_NOT_AT_BOUNDARY');for(const faction of this.state.factions)if((faction.kind==='ai'||this.state.control[faction.id]?.assistant)&&(playerIds===undefined||playerIds.includes(faction.id)))this.resetCommander(faction.id,reason.slice(0,96));for(const faction of this.state.factions)if((faction.kind==='ai'||this.state.control[faction.id]?.assistant)&&(playerIds===undefined||playerIds.includes(faction.id)))this.record({kind:'commander_memory',playerId:faction.id,memory:this.state.controllers[faction.id]!});}
  aiSchedulingState(){return {matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,tick:this.state.tick,status:this.state.status,commanders:this.state.factions.filter(faction=>this.commanderEligible(faction)).map(faction=>{const memory=this.state.controllers[faction.id]!;return {playerId:faction.id,modelId:faction.kind==='ai'?(faction.aiModelId??'host'):this.state.control[faction.id]!.assistant!.preferences.modelId!,difficulty:faction.difficulty??'medium',personality:faction.personality??'builder',generation:memory.generation,alive:!this.state.economies[faction.id]!.defeated,nextStrategicTick:memory.nextStrategicTick,...(memory.activeRequest?{activeRequest:structuredClone(memory.activeRequest.binding)}:{}),mode:memory.mode,reason:memory.reason,goals:goalSummaries(memory)};})};}
  prepareAiRequest(playerId:string,requestId:string,chatRequestIds:string[]=[]){
    if(this.phase!=='boundary'||this.replayMode)throw new Error('AI_NOT_AT_BOUNDARY');
    const faction=this.state.factions.find(faction=>faction.id===playerId);if(!faction||!this.commanderEligible(faction)||this.state.economies[playerId]!.defeated||this.state.status!=='RUNNING')throw new Error('AI_UNAVAILABLE');
    const memory=this.state.controllers[playerId]!;if(memory.activeRequest)throw new Error('AI_REQUEST_IN_FLIGHT');
    if(!/^[A-Za-z0-9_-]{1,96}$/.test(requestId)||chatRequestIds.length>1||chatRequestIds.some(id=>!memory.chatRequests.some(request=>request.requestId===id&&this.state.tick-request.tick<=90*R.simulationHz)))throw new Error('INVALID_AI_REQUEST');
    const view=this.view(playerId);refreshAiMemory(view,memory.memory);const binding={matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,playerId,requestId,observedTick:this.state.tick,controllerGeneration:memory.generation,observationId:aiObservationId(this.state.matchId,playerId,memory.generation,++memory.observationNonce)};
    const dispatch=buildAiObservation(view,{binding,memory:memory.memory,goals:goalSummaries(memory),chatRequests:chatRequestIds.length?memory.chatRequests.filter(request=>chatRequestIds.includes(request.requestId)):[],resourceAssignments:memory.assignments});
    memory.activeRequest={binding:structuredClone(binding),references:structuredClone(dispatch.references),chatRequestIds:[...chatRequestIds]};this.record({kind:'commander_memory',playerId,memory});return dispatch;
  }
  completeAiRequest(binding:AiRequestBinding,result:AiRequestResult):AiCompletion{
    if(this.phase!=='boundary'||this.replayMode)return {accepted:false,code:'AI_NOT_AT_BOUNDARY',goals:[]};
    const faction=this.state.factions.find(faction=>faction.id===binding.playerId);if(!faction||!this.commanderEligible(faction))return {accepted:false,code:'STALE_AI_RESPONSE',goals:[]};
    const memory=this.state.controllers[faction.id]!,view=this.view(faction.id),reason=bindingReason(view,memory,binding);
    if(reason&&reason!=='AI_OBSERVATION_EXPIRED')return {accepted:false,code:reason,goals:[]};
    let response:AiCompletion;
    if(reason||result.kind==='failure'){delete memory.activeRequest;memory.mode='fallback';memory.reason=reason??(/^[A-Z0-9_]{1,96}$/.test(result.kind==='failure'?result.code:'')?(result as {code:string}).code:'ENDPOINT_FAILURE');response={accepted:false,code:memory.reason,goals:goalSummaries(memory)};}
    else response=installAiPlan(view,memory,binding,result.plan);
    if(!response.accepted){memory.inferenceFailures++;this.state.economies[faction.id]!.statistics.inferenceFailures=memory.inferenceFailures;}
    this.pruneAiMemory(faction.id);this.record({kind:'commander_memory',playerId:faction.id,memory});return response;
  }
  acceptAiChat(request:AiChatRequest):{accepted:boolean;code:string}{
    if(this.phase!=='boundary'||this.replayMode||this.state.status!=='RUNNING')return {accepted:false,code:'AI_UNAVAILABLE'};
    const sender=this.state.factions.find(faction=>faction.id===request.senderId),recipient=this.state.factions.find(faction=>faction.id===request.recipientId);
    if(!sender||sender.kind!=='human'||!recipient||recipient.kind!=='ai'||sender.teamId!==recipient.teamId||this.state.economies[recipient.id]!.defeated)return {accepted:false,code:'INVALID_ALLY'};
    const legalPoint=(point:Position)=>point&&Number.isSafeInteger(point.xMm)&&Number.isSafeInteger(point.zMm)&&point.xMm>=0&&point.zMm>=0&&point.xMm<=this.state.widthMm&&point.zMm<=this.state.heightMm;
    if(!/^[A-Za-z0-9_-]{1,96}$/.test(request.requestId)||request.verified!==false||typeof request.text!=='string'||!request.text.trim()||request.text.length>500||!Number.isSafeInteger(request.tick)||request.tick<0||request.tick>this.state.tick||this.state.tick-request.tick>90*R.simulationHz||request.position&&!legalPoint(request.position))return {accepted:false,code:'INVALID_AI_CHAT'};
    const intent=request.intent;if(intent&&!(intent.action==='defend_base'||intent.action==='attack_ping'&&legalPoint(intent.position)||intent.action==='tribute'&&resources.includes(intent.resource)&&Number.isSafeInteger(intent.amount)&&intent.amount>=1&&intent.amount<=1000))return {accepted:false,code:'INVALID_AI_CHAT'};
    request={requestId:request.requestId,senderId:request.senderId,recipientId:request.recipientId,text:request.text.trim(),tick:request.tick,verified:false,...(request.position?{position:{xMm:request.position.xMm,zMm:request.position.zMm}}:{}),...(intent?{intent:intent.action==='defend_base'?{action:intent.action}:intent.action==='attack_ping'?{action:intent.action,position:{xMm:intent.position.xMm,zMm:intent.position.zMm}}:{action:intent.action,resource:intent.resource,amount:intent.amount}}:{})};
    const memory=this.state.controllers[recipient.id]!;this.pruneAiMemory(recipient.id);if(memory.chatRequests.some(prior=>prior.requestId===request.requestId))return {accepted:true,code:'DUPLICATE_CHAT'};
    if(memory.chatRequests.length>=32)return {accepted:false,code:'AI_CHAT_LIMIT'};
    memory.chatRequests.push(structuredClone(request));recordAiFact(memory.memory,{id:`chat_${request.requestId}`,tick:request.tick,expiresTick:request.tick+90*R.simulationHz,kind:'ally_request',provenance:request.position?'team_ping':'human_claim',confidence:'unverified',sourcePlayerId:request.senderId,text:request.text.slice(0,240),requestId:request.requestId,...(request.position?{position:{...request.position}}:{})});
    if(request.intent){
      memory.generation++;delete memory.activeRequest;const view=this.view(recipient.id),binding={matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,playerId:recipient.id,requestId:request.requestId,observedTick:this.state.tick,controllerGeneration:memory.generation,observationId:aiObservationId(this.state.matchId,recipient.id,memory.generation,++memory.observationNonce)};
      const intentRequest=request.intent.action==='attack_ping'?{...request,position:request.intent.position}:request,dispatch=buildAiObservation(view,{binding,memory:memory.memory,chatRequests:[intentRequest],resourceAssignments:memory.assignments}),ally=Object.values(dispatch.references).find(ref=>ref.kind==='ally'&&ref.playerId===request.senderId),target=Object.values(dispatch.references).find(ref=>ref.kind==='team_ping')??Object.values(dispatch.references).find(ref=>ref.kind==='ally_anchor'&&ref.playerId===request.senderId);
      const goal=request.intent.action==='tribute'&&ally?{kind:'tribute' as const,allyRef:ally.ref,resource:request.intent.resource,amount:request.intent.amount}:target?{kind:'army_order' as const,squadRef:'army-main',order:request.intent.action==='defend_base'?'assist' as const:'attack' as const,targetRef:target.ref}:undefined;
      memory.activeRequest={binding,references:structuredClone(dispatch.references),chatRequestIds:[request.requestId]};const response=installAiPlan(view,memory,binding,{schemaVersion:1,observationId:binding.observationId,strategy:'Execute an authorized allied cooperation preset.',goals:goal?[goal]:[],message:null},{source:'preset'});memory.mode='fallback';memory.reason=response.accepted?'RULE_COOPERATION':response.code;
      memory.outbox.push({recipientId:request.senderId,requestId:request.requestId,status:goal&&response.accepted?'planned':'declined',text:goal&&response.accepted?'The cooperation request is planned; completion depends on the ordinary economy and available units.':response.message?.text??'No authorized target is available for this request.'});memory.outbox=memory.outbox.slice(-32);
    }
    this.record({kind:'commander_memory',playerId:recipient.id,memory});return {accepted:true,code:'CHAT_ACCEPTED'};
  }
  private pruneAiMemory(playerId:string):void{
    const memory=this.state.controllers[playerId]!,active=new Set([...(memory.activeRequest?.chatRequestIds??[]),...(memory.plan?.goals.filter(goal=>this.state.tick<goal.expiresTick).map(goal=>goal.correlationId).filter((id):id is string=>Boolean(id))??[])]);
    memory.chatRequests=memory.chatRequests.filter(request=>this.state.tick-request.tick<=90*R.simulationHz||active.has(request.requestId)).slice(-32);
    const keep=new Set([...active,...memory.chatRequests.map(request=>request.requestId)]);for(const key of Object.keys(memory.tributeCredits))if(key.startsWith('tribute:')&&!key.endsWith(':autonomous')&&![...keep].some(id=>key.endsWith(`:${id}`)))delete memory.tributeCredits[key];
    const goalKeys=new Set(memory.plan?.goals.map(goal=>goal.key)??[]);for(const key of Object.keys(memory.fortifications))if(key!=='fallback'&&!goalKeys.has(key))delete memory.fortifications[key];
  }
  private reportAiGoalOutcomes(playerId:string):void{
    const memory=this.state.controllers[playerId]!,goals=memory.plan?.goals??[];
    for(const correlationId of new Set(goals.map(goal=>goal.correlationId).filter((id):id is string=>Boolean(id)))){const related=goals.filter(goal=>goal.correlationId===correlationId);if(related.every(goal=>goal.reportedStatus===goal.status))continue;const request=memory.chatRequests.find(request=>request.requestId===correlationId);if(!request)continue;for(const goal of related)goal.reportedStatus=goal.status;
      const status:AiMessage['status']|undefined=related.every(goal=>goal.status==='fulfilled')?'completed':related.some(goal=>goal.status==='expired')?'expired':related.every(goal=>goal.status==='rejected')?'declined':related.some(goal=>goal.status==='blocked'||goal.status==='rejected')?'blocked':undefined;
      if(status)memory.outbox.push({recipientId:request.senderId,requestId:request.requestId,status,text:status==='completed'?'All accepted actions in this request are complete.':`${status}: ${related.filter(goal=>goal.status!=='fulfilled').map(goal=>`${goal.kind} (${goal.reason??goal.status})`).join(', ')}`.slice(0,500)});
    }memory.outbox=memory.outbox.slice(-32);this.pruneAiMemory(playerId);
  }
  drainAiMessages():(AiMessage&{playerId:string})[]{if(this.phase!=='boundary')throw new Error('AI_NOT_AT_BOUNDARY');const messages:(AiMessage&{playerId:string})[]=[];for(const faction of this.state.factions){const memory=this.state.controllers[faction.id]!;if(!memory.outbox.length)continue;messages.push(...memory.outbox.map(message=>({...message,playerId:faction.id})));memory.outbox=[];this.record({kind:'commander_memory',playerId:faction.id,memory});}return messages;}
  serializeState():SimulationState{Simulation.resourceObservationFlush.call(this);return {...structuredClone(this.state),navigation:this.pathScheduler.exportState(),approachReservations:[...this.approachReservations.values()].flatMap(reservations=>reservations.exportState()),localAvoidance:Object.fromEntries([...this.localAvoidance].map(([playerId,avoidance])=>[playerId,avoidance.exportState()]))};}
  capture():SimulationSavePayload {
    if(this.phase!=='boundary'||this.stepping)throw new Error('SAVE_NOT_AT_TICK_BOUNDARY');
    Simulation.resourceObservationFlush.call(this);
    if(this.options.authoritativeIntervalMs===300&&this.pathScheduler instanceof RemotePathScheduler&&this.replayMode)this.pathScheduler.synchronizeCaptureSynchronous(this.planningGeometries());
    const {navigation:_navigation,approachReservations:_reservations,localAvoidance:_avoidance,...state}=structuredClone(this.state);state.randomState=this.random.state;
    const options:EffectiveSimulationOptions={rulesetId:this.options.rulesetId,maxAge:this.options.maxAge,startingResourcePreset:this.options.startingResourcePreset,...(this.options.authoritativeIntervalMs?{authoritativeIntervalMs:this.options.authoritativeIntervalMs}:{}),...(this.options.localPlanningMode?{localPlanningMode:this.options.localPlanningMode}:{}),populationLimit:(this.options.populationLimit??R.defaultPopulationLimit) as 80|120|200,sharedVision:this.options.sharedVision??true,controllers:this.options.controllers??true,monumentVictory:this.options.monumentVictory??false,caretakerEnabled:this.options.caretakerEnabled??false,seed:this.options.seed,mapType:this.state.map.type,mapSize:this.options.mapSize??'auto'};
    return {schemaVersion:1,contentHash:resolveRuleset(this.options.rulesetId,this.options.maxAge,this.options.startingResourcePreset).contentHash,options,state,runtime:{profileIds:this.state.factions.map(f=>f.id),planningProfiles:this.state.factions.map(f=>{const profile=this.planningNavigations.get(f.id);return [f.id,{revision:profile?.revision??0,obstacles:profile?structuredClone([...profile.obstacles]):[]}];}),pathScheduler:this.pathScheduler.exportState(),approachReservations:this.state.factions.map(f=>[f.id,this.approachReservations.get(f.id)?.exportState()??[]]),localAvoidance:this.state.factions.map(f=>[f.id,this.localAvoidance.get(f.id)?.exportState()??{tick:0,searches:0,routes:[],waiting:[],grants:[],...(this.options.localPlanningMode?{deferred:{version:1 as const,nextRequestId:1,jobs:[]}}:{})}])}};
  }
  /** Synchronous native IPC is the snapshot's copy boundary. No borrowed record
   * escapes to a caller, no await occurs, and public capture() stays detached. */
  postNativeCapture(port:MessagePort,envelope:NativeCheckpointEnvelope):boolean {
    this.checkLiveOwnership();
    if(!this.liveOwned)return false;
    if(this.phase!=='boundary'||this.stepping)throw new Error('SAVE_NOT_AT_TICK_BOUNDARY');
    if(!isNativeCheckpointPort(port))throw new Error('INVALID_NATIVE_CHECKPOINT_PORT');
    Simulation.resourceObservationFlush.call(this);
    const {navigation:_navigation,approachReservations:_reservations,localAvoidance:_avoidance,...state}=this.state;state.randomState=this.random.state;
    const options:EffectiveSimulationOptions={rulesetId:this.options.rulesetId,maxAge:this.options.maxAge,startingResourcePreset:this.options.startingResourcePreset,...(this.options.authoritativeIntervalMs?{authoritativeIntervalMs:this.options.authoritativeIntervalMs}:{}),...(this.options.localPlanningMode?{localPlanningMode:this.options.localPlanningMode}:{}),populationLimit:(this.options.populationLimit??R.defaultPopulationLimit) as 80|120|200,sharedVision:this.options.sharedVision??true,controllers:this.options.controllers??true,monumentVictory:this.options.monumentVictory??false,caretakerEnabled:this.options.caretakerEnabled??false,seed:this.options.seed,mapType:this.state.map.type,mapSize:this.options.mapSize??'auto'};
    const body={schemaVersion:1 as const,contentHash:resolveRuleset(this.options.rulesetId,this.options.maxAge,this.options.startingResourcePreset).contentHash,options,state,runtime:{profileIds:this.state.factions.map(f=>f.id),planningProfiles:this.state.factions.map(f=>{const profile=this.planningNavigations.get(f.id);return [f.id,{revision:profile?.revision??0,obstacles:profile?[...profile.obstacles]:[]}] as SimulationSavePayload['runtime']['planningProfiles'][number];}),approachReservations:this.state.factions.map(f=>[f.id,this.approachReservations.get(f.id)?.exportState()??[]] as SimulationSavePayload['runtime']['approachReservations'][number]),localAvoidance:this.state.factions.map(f=>[f.id,this.localAvoidance.get(f.id)?.exportState()??{tick:0,searches:0,routes:[],waiting:[],grants:[],...(this.options.localPlanningMode?{deferred:{version:1 as const,nextRequestId:1,jobs:[]}}:{})}] as SimulationSavePayload['runtime']['localAvoidance'][number])}};
    const path=this.pathScheduler instanceof RemotePathScheduler?this.pathScheduler.nativeCheckpoint():this.nativeLocalPathCheckpointScope.prepare(this.pathScheduler.exportState());
    try{postNativeCheckpoint(this.nativeCheckpointScope.prepare(body,path),port,envelope);return true;}
    finally{this.nativeCheckpointScope.invalidate();discardNativePathCheckpoint(path);}
  }
  initialCapture():SimulationSavePayload{return structuredClone(this.initialPayload);}
  /** Aggregate host diagnostics only; never part of a player view or saved state. */
  pathDiagnostics():PathWorkReport{return {...this.lastPathWork};}
  /** Host-worker sampling only. Positions stay inside the worker; only the
   * aggregate counters are published by its existing diagnostics response.
   * Reading raw owned records here avoids thousands of read-membrane traps.
   * No returned object aliases authoritative state, including the generic path. */
  hostWorldDiagnostics(){
    if(this.stepping||this.phase!=='boundary')throw new Error('DIAGNOSTICS_NOT_AT_BOUNDARY');
    const activity={gathering:0,returning:0,building:0,repairing:0,blocked:0,attackCooldownActive:0},positions:{id:string;xMm:number;zMm:number}[]=[];
    const factions=this.state.factions.map(faction=>{const economy=this.state.economies[faction.id]!;return {playerId:faction.id,kind:faction.kind,age:economy.age,defeated:economy.defeated,units:0,population:0,nonWallBuildings:0,wallEquivalentCells:0,statistics:structuredClone(economy.statistics),collected:{...economy.collected}};});
    const byPlayer=new Map(factions.map(faction=>[faction.playerId,faction]));
    let resourceNodes=0,activeResourceNodes=0,nonnegativeResources=true;
    // Public/custom simulations retain their ordinary current-state reads;
    // only the private factory can rely on the maintained entity roster.
    for(const entity of this.liveOwned?this.all():Object.values(this.state.entities)){
      if(entity.kind==='resource'){resourceNodes++;if(entity.amount>0)activeResourceNodes++;nonnegativeResources&&=entity.amount>=0;continue;}
      const faction=byPlayer.get(entity.ownerId)!;
      if(entity.cooldown>0)activity.attackCooldownActive++;
      if(entity.kind==='unit'){
        faction.units++;faction.population+=units[entity.typeId].population;
        positions.push({id:entity.id,xMm:entity.xMm,zMm:entity.zMm});nonnegativeResources&&=entity.cargo.amount>=0;
        if(entity.taskState&&entity.taskState in activity)activity[entity.taskState as 'gathering'|'returning'|'building'|'repairing'|'blocked']++;
      }else if(buildings[entity.typeId].wallEquivalentCells)faction.wallEquivalentCells+=buildings[entity.typeId].wallEquivalentCells!;else faction.nonWallBuildings++;
    }
    for(const economy of Object.values(this.state.economies))nonnegativeResources&&=Object.values(economy.resources).every(value=>Number.isSafeInteger(value)&&value>=0);
    return {matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,tick:this.state.tick,world:{units:factions.reduce((sum,faction)=>sum+faction.units,0),population:factions.reduce((sum,faction)=>sum+faction.population,0),resourceNodes,activeResourceNodes,nonnegativeResources,factions},activity,positions};
  }
  stalledPlanningCandidates():PlanningStallCandidate[]{
    if(this.stepping||this.phase!=='boundary')throw new Error('PLANNING_RECOVERY_NOT_AT_BOUNDARY');
    if(this.state.status!=='RUNNING')return [];
    const result:PlanningStallCandidate[]=[];
    for(const request of this.pathScheduler.pendingRequests()){
      const unit=this.state.entities[request.unitId];
      if(unit?.kind!=='unit'||unit.hp<=0||unit.garrisonedIn||unit.path.length||unit.pathRequestId!==request.id||(unit.orderRevision??0)!==request.orderRevision||unit.ownerId!==request.profile||this.state.economies[unit.ownerId]!.defeated)continue;
      result.push({unitId:unit.id,requestId:request.id,orderRevision:request.orderRevision,progressTick:unit.lastProgressTick??request.enqueuedTick??0,playerId:unit.ownerId});
    }
    for(const faction of this.state.factions)for(const request of this.localAvoidance.get(faction.id)?.pendingLocalRequests()??[]){const unit=this.state.entities[request.unitId];if(unit?.kind!=='unit'||unit.hp<=0||unit.garrisonedIn||!unit.path.length||unit.ownerId!==faction.id||(unit.orderRevision??0)!==request.orderRevision||this.state.economies[faction.id]!.defeated)continue;result.push({unitId:unit.id,requestId:request.requestId,orderRevision:request.orderRevision,progressTick:unit.lastProgressTick??request.firstTick,playerId:faction.id});}
    return result;
  }
  recoverStalledPlanning(proposals:readonly PlanningStallCandidate[]):number{
    if(this.stepping||this.phase!=='boundary')throw new Error('PLANNING_RECOVERY_NOT_AT_BOUNDARY');
    if(proposals.length>16||new Set(proposals.map(proposal=>proposal.unitId)).size!==proposals.length)throw new Error('INVALID_PLANNING_RECOVERY');
    const current=new Map(this.stalledPlanningCandidates().map(candidate=>[candidate.unitId,candidate])),accepted:PlanningStallCandidate[]=[];
    for(const proposal of proposals){
      const candidate=current.get(proposal.unitId);if(!candidate||candidate.requestId!==proposal.requestId||candidate.orderRevision!==proposal.orderRevision||candidate.progressTick!==proposal.progressTick||candidate.playerId!==proposal.playerId)continue;
      const unit=this.state.entities[candidate.unitId] as Unit,order=unit.orders[0];
      const work=order&&['gather','build','repair','reseed'].includes(order.kind),targetId=order?.kind==='gather'&&order.phase==='deposit'?order.dropOffId:order?.targetId;
      const target=work&&targetId?this.knownTarget(unit.ownerId,targetId):undefined;
      // A pending search is not proof of a blocked route. Keep ordinary move
      // work intact; only replace a work leg when another legal authorized face
      // is actually available. Paid orders and manual ownership remain intact.
      const alternative=target&&this.approachDestination(unit,target,true,true);
      if(!alternative)this.localAvoidance.get(unit.ownerId)?.retryPendingLocal(unit.id);
      this.task(unit,order?.kind==='gather'&&order.phase==='deposit'?'returning':'moving',alternative?undefined:'PATH_BUSY');
      accepted.push({...candidate});
    }
    if(accepted.length)this.record({kind:'planning_stall_recovery',proposals:accepted});
    return accepted.length;
  }
  planningQueueDiagnostics(){return this.pathScheduler.queueSummary(this.state.tick);}
  /** Private opt-in QA observer. Clock values never participate in simulation or saves. */
  enablePlanningDiagnostics(now:()=>number):void {this.planningDiagnosticNow=now;this.pathScheduler.enablePathDiagnostics({tick:()=>this.state.tick,now});for(const avoidance of this.localAvoidance.values())avoidance.enablePlanningDiagnostics({tick:()=>this.state.tick,now});}
  planningDiagnostics(){const planning=this.pathScheduler.pathDiagnostics();if(!planning)return;const localAvoidance=[];for(const [profile,avoidance]of this.localAvoidance){if(localAvoidance.length>=11)break;localAvoidance.push({profile,diagnostics:avoidance.planningDiagnostics()});}return {...planning,localAvoidance,localAvoidanceLimit:11,omittedLocalAvoidance:Math.max(0,this.localAvoidance.size-11)};}
  /** Fresh host-only tick evidence; excludes idle/cargo poses and retained attack animations. */
  committedUnitActions():{id:string;playerId:string;kind:CommittedUnitActionKind}[]{
    const actions:{id:string;playerId:string;kind:CommittedUnitActionKind}[]=[];
    for(const [id,action]of this.committedActions){const entity=this.state.entities[id];if(entity?.kind==='unit'&&entity.hp>0&&action.kind!=='idle')actions.push({id,playerId:entity.ownerId,kind:action.kind});}
    return actions;
  }
  /** Bounded host evidence of actions actually committed in every contact slice.
   * A last-slice pose must never be multiplied by six to invent activity. */
  private retainFrameActivity():void{
    if(!this.coarseFrame)return;
    for(const [id,action]of this.committedActions){
      const entity=this.state.entities[id];if(entity?.kind!=='unit'||entity.hp<=0||action.kind==='idle')continue;
      const key=`${id}\0${action.kind}`,prior=this.frameActivity.get(key);
      if(prior)prior.ticks++;else this.frameActivity.set(key,{id,playerId:entity.ownerId,kind:action.kind,ticks:1});
    }
  }
  committedFrameActions():{fromTick:number;toTick:number;actions:{id:string;playerId:string;kind:CommittedUnitActionKind;ticks:number}[]}{
    if(this.options.authoritativeIntervalMs===300&&this.frameActivityEndTick===this.state.tick)return {fromTick:this.frameStartTick,toTick:this.state.tick,actions:[...this.frameActivity.values()].map(action=>({...action}))};
    return {fromTick:Math.max(0,this.state.tick-1),toTick:this.state.tick,actions:this.committedUnitActions().map(action=>({...action,ticks:1}))};
  }
  journalEvents():JournalEvent[]{return this.journal.peek();}
  drainJournal(limit=512){return this.journal.drain(this.state.eventOrdinal,limit);}
  private record(action:JournalAction):void {
    const event={...structuredClone(action),ordinal:++this.state.eventOrdinal,tick:this.state.tick,phase:this.phase} as JournalEvent;if(!this.replayMode)this.journal.append(event);
  }
  enableReplay(controllerPhase:()=>void):void{this.replayMode=true;this.replayControllerHook=controllerPhase;}
  private validReplayedExploration(playerId:string,memory:Pick<CommanderState,'explorerId'|'scoutRoute'>):boolean{
    const explorer=memory.explorerId&&this.state.entities[memory.explorerId],route=memory.scoutRoute;
    return !(explorer&&(explorer.ownerId!==playerId||explorer.typeId!=='villager')||route&&(route.issuedTick>this.state.tick||route.target.xMm>this.state.widthMm||route.target.zMm>this.state.heightMm));
  }
  private installReplayedCommander(playerId:string,next:unknown):void{
    if(!Object.hasOwn(this.state.controllers,playerId)||!validateCommanderMemory(next,playerId,this.state.tick)||next.memory.matchId!==this.state.matchId||next.activeRequest&&next.activeRequest.binding.matchEpoch!==this.state.matchEpoch)throw new Error('INVALID_COMMANDER_PATCH');
    if(!this.validReplayedExploration(playerId,next))throw new Error('INVALID_COMMANDER_PATCH');
    const handoff=next.resourceHandoff;if(handoff&&([handoff.target,handoff.lastPosition].some(point=>point.xMm>this.state.widthMm||point.zMm>this.state.heightMm)||this.state.entities[handoff.workerId]&&(this.state.entities[handoff.workerId]!.ownerId!==playerId||this.state.entities[handoff.workerId]!.typeId!=='villager')))throw new Error('INVALID_COMMANDER_PATCH');
    for(const memory of Object.values(next.fortifications)){const shape=memory.layout??memory.screen;if(shape){const anchor=this.state.entities[memory.goalKey!.split(':')[1]!];if(anchor&&(anchor.ownerId!==playerId||anchor.kind!=='building')||shape.origin.xMm>this.state.widthMm||shape.origin.zMm>this.state.heightMm||shape.cells.some(cell=>(cell.x+1)*grid>this.state.widthMm||(cell.z+1)*grid>this.state.heightMm))throw new Error('INVALID_COMMANDER_PATCH');}}
    const faction=this.state.factions.find(faction=>faction.id===playerId)!,allied=(id:string)=>id!==playerId&&this.state.factions.some(other=>other.id===id&&other.teamId===faction.teamId);
    if(!this.commanderEligible(faction)&&(next.activeRequest||next.plan||next.mode==='model')||next.chatRequests.some(request=>request.recipientId!==playerId||!allied(request.senderId))||next.outbox.some(message=>!allied(message.recipientId))||next.memory.facts.some(fact=>fact.confidence==='unverified'&&!allied(fact.sourcePlayerId)))throw new Error('INVALID_COMMANDER_PATCH');
    for(const registry of [next.planReferences,...(next.activeRequest?[next.activeRequest.references]:[]),...(next.plan?.goals.flatMap(goal=>goal.frozenReferences?[goal.frozenReferences]:[])??[])])for(const reference of Object.values(registry))if('position'in reference&&(reference.position.xMm>this.state.widthMm||reference.position.zMm>this.state.heightMm)||'playerId'in reference&&!allied(reference.playerId)||reference.kind==='team_ping'&&!allied(reference.senderId)||reference.kind==='squad'&&reference.entityIds.some(id=>this.state.entities[id]&&this.state.entities[id]!.ownerId!==playerId)||reference.kind==='own_base'&&this.state.entities[reference.entityId]&&this.state.entities[reference.entityId]!.ownerId!==playerId)throw new Error('INVALID_COMMANDER_PATCH');
    this.state.controllers[playerId]=structuredClone(next);this.state.economies[playerId]!.statistics.inferenceFailures=next.inferenceFailures;
  }
  applyJournalEvent(event:JournalEvent):void {
    if(!this.replayMode||event.ordinal!==this.state.eventOrdinal+1||event.tick!==this.state.tick||event.phase!==this.phase)throw new Error('REPLAY_EVENT_ORDER');
    switch(event.kind){
      case 'planning_service_start':this.startFramePlanning(event.leases);break;
      case 'planning_service_admit':this.admitFramePlanning(event.leases);break;
      case 'planning_stall_recovery':if(this.recoverStalledPlanning(event.proposals)!==event.proposals.length)throw new Error('REPLAY_PLANNING_RECOVERY_STALE');break;
      case 'command':{const actual=this.command(event.playerId,event.envelope,event.source);if(canonical(actual)!==canonical(event.receipt))throw new Error(`REPLAY_RECEIPT_DIVERGENCE:${event.ordinal}`);break;}
      case 'invalid_command':this.record({kind:'invalid_command',playerId:event.playerId,receipt:event.receipt});break;
      case 'status':this.setStatus(event.status);break;
      case 'movement_cadence':if(event.tier===this.state.movementCadenceTier)throw new Error('INVALID_MOVEMENT_CADENCE_TRANSITION');this.setMovementCadenceTier(event.tier);break;
      case 'epoch':this.invalidateEpoch(event.epoch);break;
      case 'draw':this.endAsDraw();break;
      case 'admin_surrender':this.adminSurrender(event.playerId);break;
      case 'controller_memory':case 'commander_memory':this.installReplayedCommander(event.playerId,event.memory);this.record({kind:event.kind,playerId:event.playerId,memory:event.memory});break;
      case 'commander_patch':{if(!Object.hasOwn(this.state.controllers,event.playerId))throw new Error('INVALID_COMMANDER_PATCH');const next=applyCommanderPatches(this.state.controllers[event.playerId]!,event.patches);this.installReplayedCommander(event.playerId,next);this.record({kind:event.kind,playerId:event.playerId,patches:event.patches});break;}
      case 'caretaker_memory':if(!Object.hasOwn(this.state.control,event.playerId)||!this.validReplayedExploration(event.playerId,event.memory))throw new Error('INVALID_CARETAKER_MEMORY');this.state.control[event.playerId]!.memory=structuredClone(event.memory);this.record({kind:event.kind,playerId:event.playerId,memory:event.memory});break;
      case 'control':this.setControlMode(event.playerId,event.mode);break;
      case 'assistant':this.configureAssistant(event.playerId,event.preferences);break;
      case 'assistant_release':this.releaseAssistantEntities(event.playerId,event.entityIds);break;
      case 'ai_model':this.setAiModel(event.playerId,event.modelId);break;
    }
  }
  setControlMode(playerId:string,mode:'human'|'disconnected'|'caretaker'):void {
    const faction=this.state.factions.find(f=>f.id===playerId);if(!faction||faction.kind!=='human')throw new Error('INVALID_HUMAN_SLOT');
    const control=this.state.control[playerId]!;
    if(control.mode==='caretaker'&&mode!=='caretaker'){
      for(const entity of this.owned(playerId))if(entity.kind==='unit'){
        const owned=(order:Order)=>order.authority?.kind==='caretaker'&&order.authority.generation===control.generation,current=entity.orders[0]&&owned(entity.orders[0]),remaining=entity.orders.filter(order=>!owned(order)),suspended=control.suspendedOrders[entity.id]??[];
        if(remaining.length!==entity.orders.length||suspended.length){entity.orders=[...structuredClone(suspended),...remaining].slice(0,R.orderQueueLimit);if(current)delete entity.engagement;this.cancelPath(entity);this.task(entity,entity.orders.length?'moving':'idle');}
      }
      if(control.priorAutoReseed!==undefined)this.state.economies[playerId]!.autoReseed=control.priorAutoReseed;
      control.suspendedOrders={};control.memory.pending=[];delete control.priorAutoReseed;
    }
    if(mode==='caretaker'&&control.mode!=='caretaker'){control.generation++;control.memory=emptyCaretakerMemory();control.memory.sequence=this.state.economies[playerId]!.lastClientSequence;control.priorAutoReseed=this.state.economies[playerId]!.autoReseed;}
    if(control.mode!==mode&&control.assistant)this.resetCommander(playerId,'CONTROL_CHANGED');control.mode=mode;this.record({kind:'control',playerId,mode});
  }
  private population(playerId:string,entities:readonly Entity[]=this.owned(playerId)):{population:number;populationCap:number;reservedPopulation:number}{
    let population=0,capacity=0,reservedPopulation=0;
    for(const e of entities){if(e.ownerId!==playerId)continue;if(e.kind==='unit')population+=units[e.typeId].population;if(e.kind==='building'){if(this.complete(e))capacity+=buildings[e.typeId].populationProvided;for(const j of e.queue)if(j.kind==='train'&&j.reserved)reservedPopulation+=units[j.typeId].population;}}
    return {population,populationCap:Math.min(capacity,this.options.populationLimit??R.defaultPopulationLimit),reservedPopulation};
  }
  private asView(e:Entity,own:boolean,playerId:string):ViewEntity {
    const view:ViewEntity={id:e.id,kind:e.kind,typeId:e.typeId,ownerId:e.ownerId,xMm:e.xMm,zMm:e.zMm,hp:e.hp,maxHp:e.maxHp};
    if(e.kind!=='resource'){view.visualAge=this.state.economies[e.ownerId]!.age as import('@frontier/shared').AgeId;view.visualTier=e.kind==='unit'?this.progression.visualTier(e.ownerId,e.typeId):'base';}
    const action=this.state.vision[playerId]!.actions[e.id];if(action)view.visualAction={...action};
    if(e.kind==='resource'){view.resource=e.resource;view.amount=Math.ceil(e.amount/scale);if(e.forest)view.forest={...e.forest};}
    if(e.kind==='building'){
      view.rotation=e.rotation;view.progress=e.required?e.work/e.required:1;
      if(e.gateOpen!==undefined)view.gateOpen=e.gateOpen;
      if(e.typeId==='farm'){view.resource='food';view.amount=Math.floor((e.foodRemaining??0)/scale);view.farmState=e.reseedRequired?'reseeding':(e.foodRemaining??0)>0?'ready':'exhausted';if(e.reseedRequired)view.reseedProgress=e.reseedWork!/e.reseedRequired;}
      if(own){view.queue=e.queue.map(j=>({id:j.id,...(j.kind==='train'?{kind:j.kind,typeId:j.typeId}:j.kind==='research'?{kind:j.kind,typeId:j.typeId}:{kind:j.kind,typeId:j.typeId}),progress:j.work/j.required,state:j.state,started:j.started,...(j.blockedReason?{blockedReason:j.blockedReason}:{})}));if(e.rally)view.rally={...e.rally};if(e.garrisoned)view.garrisoned=[...e.garrisoned];if(e.gateMode)view.gateMode=e.gateMode;if(e.typeId==='farm')view.farmerAssigned=Boolean(e.farmerId);if(e.demolitionTick)view.demolitionTicksRemaining=Math.max(0,e.demolitionTick-this.state.tick);}
    }
    if(e.kind==='unit'&&e.deploymentState){view.deploymentState=e.deploymentState;if(e.transitionRequired)view.deploymentProgress=1-(e.transitionTicks??0)/e.transitionRequired;}
    if(e.kind==='building'&&e.ward)view.ward={current:e.ward.current,max:e.ward.max,...(own?{supportId:e.ward.supportId}:{})};
    if(e.kind==='building'&&own&&e.upgrade)view.upgrade={jobId:e.upgrade.id,targetTypeId:e.upgrade.targetTypeId,progress:e.upgrade.work/e.upgrade.required,started:e.upgrade.started,state:e.upgrade.started?'active':'waiting'};
    if(e.kind==='building'&&own&&e.pendingConstruction){view.pendingConstruction=true;if(e.pendingConstruction.blocked)view.blockedReason='PLACEMENT_BLOCKED';}
    if(e.kind!=='resource'&&own&&e.weaponCooldowns)view.weaponCooldowns=[...e.weaponCooldowns];
    if(e.kind==='unit'&&e.windup)view.windup={remainingTicks:Math.max(0,e.windup.launchTick-this.state.tick),...(own?{aim:{...e.windup.aim}}:{})};
    if(e.kind==='unit'&&own){if(e.garrisoned)view.garrisoned=[...e.garrisoned];const ammo=units[e.typeId].ammunitionCost;if(ammo)view.ammoAffordable=resources.every(resource=>this.state.economies[e.ownerId]!.resources[resource]>=ammo[resource]*scale);}
    if(e.kind==='unit'&&own&&e.garrisonedIn)view.garrisonedIn=e.garrisonedIn;
    if(e.kind==='unit'&&own){view.cargo={resource:e.cargo.resource,amount:Math.floor(e.cargo.amount/scale)};view.order=e.orders[0]?.kind??'idle';view.stance=e.stance;view.taskState=e.taskState??(e.orders.length?'moving':'idle');view.queuedOrderCount=Math.max(0,e.orders.length-1);if(e.blockedReason)view.blockedReason=e.blockedReason;}
    if(e.kind==='unit'&&own){const order=e.orders[0];if(order?.forestIntentId)view.forestIntentId=order.forestIntentId;if(order?.targetId&&(order.kind==='build'||order.kind==='gather'))view.workTargetId=order.targetId;}
    if(e.kind==='unit'&&this.options.authoritativeIntervalMs===300&&(own||this.visible(playerId,e))){const trace=this.traceFor(playerId,e.id);if(trace)view.motionTrace=trace;}
    return view;
  }
  private publicationCaches=new Map<string,RecipientProjection>();
  private publicationCommon=new RecipientProjection();
  private nativePublicationFallback=false;
  // Ownership certification must compare against the original implementations,
  // including when a diagnostic/custom reader replaces a prototype method.
  private static readonly nativePublicationReaders=Object.freeze({
    guard:Simulation.prototype.canonicalPublicationReaders,
    publicationProjections:Simulation.prototype.publicationProjections,
    preparePublicationProjections:Simulation.prototype.preparePublicationProjections,
    publicationBatch:Simulation.prototype.publicationBatch,
    publicationMembership:Simulation.prototype.publicationMembership,
    all:Simulation.prototype.all,visible:Simulation.prototype.visible,cell:Simulation.prototype.cell,
    viewFromRoster:Simulation.prototype.viewFromRoster,asView:Simulation.prototype.asView,
    visualTraceFor:Simulation.prototype.visualTraceFor,
    publicationEntity:Simulation.prototype.publicationEntity,population:Simulation.prototype.population,
    complete:Simulation.prototype.complete,visionGroup:Simulation.prototype.visionGroup,
    visualTier:Progression.prototype.visualTier,
  });
  private publicationUrgency=new PublicationUrgency();
  private publicationMask(playerId:string):Uint8Array{
    if(this.liveOwned){const mask=this.visibilityMasks.get(playerId);if(mask)return mask;}
    const mask=new Uint8Array(Math.floor(this.state.widthMm/fogGrid)*Math.floor(this.state.heightMm/fogGrid));for(const cell of this.state.vision[playerId]!.visible)mask[cell]=1;return mask;
  }
  /** Only recipient-authorized observations participate; a hidden death cannot
   * force another recipient's publication. This does not assemble any view. */
  urgentPublicationRecipients(playerIds:readonly string[]):string[]{
    if(this.stepping)throw new Error('PUBLICATION_REQUIRES_BOUNDARY');
    for(const playerId of playerIds)if(!Object.hasOwn(this.state.economies,playerId))throw new Error('NOT_AUTHORIZED');
    if(this.options.authoritativeIntervalMs!==300&&this.state.movementCadenceTier<2)return [];
    return playerIds.filter(playerId=>this.publicationUrgency.pending(playerId,this.state.vision[playerId]!.actions,this.publicationMask(playerId),this.state.status,this.state.matchEpoch,this.liveOwned));
  }
  private publishedRecipient(playerId:string):void{if(this.options.authoritativeIntervalMs===300||this.state.movementCadenceTier>=2)this.publicationUrgency.published(playerId,this.state.vision[playerId]!.actions,this.publicationMask(playerId),this.state.status,this.state.matchEpoch,this.liveOwned);}
  resetPublication(playerId?:string):void{this.publicationUrgency.reset(playerId);if(playerId===undefined){for(const cache of this.publicationCaches.values())cache.closeExports();this.publicationCaches.clear();this.publicationCommon=new RecipientProjection();this.nativePublicationFallback=false;}else{this.publicationCaches.get(playerId)?.closeExports();this.publicationCaches.delete(playerId);}}
  private canonicalPublicationReaders():boolean {
    const original=Simulation.nativePublicationReaders;
    return this.publicationProjections===original.publicationProjections&&this.preparePublicationProjections===original.preparePublicationProjections&&this.publicationBatch===original.publicationBatch&&this.publicationMembership===original.publicationMembership&&this.all===original.all&&this.visible===original.visible&&this.cell===original.cell&&this.viewFromRoster===original.viewFromRoster&&this.asView===original.asView&&this.publicationEntity===original.publicationEntity&&this.population===original.population&&this.complete===original.complete&&this.visionGroup===original.visionGroup&&this.progression.visualTier===original.visualTier;
  }
  /** Called only for recipients that reserved bounded encoder credit. The cache
   * contains authorized presentation records, never authoritative world objects. */
  publicationProjections(requests:readonly {playerId:string;sequence:number}[]):ProjectionPatch[]{
    if(!Simulation.nativePublicationReaders.guard.call(this))this.nativePublicationFallback=true;
    return this.preparePublicationProjections(requests,false);
  }
  /** Opaque exports for synchronous native IPC. Public projections keep their
   * detached ownership contract; custom readers retain that conservative path. */
  publicationTransfers(requests:readonly {playerId:string;sequence:number}[]):NativeProjection[]{
    if(this.nativePublicationFallback||!Simulation.nativePublicationReaders.guard.call(this)){
      // A prior custom reader may have retained a mutable cache alias. Restoring
      // the method later does not restore ownership; only clearing all bases does.
      this.nativePublicationFallback=true;
      return this.publicationProjections(requests).map(patch=>{
        let cache=this.publicationCaches.get(patch.header.playerId);if(!cache){cache=new RecipientProjection();this.publicationCaches.set(patch.header.playerId,cache);}
        return cache.detachedExport(patch);
      });
    }
    return this.preparePublicationProjections(requests,true);
  }
  private preparePublicationProjections(requests:readonly {playerId:string;sequence:number}[],native:false):ProjectionPatch[];
  private preparePublicationProjections(requests:readonly {playerId:string;sequence:number}[],native:true):NativeProjection[];
  private preparePublicationProjections(requests:readonly {playerId:string;sequence:number}[],native:boolean):(ProjectionPatch|NativeProjection)[]{
    if(requests.length>11||new Set(requests.map(request=>request.playerId)).size!==requests.length)throw new Error('INVALID_PROJECTION_SUBSCRIBERS');
    for(const request of requests)if(!Object.hasOwn(this.state.economies,request.playerId))throw new Error('NOT_AUTHORIZED');
    if(!requests.length)return [];
    const world=this.all(),members=this.publicationMembership(world,requests),geometry=!members&&requests.length>1?packStaticFootprints(world,this.state.widthMm,this.state.heightMm):undefined;
    // Only privately owned records from canonical readers may establish equality
    // without reconstructing their DTO. Restored hooks retain the sticky fallback.
    const reuseBuildings=!this.nativePublicationFallback&&Simulation.nativePublicationReaders.guard.call(this);
    const batch=reuseBuildings&&!this.stepping?this.publicationBatch(world):undefined;
    return requests.map(({playerId,sequence})=>{
      let cache=this.publicationCaches.get(playerId);if(!cache){cache=new RecipientProjection();this.publicationCaches.set(playerId,cache);}
      cache.begin();const projection={cache,sequence,reuseBuildings,...(batch?{batch}:{}),...(members?{members:members.get(playerId)!}:{})};
      const result=native?this.viewFromRoster(playerId,world,geometry,{...projection,native:true}):this.viewFromRoster(playerId,world,geometry,projection);
      this.publishedRecipient(playerId);return result;
    });
  }
  /** Only public fields are shared. This frame cannot survive its synchronous
   * batch; the retained values are detached and compared against current state
   * each time, including same-tick public edits. Custom readers never receive it. */
  private publicationBatch(world:readonly Entity[]){
    const retain=<T>(key:string,value:T):T=>this.publicationCommon.retain(key,value);
    const map=this.liveOwned&&this.liveMap?this.liveMap:retain('map',{widthMm:this.state.widthMm,heightMm:this.state.heightMm,fogCellMm:fogGrid,type:this.state.map.type,generatorVersion:this.state.map.generatorVersion,terrain:this.state.map.terrain});
    if(this.liveOwned)this.liveMap=map;
    const players=retain('players',this.state.factions.map(p=>({...p,controlMode:this.state.control[p.id]!.mode,...(p.kind==='ai'?{aiMode:this.state.controllers[p.id]!.mode}:{}),age:this.state.economies[p.id]!.age as import('@frontier/shared').AgeId,defeated:this.state.economies[p.id]!.defeated})));
    const monuments=retain('monuments',this.options.monumentVictory?world.filter((e):e is Building=>e.kind==='building'&&e.typeId==='monument'&&this.complete(e)&&!this.state.economies[e.ownerId]!.defeated).map(e=>({id:e.id,ownerId:e.ownerId,xMm:e.xMm,zMm:e.zMm,remainingTicks:Math.max(0,R.monumentHoldSeconds*R.simulationHz-(this.state.tick-(e.monumentCompletedTick??this.state.tick)))})):[]);
    return {map,players,monuments,ageAnnouncements:retain('ageAnnouncements',this.state.ageAnnouncements),result:retain('result',this.state.result),
      projectiles:this.state.projectiles.map(projectile=>({id:projectile.id,kind:projectile.kind,...(projectile.sourceTypeId?{sourceTypeId:projectile.sourceTypeId}:{}),...(projectile.sourceTypeId==='worldbreaker_trebuchet'&&projectile.kind==='stone'?{impactWarning:{...projectile.aim,radiusMm:Math.round(Math.max(...projectile.bands.map(band=>band.radiusM))*1000),hitTick:projectile.hitTick}}:{}),...projectilePosition(projectile,this.state)})),resourceViews:new Map<string,ViewEntity>()};
  }
  private publicationMembership(world:readonly Entity[],requests:readonly {playerId:string}[],controller=false):Map<string,readonly Entity[]>|undefined {
    const prototype=Simulation.prototype;
    // Only completed synchronous boundaries share the derived index. Custom
    // readers retain the established packed/scalar path, including their hooks.
    if(this.stepping&&!(controller&&this.liveOwned)||this.all!==prototype.all||this.visible!==prototype.visible||this.cell!==prototype.cell||this.viewFromRoster!==prototype.viewFromRoster||this.asView!==prototype.asView||this.publicationEntity!==prototype.publicationEntity||this.population!==prototype.population||this.complete!==prototype.complete||this.visionGroup!==prototype.visionGroup)return undefined;
    const groups=new Map<string,Uint8Array>(),owners=new Map<string,string>(),size=Math.floor(this.state.widthMm/fogGrid)*Math.floor(this.state.heightMm/fogGrid);
    for(const faction of this.state.factions){
      const mask=this.visibilityMasks.get(faction.id),key=this.visionGroup(faction.id);
      if(owners.has(faction.id)||!mask||mask.length!==size||groups.has(key)&&groups.get(key)!==mask)return undefined;
      owners.set(faction.id,key);groups.set(key,mask);
    }
    if(requests.some(request=>!owners.has(request.playerId)))return undefined;
    // At a completed private-owner boundary, the last vision commit already
    // reconciled these actors and masks. Order-only commands cannot change
    // membership; additions/removals replace the world roster. In-phase reads,
    // a changed epoch/group/mask, or a partial frame keep the ordinary scan.
    const snapshot=this.tracePerceptionSnapshot,committed=this.liveOwned&&!this.stepping&&this.phase==='boundary'&&world===this.liveWorld&&this.perceptionWorld===world
      &&snapshot?.world===world&&snapshot.tick===this.state.tick&&snapshot.epoch===this.state.matchEpoch&&snapshot.groups.length===owners.size
      &&snapshot.groups.every(group=>owners.get(group.playerId)===group.key&&groups.get(group.key)===group.mask);
    if(!committed){
      // A failed scan can have reconciled a prefix; never certify its prior roster.
      this.perceptionWorld=undefined;
      if(!this.synchronizePerception(world))return undefined;
      this.perceptionMembership.commit([...groups].map(([key,mask])=>({key,mask})));this.perceptionWorld=world;this.rememberStaticKnowledge(world);
    }
    return new Map(requests.map(({playerId})=>[playerId,this.perceptionMembership.recipients(owners.get(playerId)!,playerId)]));
  }
  private publicationEntity(e:Entity,own:boolean,playerId:string,cache:RecipientProjection,reuseBuildings=false,resourceViews?:Map<string,ViewEntity>):ViewEntity{
    // Neutral presentation values may be shared only after this recipient passed
    // visibility filtering. Recipient-specific observed actions are never shared.
    const shareResource=e.kind==='resource'&&!this.state.vision[playerId]!.actions[e.id]?resourceViews:undefined,shared=shareResource?.get(e.id);
    if(shared)return shared;
    if(this.liveOwned&&e.kind==='resource'&&!this.state.vision[playerId]!.actions[e.id]){const value=this.liveResourceView(e);shareResource?.set(e.id,value);return value;}
    const prior=cache.prior(e.id),visualTrace=e.kind==='resource'?undefined:this.visualTraceFor(playerId,e);
    // Resource DTOs dominate static rosters. Reuse their detached absolute value
    // without reconstructing it when only the observer's publication tick moved.
    if(e.kind==='resource'&&prior&&!prior.ghost&&prior.kind===e.kind&&prior.id===e.id&&prior.typeId===e.typeId&&prior.ownerId===e.ownerId
      &&prior.xMm===e.xMm&&prior.zMm===e.zMm&&prior.hp===e.hp&&prior.maxHp===e.maxHp&&prior.resource===e.resource&&prior.amount===Math.ceil(e.amount/scale)
      &&sameJson(prior.forest,e.forest)&&sameJson(prior.visualAction,this.state.vision[playerId]!.actions[e.id])){shareResource?.set(e.id,prior);return prior;}
    // Stable walls and empty producers need neither a fresh object/queue nor a
    // second general field comparison. Transient owner payloads stay scalar.
    // Check recipient action and ownership fields even while sight is unchanged.
    if(reuseBuildings&&e.kind==='building'&&e.typeId!=='farm'&&prior&&!prior.ghost
      &&prior.kind===e.kind&&prior.id===e.id&&prior.typeId===e.typeId&&prior.ownerId===e.ownerId
      &&prior.xMm===e.xMm&&prior.zMm===e.zMm&&prior.hp===e.hp&&prior.maxHp===e.maxHp
      &&prior.visualAge===this.state.economies[e.ownerId]!.age&&prior.visualTier==='base'
      &&prior.rotation===e.rotation&&prior.progress===(e.required?e.work/e.required:1)&&prior.gateOpen===e.gateOpen
      &&prior.pendingConstruction===(own&&e.pendingConstruction?true:undefined)&&prior.blockedReason===(own&&e.pendingConstruction?.blocked?'PLACEMENT_BLOCKED':undefined)
      &&sameJson(prior.visualAction,this.state.vision[playerId]!.actions[e.id])
      &&sameJson(prior.visualTrace,visualTrace)
      &&sameJson(prior.ward,e.ward?{current:e.ward.current,max:e.ward.max,...(own?{supportId:e.ward.supportId}:{})}:undefined)&&sameJson(prior.weaponCooldowns,own?e.weaponCooldowns:undefined)
      &&sameJson(prior.upgrade,own&&e.upgrade?{jobId:e.upgrade.id,targetTypeId:e.upgrade.targetTypeId,progress:e.upgrade.work/e.upgrade.required,started:e.upgrade.started,state:e.upgrade.started?'active':'waiting'}:undefined)
      &&prior.rally===undefined&&prior.garrisoned===undefined&&prior.demolitionTicksRemaining===undefined
      &&(own?e.queue.length===0&&!e.rally&&!e.garrisoned&&!e.demolitionTick&&prior.queue?.length===0&&prior.gateMode===(e.gateMode||undefined)
        :prior.queue===undefined&&prior.gateMode===undefined))return prior;
    const value=this.asView(e,own,playerId);if(visualTrace)value.visualTrace=visualTrace;shareResource?.set(e.id,value);return value;
  }
  view(playerId:string):PlayerView {
    if(!Object.hasOwn(this.state.economies,playerId))throw new Error('NOT_AUTHORIZED');
    const world=this.all();return this.viewFromRoster(playerId,world,this.controllerViewGeometry(world));
  }
  /** Borrow detached immutable static observations only for the synchronous
   * built-in policy. Public reads and external diagnostic callbacks keep fully
   * detached views. Current actor memberships and masks are reconciled before
   * every decision, including after an earlier command added a foundation. */
  private controllerView(playerId:string):PlayerView {
    if(!this.liveOwned||this.controllerProfiler||this.view!==Simulation.prototype.view)return this.view(playerId);
    const world=this.all(),members=this.publicationMembership(world,[{playerId}],true)?.get(playerId);
    if(!members)return this.view(playerId);
    const vision=this.state.vision[playerId]!,prior=this.liveControllerFog.get(playerId);
    let fog=prior?.fog;
    if(!prior||prior.visible!==vision.visible||prior.explored!==vision.explored){
      fog={visible:prior?.visible===vision.visible?prior.fog.visible:[...vision.visible],explored:prior?.explored===vision.explored?prior.fog.explored:[...vision.explored]};
      this.liveControllerFog.set(playerId,{visible:vision.visible,explored:vision.explored,fog});
    }
    const map=this.liveMap??=structuredClone({widthMm:this.state.widthMm,heightMm:this.state.heightMm,fogCellMm:fogGrid,type:this.state.map.type,generatorVersion:this.state.map.generatorVersion,terrain:this.state.map.terrain});
    return this.viewFromRoster(playerId,world,undefined,undefined,{members,map,fog:fog!});
  }
  private controllerGhost(ghost:ViewEntity):ViewEntity {
    const prior=this.liveControllerGhosts.get(ghost);if(prior&&prior.tick===ghost.lastSeenTick)return prior.view;
    // A changed static payload replaces its memory object. Only lastSeenTick is
    // refreshed in place; remembered data is never refreshed from hidden state.
    const view={...structuredClone(ghost),ghost:true};this.liveControllerGhosts.set(ghost,{tick:ghost.lastSeenTick,view});return view;
  }
  private controllerViewGeometry(world:readonly Entity[]):StaticFootprints|undefined {
    const frame=this.controllerViewFrame,prototype=Simulation.prototype;
    if(!frame||this.view!==prototype.view||this.visible!==prototype.visible||this.all!==prototype.all||this.viewFromRoster!==prototype.viewFromRoster||this.asView!==prototype.asView)return undefined;
    // Ordinary commands cannot change existing static spans. Roster-changing
    // commands invalidate all(), whose next ordered array has a new identity.
    // Custom synchronous hooks (including diagnostic command wrappers) may edit
    // public state in place, so compare every span input before reusing geometry.
    const methods=prototype as unknown as Record<string,unknown>,instance=this as unknown as Record<string,unknown>;
    const verify=frame.verify||=Boolean(this.controllerProfiler)||Object.getOwnPropertyNames(this).some(key=>typeof methods[key]==='function'&&instance[key]!==methods[key]);
    const {widthMm,heightMm}=this.state;let current=frame.current;
    const unchanged=!verify||current?.verifiedSources?.length===world.length&&world.every((entity,index)=>{
      const prior=current!.verifiedSources![index]!;return prior.entity===entity&&prior.kind===entity.kind&&(entity.kind==='unit'||prior.xMm===entity.xMm&&prior.zMm===entity.zMm&&(entity.kind==='resource'?prior.wood===(entity.resource==='wood'):prior.typeId===entity.typeId&&prior.rotation===entity.rotation&&prior.pending===Boolean(entity.pendingConstruction)));
    });
    if(!current||current.world!==world||current.widthMm!==widthMm||current.heightMm!==heightMm||!unchanged){
      current={world,widthMm,heightMm,geometry:packStaticFootprints(world,widthMm,heightMm)};
      if(verify)current.verifiedSources=world.map(entity=>({entity,kind:entity.kind,...(entity.kind==='unit'?{}:{xMm:entity.xMm,zMm:entity.zMm,...(entity.kind==='resource'?{wood:entity.resource==='wood'}:{typeId:entity.typeId,rotation:entity.rotation,pending:Boolean(entity.pendingConstruction)})})}));
      frame.current=current;
    }
    return current.geometry;
  }
  /** A synchronous publication batch shares membership, never recipient visibility or DTOs. */
  views(playerIds:readonly string[]):PlayerView[] {
    for(const playerId of playerIds)if(!Object.hasOwn(this.state.economies,playerId))throw new Error('NOT_AUTHORIZED');
    if(!playerIds.length)return [];
    const world=this.all(),geometry=playerIds.length>1?packStaticFootprints(world,this.state.widthMm,this.state.heightMm):undefined;
    if(geometry&&Simulation.nativePublicationReaders.guard.call(this))geometry.visibility=lazyStaticVisibility(geometry,playerIds,this.state.factions,this.visibilityMasks);
    return playerIds.map(playerId=>{const result=this.viewFromRoster(playerId,world,geometry);this.publishedRecipient(playerId);return result;});
  }
  private viewFromRoster(playerId:string,world:readonly Entity[],geometry?:StaticFootprints):PlayerView;
  private viewFromRoster(playerId:string,world:readonly Entity[],geometry:StaticFootprints|undefined,projection:undefined,controller:{members:readonly Entity[];map:PlayerView['map'];fog:PlayerView['fog']}):PlayerView;
  private viewFromRoster(playerId:string,world:readonly Entity[],geometry:StaticFootprints|undefined,projection:{cache:RecipientProjection;sequence:number;members?:readonly Entity[];reuseBuildings?:boolean;batch?:ReturnType<Simulation['publicationBatch']>}):ProjectionPatch;
  private viewFromRoster(playerId:string,world:readonly Entity[],geometry:StaticFootprints|undefined,projection:{cache:RecipientProjection;sequence:number;members?:readonly Entity[];reuseBuildings?:boolean;batch?:ReturnType<Simulation['publicationBatch']>;native:true}):NativeProjection;
  private viewFromRoster(playerId:string,world:readonly Entity[],geometry?:StaticFootprints,projection?:{cache:RecipientProjection;sequence:number;members?:readonly Entity[];reuseBuildings?:boolean;batch?:ReturnType<Simulation['publicationBatch']>;native?:true},controller?:{members:readonly Entity[];map:PlayerView['map'];fog:PlayerView['fog']}):PlayerView|ProjectionPatch|NativeProjection {
    const economy=this.state.economies[playerId];
    const vision=this.state.vision[playerId]!,entities:ViewEntity[]|undefined=projection?undefined:[],owned:Entity[]=[],seen=this.visibilityMasks.get(playerId),currentIds=new Set<string>();let idleWorkers=0;
    const batch=projection?.batch;
    const append=(e:Entity,own:boolean)=>{currentIds.add(e.id);if(projection)projection.cache.entity(this.publicationEntity(e,own,playerId,projection.cache,projection.reuseBuildings,batch?.resourceViews));else{const entity=controller&&e.kind==='resource'&&!vision.actions[e.id]?this.liveResourceView(e):this.asView(e,own,playerId),trace=controller?undefined:this.visualTraceFor(playerId,e);if(trace)entity.visualTrace=trace;entities!.push(entity);}};
    const members=projection?.members??controller?.members??world;
    for(let index=0;index<members.length;index++){const e=members[index]!;if(e.ownerId===playerId){owned.push(e);if(e.kind==='unit'&&e.typeId==='villager'&&e.orders.length===0)idleWorkers++;append(e,true);}else if(projection?.members||controller||(e.kind==='unit'?!e.garrisonedIn&&this.visible(playerId,e):geometry?visibleStatic(geometry,index,seen):this.visible(playerId,e)))append(e,false);}
    let ghosts:ViewEntity[];
    if(this.liveOwned&&(projection?.members||controller)){
      const prior=this.liveGhosts.get(playerId);
      if(prior&&prior.members===members&&prior.mask===seen&&prior.revision===this.liveStaticRevision)ghosts=prior.values;
      else{ghosts=Object.values(vision.memory).filter(ghost=>!currentIds.has(ghost.id));this.liveGhosts.set(playerId,{members,mask:seen,revision:this.liveStaticRevision,values:ghosts});}
    }else ghosts=Object.values(vision.memory).filter(ghost=>!currentIds.has(ghost.id));
    for(const ghost of ghosts){if(projection){if(this.liveOwned)projection.cache.rememberedOwned(ghost);else projection.cache.remembered(ghost);}else entities!.push(controller?this.controllerGhost(ghost):{...structuredClone(ghost),ghost:true});}
    const bank=emptyBank(),incomePerMinute=emptyBank();for(const r of resources){bank[r]=Math.floor(economy.resources[r]/scale);incomePerMinute[r]=this.state.tick?Math.floor(economy.collected[r]/scale*R.simulationHz*60/this.state.tick):0;}
    const map={widthMm:this.state.widthMm,heightMm:this.state.heightMm,fogCellMm:fogGrid,type:this.state.map.type,generatorVersion:this.state.map.generatorVersion,terrain:this.state.map.terrain};
    const result={protocolVersion:PROTOCOL_VERSION,contentHash:resolveRuleset(this.options.rulesetId,this.options.maxAge,this.options.startingResourcePreset).contentHash,rulesetId:this.options.rulesetId!,maxAge:this.options.maxAge!,startingResourcePreset:this.options.startingResourcePreset!,matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,tick:this.state.tick,sequence:projection?.sequence??this.state.tick,playerId,
      status:this.state.status,...(this.options.authoritativeIntervalMs===300?{committedTimeMs:this.state.tick*1000/R.simulationHz,frameRevision:this.state.frameRevision??0,authoritativeIntervalMs:this.authoritativeFrameIntervalMs}:{}),...(this.presentationSpeed===1?{}:{simulationSpeed:this.presentationSpeed}),publicationIntervalMs:this.options.authoritativeIntervalMs===300?this.authoritativeFrameIntervalMs as 300|450|600:([100,100,150,200] as const)[this.state.movementCadenceTier],
      map:batch?.map??controller?.map??(projection?projection.cache.retain('map',map):structuredClone(map)),self:{resources:bank,lastCommandSequence:economy.lastClientSequence,incomePerMinute,age:economy.age,technologies:[...economy.technologies],...this.population(playerId,owned),populationLimit:(this.options.populationLimit??R.defaultPopulationLimit) as 80|120|200,autoReseed:economy.autoReseed,idleWorkers,notifications:structuredClone(economy.notifications),recentLedger:structuredClone(economy.ledger.slice(-30))},
      players:batch?.players??this.state.factions.map(p=>({...p,controlMode:this.state.control[p.id]!.mode,...(p.kind==='ai'?{aiMode:this.state.controllers[p.id]!.mode}:{}),age:this.state.economies[p.id]!.age as import('@frontier/shared').AgeId,defeated:this.state.economies[p.id]!.defeated})),...(entities?{entities}:{}),fog:controller?.fog??(projection?this.liveOwned&&this.options.authoritativeIntervalMs===300&&projection.reuseBuildings?projection.cache.retainFogOwned(vision.visible,vision.explored):projection.cache.retainFog(vision.visible,vision.explored):{visible:[...vision.visible],explored:[...vision.explored]}),ageAnnouncements:batch?.ageAnnouncements??structuredClone(this.state.ageAnnouncements),
      projectiles:(batch?.projectiles??this.state.projectiles.map(projectile=>({id:projectile.id,kind:projectile.kind,...(projectile.sourceTypeId?{sourceTypeId:projectile.sourceTypeId}:{}),...(projectile.sourceTypeId==='worldbreaker_trebuchet'&&projectile.kind==='stone'?{impactWarning:{...projectile.aim,radiusMm:Math.round(Math.max(...projectile.bands.map(band=>band.radiusM))*1000),hitTick:projectile.hitTick}}:{}),...projectilePosition(projectile,this.state)}))).filter(projectile=>this.visible(playerId,projectile)).slice(-4096).map(projectile=>{const {impactWarning,...visibleProjectile}=projectile;const authorized=impactWarning&&this.visible(playerId,impactWarning)?{...visibleProjectile,impactWarning}:visibleProjectile;const trace=this.traceFor(playerId,projectile.id);return trace?{...authorized,motionTrace:trace}:authorized;}),
      effects:this.state.effects.filter(effect=>effect.recipients.includes(playerId)).map(({recipients,...effect})=>({...effect})),
      monuments:batch?.monuments??(this.options.monumentVictory?world.filter((e):e is Building=>e.kind==='building'&&e.typeId==='monument'&&this.complete(e)&&!this.state.economies[e.ownerId]!.defeated).map(e=>({id:e.id,ownerId:e.ownerId,xMm:e.xMm,zMm:e.zMm,remainingTicks:Math.max(0,R.monumentHoldSeconds*R.simulationHz-(this.state.tick-(e.monumentCompletedTick??this.state.tick)))})):[]),
      ...(batch?batch.result?{result:batch.result}:{}:this.state.result?{result:structuredClone(this.state.result)}:{})};
    return projection?(projection.native?projection.cache.finishNative(result):projection.cache.finish(result)):result as PlayerView;
  }
  private cell(point:Position):number{return Math.floor(point.zMm/fogGrid)*Math.floor(this.state.widthMm/fogGrid)+Math.floor(point.xMm/fogGrid);}
  private visible(playerId:string,point:Position):boolean{
    if('kind'in point&&point.kind==='building'&&'pendingConstruction'in point&&point.pendingConstruction)return false;
    if('kind'in point&&point.kind==='unit'&&'garrisonedIn'in point&&point.garrisonedIn)return false;
    const seen=this.visibilityMasks.get(playerId);if(!seen)return false;
    if('kind'in point&&point.kind==='resource'){
      const resource=point as ResourceNode|ViewEntity,radius=resource.resource==='wood'?450:650,width=Math.floor(this.state.widthMm/fogGrid),height=Math.floor(this.state.heightMm/fogGrid);
      for(let z=Math.max(0,Math.floor((point.zMm-radius)/fogGrid));z<=Math.min(height-1,Math.ceil((point.zMm+radius)/fogGrid)-1);z++)for(let x=Math.max(0,Math.floor((point.xMm-radius)/fogGrid));x<=Math.min(width-1,Math.ceil((point.xMm+radius)/fogGrid)-1);x++)if(seen[z*width+x])return true;
      return false;
    }
    if('kind'in point&&point.kind==='unit'&&'typeId'in point){
      if(seen[this.cell(point)])return true;
      const radius=units[point.typeId as UnitId].collisionRadiusM*1000,width=Math.floor(this.state.widthMm/fogGrid),height=Math.floor(this.state.heightMm/fogGrid);
      for(let z=Math.max(0,Math.floor((point.zMm-radius)/fogGrid));z<=Math.min(height-1,Math.floor((point.zMm+radius)/fogGrid));z++)for(let x=Math.max(0,Math.floor((point.xMm-radius)/fogGrid));x<=Math.min(width-1,Math.floor((point.xMm+radius)/fogGrid));x++){
        if(!seen[z*width+x])continue;const dx=Math.max(x*fogGrid-point.xMm,0,point.xMm-(x+1)*fogGrid),dz=Math.max(z*fogGrid-point.zMm,0,point.zMm-(z+1)*fogGrid);if(dx*dx+dz*dz<=radius*radius)return true;
      }
      return false;
    }
    if('kind'in point&&point.kind==='building'&&'typeId'in point){
      const building=point as Building|ViewEntity,def=buildings[building.typeId as BuildingId];
      let [w,h]=def.footprintCells;if(building.rotation===90||building.rotation===270)[w,h]=[h,w];
      const width=Math.floor(this.state.widthMm/fogGrid);
      for(let z=point.zMm-h*grid/2+fogGrid/2;z<point.zMm+h*grid/2;z+=fogGrid){const row=Math.floor(z/fogGrid)*width;for(let x=point.xMm-w*grid/2+fogGrid/2;x<point.xMm+w*grid/2;x+=fogGrid)if(seen[row+Math.floor(x/fogGrid)])return true;}
      return false;
    }
    return Boolean(seen[this.cell(point)]);
  }
  /** Fresh phase-local memberships, in original world order. No fog result survives its frame. */
  private staticMembership(world:readonly Entity[],geometry:StaticFootprints,masks:ReadonlyMap<string,Uint8Array>,includeOwned:boolean,visibleCells?:ReadonlyMap<Uint8Array,readonly number[]>):Map<string,Entity[]>|undefined {
    const factions=this.state.factions;
    // Public state remains mutable; unusual external rosters retain the scalar path.
    if(!factions.length||factions.length>R.factionLimit||factions.length>16||geometry.columns<=0)return undefined;
    const ownerBits=new Map<string,number>(),groups=new Map<Uint8Array,number>(),lists:Entity[][]=[],result=new Map<string,Entity[]>();let size=0;
    for(let index=0;index<factions.length;index++){
      const id=factions[index]!.id;if(ownerBits.has(id))return undefined;
      const bit=1<<index,mask=masks.get(id),list:Entity[]=[];ownerBits.set(id,bit);lists.push(list);result.set(id,list);
      if(mask){if(visibleCells&&!visibleCells.has(mask))return undefined;groups.set(mask,(groups.get(mask)??0)|bit);size=Math.max(size,mask.length);}
    }
    const cells=new Uint16Array(size);
    for(const [mask,bits]of groups){
      if(visibleCells){for(const cell of visibleCells.get(mask)!)cells[cell]=cells[cell]!|bits;}
      else for(let cell=0;cell<mask.length;cell++)if(mask[cell])cells[cell]=cells[cell]!|bits;
    }
    const spans=geometry.spans;
    for(let index=0;index<world.length;index++){
      const entity=world[index]!;if(entity.kind==='unit')continue;
      const offset=index*4;let bits=0;
      // Preserve legacy linear cell indexing even for off-grid public fixtures.
      for(let row=spans[offset+2]!;row<=spans[offset+3]!;row+=geometry.columns)for(let x=spans[offset]!;x<=spans[offset+1]!;x++)bits|=cells[row+x]??0;
      const owned=ownerBits.get(entity.ownerId!)??0;bits=includeOwned?bits|owned:bits&~owned;
      while(bits){const bit=bits&-bits;lists[31-Math.clz32(bit)]!.push(entity);bits&=bits-1;}
    }
    return result;
  }
  private observeActions():void {
    // Deaths/ejection may have changed both membership and fog since movement.
    const world=this.all();
    if(this.perceptionWorld!==world){
      this.perceptionWorld=this.synchronizePerception(world)?world:undefined;
      if(this.perceptionWorld){const groups=new Map<string,Uint8Array>();for(const faction of this.state.factions){const mask=this.visibilityMasks.get(faction.id);if(mask)groups.set(this.visionGroup(faction.id),mask);}this.perceptionMembership.commit([...groups].map(([key,mask])=>({key,mask})));this.rememberStaticKnowledge(world);}
    }
    if(this.perceptionWorld){const update=this.liveOwned?this.observedActionCache.updateOwned:this.observedActionCache.update;update.call(this.observedActionCache,this.state,this.committedActions,playerId=>this.perceptionMembership.actors(this.visionGroup(playerId),playerId),(playerId,entity)=>this.perceptionMembership.visible(this.visionGroup(playerId),entity.id));return;}
    const actors=world.filter(entity=>entity.kind!=='resource'),geometry=packStaticFootprints(actors,this.state.widthMm,this.state.heightMm);
    const canonicalUnitVisibility=admissionMethod(this,'visible',Simulation.combatPhaseReaders.visible)&&admissionMethod(this,'cell',Simulation.combatPhaseReaders.cell);
    const unitCells=canonicalUnitVisibility?observationUnitCells(actors,this.state.widthMm,this.state.heightMm):undefined;
    updateObservedActions(this.state,this.committedActions,(playerId,entity,index)=>entity.kind==='building'?visibleStatic(geometry,index,this.visibilityMasks.get(playerId)):unitCells?visibleObservedUnit(entity,index,unitCells,this.visibilityMasks.get(playerId),()=>this.visible(playerId,entity)):this.visible(playerId,entity),actors);
  }
  private updateVision():void {this.commitVision(this.visionKernel.computeRetained(this.prepareVision()));}
  private async updateVisionAsync(phase:string):Promise<void>{
    const frame=this.prepareVision(),pending=this.visionExecutor!(frame,{matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,tick:this.state.tick,phase});
    // Actor footprint reconciliation does not read the new fog, so it can run
    // while persistent workers update their mask unions. Only the inaccessible
    // native owner may reuse this preparation after an asynchronous boundary.
    // Generic mutable fixtures still reconcile at commit, as before.
    let prepared:readonly Entity[]|undefined;
    try{if(this.liveOwned){const world=this.all();if(this.synchronizePerception(world))prepared=world;}}
    catch(error){await pending.catch(()=>undefined);throw error;}
    const results=await pending;this.checkLiveOwnership();this.commitVision(results,prepared);
  }
  /** Retain only private immutable source snapshots. Every contact slice still
   * reads current actor ownership, type and pose; no movement/fog is deferred. */
  private prepareOwnedVisionGroups(actors:readonly Entity[],cacheKey:string):readonly VisionMaskGroup[]|undefined {
    const prior=this.liveVisionSources;this.liveVisionSources=undefined;
    if(actors.length>MAX_WORLD_ACTORS||this.state.factions.length>R.factionLimit)return;
    const owners=this.state.factions.map(faction=>({id:faction.id,key:this.visionGroup(faction.id)}));
    if(prior&&prior.actors===actors&&prior.epoch===this.state.matchEpoch&&prior.cacheKey===cacheKey&&prior.slots.length===actors.length&&prior.owners.length===owners.length&&owners.every((owner,index)=>owner.id===prior.owners[index]!.id&&owner.key===prior.owners[index]!.key)){
      let slots=prior.slots,groups=prior.groups,compatible=true;const changed=new Map<number,VisionMaskSource[]>();
      for(let index=0;index<actors.length;index++){
        const entity=actors[index]!,slot=slots[index]!;
        if(slot.entity!==entity||entity.kind==='resource'||slot.ownerId!==entity.ownerId||slot.typeId!==entity.typeId){compatible=false;break;}
        const xMm=entity.xMm,zMm=entity.zMm,radius=(entity.kind==='unit'?units[entity.typeId].visionM:buildings[entity.typeId].visionM)*1000;
        if(slot.source.id===entity.id&&slot.source.xMm===xMm&&slot.source.zMm===zMm&&slot.source.radius===radius)continue;
        const source=immutableVisionSource(entity.id,xMm,zMm,radius,entity.kind),sources=changed.get(slot.group)??[...groups[slot.group]!.sources];sources[slot.index]=source;changed.set(slot.group,sources);
        if(slots===prior.slots)slots=slots.slice();slots[index]={...slot,source};
      }
      if(compatible){
        if(changed.size){const next=groups.slice();for(const [index,sources]of changed)next[index]=immutableVisionGroup(groups[index]!.key,sources);groups=Object.freeze(next);}
        this.liveVisionSources={...prior,slots,groups};return groups;
      }
    }
    const groupIndices=new Map<string,number>(),ownerGroups=new Map<string,number>(),sources:VisionMaskSource[][]=[],keys:string[]=[],slots:NonNullable<Simulation['liveVisionSources']>['slots']=[],ids=new Set<string>();
    for(const owner of owners){let index=groupIndices.get(owner.key);if(index===undefined){index=keys.length;keys.push(owner.key);sources.push([]);groupIndices.set(owner.key,index);}ownerGroups.set(owner.id,index);}
    for(const entity of actors){
      if(entity.kind==='resource'||ids.has(entity.id))return;ids.add(entity.id);
      const group=ownerGroups.get(entity.ownerId);if(group===undefined)return;
      const source=immutableVisionSource(entity.id,entity.xMm,entity.zMm,(entity.kind==='unit'?units[entity.typeId].visionM:buildings[entity.typeId].visionM)*1000,entity.kind),index=sources[group]!.length;
      sources[group]!.push(source);slots.push({entity,ownerId:entity.ownerId,typeId:entity.typeId,group,index,source});
    }
    const groups=Object.freeze(keys.map((key,index)=>immutableVisionGroup(key,sources[index]!)));
    this.liveVisionSources={actors,epoch:this.state.matchEpoch,cacheKey,owners,groups,slots};return groups;
  }
  private prepareVision():VisionMaskFrame {
    const width=Math.floor(this.state.widthMm/fogGrid),height=Math.floor(this.state.heightMm/fogGrid);
    const cacheKey=`${width}:${height}:${this.state.map.type}:${this.state.map.generatorVersion}:${this.state.map.seed}`;
    if(this.visionCacheKey!==cacheKey){this.visionCacheKey=cacheKey;this.visibilityMasks.clear();this.committedFog.clear();this.liveExploredMasks.clear();this.visionBlockersVersion=-1;this.visionCheckedNavigationRevision=-1;}
    if(this.visionCheckedNavigationRevision!==this.state.navigationRevision||this.visionTerrain!==this.state.map.terrain){
      const blockers=terrainVisionBlockers(this.state.map.terrain),changed=blockers.length!==this.visionBlockers.length||blockers.some((blocker,index)=>{const prior=this.visionBlockers[index]!;return blocker.id!==prior.id||blocker.xMm!==prior.xMm||blocker.zMm!==prior.zMm||blocker.halfWidth!==prior.halfWidth||blocker.halfHeight!==prior.halfHeight;});
      if(this.visionBlockersVersion<0||changed){this.visionBlockers=blockers;this.visionBlockersVersion++;}
      this.visionCheckedNavigationRevision=this.state.navigationRevision;this.visionTerrain=this.state.map.terrain;
    }
    let visionActors:Entity[]|undefined;
    if(this.liveOwned){const actors=this.actors();if(this.liveVisionActors?.actors!==actors)this.liveVisionActors={actors,members:actors.filter(entity=>!(entity.kind==='building'&&entity.pendingConstruction))};visionActors=this.liveVisionActors.members;}
    const retained=visionActors?this.prepareOwnedVisionGroups(visionActors,cacheKey):undefined;
    if(retained)return {width,height,gridMm:fogGrid,cacheKey,blockerRevision:this.visionBlockersVersion,blockers:this.visionBlockers,groups:retained};
    const groups=new Map<string,{key:string;sources:{id:string;xMm:number;zMm:number;radius:number}[]}>(),owners=new Map<string,string>();
    for(const faction of this.state.factions){const key=this.visionGroup(faction.id);owners.set(faction.id,key);if(!groups.has(key))groups.set(key,{key,sources:[]});}
    for(const e of (this.coarseFrame?this.actors():this.all()))if(e.kind!=='resource'&&!(e.kind==='building'&&e.pendingConstruction))groups.get(owners.get(e.ownerId)!)!.sources.push({id:e.id,xMm:e.xMm,zMm:e.zMm,radius:(e.kind==='unit'?units[e.typeId].visionM:buildings[e.typeId].visionM)*1000});
    return {width,height,gridMm:fogGrid,cacheKey,blockerRevision:this.visionBlockersVersion,blockers:this.visionBlockers,groups:[...groups.values()]};
  }
  private visionGroup(playerId:string):string {const faction=this.state.factions.find(f=>f.id===playerId)!;return (this.options.sharedVision??true)?`team:${faction.teamId}`:`player:${faction.id}`;}
  private static readonly staticMemoryReaders=Object.freeze({commit:Simulation.prototype.commitVision,refresh:Simulation.prototype.refreshStaticMemory,asView:Simulation.prototype.asView,all:Simulation.prototype.all,visible:Simulation.prototype.visible,group:Simulation.prototype.visionGroup});
  private commitVision(results:VisionMaskResult[],preparedWorld?:readonly Entity[]):void {
    const world=this.all(),groups=new Map(results.map(result=>[result.key,result])),ownerMasks=new Map<string,Uint8Array>(),groupCells=new Map<Uint8Array,number[]>();
    for(const faction of this.state.factions){const result=groups.get(this.visionGroup(faction.id));if(!result)throw new Error('INCOMPLETE_VISION_BATCH');ownerMasks.set(faction.id,result.mask);this.activeWorkRoster?.observeVisibility(faction.id,this.visibilityMasks.get(faction.id),result.mask);this.visibilityMasks.set(faction.id,result.mask);groupCells.set(result.mask,result.visible);}
    this.perceptionWorld=(this.liveOwned&&preparedWorld===world||this.synchronizePerception(world))?world:undefined;
    if(this.perceptionWorld){this.perceptionMembership.commit(results);this.rememberStaticKnowledge(world);}
    const geometry=this.perceptionWorld?undefined:packStaticFootprints(world,this.state.widthMm,this.state.heightMm),staticMembers=geometry?this.staticMembership(world,geometry,ownerMasks,false,groupCells):undefined;
    // A first authorized recipient already reconciles the complete common static
    // payload. Reuse that phase-local observation for allied recipients, while
    // still checking each publicly mutable memory and its private action. No
    // observation reference is assigned to a different recipient's memory.
    const original=Simulation.staticMemoryReaders,canonical=this.commitVision===original.commit&&this.refreshStaticMemory===original.refresh&&this.asView===original.asView&&this.all===original.all&&this.visible===original.visible&&this.visionGroup===original.group;
    const scheduledResources=this.liveOwned&&this.coarseFrame&&canonical&&Boolean(this.perceptionWorld);
    if(!scheduledResources)Simulation.resourceObservationFlush.call(this,true);
    // Imported observations may contain a resource action. Keep only those
    // unusual resources awake until the actor-only action phase removes it.
    const resourceActions=scheduledResources?new Set<ResourceNode>():undefined;
    const groupCounts=new Map<string,number>();if(canonical&&this.perceptionWorld)for(const faction of this.state.factions){const key=this.visionGroup(faction.id);groupCounts.set(key,(groupCounts.get(key)??0)+1);}
    const sharedSamples=groupCounts.size<this.state.factions.length&&groupCounts.size?new Map<Entity,StaticMemorySample>():undefined;
    for(const faction of this.state.factions){
      const seen=ownerMasks.get(faction.id)!,v=this.state.vision[faction.id]!,visible=groupCells.get(seen)!;
      const prior=this.committedFog.get(faction.id);
      const sameExplored=prior&&v.explored===prior.explored&&(this.liveOwned||sameFogCells(v.explored,prior.exploredBaseline));
      const ownedExplored=this.liveOwned?this.liveExploredMasks.get(faction.id):undefined;
      if(ownedExplored&&sameExplored&&ownedExplored.array===v.explored&&ownedExplored.mask.length===seen.length){
        if(prior.mask!==seen||prior.source!==visible){
          // Current visibility still commits every contact slice. Exploration is
          // monotonic, so scan only newly visible words and leave already-known
          // history untouched rather than copying the whole map six times/frame.
          const discovered:number[]=[],changed=changedVisionMaskWords(prior.mask,seen);
          if(changed){for(const word of changed)for(let cell=word*32;cell<Math.min(seen.length,word*32+32);cell++)if(seen[cell]&&!ownedExplored.mask[cell]){ownedExplored.mask[cell]=1;discovered.push(cell);}}
          else for(const cell of visible)if(!ownedExplored.mask[cell]){ownedExplored.mask[cell]=1;discovered.push(cell);}
          if(discovered.length){v.explored=mergeExploredCells(v.explored,discovered,ownedExplored.mask);ownedExplored.array=v.explored;}
        }
      }else{
        if(!sameExplored||prior.mask!==seen||prior.source!==visible)v.explored=mergeExploredCells(v.explored,visible,seen);
        if(this.liveOwned){const mask=new Uint8Array(seen.length);for(const cell of v.explored)mask[cell]=1;this.liveExploredMasks.set(faction.id,{array:v.explored,mask});}
      }
      // Replaced/aliased public arrays must be detached even when their values match.
      if(!prior||v.visible!==prior.visible||!(this.liveOwned&&prior.source===visible)&&!sameFogCells(v.visible,visible))v.visible=[...visible];
      const exploredBaseline=sameExplored&&v.explored===prior.explored?prior.exploredBaseline:v.explored.slice();
      this.committedFog.set(faction.id,{mask:seen,source:visible,visible:v.visible,explored:v.explored,exploredBaseline});
      if(this.liveOwned){
        let missing=this.liveMissingMemory.get(faction.id);
        if(!missing||missing.revision!==this.liveStaticRevision){missing={revision:this.liveStaticRevision,ids:new Set(Object.keys(v.memory).filter(id=>!this.state.entities[id]))};this.liveMissingMemory.set(faction.id,missing);}
        for(const id of missing.ids)if(this.visible(faction.id,v.memory[id]!)){delete v.memory[id];missing.ids.delete(id);this.liveKnowledgeBindings.delete(faction.id);this.liveGhosts.delete(faction.id);this.frameStaticMembers.delete(faction.id);}
      }else for(const id of Object.keys(v.memory))if(!this.state.entities[id]&&this.visible(faction.id,v.memory[id]!))delete v.memory[id];
      // Memory observes only visible statics. Allied recipients share this
      // ordered roster while refreshing their own detached observations below.
      const key=this.visionGroup(faction.id),previous=this.frameResourceObservations.get(faction.id);
      // A recipient's own completed observation is the time authority. A second
      // command-induced vision refresh can occur at this same simulation tick.
      const retained=previous?.key===key&&previous.epoch===this.state.matchEpoch&&previous.vision===v?previous:undefined;
      if(previous&&!retained){for(const resource of previous.resources){const memory=previous.vision.memory[resource.id];if(memory)memory.lastSeenTick=Math.max(memory.lastSeenTick??0,previous.tick);}this.frameResourceObservations.delete(faction.id);}
      const scheduled=scheduledResources?this.perceptionMembership.resourceObservations(key,retained?.resources,this.frameChangedResources):undefined;
      if(scheduled&&retained)for(const resource of scheduled.exited){const memory=v.memory[resource.id];if(memory)memory.lastSeenTick=Math.max(memory.lastSeenTick??0,retained.tick);}
      const members=scheduled?.observations??(this.perceptionWorld?this.perceptionMembership.visibleStatics(key):staticMembers?.get(faction.id));
      const samples=(groupCounts.get(this.visionGroup(faction.id))??0)>1?sharedSamples:undefined;
      if(members){for(const e of members)if(e.kind!=='unit'&&e.ownerId!==faction.id){
        if(this.liveOwned&&e.kind==='resource'){const observation=this.refreshStaticMemory(e,faction.id);if(scheduled){resourceObservationCounts.refreshed=Math.min(Number.MAX_SAFE_INTEGER,resourceObservationCounts.refreshed+1);if(observation.visualAction)resourceActions!.add(e);}continue;}
        const sample=samples?.get(e);
        const observation=this.refreshStaticMemory(e,faction.id,sample);
        if(samples&&!sample){const forest=observation.forest;samples.set(e,{observation,...(forest&&Object.keys(forest).length===2&&Object.hasOwn(forest,'cellMm')&&Object.hasOwn(forest,'patchId')&&typeof forest.cellMm==='number'&&typeof forest.patchId==='string'?{forest:{cellMm:forest.cellMm,patchId:forest.patchId}}:{})});}
      }}
      else for(let index=0;index<world.length;index++){
        const e=world[index]!;
        if(e.kind!=='unit'&&e.ownerId!==faction.id&&visibleStatic(geometry!,index,seen)){
          // asView already creates a detached observation for this recipient.
          const memory=this.asView(e,false,faction.id);memory.lastSeenTick=this.state.tick;v.memory[e.id]=memory;
        }
      }
      if(scheduled){this.frameResourceObservations.set(faction.id,{key,epoch:this.state.matchEpoch,vision:v,resources:scheduled.resources,tick:this.state.tick});resourceObservationCounts.deferred=Math.min(Number.MAX_SAFE_INTEGER,resourceObservationCounts.deferred+scheduled.resources.length);}
    }
    this.frameChangedResources.clear();
    for(const resource of resourceActions??[])this.frameChangedResources.add(resource);
    for(const playerId of this.committedFog.keys())if(!ownerMasks.has(playerId))this.committedFog.delete(playerId);
    this.tracePerceptionSnapshot=this.liveOwned&&this.perceptionWorld===world?{world,tick:this.state.tick,epoch:this.state.matchEpoch,groups:this.state.factions.map(faction=>({playerId:faction.id,key:this.visionGroup(faction.id),mask:ownerMasks.get(faction.id)!}))}:undefined;
  }
  /** Unchanged sight still advances lastSeenTick. Public payload changes are
   * checked independently of fog, including depletion, damage and actual poses. */
  private refreshStaticMemory(entity:Building|ResourceNode,playerId:string,sample?:StaticMemorySample):ViewEntity{
    const vision=this.state.vision[playerId]!,prior=vision.memory[entity.id],action=vision.actions[entity.id];
    if(this.liveOwned&&entity.kind==='resource'&&!action){
      const source=this.liveResourceView(entity);
      if(prior&&this.liveMemorySources.get(prior)===source){prior.lastSeenTick=this.state.tick;return prior;}
      const memory={...source,...(source.forest?{forest:{...source.forest}}:{}),lastSeenTick:this.state.tick};
      this.liveMemorySources.set(memory,source);vision.memory[entity.id]=memory;return memory;
    }
    const source=sample?.observation??entity;
    let unchanged=Boolean(prior&&!prior.ghost&&prior.kind===source.kind&&prior.typeId===source.typeId&&prior.ownerId===source.ownerId&&prior.xMm===source.xMm&&prior.zMm===source.zMm&&prior.hp===source.hp&&prior.maxHp===source.maxHp&&sameJson(prior.visualAction,action)
      &&(action?Object.keys(prior).indexOf('visualAction')===(entity.kind==='resource'?8:10):!Object.hasOwn(prior,'visualAction')));
    if(unchanged&&entity.kind==='resource'){
      const forest=prior!.forest,expected=sample?.forest;
      unchanged=prior!.resource===(sample?sample.observation.resource:entity.resource)&&prior!.amount===(sample?sample.observation.amount:Math.ceil(entity.amount/scale))
        &&(expected?Boolean(forest&&Object.keys(forest).length===2&&Object.hasOwn(forest,'cellMm')&&Object.hasOwn(forest,'patchId')&&forest.cellMm===expected.cellMm&&forest.patchId===expected.patchId):sameJson(forest,sample?sample.observation.forest:entity.forest));
    }else if(unchanged){const building=entity as Building,observed=sample?.observation;unchanged=prior!.rotation===(observed?observed.rotation:building.rotation)&&prior!.progress===(observed?observed.progress:building.required?building.work/building.required:1)&&prior!.gateOpen===(observed?observed.gateOpen:building.gateOpen)&&prior!.visualAge===(observed?observed.visualAge:this.state.economies[building.ownerId]!.age)&&prior!.visualTier==='base'&&sameJson(prior!.ward,building.ward?{current:building.ward.current,max:building.ward.max}:undefined);
      if(unchanged&&building.typeId==='farm')unchanged=prior!.resource==='food'&&prior!.amount===(observed?observed.amount:Math.floor((building.foodRemaining??0)/scale))&&prior!.farmState===(observed?observed.farmState:building.reseedRequired?'reseeding':(building.foodRemaining??0)>0?'ready':'exhausted')&&prior!.reseedProgress===(observed?observed.reseedProgress:building.reseedRequired?building.reseedWork!/building.reseedRequired:undefined);
    }
    if(unchanged){prior!.lastSeenTick=this.state.tick;return prior!;}
    const memory=this.asView(entity,false,playerId);memory.lastSeenTick=this.state.tick;vision.memory[entity.id]=memory;return memory;
  }
  private hostile(a:string,b:string|null):boolean{return b!==null&&this.state.factions.find(f=>f.id===a)!.teamId!==this.state.factions.find(f=>f.id===b)!.teamId;}
  private static readonly factionLookupReaders=Object.freeze({hostile:Simulation.prototype.hostile,lookup:Simulation.prototype.factionHostility,snapshot:Simulation.prototype.factionSnapshot,run:Simulation.prototype.runFactionPhase,find:Array.prototype.find});
  private static readonly factionLookupContexts=new WeakMap<OrderContext,ReturnType<Simulation['factionHostility']>>();
  /** Maps live only on the certified synchronous phase stack. Detached/manual
   * contexts retain the original mutable-state predicate without a query scan. */
  private factionHostility():{active:boolean;factions:Map<string,PublicPlayer>|undefined;hostile:OrderContext['hostile']}{
    const original=Simulation.factionLookupReaders.hostile;
    const lookup:ReturnType<Simulation['factionHostility']>={active:false,factions:undefined,hostile:(a,b)=>{
      const factions=lookup.factions;
      if(!lookup.active||!factions||this.hostile!==original)return this.hostile(a,b);
      return b!==null&&factions.get(a)!.teamId!==factions.get(b)!.teamId;
    }};
    return lookup;
  }
  /** At most eleven records are checked once when a proven phase activates.
   * Preserve find's first duplicate and read current team fields from its refs. */
  private factionSnapshot():Map<string,PublicPlayer>|undefined{
    const original=Simulation.factionLookupReaders;if(!admissionMethod(this,'hostile',original.hostile))return;
    const state=Object.getOwnPropertyDescriptor(this,'state'),stateValue=state&&'value'in state?state.value:undefined;
    const field=admissionRecord(stateValue)?Object.getOwnPropertyDescriptor(stateValue,'factions'):undefined,roster=field&&'value'in field?field.value:undefined;
    if(!Array.isArray(roster)||nodeTypes.isProxy(roster)||Object.getPrototypeOf(roster)!==Array.prototype||roster.length>11||!admissionMethod(roster,'find',original.find))return;
    const factions=new Map<string,PublicPlayer>();
    for(let index=0;index<roster.length;index++){
      const slot=Object.getOwnPropertyDescriptor(roster,String(index)),faction=slot&&'value'in slot?slot.value:undefined;if(!admissionRecord(faction))return;
      const id=Object.getOwnPropertyDescriptor(faction,'id'),team=Object.getOwnPropertyDescriptor(faction,'teamId');
      if(!id||!('value'in id)||typeof id.value!=='string'||!team||!('value'in team)||typeof team.value!=='string')return;
      if(!factions.has(id.value))factions.set(id.value,faction as unknown as PublicPlayer);
    }
    return factions;
  }
  private runFactionPhase(context:OrderContext,phase:'engagement'|'combat'):void{
    const lookup=Simulation.factionLookupContexts.get(context),name=phase==='engagement'?'updateEngagements':'advanceCombat';
    if(lookup){lookup.active=admissionMethod(this,name,Simulation.combatPhaseReaders[name]);lookup.factions=undefined;}
    try{if(phase==='engagement')this.updateEngagements(context);else{
      // Only inaccessible native authority may defer counter writes. Public or
      // instrumented callbacks retain their original observable per-tick reads.
      if(this.liveOwned&&this.coarseFrame&&this.advanceCombat===advanceCombat){if(!this.frameCombatTimelineChecked){this.frameCombatTimelineChecked=true;this.frameCombatTimeline=NativeCombatTimeline.create(this.state,this.actors(),this.state.tick-1,this.frameEndTick);}}
      else this.flushCombatTimeline();
      this.wards.advance(this.state,this.liveOwned?this.actors():this.all(),true,this.liveOwned?this.liveStaticRevision:undefined);this.advanceCombat(context,this.frameCombatTimeline);
    }}
    finally{if(lookup){lookup.active=false;lookup.factions=undefined;}}
  }
  private bounds(e:Entity):{halfWidth:number;halfHeight:number}{
    if(e.kind==='building'){let [w,h]=buildings[e.typeId].footprintCells;if(e.rotation===90||e.rotation===270)[w,h]=[h,w];return {halfWidth:w!*grid/2,halfHeight:h!*grid/2};}
    const radius=e.kind==='unit'?units[e.typeId].collisionRadiusM*1000:e.resource==='wood'?450:650;return {halfWidth:radius,halfHeight:radius};
  }
  private entityObstacles(entity:Entity,planningFor?:string):Obstacle[]{
    if(entity.kind==='building'&&entity.pendingConstruction)return [];
    if(entity.kind==='building')return fortificationObstacles(entity,planningFor&&!this.state.economies[entity.ownerId]!.defeated?planningFor:undefined,(a,b)=>this.hostile(a,b));
    return entity.kind==='resource'&&entity.amount>0?[{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,...resourceWorkBounds(entity)}]:[];
  }
  private constructionDiscovery(playerId:string):(xMm:number,zMm:number)=>boolean {
    const explored=this.state.vision[playerId]!.explored,cached=this.liveOwned?this.liveExploredMasks.get(playerId):undefined;
    if(cached?.array===explored)return (xMm,zMm)=>Boolean(cached.mask[this.cell({xMm,zMm})]);
    const cells=new Set(explored);return (xMm,zMm)=>cells.has(this.cell({xMm,zMm}));
  }
  private knownConstructionOccupants(playerId:string):Entity[]{
    return [...this.knownStatic(playerId),...this.actors().filter(entity=>entity.kind==='unit'&&!entity.garrisonedIn&&entity.hp>0&&(entity.ownerId===playerId||this.visible(playerId,entity)))];
  }
  private constructionOverlap(site:Pick<Building,'id'|'typeId'|'xMm'|'zMm'|'rotation'>,entity:Entity,gap:number):boolean {
    if(entity.id===site.id||entity.kind==='resource'&&entity.amount===0||entity.kind==='unit'&&(entity.garrisonedIn||entity.hp<=0))return false;
    const size=this.bounds(site as Building),left=site.xMm-size.halfWidth,right=site.xMm+size.halfWidth,top=site.zMm-size.halfHeight,bottom=site.zMm+size.halfHeight;
    const bounds=entity.kind==='resource'?resourcePlacementBounds(entity,R.treeBuildingClearanceM*1000):this.workBounds(entity);
    if(entity.kind==='building'&&(!buildings[site.typeId].wallEquivalentCells||!buildings[entity.typeId].wallEquivalentCells)){bounds.halfWidth+=gap;bounds.halfHeight+=gap;}
    if(entity.kind==='unit'){const dx=Math.max(left-entity.xMm,0,entity.xMm-right),dz=Math.max(top-entity.zMm,0,entity.zMm-bottom);return dx*dx+dz*dz<bounds.halfWidth*bounds.halfWidth;}
    return entity.xMm+bounds.halfWidth>left&&entity.xMm-bounds.halfWidth<right&&entity.zMm+bounds.halfHeight>top&&entity.zMm-bounds.halfHeight<bottom;
  }
  /** Only this worker's paid order, at most one wall batch. Planned sites are
   * nonphysical, but a builder must leave their footprints before working. */
  private pendingBuildOverlap(unit:Unit,point:Position=unit):Building|undefined {
    const order=unit.orders[0];if(order?.kind!=='build')return;
    const radius=units[unit.typeId].collisionRadiusM*1000;
    for(const id of order.wallTargets??(order.targetId?[order.targetId]:[])){
      const site=this.state.entities[id];if(site?.kind!=='building'||site.ownerId!==unit.ownerId||!site.pendingConstruction)continue;
      const bounds=this.bounds(site),dx=Math.max(0,Math.abs(point.xMm-site.xMm)-bounds.halfWidth),dz=Math.max(0,Math.abs(point.zMm-site.zMm)-bounds.halfHeight);
      if(dx*dx+dz*dz<radius*radius)return site;
    }
    return;
  }
  /** Only visited after a real worker reaches this paid site. Static geometry
   * is indexed once per structural revision; moving units remain current. */
  private activateConstruction(site:Building):boolean {
    const pending=site.pendingConstruction;if(!pending)return true;if(this.state.tick<(pending.retryAtTick??0))return false;
    const bucketMm=16000;let index=this.liveOwned?this.constructionOccupancy:undefined;
    if(!index||index.state!==this.state||index.revision!==this.liveStaticRevision){
      const buckets=new Map<string,Entity[]>();
      for(const entity of this.all())if(entity.kind!=='unit'&&!(entity.kind==='building'&&entity.pendingConstruction)&&!(entity.kind==='resource'&&entity.amount===0)){
        const bounds=entity.kind==='resource'?resourcePlacementBounds(entity,R.treeBuildingClearanceM*1000):this.workBounds(entity),margin=entity.kind==='building'?aiBuildingClearanceMm:0;
        for(let z=Math.floor((entity.zMm-bounds.halfHeight-margin)/bucketMm);z<=Math.floor((entity.zMm+bounds.halfHeight+margin)/bucketMm);z++)for(let x=Math.floor((entity.xMm-bounds.halfWidth-margin)/bucketMm);x<=Math.floor((entity.xMm+bounds.halfWidth+margin)/bucketMm);x++){const key=`${x}:${z}`,rows=buckets.get(key)??[];rows.push(entity);buckets.set(key,rows);}
      }
      index={state:this.state,revision:this.liveStaticRevision,buckets};if(this.liveOwned)this.constructionOccupancy=index;
    }
    const bounds=this.bounds(site),candidates=new Set<Entity>();
    for(let z=Math.floor((site.zMm-bounds.halfHeight)/bucketMm);z<=Math.floor((site.zMm+bounds.halfHeight)/bucketMm);z++)for(let x=Math.floor((site.xMm-bounds.halfWidth)/bucketMm);x<=Math.floor((site.xMm+bounds.halfWidth)/bucketMm);x++)for(const entity of index.buckets.get(`${x}:${z}`)??[])candidates.add(entity);
    const blocked=[...candidates].some(entity=>this.constructionOverlap(site,entity,pending.clearanceMm))||this.actors().some(entity=>entity.kind==='unit'&&this.constructionOverlap(site,entity,0));
    if(blocked){pending.blocked=true;pending.retryAtTick=this.state.tick+R.simulationHz;return false;}
    delete site.pendingConstruction;this.invalidateEntityRoster(true);this.state.navigationRevision++;this.activeWorkRoster?.wakeTarget(site.id);return true;
  }
  private obstacles():Obstacle[]{return [...terrainObstacles(this.state.map.terrain),...this.all().flatMap(e=>this.entityObstacles(e))];}
  /** Public terrain is reconciled by the exact fields that construct its ordered
   * barriers/passages. No mutable map-array or global revision is a freshness key. */
  private knownTerrainObstacles():Obstacle[]{
    const terrain=this.state.map.terrain,prior=this.knownTerrain;
    if(this.liveOwned&&prior)return prior.obstacles;
    if(!prior||terrain.length!==prior.sources.length||terrain.some((region,index)=>{const old=prior.sources[index]!;return region.id!==old.id||region.kind!==old.kind||region.xMm!==old.xMm||region.zMm!==old.zMm||region.widthMm!==old.widthMm||region.depthMm!==old.depthMm;})){
      const obstacles=terrainObstacles(terrain);for(const obstacle of obstacles)Object.freeze(obstacle);Object.freeze(obstacles);
      this.knownTerrain={sources:terrain.map(({id,kind,xMm,zMm,widthMm,depthMm})=>({id,kind,xMm,zMm,widthMm,depthMm})),obstacles};
    }
    return this.knownTerrain!.obstacles;
  }
  /** Reconcile live physical geometry. Recipient planning uses this only for
   * non-gates; the physical navigation cache also retains actual gate shapes. */
  private sharedMovementObstacle(entity:Entity,prior:SharedObstacleRecord|undefined):SharedObstacleRecord{
    const building=entity.kind==='building'?entity:undefined;
    const kind=entity.kind,typeId=entity.typeId,xMm=entity.xMm,zMm=entity.zMm,rotation=building?.rotation;
    const active=entity.kind==='resource'&&entity.amount>0,wood=entity.kind==='resource'&&entity.resource==='wood';
    const forestCellMm=entity.kind==='resource'?entity.forest?.cellMm??0:0,open=Boolean(building?.gateOpen),incomplete=building?building.work<building.required:false,pending=Boolean(building?.pendingConstruction);
    if(prior&&prior.kind===kind&&prior.typeId===typeId&&prior.xMm===xMm&&prior.zMm===zMm&&prior.rotation===rotation&&prior.active===active&&prior.wood===wood&&prior.forestCellMm===forestCellMm&&prior.open===open&&prior.incomplete===incomplete&&prior.pending===pending)return prior;
    const obstacles=this.entityObstacles(entity);for(const obstacle of obstacles)Object.freeze(obstacle);Object.freeze(obstacles);
    // AUTO passage affects gates only. Non-gate geometry has no viewer policy.
    return Object.freeze({kind,typeId,xMm,zMm,rotation,active,wood,forestCellMm,open,auto:false,incomplete,pending,obstacles});
  }
  // Captured originals also reject prototype hooks. Only the server's explicitly
  // registered timing wrapper may surround refresh while this window is active.
  private static readonly movementObstacleReaders=Object.freeze({
    guard:Simulation.prototype.canonicalMovementObstacleReaders,
    all:Simulation.prototype.all,knownStatic:Simulation.prototype.knownStatic,indexStaticKnowledge:Simulation.prototype.indexStaticKnowledge,
    staticMembership:Simulation.prototype.staticMembership,
    knownObstacles:Simulation.prototype.knownObstacles,knownTerrainObstacles:Simulation.prototype.knownTerrainObstacles,
    entityObstacles:Simulation.prototype.entityObstacles,sharedMovementObstacle:Simulation.prototype.sharedMovementObstacle,
    refreshPlanningNav:Simulation.prototype.refreshPlanningNav,visible:Simulation.prototype.visible,cell:Simulation.prototype.cell,
    bounds:Simulation.prototype.bounds,visionGroup:Simulation.prototype.visionGroup,hostile:Simulation.prototype.hostile,
    avoidance:Simulation.prototype.avoidance,beginTick:LocalAvoidance.prototype.beginTick,
    invalidate:PathScheduler.prototype.invalidate,invalidateRemote:RemotePathScheduler.prototype.invalidate,
    synchronize:PerceptionMembership.prototype.synchronize,commit:PerceptionMembership.prototype.commit,statics:PerceptionMembership.prototype.statics,
    sameKnownObstacleRecord:Simulation.prototype.sameKnownObstacleRecord,
    beginMovementObstacleDependencies:Simulation.prototype.beginMovementObstacleDependencies,
    preparedMovementObstacle:Simulation.prototype.preparedMovementObstacle,
    reuseMovementObstacles:Simulation.prototype.reuseMovementObstacles,certifyMovementObstacles:Simulation.prototype.certifyMovementObstacles,
    releaseMovementObstacleCertificate:Simulation.prototype.releaseMovementObstacleCertificate,
    releaseMovementSourceSubscription:Simulation.prototype.releaseMovementSourceSubscription,
    beginMovementCertificateDraft:Simulation.prototype.beginMovementCertificateDraft,captureMovementCertificateRow:Simulation.prototype.captureMovementCertificateRow,commitMovementCertificateDraft:Simulation.prototype.commitMovementCertificateDraft,
    retainMovementSource:Simulation.prototype.retainMovementSource,removeMovementSource:Simulation.prototype.removeMovementSource,
  });
  /** Explicit ownership seam for the host's read-only refresh timing wrapper.
   * A wrapper over a custom reader, or a later replacement, cannot qualify. */
  registerPlanningRefreshDiagnostic(original:unknown,wrapper:unknown):(()=>void)|undefined {
    if(original!==Simulation.movementObstacleReaders.refreshPlanningNav||typeof wrapper!=='function'||this.refreshPlanningNav!==wrapper)return;
    this.planningRefreshDiagnostic=wrapper;
    return ()=>{if(this.planningRefreshDiagnostic===wrapper)this.planningRefreshDiagnostic=undefined;};
  }
  private canonicalMovementObstacleReaders():boolean {
    const original=Simulation.movementObstacleReaders;
    return this.all===original.all&&this.knownStatic===original.knownStatic&&this.indexStaticKnowledge===original.indexStaticKnowledge&&this.staticMembership===original.staticMembership
      &&this.knownObstacles===original.knownObstacles&&this.knownTerrainObstacles===original.knownTerrainObstacles
      &&this.entityObstacles===original.entityObstacles&&this.sharedMovementObstacle===original.sharedMovementObstacle
      &&(this.refreshPlanningNav===original.refreshPlanningNav||this.refreshPlanningNav===this.planningRefreshDiagnostic)
      &&this.visible===original.visible&&this.cell===original.cell&&this.bounds===original.bounds&&this.visionGroup===original.visionGroup&&this.hostile===original.hostile
      &&this.avoidance===original.avoidance&&LocalAvoidance.prototype.beginTick===original.beginTick&&[...this.localAvoidance.values()].every(value=>value.beginTick===original.beginTick)
      &&(this.pathScheduler.invalidate===original.invalidate||this.pathScheduler.invalidate===original.invalidateRemote)
      &&this.perceptionMembership.synchronize===original.synchronize&&this.perceptionMembership.commit===original.commit&&this.perceptionMembership.statics===original.statics
      &&this.sameKnownObstacleRecord===original.sameKnownObstacleRecord&&this.beginMovementObstacleDependencies===original.beginMovementObstacleDependencies&&this.preparedMovementObstacle===original.preparedMovementObstacle
      &&this.reuseMovementObstacles===original.reuseMovementObstacles&&this.certifyMovementObstacles===original.certifyMovementObstacles
      &&this.releaseMovementObstacleCertificate===original.releaseMovementObstacleCertificate&&this.releaseMovementSourceSubscription===original.releaseMovementSourceSubscription
      &&this.beginMovementCertificateDraft===original.beginMovementCertificateDraft&&this.captureMovementCertificateRow===original.captureMovementCertificateRow&&this.commitMovementCertificateDraft===original.commitMovementCertificateDraft
      &&this.retainMovementSource===original.retainMovementSource&&this.removeMovementSource===original.removeMovementSource;
  }
  private releaseMovementObstacleCertificate(playerId:string,retained?:ReadonlySet<MovementObstacleSource>):void {
    const prior=this.movementObstacleCertificates.get(playerId);if(!prior)return;
    for(const source of prior.common){
      if(retained?.has(source))continue;
      this.releaseMovementSourceSubscription(playerId,source);
    }
    this.movementObstacleCertificates.delete(playerId);
  }
  private releaseMovementSourceSubscription(playerId:string,source:MovementObstacleSource):void {
    source.subscribers.delete(playerId);
    if(!source.subscribers.size&&this.movementObstacleSources.get(source.entity)===source){
      // A later profile can acquire the same prepared source this phase. Keep
      // its geometry/slot even after its last previous subscriber releases it.
      const active=this.movementDependencyPreparation;
      if(active?.complete&&source.valid&&(source.preparedFor===active.token||this.liveOwned&&source.entity.kind==='resource'))this.movementObstaclePreparation!.set(source.entity,source.geometry);
      this.removeMovementSource(source.entity);
    }
  }
  private retainMovementSource(source:MovementObstacleSource):void {
    this.removeMovementSource(source.entity);this.movementObstacleSources.set(source.entity,source);
    (source.entity.kind==='resource'?this.liveMovementResources:this.liveMovementActors).add(source);
  }
  private removeMovementSource(entity:Entity):void {
    const source=this.movementObstacleSources.get(entity);if(source){this.liveMovementResources.delete(source);this.liveMovementActors.delete(source);this.movementObstacleSources.delete(entity);}
  }
  private clearMovementSources():void {this.movementObstacleSources.clear();this.liveMovementResources.clear();this.liveMovementActors.clear();this.liveDepletedResources.clear();}
  private beginMovementObstacleDependencies():void {
    const factions=new Set(this.state.factions.map(faction=>faction.id));
    for(const playerId of this.movementObstacleCertificates.keys())if(!factions.has(playerId))this.releaseMovementObstacleCertificate(playerId);
    const active:MovementDependencyPreparation={widthMm:this.state.widthMm,heightMm:this.state.heightMm,token:Symbol(),complete:false,preparedCount:0,created:new Set()};
    this.movementDependencyPreparation=active;
    if(this.liveOwned){
      // Resource geometry is immutable under the live owner. Only the gather
      // transition to zero can remove it; reconcile those exact dirty sources.
      active.preparedCount=this.liveMovementResources.size;
      for(const entity of this.liveDepletedResources){const source=this.movementObstacleSources.get(entity);if(!source)continue;const geometry=this.sharedMovementObstacle(entity,source.geometry);if(geometry!==source.geometry){source.geometry=geometry;for(const playerId of source.subscribers){const profile=this.movementObstacleCertificates.get(playerId);if(profile)profile.dirty=true;}}}
      this.liveDepletedResources.clear();
    }
    // Reconcile the subscribed union, not every hidden world object. Newly
    // authorized sources join lazily through the existing geometry preparation.
    for(const source of this.liveOwned?this.liveMovementActors:this.movementObstacleSources.values()){
      const entity=source.entity,valid=entity.id===source.id&&this.state.entities[source.id]===entity&&entity.kind!=='unit'&&!(entity.kind==='building'&&isGate(entity));
      const geometry=valid?(this.liveOwned&&entity.kind==='resource'&&source.geometry.active===(entity.amount>0)?source.geometry:this.sharedMovementObstacle(entity,source.geometry)):source.geometry;
      if(!valid||!source.valid||geometry!==source.geometry)for(const playerId of source.subscribers){const profile=this.movementObstacleCertificates.get(playerId);if(profile)profile.dirty=true;}
      source.valid=valid;source.geometry=geometry;
      source.preparedFor=valid?active.token:undefined;
      if(valid)active.preparedCount++;
    }
    active.complete=true;
  }
  private preparedMovementObstacle(entity:Entity):SharedObstacleRecord|undefined {
    const active=this.movementDependencyPreparation;if(!active?.complete)return;
    const source=this.movementObstacleSources.get(entity);
    if(source?.valid&&(source.preparedFor===active.token||this.liveOwned&&entity.kind==='resource'))return source.geometry;
    return this.movementObstaclePreparation?.get(entity);
  }
  private sameKnownObstacleRecord(entity:Entity,playerId:string,record:KnownObstacleRecord):boolean {
    const building=entity.kind==='building'?entity:undefined;
    const auto=Boolean(building&&!this.state.economies[building.ownerId]!.defeated&&!this.hostile(playerId,building.ownerId)&&(building.gateMode??buildings[building.typeId].defaultGateMode)==='AUTO');
    return record.kind===entity.kind&&record.typeId===entity.typeId&&record.xMm===entity.xMm&&record.zMm===entity.zMm&&record.rotation===building?.rotation
      &&record.active===(entity.kind==='resource'&&entity.amount>0)&&record.wood===(entity.kind==='resource'&&entity.resource==='wood')
      &&record.forestCellMm===(entity.kind==='resource'?entity.forest?.cellMm??0:0)&&record.open===Boolean(building?.gateOpen)
      &&record.incomplete===(building?building.work<building.required:false)&&record.auto===auto&&record.pending===Boolean(building?.pendingConstruction);
  }
  private reuseMovementObstacles(playerId:string,known:Entity[],terrain:Obstacle[]):Obstacle[]|undefined {
    const active=this.movementDependencyPreparation,profile=this.movementObstacleCertificates.get(playerId),cache=this.knownObstacleRecords.get(playerId);
    if(!active?.complete||!profile||!cache||profile.dirty||!this.movementFrame?.staticIndexed||active.widthMm!==this.state.widthMm||active.heightMm!==this.state.heightMm
      ||profile.widthMm!==active.widthMm||profile.heightMm!==active.heightMm||profile.known!==known||profile.terrain!==terrain||profile.obstacles!==cache.obstacles||profile.recordCount!==cache.records.size
      ||this.knownStaticRecords.get(playerId)?.members!==profile.members)return;
    // Memory references/order were checked by knownStatic. Native resource
    // memories cannot change geometry while hidden; revelation replaces this
    // exact known roster and rebuilds its certificate. Public mutable fixtures,
    // building memories and every gate's recipient policy retain scalar reads.
    for(const local of this.liveOwned?profile.localChecks??profile.local:profile.local)if(local.entity.id!==local.id||cache.records.get(local.id)!==local.record||!(this.liveOwned&&local.entity.kind==='resource'&&this.state.entities[local.id]!==local.entity)&&!this.sameKnownObstacleRecord(local.entity,playerId,local.record))return;
    return profile.obstacles;
  }
  /** The native scan already visits each current authorized occurrence. Stage
   * its certificate there, retaining only a bounded set of changed ID bindings.
   * Generic mutable readers keep the independent complete certification below. */
  private beginMovementCertificateDraft(playerId:string,known:Entity[],terrain:Obstacle[]):MovementCertificateDraft|undefined {
    if(!this.liveOwned)return;
    const active=this.movementDependencyPreparation,prior=this.movementObstacleCertificates.get(playerId),cache=this.knownObstacleRecords.get(playerId),knowledge=this.knownStaticRecords.get(playerId);
    if(!active?.complete||!prior?.rows||!cache||!this.movementFrame?.staticIndexed||!knowledge||knowledge.combined!==known
      ||known.length>KNOWN_OBSTACLE_RECORD_LIMIT||terrain.length>KNOWN_OBSTACLE_RECORD_LIMIT||prior.terrain!==terrain||prior.obstacles!==cache.obstacles
      ||prior.recordCount!==cache.records.size||prior.rows.size!==prior.recordCount||prior.widthMm!==active.widthMm||prior.heightMm!==active.heightMm
      ||active.widthMm!==this.state.widthMm||active.heightMm!==this.state.heightMm)return;
    return {playerId,prior,active,known,members:knowledge.members,terrain,common:[],local:[],changes:new Map(),created:new Map(),count:0};
  }
  private captureMovementCertificateRow(draft:MovementCertificateDraft,entity:Entity,record:KnownObstacleRecord,index:number,shared?:SharedObstacleRecord):boolean {
    if(this.knownObstacleRecords.get(draft.playerId)?.records.get(entity.id)!==record)return false;
    let source:MovementObstacleSource|undefined,geometry:SharedObstacleRecord|undefined;
    if(index<draft.members.length&&draft.members[index]===entity&&this.state.entities[entity.id]===entity&&entity.kind!=='unit'&&!(entity.kind==='building'&&isGate(entity))){
      geometry=shared;if(!geometry||record.shared!==geometry)return false;
      source=this.movementObstacleSources.get(entity);
      if(!source||!source.valid||source.id!==entity.id||!(source.preparedFor===draft.active.token||entity.kind==='resource')||source.geometry!==geometry){
        if(!source&&this.movementObstacleSources.size+draft.created.size>=KNOWN_OBSTACLE_RECORD_LIMIT)return false;
        source={entity,id:entity.id,geometry,subscribers:new Set(),valid:true,preparedFor:draft.active.token};draft.created.set(entity,source);
      }
      draft.common.push(source);
    }else draft.local.push({entity,id:entity.id,record});
    const previous=draft.prior.rows!.get(entity.id);
    // Sources themselves reconcile in place. Compare the separately captured
    // geometry, not just the source identity, before retaining a row binding.
    if(!previous||previous.entity!==entity||previous.record!==record||previous.source!==source||previous.geometry!==geometry){
      draft.changes.set(entity.id,{entity,record,source,geometry});if(draft.changes.size>256)return false;
    }
    draft.count++;return true;
  }
  private commitMovementCertificateDraft(draft:MovementCertificateDraft,obstacles:Obstacle[]):boolean {
    const {playerId,prior,active,known,members,terrain}=draft,cache=this.knownObstacleRecords.get(playerId),knowledge=this.knownStaticRecords.get(playerId),rows=prior.rows!;
    if(!this.liveOwned||this.movementDependencyPreparation!==active||!active.complete||this.movementObstacleCertificates.get(playerId)!==prior
      ||!this.movementFrame?.staticIndexed||knowledge?.combined!==known||knowledge.members!==members||cache?.obstacles!==obstacles||cache.records.size!==known.length||draft.count!==known.length
      ||active.widthMm!==this.state.widthMm||active.heightMm!==this.state.heightMm||draft.changes.size>256)return false;
    // Concealment/revelation replaces a live source with its detached memory
    // and can reorder thousands of otherwise identical obstacles. The bounded
    // row transition already proves exactly which sources changed: compare
    // their shapes before mutating rows, rather than rebuilding/diffing the
    // complete navigation Map again. Occurrences within a gate retain order.
    let geometry=prior.geometry;
    if(geometry)for(const [id,next]of draft.changes){
      const before=rows.get(id)?.record.obstacles??[],after=next?.record.obstacles??[];
      if(before.length!==after.length||before.some((old,index)=>{const current=after[index]!;return old.id!==current.id||old.xMm!==current.xMm||old.zMm!==current.zMm||old.halfWidth!==current.halfWidth||old.halfHeight!==current.halfHeight;})){geometry=undefined;break;}
    }
    // No subscription changes occur until every authorized occurrence has been
    // reconciled. A live-to-memory transition releases its live dependency even
    // if the old observed obstacle geometry is still byte-for-byte identical.
    for(const [id,next]of draft.changes){const previous=rows.get(id);if(previous?.source&&previous.source!==next?.source)this.releaseMovementSourceSubscription(playerId,previous.source);}
    for(const [id,next]of draft.changes){
      const previous=rows.get(id);
      if(next){
        if(next.source&&next.source!==previous?.source){next.source.subscribers.add(playerId);if(this.movementObstacleSources.get(next.entity)!==next.source)this.retainMovementSource(next.source);}
        rows.set(id,next);
      }else rows.delete(id);
    }
    for(const entity of draft.created.keys())active.created.add(entity);
    this.movementObstacleCertificates.set(playerId,{known,members,terrain,obstacles,recordCount:cache.records.size,dirty:false,widthMm:active.widthMm,heightMm:active.heightMm,common:draft.common,local:draft.local,localChecks:draft.local.filter(row=>row.entity.kind!=='resource'||this.state.entities[row.id]===row.entity),rows,geometry:geometry??{}});
    return true;
  }
  private certifyMovementObstacles(playerId:string,known:Entity[],terrain:Obstacle[],obstacles:Obstacle[],draft?:MovementCertificateDraft):void {
    if(draft&&this.commitMovementCertificateDraft(draft,obstacles))return;
    const active=this.movementDependencyPreparation,cache=this.knownObstacleRecords.get(playerId),knowledge=this.knownStaticRecords.get(playerId);
    if(!active?.complete)return;
    const members=knowledge?.members;
    if(!this.movementFrame?.staticIndexed||!knowledge||!members||!cache||knowledge.combined!==known||cache.obstacles!==obstacles
      ||known.length>KNOWN_OBSTACLE_RECORD_LIMIT||terrain.length>KNOWN_OBSTACLE_RECORD_LIMIT
      ||active.widthMm!==this.state.widthMm||active.heightMm!==this.state.heightMm){this.releaseMovementObstacleCertificate(playerId);return;}
    const common:MovementObstacleSource[]=[],local:MovementObstacleCertificate['local']=[],ids=new Set<string>(),rows=this.liveOwned?new Map<string,MovementCertificateRow>():undefined;
    for(let index=0;index<known.length;index++){
      const entity=known[index]!;
      // Duplicate occurrences retain the complete old reconstruction and charges.
      if(ids.has(entity.id)){this.releaseMovementObstacleCertificate(playerId);return;}ids.add(entity.id);
      const record=cache.records.get(entity.id);if(!record){this.releaseMovementObstacleCertificate(playerId);return;}
      if(index<members.length&&members[index]===entity&&this.state.entities[entity.id]===entity&&entity.kind!=='unit'&&!(entity.kind==='building'&&isGate(entity))){
        const geometry=this.preparedMovementObstacle(entity);
        if(!geometry||record.shared!==geometry){this.releaseMovementObstacleCertificate(playerId);return;}
        let source=this.movementObstacleSources.get(entity);
        if(!source||!source.valid||source.id!==entity.id||!(source.preparedFor===active.token||this.liveOwned&&entity.kind==='resource')||source.geometry!==geometry){
          if(!source&&this.movementObstacleSources.size>=KNOWN_OBSTACLE_RECORD_LIMIT){this.releaseMovementObstacleCertificate(playerId);return;}
          source={entity,id:entity.id,geometry,subscribers:new Set(),valid:true,preparedFor:active.token};this.retainMovementSource(source);active.created.add(entity);
        }
        common.push(source);
        rows?.set(entity.id,{entity,record,source,geometry});
      }else{local.push({entity,id:entity.id,record});rows?.set(entity.id,{entity,record});}
    }
    // A changed authorized roster need not tear down the unchanged portion of
    // its private dependency owner. Release only subscriptions absent from the
    // fully reconciled replacement, preserving the last-subscriber semantics.
    this.releaseMovementObstacleCertificate(playerId,this.movementObstacleCertificates.has(playerId)?new Set(common):undefined);
    const profile:MovementObstacleCertificate={known,members,terrain,obstacles,recordCount:cache.records.size,dirty:false,widthMm:active.widthMm,heightMm:active.heightMm,common,local,...(rows?{rows,geometry:{},localChecks:local.filter(row=>row.entity.kind!=='resource'||this.state.entities[row.id]===row.entity)}:{})};
    for(const source of common){if(!source.subscribers.has(playerId))source.subscribers.add(playerId);if(this.movementObstacleSources.get(source.entity)!==source)this.retainMovementSource(source);}
    this.movementObstacleCertificates.set(playerId,profile);
  }
  private knownObstacles(playerId:string):Obstacle[]{
    // Admission/work readers still reconcile every current dependency. An exact
    // unchanged result may keep subscriptions for the next movement phase; it
    // does not authorize reusing geometry inside this mutable read itself.
    const outsidePreparation=!this.movementDependencyPreparation;
    let certificate:MovementObstacleCertificate|undefined,completed=false;
    try{
    if(outsidePreparation){
      if(Simulation.movementObstacleReaders.guard.call(this))certificate=this.movementObstacleCertificates.get(playerId);
      else this.releaseMovementObstacleCertificate(playerId);
    }
    // Enumerate current authorized records even when the tick/revision is unchanged.
    const known=this.knownStatic(playerId),terrain=this.knownTerrainObstacles();
    let cache=this.knownObstacleRecords.get(playerId);
    if(!cache){cache={seen:false,records:new Map()};this.knownObstacleRecords.set(playerId,cache);}
    const reused=this.reuseMovementObstacles(playerId,known,terrain);if(reused)return reused;
    let draft=this.beginMovementCertificateDraft(playerId,known,terrain),entityIndex=0;
    const previous=cache.obstacles;let result:Obstacle[]|undefined,cursor=0;
    // Copy only at the first changed ordered obstacle. Record checks below still
    // run for every current source, including direct edits and hidden memories.
    const append=(obstacles:readonly Obstacle[])=>{for(const obstacle of obstacles){if(!result&&previous?.[cursor]!==obstacle)result=previous?.slice(0,cursor)??[];result?.push(obstacle);cursor++;}};
    append(terrain);
    cache.seen=!cache.seen;
    for(const entity of known){
      const index=entityIndex++;
      const prior=cache.records.get(entity.id);
      // Duplicate source IDs retain distinct obstacle identities and work charges.
      if(prior?.seen===cache.seen){draft=undefined;const duplicates=this.entityObstacles(entity,playerId);for(const obstacle of duplicates)Object.freeze(obstacle);append(duplicates);continue;}
      const preparation=this.movementObstaclePreparation,preparationState=this.movementDependencyPreparation;
      if(preparation&&preparationState?.complete&&(prior||cache.records.size<KNOWN_OBSTACLE_RECORD_LIMIT)&&entity.kind!=='unit'&&!(entity.kind==='building'&&isGate(entity))&&this.state.entities[entity.id]===entity){
        let shared=this.preparedMovementObstacle(entity);
        // Retained valid sources already occupy logical slots, even though the
        // sparse map contains no entries for them. Never loosen the old bound.
        if(!shared&&preparationState.preparedCount<KNOWN_OBSTACLE_RECORD_LIMIT){shared=this.sharedMovementObstacle(entity,prior?.shared);preparation.set(entity,shared);preparationState.preparedCount++;}
        if(shared){
          let record=prior;
          if(!record||record.shared!==shared){record={...shared,seen:cache.seen,shared};if(prior||cache.records.size<KNOWN_OBSTACLE_RECORD_LIMIT)cache.records.set(entity.id,record);}
          record.seen=cache.seen;append(shared.obstacles);if(draft&&!this.captureMovementCertificateRow(draft,entity,record,index,shared))draft=undefined;continue;
        }
      }
      const building=entity.kind==='building'?entity:undefined;
      const rotation=building?.rotation,active=entity.kind==='resource'&&entity.amount>0,wood=entity.kind==='resource'&&entity.resource==='wood';
      const forestCellMm=entity.kind==='resource'?entity.forest?.cellMm??0:0;
      const open=Boolean(building?.gateOpen),incomplete=building?building.work<building.required:false,pending=Boolean(building?.pendingConstruction);
      // Missing private fields in remembered records retain their existing semantics.
      const auto=Boolean(building&&!this.state.economies[building.ownerId]!.defeated&&!this.hostile(playerId,building.ownerId)&&(building.gateMode??buildings[building.typeId].defaultGateMode)==='AUTO');
      let record=prior;
      if(!record||record.kind!==entity.kind||record.typeId!==entity.typeId||record.xMm!==entity.xMm||record.zMm!==entity.zMm||record.rotation!==rotation||record.active!==active||record.wood!==wood||record.forestCellMm!==forestCellMm||record.open!==open||record.auto!==auto||record.incomplete!==incomplete||record.pending!==pending){
        const obstacles=this.entityObstacles(entity,playerId);
        for(const obstacle of obstacles)Object.freeze(obstacle);Object.freeze(obstacles);
        record={kind:entity.kind,typeId:entity.typeId,xMm:entity.xMm,zMm:entity.zMm,rotation,active,wood,forestCellMm,open,auto,incomplete,pending,seen:cache.seen,obstacles};
        if(prior||cache.records.size<KNOWN_OBSTACLE_RECORD_LIMIT)cache.records.set(entity.id,record);
      }
      record.seen=cache.seen;append(record.obstacles);if(draft&&!this.captureMovementCertificateRow(draft,entity,record,index))draft=undefined;
    }
    for(const [id,record]of cache.records)if(record.seen!==cache.seen){if(draft){draft.changes.set(id,undefined);if(draft.changes.size>256)draft=undefined;}cache.records.delete(id);}
    if(!result&&previous&&cursor===previous.length){this.certifyMovementObstacles(playerId,known,terrain,previous,draft);completed=true;return previous;}
    result??=previous?.slice(0,cursor)??[];Object.freeze(result);
    cache.obstacles=known.length<=KNOWN_OBSTACLE_RECORD_LIMIT&&terrain.length<=KNOWN_OBSTACLE_RECORD_LIMIT?result:undefined;
    this.certifyMovementObstacles(playerId,known,terrain,result,draft);
    completed=true;return result;
    }finally{
      if(outsidePreparation){
        let retain=false;
        try{const cache=this.knownObstacleRecords.get(playerId);retain=Boolean(completed&&certificate&&cache?.obstacles===certificate.obstacles&&cache.records.size===certificate.recordCount&&Simulation.movementObstacleReaders.guard.call(this));}
        finally{if(!retain)this.releaseMovementObstacleCertificate(playerId);}
      }
    }
  }
  private planningNav(playerId:string):Navigation{return this.planningNavigations.get(playerId)?.navigation??this.refreshPlanningNav(playerId);}
  private admissionBudget(playerId:string):NavigationWorkBudget{
    const budgets=this.state.pathAdmission??={},budget=budgets[playerId]??={tick:this.state.tick,remaining:50000,used:0};
    if(budget.tick!==this.state.tick){budget.tick=this.state.tick;budget.remaining=50000;budget.used=0;}return budget;
  }
  private admissionNav(playerId:string):Navigation{
    const known=this.refreshPlanningNav(playerId),revision=this.planningNavigations.get(playerId)!.revision,budget=this.admissionBudget(playerId),cached=this.admissionNavigations.get(playerId);
    if(cached?.revision===revision)return cached.navigation;
    const navigation=withOwnedNavigationBudget(known,budget);this.admissionNavigations.set(playerId,{navigation,revision});return navigation;
  }
  private formationNavigation(playerId:string):Navigation{
    // Later commands in a certified D087 batch already own the exact navigation.
    if(this.nativeAdmissionPreparation?.playerId===playerId&&this.nativeAdmissionPreparation.navigation)return this.refreshPlanningNav(playerId);
    // Boundary commands can reuse the exact membership index, but never a prior
    // command's frame. Custom readers and commands inside a tick retain scalar
    // preparation; only the explicitly owned refresh diagnostic may wrap it.
    if(this.stepping||this.movementFrame||this.workFrame||this.formationKnowledge||!Simulation.movementObstacleReaders.guard.call(this))return this.refreshPlanningNav(playerId);
    const world=this.liveOwned?this.all():undefined;
    if(world&&this.perceptionWorld===world){
      // No positions or fog can change inside this synchronous boundary call.
      // The private owner's committed membership remains valid until its world
      // roster changes; order-only commands need no all-faction reconciliation.
      this.formationKnowledge={entities:world,knownStatic:new Map(),staticIndexed:true};
      try{return this.refreshPlanningNav(playerId);}finally{this.formationKnowledge=undefined;}
    }
    const factions=this.state.factions,ids=new Set(factions.map(faction=>faction.id));
    if(factions.length>R.factionLimit||ids.size!==factions.length||!ids.has(playerId))return this.refreshPlanningNav(playerId);
    const columns=Math.floor(this.state.widthMm/fogGrid),rows=Math.floor(this.state.heightMm/fogGrid),groups=new Map<string,Uint8Array>();
    if(!Number.isSafeInteger(columns)||!Number.isSafeInteger(rows)||columns<=0||rows<=0||columns*rows>2_000_000)return this.refreshPlanningNav(playerId);
    for(const faction of factions){
      const mask=this.visibilityMasks.get(faction.id),key=this.visionGroup(faction.id);
      if(!mask||mask.length!==columns*rows||groups.has(key)&&groups.get(key)!==mask)return this.refreshPlanningNav(playerId);
      groups.set(key,mask);
    }
    const frame:StaticKnowledgeFrame={entities:world??this.all(),knownStatic:new Map()};
    // A failed index may have reconciled only a prefix. Its extra actor reads
    // must not make static-only admission fail; retry the original scalar path.
    this.perceptionWorld=undefined;
    let actorsIndexed=false;
    try{actorsIndexed=this.indexStaticKnowledge(frame);}catch{return this.refreshPlanningNav(playerId);}
    // Duplicate sources or incoherent allied masks preserve the original
    // unframed scalar semantics, rather than selecting the packed fallback.
    if(!frame.staticIndexed)return this.refreshPlanningNav(playerId);
    if(this.liveOwned&&actorsIndexed)this.perceptionWorld=frame.entities;
    this.formationKnowledge=frame;
    try{return this.refreshPlanningNav(playerId);}finally{this.formationKnowledge=undefined;}
  }
  private refreshPlanningNav(playerId:string):Navigation{
    const admission=this.nativeAdmissionPreparation?.playerId===playerId?this.nativeAdmissionPreparation:undefined;
    if(admission?.navigation)return admission.navigation;
    const cached=this.movementFrame?.planning.get(playerId);if(cached)return cached;
    const known=this.knownObstacles(playerId),prior=this.planningNavigations.get(playerId);
    // Only our privately owned immutable list can certify the identity shortcut.
    // Reference/fixture overrides still receive the complete scalar comparison.
    const verified=this.knownObstacleRecords.get(playerId)?.obstacles===known?known:undefined;
    const certificate=this.movementObstacleCertificates.get(playerId),geometry=this.liveOwned&&this.movementDependencyPreparation?.complete&&verified&&certificate?.obstacles===known?certificate.geometry:undefined;
    if(prior&&((geometry&&prior.verifiedGeometry===geometry)||(verified&&prior.verifiedObstacles===verified)||(known.length===prior.navigation.obstacles.length&&known.every((obstacle,index)=>{const old=prior.navigation.obstacles[index]!;return old.id===obstacle.id&&old.xMm===obstacle.xMm&&old.zMm===obstacle.zMm&&old.halfWidth===obstacle.halfWidth&&old.halfHeight===obstacle.halfHeight;})))){prior.verifiedObstacles=verified;prior.verifiedGeometry=geometry;this.movementFrame?.planning.set(playerId,prior.navigation);if(admission)admission.navigation=prior.navigation;return prior.navigation;}
    const counts=new Map<string,number>(),next=new Map<string,Obstacle>(known.map(o=>{const index=counts.get(o.id)??0;counts.set(o.id,index+1);return [`${o.id}:${index}`,o] as const;})),changed:Obstacle[]=[];
    if(prior){for(const [id,obstacle]of next){const previous=prior.obstacles.get(id);if(!previous||previous.xMm!==obstacle.xMm||previous.zMm!==obstacle.zMm||previous.halfWidth!==obstacle.halfWidth||previous.halfHeight!==obstacle.halfHeight){changed.push(obstacle);if(previous)changed.push(previous);}}for(const [id,obstacle]of prior.obstacles)if(!next.has(id))changed.push(obstacle);if(!changed.length){prior.verifiedObstacles=verified;prior.verifiedGeometry=geometry;this.movementFrame?.planning.set(playerId,prior.navigation);if(admission)admission.navigation=prior.navigation;return prior.navigation;}}
    const navigation=this.liveOwned&&verified?createOwnedNavigationRevision(prior?.navigation,this.state.widthMm,this.state.heightMm,known):createOwnedNavigation(this.state.widthMm,this.state.heightMm,known);this.planningNavigations.set(playerId,{navigation,obstacles:next,revision:(prior?.revision??0)+1,verifiedObstacles:verified,verifiedGeometry:geometry});
    if(prior&&changed.length)this.pathScheduler.invalidate(playerId,changed.map(o=>({xMm:o.xMm-o.halfWidth,zMm:o.zMm-o.halfHeight,widthMm:o.halfWidth*2,depthMm:o.halfHeight*2})));
    this.movementFrame?.planning.set(playerId,navigation);
    if(admission)admission.navigation=navigation;
    return navigation;
  }
  private physicalObstacles():Obstacle[]{
    if(!this.liveOwned){this.physicalObstacleRoster=undefined;this.physicalObstacleRecords.clear();return this.obstacles();}
    let roster=this.physicalObstacleRoster;
    if(!roster||roster.revision!==this.liveStaticRevision){
      const members=new Set<Building|ResourceNode>();
      for(const entity of this.all())if(entity.kind==='building'||entity.kind==='resource'&&entity.amount>0){
        // Detect aliases before the set discards their physical occurrence.
        // Ordinary owned rosters retain the cached unique-source path.
        if(members.has(entity)){this.physicalObstacleRoster=undefined;this.physicalObstacleRecords.clear();return this.obstacles();}
        members.add(entity);
      }
      this.physicalObstacleRoster=roster={revision:this.liveStaticRevision,members};
    }
    const result=[...this.knownTerrainObstacles()],next=new Map<Entity,SharedObstacleRecord>();
    for(const entity of roster.members){
      // Duplicate occurrences must retain the ordinary independently generated
      // shape identities. Unsupported sizes use the complete constructor too.
      if(next.has(entity)||next.size>=KNOWN_OBSTACLE_RECORD_LIMIT){this.physicalObstacleRecords.clear();return this.obstacles();}
      const record=this.sharedMovementObstacle(entity,this.physicalObstacleRecords.get(entity));
      next.set(entity,record);result.push(...record.obstacles);
      if(result.length>KNOWN_OBSTACLE_RECORD_LIMIT){this.physicalObstacleRecords.clear();return this.obstacles();}
    }
    if(result.length>KNOWN_OBSTACLE_RECORD_LIMIT){this.physicalObstacleRecords.clear();return this.obstacles();}
    // Prune removed sources atomically. Frozen unchanged shapes can then retain
    // their packed records and unaffected buckets through this physical revision.
    this.physicalObstacleRecords=next;return Object.freeze(result) as unknown as Obstacle[];
  }
  private nav():Navigation{if(!this.navigationCache||this.navigationVersion!==this.state.navigationRevision){this.navigationCache=this.liveOwned?createOwnedNavigationRevision(this.navigationCache,this.state.widthMm,this.state.heightMm,this.physicalObstacles()):createOwnedNavigation(this.state.widthMm,this.state.heightMm,this.obstacles());this.navigationVersion=this.state.navigationRevision;}return this.navigationCache;}
  private occupied(point:Position,radius:number,except?:string,viewerId?:string):boolean{
    const occupiedBy=(e:Entity)=>e.kind==='unit'&&e.hp>0&&!e.garrisonedIn&&e.id!==except&&(!viewerId||e.ownerId===viewerId||this.visible(viewerId,e))&&distance(e,point)<units[e.typeId].collisionRadiusM*1000+radius;
    if(this.movementFrame)return this.movementFrame.units.withNearby(point,radius,bodies=>bodies.some(body=>occupiedBy(this.state.entities[body.id]!)));
    if(this.liveOwned){
      // Production, work and garrison exits run outside movementFrame. Reuse the
      // canonical unit index after roster synchronization, including earlier
      // spawns/deaths in this tick. Before the first tick (or at a command
      // boundary), only the owned actor roster is certified, not the index.
      const roster=this.all(),frame=this.tickFrame;
      if(frame?.gateUnitsCanonical&&frame.entities===roster)return this.movementUnits.withNearby(point,radius,bodies=>bodies.some(body=>occupiedBy(this.state.entities[body.id]!)));
      return this.liveActors.some(occupiedBy);
    }
    return this.all().some(occupiedBy);
  }
  private boundaryDistance(point:Position,e:Entity):number{const b=this.bounds(e);return Math.hypot(Math.max(0,Math.abs(point.xMm-e.xMm)-b.halfWidth),Math.max(0,Math.abs(point.zMm-e.zMm)-b.halfHeight));}
  private workBounds(e:Entity):{halfWidth:number;halfHeight:number}{return e.kind==='resource'?resourceWorkBounds(e):this.bounds(e);}
  private combatDistance(a:Unit|Building,b:Unit|Building):number{
    if(a.kind==='unit'&&b.kind==='unit')return Math.max(0,distance(a,b)-(units[a.typeId].collisionRadiusM+units[b.typeId].collisionRadiusM)*1000);
    if(a.kind==='unit')return Math.max(0,this.boundaryDistance(a,b)-units[a.typeId].collisionRadiusM*1000);
    if(b.kind==='unit')return Math.max(0,this.boundaryDistance(b,a)-units[b.typeId].collisionRadiusM*1000);
    const ab=this.bounds(a),bb=this.bounds(b);return Math.hypot(Math.max(0,Math.abs(a.xMm-b.xMm)-ab.halfWidth-bb.halfWidth),Math.max(0,Math.abs(a.zMm-b.zMm)-ab.halfHeight-bb.halfHeight));
  }
  private effect(kind:'impact'|'hit'|'death',point:Position,typeId?:string,onlyOwner?:string,entityId?:string,projectileKind?:'arrow'|'stone'):void{
    const victim=kind!=='impact'&&'kind'in point&&point.kind!=='resource'?point as Unit|Building:undefined;
    if(victim?.kind==='unit'&&victim.garrisonedIn)onlyOwner=victim.ownerId;
    const recipients=this.state.factions.filter(f=>onlyOwner?f.id===onlyOwner:this.visible(f.id,point)).map(f=>f.id);if(!recipients.length)return;
    this.state.effects.push({id:this.id(),tick:this.state.tick,kind,xMm:point.xMm,zMm:point.zMm,...(projectileKind?{projectileKind}:{}),...(typeId?{typeId}:{}),...(entityId?{entityId}:{}),...(victim?{entityId:victim.id,typeId:victim.typeId,ownerId:victim.ownerId,visualAge:this.state.economies[victim.ownerId]!.age as import('@frontier/shared').AgeId,visualTier:victim.kind==='unit'?this.progression.visualTier(victim.ownerId,victim.typeId):'base' as const,...(victim.kind==='building'?{rotation:victim.rotation}:{})}:{}),recipients});
  }
  private cancelPath(unit:Unit):void{delete unit.windup;this.frameCombatTimeline?.notify(unit);this.activeWorkRoster?.wake(unit.id);unit.path=[];unit.repathAtTick=0;unit.orderRevision=(unit.orderRevision??0)+1;unit.lastProgressTick=this.state.tick;delete unit.pathDestination;delete unit.pathRegions;delete unit.pathRequestId;delete unit.pathBlockedRevision;delete unit.pathBlockedNeighbors;delete unit.approachGoal;delete unit.resourceSearch;this.pathScheduler.cancel(unit.id);this.reservations(unit.ownerId).release(unit.id);this.avoidance(unit.ownerId).release(unit.id);this.updateMovementUnit(unit);}
  private exitPosition(building:Building|Unit,unitType:string,unitId?:string):Position|undefined{
    const box=this.bounds(building),radius=units[unitType].collisionRadiusM*1000,points:Position[]=[];
    for(let x=-box.halfWidth;x<=box.halfWidth;x+=1000)points.push({xMm:building.xMm+x,zMm:building.zMm+box.halfHeight+radius+500},{xMm:building.xMm+x,zMm:building.zMm-box.halfHeight-radius-500});
    for(let z=-box.halfHeight;z<=box.halfHeight;z+=1000)points.push({xMm:building.xMm+box.halfWidth+radius+500,zMm:building.zMm+z},{xMm:building.xMm-box.halfWidth-radius-500,zMm:building.zMm+z});
    return points.find(point=>{const surface={xMm:Math.max(building.xMm-box.halfWidth,Math.min(building.xMm+box.halfWidth,point.xMm)),zMm:Math.max(building.zMm-box.halfHeight,Math.min(building.zMm+box.halfHeight,point.zMm))};return this.nav().free(point,radius)&&!this.occupied(point,radius,unitId)&&this.nav().clearLine(surface,point,radius,building.id);});
  }
  private static readonly combatPhaseReaders=Object.freeze({
    orderContext:Simulation.prototype.orderContext,combatOwnerFilter:Simulation.prototype.combatOwnerFilter,
    all:Simulation.prototype.all,hostile:Simulation.prototype.hostile,visible:Simulation.prototype.visible,cell:Simulation.prototype.cell,
    complete:Simulation.prototype.complete,bounds:Simulation.prototype.bounds,combatDistance:Simulation.prototype.combatDistance,boundaryDistance:Simulation.prototype.boundaryDistance,
    id:Simulation.prototype.id,effect:Simulation.prototype.effect,task:Simulation.prototype.task,cancelPath:Simulation.prototype.cancelPath,
    reservations:Simulation.prototype.reservations,avoidance:Simulation.prototype.avoidance,updateMovementUnit:Simulation.prototype.updateMovementUnit,
    nav:Simulation.prototype.nav,updateEngagements,advanceCombat,
  });
  private static readonly combatSpatialNearest=CombatSpatialIndex.prototype.nearest;
  private static readonly combatProgressionReaders=Object.freeze(Object.getOwnPropertyDescriptors(Progression.prototype));
  private readonly nativeCombatFilter=createNativeCombatOwnerFilterScope();
  /** Certify only live phase inputs, never the resource world or queued paths.
   * Both phases create their own index: movement/vision may intervene between them. */
  private combatOwnerFilter(phase:'engagement'|'combat',combatants:readonly Combatant[]):CombatOwnerFilter|undefined {
    // The native factory owns all actor records and canonical phase callbacks.
    // Its public membrane revokes this proof if a prototype is replaced. Do not
    // re-certify thousands of static records and every actor descriptor twice
    // per contact slice; ordinary mutable simulations retain the full audit.
    if(this.liveOwned)return this.nativeCombatFilter(this.state.factions,phase,combatants);
    try{
      if(nodeTypes.isProxy(this)||Object.getPrototypeOf(this)!==Simulation.prototype)return;
      for(const field of ['state','planningDiagnosticNow','controllerProfiler','progression','pathScheduler','movementUnits','approachReservations','localAvoidance','visibilityMasks','committedActions','navigationCache','navigationVersion']){const property=Object.getOwnPropertyDescriptor(this,field);if(!property||!('value'in property))return;}
      if(this.planningDiagnosticNow||this.controllerProfiler||!admissionMethod(CombatSpatialIndex.prototype,'nearest',Simulation.combatSpatialNearest))return;
      for(const [name,method]of Object.entries(Simulation.combatPhaseReaders))if(!admissionMethod(this,name,method))return;
      const progression=this.progression;if(nodeTypes.isProxy(progression)||Object.getPrototypeOf(progression)!==Progression.prototype)return;
      for(const [name,descriptor]of Object.entries(Simulation.combatProgressionReaders))if(!admissionMethod(progression,name,descriptor.value))return;
      for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(progression)))if(!('value'in descriptor)||nodeTypes.isProxy(descriptor.value)||typeof descriptor.value==='function'||nodeTypes.isMap(descriptor.value)&&Reflect.ownKeys(descriptor.value).length)return;
      for(const map of [this.visibilityMasks,this.committedActions,this.approachReservations,this.localAvoidance])if(nodeTypes.isProxy(map)||Object.getPrototypeOf(map)!==Map.prototype||Reflect.ownKeys(map).length)return;
      for(const mask of this.visibilityMasks.values())if(nodeTypes.isProxy(mask)||!nodeTypes.isUint8Array(mask)||Object.getPrototypeOf(mask)!==Uint8Array.prototype||nodeTypes.isSharedArrayBuffer(admissionTypedBuffer.call(mask)))return;
      const state=this.state;
      if(!admissionFields(state,['tick','widthMm','heightMm','navigationRevision','secretIdKey','entityNonce'],true)||!admissionFields(state,['entities','factions','economies','effects','projectiles'])||!admissionRecord(state.entities)||!admissionRecord(state.economies))return;
      // Avoid proving the actor roster when a fresh nav build already requires
      // scalar callbacks for this phase.
      if(phase==='combat'&&(!this.navigationCache||this.navigationVersion!==state.navigationRevision||!admissionHelper(this.navigationCache)))return;
      const filter=createCombatOwnerFilter(state.factions);if(!filter)return;
      const factions=admissionEntries(state.factions);if(!factions)return;
      const ownerIds=new Set<string>();
      for(const faction of state.factions){
        ownerIds.add(faction.id);if(!admissionFields(state.economies,[faction.id]))return;
        const economy=state.economies[faction.id];if(!admissionFields(economy,['defeated','age','researchRevision'],true)||!admissionFields(economy,['technologies']))return;
        const technologies=admissionEntries(economy?.technologies);if(!technologies||technologies.some(value=>typeof value!=='string'))return;
      }
      // These are the only nested public actor records read after index creation.
      // Descriptors establish eligibility without executing an accessor.
      const point=(value:unknown)=>value===undefined||admissionFields(value,['xMm','zMm'],true);
      const ids=new Set<string>(),targets=new Set<string>();
      const actorFields=['id','kind','typeId','ownerId','xMm','zMm','rotation','hp','cooldown','garrisonedIn','work','required','deploymentState','stance','lastAttackerId','lastDamagedTick','orderRevision','repathAtTick','lastProgressTick','taskState','blockedReason'];
      for(const entity of combatants){
        if(!admissionFields(entity,actorFields,true)||!admissionFields(entity,['orders','engagement','path','windup','weaponCooldowns','ward'])||!ownerIds.has(entity.ownerId)||ids.has(entity.id)||!admissionFields(state.entities,[entity.id])||state.entities[entity.id]!==entity)return;
        if(!admissionTree(entity.weaponCooldowns)||entity.kind==='unit'&&!admissionTree(entity.windup)||entity.kind==='building'&&!admissionTree(entity.ward))return;
        ids.add(entity.id);
        if(entity.kind==='unit'){
          const orders=admissionEntries(entity.orders);if(!orders)return;
          const order=entity.orders[0];if(order!==undefined){if(!admissionFields(order,['kind','targetId'],true)||!admissionFields(order,['target'])||!point(order.target))return;if(order.targetId)targets.add(order.targetId);}
          const engagement=entity.engagement;if(engagement!==undefined){if(!admissionFields(engagement,['targetId'],true)||!admissionFields(engagement,['anchor','lastKnown'])||!point(engagement.anchor)||!point(engagement.lastKnown))return;targets.add(engagement.targetId);}
        }
      }
      // Explicit dead/garrisoned targets need not be members of the active index.
      for(const id of targets){if(!admissionFields(state.entities,[id]))return;const target=state.entities[id];if(target&&!ids.has(id)&&(!admissionFields(target,actorFields,true)||target.kind!=='resource'&&!ownerIds.has(target.ownerId)))return;}
      if(phase==='engagement'){
        const scheduler=this.pathScheduler;if(!admissionHelper(scheduler)||!admissionHelper(this.movementUnits))return;
        const shared=Object.getOwnPropertyDescriptor(scheduler,'sharedJobs');if(shared&&(!('value'in shared)||!admissionHelper(shared.value)))return;
        const census=Object.getOwnPropertyDescriptor(scheduler,'pathCensus');if(census&&(!('value'in census)||census.value!==undefined))return;
        if(!admissionPrototype(ApproachReservations.prototype)||!admissionPrototype(LocalAvoidance.prototype))return;
        for(const reservation of this.approachReservations.values())if(!admissionHelper(reservation))return;
        for(const avoidance of this.localAvoidance.values()){
          if(!admissionHelper(avoidance))return;
          const routes=Object.getOwnPropertyDescriptor(avoidance,'routes')!.value as Map<string,{yield?:unknown}>;
          for(const route of routes.values())if(!admissionFields(route,['yield'])||route.yield!==undefined&&!admissionFields(route.yield,['requesterId'],true))return;
        }
      }else{
        // A fresh physical navigation build can read arbitrary public resource
        // records. Keep that case scalar; an existing owned snapshot reads none.
        if(!admissionEntries(state.effects)||!admissionEntries(state.projectiles))return;
      }
      return filter;
    }catch{return undefined;}
  }
  private orderContext():OrderContext{const lookup=Simulation.factionLookupReaders.lookup.call(this),context:OrderContext={
    state:this.state,entities:()=>this.liveOwned?this.actors():this.all(),id:()=>this.id(),hostile:lookup.hostile,visible:(p,e)=>this.visible(p,e),complete:e=>this.complete(e),distance:(a,b)=>this.combatDistance(a,b),pointDistance:(point,target)=>this.boundaryDistance(point,target),
    ammunition:(unit,commit)=>{const cost=units[unit.typeId].ammunitionCost;if(!cost)return true;const bank=this.state.economies[unit.ownerId]!;if(resources.some(resource=>bank.resources[resource]<cost[resource]*scale)){this.task(unit,'blocked','OUT_OF_AMMUNITION');return false;}if(commit)this.spend(unit.ownerId,cost,1,'siege_ammunition',unit.id);return true;},
    definition:e=>e.kind==='unit'?this.progression.unit(e.ownerId,e.typeId):this.progression.building(e.ownerId,e.typeId),
    meleeClear:(a,b)=>{const bounds=this.bounds(b),surface={xMm:Math.max(b.xMm-bounds.halfWidth,Math.min(b.xMm+bounds.halfWidth,a.xMm)),zMm:Math.max(b.zMm-bounds.halfHeight,Math.min(b.zMm+bounds.halfHeight,a.zMm))};return this.nav().clearLine(a,surface,0,b.id);},
    effect:(kind,point,typeId,projectileKind)=>this.effect(kind,point,typeId,undefined,undefined,projectileKind),action:(entity,kind,durationTicks,aim)=>this.committedActions.set(entity.id,{kind,durationTicks,...committedFacing(entity,aim),recipients:this.state.factions.filter(f=>f.id===entity.ownerId||this.visible(f.id,entity)).map(f=>f.id)}),workReachable:(unit,target)=>this.workReachable(unit,target),exitPosition:(building,typeId,id)=>this.exitPosition(building,typeId,id),task:(unit,state,reason)=>this.task(unit,state,reason),cancelPath:unit=>this.cancelPath(unit)
  };
    const owner=this,callbacks=Object.entries(context).filter(([,value])=>typeof value==='function');
    context.ownerFilter=function(this:OrderContext,phase,combatants){
      if(this!==context)return undefined;
      for(const [name,callback]of callbacks)if(!admissionMethod(context,name,callback))return undefined;
      const state=Object.getOwnPropertyDescriptor(context,'state');if(!state||!('value'in state)||state.value!==owner.state)return undefined;
      const filter=Simulation.combatPhaseReaders.combatOwnerFilter.call(owner,phase,combatants);
      if(lookup.active)lookup.factions=filter?Simulation.factionLookupReaders.snapshot.call(owner):undefined;
      return filter;
    };
    Simulation.factionLookupContexts.set(context,lookup);
    return context;
  }
  /** Secondary resource faces fit usable gaps between clustered nodes. Existing
   * roomy faces retain priority; these still require ordinary route/collision proof. */
  private tighterResourceApproaches(unit:Unit,target:Entity):Position[]{
    if(target.kind!=='resource')return [];
    const bounds=this.workBounds(target),margin=units[unit.typeId].collisionRadiusM*1000+100,points:Position[]=[];
    for(let x=-bounds.halfWidth;x<=bounds.halfWidth;x+=1000)points.push({xMm:target.xMm+x,zMm:target.zMm-bounds.halfHeight-margin},{xMm:target.xMm+x,zMm:target.zMm+bounds.halfHeight+margin});
    for(let z=-bounds.halfHeight;z<=bounds.halfHeight;z+=1000)points.push({xMm:target.xMm-bounds.halfWidth-margin,zMm:target.zMm+z},{xMm:target.xMm+bounds.halfWidth+margin,zMm:target.zMm+z});
    return points.sort((a,b)=>distance(a,unit)-distance(b,unit));
  }
  private approach(unit:Unit,target:Entity,nav=this.admissionNav(unit.ownerId)):Position[]|null{
    const b=this.workBounds(target),radius=units[unit.typeId].collisionRadiusM*1000,points:Position[]=[],margin=radius+500;
    for(let x=-b.halfWidth;x<=b.halfWidth;x+=1000)points.push({xMm:target.xMm+x,zMm:target.zMm-b.halfHeight-margin},{xMm:target.xMm+x,zMm:target.zMm+b.halfHeight+margin});
    for(let z=-b.halfHeight;z<=b.halfHeight;z+=1000)points.push({xMm:target.xMm-b.halfWidth-margin,zMm:target.zMm+z},{xMm:target.xMm+b.halfWidth+margin,zMm:target.zMm+z});
    points.sort((a,b)=>distance(a,unit)-distance(b,unit));
    const available=(point:Position)=>!this.occupied(point,radius,unit.id,unit.ownerId),route=nav.pathToAny(unit,points.filter(available),radius);
    return route??(target.kind==='resource'?nav.pathToAny(unit,this.tighterResourceApproaches(unit,target).filter(available),radius):null);
  }
  private approachDestination(unit:Unit,target:Entity,requireRoute=false,replaceStalled=false):Position|undefined{
    const radius=units[unit.typeId].collisionRadiusM*1000,nav=this.planningNav(unit.ownerId);
    const key=target.kind==='unit'?`${target.id}_${Math.round(target.xMm/500)}_${Math.round(target.zMm/500)}`:target.id;
    const reservations=this.reservations(unit.ownerId),legal=(point:Position)=>{
      if(!nav.free(point,radius)||this.occupied(point,radius,unit.id,unit.ownerId)||!reservations.available(unit.id,point,radius))return false;
      if(this.pendingBuildOverlap(unit,point))return false;
      if(!requireRoute)return true;
      const bounds=this.workBounds(target),surface={xMm:Math.max(target.xMm-bounds.halfWidth,Math.min(target.xMm+bounds.halfWidth,point.xMm)),zMm:Math.max(target.zMm-bounds.halfHeight,Math.min(target.zMm+bounds.halfHeight,point.zMm))};
      // A free arrival slot must also permit work across its short final gap.
      // Use authorized geometry here; actual work still verifies physical LOS.
      return nav.clearLine(point,surface,0,target.id);
    };
    const revision=this.planningNavigations.get(unit.ownerId)!.revision,prior=unit.approachGoal;
    let points:Position[]|undefined;
    const candidates=()=>{
      if(points)return points;
      const bounds=this.workBounds(target),margin=radius+500;points=[];
      for(let x=-bounds.halfWidth;x<=bounds.halfWidth;x+=1000)points.push({xMm:target.xMm+x,zMm:target.zMm-bounds.halfHeight-margin},{xMm:target.xMm+x,zMm:target.zMm+bounds.halfHeight+margin});
      for(let z=-bounds.halfHeight;z<=bounds.halfHeight;z+=1000)points.push({xMm:target.xMm-bounds.halfWidth-margin,zMm:target.zMm+z},{xMm:target.xMm+bounds.halfWidth+margin,zMm:target.zMm+z});
      return points.sort((a,b)=>distance(a,unit)-distance(b,unit));
    };
    if(requireRoute&&prior?.key===key){
      // The scheduler owns resumable route proof and affected-region invalidation.
      // A distant new observation does not invalidate a still-legal arrival slot.
      if(prior.revision!==revision){
        prior.revision=revision;delete prior.failedPoints;delete prior.retryAtTick;
        const same=(point:Position)=>point.xMm===prior.point?.xMm&&point.zMm===prior.point.zMm;
        if(prior.point&&!candidates().some(same)&&!this.tighterResourceApproaches(unit,target).some(same))delete prior.point;
      }
      if(!replaceStalled&&prior.point&&legal(prior.point))return reservations.claim(unit.id,key,radius,[prior.point],legal);
      if(!prior.point&&this.state.tick<(prior.retryAtTick??0))return undefined;
    }
    // Most work journeys retain their reserved face while the incremental service
    // searches. Only completed failures exclude a face, never a pending search.
    if(!requireRoute)return reservations.claim(unit.id,key,radius,candidates(),legal)??(target.kind==='resource'?reservations.claim(unit.id,key,radius,this.tighterResourceApproaches(unit,target),legal):undefined);
    const failed=prior?.key===key&&prior.revision===revision&&prior.retryAtTick===undefined?[...(prior.failedPoints??[])]:[];
    if(replaceStalled&&prior?.point&&!failed.some(point=>point.xMm===prior.point!.xMm&&point.zMm===prior.point!.zMm))failed.push({...prior.point});
    const available=(point:Position)=>!failed.some(other=>other.xMm===point.xMm&&other.zMm===point.zMm)&&legal(point);
    if(replaceStalled&&!candidates().some(available)&&!this.tighterResourceApproaches(unit,target).some(available))return undefined;
    this.clearApproachPath(unit);
    reservations.release(unit.id);
    const point=reservations.claim(unit.id,key,radius,candidates(),available)??(target.kind==='resource'?reservations.claim(unit.id,key,radius,this.tighterResourceApproaches(unit,target),available):undefined);
    unit.approachGoal={key,revision,...(failed.length?{failedPoints:failed}:{}),...(point?{point:{...point}}:{retryAtTick:this.state.tick+R.simulationHz})};
    return point;
  }
  /** Discard one work leg without replacing the paid/authorized order. */
  private clearApproachPath(unit:Unit):void{
    this.activeWorkRoster?.wake(unit.id);unit.path=[];delete unit.pathDestination;delete unit.pathRegions;delete unit.pathRequestId;delete unit.pathBlockedRevision;delete unit.pathBlockedNeighbors;
    unit.repathAtTick=this.state.tick;unit.lastProgressTick=this.state.tick;this.pathScheduler.cancel(unit.id);this.avoidance(unit.ownerId).release(unit.id);
  }
  private attackDestination(unit:Unit,target:Unit|Building|Position):Position|undefined{
    const def=this.progression.unit(unit.ownerId,unit.typeId);if('kind'in target&&def.minRangeM===0&&def.rangeM<=2)return this.approachDestination(unit,target);
    const radius=def.collisionRadiusM*1000,bounds='kind'in target?this.bounds(target):{halfWidth:0,halfHeight:0},desired=Math.max(def.minRangeM*1000+500,def.rangeM*1000-500),range=desired+Math.max(bounds.halfWidth,bounds.halfHeight)+radius,nav=this.planningNav(unit.ownerId);
    const candidates=()=>{const points:Position[]=[];for(let i=0;i<32;i++){const angle=Math.PI*2*i/32,point={xMm:Math.round(target.xMm+Math.cos(angle)*range),zMm:Math.round(target.zMm+Math.sin(angle)*range)};const gap='kind'in target?this.combatDistance({...unit,...point},target):distance(point,target)-radius;if(gap>=def.minRangeM*1000&&gap<=def.rangeM*1000)points.push(point);}points.sort((a,b)=>distance(a,unit)-distance(b,unit));return points;};
    if(this.liveOwned&&this.coarseFrame)return this.reservations(unit.ownerId).claimLazy(unit.id,'id'in target?`${target.id}_${Math.round(target.xMm/500)}_${Math.round(target.zMm/500)}`:`ground_${target.xMm}_${target.zMm}`,radius,candidates,point=>nav.free(point,radius)&&!this.occupied(point,radius,unit.id,unit.ownerId));
    const points=candidates();return this.reservations(unit.ownerId).claim(unit.id,'id'in target?`${target.id}_${Math.round(target.xMm/500)}_${Math.round(target.zMm/500)}`:`ground_${target.xMm}_${target.zMm}`,radius,points,point=>nav.free(point,radius)&&!this.occupied(point,radius,unit.id,unit.ownerId));
  }
  private task(unit:Unit,state:TaskState,reason?:string):void{
    if(unit.taskState!==state||unit.blockedReason!==reason)this.activeWorkRoster?.wake(unit.id);
    if(reason&&reason!==unit.blockedReason){const notices=this.state.economies[unit.ownerId]!.notifications;if(!notices.some(n=>n.entityId===unit.id&&n.code===reason&&this.state.tick-n.tick<5*R.simulationHz)){notices.push({id:this.id(),tick:this.state.tick,code:reason,entityId:unit.id});if(notices.length>30)notices.shift();}}
    unit.taskState=state;if(reason)unit.blockedReason=reason;else delete unit.blockedReason;
  }
  private setOrder(unit:Unit,order:Order,queued:boolean,retainPendingPath=false):void{
    this.activeWorkRoster?.wake(unit.id);
    order.planningClass??=this.commandSource===undefined?'routine':'interactive';if(this.commandSource==='human')order.manualOrder=true;
    if(unit.typeId==='villager'){unit.autoGather=true;delete unit.autoGatherAtTick;}
    if(queued&&!unit.orders.length&&unit.resourceSearch)this.cancelPath(unit);
    const control=this.state.control[unit.ownerId]!;
    if(this.commandSource==='caretaker'){
      order.authority={kind:'caretaker',generation:control.generation};if(!queued&&!Object.hasOwn(control.suspendedOrders,unit.id))control.suspendedOrders[unit.id]=structuredClone(unit.orders.filter(prior=>!prior.authority));
    }else if(this.commandSource===undefined&&unit.orders[0]?.authority)order.authority={...unit.orders[0].authority};
    else if(this.commandSource==='human'&&!queued)delete control.suspendedOrders[unit.id];
    if(!queued){unit.orders=[];delete unit.engagement;if(!retainPendingPath)this.cancelPath(unit);this.task(unit,'moving');}unit.orders.push(order);
  }
  private affordability(playerId:string,cost:ResourceBank,quantity=1):boolean{const charge=scaledCost(cost,quantity),reserve=this.commandSource==='ai'?this.state.control[playerId]?.assistant?.preferences.reserve:undefined;if(reserve)for(const r of resources)if(charge[r]>0)charge[r]+=reserve[r]*scale;const missing=missingResources(this.state.economies[playerId]!,charge);if(resources.some(r=>missing[r]>0)){this.pendingMissing=missing;return false;}return true;}
  private spend(playerId:string,cost:ResourceBank,quantity=1,reason='purchase',entityId?:string):void{if(!debit(this.state.economies[playerId]!,scaledCost(cost,quantity),reason,this.state.tick,entityId))throw new Error('RESOURCE_TRANSACTION_INVARIANT');}
  private static readonly nativeAdmissionReaders=Object.freeze({
    guard:Simulation.prototype.canonicalNativeAdmissionReaders,data:Simulation.prototype.canonicalNativeAdmissionData,
    formationNavigation:Simulation.prototype.formationNavigation,
    command:Simulation.prototype.command,admitCommand:Simulation.prototype.admitCommand,apply:Simulation.prototype.apply,
    formationTargets,id:Simulation.prototype.id,setOrder:Simulation.prototype.setOrder,cancelPath:Simulation.prototype.cancelPath,
    task:Simulation.prototype.task,record:Simulation.prototype.record,updateMovementUnit:Simulation.prototype.updateMovementUnit,
    reservations:Simulation.prototype.reservations,avoidance:Simulation.prototype.avoidance,
    all:Simulation.prototype.all,knownStatic:Simulation.prototype.knownStatic,knownObstacles:Simulation.prototype.knownObstacles,
    knownTerrainObstacles:Simulation.prototype.knownTerrainObstacles,entityObstacles:Simulation.prototype.entityObstacles,
    refreshPlanningNav:Simulation.prototype.refreshPlanningNav,visible:Simulation.prototype.visible,cell:Simulation.prototype.cell,
    hostile:Simulation.prototype.hostile,releaseMovementObstacleCertificate:Simulation.prototype.releaseMovementObstacleCertificate,
    reuseMovementObstacles:Simulation.prototype.reuseMovementObstacles,certifyMovementObstacles:Simulation.prototype.certifyMovementObstacles,
  });
  private static readonly nativeAdmissionWriters=Object.freeze({
    cancel:PathScheduler.prototype.cancel,invalidate:PathScheduler.prototype.invalidate,
    cancelRemote:RemotePathScheduler.prototype.cancel,invalidateRemote:RemotePathScheduler.prototype.invalidate,
    reservationRelease:ApproachReservations.prototype.release,avoidanceRelease:LocalAvoidance.prototype.release,
    movementUpdate:UnitSpatialIndex.prototype.update,movementDelete:UnitSpatialIndex.prototype.delete,
    append:JournalBuffer.prototype.append,free:Navigation.prototype.free,
    ownedFree:Object.getPrototypeOf(createOwnedNavigation(0,0,[])).free as unknown,
  });
  private canonicalNativeAdmissionReaders():boolean {
    if(nodeTypes.isProxy(this)||Object.getPrototypeOf(this)!==Simulation.prototype)return false;
    for(const key of ['state','stepping','replayMode','phase','tickFrame','workFrame','movementFrame','movementDependencyPreparation','planningDiagnosticNow','pathScheduler','movementUnits','approachReservations','localAvoidance','journal','commandSource','visibilityMasks','planningNavigations','knownObstacleRecords','movementObstacleCertificates','movementObstacleSources']){
      const descriptor=Object.getOwnPropertyDescriptor(this,key);if(!descriptor||!('value'in descriptor))return false;
    }
    if(this.stepping||this.replayMode||this.phase!=='boundary'||this.tickFrame||this.workFrame||this.movementFrame||this.movementDependencyPreparation||this.planningDiagnosticNow||this.commandSource!==undefined)return false;
    for(const [key,method]of Object.entries(Simulation.nativeAdmissionReaders)){
      const name=key==='guard'?'canonicalNativeAdmissionReaders':key==='data'?'canonicalNativeAdmissionData':key;
      if(!admissionMethod(this,name,method))return false;
    }
    const original=Simulation.nativeAdmissionWriters,scheduler=this.pathScheduler;
    if(!admissionHelper(scheduler)||!admissionHelper(this.movementUnits)||!admissionHelper(this.journal)||!admissionPrototype(admissionOwnedNavigationPrototype))return false;
    const shared=Object.getOwnPropertyDescriptor(scheduler,'sharedJobs');if(shared&&(!('value'in shared)||!admissionHelper(shared.value)))return false;
    if(!(admissionMethod(scheduler,'cancel',original.cancel)&&admissionMethod(scheduler,'invalidate',original.invalidate))&&!(admissionMethod(scheduler,'cancel',original.cancelRemote)&&admissionMethod(scheduler,'invalidate',original.invalidateRemote)))return false;
    const census=Object.getOwnPropertyDescriptor(scheduler,'pathCensus');if(census&&(!('value'in census)||census.value!==undefined))return false;
    if(!admissionMethod(this.journal,'append',original.append)||!admissionMethod(this.movementUnits,'update',original.movementUpdate)||!admissionMethod(this.movementUnits,'delete',original.movementDelete)||!admissionMethod(Navigation.prototype,'free',original.free))return false;
    for(const map of [this.approachReservations,this.localAvoidance,this.visibilityMasks,this.planningNavigations,this.knownObstacleRecords,this.movementObstacleCertificates,this.movementObstacleSources])if(nodeTypes.isProxy(map)||Object.getPrototypeOf(map)!==Map.prototype||Reflect.ownKeys(map).length)return false;
    if(!admissionMethod(ApproachReservations.prototype,'release',original.reservationRelease)||!admissionMethod(LocalAvoidance.prototype,'release',original.avoidanceRelease))return false;
    for(const reservation of this.approachReservations.values())if(!admissionHelper(reservation)||!admissionMethod(reservation,'release',original.reservationRelease))return false;
    for(const avoidance of this.localAvoidance.values())if(!admissionHelper(avoidance)||!admissionMethod(avoidance,'release',original.avoidanceRelease))return false;
    return true;
  }
  /** One bounded plain-data proof per compatible run. It creates no membership
   * index and never reads an accessor merely to decide whether reuse is safe. */
  private canonicalNativeAdmissionData(playerId:string,items:readonly NativeCommandItem[]):boolean {
    const state=this.state;
    if(!admissionFields(state,['matchId','matchEpoch','tick','sequence','status','secretIdKey','entityNonce','eventOrdinal','widthMm','heightMm'],true)||
      !admissionFields(state,['entities','factions','economies','control','vision','map','receipts','commandLog']))return false;
    const entities=admissionEntries(state.entities),factions=admissionEntries(state.factions),economies=admissionEntries(state.economies),log=admissionEntries(state.commandLog);
    if(!entities||!factions||!economies||!log||!admissionRecord(state.control)||!admissionRecord(state.vision)||!admissionRecord(state.receipts))return false;
    for(const faction of factions)if(!admissionFields(faction,['id','teamId'],true))return false;
    for(const economy of economies)if(!admissionFields(economy,['defeated','lastClientSequence'],true))return false;
    if(!admissionFields(state.control,[playerId])||!admissionFields(state.vision,[playerId]))return false;
    const control=state.control[playerId],vision=state.vision[playerId];
    if(!admissionFields(control,['assistant'])||!admissionTree(control?.assistant))return false;
    if(!admissionFields(control,['suspendedOrders'])||!admissionEntries(control?.suspendedOrders)||!admissionFields(vision,['memory']))return false;
    const memories=admissionEntries(vision?.memory);if(!memories||!admissionFields(state.map,['terrain']))return false;
    const mask=this.visibilityMasks.get(playerId);
    if(mask!==undefined&&(nodeTypes.isProxy(mask)||!nodeTypes.isUint8Array(mask)||Object.getPrototypeOf(mask)!==Uint8Array.prototype||nodeTypes.isSharedArrayBuffer(admissionTypedBuffer.call(mask))))return false;
    const terrain=admissionEntries(state.map.terrain);if(!terrain)return false;
    for(const region of terrain)if(!admissionFields(region,['id','kind','xMm','zMm','widthMm','depthMm'],true))return false;
    const staticFields=['kind','id','ownerId','typeId','xMm','zMm','rotation','resource','amount','work','required','gateMode','gateOpen'];
    for(const roster of [entities,memories])for(const entity of roster){
      if(!admissionFields(entity,['kind'],true))return false;
      if((entity as Entity).kind==='unit'){if(roster===memories)return false;continue;}
      if(!admissionFields(entity,staticFields,true)||!admissionFields(entity,['forest']))return false;
      const forest=(entity as ResourceNode).forest;if(forest!==undefined&&(!admissionFields(forest,['cellMm'],true)))return false;
    }
    const selected=new Set<string>(),seen=new Set<object>();
    for(const item of items){
      const envelope=item.command as ClientCommandEnvelope;
      if(!validateClientCommand(envelope))return false;
      const command=envelope.command;if(command.kind!=='move'&&command.kind!=='attack_move')return false;
      const receiptKey=`${state.matchEpoch}:${playerId}:${envelope.clientCommandId}`;
      if(!admissionFields(state.receipts,[receiptKey])||!admissionTree(state.receipts[receiptKey],seen))return false;
      for(const id of command.unitIds)selected.add(id);
    }
    for(const id of selected){const entity=state.entities[id];if(entity!==undefined&&!admissionTree(entity,seen))return false;}
    // Release visits existing yield records. Check their readable fields without
    // walking unrelated path/frontier payloads or changing reservation ownership.
    for(const avoidance of this.localAvoidance.values()){
      const routes=Object.getOwnPropertyDescriptor(avoidance,'routes')!.value as Map<string,unknown>;
      for(const route of routes.values()){
        if(!admissionFields(route,['yield']))return false;const yielding=(route as {yield?:unknown}).yield;
        if(yielding!==undefined&&!admissionFields(yielding,['requesterId'],true))return false;
      }
    }
    const navigation=this.planningNavigations.get(playerId)?.navigation;
    return !navigation||admissionHelper(navigation)&&admissionMethod(navigation,'free',Simulation.nativeAdmissionWriters.ownedFree);
  }
  /** Fixed native messages only: expiry and replies retain their original loop
   * positions. No caller callback or yielding iterator can borrow the scope. */
  drainNativeCommands(batch:NativeCommandBatch):void {
    const owner=consumeNativeCommandBatch(batch),nested=this.nativeAdmissionActive;
    // The factory's facade checks canonical ownership before this call. The
    // claimed native batch owns detached data and invokes no caller callbacks
    // between commands, so that proof lasts through this synchronous drain.
    // Externally reachable simulations retain the original descriptor proofs.
    const owned=this.liveOwned&&!nested;
    this.nativeAdmissionActive=true;this.nativeAdmissionPreparation=undefined;
    let attemptedEnd=0;
    try{
      for(let index=0;index<owner.items.length;index++){
        const item=owner.items[index]!;
        if(item.requestExpiresAtMs!==undefined&&owner.expired(item.requestExpiresAtMs)){this.nativeAdmissionPreparation=undefined;owner.reply(item.id,undefined,'WORKER_TIMEOUT');continue;}
        try{
          const envelope=item.command as Partial<ClientCommandEnvelope>|null;
          const kind=envelope&&typeof envelope==='object'?envelope.command?.kind:undefined;
          const compatible=kind==='move'||kind==='attack_move';
          if(!compatible||this.nativeAdmissionPreparation?.playerId!==item.playerId)this.nativeAdmissionPreparation=undefined;
          if(!nested&&compatible&&!this.nativeAdmissionPreparation&&index>=attemptedEnd){
            try{
              let end=index,formations=0;
              while(end<owner.items.length){const next=owner.items[end]!,input=next.command as Partial<ClientCommandEnvelope>|null,command=input&&typeof input==='object'?input.command:undefined;if(next.playerId!==item.playerId||(command?.kind!=='move'&&command?.kind!=='attack_move'))break;if(Array.isArray(command.unitIds)&&command.unitIds.length>1)formations++;end++;}
              attemptedEnd=end;
              // Single-unit moves never prepare formations. Failed eligibility
              // is remembered for this run rather than rescanning each member.
              if(formations>=2&&(owned||Simulation.nativeAdmissionReaders.guard.call(this)&&Simulation.nativeAdmissionReaders.data.call(this,item.playerId,owner.items.slice(index,end))))this.nativeAdmissionPreparation={playerId:item.playerId};
            }catch{this.nativeAdmissionPreparation=undefined;}
          }
          owner.reply(item.id,this.command(item.playerId,item.command));
          if(this.nativeAdmissionPreparation&&!owned){try{if(!Simulation.nativeAdmissionReaders.guard.call(this))this.nativeAdmissionPreparation=undefined;}catch{this.nativeAdmissionPreparation=undefined;}}
        }catch{this.nativeAdmissionPreparation=undefined;owner.reply(item.id,undefined,'COMMAND_FAILED');}
      }
    }finally{this.nativeAdmissionPreparation=undefined;this.nativeAdmissionActive=nested;}
  }
  command(playerId:string,input:unknown,source:CommandSource='human'):CommandReceipt{
    if(this.controllerViewFrame&&(this.command!==Simulation.prototype.command||this.apply!==Simulation.prototype.apply||this.addBuilding!==Simulation.prototype.addBuilding))this.controllerViewFrame.verify=true;
    const previous=this.commandSource;this.commandSource=source;
    try{const receipt=this.admitCommand(playerId,input);this.record(validateClientCommand(input)?{kind:'command',playerId,envelope:input,receipt,source}:{kind:'invalid_command',playerId,receipt});return receipt;}finally{this.commandSource=previous;}
  }
  private admitCommand(playerId:string,input:unknown):CommandReceipt{
    const receipt=(status:'accepted'|'rejected',code:string,clientCommandId=''):CommandReceipt=>({status,code,clientCommandId,tick:this.state.tick,sequence:Object.hasOwn(this.state.economies,playerId)?(this.commandSource==='ai'&&this.state.control[playerId]?.assistant?this.state.control[playerId]!.assistant!.sequence:this.state.economies[playerId]!.lastClientSequence):0});
    if(!validateClientCommand(input))return receipt('rejected','INVALID_COMMAND');
    if(!Object.hasOwn(this.state.economies,playerId))return receipt('rejected','NOT_AUTHORIZED',input.clientCommandId);
    const eco=this.state.economies[playerId],assistant=this.commandSource==='ai'?this.state.control[playerId]?.assistant:undefined;
    if(input.matchId!==this.state.matchId||input.matchEpoch!==this.state.matchEpoch)return receipt('rejected','STALE_MATCH',input.clientCommandId);
    const key=`${this.state.matchEpoch}:${playerId}:${assistant?'ai:':''}${input.clientCommandId}`,digest=createHash('sha256').update(canonical(input)).digest('hex'),prior=this.state.receipts[key];
    if(prior)return digest===prior.digest?{...prior.receipt}:receipt('rejected','COMMAND_ID_REUSED',input.clientCommandId);
    if(this.state.status!=='RUNNING')return receipt('rejected',this.state.status==='FINISHED'?'MATCH_FINISHED':'MATCH_PAUSED',input.clientCommandId);
    if(eco.defeated)return receipt('rejected','FACTION_DEFEATED',input.clientCommandId);
    if(input.clientSequence<=(assistant?.sequence??eco.lastClientSequence))return receipt('rejected','STALE_SEQUENCE',input.clientCommandId);
    this.pendingMissing=undefined;
    const cancelled=this.commandSource==='human'&&input.command.kind==='cancel_foundation'?this.state.entities[input.command.foundationId]:undefined;
    let error:string|undefined;try{error=assistant?assistantCommandReason(this.state,playerId,input.command):undefined;if(!error)error=this.apply(playerId,input.command);}catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;error='PATH_BUSY';}if(assistant)assistant.sequence=input.clientSequence;else eco.lastClientSequence=input.clientSequence;
    if(!error){if(this.commandSource==='human'){protectManualCommand(this.state,playerId,input.command,cancelled);if((input.command.kind==='cancel_foundation'||input.command.kind==='cancel_job')&&this.state.control[playerId]?.assistant)this.resetCommander(playerId,'MANUAL_CANCELLATION');}this.state.sequence++;this.state.commandLog.push({playerId,envelope:structuredClone(input),sequence:this.state.sequence,tick:this.state.tick});if(this.state.commandLog.length>4096)this.state.commandLog.shift();}
    const result=receipt(error?'rejected':'accepted',error??'OK',input.clientCommandId);if(error==='INSUFFICIENT_RESOURCES'&&this.pendingMissing)result.missingResources=structuredClone(this.pendingMissing as ResourceBank);this.state.receipts[key]={digest,tick:this.state.tick,receipt:result};return {...result};
  }
  private buildingCapReason(playerId:string,typeId:BuildingId,upgradingIds:readonly string[]=[],quantity=1):boolean{
    const definition=buildings[typeId],owned=this.owned(playerId).filter((e):e is Building=>e.kind==='building'&&e.hp>0);
    if(definition.maxPerPlayer&&owned.filter(e=>!upgradingIds.includes(e.id)&&(e.typeId===typeId||e.upgrade?.targetTypeId===typeId)).length+quantity>definition.maxPerPlayer)return true;
    return Boolean(definition.familyCap&&owned.filter(e=>buildings[e.typeId].family===definition.family&&!upgradingIds.includes(e.id)).length+quantity>definition.familyCap);
  }
  private apply(playerId:string,command:GameplayCommand):string|undefined{
    const ids='unitIds'in command?command.unitIds:'builderIds'in command?command.builderIds:[];
    const selected=ids.map(id=>this.state.entities[id]);
    if(selected.some(e=>!e||e.kind!=='unit'||e.ownerId!==playerId))return 'INVALID_REFERENCE';
    const workers=selected as Unit[];
    if(!['ungarrison','stop','set_stance'].includes(command.kind)&&workers.some(unit=>unit.garrisonedIn))return 'GARRISONED';
    if('queued'in command&&command.queued&&workers.some(u=>u.orders.length>=R.orderQueueLimit))return 'ORDER_QUEUE_FULL';
    switch(command.kind){
      case 'upgrade_structure':{
        const selected=command.buildingIds.map(id=>this.state.entities[id]);
        if(selected.some(e=>!e||e.kind!=='building'||e.ownerId!==playerId||e.hp<=0))return 'INVALID_REFERENCE';
        const structures=selected as Building[],reason=contentPrerequisiteReason(this.state,playerId,command.targetTypeId);if(reason)return reason;
        const costs=structures.map(e=>structureUpgrade(e.typeId,command.targetTypeId));
        if(structures.some((e,i)=>!costs[i]||!this.complete(e)||e.upgrade||e.demolitionTick))return 'INVALID_UPGRADE';
        if(this.buildingCapReason(playerId,command.targetTypeId,command.buildingIds,structures.length))return 'BUILDING_LIMIT';
        const total=emptyBank();for(const cost of costs)for(const resource of resources)total[resource]+=cost!.cost[resource];
        if(!this.affordability(playerId,total))return 'INSUFFICIENT_RESOURCES';
        this.spend(playerId,total,1,'structure_upgrade');
        structures.forEach((e,i)=>{const proposal=costs[i]!;e.upgrade={id:this.id(),targetTypeId:command.targetTypeId,originalCost:structuredClone(proposal.cost),work:0,required:proposal.seconds*R.simulationHz*100,started:false};});
        // Admission pays atomically; ordinary reachable workers provide all progress.
        // Busy/manual assignments are never stolen to make an upgrade appear instant.
        const helpers=this.owned(playerId).filter((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'&&!e.garrisonedIn&&!e.orders.length&&!e.cargo.amount&&!this.state.control[playerId]?.assistant?.protectedEntityIds.includes(e.id));
        if(helpers[0])this.setOrder(helpers[0],{kind:'build',targetId:structures[0]!.id,wallTargets:structures.map(e=>e.id)},false);
        return;
      }
      case 'move':case 'attack_move':case 'attack_ground':{
        if(command.target.xMm>=this.state.widthMm||command.target.zMm>=this.state.heightMm)return 'OUT_OF_BOUNDS';
        if(command.kind==='attack_ground'){
          if(workers.some(unit=>!units[unit.typeId].areaDamageBands))return 'INVALID_TARGET';
          if(!this.state.vision[playerId]!.explored.includes(this.cell(command.target)))return 'TARGET_UNEXPLORED';
        }
        const slots=command.kind==='attack_ground'||workers.length===1?undefined:this.formationTargets(workers.map(unit=>({id:unit.id,xMm:unit.xMm,zMm:unit.zMm,radiusMm:units[unit.typeId].collisionRadiusM*1000})),command.target,this.formationNavigation(playerId));
        const formationId=slots?this.id():undefined;
        for(const unit of workers){const target={...(slots?.get(unit.id)??command.target)};this.setOrder(unit,{kind:command.kind,target,...(formationId?{formation:{id:formationId,center:{...command.target},anchor:{...target}}}:{})},command.queued);}return;
      }
      case 'patrol':{
        if(command.points.some(point=>point.xMm>=this.state.widthMm||point.zMm>=this.state.heightMm))return 'OUT_OF_BOUNDS';
        for(const unit of workers)this.setOrder(unit,{kind:'patrol',points:structuredClone(command.points),pointIndex:0,target:{...command.points[0]!}},command.queued);return;
      }
      case 'deploy':case 'pack':{
        if(workers.some(unit=>!units[unit.typeId].deploySeconds))return 'INVALID_TARGET';
        for(const unit of workers){unit.orders=[];delete unit.engagement;this.cancelPath(unit);beginTransition(unit,command.kind,true);}return;
      }
      case 'stop':case 'hold_position':for(const unit of workers){unit.orders=[];delete unit.engagement;delete unit.desiredDeployment;if(unit.typeId==='villager')unit.autoGather=false;this.cancelPath(unit);this.task(unit,'idle');if(command.kind==='hold_position')unit.stance='stand_ground';}return;
      case 'set_stance':for(const unit of workers)unit.stance=command.stance;return;
      case 'gather':case 'attack_target':{
        const target=this.state.entities[command.targetId];if(!target||!this.visible(playerId,target))return 'INVALID_REFERENCE';
        if(command.kind==='gather'){
          const farm=target.kind==='building'&&target.typeId==='farm'&&this.complete(target)&&!this.hostile(playerId,target.ownerId);
          if((target.kind!=='resource'&&!farm)||(target.kind==='resource'&&target.amount<=0)||workers.some(u=>u.typeId!=='villager'))return 'INVALID_TARGET';
          const resource=farm?'food':(target as ResourceNode).resource;
          for(const unit of workers)this.setOrder(unit,{kind:'gather',targetId:target.id,...(target.kind==='resource'&&target.forest?{forestIntentId:target.id}:{}),phase:unit.cargo.amount>0&&unit.cargo.resource!==resource?'deposit':'gather'},command.queued);
        }else{
          if(target.kind==='resource'||!this.hostile(playerId,target.ownerId))return 'INVALID_TARGET';
          for(const unit of workers)this.setOrder(unit,{kind:'attack',targetId:target.id,lastKnown:{xMm:target.xMm,zMm:target.zMm}},command.queued);
        }return;
      }
      case 'build':{
        if(workers.some(u=>u.typeId!=='villager'))return 'INVALID_BUILDER';
        const def=buildings[command.buildingType],eco=this.state.economies[playerId]!;
        const prerequisite=contentPrerequisiteReason(this.state,playerId,command.buildingType);if(prerequisite)return prerequisite;
        if(this.buildingCapReason(playerId,command.buildingType))return 'BUILDING_LIMIT';
        if(def.id==='monument'&&!this.options.monumentVictory)return 'MONUMENT_DISABLED';
        if(def.maxPerPlayerByAge&&this.owned(playerId).filter(e=>e.typeId===def.id).length>=(def.maxPerPlayerByAge[String(Math.min(4,eco.age))]??Infinity))return 'BUILDING_LIMIT';
        if(def.wallEquivalentCells){if(this.owned(playerId).filter(e=>e.kind==='building').reduce((sum,e)=>sum+(buildings[e.typeId].wallEquivalentCells??0),0)+def.wallEquivalentCells>R.maxWallEquivalentCellsPerPlayer)return 'WALL_LIMIT';}
        else if(this.owned(playerId).filter(e=>e.kind==='building'&&!buildings[e.typeId].wallEquivalentCells).length>=R.maxNonWallBuildingsPerPlayer)return 'BUILDING_LIMIT';
        let [w,h]=def.footprintCells;if(command.rotation===90||command.rotation===270)[w,h]=[h,w];
        const left=command.originCell.x*grid,top=command.originCell.z*grid,right=left+w!*grid,bottom=top+h!*grid;
        if(right>this.state.widthMm||bottom>this.state.heightMm)return 'OUT_OF_BOUNDS';
        const buildingGap=this.commandSource!=='human'?aiBuildingClearanceMm:0;
        const rectangle={xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top},halo=Math.max(R.treeBuildingClearanceM*1000,buildingGap);
        if(!placementAreaDiscovered(rectangle,this.state.widthMm,this.state.heightMm,fogGrid,halo,this.constructionDiscovery(playerId),this.state.map.terrain))return 'PLACEMENT_UNAVAILABLE';
        const deferred=!placementAreaDiscovered(rectangle,this.state.widthMm,this.state.heightMm,fogGrid,halo,(xMm,zMm)=>this.visible(playerId,{xMm,zMm}),this.state.map.terrain);
        const position={xMm:(left+right)/2,zMm:(top+bottom)/2};
        if(!terrainBuildable(this.state.map.terrain,{xMm:left,zMm:top,widthMm:right-left,depthMm:bottom-top}))return 'PLACEMENT_BLOCKED';
        for(const e of this.knownConstructionOccupants(playerId)){
          if((e.kind==='resource'&&e.amount===0)||(e.kind==='unit'&&(e.garrisonedIn||e.hp<=0)))continue;const b=e.kind==='resource'?resourcePlacementBounds(e,R.treeBuildingClearanceM*1000):this.workBounds(e);
          if(e.kind==='building'&&(!def.wallEquivalentCells||!buildings[e.typeId].wallEquivalentCells)){b.halfWidth+=buildingGap;b.halfHeight+=buildingGap;}
          if(e.kind==='unit'){const dx=Math.max(left-e.xMm,0,e.xMm-right),dz=Math.max(top-e.zMm,0,e.zMm-bottom);if(dx*dx+dz*dz<b.halfWidth*b.halfWidth)return 'PLACEMENT_BLOCKED';}
          else if(e.xMm+b.halfWidth>left&&e.xMm-b.halfWidth<right&&e.zMm+b.halfHeight>top&&e.zMm-b.halfHeight<bottom)return 'PLACEMENT_BLOCKED';
        }
        const proposal={id:'proposal',xMm:position.xMm,zMm:position.zMm,halfWidth:w!*grid/2,halfHeight:h!*grid/2};
        const nav=new Navigation(this.state.widthMm,this.state.heightMm,[...this.knownObstacles(playerId),proposal],30000,1000,this.admissionBudget(playerId));
        const dummy={...position,id:'proposal',kind:'building',typeId:def.id,rotation:command.rotation} as Building;
        if(workers.some(worker=>!this.approach(worker,dummy,nav)))return 'NO_PATH';
        if(!this.affordability(playerId,def.cost))return 'INSUFFICIENT_RESOURCES';
        this.spend(playerId,def.cost,1,'construction');const building=this.addBuilding(playerId,command.buildingType,position,command.rotation,false,deferred?{clearanceMm:buildingGap}:undefined);
        for(const worker of workers)this.setOrder(worker,{kind:'build',targetId:building.id},command.queued);return;
      }
      case 'build_wall':case 'replace_wall_with_gate':{
        const buildingGap=this.commandSource!=='human'?aiBuildingClearanceMm:0;
        const discovered=this.constructionDiscovery(playerId);
        const plan=planFortification({state:this.state,clearanceMm:buildingGap,knownEntities:this.knownConstructionOccupants(playerId),discovered:(_p,point)=>discovered(point.xMm,point.zMm),visible:(p,point)=>this.visible(p,point),bounds:entity=>{
          const bounds=entity.kind==='resource'?resourcePlacementBounds(entity,R.treeBuildingClearanceM*1000):this.workBounds(entity);
          if(entity.kind==='building'&&!buildings[entity.typeId].wallEquivalentCells){bounds.halfWidth+=buildingGap;bounds.halfHeight+=buildingGap;}return bounds;
        },obstacles:this.knownObstacles(playerId),workBudget:this.admissionBudget(playerId),canApproach:(worker,target,nav)=>this.approach(worker,target,nav)},playerId,command);
        if('error'in plan){if(plan.error==='INSUFFICIENT_RESOURCES'&&plan.cost)this.affordability(playerId,plan.cost);return plan.error;}
        if(!this.affordability(playerId,plan.cost))return 'INSUFFICIENT_RESOURCES';this.spend(playerId,plan.cost,1,'fortification');
        for(const id of plan.removeIds)delete this.state.entities[id];if(plan.removeIds.length){this.invalidateEntityRoster(true);this.state.navigationRevision++;}
        const created=plan.create.map(site=>this.addBuilding(playerId,site.typeId,site.position,site.rotation,false,site.pending?{clearanceMm:buildingGap}:undefined));
        const allTargets=[...created.map(site=>site.id),...plan.existingTargetIds];
        for(const assignment of plan.assignments){const worker=this.state.entities[assignment.workerId] as Unit,ids=[...new Set([...assignment.siteIndices.map(index=>created[index]!.id),...allTargets])];if(ids.length)this.setOrder(worker,{kind:'build',wallTargets:ids,targetId:ids[0]},command.queued);}return;
      }
      case 'set_gate_mode':{
        const gate=this.state.entities[command.gateId];if(!gate||gate.kind!=='building'||gate.ownerId!==playerId)return 'INVALID_REFERENCE';if(!isGate(gate)||!this.complete(gate))return 'INVALID_TARGET';gate.gateMode=command.mode;return;
      }
      case 'continue_build':{
        const target=this.state.entities[command.foundationId];if(!target||target.kind!=='building'||target.ownerId!==playerId)return 'INVALID_REFERENCE';
        if(this.complete(target)&&!target.upgrade||workers.some(u=>u.typeId!=='villager'))return 'INVALID_TARGET';
        for(const unit of workers){
          const prior=unit.orders[0];
          // Recovery may retry an unchanged work order while its route is still
          // being planned. Keep that paid frontier (or unconsumed result); the
          // ordinary order path still applies current authority/manual flags.
          const retainPendingPath=!command.queued&&unit.orders.length===1&&prior?.kind==='build'&&prior.targetId===target.id
            &&!prior.wallTargets&&prior.planningClass===(this.commandSource===undefined?'routine':'interactive')&&!!unit.pathRequestId&&!unit.path.length
            &&!unit.resourceSearch&&!unit.engagement&&unit.blockedReason!=='PATH_BLOCKED';
          this.setOrder(unit,{kind:'build',targetId:target.id},command.queued,retainPendingPath);
        }return;
      }
      case 'repair':{
        const target=this.state.entities[command.targetId];if(!target||target.kind!=='building'||!this.visible(playerId,target)||this.hostile(playerId,target.ownerId))return 'INVALID_REFERENCE';
        if(!this.complete(target)||workers.some(u=>u.typeId!=='villager'))return 'INVALID_TARGET';
        for(const unit of workers)this.setOrder(unit,{kind:'repair',targetId:target.id},command.queued);return;
      }
      case 'garrison':{
        const target=this.state.entities[command.targetId];if(!target||target.kind==='resource'||!this.visible(playerId,target)||this.hostile(playerId,target.ownerId))return 'INVALID_REFERENCE';
        if(target.kind==='building'&&!this.complete(target)||!garrisonCapacity(target)||this.state.economies[target.ownerId]!.defeated||workers.some(unit=>!canBoard(unit,target)))return 'INVALID_TARGET';
        if((target.garrisoned?.length??0)+workers.length>garrisonCapacity(target))return 'GARRISON_FULL';
        for(const unit of workers)this.setOrder(unit,{kind:'garrison',targetId:target.id,lastKnown:{xMm:target.xMm,zMm:target.zMm}},command.queued);return;
      }
      case 'ungarrison':{
        const building=this.state.entities[command.buildingId];if(!building||building.kind==='resource'||this.hostile(playerId,building.ownerId)||workers.some(unit=>unit.garrisonedIn!==building.id))return 'INVALID_REFERENCE';
        building.pendingUngarrison=[...new Set([...(building.pendingUngarrison??[]),...workers.map(unit=>unit.id)])];return;
      }
      case 'cancel_foundation':{
        const target=this.state.entities[command.foundationId];if(!target||target.kind!=='building'||target.ownerId!==playerId)return 'INVALID_REFERENCE';if(this.complete(target))return 'INVALID_TARGET';
        if(!transact(this.state.economies[playerId]!,refund(buildings[target.typeId].cost,target.work,target.required,target.pendingConstruction?1:R.unfinishedCancelRefundFraction),'foundation_refund',this.state.tick,target.id))return 'RESOURCE_LIMIT';
        delete this.state.entities[target.id];this.invalidateEntityRoster(true);this.state.navigationRevision++;return;
      }
      case 'cancel_job':{
        const target=this.state.entities[command.buildingId];if(!target||target.kind!=='building'||target.ownerId!==playerId)return 'INVALID_REFERENCE';
        if(target.upgrade?.id===command.jobId){const job=target.upgrade;if(!transact(this.state.economies[playerId]!,refund(job.originalCost,job.work,job.required,job.started?R.startedJobRemainingRefundFraction:1),'upgrade_refund',this.state.tick,target.id))return 'RESOURCE_LIMIT';delete target.upgrade;this.activeWorkRoster?.wakeTarget(target.id);return;}
        const index=target.queue.findIndex(j=>j.id===command.jobId);if(index<0)return 'INVALID_REFERENCE';
        const job=target.queue[index]!,fraction=job.started||job.work>0?R.startedJobRemainingRefundFraction:1;
        if(!transact(this.state.economies[playerId]!,refund(job.originalCost,job.work,job.required,fraction),'production_refund',this.state.tick,target.id))return 'RESOURCE_LIMIT';target.queue.splice(index,1);this.updateProductionMembership(target);return;
      }
      case 'demolish':{
        const target=this.state.entities[command.buildingId];if(!target||target.kind!=='building'||target.ownerId!==playerId)return 'INVALID_REFERENCE';
        if(!this.complete(target)||target.demolitionTick)return 'INVALID_TARGET';target.demolitionTick=this.state.tick+Math.ceil(R.demolitionSeconds*R.simulationHz);return;
      }
      case 'set_auto_reseed':this.state.economies[playerId]!.autoReseed=command.enabled;return;
      case 'reseed_farm':{
        const farm=this.state.entities[command.farmId],builder=this.state.entities[command.builderId];
        if(!farm||farm.kind!=='building'||farm.typeId!=='farm'||farm.ownerId!==playerId||!builder||builder.kind!=='unit'||builder.ownerId!==playerId||builder.typeId!=='villager')return 'INVALID_REFERENCE';
        return this.startReseed(farm,builder);
      }
      case 'market_trade':{
        const market=this.state.entities[command.marketId];if(!market||market.kind!=='building'||market.ownerId!==playerId)return 'INVALID_REFERENCE';
        if(market.typeId!=='market'||!this.complete(market)||this.state.economies[playerId]!.age<buildings.market.minAge)return 'AGE_REQUIRED';
        const cost=emptyBank(),change=emptyBank();
        if(command.side==='buy'){cost.gold=R.market.buyGold*command.lots;change[command.resource]=R.market.tradeLot*command.lots*scale;change.gold=-cost.gold*scale;}
        else{cost[command.resource]=R.market.tradeLot*command.lots;change[command.resource]=-cost[command.resource]*scale;change.gold=R.market.sellGold*command.lots*scale;}
        if(!this.affordability(playerId,cost))return 'INSUFFICIENT_RESOURCES';if(!transact(this.state.economies[playerId]!,change,`market_${command.side}`,this.state.tick,market.id))return 'RESOURCE_LIMIT';return;
      }
      case 'tribute':{
        if(!Object.hasOwn(this.state.economies,command.recipientId)||command.recipientId===playerId||this.hostile(playerId,command.recipientId)||this.state.economies[command.recipientId]!.defeated)return 'INVALID_RECIPIENT';
        const cost=emptyBank();cost[command.resource]=command.amount+Math.ceil(command.amount*R.market.tributeFeeFraction);if(!this.affordability(playerId,cost))return 'INSUFFICIENT_RESOURCES';
        const change=emptyBank();change[command.resource]=command.amount*scale;if(!canTransact(this.state.economies[command.recipientId]!,change))return 'RESOURCE_LIMIT';
        this.spend(playerId,cost,1,'tribute_sent');transact(this.state.economies[command.recipientId]!,change,'tribute_received',this.state.tick);return;
      }
      case 'research':case 'advance_age':{
        const producer=this.state.entities[command.kind==='research'?command.buildingId:command.townCenterId];if(!producer||producer.kind!=='building'||producer.ownerId!==playerId)return 'INVALID_REFERENCE';
        if(!this.complete(producer)||producer.hp<=0||producer.demolitionTick)return 'INVALID_PRODUCER';
        const economy=this.state.economies[playerId]!,pending=this.owned(playerId).flatMap(entity=>entity.kind==='building'?entity.queue:[]);
        if(command.kind==='research'){
          const definition=technologies[command.technologyId];if(producer.typeId!==definition.researchedAt)return 'INVALID_PRODUCER';
          if(economy.technologies.includes(command.technologyId))return 'ALREADY_RESEARCHED';
          if(pending.some(job=>job.kind==='research'&&job.typeId===command.technologyId))return 'RESEARCH_PENDING';
          const reason=researchPrerequisiteReason(this.state,playerId,command.technologyId);if(reason)return reason;
          if(producer.queue.length>=R.queueWaitingLimit+1)return 'QUEUE_FULL';if(!this.affordability(playerId,definition.cost))return 'INSUFFICIENT_RESOURCES';
          this.spend(playerId,definition.cost,1,'research',producer.id);producer.queue.push({id:this.id(),kind:'research',typeId:command.technologyId,originalCost:structuredClone(definition.cost),work:0,required:definition.researchSeconds*R.simulationHz,reserved:false,started:false,state:'waiting'});
        }else{
          if(producer.typeId!=='town_center')return 'INVALID_PRODUCER';
          if(command.targetAge!==economy.age+1)return 'INVALID_AGE';if(pending.some(job=>job.kind==='age'))return 'AGE_PENDING';
          const reason=agePrerequisiteReason(this.state,playerId,command.targetAge);if(reason)return reason;
          const definition=resolveRuleset(this.options.rulesetId,this.options.maxAge,this.options.startingResourcePreset).ages.find(age=>age.id===command.targetAge)!;
          if(producer.queue.length>=R.queueWaitingLimit+1)return 'QUEUE_FULL';if(!this.affordability(playerId,definition.cost))return 'INSUFFICIENT_RESOURCES';
          this.spend(playerId,definition.cost,1,'age_advancement',producer.id);producer.queue.push({id:this.id(),kind:'age',typeId:`age_${command.targetAge}`,targetAge:command.targetAge,originalCost:structuredClone(definition.cost),work:0,required:definition.researchSeconds*R.simulationHz,reserved:false,started:false,state:'waiting'});
        }
        this.updateProductionMembership(producer);return;
      }
      case 'train':{
        const building=this.state.entities[command.buildingId];if(!building||building.kind!=='building'||building.ownerId!==playerId)return 'INVALID_REFERENCE';
        const def=units[command.unitType];if(!this.complete(building)||def.producedAt!==building.typeId||building.demolitionTick)return 'INVALID_PRODUCER';
        const prerequisite=contentPrerequisiteReason(this.state,playerId,command.unitType);if(prerequisite)return prerequisite;
        if(def.maxPerPlayer&&this.owned(playerId).reduce((count,e)=>count+(e.kind==='unit'&&e.typeId===def.id?1:0)+(e.kind==='building'?e.queue.filter(j=>j.kind==='train'&&j.typeId===def.id).length:0),0)+command.quantity>def.maxPerPlayer)return 'UNIT_LIMIT';
        if(building.queue.length+command.quantity>R.queueWaitingLimit+1)return 'QUEUE_FULL';
        if(!this.affordability(playerId,def.cost,command.quantity))return 'INSUFFICIENT_RESOURCES';
        this.spend(playerId,def.cost,command.quantity,'training',building.id);for(let i=0;i<command.quantity;i++)building.queue.push({id:this.id(),kind:'train',typeId:command.unitType,originalCost:structuredClone(def.cost),work:0,required:def.trainSeconds*R.simulationHz,reserved:false,started:false,state:'waiting'});this.updateProductionMembership(building);return;
      }
      case 'set_rally':{const building=this.state.entities[command.buildingId];if(!building||building.kind!=='building'||building.ownerId!==playerId)return 'INVALID_REFERENCE';if(command.target.xMm>=this.state.widthMm||command.target.zMm>=this.state.heightMm)return 'OUT_OF_BOUNDS';building.rally={...command.target};return;}
      case 'surrender':this.eliminate(playerId);return;
      default:return 'NOT_IMPLEMENTED';
    }
  }
  private advanceProduction():void{
    const roster=this.phaseRoster();
    for(const e of (roster?this.productionCandidates(roster):this.coarseFrame?this.actors():this.all())){
      if(e.kind!=='building'||e.hp<=0||!this.complete(e)||this.state.economies[e.ownerId]!.defeated)continue;
      const job=e.queue[0];if(!job)continue;
      if(!job.started){
        if(job.kind==='train'){
          const reason=contentPrerequisiteReason(this.state,e.ownerId,job.typeId);if(reason){job.state='prerequisite_blocked';job.blockedReason=reason;continue;}
          const p=this.population(e.ownerId);if(p.population+p.reservedPopulation+units[job.typeId].population>p.populationCap){job.state='population_blocked';continue;}job.reserved=true;
        }else{
          const reason=job.kind==='age'?agePrerequisiteReason(this.state,e.ownerId,job.targetAge):researchPrerequisiteReason(this.state,e.ownerId,job.typeId);
          if(reason){job.state='prerequisite_blocked';job.blockedReason=reason;continue;}
        }
        job.started=true;job.state='active';delete job.blockedReason;
      }
      if(job.work<job.required)job.work++;
      if(job.work>=job.required){
        const economy=this.state.economies[e.ownerId]!;
        if(job.kind==='train'){
          const exit=this.exitPosition(e,job.typeId);if(!exit){job.state='exit_blocked';continue;}
          const unit=this.addUnit(e.ownerId,job.typeId,exit);economy.statistics.unitsTrained++;if(e.rally){const assistant=this.state.control[e.ownerId]?.assistant,manual=assistant?.protectedEntityIds.includes(e.id);unit.orders.push({kind:'move',target:{...e.rally},...(manual?{manualOrder:true as const}:{})});if(manual){assistant!.protectedEntityIds.push(unit.id);assistant!.releaseAfterIdle[unit.id]=-1;}}
        }else if(job.kind==='research'){
          this.progression.completeResearch(e.ownerId,job.typeId);economy.notifications.push({id:this.id(),tick:this.state.tick,code:`RESEARCH_COMPLETED:${job.typeId}`,entityId:e.id});
        }else{
          economy.age=job.targetAge;this.wards.invalidate();economy.statistics.ageTicks[job.targetAge]=this.state.tick;this.state.ageAnnouncements.push({playerId:e.ownerId,age:job.targetAge,tick:this.state.tick});economy.notifications.push({id:this.id(),tick:this.state.tick,code:`AGE_ADVANCED:${job.targetAge}`,entityId:e.id});
        }
        if(economy.notifications.length>30)economy.notifications.splice(0,economy.notifications.length-30);e.queue.shift();this.updateProductionMembership(e);
      }
    }
  }
  private rememberFrameWorkWait(unit:Unit,target:Entity,search=false):void{
    if(!this.coarseFrame||!this.frameDeferredKnowledge)return;
    this.frameWorkWaits.set(unit,{frame:this.frameStartTick,order:unit.orders[0],revision:unit.orderRevision??0,target,phase:unit.orders[0]?.phase,cargo:unit.cargo.amount,resource:unit.cargo.resource,research:this.state.economies[unit.ownerId]!.researchRevision,x:unit.xMm,z:unit.zMm,
      ...(search?{search:unit.resourceSearch,searchIndex:unit.resourceSearch?.index,requestId:unit.pathRequestId}:{})});
  }
  /** Pending resource searches cannot complete between service admissions. A
   * travelling worker cannot work until its path empties; arrival wakes work in
   * the following slice, preserving work-before-movement event ordering. */
  private continueFrameWorkWait(unit:Unit):boolean{
    if(!this.coarseFrame||!this.frameDeferredKnowledge)return false;
    const wait=this.frameWorkWaits.get(unit),order=unit.orders[0];
    if(!wait||wait.frame!==this.frameStartTick&&(!this.liveOwned||!!wait.search)||wait.order!==order||wait.revision!==(unit.orderRevision??0)||wait.phase!==order?.phase||wait.cargo!==unit.cargo.amount||wait.resource!==unit.cargo.resource||wait.research!==this.state.economies[unit.ownerId]!.researchRevision)return false;
    if(wait.search){
      if(!(this.pathScheduler instanceof RemotePathScheduler)||unit.resourceSearch!==wait.search||unit.resourceSearch.index!==wait.searchIndex||unit.resourceSearch.targetIds[wait.searchIndex!]!==wait.target.id||!wait.requestId||unit.pathRequestId!==wait.requestId||unit.xMm!==wait.x||unit.zMm!==wait.z||this.knownTarget(unit.ownerId,wait.target.id)!==wait.target||wait.target.kind!=='resource'||wait.target.amount<=0)return false;
      this.frameWorkSchedulingCounts.resourceWait++;return true;
    }
    if(unit.resourceSearch||!order||order.wallTargets||!unit.path.length||order.targetId!==wait.target.id||this.knownTarget(unit.ownerId,wait.target.id)!==wait.target)return false;
    const target=wait.target;
    if(order.kind==='gather'){
      if(order.phase!=='gather'||target.kind==='unit'||target.kind==='resource'&&target.amount<=0||target.kind==='building'&&(target.typeId!=='farm'||(target.foodRemaining??0)<=0||target.farmerId!==unit.id))return false;
      // The full call established capacity, resource availability and the farm
      // assignment. Current target knowledge and cargo/research stamps preserve
      // that eligibility; no task/action mutation occurs during this travel.
    }else if(target.kind!=='building'||order.kind==='build'&&this.complete(target)&&!target.upgrade||order.kind==='repair'&&target.hp>=target.maxHp||order.kind==='reseed'&&!target.reseedRequired||!['build','repair','reseed'].includes(order.kind))return false;
    this.frameWorkSchedulingCounts.transit++;return true;
  }
  /** Positive proof only: an eligible pinned dropoff avoids traversing the
   * entire known resource world. A failed proof uses ordinary ordered search. */
  private frameTransitDropoff(unit:Unit):Building|undefined{
    if(!this.coarseFrame||!this.frameDeferredKnowledge)return;
    if(!unit.path.length){
      const pending=this.framePendingWorkFace(unit);
      if(!pending||pending.order.kind!=='gather'||pending.order.phase!=='deposit'||pending.target.kind!=='building'||this.pendingDepositContact(unit))return;
      this.frameWorkSchedulingCounts.pinnedDropoffs++;return pending.target;
    }
    const id=unit.orders[0]?.dropOffId;if(!id)return;
    const target=this.knownTarget(unit.ownerId,id);
    if(target?.kind!=='building'||!('progress'in target?target.progress===1:this.complete(target))||this.hostile(unit.ownerId,target.ownerId)||this.state.economies[target.ownerId]!.defeated||!buildings[target.typeId].dropOffResources.includes(unit.cargo.resource!))return;
    this.frameWorkSchedulingCounts.pinnedDropoffs++;return target;
  }
  private rememberFrameWorkFaceWait(unit:Unit,order:Order,target:Entity):void{
    if(!this.coarseFrame||!this.frameDeferredKnowledge||!(this.pathScheduler instanceof RemotePathScheduler)||!unit.pathRequestId||unit.path.length||unit.engagement||unit.resourceSearch||order.wallTargets||!['gather','build','repair','reseed'].includes(order.kind)||target.kind==='unit'||this.state.entities[target.id]!==target||this.knownTarget(unit.ownerId,target.id)!==target||!unit.approachGoal?.point)return;
    const approach=unit.approachGoal,point=approach.point!,bounds=this.workBounds(target);
    this.frameWorkFaceWaits.set(unit,{frame:this.frameStartTick,order,kind:order.kind,phase:order.phase,targetId:order.targetId,dropOffId:order.dropOffId,revision:unit.orderRevision??0,requestId:unit.pathRequestId,ownerId:unit.ownerId,typeId:unit.typeId,x:unit.xMm,z:unit.zMm,cargo:unit.cargo.amount,resource:unit.cargo.resource,research:this.state.economies[unit.ownerId]!.researchRevision,physicalRevision:this.state.navigationRevision,profileRevision:this.planningNavigations.get(unit.ownerId)!.revision,path:unit.path,destination:unit.pathDestination,destinationX:unit.pathDestination?.xMm,destinationZ:unit.pathDestination?.zMm,target,targetType:target.typeId,targetOwner:target.ownerId,targetX:target.xMm,targetZ:target.zMm,...bounds,approach,point,pointX:point.xMm,pointZ:point.zMm});
  }
  /** A positive live work-face proof only. Pending service cannot complete
   * inside the frame; current visibility, work eligibility, reservation and
   * occupation are still checked before retaining the selected face. */
  private framePendingWorkFace(unit:Unit):FrameWorkFaceWait|undefined{
    if(!this.coarseFrame||!this.frameDeferredKnowledge||!(this.pathScheduler instanceof RemotePathScheduler))return;
    const wait=this.frameWorkFaceWaits.get(unit),order=unit.orders[0];
    if(!wait||wait.frame!==this.frameStartTick||wait.order!==order||wait.kind!==order.kind||wait.phase!==order.phase||wait.targetId!==order.targetId||wait.dropOffId!==order.dropOffId||wait.revision!==(unit.orderRevision??0)||wait.requestId!==unit.pathRequestId||wait.ownerId!==unit.ownerId||wait.typeId!==unit.typeId||wait.x!==unit.xMm||wait.z!==unit.zMm||wait.cargo!==unit.cargo.amount||wait.resource!==unit.cargo.resource||wait.path!==unit.path||unit.path.length||unit.resourceSearch||unit.engagement||unit.garrisonedIn||unit.pathBlockedRevision!==undefined||order.wallTargets||unit.pathDestination!==wait.destination||unit.pathDestination?.xMm!==wait.destinationX||unit.pathDestination?.zMm!==wait.destinationZ||unit.approachGoal!==wait.approach||wait.approach.point!==wait.point||wait.point.xMm!==wait.pointX||wait.point.zMm!==wait.pointZ||wait.approach.revision!==wait.profileRevision||wait.physicalRevision!==this.state.navigationRevision||wait.profileRevision!==this.planningNavigations.get(unit.ownerId)!.revision||wait.research!==this.state.economies[unit.ownerId]!.researchRevision)return;
    const target=wait.target;
    if(target.kind==='unit'||this.state.entities[target.id]!==target||this.knownTarget(unit.ownerId,target.id)!==target||target.typeId!==wait.targetType||target.ownerId!==wait.targetOwner||target.xMm!==wait.targetX||target.zMm!==wait.targetZ)return;
    const bounds=this.workBounds(target);if(bounds.halfWidth!==wait.halfWidth||bounds.halfHeight!==wait.halfHeight)return;
    if(order.kind==='gather'&&order.phase==='deposit'){
      if(target.kind!=='building'||target.id!==order.dropOffId||!unit.cargo.amount||!this.complete(target)||this.hostile(unit.ownerId,target.ownerId)||this.state.economies[target.ownerId]!.defeated||!buildings[target.typeId].dropOffResources.includes(unit.cargo.resource!))return;
    }else if(target.id!==order.targetId||order.kind==='gather'&&(target.kind==='resource'?target.amount<=0:target.typeId!=='farm'||(target.foodRemaining??0)<=0||target.farmerId!==unit.id)||order.kind==='build'&&(target.kind!=='building'||this.complete(target)&&!target.upgrade)||order.kind==='repair'&&(target.kind!=='building'||target.hp>=target.maxHp)||order.kind==='reseed'&&(target.kind!=='building'||!target.reseedRequired))return;
    const radius=units[unit.typeId].collisionRadiusM*1000;
    if(this.occupied(wait.point,radius,unit.id,unit.ownerId)||!this.reservations(unit.ownerId).available(unit.id,wait.point,radius))return;
    return wait;
  }
  /** Never cache "no deposit possible". A nearby completed camp may become
   * eligible during this slice without changing navigationRevision. A current
   * geometric candidate wakes the exact sorted dropoff/LOS selection path. */
  private pendingDepositContact(unit:Unit):boolean{
    const radius=units[unit.typeId].collisionRadiusM*1000+1100;
    if(this.liveOwned&&this.coarseFrame&&this.frameDeferredKnowledge){
      // This is only a wake-up test for current physical contact. A remembered
      // hidden building cannot satisfy the owner-or-current-visibility check
      // below. Stable native IDs/geometry therefore let us inspect live buildings
      // directly, without preparing every known resource and memory record.
      // The ordinary sorted dropoff/LOS routine still performs the actual work.
      // Only immutable content-kind membership is retained. Construction can
      // finish without a geometry revision, and visibility/policy/cargo may
      // change within this slice, so every eligibility predicate stays live.
      let membership=this.liveDepositBuildings;
      if(!membership||membership.revision!==this.liveStaticRevision)this.liveDepositBuildings=membership={revision:this.liveStaticRevision,buildings:this.actors().filter((entity):entity is Building=>entity.kind==='building'&&buildings[entity.typeId].dropOffResources.length>0)};
      for(const drop of membership.buildings)if(buildings[drop.typeId].dropOffResources.includes(unit.cargo.resource!)
        &&this.boundaryDistance(unit,drop)<=radius&&this.complete(drop)
        &&!this.hostile(unit.ownerId,drop.ownerId)&&!this.state.economies[drop.ownerId]!.defeated
        &&(drop.ownerId===unit.ownerId||this.visible(unit.ownerId,drop)))return true;
      return false;
    }
    return this.dropoffs(unit,false).some(drop=>(drop.ownerId===unit.ownerId||this.visible(unit.ownerId,drop))&&this.state.entities[drop.id]&&this.boundaryDistance(unit,drop)<=radius);
  }
  private activeWorkRoster:ActiveWorkRoster|undefined;
  private activeWorkNavigationRevision=-1;
  private workDepletionRevisions=0;
  private activeWorkGeometryRevision=-1;
  private activeWorkEpoch=-1;
  private activeWorkOwners='';
  private activeGatherJobs=new WeakMap<Unit,{
    roster:ActiveWorkRoster;generation:number;order:Order;target:ResourceNode|Building;
    resource:ResourceType;rate:number;capacity:number;cargo:number;cargoResource:Unit['cargo']['resource'];
    x:number;z:number;targetX:number;targetZ:number;ownerId:string;research:number;
  }>();

  private prepareActiveWork():ActiveWorkRoster|undefined{
    if(!this.liveOwned||!this.coarseFrame||!this.frameDeferredKnowledge){this.activeWorkRoster=undefined;return;}
    const actors=this.actors();
    if(!this.activeWorkRoster||this.activeWorkRoster.actors!==actors||this.activeWorkEpoch!==this.state.matchEpoch){
      this.activeGatherJobs=new WeakMap();
      this.activeWorkRoster=ActiveWorkRoster.create(actors,this.frameStartTick);
      this.activeWorkNavigationRevision=this.state.navigationRevision;
      this.activeWorkGeometryRevision=this.state.navigationRevision-this.workDepletionRevisions;
      this.activeWorkEpoch=this.state.matchEpoch;
      this.activeWorkOwners='';
    }
    const roster=this.activeWorkRoster;if(!roster)return;roster.beginFrame(this.frameStartTick);
    const owners=this.state.factions.map(f=>`${f.id}:${this.state.economies[f.id]!.researchRevision}:${this.state.economies[f.id]!.defeated}:${f.teamId}`).join('|');
    const geometryRevision=this.state.navigationRevision-this.workDepletionRevisions;
    if(this.activeWorkGeometryRevision!==geometryRevision||owners!==this.activeWorkOwners)roster.wakeAll();
    else if(this.activeWorkNavigationRevision!==this.state.navigationRevision)roster.wakeSleeping();
    this.activeWorkGeometryRevision=geometryRevision;
    this.activeWorkNavigationRevision=this.state.navigationRevision;this.activeWorkOwners=owners;
    return roster;
  }

  /** Exactly the existing resource/building visibility samples. Subscribe only
   * authorized target records; larger/custom footprints remain scalar. */
  private workTargetFogCells(target:Entity):number[]{
    const width=Math.floor(this.state.widthMm/fogGrid),height=Math.floor(this.state.heightMm/fogGrid),cells:number[]=[];
    if(target.kind==='resource'){
      const radius=target.resource==='wood'?450:650;
      for(let z=Math.max(0,Math.floor((target.zMm-radius)/fogGrid));z<=Math.min(height-1,Math.ceil((target.zMm+radius)/fogGrid)-1);z++)for(let x=Math.max(0,Math.floor((target.xMm-radius)/fogGrid));x<=Math.min(width-1,Math.ceil((target.xMm+radius)/fogGrid)-1);x++)cells.push(z*width+x);
    }else if(target.kind==='building'){
      let [w,h]=buildings[target.typeId].footprintCells;if(target.rotation===90||target.rotation===270)[w,h]=[h,w];
      for(let z=target.zMm-h*grid/2+fogGrid/2;z<target.zMm+h*grid/2;z+=fogGrid)for(let x=target.xMm-w*grid/2+fogGrid/2;x<target.xMm+w*grid/2;x+=fogGrid)cells.push(Math.floor(z/fogGrid)*width+Math.floor(x/fogGrid));
    }
    return cells;
  }

  /** A normal work pass already established these no-op cases. Never sleep a
   * contested farm, a hidden unobserved target, or construction/repair/reseed. */
  private classifyActiveWork(unit:Unit,roster:ActiveWorkRoster):void{
    if(this.activeWorkRoster!==roster||unit.garrisonedIn||unit.engagement||this.state.economies[unit.ownerId]!.defeated)return;
    const order=unit.orders[0];
    if(!order&&!unit.resourceSearch&&unit.taskState==='idle'&&!unit.blockedReason){roster.watch(unit,[],[],'inert');return;}
    if(order&&!unit.resourceSearch&&!['gather','build','repair','reseed'].includes(order.kind)){roster.watch(unit,[],[],'inert');return;}
    const wait=this.frameWorkWaits.get(unit);
    if(wait?.frame===this.frameStartTick&&wait.search&&unit.resourceSearch===wait.search&&unit.pathRequestId===wait.requestId&&wait.target.kind==='resource'&&wait.target.amount>0){
      roster.watch(unit,[wait.target.id],this.workTargetFogCells(wait.target),'pending');return;
    }
    if(order?.kind!=='gather')return;
    if(wait&&(wait.frame===this.frameStartTick||this.liveOwned)&&wait.order===order&&!wait.search&&unit.path.length&&order.phase==='gather'&&wait.target.id===order.targetId){
      roster.watch(unit,[wait.target.id],this.workTargetFogCells(wait.target),'travel');return;
    }
    // Depositing travellers retain their current eligible dropoff. Both the
    // original resource and dropoff are watched: resource depletion can change
    // planningClass even while the worker is carrying cargo elsewhere.
    if(order.phase==='deposit'&&unit.path.length&&unit.cargo.amount&&order.dropOffId){
      const target=this.knownTarget(unit.ownerId,order.targetId!),drop=this.knownTarget(unit.ownerId,order.dropOffId);
      if(target&&drop?.kind==='building'&&this.state.entities[drop.id]===drop&&this.frameTransitDropoff(unit))roster.watch(unit,[target.id,drop.id],[...this.workTargetFogCells(target),...this.workTargetFogCells(drop)],'travel');
    }
  }

  /** Called only after the ordinary movement phase has established the existing
   * positive pending-face proof. It does not infer a route from a pending job. */
  private sleepPendingWork(unit:Unit):void{
    const roster=this.activeWorkRoster;if(!roster)return;
    const wait=this.framePendingWorkFace(unit),order=unit.orders[0];
    if(!wait||order?.kind!=='gather')return;
    const target=this.knownTarget(unit.ownerId,order.targetId!);if(!target)return;
    if(order.phase==='deposit'&&this.pendingDepositContact(unit))return;
    roster.watch(unit,[target.id,wait.target.id],[...this.workTargetFogCells(target),...this.workTargetFogCells(wait.target)],order.phase==='deposit'?'deposit':'pending');
  }

  /** Shared unchanged integer gather kernel. Keep this at every original50ms
   * event: no multiplication of elapsed ticks and no invented action credit. */
  private commitGatherContact(unit:Unit,order:Order,node:ResourceNode|Building,resource:ResourceType,rate:number,capacity:number):void{
    const available=node.kind==='building'?node.foodRemaining??0:node.amount,denominator=R.simulationHz*1000;
    unit.gatherRemainder+=Math.round(rate*scale*1000);
    const amount=Math.min(Math.floor(unit.gatherRemainder/denominator),capacity-unit.cargo.amount,available);unit.gatherRemainder%=denominator;
    unit.cargo.resource=resource;unit.cargo.amount+=amount;
    if(amount>0)this.committedActions.set(unit.id,{kind:resource==='food'?'gather_food':resource==='wood'?'gather_wood':'mine',...committedFacing(unit,node)});
    if(node.kind==='building')node.foodRemaining!-=amount;else{node.amount-=amount;if(amount>0&&this.liveOwned&&this.coarseFrame)this.frameChangedResources.add(node);if(node.amount===0){this.state.navigationRevision++;this.workDepletionRevisions++;if(this.liveOwned){this.liveDepletedResources.add(node);this.physicalObstacleRoster?.members.delete(node);}}}
    const roster=this.activeWorkRoster;
    if((node.kind==='building'?node.foodRemaining??0:node.amount)<=0)roster?.wakeTarget(node.id);
    if(!roster||this.knownTarget(unit.ownerId,node.id)!==node||this.state.entities[node.id]!==node||unit.path.length||unit.cargo.amount>=capacity){roster?.wake(unit.id);return;}
    const prior=this.activeGatherJobs.get(unit);
    if(prior?.roster===roster&&prior.order===order&&prior.target===node&&prior.generation===roster.generation(unit.id)&&prior.rate===rate&&prior.capacity===capacity&&prior.x===unit.xMm&&prior.z===unit.zMm&&prior.targetX===node.xMm&&prior.targetZ===node.zMm&&prior.ownerId===unit.ownerId&&prior.research===this.state.economies[unit.ownerId]!.researchRevision){prior.cargo=unit.cargo.amount;prior.cargoResource=unit.cargo.resource;return;}
    if(!roster.watch(unit,[node.id],this.workTargetFogCells(node))){this.activeGatherJobs.delete(unit);return;}
    this.activeGatherJobs.set(unit,{roster,generation:roster.generation(unit.id)!,order,target:node,resource,rate,capacity,cargo:unit.cargo.amount,cargoResource:unit.cargo.resource,x:unit.xMm,z:unit.zMm,targetX:node.xMm,targetZ:node.zMm,ownerId:unit.ownerId,research:this.state.economies[unit.ownerId]!.researchRevision});
  }

  private continueActiveGather(unit:Unit):boolean{
    const roster=this.activeWorkRoster,job=this.activeGatherJobs.get(unit),order=unit.orders[0];
    if(!roster||!job||job.roster!==roster||job.generation!==roster.generation(unit.id)||order!==job.order||order.kind!=='gather'||order.phase==='deposit'||order.targetId!==job.target.id||unit.resourceSearch||unit.path.length||unit.cargo.amount!==job.cargo||unit.cargo.resource!==job.cargoResource||unit.xMm!==job.x||unit.zMm!==job.z||unit.ownerId!==job.ownerId||this.state.economies[unit.ownerId]!.researchRevision!==job.research)return false;
    const node=job.target;
    if(this.state.entities[node.id]!==node||node.xMm!==job.targetX||node.zMm!==job.targetZ||this.knownTarget(unit.ownerId,node.id)!==node||node.kind==='resource'&&node.amount<=0||node.kind==='building'&&((node.foodRemaining??0)<=0||node.farmerId!==unit.id)||unit.cargo.amount>=job.capacity||!this.workReachable(unit,node))return false;
    this.task(unit,'gathering');this.commitGatherContact(unit,order,node,job.resource,job.rate,job.capacity);roster.recordContact();return true;
  }
  /** Reuse the existing four-per-second idle selection, never an all-world
   * per-tick rescue. Explicit holds and AI Pilot pins remain authoritative. */
  private assistNearbyWall(worker:Unit):boolean {
    const assistant=this.state.control[worker.ownerId]?.assistant;
    if(worker.cargo.amount||assistant?.protectedEntityIds.includes(worker.id))return false;
    const radius=R.idleGatherRadiusM*1000,targets:Building[]=[],actors=this.coarseFrame?this.actors():this.all();
    for(const entity of actors)if(entity.kind==='building'&&entity.ownerId===worker.ownerId&&buildings[entity.typeId].wallEquivalentCells&&(!this.complete(entity)||entity.upgrade)&&distance(worker,entity)<=radius&&!(entity.pendingConstruction?.blocked&&this.state.tick<(entity.pendingConstruction.retryAtTick??0))&&!(assistant?.protectedEntityIds.includes(entity.id)&&!Object.hasOwn(assistant.releaseAfterIdle,entity.id)))targets.push(entity);
    if(!targets.length)return false;
    targets.sort((a,b)=>distance(worker,a)-distance(worker,b)||a.id.localeCompare(b.id));
    const unassigned=new Set(targets.map(target=>target.id));
    // Existing and queued construction retains its crew. Rescue orphaned work
    // without recruiting every idle villager into an already crowded approach.
    for(const entity of actors)if(entity.kind==='unit'&&entity.ownerId===worker.ownerId&&entity.hp>0)for(const order of entity.orders)if(order.kind==='build'){
      if(order.targetId)unassigned.delete(order.targetId);for(const id of order.wallTargets??[])unassigned.delete(id);
    }
    const wallTargets=[...unassigned].slice(0,R.maxWallSegmentsPerCommand);if(!wallTargets.length)return false;
    this.setOrder(worker,{kind:'build',targetId:wallTargets[0],wallTargets},false);return true;
  }
  private advanceWork():StaticKnowledgeFrame|undefined{
    this.workFrame=this.liveOwned&&this.coarseFrame?{knowledge:this.workKnowledgeForFrame()}:{};try{
    const activeWork=this.prepareActiveWork();
    const builders=new Map<string,Unit[]>(),repairers=new Map<string,Unit[]>(),reseeders=new Map<string,Unit[]>();
    // Start at most four idle searches per second across the whole match. The
    // tick-derived rotating choice is deterministic without an unsaved cursor.
    if(this.state.tick%5===0){
      const idle=(this.coarseFrame?this.actors():this.all()).filter((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'&&e.autoGather===true&&!e.orders.length&&!e.resourceSearch&&!e.garrisonedIn&&!e.engagement&&e.stance!=='stand_ground'&&e.hp>0&&!this.state.economies[e.ownerId]!.defeated&&(this.options.controllers!==false||this.state.control[e.ownerId]!.mode!=='ai')&&this.state.tick>=(e.autoGatherAtTick??0));
      const worker=idle[Math.floor(this.state.tick/5)%idle.length];if(worker&&!this.assistNearbyWall(worker))this.startResourceSearch(worker,'idle',worker,R.idleGatherRadiusM*1000);
    }
    const farmRoster=this.phaseRoster()?.farms;if(farmRoster)countPhaseRoster('farms',farmRoster.length);
    for(const e of (farmRoster??(this.coarseFrame?this.actors():this.all())))if(e.kind==='building'&&e.typeId==='farm'&&e.farmerId){const worker=this.state.entities[e.farmerId];if(!worker||worker.kind!=='unit'||worker.orders[0]?.kind!=='gather'||worker.orders[0]?.targetId!==e.id){delete e.farmerId;this.activeWorkRoster?.wakeTarget(e.id);}}
    for(const e of activeWork?.due()??(this.coarseFrame?this.actors():this.all())){
      if(e.kind!=='unit'||e.garrisonedIn||e.engagement||this.state.economies[e.ownerId]!.defeated)continue;
      try{
      if(this.continueActiveGather(e))continue;
      if(this.continueFrameWorkWait(e))continue;
      if(e.resourceSearch){this.advanceResourceSearch(e);continue;}
      const order=e.orders[0];if(!order){this.task(e,'idle');continue;}
      if(order.kind==='build'&&order.wallTargets){
        const pending=order.wallTargets.map(id=>this.state.entities[id]).filter((target):target is Building=>Boolean(target?.kind==='building'&&(!this.complete(target)||target.upgrade)));order.wallTargets=pending.map(target=>target.id);
        if(!pending.length){e.orders.shift();this.cancelPath(e);this.task(e,e.orders.length?'moving':'idle');continue;}
        // Passing through a nonphysical plan is legal. Only relocate a stopped
        // builder; cancelling an in-progress crossing would oscillate at edges.
        const occupied=!e.path.length&&!e.pathRequestId?this.pendingBuildOverlap(e):undefined;
        if(occupied&&occupied.id!==order.targetId){this.cancelPath(e);order.targetId=occupied.id;}
        const currentIndex=pending.findIndex(target=>target.id===order.targetId),goal=e.approachGoal;
        const exhausted=goal&&goal.key===order.targetId&&!goal.point&&goal.retryAtTick!==undefined;
        // The saved target list is a nearest-first pass, with targetId as its
        // cursor. Movement proves each face through the incremental scheduler;
        // a pending search must retain its frontier instead of using admission A*.
        const nextPass=currentIndex<0||(exhausted&&currentIndex===pending.length-1&&this.state.tick>=goal.retryAtTick!);
        const blockedSite=currentIndex>=0?pending[currentIndex]!.pendingConstruction:undefined;
        const blocked=blockedSite?.blocked&&this.state.tick<(blockedSite.retryAtTick??0);
        const available=(target:Building)=>!target.pendingConstruction?.blocked||this.state.tick>=(target.pendingConstruction.retryAtTick??0);
        if(blocked&&!occupied){
          // Activation failures do not exhaust an approach search. Keep the
          // paid site, but let this worker use another segment during its retry.
          const alternatives=[...pending.slice(currentIndex+1),...pending.slice(0,currentIndex)].filter(available);
          const next=alternatives.find(target=>this.workReachable(e,target))??alternatives[0];
          if(next){this.cancelPath(e);order.targetId=next.id;}
        }else if(!occupied&&!e.path.length&&!e.pathRequestId&&currentIndex>=0&&(builders.get(pending[currentIndex]!.id)?.length??0)>=R.constructionWorkerMultipliers.length){
          // Extra contact workers add no speed beyond the configured curve.
          // Send them to other paid work; routing still proves a legal approach.
          const alternatives=pending.filter(target=>target.id!==order.targetId&&available(target)&&(builders.get(target.id)?.length??0)<R.constructionWorkerMultipliers.length);
          const next=alternatives.find(target=>this.workReachable(e,target))??alternatives[0];
          if(next){this.cancelPath(e);order.targetId=next.id;}
        }else if(nextPass){
          pending.sort((a,b)=>distance(e,a)-distance(e,b));order.wallTargets=pending.map(target=>target.id);
          this.cancelPath(e);order.targetId=pending[0]!.id;
        }else if(exhausted&&currentIndex<pending.length-1&&!this.workReachable(e,pending[currentIndex]!)){
          this.cancelPath(e);order.targetId=pending[currentIndex+1]!.id;
        }
      }
      if(order.kind==='build'||order.kind==='repair'||order.kind==='reseed'){
        const target=this.knownTarget(e.ownerId,order.targetId!);
        if(target&&target.ownerId!==e.ownerId&&!this.visible(e.ownerId,target))continue;
        if(!target||target.kind!=='building'||(order.kind==='build'&&this.complete(target)&&!target.upgrade)||(order.kind==='repair'&&target.hp>=target.maxHp)||(order.kind==='reseed'&&!target.reseedRequired)){e.orders.shift();this.cancelPath(e);this.task(e,e.orders.length?'moving':'idle');continue;}
        if(this.workReachable(e,target)){if(target.pendingConstruction&&!this.activateConstruction(target)){this.task(e,'blocked','PLACEMENT_BLOCKED');continue;}const map=order.kind==='build'?builders:order.kind==='repair'?repairers:reseeders;const list=map.get(target.id)??[];list.push(e);map.set(target.id,list);this.task(e,order.kind==='repair'?'repairing':'building');}
        else if(e.path.length&&!order.wallTargets)this.rememberFrameWorkWait(e,target);
      }
      if(order.kind==='gather')this.gather(e,order);
      }finally{if(activeWork)this.classifyActiveWork(e,activeWork);}
    }
    for(const [id,workers]of builders){
      const b=this.state.entities[id] as Building,def=this.progression.building(b.ownerId,b.typeId);
      if(b.upgrade){
        const job=b.upgrade;job.started=true;job.work=Math.min(job.required,job.work+Math.round(this.workerEfficiency(workers.length)*100*this.progression.construction(b.ownerId)));
        for(const worker of workers.slice(0,R.constructionWorkerMultipliers.length))this.committedActions.set(worker.id,{kind:'build',...committedFacing(worker,b)});
        if(job.work===job.required){
          this.frameCombatTimeline?.prepareWeaponChange(b);
          const missing=b.maxHp-b.hp,oldPorts=def.attack?(def.weaponPorts??1):0,oldCooldowns=b.weaponCooldowns??[];
          b.typeId=job.targetTypeId;const next=this.progression.building(b.ownerId,b.typeId);rescaleRepairDenominator(b,next.maxHp);b.maxHp=next.maxHp;b.hp=Math.max(1,next.maxHp-missing);b.grantedHp=next.maxHp;
          b.required=next.buildSeconds*R.simulationHz*100;b.work=b.required;
          if(next.attack&&!def.attack)b.cooldown=Math.max(b.cooldown,2);
          if(next.weaponPorts)b.weaponCooldowns=Array.from({length:next.weaponPorts-1},(_,port)=>port<oldPorts-1?(oldCooldowns[port]??b.cooldown):2);
          this.frameCombatTimeline?.commitWeaponChange(b);
          delete b.upgrade;this.invalidateEntityRoster(true);this.state.navigationRevision++;this.activeWorkRoster?.wakeTarget(b.id);
          for(const worker of workers){if(!worker.orders[0]?.wallTargets)worker.orders.shift();this.cancelPath(worker);this.task(worker,worker.orders.length?'moving':'idle');}
        }
        continue;
      }
      b.work=Math.min(b.required,b.work+Math.round(this.workerEfficiency(workers.length)*100*this.progression.construction(b.ownerId)));
      for(const worker of workers.slice(0,R.constructionWorkerMultipliers.length))this.committedActions.set(worker.id,{kind:'build',...committedFacing(worker,b)});
      const initial=Math.floor(def.maxHp*R.foundationStartingHpFraction),grant=initial+Math.floor((def.maxHp-initial)*b.work/b.required);b.hp+=grant-b.grantedHp;b.grantedHp=grant;
      if(this.complete(b)){this.wards.invalidate();this.activeWorkRoster?.wakeTarget(b.id);this.activeWorkRoster?.wakeDeposits();this.state.economies[b.ownerId]!.statistics.buildingsBuilt++;if(b.typeId==='monument')b.monumentCompletedTick=this.state.tick;if(b.typeId==='farm')b.foodRemaining=this.progression.farmCapacity(b.ownerId)*scale;for(const worker of workers){if(!worker.orders[0]?.wallTargets)worker.orders.shift();this.cancelPath(worker);this.task(worker,worker.orders.length?'moving':'idle');}}
    }
    for(const [id,workers]of repairers){
      const building=this.state.entities[id] as Building,def=this.progression.building(building.ownerId,building.typeId),denominator=building.repairDenominator??=building.maxHp;
      const credits=building.repairCredits??={},remainders=building.repairRemainders??={},contributions=new Map<string,number>();
      const repairCost=(ownerId:string,hp:number)=>{const cost=emptyBank(),remaining=remainders[ownerId]??emptyBank();for(const r of resources)cost[r]=Math.floor((remaining[r]+Math.round(def.cost[r]*scale*R.repairFullHpCostFraction)*hp*(denominator/building.maxHp))/denominator);return cost;};
      const affordable=(ownerId:string,hp:number)=>{const assistant=this.state.control[ownerId]?.assistant,reserve=assistant&&!workers.some(worker=>worker.ownerId===ownerId&&assistant.protectedEntityIds.includes(worker.id))?assistant.preferences.reserve:undefined;return resources.every(r=>{const cost=repairCost(ownerId,hp)[r];return cost<=Math.max(0,this.state.economies[ownerId]!.resources[r]-(cost>0?(reserve?.[r]??0)*scale:0));});};
      const effective=workers.filter(worker=>{if(affordable(worker.ownerId,1))return true;credits[worker.ownerId]=(credits[worker.ownerId]??0)%1000;this.task(worker,'blocked','INSUFFICIENT_RESOURCES');return false;});
      // Allocate the incremental efficiency curve to its actual worker's owner.
      for(let i=0;i<effective.length;i++){const contribution=this.workerEfficiency(i+1)-(i?this.workerEfficiency(i):0);contributions.set(effective[i]!.ownerId,(contributions.get(effective[i]!.ownerId)??0)+contribution);}
      for(const worker of effective.slice(0,R.constructionWorkerMultipliers.length))this.committedActions.set(worker.id,{kind:'repair',...committedFacing(worker,building)});
      for(const [ownerId,efficiency]of contributions){
        credits[ownerId]=(credits[ownerId]??0)+Math.round(R.repairHpPerWorkerSecond*1000*efficiency/R.simulationHz);
        const desired=Math.min(Math.floor(credits[ownerId]/1000),building.maxHp-building.hp);let low=0,high=desired;
        while(low<high){const middle=Math.ceil((low+high)/2);if(affordable(ownerId,middle))low=middle;else high=middle-1;}
        const hp=low;if(hp<=0)continue;
        const remaining=remainders[ownerId]??emptyBank(),cost=emptyBank(),nextRemainder=emptyBank();
        for(const r of resources){const numerator=remaining[r]+Math.round(def.cost[r]*scale*R.repairFullHpCostFraction)*hp*(denominator/building.maxHp);cost[r]=Math.floor(numerator/denominator);nextRemainder[r]=numerator%denominator;}
        if(!debit(this.state.economies[ownerId]!,cost,'repair',this.state.tick,building.id)){credits[ownerId]%=1000;for(const worker of workers)if(worker.ownerId===ownerId)this.task(worker,'blocked','INSUFFICIENT_RESOURCES');continue;}
        remainders[ownerId]=nextRemainder;credits[ownerId]-=hp*1000;if(hp<desired)credits[ownerId]%=1000;building.hp+=hp;
      }
      if(building.hp===building.maxHp)building.repairCredits={};
    }
    for(const [id,workers]of reseeders){
      const farm=this.state.entities[id] as Building;farm.reseedWork=Math.min(farm.reseedRequired!,farm.reseedWork!+100);
      if(workers[0])this.committedActions.set(workers[0].id,{kind:'build',...committedFacing(workers[0],farm)});
      if(farm.reseedWork===farm.reseedRequired){this.activeWorkRoster?.wakeTarget(farm.id);farm.foodRemaining=this.progression.farmCapacity(farm.ownerId)*scale;delete farm.reseedWork;delete farm.reseedRequired;for(const worker of workers){const authority=worker.orders[0]?.authority;worker.orders[0]={kind:'gather',targetId:farm.id,phase:'gather',...(authority?{authority:{...authority}}:{})};this.activeWorkRoster?.wake(worker.id);worker.path=[];}}
    }
    return this.workFrame.knowledge;
    }finally{this.workFrame=undefined;}
  }
  private workerEfficiency(count:number):number{return R.constructionWorkerMultipliers[Math.min(count,R.constructionWorkerMultipliers.length)-1]!;}
  private workKnowledgeForFrame():StaticKnowledgeFrame {
    const entities=this.all(),prior=this.workCoarseKnowledge;
    if(prior&&prior.revision===this.state.navigationRevision&&prior.staticRevision===this.liveStaticRevision&&prior.entities===entities&&this.perceptionWorld
      &&this.state.factions.every((faction,index)=>{
        const members=this.perceptionMembership.statics(this.visionGroup(faction.id),faction.id),known=prior.knowledge.knownStatic.get(faction.id),binding=this.liveKnowledgeBindings.get(faction.id);
        // Revealing the empty site of a destroyed remembered static invalidates
        // its binding even when the current static roster does not change.
        return prior.members[index]===members&&(!known||binding?.members===members&&binding.revision===this.liveStaticRevision&&this.knownStaticRecords.get(faction.id)?.combined===known);
      }))return prior.knowledge;
    const knowledge:StaticKnowledgeFrame={entities,knownStatic:new Map()};
    this.workCoarseKnowledge={tick:this.frameStartTick,revision:this.state.navigationRevision,staticRevision:this.liveStaticRevision,entities,members:this.state.factions.map(faction=>this.perceptionMembership.statics(this.visionGroup(faction.id),faction.id)),knowledge};
    return knowledge;
  }
  private workReachable(unit:Unit,target:Entity):boolean{
    const box=this.workBounds(target);
    if(unit.path.length||Math.hypot(Math.max(0,Math.abs(unit.xMm-target.xMm)-box.halfWidth),Math.max(0,Math.abs(unit.zMm-target.zMm)-box.halfHeight))>units[unit.typeId].collisionRadiusM*1000+1100)return false;
    // An unmaterialized plan may be crossed by an earlier queued move. Being
    // inside it is not work contact: ordinary movement must first reach an edge.
    if(target.kind==='building'&&target.pendingConstruction&&this.constructionOverlap(target,unit,0))return false;
    // Only the inaccessible factory-owned frame may certify stationary physical
    // work contact. Visibility/cargo/completion stay with their original callers.
    // Dynamic unit bodies are not part of nav().clearLine; static changes are
    // versioned, and target identity/bounds protect depletion/removal/replacement.
    const reusable=this.liveOwned&&this.coarseFrame&&this.state.entities[unit.id]===unit&&this.state.entities[target.id]===target;
    const prior=reusable?this.workReachability.get(unit):undefined;
    if(prior&&prior.revision===this.state.navigationRevision&&prior.target===target&&prior.order===unit.orders[0]&&prior.orderKind===unit.orders[0]?.kind&&prior.orderPhase===unit.orders[0]?.phase&&prior.orderRevision===unit.orderRevision&&prior.path===unit.path&&prior.unitType===unit.typeId&&prior.ownerId===unit.ownerId&&prior.research===this.state.economies[unit.ownerId]!.researchRevision&&prior.targetOwner===target.ownerId&&prior.targetType===target.typeId
      &&prior.x===unit.xMm&&prior.z===unit.zMm&&prior.targetX===target.xMm&&prior.targetZ===target.zMm&&prior.halfWidth===box.halfWidth&&prior.halfHeight===box.halfHeight&&prior.width===this.state.widthMm&&prior.height===this.state.heightMm){prior.tick=this.frameStartTick;return prior.reachable;}
    const surface={xMm:Math.max(target.xMm-box.halfWidth,Math.min(target.xMm+box.halfWidth,unit.xMm)),zMm:Math.max(target.zMm-box.halfHeight,Math.min(target.zMm+box.halfHeight,unit.zMm))};
    const reachable=this.nav().clearLine(unit,surface,0,target.id);
    if(reusable)this.workReachability.set(unit,{tick:this.frameStartTick,revision:this.state.navigationRevision,target,order:unit.orders[0],orderKind:unit.orders[0]?.kind,orderPhase:unit.orders[0]?.phase,orderRevision:unit.orderRevision,path:unit.path,unitType:unit.typeId,ownerId:unit.ownerId,research:this.state.economies[unit.ownerId]!.researchRevision,targetOwner:target.ownerId,targetType:target.typeId,x:unit.xMm,z:unit.zMm,targetX:target.xMm,targetZ:target.zMm,halfWidth:box.halfWidth,halfHeight:box.halfHeight,width:this.state.widthMm,height:this.state.heightMm,reachable});
    return reachable;
  }
  /** Work already established positive physical contact this frame. Preserve
   * its per-slice economy/actions and the ordinary movement cancellation, while
   * omitting unrelated route/formation preparation for a stationary worker. */
  private continueFrameWorkContact(unit:Unit,order:Order):boolean{
    if(!this.liveOwned||!this.coarseFrame||!this.frameDeferredKnowledge||unit.path.length||order.wallTargets||order.kind==='gather'&&order.phase==='deposit'||!['gather','build','repair','reseed'].includes(order.kind))return false;
    const prior=this.workReachability.get(unit);
    if(!prior?.reachable||prior.tick!==this.frameStartTick||prior.revision!==this.state.navigationRevision||prior.order!==order||prior.orderKind!==order.kind||prior.orderPhase!==order.phase||prior.orderRevision!==unit.orderRevision||prior.path!==unit.path||prior.unitType!==unit.typeId||prior.ownerId!==unit.ownerId||prior.research!==this.state.economies[unit.ownerId]!.researchRevision||prior.x!==unit.xMm||prior.z!==unit.zMm||prior.width!==this.state.widthMm||prior.height!==this.state.heightMm)return false;
    const target=prior.target;
    if(target.kind==='unit'||target.id!==order.targetId||this.state.entities[target.id]!==target||this.knownTarget(unit.ownerId,target.id)!==target||target.ownerId!==prior.targetOwner||target.typeId!==prior.targetType||target.xMm!==prior.targetX||target.zMm!==prior.targetZ)return false;
    if(order.kind==='gather'&&(target.kind==='resource'?target.amount<=0:target.typeId!=='farm'||(target.foodRemaining??0)<=0||target.farmerId!==unit.id)||order.kind==='build'&&(target.kind!=='building'||this.complete(target)&&!target.upgrade)||order.kind==='repair'&&(target.kind!=='building'||target.hp>=target.maxHp)||order.kind==='reseed'&&(target.kind!=='building'||!target.reseedRequired))return false;
    const bounds=this.workBounds(target);if(bounds.halfWidth!==prior.halfWidth||bounds.halfHeight!==prior.halfHeight)return false;
    this.pathScheduler.cancel(unit.id);this.frameWorkSchedulingCounts.contact++;return true;
  }
  private startReseed(farm:Building,builder:Unit):string|undefined{
    if(!this.complete(farm)||(farm.foodRemaining??0)>0||farm.demolitionTick)return 'INVALID_TARGET';
    try{if(!this.approach(builder,farm))return 'NO_PATH';}catch(cause){if(cause instanceof PathBudgetExceededError)return 'PATH_BUSY';throw cause;}
    if(farm.reseedRequired){this.setOrder(builder,{kind:'reseed',targetId:farm.id},false);return;}
    const assistant=this.state.control[farm.ownerId]?.assistant;if(this.commandSource===undefined&&assistant&&!assistant.autoReseedProtected&&!assistant.protectedEntityIds.includes(builder.id)&&resources.some(resource=>buildings.farm.reseedCost![resource]>0&&this.state.economies[farm.ownerId]!.resources[resource]<(buildings.farm.reseedCost![resource]+assistant.preferences.reserve[resource])*scale))return 'INSUFFICIENT_RESOURCES';
    const def=buildings.farm;if(!this.affordability(farm.ownerId,def.reseedCost!))return 'INSUFFICIENT_RESOURCES';
    this.spend(farm.ownerId,def.reseedCost!,1,'farm_reseed',farm.id);farm.reseedWork=0;farm.reseedRequired=def.reseedSeconds!*R.simulationHz*100;
    this.setOrder(builder,{kind:'reseed',targetId:farm.id},false);return;
  }
  /** Static memory is sufficient for pursuit, never for performing work. */
  private knownTarget(playerId:string,id:string):Entity|undefined{
    const live=this.state.entities[id];if(live&&(live.ownerId===playerId||this.visible(playerId,live)))return live;
    const memory=this.state.vision[playerId]!.memory[id];return memory&&!this.visible(playerId,memory)?memory as Entity:undefined;
  }
  private indexStaticKnowledge(frame:StaticKnowledgeFrame):boolean{
    // Native static footprints/owners change only through roster/navigation
    // invalidations. Actor motion needs no reindex for this static-only query.
    // In particular this shortcut must never certify perceptionWorld as current.
    if(this.reusableStaticKnowledge(frame.entities)){frame.staticIndexed=true;return false;}
    // Reconcile the current phase, including creations and direct fixture edits.
    // Shared groups are usable only while every recipient has the same mask.
    const masks=new Map<string,Uint8Array|undefined>();let coherent=true;
    for(const faction of this.state.factions){const key=this.visionGroup(faction.id),mask=this.visibilityMasks.get(faction.id);if(masks.has(key)&&masks.get(key)!==mask)coherent=false;masks.set(key,mask);}
    frame.staticIndexed=coherent&&this.synchronizePerception(frame.entities);
    if(frame.staticIndexed){this.perceptionMembership.commit([...masks].flatMap(([key,mask])=>mask?[{key,mask}]:[]));this.rememberStaticKnowledge(frame.entities);}
    else{frame.staticFootprints=packStaticFootprints(frame.entities,this.state.widthMm,this.state.heightMm);frame.staticMembers=this.staticMembership(frame.entities,frame.staticFootprints,this.visibilityMasks,true);}
    return frame.staticIndexed;
  }
  private knownStatic(playerId:string):Entity[]{
    let frame:StaticKnowledgeFrame|undefined=this.movementFrame??this.formationKnowledge;
    if(!frame&&this.workFrame){if(!this.workFrame.knowledge)this.workFrame.knowledge={entities:this.all(),knownStatic:new Map()};frame=this.workFrame.knowledge;}
    const cached=frame?.knownStatic.get(playerId);if(cached)return cached;
    const world=frame?.entities??this.all(),seen=this.visibilityMasks.get(playerId);
    if(frame&&frame.staticIndexed===undefined)this.indexStaticKnowledge(frame);
    const members=frame?.staticIndexed?this.perceptionMembership.statics(this.visionGroup(playerId),playerId):frame?.staticMembers?.get(playerId);
    if(frame?.staticIndexed&&members){
      const prior=this.knownStaticRecords.get(playerId),sameMembers=prior?.members===members;
      const binding=this.liveOwned?this.liveKnowledgeBindings.get(playerId):undefined;
      // Factory-owned IDs/geometry cannot be externally edited. Fog movement
      // without a membership change cannot alter these live statics or hidden
      // observations. Missing-memory revelation explicitly clears this binding.
      if(prior&&sameMembers&&binding?.members===members&&binding.revision===this.liveStaticRevision){frame.knownStatic.set(playerId,prior.combined);return prior.combined;}
      const ids=sameMembers?prior.ids:new Set(members.map(entity=>entity.id));
      let current:Entity[]|undefined=sameMembers?undefined:[...members],cursor=members.length;
      // Memory is public mutable state: reconcile its references, order and current
      // visibility even when the privately indexed current roster is unchanged.
      // Only current members suppress an observation; duplicate remembered IDs
      // retain their established occurrence order.
      const memory=this.state.vision[playerId]!.memory;
      for(const key in memory)if(Object.hasOwn(memory,key)){
        const observation=memory[key]!;
        if(ids.has(observation.id)||this.visible(playerId,observation))continue;
        if(!current&&prior!.combined[cursor]!==observation)current=prior!.combined.slice(0,cursor);
        current?.push(observation as Entity);cursor++;
      }
      current??=cursor===prior!.combined.length?prior!.combined:prior!.combined.slice(0,cursor);
      if(current.length<=KNOWN_OBSTACLE_RECORD_LIMIT)this.knownStaticRecords.set(playerId,{members,ids,combined:current});
      else this.knownStaticRecords.delete(playerId);
      if(this.liveOwned)this.liveKnowledgeBindings.set(playerId,{members,mask:seen,revision:this.liveStaticRevision});
      frame.knownStatic.set(playerId,current);return current;
    }
    const current:Entity[]=members?[...members]:[];
    if(!members)for(let index=0;index<world.length;index++){const e=world[index]!;if(e.kind!=='unit'&&(e.ownerId===playerId||(frame?visibleStatic(frame.staticFootprints!,index,seen):this.visible(playerId,e))))current.push(e);}
    const ids=new Set(current.map(e=>e.id));
    for(const memory of Object.values(this.state.vision[playerId]!.memory))if(!ids.has(memory.id)&&!this.visible(playerId,memory))current.push(memory as Entity);
    frame?.knownStatic.set(playerId,current);
    return current;
  }
  private dropoffs(unit:Unit,ordered=true):Building[]{
    const known=this.knownStatic(unit.ownerId),frame=this.movementFrame??this.workFrame?.knowledge;
    let candidates=frame?.knownBuildings?.get(unit.ownerId);
    if(!candidates){candidates=known.filter((e):e is Building=>e.kind==='building'&&buildings[e.typeId].dropOffResources.length>0);if(frame)(frame.knownBuildings??=new Map()).set(unit.ownerId,candidates);}
    // Cache only content-defined drop-off kinds/membership for this phase. Completion, owner
    // eligibility, cargo compatibility and distance still use live references.
    const eligible=candidates.filter(e=>('progress'in e?e.progress===1:this.complete(e))&&!this.hostile(unit.ownerId,e.ownerId)&&!this.state.economies[e.ownerId]!.defeated&&buildings[e.typeId].dropOffResources.includes(unit.cargo.resource!));
    return ordered?eligible.sort((a,b)=>distance(a,unit)-distance(b,unit)):eligible;
  }
  private gather(unit:Unit,order:Order):void{
    const target=this.knownTarget(unit.ownerId,order.targetId!),node=target?.kind==='resource'||(target?.kind==='building'&&target.typeId==='farm')?target:undefined;
    // Assigned static targets retain their known position, but hidden changes cannot
    // drive an automatic decision before the worker observes that location again.
    if(node&&node.ownerId!==unit.ownerId&&!this.visible(unit.ownerId,node)&&order.phase!=='deposit'&&unit.cargo.amount<(this.progression.unit(unit.ownerId,unit.typeId).carryCapacity??R.carryCapacity)*scale)return;
    if(!node){if(unit.cargo.amount){if(order.phase!=='deposit')this.cancelPath(unit);order.phase='deposit';}else{unit.orders.shift();this.cancelPath(unit);this.task(unit,'idle','RESOURCE_DEPLETED');return;}}
    const resource=node?.kind==='building'?'food':node?.resource;
    const available=node?.kind==='building'?node.foodRemaining??0:node?.amount??0;
    const capacity=(this.progression.unit(unit.ownerId,unit.typeId).carryCapacity??R.carryCapacity)*scale;
    if(unit.cargo.amount>=capacity||(!available&&unit.cargo.amount>0)){if(order.phase!=='deposit')this.cancelPath(unit);order.phase='deposit';order.planningClass='routine';}
    if(order.phase==='deposit'){
      this.task(unit,'returning');
      if(this.frameTransitDropoff(unit))return;
      if(this.liveOwned&&this.coarseFrame&&unit.path.length){if(!this.dropoffs(unit,false).length)this.task(unit,'blocked','NO_DROP_OFF');return;}
      const drops=this.dropoffs(unit);
      for(const drop of drops)if((drop.ownerId===unit.ownerId||this.visible(unit.ownerId,drop))&&this.state.entities[drop.id]&&this.workReachable(unit,drop)){
        if(unit.cargo.resource){const delta=emptyBank();delta[unit.cargo.resource]=unit.cargo.amount;if(!transact(this.state.economies[unit.ownerId]!,delta,'deposit',this.state.tick,drop.id)){this.task(unit,'blocked','RESOURCE_LIMIT');return;}}
        unit.cargo={resource:null,amount:0};order.phase='gather';delete order.dropOffId;this.cancelPath(unit);return;
      }
      if(!drops.length)this.task(unit,'blocked','NO_DROP_OFF');
      return;
    }
    if(node?.kind==='building'){
      if(node.farmerId&&node.farmerId!==unit.id){this.task(unit,'blocked','FARM_OCCUPIED');return;}
      if(node.farmerId!==unit.id)this.activeWorkRoster?.wakeTarget(node.id);node.farmerId=unit.id;
      if(available<=0){
        if(node.ownerId===unit.ownerId&&node.reseedRequired&&!this.all().some(e=>e.kind==='unit'&&e.orders[0]?.kind==='reseed'&&e.orders[0].targetId===node.id)){this.setOrder(unit,{kind:'reseed',targetId:node.id},false);return;}
        if(node.ownerId===unit.ownerId&&this.state.economies[unit.ownerId]!.autoReseed&&!node.reseedRequired){const error=this.startReseed(node,unit);if(error)this.task(unit,'blocked',error);return;}
        this.task(unit,'blocked',node.reseedRequired?'FARM_RESEEDING':'FARM_EXHAUSTED');return;
      }
    }
    if(!node||available<=0){
      if(node)this.startResourceSearch(unit,'depleted',node,30000,resource);else{unit.orders.shift();this.cancelPath(unit);this.task(unit,'idle','RESOURCE_DEPLETED');}return;
    }
    if(!this.workReachable(unit,node)){
      if(unit.path.length)this.rememberFrameWorkWait(unit,node);
      if(node.kind==='resource'&&node.forest&&!unit.path.length&&!unit.pathRequestId&&!unit.approachGoal?.point&&this.state.tick>=(unit.autoGatherAtTick??0)){
        order.forestIntentId??=node.id;this.startResourceSearch(unit,'forest',node,30000,'wood');
      }
      return;
    }
    this.task(unit,'gathering');
    const rates=this.progression.rates(unit.ownerId),rate=node.kind==='building'?rates.farm:resource==='food'?rates.forage:rates[resource!];
    this.commitGatherContact(unit,order,node,resource!,rate,capacity);
  }
  /** Candidate admission uses recipient knowledge; route proof shares the normal
   * 4000-work incremental service instead of restarting synchronous A* each tick. */
  private startResourceSearch(unit:Unit,purpose:'idle'|'depleted'|'forest',origin:Position,radiusMm:number,resource?:ResourceType):void{
    const forest=purpose!=='idle'&&'forest'in origin?origin as ResourceNode:undefined;
    const known=this.knownStatic(unit.ownerId),targetIds=forest?.forest?forestCandidates(known,forest,unit,radiusMm).map(e=>e.id):known.filter((e):e is ResourceNode=>e.kind==='resource'&&e.amount>0&&(!resource||e.resource===resource)&&distance(e,origin)<radiusMm&&(purpose!=='idle'||this.visible(unit.ownerId,e))).sort((a,b)=>distance(a,unit)-distance(b,unit)||a.id.localeCompare(b.id)).map(e=>e.id);
    if(forest?.forest){const clicked=targetIds.indexOf(forest.id);if(clicked>0){targetIds.splice(clicked,1);targetIds.unshift(forest.id);}}
    this.cancelPath(unit);unit.resourceSearch={purpose,targetIds,index:0};this.task(unit,purpose==='idle'?'idle':'blocked',purpose==='depleted'?'PATH_BUSY':undefined);if(!targetIds.length)this.advanceResourceSearch(unit);
  }
  private advanceResourceSearch(unit:Unit):void{
    const search=unit.resourceSearch!,id=search.targetIds[search.index];
    if(!id){
      if(search.purpose==='forest'){this.cancelPath(unit);unit.autoGatherAtTick=this.state.tick+R.simulationHz;this.task(unit,'blocked','NO_REACHABLE_FOREST_EDGE');return;}
      if(search.purpose==='depleted')unit.orders.shift();this.cancelPath(unit);unit.autoGatherAtTick=this.state.tick+5*R.simulationHz;this.task(unit,unit.orders.length?'moving':'idle',search.purpose==='depleted'?'RESOURCE_DEPLETED':undefined);return;
    }
    const target=this.knownTarget(unit.ownerId,id);
    if(!target||target.kind!=='resource'||target.amount<=0){search.index++;this.clearApproachPath(unit);delete unit.approachGoal;this.reservations(unit.ownerId).release(unit.id);return;}
    const result=this.pathScheduler.take(unit.id,unit.orderRevision??0);
    if(result?.status==='pending'){this.rememberFrameWorkWait(unit,target,true);return;}
    if(result?.status==='ready'){
      const order:Order=search.purpose!=='idle'?unit.orders[0]!:{kind:'gather',targetId:id,phase:'gather',planningClass:'routine'};
      if(search.purpose==='depleted')order.planningClass='routine';
      if(target.forest)order.forestIntentId??=id;
      order.targetId=id;order.phase=unit.cargo.amount>0&&unit.cargo.resource!==target.resource?'deposit':'gather';
      if(search.purpose==='idle')unit.orders.push(order);
      // Keep the proved route and stamps; ordinary movement still performs each
      // physical sweep and validates its work face against moving neighbors.
      delete unit.resourceSearch;delete unit.pathRequestId;unit.path=result.points;unit.pathRegions=result.regions;unit.lastProgressTick=this.state.tick;this.task(unit,order.phase==='deposit'?'returning':'moving');
      if(order.phase==='deposit')this.cancelPath(unit);return;
    }
    if(result?.status==='blocked'&&unit.approachGoal?.point){const goal=unit.approachGoal;(goal.failedPoints??=[]).push({...goal.point!});delete goal.point;this.clearApproachPath(unit);this.reservations(unit.ownerId).release(unit.id);}
    const point=this.approachDestination(unit,target,true);
    if(!point){search.index++;this.clearApproachPath(unit);delete unit.approachGoal;this.reservations(unit.ownerId).release(unit.id);return;}
    unit.pathRequestId=`resource_${unit.id}_${unit.orderRevision??0}_${this.state.tick}`;unit.pathDestination={...point};
    this.pathScheduler.request({id:unit.pathRequestId,unitId:unit.id,orderRevision:unit.orderRevision??0,from:{xMm:unit.xMm,zMm:unit.zMm},target:point,radiusMm:units[unit.typeId].collisionRadiusM*1000,profile:unit.ownerId,workClass:search.purpose==='forest'?(unit.orders[0]?.planningClass??'interactive'):'routine',enqueuedTick:this.state.tick});
  }
  private revalidateFormation(unit:Unit,order:Order,nav:Navigation,index:UnitSpatialIndex):boolean{
    const formation=order.formation!,revision=this.planningNavigations.get(unit.ownerId)!.revision,radius=units[unit.typeId].collisionRadiusM*1000;
    if(formation.checkedRevision===revision&&formation.retryAtTick===undefined)return true;
    if(formation.checkedRevision===revision&&this.state.tick<(formation.retryAtTick??0))return false;
    if(formation.checkedRevision!==revision)formation.searchIndex=0;formation.checkedRevision=revision;
    if(order.target&&nav.free(order.target,radius)){delete formation.retryAtTick;return true;}
    const reserved=this.owned(unit.ownerId).flatMap(entity=>entity.kind==='unit'&&entity.id!==unit.id?entity.orders.filter(other=>other.formation?.id===formation.id&&other.target).map(other=>({point:other.target!,radius:units[entity.typeId].collisionRadiusM*1000})):[]);
    const candidates:Position[]=[];
    for(let z=-16;z<=16;z++)for(let x=-16;x<=16;x++)if(x*x+z*z<=16*16)candidates.push({xMm:formation.anchor.xMm+x*1000,zMm:formation.anchor.zMm+z*1000});
    candidates.sort((a,b)=>distance(a,formation.anchor)-distance(b,formation.anchor)||distance(a,formation.center)-distance(b,formation.center)||a.zMm-b.zMm||a.xMm-b.xMm);
    let target:Position|undefined;
    try{
      const bounded=this.admissionNav(unit.ownerId);
      for(let i=formation.searchIndex??0;i<candidates.length;i++){
        const point=candidates[i]!;formation.searchIndex=i+1;
        if(!bounded.free(point,radius)||reserved.some(slot=>distance(point,slot.point)<radius+slot.radius+200)||index.withNearby(point,radius,bodies=>bodies.some(body=>body.id!==unit.id&&distance(point,body)<radius+body.radiusMm&&(this.state.entities[body.id]?.ownerId===unit.ownerId||this.visible(unit.ownerId,this.state.entities[body.id]!)))))continue;
        if(bounded.path(unit,point,radius)){target=point;break;}
      }
    }catch(cause){if(!(cause instanceof PathBudgetExceededError))throw cause;this.task(unit,'blocked','PATH_BUSY');formation.retryAtTick=this.state.tick+1;return false;}
    if(!target){this.task(unit,'blocked','PATH_BLOCKED');formation.searchIndex=0;formation.retryAtTick=this.state.tick+R.simulationHz;return false;}
    order.target={...target};delete formation.retryAtTick;delete formation.searchIndex;this.cancelPath(unit);this.task(unit,'moving');return true;
  }
  private prepareMovement(workKnowledge?:StaticKnowledgeFrame,refreshProfiles?:ReadonlySet<string>):void{
    this.prepareMovementGeometry(workKnowledge,refreshProfiles,true);
  }
  private prepareMovementGeometry(workKnowledge?:StaticKnowledgeFrame,refreshProfiles?:ReadonlySet<string>,beginLocalTick=false):void{
    const entities=this.all(),index=this.movementUnits;
    // No visibility update separates work and movement. Reuse only this tick's
    // static membership when the roster is identical; mutable eligibility and
    // obstacle geometry are still read from the live entities below.
    const knowledge=workKnowledge?.entities===entities?workKnowledge:{entities,knownStatic:new Map<string,Entity[]>()};
    this.movementFrame={...knowledge,units:index,planning:new Map()};
    // Certificates exist only in this synchronous window. Public state is freshly
    // reconciled; neither tick nor global navigation revision proves freshness.
    const owned=Simulation.movementObstacleReaders.guard.call(this)&&this.state.factions.length<=R.factionLimit&&new Set(this.state.factions.map(faction=>faction.id)).size===this.state.factions.length;
    if(!owned){this.movementObstacleCertificates.clear();this.clearMovementSources();}
    try{
      if(owned){this.movementObstaclePreparation=new Map();this.beginMovementObstacleDependencies();}
      for(const faction of this.state.factions){if(!refreshProfiles||refreshProfiles.has(faction.id))this.refreshPlanningNav(faction.id);if(beginLocalTick)this.avoidance(faction.id).beginTick(this.state.tick,Math.max(1,Math.floor(8/this.state.factions.length)),this.liveOwned&&this.coarseFrame);}
    }catch(cause){
      // Partial source/profile reconciliation cannot certify the next phase.
      this.movementObstacleCertificates.clear();this.clearMovementSources();throw cause;
    }finally{
      const active=this.movementDependencyPreparation;
      this.movementDependencyPreparation=undefined;this.movementObstaclePreparation=undefined;
      // Only newly inserted records can have failed to acquire a subscriber.
      // Existing records are pruned immediately by certificate release.
      if(active)for(const entity of active.created){const source=this.movementObstacleSources.get(entity);if(source&&!source.subscribers.size)this.removeMovementSource(entity);}
    }
  }
  /** Simplify only at route/waypoint transitions, with a fixed four-sweep bound.
   * Stay inside the route's versioned regions so later known geometry changes
   * invalidate every shortcut. Physical movement still checks current bodies. */
  private simplifyMovementRoute(unit:Unit,navigation:Navigation,radiusMm:number):void{
    if(unit.path.length<2||!unit.pathRegions?.length)return;
    for(let index=Math.min(4,unit.path.length-1);index>0;index--){
      const point=unit.path[index]!;if(distance(unit,point)>12000)continue;
      let covered=true;
      const minX=Math.max(0,Math.floor((Math.min(unit.xMm,point.xMm)-radiusMm)/16000)),maxX=Math.floor((Math.max(unit.xMm,point.xMm)+radiusMm)/16000);
      const minZ=Math.max(0,Math.floor((Math.min(unit.zMm,point.zMm)-radiusMm)/16000)),maxZ=Math.floor((Math.max(unit.zMm,point.zMm)+radiusMm)/16000);
      for(let z=minZ;covered&&z<=maxZ;z++)for(let x=minX;x<=maxX;x++)if(!unit.pathRegions.some(stamp=>stamp.region===`${x},${z}`)){covered=false;break;}
      if(covered&&navigation.clearLine(unit,point,radiusMm)){unit.path.splice(0,index);return;}
    }
  }
  private commitMovementStep(unit:Unit,order:Order,nextPoint:Position,next:Position,nav:Navigation,radius:number):void{
    const before=distance(unit,nextPoint);if(unit.xMm!==next.xMm||unit.zMm!==next.zMm)this.committedActions.set(unit.id,{kind:unit.cargo.amount>0?'carry':'move'});
    unit.xMm=next.xMm;unit.zMm=next.zMm;this.updateMovementUnit(unit);
    if(distance(unit,nextPoint)<=100){unit.path.shift();this.simplifyMovementRoute(unit,nav,radius);if(!unit.path.length)this.activeWorkRoster?.wake(unit.id);}
    if(distance(unit,nextPoint)<before-10||this.avoidance(unit.ownerId).madeProgress(unit.id)){unit.lastProgressTick=this.state.tick;delete unit.pathBlockedRevision;delete unit.pathBlockedNeighbors;}
    this.task(unit,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving');
  }
  /** Full decisions certify only stable travel. Work, engagement, transitions and
   * visibility already advanced this tick; changing any dependency wakes now. */
  private rememberMovementDecision(unit:Unit,order:Order,radius:number,speed:number,workTarget?:Entity):void{
    if(!this.liveOwned||(!this.state.movementCadenceTier&&!this.coarseFrame)||unit.engagement||Boolean(units[unit.typeId].deploySeconds)||!unit.path[0]||unit.pathRequestId||unit.pathBlockedRevision!==undefined||!['move','attack_move','patrol','gather','build','repair','reseed'].includes(order.kind))return;
    if(workTarget&&(workTarget.kind==='unit'||this.state.entities[workTarget.id]!==workTarget||this.knownTarget(unit.ownerId,workTarget.id)!==workTarget))return;
    if(!['move','attack_move','patrol'].includes(order.kind)&&(!workTarget||!unit.approachGoal?.point))return;
    const workRoute=workTarget&&this.coarseFrame&&this.frameDeferredKnowledge&&this.options.localPlanningMode==='deferred-v1'&&!order.wallTargets&&unit.approachGoal?.point
      ?{frame:this.frameStartTick,epoch:this.state.matchEpoch,x:unit.xMm,z:unit.zMm,kind:order.kind,ownerId:unit.ownerId,typeId:unit.typeId,cargo:unit.cargo.amount,resource:unit.cargo.resource,targetType:workTarget.typeId,targetOwner:workTarget.ownerId,...this.workBounds(workTarget),pointX:unit.path[0].xMm,pointZ:unit.path[0].zMm,followingX:unit.path[1]?.xMm,followingZ:unit.path[1]?.zMm,destinationX:unit.pathDestination?.xMm,destinationZ:unit.pathDestination?.zMm,approachX:unit.approachGoal.point.xMm,approachZ:unit.approachGoal.point.zMm}:undefined;
    let stagger=0;for(let index=0;index<unit.id.length;index++)stagger=(stagger*31+unit.id.charCodeAt(index))>>>0;
    this.movementDecisions.set(unit,{tick:this.state.tick,stagger,order,orderRevision:unit.orderRevision??0,phase:order.phase,targetId:order.targetId,dropOffId:order.dropOffId,
      target:order.target,targetX:order.target?.xMm,targetZ:order.target?.zMm,path:unit.path,point:unit.path[0],following:unit.path[1],length:unit.path.length,
      pathDestination:unit.pathDestination,regions:unit.pathRegions,approach:unit.approachGoal,approachPoint:unit.approachGoal?.point,
      profileRevision:this.planningNavigations.get(unit.ownerId)!.revision,physicalRevision:this.state.navigationRevision,researchRevision:this.state.economies[unit.ownerId]!.researchRevision,radius,speed,
      ...(workTarget?{workTarget,workX:workTarget.xMm,workZ:workTarget.zMm,workComplete:workTarget.kind==='building'?this.complete(workTarget):undefined,workAvailable:workTarget.kind==='resource'?workTarget.amount>0:workTarget.kind==='building'&&workTarget.typeId==='farm'?(workTarget.foodRemaining??0)>0:undefined}:{}),...(workRoute?{workRoute}:{})});
  }
  private continueMovementDecision(unit:Unit,order:Order,index:UnitSpatialIndex):false|'moved'|'pending'{
    if(!this.liveOwned||(!this.state.movementCadenceTier&&!this.coarseFrame)||unit.engagement)return false;
    const prior=this.movementDecisions.get(unit),period=this.coarseFrame?COARSE_MOVEMENT_DECISION_TICKS[this.state.movementCadenceTier]:this.state.movementCadenceTier+1;
    if(!prior)return false;
    const work=prior.workRoute,expired=this.state.tick-prior.tick>=period||(this.state.tick+prior.stagger)%period===0;
    let retainedWait=false;
    if(work&&(expired||work.frame!==this.frameStartTick)&&this.coarseFrame&&this.frameDeferredKnowledge&&this.options.localPlanningMode==='deferred-v1'&&work.epoch===this.state.matchEpoch&&work.x===unit.xMm&&work.z===unit.zMm&&this.pathScheduler instanceof RemotePathScheduler){
      const body=index.body(unit.id);
      // A stationary local wait can retain positive work-face preparation over
      // a commit boundary. All current work/visibility/occupancy guards below
      // still run; global service admissions and regional invalidation cannot
      // be hidden behind this derived certificate.
      retainedWait=Boolean(body&&this.avoidance(unit.ownerId).matchesPendingLocal(body,prior.point,unit.path[1],unit.path,unit.orderRevision??0)&&!this.pathScheduler.hasRequest(unit.id)&&(!unit.pathRegions||this.pathScheduler.isCurrent(unit.ownerId,unit.pathRegions)));
    }
    if(expired&&!retainedWait)return false;
    this.movementDecisionCounts.attempted++;
    const revision=this.planningNavigations.get(unit.ownerId)!.revision;
    if(prior.order!==order||prior.orderRevision!==(unit.orderRevision??0)||prior.phase!==order.phase||prior.targetId!==order.targetId||prior.dropOffId!==order.dropOffId
      ||prior.target!==order.target||prior.targetX!==order.target?.xMm||prior.targetZ!==order.target?.zMm||prior.path!==unit.path||prior.point!==unit.path[0]||prior.following!==unit.path[1]||prior.length!==unit.path.length
      ||prior.pathDestination!==unit.pathDestination||prior.regions!==unit.pathRegions||prior.approach!==unit.approachGoal||prior.approachPoint!==unit.approachGoal?.point
      ||prior.profileRevision!==revision||prior.physicalRevision!==this.state.navigationRevision||prior.researchRevision!==this.state.economies[unit.ownerId]!.researchRevision
      ||unit.pathRequestId||unit.pathBlockedRevision!==undefined||!canMove(unit)
      ||order.formation&&(order.formation.checkedRevision!==revision||order.formation.retryAtTick!==undefined))return false;
    // Arrivals and shortcut opportunities remain ordinary decision boundaries.
    if(distance(unit,prior.point)<=prior.speed+100||prior.following&&distance(unit,prior.following)<12000||order.target&&distance(unit,order.target)<=100)return false;
    const target=prior.workTarget;
    if(target){
      if(this.knownTarget(unit.ownerId,target.id)!==target||this.state.entities[target.id]!==target||target.xMm!==prior.workX||target.zMm!==prior.workZ
        ||target.kind==='building'&&this.complete(target)!==prior.workComplete
        ||target.kind==='resource'&&(target.amount>0)!==prior.workAvailable
        ||target.kind==='building'&&target.typeId==='farm'&&((target.foodRemaining??0)>0)!==prior.workAvailable)return false;
      // Geometry and the surface proof remain valid at the same profile version;
      // dynamic occupation/reservations are checked against current authorized state.
      const point=prior.approachPoint!;
      if(this.occupied(point,prior.radius,unit.id,unit.ownerId)||!this.reservations(unit.ownerId).available(unit.id,point,prior.radius))return false;
      if(order.phase==='deposit'&&(target.kind!=='building'||this.hostile(unit.ownerId,target.ownerId)||this.state.economies[target.ownerId]!.defeated||!buildings[target.typeId].dropOffResources.includes(unit.cargo.resource!)))return false;
    }
    const body=index.body(unit.id);if(!body)return false;
    if(work){
      // Retain only positive route/arrival preparation. All current work guards
      // run before an isolated flight can replace repeated collision queries.
      // Detours, credits and retries retain their original contact schedule.
      // Ready gathering/deposit travel can use the450/600ms decision lifetime
      // across a commit boundary. Its lifetime is never renewed here; collision
      // flights below still expire at this frame's end and are freshly proved.
      const retainedTravel=order.kind==='gather'&&!expired&&unit.path.length>0&&this.options.localPlanningMode==='deferred-v1';
      if(!target||!this.coarseFrame||!this.frameDeferredKnowledge||work.epoch!==this.state.matchEpoch||work.frame!==this.frameStartTick&&!retainedWait&&!retainedTravel||work.kind!==order.kind||work.ownerId!==unit.ownerId||work.typeId!==unit.typeId||work.cargo!==unit.cargo.amount||work.resource!==unit.cargo.resource||order.wallTargets||unit.resourceSearch||target.typeId!==work.targetType||target.ownerId!==work.targetOwner||prior.point.xMm!==work.pointX||prior.point.zMm!==work.pointZ||prior.following?.xMm!==work.followingX||prior.following?.zMm!==work.followingZ||unit.pathDestination?.xMm!==work.destinationX||unit.pathDestination?.zMm!==work.destinationZ||prior.approachPoint!.xMm!==work.approachX||prior.approachPoint!.zMm!==work.approachZ||unit.approachGoal?.revision!==revision)return false;
      const bounds=this.workBounds(target);if(bounds.halfWidth!==work.halfWidth||bounds.halfHeight!==work.halfHeight||!this.reservations(unit.ownerId).matchesClaim(unit.id,target.id,prior.radius,prior.approachPoint!))return false;
      if(order.kind==='gather'&&order.phase==='deposit'){
        if(target.kind!=='building'||target.id!==order.dropOffId||!unit.cargo.amount||!this.complete(target))return false;
      }else if(target.id!==order.targetId||order.kind==='gather'&&(target.kind==='resource'?target.amount<=0:target.kind!=='building'||target.typeId!=='farm'||(target.foodRemaining??0)<=0||target.farmerId!==unit.id)||order.kind==='build'&&(target.kind!=='building'||this.complete(target)&&!target.upgrade)||order.kind==='repair'&&(target.kind!=='building'||target.hp>=target.maxHp)||order.kind==='reseed'&&(target.kind!=='building'||!target.reseedRequired))return false;
      if(order.kind==='gather'&&this.continueFrameStraightFlight(unit,order,index,prior))return 'moved';
      const nav=this.planningNav(unit.ownerId),next=this.avoidance(unit.ownerId).step(body,prior.point,prior.speed,nav,index,this.nav(),id=>{const entity=this.state.entities[id];return Boolean(entity&&(entity.ownerId===unit.ownerId||this.visible(unit.ownerId,entity)));},unit.path[1],unit.path,true,unit.orderRevision??0);
      this.movementDecisionCounts.reused++;
      if(next){const displaced=next.xMm!==unit.xMm||next.zMm!==unit.zMm;this.commitMovementStep(unit,order,prior.point,next,nav,prior.radius);if(displaced)this.rememberFrameStraightFlight(unit,order,prior.radius,prior.speed,index,prior);return 'moved';}
      // A handled no-displacement result must not fall through into another
      // step: that would consume a second local credit or ready reply.
      this.finishFailedMovement(unit,order,index,revision);return 'pending';
    }
    const next=this.avoidance(unit.ownerId).continueStraight(body,prior.point,prior.speed,this.nav(),index,this.liveOwned&&this.coarseFrame);if(!next)return false;
    this.commitMovementStep(unit,order,prior.point,next,this.planningNav(unit.ownerId),prior.radius);this.rememberFrameStraightFlight(unit,order,prior.radius,prior.speed,index);this.movementDecisionCounts.reused++;return 'moved';
  }
  private finishFailedMovement(unit:Unit,order:Order,index:UnitSpatialIndex,profileRevision:number):void{
    if(this.avoidance(unit.ownerId).pendingLocal(unit.id)){
      this.task(unit,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving','PATH_BUSY');
    }else if(this.state.tick-(unit.lastProgressTick??this.state.tick)>=5*R.simulationHz){
      if(order.kind==='build'&&order.wallTargets&&unit.approachGoal?.point){
        const goal=unit.approachGoal;(goal.failedPoints??=[]).push({...goal.point!});delete goal.point;
        this.clearApproachPath(unit);this.reservations(unit.ownerId).release(unit.id);this.task(unit,'blocked','PATH_BLOCKED');return;
      }
      this.activeWorkRoster?.wake(unit.id);unit.path=[];this.pathScheduler.cancel(unit.id);delete unit.pathRequestId;unit.pathBlockedRevision=profileRevision;
      unit.pathBlockedNeighbors=index.withNearby(unit,8000,bodies=>bodies.filter(body=>body.id!==unit.id&&(this.state.entities[body.id]?.ownerId===unit.ownerId||this.visible(unit.ownerId,body))).map(body=>`${body.id}:${body.xMm}:${body.zMm}`).join('|'));
      this.task(unit,'blocked','PATH_BLOCKED');
    }
  }
  private prepareFrameFlightLimits():void{
    if(!this.liveOwned||!this.coarseFrame)return;
    const research=this.state.factions.map(faction=>`${faction.id}:${this.state.economies[faction.id]!.researchRevision}`).join('|');if(research===this.frameFlightResearch)return;
    let maximum=0;for(const faction of this.state.factions)for(const typeId of Object.keys(units) as UnitId[])maximum=Math.max(maximum,Math.round(this.progression.unit(faction.id,typeId).moveSpeedMps*1000/R.simulationHz));
    this.frameFlightResearch=research;this.frameFlightMaximumStep=maximum;
  }
  private rememberFrameStraightFlight(unit:Unit,order:Order,radius:number,speed:number,index:UnitSpatialIndex,work?:MovementDecision):void{
    if(!this.liveOwned||!this.coarseFrame||unit.engagement||Boolean(units[unit.typeId].deploySeconds)||unit.pathRequestId||unit.pathBlockedRevision!==undefined||!unit.path.length)return;
    if(work){
      // Work callers arrive only after a displaced ordinary step, which cleared
      // this actor's failed-direct witness, waiting/grant and local job. The
      // local proof also rejects yielding or residual detour points, so future
      // proved direct successes cannot bypass a paid retry or service result.
      if(order.kind!=='gather'||!work.workRoute||work.order!==order||work.path!==unit.path||work.point!==unit.path[0]||work.length!==unit.path.length)return;
    }else if(!['move','attack_move','patrol'].includes(order.kind)||!order.target)return;
    const profileRevision=this.planningNavigations.get(unit.ownerId)!.revision;
    if(order.formation&&(order.formation.checkedRevision!==profileRevision||order.formation.retryAtTick!==undefined))return;
    const point=unit.path[0]!,following=unit.path[1],target=order.target;
    const remaining=this.frameEndTick-this.state.tick;if(remaining<1)return;
    const body=index.body(unit.id);if(!body)return;
    // Intermediate waypoints are safe only while no ordinary slice could arrive
    // at the order target or choose its <12 m following-waypoint shortcut. The
    // corridor proof already keeps the first waypoint outside arrival distance.
    if(target&&distance(unit,target)<=100||following&&distance(unit,following)<12000)return;
    const avoidance=this.avoidance(unit.ownerId),physical=this.nav(),prepare=(steps:number)=>{
      const points=avoidance.prepareStraightFlight(body,point,speed,steps,this.frameFlightMaximumStep,physical,index);
      return points&&!points.some(next=>target&&distance(next,target)<=100||following&&distance(next,following)<12000)?points:undefined;
    };
    // Retain the original five-slice and two-slice fallbacks when a longer
    // adaptive corridor cannot be proved. Every candidate remains bounded and
    // must save at least two upcoming collision queries.
    const points=prepare(remaining)??(remaining>5?prepare(5):undefined)??(remaining>2?prepare(2):undefined);if(!points)return;
    this.frameStraightFlights.set(unit,{frame:this.frameStartTick,tick:this.state.tick,order,revision:unit.orderRevision??0,ownerId:unit.ownerId,typeId:unit.typeId,kind:order.kind,formation:order.formation,path:unit.path,length:unit.path.length,point,pointX:point.xMm,pointZ:point.zMm,following,followingX:following?.xMm,followingZ:following?.zMm,destination:unit.pathDestination,destinationX:unit.pathDestination?.xMm,destinationZ:unit.pathDestination?.zMm,regions:unit.pathRegions,target:order.target,targetX:order.target?.xMm,targetZ:order.target?.zMm,x:unit.xMm,z:unit.zMm,profileRevision,physicalRevision:this.state.navigationRevision,research:this.frameFlightResearch,topology:index.topologyVersion(),radius,points,...(work?{work}:{})});
    if(work)workFlightCounts.prepared=Math.min(Number.MAX_SAFE_INTEGER,workFlightCounts.prepared+1);
  }
  /** Only the privately owned world can certify bounded motion of other bodies.
   * Positions still commit in original actor order before each vision/combat
   * event. A new body, upgrade, gate, path or command wakes the full solver. */
  private continueFrameStraightFlight(unit:Unit,order:Order,index:UnitSpatialIndex,validatedWork?:MovementDecision):boolean{
    if(!this.liveOwned||!this.coarseFrame)return false;
    // A work flight is usable only from the fully validated work decision above;
    // the earlier general flight fast path cannot bypass live work eligibility.
    const flight=this.frameStraightFlights.get(unit);if(!flight||flight.frame!==this.frameStartTick||flight.work!==validatedWork)return false;
    const offset=this.state.tick-flight.tick-1,next=flight.points[offset],prior=offset===0?flight:flight.points[offset-1];
    if(!next||!prior||flight.order!==order||flight.kind!==order.kind||order.formation!==flight.formation||order.formation&&(order.formation.checkedRevision!==flight.profileRevision||order.formation.retryAtTick!==undefined)||unit.engagement||unit.garrisonedIn||!canMove(unit)||flight.revision!==(unit.orderRevision??0)||flight.ownerId!==unit.ownerId||flight.typeId!==unit.typeId||unit.pathRequestId||unit.pathBlockedRevision!==undefined||flight.path!==unit.path||unit.path.length!==flight.length||unit.path[0]!==flight.point||unit.path[1]!==flight.following||flight.point.xMm!==flight.pointX||flight.point.zMm!==flight.pointZ||flight.following?.xMm!==flight.followingX||flight.following?.zMm!==flight.followingZ||unit.pathDestination!==flight.destination||unit.pathDestination?.xMm!==flight.destinationX||unit.pathDestination?.zMm!==flight.destinationZ||unit.pathRegions!==flight.regions||order.target!==flight.target||order.target?.xMm!==flight.targetX||order.target?.zMm!==flight.targetZ||unit.xMm!==('x'in prior?prior.x:prior.xMm)||unit.zMm!==('z'in prior?prior.z:prior.zMm)||this.state.navigationRevision!==flight.physicalRevision||this.planningNavigations.get(unit.ownerId)!.revision!==flight.profileRevision||this.frameFlightResearch!==flight.research||index.topologyVersion()!==flight.topology)return false;
    const body=index.body(unit.id);if(!body||!this.avoidance(unit.ownerId).continueProvenStraight(body,flight.point,next))return false;
    this.commitMovementStep(unit,order,flight.point,next,this.planningNav(unit.ownerId),flight.radius);if(!validatedWork)this.movementDecisionCounts.attempted++;else workFlightCounts.used=Math.min(Number.MAX_SAFE_INTEGER,workFlightCounts.used+1);this.movementDecisionCounts.reused++;return true;
  }
  private async advanceMovementAsync(workKnowledge?:StaticKnowledgeFrame):Promise<void>{
    if(!(this.pathScheduler instanceof RemotePathScheduler)){this.advanceMovement(workKnowledge);return;}
    this.prepareMovement(workKnowledge);
    try{
      const frame=this.movementFrame!,candidates=new Map(this.state.factions.map(f=>[f.id,[] as {body:{id:string;xMm:number;zMm:number;radiusMm:number};target:Position;following?:Position;remainingPath:Position[]}[]]));
      for(const entity of frame.entities)if(entity.kind==='unit'&&entity.hp>0&&!entity.garrisonedIn&&entity.path[0]&&!this.state.economies[entity.ownerId]!.defeated&&(!this.liveOwned||this.avoidance(entity.ownerId).needsParallelQuery(entity.id)))candidates.get(entity.ownerId)!.push({body:frame.units.body(entity.id)!,target:entity.path[0],following:entity.path[1],remainingPath:entity.path});
      const queries=this.state.factions.flatMap(faction=>{const profile=this.planningNavigations.get(faction.id)!;return this.avoidance(faction.id).prepareParallelQueries(faction.id,profile.revision,candidates.get(faction.id)!,profile.navigation,frame.units,id=>{const entity=this.state.entities[id];return Boolean(entity&&(entity.ownerId===faction.id||this.visible(faction.id,entity)));});});
      this.lastPathWork=await this.pathScheduler.advanceAsync(4000,this.planningGeometries(),queries,this.state.tick);
      this.checkLiveOwnership();
      const results=this.pathScheduler.takeLocalResults();
      for(const faction of this.state.factions){const profile=this.planningNavigations.get(faction.id)!;this.avoidance(faction.id).installParallelResults(results.filter(result=>result.query.profile===faction.id),profile.navigation,profile.revision);}
      this.advanceMovement(undefined,true);
    }finally{this.movementFrame=undefined;}
  }
  private advanceMovement(workKnowledge?:StaticKnowledgeFrame,prepared=false):void{
    if(!prepared){this.prepareMovement(workKnowledge);if(this.pathScheduler instanceof RemotePathScheduler)throw new Error('ASYNC_PLANNING_REQUIRES_ASYNC_STEP');this.lastPathWork=this.pathScheduler.advance(4000,this.state.tick);}
    const {entities,units:index}=this.movementFrame!;
    try{
    const context=this.orderContext();
    for(const e of (this.coarseFrame?this.actors():entities)){
      if(e.kind!=='unit'||e.garrisonedIn||e.resourceSearch||this.state.economies[e.ownerId]!.defeated)continue;
      const engagement=e.engagement,order=engagement?{kind:'attack' as const,targetId:engagement.targetId,lastKnown:engagement.lastKnown}:e.orders[0];if(!order)continue;
      if(!engagement&&this.continueFrameWorkContact(e,order))continue;
      if(!engagement&&this.continueFrameMovementWait(e,order))continue;
      if(!engagement&&this.continueFrameStraightFlight(e,order,index))continue;
      if(this.continueMovementDecision(e,order,index))continue;
      this.movementDecisions.delete(e);this.movementDecisionCounts.full++;
      const radius=units[e.typeId].collisionRadiusM*1000,definition=this.progression.unit(e.ownerId,e.typeId),nav=this.planningNav(e.ownerId);
      const finishOrder=()=>{if(engagement)delete e.engagement;else e.orders.shift();this.cancelPath(e);this.task(e,e.orders.length?'moving':'idle');};
      if(order.kind==='attack'&&order.lastKnown&&this.visible(e.ownerId,order.lastKnown)){
        const target=this.state.entities[order.targetId!];if(!target||!this.visible(e.ownerId,target)){finishOrder();continue;}
      }
      let destination:Position|undefined,workApproach=false,workTarget:Entity|undefined;
      if(order.kind==='attack'||order.kind==='attack_ground'){
        const target=order.kind==='attack'?this.state.entities[order.targetId!]:undefined;
        if(target&&target.kind!=='resource'&&this.visible(e.ownerId,target)){
          order.lastKnown={xMm:target.xMm,zMm:target.zMm};if(engagement)engagement.lastKnown={...order.lastKnown};
          if(inAttackRange(context,e,target)&&(definition.projectileSpeedMps>0||context.meleeClear(e,target))){this.activeWorkRoster?.wake(e.id);e.path=[];this.pathScheduler.cancel(e.id);if(Boolean(units[e.typeId].deploySeconds))beginTransition(e,'deploy');continue;}
          if(engagement&&e.stance==='stand_ground'){finishOrder();continue;}
          destination=this.attackDestination(e,target);
        }else if(order.kind==='attack_ground'&&order.target){
          const range=distance(e,order.target)-radius;
          if(range>=definition.minRangeM*1000&&range<=definition.rangeM*1000){this.activeWorkRoster?.wake(e.id);e.path=[];this.pathScheduler.cancel(e.id);if(Boolean(units[e.typeId].deploySeconds))beginTransition(e,'deploy');continue;}
          destination=this.attackDestination(e,order.target);
        }else if(order.lastKnown&&!this.visible(e.ownerId,order.lastKnown)&&distance(e,order.lastKnown)>1000)destination=order.lastKnown;
        else{finishOrder();continue;}
      }else if(order.kind==='move'||order.kind==='attack_move'||order.kind==='patrol'){
        if(order.formation&&!this.revalidateFormation(e,order,nav,index))continue;
        destination=order.target;if(destination&&distance(e,destination)<=100){
          if(order.kind==='patrol'){order.pointIndex=((order.pointIndex??0)+1)%order.points!.length;order.target={...order.points![order.pointIndex]!};this.cancelPath(e);destination=order.target;}
          else{finishOrder();continue;}
        }
      }else{
        workApproach=true;
        let target=this.knownTarget(e.ownerId,order.targetId!);
        let selectedApproach:Position|undefined;
        if(order.kind==='gather'&&order.phase==='deposit'){
          const retained=this.frameTransitDropoff(e);
          const selectApproach=(drop:Building)=>{
            const point=this.approachDestination(e,drop,true);
            // This actor has already claimed the positive face. Nothing can
            // change its geometry, occupancy or reservation before the common
            // work-contact check below. Mutable/custom hooks keep every call.
            if(this.liveOwned&&this.coarseFrame&&this.frameDeferredKnowledge)selectedApproach=point;
            return point;
          };
          // Keep a pending trip pinned. Once every face fails, continue cyclically
          // through the other eligible dropoffs instead of restarting the nearest.
          if(retained&&selectApproach(retained))target=retained;
          else{
            const drops=this.dropoffs(e),pinned=drops.findIndex(drop=>drop.id===order.dropOffId),candidates=pinned<0?drops:[...drops.slice(pinned),...drops.slice(0,pinned)];
            // The retained candidate was tested while a nonempty path proved no
            // building reachable. A failed face can clear that path; do not then
            // run an arrival check earlier than the ordinary algorithm would.
            target=retained?candidates.filter(drop=>drop.id!==retained.id).find(selectApproach):drops.find(drop=>this.workReachable(e,drop))??candidates.find(selectApproach);
          }
          if(target)order.dropOffId=target.id;else{delete order.dropOffId;this.task(e,'blocked','NO_REACHABLE_DROP_OFF');}
        }
        workTarget=target;
        if(target){if(this.workReachable(e,target)){this.pathScheduler.cancel(e.id);continue;}destination=selectedApproach??this.approachDestination(e,target,true);}
        else if(order.kind==='garrison'&&order.lastKnown&&!this.visible(e.ownerId,order.lastKnown))destination=order.lastKnown;
        else if(order.kind==='garrison'){finishOrder();continue;}
        if(!destination){
          // No recipient-authorized target remains for this work leg. A ready
          // result to a destroyed drop-off is obsolete, not useful progress;
          // release it even though the ordinary take() branch cannot run here.
          // Keep the gather order and cargo so a rebuilt drop-off can resume it.
          if(!target&&(e.pathRequestId||e.path.length||e.pathDestination||e.approachGoal)){
            this.clearApproachPath(e);delete e.approachGoal;this.reservations(e.ownerId).release(e.id);
          }
          if(target)this.task(e,'blocked',order.kind==='build'&&order.wallTargets?'NO_REACHABLE_WALL_SITE':'PATH_BLOCKED');continue;
        }
      }
      if(!canMove(e)){this.pathScheduler.cancel(e.id);continue;}
      const profileRevision=this.planningNavigations.get(e.ownerId)!.revision;
      const neighborStamp=()=>index.withNearby(e,8000,bodies=>bodies.filter(body=>body.id!==e.id&&(this.state.entities[body.id]?.ownerId===e.ownerId||this.visible(e.ownerId,body))).map(body=>`${body.id}:${body.xMm}:${body.zMm}`).join('|'));
      if(e.pathBlockedRevision!==undefined&&(e.pathBlockedRevision!==profileRevision||e.pathBlockedNeighbors!==neighborStamp())){delete e.pathBlockedRevision;delete e.pathBlockedNeighbors;e.lastProgressTick=this.state.tick;e.repathAtTick=this.state.tick;}
      if(e.pathRegions&&!this.pathScheduler.isCurrent(e.ownerId,e.pathRegions)){this.activeWorkRoster?.wake(e.id);e.path=[];delete e.pathRegions;this.pathScheduler.cancel(e.id);}
      // A moving target must not repeatedly cancel useful work toward its last
      // authorized position. Refresh the endpoint when its corridor is nearly done.
      const pursuing=order.kind==='attack'||order.kind==='attack_ground';
      if(e.pathDestination&&destination&&distance(e.pathDestination,destination)>1000&&this.state.tick>=e.repathAtTick&&(!pursuing||(!e.pathRequestId&&distance(e,e.pathDestination)<=12000))){this.activeWorkRoster?.wake(e.id);e.path=[];this.pathScheduler.cancel(e.id);delete e.pathDestination;}
      const result=this.pathScheduler.take(e.id,e.orderRevision??0);
      if(result?.status==='ready'){
        const end=result.points.at(-1);
        if(workApproach&&(!destination||!end||end.xMm!==destination.xMm||end.zMm!==destination.zMm)){this.clearApproachPath(e);continue;}
        this.activeWorkRoster?.wake(e.id);e.path=result.points;e.pathRegions=result.regions;this.simplifyMovementRoute(e,nav,radius);e.lastProgressTick=this.state.tick;if(pursuing)e.repathAtTick=this.state.tick+R.simulationHz;delete e.pathRequestId;
      }else if(result?.status==='blocked'){
        if(workApproach&&e.approachGoal?.point){
          const goal=e.approachGoal,point=goal.point!;(goal.failedPoints??=[]).push({...point});delete goal.point;
          this.clearApproachPath(e);this.reservations(e.ownerId).release(e.id);this.task(e,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving');continue;
        }
        e.repathAtTick=this.state.tick+Math.min(40,5+Math.floor((this.state.tick-(e.lastProgressTick??this.state.tick))/5));delete e.pathRequestId;this.reservations(e.ownerId).release(e.id);
      }
      let requested=false;
      if(!e.path.length&&result?.status!=='pending'&&destination&&this.state.tick>=e.repathAtTick&&(e.pathBlockedRevision===undefined||e.pathBlockedRevision!==profileRevision)){
        e.pathRequestId=`path_${e.id}_${e.orderRevision??0}_${this.state.tick}`;e.pathDestination={...destination};
        this.pathScheduler.request({id:e.pathRequestId,unitId:e.id,orderRevision:e.orderRevision??0,from:{xMm:e.xMm,zMm:e.zMm},target:destination,radiusMm:radius,profile:e.ownerId,workClass:engagement?'routine':e.orders[0]?.planningClass??'interactive',enqueuedTick:this.state.tick});
        requested=true;
        if(workApproach||e.taskState!=='blocked')this.task(e,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving');
      }
      if(workApproach&&result?.status==='pending')this.task(e,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving');
      if((result?.status==='pending'||requested)&&workApproach&&workTarget){this.rememberFrameWorkFaceWait(e,order,workTarget);this.sleepPendingWork(e);}
      // A new remote request is already a pending mirror. No service result can
      // be admitted inside this frame. A validated formation uses the same
      // no-op branch as revalidateFormation until its profile or retry changes.
      if((result?.status==='pending'||requested)&&this.pathScheduler instanceof RemotePathScheduler&&!engagement&&!e.path.length&&(!order.formation||order.formation.checkedRevision===profileRevision&&order.formation.retryAtTick===undefined)&&['move','attack_move','patrol'].includes(order.kind)&&order.target&&!units[e.typeId].deploySeconds&&e.pathRequestId&&e.pathBlockedRevision===undefined&&this.coarseFrame&&this.frameDeferredKnowledge)this.frameMovementWaits.set(e,{frame:this.frameStartTick,order,revision:e.orderRevision??0,requestId:e.pathRequestId,target:order.target,x:e.xMm,z:e.zMm,targetX:order.target.xMm,targetZ:order.target.zMm,profileRevision,physicalRevision:this.state.navigationRevision,research:this.state.economies[e.ownerId]!.researchRevision,kind:order.kind,formation:order.formation,path:e.path,destination:e.pathDestination,destinationX:e.pathDestination?.xMm,destinationZ:e.pathDestination?.zMm,ownerId:e.ownerId,typeId:e.typeId});
      const point=e.path[0];if(!point){if(this.state.tick-(e.lastProgressTick??this.state.tick)>=5*R.simulationHz&&!e.pathRequestId&&result?.status!=='pending'){this.task(e,'blocked','PATH_BLOCKED');e.pathBlockedRevision=profileRevision;e.pathBlockedNeighbors=neighborStamp();}continue;}
      // Local avoidance may pass an occupied waypoint on its way to a later one.
      // Reconcile that progress even between route transitions, rather than turn
      // back toward a stale point occupied by an already-arrived unit.
      if(e.path.length>1&&distance(e,e.path[1]!)<12000&&nav.clearLine(e,e.path[1]!,radius))e.path.shift();
      const nextPoint=e.path[0]!,speed=Math.round(definition.moveSpeedMps*1000/R.simulationHz),body=index.body(e.id)??{id:e.id,xMm:e.xMm,zMm:e.zMm,radiusMm:radius};
      const next=this.avoidance(e.ownerId).step(body,nextPoint,speed,nav,index,this.nav(),id=>{const entity=this.state.entities[id];return Boolean(entity&&(entity.ownerId===e.ownerId||this.visible(e.ownerId,entity)));},e.path[1],e.path,this.liveOwned&&this.coarseFrame,e.orderRevision??0);
      if(next){
        const displaced=next.xMm!==e.xMm||next.zMm!==e.zMm;
        this.commitMovementStep(e,order,nextPoint,next,nav,radius);this.rememberMovementDecision(e,order,radius,speed,workTarget);
        if(!workTarget||displaced)this.rememberFrameStraightFlight(e,order,radius,speed,index,workTarget?this.movementDecisions.get(e):undefined);
      }else{
        this.finishFailedMovement(e,order,index,profileRevision);
        if(this.liveOwned&&workTarget&&this.coarseFrame&&this.frameDeferredKnowledge&&this.options.localPlanningMode==='deferred-v1'&&this.avoidance(e.ownerId).pendingLocal(e.id))this.rememberMovementDecision(e,order,radius,speed,workTarget);
      }
    }
    }finally{this.movementFrame=undefined;}
  }
  /** A request stays pending until a recorded boundary admission. Preserve its
   * frontier and skip unchanged travel (including validated formations). Work
   * faces require the separate current positive proof above; engagement and
   * scheduled formation retries always wake ordinary decisions. */
  private continueFrameMovementWait(unit:Unit,order:Order):boolean{
    if(!this.coarseFrame||!this.frameDeferredKnowledge||!(this.pathScheduler instanceof RemotePathScheduler))return false;
    const work=this.framePendingWorkFace(unit);
    if(work){
      if(order.kind==='gather'&&order.phase==='deposit'&&this.pendingDepositContact(unit))return false;
      this.task(unit,order.kind==='gather'&&order.phase==='deposit'?'returning':'moving');this.frameWorkSchedulingCounts.workFaceWait++;return true;
    }
    const wait=this.frameMovementWaits.get(unit);
    if(!wait||wait.frame!==this.frameStartTick||wait.order!==order||wait.kind!==order.kind||wait.revision!==(unit.orderRevision??0)||wait.requestId!==unit.pathRequestId||wait.ownerId!==unit.ownerId||wait.typeId!==unit.typeId||unit.path!==wait.path||unit.path.length||unit.pathDestination!==wait.destination||unit.pathDestination?.xMm!==wait.destinationX||unit.pathDestination?.zMm!==wait.destinationZ||unit.pathBlockedRevision!==undefined||unit.resourceSearch||order.formation!==wait.formation||order.formation&&(order.formation.checkedRevision!==wait.profileRevision||order.formation.retryAtTick!==undefined)||order.target!==wait.target||order.target.xMm!==wait.targetX||order.target.zMm!==wait.targetZ||unit.xMm!==wait.x||unit.zMm!==wait.z||this.state.navigationRevision!==wait.physicalRevision||this.planningNavigations.get(unit.ownerId)!.revision!==wait.profileRevision||this.state.economies[unit.ownerId]!.researchRevision!==wait.research)return false;
    this.frameWorkSchedulingCounts.moveWait++;return true;
  }
  private resolveDeaths(updateVision=true):boolean{
    let removed=false;
    for(const e of (this.liveOwned?this.actors():this.all()))if(e.kind==='building'&&(e.hp<=0||(e.demolitionTick!==undefined&&e.demolitionTick<=this.state.tick))){
      this.effect('death',e,e.typeId,undefined,e.id);this.state.economies[e.ownerId]!.statistics.buildingsLost++;delete this.state.entities[e.id];this.invalidateEntityRoster(true);this.state.navigationRevision++;ejectDestroyedGarrison(this.orderContext(),e);removed=true;
    }
    // Eject before the death walk so passengers earlier than their carrier in
    // the canonical roster still receive damage and cleanup in this event.
    if(this.state.rulesetId==='legendary_ages_v1')for(const host of this.phaseRoster()?.mobileHosts??(this.liveOwned?this.actors():this.all()).filter((e):e is Unit=>e.kind==='unit'&&Boolean(units[e.typeId].mobileGarrisonCapacity)))if(host.hp<=0&&host.garrisoned?.length)ejectDestroyedGarrison(this.orderContext(),host);
    for(const e of (this.liveOwned?this.actors():this.all()))if(e.kind==='unit'&&e.hp<=0){
      this.effect('death',e,e.typeId,e.garrisonedIn?e.ownerId:undefined,e.id);this.state.economies[e.ownerId]!.statistics.unitsLost++;
      if(e.cargo.resource)this.state.economies[e.ownerId]!.lostCargo[e.cargo.resource]+=e.cargo.amount;
      if(e.garrisonedIn){const building=this.state.entities[e.garrisonedIn];if(building&&building.kind!=='resource')building.garrisoned=building.garrisoned?.filter(id=>id!==e.id);}
      this.cancelPath(e);this.movementUnits.delete(e.id);delete this.state.entities[e.id];this.invalidateEntityRoster();removed=true;
    }
    if(removed){this.wards.advance(this.state,this.liveOwned?this.actors():this.all(),false,this.liveOwned?this.liveStaticRevision:undefined);if(updateVision)this.updateVision();}return removed;
  }
  private eliminate(playerId:string):void{this.wards.invalidate();this.state.economies[playerId]!.defeated=true;delete this.state.economies[playerId]!.aiResignationSinceTick;const commander=this.state.controllers[playerId]!;commander.generation++;delete commander.activeRequest;commander.pending=[];for(const e of this.owned(playerId)){if(e.kind==='building'){e.queue=[];this.updateProductionMembership(e);}if(e.kind==='unit'){e.orders=[];this.cancelPath(e);}}}
  private evaluateVictory():void{
    const survivingFactions=new Set<string>(),scouts=new Map<string,number>(),viable=new Set<string>();
    for(const faction of this.state.factions)if(faction.kind==='ai'&&!this.state.economies[faction.id]!.defeated)scouts.set(faction.id,0);
    // Fold resignation into the existing victory census. Native frames keep
    // using the retained actor roster; no resource, path or fog scan is added.
    for(const entity of (this.liveOwned?this.actors():this.all())){
      if(entity.ownerId===null||entity.hp<=0)continue;
      if(entity.kind==='unit'||entity.typeId==='town_center'&&entity.kind==='building'&&!entity.pendingConstruction)survivingFactions.add(entity.ownerId);
      if(!scouts.has(entity.ownerId)||viable.has(entity.ownerId))continue;
      if(entity.kind==='unit'){
        if(entity.typeId!=='scout')viable.add(entity.ownerId);
        else{const count=scouts.get(entity.ownerId)!+1;scouts.set(entity.ownerId,count);if(count>balance.ai.resignation.maxScouts)viable.add(entity.ownerId);}
      }else if(entity.kind==='building'){
        const definition=buildings[entity.typeId];
        // Preserve possible recovery/defense, including unfinished and planned
        // producers. Empty houses, farms, camps and unarmed walls cannot rebuild.
        if(entity.typeId==='town_center'||entity.typeId==='monument'||definition.produces.length||definition.attack>0)viable.add(entity.ownerId);
      }
    }
    for(const f of this.state.factions)if(!this.state.economies[f.id]!.defeated&&!survivingFactions.has(f.id))this.eliminate(f.id);
    if(this.state.status==='RUNNING'){
      // A viable teammate (including any human/Pilot/caretaker) protects the
      // remnant. All-remnant AI teams qualify together, avoiding mutual waits.
      const protectedTeams=new Set(this.state.factions.filter(f=>!this.state.economies[f.id]!.defeated&&(!scouts.has(f.id)||viable.has(f.id))).map(f=>f.teamId));
      const due:string[]=[],graceTicks=balance.ai.resignation.graceSeconds*R.simulationHz;
      for(const faction of this.state.factions){
        const economy=this.state.economies[faction.id]!;
        if(economy.defeated||!scouts.has(faction.id)||protectedTeams.has(faction.teamId)){delete economy.aiResignationSinceTick;continue;}
        economy.aiResignationSinceTick??=this.state.tick;
        if(this.state.tick-economy.aiResignationSinceTick>=graceTicks)due.push(faction.id);
      }
      // Decide the full batch before elimination: opposing remnants whose grace
      // expires together draw rather than granting victory by iteration order.
      for(const playerId of due)this.eliminate(playerId);
    }
    const teams=[...new Set(this.state.factions.filter(f=>!this.state.economies[f.id]!.defeated).map(f=>f.teamId))];
    if(teams.length<=1){this.finish(teams[0]??null,teams.length?'conquest':'simultaneous_elimination');return;}
    if(this.options.monumentVictory){
      const winners=new Set<string>();
      for(const e of (this.liveOwned?this.actors():this.all()))if(e.kind==='building'&&e.typeId==='monument'&&this.complete(e)&&!this.state.economies[e.ownerId]!.defeated&&(this.options.rulesetId!=='legendary_ages_v1'||this.state.economies[e.ownerId]!.age>=this.options.maxAge!)){e.monumentCompletedTick??=this.state.tick;if(this.state.tick-e.monumentCompletedTick>=R.monumentHoldSeconds*R.simulationHz)winners.add(this.state.factions.find(f=>f.id===e.ownerId)!.teamId);}
      if(winners.size)this.finish(winners.size===1?[...winners][0]!:null,winners.size===1?'monument':'simultaneous_monuments');
    }
  }
  private finish(winnerTeamId:string|null,reason:string):void{
    this.clearAiBindings('MATCH_FINISHED');
    this.state.status='FINISHED';this.state.result={winnerTeamId,reason,durationTicks:this.state.tick,statistics:this.state.factions.map(f=>{const economy=this.state.economies[f.id]!,whole=(bank:ResourceBank)=>Object.fromEntries(resources.map(r=>[r,Math.floor(bank[r]/scale)])) as ResourceBank;return {playerId:f.id,...structuredClone(economy.statistics),collected:whole(economy.collected),spent:whole(economy.spent),lostCargo:whole(economy.lostCargo)};})};
  }
  private advanceControllers():void{
    for(const faction of this.state.factions){
      if(!this.commanderEligible(faction)||this.state.economies[faction.id]!.defeated)continue;
      const cadence=balance.ai.difficulty[faction.difficulty??'medium'].tacticalIntervalSeconds*R.simulationHz,controller=this.state.controllers[faction.id]!,tacticalPulse=controllerPulse({tick:this.state.tick,playerId:faction.id,players:this.state.factions,authoritativeIntervalMs:this.options.authoritativeIntervalMs},cadence);if(!tacticalPulse&&!controller.pending.some(batch=>batch.executeTick<=this.state.tick)&&!controller.plan?.goals.some(goal=>this.state.tick>=goal.expiresTick&&!['fulfilled','rejected','expired'].includes(goal.status)))continue;
      if(this.controllerProfiler)this.controllerProfiler.commander({playerId:faction.id,tick:this.state.tick,epoch:this.state.matchEpoch,tacticalPulse,pendingDue:controller.pending.some(batch=>batch.executeTick<=this.state.tick),expiredGoal:Boolean(controller.plan?.goals.some(goal=>this.state.tick>=goal.expiresTick&&!['fulfilled','rejected','expired'].includes(goal.status)))},()=>this.advanceCommander(faction.id));
      else this.advanceCommander(faction.id);
    }
  }
  private advanceCommander(playerId:string):void {
    const profiler=this.controllerProfiler,memory=this.state.controllers[playerId]!;
    const prior=profiler?profiler.measure('priorClone',()=>structuredClone(memory)):structuredClone(memory);
    let view=profiler?profiler.measure('view',()=>this.view(playerId)):this.controllerView(playerId);const assistant=this.state.control[playerId]!.assistant,protectedIds=assistant?new Set(assistant.protectedEntityIds):undefined;if(assistant)view={...view,self:{...view.self,resources:Object.fromEntries(resources.map(resource=>[resource,Math.max(0,view.self.resources[resource]-assistant.preferences.reserve[resource])])) as ResourceBank}};profiler?.observation(view);
    const cadence=balance.ai.difficulty[this.state.factions.find(faction=>faction.id===playerId)?.difficulty??'medium'].tacticalIntervalSeconds*R.simulationHz;
    if(controllerMemoryPulse(view,cadence,R.simulationHz)){if(profiler)profiler.measure('memoryRefresh',()=>refreshAiMemory(view,memory.memory));else if(this.liveOwned)refreshOwnedAiMemory(view,memory.memory);else refreshAiMemory(view,memory.memory);}
    const decision=this.liveOwned?new AiDecisionContext(view):undefined;let proposals:AiCommandProposal[];
    try{proposals=profiler?profiler.measure('policy',()=>commanderCommands(view,memory,profiler,protectedIds,decision)):commanderCommands(view,memory,undefined,protectedIds,decision);}finally{decision?.close();}
    if(profiler)profiler.measure('admission',()=>this.admitCommanderProposals(playerId,memory,proposals));else this.admitCommanderProposals(playerId,memory,proposals);
    if(profiler)profiler.measure('journal',()=>this.recordCommanderChanges(playerId,prior,memory));else this.recordCommanderChanges(playerId,prior,memory);
  }
  private admitCommanderProposals(playerId:string,memory:CommanderState,proposals:AiCommandProposal[]):void {
      for(const proposal of proposals){if(proposal.goalKey&&proposal.planGeneration!==memory.plan?.generation)continue;let command=proposal.command;const assistant=this.state.control[playerId]!.assistant;if(assistant){const protectedIds=new Set(assistant.protectedEntityIds);if('unitIds'in command){const ids=command.unitIds.filter(id=>!protectedIds.has(id));if(!ids.length)continue;command={...command,unitIds:ids};}else if('builderIds'in command){const ids=command.builderIds.filter(id=>!protectedIds.has(id));if(!ids.length)continue;command={...command,builderIds:ids};}}memory.sequence=Math.max(memory.sequence,this.state.control[playerId]!.assistant?.sequence??this.state.economies[playerId]!.lastClientSequence)+1;const receipt=this.command(playerId,{protocolVersion:PROTOCOL_VERSION,matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,clientCommandId:`ai_${memory.generation}_${memory.sequence}`,clientSequence:memory.sequence,command},'ai');recordAiReceipt(memory.memory,receipt,proposal.goalKey);if(proposal.goalKey)applyGoalReceipt(memory,proposal.goalKey,command,receipt);else if(command.kind==='tribute'&&receipt.status==='accepted')memory.tributeCredits[`diplomat:${command.recipientId}:${command.resource}`]=(memory.tributeCredits[`diplomat:${command.recipientId}:${command.resource}`]??0)+command.amount;}
  }
  private recordCommanderChanges(playerId:string,prior:CommanderState,memory:CommanderState):void {
    this.reportAiGoalOutcomes(playerId);const patches=commanderPatches(prior,memory);if(patches.length)this.record({kind:'commander_patch',playerId,patches});
  }
  private advanceCaretakers():void {
    for(const faction of this.state.factions){
      const control=this.state.control[faction.id]!;if(control.mode!=='caretaker'||this.state.economies[faction.id]!.defeated)continue;
      const memory=control.memory;
      if(!controllerPulse({tick:this.state.tick,playerId:faction.id,players:this.state.factions,authoritativeIntervalMs:this.options.authoritativeIntervalMs},balance.ai.difficulty.medium.tacticalIntervalSeconds*R.simulationHz)&&!memory.pending.some(batch=>batch.executeTick<=this.state.tick))continue;
      for(const command of caretakerCommands(this.view(faction.id),memory)){memory.sequence=Math.max(memory.sequence,this.state.economies[faction.id]!.lastClientSequence)+1;this.command(faction.id,{protocolVersion:PROTOCOL_VERSION,matchId:this.state.matchId,matchEpoch:this.state.matchEpoch,clientCommandId:`caretaker_${control.generation}_${memory.sequence}`,clientSequence:memory.sequence,command},'caretaker');}
      this.record({kind:'caretaker_memory',playerId:faction.id,memory});
    }
  }
}
// Factory ownership is revoked permanently if a fixture/custom prototype changes.
const liveSurfaces=[...admissionHelperSurfaces.keys(),Simulation.prototype,Progression.prototype,PerceptionMembership.prototype,ObservedActionCache.prototype,RecipientProjection.prototype,PublicationUrgency.prototype,SeededRandom.prototype,VisionMaskKernel.prototype,CombatSpatialIndex.prototype,NativeCombatTimeline,NativeCombatTimeline.prototype,ActiveWorkRoster,ActiveWorkRoster.prototype].map(prototype=>({prototype,parent:Object.getPrototypeOf(prototype),descriptors:Object.getOwnPropertyDescriptors(prototype)}));
function canonicalLiveSurfaces():boolean {
  for(const {prototype,parent,descriptors} of liveSurfaces){
    if(Object.getPrototypeOf(prototype)!==parent)return false;
    const keys=Reflect.ownKeys(prototype);if(keys.length!==Reflect.ownKeys(descriptors).length)return false;
    for(const key of keys){if(typeof key!=='string')return false;const actual=Object.getOwnPropertyDescriptor(prototype,key)!,expected=descriptors[key];if(!expected||actual.value!==expected.value||actual.get!==expected.get||actual.set!==expected.set)return false;}
  }
  return true;
}
export function createLiveSimulation(options:SimulationOptions,restored?:SimulationSavePayload):LiveSimulation{return Simulation.createLive(options,restored);}
export function createSimulation(options:SimulationOptions):Simulation{return new Simulation(options);}
export const simulationHz=R.simulationHz;
export { exportSimulationSave, sealSimulationCapture, assertValidSave, validateSave, restoreSimulation, restoreLiveSimulation, simulationChecksum, replayCheckpoint, createReplayRecording, exportReplay, ReplayRunner } from './persistence.js';
