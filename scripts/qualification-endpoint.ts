import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { EndpointSettings } from '@frontier/shared';
import { endpointUrl, MAX_ENDPOINT_BODY_BYTES, MAX_ENDPOINT_RESPONSE_BYTES, normalizeEndpointSettings } from '../apps/server/src/ai-endpoint.js';

type Operation = 'models' | 'chat/completions' | 'chat/completions/input_tokens' | 'request';
type FailureCode = 'QUALIFICATION_ENDPOINT_NOT_CONFIGURED' | 'INVALID_SETTINGS' | 'INVALID_KEY' | 'UNAUTHORIZED' | 'INVALID_ROUTE' | 'METHOD_NOT_ALLOWED' | 'REQUEST_LIMIT' | 'INVALID_REQUEST' | 'BUSY' | 'OUTAGE' | 'CLOSED' | 'TIMEOUT' | 'CLIENT_DISCONNECTED' | 'REDIRECT_REJECTED' | 'UPSTREAM_FAILURE' | 'RESPONSE_LIMIT' | 'CONNECTION_FAILED';
export interface QualificationEndpointFailure { code: FailureCode; operation: Operation }
export class QualificationEndpointError extends Error { constructor(readonly code: FailureCode) { super(code); } }
export interface QualificationEndpointOptions {
  mode: 'mock' | 'real'; settings: EndpointSettings; apiKey?: string;
  /** Codes only: never forward an Error.message, URL, prompt or provider body here. */
  onFailure?: (failure: QualificationEndpointFailure) => void;
}
export interface QualificationEndpointDiagnostics {
  mode: 'mock' | 'real'; qualification: 'synthetic_only' | 'forwarded_existing_endpoint'; outage: boolean; closed: boolean;
  requests: number; completed: number; forwarded: number; syntheticCompletions: number; syntheticProbes: number;
  active: number; peakActive: number; requestBytes: number; responseBytes: number;
  outageTransitions: number; outageRejected: number; unauthorized: number; failures: Partial<Record<FailureCode, number>>;
}
export interface QualificationEndpoint {
  settings: EndpointSettings;
  /** A fresh local proxy credential, not the upstream API key. */
  apiKey: string;
  setOutage(outage: boolean): void;
  diagnostics(): QualificationEndpointDiagnostics;
  close(): Promise<void>;
}
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const increment = (value: number, amount = 1) => Math.min(Number.MAX_SAFE_INTEGER, value + amount);

