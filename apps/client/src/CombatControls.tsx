import { ages, balance, buildings, units, type GameplayCommand, type PlayerView, type ViewEntity } from '@frontier/shared';
import { AssetIcon } from './AssetIcon';
import { keyLabel, readPreferences, type Hotkey } from './preferences';

export type TargetOrder = 'move' | 'attack_move' | 'attack_target' | 'patrol' | 'garrison' | 'attack_ground' | 'wooden_gate' | 'stone_gate' | 'bastion_gate' | 'runestone_gate' | 'titan_gate' | 'eternal_gate';
export const targetOrderText: Record<TargetOrder, string> = { move: 'Move', attack_move: 'Attack-move', attack_target: 'Attack target', patrol: 'Patrol route', garrison: 'Garrison', attack_ground: 'Attack ground', wooden_gate: 'Replace palisades with a gate', stone_gate: 'Replace stone walls with a gate', bastion_gate:'Replace bastion walls with a gate',runestone_gate:'Replace runestone walls with a gate',titan_gate:'Replace titan walls with a gate',eternal_gate:'Replace eternal walls with a gate' };

export function UnitClassBadge({ typeId }: { typeId: string }) {
  const unit = units[typeId]; if (!unit) return null;
  const kind = ['worker', 'colossal', 'cavalry', 'siege', 'infantry'].find((tag) => unit.tags.includes(tag)) ?? 'ranged';
  const bonuses = Object.entries(unit.bonusDamage).map(([tag, value]) => `+${value} damage against ${tag}`);
  const counters = Object.values(units).filter((candidate) => Object.entries(candidate.bonusDamage).some(([tag, value]) => value > 0 && unit.tags.includes(tag))).map((candidate) => candidate.name);
  const help = `${unit.name}: ${unit.tags.join(', ')}. ${bonuses.length ? `${bonuses.join('; ')}. ` : ''}${counters.length ? `Vulnerable to bonus damage from ${counters.join(', ')}.` : 'No opposing class bonus; armor, range, numbers, and positioning still matter.'}`;
  return <span className="unit-class-badge" tabIndex={0} title={help} aria-label={help}><span aria-hidden="true">{({ colossal: 'C', worker: '♙', cavalry: '♞', siege: '▰', infantry: '⚔', ranged: '⌁' })[kind]}</span>{kind}</span>;
}

export function CombatOrders({ view, selection, locked, mode, setMode, send }: { view: PlayerView; selection: ViewEntity[]; locked: boolean; mode: TargetOrder | null; setMode: (mode: TargetOrder | null) => void; send: (command: GameplayCommand) => void }) {
  const bindings = readPreferences().bindings;
  const label = (action: Hotkey) => keyLabel(bindings[action]);
  const own = selection.filter((entity) => entity.ownerId === view.playerId && entity.kind === 'unit');
  const active = own.filter((entity) => !entity.garrisonedIn), ids = active.map((entity) => entity.id);
  const siege = active.filter((entity) => !!units[entity.typeId]?.areaDamageBands?.length);
  const trebuchets = active.filter((entity) => !!units[entity.typeId]?.deploySeconds);
  const transitions = trebuchets.some((entity) => ['deploying', 'packing'].includes(entity.deploymentState ?? ''));
  const commands: { mode: TargetOrder; icon: string; key: string; disabled?: boolean; reason?: string }[] = [
    { mode: 'move', icon: '↗', key: label('move') }, { mode: 'attack_move', icon: '⚔', key: label('attackMove') }, { mode: 'attack_target', icon: '◎', key: label('attackTarget') }, { mode: 'patrol', icon: '⇄', key: label('patrol') },
    { mode: 'garrison', icon: '⌂', key: label('garrison'), disabled: !active.some((entity) => units[entity.typeId]?.canGarrison), reason: 'Siege cannot garrison' },
  ];
  return <div className="combat-orders">
    <div className="military-order-grid">{commands.map((item) => <button key={item.mode} className={mode === item.mode ? 'active' : ''} aria-label={targetOrderText[item.mode]} disabled={locked || !ids.length || item.disabled} title={item.disabled ? item.reason : `${targetOrderText[item.mode]} · ${item.key}`} onClick={() => setMode(mode === item.mode ? null : item.mode)}><AssetIcon id={`action_icon_${item.mode}`}/>{targetOrderText[item.mode]}<kbd>{item.key}</kbd></button>)}<button aria-label="Hold position" disabled={locked || !ids.length} onClick={() => send({ kind: 'hold_position', unitIds: ids })}><AssetIcon id="action_icon_hold_position"/>Hold position<kbd>{label('holdPosition')}</kbd></button><button aria-label="Stop selected units" disabled={locked || !ids.length} onClick={() => send({ kind: 'stop', unitIds: ids })}><AssetIcon id="action_icon_stop"/>Stop<kbd>{label('stop')}</kbd></button>{siege.length > 0 && <button className={mode === 'attack_ground' ? 'active' : ''} aria-label="Attack ground" disabled={locked} onClick={() => setMode(mode === 'attack_ground' ? null : 'attack_ground')}><AssetIcon id="action_icon_attack_ground"/>Attack ground<kbd>{label('attackGround')}</kbd></button>}</div>
    <div className="stance-controls"><label>Stance<select aria-label="Unit stance" value={active.every((entity) => entity.stance === active[0]?.stance) ? active[0]?.stance ?? 'aggressive' : ''} disabled={locked || !ids.length} onChange={(event) => send({ kind: 'set_stance', unitIds: ids, stance: event.target.value as 'aggressive' | 'defensive' | 'stand_ground' })}><option value="" disabled>Mixed stances</option><option value="aggressive">Aggressive</option><option value="defensive">Defensive</option><option value="stand_ground">Stand ground</option></select></label>{trebuchets.length > 0 && <><button className="quiet-button" disabled={locked || transitions || trebuchets.every((entity) => entity.deploymentState === 'deployed')} onClick={() => send({ kind: 'deploy', unitIds: trebuchets.map((entity) => entity.id) })}>Deploy · {Math.max(...trebuchets.map(entity=>units[entity.typeId]!.deploySeconds!))}s</button><button className="quiet-button" disabled={locked || transitions || trebuchets.every((entity) => entity.deploymentState === 'packed')} onClick={() => send({ kind: 'pack', unitIds: trebuchets.map((entity) => entity.id) })}>Pack · {Math.max(...trebuchets.map(entity=>units[entity.typeId]!.packSeconds!))}s</button></>}</div>
    {own.some((entity) => entity.garrisonedIn) && <button className="quiet-button" aria-label="Ungarrison selected units" disabled={locked} onClick={() => { const byBuilding = new Map<string, string[]>(); for (const entity of own) if (entity.garrisonedIn) byBuilding.set(entity.garrisonedIn, [...(byBuilding.get(entity.garrisonedIn) ?? []), entity.id]); for (const [buildingId, unitIds] of byBuilding) send({ kind: 'ungarrison', buildingId, unitIds }); }}>Ungarrison selected units</button>}
  </div>;
}

