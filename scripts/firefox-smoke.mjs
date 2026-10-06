import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';

// Stock Firefox's direct BiDi endpoint; no Playwright-patched browser, geckodriver,
// downloads, user profile, graphics preferences, or model configuration involved.
// Build first. The default --plan does not launch anything.
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const args = process.argv.slice(2);
if (args.length > 2 || args.filter(value => ['--run', '--plan'].includes(value)).length > 1 || args.some(value => !['--run', '--plan'].includes(value) && !value.startsWith('--firefox='))) throw new Error('USAGE: node scripts/firefox-smoke.mjs [--run|--plan] [--firefox=ABSOLUTE_PATH]');
const run = args.includes('--run');
const firefox = args.find(value => value.startsWith('--firefox='))?.slice('--firefox='.length) ?? (process.platform === 'win32' ? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' : process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : '/usr/bin/firefox');
if (!isAbsolute(firefox)) throw new Error('FIREFOX_ABSOLUTE_PATH_REQUIRED');
const inside = (parent, child) => { const value = relative(parent, child); return value !== '' && !isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const emit = (event, detail = {}) => process.stdout.write(JSON.stringify({ event, ...detail }) + '\n');
const references = [
  'https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection',
  'https://firefox-source-docs.mozilla.org/browser/CommandLineParameters.html',
  'https://firefox-source-docs.mozilla.org/remote/Security.html',
  'https://bugzilla.mozilla.org/show_bug.cgi?id=2036597',
];
if (!run) {
  emit('firefox_smoke_plan', { firefox, productionEntry: 'dist/server/index.js', viewport: { width: 1440, height: 900 }, mode: 'stock_headless', checks: ['production_CSP', 'WebGL2_without_WebGPU', 'rendered_camera_rotation_and_Home', 'context_loss_and_recovery', 'missing_WebGL2_explanation', 'owned_graceful_cleanup'], references });
  process.exit(0);
}

const abort = new AbortController(), started = performance.now();
const deadline = setTimeout(() => abort.abort(new Error('OVERALL_DEADLINE')), 180_000);
const interrupt = () => abort.abort(new Error('INTERRUPTED'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
const report = {
  schemaVersion: 1, scope: 'Stock Firefox production lobby WebGL2/camera/capability smoke; no gameplay, multiplayer, or performance qualification',
  startedAt: new Date().toISOString(), nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch,
  mode: 'stock_headless', graphicsOverrides: [], references, checks: {}, screenshots: [], errors: [], consoleErrors: [], cleanup: {},
};
const artifactId = `firefox-${Date.now()}-${randomBytes(4).toString('hex')}`;
const artifactDirectory = join(root, 'runtime-data', 'e2e', artifactId);
const temporaryParent = await realpath(tmpdir());
let temporaryRoot, ownedRoot, ownership, bootstrapToken, server, browser, bidi, currentContext;
const contexts = new Map();
const safeText = value => {
  let text = String(value ?? '').slice(0, 2000);
  for (const secret of [ownership, bootstrapToken, ownedRoot]) if (secret) text = text.split(secret).join('[redacted]');
  return text.slice(0, 1000);
};
const checkAbort = () => { if (abort.signal.aborted) throw abort.signal.reason; };

function child(executable, arguments_, options) {
  const process_ = spawn(executable, arguments_, { ...options, windowsHide: true });
  const state = { process: process_, result: undefined, ended: undefined };
  state.ended = new Promise(resolveExit => {
    process_.once('error', () => { state.result = { code: null, error: 'SPAWN_FAILED' }; resolveExit(state.result); });
    process_.once('close', (code, signal) => { state.result = { code, signal }; resolveExit(state.result); });
  });
  return state;
}

async function waitUntil(test, code, timeoutMs = 15_000) {
  const limit = performance.now() + timeoutMs;
  do { checkAbort(); const result = await test(); if (result) return result; await delay(150, undefined, { signal: abort.signal }); } while (performance.now() < limit);
  throw new Error(code);
}

async function ownedFetch(origin, path) {
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]) });
  const parts = []; let bytes = 0;
  for await (const part of response.body ?? []) { bytes += part.length; if (bytes > 2 * 1024 * 1024) throw new Error('HTTP_BODY_LIMIT'); parts.push(part); }
  return { response, bytes: Buffer.concat(parts, bytes) };
}

