import type { Position, TerrainRectangle } from '@frontier/shared';
import { Navigation, navigationConnectors, createEndpointConnectorSearch, advanceEndpointConnectorSearch, endpointConnectorRoutes, connectorRouteLength, CONNECTOR_CELL_MM, CONNECTOR_REACH_CELLS, type EndpointConnectorSearch, type EndpointConnectorRoute, type Obstacle } from './navigation.js';
import { PathPlanningCensus, summarizePathQueue, type PathDiagnosticClock, type PathPlanningDiagnostics, type PathQueueTask } from './path-diagnostics.js';
import { SharedPathJobs, type SharedCoarseFrontier, type SharedCoarseStep, type SharedPathJobsState, type SharedPathMember, type SharedPathService } from './shared-path-jobs.js';
import { cellKey, componentKey, componentCoordinates, componentFromText, componentText, componentRegionText, regionKey, regionFromText, searchKeyOrder, createPathSearch, exportPathSearch, importPathSearch, type SearchKey, type PathSearch, type SavedPathSearch } from './path-search-keys.js';
import { MessagePort } from 'node:worker_threads';
export type { PathDiagnosticClock, PathPlanningDiagnostics } from './path-diagnostics.js';
export interface PathCheckpointEnvelope {id:number;generation:number;threadId:number;startedAtMs?:number}
declare const preparedCheckpointBrand:unique symbol;
export interface PreparedPathCheckpointMessage {readonly [preparedCheckpointBrand]:true}
const checkpointPost=Function.prototype.call.bind(MessagePort.prototype.postMessage) as (port:MessagePort,value:unknown)=>void;
const checkpointHasRef=Function.prototype.call.bind(MessagePort.prototype.hasRef) as (port:MessagePort)=>boolean;
const checkpointClone=globalThis.structuredClone,checkpointClock=process.hrtime.bigint.bind(process.hrtime);
const nativeCheckpointCounts={posted:0};
const checkpointMessages=new WeakMap<PreparedPathCheckpointMessage,{metadata:PathCheckpointEnvelope;reply?:unknown}>();
/** Detach caller metadata before any authority is assembled. Opaque one-use
 * message scopes avoid cloning the task-mirror reply a second time. */
export function preparePathCheckpointMessage(envelope:PathCheckpointEnvelope,reply?:unknown):PreparedPathCheckpointMessage{
  const metadata=checkpointClone(envelope),detachedReply=reply===undefined?undefined:checkpointClone(reply);
  if(!metadata||![metadata.id,metadata.generation,metadata.threadId].every(value=>Number.isSafeInteger(value)&&value>=0)||metadata.startedAtMs!==undefined&&(!Number.isFinite(metadata.startedAtMs)||metadata.startedAtMs<0))throw new Error('INVALID_PATH_CHECKPOINT_ENVELOPE');
  const handle=Object.freeze(Object.create(null)) as PreparedPathCheckpointMessage;checkpointMessages.set(handle,{metadata,reply:detachedReply});return handle;
}
export function discardPathCheckpointMessage(handle:PreparedPathCheckpointMessage):void{checkpointMessages.delete(handle);}
/** The only state reader is the captured native IPC intrinsic. Consume even if
 * native clone/post fails; no borrowed state is stored in the message scope. */
export function postPathCheckpointMessage(port:MessagePort,handle:PreparedPathCheckpointMessage,state:PathSchedulerState):void{
  const prepared=checkpointMessages.get(handle);checkpointMessages.delete(handle);if(!prepared)throw new Error('INVALID_PATH_CHECKPOINT_MESSAGE');
  try{checkpointHasRef(port);}catch{throw new Error('INVALID_NATIVE_CHECKPOINT_PORT');}
  const {metadata,reply}=prepared;checkpointPost(port,{id:metadata.id,generation:metadata.generation,threadId:metadata.threadId,value:reply===undefined?state:{reply,state},...(metadata.startedAtMs===undefined?{}:{timing:{workerStartedAtMs:metadata.startedAtMs,workerFinishedAtMs:Number(checkpointClock())/1e6}})});
}

export type PathWorkClass='interactive'|'routine'|'optional';
export interface PathRequest {id:string;unitId:string;orderRevision:number;from:Position;target:Position;radiusMm:number;profile:string;workClass?:PathWorkClass;enqueuedTick?:number}
export const PATH_TASK_LIMIT=2200;
/** Long-route shortcut work is charged to existing faction grants. Exhaustion
 * returns to the ordinary planner; it is never a proof of unreachability. */
export const CORNER_ROUTE_MIN_MM=128000,CORNER_OBSTACLE_LIMIT=256,CORNER_POINT_LIMIT=64,CORNER_WORK_LIMIT=16384,CORNER_SWEEP_MM=4000;
export interface CornerPathSearch {
  phase:'collect'|'search';obstacleCursor:number;points:Position[];work:number;
  scores?:(number|null)[];parents?:number[];closed?:boolean[];current?:number;
  edgeCursor?:number;sweepStep?:number;sweepSteps?:number;
}
export interface PathPriorityState {tick:number;profiles:Record<string,{phase:number;interactive:number;routine:number;optional:number}>}
export interface RegionStamp {region:string;revision:number}
export type PathResult = {status:'pending';id:string;orderRevision:number}|{status:'ready';id:string;orderRevision:number;points:Position[];regions:RegionStamp[]}|{status:'blocked';id:string;orderRevision:number};
interface HeapItem {key:SearchKey;score:number}
interface Region {key:string;profile:string;radiusMm:number;x:number;z:number;labels:number[];cursor:number;frontier:number[];frontierCursor:number;label:number;complete:boolean}
interface SavedTask extends PathRequest {
  stage:'direct'|'corner'|'coarse'|'fine'|'done';lineStep:number;lineSteps:number;result?:PathResult;corner?:CornerPathSearch;
  starts?:number[];ends?:number[];prepareEndpoints?:true;startComponents?:string[];endComponents?:string[];
  startBridge?:EndpointConnectorSearch;endBridge?:EndpointConnectorSearch;startRoutes?:EndpointConnectorRoute[];endRoutes?:EndpointConnectorRoute[];
  coarse?:SavedPathSearch;currentComponent?:string;edgeCursor?:number;corridor?:string[];
  fine?:SavedPathSearch;currentCell?:number;neighborCursor?:number;cacheKey?:string;lateCacheChecked?:true;endJoinChecked?:true;
}
interface Task extends Omit<SavedTask,'coarse'|'fine'|'currentComponent'> {coarse?:PathSearch;fine?:PathSearch;currentComponent?:SearchKey}
interface CornerDependencies {sources:Obstacle[];regions:Set<string>;graph?:TerrainRectangle}
function exportTask(task:Task):SavedTask {const saved={...task} as unknown as SavedTask;if(task.coarse)saved.coarse=exportPathSearch(task.coarse,true);if(task.fine)saved.fine=exportPathSearch(task.fine,false);if(task.currentComponent!==undefined)saved.currentComponent=componentText(task.currentComponent);return saved;}
function importTask(saved:SavedTask):Task {const task={...saved} as unknown as Task;if(saved.coarse)task.coarse=importPathSearch(saved.coarse,true);if(saved.fine)task.fine=importPathSearch(saved.fine,false);if(saved.currentComponent!==undefined)task.currentComponent=componentFromText(saved.currentComponent);return task;}
interface Route {profile:string;radiusMm:number;points:Position[];regions:RegionStamp[];corridor:string[]}
type RouteComponentIndex=Map<string,Map<number,Map<SearchKey,Map<SearchKey,Set<string>>>>>;
type RouteEndIndex=Map<string,Map<number,Map<SearchKey,Map<string,readonly SearchKey[]>>>>;
/** Internal snapshots require the same engine; full saves separately bind its hash. */
export interface PathSchedulerState {version:1;tasks:SavedTask[];regions:Region[];revisions:Record<string,number>;routes:[string,Route][];cursor:number;profileCursors?:Record<string,number>;priority?:PathPriorityState;sharedJobs?:{geometryVersions:Record<string,number>;registry:SharedPathJobsState}}
export interface PathWorkReport {work:number;pending:number;ready:number;blocked:number;regionCount:number;cacheHits:number}
export interface PathProfileGrant {profile:string;nodeBudget:number}
/** Read-side state only: search heaps and region frontiers remain in their owner. */
export interface PathTaskMirror {request:PathRequest;result:PathResult;direct:boolean;usedRegions:readonly string[];connectorRegions:string[]}
export function pathProfileGrants(profiles:readonly string[],nodeBudget:number):PathProfileGrant[]{
  if(!Number.isSafeInteger(nodeBudget)||nodeBudget<0)throw new Error('INVALID_PATH_BUDGET');
  const sorted=profiles.length?[...profiles].sort():[''];
  return sorted.map((profile,index)=>({profile,nodeBudget:Math.floor(nodeBudget/sorted.length)+(index<nodeBudget%sorted.length?1:0)}));
}
/** Profile partition is an execution detail, so saved order is canonical across pools. */
export function canonicalPathState(state:PathSchedulerState):PathSchedulerState{
  const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
  state.tasks.sort((a,b)=>compare(a.profile,b.profile));state.regions.sort((a,b)=>compare(a.profile,b.profile));state.routes.sort((a,b)=>compare(a[1].profile,b[1].profile));
  state.revisions=Object.fromEntries(Object.entries(state.revisions).sort(([a],[b])=>compare(a,b)));
  state.profileCursors=Object.fromEntries(Object.entries(state.profileCursors??{}).sort(([a],[b])=>compare(a,b)));
  // Replay hashes serialize object insertion order, including this root object.
  return {version:1,tasks:state.tasks,regions:state.regions,revisions:state.revisions,routes:state.routes,cursor:state.cursor,profileCursors:state.profileCursors,...(state.priority?{priority:{tick:state.priority.tick,profiles:Object.fromEntries(Object.entries(state.priority.profiles).sort(([a],[b])=>compare(a,b)))}}:{}),...(state.sharedJobs?{sharedJobs:{geometryVersions:Object.fromEntries(Object.entries(state.sharedJobs.geometryVersions).sort(([a],[b])=>compare(a,b))),registry:state.sharedJobs.registry}}:{})};
}
const SIDE=16,CELL=1000;
const directions=[[0,-1],[-1,0],[1,0],[0,1]] as const;
const componentRegion=(key:string)=>key.slice(0,key.lastIndexOf(','));
/** Closed segment/expanded-region intersection, not spaced point sampling.
 * Integer millimetre bounds keep the separating-axis products exact on legal
 * maps. Rounding radius upward is conservative for generic fractional bodies. */
