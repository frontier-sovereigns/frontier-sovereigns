import { expect, it, vi } from 'vitest';
import { chunkView, chunkViewDelta, contentHash, createViewDelta, type PlayerView, type ClientCommandEnvelope } from '@frontier/shared';
import { ViewStream, nextCommandSequence } from './ViewStream';
import { gameSocketUrl } from './useGame';
import { BrowserDeliveryDiagnostics, BrowserResponseDiagnostics, browserResponseDiagnostics, browserResponseProbe, type ResponseRenderEntity } from './BrowserResponseDiagnostics';

it('distinguishes browser message, complete-state and advancing-state gaps without retaining viewpoint contents',()=>{
  let now=0;const delivery=new BrowserDeliveryDiagnostics(()=>now,()=>Date.UTC(2026,9,5)+now),view=fixture();
  delivery.message();now=10;delivery.validated(5);delivery.applied(view,6);delivery.poll(500,false);
  now=20;delivery.rendered(view);now=300;delivery.message();delivery.applied({...view,sequence:2},290);
  now=1000;delivery.message();delivery.poll(500,false);delivery.poll(500,false);
  const report=delivery.report();expect(report.episodes).toBe(1);expect(report.recentGaps[0]).toMatchObject({tick:10,completeViewAgeMs:710,advancingViewAgeMs:994,messageAgeMs:0,hidden:false});
  expect(report.metrics.worldApply).toMatchObject({samples:2,latestMs:10});expect(report.metrics.applyToRender?.latestMs).toBe(10);expect(report.metrics.advancingViewGap).toBeUndefined();
  now=1100;delivery.applied({...view,sequence:3,tick:16},1090);expect(delivery.report().metrics.advancingViewGap?.latestMs).toBe(1084);
  expect(JSON.stringify(report)).not.toContain('worker');expect(JSON.stringify(report)).not.toContain('resources');
});
it('bounds browser delay history, censors disconnected intervals and retains finished-match evidence',()=>{
  let now=0;const delivery=new BrowserDeliveryDiagnostics(()=>now,()=>now),view=fixture();
  for(let i=0;i<40;i++){delivery.applied({...view,sequence:i+1,tick:i},now);now+=600;delivery.poll(500,i%2===0);now+=1;}
  expect(delivery.report().episodes).toBe(40);expect(delivery.report().recentGaps).toHaveLength(32);
  delivery.boundary();now+=10000;delivery.poll(500,false);expect(delivery.report().episodes).toBe(40);
  delivery.applied({...view,matchEpoch:2},now);expect(delivery.report().metrics.completeViewGap?.maxMs).toBe(601);
  delivery.applied({...view,status:'FINISHED'},now);now+=10000;delivery.poll(500,false);expect(delivery.report().episodes).toBe(40);
});

function fixture(): PlayerView { return { protocolVersion: 2, contentHash, matchId: 'stream_fixture', matchEpoch: 1, tick: 10, sequence: 1, playerId: 'me', status: 'RUNNING', map: { widthMm: 640000, heightMm: 640000, fogCellMm: 2000 }, self: { lastCommandSequence: 15, resources: { food: 200, wood: 250, gold: 100, stone: 150 }, age: 1, population: 7, populationCap: 15, populationLimit: 120, reservedPopulation: 0 }, players: [], entities: [{ id: 'worker', typeId: 'villager', kind: 'unit', ownerId: 'me', hp: 35, maxHp: 35, xMm: 1000, zMm: 1000 }], fog: { visible: [0], explored: [0] } }; }

it('applies coalesced building upgrades without resetting the live browser stream',()=>{
  const stream=new ViewStream('me',contentHash),base=fixture();base.maxAge=8;base.entities=[{...base.entities[0]!,kind:'building',typeId:'grand_citadel',progress:1}];
  expect(stream.ingest({type:'snapshot',view:base},100)).toMatchObject({type:'view',resetInterpolation:true});
  const next={...base,tick:16,sequence:2,entities:[{...base.entities[0]!,typeId:'eternal_citadel'}]};
  expect(stream.ingest({type:'delta',delta:createViewDelta(base,next)},400)).toMatchObject({type:'view',resetInterpolation:false,view:{entities:[{typeId:'eternal_citadel'}]}});
});

