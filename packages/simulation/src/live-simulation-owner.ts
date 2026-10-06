import type { Simulation } from './index.js';
import { measurePathCoordinator, type PathPlanningExecutor } from './parallel-path-scheduler.js';
import { isImmutableVisionGroup,retainTransferredVisionChanges,type VisionMaskFrame,type VisionMaskResult } from './vision-mask-kernel.js';
import { claimNativeSerializedPathCheckpoint, discardNativeSerializedPathCheckpoint } from './checkpoint-native.js';

/** This adapter does not confer ownership. Only the simulation factory that
 * creates an inaccessible instance may enable private dirty-record shortcuts. */
const methods=[
  'setPresentationSpeed','setMovementCadenceTier','movementDecisionDiagnostics','urgentPublicationRecipients','step','stepAsync','advanceFrame','advanceFrameAsync','frameDiagnostics','setPlanningServiceLeases','attachPlanningExecutor','attachVisionExecutor','synchronizeCapture',
  'setStatus','invalidateEpoch','endAsDraw','adminSurrender','configureAssistant','assistantState',
  'releaseAssistantEntities','setAiModel','invalidateAiRequests','aiSchedulingState','prepareAiRequest',
  'completeAiRequest','acceptAiChat','drainAiMessages','serializeState','capture','postNativeCapture','initialCapture',
  'pathDiagnostics','hostWorldDiagnostics','planningQueueDiagnostics','planningDiagnostics','stalledPlanningCandidates','recoverStalledPlanning','committedUnitActions','committedFrameActions',
  'journalEvents','drainJournal','setControlMode','resetPublication','publicationProjections',
  'publicationTransfers','view','views','drainNativeCommands','command',
] as const satisfies readonly (keyof Simulation)[];
type LiveMethod=typeof methods[number];
/** Runtime read-only views retain the established host diagnostic input types.
 * Mutations at any depth throw; callers must use an explicit command method. */
export type LiveSimulation=Readonly<Pick<Simulation,LiveMethod|'state'|'options'|'authoritativeFrameIntervalMs'>>;

const sources=new WeakMap<object,object>();
const blocked=new Set<PropertyKey>(['constructor','prototype','__proto__']);
const arrayMethods=new Map<PropertyKey,Function>(Reflect.ownKeys(Array.prototype).flatMap<[PropertyKey,Function]>(key=>{
  const value=Object.getOwnPropertyDescriptor(Array.prototype,key)?.value;
  return typeof value==='function'&&!blocked.has(key)?[[key,value]]:[];
}));
const objectMethods=new Map<PropertyKey,Function>(['hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','toString','valueOf'].map(key=>[key,Object.getOwnPropertyDescriptor(Object.prototype,key)!.value]));
const readonly=():never=>{throw new TypeError('LIVE_SIMULATION_READ_ONLY');};

/** Detach aggregates containing lazy host read views before native IPC. It does
 * not expose an unwrap capability; even a root read view becomes a deep copy. */
export function detachLiveSimulationRead<T>(value:T):T {
  const copies=new WeakMap<object,unknown>();
  const copy=(input:unknown):unknown=>{
    if(!input||typeof input!=='object')return typeof input==='function'?structuredClone(input):input;
    const source=sources.get(input)??input,prior=copies.get(source);if(prior!==undefined)return prior;
    if(sources.has(input)){const result=structuredClone(source);copies.set(source,result);return result;}
    if(!Array.isArray(source)&&Object.getPrototypeOf(source)!==Object.prototype&&Object.getPrototypeOf(source)!==null){const result=structuredClone(source);copies.set(source,result);return result;}
    const result:Record<PropertyKey,unknown>|unknown[]=Array.isArray(source)?new Array(source.length):{};copies.set(source,result);
    for(const key of Object.keys(source))Object.defineProperty(result,key,{value:copy(Reflect.get(source,key)),enumerable:true,configurable:true,writable:true});
    return result;
  };
  return copy(value) as T;
}

