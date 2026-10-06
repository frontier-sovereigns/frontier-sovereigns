import { balance, buildings, type AssistantPreferences, type GameplayCommand } from '@frontier/shared';
import type { Entity, SimulationState } from './state.js';

/** Saved authority, not credentials. Pins last until the owner explicitly releases them. */
export interface AssistantControl {
  preferences: AssistantPreferences;
  protectedEntityIds: string[];
  /** -1 waits for completion; otherwise the first idle tick. Missing means pinned. */
  releaseAfterIdle: Record<string, number>;
  autoReseedProtected: boolean;
  cancelledSites: { xMm: number; zMm: number; expiresTick: number }[];
  sequence: number;
}
export const defaultAssistantPreferences = (): AssistantPreferences => ({ modelId: null, enabled: false, reserve: { food: 0, wood: 0, gold: 0, stone: 0 } });
export const createAssistantControl = (): AssistantControl => ({ preferences: defaultAssistantPreferences(), protectedEntityIds: [], releaseAfterIdle: {}, autoReseedProtected: false, cancelledSites: [], sequence: 0 });

export function advanceManualProtection(state: SimulationState): void {
  for (const [playerId, control] of Object.entries(state.control)) {
    const assistant = control.assistant;
    if (!assistant) continue;
    assistant.cancelledSites = assistant.cancelledSites.filter(site => site.expiresTick > state.tick);
    assistant.protectedEntityIds = assistant.protectedEntityIds.filter(id => {
      const entity = state.entities[id];
      if (!entity || entity.ownerId !== playerId || entity.hp <= 0) { delete assistant.releaseAfterIdle[id]; return false; }
      if (!Object.hasOwn(assistant.releaseAfterIdle, id)) return true;
      const idle = entity.kind === 'unit' ? !entity.orders.some(order => order.manualOrder) && !entity.garrisonedIn && !entity.engagement && !entity.transitionTicks : entity.kind === 'building' && entity.work >= entity.required && !entity.upgrade && !entity.queue.length && !entity.demolitionTick;
      if (!idle) assistant.releaseAfterIdle[id] = -1;
      else if (assistant.releaseAfterIdle[id] === -1) assistant.releaseAfterIdle[id] = state.tick;
      else if (state.tick - assistant.releaseAfterIdle[id]! >= 5 * balance.rules.simulationHz) { delete assistant.releaseAfterIdle[id]; return false; }
      return true;
    });
  }
}

export function commandEntities(command: GameplayCommand): string[] {
  const ids = 'unitIds' in command ? [...command.unitIds] : 'builderIds' in command ? [...command.builderIds] : [];
  for (const key of ['buildingId', 'foundationId', 'townCenterId', 'gateId', 'farmId', 'builderId', 'marketId'] as const)
    if (key in command) ids.push((command as unknown as Record<string, string>)[key]!);
  if ('wallIds' in command) ids.push(...command.wallIds);
  if ('buildingIds' in command) ids.push(...command.buildingIds);
  return ids;
}
export function assistantCommandReason(state: SimulationState, playerId: string, command: GameplayCommand): string | undefined {
  const control = state.control[playerId]!, assistant = control.assistant;
  if (!assistant?.preferences.enabled || !assistant.preferences.modelId || control.mode !== 'human') return 'ASSISTANT_DISABLED';
  if (['garrison', 'surrender', 'demolish'].includes(command.kind)) return 'MANUAL_ACTION_REQUIRED';
  if (commandEntities(command).some(id => assistant.protectedEntityIds.includes(id))) return 'MANUAL_CONTROL';
  if (command.kind === 'set_auto_reseed' && assistant.autoReseedProtected) return 'MANUAL_CONTROL';
  if (command.kind === 'build') {
    const grid = balance.rules.buildingGridM * 1000;
    if (assistant.cancelledSites.some(site => site.xMm === command.originCell.x * grid && site.zMm === command.originCell.z * grid)) return 'MANUAL_CANCELLATION';
  }
  if (command.kind === 'build_wall' && command.cells.some(cell => assistant.cancelledSites.some(site => site.xMm === cell.x * balance.rules.buildingGridM * 1000 && site.zMm === cell.z * balance.rules.buildingGridM * 1000))) return 'MANUAL_CANCELLATION';
  return undefined;
}
export function protectManualCommand(state: SimulationState, playerId: string, command: GameplayCommand, cancelled?: Entity): void {
  const assistant = state.control[playerId]?.assistant;
  if (!assistant) return;
  const ids = new Set(assistant.protectedEntityIds.filter(id => state.entities[id]?.ownerId === playerId));
  const persistent = ['gather', 'patrol', 'stop', 'hold_position', 'set_stance', 'garrison', 'reseed_farm', 'set_rally', 'set_gate_mode', 'cancel_job', 'demolish'].includes(command.kind);
  for (const id of commandEntities(command)) if (state.entities[id]?.ownerId === playerId) {
    if (persistent) delete assistant.releaseAfterIdle[id];
    else if (!('queued' in command && command.queued && ids.has(id) && !Object.hasOwn(assistant.releaseAfterIdle, id))) assistant.releaseAfterIdle[id] = -1;
    ids.add(id);
  }
  // Construction creates foundations during admission; protect those paid commitments too.
  if (['build', 'build_wall', 'replace_wall_with_gate'].includes(command.kind)) for (const id of commandEntities(command)) {
    const unit = state.entities[id];
    if (unit?.kind === 'unit') for (const order of unit.orders) {
      if (order.kind !== 'build') continue;
      for (const target of [order.targetId, ...(order.wallTargets ?? [])]) if (target && state.entities[target]?.ownerId === playerId) { ids.add(target); assistant.releaseAfterIdle[target] = -1; }
    }
  }
  assistant.protectedEntityIds = [...ids];
  for (const id of Object.keys(assistant.releaseAfterIdle)) if (!ids.has(id)) delete assistant.releaseAfterIdle[id];
  if (command.kind === 'set_auto_reseed') assistant.autoReseedProtected = true;
  if (cancelled?.kind === 'building') {
    const definition = buildings[cancelled.typeId];
    let [width, height] = definition.footprintCells;
    if (cancelled.rotation === 90 || cancelled.rotation === 270) [width, height] = [height, width];
    const site = { xMm: cancelled.xMm - width * balance.rules.buildingGridM * 500, zMm: cancelled.zMm - height * balance.rules.buildingGridM * 500, expiresTick: state.tick + balance.ai.goalTtlSeconds * balance.rules.simulationHz };
    if (!assistant.cancelledSites.some(prior => prior.xMm === site.xMm && prior.zMm === site.zMm)) assistant.cancelledSites = [...assistant.cancelledSites, site].slice(-2640);
  }
}
