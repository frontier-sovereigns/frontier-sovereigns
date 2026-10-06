import type { Position } from '@frontier/shared';
import type { PathRequest, PathSchedulerState, PathWorkClass } from './path-scheduler.js';
import { componentCoordinates, componentFromText, componentText, componentRegionText, exportPathSearch, importPathSearch, type SearchKey, type PathSearch } from './path-search-keys.js';

type Task = PathSchedulerState['tasks'][number];
/** Independent coarse owner. It deliberately has no unit/request ID or fine search. */
export interface SharedCoarseFrontier {
  profile: string; radiusMm: number; from: Position; target: Position;
  starts: number[]; ends: number[]; startComponents: string[]; endComponents: string[];
  coarse: PathSearch; currentComponent?: SearchKey; edgeCursor?: number;
}
export interface SavedSharedCoarseFrontier extends Omit<SharedCoarseFrontier,'coarse'|'currentComponent'> {coarse:NonNullable<Task['coarse']>;currentComponent?:string}
type FrontierInput=SharedCoarseFrontier|SavedSharedCoarseFrontier;
function exportFrontier(frontier:SharedCoarseFrontier):SavedSharedCoarseFrontier {const saved={...frontier,coarse:exportPathSearch(frontier.coarse,true)} as SavedSharedCoarseFrontier;if(frontier.currentComponent!==undefined)saved.currentComponent=componentText(frontier.currentComponent);return saved;}
function importFrontier(saved:SavedSharedCoarseFrontier):SharedCoarseFrontier {const frontier={...saved,coarse:importPathSearch(saved.coarse,true)} as SharedCoarseFrontier;if(saved.currentComponent!==undefined)frontier.currentComponent=componentFromText(saved.currentComponent);return frontier;}
export interface SharedPathMember {
  request: PathRequest; geometryRevision: number; widthMm: number; heightMm: number;
  startComponents: string[]; endComponents: string[]; connectorRegions: string[];
}
export interface SharedPathJobState {
  id: string; key: string; frontier: SavedSharedCoarseFrontier; geometryRevision: number;
  widthMm: number; heightMm: number; members: SharedPathMember[]; dependencies: string[];
}
export interface SharedPathJobsState { version: 1; serials: Record<string, number>; waiting: SharedPathMember[]; jobs: SharedPathJobState[] }
export type SharedCoarseStep = { status: 'pending' } | { status: 'blocked' } | { status: 'ready'; chain: string[] };
export type SharedJobCompletion = { status: 'pending' } | { status: 'restart' | 'blocked'; members: SharedPathMember[] } | { status: 'ready'; members: SharedPathMember[]; chain: string[] };
export interface SharedPathService { id: string; profile: string; workClass: PathWorkClass; enqueuedTick: number }
interface Job { id: string; key: string; frontier: SharedCoarseFrontier; geometryRevision: number; widthMm: number; heightMm: number; members: Map<string, SharedPathMember>; dependencies: Set<string>; dependencyList?: readonly string[] }
export interface SharedPathJobLimits { jobsPerProfile: number; membersPerJob: number; dependenciesPerJob: number; waiting: number }
const MAX: SharedPathJobLimits = { jobsPerProfile: 64, membersPerJob: 32, dependenciesPerJob: 4096, waiting: 2200 };
const componentPattern = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/;
const regionPattern = /^(0|[1-9][0-9]*),(0|[1-9][0-9]*)$/;
const canonical = (values: readonly string[]) => [...new Set(values)].sort();
const regionOf = (component: string) => component.slice(0, component.lastIndexOf(','));
const identity = (member: SharedPathMember) => JSON.stringify([member.request.profile, member.request.radiusMm, member.geometryRevision, member.widthMm, member.heightMm, canonical(member.startComponents), canonical(member.endComponents)]);
const priority = (member: SharedPathMember, tick: number): PathWorkClass => member.request.workClass === 'routine' && tick - member.request.enqueuedTick! >= 40 ? 'interactive' : member.request.workClass ?? 'interactive';
const rank = { optional: 0, routine: 1, interactive: 2 };
const samePosition = (a: Position, b: Position) => a.xMm === b.xMm && a.zMm === b.zMm;
const sameComponents = (a: readonly string[], b: readonly string[]) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function matchesMember(frontier: FrontierInput | undefined, member: SharedPathMember): frontier is FrontierInput {
  return !!frontier && frontier.profile === member.request.profile && frontier.radiusMm === member.request.radiusMm
    && samePosition(frontier.from, member.request.from) && samePosition(frontier.target, member.request.target)
    && sameComponents(frontier.startComponents, member.startComponents) && sameComponents(frontier.endComponents, member.endComponents);
}
function validRegion(value: string, widthMm: number, heightMm: number): boolean {
  if (!regionPattern.test(value)) return false; const [x,z] = value.split(',').map(Number);
  return x! < Math.ceil(widthMm / 16000) && z! < Math.ceil(heightMm / 16000);
}
/** Save-only semantic validation. Ordinary service does not walk its existing heap. */
function validateFrontier(frontier: SavedSharedCoarseFrontier, widthMm: number, heightMm: number): void {
  const invalid = (): never => { throw new Error('INVALID_SHARED_PATH_FRONTIER'); };
  const component = (key: string) => componentPattern.test(key) && validRegion(regionOf(key), widthMm, heightMm) && Number(key.slice(key.lastIndexOf(',') + 1)) < 256;
  const position = (point: Position) => Number.isSafeInteger(point.xMm) && Number.isSafeInteger(point.zMm) && point.xMm >= 0 && point.zMm >= 0 && point.xMm <= widthMm && point.zMm <= heightMm;
  const cells = (values: number[]) => values.length > 0 && values.length <= 9 && new Set(values).size === values.length && values.every(cell => Number.isSafeInteger(cell) && cell >= 0 && cell < Math.floor(widthMm / 1000) * Math.floor(heightMm / 1000));
  if (!position(frontier.from) || !position(frontier.target) || !Number.isFinite(frontier.radiusMm) || frontier.radiusMm <= 0 || frontier.radiusMm > 10000 || !cells(frontier.starts) || !cells(frontier.ends)
    || !frontier.startComponents.length || frontier.startComponents.length > 9 || new Set(frontier.startComponents).size !== frontier.startComponents.length || frontier.endComponents.length !== 1 || ![...frontier.startComponents,...frontier.endComponents].every(component)) invalid();
  const search = frontier.coarse, scores = Object.entries(search.scores), parents = Object.entries(search.parents), closed = Object.entries(search.closed);
  if (scores.length > 409600 || parents.length > 409600 || closed.length > 409600 || search.heap.length > 1638400) invalid();
  const hasScore = (key: string) => Object.hasOwn(search.scores, key);
  for (const [key, score] of scores) if (!component(key) || !Number.isFinite(score) || score < 0 || score > Number.MAX_SAFE_INTEGER) invalid();
  for (const start of frontier.startComponents) if (search.scores[start] !== 0 || Object.hasOwn(search.parents, start)) invalid();
  for (const [child, parent] of parents) if (!component(child) || !component(parent) || !hasScore(child) || !hasScore(parent) || search.scores[child]! <= search.scores[parent]!) invalid();
  // A strict increase along parent edges excludes cycles. Every scored root must
  // originate at one of the proved start components, not an injected island.
  for (const [key] of scores) if (!Object.hasOwn(search.parents, key) && !frontier.startComponents.includes(key)) invalid();
  for (const [key, value] of closed) if (!component(key) || !hasScore(key) || value !== true) invalid();
  for (let index = 0; index < search.heap.length; index++) {
    const item = search.heap[index]!; if (!component(item.key) || !hasScore(item.key) || !Number.isFinite(item.score) || item.score < 0) invalid();
    if (index) { const parent = search.heap[(index - 1) >> 1]!; if (parent.score > item.score || parent.score === item.score && parent.key > item.key) invalid(); }
  }
  if ((frontier.currentComponent === undefined) !== (frontier.edgeCursor === undefined) || frontier.currentComponent !== undefined && (!component(frontier.currentComponent) || search.closed[frontier.currentComponent] !== true || !Number.isSafeInteger(frontier.edgeCursor) || frontier.edgeCursor! < 0 || frontier.edgeCursor! >= 64)) invalid();
}

