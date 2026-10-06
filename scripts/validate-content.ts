import { balance, contentHash, assetCatalogContentHash, resolveRuleset, validateContent, validateAiPlan, validateClientCommand } from '@frontier/shared';
import { readFileSync } from 'node:fs';
validateContent(balance);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
if (!validateAiPlan(read('examples/ai-plan.valid.json')) || validateAiPlan(read('examples/ai-plan.invalid-extra-field.json')) || !validateClientCommand(read('examples/client-command.valid.json'))) throw new Error('SCHEMA_EXAMPLES_FAILED');
const current=resolveRuleset('legendary_ages_v1');
console.log(JSON.stringify({contentHash:current.contentHash,classicContentHash:contentHash,assetCatalogContentHash,ages:current.ages.length,units:current.units.length,buildings:current.buildings.length,technologies:current.technologies.length,examples:'valid and invalid examples checked'},null,2));
