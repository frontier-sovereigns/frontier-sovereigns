import { describe, expect, it, vi } from 'vitest';
import { balance, buildings, units, type GameplayCommand, type PublicPlayer, type UnitId, type BuildingId } from '@frontier/shared';
import { createSimulation, exportSimulationSave, restoreSimulation, restoreLiveSimulation, sealSimulationCapture, assertValidSave, validateSave, simulationChecksum, replayCheckpoint, exportReplay, ReplayRunner, createReplayRecording, type Building, type EngineIdentity, type Simulation, type Unit } from '../src/index.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';

const identity:EngineIdentity={engineBuildHash:'1'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const factions:PublicPlayer[]=[{id:'blue',name:'Blue',teamId:'blue',kind:'human',color:'#3388ff'},{id:'red',name:'Red',teamId:'red',kind:'human',color:'#ee5533'}];
function simulation(ai=false){return createSimulation({factions:ai?factions.map(f=>({...f,kind:'ai' as const,difficulty:'medium' as const})):factions,seed:'m5-persistence',matchId:'persistence',controllers:ai,sharedVision:false,monumentVictory:true,caretakerEnabled:true});}
function send(sim:Simulation,command:GameplayCommand,playerId='blue'){const sequence=sim.state.economies[playerId]!.lastClientSequence+1;return sim.command(playerId,{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`${playerId}_${sequence}`,clientSequence:sequence,command});}
function roundTrip(sim:Simulation,preserveEpoch=true){const save=JSON.parse(JSON.stringify(exportSimulationSave(sim,identity)));expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);return restoreSimulation(save,identity,{preserveEpoch});}
function compare(a:Simulation,b:Simulation){expect(JSON.stringify(b.capture())).toBe(JSON.stringify(a.capture()));for(const faction of a.state.factions)expect(b.view(faction.id)).toEqual(a.view(faction.id));}

