import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

// Explicit safety ceilings, not a claim that every legal long-running world fits.
export const MAX_SAVE_BYTES = 256 * 1024 * 1024;
const idPattern = /^(auto|manual)_[0-9]{13}_[a-f0-9]{16}$/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validationWarnings = new Set(['SAVE_TOO_LARGE', 'SAVE_CORRUPT', 'SAVE_FORMAT_UNSUPPORTED', 'SAVE_CHECKSUM_MISMATCH', 'SAVE_PAYLOAD_INVALID', 'INVALID_ENGINE_IDENTITY', 'INVALID_SAVE', 'SAVE_VERSION_UNSUPPORTED', 'ENGINE_VERSION_MISMATCH', 'ENGINE_RUNTIME_MISMATCH', 'CONTENT_VERSION_MISMATCH', 'INVALID_SAVE_PAYLOAD']);
export interface SaveSummary { id: string; kind: 'auto' | 'manual'; label: string; createdAt: string; tick: number; bytes: number }
interface SaveRecord<T> { formatVersion: 1; id: string; kind: 'auto' | 'manual'; label: string; createdAt: string; tick: number; payload: T; checksum: string }
type SaveIO = Pick<typeof fs, 'mkdir' | 'open' | 'rename' | 'unlink' | 'readFile' | 'readdir' | 'stat'>;
export interface SaveListing { saves: SaveSummary[]; warnings: { id: string; code: string }[] }
type ListingEntry = { fingerprint: string; summary?: SaveSummary; warning?: string };
type SaveStat = Awaited<ReturnType<SaveIO['stat']>>;
const fingerprint = (stat: SaveStat): string => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid, stat.size, stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs].join(':');

