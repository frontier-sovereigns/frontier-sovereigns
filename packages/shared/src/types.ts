import type { TerrainRegion } from './terrain.js';
import rawBalance from '../../../data/balance.v1.json' with { type: 'json' };
/** Finite live roster ceiling: resources plus every faction's maximum units and
 * structures. Snapshot byte / JSON-work budgets remain separate boundaries. */
export const MAX_WORLD_ACTORS=rawBalance.rules.factionLimit*(Math.max(...rawBalance.rules.populationOptions)+rawBalance.rules.maxNonWallBuildingsPerPlayer+rawBalance.rules.maxWallEquivalentCellsPerPlayer);
export const MAX_WORLD_ENTITIES=rawBalance.rules.maxResourceNodes+MAX_WORLD_ACTORS;
export const PROTOCOL_VERSION = 2 as const;
export const ENGINE_VERSION = '0.1.0';
export const TEAM_IDENTITIES=Object.freeze([
  {color:'#0072f5',name:'Diagonal'},{color:'#f07800',name:'Cross'},{color:'#00b8a9',name:'Chevron'},
  {color:'#e729d9',name:'Bars'},{color:'#f6d500',name:'Saltire'},{color:'#d52b3a',name:'Dots'},
  {color:'#773de5',name:'Diamond'},{color:'#98cf20',name:'Steps'},{color:'#ececec',name:'Sun'},
  {color:'#884b20',name:'Triangle'},{color:'#ff9fcb',name:'Rings'},
].map(identity=>Object.freeze(identity)));
export type ResourceType = 'food' | 'wood' | 'gold' | 'stone';
export type MovementCadenceTier = 0 | 1 | 2 | 3;
/** Stable decision reuse only; every contact still advances on the 50ms lattice.
 * Legacy tier3 saves retain the same 600ms ceiling as the new highest coarse tier. */
