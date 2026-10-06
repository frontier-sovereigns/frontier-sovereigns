import Fastify, { LogController, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { sealSimulationCapture, assertValidSave } from '@frontier/simulation';
import type { SaveEnvelope, SimulationSavePayload } from '../../../packages/simulation/src/persistence-types.js';
import {
  balance, contentHash, assetCatalogContentHash, resolveRuleset, PROTOCOL_VERSION, validateClientCommand, validateJoin, validateReady, validateBootstrap,
  validateEndpointUpdateRequest, validateChatRequest, validatePingRequest, validateCooperationRequest, type ChatMessage, type ChatStateResponse, type TeamPing,
  validateLobbyConfig, validateLobbyState, validateTeamAssignmentRequest, TEAM_IDENTITIES, type LobbyPlayer, type LobbyState, type LobbySettings, type PlayerView, type Difficulty, type Personality,
  validateAiModelUpsertRequest, validateAiModelAssignmentRequest, validateAssistantPreferences, validateAssistantReleaseRequest,
  type AssistantPreferences, type AssistantOptionsResponse, type AssistantStateResponse,
} from '@frontier/shared';
import { SimulationBridge } from './bridge.js';
import type { OverloadPolicy } from './simulation-pacing.js';
import { ViewPublisher } from './view-publisher.js';
import { PublicationWorker, ThreadedViewPublisher } from './publication-pool.js';
import { createWorkerPreparedViewScope, inspectWorkerViewJson, inspectWorkerPublicationJson, workerPublicationProjection, type WorkerViewTransfer } from './worker-view-channel.js';
import { MeteredTransport, TRANSPORT_WINDOW_MS } from './transport-metrics.js';
import { IsolateRuntimeDiagnostics, PerformanceDiagnostics } from './performance-diagnostics.js';
import { SaveStore, type SaveSummary } from './save-store.js';
import { engineIdentity } from './build-info.js';
import { ReplayStore } from './replay-store.js';
import { EndpointConfiguration } from './ai-endpoint.js';
import { AiModelCatalog } from './ai-model-catalog.js';
import { AiModelScheduler } from './ai-model-scheduler.js';
import type { AiChatRequest } from '../../../packages/simulation/src/ai-observation.js';

const token = () => randomBytes(32).toString('base64url');
const equals = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const loopback = (ip: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
const loopbackOrigin = (origin: string | undefined) => typeof origin === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin);
interface Session { id: string; csrf: string; host: boolean; playerId?: string; expires: number }
export interface ServerOptions { port?: number; bind?: string; lan?: boolean; allowedOrigins?: string[]; bootstrapToken?: string; logger?: boolean; staticRoot?: string; requireStaticAssets?: boolean; dataDir?: string; clock?: () => number; policyIntervalMs?: number; performanceDiagnostics?: boolean;
  /** Host-only pacing policy. Qualification explicitly selects strict pause. */
  overloadPolicy?: OverloadPolicy;
  authoritativeIntervalMs?:50|300;
  /** Private experiment selector. Retained JSON remains the default; never configured by browser requests. */
  publicationPreparation?: 'json' | 'owned' | 'fog';
  /** Independent Node snapshot-codec selector. Native is default; no browser setting. */
  snapshotEncoding?: 'portable' | 'native';
  /** Default production encoding runs on a persistent worker; false retains the inline QA control. */
  publicationThread?: boolean;
  /** Trusted in-process QA callbacks only; never configured over HTTP or sent to observers. */
  inspectPublishedViewJson?: (text: string, playerId: string) => void;
  inspectOutboundFrame?: (text: string, playerId: string | undefined, host: boolean) => void;
}
const colors = TEAM_IDENTITIES.map(identity => identity.color);
interface ServerSavePayload { game: SaveEnvelope; lobby: { settings: LobbySettings; players: LobbyPlayer[]; hostSeed: string | null } }
/** A listing-only rejection hint for our canonical writer's header. Never
 * certifies integrity or accepts a save: compatible/unrecognized headers take
 * the full validation path, and explicit loads/retention always bypass this. */
export function saveListingCompatibilityWarning(prefix: string): string | undefined {
  const match = /^\{"formatVersion":1,"id":"(?:auto|manual)_[0-9]{13}_[a-f0-9]{16}","kind":"(?:auto|manual)","label":"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*","createdAt":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z","tick":(?:0|[1-9][0-9]*),"payload":\{"game":\{"formatVersion":1,"engineBuildHash":"([a-f0-9]{64})","runtimeProfile":\{/.exec(prefix);
  return match && match[1] !== engineIdentity.engineBuildHash ? 'ENGINE_VERSION_MISMATCH' : undefined;
}
function validateServerSave(value: unknown): value is ServerSavePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'game,lobby') return false;
  const save = value as ServerSavePayload, lobby = save.lobby;
  if (!lobby || typeof lobby !== 'object' || Array.isArray(lobby) || Object.keys(lobby).sort().join(',') !== 'hostSeed,players,settings'
    || !validateLobbyState({ status: 'PAUSED', ...lobby, canStart: false })) return false;
  // SaveStore owns this parsed/local envelope. Check it fully without allocating
  // a detached snapshot solely for these synchronous lobby comparisons.
  assertValidSave(save.game, engineIdentity);
  const game = save.game.payload, factions = game.state.factions;
  const lobbyContent = resolveRuleset(lobby.settings.rulesetId, lobby.settings.maxAge, lobby.settings.startingResourcePreset);
  const gameContent = resolveRuleset(game.options.rulesetId, game.options.maxAge, game.options.startingResourcePreset);
  if (!!lobby.settings.tutorial !== (game.options.controllers === false)
    || lobby.settings.tutorial && (factions.length !== 2 || lobby.players.filter(p => p.kind === 'human' && p.hostPlayer).length !== 1 || lobby.settings.aiCount !== 1)) return false;
  if (lobby.players.length !== factions.length || new Set(lobby.players.map(player => player.id)).size !== factions.length
    || lobby.players.filter(player => player.kind === 'human' && !player.hostPlayer).length > 5 || lobby.players.filter(player => player.hostPlayer).length > 1
    || lobby.players.filter(player => player.kind === 'ai').length !== lobby.settings.aiCount) return false;
  for (const player of lobby.players) {
    const faction = factions.find(faction => faction.id === player.id);
    if (!faction || ['name', 'teamId', 'kind', 'color', 'pattern', 'hostPlayer', 'difficulty', 'personality'].some(key => (player as unknown as Record<string, unknown>)[key] !== (faction as unknown as Record<string, unknown>)[key])) return false;
    if ((player.aiModelId ?? 'host') !== (faction.aiModelId ?? 'host') || (player.assistant?.modelId ?? null) !== (faction.assistant?.modelId ?? null) || (player.assistant?.enabled ?? false) !== (faction.assistant?.enabled ?? false)) return false;
  }
  return lobby.settings.populationLimit === game.options.populationLimit && lobby.settings.mapType === game.options.mapType
    && (lobby.settings.mapSize ?? 'auto') === game.options.mapSize && lobby.settings.sharedVision === game.options.sharedVision
    && (lobby.settings.monumentVictory ?? false) === game.options.monumentVictory && (lobby.settings.caretakerEnabled ?? false) === game.options.caretakerEnabled
    && lobbyContent.contentHash === gameContent.contentHash;
}

/** Verify the installed production payload before advertising readiness or starting timers. */
async function verifyProductionAssets(directory: string): Promise<void> {
  try {
    const root = await realpath(directory), rootStat = await lstat(directory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error();
    const read = async (path: string, limit: number) => {
      if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.startsWith('//') || path.split('/').some(part => part === '..' || part === '.')) throw new Error();
      const file = resolve(root, path.slice(1)), actual = await realpath(file), child = relative(root, actual), stat = await lstat(file);
      if (!child || child.startsWith('..') || isAbsolute(child) || !stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) throw new Error();
      const bytes = await readFile(file); if (!bytes.length || bytes.length > limit) throw new Error(); return bytes;
    };
    const html = (await read('/index.html', 1024 * 1024)).toString('utf8');
    const references = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]!);
    if (references.length > 256 || !references.some(path => path.endsWith('.js')) || !references.some(path => path.endsWith('.css')) || references.some(path => !path.startsWith('/assets/'))) throw new Error();
    for (const path of new Set(references)) await read(path, 32 * 1024 * 1024);
    const manifest = JSON.parse((await read('/asset-manifest.json', 1024 * 1024)).toString('utf8'));
    if (!manifest || manifest.schemaVersion !== 2 || manifest.contentHash !== contentHash || manifest.catalogContentHash !== assetCatalogContentHash || manifest.status !== 'GENERATED_ORIGINAL_ASSETS'
      || !Array.isArray(manifest.catalog) || !manifest.catalog.length || manifest.catalog.length > 1024
      || !Array.isArray(manifest.ui) || !manifest.ui.length || manifest.ui.length > 1024 || !Array.isArray(manifest.audio) || !manifest.audio.length || manifest.audio.length > 1024) throw new Error();
    const assets = [manifest.bundle, ...manifest.ui, ...manifest.audio], seen = new Set<string>(); let total = 0;
    for (const asset of assets) {
      if (!asset || typeof asset.path !== 'string' || !asset.path.startsWith('/art/') || seen.has(asset.path)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 64 * 1024 * 1024 || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error();
      seen.add(asset.path); total += asset.bytes; if (total > 256 * 1024 * 1024) throw new Error();
      const bytes = await read(asset.path, asset.bytes);
      if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error();
    }
  } catch { throw new Error('PRODUCTION_ASSETS_INVALID'); }
}

