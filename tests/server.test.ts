import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGameServer, saveListingCompatibilityWarning, type ServerOptions } from '../apps/server/src/server.js';
import { SimulationBridge } from '../apps/server/src/bridge.js';
import { PerformanceDiagnostics, ViewDeliveryDiagnostics } from '../apps/server/src/performance-diagnostics.js';
import { SaveStore } from '../apps/server/src/save-store.js';
import { ReplayStore } from '../apps/server/src/replay-store.js';
import { defaultEndpointSettings } from '../apps/server/src/ai-endpoint.js';
import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { contentHash, assetCatalogContentHash, resolveRuleset, SnapshotAssembler, DeltaAssembler, applyViewDelta, validateHostRecoveryResponse, validateEndpointDiagnosticsResponse, type PlayerView, type GameplayCommand } from '@frontier/shared';
import { Simulation } from '@frontier/simulation';
import { sealSimulationCapture } from '../packages/simulation/src/persistence.js';
import { engineIdentity } from '../apps/server/src/build-info.js';

const active: Awaited<ReturnType<typeof createGameServer>>[] = [];
const temporary: string[] = [], testRoot = resolve('runtime-data/server-tests');
afterEach(async () => { for (const server of active.splice(0)) await server.app.close(); for (const path of temporary.splice(0)) { const within = relative(testRoot, path); if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(path, { recursive: true, force: true }); } });
async function setup(options: ServerOptions = {}) { await mkdir(testRoot, { recursive: true }); const dataDir = await mkdtemp(join(testRoot, 'case-')); temporary.push(dataDir); const server = await createGameServer({ bootstrapToken: 'test-bootstrap-secret', dataDir, ...options }); active.push(server); await server.app.ready(); return Object.assign(server, { dataDir }); }
const origin = 'http://localhost:3000';
describe('save listing compatibility hints', () => {
  const header = (engineBuildHash: string, label = 'My frontier') => JSON.stringify({
    formatVersion: 1, id: 'manual_1791277950031_4389521bcd53161e', kind: 'manual', label,
    createdAt: '2026-10-06T09:12:30.031Z', tick: 69204,
    payload: { game: { formatVersion: 1, engineBuildHash, runtimeProfile: { nodeVersion: process.version } } },
  });
  it('only rejects a different engine in the canonical writer header, including escaped labels', () => {
    for (const label of ['My frontier', 'Quotes " and \\ and \u6c34', '"engineBuildHash":"' + 'f'.repeat(64)]) {
      expect(saveListingCompatibilityWarning(header('f'.repeat(64), label))).toBe('ENGINE_VERSION_MISMATCH');
      expect(saveListingCompatibilityWarning(header(engineIdentity.engineBuildHash, label))).toBeUndefined();
    }
  });
  it('leaves truncated, noncanonical and corrupt headers for full validation', () => {
    const old = header('f'.repeat(64));
    for (const prefix of ['', old.slice(0, old.indexOf('runtimeProfile')), JSON.stringify(JSON.parse(old), null, 2),
      old.replace('"formatVersion":1', '"formatVersion":2'), old.replace('"tick":69204', '"tick":null'),
      old.replace('"engineBuildHash":"', '"unexpected":"'), old.replace('My frontier', 'Unescaped\ncontrol')]) {
      expect(saveListingCompatibilityWarning(prefix)).toBeUndefined();
    }
  });
});
type Login = { cookie: string; csrf: string; body: any };
function login(response: any): Login { return { cookie: String(response.headers['set-cookie']).split(';')[0]!, csrf: response.json().csrfToken, body: response.json() }; }
async function post(server: Awaited<ReturnType<typeof setup>>, path: string, payload: Record<string, unknown>, session?: Login) { return server.app.inject({ method: 'POST', url: path, headers: { origin, ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}) }, payload }); }
async function admin(server: Awaited<ReturnType<typeof setup>>) { const response = await post(server, '/api/bootstrap', { token: 'test-bootstrap-secret' }); expect(response.statusCode).toBe(200); return login(response); }

describe('continuous eight-age match configuration',()=>{
  it('starts normal lobbies at VIII and resolves the selected age/resource identity',async()=>{
    const server=await setup(),host=await admin(server);
    expect(host.body.protocolVersion).toBe(2);
    expect(host.body.lobby.settings).toMatchObject({maxAge:8,startingResourcePreset:'long_war'});
    expect(host.body.contentHash).toBe(resolveRuleset('legendary_ages_v1',8,'long_war').contentHash);
    const changed=await post(server,'/api/host/lobby',{maxAge:6,startingResourcePreset:'standard'},host);
    expect(changed.statusCode).toBe(200);
    expect(changed.json().contentHash).toBe(resolveRuleset('legendary_ages_v1',6,'standard').contentHash);
    expect(changed.json().lobby.settings.maxAge).toBe(6);
  });
  it('rejects an invalid cap without partially changing the lobby',async()=>{
    const server=await setup(),host=await admin(server);
    expect((await post(server,'/api/host/lobby',{maxAge:9,startingResourcePreset:'standard'},host)).statusCode).toBe(400);
    const response=await server.app.inject({method:'GET',url:'/api/session',headers:{cookie:host.cookie}});
    expect(response.json().lobby.settings).toMatchObject({maxAge:8,startingResourcePreset:'long_war'});
  });
  it('restores omitted legacy identity without retaining the current eight-age lobby defaults',async()=>{
    const server=await setup(),host=await admin(server);
    const factions=[{id:'a',name:'First',teamId:'a',color:'#3388ff',kind:'human' as const,hostPlayer:true},{id:'b',name:'Second',teamId:'b',color:'#ff8833',kind:'human' as const,hostPlayer:false}];
    const sim=new Simulation({matchId:'legacy_metadata_match',seed:'tenfold-natural-resources',factions,populationLimit:120,sharedVision:true,controllers:true,monumentVictory:false,caretakerEnabled:false,mapType:'open_frontier',mapSize:'auto'});
    sim.setStatus('PAUSED');const capture=sim.capture();
    for(const value of [capture.options,capture.state]){delete value.rulesetId;delete value.maxAge;delete value.startingResourcePreset;}
    const settings={...host.body.lobby.settings,aiCount:0,populationLimit:120,sharedVision:true,monumentVictory:false,caretakerEnabled:false,mapType:'open_frontier',mapSize:'auto'};
    delete settings.rulesetId;delete settings.maxAge;delete settings.startingResourcePreset;
    const payload={game:sealSimulationCapture(capture,engineIdentity),lobby:{settings,hostSeed:'tenfold-natural-resources',players:factions.map(player=>({...player,connected:false,ready:false}))}};
    const store=new SaveStore<typeof payload>(join(server.dataDir,'saves'),(value):value is typeof payload=>Boolean(value));
    const saved=await store.save(payload,{kind:'manual',label:'Legacy compatibility fixture',tick:0});
    const response=await post(server,'/api/host/load',{saveId:saved.id,confirmed:true},host);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().lobby.settings).toMatchObject({rulesetId:'classic_v1',maxAge:4,startingResourcePreset:'standard'});
    expect(response.json().contentHash).toBe(contentHash);
    expect((await post(server,'/api/host/end-draw',{confirmed:true},host)).statusCode).toBe(200);
    const next=await post(server,'/api/host/reset',{},host);
    expect(next.statusCode,next.body).toBe(200);
    expect(next.json().lobby.settings).toMatchObject({rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war'});
  },20000);
});
function viewpointDecoder(initial?:PlayerView) {
  const assembly = new SnapshotAssembler(), deltaAssembly = new DeltaAssembler(); let view: PlayerView | undefined=initial;
  return (message: any): any => {
    if (message.type === 'snapshot_chunk') { deltaAssembly.reset(); const result = assembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'pending') return undefined; view = result.view; return { type: 'snapshot', view }; }
    if (message.type === 'delta_chunk') { if (!view) throw new Error('DELTA_WITHOUT_BASE'); const result = deltaAssembly.push(message, Date.now()); if (result.status === 'rejected') throw new Error(result.code); if (result.status === 'pending') return undefined; view = applyViewDelta(view, result.delta); if (!view) throw new Error('INVALID_TEST_DELTA'); return { type: 'snapshot', view }; }
    if (message.type === 'delta') { deltaAssembly.reset(); if (!view) throw new Error('DELTA_WITHOUT_BASE'); view = applyViewDelta(view, message.delta); if (!view) throw new Error('INVALID_TEST_DELTA'); return { type: 'snapshot', view }; }
    if (message.type === 'snapshot') { assembly.reset(); deltaAssembly.reset(); view = message.view; }
    return message;
  };
}

