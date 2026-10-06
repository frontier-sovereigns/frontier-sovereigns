import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { NetworkObserver, ProcessDeliveryDiagnostics, assertObserverMessageSize, impairmentRandom, observerEnvironment, type ObserverConfiguration } from '../scripts/network-observer.js';
import { PerformanceDiagnostics, type PublicationStamp } from '../apps/server/src/performance-diagnostics.js';
import { chunkView, chunkViewDelta, contentHash, createViewDelta, type ClientCommandEnvelope, type PlayerView } from '@frontier/shared';

const command=(id='probe',sequence=1):ClientCommandEnvelope=>({protocolVersion:2,matchId:'test_match',matchEpoch:1,clientCommandId:id,clientSequence:sequence,command:{kind:'move',unitIds:['own_unit'],target:{xMm:2000,zMm:1000},queued:false}});
const view=(tick=10):PlayerView=>({playerId:'human_1',matchId:'test_match',matchEpoch:1,sequence:tick,tick,status:'RUNNING',entities:[{id:'own_unit',kind:'unit',ownerId:'human_1',xMm:1200,zMm:1000,visualAction:{kind:'move'}}]} as PlayerView);
const stamp=(tick=10):PublicationStamp=>({matchId:'test_match',matchEpoch:1,sequence:tick,tick,postedAtMs:1e9,completedAtMs:1e9-50,movements:[{playerId:'human_1',commandId:'probe',commandSequence:1,unitId:'own_unit',orderRevision:2,acceptedAtMs:1e9-400,firstMoveAtMs:1e9-200,firstMoveTick:9,xMm:1200,zMm:1000}]});
const flush=async()=>{for(let index=0;index<8;index++)await Promise.resolve();};
afterEach(()=>vi.useRealTimers());

