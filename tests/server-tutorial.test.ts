import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { SnapshotAssembler, DeltaAssembler, applyViewDelta, balance, contentHash, sha256, type CommandReceipt, type GameplayCommand, type PlayerView } from '@frontier/shared';
import { createGameServer } from '../apps/server/src/server.js';
import { defaultEndpointSettings } from '../apps/server/src/ai-endpoint.js';
import { buildingCommand } from '../packages/simulation/src/caretaker.js';
import type { SimulationSavePayload } from '../packages/simulation/src/persistence-types.js';

const testRoot = resolve('runtime-data/server-tutorial-tests'), origin = 'http://localhost:3000';
const practiceSettings = { tutorial: true, aiCount: 1, teamPreset: 'free_for_all', caretakerEnabled: false, monumentVictory: false };
let directory: string | undefined, server: Awaited<ReturnType<typeof createGameServer>> | undefined, model: Server | undefined, time = Date.now();
type Identity = { cookie: string; csrf: string; body: any };
afterEach(async () => {
  await server?.app.close(); server = undefined;
  if (model) { model.closeAllConnections(); await new Promise<void>(done => model!.close(() => done())); model = undefined; }
  if (directory) {
    const child = relative(testRoot, directory);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(directory, { recursive: true, force: true }); directory = undefined;
  }
});
const identity = (response: any): Identity => ({ cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json().csrfToken, body: response.json() });
async function post(url: string, payload: Record<string, unknown>, who?: Identity) {
  // This clock only spaces HTTP rate-limit tokens; the worker uses its real 20 Hz clock.
  time += 2500;
  return server!.app.inject({ method: 'POST', url, headers: { origin, ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, payload });
}
const get = (url: string, who: Identity) => server!.app.inject({ url, headers: { cookie: who.cookie } });
async function setup() {
  await mkdir(testRoot, { recursive: true }); directory = await mkdtemp(join(testRoot, 'case-'));
  server = await createGameServer({ bootstrapToken: 'tutorial-bootstrap', dataDir: directory, clock: () => time }); await server.app.ready();
  const response = await post('/api/bootstrap', { token: 'tutorial-bootstrap' }); expect(response.statusCode).toBe(200); return identity(response);
}
async function connect(who: Identity) {
  const address = server!.app.server.address() as { port: number }, assembly = new SnapshotAssembler(), deltaAssembly = new DeltaAssembler();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: who.cookie } });
  const receipts = new Map<string, CommandReceipt>(), errors: string[] = []; let latest: PlayerView | undefined, sequence = 0, loadedKey = '';
  socket.on('message', data => {
    try {
      const message = JSON.parse(String(data));
      if (message.type === 'snapshot_chunk') { deltaAssembly.reset(); const result = assembly.push(message, Date.now()); if (result.status === 'complete') latest = result.view; else if (result.status === 'rejected') errors.push(result.code); }
      else if (message.type === 'delta_chunk') { if (!latest) throw new Error('DELTA_WITHOUT_BASE'); const result = deltaAssembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'complete') { const next = applyViewDelta(latest, result.delta); if (!next) throw new Error('INVALID_DELTA'); latest = next; } }
      else if (message.type === 'delta') { deltaAssembly.reset(); if (!latest) throw new Error('DELTA_WITHOUT_BASE'); const next = applyViewDelta(latest, message.delta); if (!next) throw new Error('INVALID_DELTA'); latest = next; }
      else if (message.type === 'snapshot') { assembly.reset(); deltaAssembly.reset(); latest = message.view; }
      else if (message.type === 'receipt') receipts.set(message.receipt.clientCommandId, message.receipt);
      else if (message.type === 'error') errors.push(message.code);
      if (latest?.status === 'LOADING' && loadedKey !== `${latest.matchId}:${latest.matchEpoch}`) {
        loadedKey = `${latest.matchId}:${latest.matchEpoch}`;
        socket.send(JSON.stringify({ type: 'loaded', contentHash: latest.contentHash, matchId: latest.matchId, matchEpoch: latest.matchEpoch }));
      }
    } catch (error) { errors.push(String(error)); }
  });
  await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); });
  return { socket, latest: () => latest, errors, async command(command: GameplayCommand) {
    const view = latest!, clientCommandId = `tutorial-${++sequence}`;
    socket.send(JSON.stringify({ protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId, clientSequence: Math.max(sequence, view.self.lastCommandSequence + 1), command }));
    await expect.poll(() => ({ received: receipts.has(clientCommandId), errors }), { timeout: 3000 }).toEqual({ received: true, errors: [] }); return receipts.get(clientCommandId)!;
  } };
}
async function beginPractice(host: Identity) {
  expect((await post('/api/host/lobby', practiceSettings, host)).statusCode).toBe(200);
  expect((await post('/api/host/seed', { seed: 'm7-quiet-practice-gateway' }, host)).statusCode).toBe(200);
  const joined = await post('/api/join', { name: 'Practice host', inviteCode: host.body.lobby.inviteCode, hostPlayer: true }, host);
  expect(joined.statusCode, joined.body).toBe(200); host.body = joined.json();
  await server!.app.listen({ port: 0, host: '127.0.0.1' }); const client = await connect(host);
  expect((await post('/api/ready', { ready: true }, host)).statusCode).toBe(200);
  expect((await post('/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => client.latest()?.status, { timeout: 15000 }).toBe('RUNNING'); return client;
}
async function endpoint(host: Identity) {
  let calls = 0;
  model = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
      calls++;
      const body = JSON.parse(Buffer.concat(chunks).toString()), user = body.messages?.find((message: { role: string }) => message.role === 'user');
      let observation: any; try { observation = JSON.parse(user?.content ?? '{}'); } catch { observation = {}; }
      const observationId = observation.identity?.observationId;
      const answer = observationId ? { schemaVersion: 1, observationId, strategy: 'Continue normal autonomous economy.', goals: [], message: null } : { ok: true };
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  await new Promise<void>(done => model!.listen(0, '127.0.0.1', done));
  const address = model.address() as { port: number }, settings = { ...defaultEndpointSettings(), baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'tutorial-local-model', intervalSeconds: { easy: 10, medium: 10, hard: 10 } };
  const response = await post('/api/host/endpoint', { settings }, host); expect(response.statusCode, response.body).toBe(200);
  return { calls: () => calls, settings };
}
async function save(host: Identity, label: string) {
  const response = await post('/api/host/save', { name: label }, host); expect(response.statusCode, response.body).toBe(200);
  const summary = (await get('/api/host/recovery', host)).json().saves.find((item: { label: string }) => item.label === label); expect(summary).toBeDefined();
  const path = join(directory!, 'saves', `${summary.id}.json`), bytes = await readFile(path, 'utf8'), record = JSON.parse(bytes);
  return { id: summary.id as string, path, bytes, record, game: record.payload.game.payload as SimulationSavePayload };
}
function expectQuiet(game: SimulationSavePayload) {
  expect(game.options.controllers).toBe(false);
  const ai = game.state.factions.find(faction => faction.kind === 'ai')!;
  expect(game.state.commandLog.filter(command => command.playerId === ai.id)).toEqual([]);
  expect(game.state.economies[ai.id]!.resources).toEqual(Object.fromEntries(Object.entries(balance.start.resources).map(([resource, amount]) => [resource, amount * 1000])));
  const units = Object.values(game.state.entities).filter(entity => entity.ownerId === ai.id && entity.kind === 'unit');
  expect(units.filter(unit => unit.typeId === 'villager')).toHaveLength(6); expect(units.filter(unit => unit.typeId === 'scout')).toHaveLength(1);
  for (const unit of units) if (unit.kind === 'unit') expect(unit.orders).toEqual([]);
}
function reseal(value: any) { const { checksum: _checksum, ...body } = value; value.checksum = sha256(JSON.stringify(body)); }

it('restricts quiet practice to one host and one opposing AI, while ordinary lobbies remain configurable', async () => {
  const host = await setup(); expect((await post('/api/host/lobby', practiceSettings, host)).statusCode).toBe(200);
  expect((await post('/api/host/start', {}, host)).json().code).toBe('PLAYERS_NOT_READY');
  expect((await post('/api/join', { name: 'Remote', inviteCode: host.body.lobby.inviteCode })).json().code).toBe('PRACTICE_HOST_PLAYER_ONLY');
  expect((await post('/api/host/team', { playerId: 'ai_1', teamId: 'another-team' }, host)).json().code).toBe('PRACTICE_TEAMS_FIXED');
  for (const invalid of [{ aiCount: 0 }, { aiCount: 2 }, { teamPreset: 'custom' }, { caretakerEnabled: true }, { monumentVictory: true }]) {
    const response = await post('/api/host/lobby', invalid, host); expect(response.statusCode, response.body).toBe(409);
    expect((await get('/api/session', host)).json().lobby.settings).toMatchObject(practiceSettings);
  }
  expect((await post('/api/host/lobby', { tutorial: false }, host)).statusCode).toBe(200);
  expect((await post('/api/host/team', { playerId: 'ai_1', teamId: 'ordinary-team' }, host)).statusCode).toBe(200);
  const remote = await post('/api/join', { name: 'Ordinary remote', inviteCode: host.body.lobby.inviteCode }); expect(remote.statusCode).toBe(200);
  expect((await post('/api/host/lobby', practiceSettings, host)).json().code).toBe('PRACTICE_REQUIRES_ONE_HOST_AND_ONE_OPPONENT');
});

it('preserves fixed free-for-all teams when the valid practice AI count is sent without a preset', async () => {
  const host = await setup(); await post('/api/host/lobby', practiceSettings, host);
  const response = await post('/api/host/lobby', { aiCount: 1 }, host); expect(response.statusCode).toBe(200);
  expect(response.json().lobby.settings).toMatchObject(practiceSettings);
  expect((await post('/api/host/lobby', { mapType: 'river_divide' }, host)).statusCode).toBe(200);
});

it('uses standard banks and real movement, gathering and construction while practice AI and inference stay quiet, then reactivates normal play', async () => {
  const host = await setup(), inference = await endpoint(host), client = await beginPractice(host), initial = client.latest()!;
  expect(initial.self.resources).toEqual(balance.start.resources); expect(initial.self.age).toBe(balance.start.age); expect(initial.players).toHaveLength(2);
  const own = initial.entities.filter(entity => entity.ownerId === initial.playerId), workers = own.filter(entity => entity.typeId === 'villager'), scout = own.find(entity => entity.typeId === 'scout')!, home = own.find(entity => entity.typeId === 'town_center')!;
  expect(workers).toHaveLength(6); expect(own.filter(entity => entity.typeId === 'house')).toHaveLength(1);
  expect(initial.entities.some(entity => entity.ownerId && entity.ownerId !== initial.playerId)).toBe(false);
  expect((await client.command({ kind: 'move', unitIds: [scout.id], target: { xMm: scout.xMm + 4000, zMm: scout.zMm }, queued: false })).status).toBe('accepted');
  const food = initial.entities.filter(entity => entity.kind === 'resource' && entity.resource === 'food' && !entity.ghost).sort((a, b) => Math.hypot(a.xMm - workers[0]!.xMm, a.zMm - workers[0]!.zMm) - Math.hypot(b.xMm - workers[0]!.xMm, b.zMm - workers[0]!.zMm))[0]!;
  expect(food).toBeDefined(); expect((await client.command({ kind: 'gather', unitIds: [workers[0]!.id], targetId: food.id, queued: false })).status).toBe('accepted');
  let built = false;
  for (let attempt = 0; attempt < 8 && !built; attempt++) {
    const command = buildingCommand(client.latest()!, 'house', home, workers.slice(1), attempt); if (!command || command.kind !== 'build') continue;
    built = (await client.command({ ...command, builderIds: workers.slice(1).map(worker => worker.id) })).status === 'accepted';
  }
  expect(built).toBe(true);
  await expect.poll(() => { const unit = client.latest()?.entities.find(entity => entity.id === scout.id); return unit ? Math.hypot(unit.xMm - scout.xMm, unit.zMm - scout.zMm) : 0; }, { timeout: 5000 }).toBeGreaterThan(500);
  await expect.poll(() => client.latest()?.entities.filter(entity => entity.ownerId === initial.playerId && entity.typeId === 'house' && entity.progress === 1).length, { timeout: 20000 }).toBe(2);
  await expect.poll(() => client.latest()?.self.recentLedger?.some(entry => entry.reason === 'deposit' && entry.resource === 'food' && entry.deltaMilli > 0), { timeout: 25000 }).toBe(true);
  expect(client.latest()!.self.resources.food).toBeGreaterThan(balance.start.resources.food);
  expect((await post('/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
  const quiet = await save(host, 'Quiet standard practice'); expectQuiet(quiet.game); expect(quiet.game.state.tick).toBeGreaterThan(200); expect(inference.calls()).toBe(0);
  const diagnostic = (await get('/api/host/diagnostics', host)).json(); expect(diagnostic.scheduler.active).toBe(0); expect(diagnostic.scheduler.completed).toBe(0);
  expect((await post('/api/host/endpoint', { settings: inference.settings }, host)).statusCode).toBe(200);
  expect((await post('/api/host/pause', { paused: false }, host)).statusCode).toBe(200);
  await expect.poll(() => client.latest()?.tick, { timeout: 4000 }).toBeGreaterThan(quiet.game.state.tick + 20); expect(inference.calls()).toBe(0);

  expect((await post('/api/host/end-draw', { confirmed: true }, host)).statusCode).toBe(200);
  expect((await post('/api/host/reset', {}, host)).statusCode).toBe(200);
  expect((await post('/api/host/lobby', { tutorial: false }, host)).statusCode).toBe(200);
  await post('/api/ready', { ready: true }, host); expect((await post('/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => client.latest()?.matchId !== initial.matchId && client.latest()?.status === 'RUNNING', { timeout: 15000 }).toBe(true);
  await expect.poll(inference.calls, { timeout: 6000 }).toBeGreaterThan(0);
  await expect.poll(() => client.latest()?.tick, { timeout: 6000 }).toBeGreaterThan(80);
  expect((await post('/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
  const normal = await save(host, 'Normal mode reactivated'); expect(normal.game.options.controllers).toBe(true);
  expect(normal.game.state.commandLog.some(command => command.playerId === 'ai_1')).toBe(true); expect(client.errors).toEqual([]);
}, 75000);

it('restores quiet practice without attaching inference and rejects rechecksummed tutorial/controller metadata mismatches', async () => {
  const host = await setup(), inference = await endpoint(host), client = await beginPractice(host), playerId = client.latest()!.playerId;
  await expect.poll(() => client.latest()?.tick, { timeout: 4000 }).toBeGreaterThan(20);
  expect((await post('/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
  const saved = await save(host, 'Practice restore'); expectQuiet(saved.game); expect(saved.record.payload.lobby.settings.tutorial).toBe(true);
  for (const mismatch of ['tutorial', 'controllers']) {
    const tampered = structuredClone(saved.record);
    if (mismatch === 'tutorial') tampered.payload.lobby.settings.tutorial = false;
    else { tampered.payload.game.payload.options.controllers = true; reseal(tampered.payload.game); }
    reseal(tampered); await writeFile(saved.path, JSON.stringify(tampered));
    const rejected = await post('/api/host/load', { saveId: saved.id, confirmed: true }, host);
    expect(rejected.statusCode, rejected.body).toBe(400); expect(rejected.json().code).toBe('SAVE_PAYLOAD_INVALID');
    expect((await get('/api/session', host)).json().lobby).toMatchObject({ status: 'PAUSED', settings: { tutorial: true } });
  }
  await writeFile(saved.path, saved.bytes);
  const loaded = await post('/api/host/load', { saveId: saved.id, confirmed: true }, host); expect(loaded.statusCode, loaded.body).toBe(200);
  expect(loaded.json().lobby).toMatchObject({ status: 'PAUSED', settings: practiceSettings });
  const invite = await post('/api/host/rejoin-invite', { playerId }, host); expect(invite.statusCode).toBe(200);
  const joined = await post('/api/rejoin', { token: invite.json().token }, host); expect(joined.statusCode, joined.body).toBe(200);
  const recoveredHost = identity(joined), recovered = await connect(recoveredHost);
  expect((await post('/api/host/endpoint', { settings: inference.settings }, recoveredHost)).statusCode).toBe(200);
  expect((await post('/api/host/pause', { paused: false }, recoveredHost)).statusCode).toBe(200);
  await expect.poll(() => recovered.latest()?.tick, { timeout: 6000 }).toBeGreaterThan(saved.game.state.tick + 60);
  expect(recovered.latest()!.matchEpoch).toBeGreaterThan(saved.game.state.matchEpoch);
  expect((await post('/api/host/pause', { paused: true }, recoveredHost)).statusCode).toBe(200);
  const continued = await save(recoveredHost, 'Practice continued'); expectQuiet(continued.game);
  expect(continued.record.payload.lobby.settings.tutorial).toBe(true); expect(inference.calls()).toBe(0); expect(recovered.errors).toEqual([]);
}, 35000);
