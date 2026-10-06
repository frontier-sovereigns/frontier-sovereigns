import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AiModelCatalogResponse, AiModelChoice, AiModelUpsertRequest, EndpointSettings, EndpointStateResponse, HostAiModelEntry } from '@frontier/shared';
import { EndpointConfiguration, EndpointError, normalizeEndpointSettings, type EndpointConfigSource, type OutputMode } from './ai-endpoint.js';

const MAX_MODELS = 16, MAX_FILE_BYTES = 512 * 1024;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value);
const validKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
const validLabel = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
type StoredModel = { id: string; label: string; enabled: boolean; settings: EndpointSettings; apiKey: string };
type StoredCatalog = { formatVersion: 1; host: { label: string; enabled: boolean }; models: StoredModel[] };

class CatalogEndpoint implements EndpointConfigSource {
  private version = 1;
  private capability: EndpointStateResponse['capability'];
  constructor(private settings: EndpointSettings, private apiKey: string) { this.capability = { mode: 'unprobed', status: this.configured() ? 'NOT_TESTED' : 'NOT_CONFIGURED' }; }
  private configured() { return Boolean(this.settings.baseUrl && this.settings.model && this.settings.model !== 'replace-with-your-served-model-id'); }
  snapshot() { return { settings: structuredClone(this.settings), apiKey: this.apiKey, version: this.version }; }
  state(): EndpointStateResponse { return { settings: structuredClone(this.settings), hasApiKey: Boolean(this.apiKey), configured: this.configured(), capability: { ...this.capability } }; }
  setCapability(mode: OutputMode, status: string, version = this.version) { if (version === this.version) this.capability = { mode, status, checkedAt: Date.now() }; }
  replace(settings: EndpointSettings, apiKey: string) { this.settings = structuredClone(settings); this.apiKey = apiKey; this.version++; this.capability = { mode: 'unprobed', status: this.configured() ? 'NOT_TESTED' : 'NOT_CONFIGURED' }; }
}

