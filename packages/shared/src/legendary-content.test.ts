import { describe, expect, it } from 'vitest';
import rawClassic from '../../../data/balance.v1.json';
import {
  PROTOCOL_VERSION, balance, buildings, units, legendaryExpansion, classicContentHash, assetCatalogContentHash,
  resolveRuleset, isContentAllowed, structureUpgrade, buildingSatisfies,
  validateLegendaryExpansion, validateContent, validateClientCommand, validateConsistentPlayerView,
  effectiveUnit, effectiveBuilding, effectiveGatherRates, effectiveConstructionRate, effectiveFarmCapacity,
  canonicalJson, sha256, type TechnologyId, type PlayerView,
} from './index.js';

const military:TechnologyId[]=['royal_muster','runebound_arms','titanforged_arms','oath_of_eternity'];
const engineering:TechnologyId[]=['citadel_engineering','runic_engineering','colossal_engineering','eternal_engineering'];
const economy:TechnologyId[]=['guild_stewardship','runic_husbandry','great_estates','eternal_stewardship'];

describe('Legendary content contracts',()=>{
  it('retains exact legacy data and content identity while adding later ages',()=>{
    expect(balance).toEqual(rawClassic);expect(classicContentHash).toBe(sha256(canonicalJson(rawClassic)));
    const classic=resolveRuleset();expect(classic.contentHash).toBe(classicContentHash);
    expect([classic.ages.length,classic.units.length,classic.buildings.length,classic.technologies.length]).toEqual([4,11,20,29]);
    expect([legendaryExpansion.ages.length,legendaryExpansion.units.length,legendaryExpansion.buildings.length,legendaryExpansion.technologies.length]).toEqual([4,8,15,12]);
    expect(()=>validateContent(balance)).not.toThrow();expect(()=>validateLegendaryExpansion(legendaryExpansion)).not.toThrow();
  });
  it('uses distinct immutable identities for each Legendary cap and resource preset',()=>{
    const full=resolveRuleset('legendary_ages_v1');
    expect([full.ages.length,full.units.length,full.buildings.length,full.technologies.length]).toEqual([8,19,35,41]);
    expect(full.startingResourcePreset).toBe('long_war');expect(Object.isFrozen(full.units)).toBe(true);
    const hashes=new Set([classicContentHash]);
    for(const cap of [4,5,6,7,8] as const)for(const preset of ['standard','long_war'] as const)hashes.add(resolveRuleset('legendary_ages_v1',cap,preset).contentHash);
    expect(hashes.size).toBe(11);expect(resolveRuleset('legendary_ages_v1')).toBe(full);
    expect(()=>resolveRuleset('classic_v1',8)).toThrow('INVALID_AGE_CAP');
    expect(()=>resolveRuleset('classic_v1',4,'long_war')).toThrow('INVALID_RESOURCE_PRESET');
  });
  it('does not admit Legendary IDs through Classic lookup availability or above the selected cap',()=>{
    expect(units.crown_colossus).toBeDefined();expect(isContentAllowed('crown_colossus')).toBe(false);
    expect(isContentAllowed('crown_colossus','legendary_ages_v1',7)).toBe(false);
    expect(isContentAllowed('crown_colossus','legendary_ages_v1',8)).toBe(true);
    expect(isContentAllowed('invented_spell','legendary_ages_v1',8)).toBe(false);
    expect(resolveRuleset('legendary_ages_v1',4).units.map(unit=>unit.id)).toEqual(balance.units.map(unit=>unit.id));
    expect(resolveRuleset('legendary_ages_v1',7).buildings.find(building=>building.id==='monument')!.minAge).toBe(7);
    expect(buildings.town_center!.maxPerPlayerByAge!['8']).toBe(4);
  });
  it('keeps baseline node yields and broad corridors in the Long War contract',()=>{
    expect(assetCatalogContentHash).toBe(sha256(canonicalJson({balance,legendaryExpansion})));
    expect(assetCatalogContentHash).not.toBe(classicContentHash);
    expect(legendaryExpansion.longWar).toMatchObject({preservePerNodeYields:true,minimumRoutes:2,minimumRouteWidthM:32,forestOpeningWidthM:48,maxResourceNodes:32000});
    expect(legendaryExpansion.longWar.perFactionNonStartingMinimum).toEqual({wood:60000,gold:45000,stone:50000});
  });
  it('recognizes higher citadel tiers and rejects skipped upgrades and footprint growth',()=>{
    expect(buildingSatisfies('eternal_citadel','grand_citadel')).toBe(true);
    expect(buildingSatisfies('grand_citadel','runic_citadel')).toBe(false);
    expect(structureUpgrade('grand_citadel','runic_citadel')).toEqual({cost:{food:0,wood:200,gold:500,stone:800},seconds:100});
    expect(structureUpgrade('stone_wall','bastion_wall')).toEqual({cost:{food:0,wood:0,gold:0,stone:17},seconds:18});
    expect(structureUpgrade('grand_citadel','eternal_citadel')).toBeNull();
    expect(structureUpgrade('stone_gate','bastion_gate')).toBeNull();
  });
  it('rejects a research-producing building that depends on its own research',()=>{
    const data=structuredClone(legendaryExpansion);data.buildings.find(building=>building.id==='rune_forge')!.requiredTechnologies=['runic_engineering'];
    expect(()=>validateLegendaryExpansion(data)).toThrow('Cyclic building/research dependency');
  });
  it('rejects unknown fields, invented modifiers and malformed upgrade geometry',()=>{
    expect(()=>validateLegendaryExpansion({...legendaryExpansion,freeWards:true})).toThrow();
    const data=structuredClone(legendaryExpansion);data.buildings.find(building=>building.id==='runic_citadel')!.footprintCells=[12,12];
    expect(()=>validateLegendaryExpansion(data)).toThrow('Invalid structural upgrade');
  });
  it('bounds optional projectile heights without modifying legacy weapon definitions',()=>{
    expect(balance.units.every(unit=>unit.projectileLaunchHeightM===undefined)).toBe(true);expect(balance.buildings.every(building=>building.projectileLaunchHeightM===undefined)).toBe(true);
    for(const height of [-1,0,.0001,100.001,Infinity]){const data=structuredClone(legendaryExpansion);data.units.find(unit=>unit.id==='worldbreaker_trebuchet')!.projectileLaunchHeightM=height;expect(()=>validateLegendaryExpansion(data)).toThrow();}
    const data=structuredClone(legendaryExpansion);data.units.find(unit=>unit.id==='crown_colossus')!.turret!.projectileLaunchHeightM=101;expect(()=>validateLegendaryExpansion(data)).toThrow();
  });
  it('aggregates military bonuses against the original base once, preserving older research',()=>{
    const base=units.spearman!,upgraded=effectiveUnit('spearman',military);
    expect(upgraded.maxHp).toBe(Math.floor(base.maxHp*1.8));expect(upgraded.attack).toBe(Math.floor(base.attack*1.6));
    expect(upgraded.bonusDamage).toEqual({cavalry:25,colossal:40});
    expect(upgraded.armor.melee).toBe(base.armor.melee+2);
    expect(effectiveUnit('spearman',[...military].reverse())).toEqual(upgraded);
    expect(effectiveUnit('spearman',[...military,...military])).toEqual(upgraded);
    expect(effectiveUnit('spearman',[...military,'veteran_spearman']).bonusDamage.cavalry).toBe(29);
    expect(effectiveUnit('stone_warden',[...military,...engineering])).toEqual(units.stone_warden);
  });
  it('improves only original siege and actual construction, not new siege or research',()=>{
    expect(effectiveConstructionRate(engineering)).toBe(1.6);expect(effectiveConstructionRate([])).toBe(1);
    expect(effectiveUnit('battering_ram',engineering).attack).toBe(56);
    expect(effectiveUnit('battering_ram',engineering).bonusDamage.building).toBe(128);
    expect(effectiveUnit('colossus_ram',engineering)).toEqual(units.colossus_ram);
    expect(effectiveBuilding('grand_citadel',['masonry'])).toEqual(buildings.grand_citadel);
  });
  it('adds all five gather rates, carrying and new farm capacity without compounding',()=>{
    const rates=effectiveGatherRates(economy);
    for(const source of ['forage','farm','wood','gold','stone'] as const)expect(rates[source]).toBeCloseTo(balance.rules.gatherPerWorkingSecond[source]*1.8,10);
    expect(effectiveGatherRates([...economy,'forestry_1']).wood).toBe(1.2675);
    expect(effectiveUnit('villager',economy).carryCapacity).toBe(30);
    expect(effectiveFarmCapacity(economy)).toBe(750);expect(effectiveFarmCapacity([])).toBe(350);
    expect(balance.buildings.find(building=>building.id==='farm')!.foodCapacity).toBe(350);
  });
  it('validates bounded atomic upgrade batches and rejects old protocol and invented destinations',()=>{
    const envelope={protocolVersion:PROTOCOL_VERSION,matchId:'match',matchEpoch:1,clientCommandId:'command',clientSequence:1,command:{kind:'upgrade_structure',buildingIds:['wall-1','wall-2'],targetTypeId:'bastion_wall'}};
    expect(validateClientCommand(envelope)).toBe(true);
    expect(validateClientCommand({...envelope,protocolVersion:1})).toBe(false);
    for(const buildingIds of [[],['wall-1','wall-1'],Array.from({length:65},(_,i)=>'wall-'+i)])expect(validateClientCommand({...envelope,command:{...envelope.command,buildingIds}})).toBe(false);
    expect(validateClientCommand({...envelope,command:{...envelope.command,targetTypeId:'fortress'}})).toBe(false);
    expect(validateClientCommand({...envelope,command:{...envelope.command,cost:0}})).toBe(false);
  });
  it('keeps owner-only upgrade, ammunition, ward support and aim out of enemy views',()=>{
    const view:PlayerView={protocolVersion:PROTOCOL_VERSION,contentHash:resolveRuleset('legendary_ages_v1').contentHash,rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war',matchId:'match',matchEpoch:1,tick:0,sequence:0,playerId:'self',status:'RUNNING',map:{widthMm:64000,heightMm:64000,fogCellMm:2000},self:{lastCommandSequence:0,resources:{food:0,wood:0,gold:0,stone:0},age:8,population:0,populationCap:10,populationLimit:120,reservedPopulation:0},players:[],fog:{visible:[],explored:[]},entities:[{id:'citadel',ownerId:'enemy',kind:'building',typeId:'runic_citadel',xMm:1000,zMm:1000,hp:16000,maxHp:16000,ward:{current:100,max:1500}}]};
    expect(validateConsistentPlayerView(view)).toBe(true);
    view.entities[0]!.ward!.supportId='hidden-spire';expect(validateConsistentPlayerView(view)).toBe(false);
    delete view.entities[0]!.ward!.supportId;view.entities[0]!.windup={remainingTicks:10,aim:{xMm:1000,zMm:1000}};expect(validateConsistentPlayerView(view)).toBe(false);
    view.entities[0]!.ownerId='self';expect(validateConsistentPlayerView(view)).toBe(true);
    view.projectiles=[{id:'shot',kind:'stone',xMm:1000,zMm:1000,yMm:8000,sourceTypeId:'worldbreaker_trebuchet',impactWarning:{xMm:1000,zMm:1000,radiusMm:8000,hitTick:200}}];
    view.effects=[{id:'impact',kind:'impact',projectileKind:'stone',tick:0,xMm:1000,zMm:1000,typeId:'worldbreaker_trebuchet'}];
    expect(validateConsistentPlayerView(view)).toBe(true);
    view.projectiles[0]!.impactWarning!.radiusMm=10001;expect(validateConsistentPlayerView(view)).toBe(false);
    delete view.projectiles[0]!.impactWarning;view.effects[0]!.entityId='hidden-source';expect(validateConsistentPlayerView(view)).toBe(false);
  });
});
