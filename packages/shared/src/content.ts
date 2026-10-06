import rawBalance from '../../../data/balance.v1.json' with { type: 'json' };
import rawLegendary from '../../../data/balance.legendary-ages.v1.json' with { type: 'json' };
import assetRequirements from '../../../data/asset-requirements.json' with { type: 'json' };
import commandSchema from '../../../schemas/client-command.schema.json' with { type: 'json' };
import aiSchema from '../../../schemas/ai-plan.schema.json' with { type: 'json' };
import { isSafeJson } from './validation-safety.js';
import { validateContentStructure as validateStructure, validateLegendaryExpansionStructure } from './validators.generated.js';
import { canonicalJson, sha256 } from './hash.js';
import type { BuildingId, ResourceBank, ResourceType, TechnologyId, UnitId, RulesetId, MaximumAge, WallMaterial } from './types.js';

export type DamageType = 'melee' | 'pierce' | 'crush';
export type Armor = Record<DamageType, number>;
export interface ContentRequirements { requiredTechnologies?:TechnologyId[];requiredBuildings?:BuildingId[];maxPerPlayer?:number }
export interface TurretDefinition {attack:number;attackType:DamageType;bonusDamage:Record<string,number>;rangeM:number;attackCooldownSeconds:number;projectileSpeedMps:number;projectileLaunchHeightM?:number}
export interface UnitDefinition extends ContentRequirements {
  id: UnitId; name: string; minAge: number; producedAt: BuildingId; cost: ResourceBank;
  maxHp: number; attack: number; attackType: DamageType; rangeM: number; minRangeM: number;
  moveSpeedMps: number; trainSeconds: number; population: number; visionM: number;
  armor: Armor; bonusDamage: Record<string, number>; attackCooldownSeconds: number; tags: string[];
  collisionRadiusM: number; projectileSpeedMps: number; projectileLaunchHeightM?:number; canGarrison: boolean; carryCapacity?: number;
  windupSeconds?:number;ammunitionCost?:ResourceBank;mobileGarrisonCapacity?:number;turret?:TurretDefinition;wardDepletionMultiplier?:number;
  areaDamageBands?: { radiusM: number; multiplier: number }[]; deploySeconds?: number; packSeconds?: number;
}
export interface BuildingDefinition extends ContentRequirements {
  family?:'citadel'|'wall'|'gate';tier?:number;familyCap?:number;upgradeFrom?:BuildingId;upgradeSeconds?:number;weaponPorts?:number;wardEligible?:boolean;wallMaterial?:WallMaterial;
  id: BuildingId; name: string; minAge: number; cost: ResourceBank; maxHp: number; buildSeconds: number;
  footprintCells: [number, number]; populationProvided: number; visionM: number; garrisonCapacity: number;
  dropOffResources: ResourceType[]; attack: number; attackType: DamageType | null; rangeM: number;
  attackCooldownSeconds: number; projectileSpeedMps: number; projectileLaunchHeightM?:number; armor: Armor; tags: string[];
  produces: UnitId[]; maxPerPlayerByAge?: Record<string, number>; foodCapacity?: number;
  maxActiveGatherers?: number; reseedCost?: ResourceBank; reseedSeconds?: number; wallEquivalentCells?: number;
  defaultGateMode?: 'AUTO'; gatePassageWidthM?: number; autoOpenDistanceM?: number; autoCloseDelaySeconds?: number;
}
export type ModifierStat = 'attack' | 'maxHp' | 'rangeM' | 'moveSpeedMps' | 'carryCapacity' | 'armor.melee' | 'armor.pierce' | 'armor.crush' | 'constructionRate' | 'foodCapacity' | 'gatherRate.forage' | 'bonusDamage.archer' | 'bonusDamage.building' | 'bonusDamage.siege' | 'bonusDamage.colossal' | 'bonusDamage.cavalry' | 'gatherRate.wood' | 'gatherRate.gold' | 'gatherRate.stone' | 'gatherRate.farm';
export interface TechnologyDefinition {
  id: TechnologyId; name: string; minAge: number; researchedAt: BuildingId; cost: ResourceBank;
  researchSeconds: number; prerequisites: TechnologyId[];
  effects: { targets: (UnitId | BuildingId)[]; stat: ModifierStat; operation: 'add' | 'add_base_fraction'; value: number }[];
}
export interface AgeDefinition {
  id: number; name: string; cost: ResourceBank; researchSeconds: number; requiredAge: number | null;
  prerequisites: ({ kind: 'completed_buildings'; types: BuildingId[] } | { kind: 'distinct_completed_building_types'; types: BuildingId[]; count: number })[];
}
export type BalanceData = Omit<typeof rawBalance, 'ages' | 'units' | 'buildings' | 'technologies' | 'resourceOrder'> & {
  ages: AgeDefinition[]; units: UnitDefinition[]; buildings: BuildingDefinition[]; technologies: TechnologyDefinition[]; resourceOrder: ResourceType[];
};

