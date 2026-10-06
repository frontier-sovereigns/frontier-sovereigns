import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  for (const module of ['node:worker_threads', 'node:perf_hooks', 'node:os', './performance-diagnostics.js']) vi.doUnmock(module);
  vi.resetModules();
});

// Historical debt/cadence fixtures explicitly exercise the supported 50ms profile.
// Native 300ms cases opt in below; changing the default balance must not silently
// change the clock arithmetic or the behavior these assertions cover.
async function workerHarness(enabled: boolean,projectionTransfer=false,factionCount=2,overloadPolicy:'adaptive'|'pause'='pause',authoritativeIntervalMs:50|300=50) {
  vi.resetModules();
  let now = 0, timer!: () => Promise<void>|undefined, receive!: (message: any) => void;
  let immediateSerial = 0;
  const immediates = new Map<number, () => void>();
  const packets: any[] = [];
  const rawPackets: any[] = [];
  let postEffect: ((packet: any) => void) | undefined;
  vi.doMock('node:worker_threads', async () => ({ ...await vi.importActual<typeof import('node:worker_threads')>('node:worker_threads'), workerData: { performanceDiagnostics: enabled, projectionTransfer, planningWorkers: 0, visionWorkers: 0, overloadPolicy, authoritativeIntervalMs },
    // This deliberately remains a non-native port. Production must use its
    // detached fallback instead of trusting this callback as a clone boundary.
    parentPort: { on: (_event: string, listener: typeof receive) => { receive = listener; }, postMessage: (packet: unknown) => { rawPackets.push(packet); packets.push(structuredClone(packet)); postEffect?.(packet); } } }));
  vi.doMock('node:perf_hooks', () => ({ performance: { now: () => now } }));
  vi.doMock('./performance-diagnostics.js', async () => {
    const original = await vi.importActual<typeof import('./performance-diagnostics.js')>('./performance-diagnostics.js');
    return { ...original, diagnosticNow:()=>now, PerformanceDiagnostics: class extends original.PerformanceDiagnostics { constructor() { super(() => now); } },
      IsolateRuntimeDiagnostics: class { snapshot() { return { isolate: 'test-worker', closed: false }; } } };
  });
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: typeof timer) => { timer = callback; return 1; }) as unknown as typeof setInterval);
  vi.spyOn(globalThis, 'setImmediate').mockImplementation(((callback: () => void) => { const id = ++immediateSerial; immediates.set(id, callback); return id; }) as unknown as typeof setImmediate);
  vi.spyOn(globalThis, 'clearImmediate').mockImplementation(((id: number) => { immediates.delete(id); }) as unknown as typeof clearImmediate);
  // Execute the real worker module and real simulation with controlled delivery/clock.
  // No delay injection or test-only operation is added to the production worker.
  await import('./worker.js');
  let sequence = 0;
  const request = async (type: string, payload: Record<string, unknown> = {}, expectedError?:string) => {
    const id = ++sequence; receive({ ...payload, id, type });
    // Replies cross the actual serialized async boundary. The inline computation
    // control avoids introducing real threads into this controlled-clock harness.
    let reply: any;
    for (let turn = 0; turn < 1000 && !reply; turn++) {
      await Promise.resolve(); reply = packets.find(packet => packet.id === id);
      // Cooperatively service only boundary continuations; projection flushes
      // remain explicitly controlled by the publication tests below.
      if(turn%16===15)for(const [key,callback] of immediates)if(callback.name==='continueBoundaryMessages'){immediates.delete(key);callback();}
    }
    expect(reply, `No reply for ${type}`).toBeDefined(); expect(reply?.error).toBe(expectedError);
    await Promise.resolve(); await Promise.resolve(); return reply?.value;
  };
  const options = { matchId: 'overload-clock', seed: 'overload-clock', controllers: false, factions: Array.from({length:factionCount},(_,index)=>{
    const id=String.fromCharCode(97+index);return {id,name:id.toUpperCase(),teamId:id,color:index%2?'#ff8844':'#3388ff',kind:'human'};
  }) };
  await request('init', { options }); await request('subscribe', { playerIds: projectionTransfer?options.factions.map(faction=>faction.id):['a'] }); await request('status', { status: 'RUNNING' });
  const startAdvance = (at: number) => { now = at; return timer(); };
  const deliverImmediates = () => { const callbacks = [...immediates.values()]; immediates.clear(); for (const callback of callbacks) callback(); };
  return { request, options, packets, rawPackets, send:(message:unknown)=>receive(message), startAdvance, deliverImmediates,
    setTime:(at:number)=>{now=at;},
    setPostEffect: (effect: (packet: any) => void) => { postEffect = effect; },
    scheduledPublications: () => immediates.size,
    flushPublications: async () => { deliverImmediates(); await request('diagnostics'); },
    advance: async (at: number) => { await startAdvance(at); await request('diagnostics'); } };
}

it('uses detached publication payloads for a non-native parent port callback',async()=>{
  const worker=await workerHarness(false,true),{Simulation}=await import('@frontier/simulation');
  const raw=worker.rawPackets.find(packet=>packet.type==='projection-view'&&packet.playerId==='a'),delivered=worker.packets.find(packet=>packet.type==='projection-view'&&packet.playerId==='a');
  const resource=raw.transfer.patch.entities.upserts.find((entity:any)=>entity.kind==='resource');expect(resource).toBeDefined();
  const expectedAmount=resource.amount,resourceId=resource.id;resource.amount=-1;raw.transfer.patch.fields.fog.visible.length=0;
  const projected=vi.spyOn(Simulation.prototype,'publicationProjections'),transferred=vi.spyOn(Simulation.prototype,'publicationTransfers');
  const view=await worker.request('view',{playerId:'a'});expect(view.entities.find((entity:any)=>entity.id===resourceId).amount).toBe(expectedAmount);expect(view.fog.visible.length).toBeGreaterThan(0);
  await worker.request('status',{status:'PAUSED'});
  worker.send({type:'projection-credit',playerId:'a',generation:delivered.transfer.generation,revision:delivered.transfer.patch.revision});await worker.request('diagnostics');await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(1);expect(transferred).not.toHaveBeenCalled();
  const next=worker.packets.filter(packet=>packet.type==='projection-view'&&packet.playerId==='a').at(-1)!;
  expect(next.transfer.patch.entities.upserts).toEqual([]);expect(next.transfer.patch.fields.fog).toBeUndefined();expect(next.transfer.patch.header.status).toBe('PAUSED');
  expect(delivered.transfer.patch.entities.upserts.find((entity:any)=>entity.id===resourceId).amount).toBe(expectedAmount);expect(delivered.transfer.patch.fields.fog.visible.length).toBeGreaterThan(0);
});

it('keeps checkpoint replies detached when the parent port is an arbitrary callback',async()=>{
  const worker=await workerHarness(false,false,2,'pause',300),first=await worker.request('capture');
  const raw=worker.rawPackets.find(packet=>packet.value?.schemaVersion===1&&packet.value?.state?.tick===first.state.tick);expect(raw).toBeDefined();
  raw.value.state.economies.a.resources.food=0;raw.value.runtime.pathScheduler.tasks.length=0;raw.value.runtime.planningProfiles.length=0;
  const second=await worker.request('capture');expect(second).toEqual(first);expect(second.state.economies.a.resources.food).toBeGreaterThan(0);expect(second.runtime.planningProfiles).toHaveLength(2);
});

