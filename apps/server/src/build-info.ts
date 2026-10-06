import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __ENGINE_BUILD_HASH__: string | undefined;

/** A conservative compatibility fingerprint; tests and private configuration are excluded. */
export function computeEngineBuildHash(root: string): string {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && !entry.name.endsWith('.test.ts')) files.push(child);
    }
  };
  for (const directory of ['packages/simulation/src', 'packages/shared/src', 'schemas']) visit(resolve(root, directory));
  files.push(resolve(root, 'data/balance.v1.json'),resolve(root, 'data/balance.legendary-ages.v1.json'));
  const hash = createHash('sha256');
  for (const path of files.sort((a, b) => relative(root, a).replaceAll('\\', '/') < relative(root, b).replaceAll('\\', '/') ? -1 : 1)) {
    const bytes = readFileSync(path), name = relative(root, path).replaceAll('\\', '/');
    hash.update(`${name.length}:${name}:${bytes.length}:`); hash.update(bytes);
  }
  return hash.digest('hex');
}

export const engineIdentity = {
  engineBuildHash: typeof __ENGINE_BUILD_HASH__ === 'string' ? __ENGINE_BUILD_HASH__ : computeEngineBuildHash(resolve(dirname(fileURLToPath(import.meta.url)), '../../..')),
  runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch },
};