it('explicitly advertises chunked delta support on the same-origin authenticated game socket', () => {
  expect(gameSocketUrl('http://127.0.0.1:3000/?invite=private').href).toBe('ws://127.0.0.1:3000/ws?deltaChunks=1');
  expect(gameSocketUrl('https://frontier.example/game?other=private#host').href).toBe('wss://frontier.example/ws?deltaChunks=1');
});

it('applies independent adaptive speed and publication changes without resetting the command boundary and restores them on reconnect',()=>{
  const stream=new ViewStream('me',contentHash);let base=fixture();
  expect(stream.ingest({type:'snapshot',view:base},100)).toMatchObject({type:'view',resetInterpolation:true});
  for(const [index,[speed,interval]] of ([[.9,150],[.1,200],[.1,150],[1,undefined]] as const).entries()){
    const next={...base,sequence:base.sequence+1,tick:base.tick+2};
    if(speed===1)delete next.simulationSpeed;else next.simulationSpeed=speed;
    if(interval===undefined)delete next.publicationIntervalMs;else next.publicationIntervalMs=interval;
    expect(stream.ingest({type:'delta',delta:createViewDelta(base,next)},200+index*1000)).toMatchObject({type:'view',resetInterpolation:false,view:{matchEpoch:1,status:'RUNNING',self:{lastCommandSequence:15}}});
    expect(stream.view?.simulationSpeed??1).toBe(speed);expect(stream.view?.publicationIntervalMs).toBe(interval);expect(stream.synchronizing).toBe(false);base=next;
  }
  stream.reset();expect(stream.view).toBeNull();base={...base,simulationSpeed:.1,publicationIntervalMs:200};
  // Reconnection must restore the cadence together with the verified viewpoint,
  // not retain a previous socket's cadence or change the command watermark.
  expect(stream.ingest(chunkView(base,'reconnected_cadence')[0],5000)).toMatchObject({type:'view',resetInterpolation:true,view:{simulationSpeed:.1,publicationIntervalMs:200,self:{lastCommandSequence:15}}});
});