it('samples host world once, retains movement/reset semantics and keeps unit positions out of diagnostics',async()=>{
  const worker=await workerHarness(false,false,2,'pause',300),{Simulation}=await import('@frontier/simulation');
  let raw:InstanceType<typeof Simulation>|undefined;
  const original=Simulation.prototype.hostWorldDiagnostics,sample=vi.spyOn(Simulation.prototype,'hostWorldDiagnostics').mockImplementation(function(this:InstanceType<typeof Simulation>){raw=this;return original.call(this);});
  const first=await worker.request('diagnostics');expect(sample).toHaveBeenCalledTimes(1);expect(first.activity).toMatchObject({movingSinceLastSample:0,sampledTicks:0});
  const unit=Object.values(raw!.state.entities).find(entity=>entity.kind==='unit')!,tree=Object.values(raw!.state.entities).find(entity=>entity.kind==='resource')!;
  if(unit.kind!=='unit'||tree.kind!=='resource')throw new Error('DIAGNOSTIC_FIXTURE');
  const initialPosition={xMm:unit.xMm,zMm:unit.zMm};unit.xMm+=2;unit.taskState='gathering';unit.cooldown=3;tree.amount=0;raw!.state.tick+=6;
  const second=await worker.request('diagnostics');expect(sample).toHaveBeenCalledTimes(2);expect(second.activity).toMatchObject({movingSinceLastSample:1,sampledTicks:6,gathering:1,attackCooldownActive:1});expect(second.world.activeResourceNodes).toBe(first.world.activeResourceNodes-1);
  expect(await worker.request('diagnostics')).toMatchObject({activity:{movingSinceLastSample:0,sampledTicks:0}});
  unit.xMm+=1;expect(await worker.request('diagnostics')).toMatchObject({activity:{movingSinceLastSample:0,sampledTicks:0}});
  // A same-match epoch change resets the prior position baseline even if IDs
  // remain the same. Neither previous nor current coordinates reach the host.
  raw!.invalidateEpoch();unit.xMm+=10;raw!.state.tick+=6;
  const epoch=await worker.request('diagnostics');expect(epoch.activity).toMatchObject({movingSinceLastSample:0,sampledTicks:0});
  expect(JSON.stringify([first,second,epoch])).not.toMatch(/"(?:positions|xMm|zMm|secretIdKey|entities)"/);
  expect(first.world.activeResourceNodes).toBe(second.world.activeResourceNodes+1);
  await worker.request('init',{options:{...worker.options,matchId:'next-diagnostic-match'}});
  const reset=await worker.request('diagnostics');expect(reset.activity).toMatchObject({movingSinceLastSample:0,sampledTicks:0});
  expect(initialPosition.xMm).not.toBe(unit.xMm);
});

it('retains the exact guard trigger privately through pause/resume and clears it for a new match', async () => {
  const worker = await workerHarness(true);
  await worker.advance(50);
  await worker.advance(2100); // Exactly 2000 ms of debt: existing guard must allow four catch-up ticks.
  expect(await worker.request('diagnostics')).toMatchObject({ tick: 5, status: 'RUNNING' });
  await worker.advance(2301); // 2001 ms: pause before advancing or changing the epoch in the record.
  const diagnostics = await worker.request('diagnostics');
  expect(diagnostics).toMatchObject({ tick: 5, status: 'PAUSED', debtMs: 0 });
  expect(diagnostics).not.toHaveProperty('overload');
  const privateReport = await worker.request('performance-diagnostics'), history = privateReport.overload;
  expect(history.lastOverload).toMatchObject({ trigger: { tick: 5, epoch: 1, status: 'RUNNING', debtMs: 2001, gapBeforeMs: 201 },
    completedCallback: { endTick: 5, stepsMs: [] } });
  expect(history.lastOverload.precedingEvents.filter((event: any) => event.operation === 'timer').map((event: any) => event.stepsMs.length)).toEqual([1, 4]);
  expect(history.lastOverload.completedCallback.accounting).toMatchObject({ operation: 'timer', totalMs: 0, accountedMs: 0, remainderMs: 0 });
  expect(privateReport.worker.callbackAccounting.callbackKinds).toHaveProperty('init');
  expect(privateReport.worker.callbackAccounting.callbackKinds).toHaveProperty('status');
  expect(privateReport.worker.callbackAccounting.callbackKinds.timer.count).toBe(3);
  expect(privateReport.worker.counts.advancingCallbacksWith4Ticks).toBe(1);
  expect(privateReport.planning.scope).toBe('host-private-opt-in');
  expect(worker.packets.filter(packet => packet.type === 'view').every(packet => !JSON.stringify(packet.view).includes('lastOverload'))).toBe(true);
  const directView = await worker.request('view', { playerId: 'a' });
  expect(JSON.stringify(directView)).not.toMatch(/callbackAccounting|startHostMonotonicMs|planningDiagnostics/);
  const capture = await worker.request('capture');
  expect(JSON.stringify(capture)).not.toMatch(/callbackAccounting|startHostMonotonicMs|planningDiagnostics/);
  const callbackReport = (await worker.request('performance-diagnostics')).worker.callbackAccounting;
  expect(callbackReport.callbackKinds.view.count).toBe(1); expect(callbackReport.callbackKinds.capture.count).toBe(1);
  await worker.request('status', { status: 'RUNNING' }); await worker.advance(2351);
  expect((await worker.request('performance-diagnostics')).overload.lastOverload).toEqual(history.lastOverload);
  await worker.request('init', { options: { ...worker.options, matchId: 'next-match' } });
  expect((await worker.request('performance-diagnostics')).overload.lastOverload).toBeNull();
});

it('retains bounded production overload evidence with detailed diagnostics disabled', async () => {
  const worker = await workerHarness(false); await worker.advance(2051);
  const first=await worker.request('diagnostics');
  expect(first).toMatchObject({tick:0,status:'PAUSED',debtMs:0,runtime:{historyLimit:16,lastOverload:{tick:0,epoch:1,debtMs:2001,boundaryQueued:0,pendingCommands:0}}});
  expect(await worker.request('performance-diagnostics')).toBeNull();
  for(let i=0;i<20;i++)await worker.request('diagnostics');
  const bounded=await worker.request('diagnostics');expect(bounded.runtime.recentCallbacks).toHaveLength(16);
  expect(bounded.runtime.lastOverload).toEqual(first.runtime.lastOverload);
  expect(JSON.stringify(await worker.request('view',{playerId:'a'}))).not.toMatch(/lastOverload|recentCallbacks|phasesMs/);
  expect(JSON.stringify(await worker.request('capture'))).not.toMatch(/lastOverload|recentCallbacks|phasesMs/);
  await worker.request('status',{status:'RUNNING'});await worker.advance(2101);
  expect((await worker.request('diagnostics')).runtime.lastOverload).toEqual(first.runtime.lastOverload);
  await worker.request('init',{options:{...worker.options,matchId:'normal-next'}});
  expect((await worker.request('diagnostics')).runtime.lastOverload).toBeNull();
});

it('quietly reduces wall-clock speed without pausing, invalidating orders or changing fixed-tick state',async()=>{
  const slow=await workerHarness(false,false,2,'adaptive');
  const initial=await slow.request('capture'),unit=Object.values(initial.state.entities).find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit') as any;
  const command={protocolVersion:2,matchId:initial.state.matchId,matchEpoch:initial.state.matchEpoch,clientCommandId:'paced-stop',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}};
  slow.send({id:701,type:'command',playerId:'a',command});await slow.request('diagnostics');await slow.advance(2051);
  const actual=await slow.request('capture'),view=await slow.request('view',{playerId:'a'}),diagnostics=await slow.request('diagnostics');
  expect(actual.state).toMatchObject({tick:4,status:'RUNNING',matchEpoch:1});
  expect(slow.packets.find(packet=>packet.id===701).value).toMatchObject({status:'accepted',tick:0});
  expect(slow.packets.filter(packet=>packet.type==='status')).toEqual([]);
  expect(view.simulationSpeed).toBe(.9);expect(JSON.stringify(actual)).not.toMatch(/simulationSpeed|speedPercent|deferredWallMs/);
  expect(diagnostics).toMatchObject({status:'RUNNING',pacing:{policy:'adaptive',speedPercent:90,reductions:1,selfPaced:false,lastReduction:{tick:0,fromPercent:100,toPercent:90,debtMs:2001}},runtime:{lastOverload:{tick:0,epoch:1,debtMs:2001}}});
  expect(JSON.stringify(view)).not.toMatch(/lastOverload|speedPercent|deferredWallMs|lastReduction/);
  const normal=await workerHarness(false,false,2,'pause');
  normal.send({id:701,type:'command',playerId:'a',command});await normal.request('diagnostics');await normal.advance(200);
  expect(await normal.request('capture')).toEqual(actual);
  const expected=await normal.request('view',{playerId:'a'});delete view.simulationSpeed;expect(view).toEqual(expected);
});

