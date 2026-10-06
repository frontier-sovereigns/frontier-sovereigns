import type { ValidateFunction } from 'ajv';
import type {EndpointSettings,EndpointUpdateRequest,EndpointStateResponse,EndpointProbeResponse,EndpointDiagnosticsResponse,ChatRequest,PingRequest,CooperationRequest,ChatStateResponse} from './types.js';
import type { AiPlan, BootstrapRequest, ClientCommandEnvelope, ClientSocketMessage, HostRecoveryResponse, JoinRequest, LoadedRequest, LobbyConfigRequest, LobbyState, PauseRequest, PlayerView, PlayerViewDelta, ReadyRequest, RejoinInviteResponse, ReplayListResponse, ReplayOpenResponse, ReplayStepResponse, ServerSocketMessage, SessionResponse, SnapshotChunk, DeltaChunk, TeamAssignmentRequest } from './types.js';
import * as compiled from './validators.generated.js';
import type {AiModelCatalogResponse,AiModelUpsertRequest,AiModelAssignmentRequest,AssistantPreferences,AssistantStateResponse,AssistantOptionsResponse,AssistantReleaseRequest} from './types.js';
import { protect } from './validation-safety.js';
import { validViewTiming } from './view-timing.js';
export { isSafeJson, type StrictValidator } from './validation-safety.js';
export const validateClientCommand = protect(compiled.validateClientCommand as ValidateFunction<ClientCommandEnvelope>);
export const validateAiPlan = protect(compiled.validateAiPlan as ValidateFunction<AiPlan>, plan => plan.goals.every(goal => goal.kind !== 'economy' || Object.values(goal.weights).reduce((sum, n) => sum + n, 0) === 100));
export const validateJoin = protect(compiled.validateJoin as ValidateFunction<JoinRequest>);
export const validateReady = protect(compiled.validateReady as ValidateFunction<ReadyRequest>);
export const validateBootstrap = protect(compiled.validateBootstrap as ValidateFunction<BootstrapRequest>);
export const validateLoaded = protect(compiled.validateLoaded as ValidateFunction<LoadedRequest>);
export const validateLobbyConfig = protect(compiled.validateLobbyConfig as ValidateFunction<LobbyConfigRequest>);
export const validateClientSocketMessage = protect(compiled.validateClientSocketMessage as ValidateFunction<ClientSocketMessage>);
export const validateLobbyState = protect(compiled.validateLobbyState as ValidateFunction<LobbyState>);
export const validateSessionResponse = protect(compiled.validateSessionResponse as ValidateFunction<SessionResponse>);
export const validatePlayerView = protect(compiled.validatePlayerView as ValidateFunction<PlayerView>, validViewTiming, 1000000);
export const validatePlayerViewDelta=protect(compiled.validatePlayerViewDelta as ValidateFunction<PlayerViewDelta>,validViewTiming,1000000);
export const validateSnapshotChunk=protect(compiled.validateSnapshotChunk as ValidateFunction<SnapshotChunk>);
export const validateDeltaChunk=protect(compiled.validateDeltaChunk as ValidateFunction<DeltaChunk>,chunk=>chunk.sequence>chunk.baseSequence);
export const validateHostRecoveryResponse=protect(compiled.validateHostRecoveryResponse as ValidateFunction<HostRecoveryResponse>);
export const validateRejoinInviteResponse=protect(compiled.validateRejoinInviteResponse as ValidateFunction<RejoinInviteResponse>);
export const validateReplayListResponse=protect(compiled.validateReplayListResponse as ValidateFunction<ReplayListResponse>,value=>value.recordings.every(recording=>recording.endTick>=recording.startTick));
export const validateReplayOpenResponse=protect(compiled.validateReplayOpenResponse as ValidateFunction<ReplayOpenResponse>,value=>value.endTick>=value.startTick);
export const validateReplayStepResponse=protect(compiled.validateReplayStepResponse as ValidateFunction<ReplayStepResponse>,value=>value.tick>=value.startTick&&value.tick<=value.endTick&&value.view.tick===value.tick&&validViewTiming(value.view),1000000);
export const validateServerSocketMessage = protect(compiled.validateServerSocketMessage as ValidateFunction<ServerSocketMessage>,message=>message.type==='snapshot'?validViewTiming(message.view):message.type==='delta'?validViewTiming(message.delta):message.type==='delta_chunk'?message.sequence>message.baseSequence:message.type!=='communication'||validateChatStateResponse(message.state),1000000);
export const validateEmptyRequest = protect(compiled.validateEmptyRequest as ValidateFunction<Record<string, never>>);
export const validatePauseRequest = protect(compiled.validatePauseRequest as ValidateFunction<PauseRequest>);
export const validateTeamAssignmentRequest = protect(compiled.validateTeamAssignmentRequest as ValidateFunction<TeamAssignmentRequest>);
export const validateEndpointSettings=protect(compiled.validateEndpointSettings as ValidateFunction<EndpointSettings>);
export const validateEndpointUpdateRequest=protect(compiled.validateEndpointUpdateRequest as ValidateFunction<EndpointUpdateRequest>);
export const validateEndpointStateResponse=protect(compiled.validateEndpointStateResponse as ValidateFunction<EndpointStateResponse>);
export const validateEndpointProbeResponse=protect(compiled.validateEndpointProbeResponse as ValidateFunction<EndpointProbeResponse>);
export const validateEndpointDiagnosticsResponse=protect(compiled.validateEndpointDiagnosticsResponse as ValidateFunction<EndpointDiagnosticsResponse>);
export const validateHostDiagnosticsResponse=validateEndpointDiagnosticsResponse;
export const validateAiModelCatalogResponse=protect(compiled.validateAiModelCatalogResponse as ValidateFunction<AiModelCatalogResponse>);
export const validateAiModelUpsertRequest=protect(compiled.validateAiModelUpsertRequest as ValidateFunction<AiModelUpsertRequest>);
export const validateAiModelAssignmentRequest=protect(compiled.validateAiModelAssignmentRequest as ValidateFunction<AiModelAssignmentRequest>);
export const validateAssistantPreferences=protect(compiled.validateAssistantPreferences as ValidateFunction<AssistantPreferences>);
export const validateAssistantStateResponse=protect(compiled.validateAssistantStateResponse as ValidateFunction<AssistantStateResponse>);
export const validateAssistantOptionsResponse=protect(compiled.validateAssistantOptionsResponse as ValidateFunction<AssistantOptionsResponse>);
export const validateAssistantReleaseRequest=protect(compiled.validateAssistantReleaseRequest as ValidateFunction<AssistantReleaseRequest>);
export const validateChatStateResponse=protect(compiled.validateChatStateResponse as ValidateFunction<ChatStateResponse>,value=>new Set(value.messages.map(item=>item.id)).size===value.messages.length&&new Set(value.pings.map(item=>item.id)).size===value.pings.length&&value.pings.every(ping=>ping.expiresTick>=ping.tick));
export const validateChatRequest=protect(compiled.validateChatRequest as ValidateFunction<ChatRequest>);
export const validatePingRequest=protect(compiled.validatePingRequest as ValidateFunction<PingRequest>);
export const validateCooperationRequest=protect(compiled.validateCooperationRequest as ValidateFunction<CooperationRequest>);

/** Transport callers enforce their byte limit before parsing. Errors contain no submitted data. */
export function parseClientSocketMessage(text: string): ClientSocketMessage | undefined {
  if (new TextEncoder().encode(text).length > 16384) return undefined;
  try { const value: unknown = JSON.parse(text); return validateClientSocketMessage(value) ? value : undefined; } catch { return undefined; }
}
