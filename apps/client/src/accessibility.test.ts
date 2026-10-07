import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HostDiagnosticsResponse, PlayerView, ViewEntity } from '@frontier/shared';
import { deriveAudioEvents } from './GameAudio';
import { defaultPreferences, HOTKEYS, heldPanKey, matchesHotkey, rebind, suppressGameplayHotkeys, validPreferences } from './preferences';
import { isIdleWorker, nextIdleWorker, resolveContextOrder } from './contextOrder';
import { CommanderRequestDiagnostics, MovementCadenceDiagnostics, FrameDiagnostics, DeliveryDiagnostics } from './EndpointPanel';
import { OpponentStatus } from './CombatControls';

const entity = (id = 'worker', changes: Partial<ViewEntity> = {}): ViewEntity => ({ id, kind: 'unit', typeId: 'villager', ownerId: 'me', xMm: 10000, zMm: 10000, hp: 50, maxHp: 50, visualAction: { kind: 'idle', startedTick: 0 }, ...changes });
function view(tick = 10): PlayerView {
  return { protocolVersion: 2, contentHash: 'audio-fixture', matchId: 'match', matchEpoch: 1, tick, sequence: tick, playerId: 'me', status: 'RUNNING', map: { widthMm: 64000, heightMm: 64000, fogCellMm: 2000 }, self: { lastCommandSequence: 0, resources: { food: 200, wood: 250, gold: 100, stone: 150 }, age: 1, population: 7, populationCap: 15, populationLimit: 120, reservedPopulation: 0 }, players: [{ id: 'me', name: 'Host', teamId: 'blue', kind: 'human', color: '#0088ff' }], entities: [entity()], fog: { visible: [], explored: [] }, effects: [] };
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('public opponent status', () => {
  const render = (players: PlayerView['players'], playerId = 'me') => renderToStaticMarkup(createElement(OpponentStatus, { players, playerId }));
  const player = (id: string, teamId: string, defeated = false): PlayerView['players'][number] => ({ id, name: id, teamId, defeated, kind: 'ai', color: '#abcdef' });

  it('counts opposing factions and distinct teams while keeping eliminated factions and allies in the roster', () => {
    const players = [player('me', 'blue'), player('ally', 'blue'), player('fallen ally', 'blue', true), player('north', 'team_Xi15gNPwu1QV'), player('south', 'team_Xi15gNPwu1QV'), player('east', 'green'), player('fallen enemy', 'yellow', true)];
    const html = render(players);
    expect(html).toContain('3 factions · 2 teams');
    expect(html).toContain('<summary>'); expect(html).toContain('aria-live="polite"'); expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('data-gameplay-hotkeys="suspend"'); expect(html).toContain('aria-label="Faction status"');
    expect(html).toContain('ally<small>Ally · Team 1</small></span><strong>Active');
    expect(html).toContain('fallen enemy<small>Opponent · Team 4</small></span><strong>Eliminated');
    expect(html).toContain('me<small>You · Team 1');
    expect(html).toContain('north<small>Opponent · Team 2');
    expect(html).toContain('south<small>Opponent · Team 2');
    expect(html).not.toContain('team_Xi15gNPwu1QV');
    expect(render(players, 'fallen ally')).toContain('3 factions · 2 teams');
  });

  it('keeps an unseen surviving faction active until the host marks it defeated', () => {
    const current = view();
    current.entities = [];
    current.players.push({ ...player('Last <banner>', 'red'), defeated: undefined }, player('fallen enemy', 'green', true));
    const html = render(current.players);
    expect(html).toContain('1 faction · 1 team');
    expect(html).toContain('Last &lt;banner&gt;<small>Opponent · Team 2</small></span><strong>Active');
    expect(html).toContain('units outside your sight');
    current.players[1]!.defeated = true;
    const eliminated = render(current.players);
    expect(eliminated).toContain('0 factions · 0 teams');
    expect(eliminated).toContain('Victory is confirmed by the match result.');
    expect(eliminated).toContain('Last &lt;banner&gt;<small>Opponent · Team 2</small></span><strong>Eliminated');
    expect(eliminated).toContain('fallen enemy<small>Opponent · Team 3');
  });
});

it('labels committed frame timing and nested phase elapsed costs without inventing unreported measurements',()=>{
  expect(renderToStaticMarkup(createElement(FrameDiagnostics,{frame:undefined}))).toBe('');
  const text=renderToStaticMarkup(createElement(FrameDiagnostics,{frame:{frameRevision:8,committedTimeMs:2400,authoritativeIntervalMs:300,phases:{total:220,movement:160,navigationPreparation:40,combat:8}}}));
  expect(text).toContain('Frame 8; committed game time 2.4 seconds; 300 ms');expect(text).toContain('Movement (includes preparation)');expect(text).toContain('160 ms');
  expect(text).toContain('Navigation preparation (overlapping)');expect(text).toContain('Not reported');expect(text).toContain('Overlapping phases must not be added together');expect(text).toContain('not CPU usage');
});

it('labels adaptive movement cadence separately from simulation speed and omits absent diagnostics',()=>{
  const pacing={policy:'adaptive' as const,speedPercent:40,tickIntervalMs:125,reductions:6,selfPaced:true,deferredWallMs:0,lastReduction:null};
  expect(renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing}))).toBe('');
  const text=renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing:{...pacing,movementTier:3,movementDecisionIntervalMs:200,publicationIntervalMs:200,tierChanges:3,lastTierChange:{tick:1200,fromTier:2,toTier:3,reason:'sustained_overload'}}}));
  expect(text).toContain('Adaptive movement');expect(text).toContain('Reduced 3');expect(text).toContain('200 ms');expect(text).toContain('intervals are game time');expect(text).toContain('Game speed is reported separately');expect(text).toContain('sustained overload');expect(text).not.toContain('40%');
  const coarse=renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing:{...pacing,authoritativeIntervalMs:600,tickIntervalMs:1500,movementTier:2,movementDecisionIntervalMs:600,publicationIntervalMs:600}}));
  expect(coarse).toContain('600 ms');expect(coarse).toContain('Authoritative frames advance 600 ms');expect(coarse).toContain('from 300 to 450 to 600 ms');expect(coarse).toContain('authorized movement history');expect(coarse).not.toContain('publication stays at 300 ms');
  const pressured={...pacing,movementTier:2 as const,authoritativeIntervalMs:600 as const,memoryRecoveryBlocked:true};
  expect(renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing:pressured}))).toContain('Automatic speed recovery is waiting for available host RAM');
  expect(renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing:{...pressured,memoryRecoveryBlocked:false}}))).not.toContain('Close unused applications');
  expect(renderToStaticMarkup(createElement(MovementCadenceDiagnostics,{pacing:{...pressured,speedPercent:100}}))).not.toContain('Close unused applications');
  expect(coarse).not.toContain('Close unused applications');
});

