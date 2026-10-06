import { createHash } from 'node:crypto';
import { COARSE_MOVEMENT_DECISION_TICKS, resolveRuleset } from '@frontier/shared';
import { Simulation,createLiveSimulation,type SimulationOptions,type LiveSimulation } from './index.js';
import { validateJournalEvent, validateSimulationSavePayload } from './save-schema.js';
import type { EngineIdentity, ReplayCheckpoint, ReplayRecording, RestoreOptions, SaveEnvelope, SimulationSavePayload } from './persistence-types.js';

const checksum=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const record=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const exactKeys=(value:Record<string,unknown>,keys:readonly string[]):boolean=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const fingerprint=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function identityValid(value:EngineIdentity):boolean{return fingerprint(value.engineBuildHash)&&record(value.runtimeProfile)&&exactKeys(value.runtimeProfile,['nodeVersion','platform','arch'])&&Object.values(value.runtimeProfile).every(part=>typeof part==='string'&&part.length>0&&part.length<=128);}
export function sealSimulationCapture(payload:SimulationSavePayload,identity:EngineIdentity):SaveEnvelope {
  if(!identityValid(identity))throw new Error('INVALID_ENGINE_IDENTITY');
  const body={formatVersion:1 as const,engineBuildHash:identity.engineBuildHash,runtimeProfile:structuredClone(identity.runtimeProfile),payload:structuredClone(payload)};return {...body,checksum:checksum(body)};
}
export function exportSimulationSave(simulation:Simulation|LiveSimulation,identity:EngineIdentity):SaveEnvelope{return sealSimulationCapture(simulation.capture(),identity);}
/** Validate a locally owned/parsed envelope synchronously without making a
 * discarded payload copy. This does not transfer ownership or make it immutable;
 * callers needing an independent snapshot must use validateSave below. */
export function assertValidSave(input:unknown,identity:EngineIdentity):asserts input is SaveEnvelope {
  if(!identityValid(identity))throw new Error('INVALID_ENGINE_IDENTITY');
  if(!record(input)||!exactKeys(input,['formatVersion','engineBuildHash','runtimeProfile','payload','checksum']))throw new Error('INVALID_SAVE');
  if(input.formatVersion!==1)throw new Error('SAVE_VERSION_UNSUPPORTED');
  if(input.engineBuildHash!==identity.engineBuildHash)throw new Error('ENGINE_VERSION_MISMATCH');
  if(!record(input.runtimeProfile)||!exactKeys(input.runtimeProfile,['nodeVersion','platform','arch'])||input.runtimeProfile.nodeVersion!==identity.runtimeProfile.nodeVersion||input.runtimeProfile.platform!==identity.runtimeProfile.platform||input.runtimeProfile.arch!==identity.runtimeProfile.arch)throw new Error('ENGINE_RUNTIME_MISMATCH');
  const body={formatVersion:input.formatVersion,engineBuildHash:input.engineBuildHash,runtimeProfile:input.runtimeProfile,payload:input.payload};
  if(!fingerprint(input.checksum)||checksum(body)!==input.checksum)throw new Error('SAVE_CHECKSUM_MISMATCH');
  if(record(input.payload)){const options=input.payload.options as SimulationSavePayload['options'];if(!options||input.payload.contentHash!==resolveRuleset(options.rulesetId,options.maxAge,options.startingResourcePreset).contentHash)throw new Error('CONTENT_VERSION_MISMATCH');}
  if(!validateSimulationSavePayload(input.payload))throw new Error('INVALID_SAVE_PAYLOAD');
}
/** Validate completely before constructing a world or importing any helper state;
 * retain the public independent-snapshot contract. */
export function validateSave(input:unknown,identity:EngineIdentity):SimulationSavePayload {
  assertValidSave(input,identity);
  return structuredClone(input.payload);
}
export function restoreSimulation(input:unknown,identity:EngineIdentity,options:RestoreOptions={}):Simulation {
  return restoreWith(input,identity,options,(settings,payload)=>new Simulation(settings,payload));
}
/** Native live workers restore directly into an inaccessible authoritative
 * owner; no raw instance exists at the gateway or escapes validation. */
