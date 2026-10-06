import { MessagePort } from 'node:worker_threads';
import { types as nodeTypes } from 'node:util';
import { deserialize } from 'node:v8';
import type { PathSchedulerState } from './path-scheduler.js';
import type { SimulationSavePayload } from './persistence-types.js';

declare const pathBrand: unique symbol;
declare const captureBrand: unique symbol;
declare const serializedBrand: unique symbol;
export interface NativePathCheckpoint { readonly [pathBrand]: true }
export interface NativeCheckpoint { readonly [captureBrand]: true }
export interface NativeSerializedPathCheckpoint { readonly [serializedBrand]: true }
export interface SerializedPathCheckpoint {format:'path-state-v8-v1';data:ArrayBuffer;byteLength:number}
const MAX_PATH_CHECKPOINT_BYTES=256*1024*1024;
const ownedSerialized=new WeakMap<NativeSerializedPathCheckpoint,ArrayBuffer>();
const arrayBufferLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength')!.get!;
const arrayBufferResizable=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'resizable')?.get;
const nativeClone=globalThis.structuredClone;
function checkedSerializedBytes(input:unknown):ArrayBuffer {
  try {
    if(!input||typeof input!=='object'||nodeTypes.isProxy(input)||Object.keys(input).sort().join(',')!=='byteLength,data,format')throw new Error();
    const field=(key:string)=>{const descriptor=Object.getOwnPropertyDescriptor(input,key);if(!descriptor||!('value'in descriptor))throw new Error();return descriptor.value;};
    const data=field('data'),length=arrayBufferLength.call(data),expected=field('byteLength');
    if(field('format')!=='path-state-v8-v1'||!Number.isSafeInteger(expected)||expected<1||expected>MAX_PATH_CHECKPOINT_BYTES||length!==expected||arrayBufferResizable?.call(data))throw new Error();
    return data as ArrayBuffer;
  }catch{throw new Error('INVALID_PATH_CAPTURE_ENCODING');}
}
export function deserializePathCheckpoint(input:unknown):PathSchedulerState {
  try{const state=deserialize(new Uint8Array(checkedSerializedBytes(input))) as PathSchedulerState;
    if(!state||state.version!==1||!Array.isArray(state.tasks)||!Array.isArray(state.regions)||!Array.isArray(state.routes)||!state.revisions||typeof state.revisions!=='object')throw new Error();return state;
  }catch{throw new Error('INVALID_PATH_CAPTURE_ENCODING');}
}
/** Takes actual transferable ownership. No producer alias or buffer accessor survives. */
export function captureNativeSerializedPathCheckpoint(input:unknown):NativeSerializedPathCheckpoint {
  const data=checkedSerializedBytes(input),owned=nativeClone(data,{transfer:[data]}),handle=Object.freeze(Object.create(null)) as NativeSerializedPathCheckpoint;
  ownedSerialized.set(handle,owned);return handle;
}
export function claimNativeSerializedPathCheckpoint(handle:NativeSerializedPathCheckpoint):NativeSerializedPathCheckpoint {
  const data=ownedSerialized.get(handle);if(!data)throw new Error('INVALID_NATIVE_CHECKPOINT');
  const claimed=Object.freeze(Object.create(null)) as NativeSerializedPathCheckpoint;ownedSerialized.delete(handle);ownedSerialized.set(claimed,data);return claimed;
}
export function discardNativeSerializedPathCheckpoint(handle:NativeSerializedPathCheckpoint):void {ownedSerialized.delete(handle);}
/** Public capture/export obtains a fresh graph; it never borrows retained bytes. */
export function decodeNativeSerializedPathCheckpoint(handle:NativeSerializedPathCheckpoint):PathSchedulerState {
  const data=ownedSerialized.get(handle);if(!data)throw new Error('INVALID_NATIVE_CHECKPOINT');return deserializePathCheckpoint({format:'path-state-v8-v1',data,byteLength:arrayBufferLength.call(data)});
}
export type NativeCheckpointEnvelope = { type: 'checkpoint'; autosave: boolean } | { type: 'reply'; id: number };
export type NativeCheckpointBody = Omit<SimulationSavePayload, 'runtime'> & { runtime: Omit<SimulationSavePayload['runtime'], 'pathScheduler'> };
interface Scope { current?: object; closed: boolean }
type CheckpointBinding={matchId:string;matchEpoch:number;tick:number;eventOrdinal:number;authoritativeIntervalMs:number;localPlanningMode:string|null};
const binding=(body:NativeCheckpointBody):CheckpointBinding=>({matchId:body.state.matchId,matchEpoch:body.state.matchEpoch,tick:body.state.tick,eventOrdinal:body.state.eventOrdinal,authoritativeIntervalMs:body.options.authoritativeIntervalMs??50,localPlanningMode:body.options.localPlanningMode??null});
const sameBinding=(a:CheckpointBinding,b:CheckpointBinding)=>a.matchId===b.matchId&&a.matchEpoch===b.matchEpoch&&a.tick===b.tick&&a.eventOrdinal===b.eventOrdinal&&a.authoritativeIntervalMs===b.authoritativeIntervalMs&&a.localPlanningMode===b.localPlanningMode;
const paths = new WeakMap<NativePathCheckpoint, { scope: Scope; state: PathSchedulerState }|{scope:Scope;serialized:NativeSerializedPathCheckpoint}>();
const captures = new WeakMap<NativeCheckpoint, { scope: Scope; body: NativeCheckpointBody; path: NativePathCheckpoint;binding:CheckpointBinding }>();
const nativeHasRef = Function.prototype.call.bind(MessagePort.prototype.hasRef) as (port: MessagePort) => boolean;
const nativePost = Function.prototype.call.bind(MessagePort.prototype.postMessage) as (port: MessagePort, value: unknown,transfer?:ArrayBuffer[]) => void;
const invalid = (): never => { throw new Error('INVALID_NATIVE_CHECKPOINT'); };

