import { describe, expect, it } from 'vitest';
import { balance, buildings, effectiveBuilding, effectiveGatherRates, effectiveUnit, technologies, unitVisualTier, units, type BuildingDefinition, type BuildingId, type GatherRates, type TechnologyId, type UnitDefinition, type UnitId } from './index.js';

const allTechnologies = balance.technologies.map(technology => technology.id);
const melee: UnitId[] = ['militia','spearman','scout','light_cavalry','knight'];
const ranged: UnitId[] = ['archer','skirmisher'];
interface ExpectedTechnology {
  ids:TechnologyId[]; targets?:UnitId[]; change?:(unit:UnitDefinition)=>void;
  buildingChange?:(building:BuildingDefinition)=>void; rates?:Partial<GatherRates>;
}
// Independent catalog expectations: none reads the effects it is checking.
const expectations:ExpectedTechnology[] = [
  {ids:['forestry_1','forestry_2','forestry_3'],rates:{wood:.7475}},
  {ids:['mining_1','mining_2'],rates:{gold:.69,stone:.69}},
  {ids:['farming_1','farming_2'],rates:{farm:.8625}},
  {ids:['wheelbarrow'],targets:['villager'],change:unit=>{unit.carryCapacity=15;unit.moveSpeedMps=3.3;}},
  {ids:['hand_cart'],targets:['villager'],change:unit=>{unit.carryCapacity=20;unit.moveSpeedMps=3.3;}},
  {ids:['forging_1','forging_2','forging_3'],targets:melee,change:unit=>{unit.attack++;}},
  {ids:['fletching_1','fletching_2','fletching_3'],targets:ranged,change:unit=>{unit.attack++;unit.rangeM++;}},
  {ids:['melee_armor_1','melee_armor_2','melee_armor_3'],targets:melee,change:unit=>{unit.armor.melee++;unit.armor.pierce++;}},
  {ids:['ranged_armor_1','ranged_armor_2','ranged_armor_3'],targets:ranged,change:unit=>{unit.armor.melee++;unit.armor.pierce++;}},
  {ids:['veteran_militia','elite_militia'],targets:['militia'],change:unit=>{unit.maxHp+=15;unit.attack+=2;}},
  {ids:['veteran_spearman','elite_spearman'],targets:['spearman'],change:unit=>{unit.maxHp+=10;unit.attack+=2;unit.bonusDamage.cavalry!+=4;}},
  {ids:['veteran_archer','elite_archer'],targets:['archer'],change:unit=>{unit.maxHp+=5;unit.attack++;}},
  {ids:['elite_knight'],targets:['knight'],change:unit=>{unit.maxHp+=30;unit.attack+=2;}},
  {ids:['masonry'],buildingChange:building=>{building.maxHp=building.maxHp*6/5;building.armor.melee++;building.armor.pierce++;}},
];