it('restores saved movement cadence, coalesces routine poses, and admits commands between publications',async()=>{
  const worker=await workerHarness(false,false,2,'adaptive');
  const {sealSimulationCapture}=await import('@frontier/simulation'),{engineIdentity}=await import('./build-info.js');
  const payload=await worker.request('capture');payload.state.movementCadenceTier=3;
  for(const entity of Object.values(payload.state.entities) as any[])if(entity.kind==='unit')entity.autoGather=false;
  await worker.request('restore',{save:sealSimulationCapture(payload,engineIdentity),newEpoch:2});
  await worker.request('status',{status:'RUNNING'});
  const before=worker.packets.length;
  for(const at of [50,100,150,200])await worker.advance(at);
  expect(worker.packets.slice(before).filter(packet=>packet.type==='view').map(packet=>packet.view.tick)).toEqual([4]);
  const diagnostics=await worker.request('diagnostics');
  expect(diagnostics).toMatchObject({tick:4,pacing:{speedPercent:100,movementTier:3,publicationIntervalMs:200}});
  const view=worker.packets.filter(packet=>packet.type==='view').at(-1).view;
  expect(view.publicationIntervalMs).toBe(200);expect(view).not.toHaveProperty('movementCadenceTier');
  const unit=view.entities.find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit');
  worker.send({id:9901,type:'command',playerId:'a',command:{protocolVersion:2,matchId:view.matchId,matchEpoch:view.matchEpoch,clientCommandId:'cadence-stop',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}}});
  await worker.request('diagnostics');await worker.advance(210);
  expect(worker.packets.find(packet=>packet.id===9901)?.value).toMatchObject({status:'accepted',tick:4});
  expect((await worker.request('capture')).state.movementCadenceTier).toBe(3);
  await worker.request('status',{status:'PAUSED'});
  expect(worker.packets.filter(packet=>packet.type==='view').at(-1).view).toMatchObject({status:'PAUSED',tick:4,publicationIntervalMs:200});
});

it.each([{tier:1,interval:450,ticks:9},{tier:2,interval:600,ticks:12}] as const)('commits actual$interval ms frames and accepts commands between them',async({tier,interval,ticks})=>{
  const worker=await workerHarness(false,false,2,'adaptive',300);
  const {sealSimulationCapture}=await import('@frontier/simulation'),{engineIdentity}=await import('./build-info.js'),{validatePlayerView}=await import('@frontier/shared');
  const payload=await worker.request('capture');payload.state.movementCadenceTier=tier;
  for(const entity of Object.values(payload.state.entities) as any[])if(entity.kind==='unit')entity.autoGather=false;
  await worker.request('restore',{save:sealSimulationCapture(payload,engineIdentity),newEpoch:2});
  await worker.request('status',{status:'RUNNING'});
  await worker.advance(interval-1);expect((await worker.request('diagnostics')).tick).toBe(0);
  await worker.advance(interval);
  const view=await worker.request('view',{playerId:'a'});
  expect(view).toMatchObject({tick:ticks,committedTimeMs:interval,authoritativeIntervalMs:interval,publicationIntervalMs:interval});
  expect(validatePlayerView(view)).toBe(true);
  const unit=view.entities.find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit');
  worker.send({id:9901,type:'command',playerId:'a',command:{protocolVersion:2,matchId:view.matchId,matchEpoch:view.matchEpoch,clientCommandId:'coarse-stop',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}}});
  // Deliver the queued boundary message before the controlled10ms timer poll.
  await worker.request('diagnostics');
  await worker.advance(interval+10);
  expect(worker.packets.find(packet=>packet.id===9901)?.value).toMatchObject({status:'accepted',tick:ticks});
  await worker.advance(interval*2-1);expect((await worker.request('diagnostics')).tick).toBe(ticks);
  await worker.advance(interval*2);
  expect(await worker.request('diagnostics')).toMatchObject({tick:ticks*2,pacing:{speedPercent:100,authoritativeIntervalMs:interval,publicationIntervalMs:interval,tickIntervalMs:interval},frame:{authoritativeIntervalMs:interval,committedTimeMs:interval*2}});
});

it('retimes pending deadlines on coarse tier changes without granting early game time or discarding debt',async()=>{
  const worker=await workerHarness(false,false,2,'adaptive',300),{SimulationPacing}=await import('./simulation-pacing.js'),{validatePlayerView}=await import('@frontier/shared');
  const original=SimulationPacing.prototype.review;
  vi.spyOn(SimulationPacing.prototype,'review').mockImplementation(function(this:InstanceType<typeof SimulationPacing>,now,debt,tick){
    if(now===300){this.reset(1);return 'tier-changed';}
    if(now===600){this.reset(0);return 'tier-changed';}
    return original.call(this,now,debt,tick);
  });
  await worker.advance(300);expect((await worker.request('diagnostics')).tick).toBe(0);
  await worker.advance(449);expect((await worker.request('diagnostics')).tick).toBe(0);
  await worker.advance(450);expect((await worker.request('diagnostics')).tick).toBe(9);
  await worker.advance(600);expect((await worker.request('diagnostics')).tick).toBe(9);
  const changed=await worker.request('view',{playerId:'a'});expect(changed.authoritativeIntervalMs).toBe(300);expect(validatePlayerView(changed)).toBe(true);
  await worker.advance(749);expect((await worker.request('diagnostics')).tick).toBe(9);
  await worker.advance(750);expect((await worker.request('diagnostics')).tick).toBe(15);
  const events=worker.packets.filter(packet=>packet.type==='journal').flatMap(packet=>packet.batch.events).filter((event:any)=>event.kind==='movement_cadence');
  expect(events.map((event:any)=>[event.tick,event.tier])).toEqual([[0,1],[9,0]]);
});

it('automatically journals a cadence reduction after sustained advancing overload without pausing',async()=>{
  const worker=await workerHarness(false,false,2,'adaptive');
  const {Simulation}=await import('@frontier/simulation'),original=Simulation.prototype.stepAsync;
  let clock=2051;
  const cost=vi.spyOn(Simulation.prototype,'stepAsync').mockImplementation(async function(this:InstanceType<typeof Simulation>,...args){await original.apply(this,args);clock+=600;worker.setTime(clock);});
  let diagnostics:any;
  for(let callbacks=0;callbacks<150;callbacks++){
    await worker.advance(clock);diagnostics=await worker.request('diagnostics');
    if(diagnostics.pacing.movementTier===1)break;
    clock+=10;
  }
  expect(diagnostics).toMatchObject({status:'RUNNING',pacing:{movementTier:1,publicationIntervalMs:100,lastTierChange:{fromTier:0,toTier:1,reason:'sustained_overload'}}});
  expect(clock).toBeGreaterThan(60000);
  expect(worker.packets.filter(packet=>packet.type==='status')).toEqual([]);
  const transitions=worker.packets.filter(packet=>packet.type==='journal').flatMap(packet=>packet.batch.events).filter((event:any)=>event.kind==='movement_cadence');
  expect(transitions).toHaveLength(1);expect(transitions[0]).toMatchObject({phase:'boundary',tier:1,tick:diagnostics.pacing.lastTierChange.tick});
  expect((await worker.request('capture')).state).toMatchObject({movementCadenceTier:1,matchEpoch:1,status:'RUNNING'});
  cost.mockRestore();
});

it('admits commands between slowed ticks and preserves selected speed through manual pause and resume',async()=>{
  const worker=await workerHarness(false,false,2,'adaptive');await worker.advance(2051);
  await worker.request('status',{status:'PAUSED'});await worker.advance(10000);
  const paused=await worker.request('diagnostics');expect(paused).toMatchObject({tick:4,status:'PAUSED',debtMs:0,pacing:{speedPercent:90,reductions:1}});
  await worker.request('status',{status:'RUNNING'});
  const capture=await worker.request('capture'),unit=Object.values(capture.state.entities).find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit') as any;
  const command={protocolVersion:2,matchId:capture.state.matchId,matchEpoch:capture.state.matchEpoch,clientCommandId:'between-paced-ticks',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}};
  worker.send({id:702,type:'command',playerId:'a',command,requestExpiresAtMs:10030});await worker.request('diagnostics');
  await worker.advance(10010);
  expect(worker.packets.find(packet=>packet.id===702).value).toMatchObject({status:'accepted',tick:4});
  expect(await worker.request('diagnostics')).toMatchObject({tick:4,status:'RUNNING',pacing:{speedPercent:90,reductions:1}});
  await worker.advance(10056);expect(await worker.request('diagnostics')).toMatchObject({tick:5,pacing:{speedPercent:90,reductions:1}});
  const {sealSimulationCapture}=await import('@frontier/simulation'),{engineIdentity}=await import('./build-info.js');
  const save=sealSimulationCapture(await worker.request('capture'),engineIdentity);
  await worker.request('restore',{save,newEpoch:2});
  expect(await worker.request('diagnostics')).toMatchObject({pacing:{speedPercent:100,reductions:0,selfPaced:false,lastReduction:null}});
  expect(await worker.request('view',{playerId:'a'})).not.toHaveProperty('simulationSpeed');
});