async function connectPlayer(server: Awaited<ReturnType<typeof setup>>, identity: Login) {
  const address = server.app.server.address() as { port: number }, packets: any[] = [], wire: any[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: identity.cookie } });
  const decode = viewpointDecoder();
  socket.on('message', data => {
    const raw = JSON.parse(data.toString()); wire.push(raw); const packet = decode(raw); if (!packet) return; packets.push(packet);
    if (packet.type === 'snapshot' && packet.view.status === 'LOADING') socket.send(JSON.stringify({ type: 'loaded', contentHash: packet.view.contentHash, matchId: packet.view.matchId, matchEpoch: packet.view.matchEpoch }));
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, packets, wire, latest: () => [...packets].reverse().find(packet => packet.type === 'snapshot')?.view as PlayerView | undefined };
}

async function twoHumans(options: ServerOptions = {}) {
  const server = await setup(options), host = await admin(server);
  await post(server, '/api/host/lobby', { aiCount: 0 }, host);
  const hostJoin = await post(server, '/api/join', { name: 'Host commander', inviteCode: host.body.lobby.inviteCode, hostPlayer: true }, host); expect(hostJoin.statusCode, hostJoin.body).toBe(200); host.body = hostJoin.json();
  const remote = login(await post(server, '/api/join', { name: 'Remote commander', inviteCode: host.body.lobby.inviteCode }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const clients = [await connectPlayer(server, host), await connectPlayer(server, remote)];
  for (const identity of [host, remote]) await post(server, '/api/ready', { ready: true }, identity);
  expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => clients.every(client => client.latest()?.status === 'RUNNING'), { timeout: 12000 }).toBe(true);
  return { server, host, remote, clients };
}

describe('truthful startup endpoint reporting', () => {
  async function fromStored(contents: string, logger = false) {
    await mkdir(testRoot, { recursive: true });
    const dataDir = await mkdtemp(join(testRoot, 'startup-')); temporary.push(dataDir);
    await writeFile(join(dataDir, 'endpoint.local.json'), contents);
    const server = await createGameServer({ dataDir, logger, publicationThread: false }); active.push(server);
    return server;
  }
  const stored = (configured: boolean) => JSON.stringify({ formatVersion: 1, apiKey: 'startup-private-key', settings: {
    ...defaultEndpointSettings(), ...(configured ? { baseUrl: 'http://127.0.0.1:1919/private/v1', model: 'startup-private-model' } : {}),
  } });
  it.each([false, true])('reports configured=%s as unprobed without making an endpoint request or exposing settings', async configured => {
    const requests = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('BOOT_MUST_NOT_CONTACT_ENDPOINT'));
    try {
      const server = await fromStored(stored(configured));
      expect((await server.app.inject('/api/health')).statusCode).toBe(200);
      expect(server.startupEndpoint).toEqual({ configured, mode: 'unprobed', status: configured ? 'NOT_TESTED' : 'NOT_CONFIGURED' });
      expect(Object.isFrozen(server.startupEndpoint)).toBe(true);
      const logFields = JSON.stringify(server.startupEndpoint);
      for (const secret of ['startup-private-key', 'startup-private-model', '127.0.0.1', 'commander', 'settings', 'apiKey']) expect(logFields).not.toContain(secret);
      expect(requests).not.toHaveBeenCalled();
    } finally { requests.mockRestore(); }
  });
  it('reports a sanitized configuration failure without inventing model availability', async () => {
    const requests = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('BOOT_MUST_NOT_CONTACT_ENDPOINT'));
    try {
      const server = await fromStored('{"private-key":"never-log-this",');
      await server.app.ready();
      expect(server.startupEndpoint).toEqual({ configured: false, mode: 'unprobed', status: 'ENDPOINT_CONFIG_INVALID' });
      expect(JSON.stringify(server.startupEndpoint)).not.toContain('never-log-this');
      expect(requests).not.toHaveBeenCalled();
    } finally { requests.mockRestore(); }
  });
  it('continues suppressing automatic request logs with the supported Fastify log controller', async () => {
    const server = await fromStored(stored(false), true), requestLog = vi.fn();
    const requestLogger = vi.fn((...args: Parameters<Parameters<typeof server.app.setChildLoggerFactory>[0]>) => {
      const [logger, bindings, options] = args, child = logger.child(bindings, options);
      child.info = requestLog; child.error = requestLog; child.warn = requestLog;
      return child;
    });
    server.app.setChildLoggerFactory(requestLogger);
    // Fastify captures the child-logger factory when each route is registered.
    server.app.get('/startup-log-test', async () => ({ ready: true }));
    expect((await server.app.inject('/startup-log-test')).statusCode).toBe(200);
    expect(requestLogger).toHaveBeenCalled();
    expect(requestLog).not.toHaveBeenCalled();
  });
});

