import type { EndpointDiagnosticsResponse } from '@frontier/shared';
import { EndpointClient, EndpointError, type EndpointConfigSource } from './ai-endpoint.js';
import { AiModelCatalog } from './ai-model-catalog.js';
import { AiScheduler, AI_REQUEST_STAGES, percentiles, type AiAdmission, type AiAdmissionLease, type AiDriver, type SchedulingState } from './ai-scheduler.js';

type Candidate = { modelId: string; playerId: string; queuedAt: number };
type Lease = { group: string; playerId?: string; deadline: number; cancelled: boolean };
const originGroup = (baseUrl: string): string => {
  if (!baseUrl) return '';
  const url = new URL(baseUrl);
  // Conservative origin-level sharing: aliases/paths/model labels are not more capacity.
  if (['localhost', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  return url.origin;
};

/** One admission owner survives profile changes/removal, including canceled inference. */
class AdmissionPool {
  private readonly leases = new Set<Lease>();
  private pending: Candidate[] = [];
  constructor(private readonly catalog: AiModelCatalog, private readonly now: () => number, readonly maximum: number) {}
  private prune() { for (const lease of this.leases) if (lease.cancelled && lease.deadline <= this.now()) this.leases.delete(lease); }
  active() { this.prune(); return this.leases.size; }
  collect(pending: Candidate[]) { this.pending = pending.sort((a, b) => a.queuedAt - b.queuedAt || a.playerId.localeCompare(b.playerId)); }
  private group(modelId: string) { const endpoint = this.catalog.get(modelId); return endpoint && originGroup(endpoint.snapshot().settings.baseUrl); }
  private capacity(group: string) {
    const caps = this.catalog.entries().filter(item => item.enabled && originGroup(item.endpoint.snapshot().settings.baseUrl) === group).map(item => item.endpoint.snapshot().settings.maxConcurrent);
    return caps.length ? Math.min(...caps) : 0;
  }
  private available(group: string, playerId?: string) { return group && this.leases.size < this.maximum && [...this.leases].filter(lease => lease.group === group).length < this.capacity(group) && (!playerId || ![...this.leases].some(lease => lease.playerId === playerId)); }
  admission(modelId: string): AiAdmission {
    return {
      cancelPending: playerId => { this.pending = this.pending.filter(item => item.modelId !== modelId || playerId !== undefined && item.playerId !== playerId); },
      acquire: request => {
        this.prune(); const group = this.group(modelId); if (!group || !this.available(group, request.playerId)) return;
        // Global FIFO among requests whose origins have capacity. A saturated origin
        // cannot block unrelated model services; ties are stable faction identities.
        const first = this.pending.find(item => { const candidateGroup = this.group(item.modelId); return candidateGroup && this.available(candidateGroup, item.playerId); });
        if (first && (first.modelId !== modelId || first.playerId !== request.playerId)) return;
        const lease: Lease = { group, deadline: request.deadline, cancelled: false, ...(request.playerId ? { playerId: request.playerId } : {}) };
        this.leases.add(lease); this.pending = this.pending.filter(item => item.modelId !== modelId || item.playerId !== request.playerId);
        let released = false;
        return { setDeadline:deadline=>{if(!released&&Number.isFinite(deadline)&&deadline>=this.now())lease.deadline=deadline;},release: cancelled => { if (released) return; released = true; if (cancelled && lease.deadline > this.now()) lease.cancelled = true; else this.leases.delete(lease); } } satisfies AiAdmissionLease;
      },
    };
  }
}

type SchedulerNode = { source: EndpointConfigSource; scheduler: AiScheduler; driver?: AiDriver };

/** Isolated endpoint health with bounded cross-profile scheduling, outside simulation. */
export class AiModelScheduler {
  private readonly nodes = new Map<string, SchedulerNode>();
  private readonly pool: AdmissionPool;
  private driver?: AiDriver;
  private state?: SchedulingState;
  private polling = false;
  private stopped = false;
  private generation = 0;
  private traceClock?: () => number;
  onMessage: AiScheduler['onMessage'] = () => {};
  constructor(private readonly catalog: AiModelCatalog, private readonly now: () => number = Date.now, private readonly clientFactory = (snapshot: ReturnType<EndpointConfigSource['snapshot']>) => new EndpointClient(snapshot.settings, snapshot.apiKey), globalConcurrency = 11) {
    if (!Number.isSafeInteger(globalConcurrency) || globalConcurrency < 1 || globalConcurrency > 11) throw new EndpointError('INVALID_AI_CONCURRENCY');
    this.pool = new AdmissionPool(catalog, now, globalConcurrency);
  }
  private members(modelId: string) { return this.state?.commanders.filter(item => (item.modelId ?? 'host') === modelId) ?? []; }
  private wrap(modelId: string, driver: AiDriver): AiDriver {
    return {
      aiSchedulingState: async () => {
        if (this.driver !== driver || !this.state) throw new EndpointError('WORKER_UNAVAILABLE');
        return { ...this.state, commanders: this.catalog.get(modelId) ? this.members(modelId) : [] };
      },
      prepareAiRequest: async (playerId, requestId, chats) => {
        const expected = this.members(modelId).find(item => item.playerId === playerId);
        if (this.driver !== driver || !this.catalog.get(modelId) || !expected) throw new EndpointError('AI_UNAVAILABLE');
        const dispatch = await driver.prepareAiRequest(playerId, requestId, chats);
        // A human may switch models while this worker boundary is in flight.
        if (dispatch.binding.controllerGeneration !== expected.generation || this.driver !== driver || !this.catalog.get(modelId)) {
          await driver.completeAiRequest(dispatch.binding, { kind: 'failure', code: 'CANCELLED' }).catch(() => {}); throw new EndpointError('CANCELLED');
        }
        return dispatch;
      },
      completeAiRequest: (binding, result) => driver.completeAiRequest(binding, result),
      invalidateAiRequests: async reason => { const ids = this.members(modelId).map(item => item.playerId); if (ids.length) await driver.invalidateAiRequests(reason, ids); },
    };
  }
  private async synchronize(): Promise<void> {
    const entries = this.catalog.entries(), present = new Set(entries.map(item => item.id));
    for (const [id, node] of this.nodes) if (!present.has(id)) { await node.scheduler.close(); this.nodes.delete(id); }
    for (const entry of entries) {
      let node = this.nodes.get(entry.id);
      if (!node) {
        const scheduler = new AiScheduler(entry.endpoint, this.now, this.clientFactory, this.pool.admission(entry.id));
        scheduler.onMessage = (playerId, message) => this.onMessage(playerId, message);
        if (this.traceClock) scheduler.enableRenewalDiagnostics(this.traceClock);
        node = { source: entry.endpoint, scheduler }; this.nodes.set(entry.id, node);
      }
      if (node.driver !== this.driver) { await node.scheduler.setDriver(this.driver ? this.wrap(entry.id, this.driver) : undefined); node.driver = this.driver; }
    }
  }
  async setDriver(driver?: AiDriver) {
    const generation = ++this.generation, previous = this.driver; this.driver = undefined; this.invalidate('MATCH_REPLACED');
    if (previous) await previous.invalidateAiRequests('MATCH_REPLACED').catch(() => {});
    if (generation !== this.generation || this.stopped && driver) return;
    this.state = undefined; this.driver = driver; await this.synchronize();
  }
  invalidate(reason = 'REQUEST_CANCELLED') { for (const node of this.nodes.values()) node.scheduler.invalidate(reason); this.pool.collect([]); }
  playerChanged(playerId: string) { for (const node of this.nodes.values()) node.scheduler.invalidatePlayer(playerId); }
  async configurationChanged(modelId: string) {
    this.nodes.get(modelId)?.scheduler.configurationChanged();
    const ids = this.members(modelId).map(item => item.playerId);
    if (this.driver && ids.length) await this.driver.invalidateAiRequests('CONFIG_CHANGED', ids);
    await this.synchronize();
  }
  urgent(playerId: string, requestId: string) { const modelId = this.state?.commanders.find(item => item.playerId === playerId)?.modelId ?? 'host'; return this.nodes.get(modelId)?.scheduler.urgent(playerId, requestId) ?? false; }
  async poll(): Promise<void> {
    if (this.polling || this.stopped || !this.driver) return;
    this.polling = true; const driver = this.driver, generation = this.generation;
    try {
      const state = await driver.aiSchedulingState(); if (this.driver !== driver || generation !== this.generation || this.stopped) return;
      if (state.commanders.length > 11 || new Set(state.commanders.map(item => item.playerId)).size !== state.commanders.length) throw new EndpointError('INVALID_AI_CONCURRENCY');
      this.state = state; await this.synchronize();
      if (this.driver !== driver || generation !== this.generation) return;
      for (const node of this.nodes.values()) await node.scheduler.poll(true);
      this.pool.collect([...this.nodes].flatMap(([modelId, node]) => node.scheduler.pendingRequests().map(item => ({ modelId, ...item }))));
      // At most eleven admissions: a later profile's oldest request can admit
      // before an earlier profile's next request within the same bounded poll.
      for (let pass = 0; pass < 11; pass++) {
        const active = this.pool.active();
        for (const node of this.nodes.values()) await node.scheduler.poll();
        if (this.pool.active() === active || this.pool.active() >= this.pool.maximum) break;
      }
    } catch { this.invalidate('WORKER_UNAVAILABLE'); if (this.driver === driver) await driver.invalidateAiRequests('WORKER_UNAVAILABLE').catch(() => {}); }
    finally { this.polling = false; }
  }
  async probe(listModels: boolean, modelId = 'host') { await this.synchronize(); const endpoint = this.catalog.get(modelId); if (!endpoint) throw new EndpointError('MODEL_NOT_FOUND'); if (!endpoint.state().configured) throw new EndpointError('NOT_CONFIGURED'); return this.nodes.get(modelId)!.scheduler.probe(listModels); }
  currentTick(fallback = 0) { return this.state?.tick ?? fallback; }
  enableRenewalDiagnostics(now: () => number = () => performance.now()) { this.traceClock = now; for (const node of this.nodes.values()) node.scheduler.enableRenewalDiagnostics(now); }
  renewalDiagnostics() { return this.traceClock ? { ...this.nodes.get('host')?.scheduler.renewalDiagnostics(), models: [...this.nodes].map(([modelId, node]) => ({ modelId, trace: node.scheduler.renewalDiagnostics() })) } : undefined; }
  renewalPolicyDiagnostics() { return { ...this.nodes.get('host')?.scheduler.renewalPolicyDiagnostics(), models: [...this.nodes].map(([modelId, node]) => ({ modelId, policy: node.scheduler.renewalPolicyDiagnostics() })) }; }
  diagnostics(): EndpointDiagnosticsResponse['scheduler'] {
    const rows = [...this.nodes.values()].map(node => node.scheduler.diagnostics()), samples = [...this.nodes.values()].map(node => node.scheduler.measurementSamples());
    const sum = (field: 'completed' | 'failed' | 'pending' | 'consecutiveFailures') => rows.reduce((total, row) => total + row[field], 0);
    const usageTotals = rows.reduce((total, row) => ({ reportedRequests: total.reportedRequests + (row.usageTotals?.reportedRequests ?? 0), missingUsageRequests: total.missingUsageRequests + (row.usageTotals?.missingUsageRequests ?? 0), promptTokens: total.promptTokens + (row.usageTotals?.promptTokens ?? 0), completionTokens: total.completionTokens + (row.usageTotals?.completionTokens ?? 0), totalTokens: total.totalTokens + (row.usageTotals?.totalTokens ?? 0) }), { reportedRequests: 0, missingUsageRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    const renewals = rows.flatMap(row => row.renewal ? [row.renewal] : []), host = this.nodes.get('host')?.scheduler.diagnostics();
    return { active: this.pool.active(), pending: sum('pending'), concurrency: this.pool.maximum, circuit: rows.some(row => row.circuit === 'half_open') ? 'half_open' : rows.some(row => row.circuit === 'open') ? 'open' : 'closed', retryAfterMs: Math.max(0, ...rows.map(row => row.retryAfterMs)), consecutiveFailures: sum('consecutiveFailures'), completed: sum('completed'), failed: sum('failed'), latencyMs: percentiles(samples.flatMap(row => row.latencies)), queueDelayMs: percentiles(samples.flatMap(row => row.queues)), promptTokens: host?.promptTokens ?? null, completionTokens: host?.completionTokens ?? null, prefillMs: host?.prefillMs ?? null, generationMs: host?.generationMs ?? null, usageTotals,
      stages:Object.fromEntries(AI_REQUEST_STAGES.map(stage=>[stage,{samples:samples.reduce((total,row)=>total+row.stages[stage].durations.length,0),durationMs:percentiles(samples.flatMap(row=>row.stages[stage].durations)),failures:samples.reduce((total,row)=>total+row.stages[stage].failures,0),timeouts:samples.reduce((total,row)=>total+row.stages[stage].timeouts,0)}])) as NonNullable<EndpointDiagnosticsResponse['scheduler']['stages']>,
      recentFailures: rows.flatMap(row => row.recentFailures ?? []).sort((a, b) => a.at - b.at).slice(-16),
      renewal: { estimateSource: 'joint_queue_to_acceptance', samples: renewals.reduce((total, row) => total + row.samples, 0), warmup: renewals.some(row => row.warmup), commanders: renewals.flatMap(row => row.commanders) }, commanders: rows.flatMap(row => row.commanders) };
  }
  async close() { this.stopped = true; await this.setDriver(); for (const node of this.nodes.values()) await node.scheduler.close(); }
}
