import { afterEach, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { createAssetLibrary, generateBuildingAssets } from '@frontier/assets';
import { balance, buildings, type BuildingId, type PlayerView, type Rotation, type ViewEntity } from '@frontier/shared';
import { AssetRenderer } from './AssetRenderer';
import { buildingPlacementCommand, resolveBuildingPlacement } from './buildingPlacement';
import { World } from './World';

const gateTypes = ['wooden_gate', 'stone_gate', 'bastion_gate', 'runestone_gate', 'titan_gate', 'eternal_gate'] as const;
const grid = balance.rules.buildingGridM * 1000, center = { xMm: 41000, zMm: 41000 };
function wall(index: number, rotation: Rotation, type: BuildingId = 'palisade_wall'): ViewEntity {
  return { id: `wall_${rotation}_${index}`, kind: 'building', typeId: type, ownerId: 'me', xMm: center.xMm + (rotation % 180 ? 0 : index * grid), zMm: center.zMm + (rotation % 180 ? index * grid : 0), hp: 100, maxHp: 100, progress: 1 };
}
const view = (entities: ViewEntity[]) => ({ playerId: 'me', entities });
const wallType = (type: BuildingId): BuildingId => type === 'wooden_gate' ? 'palisade_wall' : type.replace('_gate', '_wall') as BuildingId;

it.each(gateTypes)('centers and aligns %s to both completed wall axes and returns its existing replacement command', type => {
  const half = Math.floor(buildings[type].footprintCells[0] / 2);
  for (const rotation of [0, 90] as const) {
    const entities = Array.from({ length: half * 2 + 1 }, (_, index) => wall(index - half, rotation, wallType(type)));
    const placement = resolveBuildingPlacement(view(entities), type, center, rotation === 0 ? 90 : 0);
    expect(placement).toEqual({ originCell: { x: 20 - (rotation === 0 ? half : 0), z: 20 - (rotation === 90 ? half : 0) }, rotation, wallIds: entities.map(entity => entity.id), aligned: true });
    expect(buildingPlacementCommand(type, placement, ['worker'], true)).toEqual({ kind: 'replace_wall_with_gate', builderIds: ['worker'], wallIds: entities.map(entity => entity.id), queued: true });
  }
});

it.each(gateTypes)('fills a clear gap between wall endpoints with %s on either axis', type => {
  const half = Math.floor(buildings[type].footprintCells[0] / 2);
  for (const rotation of [0, 90] as const) {
    const entities = [-half - 1, half + 1].map(index => wall(index, rotation, wallType(type)));
    const placement = resolveBuildingPlacement(view(entities), type, center, rotation === 0 ? 90 : 0);
    expect(placement.aligned).toBe(true); expect(placement.rotation).toBe(rotation); expect(placement.wallIds).toEqual([]);
    expect(buildingPlacementCommand(type, placement, ['worker'], false)).toEqual({ kind: 'build', buildingType: type, builderIds: ['worker'], originCell: placement.originCell, rotation, queued: false });
    const dimensions = rotation === 0 ? buildings[type].footprintCells : [...buildings[type].footprintCells].reverse();
    expect((placement.originCell.x + dimensions[0]! / 2) * grid).toBe(center.xMm);
    expect((placement.originCell.z + dimensions[1]! / 2) * grid).toBe(center.zMm);
  }
});

it('keeps open-ground rotation, ordinary building origins and map bounds, without borrowing foreign or remembered walls', () => {
  const entities = [-1, 0, 1].map(index => ({ ...wall(index, 90), ownerId: 'other' }));
  const placement = resolveBuildingPlacement(view(entities), 'wooden_gate', center, 180);
  expect(placement).toMatchObject({ rotation: 180, aligned: false, wallIds: [], originCell: { x: 19, z: 20 } });
  expect(resolveBuildingPlacement(view(entities.map(entity => ({ ...entity, ownerId: 'me', ghost: true }))), 'wooden_gate', center, 0)).toMatchObject({ rotation: 0, aligned: false, wallIds: [] });
  expect(resolveBuildingPlacement(view(entities), 'house', center, 90)).toEqual({ originCell: { x: 20, z: 20 }, rotation: 90, wallIds: [], aligned: false });
  expect(buildingPlacementCommand('wooden_gate', resolveBuildingPlacement(view([]), 'wooden_gate', { xMm: 1000, zMm: 1000 }, 0), ['worker'], false)).toBeNull();
});

it('refuses partial, unfinished, upgrading, mixed and ambiguous replacement spans', () => {
  const straight = [-1, 0, 1].map(index => wall(index, 0));
  for (const changes of [{ progress: .5 }, { typeId: 'stone_wall' }, { upgrade: { jobId: 'upgrade', targetTypeId: 'stone_wall' as const, progress: .5, started: true, state: 'active' as const } }]) {
    const entities = straight.map((entity, index) => index === 1 ? { ...entity, ...changes } : entity);
    const placement = resolveBuildingPlacement(view(entities), 'wooden_gate', center, 0);
    expect(placement.reason).toContain('completed matching'); expect(buildingPlacementCommand('wooden_gate', placement, ['worker'], false)).toBeNull();
  }
  for (const entities of [straight.slice(1), [...straight, wall(-1, 90), wall(1, 90)]]) {
    expect(buildingPlacementCommand('wooden_gate', resolveBuildingPlacement(view(entities), 'wooden_gate', center, 0), ['worker'], false)).toBeNull();
  }
});

const library = createAssetLibrary(), bundle = library.finish(generateBuildingAssets(library));
const engines: NullEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose(); });

it.each([0, 90] as const)('uses the same rendered gate anchor and %s degree orientation for the actual World command path', rotation => {
  const engine = new NullEngine(); engines.push(engine);
  const scene = new Scene(engine), assets = new AssetRenderer(scene, bundle), preview = assets.create('bastion_gate');
  const entities = [-2, -1, 0, 1, 2].map(index => wall(index, rotation, 'bastion_wall'));
  const fog = Array.from({ length: 2500 }, (_, index) => index), hint = vi.fn();
  const current = { ...view(entities), map: { widthMm: 100000, heightMm: 100000, fogCellMm: 2000, terrain: [] }, fog: { visible: fog, explored: fog } } as unknown as PlayerView;
  // Exercise the production World methods with real Babylon assets; only the
  // DOM/WebGL constructor is replaced by the deterministic NullEngine fixture.
  const world = Object.assign(Object.create(World.prototype), { view: current, placement: 'bastion_gate', placementRotation: rotation === 0 ? 90 : 0, previewMesh: preview.root, assets, scene, materials: new Map(), onPlacementHint: hint }) as World;
  (world as unknown as { updatePlacement(target: typeof center): void }).updatePlacement(center);
  expect(preview.root.position.x).toBe(41); expect(preview.root.position.z).toBe(41);
  expect(preview.root.rotation.y).toBe(rotation * Math.PI / 180); expect(hint).toHaveBeenLastCalledWith(expect.stringContaining('Replace 5 completed walls'));
  expect(world.placementCommand(center, ['worker'], false)).toEqual({ kind: 'replace_wall_with_gate', builderIds: ['worker'], wallIds: entities.map(entity => entity.id), queued: false });
  // A wall changing after the preview must not send the formerly valid span.
  entities[2]!.progress = .5;
  expect(world.placementCommand(center, ['worker'], false)).toBeNull();
});
