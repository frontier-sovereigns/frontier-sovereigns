import type { Page } from '@playwright/test';
import type { ChatStateResponse, ClientCommandEnvelope, CommandReceipt, PlayerView } from '@frontier/shared';
// Import transport directly; its resolved content contract uses explicit JSON
// import attributes for the Node loader as well as the bundled browser.
import { SnapshotAssembler, DeltaAssembler, applyViewDelta, validateConsistentPlayerView } from '../../packages/shared/src/view-stream';
import { validateServerSocketMessage } from '../../packages/shared/src/validation';

/** Read displayed canvas pixels only; no camera handle or simulation state is exposed. */
export async function renderedWorldSample(page: Page): Promise<number[]> {
  return page.getByTestId('world-canvas').evaluate(async canvas => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const sample = document.createElement('canvas'); sample.width = 128; sample.height = 96;
    const context = sample.getContext('2d')!; context.drawImage(canvas as HTMLCanvasElement, 0, 0, sample.width, sample.height);
    return Array.from(context.getImageData(0, 0, sample.width, sample.height).data);
  });
}

export function changedWorldPixels(before: number[], after: number[]): number {
  let changed = 0;
  for (let index = 0; index < before.length; index += 4) if (Math.abs(before[index]! - after[index]!) + Math.abs(before[index + 1]! - after[index + 1]!) + Math.abs(before[index + 2]! - after[index + 2]!) > 45) changed++;
  return changed / (before.length / 4);
}

export function capture(page: Page, routed = false) {
  const state: { view?: PlayerView; communication?: ChatStateResponse; commands: ClientCommandEnvelope[]; receipts: CommandReceipt[]; errors: string[]; protocolErrors: string[]; chunks: number; deltas: number; fullViews: number; resyncs: number } = { commands: [], receipts: [], errors: [], protocolErrors: [], chunks: 0, deltas: 0, fullViews: 0, resyncs: 0 };
  page.on('pageerror', (error) => state.errors.push(error.message));
  const openStream = () => {
    const assembler = new SnapshotAssembler(), deltaAssembler = new DeltaAssembler(); let base: PlayerView | undefined;
    const received = (payload: string | Buffer) => {
      let message: unknown; try { message = JSON.parse(payload.toString()); } catch { state.protocolErrors.push('INVALID_JSON'); return; }
      if (!validateServerSocketMessage(message)) { state.protocolErrors.push('INVALID_MESSAGE'); return; }
      if (message.type === 'snapshot_chunk') {
        deltaAssembler.reset();
        state.chunks++; const result = assembler.push(message, performance.now());
        if (result.status === 'rejected') { state.protocolErrors.push(result.code); base = undefined; }
        if (result.status === 'complete') { base = result.view; state.view = base; state.fullViews++; }
      } else if (message.type === 'delta_chunk') {
        state.chunks++; const result = deltaAssembler.push(message, performance.now());
        if (result.status === 'rejected') { state.protocolErrors.push(result.code); base = undefined; }
        if (result.status === 'complete') {
          state.deltas++; if (!base) return;
          const next = applyViewDelta(base, result.delta);
          if (!next) { state.protocolErrors.push('DELTA_GAP'); base = undefined; }
          else { base = next; state.view = next; }
        }
      } else if (message.type === 'delta') {
        state.deltas++; if (!base) return;
        const next = applyViewDelta(base, message.delta);
        if (!next) { state.protocolErrors.push('DELTA_GAP'); base = undefined; }
        else { base = next; state.view = next; }
      } else if (message.type === 'snapshot') {
        assembler.reset(); deltaAssembler.reset();
        if (!validateConsistentPlayerView(message.view)) { state.protocolErrors.push('INVALID_SNAPSHOT'); return; }
        base = message.view; state.view = base; state.fullViews++;
      } else if (message.type === 'communication') state.communication = message.state;
      else if (message.type === 'receipt') state.receipts.push(message.receipt);
      else if (message.type === 'lobby' && ['SETUP', 'LOBBY', 'ARCHIVED'].includes(message.lobby.status)) { base = undefined; assembler.reset(); deltaAssembler.reset(); }
    };
    const sent = (payload: string | Buffer) => { const message = JSON.parse(payload.toString()); if (message.command) state.commands.push(message); if (message.type === 'resync') state.resyncs++; };
    return { received, sent, close: () => { assembler.reset(); deltaAssembler.reset(); } };
  };
  if (!routed) page.on('websocket', (socket) => { const stream = openStream(); socket.on('close', stream.close); socket.on('framereceived', ({ payload }) => stream.received(payload)); socket.on('framesent', ({ payload }) => stream.sent(payload)); });
  return Object.assign(state, { openStream });
}
