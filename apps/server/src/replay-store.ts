import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { createReplayRecording, ReplayRunner, validateSave, type EngineIdentity, type JournalBatch, type JournalEvent, type ReplayCheckpoint, type ReplayRecording, type SaveEnvelope } from '@frontier/simulation';
import { validateJournalEvent } from '../../../packages/simulation/src/save-schema.js';

export const MAX_REPLAY_QUEUED_BYTES=16*1024*1024;
export const MAX_REPLAY_BYTES=256*1024*1024;
const MAX_REPLAY_EVENTS=2_000_000,MAX_REPLAY_CHECKPOINTS=100_000,MAX_REPLAY_FILES=512;
const pattern=/^replay_[0-9]{13}_[a-f0-9]{16}$/;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const hash=(value:unknown)=>digest(JSON.stringify(value));
const isHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const checkpointValid=(value:unknown):value is ReplayCheckpoint=>record(value)&&exact(value,['tick','ordinal','checksum'])&&integer(value.tick)&&integer(value.ordinal)&&isHash(value.checksum);
type ReplayIO=Pick<typeof fs,'mkdir'|'open'|'rename'|'unlink'|'readFile'|'readdir'|'stat'>;
type State='idle'|'starting'|'recording'|'finalizing'|'complete'|'failed';
export interface ReplaySummary {id:string;createdAt:string;startTick:number;endTick:number;endOrdinal:number;bytes:number}
export interface ReplayStoreStatus {state:State;healthy:boolean;id?:string;queuedBytes:number;receivedOrdinal:number;writtenOrdinal:number;error?:string}
export interface ReplayListing {recordings:ReplaySummary[];warnings:{id:string;code:string}[]}
type JournalRecord=
  |{kind:'header';formatVersion:1;id:string;createdAt:string;initial:SaveEnvelope}
  |{kind:'batch';batch:JournalBatch}
  |{kind:'checkpoint';checkpoint:ReplayCheckpoint}
  |{kind:'end';endTick:number;endOrdinal:number};
interface QueueEntry {line:string;bytes:number;ordinal?:number}
interface ReplayFile {formatVersion:1;id:string;createdAt:string;recording:ReplayRecording;checksum:string}