it('stages repeated reductions, then bounds terminal catch-up without sending an overload pause',async()=>{
  const worker=await workerHarness(false,false,2,'adaptive');
  let at=2051;
  for(let cut=1;cut<=9;cut++){
    await worker.advance(at);
    expect(await worker.request('diagnostics')).toMatchObject({status:'RUNNING',pacing:{speedPercent:100-cut*10,reductions:cut,selfPaced:false}});
    at+=4000;
  }
  const before=await worker.request('capture');await worker.advance(at);
  const terminal=await worker.request('diagnostics');
  expect(terminal).toMatchObject({tick:before.state.tick+1,status:'RUNNING',debtMs:0,pacing:{speedPercent:10,reductions:9,selfPaced:true}});
  expect(terminal.pacing.deferredWallMs).toBeGreaterThan(0);
  await worker.advance(at+10000);const after=await worker.request('diagnostics');
  expect(after.tick).toBe(terminal.tick+1);expect(after.debtMs).toBe(0);expect(after.pacing.deferredWallMs).toBeGreaterThan(terminal.pacing.deferredWallMs);
  expect(worker.packets.filter(packet=>packet.type==='status')).toEqual([]);
  await worker.request('init',{options:{...worker.options,matchId:'fresh-pacing'}});
  expect(await worker.request('diagnostics')).toMatchObject({tick:0,pacing:{speedPercent:100,reductions:0,selfPaced:false,deferredWallMs:0}});
});

it.each(['healthy','pressured'] as const)('quietly restores one speed stage only with sustained headroom, preserving epoch and pause state (%s memory)',async memory=>{
  // The controlled-clock case must also control its external memory evidence.
  // A real low-RAM development host correctly inhibits recovery in production.
  vi.doMock('node:os',async()=>({...await vi.importActual<typeof import('node:os')>('node:os'),
    freemem:()=>memory==='healthy'?8*1024**3:512*1024**2,totalmem:()=>32*1024**3}));
  const worker=await workerHarness(false,false,2,'adaptive');await worker.advance(2051);
  await worker.request('status',{status:'PAUSED'});await worker.request('status',{status:'RUNNING'});
  const initial=await worker.request('capture');
  // Controlled clock, real worker and simulation. Each poll arrives near its
  // 90% deadline; unlike a long idle jump these are actual advancing callbacks.
  for(let sample=1;sample<=542;sample++)await worker.advance(2051+sample*(50/.9+.01));
  const recovered=await worker.request('diagnostics');
  expect(recovered,JSON.stringify(recovered.pacing)).toMatchObject({status:'RUNNING',pacing:{speedPercent:memory==='healthy'?100:90,recoveries:memory==='healthy'?1:0,memoryRecoveryBlocked:memory==='pressured'}});
  const current=await worker.request('capture');expect(current.state.matchEpoch).toBe(initial.state.matchEpoch);
  expect(current.state.tick).toBeGreaterThan(initial.state.tick+500);
  const view=await worker.request('view',{playerId:'a'});
  if(memory==='healthy')expect(view).not.toHaveProperty('simulationSpeed');
  else expect(view.simulationSpeed).toBe(.9);
  expect(worker.packets.filter(packet=>packet.type==='status')).toEqual([]);
});

it('yields a boundary request burst to the simulation timer without dropping or reordering requests',async()=>{
  const worker=await workerHarness(false);
  for(let id=1001;id<=1040;id++)worker.send({id,type:'diagnostics'});
  for(let i=0;i<80;i++)await Promise.resolve();
  const prefix=worker.packets.filter(packet=>packet.id>=1001&&packet.id<=1040);
  expect(prefix.map(packet=>packet.id)).toEqual(Array.from({length:16},(_,i)=>1001+i));
  expect(prefix.every(packet=>packet.value.tick===0)).toBe(true);
  await worker.startAdvance(50);
  const final=await worker.request('diagnostics');
  const replies=worker.packets.filter(packet=>packet.id>=1001&&packet.id<=1040);
  expect(replies.map(packet=>packet.id)).toEqual(Array.from({length:40},(_,i)=>1001+i));
  expect(replies.slice(16).every(packet=>packet.value.tick===1)).toBe(true);
  expect(final).toMatchObject({tick:1,status:'RUNNING',runtime:{boundaryYields:2}});
});

it.each(['stop','cancel_job','cancel_foundation'] as const)('promotes the player FIFO prefix for %s into the bounded command intake without bypassing validation',async kind=>{
  const worker=await workerHarness(false,false,2,'pause',300),before=await worker.request('capture');
  const own=(playerId:string,entityKind:string)=>Object.values(before.state.entities).find((entity:any)=>entity.ownerId===playerId&&entity.kind===entityKind) as any;
  const envelope=(playerId:string,sequence:number,command:any)=>({protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId:`priority-${playerId}-${sequence}`,clientSequence:sequence,command});
  const advancing=worker.startAdvance(300);
  for(let sequence=1;sequence<=40;sequence++)worker.send({id:1000+sequence,type:'command',playerId:'a',command:envelope('a',sequence,{kind:'hold_position',unitIds:[own('a','unit').id]})});
  worker.send({id:2001,type:'command',playerId:'b',command:envelope('b',1,{kind:'hold_position',unitIds:[own('b','unit').id]})});
  const urgent=kind==='stop'?{kind,unitIds:[own('b','unit').id]}:kind==='cancel_job'?{kind,buildingId:own('a','building').id,jobId:'absent-job'}:{kind,foundationId:own('a','building').id};
  worker.send({id:2002,type:'command',playerId:'b',command:envelope('b',2,urgent)});
  await advancing;for(let turn=0;turn<80;turn++)await Promise.resolve();
  await worker.startAdvance(301);
  const receipts=worker.packets.filter(packet=>packet.id>=1001&&packet.id<=2002);
  expect(receipts.map(packet=>packet.id)).toEqual([2001,2002,...Array.from({length:14},(_,index)=>1001+index)]);
  expect(receipts[0].value).toMatchObject({status:'accepted',sequence:1,tick:6});
  expect(receipts[1].value).toMatchObject({status:kind==='stop'?'accepted':'rejected',code:kind==='stop'?'OK':'INVALID_REFERENCE',sequence:2,tick:6});
  await worker.request('diagnostics');await worker.advance(302);
  const after=await worker.request('capture'),log=after.state.commandLog;
  expect(log.filter((entry:any)=>entry.playerId==='a').map((entry:any)=>entry.envelope.clientSequence)).toEqual(Array.from({length:40},(_,index)=>index+1));
  expect(log.map((entry:any)=>entry.sequence)).toEqual(Array.from({length:kind==='stop'?42:41},(_,index)=>index+1));
});

it('limits urgent promotion to four commands before serving the oldest unrelated command',async()=>{
  const worker=await workerHarness(false,false,2,'pause',300),before=await worker.request('capture');
  const unit=(playerId:string)=>(Object.values(before.state.entities).find((entity:any)=>entity.ownerId===playerId&&entity.kind==='unit') as any).id;
  const advancing=worker.startAdvance(300);
  for(const [playerId,count,kind,base]of [['a',40,'hold_position',1000],['b',12,'stop',2000]] as const)for(let sequence=1;sequence<=count;sequence++)worker.send({id:base+sequence,type:'command',playerId,command:{protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId:`fair-${playerId}-${sequence}`,clientSequence:sequence,command:{kind,unitIds:[unit(playerId)]}}});
  await advancing;for(let turn=0;turn<80;turn++)await Promise.resolve();await worker.startAdvance(301);
  const receipts=worker.packets.filter(packet=>packet.id>=1001&&packet.id<=2012);
  expect(receipts.map(packet=>packet.id)).toEqual([2001,2002,2003,2004,1001,2005,2006,2007,2008,1002,2009,2010,2011,2012,1003,1004]);
  expect(receipts.every(packet=>packet.value.status==='accepted'&&packet.value.tick===6)).toBe(true);
});