async function connectBidi(url) {
  const socket = new WebSocket(url, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10_000 });
  let nextId = 0; const pending = new Map();
  const rejectPending = () => { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('BIDI_DISCONNECTED')); } pending.clear(); };
  socket.on('error', rejectPending); socket.on('close', rejectPending);
  socket.on('message', bytes => {
    let message; try { message = JSON.parse(bytes.toString()); } catch { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.type === 'success') entry.resolve(message.result);
      else { report.lastProtocolError = { method: entry.method, error: safeText(message.error) }; entry.reject(new Error('BIDI_COMMAND_FAILED')); }
    } else if (message.method === 'log.entryAdded') {
      const value = message.params, phase = contexts.get(value.source?.context) ?? 'browser';
      const target = value.type === 'javascript' ? report.errors : value.level === 'error' ? report.consoleErrors : undefined;
      if (target && target.length < 64) target.push({ phase, level: value.level, text: safeText(value.text) });
    }
  });
  await new Promise((resolveOpen, reject) => {
    const cancel = () => { socket.terminate(); reject(abort.signal.reason); };
    abort.signal.addEventListener('abort', cancel, { once: true });
    socket.once('open', () => { abort.signal.removeEventListener('abort', cancel); resolveOpen(); });
    socket.once('error', () => { abort.signal.removeEventListener('abort', cancel); reject(new Error('BIDI_CONNECTION_FAILED')); });
  });
  const rpc = (method, params = {}, cleanup = false) => new Promise((resolveCommand, reject) => {
    if (!cleanup) { try { checkAbort(); } catch (error) { reject(error); return; } }
    if (socket.readyState !== WebSocket.OPEN) { reject(new Error('BIDI_DISCONNECTED')); return; }
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('BIDI_COMMAND_TIMEOUT')); }, cleanup ? 5000 : 20_000);
    pending.set(id, { resolve: resolveCommand, reject, timer, method });
    socket.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('BIDI_SEND_FAILED')); } });
  });
  return { rpc, close: () => { socket.terminate(); rejectPending(); } };
}

