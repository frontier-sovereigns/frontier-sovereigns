import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { SessionResponse } from '@frontier/shared';

// Own the one-use login and temporary server so the shared 3010 fixture and the
// installed host remain untouched. No match or model endpoint is started.
const bootstrap = 'host-access-browser-fixture-not-a-real-host-token';
const dataRoot = resolve('runtime-data');
let server: ChildProcess | undefined, origin = '', lanOrigin = '', dataDir = '', serverOutput = '';

test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No host-access fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`; lanOrigin = `http://192.0.2.10:${port}`;
  await mkdir(dataRoot, { recursive: true }); dataDir = await mkdtemp(join(dataRoot, 'e2e-host-access-'));
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: {
    ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false',
    GAME_DATA_DIR: dataDir, GAME_PUBLIC_ORIGIN: '', GAME_ALLOWED_ORIGINS: lanOrigin, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap,
    AI_BASE_URL: '', AI_MODEL: '', AI_API_KEY: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`Host-access fixture exited: ${serverOutput.replaceAll(bootstrap, '[fixture token]')}`);
    return fetch(`${origin}/api/health`).then(response => response.ok).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
});

test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>(resolve => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
  if (dataDir) {
    const target = resolve(dataDir);
    if (dirname(target) !== dataRoot || !basename(target).startsWith('e2e-host-access-')) throw new Error('Unexpected fixture cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});

async function browserAddress(page: Page, address: string) {
  // Route the real production HTML, assets and HTTP APIs through the owned host.
  // This checks browser URL behavior, not connectivity from remote LAN hardware.
  await page.route(`${address}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({ url: `${origin}${url.pathname}${url.search}`, headers: await request.allHeaders() });
    await route.fulfill({ response });
  });
  // Lobby authentication assertions use real HTTP; gameplay socket transport is
  // outside this URL-visibility check and must never contact the synthetic IP.
  await page.routeWebSocket(url => url.pathname === '/ws', socket => { socket.onMessage(() => undefined); });
  await page.goto(address);
  await expect(page.getByText('CONNECTED TO SERVER', { exact: true })).toBeVisible();
}

for (const hostname of ['127.0.0.1', 'localhost', '[::1]', '192.0.2.10', 'host.localhost']) {
  test(`Host access follows the exact page hostname: ${hostname}`, async ({ page }) => {
    const address = new URL(origin); address.hostname = hostname;
    await browserAddress(page, address.origin);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
    await expect(page.getByRole('tab', { name: 'Host access', exact: true })).toHaveCount(local ? 1 : 0);
    if (local) {
      await page.getByRole('tab', { name: 'Host access', exact: true }).click();
      await expect(page.getByLabel('HOST ACCESS TOKEN', { exact: true })).toBeVisible();
      await expect(page.locator('.connect-form')).toContainText('printed below Host browser in the server console');
      await expect(page.locator('.connect-form')).toContainText('works once and expires after 10 minutes');
      await expect(page.locator('.connect-form')).toContainText('private backup');
    } else {
      await expect(page.getByLabel('HOST ACCESS TOKEN', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open host controls' })).toHaveCount(0);
      await page.getByRole('tab', { name: 'Rejoin saved game' }).click();
      await expect(page.getByLabel('Rejoin token', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Join a game', exact: true }).click();
      await expect(page.getByLabel('YOUR NAME', { exact: true })).toBeVisible();
      await expect(page.getByLabel('HOST ACCESS TOKEN', { exact: true })).toHaveCount(0);
    }
  });
}

test('local wrong-token guidance, valid host login, and joining through a synthetic LAN address', async ({ page, browser }) => {
  await page.goto(origin); await page.getByRole('tab', { name: 'Host access', exact: true }).click();
  await page.getByLabel('HOST ACCESS TOKEN', { exact: true }).fill('wrong-fixture-token');
  const rejected = page.waitForResponse(response => response.url() === `${origin}/api/bootstrap`);
  await page.getByRole('button', { name: 'Open host controls' }).click();
  expect(await (await rejected).json()).toEqual({ code: 'BOOTSTRAP_REJECTED' });
  await expect(page.getByRole('alert')).toContainText('The host access token was not accepted. Copy the one-time token printed below Host browser');
  await page.getByLabel('HOST ACCESS TOKEN', { exact: true }).fill(` ${bootstrap} `);
  await page.getByRole('button', { name: 'Open host controls' }).click();
  await expect(page.locator('.invite-code')).toBeVisible();
  const invite = await page.locator('.invite-code').innerText();

  const remoteContext = await browser.newContext(), remote = await remoteContext.newPage();
  try {
    await browserAddress(remote, lanOrigin);
    await expect(remote.getByRole('tab', { name: 'Host access', exact: true })).toHaveCount(0);
    await expect(remote.getByLabel('HOST ACCESS TOKEN', { exact: true })).toHaveCount(0);
    await remote.getByLabel('YOUR NAME', { exact: true }).fill('LAN commander');
    await remote.getByLabel('INVITATION CODE', { exact: true }).fill(invite);
    await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await expect(remote.getByRole('button', { name: 'Ready to begin' })).toBeVisible();
    const remoteSession = await remote.evaluate(async () => (await fetch('/api/session')).json()) as SessionResponse;
    expect(remoteSession.host).toBe(false); expect(remoteSession.playerId).toBeTruthy();
    expect(remoteSession.lobby.inviteCode).toBeUndefined();
    await expect(remote.locator('.host-controls')).toHaveCount(0);
  } finally { await remoteContext.close(); }
});

test('bootstrap expiry, prior use, and local-only failures explain recovery', async ({ page }) => {
  // Deterministic response fixtures verify wording without waiting ten minutes
  // or pretending that routed requests came from a second physical computer.
  let code = '';
  await page.route('**/api/bootstrap', route => route.fulfill({ status: 403, json: { code } }));
  await page.goto(origin); await page.getByRole('tab', { name: 'Host access', exact: true }).click();
  for (const [failure, message] of [
    ['BOOTSTRAP_EXPIRED', 'This host access token has expired. Restart the game server'],
    ['BOOTSTRAP_USED', 'This host access token has already been used. Return to the browser session'],
    ['BOOTSTRAP_LOCAL_ONLY', "Host access is available only at the host computer's local browser address"],
  ]) {
    code = failure!;
    await page.getByLabel('HOST ACCESS TOKEN', { exact: true }).fill('fixture-token');
    await page.getByRole('button', { name: 'Open host controls' }).click();
    await expect(page.getByRole('alert')).toContainText(message!);
    await expect(page.getByLabel('HOST ACCESS TOKEN', { exact: true })).toHaveValue('');
  }
});