describe('M5 consistent state capture and restoration',()=>{
  it('checks save integrity without a discarded copy and preserves the public detached snapshot',()=>{
    const original=simulation(),save=exportSimulationSave(original,identity),encoded=JSON.stringify(save),clone=vi.spyOn(globalThis,'structuredClone');
    try{
      expect(assertValidSave(save,identity)).toBeUndefined();expect(clone).not.toHaveBeenCalled();expect(JSON.stringify(save)).toBe(encoded);
      const detached=validateSave(save,identity);expect(detached).toEqual(save.payload);expect(detached).not.toBe(save.payload);
      save.payload.state.tick=123;save.payload.state.economies.blue!.resources.wood=0;
      expect(detached.state.tick).toBe(0);expect(detached.state.economies.blue!.resources.wood).toBeGreaterThan(0);
      expect(original.state.tick).toBe(0);expect(original.state.economies.blue!.resources.wood).toBeGreaterThan(0);
    }finally{clone.mockRestore();}
  });
  it('rejects the same corrupt or incompatible save in assertion and snapshot validation',()=>{
    const save=exportSimulationSave(simulation(),identity),corrupt=structuredClone(save);corrupt.payload.state.tick++;
    const wrongContent=structuredClone(save.payload);wrongContent.contentHash='0'.repeat(64);
    const invalidPayload=structuredClone(save.payload);invalidPayload.state.tick=-1;
    const invalidExtra={...save,extra:true};
    const cases:[unknown,EngineIdentity,string][]=[
      [corrupt,identity,'SAVE_CHECKSUM_MISMATCH'],[save,{...identity,engineBuildHash:'2'.repeat(64)},'ENGINE_VERSION_MISMATCH'],
      [save,{...identity,runtimeProfile:{...identity.runtimeProfile,nodeVersion:'unsupported'}},'ENGINE_RUNTIME_MISMATCH'],
      [sealSimulationCapture(wrongContent,identity),identity,'CONTENT_VERSION_MISMATCH'],[sealSimulationCapture(invalidPayload,identity),identity,'INVALID_SAVE_PAYLOAD'],
      [invalidExtra,identity,'INVALID_SAVE'],
    ];
    for(const [input,expectedIdentity,code]of cases)for(const check of [assertValidSave,validateSave])expect(()=>check(input,expectedIdentity)).toThrow(code);
  });
  it('preserves the authoritative movement cadence through cold restore and fixed-tick continuation',()=>{
    const original=simulation();expect(original.state.movementCadenceTier).toBe(0);
    for(const tier of [1,2,3,0] as const){
      original.setMovementCadenceTier(tier);const ordinal=original.state.eventOrdinal;original.setMovementCadenceTier(tier);expect(original.state.eventOrdinal).toBe(ordinal);
      const restored=roundTrip(original);expect(restored.state.movementCadenceTier).toBe(tier);compare(original,restored);
      const live=restoreLiveSimulation(exportSimulationSave(original,identity),identity,{preserveEpoch:true});expect(live.state.movementCadenceTier).toBe(tier);
      for(let tick=0;tick<3;tick++){original.step();restored.step();live.step();compare(original,restored);expect(live.capture()).toEqual(original.capture());}
    }
    const before=original.capture();for(const tier of [-1,4,.5,NaN,Infinity])expect(()=>original.setMovementCadenceTier(tier as 0)).toThrow();expect(original.capture()).toEqual(before);
    original.setMovementCadenceTier(3);const paused=restoreSimulation(exportSimulationSave(original,identity),identity);expect(paused.state.movementCadenceTier).toBe(3);expect(paused.state.status).toBe('PAUSED');
  });
  it('restores a private live owner with the same epoch, status, command history and continuation',()=>{
    const original=simulation();original.step(3);const save=exportSimulationSave(original,identity);
    for(const options of [{},{preserveEpoch:true},{newEpoch:5000000}] as const){
      const expected=restoreSimulation(save,identity,options),actual=restoreLiveSimulation(save,identity,options);
      expect(actual.capture()).toEqual(expected.capture());expect(actual.journalEvents()).toEqual(expected.journalEvents());
      expect(()=>{actual.state.tick=999;}).toThrow('LIVE_SIMULATION_READ_ONLY');
      actual.setStatus('RUNNING');expected.setStatus('RUNNING');
      for(let tick=0;tick<4;tick++){actual.step();expected.step();expect(actual.capture()).toEqual(expected.capture());expect(actual.view('blue')).toEqual(expected.view('blue'));}
      expect(validateSave(exportSimulationSave(actual,identity),identity)).toEqual(actual.capture());
    }
    const corrupt=structuredClone(save);corrupt.payload.state.tick++;
    expect(()=>restoreLiveSimulation(corrupt,identity)).toThrow('SAVE_CHECKSUM_MISMATCH');expect(()=>restoreLiveSimulation(save,identity,{newEpoch:0})).toThrow('INVALID_RESTORE_EPOCH');
    original.endAsDraw();expect(()=>restoreLiveSimulation(exportSimulationSave(original,identity),identity,{status:'RUNNING'})).toThrow('FINISHED_SAVE_CANNOT_RESUME');
  });
  it('round-trips before any navigation profile has been initialized without rebuilding vision or map state',()=>{
    const original=simulation(),restored=roundTrip(original);expect(original.capture().runtime.planningProfiles.every(([,profile])=>profile.revision===0)).toBe(true);compare(original,restored);
    for(let tick=0;tick<5;tick++){original.step();restored.step();compare(original,restored);}
  });
  it('restores into a fresh paused epoch by default and resets only the epoch-scoped command highwater',()=>{
    const original=simulation(),home=Object.values(original.state.entities).find((e):e is Building=>e.kind==='building'&&e.ownerId==='blue'&&e.typeId==='town_center')!;send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});original.step(3);const restored=roundTrip(original,false);
    expect(restored.state.matchEpoch).toBe(original.state.matchEpoch+1);expect(restored.state.status).toBe('PAUSED');expect(restored.view('blue').self.lastCommandSequence).toBe(0);expect(restored.state.entities).toEqual(original.state.entities);restored.step(10);expect(restored.state.tick).toBe(original.state.tick);restored.setStatus('RUNNING');expect(send(restored,{kind:'set_rally',buildingId:home.id,target:{xMm:home.xMm+10000,zMm:home.zMm}}).status).toBe('accepted');
  });
  it('loads an old save into a higher live gateway epoch using one replayable advancement event',()=>{
    const original=simulation(),restored=restoreSimulation(exportSimulationSave(original,identity),identity,{newEpoch:5000000});expect(restored.state.matchEpoch).toBe(5000000);expect(restored.journalEvents().map(event=>event.kind)).toEqual(['epoch','status']);expect(restored.state.eventOrdinal).toBe(original.state.eventOrdinal+2);const runner=new ReplayRunner(exportReplay(restored,identity,[replayCheckpoint(restored)]),identity);expect(runner.advanceTo(0).done).toBe(true);compare(restored,runner.simulation);
    expect(()=>restoreSimulation(exportSimulationSave(original,identity),identity,{newEpoch:2147483648})).toThrow('INVALID_RESTORE_EPOCH');
  });
  it.each(['draw','conquest'] as const)('keeps a terminal %s save finished and rejects every nonterminal restore override',outcome=>{
    const original=simulation();original.step(5);if(outcome==='draw')original.endAsDraw();else original.adminSurrender('red');
    const save=exportSimulationSave(original,identity),restored=restoreSimulation(save,identity);
    expect(restored.state.status).toBe('FINISHED');expect(restored.state.result).toEqual(original.state.result);expect(restored.state.result!.reason).toBe(outcome==='draw'?'administrative_draw':'conquest');expect(restored.state.matchEpoch).toBe(original.state.matchEpoch+1);
    const before=restored.capture();restored.step(100);expect(restored.capture()).toEqual(before);expect(restored.view('blue').status).toBe('FINISHED');expect(send(restored,{kind:'surrender'}).code).toBe('MATCH_FINISHED');
    for(const status of ['LOADING','COUNTDOWN','RUNNING','PAUSED'] as const)for(const preserveEpoch of [false,true])expect(()=>restoreSimulation(save,identity,{status,preserveEpoch})).toThrow('FINISHED_SAVE_CANNOT_RESUME');
    compare(original,restoreSimulation(save,identity,{preserveEpoch:true}));expect(restoreSimulation(save,identity,{status:'FINISHED'}).state.status).toBe('FINISHED');
  });
  it('preserves active economy, paid research, population reservation, route work and ordered caches on every continued tick',()=>{
    const original=simulation(),owned=Object.values(original.state.entities).filter(e=>e.ownerId==='blue'),workers=owned.filter((e):e is Unit=>e.kind==='unit'&&e.typeId==='villager'),home=owned.find((e):e is Building=>e.kind==='building'&&e.typeId==='town_center')!,known=original.view('blue').entities.find(e=>e.kind==='resource'&&e.resource==='wood')!;
    original.state.economies.blue!.age=2;original.state.economies.blue!.resources.food=500000;original.state.economies.blue!.resources.wood=200000;
    send(original,{kind:'research',buildingId:home.id,technologyId:'wheelbarrow'});send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});send(original,{kind:'gather',unitIds:[workers[0]!.id],targetId:known.id,queued:false});send(original,{kind:'move',unitIds:workers.slice(1).map(e=>e.id),target:{xMm:original.state.widthMm/2,zMm:original.state.heightMm/2},queued:false});original.step(25);
    const restored=roundTrip(original);compare(original,restored);expect(original.capture().runtime.pathScheduler.tasks.length+workers.reduce((sum,worker)=>sum+worker.path.length,0)).toBeGreaterThan(0);
    for(let tick=0;tick<120;tick++){original.step();restored.step();compare(original,restored);}
  });
  it('continues flying projectiles, deployment, garrison healing, farm reseeding, repair fractions and gate timers identically',()=>{
    const original=simulation();original.state.entities={};original.state.map.terrain=[];original.state.navigationRevision++;for(const vision of Object.values(original.state.vision)){vision.memory={};vision.explored=[];}
    original.state.economies.blue!.age=4;original.state.economies.blue!.resources={food:1000000,wood:1000000,gold:1000000,stone:1000000};let nonce=0;
    const structure=(typeId:BuildingId,xMm:number,zMm:number,ownerId='blue'):Building=>{const def=buildings[typeId],building:Building={id:`save_building_${++nonce}`,kind:'building',typeId,ownerId,xMm,zMm,rotation:0,hp:def.maxHp,maxHp:def.maxHp,grantedHp:def.maxHp,work:def.buildSeconds*2000,required:def.buildSeconds*2000,queue:[],cooldown:0};original.state.entities[building.id]=building;original.state.navigationRevision++;return building;};
    const unit=(typeId:UnitId,xMm:number,zMm:number,ownerId='blue'):Unit=>{const def=units[typeId],entity:Unit={id:`save_unit_${++nonce}`,kind:'unit',typeId,ownerId,xMm,zMm,hp:def.maxHp,maxHp:def.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',...(typeId==='trebuchet'?{deploymentState:'packed' as const}:{})};original.state.entities[entity.id]=entity;return entity;};
    const home=structure('town_center',30000,30000);structure('town_center',300000,300000,'red');const patient=unit('villager',23000,30000);patient.hp=20;
    const farm=structure('farm',46000,30000),farmer=unit('villager',42000,30000);farm.foodRemaining=0;
    const house=structure('house',40000,46000),repairer=unit('villager',37000,46000);house.hp-=100;house.repairDenominator=600;house.repairRemainders={blue:{food:0,wood:1,gold:0,stone:0}};
    const gate=structure('wooden_gate',66000,30000);gate.gateMode='AUTO';gate.gateOpen=false;unit('scout',65000,34000);
    unit('archer',60000,66000);const victim=unit('knight',65000,66000,'red');victim.cooldown=10000;const trebuchet=unit('trebuchet',85000,66000);original.step();
    expect(send(original,{kind:'garrison',unitIds:[patient.id],targetId:home.id,queued:false}).status).toBe('accepted');expect(send(original,{kind:'reseed_farm',farmId:farm.id,builderId:farmer.id}).status).toBe('accepted');expect(send(original,{kind:'repair',unitIds:[repairer.id],targetId:house.id,queued:false}).status).toBe('accepted');expect(send(original,{kind:'deploy',unitIds:[trebuchet.id]}).status).toBe('accepted');expect(send(original,{kind:'research',buildingId:home.id,technologyId:'wheelbarrow'}).status).toBe('accepted');expect(send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}).status).toBe('accepted');original.step(2);
    expect(original.state.projectiles.length).toBeGreaterThan(0);expect(patient.garrisonedIn).toBe(home.id);expect(trebuchet.deploymentState).toBe('deploying');expect(farm.reseedRequired).toBeGreaterThan(0);expect(gate.gateOpen).toBe(true);
    const restored=roundTrip(original);compare(original,restored);for(let tick=0;tick<buildings.farm.reseedSeconds!*balance.rules.simulationHz+5;tick++){original.step();restored.step();compare(original,restored);}expect((original.state.entities[farm.id] as Building).foodRemaining).toBeGreaterThan(0);expect((original.state.entities[patient.id] as Unit).hp).toBeGreaterThan(20);
  });
  it('rejects corrupt, incompatible and incomplete saves before creating any replacement world',()=>{
    const original=simulation(),save=exportSimulationSave(original,identity),bad=structuredClone(save);bad.payload.state.tick++;expect(()=>restoreSimulation(bad,identity)).toThrow('SAVE_CHECKSUM_MISMATCH');expect(()=>restoreSimulation(save,{...identity,engineBuildHash:'2'.repeat(64)})).toThrow('ENGINE_VERSION_MISMATCH');expect(()=>restoreSimulation(save,{...identity,runtimeProfile:{...identity.runtimeProfile,nodeVersion:'unsupported'}})).toThrow('ENGINE_RUNTIME_MISMATCH');
    const missing=structuredClone(save.payload);delete (missing.runtime as Partial<typeof missing.runtime>).localAvoidance;expect(()=>validateSave(sealSimulationCapture(missing,identity),identity)).toThrow('INVALID_SAVE_PAYLOAD');
    const reordered=structuredClone(save);reordered.payload.state.entities=Object.fromEntries(Object.entries(reordered.payload.state.entities).reverse());expect(()=>restoreSimulation(reordered,identity)).toThrow('SAVE_CHECKSUM_MISMATCH');expect(original.state.tick).toBe(0);
  });
  it('keeps receipt digests and duplicate protection through restore, then rejects expired envelopes using highwater',()=>{
    const original=simulation(),home=Object.values(original.state.entities).find((e):e is Building=>e.kind==='building'&&e.ownerId==='blue'&&e.typeId==='town_center')!;const receipt=send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}),envelope=original.state.commandLog.at(-1)!.envelope,record=Object.values(original.state.receipts)[0]!;
    expect(record).not.toHaveProperty('body');expect(record.digest).toMatch(/^[a-f0-9]{64}$/);const restored=roundTrip(original);expect(restored.command('blue',envelope)).toEqual(receipt);const bank=restored.state.economies.blue!.resources.food;
    // Keep this receipt/ledger fixture economically idle, including the newly
    // trained villager: ordinary idle workers now acquire nearby resources.
    const stopWorkers=()=>send(restored,{kind:'stop',unitIds:Object.values(restored.state.entities).filter((e):e is Unit=>e.kind==='unit'&&e.ownerId==='blue'&&e.typeId==='villager').map(e=>e.id)});
    stopWorkers();restored.step(units.villager.trainSeconds*balance.rules.simulationHz);stopWorkers();restored.step(180*balance.rules.simulationHz);
    expect(Object.keys(restored.state.receipts)).toHaveLength(0);expect(restored.command('blue',envelope).code).toBe('STALE_SEQUENCE');expect(restored.state.economies.blue!.resources.food).toBe(bank);
  });
});