describe('private opt-in performance diagnostics',()=>{
  it('uses credited publication for startup, paused resync and reconnect without direct full-view RPCs', async () => {
    const direct = vi.spyOn(SimulationBridge.prototype, 'view'), requested = vi.spyOn(SimulationBridge.prototype, 'publishRecipient');
    let reconnected: Awaited<ReturnType<typeof connectPlayer>> | undefined;
    try {
      const { server, host, remote, clients } = await twoHumans();
      expect(direct).not.toHaveBeenCalled();
      await post(server, '/api/host/pause', { paused: true }, host);
      await expect.poll(() => clients[1]!.latest()?.status).toBe('PAUSED');
      const before = clients[1]!.wire.filter(packet => packet.type === 'snapshot_chunk' && packet.index === 0).length;
      const current = clients[1]!.latest()!;
      clients[1]!.socket.send(JSON.stringify({ type: 'resync' }));
      await expect.poll(() => clients[1]!.wire.filter(packet => packet.type === 'snapshot_chunk' && packet.index === 0).length).toBeGreaterThan(before);
      expect(requested).toHaveBeenCalledWith(remote.body.playerId, expect.any(Number), current.matchId, current.matchEpoch);
      const closed = new Promise<void>(resolve => clients[1]!.socket.once('close', () => resolve())); clients[1]!.socket.close(); await closed;
      reconnected = await connectPlayer(server, remote);
      await expect.poll(() => reconnected!.latest()?.status).toBe('PAUSED');
      expect(reconnected.latest()!.playerId).toBe(remote.body.playerId);
      expect(reconnected.wire.find(packet => packet.type === 'snapshot_chunk')).toBeDefined();
      expect(direct).not.toHaveBeenCalled();
      expect(clients.flatMap(client => client.wire).concat(reconnected.wire).some(packet => /publicationRequest|requestToken|snapshot-complete/.test(JSON.stringify(packet)))).toBe(false);
      for (const client of clients) client.socket.close();
    } finally { reconnected?.socket.close(); direct.mockRestore(); requested.mockRestore(); }
  });
  it('does not publish a reconnect request whose authority wait crosses an epoch change', async () => {
    const { server, host, remote, clients } = await twoHumans();
    const closed = new Promise<void>(resolve => clients[1]!.socket.once('close', () => resolve())); clients[1]!.socket.close(); await closed;
    let release!: () => void, waiting = false;
    const held = new Promise<void>(resolve => { release = resolve; }), original = SimulationBridge.prototype.controlMode;
    const control = vi.spyOn(SimulationBridge.prototype, 'controlMode').mockImplementation(function (this: SimulationBridge, playerId, mode) {
      const result = original.call(this, playerId, mode);
      return playerId === remote.body.playerId && mode === 'human' ? result.then(async value => { waiting = true; await held; return value; }) : result;
    });
    const requested = vi.spyOn(SimulationBridge.prototype, 'publishRecipient');
    let reconnected: Awaited<ReturnType<typeof connectPlayer>> | undefined;
    try {
      reconnected = await connectPlayer(server, remote);
      await expect.poll(() => waiting).toBe(true);
      expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
      await expect.poll(() => clients[0]!.latest()?.status).toBe('PAUSED');
      release();
      await expect.poll(() => reconnected!.packets.some(packet => packet.type === 'error' && packet.code === 'NO_MATCH')).toBe(true);
      expect(requested).not.toHaveBeenCalled();
    } finally { release(); reconnected?.socket.close(); for (const client of clients) client.socket.close(); control.mockRestore(); requested.mockRestore(); }
  });
  it.each([['json','portable'],['json','native'],['owned','portable'],['fog','native'],['fog','portable']] as const)('audits scheduled and resync views plus wire payloads in the trusted gateway only (%s / %s)',async (publicationPreparation,snapshotEncoding)=>{
    const views:{playerId:string;view:PlayerView}[]=[],frames:{playerId:string|undefined;host:boolean;type:string}[]=[];
    const {server,host,remote,clients}=await twoHumans({
      publicationPreparation,snapshotEncoding,
      inspectPublishedViewJson:(text,playerId)=>views.push({playerId,view:JSON.parse(text)}),
      inspectOutboundFrame:(text,playerId,host)=>frames.push({playerId,host,type:JSON.parse(text).type}),
    });
    const playerId=remote.body.playerId;
    expect(views.some(item=>item.playerId===playerId&&item.view.status==='RUNNING')).toBe(true);
    expect(frames.some(item=>item.playerId===playerId&&!item.host&&item.type==='snapshot_chunk')).toBe(true);
    expect(frames.some(item=>item.host&&item.type==='lobby')).toBe(true);
    await post(server,'/api/host/pause',{paused:true},host);
    await expect.poll(()=>clients[1]!.latest()?.status).toBe('PAUSED');
    const before=views.filter(item=>item.playerId===playerId).length;
    clients[1]!.socket.send(JSON.stringify({type:'resync'}));
    await expect.poll(()=>views.filter(item=>item.playerId===playerId).length).toBeGreaterThan(before);
    expect(views.every(item=>item.view.playerId===item.playerId)).toBe(true);
    expect(clients.flatMap(client=>client.wire).some(packet=>JSON.stringify(packet).includes('inspectPublishedViewJson'))).toBe(false);
    for(const client of clients)client.socket.close();
  });
  it('does not expose timing hooks by default or add them to host/player HTTP contracts',async()=>{
    const ordinary=await setup();expect(ordinary.performanceDiagnostics).toBeUndefined();expect(ordinary.publicationStamp).toBeUndefined();
    const observed=await setup({performanceDiagnostics:true}),host=await admin(observed);
    expect(await observed.performanceDiagnostics!()).toMatchObject({main:{enabled:true,timingQualificationEligible:false}});
    const response=await observed.app.inject({url:'/api/host/diagnostics',headers:{cookie:host.cookie}});
    expect(validateEndpointDiagnosticsResponse(response.json())).toBe(true);
    expect(response.body).not.toContain('sampleLimitPerPhase');expect(response.body).not.toContain('acceptedToFirstMove');
    expect((await observed.app.inject({url:'/api/performance-diagnostics',headers:{cookie:host.cookie}})).statusCode).toBe(404);
  });

  it.each([['json','portable'],['json','native'],['owned','portable'],['fog','native'],['fog','portable']] as const)('measures the real worker/publication path privately while preserving ordinary receipts and recipient packets (%s / %s)',async (publicationPreparation,snapshotEncoding)=>{
    const {server,host,clients}=await twoHumans({performanceDiagnostics:true,publicationPreparation,snapshotEncoding});
    const client=clients[0]!,initial=client.latest()!,scout=initial.entities.find(entity=>entity.ownerId===initial.playerId&&entity.typeId==='scout')!;
    expect(scout).toBeDefined();
    const deliveryMetrics=new PerformanceDiagnostics(),delivery=new ViewDeliveryDiagnostics(deliveryMetrics),decode=viewpointDecoder(client.latest());let observerError:unknown;
    client.socket.on('message',data=>{try{const packet=decode(JSON.parse(data.toString()));if(packet?.type==='snapshot'){const view=packet.view as PlayerView;delivery.observe(view,server.publicationStamp!(view.playerId,view.matchId,view.matchEpoch,view.sequence));}}catch(error){observerError=error;}});
    const send=(sequence:number,command:GameplayCommand)=>{const envelope={protocolVersion:2 as const,matchId:initial.matchId,matchEpoch:initial.matchEpoch,clientCommandId:`diagnostic_move_${sequence}`,clientSequence:sequence,command};delivery.commandIssued(initial.playerId,envelope);client.socket.send(JSON.stringify(envelope));};
    send(1,{kind:'stop',unitIds:[scout.id]});
    await expect.poll(()=>client.packets.some(packet=>packet.type==='receipt'&&packet.receipt.clientCommandId==='diagnostic_move_1'&&packet.receipt.status==='accepted')).toBe(true);
    const stopped=client.latest()!.entities.find(entity=>entity.id===scout.id)!;
    send(2,{kind:'move',unitIds:[scout.id],target:{xMm:stopped.xMm+2000,zMm:stopped.zMm},queued:false});
    await expect.poll(()=>client.packets.some(packet=>packet.type==='receipt'&&packet.receipt.clientCommandId==='diagnostic_move_2'&&packet.receipt.status==='accepted')).toBe(true);
    await expect.poll(async()=>{
      const diagnostic=await server.performanceDiagnostics!() as {simulation?:{worker?:{counts?:Record<string,number>}}};
      return diagnostic.simulation?.worker?.counts?.moveProbeCompleted??0;
    },{timeout:5000}).toBe(1);
    await expect.poll(()=>deliveryMetrics.snapshot().counts.deliveredMoveCompleted??0,{timeout:5000}).toBe(1);expect(observerError).toBeUndefined();
    expect(deliveryMetrics.snapshot().phases.commandIssuedToDeliveredMove!.count).toBe(1);expect(deliveryMetrics.snapshot().phases.acceptedToDeliveredMove!.count).toBe(1);expect(deliveryMetrics.snapshot().phases.firstMoveToDeliveredMove!.count).toBe(1);
    const diagnostic=await server.performanceDiagnostics!() as {main:{phases:Record<string,{count:number}>};bridge:{phases:Record<string,{count:number}>};simulation:{worker:{phases:Record<string,{count:number}>}}};
    expect(diagnostic.main).toMatchObject({snapshotEncoding,publicationPreparation});
    expect(diagnostic.main.phases.prepare!.count).toBeGreaterThan(0);expect(diagnostic.bridge.phases.viewIpc!.count).toBeGreaterThan(0);
    if(publicationPreparation==='owned')for(const phase of ['ownedSafetySize','ownedSchema','ownedConsistency','ownedNormalize','preparedAdoption'])expect(diagnostic.main.phases[phase]!.count).toBeGreaterThan(0);
    if(publicationPreparation==='fog'){
      expect(diagnostic.bridge.phases.prepare!.count).toBeGreaterThan(0);
      expect(diagnostic.main.phases.preparedAdoption!.count).toBeGreaterThan(0);
    }
    expect(diagnostic.bridge.phases.workerRequestRoundTrip!.count).toBeGreaterThan(0);
    expect(diagnostic.simulation.worker.phases.workerRequestQueue!.count).toBeGreaterThan(0);
    expect(diagnostic.simulation.worker.phases.advancingCallback!.count).toBeGreaterThan(0);
    expect(diagnostic.simulation.worker.phases.tickDebt!.count).toBeGreaterThanOrEqual(diagnostic.simulation.worker.phases.advancingCallback!.count);
    expect(diagnostic.simulation.worker.phases.queuedToFirstMove!.count).toBe(1);
    expect(diagnostic.simulation).toMatchObject({ overload: { eventLimit: 256, lastOverload: null,
      recentEvents: expect.arrayContaining([expect.objectContaining({ operation: 'timer', status: 'RUNNING', stepsMs: expect.any(Array) })]) } });
    expect(JSON.stringify(client.wire)).not.toContain('performanceStamp');expect(JSON.stringify(client.wire)).not.toContain('diagnosticSentAtMs');expect(JSON.stringify(client.wire)).not.toContain('diagnosticRequestSentAtMs');
    const publicDiagnostics=await server.app.inject({url:'/api/host/diagnostics',headers:{cookie:host.cookie}});expect(validateEndpointDiagnosticsResponse(publicDiagnostics.json())).toBe(true);
    const compute=publicDiagnostics.json();
    expect(compute.compute.publication).toMatchObject({mode:'threads',threadIds:[expect.any(Number)],degraded:false});
    expect(compute.simulation.compute.planning).toMatchObject({mode:'threads',threadIds:[expect.any(Number),expect.any(Number),expect.any(Number)],degraded:false});
    expect(compute.simulation.compute.vision).toMatchObject({mode:'inline',threadIds:[],degraded:false});
    expect(compute.simulation.pacing).toMatchObject({authoritativeIntervalMs:300,movementDecisionIntervalMs:300});
    expect(new Set([...compute.compute.publication.threadIds,...compute.simulation.compute.planning.threadIds,...compute.simulation.compute.vision.threadIds]).size).toBe(4);
    // D090 deliberately exposes bounded callback evidence to the authenticated
    // host; detailed traces and ordinary recipient/save payloads stay separate.
    const runtime=compute.simulation.runtime;
    expect(runtime).toMatchObject({historyLimit:16,callbackCount:expect.any(Number),boundaryYields:expect.any(Number),lastOverload:null});
    expect(Object.keys(runtime).sort()).toEqual(['boundaryYields','callbackCount','historyLimit','lastOverload','recentCallbacks']);
    expect(runtime.recentCallbacks.length).toBeGreaterThan(0);expect(runtime.recentCallbacks.length).toBeLessThanOrEqual(16);
    for(const callback of runtime.recentCallbacks)expect(Object.keys(callback).sort()).toEqual(['durationMs','endTick','epoch','gapBeforeMs','operation','phasesMs','tick']);
    expect(JSON.stringify(client.wire)).not.toContain('threadIds');
    expect((await post(server,'/api/host/pause',{paused:true},host)).statusCode).toBe(200);expect((await post(server,'/api/host/save',{name:'Private movement diagnostics'},host)).statusCode).toBe(200);
    const recovery=(await server.app.inject({url:'/api/host/recovery',headers:{cookie:host.cookie}})).json(),save=await readFile(join(server.dataDir,'saves',`${recovery.saves[0].id}.json`),'utf8');
    const ordinaryPayloads=[...clients.map(player=>JSON.stringify(player.wire)),save];
    for(const value of [...ordinaryPayloads,publicDiagnostics.body])for(const field of ['firstMoveAtMs','acceptedAtMs','commandIssuedToDeliveredMove','moveCertificate','performanceStamp','recentEvents','recentAdvancingEvents','callbackAccounting','simulationStages','advancingCallbackScope'])expect(value).not.toContain(field);
    for(const value of ordinaryPayloads)for(const field of ['lastOverload','recentCallbacks','phasesMs'])expect(value).not.toContain(field);
  },20000);
});

