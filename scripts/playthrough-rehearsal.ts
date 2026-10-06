import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { createSimulation, type Simulation } from '@frontier/simulation';
import { balance, contentHash, TEAM_IDENTITIES, type ClientCommandEnvelope, type GameplayCommand, type Personality, type PlayerView, type PublicPlayer } from '@frontier/shared';
import { engineIdentity } from '../apps/server/src/build-info.js';
import { createPlaythroughMemory, observePlaythrough, planPlaythrough, playthroughCommandSent, playthroughReceipt } from './playthrough-policy.js';

// Functional debugging only: advance ordinary fixed ticks without wall-clock pacing.
// The participant policy receives ONLY its own 10 Hz PlayerView and command receipts.
// No scenario state edits, resource grants, model calls, or administrative victory.
declare const __PROFILE_EXECUTION__: 'bundled-production' | undefined;
const execution = typeof __PROFILE_EXECUTION__ === 'string' ? __PROFILE_EXECUTION__ : 'source-tsx';
// Hash the code actually loaded for this run; scripts are outside engine identity.
const hashBytes = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const harnessIdentity = { artifactSha256: hashBytes(await readFile(new URL(import.meta.url))),
  ...(execution === 'source-tsx' ? { policySourceSha256: hashBytes(await readFile(new URL('./playthrough-policy.ts', import.meta.url))) } : {}) };
const args = new Map(process.argv.slice(2).filter(arg => arg !== '--').map(arg => {
  const match = /^--([a-z-]+)=(.+)$/.exec(arg); assert(match, 'USE_NAMED_EQUALS_ARGUMENTS'); return [match[1]!, match[2]!] as const;
}));
for (const name of args.keys()) assert(['ticks', 'seed', 'population', 'map'].includes(name), 'UNKNOWN_OPTION');
const tickLimit = Number(args.get('ticks') ?? 72000), seed = Number(args.get('seed') ?? 37);
const populationLimit = Number(args.get('population') ?? 120), mapType = args.get('map') ?? 'open_frontier';
assert(Number.isSafeInteger(tickLimit) && tickLimit >= 20 && tickLimit <= 144000, 'INVALID_TICKS');
assert(Number.isSafeInteger(seed) && seed >= 0 && seed <= 4294967295, 'INVALID_SEED');
assert(populationLimit === 120 || populationLimit === 200, 'INVALID_POPULATION');
assert(mapType === 'open_frontier' || mapType === 'river_divide', 'INVALID_MAP');
const mapSeed = createHash('sha256').update(`network-map:${seed}:${mapType}`).digest('hex');
const factions: PublicPlayer[] = [
  ...Array.from({ length: 6 }, (_, index): PublicPlayer => ({ id: `human_${index + 1}`, name: index === 5 ? 'Rehearsal host' : `Rehearsal remote ${index + 1}`,
    teamId: 'team_humans', kind: 'human', hostPlayer: index === 5, color: TEAM_IDENTITIES[index]!.color, pattern: index })),
  ...Array.from({ length: 5 }, (_, index): PublicPlayer => ({ id: `ai_${index + 1}`, name: `Rehearsal AI ${index + 1}`, teamId: 'team_commanders', kind: 'ai', hostPlayer: false,
    difficulty: 'easy', personality: balance.ai.personalities[index] as Personality, color: TEAM_IDENTITIES[index + 6]!.color, pattern: index + 6 })),
];
const humans = factions.filter(faction => faction.kind === 'human'), humanIds = humans.map(faction => faction.id);
const memory = new Map(humanIds.map(id => [id, createPlaythroughMemory()])), sequences = new Map(humanIds.map(id => [id, 0]));
const configuration = { tickLimit, seed, mapSeed, mapType, mapSize: 'large', populationLimit, sharedVision: false, caretakerEnabled: false, monumentVictory: false,
  controllers: true, teamPreset: 'six_vs_five', startingResourcePreset: 'standard', factions, viewHz: 10, maximumPolicyDecisionHz: 1 };
const configurationId = createHash('sha256').update(JSON.stringify(configuration)).digest('hex').slice(0, 12), runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const reportPath = `runtime-data/qualification/playthrough-rehearsal-${seed}-${tickLimit}ticks-${configurationId}-${execution}-${engineIdentity.engineBuildHash.slice(0, 12)}-${runId}.json`;
const hz = balance.rules.simulationHz, viewInterval = hz / configuration.viewHz;
assert(Number.isInteger(viewInterval) && viewInterval > 0, 'INVALID_VIEW_CADENCE');
const journal = { events: 0, lastOrdinal: 0, byKind: {} as Record<string, number>, commands: {} as Record<string, { accepted: number; rejected: Record<string, number> }> };
const initialPurchases: { playerId: string; tick: number; status: string; code?: string }[] = [];
const progress: { tick: number; ages: number[]; populations: number[]; accepted: number[] }[] = [];
let simulation: Simulation | undefined, latest: PlayerView[] = [], failure: string | undefined, interrupted = false;
const started = performance.now(), interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);

