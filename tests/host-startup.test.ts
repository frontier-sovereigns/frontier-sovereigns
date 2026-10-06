import { afterEach, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';

const testToken = 'startup-fixed-test-token-not-a-real-credential';
const port = 3217;
const directory = resolve('runtime-data/startup-tests-no-real-files');
const bootstrapPath = resolve(directory, 'host-bootstrap.txt');
const cleanup: (() => void)[] = [];
const signals = ['SIGINT', 'SIGTERM'] as const;
const address = (value: string, internal = false): NetworkInterfaceInfo => ({ address: value, family: 'IPv4', internal, netmask: '255.255.255.0', cidr: `${value}/24`, mac: '00:00:00:00:00:00' });

afterEach(() => {
  for (const restore of cleanup.splice(0).reverse()) restore();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const module of ['node:fs/promises', 'node:os', '../apps/server/src/server.js']) vi.doUnmock(module);
  vi.resetModules();
});

/** Import the real entry point, with every filesystem/server boundary replaced.
 * Nothing listens, writes a private file, contacts a model, or emits a real token.
 */
function startup(options: { tty?: boolean; lan?: boolean; bind?: string; deferListen?: boolean; listenError?: Error; writeError?: Error } = {}) {
  vi.resetModules();
  const previousTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: options.tty ?? true });
  cleanup.push(() => { if (previousTty) Object.defineProperty(process.stdout, 'isTTY', previousTty); else Reflect.deleteProperty(process.stdout, 'isTTY'); });
  const existingListeners = new Map(signals.map(signal => [signal, new Set(process.listeners(signal))]));
  cleanup.push(() => { for (const signal of signals) for (const listener of process.listeners(signal)) if (!existingListeners.get(signal)!.has(listener)) process.removeListener(signal, listener); });
  for (const [key, value] of Object.entries({
    GAME_PORT: String(port), GAME_LAN_MODE: String(options.lan ?? true), GAME_BIND: options.bind,
    GAME_DATA_DIR: directory, GAME_PUBLIC_ORIGIN: 'https://public-game.example',
    GAME_ALLOWED_ORIGINS: 'http://dev-client.example:5173,http://localhost:5173',
    NODE_ENV: 'development', HOST_ADMIN_BOOTSTRAP_TOKEN: undefined,
  })) vi.stubEnv(key, value);

  const events: string[] = [], output: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { events.push('banner'); output.push(String(chunk)); return true; }) as typeof process.stdout.write);
  const mkdir = vi.fn(async () => { events.push('mkdir'); });
  const writeFile = vi.fn(async (_path: unknown, _body: unknown, _options: unknown) => { events.push('token_file'); if (options.writeError) throw options.writeError; });
  const chmod = vi.fn(async () => { events.push('chmod'); });
  vi.doMock('node:fs/promises', () => ({ mkdir, writeFile, chmod }));
  const interfaces = vi.fn(() => ({
    loopback: [address('127.0.0.1', true)],
    ethernet: [address('192.168.50.23')],
    duplicateAdapter: [address('192.168.50.23')],
    wireless: [address('10.23.4.5')],
    ipv6: [{ address: '2001:db8::1', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', cidr: '2001:db8::1/64', scopeid: 0, mac: '00:00:00:00:00:00' } satisfies NetworkInterfaceInfo],
  }));
  vi.doMock('node:os', () => ({ networkInterfaces: interfaces }));
  let releaseListen!: () => void;
  const listenGate = new Promise<void>(done => { releaseListen = done; });
  const listen = vi.fn(async (_options: unknown) => {
    events.push('listen_started');
    if (options.deferListen) await listenGate;
    if (options.listenError) throw options.listenError;
    events.push('listen_ready');
  });
  const close = vi.fn(async () => { events.push('closed'); });
  const info = vi.fn((_entry: unknown) => { events.push('host_ready'); });
  const createGameServer = vi.fn(async (_options: unknown) => ({
    app: { listen, close, log: { info } }, bootstrapToken: testToken,
    origins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, `http://192.168.50.23:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173', 'https://public-game.example', 'http://dev-client.example:5173'],
    startupEndpoint: { configured: false, mode: 'unprobed', status: 'NOT_CONFIGURED' },
  }));
  vi.doMock('../apps/server/src/server.js', () => ({ createGameServer }));
  // Capture import failures immediately, so a deliberately failed listen cannot
  // become an unhandled rejection while the test checks its observable effects.
  const completed = import('../apps/server/src/index.js').then(() => ({ error: undefined }), (error: unknown) => ({ error }));
  return { completed, releaseListen, events, output, stdout, mkdir, writeFile, chmod, interfaces, listen, close, info, createGameServer };
}

it('prints one adjacent host address/token block only after listening and persisting the matching token', async () => {
  const run = startup({ deferListen: true });
  try {
    await expect.poll(() => run.listen.mock.calls.length).toBe(1);
    expect(run.writeFile).not.toHaveBeenCalled(); expect(run.info).not.toHaveBeenCalled(); expect(run.stdout).not.toHaveBeenCalled();
  } finally { run.releaseListen(); }
  expect((await run.completed).error).toBeUndefined();
  expect(run.createGameServer).toHaveBeenCalledWith(expect.objectContaining({ port, bind: '0.0.0.0', lan: true, bootstrapToken: undefined }));
  expect(run.listen).toHaveBeenCalledWith({ port, host: '0.0.0.0' });
  expect(run.writeFile).toHaveBeenCalledExactlyOnceWith(bootstrapPath, expect.any(String), { mode: 0o600 });
  const file = String(run.writeFile.mock.calls[0]![1]); expect(file.split('\n').filter(line => line === testToken)).toHaveLength(1);
  expect(run.stdout).toHaveBeenCalledTimes(1);
  const banner = run.output.join('');
  expect(banner).toContain(`Host browser: http://127.0.0.1:${port}\nHost access token: ${testToken}\n`);
  expect(banner.match(/^Host browser:/gm)).toHaveLength(1); expect(banner.match(/^Host access token:/gm)).toHaveLength(1);
  expect(banner).toContain('Usable once within 10 minutes'); expect(banner).toContain('using a browser on this server computer');
  expect(banner).toContain(`Token backup file: ${bootstrapPath}`);
  expect(banner.split('\n').filter(line => line.startsWith('Other computers on this LAN:'))).toEqual([
    `Other computers on this LAN: http://192.168.50.23:${port}`,
    `Other computers on this LAN: http://10.23.4.5:${port}`,
  ]);
  for (const excluded of ['localhost', ':5173', 'public-game.example', 'dev-client.example', '2001:db8']) expect(banner).not.toContain(excluded);
  expect(run.events.indexOf('listen_ready')).toBeLessThan(run.events.indexOf('token_file'));
  expect(run.events.indexOf('token_file')).toBeLessThan(run.events.indexOf('host_ready'));
  expect(run.events.indexOf('host_ready')).toBeLessThan(run.events.indexOf('banner'));
  expect(JSON.stringify(run.info.mock.calls)).not.toContain(testToken);
});

it('keeps redirected output token-free while retaining the private file and redacted readiness log', async () => {
  const run = startup({ tty: false }); expect((await run.completed).error).toBeUndefined();
  expect(run.stdout).not.toHaveBeenCalled(); expect(run.interfaces).not.toHaveBeenCalled();
  expect(run.writeFile).toHaveBeenCalledExactlyOnceWith(bootstrapPath, expect.stringContaining(`\n${testToken}\n`), { mode: 0o600 });
  expect(run.info).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'host_ready', bootstrapFile: bootstrapPath, strategicModel: { scope: 'default_host_model', configured: false, mode: 'unprobed', status: 'NOT_CONFIGURED' } }));
  expect(JSON.stringify(run.info.mock.calls)).not.toContain(testToken);
});

