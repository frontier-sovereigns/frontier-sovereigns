import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { contentHash, SnapshotAssembler, DeltaAssembler, applyViewDelta, validateAssistantOptionsResponse, validateEndpointDiagnosticsResponse, type PlayerView } from '@frontier/shared';
import { createGameServer } from '../apps/server/src/server.js';
import { defaultEndpointSettings } from '../apps/server/src/ai-endpoint.js';
import { SimulationBridge } from '../apps/server/src/bridge.js';

const root = resolve('runtime-data/assistant-server-tests'), servers: Awaited<ReturnType<typeof createGameServer>>[] = [], directories: string[] = [], sockets: WebSocket[] = [];
const modelServers: HttpServer[] = [];
const origin = 'http://localhost:3000', secret = 'catalog-test-secret-never-returned';
const settings = { ...defaultEndpointSettings(), baseUrl: 'http://127.0.0.1:1/private/v1', model: 'private-served-model', timeoutSeconds: 5 };
type Identity = { cookie: string; csrf: string; playerId?: string };
type Server = Awaited<ReturnType<typeof setup>>;
const preferences = (modelId: string | null, enabled = true) => ({ modelId, enabled, reserve: { food: 75, wood: 125, gold: 25, stone: 10 } });
const identity = (response: any): Identity => ({ cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json().csrfToken, playerId: response.json().playerId });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.app.close();
  for (const server of modelServers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  for (const directory of directories.splice(0)) { const child = relative(root, directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(directory, { recursive: true, force: true }); }
});
async function setup() {
  await mkdir(root, { recursive: true }); const dataDir = await mkdtemp(join(root, 'case-')); directories.push(dataDir);
  const server = await createGameServer({ dataDir, bootstrapToken: 'assistant-test-bootstrap', publicationThread: false }); servers.push(server); await server.app.ready();
  return Object.assign(server, { dataDir });
}
async function post(server: Server, url: string, payload: unknown, session?: Identity) { return server.app.inject({ method: 'POST', url, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, payload: payload as any }); }
async function get(server: Server, url: string, session?: Identity) { return server.app.inject({ url, headers: session ? { cookie: session.cookie } : {} }); }
async function admin(server: Server) { const response = await post(server, '/api/bootstrap', { token: 'assistant-test-bootstrap' }); expect(response.statusCode).toBe(200); return { ...identity(response), invite: response.json().lobby.inviteCode as string }; }
async function joinPlayer(server: Server, host: Awaited<ReturnType<typeof admin>>, name: string) { const response = await post(server, '/api/join', { name, inviteCode: host.invite }); expect(response.statusCode, response.body).toBe(200); return identity(response); }
async function addModel(server: Server, host: Identity, id = 'personal') { const response = await post(server, '/api/host/models', { id, label: `Choice ${id}`, enabled: true, settings, apiKey: secret }, host); expect(response.statusCode, response.body).toBe(200); return response; }
async function connect(server: Server, player: Identity) {
  const port = (server.app.server.address() as { port: number }).port, socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin, cookie: player.cookie } }); sockets.push(socket);
  let view: PlayerView | undefined; const assembly = new SnapshotAssembler(), deltaAssembly = new DeltaAssembler(), messages: any[] = [];
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString()); messages.push(message);
    if (message.type === 'snapshot_chunk') { deltaAssembly.reset(); const result = assembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'complete') view = result.view; }
    else if (message.type === 'snapshot') { assembly.reset(); deltaAssembly.reset(); view = message.view; }
    else if (message.type === 'delta_chunk') { if (!view) throw new Error('DELTA_WITHOUT_BASE'); const result = deltaAssembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'complete') { const next = applyViewDelta(view, result.delta); if (!next) throw new Error('INVALID_TEST_DELTA'); view = next; } }
    else if (message.type === 'delta' && view) { deltaAssembly.reset(); view = applyViewDelta(view, message.delta); }
    if (view?.status === 'LOADING') socket.send(JSON.stringify({ type: 'loaded', contentHash: view.contentHash, matchId: view.matchId, matchEpoch: view.matchEpoch }));
  });
  await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  return { socket, messages, view: () => view };
}
async function runningAssistantFixture() {
  const server = await setup(), host = await admin(server), player = await joinPlayer(server, host, 'Race owner'); await addModel(server, host);
  expect((await post(server, '/api/assistant', preferences('personal', false), player)).statusCode).toBe(200);
  await server.app.listen({ port: 0, host: '127.0.0.1' }); const client = await connect(server, player);
  expect((await post(server, '/api/ready', { ready: true }, player)).statusCode).toBe(200);
  expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => client.view()?.status, { timeout: 15000 }).toBe('RUNNING');
  return { server, host, player, client };
}

