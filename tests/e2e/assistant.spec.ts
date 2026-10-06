import { expect, test, type Page } from '@playwright/test';
import type { AssistantOptionsResponse, EndpointSettings, HostAiModelEntry, SessionResponse } from '@frontier/shared';

// Focused UI contract fixtures. HTTP/WS are intercepted; no model requests,
// real match, installed host or credential store is touched by these tests.
function session(host: boolean): SessionResponse {
  return { protocolVersion: 2, contentHash: 'a'.repeat(64), csrfToken: 'assistant-ui-fixture', host, playerId: 'human', lobby: {
    status: 'LOBBY', canStart: false,
    settings: { aiCount: 1, mapType: 'open_frontier', populationLimit: 120, sharedVision: true },
    players: [
      { id: 'human', name: 'Human commander', kind: 'human', teamId: 'one', color: '#0072f5', hostPlayer: host, ready: false, connected: true },
      { id: 'bot', name: 'Bot commander', kind: 'ai', teamId: 'two', color: '#f07800', hostPlayer: false, ready: true, connected: true, aiModelId: 'host' },
    ],
  } };
}
const fixtureSettings = (): EndpointSettings => ({ baseUrl: '', model: '', providerProfile: 'generic_openai_compatible', timeoutSeconds: 10, maxConcurrent: 1, inputTokenBudget: 2000, maxOutputTokens: 512, intervalSeconds: { easy: 60, medium: 45, hard: 30 }, maxAdaptiveIntervalSeconds: 120, temperature: 0, sendHumanChat: false, providerOptions: {} });
async function sockets(page: Page) { await page.routeWebSocket(url => url.pathname === '/ws', socket => { socket.onMessage(() => undefined); }); }

