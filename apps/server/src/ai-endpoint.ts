import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { balance, validateEndpointSettings, type EndpointSettings, type EndpointStateResponse, type EndpointProbeResponse } from '@frontier/shared';
import canonicalPlanSchema from '../../../schemas/ai-plan.schema.json' with { type: 'json' };

export type OutputMode = EndpointStateResponse['capability']['mode'];
/** Private scheduler input. Implementations never include credentials in state(). */
export interface EndpointConfigSource {
  snapshot(): { settings: EndpointSettings; apiKey: string; version: number };
  state(): EndpointStateResponse;
  setCapability(mode: OutputMode, status: string, version?: number): void;
}
export const MAX_ENDPOINT_BODY_BYTES = 64 * 1024, MAX_ENDPOINT_RESPONSE_BYTES = 256 * 1024;
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeCode = (value: unknown, fallback: string) => value instanceof EndpointError ? value.code : fallback;
export class EndpointError extends Error {
  constructor(readonly code: string, readonly retryAfterMs = 0, readonly completionTelemetry?: CompletionTelemetry) { super(code); }
}

export function defaultEndpointSettings(): EndpointSettings {
  return { baseUrl: '', model: '', providerProfile: 'generic_openai_compatible', timeoutSeconds: balance.ai.timeoutSeconds, maxConcurrent: balance.ai.maxConcurrent,
    inputTokenBudget: 2500, maxOutputTokens: balance.ai.maxOutputTokens,
    intervalSeconds: { easy: balance.ai.difficulty.easy.strategicIntervalSeconds, medium: balance.ai.difficulty.medium.strategicIntervalSeconds, hard: balance.ai.difficulty.hard.strategicIntervalSeconds },
    maxAdaptiveIntervalSeconds: balance.ai.maxAdaptiveIntervalSeconds, temperature: 0.2, sendHumanChat: true, providerOptions: {} };
}
export function normalizeEndpointSettings(input: unknown): EndpointSettings {
  if (!validateEndpointSettings(input)) throw new EndpointError('INVALID_ENDPOINT_SETTINGS');
  const settings = structuredClone(input);
  settings.model = settings.model.trim(); settings.baseUrl = settings.baseUrl.trim();
  if (settings.baseUrl) {
    let url: URL; try { url = new URL(settings.baseUrl); } catch { throw new EndpointError('INVALID_ENDPOINT_URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname || /[\u0000-\u001f\u007f]/.test(settings.baseUrl)) throw new EndpointError('INVALID_ENDPOINT_URL');
    settings.baseUrl = url.href.replace(/\/+$/, '');
  }
  if (/[\u0000-\u001f\u007f]/.test(settings.model) || Object.values(settings.intervalSeconds).some(interval => interval > settings.maxAdaptiveIntervalSeconds)) throw new EndpointError('INVALID_ENDPOINT_SETTINGS');
  const common = ['top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'reasoning_effort'];
  const profile = settings.providerProfile === 'llama_cpp' ? ['top_k', 'min_p', 'repeat_penalty', 'chat_template_kwargs', 'reasoning_effort'] : settings.providerProfile === 'vllm' ? ['top_k', 'min_p', 'repetition_penalty', 'chat_template_kwargs', 'reasoning_effort'] : [];
  if (Object.keys(settings.providerOptions).some(key => ![...common, ...profile].includes(key))) throw new EndpointError('UNSUPPORTED_PROVIDER_OPTION');
  return settings;
}
export function endpointUrl(baseUrl: string, operation: 'chat/completions' | 'models' | 'chat/completions/input_tokens'): string {
  return `${baseUrl.replace(/\/+$/, '')}/${operation}`;
}
function keyValid(key: unknown): key is string { return typeof key === 'string' && key.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(key); }

/** Game-owned local configuration, excluded from every save, replay and public DTO. */
export class EndpointConfiguration implements EndpointConfigSource {
  private settings = defaultEndpointSettings(); private apiKey = ''; private version = 0; private writing = false;
  private capability: EndpointStateResponse['capability'] = { mode: 'unprobed', status: 'NOT_CONFIGURED' };
  private readonly path: string;
  constructor(directory: string) { this.path = resolve(directory, 'endpoint.local.json'); }
  snapshot() { return { settings: structuredClone(this.settings), apiKey: this.apiKey, version: this.version }; }
  state(): EndpointStateResponse { return { settings: structuredClone(this.settings), hasApiKey: Boolean(this.apiKey), configured: Boolean(this.settings.baseUrl && this.settings.model && this.settings.model !== 'replace-with-your-served-model-id'), capability: { ...this.capability } }; }
  setCapability(mode: OutputMode, status: string, version = this.version) { if (version === this.version) this.capability = { mode, status, checkedAt: Date.now() }; }
  async load(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
      const stat = await fs.stat(this.path); if (!stat.isFile() || stat.size > 32768) throw new EndpointError('ENDPOINT_CONFIG_INVALID');
      const bytes = await fs.readFile(this.path); if (bytes.length > 32768) throw new EndpointError('ENDPOINT_CONFIG_INVALID');
      const value: unknown = JSON.parse(bytes.toString('utf8'));
      if (!plain(value) || Object.keys(value).sort().join(',') !== 'apiKey,formatVersion,settings' || value.formatVersion !== 1 || !keyValid(value.apiKey)) throw new EndpointError('ENDPOINT_CONFIG_INVALID');
      this.settings = normalizeEndpointSettings(value.settings); this.apiKey = value.apiKey; this.version++;
      this.capability = { mode: 'unprobed', status: this.state().configured ? 'NOT_TESTED' : 'NOT_CONFIGURED' }; return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.capability = { mode: 'unprobed', status: safeCode(error, 'ENDPOINT_CONFIG_INVALID') }; return; }
    }
    try {
      const settings = defaultEndpointSettings();
      const numeric: [keyof EndpointSettings, string][] = [['timeoutSeconds', 'AI_TIMEOUT_SECONDS'], ['maxConcurrent', 'AI_MAX_CONCURRENT'], ['inputTokenBudget', 'AI_INPUT_TOKEN_BUDGET'], ['maxOutputTokens', 'AI_MAX_OUTPUT_TOKENS'], ['maxAdaptiveIntervalSeconds', 'AI_MAX_ADAPTIVE_INTERVAL_SECONDS'], ['temperature', 'AI_TEMPERATURE']];
      for (const [key, variable] of numeric) if (environment[variable] !== undefined && environment[variable] !== '') (settings as unknown as Record<string, unknown>)[key] = Number(environment[variable]);
      settings.baseUrl = environment.AI_BASE_URL ?? ''; settings.model = environment.AI_MODEL ?? '';
      if (environment.AI_PROVIDER_PROFILE) settings.providerProfile = environment.AI_PROVIDER_PROFILE as EndpointSettings['providerProfile'];
      for (const difficulty of ['easy', 'medium', 'hard'] as const) { const value = environment[`AI_INTERVAL_${difficulty.toUpperCase()}_SECONDS`]; if (value) settings.intervalSeconds[difficulty] = Number(value); }
      if (environment.AI_SEND_HUMAN_CHAT !== undefined) { if (!['true', 'false'].includes(environment.AI_SEND_HUMAN_CHAT)) throw new EndpointError('INVALID_ENDPOINT_SETTINGS'); settings.sendHumanChat = environment.AI_SEND_HUMAN_CHAT === 'true'; }
      if (environment.AI_PROVIDER_OPTIONS_JSON) settings.providerOptions = JSON.parse(environment.AI_PROVIDER_OPTIONS_JSON);
      if (!keyValid(environment.AI_API_KEY ?? '')) throw new EndpointError('INVALID_API_KEY');
      this.settings = normalizeEndpointSettings(settings); this.apiKey = environment.AI_API_KEY ?? ''; this.version++;
      this.capability = { mode: 'unprobed', status: this.state().configured ? 'NOT_TESTED' : 'NOT_CONFIGURED' };
    } catch (error) { this.settings = defaultEndpointSettings(); this.apiKey = ''; this.capability = { mode: 'unprobed', status: safeCode(error, 'ENDPOINT_CONFIG_INVALID') }; }
  }
  async update(settings: unknown, key?: string | null): Promise<void> {
    if (this.writing) throw new EndpointError('ENDPOINT_CONFIG_BUSY');
    const normalized = normalizeEndpointSettings(settings), nextKey = key === undefined ? this.apiKey : key === null ? '' : key;
    if (!keyValid(nextKey)) throw new EndpointError('INVALID_API_KEY');
    this.writing = true;
    const temporary = `${this.path}.tmp_${randomBytes(8).toString('hex')}`;
    try {
      await fs.mkdir(resolve(this.path, '..'), { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ formatVersion: 1, settings: normalized, apiKey: nextKey })); await handle.sync(); } finally { await handle.close(); }
      await fs.rename(temporary, this.path);
    } catch { await fs.unlink(temporary).catch(() => {}); throw new EndpointError('ENDPOINT_CONFIG_WRITE_FAILED'); }
    finally { this.writing = false; }
    this.settings = normalized; this.apiKey = nextKey; this.version++; this.capability = { mode: 'unprobed', status: this.state().configured ? 'NOT_TESTED' : 'NOT_CONFIGURED' };
  }
}

