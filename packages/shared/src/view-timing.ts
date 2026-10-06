import rawBalance from '../../../data/balance.v1.json' with { type: 'json' };
import type { MotionTrace, PlayerView, PlayerViewDelta, ViewEntity, VisualAction } from './types.js';

type TimedView = PlayerView | PlayerViewDelta;
const quantumMs = 1000 / rawBalance.rules.simulationHz;

/** Runs only after strict JSON/schema admission, identically in the compiler and
 * shipped validators. Traces describe this committed interval, never a route. */
export function validViewTiming(view: TimedView): boolean {
  const hasTiming = view.committedTimeMs !== undefined || view.frameRevision !== undefined || view.authoritativeIntervalMs !== undefined;
  const completeTiming = view.committedTimeMs !== undefined && view.frameRevision !== undefined && view.authoritativeIntervalMs !== undefined;
  if ((hasTiming || (view.publicationIntervalMs ?? 0) >= 300) && !completeTiming) return false;
  if (completeTiming && (!Number.isSafeInteger(view.tick * quantumMs) || view.committedTimeMs !== view.tick * quantumMs)) return false;
  if ((view.authoritativeIntervalMs ?? 0) >= 300 && view.publicationIntervalMs !== view.authoritativeIntervalMs) return false;
  const validTrace = (trace: MotionTrace, endpoint: { xMm: number; zMm: number; yMm?: number }, projectile: boolean): boolean => {
    if (!completeTiming || trace.points.length < 1 || trace.points.length > 16) return false;
    const last = trace.points.at(-1)!;
    if (last.tick !== view.tick || last.xMm !== endpoint.xMm || last.zMm !== endpoint.zMm || projectile && last.yMm !== endpoint.yMm) return false;
    const earliest = Math.max(0, view.tick - view.authoritativeIntervalMs! / quantumMs);
    return trace.points.every((point, index) => point.tick >= earliest && point.tick <= view.tick
      && (index === 0 || point.tick > trace.points[index - 1]!.tick)
      && point.xMm <= view.map.widthMm && point.zMm <= view.map.heightMm
      && (projectile ? point.yMm !== undefined : point.yMm === undefined));
  };
  const sameAction = (a: VisualAction | undefined, b: VisualAction | undefined): boolean => a === undefined ? b === undefined : b !== undefined
    && a.kind === b.kind && a.startedTick === b.startedTick && a.durationTicks === b.durationTicks && a.facingMilliRad === b.facingMilliRad;
  const validEntity = (entity: ViewEntity): boolean => {
    if (entity.motionTrace !== undefined && !(entity.kind === 'unit' && !entity.ghost && entity.garrisonedIn === undefined && validTrace(entity.motionTrace, entity, false))) return false;
    const trace = entity.visualTrace;
    if (!trace) return true;
    if (!completeTiming || view.authoritativeIntervalMs! < 300 || entity.kind === 'resource' || entity.ghost || entity.garrisonedIn !== undefined
      || trace.points.length < 1 || trace.points.length > 13 || trace.fromTick > view.tick || trace.fromTick < Math.max(0, view.tick - view.authoritativeIntervalMs! / quantumMs)) return false;
    const last = trace.points.at(-1)!;
    if (last.tick !== view.tick || !sameAction(last.visualAction, entity.visualAction) || last.gateOpen !== entity.gateOpen
      || trace.complete && trace.points[0]!.tick !== trace.fromTick) return false;
    const gate = entity.kind === 'building' && ['wooden_gate','stone_gate','bastion_gate','runestone_gate','titan_gate','eternal_gate'].includes(entity.typeId);
    return trace.points.every((point, index) => point.tick >= trace.fromTick && point.tick <= view.tick
      && (index === 0 || point.tick > trace.points[index - 1]!.tick)
      && (point.visualAction === undefined || point.visualAction.startedTick <= point.tick)
      && (point.gateOpen === undefined ? entity.gateOpen === undefined : gate && entity.gateOpen !== undefined));
  };
  if ('entities' in view) {
    if (!view.entities.every(validEntity)) return false;
  } else if (!view.creates.every(validEntity) || !view.updates.every(validEntity)) return false;
  return (view.projectiles ?? []).every(projectile => projectile.motionTrace === undefined || validTrace(projectile.motionTrace, projectile, true));
}
