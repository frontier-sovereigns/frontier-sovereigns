import { balance, buildings, technologies, units, type BuildingDefinition, type ModifierStat, type UnitDefinition } from './content.js';
import type { BuildingId, TechnologyId, UnitId, VisualTier } from './types.js';

export type GatherSource = 'forage' | 'farm' | 'wood' | 'gold' | 'stone';
/** Resources per second actually spent working; travel and deposit time are excluded. */
export type GatherRates = Record<GatherSource, number>;
interface Decimal { coefficient: bigint; places: number }
interface ModifierTotals { add: Decimal; fraction: Decimal }
const zero = (): Decimal => ({ coefficient: 0n, places: 0 });

// Balance decimals are accumulated exactly before the final conversion to Number.
// In particular, three Forestry upgrades yield .9425, without intermediate rounding.
function decimal(value: number): Decimal {
  const [digits, exponent = '0'] = String(value).split('e');
  const [whole, fraction = ''] = digits!.split('.');
  const places = fraction.length - Number(exponent);
  const coefficient = BigInt(whole! + fraction);
  return places < 0 ? { coefficient: coefficient * 10n ** BigInt(-places), places: 0 } : { coefficient, places };
}
function add(a: Decimal, b: Decimal): Decimal {
  const places = Math.max(a.places, b.places);
  return { coefficient: a.coefficient * 10n ** BigInt(places - a.places) + b.coefficient * 10n ** BigInt(places - b.places), places };
}
function adjusted(base: number, totals: ModifierTotals): number {
  const original = decimal(base);
  const fraction = { coefficient: original.coefficient * totals.fraction.coefficient, places: original.places + totals.fraction.places };
  const result = add(add(original, totals.add), fraction);
  const value = Number(`${result.coefficient}e-${result.places}`);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error('INVALID_EFFECTIVE_STAT');
  return value;
}
function completedIds(completed: Iterable<TechnologyId>): TechnologyId[] {
  const ids = [...new Set(completed)].sort();
  for (const id of ids) if (!Object.hasOwn(technologies, id)) throw new Error('UNKNOWN_TECHNOLOGY');
  return ids;
}
function modifiers(typeId: UnitId | BuildingId, completed: Iterable<TechnologyId>): Map<ModifierStat, ModifierTotals> {
  const result = new Map<ModifierStat, ModifierTotals>();
  for (const id of completedIds(completed)) for (const effect of technologies[id]!.effects) {
    if (!effect.targets.includes(typeId)) continue;
    const totals = result.get(effect.stat) ?? { add: zero(), fraction: zero() };
    const operation = effect.operation === 'add' ? 'add' : 'fraction';
    totals[operation] = add(totals[operation], decimal(effect.value));
    result.set(effect.stat, totals);
  }
  return result;
}
function effective<T extends UnitDefinition | BuildingDefinition>(base: T, completed: Iterable<TechnologyId>): T {
  const result = structuredClone(base);
  for (const [stat, totals] of modifiers(base.id, completed)) {
    switch (stat) {
      case 'attack': case 'maxHp': case 'rangeM': result[stat] = adjusted(base[stat], totals); break;
      case 'moveSpeedMps': case 'carryCapacity':
        if ('moveSpeedMps' in base && 'moveSpeedMps' in result) result[stat] = adjusted(base[stat] ?? 0, totals);
        break;
      case 'armor.melee': case 'armor.pierce': case 'armor.crush': {
        const type = stat.slice(6) as keyof UnitDefinition['armor'];
        result.armor[type] = adjusted(base.armor[type], totals); break;
      }
      case 'bonusDamage.cavalry': case 'bonusDamage.archer': case 'bonusDamage.building': case 'bonusDamage.siege': case 'bonusDamage.colossal':
        if ('bonusDamage' in base && 'bonusDamage' in result) {const tag=stat.slice(12);result.bonusDamage[tag] = adjusted(base.bonusDamage[tag] ?? 0, totals);}
        break;
      case 'foodCapacity': if('foodCapacity' in base&&'foodCapacity' in result)result.foodCapacity=adjusted(base.foodCapacity??0,totals);break;
      case 'constructionRate': case 'gatherRate.forage': case 'gatherRate.wood': case 'gatherRate.gold': case 'gatherRate.stone': case 'gatherRate.farm': break;
    }
  }
  result.maxHp=Math.floor(result.maxHp);result.attack=Math.floor(result.attack);
  for(const type of ['melee','pierce','crush'] as const)result.armor[type]=Math.floor(result.armor[type]);
  if('bonusDamage' in result)for(const tag of Object.keys(result.bonusDamage))result.bonusDamage[tag]=Math.floor(result.bonusDamage[tag]!);
  return result;
}

/** Only explicitly completed IDs contribute; admission owns prerequisites and ages. */
export function effectiveUnit(typeId: UnitId, completed: Iterable<TechnologyId>): UnitDefinition {
  if (!Object.hasOwn(units, typeId)) throw new Error('UNKNOWN_UNIT');
  return effective(units[typeId]!, completed);
}
export function effectiveBuilding(typeId: BuildingId, completed: Iterable<TechnologyId>): BuildingDefinition {
  if (!Object.hasOwn(buildings, typeId)) throw new Error('UNKNOWN_BUILDING');
  return effective(buildings[typeId]!, completed);
}
export function effectiveGatherRates(completed: Iterable<TechnologyId>): GatherRates {
  const result: GatherRates = { ...balance.rules.gatherPerWorkingSecond };
  for (const [stat, totals] of modifiers('villager', completed)) if (stat.startsWith('gatherRate.')) {
    const source = stat.slice(11) as GatherSource;
    result[source] = adjusted(result[source], totals);
  }
  return result;
}
export function unitVisualTier(typeId: UnitId, completed: Iterable<TechnologyId>): VisualTier {
  if (!Object.hasOwn(units, typeId)) throw new Error('UNKNOWN_UNIT');
  const ids = new Set(completedIds(completed));
  if (['militia', 'spearman', 'archer', 'knight'].includes(typeId) && ids.has(`elite_${typeId}` as TechnologyId)) return 'elite';
  if (['militia', 'spearman', 'archer'].includes(typeId) && ids.has(`veteran_${typeId}` as TechnologyId)) return 'veteran';
  return 'base';
}

/** Construction only: does not accelerate gathering, repairs or production. */
export function effectiveConstructionRate(completed:Iterable<TechnologyId>):number {const totals=modifiers('villager',completed).get('constructionRate');return totals?adjusted(1,totals):1;}
/** Evaluated at planting/reseeding; never refill an existing resource pool. */
export function effectiveFarmCapacity(completed:Iterable<TechnologyId>):number {return Math.floor(effectiveBuilding('farm',completed).foodCapacity!);}