function readMembrane(){
  const views=new WeakMap<object,object>();
  const wrap=(value:unknown):unknown=>{
    if(typeof value==='function')return undefined;
    if(value===null||typeof value!=='object')return value;
    const prior=views.get(value);if(prior)return prior;
    const array=Array.isArray(value);
    if(!array&&Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new TypeError('INVALID_LIVE_SIMULATION_DATA');
    // A distinct extensible target avoids the invariant that would otherwise
    // expose unwrapped values of frozen/nonconfigurable source properties.
    const target=array?[]:Object.create(null),calls=new Map<PropertyKey,Function>();
    const view:object=new Proxy(target,{
      get(_target,key){
        if(blocked.has(key))return undefined;
        if(Object.hasOwn(value,key))return wrap(Reflect.get(value,key));
        const method=array?arrayMethods.get(key)??objectMethods.get(key):objectMethods.get(key);
        if(!method)return undefined;
        let call=calls.get(key);if(!call){call=(...args:unknown[])=>Reflect.apply(method,view,args);calls.set(key,call);}return call;
      },
      has(_target,key){return !blocked.has(key)&&(Object.hasOwn(value,key)||(array?arrayMethods.has(key):false)||objectMethods.has(key));},
      ownKeys(){return Reflect.ownKeys(value).filter(key=>!blocked.has(key));},
      getOwnPropertyDescriptor(_target,key){
        if(blocked.has(key))return undefined;
        const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor)return undefined;
        // Array targets always have a nonconfigurable length. It remains
        // writable in this descriptor only to satisfy Proxy invariants; every
        // mutation operation is denied by the traps below.
        return {value:wrap(Reflect.get(value,key)),enumerable:descriptor.enumerable,configurable:!(array&&key==='length'),writable:array&&key==='length'};
      },
      getPrototypeOf(){return null;},
      set:readonly,defineProperty:readonly,deleteProperty:readonly,setPrototypeOf:readonly,preventExtensions:readonly,
    });
    views.set(value,view);sources.set(view,value);return view;
  };
  return wrap;
}

/** Callbacks receive detached frames/replies, never coordinator-owned records.
 * This preserves the compute interface while keeping arbitrary attachments from
 * retaining an alias that could mutate the authoritative simulation later. */
function detachPlanningExecutor(executor:PathPlanningExecutor,guard:()=>void):PathPlanningExecutor {
  const initialize=executor.initialize.bind(executor),advance=executor.advance.bind(executor),advanceService=executor.advanceService?.bind(executor),stopService=executor.stopServiceAfterCurrent?.bind(executor),advanceAndCapture=executor.advanceAndCapture?.bind(executor),capture=executor.capture.bind(executor),dispose=executor.dispose.bind(executor),diagnostics=executor.diagnostics?.bind(executor);
  const captureNative=executor.captureNativeCheckpoint?.bind(executor),advanceNative=executor.advanceAndCaptureNative?.bind(executor);
  const invoke=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    guard();let result:T;
    try{result=await operation();}catch(error){measurePathCoordinator(executor,guard);throw error;}
    return measurePathCoordinator(executor,()=>{try{return structuredClone(result);}finally{guard();}});
  };
  return Object.freeze({
    initialize:(...args:Parameters<PathPlanningExecutor['initialize']>)=>invoke(()=>initialize(...structuredClone(args))),
    advance:(batch:Parameters<PathPlanningExecutor['advance']>[0])=>invoke(()=>advance(structuredClone(batch))),
    ...(advanceService?{advanceService:(...args:Parameters<NonNullable<PathPlanningExecutor['advanceService']>>)=>invoke(()=>advanceService(...structuredClone(args)))}:{}),
    ...(stopService?{stopServiceAfterCurrent:()=>{guard();try{stopService();}finally{guard();}}}:{}),
    ...(advanceAndCapture?{advanceAndCapture:(batch:Parameters<PathPlanningExecutor['advance']>[0])=>invoke(()=>advanceAndCapture(structuredClone(batch)))}:{}),
    capture:()=>invoke(capture),dispose:()=>invoke(dispose),
    ...(captureNative?{captureNativeCheckpoint:async()=>{
      guard();let source;try{source=await captureNative();}catch(error){measurePathCoordinator(executor,guard);throw error;}return measurePathCoordinator(executor,()=>{const handle=claimNativeSerializedPathCheckpoint(source);try{guard();return handle;}catch(error){discardNativeSerializedPathCheckpoint(handle);throw error;}});
    }}:{}),
    ...(advanceNative?{advanceAndCaptureNative:async(batch:Parameters<PathPlanningExecutor['advance']>[0])=>{
      guard();let source;try{source=await advanceNative(structuredClone(batch));}catch(error){measurePathCoordinator(executor,guard);throw error;}return measurePathCoordinator(executor,()=>{const checkpoint=claimNativeSerializedPathCheckpoint(source.checkpoint);try{const reply=structuredClone(source.reply);guard();return {reply,checkpoint};}catch(error){discardNativeSerializedPathCheckpoint(checkpoint);throw error;}});
    }}:{}),
    ...(executor.observeCoordinatorWork?{observeCoordinatorWork:executor.observeCoordinatorWork.bind(executor)}:{}),
    ...(diagnostics?{diagnostics:()=>{guard();try{return structuredClone(diagnostics());}finally{guard();}}}:{}),
  });
}

/** Frozen allowlisted interface: no raw instance, private fields, diagnostic
 * installers, replay callbacks, random generator or mutable state aliases. */