export function restoreLiveSimulation(input:unknown,identity:EngineIdentity,options:RestoreOptions={}):LiveSimulation {
  return restoreWith(input,identity,options,createLiveSimulation);
}
function restoreWith<T extends Simulation|LiveSimulation>(input:unknown,identity:EngineIdentity,options:RestoreOptions,construct:(settings:SimulationOptions,payload:SimulationSavePayload)=>T):T {
  const payload=validateSave(input,identity),state=payload.state;
  const finished=state.status==='FINISHED';if(finished&&options.status!==undefined&&options.status!=='FINISHED')throw new Error('FINISHED_SAVE_CANNOT_RESUME');
  const simulation=construct({...payload.options,factions:state.factions,matchId:state.matchId,epoch:state.matchEpoch,secretIdKey:state.secretIdKey},payload);
  if(!options.preserveEpoch){
    const epoch=options.newEpoch??state.matchEpoch+1;if(!Number.isSafeInteger(epoch)||epoch<=state.matchEpoch||epoch>2147483647)throw new Error('INVALID_RESTORE_EPOCH');
    simulation.invalidateEpoch(epoch);
  }else if(options.newEpoch!==undefined&&options.newEpoch!==state.matchEpoch)throw new Error('INVALID_RESTORE_EPOCH');
  const status=options.status??(finished?'FINISHED':options.preserveEpoch?state.status:'PAUSED');if(status!==simulation.state.status)simulation.setStatus(status);
  return simulation;
}
export function simulationChecksum(simulation:Simulation|LiveSimulation):string{return checksum(simulation.capture());}
export function replayCheckpoint(simulation:Simulation|LiveSimulation):ReplayCheckpoint{return {tick:simulation.state.tick,ordinal:simulation.state.eventOrdinal,checksum:simulationChecksum(simulation)};}
export function createReplayRecording(initial:SaveEnvelope,events:ReplayRecording['events'],checkpoints:ReplayCheckpoint[],endTick:number,endOrdinal:number):ReplayRecording {
  const body={formatVersion:1 as const,initial:structuredClone(initial),events:structuredClone(events),checkpoints:structuredClone(checkpoints),endTick,endOrdinal};return {...body,checksum:checksum(body)};
}
export function exportReplay(simulation:Simulation|LiveSimulation,identity:EngineIdentity,checkpoints:ReplayCheckpoint[]=[]):ReplayRecording {
  const initial=sealSimulationCapture(simulation.initialCapture(),identity),events=simulation.journalEvents();
  if(events.length!==simulation.state.eventOrdinal-initial.payload.state.eventOrdinal)throw new Error('REPLAY_JOURNAL_INCOMPLETE');
  return createReplayRecording(initial,events,checkpoints,simulation.state.tick,simulation.state.eventOrdinal);
}

