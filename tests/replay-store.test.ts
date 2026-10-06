import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createSimulation, exportSimulationSave, ReplayRunner, replayCheckpoint, simulationChecksum, type Building, type EngineIdentity, type JournalBatch, type JournalEvent, type ReplayCheckpoint, type SaveEnvelope } from '@frontier/simulation';
import { MAX_REPLAY_BYTES, MAX_REPLAY_QUEUED_BYTES, ReplayStore } from '../apps/server/src/replay-store.js';

const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const root=resolve('runtime-data/replay-store-tests');let directory:string,stores:ReplayStore[]=[];
let initial:SaveEnvelope,batch:JournalBatch,point:ReplayCheckpoint,endTick:number,endOrdinal:number,expectedChecksum:string;
beforeAll(()=>{
  const sim=createSimulation({seed:'durable-replay-store',matchId:'durable_replay',controllers:false,factions:[{id:'a',name:'A',teamId:'a',color:'#aabbcc',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ddeeff',kind:'human'}]});
  initial=exportSimulationSave(sim,identity);const home=Object.values(sim.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a'&&entity.typeId==='town_center')!;
  sim.command('a',{protocolVersion:2,matchId:'durable_replay',matchEpoch:1,clientCommandId:'paid_train',clientSequence:1,command:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}});
  sim.command('a',{protocolVersion:2,matchId:'durable_replay',matchEpoch:1,clientCommandId:'rejected_order',clientSequence:2,command:{kind:'stop',unitIds:['not_owned']}});
  sim.step(4);sim.setStatus('PAUSED');sim.setStatus('RUNNING');sim.step(2);sim.endAsDraw();batch=sim.drainJournal();point=replayCheckpoint(sim);endTick=sim.state.tick;endOrdinal=sim.state.eventOrdinal;expectedChecksum=simulationChecksum(sim);
});
beforeEach(async()=>{await fs.mkdir(root,{recursive:true});directory=await fs.mkdtemp(resolve(root,'case-'));stores=[];});
afterEach(async()=>{for(const store of stores)await store.close();const child=relative(root,directory);if(!child||child.startsWith('..')||isAbsolute(child))throw new Error('UNSAFE_TEST_CLEANUP');await fs.rm(directory,{recursive:true,force:true});});
function store(io?:ConstructorParameters<typeof ReplayStore>[2]){const result=new ReplayStore(directory,identity,io);stores.push(result);return result;}
async function complete(target:ReplayStore){await target.start(initial);expect(target.append(batch)).toBe(true);expect(target.checkpoint(point)).toBe(true);return target.finish(endTick,endOrdinal);}

describe('durable append-only host replay storage',()=>{
  it('persists a hash-chained journal, finalizes atomically, and replays real accepted/rejected commands to the authoritative checksum',async()=>{
    const target=store(),summary=await complete(target);expect(target.status()).toMatchObject({state:'complete',healthy:true,queuedBytes:0,receivedOrdinal:endOrdinal,writtenOrdinal:endOrdinal});
    const fresh=store(),loaded=await fresh.read(summary.id),runner=new ReplayRunner(loaded.recording,identity);expect(runner.advanceTo(endTick,200)).toMatchObject({tick:endTick,done:true,ordinal:endOrdinal});expect(simulationChecksum(runner.simulation)).toBe(expectedChecksum);expect(loaded.summary).toEqual(summary);
    const lines=(await fs.readFile(resolve(directory,summary.id+'.ndjson'),'utf8')).trimEnd().split('\n').map(line=>JSON.parse(line));expect(lines.map(line=>line.record.kind)).toEqual(['header','batch','checkpoint','end']);expect(lines[1].previous).toBe(lines[0].checksum);
    expect(await fresh.list()).toEqual({recordings:[summary],warnings:[]});expect((await fs.readdir(directory)).sort()).toEqual([summary.id+'.json',summary.id+'.ndjson'].sort());
  });
  it('accepts bounded appends while start is awaiting disk and captures immutable event/header data',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),io={...fs,mkdir:(async(...args:Parameters<typeof fs.mkdir>)=>{await gate;return fs.mkdir(...args);}) as typeof fs.mkdir},target=store(io),source=structuredClone(initial),events=structuredClone(batch);
    const starting=target.start(source);expect(target.status().state).toBe('starting');expect(target.append(events)).toBe(true);events.events[0]!.ordinal=999;source.payload.state.tick=999;expect(target.checkpoint(point)).toBe(true);
    release();await starting;const summary=await target.finish(endTick,endOrdinal),recording=(await target.read(summary.id)).recording;expect(recording.initial.payload.state.tick).toBe(initial.payload.state.tick);expect(recording.events[0]!.ordinal).toBe(batch.events[0]!.ordinal);
  });
  it('honors a through-ordinal highwater while draining partial consecutive batches',async()=>{
    const target=store();await target.start(initial);expect(target.append({events:batch.events.slice(0,2),throughOrdinal:endOrdinal})).toBe(true);expect(target.checkpoint(point)).toBe(true);expect(target.append({events:batch.events.slice(2),throughOrdinal:endOrdinal})).toBe(true);const summary=await target.finish(endTick,endOrdinal);expect((await target.read(summary.id)).recording.events).toEqual(batch.events);
  });
  it.each(['source gap','missing ordinal','duplicate ordinal','backwards tick'] as const)('marks %s permanently incomplete instead of presenting a playable artifact',async flaw=>{
    const target=store(),warnings:string[]=[];target.onFailure=code=>warnings.push(code);await target.start(initial);const broken=structuredClone(batch);
    if(flaw==='source gap')broken.gapBeforeOrdinal=2;
    if(flaw==='missing ordinal')broken.events.shift();
    if(flaw==='duplicate ordinal')broken.events.splice(1,0,structuredClone(broken.events[0]!));
    if(flaw==='backwards tick')broken.events.at(-1)!.tick=0;
    expect(target.append(broken)).toBe(false);expect(target.status()).toMatchObject({state:'failed',healthy:false,error:'REPLAY_JOURNAL_GAP'});expect(warnings).toEqual(['REPLAY_JOURNAL_GAP']);expect(target.append(batch)).toBe(false);await expect(target.finish(endTick,endOrdinal)).rejects.toThrow('REPLAY_JOURNAL_GAP');expect((await target.list()).recordings).toEqual([]);
  });
  it('refuses finalization with undrained ordinals and lists interrupted journals only as warnings',async()=>{
    const target=store(),started=await target.start(initial);expect(target.append({events:batch.events.slice(0,1),throughOrdinal:endOrdinal})).toBe(true);await expect(target.finish(endTick,endOrdinal)).rejects.toThrow('REPLAY_JOURNAL_INCOMPLETE');await target.close();expect(await store().list()).toEqual({recordings:[],warnings:[{id:started.id,code:'REPLAY_INCOMPLETE'}]});
  });
  it('bounds queued disk work even when starting never drains, and never holds the event loop waiting on IO',async()=>{
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),target=store({...fs,mkdir:(async(...args:Parameters<typeof fs.mkdir>)=>{await gate;return fs.mkdir(...args);}) as typeof fs.mkdir});
    const starting=target.start(initial),caught=starting.catch(error=>error as Error);let ordinal=initial.payload.state.eventOrdinal,accepted=0;
    while(target.status().healthy&&accepted<200){const events:JournalEvent[]=Array.from({length:512},()=>({kind:'invalid_command',ordinal:++ordinal,tick:0,phase:'boundary',playerId:'a',receipt:{status:'rejected',clientCommandId:'x'.repeat(96),code:'Y'.repeat(96),tick:0,sequence:0}}));if(target.append({events,throughOrdinal:ordinal}))accepted++;}
    expect(accepted).toBeGreaterThan(0);expect(accepted).toBeLessThan(200);expect(target.status()).toMatchObject({healthy:false,error:'REPLAY_QUEUE_LIMIT',queuedBytes:0});expect(target.status().queuedBytes).toBeLessThanOrEqual(MAX_REPLAY_QUEUED_BYTES);
    let responsive=false;await new Promise<void>(resolve=>setImmediate(()=>{responsive=true;resolve();}));expect(responsive).toBe(true);release();expect(await caught).toBeInstanceOf(Error);expect((await target.list()).recordings).toEqual([]);
  });
  it('reports an append failure without blocking later simulation work or overwriting a prior recording',async()=>{
    const good=store(),prior=await complete(good);let writes=0;
    const faulty=store({...fs,open:(async(...args:Parameters<typeof fs.open>)=>{const handle=await fs.open(...args);return new Proxy(handle,{get(target,key){if(key==='writeFile')return async(...parameters:Parameters<typeof handle.writeFile>)=>{if(++writes>1)throw new Error('Injected ENOSPC');return target.writeFile(...parameters);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}) as typeof fs.open});
    await faulty.start(initial);expect(faulty.append(batch)).toBe(true);await expect(faulty.flush()).rejects.toThrow('REPLAY_WRITE_FAILED');expect(faulty.status().healthy).toBe(false);expect((await good.read(prior.id)).summary).toEqual(prior);expect((await faulty.list()).recordings.map(entry=>entry.id)).toEqual([prior.id]);
  });
  it('cleans an unsuccessful final rename while preserving its journal and prior finalized recordings',async()=>{
    const prior=await complete(store()),faulty=store({...fs,rename:async()=>{throw new Error('Injected EACCES');}});await faulty.start(initial);faulty.append(batch);await expect(faulty.finish(endTick,endOrdinal)).rejects.toThrow('REPLAY_WRITE_FAILED');expect((await fs.readdir(directory)).some(name=>name.includes('.tmp_'))).toBe(false);expect((await store().list()).recordings.map(entry=>entry.id)).toEqual([prior.id]);
  });
  it('rejects journal tampering before finalization and finalized corruption or incompatible engines on read',async()=>{
    const target=store(),started=await target.start(initial);target.append(batch);await target.flush();const journalPath=resolve(directory,started.id+'.ndjson'),text=await fs.readFile(journalPath,'utf8');await fs.writeFile(journalPath,text.replace('paid_train','fake_train'));await expect(target.finish(endTick,endOrdinal)).rejects.toThrow('REPLAY_JOURNAL_CORRUPT');
    const good=store(),summary=await complete(good),path=resolve(directory,summary.id+'.json');const file=JSON.parse(await fs.readFile(path,'utf8'));file.recording.endTick++;await fs.writeFile(path,JSON.stringify(file));await expect(good.read(summary.id)).rejects.toThrow('REPLAY_CHECKSUM_MISMATCH');
    file.recording.endTick--;file.createdAt='2026-09-19T00:00:00.000Z';const {checksum:_checksum,...body}=file;file.checksum=createHash('sha256').update(JSON.stringify(body)).digest('hex');await fs.writeFile(path,JSON.stringify(file));
    const incompatible=new ReplayStore(directory,{...identity,engineBuildHash:'b'.repeat(64)});stores.push(incompatible);await expect(incompatible.read(summary.id)).rejects.toThrow('ENGINE_VERSION_MISMATCH');
  });
  it('rejects path traversal and oversized files before reading payload bytes',async()=>{
    const target=store();await expect(target.read('../server-secret')).rejects.toThrow('INVALID_REPLAY_ID');const saved=await complete(target),stat=await fs.stat(resolve(directory,saved.id+'.json'));stat.size=MAX_REPLAY_BYTES+1;let read=false;
    const bounded=store({...fs,stat:(async()=>stat) as unknown as typeof fs.stat,readFile:(async()=>{read=true;throw new Error('Should not read');}) as typeof fs.readFile});await expect(bounded.read(saved.id)).rejects.toThrow('REPLAY_TOO_LARGE');expect(read).toBe(false);
  });
});
