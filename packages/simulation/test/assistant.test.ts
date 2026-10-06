import { MessageChannel, receiveMessageOnPort } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, type AssistantPreferences, type ClientCommandEnvelope, type GameplayCommand } from '@frontier/shared';
import { createSimulation, exportReplay, exportSimulationSave, replayCheckpoint, ReplayRunner, restoreSimulation, type Building, type EngineIdentity, type Simulation, type Unit } from '../src/index.js';
import { createNativeCommandBatch } from '../src/command-admission-native.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';

const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const preferences=(modelId='personal',enabled=true,reserve=0):AssistantPreferences=>({modelId,enabled,reserve:{food:reserve,wood:reserve,gold:reserve,stone:reserve}});
function fixture(controllers=false){
  const sim=createSimulation({matchId:'assistant',seed:'assistant-authority',controllers,sharedVision:false,factions:[
    {id:'human',name:'Human',teamId:'blue',kind:'human',color:'#0072f5'},
    {id:'bot',name:'Bot',teamId:'red',kind:'ai',color:'#f07800'},
    {id:'other',name:'Other bot',teamId:'red',kind:'ai',color:'#00b8a9'},
  ]});
  const own=Object.values(sim.state.entities).filter(entity=>entity.ownerId==='human');
  return {sim,worker:own.find(entity=>entity.typeId==='villager') as Unit,scout:own.find(entity=>entity.typeId==='scout') as Unit,home:own.find(entity=>entity.typeId==='town_center') as Building};
}
function envelope(sim:Simulation,sequence:number,command:GameplayCommand,id=`order_${sequence}`):ClientCommandEnvelope{return {protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientSequence:sequence,clientCommandId:id,command};}
function send(sim:Simulation,command:GameplayCommand,source:'human'|'ai'='human',id?:string){const sequence=(source==='ai'?sim.state.control.human!.assistant!.sequence:sim.state.economies.human!.lastClientSequence)+1;return sim.command('human',envelope(sim,sequence,command,id),source);}
function install(sim:Simulation,playerId='human'){const request=sim.prepareAiRequest(playerId,`request_${sim.state.controllers[playerId]!.observationNonce+1}`);expect(sim.completeAiRequest(request.binding,{kind:'plan',plan:{schemaVersion:1,observationId:request.binding.observationId,strategy:'Develop this faction independently.',goals:[],message:null}}).accepted).toBe(true);return request;}

