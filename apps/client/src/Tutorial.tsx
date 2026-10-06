import { useEffect, useRef, useState } from 'react';
import { balance, validateClientCommand, validateServerSocketMessage, type ClientCommandEnvelope, type CommandReceipt, type GameplayCommand, type PlayerView, type Position } from '@frontier/shared';
import type { World } from './World';

export interface CommandObservation { envelope: ClientCommandEnvelope; receipt: CommandReceipt; sentTick: number; initialUnitIds?: string[]; origins?: Record<string, Position>; targetHp?: number }
export const LESSONS = [
  ['select', 'Your people', 'Select a Villager in the world, or use the Villagers button. A selection ring identifies the people receiving your orders.'],
  ['move', 'Give an order', 'With a Villager selected, right-click nearby clear ground. Wait for the Villager to reach it. Shift adds another destination to the queue.'],
  ['gather', 'Bring resources home', 'Select Villagers and right-click forage or a tree, or use a Gather button. Watch them carry resources and deposit at your Town Center.'],
  ['house', 'Room to grow', 'Select a Villager, choose House, and click clear explored ground near your Town Center. Wait for construction to finish.'],
  ['villagers', 'Grow your economy', 'Select your Town Center and train a Villager. The lesson completes when the new worker appears. Keep other workers gathering food and wood.'],
  ['defenses', 'Defend the approach', 'Select a Villager, choose Palisade Wall, then drag a short straight line of at least three cells. Leave a route to resources and wait for all segments to finish.'],
  ['troops', 'Raise a company', 'Build a Barracks, then train three Militia. Select new troops with the Army button. Keep Villagers gathering while production runs.'],
  ['age', 'A new age', 'Build a Mill as your second qualifying building. Gather the food and gold shown at your Town Center, then advance to Settlement Age. Age work uses its production queue; wait for completion.'],
  ['attack', 'Meet the frontier', 'Send your Scout outward into unexplored ground. When a practice enemy becomes visible, select troops and right-click it. A peripheral House is safer than the defended Town Center. The lesson completes on real visible damage.'],
] as const;
export type LessonId = typeof LESSONS[number][0];
export interface TutorialState {
  matchId: string; playerId: string; startedTick: number; lastTick: number; initialUnitIds: string[]; initialBuildingIds: string[];
  completed: Partial<Record<LessonId, number>>; cargoTick?: number; events: CommandObservation[];
}
export function startTutorial(view: PlayerView): TutorialState {
  return { matchId: view.matchId, playerId: view.playerId, startedTick: view.tick, lastTick: view.tick, initialUnitIds: view.entities.filter(e => e.ownerId === view.playerId && e.kind === 'unit').map(e => e.id), initialBuildingIds: view.entities.filter(e => e.ownerId === view.playerId && e.kind === 'building').map(e => e.id), completed: {}, events: [] };
}
export function advanceTutorial(prior: TutorialState | null, view: PlayerView, selection: string[], observations: CommandObservation[], connected = true): TutorialState {
  let state = !prior || prior.matchId !== view.matchId || prior.playerId !== view.playerId ? startTutorial(view) : structuredClone(prior);
  if (view.tick < state.lastTick) {
    state.completed = Object.fromEntries(Object.entries(state.completed).filter(([, tick]) => tick <= view.tick));
    state.events = state.events.filter(event => event.receipt.tick <= view.tick && event.sentTick <= view.tick);
    if ((state.cargoTick ?? 0) > view.tick) delete state.cargoTick;
    state.startedTick = Math.min(state.startedTick, view.tick);
  }
  state.lastTick = view.tick;
  if (!connected || view.status !== 'RUNNING') return state;
  for (const event of observations) if (event.envelope.matchId === view.matchId && event.receipt.status === 'accepted' && event.sentTick >= state.startedTick && event.receipt.tick <= view.tick && !state.events.some(old => old.envelope.clientCommandId === event.envelope.clientCommandId)) state.events.push(structuredClone(event));
  state.events = state.events.slice(-96);
  const owned = view.entities.filter(e => e.ownerId === view.playerId && !e.ghost), complete = (type: string) => owned.some(e => e.typeId === type && e.kind === 'building' && e.progress === 1);
  const commands = <K extends GameplayCommand['kind']>(kind: K) => state.events.filter(event => event.envelope.command.kind === kind) as (CommandObservation & { envelope: ClientCommandEnvelope & { command: Extract<GameplayCommand, { kind: K }> } })[];
  const gather = commands('gather');
  if (!state.cargoTick && gather.some(event => owned.some(entity => event.envelope.command.unitIds.includes(entity.id) && (entity.cargo?.amount ?? 0) > 0))) state.cargoTick = view.tick;
  const newUnits = (type: string) => owned.filter(e => e.typeId === type && !state.initialUnitIds.includes(e.id));
  const trained = (type: string, count: number) => newUnits(type).length >= count && commands('train').filter(e => e.envelope.command.unitType === type).reduce((n, e) => n + e.envelope.command.quantity, 0) >= count;
  const evidence: Record<LessonId, () => boolean> = {
    select: () => owned.some(e => e.typeId === 'villager' && selection.includes(e.id)),
    move: () => commands('move').some(event => event.envelope.command.unitIds.some(id => {
      const entity = owned.find(e => e.id === id), origin = event.origins?.[id];
      return !!entity && entity.typeId === 'villager' && entity.taskState !== 'blocked' && entity.taskState !== 'moving' && entity.order !== 'move' && !!origin && Math.hypot(entity.xMm - origin.xMm, entity.zMm - origin.zMm) >= 1500 && Math.hypot(entity.xMm - event.envelope.command.target.xMm, entity.zMm - event.envelope.command.target.zMm) <= 2500 + Math.sqrt(event.envelope.command.unitIds.length) * 600;
    })),
    gather: () => !!state.cargoTick && gather.some(event => view.self.recentLedger?.some(row => row.reason === 'deposit' && row.deltaMilli > 0 && row.tick >= event.receipt.tick && row.tick >= state.cargoTick!)),
    house: () => commands('build').some(event => event.envelope.command.buildingType === 'house') && owned.some(e => e.typeId === 'house' && e.progress === 1 && !state.initialBuildingIds.includes(e.id)),
    villagers: () => trained('villager', 1),
    defenses: () => commands('build_wall').some(event => event.envelope.command.cells.length >= 3 && event.envelope.command.cells.every(cell => owned.some(e => e.typeId === (event.envelope.command.material === 'palisade' ? 'palisade_wall' : 'stone_wall') && e.progress === 1 && Math.floor(e.xMm / (balance.rules.buildingGridM * 1000)) === cell.x && Math.floor(e.zMm / (balance.rules.buildingGridM * 1000)) === cell.z))),
    troops: () => complete('barracks') && trained('militia', 3),
    age: () => view.self.age >= 2 && commands('advance_age').some(event => event.envelope.command.targetAge === 2),
    attack: () => commands('attack_target').some(event => {
      const target = view.entities.find(e => e.id === event.envelope.command.targetId && !e.ghost);
      return event.targetHp !== undefined && (target !== undefined && target.hp < event.targetHp || view.effects?.some(effect => effect.kind === 'death' && effect.entityId === event.envelope.command.targetId && effect.tick >= event.receipt.tick));
    }),
  };
  const current = LESSONS.find(([id]) => state.completed[id] === undefined);
  if (current && evidence[current[0]]()) state.completed[current[0]] = view.tick;
  return state;
}