it('never promotes a stop across a capture RPC or changes its committed snapshot ordering',async()=>{
  const worker=await workerHarness(false,false,2,'pause',300),before=await worker.request('capture');
  const unit=(playerId:string)=>(Object.values(before.state.entities).find((entity:any)=>entity.ownerId===playerId&&entity.kind==='unit') as any).id;
  const envelope=(playerId:string,sequence:number,kind:string)=>({protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId:`fenced-${playerId}-${sequence}`,clientSequence:sequence,command:{kind,unitIds:[unit(playerId)]}});
  const advancing=worker.startAdvance(300);
  for(let sequence=1;sequence<=20;sequence++)worker.send({id:1000+sequence,type:'command',playerId:'a',command:envelope('a',sequence,'hold_position')});
  worker.send({id:1500,type:'capture'});worker.send({id:2001,type:'command',playerId:'b',command:envelope('b',1,'stop')});
  await advancing;for(let turn=0;turn<80;turn++)await Promise.resolve();await worker.startAdvance(301);
  expect(worker.packets.filter(packet=>packet.id>=1001&&packet.id<=2001).map(packet=>packet.id)).toEqual(Array.from({length:16},(_,index)=>1001+index));
  await worker.request('diagnostics');const captured=worker.packets.find(packet=>packet.id===1500).value;
  expect(captured.state.commandLog).toHaveLength(16);expect(captured.state.commandLog.every((entry:any)=>entry.playerId==='a')).toBe(true);
  await worker.advance(302);expect(worker.packets.find(packet=>packet.id===2001).value).toMatchObject({status:'accepted',sequence:1,tick:6});
});

it('rechecks expiry and deduplicates promoted stop receipts at authoritative admission',async()=>{
  const worker=await workerHarness(false,false,2,'pause',300),before=await worker.request('capture');
  const unit=(playerId:string)=>(Object.values(before.state.entities).find((entity:any)=>entity.ownerId===playerId&&entity.kind==='unit') as any).id;
  const envelope=(playerId:string,sequence:number,kind:string,clientCommandId=`urgent-${playerId}-${sequence}`)=>({protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId,clientSequence:sequence,command:{kind,unitIds:[unit(playerId)]}});
  const advancing=worker.startAdvance(300);
  for(let sequence=1;sequence<=40;sequence++)worker.send({id:1000+sequence,type:'command',playerId:'a',command:envelope('a',sequence,'hold_position')});
  worker.send({id:2001,type:'command',playerId:'b',command:envelope('b',1,'hold_position')});
  worker.send({id:2002,type:'command',playerId:'b',requestExpiresAtMs:300.5,command:envelope('b',2,'stop','urgent-expired')});
  for(const id of [2003,2004])worker.send({id,type:'command',playerId:'b',command:envelope('b',2,'stop')});
  await advancing;for(let turn=0;turn<80;turn++)await Promise.resolve();await worker.startAdvance(301);
  expect(worker.packets.find(packet=>packet.id===2001).value).toMatchObject({status:'accepted',sequence:1,tick:6});
  expect(worker.packets.find(packet=>packet.id===2002)).toMatchObject({error:'WORKER_TIMEOUT'});
  const accepted=worker.packets.find(packet=>packet.id===2003).value;expect(accepted).toMatchObject({status:'accepted',sequence:2,tick:6});
  expect(worker.packets.find(packet=>packet.id===2004).value).toEqual(accepted);
  const captured=await worker.request('capture');expect(captured.state.commandLog.filter((entry:any)=>entry.playerId==='b').map((entry:any)=>entry.envelope.clientCommandId)).toEqual(['urgent-b-1','urgent-b-2']);
});

it('accounts normal command admission in retained callback phases without enabling simulation hooks',async()=>{
  const worker=await workerHarness(false),{Simulation}=await import('@frontier/simulation');
  const before=await worker.request('capture'),unit=Object.values(before.state.entities).find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit') as any;
  const original=Simulation.prototype.command;
  vi.spyOn(Simulation.prototype,'command').mockImplementation(function(this:InstanceType<typeof Simulation>,...args){worker.setTime(57);return original.apply(this,args);});
  worker.send({id:777,type:'command',playerId:'a',command:{protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId:'normal-evidence',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}}});
  await worker.request('diagnostics');await worker.advance(50);
  const diagnostics=await worker.request('diagnostics'),timer=diagnostics.runtime.recentCallbacks.find((entry:any)=>entry.operation==='timer');
  expect(timer).toMatchObject({tick:0,endTick:1,durationMs:7,phasesMs:{commandDrain:7,coreStep:0}});
  expect(await worker.request('performance-diagnostics')).toBeNull();
  expect(worker.packets.find(packet=>packet.id===777).value.status).toBe('accepted');
});

it('does not flush an unchanged journal during command intake and retains admitted event order',async()=>{
  const worker=await workerHarness(false),{Simulation}=await import('@frontier/simulation'),before=await worker.request('capture');
  const unit=Object.values(before.state.entities).find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit') as any;
  const flush=vi.spyOn(Simulation.prototype,'drainJournal'),commands=vi.spyOn(Simulation.prototype,'command');
  for(let sequence=1;sequence<=3;sequence++)worker.send({id:8100+sequence,type:'command',playerId:'a',command:{protocolVersion:2,matchId:before.state.matchId,matchEpoch:before.state.matchEpoch,clientCommandId:`intake-journal-${sequence}`,clientSequence:sequence,command:{kind:'stop',unitIds:[unit.id]}}});
  for(let turn=0;turn<40;turn++)await Promise.resolve();expect(flush).not.toHaveBeenCalled();expect(commands).not.toHaveBeenCalled();
  await worker.startAdvance(1);expect(flush).toHaveBeenCalledTimes(1);expect(commands).toHaveBeenCalledTimes(3);
  const events=worker.packets.filter(packet=>packet.type==='journal').flatMap(packet=>packet.batch.events).filter((event:any)=>event.kind==='command');
  expect(events.map((event:any)=>event.envelope.clientCommandId)).toEqual(['intake-journal-1','intake-journal-2','intake-journal-3']);
  expect(worker.packets.filter(packet=>packet.id>=8101&&packet.id<=8103).map(packet=>packet.value.status)).toEqual(['accepted','accepted','accepted']);
});

it('supplies private renewal validity on the ordinary worker path and failure acknowledgement',async()=>{
  const worker=await workerHarness(false);
  await worker.request('init',{options:{...worker.options,controllers:true,factions:worker.options.factions.map((faction,index)=>index?{...faction,kind:'ai',difficulty:'medium',personality:'builder'}:faction)}});
  await worker.request('status',{status:'RUNNING'});
  const scheduling=await worker.request('ai-state');
  expect(scheduling.commanders).toHaveLength(1);
  expect(scheduling.commanders[0].renewal).toMatchObject({playerId:'b',tick:0,status:'RUNNING',mode:'fallback',plan:null});
  const dispatch=await worker.request('ai-prepare',{playerId:'b',requestId:'renewal-normal',chatRequestIds:[]});
  const reply=await worker.request('ai-complete',{binding:dispatch.binding,result:{kind:'failure',code:'CONNECTION_FAILED'}});
  expect(reply.renewal).toMatchObject({playerId:'b',tick:0,statistics:{inferenceFailures:1}});
  expect(await worker.request('performance-diagnostics')).toBeNull();
  expect(JSON.stringify(await worker.request('view',{playerId:'a'}))).not.toContain('controllerGeneration');
});

it('keeps authoritative captures and public views exact when callback accounting is enabled', async () => {
  const disabled = await workerHarness(false);
  await disabled.advance(50); await disabled.advance(200);
  const expectedView = await disabled.request('view', { playerId: 'a' }), expectedCapture = await disabled.request('capture');
  const enabled = await workerHarness(true);
  await enabled.advance(50); await enabled.advance(200);
  expect(await enabled.request('view', { playerId: 'a' })).toEqual(expectedView);
  expect(await enabled.request('capture')).toEqual(expectedCapture);
  await enabled.request('ai-state');
  const report = await enabled.request('performance-diagnostics');
  expect(report.worker.callbackAccounting.callbackKinds['ai-state'].count).toBe(1);
  expect(report.worker.callbackAccounting.absoluteReconciliationErrorMs).toBe(0);
});

