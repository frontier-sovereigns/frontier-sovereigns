import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ages, balance, buildings, legendaryExpansion, effectiveBuilding, effectiveGatherRates, effectiveUnit, technologies, units, type BuildingId, type ChatStateResponse, type GameplayCommand, type PlayerView, type ResourceType, type SessionResponse, type TeamPing, type ViewEntity } from '@frontier/shared';
import type { World, WorldTarget } from './World';
import { EconomyActions, EconomyWindow, jobStateLabel, refundLabel } from './EconomyPanel';
import { TechnologyTree, jobDefinition } from './ResearchPanel';
import { GarrisonControls, MatchStatistics, UnitClassBadge, targetOrderText, type TargetOrder } from './CombatControls';
import { Communications, commanderModeLabel, pingSymbols } from './Communications';
import { keyLabel, matchesHotkey, suppressGameplayHotkeys, type Preferences, type Hotkey } from './preferences';
import { useModalFocus } from './modalFocus';
import type { GameAudio } from './GameAudio';
import { Tutorial, type CommandObservation } from './Tutorial';
import { AssetIcon } from './AssetIcon';
import { AssistantPanel } from './AssistantPanel';
import { isIdleWorker, nextIdleWorker, resolveContextOrder } from './contextOrder';

interface Props { view: PlayerView; session: SessionResponse; world: World; connection: string; receipt: string; pendingCount: number; error: string; clearError: () => void; send: (command: GameplayCommand) => void; post: (path: string, body: unknown) => Promise<void>; openRecovery: () => void; communication: ChatStateResponse | null; refreshCommunication: () => Promise<void>; openSettings: () => void; openEndpoint: () => void; preferences: Preferences; audio: GameAudio | null; commandObservations: CommandObservation[] }
const displayName = (entity: ViewEntity) => units[entity.typeId]?.name ?? buildings[entity.typeId]?.name ?? (entity.resource === 'food' ? 'Forage patch' : entity.resource === 'wood' ? 'Oak tree' : `${entity.resource ?? entity.typeId} deposit`);

/** Only this small readout animates; the authoritative HUD and command controls
 * continue to render the latest validated view. No queue or resource is inferred. */
export function PresentationProgress({world,entityId,jobId,committed,label}:{world:World;entityId:string;jobId?:string;committed:number;label?:string}) {
  const [value,setValue]=useState(committed);
  useEffect(()=>{
    let frame=0;
    const sample=()=>{const next=Math.min(committed,Math.max(0,world.presentationProgress(entityId,jobId)??committed));setValue(prior=>Math.abs(prior-next)<.00001?prior:next);frame=requestAnimationFrame(sample);};
    sample();return()=>cancelAnimationFrame(frame);
  },[world,entityId,jobId,committed]);
  const progress=Math.min(committed,value);
  return label===undefined?<>{Math.floor(progress*100)}%</>:<><progress max={1} value={progress}/><small>{label} {Math.floor(progress*100)}%</small></>;
}

function Minimap({ view, world, order, targeting, pings, signal }: { view: PlayerView; world: World; order: (target: WorldTarget, queued: boolean) => void; targeting: boolean; pings: TeamPing[]; signal: (point: WorldTarget) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return;
    const size = 200, columns = Math.ceil(view.map.widthMm / view.map.fogCellMm), rows = Math.ceil(view.map.heightMm / view.map.fogCellMm);
    context.fillStyle = '#111e1d'; context.fillRect(0, 0, size, size);
    for (const [cells, color] of [[view.fog.explored, '#344437'], [view.fog.visible, '#788661']] as const) {
      context.fillStyle = color;
      for (const index of cells) context.fillRect(index % columns / columns * size, Math.floor(index / columns) / rows * size, size / columns + 0.5, size / rows + 0.5);
    }
    const explored = new Set(view.fog.explored);
    for (const region of view.map.terrain ?? []) {
      context.fillStyle = region.kind === 'water' ? '#355967' : region.kind === 'bridge' ? '#c3ad87' : region.kind === 'cliff' || region.kind === 'ridge' ? '#9b9682' : region.kind === 'ramp' ? '#b4ab8c' : '#83906d';
      for (let z = Math.floor(region.zMm / view.map.fogCellMm); z < Math.ceil((region.zMm + region.depthMm) / view.map.fogCellMm); z++) for (let x = Math.floor(region.xMm / view.map.fogCellMm); x < Math.ceil((region.xMm + region.widthMm) / view.map.fogCellMm); x++) if (explored.has(z * columns + x)) context.fillRect(x / columns * size, z / rows * size, size / columns + 0.5, size / rows + 0.5);
    }
    for (const entity of view.entities) {
      if (entity.kind === 'resource' && entity.amount === 0) continue;
      context.fillStyle = entity.kind === 'resource' ? entity.resource === 'food' ? '#d7b587' : entity.resource === 'wood' ? '#3d603b' : '#d7c18a' : view.players.find((player) => player.id === entity.ownerId)?.color ?? '#ddd';
      context.globalAlpha = entity.ghost ? 0.4 : 1;
      const radius = entity.kind === 'building' ? 4 : entity.kind === 'unit' ? 2 : 1.5;
      context.fillRect(entity.xMm / view.map.widthMm * size - radius / 2, entity.zMm / view.map.heightMm * size - radius / 2, radius, radius);
    }
    context.globalAlpha = 1; context.font = 'bold 13px sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    for (const ping of pings) if (ping.expiresTick > view.tick) { const x = ping.xMm / view.map.widthMm * size, z = ping.zMm / view.map.heightMm * size; context.fillStyle = '#192c2b'; context.beginPath(); context.arc(x, z, 8, 0, Math.PI * 2); context.fill(); context.fillStyle = '#f3d39a'; context.fillText(pingSymbols[ping.category], x, z); }
    context.strokeStyle = '#f3e7c1'; context.lineWidth = 1;
    context.strokeRect(world.camera.target.x * 1000 / view.map.widthMm * size - 12, world.camera.target.z * 1000 / view.map.heightMm * size - 8, 24, 16);
  }, [view, world, pings]);
  function target(event: React.MouseEvent<HTMLCanvasElement>): WorldTarget { const rect = event.currentTarget.getBoundingClientRect(); return { xMm: Math.min(view.map.widthMm - 1, Math.round((event.clientX - rect.left) / rect.width * view.map.widthMm)), zMm: Math.min(view.map.heightMm - 1, Math.round((event.clientY - rect.top) / rect.height * view.map.heightMm)) }; }
  return <div className="minimap-panel"><div className="map-label"><span>{view.map.type === 'river_divide' ? 'RIVER DIVIDE' : 'OPEN FRONTIER'}</span><span>N ↑</span></div><canvas ref={canvas} width={200} height={200} aria-label="Minimap. Click to move camera; right-click to order selected units; Alt-click to signal teammates." data-testid="minimap" onClick={(e) => { const point = target(e); if (e.altKey) signal(point); else if (e.shiftKey || targeting) order(point, e.shiftKey); else world.focus(point.xMm, point.zMm); }} onContextMenu={(e) => { e.preventDefault(); order(target(e), e.shiftKey); }} /></div>;
}

