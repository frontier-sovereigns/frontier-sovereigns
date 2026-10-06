import { useState } from 'react';
import { AssetIcon } from './AssetIcon';
import { ages, balance, buildings, resolveRuleset, buildingSatisfies, technologies, units, type AgeDefinition, type BuildingId, type GameplayCommand, type PlayerView, type ResourceBank, type TechnologyDefinition, type ViewEntity, type ViewJob } from '@frontier/shared';

export function costLabel(cost: ResourceBank, multiple = 1): string { return balance.resourceOrder.filter((resource) => cost[resource] > 0).map((resource) => `${Math.floor(cost[resource] * multiple)} ${resource}`).join(' · ') || 'No resource cost'; }
export function missingLabel(cost: ResourceBank, bank: ResourceBank, multiple = 1): string { const missing = balance.resourceOrder.filter((resource) => cost[resource] * multiple > bank[resource]).map((resource) => `${Math.ceil(cost[resource] * multiple - bank[resource])} ${resource}`); return missing.length ? `Need ${missing.join(', ')}` : ''; }
export function refundLabel(cost: ResourceBank, progress: number, started = true, fraction = balance.rules.startedJobRemainingRefundFraction): string { const refund = Object.fromEntries(balance.resourceOrder.map((resource) => [resource, Math.floor(cost[resource] * (started ? Math.max(0, 1 - progress) * fraction : 1))])) as ResourceBank; return costLabel(refund); }
export function jobDefinition(job: ViewJob) { return job.kind === 'age' ? ages[Number(job.typeId.slice(4))]! : job.kind === 'research' ? technologies[job.typeId]! : units[job.typeId]!; }
export function jobStateLabel(job: ViewJob, view?: PlayerView): string {
  if (job.state === 'active') return job.kind === 'train' ? 'Training' : job.kind === 'age' ? 'Advancing age' : 'Researching';
  if (job.state === 'prerequisite_blocked') {
    if (job.kind === 'age' && view) {
      const missing = agePrerequisites(ages[Number(job.typeId.slice(4))]!, view).filter((entry) => !entry.met);
      if (missing.length) return `Waiting for ${missing.map((entry) => entry.text.replace(/^Completed /, '')).join(', ')}`;
    }
    return job.blockedReason === 'AGE_REQUIRED' || job.blockedReason === 'INVALID_AGE' ? 'Waiting for the required age' : 'Waiting for prerequisites';
  }
  return ({ waiting: 'Waiting in queue', population_blocked: 'Waiting for housing', exit_blocked: 'Exit blocked - clear space outside' })[job.state];
}

const ownBuildings = (view: PlayerView) => view.entities.filter((entity) => entity.ownerId === view.playerId && entity.kind === 'building');
const fullQueue = (building: ViewEntity) => (building.queue?.length ?? 0) >= balance.rules.queueWaitingLimit + 1;

