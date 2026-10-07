import { describe, expect, it } from 'vitest';
import { ages, balance, buildings, technologies, structureUpgrade, resolveRuleset, type PlayerView, type ViewEntity } from '@frontier/shared';
import { buildLock, buildPaletteTypes, contentRequirementLock, createEconomyViewIndex } from './EconomyPanel';
import { ageLock, agePrerequisites, jobDefinition, jobStateLabel, refundLabel, researchLock } from './ResearchPanel';

const building = (typeId: string, id = typeId): ViewEntity => ({ id, kind: 'building', typeId, ownerId: 'me', xMm: 10000, zMm: 10000, hp: 100, maxHp: 100, progress: 1, queue: [] });
function fixture(): PlayerView { return { protocolVersion: 2, contentHash: 'fixture', matchId: 'fixture', matchEpoch: 1, tick: 0, sequence: 0, playerId: 'me', status: 'RUNNING', map: { widthMm: 64000, heightMm: 64000, fogCellMm: 4000 }, self: { lastCommandSequence: 0, resources: { food: 5000, wood: 5000, gold: 5000, stone: 5000 }, age: 1, population: 7, populationCap: 15, populationLimit: 120, reservedPopulation: 0, technologies: [] }, players: [], entities: [building('town_center')], fog: { visible: [], explored: [] } }; }

describe('research UI uses authoritative content requirements', () => {
  it('requires distinct completed prerequisite types and preserves shared queue locks', () => {
    const view = fixture(), center = view.entities[0]!;
    view.entities.push(building('mill'), building('mill', 'mill2'));
    expect(ageLock(ages[2]!, view, center)).toContain('(1/2)');
    view.entities.push({ ...building('lumber_camp'), progress: 0.9 });
    expect(agePrerequisites(ages[2]!, view)[0]!.met).toBe(false);
    view.entities[3]!.progress = 1;
    expect(ageLock(ages[2]!, view, center)).toBe('');
    center.queue = [{ id: 'age-job', kind: 'age', typeId: 'age_2', state: 'active', progress: 0.2, started: true }];
    expect(ageLock(ages[2]!, view, center)).toBe('Age advancement already queued');
    expect(jobDefinition(center.queue[0]!).cost).toEqual(ages[2]!.cost);
    expect(jobStateLabel(center.queue[0]!)).toBe('Advancing age');
    expect(refundLabel(ages[2]!.cost, 0.2)).toBe('330 food · 90 gold');
  });
  it('exposes all 29 technologies and checks every individual producer, age, dependency, cost, and duplicate', () => {
    expect(balance.technologies).toHaveLength(29);
    for (const technology of balance.technologies) {
      const view = fixture(), producer = building(technology.researchedAt); view.entities = [producer];
      view.self.age = technology.minAge; view.self.technologies = [...technology.prerequisites];
      expect(researchLock(technology, view, producer), technology.id).toBe('');
      expect(researchLock(technology, view), technology.id).toContain('completed');
      view.self.resources = { food: 0, wood: 0, gold: 0, stone: 0 };
      expect(researchLock(technology, view, producer)).toContain('Need ');
      view.self.age = technology.minAge - 1;
      expect(researchLock(technology, view, producer)).toContain('required');
      view.self.age = technology.minAge;
      if (technology.prerequisites.length) { view.self.technologies = []; expect(researchLock(technology, view, producer)).toContain(technologies[technology.prerequisites[0]!]!.name); }
      view.self.technologies = [...technology.prerequisites, technology.id];
      expect(researchLock(technology, view, producer)).toBe('Research completed');
      view.self.technologies = [...technology.prerequisites]; producer.queue = [{ id: 'research-job', kind: 'research', typeId: technology.id, state: 'waiting', progress: 0, started: false }];
      expect(researchLock(technology, view, producer)).toBe('Research already queued');
      expect(jobDefinition(producer.queue[0]!)).toBe(technology);
    }
  });
  it('labels blocked research and refunds an unstarted job in full', () => {
    const job = { id: 'job', kind: 'research', typeId: 'forestry_1', state: 'prerequisite_blocked', progress: 0, started: false, blockedReason: 'PREREQUISITES_REQUIRED' } as const;
    expect(jobStateLabel(job)).toBe('Waiting for prerequisites');
    expect(jobStateLabel({ kind: 'age', typeId: 'age_3', id: 'age', state: 'prerequisite_blocked', progress: 0, blockedReason: 'PREREQUISITES_REQUIRED' }, fixture())).toBe('Waiting for Market, Blacksmith');
    expect(refundLabel(jobDefinition(job).cost, job.progress, job.started)).toBe('100 food · 50 wood');
  });
});