function storedTutorial(view: PlayerView): TutorialState | null {
  try {
    const text = localStorage.getItem(`frontier.tutorial.${view.matchId}.${view.playerId}`); if (!text || text.length > 250_000) return null;
    const value = JSON.parse(text) as TutorialState;
    // This is a local lesson journal, never a simulation command or authority flag.
    if (value.matchId !== view.matchId || value.playerId !== view.playerId || !Number.isSafeInteger(value.startedTick) || !Number.isSafeInteger(value.lastTick) || !Array.isArray(value.initialUnitIds) || !Array.isArray(value.initialBuildingIds) || !value.completed || !Array.isArray(value.events) || value.events.length > 96) return null;
    if (Object.entries(value.completed).some(([id, tick]) => !LESSONS.some(([key]) => key === id) || !Number.isSafeInteger(tick) || tick < 0)) return null;
    if (value.initialUnitIds.length > 2200 || value.initialBuildingIds.length > 3000 || [...value.initialUnitIds, ...value.initialBuildingIds].some(id => typeof id !== 'string' || id.length > 96)) return null;
    if (value.events.some(event => !event || !validateClientCommand(event.envelope) || !validateServerSocketMessage({ type: 'receipt', receipt: event.receipt }) || !Number.isSafeInteger(event.sentTick) || event.sentTick < 0 || event.targetHp !== undefined && (!Number.isFinite(event.targetHp) || event.targetHp < 0) || event.origins && (typeof event.origins !== 'object' || Object.values(event.origins).some(point => !point || !Number.isFinite(point.xMm) || !Number.isFinite(point.zMm))))) return null;
    return value;
  } catch { return null; }
}
export function Tutorial({ view, selection, observations, connection, world }: { view: PlayerView; selection: string[]; observations: CommandObservation[]; connection: string; world: World }) {
  const tracker = useRef<TutorialState | null>(null), [state, setState] = useState<TutorialState | null>(null), [collapsed, setCollapsed] = useState(false), savedAt = useRef(-1);
  useEffect(() => {
    if (!tracker.current) tracker.current = storedTutorial(view);
    const next = advanceTutorial(tracker.current, view, selection, observations, connection === 'Connected');
    tracker.current = next; setState(next);
    if (view.tick - savedAt.current >= balance.rules.simulationHz || view.tick < savedAt.current) { savedAt.current = view.tick; try { localStorage.setItem(`frontier.tutorial.${view.matchId}.${view.playerId}`, JSON.stringify(next)); } catch { /* Optional local journal. */ } }
  }, [view, selection, observations, connection]);
  const step = LESSONS.findIndex(([id]) => state?.completed[id] === undefined), current = LESSONS[Math.max(0, step)], finished = step < 0;
  return <section className={`tutorial-guide ${collapsed ? 'collapsed' : ''}`} aria-label="Guided first game"><header><span className="eyebrow">QUIET PRACTICE · {finished ? 'COMPLETE' : `${step + 1} / ${LESSONS.length}`}</span><button className="quiet-button" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? 'Expand tutorial' : 'Collapse tutorial'}>{collapsed ? 'Show' : 'Hide'}</button></header>
    {!collapsed && <><h2>{finished ? 'Your frontier is ready.' : current![1]}</h2><p>{finished ? 'You completed every lesson through real game actions. Keep practicing, or use End as draw and return to the lobby for a normal match.' : current![2]}</p><progress aria-label="Tutorial progress" max={LESSONS.length} value={Object.keys(state?.completed ?? {}).length}/>
      {!finished && <button className="quiet-button" onClick={() => { const type = ['villagers', 'age'].includes(current![0]) ? 'town_center' : current![0] === 'troops' ? 'barracks' : 'villager'; const target = view.entities.find(e => e.ownerId === view.playerId && e.typeId === type); if (target) { world.select([target.id]); world.focus(target.xMm, target.zMm); } }}>Find {['villagers', 'age'].includes(current![0]) ? 'Town Center' : current![0] === 'troops' ? 'Barracks' : 'a Villager'}</button>}
      <small>{connection !== 'Connected' || view.status !== 'RUNNING' ? 'Lessons wait while the match is paused or the view is synchronizing.' : 'The practice opponent stays in place. Its units and Town Center still defend themselves.'}</small>
    </>}
  </section>;
}
