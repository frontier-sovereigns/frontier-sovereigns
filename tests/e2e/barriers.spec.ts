import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PlayerView } from '@frontier/shared';
import { capture, changedWorldPixels, renderedWorldSample } from './capture';
import { terrainObstacles } from '../../packages/shared/src/terrain';
import { Navigation, type Obstacle } from '../../packages/simulation/src/navigation';
import type { SaveEnvelope } from '../../packages/simulation/src/persistence-types';
import { engineIdentity } from '../../apps/server/src/build-info';
import balance from '../../data/balance.v1.json' with { type: 'json' };

const fixtureSeed = 'barriers-browser-standard-frontier-v7', replayDirectory = 'runtime-data/e2e/replays';
const journalNames = () => new Set(existsSync(replayDirectory) ? readdirSync(replayDirectory).filter(name => /^replay_\d{13}_[a-f0-9]{16}\.ndjson$/.test(name)) : []);

/** Authored Node-only route geometry; never sent to a browser or attachment.
 * Read only the bounded, sealed initial header of this test's new journal. */
function fixtureGeometry(priorFiles: ReadonlySet<string>, views: readonly PlayerView[]): Obstacle[] | undefined {
  const files = [...journalNames()].filter(name => !priorFiles.has(name));
  if (!files.length) return;
  if (files.length !== 1) throw new Error('BARRIERS_FIXTURE_AMBIGUOUS_JOURNAL');
  const descriptor = openSync(`${replayDirectory}/${files[0]}`, 'r'), chunks: Buffer[] = [];
  let size = 0, complete = false;
  try {
    while (size < 16 * 1024 * 1024) {
      const chunk = Buffer.alloc(Math.min(65536, 16 * 1024 * 1024 - size)), count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      const end = chunk.subarray(0, count).indexOf(10), part = chunk.subarray(0, end < 0 ? count : end);
      chunks.push(part); size += part.length;
      if (end >= 0) { complete = true; break; }
    }
  } finally { closeSync(descriptor); }
  if (!complete) { if (size >= 16 * 1024 * 1024) throw new Error('BARRIERS_FIXTURE_HEADER_LIMIT'); return; }
  const line = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as { previous: string; checksum: string; record: { kind: string; initial: SaveEnvelope } };
  const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if (line.record.kind !== 'header' || line.previous !== '0'.repeat(64) || line.checksum !== createHash('sha256').update(line.previous + '\n' + JSON.stringify(line.record)).digest('hex')) throw new Error('BARRIERS_FIXTURE_INVALID_HEADER');
  const { checksum, ...sealed } = line.record.initial, { state, options } = sealed.payload;
  if (sealed.formatVersion !== 1 || checksum !== fingerprint(sealed) || sealed.engineBuildHash !== engineIdentity.engineBuildHash || JSON.stringify(sealed.runtimeProfile) !== JSON.stringify(engineIdentity.runtimeProfile)) throw new Error('BARRIERS_FIXTURE_ENGINE_MISMATCH');
  if (state.tick !== 0 || options.seed !== fixtureSeed || state.map.seed !== fixtureSeed || options.mapType !== 'open_frontier') throw new Error('BARRIERS_FIXTURE_MATCH_MISMATCH');
  const factions = (players: readonly { id: string; teamId: string; kind: string }[]) => players.map(({ id, teamId, kind }) => ({ id, teamId, kind })).sort((a, b) => a.id.localeCompare(b.id));
  for (const view of views) {
    if (view.matchId !== state.matchId || view.matchEpoch !== state.matchEpoch || view.contentHash !== sealed.payload.contentHash || view.map.widthMm !== state.widthMm || view.map.heightMm !== state.heightMm || view.map.type !== state.map.type || view.map.generatorVersion !== state.map.generatorVersion || JSON.stringify(view.map.terrain) !== JSON.stringify(state.map.terrain) || JSON.stringify(factions(view.players)) !== JSON.stringify(factions(state.factions))) throw new Error('BARRIERS_FIXTURE_VIEW_MISMATCH');
    const scout = view.entities.find(entity => entity.ownerId === view.playerId && entity.typeId === 'scout'), initial = scout && state.entities[scout.id];
    if (!scout || !initial || initial.ownerId !== scout.ownerId || initial.typeId !== 'scout' || initial.xMm !== scout.xMm || initial.zMm !== scout.zMm) throw new Error('BARRIERS_FIXTURE_SCOUT_MISMATCH');
  }
  const obstacles = terrainObstacles(state.map.terrain), grid = balance.rules.buildingGridM * 1000;
  for (const entity of Object.values(state.entities)) {
    if (entity.kind === 'unit') continue;
    let halfWidth: number, halfHeight: number;
    if (entity.kind === 'resource') {
      if (entity.amount <= 0) continue;
      // Exact resourceWorkBounds, including authored forest cells.
      halfWidth = halfHeight = entity.resource === 'wood' && entity.forest ? entity.forest.cellMm / 2 : entity.resource === 'wood' ? 450 : 650;
    } else {
      let [w, h] = balance.buildings.find(building => building.id === entity.typeId)!.footprintCells as [number, number];
      if (entity.rotation === 90 || entity.rotation === 270) [w, h] = [h, w];
      halfWidth = w * grid / 2; halfHeight = h * grid / 2;
    }
    obstacles.push({ id: entity.id, xMm: entity.xMm, zMm: entity.zMm, halfWidth, halfHeight });
  }
  return obstacles;
}

