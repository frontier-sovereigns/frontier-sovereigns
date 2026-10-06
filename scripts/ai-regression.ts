import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createSimulation, type Simulation } from '@frontier/simulation';
import { balance, buildings, contentHash, TEAM_IDENTITIES, type Difficulty, type Personality, type PublicPlayer } from '@frontier/shared';
import { engineIdentity } from '../apps/server/src/build-info.js';

declare const __PROFILE_EXECUTION__: 'bundled-production' | undefined;
const execution = typeof __PROFILE_EXECUTION__ === 'string' ? __PROFILE_EXECUTION__ : 'source-tsx';

// AT-66 ordinary-start, side-swapped policy evidence. This runner never changes
// authoritative state, supplies model plans, or declares Hard the required winner.
const options = new Map(process.argv.slice(2).filter(arg => arg !== '--').map(arg => {
  const match = /^--([a-z-]+)=(.+)$/.exec(arg); assert(match, 'USE_NAMED_EQUALS_ARGUMENTS'); return [match[1]!, match[2]!] as const;
}));
for (const key of options.keys()) assert(['ticks', 'seeds', 'suite', 'pairs'].includes(key), `UNKNOWN_OPTION:${key}`);
const tickLimit = Number(options.get('ticks') ?? 36000), seeds = (options.get('seeds') ?? '66,137').split(',');
const suite = options.get('suite') ?? 'all', pairLimit = Number(options.get('pairs') ?? 100);
assert(Number.isSafeInteger(tickLimit) && tickLimit >= 20 && tickLimit <= 144000, 'INVALID_TICKS');
assert(seeds.length >= 1 && seeds.length <= 8 && seeds.every(seed => /^\d{1,10}$/.test(seed) && Number(seed) <= 4294967295), 'INVALID_SEEDS');
assert(new Set(seeds).size === seeds.length, 'DUPLICATE_SEEDS');
assert(['all', 'difficulty', 'personality'].includes(suite), 'INVALID_SUITE');
assert(Number.isSafeInteger(pairLimit) && pairLimit >= 1 && pairLimit <= 100, 'INVALID_PAIRS');
type Policy = { difficulty: Difficulty; personality: Personality };
type Pair = { label: string; policies: [Policy, Policy] };
const pairs: Pair[] = [];
if (suite !== 'personality') for (const [a, b] of [['easy', 'medium'], ['easy', 'hard'], ['medium', 'hard']] as const)
  pairs.push({ label: `${a}_vs_${b}`, policies: [{ difficulty: a, personality: 'marshal' }, { difficulty: b, personality: 'marshal' }] });
if (suite !== 'difficulty') for (const personality of ['raider', 'marshal', 'steward', 'diplomat'] as const)
  pairs.push({ label: `builder_vs_${personality}`, policies: [{ difficulty: 'medium', personality: 'builder' }, { difficulty: 'medium', personality }] });
const hz = balance.rules.simulationHz;
const ratio = (n: number, d: number) => d ? Number((n / d).toFixed(5)) : null;
function exactWorkerExposure() { return { survivingWorkerTicks: 0, gatherWorkerTicks: 0, buildWorkerTicks: 0, repairWorkerTicks: 0, cargoReturnMovementWorkerTicks: 0 }; }
type ExactWorkerExposure = ReturnType<typeof exactWorkerExposure>;
function committedWorkerFractions(exposure: ExactWorkerExposure) {
  const contribution = exposure.gatherWorkerTicks + exposure.buildWorkerTicks + exposure.repairWorkerTicks;
  return { gather: ratio(exposure.gatherWorkerTicks, exposure.survivingWorkerTicks), build: ratio(exposure.buildWorkerTicks, exposure.survivingWorkerTicks),
    repair: ratio(exposure.repairWorkerTicks, exposure.survivingWorkerTicks), cargoReturnMovement: ratio(exposure.cargoReturnMovementWorkerTicks, exposure.survivingWorkerTicks),
    contribution: ratio(contribution, exposure.survivingWorkerTicks), contributionOrCargoReturnMovement: ratio(contribution + exposure.cargoReturnMovementWorkerTicks, exposure.survivingWorkerTicks) };
}
function metrics() { return { workerTicks: 0, assignedWorkStateWorkerTicks: 0, idleWorkerTicks: 0, blockedWorkerTicks: 0, producerTicks: 0, idleProducerTicks: 0,
  blockedProducerTicks: 0, waitingProducerTicks: 0, exactWorkers: exactWorkerExposure(), militaryTicks: {} as Record<string, number>, maximumMilitary: 0, attacks: [] as number[], accepted: {} as Record<string, number>, rejected: {} as Record<string, number>, peakMemoryBytes: 0, peakCommanderBytes: 0, observedStrikeCooldownResets: 0 }; }