it('queues capture and pause until a yielding tick commits and rejects reentrant timer execution', async () => {
  const worker = await workerHarness(true);
  worker.startAdvance(50);
  const capture = worker.request('capture'), pause = worker.request('status', { status: 'PAUSED' });
  // This callback arrives while the first tick awaits its asynchronous phase.
  worker.startAdvance(50);
  const saved = await capture; await pause;
  expect(saved.state).toMatchObject({ tick: 1, status: 'RUNNING' });
  expect(await worker.request('diagnostics')).toMatchObject({ tick: 1, status: 'PAUSED' });
  const report = await worker.request('performance-diagnostics');
  expect(report.worker.counts.advancedTicks).toBe(1);
  expect(report.worker.callbackAccounting.callbackKinds.timer.count).toBe(1);
  expect(report.worker.callbackAccounting.absoluteReconciliationErrorMs).toBe(0);
  const callbackOrder = report.overload.recentEvents.map((event: { operation: string }) => event.operation);
  expect(callbackOrder.indexOf('timer')).toBeLessThan(callbackOrder.indexOf('capture'));
});

it.each([50,300] as const)('rejects expired controls and captures queued behind a yielding %ims frame without applying them later',async(interval)=>{
  const worker=await workerHarness(false,false,2,'pause',interval);worker.startAdvance(interval);
  const pause=worker.request('status',{status:'PAUSED',requestExpiresAtMs:interval+1},'WORKER_TIMEOUT');
  const capture=worker.request('capture',{requestExpiresAtMs:interval+1},'WORKER_TIMEOUT');
  worker.startAdvance(interval+2);await Promise.all([pause,capture]);
  expect(await worker.request('diagnostics')).toMatchObject({tick:interval/50,status:'RUNNING'});
  expect((await worker.request('capture')).state).toMatchObject({tick:interval/50,status:'RUNNING'});
});

it('rechecks a command deadline at actual admission instead of accepting an expired queued order',async()=>{
  const worker=await workerHarness(false),before=await worker.request('capture');
  const unit=Object.values(before.state.entities).find((entity:any)=>entity.ownerId==='a'&&entity.kind==='unit') as any;
  const receipt=worker.request('command',{playerId:'a',requestExpiresAtMs:25,command:{protocolVersion:2,matchId:'overload-clock',matchEpoch:1,clientCommandId:'expired-stop',clientSequence:1,command:{kind:'stop',unitIds:[unit.id]}}},'WORKER_TIMEOUT');
  await worker.request('diagnostics');worker.startAdvance(50);await receipt;
  const after=await worker.request('capture');expect(after.state.economies.a.lastClientSequence).toBe(before.state.economies.a.lastClientSequence);
});

it('keeps non-native command replies sequential when a custom sender changes authority between replies', async () => {
  const worker = await workerHarness(false), { Simulation } = await import('@frontier/simulation');
  const before = await worker.request('capture'), unit = Object.values(before.state.entities).find((entity: any) => entity.ownerId === 'a' && entity.kind === 'unit') as any;
  const nativeDrain = vi.spyOn(Simulation.prototype, 'drainNativeCommands'), original = Simulation.prototype.command, events: string[] = [];
  let active: InstanceType<typeof Simulation> | undefined;
  vi.spyOn(Simulation.prototype, 'command').mockImplementation(function (this: InstanceType<typeof Simulation>, playerId, input, source) {
    active = this; events.push(`command:${(input as { clientCommandId: string }).clientCommandId}`);
    return original.call(this, playerId, input, source);
  });
  worker.setPostEffect(packet => {
    if (![901, 902, 903].includes(packet.id)) return;
    events.push(`reply:${packet.id}`);
    // An arbitrary sender is not an immutable native boundary. Its effects must
    // remain visible before the next admission, including ordinary deduplication.
    if (packet.id === 901) active!.setStatus('PAUSED');
  });
  const first = { protocolVersion: 2, matchId: before.state.matchId, matchEpoch: before.state.matchEpoch, clientCommandId: 'reply-first', clientSequence: 1, command: { kind: 'stop', unitIds: [unit.id] } };
  for (const [index, command] of [first, first, { ...first, clientCommandId: 'reply-next', clientSequence: 2 }].entries()) worker.send({ type: 'command', id: 901 + index, playerId: 'a', command });
  await worker.request('diagnostics'); await worker.advance(50);
  const replies = worker.packets.filter(packet => packet.id >= 901 && packet.id <= 903);
  expect(replies.map(packet => packet.id)).toEqual([901, 902, 903]);
  expect(replies.map(packet => packet.value)).toEqual([
    { status: 'accepted', code: 'OK', clientCommandId: 'reply-first', tick: 0, sequence: 1 },
    { status: 'accepted', code: 'OK', clientCommandId: 'reply-first', tick: 0, sequence: 1 },
    { status: 'rejected', code: 'MATCH_PAUSED', clientCommandId: 'reply-next', tick: 0, sequence: 1 },
  ]);
  expect(events).toEqual(['command:reply-first', 'reply:901', 'command:reply-first', 'reply:902', 'command:reply-next', 'reply:903']);
  expect(nativeDrain).not.toHaveBeenCalled();
  const after = await worker.request('capture');
  expect(after.state).toMatchObject({ status: 'PAUSED', tick: 0 });
  expect(after.state.economies.a.lastClientSequence).toBe(1);
  expect(after.state.commandLog.map((entry: any) => entry.envelope.clientCommandId)).toEqual(['reply-first']);
});

it('keeps diagnostic command bursts sequential and excludes commands that expire before admission from stage counts', async () => {
  const worker = await workerHarness(true), { Simulation } = await import('@frontier/simulation');
  const nativeDrain = vi.spyOn(Simulation.prototype, 'drainNativeCommands'), before = await worker.request('capture');
  const unit = Object.values(before.state.entities).find((entity: any) => entity.ownerId === 'a' && entity.kind === 'unit') as any;
  const first = { protocolVersion: 2, matchId: before.state.matchId, matchEpoch: before.state.matchEpoch, clientCommandId: 'diagnostic-first', clientSequence: 1, command: { kind: 'stop', unitIds: [unit.id] } };
  const inputs = [first, { ...first, clientCommandId: 'diagnostic-expired', clientSequence: 2 }, first, { ...first, clientCommandId: 'diagnostic-next', clientSequence: 2 }];
  for (const [index, command] of inputs.entries()) worker.send({ type: 'command', id: 911 + index, playerId: 'a', command, diagnosticSentAtMs: 0, ...(index === 1 ? { requestExpiresAtMs: 25 } : {}) });
  await worker.request('diagnostics'); await worker.advance(50);
  const replies = worker.packets.filter(packet => packet.id >= 911 && packet.id <= 914);
  expect(replies.map(packet => packet.id)).toEqual([911, 912, 913, 914]);
  expect(replies[0].value).toMatchObject({ status: 'accepted', clientCommandId: 'diagnostic-first', sequence: 1, tick: 0 });
  expect(replies[1]).toMatchObject({ id: 912, error: 'WORKER_TIMEOUT' });
  expect(replies[2].value).toEqual(replies[0].value);
  expect(replies[3].value).toMatchObject({ status: 'accepted', clientCommandId: 'diagnostic-next', sequence: 2, tick: 0 });
  expect(nativeDrain).not.toHaveBeenCalled();
  const report = await worker.request('performance-diagnostics');
  expect(report.worker.phases.commandQueue).toMatchObject({ count: 3, totalMs: 150 });
  expect(report.worker.phases.commandAdmission.count).toBe(3);
  expect(report.worker.callbackAccounting.callbackKinds.command.count).toBe(4);
  const timer = report.overload.recentEvents.find((event: any) => event.operation === 'timer');
  expect(timer.accounting.simulationStages.externalAdmission.calls).toBe(3);
  expect(timer.accounting.simulationStages.externalAdmission.metrics.command.calls).toBe(3);
  const after = await worker.request('capture');
  expect(after.state.economies.a.lastClientSequence).toBe(2);
  expect(after.state.commandLog.map((entry: any) => entry.envelope.clientCommandId)).toEqual(['diagnostic-first', 'diagnostic-next']);
});

