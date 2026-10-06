import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import { SnapshotAssembler, DeltaAssembler, applyViewDelta, contentHash, validateChatStateResponse, validateEndpointDiagnosticsResponse, validateEndpointStateResponse, type PlayerView } from '@frontier/shared';
import { createGameServer } from '../apps/server/src/server.js';
import { defaultEndpointSettings } from '../apps/server/src/ai-endpoint.js';
import { SimulationBridge } from '../apps/server/src/bridge.js';

const root = resolve('runtime-data/server-m6-tests'), origin = 'http://localhost:3000';
let directory: string | undefined, server: Awaited<ReturnType<typeof createGameServer>> | undefined, model: Server | undefined, time = Date.now();
type Identity = { cookie: string; csrf: string; body: any };
afterEach(async () => {
  vi.restoreAllMocks();
  await server?.app.close(); server = undefined;
  if (model) { model.closeAllConnections(); await new Promise<void>(done => model!.close(() => done())); model = undefined; }
  if (directory) { const child = relative(root, directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
const identity = (response: any): Identity => ({ cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json().csrfToken, body: response.json() });
async function post(url: string, payload: unknown, who?: Identity, advance = true) { if (advance) time += 2500; return server!.app.inject({ method: 'POST', url, headers: { origin, ...(who ? { cookie: who.cookie, 'x-csrf-token': who.csrf } : {}) }, payload: payload as Record<string, unknown> }); }
const get = (url: string, who?: Identity) => server!.app.inject({ url, headers: who ? { cookie: who.cookie } : {} });
async function setup() { await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'case-')); server = await createGameServer({ bootstrapToken: 'm6-bootstrap', dataDir: directory, clock: () => time }); await server.app.ready(); return identity(await post('/api/bootstrap', { token: 'm6-bootstrap' })); }
async function connect(who: Identity) {
  const address = server!.app.server.address() as { port: number }, socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: who.cookie } }), assembly = new SnapshotAssembler(), deltaAssembly = new DeltaAssembler(); let latest: PlayerView | undefined;
  socket.on('message', data => { const message = JSON.parse(String(data));
    if (message.type === 'snapshot_chunk') { deltaAssembly.reset(); const result = assembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'complete') latest = result.view; }
    else if (message.type === 'delta_chunk') { if (!latest) throw new Error('DELTA_WITHOUT_BASE'); const result = deltaAssembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'complete') { const next = applyViewDelta(latest, result.delta); if (!next) throw new Error('INVALID_TEST_DELTA'); latest = next; } }
    else if (message.type === 'delta' && latest) { deltaAssembly.reset(); latest = applyViewDelta(latest, message.delta); }
    else if (message.type === 'snapshot') { assembly.reset(); deltaAssembly.reset(); latest = message.view; }
    if (latest?.status === 'LOADING') socket.send(JSON.stringify({ type: 'loaded', contentHash: latest.contentHash, matchId: latest.matchId, matchEpoch: latest.matchEpoch })); });
  await new Promise<void>((done, reject) => { socket.once('open', done); socket.once('error', reject); }); return { socket, latest: () => latest };
}

it('keeps endpoint settings, key and diagnostics host-only and performs a real local capability round trip', async () => {
  const host = await setup(), remote = identity(await post('/api/join', { name: 'Remote', inviteCode: host.body.lobby.inviteCode }));
  for (const url of ['/api/host/endpoint', '/api/host/diagnostics']) { expect((await get(url)).statusCode).toBe(403); expect((await get(url, remote)).statusCode).toBe(403); }
  expect((await post('/api/host/endpoint', { settings: defaultEndpointSettings() }, remote)).statusCode).toBe(403);
  expect((await post('/api/host/endpoint/test', { listModels: true }, remote)).statusCode).toBe(403);
  let probes = 0;
  model = createServer((request, reply) => {
    expect(request.headers.authorization).toBe('Bearer private-m6-test-key'); expect(request.url).toMatch(/^\/custom\/v1\//);
    if (request.url!.endsWith('/models')) { reply.writeHead(404); reply.end('{}'); return; }
    probes++; reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}', reasoning: 'private ignored model text' } }] }));
  });
  await new Promise<void>(done => model!.listen(0, '127.0.0.1', done)); const address = model.address() as { port: number };
  const settings = { ...defaultEndpointSettings(), baseUrl: `http://127.0.0.1:${address.port}/custom/v1`, model: 'mock-model' };
  const saved = await post('/api/host/endpoint', { settings, apiKey: 'private-m6-test-key' }, host); expect(saved.statusCode, saved.body).toBe(200); expect(validateEndpointStateResponse(saved.json())).toBe(true); expect(saved.body).not.toContain('private-m6-test-key'); expect(saved.json().hasApiKey).toBe(true);
  const probe = await post('/api/host/endpoint/test', { listModels: true }, host); expect(probe.json()).toMatchObject({ success: true, mode: 'schema', modelsStatus: 'MODEL_OR_ROUTE_UNAVAILABLE' }); expect(probes).toBe(1); expect(probe.body).not.toContain('private ignored');
  const diagnostics = await get('/api/host/diagnostics', host); expect(validateEndpointDiagnosticsResponse(diagnostics.json())).toBe(true); expect(diagnostics.body).not.toContain(settings.baseUrl); expect(diagnostics.body).not.toContain('private-m6-test-key');
  const remoteSession = await get('/api/session', remote); expect(remoteSession.body).not.toContain(settings.baseUrl); expect(remoteSession.body).not.toContain('mock-model');
  expect((await post('/api/host/endpoint', { settings: { ...settings, baseUrl: 'http://user:password@localhost/v1' } }, host)).json().code).toBe('INVALID_ENDPOINT_URL');
  expect((await get('/api/host/endpoint', host)).json().settings.baseUrl).toBe(settings.baseUrl);
});