describe('production assets and shutdown persistence', () => {
  async function installedAssets() {
    await mkdir(testRoot, { recursive: true }); const directory = await mkdtemp(join(testRoot, 'assets-')); temporary.push(directory);
    const staticRoot = join(directory, 'public'); await mkdir(join(staticRoot, 'assets'), { recursive: true }); await mkdir(join(staticRoot, 'art'));
    const html = '<!doctype html><script type="module" src="/assets/game.js"></script><link rel="stylesheet" href="/assets/game.css">';
    await writeFile(join(staticRoot, 'index.html'), html); await writeFile(join(staticRoot, 'assets/game.js'), 'export const ready=true;'); await writeFile(join(staticRoot, 'assets/game.css'), 'body{color:white}');
    const asset = async (name: string, contents: string) => { await writeFile(join(staticRoot, 'art', name), contents); return { path: `/art/${name}`, bytes: Buffer.byteLength(contents), sha256: createHash('sha256').update(contents).digest('hex') }; };
    const manifest = { schemaVersion: 2, contentHash, catalogContentHash: assetCatalogContentHash, status: 'GENERATED_ORIGINAL_ASSETS', catalog: [{ id: 'fixture' }], bundle: await asset('bundle.json', '{"fixture":true}'), ui: [await asset('icon.svg', '<svg/>')], audio: [await asset('cue.wav', 'fixture-audio')] };
    await writeFile(join(staticRoot, 'asset-manifest.json'), JSON.stringify(manifest));
    return { directory, staticRoot, html, manifest };
  }
  it('advertises readiness only after checking production browser and generated assets', async () => {
    const fixture = await installedAssets(), server = await setup({ staticRoot: fixture.staticRoot, requireStaticAssets: true });
    expect((await server.app.inject('/api/health')).json()).toEqual({ ready: true, protocolVersion: 2 });
    expect((await server.app.inject('/')).body).toBe(fixture.html);
    expect((await server.app.inject('/assets/game.js')).headers['content-type']).toContain('javascript');
    expect((await server.app.inject('/art/bundle.json')).body).toBe('{"fixture":true}');
  });
  it.each(['missing-root', 'missing-index', 'missing-script', 'missing-manifest', 'wrong-content', 'corrupt-bundle', 'corrupt-icon', 'missing-audio', 'escaping-art'] as const)('rejects %s before production server initialization', async failure => {
    const fixture = await installedAssets(); let root = fixture.staticRoot;
    if (failure === 'missing-root') root = join(fixture.directory, 'not-installed');
    else if (failure === 'missing-index') await rm(join(root, 'index.html'));
    else if (failure === 'missing-script') await rm(join(root, 'assets/game.js'));
    else if (failure === 'missing-manifest') await rm(join(root, 'asset-manifest.json'));
    else if (failure === 'corrupt-bundle') await writeFile(join(root, 'art/bundle.json'), '{"fixture":null}');
    else if (failure === 'corrupt-icon') await writeFile(join(root, 'art/icon.svg'), '<svg!>');
    else if (failure === 'missing-audio') await rm(join(root, 'art/cue.wav'));
    else {
      if (failure === 'wrong-content') fixture.manifest.contentHash = '0'.repeat(64);
      else fixture.manifest.bundle.path = '/art/../../host-private.txt';
      await writeFile(join(root, 'asset-manifest.json'), JSON.stringify(fixture.manifest));
    }
    await expect(createGameServer({ staticRoot: root, requireStaticAssets: true, dataDir: fixture.directory })).rejects.toThrow('PRODUCTION_ASSETS_INVALID');
  });
  it('serves public assets while denying private files through noncanonical traversal paths', async () => {
    const fixture = await installedAssets(), secret = 'private-static-regression-canary';
    await writeFile(join(fixture.directory, 'host-private.txt'), secret); await writeFile(join(fixture.staticRoot, '.env'), secret);
    const server = await setup({ staticRoot: fixture.staticRoot, requireStaticAssets: true });
    for (const path of ['/.env', '/%2eenv', '/../host-private.txt', '/%2e%2e/host-private.txt', '/assets/%2e%2e/%2e%2e/host-private.txt', '/assets/..%2f..%2fhost-private.txt', '/assets/%2e%2e%5c%2e%2e%5chost-private.txt', '/runtime-data/host-bootstrap.txt']) {
      const response = await server.app.inject(path);
      expect(response.body, path).not.toContain(secret);
      if (response.statusCode === 200) expect(response.body, path).toBe(fixture.html);
    }
  });
  it.each([false, true])('drains the active autosave and queued replacement before close (first fails: %s)', async firstFails => {
    const init = SimulationBridge.prototype.init, save = SaveStore.prototype.save, closeJournal = ReplayStore.prototype.close; let current: SimulationBridge | undefined;
    let journalClosed!: () => void; const journalFinished = new Promise<void>(resolve => { journalClosed = resolve; });
    const releases: (() => void)[] = [], entered: (() => void)[] = [];
    const gates = [0, 1].map(() => new Promise<void>(resolve => releases.push(resolve))), starts = [0, 1].map(() => new Promise<void>(resolve => entered.push(resolve)));
    let calls = 0, closed = false, closing: Promise<void> | undefined;
    const initSpy = vi.spyOn(SimulationBridge.prototype, 'init').mockImplementation(function (this: SimulationBridge, options) { current = this; return init.call(this, options); });
    const closeSpy = vi.spyOn(ReplayStore.prototype, 'close').mockImplementation(async function (this: ReplayStore) { await closeJournal.call(this); journalClosed(); });
    const saveSpy = vi.spyOn(SaveStore.prototype, 'save').mockImplementation(async function (this: SaveStore<unknown>, payload, options) {
      const index = calls++; if (index < 2) { entered[index]!(); await gates[index]; }
      if (firstFails && index === 0) throw new Error('INJECTED_SAVE_FAILURE');
      return save.call(this, payload, options);
    });
    try {
      const server = await setup(), host = await admin(server); await post(server, '/api/host/lobby', { aiCount: 2 }, host);
      expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200); expect(current).toBeDefined();
      const capture = await current!.capture(); current!.onCheckpoint(capture, true); await starts[0]; current!.onCheckpoint(capture, true);
      closing = server.app.close().then(() => { closed = true; });
      // The worker and journal have already stopped; only persistence can now keep close pending.
      await journalFinished; await new Promise<void>(resolve => setImmediate(resolve)); expect(closed).toBe(false);
      releases[0]!(); await starts[1]; await new Promise<void>(resolve => setImmediate(resolve)); expect(closed).toBe(false);
      releases[1]!(); await closing; expect(closed).toBe(true); expect(calls).toBe(2);
      const records = await new SaveStore(join(server.dataDir, 'saves'), (value): value is object => Boolean(value && typeof value === 'object')).list();
      expect(records.warnings).toEqual([]); expect(records.saves).toHaveLength(firstFails ? 1 : 2); expect(records.saves.every(record => record.kind === 'auto' && record.tick === capture.state.tick)).toBe(true);
    } finally { releases.forEach(release => release()); await closing; initSpy.mockRestore(); saveSpy.mockRestore(); closeSpy.mockRestore(); }
  }, 20000);
});

