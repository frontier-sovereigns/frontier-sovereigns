import { expect, it } from 'vitest';
import { balance, buildings, type Difficulty } from '@frontier/shared';
import { createSimulation, type Building, type ResourceNode, type Unit } from '../src/index.js';

/** A saved-game-shaped shortage: the old seven patrol points are explored, but
 * the last wooded corner is not. Setup is synthetic; recovery uses real fog,
 * controller admission, movement, cargo deposits and automatic farm reseeding. */
function shortage(kind: 'ai' | 'human', difficulty: Difficulty = 'medium') {
  const simulation = createSimulation({ matchId: 'resource_exploration', seed: 'resource_exploration', controllers: true, sharedVision: false, factions: [
    { id: 'settlement', name: 'Settlement', teamId: 'a', kind, difficulty, color: '#0072f5' },
    { id: 'other', name: 'Other', teamId: 'b', kind: 'human', color: '#f07800' },
  ] });
  simulation.state.widthMm = simulation.state.heightMm = 96000;
  simulation.state.map.terrain = [];
  const own = Object.values(simulation.state.entities).filter(entity => entity.ownerId === 'settlement');
  const home = own.find(entity => entity.typeId === 'town_center') as Building;
  const workers = own.filter(entity => entity.typeId === 'villager') as Unit[];
  const scout = own.find(entity => entity.typeId === 'scout') as Unit;
  for (const entity of Object.values(simulation.state.entities)) {
    if (entity.kind === 'resource' || entity.ownerId === 'other' && entity.typeId !== 'town_center') delete simulation.state.entities[entity.id];
    else if (entity.ownerId === 'other') { entity.xMm = 88000; entity.zMm = 10000; }
    else if (entity === home) { entity.xMm = 18000; entity.zMm = 18000; }
    else if (entity.kind === 'building') { entity.xMm = 10000; entity.zMm = 26000; }
    else { entity.xMm = 23000 + workers.indexOf(entity as Unit) * 1500; entity.zMm = 26000; }
    if (entity.kind === 'unit') { entity.orders = []; entity.path = []; entity.autoGather = false; entity.stance = 'stand_ground'; }
  }
  scout.xMm = scout.zMm = 32000;
  const farmDefinition = buildings.farm;
  const farms = [0, 1].map(index => {
    const farm: Building = { ...structuredClone(home), id: `empty_farm_${index}`, typeId: 'farm', xMm: 32000, zMm: 16000 + index * 8000,
      hp: farmDefinition.maxHp, maxHp: farmDefinition.maxHp, grantedHp: farmDefinition.maxHp,
      work: farmDefinition.buildSeconds * balance.rules.simulationHz * 100, required: farmDefinition.buildSeconds * balance.rules.simulationHz * 100,
      foodRemaining: 0, queue: [] };
    const farmer = workers[index]!;
    farmer.xMm = farm.xMm + farmDefinition.footprintCells[0] * 1000 + 850; farmer.zMm = farm.zMm;
    farmer.orders = [{ kind: 'gather', targetId: farm.id, phase: 'gather' }];
    farmer.taskState = 'blocked'; farmer.blockedReason = 'INSUFFICIENT_RESOURCES'; farm.farmerId = farmer.id;
    simulation.state.entities[farm.id] = farm;
    return farm;
  });
  const tree: ResourceNode = { id: 'last_unseen_tree', kind: 'resource', ownerId: null, typeId: 'tree_oak', resource: 'wood',
    amount: 3000 * balance.rules.resourceScale, xMm: 84000, zMm: 84000, hp: 1, maxHp: 1 };
  simulation.state.entities[tree.id] = tree;
  const economy = simulation.state.economies.settlement!;
  economy.resources = { food: 0, wood: kind === 'ai' ? 10000 : 0, gold: 0, stone: 0 };
  economy.autoReseed = true;
  const width = simulation.state.widthMm / (balance.rules.fogGridM * 1000);
  for (const [playerId, vision] of Object.entries(simulation.state.vision)) {
    vision.memory = {}; vision.actions = {}; vision.visible = [];
    vision.explored = playerId === 'settlement' ? Array.from({ length: width * width }, (_, index) => index)
      .filter(index => index % width < 36 || Math.floor(index / width) < 36) : [];
  }
  simulation.state.navigationRevision++;
  (simulation as unknown as { updateVision(): void }).updateVision();
  if (kind === 'human') {
    simulation.configureAssistant('settlement', { modelId: 'local', enabled: true, reserve: { food: 0, wood: 0, gold: 0, stone: 0 } });
    const receipt = simulation.command('settlement', { protocolVersion: 2, matchId: simulation.state.matchId, matchEpoch: 1,
      clientSequence: 1, clientCommandId: 'manual_hold', command: { kind: 'hold_position', unitIds: [workers.at(-1)!.id] } });
    expect(receipt.status).toBe('accepted');
  }
  return { simulation, workers, scout, farms, tree, economy };
}

