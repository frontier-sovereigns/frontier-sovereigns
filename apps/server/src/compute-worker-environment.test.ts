import { expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { computeWorkerEnvironment } from './compute-worker-environment.js';

it('copies only operating-system/module-loading environment and excludes credentials and preload options', () => {
  const source = { Path: 'safe-path', SystemRoot: 'safe-system-root', WINDIR: 'safe-windows', TEMP: 'safe-temp', TMP: 'safe-tmp', NODE_ENV: 'test',
    AI_API_KEY: 'fixture-secret', AI_BASE_URL: 'fixture-endpoint', HOST_ADMIN_BOOTSTRAP_TOKEN: 'fixture-token', NODE_OPTIONS: '--require unexpected', FRONTIER_PATH_WORKERS: '2' };
  expect(computeWorkerEnvironment(source)).toEqual({ Path: 'safe-path', SystemRoot: 'safe-system-root', WINDIR: 'safe-windows', TEMP: 'safe-temp', TMP: 'safe-tmp', NODE_ENV: 'test' });
  const copy = computeWorkerEnvironment(source); copy.Path = 'changed'; expect(source.Path).toBe('safe-path');
});

it('supplies the same allowlist to an actual isolated Node worker', async () => {
  const env = computeWorkerEnvironment({ ...process.env, AI_API_KEY: 'test-only-sentinel', NODE_OPTIONS: '--require invalid-test-module' });
  const worker = new Worker("const {parentPort}=require('node:worker_threads');parentPort.postMessage(Object.keys(process.env));", { eval: true, env });
  try {
    const keys = await new Promise<string[]>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    expect(keys.every(key => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'NODE_ENV'].includes(key.toUpperCase()))).toBe(true);
    expect(keys).not.toContain('AI_API_KEY'); expect(keys).not.toContain('NODE_OPTIONS');
  } finally { await worker.terminate(); }
});

it('prevents env-file and preload inheritance at every real compute-worker constructor', async () => {
  const root = resolve('runtime-data/worker-environment-tests'); await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'case-')), envFile = join(directory, 'fixture.env'), preload = join(directory, 'fixture.cjs'), driver = join(directory, 'driver.mjs');
  const moduleUrl = (name: string) => JSON.stringify(pathToFileURL(resolve('apps/server/src', name)).href);
  // Only synthetic secrets exist here. No real .env file is opened or copied.
  const probe = `const {parentPort}=require('node:worker_threads');parentPort.postMessage({envFile:Object.hasOwn(process.env,'FRONTIER_FIXTURE_SECRET'),preload:globalThis.frontierFixturePreload===true,envKeys:Object.keys(process.env)});`;
  try {
    await writeFile(envFile, 'FRONTIER_FIXTURE_SECRET=synthetic-test-value\n');
    await writeFile(preload, 'globalThis.frontierFixturePreload=true;\n');
    await writeFile(driver, `
import threads from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {tsImport} from 'tsx/esm/api';
const NativeWorker=threads.Worker,observed=[];
threads.Worker=class extends NativeWorker{
  constructor(source,options){
    super(source,options);
    const text=String(source),name=['publication-worker','path-worker','vision-worker'].find(name=>text.includes(name))??(text.includes('/worker.ts')||text.includes('/worker.js')?'simulation-worker':undefined);
    if(name)observed.push({name,options});
  }
};
syncBuiltinESMExports();
const [{PublicationWorker},{PathWorkerPool},{VisionWorkerPool},{SimulationBridge},{computeWorkerEnvironment}]=await Promise.all([
  tsImport(${moduleUrl('publication-pool.ts')},import.meta.url),tsImport(${moduleUrl('path-worker-pool.ts')},import.meta.url),
  tsImport(${moduleUrl('vision-worker-pool.ts')},import.meta.url),tsImport(${moduleUrl('bridge.ts')},import.meta.url),
  tsImport(${moduleUrl('compute-worker-environment.ts')},import.meta.url)
]);
const publication=new PublicationWorker(),path=new PathWorkerPool({workerCount:1}),vision=new VisionWorkerPool({size:1}),bridge=new SimulationBridge({planningWorkers:0,visionWorkers:0});
try{
  await Promise.all([publication.ready,path.initialize(['blue'],{version:1,tasks:[],regions:[],revisions:{},routes:[],cursor:0,profileCursors:{}},[{profile:'blue',revision:0,widthMm:32000,heightMm:32000,obstacles:[]}])]);
}finally{await Promise.all([publication.close(),path.close(),vision.close(),bridge.close()]);}
async function probe(options){
  const worker=new NativeWorker(${JSON.stringify(probe)},{...options,eval:true});
  try{return await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});}finally{await worker.terminate();}
}
const negativeControl=await probe({env:computeWorkerEnvironment()});
const constructors=[];
for(const {name,options}of observed)constructors.push({name,execArgv:options.execArgv,...await probe(options)});
console.log(JSON.stringify({negativeControl,constructors}));
`);
    const { stdout } = await promisify(execFile)(process.execPath, [`--env-file-if-exists=${envFile}`, '--require', preload, driver],
      { env: computeWorkerEnvironment(), windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as { negativeControl: { envFile: boolean; preload: boolean }; constructors: { name: string; execArgv: string[]; envFile: boolean; preload: boolean; envKeys: string[] }[] };
    expect(result.negativeControl).toMatchObject({ envFile: true, preload: true });
    expect(result.constructors.map(item => item.name).sort()).toEqual(['path-worker', 'publication-worker', 'simulation-worker', 'vision-worker']);
    for (const item of result.constructors) {
      expect(item, item.name).toMatchObject({ execArgv: [], envFile: false, preload: false });
      expect(item.envKeys.every(key => ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'NODE_ENV'].includes(key.toUpperCase())), item.name).toBe(true);
    }
  } finally {
    for (const file of [driver, preload, envFile]) await unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(directory);
  }
}, 45000);
