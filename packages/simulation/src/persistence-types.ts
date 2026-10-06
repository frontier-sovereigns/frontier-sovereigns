import type { ClientCommandEnvelope, CommandReceipt, MapType, AssistantPreferences, MovementCadenceTier } from '@frontier/shared';
import type { SimulationState } from './state.js';
import type { Obstacle } from './navigation.js';
import type { PathSchedulerState } from './path-scheduler.js';
import type { ApproachReservations, LocalAvoidance } from './movement.js';
import type { CommanderState, CommanderPatch } from './ai-controller.js';
import type { CaretakerMemory } from './caretaker.js';

export interface RuntimeProfile {nodeVersion:string;platform:string;arch:string}
export interface EngineIdentity {engineBuildHash:string;runtimeProfile:RuntimeProfile}
export interface EffectiveSimulationOptions {rulesetId?:import('@frontier/shared').RulesetId;maxAge?:import('@frontier/shared').MaximumAge;startingResourcePreset?:'standard'|'long_war';authoritativeIntervalMs?:50|300;localPlanningMode?:'deferred-v1';populationLimit:80|120|200;sharedVision:boolean;controllers:boolean;monumentVictory:boolean;caretakerEnabled:boolean;seed:string|number;mapType:MapType;mapSize:'auto'|'small'|'medium'|'large'}
export type PersistedSimulationState=Omit<SimulationState,'navigation'|'approachReservations'|'localAvoidance'>;
export interface SimulationSavePayload {
  schemaVersion:1;contentHash:string;options:EffectiveSimulationOptions;state:PersistedSimulationState;
  runtime:{
    profileIds:string[];
    planningProfiles:[string,{revision:number;obstacles:[string,Obstacle][]}][];
    pathScheduler:PathSchedulerState;
    approachReservations:[string,ReturnType<ApproachReservations['exportState']>][];
    localAvoidance:[string,ReturnType<LocalAvoidance['exportState']>][];
  };
}
export interface SaveEnvelope {formatVersion:1;engineBuildHash:string;runtimeProfile:RuntimeProfile;payload:SimulationSavePayload;checksum:string}
export type CommandSource='human'|'ai'|'caretaker';
interface JournalBase {ordinal:number;tick:number;phase:'boundary'|'controllers'}
export interface PlanningStallCandidate {unitId:string;requestId:string;orderRevision:number;progressTick:number;playerId:string}
export type JournalEvent=JournalBase&(
  |{kind:'command';playerId:string;envelope:ClientCommandEnvelope;receipt:CommandReceipt;source:CommandSource}
  |{kind:'invalid_command';playerId:string;receipt:CommandReceipt}
  |{kind:'status';status:SimulationState['status']}
  |{kind:'epoch';epoch:number}
  |{kind:'movement_cadence';tier:MovementCadenceTier}
  |{kind:'planning_service_start'|'planning_service_admit';leases:number}
  |{kind:'planning_stall_recovery';proposals:PlanningStallCandidate[]}
  |{kind:'draw'}
  |{kind:'admin_surrender';playerId:string}
  |{kind:'controller_memory'|'commander_memory';playerId:string;memory:CommanderState}
  |{kind:'commander_patch';playerId:string;patches:CommanderPatch[]}
  |{kind:'caretaker_memory';playerId:string;memory:CaretakerMemory}
  |{kind:'control';playerId:string;mode:'human'|'disconnected'|'caretaker'}
  |{kind:'assistant';playerId:string;preferences:AssistantPreferences}
  |{kind:'assistant_release';playerId:string;entityIds:string[]}
  |{kind:'ai_model';playerId:string;modelId:string}
);
export type JournalAction=JournalEvent extends infer Event?Event extends JournalBase?Omit<Event,keyof JournalBase>:never:never;
export interface JournalBatch {events:JournalEvent[];gapBeforeOrdinal?:number;throughOrdinal:number}
export interface ReplayCheckpoint {tick:number;ordinal:number;checksum:string}
export interface ReplayRecording {formatVersion:1;initial:SaveEnvelope;events:JournalEvent[];checkpoints:ReplayCheckpoint[];endTick:number;endOrdinal:number;checksum:string}
export interface RestoreOptions {preserveEpoch?:boolean;newEpoch?:number;status?:SimulationState['status']}