/** Host-only playback; each request advances a bounded number of simulation ticks. */
export class ReplayRunner {
  simulation:Simulation;
  private recording:ReplayRecording;
  private cursor=0;
  private checked=new Set<number>();
  private frameCadences:{tick:number;quanta:number}[]=[];
  constructor(input:unknown,private readonly identity:EngineIdentity){
    if(!record(input)||!exactKeys(input,['formatVersion','initial','events','checkpoints','endTick','endOrdinal','checksum'])||input.formatVersion!==1||!Array.isArray(input.events)||!Array.isArray(input.checkpoints)||!Number.isSafeInteger(input.endTick)||!Number.isSafeInteger(input.endOrdinal))throw new Error('INVALID_REPLAY');
    const {checksum:expected,...body}=input;if(!fingerprint(expected)||checksum(body)!==expected)throw new Error('REPLAY_CHECKSUM_MISMATCH');
    const start=validateSave(input.initial,identity);let ordinal=start.state.eventOrdinal,tick=start.state.tick,tier=start.state.movementCadenceTier;
    if((input.endTick as number)<tick||(input.endOrdinal as number)<ordinal||input.events.length>2000000)throw new Error('INVALID_REPLAY');
    const coarse=start.options.authoritativeIntervalMs===300;
    this.frameCadences.push({tick,quanta:coarse?COARSE_MOVEMENT_DECISION_TICKS[tier]:1});
    for(const event of input.events){if(!validateJournalEvent(event)||event.ordinal!==++ordinal||event.tick<tick||event.tick>(input.endTick as number))throw new Error('INVALID_REPLAY_EVENT');if(event.kind==='movement_cadence'){if(event.tier===tier)throw new Error('INVALID_REPLAY_EVENT');tier=event.tier;if(coarse)this.frameCadences.push({tick:event.tick,quanta:COARSE_MOVEMENT_DECISION_TICKS[tier]});}tick=event.tick;}
    if(ordinal!==input.endOrdinal)throw new Error('REPLAY_JOURNAL_INCOMPLETE');
    for(const checkpoint of input.checkpoints)if(!record(checkpoint)||!exactKeys(checkpoint,['tick','ordinal','checksum'])||!Number.isSafeInteger(checkpoint.tick)||!Number.isSafeInteger(checkpoint.ordinal)||!fingerprint(checkpoint.checksum)||(checkpoint.tick as number)<start.state.tick||(checkpoint.tick as number)>(input.endTick as number)||(checkpoint.ordinal as number)<start.state.eventOrdinal||(checkpoint.ordinal as number)>ordinal)throw new Error('INVALID_REPLAY_CHECKPOINT');
    this.recording=structuredClone(input) as unknown as ReplayRecording;this.simulation=this.reset();
  }
  private reset():Simulation {
    this.cursor=0;this.checked.clear();const simulation=restoreSimulation(this.recording.initial,this.identity,{preserveEpoch:true});
    simulation.enableReplay(()=>{let count=0;while(this.recording.events[this.cursor]?.tick===simulation.state.tick&&this.recording.events[this.cursor]?.phase==='controllers'){if(++count>4096)throw new Error('REPLAY_PHASE_LIMIT');simulation.applyJournalEvent(this.recording.events[this.cursor++]!);}});return simulation;
  }
  private verify():void {
    for(const [index,checkpoint]of this.recording.checkpoints.entries())if(!this.checked.has(index)&&checkpoint.tick===this.simulation.state.tick&&checkpoint.ordinal===this.simulation.state.eventOrdinal){if(simulationChecksum(this.simulation)!==checkpoint.checksum)throw new Error(`REPLAY_STATE_DIVERGENCE:${checkpoint.tick}:${checkpoint.ordinal}`);this.checked.add(index);}
  }
  advanceTo(targetTick:number,maxTicks=2000):{tick:number;done:boolean;ordinal:number} {
    const start=this.recording.initial.payload.state.tick;if(!Number.isSafeInteger(targetTick)||targetTick<start||targetTick>this.recording.endTick||!Number.isSafeInteger(maxTicks)||maxTicks<1||maxTicks>2000)throw new Error('INVALID_REPLAY_TARGET');
    // A coarse recording publishes committed frames, not its internal contact
    // slices. Seek to the latest complete frame at or before the request. The
    // terminal frame may end early when victory occurs and remains seekable.
    let cadence=this.frameCadences[0]!;for(const next of this.frameCadences){if(next.tick>targetTick)break;cadence=next;}
    if(cadence.quanta>1&&targetTick!==this.recording.endTick)targetTick=cadence.tick+Math.floor((targetTick-cadence.tick)/cadence.quanta)*cadence.quanta;
    if(targetTick<this.simulation.state.tick)this.simulation=this.reset();
    let ticks=0,events=0;
    for(;;){
      this.verify();
      while(this.recording.events[this.cursor]?.tick===this.simulation.state.tick&&this.recording.events[this.cursor]?.phase==='boundary'){
        if(++events>10000)return {tick:this.simulation.state.tick,ordinal:this.simulation.state.eventOrdinal,done:false};this.simulation.applyJournalEvent(this.recording.events[this.cursor++]!);this.verify();
      }
      if(this.simulation.state.tick>=targetTick){const done=targetTick!==this.recording.endTick||this.cursor===this.recording.events.length;if(done&&targetTick===this.recording.endTick&&this.checked.size!==this.recording.checkpoints.length)throw new Error('REPLAY_CHECKPOINT_NOT_REACHED');return {tick:this.simulation.state.tick,ordinal:this.simulation.state.eventOrdinal,done};}
      // Boundary events can change the following frame's span. Budget the
      // actual 50 ms quanta after applying them, rather than a fixed six ticks.
      const frameSpan=Math.min(this.simulation.authoritativeFrameIntervalMs/50,targetTick-this.simulation.state.tick);
      if(ticks+frameSpan>maxTicks){if(ticks===0)throw new Error('REPLAY_BUDGET_BELOW_FRAME');return {tick:this.simulation.state.tick,ordinal:this.simulation.state.eventOrdinal,done:false};}
      const beforeTick=this.simulation.state.tick;
      if(this.simulation.state.status!=='RUNNING')throw new Error('REPLAY_CANNOT_ADVANCE');if(this.simulation.options.authoritativeIntervalMs===300)this.simulation.advanceFrame();else this.simulation.step();
      ticks+=this.simulation.state.tick-beforeTick;
      const next=this.recording.events[this.cursor];if(next&&next.tick<this.simulation.state.tick)throw new Error('REPLAY_EVENT_NOT_REACHED');
    }
  }
}