it('separates queued local detours and route hints from confirmed movement',()=>{
  const text=renderToStaticMarkup(createElement(FrameDiagnostics,{frame:{frameRevision:8,committedTimeMs:2400,authoritativeIntervalMs:300,phases:{},localPlanning:{mode:'deferred-v1',waitingForCredit:3,queued:2,inflight:1,ready:0,retry:1,oldestWaitMs:5000,prepared:8,admitted:4,used:2,discarded:1}}}));
  expect(text).toContain('Local detours');expect(text).toContain('Waiting for search allowance');expect(text).toContain('Oldest wait (game time)');expect(text).toContain('not confirmed movement');expect(text).toContain('Prepared searches can remain unexecuted');
});

it('labels per-commander stages, sample counts and timeouts separately from accepted plans and queue waits',()=>{
  const metric=(p95:number)=>({p50:p95,p95,max:p95});
  const requests:NonNullable<HostDiagnosticsResponse['scheduler']['commanders'][number]['requests']>={completed:12,failed:4,queueSamples:16,queueDelayMs:metric(123.45),stages:{
    preparation:{samples:16,durationMs:metric(14),failures:1,timeouts:1},
    endpoint:{samples:15,durationMs:metric(900),failures:2,timeouts:1},
    application:{samples:13,durationMs:metric(20),failures:1,timeouts:0},
  }};
  const text=renderToStaticMarkup(createElement(CommanderRequestDiagnostics,{requests,commanderName:'<Forge> & ally'}));
  expect(text).toContain('<summary>12 accepted plans / 4 failed requests</summary>');
  expect(text).toContain('Queue delay (95th percentile): 123.5 ms from 16 sampled waits.');
  expect(text).toContain('<caption>Request stages for &lt;Forge&gt; &amp; ally</caption>');
  expect(text).toContain('<th scope="col">Timeouts</th>');
  expect(text).toContain('<th scope="row">Game observation preparation</th><td>16</td><td>14 ms</td><td>1</td><td>1</td>');
  expect(text).toContain('<th scope="row">Endpoint HTTP and parsing</th><td>15</td><td>900 ms</td><td>2</td><td>1</td>');
  expect(text).toContain('<th scope="row">Game plan application</th><td>13</td><td>20 ms</td><td>1</td><td>0</td>');
  expect(text).toContain('include waiting and are not CPU measurements');expect(text).toContain('Counts survive pauses');
  expect(text).toContain('new or reloaded match, model configuration change or host restart resets them');
});