export const COARSE_MOVEMENT_DECISION_TICKS = [6,9,12,12] as const;
export type PublicationIntervalMs = 100 | 150 | 200 | 300 | 450 | 600;
export type AuthoritativeIntervalMs = 50 | 300 | 450 | 600;
/** Resolved past movement only. Incomplete coverage must never authorize a chord. */
export interface MotionTrace {complete:boolean;points:{tick:number;xMm:number;zMm:number;yMm?:number}[]}
/** Recipient-authorized past poses within one committed coarse frame. */
export interface VisualTrace {complete:boolean;fromTick:number;points:{tick:number;visualAction?:VisualAction;gateOpen?:boolean}[]}
export type ResourceBank = Record<ResourceType, number>;
export type Resources = ResourceBank;
export type UnitId = 'villager' | 'scout' | 'militia' | 'spearman' | 'archer' | 'skirmisher' | 'light_cavalry' | 'knight' | 'battering_ram' | 'catapult' | 'trebuchet' | 'ironhide_ram' | 'warwolf_trebuchet' | 'rune_catapult' | 'wardbreaker_ballista' | 'colossus_ram' | 'stone_warden' | 'worldbreaker_trebuchet' | 'crown_colossus';
export type BuildingId = 'town_center' | 'house' | 'mill' | 'lumber_camp' | 'mining_camp' | 'farm' | 'barracks' | 'archery_range' | 'stable' | 'blacksmith' | 'market' | 'siege_workshop' | 'university' | 'watchtower' | 'fortress' | 'palisade_wall' | 'stone_wall' | 'wooden_gate' | 'stone_gate' | 'monument' | 'grand_citadel' | 'runic_citadel' | 'titan_citadel' | 'eternal_citadel' | 'great_siege_yard' | 'rune_forge' | 'ward_spire' | 'bastion_wall' | 'runestone_wall' | 'titan_wall' | 'eternal_wall' | 'bastion_gate' | 'runestone_gate' | 'titan_gate' | 'eternal_gate';
export type TechnologyId = 'forestry_1' | 'forestry_2' | 'forestry_3' | 'mining_1' | 'mining_2' | 'wheelbarrow' | 'hand_cart' | 'farming_1' | 'farming_2' | 'forging_1' | 'forging_2' | 'forging_3' | 'fletching_1' | 'fletching_2' | 'fletching_3' | 'melee_armor_1' | 'melee_armor_2' | 'melee_armor_3' | 'ranged_armor_1' | 'ranged_armor_2' | 'ranged_armor_3' | 'veteran_militia' | 'elite_militia' | 'veteran_spearman' | 'elite_spearman' | 'veteran_archer' | 'elite_archer' | 'elite_knight' | 'masonry' | 'royal_muster' | 'citadel_engineering' | 'guild_stewardship' | 'runebound_arms' | 'runic_engineering' | 'runic_husbandry' | 'titanforged_arms' | 'colossal_engineering' | 'great_estates' | 'oath_of_eternity' | 'eternal_engineering' | 'eternal_stewardship';
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Personality = 'builder' | 'raider' | 'marshal' | 'steward' | 'diplomat';
export type MapType = 'open_frontier' | 'river_divide';
export type MatchStatus = 'SETUP' | 'LOBBY' | 'LOADING' | 'COUNTDOWN' | 'RUNNING' | 'PAUSED' | 'FINISHED' | 'ARCHIVED';
export interface Position { xMm: number; zMm: number }
export interface Cell { x: number; z: number }
export type Rotation = 0 | 90 | 180 | 270;
export type AgeId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type RulesetId = 'classic_v1' | 'legendary_ages_v1';
export type MaximumAge = 4 | 5 | 6 | 7 | 8;
export type WallMaterial = 'palisade' | 'stone' | 'bastion' | 'runestone' | 'titan' | 'eternal';
export type AgeJobId = `age_${Exclude<AgeId, 1>}`;
export type VisualTier = 'base' | 'veteran' | 'elite';
export interface VisualAction {kind:'idle'|'move'|'attack'|'gather_food'|'gather_wood'|'mine'|'build'|'repair'|'carry';startedTick:number;durationTicks?:number;facingMilliRad?:number}
export interface VisibleEffect extends Position {id:string;tick:number;kind:'impact'|'hit'|'death';projectileKind?:'arrow'|'stone';typeId?:string;entityId?:string;ownerId?:string;visualAge?:AgeId;visualTier?:VisualTier;rotation?:Rotation}
type DistinctKinds<T extends { kind: string }> = { [K in T['kind']]: Omit<T, 'kind'> & { kind: K } }[T['kind']];
export type GameplayCommand =
  | DistinctKinds<{ kind: 'move' | 'attack_move' | 'attack_ground'; unitIds: string[]; target: Position; queued: boolean }>
  | DistinctKinds<{ kind: 'attack_target' | 'gather' | 'repair' | 'garrison'; unitIds: string[]; targetId: string; queued: boolean }>
  | DistinctKinds<{ kind: 'stop' | 'hold_position' | 'deploy' | 'pack'; unitIds: string[] }>
  | { kind: 'patrol'; unitIds: string[]; points: Position[]; queued: boolean }
  | { kind: 'build'; builderIds: string[]; buildingType: Exclude<BuildingId, 'palisade_wall' | 'stone_wall' | 'bastion_wall' | 'runestone_wall' | 'titan_wall' | 'eternal_wall'>; originCell: Cell; rotation: Rotation; queued: boolean }
  | { kind: 'build_wall'; builderIds: string[]; material: WallMaterial; cells: Cell[]; queued: boolean }
  | { kind: 'replace_wall_with_gate'; builderIds: string[]; wallIds: string[]; queued: boolean }
  | { kind: 'upgrade_structure'; buildingIds: string[]; targetTypeId: BuildingId }
  | { kind: 'continue_build'; builderIds: string[]; foundationId: string; queued: boolean }
  | { kind: 'train'; buildingId: string; unitType: UnitId; quantity: number }
  | { kind: 'research'; buildingId: string; technologyId: TechnologyId }
  | { kind: 'advance_age'; townCenterId: string; targetAge: Exclude<AgeId, 1> }
  | { kind: 'cancel_job'; buildingId: string; jobId: string }
  | { kind: 'cancel_foundation'; foundationId: string }
  | { kind: 'demolish'; buildingId: string }
  | { kind: 'set_gate_mode'; gateId: string; mode: 'AUTO' | 'LOCKED' | 'OPEN' }
  | { kind: 'set_stance'; unitIds: string[]; stance: 'aggressive' | 'defensive' | 'stand_ground' }
  | { kind: 'ungarrison'; buildingId: string; unitIds: string[] }
  | { kind: 'set_rally'; buildingId: string; target: Position }
  | { kind: 'reseed_farm'; farmId: string; builderId: string }
  | { kind: 'set_auto_reseed'; enabled: boolean }
  | { kind: 'market_trade'; marketId: string; side: 'buy' | 'sell'; resource: Exclude<ResourceType, 'gold'>; lots: number }
  | { kind: 'tribute'; recipientId: string; resource: ResourceType; amount: number }
  | { kind: 'surrender' };