it('reports current per-player payload bytes only to the host and removes disconnected connection history',async()=>{
  const host=await setup(),remote=identity(await post('/api/join',{name:'Remote bytes',inviteCode:host.body.lobby.inviteCode}));
  await server!.app.listen({port:0,host:'127.0.0.1'});
  const address=server!.app.server.address() as {port:number};
  const open=async(who:Identity)=>{
    const socket=new WebSocket(`ws://127.0.0.1:${address.port}/ws`,{headers:{origin,cookie:who.cookie}}),record={socket,bytes:0,packets:[] as any[]};
    socket.on('message',data=>{const text=data.toString();record.bytes+=Buffer.byteLength(text,'utf8');record.packets.push(JSON.parse(text));});
    await new Promise<void>((done,reject)=>{socket.once('open',done);socket.once('error',reject);});return record;
  };
  const adminSocket=await open(host),first=await open(remote),second=await open(remote);
  const diagnostics=async()=>{const response=await get('/api/host/diagnostics',host);expect(response.statusCode).toBe(200);expect(validateEndpointDiagnosticsResponse(response.json())).toBe(true);return response.json();};
  const expected=()=>[{playerId:null,connections:1,totalBytes:adminSocket.bytes},{playerId:remote.body.playerId,connections:2,totalBytes:first.bytes+second.bytes}];
  await expect.poll(async()=>{const rows=(await diagnostics()).transport.clients.map(({bytesPerSecond,...row}:any)=>row);return adminSocket.bytes>0&&first.bytes>0&&second.bytes>0&&JSON.stringify(rows)===JSON.stringify(expected());}).toBe(true);
  const privateText='transport-counter-canary 守城🏰';expect((await post('/api/chat',{channel:'all',text:privateText},remote)).statusCode).toBe(200);
  await expect.poll(()=>first.packets.some(packet=>packet.type==='communication'&&packet.state.messages.some((message:any)=>message.text===privateText))).toBe(true);
  await expect.poll(async()=>JSON.stringify((await diagnostics()).transport.clients.map(({bytesPerSecond,...row}:any)=>row))===JSON.stringify(expected())).toBe(true);
  const current=await diagnostics();expect(current.transport.scope).toBe('websocket_application_payload_enqueued');expect(current.transport.windowMs).toBe(10000);
  expect(current.transport.clients.map(({bytesPerSecond,...row}:any)=>row)).toEqual(expected());
  for(const row of current.transport.clients)expect(row.bytesPerSecond).toBeGreaterThan(0);
  expect(JSON.stringify(current.transport)).not.toContain(privateText);expect(JSON.stringify(current.transport)).not.toContain(remote.cookie.split('=')[1]);
  for(const who of [undefined,remote])expect((await get('/api/host/diagnostics',who)).statusCode).toBe(403);
  expect((await get('/api/session',remote)).body).not.toContain('websocket_application_payload_enqueued');
  expect(JSON.stringify(first.packets)).not.toContain('websocket_application_payload_enqueued');
  time+=11000;expect((await diagnostics()).transport.clients.every((row:any)=>row.bytesPerSecond===0)).toBe(true);
  const closed=Promise.all([first.socket,second.socket].map(socket=>new Promise<void>(done=>socket.once('close',()=>done()))));
  const replacement=identity(await post('/api/reconnect',{},remote));await closed;
  await expect.poll(async()=>(await diagnostics()).transport.clients.map((row:any)=>row.playerId)).toEqual([null]);
  const reconnected=await open(replacement);
  await expect.poll(async()=>(await diagnostics()).transport.clients.find((row:any)=>row.playerId===remote.body.playerId)?.totalBytes===reconnected.bytes&&reconnected.bytes>0).toBe(true);
  expect((await diagnostics()).transport.clients.find((row:any)=>row.playerId===remote.body.playerId)?.connections).toBe(1);
  reconnected.socket.close();adminSocket.socket.close();
});

