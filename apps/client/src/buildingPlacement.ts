import { balance, buildings, type BuildingId, type Cell, type GameplayCommand, type PlayerView, type Position, type Rotation, type ViewEntity } from '@frontier/shared';

export interface BuildingPlacement {
  originCell: Cell;
  rotation: Rotation;
  wallIds: string[];
  aligned: boolean;
  reason?: string;
}

/** Use only the player's disclosed view. Admission and payment remain on the host. */
export function resolveBuildingPlacement(view: Pick<PlayerView, 'playerId' | 'entities'>, type: BuildingId, target: Position, preferred: Rotation): BuildingPlacement {
  const grid = balance.rules.buildingGridM * 1000, cell = { x: Math.floor(target.xMm / grid), z: Math.floor(target.zMm / grid) };
  const definition = buildings[type]!, placement: BuildingPlacement = { originCell: cell, rotation: preferred, wallIds: [], aligned: false };
  if (!definition.defaultGateMode) return placement;

  // Gate clicks identify the middle of the opening, rather than its lower corner.
  // This makes the same gesture work in a gap and on an existing wall run.
  const half = Math.floor(definition.footprintCells[0] / 2), wallType = type === 'wooden_gate' ? 'palisade_wall' : type.replace('_gate', '_wall');
  const walls = new Map<string, ViewEntity>();
  for (const entity of view.entities) if (entity.kind === 'building' && entity.ownerId === view.playerId && !entity.ghost && entity.typeId.endsWith('_wall')) {
    const x = Math.floor(entity.xMm / grid), z = Math.floor(entity.zMm / grid);
    if (entity.xMm === (x + .5) * grid && entity.zMm === (z + .5) * grid) walls.set(`${x}:${z}`, entity);
  }
  const axes = ([0, 90] as const).map(rotation => {
    const at = (offset: number) => walls.get(`${cell.x + (rotation === 0 ? offset : 0)}:${cell.z + (rotation === 90 ? offset : 0)}`);
    const span = Array.from({ length: half * 2 + 1 }, (_, index) => at(index - half));
    const negative = Array.from({ length: half + 2 }, (_, index) => at(-index - 1)).filter(Boolean).length;
    const positive = Array.from({ length: half + 2 }, (_, index) => at(index + 1)).filter(Boolean).length;
    const replacement = span.every(entity => entity?.typeId === wallType && (entity.progress ?? 0) >= 1 && !entity.upgrade);
    const count = negative + positive + (at(0) ? 1 : 0);
    return { rotation, span, replacement, bilateral: negative > 0 && positive > 0, score: count < 2 ? 0 : (replacement ? 1000 : negative && positive ? 100 : 0) + count };
  });
  axes.sort((a, b) => b.score - a.score || Number(a.rotation !== preferred % 180) - Number(b.rotation !== preferred % 180));
  const chosen = axes[0]!;
  if (chosen.score > 0) {
    placement.aligned = true;
    placement.rotation = chosen.rotation === preferred % 180 ? preferred : chosen.rotation;
    if (chosen.score === axes[1]!.score || chosen.bilateral && axes[1]!.bilateral) placement.reason = 'Choose a straight wall run or a clear gap, away from a wall junction';
    else if (chosen.replacement) placement.wallIds = chosen.span.map(entity => entity!.id);
    else if (chosen.span.some(Boolean)) placement.reason = `Replacement needs ${half * 2 + 1} completed matching wall segments`;
  }
  placement.originCell = { x: cell.x - (placement.rotation % 180 ? 0 : half), z: cell.z - (placement.rotation % 180 ? half : 0) };
  return placement;
}

export function buildingPlacementCommand(type: BuildingId, placement: BuildingPlacement, builderIds: string[], queued: boolean): GameplayCommand | null {
  if (placement.reason || !builderIds.length || type.endsWith('_wall') || placement.originCell.x < 0 || placement.originCell.z < 0) return null;
  if (placement.wallIds.length) return { kind: 'replace_wall_with_gate', builderIds, wallIds: placement.wallIds, queued };
  return { kind: 'build', buildingType: type as Extract<GameplayCommand, { kind: 'build' }>['buildingType'], builderIds, originCell: placement.originCell, rotation: placement.rotation, queued };
}