/** Inline trusted references and equivalent disjoint branches for provider subsets. */
export function providerSchema(schema: unknown = canonicalPlanSchema): unknown {
  const root = schema as Record<string, unknown>, definitions = root.$defs as Record<string, unknown> | undefined;
  const convert = (value: unknown, depth = 0): unknown => {
    if (depth > 32) throw new EndpointError('INVALID_PROVIDER_SCHEMA');
    if (Array.isArray(value)) return value.map(item => convert(item, depth + 1));
    if (!plain(value)) return value;
    if (typeof value.$ref === 'string') { const name = value.$ref.match(/^#\/\$defs\/([A-Za-z0-9_]+)$/)?.[1]; if (!name || !definitions?.[name]) throw new EndpointError('INVALID_PROVIDER_SCHEMA'); return convert(definitions[name], depth + 1); }
    const result: Record<string, unknown> = {};
    for (const [key, part] of Object.entries(value)) { if (['$schema', '$id', '$defs', 'title', 'description'].includes(key)) continue; result[key === 'oneOf' ? 'anyOf' : key] = convert(part, depth + 1); }
    return result;
  };
  return convert(root);
}
export interface EndpointMessages { system: string; user: string }
/** Sanitized numbers from a recognized completion envelope; never provider content or errors. */
export interface CompletionTelemetry { latencyMs: number; promptTokens?: number; completionTokens?: number; totalTokens?: number; prefillMs?: number; generationMs?: number }
export interface CompletionResult extends CompletionTelemetry { content: unknown }
const tokenCount = (value: unknown): number | undefined => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000000 ? Number(value) : undefined;
const timing = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 3600000 ? value : undefined;

export class EndpointClient {
  constructor(private readonly settings: EndpointSettings, private readonly apiKey = '', private readonly fetcher: typeof fetch = fetch) {}
  private async request(operation: 'chat/completions' | 'models' | 'chat/completions/input_tokens', body?: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.settings.baseUrl || !this.settings.model) throw new EndpointError('NOT_CONFIGURED');
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized && Buffer.byteLength(serialized) > MAX_ENDPOINT_BODY_BYTES) throw new EndpointError('INPUT_BODY_LIMIT');
    const controller = new AbortController(), abort = () => controller.abort(); let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.settings.timeoutSeconds * 1000); timeout.unref();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    try {
      const response = await this.fetcher(endpointUrl(this.settings.baseUrl, operation), { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) }, ...(serialized === undefined ? {} : { body: serialized }) });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new EndpointError('REDIRECT_REJECTED'); }
      if (!response.ok) {
        let retry = 0; const header = response.headers.get('retry-after');
        if (header) { const seconds = Number(header); retry = Math.max(0, Math.min(120000, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now() || 0)); }
        await response.body?.cancel().catch(() => {});
        throw new EndpointError(response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : response.status === 404 ? 'MODEL_OR_ROUTE_UNAVAILABLE' : response.status === 429 ? 'RATE_LIMITED' : response.status === 400 || response.status === 422 ? 'REQUEST_UNSUPPORTED' : 'ENDPOINT_FAILURE', retry);
      }
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > MAX_ENDPOINT_RESPONSE_BYTES) { await response.body?.cancel().catch(() => {}); throw new EndpointError('RESPONSE_TOO_LARGE'); }
      if (!response.body) throw new EndpointError('INVALID_ENDPOINT_RESPONSE');
      const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > MAX_ENDPOINT_RESPONSE_BYTES) { await reader.cancel(); throw new EndpointError('RESPONSE_TOO_LARGE'); } parts.push(part.value); }
      try { return JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new EndpointError('INVALID_JSON'); }
    } catch (error) { if (timedOut || signal?.aborted && signal.reason?.name === 'TimeoutError') throw new EndpointError('TIMEOUT'); if (signal?.aborted) throw new EndpointError('CANCELLED'); if (error instanceof EndpointError) throw error; throw new EndpointError('CONNECTION_FAILED'); }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  private body(messages: EndpointMessages, mode: Exclude<OutputMode, 'unprobed'>, schema: unknown, outputTokens = this.settings.maxOutputTokens) {
    const response_format = mode === 'prompt_json' ? undefined : mode === 'json_object' ? { type: 'json_object' } : this.settings.providerProfile === 'llama_cpp' ? { type: 'json_object', schema: providerSchema(schema) } : { type: 'json_schema', json_schema: { name: 'frontier_plan', strict: true, schema: providerSchema(schema) } };
    return { model: this.settings.model, messages: [{ role: 'system', content: messages.system }, { role: 'user', content: messages.user }], stream: false, temperature: this.settings.temperature, max_tokens: outputTokens, ...(response_format ? { response_format } : {}), ...this.settings.providerOptions };
  }
  async complete(messages: EndpointMessages, mode: Exclude<OutputMode, 'unprobed'>, signal?: AbortSignal, schema: unknown = canonicalPlanSchema, outputTokens?: number): Promise<CompletionResult> {
    const started = performance.now(), result = await this.request('chat/completions', this.body(messages, mode, schema, outputTokens), signal);
    if (!plain(result) || !Array.isArray(result.choices) || result.choices.length !== 1 || !plain(result.choices[0]) || !plain(result.choices[0].message)) throw new EndpointError('INVALID_ENDPOINT_RESPONSE');
    const choice = result.choices[0], message = choice.message as Record<string, unknown>;
    const usage = plain(result.usage) ? result.usage : {}, timings = plain(result.timings) ? result.timings : {};
    const telemetry: CompletionTelemetry = { latencyMs: performance.now() - started, promptTokens: tokenCount(usage.prompt_tokens), completionTokens: tokenCount(usage.completion_tokens), totalTokens: tokenCount(usage.total_tokens), prefillMs: timing(timings.prompt_ms), generationMs: timing(timings.predicted_ms) };
    // Rejected final content still consumed inference. Carry only sanitized numbers through the error path.
    if (choice.finish_reason === 'length') throw new EndpointError('OUTPUT_TRUNCATED', 0, telemetry);
    if (message.refusal || Array.isArray(message.tool_calls) && message.tool_calls.length || message.function_call) throw new EndpointError('UNSUPPORTED_MODEL_OUTPUT', 0, telemetry);
    // Separate reasoning is intentionally neither parsed as commands nor returned.
    if (typeof message.content !== 'string' || !message.content.trim()) throw new EndpointError('INVALID_JSON', 0, telemetry);
    let content: unknown; try { content = JSON.parse(message.content); } catch { throw new EndpointError('INVALID_JSON', 0, telemetry); }
    return { content, ...telemetry };
  }
  async countInput(messages: EndpointMessages, mode: Exclude<OutputMode, 'unprobed'>, signal?: AbortSignal): Promise<number | undefined> {
    if (this.settings.providerProfile !== 'llama_cpp') return undefined;
    try { const value = await this.request('chat/completions/input_tokens', this.body(messages, mode, canonicalPlanSchema), signal); return plain(value) ? tokenCount(value.input_tokens) : undefined; }
    catch (error) { if (error instanceof EndpointError && ['MODEL_OR_ROUTE_UNAVAILABLE', 'REQUEST_UNSUPPORTED'].includes(error.code)) return undefined; throw error; }
  }
  async probe(listModels: boolean, signal?: AbortSignal): Promise<EndpointProbeResponse> {
    const deadline = AbortSignal.timeout(this.settings.timeoutSeconds * 1000);
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const started = performance.now(); let modelsStatus = 'NOT_REQUESTED', schemaStatus = 'NOT_TESTED';
    if (listModels) try { const models = await this.request('models', undefined, signal); modelsStatus = plain(models) && Array.isArray(models.data) ? 'AVAILABLE' : 'INVALID_RESPONSE'; } catch (error) { modelsStatus = safeCode(error, 'CONNECTION_FAILED'); }
    const messages = { system: 'Return only one JSON object. Do not use tools or include explanations.', user: 'Reply with exactly {"ok":true}.' }, schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', const: true } }, required: ['ok'] };
    let mode: Exclude<OutputMode, 'unprobed'> = 'schema';
    try {
      let result: CompletionResult;
      for (;;) {
        try { result = await this.complete(messages, mode, signal, schema, 64); if (mode === 'schema') schemaStatus = 'ACCEPTED'; break; }
        catch (error) {
          if (!(error instanceof EndpointError) || error.code !== 'REQUEST_UNSUPPORTED' || mode === 'prompt_json') throw error;
          schemaStatus = 'UNSUPPORTED'; mode = mode === 'schema' ? 'json_object' : 'prompt_json';
        }
      }
      if (!plain(result.content) || Object.keys(result.content).join(',') !== 'ok' || result.content.ok !== true) throw new EndpointError('INVALID_STRUCTURED_OUTPUT');
      return { success: true, status: 'ROUND_TRIP_OK', mode, schemaStatus, modelsStatus, roundTripMs: Math.round(performance.now() - started) };
    } catch (error) { return { success: false, status: safeCode(error, 'CONNECTION_FAILED'), mode: 'unprobed', schemaStatus, modelsStatus, roundTripMs: Math.round(performance.now() - started) }; }
  }
}