it('later ages retain higher-family prerequisites and respect the selected age cap',()=>{
  const view=fixture();view.rulesetId='legendary_ages_v1';view.maxAge=8;view.self.age=6;view.self.resources={food:10000,wood:10000,gold:10000,stone:10000};
  view.entities.push(building('eternal_citadel'),building('rune_forge'),building('ward_spire'));
  expect(agePrerequisites(ages[7]!,view).every(item=>item.met)).toBe(true);
  expect(ageLock(ages[7]!,view,view.entities[0])).toBe('');view.maxAge=6;expect(ageLock(ages[7]!,view,view.entities[0])).toContain('age cap');
  expect(structureUpgrade('grand_citadel','runic_citadel')!.cost).toEqual({food:0,wood:200,gold:500,stone:800});expect(structureUpgrade('fortress','grand_citadel')).toBeNull();
  view.rulesetId='classic_v1';view.maxAge=4;expect(researchLock(technologies.citadel_engineering!,view,building('university'))).toContain('Unavailable');
});

it('build palettes require paid engineering and count committed citadel upgrades',()=>{
  const view=fixture();view.rulesetId='legendary_ages_v1';view.maxAge=8;view.self.age=8;view.self.resources={food:10000,wood:10000,gold:10000,stone:10000};
  expect(buildLock('grand_citadel',view)).toContain('Citadel Engineering');view.self.technologies=['citadel_engineering'];expect(buildLock('grand_citadel',view)).toBe('');
  view.entities.push(building('runic_citadel','first'),{...building('grand_citadel','second'),progress:.1});expect(buildLock('grand_citadel',view)).toContain('Family limit');
  view.maxAge=4;expect(buildLock('grand_citadel',view)).toContain('Unavailable');expect(buildLock('monument',view)).toBe('');
  view.entities=view.entities.filter(entity=>entity.typeId!=='runic_citadel');expect(contentRequirementLock({id:'example',requiredBuildings:['runic_citadel']},view)).toContain('Runic Citadel');view.entities.push(building('eternal_citadel'));expect(contentRequirementLock({id:'example',requiredBuildings:['runic_citadel']},view)).toBe('');
});

it('every allowed building has one palette slot when Monument unlocks at the match age cap', () => {
  for (const [ruleset, maximumAge] of [['classic_v1', 4], ['legendary_ages_v1', 4], ['legendary_ages_v1', 5], ['legendary_ages_v1', 6], ['legendary_ages_v1', 7], ['legendary_ages_v1', 8]] as const) {
    const content = resolveRuleset(ruleset, maximumAge);
    const economy = buildPaletteTypes(content, 'economy'), military = buildPaletteTypes(content, 'military'), fortifications = buildPaletteTypes(content, 'fortifications');
    const all = [...economy, ...military, ...fortifications];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(content.buildings.map(building => building.id).sort());
    expect(military.filter(id => id === 'monument')).toHaveLength(1);
    expect(economy).not.toContain('monument'); expect(fortifications).not.toContain('monument');
    expect(buildPaletteTypes(content, 'orders')).toEqual([]);
  }
});