describe('isolated observer diagnostic joins',()=>{
  it('uses the captured observer application clock, excluding delayed IPC and unrelated server clock origins',async()=>{
    let now=100,resolveStamp!:(value:PublicationStamp)=>void;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,()=>new Promise(resolve=>{resolveStamp=resolve;}));
    diagnostics.commandIssued(command());now=150;diagnostics.observe(view(),now);now=2500;resolveStamp(stamp());await flush();
    const result=metrics.snapshot();expect(result.phases.commandIssuedToDeliveredMove).toMatchObject({count:1,totalMs:50});
    expect(result.phases.viewDeliveryAge).toBeUndefined();expect(result.phases.acceptedToDeliveredMove).toBeUndefined();expect(diagnostics.snapshot()).toMatchObject({pendingCommands:0,serverToObserverAbsoluteAge:null});
  });
  it('does not certify another recipient, stale publication, or unobserved position',async()=>{
    let now=100,current=stamp();const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,async()=>current);
    diagnostics.commandIssued(command());current={...stamp(),movements:[{...stamp().movements![0]!,playerId:'other_player'}]};now=150;diagnostics.observe(view(),now);await flush();
    current={...stamp(11),sequence:10};now=200;diagnostics.observe(view(11),now);await flush();
    current={...stamp(12),movements:[{...stamp(12).movements![0]!,xMm:1300}]};now=250;diagnostics.observe(view(12),now);await flush();
    expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toBeUndefined();expect(diagnostics.snapshot().pendingCommands).toBe(1);
  });
  it('reports rejected, timed out, pending, overflow and boundary-censored commands',async()=>{
    let now=0;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,async()=>undefined);
    diagnostics.commandIssued(command('rejected'));diagnostics.receipt({clientCommandId:'rejected',sequence:1,tick:1,status:'rejected',code:'INVALID_TARGET'});
    diagnostics.commandIssued(command('timeout',2));now=10001;diagnostics.expire();
    for(let index=0;index<65;index++)diagnostics.commandIssued(command(`pending_${index}`,index+3));
    expect(diagnostics.snapshot().pendingCommands).toBe(64);diagnostics.reset();
    expect(metrics.snapshot().counts).toMatchObject({deliveredMoveIssued:67,deliveredMoveCandidatesTracked:66,deliveredMoveRejected:1,deliveredMoveUncertifiedAtDeadline:1,deliveredMoveOverflow:1,deliveredMoveBoundaryCensored:64});
  });
  it('retains a pre-deadline applied view while its certificate crosses the command deadline',async()=>{
    let now=0,resolveStamp!:(value:PublicationStamp)=>void;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,()=>new Promise(resolve=>{resolveStamp=resolve;}));
    diagnostics.commandIssued(command());now=9990;diagnostics.observe(view(),now);now=10001;diagnostics.expire();
    expect(diagnostics.snapshot()).toMatchObject({pendingCommands:1,pendingJoins:1,commandsAwaitingEligibleJoins:1});
    now=10020;resolveStamp(stamp());await flush();
    expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toMatchObject({count:1,totalMs:9990});expect(metrics.snapshot().counts.deliveredMoveUncertifiedAtDeadline).toBeUndefined();expect(diagnostics.snapshot()).toMatchObject({pendingCommands:0,pendingJoins:0});
  });
  it('registers an already captured pre-deadline application before a later audit clock can expire it',async()=>{
    let now=0;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,async()=>stamp());
    diagnostics.commandIssued(command());now=10020;diagnostics.observe(view(),9990);await flush();
    expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toMatchObject({count:1,totalMs:9990});expect(metrics.snapshot().counts.deliveredMoveUncertifiedAtDeadline).toBeUndefined();
  });
  it('does not let a late-applied view qualify while an earlier join keeps the candidate alive',async()=>{
    let now=0,resolveStamp!:(value:PublicationStamp|undefined)=>void,lookups=0;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,()=>{lookups++;return new Promise(resolve=>{resolveStamp=resolve;});});
    diagnostics.commandIssued(command());now=9990;diagnostics.observe(view(),now);now=10001;diagnostics.observe(view(11),now);
    expect(lookups).toBe(1);resolveStamp(undefined);await flush();
    expect(metrics.snapshot().counts).toMatchObject({deliveryStampMissing:1,deliveredMoveUncertifiedAtDeadline:1});expect(metrics.snapshot().phases.commandIssuedToDeliveredMove).toBeUndefined();expect(diagnostics.snapshot().pendingCommands).toBe(0);
  });
  it('bounds a held pre-deadline join and reports its timeout separately from uncertified command expiry',async()=>{
    vi.useFakeTimers();let now=0;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,()=>new Promise(()=>{}));
    diagnostics.commandIssued(command());now=9990;diagnostics.observe(view(),now);now=11000;diagnostics.expire();expect(diagnostics.snapshot().pendingCommands).toBe(1);
    await vi.advanceTimersByTimeAsync(2001);await flush();
    expect(metrics.snapshot().counts).toMatchObject({deliveryJoinTimedOut:1,deliveredMoveUncertifiedAtDeadline:1});expect(metrics.snapshot().counts.deliveryStampMissing).toBeUndefined();expect(diagnostics.snapshot()).toMatchObject({pendingCommands:0,pendingJoins:0});
  });
  it('keeps accepted but uncertified moving-unit candidates in the issued denominator without claiming non-delivery',async()=>{
    let now=0;const metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,async()=>({...stamp(),movements:[]}));
    diagnostics.commandIssued(command());diagnostics.receipt({clientCommandId:'probe',sequence:1,tick:1,status:'accepted'});
    // A changed, visibly moving own body alone cannot establish idle-unit server eligibility.
    now=50;diagnostics.observe(view(),now);await flush();now=10001;diagnostics.expire();
    expect(metrics.snapshot().counts).toMatchObject({deliveredMoveIssued:1,deliveredMoveCandidatesTracked:1,deliveredMoveUncertifiedAtDeadline:1});expect(metrics.snapshot().counts.deliveredMoveExpiredWithoutDelivery).toBeUndefined();expect(metrics.snapshot().counts.deliveredMoveCompleted).toBeUndefined();
    expect(diagnostics.snapshot().eligibility).toContain('eligibility is unknown');expect(diagnostics.snapshot().eligibility).toContain('not proof of non-delivery');
  });
  it('bounds asynchronous joins and invalidates late results after reconnection',async()=>{
    let now=0;const resolvers:((value:PublicationStamp)=>void)[]=[],metrics=new PerformanceDiagnostics(()=>now),diagnostics=new ProcessDeliveryDiagnostics(metrics,()=>new Promise(resolve=>resolvers.push(resolve)));
    diagnostics.commandIssued(command());for(let tick=10;tick<27;tick++){now++;diagnostics.observe(view(tick),now);}
    expect(diagnostics.snapshot().pendingJoins).toBe(16);expect(metrics.snapshot().counts.deliveryJoinOverflow).toBe(1);
    diagnostics.reset();for(const [index,resolve]of resolvers.entries())resolve(stamp(index+10));await flush();
    expect(metrics.snapshot().counts.deliveredMoveCompleted).toBeUndefined();expect(metrics.snapshot().counts.deliveryJoinBoundaryCensored).toBe(16);
  });
});

