import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Default is a read-only plan. --run is deliberately explicit: this installs and
// builds from the existing local package cache, never from this checkout's output.
const sourceRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || arguments_.some(value => !['--plan', '--run', '--package'].includes(value))) throw new Error('USAGE: node scripts/release-smoke.mjs [--plan|--run|--package]');
const packageCandidate = arguments_[0] === '--package';
const run = arguments_[0] === '--run' || packageCandidate;
const pinnedNode = (await readFile(join(sourceRoot, '.node-version'), 'utf8')).trim();
const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
const stages = [
  ['install', 'corepack pnpm install --offline --frozen-lockfile --config.engine-strict=true'],
  ['build', 'corepack pnpm build'],
];
const stageTimeoutMs = { package_manager: 60_000, install: 20 * 60_000, assets: 5 * 60_000, build: 20 * 60_000 };
const executionTimeoutMs = 60 * 60_000;
const rootFiles = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json', 'vitest.config.ts', 'playwright.config.ts', '.node-version', '.npmrc', '.gitignore', '.env.example', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md'];
// No wildcard root copy, no .env, no generated public art, and no build products.
const trees = {
  'apps/client/src': ['.ts', '.tsx', '.css'],
  'apps/server/src': ['.ts'],
  'packages/assets/src': ['.ts'], 'packages/assets/test': ['.ts'],
  'packages/shared/src': ['.ts', '.js'],
  'packages/simulation/src': ['.ts'], 'packages/simulation/test': ['.ts'],
  scripts: ['.ts', '.mjs'], tests: ['.ts'], data: ['.json'], schemas: ['.json'], examples: ['.json'],
  docs: ['.md'], assets: ['.md', '.txt'],
};
const fixedFiles = [
  ...rootFiles, 'apps/client/package.json', 'apps/client/tsconfig.json', 'apps/client/vite.config.ts', 'apps/client/index.html', 'apps/server/package.json',
  'packages/assets/package.json', 'packages/shared/package.json', 'packages/shared/generate-validators.ts', 'packages/simulation/package.json', 'packages/simulation/tsconfig.json',
];
const forbiddenNames = new Set(['node_modules', 'dist', 'runtime-data', 'test-results', 'playwright-report', 'coverage', '.git']);
const inside = (parent, child) => { const rel = relative(parent, child); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = (event, detail = {}) => process.stdout.write(JSON.stringify({ event, ...detail }) + '\n');

async function enumerate(directory, extensions) {
  const result = [];
  for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('SOURCE_SYMLINK_REJECTED');
    if (forbiddenNames.has(entry.name) || entry.name.startsWith('.env') || /^validators\.generated\.(?:js|d\.ts)$/.test(entry.name)) continue;
    const name = `${directory}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await enumerate(name, extensions));
    else if (entry.isFile() && extensions.includes(extname(entry.name))) result.push(name);
  }
  return result;
}
const files = [...fixedFiles];
for (const [directory, extensions] of Object.entries(trees)) files.push(...await enumerate(directory, extensions));
files.sort();
if (new Set(files).size !== files.length) throw new Error('DUPLICATE_SOURCE_PATH');
let sourceBytes = 0;
const inventory = [];
for (const name of files) {
  const path = join(sourceRoot, name), stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !inside(sourceRoot, await realpath(path))) throw new Error('UNSAFE_SOURCE_PATH');
  const bytes = await readFile(path); sourceBytes += bytes.length;
  inventory.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const sourceHash = sha256(JSON.stringify(inventory));
report('release_smoke_plan', { execution: run ? 'run' : 'plan_only', packageCandidate, files: files.length, sourceBytes, sourceHash, node: pinnedNode, packageManager: packageJson.packageManager, stages: stages.map(([, command]) => command), stageTimeoutMs, executionTimeoutMs, productionEntry: packageJson.scripts.start, checks: ['health', 'production_CSP', 'same_host_HTML_assets', 'all_generated_asset_hashes', 'private_file_denial', 'graceful_shutdown', 'verified_temp_cleanup'], exclusions: ['private_environment', 'runtime_data', 'node_modules', 'dist', 'generated_public_art'], limitation: 'Offline install requires the pinned package-manager and dependency cache; this is packaging evidence, not gameplay, WebGL, endpoint, or load qualification.' });
if (!run) process.exit(0);
if (process.versions.node !== pinnedNode) throw new Error('PINNED_NODE_REQUIRED');
if (packageJson.scripts.start !== 'node --env-file-if-exists=.env dist/server/index.js') throw new Error('PRODUCTION_START_CHANGED_REVIEW_SMOKE');

const abort = new AbortController();
const interrupt = () => { process.exitCode = 1; abort.abort(new Error('RELEASE_INTERRUPTED')); };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
const executionDeadline = setTimeout(() => abort.abort(new Error('RELEASE_DEADLINE')), executionTimeoutMs);
executionDeadline.unref();
const checkAbort = () => { if (abort.signal.aborted) throw abort.signal.reason; };
const temporaryParent = await realpath(tmpdir());
const temporaryRoot = await mkdtemp(join(temporaryParent, 'frontier-release-smoke-'));
const ownedRoot = await realpath(temporaryRoot), ownership = randomBytes(32).toString('hex');
if (!inside(temporaryParent, ownedRoot) || inside(sourceRoot, ownedRoot) || inside(ownedRoot, sourceRoot)) throw new Error('TEMP_ROOT_NOT_ISOLATED');
await writeFile(join(ownedRoot, '.release-smoke-owner'), ownership, { mode: 0o600 });
let child, childExit, childExitResult, graceful = false;
const ownedChildren = new Set();
// Inherit only tool discovery/cache paths, never endpoint/authentication variables,
// NODE_OPTIONS, proxies, npm credentials, or the user's local .env.
const env = {};
const allowedEnvironment = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'userprofile', 'home', 'appdata', 'localappdata', 'temp', 'tmp', 'corepack_home', 'pnpm_home', 'xdg_cache_home', 'xdg_data_home']);
for (const [key, value] of Object.entries(process.env)) if (allowedEnvironment.has(key.toLowerCase()) && value !== undefined) env[key] = value;
Object.assign(env, { CI: 'true', COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', NPM_CONFIG_USERCONFIG: join(ownedRoot, '.smoke-user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(ownedRoot, '.smoke-global.npmrc') });

function trackOwned(proc, label, processGroup = false) {
  const state = { proc, label, processGroup, closed: false, ended: undefined };
  state.ended = new Promise(resolveExit => proc.once('close', (code, signal) => { state.closed = true; resolveExit({ code, signal }); }));
  // The owner handles diagnostics; this also keeps cleanup-only helpers safe.
  proc.on('error', () => undefined); ownedChildren.add(state); return state;
}
const liveOwnedPid = proc => proc.exitCode === null && proc.signalCode === null && Number.isSafeInteger(proc.pid) && proc.pid > 0;
async function stopOwnedTree(state) {
  if (!state) throw new Error('UNKNOWN_OWNED_CHILD');
  if (state.closed) return;
  // close can lag exit while a pipe stays open. Never act on an exited/reused PID.
  if (liveOwnedPid(state.proc)) {
    if (process.platform === 'win32') {
      const killer = spawn(join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(state.proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const helper = trackOwned(killer, 'owned_tree_cleanup');
      await Promise.race([helper.ended, delay(5000)]);
      if (!helper.closed && liveOwnedPid(killer)) killer.kill();
      if (!helper.closed) await Promise.race([helper.ended, delay(2000)]);
    } else {
      try { if (state.processGroup) process.kill(-state.proc.pid, 'SIGKILL'); else state.proc.kill('SIGKILL'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
    }
  }
  if (!state.closed) await Promise.race([state.ended, delay(5000)]);
  if (!state.closed) throw new Error('OWNED_CHILD_SHUTDOWN_FAILED');
}

function command(label, text) {
  checkAbort();
  return new Promise((resolveCommand, reject) => {
    const windows = process.platform === 'win32';
    // POSIX cleanup needs an isolated group. On Windows detached cmd children
    // lose piped tool output; exact-PID /T cleanup already owns their whole tree.
    const proc = spawn(windows ? (env.ComSpec ?? env.COMSPEC ?? 'cmd.exe') : '/bin/sh', windows ? ['/d', '/s', '/c', text] : ['-c', text], { cwd: ownedRoot, env, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    trackOwned(proc, label, !windows);
    let settled = false;
    const finish = (error, output) => { if (settled) return; settled = true; clearTimeout(timer); abort.signal.removeEventListener('abort', cancelled); if (error) reject(error); else resolveCommand(output); };
    const cancelled = () => finish(abort.signal.reason);
    const timer = setTimeout(() => abort.abort(new Error(`${label.toUpperCase()}_TIMEOUT`)), stageTimeoutMs[label]);
    abort.signal.addEventListener('abort', cancelled, { once: true });
    let output = '', stdout = '';
    const collect = bytes => { output = (output + bytes.toString('utf8')).slice(-65_536); };
    proc.stdout.on('data', bytes => { stdout = (stdout + bytes.toString('utf8')).slice(-65_536); collect(bytes); }); proc.stderr.on('data', collect);
    proc.once('error', () => finish(new Error(`${label.toUpperCase()}_SPAWN_FAILED`)));
    proc.once('close', code => {
      if (code !== 0) {
        // Never echo tool output: a future install hook might print credentials.
        const safeCode = output.match(/ERR_PNPM_[A-Z_]+|TS\d{4,5}/)?.[0];
        report('release_smoke_stage_failed', { stage: label, exitCode: code, ...(safeCode ? { code: safeCode } : {}) });
        finish(new Error(`${label.toUpperCase()}_FAILED`));
      } else finish(undefined, stdout);
    });
  });
}
async function fetchOwned(origin, path, maxBytes = 16 * 1024 * 1024) {
  checkAbort();
  if (!/^\/[a-zA-Z0-9_./-]*$/.test(path) || path.includes('..') || path.startsWith('//')) throw new Error('NONLOCAL_ASSET_PATH');
  const response = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]) });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('HTTP_BODY_LIMIT');
  const chunks = []; let length = 0;
  for await (const bytes of response.body ?? []) { length += bytes.length; if (length > maxBytes) throw new Error('HTTP_BODY_LIMIT'); chunks.push(bytes); }
  return { response, bytes: Buffer.concat(chunks, length) };
}
async function stopOwnedServer() {
  if (!child) return;
  try { if (!childExitResult && child.connected) child.send({ type: 'frontier-release-smoke-stop', ownership }, () => undefined); } catch { /* wait for exit, then bounded owned cleanup */ }
  const result = await Promise.race([childExit, delay(10_000).then(() => undefined)]);
  if (!result) { await stopOwnedTree([...ownedChildren].find(state => state.proc === child)); throw new Error('GRACEFUL_SHUTDOWN_TIMEOUT'); }
  if (result.code !== 0) throw new Error('PRODUCTION_SERVER_EXIT_FAILED');
  graceful = true;
}
/** Retain only allowlisted source and freshly verified build products. Never copy
 * the temporary server's runtime data, dependency links or shutdown preload. */
async function prepareCandidate(assetManifest) {
  checkAbort();
  const packageFiles = [...inventory.map(item => item.path)];
  async function builtFiles(directory) {
    const absolute = join(ownedRoot, directory);
    if (!inside(ownedRoot, await realpath(absolute)) || (await lstat(absolute)).isSymbolicLink()) throw new Error('UNSAFE_BUILD_PATH');
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.') || forbiddenNames.has(entry.name)) throw new Error('UNSAFE_BUILD_ENTRY');
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await builtFiles(name);
      else if (entry.isFile()) packageFiles.push(name);
      else throw new Error('UNSAFE_BUILD_ENTRY');
    }
  }
  await builtFiles('dist/server');
  await builtFiles('apps/client/dist');
  packageFiles.sort();
  if (new Set(packageFiles).size !== packageFiles.length) throw new Error('DUPLICATE_PACKAGE_PATH');
  const runtimeRoot = join(sourceRoot, 'runtime-data');
  await mkdir(runtimeRoot, { recursive: true });
  if ((await lstat(runtimeRoot)).isSymbolicLink() || !inside(sourceRoot, await realpath(runtimeRoot))) throw new Error('UNSAFE_PACKAGE_PARENT');
  const releasesRoot = join(runtimeRoot, 'releases');
  await mkdir(releasesRoot, { recursive: true });
  if ((await lstat(releasesRoot)).isSymbolicLink() || !inside(runtimeRoot, await realpath(releasesRoot))) throw new Error('UNSAFE_PACKAGE_PARENT');
  const target = await mkdtemp(join(releasesRoot, `frontier-candidate-${sourceHash.slice(0, 12)}-`));
  const targetReal = await realpath(target);
  if (!inside(await realpath(releasesRoot), targetReal)) throw new Error('UNSAFE_PACKAGE_TARGET');
  // Without the final manifest this directory is an incomplete copy, never a release.
  const packageInventory = [];
  for (const name of packageFiles) {
    checkAbort();
    const input = join(ownedRoot, name), stat = await lstat(input);
    if (!stat.isFile() || stat.isSymbolicLink() || !inside(ownedRoot, await realpath(input))) throw new Error('UNSAFE_PACKAGE_INPUT');
    const bytes = await readFile(input), checksum = sha256(bytes), source = inventory.find(item => item.path === name);
    if (source && source.sha256 !== checksum) throw new Error('PACKAGE_SOURCE_CHANGED_DURING_BUILD');
    const output = join(targetReal, name);
    if (!inside(targetReal, output)) throw new Error('UNSAFE_PACKAGE_OUTPUT');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, bytes, { flag: 'wx' });
    if (sha256(await readFile(output)) !== checksum) throw new Error('PACKAGE_COPY_MISMATCH');
    packageInventory.push({ path: name, bytes: bytes.length, sha256: checksum });
  }
  const releaseManifest = { schemaVersion: 1, kind: 'production-candidate', productionQualified: false,
    qualification: 'Packaging checks only; production is not qualified. Review docs/SELF_HOSTING.md and docs/TESTING.md before deployment.',
    createdAt: new Date().toISOString(), sourceHash, node: pinnedNode, packageManager: packageJson.packageManager,
    contentHash: assetManifest.contentHash, assetBundleHash: assetManifest.bundle.sha256,
    install: 'corepack pnpm install --frozen-lockfile --config.engine-strict=true', start: 'corepack pnpm start',
    privateDataIncluded: false, dependenciesIncluded: false, files: packageInventory };
  const bytes = Buffer.from(JSON.stringify(releaseManifest, null, 2) + '\n');
  checkAbort();
  const manifestTemporary = join(targetReal, '.release-manifest.pending');
  await writeFile(manifestTemporary, bytes, { flag: 'wx' });
  checkAbort();
  await rename(manifestTemporary, join(targetReal, 'RELEASE_MANIFEST.json'));
  report('release_candidate_prepared', { path: targetReal, files: packageInventory.length, bytes: packageInventory.reduce((sum, item) => sum + item.bytes, 0), manifestSHA256: sha256(bytes), productionQualified: false });
}
async function cleanup() {
  // Verify the resolved target and ownership marker immediately before deletion.
  // rm is Node-native; no shell-built recursive deletion or process-name killing.
  if ([...ownedChildren].some(state => !state.closed)) throw new Error('TEMP_CLEANUP_LIVE_CHILD');
  const target = await realpath(temporaryRoot);
  if (target !== ownedRoot || !inside(temporaryParent, target) || inside(sourceRoot, target) || inside(target, sourceRoot) || await readFile(join(target, '.release-smoke-owner'), 'utf8') !== ownership) throw new Error('TEMP_CLEANUP_REFUSED');
  await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  report('release_smoke_cleanup', { removedOwnedTemporaryDirectory: true });
}

try {
  for (const item of inventory) {
    checkAbort();
    const bytes = await readFile(join(sourceRoot, item.path));
    if (sha256(bytes) !== item.sha256) throw new Error('SOURCE_CHANGED_DURING_COPY');
    const destination = join(ownedRoot, item.path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
  }
  await writeFile(env.NPM_CONFIG_USERCONFIG, ''); await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '');
  const pnpmVersion = (await command('package_manager', 'corepack pnpm --version')).trim();
  if (`pnpm@${pnpmVersion}` !== packageJson.packageManager) throw new Error('PINNED_PACKAGE_MANAGER_REQUIRED');
  const lockBefore = sha256(await readFile(join(ownedRoot, 'pnpm-lock.yaml')));
  for (const [label, text] of stages) {
    checkAbort();
    const started = performance.now(); report('release_smoke_stage_started', { stage: label });
    await command(label, text);
    if (sha256(await readFile(join(ownedRoot, 'pnpm-lock.yaml'))) !== lockBefore) throw new Error('FROZEN_LOCKFILE_CHANGED');
    report('release_smoke_stage_passed', { stage: label, elapsedMs: Math.round(performance.now() - started) });
  }
  const port = await new Promise((resolvePort, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('PORT_RESERVATION_FAILED')); server.close(error => error ? reject(error) : resolvePort(address.port)); }); });
  const origin = `http://127.0.0.1:${port}`;
  // Windows child.kill does not reliably run Node's SIGTERM listeners. This tiny
  // test-only preload forwards an authenticated parent IPC request to the actual
  // production handler, which awaits app.close(). No product file is modified.
  const hookPath = join(ownedRoot, '.release-smoke-shutdown.mjs');
  await writeFile(hookPath, `process.on('message', value => { if (value?.type === 'frontier-release-smoke-stop' && value.ownership === ${JSON.stringify(ownership)}) process.emit('SIGTERM'); });\n`);
  const bootstrapToken = randomBytes(32).toString('base64url');
  child = spawn(process.execPath, ['--import', pathToFileURL(hookPath).href, '--env-file-if-exists=.env', 'dist/server/index.js'], { cwd: ownedRoot, env: { ...env, NODE_ENV: 'production', GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_PORT: String(port), GAME_DATA_DIR: join(ownedRoot, 'runtime-data'), HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrapToken }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  trackOwned(child, 'production_server');
  childExit = new Promise(resolveExit => { child.once('error', () => { childExitResult = { code: null }; resolveExit(childExitResult); }); child.once('exit', code => { childExitResult = { code }; resolveExit(childExitResult); }); });
  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    checkAbort();
    if (childExitResult) throw new Error('PRODUCTION_START_FAILED');
    try { health = await fetchOwned(origin, '/api/health', 4096); if (health.response.ok) break; } catch { /* bounded startup retry */ }
    await delay(200, undefined, { signal: abort.signal });
  }
  if (!health?.response.ok || JSON.parse(health.bytes.toString()).ready !== true) throw new Error('PRODUCTION_HEALTH_FAILED');
  const html = await fetchOwned(origin, '/', 1024 * 1024);
  if (!html.response.ok || !html.response.headers.get('content-type')?.includes('text/html')) throw new Error('PRODUCTION_HTML_FAILED');
  const csp = html.response.headers.get('content-security-policy') ?? '';
  const directives = new Map(csp.split(';').map(value => value.trim().split(/\s+/)).filter(parts => parts[0]).map(([name, ...values]) => [name, values]));
  if (JSON.stringify(directives.get('script-src')) !== JSON.stringify(["'self'"]) || !directives.get('object-src')?.includes("'none'") || !directives.get('frame-ancestors')?.includes("'none'") || csp.includes('unsafe-eval')) throw new Error('PRODUCTION_CSP_FAILED');
  const htmlText = html.bytes.toString();
  if (htmlText.includes('/@vite/') || htmlText.includes('/src/main.tsx') || htmlText.includes(bootstrapToken)) throw new Error('NOT_PRIVATE_PRODUCTION_HTML');
  const references = [...htmlText.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
  if (!references.some(path => path.endsWith('.js')) || !references.some(path => path.endsWith('.css'))) throw new Error('MISSING_COMPILED_BROWSER_ASSETS');
  for (const path of new Set(references)) {
    if (!path.startsWith('/assets/')) throw new Error('UNEXPECTED_HTML_ASSET_ORIGIN');
    const served = await fetchOwned(origin, path), local = await readFile(join(ownedRoot, 'apps/client/dist', path.slice(1)));
    if (!served.response.ok || sha256(served.bytes) !== sha256(local)) throw new Error('COMPILED_ASSET_MISMATCH');
  }
  const manifestReply = await fetchOwned(origin, '/asset-manifest.json', 1024 * 1024);
  const manifest = JSON.parse(manifestReply.bytes.toString());
  if (!manifestReply.response.ok || manifest.schemaVersion !== 2 || manifest.status !== 'GENERATED_ORIGINAL_ASSETS' || !/^[a-f0-9]{64}$/.test(manifest.contentHash)) throw new Error('ASSET_MANIFEST_FAILED');
  const assets = [manifest.bundle, ...manifest.ui, ...manifest.audio];
  if (new Set(assets.map(asset => asset.path)).size !== assets.length || !manifest.catalog?.length) throw new Error('INVALID_ASSET_INVENTORY');
  for (const asset of assets) {
    if (!asset.path.startsWith('/art/') || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('INVALID_ASSET_METADATA');
    const served = await fetchOwned(origin, asset.path);
    if (!served.response.ok || served.bytes.length !== asset.bytes || sha256(served.bytes) !== asset.sha256) throw new Error('GENERATED_ASSET_MISMATCH');
  }
  for (const path of ['/.env', '/runtime-data/host-bootstrap.txt']) {
    const reply = await fetchOwned(origin, path, 1024 * 1024);
    // The SPA fallback may return index.html; it must never expose private bytes.
    if (reply.bytes.includes(Buffer.from(bootstrapToken)) || (reply.response.ok && sha256(reply.bytes) !== sha256(html.bytes))) throw new Error('PRIVATE_FILE_EXPOSED');
  }
  await stopOwnedServer();
  checkAbort();
  report('release_smoke_verified', { sourceHash, node: process.versions.node, packageManager: packageJson.packageManager, browserAssets: new Set(references).size, generatedAssets: assets.length, contentHash: manifest.contentHash, assetBundleHash: manifest.bundle.sha256, gracefulShutdown: graceful, shutdownMechanism: 'production_SIGTERM_handler_via_test_only_IPC_preload' });
  if (packageCandidate) await prepareCandidate(manifest);
} catch (error) {
  // All surfaced errors are fixed local codes, not upstream data or process logs.
  const cause = abort.signal.aborted ? abort.signal.reason : error;
  const message = cause instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(cause.message) ? cause.message : 'RELEASE_SMOKE_FAILED';
  report('release_smoke_failed', { code: message }); process.exitCode = 1;
} finally {
  clearTimeout(executionDeadline);
  try { if (child && !graceful) await stopOwnedServer(); }
  catch { report('release_smoke_shutdown_failed'); process.exitCode = 1; }
  for (const state of [...ownedChildren]) {
    try { if (!state.closed) await stopOwnedTree(state); }
    catch { report('release_smoke_child_shutdown_failed', { stage: state.label }); process.exitCode = 1; }
  }
  try { await cleanup(); }
  catch { report('release_smoke_cleanup_refused'); process.exitCode = 1; }
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