describe('M5 capacity, recovery and disconnected authority', () => {
  it('runs six authenticated human viewpoints and five AI with unique public identities and host-only seed', async () => {
    const server = await setup(), host = await admin(server);
    expect((await post(server, '/api/host/lobby', { teamPreset: 'six_vs_five', mapSize: 'large' }, host)).statusCode).toBe(200);
    expect((await post(server, '/api/host/seed', { seed: 'm5-capacity-private-seed' }, host)).statusCode).toBe(200);
    const players: Login[] = [];
    for (let i = 0; i < 5; i++) players.push(login(await post(server, '/api/join', { name: `Remote ${i + 1}`, inviteCode: host.body.lobby.inviteCode })));
    expect((await post(server, '/api/join', { name: 'Excess', inviteCode: host.body.lobby.inviteCode })).json().code).toBe('REMOTE_PLAYER_CAPACITY');
    const hostJoin = await post(server, '/api/join', { name: 'Host', inviteCode: host.body.lobby.inviteCode, hostPlayer: true }, host); expect(hostJoin.statusCode, hostJoin.body).toBe(200); host.body = hostJoin.json(); players.push(host);
    expect((await post(server, '/api/host/lobby', { teamPreset: 'five_vs_five' }, host)).json().code).toBe('PRESET_HUMAN_CAPACITY');
    expect((await post(server, '/api/host/ai', { playerId: 'ai_2', difficulty: 'hard', personality: 'marshal' }, host)).statusCode).toBe(200);
    const swapped = (await post(server, '/api/host/identity', { playerId: host.body.playerId, pattern: 7 }, host)).json().lobby;
    expect(new Set(swapped.players.map((player: any) => player.color)).size).toBe(11);
    expect(new Set(swapped.players.map((player: any) => player.pattern)).size).toBe(11);
    expect(new Set(swapped.players.filter((player: any) => player.kind === 'human').map((player: any) => player.teamId)).size).toBe(1);
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    const clients = await Promise.all(players.map(player => connectPlayer(server, player)));
    for (const player of players) await post(server, '/api/ready', { ready: true }, player);
    const started = await post(server, '/api/host/start', {}, host);
    expect(started.statusCode, started.body).toBe(200);
    await expect.poll(() => clients.every(client => client.latest()?.status === 'RUNNING'), { timeout: 15000 }).toBe(true);
    for (let index = 0; index < clients.length; index++) {
      const client = clients[index]!, view = client.latest()!;
      expect(view.playerId).toBe(players[index]!.body.playerId); expect(view.players).toHaveLength(11);
      expect(view.entities.some(entity => entity.ownerId?.startsWith('ai_'))).toBe(false);
      expect(JSON.stringify(view)).not.toContain('m5-capacity-private-seed');
      if (index < 5) expect(JSON.stringify(client.wire)).not.toContain('m5-capacity-private-seed');
      expect(view.players.every(player => !Object.hasOwn(player, 'resources'))).toBe(true);
    }
    expect((await server.app.inject({ url: '/api/host/recovery', headers: { cookie: players[0]!.cookie } })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/debug/state', headers: { cookie: players[0]!.cookie } })).statusCode).toBe(404);
  }, 35000);

  it.each([['json','portable'],['json','native'],['owned','portable'],['fog','native'],['fog','portable']] as const)('restores a queued purchase with a new epoch, rejects old authority and issues single-use slot credentials (%s / %s)', async (publicationPreparation,snapshotEncoding) => {
    const { server, host, remote, clients } = await twoHumans({publicationPreparation,snapshotEncoding});
    const view = clients[0]!.latest()!, town = view.entities.find(entity => entity.ownerId === view.playerId && entity.typeId === 'town_center')!;
    const command = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: 'saved-purchase', clientSequence: 1, command: { kind: 'train', buildingId: town.id, unitType: 'villager', quantity: 1 } };
    clients[0]!.socket.send(JSON.stringify(command));
    await expect.poll(() => clients[0]!.packets.find(packet => packet.type === 'receipt')?.receipt.status).toBe('accepted');
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    expect((await post(server, '/api/host/save', { name: 'Queued villager' }, host)).statusCode).toBe(200);
    const recovery = (await server.app.inject({ url: '/api/host/recovery', headers: { cookie: host.cookie } })).json();
    expect(validateHostRecoveryResponse(recovery)).toBe(true); expect(recovery.saves).toHaveLength(1);
    const saveId = recovery.saves[0].id, path = join(server.dataDir, 'saves', `${saveId}.json`), portable = await readFile(path, 'utf8');
    for (const secret of [host.cookie.split('=')[1]!, remote.cookie.split('=')[1]!, host.csrf, remote.csrf]) expect(portable).not.toContain(secret);
    expect((await post(server, '/api/host/load', { saveId, confirmed: true }, remote)).statusCode).toBe(403);
    expect((await post(server, '/api/host/load', { saveId }, host)).json().code).toBe('CONFIRMATION_REQUIRED');
    await post(server, '/api/host/pause', { paused: false }, host); await post(server, '/api/host/pause', { paused: true }, host);
    await writeFile(path, portable.replace('Queued villager', 'Tampered label'));
    expect((await post(server, '/api/host/load', { saveId, confirmed: true }, host)).json().code).toBe('SAVE_CHECKSUM_MISMATCH');
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().playerId).toBe(view.playerId);
    await writeFile(path, portable);
    const restored = await post(server, '/api/host/load', { saveId, confirmed: true }, host);
    expect(restored.statusCode, restored.body).toBe(200); expect(restored.json().lobby.status).toBe('PAUSED'); expect(restored.json().playerId).toBeUndefined();
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: remote.cookie } })).json().playerId).toBeUndefined();
    expect((await post(server, '/api/host/pause', { paused: false }, host)).json().code).toBe('REISSUE_REJOIN_INVITES');
    const hostInvite = (await post(server, '/api/host/rejoin-invite', { playerId: view.playerId }, host)).json();
    expect((await post(server, '/api/rejoin', { token: hostInvite.token })).json().code).toBe('REJOIN_REJECTED');
    const remoteInvite = (await post(server, '/api/host/rejoin-invite', { playerId: remote.body.playerId }, host)).json();
    const newHost = login(await post(server, '/api/rejoin', { token: hostInvite.token }, host));
    expect(newHost.body.host).toBe(true); expect(newHost.cookie).not.toBe(host.cookie);
    const newRemote = login(await post(server, '/api/rejoin', { token: remoteInvite.token }, remote));
    expect(newRemote.body.host).toBe(false); expect(newRemote.cookie).not.toBe(remote.cookie);
    expect((await post(server, '/api/rejoin', { token: remoteInvite.token })).statusCode).toBe(403);
    expect((await post(server, '/api/host/pause', { paused: false }, host)).statusCode).toBe(403);
    const hostClient = await connectPlayer(server, newHost), remoteClient = await connectPlayer(server, newRemote);
    await expect.poll(() => hostClient.latest()?.status).toBe('PAUSED');
    const recovered = hostClient.latest()!;
    expect(recovered.matchEpoch).toBeGreaterThan(view.matchEpoch + 3); expect(recovered.self.resources.food).toBe(150);
    expect(recovered.self.lastCommandSequence).toBe(0); expect(recovered.entities.find(entity => entity.id === town.id)?.queue).toHaveLength(1);
    hostClient.socket.send(JSON.stringify({ ...command, clientCommandId: 'obsolete-epoch', clientSequence: 2 }));
    await expect.poll(() => hostClient.packets.find(packet => packet.type === 'receipt')?.receipt.status).toBe('rejected');
    expect((await post(server, '/api/host/pause', { paused: false }, newHost)).statusCode).toBe(200);
    await expect.poll(() => remoteClient.latest()?.status).toBe('RUNNING');
  }, 35000);

  it('commits pause authority only after a successful worker reply and serializes concurrent transitions', async () => {
    const { server, host, remote, clients } = await twoHumans();
    expect((await post(server, '/api/pause-request', {}, remote)).statusCode).toBe(200);
    const before = clients[0]!.latest()!, wireStart = clients[0]!.wire.length;
    let rejectPause!: (error: Error) => void;
    const statusCall = vi.spyOn(SimulationBridge.prototype, 'status').mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPause = reject; }));
    try {
      const first = post(server, '/api/host/pause', { paused: true }, host);
      await expect.poll(() => statusCall.mock.calls.length).toBe(1);
      expect((await post(server, '/api/host/pause', { paused: false }, host)).json().code).toBe('PAUSE_BUSY');
      const pendingLobby = (await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby;
      expect(pendingLobby.status).toBe('RUNNING'); expect(pendingLobby.pauseRequests).toHaveLength(1);
      rejectPause(new Error('WORKER_TIMEOUT')); expect((await first).statusCode).toBe(500);
      const failedLobby = (await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby;
      expect(failedLobby.status).toBe('RUNNING'); expect(failedLobby.pauseReason).toBeUndefined(); expect(failedLobby.pauseRequests).toHaveLength(1);
      expect(clients[0]!.wire.slice(wireStart).some(packet => packet.type === 'lobby' && packet.lobby.status === 'PAUSED')).toBe(false);
    } finally { statusCall.mockRestore(); }
    const unit = before.entities.find(entity => entity.ownerId === before.playerId && entity.kind === 'unit')!;
    clients[0]!.socket.send(JSON.stringify({ protocolVersion: 2, matchId: before.matchId, matchEpoch: before.matchEpoch, clientCommandId: 'pause-failure-authority', clientSequence: 1, command: { kind: 'stop', unitIds: [unit.id] } }));
    await expect.poll(() => clients[0]!.packets.find(packet => packet.type === 'receipt' && packet.receipt.clientCommandId === 'pause-failure-authority')?.receipt.status).toBe('accepted');
    expect((await post(server, '/api/host/pause', { paused: true }, host)).statusCode).toBe(200);
    await expect.poll(() => clients[0]!.latest()?.status).toBe('PAUSED');
    expect(clients[0]!.latest()!.matchEpoch).toBe(before.matchEpoch + 1);
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby.pauseRequests).toEqual([]);
  }, 25000);

  it('reserves disconnected slots by default, requires a host decision at180s and pauses after all humans leave', async () => {
    let now = Date.now(); const { server, host, remote, clients } = await twoHumans({ clock: () => now, policyIntervalMs: 10 });
    const recovery = async () => (await server.app.inject({ url: '/api/host/recovery', headers: { cookie: host.cookie } })).json();
    clients[1]!.socket.close();
    await expect.poll(async () => (await recovery()).disconnected.length).toBe(1);
    now += 30001;
    await expect.poll(async () => (await recovery()).disconnected[0]?.seconds).toBeGreaterThanOrEqual(30);
    expect((await recovery()).disconnected[0].mode).toBe('grace');
    expect((await post(server, '/api/host/disconnect-choice', { playerId: remote.body.playerId, choice: 'surrender' }, host)).json().code).toBe('DISCONNECT_CHOICE_NOT_READY');
    now += 150000;
    await expect.poll(async () => (await recovery()).disconnected[0]?.decisionRequired).toBe(true);
    expect((await post(server, '/api/host/disconnect-choice', { playerId: remote.body.playerId, choice: 'keep_reserved' }, host)).statusCode).toBe(200);
    expect((await recovery()).disconnected[0].mode).toBe('reserved');
    expect((await post(server, '/api/pause-request', {}, remote)).statusCode).toBe(200);
    expect((await recovery()).pauseRequests[0].playerId).toBe(remote.body.playerId);
    expect((await post(server, '/api/pause-request', {}, remote)).statusCode).toBe(429);
    clients[0]!.socket.close(); await expect.poll(async () => (await recovery()).disconnected.length).toBe(2); now += 30001;
    await expect.poll(async () => (await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby.pauseReason).toBe('no_humans');
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby.status).toBe('PAUSED');
    const reconnected = await connectPlayer(server, remote); await expect.poll(() => reconnected.latest()?.status).toBe('PAUSED');
    expect(reconnected.latest()!.playerId).toBe(remote.body.playerId);
    now += 86400001;
    expect((await post(server, '/api/host/pause', { paused: false }, host)).statusCode).toBe(403);
  }, 25000);
});

