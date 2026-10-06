import type { VisionMaskFrame, VisionMaskGroup, VisionMaskResult, VisionMaskSource } from '../../../packages/simulation/src/vision-mask-kernel.js';

export interface VisionPhaseBinding {matchId:string;matchEpoch:number;tick:number;phase:string}
/** Diagnostic-only stamps share process.hrtime's host-monotonic clock across threads.
 * Receipt follows deserialization. Result post marks the start of postMessage, so
 * the remaining interval includes serialization/transfer and coordinator delay. */
export interface VisionWorkerTiming {
  workerReceivedAtMs:number;
  workerComputeStartedAtMs?:number;
  workerComputeEndedAtMs?:number;
  workerResultPostStartedAtMs?:number;
  kernelWork?:{rasterizedSources:number;coveredSources:number;witnessChecks:number};
}
export interface VisionWorkerRequest {
  type:'vision';generation:number;batch:number;binding:VisionPhaseBinding;
  frame:Omit<VisionMaskFrame,'blockers'|'groups'>;
  exchangeKey:string;
  sources:VisionSourceExchange;
  geometry?:VisionMaskFrame['blockers'];
  diagnosticTiming?:true;
}
export interface VisionWorkerResponse {
  type:'vision-result';generation:number;batch:number;binding:VisionPhaseBinding;
  exchangeKey:string;sourceBaseRevision:number;sourceRevision:number;
  results?:VisionResultExchange[];error?:string;
  diagnosticTiming?:VisionWorkerTiming;
}
export interface VisionGroupDelta {key:string;upserts:VisionMaskSource[];removed:string[];order?:string[]}
export type VisionSourceExchange =
  | {mode:'full';baseRevision:0;revision:1;groups:readonly VisionMaskGroup[]}
  | {mode:'delta';baseRevision:number;revision:number;groups:VisionGroupDelta[];removed:string[];order?:string[]};
/** Absence of result acknowledges exactly the already-owned immutable revision. */
export interface VisionResultExchange {
  key:string;baseRevision:number;revision:number;result?:Pick<VisionMaskResult,'mask'|'visible'>;
}
export const visionGeometryKey=(frame:Pick<VisionMaskFrame,'cacheKey'|'blockerRevision'|'width'|'height'|'gridMm'>):string=>
  JSON.stringify([frame.cacheKey,frame.blockerRevision,frame.width,frame.height,frame.gridMm]);
export const visionExchangeKey=(frame:Pick<VisionMaskFrame,'cacheKey'|'blockerRevision'|'width'|'height'|'gridMm'>,binding:VisionPhaseBinding):string=>
  JSON.stringify([binding.matchId,binding.matchEpoch,visionGeometryKey(frame)]);
export function sameVisionBinding(left:VisionPhaseBinding,right:VisionPhaseBinding):boolean {
  return left.matchId===right.matchId&&left.matchEpoch===right.matchEpoch&&left.tick===right.tick&&left.phase===right.phase;
}
