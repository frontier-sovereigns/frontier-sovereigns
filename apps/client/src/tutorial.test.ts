import { describe, expect, it } from 'vitest';
import type { GameplayCommand, PlayerView, ViewEntity } from '@frontier/shared';
import { advanceTutorial, LESSONS, startTutorial, type CommandObservation, type LessonId } from './Tutorial';

const unit = (id: string, typeId = 'villager', ownerId = 'me'): ViewEntity => ({ id, kind: 'unit', typeId, ownerId, xMm: 1000, zMm: 1000, hp: 50, maxHp: 50, order: 'idle', taskState: 'idle' });
const building = (id: string, typeId: string, progress = 1): ViewEntity => ({ id, kind: 'building', typeId, ownerId: 'me', xMm: 12000, zMm: 12000, hp: 100, maxHp: 100, progress, queue: [] });
function view(tick = 20): PlayerView {
  return { protocolVersion: 2, contentHash: 'tutorial-fixture', matchId: 'practice', matchEpoch: 1, tick, sequence: tick, playerId: 'me', status: 'RUNNING', map: { widthMm: 64000, heightMm: 64000, fogCellMm: 2000 }, self: { lastCommandSequence: 0, resources: { food: 200, wood: 250, gold: 100, stone: 150 }, age: 1, population: 7, populationCap: 15, populationLimit: 120, reservedPopulation: 0, recentLedger: [] }, players: [{ id: 'me', name: 'Host', teamId: 'blue', kind: 'human', color: '#0088ff' }, { id: 'enemy', name: 'Practice', teamId: 'red', kind: 'ai', color: '#ff4400' }], entities: [unit('worker'), unit('scout', 'scout'), building('initial-house', 'house'), building('town', 'town_center')], fog: { visible: [], explored: [] }, effects: [] };
}
function atLesson(id: LessonId, initial = view(0)) {
  const state = startTutorial(initial);
  for (const [prior] of LESSONS) { if (prior === id) break; state.completed[prior] = 1; }
  return state;
}
function event(command: GameplayCommand, changes: Partial<CommandObservation> = {}): CommandObservation {
  return { envelope: { protocolVersion: 2, matchId: 'practice', matchEpoch: 1, clientCommandId: `command-${command.kind}`, clientSequence: 1, command }, receipt: { status: 'accepted', clientCommandId: `command-${command.kind}`, tick: 10, sequence: 1 }, sentTick: 10, ...changes };
}
const move = () => event({ kind: 'move', unitIds: ['worker'], target: { xMm: 10000, zMm: 1000 }, queued: false }, { origins: { worker: { xMm: 1000, zMm: 1000 } } });
const gather = () => event({ kind: 'gather', unitIds: ['worker'], targetId: 'forage', queued: false });
const train = (type: 'villager' | 'militia', quantity = 1) => event({ kind: 'train', buildingId: type === 'villager' ? 'town' : 'barracks', unitType: type, quantity });

