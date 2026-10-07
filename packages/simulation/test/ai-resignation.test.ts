import { beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { balance, buildings, units, validatePlayerView, type BuildingId, type PublicPlayer, type UnitId } from '@frontier/shared';
import { Simulation, createSimulation, createLiveSimulation, exportSimulationSave, restoreSimulation, sealSimulationCapture, exportReplay, replayCheckpoint, ReplayRunner, type Building, type Unit, type SimulationSavePayload, type EngineIdentity } from '../src/index.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { hydrateNativeCheckpointMessage } from '../src/checkpoint-native.js';

const grace=balance.ai.resignation.graceSeconds*balance.rules.simulationHz;
const identity:EngineIdentity={engineBuildHash:'e'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const factions:PublicPlayer[]=[
  {id:'a',name:'Human',teamId:'blue',kind:'human',color:'#3388ff'},
  {id:'b',name:'Remnant',teamId:'red',kind:'ai',color:'#ee5533'},
  {id:'c',name:'Ally',teamId:'green',kind:'ai',color:'#22aa66'},
  {id:'d',name:'Other human',teamId:'purple',kind:'human',color:'#aa33cc'},
];
let initial:SimulationSavePayload;
function unit(typeId:UnitId,ownerId='b',id='extra_unit'):Unit{
  const definition=units[typeId];
  return {id,kind:'unit',typeId,ownerId,xMm:220000,zMm:220000,hp:definition.maxHp,maxHp:definition.maxHp,orders:[],path:[],pathRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',autoGather:false};
}
function building(typeId:BuildingId,ownerId='b',id='extra_building'):Building{
  const definition=buildings[typeId],required=definition.buildSeconds*balance.rules.simulationHz*100;
  return {id,kind:'building',typeId,ownerId,xMm:260000,zMm:240000,hp:definition.maxHp,maxHp:definition.maxHp,grantedHp:definition.maxHp,rotation:0,work:required,required,queue:[],cooldown:0};
}
beforeAll(()=>{
  const sim=createSimulation({seed:'resignation',matchId:'resignation',factions,controllers:false,sharedVision:false,rulesetId:'legendary_ages_v1',maxAge:8});
  sim.state.entities={home:building('town_center','a','home'),scout:unit('scout','b','scout')};
  sim.state.entities.home!.xMm=30000;sim.state.entities.home!.zMm=30000;
  sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.visible=[];vision.explored=[];vision.actions={};}
  sim.step();
  delete sim.state.economies.b!.aiResignationSinceTick;
  initial=sim.capture();
});
function fixture(edit?:(payload:SimulationSavePayload)=>void):Simulation{
  const payload=structuredClone(initial);edit?.(payload);
  return new Simulation({...payload.options,factions:payload.state.factions,matchId:payload.state.matchId},payload);
}
function dueSoon(sim:Simulation):void{
  sim.state.tick=grace-1;sim.state.economies.b!.aiResignationSinceTick=0;
}
function revive(payload:SimulationSavePayload,id:string,teamId:string,kind:'ai'|'human'='ai'):void{
  const faction=payload.state.factions.find(f=>f.id===id)!;faction.teamId=teamId;faction.kind=kind;
  payload.state.economies[id]!.defeated=false;payload.state.control[id]!.mode=kind;
  payload.state.entities[`scout_${id}`]=unit('scout',id,`scout_${id}`);
}

describe('conservative native-AI resignation',()=>{
  it('gives the last idle Scout the complete grace period, then ends conquest and cancels its commander',()=>{
    const sim=fixture();sim.step();const since=sim.state.economies.b!.aiResignationSinceTick!;
    expect(since).toBe(sim.state.tick);expect(sim.state.economies.b!.defeated).toBe(false);
    sim.step(grace-1);expect(sim.state.status).toBe('RUNNING');expect(sim.state.economies.b!.defeated).toBe(false);
    const generation=sim.state.controllers.b!.generation;
    sim.step();expect(sim.state.tick).toBe(since+grace);expect(sim.state.result).toMatchObject({winnerTeamId:'blue',reason:'conquest',durationTicks:since+grace});
    expect(sim.state.controllers.b!.generation).toBeGreaterThan(generation);expect(sim.state.controllers.b!.pending).toEqual([]);
    expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();expect(sim.state.entities.scout).toBeDefined();
    expect(sim.state.entities.scout).toMatchObject({orders:[],path:[]});
  });
  it.each(['villager','militia','knight','trebuchet','crown_colossus'] as const)('preserves a surviving %s, regardless of low HP or idle orders',type=>{
    const sim=fixture();sim.state.entities.extra=unit(type);sim.state.entities.extra.hp=1;dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it('preserves a second Scout rather than treating a larger remnant as defeated',()=>{
    const sim=fixture();sim.state.entities.extra=unit('scout');dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it.each(['town_center','barracks','stable','watchtower','fortress','grand_citadel','monument'] as const)('preserves surviving %s recovery, defenses or victory opportunities',type=>{
    const sim=fixture();sim.state.entities.extra=building(type);sim.state.navigationRevision++;dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it.each([false,true])('preserves an unfinished producer (planned site: %s)',planned=>{
    const sim=fixture(),site=building('town_center');site.work=0;site.hp=1;site.grantedHp=1;
    if(planned)site.pendingConstruction={clearanceMm:0};sim.state.entities.extra=site;sim.state.navigationRevision++;dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it('counts military passengers inside a garrison as surviving fighting units',()=>{
    const sim=fixture(),host=building('fortress'),passenger=unit('spearman');host.garrisoned=[passenger.id];passenger.garrisonedIn=host.id;
    sim.state.entities[host.id]=host;sim.state.entities[passenger.id]=passenger;sim.state.navigationRevision++;dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);
  });
  it.each(['house','farm','lumber_camp','stone_wall','stone_gate'] as const)('does not let an unproductive %s preserve a lone Scout indefinitely',type=>{
    const sim=fixture();sim.state.entities.extra=building(type);sim.state.navigationRevision++;dueSoon(sim);sim.step();
    expect(sim.state.result?.winnerTeamId).toBe('blue');expect(sim.state.economies.b!.defeated).toBe(true);
  });
  it('resets grace after recovery and starts a new full period after recovery is lost',()=>{
    const sim=fixture();dueSoon(sim);sim.state.entities.worker=unit('villager','b','worker');sim.step();
    expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();sim.state.entities.worker.hp=0;sim.step();
    expect(sim.state.economies.b!.aiResignationSinceTick).toBe(sim.state.tick);expect(sim.state.economies.b!.defeated).toBe(false);
  });
  it.each(['human','disconnected','caretaker'] as const)('never automatically surrenders a human slot in %s control mode',mode=>{
    const sim=fixture(payload=>{payload.state.factions.find(f=>f.id==='b')!.kind='human';payload.state.control.b!.mode=mode;});
    dueSoon(sim);sim.step(2);expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it('never automatically surrenders a human AI Pilot',()=>{
    const sim=fixture(payload=>{payload.state.factions.find(f=>f.id==='b')!.kind='human';payload.state.control.b!.mode='human';});
    sim.configureAssistant('b',{enabled:true,modelId:'host',reserve:{food:0,wood:0,gold:0,stone:0}});dueSoon(sim);sim.step(2);
    expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it.each(['ai','human'] as const)('preserves the remnant while its %s teammate can continue',kind=>{
    const sim=fixture(payload=>{revive(payload,'c','red',kind);if(kind==='ai')payload.state.entities.worker_c=unit('villager','c','worker_c');});
    dueSoon(sim);sim.step(2);expect(sim.state.economies.b!.defeated).toBe(false);expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();
  });
  it('resigns an all-remnant AI team together instead of having its Scouts protect each other forever',()=>{
    const sim=fixture(payload=>revive(payload,'c','red'));dueSoon(sim);sim.state.economies.c!.aiResignationSinceTick=0;sim.step();
    expect(sim.state.economies.b!.defeated).toBe(true);expect(sim.state.economies.c!.defeated).toBe(true);expect(sim.state.result?.winnerTeamId).toBe('blue');
  });
  it('resets the entire remnant team grace when a teammate recovers',()=>{
    const sim=fixture(payload=>revive(payload,'c','red'));dueSoon(sim);sim.state.economies.c!.aiResignationSinceTick=0;
    sim.state.entities.worker_c=unit('villager','c','worker_c');sim.step();
    expect(sim.state.economies.b!.aiResignationSinceTick).toBeUndefined();expect(sim.state.economies.c!.aiResignationSinceTick).toBeUndefined();
    sim.state.entities.worker_c.hp=0;sim.step();
    expect(sim.state.economies.b!.aiResignationSinceTick).toBe(sim.state.tick);expect(sim.state.economies.c!.aiResignationSinceTick).toBe(sim.state.tick);
  });
  it('draws when opposing AI remnants resign on the same tick',()=>{
    const sim=fixture(payload=>{delete payload.state.entities.home;revive(payload,'a','blue');});dueSoon(sim);sim.state.economies.a!.aiResignationSinceTick=0;sim.step();
    expect(sim.state.result).toMatchObject({winnerTeamId:null,reason:'simultaneous_elimination'});
  });
  it('does not advance grace while paused, or resurrect a finished match',()=>{
    const sim=fixture();dueSoon(sim);sim.setStatus('PAUSED');const tick=sim.state.tick;sim.step(grace);expect(sim.state.tick).toBe(tick);
    sim.setStatus('RUNNING');sim.step();const result=structuredClone(sim.state.result);sim.step(grace);expect(sim.state.result).toEqual(result);
  });
  it('keeps grace private and bases it on its own team rather than hidden enemy strength',()=>{
    const left=fixture(),right=fixture();right.state.entities.hidden=unit('knight','a','hidden');right.state.entities.hidden.xMm=60000;right.state.entities.hidden.zMm=60000;
    left.step();right.step();expect(left.state.economies.b!.aiResignationSinceTick).toBe(right.state.economies.b!.aiResignationSinceTick);
    const view=left.view('a');expect(validatePlayerView(view)).toBe(true);expect(JSON.stringify(view)).not.toContain('aiResignation');expect(view.entities.some(e=>e.ownerId==='b')).toBe(false);
    expect(view.players.find(f=>f.id==='b')!.defeated).toBe(false);
  });
});

describe('resignation persistence and execution cadences',()=>{
  it('retains the active timer in native checkpoints without aliasing subsequent progress',async()=>{
    const sim=fixture(payload=>{payload.options.authoritativeIntervalMs=300;payload.state.tick=grace/2;payload.state.economies.b!.aiResignationSinceTick=0;});
    const live=createLiveSimulation({...sim.options,factions:sim.state.factions,matchId:sim.state.matchId},sim.capture()),channel=new MessageChannel();
    try{
      await live.synchronizeCapture();const before=live.capture(),incoming=once(channel.port2,'message');
      expect(live.postNativeCapture(channel.port1,{type:'checkpoint',autosave:true})).toBe(true);
      live.advanceFrame();const received=hydrateNativeCheckpointMessage((await incoming)[0]) as {payload:SimulationSavePayload};
      expect(received.payload).toEqual(before);expect(received.payload.state.economies.b!.aiResignationSinceTick).toBe(0);
      const cold=restoreSimulation(sealSimulationCapture(received.payload,identity),identity,{preserveEpoch:true});
      cold.advanceFrame();await cold.synchronizeCapture();await live.synchronizeCapture();
      expect(cold.capture().state.economies).toEqual(live.capture().state.economies);
    }finally{channel.port1.close();channel.port2.close();}
  });
  it('retains an optional grace timer through cold saves and rejects invalid or human timers',()=>{
    const sim=fixture();dueSoon(sim);sim.state.tick=grace/2;
    const save=exportSimulationSave(sim,identity),restored=restoreSimulation(save,identity,{preserveEpoch:true});
    expect(restored.capture()).toEqual(sim.capture());
    for(const candidate of [sim,restored]){candidate.state.tick=grace-1;candidate.step();}
    expect(restored.capture()).toEqual(sim.capture());expect(restored.state.result?.winnerTeamId).toBe('blue');
    expect(validateSimulationSavePayload(initial)).toBe(true);
    for(const value of [-1,.5,grace]){const invalid=structuredClone(save.payload);invalid.state.economies.b!.aiResignationSinceTick=value;expect(validateSimulationSavePayload(invalid)).toBe(false);}
    const human=structuredClone(save.payload);human.state.economies.a!.aiResignationSinceTick=0;expect(validateSimulationSavePayload(human)).toBe(false);
    const defeated=structuredClone(save.payload);defeated.state.economies.b!.defeated=true;expect(validateSimulationSavePayload(defeated)).toBe(false);
  });
  it.each([50,300,450,600] as const)('preserves the exact grace deadline and replay at %s ms frames',async interval=>{
    const sim=fixture(payload=>{payload.options.authoritativeIntervalMs=interval===50?50:300;payload.state.movementCadenceTier=interval===450?1:interval===600?2:0;payload.state.tick=grace-13;payload.state.economies.b!.aiResignationSinceTick=0;});
    const start=sealSimulationCapture(sim.capture(),identity),live=createLiveSimulation({...sim.options,factions:sim.state.factions,matchId:sim.state.matchId},start.payload);
    while(sim.state.status==='RUNNING')sim.advanceFrame();
    await sim.synchronizeCapture();
    while(live.view('a').status==='RUNNING')live.advanceFrame();
    await live.synchronizeCapture();
    expect(sim.state.result).toMatchObject({durationTicks:grace,winnerTeamId:'blue'});expect(live.capture().state.result).toEqual(sim.state.result);
    expect(live.capture().state.economies).toEqual(sim.state.economies);expect(live.view('a').players).toEqual(sim.view('a').players);
    const replay=new ReplayRunner(exportReplay(sim,identity,[replayCheckpoint(sim)]),identity);expect(replay.advanceTo(grace).done).toBe(true);
    expect(replay.simulation.capture()).toEqual(sim.capture());
  });
});