export async function createGameServer(options: ServerOptions = {}) {
  const performanceMetrics = options.performanceDiagnostics === true ? new PerformanceDiagnostics() : undefined;
  if (options.publicationPreparation !== undefined && !['json', 'owned', 'fog'].includes(options.publicationPreparation)) throw new Error('INVALID_PUBLICATION_PREPARATION');
  const fogTransfer = options.publicationPreparation === 'fog';
  const ownedPreparation = options.publicationPreparation === 'owned' || fogTransfer;
  const snapshotEncoding = options.snapshotEncoding ?? 'native';
  if (snapshotEncoding !== 'portable' && snapshotEncoding !== 'native') throw new Error('INVALID_SNAPSHOT_ENCODING');
  const publicationSetting = process.env.FRONTIER_PUBLICATION_WORKER ?? '1';
  if (options.publicationThread === undefined && !['0', '1'].includes(publicationSetting)) throw new Error('INVALID_PUBLICATION_WORKER_SETTING');
  const publicationThread = options.publicationThread ?? publicationSetting === '1';
  const projectionTransfer = publicationThread && !ownedPreparation;
  const overloadPolicy = options.overloadPolicy ?? process.env.FRONTIER_OVERLOAD_POLICY ?? 'adaptive';
  if (overloadPolicy !== 'adaptive' && overloadPolicy !== 'pause') throw new Error('INVALID_OVERLOAD_POLICY');
  const publicationScope = ownedPreparation || snapshotEncoding === 'native' ? (options?:{visualTraces?:boolean}) => createWorkerPreparedViewScope({ ...options, snapshotEncoding }) : undefined;
  const createBridge = () => new SimulationBridge({ performanceDiagnostics: !!performanceMetrics, fogTransfer, projectionTransfer, overloadPolicy, authoritativeIntervalMs:options.authoritativeIntervalMs });
  const staticRoot = resolve(options.staticRoot ?? 'apps/client/dist');
  if (options.requireStaticAssets) await verifyProductionAssets(staticRoot);
  const clockNow = options.clock ?? Date.now;
  const port = options.port ?? 3000;
  const origins = new Set(options.allowedOrigins ?? []);
  origins.add(`http://127.0.0.1:${port}`); origins.add(`http://localhost:${port}`);
  origins.add(`http://[::1]:${port}`);
  if (options.lan) for (const group of Object.values(networkInterfaces())) for (const info of group ?? []) if (info.family === 'IPv4') origins.add(`http://${info.address}:${port}`);
  const app = Fastify({ bodyLimit: 16384, trustProxy: false, logger: options.logger ? {
    redact: ['req.headers.cookie', 'req.headers.authorization', 'req.body', 'res.headers.set-cookie'],
  } : false, logController: new LogController({ disableRequestLogging: true }) });
  await app.register(cookie);
  const bootstrapToken = options.bootstrapToken || token();
  const bootstrapExpires = clockNow() + 10 * 60_000;
  let bootstrapped = false;
  let inviteCode = randomBytes(9).toString('base64url');
  let status: LobbyState['status'] = 'SETUP';
  const settings: LobbySettings = { aiCount: 1, mapType: 'open_frontier', mapSize: 'auto', rulesetId: 'legendary_ages_v1', maxAge: 8, populationLimit: 120, sharedVision: true, monumentVictory: false, startingResourcePreset: 'long_war', teamPreset: 'custom', caretakerEnabled: false, pauseWhenNoHumans: process.env.GAME_PAUSE_WHEN_NO_HUMANS !== 'false' };
  const aiTeams = new Map<string, string>();
  const aiConfiguration = new Map<string, { difficulty: Difficulty; personality: Personality; pattern: number; modelId?:string }>();
  const assistantPreferences = new Map<string, AssistantPreferences>();
  const assistantChanges = new Set<string>();
  const defaultAssistant = ():AssistantPreferences => ({modelId:null,enabled:false,reserve:{food:0,wood:0,gold:0,stone:0}});
  let hostSeed: string | null = null;
  let humans: LobbyPlayer[] = [];
  const sessions = new Map<string, Session>();
  const sockets = new Map<WebSocket, Session>();
  const publishers = new Map<WebSocket, ViewPublisher | ThreadedViewPublisher>();
  const transports = new Map<WebSocket, MeteredTransport>();
  const disconnected = new Map<string, { since: number; mode: 'grace' | 'reserved' | 'caretaker'; decisionRequired: boolean; decided: boolean }>();
  const pauseRequests = new Map<string, number>();
  let pauseReason: 'host' | 'no_humans' | 'overload' | undefined;
  let noHumansSince: number | undefined;
  let policyBusy = false, pauseBusy = false;
  const dataDirectory = resolve(options.dataDir ?? process.env.GAME_DATA_DIR ?? 'runtime-data');
  const endpoint = new EndpointConfiguration(dataDirectory); await endpoint.load();
  const modelCatalog = new AiModelCatalog(dataDirectory, endpoint); await modelCatalog.load();
  // Boot reports configuration only. Availability is unknown until an explicit
  // probe or a match request; never return settings or credentials for logging.
  const loadedEndpoint = endpoint.state();
  const startupEndpoint = Object.freeze({ configured: loadedEndpoint.configured, mode: loadedEndpoint.capability.mode, status: loadedEndpoint.capability.status });
  const publicationWorker = publicationThread ? new PublicationWorker({ snapshotEncoding }) : undefined;
  const scheduler = new AiModelScheduler(modelCatalog);if(performanceMetrics)scheduler.enableRenewalDiagnostics();
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 }); eventLoopDelay.enable();
  const isolateMetrics = performanceMetrics ? new IsolateRuntimeDiagnostics('gateway') : undefined;
  const aiTimer = setInterval(() => { void scheduler.poll().then(() => {
    communicationTick = scheduler.currentTick(communicationTick); let changed = false;
    for (let index = pings.length - 1; index >= 0; index--) if (pings[index]!.expiresTick <= communicationTick) { pings.splice(index, 1); changed = true; }
    for (const [requestId, request] of chatRequests) if (communicationTick - request.tick > 90 * balance.rules.simulationHz) { aiMessage(request.targetAiId, { recipientId: request.senderId, requestId, text: 'This request expired before completion.', status: 'expired' }); }
    if (changed) broadcastCommunication();
  }); }, 250); aiTimer.unref();
  let endpointBusy = false;
  let communicationTick = 0;
  const messages: ChatMessage[] = [], pings: TeamPing[] = [];
  const chatRequests = new Map<string, { senderId: string; targetAiId: string; tick: number; preset: boolean }>();
  const saveStore = new SaveStore<ServerSavePayload>(resolve(dataDirectory, 'saves'), validateServerSave, undefined, saveListingCompatibilityWarning);
  const replayDirectory = resolve(dataDirectory, 'replays'), replayLibrary = new ReplayStore(replayDirectory, engineIdentity);
  const journals = new Map<SimulationBridge, { store: ReplayStore; started?: Promise<unknown>; finishing?: Promise<void>; sealed: boolean }>();
  let replayViewer: { bridge: SimulationBridge; id: string } | undefined, replayBusy = false;
  const restoreSlots = new Map<string, { playerId: string; name: string; hostPlayer: boolean; claimed: boolean }>();
  const rejoinInvites = new Map<string, { playerId: string; expiresAt: number; matchId: string; epoch: number }>();
  let lastSave: SaveSummary | undefined, persistenceError: string | undefined;
  let saveBusy = false, pendingAutosave: ServerSavePayload | undefined;
  const persistence = new Set<Promise<SaveSummary>>();
  let journalHealthy = false;
  let restoreBusy = false, restoreEpoch: number | undefined;
  const rates = new Map<string, { tokens: number; time: number }>();
  let bridge: SimulationBridge | undefined;
  let matchId = '';
  let epoch = 1;
  const loaded = new Set<string>();
  let loadingTimer: NodeJS.Timeout | undefined;
  let countdownTimer: NodeJS.Timeout | undefined;
  function rate(key: string, capacity = 60, perSecond = 30) {
    const now = clockNow(); const prior = rates.get(key) ?? { tokens: capacity, time: now };
    prior.tokens = Math.min(capacity, prior.tokens + (now - prior.time) / 1000 * perSecond); prior.time = now;
    const allowed = prior.tokens >= 1; if (allowed) prior.tokens--; rates.set(key, prior); return allowed;
  }
  const cleanup = setInterval(() => {
    const now = clockNow();
    for (const [key, item] of rates) if (now - item.time > 120000) rates.delete(key);
    for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id);
    for (const [socket, session] of sockets) if (session.expires < now) socket.close(4001, 'SESSION_EXPIRED');
  }, 30000);
  cleanup.unref();
  function sessionFor(request: FastifyRequest): Session | undefined {
    const session = sessions.get(request.cookies.fs_session ?? '');
    return session && session.expires > clockNow() ? session : undefined;
  }
  function syncAiConfiguration() {
    const active = new Set(Array.from({ length: settings.aiCount }, (_, i) => `ai_${i + 1}`));
    for (const id of aiConfiguration.keys()) if (!active.has(id)) { aiConfiguration.delete(id); aiTeams.delete(id); }
    const used = new Set([...humans.map(player => player.pattern!), ...[...aiConfiguration.values()].map(config => config.pattern)]);
    for (let i = 0; i < settings.aiCount; i++) {
      const id = `ai_${i + 1}`;
      if (!aiConfiguration.has(id)) { const pattern = used.has(i + 6) ? colors.findIndex((_, index) => !used.has(index)) : i + 6; used.add(pattern); aiConfiguration.set(id, { difficulty: 'easy', personality: balance.ai.personalities[i] as Personality, pattern }); }
    }
  }
  syncAiConfiguration();
  function aiPlayers(): LobbyPlayer[] { return Array.from({ length: settings.aiCount }, (_, i) => { const id = `ai_${i + 1}`, config = aiConfiguration.get(id)!; return { id, name: ['Alder','Kestrel','Rowan','Flint','Mira'][i]!, teamId: aiTeams.get(id) ?? `team_ai_${i + 1}`, color: colors[config.pattern]!, pattern: config.pattern, kind: 'ai', hostPlayer: false, ready: true, connected: true, difficulty: config.difficulty, personality: config.personality, aiModelId:config.modelId??'host' }; }); }
  function applyTeamPreset() {
    if (settings.teamPreset === 'custom') return;
    const grouped = settings.teamPreset === 'five_vs_five' || settings.teamPreset === 'six_vs_five';
    for (const player of humans) player.teamId = grouped ? 'team_humans' : `team_${player.id}`;
    for (const player of aiPlayers()) aiTeams.set(player.id, grouped ? 'team_commanders' : `team_${player.id}`);
  }
  function presetReady(): boolean {
    if (settings.tutorial) return settings.aiCount === 1 && humans.length === 1 && humans[0]!.hostPlayer;
    if (settings.teamPreset === 'five_vs_five') return settings.aiCount === 5 && humans.length === 5;
    if (settings.teamPreset === 'six_vs_five') return settings.aiCount === 5 && humans.filter(player => !player.hostPlayer).length === 5 && humans.filter(player => player.hostPlayer).length === 1;
    return true;
  }
  function lobby(host = false): LobbyState {
    const players: LobbyPlayer[] = [...humans.map(player => ({ ...player, controlMode: disconnected.get(player.id)?.mode === 'caretaker' ? 'caretaker' as const : disconnected.has(player.id) ? 'disconnected' as const : 'human' as const })), ...aiPlayers().map(player => ({ ...player, controlMode: 'ai' as const }))];
    return { status, settings: { ...settings }, players: structuredClone(players), canStart: status === 'LOBBY' && presetReady() && players.length >= 2 && new Set(players.map(player => player.teamId)).size >= 2 && humans.every(p => p.ready && p.connected), ...(pauseReason ? { pauseReason } : {}), ...(host ? { inviteCode, hostSeed, pauseRequests: [...pauseRequests].map(([playerId, timestamp]) => ({ playerId, timestamp })) } : {}) };
  }
  function send(socket: WebSocket, value: unknown) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(4008, 'SLOW_CLIENT_RECONNECT'); return; }
    transports.get(socket)?.send(JSON.stringify(value));
  }
  function transportDiagnostics() {
    const clients = new Map<string | null, { playerId: string | null; connections: number; totalBytes: number; bytesPerSecond: number }>();
    for (const [socket, session] of sockets) {
      if (socket.readyState !== WebSocket.OPEN || session.playerId && !humans.some(player => player.id === session.playerId)) continue;
      const metrics = transports.get(socket)?.snapshot(); if (!metrics) continue;
      const playerId = session.playerId ?? null, row = clients.get(playerId) ?? { playerId, connections: 0, totalBytes: 0, bytesPerSecond: 0 };
      row.connections++; row.totalBytes = Math.min(Number.MAX_SAFE_INTEGER, row.totalBytes + metrics.totalBytes);
      row.bytesPerSecond = Math.min(Number.MAX_SAFE_INTEGER, row.bytesPerSecond + metrics.bytesPerSecond); clients.set(playerId, row);
    }
    return { scope: 'websocket_application_payload_enqueued' as const, windowMs: TRANSPORT_WINDOW_MS, clients: [...clients.values()].sort((a, b) => (a.playerId ?? '').localeCompare(b.playerId ?? '')) };
  }
  function broadcastLobby() { for (const [socket, session] of sockets) send(socket, { type: 'lobby', lobby: lobby(session.host) }); }
  function communication(playerId?: string): ChatStateResponse {
    const roster = [...humans, ...aiPlayers()], player = roster.find(item => item.id === playerId);
    const allied = (id: string) => player && roster.some(item => item.id === id && item.teamId === player.teamId);
    return { messages: messages.filter(message => message.channel === 'all' || allied(message.senderId)), pings: pings.filter(ping => ping.expiresTick > communicationTick && allied(ping.senderId)), sendHumanChat: aiPlayers().some(ai=>allied(ai.id)&&modelCatalog.get(ai.aiModelId??'host')?.state().settings.sendHumanChat) };
  }
  function broadcastCommunication() { for (const [socket, session] of sockets) send(socket, { type: 'communication', state: communication(session.playerId) }); }
  function addMessage(message: ChatMessage) { messages.push(message); if (messages.length > 200) messages.shift(); broadcastCommunication(); }
  function clearCommunication() { messages.length = 0; pings.length = 0; chatRequests.clear(); communicationTick = 0; broadcastCommunication(); }
  function aiMessage(playerId: string, message: { recipientId: string; text: string; requestId?: string; status: 'planned' | 'declined' | 'completed' | 'blocked' | 'expired' }) {
    const roster = [...humans, ...aiPlayers()], ai = roster.find(item => item.id === playerId && item.kind === 'ai'), recipient = roster.find(item => item.id === message.recipientId);
    if (!ai || !recipient || ai.teamId !== recipient.teamId) return;
    const request = message.requestId ? chatRequests.get(message.requestId) : undefined;
    if (message.requestId && (!request || request.targetAiId !== playerId || request.senderId !== message.recipientId)) return;
    if (request && message.status === 'planned') request.tick = communicationTick;
    const text = message.text.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240).trim(); if (!text) return;
    addMessage({ id: `msg_${token().slice(0, 20)}`, tick: communicationTick, senderId: playerId, channel: 'team', text, source: !request?.preset && (message.status === 'planned' || message.status === 'declined') ? 'model' : 'system', ...(message.requestId ? { requestId: message.requestId, targetAiId: playerId } : {}), status: message.status });
    if (message.requestId && ['completed', 'declined', 'expired'].includes(message.status)) chatRequests.delete(message.requestId);
  }
  scheduler.onMessage = aiMessage;
  const matchContent = () => resolveRuleset(settings.rulesetId, settings.maxAge, settings.startingResourcePreset);
  function response(session?: Session) { return { protocolVersion: PROTOCOL_VERSION, contentHash: matchContent().contentHash, csrfToken: session?.csrf ?? '', host: session?.host ?? false, ...(session?.playerId ? { playerId: session.playerId } : {}), lobby: lobby(session?.host) }; }
  function setSession(reply: FastifyReply, request: FastifyRequest, session: Session) {
    sessions.set(session.id, session);
    reply.setCookie('fs_session', session.id, { path: '/', httpOnly: true, sameSite: 'strict', secure: request.headers.origin?.startsWith('https:') ?? false, maxAge: 86400 });
  }
  function issue(reply: FastifyReply, request: FastifyRequest, host: boolean, playerId?: string) {
    const session: Session = { id: token(), csrf: token(), host, playerId, expires: clockNow() + 86400000 }; setSession(reply, request, session); return session;
  }
  function fail(reply: FastifyReply, code: string, statusCode = 400) { return reply.code(statusCode).send({ code }); }
  const publicError = (error: unknown, fallback = 'SAVE_FAILED') => error instanceof Error && /^[A-Z][A-Z_]{1,95}$/.test(error.message) ? error.message : fallback;
  function warnHost(code: string) { for (const [socket, identity] of sockets) if (identity.host) send(socket, { type: 'error', code }); }
  function emptyBody(value: unknown) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0; }
  function host(request: FastifyRequest, reply: FastifyReply) { const session = sessionFor(request); if (!session?.host) { fail(reply, 'HOST_REQUIRED', 403); return undefined; } return session; }
  function allowedOrigin(origin: string | undefined) { return typeof origin === 'string' && origins.has(origin); }
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (!allowedOrigin(request.headers.origin)) return fail(reply, request.routeOptions.url === '/api/bootstrap' ? 'BOOTSTRAP_LOCAL_ONLY' : 'ORIGIN_REJECTED', 403);
      if (!rate(`http:${request.ip}`)) return fail(reply, 'RATE_LIMITED', 429);
      const session = sessionFor(request);
      if (session && !equals(String(request.headers['x-csrf-token'] ?? ''), session.csrf)) return fail(reply, 'CSRF_REJECTED', 403);
      if (restoreBusy) return fail(reply, 'RESTORE_IN_PROGRESS', 409);
    }
  });
  app.setErrorHandler((error, _request, reply) => { const statusCode = (error as { statusCode?: number }).statusCode ?? 500; reply.code(statusCode).send({ code: statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : statusCode === 400 ? 'INVALID_REQUEST' : 'SERVER_ERROR' }); });
  app.get('/api/health', async () => ({ ready: true, protocolVersion: PROTOCOL_VERSION }));
  app.get('/api/session', async request => response(sessionFor(request)));
  app.get('/api/host/endpoint', async (request, reply) => { if (!host(request, reply)) return; return endpoint.state(); });
  app.post('/api/host/endpoint', async (request, reply) => {
    if (!host(request, reply)) return;
    if (pauseBusy) return fail(reply, 'PAUSE_BUSY', 409);
    if (!['LOBBY', 'PAUSED', 'FINISHED'].includes(status)) return fail(reply, 'PAUSE_BEFORE_ENDPOINT_CHANGE', 409);
    if (!validateEndpointUpdateRequest(request.body)) return fail(reply, 'INVALID_ENDPOINT_SETTINGS');
    if (endpointBusy || assistantChanges.size) return fail(reply, 'ENDPOINT_BUSY', 409); endpointBusy = true;
    try { await endpoint.update(request.body.settings, request.body.apiKey); await scheduler.configurationChanged('host'); broadcastCommunication(); return endpoint.state(); }
    catch (error) { return fail(reply, publicError(error, 'ENDPOINT_CONFIG_FAILED')); }
    finally { endpointBusy = false; }
  });
  app.post('/api/host/endpoint/test', async (request, reply) => {
    if (!host(request, reply)) return;
    if (pauseBusy) return fail(reply, 'PAUSE_BUSY', 409);
    if (!['LOBBY', 'PAUSED', 'FINISHED'].includes(status)) return fail(reply, 'PAUSE_BEFORE_ENDPOINT_TEST', 409);
    const body = request.body as { listModels?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'listModels' || typeof body.listModels !== 'boolean') return fail(reply, 'INVALID_REQUEST');
    if (endpointBusy) return fail(reply, 'ENDPOINT_BUSY', 409); endpointBusy = true;
    try { return await scheduler.probe(body.listModels); } catch (error) { return fail(reply, publicError(error, 'ENDPOINT_TEST_FAILED'), 409); }
    finally { endpointBusy = false; }
  });
  app.get('/api/host/models', async (request, reply) => { if (!host(request,reply)) return; return modelCatalog.hostState(); });
  app.post('/api/host/models', async (request, reply) => {
    if (!host(request,reply)) return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if (!['LOBBY','PAUSED','FINISHED'].includes(status)) return fail(reply,'PAUSE_BEFORE_ENDPOINT_CHANGE',409);
    if (!validateAiModelUpsertRequest(request.body)) return fail(reply,'INVALID_MODEL_CONFIGURATION');
    if (endpointBusy || assistantChanges.size) return fail(reply,'ENDPOINT_BUSY',409); endpointBusy=true;
    try { const entry=await modelCatalog.upsert(request.body); await scheduler.configurationChanged(entry.id); broadcastCommunication(); broadcastLobby(); return entry; }
    catch(error){return fail(reply,publicError(error,'MODEL_CONFIG_FAILED'));} finally {endpointBusy=false;}
  });
  app.delete('/api/host/models/:id', async (request,reply) => {
    if (!host(request,reply)) return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if (!['LOBBY','PAUSED','FINISHED'].includes(status)) return fail(reply,'PAUSE_BEFORE_ENDPOINT_CHANGE',409);
    const {id}=request.params as {id:string};
    if ([...aiConfiguration.values()].some(entry=>(entry.modelId??'host')===id) || humans.some(player=>player.assistant?.modelId===id)) return fail(reply,'MODEL_IN_USE',409);
    if(endpointBusy || assistantChanges.size)return fail(reply,'ENDPOINT_BUSY',409);endpointBusy=true;
    try {await modelCatalog.remove(id);await scheduler.configurationChanged(id);return {ok:true};}
    catch(error){return fail(reply,publicError(error,'MODEL_DELETE_FAILED'));}finally{endpointBusy=false;}
  });
  app.post('/api/host/models/:id/test', async(request,reply)=>{
    if(!host(request,reply))return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if(!['LOBBY','PAUSED','FINISHED'].includes(status))return fail(reply,'PAUSE_BEFORE_ENDPOINT_TEST',409);
    const body=request.body as {listModels?:unknown}|null;
    if(!body||Array.isArray(body)||Object.keys(body).join(',')!=='listModels'||typeof body.listModels!=='boolean')return fail(reply,'INVALID_REQUEST');
    if(endpointBusy)return fail(reply,'ENDPOINT_BUSY',409);endpointBusy=true;
    try{return await scheduler.probe(body.listModels,(request.params as {id:string}).id);}
    catch(error){return fail(reply,publicError(error,'ENDPOINT_TEST_FAILED'),409);}finally{endpointBusy=false;}
  });
  function assistantPlayer(request:FastifyRequest,reply:FastifyReply){
    const player=humans.find(item=>item.id===sessionFor(request)?.playerId);
    if(!player){fail(reply,'PLAYER_REQUIRED',403);return;}
    return player;
  }
  async function assistantOptions(player:LobbyPlayer):Promise<AssistantOptionsResponse>{
    const current=bridge, currentEpoch=epoch;
    const prefs=structuredClone(assistantPreferences.get(player.id)??defaultAssistant());
    const state:AssistantStateResponse=current?await current.assistantState(player.id):{preferences:prefs,status:prefs.enabled?'fallback':'manual',protectedEntityIds:[]};
    if(current!==bridge||currentEpoch!==epoch)throw new Error('MATCH_CHANGED');
    if(state.preferences.enabled && !modelCatalog.choices().some(model=>model.id===state.preferences.modelId&&model.available))state.status='unavailable';
    return {models:modelCatalog.choices(),assistant:state};
  }
  app.get('/api/assistant',async(request,reply)=>{
    const player=assistantPlayer(request,reply);if(!player)return;
    if(!rate(`assistant-read:${player.id}`,10,2))return fail(reply,'RATE_LIMITED',429);
    try{return await assistantOptions(player);}catch(error){return fail(reply,publicError(error,'ASSISTANT_UNAVAILABLE'),409);}
  });
  app.post('/api/assistant',async(request,reply)=>{
    const player=assistantPlayer(request,reply);if(!player)return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if(!validateAssistantPreferences(request.body))return fail(reply,'INVALID_ASSISTANT_SETTINGS');
    if(!['LOBBY','RUNNING','PAUSED'].includes(status))return fail(reply,'ASSISTANT_CHANGE_UNAVAILABLE',409);
    if(settings.tutorial)return fail(reply,'PRACTICE_ASSISTANCE_DISABLED',409);
    if(!rate(`assistant-write:${player.id}`,6,1))return fail(reply,'RATE_LIMITED',429);
    if(endpointBusy||assistantChanges.has(player.id))return fail(reply,'ASSISTANT_BUSY',409);
    const prefs=structuredClone(request.body), model=prefs.modelId===null?undefined:modelCatalog.choices().find(item=>item.id===prefs.modelId);
    // An owner must always be able to pause a previously selected model, even
    // after the host disables that profile or a restored save references it.
    const previousModelId=assistantPreferences.get(player.id)?.modelId??player.assistant?.modelId??null;
    if(prefs.modelId!==null&&!model&&(prefs.enabled||prefs.modelId!==previousModelId))return fail(reply,'MODEL_NOT_FOUND');
    if(prefs.enabled&&!model?.available)return fail(reply,'MODEL_UNAVAILABLE',409);
    assistantChanges.add(player.id);
    try{
      const current=bridge,currentEpoch=epoch;
      if(current)await current.configureAssistant(player.id,prefs);
      if(current!==bridge||currentEpoch!==epoch||!humans.includes(player))return fail(reply,'MATCH_CHANGED',409);
      assistantPreferences.set(player.id,prefs);player.assistant={modelId:prefs.modelId,enabled:prefs.enabled};
      if(status==='LOBBY')player.ready=false;
      scheduler.playerChanged(player.id);broadcastLobby();return await assistantOptions(player);
    }catch(error){return fail(reply,publicError(error,'ASSISTANT_CHANGE_FAILED'),409);}finally{assistantChanges.delete(player.id);}
  });
  app.post('/api/assistant/release',async(request,reply)=>{
    const player=assistantPlayer(request,reply);if(!player)return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if(!validateAssistantReleaseRequest(request.body))return fail(reply,'INVALID_REQUEST');
    if(!bridge||!['RUNNING','PAUSED'].includes(status))return fail(reply,'NO_ACTIVE_MATCH',409);
    if(!rate(`assistant-write:${player.id}`,6,1))return fail(reply,'RATE_LIMITED',429);
    if(assistantChanges.has(player.id))return fail(reply,'ASSISTANT_BUSY',409);assistantChanges.add(player.id);
    try{const current=bridge,currentEpoch=epoch;await current.releaseAssistantEntities(player.id,request.body.entityIds);if(current!==bridge||currentEpoch!==epoch)return fail(reply,'MATCH_CHANGED',409);return await assistantOptions(player);}
    catch(error){return fail(reply,publicError(error,'ASSISTANT_RELEASE_FAILED'),409);}finally{assistantChanges.delete(player.id);}
  });
  app.post('/api/host/ai-model',async(request,reply)=>{
    if(!host(request,reply))return;
    if(pauseBusy)return fail(reply,'PAUSE_BUSY',409);
    if(!['LOBBY','PAUSED'].includes(status))return fail(reply,'PAUSE_BEFORE_ENDPOINT_CHANGE',409);
    if(!validateAiModelAssignmentRequest(request.body))return fail(reply,'INVALID_REQUEST');
    const {playerId,modelId}=request.body,current=aiConfiguration.get(playerId);
    if(!current)return fail(reply,'INVALID_PLAYER');
    if(!modelCatalog.choices().some(item=>item.id===modelId&&item.available))return fail(reply,'MODEL_UNAVAILABLE',409);
    if(endpointBusy||assistantChanges.has(playerId))return fail(reply,'ASSISTANT_BUSY',409);assistantChanges.add(playerId);
    try{const worker=bridge,currentEpoch=epoch;if(worker)await worker.setAiModel(playerId,modelId);if(worker!==bridge||currentEpoch!==epoch)return fail(reply,'MATCH_CHANGED',409);current.modelId=modelId;scheduler.playerChanged(playerId);if(status==='LOBBY')for(const player of humans)player.ready=false;broadcastLobby();return lobby(true);}
    catch(error){return fail(reply,publicError(error,'MODEL_ASSIGNMENT_FAILED'),409);}finally{assistantChanges.delete(playerId);}
  });
  app.get('/api/host/diagnostics', async (request, reply) => {
    if (!host(request, reply)) return;
    const publication = publicationWorker?.diagnostics();
    const state = endpoint.state(); return { endpoint: { configured: state.configured, mode: state.capability.mode, status: state.capability.status }, scheduler: scheduler.diagnostics(), simulation: await bridge?.diagnostics().catch(() => null) ?? null,
      compute: { publication: { mode: publication ? 'threads' : 'inline', threadIds: publication?.threadId && !publication.failed ? [publication.threadId] : [], pending: publication ? publication.inflightOffers + publication.pendingOffers + publication.projectionTransfers : 0, recoveries: publication?.recoveries ?? 0, degraded: publication?.failed ?? false } },
      ...(publication ? { publicationDelivery: publication.delivery } : {}),
      process: { rssMiB: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100, eventLoopDelayMs: { p50: eventLoopDelay.percentile(50) / 1e6, p95: eventLoopDelay.percentile(95) / 1e6, p99: eventLoopDelay.percentile(99) / 1e6, max: eventLoopDelay.max / 1e6 } }, transport: transportDiagnostics() };
  });
  app.get('/api/chat', async (request, reply) => { const session = sessionFor(request); if (!session) return fail(reply, 'SESSION_REQUIRED', 403); return communication(session.playerId); });
  function chatPlayer(request: FastifyRequest, reply: FastifyReply) {
    const player = humans.find(item => item.id === sessionFor(request)?.playerId);
    if (!player) { fail(reply, 'PLAYER_REQUIRED', 403); return; }
    if (!rate(`chat:${player.id}`, 5, .5)) { fail(reply, 'RATE_LIMITED', 429); return; } return player;
  }
  function alliedAi(player: LobbyPlayer, targetAiId: string) { return aiPlayers().find(ai => ai.id === targetAiId && ai.teamId === player.teamId); }
  async function addressAi(player: LobbyPlayer, targetAiId: string, text: string, intent?: AiChatRequest['intent'], position?: { xMm: number; zMm: number }) {
    if (!bridge || !['RUNNING', 'PAUSED'].includes(status)) throw new Error('NO_ACTIVE_MATCH');
    const requestId = `chat_${token().slice(0, 24)}`, current = bridge, epochAtRequest = epoch;
    const view = await current.view(player.id); if (current !== bridge || epochAtRequest !== epoch) throw new Error('MATCH_CHANGED');
    communicationTick = view.tick;
    const entry = { senderId: player.id, targetAiId, tick: view.tick, preset: Boolean(intent) };
    chatRequests.set(requestId, entry); if (chatRequests.size > 160) { chatRequests.delete(requestId); throw new Error('AI_CHAT_LIMIT'); }
    if (modelCatalog.get(aiConfiguration.get(targetAiId)?.modelId??'host')?.state().settings.sendHumanChat || intent) {
      const result = await current.acceptAiChat({ requestId, senderId: player.id, recipientId: targetAiId, text, tick: view.tick, verified: false, ...(intent ? { intent } : {}), ...(position ? { position } : {}) });
      if (current !== bridge || epochAtRequest !== epoch) { chatRequests.delete(requestId); throw new Error('MATCH_CHANGED'); }
      if (!result.accepted) { chatRequests.delete(requestId); throw new Error(result.code); }
      if (!intent) scheduler.urgent(targetAiId, requestId);
    }
    return requestId;
  }
  app.post('/api/chat', async (request, reply) => {
    if (!validateChatRequest(request.body)) return fail(reply, 'INVALID_REQUEST'); const player = chatPlayer(request, reply); if (!player) return;
    const body = request.body, text = body.text.replace(/[\u0000-\u001f\u007f]/g, '').trim(); if (!text) return fail(reply, 'EMPTY_CHAT');
    if (body.targetAiId && !alliedAi(player, body.targetAiId)) return fail(reply, 'ALLIED_AI_REQUIRED', 403);
    let requestId: string | undefined;
    const unavailable = body.targetAiId ? !modelCatalog.get(aiConfiguration.get(body.targetAiId)?.modelId??'host')?.state().settings.sendHumanChat ? 'Human chat is not sent to the model. Use a cooperation preset to request an action.' : status !== 'RUNNING' ? 'AI action requests are available while the match is running.' : undefined : undefined;
    try { if (body.targetAiId) requestId = unavailable ? `chat_${token().slice(0, 24)}` : await addressAi(player, body.targetAiId, text); }
    catch (error) { return fail(reply, publicError(error, 'CHAT_REJECTED'), 409); }
    addMessage({ id: `msg_${token().slice(0, 20)}`, tick: communicationTick, senderId: player.id, channel: body.channel, text, source: 'human', ...(requestId ? { requestId, targetAiId: body.targetAiId, status: 'requested' as const } : {}) });
    if (unavailable && requestId) addMessage({ id: `msg_${token().slice(0, 20)}`, tick: communicationTick, senderId: body.targetAiId!, channel: 'team', text: unavailable, source: 'system', requestId, targetAiId: body.targetAiId, status: 'declined' });
    return communication(player.id);
  });
  app.post('/api/ping', async (request, reply) => {
    if (!validatePingRequest(request.body)) return fail(reply, 'INVALID_REQUEST'); const player = chatPlayer(request, reply); if (!player) return;
    if (!bridge || !['RUNNING', 'PAUSED'].includes(status)) return fail(reply, 'NO_ACTIVE_MATCH', 409);
    const body = request.body, current = bridge, epochAtRequest = epoch, view = await current.view(player.id);
    if (bridge !== current || epochAtRequest !== epoch) return fail(reply, 'MATCH_CHANGED', 409);
    if (body.xMm >= view.map.widthMm || body.zMm >= view.map.heightMm) return fail(reply, 'OUT_OF_BOUNDS');
    communicationTick = view.tick; pings.push({ ...body, id: `ping_${token().slice(0, 20)}`, senderId: player.id, tick: view.tick, expiresTick: view.tick + 30 * balance.rules.simulationHz }); if (pings.length > 64) pings.shift(); broadcastCommunication(); return communication(player.id);
  });
  app.post('/api/cooperate', async (request, reply) => {
    if (!validateCooperationRequest(request.body)) return fail(reply, 'INVALID_REQUEST'); const player = chatPlayer(request, reply); if (!player) return;
    const body = request.body; if (!alliedAi(player, body.targetAiId)) return fail(reply, 'ALLIED_AI_REQUIRED', 403);
    if (!bridge || !['RUNNING', 'PAUSED'].includes(status)) return fail(reply, 'NO_ACTIVE_MATCH', 409);
    let text: string, intent: AiChatRequest['intent'], position: { xMm: number; zMm: number } | undefined;
    if (body.action === 'tribute') { text = `Request ${body.amount} ${body.resource}.`; intent = { action: 'tribute', resource: body.resource, amount: body.amount }; }
    else if (body.action === 'attack_ping') {
      const ping = communication(player.id).pings.find(ping => ping.id === body.pingId); if (!ping) return fail(reply, 'PING_UNAVAILABLE');
      position = { xMm: ping.xMm, zMm: ping.zMm }; text = `Request an attack at the allied ping (${Math.round(ping.xMm / 1000)}, ${Math.round(ping.zMm / 1000)} m).`; intent = { action: 'attack_ping', position };
    } else {
      const current = bridge, epochAtRequest = epoch, view = await current.view(player.id);
      if (current !== bridge || epochAtRequest !== epoch) return fail(reply, 'MATCH_CHANGED', 409);
      const base = view.entities.find(entity => entity.ownerId === player.id && entity.typeId === 'town_center' && !entity.ghost); if (!base) return fail(reply, 'OWN_BASE_UNAVAILABLE');
      position = { xMm: base.xMm, zMm: base.zMm }; text = 'Request defense of my base.'; intent = { action: 'defend_base' };
    }
    try { const requestId = await addressAi(player, body.targetAiId, text, intent, position); addMessage({ id: `msg_${token().slice(0, 20)}`, tick: communicationTick, senderId: player.id, channel: 'team', text, source: 'human', requestId, targetAiId: body.targetAiId, status: 'requested' }); return communication(player.id); }
    catch (error) { return fail(reply, publicError(error, 'COOPERATION_REJECTED'), 409); }
  });
  app.post('/api/bootstrap', async (request, reply) => {
    if (!rate(`bootstrap:${request.ip}`, 5, 0.05)) return fail(reply, 'RATE_LIMITED', 429);
    if (!loopback(request.ip) || !loopbackOrigin(request.headers.origin)) return fail(reply, 'BOOTSTRAP_LOCAL_ONLY', 403);
    if (bootstrapped) return fail(reply, 'BOOTSTRAP_USED', 403);
    if (clockNow() > bootstrapExpires) return fail(reply, 'BOOTSTRAP_EXPIRED', 403);
    if (!validateBootstrap(request.body) || !equals(request.body.token, bootstrapToken)) return fail(reply, 'BOOTSTRAP_REJECTED', 403);
    bootstrapped = true; status = 'LOBBY'; const session = issue(reply, request, true); broadcastLobby(); return response(session);
  });
  app.post('/api/join', async (request, reply) => {
    if (!validateJoin(request.body)) return fail(reply, 'INVALID_REQUEST');
    const body = request.body; const existing = sessionFor(request);
    if (existing?.playerId) return response(existing);
    if (status !== 'LOBBY') return fail(reply, 'LOBBY_CLOSED', 409);
    if (!rate(`join:${request.ip}`, 10, 0.1)) return fail(reply, 'RATE_LIMITED', 429);
    const hostPlayer = body.hostPlayer === true;
    if (hostPlayer ? !existing?.host : !equals(body.inviteCode, inviteCode)) return fail(reply, 'INVITE_REJECTED', 403);
    if (settings.tutorial && !hostPlayer) return fail(reply, 'PRACTICE_HOST_PLAYER_ONLY', 409);
    if (hostPlayer && humans.some(p => p.hostPlayer)) return fail(reply, 'HOST_PLAYER_CAPACITY', 409);
    if (settings.teamPreset === 'five_vs_five' && humans.length >= 5) return fail(reply, 'PRESET_HUMAN_CAPACITY', 409);
    if (!hostPlayer && humans.filter(p => !p.hostPlayer).length >= balance.rules.remoteHumanLimit) return fail(reply, 'REMOTE_PLAYER_CAPACITY', 409);
    const used = new Set([...humans, ...aiPlayers()].map(player => player.pattern)), pattern = colors.findIndex((_, index) => !used.has(index));
    const player: LobbyPlayer = { id: `p_${randomBytes(12).toString('hex')}`, name: body.name.trim().replace(/[\u0000-\u001f\u007f]/g, ''), teamId: `team_${token().slice(0, 12)}`, color: colors[pattern]!, pattern, kind: 'human', hostPlayer, ready: false, connected: false };
    if (!player.name) return fail(reply, 'INVALID_NAME');
    humans.push(player); applyTeamPreset();
    const session = existing ?? issue(reply, request, false); session.playerId = player.id; broadcastLobby(); return response(session);
  });
  app.post('/api/ready', async (request, reply) => {
    const session = sessionFor(request); const player = humans.find(p => p.id === session?.playerId);
    if (!player) return fail(reply, 'PLAYER_REQUIRED', 403);
    if (!validateReady(request.body)) return fail(reply, 'INVALID_REQUEST');
    if (status !== 'LOBBY') return fail(reply, 'LOBBY_CLOSED', 409);
    player.ready = request.body.ready; broadcastLobby(); return response(session);
  });
  app.post('/api/leave', async (request, reply) => {
    const session = sessionFor(request); if (!session?.playerId) return fail(reply, 'PLAYER_REQUIRED', 403);
    if (!emptyBody(request.body)) return fail(reply, 'INVALID_REQUEST');
    if (status !== 'LOBBY') return fail(reply, 'LOBBY_CLOSED', 409);
    const playerId = session.playerId; humans = humans.filter(player => player.id !== playerId);assistantPreferences.delete(playerId);
    for (const identity of sessions.values()) if (identity.playerId === playerId) delete identity.playerId;
    disconnected.delete(playerId); pauseRequests.delete(playerId); broadcastLobby(); return response(session);
  });
  app.post('/api/host/invite', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (!emptyBody(request.body)) return fail(reply, 'INVALID_REQUEST');
    if (status !== 'LOBBY') return fail(reply, 'LOBBY_CLOSED', 409);
    inviteCode = randomBytes(9).toString('base64url'); broadcastLobby(); return response(session);
  });
  app.post('/api/host/lobby', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (status !== 'LOBBY' || !validateLobbyConfig(request.body)) return fail(reply, 'INVALID_LOBBY');
    if (request.body.teamPreset === 'five_vs_five' && humans.length > 5) return fail(reply, 'PRESET_HUMAN_CAPACITY', 409);
    const nextSettings = { ...settings, ...request.body };
    if (settings.tutorial && request.body.tutorial === false && request.body.rulesetId === undefined) {
      nextSettings.rulesetId = 'legendary_ages_v1';
      nextSettings.maxAge = request.body.maxAge ?? 8;
      nextSettings.startingResourcePreset = request.body.startingResourcePreset ?? 'long_war';
    }
    // Reset implicit defaults on a ruleset change. Validate before mutating
    // settings or player readiness; incompatible explicit combinations fail.
    if (request.body.rulesetId && request.body.rulesetId !== settings.rulesetId) {
      const defaults = resolveRuleset(request.body.rulesetId);
      nextSettings.maxAge = request.body.maxAge ?? defaults.maxAge;
      nextSettings.startingResourcePreset = request.body.startingResourcePreset ?? defaults.startingResourcePreset;
    }
    try {
      const selected = resolveRuleset(nextSettings.rulesetId, nextSettings.maxAge, nextSettings.startingResourcePreset);
      nextSettings.rulesetId = selected.rulesetId; nextSettings.maxAge = selected.maxAge; nextSettings.startingResourcePreset = selected.startingResourcePreset;
    } catch { return fail(reply, 'INVALID_RULESET_SETTINGS'); }
    if (nextSettings.tutorial) { nextSettings.rulesetId = 'classic_v1'; nextSettings.maxAge = 4; nextSettings.startingResourcePreset = 'standard'; }
    if (nextSettings.tutorial && (humans.some(player => !player.hostPlayer || player.assistant?.enabled) || nextSettings.aiCount !== 1 || nextSettings.teamPreset !== 'free_for_all' || nextSettings.caretakerEnabled || nextSettings.monumentVictory)) return fail(reply, 'PRACTICE_REQUIRES_ONE_HOST_AND_ONE_OPPONENT', 409);
    Object.assign(settings, nextSettings);
    if (request.body.teamPreset === 'five_vs_five' || request.body.teamPreset === 'six_vs_five') settings.aiCount = 5;
    else if (!settings.tutorial && request.body.aiCount !== undefined && request.body.teamPreset === undefined) settings.teamPreset = 'custom';
    syncAiConfiguration(); applyTeamPreset(); for (const player of humans) player.ready = false;
    broadcastLobby(); return response(session);
  });
  app.post('/api/host/team', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (status !== 'LOBBY') return fail(reply, 'LOBBY_CLOSED', 409);
    if (!validateTeamAssignmentRequest(request.body)) return fail(reply, 'INVALID_REQUEST');
    if (settings.tutorial) return fail(reply, 'PRACTICE_TEAMS_FIXED', 409);
    const { playerId, teamId } = request.body;
    const human = humans.find(player => player.id === playerId);
    if (!human && !aiPlayers().some(player => player.id === playerId)) return fail(reply, 'INVALID_PLAYER');
    if (human) human.teamId = teamId; else aiTeams.set(playerId, teamId);
    settings.teamPreset = 'custom';
    for (const player of humans) player.ready = false;
    broadcastLobby(); return response(session);
  });
  app.post('/api/host/seed', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { seed?: unknown } | null;
    if (status !== 'LOBBY' || !body || Array.isArray(body) || Object.keys(body).join(',') !== 'seed' || !(body.seed === null || typeof body.seed === 'string' && body.seed.length >= 1 && body.seed.length <= 256 && !/[\u0000-\u001f\u007f]/.test(body.seed))) return fail(reply, 'INVALID_SEED');
    hostSeed = body.seed; for (const player of humans) player.ready = false; broadcastLobby(); return response(session);
  });
  app.post('/api/host/ai', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { playerId?: unknown; difficulty?: unknown; personality?: unknown } | null;
    if (status !== 'LOBBY' || !body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'difficulty,personality,playerId' || typeof body.playerId !== 'string' || typeof body.difficulty !== 'string' || typeof body.personality !== 'string' || !Object.hasOwn(balance.ai.difficulty, body.difficulty) || !balance.ai.personalities.includes(body.personality as Personality)) return fail(reply, 'INVALID_AI_CONFIGURATION');
    const current = aiConfiguration.get(body.playerId); if (!current) return fail(reply, 'INVALID_PLAYER');
    current.difficulty = body.difficulty as Difficulty; current.personality = body.personality as Personality;
    for (const player of humans) player.ready = false; broadcastLobby(); return response(session);
  });
  app.post('/api/host/identity', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { playerId?: unknown; pattern?: unknown } | null;
    if (status !== 'LOBBY' || !body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'pattern,playerId' || typeof body.playerId !== 'string' || !Number.isInteger(body.pattern) || Number(body.pattern) < 0 || Number(body.pattern) >= colors.length) return fail(reply, 'INVALID_IDENTITY');
    const roster = [...humans, ...aiPlayers()], player = roster.find(player => player.id === body.playerId); if (!player) return fail(reply, 'INVALID_PLAYER');
    const other = roster.find(player => player.pattern === body.pattern), prior = player.pattern!;
    const assign = (id: string, pattern: number) => { const human = humans.find(player => player.id === id); if (human) { human.pattern = pattern; human.color = colors[pattern]!; } else aiConfiguration.get(id)!.pattern = pattern; };
    if (other) assign(other.id, prior); assign(player.id, Number(body.pattern));
    for (const human of humans) human.ready = false; broadcastLobby(); return response(session);
  });
  async function returnToLobby() {
    clearTimeout(loadingTimer); clearTimeout(countdownTimer); loaded.clear();
    const previous = bridge; bridge = undefined;
    await scheduler.setDriver(); clearCommunication();
    status = 'LOBBY'; for (const player of humans) player.ready = false;
    // A loaded legacy match keeps its original rules only for that match.
    // Return to the normal continuous-age game when starting the next one.
    if(settings.rulesetId==='classic_v1'&&!settings.tutorial)Object.assign(settings,{rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war'});
    disconnected.clear(); pauseRequests.clear(); pauseReason = undefined; noHumansSince = undefined;
    restoreSlots.clear(); rejoinInvites.clear(); restoreEpoch = undefined; pendingAutosave = undefined;
    for (const publisher of publishers.values()) publisher.reset();
    if (previous) await closeMatchWorker(previous); broadcastLobby();
  }
  app.post('/api/host/remove-player', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { playerId?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.playerId !== 'string' || !['LOBBY','LOADING'].includes(status)) return fail(reply, 'INVALID_REQUEST');
    const player = humans.find(item => item.id === body.playerId); if (!player) return fail(reply, 'INVALID_PLAYER');
    if (status === 'LOADING') await returnToLobby();
    humans = humans.filter(item => item.id !== player.id);assistantPreferences.delete(player.id);
    disconnected.delete(player.id); pauseRequests.delete(player.id);
    for (const identity of sessions.values()) if (identity.playerId === player.id) delete identity.playerId;
    broadcastLobby(); return response(session);
  });
  app.post('/api/host/reset', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (!emptyBody(request.body) || status !== 'FINISHED') return fail(reply, 'MATCH_NOT_FINISHED', 409);
    await returnToLobby(); return response(session);
  });
  async function subscriptions() { if (bridge) await bridge.subscribe([...new Set([...sockets.values()].flatMap(s => s.playerId ? [s.playerId] : []))]); }
  const updateSubscriptions = () => { void subscriptions().catch(() => {}); };
  function offerDirectView(socket: WebSocket, view: PlayerView) {
    if (options.inspectPublishedViewJson) options.inspectPublishedViewJson(JSON.stringify(view), view.playerId);
    publishers.get(socket)?.offer(view, true);
  }
  async function requestSocketView(socket: WebSocket, current: SimulationBridge, playerId: string, requestedMatch: string | undefined, requestedEpoch: number): Promise<void> {
    if (current !== bridge || requestedMatch !== matchId || requestedEpoch !== epoch || sockets.get(socket)?.playerId !== playerId || socket.readyState !== WebSocket.OPEN) throw new Error('MATCH_CHANGED');
    if (projectionTransfer) {
      const publisher = publishers.get(socket), token = current.reservePublicationRequest();
      if (!requestedMatch || !(publisher instanceof ThreadedViewPublisher) || !publisher.requestSnapshot({ stream: current.publicationStream, token, matchId: requestedMatch, matchEpoch: requestedEpoch })) throw new Error('PUBLICATION_UNAVAILABLE');
      await current.publishRecipient(playerId, token, requestedMatch, requestedEpoch);
    } else {
      const epochAtRequest = epoch, view = await current.view(playerId);
      if (current !== bridge || epochAtRequest !== epoch || sockets.get(socket)?.playerId !== playerId) throw new Error('MATCH_CHANGED');
      offerDirectView(socket, view);
    }
  }
  function publishView(playerId: string, view: PlayerView) {
    const started = performanceMetrics?.now();
    try {
    epoch = Math.max(epoch, view.matchEpoch);
    communicationTick = view.tick;
    if (view.status === 'FINISHED' && status !== 'FINISHED') { status = 'FINISHED'; broadcastLobby(); }
    // The worker still sends its filtered object over IPC. Serialize once for all
    // sockets of this recipient; each publisher privately parses and validates it.
    let encoded: string | undefined, attempted = false, encodingFailed = false;
    for (const [socket, session] of sockets) if (session.playerId === playerId) {
      if (!attempted) {
        attempted = true;
        try { encoded = performanceMetrics ? performanceMetrics.measure('stringify', () => JSON.stringify({ ...view, status: status === 'COUNTDOWN' ? 'COUNTDOWN' : view.status })) : JSON.stringify({ ...view, status: status === 'COUNTDOWN' ? 'COUNTDOWN' : view.status }); }
        catch { encodingFailed = true; }
        if (encoded !== undefined) options.inspectPublishedViewJson?.(encoded, playerId);
      }
      const publisher = publishers.get(socket);
      // Cycles and other invalid internal values fail only this transport through
      // the existing strict capture path, never escape the worker message callback.
      if (encodingFailed) publisher?.offer(view); else publisher?.offerJson(encoded);
    }
    } finally { if (performanceMetrics) performanceMetrics.sample('publication', performanceMetrics.now() - started!); }
  }
  function publishTransferred(current: SimulationBridge, playerId: string, transfer: WorkerViewTransfer) {
    const started = performanceMetrics?.now();
    const recipients = [...sockets].flatMap(([socket, session]) => session.playerId === playerId && publishers.has(socket) ? [publishers.get(socket)!] : []);
    try {
      const header = current.publicationHeader(transfer, playerId);
      epoch = Math.max(epoch, header.matchEpoch); communicationTick = header.tick;
      if (header.status === 'FINISHED' && status !== 'FINISHED') { status = 'FINISHED'; broadcastLobby(); }
      if (!recipients.length) return;
      if (ownedPreparation) {
        const prepare = () => current.preparePublication(transfer, playerId, status === 'COUNTDOWN', performanceMetrics);
        const prepared = performanceMetrics ? performanceMetrics.measure('prepare', prepare) : prepare();
        if (options.inspectPublishedViewJson) {
          const inspect = () => inspectWorkerViewJson(prepared, options.inspectPublishedViewJson!);
          if (performanceMetrics) performanceMetrics.measure('ownedAuditSerialize', inspect); else inspect();
        }
        for (const publisher of recipients) publisher.offerPrepared(prepared);
      } else {
        if (publicationWorker) {
          const deferred = current.deferPublication(transfer, playerId, status === 'COUNTDOWN');
          if (workerPublicationProjection(deferred)) publicationWorker.offerProjection(deferred, recipients as ThreadedViewPublisher[], options.inspectPublishedViewJson);
          else {
            if (options.inspectPublishedViewJson) inspectWorkerPublicationJson(deferred, options.inspectPublishedViewJson);
            for (const publisher of recipients) (publisher as ThreadedViewPublisher).offerTransferred(deferred);
          }
        } else {
          const stringify = () => current.serializePublication(transfer, playerId, status === 'COUNTDOWN');
          const text = performanceMetrics ? performanceMetrics.measure('stringify', stringify) : stringify();
          options.inspectPublishedViewJson?.(text, playerId);
          for (const publisher of recipients) publisher.offerJson(text);
        }
      }
    } catch (error) { for (const publisher of recipients) publisher.rejectPublication(error); }
    finally { if (performanceMetrics) performanceMetrics.sample('publication', performanceMetrics.now() - started!); }
  }
  function captureSave(payload: SimulationSavePayload): ServerSavePayload {
    // A controller edit can commit before the gateway receives its ACK. Save
    // model choices from this exact capture rather than from the lobby cache.
    const players=structuredClone([...humans,...aiPlayers()]).map(player=>{const faction=payload.state.factions.find(item=>item.id===player.id)!;delete player.assistant;delete player.aiModelId;if(faction.assistant)player.assistant=structuredClone(faction.assistant);if(faction.aiModelId)player.aiModelId=faction.aiModelId;return player;});
    return { game: sealSimulationCapture(payload, engineIdentity), lobby: { settings: structuredClone(settings), players, hostSeed } };
  }
  function persist(save: ServerSavePayload, kind: 'auto' | 'manual', label: string): Promise<SaveSummary> {
    if (saveBusy) return Promise.reject(new Error('SAVE_BUSY'));
    saveBusy = true;
    const operation = (async () => {
      try { const result = await saveStore.save(save, { kind, label, tick: save.game.payload.state.tick }); lastSave = result; persistenceError = undefined; return result; }
      catch (error) { persistenceError = publicError(error); warnHost(persistenceError); app.log.warn({ event: 'save_failed', code: persistenceError }); throw error; }
      finally {
        saveBusy = false;
        if (pendingAutosave) { const pending = pendingAutosave; pendingAutosave = undefined; void persist(pending, 'auto', 'Autosave').catch(() => {}); }
      }
    })();
    persistence.add(operation);
    void operation.then(() => persistence.delete(operation), () => persistence.delete(operation));
    return operation;
  }
  function checksumCapture(payload: SimulationSavePayload) { return { tick: payload.state.tick, ordinal: payload.state.eventOrdinal, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') }; }
  async function closeMatchWorker(current: SimulationBridge) {
    const journal = journals.get(current); await journal?.finishing; await current.close();
    publicationWorker?.releaseProjectionStream(current.publicationStream);
    if (journal) { journal.sealed = true; await journal.store.flush().catch(() => {}); await journal.store.close(); journals.delete(current); }
  }
  function finishRecording(current: SimulationBridge) {
    const journal = journals.get(current); if (!journal || journal.finishing) return journal?.finishing;
    journal.finishing = (async () => {
      try {
        const capture = await current.capture(); journal.sealed = true;
        journal.store.checkpoint(checksumCapture(capture));
        await journal.started; await journal.store.finish(capture.state.tick, capture.state.eventOrdinal);
      } catch (error) { journalHealthy = false; persistenceError = publicError(error, 'REPLAY_RECORDING_FAILED'); warnHost(persistenceError); }
    })();
    return journal.finishing;
  }
  function attachBridge(current: SimulationBridge) {
    const journal = { store: new ReplayStore(replayDirectory, engineIdentity), sealed: false } as { store: ReplayStore; started?: Promise<unknown>; finishing?: Promise<void>; sealed: boolean };
    journals.set(current, journal);
    journal.store.onFailure = code => { if (bridge === current) { journalHealthy = false; persistenceError = code; warnHost(code); } };
    current.onJournalStart = payload => {
      try { journal.started = journal.store.start(sealSimulationCapture(payload, engineIdentity)); void journal.started.then(() => { if (bridge === current) journalHealthy = journal.store.status().healthy; }).catch(() => {}); }
      catch (error) { journalHealthy = false; persistenceError = publicError(error, 'REPLAY_RECORDING_FAILED'); }
    };
    current.onJournal = batch => { if (!journal.sealed) journal.store.append(batch); };
    current.onView = (playerId, transfer) => { if (bridge === current) publishTransferred(current, playerId, transfer); };
    current.onAiMessage = (playerId, message) => { if (bridge === current) aiMessage(playerId, message); };
    current.onStatus = (state, matchEpoch) => { if (bridge === current && (state === 'PAUSED' || state === 'FINISHED')) { scheduler.invalidate('MATCH_NOT_RUNNING'); epoch = Math.max(epoch, matchEpoch); status = state; pauseReason = state === 'PAUSED' ? 'overload' : undefined; broadcastLobby(); if (state === 'FINISHED') void finishRecording(current); } };
    current.onFailure = () => { if (bridge !== current) return; void returnToLobby(); app.log.error({ event: 'simulation_worker_failed' }); };
    current.onCheckpoint = (payload, autosave) => {
      if (!journal.sealed) journal.store.checkpoint(checksumCapture(payload));
      if (bridge !== current || !autosave) return;
      try { const save = captureSave(payload); if (saveBusy) pendingAutosave = save; else void persist(save, 'auto', 'Autosave').catch(() => {}); }
      catch (error) { persistenceError = publicError(error); }
    };
  }
  function replayAllowed(reply: FastifyReply) { if (!['LOBBY', 'FINISHED'].includes(status)) { fail(reply, 'REPLAY_REQUIRES_FINISHED_MATCH', 409); return false; } return true; }
  app.get('/api/host/replays', async (request, reply) => {
    if (!host(request, reply) || !replayAllowed(reply)) return;
    try { if (bridge) await journals.get(bridge)?.finishing; return await replayLibrary.list(); }
    catch (error) { return fail(reply, publicError(error, 'REPLAY_DIRECTORY_UNAVAILABLE'), 500); }
  });
  app.post('/api/host/replay/open', async (request, reply) => {
    if (!host(request, reply) || !replayAllowed(reply)) return;
    const body = request.body as { replayId?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'replayId' || typeof body.replayId !== 'string') return fail(reply, 'INVALID_REQUEST');
    if (replayBusy) return fail(reply, 'REPLAY_BUSY', 409); replayBusy = true;
    let candidate: SimulationBridge | undefined;
    try {
      const { recording } = await replayLibrary.read(body.replayId); candidate = createBridge();
      const opened = await candidate.openReplay(recording);
      await replayViewer?.bridge.close(); replayViewer = { bridge: candidate, id: body.replayId }; candidate = undefined;
      return { replayId: body.replayId, ...opened };
    } catch (error) { await candidate?.close(); return fail(reply, publicError(error, 'REPLAY_OPEN_FAILED'), 400); }
    finally { replayBusy = false; }
  });
  app.post('/api/host/replay/step', async (request, reply) => {
    if (!host(request, reply) || !replayAllowed(reply)) return;
    const body = request.body as { targetTick?: unknown; playerId?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'playerId,targetTick' || !Number.isSafeInteger(body.targetTick) || typeof body.playerId !== 'string') return fail(reply, 'INVALID_REQUEST');
    if (!replayViewer) return fail(reply, 'NO_REPLAY', 409);
    if (replayBusy) return fail(reply, 'REPLAY_BUSY', 409); replayBusy = true;
    try { return { replayId: replayViewer.id, ...await replayViewer.bridge.stepReplay(body.targetTick as number, body.playerId) }; }
    catch (error) { return fail(reply, publicError(error, 'REPLAY_DIVERGENCE'), 400); }
    finally { replayBusy = false; }
  });
  app.get('/api/host/recovery', async (request, reply) => {
    if (!host(request, reply)) return;
    try {
      const listing = await saveStore.list();
      return { ...listing, persistence: { ...(lastSave ? { lastSave } : {}), ...(persistenceError ? { lastError: persistenceError } : {}), journalHealthy },
        disconnected: [...disconnected].map(([playerId, slot]) => ({ playerId, seconds: Math.max(0, Math.floor((clockNow() - slot.since) / 1000)), decisionRequired: slot.decisionRequired, mode: slot.mode })),
        restoreSlots: [...restoreSlots.values()], pauseRequests: [...pauseRequests].map(([playerId, timestamp]) => ({ playerId, timestamp })) };
    } catch (error) { return fail(reply, publicError(error, 'SAVE_DIRECTORY_UNAVAILABLE'), 500); }
  });
  app.post('/api/host/save', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { name?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'name' || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 64 || /[\u0000-\u001f\u007f]/.test(body.name)) return fail(reply, 'INVALID_SAVE_LABEL');
    if (!bridge || !['RUNNING', 'PAUSED', 'FINISHED'].includes(status)) return fail(reply, 'NO_ACTIVE_MATCH', 409);
    if (saveBusy || endpointBusy || assistantChanges.size) return fail(reply, 'SAVE_BUSY', 409);
    try { await persist(captureSave(await bridge.capture()), 'manual', body.name); return response(session); }
    catch (error) { return fail(reply, publicError(error), 500); }
  });
  async function loadSaved(save: ServerSavePayload) {
    if (!validateServerSave(save)) throw new Error('SAVE_PAYLOAD_INVALID');
    const candidate = createBridge();
    attachBridge(candidate);
    let restored: SimulationSavePayload;
    try {
      restored = await candidate.restore(save.game, Math.max(epoch + 1, save.game.payload.state.matchEpoch + 1));
      // Restoring authority does not reconnect its owner. Do not run a personal
      // assistant before that player has reclaimed the seat and opened a socket.
      for(const player of restored.state.factions)if(player.kind==='human'&&restored.state.control[player.id]?.mode!=='caretaker')await candidate.controlMode(player.id,'disconnected');
    }
    catch (error) { await closeMatchWorker(candidate); throw error; }
    const previous = bridge; bridge = candidate; journalHealthy = journals.get(candidate)!.store.status().healthy;
    await scheduler.setDriver(save.lobby.settings.tutorial ? undefined : candidate); clearCommunication();
    clearTimeout(loadingTimer); clearTimeout(countdownTimer); loaded.clear();
    matchId = restored.state.matchId; epoch = restored.state.matchEpoch; status = restored.state.status === 'FINISHED' ? 'FINISHED' : 'PAUSED'; pauseReason = status === 'PAUSED' ? 'host' : undefined;
    restoreEpoch = epoch;
    const content = resolveRuleset(restored.options.rulesetId, restored.options.maxAge, restored.options.startingResourcePreset);
    Object.assign(settings, { tutorial: false }, save.lobby.settings, { rulesetId: content.rulesetId, maxAge: content.maxAge, startingResourcePreset: content.startingResourcePreset }); hostSeed = save.lobby.hostSeed;
    humans = save.lobby.players.filter(player => player.kind === 'human').map(player => ({ ...player, connected: false, ready: false }));
    assistantPreferences.clear();for(const player of humans)assistantPreferences.set(player.id,(await candidate.assistantState(player.id)).preferences);
    aiConfiguration.clear(); aiTeams.clear();
    for (const player of save.lobby.players.filter(player => player.kind === 'ai')) { aiConfiguration.set(player.id, { difficulty: player.difficulty ?? 'easy', personality: player.personality!, pattern: player.pattern!,modelId:player.aiModelId??'host' }); aiTeams.set(player.id, player.teamId); }
    communicationTick = restored.state.tick;
    for (const memory of Object.values(restored.state.controllers)) for (const request of memory.chatRequests) {
      const goals = memory.plan?.goals.filter(goal => goal.correlationId === request.requestId) ?? [];
      if (goals.length && goals.every(goal => ['fulfilled', 'rejected', 'expired'].includes(goal.status))) continue;
      const acceptedTick = Math.max(request.tick, ...goals.map(goal => goal.acceptedTick));
      if (communicationTick - acceptedTick > 90 * balance.rules.simulationHz || chatRequests.size >= 160) continue;
      const sender = humans.find(player => player.id === request.senderId); if (!sender || !alliedAi(sender, request.recipientId)) continue;
      chatRequests.set(request.requestId, { senderId: request.senderId, targetAiId: request.recipientId, tick: acceptedTick, preset: Boolean(request.intent) });
      messages.push({ id: `msg_${createHash('sha256').update(request.requestId).digest('hex').slice(0, 24)}`, tick: request.tick, senderId: request.senderId, targetAiId: request.recipientId, requestId: request.requestId, channel: 'team', text: request.text, source: 'human', status: goals.length ? 'planned' : 'requested' });
    }
    disconnected.clear(); restoreSlots.clear(); rejoinInvites.clear(); pauseRequests.clear(); pendingAutosave = undefined;
    for (const player of humans) { restoreSlots.set(player.id, { playerId: player.id, name: player.name, hostPlayer: player.hostPlayer, claimed: false }); disconnected.set(player.id, { since: clockNow(), mode: restored.state.control[player.id]?.mode === 'caretaker' ? 'caretaker' : 'grace', decisionRequired: false, decided: false }); }
    noHumansSince = humans.length ? clockNow() : undefined;
    // Preserve only administration; every human slot needs a new single-use claim.
    for (const identity of sessions.values()) delete identity.playerId;
    for (const [socket, identity] of sockets) { publishers.get(socket)?.reset(); if (!identity.host) socket.close(4003, 'RESTORE_REJOIN_REQUIRED'); }
    if (previous) await closeMatchWorker(previous); await subscriptions(); broadcastLobby(); broadcastCommunication();
    if (status === 'FINISHED') void finishRecording(candidate);
  }
  app.post('/api/host/load', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (pauseBusy) return fail(reply, 'PAUSE_BUSY', 409);
    const body = request.body as { saveId?: unknown; confirmed?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'confirmed,saveId' || body.confirmed !== true || typeof body.saveId !== 'string') return fail(reply, 'CONFIRMATION_REQUIRED');
    if (!['LOBBY', 'PAUSED', 'FINISHED'].includes(status)) return fail(reply, 'PAUSE_BEFORE_LOAD', 409);
    if (replayBusy) return fail(reply, 'REPLAY_BUSY', 409);
    if (endpointBusy || assistantChanges.size) return fail(reply, 'ENDPOINT_BUSY', 409);
    restoreBusy = true;
    try { await loadSaved((await saveStore.read(body.saveId)).payload); return response(session); }
    catch (error) { return fail(reply, publicError(error, 'SAVE_LOAD_FAILED'), 400); }
    finally { restoreBusy = false; }
  });
  app.post('/api/host/load-latest', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (pauseBusy) return fail(reply, 'PAUSE_BUSY', 409);
    const body = request.body as { confirmed?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'confirmed' || body.confirmed !== true) return fail(reply, 'CONFIRMATION_REQUIRED');
    if (!['LOBBY', 'PAUSED', 'FINISHED'].includes(status)) return fail(reply, 'PAUSE_BEFORE_LOAD', 409);
    if (replayBusy) return fail(reply, 'REPLAY_BUSY', 409);
    if (endpointBusy || assistantChanges.size) return fail(reply, 'ENDPOINT_BUSY', 409);
    restoreBusy = true;
    try { const latest = await saveStore.latestAuto(); await loadSaved(latest.payload); if (latest.warnings.length) persistenceError = 'CORRUPT_AUTOSAVE_SKIPPED'; return response(session); }
    catch (error) { return fail(reply, publicError(error, 'SAVE_LOAD_FAILED'), 400); }
    finally { restoreBusy = false; }
  });
  app.post('/api/host/rejoin-invite', async (request, reply) => {
    if (!host(request, reply)) return;
    const body = request.body as { playerId?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'playerId' || typeof body.playerId !== 'string') return fail(reply, 'INVALID_REQUEST');
    const slot = restoreSlots.get(body.playerId); if (!slot || slot.claimed || !bridge) return fail(reply, 'INVALID_RESTORE_SLOT');
    for (const [key, invitation] of rejoinInvites) if (invitation.playerId === slot.playerId) rejoinInvites.delete(key);
    const invitation = token(), expiresAt = clockNow() + 180000; rejoinInvites.set(invitation, { playerId: slot.playerId, expiresAt, matchId, epoch: restoreEpoch! });
    return { playerId: slot.playerId, token: invitation, expiresAt };
  });
  app.post('/api/rejoin', async (request, reply) => {
    const body = request.body as { token?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'token' || typeof body.token !== 'string' || body.token.length > 256) return fail(reply, 'INVALID_REQUEST');
    const invitation = rejoinInvites.get(body.token), current = sessionFor(request), slot = invitation && restoreSlots.get(invitation.playerId);
    if (!invitation || !slot || slot.claimed || invitation.expiresAt <= clockNow() || invitation.matchId !== matchId || invitation.epoch !== restoreEpoch || current?.playerId || slot.hostPlayer && !current?.host) return fail(reply, 'REJOIN_REJECTED', 403);
    rejoinInvites.delete(body.token); slot.claimed = true;
    if (current) { sessions.delete(current.id); for (const [socket, identity] of sockets) if (identity.id === current.id) socket.close(4000, 'SESSION_ROTATED'); }
    const session = issue(reply, request, current?.host ?? false, slot.playerId); broadcastLobby(); return response(session);
  });
  app.post('/api/host/start', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    if (!emptyBody(request.body)) return fail(reply, 'INVALID_REQUEST');
    if (!lobby().canStart) return fail(reply, 'PLAYERS_NOT_READY', 409);
    if(assistantChanges.size)return fail(reply,'ASSISTANT_BUSY',409);
    if (replayBusy) return fail(reply, 'REPLAY_BUSY', 409);
    if (endpointBusy) return fail(reply, 'ENDPOINT_BUSY', 409);
    status = 'LOADING'; matchId = `match_${randomBytes(12).toString('hex')}`; epoch++; loaded.clear(); broadcastLobby();
    clearCommunication();
    await replayViewer?.bridge.close(); replayViewer = undefined;
    disconnected.clear(); pauseRequests.clear(); pauseReason = undefined; noHumansSince = undefined;
    if (bridge) await closeMatchWorker(bridge); bridge = createBridge(); attachBridge(bridge);
    try {
      await bridge.init({ factions: [...humans, ...aiPlayers()], seed: hostSeed ?? token(), matchId, epoch, mapType: settings.mapType, mapSize: settings.mapSize, rulesetId: settings.rulesetId, maxAge: settings.maxAge, startingResourcePreset: settings.startingResourcePreset, populationLimit: settings.populationLimit, sharedVision: settings.sharedVision, monumentVictory: settings.monumentVictory??false, caretakerEnabled: settings.caretakerEnabled??false, controllers: !settings.tutorial });
      for(const player of humans){const preferences=assistantPreferences.get(player.id);if(preferences)await bridge.configureAssistant(player.id,preferences);}
      await scheduler.setDriver(settings.tutorial ? undefined : bridge);
      await subscriptions();
      // New subscriptions already queue fresh, credited recipient publications.
      if (!projectionTransfer) for (const player of humans) publishView(player.id, await bridge.view(player.id));
      loadingTimer = setTimeout(() => { if (status === 'LOADING') void returnToLobby(); }, 30000);
      if (humans.length === 0) startCountdown();
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith('MAP_GENERATION_FAILED') ? 'MAP_GENERATION_FAILED' : 'MATCH_LOAD_FAILED';
      await returnToLobby(); return fail(reply, code, 500);
    }
    return response(session);
  });
  function startCountdown() {
    if (status !== 'LOADING') return; clearTimeout(loadingTimer); status = 'COUNTDOWN'; broadcastLobby();
    countdownTimer = setTimeout(() => { if (status !== 'COUNTDOWN' || !bridge) return; status = 'RUNNING'; void bridge.status('RUNNING').catch(() => { status = 'LOBBY'; broadcastLobby(); }); broadcastLobby(); }, 3000);
  }
  app.post('/api/host/pause', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { paused?: unknown } | null;
    if (!body || Object.keys(body).length !== 1 || typeof body.paused !== 'boolean' || !['RUNNING','PAUSED'].includes(status)) return fail(reply, 'INVALID_PAUSE');
    if (!body.paused && [...restoreSlots.values()].some(slot => !slot.claimed && ![...rejoinInvites.values()].some(invite => invite.playerId === slot.playerId && invite.expiresAt > clockNow()))) return fail(reply, 'REISSUE_REJOIN_INVITES', 409);
    if (endpointBusy) return fail(reply, 'ENDPOINT_BUSY', 409);
    if (assistantChanges.size) return fail(reply, 'ASSISTANT_BUSY', 409);
    if (pauseBusy) return fail(reply, 'PAUSE_BUSY', 409);
    await applyPauseTransition(body.paused ? 'PAUSED' : 'RUNNING', body.paused ? 'host' : undefined);
    pauseRequests.clear(); broadcastLobby(); return response(session);
  });
  async function applyPauseTransition(target: 'PAUSED' | 'RUNNING', reason: typeof pauseReason) {
    const current = bridge;
    if (!current || pauseBusy) throw new Error('PAUSE_BUSY');
    if (endpointBusy) throw new Error('ENDPOINT_BUSY');
    if (assistantChanges.size) throw new Error('ASSISTANT_BUSY');
    pauseBusy = true;
    try {
      const updated = await current.status(target, true);
      if (bridge !== current || !['RUNNING', 'PAUSED'].includes(status)) throw new Error('MATCH_CHANGED');
      scheduler.invalidate('MATCH_EPOCH_CHANGED');
      status = target; pauseReason = reason; epoch = Math.max(epoch, updated.matchEpoch);
    } finally { pauseBusy = false; }
  }
  app.post('/api/pause-request', async (request, reply) => {
    const session = sessionFor(request);
    if (!session?.playerId || !humans.some(player => player.id === session.playerId)) return fail(reply, 'PLAYER_REQUIRED', 403);
    if (!emptyBody(request.body) || !['RUNNING', 'PAUSED'].includes(status)) return fail(reply, 'NO_ACTIVE_MATCH', 409);
    if (!rate(`pause:${session.playerId}`, 1, 1 / 30)) return fail(reply, 'RATE_LIMITED', 429);
    pauseRequests.set(session.playerId, clockNow()); broadcastLobby(); return response(session);
  });
  app.post('/api/host/disconnect-choice', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { playerId?: unknown; choice?: unknown } | null;
    if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'choice,playerId' || typeof body.playerId !== 'string' || typeof body.choice !== 'string' || !['keep_reserved', 'surrender', 'caretaker'].includes(body.choice)) return fail(reply, 'INVALID_DISCONNECT_CHOICE');
    const slot = disconnected.get(body.playerId);
    if (!bridge || !slot || clockNow() - slot.since < 180000 || !['RUNNING', 'PAUSED'].includes(status)) return fail(reply, 'DISCONNECT_CHOICE_NOT_READY', 409);
    if (body.choice === 'surrender') { await bridge.surrender(body.playerId); disconnected.delete(body.playerId); restoreSlots.delete(body.playerId); }
    else { await bridge.controlMode(body.playerId, body.choice === 'caretaker' ? 'caretaker' : 'disconnected'); slot.mode = body.choice === 'caretaker' ? 'caretaker' : 'reserved'; slot.decided = true; slot.decisionRequired = false; }
    broadcastLobby(); return response(session);
  });
  async function enforceDisconnectPolicy() {
    if (policyBusy || !bridge || !['RUNNING', 'PAUSED'].includes(status)) return;
    policyBusy = true;
    try {
      let changed = false;
      for (const [playerId, slot] of disconnected) {
        const elapsed = clockNow() - slot.since;
        if (elapsed >= 30000 && settings.caretakerEnabled && slot.mode === 'grace' && !slot.decided) { await bridge.controlMode(playerId, 'caretaker'); slot.mode = 'caretaker'; changed = true; }
        if (elapsed >= 180000 && !slot.decided && !slot.decisionRequired) { slot.decisionRequired = true; changed = true; }
      }
      if (humans.length > 0 && humans.every(player => !player.connected)) {
        noHumansSince ??= clockNow();
        if (settings.pauseWhenNoHumans && status === 'RUNNING' && !pauseBusy && !endpointBusy && !assistantChanges.size && clockNow() - noHumansSince >= 30000) { await applyPauseTransition('PAUSED', 'no_humans'); changed = true; }
      } else noHumansSince = undefined;
      if (changed) broadcastLobby();
    } finally { policyBusy = false; }
  }
  const policyTimer = setInterval(() => { void enforceDisconnectPolicy().catch(() => app.log.warn({ event: 'disconnect_policy_failed' })); }, options.policyIntervalMs ?? 250);
  policyTimer.unref();
  app.post('/api/reconnect', async (request, reply) => {
    const session = sessionFor(request); if (!session) return fail(reply, 'SESSION_REQUIRED', 401);
    if (!emptyBody(request.body)) return fail(reply, 'INVALID_REQUEST');
    sessions.delete(session.id); const replacement = issue(reply, request, session.host, session.playerId);
    for (const [socket, old] of sockets) if (old.id === session.id) socket.close(4000, 'SESSION_ROTATED');
    return response(replacement);
  });
  app.post('/api/host/end-draw', async (request, reply) => {
    const session = host(request, reply); if (!session) return;
    const body = request.body as { confirmed?: unknown } | null;
    if (!body || Object.keys(body).length !== 1 || body.confirmed !== true) return fail(reply, 'CONFIRMATION_REQUIRED');
    if (!bridge || !['RUNNING','PAUSED'].includes(status)) return fail(reply, 'NO_ACTIVE_MATCH', 409);
    await bridge.endAsDraw(); status = 'FINISHED'; broadcastLobby(); return response(session);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
  app.server.on('upgrade', (request, socket, head) => {
    const parsed = app.parseCookie(request.headers.cookie ?? ''); const session = sessions.get(parsed.fs_session ?? '');
    // Older open tabs keep the original transport until they explicitly opt in.
    const deltaChunks = request.url === '/ws?deltaChunks=1';
    if ((request.url !== '/ws' && !deltaChunks) || !session || session.expires < clockNow() || !allowedOrigin(request.headers.origin) || !rate(`upgrade:${request.socket.remoteAddress}`, 12, 1) || [...sockets.values()].filter(s => s.id === session.id).length >= 3) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const transport = new MeteredTransport(ws, clockNow, options.inspectOutboundFrame
        ? text => options.inspectOutboundFrame!(text, session.playerId, session.host) : undefined);
      sockets.set(ws, session); transports.set(ws, transport); publishers.set(ws, publicationWorker ? publicationWorker.createPublisher(transport, performanceMetrics, deltaChunks) : new ViewPublisher(transport, performanceMetrics, publicationScope, undefined, deltaChunks)); const player = humans.find(p => p.id === session.playerId); if (player) player.connected = true;
      if (player) { disconnected.delete(player.id); noHumansSince = undefined; }
      const authorityReady = player && bridge && status !== 'LOBBY' ? bridge.controlMode(player.id, 'human').then(() => undefined) : Promise.resolve();
      void authorityReady.catch(() => ws.close(1011, 'SERVER_UNAVAILABLE'));
      broadcastLobby(); updateSubscriptions();
      send(ws, { type: 'communication', state: communication(session.playerId) });
      if (bridge && session.playerId && status !== 'LOBBY') {
        const current = bridge, playerId = session.playerId, requestedMatch = matchId, requestedEpoch = epoch;
        void authorityReady.then(() => requestSocketView(ws, current, playerId, requestedMatch, requestedEpoch)).catch(() => send(ws, { type: 'error', code: 'NO_MATCH' }));
      }
      ws.on('message', async (buffer, binary) => {
        if (!rate(`ws:${session.playerId ?? session.id}`)) return send(ws, { type: 'error', code: 'RATE_LIMITED' });
        if (!sessions.has(session.id) || session.expires < clockNow()) return ws.close(4001, 'SESSION_EXPIRED');
        let message: any; try { if (binary) throw new Error(); message = JSON.parse(buffer.toString()); } catch { return send(ws, { type: 'error', code: 'INVALID_MESSAGE' }); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return send(ws, { type: 'error', code: 'INVALID_MESSAGE' });
        const requestedBridge = bridge, requestedMatch = matchId, requestedEpoch = epoch, requestedPlayer = session.playerId;
        try {
          await authorityReady;
          if (message.type === 'resync' && Object.keys(message).length === 1) {
            if (requestedBridge && requestedPlayer) await requestSocketView(ws, requestedBridge, requestedPlayer, requestedMatch, requestedEpoch); else send(ws, { type: 'lobby', lobby: lobby(session.host) }); return;
          }
          if (message.type === 'loaded' && Object.keys(message).sort().join(',') === 'contentHash,matchEpoch,matchId,type') {
            if (session.playerId && status === 'LOADING' && message.contentHash === matchContent().contentHash && message.matchId === matchId && message.matchEpoch === epoch) { loaded.add(session.playerId); if (humans.every(p => p.connected && loaded.has(p.id))) startCountdown(); }
            else send(ws, { type: 'error', code: 'CONTENT_OR_MATCH_MISMATCH' }); return;
          }
          if (message.protocolVersion !== undefined && message.protocolVersion !== PROTOCOL_VERSION) return send(ws, { type: 'error', code: 'PROTOCOL_VERSION_MISMATCH' });
          if (!validateClientCommand(message)) return send(ws, { type: 'error', code: 'INVALID_COMMAND' });
          if (!bridge || !session.playerId) return send(ws, { type: 'error', code: 'PLAYER_REQUIRED' });
          send(ws, { type: 'receipt', receipt: await bridge.command(session.playerId, message,()=>send(ws,{type:'command_received',commandId:message.clientCommandId,sequence:message.clientSequence})) });
        } catch { send(ws, { type: 'error', code: 'SERVER_UNAVAILABLE' }); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        const publisher = publishers.get(ws); if (publisher instanceof ThreadedViewPublisher) publisher.dispose(); else publisher?.reset(); publishers.delete(ws); transports.delete(ws); sockets.delete(ws);
        if (player) {
          player.connected = [...sockets.values()].some(s => s.playerId === player.id);
          if (!player.connected && humans.includes(player) && bridge && ['COUNTDOWN', 'RUNNING', 'PAUSED'].includes(status)) {
            if (!disconnected.has(player.id)) disconnected.set(player.id, { since: clockNow(), mode: 'grace', decisionRequired: false, decided: false });
            void bridge.controlMode(player.id, 'disconnected').catch(() => {});
            if (humans.every(human => !human.connected)) noHumansSince ??= clockNow();
          }
        }
        broadcastLobby(); updateSubscriptions();
      });
    });
  });
  if (existsSync(staticRoot)) { await app.register(staticFiles, { root: staticRoot, dotfiles: 'deny' }); app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? fail(reply, 'NOT_FOUND', 404) : reply.sendFile('index.html')); }
  app.addHook('preClose', async () => { for (const socket of sockets.keys()) socket.terminate(); wss.close(); });
  app.addHook('onClose', async () => { eventLoopDelay.disable(); isolateMetrics?.close(); clearInterval(cleanup); clearInterval(policyTimer); clearInterval(aiTimer); clearTimeout(loadingTimer); clearTimeout(countdownTimer); await scheduler.close(); if (bridge) await closeMatchWorker(bridge); await replayViewer?.bridge.close(); await Promise.all([...journals.keys()].map(closeMatchWorker)); await publicationWorker?.close();
    // Worker producers are stopped. A completed write can enqueue the retained
    // replacement, so keep draining until both generations have settled.
    while (persistence.size) await Promise.allSettled([...persistence]);
  });
  return { app, bootstrapToken, origins: [...origins], startupEndpoint, ...(performanceMetrics ? {
    // Direct owned-harness access only. Neither function is an HTTP/WS endpoint.
    performanceDiagnostics: async () => ({ main: { ...performanceMetrics.snapshot(), publicationPreparation: options.publicationPreparation ?? 'json', snapshotEncoding, publicationWorker: publicationWorker?.diagnostics(), isolate: isolateMetrics?.snapshot(), aiRenewals: scheduler.renewalDiagnostics() }, ...(await bridge?.performanceDiagnostics() ?? {}) }),
    publicationStamp: (playerId: string, matchId: string, epoch: number, sequence: number) => bridge?.publicationStamp(playerId, matchId, epoch, sequence),
  } : {}) };
}