export function isNativeCheckpointPort(value: unknown): value is MessagePort {
  try { nativeHasRef(value as MessagePort); return true; } catch { return false; }
}
export function discardNativePathCheckpoint(handle: NativePathCheckpoint): void {
  const entry = paths.get(handle); paths.delete(handle);
  if (entry?.scope.current === handle) entry.scope.current = undefined;
}
export function discardNativeCheckpoint(handle: NativeCheckpoint): void {
  const entry = captures.get(handle); captures.delete(handle);
  if (entry) { if (entry.scope.current === handle) entry.scope.current = undefined; discardNativePathCheckpoint(entry.path); }
}
/** Private checkpoint owner. This never exposes its retained graph or invokes a
 * caller callback. Mutation/capture replacement invalidates the prior handle. */
export function createNativePathCheckpointScope() {
  const scope: Scope = { closed: false };
  const invalidate = () => { if (scope.current) discardNativePathCheckpoint(scope.current as NativePathCheckpoint); };
  return Object.freeze({ invalidate, close() { invalidate(); scope.closed = true; }, prepare(state: PathSchedulerState): NativePathCheckpoint {
    if (scope.closed) return invalid(); invalidate();
    const handle = Object.freeze(Object.create(null)) as NativePathCheckpoint;
    paths.set(handle, { scope, state }); scope.current = handle; return handle;
  },prepareSerialized(serialized:NativeSerializedPathCheckpoint):NativePathCheckpoint{
    if(scope.closed||!ownedSerialized.has(serialized))return invalid();invalidate();const handle=Object.freeze(Object.create(null)) as NativePathCheckpoint;
    paths.set(handle,{scope,serialized});scope.current=handle;return handle;
  } });
}
/** Used only during a synchronous native capture method. Borrowed world records
 * must never survive an await or a simulation mutation. The only graph reader
 * is the captured MessagePort intrinsic, which detaches the receiving snapshot. */
export function createNativeCheckpointScope() {
  const scope: Scope = { closed: false };
  const invalidate = () => { if (scope.current) discardNativeCheckpoint(scope.current as NativeCheckpoint); };
  return Object.freeze({ invalidate, close() { invalidate(); scope.closed = true; }, prepare(body: NativeCheckpointBody, path: NativePathCheckpoint): NativeCheckpoint {
    if (scope.closed || !paths.has(path)) return invalid(); invalidate();
    const handle = Object.freeze(Object.create(null)) as NativeCheckpoint;
    captures.set(handle, { scope, body, path,binding:binding(body) }); scope.current = handle; return handle;
  } });
}
/** No raw accessor, arbitrary serializer or caller postMessage is consulted.
 * Consume before posting, including native clone/send failures. Ordinary public
 * capture/export APIs retain their independent mutable-snapshot contract. */
