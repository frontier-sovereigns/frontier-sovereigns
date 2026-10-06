import { buildings, units, type GameplayCommand, type PlayerView, type ViewEntity } from '@frontier/shared';
import type { WorldTarget } from './World';

export interface ContextOrder { label: string; cursor: string; command: GameplayCommand | null }

/** Ownership is checked by the view-aware caller; active or queued work is never idle. */
export function isIdleWorker(entity: ViewEntity): boolean {
  return entity.kind === 'unit' && entity.typeId === 'villager' && entity.hp > 0 && !entity.ghost && !entity.garrisonedIn
    && (!entity.order || entity.order === 'idle') && (!entity.taskState || entity.taskState === 'idle') && !(entity.queuedOrderCount ?? 0);
}

export function nextIdleWorker(view: PlayerView, selectedIds: readonly string[]): ViewEntity | null {
  const workers = view.entities.filter(entity => entity.ownerId === view.playerId && isIdleWorker(entity))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!workers.length) return null;
  const current = workers.findIndex(entity => selectedIds.includes(entity.id));
  return workers[(current + 1) % workers.length]!;
}

/** The preview and dispatch both use only the current recipient-authorized view.
 * This describes an intended order; authority still checks reachability/costs. */
export function resolveContextOrder(view: PlayerView, selectedIds: readonly string[], target: WorldTarget, queued = false, mode: 'attack_target' | 'garrison' | null = null): ContextOrder | null {
  const own = view.entities.filter(entity => selectedIds.includes(entity.id) && entity.ownerId === view.playerId && entity.kind === 'unit' && !entity.garrisonedIn && !entity.ghost);
  const point = { xMm: target.xMm, zMm: target.zMm };
  if (!own.length) {
    if (mode) return null;
    const producer = view.entities.find(entity => selectedIds.includes(entity.id) && entity.ownerId === view.playerId && entity.kind === 'building' && !entity.ghost && (entity.progress ?? 1) >= 1 && buildings[entity.typeId]?.produces.length);
    return producer ? { label: 'Set rally point', cursor: 'crosshair', command: { kind: 'set_rally', buildingId: producer.id, target: point } } : null;
  }
  const object = view.entities.find(entity => entity.id === target.id);
  const owner = view.players.find(player => player.id === object?.ownerId), me = view.players.find(player => player.id === view.playerId);
  const friendly = !!object?.ownerId && (object.ownerId === view.playerId || !!owner && !!me && owner.teamId === me.teamId);
  // Defeat makes remaining defenses inert, not indestructible (FR-WIN).
  const enemy = !!object && object.kind !== 'resource' && object.hp > 0 && !!owner && !!me && owner.teamId !== me.teamId;
  const visible = object && !object.ghost && !object.garrisonedIn;
  const workerIds = own.filter(entity => entity.typeId === 'villager').map(entity => entity.id), unitIds = own.map(entity => entity.id);
  const garrisonIds = own.filter(entity => units[entity.typeId]?.canGarrison && (object?.typeId!=='crown_colossus'||!units[entity.typeId]?.tags.some(tag=>['worker','siege','colossal'].includes(tag)))).map(entity => entity.id);
  const canGarrison = visible && friendly && ((object.kind === 'building' && (object.progress ?? 1) >= 1 && !!buildings[object.typeId]?.garrisonCapacity || object.typeId==='crown_colossus') || object.typeId==='crown_colossus') && garrisonIds.length > 0;
  if (mode === 'attack_target') return visible && enemy
    ? { label: 'Attack enemy', cursor: 'crosshair', command: { kind: 'attack_target', unitIds, targetId: object.id, queued } }
    : { label: friendly ? 'Cannot attack allies' : 'Choose a visible enemy', cursor: 'not-allowed', command: null };
  if (mode === 'garrison') return canGarrison
    ? { label: 'Garrison', cursor: 'pointer', command: { kind: 'garrison', unitIds: garrisonIds, targetId: object.id, queued } }
    : { label: 'Choose a friendly garrison building or Crown Colossus', cursor: 'not-allowed', command: null };
  if (visible && workerIds.length && (object.amount ?? 0) > 0 && (object.kind === 'resource' || object.typeId === 'farm' && friendly && object.farmState === 'ready')) {
    const label = object.resource === 'gold' || object.resource === 'stone' ? `Mine ${object.resource}` : object.resource === 'wood' ? object.forest?'Chop wood at forest edge':'Chop wood' : 'Gather food';
    return { label, cursor: 'pointer', command: { kind: 'gather', unitIds: workerIds, targetId: object.id, queued } };
  }
  if (visible && enemy) return { label: 'Attack enemy', cursor: 'crosshair', command: { kind: 'attack_target', unitIds, targetId: object.id, queued } };
  if (visible && object.kind === 'building' && workerIds.length) {
    if (object.ownerId === view.playerId && (object.progress ?? 1) < 1) return { label: 'Continue construction', cursor: 'pointer', command: { kind: 'continue_build', builderIds: workerIds, foundationId: object.id, queued } };
    if (friendly && object.hp < object.maxHp && (object.progress ?? 1) >= 1) return { label: 'Repair', cursor: 'pointer', command: { kind: 'repair', unitIds: workerIds, targetId: object.id, queued } };
  }
  // Entering a building requires the explicit Garrison action; an ordinary
  // contextual click must not hide selected units inside a friendly structure.
  return { label: object?.ghost ? 'Move to last known position' : 'Move', cursor: 'move', command: { kind: 'move', unitIds, target: point, queued } };
}
