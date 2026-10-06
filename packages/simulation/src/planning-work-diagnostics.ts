import type { PathDiagnosticClock } from './path-diagnostics.js';
import type { PathRequest } from './path-scheduler.js';

/** Private observation only: operation calls are NOT navigation-work charges. */
export const PLANNING_OPERATIONS = ['scheduler.step', 'scheduler.connectors', 'scheduler.region-fill', 'scheduler.cache-connectors', 'scheduler.end-join-scan', 'scheduler.finish', 'local.step', 'local.grant', 'local.neighbors', 'local.overlay', 'local.path'] as const;
type Operation = typeof PLANNING_OPERATIONS[number];
interface Context { profile?: string; unitId?: string; stage?: string }
interface Span { operation: Operation; start: number | null; childMs: number; context: Context; tick: number | null; depth: number; sequence: number }
interface Metric { calls: number; failures: number; measured: number; invalid: number; inclusiveMs: number; exclusiveMs: number; maxInclusiveMs: number }
const DEPTH_LIMIT = 16, LARGEST_LIMIT = 16, GROUP_LIMIT = 16;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, 160) : undefined;
const clean = (value: Context): Context => ({ profile: text(value.profile), unitId: text(value.unitId), stage: text(value.stage) });

/** Fixed operation set, bounded stack and slow-operation examples. No world refs. */
export class PlanningWorkCensus {
  private metrics = new Map<Operation, Metric>();
  private stack: Span[] = [];
  private largest: (Context & { operation: Operation; tick: number | null; ms: number; sequence: number })[] = [];
  private sequence = 0;
  private depthOmissions = 0;
  private largestOmissions = 0;
  private invalidClockReads = 0;
  private lastNow: number | undefined;
  private invalidNesting = 0;
  private operationOmissions = 0;
  private scheduledWork = { direct: 0, corner: 0, coarse: 0, fine: 0, done: 0, unknown: 0 };
  private profileWork = new Map<string, number>();
  private omittedProfileWork = 0;
  constructor(private readonly clock: PathDiagnosticClock) {}
  private now(): number | null { try { const value = this.clock.now(); if (Number.isFinite(value) && value >= 0 && (this.lastNow === undefined || value >= this.lastNow)) { this.lastNow = value; return value; } } catch {} this.invalidClockReads++; return null; }
  private tick(): number | null { try { const value = this.clock.tick(); if (Number.isSafeInteger(value) && value >= 0) return value; } catch {} this.invalidClockReads++; return null; }
  begin(operation: Operation, context?: Context): Span | undefined {
    if (!PLANNING_OPERATIONS.includes(operation)) { this.operationOmissions++; return; }
    let metric = this.metrics.get(operation);
    if (!metric) { metric = { calls: 0, failures: 0, measured: 0, invalid: 0, inclusiveMs: 0, exclusiveMs: 0, maxInclusiveMs: 0 }; this.metrics.set(operation, metric); }
    metric.calls++;
    if (this.stack.length >= DEPTH_LIMIT) { this.depthOmissions++; return; }
    const span: Span = { operation, start: this.now(), childMs: 0, context: clean(context ?? this.stack.at(-1)?.context ?? {}), tick: this.tick(), depth: this.stack.length, sequence: ++this.sequence };
    this.stack.push(span); return span;
  }
  end(span: Span | undefined): void {
    if (!span) return;
    if (this.stack.at(-1) !== span) { this.invalidNesting++; return; }
    this.stack.pop();
    const end = this.now(), metric = this.metrics.get(span.operation)!;
    if (span.start === null || end === null || end < span.start) { metric.invalid++; return; }
    const elapsed = end - span.start;
    metric.measured++; metric.inclusiveMs += elapsed; metric.exclusiveMs += Math.max(0, elapsed - span.childMs); metric.maxInclusiveMs = Math.max(metric.maxInclusiveMs, elapsed);
    const parent = this.stack.at(-1); if (parent) parent.childMs += elapsed;
    this.largest.push({ ...span.context, operation: span.operation, tick: span.tick, ms: elapsed, sequence: span.sequence });
    this.largest.sort((a, b) => b.ms - a.ms || a.sequence - b.sequence);
    if (this.largest.length > LARGEST_LIMIT) { this.largest.pop(); this.largestOmissions++; }
  }
  recordFailure(operation: Operation): void { const metric = this.metrics.get(operation); if (metric) metric.failures++; }
  measure<T>(operation: Operation, run: () => T, context?: Context): T {
    const span = this.begin(operation, context), before = span?.context ?? clean(context ?? {});
    try {
      const result = run();
      if (operation === 'scheduler.step') {
        const stage = before.stage === 'direct' || before.stage === 'corner' || before.stage === 'coarse' || before.stage === 'fine' || before.stage === 'done' ? before.stage : 'unknown';
        this.scheduledWork[stage]++;
        const profile = before.profile ?? '';
        if (this.profileWork.has(profile) || this.profileWork.size < 11) this.profileWork.set(profile, (this.profileWork.get(profile) ?? 0) + 1); else this.omittedProfileWork++;
      }
      return result;
    } catch (error) { this.recordFailure(operation); throw error; }
    finally { this.end(span); }
  }
  snapshot() {
    return { scope: 'host-private-opt-in' as const, timingQualificationEligible: false as const,
      accounting: 'Calls count actual hooked operations, not navigation work. scheduledWork counts successfully returned scheduler.step calls using their entry stage, matching existing charged scheduler units; thrown calls are failures. Inclusive durations overlap; exclusive durations subtract valid directly nested spans only. Invalid/depth-omitted spans cannot support a complete exclusive ledger. Instrumentation overhead remains in its enclosing phase.',
      unmeasured: ['query/bucket/obstacle work is supplied by the separate query-family census', 'local connector/heap/reconstruction/smoothing substeps remain inside local.path', 'scheduler fine route reconstruction remains inside scheduler.step'],
      limits: { operationKinds: PLANNING_OPERATIONS.length, nesting: DEPTH_LIMIT, largest: LARGEST_LIMIT, profiles: 11 },
      scheduledWork: { total: Object.values(this.scheduledWork).reduce((a, b) => a + b, 0), byStage: { ...this.scheduledWork }, byProfile: Object.fromEntries(this.profileWork), omittedProfileWork: this.omittedProfileWork },
      operations: Object.fromEntries([...this.metrics].map(([key, value]) => [key, { ...value }])),
      largest: this.largest.map(value => ({ ...value })), depthOmissions: this.depthOmissions, largestOmissions: this.largestOmissions, operationOmissions: this.operationOmissions, invalidClockReads: this.invalidClockReads, invalidNesting: this.invalidNesting, openSpans: this.stack.length };
  }
}