function envelope(view: PlayerView, command: GameplayCommand): ClientCommandEnvelope {
  const clientSequence = Math.max(sequences.get(view.playerId)!, view.self.lastCommandSequence) + 1; sequences.set(view.playerId, clientSequence);
  return { protocolVersion: 2, matchId: view.matchId, matchEpoch: view.matchEpoch, clientSequence, clientCommandId: `rehearsal_${view.playerId}_${clientSequence}`, command };
}
function drain(): void {
  const batch = simulation!.drainJournal(4096); assert(batch.gapBeforeOrdinal === undefined, 'JOURNAL_CONSUMER_GAP');
  for (const event of batch.events) {
    assert.equal(event.ordinal, journal.lastOrdinal + 1, 'JOURNAL_ORDINAL_GAP'); journal.lastOrdinal = event.ordinal; journal.events++;
    journal.byKind[event.kind] = (journal.byKind[event.kind] ?? 0) + 1;
    if (event.kind === 'command') {
      const counts = journal.commands[event.playerId] ??= { accepted: 0, rejected: {} };
      if (event.receipt.status === 'accepted') counts.accepted++;
      else { const code = event.receipt.code ?? 'UNKNOWN'; counts.rejected[code] = (counts.rejected[code] ?? 0) + 1; }
    }
  }
  assert.equal(journal.lastOrdinal, batch.throughOrdinal, 'JOURNAL_NOT_FULLY_DRAINED');
}
function observe(): void {
  latest = simulation!.views(humanIds);
  for (const view of latest) {
    observePlaythrough(view, memory.get(view.playerId)!);
    assert(Object.values(view.self.resources).every(amount => Number.isSafeInteger(amount) && amount >= 0), 'OBSERVED_NEGATIVE_OR_INVALID_BANK');
  }
}
function finalHuman(view: PlayerView) {
  const own = view.entities.filter(entity => entity.ownerId === view.playerId && !entity.ghost), tasks: Record<string, number> = {}, buildings: Record<string, number> = {};
  for (const entity of own) {
    if (entity.typeId === 'villager') { const task = entity.blockedReason ?? entity.taskState ?? 'idle'; tasks[task] = (tasks[task] ?? 0) + 1; }
    if (entity.kind === 'building') { const key = `${entity.typeId}:${entity.progress === 1 ? 'completed' : 'foundation'}`; buildings[key] = (buildings[key] ?? 0) + 1; }
  }
  return { playerId: view.playerId, ...memory.get(view.playerId)!.telemetry, final: { tick: view.tick, age: view.self.age, resources: view.self.resources,
    population: view.self.population, reservedPopulation: view.self.reservedPopulation, populationCap: view.self.populationCap,
    technologies: view.self.technologies ?? [], workerTasks: tasks, buildings, jobs: own.flatMap(entity => (entity.queue ?? []).map(job => ({ producerId: entity.id, ...job }))) } };
}
await mkdir('runtime-data/qualification', { recursive: true });
try {
  simulation = createSimulation({ seed: mapSeed, mapType, mapSize: 'large', populationLimit, factions, matchId: `rehearsal_${configurationId}`, controllers: true,
    sharedVision: false, caretakerEnabled: false, monumentVictory: false });
  observe();
  for (const view of latest) {
    assert.deepEqual(view.self.resources, balance.start.resources, 'NONSTANDARD_START_BANK'); assert.equal(view.self.age, balance.start.age, 'NONSTANDARD_START_AGE');
    // Network setup also makes one ordinary paid villager purchase per participant.
    const home = view.entities.find(entity => entity.ownerId === view.playerId && entity.typeId === 'town_center'); assert(home, 'INITIAL_TOWN_CENTER_MISSING');
    const receipt = simulation.command(view.playerId, envelope(view, { kind: 'train', buildingId: home.id, unitType: 'villager', quantity: 1 }));
    initialPurchases.push({ playerId: view.playerId, tick: receipt.tick, status: receipt.status, code: receipt.code });
    assert.equal(receipt.status, 'accepted', 'INITIAL_PAID_VILLAGER_REJECTED');
  }
  drain();
  console.log(JSON.stringify({ event: 'playthrough_rehearsal_started', execution, engineBuildHash: engineIdentity.engineBuildHash, configurationId, runId, reportPath, tickLimit, qualificationPassed: false }));
  while (simulation.state.tick < tickLimit && simulation.state.status === 'RUNNING' && !interrupted) {
    simulation.step(); drain();
    if (simulation.state.tick % viewInterval === 0 || simulation.state.status !== 'RUNNING') {
      observe();
      for (const view of latest) {
        const participant = memory.get(view.playerId)!;
        for (const command of planPlaythrough(view, participant)) {
          const packet = envelope(view, command); playthroughCommandSent(participant, packet);
          playthroughReceipt(participant, simulation.command(view.playerId, packet));
        }
      }
      drain();
    }
    if (simulation.state.tick % (60 * hz) === 0) {
      const sample = { tick: simulation.state.tick, ages: latest.map(view => view.self.age), populations: latest.map(view => view.self.population), accepted: humanIds.map(id => memory.get(id)!.telemetry.accepted) };
      progress.push(sample); console.log(JSON.stringify({ event: 'playthrough_rehearsal_progress', ...sample })); await setImmediate();
    }
  }
  // Include the last decision's admitted commands, even at an existing view tick.
  observe();
  assert(interrupted || simulation.state.status === 'FINISHED' || simulation.state.tick === tickLimit, 'UNEXPECTED_NONTERMINAL_STOP');
} catch (error) {
  // Fixed diagnostic codes only; neither raw state nor arbitrary error text is logged.
  const message = error instanceof Error ? error.message : ''; failure = /^[A-Z][A-Z0-9_]{0,95}$/.test(message) ? message : 'REHEARSAL_FAILED';
} finally {
  process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
}
const telemetry = latest.map(finalHuman), observedChecks = {
  allFourAges: telemetry.length === 6 && telemetry.every(item => ['1', '2', '3', '4'].every(age => item.ageTicks[age] !== undefined)),
  upgrades: latest.length === 6 && latest.every(view => view.self.technologies?.includes('forestry_3')),
  completedFarm: telemetry.some(item => item.evidence.completedFarm.met), completedWall: telemetry.some(item => item.evidence.completedWall.met),
  completedGate: telemetry.some(item => item.evidence.completedGate.met), resourceDepletion: telemetry.some(item => item.evidence.resourceDepletion.met),
  naturalNodeDepletion: telemetry.some(item => item.evidence.naturalNodeDepletion.met), fortificationBreach: telemetry.some(item => item.evidence.fortificationBreach.met),
  finished: latest[0]?.status === 'FINISHED' && !!latest[0].result,
};
const policyComplete = !failure && Object.values(observedChecks).every(Boolean), terminated = observedChecks.finished;
// Host-private artifacts only, outside the static root. A checkpoint is useful for
// diagnosis, but cannot replace the unretained journal as terminal replay evidence.
const artifacts: { kind: string; path: string; maximumBytes: number; bytes?: number; sha256?: string; status: 'written' | 'omitted' | 'failed'; reason?: string }[] = [];
async function retain(kind: string, value: unknown, maximumBytes: number): Promise<void> {
  const path = reportPath.replace(/\.json$/, `.${kind}.json`), text = JSON.stringify(value), bytes = Buffer.byteLength(text);
  if (bytes > maximumBytes) { artifacts.push({ kind, path, maximumBytes, bytes, status: 'omitted', reason: 'ARTIFACT_BYTE_LIMIT' }); return; }
  try { await writeFile(path, text, { flag: 'wx' }); artifacts.push({ kind, path, maximumBytes, bytes, sha256: hashBytes(text), status: 'written' }); }
  catch { artifacts.push({ kind, path, maximumBytes, bytes, status: 'failed', reason: 'ARTIFACT_WRITE_FAILED' }); }
}
if (simulation) {
  try { await retain('checkpoint', { schemaVersion: 1, contentHash, ...engineIdentity, harnessIdentity, payload: simulation.capture() }, 64 * 1024 * 1024); }
  catch { artifacts.push({ kind: 'checkpoint', path: reportPath.replace(/\.json$/, '.checkpoint.json'), maximumBytes: 64 * 1024 * 1024, status: 'failed', reason: 'CHECKPOINT_CAPTURE_FAILED' }); }
  await retain('participants', { schemaVersion: 1, contentHash, ...engineIdentity, harnessIdentity, views: latest,
    memories: Object.fromEntries(memory), clientSequences: Object.fromEntries(sequences) }, 16 * 1024 * 1024);
}
const report = { event: 'playthrough_rehearsal_recorded', schemaVersion: 1, execution, configurationId, runId, configuration, contentHash, ...engineIdentity, harnessIdentity, artifacts,
  scope: 'Offline normal-resource deterministic policy rehearsal only. Six scripted human policies receive their own 10 Hz filtered views; five Easy AI use rule fallback. Stable rehearsal human IDs replace random network session IDs. No network, model, persistence, replay, real-time throughput, or acceptance qualification.',
  qualificationPassed: false, policyComplete, censored: !terminated, unmet: Object.entries(observedChecks).filter(([, met]) => !met).map(([name]) => name),
  stopReason: failure ? 'error' : interrupted ? 'interrupted' : terminated ? 'terminal' : 'tick_limit', ...(failure ? { failure } : {}),
  checks: observedChecks, finalTick: simulation?.state.tick ?? 0, wallElapsedMs: Math.round(performance.now() - started), wallTimeIsPerformanceEvidence: false,
  result: latest[0]?.result ?? null, players: latest[0]?.players ?? factions, initialPurchases, journal: { ...journal, retainedForReplay: false }, progress, telemetry,
  untested: ['network_replication', 'reconnect', 'save_restore', 'terminal_replay', 'model_endpoint', 'capacity', 'real_time_timing', 'soak'] };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ event: report.event, reportPath, finalTick: report.finalTick, stopReason: report.stopReason, qualificationPassed: false, policyComplete, censored: report.censored, unmet: report.unmet, ...(failure ? { failure } : {}) }));
process.exitCode = failure ? 1 : interrupted ? 130 : policyComplete ? 0 : 2;