describe('M0 host, sessions and lobby security', () => {
  describe('local host bootstrap', () => {
    it.each([
      ['http://127.0.0.1:3000', '127.0.0.1'],
      ['http://localhost:3000', '127.0.0.1'],
      ['http://[::1]:3000', '::1'],
      ['http://localhost:3000', '::ffff:127.0.0.1'],
      ['http://localhost:5173', '127.0.0.1'],
    ])('accepts allowed local origin %s from peer %s', async (localOrigin, remoteAddress) => {
      const server = await setup({ publicationThread: false, allowedOrigins: ['http://localhost:5173'] });
      const result = await server.app.inject({ method: 'POST', url: '/api/bootstrap', remoteAddress, headers: { origin: localOrigin }, payload: { token: 'test-bootstrap-secret' } });
      expect(result.statusCode).toBe(200); expect(result.json()).toMatchObject({ host: true, lobby: { status: 'LOBBY' } });
      expect(result.headers['set-cookie']).toContain('HttpOnly'); expect(result.headers['set-cookie']).toContain('SameSite=Strict');
      expect(result.body).not.toContain('test-bootstrap-secret');
    });
    it.each(['fresh', 'used', 'expired'])('rejects remote peers and LAN origins without exposing a %s token state', async state => {
      let now = 0;
      const lanOrigin = 'http://192.168.1.10:3000', server = await setup({ publicationThread: false, allowedOrigins: [lanOrigin], clock: () => now });
      if (state === 'used') await admin(server);
      if (state === 'expired') now += 10 * 60_000 + 1;
      const forged = await server.app.inject({ method: 'POST', url: '/api/bootstrap?source=local', remoteAddress: '192.0.2.20', payload: { token: 'test-bootstrap-secret' }, headers: {
        origin, forwarded: 'for=127.0.0.1;host=localhost:3000;proto=http', 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost:3000', 'x-real-ip': '127.0.0.1',
      } });
      const proxied = await server.app.inject({ method: 'POST', url: '/api/bootstrap', remoteAddress: '127.0.0.1', headers: { origin: lanOrigin }, payload: { token: 'test-bootstrap-secret' } });
      for (const result of [forged, proxied]) {
        expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_LOCAL_ONLY' }); expect(result.headers['set-cookie']).toBeUndefined();
      }
      expect((await server.app.inject('/api/session')).json().host).toBe(false);
      if (state === 'fresh') await admin(server);
    });
    it.each([
      'https://game.example', 'http://localhost.evil.example:3000', 'http://127.0.0.2:3000', 'http://127.1:3000', 'http://2130706433:3000', 'http://[::ffff:127.0.0.1]:3000',
    ])('rejects nonlocal origin %s even when explicitly allowed globally', async remoteOrigin => {
      const server = await setup({ publicationThread: false, allowedOrigins: [remoteOrigin] });
      const result = await server.app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin: remoteOrigin }, payload: { token: 'test-bootstrap-secret' } });
      expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_LOCAL_ONLY' }); expect(result.headers['set-cookie']).toBeUndefined();
      await admin(server);
    });
    it.each([undefined, 'null', 'http://localhost:5173', 'https://evil.example'])('rejects missing or globally disallowed origin %s', async rejectedOrigin => {
      const server = await setup({ publicationThread: false });
      const result = await server.app.inject({ method: 'POST', url: '/api/bootstrap?source=local', headers: rejectedOrigin ? { origin: rejectedOrigin } : {}, payload: { token: 'test-bootstrap-secret' } });
      expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_LOCAL_ONLY' }); expect(result.headers['set-cookie']).toBeUndefined();
      await admin(server);
    });
    it('rejects invalid bodies and wrong tokens without consuming the token, and retains the rate limit', async () => {
      const server = await setup({ publicationThread: false });
      for (const payload of [{}, { token: 7 }, { token: 'test-bootstrap-secret', extra: true }, { token: 'wrong' }]) {
        const result = await post(server, '/api/bootstrap', payload);
        expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_REJECTED' }); expect(result.headers['set-cookie']).toBeUndefined();
      }
      await admin(server);
      const limited = await post(server, '/api/bootstrap', { token: 'test-bootstrap-secret' });
      expect(limited.statusCode).toBe(429); expect(limited.json()).toEqual({ code: 'RATE_LIMITED' });
    });
    it('reports expiry after ten minutes without issuing host authority', async () => {
      let now = 0;
      const server = await setup({ publicationThread: false, clock: () => now }); now += 10 * 60_000 + 1;
      const result = await post(server, '/api/bootstrap', { token: 'test-bootstrap-secret' });
      expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_EXPIRED' }); expect(result.headers['set-cookie']).toBeUndefined();
      expect((await server.app.inject('/api/session')).json()).toMatchObject({ host: false, lobby: { status: 'SETUP' } });
    });
    it('reports reuse and preserves established host sessions over allowed remote origins after token expiry', async () => {
      let now = 0;
      const remoteOrigin = 'https://game.example', server = await setup({ publicationThread: false, allowedOrigins: [remoteOrigin], clock: () => now }), host = await admin(server);
      for (const elapsed of [0, 10 * 60_000 + 1]) {
        now = elapsed;
        const result = await post(server, '/api/bootstrap', { token: 'test-bootstrap-secret' });
        expect(result.statusCode).toBe(403); expect(result.json()).toEqual({ code: 'BOOTSTRAP_USED' }); expect(result.headers['set-cookie']).toBeUndefined();
      }
      const session = await server.app.inject({ url: '/api/session', remoteAddress: '192.0.2.20', headers: { origin: remoteOrigin, cookie: host.cookie } });
      expect(session.json()).toMatchObject({ host: true, csrfToken: host.csrf });
      const updated = await server.app.inject({ method: 'POST', url: '/api/host/lobby', remoteAddress: '192.0.2.20', headers: { origin: remoteOrigin, cookie: host.cookie, 'x-csrf-token': host.csrf }, payload: { aiCount: 2 } });
      expect(updated.statusCode).toBe(200); expect(updated.json().lobby.settings.aiCount).toBe(2);
    });
  });
  it('caps the five-human preset at five total including an optional host-player', async () => {
    const server = await setup(), host = await admin(server), inviteCode = host.body.lobby.inviteCode;
    expect((await post(server, '/api/host/lobby', { teamPreset: 'five_vs_five' }, host)).statusCode).toBe(200);
    expect((await post(server, '/api/join', { name: 'Host', inviteCode, hostPlayer: true }, host)).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await post(server, '/api/join', { name: `Remote ${i}`, inviteCode })).statusCode).toBe(200);
    expect((await post(server, '/api/join', { name: 'Sixth human', inviteCode })).json().code).toBe('PRESET_HUMAN_CAPACITY');
    const lobby = (await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby;
    expect(lobby.players).toHaveLength(10); expect(lobby.players.filter((player: any) => player.hostPlayer)).toHaveLength(1);
  });
  it('rejects unauthenticated admin, incorrect bootstrap, foreign origin, missing CSRF, reused bootstrap', async () => {
    const server = await setup();
    expect((await post(server, '/api/host/start', {})).statusCode).toBe(403);
    expect((await post(server, '/api/bootstrap', { token: 'wrong' })).statusCode).toBe(403);
    expect((await server.app.inject({ method: 'POST', url: '/api/bootstrap', payload: { token: 'test-bootstrap-secret' }, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    const host = await admin(server);
    expect((await server.app.inject({ method: 'POST', url: '/api/host/start', headers: { origin, cookie: host.cookie }, payload: {} })).statusCode).toBe(403);
    expect((await post(server, '/api/bootstrap', { token: 'test-bootstrap-secret' })).statusCode).toBe(403);
    expect((await server.app.inject({ url: '/api/session' })).json().lobby.inviteCode).toBeUndefined();
  });
  it('admits five remotes and one host, rejects extra human/AI and unknown settings atomically', async () => {
    const server = await setup(); const host = await admin(server); const inviteCode = host.body.lobby.inviteCode;
    expect((await post(server, '/api/host/lobby', { aiCount: 5 }, host)).statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await post(server, '/api/join', { name: `Player ${i}`, inviteCode })).statusCode).toBe(200);
    expect((await post(server, '/api/join', { name: 'Sixth', inviteCode })).json().code).toBe('REMOTE_PLAYER_CAPACITY');
    const joined = await post(server, '/api/join', { name: 'Host', inviteCode, hostPlayer: true }, host);
    expect(joined.json().lobby.players).toHaveLength(11);
    expect((await post(server, '/api/join', { name: 'Host another tab', inviteCode, hostPlayer: true }, host)).json().playerId).toBe(joined.json().playerId);
    expect((await post(server, '/api/host/lobby', { aiCount: 6 }, host)).statusCode).toBe(400);
    expect((await post(server, '/api/host/lobby', { seed: 'visible', aiCount: 1 }, host)).statusCode).toBe(400);
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: host.cookie } })).json().lobby.players).toHaveLength(11);
  });
  it('ordinary player cannot impersonate host or view invitation and sessions rotate without losing slot', async () => {
    const server = await setup(); const host = await admin(server);
    const player = login(await post(server, '/api/join', { name: 'Host', inviteCode: host.body.lobby.inviteCode }));
    expect(player.body.host).toBe(false); expect(player.body.lobby.inviteCode).toBeUndefined();
    expect((await post(server, '/api/host/lobby', { aiCount: 0 }, player)).statusCode).toBe(403);
    const reconnect = login(await post(server, '/api/reconnect', {}, player));
    expect(reconnect.cookie).not.toBe(player.cookie); expect(reconnect.body.playerId).toBe(player.body.playerId);
    expect((await server.app.inject({ url: '/api/session', headers: { cookie: player.cookie } })).json().playerId).toBeUndefined();
  });
  it('rejects malformed and oversized inputs and keeps health free of configuration', async () => {
    const server = await setup(); const host = await admin(server);
    expect((await post(server, '/api/join', { name: 'P', inviteCode: host.body.lobby.inviteCode, playerId: 'ai_1' })).statusCode).toBe(400);
    expect((await post(server, '/api/join', { name: 'x'.repeat(20000), inviteCode: 'bad' })).statusCode).toBe(413);
    expect((await server.app.inject('/api/health')).json()).toEqual({ ready: true, protocolVersion: 2 });
  });
  it('allows the host to remove an unavailable lobby player and release their reserved slot', async () => {
    const server = await setup(); const host = await admin(server);
    const player = login(await post(server, '/api/join', { name: 'Unavailable', inviteCode: host.body.lobby.inviteCode }));
    expect((await post(server, '/api/host/remove-player', { playerId: player.body.playerId }, player)).statusCode).toBe(403);
    expect((await post(server, '/api/host/remove-player', { playerId: player.body.playerId, forced: true }, host)).statusCode).toBe(400);
    expect((await post(server, '/api/host/remove-player', { playerId: player.body.playerId }, host)).statusCode).toBe(200);
    const session = (await server.app.inject({ url: '/api/session', headers: { cookie: player.cookie } })).json();
    expect(session.playerId).toBeUndefined(); expect(session.lobby.players.every((item: any) => item.kind === 'ai')).toBe(true);
    expect((await post(server, '/api/host/reset', {}, host)).statusCode).toBe(409);
  });
});

