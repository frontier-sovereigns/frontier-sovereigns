import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AiModelCatalog } from './ai-model-catalog.js';
import { AiModelScheduler } from './ai-model-scheduler.js';
import { defaultEndpointSettings, EndpointClient, EndpointConfiguration } from './ai-endpoint.js';
import type { AiDriver, SchedulingState } from './ai-scheduler.js';
import type { AiDispatch, AiRequestBinding } from '../../../packages/simulation/src/ai-observation.js';

const root = resolve('runtime-data/model-scheduler-tests'), directories: string[] = [], schedulers: AiModelScheduler[] = [];
const flush = () => new Promise<void>(done => setImmediate(done));
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.close(); await flush();
  for (const directory of directories.splice(0)) { const child = relative(root, directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(directory, { recursive: true, force: true }); }
});
const profileSettings = (baseUrl: string, maxConcurrent = 5) => ({ ...defaultEndpointSettings(), baseUrl, model: 'test-model', maxConcurrent, timeoutSeconds: 45, intervalSeconds: { easy: 10, medium: 10, hard: 10 } });
async function fixture(specs: { modelId: string; baseUrl: string; cap?: number }[], assignments: string[], globalConcurrency = 11) {
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'owned-')); directories.push(directory);
  const config = new EndpointConfiguration(directory); await config.load({});
  const catalog = new AiModelCatalog(directory, config); await catalog.load();
  for (const spec of specs) await catalog.upsert({ id: spec.modelId, label: spec.modelId, enabled: true, settings: profileSettings(spec.baseUrl, spec.cap), apiKey: `${spec.modelId}-private-test-key` });
  let now = 1000, serial = 0;
  const state: SchedulingState = { matchId: 'models', matchEpoch: 1, tick: 0, status: 'RUNNING', commanders: assignments.map((modelId, index) => ({ playerId: `player_${index}`, modelId, difficulty: 'hard', generation: 1, alive: true, nextStrategicTick: 0, mode: 'fallback' })) };
  const calls: { playerId: string; observationId: string; url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [], accepted: AiRequestBinding[] = [], invalidations: { reason: string; ids?: string[] }[] = [];
  const driver: AiDriver = {
    async aiSchedulingState() { return structuredClone(state); },
    async prepareAiRequest(playerId, requestId) {
      const commander = state.commanders.find(item => item.playerId === playerId)!, binding = { matchId: state.matchId, matchEpoch: state.matchEpoch, playerId, requestId, observationId: `obs_${++serial}`, observedTick: state.tick, controllerGeneration: commander.generation }, bank = { food: 100, wood: 100, gold: 100, stone: 100 };
      return { binding, references: {}, observation: { schemaVersion: 1, identity: binding, player: { id: playerId, teamId: playerId, name: playerId, difficulty: 'hard', personality: 'builder' }, objective: { kind: 'conquest', opposingTeams: 1 }, economy: { age: 1, bank, incomePerMinute: bank, population: { used: 7, reserved: 0, cap: 10, limit: 120 }, workerTargetLimit: 60, workers: {} }, army: {}, buildings: [], production: [], legalTechnologies: [], references: [], resources: [], enemies: { visibleComposition: {}, lastKnownThreats: [] }, emergencies: [], goals: [], previousReceipts: [], memory: { facts: [], summary: '' }, requests: [] } } as AiDispatch;
    },
    async completeAiRequest(binding, result) { if (result.kind === 'failure') return { accepted: false, code: result.code }; accepted.push(binding); return { accepted: true, code: 'PLAN_ACCEPTED' }; },
    async invalidateAiRequests(reason, ids) { invalidations.push({ reason, ...(ids ? { ids } : {}) }); for (const commander of state.commanders) if (!ids || ids.includes(commander.playerId)) commander.generation++; },
  };
  const fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body)), observation = JSON.parse(body.messages[1].content), signal = init?.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      calls.push({ playerId: observation.identity.playerId, observationId: observation.identity.observationId, url: String(url), signal, resolve: response => { signal.removeEventListener('abort', abort); resolve(response); } });
      if (signal.aborted) abort();
    });
  }) as typeof fetch;
  const scheduler = new AiModelScheduler(catalog, () => now, snapshot => new EndpointClient(snapshot.settings, snapshot.apiKey, fetcher), globalConcurrency); schedulers.push(scheduler);
  await scheduler.setDriver(driver);
  const ok = (index: number) => calls[index]!.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ schemaVersion: 1, observationId: calls[index]!.observationId, strategy: 'Test', goals: [], message: null }) } }] })));
  return { catalog, config, driver, scheduler, state, calls, accepted, invalidations, ok, advance(ms: number) { now += ms; state.tick += Math.floor(ms / 50); }, async poll() { await scheduler.poll(); await flush(); } };
}