// Uses Playwright's owned production host on3010, ordinary browser authentication,
// and recipient snapshots for assertions. Route fixture geometry stays Node-only.
// Never loads a save, disables fog, or calls a model.
test('natural ridges render around broad valleys while two human viewpoints scout normally', async ({ browser }, testInfo) => {
  test.setTimeout(180000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), remote = await remoteContext.newPage();
  const state = capture(host), other = capture(remote);
  host.setDefaultTimeout(12000); remote.setDefaultTimeout(12000);
  try {
    await host.goto('/'); await host.getByRole('tab', { name: 'Host access', exact: true }).click();
    await host.getByLabel('HOST ACCESS TOKEN').fill('e2e-bootstrap-token-not-for-real-hosts');
    await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible();
    const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('AI COMMANDERS').selectOption('0');
    await host.getByLabel('Map type').selectOption('open_frontier');
    await host.getByLabel('YOUR NAME').fill('Ridge host');
    await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto('/'); await remote.getByLabel('YOUR NAME').fill('Valley guest');
    await remote.getByLabel('INVITATION CODE').fill(invite);
    await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await host.getByLabel('Ridge host team', { exact: true }).selectOption('team_1');
    await host.getByLabel('Valley guest team', { exact: true }).selectOption('team_2');
    await host.getByLabel('Private map seed', { exact: true }).fill(fixtureSeed);
    const [seedResponse] = await Promise.all([
      host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/host/seed'),
      host.getByRole('button', { name: 'Set seed', exact: true }).click(),
    ]);
    expect(seedResponse.ok()).toBe(true);
    const priorJournals = journalNames();
    await host.getByRole('button', { name: 'Ready to begin' }).click();
    await remote.getByRole('button', { name: 'Ready to begin' }).click();
    await expect(host.getByRole('button', { name: 'Begin match' })).toBeEnabled();
    await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 45000 }).toBe('RUNNING');
    await expect.poll(() => other.view?.status, { timeout: 45000 }).toBe('RUNNING');
    const initial = structuredClone(state.view!), guest = structuredClone(other.view!);
    expect(initial.map.generatorVersion).toBe('7.0.1');
    expect(initial.players.every(player => player.kind === 'human')).toBe(true);
    expect(initial.map.terrain).toEqual(guest.map.terrain);
    expect(initial.map).not.toHaveProperty('seed'); expect(initial.map).not.toHaveProperty('spawns');
    expect(initial.map).not.toHaveProperty('forestFrontiers'); expect(initial.map).not.toHaveProperty('validation');
    expect(initial.entities.some(entity => entity.ownerId === guest.playerId)).toBe(false);
    expect(guest.entities.some(entity => entity.ownerId === initial.playerId)).toBe(false);
    const ownResources = new Set(initial.entities.filter(entity => entity.kind === 'resource').map(entity => entity.id));
    expect(guest.entities.filter(entity => entity.kind === 'resource').some(entity => ownResources.has(entity.id))).toBe(false);
    const scout = initial.entities.find(entity => entity.ownerId === initial.playerId && entity.typeId === 'scout')!;
    expect(scout).toBeDefined();
    const ridges = initial.map.terrain!.filter(region => region.kind === 'ridge');
    expect(ridges.length).toBeGreaterThan(0);
    const terrain = terrainObstacles(initial.map.terrain!);
    // Terrain alone cannot prove a route through undiscovered forests. Keep a
    // fixed authored fixture and queue a bounded real route through ordinary UI.
    let obstacles: Obstacle[] | undefined;
    await expect.poll(() => { obstacles = fixtureGeometry(priorJournals, [initial, guest]); return Boolean(obstacles); }, { timeout: 15000 }).toBe(true);
    const navigation = new Navigation(initial.map.widthMm, initial.map.heightMm, obstacles!, 160000);
    obstacles = undefined;
    const axes=(length:number)=>{
      const grid=balance.rules.buildingGridM*1000,size=balance.maps.sizes.find(size=>length<=size.cells[0]!*grid)!,count=balance.maps.forestBelts.territoryCellsBySize[size.id as 'small'|'medium'|'large'];
      return Array.from({length:count},(_,index)=>Math.round(length*(index+.5)/count/grid)*grid);
    };
    const xs=axes(initial.map.widthMm),zs=axes(initial.map.heightMm);
    const candidates = ridges.flatMap(ridge => [
      { ridge, xMm: xs.filter(x=>x<ridge.xMm).at(-1)!, zMm: ridge.zMm + ridge.depthMm / 2 },
      { ridge, xMm: xs.find(x=>x>ridge.xMm+ridge.widthMm)!, zMm: ridge.zMm + ridge.depthMm / 2 },
      { ridge, xMm: ridge.xMm + ridge.widthMm / 2, zMm: zs.filter(z=>z<ridge.zMm).at(-1)! },
      { ridge, xMm: ridge.xMm + ridge.widthMm / 2, zMm: zs.find(z=>z>ridge.zMm+ridge.depthMm)! },
    ]).filter(point => Number.isFinite(point.xMm) && Number.isFinite(point.zMm) && !terrain.some(obstacle => Math.abs(point.xMm - obstacle.xMm) < obstacle.halfWidth + 1500 && Math.abs(point.zMm - obstacle.zMm) < obstacle.halfHeight + 1500))
      .sort((a, b) => Math.hypot(a.xMm - scout.xMm, a.zMm - scout.zMm) - Math.hypot(b.xMm - scout.xMm, b.zMm - scout.zMm));
    const scoutType = balance.units.find(unit => unit.id === 'scout')!, speed = scoutType.moveSpeedMps * 1000;
    const routes = candidates.flatMap(destination => {
      const route = navigation.path(scout, destination, 3000);
      if (!route?.length || route.length > balance.rules.orderQueueLimit) return [];
      const points = [scout, ...route], distance = points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.xMm - points[index]!.xMm, point.zMm - points[index]!.zMm), 0);
      return distance <= speed * 40 ? [{ destination, route, distance }] : [];
    }).sort((a, b) => a.distance - b.distance);
    expect(routes.length, 'A guarded valley route must fit 40 seconds and the ordinary command queue').toBeGreaterThan(0);
    const { destination, route, distance } = routes[0]!;
    console.log(`Barrier fixture: ${(distance / speed).toFixed(1)}s guarded route through ${route.length} ordinary waypoints.`);
    await host.bringToFront(); await host.getByRole('button', { name: 'Select army', exact: true }).click();
    const minimap = (await host.getByTestId('minimap').boundingBox())!;
    const pixel = { x: Math.round(minimap.x + destination.xMm / initial.map.widthMm * minimap.width), y: Math.round(minimap.y + destination.zMm / initial.map.heightMm * minimap.height) };
    const pixelError = Math.hypot(initial.map.widthMm / minimap.width / 2, initial.map.heightMm / minimap.height / 2);
    expect(pixelError + scoutType.collisionRadiusM * 1000, 'Route clearance must cover the scout and minimap rounding').toBeLessThan(3000);
    const before = state.commands.length;
    for (const [index, point] of route.entries()) {
      const prior = state.commands.length;
      if (index) await host.keyboard.down('Shift');
      try { await host.mouse.click(Math.round(minimap.x + point.xMm / initial.map.widthMm * minimap.width), Math.round(minimap.y + point.zMm / initial.map.heightMm * minimap.height), { button: 'right' }); }
      finally { if (index) await host.keyboard.up('Shift'); }
      await expect.poll(() => state.commands.slice(prior).find(envelope => envelope.command.kind === 'move')).toBeTruthy();
      const command = state.commands.slice(prior).find(envelope => envelope.command.kind === 'move')!;
      expect(command.command).toMatchObject({ kind: 'move', unitIds: [scout.id], queued: index > 0 });
      await expect.poll(() => state.receipts.find(receipt => receipt.clientCommandId === command.clientCommandId)?.status).toBe('accepted');
      expect(state.commands.slice(prior)).toHaveLength(1);
    }
    const envelope = state.commands.slice(before).at(-1)!;
    if (envelope.command.kind !== 'move') throw new Error('Missing ordinary move command');
    const target = envelope.command.target;
    expect(envelope.command.unitIds).toEqual([scout.id]);
    await expect.poll(() => state.receipts.find(receipt => receipt.clientCommandId === envelope.clientCommandId)?.status).toBe('accepted');
    await expect.poll(() => {
      const current = state.view!.entities.find(entity => entity.id === scout.id)!;
      return Math.hypot(current.xMm - target.xMm, current.zMm - target.zMm);
    }, { timeout: 60000 }).toBeLessThan(2500);
    expect(state.view!.fog.explored.length).toBeGreaterThan(initial.fog.explored.length);
    await host.mouse.click(pixel.x, pixel.y);
    await host.mouse.move(700, 400);
    const image = await renderedWorldSample(host);
    const colors = new Set(Array.from({ length: image.length / 4 }, (_, index) => image.slice(index * 4, index * 4 + 3).join(',')));
    expect(colors.size).toBeGreaterThan(25);
    await mkdir('runtime-data/e2e', { recursive: true });
    await host.screenshot({ path: 'runtime-data/e2e/natural-barriers-scout-valley.png' });
    // Rotate with the ordinary middle-button camera gesture; real depth must
    // change the rendered scene without sending a gameplay command.
    const commandCount = state.commands.length;
    await host.mouse.move(710, 330); await host.mouse.down({ button: 'middle' });
    await host.mouse.move(930, 350, { steps: 12 }); await host.mouse.up({ button: 'middle' });
    await expect.poll(async () => changedWorldPixels(image, await renderedWorldSample(host))).toBeGreaterThan(.03);
    expect(state.commands.length).toBe(commandCount);
    await host.screenshot({ path: 'runtime-data/e2e/natural-barriers-rotated-ridge.png' });
    const ridgeCenter = { xMm: destination.ridge.xMm + destination.ridge.widthMm / 2, zMm: destination.ridge.zMm + destination.ridge.depthMm / 2 };
    await host.mouse.click(minimap.x + ridgeCenter.xMm / initial.map.widthMm * minimap.width, minimap.y + ridgeCenter.zMm / initial.map.heightMm * minimap.height);
    await host.mouse.move(720, 340); await host.mouse.wheel(0, 360);
    await renderedWorldSample(host);
    await host.screenshot({ path: 'runtime-data/e2e/natural-barriers-public-ridge-overview.png' });
    expect(state.errors).toEqual([]); expect(other.errors).toEqual([]);
    expect(state.protocolErrors).toEqual([]); expect(other.protocolErrors).toEqual([]);
    const evidence = JSON.stringify({ generatorVersion: initial.map.generatorVersion, ridgeCount: ridges.length, ridge: destination.ridge, initialScout: scout, finalScout: state.view!.entities.find(entity => entity.id === scout.id), move: envelope, receipt: state.receipts.find(receipt => receipt.clientCommandId === envelope.clientCommandId), initialExplored: initial.fog.explored.length, finalExplored: state.view!.fog.explored.length, authorizedStartingResourceOverlap: false, errors: state.errors, protocolErrors: state.protocolErrors }, null, 2);
    await writeFile('runtime-data/e2e/natural-barriers-authorized-evidence.json', evidence);
    await testInfo.attach('natural-barriers-authorized-evidence', {
      body: evidence,
      contentType: 'application/json',
    });
  } finally { await hostContext.close(); await remoteContext.close(); }
});