describe('M2 map selection and locked teams', () => {
  it('accepts both map types and host-only team assignments, requiring opposing teams', async () => {
    const server = await setup(); const host = await admin(server);
    const configured = await post(server, '/api/host/lobby', { aiCount: 2, mapType: 'river_divide' }, host);
    expect(configured.statusCode).toBe(200);
    expect(configured.json().lobby.settings.mapType).toBe('river_divide');
    expect(configured.json().lobby.canStart).toBe(true);
    const allied = await post(server, '/api/host/team', { playerId: 'ai_2', teamId: 'team_ai_1' }, host);
    expect(allied.statusCode).toBe(200); expect(allied.json().lobby.canStart).toBe(false);
    expect((await post(server, '/api/host/start', {}, host)).json().code).toBe('PLAYERS_NOT_READY');
    const opposed = await post(server, '/api/host/team', { playerId: 'ai_2', teamId: 'team_second' }, host);
    expect(opposed.json().lobby.canStart).toBe(true);
    expect((await post(server, '/api/host/team', { playerId: 'missing', teamId: 'team_second' }, host)).json().code).toBe('INVALID_PLAYER');
    expect((await post(server, '/api/host/team', { playerId: 'ai_2', teamId: 'team_ai_1', force: true }, host)).statusCode).toBe(400);
    const remote = login(await post(server, '/api/join', { name: 'Ally', inviteCode: host.body.lobby.inviteCode }));
    expect((await post(server, '/api/host/team', { playerId: remote.body.playerId, teamId: 'team_second' }, remote)).statusCode).toBe(403);
    await post(server, '/api/ready', { ready: true }, remote);
    const updated = await post(server, '/api/host/team', { playerId: remote.body.playerId, teamId: 'team_second' }, host);
    const changed = updated.json().lobby.players.find((player: any) => player.id === remote.body.playerId);
    expect(changed.teamId).toBe('team_second'); expect(changed.ready).toBe(false);
    await post(server, '/api/host/lobby', { aiCount: 1 }, host);
    const readded = await post(server, '/api/host/lobby', { aiCount: 2, mapType: 'open_frontier' }, host);
    expect(readded.json().lobby.players.find((player: any) => player.id === 'ai_2').teamId).toBe('team_ai_2');
  });
});

it('runs an isolated headless simulation worker and sends a separate authenticated viewpoint to each socket', async () => {
  const server = await setup(); const host = await admin(server); const players: Login[] = [];
  await post(server, '/api/host/lobby', { aiCount: 0, mapType: 'river_divide' }, host);
  for (let i = 0; i < 2; i++) players.push(login(await post(server, '/api/join', { name: `Human ${i}`, inviteCode: host.body.lobby.inviteCode })));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address() as { port: number };
  const messages: any[][] = [[], []];
  const sockets = await Promise.all(players.map(async (player, index) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: player.cookie } });
    const decode = viewpointDecoder();
    socket.on('message', data => { const message = decode(JSON.parse(data.toString())); if (!message) return; messages[index]!.push(message); if (message.type === 'snapshot' && message.view.status === 'LOADING') socket.send(JSON.stringify({ type: 'loaded', contentHash: message.view.contentHash, matchId: message.view.matchId, matchEpoch: message.view.matchEpoch })); });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); return socket;
  }));
  for (const player of players) expect((await post(server, '/api/ready', { ready: true }, player)).statusCode).toBe(200);
  expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
  await expect.poll(() => messages.every(list => list.some(message => message.type === 'snapshot' && message.view.status === 'RUNNING')), { timeout: 12000 }).toBe(true);
  const views = messages.map(list => [...list].reverse().find(message => message.type === 'snapshot').view);
  expect(views[0].map.type).toBe('river_divide');
  expect(views[0].map.terrain.some((region: any) => region.kind === 'water')).toBe(true);
  expect(views[0].map.terrain.some((region: any) => region.kind === 'bridge')).toBe(true);
  expect(views[0].map.seed).toBeUndefined(); expect(views[0].map.spawns).toBeUndefined();
  expect((await post(server, '/api/host/team', { playerId: views[0].playerId, teamId: views[1].players[1].teamId }, host)).json().code).toBe('LOBBY_CLOSED');
  expect(views[0].playerId).not.toBe(views[1].playerId);
  expect(views[0].seed).toBeUndefined(); expect(views[0].receipts).toBeUndefined();
  expect(views[0].entities.some((entity: any) => entity.ownerId === views[1].playerId)).toBe(false);
  expect(views[1].entities.some((entity: any) => entity.ownerId === views[0].playerId)).toBe(false);
  const town = views[0].entities.find((entity: any) => entity.typeId === 'town_center' && entity.ownerId === views[0].playerId);
  const command = { protocolVersion: 2, matchId: views[0].matchId, matchEpoch: views[0].matchEpoch, clientCommandId: 'network-train-dedup', clientSequence: 1, command: { kind: 'train', buildingId: town.id, unitType: 'villager', quantity: 1 } };
  sockets[0]!.send(JSON.stringify(command)); sockets[0]!.send(JSON.stringify(command));
  await expect.poll(() => messages[0]!.filter(message => message.type === 'receipt').length).toBe(2);
  const receipts = messages[0]!.filter(message => message.type === 'receipt').map(message => message.receipt);
  expect(receipts[0].status).toBe('accepted'); expect(receipts[1]).toEqual(receipts[0]);
  const rotated = login(await post(server, '/api/reconnect', {}, players[0]));
  const recovered: any[] = [];
  const restored = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: rotated.cookie } });
  const decodeRestored = viewpointDecoder();
  restored.on('message', data => { const message = decodeRestored(JSON.parse(data.toString())); if (message) recovered.push(message); });
  await new Promise<void>((resolve, reject) => { restored.once('open', resolve); restored.once('error', reject); });
  restored.send(JSON.stringify(command));
  await expect.poll(() => recovered.find(message => message.type === 'receipt')?.receipt.status).toBe('accepted');
  await expect.poll(() => recovered.find(message => message.type === 'snapshot')?.view.self.resources.food).toBe(150);
  const recoveredView = recovered.find(message => message.type === 'snapshot').view;
  expect(recoveredView.playerId).toBe(views[0].playerId);
  expect(recoveredView.entities.find((entity: any) => entity.id === town.id).queue).toHaveLength(1);
  expect(recovered.find(message => message.type === 'receipt').receipt).toEqual(receipts[0]);
  sockets[1]!.send(JSON.stringify({ ...command, clientCommandId: 'network-surrender', command: { kind: 'surrender' } }));
  await expect.poll(() => recovered.some(message => message.type === 'snapshot' && message.view.status === 'FINISHED')).toBe(true);
  expect((await post(server, '/api/host/reset', {}, host)).json().lobby.status).toBe('LOBBY');
  expect((await server.app.inject({ url: '/api/session', headers: { cookie: rotated.cookie } })).json().playerId).toBe(views[0].playerId);
  restored.close();
  for (const socket of sockets) socket.close();
});