it('omits optional older-host commander metrics and labels missing durations instead of inventing zero latency',()=>{
  expect(renderToStaticMarkup(createElement(CommanderRequestDiagnostics,{requests:undefined,commanderName:'Commander'}))).toBe('');
  const empty={p50:0,p95:0,max:0},stage={samples:0,durationMs:empty,failures:0,timeouts:0};
  const text=renderToStaticMarkup(createElement(CommanderRequestDiagnostics,{commanderName:'Commander',requests:{completed:0,failed:0,queueSamples:0,queueDelayMs:empty,stages:{preparation:stage,endpoint:stage,application:stage}}}));
  expect(text).toContain('<summary>0 accepted plans / 0 failed requests</summary>');
  expect(text).toContain('Not reported from 0 sampled waits');expect(text.match(/Not reported/g)).toHaveLength(4);expect(text).not.toContain('0 ms');
  const measured=renderToStaticMarkup(createElement(CommanderRequestDiagnostics,{commanderName:'Commander',requests:{completed:1,failed:0,queueSamples:1,queueDelayMs:empty,stages:{preparation:stage,endpoint:stage,application:{...stage,samples:1}}}}));
  expect(measured).toContain('Queue delay (95th percentile): 0 ms from 1 sampled waits');
  expect(measured).toContain('<th scope="row">Game plan application</th><td>1</td><td>0 ms</td>');expect(measured.match(/Not reported/g)).toHaveLength(2);
});

describe('idle worker navigation', () => {
  it('counts only living available villagers without active or queued work', () => {
    expect(isIdleWorker(entity())).toBe(true);
    expect(isIdleWorker(entity('idle', { order: 'idle', taskState: 'idle', queuedOrderCount: 0 }))).toBe(true);
    const unavailable: Partial<ViewEntity>[] = [
      { hp: 0 }, { ghost: true }, { garrisonedIn: 'town' }, { typeId: 'militia' }, { kind: 'building' },
      { order: 'gather', taskState: 'idle' }, { order: 'idle', taskState: 'moving' },
      { order: 'idle', taskState: 'blocked' }, { order: 'idle', queuedOrderCount: 1 },
    ];
    for (const changes of unavailable) expect(isIdleWorker(entity('unavailable', changes)), JSON.stringify(changes)).toBe(false);
  });

  it('cycles one owned idle worker in stable ID order and wraps regardless of snapshot ordering', () => {
    const snapshot = view(); snapshot.entities = [
      entity('c'), entity('enemy', { ownerId: 'enemy' }), entity('a'), entity('busy', { order: 'build' }),
      entity('ally', { ownerId: 'ally' }), entity('b'),
    ];
    const originalIds = snapshot.entities.map(worker => worker.id);
    expect(nextIdleWorker(snapshot, [])?.id).toBe('a');
    expect(nextIdleWorker(snapshot, ['a'])?.id).toBe('b');
    expect(nextIdleWorker(snapshot, ['b'])?.id).toBe('c');
    expect(nextIdleWorker(snapshot, ['c'])?.id).toBe('a');
    expect(nextIdleWorker(snapshot, ['busy', 'enemy'])?.id).toBe('a');
    expect(snapshot.entities.map(worker => worker.id)).toEqual(originalIds);
    snapshot.entities.reverse();
    expect(nextIdleWorker(snapshot, ['a'])?.id).toBe('b');
    snapshot.entities = [entity('only')];
    expect(nextIdleWorker(snapshot, ['only'])?.id).toBe('only');
    snapshot.entities[0]!.queuedOrderCount = 1;
    expect(nextIdleWorker(snapshot, [])).toBeNull();
  });
});