type Metrics = ReturnType<typeof metrics>;
function observe(sim: Simulation, data: Record<string, Metrics>, elapsedTicks: number) {
  const military: Record<string, number> = {};
  for (const entity of Object.values(sim.state.entities)) {
    if (entity.kind === 'resource') { assert(entity.amount >= 0 && Number.isSafeInteger(entity.amount), 'RESOURCE_INVARIANT'); continue; }
    const sample = data[entity.ownerId]!;
    if (entity.kind === 'unit') {
      assert(entity.cargo.amount >= 0 && Number.isSafeInteger(entity.cargo.amount), 'CARGO_INVARIANT');
      if (entity.typeId === 'villager') {
        sample.workerTicks += elapsedTicks;
        if (['gathering', 'returning', 'building', 'repairing'].includes(entity.taskState ?? 'idle')) sample.assignedWorkStateWorkerTicks += elapsedTicks;
        if (!entity.orders.length) sample.idleWorkerTicks += elapsedTicks;
        if (entity.taskState === 'blocked') sample.blockedWorkerTicks += elapsedTicks;
      } else { sample.militaryTicks[entity.typeId] = (sample.militaryTicks[entity.typeId] ?? 0) + elapsedTicks; military[entity.ownerId] = (military[entity.ownerId] ?? 0) + 1; }
    } else if (entity.work >= entity.required && buildings[entity.typeId].produces.length) {
      sample.producerTicks += elapsedTicks; if (!entity.queue.length) sample.idleProducerTicks += elapsedTicks;
      else if (['population_blocked', 'exit_blocked', 'prerequisite_blocked'].includes(entity.queue[0]!.state)) sample.blockedProducerTicks += elapsedTicks;
      else if (entity.queue[0]!.state === 'waiting') sample.waitingProducerTicks += elapsedTicks;
    }
  }
  for (const faction of sim.state.factions) {
    const economy = sim.state.economies[faction.id]!, sample = data[faction.id]!;
    for (const value of Object.values(economy.resources)) assert(Number.isSafeInteger(value) && value >= 0, 'BANK_INVARIANT');
    sample.maximumMilitary = Math.max(sample.maximumMilitary, military[faction.id] ?? 0);
    sample.peakMemoryBytes = Math.max(sample.peakMemoryBytes, Buffer.byteLength(JSON.stringify(sim.state.controllers[faction.id]!.memory)));
    sample.peakCommanderBytes = Math.max(sample.peakCommanderBytes, Buffer.byteLength(JSON.stringify(sim.state.controllers[faction.id]!)));
  }
}
function drain(sim: Simulation, data: Record<string, Metrics>) {
  const batch = sim.drainJournal(4096); assert(batch.gapBeforeOrdinal === undefined, 'JOURNAL_CONSUMER_GAP');
  for (const event of batch.events) if (event.kind === 'command') {
    const sample = data[event.playerId]!, command = event.envelope.command;
    if (event.receipt.status === 'accepted') {
      sample.accepted[command.kind] = (sample.accepted[command.kind] ?? 0) + 1;
      if (['attack_move', 'attack_target', 'attack_ground'].includes(command.kind) && sample.attacks.at(-1) !== event.tick) sample.attacks.push(event.tick);
    } else { const code = event.receipt.code ?? 'UNKNOWN'; sample.rejected[code] = (sample.rejected[code] ?? 0) + 1; }
  }
}
type Histogram = { value: number; count: number }[];
function histogram(values: number[]): Histogram {
  const counts = new Map<number, number>(); for (const value of values) { assert(Number.isFinite(value), 'NONFINITE_METRIC'); counts.set(value, (counts.get(value) ?? 0) + 1); }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([value, count]) => ({ value, count }));
}
function weightedDistribution(values: Histogram) {
  const sorted = [...values].sort((a, b) => a.value - b.value), count = sorted.reduce((sum, item) => sum + item.count, 0);
  const quantile = (fraction: number) => { const rank = Math.max(1, Math.ceil(count * fraction)); let seen = 0; for (const item of sorted) { seen += item.count; if (seen >= rank) return item.value; } return null; };
  return { count, min: sorted[0]?.value ?? null, p25: quantile(.25), p50: quantile(.5), p75: quantile(.75), p95: quantile(.95), max: sorted.at(-1)?.value ?? null,
    mean: count ? Number((sorted.reduce((sum, item) => sum + item.value * item.count, 0) / count).toFixed(5)) : null };
}
function distribution(values: (number | null | undefined)[]) {
  const present = values.filter((value): value is number => value !== null && value !== undefined);
  return { ...weightedDistribution(histogram(present)), missing: values.length - present.length };
}
function factionResult(sim: Simulation, faction: PublicPlayer, m: Metrics) {
  const economy = sim.state.economies[faction.id]!, totalArmy = Object.values(m.militaryTicks).reduce((a, b) => a + b, 0);
  const outcome = sim.state.status !== 'FINISHED' ? 'censored' : sim.state.result!.winnerTeamId === null ? 'draw' : sim.state.result!.winnerTeamId === faction.teamId ? 'win' : 'loss';
  const attackIntervals = histogram(m.attacks.slice(1).map((tick, index) => (tick - m.attacks[index]!) / hz));
  return { side: faction.id, difficulty: faction.difficulty!, personality: faction.personality!, outcome,
    age: economy.age, ageSeconds: Object.fromEntries(Object.entries(economy.statistics.ageTicks).map(([age, tick]) => [age, tick / hz])),
    assignedWorkStateUtilization: ratio(m.assignedWorkStateWorkerTicks, m.workerTicks), idleWorkerFraction: ratio(m.idleWorkerTicks, m.workerTicks), blockedWorkerFraction: ratio(m.blockedWorkerTicks, m.workerTicks),
    committedWorkerFractions: committedWorkerFractions(m.exactWorkers), exactWorkerExposure: { ...m.exactWorkers },
    productionIdleFraction: ratio(m.idleProducerTicks, m.producerTicks), productionBlockedFraction: ratio(m.blockedProducerTicks, m.producerTicks), productionWaitingFraction: ratio(m.waitingProducerTicks, m.producerTicks), militaryTimeComposition: Object.fromEntries(Object.entries(m.militaryTicks).map(([id, ticks]) => [id, ratio(ticks, totalArmy)])),
    attackOrderCount: m.attacks.length, firstAttackOrderSeconds: m.attacks.length ? m.attacks[0]! / hz : null, lastAttackOrderSeconds: m.attacks.length ? m.attacks.at(-1)! / hz : null,
    attackOrderIntervalSeconds: weightedDistribution(attackIntervals), attackOrderIntervalHistogram: attackIntervals, observedStrikeCooldownResets: m.observedStrikeCooldownResets,
    peakMilitary: m.maximumMilitary, peakMemoryBytes: m.peakMemoryBytes, peakCommanderBytes: m.peakCommanderBytes,
    sampledExposure: { workerTicks: m.workerTicks, assignedWorkStateWorkerTicks: m.assignedWorkStateWorkerTicks, idleWorkerTicks: m.idleWorkerTicks, blockedWorkerTicks: m.blockedWorkerTicks, producerTicks: m.producerTicks, idleProducerTicks: m.idleProducerTicks, blockedProducerTicks: m.blockedProducerTicks, waitingProducerTicks: m.waitingProducerTicks, militaryTicks: m.militaryTicks },
    acceptedCommands: m.accepted, rejectedCommands: m.rejected, statistics: economy.statistics, collectedMilli: economy.collected, spentMilli: economy.spent };
}
type FactionResult = ReturnType<typeof factionResult>;
interface RunResult { pair: string; seed: string; reversed: boolean; mapSeed: string; finalTick: number; status: string; result: Simulation['state']['result'] | null; observedStrikeCooldownResets: number; elapsedSeconds: number; factions: FactionResult[] }
const policyId = (faction: Pick<FactionResult, 'difficulty' | 'personality'>) => `${faction.difficulty}/${faction.personality}`;
function aggregate(factions: FactionResult[]) {
  const sum = (field: keyof Omit<FactionResult['sampledExposure'], 'militaryTicks'>) => factions.reduce((total, faction) => total + faction.sampledExposure[field], 0);
  const exact = exactWorkerExposure();
  for (const faction of factions) for (const field of Object.keys(exact) as (keyof ExactWorkerExposure)[]) exact[field] += faction.exactWorkerExposure[field];
  const fractionFields = Object.keys(committedWorkerFractions(exact)) as (keyof ReturnType<typeof committedWorkerFractions>)[];
  const army: Record<string, number> = {}, intervals = new Map<number, number>();
  for (const faction of factions) { for (const [id, ticks] of Object.entries(faction.sampledExposure.militaryTicks)) army[id] = (army[id] ?? 0) + ticks;
    for (const item of faction.attackOrderIntervalHistogram) intervals.set(item.value, (intervals.get(item.value) ?? 0) + item.count); }
  const totalArmy = Object.values(army).reduce((a, b) => a + b, 0);
  return { runs: factions.length, outcomes: Object.fromEntries(['win', 'loss', 'draw', 'censored'].map(outcome => [outcome, factions.filter(faction => faction.outcome === outcome).length])),
    ageSeconds: Object.fromEntries([1, 2, 3, 4].map(age => [age, { ...distribution(factions.map(faction => faction.ageSeconds[String(age)])), notReached: factions.filter(faction => faction.ageSeconds[String(age)] === undefined).length }])),
    assignedWorkStateUtilization: distribution(factions.map(faction => faction.assignedWorkStateUtilization)), idleWorkerFraction: distribution(factions.map(faction => faction.idleWorkerFraction)), blockedWorkerFraction: distribution(factions.map(faction => faction.blockedWorkerFraction)),
    committedWorkerFractions: Object.fromEntries(fractionFields.map(field => [field, distribution(factions.map(faction => faction.committedWorkerFractions[field]))])), pooledCommittedWorkerFractions: committedWorkerFractions(exact), exactWorkerExposure: exact,
    productionIdleFraction: distribution(factions.map(faction => faction.productionIdleFraction)), productionBlockedFraction: distribution(factions.map(faction => faction.productionBlockedFraction)), productionWaitingFraction: distribution(factions.map(faction => faction.productionWaitingFraction)),
    pooledAssignedWorkStateUtilization: ratio(sum('assignedWorkStateWorkerTicks'), sum('workerTicks')), pooledIdleWorkerFraction: ratio(sum('idleWorkerTicks'), sum('workerTicks')),
    pooledProductionIdleFraction: ratio(sum('idleProducerTicks'), sum('producerTicks')), pooledProductionBlockedFraction: ratio(sum('blockedProducerTicks'), sum('producerTicks')), pooledProductionWaitingFraction: ratio(sum('waitingProducerTicks'), sum('producerTicks')),
    peakMilitary: distribution(factions.map(faction => faction.peakMilitary)), militaryTimeComposition: Object.fromEntries(Object.keys(army).sort().map(id => [id, { pooledFraction: ratio(army[id]!, totalArmy), perRun: distribution(factions.map(faction => Object.values(faction.sampledExposure.militaryTicks).some(ticks => ticks > 0) ? faction.militaryTimeComposition[id] ?? 0 : null)) }])),
    attackOrderCount: distribution(factions.map(faction => faction.attackOrderCount)), firstAttackOrderSeconds: distribution(factions.map(faction => faction.firstAttackOrderSeconds)),
    attackOrderIntervalSeconds: { weighting: 'one observation per accepted-order interval; longer or more frequent-order runs contribute more intervals', ...weightedDistribution([...intervals].map(([value, count]) => ({ value, count }))) }, runsWithoutRepeatedAttackOrders: factions.filter(faction => faction.attackOrderCount < 2).length,
    observedStrikeCooldownResets: distribution(factions.map(faction => faction.observedStrikeCooldownResets)), peakMemoryBytes: distribution(factions.map(faction => faction.peakMemoryBytes)), peakCommanderBytes: distribution(factions.map(faction => faction.peakCommanderBytes)) };
}
function aggregates(runs: RunResult[]) {
  const group = (key: (run: RunResult, faction: FactionResult) => string) => {
    const groups = new Map<string, FactionResult[]>(); for (const run of runs) for (const faction of run.factions) { const id = key(run, faction); groups.set(id, [...(groups.get(id) ?? []), faction]); }
    return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => [key, aggregate(values)]));
  };
  return { byPolicyInterpretation: 'Mixed-opponent descriptive data, not an unbiased cross-policy ranking. Opponent portfolios differ; compare policies within byMatchupPolicy and paired starting sides.',
    byPolicy: group((_run, faction) => policyId(faction)), byMatchupPolicy: group((run, faction) => `${run.pair}:${policyId(faction)}`), byMatchupStartingSide: group((run, faction) => `${run.pair}:${faction.side}:${policyId(faction)}`),
    pairedSeeds: [...new Set(runs.map(run => `${run.pair}:${run.seed}`))].sort().map(key => { const pair = runs.filter(run => `${run.pair}:${run.seed}` === key); return { key, bothSidesComplete: pair.length === 2 && pair.some(run => run.reversed) && pair.some(run => !run.reversed),
      runs: pair.map(run => ({ reversed: run.reversed, finalTick: run.finalTick, outcomes: run.factions.map(faction => ({ side: faction.side, policy: policyId(faction), outcome: faction.outcome })) })) }; }) };
}
const started = performance.now(), runs: RunResult[] = [], selectedPairs = pairs.slice(0, pairLimit);
const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const seedLabel = seeds.length <= 2 ? seeds.join('-') : `${seeds[0]}-plus${seeds.length - 1}`;
const reportPath = `runtime-data/qualification/ai-regression-${execution}-${suite}-${seedLabel}-${tickLimit}ticks-${pairLimit}pairs-${engineIdentity.engineBuildHash.slice(0,12)}-${runId}.json`;
await mkdir('runtime-data/qualification', { recursive: true });
for (const pair of selectedPairs) for (const seed of seeds) for (const reversed of [false, true]) {
  const runStart = performance.now(), policies = reversed ? [...pair.policies].reverse() : pair.policies;
  const factions: PublicPlayer[] = policies.map((policy, side) => ({ id: `side_${side}`, name: `Side ${side + 1}`, teamId: `side_${side}`, color: TEAM_IDENTITIES[side]!.color, pattern: side, kind: 'ai', ...policy }));
  // Both halves retain the same IDs/secret random stream as well as the same map.
  // The run label is external; only policy assignment changes between these games.
  const mapSeed = `at66_${seed}`, sim = createSimulation({ seed: mapSeed, factions, matchId: `at66_${pair.label}_${seed}`, populationLimit: 120, mapType: 'open_frontier', mapSize: 'small' });
  const data = Object.fromEntries(factions.map(faction => [faction.id, metrics()]));
  for (const faction of factions) assert.deepEqual(sim.view(faction.id).self.resources, balance.start.resources);
  console.log(JSON.stringify({ event: 'ai_pair_started', pair: pair.label, seed, reversed, tickLimit, modelAvailability: 'unconfigured; rule fallback only' }));
  let previousSample = 0, strikes = 0;
  const cooldowns = new Map<string, number>();
  for (let tick = 0; tick < tickLimit && sim.state.status === 'RUNNING'; tick++) {
    sim.step(); drain(sim, data);
    const committed = new Map(sim.committedUnitActions().map(action => [action.id, action.kind]));
    // Observe cooldown resets without feeding hidden information to commanders.
    // Attackers removed during this same tick cannot be counted by this observer;
    // report this diagnostic honestly, separately from exact accepted-order cadence.
    for (const entity of Object.values(sim.state.entities)) if (entity.kind !== 'resource') {
      if (entity.kind === 'unit' && entity.typeId === 'villager' && entity.hp > 0) {
        const exposure = data[entity.ownerId]!.exactWorkers, action = committed.get(entity.id); exposure.survivingWorkerTicks++;
        if (action === 'gather_food' || action === 'gather_wood' || action === 'mine') exposure.gatherWorkerTicks++;
        else if (action === 'build') exposure.buildWorkerTicks++;
        else if (action === 'repair') exposure.repairWorkerTicks++;
        else if (action === 'carry' && entity.taskState === 'returning') exposure.cargoReturnMovementWorkerTicks++;
      }
      if (entity.cooldown > (cooldowns.get(entity.id) ?? 0)) { strikes++; data[entity.ownerId]!.observedStrikeCooldownResets++; }
      cooldowns.set(entity.id, entity.cooldown);
    }
    if (sim.state.tick % hz === 0) { observe(sim, data, sim.state.tick - previousSample); previousSample = sim.state.tick; }
    if (sim.state.tick % (hz * 60) === 0) {
      const live = new Set(Object.keys(sim.state.entities)); for (const id of cooldowns.keys()) if (!live.has(id)) cooldowns.delete(id);
      console.log(JSON.stringify({ event: 'ai_pair_progress', pair: pair.label, seed, reversed, tick: sim.state.tick, age: factions.map(f => sim.state.economies[f.id]!.age), elapsedSeconds: Math.round((performance.now() - runStart) / 1000) }));
    }
  }
  assert(sim.state.status === 'FINISHED' || sim.state.tick === tickLimit, 'EARLY_NONTERMINAL_STOP');
  assert(sim.state.status !== 'FINISHED' || sim.state.result, 'MISSING_TERMINAL_RESULT');
  if (sim.state.tick > previousSample) observe(sim, data, sim.state.tick - previousSample);
  const result: RunResult = { pair: pair.label, seed, reversed, mapSeed, finalTick: sim.state.tick, status: sim.state.status, result: sim.state.result ?? null, observedStrikeCooldownResets: strikes,
    elapsedSeconds: (performance.now() - runStart) / 1000, factions: factions.map(faction => factionResult(sim, faction, data[faction.id]!)) };
  runs.push(result); console.log(JSON.stringify({ event: 'ai_pair_completed', ...result }));
  const completeSelectedRuns = runs.length === selectedPairs.length * seeds.length * 2;
  const complete = completeSelectedRuns && selectedPairs.length === pairs.length;
  const report = { profile: 'AT-66 paired ordinary-start policy regression; no model endpoint', execution, runId, sampling: 'Assigned-work-state utilization, production and composition use right-endpoint samples every simulation second (plus a partial last second), not exact time integrals. Assigned work includes gathering/returning/building/repairing states, including surplus assigned workers, and excludes moving to work. Unit-producing buildings only contribute production exposure; empty queues, ordinary waiting, and explicit population/exit/prerequisite blockage are separate. Exact worker exposure counts surviving Villagers after every step; same-tick deaths are excluded from numerator and denominator. Committed worker fractions use the final per-unit committed action recorded that tick: gather/mine, build (including reseed), repair, or actual cargo movement while returning. Later same-tick actions can supersede earlier work; these counts are not resource or HP output. Sampled and per-tick denominators are never combined. Accepted attack-order ticks are exact; multiple attack orders on one tick form one batch. Cooldown-reset counts exclude attackers removed during the same tick. Memory byte peaks are sampled once per second.',
    distributions: 'Empirical nearest-rank percentiles; null metrics are missing, never zero-imputed. Unreached ages and tick-limit-censored outcomes are explicit. Pooled utilization is exposure-weighted within its own sampled or exact denominator; per-run distributions weight each run equally. Aggregate attack intervals are interval-weighted, not run-weighted. byPolicy mixes unequal opponent portfolios and is descriptive only; matchup/side strata support paired comparison. Composition zero is used only for a unit type absent from a nonempty army.',
    modelAvailability: 'unconfigured; fallback policy only', contentHash, ...engineIdentity, hardware: { cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryMiB: Math.round(os.totalmem() / 1048576) },
    suite, seeds, tickLimit, pairLimit, availablePairs: pairs.length, selectedPairCount: selectedPairs.length, completeSelectedRuns, complete,
    completeMeaning: 'All matchups in the named suite completed both sides of every requested seed without --pairs truncation. Finished or tick-limit-censored runs both count as executed; this is coverage, not a balance pass.',
    coverage: { availableMatchups: pairs.map(pair=>pair.label), selectedMatchups: selectedPairs.map(pair=>pair.label), excludedMatchups: pairs.slice(selectedPairs.length).map(pair=>pair.label), completeDifficultyAndPersonalityMatrix: suite === 'all' && complete },
    elapsedSeconds: (performance.now() - started) / 1000, aggregates: aggregates(runs), runs };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ event: 'ai_regression_report', path: reportPath, execution, runId, complete: report.complete, completeSelectedRuns, completeDifficultyAndPersonalityMatrix: report.coverage.completeDifficultyAndPersonalityMatrix, completedRuns: runs.length }));
}
