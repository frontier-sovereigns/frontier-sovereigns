import { expect, it, vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { SimulationBridge } from '../apps/server/src/bridge.js';
import type {JournalEvent,SimulationSavePayload} from '../packages/simulation/src/persistence-types.js';

it('keeps coarse visibility inline by default and runs its explicit worker opt-in',async()=>{
  vi.stubEnv('FRONTIER_COARSE_VISION_WORKERS','0');
  try{
    expect(()=>new SimulationBridge({coarseVisionWorkers:-1})).toThrow('INVALID_COMPUTE_WORKER_COUNT');
    for(const coarseVisionWorkers of [undefined,1]){
      const bridge=new SimulationBridge({planningWorkers:0,visionWorkers:2,authoritativeIntervalMs:300,performanceDiagnostics:true,...(coarseVisionWorkers===undefined?{}:{coarseVisionWorkers})});
      try{
        await bridge.init({matchId:'coarse-vision-bridge',seed:'coarse-vision-bridge',controllers:false,factions:[
          {id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},
          {id:'b',name:'B',teamId:'b',color:'#ee5533',kind:'human'},
        ]});
        expect((await bridge.diagnostics()).compute?.vision).toMatchObject({mode:coarseVisionWorkers?'threads':'inline',threadIds:coarseVisionWorkers?[expect.any(Number)]:[]});
        await bridge.status('RUNNING');
        await expect.poll(async()=>(await bridge.diagnostics()).tick,{timeout:10000}).toBeGreaterThanOrEqual(6);
        await bridge.status('PAUSED');
        const measured=await bridge.request<{compute:{vision:{completed:number}|null}}>('performance-diagnostics');
        if(coarseVisionWorkers)expect(measured.compute.vision!.completed).toBeGreaterThanOrEqual(6);
        else expect(measured.compute.vision).toBeNull();
      }finally{await bridge.close();}
    }
    vi.stubEnv('FRONTIER_COARSE_VISION_WORKERS','9');
    expect(()=>new SimulationBridge()).toThrow('INVALID_COMPUTE_WORKER_COUNT');
  }finally{vi.unstubAllEnvs();}
});

it('bounds dense-map initialization separately without extending live control deadlines',async()=>{
  const bridge=new SimulationBridge({planningWorkers:0,visionWorkers:0}),posted:{type:string;requestExpiresAtMs:number}[]=[];
  const worker=(bridge as unknown as {worker:{postMessage(message:unknown):void}}).worker;
  const post=vi.spyOn(worker,'postMessage').mockImplementation(message=>{posted.push(message as typeof posted[number]);});
  vi.useFakeTimers();
  try{
    let started=false,controlled=false;
    const init=bridge.request('init').catch(error=>{started=true;return (error as Error).message;});
    const control=bridge.request('status',{status:'PAUSED'}).catch(error=>{controlled=true;return (error as Error).message;});
    expect(posted.map(message=>message.type)).toEqual(['init','status']);
    expect(posted[0]!.requestExpiresAtMs-posted[1]!.requestExpiresAtMs).toBeGreaterThan(14990);
    await vi.advanceTimersByTimeAsync(15000);expect(controlled).toBe(true);expect(started).toBe(false);expect(await control).toBe('WORKER_TIMEOUT');
    await vi.advanceTimersByTimeAsync(15000);expect(started).toBe(true);expect(await init).toBe('WORKER_TIMEOUT');
  }finally{vi.useRealTimers();post.mockRestore();await bridge.close();}
});

it('flushes native background-planning admission before returning a capture at that journal ordinal',async()=>{
  const bridge=new SimulationBridge({planningWorkers:2,visionWorkers:0,authoritativeIntervalMs:300}),events:JournalEvent[]=[],failures:Error[]=[];
  let requestedAt:number|undefined,captured:Promise<{payload:SimulationSavePayload;flushedOrdinal:number}>|undefined;
  bridge.onFailure=error=>failures.push(error);
  bridge.onJournal=batch=>{
    events.push(...batch.events);
    const start=batch.events.find(event=>event.kind==='planning_service_start');
    if(start&&requestedAt===undefined){
      requestedAt=start.ordinal;
      // The service has started, and no following committed boundary has
      // admitted it yet. Capture must drain it and flush the resulting event
      // before its response becomes visible to the journal/save coordinator.
      captured=bridge.capture().then(payload=>({payload,flushedOrdinal:events.at(-1)?.ordinal??0}));
    }
  };
  try{
    await bridge.init({matchId:'capture-planning-journal',seed:'capture-planning-journal',controllers:false,factions:[
      {id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},
      {id:'b',name:'B',teamId:'b',color:'#ee5533',kind:'human'},
    ]});
    await bridge.status('RUNNING');
    await expect.poll(()=>captured!==undefined,{timeout:10000}).toBe(true);
    const result=await captured!;
    expect(result.payload.state.eventOrdinal).toBeGreaterThan(requestedAt!);
    expect(result.flushedOrdinal).toBeGreaterThanOrEqual(result.payload.state.eventOrdinal);
    expect(events.some(event=>event.kind==='planning_service_admit'&&event.ordinal>requestedAt!&&event.ordinal<=result.payload.state.eventOrdinal)).toBe(true);
    expect(failures).toEqual([]);
    await bridge.status('PAUSED');
  }finally{await bridge.close();}
},20000);

it('passes the default adaptive and explicit strict pacing policies to real worker isolates',async()=>{
  vi.stubEnv('FRONTIER_OVERLOAD_POLICY','adaptive');
  vi.stubEnv('FRONTIER_FRAME_MS','300');
  try{
    for(const overloadPolicy of [undefined,'pause'] as const){
      const bridge=new SimulationBridge({planningWorkers:0,visionWorkers:0,...(overloadPolicy?{overloadPolicy}:{})});
      try{expect(await bridge.diagnostics()).toMatchObject({pacing:{policy:overloadPolicy??'adaptive',speedPercent:100,tickIntervalMs:300,authoritativeIntervalMs:300,reductions:0,selfPaced:false,deferredWallMs:0}});}
      finally{await bridge.close();}
    }
    vi.stubEnv('FRONTIER_OVERLOAD_POLICY','invalid');
    expect(()=>new SimulationBridge({planningWorkers:0,visionWorkers:0})).toThrow('INVALID_OVERLOAD_POLICY');
    const strict=new SimulationBridge({planningWorkers:0,visionWorkers:0,overloadPolicy:'pause'});
    try{expect(await strict.diagnostics()).toMatchObject({pacing:{policy:'pause'}});}finally{await strict.close();}
    const fast=new SimulationBridge({planningWorkers:0,visionWorkers:0,overloadPolicy:'pause',authoritativeIntervalMs:50});
    try{expect(await fast.diagnostics()).toMatchObject({pacing:{authoritativeIntervalMs:50,tickIntervalMs:50}});}finally{await fast.close();}
  }finally{vi.unstubAllEnvs();}
});

it('reports an unexpected worker exit while idle and rejects subsequent work', async () => {
  const bridge = new SimulationBridge(), failures: Error[] = [];
  bridge.onFailure = error => failures.push(error);
  try {
    // The test terminates only the worker it just created, with no request pending.
    const worker = (bridge as unknown as { worker: Worker }).worker;
    await new Promise<void>(resolve => worker.once('online', resolve));
    await worker.terminate();
    await expect.poll(() => failures.length).toBe(1);
    expect(failures[0]!.message).toBe('WORKER_EXITED');
    await expect(bridge.capture()).rejects.toThrow('WORKER_UNAVAILABLE');
  } finally { await bridge.close(); }
});

it('does not report an intentional shutdown as a simulation failure', async () => {
  const bridge = new SimulationBridge(), failures: Error[] = [];
  bridge.onFailure = error => failures.push(error);
  await bridge.close(); expect(failures).toEqual([]);
  await expect(bridge.capture()).rejects.toThrow('WORKER_UNAVAILABLE');
});

it('preserves native worker burst reply order, duplicate receipts and exactly-once authoritative commands', async () => {
  const bridge = new SimulationBridge({ planningWorkers: 0, visionWorkers: 0 }), failures: Error[] = [], completions: number[] = [], commandEvents: unknown[] = [];
  bridge.onFailure = error => failures.push(error);
  bridge.onJournal = batch => commandEvents.push(...batch.events.filter(event => event.kind === 'command'));
  try {
    await bridge.init({ matchId: 'native-command-burst', seed: 'native-command-burst', controllers: false, factions: [
      { id: 'a', name: 'A', teamId: 'a', color: '#3388ff', kind: 'human' },
      { id: 'b', name: 'B', teamId: 'b', color: '#ff8844', kind: 'human' },
    ] });
    const before = await bridge.capture(), unitIds = Object.values(before.state.entities).filter(entity => entity.kind === 'unit' && entity.ownerId === 'a').slice(0, 2).map(entity => entity.id);
    expect(unitIds).toHaveLength(2);
    const first = { protocolVersion: 2, matchId: before.state.matchId, matchEpoch: before.state.matchEpoch, clientCommandId: 'native-first', clientSequence: 1,
      command: { kind: 'move', unitIds, target: { xMm: before.state.widthMm / 2, zMm: before.state.heightMm / 2 }, queued: false } };
    const changed = { ...first, command: { ...first.command, target: { ...first.command.target, xMm: first.command.target.xMm + 1000 } } };
    const next = { ...changed, clientCommandId: 'native-next', clientSequence: 2 };
    await bridge.status('RUNNING');
    // All calls are posted together through the real MessagePort. No sender,
    // simulation method, clock or admission callback is replaced in this test.
    const receipts = await Promise.all([first, first, changed, next].map((command, index) => bridge.command('a', command).then(receipt => { completions.push(index); return receipt; })));
    await bridge.status('PAUSED');
    const after = await bridge.capture();
    expect(completions).toEqual([0, 1, 2, 3]);
    expect(receipts[0]).toMatchObject({ status: 'accepted', code: 'OK', clientCommandId: 'native-first', sequence: 1 });
    expect(receipts[1]).toEqual(receipts[0]);
    expect(receipts[2]).toMatchObject({ status: 'rejected', code: 'COMMAND_ID_REUSED', clientCommandId: 'native-first', sequence: 1 });
    expect(receipts[3]).toMatchObject({ status: 'accepted', code: 'OK', clientCommandId: 'native-next', sequence: 2 });
    expect(after.state.economies.a!.lastClientSequence).toBe(2);
    expect(after.state.commandLog.map(entry => entry.envelope)).toEqual([first, next]);
    expect(commandEvents).toHaveLength(4);
    expect(commandEvents).toMatchObject(receipts.map(receipt => ({ kind: 'command', playerId: 'a', source: 'human', receipt })));
    expect(failures).toEqual([]);
  } finally { await bridge.close(); }
}, 20000);