describe('server catalog commander authority',()=>{
  it('binds all eleven existing seats independently without converting assisted humans to AI slots',()=>{
    const factions=Array.from({length:11},(_,index)=>({id:`player_${index}`,name:`Player ${index}`,teamId:index<6?'humans':'bots',kind:index<6?'human' as const:'ai' as const,color:'#0072f5'}));
    const sim=createSimulation({matchId:'eleven_assistants',seed:'eleven-assistants',controllers:false,factions});
    for(const faction of factions)if(faction.kind==='human')sim.configureAssistant(faction.id,preferences(`model_${faction.id}`));else sim.setAiModel(faction.id,`model_${faction.id}`);
    expect(sim.aiSchedulingState().commanders).toHaveLength(11);expect(new Set(sim.aiSchedulingState().commanders.map(commander=>commander.modelId)).size).toBe(11);
    expect(sim.state.factions.filter(faction=>faction.kind==='human')).toHaveLength(6);expect(sim.state.factions.filter(faction=>faction.kind==='ai')).toHaveLength(5);
    expect(validateSimulationSavePayload(sim.capture())).toBe(true);
  });
  it('keeps assisted humans in human seats and gives each AI a selectable binding',()=>{
    const {sim}=fixture();sim.configureAssistant('human',preferences());sim.setAiModel('bot','external');
    expect(sim.state.factions.map(faction=>faction.kind)).toEqual(['human','ai','ai']);
    expect(sim.aiSchedulingState().commanders.map(({playerId,modelId})=>({playerId,modelId}))).toEqual([{playerId:'human',modelId:'personal'},{playerId:'bot',modelId:'external'},{playerId:'other',modelId:'host'}]);
    install(sim);expect(sim.assistantState('human').status).toBe('model');
    expect(()=>sim.configureAssistant('bot',preferences())).toThrow('INVALID_HUMAN_SLOT');
    expect(()=>sim.setAiModel('human','external')).toThrow('INVALID_AI_SLOT');
  });
  it('isolates human sequence and deduplication from assistant purchases',()=>{
    const {sim,home,worker}=fixture();sim.configureAssistant('human',preferences());
    const ai=envelope(sim,1,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'same_id');
    expect(sim.command('human',ai,'ai').status).toBe('accepted');expect(sim.command('human',ai,'ai').status).toBe('accepted');expect(home.queue).toHaveLength(1);
    expect(sim.view('human').self.lastCommandSequence).toBe(0);
    const human=envelope(sim,1,{kind:'stop',unitIds:[worker.id]},'same_id');
    expect(sim.command('human',human).status).toBe('accepted');expect(sim.command('human',human).status).toBe('accepted');
    expect(sim.view('human').self.lastCommandSequence).toBe(1);expect(sim.state.control.human!.assistant!.sequence).toBe(1);
  });
  it('protects manual workers and producers even before assistance is enabled',()=>{
    const {sim,home,worker}=fixture();expect(send(sim,{kind:'stop',unitIds:[worker.id]}).status).toBe('accepted');expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');
    sim.configureAssistant('human',preferences());
    expect(send(sim,{kind:'move',unitIds:[worker.id],target:{xMm:worker.xMm+1000,zMm:worker.zMm},queued:false},'ai').code).toBe('MANUAL_CONTROL');
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai').code).toBe('MANUAL_CONTROL');
    expect(send(sim,{kind:'cancel_job',buildingId:home.id,jobId:home.queue[0]!.id},'ai').code).toBe('MANUAL_CONTROL');
    sim.releaseAssistantEntities('human',[worker.id,home.id]);expect(send(sim,{kind:'stop',unitIds:[worker.id]},'ai').status).toBe('accepted');
    expect(()=>sim.releaseAssistantEntities('human',[Object.values(sim.state.entities).find(entity=>entity.ownerId==='bot')!.id])).toThrow('INVALID_REFERENCE');
  });
  it('releases completed ordinary orders after grace but retains Stop/Hold',()=>{
    const {sim,worker,scout}=fixture();sim.configureAssistant('human',preferences());
    expect(send(sim,{kind:'move',unitIds:[scout.id],target:{xMm:scout.xMm,zMm:scout.zMm},queued:false}).status).toBe('accepted');
    expect(send(sim,{kind:'hold_position',unitIds:[worker.id]}).status).toBe('accepted');
    sim.step(5*balance.rules.simulationHz+5);
    expect(sim.assistantState('human').protectedEntityIds).not.toContain(scout.id);expect(sim.assistantState('human').protectedEntityIds).toContain(worker.id);
  });
  it('reserves money for manual spending and requires explicit garrison and surrender',()=>{
    const {sim,worker,home}=fixture();const food=sim.view('human').self.resources.food;sim.configureAssistant('human',preferences('personal',true,food));
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai').code).toBe('INSUFFICIENT_RESOURCES');expect(home.queue).toHaveLength(0);
    expect(send(sim,{kind:'garrison',unitIds:[worker.id],targetId:home.id,queued:false},'ai').code).toBe('MANUAL_ACTION_REQUIRED');expect(send(sim,{kind:'surrender'},'ai').code).toBe('MANUAL_ACTION_REQUIRED');
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');
  });
  it('keeps reserves for an accepted repair after assistance pauses while allowing a manual repair override',()=>{
    const {sim,worker,home}=fixture();sim.configureAssistant('human',preferences('personal',true,75));
    worker.xMm=home.xMm+buildings.town_center.footprintCells[0]*1000+850;worker.zMm=home.zMm;worker.path=[];worker.autoGather=false;home.hp-=100;
    sim.state.economies.human!.resources.wood=75000;sim.step();
    expect(send(sim,{kind:'repair',unitIds:[worker.id],targetId:home.id,queued:false},'ai').status).toBe('accepted');
    sim.configureAssistant('human',preferences('personal',false,75));sim.step(40);
    expect(worker.orders[0]?.kind).toBe('repair');expect(sim.state.economies.human!.resources.wood).toBe(75000);expect(home.hp).toBe(home.maxHp-100);
    expect(send(sim,{kind:'repair',unitIds:[worker.id],targetId:home.id,queued:false}).status).toBe('accepted');sim.step(20);
    expect(sim.state.economies.human!.resources.wood).toBeLessThan(75000);expect(home.hp).toBeGreaterThan(home.maxHp-100);
  });
  it('keeps automatic reseed reserves after assistance pauses while permitting the owner to reseed explicitly',()=>{
    const {sim,worker,home}=fixture(),definition=buildings.farm;
    const farm:Building={...structuredClone(home),id:'reserve_farm',typeId:'farm',xMm:home.xMm-16000,zMm:home.zMm-14000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,required:definition.buildSeconds*balance.rules.simulationHz*100,work:definition.buildSeconds*balance.rules.simulationHz*100,foodRemaining:0,queue:[]};
    sim.state.entities[farm.id]=farm;sim.state.navigationRevision++;worker.xMm=farm.xMm+definition.footprintCells[0]*1000+850;worker.zMm=farm.zMm;worker.path=[];worker.autoGather=false;sim.step();
    sim.configureAssistant('human',preferences('personal',true,75));sim.state.economies.human!.resources.wood=100000;
    expect(send(sim,{kind:'set_auto_reseed',enabled:true},'ai').status).toBe('accepted');expect(send(sim,{kind:'gather',unitIds:[worker.id],targetId:farm.id,queued:false},'ai').status).toBe('accepted');
    sim.configureAssistant('human',preferences('personal',false,75));sim.step(20);
    expect(farm.reseedRequired).toBeUndefined();expect(sim.state.economies.human!.resources.wood).toBe(100000);
    const reseed=send(sim,{kind:'reseed_farm',farmId:farm.id,builderId:worker.id});expect(reseed.status,reseed.code).toBe('accepted');expect(farm.reseedRequired).toBeGreaterThan(0);expect(sim.state.economies.human!.resources.wood).toBe(40000);
  });
  it('invalidates only affected model generations and clears unpaid work',()=>{
    const {sim}=fixture();sim.configureAssistant('human',preferences());install(sim,'bot');install(sim,'other');
    const pending=sim.prepareAiRequest('bot','pending'),other=structuredClone(sim.state.controllers.other);sim.state.controllers.bot!.pending.push({observedTick:0,executeTick:10,commands:[{kind:'set_auto_reseed',enabled:true}]});
    sim.setAiModel('bot','different');expect(sim.completeAiRequest(pending.binding,{kind:'failure',code:'TIMEOUT'}).code).toBe('STALE_AI_RESPONSE');expect(sim.state.controllers.bot!.pending).toEqual([]);expect(sim.state.controllers.bot!.plan).toBeUndefined();expect(sim.state.controllers.other).toEqual(other);
    install(sim);sim.invalidateAiRequests('CONFIG_CHANGED',['human']);expect(sim.state.controllers.human!.plan).toBeUndefined();expect(sim.state.controllers.other).toEqual(other);
  });
  it('pauses assistance without cancelling paid jobs and excludes disconnected caretakers',()=>{
    const {sim,home}=fixture();sim.configureAssistant('human',preferences());send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai');const job=structuredClone(home.queue),request=sim.prepareAiRequest('human','pending');
    sim.configureAssistant('human',preferences('personal',false));expect(home.queue).toEqual(job);expect(sim.completeAiRequest(request.binding,{kind:'failure',code:'TIMEOUT'}).code).toBe('STALE_AI_RESPONSE');expect(sim.assistantState('human').status).toBe('paused');
    sim.configureAssistant('human',preferences());sim.setControlMode('human','caretaker');expect(sim.aiSchedulingState().commanders.some(commander=>commander.playerId==='human')).toBe(false);expect(()=>sim.prepareAiRequest('human','absent')).toThrow('AI_UNAVAILABLE');
    sim.setControlMode('human','human');expect(sim.aiSchedulingState().commanders.some(commander=>commander.playerId==='human')).toBe(true);
  });
  it('runs real fallback decisions around a human-held worker without borrowing the human sequence',()=>{
    const {sim,worker}=fixture(true);sim.configureAssistant('human',preferences());
    expect(send(sim,{kind:'hold_position',unitIds:[worker.id]}).status).toBe('accepted');sim.step(60);
    expect(sim.state.control.human!.assistant!.sequence).toBeGreaterThan(0);
    expect(sim.state.commandLog.some(row=>row.playerId==='human'&&row.envelope.clientCommandId.startsWith('ai_'))).toBe(true);
    expect(worker.orders).toEqual([]);expect(worker.stance).toBe('stand_ground');expect(sim.state.economies.human!.lastClientSequence).toBe(1);
    expect(sim.state.economies.human!.statistics.fallbackTicks).toBe(60);
    expect(validateSimulationSavePayload(sim.capture())).toBe(true);
  });
  it('counts manually controlled units toward model goals while assigning only available units',()=>{
    const {sim,worker,home}=fixture(true);sim.configureAssistant('human',preferences());send(sim,{kind:'hold_position',unitIds:[worker.id]});
    const villagers=Object.values(sim.state.entities).filter(entity=>entity.ownerId==='human'&&entity.typeId==='villager').length,request=sim.prepareAiRequest('human','counts');
    expect(sim.completeAiRequest(request.binding,{kind:'plan',plan:{schemaVersion:1,observationId:request.binding.observationId,strategy:'Keep our existing worker count.',goals:[{kind:'ensure_units',unitType:'villager',targetCount:villagers}],message:null}}).accepted).toBe(true);
    sim.step(10);expect(sim.state.controllers.human!.plan!.goals[0]!.status).toBe('fulfilled');
    expect(worker.orders).toEqual([]);expect(home.queue.filter(job=>job.kind==='train'&&job.typeId==='villager').length).toBeLessThanOrEqual(1);
  });
  it('preserves manual production rally travel when the trained unit appears',()=>{
    const {sim,home}=fixture();sim.configureAssistant('human',preferences());
    expect(send(sim,{kind:'set_rally',buildingId:home.id,target:{xMm:home.xMm+20000,zMm:home.zMm}}).status).toBe('accepted');
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');
    const before=new Set(Object.keys(sim.state.entities));home.queue[0]!.work=home.queue[0]!.required-1;sim.step();
    const spawned=Object.values(sim.state.entities).find(entity=>entity.kind==='unit'&&!before.has(entity.id)) as Unit;
    expect(spawned).toBeDefined();expect(spawned.orders[0]?.manualOrder).toBe(true);expect(sim.assistantState('human').protectedEntityIds).toContain(spawned.id);
    expect(send(sim,{kind:'stop',unitIds:[spawned.id]},'ai').code).toBe('MANUAL_CONTROL');
  });
  it('manual cancellation invalidates stale plans and prevents recreating the cancelled producer job',()=>{
    const {sim,home}=fixture();sim.configureAssistant('human',preferences());send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai');install(sim);
    const pending=sim.prepareAiRequest('human','before_cancel');
    expect(send(sim,{kind:'cancel_job',buildingId:home.id,jobId:home.queue[0]!.id}).status).toBe('accepted');
    expect(sim.state.controllers.human!.plan).toBeUndefined();expect(sim.completeAiRequest(pending.binding,{kind:'failure',code:'TIMEOUT'}).code).toBe('STALE_AI_RESPONSE');
    expect(send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai').code).toBe('MANUAL_CONTROL');expect(home.queue).toEqual([]);
  });
  it('rejects forged saved assistant bindings, foreign protections and authority on a bot',()=>{
    const {sim}=fixture();sim.configureAssistant('human',preferences());install(sim);
    const badBinding=sim.capture();badBinding.state.control.human!.assistant!.preferences.modelId=null;expect(validateSimulationSavePayload(badBinding)).toBe(false);
    const foreign=sim.capture();foreign.state.control.human!.assistant!.protectedEntityIds.push(Object.values(sim.state.entities).find(entity=>entity.ownerId==='bot')!.id);expect(validateSimulationSavePayload(foreign)).toBe(false);
    const bot=sim.capture();bot.state.control.bot!.assistant=structuredClone(bot.state.control.human!.assistant!);expect(validateSimulationSavePayload(bot)).toBe(false);
  });
  it('persists and replays assistance authority and model selection without inference',()=>{
    const {sim,worker,home}=fixture();sim.configureAssistant('human',preferences());sim.setAiModel('bot','chosen');install(sim);send(sim,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1},'ai');send(sim,{kind:'hold_position',unitIds:[worker.id]});sim.setStatus('PAUSED');
    expect(validateSimulationSavePayload(sim.capture())).toBe(true);
    const exact=restoreSimulation(exportSimulationSave(sim,identity),identity,{preserveEpoch:true});expect(exact.capture()).toEqual(sim.capture());
    const restored=restoreSimulation(exportSimulationSave(sim,identity),identity);expect(restored.assistantState('human').preferences).toEqual(preferences());expect(restored.assistantState('human').protectedEntityIds).toContain(worker.id);expect(restored.state.factions[1]!.aiModelId).toBe('chosen');
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('NO_NETWORK'));try{const replay=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(replay.advanceTo(0).done).toBe(true);expect(replay.simulation.capture()).toEqual(sim.capture());expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
  });
  it('native human admission applies the same protections as scalar commands',()=>{
    const {sim,worker}=fixture();sim.configureAssistant('human',preferences());const channel=new MessageChannel();
    try{sim.drainNativeCommands(createNativeCommandBatch(channel.port1,[{id:1,playerId:'human',command:envelope(sim,1,{kind:'stop',unitIds:[worker.id]})}]));expect(receiveMessageOnPort(channel.port2)?.message.value.status).toBe('accepted');expect(sim.assistantState('human').protectedEntityIds).toContain(worker.id);expect(send(sim,{kind:'stop',unitIds:[worker.id]},'ai').code).toBe('MANUAL_CONTROL');}finally{channel.port1.close();channel.port2.close();}
  });
});