async function evaluate(context, expression) {
  const response = await bidi.rpc('script.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`, target: { context }, awaitPromise: true, resultOwnership: 'none' });
  if (response.type !== 'success' || response.result?.type !== 'string') {
    report.lastScriptError = safeText(response.exceptionDetails?.text ?? response.type);
    throw new Error('BIDI_SCRIPT_FAILED');
  }
  return JSON.parse(response.result.value);
}

async function screenshot(context, name) {
  const result = await bidi.rpc('browsingContext.captureScreenshot', { context, origin: 'viewport', format: { type: 'image/png' } });
  if (typeof result.data !== 'string' || result.data.length > 12 * 1024 * 1024) throw new Error('SCREENSHOT_INVALID');
  const bytes = Buffer.from(result.data, 'base64');
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('SCREENSHOT_INVALID');
  await writeFile(join(artifactDirectory, `${name}.png`), bytes);
  report.screenshots.push({ file: `${name}.png`, bytes: bytes.length, sha256: hash(bytes) });
}

const pixelExpression = `(async () => {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const world = document.querySelector('[data-testid="world-canvas"]');
  if (!world) throw new Error('WORLD_CANVAS_MISSING');
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96;
  const context = canvas.getContext('2d'); context.drawImage(world, 0, 0, 128, 96);
  return Array.from(context.getImageData(0, 0, 128, 96).data);
})()`;
function comparePixels(before, after) {
  if (!Array.isArray(before) || before.length !== 128 * 96 * 4 || after.length !== before.length) throw new Error('PIXEL_SAMPLE_INVALID');
  let changed = 0;
  for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 45) changed++;
  return changed / (before.length / 4);
}
function pixelEvidence(pixels) {
  if (!Array.isArray(pixels) || pixels.length !== 128 * 96 * 4) throw new Error('PIXEL_SAMPLE_INVALID');
  let opaque = 0; const colors = new Set();
  for (let i = 0; i < pixels.length; i += 4) { if (pixels[i + 3] > 0 && pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) opaque++; colors.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`); }
  return { coloredPixelFraction: opaque / (pixels.length / 4), quantizedColors: colors.size, sha256: hash(Buffer.from(pixels)) };
}
async function home(context) {
  await bidi.rpc('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: '\uE011' }, { type: 'keyUp', value: '\uE011' }] }] });
}
async function newContext(phase, preload) {
  const { context } = await bidi.rpc('browsingContext.create', { type: 'tab' });
  contexts.set(context, phase); currentContext = context;
  await bidi.rpc('browsingContext.setViewport', { context, viewport: { width: 1440, height: 900 }, devicePixelRatio: 1 });
  if (preload) await bidi.rpc('script.addPreloadScript', { contexts: [context], functionDeclaration: preload });
  return context;
}

async function forceOwnedExit(state) {
  if (!state || state.result || state.process.exitCode !== null || state.process.signalCode !== null || !Number.isSafeInteger(state.process.pid) || state.process.pid <= 0) return;
  // Only the still-owned ChildProcess PID, never an executable/process-name kill.
  if (process.platform === 'win32') {
    const killer = child(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(state.process.pid), '/T', '/F'], { stdio: 'ignore' });
    await Promise.race([killer.ended, delay(5000)]);
  } else state.process.kill('SIGKILL');
  await Promise.race([state.ended, delay(5000)]);
}
async function cleanup() {
  if (browser && !browser.result) {
    try { await bidi?.rpc('browser.close', {}, true); } catch { /* actual process exit below decides success */ }
    const result = await Promise.race([browser.ended, delay(10_000).then(() => undefined)]);
    report.cleanup.browserGraceful = result?.code === 0;
    if (!result) await forceOwnedExit(browser);
  } else if (browser) report.cleanup.browserGraceful = browser.result.code === 0;
  bidi?.close();
  if (server && !server.result) {
    try { if (server.process.connected) server.process.send({ type: 'frontier-firefox-stop', ownership }, () => undefined); } catch { /* await actual exit, otherwise stop only this owned child */ }
    const result = await Promise.race([server.ended, delay(10_000).then(() => undefined)]);
    report.cleanup.serverGraceful = result?.code === 0;
    if (!result) await forceOwnedExit(server);
  } else if (server) report.cleanup.serverGraceful = server.result.code === 0;
  if (browser && !browser.result || server && !server.result) throw new Error('OWNED_PROCESS_SHUTDOWN_FAILED');
  if (ownedRoot) {
    const target = await realpath(temporaryRoot);
    if (target !== ownedRoot || !inside(temporaryParent, target) || inside(root, target) || inside(target, root) || (await lstat(temporaryRoot)).isSymbolicLink() || await readFile(join(target, '.firefox-smoke-owner'), 'utf8') !== ownership) throw new Error('TEMP_CLEANUP_REFUSED');
    await rm(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    report.cleanup.temporaryDirectoryRemoved = true;
  }
}

try {
  await mkdir(artifactDirectory, { recursive: true });
  const binary = await realpath(firefox);
  if (!(await lstat(binary)).isFile()) throw new Error('FIREFOX_BINARY_MISSING');
  // Read installed metadata, not the user's profile or an assumed release number.
  try {
    const metadata = await readFile(join(dirname(binary), 'application.ini'), 'utf8');
    report.installedBrowser = { version: metadata.match(/^Version=(.+)$/m)?.[1].trim() ?? null, buildId: metadata.match(/^BuildID=(.+)$/m)?.[1].trim() ?? null };
  } catch { report.installedBrowser = null; }
  const builtServer = await readFile(join(root, 'dist/server/index.js'));
  const builtWorker = await readFile(join(root, 'dist/server/worker.js'));
  report.production = { serverSha256: hash(builtServer), workerSha256: hash(builtWorker), engineBuildHash: builtServer.toString('utf8').match(/var engineIdentity = \{\s+engineBuildHash: (?:true \? )?"([a-f0-9]{64})"/)?.[1] ?? null };
  temporaryRoot = await mkdtemp(join(temporaryParent, 'frontier-firefox-smoke-')); ownedRoot = await realpath(temporaryRoot);
  if (!inside(temporaryParent, ownedRoot) || inside(root, ownedRoot) || inside(ownedRoot, root)) throw new Error('TEMP_ROOT_NOT_ISOLATED');
  ownership = randomBytes(32).toString('hex'); bootstrapToken = randomBytes(32).toString('base64url');
  await writeFile(join(ownedRoot, '.firefox-smoke-owner'), ownership, { mode: 0o600 });
  const profile = join(ownedRoot, 'profile'); await mkdir(profile);
  const env = {}, allowed = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'userprofile', 'home', 'appdata', 'localappdata', 'temp', 'tmp', 'display', 'wayland_display', 'xdg_runtime_dir']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  const port = await new Promise((resolvePort, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const address = socket.address(); socket.close(error => error ? reject(error) : address && typeof address !== 'string' ? resolvePort(address.port) : reject(new Error('PORT_RESERVATION_FAILED'))); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const hook = join(ownedRoot, 'stop-server.mjs');
  // Windows kill() does not run SIGTERM handlers. This private parent-only IPC
  // preload invokes the real production shutdown handler and waits for exit.
  await writeFile(hook, `process.on('message', value => { if (value?.type === 'frontier-firefox-stop' && value.ownership === ${JSON.stringify(ownership)}) process.emit('SIGTERM'); });\n`);
  server = child(process.execPath, ['--import', pathToFileURL(hook).href, 'dist/server/index.js'], { cwd: root, env: { ...env, NODE_ENV: 'production', GAME_BIND: '127.0.0.1', GAME_PORT: String(port), GAME_LAN_MODE: 'false', GAME_DATA_DIR: join(ownedRoot, 'game-data'), HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await waitUntil(async () => { if (server.result) throw new Error('PRODUCTION_START_FAILED'); try { const reply = await ownedFetch(origin, '/api/health'); return reply.response.ok && JSON.parse(reply.bytes).ready === true; } catch { return false; } }, 'PRODUCTION_HEALTH_TIMEOUT', 30_000);
  const html = await ownedFetch(origin, '/'), csp = html.response.headers.get('content-security-policy') ?? '';
  report.csp = csp;
  const scriptSources = csp.split(';').map(value => value.trim()).find(value => value.startsWith('script-src '));
  if (!html.response.ok || scriptSources !== "script-src 'self'" || csp.includes('unsafe-eval') || html.bytes.includes(Buffer.from('/@vite/'))) throw new Error('PRODUCTION_CSP_FAILED');
  report.checks.productionCsp = true;
  const manifestReply = await ownedFetch(origin, '/asset-manifest.json'), manifest = JSON.parse(manifestReply.bytes);
  if (!manifestReply.response.ok || manifest.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(manifest.contentHash) || !/^[a-f0-9]{64}$/.test(manifest.bundle?.sha256)) throw new Error('PRODUCTION_MANIFEST_INVALID');
  Object.assign(report.production, { contentHash: manifest.contentHash, assetBundleHash: manifest.bundle.sha256, htmlSha256: hash(html.bytes) });
  const browserArgs = ['--no-remote', '--profile', profile, '--headless', '--remote-debugging-port', '0', ...(process.platform === 'win32' ? ['--wait-for-browser'] : []), 'about:blank'];
  browser = child(binary, browserArgs, { cwd: ownedRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = bytes => { output = (output + bytes.toString('utf8')).slice(-32_768); };
  browser.process.stderr.on('data', collect); browser.process.stdout.on('data', collect);
  let endpoint;
  try {
    endpoint = await waitUntil(() => { if (browser.result) throw new Error('FIREFOX_START_FAILED'); return output.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)(?:\/session)?/)?.[1]; }, 'BIDI_START_TIMEOUT', 30_000);
  } catch (error) {
    report.browserStartup = { result: browser.result ?? null, output: safeText(output) };
    throw error;
  }
  bidi = await connectBidi(`${endpoint}/session`);
  const session = await bidi.rpc('session.new', { capabilities: {} });
  const capabilities = session.capabilities;
  if (capabilities?.browserName !== 'firefox') throw new Error('UNEXPECTED_BROWSER');
  report.browser = { name: capabilities.browserName, version: capabilities.browserVersion, buildId: capabilities['moz:buildID'] ?? null, platform: capabilities.platformName, userAgent: capabilities.userAgent };
  await bidi.rpc('session.subscribe', { events: ['log.entryAdded'] });
  emit('firefox_smoke_started', { browserVersion: report.browser.version, artifact: relative(root, artifactDirectory).replaceAll('\\', '/') });
  const context = await newContext('production', `() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }); }`);
  await bidi.rpc('browsingContext.navigate', { context, url: `${origin}/`, wait: 'complete' });
  await waitUntil(() => evaluate(context, `document.querySelector('.lobby-footer')?.textContent.includes('WEBGL2') === true`), 'WEBGL2_RENDER_TIMEOUT', 30_000);
  report.graphics = await evaluate(context, `(() => {
    const canvas = document.querySelector('[data-testid="world-canvas"]'), gl = canvas?.getContext('webgl2');
    if (!gl) return { webgl2: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { webgl2: true, webgpu: !!navigator.gpu, renderer: gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER), vendor: gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR), version: gl.getParameter(gl.VERSION), viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }, drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight } };
  })()`);
  if (!report.graphics.webgl2 || report.graphics.webgpu || report.graphics.viewport.width !== 1440 || report.graphics.viewport.height !== 900) throw new Error('WEBGL2_BASELINE_FAILED');
  await home(context); await delay(300, undefined, { signal: abort.signal });
  const before = await evaluate(context, pixelExpression); report.initialPixels = pixelEvidence(before);
  if (report.initialPixels.coloredPixelFraction < .05 || report.initialPixels.quantizedColors < 20) throw new Error('BLANK_WORLD_CANVAS');
  await screenshot(context, 'production-webgl2'); report.checks.webgl2WithoutWebgpu = true;
  await bidi.rpc('input.performActions', { context, actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', origin: 'viewport', x: 650, y: 250 }, { type: 'pointerDown', button: 1 }, ...Array.from({ length: 16 }, (_, i) => ({ type: 'pointerMove', origin: 'viewport', x: 650 + (i + 1) * 20, y: Math.round(250 + (i + 1) * 90 / 16), duration: 25 })), { type: 'pointerUp', button: 1 }] }] });
  let changed = 0;
  await waitUntil(async () => { changed = comparePixels(before, await evaluate(context, pixelExpression)); return changed > .05; }, 'CAMERA_ROTATION_NOT_VISIBLE');
  await screenshot(context, 'camera-rotated');
  await home(context); let restored = 1;
  await waitUntil(async () => { restored = comparePixels(before, await evaluate(context, pixelExpression)); return restored < .01; }, 'CAMERA_HOME_NOT_RESTORED');
  await screenshot(context, 'camera-restored'); report.camera = { changedPixelFraction: changed, restoredPixelFraction: restored }; report.checks.cameraRotationAndHome = true;
  emit('firefox_smoke_camera_passed');
  contexts.set(context, 'context_recovery');
  const supportsLoss = await evaluate(context, `(() => { const extension = document.querySelector('[data-testid="world-canvas"]').getContext('webgl2').getExtension('WEBGL_lose_context'); if (!extension) return false; window.__frontierSmokeRestoreContext = () => extension.restoreContext(); extension.loseContext(); return true; })()`);
  if (!supportsLoss) throw new Error('CONTEXT_LOSS_EXTENSION_UNAVAILABLE');
  const graphicsAlert = `Array.from(document.querySelectorAll('[role="alert"]')).some(node => /graphics|context/i.test(node.textContent))`;
  await waitUntil(() => evaluate(context, graphicsAlert), 'CONTEXT_LOSS_NOTICE_MISSING'); await screenshot(context, 'context-lost');
  const health = await ownedFetch(origin, '/api/health');
  if (!health.response.ok || JSON.parse(health.bytes).ready !== true) throw new Error('HOST_UNHEALTHY_DURING_GRAPHICS_LOSS');
  report.checks.hostHealthyDuringGraphicsLoss = true;
  await evaluate(context, `(() => { window.__frontierSmokeRestoreContext(); delete window.__frontierSmokeRestoreContext; return true; })()`);
  await waitUntil(async () => !await evaluate(context, graphicsAlert), 'CONTEXT_NOT_RECOVERED', 20_000);
  report.recoveredPixels = await waitUntil(async () => { const sample = pixelEvidence(await evaluate(context, pixelExpression)); return sample.coloredPixelFraction >= .05 && sample.quantizedColors >= 20 ? sample : false; }, 'RECOVERED_CANVAS_BLANK', 20_000);
  await screenshot(context, 'context-restored'); report.checks.contextRecovery = true;
  emit('firefox_smoke_recovery_passed');
  const missing = await newContext('missing_webgl2', `() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return kind === 'webgl2' ? null : Reflect.apply(original, this, [kind, ...args]); }; }`);
  await bidi.rpc('browsingContext.navigate', { context: missing, url: `${origin}/`, wait: 'complete' });
  await waitUntil(() => evaluate(missing, `Array.from(document.querySelectorAll('[role="alert"]')).some(node => /WebGL2/.test(node.textContent))`), 'MISSING_WEBGL2_NOTICE_ABSENT');
  await screenshot(missing, 'missing-webgl2'); report.checks.missingWebgl2Explanation = true;
  if (report.errors.some(error => error.phase !== 'missing_webgl2')) throw new Error('UNEXPECTED_PAGE_EXCEPTION');
  report.checks.noUnexpectedPageExceptions = true;
} catch (error) {
  report.failure = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : abort.signal.aborted ? safeText(abort.signal.reason?.message) : 'FIREFOX_SMOKE_FAILED';
  if (currentContext && bidi && !abort.signal.aborted) { try { await screenshot(currentContext, 'failure'); } catch { /* preserve original failure */ } }
} finally {
  clearTimeout(deadline);
  try { await cleanup(); } catch (error) { report.cleanup.failure = safeText(error.message); report.failure ??= 'CLEANUP_FAILED'; }
  if (browser && !report.cleanup.browserGraceful || server && !report.cleanup.serverGraceful) report.failure ??= 'GRACEFUL_SHUTDOWN_FAILED';
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  report.elapsedMs = Math.round(performance.now() - started); report.passed = !report.failure && Object.keys(report.checks).length === 7 && Object.values(report.checks).every(Boolean) && report.cleanup.temporaryDirectoryRemoved === true;
  if (!report.passed) process.exitCode = 1;
  await mkdir(artifactDirectory, { recursive: true }); await writeFile(join(artifactDirectory, 'report.json'), JSON.stringify(report, null, 2));
  emit('firefox_smoke_finished', { passed: report.passed, ...(report.failure ? { code: report.failure } : {}), elapsedMs: report.elapsedMs, report: `${relative(root, artifactDirectory).replaceAll('\\', '/')}/report.json` });
}
