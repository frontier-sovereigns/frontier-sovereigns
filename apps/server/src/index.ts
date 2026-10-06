import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createGameServer } from './server.js';

const port = Number(process.env.GAME_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_GAME_PORT');
const lan = process.env.GAME_LAN_MODE === 'true';
const bind = process.env.GAME_BIND ?? (lan ? '0.0.0.0' : '127.0.0.1');
const extraOrigins = [process.env.GAME_PUBLIC_ORIGIN, ...(process.env.GAME_ALLOWED_ORIGINS ?? '').split(',')].filter((s): s is string => Boolean(s));
if (process.env.NODE_ENV !== 'production') extraOrigins.push('http://127.0.0.1:5173', 'http://localhost:5173');
const { app, bootstrapToken, origins, startupEndpoint } = await createGameServer({ port, bind, lan, allowedOrigins: extraOrigins, bootstrapToken: process.env.HOST_ADMIN_BOOTSTRAP_TOKEN, logger: true, requireStaticAssets: process.env.NODE_ENV !== 'development' });
const directory = resolve(process.env.GAME_DATA_DIR ?? 'runtime-data');
await mkdir(directory, { recursive: true, mode: 0o700 });
const bootstrapPath = resolve(directory, 'host-bootstrap.txt');
await app.listen({ port, host: bind });
// A failed second launch must not replace the running host's private token file.
try {
  await writeFile(bootstrapPath, `Frontier Sovereigns host bootstrap (expires in 10 minutes, one use, loopback only)\nOpen http://127.0.0.1:${port} and enter this token in Host access:\n${bootstrapToken}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') await chmod(bootstrapPath, 0o600);
} catch (error) { await app.close(); throw error; }
app.log.info({ event: 'host_ready', mode: lan ? 'LAN' : 'loopback', gameAddresses: origins, bootstrapFile: bootstrapPath, strategicModel: { scope: 'default_host_model', ...startupEndpoint } });
// Only the operator's interactive console may display the bootstrap secret.
// Background/redirected output keeps the private-file fallback, never a token log.
if (process.stdout.isTTY) {
  const lanAddresses = lan ? [...new Set(Object.values(networkInterfaces()).flatMap(group => (group ?? [])
    .filter(info => info.family === 'IPv4' && !info.internal && (bind === '0.0.0.0' || bind === '::' || bind === info.address))
    .map(info => `http://${info.address}:${port}`)))] : [];
  process.stdout.write([
    '', 'Frontier Sovereigns', `Host browser: http://127.0.0.1:${port}`, `Host access token: ${bootstrapToken}`,
    'Enter this token in HOST ACCESS at the address above,',
    'using a browser on this server computer. Usable once within 10 minutes of startup.',
    '', ...lanAddresses.map(address => `Other computers on this LAN: ${address}`),
    ...(lanAddresses.length ? ['Players join using the invitation code provided by the host.', ''] : []),
    `Token backup file: ${bootstrapPath}`,
    'Save your match, then press Ctrl+C here to stop the game.', '',
  ].join('\n'));
}
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