it('indexes authorized economy data once without rescanning resources for every building card', () => {
  const view = fixture(); view.rulesetId = 'legendary_ages_v1'; view.maxAge = 8; view.self.age = 8;
  view.self.technologies = resolveRuleset(view.rulesetId, view.maxAge).technologies.map(item => item.id);
  const content = resolveRuleset(view.rulesetId, view.maxAge);
  view.entities.push(...content.buildings.map(item => building(item.id)),
    ...Array.from({length: 1000}, (_, index): ViewEntity => ({id: `tree-${index}`, kind: 'resource', typeId: 'tree_oak', ownerId: null, xMm: index, zMm: 20000, hp: 1, maxHp: 1, resource: 'wood', amount: 250})));
  const expected = content.buildings.map(item => buildLock(item.id, view));
  let reads = 0; const entities = view.entities;
  Object.defineProperty(view, 'entities', {get() { reads++; return entities; }});
  const index = createEconomyViewIndex(view);
  expect(reads).toBe(1);
  for (let hover = 0; hover < 10; hover++) {
    expect(content.buildings.map(item => buildLock(item.id, view, index))).toEqual(expected);
  }
  // Ten hover-driven redraws of all 35 cards perform no additional full-view
  // reads. This measures removed work, not a wall-clock performance claim.
  expect(content.buildings).toHaveLength(35); expect(reads).toBe(1);
});

it('economy indexes preserve fog, alliance, queues, demolition and incoming view changes', () => {
  const view = fixture();
  view.players = [{id: 'me', name: 'Mine', kind: 'human', teamId: 'one', color: '#00f', age: 1}, {id: 'ally', name: 'Ally', kind: 'human', teamId: 'one', color: '#0f0', age: 1}, {id: 'enemy', name: 'Enemy', kind: 'ai', teamId: 'two', color: '#f00', age: 1}];
  const villager: ViewEntity = {...building('villager'), kind: 'unit', order: 'idle'};
  const resource: ViewEntity = {id: 'wood', kind: 'resource', typeId: 'tree_oak', ownerId: null, xMm: 10000, zMm: 20000, hp: 1, maxHp: 1, resource: 'wood', amount: 250};
  view.entities = [view.entities[0]!, villager, {...villager, id: 'garrisoned', garrisonedIn: 'town_center'},
    {...building('farm', 'allied-farm'), ownerId: 'ally', resource: 'food', amount: 250},
    {...building('farm', 'enemy-farm'), ownerId: 'enemy', resource: 'food', amount: 250}, resource,
    {...resource, id: 'remembered-gold', typeId: 'gold_deposit', resource: 'gold', ghost: true},
    {...resource, id: 'depleted-stone', typeId: 'stone_quarry', resource: 'stone', amount: 0},
    {...building('mill'), progress: .2}, {...building('lumber_camp'), demolitionTicksRemaining: 20},
    {...building('runic_citadel'), queue: [{id: 'training', kind: 'train', typeId: 'villager', state: 'waiting', progress: 0}]}];
  const index = createEconomyViewIndex(view);
  expect([...index.gatherable].sort()).toEqual(['food', 'wood']);
  expect(index.unitCounts.get('villager')).toBe(3); expect(index.villagers.map(entity => entity.id)).toEqual(['villager']);
  expect(index.completedBuildings.map(entity => entity.typeId)).toEqual(['town_center', 'runic_citadel']);
  expect(contentRequirementLock({id: 'needs-mill', requiredBuildings: ['mill']}, view, index)).toContain('Completed Mill');
  expect(contentRequirementLock({id: 'needs-grand-citadel', requiredBuildings: ['grand_citadel']}, view, index)).toBe('');
  const next = {...view, entities: view.entities.filter(entity => entity.id !== 'allied-farm').map(entity => entity.id === 'wood' ? {...entity, amount: 0} : entity.typeId === 'mill' ? {...entity, progress: 1} : entity)};
  const nextIndex = createEconomyViewIndex(next);
  expect([...nextIndex.gatherable]).toEqual([]);
  expect(contentRequirementLock({id: 'needs-mill', requiredBuildings: ['mill']}, next, nextIndex)).toBe('');
  expect([...index.gatherable].sort()).toEqual(['food', 'wood']);
});