describe('recipient-authorized hover and contextual orders', () => {
  it('explicit mobile garrison admits ordinary soldiers but never workers, siege or another colossal unit',()=>{
    const snapshot=view(),crown=entity('crown',{typeId:'crown_colossus'});snapshot.entities.push(crown,entity('soldier',{typeId:'militia'}),entity('ram',{typeId:'ironhide_ram'}),entity('giant',{typeId:'stone_warden'}));
    expect(resolveContextOrder(snapshot,['worker','soldier','ram','giant'],crown)?.command?.kind).toBe('move');
    expect(resolveContextOrder(snapshot,['worker','soldier','ram','giant'],crown,false,'garrison')?.command).toEqual({kind:'garrison',unitIds:['soldier'],targetId:'crown',queued:false});
    expect(resolveContextOrder(snapshot,['worker','ram','giant'],crown,false,'garrison')?.command).toBeNull();crown.ghost=true;expect(resolveContextOrder(snapshot,['soldier'],crown,false,'garrison')?.command).toBeNull();
  });
  it('explains forest edge gathering without inventing an undisclosed working tree',()=>{
    const snapshot=view(),node=entity('tree',{kind:'resource',typeId:'tree_oak',ownerId:null,resource:'wood',amount:100,forest:{patchId:'visible_patch',cellMm:3000}});
    snapshot.entities.push(node);
    expect(resolveContextOrder(snapshot,['worker'],node)).toEqual({label:'Chop wood at forest edge',cursor:'pointer',command:{kind:'gather',unitIds:['worker'],targetId:'tree',queued:false}});
  });
  it.each(['food', 'wood', 'gold', 'stone'] as const)('previews %s work and dispatches exactly the previewed worker-only order', resource => {
    const snapshot = view(), node = entity('node', { kind: 'resource', typeId: resource === 'wood' ? 'wood_oak' : `${resource}_deposit`, ownerId: null, resource, amount: 500 });
    snapshot.entities.push(node, entity('soldier', { typeId: 'militia' }));
    const preview = resolveContextOrder(snapshot, ['worker', 'soldier'], node)!;
    expect(preview.label).toBe(({ food: 'Gather food', wood: 'Chop wood', gold: 'Mine gold', stone: 'Mine stone' })[resource]);
    expect(preview.command).toEqual({ kind: 'gather', unitIds: ['worker'], targetId: 'node', queued: false });
    expect(resolveContextOrder(snapshot, ['worker', 'soldier'], node, true)?.command).toEqual({ ...preview.command, queued: true });
    node.amount = 0; expect(resolveContextOrder(snapshot, ['worker'], node)?.command?.kind).toBe('move');
  });

  it.each(['me', 'ally'])('never offers an attack on a %s building, retaining repair and explicit garrison intents', ownerId => {
    const snapshot = view(); snapshot.players.push({ ...snapshot.players[0]!, id: 'ally' });
    const town = entity('town', { kind: 'building', typeId: 'town_center', ownerId, progress: 1 }); snapshot.entities.push(town);
    const attack = resolveContextOrder(snapshot, ['worker'], town, false, 'attack_target');
    expect(attack).toEqual({ label: 'Cannot attack allies', cursor: 'not-allowed', command: null });
    expect(resolveContextOrder(snapshot, ['worker'], town)?.command?.kind).toBe('move');
    expect(resolveContextOrder(snapshot, ['worker'], town, false, 'garrison')?.command?.kind).toBe('garrison');
    town.hp -= 1; expect(resolveContextOrder(snapshot, ['worker'], town)?.command?.kind).toBe('repair');
    town.typeId = 'house'; town.hp = town.maxHp;
    expect(resolveContextOrder(snapshot, ['worker'], town)?.command?.kind).toBe('move');
    expect(resolveContextOrder(snapshot, ['worker'], town, false, 'garrison')?.command).toBeNull();
  });

  it.each(['town_center', 'watchtower', 'fortress'])('requires explicit Garrison mode to enter a friendly %s', typeId => {
    const snapshot = view(); snapshot.players.push({ ...snapshot.players[0]!, id: 'ally' });
    snapshot.entities.push(entity('soldier', { typeId: 'militia' }));
    snapshot.entities[0]!.cargo = { resource: 'gold', amount: 10 };
    const target = entity('building', { kind: 'building', typeId, progress: 1 }); snapshot.entities.push(target);
    for (const ownerId of ['me', 'ally']) for (const queued of [false, true]) {
      target.ownerId = ownerId;
      expect(resolveContextOrder(snapshot, ['worker', 'soldier'], target, queued)).toEqual({
        label: 'Move', cursor: 'move', command: { kind: 'move', unitIds: ['worker', 'soldier'], target: { xMm: target.xMm, zMm: target.zMm }, queued },
      });
      expect(resolveContextOrder(snapshot, ['worker', 'soldier'], target, queued, 'garrison')).toEqual({
        label: 'Garrison', cursor: 'pointer', command: { kind: 'garrison', unitIds: ['worker', 'soldier'], targetId: target.id, queued },
      });
    }
    target.ghost = true;
    expect(resolveContextOrder(snapshot, ['worker', 'soldier'], target, false, 'garrison')?.command).toBeNull();
    delete target.ghost; target.progress = .5;
    expect(resolveContextOrder(snapshot, ['worker', 'soldier'], target, false, 'garrison')?.command).toBeNull();
  });

  it('rechecks current team and visibility at click time without attacking remembered or unknown owners', () => {
    const snapshot = view(), foe = { ...snapshot.players[0]!, id: 'enemy', teamId: 'red' };
    snapshot.players.push(foe); const town = entity('enemy-town', { kind: 'building', typeId: 'town_center', ownerId: foe.id }); snapshot.entities.push(town);
    for (const mode of [null, 'attack_target'] as const) expect(resolveContextOrder(snapshot, ['worker'], town, false, mode)?.command).toEqual({ kind: 'attack_target', unitIds: ['worker'], targetId: town.id, queued: false });
    for (const changes of [{ ghost: true }, { ownerId: 'unknown' }, { garrisonedIn: 'transport' }]) {
      Object.assign(town, changes);
      expect(resolveContextOrder(snapshot, ['worker'], town)?.command?.kind).toBe('move');
      expect(resolveContextOrder(snapshot, ['worker'], town, false, 'attack_target')?.command).toBeNull();
      delete town.ghost; delete town.garrisonedIn; town.ownerId = foe.id;
    }
    foe.teamId = 'blue'; expect(resolveContextOrder(snapshot, ['worker'], town, false, 'attack_target')?.command).toBeNull();
    snapshot.entities.pop(); expect(resolveContextOrder(snapshot, ['worker'], town, false, 'attack_target')?.command).toBeNull();
  });

  it('allows clearing visible surviving enemy walls after defeat but refuses dead, remembered, neutral and allied targets', () => {
    const snapshot = view(), defeated = { ...snapshot.players[0]!, id: 'defeated', teamId: 'red', defeated: true };
    snapshot.players.push(defeated);
    const wall = entity('remaining-wall', { kind: 'building', typeId: 'palisade_wall', ownerId: defeated.id, hp: 15 }); snapshot.entities.push(wall);
    for (const mode of [null, 'attack_target'] as const) expect(resolveContextOrder(snapshot, ['worker'], wall, true, mode)?.command).toEqual({ kind: 'attack_target', unitIds: ['worker'], targetId: wall.id, queued: true });
    for (const changes of [{ hp: 0 }, { ghost: true }, { ownerId: null }]) {
      Object.assign(wall, changes);
      expect(resolveContextOrder(snapshot, ['worker'], wall)?.command?.kind).toBe('move');
      expect(resolveContextOrder(snapshot, ['worker'], wall, false, 'attack_target')?.command).toBeNull();
      wall.hp = 15; delete wall.ghost; wall.ownerId = defeated.id;
    }
    defeated.teamId = 'blue'; expect(resolveContextOrder(snapshot, ['worker'], wall, false, 'attack_target')?.command).toBeNull();
  });

  it('preserves construction, friendly ready farms, siege exclusions and producer rally orders', () => {
    const snapshot = view(), foundation = entity('house', { kind: 'building', typeId: 'house', progress: .2 }); snapshot.entities.push(foundation);
    expect(resolveContextOrder(snapshot, ['worker'], foundation)?.command).toEqual({ kind: 'continue_build', builderIds: ['worker'], foundationId: 'house', queued: false });
    const farm = entity('farm', { kind: 'building', typeId: 'farm', progress: 1, farmState: 'ready', amount: 200, resource: 'food' }); snapshot.entities.push(farm);
    expect(resolveContextOrder(snapshot, ['worker'], farm)?.command?.kind).toBe('gather');
    farm.ghost = true; expect(resolveContextOrder(snapshot, ['worker'], farm)?.command?.kind).toBe('move');
    const town = entity('town', { kind: 'building', typeId: 'town_center', progress: 1 }); snapshot.entities.push(town, entity('siege', { typeId: 'catapult' }));
    expect(resolveContextOrder(snapshot, ['worker', 'siege'], town, false, 'garrison')?.command).toEqual({ kind: 'garrison', unitIds: ['worker'], targetId: 'town', queued: false });
    expect(resolveContextOrder(snapshot, ['town'], { xMm: 15000, zMm: 16000 })?.command).toEqual({ kind: 'set_rally', buildingId: 'town', target: { xMm: 15000, zMm: 16000 } });
    expect(resolveContextOrder(snapshot, [], town)).toBeNull();
  });
});