export function GarrisonControls({ view, building, locked, send, select }: { view: PlayerView; building: ViewEntity; locked: boolean; send: (command: GameplayCommand) => void; select: (ids: string[]) => void }) {
  const capacity = buildings[building.typeId]?.garrisonCapacity ?? units[building.typeId]?.mobileGarrisonCapacity ?? 0;
  const ownOccupants = view.entities.filter((entity) => entity.ownerId === view.playerId && entity.garrisonedIn === building.id);
  if (!capacity || !ownOccupants.length && building.ownerId !== view.playerId) return null;
  return <div className="garrison-controls"><span>Garrison {(building.garrisoned ?? ownOccupants).length} / {capacity}</span>{ownOccupants.map(entity=><span key={entity.id}>{units[entity.typeId]?.name} / {Math.ceil(entity.hp)} / {entity.maxHp} HP</span>)}{ownOccupants.length > 0 && <><button className="quiet-button" disabled={locked} onClick={() => send({ kind: 'ungarrison', buildingId: building.id, unitIds: ownOccupants.map((entity) => entity.id) })}>Ungarrison all yours</button><button className="quiet-button" onClick={() => select(ownOccupants.map((entity) => entity.id))}>Select occupants</button></>}</div>;
}

export function MatchStatistics({ view }: { view: PlayerView }) {
  if (view.status !== 'FINISHED' || !view.result?.statistics) return null;
  return <div className="match-statistics"><h3>Final faction statistics</h3>{view.result.statistics.map((record) => {
    const player = view.players.find((entry) => entry.id === record.playerId), totalTicks = record.fallbackTicks + record.modelReadyTicks;
    return <details key={record.playerId} open={record.playerId === view.playerId}><summary><span style={{ color: player?.color }}>{player?.name ?? record.playerId}</span><span>{record.unitsTrained} trained · {record.unitsLost} units lost</span></summary><div className="stat-totals"><span>Buildings {record.buildingsBuilt} built / {record.buildingsLost} lost</span><span>{Object.entries(record.ageTicks).map(([age, tick]) => `${ages[Number(age)]?.name}: ${Math.floor(tick / balance.rules.simulationHz / 60)}m ${Math.floor(tick / balance.rules.simulationHz) % 60}s`).join(' · ')}</span>{player?.kind === 'ai' && <span>Model available {totalTicks ? Math.round(record.modelReadyTicks / totalTicks * 100) : 0}% · Fallback {Math.floor(record.fallbackTicks / balance.rules.simulationHz)}s · {record.inferenceFailures} inference failures</span>}</div><table><thead><tr><th>Resource</th><th>Collected</th><th>Spent</th><th>Cargo lost</th></tr></thead><tbody>{balance.resourceOrder.map((resource) => <tr key={resource}><td>{resource}</td><td>{record.collected[resource]}</td><td>{record.spent[resource]}</td><td>{record.lostCargo[resource]}</td></tr>)}</tbody></table></details>;
  })}</div>;
}

/** Public faction status only; concealed units never affect this readout. */
export function OpponentStatus({ players, playerId }: Pick<PlayerView, 'players' | 'playerId'>) {
  const teamId = players.find(player => player.id === playerId)?.teamId;
  const opponents = players.filter(player => player.id !== playerId && player.teamId !== teamId && !player.defeated);
  const teams = new Set(opponents.map(player => player.teamId)).size;
  const teamNumbers = new Map<string, number>();
  for (const player of players) if (!teamNumbers.has(player.teamId)) teamNumbers.set(player.teamId, teamNumbers.size + 1);
  return <details className="opponent-status" data-gameplay-hotkeys="suspend">
    <summary><span>Opponents remaining</span><strong aria-live="polite" aria-atomic="true">{opponents.length} {opponents.length === 1 ? 'faction' : 'factions'} · {teams} {teams === 1 ? 'team' : 'teams'}</strong></summary>
    <div className="opponent-status-content">
      <p>Active factions may still have units outside your sight. Victory is confirmed by the match result.</p>
      <ul aria-label="Faction status">{players.map(player => <li key={player.id}><span>{player.name}<small>{player.id === playerId ? 'You' : player.teamId === teamId ? 'Ally' : 'Opponent'} · Team {teamNumbers.get(player.teamId)}</small></span><strong>{player.defeated ? 'Eliminated' : 'Active'}</strong></li>)}</ul>
    </div>
  </details>;
}
