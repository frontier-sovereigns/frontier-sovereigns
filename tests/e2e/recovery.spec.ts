import { capture } from './capture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import type { BalanceData, ComputeWorkerLane, HostDiagnosticsResponse, HostRecoveryResponse, MetricPercentiles, ReplayStepResponse } from '@frontier/shared';
const content = JSON.parse(readFileSync('data/balance.v1.json', 'utf8')) as BalanceData;

// This fixture owns its host process and bootstrap token. It never relies on another
// test's one-time host login or changes the production authentication rules.
let server: ChildProcess | undefined;
let origin = '';
let serverOutput = '';
const bootstrap = 'recovery-browser-fixture-not-a-real-host-token';
test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: `runtime-data/e2e-recovery-${port}`, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`Recovery fixture host exited: ${serverOutput}`);
    return fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>((resolve) => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
});

async function openMockRecoveryHost(page: Page) {
  // UI failure fixtures do not consume the real cold-load scenario's host login.
  // Only session presentation is mocked; no private save or live host is accessed.
  const session = await page.request.get(`${origin}/api/session`).then(response => response.json());
  session.host = true; session.lobby.status = 'LOBBY';
  await page.route(`${origin}/api/session`, route => route.fulfill({ json: session }));
  await page.route(`${origin}/api/host/models`, route => route.fulfill({ json: { models: [] } }));
  await page.routeWebSocket(url => url.pathname === '/ws', () => undefined);
  await page.goto(origin);
  await page.getByRole('button', { name: 'Saves and recovery', exact: true }).click();
}

test('recovery list shows slow scans, retries and load errors without hiding compatible saves', async ({ page }) => {
  await page.clock.install();
  let pending: Route | undefined, loadRequest: Route | undefined, scans = 0;
  const response: HostRecoveryResponse = {
    saves: [{ id: 'manual_1791277950031_4389521bcd53161e', kind: 'manual', label: 'Compatible checkpoint', createdAt: '2026-10-06T09:12:30.000Z', tick: 4800, bytes: 16606847 }],
    warnings: Array.from({ length: 71 }, (_, index) => ({ id: `old_save_${index}`, code: 'ENGINE_VERSION_MISMATCH' })),
    persistence: { journalHealthy: true }, disconnected: [], restoreSlots: [],
  };
  await page.route(`${origin}/api/host/recovery`, route => { scans++; if (scans === 1) { pending = route; return; } return route.fulfill({ json: response }); });
  await page.route(`${origin}/api/host/load`, route => { loadRequest = route; });
  await openMockRecoveryHost(page);
  const dialog = page.getByRole('dialog', { name: 'Host saves and recovery' }), loadArea = dialog.getByRole('region', { name: 'Load saved game' });
  await expect(loadArea).toHaveAttribute('aria-busy', 'true');
  await expect(loadArea).toContainText('Checking saved games for compatibility');
  await expect(dialog.getByRole('button', { name: 'Refresh list', exact: true })).toBeDisabled();
  await page.clock.fastForward(26000);
  expect(scans).toBe(1);
  await expect(loadArea).toContainText('Checking saved games for compatibility');
  await expect(loadArea).not.toContainText('No compatible saves');
  await expect.poll(() => !!pending).toBe(true);
  await pending!.fulfill({ status: 500, json: { code: 'SAVE_DIRECTORY_UNAVAILABLE' } });
  await expect(loadArea.getByRole('alert')).toContainText('Could not read saved games');
  await expect(dialog).toContainText('Command journal status unavailable');
  await expect(dialog).not.toContainText('Reading host recovery information');
  await dialog.getByRole('button', { name: 'Retry list', exact: true }).click();
  const loadButton = loadArea.getByRole('button', { name: 'Load save Compatible checkpoint', exact: true });
  await expect(loadButton).toBeEnabled(); expect(scans).toBe(2);
  await expect(loadArea).toHaveAttribute('aria-busy', 'false');
  await expect(loadArea.getByRole('button', { name: 'Load latest autosave', exact: true })).toBeDisabled();
  await expect(dialog.locator('.save-warnings')).not.toHaveAttribute('open');
  await expect(dialog.locator('.save-warnings summary')).toHaveText('71 unavailable saves');
  const savedBounds = await loadArea.boundingBox(), newSaveBounds = await dialog.locator('.manual-save').boundingBox();
  expect(savedBounds!.y).toBeLessThan(newSaveBounds!.y);
  await loadButton.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Confirm save load' });
  await confirmation.getByRole('button', { name: 'Confirm load' }).click();
  await expect.poll(() => !!loadRequest).toBe(true);
  await expect(confirmation.getByRole('status')).toContainText('Restoring the saved match');
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Keep current match', exact: true })).toBeDisabled();
  await loadRequest!.fulfill({ status: 400, json: { code: 'SAVE_PAYLOAD_INVALID' } });
  await expect(confirmation.getByRole('alert')).toHaveText('SAVE PAYLOAD INVALID');
  await expect(confirmation.getByRole('button', { name: 'Keep current match', exact: true })).toBeEnabled();
  await confirmation.getByRole('button', { name: 'Keep current match', exact: true }).click();
  await expect(loadButton).toBeEnabled();
});

