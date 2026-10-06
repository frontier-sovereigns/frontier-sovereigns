import { capture } from './capture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { BalanceData, BuildingId, PlayerView } from '@frontier/shared';
const content = JSON.parse(readFileSync('data/balance.v1.json', 'utf8')) as BalanceData;
const laterContent=JSON.parse(readFileSync('data/balance.legendary-ages.v1.json','utf8')) as Pick<BalanceData,'technologies'>;

// This fixture owns its host process and bootstrap token. It never relies on another
// test's one-time host login or changes the production authentication rules.
let server: ChildProcess | undefined;
let origin = '';
let serverOutput = '';
const bootstrap = 'progression-browser-fixture-not-a-real-host-token';
test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: `runtime-data/e2e-progression-${port}`, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`Progression fixture host exited: ${serverOutput}`);
    return fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>((resolve) => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
});


test('M4 real normal-resource Settlement age, shared queue, Forestry research, and private upgrades', async ({ browser }, testInfo) => {
  test.setTimeout(600000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), remote = await remoteContext.newPage(); host.setDefaultTimeout(10000); remote.setDefaultTimeout(10000);
  const state = capture(host), enemy = capture(remote);
  try {
    await host.goto(origin); await host.getByRole('tab', { name: 'Host access' }).click(); await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible(); const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('AI COMMANDERS').selectOption('0'); await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto(origin); await remote.getByLabel('YOUR NAME').fill('Birch'); await remote.getByLabel('INVITATION CODE').fill(invite); await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click(); await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 35000 }).toBe('RUNNING'); await expect.poll(() => enemy.view?.status, { timeout: 35000 }).toBe('RUNNING');
    const playerId = state.view!.playerId, initialIds = state.view!.entities.filter((entity) => entity.ownerId === playerId).map((entity) => entity.id), center = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'town_center')!;
    const settlement = content.ages.find((age) => age.id === 2)!, forestry = content.technologies.find((technology) => technology.id === 'forestry_1')!;
    const own = (id: string) => state.view!.entities.find((entity) => entity.id === id);
    await host.getByRole('button', { name: 'Technology tree', exact: true }).click();
    await expect(host.locator('.technology-card')).toHaveCount(content.technologies.length+laterContent.technologies.length);
    await expect(host.getByTestId('technology-forestry_1')).toContainText('Settlement Age required');
    await expect(host.getByTestId('technology-elite_militia')).toContainText('Veteran Militia');
    await host.screenshot({ path: 'runtime-data/e2e/m4-technology-tree.png' }); await host.getByRole('button', { name: 'Close technology tree' }).click();
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('tab', { name: 'Research & ages', exact: true }).click();
    await expect(host.getByRole('button', { name: `Advance to ${settlement.name}`, exact: true })).toBeDisabled();

    async function place(type: BuildingId) {
      const before = new Set(state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === type).map((entity) => entity.id));
      await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
      for (const [x, y] of [[550, 340], [620, 300], [820, 330], [870, 400], [500, 430], [650, 530], [860, 540], [550, 510], [730, 270], [930, 460], [440, 390], [730, 580]]) {
        await host.getByRole('button', { name: `Build ${content.buildings.find((building) => building.id === type)!.name}`, exact: true }).click(); await host.mouse.move(x!, y!);
        if (!(await host.locator('.placement-notice').innerText()).includes('Clear visible site')) { await host.keyboard.press('Escape'); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); continue; }
        await host.mouse.click(x!, y!);
        try { await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === playerId && entity.typeId === type && !before.has(entity.id)), { timeout: 2500 }).toBe(true); return state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === type && !before.has(entity.id))!; }
        catch { const dismiss = host.getByRole('button', { name: 'Dismiss alert' }); if (await dismiss.isVisible()) await dismiss.click(); }
      }
      throw new Error(`No clear visible ${type} site accepted through canvas preview`);
    }
    const mill = await place('mill'); await expect.poll(() => own(mill.id)?.progress, { timeout: 45000 }).toBe(1);
    const lumber = await place('lumber_camp'); await expect.poll(() => own(lumber.id)?.progress, { timeout: 45000 }).toBe(1);
    console.log('M4 browser: two distinct normal-cost prerequisite buildings completed.');
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    // The UI may only gather a node the player has actually discovered.
    if (await host.getByRole('button', { name: 'Gather gold', exact: true }).isDisabled()) {
      const map = state.view!.map, box = (await host.getByTestId('minimap').boundingBox())!;
      for (const [dx, dz] of [[16000, 0], [0, 16000], [-16000, 0], [0, -16000]]) {
        await host.getByRole('button', { name: 'Select army', exact: true }).click(); const point = { xMm: center.xMm + dx!, zMm: center.zMm + dz! };
        await host.mouse.click(box.x + point.xMm / map.widthMm * box.width, box.y + point.zMm / map.heightMm * box.height, { button: 'right' });
        try { await expect.poll(() => state.view!.entities.some((entity) => entity.resource === 'gold' && !entity.ghost), { timeout: 18000 }).toBe(true); break; } catch { /* Try another legal scouting direction. */ }
      }
      await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    }
    await host.getByRole('button', { name: 'Gather gold', exact: true }).click();
    await expect.poll(() => state.view!.self.resources.gold, { timeout: 75000 }).toBeGreaterThanOrEqual(settlement.cost.gold);
    await host.getByRole('button', { name: 'Gather food', exact: true }).click();
    await expect.poll(() => state.view!.self.resources.food, { timeout: 240000 }).toBeGreaterThanOrEqual(settlement.cost.food + 100);
    console.log('M4 browser: age resources actually deposited; starting the 90-second shared queue.');
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('tab', { name: 'Research & ages', exact: true }).click();
    await host.getByRole('button', { name: `Advance to ${settlement.name}`, exact: true }).click();
    await expect.poll(() => own(center.id)?.queue?.[0]?.kind).toBe('age');
    const ageJob = own(center.id)!.queue![0]!;
    expect(ageJob.typeId).toBe('age_2');
    await host.getByRole('tab', { name: 'Train', exact: true }).click(); await host.getByLabel('Training quantity').selectOption('2'); await host.getByRole('button', { name: 'Train Villager', exact: true }).click();
    await expect.poll(() => own(center.id)?.queue?.length).toBe(3);
    expect(own(center.id)!.queue!.slice(1).every((job) => job.kind === 'train' && job.state === 'waiting' && job.progress === 0)).toBe(true);
    await expect(host.getByRole('button', { name: 'Cancel queued Villager', exact: true }).last()).toHaveAttribute('title', 'Estimated refund: 50 food');
    const cancelledId = own(center.id)!.queue![2]!.id;
    await host.getByRole('button', { name: 'Cancel queued Villager', exact: true }).last().click();
    await expect.poll(() => own(center.id)?.queue?.length).toBe(2);
    expect(own(center.id)!.queue!.some((job) => job.id === cancelledId)).toBe(false);
    const paidTrainingId = own(center.id)!.queue![1]!.id;
    await expect.poll(() => own(center.id)?.queue?.[0]?.progress, { timeout: 30000 }).toBeGreaterThan(0.1);
    await host.screenshot({ path: 'runtime-data/e2e/m4-shared-queue.png' });
    await expect.poll(() => state.view!.self.age, { timeout: 110000 }).toBe(2);
    await expect(host.locator('.selection-heading h2')).toHaveText('Town Center');
    await expect(host.getByLabel('Select building', { exact: true })).toHaveValue(center.id);
    expect(own(center.id)!.queue!.some((job) => job.id === paidTrainingId)).toBe(true);
    expect(initialIds.every((id) => own(id)?.visualAge === 2)).toBe(true);
    await expect(host.locator('.own-age-announcement')).toContainText('Your Settlement Age begins.');
    await expect(remote.locator('.age-announcements')).toContainText('Aster reached Settlement Age.');
    await expect.poll(() => enemy.view!.players.find((player) => player.id === playerId)?.age).toBe(2);
    expect(enemy.view!.self.technologies).toEqual([]);
    await host.screenshot({ path: 'runtime-data/e2e/m4-settlement-upgrade.png' });
    await remote.screenshot({ path: 'runtime-data/e2e/m4-public-age-1280.png' });
    console.log('M4 browser: age completion announced to both players; selected producer and paid training survived.');
    await host.getByLabel('Select building', { exact: true }).selectOption(lumber.id);
    await expect(host.getByRole('button', { name: `Research ${forestry.name}`, exact: true })).toBeEnabled();
    await host.getByRole('button', { name: `Research ${forestry.name}`, exact: true }).click();
    await expect.poll(() => own(lumber.id)?.queue?.[0]?.typeId).toBe('forestry_1');
    await expect(host.getByRole('button', { name: `Research ${forestry.name}`, exact: true })).toBeDisabled();
    await expect.poll(() => state.view!.self.technologies?.includes('forestry_1'), { timeout: 55000 }).toBe(true);
    await expect(host.locator('.selection-heading h2')).toHaveText('Lumber Camp');
    await expect.poll(() => state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === 'villager').length, { timeout: 15000 }).toBe(7);
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    await expect(host.getByLabel('Selected unit statistics')).toContainText('wood 0.7475');
    await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await host.screenshot({ path: 'runtime-data/e2e/m4-effective-worker.png' });
    await host.getByRole('button', { name: 'Technology tree', exact: true }).click();
    await expect(host.getByTestId('technology-forestry_1')).toContainText('Completed');
    await expect(host.getByTestId('technology-forestry_2')).toContainText('Fortress Age required');
    await host.screenshot({ path: 'runtime-data/e2e/m4-research-complete.png' });
    for (const entity of enemy.view!.entities.filter((entity) => entity.ownerId !== enemy.view!.playerId)) { expect(entity.queue).toBeUndefined(); expect(entity.cargo).toBeUndefined(); }
    expect(enemy.view!.self.technologies).toEqual([]); expect(state.errors).toEqual([]); expect(enemy.errors).toEqual([]);
    console.log('M4 browser: normal-cost ForestryI completed, effective gathering and private technology packets checked.');
  } catch (error) { await testInfo.attach('authorized-progression-diagnostics', { body: JSON.stringify({ host: state, remote: enemy }), contentType: 'application/json' }); throw error; }
  finally { await hostContext.close(); await remoteContext.close(); }
});

