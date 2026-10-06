import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createGameServer } from '../apps/server/src/server.js';
import type { SimulationSavePayload } from '../packages/simulation/src/persistence-types.js';

const root = resolve('runtime-data/server-m5-audit');
let directory: string | undefined;
let server: Awaited<ReturnType<typeof createGameServer>> | undefined;
afterEach(async () => {
  await server?.app.close(); server = undefined;
  if (directory) {
    const child = relative(root, directory);
    if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP');
    await rm(directory, { recursive: true, force: true }); directory = undefined;
  }
});

it('keeps a restored completed draw terminal, preserves its results, and refuses resumed gameplay', async () => {
  await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'terminal-'));
  server = await createGameServer({ bootstrapToken: 'audit-bootstrap', dataDir: directory });
  await server.app.ready();
  const initial = await server.app.inject({ method: 'POST', url: '/api/bootstrap', headers: { origin: 'http://localhost:3000' }, payload: { token: 'audit-bootstrap' } });
  expect(initial.statusCode).toBe(200);
  const headers = { origin: 'http://localhost:3000', cookie: String(initial.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': initial.json().csrfToken };
  const post = (url: string, payload: Record<string, unknown>) => server!.app.inject({ method: 'POST', url, headers, payload });
  const session = async () => (await server!.app.inject({ url: '/api/session', headers })).json();
  const save = async (name: string): Promise<SimulationSavePayload> => {
    const response = await post('/api/host/save', { name }); expect(response.statusCode, response.body).toBe(200);
    const recovery = (await server!.app.inject({ url: '/api/host/recovery', headers })).json();
    const summary = recovery.saves.find((item: { label: string }) => item.label === name);
    expect(summary).toBeDefined();
    return JSON.parse(await readFile(join(directory!, 'saves', `${summary.id}.json`), 'utf8')).payload.game.payload;
  };

  expect((await post('/api/host/lobby', { aiCount: 2 })).statusCode).toBe(200);
  expect((await post('/api/host/start', {})).statusCode).toBe(200);
  await expect.poll(async () => (await session()).lobby.status, { timeout: 12000 }).toBe('RUNNING');
  expect((await post('/api/host/end-draw', { confirmed: true })).statusCode).toBe(200);
  const before = await save('Completed draw');
  expect(before.state.status).toBe('FINISHED');
  expect(before.state.result?.reason).toBe('administrative_draw');
  expect(Object.values(before.state.economies).every(economy => !economy.defeated)).toBe(true);
  const recovery = (await server.app.inject({ url: '/api/host/recovery', headers })).json();
  const saveId = recovery.saves.find((item: { label: string }) => item.label === 'Completed draw').id;
  const loaded = await post('/api/host/load', { saveId, confirmed: true });
  expect(loaded.statusCode, loaded.body).toBe(200);
  expect(loaded.json().lobby.status).toBe('FINISHED');
  const resumed = await post('/api/host/pause', { paused: false });
  expect(resumed.statusCode).toBe(400); expect(resumed.json().code).toBe('INVALID_PAUSE');
  expect((await session()).lobby.status).toBe('FINISHED');

  const after = await save('Restored completed draw');
  expect(after.state.status).toBe('FINISHED');
  expect(after.state.matchEpoch).toBeGreaterThan(before.state.matchEpoch);
  expect(after.state.tick).toBe(before.state.tick);
  expect(after.state.result).toEqual(before.state.result);
  expect(after.state.economies).toEqual(Object.fromEntries(Object.entries(before.state.economies).map(([id, economy]) => [id, { ...economy, lastClientSequence: 0 }])));
  expect(after.state.entities).toEqual(before.state.entities);
}, 30000);