it('scouting decisions are identical when undiscovered wood moves within hidden terrain', () => {
  const first = shortage('ai'), second = shortage('ai');
  second.tree.xMm = 92000; second.tree.zMm = 92000;
  second.simulation.state.navigationRevision++;
  expect(first.simulation.view('settlement')).toEqual(second.simulation.view('settlement'));
  for (let tick = 0; tick < 60; tick++) { first.simulation.step(); second.simulation.step(); }
  expect(first.simulation.view('settlement').entities.some(entity => entity.id === first.tree.id)).toBe(false);
  expect(second.simulation.view('settlement').entities.some(entity => entity.id === second.tree.id)).toBe(false);
  const proposals = (fixture: ReturnType<typeof shortage>) => fixture.simulation.state.commandLog
    .filter(row => row.playerId === 'settlement').map(row => ({ tick: row.tick, command: row.envelope.command }));
  expect(proposals(first).some(row => row.command.kind === 'move')).toBe(true);
  expect(proposals(first)).toEqual(proposals(second));
  expect(first.scout.orders).toEqual(second.scout.orders);
  expect({ xMm: first.scout.xMm, zMm: first.scout.zMm }).toEqual({ xMm: second.scout.xMm, zMm: second.scout.zMm });
});

function recover(kind: 'ai' | 'human', difficulty: Difficulty = 'medium', activeModel = false) {
  const { simulation, workers, farms, tree, economy } = shortage(kind, difficulty);
  const renewPlan = () => {
    const request = simulation.prepareAiRequest('settlement', `renew_${simulation.state.controllers.settlement!.observationNonce + 1}`);
    // Valid strategic output without a scout goal, matching the live-save case.
    // Completion uses normal binding/admission but makes no endpoint request.
    const completion = simulation.completeAiRequest(request.binding, { kind: 'plan', plan: {
      schemaVersion: 1, observationId: request.binding.observationId, strategy: 'Recover the settlement economy.',
      goals: [{ kind: 'economy', weights: { food: 60, wood: 40, gold: 0, stone: 0 }, targetVillagers: workers.length },
        { kind: 'ensure_units', unitType: 'militia', targetCount: 1 }], message: null,
    } });
    expect(completion.accepted).toBe(true);
    expect(simulation.state.controllers.settlement!.mode).toBe('model');
  };
  if (activeModel) renewPlan();
  const protectedWorker = kind === 'human' ? workers.at(-1)! : undefined;
  const protectedPosition = protectedWorker && { xMm: protectedWorker.xMm, zMm: protectedWorker.zMm };
  expect(simulation.view('settlement').entities.some(entity => entity.id === tree.id)).toBe(false);
  expect(farms.every(farm => farm.foodRemaining === 0)).toBe(true);
  let observedAt: number | undefined;
  for (let tick = 0; tick < 6000; tick++) {
    if (activeModel && tick > 0 && tick % (60 * balance.rules.simulationHz) === 0) renewPlan();
    simulation.step();
    if (observedAt === undefined && simulation.view('settlement').entities.some(entity => entity.id === tree.id && !entity.ghost)) {
      observedAt = simulation.state.tick;
      if (activeModel) expect(simulation.state.controllers.settlement!.mode).toBe('model');
    }
    if (farms.some(farm => (farm.foodRemaining ?? 0) > 0)) break;
  }
  expect(observedAt, 'the scout must reveal a real previously unknown resource').toBeDefined();
  const gathers = simulation.state.commandLog.filter(row => row.playerId === 'settlement' && row.envelope.command.kind === 'gather' && row.envelope.command.targetId === tree.id);
  expect(gathers.length, 'the ordinary controller must assign workers to discovered wood').toBeGreaterThan(0);
  expect(gathers.every(row => row.tick >= observedAt!)).toBe(true);
  expect(economy.collected.wood, 'wood must actually arrive at a drop-off').toBeGreaterThan(0);
  expect(economy.ledger.some(row => row.reason === 'farm_reseed' && row.resource === 'wood' && row.deltaMilli < 0)).toBe(true);
  expect(farms.some(farm => (farm.foodRemaining ?? 0) > 0), 'an empty farm must finish reseeding').toBe(true);
  if (activeModel) {
    expect(simulation.state.controllers.settlement!.mode).toBe('model');
    expect(economy.statistics.fallbackTicks).toBe(0);
    expect(economy.statistics.modelReadyTicks).toBe(simulation.state.tick);
    expect(simulation.state.controllers.settlement!.plan!.goals.every(goal => goal.kind !== 'scout')).toBe(true);
  }
  if (protectedWorker) {
    expect(simulation.assistantState('settlement').protectedEntityIds).toContain(protectedWorker.id);
    expect(protectedWorker.orders).toEqual([]);
    expect({ xMm: protectedWorker.xMm, zMm: protectedWorker.zMm }).toEqual(protectedPosition);
    expect(economy.lastClientSequence).toBe(1);
  }
}

it.each(['ai', 'human'] as const)('a starving medium %s explores unseen wood, deposits it and resumes empty farms', kind => recover(kind), 60000);

it.each([{ kind: 'ai', difficulty: 'easy' }, { kind: 'human', difficulty: 'medium' }] as const)(
  'an active model without scouting goals lets starving $difficulty $kind recover unseen wood and reseed',
  ({ kind, difficulty }) => recover(kind, difficulty, true), 60000,
);