function responseFixture(){
  let now=100;const probe=new BrowserResponseDiagnostics(()=>now),view=fixture();
  view.entities[0]={...view.entities[0]!,order:'idle',taskState:'idle',queuedOrderCount:0,visualAction:{kind:'idle',startedTick:5}};
  const rendered=(input:PlayerView):ResponseRenderEntity[]=>input.entities.filter(entity=>entity.ownerId===input.playerId).map(entity=>({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,clip:entity.visualAction?.kind??'idle'}));
  const command=(sequence=16,kind:'move'|'attack_move'|'gather'='move'):ClientCommandEnvelope=>({protocolVersion:2,matchId:view.matchId,matchEpoch:view.matchEpoch,clientCommandId:`response_${sequence}`,clientSequence:sequence,command:kind==='gather'?{kind,unitIds:view.entities.filter(entity=>entity.kind==='unit').map(entity=>entity.id),targetId:'visible_gold',queued:false}:{kind,unitIds:view.entities.filter(entity=>entity.kind==='unit').map(entity=>entity.id),target:{xMm:10000,zMm:1000},queued:false}});
  const moved=(sequence=2,watermark=16)=>{const next=structuredClone(view);next.sequence=sequence;next.tick=12;next.self.lastCommandSequence=watermark;next.entities=next.entities.map(entity=>({...entity,xMm:entity.xMm+100,order:'move',taskState:'moving',visualAction:{kind:'move',startedTick:11}}));return next;};
  return {probe,view,rendered,command,moved,time:(value:number)=>{now=value;}};
}
it('gateway acknowledgement stays provisional and records a different interval from authoritative acceptance',()=>{
  const f=responseFixture();f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);
  f.probe.gatewayReceived('response_16',17,115);expect(f.probe.report().counts.gatewayReceived).toBe(0);
  f.probe.gatewayReceived('response_16',16,120);f.probe.gatewayReceived('response_16',16,130);
  expect(f.probe.report().counts).toMatchObject({gatewayReceived:1,accepted:0,acted:0,pending:1});
  expect(f.probe.report().samples[0]).toMatchObject({gatewayReceivedMs:20,outcome:'pending'});
  f.probe.receipt({clientCommandId:'response_16',sequence:16,status:'accepted',tick:10},400);
  expect(f.probe.report().samples[0]).toMatchObject({gatewayReceivedMs:20,authoritativeDecisionMs:300,applied:0,rendered:0});
});
it('routes provisional gateway acknowledgements without mutating the current viewpoint or watermark',()=>{
  const stream=new ViewStream('me',contentHash),view=fixture();stream.ingest({type:'snapshot',view},100);
  const message={type:'command_received',commandId:'response_16',sequence:16};
  expect(stream.ingest(message,120)).toEqual({type:'event',message});expect(stream.view?.self.lastCommandSequence).toBe(15);expect(stream.synchronizing).toBe(false);
});
it('browser response evidence separates authorized application from actual rendered group coverage on one clock',()=>{
  const f=responseFixture();f.view.entities.push({...f.view.entities[0]!,id:'second',zMm:2000});f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);
  f.time(130);f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16},120);
  const next=f.moved();f.time(160);f.probe.applied(next,145);expect(f.probe.report().samples[0]).toMatchObject({eligible:2,applied:2,rendered:0,firstReceivedMs:45,firstAppliedMs:60,firstMotionMs:60});
  f.time(200);f.probe.rendered(next,[f.rendered(f.view)[0]!]);expect(f.probe.report().counts.rendered).toBe(0); // Interpolation still at origin.
  f.time(220);f.probe.rendered(next,[f.rendered(next)[0]!]);expect(f.probe.report().samples[0]).toMatchObject({rendered:1,firstRenderedMs:120,outcome:'pending'});
  f.time(240);f.probe.rendered(next,f.rendered(next));expect(f.probe.report().samples[0]).toMatchObject({rendered:2,firstRenderedMs:120,completeRenderedMs:140,outcome:'rendered'});
  const detached=f.probe.report();detached.rows[0]!.units[0]!.id='changed';expect(f.probe.report().rows[0]!.units[0]!.id).toBe('worker');
});
it('browser response evidence excludes old orders and old action clocks and censors an unknown later command boundary',()=>{
  const f=responseFixture();f.view.entities[0]!.order='gather';f.view.entities[0]!.taskState='moving';f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16});
  expect(f.probe.report().rows[0]).toMatchObject({outcome:'ineligible',eligible:0,excluded:{'prior-order-or-action':1}});
  const clean=responseFixture();clean.probe.rendered(clean.view,clean.rendered(clean.view));clean.probe.issue(clean.command(),clean.view);clean.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16});
  const old=clean.moved();old.entities[0]!.visualAction!.startedTick=10;clean.time(180);clean.probe.applied(old,170);clean.probe.rendered(old,clean.rendered(old));expect(clean.probe.report().samples[0]!.applied).toBe(0);
  const foreign=clean.moved(3,17);clean.probe.applied(foreign,190);expect(clean.probe.report().rows[0]).toMatchObject({outcome:'boundary-censored',reason:'later-command-watermark'});
});
it('browser response evidence keeps rejected, replacement-cancelled, timed-out, pending and overflow denominators',()=>{
  const f=responseFixture();f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16});
  const stop=f.command(17);stop.command={kind:'stop',unitIds:['worker']};f.probe.issue(stop,f.view);f.probe.receipt({clientCommandId:'response_17',status:'accepted',tick:10,sequence:17});expect(f.probe.report().counts).toMatchObject({issued:2,accepted:2,cancelled:1,ineligible:1,pending:0});
  const rejected=f.command(18);f.probe.issue(rejected,f.view);f.probe.receipt({clientCommandId:rejected.clientCommandId,status:'rejected',tick:10,sequence:18,code:'PATH_BUSY'});expect(f.probe.report().counts.rejected).toBe(1);
  f.probe.issue(f.command(19),f.view);expect(f.probe.report().counts.pending).toBe(1);f.time(10101);expect(f.probe.report().counts).toMatchObject({timedOut:1,pending:0});
  const overflow=responseFixture();for(let i=0;i<65;i++)overflow.probe.issue(overflow.command(i+16),overflow.view);expect(overflow.probe.report().counts).toMatchObject({issued:65,pending:64,overflow:1});
});
it('browser response evidence handles gathered action, locked gate opening and pre-receipt authorized state without enemy detail',()=>{
  const f=responseFixture();f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(16,'gather'),f.view);
  const gathered=f.moved();gathered.entities[0]!.order='gather';gathered.entities[0]!.taskState='gathering';gathered.entities[0]!.visualAction={kind:'mine',startedTick:11};gathered.entities.push({...gathered.entities[0]!,id:'enemy_secret',ownerId:'enemy'});
  f.time(150);f.probe.applied(gathered,140);f.time(160);f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16},155);f.time(200);f.probe.rendered(gathered,f.rendered(gathered));expect(f.probe.report().samples[0]).toMatchObject({outcome:'rendered',firstAppliedMs:50,firstRenderedMs:100});expect(JSON.stringify(f.probe.report())).not.toContain('enemy_secret');
  const gate=responseFixture();gate.view.entities=[{id:'own_gate',kind:'building',typeId:'wooden_gate',ownerId:'me',xMm:1000,zMm:1000,hp:100,maxHp:100,progress:1,gateMode:'LOCKED',gateOpen:false}];
  gate.probe.rendered(gate.view,[{id:'own_gate',xMm:1000,zMm:1000,clip:'gate_open',gatePose:0}]);const command=gate.command();command.command={kind:'set_gate_mode',gateId:'own_gate',mode:'OPEN'};gate.probe.issue(command,gate.view);gate.probe.receipt({clientCommandId:command.clientCommandId,status:'accepted',tick:10,sequence:16});
  const opened=structuredClone(gate.view);opened.tick=12;opened.sequence=2;opened.self.lastCommandSequence=16;opened.entities[0]!.gateMode='OPEN';opened.entities[0]!.gateOpen=true;gate.time(180);gate.probe.applied(opened,170);gate.probe.rendered(opened,[{id:'own_gate',xMm:1000,zMm:1000,clip:'gate_open',gatePose:0}]);expect(gate.probe.report().counts.rendered).toBe(0);gate.time(200);gate.probe.rendered(opened,[{id:'own_gate',xMm:1000,zMm:1000,clip:'gate_open',gatePose:.2}]);expect(gate.probe.report().rows[0]!.outcome).toBe('rendered');
});
it('browser response evidence censors epoch, reconnect, pause and missing renderer boundaries and starts cleanly again',()=>{
  for(const boundary of ['epoch','reconnecting','pause','graphics-context-lost']){
    const f=responseFixture();f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);
    if(boundary==='epoch'){const next=f.moved();next.matchEpoch++;f.probe.applied(next,150);}else if(boundary==='pause'){const next=f.moved();next.status='PAUSED';f.probe.applied(next,150);}else f.probe.boundary(boundary);
    f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16});expect(f.probe.report().counts).toMatchObject({boundaryCensored:1,accepted:1,rendered:0,pending:0});
    f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(17),f.view);expect(f.probe.report().counts.pending).toBe(1);
  }
});
it('browser response evidence preserves the first completed draw when the receipt arrives after rendering',()=>{
  const f=responseFixture();f.probe.rendered(f.view,f.rendered(f.view));f.probe.issue(f.command(),f.view);
  const moved=f.moved();f.time(150);f.probe.applied(moved,140);
  f.time(160);f.probe.rendered(moved,f.rendered(f.view)); // Still interpolating at the old position.
  f.time(180);f.probe.rendered(moved,f.rendered(moved));f.time(200);f.probe.rendered(moved,f.rendered(moved));
  expect(f.probe.report().counts.rendered).toBe(0);
  f.time(240);f.probe.receipt({clientCommandId:'response_16',status:'accepted',tick:10,sequence:16},230);
  expect(f.probe.report().samples[0]).toMatchObject({outcome:'rendered',firstAppliedMs:50,firstRenderedMs:80,completeRenderedMs:80});
});
it('browser response opt-in remains local and disabled observers cannot alter commands',()=>{
  browserResponseDiagnostics.disable();const operation=vi.fn();browserResponseProbe.observe(operation);expect(operation).not.toHaveBeenCalled();
  browserResponseDiagnostics.enable();try{browserResponseProbe.observe(()=>{throw new Error('diagnostic failure');});expect(browserResponseDiagnostics.report()).toMatchObject({enabled:false,faults:1});}finally{browserResponseDiagnostics.disable();}
});
it('commits complete chunks atomically, rejects a gap once, and resets only when a verified replacement arrives', () => {
  const stream = new ViewStream('me', contentHash), base = fixture();
  expect(stream.ingest(chunkView(base, 'initial')[0], 0).type).toBe('view');
  const large = structuredClone(base); large.sequence = 2; large.tick = 12; large.fog.explored = Array.from({ length: 102400 }, (_, index) => index);
  const chunks = chunkView(large, 'replacement'); expect(chunks.length).toBeGreaterThan(1);
  expect(stream.ingest(chunks[0], 100).type).toBe('pending'); expect(stream.view?.sequence).toBe(1);
  for (const chunk of chunks.slice(1, -1)) expect(stream.ingest(chunk, 110).type).toBe('pending');
  expect(stream.ingest(chunks.at(-1), 120)).toMatchObject({ type: 'view', resetInterpolation: true, view: { sequence: 2 } });
  const next = structuredClone(large); next.sequence = 3; next.tick = 14; next.entities[0]!.xMm = 1100;
  const invalid = createViewDelta(large, next); invalid.baseSequence = 0;
  expect(stream.ingest({ type: 'delta', delta: invalid }, 200).type).toBe('resync');
  expect(stream.view?.sequence).toBe(2); expect(stream.ingest({ type: 'delta', delta: invalid }, 210).type).toBe('pending');
  expect(stream.ingest({ type: 'delta', delta: createViewDelta(large, next) }, 220).type).toBe('pending');
  const renewed = chunkView(next, 'renewed'); for (const chunk of renewed) stream.ingest(chunk, 300);
  const fourth = structuredClone(next); fourth.tick = 16; fourth.sequence = 4; fourth.self.resources.food = 205;
  expect(stream.ingest({ type: 'delta', delta: createViewDelta(next, fourth) }, 400)).toMatchObject({ type: 'view', resetInterpolation: false, view: { self: { resources: { food: 205 } } } });
  expect(base.self.resources.food).toBe(200);
});
it('never publishes foreign recipients, mixed transfers, duplicate IDs, or partial timed-out snapshots', () => {
  const stream = new ViewStream('me', contentHash), base = fixture();
  stream.ingest(chunkView(base, 'initial')[0], 0);
  const foreign = { ...base, playerId: 'enemy' };
  expect(stream.ingest(chunkView(foreign, 'foreign')[0], 10).type).toBe('resync'); expect(stream.view?.playerId).toBe('me');
  stream.reset(); const large = fixture(); large.fog.explored = Array.from({ length: 102400 }, (_, index) => index);
  stream.requestSnapshot(0); stream.ingest(chunkView(large, 'incomplete')[0], 9000);
  expect(stream.poll(10000).type).toBe('pending'); expect(stream.poll(19000).type).toBe('resync'); expect(stream.view).toBeNull();
  stream.reset(); base.entities.push({ ...base.entities[0]! }); expect(stream.ingest({ type: 'snapshot', view: base }, 20000).type).toBe('resync'); expect(stream.view).toBeNull();
});
it('recovers consumed command watermarks after reload with blocked or corrupt browser storage', () => {
  expect(nextCommandSequence(0, null, 250)).toBe(251);
  expect(nextCommandSequence(1, 'NaN', 250)).toBe(251);
  expect(nextCommandSequence(252, 'Infinity', 250)).toBe(253);
  expect(nextCommandSequence(252, '255', 250)).toBe(256);
  expect(() => nextCommandSequence(0, null, Number.MAX_SAFE_INTEGER)).toThrow('exhausted');
});