it('runs all eleven controllers across host and personal selections with isolated endpoint calls', async () => {
  const specs = [{ modelId: 'host', baseUrl: 'http://host-model.invalid/v1', cap: 5 }, ...Array.from({ length: 6 }, (_, index) => ({ modelId: `personal_${index}`, baseUrl: `http://personal-${index}.invalid/v1`, cap: 1 }))];
  const h = await fixture(specs, ['host', 'host', 'host', 'host', 'host', ...specs.slice(1).map(item => item.modelId)]);
  await h.poll(); h.advance(10000); await h.poll();
  expect(h.calls).toHaveLength(11); expect(new Set(h.calls.map(item => item.playerId)).size).toBe(11); expect(h.scheduler.diagnostics().active).toBe(11);
  expect(h.calls.filter(item => item.url.includes('host-model.invalid'))).toHaveLength(5);
  for (let index = 0; index < 11; index++) h.ok(index); await flush();
  expect(h.accepted).toHaveLength(11); expect(h.scheduler.diagnostics()).toMatchObject({ active: 0, completed: 11, failed: 0 });
  expect(h.scheduler.diagnostics().commanders).toHaveLength(11);
  for(const commander of h.scheduler.diagnostics().commanders)expect(commander.requests).toMatchObject({completed:1,failed:0,queueSamples:1,stages:{preparation:{samples:1},endpoint:{samples:1},application:{samples:1}}});
  expect(JSON.stringify(h.scheduler.diagnostics())).not.toContain('private-test-key');
});

it('shares capacity for duplicate origin profiles and fairly admits the oldest waiting faction', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://localhost:9001/v1', cap: 1 }, { modelId: 'other', baseUrl: 'http://127.0.0.1:9001/different-prefix/v1', cap: 5 }], ['host', 'other']);
  await h.poll(); expect(h.calls).toHaveLength(1); await expect(h.scheduler.probe(false, 'other')).rejects.toThrow('ENDPOINT_BUSY');
  h.ok(0); await flush(); h.advance(10000); await h.poll();
  expect(h.calls).toHaveLength(2); expect(h.calls[1]!.playerId).toBe('player_1'); expect(h.scheduler.diagnostics().active).toBe(1);
  h.ok(1); await flush(); await h.poll(); expect(h.calls[2]!.playerId).toBe('player_0');
});

it('does not let a saturated origin prevent another independent endpoint from progressing', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://same.invalid/v1', cap: 1 }, { modelId: 'same', baseUrl: 'http://same.invalid/another/v1', cap: 1 }, { modelId: 'independent', baseUrl: 'http://other.invalid/v1', cap: 1 }], ['host', 'same', 'independent']);
  await h.poll(); expect(h.calls.map(item => item.playerId)).toEqual(['player_0', 'player_2']); expect(h.scheduler.diagnostics().pending).toBe(1);
  h.ok(1); await flush(); expect(h.accepted[0]!.playerId).toBe('player_2');
});

it('keeps a failed endpoint circuit isolated from another model service', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://broken.invalid/v1', cap: 1 }, { modelId: 'good', baseUrl: 'http://good.invalid/v1', cap: 1 }], ['host', 'good']);
  for (let round = 0; round < 3; round++) {
    await h.poll();
    const players = h.calls.map(item => item.playerId), bad = players.lastIndexOf('player_0'), good = players.lastIndexOf('player_1');
    h.calls[bad]!.resolve(new Response('{}', { status: 503 })); h.ok(good); await flush();
    if (round < 2) h.advance(120000);
  }
  expect(h.scheduler.diagnostics().circuit).toBe('open');
  const count = h.calls.length; h.advance(10000); await h.poll();
  expect(h.calls.slice(count).map(item => item.playerId)).toEqual(['player_1']);
});