it('M3 requires an authenticated explicit host confirmation to end an active match as a draw', async () => {
  const server=await setup(),host=await admin(server);
  expect((await post(server,'/api/host/end-draw',{confirmed:true})).statusCode).toBe(403);
  expect((await post(server,'/api/host/end-draw',{confirmed:true},host)).json().code).toBe('NO_ACTIVE_MATCH');
  expect((await post(server,'/api/host/lobby',{aiCount:2,monumentVictory:true},host)).json().lobby.settings.monumentVictory).toBe(true);
  expect((await post(server,'/api/host/lobby',{monumentVictory:'true'},host)).statusCode).toBe(400);
  expect((await post(server,'/api/host/start',{},host)).statusCode).toBe(200);
  await expect.poll(async()=> (await server.app.inject({url:'/api/session',headers:{cookie:host.cookie}})).json().lobby.status,{timeout:12000}).toBe('RUNNING');
  expect((await post(server,'/api/host/lobby',{monumentVictory:false},host)).json().code).toBe('INVALID_LOBBY');
  expect((await post(server,'/api/host/end-draw',{},host)).json().code).toBe('CONFIRMATION_REQUIRED');
  expect((await post(server,'/api/host/end-draw',{confirmed:false},host)).json().code).toBe('CONFIRMATION_REQUIRED');
  expect((await post(server,'/api/host/end-draw',{confirmed:true,extra:true},host)).json().code).toBe('CONFIRMATION_REQUIRED');
  expect((await server.app.inject({url:'/api/host/replays',headers:{cookie:host.cookie}})).json().code).toBe('REPLAY_REQUIRES_FINISHED_MATCH');
  await new Promise(resolve => setTimeout(resolve, 1250));
  const ended=await post(server,'/api/host/end-draw',{confirmed:true},host);expect(ended.statusCode).toBe(200);expect(ended.json().lobby.status).toBe('FINISHED');
  expect((await post(server,'/api/host/end-draw',{confirmed:true},host)).json().code).toBe('NO_ACTIVE_MATCH');
  const list = await server.app.inject({url:'/api/host/replays',headers:{cookie:host.cookie}});
  expect(list.statusCode, list.body).toBe(200); expect(list.json().warnings).toEqual([]); expect(list.json().recordings).toHaveLength(1);
  expect((await server.app.inject('/api/host/replays')).statusCode).toBe(403);
  const replayId = list.json().recordings[0].id;
  const opened = await post(server, '/api/host/replay/open', { replayId }, host); expect(opened.statusCode, opened.body).toBe(200);
  const { startTick, endTick, players } = opened.json(); expect(endTick).toBeGreaterThan(startTick);
  let frame: any;
  for (let attempt = 0; attempt < 10; attempt++) { const step = await post(server, '/api/host/replay/step', { targetTick: endTick, playerId: players[0].id }, host); expect(step.statusCode, step.body).toBe(200); frame = step.json(); if (frame.done) break; }
  expect(frame.done).toBe(true); expect(frame.tick).toBe(endTick); expect(frame.view.status).toBe('FINISHED'); expect(frame.view.playerId).toBe(players[0].id);
  expect(frame.view.entities.some((entity: any) => entity.ownerId === players[1].id)).toBe(false);
  const beginning = await post(server, '/api/host/replay/step', { targetTick: startTick, playerId: players[1].id }, host); expect(beginning.statusCode, beginning.body).toBe(200); expect(beginning.json().tick).toBe(startTick); expect(beginning.json().view.playerId).toBe(players[1].id);
  expect((await post(server, '/api/host/replay/step', { targetTick: endTick + 1, playerId: players[0].id }, host)).statusCode).toBe(400);
});

it('admits allied tribute once through real sockets and reports only each recipient bank', async () => {
  const server = await setup(); const host = await admin(server);
  await post(server, '/api/host/lobby', { aiCount: 1, sharedVision: false }, host);
  const players: Login[] = [];
  for (const name of ['Sender', 'Recipient']) {
    const player = login(await post(server, '/api/join', { name, inviteCode: host.body.lobby.inviteCode }));
    players.push(player);
    await post(server, '/api/host/team', { playerId: player.body.playerId, teamId: 'allied_humans' }, host);
  }
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const address = server.app.server.address() as { port: number };
  const packets: any[][] = [[], []];
  const sockets = await Promise.all(players.map(async (player, index) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, { headers: { origin, cookie: player.cookie } });
    const decode = viewpointDecoder();
    socket.on('message', data => {
      const packet = decode(JSON.parse(data.toString())); if (!packet) return; packets[index]!.push(packet);
      if (packet.type === 'snapshot' && packet.view.status === 'LOADING') socket.send(JSON.stringify({ type: 'loaded', contentHash: packet.view.contentHash, matchId: packet.view.matchId, matchEpoch: packet.view.matchEpoch }));
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); return socket;
  }));
  for (const player of players) await post(server, '/api/ready', { ready: true }, player);
  expect((await post(server, '/api/host/start', {}, host)).statusCode).toBe(200);
  const latest = (index: number) => [...packets[index]!].reverse().find(packet => packet.type === 'snapshot')?.view;
  await expect.poll(() => latest(0)?.status, { timeout: 12000 }).toBe('RUNNING');
  const view = latest(0);
  const envelope = { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientCommandId: 'tribute-dedup', clientSequence: 1, command: { kind: 'tribute', recipientId: players[1]!.body.playerId, resource: 'wood', amount: 100 } };
  sockets[0]!.send(JSON.stringify(envelope)); sockets[0]!.send(JSON.stringify(envelope));
  await expect.poll(() => packets[0]!.filter(packet => packet.type === 'receipt').length).toBe(2);
  const receipts = packets[0]!.filter(packet => packet.type === 'receipt').map(packet => packet.receipt);
  expect(receipts[0].status).toBe('accepted'); expect(receipts[1]).toEqual(receipts[0]);
  await expect.poll(() => latest(0)?.self.resources.wood).toBe(140);
  await expect.poll(() => latest(1)?.self.resources.wood).toBe(350);
  sockets[0]!.send(JSON.stringify({ ...envelope, clientCommandId: 'tribute-insufficient', clientSequence: 2, command: { ...envelope.command, amount: 200 } }));
  await expect.poll(() => packets[0]!.find(packet => packet.type === 'receipt' && packet.receipt.clientCommandId === 'tribute-insufficient')?.receipt.status).toBe('rejected');
  for (const index of [0, 1]) {
    expect(latest(index).economies).toBeUndefined();
    expect(latest(index).players.every((player: any) => player.resources === undefined)).toBe(true);
    expect(latest(index).self.resources.wood).toBe(index === 0 ? 140 : 350);
  }
  for (const socket of sockets) socket.close();
});