export interface ClientCommandEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  matchId: string;
  matchEpoch: number;
  clientCommandId: string;
  clientSequence: number;
  command: GameplayCommand;
}
export type ClientCommand = ClientCommandEnvelope;
export interface CommandReceipt { status: 'accepted' | 'rejected'; clientCommandId: string; code?: string; tick: number; sequence: number; missingResources?:ResourceBank }
export interface PublicPlayer {
  id: string; name: string; teamId: string; color: string; kind: 'human' | 'ai';
  hostPlayer?: boolean; ready?: boolean; connected?: boolean;
  difficulty?: Difficulty; personality?: Personality;
  defeated?: boolean;
  age?:AgeId;
  pattern?:number;
  controlMode?:'human'|'disconnected'|'caretaker'|'ai';
  aiMode?:'model'|'fallback';
  aiModelId?:string;
  assistant?:{modelId:string|null;enabled:boolean};
}
export interface LobbyPlayer extends PublicPlayer { hostPlayer: boolean; ready: boolean; connected: boolean }
export interface LobbySettings { aiCount: number; mapType: MapType; populationLimit: 80 | 120 | 200; sharedVision: boolean;monumentVictory?:boolean;caretakerEnabled?:boolean;mapSize?:'auto'|'small'|'medium'|'large';rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';pauseWhenNoHumans?:boolean;teamPreset?:'custom'|'free_for_all'|'five_vs_five'|'six_vs_five';tutorial?:boolean }
export interface LobbyState { status: MatchStatus; players: LobbyPlayer[]; settings: LobbySettings; canStart: boolean; inviteCode?: string;hostSeed?:string|null;pauseReason?:'host'|'no_humans'|'overload';pauseRequests?:{playerId:string;timestamp:number}[] }
export interface SessionResponse { protocolVersion: typeof PROTOCOL_VERSION; contentHash: string; csrfToken: string | null; host: boolean; playerId?: string; lobby: LobbyState }
export type SessionInfo = SessionResponse;
export type ViewJob = {
  id:string;progress:number;state:'waiting'|'active'|'population_blocked'|'exit_blocked'|'prerequisite_blocked';started?:boolean;blockedReason?:string;
} & ({kind:'train';typeId:UnitId}|{kind:'research';typeId:TechnologyId}|{kind:'age';typeId:AgeJobId});
export interface FinalFactionStatistics {playerId:string;collected:ResourceBank;spent:ResourceBank;lostCargo:ResourceBank;unitsTrained:number;unitsLost:number;buildingsBuilt:number;buildingsLost:number;ageTicks:Record<string,number>;fallbackTicks:number;modelReadyTicks:number;inferenceFailures:number}
/** Disclosed only with its observed tree; no patch extent or member roster. */
export interface ForestCell {patchId:string;cellMm:number}
/** A recipient-authorized object. Never put enemy orders, cargo or queues here. */
export interface ViewEntity extends Position {
  upgrade?:{jobId:string;targetTypeId:BuildingId;progress:number;started:boolean;state:'waiting'|'active'};
  ward?:{current:number;max:number;supportId?:string};weaponCooldowns?:number[];ammoAffordable?:boolean;
  windup?:{remainingTicks:number;aim?:Position};
  motionTrace?:MotionTrace;
  visualTrace?:VisualTrace;
  id: string; kind: 'unit' | 'building' | 'resource'; typeId: string; ownerId: string | null;
  hp: number; maxHp: number; progress?: number; resource?: ResourceType; amount?: number;
  /** Owner-only reservation on explored ground; no active foundation exists yet. */
  pendingConstruction?: boolean;
  forest?:ForestCell;forestIntentId?:string;workTargetId?:string;
  cargo?: { resource: ResourceType | null; amount: number }; order?: string; queue?: ViewJob[];
  ghost?: boolean; rotation?: Rotation; stance?: string; gateMode?: 'AUTO' | 'LOCKED' | 'OPEN';
  gateOpen?: boolean; garrisoned?: string[];
  visualAge?:AgeId;visualTier?:VisualTier;visualAction?:VisualAction;
  garrisonedIn?:string;deploymentState?:'packed'|'deploying'|'deployed'|'packing';deploymentProgress?:number;lastSeenTick?:number;
  rally?:Position;
  taskState?:'idle'|'moving'|'gathering'|'returning'|'building'|'repairing'|'blocked';
  queuedOrderCount?:number;blockedReason?:string;farmState?:'ready'|'exhausted'|'reseeding';farmerAssigned?:boolean;reseedProgress?:number;demolitionTicksRemaining?:number;
}
export interface PlayerView {
  rulesetId?:RulesetId;maxAge?:MaximumAge;startingResourcePreset?:'standard'|'long_war';
  protocolVersion: typeof PROTOCOL_VERSION; contentHash: string; matchId: string; matchEpoch: number;
  tick: number; sequence: number; playerId: string; status: 'LOADING' | 'COUNTDOWN' | 'RUNNING' | 'PAUSED' | 'FINISHED';
  committedTimeMs?:number;frameRevision?:number;authoritativeIntervalMs?:AuthoritativeIntervalMs;
  /** Host wall-clock pacing for rendering only; absent means normal speed. */
  simulationSpeed?: number;
  /** Routine pose interval in game milliseconds; absent means 100 ms. */
  publicationIntervalMs?: PublicationIntervalMs;
  map: { widthMm: number; heightMm: number; fogCellMm: number;type?:MapType;generatorVersion?:string;terrain?:TerrainRegion[] };
  self: { lastCommandSequence:number;resources: ResourceBank; age: number; population: number; populationCap: number; populationLimit:80|120|200; reservedPopulation: number; technologies?: TechnologyId[];autoReseed?:boolean;idleWorkers?:number;incomePerMinute?:ResourceBank;
    notifications?:{id:string;tick:number;code:string;entityId?:string}[];
    recentLedger?:{tick:number;reason:string;resource:ResourceType;deltaMilli:number;balanceMilli:number;entityId?:string}[];
  };
  players: PublicPlayer[]; entities: ViewEntity[];
  fog: { visible: number[]; explored: number[] };
  projectiles?:{id:string;kind:'arrow'|'stone';xMm:number;zMm:number;yMm:number;motionTrace?:MotionTrace;sourceTypeId?:UnitId;impactWarning?:{xMm:number;zMm:number;radiusMm:number;hitTick:number}}[];
  effects?:VisibleEffect[];
  monuments?:{id:string;ownerId:string;xMm:number;zMm:number;remainingTicks:number}[];
  ageAnnouncements?:{playerId:string;age:Exclude<AgeId,1>;tick:number}[];
  result?: { winnerTeamId: string | null; reason: string;durationTicks?:number;statistics?:FinalFactionStatistics[] };
}
/** All fields originate in recipient-filtered views. Updates replace the entire authorized entity. */
export type PlayerViewDelta = Omit<PlayerView,'entities'|'fog'> & {
  baseSequence:number;creates:ViewEntity[];updates:ViewEntity[];conceals:string[];removals:string[];
  fog:{visibleAdded:number[];visibleRemoved:number[];exploredAdded:number[]};
};
export interface SnapshotChunk {
  type:'snapshot_chunk';transferId:string;protocolVersion:typeof PROTOCOL_VERSION;contentHash:string;
  matchId:string;matchEpoch:number;playerId:string;sequence:number;index:number;count:number;byteLength:number;sha256:string;data:string;
}
/** A bounded replacement delta, applied only against its exact completed base. */
export interface DeltaChunk extends Omit<SnapshotChunk,'type'> {type:'delta_chunk';baseSequence:number}
export interface JoinRequest { name: string; inviteCode: string; hostPlayer?: boolean }
export interface ReadyRequest { ready: boolean }
export interface BootstrapRequest { token: string }
export interface PauseRequest { paused: boolean }
export interface TeamAssignmentRequest { playerId:string;teamId:string }
export interface SaveSummary {id:string;kind:'auto'|'manual';label:string;createdAt:string;tick:number;bytes:number}
export interface HostRecoveryResponse {
  saves:SaveSummary[];warnings:{id:string;code:string}[];persistence:{lastSave?:SaveSummary;lastError?:string;journalHealthy:boolean};
  disconnected:{playerId:string;seconds:number;decisionRequired:boolean;mode:'grace'|'reserved'|'caretaker'}[];
  restoreSlots:{playerId:string;name:string;hostPlayer:boolean;claimed:boolean}[];pauseRequests?:{playerId:string;timestamp:number}[];
}
export interface RejoinInviteResponse {playerId:string;token:string;expiresAt:number}
export interface ReplaySummary {id:string;createdAt:string;startTick:number;endTick:number;endOrdinal:number;bytes:number}
export interface ReplayListResponse {recordings:ReplaySummary[];warnings:{id:string;code:string}[]}
export interface ReplayOpenResponse {replayId:string;startTick:number;endTick:number;players:PublicPlayer[]}
export interface ReplayStepResponse {replayId:string;startTick:number;endTick:number;tick:number;done:boolean;view:PlayerView}
export interface LoadedRequest { contentHash: string; matchId: string; matchEpoch: number }
export type LobbyConfigRequest = Partial<LobbySettings>;
export type ClientSocketMessage = ClientCommandEnvelope | { type: 'resync' } | ({ type: 'loaded' } & LoadedRequest);
export type ServerSocketMessage = {type:'command_received';commandId:string;sequence:number} | { type: 'snapshot'; view: PlayerView } | {type:'delta';delta:PlayerViewDelta} | SnapshotChunk | DeltaChunk | { type: 'lobby'; lobby: LobbyState } | { type: 'receipt'; receipt: CommandReceipt } | { type: 'error'; code: string } | {type:'communication';state:ChatStateResponse};
export interface EndpointSettings {
  baseUrl:string;model:string;providerProfile:'generic_openai_compatible'|'llama_cpp'|'vllm';timeoutSeconds:number;maxConcurrent:number;inputTokenBudget:number;maxOutputTokens:number;
  intervalSeconds:{easy:number;medium:number;hard:number};maxAdaptiveIntervalSeconds:number;temperature:number;sendHumanChat:boolean;
  providerOptions:{top_p?:number;top_k?:number;min_p?:number;repeat_penalty?:number;repetition_penalty?:number;presence_penalty?:number;frequency_penalty?:number;seed?:number;chat_template_kwargs?:{enable_thinking:boolean};reasoning_effort?:'none'|'low'|'medium'|'high'};
}
export interface EndpointUpdateRequest {settings:EndpointSettings;apiKey?:string|null}
/** prompt_json requests JSON through instructions only; it does not claim provider
 * constrained decoding. Every returned plan still requires full host validation. */
export type EndpointMode='unprobed'|'schema'|'json_object'|'prompt_json';
export interface EndpointStateResponse {settings:EndpointSettings;hasApiKey:boolean;configured:boolean;capability:{mode:EndpointMode;status:string;checkedAt?:number}}
/** Normal player choices contain no endpoint URL, provider options or credentials. */
export interface AiModelChoice {id:string;label:string;available:boolean}
/** Host-only catalog metadata. API keys are write-only and never returned. */
export interface HostAiModelEntry extends EndpointStateResponse {id:string;label:string;enabled:boolean}
export interface AiModelCatalogResponse {models:HostAiModelEntry[]}
export interface AiModelUpsertRequest {id?:string;label:string;enabled:boolean;settings:EndpointSettings;apiKey?:string|null}
export interface AiModelAssignmentRequest {playerId:string;modelId:string}
export interface AssistantPreferences {modelId:string|null;enabled:boolean;reserve:ResourceBank}
export interface AssistantStateResponse {preferences:AssistantPreferences;status:'manual'|'model'|'fallback'|'paused'|'unavailable';protectedEntityIds:string[]}
export interface AssistantOptionsResponse {models:AiModelChoice[];assistant:AssistantStateResponse}
export interface AssistantReleaseRequest {entityIds:string[]}
export interface EndpointProbeResponse {success:boolean;status:string;mode:EndpointMode;schemaStatus:string;modelsStatus:string;roundTripMs:number}
export interface MetricPercentiles {p50:number;p95:number;p99?:number;max:number}
export type CommittedUnitActionKind=Exclude<VisualAction['kind'],'idle'>;
/** Host-only evidence for one complete simulation minute, never a player snapshot. */
export interface SimulationActivityWindow {
  matchId:string;matchEpoch:number;fromTick:number;toTick:number;
  actionTicks:Partial<Record<CommittedUnitActionKind,number>>;
  factions:{playerId:string;uniqueActiveUnits:number;activeSurvivingUnits:number;survivingUnits:number;actionTicks:Partial<Record<CommittedUnitActionKind,number>>;depositedMilli:ResourceBank}[];
}
/** Redacted operational state, returned only by the authenticated host diagnostics endpoint. */
export interface ComputeWorkerLane {
  mode:'threads'|'inline';threadIds:number[];pending:number;recoveries:number;degraded:boolean;
}
/** Bounded host-only callback evidence; durations share the worker's clock. */
export interface WorkerCallbackSummary {
  operation:string;tick:number|null;endTick:number|null;epoch:number|null;
  durationMs:number;gapBeforeMs:number|null;
  phasesMs:{commandDrain:number;coreStep:number;activityProjection:number;viewAssemblyPost:number;journalCheckpoint:number;other:number};
}
export interface WorkerRuntimeSummary {
  historyLimit:16;callbackCount:number;boundaryYields:number;
  recentCallbacks:WorkerCallbackSummary[];
  lastOverload:null|{tick:number;epoch:number;debtMs:number;boundaryQueued:number;pendingCommands:number;
    precedingCallbacks:WorkerCallbackSummary[];precedingAdvancingCallbacks:WorkerCallbackSummary[]};
}
export interface AiRenewalDiagnostics {
  estimateSource:'joint_queue_to_acceptance';samples:number;warmup:boolean;
  commanders:{playerId:string;leadMs:number|null;remainingPlanTicks:number|null;estimatedDeadlineFeasible:boolean|null;nextDueInMs:number}[];
}
export type AiRequestStage='preparation'|'endpoint'|'application';
export interface AiStageDiagnostics {samples:number;durationMs:MetricPercentiles;failures:number;timeouts:number}
export const SIMULATION_FRAME_PHASES=['total','production','controllers','gates','engagement','observedActions','work','movement','navigationPreparation','planning','planningAdmission','planningService','perception','combat','trace'] as const;
/** Host-only elapsed phase costs; movement includes nested navigation costs. */
export interface SimulationFrameDiagnostics {
  frameRevision:number;committedTimeMs:number;authoritativeIntervalMs:AuthoritativeIntervalMs;
  phases:Partial<Record<typeof SIMULATION_FRAME_PHASES[number],number>>;
  /** Host-only aggregate queue evidence; route hints are not physical progress. */
  localPlanning?:{mode:'deferred-v1';waitingForCredit:number;queued:number;inflight:number;ready:number;retry:number;oldestWaitMs:number;prepared:number;admitted:number;used:number;discarded:number};
}
export interface SimulationDiagnostics {
  tick:number;tickMs:MetricPercentiles;debtMs:number;overrunWarning:boolean;status?:MatchStatus;
  callbackMs?:MetricPercentiles;callbackSamples?:number;
  /** Sum of exclusive coordinator costs between successive advances; includes
   * separate publication/RPC/checkpoint and planner-return work, not idle gaps. */
  cycleMs?:MetricPercentiles;cycleSamples?:number;
  frame?:SimulationFrameDiagnostics;
  pacing?:{authoritativeIntervalMs?:AuthoritativeIntervalMs;policy:'adaptive'|'pause';speedPercent:number;tickIntervalMs:number;reductions:number;recoveries?:number;memoryRecoveryBlocked?:boolean;lastRecovery?:null|{tick:number;fromPercent:number;toPercent:number};selfPaced:boolean;deferredWallMs:number;lastReduction:null|{tick:number;fromPercent:number;toPercent:number;debtMs:number};movementTier?:MovementCadenceTier;movementDecisionIntervalMs?:50|100|150|200|300|450|600;publicationIntervalMs?:PublicationIntervalMs;tierChanges?:number;lastTierChange?:null|{tick:number;fromTier:MovementCadenceTier;toTier:MovementCadenceTier;reason:'sustained_overload'|'headroom'|'recovery_failed'}};
  movementDecisions?:{full:number;reused:number;attempted:number};
  path?:{work:number;pending:number;ready:number;blocked:number;regionCount:number;cacheHits:number}|null;
  world?:{units:number;population:number;resourceNodes:number;activeResourceNodes?:number;nonnegativeResources:boolean;factions:{playerId:string;kind:'human'|'ai';age:number;defeated:boolean;units:number;population:number;nonWallBuildings:number;wallEquivalentCells:number;statistics:Pick<FinalFactionStatistics,'unitsTrained'|'unitsLost'|'buildingsBuilt'|'buildingsLost'|'ageTicks'|'fallbackTicks'|'modelReadyTicks'|'inferenceFailures'>;collected:ResourceBank}[]};
  activity?:{movingSinceLastSample:number;gathering:number;returning:number;building:number;repairing:number;blocked:number;attackCooldownActive:number;sampledTicks:number};
  activityWindow?:SimulationActivityWindow;
  memory?:{rss:number;heapTotal:number;heapUsed:number;external:number;arrayBuffers:number};
  compute?:{planning:ComputeWorkerLane;vision:ComputeWorkerLane;boundaryQueued:number};
  runtime?:WorkerRuntimeSummary;
}
/** Host-only publication progress. Socket callbacks do not prove browser receipt. */
export interface PublicationDeliveryDiagnostics {
  scope:'gateway_publication_socket_callbacks';
  channels:{channelId:number;playerId:string|null;offeredViews:number;completedViews:number;offeredSequence:number|null;completedSequence:number|null;
    offerAgeMs:number|null;lastWriteAgeMs:number|null;completedAgeMs:number|null;maxOfferIntervalMs:number|null;maxCompletedIntervalMs:number|null;
    pendingSocketWrites:number;oldestSocketWriteMs:number|null;lastSocketCallbackMs:number|null;maxSocketCallbackMs:number|null;bufferedBytes:number;
    lastLongGap:{at:number;stage:'offer'|'completion'|'socket_callback';durationMs:number}|null}[];
}
export interface EndpointDiagnosticsResponse {
  endpoint:{configured:boolean;mode:EndpointMode;status:string};
  scheduler:{recentFailures?:{playerId:string;code:string;at:number;stage?:AiRequestStage}[];stages?:Record<AiRequestStage,AiStageDiagnostics>;renewal?:AiRenewalDiagnostics;active:number;pending:number;concurrency:number;circuit:'closed'|'open'|'half_open';retryAfterMs:number;consecutiveFailures:number;completed:number;failed:number;latencyMs:MetricPercentiles;queueDelayMs:MetricPercentiles;promptTokens:number|null;completionTokens:number|null;prefillMs:number|null;generationMs:number|null;usageTotals?:{reportedRequests:number;missingUsageRequests:number;promptTokens:number;completionTokens:number;totalTokens:number};commanders:{playerId:string;mode:'model'|'fallback';inFlight:boolean;pending:boolean;intervalSeconds:number;lastStatus:string;lastLatencyMs:number|null;lastAcceptedAt?:number|null;requests?:{completed:number;failed:number;queueSamples:number;queueDelayMs:MetricPercentiles;stages:Record<AiRequestStage,AiStageDiagnostics>}}[]};
  simulation:SimulationDiagnostics|null;process:{rssMiB:number;eventLoopDelayMs?:MetricPercentiles};
  compute?:{publication:ComputeWorkerLane};
  publicationDelivery?:PublicationDeliveryDiagnostics;
  /** Current open connections only. Reconnect resets totals; rates use a fixed
   * ten-second denominator with one-second buckets, including during warm-up. */
  transport?:{scope:'websocket_application_payload_enqueued';windowMs:10000;clients:{playerId:string|null;connections:number;totalBytes:number;bytesPerSecond:number}[]};
}
export type HostDiagnosticsResponse=EndpointDiagnosticsResponse;
export interface ChatMessage {id:string;tick:number;senderId:string;channel:'all'|'team';text:string;source:'human'|'model'|'system';requestId?:string;targetAiId?:string;status?:'requested'|'planned'|'completed'|'declined'|'blocked'|'expired'}
export interface TeamPing extends Position {id:string;tick:number;senderId:string;category:'attack'|'defend'|'resource'|'help';expiresTick:number}
export interface ChatStateResponse {messages:ChatMessage[];pings:TeamPing[];sendHumanChat:boolean}
export interface ChatRequest {text:string;channel:'all'|'team';targetAiId?:string}
export interface PingRequest extends Position {category:TeamPing['category']}
export type CooperationRequest = {targetAiId:string}&({action:'defend_base'}|{action:'attack_ping';pingId:string}|{action:'tribute';resource:ResourceType;amount:number});
export type AiGoal =
  | { kind: 'economy'; weights: ResourceBank; targetVillagers: number }
  | { kind: 'ensure_building'; buildingType: Exclude<BuildingId, `${string}_wall` | `${string}_gate`>; targetCount: number; anchorRef: string }
  | { kind: 'ensure_units'; unitType: UnitId; targetCount: number }
  | { kind: 'research'; technologyId: TechnologyId }
  | { kind: 'advance_age'; targetAge: Exclude<AgeId, 1> }
  | { kind: 'develop'; targetAge: Exclude<AgeId, 1>; anchorRef: string }
  | { kind: 'army_order'; squadRef: string; order: 'defend' | 'attack' | 'raid' | 'assist' | 'retreat' | 'rally'; targetRef: string }
  | { kind: 'scout'; zoneRef: string }
  | { kind: 'fortify'; anchorRef: string; material: WallMaterial; radiusM: number }
  | { kind: 'tribute'; allyRef: string; resource: ResourceType; amount: number };
export interface AiPlan { schemaVersion: 1; observationId: string; strategy: string; goals: AiGoal[]; message: { recipientRef: string; text: string } | null }