export function GameHud({ view, session, world, connection, receipt, pendingCount, error, clearError, send, post, openRecovery, communication, refreshCommunication, openSettings, openEndpoint, preferences, audio, commandObservations }: Props) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [placement, setPlacement] = useState<BuildingId | null>(null);
  const [hint, setHint] = useState('');
  const [hover, setHover] = useState<{ x: number; y: number; label: string; blocked: boolean } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [confirmDraw, setConfirmDraw] = useState(false);
  const drawModal = useModalFocus(confirmDraw, () => setConfirmDraw(false)), surrenderModal = useModalFocus(confirmSurrender, () => setConfirmSurrender(false));
  const [orderMode, setOrderModeState] = useState<TargetOrder | null>(null);
  const orderModeRef = useRef<TargetOrder | null>(null);
  const patrolStart = useRef<WorldTarget | null>(null);
  const [economyOpen, setEconomyOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [technologyOpen, setTechnologyOpen] = useState(false);
  const [communicationOpen, setCommunicationOpen] = useState(false);
  const lastReadMessage = useRef('');
  const [rally, setRally] = useState<string | null>(null);
  const groups = useRef(new Map<string, string[]>());
  const viewRef = useRef(view); viewRef.current = view;
  const selectedRef = useRef(selectedIds); selectedRef.current = selectedIds;
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const placementRef = useRef(placement); placementRef.current = placement;
  const selection = selectedIds.map((id) => view.entities.find((entity) => entity.id === id)).filter((entity): entity is ViewEntity => !!entity);
  const owned = selection.filter((entity) => entity.ownerId === view.playerId);
  const selected = selection[0];
  const workers = owned.filter((entity) => entity.typeId === 'villager' && !entity.garrisonedIn);
  const locked = view.status !== 'RUNNING' || !['Connected', 'Delayed'].includes(connection);
  const lockedRef = useRef(locked); lockedRef.current = locked;
  useEffect(() => { world.setPings(communication?.pings ?? [], view.tick); }, [communication?.pings, view.tick, world]);
  useEffect(() => { if (communicationOpen) lastReadMessage.current = communication?.messages.at(-1)?.id ?? ''; }, [communicationOpen, communication?.messages]);
  const unread = communicationOpen ? 0 : (communication?.messages ?? []).slice((communication?.messages.findIndex((message) => message.id === lastReadMessage.current) ?? -1) + 1).filter((message) => message.senderId !== view.playerId).length;

  function setOrderMode(mode: TargetOrder | null) {
    setOrderModeState(mode); orderModeRef.current = mode; patrolStart.current = null;
    setPlacement(null); setRally(null); world.setPlacement(null); world.setRallyMode(null); world.setTargetMode(!!mode, mode?.endsWith('_gate') ? mode==='wooden_gate'?'palisade_wall':mode.replace('_gate','_wall') as BuildingId : null);
    setHint(mode === 'patrol' ? 'Choose the first patrol waypoint, then the second.' : mode?.endsWith('_gate') ? `Click the middle of ${mode==='wooden_gate'||mode==='stone_gate'?'three':'five'} straight, completed, matching walls. ${keyLabel(preferences.bindings.rotateLeft)}/${keyLabel(preferences.bindings.rotateRight)} chooses the axis.` : mode === 'garrison' ? 'Choose a friendly garrison building or Crown Colossus.' : mode === 'attack_ground' ? 'Choose explored ground for your selected siege.' : 'Click a destination or visible target. Shift queues the order.');
  }

  function targetedOrder(target: WorldTarget, queued: boolean) {
    const mode = orderModeRef.current, current = viewRef.current;
    if (!mode) { order(target, queued); return; }
    const own = current.entities.filter((entity) => selectedRef.current.includes(entity.id) && entity.ownerId === current.playerId && entity.kind === 'unit' && !entity.garrisonedIn);
    const point = { xMm: target.xMm, zMm: target.zMm };
    if (mode.endsWith('_gate')) {
      const wall = current.entities.find((entity) => entity.id === target.id && entity.ownerId === current.playerId && entity.typeId === (mode === 'wooden_gate' ? 'palisade_wall' : mode.replace('_gate','_wall')) && (entity.progress ?? 0) >= 1 && !entity.ghost);
      if (!wall) { setHint('Choose the middle segment of a completed matching wall.'); return; }
      const axisOrder = world.placementRotation % 180 ? ['zMm', 'xMm'] as const : ['xMm', 'zMm'] as const;
      const triples = axisOrder.map((axis) => (mode==='wooden_gate'||mode==='stone_gate'?[-1,0,1]:[-2,-1,0,1,2]).map((offset) => current.entities.find((entity) => entity.ownerId === current.playerId && entity.typeId === wall.typeId && (entity.progress ?? 0) >= 1 && !entity.ghost && entity.xMm === wall.xMm + (axis === 'xMm' ? offset * balance.rules.buildingGridM * 1000 : 0) && entity.zMm === wall.zMm + (axis === 'zMm' ? offset * balance.rules.buildingGridM * 1000 : 0))));
      const walls = triples.find((entries) => entries.every(Boolean));
      if (!walls) { setHint('Adjacent straight completed matching wall segments are required.'); return; }
      const builderIds = own.filter((entity) => entity.typeId === 'villager').map((entity) => entity.id);
      if (builderIds.length) send({ kind: 'replace_wall_with_gate', builderIds, wallIds: walls.map((entity) => entity!.id), queued });
    } else if (mode === 'patrol') {
      if (!patrolStart.current) { patrolStart.current = point; setHint('First waypoint chosen. Click the second waypoint to begin patrolling.'); return; }
      send({ kind: 'patrol', unitIds: own.map((entity) => entity.id), points: [patrolStart.current, point], queued });
    } else if (mode === 'attack_target' || mode === 'garrison') {
      const action = resolveContextOrder(current, selectedRef.current, target, queued, mode);
      if (!action?.command) { setHint(action?.label ?? 'Select your units first.'); return; }
      send(action.command);
    } else {
      const eligible = mode === 'attack_ground' ? own.filter((entity) => !!units[entity.typeId]?.areaDamageBands?.length) : own;
      if (eligible.length) send({ kind: mode as 'move'|'attack_move'|'attack_ground', unitIds: eligible.map((entity) => entity.id), target: point, queued });
    }
    setOrderMode(null);
  }

  function selectWhere(predicate: (entity: ViewEntity) => boolean, focus = false) {
    const entries = viewRef.current.entities.filter((entity) => entity.ownerId === viewRef.current.playerId && !entity.garrisonedIn && predicate(entity));
    world.select(entries.map((entity) => entity.id));
    if (focus && entries[0]) world.focus(entries[0].xMm, entries[0].zMm);
  }

  function cycleOwned(predicate: (entity: ViewEntity) => boolean) {
    const entries = viewRef.current.entities.filter((entity) => entity.ownerId === viewRef.current.playerId && !entity.garrisonedIn && predicate(entity));
    if (!entries.length) return;
    const current = entries.findIndex((entity) => selectedRef.current.includes(entity.id)), next = entries[(current + 1) % entries.length]!;
    world.select([next.id]); world.focus(next.xMm, next.zMm);
  }

  function selectNextIdleWorker() {
    const next = nextIdleWorker(viewRef.current, selectedRef.current);
    if (!next) return;
    setOrderMode(null);
    world.select([next.id]); world.focus(next.xMm, next.zMm);
  }

  function gatherKnown(resource: ResourceType) {
    if (!workers.length) return;
    const worker = workers[0]!;
    const team = view.players.find((player) => player.id === view.playerId)?.teamId;
    const node = view.entities.filter((entity) => (entity.kind === 'resource' || entity.typeId === 'farm' && view.players.find((player) => player.id === entity.ownerId)?.teamId === team) && entity.resource === resource && !entity.ghost && (entity.amount ?? 0) > 0).sort((a, b) => Math.hypot(a.xMm - worker.xMm, a.zMm - worker.zMm) - Math.hypot(b.xMm - worker.xMm, b.zMm - worker.zMm))[0];
    if (node) send({ kind: 'gather', unitIds: workers.map((entity) => entity.id), targetId: node.id, queued: false });
  }

  function order(target: WorldTarget, queued: boolean) {
    const action = resolveContextOrder(viewRef.current, selectedRef.current, target, queued);
    if (action?.command) send(action.command);
  }

  useEffect(() => {
    world.onHover = point => {
      const mode = orderModeRef.current;
      const action = point && !lockedRef.current ? mode && mode !== 'attack_target' && mode !== 'garrison'
        ? { label: targetOrderText[mode], cursor: 'crosshair' }
        : resolveContextOrder(viewRef.current, selectedRef.current, point.target, false, mode) : null;
      const next = point && action ? { x: point.x, y: point.y, label: `${mode ? 'Click' : 'Right-click'} · ${action.label}`, blocked: action.cursor === 'not-allowed' } : null;
      setHover(previous => previous?.x === next?.x && previous?.y === next?.y && previous?.label === next?.label && previous?.blocked === next?.blocked ? previous : next);
      return action?.cursor ?? 'default';
    };
    world.onSelection = ids => { if (ids.length && ids.join() !== selectedRef.current.join()) audio?.play('selection'); selectedRef.current = ids; setSelectedIds(ids); }; world.onDrag = setDrag; world.onPlacementHint = setHint;
    world.onTarget = targetedOrder;
    world.onWall = (cells, queued) => {
      const type = placementRef.current; if (!type?.endsWith('_wall')) return;
      const builderIds = viewRef.current.entities.filter((entity) => selectedRef.current.includes(entity.id) && entity.ownerId === viewRef.current.playerId && entity.typeId === 'villager' && !entity.garrisonedIn).map((entity) => entity.id);
      if (builderIds.length && cells.length <= 64) send({ kind: 'build_wall', builderIds, material: type.replace('_wall','') as Extract<GameplayCommand,{kind:'build_wall'}>['material'], cells, queued });
      if (!queued) { setPlacement(null); world.setPlacement(null); }
    };
    world.onRally = (buildingId, target) => { send({ kind: 'set_rally', buildingId, target: { xMm: target.xMm, zMm: target.zMm } }); setRally(null); };
    world.onOrder = (target, queued) => {
      if (orderModeRef.current) { targetedOrder(target, queued); return; }
      if (placementRef.current) { world.setPlacement(null); setPlacement(null); return; }
      order(target, queued);
    };
    world.onBuild = (target, queued) => {
      const type = placementRef.current; if (!type || type.endsWith('_wall')) return;
      const ids = viewRef.current.entities.filter((entity) => selectedRef.current.includes(entity.id) && entity.ownerId === viewRef.current.playerId && entity.typeId === 'villager' && !entity.garrisonedIn).map((entity) => entity.id);
      if (!ids.length) return;
      send({ kind: 'build', builderIds: ids, buildingType: type as Extract<GameplayCommand,{kind:'build'}>['buildingType'], originCell: { x: Math.floor(target.xMm / (balance.rules.buildingGridM * 1000)), z: Math.floor(target.zMm / (balance.rules.buildingGridM * 1000)) }, rotation: world.placementRotation, queued });
      if (!queued) { setPlacement(null); world.setPlacement(null); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (suppressGameplayHotkeys(event.target) || event.metaKey) return;
      const matches = (action: Hotkey) => matchesHotkey(event, action, preferencesRef.current);
      const group = Array.from({ length: 9 }, (_, i) => `group${i + 1}` as Hotkey).find(matches);
      if (group) { event.preventDefault(); if (event.ctrlKey) groups.current.set(group, [...selectedRef.current]); else world.select((groups.current.get(group) ?? []).filter(id => viewRef.current.entities.some(entity => entity.id === id))); return; }
      if (event.ctrlKey) return;
      if (matches('cancel')) { event.preventDefault(); setOrderMode(null); setConfirmDraw(false); setConfirmSurrender(false); setEconomyOpen(false); setTechnologyOpen(false); world.select([]); }
      if ((placementRef.current || orderModeRef.current?.endsWith('_gate')) && (matches('rotateLeft') || matches('rotateRight'))) { event.preventDefault(); world.rotatePlacement(matches('rotateLeft') ? -90 : 90); }
      if (matches('townCenter')) { event.preventDefault(); cycleOwned(entity => entity.typeId === 'town_center'); }
      if (matches('idleWorker')) { event.preventDefault(); selectNextIdleWorker(); }
      if (matches('stop')) { event.preventDefault(); const ids = viewRef.current.entities.filter(entity => selectedRef.current.includes(entity.id) && entity.ownerId === viewRef.current.playerId && entity.kind === 'unit').map(entity => entity.id); if (ids.length) send({ kind: 'stop', unitIds: ids }); }
      const shortcuts: Partial<Record<Hotkey, TargetOrder>> = { move: 'move', attackMove: 'attack_move', attackTarget: 'attack_target', patrol: 'patrol', garrison: 'garrison', attackGround: 'attack_ground' };
      const shortcut = (Object.keys(shortcuts) as Hotkey[]).find(matches);
      if (!placementRef.current && shortcut && viewRef.current.entities.some(entity => selectedRef.current.includes(entity.id) && entity.ownerId === viewRef.current.playerId && entity.kind === 'unit' && !entity.garrisonedIn)) { event.preventDefault(); setOrderMode(shortcuts[shortcut]!); }
      if (matches('holdPosition')) { event.preventDefault(); const unitIds = viewRef.current.entities.filter(entity => selectedRef.current.includes(entity.id) && entity.ownerId === viewRef.current.playerId && entity.kind === 'unit' && !entity.garrisonedIn).map(entity => entity.id); if (unitIds.length) send({ kind: 'hold_position', unitIds }); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); world.onHover = () => 'default'; world.canvas.style.cursor = 'default'; world.onSelection = () => undefined; world.onOrder = () => undefined; world.onBuild = () => undefined; world.onWall = () => undefined; world.onTarget = () => undefined; world.onDrag = () => undefined; world.onPlacementHint = () => undefined; };
  }, [world, send, audio]);

  const me = view.players.find((player) => player.id === view.playerId);
  const selectedUnit = selected?.kind === 'unit' && units[selected.typeId] ? selected.ownerId === view.playerId ? effectiveUnit(units[selected.typeId]!.id, view.self.technologies ?? []) : units[selected.typeId] : undefined;
  const selectedBuilding = selected?.kind === 'building' && buildings[selected.typeId] ? selected.ownerId === view.playerId ? effectiveBuilding(buildings[selected.typeId]!.id, view.self.technologies ?? []) : buildings[selected.typeId] : undefined;
  const gatherRates = selected?.typeId === 'villager' && selected.ownerId === view.playerId ? effectiveGatherRates(view.self.technologies ?? []) : undefined;
  const timeSeconds = Math.floor(view.tick / balance.rules.simulationHz);
  const idle = view.entities.filter((entity) => entity.ownerId === view.playerId && isIdleWorker(entity)).length;

  return <div className={`game-hud ${view.players.some((player) => player.kind === 'ai') ? 'has-ai-commanders' : ''}`} data-testid="game-hud">
    {hover && createPortal(<div className="context-action" role="tooltip" data-testid="context-action" data-blocked={hover.blocked} style={{ fontSize: 13 * preferences.uiScale, maxWidth: 250 * preferences.uiScale, left: Math.max(8, Math.min(hover.x + 18, window.innerWidth - 268 * preferences.uiScale)), top: Math.max(8, Math.min(hover.y + 20, window.innerHeight - 72 * preferences.uiScale)) }}>{hover.label}</div>, document.body)}
    <header className="resource-bar">
      <div className="game-brand"><span className="crest" role="img" aria-label="Frontier Sovereigns">F</span><span>{me?.name}<small>{ages[view.self.age]?.name ?? `Age ${view.self.age}`}</small></span></div>
      <div className="resources">{balance.resourceOrder.map((resource) => <div className={`resource ${resource}`} key={resource}><AssetIcon id={`${resource}_icon`} className="resource-symbol"/><span data-testid={`resource-${resource}`}>{Math.floor(view.self.resources[resource])}<small>{resource}</small></span></div>)}<div className="resource population"><span className="resource-symbol">♙</span><span data-testid="population">{view.self.population}<em>{view.self.reservedPopulation ? ` +${view.self.reservedPopulation}` : ''}</em> / {view.self.populationCap}<small>population</small></span></div></div>
      <div className="match-clock">{String(Math.floor(timeSeconds / 60)).padStart(2, '0')}:{String(timeSeconds % 60).padStart(2, '0')}<small>{connection}</small></div>
      <button className="quiet-button" aria-label="Economy overview" aria-expanded={economyOpen} onClick={() => { setEconomyOpen(!economyOpen); setTechnologyOpen(false); }}>Economy</button>
      <button className="quiet-button" aria-label="Technology tree" aria-expanded={technologyOpen} onClick={() => { setTechnologyOpen(!technologyOpen); setEconomyOpen(false); }}>Research</button>
      <button className="quiet-button" aria-label="Game settings" onClick={openSettings}>Settings</button>
      <button className="quiet-button" onClick={() => setAssistantOpen(true)}>AI Pilot</button>
      {session.host && <button className="quiet-button" onClick={openEndpoint}>AI models</button>}
      {session.host && <button className="quiet-button" aria-label="Saves and recovery" onClick={openRecovery}>Saves</button>}
      {!session.host && <button className="quiet-button" disabled={view.status !== 'RUNNING'} onClick={() => void post('/api/pause-request', {})}>Request pause</button>}
      {session.host && <><button className="quiet-button" onClick={() => void post('/api/host/pause', { paused: view.status !== 'PAUSED' })} disabled={!['RUNNING', 'PAUSED'].includes(view.status)}>{view.status === 'PAUSED' ? 'Resume' : 'Pause'}</button><button className="quiet-button" disabled={!['RUNNING', 'PAUSED'].includes(view.status)} onClick={() => setConfirmDraw(true)}>End as draw</button></>}
      <button className="quiet-button" disabled={view.status !== 'RUNNING'} onClick={() => setConfirmSurrender(true)}>Surrender</button>
    </header>
    <div className="monument-alerts">{(view.monuments ?? []).map((monument) => <button key={monument.id} onClick={() => world.focus(monument.xMm, monument.zMm)}>{view.players.find((player) => player.id === monument.ownerId)?.name} Monument: {Math.ceil(monument.remainingTicks / balance.rules.simulationHz)}s</button>)}</div>
    {session.host && !!session.lobby.pauseRequests?.length && <button className="host-pause-notice" onClick={openRecovery}>{session.lobby.pauseRequests.length} commander pause request{session.lobby.pauseRequests.length > 1 ? 's' : ''}</button>}
    <div className="control-mode-notices">{view.players.filter((player) => player.controlMode === 'caretaker' || player.controlMode === 'disconnected').map((player) => <span key={player.id}>{player.name}: {player.controlMode === 'caretaker' ? 'medium rule-based caretaker active' : 'disconnected; existing orders continue'}</span>)}</div>
    {session.lobby.settings.tutorial ? <Tutorial view={view} selection={selectedIds} observations={commandObservations} connection={connection} world={world}/> : <div className="game-objective"><span className="eyebrow">YOUR FIRST SETTLEMENT</span><p>Gather, cultivate, and expand.<br />Keep your workers close to a drop-off.</p>{view.players.some((player) => player.kind === 'ai') && <button className="strategic-mode-summary" onClick={() => setCommunicationOpen(true)}>{commanderModeLabel(view.players.filter((player) => player.kind === 'ai').every((player) => player.aiMode === 'model') ? 'model' : 'fallback')}<small>{view.players.filter((player) => player.kind === 'ai' && player.aiMode === 'model').length} model / {view.players.filter((player) => player.kind === 'ai' && player.aiMode !== 'model').length} rule-based</small></button>}</div>}
    <div className="quick-selection"><button className="next-idle-worker" aria-label="Next idle worker" title={`Select and center on the next idle worker (${keyLabel(preferences.bindings.idleWorker)}).`} disabled={!idle} onClick={selectNextIdleWorker}><AssetIcon id="idle_worker_icon" /><span>Next idle worker</span><b>{idle}</b><kbd>{keyLabel(preferences.bindings.idleWorker)}</kbd></button><button aria-label="Select Town Center" onClick={() => selectWhere((entity) => entity.typeId === 'town_center', true)}>⌂ <span>Town Center</span><kbd>{keyLabel(preferences.bindings.townCenter)}</kbd></button><button aria-label="Select villagers" onClick={() => selectWhere((entity) => entity.typeId === 'villager')}>♙ <span>Villagers</span></button><button aria-label="Select army" onClick={() => selectWhere((entity) => entity.kind === 'unit' && entity.typeId !== 'villager')}>⚔ <span>Army</span></button>{view.entities.some((entity) => entity.ownerId === view.playerId && entity.typeId === 'barracks') && <button aria-label="Select Barracks" onClick={() => selectWhere((entity) => entity.typeId === 'barracks', true)}>⚑ <span>Barracks</span></button>}</div>
    <div className="building-selector"><select aria-label="Select building" value={selected?.ownerId === view.playerId && selected.kind === 'building' ? selected.id : ''} onChange={(event) => { const entry = view.entities.find((entity) => entity.id === event.target.value); if (entry) { world.select([entry.id]); world.focus(entry.xMm, entry.zMm); } }}><option value="">Your buildings</option>{view.entities.filter((entity) => entity.ownerId === view.playerId && entity.kind === 'building').map((entity, index) => <option key={entity.id} value={entity.id}>{displayName(entity)} {index + 1}{entity.pendingConstruction ? ' (planned)' : (entity.progress ?? 1) < 1 ? ` (${Math.floor((entity.progress ?? 0) * 100)}%)` : ''}</option>)}</select></div>
    <div className="age-announcements" aria-live="polite">{(view.ageAnnouncements ?? []).filter((entry) => view.tick - entry.tick < balance.rules.simulationHz * 15).slice(-3).map((entry) => <div key={`${entry.playerId}-${entry.age}`} className={entry.playerId === view.playerId ? 'own-age-announcement' : ''}><b>{entry.playerId === view.playerId ? `Your ${ages[entry.age]!.name} begins.` : `${view.players.find((player) => player.id === entry.playerId)?.name} reached ${ages[entry.age]!.name}.`}</b>{entry.playerId === view.playerId && <span>New buildings, units, and research are now available.</span>}</div>)}</div>
    <div className="economic-notifications" aria-live="polite">{(view.self.notifications ?? []).filter((entry) => view.tick - entry.tick < balance.rules.simulationHz * 12).slice(-3).map((entry) => <button key={entry.id} onClick={() => { const entity = view.entities.find((candidate) => candidate.id === entry.entityId); if (entity) { world.select([entity.id]); world.focus(entity.xMm, entity.zMm); } }}>{entry.code.startsWith('RESEARCH_COMPLETED:') ? `Research complete: ${technologies[entry.code.split(':')[1] ?? '']?.name ?? entry.code.split(':')[1]}` : entry.code.startsWith('AGE_ADVANCED:') ? `${ages[Number(entry.code.split(':')[1])]?.name} unlocked` : entry.code.replaceAll('_', ' ')}</button>)}</div>
    {drag && <div className="selection-box" style={{ left: drag.x / preferences.uiScale, top: drag.y / preferences.uiScale, width: drag.width / preferences.uiScale, height: drag.height / preferences.uiScale }} />}
    {placement && <div className="placement-notice"><b>Place {buildings[placement]?.name}</b><span>{hint}</span><small>{placement.endsWith('_wall') ? 'Drag a wall; Ctrl changes bend direction. Shift repeats.' : `Click to place; ${keyLabel(preferences.bindings.rotateLeft)}/${keyLabel(preferences.bindings.rotateRight)} rotates; Shift repeats.`} {keyLabel(preferences.bindings.cancel)} cancels.</small></div>}
    {orderMode && <div className="placement-notice"><b>{targetOrderText[orderMode]}</b><span>{hint}</span><small>{keyLabel(preferences.bindings.cancel)} cancels the order mode.</small></div>}
    {rally && <div className="placement-notice"><b>Set rally point</b><span>Click a destination for newly trained units.</span><small>{keyLabel(preferences.bindings.cancel)} to cancel</small></div>}
    {(view.status === 'LOADING' || view.status === 'COUNTDOWN' || view.status === 'PAUSED' || connection !== 'Connected') && <div className="match-banner" role="status"><b>{view.status === 'PAUSED' ? session.lobby.pauseReason === 'no_humans' ? 'Paused because all humans disconnected' : session.lobby.pauseReason === 'overload' ? 'The host paused an overloaded match' : 'The host has paused the match' : view.status === 'LOADING' ? 'Preparing your frontier' : view.status === 'COUNTDOWN' ? 'Your frontier opens in a moment' : connection === 'Delayed' ? 'Host updates delayed' : connection === 'Synchronizing' ? 'Synchronizing your viewpoint' : 'Connection interrupted'}</b><span>{connection === 'Delayed' ? 'Movement updates are delayed. Current orders continue on the host.' : connection !== 'Connected' ? 'Your view is frozen while recovering a complete viewpoint. Current orders continue on the host.' : view.status === 'LOADING' ? 'Waiting for every commander to load.' : 'Your camera remains available.'}</span>{session.host && view.status === 'LOADING' && <div className="loading-players">{session.lobby.players.filter((player) => player.kind === 'human' && player.id !== session.playerId).map((player) => <button className="quiet-button" key={player.id} onClick={() => void post('/api/host/remove-player', { playerId: player.id })}>Remove {player.name} and return to lobby</button>)}</div>}</div>}
    {error && <div className="game-error" role="alert"><span>{error.replaceAll('_', ' ')}</span><button aria-label="Dismiss alert" onClick={clearError}>×</button></div>}
    <div className="command-dock">
      <Minimap view={view} world={world} targeting={!!orderMode} pings={communication?.pings ?? []} signal={(point) => { if (!locked) void post('/api/ping', { xMm: point.xMm, zMm: point.zMm, category: 'help' }); }} order={(target, queued) => orderModeRef.current ? targetedOrder(target, queued) : order(target, queued)} />
      <section className="selection-panel">
        <div className="selection-heading"><div><span className="eyebrow">{selection.length > 1 ? `${selection.length} SELECTED` : selected?.ghost ? 'LAST KNOWN' : 'YOUR SELECTION'}</span><h2>{selection.length > 1 ? `${owned.length === selection.length ? 'Your' : 'Selected'} company` : selected ? displayName(selected) : 'The frontier is yours.'}</h2></div><span className="selection-emblem">{selected?.kind === 'building' ? '⌂' : selected?.kind === 'unit' ? '♙' : '◇'}</span></div>
        {selected ? <><div className="health-row"><div className="health-track"><i style={{ width: `${selected.maxHp ? selected.hp / selected.maxHp * 100 : 100}%` }} /></div><span>{Math.ceil(selected.hp)} / {selected.maxHp} HP</span></div><div className="selection-stats"><span>{selected.kind === 'resource' ? `${Math.floor(selected.amount ?? 0)} ${selected.resource} remaining` : selected.taskState ? selected.taskState : selected.order ? selected.order.replaceAll('_', ' ') : selected.ownerId === view.playerId ? 'Awaiting your command' : view.players.find((player) => player.id === selected.ownerId)?.name}{selected.cargo?.amount ? ` · Carrying ${Number(selected.cargo.amount.toFixed(1))} ${selected.cargo.resource}` : ''}</span>{selected.forest && (selected.amount ?? 0) > 0 && <span>Forest interiors block movement. Gather at accessible edges.</span>}{selected.ownerId === view.playerId && selected.forestIntentId && <span>Working at the forest edge{selected.workTargetId && view.entities.some(entity => entity.id === selected.workTargetId) && <button className="quiet-button" onClick={() => { const tree = view.entities.find(entity => entity.id === selected.workTargetId); if (tree) { world.select([tree.id]); world.focus(tree.xMm, tree.zMm); } }}>Show working tree</button>}</span>}{selected.deploymentState && <span>{selected.deploymentState} {selected.deploymentProgress !== undefined && selected.deploymentProgress < 1 ? `${Math.floor(selected.deploymentProgress * 100)}%` : ''}</span>}{selected.garrisonedIn && <span>Garrisoned</span>}{selected.ghost && selected.lastSeenTick !== undefined && <span>Last seen {Math.floor((view.tick - selected.lastSeenTick) / balance.rules.simulationHz)}s ago</span>}{selected.queuedOrderCount ? <span>{selected.queuedOrderCount} / {balance.rules.orderQueueLimit} queued orders</span> : null}{selected.blockedReason && <span className="blocked-reason">{selected.blockedReason.replaceAll('_', ' ')}</span>}{selected.pendingConstruction && <span>Planned site: waiting for a builder to verify the ground. Cancel for a full refund.</span>}{!selected.pendingConstruction && selected.progress !== undefined && selected.progress < 1 && <span>Construction <PresentationProgress world={world} entityId={selected.id} committed={selected.progress}/></span>}</div>{selection.length > 1 && <div className="selection-chips">{Object.entries(selection.reduce<Record<string, number>>((counts, entity) => { counts[displayName(entity)] = (counts[displayName(entity)] ?? 0) + 1; return counts; }, {})).map(([name, count]) => <span key={name}>{name} × {count}</span>)}</div>}{selected.queue?.length ? <div className="production-queue">{selected.queue.map((job) => <div key={job.id}><span>{jobDefinition(job).name}</span><PresentationProgress world={world} entityId={selected.id} jobId={job.id} committed={job.progress} label={jobStateLabel(job, view)}/><button aria-label={`Cancel queued ${jobDefinition(job).name}`} disabled={locked} title={`Estimated refund: ${refundLabel(jobDefinition(job).cost, job.progress, job.started ?? job.state === 'active')}`} onClick={() => send({ kind: 'cancel_job', buildingId: selected.id, jobId: job.id })}>×</button></div>)}</div> : null}</> : <p className="selection-help">Click a unit or drag to select a company.<br />Right-click the world to move, gather, or attack.</p>}
        {selectedUnit && <div className="combat-stats" aria-label="Selected unit statistics"><UnitClassBadge typeId={selected!.typeId} /><span>{selected!.ownerId === view.playerId ? 'Effective' : 'Base'} attack {selectedUnit.attack} {selectedUnit.attackType}</span><span>Range {selectedUnit.rangeM}m</span><span>Armor {selectedUnit.armor.melee} / {selectedUnit.armor.pierce} / {selectedUnit.armor.crush}</span><span>Speed {Number(selectedUnit.moveSpeedMps.toFixed(3))}m/s</span>{Object.keys(selectedUnit.bonusDamage).length > 0 && <span>{Object.entries(selectedUnit.bonusDamage).map(([tag, bonus]) => `+${bonus} vs ${tag}`).join(' / ')}</span>}{selectedUnit.carryCapacity !== undefined && <span>Carry {selectedUnit.carryCapacity}</span>}{gatherRates && <span>Gather / working second: {Object.entries(gatherRates).map(([resource, rate]) => `${resource} ${rate}`).join(' \u00b7 ')}</span>}</div>}
        {selected?.ward&&<div className="combat-stats"><span>Ward {Math.floor(selected.ward.current)} / {selected.ward.max}</span>{selected.ownerId===view.playerId&&<span>{selected.ward.supportId?'Supported by Ward Spire':'No active ward support'}</span>}</div>}
        {selected?.typeId==='ward_spire'&&selected.ownerId===view.playerId&&<div className="combat-stats"><span>Ward support radius: {legendaryExpansion.wards.radiusM}m</span><span>Assigned: {view.entities.filter(entity=>entity.ownerId===view.playerId&&entity.ward?.supportId===selected.id).map(entity=>buildings[entity.typeId]?.name).join(', ')||'No eligible targets'}</span></div>}
        {selectedUnit&&<div className="combat-stats">{selectedUnit.minRangeM>0&&<span>Minimum range {selectedUnit.minRangeM}m</span>}{selectedUnit.maxPerPlayer!==undefined&&<span>Faction limit {selectedUnit.maxPerPlayer} / {selectedUnit.population} population</span>}{selectedUnit.ammunitionCost&&<span>Each launched shot costs {Object.entries(selectedUnit.ammunitionCost).filter(([,amount])=>amount>0).map(([resource,amount])=>`${amount} ${resource}`).join(', ')}{selected?.ammoAffordable===false?' / OUT OF AMMUNITION':''}</span>}{selectedUnit.turret&&<span>Keep turret: {selectedUnit.turret.attack} {selectedUnit.turret.attackType} / range {selectedUnit.turret.rangeM}m / fires while stationary</span>}</div>}
        {selectedBuilding && <div className="combat-stats"><span>{selected!.ownerId === view.playerId ? 'Effective' : 'Base'} armor {selectedBuilding.armor.melee} / {selectedBuilding.armor.pierce} / {selectedBuilding.armor.crush}</span>{selectedBuilding.attack > 0 && <span>Attack {selectedBuilding.attack} &middot; Range {selectedBuilding.rangeM}m</span>}{selected!.visualAge && <span>Observed {ages[selected!.visualAge]!.name}</span>}</div>}
        {(selected?.kind === 'building'||selected?.typeId==='crown_colossus') && <GarrisonControls view={view} building={selected} locked={locked} send={send} select={(ids) => world.select(ids)} />}
      </section>
      <EconomyActions view={view} selected={selected} selectedIds={selectedIds} workers={workers} locked={locked} placement={placement} setPlacement={(type) => { setOrderModeState(null); orderModeRef.current = null; world.setTargetMode(false); setPlacement(type); setRally(null); world.setRallyMode(null); world.setPlacement(type); }} gather={gatherKnown} send={send} setRally={(id) => { setOrderModeState(null); orderModeRef.current = null; world.setTargetMode(false); setRally(id); setPlacement(null); world.setPlacement(null); world.setRallyMode(id); }} receipt={receipt} pendingCount={pendingCount} orderMode={orderMode} setOrderMode={setOrderMode} />
    </div>
    {assistantOpen && <AssistantPanel session={session} selectedIds={owned.map(entity => entity.id)} close={() => setAssistantOpen(false)}/>}
    {economyOpen && <EconomyWindow view={view} locked={locked} send={send} close={() => setEconomyOpen(false)} />}
    {technologyOpen && <TechnologyTree view={view} locked={locked} send={send} close={() => setTechnologyOpen(false)} select={(id) => { world.select([id]); const entity = view.entities.find((item) => item.id === id); if (entity) world.focus(entity.xMm, entity.zMm); }} />}
    <button className="communications-launcher quiet-button" aria-label="Chat and team signals" aria-expanded={communicationOpen} onClick={() => { setCommunicationOpen(!communicationOpen); if (!communicationOpen) void refreshCommunication().catch(() => undefined); }}>Dispatches & signals{unread > 0 && <b>{unread}</b>}</button>
    {communicationOpen && <Communications view={view} session={session} state={communication} world={world} changed={refreshCommunication} close={() => setCommunicationOpen(false)} />}
    <div className="game-controls"><span>{[preferences.bindings.panForward, preferences.bindings.panLeft, preferences.bindings.panBack, preferences.bindings.panRight].map(keyLabel).join('')} pan · Scroll zoom · {keyLabel(preferences.bindings.health)} health bars</span><span>Shift queues orders · Ctrl + group key assigns · {keyLabel(preferences.bindings.cancel)} clears</span><span>FOG OF WAR ACTIVE</span></div>
    {confirmDraw && <div className="dialog-overlay"><section ref={drawModal} className="game-dialog" role="dialog" aria-modal="true" aria-labelledby="draw-heading"><span className="eyebrow">HOST ADMINISTRATION</span><h2 id="draw-heading">End this match as a draw?</h2><p>Every commander will receive a draw result. This ends all active orders and production.</p><button className="primary" aria-label="Confirm draw" onClick={() => { void post('/api/host/end-draw', { confirmed: true }); setConfirmDraw(false); }}>Confirm draw<span>↗</span></button><button data-modal-initial-focus className="quiet-button" onClick={() => setConfirmDraw(false)}>Keep playing</button></section></div>}
    {confirmSurrender && <div className="dialog-overlay"><section ref={surrenderModal} className="game-dialog" role="dialog" aria-modal="true" aria-labelledby="surrender-heading"><span className="eyebrow">LEAVE THE FIELD</span><h2 id="surrender-heading">Surrender your command?</h2><p>Your faction will be eliminated from this match.</p><button className="primary" onClick={() => { send({ kind: 'surrender' }); setConfirmSurrender(false); }}>Confirm surrender<span>↗</span></button><button data-modal-initial-focus className="quiet-button" onClick={() => setConfirmSurrender(false)}>Keep playing</button></section></div>}
    {view.status === 'FINISHED' && <div className="dialog-overlay"><section className="game-dialog results" role="status" data-testid="match-results"><span className="eyebrow">THE CHAPTER CLOSES</span><h2>{view.result?.winnerTeamId === null ? 'A frontier shared.' : view.result?.winnerTeamId === me?.teamId ? 'Your banner prevails.' : 'Your watch has ended.'}</h2><p>{view.result?.winnerTeamId === null ? 'Draw' : view.result?.winnerTeamId === me?.teamId ? 'Victory' : 'Defeat'} · {view.result?.reason.replaceAll('_', ' ')}</p><div className="result-details"><span>Time on the frontier<strong>{Math.floor(timeSeconds / 60)}m {timeSeconds % 60}s</strong></span><span>Your age<strong>{ages[view.self.age]?.name}</strong></span></div><MatchStatistics view={view} />{session.host ? <><button className="quiet-button" onClick={openRecovery}>Saves and recordings</button><button className="primary" onClick={() => void post('/api/host/reset', {})}>Return to lobby<span>↗</span></button></> : <p className="small-copy">Waiting for the host to open the lobby for another match.</p>}</section></div>}
  </div>;
}