describe('recipient-authorized audio events', () => {
  it('stays silent for initial views, another match/player/epoch, duplicate ticks, rollback and pause', () => {
    const before = view(), next = view(20); next.entities[0]!.visualAction = { kind: 'gather_wood', startedTick: 15 };
    expect(deriveAudioEvents(null, next)).toEqual([]);
    for (const changes of [{ matchId: 'other' }, { playerId: 'other' }, { matchEpoch: 2 }, { tick: 10 }, { tick: 5 }, { status: 'PAUSED' as const }, { status: 'LOADING' as const }]) expect(deriveAudioEvents(before, { ...next, ...changes })).toEqual([]);
  });

  it('never creates sounds from concealed entities, ghost changes or contained units', () => {
    const before = view(), next = view(20); next.entities = []; expect(deriveAudioEvents(before, next)).toEqual([]);
    next.entities = [entity('worker', { ghost: true, hp: 1, visualAction: { kind: 'gather_wood', startedTick: 15 } }), entity('contained', { garrisonedIn: 'town', visualAction: { kind: 'attack', startedTick: 15, durationTicks: 20 } })];
    expect(deriveAudioEvents(before, next)).toEqual([]);
  });

  it('emits one observed work/action onset and never replays a continuing or stale action', () => {
    const before = view(), next = view(20);
    const kinds = ['gather_food', 'gather_wood', 'mine', 'build', 'repair'] as const;
    next.entities = kinds.map((kind, index) => entity(`visible-${index}`, { ownerId: 'enemy', visualAction: { kind, startedTick: 15 } }));
    expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['gather_food', 'gather_wood', 'mine', 'build', 'build']);
    expect(deriveAudioEvents(next, { ...next, tick: 21 })).toEqual([]);
    next.entities[0]!.visualAction!.startedTick = 5; expect(deriveAudioEvents(before, next).map(sound => sound.id)).not.toContain('gather_food');
  });

  it('maps actual attack actions to melee, arrow and siege cues and deduplicates authorized impacts', () => {
    const before = view(), next = view(20);
    next.entities = ['militia', 'archer', 'catapult'].map(typeId => entity(typeId, { typeId, visualAction: { kind: 'attack', startedTick: 15, durationTicks: 20 } }));
    next.effects = [{ id: 'arrow-impact', kind: 'impact', projectileKind: 'arrow', tick: 18, xMm: 20000, zMm: 20000 }, { id: 'stone-impact', kind: 'impact', projectileKind: 'stone', tick: 19, xMm: 21000, zMm: 20000 }];
    expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['melee', 'arrow', 'siege_launch', 'arrow', 'siege_impact']);
    expect(deriveAudioEvents(next, { ...next, tick: 21 })).toEqual([]);
  });

  it('alerts on actual owned damage, construction completion and newly blocked production without repeats', () => {
    const before = view(), next = view(20); before.entities.push(entity('house', { kind: 'building', typeId: 'house', progress: .8 }), entity('town', { kind: 'building', typeId: 'town_center', queue: [] }));
    next.entities = structuredClone(before.entities); next.entities[0]!.hp = 45; next.entities[1]!.progress = 1;
    next.entities[2]!.queue = [{ kind: 'train', typeId: 'villager', id: 'blocked', progress: 0, state: 'population_blocked' }];
    expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['construction_complete', 'under_attack', 'population_blocked']);
    expect(deriveAudioEvents(before, next).filter(sound => sound.alert)).toHaveLength(2);
    expect(deriveAudioEvents(next, { ...next, tick: 21 })).toEqual([]);
  });

  it('alerts for an authorized lethal hit even when the owned victim disappears between snapshots', () => {
    const before = view(), next = view(20); next.entities = [];
    next.effects = [{ id: 'lethal-hit', kind: 'hit', tick: 18, entityId: 'worker', ownerId: 'me', typeId: 'villager', visualAge: 1, visualTier: 'base', xMm: 10000, zMm: 10000 }, { id: 'death', kind: 'death', tick: 18, entityId: 'worker', ownerId: 'me', typeId: 'villager', visualAge: 1, visualTier: 'base', xMm: 10000, zMm: 10000 }];
    expect(deriveAudioEvents(before, next).filter(sound => sound.id === 'under_attack')).toHaveLength(1);
    expect(deriveAudioEvents(next, { ...next, tick: 21 })).toEqual([]);
    for (const effect of next.effects) effect.ownerId = 'enemy'; expect(deriveAudioEvents(before, next)).toEqual([]);
  });

  it('announces actual age completion and terminal victory/defeat once, leaving draws silent', () => {
    const before = view(), next = view(20); next.self.age = 2;
    expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['age_up']);
    next.status = 'FINISHED'; next.result = { reason: 'conquest', winnerTeamId: 'blue' };
    expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['age_up', 'victory']);
    next.result.winnerTeamId = 'red'; expect(deriveAudioEvents(before, next).map(sound => sound.id)).toEqual(['age_up', 'defeat']);
    next.self.age = 1; next.result.winnerTeamId = null; expect(deriveAudioEvents(before, next)).toEqual([]);
    expect(deriveAudioEvents(next, { ...next, tick: 21 })).toEqual([]);
  });
});