/** Host-only disk ownership. Enqueuing never waits for disk or blocks a simulation tick. */
export class ReplayStore {
  readonly directory:string;
  onFailure:(code:string)=>void=()=>{};
  private state:State='idle';private id?:string;private createdAt='';private error?:string;
  private initialTick=0;private initialOrdinal=0;private receivedOrdinal=0;private writtenOrdinal=0;private throughOrdinal=0;private lastTick=0;
  private events=0;private checkpoints=0;private lastCheckpoint?:ReplayCheckpoint;
  private queuedBytes=0;private totalBytes=0;private chain='0'.repeat(64);private queue:QueueEntry[]=[];
  private handle?:fs.FileHandle;private opening?:Promise<void>;private writer?:Promise<void>;
  constructor(directory:string,private readonly identity:EngineIdentity,private readonly io:ReplayIO=fs){this.directory=resolve(directory);}
  status():ReplayStoreStatus{return {state:this.state,healthy:this.state==='starting'||this.state==='recording'||this.state==='finalizing'||this.state==='complete',...(this.id?{id:this.id}:{}),queuedBytes:this.queuedBytes,receivedOrdinal:this.receivedOrdinal,writtenOrdinal:this.writtenOrdinal,...(this.error?{error:this.error}:{})};}
  private path(id:string,suffix:'.json'|'.ndjson'):string {
    if(!pattern.test(id))throw new Error('INVALID_REPLAY_ID');const path=resolve(this.directory,id+suffix),child=relative(this.directory,path);
    if(isAbsolute(child)||child.startsWith('..'))throw new Error('INVALID_REPLAY_ID');return path;
  }
  private fail(code:string):false {if(this.state!=='failed'){this.state='failed';this.error=code;this.queue=[];this.queuedBytes=0;try{this.onFailure(code);}catch{/* Reporting must never backpressure the simulation. */}}return false;}
  private line(value:JournalRecord):QueueEntry {
    const body=JSON.stringify(value),previous=this.chain,checksum=digest(previous+'\n'+body),line=JSON.stringify({record:value,previous,checksum})+'\n';this.chain=checksum;
    return {line,bytes:Buffer.byteLength(line)};
  }
  start(initial:SaveEnvelope):Promise<{id:string}> {
    if(this.state!=='idle')return Promise.reject(new Error('REPLAY_ALREADY_STARTED'));
    let entry:QueueEntry;
    try{
      const payload=validateSave(initial,this.identity),now=Date.now();this.id=`replay_${now}_${randomBytes(8).toString('hex')}`;this.createdAt=new Date(now).toISOString();
      this.initialTick=this.lastTick=payload.state.tick;this.initialOrdinal=this.receivedOrdinal=this.writtenOrdinal=this.throughOrdinal=payload.state.eventOrdinal;
      entry=this.line({kind:'header',formatVersion:1,id:this.id,createdAt:this.createdAt,initial:structuredClone(initial)});if(entry.bytes>MAX_REPLAY_BYTES)throw new Error('REPLAY_TOO_LARGE');this.totalBytes=entry.bytes;this.state='starting';
    }catch(error){const code=error instanceof Error?error.message:'INVALID_REPLAY_INITIAL';this.fail(code);return Promise.reject(new Error(code));}
    this.opening=(async()=>{
      try{
        await this.io.mkdir(this.directory,{recursive:true,mode:0o700});const names=await this.io.readdir(this.directory),ids=new Set(names.filter(name=>name.endsWith('.json')||name.endsWith('.ndjson')).map(name=>name.replace(/\.(?:ndjson|json)$/,'')).filter(id=>pattern.test(id)));
        if(ids.size>=MAX_REPLAY_FILES)throw new Error('REPLAY_DIRECTORY_LIMIT');
        this.handle=await this.io.open(this.path(this.id!,'.ndjson'),'wx',0o600);await this.handle.writeFile(entry.line);await this.handle.sync();if(this.state==='failed')throw new Error(this.error??'REPLAY_FAILED');
        if(this.state==='starting')this.state='recording';this.pump();
      }catch(error){const code=error instanceof Error&&/^REPLAY_[A-Z_]+$/.test(error.message)?error.message:'REPLAY_WRITE_FAILED';this.fail(code);if(this.handle){await this.handle.close().catch(()=>{});this.handle=undefined;}throw new Error(code);}
    })();
    // The caller can observe/recover this rejection; internal writers also await it.
    return this.opening.then(()=>({id:this.id!}));
  }
  private enqueue(value:JournalRecord,ordinal?:number):boolean {
    const previous=this.chain,entry=this.line(value);
    if(entry.bytes>MAX_REPLAY_QUEUED_BYTES||this.queuedBytes+entry.bytes>MAX_REPLAY_QUEUED_BYTES){this.chain=previous;return this.fail('REPLAY_QUEUE_LIMIT');}
    if(this.totalBytes+entry.bytes>MAX_REPLAY_BYTES){this.chain=previous;return this.fail('REPLAY_TOO_LARGE');}
    this.totalBytes+=entry.bytes;this.queuedBytes+=entry.bytes;this.queue.push({...entry,...(ordinal!==undefined?{ordinal}:{})});this.pump();return true;
  }
  append(batch:JournalBatch):boolean {
    if(!['starting','recording'].includes(this.state))return false;
    if(!record(batch)||!Object.keys(batch).every(key=>['events','throughOrdinal','gapBeforeOrdinal'].includes(key))||!Array.isArray(batch.events)||batch.events.length>4096||!integer(batch.throughOrdinal)||batch.throughOrdinal<this.throughOrdinal)return this.fail('INVALID_REPLAY_BATCH');
    if(batch.gapBeforeOrdinal!==undefined)return this.fail('REPLAY_JOURNAL_GAP');
    let ordinal=this.receivedOrdinal,tick=this.lastTick;
    for(const event of batch.events){if(!validateJournalEvent(event)||event.ordinal!==ordinal+1||event.tick<tick||event.ordinal>batch.throughOrdinal)return this.fail('REPLAY_JOURNAL_GAP');ordinal=event.ordinal;tick=event.tick;}
    if(this.events+batch.events.length>MAX_REPLAY_EVENTS)return this.fail('REPLAY_EVENT_LIMIT');
    if(!this.enqueue({kind:'batch',batch},ordinal))return false;
    this.receivedOrdinal=ordinal;this.throughOrdinal=batch.throughOrdinal;this.lastTick=tick;this.events+=batch.events.length;return true;
  }
  checkpoint(point:ReplayCheckpoint):boolean {
    if(!['starting','recording'].includes(this.state))return false;
    if(!checkpointValid(point)||point.tick<this.initialTick||point.ordinal<this.initialOrdinal||point.ordinal>this.throughOrdinal||this.lastCheckpoint&&(point.tick<this.lastCheckpoint.tick||point.ordinal<this.lastCheckpoint.ordinal))return this.fail('INVALID_REPLAY_CHECKPOINT');
    if(++this.checkpoints>MAX_REPLAY_CHECKPOINTS)return this.fail('REPLAY_CHECKPOINT_LIMIT');
    if(!this.enqueue({kind:'checkpoint',checkpoint:point}))return false;this.lastCheckpoint={...point};return true;
  }
  private pump():void {
    if(this.writer||!this.handle||!this.queue.length||!['recording','finalizing'].includes(this.state))return;
    const run=(async()=>{
      try{while(this.queue.length&&this.handle&&['recording','finalizing'].includes(this.state)){
        const entry=this.queue[0]!;await this.handle.writeFile(entry.line);await this.handle.sync();
        if(entry.ordinal!==undefined)this.writtenOrdinal=entry.ordinal;
        if(this.queue[0]===entry){this.queue.shift();this.queuedBytes-=entry.bytes;}
      }}catch{this.fail('REPLAY_WRITE_FAILED');}
    })();this.writer=run;void run.then(()=>{this.writer=undefined;this.pump();});
  }
  async flush():Promise<void> {
    if(this.opening)await this.opening;
    while(this.writer||this.queue.length){if(this.state==='failed')break;this.pump();if(this.writer)await this.writer;else break;}
    if(this.state==='failed')throw new Error(this.error??'REPLAY_FAILED');
  }
  async finish(endTick:number,endOrdinal:number):Promise<ReplaySummary> {
    if(!['starting','recording'].includes(this.state))throw new Error(this.error??'REPLAY_NOT_RECORDING');
    if(!integer(endTick)||!integer(endOrdinal)||endTick<this.lastTick||endOrdinal!==this.receivedOrdinal||endOrdinal!==this.throughOrdinal||this.lastCheckpoint&&(this.lastCheckpoint.tick>endTick||this.lastCheckpoint.ordinal>endOrdinal)){this.fail('REPLAY_JOURNAL_INCOMPLETE');throw new Error(this.error);}
    this.state='finalizing';let temporary:string|undefined;
    try{
      await this.flush();if(!this.enqueue({kind:'end',endTick,endOrdinal}))throw new Error(this.error);await this.flush();
      await this.handle!.close();this.handle=undefined;
      const recording=await this.readJournal(this.id!);new ReplayRunner(recording,this.identity);
      const body={formatVersion:1 as const,id:this.id!,createdAt:this.createdAt,recording},file:ReplayFile={...body,checksum:hash(body)},bytes=Buffer.from(JSON.stringify(file));if(bytes.length>MAX_REPLAY_BYTES)throw new Error('REPLAY_TOO_LARGE');
      const target=this.path(this.id!,'.json');temporary=target+`.tmp_${randomBytes(8).toString('hex')}`;const handle=await this.io.open(temporary,'wx',0o600);
      try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
      await this.io.rename(temporary,target);temporary=undefined;this.state='complete';return this.summary(file,bytes.length);
    }catch(error){const code=error instanceof Error&&/^REPLAY_[A-Z_]+$/.test(error.message)?error.message:'REPLAY_WRITE_FAILED';this.fail(code);throw new Error(code);}
    finally{if(temporary)await this.io.unlink(temporary).catch(()=>{});}
  }
  private async readBytes(path:string):Promise<Buffer>{const stat=await this.io.stat(path);if(!stat.isFile()||stat.size>MAX_REPLAY_BYTES)throw new Error('REPLAY_TOO_LARGE');const bytes=await this.io.readFile(path);if(bytes.length>MAX_REPLAY_BYTES)throw new Error('REPLAY_TOO_LARGE');return bytes;}
  private async readJournal(id:string):Promise<ReplayRecording> {
    const text=(await this.readBytes(this.path(id,'.ndjson'))).toString('utf8');if(!text.endsWith('\n'))throw new Error('REPLAY_JOURNAL_INCOMPLETE');
    let chain='0'.repeat(64),cursor=0,initial:SaveEnvelope|undefined,end:{endTick:number;endOrdinal:number}|undefined,ordinal=0,tick=0,through=0;const events:JournalEvent[]=[],checkpoints:ReplayCheckpoint[]=[];
    while(cursor<text.length){
      const newline=text.indexOf('\n',cursor);let value:unknown;try{value=JSON.parse(text.slice(cursor,newline));}catch{throw new Error('REPLAY_CORRUPT');}cursor=newline+1;
      if(!record(value)||!exact(value,['record','previous','checksum'])||value.previous!==chain||!isHash(value.checksum)||digest(chain+'\n'+JSON.stringify(value.record))!==value.checksum||!record(value.record)||end)throw new Error('REPLAY_JOURNAL_CORRUPT');chain=value.checksum;const line=value.record;
      if(line.kind==='header'){
        if(initial||!exact(line,['kind','formatVersion','id','createdAt','initial'])||line.formatVersion!==1||line.id!==id||line.createdAt!==this.createdAt)throw new Error('INVALID_REPLAY_HEADER');
        const payload=validateSave(line.initial,this.identity);initial=line.initial as SaveEnvelope;ordinal=through=payload.state.eventOrdinal;tick=payload.state.tick;
      }else if(!initial)throw new Error('INVALID_REPLAY_HEADER');
      else if(line.kind==='batch'){
        if(!exact(line,['kind','batch'])||!record(line.batch)||!exact(line.batch,['events','throughOrdinal'])||!Array.isArray(line.batch.events)||line.batch.events.length>4096||!integer(line.batch.throughOrdinal)||line.batch.throughOrdinal<through)throw new Error('INVALID_REPLAY_BATCH');
        through=line.batch.throughOrdinal;for(const event of line.batch.events){if(!validateJournalEvent(event)||event.ordinal!==++ordinal||event.tick<tick||event.ordinal>through)throw new Error('REPLAY_JOURNAL_GAP');tick=event.tick;events.push(event);}if(events.length>MAX_REPLAY_EVENTS)throw new Error('REPLAY_EVENT_LIMIT');
      }else if(line.kind==='checkpoint'){
        if(!exact(line,['kind','checkpoint'])||!checkpointValid(line.checkpoint)||line.checkpoint.ordinal>through)throw new Error('INVALID_REPLAY_CHECKPOINT');checkpoints.push(line.checkpoint);if(checkpoints.length>MAX_REPLAY_CHECKPOINTS)throw new Error('REPLAY_CHECKPOINT_LIMIT');
      }else if(line.kind==='end'){
        if(!exact(line,['kind','endTick','endOrdinal'])||!integer(line.endTick)||!integer(line.endOrdinal)||line.endTick<tick||line.endOrdinal!==ordinal||line.endOrdinal!==through)throw new Error('REPLAY_JOURNAL_INCOMPLETE');end={endTick:line.endTick,endOrdinal:line.endOrdinal};
      }else throw new Error('INVALID_REPLAY_RECORD');
    }
    if(!initial||!end)throw new Error('REPLAY_JOURNAL_INCOMPLETE');return createReplayRecording(initial,events,checkpoints,end.endTick,end.endOrdinal);
  }
  private summary(file:ReplayFile,bytes:number):ReplaySummary{return {id:file.id,createdAt:file.createdAt,startTick:file.recording.initial.payload.state.tick,endTick:file.recording.endTick,endOrdinal:file.recording.endOrdinal,bytes};}
  async read(id:string):Promise<{summary:ReplaySummary;recording:ReplayRecording}> {
    const bytes=await this.readBytes(this.path(id,'.json'));let file:unknown;try{file=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('REPLAY_CORRUPT');}
    if(!record(file)||!exact(file,['formatVersion','id','createdAt','recording','checksum'])||file.formatVersion!==1||file.id!==id||typeof file.createdAt!=='string'||!Number.isFinite(Date.parse(file.createdAt))||!isHash(file.checksum))throw new Error('INVALID_REPLAY_FILE');
    const {checksum,...body}=file;if(hash(body)!==checksum)throw new Error('REPLAY_CHECKSUM_MISMATCH');new ReplayRunner(file.recording,this.identity);
    const valid=file as unknown as ReplayFile;return {summary:this.summary(valid,bytes.length),recording:valid.recording};
  }
  async list():Promise<ReplayListing> {
    let names:string[];try{names=await this.io.readdir(this.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {recordings:[],warnings:[]};throw error;}
    const ids=[...new Set(names.filter(name=>/\.(ndjson|json)$/.test(name)).map(name=>name.replace(/\.(ndjson|json)$/,'')).filter(id=>pattern.test(id)))];if(ids.length>MAX_REPLAY_FILES)throw new Error('REPLAY_DIRECTORY_LIMIT');const result:ReplayListing={recordings:[],warnings:[]};
    for(const id of ids){if(!names.includes(id+'.json')){result.warnings.push({id,code:'REPLAY_INCOMPLETE'});continue;}try{result.recordings.push((await this.read(id)).summary);}catch(error){const message=error instanceof Error?error.message:'';result.warnings.push({id,code:/^[A-Z][A-Z_]{1,95}$/.test(message)?message:'REPLAY_READ_FAILED'});}}
    result.recordings.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));return result;
  }
  async close():Promise<void>{if(!['complete','failed','idle'].includes(this.state))this.fail('REPLAY_INCOMPLETE');await this.opening?.catch(()=>{});await this.writer;if(this.handle){await this.handle.close().catch(()=>{});this.handle=undefined;}}
}