describe('host catalog and player assistant HTTP authority', () => {
  it('rejects assistant, model, endpoint and restore mutations while a resume acknowledgement is in flight', async () => {
    const { server, host, player, client } = await runningAssistantFixture();
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    await addModel(server, host, 'unused');
    const worker = client.view()!.entities.find(entity => entity.ownerId === player.playerId && entity.typeId === 'villager')!;
    const original = SimulationBridge.prototype.status; let entered = false, release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    vi.spyOn(SimulationBridge.prototype, 'status').mockImplementation(function (this: SimulationBridge, target, invalidate) {
      const reply = original.call(this, target, invalidate);
      return target === 'RUNNING' && invalidate ? reply.then(async value => { entered = true; await gate; return value; }) : reply;
    });
    const configured = vi.spyOn(SimulationBridge.prototype, 'configureAssistant'), released = vi.spyOn(SimulationBridge.prototype, 'releaseAssistantEntities'), assigned = vi.spyOn(SimulationBridge.prototype, 'setAiModel');
    const resume = post(server, '/api/host/pause', { paused: false }, host);
    try {
      await expect.poll(() => entered, { timeout: 3000 }).toBe(true);
      const requests: [string, unknown, Identity][] = [
        ['/api/assistant', preferences('personal'), player],
        ['/api/assistant/release', { entityIds: [worker.id] }, player],
        ['/api/host/ai-model', { playerId: 'ai_1', modelId: 'personal' }, host],
        ['/api/host/endpoint', { settings }, host],
        ['/api/host/endpoint/test', { listModels: false }, host],
        ['/api/host/models', { id: 'personal', label: 'Changed during resume', enabled: false, settings }, host],
        ['/api/host/models/personal/test', { listModels: false }, host],
        ['/api/host/load', { saveId: 'not-read', confirmed: true }, host],
        ['/api/host/load-latest', { confirmed: true }, host],
      ];
      for (const [url, payload, session] of requests) { const response = await post(server, url, payload, session); expect(response.statusCode, url).toBe(409); expect(response.json().code, url).toBe('PAUSE_BUSY'); }
      const removed = await server.app.inject({ method: 'DELETE', url: '/api/host/models/unused', headers: { origin, cookie: host.cookie, 'x-csrf-token': host.csrf } });
      expect(removed.statusCode).toBe(409); expect(removed.json().code).toBe('PAUSE_BUSY');
      expect(configured).not.toHaveBeenCalled(); expect(released).not.toHaveBeenCalled(); expect(assigned).not.toHaveBeenCalled();
      expect((await get(server, '/api/assistant', player)).json().assistant.preferences).toEqual(preferences('personal', false));
      const catalog = (await get(server, '/api/host/models', host)).json();
      expect(catalog.models.find((item: any) => item.id === 'personal')).toMatchObject({ label: 'Choice personal', enabled: true });
      expect(catalog.models.some((item: any) => item.id === 'unused')).toBe(true);
    } finally { release(); expect((await resume).statusCode).toBe(200); }
  }, 30000);

  it('rejects pause until an already committed assistant preference acknowledgement finishes', async () => {
    const { server, host, player } = await runningAssistantFixture(), original = SimulationBridge.prototype.configureAssistant;
    let entered = false, release!: () => void; const gate = new Promise<void>(done => { release = done; });
    vi.spyOn(SimulationBridge.prototype, 'configureAssistant').mockImplementation(function (this: SimulationBridge, ...args) {
      return original.apply(this, args).then(async value => { entered = true; await gate; return value; });
    });
    const status = vi.spyOn(SimulationBridge.prototype, 'status'), prefs = preferences('personal', false); prefs.reserve.food = 90;
    const change = post(server, '/api/assistant', prefs, player);
    try {
      await expect.poll(() => entered, { timeout: 3000 }).toBe(true);
      const paused = await post(server, '/api/host/pause', { paused: true }, host);
      expect(paused.statusCode).toBe(409); expect(paused.json().code).toBe('ASSISTANT_BUSY'); expect(status).not.toHaveBeenCalled();
      expect((await get(server, '/api/session', host)).json().lobby.status).toBe('RUNNING');
    } finally { release(); const result = await change; expect(result.statusCode, result.body).toBe(200); expect(result.json().assistant.preferences).toEqual(prefs); }
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    expect((await get(server, '/api/assistant', player)).json().assistant.preferences).toEqual(prefs);
  }, 30000);

  it('routes two assisted humans and a server bot to their selected models through real HTTP and isolated worker plans', async () => {
    const calls: { model: string; observation: any; authorized: boolean }[] = [], fixtureErrors: string[] = [];
    const endpoint = createServer((request, response) => {
      void (async () => {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
        let body = ''; for await (const part of request) { body += part.toString(); if (Buffer.byteLength(body) > 65536) throw new Error('FIXTURE_REQUEST_LIMIT'); }
        const message = JSON.parse(body), observation = JSON.parse(message.messages.find((entry: any) => entry.role === 'user').content);
        calls.push({ model: message.model, observation, authorized: request.headers.authorization === `Bearer ${secret}` });
        const plan = { schemaVersion: 1, observationId: observation.identity.observationId, strategy: 'Maintain six workers using our own economy.', goals: [{ kind: 'ensure_units', unitType: 'villager', targetCount: 6 }], message: null };
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(plan) } }], usage: { prompt_tokens: 1000, completion_tokens: 70, total_tokens: 1070 } }));
      })().catch(() => { fixtureErrors.push('FIXTURE_REQUEST_FAILED'); if (!response.headersSent) response.writeHead(400); response.end(); });
    });
    modelServers.push(endpoint); await new Promise<void>(done => endpoint.listen(0, '127.0.0.1', done));
    const modelPort = (endpoint.address() as { port: number }).port;
    const server = await setup(), host = await admin(server), first = await joinPlayer(server, host, 'First owner'), second = await joinPlayer(server, host, 'Second owner');
    expect((await post(server, '/api/host/lobby', { aiCount: 1, teamPreset: 'free_for_all', sharedVision: false }, host)).statusCode).toBe(200);
    expect((await post(server, '/api/host/seed', { seed: 'isolated-assistant-endpoints' }, host)).statusCode).toBe(200);
    const assignments = [{ playerId: first.playerId!, catalogId: 'first_model', served: 'fixture-human-one' }, { playerId: second.playerId!, catalogId: 'second_model', served: 'fixture-human-two' }, { playerId: 'ai_1', catalogId: 'bot_model', served: 'fixture-server-bot' }];
    for (const assignment of assignments) {
      const saved = await post(server, '/api/host/models', { id: assignment.catalogId, label: assignment.catalogId, enabled: true, settings: { ...defaultEndpointSettings(), baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: assignment.served, timeoutSeconds: 5, maxConcurrent: 2 }, apiKey: secret }, host);
      expect(saved.statusCode, saved.body).toBe(200);
    }
    expect((await post(server, '/api/assistant', preferences('first_model'), first)).statusCode).toBe(200);
    expect((await post(server, '/api/assistant', preferences('second_model'), second)).statusCode).toBe(200);
    expect((await post(server, '/api/host/ai-model', { playerId: 'ai_1', modelId: 'bot_model' }, host)).statusCode).toBe(200);
    await server.app.listen({ port: 0, host: '127.0.0.1' }); const firstClient = await connect(server, first), secondClient = await connect(server, second);
    for (const owner of [first, second]) expect((await post(server, '/api/ready', { ready: true }, owner)).statusCode).toBe(200);
    expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
    await expect.poll(() => [firstClient.view()?.status, secondClient.view()?.status], { timeout: 15000 }).toEqual(['RUNNING', 'RUNNING']);
    const view = firstClient.view()!, worker = view.entities.find(entity => entity.ownerId === first.playerId && entity.typeId === 'villager')!;
    firstClient.socket.send(JSON.stringify({ protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: 'hold_during_inference', clientSequence: view.self.lastCommandSequence + 1, command: { kind: 'hold_position', unitIds: [worker.id] } }));
    await expect.poll(() => firstClient.messages.find(message => message.type === 'receipt' && message.receipt.clientCommandId === 'hold_during_inference')?.receipt.status, { timeout: 3000 }).toBe('accepted');
    await expect.poll(async () => {
      const diagnostics = (await get(server, '/api/host/diagnostics', host)).json();
      return assignments.every(assignment => diagnostics.scheduler.commanders.some((commander: any) => commander.playerId === assignment.playerId && commander.lastStatus === 'PLAN_ACCEPTED' && commander.lastAcceptedAt !== null));
    }, { timeout: 15000, interval: 500 }).toBe(true);
    expect(fixtureErrors).toEqual([]);
    for (const assignment of assignments) {
      const requests = calls.filter(call => call.observation.player.id === assignment.playerId); expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(call => call.model === assignment.served && call.authorized)).toBe(true);
      const observation = requests[0]!.observation;
      expect(observation.identity.playerId).toBe(assignment.playerId); expect(observation.memory.facts.every((fact: any) => fact.sourcePlayerId === assignment.playerId)).toBe(true);
      expect(observation.enemies.visibleComposition).toEqual({}); expect(observation.enemies.lastKnownThreats).toEqual([]);
      expect(observation.references.some((reference: any) => ['enemy_memory', 'ally_anchor'].includes(reference.kind))).toBe(false);
      const ownBase = observation.references.find((reference: any) => reference.kind === 'own_base')!.position;
      for (const other of assignments.filter(item => item.playerId !== assignment.playerId)) {
        const enemyBase = calls.find(call => call.observation.player.id === other.playerId)!.observation.references.find((reference: any) => reference.kind === 'own_base')!.position;
        expect(ownBase).not.toEqual(enemyBase); expect(observation.references.some((reference: any) => reference.position?.xMm === enemyBase.xMm && reference.position?.zMm === enemyBase.zMm)).toBe(false);
      }
    }
    await expect.poll(() => firstClient.view()?.players.find(player => player.id === 'ai_1')?.aiMode, { timeout: 3000 }).toBe('model');
    expect((await get(server, '/api/assistant', first)).json().assistant).toMatchObject({ status: 'model', protectedEntityIds: expect.arrayContaining([worker.id]) });
    expect((await get(server, '/api/assistant', second)).json().assistant.status).toBe('model');
    expect(firstClient.view()!.entities.some(entity => entity.ownerId === 'ai_1' || entity.ownerId === second.playerId)).toBe(false);
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    for (const enabled of [false, true]) {
      const changed = await post(server, '/api/assistant', preferences('first_model', enabled), first); expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().assistant.protectedEntityIds).toContain(worker.id);
    }
    const publicTraffic = JSON.stringify([firstClient.messages, secondClient.messages]);
    for (const hidden of [secret, `http://127.0.0.1:${modelPort}`, ...assignments.map(assignment => assignment.served)]) expect(publicTraffic).not.toContain(hidden);
  }, 60000);
  it('keeps model credentials private and selections isolated across human and all five AI slots', async () => {
    const server = await setup(), host = await admin(server), first = await joinPlayer(server, host, 'One'), second = await joinPlayer(server, host, 'Two');
    expect((await get(server, '/api/assistant')).statusCode).toBe(403);
    expect((await get(server, '/api/host/models', first)).statusCode).toBe(403);
    expect((await post(server, '/api/host/models', { label: 'Forbidden', enabled: true, settings }, first)).statusCode).toBe(403);
    const created = await addModel(server, host); expect(created.body).not.toContain(secret); expect(created.json().hasApiKey).toBe(true);
    const before = await get(server, '/api/assistant', first); expect(validateAssistantOptionsResponse(before.json())).toBe(true);
    for (const hidden of [secret, settings.baseUrl, settings.model, 'apiKey', 'providerOptions']) expect(before.body).not.toContain(hidden);
    expect(before.json().models.find((item: any) => item.id === 'personal')).toEqual({ id: 'personal', label: 'Choice personal', available: true });
    expect((await post(server, '/api/assistant', { ...preferences('personal'), playerId: second.playerId }, first)).statusCode).toBe(400);
    expect((await post(server, '/api/assistant', preferences('personal'), first)).statusCode).toBe(200);
    expect((await get(server, '/api/assistant', second)).json().assistant.preferences.enabled).toBe(false);
    expect((await post(server, '/api/host/lobby', { aiCount: 5 }, host)).statusCode).toBe(200);
    for (let index = 1; index <= 5; index++) expect((await post(server, '/api/host/ai-model', { playerId: `ai_${index}`, modelId: 'personal' }, host)).statusCode).toBe(200);
    const lobby = (await get(server, '/api/session', first)).json().lobby;
    expect(lobby.players.filter((player: any) => player.kind === 'ai').map((player: any) => player.aiModelId)).toEqual(Array(5).fill('personal'));
    expect(lobby.players.filter((player: any) => player.kind === 'human')).toHaveLength(2);
    const serialized = JSON.stringify(lobby); expect(serialized).not.toContain('reserve'); expect(serialized).not.toContain(secret); expect(serialized).not.toContain(settings.baseUrl);
    const stored = JSON.parse(await readFile(join(server.dataDir, 'ai-models.local.json'), 'utf8')); expect(stored.models[0].apiKey).toBe(secret);
    expect(validateEndpointDiagnosticsResponse((await get(server, '/api/host/diagnostics', host)).json())).toBe(true);
  });
  it('requires CSRF for catalog mutation and allows pausing a disabled selected model', async () => {
    const server = await setup(), host = await admin(server), player = await joinPlayer(server, host, 'Owner'); await addModel(server, host);
    const forged = await server.app.inject({ method: 'POST', url: '/api/host/models', headers: { origin, cookie: host.cookie }, payload: { id: 'personal', label: 'Changed', enabled: false, settings } }); expect(forged.statusCode).toBe(403);
    expect((await post(server, '/api/assistant', preferences('personal'), player)).statusCode).toBe(200);
    expect((await post(server, '/api/host/models', { id: 'personal', label: 'Disabled', enabled: false, settings }, host)).statusCode).toBe(200);
    const disabled = (await get(server, '/api/assistant', player)).json(); expect(disabled.assistant.status).toBe('unavailable'); expect(disabled.models.some((item: any) => item.id === 'personal')).toBe(false);
    expect((await post(server, '/api/assistant', preferences('personal', false), player)).statusCode).toBe(200);
    const removed = await server.app.inject({ method: 'DELETE', url: '/api/host/models/personal', headers: { origin, cookie: host.cookie, 'x-csrf-token': host.csrf } }); expect(removed.statusCode).toBe(409); expect(removed.json().code).toBe('MODEL_IN_USE');
    expect((await post(server, '/api/assistant', preferences(null, false), player)).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'DELETE', url: '/api/host/models/personal', headers: { origin, cookie: host.cookie, 'x-csrf-token': host.csrf } })).statusCode).toBe(200);
  });
  it('preserves selections, reserves and manual unit protection through an authoritative save and rejoin', async () => {
    const server = await setup(), host = await admin(server), player = await joinPlayer(server, host, 'Owner'); await addModel(server, host);
    // Disabled assistance exercises save authority without inference/network requests.
    expect((await post(server, '/api/assistant', preferences('personal', false), player)).statusCode).toBe(200);
    expect((await post(server, '/api/host/ai-model', { playerId: 'ai_1', modelId: 'personal' }, host)).statusCode).toBe(200);
    await post(server, '/api/host/models', { id: 'personal', label: 'Saved choice', enabled: false, settings }, host);
    await server.app.listen({ port: 0, host: '127.0.0.1' }); const client = await connect(server, player);
    expect((await post(server, '/api/ready', { ready: true }, player)).statusCode).toBe(200);
    expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
    await expect.poll(() => client.view()?.status, { timeout: 15000 }).toBe('RUNNING');
    const view = client.view()!, worker = view.entities.find(entity => entity.ownerId === player.playerId && entity.typeId === 'villager')!;
    client.socket.send(JSON.stringify({ protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: 'manual_pin', clientSequence: view.self.lastCommandSequence + 1, command: { kind: 'hold_position', unitIds: [worker.id] } }));
    await expect.poll(() => client.messages.find(message => message.type === 'receipt' && message.receipt.clientCommandId === 'manual_pin')?.receipt.status, { timeout: 3000 }).toBe('accepted');
    expect((await get(server, '/api/assistant', player)).json().assistant.protectedEntityIds).toContain(worker.id);
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    expect((await post(server, '/api/host/save', { name: 'Assistant authority' }, host)).statusCode).toBe(200);
    const listing = await get(server, '/api/host/recovery', host); expect(listing.statusCode, listing.body).toBe(200);
    const saved = listing.json().saves.find((item: any) => item.kind === 'manual'); expect(saved).toBeDefined();
    const bytes = await readFile(join(server.dataDir, 'saves', `${saved.id}.json`), 'utf8'); for (const hidden of [secret, settings.baseUrl, settings.model]) expect(bytes).not.toContain(hidden);
    const loaded = await post(server, '/api/host/load', { saveId: saved.id, confirmed: true }, host); expect(loaded.statusCode, loaded.body).toBe(200);
    expect(loaded.json().lobby.players.find((item: any) => item.id === 'ai_1').aiModelId).toBe('personal');
    const invitation = await post(server, '/api/host/rejoin-invite', { playerId: player.playerId }, host), rejoined = await post(server, '/api/rejoin', { token: invitation.json().token }); expect(rejoined.statusCode, rejoined.body).toBe(200);
    const resumed = identity(rejoined), state = (await get(server, '/api/assistant', resumed)).json(); expect(state.assistant.preferences).toEqual(preferences('personal', false)); expect(state.assistant.protectedEntityIds).toContain(worker.id);
    expect((await post(server, '/api/assistant/release', { entityIds: [worker.id] }, resumed)).statusCode).toBe(200);
    expect((await get(server, '/api/assistant', resumed)).json().assistant.protectedEntityIds).not.toContain(worker.id);
  });
});
