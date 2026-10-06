import { build } from 'esbuild';
import { engineIdentity } from '../apps/server/src/build-info.ts';
await build({
  entryPoints: {
    index: 'apps/server/src/index.ts',
    worker: 'apps/server/src/worker.ts',
    'path-worker': 'apps/server/src/path-worker.ts',
    'path-service-worker': 'apps/server/src/path-service-worker.ts',
    'publication-worker': 'apps/server/src/publication-worker.ts',
    'vision-worker': 'apps/server/src/vision-worker.ts',
    'load-profile': 'scripts/load.ts',
    'network-profile': 'scripts/network-load.ts',
    'network-observer': 'scripts/network-observer-worker.ts',
    'ai-regression': 'scripts/ai-regression.ts',
    'playthrough-rehearsal': 'scripts/playthrough-rehearsal.ts',
  },
  outdir: 'dist/server', platform: 'node', target: 'node22', format: 'esm',
  bundle: true, sourcemap: true,
  define: {
    __ENGINE_BUILD_HASH__: JSON.stringify(engineIdentity.engineBuildHash),
    __PROFILE_EXECUTION__: JSON.stringify('bundled-production'),
  },
  external: ['fastify', '@fastify/static', '@fastify/cookie', 'ws', 'ajv', 'ajv/*'],
});
