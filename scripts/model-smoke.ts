import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { contentHash, TEAM_IDENTITIES, validateAiPlan, type EndpointProbeResponse } from '@frontier/shared';
import { engineIdentity } from '../apps/server/src/build-info.js';
import { EndpointConfiguration } from '../apps/server/src/ai-endpoint.js';
import { AiScheduler } from '../apps/server/src/ai-scheduler.js';
import { SimulationBridge } from '../apps/server/src/bridge.js';

// This command uses only the operator's explicit local configuration. It never starts a model server.
const config = new EndpointConfiguration(resolve(process.env.GAME_DATA_DIR ?? 'runtime-data'));
await config.load();
if (!config.state().configured) {
  console.error(JSON.stringify({ passed: false, code: 'REAL_ENDPOINT_NOT_CONFIGURED', instructions: 'Configure the host Endpoint panel or local .env, then rerun corepack pnpm test:model.' })); process.exitCode = 2;
} else {
  const scheduler = new AiScheduler(config), accepted = new Set<string>(), bridge = new SimulationBridge(), started = performance.now();
  const snapshot = config.snapshot(); let timer: NodeJS.Timeout | undefined, probe:EndpointProbeResponse|undefined;
  try {
    probe = await scheduler.probe(true);console.log(JSON.stringify({event:'real_endpoint_probe',...probe}));
    if (!probe.success) throw new Error(probe.status);
    await bridge.init({ seed: 'real-endpoint-five-commanders-v1', matchId: 'real_endpoint_smoke', epoch: 1, mapType: 'open_frontier', mapSize: 'large', populationLimit: 80,
      factions: ['builder', 'raider', 'marshal', 'steward', 'diplomat'].map((personality, index) => ({ id: `ai_${index + 1}`, name: `Commander ${index + 1}`, teamId: `team_${index + 1}`, color: TEAM_IDENTITIES[index]!.color, pattern: index, kind: 'ai' as const, difficulty: 'hard' as const, personality: personality as 'builder' | 'raider' | 'marshal' | 'steward' | 'diplomat' })) });
    await bridge.status('RUNNING');
    await scheduler.setDriver({ aiSchedulingState: () => bridge.aiSchedulingState(), prepareAiRequest: (...args) => bridge.prepareAiRequest(...args), invalidateAiRequests: reason => bridge.invalidateAiRequests(reason),
      completeAiRequest: async (binding, result) => {
        const completion = await bridge.completeAiRequest(binding, result); if (completion.accepted) accepted.add(binding.playerId);
        let validation:unknown;
        if(result.kind==='plan'&&!completion.accepted){
          // Fixed schema paths and keywords only; never log model text, arbitrary
          // field values, prompts, credentials or private observation contents.
          const plan=result.plan,valid=validateAiPlan(plan);
          validation=valid?{category:plan.observationId===binding.observationId?'admission':'observation_binding'}:{category:'schema_or_semantic',errors:(validateAiPlan.errors??[]).slice(0,12).map(({keyword,schemaPath})=>({keyword,schemaPath}))};
        }
        console.log(JSON.stringify({event:'real_commander_result',playerId:binding.playerId,accepted:completion.accepted,code:completion.code,elapsedMs:Math.round(performance.now()-started),...(validation?{validation}:{})})); return completion;
      } });
    timer = setInterval(() => { void scheduler.poll(); }, 250);
    const timeout = Math.max(180000, snapshot.settings.timeoutSeconds * 5000 + 60000), deadline = performance.now() + timeout;
    while (accepted.size < 5 && performance.now() < deadline) {
      await new Promise(done => setTimeout(done, 1000));
      const state = await bridge.aiSchedulingState(); if (state.status !== 'RUNNING') throw new Error(`SIMULATION_${state.status}`);
      if (scheduler.diagnostics().failed >= 5) throw new Error('FIVE_PLAN_FAILURES');
    }
    if (accepted.size !== 5) throw new Error('FIVE_COMMANDER_SMOKE_TIMEOUT');
    console.log(JSON.stringify({ passed: true, ...engineIdentity, contentHash, provider: snapshot.settings.providerProfile, model: snapshot.settings.model, outputMode: config.state().capability.mode, probe, acceptedCommanders: [...accepted], elapsedMs: Math.round(performance.now() - started), scheduler: scheduler.diagnostics(), simulation: await bridge.diagnostics(), limits: 'Compatibility smoke; not a throughput, maximum-population, or model-colocation qualification.' }, null, 2));
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z_]{1,95}$/.test(error.message) ? error.message : 'REAL_ENDPOINT_SMOKE_FAILED';
    console.error(JSON.stringify({ passed: false, ...engineIdentity, contentHash, code, provider: snapshot.settings.providerProfile, model: snapshot.settings.model, outputMode:config.state().capability.mode,probe,acceptedCommanders: [...accepted],elapsedMs:Math.round(performance.now()-started),scheduler: scheduler.diagnostics() }, null, 2)); process.exitCode = 1;
  } finally { clearInterval(timer); await scheduler.close(); await bridge.close(); }
}
