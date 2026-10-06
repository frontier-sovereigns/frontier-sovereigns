import { afterEach,describe,expect,it } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { Navigation } from '../../../packages/simulation/src/navigation.js';
import { PathScheduler } from '../../../packages/simulation/src/path-scheduler.js';
import { RemotePathScheduler } from '../../../packages/simulation/src/parallel-path-scheduler.js';
import { PathWorkerPool } from './path-worker-pool.js';

const pools:PathWorkerPool[]=[],timers=new Set<NodeJS.Timeout>();
afterEach(async()=>{for(const timer of timers)clearTimeout(timer);timers.clear();await Promise.all(pools.splice(0).map(pool=>pool.close()));});
type Slot={worker:Worker};
const internals=(pool:PathWorkerPool)=>pool as unknown as {slots:Slot[];spawn(slot:Slot):void};
async function fixture(options:ConstructorParameters<typeof PathWorkerPool>[0]={}){
  const profile='p1',geometry=[{profile,revision:1,widthMm:64000,heightMm:64000,obstacles:[]}],navigation=new Navigation(64000,64000,[]);
  const expected=new PathScheduler(()=>navigation,[profile]),pool=new PathWorkerPool({workerCount:1,...options});pools.push(pool);
  const remote=await RemotePathScheduler.create([profile],expected.exportState(),geometry,pool);
  for(const scheduler of [expected,remote])scheduler.request({id:'route',unitId:'unit',orderRevision:1,profile,from:{xMm:4000,zMm:4000},target:{xMm:56000,zMm:50000},radiusMm:350,workClass:'interactive',enqueuedTick:1});
  for(let tick=1;tick<=5;tick++){expected.advance(4,tick);await remote.advanceAsync(4,geometry,[],tick);}
  return {pool,remote,expected,geometry};
}

