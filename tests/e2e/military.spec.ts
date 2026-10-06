import { capture, changedWorldPixels, renderedWorldSample } from './capture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { BuildingDefinition, PlayerView, UnitDefinition } from '@frontier/shared';
import { terrainBuildable, terrainHeightAt } from '../../packages/shared/src/terrain';

const catalogue = JSON.parse(readFileSync(new URL('../../data/balance.v1.json', import.meta.url), 'utf8')) as { buildings: BuildingDefinition[]; units: UnitDefinition[] };
const buildings = Object.fromEntries(catalogue.buildings.map((building) => [building.id, building]));
const villagerRadiusMm = catalogue.units.find(unit => unit.id === 'villager')!.collisionRadiusM * 1000;


// This fixture owns its host process and bootstrap token. It never relies on another
// test's one-time host login or changes the production authentication rules.
let server: ChildProcess | undefined;
let origin = '';
let serverOutput = '';
const bootstrap = 'military-browser-fixture-not-a-real-host-token';
const scenarioSeed = 'military-final-art-gate-breach-v1';
test.beforeAll(async () => {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist/server/index.js'], { windowsHide: true, env: { ...process.env, NODE_ENV: 'production', GAME_PORT: String(port), GAME_BIND: '127.0.0.1', GAME_LAN_MODE: 'false', GAME_DATA_DIR: `runtime-data/e2e-military-${port}`, HOST_ADMIN_BOOTSTRAP_TOKEN: bootstrap }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream?.on('data', (chunk) => { serverOutput = (serverOutput + chunk.toString()).slice(-6000); });
  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`Military fixture host exited: ${serverOutput}`);
    return fetch(`${origin}/api/health`).then((response) => response.ok).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
});
test.afterAll(async () => {
  if (server && server.exitCode === null) { const closed = new Promise<void>((resolve) => server!.once('exit', () => resolve())); server.kill('SIGTERM'); await closed; }
});


