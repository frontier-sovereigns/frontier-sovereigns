import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createPortListener } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import type { AiObservation } from '../../packages/simulation/src/ai-observation';
import type { EndpointStateResponse, HostDiagnosticsResponse, SessionResponse } from '@frontier/shared';
import { capture } from './capture';

// This is an explicitly local mock endpoint, not real-model compatibility evidence.
// Both processes belong to this fixture. All gameplay uses normal production routes.
let server: ChildProcess | undefined, endpoint: Server | undefined;
let origin = '', endpointOrigin = '', serverOutput = '', unavailable = false;
let active = 0, maximumActive = 0, probeCount = 0, modelsCount = 0;
const observations: AiObservation[] = [], endpointBodies: string[] = [], endpointErrors: string[] = [];
const bootstrap = 'commanders-browser-fixture-not-a-real-host-token';
const fixtureKey = 'local-mock-fixture-key-not-a-real-credential';
const reasoningMarker = 'LOCAL_MOCK_PRIVATE_REASONING_MUST_NOT_BE_FORWARDED';
const privateChat = '<img src=x onerror=alert(1)> PRIVATE_TEAM_ONLY_CHAT_NOT_FOR_MODEL';
const modelRequest = 'LOCAL_MOCK_REQUEST: Please send 10 wood to help my settlement.';

test.beforeAll(async () => {
  endpoint = createServer(async (request, response) => {
    try {
      if (request.url === '/custom/v1/models') { modelsCount++; response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'local-browser-mock' }] })); return; }
      if (request.url !== '/custom/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404).end(); return; }
      if (request.headers.authorization !== `Bearer ${fixtureKey}`) { endpointErrors.push('INCORRECT_FIXTURE_AUTHORIZATION'); response.writeHead(401).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString('utf8'); endpointBodies.push(text);
      const body = JSON.parse(text) as { messages: { role: string; content: string }[]; model: string; max_tokens: number };
      if (body.model !== 'local-browser-mock') endpointErrors.push('INCORRECT_FIXTURE_MODEL');
      const user = body.messages.find((message) => message.role === 'user')?.content ?? '';
      const probe = user === 'Reply with exactly {"ok":true}.';
      let content: unknown = { ok: true };
      if (probe) probeCount++;
      else {
        const observation = JSON.parse(user) as AiObservation; observations.push(observation);
        const addressed = observation.requests.find((entry) => entry.text === modelRequest);
        const ally = addressed && observation.references.find((entry) => entry.kind === 'ally' && entry.playerId === addressed.senderId);
        content = { schemaVersion: 1, observationId: observation.identity.observationId, strategy: 'Local mock fixture: continue ordinary economic orders.', goals: ally ? [{ kind: 'tribute', allyRef: ally.ref, resource: 'wood', amount: 10 }] : [], message: ally ? { recipientRef: ally.ref, text: 'I plan to send 10 wood. <b>This is plain text.</b>' } : null };
      }
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 250));
      active--;
      if (unavailable && !probe) { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Intentional local mock outage' } })); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content), reasoning: reasoningMarker } }], usage: { prompt_tokens: 700, completion_tokens: 90, total_tokens: 790 }, timings: { prompt_ms: 12, predicted_ms: 18 } }));
    } catch (error) { endpointErrors.push(String(error)); if (!response.headersSent) response.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => { endpoint!.once('error', reject); endpoint!.listen(0, '127.0.0.1', resolve); });
  const endpointAddress = endpoint.address(); if (!endpointAddress || typeof endpointAddress === 'string') throw new Error('No endpoint fixture port');
  endpointOrigin = `http://127.0.0.1:${endpointAddress.port}/custom/v1`;
  const listener = createPortListener(); await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No host fixture port');
  const port = address.port; await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: `runtime-data/e2e-commanders-${port}`, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap, AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => { if (server?.exitCode !== null) throw new Error(`Commander fixture host exited: ${serverOutput}`); return fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false); }, { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>((resolve) => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
  if (endpoint) { endpoint.closeAllConnections(); await new Promise<void>((resolve) => endpoint!.close(() => resolve())); }
});

