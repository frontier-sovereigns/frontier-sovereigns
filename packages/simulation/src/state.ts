import type { ClientCommandEnvelope, CommandReceipt, PublicPlayer, Position, ResourceType, ResourceBank, UnitId, BuildingId, TechnologyId, ViewEntity, Rotation, MapType, DamageType, VisualAction, VisibleEffect, ForestCell, MovementCadenceTier, AgeId, RulesetId, MaximumAge } from '@frontier/shared';
import type { CommanderState } from './ai-controller.js';
import type { GeneratedMap } from './map.js';
import type { PathSchedulerState, RegionStamp } from './path-scheduler.js';
import type { LocalAvoidance } from './movement.js';
import type { AssistantControl } from './assistant.js';
import type { CaretakerMemory } from './caretaker.js';

export interface SimulationOptions {
  factions:PublicPlayer[];seed:string|number;matchId:string;epoch?:number;secretIdKey?:string;
  authoritativeIntervalMs?:50|300;
  localPlanningMode?:'deferred-v1';
  rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';
  populationLimit?:number;sharedVision?:boolean;controllers?:boolean;mapType?:MapType;mapSize?:'auto'|'small'|'medium'|'large';monumentVictory?:boolean;caretakerEnabled?:boolean;
}
export type TaskState='idle'|'moving'|'gathering'|'returning'|'building'|'repairing'|'blocked';
export interface Order {manualOrder?:true;kind:'move'|'attack'|'attack_move'|'attack_ground'|'patrol'|'garrison'|'gather'|'build'|'repair'|'reseed';target?:Position;targetId?:string;forestIntentId?:string;planningClass?:'interactive'|'routine';phase?:'gather'|'deposit';lastKnown?:Position;dropOffId?:string;points?:Position[];pointIndex?:number;wallTargets?:string[];authority?:{kind:'caretaker';generation:number};formation?:{id:string;center:Position;anchor:Position;checkedRevision?:number;retryAtTick?:number;searchIndex?:number}}
export type DeploymentState='packed'|'deploying'|'deployed'|'packing';
interface BaseEntity extends Position {id:string;ownerId:string|null;hp:number;maxHp:number;typeId:string}
export interface WeaponWindup {launchTick:number;aim:Position;targetId?:string;orderRevision:number;from:Position;attack:AttackSnapshot}
export interface StructureUpgrade {id:string;targetTypeId:BuildingId;originalCost:ResourceBank;work:number;required:number;started:boolean}
export interface Unit extends BaseEntity {
  kind:'unit';ownerId:string;typeId:UnitId;orders:Order[];path:Position[];pathRevision:number;
  cargo:{resource:ResourceType|null;amount:number};gatherRemainder:number;cooldown:number;
  stance:'aggressive'|'defensive'|'stand_ground';repathAtTick:number;taskState?:TaskState;blockedReason?:string;
  orderRevision?:number;engagement?:{targetId:string;lastKnown:Position;anchor:Position};lastAttackerId?:string;lastDamagedTick?:number;
  deploymentState?:DeploymentState;transitionTicks?:number;transitionRequired?:number;
  desiredDeployment?:'packed'|'deployed';
  garrisonedIn?:string;garrisonHealTicks?:number;
  garrisoned?:string[];pendingUngarrison?:string[];weaponCooldowns?:number[];windup?:WeaponWindup;
  /** Missing in legacy saves means disabled until the next explicit work/move order. */
  autoGather?:boolean;autoGatherAtTick?:number;
  resourceSearch?:{purpose:'idle'|'depleted'|'forest';targetIds:string[];index:number};
  pathRegions?:RegionStamp[];pathRequestId?:string;pathDestination?:Position;lastProgressTick?:number;pathBlockedRevision?:number;pathBlockedNeighbors?:string;
  approachGoal?:{key:string;revision:number;point?:Position;retryAtTick?:number;failedPoints?:Position[]};
}
interface JobProgress {id:string;originalCost:ResourceBank;work:number;required:number;reserved:boolean;started:boolean;state:'waiting'|'active'|'population_blocked'|'exit_blocked'|'prerequisite_blocked';blockedReason?:string}
export type ProductionJob=JobProgress&({kind:'train';typeId:UnitId}|{kind:'research';typeId:TechnologyId}|{kind:'age';typeId:`age_${Exclude<AgeId,1>}`;targetAge:Exclude<AgeId,1>});
export interface Building extends BaseEntity {
  kind:'building';ownerId:string;typeId:BuildingId;rotation:Rotation;work:number;required:number;
  grantedHp:number;queue:ProductionJob[];cooldown:number;rally?:Position;demolitionTick?:number;
  foodRemaining?:number;farmerId?:string;reseedWork?:number;reseedRequired?:number;
  repairCredits?:Record<string,number>;repairRemainders?:Record<string,ResourceBank>;repairDenominator?:number;
  gateMode?:'AUTO'|'LOCKED'|'OPEN';gateOpen?:boolean;gateCloseAfterTick?:number;
  garrisoned?:string[];pendingUngarrison?:string[];monumentCompletedTick?:number;
  upgrade?:StructureUpgrade;weaponCooldowns?:number[];
  /** Paid owner-only site; not physical and grants no vision before a builder arrives. */
  pendingConstruction?:{clearanceMm:number;blocked?:boolean;retryAtTick?:number};
  ward?:{current:number;max:number;supportId:string;quietSinceTick:number;recoveryRemainder:number};
}
export interface ResourceNode extends BaseEntity {kind:'resource';ownerId:null;resource:ResourceType;amount:number;forest?:ForestCell}
export type Entity=Unit|Building|ResourceNode;
export interface LedgerEntry {tick:number;reason:string;resource:ResourceType;deltaMilli:number;balanceMilli:number;entityId?:string}
export interface Notification {id:string;tick:number;code:string;entityId?:string}
export interface FactionStatistics {unitsTrained:number;unitsLost:number;buildingsBuilt:number;buildingsLost:number;ageTicks:Record<string,number>;fallbackTicks:number;modelReadyTicks:number;inferenceFailures:number}
export interface Economy {
  resources:ResourceBank;age:number;defeated:boolean;collected:ResourceBank;spent:ResourceBank;lastClientSequence:number;
  /** Private deterministic grace timer for irrecoverable native-AI remnants. */
  aiResignationSinceTick?:number;
  autoReseed:boolean;ledger:LedgerEntry[];lostCargo:ResourceBank;notifications:Notification[];
  statistics:FactionStatistics;
  technologies:TechnologyId[];researchRevision:number;
}
export interface AttackSnapshot {attack:number;attackType:DamageType;bonusDamage:Record<string,number>;wardDepletionMultiplier?:number}
interface ProjectileBase {sourceTypeId?:UnitId;launchHeightMm?:number;id:string;ownerId:string;sourceId:string;from:Position;aim:Position;launchTick:number;hitTick:number;attack:AttackSnapshot}
export type Projectile=(ProjectileBase&{kind:'arrow';targetId:string})|(ProjectileBase&{kind:'stone';bands:{radiusM:number;multiplier:number}[]});
export interface WorldEffect extends VisibleEffect {recipients:string[]}
export interface FactionControl {mode:'human'|'disconnected'|'caretaker'|'ai';generation:number;memory:CaretakerMemory;suspendedOrders:Record<string,Order[]>;priorAutoReseed?:boolean;assistant?:AssistantControl}
export interface FinalFactionStatistics extends FactionStatistics {playerId:string;collected:ResourceBank;spent:ResourceBank;lostCargo:ResourceBank}
interface Vision {visible:number[];explored:number[];memory:Record<string,ViewEntity>;actions:Record<string,VisualAction>}
export interface SimulationState {
  rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';
  matchId:string;matchEpoch:number;tick:number;sequence:number;randomState:number;secretIdKey:string;entityNonce:number;
  /** Authoritative decision schedule, changed only by recorded boundary events. */
  movementCadenceTier:MovementCadenceTier;
  frameRevision?:number;
  status:'LOADING'|'COUNTDOWN'|'RUNNING'|'PAUSED'|'FINISHED';factions:PublicPlayer[];
  receipts:Record<string,{digest:string;tick:number;receipt:CommandReceipt}>;eventOrdinal:number;
  commandLog:{playerId:string;envelope:ClientCommandEnvelope;sequence:number;tick:number}[];
  entities:Record<string,Entity>;economies:Record<string,Economy>;vision:Record<string,Vision>;
  controllers:Record<string,CommanderState>;widthMm:number;heightMm:number;navigationRevision:number;
  control:Record<string,FactionControl>;
  map:Pick<GeneratedMap,'type'|'generatorVersion'|'terrain'|'validation'|'seed'>;
  projectiles:Projectile[];effects:WorldEffect[];ageAnnouncements:{playerId:string;age:Exclude<AgeId,1>;tick:number}[];
  navigation?:PathSchedulerState;approachReservations?:[string,{targetId:string;position:Position;radiusMm:number}][];
  pathAdmission?:Record<string,{tick:number;remaining:number;used:number}>;
  localAvoidance?:Record<string,ReturnType<LocalAvoidance['exportState']>>;
  result?:{winnerTeamId:string|null;reason:string;durationTicks:number;statistics:FinalFactionStatistics[]};
}
export type FoundationState=SimulationState;
