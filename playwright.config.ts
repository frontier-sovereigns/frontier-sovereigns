import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', timeout: 90000, workers: 1, retries: 0,
  use: { baseURL: 'http://127.0.0.1:3010', channel: process.env.BROWSER_CHANNEL ?? 'chrome', viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } },
  webServer: { command: 'node --env-file-if-exists=.env dist/server/index.js', url: 'http://127.0.0.1:3010/api/health', reuseExistingServer: false, timeout: 30000, env: { GAME_PORT: '3010', GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: './runtime-data/e2e', NODE_ENV: 'production', HOST_ADMIN_BOOTSTRAP_TOKEN: 'e2e-bootstrap-token-not-for-real-hosts' } },
});