test('M6 real commander UI, private dispatches and fallback with a local mock endpoint', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), remote = await remoteContext.newPage(), state = capture(host), enemy = capture(remote);
  host.setDefaultTimeout(15000); remote.setDefaultTimeout(15000);
  const privacyErrors: string[] = [];
  for (const page of [host, remote]) page.on('websocket', (socket) => socket.on('framereceived', ({ payload }) => {
    const text = payload.toString(); if ([fixtureKey, reasoningMarker, endpointOrigin].some((secret) => text.includes(secret))) privacyErrors.push('ENDPOINT_DETAIL_IN_SOCKET');
  }));
  const readSession = (page: Page) => page.request.get(`${origin}/api/session`).then((response) => response.json()) as Promise<SessionResponse>;
  const post = async (page: Page, path: string, body: unknown) => { const session = await readSession(page); return page.request.post(`${origin}${path}`, { headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken! }, data: body }); };
  const openEndpoint = async () => { await host.getByRole('button', { name: 'Saves and recovery', exact: true }).click(); await host.getByRole('button', { name: 'AI endpoint & diagnostics', exact: true }).click(); };
  const messages = () => state.communication?.messages ?? [];
  try {
    await host.goto(origin); await host.getByRole('tab', { name: 'Host access' }).click(); await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible(); const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto(origin); await remote.getByLabel('YOUR NAME').fill('Birch'); await remote.getByLabel('INVITATION CODE').fill(invite); await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await host.getByLabel('AI COMMANDERS').selectOption('5'); await expect(host.locator('select[aria-label$=" difficulty"]')).toHaveCount(5);
    const session = await readSession(host), ally = session.lobby.players.find((player) => player.kind === 'ai')!, hostile = session.lobby.players.filter((player) => player.kind === 'ai')[1]!;
    const own = session.lobby.players.find((player) => player.id === session.playerId)!;
    await host.getByLabel(`${ally.name} team`, { exact: true }).selectOption(own.teamId);
    const vision = host.getByRole('checkbox', { name: 'Share vision with teammates', exact: true }); if (await vision.isChecked()) { await vision.click(); await expect(vision).not.toBeChecked(); }
    await host.getByLabel('Private map seed', { exact: true }).fill('commanders-browser-mock-endpoint'); await host.getByRole('button', { name: 'Set seed', exact: true }).click();
    await host.getByRole('button', { name: 'AI endpoint & diagnostics', exact: true }).click();
    await host.getByLabel('Endpoint base URL', { exact: true }).fill(endpointOrigin); await host.getByLabel('Endpoint model', { exact: true }).fill('local-browser-mock'); await host.getByLabel('Endpoint API key', { exact: true }).fill(fixtureKey);
    await host.getByLabel('Maximum simultaneous requests', { exact: true }).fill('2'); await host.getByLabel('Request timeout (seconds)', { exact: true }).fill('5'); await host.getByLabel('Input token budget', { exact: true }).fill('8000');
    for (const difficulty of ['easy', 'medium', 'hard']) await host.getByLabel(`${difficulty} strategic interval seconds`, { exact: true }).fill('10');
    await host.getByRole('checkbox', { name: 'Allow authorized human chat to be sent to the model', exact: true }).uncheck();
    await host.getByRole('button', { name: 'Save endpoint settings', exact: true }).click(); await expect(host.locator('.endpoint-panel .recovery-notice')).toContainText('Endpoint settings saved'); await expect(host.getByLabel('Endpoint API key', { exact: true })).toHaveValue('');
    const endpointState = await host.request.get(`${origin}/api/host/endpoint`).then((response) => response.json()) as EndpointStateResponse;
    expect(endpointState.hasApiKey).toBe(true); expect(JSON.stringify(endpointState)).not.toContain(fixtureKey);
    await host.getByRole('checkbox', { name: 'Also check the optional model listing', exact: true }).check(); await host.getByRole('button', { name: 'Test endpoint', exact: true }).click();
    await expect(host.locator('.endpoint-probe')).toContainText('Successful round trip'); expect(probeCount).toBe(1); expect(modelsCount).toBe(1);
    await host.locator('.endpoint-probe').scrollIntoViewIfNeeded(); await host.screenshot({ path: 'runtime-data/e2e/m6-endpoint-probe.png' });
    await host.getByRole('button', { name: 'Close AI endpoint', exact: true }).click();
    expect((await remote.request.get(`${origin}/api/host/endpoint`)).status()).toBe(403); expect((await remote.request.get(`${origin}/api/host/diagnostics`)).status()).toBe(403);
    console.log('M6 browser: write-only fixture key retained, custom-prefix completion and optional model listing passed; ordinary endpoint access denied.');
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click(); await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 45000 }).toBe('RUNNING'); await expect.poll(() => enemy.view?.status, { timeout: 45000 }).toBe('RUNNING');
    await expect.poll(() => new Set(observations.map((entry) => entry.identity.playerId)).size, { timeout: 30000 }).toBe(5);
    await expect.poll(() => state.view!.players.filter((player) => player.kind === 'ai' && player.aiMode === 'model').length, { timeout: 20000 }).toBe(5);
    expect(observations.every((entry) => entry.identity.playerId === entry.player.id)).toBe(true); expect(maximumActive).toBeLessThanOrEqual(2);
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    await host.getByRole('button', { name: 'Chat and team signals', exact: true }).click(); await remote.getByRole('button', { name: 'Chat and team signals', exact: true }).click();
    const beforeChatKeys = state.commands.length, focusButton = host.getByRole('button', { name: 'Close chat and team signals', exact: true });
    await focusButton.focus(); await focusButton.press('h'); await focusButton.press('x'); await focusButton.press('1');
    await expect(host.locator('.selection-heading h2')).toHaveText('Your company'); expect(state.commands.length).toBe(beforeChatKeys);
    const cameraBeforeChatKey = await host.getByTestId('minimap').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    await host.keyboard.down('w'); await host.waitForTimeout(600); await host.keyboard.up('w');
    expect(await host.getByTestId('minimap').evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(cameraBeforeChatKey);
    await host.getByLabel('Chat message', { exact: true }).pressSequentially('whx123');
    await expect(host.locator('.selection-heading h2')).toHaveText('Your company'); expect(state.commands.length).toBe(beforeChatKeys);
    await expect(host.locator('.chat-privacy')).toContainText('Free-form text is not sent to the model');
    await expect(host.getByLabel('Address allied AI', { exact: true }).locator('option')).toHaveCount(2);
    await host.getByLabel('Address allied AI', { exact: true }).selectOption(ally.id); await host.getByLabel('Chat message', { exact: true }).fill(privateChat); await host.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(host.getByRole('log', { name: 'Recent messages', exact: true })).toContainText(privateChat); await expect(host.getByRole('log').locator('img')).toHaveCount(0);
    const privateRequestId = messages().find((entry) => entry.text === privateChat)?.requestId;
    expect(privateRequestId).toBeTruthy();
    await expect.poll(() => messages().some((entry) => entry.requestId === privateRequestId && entry.source === 'system' && entry.status === 'declined')).toBe(true);
    expect(enemy.communication?.messages.some((entry) => entry.text === privateChat)).toBe(false); expect(endpointBodies.some((entry) => entry.includes('PRIVATE_TEAM_ONLY_CHAT_NOT_FOR_MODEL'))).toBe(false);
    await host.getByLabel('Chat audience', { exact: true }).selectOption('all'); await host.getByLabel('Chat message', { exact: true }).fill('PUBLIC_BROWSER_DISPATCH: Good luck on the frontier.'); await host.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(remote.getByRole('log', { name: 'Recent messages', exact: true })).toContainText('PUBLIC_BROWSER_DISPATCH');
    await host.getByRole('button', { name: 'Close chat and team signals', exact: true }).click();
    const minimap = host.getByTestId('minimap'), rectangle = await minimap.boundingBox(); if (!rectangle) throw new Error('No minimap bounds');
    const beforeSignalCommands = state.commands.length; const beforeSignalTick = state.view!.tick;
    await host.keyboard.down('Alt'); await host.mouse.click(rectangle.x + rectangle.width * .9, rectangle.y + rectangle.height * .9); await host.keyboard.up('Alt');
    await expect.poll(() => state.communication?.pings.length ?? 0).toBe(1); await expect.poll(() => state.view!.tick).toBeGreaterThan(beforeSignalTick);
    expect(state.commands.length).toBe(beforeSignalCommands); expect(enemy.communication?.pings ?? []).toHaveLength(0);
    const signal = state.communication!.pings[0]!, columns = Math.ceil(state.view!.map.widthMm / state.view!.map.fogCellMm), cell = Math.floor(signal.zMm / state.view!.map.fogCellMm) * columns + Math.floor(signal.xMm / state.view!.map.fogCellMm);
    expect(state.view!.fog.visible).not.toContain(cell);
    await host.getByRole('button', { name: 'Chat and team signals', exact: true }).click(); await host.locator('.cooperation-section > summary').click();
    await host.getByLabel('Requested tribute amount', { exact: true }).fill('10'); const bankBeforePreset = state.view!.self.resources.wood;
    await host.getByRole('button', { name: 'Request tribute', exact: true }).click();
    await expect.poll(() => messages().filter((entry) => entry.targetAiId === ally.id && entry.text === 'Request 10 wood.').length).toBe(1);
    const presetId = messages().find((entry) => entry.text === 'Request 10 wood.')!.requestId!;
    await expect.poll(() => messages().some((entry) => entry.requestId === presetId && entry.status === 'completed'), { timeout: 30000 }).toBe(true);
    expect(state.view!.self.resources.wood).toBe(bankBeforePreset + 10);
    expect(messages().some((entry) => entry.requestId === presetId && entry.source === 'system' && entry.status === 'planned')).toBe(true);
    expect(endpointBodies.some((entry) => entry.includes('PRIVATE_TEAM_ONLY_CHAT_NOT_FOR_MODEL'))).toBe(false);
    await host.locator('.communications-panel').evaluate((element) => { element.scrollTop = 0; });
    await host.locator('.chat-history').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await host.screenshot({ path: 'runtime-data/e2e/m6-private-cooperation.png' });
    await remote.screenshot({ path: 'runtime-data/e2e/m6-public-chat-1280.png' });
    // Malicious clients cannot bypass the allied-only target chooser.
    expect((await post(remote, '/api/cooperate', { targetAiId: hostile.id, action: 'tribute', resource: 'wood', amount: 10 })).status()).toBe(403);
    expect((await post(remote, '/api/chat', { targetAiId: ally.id, channel: 'team', text: 'Unauthorized enemy request' })).status()).toBe(403);
    console.log('M6 browser: five independent observations, private plain-text chat, allied coordinate signal, and real tribute completion with chat forwarding disabled.');

    await host.getByRole('button', { name: 'Close chat and team signals', exact: true }).click(); await host.getByRole('button', { name: 'Pause', exact: true }).click(); await expect.poll(() => state.view!.status).toBe('PAUSED');
    await openEndpoint(); await host.getByRole('checkbox', { name: 'Allow authorized human chat to be sent to the model', exact: true }).check(); await host.getByRole('button', { name: 'Save endpoint settings', exact: true }).click();
    await expect(host.locator('.endpoint-panel .recovery-notice')).toContainText('Endpoint settings saved'); await expect(host.getByLabel('Endpoint API key', { exact: true })).toHaveValue('');
    await host.getByRole('button', { name: 'Close AI endpoint', exact: true }).click(); await host.getByRole('button', { name: 'Resume', exact: true }).click(); await expect.poll(() => state.view!.status).toBe('RUNNING');
    await host.getByRole('button', { name: 'Chat and team signals', exact: true }).click(); await host.getByLabel('Chat audience', { exact: true }).selectOption('team'); await host.getByLabel('Address allied AI', { exact: true }).selectOption(ally.id);
    const bankBeforeModel = state.view!.self.resources.wood; await host.getByLabel('Chat message', { exact: true }).fill(modelRequest); await host.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => messages().some((entry) => entry.text === modelRequest)).toBe(true); const modelId = messages().find((entry) => entry.text === modelRequest)!.requestId!;
    await expect.poll(() => messages().some((entry) => entry.requestId === modelId && entry.source === 'model' && entry.status === 'planned'), { timeout: 30000 }).toBe(true);
    await expect.poll(() => messages().some((entry) => entry.requestId === modelId && entry.source === 'system' && entry.status === 'completed'), { timeout: 30000 }).toBe(true);
    expect(state.view!.self.resources.wood).toBe(bankBeforeModel + 10); await expect(host.getByRole('log').locator('b').filter({ hasText: 'This is plain text.' })).toHaveCount(0);
    await expect(host.getByRole('log')).toContainText('<b>This is plain text.</b>');
    expect(observations.filter((entry) => entry.requests.some((request) => request.text === modelRequest)).every((entry) => entry.identity.playerId === ally.id)).toBe(true);
    expect(endpointBodies.some((entry) => entry.includes('PRIVATE_TEAM_ONLY_CHAT_NOT_FOR_MODEL'))).toBe(false);
    await host.screenshot({ path: 'runtime-data/e2e/m6-model-outcome.png' });
    await host.getByRole('button', { name: 'Close chat and team signals', exact: true }).click();
    unavailable = true; const tickBeforeOutage = state.view!.tick;
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Gather wood', exact: true }).click(); const woodBeforeOutage = state.view!.self.resources.wood;
    await expect.poll(() => state.view!.players.filter((player) => player.kind === 'ai' && player.aiMode === 'fallback').length, { timeout: 40000 }).toBeGreaterThan(0);
    await expect.poll(() => state.view!.self.resources.wood, { timeout: 40000 }).toBeGreaterThan(woodBeforeOutage); expect(state.view!.tick).toBeGreaterThan(tickBeforeOutage + 40);
    await expect(host.locator('.strategic-mode-summary')).toContainText('rule-based commander active');
    await openEndpoint();
    const diagnosticResponse = host.waitForResponse((response) => response.url() === `${origin}/api/host/diagnostics` && response.request().method() === 'GET');
    await host.getByRole('tab', { name: 'Live diagnostics', exact: true }).click();
    const response = await diagnosticResponse; expect(response.status()).toBe(200);
    const diagnostics = await response.json() as HostDiagnosticsResponse;
    await expect(host.locator('.diagnostic-commander')).toHaveCount(5);
    // Diagnostics reports the catalog-wide ceiling; this service retains its
    // configured two-request limit, verified against actual fixture concurrency.
    expect(diagnostics.scheduler.concurrency).toBe(11); expect(endpointState.settings.maxConcurrent).toBe(2); expect(maximumActive).toBeLessThanOrEqual(2);
    expect(diagnostics.scheduler.failed).toBeGreaterThan(0); expect(JSON.stringify(diagnostics)).not.toContain(fixtureKey); expect(JSON.stringify(diagnostics)).not.toContain(reasoningMarker);
    expect(diagnostics.scheduler.usageTotals!.reportedRequests).toBeGreaterThanOrEqual(5);
    await expect(host.locator('.diagnostic-usage')).toContainText('Unreported usage is unknown');
    expect(diagnostics.transport?.scope).toBe('websocket_application_payload_enqueued');expect(diagnostics.transport?.windowMs).toBe(10000);
    expect(diagnostics.transport!.clients.map(client=>client.playerId).sort()).toEqual([state.view!.playerId,enemy.view!.playerId].sort());
    expect(diagnostics.transport!.clients.every(client=>client.connections===1&&client.totalBytes>0&&client.bytesPerSecond>0)).toBe(true);
    const payloads=host.locator('.endpoint-section').filter({has:host.getByRole('heading',{name:'Outbound application payloads',exact:true})});
    await expect(payloads.getByRole('columnheader',{name:'Payload bytes',exact:true})).toBeVisible();await expect(payloads.getByRole('row')).toHaveCount(3);
    await expect(payloads).toContainText('WebSocket framing, compression, TLS, TCP/IP and HTTP traffic are excluded');
    await host.screenshot({ path: 'runtime-data/e2e/m6-redacted-diagnostics.png' }); await host.getByRole('button', { name: 'Close AI endpoint', exact: true }).click();
    expect(state.errors).toEqual([]); expect(enemy.errors).toEqual([]); expect(state.protocolErrors).toEqual([]); expect(enemy.protocolErrors).toEqual([]); expect(privacyErrors).toEqual([]); expect(endpointErrors).toEqual([]); expect(maximumActive).toBeLessThanOrEqual(2);
    const decodedPackets = JSON.stringify([state.view, state.communication, enemy.view, enemy.communication]);
    for (const secret of [fixtureKey, reasoningMarker, endpointOrigin]) expect(decodedPackets).not.toContain(secret);
    expect(serverOutput).not.toContain(fixtureKey); expect(serverOutput).not.toContain(reasoningMarker);
    console.log('M6 browser: addressed mock-model plan and verified tribute outcome correlated; endpoint outage left ticks and gathering live with truthful fallback and redacted diagnostics.');
  } catch (error) { await testInfo.attach('authorized-commander-diagnostics', { body: JSON.stringify({ host: state, remote: enemy, endpoint: { probeCount, modelsCount, maximumActive, requests: observations.map((entry) => ({ playerId: entry.identity.playerId, tick: entry.identity.observedTick, requests: entry.requests.map((request) => request.requestId) })) }, endpointErrors, privacyErrors }), contentType: 'application/json' }); throw error; }
  finally { await hostContext.close(); await remoteContext.close(); }
});