describe('AT-15/16 complete technology modifier catalog',()=>{
  it('covers every stable technology exactly once in the independent expectations',()=>{
    const ids=expectations.flatMap(expected=>expected.ids);
    expect(ids).toHaveLength(29);expect(new Set(ids).size).toBe(29);expect([...ids].sort()).toEqual([...allTechnologies].sort());
  });
  it.each(expectations.flatMap(expected=>expected.ids.map(id=>({id,expected}))))('$id changes exactly its eligible stats and leaves every other catalog field unchanged',({id,expected})=>{
    for(const base of balance.units){
      const target=structuredClone(base);if(expected.targets?.includes(base.id))expected.change!(target);
      expect(effectiveUnit(base.id,[id]),`${id}/${base.id}`).toEqual(target);
    }
    for(const base of balance.buildings){
      const target=structuredClone(base);expected.buildingChange?.(target);
      if(target.id==='town_center')target.maxPerPlayerByAge={...target.maxPerPlayerByAge,'5':4,'6':4,'7':4,'8':4};
      expect(effectiveBuilding(base.id,[id]),`${id}/${base.id}`).toEqual(target);
    }
    expect(effectiveGatherRates([id])).toEqual({...balance.rules.gatherPerWorkingSecond,...expected.rates});
  });
  it('adds base fractions without compounding or rounding away quarter-milli rates',()=>{
    expect(effectiveGatherRates(['forestry_1','forestry_2']).wood).toBe(.845);
    expect(effectiveGatherRates(['forestry_1','forestry_2','forestry_3']).wood).toBe(.9425);
    expect(effectiveGatherRates(allTechnologies)).toEqual({forage:.7,farm:.975,wood:.9425,gold:.78,stone:.78});
    expect(effectiveUnit('villager',allTechnologies)).toMatchObject({carryCapacity:25,moveSpeedMps:3.6});
  });
  it('matches the full completed military tree',()=>{
    const expected:[UnitId,number,number,number,number,number][]=[
      ['villager',35,3,1.5,0,0],['scout',45,6,1.5,3,3],['militia',85,13,1.5,3,4],
      ['spearman',65,11,1.8,3,3],['archer',45,9,9,3,3],['skirmisher',40,6,8,3,6],
      ['light_cavalry',70,9,1.5,3,4],['knight',140,15,1.5,5,5],
      ['battering_ram',200,35,1.8,0,8],['catapult',120,40,9,0,0],['trebuchet',150,100,18,0,0],
    ];
    for(const [id,maxHp,attack,rangeM,meleeArmor,pierceArmor]of expected)expect(effectiveUnit(id,allTechnologies)).toMatchObject({maxHp,attack,rangeM,armor:{melee:meleeArmor,pierce:pierceArmor,crush:0}});
    expect(effectiveUnit('spearman',allTechnologies).bonusDamage).toEqual({cavalry:24});
    expect(effectiveBuilding('town_center',allTechnologies)).toMatchObject({maxHp:2880,armor:{melee:5,pierce:9,crush:0},attack:10,rangeM:8});
  });
  it('is independent of research order, duplicates, and iterable representation',()=>{
    const canonical={units:balance.units.map(unit=>effectiveUnit(unit.id,allTechnologies)),buildings:balance.buildings.map(building=>effectiveBuilding(building.id,allTechnologies)),rates:effectiveGatherRates(allTechnologies)};
    const orders=[...allTechnologies].map((_,index)=>[...allTechnologies.slice(index),...allTechnologies.slice(0,index)].reverse());
    for(const order of [...orders,[...allTechnologies,...allTechnologies]]){
      expect({units:balance.units.map(unit=>effectiveUnit(unit.id,order)),buildings:balance.buildings.map(building=>effectiveBuilding(building.id,order)),rates:effectiveGatherRates(order)}).toEqual(canonical);
    }
    expect(effectiveUnit('militia',new Set(allTechnologies))).toEqual(canonical.units.find(unit=>unit.id==='militia'));
    expect(effectiveGatherRates((function*(){yield 'forestry_2' as const;yield 'forestry_1' as const;})())).toEqual({...balance.rules.gatherPerWorkingSecond,wood:.845});
  });
  it('returns independent data and never mutates the base catalog or caller collection',()=>{
    const before=structuredClone(balance),completed:TechnologyId[]=['masonry','veteran_militia','forging_1'],original=[...completed];
    const unit=effectiveUnit('militia',completed),building=effectiveBuilding('town_center',completed),rates=effectiveGatherRates(completed);
    unit.attack=999;unit.armor.melee=999;unit.cost.food=999;unit.tags.push('changed');
    building.maxHp=999;building.footprintCells[0]=999;building.produces.length=0;rates.wood=999;
    expect(balance).toEqual(before);expect(completed).toEqual(original);
    expect(effectiveUnit('militia',completed)).toMatchObject({maxHp:70,attack:9,armor:{melee:0}});
    expect(effectiveBuilding('town_center',completed).footprintCells).toEqual([6,6]);
  });
  it('does not infer prerequisite upgrades or silently accept unknown IDs',()=>{
    expect(effectiveUnit('militia',['elite_militia'])).toMatchObject({maxHp:70,attack:8});
    expect(effectiveUnit('militia',[])).toEqual(units.militia);
    expect(effectiveBuilding('house',[])).toEqual(buildings.house);
    expect(()=>effectiveUnit('constructor' as UnitId,[])).toThrow('UNKNOWN_UNIT');
    expect(()=>effectiveBuilding('unknown' as BuildingId,[])).toThrow('UNKNOWN_BUILDING');
    for(const invalid of ['unknown','constructor','__proto__']){
      expect(()=>effectiveUnit('villager',[invalid as TechnologyId])).toThrow('UNKNOWN_TECHNOLOGY');
      expect(()=>effectiveBuilding('house',[invalid as TechnologyId])).toThrow('UNKNOWN_TECHNOLOGY');
      expect(()=>effectiveGatherRates([invalid as TechnologyId])).toThrow('UNKNOWN_TECHNOLOGY');
    }
  });
  it('derives only the named visual tiers',()=>{
    for(const id of ['militia','spearman','archer'] as const){expect(unitVisualTier(id,[])).toBe('base');expect(unitVisualTier(id,[`veteran_${id}`])).toBe('veteran');expect(unitVisualTier(id,[`veteran_${id}`,`elite_${id}`])).toBe('elite');}
    expect(unitVisualTier('knight',['elite_knight'])).toBe('elite');
    for(const id of ['villager','scout','skirmisher','light_cavalry','battering_ram','catapult','trebuchet'] as const)expect(unitVisualTier(id,allTechnologies)).toBe('base');
  });
  it('reaches every age, producer, unit and technology through its catalog prerequisites',()=>{
    const completed=new Set<TechnologyId>(),reachableUnits=new Set<UnitId>(),reachableBuildings=new Set<BuildingId>();
    const expectedTechnologyCounts=[0,8,20,29];
    for(const age of balance.ages){
      for(const requirement of age.prerequisites){
        const existing=requirement.types.filter(id=>reachableBuildings.has(id));
        expect(existing.length).toBeGreaterThanOrEqual(requirement.kind==='completed_buildings'?requirement.types.length:requirement.count);
      }
      for(const building of balance.buildings)if(building.minAge<=age.id)reachableBuildings.add(building.id);
      for(const unit of balance.units)if(unit.minAge<=age.id&&reachableBuildings.has(unit.producedAt))reachableUnits.add(unit.id);
      let changed=true;while(changed){changed=false;for(const technology of balance.technologies)if(!completed.has(technology.id)&&technology.minAge<=age.id&&reachableBuildings.has(technology.researchedAt)&&technology.prerequisites.every(id=>completed.has(id))){completed.add(technology.id);changed=true;}}
      expect(completed.size).toBe(expectedTechnologyCounts[age.id-1]);
    }
    expect([...completed].sort()).toEqual([...allTechnologies].sort());expect(reachableUnits.size).toBe(11);expect(reachableBuildings.size).toBe(20);
  });
});