it('invalidates only a changed player and keeps canceled inference capacity until its deadline', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://old.invalid/v1', cap: 1 }, { modelId: 'next', baseUrl: 'http://new.invalid/v1', cap: 2 }], ['host', 'next']);
  await h.poll(); h.state.commanders[0]!.modelId = 'next'; h.state.commanders[0]!.generation++; h.scheduler.playerChanged('player_0'); await flush();
  expect(h.calls[0]!.signal.aborted).toBe(true); expect(h.calls[1]!.signal.aborted).toBe(false);
  await h.poll(); expect(h.calls).toHaveLength(2); expect(h.scheduler.diagnostics().active).toBe(2);
  h.advance(45000); await h.poll(); expect(h.calls).toHaveLength(3); expect(h.calls[2]!.url).toContain('new.invalid'); expect(h.accepted).toHaveLength(0);
});

it('retains shared canceled leases across profile removal and invalidates only that profile', async () => {
  const h = await fixture([{ modelId: 'a', baseUrl: 'http://same.invalid/v1', cap: 1 }, { modelId: 'b', baseUrl: 'http://same.invalid/v1', cap: 1 }], ['a', 'b']);
  await h.poll(); await h.catalog.remove('a'); await h.scheduler.configurationChanged('a'); await flush();
  expect(h.invalidations.some(item => item.reason === 'CONFIG_CHANGED' && item.ids?.join(',') === 'player_0')).toBe(true);
  await h.poll(); expect(h.calls).toHaveLength(1); expect(h.scheduler.diagnostics().active).toBe(1);
  h.advance(45000); await h.poll(); expect(h.calls[1]!.playerId).toBe('player_1');
});

it('reconfigures one endpoint without aborting or invalidating another endpoint request', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://before.invalid/v1', cap: 1 }, { modelId: 'other', baseUrl: 'http://other.invalid/v1', cap: 1 }], ['host', 'other']);
  await h.poll();
  await h.catalog.upsert({ id: 'host', label: 'Changed', enabled: true, settings: profileSettings('http://after.invalid/v1', 1) });
  await h.scheduler.configurationChanged('host'); await flush();
  expect(h.calls[0]!.signal.aborted).toBe(true); expect(h.calls[1]!.signal.aborted).toBe(false);
  expect(h.invalidations).toEqual([{ reason: 'CONFIG_CHANGED', ids: ['player_0'] }]);
  h.ok(1); await flush(); expect(h.accepted.map(item => item.playerId)).toEqual(['player_1']);
  h.advance(45000); await h.poll(); expect(h.calls.some(item => item.playerId === 'player_0' && item.url.includes('after.invalid'))).toBe(true);
});

it('does not send a newly reassigned controller observation to the previous model during preparation', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://before.invalid/v1' }, { modelId: 'other', baseUrl: 'http://other.invalid/v1' }], ['host']);
  const prepare = h.driver.prepareAiRequest;
  h.driver.prepareAiRequest = async (...args) => {
    h.state.commanders[0]!.modelId = 'other'; h.state.commanders[0]!.generation++;
    h.driver.prepareAiRequest = prepare; return prepare(...args);
  };
  await h.poll(); expect(h.calls).toHaveLength(0); expect(h.accepted).toHaveLength(0);
  h.scheduler.playerChanged('player_0'); await h.poll(); expect(h.calls).toHaveLength(1); expect(h.calls[0]!.url).toContain('other.invalid');
});

it('enforces the global cap fairly even for independent endpoints', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://host.invalid/v1' }, { modelId: 'other', baseUrl: 'http://other.invalid/v1' }], ['host', 'other'], 1);
  await h.poll(); expect(h.calls).toHaveLength(1); h.ok(0); await flush(); h.advance(10000); await h.poll();
  expect(h.calls[1]!.playerId).toBe('player_1'); expect(h.scheduler.diagnostics().active).toBe(1);
});

it('removes a disabled controller pending request instead of dispatching it later', async () => {
  const h = await fixture([{ modelId: 'host', baseUrl: 'http://same.invalid/v1', cap: 1 }], ['host', 'host']);
  await h.poll(); h.advance(10000); await h.poll(); h.state.commanders.splice(1, 1); h.ok(0); await flush(); await h.poll();
  expect(h.calls.every(item => item.playerId === 'player_0')).toBe(true); expect(h.scheduler.diagnostics().commanders).toHaveLength(1);
});