it.each([{interval:50,advances:[100,200],tick:4},{interval:300,advances:[300,600],tick:12}] as const)('reserves encoder capacity and fairly coalesces six recipients with $interval ms frames',async({interval,advances,tick})=>{
  const worker=await workerHarness(false,true,6,'pause',interval),{Simulation}=await import('@frontier/simulation');
  const projected=vi.spyOn(Simulation.prototype,'publicationProjections'),full=vi.spyOn(Simulation.prototype,'views');
  const initial=worker.packets.filter(packet=>packet.type==='projection-view');expect(initial).toHaveLength(4);
  for(const at of advances)await worker.advance(at);
  expect((await worker.request('diagnostics')).tick).toBe(tick);expect(projected).not.toHaveBeenCalled();expect(full).not.toHaveBeenCalled();
  expect(worker.packets.filter(packet=>packet.type==='projection-view')).toHaveLength(4);
  const first=initial[0]!;worker.send({type:'projection-credit',playerId:first.playerId,generation:first.transfer.generation,revision:first.transfer.patch.revision});await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled(); expect(worker.scheduledPublications()).toBe(1);
  await worker.flushPublications();
  const packets=worker.packets.filter(packet=>packet.type==='projection-view');expect(packets).toHaveLength(5);
  expect(packets.at(-1)).toMatchObject({playerId:'e',transfer:{patch:{header:{tick,status:'RUNNING'}}}});
  expect(projected).toHaveBeenCalledTimes(1);expect(projected.mock.calls[0]![0]).toHaveLength(1);expect(full).not.toHaveBeenCalled();
});

it('promotes committed urgent recipients only after an existing encoder credit returns in the 300ms profile',async()=>{
  const worker=await workerHarness(false,true,6,'pause',300),{Simulation}=await import('@frontier/simulation');
  // First offers and LOADING -> RUNNING are themselves urgent for everybody.
  // Complete those publications before isolating priority among ordinary frames.
  let delivered=0;
  for(let turn=0;turn<4;turn++){
    const batch=worker.packets.filter(packet=>packet.type==='projection-view').slice(delivered);delivered+=batch.length;
    for(const packet of batch)worker.send({type:'projection-credit',playerId:packet.playerId,generation:packet.transfer.generation,revision:packet.transfer.patch.revision});
    await worker.request('diagnostics');await worker.flushPublications();
  }
  const urgent=vi.spyOn(Simulation.prototype,'urgentPublicationRecipients').mockReturnValue([]),projected=vi.spyOn(Simulation.prototype,'publicationProjections');
  await worker.advance(300);const held=worker.packets.filter(packet=>packet.type==='projection-view').slice(delivered);expect(held).toHaveLength(4);
  const waiting=['a','b','c','d','e','f'].filter(id=>!held.some(packet=>packet.playerId===id)),priority=waiting[1]!;
  expect(waiting).toHaveLength(2);urgent.mockReturnValue([priority]);projected.mockClear();await worker.advance(600);
  expect(urgent).toHaveBeenCalledWith(['a','b','c','d','e','f']);expect(projected).not.toHaveBeenCalled();
  expect(worker.packets.filter(packet=>packet.type==='projection-view')).toHaveLength(delivered+4);
  const first=held[0]!;worker.send({type:'projection-credit',playerId:first.playerId,generation:first.transfer.generation,revision:first.transfer.patch.revision});await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled();await worker.flushPublications();
  expect(projected.mock.calls.map(call=>call[0].map(request=>request.playerId))).toEqual([[priority]]);
  expect(worker.packets.filter(packet=>packet.type==='projection-view').at(-1)).toMatchObject({playerId:priority,transfer:{patch:{header:{tick:12,status:'RUNNING'}}}});
  await worker.flushPublications();expect(projected).toHaveBeenCalledTimes(1);
});

it('includes separate projection flush, diagnostics, capture and rejected-command work in complete300ms coordinator cycles',async()=>{
  const worker=await workerHarness(false,true,6,'pause',300),{Simulation}=await import('@frontier/simulation'),original=Simulation.prototype.advanceFrameAsync;
  let wall=300,sideCost=0;
  vi.spyOn(Simulation.prototype,'advanceFrameAsync').mockImplementation(async function(this:InstanceType<typeof Simulation>){await original.call(this);wall+=200;worker.setTime(wall);});
  await worker.advance(wall);expect((await worker.request('diagnostics')).cycleSamples).toBe(0);
  worker.setPostEffect(packet=>{
    const cost=packet.type==='projection-view'?40:packet.value?.tickMs?15:packet.value?.runtime&&packet.value?.state?20:packet.error==='WORKER_TIMEOUT'?7:0;
    sideCost+=cost;wall+=cost;worker.setTime(wall);
  });
  const first=worker.packets.find(packet=>packet.type==='projection-view');worker.send({type:'projection-credit',playerId:first.playerId,generation:first.transfer.generation,revision:first.transfer.patch.revision});
  await worker.request('diagnostics');await worker.flushPublications();
  const capture=await worker.request('capture');await worker.request('view',{playerId:'a',requestExpiresAtMs:wall-1},'WORKER_TIMEOUT');
  expect(sideCost).toBeGreaterThanOrEqual(97);const expected=sideCost+200;wall=Math.max(900,wall+1);await worker.advance(wall);
  const report=await worker.request('diagnostics');expect(report.callbackMs).toEqual({p50:200,p95:200,p99:200,max:200});
  expect(report).toMatchObject({cycleSamples:1,cycleMs:{p50:expected,p95:expected,p99:expected,max:expected}});
  expect(JSON.stringify(capture)).not.toMatch(/cycleMs|cycleSamples/);expect(JSON.stringify(await worker.request('view',{playerId:'a'}))).not.toMatch(/cycleMs|cycleSamples/);
});

it('cancels projection bases at pause epoch boundaries while retaining old transfer credit ownership',async()=>{
  const worker=await workerHarness(false,true,6),initial=worker.packets.filter(packet=>packet.type==='projection-view');
  await worker.advance(100);await worker.request('status',{status:'PAUSED',invalidate:true});
  const newestGeneration=worker.packets.filter(packet=>packet.type==='projection-reset').at(-1)!.generation;
  expect(newestGeneration).toBeGreaterThan(initial[0]!.transfer.generation);
  expect(worker.packets.filter(packet=>packet.type==='projection-view')).toHaveLength(4);
  const old=initial[0]!;worker.send({type:'projection-credit',playerId:old.playerId,generation:old.transfer.generation,revision:old.transfer.patch.revision});await worker.request('diagnostics');
  await worker.flushPublications();
  const current=worker.packets.filter(packet=>packet.type==='projection-view').at(-1)!;
  expect(current.transfer.generation).toBe(newestGeneration);expect(current.transfer.patch).toMatchObject({baseRevision:0,revision:1,header:{status:'PAUSED',tick:2}});
  const count=worker.packets.length;worker.send({type:'projection-credit',playerId:old.playerId,generation:old.transfer.generation,revision:old.transfer.patch.revision});await worker.request('diagnostics');
  await worker.flushPublications();
  expect(worker.packets.slice(count).filter(packet=>packet.type==='projection-view')).toHaveLength(0);
});

it('batches four returned credits once, keeps the four-slot ceiling and serves all six recipients fairly', async () => {
  const worker = await workerHarness(false, true, 6), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections');
  const initial = worker.packets.filter(packet => packet.type === 'projection-view');
  await worker.advance(200);
  for (const packet of initial) worker.send({ type: 'projection-credit', playerId: packet.playerId, generation: packet.transfer.generation, revision: packet.transfer.patch.revision });
  await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled(); expect(worker.scheduledPublications()).toBe(1);
  await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(1);
  expect(projected.mock.calls[0]![0].map(request => request.playerId)).toEqual(['e', 'f', 'a', 'b']);
  const batch = worker.packets.filter(packet => packet.type === 'projection-view').slice(4);
  expect(batch).toHaveLength(4); // Four released slots acquire exactly four transfers, each bounded at 32 MiB.
  expect(batch.every(packet => packet.transfer.patch.header.tick === 4)).toBe(true);
  expect(batch.map(packet => packet.transfer.patch.baseRevision)).toEqual([0, 0, 1, 1]);
  await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(1);
  // Two remaining recipients cannot create work until two of those four leases return.
  for (const packet of batch.slice(0, 2)) worker.send({ type: 'projection-credit', playerId: packet.playerId, generation: packet.transfer.generation, revision: packet.transfer.patch.revision });
  await worker.request('diagnostics'); await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(2);
  expect(projected.mock.calls[1]![0].map(request => request.playerId)).toEqual(['c', 'd']);
  expect(worker.packets.filter(packet => packet.type === 'projection-view')).toHaveLength(10);
});