/** Validate both the strict data shape and dependency reachability before exposing content. */
export function validateContent(input: unknown): asserts input is BalanceData {
  const value = input as BalanceData;
  if (!isSafeJson(value) || !validateStructure(value)) throw new Error(`Invalid content structure: ${JSON.stringify(validateStructure.errors)}`);
  if(value.rules.nonTreeBuildingClearanceM>value.rules.treeBuildingClearanceM)throw new Error('Resource construction clearance exceeds observed placement halo');
  const all = [...value.units,...value.buildings,...value.technologies];
  const seen = new Set<string>();
  for (const entry of all) { if (seen.has(entry.id)) throw new Error(`Duplicate content ID: ${entry.id}`); seen.add(entry.id); }
  const unitMap = new Map(value.units.map(v=>[v.id,v]));
  const buildingMap = new Map(value.buildings.map(v=>[v.id,v]));
  const technologyMap = new Map(value.technologies.map(v=>[v.id,v]));
  for(const policy of Object.values(value.ai.personalityPolicies)) {
    if(Object.values(policy.resourceWeights).reduce((sum,n)=>sum+n,0)!==100||policy.preferredUnits.some(id=>!unitMap.has(id as UnitId))||policy.infrastructure.some(id=>!buildingMap.has(id as BuildingId)))throw new Error('Invalid AI personality policy');
  }
  const ageMap = new Map(value.ages.map(v=>[v.id,v]));
  const expanded=value.ages.length===8;
  if (![4,8].includes(ageMap.size)||ageMap.size!==value.ages.length) throw new Error('Duplicate or unsupported age ID');
  const checkSet = (actual:string[],expected:string[],label:string) => { if (actual.length!==expected.length || expected.some(id=>!actual.includes(id))) throw new Error(`Broken ${label} content references`); };
  const expectedUnits=expanded?[...rawBalance.units,...rawLegendary.units]:rawBalance.units;
  const expectedBuildings=expanded?[...rawBalance.buildings,...rawLegendary.buildings]:rawBalance.buildings;
  const expectedTechnologies=expanded?[...rawBalance.technologies,...rawLegendary.technologies]:rawBalance.technologies;
  checkSet([...unitMap.keys()],expectedUnits.map(v=>v.id),'unit');
  checkSet([...buildingMap.keys()],expectedBuildings.map(v=>v.id),'building');
  checkSet([...technologyMap.keys()],expectedTechnologies.map(v=>v.id),'technology');
  checkSet([...rawBalance.units,...rawLegendary.units].map(v=>v.id),commandSchema.$defs.train.properties.unitType.enum,'unit command');
  checkSet([...rawBalance.buildings,...rawLegendary.buildings].map(v=>v.id),assetRequirements.buildingAssets.map(v=>v.id),'building manifest');
  checkSet([...rawBalance.units,...rawLegendary.units].map(v=>v.id),assetRequirements.unitAssets.map(v=>v.id),'unit manifest');
  checkSet([...rawBalance.technologies,...rawLegendary.technologies].map(v=>v.id),commandSchema.$defs.research.properties.technologyId.enum,'technology command');
  checkSet([...rawBalance.technologies,...rawLegendary.technologies].map(v=>v.id),aiSchema.$defs.research.properties.technologyId.enum,'technology AI');
  for (const entry of value.units) {
    const producer = buildingMap.get(entry.producedAt);
    if (!producer || !producer.produces.includes(entry.id) || producer.minAge > entry.minAge) throw new Error(`Missing or unreachable producer: ${entry.id}`);
    if (entry.rangeM < entry.minRangeM || entry.attackCooldownSeconds<=0) throw new Error(`Invalid combat stats: ${entry.id}`);
  }
  for (const entry of value.buildings) {
    for (const unitId of entry.produces) if (unitMap.get(unitId)?.producedAt !== entry.id) throw new Error(`Broken production reference: ${entry.id}`);
    if (entry.attack>0 && (entry.attackType===null || entry.attackCooldownSeconds<=0)) throw new Error(`Invalid building attack: ${entry.id}`);
    if (entry.id==='farm' && (!entry.reseedCost || !entry.foodCapacity || !entry.reseedSeconds || !entry.maxActiveGatherers)) throw new Error('Farm lifecycle content missing');
    if (entry.id.endsWith('_gate')) {
      if (entry.defaultGateMode!=='AUTO'||entry.footprintCells[0]!==(entry.minAge>4?5:3)||entry.footprintCells[1]!==1||entry.wallEquivalentCells!==(entry.minAge>4?5:3)||!entry.gatePassageWidthM||entry.gatePassageWidthM>=entry.footprintCells[0]*value.rules.buildingGridM||!entry.autoOpenDistanceM||!entry.autoCloseDelaySeconds) throw new Error(`Invalid gate geometry: ${entry.id}`);
    } else if (entry.defaultGateMode||entry.gatePassageWidthM) throw new Error(`Gate properties on non-gate: ${entry.id}`);
  }
  for (const entry of value.ages) {
    if (entry.id===1 ? entry.requiredAge!==null : entry.requiredAge!==entry.id-1) throw new Error(`Invalid age dependency: ${entry.id}`);
    for (const prerequisite of entry.prerequisites) {
      for (const type of prerequisite.types) if (!buildingMap.has(type) || buildingMap.get(type)!.minAge>=entry.id) throw new Error(`Unreachable age prerequisite: ${type}`);
      if (prerequisite.kind==='distinct_completed_building_types' && prerequisite.count>prerequisite.types.length) throw new Error('Impossible age prerequisite count');
    }
  }
  const visit = (id:TechnologyId,active:Set<string>,done:Set<string>):void => {
    if(active.has(id)) throw new Error(`Cyclic technology dependency: ${id}`);
    if(done.has(id)) return;
    const technology=technologyMap.get(id); if(!technology) throw new Error(`Unknown prerequisite: ${id}`);
    active.add(id); for(const dependency of technology.prerequisites) { visit(dependency,active,done); if(technologyMap.get(dependency)!.minAge>technology.minAge) throw new Error(`Unreachable technology: ${id}`); }
    active.delete(id); done.add(id);
  };
  const done = new Set<string>();
  for (const entry of value.technologies) {
    visit(entry.id,new Set(),done);
    const producer=buildingMap.get(entry.researchedAt); if(!producer || producer.minAge>entry.minAge) throw new Error(`Missing research producer: ${entry.id}`);
    for(const effect of entry.effects) for(const target of effect.targets) {
      const targetContent=unitMap.get(target as UnitId) ?? buildingMap.get(target as BuildingId);
      if(!targetContent) throw new Error(`Unknown modifier target: ${target}`);
      if(effect.stat.startsWith('gatherRate.') && target!=='villager') throw new Error(`Unsupported gather modifier: ${target}`);
      if(effect.stat==='carryCapacity' && !('carryCapacity' in targetContent)) throw new Error(`Unsupported carry modifier: ${target}`);
      if(effect.stat==='constructionRate' && target!=='villager')throw new Error('Unsupported construction modifier');
      if(effect.stat==='foodCapacity' && target!=='farm')throw new Error('Unsupported farm modifier');
      if(effect.stat==='moveSpeedMps' && !('moveSpeedMps' in targetContent)) throw new Error(`Unsupported movement modifier: ${target}`);
      if(effect.stat.startsWith('bonusDamage.') && !('bonusDamage' in targetContent)) throw new Error(`Unsupported damage modifier: ${target}`);
    }
  }
  const graph=new Map<string,string[]>();
  for(const entry of [...value.units,...value.buildings]) {
    const dependencies:string[]=[];
    for(const required of entry.requiredTechnologies??[]) { const tech=technologyMap.get(required);if(!tech||tech.minAge>entry.minAge)throw new Error('Unreachable unlock: '+entry.id);dependencies.push('tech:'+required); }
    for(const required of entry.requiredBuildings??[]) { const building=buildingMap.get(required);if(!building||building.minAge>entry.minAge)throw new Error('Unreachable prerequisite: '+entry.id);dependencies.push('building:'+required); }
    graph.set(('producedAt' in entry?'unit:':'building:')+entry.id,dependencies);
    if('upgradeFrom' in entry&&entry.upgradeFrom){const prior=buildingMap.get(entry.upgradeFrom);if(!prior||prior.footprintCells.some((n,i)=>n!==entry.footprintCells[i])||!entry.upgradeSeconds||entry.minAge!==prior.minAge+1&&!(prior.id==='stone_wall'&&entry.id==='bastion_wall'))throw new Error('Invalid structural upgrade: '+entry.id);for(const resource of value.resourceOrder)if(entry.cost[resource]<prior.cost[resource])throw new Error('Negative structural upgrade cost: '+entry.id);}
  }
  for(const entry of value.technologies)graph.set('tech:'+entry.id,['building:'+entry.researchedAt,...entry.prerequisites.map(id=>'tech:'+id)]);
  const graphDone=new Set<string>();const graphActive=new Set<string>();
  const walk=(id:string):void=>{if(graphActive.has(id))throw new Error('Cyclic building/research dependency: '+id);if(graphDone.has(id))return;graphActive.add(id);for(const dependency of graph.get(id)??[])walk(dependency);graphActive.delete(id);graphDone.add(id);};
  for(const id of graph.keys())walk(id);
  for(const id of Object.keys(value.start.units)) if(!unitMap.has(id as UnitId) || unitMap.get(id as UnitId)!.minAge>value.start.age) throw new Error(`Invalid starting unit: ${id}`);
  for(const id of Object.keys(value.start.buildings)) if(!buildingMap.has(id as BuildingId) || buildingMap.get(id as BuildingId)!.minAge>value.start.age) throw new Error(`Invalid starting building: ${id}`);
  if(new Set(value.maps.sizes.map(size=>size.id)).size!==3) throw new Error('Duplicate map size ID');
  const nodes=value.maps.resourceNodes;
  for(const resource of value.resourceOrder)for(const counts of [nodes.starting,nodes.expansion])if(value.maps.spawnResourceMinimum[resource]<counts[resource]||value.maps.spawnResourceMinimum[resource]%counts[resource]!==0)throw new Error('Invalid per-node resource yield');
  if(nodes.forestPatchLimit%3!==0||nodes.starting.wood%nodes.forestPatchLimit!==0||nodes.expansion.wood%nodes.forestPatchLimit!==0)throw new Error('Invalid forest patch quantity');
  const expansionCounts=Array.from({length:Math.max(4,value.rules.factionLimit*2)},(_,index)=>nodes.expansion[value.resourceOrder[index%4]!]);
  if(Object.values(nodes.starting).reduce((sum,count)=>sum+count,0)*value.rules.factionLimit+expansionCounts.reduce((sum,count)=>sum+count,0)>value.rules.maxResourceNodes)throw new Error('Resource quantity exceeds node limit');
  const barriers=value.maps.naturalBarriers;
  const belts=value.maps.forestBelts;
  if(belts.minimumDepthM>belts.targetDepthM||belts.targetDepthM>belts.maximumDepthM||[belts.minimumDepthM,belts.targetDepthM,belts.maximumDepthM,belts.approachLengthM].some(depth=>depth%value.maps.forestNavigationCellM!==0))throw new Error('Invalid forest belt dimensions');
  if(barriers.valleyWidthM<barriers.minimumRouteWidthM+16||barriers.minimumStartSeparationM<2*barriers.stagingRegionM)throw new Error('Invalid natural barrier clearance');
  for(const size of value.maps.sizes)for(const cells of size.cells){const length=cells*value.rules.buildingGridM,count=belts.territoryCellsBySize[size.id as keyof typeof belts.territoryCellsBySize];if(length/count<2*barriers.valleyWidthM+belts.minimumDepthM+4*value.maps.forestNavigationCellM)throw new Error('Invalid forest territory dimensions');}
  for(const size of value.maps.sizes) if(size.factions[0]!>size.factions[1]!) throw new Error('Invalid map faction range');
  if(value.rules.replicationHz>value.rules.simulationHz || value.rules.simulationHz%value.rules.replicationHz!==0) throw new Error('Replication must divide simulation Hz');
}

