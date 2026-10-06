import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { changedWorldPixels, renderedWorldSample } from './capture';

test('middle-drag rotates actual production geometry and Home restores the view', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();
  await page.keyboard.press('Home'); const before = await renderedWorldSample(page);
  await mkdir('runtime-data/qualification', { recursive: true });
  await page.screenshot({ path: 'runtime-data/qualification/m7-camera-before.png' });
  await page.mouse.move(650, 250); await page.mouse.down({ button: 'middle' }); await page.mouse.move(970, 340, { steps: 16 }); await page.mouse.up({ button: 'middle' });
  let changed = 0;
  await expect.poll(async () => changed = changedWorldPixels(before, await renderedWorldSample(page)), { timeout: 5000 }).toBeGreaterThan(.05);
  await page.screenshot({ path: 'runtime-data/qualification/m7-camera-rotated.png' });
  await page.keyboard.press('Home'); let restored = 1;
  await expect.poll(async () => restored = changedWorldPixels(before, await renderedWorldSample(page)), { timeout: 5000 }).toBeLessThan(.01);
  await page.screenshot({ path: 'runtime-data/qualification/m7-camera-restored.png' });
  await writeFile('runtime-data/qualification/m7-camera-check.json', JSON.stringify({ changedPixelFraction: changed, restoredPixelFraction: restored, scope: 'Actual production lobby3D geometry; real middle-pointer drag and Home key; no state mutation or exposed camera handle', errors }, null, 2));
  expect(errors).toEqual([]);
});

test('camera stops held-key panning on blur without keyup and when settings take focus', async ({ page }) => {
  await page.goto('/'); await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();
  await page.keyboard.press('Home'); const before = await renderedWorldSample(page);
  await page.keyboard.down('w');
  try {
    await expect.poll(async () => changedWorldPixels(before, await renderedWorldSample(page))).toBeGreaterThan(.02);
    // An OS/window focus loss can omit keyup. Exercise the actual production
    // blur listener while leaving the key held in Playwright's keyboard state.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const blurred = await renderedWorldSample(page); await page.waitForTimeout(250);
    expect(changedWorldPixels(blurred, await renderedWorldSample(page))).toBeLessThan(.01);
  } finally { await page.keyboard.up('w'); }
  await page.keyboard.press('Home'); const restored = await renderedWorldSample(page);
  await page.keyboard.down('w');
  try {
    await expect.poll(async () => changedWorldPixels(restored, await renderedWorldSample(page))).toBeGreaterThan(.02);
    await page.getByRole('button', { name: 'Settings & controls', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Close settings', exact: true })).toBeFocused();
    const dialog = await renderedWorldSample(page); await page.waitForTimeout(250);
    expect(changedWorldPixels(dialog, await renderedWorldSample(page))).toBeLessThan(.01);
    await page.keyboard.press('Escape'); await expect(page.getByRole('button', { name: 'Settings & controls', exact: true })).toBeFocused();
    const closed = await renderedWorldSample(page); await page.waitForTimeout(250);
    expect(changedWorldPixels(closed, await renderedWorldSample(page))).toBeLessThan(.01);
  } finally { await page.keyboard.up('w'); }
  await page.getByRole('button', { name: 'Settings & controls', exact: true }).click();
  await page.getByRole('button', { name: 'Rebind Stop', exact: true }).click(); await page.keyboard.press('ArrowUp');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  const beforeArrow = await renderedWorldSample(page); await page.keyboard.down('ArrowUp');
  try { await page.waitForTimeout(250); expect(changedWorldPixels(beforeArrow, await renderedWorldSample(page))).toBeLessThan(.01); }
  finally { await page.keyboard.up('ArrowUp'); }
});

test('production renders actual WebGL2 without WebGPU and without browser script errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { get: () => undefined, configurable: true }); });
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).not.toContain('unsafe-eval');
  await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();
  expect(await page.getByTestId('world-canvas').evaluate(canvas => !!(canvas as HTMLCanvasElement).getContext('webgl2'))).toBe(true);
  const profile={channel:process.env.BROWSER_CHANNEL??'chrome',version:page.context().browser()?.version(),graphics:await page.getByTestId('world-canvas').evaluate(canvas=>{const gl=(canvas as HTMLCanvasElement).getContext('webgl2')!,debug=gl.getExtension('WEBGL_debug_renderer_info');return{renderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),webgpu:!!Reflect.get(navigator,'gpu')};})};
  await mkdir('runtime-data/e2e',{recursive:true});await writeFile(`runtime-data/e2e/browser-capabilities-${profile.channel}.json`,JSON.stringify(profile,null,2));
  await testInfo.attach('browser-capability-profile',{body:JSON.stringify(profile),contentType:'application/json'});
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('production-webgl2.png') });
  await page.screenshot({path:`runtime-data/e2e/browser-capabilities-${profile.channel}.png`});
});

test('missing WebGL2 produces a compatibility explanation', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...args: unknown[]) {
      if (kind === 'webgl2') return null;
      return original.apply(this, [kind, ...args] as any);
    } as typeof original;
  });
  await page.goto('/');
  await expect(page.getByRole('alert').filter({ hasText: 'WebGL2' })).toBeVisible();
});

test('graphics loss displays recovery while the dedicated host stays healthy', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('WEBGL2', { exact: true })).toBeVisible();
  await page.getByTestId('world-canvas').evaluate(canvas => {
    const extension = (canvas as HTMLCanvasElement).getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
    (window as any).__restoreGraphics = () => extension.restoreContext();
    extension.loseContext();
  });
  await expect(page.getByRole('alert').filter({ hasText: /graphics|context/i })).toBeVisible();
  expect((await (await page.request.get('/api/health')).json()).ready).toBe(true);
  await page.evaluate(() => (window as any).__restoreGraphics());
  await expect(page.getByRole('alert').filter({ hasText: /graphics|context/i })).toHaveCount(0);
});