test('recovery list times out with a retry and cancels a scan when closed', async ({ page }) => {
  await page.clock.install();
  let scans = 0;
  const aborted: string[] = [];
  page.on('requestfailed', request => { if (request.url() === `${origin}/api/host/recovery`) aborted.push(request.failure()?.errorText ?? 'failed'); });
  await page.route(`${origin}/api/host/recovery`, () => { scans++; });
  await openMockRecoveryHost(page);
  const dialog = page.getByRole('dialog', { name: 'Host saves and recovery' });
  await expect.poll(() => scans).toBe(1);
  await page.clock.fastForward(60001);
  await expect(dialog.getByRole('alert')).toContainText('Checking saved games took more than a minute');
  await expect(dialog.getByRole('button', { name: 'Retry list', exact: true })).toBeEnabled();
  await expect.poll(() => aborted.length).toBe(1);
  await dialog.getByRole('button', { name: 'Retry list', exact: true }).click();
  await expect.poll(() => scans).toBe(2);
  await dialog.getByRole('button', { name: 'Close saves and recovery', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => aborted.length).toBe(2);
  await page.getByRole('button', { name: 'Saves and recovery', exact: true }).click();
  await expect.poll(() => scans).toBe(3);
  await expect(dialog.getByRole('region', { name: 'Load saved game' })).toHaveAttribute('aria-busy', 'true');
});

test('M5 real chunked recovery, impaired connection, saved slots, and caretaker control', async ({ browser }, testInfo) => {
  test.setTimeout(480000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await hostContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Fixture private storage blocked', 'SecurityError'); } }));
  const host = await hostContext.newPage(); let remote = await remoteContext.newPage();
  const state = capture(host, true); let enemy = capture(remote);
  let dropDelta = false, loseReceipt = false, receiptLost = false, dropped = false;
  let reloaded = false, routedConnections = 0, nativeReloadConnections = 0;
  let holdSessionPoll = false, staleSessionPoll: Route | undefined, holdRetryReceipt = false, lostCommandId = '';
  const heldReceipts: (() => void)[] = [];
  const networkErrors: string[] = [];
  await host.route(`${origin}/api/session`, route => {
    if (holdSessionPoll && route.request().method() === 'GET') { holdSessionPoll = false; staleSessionPoll = route; return; }
    return route.continue();
  });
  // Chromium may create a native socket during document replacement before the
  // page route is reinstalled. Capture that real transport after the impairment phase.
  host.on('websocket', (socket) => {
    if (!reloaded) return;
    nativeReloadConnections++; const stream = state.openStream();
    socket.on('framereceived', ({ payload }) => stream.received(payload)); socket.on('framesent', ({ payload }) => stream.sent(payload)); socket.on('close', stream.close);
  });
  await host.routeWebSocket(url => url.pathname === '/ws', (socket) => {
    routedConnections++;
    const server = socket.connectToServer(), stream = state.openStream(); let closed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (run: () => void) => { const timer = setTimeout(() => { timers.delete(timer); if (!closed) try { run(); } catch (error) { networkErrors.push(String(error)); } }, 75); timers.add(timer); };
    const stop = () => { closed = true; for (const timer of timers) clearTimeout(timer); stream.close(); };
    const closeOptions = (code: number | undefined, reason: string | undefined) => code === undefined || code === 1005 || code === 1006 ? {} : { code, reason };
    socket.onClose((code, reason) => { if (closed) return; stop(); void server.close(closeOptions(code, reason)).catch(() => undefined); });
    server.onClose((code, reason) => { if (closed) return; stop(); void socket.close(closeOptions(code, reason)).catch(() => undefined); });
    socket.onMessage((message) => { stream.sent(message); later(() => server.send(message)); });
    server.onMessage((message) => {
      if (closed) return;
      const parsed = JSON.parse(message.toString());
      if (dropDelta && parsed.type === 'delta') { dropDelta = false; dropped = true; return; }
      if (loseReceipt && parsed.type === 'receipt' && parsed.receipt.status === 'accepted') {
        loseReceipt = false; receiptLost = true; lostCommandId = parsed.receipt.clientCommandId;
        // Cut the impaired link at this exact acknowledgement, including queued
        // deliveries, rather than allowing later frames to race the close timer.
        stop(); void Promise.all([socket.close({ code: 1012, reason: 'fixture connection interruption' }), server.close({ code: 1012, reason: 'fixture connection interruption' })]).catch(() => undefined); return;
      }
      if (holdRetryReceipt && parsed.type === 'receipt' && parsed.receipt.clientCommandId === lostCommandId) { heldReceipts.push(() => later(() => { stream.received(message); socket.send(message); })); return; }
      later(() => { stream.received(message); socket.send(message); });
    });
  });
  host.setDefaultTimeout(15000); remote.setDefaultTimeout(15000); let gameplayFailed = false;
  try {
    await host.goto(origin); await host.getByRole('tab', { name: 'Host access' }).click(); await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible(); const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto(origin); await remote.getByLabel('YOUR NAME').fill('Birch'); await remote.getByLabel('INVITATION CODE').fill(invite); await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await remote.getByRole('button', { name: 'Leave player slot', exact: true }).click(); await expect(remote.getByRole('button', { name: 'Enter the frontier' })).toBeVisible();
    await remote.getByRole('button', { name: 'Enter the frontier' }).click(); await expect(remote.getByRole('button', { name: 'Ready to begin' })).toBeVisible();
    await host.getByRole('button', { name: 'Replace invitation', exact: true }).click(); await expect(host.locator('.invite-code')).not.toHaveText(invite); await expect(remote.getByRole('button', { name: 'Ready to begin' })).toBeVisible();
    await host.getByRole('button', { name: 'Preset 5 humans vs 5 AI', exact: true }).click(); await expect(host.getByLabel('AI COMMANDERS')).toHaveValue('5'); await expect(host.getByRole('button', { name: 'Begin match' })).toBeDisabled();
    await host.getByRole('button', { name: 'Preset 6 humans vs 5 AI', exact: true }).click(); await expect(host.getByRole('button', { name: 'Preset 6 humans vs 5 AI', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await host.locator('select[aria-label$=" difficulty"]').first().selectOption('hard'); await host.locator('select[aria-label$=" personality"]').first().selectOption('raider');
    await host.getByLabel('Aster color and pattern', { exact: true }).selectOption('6');
    await host.getByLabel('Private map seed', { exact: true }).fill('recovery-browser-ordinary-map'); await host.getByRole('button', { name: 'Set seed', exact: true }).click();
    await host.getByRole('checkbox', { name: 'Enable medium rule-based caretaker after 30 seconds' }).click(); await expect(host.getByRole('checkbox', { name: 'Enable medium rule-based caretaker after 30 seconds' })).toBeChecked();
    await expect(host.getByRole('checkbox', { name: 'Pause after all humans disconnect for 30 seconds' })).toBeChecked();
    const publicSession = await remote.request.get(`${origin}/api/session`).then((response) => response.json()); expect(publicSession.lobby.hostSeed).toBeUndefined();
    await host.screenshot({ path: 'runtime-data/e2e/m5-lobby-options.png', fullPage: true });
    await host.getByRole('button', { name: 'Preset Free for all', exact: true }).click(); await host.getByLabel('AI COMMANDERS').selectOption('0');
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click(); await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 40000 }).toBe('RUNNING'); await expect.poll(() => enemy.view?.status, { timeout: 40000 }).toBe('RUNNING');
    const playerId = state.view!.playerId, remoteId = enemy.view!.playerId;
    expect(state.chunks).toBeGreaterThan(0); await expect.poll(() => state.deltas).toBeGreaterThan(2);
    console.log('M5 browser: chunked viewpoints and deltas running with75ms each-way message latency.');

    const beforeResync = state.fullViews; dropDelta = true;
    await expect.poll(() => dropped).toBe(true); await expect.poll(() => state.fullViews, { timeout: 20000 }).toBeGreaterThan(beforeResync);
    await expect(host.locator('.match-clock')).toContainText('Connected');
    holdSessionPoll = true; await expect.poll(() => Boolean(staleSessionPoll)).toBe(true);
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); const food = state.view!.self.resources.food; loseReceipt = true; holdRetryReceipt = true;
    await host.getByRole('button', { name: 'Train Villager', exact: true }).click();
    await expect.poll(() => receiptLost).toBe(true); await expect(host.locator('.match-clock')).toContainText('Connected', { timeout: 20000 });
    await expect.poll(() => state.commands.filter((entry) => entry.command.kind === 'train').length, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    await expect.poll(() => heldReceipts.length).toBeGreaterThan(0);
    // This real request retained the pre-rotation cookie. Resolve it after the
    // successful reconnect and prove its anonymous reply cannot clear identity
    // or the still-unacknowledged, already retried paid command.
    const stale = await staleSessionPoll!.fetch({ headers: await staleSessionPoll!.request().allHeaders() });
    const staleValue = await stale.json(); expect(staleValue.host).toBe(false); expect(staleValue.playerId).toBeUndefined();
    const staleDelivered = host.waitForResponse(async response => response.url() === `${origin}/api/session` && !(await response.json()).host);
    await staleSessionPoll!.fulfill({ response: stale }); await staleDelivered;
    await host.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(host.getByTestId('game-hud')).toBeVisible(); await expect(host.locator('.receipt')).toHaveText('1 order awaiting receipt');
    holdRetryReceipt = false; for (const deliver of heldReceipts.splice(0)) deliver();
    await expect.poll(() => state.receipts.some(receipt => receipt.clientCommandId === lostCommandId && receipt.status === 'accepted')).toBe(true);
    const train = state.commands.find((entry) => entry.command.kind === 'train')!;
    expect(state.commands.filter((entry) => entry.command.kind === 'train').every((entry) => entry.clientCommandId === train.clientCommandId)).toBe(true);
    await expect.poll(() => state.view!.self.resources.food).toBe(food - content.units.find((unit) => unit.id === 'villager')!.cost.food);
    const watermark = state.view!.self.lastCommandSequence, fullBeforeReload = state.fullViews;
    reloaded = true; await host.reload(); await expect.poll(() => state.fullViews, { timeout: 15000 }).toBeGreaterThan(fullBeforeReload); await expect(host.getByTestId('game-hud')).toBeVisible();
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await expect.poll(() => state.commands.at(-1)?.clientSequence).toBeGreaterThan(watermark);
    await expect.poll(() => state.receipts.some((receipt) => receipt.clientCommandId === state.commands.at(-1)?.clientCommandId && receipt.status === 'accepted')).toBe(true);
    console.log(`M5 browser: missing delta resynced; lost receipt replay spent once; blocked-storage reload recovered sequence (${routedConnections} routed sockets, ${nativeReloadConnections} native reload sockets).`);
    await remote.getByRole('button', { name: 'Request pause', exact: true }).click(); await expect(host.locator('.host-pause-notice')).toBeVisible();
    await host.getByRole('button', { name: 'Pause', exact: true }).click(); await expect.poll(() => state.view!.status).toBe('PAUSED'); await host.getByRole('button', { name: 'Resume', exact: true }).click(); await expect.poll(() => state.view!.status).toBe('RUNNING');

    const disconnectedAt = Date.now(); await remote.close();
    await expect.poll(() => state.view!.players.find((player) => player.id === remoteId)?.controlMode, { timeout: 45000 }).toBe('caretaker');
    await expect(host.locator('.control-mode-notices')).toContainText('Birch: medium rule-based caretaker active');
    await host.screenshot({ path: 'runtime-data/e2e/m5-caretaker.png' });
    await host.getByRole('button', { name: 'Saves and recovery', exact: true }).click();
    await expect(host.getByRole('dialog', { name: 'Host saves and recovery' })).toContainText('Birch');
    await expect(host.getByRole('button', { name: 'Keep reserved', exact: true })).toHaveCount(0);
    await host.getByLabel('Save name', { exact: true }).fill('Browser recovery checkpoint'); await host.getByRole('button', { name: 'Save match' }).click();
    await expect(host.getByRole('dialog', { name: 'Host saves and recovery' }).getByRole('status')).toContainText('Save written successfully'); await expect(host.getByRole('button', { name: 'Load save Browser recovery checkpoint', exact: true })).toBeDisabled();
    await host.getByRole('button', { name: 'Close saves and recovery', exact: true }).click();
    await expect.poll(() => Date.now() - disconnectedAt, { timeout: 185000, intervals: [10000] }).toBeGreaterThanOrEqual(181000);
    await host.getByRole('button', { name: 'Saves and recovery', exact: true }).click(); await expect(host.getByRole('button', { name: 'Keep reserved', exact: true })).toBeEnabled();
    await host.getByRole('button', { name: 'Keep reserved', exact: true }).click(); await expect(host.getByRole('dialog', { name: 'Host saves and recovery' }).getByRole('status')).toContainText('remains reserved');
    await host.screenshot({ path: 'runtime-data/e2e/m5-host-recovery.png' });
    console.log('M5 browser: real30s caretaker and180s host reservation decision observed; manual save succeeded.');
    await host.getByRole('button', { name: 'Close saves and recovery', exact: true }).click();
    remote = await remoteContext.newPage(); enemy = capture(remote); await remote.goto(origin);
    await expect.poll(() => enemy.view?.playerId, { timeout: 30000 }).toBe(remoteId);
    await expect.poll(() => state.view!.players.find((player) => player.id === remoteId)?.controlMode, { timeout: 15000 }).toBe('human');

    await host.getByRole('button', { name: 'Pause', exact: true }).click(); await expect.poll(() => state.view!.status).toBe('PAUSED');
    await host.getByRole('button', { name: 'Saves and recovery', exact: true }).click(); await host.getByRole('button', { name: 'Load save Browser recovery checkpoint', exact: true }).click();
    await expect(host.getByRole('alertdialog', { name: 'Confirm save load' })).toBeVisible(); const epoch = state.view!.matchEpoch;
    await host.getByRole('button', { name: 'Confirm load' }).click();
    await expect(host.getByRole('button', { name: 'Create rejoin invite for Aster', exact: true })).toBeVisible({ timeout: 30000 });
    await host.getByRole('button', { name: 'Create rejoin invite for Aster', exact: true }).click(); await host.getByRole('button', { name: 'Rejoin my host slot' }).click();
    await expect.poll(() => state.view?.matchEpoch, { timeout: 30000 }).toBeGreaterThan(epoch); expect(state.view!.playerId).toBe(playerId); expect(state.view!.status).toBe('PAUSED');
    await host.getByRole('button', { name: 'Create rejoin invite for Birch', exact: true }).click();
    const rejoinToken = await host.getByLabel('Rejoin token for Birch', { exact: true }).inputValue();
    await remote.reload(); await remote.getByRole('tab', { name: 'Rejoin saved game', exact: true }).click(); await remote.getByLabel('Rejoin token', { exact: true }).fill(rejoinToken); await remote.getByRole('button', { name: 'Reclaim my command' }).click();
    await expect.poll(() => enemy.view?.matchEpoch, { timeout: 30000 }).toBe(state.view!.matchEpoch); expect(enemy.view!.playerId).toBe(remoteId);
    const recovery = await host.request.get(`${origin}/api/host/recovery`).then((response) => response.json()) as HostRecoveryResponse;
    expect(recovery.restoreSlots.every((slot) => slot.claimed)).toBe(true);
    await host.getByRole('button', { name: 'Resume match' }).click(); await expect.poll(() => state.view!.status).toBe('RUNNING');
    await host.getByRole('button', { name: 'Close saves and recovery', exact: true }).click();
    await host.screenshot({ path: 'runtime-data/e2e/m5-restored-command.png' });
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await expect.poll(() => state.receipts.some((receipt) => receipt.clientCommandId === state.commands.at(-1)?.clientCommandId && receipt.status === 'accepted')).toBe(true);
    await host.getByRole('button', { name: 'End as draw', exact: true }).click(); await host.getByRole('button', { name: 'Confirm draw', exact: true }).click();
    await expect(host.getByTestId('match-results')).toBeVisible();
    expect((await remote.request.get(`${origin}/api/host/replays`)).status()).toBe(403);
    await expect.poll(async () => { const response = await host.request.get(`${origin}/api/host/replays`); return response.ok() ? (await response.json()).recordings.length : 0; }, { timeout: 15000 }).toBeGreaterThan(0);
    const replayFrames: ReplayStepResponse[] = [];
    host.on('response', (response) => { if (response.url().endsWith('/api/host/replay/step') && response.ok()) void response.json().then((value: ReplayStepResponse) => replayFrames.push(value)); });
    await host.getByRole('button', { name: 'Saves and recordings', exact: true }).click(); await host.getByRole('button', { name: 'Open replay viewer', exact: true }).click();
    await host.getByRole('button', { name: /^Open replay / }).first().click();
    await expect.poll(() => replayFrames.length, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(host.getByLabel('Replay viewpoint', { exact: true })).toBeEnabled();
    const firstReplayFrame = replayFrames.at(-1)!;
    await expect(host.getByTestId('replay-canvas')).toBeVisible();
    expect(await host.getByTestId('replay-canvas').evaluate((canvas) => !!(canvas as HTMLCanvasElement).getContext('webgl2'))).toBe(true);
    await host.getByRole('button', { name: 'End', exact: true }).click(); await expect.poll(() => replayFrames.at(-1)?.done && replayFrames.at(-1)?.tick === firstReplayFrame.endTick).toBe(true);
    await expect(host.getByRole('button', { name: 'Beginning', exact: true })).toBeEnabled(); await host.getByRole('button', { name: 'Beginning', exact: true }).click();
    await expect.poll(() => replayFrames.at(-1)?.tick).toBe(firstReplayFrame.startTick);
    await host.getByLabel('Replay viewpoint', { exact: true }).selectOption(remoteId); await expect.poll(() => replayFrames.at(-1)?.view.playerId).toBe(remoteId);
    const replayView = replayFrames.at(-1)!.view; expect(replayView.entities.every((entity) => entity.ownerId === remoteId || !entity.queue && !entity.cargo && !entity.order)).toBe(true);
    await expect(host.getByRole('button', { name: 'Play replay', exact: true })).toBeEnabled(); await host.getByRole('button', { name: 'Play replay', exact: true }).click();
    await expect.poll(() => replayFrames.at(-1)?.tick, { timeout: 15000 }).toBeGreaterThan(firstReplayFrame.startTick);
    const pauseReplay = host.getByRole('button', { name: 'Pause replay', exact: true }); if (await pauseReplay.isVisible()) await pauseReplay.click();
    await host.screenshot({ path: 'runtime-data/e2e/m5-filtered-replay.png' });
    await host.getByRole('button', { name: 'Close replay', exact: true }).click(); await expect(host.getByTestId('match-results')).toBeVisible();
    expect(state.errors).toEqual([]); expect(enemy.errors).toEqual([]); expect(networkErrors).toEqual([]);
    expect(state.protocolErrors.every((code) => code === 'DELTA_GAP')).toBe(true);
    console.log('M5 browser: fresh invitations reclaimed both original identities; completed replay rendered filtered 3D viewpoints and timeline seeks.');
  } catch (error) {
    gameplayFailed = true;
    let hostDiagnostics: unknown = { available: false, code: 'HOST_DIAGNOSTICS_UNAVAILABLE' };
    try {
      const response = await host.request.get(`${origin}/api/host/diagnostics`, { timeout: 3000, maxRetries: 0 });
      if (!response.ok()) hostDiagnostics = { available: false, code: 'HOST_DIAGNOSTICS_HTTP_ERROR', httpStatus: response.status() };
      else {
        const diagnostics = await response.json() as HostDiagnosticsResponse, simulation = diagnostics.simulation;
        const metric = (value: MetricPercentiles | undefined) => value && ({ p50: value.p50, p95: value.p95, p99: value.p99, max: value.max });
        const lane = (value: ComputeWorkerLane | undefined) => value && ({ mode: value.mode, threadIds: value.threadIds, pending: value.pending, recoveries: value.recoveries, degraded: value.degraded });
        // Fixed operational fields only: no endpoint configuration, identities,
        // credentials or world records enter this additional failure attachment.
        hostDiagnostics = { available: true, simulation: simulation && {
          tick: simulation.tick, status: simulation.status, tickMs: metric(simulation.tickMs), debtMs: simulation.debtMs, overrunWarning: simulation.overrunWarning,
          path: simulation.path && { work: simulation.path.work, pending: simulation.path.pending, ready: simulation.path.ready, blocked: simulation.path.blocked, regionCount: simulation.path.regionCount, cacheHits: simulation.path.cacheHits },
          world: simulation.world && { units: simulation.world.units, population: simulation.world.population, resourceNodes: simulation.world.resourceNodes, activeResourceNodes: simulation.world.activeResourceNodes, nonnegativeResources: simulation.world.nonnegativeResources },
          activity: simulation.activity && { movingSinceLastSample: simulation.activity.movingSinceLastSample, gathering: simulation.activity.gathering, returning: simulation.activity.returning, building: simulation.activity.building, repairing: simulation.activity.repairing, blocked: simulation.activity.blocked, attackCooldownActive: simulation.activity.attackCooldownActive, sampledTicks: simulation.activity.sampledTicks },
          memory: simulation.memory && { rss: simulation.memory.rss, heapTotal: simulation.memory.heapTotal, heapUsed: simulation.memory.heapUsed, external: simulation.memory.external, arrayBuffers: simulation.memory.arrayBuffers },
          compute: simulation.compute && { planning: lane(simulation.compute.planning), vision: lane(simulation.compute.vision), boundaryQueued: simulation.compute.boundaryQueued },
        }, publication: lane(diagnostics.compute?.publication), process: { rssMiB: diagnostics.process.rssMiB, eventLoopDelayMs: metric(diagnostics.process.eventLoopDelayMs) } };
      }
    } catch { /* A failed evidence request must not replace the gameplay failure. */ }
    try { await testInfo.attach('authorized-host-failure-diagnostics', { body: JSON.stringify(hostDiagnostics), contentType: 'application/json' }); } catch { /* Preserve the original error. */ }
    try { await testInfo.attach('authorized-recovery-diagnostics', { body: JSON.stringify({ host: state, remote: enemy, networkErrors, routedConnections, nativeReloadConnections }), contentType: 'application/json' }); } catch { /* Preserve the original error. */ }
    throw error;
  } finally {
    const closed = await Promise.allSettled([hostContext.close(), remoteContext.close()]);
    const failure = closed.find(result => result.status === 'rejected');
    if (!gameplayFailed && failure?.status === 'rejected') throw failure.reason;
  }
});


