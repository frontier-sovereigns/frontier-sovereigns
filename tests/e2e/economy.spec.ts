import { capture } from './capture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BuildingId, PlayerView } from '@frontier/shared';
const content = JSON.parse(readFileSync('data/balance.v1.json', 'utf8')) as { buildings: { id: string; name: string }[] };

// This fixture owns its host process and bootstrap token. It never relies on another
// test's one-time host login or changes the production authentication rules.
let server: ChildProcess | undefined;
let origin = '';
let serverOutput = '';
const bootstrap = 'economy-browser-fixture-not-a-real-host-token';
test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: `runtime-data/e2e-economy-${port}`, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`Economy fixture host exited: ${serverOutput}`);
    return fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>((resolve) => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
});


test('M2 real economy: team tribute, refunds, production, farms, drop-offs, and terrain', async ({ browser }) => {
  test.setTimeout(240000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const allyContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), ally = await allyContext.newPage();
  host.setDefaultTimeout(10000); ally.setDefaultTimeout(10000);
  const state = capture(host), allied = capture(ally);
  try {
    await host.goto(origin); await host.getByRole('tab', { name: 'Host access' }).click();
    await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible(); const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await ally.goto(origin); await ally.getByLabel('YOUR NAME').fill('Birch'); await ally.getByLabel('INVITATION CODE').fill(invite); await ally.getByRole('button', { name: 'Enter the frontier' }).click();
    await host.getByLabel('Map type').selectOption('river_divide');
    await host.getByLabel('Aster team', { exact: true }).selectOption('team_1'); await host.getByLabel('Birch team', { exact: true }).selectOption('team_1');
    await host.getByRole('checkbox', { name: 'Share vision with teammates' }).click(); await expect(host.getByRole('checkbox', { name: 'Share vision with teammates' })).not.toBeChecked();
    await host.screenshot({ path: 'runtime-data/e2e/m2-lobby.png' });
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await ally.getByRole('button', { name: 'Ready to begin' }).click();
    await expect(host.getByRole('button', { name: 'Begin match' })).toBeEnabled(); await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 35000 }).toBe('RUNNING'); await expect.poll(() => allied.view?.status, { timeout: 35000 }).toBe('RUNNING');
    const initial = structuredClone(state.view!), allyInitial = structuredClone(allied.view!);
    expect(initial.map.type).toBe('river_divide'); expect(initial.map.terrain?.some((region) => region.kind === 'bridge')).toBe(true);
    expect(initial.entities.some((entity) => entity.ownerId === allyInitial.playerId)).toBe(false);
    await expect(host.locator('.map-label')).toContainText('RIVER DIVIDE');
    console.log('M2 browser: River Divide loaded; testing allied transfer and production refunds.');

    await host.getByRole('button', { name: 'Economy overview' }).click();
    await host.getByLabel('Tribute amount').fill('10'); await host.getByRole('button', { name: 'Send tribute' }).click();
    await expect.poll(() => allied.view!.self.resources.wood).toBe(allyInitial.self.resources.wood + 10);
    await expect.poll(() => state.view!.self.resources.wood).toBe(initial.self.resources.wood - 11);
    await host.getByRole('checkbox', { name: 'Auto-reseed farms' }).click(); await expect.poll(() => state.view!.self.autoReseed).toBe(true);
    await expect(host.getByRole('table')).toContainText('tribute');
    await host.screenshot({ path: 'runtime-data/e2e/m2-ledger.png' }); await host.getByRole('button', { name: 'Close economy' }).click();
    await ally.getByRole('button', { name: 'Economy overview' }).click(); await ally.screenshot({ path: 'runtime-data/e2e/m2-ally-economy-1280.png' }); await ally.getByRole('button', { name: 'Close economy' }).click();

    const center = state.view!.entities.find((entity) => entity.ownerId === initial.playerId && entity.typeId === 'town_center')!;
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByLabel('Training quantity').selectOption('3');
    await host.getByRole('button', { name: 'Train Villager', exact: true }).click();
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === center.id)?.queue?.length).toBe(3);
    await host.getByRole('button', { name: 'Cancel queued Villager', exact: true }).last().click();
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === center.id)?.queue?.length).toBe(2);
    await expect.poll(() => state.view!.self.resources.food).toBe(initial.self.resources.food - 100);
    await host.getByRole('button', { name: 'Set rally point', exact: true }).click(); await host.mouse.click(690, 510);
    await expect.poll(() => state.commands.some((envelope) => envelope.command.kind === 'set_rally')).toBe(true);

    async function place(type: BuildingId, rotate = false) {
      const before = new Set(state.view!.entities.filter((entity) => entity.ownerId === initial.playerId && entity.typeId === type).map((entity) => entity.id));
      await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
      for (const [x, y] of [[550, 340], [620, 300], [820, 330], [870, 400], [500, 430], [650, 530], [860, 540], [550, 510], [730, 270], [930, 460], [440, 390], [730, 580]]) {
        await host.getByRole('button', { name: `Build ${content.buildings.find((building) => building.id === type)!.name}`, exact: true }).click(); await host.mouse.move(x!, y!); if (rotate) await host.keyboard.press('e');
        if (!(await host.locator('.placement-notice').innerText()).includes('Clear visible site')) { await host.keyboard.press('Escape'); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); continue; }
        await host.mouse.click(x!, y!);
        try { await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === initial.playerId && entity.typeId === type && !before.has(entity.id)), { timeout: 2500 }).toBe(true); return state.view!.entities.find((entity) => entity.ownerId === initial.playerId && entity.typeId === type && !before.has(entity.id))!; }
        catch { const dismiss = host.getByRole('button', { name: 'Dismiss alert' }); if (await dismiss.isVisible()) await dismiss.click(); }
      }
      throw new Error(`No clear visible ${type} site accepted through canvas preview`);
    }
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Build Market', exact: true })).toBeDisabled(); await expect(host.getByRole('button', { name: 'Build Market', exact: true })).toContainText('Settlement');
    const cancelled = await place('mining_camp', true);
    expect(cancelled.rotation).toBe(90);
    await host.getByLabel('Select building', { exact: true }).selectOption(cancelled.id); await host.getByRole('button', { name: 'Cancel foundation', exact: true }).click();
    await expect.poll(() => state.view!.entities.some((entity) => entity.id === cancelled.id)).toBe(false);
    expect(state.view!.self.recentLedger?.some((entry) => entry.reason.includes('refund'))).toBe(true);
    console.log('M2 browser: queue and construction refunds observed; building a farm and lumber camp.');

    const farm = await place('farm');
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === farm.id)?.progress, { timeout: 45000 }).toBe(1);
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === farm.id)?.farmState).toBe('ready');
    expect(state.view!.entities.find((entity) => entity.id === farm.id)?.amount).toBe(350);
    console.log('M2 browser: farm completed with 350 food; placing specialized drop-off.');
    const lumber = await place('lumber_camp');
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === lumber.id)?.progress, { timeout: 45000 }).toBe(1);
    console.log('M2 browser: lumber camp complete; checking carried wood and farm assignment.');
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === initial.playerId && entity.cargo?.resource === 'wood' && entity.cargo.amount > 0), { timeout: 25000 }).toBe(true);
    await host.getByLabel('Select building', { exact: true }).selectOption(farm.id); await host.getByRole('button', { name: 'Assign farmer', exact: true }).click();
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === farm.id)?.farmerAssigned, { timeout: 30000 }).toBe(true);
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === farm.id)?.amount, { timeout: 25000 }).toBeLessThan(350);
    await host.screenshot({ path: 'runtime-data/e2e/m2-farm.png' });
    await expect.poll(() => state.view!.self.recentLedger?.some((entry) => entry.reason === 'deposit' && entry.resource === 'wood'), { timeout: 45000 }).toBe(true);
    await expect.poll(() => state.view!.entities.filter((entity) => entity.ownerId === initial.playerId && entity.typeId === 'villager').length, { timeout: 40000 }).toBe(8);
    await host.getByRole('button', { name: 'Economy overview' }).click(); await expect(host.getByRole('table')).toContainText('deposit'); await host.screenshot({ path: 'runtime-data/e2e/m2-economy.png' }); await host.getByRole('button', { name: 'Close economy' }).click();

    // A producer is selected through the player's own building list; demolition is confirmed in UI.
    await host.getByLabel('Select building', { exact: true }).selectOption(lumber.id); await host.getByRole('button', { name: 'Demolish', exact: true }).click(); await host.getByRole('button', { name: 'Confirm demolition' }).click();
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === lumber.id)?.demolitionTicksRemaining).toBeGreaterThan(0);
    await expect.poll(() => state.view!.entities.some((entity) => entity.id === lumber.id), { timeout: 10000 }).toBe(false);
    // Public landforms may guide movement; the scout still has to reveal the crossing.
    const bridge = state.view!.map.terrain!.find((region) => region.kind === 'bridge')!;
    const destination = { xMm: bridge.xMm + bridge.widthMm + 4000, zMm: bridge.zMm + bridge.depthMm / 2 };
    await host.getByRole('button', { name: 'Select army', exact: true }).click();
    const minimap = (await host.getByTestId('minimap').boundingBox())!;
    const pixel = { x: minimap.x + destination.xMm / state.view!.map.widthMm * minimap.width, y: minimap.y + destination.zMm / state.view!.map.heightMm * minimap.height };
    await host.mouse.click(pixel.x, pixel.y, { button: 'right' });
    await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === initial.playerId && entity.typeId === 'scout' && Math.hypot(entity.xMm - destination.xMm, entity.zMm - destination.zMm) < 2500), { timeout: 45000 }).toBe(true);
    await host.mouse.click(minimap.x + (bridge.xMm + bridge.widthMm / 2) / state.view!.map.widthMm * minimap.width, pixel.y); await host.screenshot({ path: 'runtime-data/e2e/m2-river-crossing.png' });
    for (const entity of state.view!.entities.filter((entity) => entity.ownerId !== initial.playerId)) { expect(entity.cargo).toBeUndefined(); expect(entity.queue).toBeUndefined(); expect(entity.taskState).toBeUndefined(); expect(entity.rally).toBeUndefined(); }
    expect(state.errors).toEqual([]); expect(allied.errors).toEqual([]);
    console.log('M2 browser: actual farming, cargo, deposits, trained units, demolition, and private packet checks passed.');
  } finally { await hostContext.close(); await allyContext.close(); }
});


