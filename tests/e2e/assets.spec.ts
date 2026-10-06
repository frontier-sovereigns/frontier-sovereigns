import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// This profile intentionally uses the browser's real default backend. Capability and
// network fixtures retain the suite's explicit software-WebGL configuration.
test.use({launchOptions:{args:[]},viewport:{width:1920,height:1080}});

test('M7 production gallery loads original geometry, every unit action, eight ages and render fixtures',async({page,request})=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const manifest=await (await request.get('/asset-manifest.json')).json();expect(manifest.schemaVersion).toBe(2);expect(manifest.status).toBe('GENERATED_ORIGINAL_ASSETS');
  const response=await request.get(manifest.bundle.path),bytes=await response.body();expect(bytes.length).toBe(manifest.bundle.bytes);expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.bundle.sha256);
  const bundle=JSON.parse(bytes.toString('utf8')) as {assets:Record<string,{id:string;kind:string;clips:{id:string}[]}>};expect(Object.keys(bundle.assets)).toHaveLength(80);
  await mkdir('runtime-data/e2e',{recursive:true});await page.goto('/asset-gallery');await expect(page.getByLabel('Asset',{exact:true})).toBeVisible();
  const reports:{scene:string;metrics:string;profile:unknown}[]=[];
  const record=async(scene:string)=>{await page.waitForTimeout(1100);reports.push({scene,metrics:await page.getByTestId('asset-metrics').innerText(),profile:JSON.parse((await page.getByTestId('asset-metrics').getAttribute('data-profile'))!)});await page.screenshot({path:`runtime-data/e2e/m7-production-${scene}.png`});};
  let actions=0;
  for(const asset of Object.values(bundle.assets).filter(asset=>asset.kind==='unit')){
    await page.getByLabel('Asset',{exact:true}).selectOption(asset.id);
    for(const clip of asset.clips){await page.getByLabel('Animation',{exact:true}).selectOption(clip.id);await page.waitForTimeout(90);actions++;}
  }
  expect(actions).toBeGreaterThanOrEqual(112);
  await page.getByLabel('Inspection scene').selectOption('units');await record('unit-families');
  await page.getByLabel('Inspection scene').selectOption('settlement');for(const age of ['1','2','3','4','5','6','7','8']){await page.getByLabel('Observed age').selectOption(age);await record(`settlement-age${age}`);}
  await page.getByLabel('Asset',{exact:true}).selectOption('wooden_gate');await page.getByLabel('Observed age').selectOption('1');await record('gate-closed');await page.getByLabel('Open gate',{exact:true}).check();await record('gate-open');
  await page.getByLabel('Asset',{exact:true}).selectOption('town_center');await page.getByLabel('Structure state').selectOption('construction');await record('construction');await page.getByLabel('Structure state').selectOption('damaged');await record('damaged');await page.getByLabel('Structure state').selectOption('complete');
  await page.getByLabel('Inspection scene').selectOption('environment');await record('environment');
  await page.getByLabel('Observed age').selectOption('4');await page.getByLabel('Upgrade tier').selectOption('elite');
  for(const size of [250,500]){await page.getByLabel('Detail level').selectOption('1');await page.getByLabel('Graphics quality').selectOption('medium');await page.getByLabel('Inspection scene').selectOption(`army${size}`);await expect(page.getByTestId('asset-metrics')).toContainText(`${size===250?300:500} assets`);await page.waitForTimeout(3000);await page.getByRole('button',{name:'Reset frame sample'}).click();await page.waitForTimeout(15000);await record(`army${size}-lod1`);}
  await page.getByLabel('Detail level').selectOption('2');await page.getByLabel('Graphics quality').selectOption('low');await page.waitForTimeout(3000);await page.getByRole('button',{name:'Reset frame sample'}).click();await page.waitForTimeout(15000);await record('army500-lod2');
  const graphics=await page.locator('canvas').evaluate(canvas=>{const gl=(canvas as HTMLCanvasElement).getContext('webgl2')!,debug=gl.getExtension('WEBGL_debug_renderer_info');return{viewport:{width:innerWidth,height:innerHeight},canvasCss:{width:canvas.clientWidth,height:canvas.clientHeight},drawingBuffer:{width:gl.drawingBufferWidth,height:gl.drawingBufferHeight},version:gl.getParameter(gl.VERSION),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
  await writeFile('runtime-data/e2e/m7-production-gallery-metrics.json',JSON.stringify({scope:'Isolated original-asset rendering; no simulation or model. Default Chrome backend, 3s warmup then 15s sample per battle profile; statistics describe last up to 600 frames. Medium LOD1 and Low LOD2 have no shadowcasters, matching World policy at these LODs. This is not a full multiplayer load qualification.',graphics,actions,errors,reports},null,2));
  expect(errors).toEqual([]);expect(await page.getByRole('alert').count()).toBe(0);
});

test('M7 corrupted asset response blocks graphics readiness and offers no placeholder model',async({page})=>{
  await page.route('**/asset-manifest.json',async route=>{const response=await route.fetch(),manifest=await response.json();manifest.bundle.sha256='0'.repeat(64);await route.fulfill({response,json:manifest});});
  await page.goto('/asset-gallery');await expect(page.getByRole('alert')).toContainText('integrity check failed');
  await expect(page.getByLabel('Asset',{exact:true})).toHaveCount(0);
  await page.goto('/');await expect(page.getByRole('alert')).toContainText('integrity check failed');await expect(page.getByRole('button',{name:/Retry graphics/})).toBeVisible();
});

test('M7 full-canvas profiles and labeled action boards use actual generated joint poses',async({page,request})=>{
  test.setTimeout(180000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const manifest=await(await request.get('/asset-manifest.json')).json(),bundle=await(await request.get(manifest.bundle.path)).json() as {assets:Record<string,{id:string;kind:string;clips:{id:string}[]}>};
  await mkdir('runtime-data/e2e',{recursive:true});await page.goto('/asset-gallery');await expect(page.getByLabel('Asset',{exact:true})).toBeVisible();
  await page.getByLabel('Observed age').selectOption('4');await page.getByLabel('Upgrade tier').selectOption('elite');await page.getByLabel('Inspection scene').selectOption('actions');
  let reviewedActions=0;
  for(const asset of Object.values(bundle.assets).filter(asset=>asset.kind==='unit')){
    await page.getByLabel('Asset',{exact:true}).selectOption(asset.id);await expect(page.locator('.asset-gallery-pose-labels span')).toHaveCount(asset.clips.length*4);
    for(const clip of asset.clips)await expect(page.locator('.asset-gallery-pose-labels').getByText(`${clip.id.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase())} · 0%`,{exact:true})).toBeVisible();
    await page.waitForTimeout(1200);await page.screenshot({path:`runtime-data/e2e/m7-actions-${asset.id}.png`});reviewedActions+=asset.clips.length;
  }
  expect(reviewedActions).toBeGreaterThanOrEqual(112);
  for(const asset of ['gold_deposit','stone_quarry']){await page.getByLabel('Asset',{exact:true}).selectOption(asset);await page.waitForTimeout(1200);await page.screenshot({path:`runtime-data/e2e/m7-closeup-${asset}.png`});}
  const reports:unknown[]=[];
  for(const entry of [{size:250,quality:'high',lod:'1',width:1920,height:1080},{size:250,quality:'medium',lod:'1',width:1632,height:918},{size:500,quality:'medium',lod:'1',width:1632,height:918},{size:500,quality:'low',lod:'2',width:1248,height:702}]){
    await page.getByLabel('Graphics quality').selectOption(entry.quality);await page.getByLabel('Detail level').selectOption(entry.lod);await page.getByLabel('Inspection scene').selectOption(`army${entry.size}`);
    await page.getByRole('button',{name:'Use full canvas',exact:true}).click();
    await expect.poll(()=>page.locator('canvas').evaluate(canvas=>({css:{width:canvas.clientWidth,height:canvas.clientHeight},buffer:{width:(canvas as HTMLCanvasElement).width,height:(canvas as HTMLCanvasElement).height}}))).toEqual({css:{width:1920,height:1080},buffer:{width:entry.width,height:entry.height}});
    await page.waitForTimeout(3000);await page.getByRole('button',{name:'Reset frame sample',exact:true}).click();await page.waitForTimeout(16000);
    const graphics=await page.locator('canvas').evaluate(canvas=>{const gl=(canvas as HTMLCanvasElement).getContext('webgl2')!,debug=gl.getExtension('WEBGL_debug_renderer_info');return{version:gl.getParameter(gl.VERSION),renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};});
    const profile=JSON.parse((await page.getByTestId('asset-metrics').getAttribute('data-profile'))!);reports.push({entry,graphics,profile});
    expect(profile.drawnUnits).toBe(entry.size);expect(profile.drawnStructures).toBe(entry.size===250?50:0);expect(profile.frames).toBeGreaterThan(0);
    await page.screenshot({path:`runtime-data/e2e/m7-full-canvas-${entry.size}-${entry.quality}-lod${entry.lod}.png`});await page.getByRole('button',{name:'Show inspection controls',exact:true}).click();
  }
  await writeFile('runtime-data/e2e/m7-full-canvas-metrics.json',JSON.stringify({scope:'Isolated original-asset rendering, default Chrome GPU, full 1920x1080 CSS canvas. High renders 1920x1080, Medium 1632x918, Low 1248x702. Selected LOD1/2 has no shadowcasters, matching World policy at those LODs. Three seconds warmup then sixteen seconds; metrics contain the last up to 600 frames. This does not qualify full multiplayer or model performance.',reviewedActions,errors,reports},null,2));
  expect(errors).toEqual([]);
});
