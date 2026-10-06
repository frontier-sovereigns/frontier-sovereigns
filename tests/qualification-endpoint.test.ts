import { createServer, request as httpRequest, type RequestListener } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { validateAiPlan } from '@frontier/shared';
import { defaultEndpointSettings, EndpointClient } from '../apps/server/src/ai-endpoint.js';
import { createQualificationEndpoint, type QualificationEndpoint, type QualificationEndpointFailure } from '../scripts/qualification-endpoint.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
async function upstream(handler: RequestListener) {
  const server = createServer(handler); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function owned(options: Parameters<typeof createQualificationEndpoint>[0]) { const endpoint = await createQualificationEndpoint(options); cleanup.push(() => endpoint.close()); return endpoint; }
const input = (observationId = 'actual_dispatch_27') => ({ model: 'fixture-model', stream: false, messages: [{ role: 'user', content: JSON.stringify({ identity: { observationId }, memory: { summary: 'private observed field' } }) }] });
function call(endpoint: QualificationEndpoint, body: unknown = input(), suffix = '/chat/completions', headers: Record<string, string> = {}) {
  return fetch(endpoint.settings.baseUrl + suffix, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.apiKey}`, ...headers }, body: JSON.stringify(body) });
}
describe('owned qualification HTTP endpoint', () => {
  it('labels synthetic probing and binds empty plans to the actual observation without invented usage', async () => {
    const endpoint = await owned({ mode: 'mock', settings: { ...defaultEndpointSettings(), model: 'fixture-model' } });
    const client = new EndpointClient(endpoint.settings, endpoint.apiKey);
    expect((await client.probe(true)).success).toBe(true);
    const result = await client.complete({ system: 'Trusted test rules', user: input().messages[0]!.content }, 'schema');
    expect(validateAiPlan(result.content)).toBe(true); expect(result.content).toMatchObject({ observationId: 'actual_dispatch_27', goals: [], message: null });
    expect(result.promptTokens).toBeUndefined(); expect(result.completionTokens).toBeUndefined();
    expect(endpoint.diagnostics()).toMatchObject({ qualification: 'synthetic_only', syntheticProbes: 1, syntheticCompletions: 1, forwarded: 0 });
    expect((await call(endpoint, input('invalid whitespace'))).status).toBe(400);
  });
  it('forwards only the configured custom base and keeps upstream credentials out of client settings and diagnostics', async () => {
    const upstreamKey = 'private-upstream-test-key', seen: { path?: string; authorization?: string; body: string }[] = [];
    const baseUrl = await upstream(async (request, response) => { let body = ''; for await (const part of request) body += part.toString(); seen.push({ path: request.url, authorization: request.headers.authorization, body }); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true })); });
    const endpoint = await owned({ mode: 'real', settings: { ...defaultEndpointSettings(), baseUrl: `${baseUrl}/custom/prefix/v2/`, model: 'fixture-model' }, apiKey: upstreamKey });
    expect(endpoint.apiKey).not.toBe(upstreamKey); expect(endpoint.settings.baseUrl).not.toContain('/custom/');
    expect((await call(endpoint)).status).toBe(200); expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ path: '/custom/prefix/v2/chat/completions', authorization: `Bearer ${upstreamKey}`, body: JSON.stringify(input()) });
    const serialized = JSON.stringify(endpoint.diagnostics()); for (const secret of [upstreamKey, endpoint.apiKey, baseUrl, 'private observed field', 'actual_dispatch_27', 'fixture-model']) expect(serialized).not.toContain(secret);
    expect((await call(endpoint, input(), '/chat/completions', { Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call(endpoint, input(), '/chat/completions?redirect=https://example.invalid')).status).toBe(404);
    expect(seen).toHaveLength(1);
  });
  it('never follows upstream redirects or returns provider error bodies and secret headers', async () => {
    let redirected = 0; const target = await upstream((_request, response) => { redirected++; response.end('unexpected'); });
    const failures: QualificationEndpointFailure[] = []; let mode = 'redirect';
    const baseUrl = await upstream((_request, response) => { if (mode === 'redirect') { response.writeHead(307, { Location: `${target}/secret` }); response.end('private redirect details'); } else { response.writeHead(401, { 'Set-Cookie': 'secret=credential', 'X-Private': 'private-server-value' }); response.end('provider secret and prompt'); } });
    const endpoint = await owned({ mode: 'real', settings: { ...defaultEndpointSettings(), baseUrl, model: 'fixture-model' }, onFailure: failure => failures.push(failure) });
    const redirect = await call(endpoint); expect(redirect.status).toBe(502); expect(await redirect.json()).toEqual({ error: { code: 'REDIRECT_REJECTED' } }); expect(redirected).toBe(0);
    mode = 'error'; const error = await call(endpoint); expect(error.status).toBe(401); expect(await error.text()).not.toContain('provider secret'); expect(error.headers.get('set-cookie')).toBeNull(); expect(error.headers.get('x-private')).toBeNull();
    expect(failures).toEqual([{ code: 'REDIRECT_REJECTED', operation: 'chat/completions' }, { code: 'UPSTREAM_FAILURE', operation: 'chat/completions' }]);
  });
  it('enforces request and streamed response byte bounds', async () => {
    let requests = 0;
    const baseUrl = await upstream((_request, response) => { requests++; response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('x'.repeat(128 * 1024)); response.end('x'.repeat(128 * 1024 + 1)); });
    const endpoint = await owned({ mode: 'real', settings: { ...defaultEndpointSettings(), baseUrl, model: 'fixture-model' } });
    const oversized = await call(endpoint, { ...input(), padding: 'x'.repeat(64 * 1024) }); expect(oversized.status).toBe(413); expect(requests).toBe(0);
    const chunkedStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(endpoint.settings.baseUrl + '/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${endpoint.apiKey}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
      request.once('error', reject); request.write('x'.repeat(40000)); request.end('x'.repeat(40000));
    });
    expect(chunkedStatus).toBe(413); expect(requests).toBe(0);
    const response = await call(endpoint); expect(response.status).toBe(502); expect(await response.json()).toEqual({ error: { code: 'RESPONSE_LIMIT' } });
    expect(endpoint.diagnostics().failures).toMatchObject({ REQUEST_LIMIT: 2, RESPONSE_LIMIT: 1 });
  });
  it('owns its outage, cancels active forwarding, recovers, and closes idempotently', async () => {
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; }); let requests = 0;
    const baseUrl = await upstream((_request, response) => { requests++; if (requests === 1) { started(); return; } response.end('{"ok":true}'); });
    const endpoint = await owned({ mode: 'real', settings: { ...defaultEndpointSettings(), baseUrl, model: 'fixture-model', timeoutSeconds: 2 } });
    const pending = call(endpoint); await entered; endpoint.setOutage(true);
    const interrupted = await pending; expect(interrupted.status).toBe(503); expect(await interrupted.json()).toEqual({ error: { code: 'OUTAGE' } });
    expect((await call(endpoint)).status).toBe(503); expect(requests).toBe(1);
    endpoint.setOutage(false); expect((await call(endpoint)).status).toBe(200); expect(requests).toBe(2);
    expect(endpoint.diagnostics()).toMatchObject({ outageTransitions: 2, outageRejected: 2, active: 0 });
    await endpoint.close(); await endpoint.close(); expect(endpoint.diagnostics().closed).toBe(true);
    // The existing endpoint remains independently available after proxy cleanup.
    expect((await fetch(baseUrl)).status).toBe(200);
  });
  it('times out forwarding and reports missing real configuration before opening a listener', async () => {
    const failures: QualificationEndpointFailure[] = [];
    await expect(createQualificationEndpoint({ mode: 'real', settings: defaultEndpointSettings(), onFailure: failure => failures.push(failure) })).rejects.toThrow('QUALIFICATION_ENDPOINT_NOT_CONFIGURED');
    expect(failures).toEqual([{ code: 'QUALIFICATION_ENDPOINT_NOT_CONFIGURED', operation: 'request' }]);
    const baseUrl = await upstream(() => {}), endpoint = await owned({ mode: 'real', settings: { ...defaultEndpointSettings(), baseUrl, model: 'fixture-model', timeoutSeconds: 1 } });
    const response = await call(endpoint); expect(response.status).toBe(504); expect(await response.json()).toEqual({ error: { code: 'TIMEOUT' } }); expect(endpoint.diagnostics().active).toBe(0);
  });
});