export function createLiveSimulationFacade(simulation:Simulation,guard:()=>void=()=>undefined,captureIsDetached:()=>boolean=()=>false):LiveSimulation {
  const wrap=readMembrane(),facade=Object.create(null) as Record<string,unknown>;
  Object.defineProperties(facade,{
    // Reading the membrane neither invokes an optimized simulation reader nor
    // mutates authority. Method/callback boundaries perform ownership checks.
    state:{enumerable:true,get:()=>wrap(simulation.state)},options:{enumerable:true,get:()=>wrap(simulation.options)},
    authoritativeFrameIntervalMs:{enumerable:true,get:()=>simulation.authoritativeFrameIntervalMs},
  });
  for(const name of methods){
    const method=simulation[name] as (...args:unknown[])=>unknown;
    facade[name]=(...input:unknown[])=>{
      guard();
      let args:unknown[];
      if(name==='drainNativeCommands')args=input;
      else if(name==='postNativeCapture')args=[input[0],structuredClone(input[1])];
      else if(name==='attachPlanningExecutor')args=[detachPlanningExecutor(input[0] as PathPlanningExecutor,guard)];
      else if(name==='attachVisionExecutor'){
        const execute=input[0] as Parameters<Simulation['attachVisionExecutor']>[0];
        let retained=new Map<string,VisionMaskResult>();
        let geometry:{source:VisionMaskFrame['blockers'];key:string;blockers:VisionMaskFrame['blockers']}|undefined;
        const sealFrame=(frame:VisionMaskFrame):VisionMaskFrame=>{
          // Private sources are already independent, deeply frozen snapshots.
          // Preserve their identity for exact delta encoding; never lend world
          // records or the simulation's mutable terrain array to a callback.
          if(!Array.isArray(frame.groups)||!frame.groups.every(isImmutableVisionGroup))return structuredClone(frame);
          const key=JSON.stringify([frame.cacheKey,frame.blockerRevision,frame.width,frame.height,frame.gridMm]);
          if(!geometry||geometry.source!==frame.blockers||geometry.key!==key)geometry={source:frame.blockers,key,blockers:Object.freeze(frame.blockers.map(blocker=>Object.freeze({...blocker})))};
          return {...frame,blockers:geometry.blockers,groups:Object.freeze([...frame.groups])};
        };
        const owned:typeof execute=async(frame,binding)=>{
          guard();
          try{
            const results=structuredClone(await execute(sealFrame(frame),structuredClone(binding))),next=new Map<string,VisionMaskResult>();
            // Callback identity cannot prove immutable results. Compare current
            // detached bytes/cells with our private prior value, retaining exact
            // mask identity so unchanged vision does not dirty every recipient.
            if(!Array.isArray(results)||results.length>11){retained.clear();return results;}
            const same=(a:ArrayLike<number>,b:ArrayLike<number>)=>{if(a.length!==b.length)return false;for(let index=0;index<a.length;index++)if(!Object.is(a[index],b[index]))return false;return true;};
            const values=results.map(value=>{
              if(!value||typeof value.key!=='string'||!(value.mask instanceof Uint8Array)||!Array.isArray(value.visible)||Object.keys(value).length!==3)return value;
              if(value.mask.buffer instanceof SharedArrayBuffer)value.mask=new Uint8Array(value.mask);
              const previous=retained.get(value.key),result=previous&&same(previous.mask,value.mask)&&same(previous.visible,value.visible)?previous:value;
              if(previous&&result!==previous)retainTransferredVisionChanges(previous.mask,result.mask);
              next.set(value.key,result);return result;
            });retained=next;return values;
          }finally{guard();}
        };
        args=[owned];
      }else args=detachLiveSimulationRead(input);
      // Input accessors may run while detaching an unsupported caller fixture.
      // Recheck after that boundary before entering authoritative methods.
      if(name!=='drainNativeCommands'&&input.some(value=>value!==null&&(typeof value==='object'||typeof value==='function')))guard();
      const result=Reflect.apply(method,simulation,args);
      // Native projection handles intentionally keep their one-use opaque
      // identity. Every ordinary result is detached even for custom fixtures.
      if(name==='publicationTransfers')return result;
      // The certified factory's capture methods already deep-copy all world,
      // navigation and runtime records. Hand that detached value to the caller
      // once rather than walking/copying it all again before postMessage.
      // Custom/escaped instances still require the conservative copy below.
      if(name==='capture'||name==='initialCapture'){guard();if(captureIsDetached())return result;}
      return result instanceof Promise?result.then(value=>{guard();return detachLiveSimulationRead(value);},error=>{guard();throw error;}):detachLiveSimulationRead(result);
    };
  }
  return Object.freeze(facade) as unknown as LiveSimulation;
}
