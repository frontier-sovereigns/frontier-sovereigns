import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import { MAX_SAVE_BYTES, SaveStore } from '../apps/server/src/save-store.js';

interface Payload { state: { first: number; second: number }; slots: string[] }
const valid = (value: unknown): value is Payload => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const data = value as Payload;
  return Object.keys(data).sort().join(',') === 'slots,state' && !!data.state && Object.keys(data.state).sort().join(',') === 'first,second'
    && Number.isSafeInteger(data.state.first) && Number.isSafeInteger(data.state.second) && Array.isArray(data.slots) && data.slots.every(slot => typeof slot === 'string');
};
const payload = (): Payload => ({ state: { first: 1, second: 2 }, slots: ['blue', 'red'] });
const root = resolve('runtime-data/save-store-tests');
let directory: string;
beforeEach(async () => { await fs.mkdir(root, { recursive: true }); directory = await fs.mkdtemp(resolve(root, 'case-')); });
afterEach(async () => {
  const child = relative(root, directory);
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP');
  await fs.rm(directory, { recursive: true, force: true });
});

describe('host-only atomic saves and recovery', () => {
  it('captures an immutable snapshot before asynchronous writes and retains dictionary order', async () => {
    const store = new SaveStore(directory, valid), original = payload();
    const pending = store.save(original, { kind: 'manual', label: ' My campaign ', tick: 1200 });
    original.state.first = 99; original.slots.push('unexpected');
    const saved = await pending, loaded = await store.read(saved.id);
    expect(loaded.payload).toEqual(payload()); expect(Object.keys(loaded.payload.state)).toEqual(['first', 'second']);
    expect(saved).toMatchObject({ kind: 'manual', label: 'My campaign', tick: 1200 });
    expect((await fs.readdir(directory))).toEqual([`${saved.id}.json`]);
  });
  it('keeps the latest five valid autosaves and every named manual save', async () => {
    const store = new SaveStore(directory, valid), manual = await store.save(payload(), { kind: 'manual', label: 'Before battle', tick: 10 });
    for (let i = 1; i <= 7; i++) await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: i * 1200 });
    const list = await store.list(); expect(list.warnings).toEqual([]);
    expect(list.saves.filter(save => save.kind === 'auto').map(save => save.tick).sort((a, b) => a - b)).toEqual([3600, 4800, 6000, 7200, 8400]);
    expect(list.saves.some(save => save.id === manual.id)).toBe(true); expect((await store.latestAuto()).summary.tick).toBe(8400);
  });
  it('retains autosaves without rereading manual saves or the newly durable snapshot', async () => {
    const writer = new SaveStore(directory, valid), manual = await writer.save(payload(), { kind: 'manual', label: 'Damaged manual', tick: 1 });
    const autos = [];
    for (let index = 1; index <= 5; index++) autos.push(await writer.save(payload(), { kind: 'auto', label: 'Autosave', tick: index * 1200 }));
    await fs.writeFile(resolve(directory, `${manual.id}.json`), '{truncated');
    const stats: string[] = [], reads: string[] = []; let validations = 0;
    const store = new SaveStore(directory, (value): value is Payload => { validations++; return valid(value); }, {
      ...fs,
      stat: (async (...args: Parameters<typeof fs.stat>) => { stats.push(String(args[0])); return fs.stat(...args); }) as unknown as typeof fs.stat,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads.push(String(args[0])); return fs.readFile(...args); }) as unknown as typeof fs.readFile,
    });
    const saved = await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 7200 });
    const priorPaths = autos.map(save => resolve(directory, `${save.id}.json`)).sort();
    expect(stats.sort()).toEqual([...priorPaths, resolve(directory, `${saved.id}.json`)].sort()); expect(reads.sort()).toEqual(priorPaths);
    expect(validations).toBe(6); // Incoming snapshot plus five previous autosaves.
    expect((await writer.read(saved.id)).payload).toEqual(payload());
    // Interactive listing and explicit recovery still report corrupt manual files.
    expect((await store.list()).warnings).toEqual([{ id: manual.id, code: 'SAVE_CORRUPT' }]);
    const recovered = await store.latestAuto();
    expect(recovered.summary.id).toBe(saved.id); expect(recovered.warnings).toEqual([{ id: manual.id, code: 'SAVE_CORRUPT' }]);
    await expect(fs.stat(resolve(directory, `${autos[0]!.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains by validated creation time, tick and id while preserving corrupt auto candidates', async () => {
    const ids = Array.from({ length: 8 }, (_, index) => `auto_1000000000000_${String(index + 1).padStart(16, '0')}`);
    const dates = ['2020-01-03', '2020-01-03', '2020-01-02', '2020-01-02', '2020-01-04', '2020-01-01', '2020-01-05', '2020-01-06'];
    const ticks = [100, 200, 300, 300, 0, 999, 1000, 1001];
    for (let index = 0; index < ids.length; index++) {
      const body = { formatVersion: 1, id: ids[index], kind: index === 6 ? 'manual' : 'auto', label: 'Candidate', createdAt: `${dates[index]}T00:00:00.000Z`, tick: ticks[index], payload: index === 7 ? { ...payload(), unexpected: true } : payload() };
      await fs.writeFile(resolve(directory, `${ids[index]}.json`), JSON.stringify({ ...body, checksum: createHash('sha256').update(JSON.stringify(body)).digest('hex') }));
    }
    const store = new SaveStore(directory, valid), saved = await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 1200 });
    const listing = await store.list();
    expect(listing.saves.map(save => save.id)).toEqual([saved.id, ids[4], ids[1], ids[0], ids[3]]);
    expect(listing.warnings).toEqual([{ id: ids[7], code: 'SAVE_PAYLOAD_INVALID' }, { id: ids[6], code: 'SAVE_CORRUPT' }]);
    expect((await fs.readdir(directory)).sort()).toEqual([saved.id, ids[4], ids[1], ids[0], ids[3], ids[6], ids[7]].map(id => `${id}.json`).sort());
  });
  it('enforces the all-file ceiling before filtering retention and preserves an already durable save on failure', async () => {
    const names = Array.from({ length: 513 }, (_, index) => `manual_1000000000000_${String(index).padStart(16, '0')}.json`);
    let listings = 0, reads = 0;
    const store = new SaveStore(directory, valid, {
      ...fs,
      // Simulate other saves appearing between preflight and post-rename retention.
      readdir: (async () => ++listings === 1 ? [] : names) as unknown as typeof fs.readdir,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads++; return fs.readFile(...args); }) as unknown as typeof fs.readFile,
    });
    await expect(store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 1200 })).rejects.toThrow('SAVE_DIRECTORY_LIMIT');
    expect(listings).toBe(2); expect(reads).toBe(0);
    const files = await fs.readdir(directory); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^auto_[0-9]{13}_[a-f0-9]{16}\.json$/);
    expect((await new SaveStore(directory, valid).read(files[0]!.slice(0, -5))).payload).toEqual(payload());
    // The initial count still blocks another write even though these are manual names.
    await expect(store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 2400 })).rejects.toThrow('SAVE_DIRECTORY_LIMIT');
    expect(await fs.readdir(directory)).toEqual(files);
  });
  it.each(['stat', 'readFile'] as const)('does not report corruption when retention removes a listed file before %s', async operation => {
    const writer = new SaveStore(directory, valid), oldest = await writer.save(payload(), { kind: 'auto', label: 'Autosave', tick: 1200 });
    for (let index = 2; index <= 5; index++) await writer.save(payload(), { kind: 'auto', label: 'Autosave', tick: index * 1200 });
    const target = resolve(directory, `${oldest.id}.json`);
    let reading!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => { reading = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const io = { ...fs };
    if (operation === 'stat') io.stat = (async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === target) { reading(); await resume; }
      return fs.stat(...args);
    }) as unknown as typeof fs.stat;
    else io.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]) === target) { reading(); await resume; }
      return fs.readFile(...args);
    }) as unknown as typeof fs.readFile;
    const listing = new SaveStore(directory, valid, io).list();
    await reached;
    try {
      // The reader already enumerated all five names; this real sixth save prunes the first.
      await writer.save(payload(), { kind: 'auto', label: 'Autosave', tick: 7200 });
      await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { release(); }
    const result = await listing;
    expect(result.warnings).toEqual([]);expect(result.saves.map(save => save.tick).sort((a, b) => a - b)).toEqual([2400, 3600, 4800, 6000]);
    expect((await writer.latestAuto()).summary.tick).toBe(7200);
  });
  it('retains warnings for permission failures while other saves remain readable', async () => {
    const writer = new SaveStore(directory, valid), blocked = await writer.save(payload(), { kind: 'manual', label: 'Restricted', tick: 1 });
    const readable = await writer.save(payload(), { kind: 'manual', label: 'Readable', tick: 2 }), target = resolve(directory, `${blocked.id}.json`);
    const io = { ...fs, stat: (async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]) === target) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      return fs.stat(...args);
    }) as unknown as typeof fs.stat };
    const listing = await new SaveStore(directory, valid, io).list();
    expect(listing.saves.map(save => save.id)).toEqual([readable.id]);expect(listing.warnings).toEqual([{ id: blocked.id, code: 'SAVE_READ_FAILED' }]);
  });
  it('reports corrupt newest autosave and explicitly falls back to the previous valid one', async () => {
    const store = new SaveStore(directory, valid), prior = await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 1200 });
    const newest = await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 2400 });
    await fs.writeFile(resolve(directory, `${newest.id}.json`), '{truncated');
    const recovered = await store.latestAuto(); expect(recovered.summary.id).toBe(prior.id);
    expect(recovered.warnings).toEqual([{ id: newest.id, code: 'SAVE_CORRUPT' }]);
    expect(await fs.readFile(resolve(directory, `${prior.id}.json`), 'utf8')).toContain('checksum');
  });
  it.each(['open', 'rename'] as const)('preserves the prior valid save when %s fails and removes its incomplete temporary file', async operation => {
    const store = new SaveStore(directory, valid), prior = await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 1200 });
    const fail = async () => { const error = new Error('Injected disk write failure') as NodeJS.ErrnoException; error.code = operation === 'open' ? 'ENOSPC' : 'EACCES'; throw error; };
    const faulty = new SaveStore(directory, valid, { ...fs, [operation]: fail });
    await expect(faulty.save(payload(), { kind: 'auto', label: 'Autosave', tick: 2400 })).rejects.toThrow('Injected disk write failure');
    expect((await store.read(prior.id)).payload).toEqual(payload()); expect(await fs.readdir(directory)).toEqual([`${prior.id}.json`]);
  });
  it('checks payload insertion order, unsupported formats and strict payload shape before accepting a file', async () => {
    const store = new SaveStore(directory, valid), saved = await store.save(payload(), { kind: 'manual', label: 'Integrity', tick: 1 });
    const path = resolve(directory, `${saved.id}.json`), original = JSON.parse(await fs.readFile(path, 'utf8'));
    original.payload.state = { second: 2, first: 1 }; await fs.writeFile(path, JSON.stringify(original));
    await expect(store.read(saved.id)).rejects.toThrow('SAVE_CHECKSUM_MISMATCH');
    original.formatVersion = 2; await fs.writeFile(path, JSON.stringify(original));
    await expect(store.read(saved.id)).rejects.toThrow('SAVE_FORMAT_UNSUPPORTED');
    original.formatVersion = 1; original.payload.unexpected = 'not accepted';
    const { checksum: _checksum, ...body } = original;
    original.checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex'); await fs.writeFile(path, JSON.stringify(original));
    await expect(store.read(saved.id)).rejects.toThrow('SAVE_PAYLOAD_INVALID');
  });
  it('rejects traversal IDs and oversized files before reading their contents', async () => {
    const store = new SaveStore(directory, valid);
    await expect(store.read('../host-bootstrap')).rejects.toThrow('INVALID_SAVE_ID');
    const saved = await store.save(payload(), { kind: 'manual', label: 'Bounded', tick: 1 });
    const stat = await fs.stat(resolve(directory, `${saved.id}.json`)); stat.size = MAX_SAVE_BYTES + 1;
    let read = false;
    const bounded = new SaveStore(directory, valid, { ...fs, stat: (async () => stat) as unknown as typeof fs.stat, readFile: (async () => { read = true; throw new Error('Unexpected read'); }) as typeof fs.readFile });
    await expect(bounded.read(saved.id)).rejects.toThrow('SAVE_TOO_LARGE'); expect(read).toBe(false);
  });
  it('caches listing summaries and validation warnings, invalidates changed files, and always validates explicit reads', async () => {
    const writer = new SaveStore(directory, valid), good = await writer.save(payload(), { kind: 'manual', label: 'Good', tick: 1 });
    const bad = await writer.save(payload(), { kind: 'manual', label: 'Bad', tick: 2 }), badPath = resolve(directory, `${bad.id}.json`);
    const original = await fs.readFile(badPath); await fs.writeFile(badPath, '{broken');
    let reads = 0;
    const store = new SaveStore(directory, valid, { ...fs, readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads++; return fs.readFile(...args); }) as unknown as typeof fs.readFile });
    const first = await store.list(); expect(reads).toBe(2);
    expect(first.warnings).toEqual([{ id: bad.id, code: 'SAVE_CORRUPT' }]);
    first.saves[0]!.label = 'Caller mutation'; first.warnings[0]!.code = 'Caller mutation';
    const repeated = await store.list(); expect(reads).toBe(2);
    expect(repeated.saves[0]!.label).toBe('Good'); expect(repeated.warnings[0]!.code).toBe('SAVE_CORRUPT');
    await store.read(good.id); expect(reads).toBe(3);
    await fs.writeFile(badPath, original);
    expect((await store.list()).saves).toHaveLength(2); expect(reads).toBe(4);
    await fs.unlink(resolve(directory, `${good.id}.json`));
    expect((await store.list()).saves.map(save => save.id)).toEqual([bad.id]); expect(reads).toBe(4);
  });
  it('coalesces simultaneous listing scans and seeds newly durable summaries', async () => {
    const writer = new SaveStore(directory, valid); await writer.save(payload(), { kind: 'manual', label: 'Existing', tick: 1 });
    let reads = 0, directories = 0;
    const store = new SaveStore(directory, valid, {
      ...fs,
      readdir: (async (...args: Parameters<typeof fs.readdir>) => { directories++; return fs.readdir(...args); }) as unknown as typeof fs.readdir,
      readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads++; return fs.readFile(...args); }) as unknown as typeof fs.readFile,
    });
    const [first, second] = await Promise.all([store.list(), store.list()]);
    expect(directories).toBe(1); expect(reads).toBe(1); expect(first).toEqual(second);
    first.saves[0]!.label = 'Changed'; expect(second.saves[0]!.label).toBe('Existing');
    const saved = await store.save(payload(), { kind: 'manual', label: 'New', tick: 2 });
    expect((await store.list()).saves.some(save => save.id === saved.id)).toBe(true); expect(reads).toBe(1);
  });
  it('retries transient read errors without requiring file metadata to change', async () => {
    const writer = new SaveStore(directory, valid), saved = await writer.save(payload(), { kind: 'manual', label: 'Retry', tick: 1 });
    let reads = 0;
    const store = new SaveStore(directory, valid, { ...fs, readFile: (async (...args: Parameters<typeof fs.readFile>) => {
      if (++reads === 1) throw Object.assign(new Error('Temporary failure'), { code: 'EACCES' });
      return fs.readFile(...args);
    }) as unknown as typeof fs.readFile });
    expect((await store.list()).warnings).toEqual([{ id: saved.id, code: 'SAVE_READ_FAILED' }]);
    expect((await store.list()).saves.map(save => save.id)).toEqual([saved.id]); expect(reads).toBe(2);
  });
  it('rejects only listing candidates through a bounded prefix hint and fully validates direct reads', async () => {
    const writer = new SaveStore(directory, valid), large = payload(); large.slots.push('x'.repeat(8000));
    const saved = await writer.save(large, { kind: 'manual', label: 'Previous engine', tick: 1 });
    let reads = 0, probes = 0;
    const store = new SaveStore(directory, valid, { ...fs, readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads++; return fs.readFile(...args); }) as unknown as typeof fs.readFile }, prefix => {
      probes++; expect(Buffer.byteLength(prefix)).toBe(4096); return 'ENGINE_VERSION_MISMATCH';
    });
    expect((await store.list()).warnings).toEqual([{ id: saved.id, code: 'ENGINE_VERSION_MISMATCH' }]);
    await store.list(); expect(probes).toBe(1); expect(reads).toBe(0);
    expect((await store.read(saved.id)).payload).toEqual(large); expect(reads).toBe(1); expect(probes).toBe(1);
  });
  it('never accepts a save based on a listing prefix and bypasses hints and cached acceptance for retention', async () => {
    const writer = new SaveStore(directory, valid), autos = [];
    for (let i = 1; i <= 5; i++) autos.push(await writer.save(payload(), { kind: 'auto', label: 'Autosave', tick: i * 1200 }));
    let reads = 0, probes = 0;
    const store = new SaveStore(directory, valid, { ...fs, readFile: (async (...args: Parameters<typeof fs.readFile>) => { reads++; return fs.readFile(...args); }) as unknown as typeof fs.readFile }, () => { probes++; return undefined; });
    expect((await store.list()).saves).toHaveLength(5); expect(reads).toBe(5); expect(probes).toBe(5);
    await fs.writeFile(resolve(directory, `${autos[0]!.id}.json`), '{truncated');
    await store.save(payload(), { kind: 'auto', label: 'Autosave', tick: 7200 });
    expect(reads).toBe(10); expect(probes).toBe(5);
    // The now-corrupt previously cached candidate survives retention.
    expect(await fs.readFile(resolve(directory, `${autos[0]!.id}.json`), 'utf8')).toBe('{truncated');
    expect((await store.list()).warnings).toEqual([{ id: autos[0]!.id, code: 'SAVE_CORRUPT' }]);
    expect(reads).toBe(11); expect(probes).toBe(6);
    const loaded = await store.latestAuto(); expect(loaded.summary.tick).toBe(7200); expect(reads).toBe(12);
  });
});
