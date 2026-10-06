import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { AiModelCatalog } from './ai-model-catalog.js';
import { defaultEndpointSettings, EndpointConfiguration } from './ai-endpoint.js';

const root = resolve('runtime-data/model-catalog-tests'), directories: string[] = [];
const settings = (model = 'mock-model') => ({ ...defaultEndpointSettings(), baseUrl: 'http://model.invalid/v1', model });
async function fixture() {
  await mkdir(root, { recursive: true }); const directory = await mkdtemp(join(root, 'owned-')); directories.push(directory);
  const legacy = new EndpointConfiguration(directory); await legacy.load({}); await legacy.update(settings('legacy'), 'legacy-private-test-key');
  const catalog = new AiModelCatalog(directory, legacy); await catalog.load(); return { directory, legacy, catalog };
}
afterEach(async () => { for (const directory of directories.splice(0)) { const child = relative(root, directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(directory, { recursive: true, force: true }); } });

it('keeps the legacy endpoint, persists independent keys, and publishes only safe player choices', async () => {
  const { directory, legacy, catalog } = await fixture(), before = await readFile(join(directory, 'endpoint.local.json'), 'utf8');
  const entry = await catalog.upsert({ label: 'Remote strategist', enabled: true, settings: settings(), apiKey: 'personal-private-test-key' });
  expect(entry.id).not.toBe('host'); expect(entry.hasApiKey).toBe(true);
  expect(catalog.choices()).toEqual([{ id: 'host', label: 'Host model', available: true }, { id: entry.id, label: 'Remote strategist', available: true }]);
  const visible = JSON.stringify({ host: catalog.hostState(), player: catalog.choices() });
  expect(visible).not.toContain('personal-private-test-key'); expect(visible).not.toContain('legacy-private-test-key');
  expect(JSON.stringify(catalog.choices())).not.toContain('model.invalid'); expect(await readFile(join(directory, 'endpoint.local.json'), 'utf8')).toBe(before);
  const restored = new AiModelCatalog(directory, legacy); await restored.load();
  expect(restored.get(entry.id)?.snapshot().apiKey).toBe('personal-private-test-key'); expect(restored.get('host')).toBe(legacy);
  const source = restored.get(entry.id), version = source!.snapshot().version;
  await restored.upsert({ id: entry.id, label: 'Changed', enabled: true, settings: settings('new-model') });
  expect(restored.get(entry.id)).toBe(source); expect(source!.snapshot().version).toBeGreaterThan(version); expect(source!.snapshot().apiKey).toBe('personal-private-test-key');
  await restored.upsert({ id: entry.id, label: 'Changed', enabled: false, settings: settings('new-model'), apiKey: null });
  expect(restored.get(entry.id)).toBeUndefined(); expect(restored.choices()).toHaveLength(1); expect(restored.hostState().models[1]!.hasApiKey).toBe(false);
});

it('updates host metadata through the catalog while preserving legacy-file compatibility', async () => {
  const { directory, catalog } = await fixture();
  await catalog.upsert({ id: 'host', label: 'Main computer', enabled: true, settings: settings('host-next') });
  const legacy = new EndpointConfiguration(directory); await legacy.load({});
  expect(legacy.snapshot()).toMatchObject({ settings: { model: 'host-next' }, apiKey: 'legacy-private-test-key' });
  const restored = new AiModelCatalog(directory, legacy); await restored.load(); expect(restored.choices()[0]!.label).toBe('Main computer');
  await expect(restored.remove('host')).rejects.toThrow('MODEL_RESERVED');
});

it('bounds the catalog and rejects corrupt private data without echoing it', async () => {
  const { directory, legacy, catalog } = await fixture();
  for (let index = 0; index < 15; index++) await catalog.upsert({ id: `model_${index}`, label: `Model ${index}`, enabled: true, settings: settings() });
  await expect(catalog.upsert({ label: 'Overflow', enabled: true, settings: settings() })).rejects.toThrow('MODEL_CATALOG_FULL');
  await catalog.remove('model_2'); expect(catalog.hostState().models).toHaveLength(15);
  await expect(catalog.upsert({ id: '../secret', label: 'Bad', enabled: true, settings: settings() })).rejects.toThrow('INVALID_MODEL_SETTINGS');
  await writeFile(join(directory, 'ai-models.local.json'), '{private-test-data');
  await expect(new AiModelCatalog(directory, legacy).load()).rejects.toThrow(/^MODEL_CATALOG_INVALID$/);
});

it('does not publish new credentials or metadata if the atomic catalog replacement fails', async () => {
  const { directory, catalog } = await fixture();
  const entry = await catalog.upsert({ id: 'extra', label: 'Before', enabled: true, settings: settings(), apiKey: 'before-private' }), source = catalog.get(entry.id)!;
  const previous = source.snapshot(), catalogPath = join(directory, 'ai-models.local.json');
  await rename(catalogPath, join(directory, 'original-catalog.json')); await mkdir(catalogPath);
  await expect(catalog.upsert({ id: entry.id, label: 'After', enabled: true, settings: settings('changed'), apiKey: 'after-private' })).rejects.toThrow('MODEL_CATALOG_WRITE_FAILED');
  expect(source.snapshot()).toEqual(previous); expect(catalog.hostState().models[1]!.label).toBe('Before');
});