function freeze<T>(value:T):T { if(value && typeof value==='object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
validateContent(rawBalance);
export const balance: BalanceData = freeze(rawBalance);
export interface LegendaryExpansion {schemaVersion:number;status:string;rulesetId:'legendary_ages_v1';ages:AgeDefinition[];units:UnitDefinition[];buildings:BuildingDefinition[];technologies:TechnologyDefinition[];wards:{radiusM:number;maxTargets:number;quietSeconds:number;byAge:Record<number,{citadel:number;gate:number;wall:number;recoveryPerSecond:number}>};longWar:typeof rawLegendary.longWar}
export function validateLegendaryExpansion(input:unknown): asserts input is LegendaryExpansion {
  if(!isSafeJson(input)||!validateLegendaryExpansionStructure(input))throw new Error('Invalid Legendary content structure');
  const expansion=input as LegendaryExpansion;
  if(expansion.ages.some((age,index)=>age.id!==index+5))throw new Error('Invalid Legendary age sequence');
  validateContent({...rawBalance,ages:[...rawBalance.ages,...expansion.ages],units:[...rawBalance.units,...expansion.units],buildings:[...rawBalance.buildings,...expansion.buildings],technologies:[...rawBalance.technologies,...expansion.technologies]});
}
validateLegendaryExpansion(rawLegendary);
export const legendaryExpansion:LegendaryExpansion=freeze(rawLegendary as unknown as LegendaryExpansion);
const fullBalance:BalanceData=freeze({...balance,ages:[...balance.ages,...legendaryExpansion.ages],units:[...balance.units,...legendaryExpansion.units],buildings:[...balance.buildings.map(entry=>entry.maxPerPlayerByAge?{...entry,maxPerPlayerByAge:{...entry.maxPerPlayerByAge,'5':entry.maxPerPlayerByAge['4']!,'6':entry.maxPerPlayerByAge['4']!,'7':entry.maxPerPlayerByAge['4']!,'8':entry.maxPerPlayerByAge['4']!}}:entry),...legendaryExpansion.buildings],technologies:[...balance.technologies,...legendaryExpansion.technologies]});
/** Lookup catalogues are a superset. Match admission must use its resolved ruleset. */
export const units = freeze(Object.fromEntries(fullBalance.units.map(entry=>[entry.id,entry]))) as Readonly<Record<string,UnitDefinition>>;
export const buildings = freeze(Object.fromEntries(fullBalance.buildings.map(entry=>[entry.id,entry]))) as Readonly<Record<string,BuildingDefinition>>;
export const technologies = freeze(Object.fromEntries(fullBalance.technologies.map(entry=>[entry.id,entry]))) as Readonly<Record<string,TechnologyDefinition>>;
export const ages = freeze(Object.fromEntries(fullBalance.ages.map(entry=>[entry.id,entry]))) as Readonly<Record<number,AgeDefinition>>;
export const classicContentHash = sha256(canonicalJson(balance));
/** Asset integrity covers the complete catalogue, independent of match age cap. */
export const assetCatalogContentHash = sha256(canonicalJson({balance,legendaryExpansion}));
/** Classic identity is retained; match-specific identities come from resolveRuleset. */
export const contentHash = classicContentHash;
export const RULESET_IDS=['classic_v1','legendary_ages_v1'] as const;
export interface ResolvedRuleset {rulesetId:RulesetId;maxAge:MaximumAge;startingResourcePreset:'standard'|'long_war';contentHash:string;ages:AgeDefinition[];units:UnitDefinition[];buildings:BuildingDefinition[];technologies:TechnologyDefinition[]}
const rulesetCache=new Map<string,ResolvedRuleset>();
export function resolveRuleset(rulesetId:RulesetId='classic_v1',maxAge?:MaximumAge,startingResourcePreset?:'standard'|'long_war'):ResolvedRuleset {
  if(!RULESET_IDS.includes(rulesetId))throw new Error('UNKNOWN_RULESET');
  const cap=maxAge??(rulesetId==='classic_v1'?4:8);
  if(!Number.isInteger(cap)||cap<4||cap>8||rulesetId==='classic_v1'&&cap!==4)throw new Error('INVALID_AGE_CAP');
  const preset=startingResourcePreset??(rulesetId==='classic_v1'?'standard':'long_war');
  if(!['standard','long_war'].includes(preset)||rulesetId==='classic_v1'&&preset!=='standard')throw new Error('INVALID_RESOURCE_PRESET');
  const key=rulesetId+':'+cap+':'+preset,cached=rulesetCache.get(key);if(cached)return cached;
  const source=rulesetId==='classic_v1'?balance:fullBalance;
  const resolved:ResolvedRuleset={rulesetId,maxAge:cap,startingResourcePreset:preset,contentHash:rulesetId==='classic_v1'?classicContentHash:sha256(canonicalJson({rulesetId,maxAge:cap,startingResourcePreset:preset,balance:fullBalance,expansion:legendaryExpansion})),ages:source.ages.filter(entry=>entry.id<=cap),units:source.units.filter(entry=>entry.minAge<=cap),buildings:source.buildings.filter(entry=>entry.minAge<=cap).map(entry=>entry.id==='monument'&&rulesetId==='legendary_ages_v1'?{...entry,minAge:cap}:entry),technologies:source.technologies.filter(entry=>entry.minAge<=cap)};
  freeze(resolved);rulesetCache.set(key,resolved);return resolved;
}
export const contentForRuleset=resolveRuleset;
export function isContentAllowed(id:string,rulesetId:RulesetId='classic_v1',maxAge?:MaximumAge):boolean {
  const resolved=resolveRuleset(rulesetId,maxAge),entry=units[id]??buildings[id]??technologies[id];
  return !!entry&&entry.minAge<=resolved.maxAge&&(rulesetId==='legendary_ages_v1'||entry.minAge<=4);
}
export function structureUpgrade(source:BuildingId,target:BuildingId):{cost:ResourceBank;seconds:number}|null {
  const from=buildings[source],to=buildings[target];if(!from||!to||to.upgradeFrom!==source||!to.upgradeSeconds)return null;
  return {cost:Object.fromEntries(balance.resourceOrder.map(resource=>[resource,to.cost[resource]-from.cost[resource]])) as ResourceBank,seconds:to.upgradeSeconds};
}
export function buildingSatisfies(actual:BuildingId,required:BuildingId):boolean {
  if(actual===required)return true;const a=buildings[actual],r=buildings[required];
  let prior=a;for(let n=0;n<8&&prior?.upgradeFrom;n++){if(prior.upgradeFrom===required)return true;prior=buildings[prior.upgradeFrom];}
  return !!a?.family&&a.family===r?.family&&(a.tier??0)>=(r.tier??0);
}
export function wallTypeForMaterial(material:WallMaterial):Extract<BuildingId,`${string}_wall`> {return material==='palisade'?'palisade_wall':(material+'_wall') as Extract<BuildingId,`${string}_wall`>;}
export function gateTypeForMaterial(material:WallMaterial):Extract<BuildingId,`${string}_gate`> {return material==='palisade'?'wooden_gate':(material+'_gate') as Extract<BuildingId,`${string}_gate`>;}