export interface PlanningTaskDetails { stage: 'direct' | 'corner' | 'coarse' | 'fine' | 'done' | 'unknown'; directRemaining: number | null; starts?: string[]; ends?: string[]; cacheKey?: string }
export type DiagnosticTask = PathRequest & { stage?: string; lineStep?: number; lineSteps?: number; startComponents?: string[]; endComponents?: string[]; cacheKey?: string };
export function planningTaskDetails(task: DiagnosticTask): PlanningTaskDetails {
  const stage = task.stage === 'direct' || task.stage === 'corner' || task.stage === 'coarse' || task.stage === 'fine' || task.stage === 'done' ? task.stage : 'unknown';
  const copy = (values: unknown): string[] | undefined => Array.isArray(values) && values.length > 0 && values.length <= 9 && values.every(value => typeof value === 'string' && value.length <= 96) ? [...values] : undefined;
  return { stage, directRemaining: Number.isSafeInteger(task.lineSteps) && Number.isSafeInteger(task.lineStep) && task.lineSteps! >= task.lineStep! ? task.lineSteps! - task.lineStep! : null,
    starts: copy(task.startComponents), ends: copy(task.endComponents), cacheKey: typeof task.cacheKey === 'string' && task.cacheKey.length <= 4096 ? task.cacheKey : undefined };
}
interface Candidate { request: PathRequest; details?: PlanningTaskDetails }
function compatibilityKeys(request: PathRequest, details: PlanningTaskDetails): [string, string] | undefined {
  if (!details.starts?.length || !details.ends?.length) return;
  const prefix = [request.profile, request.radiusMm];
  return [JSON.stringify([...prefix, [...details.ends].sort()]), JSON.stringify([...prefix, request.target.xMm, request.target.zMm, details.starts, details.ends])];
}

/** Maintains overlapping candidate peaks at natural metadata changes, so a
 * brief compatible group is not lost between host diagnostic snapshots. */
