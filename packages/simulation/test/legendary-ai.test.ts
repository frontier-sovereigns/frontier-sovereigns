import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, buildings, resolveRuleset, type AiGoal, type BuildingId, type PlayerView, type ViewEntity } from '@frontier/shared';
import { desiredGoalCommands, commandCost } from '../src/ai-executor.js';
import { missingAgeBuildings } from '../src/caretaker.js';
import { createCommanderState } from '../src/ai-controller.js';
import { createAiMemory } from '../src/ai-memory.js';
import { buildAiObservation, buildAiPrompt } from '../src/ai-observation.js';
import { commandEntities } from '../src/assistant.js';
import { legendaryArmyChoice } from '../src/legendary-ai.js';

function view():PlayerView {
  const rules=resolveRuleset('legendary_ages_v1',8);
  return {protocolVersion:PROTOCOL_VERSION,contentHash:rules.contentHash,rulesetId:rules.rulesetId,maxAge:8,startingResourcePreset:'long_war',matchId:'later',matchEpoch:1,tick:50000,sequence:1,playerId:'blue',status:'RUNNING',
    map:{widthMm:384000,heightMm:384000,fogCellMm:2000,terrain:[]},fog:{visible:[0,1],explored:[0,1]},
    players:[{id:'blue',name:'Blue',kind:'ai',teamId:'blue',color:'#3388ff',difficulty:'medium',personality:'marshal'},{id:'red',name:'Red',kind:'human',teamId:'red',color:'#ff5533'}],
    self:{age:7,resources:{food:20000,wood:20000,gold:20000,stone:20000},population:6,populationCap:120,populationLimit:120,reservedPopulation:0,lastCommandSequence:0,technologies:[]},
    entities:[structure('town_center'),structure('grand_citadel'),structure('rune_forge'),structure('ward_spire'),structure('great_siege_yard'),structure('university'),...Array.from({length:6},(_,i):ViewEntity=>({id:'worker_'+i,kind:'unit',typeId:'villager',ownerId:'blue',xMm:100000+i*1000,zMm:95000,hp:35,maxHp:35,order:'idle',taskState:'idle'}))]};
}
function structure(typeId:BuildingId):ViewEntity {const def=buildings[typeId];return {id:typeId,kind:'building',typeId,ownerId:'blue',xMm:80000,zMm:80000,hp:def.maxHp,maxHp:def.maxHp,progress:1,queue:[]};}
function planned(value:PlayerView,goal:AiGoal){
  const state=createCommanderState(value.matchId,value.playerId);state.mode='model';
  state.plan={generation:1,strategy:'Continue the kingdom',acceptedTick:value.tick,expiresTick:value.tick+1000,goals:[{key:'desired',kind:goal.kind,goal,status:'accepted',acceptedTick:value.tick,expiresTick:value.tick+1000,candidateIndex:0,attempts:0}]};
  state.planReferences={home:{ref:'home',kind:'own_base',entityId:'town_center',position:{xMm:80000,zMm:80000}}};return state;
}
describe('continuous later-age AI planning',()=>{
  it('satisfies earlier citadel prerequisites with later tiers',()=>{
    const value=view();value.self.age=6;value.entities=value.entities.filter(entity=>entity.typeId!=='grand_citadel');value.entities.push(structure('titan_citadel'));
    expect(missingAgeBuildings(value)).toEqual([]);
  });
  it('buys a single sequential citadel upgrade and accounts its incremental price',()=>{
    const value=view();value.self.technologies=['citadel_engineering','runic_engineering','colossal_engineering'];const state=planned(value,{kind:'ensure_building',buildingType:'titan_citadel',targetCount:1,anchorRef:'home'});
    const actions=desiredGoalCommands(value,state),command=actions[0]?.command;
    expect(command).toEqual({kind:'upgrade_structure',buildingIds:['grand_citadel'],targetTypeId:'runic_citadel'});
    expect(commandCost(command!,value)?.stone).toBe(buildings.runic_citadel.cost.stone-buildings.grand_citadel.cost.stone);
    expect(commandEntities(command!)).toEqual(['grand_citadel']);
  });
  it('keeps paid upgrades and manually protected structures instead of repurchasing them',()=>{
    const value=view(),state=planned(value,{kind:'ensure_building',buildingType:'runic_citadel',targetCount:1,anchorRef:'home'});
    const building=value.entities.find(entity=>entity.typeId==='grand_citadel')!;
    building.upgrade={jobId:'paid',targetTypeId:'runic_citadel',progress:.2,started:true,state:'active'};
    const protectedIds=new Set(['grand_citadel']);
    expect(desiredGoalCommands(value,state,undefined,protectedIds).some(proposal=>proposal.command.kind==='build'||proposal.command.kind==='upgrade_structure')).toBe(false);
  });
  it('pursues engineering dependencies before buying a new engine',()=>{
    const value=view();value.self.age=8;value.entities.push(structure('titan_citadel'));
    const state=planned(value,{kind:'ensure_units',unitType:'worldbreaker_trebuchet',targetCount:1});
    const actions=desiredGoalCommands(value,state);
    expect(actions.some(proposal=>proposal.command.kind==='research'&&proposal.command.technologyId==='citadel_engineering')).toBe(true);
    expect(actions.some(proposal=>proposal.command.kind==='train')).toBe(false);
  });
  it('keeps affordable siege recruitment available when ultimate engines cannot be paid',()=>{
    const value=view();value.self.age=8;value.self.technologies=['citadel_engineering','runic_engineering','colossal_engineering','eternal_engineering'];value.self.resources={food:0,wood:350,gold:180,stone:100};
    for(let i=0;i<4;i++)value.entities.push({id:'escort_'+i,kind:'unit',typeId:'militia',ownerId:'blue',xMm:60000+i*1000,zMm:60000,hp:55,maxHp:55});
    expect(legendaryArmyChoice(value,value.entities,[])).toBe('ironhide_ram');
    value.self.reservedPopulation=value.self.populationCap-value.self.population-4;expect(legendaryArmyChoice(value,value.entities,[])).toBeUndefined();
  });
  it('gives the model a bounded later-age catalog and visible ward/cap facts',()=>{
    const value=view();value.self.age=8;
    const binding={matchId:value.matchId,matchEpoch:1,playerId:'blue',requestId:'request',observationId:'observation',observedTick:value.tick,controllerGeneration:1};
    const dispatch=buildAiObservation(value,{binding,memory:createAiMemory(value.matchId,'blue')});
    expect(dispatch.observation.lateGame?.availableUnits).toContain('crown_colossus');
    expect(dispatch.observation.lateGame?.maxAge).toBe(8);
    const prompt=buildAiPrompt(dispatch,{inputTokenBudget:2500,outputTokenBudget:512});
    expect(prompt.estimatedInputTokens).toBeLessThanOrEqual(2500);
    expect(prompt.messages[0]?.content).toContain('Worldbreaker');
  });
});
