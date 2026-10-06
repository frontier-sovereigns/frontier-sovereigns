import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { balance, units, buildings, contentHash, assetCatalogContentHash } from '@frontier/shared';
import { createAssetLibrary, generateBuildingAssets, generateEnvironmentAssets, generateUnitAssets, assertAssetBundle, inspectAssetPose, type AssetState, type Lod } from '@frontier/assets';
import { generateUiAssets } from '../packages/assets/src/ui.js';
import { generateAudioAssets } from '../packages/assets/src/audio.js';

interface Requirement { id: string; ages?: number[]; requiredAnimations?: string[]; requiredStates?: string[]; requiredLods: Lod[] }
const requirements = JSON.parse(await readFile('data/asset-requirements.json', 'utf8')) as { unitAssets: Requirement[]; buildingAssets: Requirement[]; environmentAssets: string[]; uiAssets: string[]; audioAssets: string[] };
for (const [group, catalog] of [[requirements.unitAssets, Object.values(units)], [requirements.buildingAssets, Object.values(buildings)]] as const) {
  const ids = group.map(item => item.id);
  if (ids.length !== new Set(ids).size || catalog.length !== ids.length || catalog.some(entry => !ids.includes(entry.id))) throw new Error('BROKEN_ASSET_CATALOG');
}
const library = createAssetLibrary();
const bundle = library.finish([...generateBuildingAssets(library), ...generateEnvironmentAssets(library), ...generateUnitAssets(library)]);
assertAssetBundle(bundle);
for (const required of [...requirements.unitAssets, ...requirements.buildingAssets]) {
  const asset = bundle.assets[required.id]; if (!asset) throw new Error(`MISSING_ASSET:${required.id}`);
  for (const age of required.ages ?? []) if (!asset.variants.some(variant => variant.age === age)) throw new Error(`MISSING_AGE:${required.id}:${age}`);
  for (const action of required.requiredAnimations ?? []) if (!asset.clips.some(clip => clip.id === action)) throw new Error(`MISSING_ANIMATION:${required.id}:${action}`);
}
for (const id of requirements.environmentAssets) if (!bundle.assets[id]) throw new Error(`MISSING_ENVIRONMENT:${id}`);
const icons = generateUiAssets(), audio = generateAudioAssets();
const uiRequired = requirements.uiAssets.flatMap(id => id === 'age_icons_1_to_4' ? [1, 2, 3, 4].map(age => `age_icon_${age}`) : id === 'age_icons_5_to_8' ? [5,6,7,8].map(age=>`age_icon_${age}`) : id === 'eleven_team_heraldry_patterns' ? Array.from({ length: 11 }, (_, index) => `team_heraldry_${index}`) : [id]);
for (const id of uiRequired) if (!icons.some(icon => icon.id === id)) throw new Error(`MISSING_ICON:${id}`);
for (const id of requirements.audioAssets) if (!audio.some(cue => cue.id === id)) throw new Error(`MISSING_AUDIO:${id}`);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const root = 'apps/client/public';
await mkdir(`${root}/art/icons`, { recursive: true }); await mkdir(`${root}/art/audio`, { recursive: true });
const payload = JSON.stringify(bundle) + '\n', bundlePath = '/art/frontier-assets.json';
await writeFile(root + bundlePath, payload);
const ui = [];
for (const icon of icons) { const bytes = icon.svg + '\n', path = `/art/icons/${icon.id}.svg`; await writeFile(root + path, bytes); ui.push({ id: icon.id, path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes), sourceGenerator: 'packages/assets/src/ui.ts' }); }
const audioFiles = [];
for (const cue of audio) { const path = `/art/audio/${cue.id}.wav`; await writeFile(root + path, cue.wav); audioFiles.push({ id: cue.id, path, bytes: cue.wav.byteLength, sha256: hash(cue.wav), durationSeconds: cue.durationSeconds, sampleRate: cue.sampleRate, channels: 1, sourceGenerator: 'packages/assets/src/audio.ts' }); }
const sourcePaths = (await readdir('packages/assets/src')).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).sort().map(file => `packages/assets/src/${file}`);
sourcePaths.push('scripts/assets.ts');
const sourceGenerators = [];
for (const path of sourcePaths) { const bytes = await readFile(path); sourceGenerators.push({ path, bytes: bytes.length, sha256: hash(bytes) }); }
const catalog = Object.values(bundle.assets).map(asset => ({ id: asset.id, kind: asset.kind, path: `${bundlePath}#assets/${asset.id}`, sourceGenerator: `packages/assets/src/${asset.kind === 'building' ? 'buildings' : asset.kind === 'unit' ? 'units' : 'environment'}.ts`, clips: asset.clips.map(clip => clip.id), collision: asset.collision ?? null,
  variants: asset.variants.map(variant => ({ key: variant.key, age: variant.age, tier: variant.tier, lodTriangles: ([0, 1, 2] as Lod[]).map(lod => inspectAssetPose(bundle, asset, variant, { lod, state: 'complete' as AssetState, action: 'idle' }).triangles) })),
  requiredStates: requirements.buildingAssets.find(required => required.id === asset.id)?.requiredStates ?? [],
}));
// Inventory generation verifies structure, not complete visual or performance quality.
const bundleSha256 = hash(payload);
const visualReview = { status: 'REVIEW_REQUIRED', evidence: 'docs/TESTING.md', scope: 'Automated geometry and catalog checks do not establish exhaustive visual review across ages, states, animations and levels of detail.' };
const manifest = { schemaVersion: 2, contentHash, catalogContentHash:assetCatalogContentHash, status: 'GENERATED_ORIGINAL_ASSETS', qualification: 'Generated asset inventory; visual quality, browser support and match performance require separate testing.', visualReview, format: 'Original indexed geometry and hierarchical animation recipes; metres, Y up, +Z forward.', bundle: { path: bundlePath, bytes: Buffer.byteLength(payload), compressedBytes: gzipSync(payload).byteLength, sha256: bundleSha256 }, sourceGenerators, catalog, ui, audio: audioFiles };
await writeFile(`${root}/asset-manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ event: 'original_assets_generated', assets: catalog.length, geometryBuffers: Object.keys(bundle.geometries).length, icons: icons.length, audio: audio.length, bundleBytes: manifest.bundle.bytes, bundleGzipBytes: manifest.bundle.compressedBytes, totalAudioBytes: audioFiles.reduce((n, file) => n + file.bytes, 0), contentHash, note: 'This inventory build alone is not visual/performance qualification.' }, null, 2));