describe('tutorial lessons require observed gameplay completion', () => {
  it('selects an owned Villager and advances only the current lesson', () => {
    const initial = view(); initial.entities.push(unit('enemy-worker', 'villager', 'enemy'));
    expect(advanceTutorial(null, initial, ['enemy-worker'], []).completed).toEqual({});
    expect(advanceTutorial(null, initial, ['scout'], []).completed).toEqual({});
    const next = advanceTutorial(null, initial, ['worker'], []);
    expect(next.completed).toEqual({ select: initial.tick }); expect(next.initialUnitIds).toEqual(['worker', 'scout']);
  });

  it('waits for displacement and arrival instead of accepted movement or a blocked near-target position', () => {
    const state = atLesson('move'), current = view();
    expect(advanceTutorial(state, current, ['worker'], [move()]).completed.move).toBeUndefined();
    current.entities[0] = { ...current.entities[0]!, xMm: 7000, order: 'move', taskState: 'blocked', blockedReason: 'PATH_BLOCKED' };
    expect(advanceTutorial(state, current, ['worker'], [move()]).completed.move).toBeUndefined();
    current.entities[0] = { ...current.entities[0]!, xMm: 9000, order: 'move', taskState: 'moving', blockedReason: undefined };
    expect(advanceTutorial(state, current, ['worker'], [move()]).completed.move).toBeUndefined();
    current.entities[0] = { ...current.entities[0]!, xMm: 10000, order: 'idle', taskState: 'idle', blockedReason: undefined };
    expect(advanceTutorial(state, current, [], [move()]).completed.move).toBe(current.tick);
  });

  it('rejects a move without its observed origin or one that moved only a negligible distance', () => {
    const state = atLesson('move'), current = view(); current.entities[0]!.xMm = 10000;
    expect(advanceTutorial(state, current, [], [{ ...move(), origins: undefined }]).completed.move).toBeUndefined();
    const almost = move(); almost.origins!.worker = { xMm: 9900, zMm: 1000 };
    expect(advanceTutorial(state, current, [], [almost]).completed.move).toBeUndefined();
  });

  it('requires carrying followed by a real deposit ledger entry, ignoring bank increases and earlier deposits', () => {
    const state = atLesson('gather'), current = view(); current.self.resources.food += 100;
    current.self.recentLedger = [{ tick: 20, reason: 'tribute_received', resource: 'food', deltaMilli: 100000, balanceMilli: 300000 }];
    expect(advanceTutorial(state, current, [], [gather()]).completed.gather).toBeUndefined();
    current.entities[0]!.cargo = { resource: 'food', amount: 4 };
    const carrying = advanceTutorial(state, current, [], [gather()]); expect(carrying.cargoTick).toBe(20); expect(carrying.completed.gather).toBeUndefined();
    const deposited = view(30); deposited.entities[0]!.cargo = { resource: null, amount: 0 };
    deposited.self.recentLedger = [{ tick: 19, reason: 'deposit', resource: 'food', deltaMilli: 10000, balanceMilli: 210000 }];
    expect(advanceTutorial(carrying, deposited, [], []).completed.gather).toBeUndefined();
    deposited.self.recentLedger[0]!.tick = 29;
    expect(advanceTutorial(carrying, deposited, [], []).completed.gather).toBe(30);
  });

  it('does not count an accepted House order, initial House, wrong building, or unfinished foundation as completed construction', () => {
    const state = atLesson('house'), current = view(), command = event({ kind: 'build', buildingType: 'house', builderIds: ['worker'], originCell: { x: 10, z: 10 }, rotation: 0, queued: false });
    expect(advanceTutorial(state, current, [], [command]).completed.house).toBeUndefined();
    current.entities.push(building('new-mill', 'mill')); expect(advanceTutorial(state, current, [], [command]).completed.house).toBeUndefined();
    const house = building('new-house', 'house', .99); current.entities.push(house);
    expect(advanceTutorial(state, current, [], [command]).completed.house).toBeUndefined();
    house.progress = 1; expect(advanceTutorial(state, current, [], [command]).completed.house).toBe(20);
  });

  it('waits for a new owned trained Villager and never substitutes the existing workers or a blocked queue', () => {
    const state = atLesson('villagers'), current = view();
    current.entities.find(entity => entity.id === 'town')!.queue = [{ id: 'paid-worker', kind: 'train', typeId: 'villager', progress: 1, started: true, state: 'exit_blocked' }];
    expect(advanceTutorial(state, current, [], [train('villager')]).completed.villagers).toBeUndefined();
    current.entities.push(unit('enemy-new', 'villager', 'enemy'), unit('new-scout', 'scout'));
    expect(advanceTutorial(state, current, [], [train('villager')]).completed.villagers).toBeUndefined();
    current.entities.push(unit('new-worker')); expect(advanceTutorial(state, current, [], [train('villager')]).completed.villagers).toBe(20);
    expect(advanceTutorial(state, current, [], []).completed.villagers).toBeUndefined();
  });

  it('requires every commanded wall cell to finish with the matching material', () => {
    const state = atLesson('defenses'), current = view(), cells = [{ x: 10, z: 10 }, { x: 11, z: 10 }, { x: 12, z: 10 }];
    const command = event({ kind: 'build_wall', builderIds: ['worker'], material: 'palisade', cells, queued: false });
    current.entities.push(...cells.map((cell, i) => ({ ...building(`wall-${i}`, 'palisade_wall', i === 2 ? .9 : 1), xMm: cell.x * 2000 + 1000, zMm: cell.z * 2000 + 1000 })));
    expect(advanceTutorial(state, current, [], [command]).completed.defenses).toBeUndefined();
    const last = current.entities.at(-1)!; last.progress = 1; last.typeId = 'stone_wall';
    expect(advanceTutorial(state, current, [], [command]).completed.defenses).toBeUndefined();
    last.typeId = 'palisade_wall'; expect(advanceTutorial(state, current, [], [command]).completed.defenses).toBe(20);
  });

  it('requires a completed Barracks and three newly produced Militia rather than paid queue slots', () => {
    const state = atLesson('troops'), current = view(), command = train('militia', 3);
    current.entities.push(building('barracks', 'barracks'), unit('militia-a', 'militia'), unit('militia-b', 'militia'));
    expect(advanceTutorial(state, current, [], [command]).completed.troops).toBeUndefined();
    current.entities.push(unit('militia-c', 'militia')); current.entities.find(entity => entity.id === 'barracks')!.progress = .5;
    expect(advanceTutorial(state, current, [], [command]).completed.troops).toBeUndefined();
    current.entities.find(entity => entity.id === 'barracks')!.progress = 1;
    expect(advanceTutorial(state, current, [], [command]).completed.troops).toBe(20);
  });

  it('waits for the authoritative age instead of an accepted or fully progressed age job', () => {
    const state = atLesson('age'), current = view(), command = event({ kind: 'advance_age', townCenterId: 'town', targetAge: 2 });
    current.entities.find(entity => entity.id === 'town')!.queue = [{ id: 'age', kind: 'age', typeId: 'age_2', state: 'active', progress: 1, started: true }];
    expect(advanceTutorial(state, current, [], [command]).completed.age).toBeUndefined();
    current.self.age = 2; expect(advanceTutorial(state, current, [], [command]).completed.age).toBe(20);
    expect(advanceTutorial(state, current, [], []).completed.age).toBeUndefined();
  });

  it('does not infer a kill from concealment or ghost HP and accepts only visible loss or an authorized target death', () => {
    const state = atLesson('attack'), current = view(), command = event({ kind: 'attack_target', unitIds: ['scout'], targetId: 'enemy-house', queued: false }, { targetHp: 600 });
    expect(advanceTutorial(state, current, [], [command]).completed.attack).toBeUndefined();
    const enemy = { ...building('enemy-house', 'house'), ownerId: 'enemy', hp: 500, maxHp: 600, ghost: true }; current.entities.push(enemy);
    expect(advanceTutorial(state, current, [], [command]).completed.attack).toBeUndefined();
    enemy.ghost = false; expect(advanceTutorial(state, current, [], [command]).completed.attack).toBe(20);
    current.entities.pop(); current.effects = [{ id: 'other-death', kind: 'death', entityId: 'another-target', xMm: 12000, zMm: 12000, tick: 19 }];
    expect(advanceTutorial(state, current, [], [command]).completed.attack).toBeUndefined();
    current.effects[0]!.entityId = 'enemy-house'; expect(advanceTutorial(state, current, [], [command]).completed.attack).toBe(20);
  });

  it('freezes completion and command ingestion during disconnection, loading and pause', () => {
    const state = atLesson('move'), current = view(); current.entities[0]!.xMm = 10000;
    for (const status of ['PAUSED', 'LOADING', 'COUNTDOWN', 'FINISHED'] as const) {
      current.status = status; const paused = advanceTutorial(state, current, [], [move()]); expect(paused.completed).toEqual(state.completed); expect(paused.events).toEqual([]);
    }
    current.status = 'RUNNING'; const disconnected = advanceTutorial(state, current, [], [move()], false);
    expect(disconnected.completed).toEqual(state.completed); expect(disconnected.events).toEqual([]);
    expect(advanceTutorial(disconnected, current, [], [move()], true).completed.move).toBe(20);
  });

  it('drops future completions, carrying evidence and events on rollback, then waits for fresh evidence', () => {
    const state = atLesson('gather'); state.lastTick = 100; state.cargoTick = 80; state.completed.move = 60; state.completed.gather = 90;
    const past = move(), future = gather(); future.sentTick = 70; future.receipt.tick = 71; state.events = [past, future];
    const restored = view(40), next = advanceTutorial(state, restored, [], [future]);
    expect(next.completed).toEqual({ select: 1 }); expect(next.cargoTick).toBeUndefined(); expect(next.events).toEqual([past]); expect(next.lastTick).toBe(40);
    const newMatch = advanceTutorial(next, { ...restored, matchId: 'other-practice' }, [], [past]); expect(newMatch.completed).toEqual({}); expect(newMatch.events).toEqual([]);
  });

  it('ignores rejected, foreign-match and future receipts and deduplicates retransmitted accepted commands', () => {
    const state = atLesson('villagers'), current = view(), accepted = train('villager'); current.entities.push(unit('new-worker'));
    const rejected = structuredClone(accepted); rejected.receipt.status = 'rejected';
    const foreign = structuredClone(accepted); foreign.envelope.matchId = 'another-match';
    const future = structuredClone(accepted); future.receipt.tick = current.tick + 1;
    expect(advanceTutorial(state, current, [], [rejected, foreign, future]).events).toEqual([]);
    const next = advanceTutorial(state, current, [], [accepted, accepted]); expect(next.events).toHaveLength(1); expect(next.completed.villagers).toBe(20);
  });
});