export function agePrerequisites(age: AgeDefinition, view: PlayerView): { text: string; met: boolean }[] {
  const complete = new Set(ownBuildings(view).filter((entity) => (entity.progress ?? 1) >= 1 && !entity.demolitionTicksRemaining).map((entity) => entity.typeId));
  return age.prerequisites.flatMap((requirement) => requirement.kind === 'completed_buildings'
    ? requirement.types.map((type) => ({ text: `Completed ${buildings[type]!.name}`, met: [...complete].some(actual=>buildingSatisfies(actual as BuildingId,type)) }))
    : [{ text: `${requirement.count} distinct completed types: ${requirement.types.map((type) => buildings[type]!.name).join(', ')} (${requirement.types.filter((type) => [...complete].some(actual=>buildingSatisfies(actual as BuildingId,type))).length}/${requirement.count})`, met: requirement.types.filter((type) => [...complete].some(actual=>buildingSatisfies(actual as BuildingId,type))).length >= requirement.count }]);
}
export function ageLock(age: AgeDefinition, view: PlayerView, building?: ViewEntity): string {
  if(age.id>resolveRuleset(view.rulesetId,view.maxAge).maxAge)return 'Above this match age cap';
  if (view.self.age >= age.id) return 'Age reached';
  if (view.self.age !== age.requiredAge) return `${ages[age.requiredAge!]!.name} required first`;
  if (ownBuildings(view).some((entity) => entity.queue?.some((job) => job.kind === 'age'))) return 'Age advancement already queued';
  if (!building || building.typeId !== 'town_center' || building.ownerId !== view.playerId || (building.progress ?? 1) < 1 || building.demolitionTicksRemaining) return 'A completed Town Center is required';
  const prerequisite = agePrerequisites(age, view).find((entry) => !entry.met);
  if (prerequisite) return prerequisite.text;
  if (fullQueue(building)) return 'Shared production queue is full';
  return missingLabel(age.cost, view.self.resources);
}
export function researchLock(technology: TechnologyDefinition, view: PlayerView, building?: ViewEntity): string {
  if(!resolveRuleset(view.rulesetId,view.maxAge).technologies.some(item=>item.id===technology.id))return 'Unavailable in this match';
  const completed = view.self.technologies ?? [];
  if (completed.includes(technology.id)) return 'Research completed';
  if (ownBuildings(view).some((entity) => entity.queue?.some((job) => job.kind === 'research' && job.typeId === technology.id))) return 'Research already queued';
  if (view.self.age < technology.minAge) return `${ages[technology.minAge]!.name} required`;
  const prerequisite = technology.prerequisites.find((id) => !completed.includes(id));
  if (prerequisite) return `${technologies[prerequisite]!.name} required first`;
  if (!building || building.ownerId !== view.playerId || building.typeId !== technology.researchedAt || (building.progress ?? 1) < 1 || building.demolitionTicksRemaining) return `A completed ${buildings[technology.researchedAt]!.name} is required`;
  if (fullQueue(building)) return 'Shared production queue is full';
  return missingLabel(technology.cost, view.self.resources);
}
const statNames:Record<string,string> = { attack: 'attack', maxHp: 'maximum HP', rangeM: 'range (m)', moveSpeedMps: 'movement speed', carryCapacity: 'carrying capacity', 'armor.melee': 'melee armor', 'armor.pierce': 'pierce armor', 'armor.crush': 'crush armor', 'bonusDamage.cavalry': 'bonus against cavalry', 'gatherRate.wood': 'wood gathering', 'gatherRate.gold': 'gold gathering', 'gatherRate.stone': 'stone gathering', 'gatherRate.farm': 'farm gathering', 'constructionRate':'construction rate', 'foodCapacity':'new farm capacity', 'gatherRate.forage':'foraging', 'bonusDamage.colossal':'bonus against colossi', 'bonusDamage.siege':'bonus against siege', 'bonusDamage.building':'bonus against buildings', 'bonusDamage.archer':'bonus against archers' };
export function effectLabel(technology: TechnologyDefinition): string { return technology.effects.map((effect) => `+${effect.operation === 'add_base_fraction' ? `${Math.round(effect.value * 100)}% base` : effect.value} ${statNames[effect.stat]??effect.stat.replaceAll('.', ' ')}`).join(' · '); }
function targetLabel(technology: TechnologyDefinition): string { return [...new Set(technology.effects.flatMap((effect) => effect.targets))].map((id) => units[id]?.name ?? buildings[id]?.name ?? id).join(', '); }
interface ResearchProps { view: PlayerView; building: ViewEntity; locked: boolean; send: (command: GameplayCommand) => void }
export function ResearchActions({ view, building, locked, send }: ResearchProps) {
  const content=resolveRuleset(view.rulesetId,view.maxAge);
  const next = building.typeId === 'town_center' ? content.ages.find(age=>age.id===view.self.age+1) : undefined;
  return <div className="research-actions">
    {next && <button className="age-action" aria-label={`Advance to ${next.name}`} disabled={locked || !!ageLock(next, view, building)} title={`${costLabel(next.cost)} · ${next.researchSeconds}s · ${agePrerequisites(next, view).map((entry) => `${entry.met ? '✓' : '○'} ${entry.text}`).join('; ')}`} onClick={() => send({ kind: 'advance_age', townCenterId: building.id, targetAge: next.id as 2 | 3 | 4 | 5 | 6 | 7 | 8 })}><AssetIcon id={`age_icon_${next.id}`} className="age-seal"/><span><b>Advance to {next.name}</b><small>{ageLock(next, view, building) || `${costLabel(next.cost)} · ${next.researchSeconds}s`}</small></span></button>}
    <div className="research-action-grid">{content.technologies.filter((technology) => technology.researchedAt === building.typeId).map((technology) => { const reason = researchLock(technology, view, building); return <button key={technology.id} className="research-action" aria-label={`Research ${technology.name}`} disabled={locked || !!reason} title={`${effectLabel(technology)} · ${targetLabel(technology)} · ${costLabel(technology.cost)} · ${technology.researchSeconds}s`} onClick={() => send({ kind: 'research', buildingId: building.id, technologyId: technology.id })}><AssetIcon id={`tech_icon_${technology.id}`} className="action-icon"/><b>{technology.name}</b><span>{effectLabel(technology)}</span><small>{reason || costLabel(technology.cost)}</small></button>; })}</div>
  </div>;
}