it('recovers when an old partial transfer tail arrives between resync and the fresh first chunk', () => {
  const stream = new ViewStream('me', contentHash), large = fixture(); large.fog.explored = Array.from({ length: 102400 }, (_, index) => index);
  const old = chunkView(large, 'old_transfer'); stream.ingest(old[0], 0);
  expect(stream.requestSnapshot(1, 'retry').type).toBe('resync'); stream.ingest(old[1], 2);
  const renewed = structuredClone(large); renewed.sequence++; renewed.tick += 2;
  const fresh = chunkView(renewed, 'new_transfer'); stream.ingest(fresh[0], 3); stream.ingest(old[2], 4);
  for (const chunk of fresh.slice(1)) stream.ingest(chunk, 5);
  expect(stream.view?.sequence).toBe(renewed.sequence); expect(stream.synchronizing).toBe(false);
});
it('decodes authorized communication independently and rejects unexpected private fields', () => {
  const stream = new ViewStream('me', contentHash), state = { messages: [{ id: 'message_1', tick: 10, senderId: 'ally', channel: 'team', source: 'human', text: 'Defend this crossing.' }], pings: [], sendHumanChat: false };
  stream.ingest(chunkView(fixture(), 'initial')[0], 0);
  expect(stream.ingest({ type: 'communication', state }, 10)).toMatchObject({ type: 'event', message: { type: 'communication', state } });
  expect(stream.ingest({ type: 'communication', state: { ...state, apiKey: 'must-never-arrive' } }, 20).type).toBe('resync');
  expect(stream.view?.tick).toBe(10);
});