function addConnectorRegions(regions:Set<string>,from:Position,to:Position,radiusMm:number,nav:Navigation):void {
  const size=SIDE*CELL,radius=Math.ceil(radiusMm),extent=size+2*radius,dx=to.xMm-from.xMm,dz=to.zMm-from.zMm;
  const left=Math.max(0,Math.ceil((Math.min(from.xMm,to.xMm)-radius)/size)-1),right=Math.min(Math.ceil(nav.widthMm/size)-1,Math.floor((Math.max(from.xMm,to.xMm)+radius)/size));
  const top=Math.max(0,Math.ceil((Math.min(from.zMm,to.zMm)-radius)/size)-1),bottom=Math.min(Math.ceil(nav.heightMm/size)-1,Math.floor((Math.max(from.zMm,to.zMm)+radius)/size));
  for(let z=top;z<=bottom;z++)for(let x=left;x<=right;x++){
    const sx=from.xMm+to.xMm-(2*x+1)*size,sz=from.zMm+to.zMm-(2*z+1)*size;
    if(Math.abs(sx)<=extent+Math.abs(dx)&&Math.abs(sz)<=extent+Math.abs(dz)&&Math.abs(sx*dz-sz*dx)<=extent*(Math.abs(dx)+Math.abs(dz)))regions.add(`${x},${z}`);
  }
}
/** Derived metadata only: generic scheduler profiles may themselves contain colons. */
function routeComponents(key:string,route:Route):[SearchKey[],SearchKey[]]|undefined{
  const prefix=`${route.profile}:${route.radiusMm}:`;if(key.length>4096||!key.startsWith(prefix))return;
  const sections=key.slice(prefix.length).split(':');if(sections.length!==2)return;
  const lists=sections.map(section=>section.split(';'));
  for(const list of lists)if(!list.length||list.length>9||new Set(list).size!==list.length||list.some(component=>{
    if(!/^(0|[1-9][0-9]*),(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/.test(component))return true;
    const values=component.split(',').map(Number);return values.some(value=>!Number.isSafeInteger(value))||values[2]!>=SIDE*SIDE;
  }))return;
  return lists.map(list=>list.map(componentFromText)) as [SearchKey[],SearchKey[]];
}
const estimate=(xMm:number,zMm:number,target:Position):number=>Math.max(0,Math.abs(xMm-target.xMm)/CELL-1)+Math.max(0,Math.abs(zMm-target.zMm)/CELL-1);
const heapOrder=(a:HeapItem,b:HeapItem,target?:Position,width=0):number=>{
  if(a.score!==b.score)return a.score<b.score?-1:1;
  // Fine search crosses equal-f plateaus toward its goal. Only immutable cell
  // coordinates participate; a later decrease in scores[key] cannot reorder
  // entries already in the heap. Coarse search retains its lexical tie break.
  if(target){const ac=Number(a.key),bc=Number(b.key),difference=estimate((ac%width)*CELL,Math.floor(ac/width)*CELL,target)-estimate((bc%width)*CELL,Math.floor(bc/width)*CELL,target);if(difference)return difference<0?-1:1;}
  return searchKeyOrder(a.key,b.key,!target);
};
const heapPush=(heap:HeapItem[],item:HeapItem,target?:Position,width=0)=>{heap.push(item);let index=heap.length-1;while(index){const parent=(index-1)>>1,prior=heap[parent]!;if(heapOrder(prior,item,target,width)<=0)break;heap[index]=prior;index=parent;}heap[index]=item;};
const heapPop=(heap:HeapItem[],target?:Position,width=0):HeapItem|undefined=>{const result=heap[0],tail=heap.pop();if(heap.length&&tail){let index=0;while(index*2+1<heap.length){let child=index*2+1;if(child+1<heap.length&&heapOrder(heap[child+1]!,heap[child]!,target,width)<0)child++;const next=heap[child]!;if(heapOrder(tail,next,target,width)<=0)break;heap[index]=next;index=child;}heap[index]=tail;}return result;};
const search=createPathSearch;
function cornerCandidates(task:Pick<PathRequest,'from'|'target'|'radiusMm'>,points:Position[],obstacle:Obstacle,nav:Navigation):void {
  const margin=Math.ceil(task.radiusMm)+50,distance=(point:Position)=>Math.hypot(point.xMm-task.from.xMm,point.zMm-task.from.zMm)+Math.hypot(point.xMm-task.target.xMm,point.zMm-task.target.zMm);
  for(const dx of [-1,1])for(const dz of [-1,1]){
    const point={xMm:Math.round(obstacle.xMm+dx*(obstacle.halfWidth+margin)),zMm:Math.round(obstacle.zMm+dz*(obstacle.halfHeight+margin))};
    if(point.xMm<task.radiusMm||point.zMm<task.radiusMm||point.xMm>nav.widthMm-task.radiusMm||point.zMm>nav.heightMm-task.radiusMm
      ||[task.from,task.target,...points].some(prior=>prior.xMm===point.xMm&&prior.zMm===point.zMm))continue;
    if(!nav.free(point,task.radiusMm))continue;
    points.push(point);
  }
  points.sort((a,b)=>distance(a)-distance(b)||a.xMm-b.xMm||a.zMm-b.zMm);points.length=Math.min(points.length,CORNER_POINT_LIMIT);
}
/** Save/import validation reconstructs only bounded candidate metadata. Runtime
 * source collection and geometric sweeps remain incremental and grant charged. */
export function validCornerPathSearch(task:Pick<SavedTask,'stage'|'corner'|'from'|'target'|'radiusMm'|'lineStep'|'lineSteps'>,widthMm:number,heightMm:number,obstacles:readonly Obstacle[]):boolean {
  const state=task.corner;if(!state)return task.stage!=='corner';
  const distance=Math.hypot(task.target.xMm-task.from.xMm,task.target.zMm-task.from.zMm);
  if(task.stage!=='corner'||distance<CORNER_ROUTE_MIN_MM||task.lineStep<=0||task.lineStep>task.lineSteps||task.lineSteps!==Math.max(1,Math.ceil(distance/250))
    ||!Number.isSafeInteger(state.obstacleCursor)||state.obstacleCursor<0||state.obstacleCursor>Math.min(obstacles.length,CORNER_OBSTACLE_LIMIT)
    ||!Number.isSafeInteger(state.work)||state.work<state.obstacleCursor||state.work>CORNER_WORK_LIMIT||!Array.isArray(state.points)||state.points.length>CORNER_POINT_LIMIT+2)return false;
  const nav=new Navigation(widthMm,heightMm,[...obstacles]),expected:Position[]=[];for(let index=0;index<state.obstacleCursor;index++)cornerCandidates(task,expected,obstacles[index]!,nav);
  if(state.phase==='collect')return JSON.stringify(state.points)===JSON.stringify(expected)&&state.work===state.obstacleCursor&&['scores','parents','closed','current','edgeCursor','sweepStep','sweepSteps'].every(key=>!Object.hasOwn(state,key));
  if(state.phase!=='search'||state.obstacleCursor!==Math.min(obstacles.length,CORNER_OBSTACLE_LIMIT)||!expected.length||state.work<=state.obstacleCursor
    ||JSON.stringify(state.points)!==JSON.stringify([task.from,task.target,...expected]))return false;
  const {points,scores,parents,closed}=state,count=points.length;
  if(!Array.isArray(scores)||!Array.isArray(parents)||!Array.isArray(closed)||scores.length!==count||parents.length!==count||closed.length!==count
    ||scores[0]!==0||parents[0]!==-1||closed[1]||!Number.isSafeInteger(state.edgeCursor)||state.edgeCursor!<0||state.edgeCursor!>count
    ||!Number.isSafeInteger(state.sweepStep)||state.sweepStep!<0||!Number.isSafeInteger(state.sweepSteps)||state.sweepSteps!<0)return false;
  let minimumWork=state.obstacleCursor+1+closed.filter(Boolean).length;
  for(let index=0;index<count;index++){
    const score=scores[index],parent=parents[index]!;
    if(typeof closed[index]!=='boolean'||!Number.isSafeInteger(parent)||parent< -1||parent>=count||score!==null&&(!Number.isFinite(score)||score!<0))return false;
    if(index===0)continue;
    if(score===null){if(parent!==-1||closed[index])return false;continue;}
    if(parent<0||parent===index||!closed[parent]||scores[parent]===null||score!==scores[parent]!+Math.hypot(points[index]!.xMm-points[parent]!.xMm,points[index]!.zMm-points[parent]!.zMm)
      ||!nav.clearLine(points[parent]!,points[index]!,task.radiusMm))return false;
    minimumWork+=Math.max(1,Math.ceil(Math.hypot(points[index]!.xMm-points[parent]!.xMm,points[index]!.zMm-points[parent]!.zMm)/CORNER_SWEEP_MM));
  }
  if(state.work<minimumWork+state.sweepStep!)return false;
  if(state.current!==undefined&&(!Number.isSafeInteger(state.current)||state.current<0||state.current>=count||state.current===1||!closed[state.current]))return false;
  if(state.sweepSteps===0)return state.sweepStep===0;
  if(state.current===undefined||state.edgeCursor!>=count||state.sweepStep!<=0||state.sweepStep!>=state.sweepSteps!||closed[state.edgeCursor!])return false;
  const from=points[state.current]!,to=points[state.edgeCursor!]!;
  const progress=state.sweepStep!/state.sweepSteps!,point={xMm:from.xMm+(to.xMm-from.xMm)*progress,zMm:from.zMm+(to.zMm-from.zMm)*progress};
  return state.sweepSteps===Math.max(1,Math.ceil(Math.hypot(to.xMm-from.xMm,to.zMm-from.zMm)/CORNER_SWEEP_MM))&&nav.clearLine(from,point,task.radiusMm);
}

/** Deterministic incremental path work; no asynchronous result can outlive its order. */
export class PathScheduler {
  private tasks=new Map<string,Task>();
  private regions=new Map<string,Region>();
  private regionLookup=new Map<string,Map<number,Map<SearchKey,Region>>>();
  private revisions:Record<string,number>={};
  private routes=new Map<string,Route>();
  private routeComponents:RouteComponentIndex=new Map();
  private routeEnds:RouteEndIndex=new Map();
  private expandedConnectors=new WeakMap<Task,Set<string>>();
  private cornerDependencies=new WeakMap<CornerPathSearch,CornerDependencies>();
  private endpointKeyCache=new WeakMap<object,{starts:readonly string[];ends:readonly string[];keys:[SearchKey[],SearchKey[]]}>();
  private corridorKeyCache=new WeakMap<Task,{source:readonly string[];keys:Set<SearchKey>}>();
  private cursor=0;
  private cacheHits=0;
  private profileCursors:Record<string,number>={};
  private priority:PathPriorityState|undefined;
  private sharedGeometryVersions:Record<string,number>={};
  private sharedInitialized=false;
  private sharedServiceRevision=0;
  private sharedJobs=new SharedPathJobs(member=>this.sharedFrontier(member));
  private pathCensus:PathPlanningCensus|undefined;
  private attemptRestartObserver:((unitId:string)=>void)|undefined;
  constructor(private readonly navigation:(profile:string)=>Navigation,private readonly profileIds:readonly string[]=[]){if(new Set(profileIds).size!==profileIds.length)throw new Error('DUPLICATE_PATH_PROFILE');}
  static nativeCheckpointDiagnostics(){return {...nativeCheckpointCounts};}
  enablePathDiagnostics(clock:PathDiagnosticClock):void{this.pathCensus=new PathPlanningCensus(clock);this.pathCensus.observe(this.tasks.values(),false);}
  pathDiagnostics():PathPlanningDiagnostics|undefined{return this.pathCensus?.snapshot(this.tasks.size);}
  pendingRequests():PathRequest[]{return [...this.tasks.values()].filter(task=>!task.result||task.result.status==='pending').map(task=>({id:task.id,unitId:task.unitId,profile:task.profile,orderRevision:task.orderRevision,from:{...task.from},target:{...task.target},radiusMm:task.radiusMm,...(task.enqueuedTick!==undefined?{enqueuedTick:task.enqueuedTick,workClass:task.workClass!}:{})}));}
  queueSummary(tick:number){const tasks=this.tasks;return summarizePathQueue((function*():Generator<PathQueueTask>{for(const task of tasks.values())yield {request:task,status:task.result?.status??'pending'};})(),tick,this.pathCensus);}
  observeAttemptRestarts(observer:((unitId:string)=>void)|undefined):void{this.attemptRestartObserver=observer;}
  request(request:PathRequest):void {
    if(!request.id||!request.unitId||!request.profile||!Number.isSafeInteger(request.orderRevision)||request.orderRevision<0||!Number.isFinite(request.radiusMm)||request.radiusMm<=0||![request.from.xMm,request.from.zMm,request.target.xMm,request.target.zMm].every(Number.isSafeInteger))throw new Error('INVALID_PATH_REQUEST');
    if(this.profileIds.length&&!this.profileIds.includes(request.profile))throw new Error('UNKNOWN_PATH_PROFILE');
    if((request.workClass===undefined)!==(request.enqueuedTick===undefined)||request.workClass!==undefined&&(!['interactive','routine','optional'].includes(request.workClass)||!Number.isSafeInteger(request.enqueuedTick)||request.enqueuedTick!<0))throw new Error('INVALID_PATH_PRIORITY');
    const existing=this.tasks.get(request.unitId);
    if(existing&&existing.orderRevision>request.orderRevision)return;
    if(existing&&existing.id===request.id&&existing.orderRevision===request.orderRevision)return;
    if(this.profileIds.length&&!existing&&this.tasks.size>=PATH_TASK_LIMIT)throw new Error('PATH_TASK_LIMIT');
    if(request.workClass!==undefined)this.priority??={tick:request.enqueuedTick!,profiles:{}};
    if(request.workClass!==undefined&&this.profileIds.length){this.sharedInitialized=true;this.sharedGeometryVersions[request.profile]??=0;}
    this.sharedJobs.cancel(request.unitId);
    this.tasks.set(request.unitId,{...structuredClone(request),stage:'direct',lineStep:0,lineSteps:Math.max(1,Math.ceil(Math.hypot(request.target.xMm-request.from.xMm,request.target.zMm-request.from.zMm)/250))});
    this.pathCensus?.requested(request,!!existing);
    this.pathCensus?.progressed(this.tasks.get(request.unitId)!);
  }
  cancel(unitId:string):void{if(this.pathCensus){const task=this.tasks.get(unitId);if(task)this.pathCensus.canceled(task);}this.sharedJobs.cancel(unitId);this.tasks.delete(unitId);}
  take(unitId:string,orderRevision:number):PathResult|undefined {
    const task=this.tasks.get(unitId);if(!task||task.orderRevision!==orderRevision){this.pathCensus?.taken(undefined,'missing');return undefined;}
    if(task.stage!=='done'){this.pathCensus?.taken(task,'pending');return {status:'pending',id:task.id,orderRevision};}
    this.pathCensus?.taken(task,task.result!.status);
    this.sharedJobs.cancel(unitId);this.tasks.delete(unitId);return structuredClone(task.result!);
  }
  /** Call only for changes in this recipient's authorized obstacle geometry. */
  invalidate(profile:string,rectangles:readonly TerrainRectangle[]):void {
    const changed=new Set<string>();
    // A neighboring region can change traversability for a large body even when
    // its center never enters the edited rectangle. Derive the same envelope
    // after cold restore from retained caches/jobs, keeping Classic's 1m floor.
    let clearance=1000;for(const radius of this.regionLookup.get(profile)?.keys()??[])clearance=Math.max(clearance,radius);for(const radius of this.routeEnds.get(profile)?.keys()??[])clearance=Math.max(clearance,radius);for(const task of this.tasks.values())if(task.profile===profile)clearance=Math.max(clearance,task.radiusMm);
    for(const rect of rectangles)for(let z=Math.floor((rect.zMm-clearance)/(SIDE*CELL));z<=Math.floor((rect.zMm+rect.depthMm+clearance)/(SIDE*CELL));z++)for(let x=Math.floor((rect.xMm-clearance)/(SIDE*CELL));x<=Math.floor((rect.xMm+rect.widthMm+clearance)/(SIDE*CELL));x++)if(x>=0&&z>=0)changed.add(`${x},${z}`);
    for(const region of changed){const key=`${profile}:${region}`;this.revisions[key]=(this.revisions[key]??0)+1;}
    const restarted=new Set<string>();
    if(Object.hasOwn(this.sharedGeometryVersions,profile)){
      const geometryRevision=++this.sharedGeometryVersions[profile];
      for(const member of this.sharedJobs.invalidate(profile,changed,{geometryRevision,frontier:frontier=>this.repairCoarseFrontier(frontier,changed)}))restarted.add(member.request.unitId);
    }
    for(const [key,region]of this.regions)if(region.profile===profile&&changed.has(`${region.x},${region.z}`)){this.regions.delete(key);this.regionLookup.get(profile)?.get(region.radiusMm)?.delete(regionKey(region.x,region.z));}
    for(const [key,route]of this.routes)if(route.profile===profile&&route.regions.some(stamp=>changed.has(stamp.region)))this.deleteRoute(key);
    for(const task of [...this.tasks.values()])if(task.profile===profile){
      if(this.sharedJobs.isMember(task.unitId))continue;
      // An unfinished direct sweep has no region search yet. Distant authorized
      // observations cannot affect its segment; keep its exact sweep progress.
      if(task.stage==='direct'&&!rectangles.some(rect=>rect.xMm<=Math.max(task.from.xMm,task.target.xMm)+task.radiusMm&&rect.xMm+rect.widthMm>=Math.min(task.from.xMm,task.target.xMm)-task.radiusMm&&rect.zMm<=Math.max(task.from.zMm,task.target.zMm)+task.radiusMm&&rect.zMm+rect.depthMm>=Math.min(task.from.zMm,task.target.zMm)-task.radiusMm))continue;
      if(task.stage==='corner'){
        const nav=this.navigation(profile),state=task.corner!,proof=this.cornerDependencies.get(state)!;
        // Candidate collection is order-sensitive. A removed/reordered source
        // must not leave a save whose candidates describe an older obstacle list.
        const sourcesCurrent=proof.sources.every((source,index)=>{const current=nav.obstacles[index];return current&&source.xMm===current.xMm&&source.zMm===current.zMm&&source.halfWidth===current.halfWidth&&source.halfHeight===current.halfHeight&&source.circle===current.circle;})
          &&(state.phase!=='search'||state.obstacleCursor===Math.min(nav.obstacles.length,CORNER_OBSTACLE_LIMIT));
        const graph=proof.graph,graphChanged=graph&&rectangles.some(rect=>rect.xMm<=graph.xMm+graph.widthMm&&rect.xMm+rect.widthMm>=graph.xMm&&rect.zMm<=graph.zMm+graph.depthMm&&rect.zMm+rect.depthMm>=graph.zMm);
        if(sourcesCurrent&&!graphChanged&&![...proof.regions].some(region=>changed.has(region)))continue;
        // This optional shortcut has already consumed credits. Enter the
        // ordinary planner instead of repeatedly restarting direct -> corner.
        // No searched edge or candidate from the old geometry is retained.
        this.deferCoarsePreparation(task);continue;
      }
      const used=task.corridor??[...(task.coarse?.scores.keys()??[])].map(componentRegionText);
      if(task.stage==='coarse'&&!task.coarse&&!restarted.has(task.unitId)){
        if([...this.preparationRegions(task)].some(region=>changed.has(region)))this.deferCoarsePreparation(task);
        continue;
      }
      if(task.stage==='coarse'&&task.coarse&&!restarted.has(task.unitId)&&![...task.startComponents!,...task.endComponents!].some(key=>changed.has(componentRegion(key)))&&![...this.expandedConnectorRegions(task)].some(region=>changed.has(region))){
        this.repairCoarseFrontier(task,changed);continue;
      }
      if(restarted.has(task.unitId)||!used.length||used.some(region=>changed.has(region))||task.result?.status==='blocked'||[...this.expandedConnectorRegions(task)].some(region=>changed.has(region))){
        // A request that has already paid for its optional shortcuts must never
        // return to them merely because a searched region changed. Component
        // labels can change after either obstacle addition or removal, so discard
        // this task's dependent searches, but retain other prepared regions and
        // its original request age/priority. Endpoint work remains grant charged.
        if(task.stage==='coarse'||task.stage==='fine'||restarted.has(task.unitId)){this.deferCoarsePreparation(task);continue;}
        const copy:PathRequest={id:task.id,unitId:task.unitId,orderRevision:task.orderRevision,from:task.from,target:task.target,radiusMm:task.radiusMm,profile:task.profile,...(task.workClass!==undefined?{workClass:task.workClass,enqueuedTick:task.enqueuedTick!}:{})};
        this.pathCensus?.invalidated(task.unitId);
        this.tasks.delete(task.unitId);this.request(copy);
      }
    }
  }
  isCurrent(profile:string,stamps:readonly RegionStamp[]):boolean{return stamps.every(stamp=>(this.revisions[`${profile}:${stamp.region}`]??0)===stamp.revision);}
  exportState():PathSchedulerState{const state=structuredClone({version:1 as const,tasks:[...this.tasks.values()].map(exportTask),regions:[...this.regions.values()],revisions:this.revisions,routes:[...this.routes],cursor:this.cursor,profileCursors:this.profileCursors,...(this.priority?{priority:this.priority}:{}),...(this.sharedInitialized?{sharedJobs:{geometryVersions:this.sharedGeometryVersions,registry:this.sharedJobs.exportState()}}:{})});return this.profileIds.length?canonicalPathState(state):state;}
  /** Internal owned-worker emission only. Public exportState remains detached.
   * Copy caller metadata before reading authority, then assemble fresh ordered
   * containers and use the captured IPC intrinsic as the sole deep-copy boundary.
   * No borrowed graph is returned, retained or passed to a caller callback. */
  postNativeCheckpoint(port:MessagePort,message:PreparedPathCheckpointMessage):void{
    try{
      try{checkpointHasRef(port);}catch{throw new Error('INVALID_NATIVE_CHECKPOINT_PORT');}
      if(!checkpointMessages.has(message))throw new Error('INVALID_PATH_CHECKPOINT_MESSAGE');
      const assembled:PathSchedulerState={version:1,tasks:[...this.tasks.values()].map(exportTask),regions:[...this.regions.values()],revisions:this.revisions,routes:[...this.routes],cursor:this.cursor,profileCursors:this.profileCursors,...(this.priority?{priority:this.priority}:{}),...(this.sharedInitialized?{sharedJobs:{geometryVersions:this.sharedGeometryVersions,registry:this.sharedJobs.exportState()}}:{})};
      postPathCheckpointMessage(port,message,this.profileIds.length?canonicalPathState(assembled):assembled);
      nativeCheckpointCounts.posted=Math.min(Number.MAX_SAFE_INTEGER,nativeCheckpointCounts.posted+1);
    }finally{discardPathCheckpointMessage(message);}
  }
  taskMirrors():PathTaskMirror[]{return [...this.tasks.values()].map(task=>({request:{id:task.id,unitId:task.unitId,orderRevision:task.orderRevision,from:{...task.from},target:{...task.target},radiusMm:task.radiusMm,profile:task.profile,...(task.workClass!==undefined?{workClass:task.workClass,enqueuedTick:task.enqueuedTick!}:{})},result:task.result?structuredClone(task.result):{status:'pending',id:task.id,orderRevision:task.orderRevision},direct:task.stage==='direct',usedRegions:this.sharedJobs.dependencies(task.unitId)??(task.corridor?[...task.corridor]:[...(task.coarse?.scores.keys()??[])].map(componentRegionText)),connectorRegions:[...this.expandedConnectorRegions(task)]}));}
  private sharedFrontier(member:SharedPathMember):SharedCoarseFrontier|undefined{
    const task=this.tasks.get(member.request.unitId);if(!task||task.id!==member.request.id||task.orderRevision!==member.request.orderRevision||task.profile!==member.request.profile||task.radiusMm!==member.request.radiusMm||task.stage!=='coarse'||!task.coarse||!task.starts||!task.ends||!task.startComponents||!task.endComponents||JSON.stringify(task.startComponents)!==JSON.stringify(member.startComponents)||JSON.stringify(task.endComponents)!==JSON.stringify(member.endComponents))return;
    return {profile:task.profile,radiusMm:task.radiusMm,from:task.from,target:task.target,starts:task.starts,ends:task.ends,startComponents:task.startComponents,endComponents:task.endComponents,coarse:task.coarse,...(task.currentComponent!==undefined?{currentComponent:task.currentComponent,edgeCursor:task.edgeCursor!}:{})};
  }
  private considerShared(task:Task,nav:Navigation):void{
    if(!this.sharedInitialized||task.workClass===undefined)return;
    const request:PathRequest={id:task.id,unitId:task.unitId,orderRevision:task.orderRevision,from:task.from,target:task.target,radiusMm:task.radiusMm,profile:task.profile,workClass:task.workClass,enqueuedTick:task.enqueuedTick!};
    const admitted=this.sharedJobs.consider({request,geometryRevision:this.sharedGeometryVersions[task.profile]??0,widthMm:nav.widthMm,heightMm:nav.heightMm,startComponents:task.startComponents!,endComponents:task.endComponents!,connectorRegions:[...this.expandedConnectorRegions(task)]});
    if(admitted.length)this.sharedServiceRevision++;
  }
  private advanceShared(service:SharedPathService):boolean{
    const result=this.sharedJobs.advance(service.id,frontier=>this.advanceCoarse(frontier,this.navigation(frontier.profile)));if(result.status==='pending')return false;
    this.sharedServiceRevision++;
    for(const member of result.members){const task=this.tasks.get(member.request.unitId);if(!task||task.id!==member.request.id||task.orderRevision!==member.request.orderRevision)throw new Error('STALE_SHARED_PATH_MEMBER');
      if(result.status==='blocked'){this.finish(task);this.pathCensus?.completed(task,'blocked');}
      else if(result.status==='restart'){this.pathCensus?.prepareRestart(task.unitId);this.attemptRestartObserver?.(task.unitId);this.deferCoarsePreparation(task);}
      else if(result.status==='ready'){
        // Each subscriber pays its ordinary next coarse credit to seed its own
        // fine connectors. The independent job has exactly one service position.
        task.coarse=search();for(const [index,text]of result.chain.entries()){const key=componentFromText(text);task.coarse.scores.set(key,index);if(index)task.coarse.parents.set(key,componentFromText(result.chain[index-1]!));}
        task.coarse.heap.push({key:componentFromText(result.chain.at(-1)!),score:0});delete task.currentComponent;delete task.edgeCursor;
      }
    }
    return true;
  }
  importState(state:PathSchedulerState):void {
    if(state.version!==1)throw new Error('INVALID_PATH_STATE');
    for(const task of state.tasks)if(task.stage==='corner'||task.corner){const nav=this.navigation(task.profile);if(!validCornerPathSearch(task,nav.widthMm,nav.heightMm,nav.obstacles))throw new Error('INVALID_CORNER_PATH_STATE');}
    const restored=structuredClone(state),counts=new Map<string,number>();for(const [,route]of restored.routes){const count=(counts.get(route.profile)??0)+1;if(count>512)throw new Error('INVALID_PATH_STATE');counts.set(route.profile,count);}
    this.tasks=new Map(restored.tasks.map(task=>[task.unitId,importTask(task)]));this.regions=new Map(restored.regions.map(region=>[region.key,region]));this.regionLookup=new Map();for(const region of this.regions.values())this.indexRegion(region);this.revisions=restored.revisions;this.routes=new Map(restored.routes);this.cursor=restored.cursor;this.profileCursors=restored.profileCursors??{};this.priority=restored.priority;
    this.sharedInitialized=Boolean(restored.sharedJobs);this.sharedGeometryVersions=restored.sharedJobs?.geometryVersions??{};this.sharedJobs=new SharedPathJobs(member=>this.sharedFrontier(member));if(restored.sharedJobs)this.sharedJobs.importState(restored.sharedJobs.registry);
    this.routeComponents=new Map();this.routeEnds=new Map();for(const [key,route]of this.routes)this.indexRoute(key,route);
    this.cornerDependencies=new WeakMap();for(const task of this.tasks.values())if(task.corner)this.rememberCornerDependencies(task,this.navigation(task.profile));
    this.pathCensus?.observe(this.tasks.values(),true);
  }
  private indexRoute(key:string,route:Route):void{
    const components=routeComponents(key,route);if(!components)return;
    let profile=this.routeComponents.get(route.profile);if(!profile){profile=new Map();this.routeComponents.set(route.profile,profile);}
    let radius=profile.get(route.radiusMm);if(!radius){radius=new Map();profile.set(route.radiusMm,radius);}
    for(const start of components[0]){let ends=radius.get(start);if(!ends){ends=new Map();radius.set(start,ends);}for(const end of components[1]){let keys=ends.get(end);if(!keys){keys=new Set();ends.set(end,keys);}keys.add(key);}}
    let endProfile=this.routeEnds.get(route.profile);if(!endProfile){endProfile=new Map();this.routeEnds.set(route.profile,endProfile);}
    let endRadius=endProfile.get(route.radiusMm);if(!endRadius){endRadius=new Map();endProfile.set(route.radiusMm,endRadius);}
    for(const end of components[1]){let keys=endRadius.get(end);if(!keys){keys=new Map();endRadius.set(end,keys);}keys.set(key,components[0]);}
  }
  private deleteRoute(key:string):void{
    const route=this.routes.get(key);if(!route)return;this.routes.delete(key);
    const components=routeComponents(key,route),profile=this.routeComponents.get(route.profile),radius=profile?.get(route.radiusMm);if(!components)return;
    const endProfile=this.routeEnds.get(route.profile),endRadius=endProfile?.get(route.radiusMm);
    if(endProfile&&endRadius){for(const end of components[1]){const keys=endRadius.get(end);keys?.delete(key);if(!keys?.size)endRadius.delete(end);}if(!endRadius.size)endProfile.delete(route.radiusMm);if(!endProfile.size)this.routeEnds.delete(route.profile);}
    if(!profile||!radius)return;
    for(const start of components[0]){const ends=radius.get(start);if(!ends)continue;for(const end of components[1]){const keys=ends.get(end);if(!keys)continue;keys.delete(key);if(!keys.size)ends.delete(end);}if(!ends.size)radius.delete(start);}
    if(!radius.size)profile.delete(route.radiusMm);if(!profile.size)this.routeComponents.delete(route.profile);
  }
  private cachedRoute(task:Task):Route|undefined{
    const exact=task.cacheKey&&this.routes.get(task.cacheKey);if(exact)return exact;
    if(!task.startComponents||!task.endComponents||task.startComponents.length>9||task.endComponents.length>9)return;const [starts,targets]=this.endpointKeys(task as SharedCoarseFrontier);
    const radius=this.routeComponents.get(task.profile)?.get(task.radiusMm);if(!radius)return;
    // At most nine start by nine end components; never scan every cached route
    // during a fine expansion. Bucket order is rebuilt from saved route order.
    for(const start of starts){const ends=radius.get(start);if(!ends)continue;for(const end of targets){const key=ends.get(end)?.values().next().value;if(key!==undefined)return this.routes.get(key);}}
    return;
  }
  private endJoinRoute(task:Task):{matched:boolean;route?:Route;pointIndex?:number}{return this.pathCensus?this.pathCensus.execution.measure('scheduler.end-join-scan',()=>this.endJoinRouteUnobserved(task)):this.endJoinRouteUnobserved(task);}
  private endJoinRouteUnobserved(task:Task):{matched:boolean;route?:Route;pointIndex?:number}{
    const radius=this.routeEnds.get(task.profile)?.get(task.radiusMm);
    if(!radius||!task.startComponents||!task.endComponents||task.startComponents.length>9||task.endComponents.length>9)return {matched:false};const [starts,ends]=this.endpointKeys(task as SharedCoarseFrontier);
    let matched=false,best:Route|undefined,bestDistance=Infinity,suffix:Route|undefined,suffixDistance=Infinity,suffixIndex=0;const seen=new Set<string>();
    // Preserve first-point priority within each bucket's first four keys. Only
    // when none qualifies may a later point in its first eight supply a suffix.
    // Ties retain component order, cache insertion order, then point index.
    for(const end of ends){const keys=radius.get(end);if(!keys?.size)continue;matched=true;const prefix=keys.entries();
      for(let visited=0;visited<4;visited++){const entry=prefix.next();if(entry.done)break;const [key,components]=entry.value;if(seen.has(key))continue;seen.add(key);
        if(components.some(component=>starts.includes(component)))continue;
        const route=this.routes.get(key),first=route?.points[0];if(!route||!first||route.profile!==task.profile||route.radiusMm!==task.radiusMm)continue;
        const distance=(first.xMm-task.from.xMm)**2+(first.zMm-task.from.zMm)**2;
        if(distance<=32000**2&&distance<bestDistance&&this.isCurrent(task.profile,route.regions)){best=route;bestDistance=distance;}
        if(best)continue;
        let pointIndex=0,nearest=suffixDistance;
        for(let index=1;index<Math.min(8,route.points.length);index++){const point=route.points[index]!,distance=(point.xMm-task.from.xMm)**2+(point.zMm-task.from.zMm)**2;if(distance<=32000**2&&distance<nearest){pointIndex=index;nearest=distance;}}
        if(pointIndex&&this.isCurrent(task.profile,route.regions)){suffix=route;suffixDistance=nearest;suffixIndex=pointIndex;}
      }
    }
    return {matched,...(best?{route:best,pointIndex:0}:suffix?{route:suffix,pointIndex:suffixIndex}:{})};
  }
  advance(nodeBudget:number,tick?:number):PathWorkReport {
    return this.advanceProfiles(pathProfileGrants(this.profileIds,nodeBudget),tick);
  }
  /** Exact externally assigned grants; a worker must never redistribute unused credits. */
  advanceProfiles(grants:readonly PathProfileGrant[],tick?:number):PathWorkReport {
    if(new Set(grants.map(grant=>grant.profile)).size!==grants.length||grants.some(grant=>!Number.isSafeInteger(grant.nodeBudget)||grant.nodeBudget<0||(this.profileIds.length&&!this.profileIds.includes(grant.profile))))throw new Error('INVALID_PATH_GRANTS');
    if(tick!==undefined&&(!Number.isSafeInteger(tick)||tick<0||this.priority&&tick<this.priority.tick))throw new Error('INVALID_PATH_TICK');
    if(this.priority&&tick!==undefined)this.priority.tick=tick;
    let work=0;
    // Fixed faction shares make hidden enemy order volume unable to delay this
    // recipient's own routes. Unused work is deliberately not borrowed.
    for(const {profile,nodeBudget:quota}of grants){
      type Service=Task|SharedPathService;
      const collect=():Service[]=>[...[...this.tasks.values()].filter(task=>task.stage!=='done'&&(!profile||task.profile===profile)&&!this.sharedJobs.isMember(task.unitId)),...this.sharedJobs.services(profile,this.priority?.tick??0)];
      const perform=(service:Service):boolean=>{
        if(!('unitId'in service))return this.advanceShared(service);
        if(this.pathCensus)this.pathCensus.execution.measure('scheduler.step',()=>this.step(service),service);else this.step(service);this.pathCensus?.progressed(service);
        if(service.stage==='done'){this.pathCensus?.completed(service,service.result!.status as 'ready'|'blocked');return true;}return false;
      };
      let pending=collect(),spent=0,cursor=profile?this.profileCursors[profile]??0:this.cursor;
      if(this.priority&&(this.priority.profiles[profile]||pending.some(task=>task.workClass!==undefined))){
        const state=this.priority.profiles[profile]??={phase:0,interactive:0,routine:0,optional:0};
        const classify=(services:Service[]):Record<PathWorkClass,Service[]>=>{const queues:Record<PathWorkClass,Service[]>={interactive:[],routine:[],optional:[]};for(const task of services){const lane=task.workClass==='routine'&&this.priority!.tick-task.enqueuedTick!>=40?'interactive':task.workClass??'interactive';queues[lane].push(task);}return queues;};
        let queues=classify(pending);
        while(spent<quota&&(queues.interactive.length||queues.routine.length||queues.optional.length)){
          let lane:PathWorkClass;if(queues.interactive.length&&queues.routine.length){lane=state.phase===3?'routine':'interactive';state.phase=(state.phase+1)%4;}else lane=queues.interactive.length?'interactive':queues.routine.length?'routine':'optional';
          const queue=queues[lane];state[lane]%=queue.length;const service=queue[state[lane]]!,revision=this.sharedServiceRevision,done=perform(service);spent++;
          if(done)queue.splice(state[lane],1);else state[lane]=(state[lane]+1)%queue.length;
          if(this.sharedServiceRevision!==revision)queues=classify(collect());
        }
        if(profile)this.profileCursors[profile]=cursor;else this.cursor=cursor;work+=spent;continue;
      }
      while(spent<quota&&pending.length){cursor%=pending.length;const revision=this.sharedServiceRevision,done=perform(pending[cursor]!);spent++;if(done)pending.splice(cursor,1);else cursor=(cursor+1)%pending.length;if(this.sharedServiceRevision!==revision)pending=collect();}
      if(profile)this.profileCursors[profile]=cursor;else this.cursor=cursor;work+=spent;
    }
    const all=[...this.tasks.values()];return {work,pending:all.filter(task=>task.stage!=='done').length,ready:all.filter(task=>task.result?.status==='ready').length,blocked:all.filter(task=>task.result?.status==='blocked').length,regionCount:this.regions.size,cacheHits:this.cacheHits};
  }
  private cell(point:Position,nav:Navigation):number{return Math.floor(point.zMm/CELL)*Math.floor(nav.widthMm/CELL)+Math.floor(point.xMm/CELL);}
  private endpointKeys(task:Pick<SharedCoarseFrontier,'startComponents'|'endComponents'>):[SearchKey[],SearchKey[]] {let cached=this.endpointKeyCache.get(task);if(!cached||cached.starts!==task.startComponents||cached.ends!==task.endComponents){cached={starts:task.startComponents,ends:task.endComponents,keys:[task.startComponents.map(componentFromText),task.endComponents.map(componentFromText)]};this.endpointKeyCache.set(task,cached);}return cached.keys;}
  private corridorKeys(task:Task):Set<SearchKey> {let cached=this.corridorKeyCache.get(task);if(!cached||cached.source!==task.corridor){cached={source:task.corridor!,keys:new Set(task.corridor!.map(regionFromText))};this.corridorKeyCache.set(task,cached);}return cached.keys;}
  private point(cell:number,nav:Navigation,_radius:number):Position{const width=Math.floor(nav.widthMm/CELL);return {xMm:(cell%width)*CELL,zMm:Math.floor(cell/width)*CELL};}
  private indexRegion(region:Region):void {let profile=this.regionLookup.get(region.profile);if(!profile){profile=new Map();this.regionLookup.set(region.profile,profile);}let radius=profile.get(region.radiusMm);if(!radius){radius=new Map();profile.set(region.radiusMm,radius);}radius.set(regionKey(region.x,region.z),region);}
  private region(task:Pick<PathRequest,'profile'|'radiusMm'>,point:Position):Region {
    const x=Math.floor(point.xMm/(SIDE*CELL)),z=Math.floor(point.zMm/(SIDE*CELL));
    let region=this.regionLookup.get(task.profile)?.get(task.radiusMm)?.get(regionKey(x,z));if(!region){const key=`${task.profile}:${task.radiusMm}:${x},${z}`;region={key,profile:task.profile,radiusMm:task.radiusMm,x,z,labels:Array(SIDE*SIDE).fill(-2),cursor:0,frontier:[],frontierCursor:0,label:0,complete:false};this.regions.set(key,region);this.indexRegion(region);}return region;
  }
  private buildRegion(region:Region,nav:Navigation):void{return this.pathCensus?this.pathCensus.execution.measure('scheduler.region-fill',()=>this.buildRegionUnobserved(region,nav)):this.buildRegionUnobserved(region,nav);}
  private buildRegionUnobserved(region:Region,nav:Navigation):void {
    const offset=0;
    const point=(local:number):Position=>({xMm:(region.x*SIDE+local%SIDE)*CELL+offset,zMm:(region.z*SIDE+Math.floor(local/SIDE))*CELL+offset});
    if(region.frontierCursor<region.frontier.length){
      const cell=region.frontier[region.frontierCursor++]!,x=cell%SIDE,z=Math.floor(cell/SIDE),from=point(cell);
      for(const [dx,dz]of directions){const nx=x+dx,nz=z+dz,index=nz*SIDE+nx;if(nx<0||nz<0||nx>=SIDE||nz>=SIDE||region.labels[index]!==-2)continue;const target=point(index);if(!nav.free(target,region.radiusMm)){region.labels[index]=-1;continue;}if(nav.clearLine(from,target,region.radiusMm)){region.labels[index]=region.label;region.frontier.push(index);}}
      return;
    }
    region.frontier=[];region.frontierCursor=0;
    while(region.cursor<SIDE*SIDE&&region.labels[region.cursor]!==-2)region.cursor++;
    if(region.cursor===SIDE*SIDE){region.complete=true;return;}
    const index=region.cursor++;if(!nav.free(point(index),region.radiusMm)){region.labels[index]=-1;return;}
    region.label=index;region.labels[index]=index;region.frontier.push(index);
  }
  private component(task:Pick<PathRequest,'profile'|'radiusMm'>,point:Position):SearchKey|undefined {
    const region=this.region(task,point);if(!region.complete)return undefined;
    const label=region.labels[(Math.floor(point.zMm/CELL)%SIDE)*SIDE+Math.floor(point.xMm/CELL)%SIDE]!;return label<0?'':componentKey(region.x,region.z,label);
  }
  private connectors(point:Position,nav:Navigation,radius:number):number[]{return this.pathCensus?this.pathCensus.execution.measure('scheduler.connectors',()=>this.connectorsUnobserved(point,nav,radius)):this.connectorsUnobserved(point,nav,radius);}
  private connectorsUnobserved(point:Position,nav:Navigation,radius:number):number[]{
    return navigationConnectors(nav,point,radius,CELL,cell=>this.point(cell,nav,radius));
  }
  /** Endpoint preparation has no coarse frontier yet. Its region labels and
   * bounded connector searches depend only on the two endpoint neighborhoods. */
  private preparationRegions(task:Task):Set<string>{
    const nav=this.navigation(task.profile),regions=new Set(this.expandedConnectorRegions(task)),reach=4*CELL+Math.ceil(task.radiusMm),size=SIDE*CELL;
    for(const point of [task.from,task.target])for(let z=Math.max(0,Math.floor((point.zMm-reach)/size));z<=Math.min(Math.ceil(nav.heightMm/size)-1,Math.floor((point.zMm+reach)/size));z++)for(let x=Math.max(0,Math.floor((point.xMm-reach)/size));x<=Math.min(Math.ceil(nav.widthMm/size)-1,Math.floor((point.xMm+reach)/size));x++)regions.add(`${x},${z}`);
    return regions;
  }
  /** Private, reconstructible proof: never serialized as authority. Include all
   * inspected corners (even rejected ones) and the candidate graph envelope. */
  private rememberCornerDependencies(task:Task,nav:Navigation):void{
    const state=task.corner!;let proof=this.cornerDependencies.get(state);
    if(!proof){proof={sources:[],regions:new Set()};this.cornerDependencies.set(state,proof);addConnectorRegions(proof.regions,task.from,task.target,task.radiusMm,nav);}
    const margin=Math.ceil(task.radiusMm)+50;
    while(proof.sources.length<state.obstacleCursor){const source={...nav.obstacles[proof.sources.length]!};proof.sources.push(source);for(const dx of [-1,1])for(const dz of [-1,1]){const point={xMm:Math.round(source.xMm+dx*(source.halfWidth+margin)),zMm:Math.round(source.zMm+dz*(source.halfHeight+margin))};addConnectorRegions(proof.regions,point,point,task.radiusMm,nav);}}
    if(state.phase==='search'&&!proof.graph){
      const xs=state.points.map(point=>point.xMm),zs=state.points.map(point=>point.zMm),radius=Math.ceil(task.radiusMm);
      // Every tested candidate edge lies within this conservative rectangle.
      proof.graph={xMm:Math.min(...xs)-radius,zMm:Math.min(...zs)-radius,widthMm:Math.max(...xs)-Math.min(...xs)+2*radius,depthMm:Math.max(...zs)-Math.min(...zs)+2*radius};
    }
  }
  /** Only the new outer-ring connectors add coverage. Derive it from existing
   * saved endpoint cells so pending searches and restored tasks agree exactly. */
  private expandedConnectorRegions(task:Task,points?:Position[],navigation?:Navigation):Set<string>{
    let regions=this.expandedConnectors.get(task),nav=navigation;
    if(!regions){
      regions=new Set<string>();if(!task.starts&&!task.ends)return regions;
      nav??=this.navigation(task.profile);const width=Math.floor(nav.widthMm/CELL);
      for(const [point,cells]of [[task.from,task.starts],[task.target,task.ends]] as const){
        const cx=Math.floor(point.xMm/CELL),cz=Math.floor(point.zMm/CELL);
        for(const cell of cells??[])if(Math.abs(cell%width-cx)>1||Math.abs(Math.floor(cell/width)-cz)>1)addConnectorRegions(regions,point,this.point(cell,nav,task.radiusMm),task.radiusMm,nav);
      }
      // A pending bounded bridge may still discover any point in its square.
      // Keep that same conservative dependency after capture/completion so an
      // obstacle edit cannot leave a bent endpoint leg using stale geometry.
      for(const [point,bridged]of [[task.from,!!task.startBridge||!!task.startRoutes],[task.target,!!task.endBridge||!!task.endRoutes]] as const)if(bridged){
        const reach=(CONNECTOR_REACH_CELLS+1)*CONNECTOR_CELL_MM+Math.ceil(task.radiusMm),size=SIDE*CELL;
        for(let z=Math.max(0,Math.floor((point.zMm-reach)/size));z<=Math.min(Math.ceil(nav.heightMm/size)-1,Math.floor((point.zMm+reach)/size));z++)for(let x=Math.max(0,Math.floor((point.xMm-reach)/size));x<=Math.min(Math.ceil(nav.widthMm/size)-1,Math.floor((point.xMm+reach)/size));x++)regions.add(`${x},${z}`);
      }
      this.expandedConnectors.set(task,regions);
    }
    if(regions.size&&points?.length){
      regions=new Set(regions);nav??=this.navigation(task.profile);
      addConnectorRegions(regions,task.from,points[0]!,task.radiusMm,nav);
      if(points.length>1)addConnectorRegions(regions,task.target,points.at(-2)!,task.radiusMm,nav);
    }
    return regions;
  }
  private finish(task:Task,points?:Position[],cacheResult=true):void{return this.pathCensus?this.pathCensus.execution.measure('scheduler.finish',()=>this.finishUnobserved(task,points,cacheResult)):this.finishUnobserved(task,points,cacheResult);}
  private finishUnobserved(task:Task,points?:Position[],cacheResult=true):void {
    this.sharedJobs.cancel(task.unitId);
    delete task.corner;
    task.stage='done';if(!points){task.result={status:'blocked',id:task.id,orderRevision:task.orderRevision};return;}
    const connectors=this.expandedConnectorRegions(task,points);if(connectors.size)task.corridor=[...new Set([...(task.corridor??[]),...connectors])];
    const regionNames=new Set<string>(task.corridor??[]);
    let prior=task.from;
    for(const point of points){const steps=Math.max(1,Math.ceil(Math.hypot(point.xMm-prior.xMm,point.zMm-prior.zMm)/8000));for(let i=0;i<=steps;i++)regionNames.add(`${Math.floor((prior.xMm+(point.xMm-prior.xMm)*i/steps)/(SIDE*CELL))},${Math.floor((prior.zMm+(point.zMm-prior.zMm)*i/steps)/(SIDE*CELL))}`);prior=point;}
    const regions=[...regionNames].sort().map(region=>({region,revision:this.revisions[`${task.profile}:${region}`]??0}));
    task.result={status:'ready',id:task.id,orderRevision:task.orderRevision,points,regions};
    if(cacheResult&&task.cacheKey&&!this.routes.has(task.cacheKey)){const owned=[...this.routes.entries()].filter(([,route])=>route.profile===task.profile);if(owned.length>=512)this.deleteRoute(owned[0]![0]);const route={profile:task.profile,radiusMm:task.radiusMm,points:structuredClone(points),regions,corridor:task.corridor??[]};this.routes.set(task.cacheKey,route);this.indexRoute(task.cacheKey,route);}
  }
  private reuseRoute(task:Task,nav:Navigation,cached:Route,endJoin=false,pointIndex=0):boolean{return this.pathCensus?this.pathCensus.execution.measure('scheduler.cache-connectors',()=>this.reuseRouteUnobserved(task,nav,cached,endJoin,pointIndex)):this.reuseRouteUnobserved(task,nav,cached,endJoin,pointIndex);}
  private reuseRouteUnobserved(task:Task,nav:Navigation,cached:Route,endJoin=false,pointIndex=0):boolean {
    const first=cached.points[pointIndex];
    if(cached.profile!==task.profile||cached.radiusMm!==task.radiusMm||!this.isCurrent(task.profile,cached.regions)||!first||!nav.clearLine(task.from,first,task.radiusMm)||!nav.clearLine(cached.points.at(-1)!,task.target,task.radiusMm))return false;
    // A reused route may have a different component-set key. Never cache its
    // appended destination under that key and grow chains of prior arrivals.
    task.corridor=[...cached.corridor];
    if(endJoin){
      // Finished-but-untaken tasks are invalidated by corridor, so retain the
      // complete connector coverage there as well as in the returned stamps.
      const regions=new Set([...task.corridor,...cached.regions.map(stamp=>stamp.region)]);
      addConnectorRegions(regions,task.from,first,task.radiusMm,nav);addConnectorRegions(regions,cached.points.at(-1)!,task.target,task.radiusMm,nav);task.corridor=[...regions];
    }
    this.cacheHits++;this.finish(task,[...structuredClone(pointIndex?cached.points.slice(pointIndex):cached.points),{...task.target}],false);return true;
  }
  private step(task:Task):void {
    const nav=this.navigation(task.profile);
    if(task.stage==='direct'){
      if(task.lineStep===0&&!nav.free(task.target,task.radiusMm)){this.finish(task);return;}
      const before=task.lineStep/task.lineSteps,ratio=++task.lineStep/task.lineSteps,prior={xMm:task.from.xMm+(task.target.xMm-task.from.xMm)*before,zMm:task.from.zMm+(task.target.zMm-task.from.zMm)*before},point={xMm:task.from.xMm+(task.target.xMm-task.from.xMm)*ratio,zMm:task.from.zMm+(task.target.zMm-task.from.zMm)*ratio};
      if(nav.clearLine(prior,point,task.radiusMm)){if(task.lineStep===task.lineSteps)this.finish(task,[{...task.target}]);return;}
      if(Math.hypot(task.target.xMm-task.from.xMm,task.target.zMm-task.from.zMm)>=CORNER_ROUTE_MIN_MM){task.stage='corner';task.corner={phase:'collect',obstacleCursor:0,points:[],work:0};this.rememberCornerDependencies(task,nav);}
      else this.startCoarse(task,nav);
      return;
    }
    if(task.stage==='corner'){this.cornerStep(task,nav);return;}
    if(task.stage==='coarse'){this.coarseStep(task,nav);return;}
    if(task.stage==='fine')this.fineStep(task,nav);
  }
  private startCoarse(task:Task,nav:Navigation):void {
    delete task.corner;this.expandedConnectors.delete(task);task.stage='coarse';task.starts=this.connectors(task.from,nav,task.radiusMm);task.ends=this.connectors(task.target,nav,task.radiusMm);
    if(!task.starts.length)task.startBridge=createEndpointConnectorSearch(nav,task.from,task.radiusMm);
    if(!task.ends.length)task.endBridge=createEndpointConnectorSearch(nav,task.target,task.radiusMm);
    this.expandedConnectorRegions(task,undefined,nav);
  }
  private deferCoarsePreparation(task:Task):void{
    this.pathCensus?.invalidated(task.unitId);
    this.sharedJobs.cancel(task.unitId);
    delete task.corner;task.stage='coarse';task.starts=[];task.ends=[];task.prepareEndpoints=true;
    delete task.startBridge;delete task.endBridge;delete task.startRoutes;delete task.endRoutes;this.expandedConnectors.delete(task);
    delete task.startComponents;delete task.endComponents;delete task.coarse;delete task.fine;delete task.currentComponent;delete task.edgeCursor;
    delete task.corridor;delete task.currentCell;delete task.neighborCursor;delete task.cacheKey;delete task.lateCacheChecked;delete task.endJoinChecked;delete task.result;
    this.corridorKeyCache.delete(task);this.endpointKeyCache.delete(task);
    this.pathCensus?.requested(task,false);this.pathCensus?.progressed(task);
  }
  /** Keep search branches whose parent proof never touched an edited component.
   * Components in edited regions may be relabelled, so discard them and every
   * dependent descendant. Reopen the retained boundary to find new/changed edges;
   * an obstacle removal must be considered even if its old region was rejected.
   * No geometry queries or uncharged path expansion happen during invalidation. */
  private repairCoarseFrontier(task:Pick<Task,'coarse'|'currentComponent'|'edgeCursor'|'target'>,changed:ReadonlySet<string>):void{
    const state=task.coarse!,removed=new Set<SearchKey>(),children=new Map<SearchKey,SearchKey[]>();
    for(const [key,parent]of state.parents){const values=children.get(parent)??[];values.push(key);children.set(parent,values);}
    for(const key of state.scores.keys())if(changed.has(componentRegionText(key)))removed.add(key);
    const queue=[...removed];for(let index=0;index<queue.length;index++)for(const child of children.get(queue[index]!)??[])if(!removed.has(child)){removed.add(child);queue.push(child);}
    const affectedRegions=new Set(changed);for(const key of removed)affectedRegions.add(componentRegionText(key));
    const reopen=new Set<SearchKey>();
    for(const key of state.scores.keys())if(!removed.has(key)){
      const [x,z]=componentCoordinates(key);
      if(directions.some(([dx,dz])=>affectedRegions.has(`${x+dx},${z+dz}`)))reopen.add(key);
    }
    if(!removed.size&&!reopen.size)return;
    for(const key of removed){state.scores.delete(key);state.parents.delete(key);state.closed.delete(key);}
    const retained=state.heap.filter(item=>!removed.has(item.key)&&!reopen.has(item.key));state.heap=[];
    for(const item of retained)heapPush(state.heap,item);
    for(const key of reopen){state.closed.delete(key);const [x,z]=componentCoordinates(key);heapPush(state.heap,{key,score:state.scores.get(key)!+this.estimate({xMm:(x+.5)*SIDE*CELL,zMm:(z+.5)*SIDE*CELL},task.target)/SIDE});}
    if(task.currentComponent!==undefined&&(removed.has(task.currentComponent)||reopen.has(task.currentComponent))){delete task.currentComponent;delete task.edgeCursor;}
  }
  /** One bounded source inspection (four free checks), frontier selection or
   * <=4m exact sweep
   * per existing credit. Never builds a visibility graph in one scheduler turn. */
  private cornerStep(task:Task,nav:Navigation):void {
    const state=task.corner!;
    if(state.work>=CORNER_WORK_LIMIT){this.startCoarse(task,nav);return;}state.work++;
    if(state.phase==='collect'){
      if(state.obstacleCursor<Math.min(nav.obstacles.length,CORNER_OBSTACLE_LIMIT)){
        cornerCandidates(task,state.points,nav.obstacles[state.obstacleCursor++]!,nav);this.rememberCornerDependencies(task,nav);return;
      }
      if(!state.points.length){this.startCoarse(task,nav);return;}
      state.phase='search';state.points=[{...task.from},{...task.target},...state.points];state.scores=state.points.map((_,index)=>index?null:0);state.parents=state.points.map(()=>-1);state.closed=state.points.map(()=>false);state.edgeCursor=0;state.sweepStep=0;state.sweepSteps=0;this.rememberCornerDependencies(task,nav);return;
    }
    const {points,scores,parents,closed}=state;
    if(state.current===undefined){
      let current=-1,best=Infinity;
      for(let index=0;index<points.length;index++)if(!closed![index]&&scores![index]!==null){const point=points[index]!,estimate=scores![index]!+Math.hypot(point.xMm-task.target.xMm,point.zMm-task.target.zMm);if(estimate<best){best=estimate;current=index;}}
      if(current<0){this.startCoarse(task,nav);return;}
      if(current===1){
        this.finishCornerRoute(task,nav);return;
      }
      state.current=current;closed![current]=true;state.edgeCursor=0;return;
    }
    const current=state.current,edge=state.edgeCursor!;
    if(edge>=points.length){delete state.current;return;}
    const from=points[current]!,target=points[edge]!,score=scores![current]!+Math.hypot(target.xMm-from.xMm,target.zMm-from.zMm);
    const nextEdge=()=>{state.edgeCursor!++;state.sweepStep=0;state.sweepSteps=0;};
    // The initial direct sweep already proved this one edge blocked.
    if(closed![edge]||current===0&&edge===1||scores![edge]!==null&&score>=scores![edge]!){nextEdge();return;}
    state.sweepSteps||=Math.max(1,Math.ceil(Math.hypot(target.xMm-from.xMm,target.zMm-from.zMm)/CORNER_SWEEP_MM));
    const before=state.sweepStep!/state.sweepSteps,ratio=(state.sweepStep!+1)/state.sweepSteps;
    const prior={xMm:from.xMm+(target.xMm-from.xMm)*before,zMm:from.zMm+(target.zMm-from.zMm)*before},point={xMm:from.xMm+(target.xMm-from.xMm)*ratio,zMm:from.zMm+(target.zMm-from.zMm)*ratio};
    if(!nav.clearLine(prior,point,task.radiusMm)){nextEdge();return;}
    state.sweepStep=state.sweepStep!+1;
    if(state.sweepStep===state.sweepSteps){scores![edge]=score;parents![edge]=current;if(edge===1){this.finishCornerRoute(task,nav);return;}nextEdge();}
  }
  private finishCornerRoute(task:Task,nav:Navigation):void {
    const state=task.corner!,route:Position[]=[];for(let index=1;index!==0;index=state.parents![index]!)route.push({...state.points[index]!});route.reverse();
    const regions=new Set<string>();let previous=task.from;for(const point of route){addConnectorRegions(regions,previous,point,task.radiusMm,nav);previous=point;}task.corridor=[...regions];
    this.finish(task,route,false);
  }
  private coarseStep(task:Task,nav:Navigation):void {
    if(task.prepareEndpoints){delete task.prepareEndpoints;this.startCoarse(task,nav);return;}
    if(!task.coarse){
      for(const side of ['start','end'] as const){
        const bridge=side==='start'?task.startBridge:task.endBridge;if(!bridge)continue;
        const endpoint=side==='start'?task.from:task.target;
        if(bridge.cursor<bridge.queue.length){advanceEndpointConnectorSearch(bridge,nav,endpoint,task.radiusMm,CELL);return;}
        const routes=endpointConnectorRoutes(bridge,nav,endpoint,CELL);if(!routes.length){this.finish(task);return;}
        if(side==='start'){task.startRoutes=routes;task.starts=routes.map(route=>route.cell);delete task.startBridge;}else{task.endRoutes=routes;task.ends=routes.map(route=>route.cell);delete task.endBridge;}
        this.expandedConnectors.delete(task);return;
      }
      for(const cell of [...task.starts!,...task.ends!]){const region=this.region(task,this.point(cell,nav,task.radiusMm));if(!region.complete){this.buildRegion(region,nav);return;}}
      task.startComponents=[...new Set(task.starts!.map(cell=>this.component(task,this.point(cell,nav,task.radiusMm))!).filter(key=>key!=='').map(componentText))];task.endComponents=[...new Set(task.ends!.map(cell=>this.component(task,this.point(cell,nav,task.radiusMm))!).filter(key=>key!=='').map(componentText))];
      if(!task.startComponents.length||!task.endComponents.length){this.finish(task);return;}
      // Key the component sets canonically, retaining their search insertion order.
      task.cacheKey=`${task.profile}:${task.radiusMm}:${[...task.startComponents].sort().join(';')}:${[...task.endComponents].sort().join(';')}`;
      const cached=this.cachedRoute(task);
      if(cached&&this.reuseRoute(task,nav,cached))return;
      task.coarse=search();for(const text of task.startComponents){const key=componentFromText(text);task.coarse.scores.set(key,0);heapPush(task.coarse.heap,{key,score:0});}this.considerShared(task,nav);return;
    }
    const result=this.advanceCoarse(task as SharedCoarseFrontier,nav);
    if(result.status==='blocked')this.finish(task);
    else if(result.status==='ready'){
      this.sharedJobs.cancel(task.unitId);
      task.corridor=[...new Set(result.chain.map(componentRegion))];task.stage='fine';task.fine=search();
      for(const cell of task.starts!){const key=cellKey(cell),point=this.point(cell,nav,task.radiusMm),route=task.startRoutes?.find(route=>route.cell===cell),cost=(route?connectorRouteLength(task.from,route.points):Math.hypot(point.xMm-task.from.xMm,point.zMm-task.from.zMm))/CELL;task.fine.scores.set(key,cost);heapPush(task.fine.heap,{key,score:cost+this.estimate(point,task.target)},task.target,Math.floor(nav.widthMm/CELL));}
    }
  }
  private advanceCoarse(task:SharedCoarseFrontier,nav:Navigation):SharedCoarseStep{
    const state=task.coarse;
    if(task.currentComponent===undefined){
      let next:HeapItem|undefined;do{next=heapPop(state.heap);}while(next&&state.closed.get(next.key));
      if(!next)return {status:'blocked'};
      if(this.endpointKeys(task)[1].includes(next.key)){
        const chain:string[]=[];let cursor=next.key;for(;;){chain.push(componentText(cursor));const parent=state.parents.get(cursor);if(parent===undefined||parent==='')break;cursor=parent;}return {status:'ready',chain:chain.reverse()};
      }
      state.closed.set(next.key,true);task.currentComponent=next.key;task.edgeCursor=0;
    }
    const [rx,rz,label]=componentCoordinates(task.currentComponent),region=this.region(task,{xMm:rx*SIDE*CELL,zMm:rz*SIDE*CELL});
    const edge=task.edgeCursor!,side=Math.floor(edge/SIDE),offset=edge%SIDE,lx=side===0?offset:side===1?0:side===2?SIDE-1:offset,lz=side===0?0:side===1?offset:side===2?offset:SIDE-1;
    const from={xMm:(rx*SIDE+lx)*CELL,zMm:(rz*SIDE+lz)*CELL},[dx,dz]=directions[side]!,to={xMm:from.xMm+dx*CELL,zMm:from.zMm+dz*CELL};
    if(region.labels[lz*SIDE+lx]===label&&to.xMm>=0&&to.zMm>=0&&to.xMm<nav.widthMm&&to.zMm<nav.heightMm){
      const neighbor=this.region(task,to);if(!neighbor.complete){this.buildRegion(neighbor,nav);return {status:'pending'};}
      const key=this.component(task,to)!;
      if(key!==''&&!state.closed.get(key)&&nav.clearLine(from,to,task.radiusMm)){const score=state.scores.get(task.currentComponent)!+1;if(score<(state.scores.get(key)??Infinity)){state.scores.set(key,score);state.parents.set(key,task.currentComponent);heapPush(state.heap,{key,score:score+this.estimate({xMm:(neighbor.x+.5)*SIDE*CELL,zMm:(neighbor.z+.5)*SIDE*CELL},task.target)/SIDE});}}
    }
    if(++task.edgeCursor!>=SIDE*4){delete task.currentComponent;delete task.edgeCursor;}
    return {status:'pending'};
  }
  private estimate(point:Position,target:Position):number{return estimate(point.xMm,point.zMm,target);}
  private fineStep(task:Task,nav:Navigation):void {
    const state=task.fine!,width=Math.floor(nav.widthMm/CELL),height=Math.floor(nav.heightMm/CELL);
    if(task.currentCell===undefined){
      // Peers may finish after this request entered fine search. Spend one
      // scheduled step testing that complete route, once an entry actually exists.
      // A failed connector is not retried on every expanded cell or after restore.
      if(!task.lateCacheChecked&&task.cacheKey){const cached=this.cachedRoute(task);if(cached){task.lateCacheChecked=true;this.reuseRoute(task,nav,cached);return;}}
      // This independent, one-shot decision cannot suppress a later exact or
      // intersecting-component match. An empty capped prefix is still a decision.
      if(!task.endJoinChecked&&task.cacheKey){const candidate=this.endJoinRoute(task);if(candidate.matched){task.endJoinChecked=true;if(candidate.route)this.reuseRoute(task,nav,candidate.route,true,candidate.pointIndex);return;}}
      let item:HeapItem|undefined;do{item=heapPop(state.heap,task.target,width);}while(item&&state.closed.get(item.key));
      if(!item){this.finish(task);return;}
      const cell=Number(item.key);
      if(task.ends!.includes(cell)){
        const cells:number[]=[cell];let cursor=item.key;while(state.parents.get(cursor)!==undefined){cursor=state.parents.get(cursor)!;cells.push(Number(cursor));}cells.reverse();
        const startRoute=task.startRoutes?.find(route=>route.cell===cells[0]),endRoute=task.endRoutes?.find(route=>route.cell===cell),points:Position[]=[];for(let i=0;i<cells.length;i++){const point=this.point(cells[i]!,nav,task.radiusMm),previous=i?this.point(cells[i-1]!,nav,task.radiusMm):task.from,next=i+1<cells.length?this.point(cells[i+1]!,nav,task.radiusMm):task.target;if(i===0||i===cells.length-1||(point.xMm-previous.xMm)*(next.zMm-point.zMm)!==(point.zMm-previous.zMm)*(next.xMm-point.xMm))points.push(point);}
        if(startRoute)points.unshift(...startRoute.points.slice(0,-1));if(endRoute)points.push(...endRoute.points.slice(0,-1).reverse());points.push({...task.target});this.finish(task,points);return;
      }
      state.closed.set(item.key,true);task.currentCell=cell;task.neighborCursor=0;
    }
    const cell=task.currentCell!,point=this.point(cell,nav,task.radiusMm),[dx,dz]=directions[task.neighborCursor!]!,x=cell%width+dx,z=Math.floor(cell/width)+dz,next=z*width+x,key=cellKey(next);
    if(x>=0&&z>=0&&x<width&&z<height&&!state.closed.get(key)&&this.corridorKeys(task).has(regionKey(Math.floor(x/SIDE),Math.floor(z/SIDE)))){
      const target=this.point(next,nav,task.radiusMm);if(nav.free(target,task.radiusMm)&&nav.clearLine(point,target,task.radiusMm)){const current=cellKey(cell),score=state.scores.get(current)!+1;if(score<(state.scores.get(key)??Infinity)){state.scores.set(key,score);state.parents.set(key,current);heapPush(state.heap,{key,score:score+this.estimate(target,task.target)},task.target,width);}}
    }
    if(++task.neighborCursor!>=4){delete task.currentCell;delete task.neighborCursor;}
  }
}