it('preserves seeded impairment streams and excludes inherited credentials and runtime injection',()=>{
  const before=(client:number,stream:number,ordinal:number)=>{let state=(37^Math.imul(client+1,2654435761)^Math.imul(stream,2246822519)^Math.imul(ordinal,3266489917))>>>0;state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  for(let client=0;client<6;client++)for(let stream=1;stream<=5;stream++)for(let ordinal=0;ordinal<100;ordinal++)expect(impairmentRandom(37,client,stream,ordinal)).toBe(before(client,stream,ordinal));
  expect(observerEnvironment({PATH:'path',SystemRoot:'windows',TEMP:'temporary',AI_API_KEY:'secret',NODE_OPTIONS:'--require injected',OPENAI_API_KEY:'secret'})).toEqual({PATH:'path',SystemRoot:'windows',TEMP:'temporary'});
  expect(()=>assertObserverMessageSize({text:'x'.repeat(1024)},64)).toThrow('OBSERVER_IPC_BYTE_BOUND');
});

it('reports an owned observer process exit without exposing session credentials in its state',async()=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('BAD_TEST_ADDRESS');
  const configuration:ObserverConfiguration={mode:'process',baseUrl:`http://127.0.0.1:${address.port}`,origin:'http://127.0.0.1:3000',profile:'starting',profileIndex:0,seed:37,performanceDiagnosticsEnabled:false,drop:0,latencyMs:0,jitterMs:0,stallProbability:0,stallMs:250};
  const observer=new NetworkObserver({cookie:'frontier=private_test_cookie',csrf:'private_test_csrf',playerId:'human_1',host:false},()=>configuration,'source-tsx');
  try{
    await observer.connect();expect(observer.pid).toBeGreaterThan(0);expect(observer.pid).not.toBe(process.pid);
    const captured=await observer.capture();expect(JSON.stringify(captured)).not.toMatch(/private_test_cookie|private_test_csrf/);expect(captured).not.toHaveProperty('entities');
    process.kill(observer.pid!);const until=Date.now()+5000;while(!observer.failure&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,20));expect(observer.failure?.message).toBe('OBSERVER_PROCESS_EXITED');
  }finally{await observer.shutdown();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},20000);