describe('M5 phase-correct replay with no controller generation',()=>{
  it('replays exact movement cadence boundaries including same-tick transitions without inference',()=>{
    const original=simulation(),checkpoints=[replayCheckpoint(original)];
    original.setMovementCadenceTier(1);original.step(3);original.setMovementCadenceTier(2);checkpoints.push(replayCheckpoint(original));original.setMovementCadenceTier(3);original.step(3);original.setMovementCadenceTier(0);original.step(2);checkpoints.push(replayCheckpoint(original));
    const recording=exportReplay(original,identity,checkpoints),events=recording.events.filter(event=>event.kind==='movement_cadence');
    expect(events.map(event=>({tick:event.tick,tier:event.tier,phase:event.phase}))).toEqual([{tick:0,tier:1,phase:'boundary'},{tick:3,tier:2,phase:'boundary'},{tick:3,tier:3,phase:'boundary'},{tick:6,tier:0,phase:'boundary'}]);
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('REPLAY_NETWORK_FORBIDDEN'));
    try{const replay=new ReplayRunner(recording,identity);expect(replay.advanceTo(3).done).toBe(true);expect(replay.simulation.state.movementCadenceTier).toBe(3);expect(replay.advanceTo(original.state.tick).done).toBe(true);compare(original,replay.simulation);expect(replay.advanceTo(1).tick).toBe(1);expect(replay.simulation.state.movementCadenceTier).toBe(1);expect(network).not.toHaveBeenCalled();}finally{network.mockRestore();}
    for(const change of [{tier:0},{tier:4},{phase:'controllers'}]){const invalid=structuredClone(recording.events);Object.assign(invalid.find(event=>event.kind==='movement_cadence')!,change);expect(()=>new ReplayRunner(createReplayRecording(recording.initial,invalid,[],recording.endTick,recording.endOrdinal),identity)).toThrow('INVALID_REPLAY_EVENT');}
  });
  it('replays rejected and duplicate commands, controller memory, administrative epochs and periodic checksums',()=>{
    const original=simulation(true),home=Object.values(original.state.entities).find((e):e is Building=>e.kind==='building'&&e.ownerId==='blue'&&e.typeId==='town_center')!,checkpoints=[replayCheckpoint(original)];
    send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:6});const first=send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}),envelope=original.state.commandLog.at(-1)!.envelope;expect(original.command('blue',envelope)).toEqual(first);
    original.step(20);checkpoints.push(replayCheckpoint(original));original.setStatus('PAUSED');original.invalidateEpoch();send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});original.setStatus('RUNNING');original.step(35);checkpoints.push(replayCheckpoint(original));original.endAsDraw();checkpoints.push(replayCheckpoint(original));
    const recording=JSON.parse(JSON.stringify(exportReplay(original,identity,checkpoints)));expect(recording.events.some((e:{kind:string;phase:string})=>e.kind==='commander_patch'&&e.phase==='controllers')).toBe(true);
    const network=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('REPLAY_NETWORK_FORBIDDEN'));try{const runner=new ReplayRunner(recording,identity);let progress=runner.advanceTo(original.state.tick,10);while(!progress.done)progress=runner.advanceTo(original.state.tick,10);compare(original,runner.simulation);expect(network).not.toHaveBeenCalled();expect(runner.advanceTo(10,10).tick).toBe(10);}finally{network.mockRestore();}
  });
  it('drains complete ordered journal batches and refuses an incomplete in-memory replay after draining',()=>{
    const original=simulation(),initial=exportSimulationSave(original,identity),home=Object.values(original.state.entities).find((e):e is Building=>e.kind==='building'&&e.ownerId==='blue'&&e.typeId==='town_center')!;send(original,{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});const first=original.drainJournal(1);original.step(3);send(original,{kind:'set_rally',buildingId:home.id,target:{xMm:home.xMm+10000,zMm:home.zMm}});const second=original.drainJournal();expect(()=>exportReplay(original,identity)).toThrow('REPLAY_JOURNAL_INCOMPLETE');
    const replay=createReplayRecording(initial,[...first.events,...second.events],[replayCheckpoint(original)],original.state.tick,original.state.eventOrdinal),runner=new ReplayRunner(replay,identity);expect(runner.advanceTo(original.state.tick).done).toBe(true);compare(original,runner.simulation);
  });
});