it('does not overwrite an existing host token or advertise readiness when the listening port is occupied', async () => {
  const failure = Object.assign(new Error('Fixture address already in use'), { code: 'EADDRINUSE' });
  const run = startup({ listenError: failure }); expect((await run.completed).error).toBe(failure);
  expect(run.writeFile).not.toHaveBeenCalled(); expect(run.chmod).not.toHaveBeenCalled();
  expect(run.info).not.toHaveBeenCalled(); expect(run.stdout).not.toHaveBeenCalled();
});

it('closes the listening app without a readiness log or token banner if private-token persistence fails', async () => {
  const failure = Object.assign(new Error('Fixture private-file write denied'), { code: 'EACCES' });
  const run = startup({ writeError: failure }); expect((await run.completed).error).toBe(failure);
  expect(run.listen).toHaveBeenCalledTimes(1); expect(run.close).toHaveBeenCalledTimes(1);
  expect(run.events.indexOf('listen_ready')).toBeLessThan(run.events.indexOf('token_file'));
  expect(run.events.indexOf('token_file')).toBeLessThan(run.events.indexOf('closed'));
  expect(run.info).not.toHaveBeenCalled(); expect(run.stdout).not.toHaveBeenCalled();
});

it('does not advertise LAN or development addresses in loopback mode', async () => {
  const run = startup({ lan: false }); expect((await run.completed).error).toBeUndefined();
  expect(run.listen).toHaveBeenCalledWith({ port, host: '127.0.0.1' }); expect(run.interfaces).not.toHaveBeenCalled();
  expect(run.output.join('')).toContain(`Host browser: http://127.0.0.1:${port}\nHost access token: ${testToken}`);
  for (const excluded of ['Other computers on this LAN:', '192.168.50.23', '10.23.4.5', ':5173', 'public-game.example']) expect(run.output.join('')).not.toContain(excluded);
});

it('advertises each reachable LAN address only once and respects an explicitly bound interface', async () => {
  const run = startup({ bind: '192.168.50.23' }); expect((await run.completed).error).toBeUndefined();
  expect(run.listen).toHaveBeenCalledWith({ port, host: '192.168.50.23' });
  expect(run.output.join('').split('\n').filter(line => line.startsWith('Other computers on this LAN:'))).toEqual([`Other computers on this LAN: http://192.168.50.23:${port}`]);
});