it('invalidates a queued flush at the completed pause boundary and retains old-generation byte ownership', async () => {
  const worker = await workerHarness(false, true, 6), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections');
  const initial = worker.packets.filter(packet => packet.type === 'projection-view');
  const first = initial[0]!;
  worker.send({ type: 'projection-credit', playerId: first.playerId, generation: first.transfer.generation, revision: first.transfer.patch.revision });
  await worker.request('diagnostics');
  const step = worker.startAdvance(50), pause = worker.request('status', { status: 'PAUSED', invalidate: true });
  worker.deliverImmediates(); // Enqueued behind pause while the tick is still yielding.
  expect(projected).not.toHaveBeenCalled();
  await step; await pause; await worker.request('diagnostics');
  expect(projected).toHaveBeenCalledTimes(1);
  const current = worker.packets.filter(packet => packet.type === 'projection-view').slice(4);
  expect(current).toHaveLength(1); // Three old transfers still hold the other slots.
  expect(current[0].transfer.patch).toMatchObject({ baseRevision: 0, revision: 1, header: { tick: 1, matchEpoch: 2, status: 'PAUSED' } });
  expect(current[0].transfer.generation).toBeGreaterThan(first.transfer.generation);
  expect(worker.scheduledPublications()).toBe(0);
  for (const packet of initial.slice(1)) worker.send({ type: 'projection-credit', playerId: packet.playerId, generation: packet.transfer.generation, revision: packet.transfer.patch.revision });
  await worker.request('diagnostics'); await worker.flushPublications();
  expect(projected.mock.calls.map(call => call[0].length)).toEqual([1, 3]);
  const latest = worker.packets.filter(packet => packet.type === 'projection-view').slice(5);
  expect(latest.every(packet => packet.transfer.patch.header.tick === 1 && packet.transfer.patch.header.status === 'PAUSED')).toBe(true);
});

it('keeps explicit resync immediate and makes the already scheduled credit flush a no-op', async () => {
  const worker = await workerHarness(false, true), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections');
  const first = worker.packets.find(packet => packet.type === 'projection-view' && packet.playerId === 'a');
  worker.send({ type: 'projection-credit', playerId: 'a', generation: first.transfer.generation, revision: first.transfer.patch.revision });
  await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled();
  await worker.request('publication-request', { playerId: 'a', matchId: 'overload-clock', matchEpoch: 1, publicationRequest: 1 });
  expect(projected).toHaveBeenCalledTimes(1);
  expect(worker.packets.filter(packet => packet.type === 'projection-view').at(-1)).toMatchObject({ playerId: 'a', publicationRequest: 1, transfer: { patch: { header: { tick: 0, status: 'RUNNING' } } } });
  await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(1);
});

it('rebuilds a failed paused projection in a later turn without requiring another simulation tick', async () => {
  const worker = await workerHarness(false, true), { Simulation } = await import('@frontier/simulation');
  const initial = worker.packets.filter(packet => packet.type === 'projection-view');
  await worker.request('status', { status: 'PAUSED' });
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections'), first = initial[0]!;
  worker.send({ type: 'projection-credit', playerId: first.playerId, generation: first.transfer.generation, revision: first.transfer.patch.revision, failed: true });
  await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled();
  await worker.flushPublications();
  expect(projected).toHaveBeenCalledTimes(1);
  const recovered = worker.packets.filter(packet => packet.type === 'projection-view').slice(initial.length);
  expect(recovered).toHaveLength(2);
  expect(recovered.every(packet => packet.transfer.generation > first.transfer.generation && packet.transfer.patch.baseRevision === 0 && packet.transfer.patch.header.tick === 0 && packet.transfer.patch.header.status === 'PAUSED')).toBe(true);
});

it('delivers a same-tick draw immediately and drains remaining recipients after encoding credits return', async () => {
  const worker = await workerHarness(false, true, 6), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections');
  const initial = worker.packets.filter(packet => packet.type === 'projection-view');
  for (const packet of initial) worker.send({ type: 'projection-credit', playerId: packet.playerId, generation: packet.transfer.generation, revision: packet.transfer.patch.revision });
  await worker.request('diagnostics'); await worker.request('end-draw');
  expect(projected).toHaveBeenCalledTimes(1);
  const first = worker.packets.filter(packet => packet.type === 'projection-view').slice(4);
  expect(first).toHaveLength(4);
  expect(first.every(packet => packet.transfer.patch.header.status === 'FINISHED' && packet.transfer.patch.header.tick === 0 && packet.transfer.patch.fields.result !== undefined)).toBe(true);
  await worker.flushPublications(); expect(projected).toHaveBeenCalledTimes(1);
  for (const packet of first.slice(0, 2)) worker.send({ type: 'projection-credit', playerId: packet.playerId, generation: packet.transfer.generation, revision: packet.transfer.patch.revision });
  await worker.request('diagnostics'); await worker.flushPublications();
  expect(projected.mock.calls[1]![0].map(request => request.playerId)).toEqual(['c', 'd']);
  expect(worker.packets.filter(packet => packet.type === 'projection-view').slice(8).every(packet => packet.transfer.patch.header.status === 'FINISHED')).toBe(true);
});

it('coalesces resync requests before construction and stamps only later credited recipient projections', async () => {
  const worker = await workerHarness(false, true, 6), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections'), full = vi.spyOn(Simulation.prototype, 'view');
  const initial = worker.packets.filter(packet => packet.type === 'projection-view');
  const binding = { playerId: 'a', matchId: 'overload-clock', matchEpoch: 1 };
  await worker.request('publication-request', { ...binding, publicationRequest: 1 });
  await worker.request('publication-request', { ...binding, publicationRequest: 2 });
  await worker.request('status', { status: 'PAUSED' });
  expect(projected).not.toHaveBeenCalled(); expect(full).not.toHaveBeenCalled();
  expect(worker.packets.filter(packet => packet.type === 'projection-view')).toHaveLength(4);
  for (const held of initial) worker.send({ type: 'projection-credit', playerId: held.playerId, generation: held.transfer.generation, revision: held.transfer.patch.revision });
  await worker.request('diagnostics');
  expect(projected).not.toHaveBeenCalled(); expect(worker.scheduledPublications()).toBe(1);
  await worker.flushPublications();
  const later = worker.packets.filter(packet => packet.type === 'projection-view').slice(4);
  expect(later.find(packet => packet.playerId === 'a')).toMatchObject({ publicationRequest: 2, transfer: { patch: { header: { tick: 0, status: 'PAUSED' } } } });
  expect(later.filter(packet => packet.playerId !== 'a').every(packet => packet.publicationRequest === 0)).toBe(true);
  expect(projected).toHaveBeenCalled(); expect(full).not.toHaveBeenCalled();
  expect(initial.every(packet => packet.publicationRequest === 0)).toBe(true);
});

it('rejects stale, expired and unsubscribed publication requests without granting construction work', async () => {
  const worker = await workerHarness(false, true, 6), { Simulation } = await import('@frontier/simulation');
  const projected = vi.spyOn(Simulation.prototype, 'publicationProjections');
  const binding = { playerId: 'a', matchId: 'overload-clock', matchEpoch: 1 };
  await worker.request('publication-request', { ...binding, publicationRequest: 10 });
  await worker.request('publication-request', { ...binding, publicationRequest: 9 }, 'STALE_PUBLICATION_REQUEST');
  await worker.request('publication-request', { ...binding, matchEpoch: 2, publicationRequest: 11 }, 'MATCH_CHANGED');
  await worker.request('publication-request', { ...binding, publicationRequest: 11, requestExpiresAtMs: 0 }, 'WORKER_TIMEOUT');
  await worker.request('subscribe', { playerIds: ['b', 'c', 'd', 'e', 'f'] });
  await worker.request('publication-request', { ...binding, publicationRequest: 11 }, 'NOT_AUTHORIZED');
  await worker.request('subscribe', { playerIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
  // Removed recipients do not leave an ever-growing request-token registry.
  await worker.request('publication-request', { ...binding, publicationRequest: 1 });
  expect(projected).not.toHaveBeenCalled();
});