/** Event-driven admission. Ordinary task stepping installs no wrappers or region hooks.
 * A scheduler calls consider only when a request has proved its coarse endpoints;
 * while hasJobs is false it keeps its original service loop unchanged.
 * The adapter returns a live candidate's frontier only after checking its request
 * ID/order revision and geometry. The registry clones it only upon admission. */
export class SharedPathJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, Set<string>>();
  private readonly byMember = new Map<string, string>();
  private readonly waiting = new Map<string, SharedPathMember>();
  private readonly waitingKeys = new Map<string, Set<string>>();
  private serials: Record<string, number> = {};
  readonly limits: SharedPathJobLimits;
  constructor(private readonly frontierFor: (member: SharedPathMember) => FrontierInput | undefined, limits: Partial<SharedPathJobLimits> = {}) {
    this.limits = { ...MAX, ...limits };
    for (const name of Object.keys(MAX) as (keyof SharedPathJobLimits)[]) if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1 || this.limits[name] > MAX[name]) throw new Error('INVALID_SHARED_PATH_LIMIT');
    if (this.limits.membersPerJob < 2) throw new Error('INVALID_SHARED_PATH_LIMIT');
  }
  get hasJobs(): boolean { return this.jobs.size > 0; }
  isMember(unitId: string): boolean { return this.byMember.has(unitId); }
  dependencies(unitId: string): readonly string[] | undefined {
    const id = this.byMember.get(unitId); if (id === undefined) return;
    const job = this.jobs.get(id)!; return job.dependencyList ??= Object.freeze([...job.dependencies]);
  }
  inventory() { return { jobs: this.jobs.size, members: this.byMember.size, waiting: this.waiting.size }; }
  private eligible(member: SharedPathMember): boolean {
    const request = member.request;
    return [request.id, request.unitId, request.profile].every(value => typeof value === 'string' && value.length > 0 && value.length <= 96) && request.radiusMm > 0 && request.radiusMm <= 10000
      && Number.isSafeInteger(request.orderRevision) && request.orderRevision >= 0
      && (request.workClass === undefined ? request.enqueuedTick === undefined : ['interactive', 'routine', 'optional'].includes(request.workClass) && Number.isSafeInteger(request.enqueuedTick) && request.enqueuedTick! >= 0)
      && [request.from.xMm, request.from.zMm, request.target.xMm, request.target.zMm, member.geometryRevision].every(value => Number.isSafeInteger(value) && value >= 0)
      && [member.widthMm, member.heightMm].every(value => Number.isSafeInteger(value) && value > 0 && value <= 640000)
      && member.startComponents.length > 0 && member.startComponents.length <= 9 && member.endComponents.length === 1
      && [...member.startComponents, ...member.endComponents].every(value => componentPattern.test(value))
      && member.connectorRegions.length <= this.limits.dependenciesPerJob && member.connectorRegions.every(value => validRegion(value, member.widthMm, member.heightMm));
  }
  private forgetWaiting(unitId: string): void {
    const member = this.waiting.get(unitId); if (!member) return;
    const key = identity(member), group = this.waitingKeys.get(key); group?.delete(unitId); if (!group?.size) this.waitingKeys.delete(key);
    this.waiting.delete(unitId);
  }
  private wait(member: SharedPathMember): void {
    if (this.waiting.size >= this.limits.waiting) return;
    const key = identity(member); this.waiting.set(member.request.unitId, member);
    let group = this.waitingKeys.get(key); if (!group) { group = new Set(); this.waitingKeys.set(key, group); }
    group.add(member.request.unitId);
  }
  private addHalo(dependencies: Set<string>, component: SearchKey, widthMm: number, heightMm: number): void {
    const [rx, rz] = componentCoordinates(component);
    for (let z = Math.max(0, rz! - 1); z <= Math.min(Math.ceil(heightMm / 16000) - 1, rz! + 1); z++)
      for (let x = Math.max(0, rx! - 1); x <= Math.min(Math.ceil(widthMm / 16000) - 1, rx! + 1); x++) dependencies.add(`${x},${z}`);
  }
  private seedDependencies(frontier: SharedCoarseFrontier, members: readonly SharedPathMember[], widthMm: number, heightMm: number): Set<string> {
    const result = new Set(members.flatMap(member => member.connectorRegions));
    // Include earlier rejected border tests as well as accepted/scored regions.
    for (const component of new Set([...frontier.startComponents.map(componentFromText), ...frontier.endComponents.map(componentFromText), ...frontier.coarse.closed.keys(), ...(frontier.currentComponent !== undefined ? [frontier.currentComponent] : [])])) this.addHalo(result, component, widthMm, heightMm);
    for (const component of frontier.coarse.scores.keys()) result.add(componentRegionText(component));
    return result;
  }
  private track(job: Job): void {
    this.jobs.set(job.id, job); let group = this.byKey.get(job.key); if (!group) { group = new Set(); this.byKey.set(job.key, group); } group.add(job.id);
    for (const id of job.members.keys()) this.byMember.set(id, job.id);
  }
  private erase(job: Job): SharedPathMember[] {
    this.jobs.delete(job.id); const group = this.byKey.get(job.key); group?.delete(job.id); if (!group?.size) this.byKey.delete(job.key);
    for (const id of job.members.keys()) this.byMember.delete(id);
    return [...job.members.values()];
  }
  /** Returns newly admitted IDs so the scheduler can remove their individual coarse service positions. */
  consider(input: SharedPathMember): string[] {
    if (this.byMember.has(input.request.unitId)) return [];
    this.forgetWaiting(input.request.unitId);
    if (this.byMember.size + this.waiting.size >= MAX.waiting) return [];
    if (!this.eligible(input)) return [];
    const member = structuredClone(input), key = identity(member);
    if (!matchesMember(this.frontierFor(member), member)) return [];
    for (const id of this.byKey.get(key) ?? []) {
      const job = this.jobs.get(id)!; if (job.members.size >= this.limits.membersPerJob) continue;
      const dependencies = new Set([...job.dependencies, ...member.connectorRegions]);
      if (dependencies.size > this.limits.dependenciesPerJob) continue;
      job.members.set(member.request.unitId, member); job.dependencies = dependencies; delete job.dependencyList; this.byMember.set(member.request.unitId, job.id);
      return [member.request.unitId];
    }
    if ([...this.jobs.values()].filter(job => job.frontier.profile === member.request.profile).length >= this.limits.jobsPerProfile) { this.wait(member); return []; }
    for (const unitId of this.waitingKeys.get(key) ?? []) {
      const prior = this.waiting.get(unitId)!, input = this.frontierFor(prior);
      if (!matchesMember(input, prior)) { this.forgetWaiting(unitId); continue; }
      // Saved-frontier callbacks are used by the cold save validator. Runtime
      // scheduler callbacks already own numeric Maps; service never converts.
      const frontier=input.coarse.scores instanceof Map?input as SharedCoarseFrontier:importFrontier(input as SavedSharedCoarseFrontier);
      const dependencies = this.seedDependencies(frontier, [prior, member], member.widthMm, member.heightMm);
      if (dependencies.size > this.limits.dependenciesPerJob) continue;
      const serial = (this.serials[member.request.profile] ?? 0) + 1;
      if (!Number.isSafeInteger(serial)) throw new Error('SHARED_PATH_JOB_ID_LIMIT');
      this.serials[member.request.profile] = serial;
      const job: Job = { id: `${member.request.profile}:${serial}`, key, frontier: structuredClone(frontier), geometryRevision: member.geometryRevision, widthMm: member.widthMm, heightMm: member.heightMm,
        members: new Map([[unitId, prior], [member.request.unitId, member]]), dependencies };
      this.forgetWaiting(unitId); this.track(job); return [...job.members.keys()];
    }
    this.wait(member); return [];
  }
  /** A job survives cancellation of its founding member; no unit owns its frontier. */
  cancel(unitId: string): void {
    this.forgetWaiting(unitId); const jobId = this.byMember.get(unitId); if (jobId === undefined) return;
    const job = this.jobs.get(jobId)!; this.byMember.delete(unitId); job.members.delete(unitId); if (!job.members.size) this.erase(job);
  }
  services(profile: string, tick: number): SharedPathService[] {
    const result: SharedPathService[] = [];
    for (const job of this.jobs.values()) if (job.frontier.profile === profile) {
      let workClass: PathWorkClass = 'optional', enqueuedTick = Number.MAX_SAFE_INTEGER;
      for (const member of job.members.values()) {
        const current = priority(member, tick), since = member.request.enqueuedTick ?? 0;
        if (rank[current] > rank[workClass]) { workClass = current; enqueuedTick = since; }
        else if (current === workClass) enqueuedTick = Math.min(enqueuedTick, since);
      }
      result.push({ id: job.id, profile, workClass, enqueuedTick });
    }
    return result;
  }
  /** Exactly one caller-granted work credit advances exactly one independent job. */
  advance(id: string, step: (frontier: SharedCoarseFrontier) => SharedCoarseStep): SharedJobCompletion {
    const job = this.jobs.get(id); if (!job) throw new Error('UNKNOWN_SHARED_PATH_JOB');
    const previous = job.frontier.currentComponent, previousDependencyCount = job.dependencies.size, result = step(job.frontier);
    // One bounded halo on entry to a component covers its rejected neighbor tests.
    if (job.frontier.currentComponent !== undefined && job.frontier.currentComponent !== previous) this.addHalo(job.dependencies, job.frontier.currentComponent, job.widthMm, job.heightMm);
    if (previousDependencyCount !== job.dependencies.size) delete job.dependencyList;
    if (job.dependencies.size > this.limits.dependenciesPerJob) return { status: 'restart', members: this.erase(job) };
    if (result.status === 'pending') return result;
    if (result.status === 'blocked') return { status: 'blocked', members: this.erase(job) };
    if (!result.chain.length || result.chain.length > 409600 || !job.frontier.startComponents.includes(result.chain[0]!) || !job.frontier.endComponents.includes(result.chain.at(-1)!) || new Set(result.chain).size !== result.chain.length || result.chain.some(component => !componentPattern.test(component))) throw new Error('INVALID_SHARED_PATH_CHAIN');
    return { status: 'ready', members: this.erase(job), chain: [...result.chain] };
  }
  /** Endpoint/connector edits require fresh proofs. Other edits can repair the
   * independent frontier without throwing away every subscriber's paid work.
   * The scheduler's repair removes changed components and dependent descendants,
   * then reopens retained boundaries; it never trusts old labels in edited regions. */
  invalidate(profile: string, changedRegions: ReadonlySet<string>, repair?: { geometryRevision: number; frontier: (frontier: SharedCoarseFrontier) => void }): SharedPathMember[] {
    for (const [id, member] of this.waiting) if (member.request.profile === profile) this.forgetWaiting(id);
    const restart: SharedPathMember[] = [];
    for (const job of [...this.jobs.values()]) if (job.frontier.profile === profile) {
      const relevant = [...changedRegions].some(region => job.dependencies.has(region));
      if (relevant && (!repair || [...job.frontier.startComponents, ...job.frontier.endComponents].some(component => changedRegions.has(regionOf(component)))
        || [...job.members.values()].some(member => member.connectorRegions.some(region => changedRegions.has(region))))) {
        restart.push(...this.erase(job)); continue;
      }
      if (relevant) {
        repair!.frontier(job.frontier);
        job.dependencies = this.seedDependencies(job.frontier, [...job.members.values()], job.widthMm, job.heightMm); delete job.dependencyList;
      }
      if (repair) {
        // Endpoints remain proved and the retained frontier now describes the
        // current graph. Rebind admission identity so new compatible requests
        // can join it rather than duplicating this search after every tree edit.
        const previous = this.byKey.get(job.key)!; previous.delete(job.id); if (!previous.size) this.byKey.delete(job.key);
        job.geometryRevision = repair.geometryRevision;
        for (const member of job.members.values()) member.geometryRevision = repair.geometryRevision;
        job.key = identity(job.members.values().next().value!);
        let group = this.byKey.get(job.key); if (!group) { group = new Set(); this.byKey.set(job.key, group); } group.add(job.id);
      }
    }
    return restart;
  }
  exportState(): SharedPathJobsState {
    const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    return structuredClone({ version: 1, serials: Object.fromEntries(Object.entries(this.serials).sort(([a],[b])=>compare(a,b))), waiting: [...this.waiting.values()].sort((a,b)=>compare(a.request.profile,b.request.profile)), jobs: [...this.jobs.values()].sort((a,b)=>compare(a.frontier.profile,b.frontier.profile)).map(job => ({ id: job.id, key: job.key, frontier: exportFrontier(job.frontier), geometryRevision: job.geometryRevision, widthMm: job.widthMm, heightMm: job.heightMm, members: [...job.members.values()], dependencies: [...job.dependencies] })) });
  }
  /** Called only after the strict enclosing save decoder; still check ownership and cross references. */
  importState(state: SharedPathJobsState): void {
    if (state.version !== 1 || !state.serials || Object.keys(state.serials).length > 11 || Object.values(state.serials).some(serial => !Number.isSafeInteger(serial) || serial < 0) || state.waiting.length > this.limits.waiting || state.jobs.length > 11 * this.limits.jobsPerProfile) throw new Error('INVALID_SHARED_PATH_STATE');
    const candidate = new SharedPathJobs(this.frontierFor, this.limits), members = new Set<string>(), counts = new Map<string, number>();
    candidate.serials = structuredClone(state.serials);
    for (const row of state.waiting) {
      if (!candidate.eligible(row) || members.has(row.request.unitId) || !matchesMember(this.frontierFor(row), row)) throw new Error('INVALID_SHARED_PATH_MEMBER');
      members.add(row.request.unitId); candidate.wait(structuredClone(row));
    }
    for (const row of state.jobs) {
      const count = (counts.get(row.frontier.profile) ?? 0) + 1; counts.set(row.frontier.profile, count);
      if (typeof row.id !== 'string') throw new Error('INVALID_SHARED_PATH_JOB');
      validateFrontier(row.frontier, row.widthMm, row.heightMm);
      const serial = Number(row.id.slice(row.frontier.profile.length + 1));
      if (typeof row.id !== 'string' || row.id !== `${row.frontier.profile}:${serial}` || !Number.isSafeInteger(serial) || serial < 1 || serial > (state.serials[row.frontier.profile] ?? 0) || candidate.jobs.has(row.id) || count > this.limits.jobsPerProfile || !row.members.length || row.members.length > this.limits.membersPerJob || row.dependencies.length > this.limits.dependenciesPerJob || new Set(row.dependencies).size !== row.dependencies.length || row.dependencies.some(region => !validRegion(region, row.widthMm, row.heightMm))) throw new Error('INVALID_SHARED_PATH_JOB');
      for (const member of row.members) {
        if (!candidate.eligible(member) || members.has(member.request.unitId) || identity(member) !== row.key || member.request.profile !== row.frontier.profile || member.request.radiusMm !== row.frontier.radiusMm || member.geometryRevision !== row.geometryRevision || member.widthMm !== row.widthMm || member.heightMm !== row.heightMm || !sameComponents(member.startComponents,row.frontier.startComponents) || !sameComponents(member.endComponents,row.frontier.endComponents) || !matchesMember(this.frontierFor(member), member)) throw new Error('INVALID_SHARED_PATH_MEMBER');
        members.add(member.request.unitId);
      }
      if (members.size > MAX.waiting) throw new Error('INVALID_SHARED_PATH_MEMBER');
      const frontier=importFrontier(structuredClone(row.frontier)),supplied = new Set(row.dependencies), required = candidate.seedDependencies(frontier, row.members, row.widthMm, row.heightMm);
      if ([...required].some(region => !supplied.has(region))) throw new Error('INVALID_SHARED_PATH_DEPENDENCIES');
      candidate.track({ ...structuredClone(row), frontier, members: new Map(row.members.map(member => [member.request.unitId, structuredClone(member)])), dependencies: new Set(row.dependencies) });
    }
    this.jobs.clear(); this.byKey.clear(); this.byMember.clear(); this.waiting.clear(); this.waitingKeys.clear(); this.serials = candidate.serials;
    for (const member of candidate.waiting.values()) this.wait(member); for (const job of candidate.jobs.values()) this.track(job);
  }
}