export class PlanningOverlapCensus {
  private members = new Map<string, [string, string]>();
  private groups = [new Map<string, number>(), new Map<string, number>()];
  private joinedExisting = [0, 0];
  private maximumGroup = [0, 0];
  private shared = [0, 0];
  private maximumShared = [0, 0];
  private omitted = 0;
  private resets = 0;
  remove(id: string): void {
    const prior = this.members.get(id); if (!prior) return; this.members.delete(id);
    for (let index = 0; index < 2; index++) {
      const groups = this.groups[index]!, count = groups.get(prior[index]!)!;
      if (count === 2) this.shared[index]! -= 2; else if (count > 2) this.shared[index]!--;
      if (count === 1) groups.delete(prior[index]!); else groups.set(prior[index]!, count - 1);
    }
  }
  update(request: PathRequest, details: PlanningTaskDetails, pending: boolean): void {
    const keys = pending ? compatibilityKeys(request, details) : undefined, prior = this.members.get(request.unitId);
    if (keys && prior?.[0] === keys[0] && prior[1] === keys[1]) return;
    this.remove(request.unitId); if (!keys) return;
    if (this.members.size >= 4096) { this.omitted++; return; }
    this.members.set(request.unitId, keys);
    for (let index = 0; index < 2; index++) {
      const groups = this.groups[index]!, count = groups.get(keys[index]!) ?? 0;
      if (count) this.joinedExisting[index]!++;
      groups.set(keys[index]!, count + 1);
      if (count === 1) this.shared[index]! += 2; else if (count > 1) this.shared[index]!++;
      this.maximumGroup[index] = Math.max(this.maximumGroup[index]!, count + 1);
      this.maximumShared[index] = Math.max(this.maximumShared[index]!, this.shared[index]!);
    }
  }
  clearActive(): void { this.members.clear(); for (const groups of this.groups) groups.clear(); this.shared = [0, 0]; this.resets++; }
  snapshot() {
    const metric = (index: number) => ({ activeGroups: this.groups[index]!.size, activeSharedRequests: this.shared[index]!, maximumSharedRequests: this.maximumShared[index]!, maximumGroupSize: this.maximumGroup[index]!, joinsIntoExistingCandidateGroup: this.joinedExisting[index]! });
    return { compatibilityProven: false as const, scope: 'Natural component-metadata progress plus observation/restore reseeding. Join events are not distinct requests and include reseeding; peaks include earlier observed generations. Geometry/connector equivalence is not proven.',
      trackedMembers: this.members.size, memberLimit: 4096, omittedUpdates: this.omitted, activeResets: this.resets, goalComponentCandidates: metric(0), exactTargetOrderedComponentCandidates: metric(1) };
  }
}
/** Iterates only the lifecycle census's already bounded pending roster. */
export function planningCompatibility(records: Iterable<Candidate>) {
  const stages = { direct: 0, corner: 0, coarse: 0, fine: 0, done: 0, unknown: 0 };
  type Group = { profile: string; radiusMm: number; requests: number; startComponents: number; endComponents: number };
  const goalSets = new Map<string, Group>(), orderedExact = new Map<string, Group>();
  let knownComponents = 0, unknownComponents = 0, directRemainingKnown = 0, directRemainingUnknown = 0, directRemainingTotal = 0, directRemainingMax = 0;
  for (const { request, details } of records) {
    stages[details?.stage ?? 'unknown']++;
    if (details?.stage === 'direct') { if (details.directRemaining === null) directRemainingUnknown++; else { directRemainingKnown++; directRemainingTotal += details.directRemaining; directRemainingMax = Math.max(directRemainingMax, details.directRemaining); } }
    if (!details?.starts?.length || !details.ends?.length) { unknownComponents++; continue; }
    knownComponents++;
    // Goal-component candidates allow differing starts for a future reverse job.
    // Exact candidates additionally retain ordered endpoints and heuristic target.
    const pair = compatibilityKeys(request, details)!;
    const keys = [[goalSets, pair[0]], [orderedExact, pair[1]]] as const;
    for (const [groups, key] of keys) { const prior = groups.get(key); if (prior) prior.requests++; else groups.set(key, { profile: request.profile.slice(0, 160), radiusMm: request.radiusMm, requests: 1, startComponents: details.starts.length, endComponents: details.ends.length }); }
  }
  const summarize = (groups: Map<string, Group>) => ({ groups: groups.size, sharedRequests: [...groups.values()].reduce((sum, group) => sum + (group.requests > 1 ? group.requests : 0), 0),
    largest: [...groups.values()].map((group, index) => ({ ...group, index })).sort((a, b) => b.requests - a.requests || a.index - b.index).slice(0, GROUP_LIMIT), omittedGroupExamples: Math.max(0, groups.size - GROUP_LIMIT) });
  return { scope: 'bounded tracked pending metadata observed at existing scheduler seams' as const, compatibilityProven: false as const,
    missingProof: ['relevant authorized geometry dependency equality', 'follower connector legality', 'chosen algorithm/cost contract'],
    stages, knownComponents, unknownComponents, directRemaining: { known: directRemainingKnown, unknown: directRemainingUnknown, total: directRemainingTotal, maximum: directRemainingMax },
    goalComponentCandidates: summarize(goalSets), exactTargetOrderedComponentCandidates: summarize(orderedExact), reportedGroupsLimit: GROUP_LIMIT };
}