export function postNativeCheckpoint(handle: NativeCheckpoint, port: MessagePort, envelope: NativeCheckpointEnvelope): void {
  const entry = captures.get(handle), path = entry && paths.get(entry.path);
  if (!entry || !path || entry.scope.closed || path.scope.closed || entry.scope.current !== handle || path.scope.current !== entry.path) return invalid();
  if (!isNativeCheckpointPort(port)) throw new Error('INVALID_NATIVE_CHECKPOINT_PORT');
  if (!envelope || typeof envelope !== 'object' || nodeTypes.isProxy(envelope)) throw new Error('INVALID_NATIVE_CHECKPOINT_ENVELOPE');
  // Callers detach/validate the small envelope before entering the owner. Read
  // only own data descriptors here so even direct helper calls cannot reenter.
  const type = Object.getOwnPropertyDescriptor(envelope, 'type'), value = Object.getOwnPropertyDescriptor(envelope, type?.value === 'reply' ? 'id' : 'autosave');
  if (!type || !('value' in type) || !value || !('value' in value) ||
      (type.value === 'reply' ? !Number.isSafeInteger(value.value) || value.value < 0 : type.value !== 'checkpoint' || typeof value.value !== 'boolean')) throw new Error('INVALID_NATIVE_CHECKPOINT_ENVELOPE');
  const body = entry.body, runtime = body.runtime;
  if(!sameBinding(entry.binding,binding(body)))return invalid();
  if('serialized'in path){
    const retained=ownedSerialized.get(path.serialized);if(!retained)return invalid();
    discardNativeCheckpoint(handle);
    // One bounded byte copy keeps repeat captures valid. Only the copy transfers;
    // no path graph is decoded or recursively copied on the simulation thread.
    const data=nativeClone(retained),serialized:SerializedPathCheckpoint={format:'path-state-v8-v1',data,byteLength:arrayBufferLength.call(data)};
    nativePost(port,{type:'native-checkpoint',envelope:type.value==='reply'?{type:'reply',id:value.value}:{type:'checkpoint',autosave:value.value},binding:entry.binding,body,serialized},[data]);return;
  }
  // Preserve the public capture's exact insertion order for checksum/replay.
  const payload: SimulationSavePayload = { schemaVersion: body.schemaVersion, contentHash: body.contentHash, options: body.options, state: body.state,
    runtime: { profileIds: runtime.profileIds, planningProfiles: runtime.planningProfiles, pathScheduler: path.state, approachReservations: runtime.approachReservations, localAvoidance: runtime.localAvoidance } };
  discardNativeCheckpoint(handle);
  nativePost(port, type.value === 'reply' ? { id: value.value, value: payload, error: undefined } : { type: 'checkpoint', payload, autosave: value.value });
}

/** Receiver-only codec over an actual worker structured-clone message. Produces
 * the unchanged public capture shape before any save/replay/RPC callback. */
export function hydrateNativeCheckpointMessage(message:{type?:string;[key:string]:unknown}):unknown {
  if(message.type!=='native-checkpoint')return message;
  const body=message.body as NativeCheckpointBody,expected=message.binding as CheckpointBinding,envelope=message.envelope as NativeCheckpointEnvelope;
  if(!body?.state||!body.options||!body.runtime||!expected||!sameBinding(expected,binding(body)))throw new Error('INVALID_NATIVE_CHECKPOINT');
  if(!envelope||(envelope.type==='reply'?!Number.isSafeInteger(envelope.id)||envelope.id<0:envelope.type!=='checkpoint'||typeof envelope.autosave!=='boolean'))throw new Error('INVALID_NATIVE_CHECKPOINT_ENVELOPE');
  const pathScheduler=deserializePathCheckpoint(message.serialized),runtime=body.runtime;
  const payload:SimulationSavePayload={schemaVersion:body.schemaVersion,contentHash:body.contentHash,options:body.options,state:body.state,runtime:{profileIds:runtime.profileIds,planningProfiles:runtime.planningProfiles,pathScheduler,approachReservations:runtime.approachReservations,localAvoidance:runtime.localAvoidance}};
  return envelope.type==='reply'?{id:envelope.id,value:payload,error:undefined}:{type:'checkpoint',payload,autosave:envelope.autosave};
}