/** Host-managed private catalog. The reserved host model keeps its legacy file. */
export class AiModelCatalog {
  private readonly path: string;
  private host = { label: 'Host model', enabled: true };
  private models = new Map<string, { label: string; enabled: boolean; endpoint: CatalogEndpoint }>();
  private writing = false;
  constructor(directory: string, private readonly legacyEndpoint: EndpointConfiguration) { this.path = resolve(directory, 'ai-models.local.json'); }
  async load(): Promise<void> {
    let value: unknown;
    try {
      const stat = await fs.stat(this.path); if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new EndpointError('MODEL_CATALOG_INVALID');
      const bytes = await fs.readFile(this.path); if (bytes.length > MAX_FILE_BYTES) throw new EndpointError('MODEL_CATALOG_INVALID');
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new EndpointError('MODEL_CATALOG_INVALID'); }
    try {
      if (!plain(value) || Object.keys(value).sort().join(',') !== 'formatVersion,host,models' || value.formatVersion !== 1 || !plain(value.host) || Object.keys(value.host).sort().join(',') !== 'enabled,label' || !validLabel(value.host.label) || typeof value.host.enabled !== 'boolean' || !Array.isArray(value.models) || value.models.length >= MAX_MODELS) throw new Error();
      const next = new Map<string, { label: string; enabled: boolean; endpoint: CatalogEndpoint }>();
      for (const item of value.models) {
        if (!plain(item) || Object.keys(item).sort().join(',') !== 'apiKey,enabled,id,label,settings' || !validId(item.id) || item.id === 'host' || next.has(item.id) || !validLabel(item.label) || typeof item.enabled !== 'boolean' || !validKey(item.apiKey)) throw new Error();
        next.set(item.id, { label: item.label.trim(), enabled: item.enabled, endpoint: new CatalogEndpoint(normalizeEndpointSettings(item.settings), item.apiKey) });
      }
      this.host = { label: value.host.label.trim(), enabled: value.host.enabled }; this.models = next;
    } catch { throw new EndpointError('MODEL_CATALOG_INVALID'); }
  }
  entries(): { id: string; label: string; enabled: boolean; endpoint: EndpointConfigSource }[] { return [{ id: 'host', ...this.host, endpoint: this.legacyEndpoint }, ...[...this.models].map(([id, item]) => ({ id, ...item }))]; }
  hostState(): AiModelCatalogResponse { return { models: this.entries().map(({ endpoint, ...item }) => ({ ...item, ...endpoint.state() })) }; }
  /** Labels and availability only: no route, provider settings, key or diagnostics. */
  choices(): AiModelChoice[] { return this.entries().filter(item => item.enabled).map(item => ({ id: item.id, label: item.label, available: item.endpoint.state().configured })); }
  get(id: string): EndpointConfigSource | undefined { const entry = this.entries().find(item => item.id === id); return entry?.enabled ? entry.endpoint : undefined; }
  private stored(): StoredCatalog { return { formatVersion: 1, host: { ...this.host }, models: [...this.models].map(([id, item]) => ({ id, label: item.label, enabled: item.enabled, settings: item.endpoint.snapshot().settings, apiKey: item.endpoint.snapshot().apiKey })) }; }
  private async persist(value: StoredCatalog): Promise<void> {
    const temporary = `${this.path}.tmp_${randomBytes(8).toString('hex')}`;
    try {
      const body = JSON.stringify(value); if (Buffer.byteLength(body) > MAX_FILE_BYTES) throw new Error();
      await fs.mkdir(resolve(this.path, '..'), { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.path);
    } catch { await fs.unlink(temporary).catch(() => {}); throw new EndpointError('MODEL_CATALOG_WRITE_FAILED'); }
  }
  async upsert(input: AiModelUpsertRequest): Promise<HostAiModelEntry> {
    if (this.writing) throw new EndpointError('MODEL_CATALOG_BUSY');
    if (!plain(input) || Object.keys(input).some(key => !['id', 'label', 'enabled', 'settings', 'apiKey'].includes(key)) || input.id !== undefined && !validId(input.id) || !validLabel(input.label) || typeof input.enabled !== 'boolean') throw new EndpointError('INVALID_MODEL_SETTINGS');
    const settings = normalizeEndpointSettings(input.settings), id = input.id ?? `model_${randomBytes(8).toString('hex')}`, existing = this.models.get(id);
    if (!existing && id !== 'host' && this.models.size >= MAX_MODELS - 1) throw new EndpointError('MODEL_CATALOG_FULL');
    const previousKey = id === 'host' ? this.legacyEndpoint.snapshot().apiKey : existing?.endpoint.snapshot().apiKey ?? '';
    const apiKey = input.apiKey === undefined ? previousKey : input.apiKey === null ? '' : input.apiKey;
    if (!validKey(apiKey)) throw new EndpointError('INVALID_API_KEY');
    const previous = this.stored(), next = structuredClone(previous), label = input.label.trim();
    if (id === 'host') next.host = { label, enabled: input.enabled };
    else { const item = { id, label, enabled: input.enabled, settings, apiKey }, index = next.models.findIndex(model => model.id === id); if (index === -1) next.models.push(item); else next.models[index] = item; }
    this.writing = true;
    try {
      // Each credentials file is atomic; publish memory only after both writes.
      await this.persist(next);
      if (id === 'host') {
        try { await this.legacyEndpoint.update(settings, apiKey); }
        catch (error) { await this.persist(previous); throw error; }
        this.host = next.host;
      } else if (existing) { existing.endpoint.replace(settings, apiKey); existing.label = label; existing.enabled = input.enabled; }
      else this.models.set(id, { label, enabled: input.enabled, endpoint: new CatalogEndpoint(settings, apiKey) });
      return this.hostState().models.find(item => item.id === id)!;
    } finally { this.writing = false; }
  }
  async remove(id: string): Promise<void> {
    if (id === 'host') throw new EndpointError('MODEL_RESERVED');
    if (!this.models.has(id)) throw new EndpointError('MODEL_NOT_FOUND');
    if (this.writing) throw new EndpointError('MODEL_CATALOG_BUSY');
    const next = this.stored(); next.models = next.models.filter(item => item.id !== id); this.writing = true;
    try { await this.persist(next); this.models.delete(id); } finally { this.writing = false; }
  }
}