describe('validated and optional local accessibility preferences', () => {
  it.each([['panForward','arrowup'],['panBack','arrowdown'],['panLeft','arrowleft'],['panRight','arrowright']] as const)('keeps the %s arrow alias until that arrow is assigned to another action', (action, arrow) => {
    const defaults = defaultPreferences(), held = new Set([arrow]);
    expect(heldPanKey(held, action, defaults)).toBe(true);
    const rebound = rebind(defaults, 'stop', arrow);
    expect(matchesHotkey({ key: arrow }, 'stop', rebound)).toBe(true);
    for (const direction of ['panForward','panBack','panLeft','panRight'] as const) expect(heldPanKey(held, direction, rebound)).toBe(false);
    expect(heldPanKey(new Set([defaults.bindings[action]]), action, rebound)).toBe(true);
  });
  it('does not pan in two directions when an arrow is explicitly reassigned to a different camera action', () => {
    const preferences = rebind(defaultPreferences(), 'panRight', 'ArrowUp'), held = new Set(['arrowup']);
    expect(heldPanKey(held, 'panRight', preferences)).toBe(true);
    expect(heldPanKey(held, 'panForward', preferences)).toBe(false);
    expect(heldPanKey(new Set(['d']), 'panRight', preferences)).toBe(false);
  });
  it('suppresses gameplay while a modal owns focus even if the key event has no element target', () => {
    const querySelector = vi.fn().mockReturnValue({}); vi.stubGlobal('document', { querySelector });
    expect(suppressGameplayHotkeys(null)).toBe(true);
    querySelector.mockReturnValue(null); expect(suppressGameplayHotkeys(null)).toBe(false);
  });
  it('has distinct valid defaults and immutable case-insensitive rebinding', () => {
    const original = defaultPreferences(); expect(validPreferences(original)).toBe(true); expect(new Set(Object.values(original.bindings)).size).toBe(Object.keys(HOTKEYS).length);
    const changed = rebind(original, 'move', 'L'); expect(changed.bindings.move).toBe('l'); expect(original.bindings.move).toBe('m');
    expect(matchesHotkey({ key: 'L' }, 'move', changed)).toBe(true); expect(matchesHotkey({ key: 'm' }, 'move', changed)).toBe(false);
    expect(() => rebind(original, 'move', 'W')).toThrow('already assigned'); expect(() => rebind(original, 'move', 'Control+R')).toThrow('reserved');
    expect(rebind(original, 'move', 'm').bindings.move).toBe('m');
  });

  it.each([{ quality: 'ultra' }, { uiScale: .7 }, { uiScale: 1.6 }, { musicVolume: NaN }, { effectsVolume: 2 }, { muted: 'yes' }, { reducedMotion: 1 }, { extra: true }])('rejects malformed or out-of-range preference fields %j', changes => {
    expect(validPreferences({ ...defaultPreferences(), ...changes })).toBe(false);
  });

  it('rejects missing, duplicate, unknown and forbidden bindings', () => {
    const preferences = defaultPreferences(); const { move: _move, ...incomplete } = preferences.bindings;
    for (const bindings of [incomplete, { ...preferences.bindings, move: 'w' }, { ...preferences.bindings, invented: 'l' }, { ...preferences.bindings, move: 'F5' }]) expect(validPreferences({ ...preferences, bindings })).toBe(false);
  });

  it('uses the OS reduced-motion preference and remains usable when storage is blocked', async () => {
    const windowStub = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: true }) }); vi.stubGlobal('window', windowStub);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    const preferences = await import('./preferences'), initial = preferences.readPreferences(); expect(initial.reducedMotion).toBe(true);
    initial.muted = true; preferences.writePreferences(initial); expect(preferences.readPreferences().muted).toBe(true);
    initial.bindings.move = 'z'; expect(preferences.readPreferences().bindings.move).toBe('m');
    const returned = preferences.readPreferences(); returned.uiScale = 1.5; expect(preferences.readPreferences().uiScale).toBe(1);
  });

  it('validates stored input, publishes local/cross-tab updates and removes subscriptions', async () => {
    const storage = new Map<string, string>([['frontier.preferences.v1', '{"muted":"forged"}']]), windowStub = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('window', windowStub); vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const preferences = await import('./preferences'); expect(preferences.readPreferences()).toEqual(preferences.defaultPreferences());
    const listener = vi.fn(), unsubscribe = preferences.subscribePreferences(listener), changed = { ...preferences.readPreferences(), muted: true, quality: 'low' as const };
    preferences.writePreferences(changed); expect(listener).toHaveBeenCalledTimes(1); expect(listener.mock.calls[0]![0]).toEqual(changed);
    const external = { ...changed, uiScale: 1.4 }; storage.set('frontier.preferences.v1', JSON.stringify(external));
    windowStub.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' })); expect(listener).toHaveBeenCalledTimes(1);
    windowStub.dispatchEvent(Object.assign(new Event('storage'), { key: 'frontier.preferences.v1' })); expect(listener).toHaveBeenCalledTimes(2); expect(preferences.readPreferences()).toEqual(external);
    unsubscribe(); preferences.writePreferences({ ...external, muted: false }); expect(listener).toHaveBeenCalledTimes(2);
    expect(() => preferences.writePreferences({ ...external, uiScale: 99 })).toThrow('Invalid'); expect(preferences.readPreferences().uiScale).toBe(1.4);
  });
});

it('separates gateway completion from browser receipt and never invents absent delivery timings',()=>{
  const text=renderToStaticMarkup(createElement(DeliveryDiagnostics,{delivery:undefined,playerName:(id:string)=>id}));
  expect(text).toContain('No gateway delivery samples');expect(text).toContain('does not prove browser receipt');expect(text).toContain('No browser measurements are uploaded');expect(text).toContain('This browser tab');
});
