import { buildings, resolveRuleset, units, type BuildingId, type GameplayCommand, type PlayerView, type ResourceBank, type ViewEntity } from '@frontier/shared';

/** Family substitution is policy-only; command admission repeats authoritative checks. */
export function satisfiesBuilding(actual:string,required:BuildingId):boolean {
  if(actual===required)return true;
  const a=buildings[actual],b=buildings[required];
  return !!a?.family&&a.family===b.family&&(a.tier??0)>=(b.tier??0);
}

export function developmentContent(view:PlayerView) {
  const content=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset);
  return content.buildings.filter(building=>!building.wallEquivalentCells&&!['town_center','house','farm','monument'].includes(building.id));
}

export function upgradePrice(entity:ViewEntity,targetType:BuildingId):ResourceBank {
  const old=buildings[entity.typeId].cost,next=buildings[targetType].cost;
  return {food:Math.max(0,next.food-old.food),wood:Math.max(0,next.wood-old.wood),gold:Math.max(0,next.gold-old.gold),stone:Math.max(0,next.stone-old.stone)};
}

/** A desired final citadel follows one paid, sequential upgrade at a time. */
export function nextStructureUpgrade(view:PlayerView,target:BuildingId,protectedIds?:ReadonlySet<string>):GameplayCommand|undefined {
  const wanted=buildings[target];if(!wanted.family||!wanted.upgradeFrom)return;
  const content=resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset);
  for(const entity of view.entities){
    if(entity.ownerId!==view.playerId||entity.kind!=='building'||entity.ghost||entity.progress!==1||entity.upgrade||protectedIds?.has(entity.id))continue;
    const current=buildings[entity.typeId];if(current.family!==wanted.family||(current.tier??0)>=(wanted.tier??0))continue;
    const next=content.buildings.find(candidate=>candidate.upgradeFrom===current.id&&candidate.minAge<=view.self.age);
    if(next)return {kind:'upgrade_structure',buildingIds:[entity.id],targetTypeId:next.id};
  }
}

/** No secret enemies or route oracle: choose counters from the recipient view. */
export function legendaryArmyChoice(view:PlayerView,own:readonly ViewEntity[],enemies:readonly ViewEntity[]):keyof typeof units|undefined {
  if(view.rulesetId!=='legendary_ages_v1'||view.self.age<5)return;
  const completed=new Set(view.self.technologies??[]),jobs=own.flatMap(entity=>entity.queue??[]);
  const available=(id:string)=>{
    const unit=units[id];if(!unit||unit.minAge>view.self.age||unit.minAge>(view.maxAge??8))return false;
    if(unit.population>view.self.populationCap-view.self.population-view.self.reservedPopulation||Object.entries(unit.cost).some(([resource,cost])=>view.self.resources[resource as keyof ResourceBank]<cost))return false;
    if(unit.requiredTechnologies?.some(tech=>!completed.has(tech))||unit.requiredBuildings?.some(type=>!own.some(entity=>entity.kind==='building'&&entity.progress===1&&satisfiesBuilding(entity.typeId,type))))return false;
    return own.filter(entity=>entity.typeId===id).length+jobs.filter(job=>job.typeId===id&&job.kind==='train').length<(unit.maxPerPlayer??Infinity);
  };
  if(enemies.some(entity=>!entity.ghost&&units[entity.typeId]?.tags.includes('colossal'))&&own.filter(entity=>entity.typeId==='spearman').length<8)return 'spearman';
  const priorities=enemies.some(entity=>(entity.ward?.current??0)>0||entity.typeId==='ward_spire')?['wardbreaker_ballista','colossus_ram','rune_catapult']:['worldbreaker_trebuchet','warwolf_trebuchet','colossus_ram','rune_catapult','ironhide_ram','stone_warden','crown_colossus'];
  // Keep ordinary escorts and avoid monopolizing population with giant engines.
  const army=own.filter(entity=>entity.kind==='unit'&&!units[entity.typeId].tags.includes('worker'));
  if(army.length<4||army.filter(entity=>units[entity.typeId].minAge>=5).length>=Math.max(2,Math.floor(army.length/3)))return;
  return priorities.find(id=>available(id));
}
