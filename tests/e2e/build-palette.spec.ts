import { expect, test, type Locator } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { capture } from './capture';
import { resolveRuleset } from '../../packages/shared/src/content';

test('all build palettes scroll with wheel and keyboard at constrained desktop scales', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  // Own the server and bootstrap so this test also runs with the other browser
  // suites. Exercise the real rendered HUD and server-filtered match view.
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('Missing palette fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  await mkdir('runtime-data', { recursive: true });
  const dataDir = await mkdtemp('runtime-data/e2e-build-palette-'), bootstrap = 'build-palette-fixture-not-a-real-host-token';
  let server: ChildProcess | undefined, output = '';
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } }), page = await context.newPage(), state = capture(page), errors: string[] = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  const whollyReachable = async (control: Locator, region?: Locator) => {
    const { box, clip, hit } = await control.evaluate((element, clipped) => {
      const rect = element.getBoundingClientRect(), region = clipped ? element.closest('.actions-scroll')?.getBoundingClientRect() : undefined;
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, clip: region ? { y: region.y, height: region.height } : undefined, hit: hit === element || element.contains(hit) };
    }, !!region), viewport = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    if (clip) { expect(box.y).toBeGreaterThanOrEqual(clip.y - 1); expect(box.y + box.height).toBeLessThanOrEqual(clip.y + clip.height + 1); }
    expect(hit).toBe(true);
  };
  try {
    server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '', NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: dataDir, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream?.on('data', chunk => { output = (output + chunk.toString()).slice(-6000); });
    const origin = `http://127.0.0.1:${port}`;
    await expect.poll(async () => { if (server?.exitCode !== null) throw new Error(output); return fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false); }, { timeout: 20000 }).toBe(true);
    await page.goto(origin); await page.getByRole('tab', { name: 'Host access', exact: true }).click();
    await page.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await page.getByRole('button', { name: 'Open host controls' }).click();
    await expect(page.locator('.invite-code')).toBeVisible(); await page.getByLabel('AI COMMANDERS').selectOption('1');
    await page.getByLabel('YOUR NAME').fill('Palette host'); await page.getByRole('button', { name: 'Join as host-player' }).click();
    await page.getByLabel('Private map seed', { exact: true }).fill('build-palette-scroll-v1');
    const [seeded] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/host/seed'), page.getByRole('button', { name: 'Set seed', exact: true }).click()]);
    expect(seeded.ok()).toBe(true);
    await page.getByRole('button', { name: /^Ready to begin/ }).click();
    const [started] = await Promise.all([page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/host/start', { timeout: 40000 }), page.getByRole('button', { name: /^Begin match/ }).click()]);
    expect(started.ok()).toBe(true); await expect.poll(() => state.view?.status, { timeout: 40000 }).toBe('RUNNING');
    expect(state.view?.maxAge).toBe(8);
    const content = resolveRuleset(state.view!.rulesetId, state.view!.maxAge);
    const economyIds = new Set(['house', 'mill', 'lumber_camp', 'mining_camp', 'farm', 'barracks', 'market', 'town_center']);
    const category = (building: typeof content.buildings[number]) => building.wallEquivalentCells ? 'fortifications' : economyIds.has(building.id) ? 'economy' : 'military';
    await page.getByRole('button', { name: 'Select villagers', exact: true }).click();
    const evidence: unknown[] = [];
    for (const scenario of [{ width: 1280, height: 720, scale: 80 }, { width: 1280, height: 720, scale: 150 }, { width: 1024, height: 680, scale: 100 }]) {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.getByRole('button', { name: 'Game settings', exact: true }).click();
      const slider = page.getByLabel('Interface scale'); await slider.focus(); await slider.press('Home');
      for (let value = 80; value < scenario.scale; value += 5) await slider.press('ArrowRight');
      await expect(slider).toHaveValue(String(scenario.scale)); await page.getByRole('button', { name: 'Close settings', exact: true }).click();
      for (const [visit, palette] of ['military', 'economy', 'fortifications', 'orders', 'military', 'economy', 'fortifications', 'orders'].entries()) {
        await page.getByRole('tab', { name: palette, exact: true }).click();
        const region = page.getByRole('region', { name: 'Available actions', exact: true });
        const cards = region.getByRole('button', { name: /^Build / });
        const lastAction = region.getByRole('button').last();
        const expected = content.buildings.filter(building => category(building) === palette);
        const labels = await cards.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')));
        expect(labels.sort()).toEqual(expected.map(building => `Build ${building.name}`).sort());
        expect(new Set(labels).size).toBe(labels.length);
        const tick = state.view!.tick; await expect.poll(() => state.view!.tick).toBeGreaterThan(tick);
        expect((await cards.evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).sort()).toEqual(labels);
        await expect(region.getByRole('button', { name: 'Build Monument', exact: true })).toHaveCount(palette === 'military' ? 1 : 0);
        if (palette === 'orders') { await expect(region.getByRole('button', { name: 'Move', exact: true })).toBeVisible(); continue; }
        if (visit >= 4) continue; // Second cycle proves cards do not accumulate on live updates.
        await expect.poll(() => region.evaluate(element => element.scrollTop)).toBe(0);
        const overflow = await region.evaluate(element => element.scrollHeight > element.clientHeight);
        if (palette !== 'economy') expect(overflow).toBe(true);
        await region.hover(); await page.mouse.wheel(0, 3000);
        if (overflow) await expect.poll(() => region.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
        await whollyReachable(lastAction, region);
        await region.focus(); await page.keyboard.press('Home');
        await expect.poll(() => region.evaluate(element => element.scrollTop)).toBe(0);
        await page.keyboard.press('End');
        if (overflow) await expect.poll(() => region.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
        await whollyReachable(lastAction, region);
        for (const card of await cards.all()) { await card.scrollIntoViewIfNeeded(); await whollyReachable(card, region); }
        if (palette === 'fortifications') { await expect(region.getByRole('button', { name: 'Build Eternal Gate', exact: true })).toHaveCount(1); await region.getByRole('button', { name: 'Replace walls with Eternal Gate', exact: true }).scrollIntoViewIfNeeded(); await whollyReachable(region.getByRole('button', { name: 'Replace walls with Eternal Gate', exact: true }), region); }
        await whollyReachable(page.locator('.actions-panel > .receipt'));
        evidence.push({ ...scenario, palette, buildingIds: expected.map(building => building.id), cards: await cards.count(), ...await region.evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight })) });
      }
      await page.getByRole('tab', { name: 'fortifications', exact: true }).click();
      const finalRegion = page.getByRole('region', { name: 'Available actions', exact: true });
      await finalRegion.focus(); await page.keyboard.press('End');
      await expect.poll(() => finalRegion.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: testInfo.outputPath(`palette-${scenario.width}-${scenario.scale}.png`) });
    }
    await page.getByRole('tab', { name: 'economy', exact: true }).click();
    const house = page.getByRole('button', { name: 'Build House', exact: true });
    await house.focus(); await page.keyboard.press('Enter'); await expect(page.locator('.placement-notice')).toContainText('House');
    // Clicking a build action must not suppress gameplay hotkeys for the rest
    // of placement; only the native scrolling keys belong to the action pane.
    const before = state.commands.length; await page.keyboard.press('x');
    await expect.poll(() => state.commands.slice(before).some(command => command.command.kind === 'stop')).toBe(true);
    expect(errors).toEqual([]); expect(state.protocolErrors).toEqual([]);
    const evidencePath = testInfo.outputPath('build-palette-scroll-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await testInfo.attach('build-palette-scroll-evidence', { path: evidencePath, contentType: 'application/json' });
  } finally {
    await context.close();
    if (server && server.exitCode === null) { const closed = new Promise<void>(resolve => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
  }
});