export function TechnologyTree({ view, locked, send, close, select }: { view: PlayerView; locked: boolean; send: (command: GameplayCommand) => void; close: () => void; select: (id: string) => void }) {
  const [filter, setFilter] = useState('all');
  const content=resolveRuleset(view.rulesetId,view.maxAge);
  const producers = [...new Set(content.technologies.map((technology) => technology.researchedAt))];
  const complete = ownBuildings(view).filter((entity) => (entity.progress ?? 1) >= 1 && !entity.demolitionTicksRemaining);
  const producerFor = (type: string) => complete.filter((entity) => entity.typeId === type).sort((a, b) => (a.queue?.length ?? 0) - (b.queue?.length ?? 0) || a.id.localeCompare(b.id))[0];
  return <section data-gameplay-hotkeys="suspend" className="technology-window" role="dialog" aria-modal="false" aria-label="Technology tree"><div className="technology-heading"><div><span className="eyebrow">KNOWLEDGE OF YOUR FACTION</span><h2>Through the ages</h2><p>{view.self.technologies?.length ?? 0} / {content.technologies.length} technologies completed · {ages[view.self.age]?.name}</p></div><button className="quiet-button" aria-label="Close technology tree" onClick={close}>×</button></div>
    <div className="age-tree">{content.ages.map((age) => { const tc = producerFor('town_center'), reason = age.id === 1 ? 'Starting age' : ageLock(age, view, tc); return <article key={age.id} className={age.id <= view.self.age ? 'age-reached' : ''}><span className="eyebrow">AGE {['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][age.id]}</span><h3><AssetIcon id={`age_icon_${age.id}`}/>{age.name}</h3>{age.id > 1 && <><span>{costLabel(age.cost)} · {age.researchSeconds}s</span><ul>{agePrerequisites(age, view).map((entry) => <li className={entry.met ? 'requirement-met' : ''} key={entry.text}>{entry.met ? '✓' : '○'} {entry.text}</li>)}</ul></>}<button className="quiet-button" aria-label={`Advance to ${age.name} from technology tree`} disabled={locked || !!reason} onClick={() => tc && send({ kind: 'advance_age', townCenterId: tc.id, targetAge: age.id as 2 | 3 | 4 | 5 | 6 | 7 | 8 })}>{reason || `Advance to ${age.name}`}</button></article>; })}</div>
    <div className="technology-filters"><label>Research building<select aria-label="Filter technology building" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All buildings · {content.technologies.length} technologies</option>{producers.map((type) => <option key={type} value={type}>{buildings[type]!.name}</option>)}</select></label><p>Training, research, and age advancement share each building’s queue. Costs are paid when queued. Completed technologies apply to existing and future units.</p></div>
    {producers.filter((type) => filter === 'all' || filter === type).map((type) => <div className="technology-group" key={type}><h3>{buildings[type]!.name}{producerFor(type) && <button className="quiet-button" onClick={() => { select(producerFor(type)!.id); close(); }}>Select building</button>}</h3><div className="technology-cards">{content.technologies.filter((technology) => technology.researchedAt === type).map((technology) => { const producer = producerFor(type), reason = researchLock(technology, view, producer), done = view.self.technologies?.includes(technology.id); return <article key={technology.id} data-testid={`technology-${technology.id}`} className={`technology-card ${done ? 'technology-complete' : ''}`}><div><h4><AssetIcon id={`tech_icon_${technology.id}`}/>{technology.name}</h4><span>{done ? '✓ Completed' : ages[technology.minAge]!.name}</span></div><p>{effectLabel(technology)}</p><small className="technology-targets">{targetLabel(technology)}</small><p className="technology-dependencies">Requires: {technology.prerequisites.length ? technology.prerequisites.map((id) => `${view.self.technologies?.includes(id) ? '✓ ' : ''}${technologies[id]!.name}`).join(' → ') : 'No earlier technology'} · Age {technology.minAge}</p><small>{costLabel(technology.cost)} · {technology.researchSeconds}s</small><button className="quiet-button" aria-label={`Research ${technology.name} from technology tree`} disabled={locked || !!reason} onClick={() => producer && send({ kind: 'research', buildingId: producer.id, technologyId: technology.id })}>{reason || 'Queue research'}</button></article>; })}</div></div>)}
  </section>;
}