test('AI Pilot uses only player choices, saves reserves, pauses, and returns large protected groups in bounded batches', async ({ page }) => {
  const state = session(false), posts: { path: string; body: unknown }[] = [], requests: string[] = [], errors: string[] = [];
  let options: AssistantOptionsResponse = { models: [{ id: 'host', label: 'Host council', available: true }], assistant: {
    preferences: { modelId: null, enabled: false, reserve: { food: 0, wood: 0, gold: 0, stone: 0 } }, status: 'manual',
    protectedEntityIds: Array.from({ length: 205 }, (_, index) => `unit_${index}`),
  } };
  page.on('pageerror', error => errors.push(error.message)); await sockets(page);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname; requests.push(path);
    if (path === '/api/session') return route.fulfill({ json: state });
    if (path === '/api/assistant') {
      if (request.method() === 'POST') { const body = request.postDataJSON(); posts.push({ path, body }); options = { ...options, assistant: { ...options.assistant, preferences: body, status: body.enabled ? 'model' : 'manual' } }; }
      return route.fulfill({ json: options });
    }
    if (path === '/api/assistant/release') { const body = request.postDataJSON() as { entityIds: string[] }; posts.push({ path, body }); options.assistant.protectedEntityIds = options.assistant.protectedEntityIds.filter(id => !body.entityIds.includes(id)); return route.fulfill({ json: options }); }
    return route.fulfill({ status: 404, json: { code: 'FIXTURE_ROUTE_UNAVAILABLE' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'AI Pilot', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'AI Pilot', exact: true }); await expect(panel).toBeVisible();
  state.lobby.status = 'PAUSED'; // Session refresh exposes an active match for release controls.
  await expect(panel.getByLabel('Endpoint base URL')).toHaveCount(0); await expect(panel.locator('input[type=password]')).toHaveCount(0);
  await panel.getByLabel('AI Pilot model', { exact: true }).selectOption('host'); await panel.getByLabel('Enable AI Pilot', { exact: true }).check();
  await panel.getByLabel('food reserve', { exact: true }).fill('150'); await panel.getByLabel('wood reserve', { exact: true }).fill('90');
  await panel.getByRole('button', { name: 'Save AI Pilot settings', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Pause AI Pilot now', exact: true })).toBeVisible();
  expect(posts[0]?.body).toEqual({ modelId: 'host', enabled: true, reserve: { food: 150, wood: 90, gold: 0, stone: 0 } });
  await panel.getByRole('button', { name: 'Return all protected to AI Pilot', exact: true }).click();
  await expect(panel).toContainText('0 protected.');
  const releases = posts.filter(post => post.path.endsWith('/release')).map(post => (post.body as { entityIds: string[] }).entityIds.length); expect(releases).toEqual([200, 5]);
  options.models[0]!.available = false; options.assistant.status = 'unavailable';
  await expect(panel.getByLabel('Enable AI Pilot', { exact: true })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Pause AI Pilot now', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Pause AI Pilot now', exact: true }).click(); await expect(panel.getByLabel('Enable AI Pilot', { exact: true })).not.toBeChecked();
  expect(posts.at(-1)?.body).toEqual({ modelId: 'host', enabled: false, reserve: { food: 150, wood: 90, gold: 0, stone: 0 } });
  expect(requests.some(path => path.startsWith('/api/host/'))).toBe(false);
  state.lobby.status = 'LOBBY'; await expect(page.getByRole('button', { name: 'AI Pilot', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('Host model catalog creates and edits write-only credentials, assigns bots, and deletes unused entries', async ({ page }) => {
  const state = session(true), writes: Record<string, unknown>[] = [], errors: string[] = [];
  let models: HostAiModelEntry[] = [
    { id: 'host', label: 'Host council', enabled: true, settings: { ...fixtureSettings(), baseUrl: 'https://default.fixture.invalid/v1', model: 'fixture-default' }, hasApiKey: false, configured: true, capability: { mode: 'unprobed', status: 'NOT_TESTED' } },
    { id: 'unconfigured', label: 'Unconfigured council', enabled: true, settings: fixtureSettings(), hasApiKey: false, configured: false, capability: { mode: 'unprobed', status: 'NOT_CONFIGURED' } },
  ];
  page.on('pageerror', error => errors.push(error.message)); await sockets(page);
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === '/api/session') return route.fulfill({ json: state });
    if (path === '/api/host/models') {
      if (request.method() === 'GET') return route.fulfill({ json: { models } });
      const body = request.postDataJSON() as Record<string, unknown>; writes.push(body);
      const id = typeof body.id === 'string' ? body.id : 'catalog_fixture';
      const old = models.find(model => model.id === id);
      const entry: HostAiModelEntry = { id, label: body.label as string, enabled: body.enabled as boolean, settings: body.settings as HostAiModelEntry['settings'], hasApiKey: body.apiKey === null ? false : Boolean(body.apiKey) || old?.hasApiKey === true, configured: true, capability: { mode: 'unprobed', status: 'NOT_TESTED' } };
      models = [...models.filter(model => model.id !== id), entry]; return route.fulfill({ json: entry });
    }
    if (path === '/api/host/ai-model') { const body = request.postDataJSON(); state.lobby.players[1]!.aiModelId = body.modelId; return route.fulfill({ json: state.lobby }); }
    if (path === '/api/host/models/catalog_fixture' && request.method() === 'DELETE') { models = models.filter(model => model.id !== 'catalog_fixture'); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 404, json: { code: 'FIXTURE_ROUTE_UNAVAILABLE' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'AI endpoint & diagnostics', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Host AI endpoint', exact: true });
  await expect(panel.getByLabel('Bot commander model', { exact: true }).getByRole('option', { name: 'Unconfigured council (unavailable)', exact: true })).toHaveJSProperty('disabled', true);
  await panel.getByRole('button', { name: 'Add model', exact: true }).click();
  await panel.getByLabel('Model display name', { exact: true }).fill('Remote council');
  await panel.getByLabel('Endpoint base URL', { exact: true }).fill('https://fixture.invalid/v1');
  await panel.getByLabel('Endpoint model', { exact: true }).fill('fixture-model'); await panel.getByLabel('Endpoint API key', { exact: true }).fill('fixture-only-key');
  await panel.getByRole('button', { name: 'Save endpoint settings', exact: true }).click();
  await expect(panel.getByLabel('Host model catalog', { exact: true })).toHaveValue('catalog_fixture'); await expect(panel.getByLabel('Endpoint API key', { exact: true })).toHaveValue('');
  expect(writes[0]?.apiKey).toBe('fixture-only-key'); await expect(panel).not.toContainText('fixture-only-key');
  await panel.getByLabel('Model display name', { exact: true }).fill('Renamed council'); await panel.getByRole('button', { name: 'Save endpoint settings', exact: true }).click();
  await expect(panel.getByLabel('Host model catalog', { exact: true }).locator('option:checked')).toHaveText('Renamed council'); expect(writes[1]).not.toHaveProperty('apiKey');
  await panel.getByLabel('Bot commander model', { exact: true }).selectOption('catalog_fixture'); await expect.poll(() => state.lobby.players[1]!.aiModelId).toBe('catalog_fixture');
  await panel.getByLabel('Bot commander model', { exact: true }).selectOption('host');
  await panel.getByRole('button', { name: 'Delete model', exact: true }).click(); await panel.getByRole('button', { name: 'Confirm model deletion', exact: true }).click();
  await expect(panel.getByLabel('Host model catalog', { exact: true })).toHaveValue('host'); expect(models.map(model => model.id)).toEqual(['host', 'unconfigured']);
  expect(errors).toEqual([]);
});