function deltaFixture() {
  const stream = new ViewStream('me', contentHash), base = fixture();
  const next = structuredClone(base); next.sequence++; next.tick += 6; next.self.lastCommandSequence++;
  next.entities[0]!.xMm += 100; next.fog.explored = Array.from({ length: 12000 }, (_, index) => index);
  const delta = createViewDelta(base, next), chunks = chunkViewDelta(delta, 'large_delta');
  expect(chunks.length).toBeGreaterThan(1);
  stream.ingest({ type: 'snapshot', view: base }, 0);
  return { stream, base, next, delta, chunks };
}
it('commits chunked deltas atomically, accepts duplicate and reordered chunks, then continues ordinary deltas', () => {
  const { stream, next, chunks } = deltaFixture(), retained = stream.view;
  expect(stream.ingest(chunks.at(-1), 1).type).toBe('pending');
  expect(stream.ingest(chunks.at(-1), 2).type).toBe('pending');
  expect(stream.view).toBe(retained); expect(stream.view?.self.lastCommandSequence).toBe(15);
  expect(stream.synchronizing).toBe(false);
  for (const chunk of chunks.slice(0, -2)) expect(stream.ingest(chunk, 3).type).toBe('pending');
  expect(stream.ingest(chunks.at(-2), 4)).toMatchObject({ type: 'view', resetInterpolation: false, view: next });
  expect(retained?.entities[0]?.xMm).toBe(1000); expect(retained?.fog.explored).toEqual([0]);
  const later = structuredClone(next); later.sequence++; later.tick += 6; later.self.resources.food++;
  expect(stream.ingest({ type: 'delta', delta: createViewDelta(next, later) }, 5)).toMatchObject({ type: 'view', resetInterpolation: false, view: later });
  for (const chunk of chunks) expect(stream.ingest(chunk, 6).type).toBe('pending');
  expect(stream.poll(10010).type).toBe('pending'); expect(stream.view?.sequence).toBe(later.sequence);
});
it('holds the complete view on a lost delta chunk, requests one resync and requires a fresh snapshot', () => {
  const { stream, next, chunks } = deltaFixture(), retained = stream.view;
  expect(stream.ingest(chunks[0], 100).type).toBe('pending');
  expect(stream.poll(10099).type).toBe('pending');
  expect(stream.poll(10100).type).toBe('resync'); expect(stream.view).toBe(retained); expect(stream.synchronizing).toBe(true);
  expect(stream.poll(10101).type).toBe('pending');
  for (const chunk of chunks) expect(stream.ingest(chunk, 10102).type).toBe('pending');
  expect(stream.view).toBe(retained);
  expect(stream.ingest({ type: 'snapshot', view: next }, 10103)).toMatchObject({ type: 'view', resetInterpolation: true });
  expect(stream.poll(20105).type).toBe('pending'); expect(stream.view).toEqual(next);
});
it('discards partial delta assembly after an ordinary committed update or disconnect', () => {
  const { stream, base, delta, chunks } = deltaFixture();
  stream.ingest(chunks[0], 1);
  expect(stream.ingest({ type: 'delta', delta }, 2).type).toBe('view');
  for (const chunk of chunks.slice(1)) expect(stream.ingest(chunk, 3).type).toBe('pending');
  expect(stream.poll(10002).type).toBe('pending');
  stream.reset(); expect(stream.view).toBeNull();
  for (const chunk of chunks) expect(stream.ingest(chunk, 10003).type).toBe('pending');
  expect(stream.view).toBeNull(); expect(stream.synchronizing).toBe(true);
  expect(stream.ingest({ type: 'snapshot', view: base }, 10004).type).toBe('view');
  expect(stream.poll(20004).type).toBe('pending');
});
it('rejects chunked delta base, epoch, match, recipient and content mismatches without changing current state', () => {
  for (const mismatch of [{ baseSequence: 0 }, { matchEpoch: 2 }, { matchId: 'other_match' }, { playerId: 'opponent' }, { contentHash: '0'.repeat(64) }]) {
    const { stream, chunks } = deltaFixture(), retained = stream.view;
    expect(stream.ingest({ ...chunks[0], ...mismatch }, 1).type).toBe('resync');
    expect(stream.view).toBe(retained); expect(stream.view?.self.lastCommandSequence).toBe(15);
    expect(stream.ingest({ ...chunks[0], ...mismatch }, 2).type).toBe('pending');
  }
});
it('a newer epoch snapshot interrupts partial deltas and stale tails cannot poison a new transfer', () => {
  const { stream, next, chunks } = deltaFixture(); stream.ingest(chunks[0], 1);
  const replacement = { ...next, matchEpoch: 2, sequence: 1 };
  expect(stream.ingest({ type: 'snapshot', view: replacement }, 2).type).toBe('view');
  const latest = structuredClone(replacement); latest.sequence++; latest.tick += 6; latest.fog.explored = Array.from({ length: 24000 }, (_, index) => index);
  const fresh = chunkViewDelta(createViewDelta(replacement, latest), 'new_epoch_delta'); expect(fresh.length).toBeGreaterThan(1);
  expect(stream.ingest(fresh[0], 3).type).toBe('pending');
  for (const chunk of chunks) expect(stream.ingest(chunk, 4).type).toBe('pending');
  for (const chunk of fresh.slice(1, -1)) expect(stream.ingest(chunk, 5).type).toBe('pending');
  expect(stream.ingest(fresh.at(-1), 6)).toMatchObject({ type: 'view', resetInterpolation: false, view: latest });
  expect(stream.poll(10007).type).toBe('pending');
});
it('a newer coalesced delta retains the same committed base and ignores the older transfer tail', () => {
  const { stream, base, next, chunks } = deltaFixture(), retained = stream.view;
  stream.ingest(chunks[0], 1);
  const latest = structuredClone(next); latest.sequence++; latest.tick += 6; latest.entities[0]!.xMm += 100;
  const fresh = chunkViewDelta(createViewDelta(base, latest), 'coalesced_delta');
  expect(stream.ingest(fresh[0], 9000).type).toBe('pending');
  for (const chunk of chunks.slice(1)) expect(stream.ingest(chunk, 9001).type).toBe('pending');
  expect(stream.view).toBe(retained); expect(stream.poll(10001).type).toBe('pending');
  for (const chunk of fresh.slice(1, -1)) expect(stream.ingest(chunk, 10002).type).toBe('pending');
  expect(stream.ingest(fresh.at(-1), 10003)).toMatchObject({ type: 'view', resetInterpolation: false, view: latest });
});
it('a replacement snapshot starts a fresh deadline and interrupts the old partial delta immediately', () => {
  const { stream, next, chunks } = deltaFixture(), retained = stream.view;
  stream.ingest(chunks[0], 1);
  const replacement = { ...next, sequence: 3 }, full = chunkView(replacement, 'interrupting_snapshot');
  expect(stream.ingest(full[0], 9000).type).toBe('pending'); expect(stream.synchronizing).toBe(true);
  for (const chunk of chunks.slice(1)) expect(stream.ingest(chunk, 9001).type).toBe('pending');
  expect(stream.poll(10001).type).toBe('pending'); expect(stream.view).toBe(retained);
  for (const chunk of full.slice(1, -1)) expect(stream.ingest(chunk, 10002).type).toBe('pending');
  expect(stream.ingest(full.at(-1), 10003)).toMatchObject({ type: 'view', resetInterpolation: true, view: replacement });
});
it('equal-sequence snapshot tails cannot interrupt a later delta, but an explicit full resync can replace the same sequence', () => {
  const base = fixture(); base.fog.explored = Array.from({ length: 12000 }, (_, index) => index);
  const stream = new ViewStream('me', contentHash), full = chunkView(base, 'first_snapshot');
  for (const chunk of full) stream.ingest(chunk, 0);
  const next = structuredClone(base); next.sequence++; next.tick += 6; next.fog.explored = Array.from({ length: 24000 }, (_, index) => index);
  const chunks = chunkViewDelta(createViewDelta(base, next), 'next_delta'); expect(chunks.length).toBeGreaterThan(1);
  stream.ingest(chunks[0], 1); expect(stream.ingest(full.at(-1), 2).type).toBe('pending'); expect(stream.synchronizing).toBe(false);
  for (const chunk of chunks.slice(1, -1)) stream.ingest(chunk, 3);
  expect(stream.ingest(chunks.at(-1), 4)).toMatchObject({ type: 'view', resetInterpolation: false, view: next });
  expect(stream.requestSnapshot(5).type).toBe('resync');
  const replacement = chunkView(next, 'explicit_resync');
  for (const chunk of replacement.slice(0, -1)) expect(stream.ingest(chunk, 6).type).toBe('pending');
  expect(stream.ingest(replacement.at(-1), 7)).toMatchObject({ type: 'view', resetInterpolation: true });
});
it('rejects conflicting delta chunks and unexpected private envelope fields atomically', () => {
  for (const conflict of ['duplicate', 'private-field']) {
    const { stream, chunks } = deltaFixture(), retained = stream.view, first = chunks[0]!;
    expect(stream.ingest(first, 1).type).toBe('pending');
    const invalid = conflict === 'duplicate' ? { ...first, data: `${first.data[0] === 'A' ? 'B' : 'A'}${first.data.slice(1)}` } : { ...first, apiKey: 'must-not-be-accepted' };
    expect(stream.ingest(invalid, 2).type).toBe('resync'); expect(stream.view).toBe(retained);
    expect(JSON.stringify(stream.view)).not.toContain('must-not-be-accepted');
  }
});
it('rejects out-of-bounds delta envelopes before assembly without allocating or replacing the current view', () => {
  for (const invalid of [{ count: 513 }, { byteLength: 16777217 }, { index: 512 }, { baseSequence: -1 }]) {
    const { stream, chunks } = deltaFixture(), retained = stream.view;
    expect(stream.ingest({ ...chunks[0], ...invalid }, 1).type).toBe('resync'); expect(stream.view).toBe(retained);
  }
});
it('checks the decoded delta command and tick boundaries before atomically accepting the transfer', () => {
  for (const boundary of ['commands', 'tick']) {
    const { stream, delta } = deltaFixture(), retained = stream.view;
    if (boundary === 'commands') delta.self.lastCommandSequence = 14; else delta.tick = 9;
    const chunks = chunkViewDelta(delta, `invalid_${boundary}`);
    for (const chunk of chunks.slice(0, -1)) expect(stream.ingest(chunk, 1).type).toBe('pending');
    expect(stream.ingest(chunks.at(-1), 2).type).toBe('resync'); expect(stream.view).toBe(retained);
  }
});
it('chunked concealment removes only the authorized opponent and rejects opponent private state', () => {
  const base = fixture(), opponent = { ...base.entities[0]!, id: 'opponent_worker', ownerId: 'opponent' }; base.entities.push(opponent);
  const next = structuredClone(base); next.sequence++; next.tick += 6; next.entities.pop(); next.fog.explored = Array.from({ length: 12000 }, (_, index) => index);
  for (const injectPrivateState of [false, true]) {
    const stream = new ViewStream('me', contentHash); stream.ingest({ type: 'snapshot', view: base }, 0); const retained = stream.view;
    const delta = createViewDelta(base, next);
    if (injectPrivateState) { delta.conceals = []; delta.updates.push({ ...opponent, order: 'move' }); }
    const chunks = chunkViewDelta(delta, 'authorized_delta');
    for (const chunk of chunks.slice(0, -1)) expect(stream.ingest(chunk, 1).type).toBe('pending');
    expect(stream.view).toBe(retained); expect(stream.view?.entities).toHaveLength(2);
    const result = stream.ingest(chunks.at(-1), 2);
    if (injectPrivateState) { expect(result.type).toBe('resync'); expect(stream.view).toBe(retained); }
    else { expect(result.type).toBe('view'); expect(stream.view?.entities.map(entity => entity.id)).toEqual(['worker']); }
  }
});
