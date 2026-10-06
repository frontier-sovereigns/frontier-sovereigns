import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import { defaultEndpointSettings, endpointUrl, EndpointClient, EndpointConfiguration, EndpointError, MAX_ENDPOINT_RESPONSE_BYTES, normalizeEndpointSettings, providerSchema } from './ai-endpoint.js';

const root = resolve('runtime-data/endpoint-tests');
let directory: string | undefined, server: Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(done => server!.close(() => done())); server = undefined; }
  if (directory) { const child = relative(root, directory); if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('UNSAFE_TEST_CLEANUP'); await rm(directory, { recursive: true, force: true }); directory = undefined; }
});
const settings = () => ({ ...defaultEndpointSettings(), baseUrl: 'http://127.0.0.1:8080/custom/v1', model: 'local-model' });
const messages = { system: 'JSON only', user: 'safe observation' };
const completion = (content = '{"ok":true}', extra: Record<string, unknown> = {}) => ({ choices: [{ finish_reason: 'stop', message: { content, reasoning: 'private ignored reasoning' } }], ...extra });
const response = (body: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(body), { status, headers });
function mockFetch(respond: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch { return ((url, init) => respond(String(url), init ?? {})) as typeof fetch; }

describe('host endpoint boundary', () => {
  it('preserves custom prefixes and validates URLs and profile-specific extensions', () => {
    expect(endpointUrl(normalizeEndpointSettings({ ...settings(), baseUrl: 'http://localhost:8000/prefix/v1///' }).baseUrl, 'chat/completions')).toBe('http://localhost:8000/prefix/v1/chat/completions');
    for (const baseUrl of ['file:///secrets', 'http://user:secret@host/v1', 'http://host/v1?secret=1', 'http://host/#secret']) expect(() => normalizeEndpointSettings({ ...settings(), baseUrl })).toThrow('INVALID_ENDPOINT_URL');
    expect(() => normalizeEndpointSettings({ ...settings(), providerOptions: { top_k: 30 } })).toThrow('UNSUPPORTED_PROVIDER_OPTION');
    expect(normalizeEndpointSettings({ ...settings(), providerOptions: { reasoning_effort: 'none' } }).providerOptions).toEqual({ reasoning_effort: 'none' });
    expect(() => normalizeEndpointSettings({ ...settings(), providerOptions: { reasoning_effort: 'unbounded' } })).toThrow('INVALID_ENDPOINT_SETTINGS');
    expect(normalizeEndpointSettings({ ...settings(), providerProfile: 'llama_cpp', providerOptions: { top_k: 30, chat_template_kwargs: { enable_thinking: false } } }).providerProfile).toBe('llama_cpp');
    expect(() => normalizeEndpointSettings({ ...settings(), providerOptions: { messages: [] } })).toThrow('INVALID_ENDPOINT_SETTINGS');
  });
  it('writes credentials only to game-owned configuration; preserves and explicitly clears them', async () => {
    await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'config-'));
    const config = new EndpointConfiguration(directory); await config.load({});
    expect(config.state().configured).toBe(false); await config.update(settings(), 'private-test-key');
    expect(JSON.stringify(config.state())).not.toContain('private-test-key'); expect(config.state().hasApiKey).toBe(true);
    await config.update({ ...settings(), model: 'next-model' });
    const restored = new EndpointConfiguration(directory); await restored.load({ AI_API_KEY: 'wrong-environment-key' });
    expect(restored.snapshot().apiKey).toBe('private-test-key'); expect(restored.state().settings.model).toBe('next-model');
    await restored.update(settings(), null); expect(restored.state().hasApiKey).toBe(false);
    expect(JSON.parse(await readFile(join(directory, 'endpoint.local.json'), 'utf8')).apiKey).toBe('');
  });
  it('keeps corrupt or invalid configuration safely unconfigured without leaking its contents', async () => {
    await mkdir(root, { recursive: true }); directory = await mkdtemp(join(root, 'invalid-'));
    await writeFile(join(directory, 'endpoint.local.json'), '{secret-test');
    const config = new EndpointConfiguration(directory); await config.load({ AI_BASE_URL: settings().baseUrl, AI_MODEL: 'environment-model' });
    expect(config.state().configured).toBe(false); expect(config.state().capability.status).toBe('ENDPOINT_CONFIG_INVALID');
    const environmentConfig = new EndpointConfiguration(join(directory, 'missing')); await environmentConfig.load({ AI_TIMEOUT_SECONDS: 'NaN', AI_API_KEY: 'private' });
    expect(environmentConfig.state().configured).toBe(false); expect(JSON.stringify(environmentConfig.state())).not.toContain('private');
  });
  it('inlines the canonical schema and parses final content while ignoring separate reasoning', async () => {
    const schema = JSON.stringify(providerSchema()); expect(schema).not.toContain('$ref'); expect(schema).not.toContain('oneOf'); expect(schema).toContain('anyOf');
    const client = new EndpointClient(settings(), 'secret', mockFetch((url, init) => {
      expect(url).toBe('http://127.0.0.1:8080/custom/v1/chat/completions'); expect(init.redirect).toBe('manual');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
      expect(JSON.parse(String(init.body)).response_format.type).toBe('json_schema');
      return response(completion('{"ok":true}', { usage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131 }, timings: { prompt_ms: 12, predicted_ms: 25 } }));
    }));
    const result = await client.complete(messages, 'schema'); expect(result.content).toEqual({ ok: true }); expect(result.promptTokens).toBe(123); expect(result.prefillMs).toBe(12); expect(JSON.stringify(result)).not.toContain('reasoning');
  });
  it('probes optional model listing and falls back once when schema mode is unsupported', async () => {
    let completions = 0;
    const client = new EndpointClient(settings(), '', mockFetch((url, init) => {
      if (url.endsWith('/models')) return response({}, 404);
      completions++; const body = JSON.parse(String(init.body));
      if (body.response_format.type === 'json_schema') return response({ error: 'unsupported' }, 400);
      expect(body.response_format).toEqual({ type: 'json_object' }); return response(completion());
    }));
    expect(await client.probe(true)).toMatchObject({ success: true, mode: 'json_object', schemaStatus: 'UNSUPPORTED', modelsStatus: 'MODEL_OR_ROUTE_UNAVAILABLE' }); expect(completions).toBe(2);
  });
  it('reports prompted JSON when the endpoint rejects both constrained request formats', async () => {
    const formats:string[]=[];
    const client=new EndpointClient({...settings(),providerOptions:{reasoning_effort:'none'}},'',mockFetch((_url,init)=>{
      const body=JSON.parse(String(init.body));formats.push(body.response_format?.type??'prompt_json');
      expect(body.reasoning_effort).toBe('none');expect(body.max_tokens).toBe(64);
      if(body.response_format)return response({error:'no constrained decoding'},400);
      expect(Object.hasOwn(body,'response_format')).toBe(false);return response(completion());
    }));
    expect(await client.probe(false)).toMatchObject({success:true,mode:'prompt_json',schemaStatus:'UNSUPPORTED'});
    expect(formats).toEqual(['json_schema','json_object','prompt_json']);
  });
  it('does not downgrade malformed model output and still rejects invalid prompted JSON', async () => {
    let calls=0;const client=new EndpointClient(settings(),'',mockFetch(()=>{calls++;return response(completion('not JSON'));}));
    expect(await client.probe(false)).toMatchObject({success:false,status:'INVALID_JSON',mode:'unprobed'});expect(calls).toBe(1);
    await expect(client.complete(messages,'prompt_json')).rejects.toMatchObject({code:'INVALID_JSON'});expect(calls).toBe(2);
  });
  it.each([[401, 'UNAUTHORIZED'], [404, 'MODEL_OR_ROUTE_UNAVAILABLE'], [429, 'RATE_LIMITED'], [500, 'ENDPOINT_FAILURE'], [302, 'REDIRECT_REJECTED']] as const)('returns safe status for HTTP %i without endpoint error text', async (status, code) => {
    const client = new EndpointClient(settings(), '', mockFetch(() => response({ error: 'secret provider text' }, status, { 'retry-after': '5' })));
    await expect(client.complete(messages, 'schema')).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfterMs: 5000 } : {}) });
  });
  it('rejects oversized, truncated, malformed, tool-call and reasoning-only responses', async () => {
    const cases: [unknown, string][] = [
      [{ padding: 'x'.repeat(MAX_ENDPOINT_RESPONSE_BYTES) }, 'RESPONSE_TOO_LARGE'],
      [{ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'OUTPUT_TRUNCATED'],
      [completion('```json\n{}\n```'), 'INVALID_JSON'],
      [{ choices: [{ message: { content: '{}', tool_calls: [{ name: 'execute' }] } }] }, 'UNSUPPORTED_MODEL_OUTPUT'],
      [{ choices: [{ message: { reasoning: '{}' } }] }, 'INVALID_JSON'],
    ];
    for (const [body, code] of cases) await expect(new EndpointClient(settings(), '', mockFetch(() => response(body))).complete(messages, 'schema')).rejects.toMatchObject({ code });
  });
  it('retains only safe numeric telemetry when final content is rejected', async () => {
    const secret = 'private provider response, reasoning, or credential';
    const cases: [Record<string, unknown>, string][] = [
      [{ finish_reason: 'length', message: { content: secret } }, 'OUTPUT_TRUNCATED'],
      [{ message: { content: secret } }, 'INVALID_JSON'],
      [{ message: { content: ' ', reasoning: secret } }, 'INVALID_JSON'],
      [{ message: { reasoning: secret } }, 'INVALID_JSON'],
      [{ message: { content: '{}', refusal: secret } }, 'UNSUPPORTED_MODEL_OUTPUT'],
      [{ message: { content: '{}', tool_calls: [{ arguments: secret }] } }, 'UNSUPPORTED_MODEL_OUTPUT'],
      [{ message: { content: '{}', function_call: { arguments: secret } } }, 'UNSUPPORTED_MODEL_OUTPUT'],
    ];
    for (const [choice, code] of cases) {
      const body = { choices: [choice], usage: { prompt_tokens: 123, completion_tokens: 8, total_tokens: 131, secret }, timings: { prompt_ms: 12, predicted_ms: 25, secret }, error: secret };
      const error = await new EndpointClient(settings(), secret, mockFetch(() => response(body))).complete(messages, 'prompt_json').catch((value: unknown) => value);
      expect(error).toBeInstanceOf(EndpointError);
      expect(error).toMatchObject({ code, completionTelemetry: { promptTokens: 123, completionTokens: 8, totalTokens: 131, prefillMs: 12, generationMs: 25 } });
      const telemetry = (error as EndpointError).completionTelemetry!;
      expect(telemetry.latencyMs).toBeGreaterThanOrEqual(0); expect(Object.values(telemetry).every(value => typeof value === 'number' && Number.isFinite(value))).toBe(true);
      expect(Object.keys(telemetry).sort()).toEqual(['completionTokens', 'generationMs', 'latencyMs', 'prefillMs', 'promptTokens', 'totalTokens']);
      expect(JSON.stringify(error)).not.toContain(secret); expect((error as Error).message).toBe(code);
    }
  });
  it('uses the same bounded numeric sanitization for accepted and rejected completions', async () => {
    const cases = [
      { usage: { prompt_tokens: 0, completion_tokens: 10000000, total_tokens: 10000000 }, timings: { prompt_ms: 0, predicted_ms: 3600000 }, expected: { promptTokens: 0, completionTokens: 10000000, totalTokens: 10000000, prefillMs: 0, generationMs: 3600000 } },
      { usage: { prompt_tokens: '123', completion_tokens: -1, total_tokens: 10000001 }, timings: { prompt_ms: '12', predicted_ms: 3600001 }, expected: { promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, prefillMs: undefined, generationMs: undefined } },
      { usage: { prompt_tokens: 1.5, completion_tokens: null, total_tokens: Number.MAX_SAFE_INTEGER + 1 }, timings: { prompt_ms: -1, predicted_ms: null }, expected: { promptTokens: undefined, completionTokens: undefined, totalTokens: undefined, prefillMs: undefined, generationMs: undefined } },
      { usage: { prompt_tokens: 10 }, timings: {}, expected: { promptTokens: 10, completionTokens: undefined, totalTokens: undefined, prefillMs: undefined, generationMs: undefined } },
    ];
    for (const value of cases) {
      for (const rejected of [false, true]) {
        const body = completion(rejected ? 'not JSON' : '{}', { usage: value.usage, timings: value.timings });
        const result = await new EndpointClient(settings(), '', mockFetch(() => response(body))).complete(messages, 'schema').catch((error: EndpointError) => error);
        expect(result instanceof EndpointError).toBe(rejected);
        expect(result instanceof EndpointError ? result.completionTelemetry : result).toMatchObject(value.expected);
      }
    }
  });
  it('does not attribute usage to transport failures or unrecognized response envelopes', async () => {
    const cases: [typeof fetch, string][] = [
      [mockFetch(() => { throw new Error('private transport error'); }), 'CONNECTION_FAILED'],
      [mockFetch(() => response(completion('{}', { usage: { prompt_tokens: 100 } }), 500)), 'ENDPOINT_FAILURE'],
      [mockFetch(() => new Response('{invalid outer JSON')), 'INVALID_JSON'],
      [mockFetch(() => response({ choices: [], usage: { prompt_tokens: 100 } })), 'INVALID_ENDPOINT_RESPONSE'],
    ];
    for (const [fetcher, code] of cases) {
      const result = await new EndpointClient(settings(), '', fetcher).complete(messages, 'schema').catch((error: EndpointError) => error);
      expect(result).toBeInstanceOf(EndpointError); expect(result).toMatchObject({ code });
      expect((result as EndpointError).completionTelemetry).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('private');
    }
  });
  it('uses the llama input-token route and tolerates unsupported tokenization honestly', async () => {
    const client = new EndpointClient({ ...settings(), providerProfile: 'llama_cpp' }, '', mockFetch((url, init) => {
      expect(url.endsWith('/chat/completions/input_tokens')).toBe(true); expect(JSON.parse(String(init.body)).response_format.schema).toBeDefined(); return response({ input_tokens: 2001 });
    })); expect(await client.countInput(messages, 'schema')).toBe(2001);
    expect(await new EndpointClient({ ...settings(), providerProfile: 'llama_cpp' }, '', mockFetch(() => response({}, 404))).countInput(messages, 'schema')).toBeUndefined();
  });
  it('enforces one overall probe deadline across real HTTP operations and supports cancellation', async () => {
    let requests = 0;
    server = createServer((_request, reply) => { requests++; setTimeout(() => { if (!reply.destroyed) { reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(requests === 1 ? { data: [] } : completion())); } }, 650); });
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done)); const address = server.address() as { port: number };
    const client = new EndpointClient({ ...settings(), baseUrl: `http://127.0.0.1:${address.port}/prefix`, timeoutSeconds: 1 });
    const started = performance.now(), result = await client.probe(true); expect(result.status).toBe('TIMEOUT'); expect(result.success).toBe(false); expect(performance.now() - started).toBeLessThan(1600);
    const controller = new AbortController(); controller.abort(); await expect(client.complete(messages, 'schema', controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