/** Host-only storage. It never receives model keys, cookies or live slot tokens. */
export class SaveStore<T> {
  readonly directory: string;
  private writing = false;
  private readonly listingCache = new Map<string, ListingEntry>();
  private listing: Promise<SaveListing> | undefined;
  constructor(directory: string, private readonly validatePayload: (value: unknown) => value is T, private readonly io: SaveIO = fs,
    // A negative compatibility hint only: an absent rejection always requires
    // full validation. Explicit loads and retention never use this shortcut.
    private readonly listingPreflight?: (prefix: string) => string | undefined) {
    this.directory = resolve(directory);
  }
  private path(id: string): string {
    if (!idPattern.test(id)) throw new Error('INVALID_SAVE_ID');
    const path = resolve(this.directory, `${id}.json`), child = relative(this.directory, path);
    if (isAbsolute(child) || child.startsWith('..')) throw new Error('INVALID_SAVE_ID');
    return path;
  }
  private summary(record: SaveRecord<T>, bytes: number): SaveSummary {
    return { id: record.id, kind: record.kind, label: record.label, createdAt: record.createdAt, tick: record.tick, bytes };
  }
  private cache(id: string, entry: ListingEntry): void {
    this.listingCache.delete(id);
    this.listingCache.set(id, entry);
    if (this.listingCache.size > 512) this.listingCache.delete(this.listingCache.keys().next().value!);
  }
  private async listingEntry(id: string): Promise<ListingEntry> {
    const path = this.path(id), before = await this.io.stat(path), stamp = fingerprint(before);
    const cached = this.listingCache.get(id);
    if (cached?.fingerprint === stamp) return cached;
    this.listingCache.delete(id);
    let entry: ListingEntry;
    try {
      if (!before.isFile() || before.size > MAX_SAVE_BYTES) throw new Error('SAVE_TOO_LARGE');
      if (this.listingPreflight) {
        const handle = await this.io.open(path, 'r'), prefix = Buffer.alloc(4096);
        try {
          const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
          const rejected = this.listingPreflight(prefix.subarray(0, bytesRead).toString('utf8'));
          if (rejected && validationWarnings.has(rejected)) throw new Error(rejected);
        } finally { await handle.close(); }
      }
      entry = { fingerprint: stamp, summary: (await this.read(id)).summary };
    } catch (error) {
      // File permissions and other transient I/O failures must be retried even
      // when metadata did not change. Only deterministic validation is cached.
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code || !validationWarnings.has(error.message)) throw error;
      entry = { fingerprint: stamp, warning: error.message };
    }
    const after = await this.io.stat(path);
    if (fingerprint(after) === stamp) this.cache(id, entry);
    return entry;
  }
  async read(id: string): Promise<{ summary: SaveSummary; payload: T }> {
    const path = this.path(id), stat = await this.io.stat(path);
    if (!stat.isFile() || stat.size > MAX_SAVE_BYTES) throw new Error('SAVE_TOO_LARGE');
    const bytes = await this.io.readFile(path);
    if (bytes.length > MAX_SAVE_BYTES) throw new Error('SAVE_TOO_LARGE');
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('SAVE_CORRUPT'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SAVE_CORRUPT');
    const record = value as SaveRecord<unknown>;
    if (record.formatVersion !== 1) throw new Error('SAVE_FORMAT_UNSUPPORTED');
    if (Object.keys(record).sort().join(',') !== 'checksum,createdAt,formatVersion,id,kind,label,payload,tick' || record.id !== id || !['auto', 'manual'].includes(record.kind)
      || !id.startsWith(`${record.kind}_`) || typeof record.label !== 'string' || !record.label.length || record.label.length > 64
      || /[\u0000-\u001f\u007f]/.test(record.label) || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))
      || !Number.isSafeInteger(record.tick) || record.tick < 0 || typeof record.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(record.checksum)) throw new Error('SAVE_CORRUPT');
    const { checksum, ...body } = record;
    // JSON.stringify preserves gameplay dictionary insertion order in payload.
    if (hash(body) !== checksum) throw new Error('SAVE_CHECKSUM_MISMATCH');
    if (!this.validatePayload(record.payload)) throw new Error('SAVE_PAYLOAD_INVALID');
    return { summary: this.summary(record as SaveRecord<T>, bytes.length), payload: record.payload };
  }
  private async listValidated(retention?: { excludeId: string }): Promise<SaveListing> {
    let names: string[];
    try { names = await this.io.readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.listingCache.clear(); return { saves: [], warnings: [] }; } throw error; }
    const ids = names.filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5))).map(name => name.slice(0, -5)).sort().reverse();
    if (ids.length > 512) throw new Error('SAVE_DIRECTORY_LIMIT');
    const present = new Set(ids);
    for (const id of this.listingCache.keys()) if (!present.has(id)) this.listingCache.delete(id);
    const result: SaveListing = { saves: [], warnings: [] };
    for (const id of ids) {
      // Retention only needs older autosaves. The new record was validated and
      // flushed before rename; compatible manual saves receive full checks on
      // their first listing and whenever their metadata changes.
      // A matching filename only selects a candidate: read() validates its body.
      if (retention && (id === retention.excludeId || !id.startsWith('auto_'))) continue;
      try {
        const entry = retention ? { summary: (await this.read(id)).summary } : await this.listingEntry(id);
        if (entry.summary) result.saves.push({ ...entry.summary });
        else if ('warning' in entry && entry.warning) result.warnings.push({ id, code: entry.warning });
      }
      catch (error) {
        // Retention can remove an older file after this listing captured its name.
        // A vanished entry is absent, while unreadable/corrupt files remain warnings.
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') continue;
        result.warnings.push({ id, code: error instanceof Error && /^[A-Z][A-Z_]{1,95}$/.test(error.message) ? error.message : 'SAVE_READ_FAILED' });
      }
    }
    result.saves.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.tick - a.tick || b.id.localeCompare(a.id));
    return result;
  }
  async list(): Promise<SaveListing> {
    const pending = this.listing ??= this.listValidated().finally(() => { this.listing = undefined; });
    const result = await pending;
    // Callers must not be able to mutate a shared in-flight result or cache.
    return { saves: result.saves.map(save => ({ ...save })), warnings: result.warnings.map(warning => ({ ...warning })) };
  }
  async latestAuto(): Promise<{ summary: SaveSummary; payload: T; warnings: SaveListing['warnings'] }> {
    const listing = await this.list(), latest = listing.saves.find(save => save.kind === 'auto');
    if (!latest) throw new Error('NO_VALID_AUTOSAVE');
    return { ...await this.read(latest.id), warnings: listing.warnings };
  }
  async save(payload: T, options: { kind: 'auto' | 'manual'; label: string; tick: number }): Promise<SaveSummary> {
    if (this.writing) throw new Error('SAVE_BUSY');
    const label = options.label.trim();
    if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/.test(label) || !Number.isSafeInteger(options.tick) || options.tick < 0) throw new Error('INVALID_SAVE_LABEL');
    if (!this.validatePayload(payload)) throw new Error('SAVE_PAYLOAD_INVALID');
    const captured = structuredClone(payload), kind = options.kind, tick = options.tick;
    this.writing = true;
    let temporary: string | undefined;
    try {
      await this.io.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const existing = await this.io.readdir(this.directory);
      if (existing.filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5))).length >= 512) throw new Error('SAVE_DIRECTORY_LIMIT');
      const now = Date.now(), id = `${kind}_${now}_${randomBytes(8).toString('hex')}`;
      const body = { formatVersion: 1 as const, id, kind, label, createdAt: new Date(now).toISOString(), tick, payload: captured };
      const record = { ...body, checksum: hash(body) }, bytes = Buffer.from(JSON.stringify(record));
      if (bytes.length > MAX_SAVE_BYTES) throw new Error('SAVE_TOO_LARGE');
      const target = this.path(id); temporary = `${target}.tmp_${randomBytes(8).toString('hex')}`;
      const handle = await this.io.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.io.rename(temporary, target); temporary = undefined;
      try {
        const stat = await this.io.stat(target);
        if (stat.isFile() && stat.size === bytes.length) this.cache(id, { fingerprint: fingerprint(stat), summary: this.summary(record, bytes.length) });
      } catch { /* A cache seed failure cannot invalidate the durable save. */ }
      if (kind === 'auto') {
        // Remove only older validated autosaves after the new file is durable.
        const autos = (await this.listValidated({ excludeId: id })).saves;
        for (const old of autos.slice(4)) try { await this.io.unlink(this.path(old.id)); this.listingCache.delete(old.id); } catch { /* A completed save remains valid; later retention retries. */ }
      }
      return this.summary(record, bytes.length);
    } finally {
      this.writing = false;
      if (temporary) try { await this.io.unlink(temporary); } catch { /* Preserve the original failure. */ }
    }
  }
}
