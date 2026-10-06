import { balance, buildings, units, technologies, resolveRuleset, isContentAllowed, effectiveUnit, effectiveBuilding, effectiveGatherRates, effectiveConstructionRate, effectiveFarmCapacity, unitVisualTier, type BuildingId, type UnitId, type TechnologyId, type UnitDefinition, type BuildingDefinition } from '@frontier/shared';
import type { Building, SimulationState } from './state.js';

export function agePrerequisiteReason(state:SimulationState,playerId:string,targetAge:number):string|undefined {
  const age=resolveRuleset(state.rulesetId,state.maxAge).ages.find(entry=>entry.id===targetAge),economy=state.economies[playerId]!;
  if(!age||age.requiredAge!==economy.age)return 'INVALID_AGE';
  const completed=new Set(Object.values(state.entities).filter((entity):entity is Building=>entity.kind==='building'&&entity.ownerId===playerId&&entity.hp>0&&entity.work>=entity.required).map(entity=>entity.typeId));
  for(const prerequisite of age.prerequisites){
    if(prerequisite.kind==='completed_buildings'&&!prerequisite.types.every(type=>[...completed].some(actual=>buildingSatisfies(actual,type))))return 'PREREQUISITES_REQUIRED';
    if(prerequisite.kind==='distinct_completed_building_types'&&prerequisite.types.filter(type=>completed.has(type)).length<prerequisite.count)return 'PREREQUISITES_REQUIRED';
  }
  return undefined;
}
export function researchPrerequisiteReason(state:SimulationState,playerId:string,technologyId:TechnologyId):string|undefined {
  const definition=technologies[technologyId],economy=state.economies[playerId]!;
  if(!isContentAllowed(technologyId,state.rulesetId,state.maxAge))return 'RULESET_CONTENT_UNAVAILABLE';
  if(economy.age<definition.minAge)return 'AGE_REQUIRED';
  if(!definition.prerequisites.every(id=>economy.technologies.includes(id)))return 'PREREQUISITES_REQUIRED';
  return undefined;
}
export function buildingSatisfies(actual:BuildingId,required:BuildingId):boolean {const a=buildings[actual],b=buildings[required];return actual===required||Boolean(a.family&&a.family===b.family&&(a.tier??0)>=(b.tier??0));}
export function contentPrerequisiteReason(state:SimulationState,playerId:string,typeId:BuildingId|UnitId):string|undefined {
  if(!isContentAllowed(typeId,state.rulesetId,state.maxAge))return 'RULESET_CONTENT_UNAVAILABLE';
  const definition=Object.hasOwn(buildings,typeId)?buildings[typeId as BuildingId]:units[typeId as UnitId],economy=state.economies[playerId]!;
  if(economy.age<definition.minAge)return 'AGE_REQUIRED';
  if(typeId==='monument'&&state.rulesetId==='legendary_ages_v1'&&economy.age<(state.maxAge??8))return 'AGE_REQUIRED';
  if(definition.requiredTechnologies?.some(id=>!economy.technologies.includes(id)))return 'PREREQUISITES_REQUIRED';
  if(definition.requiredBuildings?.some(required=>!Object.values(state.entities).some(e=>e.kind==='building'&&e.ownerId===playerId&&e.hp>0&&e.work>=e.required&&buildingSatisfies(e.typeId,required))))return 'PREREQUISITES_REQUIRED';
}
const gcd=(a:number,b:number):number=>{while(b){const remainder=a%b;a=b;b=remainder;}return a;};
/** Repair carries an exact fractional milli-resource debt across durability upgrades. */
export function rescaleRepairDenominator(building:Building,newMaxHp:number):void {
  const old=building.repairDenominator??building.maxHp,next=old/gcd(old,newMaxHp)*newMaxHp;
  if(!Number.isSafeInteger(next))throw new Error('REPAIR_PRECISION_INVARIANT');
  if(next!==old)for(const bank of Object.values(building.repairRemainders??{}))for(const resource of balance.resourceOrder)bank[resource]*=next/old;
  building.repairDenominator=next;
}
interface CachedModifiers {revision:number;units:Map<UnitId,UnitDefinition>;buildings:Map<BuildingId,BuildingDefinition>;rates:ReturnType<typeof effectiveGatherRates>;construction:number;farmCapacity:number;tiers:Map<UnitId,ReturnType<typeof unitVisualTier>>}
/** Derived immutable definitions are cached by an authoritative research revision. */
export class Progression {
  private caches=new Map<string,CachedModifiers>();
  constructor(private readonly state:SimulationState){}
  private cache(playerId:string):CachedModifiers {
    const economy=this.state.economies[playerId]!,prior=this.caches.get(playerId);if(prior?.revision===economy.researchRevision)return prior;
    const next={revision:economy.researchRevision,units:new Map<UnitId,UnitDefinition>(),buildings:new Map<BuildingId,BuildingDefinition>(),rates:effectiveGatherRates(economy.technologies),construction:effectiveConstructionRate(economy.technologies),farmCapacity:effectiveFarmCapacity(economy.technologies),tiers:new Map<UnitId,ReturnType<typeof unitVisualTier>>()};this.caches.set(playerId,next);return next;
  }
  unit(playerId:string,typeId:UnitId):UnitDefinition {const cache=this.cache(playerId);let definition=cache.units.get(typeId);if(!definition){definition=effectiveUnit(typeId,this.state.economies[playerId]!.technologies);cache.units.set(typeId,definition);}return definition;}
  building(playerId:string,typeId:BuildingId):BuildingDefinition {const cache=this.cache(playerId);let definition=cache.buildings.get(typeId);if(!definition){definition=effectiveBuilding(typeId,this.state.economies[playerId]!.technologies);cache.buildings.set(typeId,definition);}return definition;}
  rates(playerId:string):ReturnType<typeof effectiveGatherRates>{return this.cache(playerId).rates;}
  construction(playerId:string):number{return this.cache(playerId).construction;}
  farmCapacity(playerId:string):number{return this.cache(playerId).farmCapacity;}
  visualTier(playerId:string,typeId:UnitId):'base'|'veteran'|'elite'{const cache=this.cache(playerId);let tier=cache.tiers.get(typeId);if(tier===undefined){tier=unitVisualTier(typeId,this.state.economies[playerId]!.technologies);cache.tiers.set(typeId,tier);}return tier;}
  completeResearch(playerId:string,technologyId:TechnologyId):void {
    const economy=this.state.economies[playerId]!;if(economy.technologies.includes(technologyId))return;
    economy.technologies.push(technologyId);economy.technologies.sort();economy.researchRevision++;
    for(const entity of Object.values(this.state.entities)){
      if(entity.kind==='resource'||entity.ownerId!==playerId||entity.hp<=0)continue;
      const nextMax=Math.round(entity.kind==='unit'?this.unit(playerId,entity.typeId).maxHp:this.building(playerId,entity.typeId).maxHp),oldMax=entity.maxHp;if(nextMax===oldMax)continue;
      if(entity.kind==='building'){
        rescaleRepairDenominator(entity,nextMax);
        if(entity.work<entity.required){const damage=entity.grantedHp-entity.hp,initial=Math.floor(nextMax*balance.rules.foundationStartingHpFraction),granted=initial+Math.floor((nextMax-initial)*entity.work/entity.required);entity.grantedHp=granted;entity.hp=granted-damage;}
        else{entity.hp=Math.min(nextMax,entity.hp+nextMax-oldMax);entity.grantedHp=nextMax;}
      }else entity.hp=Math.min(nextMax,entity.hp+nextMax-oldMax);
      entity.maxHp=nextMax;
    }
  }
}