it('filters team communication, rejects hostile control, preserves plain text, and executes private-chat-off presets through the worker', async () => {
  const host = await setup(); await post('/api/host/lobby', { aiCount: 2, sharedVision: false }, host);
  host.body = (await post('/api/join', { name: 'Host', inviteCode: host.body.lobby.inviteCode, hostPlayer: true }, host)).json();
  const remote = identity(await post('/api/join', { name: 'Enemy', inviteCode: host.body.lobby.inviteCode }));
  const teamId = host.body.lobby.players.find((player: any) => player.id === host.body.playerId).teamId;
  expect((await post('/api/host/team', { playerId: 'ai_1', teamId }, host)).statusCode).toBe(200);
  expect((await post('/api/host/endpoint', { settings: { ...defaultEndpointSettings(), sendHumanChat: false } }, host)).statusCode).toBe(200);
  await server!.app.listen({ port: 0, host: '127.0.0.1' }); const clients = [await connect(host), await connect(remote)];
  await post('/api/ready', { ready: true }, host); await post('/api/ready', { ready: true }, remote); expect((await post('/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => clients.every(client => client.latest()?.status === 'RUNNING'), { timeout: 15000 }).toBe(true);
  expect((await post('/api/host/endpoint/test', { listModels: false }, host)).json().code).toBe('PAUSE_BEFORE_ENDPOINT_TEST');
  const privateText = '<img src=x onerror=alert(1)> unverified enemy claim';
  const teamChat = await post('/api/chat', { channel: 'team', text: privateText }, host); expect(teamChat.statusCode, teamChat.body).toBe(200); expect(validateChatStateResponse(teamChat.json())).toBe(true);
  expect(teamChat.json().messages.some((message: any) => message.text === privateText)).toBe(true); expect((await get('/api/chat', remote)).body).not.toContain('unverified enemy claim');
  await post('/api/chat', { channel: 'all', text: 'Public greeting' }, host); expect((await get('/api/chat', remote)).body).toContain('Public greeting');
  expect((await post('/api/chat', { channel: 'team', text: 'Control the enemy', targetAiId: 'ai_2' }, host)).json().code).toBe('ALLIED_AI_REQUIRED');
  expect((await post('/api/cooperate', { targetAiId: 'ai_2', action: 'tribute', resource: 'gold', amount: 10 }, host)).statusCode).toBe(403);
  const ping = await post('/api/ping', { xMm: 10000, zMm: 10000, category: 'help' }, host); expect(ping.json().pings).toHaveLength(1); expect((await get('/api/chat', remote)).json().pings).toEqual([]);
  expect((await post('/api/ping', { xMm: 999999999, zMm: 10000, category: 'attack' }, host)).statusCode).toBe(400);
  const preset = await post('/api/cooperate', { targetAiId: 'ai_1', action: 'defend_base' }, host); expect(preset.statusCode, preset.body).toBe(200);
  await expect.poll(async () => (await get('/api/chat', host)).json().messages.some((message: any) => message.source === 'system' && message.status === 'planned'), { timeout: 5000 }).toBe(true);
  await expect.poll(async () => (await get('/api/chat', host)).json().messages.some((message: any) => message.source === 'system' && message.status === 'blocked'), { timeout: 6000 }).toBe(true);
  const chat = (await get('/api/chat', host)).json(); expect(chat.messages.some((message: any) => message.source === 'model')).toBe(false); expect((await get('/api/chat', remote)).body).not.toContain('cooperation request');
  const offline = await post('/api/chat', { channel: 'team', targetAiId: 'ai_1', text: 'Do not forward this' }, host); expect(offline.json().messages.at(-1)).toMatchObject({ source: 'system', status: 'declined' });
  const diagnostic = (await get('/api/host/diagnostics', host)).json(); expect(validateEndpointDiagnosticsResponse(diagnostic)).toBe(true); expect(diagnostic.scheduler.completed).toBe(0); expect(diagnostic.scheduler.active).toBe(0); expect(diagnostic.simulation.tick).toBeGreaterThan(0);
  expect(diagnostic.simulation.world.units).toBeGreaterThan(0); expect(diagnostic.simulation.world.nonnegativeResources).toBe(true);
  expect(diagnostic.simulation.world.factions).toHaveLength(clients[0]!.latest()!.players.length);
  expect(diagnostic.process.eventLoopDelayMs.p95).toBeGreaterThanOrEqual(0);
  expect(diagnostic.simulation.memory.heapUsed).toBeGreaterThan(0); expect(diagnostic.simulation.path.pending).toBeGreaterThanOrEqual(0);
  expect((await get('/api/host/diagnostics', remote)).statusCode).toBe(403);
  expect((await post('/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
  const paused = await post('/api/chat', { channel: 'team', text: 'Still talking while paused' }, host); expect(paused.statusCode).toBe(200);
  let limited = false; for (let i = 0; i < 7; i++) { const sent = await post('/api/chat', { channel: 'all', text: `burst ${i}` }, host, false); if (sent.statusCode === 429) limited = true; } expect(limited).toBe(true);
}, 35000);

it('rejects AI chat and defense requests whose worker acknowledgement crosses a match epoch', async () => {
  const host=await setup();await post('/api/host/lobby',{aiCount:2},host);
  host.body=(await post('/api/join',{name:'Host',inviteCode:host.body.lobby.inviteCode,hostPlayer:true},host)).json();
  const own=host.body.lobby.players.find((player:any)=>player.id===host.body.playerId);
  expect((await post('/api/host/team',{playerId:'ai_1',teamId:own.teamId},host)).statusCode).toBe(200);
  await server!.app.listen({port:0,host:'127.0.0.1'});const client=await connect(host);
  await post('/api/ready',{ready:true},host);expect((await post('/api/host/start',{},host)).statusCode).toBe(200);
  await expect.poll(()=>client.latest()?.status,{timeout:15000}).toBe('RUNNING');

  let releaseChat:(()=>void)|undefined;
  const accept=SimulationBridge.prototype.acceptAiChat;
  const chatSpy=vi.spyOn(SimulationBridge.prototype,'acceptAiChat').mockImplementationOnce(async function(this:SimulationBridge,request){
    const result=await accept.call(this,request);expect(result.accepted).toBe(true);
    await new Promise<void>(resolve=>{releaseChat=resolve;});return result;
  });
  const privateText='Old epoch private strategy must not enter the communication history';
  const waitingChat=post('/api/chat',{channel:'team',targetAiId:'ai_1',text:privateText},host);
  await expect.poll(()=>Boolean(releaseChat)).toBe(true);
  expect((await post('/api/host/pause',{paused:true},host)).statusCode).toBe(200);releaseChat!();
  const rejectedChat=await waitingChat;expect(rejectedChat.statusCode,rejectedChat.body).toBe(409);expect(rejectedChat.json().code).toBe('MATCH_CHANGED');
  expect((await get('/api/chat',host)).body).not.toContain(privateText);chatSpy.mockRestore();

  expect((await post('/api/host/pause',{paused:false},host)).statusCode).toBe(200);
  let releaseView:(()=>void)|undefined;
  const view=SimulationBridge.prototype.view;
  const viewSpy=vi.spyOn(SimulationBridge.prototype,'view').mockImplementationOnce(async function(this:SimulationBridge,playerId){
    const result=await view.call(this,playerId);await new Promise<void>(resolve=>{releaseView=resolve;});return result;
  });
  const admission=vi.spyOn(SimulationBridge.prototype,'acceptAiChat');
  const waitingDefense=post('/api/cooperate',{targetAiId:'ai_1',action:'defend_base'},host);
  await expect.poll(()=>Boolean(releaseView)).toBe(true);
  expect((await post('/api/host/pause',{paused:true},host)).statusCode).toBe(200);releaseView!();
  const rejectedDefense=await waitingDefense;expect(rejectedDefense.statusCode,rejectedDefense.body).toBe(409);expect(rejectedDefense.json().code).toBe('MATCH_CHANGED');
  expect(admission).not.toHaveBeenCalled();expect((await get('/api/chat',host)).body).not.toContain('Request defense of my base.');
  viewSpy.mockRestore();admission.mockRestore();client.socket.close();
},25000);