describe('compute recovery deadlines',()=>{
  it.each(['periodic','boundary'] as const)('recovers a lost %s checkpoint reply without applying an acknowledged grant twice',async kind=>{
    const {pool,remote,expected,geometry}=await fixture({timeoutMs:1000,recoveryTimeoutMs:6000,checkpointEvery:6});
    const worker=internals(pool).slots[0]!.worker,emit=worker.emit.bind(worker);let dropped=false;
    worker.emit=((event:string|symbol,...args:unknown[])=>{
      const reply=args[0] as {value?:{reply?:{batchId?:number}}}|undefined;
      if(event==='message'&&!dropped&&reply?.value?.reply?.batchId===6){dropped=true;return false;}
      return emit(event,...args);
    }) as typeof worker.emit;
    if(kind==='periodic'){
      expected.advance(4,6);await remote.advanceAsync(4,geometry,[],6);
    }else{
      for(const scheduler of [expected,remote]){
        scheduler.cancel('unit');scheduler.request({id:'replacement',unitId:'unit',orderRevision:2,profile:'p1',from:{xMm:5000,zMm:4000},target:{xMm:54000,zMm:50000},radiusMm:350,workClass:'interactive',enqueuedTick:6});
      }
      await remote.synchronizeCapture(geometry);
    }
    expect(dropped).toBe(true);await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());
    expect(pool.diagnostics().workers[0]).toMatchObject({acknowledgedBatch:6,retainedBatches:0,recoveries:1});
    const report=expected.advance(4,7);expect(await remote.advanceAsync(4,geometry,[],7)).toEqual(report);
    await remote.synchronizeCapture();expect(remote.exportState()).toEqual(expected.exportState());
  });

  it('retains checkpoint geometry across later edits and restores it before replaying history',async()=>{
    const {pool,remote,expected,geometry}=await fixture({timeoutMs:1000,recoveryTimeoutMs:6000,checkpointEvery:64});
    await remote.synchronizeCapture();
    const barrier={id:'new-wall',xMm:32000,zMm:30000,halfWidth:2000,halfHeight:4000};
    const updated=[{...geometry[0]!,revision:2,obstacles:[barrier]}];
    await remote.advanceAsync(1,updated,[],6);
    const owned=internals(pool) as unknown as {slots:Array<{worker:Worker;checkpoint:{geometry:typeof updated};geometry:typeof updated}>};
    const slot=owned.slots[0]!;
    expect(slot.checkpoint.geometry[0]!.obstacles).toEqual([]);
    expect(slot.geometry[0]!.obstacles).toEqual([barrier]);
    barrier.xMm=999999; // caller mutation must not corrupt retained geometry
    expect(slot.geometry[0]!.obstacles[0]!.xMm).toBe(32000);
    // A later explicit checkpoint contains the detached edit; older snapshots
    // remain independent and recovery of acknowledged batches stays exact.
    const prior=slot.checkpoint.geometry;await remote.synchronizeCapture();
    expect(prior[0]!.obstacles).toEqual([]);expect(slot.checkpoint.geometry[0]!.obstacles[0]!.xMm).toBe(32000);
    const snapshot=remote.exportState(),worker=slot.worker,post=worker.postMessage.bind(worker);let dropped=false;
    worker.postMessage=(message:any)=>{if(message.type==='advance'&&!dropped){dropped=true;return;}post(message);};
    await remote.advanceAsync(0,[{...updated[0]!,obstacles:[{...barrier,xMm:32000}]}],[],7);
    await remote.synchronizeCapture();const restored=remote.exportState();
    expect(restored.tasks).toEqual(snapshot.tasks);expect(restored.regions).toEqual(snapshot.regions);expect(restored.routes).toEqual(snapshot.routes);
    expect(pool.diagnostics().workers[0]!.recoveries).toBe(1);
    expect(expected.exportState().tasks.length).toBeGreaterThan(0);
  });

  it('boots a real worker and replays acknowledged history after a dropped request without duplicating work',async()=>{
    const {pool,remote,expected,geometry}=await fixture({timeoutMs:1000,recoveryTimeoutMs:6000,performanceDiagnostics:true});
    const worker=internals(pool).slots[0]!.worker,post=worker.postMessage.bind(worker);let dropped=false;
    worker.postMessage=(message:any)=>{if(message.type==='advance'&&!dropped){dropped=true;return;}post(message);};
    expected.advance(4,6);await remote.advanceAsync(4,geometry,[],6);await remote.synchronizeCapture();
    expect(remote.exportState()).toEqual(expected.exportState());expect(pool.diagnostics().workers[0]!.recoveries).toBe(1);
    const trace=pool.diagnostics().trace!,timeout=trace.rows.find(row=>row.kind==='request'&&row.operation==='advance'&&row.outcome==='timeout');
    expect(timeout).toMatchObject({batchId:6});expect(timeout!.workerStartedAtMs).toBeUndefined();expect(timeout!.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(trace.rows.some(row=>row.operation==='advance'&&row.batchId===6&&row.outcome==='completed'&&row.generation!>timeout!.generation!)).toBe(true);expect(trace.active).toEqual([]);
  });

  it.each(['advance','capture'] as const)('bounds the complete %s recovery including multiple individually timely replay replies',async operation=>{
    const {pool,remote,geometry}=await fixture({timeoutMs:1000,recoveryTimeoutMs:1600});
    const owned=internals(pool),old=owned.slots[0]!.worker,post=old.postMessage.bind(old);
    let dropped=false;
    old.postMessage=(message:any)=>{if(!dropped){dropped=true;return;}post(message);};
    const spawn=owned.spawn.bind(owned);let replayRequests=0;
    owned.spawn=slot=>{
      spawn(slot);const worker=slot.worker,send=worker.postMessage.bind(worker);
      worker.postMessage=(message:any)=>{
        if(message.type!=='advance'){send(message);return;}
        replayRequests++;
        // Each response delay is below the individual 1s timeout; the history
        // cannot restart the overall 1.6s operation budget for every reply.
        const timer=setTimeout(()=>{timers.delete(timer);if(worker.threadId>0)send(message);},350);timers.add(timer);
      };
    };
    const started=performance.now(),pending=operation==='advance'?remote.advanceAsync(4,geometry,[],6):pool.capture();
    await expect(pending).rejects.toThrow('PATH_COMPUTE_DEADLINE_EXCEEDED');
    expect(performance.now()-started).toBeLessThan(2400);expect(replayRequests).toBeGreaterThan(0);
    await expect(pool.capture()).rejects.toThrow('PATH_POOL_CLOSED');
    await expect(remote.advanceAsync(4,geometry,[],7)).rejects.toThrow('PATH_POOL_CLOSED');
  });
});