test('M3 real fortifications, garrison, gate passage, army orders, combat, and host draw', async ({ browser }) => {
  // The final-art extension includes ordinary travel and six unupgraded Villagers
  // attacking a 250-HP armored palisade. Individual phases remain bounded below.
  test.setTimeout(900000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } }), remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), remote = await remoteContext.newPage(); host.setDefaultTimeout(10000); remote.setDefaultTimeout(10000);
  const state = capture(host), enemy = capture(remote);
  const evidence=async(name:string,page:Page=host)=>{await mkdir('runtime-data/e2e',{recursive:true});await page.keyboard.down('Alt');await page.screenshot({path:`runtime-data/e2e/m7-military-${name}.png`});await page.keyboard.up('Alt');await writeFile(`runtime-data/e2e/m7-military-${name}.json`,JSON.stringify({view:page===host?state.view:enemy.view},null,2));};
  try {
    await host.goto(origin); await host.getByRole('tab', { name: 'Host access' }).click(); await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap); await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible(); const invite = await host.locator('.invite-code').innerText();
    await host.getByLabel('AI COMMANDERS').selectOption('0');
    await host.getByLabel('Private map seed', { exact: true }).fill(scenarioSeed); const seedSaved = host.waitForResponse(response => response.url() === `${origin}/api/host/seed` && response.request().method() === 'POST'); await host.getByRole('button', { name: 'Set seed', exact: true }).click(); expect((await seedSaved).status()).toBe(200);
    console.log(`M7 military scenario seed: ${scenarioSeed}.`);
    await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto(origin); await remote.getByLabel('YOUR NAME').fill('Birch'); await remote.getByLabel('INVITATION CODE').fill(invite); await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await expect(host.getByRole('checkbox', { name: 'Enable Monument victory' })).not.toBeChecked();
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click(); await host.getByRole('button', { name: 'Begin match' }).click();
    await expect.poll(() => state.view?.status, { timeout: 35000 }).toBe('RUNNING'); await expect.poll(() => enemy.view?.status, { timeout: 35000 }).toBe('RUNNING');
    const playerId = state.view!.playerId, enemyId = enemy.view!.playerId, base = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'town_center')!;
    const scout = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'scout')!;
    const foreignScout = enemy.view!.entities.find((entity) => entity.ownerId === enemyId && entity.typeId === 'scout')!;
    const grid = 2000;
    const breachApproach=(point:{xMm:number;zMm:number},left:number,north:number,surveyed=false)=>{
      const x=Math.floor(point.xMm/grid),z=Math.floor(point.zMm/grid),edge=x===left&&z>north&&z<north+4?[-1,0]:x===left+4&&z>north&&z<north+4?[1,0]:z===north+4&&x>left&&x<left+4?[0,1]:undefined;
      if(!edge||Math.hypot(point.xMm-base.xMm,point.zMm-base.zMm)<=17000)return undefined;
      // Six Villagers occupy three columns and two rows. Leave their complete
      // formation room beside known static bodies, plus minimap pixel rounding.
      const spacing=Math.ceil((villagerRadiusMm*4+200)/1000)*1000,halfWidth=spacing+villagerRadiusMm+1000,halfDepth=spacing/2+villagerRadiusMm+1000;
      const view=state.view!,fogCell=view.map.fogCellMm,columns=Math.ceil(view.map.widthMm/fogCell),knownCells=new Set([...view.fog.explored,...view.fog.visible]);
      // Survey first, then choose among three ordinary staging points along the
      // same wall face. Remembered statics remain obstacles when outside sight.
      for(const along of surveyed?[0,-grid,grid]:[0]){
        const approach={xMm:point.xMm+edge[0]!*4500+edge[1]!*along,zMm:point.zMm+edge[1]!*4500+edge[0]!*along};
        if(!terrainBuildable(view.map.terrain??[],{xMm:approach.xMm-halfWidth,zMm:approach.zMm-halfDepth,widthMm:halfWidth*2,depthMm:halfDepth*2}))continue;
        if(surveyed){
          if(approach.xMm-halfWidth<0||approach.zMm-halfDepth<0||approach.xMm+halfWidth>=view.map.widthMm||approach.zMm+halfDepth>=view.map.heightMm)continue;
          let known=true;
          for(let row=Math.floor((approach.zMm-halfDepth)/fogCell);row<=Math.floor((approach.zMm+halfDepth)/fogCell);row++)for(let column=Math.floor((approach.xMm-halfWidth)/fogCell);column<=Math.floor((approach.xMm+halfWidth)/fogCell);column++)if(!knownCells.has(row*columns+column))known=false;
          if(!known)continue;
        }
        if(view.entities.some(entity=>{
          if(entity.kind==='unit')return false;
          let [width,depth]=entity.kind==='building'?buildings[entity.typeId]!.footprintCells.map(extent=>extent*grid/2):[1000,1000];
          if((entity.rotation??0)%180)[width,depth]=[depth,width];
          return Math.abs(entity.xMm-approach.xMm)<halfWidth+width!&&Math.abs(entity.zMm-approach.zMm)<halfDepth+depth!;
        }))continue;
        return approach;
      }
      return undefined;
    };
    const candidates = [];
    for (let dx = -18000; dx <= 18000; dx += grid) for (let dz = -18000; dz <= 18000; dz += grid) {
      if (Math.hypot(dx, dz) < 11000 || Math.hypot(dx, dz) > 21000) continue;
      const x = Math.floor((base.xMm + dx) / grid) - 2, z = Math.floor((base.zMm + dz) / grid) - 2;
      const bounds = { xMm: x * grid, zMm: z * grid, widthMm: 5 * grid, depthMm: 5 * grid };
      if (bounds.xMm < 0 || bounds.zMm < 0 || bounds.xMm + bounds.widthMm >= state.view!.map.widthMm || bounds.zMm + bounds.depthMm >= state.view!.map.heightMm || !terrainBuildable(state.view!.map.terrain ?? [], bounds) || terrainHeightAt(state.view!.map.terrain ?? [], bounds.xMm, bounds.zMm)) continue;
      if ([0, 1, 2, 3, 4].some((cx) => [0, 1, 2, 3, 4].some((cz) => terrainHeightAt(state.view!.map.terrain ?? [], (x + cx + 0.5) * grid, (z + cz + 0.5) * grid) !== 0))) continue;
      // Select a complete enclosure with an ordinary exterior assault site before
      // spending on walls; the later breach must stay outside Town Center fire.
      if(![1,2,3].some(offset=>[[x,z+offset],[x+4,z+offset],[x+offset,z+4]].some(([cx,cz])=>breachApproach({xMm:(cx!+.5)*grid,zMm:(cz!+.5)*grid},x,z))))continue;
      const blocked = state.view!.entities.some((entity) => { const footprint = buildings[entity.typeId]?.footprintCells; let width = footprint ? footprint[0] * grid : 2000, depth = footprint ? footprint[1] * grid : 2000; if ((entity.rotation ?? 0) % 180) [width, depth] = [depth, width]; return entity.xMm + width / 2 > bounds.xMm - 1000 && entity.xMm - width / 2 < bounds.xMm + bounds.widthMm + 1000 && entity.zMm + depth / 2 > bounds.zMm - 1000 && entity.zMm - depth / 2 < bounds.zMm + bounds.depthMm + 1000; });
      if (!blocked) candidates.push({ x, z, distance: Math.hypot(dx, dz) });
    }
    candidates.sort((a, b) => a.distance - b.distance); expect(candidates.length).toBeGreaterThan(0);
    const { x: left, z: north } = candidates[0]!, center = { xMm: (left + 2.5) * grid, zMm: (north + 2.5) * grid };
    console.log(`M3 browser: authorized clear enclosure (${left},${north}) to (${left + 4},${north + 4}).`);
    const ownScout = () => state.view!.entities.find((entity) => entity.id === scout.id);
    const inside = (point: { xMm: number; zMm: number }) => point.xMm > (left + 1) * grid && point.xMm < (left + 4) * grid && point.zMm > (north + 1) * grid && point.zMm < (north + 4) * grid;
    async function minimapOrder(page: Page, snapshot: PlayerView, point: { xMm: number; zMm: number }) { const box = (await page.getByTestId('minimap').boundingBox())!; await page.mouse.click(box.x + point.xMm / snapshot.map.widthMm * box.width, box.y + point.zMm / snapshot.map.heightMm * box.height, { button: 'right' }); }
    async function focusAt(page:Page,snapshot:PlayerView,point:{xMm:number;zMm:number}) {
      const minimap = page.getByTestId('minimap'), box = (await minimap.boundingBox())!, x = Math.round(box.x + point.xMm / snapshot.map.widthMm * box.width), y = Math.round(box.y + point.zMm / snapshot.map.heightMm * box.height);
      await minimap.evaluate((element, map) => element.addEventListener('click', (event) => { const pointer = event as MouseEvent, rect = element.getBoundingClientRect(); console.debug('M3_FOCUS ' + JSON.stringify({ xMm: Math.round((pointer.clientX - rect.left) / rect.width * map.widthMm), zMm: Math.round((pointer.clientY - rect.top) / rect.height * map.heightMm) })); }, { once: true }), snapshot.map);
      const observed = page.waitForEvent('console', (message) => message.text().startsWith('M3_FOCUS '));
      await page.mouse.click(x, y); return JSON.parse((await observed).text().slice('M3_FOCUS '.length)) as { xMm: number; zMm: number };
    }
    const focusEnclosure=()=>focusAt(host,state.view!,center);
    // Project authorized ground coordinates through the documented initial RTS camera.
    // The only mutation is a real pointer click/drag on the rendered canvas.
    function screen(point: { xMm: number; zMm: number }, elevation = 0, focus: { xMm: number; zMm: number } = base,viewport={width:1440,height:900}) {
      const alpha = -Math.PI / 2.6, beta = 0.82, radius = 45;
      const offset = [radius * Math.cos(alpha) * Math.sin(beta), radius * Math.cos(beta), radius * Math.sin(alpha) * Math.sin(beta)];
      const forward = offset.map((value) => -value / radius), right = [Math.cos(alpha + Math.PI / 2), 0, Math.sin(alpha + Math.PI / 2)];
      const up = [forward[1]! * right[2]!, forward[2]! * right[0]! - forward[0]! * right[2]!, -forward[1]! * right[0]!];
      const relative = [point.xMm / 1000 - focus.xMm / 1000 - offset[0]!, elevation - offset[1]!, point.zMm / 1000 - focus.zMm / 1000 - offset[2]!];
      const dot = (vector: number[]) => relative.reduce((sum, value, index) => sum + value * vector[index]!, 0), scale = viewport.height / (2 * Math.tan(0.4));
      return { x: viewport.width/2 + dot(right) * scale / dot(forward), y: viewport.height/2 - dot(up) * scale / dot(forward) };
    }
    console.log('M3 browser: testing genuine garrison and owned unit orders.');
    await host.getByRole('button', { name: 'Select army', exact: true }).click(); await host.getByLabel('Unit stance').selectOption('stand_ground');
    await host.getByRole('button', { name: 'Garrison', exact: true }).click(); const roof = screen(base, 3); await host.mouse.click(roof.x, roof.y);
    await expect.poll(() => ownScout()?.garrisonedIn, { timeout: 20000 }).toBe(base.id);
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await expect(host.locator('.garrison-controls')).toContainText('1 / 15'); await host.getByRole('button', { name: 'Ungarrison all yours' }).click();
    await expect.poll(() => ownScout()?.garrisonedIn).toBeUndefined();
    await host.getByRole('button', { name: 'Select army', exact: true }).click(); await minimapOrder(host, state.view!, center); await expect.poll(() => !!ownScout() && inside(ownScout()!), { timeout: 20000 }).toBe(true);
    // Reaching the enclosure must actually reveal the full assault formation
    // rectangle before we stop the Scout or spend on an unsuitable wall site.
    await expect.poll(()=>[1,2,3].some(offset=>[[left,north+offset],[left+4,north+offset],[left+offset,north+4]].some(([x,z])=>breachApproach({xMm:(x!+.5)*grid,zMm:(z!+.5)*grid},left,north,true))),{message:'A fully surveyed assault formation must fit beside the planned enclosure',timeout:20000}).toBe(true);
    await evidence('surveyed-assault-site');
    await host.getByRole('button', { name: 'Hold position', exact: true }).click(); await expect.poll(() => ownScout()?.stance).toBe('stand_ground');
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await expect.poll(() => state.view!.self.resources.wood, { timeout: 70000 }).toBeGreaterThanOrEqual(320);
    await host.getByRole('button', { name: 'Stop selected units', exact: true }).click();
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('tab', { name: 'fortifications', exact: true }).click();
    let standaloneGate = '';
    for (const [x, y] of [[550, 340], [620, 300], [820, 330], [870, 400], [500, 430], [650, 530], [550, 510], [730, 270]]) {
      await host.getByRole('button', { name: 'Build Wooden Gate', exact: true }).click(); await host.keyboard.press('e'); await host.mouse.move(x!, y!);
      if (!(await host.locator('.placement-notice').innerText()).includes('Clear visible site')) { await host.keyboard.press('Escape'); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); continue; }
      await host.mouse.click(x!, y!); await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === playerId && entity.typeId === 'wooden_gate')).toBe(true); standaloneGate = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'wooden_gate')!.id; break;
    }
    expect(standaloneGate).not.toBe(''); expect(state.view!.entities.find((entity) => entity.id === standaloneGate)?.rotation).toBe(90);
    await host.getByLabel('Select building', { exact: true }).selectOption(standaloneGate); await host.getByRole('button', { name: 'Cancel foundation', exact: true }).click(); await expect.poll(() => state.view!.entities.some((entity) => entity.id === standaloneGate)).toBe(false);
    console.log('M3 browser: scout inside planned enclosure; building four legal wall batches.');

    const corners = [{ x: left, z: north }, { x: left + 4, z: north }, { x: left + 4, z: north + 4 }, { x: left, z: north + 4 }];
    const stopBuilders = async () => {
      await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
      const before = state.commands.length;
      await host.getByRole('button', { name: 'Stop selected units', exact: true }).click();
      await expect.poll(() => state.commands.slice(before).find(envelope => envelope.command.kind === 'stop')?.clientCommandId).toBeTruthy();
      const stop = state.commands.slice(before).find(envelope => envelope.command.kind === 'stop')!;
      await expect.poll(() => state.receipts.find(receipt => receipt.clientCommandId === stop.clientCommandId)?.status).toBe('accepted');
      await expect.poll(() => state.view!.tick).toBeGreaterThanOrEqual(state.receipts.find(receipt => receipt.clientCommandId === stop.clientCommandId)!.tick);
    };
    for (let side = 0; side < 4; side++) {
      const a = corners[side]!, b = corners[(side + 1) % 4]!;
      // Completed builders can resume automatic work. Freeze them through an
      // ordinary accepted Stop before checking the next placement corridor.
      await stopBuilders();
      const obstructingWorkers = () => state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === 'villager').some((entity) => entity.xMm > Math.min(a.x, b.x) * grid - 500 && entity.xMm < (Math.max(a.x, b.x) + 1) * grid + 500 && entity.zMm > Math.min(a.z, b.z) * grid - 500 && entity.zMm < (Math.max(a.z, b.z) + 1) * grid + 500);
      if (obstructingWorkers()) {
        const columns = Math.ceil(state.view!.map.widthMm / state.view!.map.fogCellMm), visible = new Set(state.view!.fog.visible);
        const parking = [[-12000, -12000], [-12000, 12000], [12000, -12000], [12000, 12000]].map(([dx, dz]) => ({ xMm: base.xMm + dx!, zMm: base.zMm + dz! })).find((point) => visible.has(Math.floor(point.zMm / state.view!.map.fogCellMm) * columns + Math.floor(point.xMm / state.view!.map.fogCellMm)) && !inside(point) && terrainBuildable(state.view!.map.terrain ?? [], { xMm: point.xMm - 2000, zMm: point.zMm - 2000, widthMm: 4000, depthMm: 4000 }) && !state.view!.entities.some((entity) => { if (entity.kind === 'unit') return false; const footprint = buildings[entity.typeId]?.footprintCells; let width = footprint ? footprint[0] * grid : 2000, depth = footprint ? footprint[1] * grid : 2000; if ((entity.rotation ?? 0) % 180) [width, depth] = [depth, width]; return Math.abs(entity.xMm - point.xMm) < width / 2 + 2500 && Math.abs(entity.zMm - point.zMm) < depth / 2 + 2500; }));
        expect(parking).toBeDefined();
        // Move re-enables idle gathering. Keep earlier arrivals parked while the
        // rest arrive; explicit movement and construction still work in this stance.
        await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('tab', { name: 'orders', exact: true }).click();
        const parkingBuilders = state.view!.entities.filter(entity => entity.ownerId === playerId && entity.typeId === 'villager');
        expect(parkingBuilders).toHaveLength(6);
        if (parkingBuilders.some(entity => entity.stance !== 'stand_ground')) {
          const beforeParkingStance = state.commands.length;
          await host.getByLabel('Unit stance').selectOption('stand_ground');
          await expect.poll(() => state.commands.slice(beforeParkingStance).find(envelope => envelope.command.kind === 'set_stance')?.clientCommandId).toBeTruthy();
          const parkingStance = state.commands.slice(beforeParkingStance).find(envelope => envelope.command.kind === 'set_stance')!;
          expect(parkingStance.command.kind === 'set_stance' && parkingStance.command.unitIds.length).toBe(6);
          await expect.poll(() => state.receipts.find(receipt => receipt.clientCommandId === parkingStance.clientCommandId)?.status).toBe('accepted');
        }
        await expect.poll(() => state.view!.entities.filter(entity => entity.ownerId === playerId && entity.typeId === 'villager').every(entity => entity.stance === 'stand_ground')).toBe(true);
        await minimapOrder(host, state.view!, parking!);
        await expect.poll(() => !obstructingWorkers() && state.view!.entities.filter(entity => entity.ownerId === playerId && entity.typeId === 'villager').every(entity => Math.hypot(entity.xMm - parking!.xMm, entity.zMm - parking!.zMm) <= 6000), { timeout: 25000 }).toBe(true);
        await stopBuilders(); expect(obstructingWorkers()).toBe(false);
      }
      const focus = await focusEnclosure(); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('tab', { name: 'fortifications', exact: true }).click();
      await expect(host.getByRole('button', { name: 'Build Stone Wall', exact: true })).toBeDisabled();
      const begin = screen({ xMm: (a.x + 0.5) * grid, zMm: (a.z + 0.5) * grid }, 0, focus), end = screen({ xMm: (b.x + 0.5) * grid, zMm: (b.z + 0.5) * grid }, 0, focus);
      const before = state.commands.filter((envelope) => envelope.command.kind === 'build_wall').length;
      await host.getByRole('button', { name: 'Build Palisade Wall', exact: true }).click(); await host.mouse.move(begin.x, begin.y); await host.mouse.down(); await host.mouse.move(end.x, end.y, { steps: 8 });
      await expect(host.locator('.placement-notice')).toContainText('Clear visible wall path'); await host.mouse.up();
      await expect.poll(() => state.commands.filter((envelope) => envelope.command.kind === 'build_wall').length).toBe(before + 1);
      const command = state.commands.filter((envelope) => envelope.command.kind === 'build_wall').at(-1)!;
      if (command.command.kind === 'build_wall') { expect(command.command.cells[0]).toEqual(a); expect(command.command.cells.at(-1)).toEqual(b); }
      await expect.poll(() => state.receipts.find((receipt) => receipt.clientCommandId === command.clientCommandId)?.status).toBe('accepted');
      const expectedWallCount = [5, 9, 13, 16][side]!;
      await expect.poll(() => { const walls = state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === 'palisade_wall'); return walls.length === expectedWallCount && walls.every((entity) => entity.progress === 1); }, { timeout: 50000 }).toBe(true);
      console.log(`M3 browser: enclosure side ${side + 1} complete, ${expectedWallCount} segments.`);
    }
    expect(state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === 'palisade_wall')).toHaveLength(16);
    await host.keyboard.down('Alt'); await host.screenshot({ path: 'runtime-data/e2e/m3-enclosure.png' }); await host.keyboard.up('Alt');
    const middle = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'palisade_wall' && entity.xMm === (left + 2.5) * grid && entity.zMm === (north + 0.5) * grid)!;
    await host.getByLabel('Select building', { exact: true }).selectOption(middle.id); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await host.getByRole('button', { name: 'Replace walls with Wooden Gate', exact: true }).click();
    const beforeReplacement = state.commands.filter((envelope) => envelope.command.kind === 'replace_wall_with_gate').length;
    // This center click deliberately passes through the gap between the visible stakes.
    const middlePixel = screen(middle, 1.5, middle); await host.mouse.click(middlePixel.x, middlePixel.y);
    await expect.poll(() => state.commands.filter((envelope) => envelope.command.kind === 'replace_wall_with_gate').length).toBe(beforeReplacement + 1);
    const replacement = state.commands.filter((envelope) => envelope.command.kind === 'replace_wall_with_gate').at(-1)!;
    await expect.poll(() => state.receipts.find((receipt) => receipt.clientCommandId === replacement.clientCommandId)?.status).toBe('accepted');
    await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === playerId && entity.typeId === 'wooden_gate'), { timeout: 10000 }).toBe(true);
    const gate = state.view!.entities.find((entity) => entity.ownerId === playerId && entity.typeId === 'wooden_gate')!;
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === gate.id)?.progress, { timeout: 45000 }).toBe(1);
    await host.getByLabel('Select building', { exact: true }).selectOption(gate.id); await host.getByLabel('Gate mode').selectOption('OPEN'); await expect.poll(() => state.view!.entities.find((entity) => entity.id === gate.id)?.gateOpen).toBe(true);
    await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); await minimapOrder(host, state.view!, { xMm: base.xMm - 9000, zMm: base.zMm + 10000 });
    await expect.poll(() => state.view!.entities.filter((entity) => entity.ownerId === playerId && entity.typeId === 'villager').every((entity) => !inside(entity)), { timeout: 25000 }).toBe(true);
    await host.getByLabel('Select building', { exact: true }).selectOption(gate.id); await host.getByLabel('Gate mode').selectOption('LOCKED'); await expect.poll(() => state.view!.entities.find((entity) => entity.id === gate.id)?.gateOpen).toBe(false);
    const exitMap = (await host.getByTestId('minimap').boundingBox())!, exitView = state.view!, exitVisible = new Set(exitView.fog.visible), exitColumns = Math.ceil(exitView.map.widthMm / exitView.map.fogCellMm);
    const beyondGate = [0, 8000, -8000, 12000, -12000].flatMap(dx => [-10000, -6000, -4000].map(dz => {
      const pixel = { x: Math.round(exitMap.x + (gate.xMm + dx) / exitView.map.widthMm * exitMap.width), y: Math.round(exitMap.y + (gate.zMm + dz) / exitView.map.heightMm * exitMap.height) };
      const point = { xMm: Math.round((pixel.x - exitMap.x) / exitMap.width * exitView.map.widthMm), zMm: Math.round((pixel.y - exitMap.y) / exitMap.height * exitView.map.heightMm) };
      return { pixel, point };
    })).find(({point}) => point.zMm < gate.zMm - 3500 && exitVisible.has(Math.floor(point.zMm / exitView.map.fogCellMm) * exitColumns + Math.floor(point.xMm / exitView.map.fogCellMm)) && terrainBuildable(exitView.map.terrain ?? [], { xMm: point.xMm - 1000, zMm: point.zMm - 1000, widthMm: 2000, depthMm: 2000 }) && !exitView.entities.some(entity => {
      if(entity.kind === 'unit' || entity.ghost)return false;
      const footprint = buildings[entity.typeId]?.footprintCells; let width = footprint ? footprint[0] * grid : 2000, depth = footprint ? footprint[1] * grid : 2000;
      if((entity.rotation ?? 0) % 180)[width, depth] = [depth, width];
      return Math.abs(entity.xMm - point.xMm) < width / 2 + 1500 && Math.abs(entity.zMm - point.zMm) < depth / 2 + 1500;
    }));
    expect(beyondGate, 'A currently visible, unobstructed exterior destination must exist beyond the locked gate').toBeDefined();
    console.log(`M3 browser: legal gate exit target (${beyondGate!.point.xMm},${beyondGate!.point.zMm}).`);
    await host.getByRole('button', { name: 'Select army', exact: true }).click(); await host.mouse.click(beyondGate!.pixel.x, beyondGate!.pixel.y, { button: 'right' });
    const blockedTick = state.view!.tick; await expect.poll(() => state.view!.tick).toBeGreaterThan(blockedTick + 40); expect(inside(ownScout()!)).toBe(true);
    await host.getByLabel('Select building', { exact: true }).selectOption(gate.id); await host.getByLabel('Gate mode').selectOption('AUTO');
    await expect.poll(() => !!state.view!.entities.find((entity) => entity.id === gate.id)?.gateOpen&&!!ownScout()&&Math.abs(ownScout()!.zMm-gate.zMm)<2800, { timeout: 15000,intervals:[25,50,100] }).toBe(true);
    await evidence('gate-traffic');
    await expect.poll(() => ownScout()!.zMm, { timeout: 25000 }).toBeLessThan(gate.zMm - 2500);
    await host.screenshot({ path: 'runtime-data/e2e/m3-gate-passage.png' });
    console.log('M3 browser: locked enclosure blocked movement; auto gate admitted the scout.');

    // Build the normal Age I producer and train the anti-cavalry unit through the HUD.
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click();
    // The gate-exit Move and automatic gathering can carry workers into a clear
    // footprint between survey and placement. Stabilize them with an ordinary Stop.
    await stopBuilders();
    await expect.poll(() => {
      const workers = state.view!.entities.filter(entity => entity.ownerId === playerId && entity.typeId === 'villager');
      return workers.length === 6 && workers.every(entity => entity.taskState === 'idle');
    }).toBe(true);
    await host.getByRole('tab', { name: 'economy', exact: true }).click();
    const placementView = state.view!, placementVisible = new Set(placementView.fog.visible), placementColumns = Math.ceil(placementView.map.widthMm / placementView.map.fogCellMm), [barracksWidth, barracksDepth] = buildings.barracks!.footprintCells;
    const barracksSites: { cell: { x: number; z: number }; center: { xMm: number; zMm: number }; distance: number }[] = [];
    for (let x = Math.floor(base.xMm / grid) - 14; x <= Math.floor(base.xMm / grid) + 14; x++) for (let z = Math.floor(base.zMm / grid) - 14; z <= Math.floor(base.zMm / grid) + 14; z++) {
      const bounds = { xMm: x * grid, zMm: z * grid, widthMm: barracksWidth * grid, depthMm: barracksDepth * grid }, point = { xMm: bounds.xMm + bounds.widthMm / 2, zMm: bounds.zMm + bounds.depthMm / 2 };
      if (bounds.xMm < 0 || bounds.zMm < 0 || bounds.xMm + bounds.widthMm > placementView.map.widthMm || bounds.zMm + bounds.depthMm > placementView.map.heightMm || !terrainBuildable(placementView.map.terrain ?? [], bounds) || terrainHeightAt(placementView.map.terrain ?? [], point.xMm, point.zMm) !== 0) continue;
      if (Array.from({ length: barracksDepth }, (_, dz) => dz).some(dz => Array.from({ length: barracksWidth }, (_, dx) => dx).some(dx => !placementVisible.has(Math.floor((z + dz) * grid / placementView.map.fogCellMm) * placementColumns + Math.floor((x + dx) * grid / placementView.map.fogCellMm))))) continue;
      if (placementView.entities.some(entity => {
        if (entity.ghost || entity.garrisonedIn) return false;
        let [halfWidth, halfDepth] = entity.kind === 'building' ? buildings[entity.typeId]!.footprintCells.map(extent => extent * grid / 2) : [entity.kind === 'unit' ? 400 : 1000, entity.kind === 'unit' ? 400 : 1000];
        if ((entity.rotation ?? 0) % 180) [halfWidth, halfDepth] = [halfDepth, halfWidth];
        return Math.abs(entity.xMm - point.xMm) < bounds.widthMm / 2 + halfWidth! + 750 && Math.abs(entity.zMm - point.zMm) < bounds.depthMm / 2 + halfDepth! + 750;
      })) continue;
      barracksSites.push({ cell: { x, z }, center: point, distance: Math.hypot(point.xMm - base.xMm, point.zMm - base.zMm) });
    }
    barracksSites.sort((a, b) => a.distance - b.distance); expect(barracksSites.length, 'The Barracks requires a currently visible, clear full footprint').toBeGreaterThan(0);
    const barracksSite = barracksSites[0]!, barracksFocus = await focusAt(host, state.view!, barracksSite.center), barracksPixel = screen({ xMm: (barracksSite.cell.x + .5) * grid, zMm: (barracksSite.cell.z + .5) * grid }, 0, barracksFocus);
    const beforeBarracks = state.commands.length;
    await host.getByRole('button', { name: 'Build Barracks', exact: true }).click(); await host.mouse.move(barracksPixel.x, barracksPixel.y); await expect(host.locator('.placement-notice')).toContainText('Clear visible site'); await host.mouse.click(barracksPixel.x, barracksPixel.y);
    await expect.poll(() => state.commands.slice(beforeBarracks).find(envelope => envelope.command.kind === 'build' && envelope.command.buildingType === 'barracks')?.clientCommandId).toBeTruthy();
    const barracksCommand = state.commands.slice(beforeBarracks).find(envelope => envelope.command.kind === 'build' && envelope.command.buildingType === 'barracks')!;
    expect(barracksCommand.command).toMatchObject({ kind: 'build', buildingType: 'barracks', originCell: barracksSite.cell, rotation: 0 });
    await expect.poll(() => state.receipts.find(receipt => receipt.clientCommandId === barracksCommand.clientCommandId)?.status).toBe('accepted');
    await expect.poll(() => state.view!.entities.some(entity => entity.ownerId === playerId && entity.typeId === 'barracks')).toBe(true);
    const barracksId = state.view!.entities.find(entity => entity.ownerId === playerId && entity.typeId === 'barracks')!.id;
    console.log(`M3 browser: normal Barracks construction at visible cell (${barracksSite.cell.x},${barracksSite.cell.z}).`);
    await expect.poll(() => state.view!.entities.find((entity) => entity.id === barracksId)?.progress, { timeout: 50000 }).toBe(1);
    await host.getByRole('button', { name: 'Select Barracks', exact: true }).click(); await host.getByRole('button', { name: 'Train Spearman', exact: true }).click();
    const away = Math.hypot(gate.xMm - base.xMm, gate.zMm - base.zMm), meeting = { xMm: Math.round(base.xMm + (gate.xMm - base.xMm) / away * 32000), zMm: Math.round(base.zMm + (gate.zMm - base.zMm) / away * 32000) };
    const assaultCandidates=()=>state.view!.entities.filter(entity=>entity.ownerId===playerId&&entity.typeId==='palisade_wall').map(wall=>{
      const approach=breachApproach(wall,left,north,true);return approach?{wall,approach}:undefined;
    }).filter((candidate):candidate is NonNullable<typeof candidate>=>!!candidate).sort((a,b)=>Math.hypot(b.wall.xMm-base.xMm,b.wall.zMm-base.zMm)-Math.hypot(a.wall.xMm-base.xMm,a.wall.zMm-base.zMm));
    const previewCandidates=assaultCandidates();expect(previewCandidates.length).toBeGreaterThan(0);const assaultArea=previewCandidates[0]!.approach;
    const foreignBase=enemy.view!.entities.find(entity=>entity.ownerId===enemyId&&entity.typeId==='town_center')!;
    await remote.getByRole('button', { name: 'Select army', exact: true }).click(); await remote.getByLabel('Unit stance').selectOption('stand_ground'); await minimapOrder(remote, enemy.view!, meeting);
    // The retained failed run still had 384–389 m left 9.3 s after dispatch: at
    // 3 m/s, entering the 6 m arrival radius needed another 126–128 s. Stage the
    // ordinary Villagers during this Scout's journey; keep the 120 s assault gate.
    // Use the Scout's actually explored corridor, well outside the host battle.
    const spacing=Math.ceil((villagerRadiusMm*4+200)/1000)*1000, musterHalfWidth=spacing+villagerRadiusMm+1000,musterHalfDepth=spacing/2+villagerRadiusMm+1000;
    let muster:{xMm:number;zMm:number}|undefined;
    await expect.poll(()=>{
      const view=enemy.view!,traveller=view.entities.find(entity=>entity.id===foreignScout.id);if(!traveller)return false;
      const columns=Math.ceil(view.map.widthMm/view.map.fogCellMm),known=new Set([...view.fog.explored,...view.fog.visible]);
      muster=[[0,0],[-4000,0],[4000,0],[0,-4000],[0,4000],[-4000,-4000],[4000,-4000],[-4000,4000],[4000,4000]].map(([dx,dz])=>({xMm:traveller.xMm+dx!,zMm:traveller.zMm+dz!})).find(point=>{
        const leg=Math.hypot(point.xMm-assaultArea.xMm,point.zMm-assaultArea.zMm);
        if(leg<100000||leg>240000||Math.hypot(point.xMm-meeting.xMm,point.zMm-meeting.zMm)<60000)return false;
        const bounds={xMm:point.xMm-musterHalfWidth,zMm:point.zMm-musterHalfDepth,widthMm:musterHalfWidth*2,depthMm:musterHalfDepth*2};
        if(bounds.xMm<0||bounds.zMm<0||bounds.xMm+bounds.widthMm>=view.map.widthMm||bounds.zMm+bounds.depthMm>=view.map.heightMm||!terrainBuildable(view.map.terrain??[],bounds))return false;
        for(let row=Math.floor(bounds.zMm/view.map.fogCellMm);row<=Math.floor((bounds.zMm+bounds.depthMm)/view.map.fogCellMm);row++)for(let column=Math.floor(bounds.xMm/view.map.fogCellMm);column<=Math.floor((bounds.xMm+bounds.widthMm)/view.map.fogCellMm);column++)if(!known.has(row*columns+column))return false;
        return !view.entities.some(entity=>{
          if(entity.kind==='unit'||entity.kind==='resource'&&entity.amount===0)return false;
          let [width,depth]=entity.kind==='building'?buildings[entity.typeId]!.footprintCells.map(extent=>extent*grid/2):[entity.forest?entity.forest.cellMm/2:1000,entity.forest?entity.forest.cellMm/2:1000];
          if((entity.rotation??0)%180)[width,depth]=[depth,width];
          return Math.abs(entity.xMm-point.xMm)<musterHalfWidth+width!&&Math.abs(entity.zMm-point.zMm)<musterHalfDepth+depth!;
        });
      });
      return !!muster;
    },{message:'The travelling enemy Scout must survey a clear muster outside the host battle lane',timeout:45000}).toBe(true);
    await remote.getByRole('button',{name:'Select villagers',exact:true}).click();await remote.getByRole('tab',{name:'orders',exact:true}).click();await remote.getByLabel('Unit stance').selectOption('stand_ground');
    const beforeMuster=enemy.commands.length;await minimapOrder(remote,enemy.view!,muster!);
    await expect.poll(()=>enemy.commands.slice(beforeMuster).find(envelope=>envelope.command.kind==='move')?.clientCommandId).toBeTruthy();
    const musterCommand=enemy.commands.slice(beforeMuster).find(envelope=>envelope.command.kind==='move')!;
    if(musterCommand.command.kind==='move')expect(musterCommand.command.unitIds).toHaveLength(6);
    await expect.poll(()=>enemy.receipts.find(receipt=>receipt.clientCommandId===musterCommand.clientCommandId)?.status).toBe('accepted');
    console.log(`M7 final art: enemy Villagers travelling early to surveyed muster (${muster!.xMm},${muster!.zMm}), outside the Scout battle lane.`);
    await expect.poll(() => state.view!.entities.some((entity) => entity.ownerId === playerId && entity.typeId === 'spearman'), { timeout: 40000 }).toBe(true);
    await expect.poll(() => { const unit = enemy.view!.entities.find((entity) => entity.id === foreignScout.id); return unit ? Math.hypot(unit.xMm - meeting.xMm, unit.zMm - meeting.zMm) : Infinity; }, { timeout: 70000 }).toBeLessThan(3000);
    await host.getByRole('button', { name: 'Select army', exact: true }).click(); await host.getByLabel('Unit stance').selectOption('aggressive'); await host.getByRole('button', { name: 'Attack-move', exact: true }).click(); await minimapOrder(host, state.view!, meeting);
    const battleMinimap = (await host.getByTestId('minimap').boundingBox())!; await host.mouse.click(battleMinimap.x + meeting.xMm / state.view!.map.widthMm * battleMinimap.width, battleMinimap.y + meeting.zMm / state.view!.map.heightMm * battleMinimap.height);
    await expect.poll(()=>state.view!.entities.some(entity=>entity.ownerId===playerId&&entity.visualAction?.kind==='attack')||state.view!.effects?.some(effect=>effect.kind==='hit'),{timeout:60000,intervals:[50,100]}).toBe(true);
    await evidence('active-combat');
    await expect.poll(() => enemy.view!.entities.some((entity) => entity.id === foreignScout.id), { timeout: 60000 }).toBe(false);
    await evidence('combat-aftermath');
    await host.screenshot({ path: 'runtime-data/e2e/m3-combat.png' });
    const survivingArmy = () => state.view!.entities.filter(entity => entity.ownerId === playerId && entity.kind === 'unit' && entity.typeId !== 'villager');
    expect(survivingArmy(), 'Both trained army units must survive for the compact gate and breach traversal checks').toHaveLength(2);

    // A real opponent breaches the wall. No demolition, damage injection, age grant,
    // resource grant or omniscient attack target substitutes for this combat phase.
    await host.getByRole('button',{name:'Select army',exact:true}).click();await host.getByLabel('Unit stance').selectOption('stand_ground');await minimapOrder(host,state.view!,center);
    await expect.poll(()=>survivingArmy().length===2&&survivingArmy().every(inside),{timeout:45000}).toBe(true);
    await host.getByLabel('Select building',{exact:true}).selectOption(gate.id);await host.getByLabel('Gate mode').selectOption('LOCKED');await expect.poll(()=>state.view!.entities.find(entity=>entity.id===gate.id)?.gateOpen).toBe(false);
    const breachCandidates=assaultCandidates();expect(breachCandidates.length).toBeGreaterThan(0);const {wall:breach,approach}=breachCandidates[0]!;
    await remote.getByRole('button',{name:'Select villagers',exact:true}).click();await remote.getByRole('tab',{name:'orders',exact:true}).click();await remote.getByLabel('Unit stance').selectOption('stand_ground');await minimapOrder(remote,enemy.view!,approach);
    console.log(`M7 final art: six ordinary enemy Villagers approaching visible palisade ${breach.id} at (${breach.xMm},${breach.zMm}).`);
    await expect.poll(()=>enemy.view!.entities.filter(entity=>entity.ownerId===enemyId&&entity.typeId==='villager').filter(entity=>Math.hypot(entity.xMm-approach.xMm,entity.zMm-approach.zMm)<6000).length,{timeout:120000}).toBe(6);
    await expect.poll(()=>enemy.view!.entities.some(entity=>entity.id===breach.id&&!entity.ghost)).toBe(true);
    // Aim at the upper wall: from this oblique camera, a low click on the far
    // segment crosses the adjacent segment's logical selection volume first.
    const remoteFocus=await focusAt(remote,enemy.view!,breach),breachPixel=screen(breach,2.6,remoteFocus,remote.viewportSize()!);const beforeAttack=enemy.commands.length;
    await remote.mouse.click(breachPixel.x,breachPixel.y,{button:'right'});
    await expect.poll(()=>enemy.commands.slice(beforeAttack).some(envelope=>envelope.command.kind==='attack_target'&&envelope.command.targetId===breach.id)).toBe(true);
    const attack=enemy.commands.slice(beforeAttack).find(envelope=>envelope.command.kind==='attack_target'&&envelope.command.targetId===breach.id)!;await expect.poll(()=>enemy.receipts.find(receipt=>receipt.clientCommandId===attack.clientCommandId)?.status).toBe('accepted');
    await focusAt(host,state.view!,breach);await expect.poll(()=>state.view!.entities.find(entity=>entity.id===breach.id)?.hp??0,{timeout:180000}).toBeLessThan(breach.maxHp/2);await evidence('wall-damaged');
    await expect.poll(()=>state.view!.entities.some(entity=>entity.id===breach.id),{timeout:180000,intervals:[50,100,250]}).toBe(false);await evidence('wall-breach');
    expect(state.view!.entities.find(entity=>entity.id===gate.id)?.gateOpen).toBe(false);expect(enemy.view!.entities.some(entity=>entity.id===breach.id&&!entity.ghost)).toBe(false);
    const remembered=enemy.view!.entities.filter(entity=>entity.ownerId===playerId&&entity.kind==='building'&&!entity.ghost&&entity.id!==breach.id).sort((a,b)=>Math.hypot(a.xMm-breach.xMm,a.zMm-breach.zMm)-Math.hypot(b.xMm-breach.xMm,b.zMm-breach.zMm))[0];
    expect(remembered,'The attacking faction must actually observe a surviving wall before remembering it').toBeDefined();
    const memoryFocus=await focusAt(remote,enemy.view!,remembered!);await evidence('visible-wall-before-retreat',remote);
    // Clear the attacking bodies using another ordinary command before testing the gap.
    await minimapOrder(remote,enemy.view!,{xMm:foreignBase.xMm,zMm:foreignBase.zMm+12000});
    await expect.poll(()=>enemy.view!.entities.filter(entity=>entity.ownerId===enemyId&&entity.typeId==='villager').every(entity=>Math.hypot(entity.xMm-breach.xMm,entity.zMm-breach.zMm)>7000),{timeout:30000}).toBe(true);
    await expect.poll(()=>enemy.view!.entities.find(entity=>entity.id===remembered!.id)?.ghost,{timeout:45000}).toBe(true);
    const memory=enemy.view!.entities.find(entity=>entity.id===remembered!.id)!;expect(memory.visualAge).toBe(remembered!.visualAge);expect(memory.lastSeenTick).toBeDefined();
    const memoryPixel=screen(memory,2.6,memoryFocus,remote.viewportSize()!);await remote.mouse.click(memoryPixel.x,memoryPixel.y);await expect(remote.locator('.selection-stats')).toContainText('Last seen');
    await evidence('remembered-wall-in-fog',remote);
    await host.getByRole('button',{name:'Select army',exact:true}).click();await minimapOrder(host,state.view!,approach);
    // A group parks in separate formation slots around the pointer target. Require
    // both bodies outside the enclosure and settled near that real command target.
    await expect.poll(()=>survivingArmy().length===2&&survivingArmy().every(entity=>!inside(entity)&&entity.taskState==='idle'&&Math.hypot(entity.xMm-approach.xMm,entity.zMm-approach.zMm)<4500),{timeout:45000}).toBe(true);
    expect(state.view!.entities.find(entity=>entity.id===gate.id)?.gateOpen).toBe(false);await evidence('breach-passage');
    // A genuine camera gesture proves depth; Home restores the normal camera before
    // any subsequent projected pointer command.
    const beforeRotation = await renderedWorldSample(host);
    await host.mouse.move(600,300);await host.mouse.down({button:'middle'});await host.mouse.move(920,390,{steps:16});await host.mouse.up({button:'middle'});
    await expect.poll(async()=>changedWorldPixels(beforeRotation,await renderedWorldSample(host)),{timeout:5000}).toBeGreaterThan(.05);
    await evidence('rotated-depth');await host.keyboard.press('Home');
    console.log('M7 final art: enemy melee damage destroyed a completed wall; army crossed the breach while the gate stayed locked.');
    await host.getByRole('button', { name: 'Select army', exact: true }).click(); await host.getByRole('button', { name: 'Patrol route', exact: true }).click(); await minimapOrder(host, state.view!, { xMm: base.xMm + 2000, zMm: base.zMm + 14000 }); await minimapOrder(host, state.view!, { xMm: base.xMm + 6000, zMm: base.zMm + 16000 });
    await expect.poll(() => state.commands.some((command) => command.command.kind === 'patrol')).toBe(true);
    await host.getByRole('button', { name: 'End as draw', exact: true }).click(); await host.getByRole('button', { name: 'Confirm draw', exact: true }).click(); await expect(host.getByTestId('match-results')).toContainText('Draw'); await expect(remote.getByTestId('match-results')).toContainText('Draw');
    await expect(host.getByTestId('match-results')).toContainText('Final faction statistics'); await expect(host.getByTestId('match-results')).toContainText('Aster'); await expect(host.getByTestId('match-results')).toContainText('Birch'); await host.screenshot({ path: 'runtime-data/e2e/m3-results.png' });
    expect(state.errors).toEqual([]); expect(enemy.errors).toEqual([]); expect(state.protocolErrors).toEqual([]); expect(enemy.protocolErrors).toEqual([]);
    await writeFile('runtime-data/e2e/m7-military-final-authorized.json', JSON.stringify({ scenarioSeed, host: state, remote: enemy }, null, 2));
    console.log('M3 browser: full wall/gate command path, garrison, Spearman combat, patrol, and confirmed host draw passed.');
  } catch (error) {
    await test.info().attach('authorized-browser-diagnostics', { body: JSON.stringify({ scenarioSeed, host: state, remote: enemy }), contentType: 'application/json' });
    // Read timing evidence only after failure, before this fixture closes its host.
    // Never capture cookies, endpoint credentials, or HTTP request headers.
    let hostDiagnostics: unknown;
    try {
      const response = await host.request.get(`${origin}/api/host/diagnostics`, { timeout: 3000, maxRetries: 0 });
      if (response.ok()) {
        const diagnostic = await response.json();
        hostDiagnostics = { httpStatus: response.status(), simulation: diagnostic.simulation, process: diagnostic.process, transport: diagnostic.transport };
      } else hostDiagnostics = { httpStatus: response.status() };
    } catch { hostDiagnostics = { error: 'HOST_DIAGNOSTICS_UNAVAILABLE' }; }
    const sanitizedServerOutput = serverOutput.split('\n').map(line => /authorization|cookie|token|credential|secret|password|api[-_ ]?key/i.test(line) ? '[redacted sensitive log line]' : line).join('\n');
    await test.info().attach('authorized-host-failure-diagnostics', { body: JSON.stringify({ hostDiagnostics, serverOutput: sanitizedServerOutput }), contentType: 'application/json' });
    throw error;
  } finally { await hostContext.close(); await remoteContext.close(); }
});