/** Test-runner infrastructure only. It never alters a model server, environment or product configuration. */
export async function createQualificationEndpoint(options: QualificationEndpointOptions): Promise<QualificationEndpoint> {
  const mode = options.mode, onFailure = options.onFailure;
  const report = (code: FailureCode, operation: Operation) => { try { onFailure?.({ code, operation }); } catch { /* A metrics callback must not break cleanup or request isolation. */ } };
  let original: EndpointSettings;
  try { original = normalizeEndpointSettings(options.settings); } catch { report('INVALID_SETTINGS', 'request'); throw new QualificationEndpointError('INVALID_SETTINGS'); }
  if (!['mock', 'real'].includes(mode)) { report('INVALID_SETTINGS', 'request'); throw new QualificationEndpointError('INVALID_SETTINGS'); }
  if (options.apiKey !== undefined && (typeof options.apiKey !== 'string' || options.apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(options.apiKey))) { report('INVALID_KEY', 'request'); throw new QualificationEndpointError('INVALID_KEY'); }
  if (mode === 'real' && (!original.baseUrl || !original.model || original.model === 'replace-with-your-served-model-id')) {
    report('QUALIFICATION_ENDPOINT_NOT_CONFIGURED', 'request'); throw new QualificationEndpointError('QUALIFICATION_ENDPOINT_NOT_CONFIGURED');
  }
  const upstreamKey = options.apiKey ?? '', proxyKey = randomBytes(32).toString('base64url'), authorization = Buffer.from(`Bearer ${proxyKey}`);
  const prefix = `/qualification/${randomBytes(16).toString('hex')}/v1`, controllers = new Set<AbortController>(), sockets = new Set<Socket>();
  let outage = false, closed = false, closing: Promise<void> | undefined;
  const stats: QualificationEndpointDiagnostics = { mode, qualification: mode === 'mock' ? 'synthetic_only' : 'forwarded_existing_endpoint', outage, closed,
    requests: 0, completed: 0, forwarded: 0, syntheticCompletions: 0, syntheticProbes: 0, active: 0, peakActive: 0, requestBytes: 0, responseBytes: 0, outageTransitions: 0, outageRejected: 0, unauthorized: 0, failures: {} };
  const fail = (code: FailureCode, operation: Operation) => { stats.failures[code] = increment(stats.failures[code] ?? 0); report(code, operation); };
  function reply(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
    if (response.destroyed || response.writableEnded) return;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'Connection': 'close', ...extra });
    stats.responseBytes = increment(stats.responseBytes, bytes.length); response.end(bytes);
  }
  function reject(response: ServerResponse, code: FailureCode, operation: Operation, status: number): void {
    fail(code, operation); if (code === 'OUTAGE') stats.outageRejected = increment(stats.outageRejected);
    if (code === 'UNAUTHORIZED') stats.unauthorized = increment(stats.unauthorized);
    reply(response, status, { error: { code } }, code === 'OUTAGE' ? { 'Retry-After': '1' } : {});
  }
  function readBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, rejectBody) => {
      const parts: Buffer[] = []; let bytes = 0, done = false;
      const cleanup = () => { request.removeListener('data', data); request.removeListener('end', end); request.removeListener('error', error); signal.removeEventListener('abort', abort); };
      const finish = (error?: QualificationEndpointError) => { if (done) return; done = true; cleanup(); if (error) { request.resume(); rejectBody(error); } else resolve(Buffer.concat(parts, bytes)); };
      const data = (part: Buffer) => { bytes += part.length; stats.requestBytes = increment(stats.requestBytes, part.length); if (bytes > MAX_ENDPOINT_BODY_BYTES) finish(new QualificationEndpointError('REQUEST_LIMIT')); else parts.push(part); };
      const end = () => finish(), error = () => finish(new QualificationEndpointError('CLIENT_DISCONNECTED'));
      const abort = () => finish(signal.reason instanceof QualificationEndpointError ? signal.reason : new QualificationEndpointError(closed ? 'CLOSED' : outage ? 'OUTAGE' : 'TIMEOUT'));
      request.on('data', data); request.once('end', end); request.once('error', error); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: (original.timeoutSeconds + 2) * 1000, headersTimeout: Math.min(5000, (original.timeoutSeconds + 2) * 1000) }, (request, response) => {
    void handle(request, response).catch(() => reject(response, 'CONNECTION_FAILED', 'request', 502));
  });
  server.maxConnections = 16; server.keepAliveTimeout = 1000;
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); else socket.destroy(); });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    stats.requests = increment(stats.requests);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) { reject(response, 'UNAUTHORIZED', 'request', 401); return; }
    const route = request.url, operation: Operation = route === `${prefix}/models` ? 'models' : route === `${prefix}/chat/completions` ? 'chat/completions' : route === `${prefix}/chat/completions/input_tokens` ? 'chat/completions/input_tokens' : 'request';
    if (operation === 'request') { reject(response, 'INVALID_ROUTE', operation, 404); return; }
    if (request.method !== (operation === 'models' ? 'GET' : 'POST')) { reject(response, 'METHOD_NOT_ALLOWED', operation, 405); return; }
    if (closed || outage) { reject(response, closed ? 'CLOSED' : 'OUTAGE', operation, 503); return; }
    if (controllers.size >= original.maxConcurrent + 2) { reject(response, 'BUSY', operation, 429); return; }
    if (Number(request.headers['content-length'] ?? 0) > MAX_ENDPOINT_BODY_BYTES) { reject(response, 'REQUEST_LIMIT', operation, 413); return; }
    const controller = new AbortController(); controllers.add(controller); stats.active = controllers.size; stats.peakActive = Math.max(stats.peakActive, stats.active);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(new QualificationEndpointError('TIMEOUT')); }, original.timeoutSeconds * 1000); timer.unref();
    const disconnected = () => { if (!response.writableEnded) controller.abort(new QualificationEndpointError('CLIENT_DISCONNECTED')); }; response.once('close', disconnected);
    try {
      const bytes = operation === 'models' ? undefined : await readBody(request, controller.signal);
      let body: unknown;
      if (bytes) { try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new QualificationEndpointError('INVALID_REQUEST'); }
        if (!plain(body) || body.model !== (original.model || 'qualification-synthetic') || body.stream !== false) throw new QualificationEndpointError('INVALID_REQUEST'); }
      if (controller.signal.aborted) throw new QualificationEndpointError(closed ? 'CLOSED' : outage ? 'OUTAGE' : timedOut ? 'TIMEOUT' : 'CLIENT_DISCONNECTED');
      if (mode === 'mock') {
        if (operation === 'models') { reply(response, 200, { object: 'list', data: [{ id: original.model || 'qualification-synthetic', object: 'model', owned_by: 'qualification-synthetic' }] }); stats.completed = increment(stats.completed); return; }
        // Unsupported token counting is explicit; the adapter uses its labeled estimate.
        if (operation === 'chat/completions/input_tokens') { reply(response, 404, { error: { code: 'SYNTHETIC_TOKENIZER_UNAVAILABLE' } }); return; }
        if (!plain(body) || !Array.isArray(body.messages)) throw new QualificationEndpointError('INVALID_REQUEST');
        const users = body.messages.filter(message => plain(message) && message.role === 'user');
        if (users.length !== 1 || !plain(users[0]) || typeof users[0].content !== 'string') throw new QualificationEndpointError('INVALID_REQUEST');
        let content: unknown;
        if (users[0].content === 'Reply with exactly {"ok":true}.') { content = { ok: true }; stats.syntheticProbes = increment(stats.syntheticProbes); }
        else {
          let observation: unknown; try { observation = JSON.parse(users[0].content); } catch { throw new QualificationEndpointError('INVALID_REQUEST'); }
          if (!plain(observation) || !plain(observation.identity) || typeof observation.identity.observationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(observation.identity.observationId)) throw new QualificationEndpointError('INVALID_REQUEST');
          content = { schemaVersion: 1, observationId: observation.identity.observationId, strategy: 'Synthetic qualification response: retain rule-based tactical behavior.', goals: [], message: null };
          stats.syntheticCompletions = increment(stats.syntheticCompletions);
        }
        reply(response, 200, { id: 'qualification_synthetic', object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
        stats.completed = increment(stats.completed); return;
      }
      stats.forwarded = increment(stats.forwarded);
      const upstream = await fetch(endpointUrl(original.baseUrl, operation), { method: operation === 'models' ? 'GET' : 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(upstreamKey ? { Authorization: `Bearer ${upstreamKey}` } : {}) }, ...(bytes ? { body: new Uint8Array(bytes) } : {}) });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel().catch(() => {}); throw new QualificationEndpointError('REDIRECT_REJECTED'); }
      if (!upstream.ok) {
        await upstream.body?.cancel().catch(() => {}); fail('UPSTREAM_FAILURE', operation);
        const retry = Number(upstream.headers.get('retry-after'));
        reply(response, upstream.status, { error: { code: 'UPSTREAM_FAILURE' } }, Number.isFinite(retry) && retry >= 0 ? { 'Retry-After': String(Math.min(120, retry)) } : {}); return;
      }
      if (Number(upstream.headers.get('content-length') ?? 0) > MAX_ENDPOINT_RESPONSE_BYTES) { await upstream.body?.cancel().catch(() => {}); throw new QualificationEndpointError('RESPONSE_LIMIT'); }
      const chunks: Uint8Array[] = []; let length = 0;
      if (upstream.body) {
        const reader = upstream.body.getReader();
        for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > MAX_ENDPOINT_RESPONSE_BYTES) { await reader.cancel().catch(() => {}); throw new QualificationEndpointError('RESPONSE_LIMIT'); } chunks.push(part.value); }
      }
      if (controller.signal.aborted) throw new QualificationEndpointError(closed ? 'CLOSED' : outage ? 'OUTAGE' : timedOut ? 'TIMEOUT' : 'CLIENT_DISCONNECTED');
      reply(response, upstream.status, Buffer.concat(chunks, length)); stats.completed = increment(stats.completed);
    } catch (error) {
      const code: FailureCode = controller.signal.reason instanceof QualificationEndpointError ? controller.signal.reason.code : closed ? 'CLOSED' : outage ? 'OUTAGE' : timedOut ? 'TIMEOUT' : error instanceof QualificationEndpointError ? error.code : controller.signal.aborted ? 'CLIENT_DISCONNECTED' : 'CONNECTION_FAILED';
      reject(response, code, operation, code === 'OUTAGE' || code === 'CLOSED' ? 503 : code === 'TIMEOUT' ? 504 : code === 'REQUEST_LIMIT' ? 413 : code === 'INVALID_REQUEST' ? 400 : 502);
    } finally { clearTimeout(timer); response.removeListener('close', disconnected); controllers.delete(controller); stats.active = controllers.size; }
  }
  await new Promise<void>((resolve, rejectListen) => { server.once('error', rejectListen); server.listen(0, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') { server.close(); throw new QualificationEndpointError('CONNECTION_FAILED'); }
  const settings = structuredClone(original); settings.baseUrl = `http://127.0.0.1:${address.port}${prefix}`; if (!settings.model) settings.model = 'qualification-synthetic';
  return {
    settings, apiKey: proxyKey,
    setOutage(value) { if (closed || outage === value) return; outage = value; stats.outage = outage; stats.outageTransitions = increment(stats.outageTransitions); if (outage) for (const controller of controllers) controller.abort(new QualificationEndpointError('OUTAGE')); },
    diagnostics() { return structuredClone({ ...stats, outage, closed, active: controllers.size }); },
    close() {
      if (closing) return closing;
      closed = true; stats.closed = true;
      for (const controller of controllers) controller.abort(new QualificationEndpointError('CLOSED'));
      closing = new Promise<void>((resolve, rejectClose) => { server.close(error => error ? rejectClose(new QualificationEndpointError('CONNECTION_FAILED')) : resolve()); for (const socket of sockets) socket.destroy(); });
      return closing;
    },
  };
}