it.each([false,true])('handles bounded delta chunks over a real observer socket (drop=%s)',async drop=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('BAD_TEST_ADDRESS');
  const configuration:ObserverConfiguration={mode:'inline',baseUrl:`http://127.0.0.1:${address.port}`,origin:'http://127.0.0.1:3000',profile:'starting',profileIndex:0,seed:37,performanceDiagnosticsEnabled:false,drop:drop?1:0,latencyMs:0,jitterMs:0,stallProbability:0,stallMs:250};
  const observer=new NetworkObserver({cookie:'frontier=private_chunk_cookie',csrf:'private_chunk_csrf',playerId:'human_1',host:false},()=>configuration,'source-tsx');
  const base:PlayerView={protocolVersion:2,contentHash,matchId:'chunk_observer',matchEpoch:1,sequence:1,tick:10,status:'RUNNING',playerId:'human_1',map:{widthMm:64000,heightMm:64000,fogCellMm:2000},
    players:Array.from({length:11},(_,index)=>({id:index<6?`human_${index+1}`:`ai_${index-5}`,name:`Faction ${index}`,teamId:`team_${index}`,kind:index<6?'human':'ai',color:'#123456'})),
    self:{lastCommandSequence:0,resources:{food:100,wood:100,gold:0,stone:0},age:1,population:0,populationCap:15,populationLimit:120,reservedPopulation:0},
    entities:Array.from({length:600},(_,index)=>({id:`resource_${index}`,kind:'resource',typeId:'tree_oak',ownerId:null,xMm:5000,zMm:5000,hp:1,maxHp:1,resource:'wood',amount:100})),fog:{visible:Array.from({length:1024},(_,index)=>index),explored:Array.from({length:1024},(_,index)=>index)}};
  const next=structuredClone(base);next.sequence=2;next.tick=12;next.self.resources.food=123;for(const entity of next.entities)entity.amount=90;
  const chunks=chunkViewDelta(createViewDelta(base,next),'observer_delta');expect(chunks.length).toBeGreaterThan(1);
  try{
    await observer.connect();const socket=[...server.clients][0]!;
    for(const chunk of chunkView(base,'observer_initial'))socket.send(JSON.stringify(chunk));
    await expect.poll(async()=>(await observer.capture()).view?.sequence).toBe(1);
    if(drop)await observer.operation({kind:'impair',enabled:true});
    socket.send(JSON.stringify(chunks[0]));
    await expect.poll(async()=>(await observer.capture()).metrics.deltaChunks).toBe(1);
    expect((await observer.capture()).view?.sequence).toBe(1);
    for(const chunk of chunks.slice(1))socket.send(JSON.stringify(chunk));
    if(drop){
      await expect.poll(async()=>(await observer.capture()).metrics.droppedReplicationFrames).toBe(chunks.length);
      expect((await observer.capture()).view?.sequence).toBe(1);expect((await observer.capture()).metrics.chunkedDeltas).toBe(0);
      await observer.operation({kind:'impair',enabled:false});for(const chunk of chunks)socket.send(JSON.stringify(chunk));
    }
    await expect.poll(async()=>(await observer.capture()).view?.sequence).toBe(2);
    let captured=await observer.capture();expect(captured.metrics).toMatchObject({chunkedDeltas:1,fullSnapshots:1,decodeRecoveries:0});expect(captured.view?.self.resources.food).toBe(123);expect(captured.failureCode).toBeNull();
    const third=structuredClone(next);third.sequence=3;third.tick=14;third.self.resources.food=124;
    socket.send(JSON.stringify({type:'delta',delta:createViewDelta(next,third)}));await expect.poll(async()=>(await observer.capture()).view?.sequence).toBe(3);
    const fourth=structuredClone(third);fourth.sequence=4;fourth.tick=16;fourth.self.resources.food=125;
    const replacement=chunkView(fourth,'observer_full_replacement'),beforeChunks=(await observer.capture()).metrics.snapshotChunks;
    socket.send(JSON.stringify(replacement[0]));await expect.poll(async()=>(await observer.capture()).metrics.snapshotChunks).toBe(beforeChunks+1);
    socket.send(JSON.stringify({type:'delta',delta:createViewDelta(third,fourth)}));await expect.poll(async()=>(await observer.capture()).metrics.deltas).toBe(2);
    expect((await observer.capture()).view?.sequence).toBe(3);
    for(const chunk of replacement.slice(1))socket.send(JSON.stringify(chunk));await expect.poll(async()=>(await observer.capture()).view?.sequence).toBe(4);
    // A valid future update with the wrong completed base must request resync,
    // rather than applying a partially assembled or stale change set.
    const fifth=structuredClone(fourth);fifth.sequence=5;fifth.tick=18;
    socket.send(JSON.stringify(chunkViewDelta(createViewDelta(base,fifth),'wrong_completed_base')[0]));
    await expect.poll(async()=>(await observer.capture()).metrics.decodeRecoveries).toBe(1);
    captured=await observer.capture();expect(captured.view).toBeUndefined();expect(captured.metrics.resyncRequests).toBe(1);expect(captured.failureCode).toBeNull();
    for(const chunk of chunkView(fourth,'observer_recovery'))socket.send(JSON.stringify(chunk));
    await expect.poll(async()=>(await observer.capture()).view?.sequence).toBe(4);
    socket.send(JSON.stringify(chunks.at(-1)));await new Promise(resolve=>setTimeout(resolve,20));
    captured=await observer.capture();expect(captured.view?.sequence).toBe(4);expect(captured.metrics.decodeRecoveries).toBe(1);expect(JSON.stringify(captured)).not.toMatch(/private_chunk_cookie|private_chunk_csrf/);
    const freshEpoch=structuredClone(fourth);freshEpoch.matchEpoch=2;freshEpoch.sequence=1;
    for(const chunk of chunkView(freshEpoch,'observer_new_epoch'))socket.send(JSON.stringify(chunk));await expect.poll(async()=>(await observer.capture()).view?.matchEpoch).toBe(2);
    socket.send(JSON.stringify(replacement.at(-1)));await new Promise(resolve=>setTimeout(resolve,20));
    captured=await observer.capture();expect(captured.view?.matchEpoch).toBe(2);expect(captured.metrics.decodeRecoveries).toBe(1);
  }finally{await observer.shutdown();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
},15000);
