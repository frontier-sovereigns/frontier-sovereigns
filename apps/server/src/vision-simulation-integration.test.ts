import { afterEach,describe,expect,it } from 'vitest';
import { balance,units,type GameplayCommand,type PublicPlayer } from '@frontier/shared';
import { Simulation,exportSimulationSave,restoreSimulation,type Building,type EngineIdentity,type ResourceNode,type Unit } from '@frontier/simulation';
import { VisionWorkerPool } from './vision-worker-pool.js';

const identity:EngineIdentity={engineBuildHash:'e'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const factions:PublicPlayer[]=[
  {id:'blue',name:'Blue',teamId:'allies',kind:'human',color:'#3388ff'},
  {id:'green',name:'Green',teamId:'allies',kind:'human',color:'#33ff88'},
  {id:'red',name:'Red',teamId:'enemy',kind:'human',color:'#ee5533'},
];
const pools:VisionWorkerPool[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.close()));});
function attach(sim:Simulation):void {const pool=new VisionWorkerPool();pools.push(pool);sim.attachVisionExecutor((frame,binding)=>pool.compute(frame,binding));}
function fixture(sharedVision:boolean):Simulation {
  const sim=new Simulation({factions,seed:'threaded-perception',matchId:'vision-integration',controllers:false,sharedVision});
  for(const [id,entity]of Object.entries(sim.state.entities))if(entity.kind!=='building')delete sim.state.entities[id];
  sim.state.map.terrain=[];sim.state.navigationRevision++;
  for(const vision of Object.values(sim.state.vision)){vision.memory={};vision.visible=[];vision.explored=[];vision.actions={};}
  const add=(id:string,ownerId:string,xMm:number,zMm:number,typeId:Unit['typeId']='militia'):Unit=>{
    const definition=units[typeId],unit:Unit={id,kind:'unit',typeId,ownerId,xMm,zMm,hp:definition.maxHp,maxHp:definition.maxHp,orders:[],path:[],pathRevision:0,orderRevision:0,repathAtTick:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',autoGather:false};
    sim.state.entities[id]=unit;return unit;
  };
  add('attacker','blue',50000,50000);add('victim','red',51000,50000).cooldown=10000;
  add('ally-scout','green',90000,90000,'scout');add('walker','blue',80000,50000,'scout');
  sim.step();return sim;
}
function send(sim:Simulation,command:GameplayCommand):void {
  const sequence=sim.state.economies.blue!.lastClientSequence+1;
  const receipt=sim.command('blue',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`command-${sequence}`,clientSequence:sequence,command});
  expect(receipt.status,JSON.stringify(receipt)).toBe('accepted');
}
function compare(reference:Simulation,threaded:Simulation):void {
  expect(threaded.capture()).toEqual(reference.capture());
  for(const faction of factions)expect(threaded.view(faction.id)).toEqual(reference.view(faction.id));
  expect(threaded.committedUnitActions()).toEqual(reference.committedUnitActions());
}

describe('parallel perception at authoritative simulation boundaries',()=>{
  it('keeps memory, actions and independent browser views current when an exact fog result is reused',async()=>{
    const reference=fixture(false);
    const victim=reference.state.entities.victim as Unit;victim.xMm=250000;victim.zMm=250000;
    const house=Object.values(reference.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='red'&&entity.typeId==='house')!;
    reference.state.entities.observed_house={...structuredClone(house),id:'observed_house',xMm:55000,zMm:50000};
    reference.state.entities.observed_tree={id:'observed_tree',kind:'resource',typeId:'tree_oak',resource:'wood',ownerId:null,xMm:53000,zMm:53000,hp:1,maxHp:1,amount:100000};
    reference.state.navigationRevision++;reference.step();
    const threaded=new Simulation(reference.options,reference.capture());attach(threaded);
    reference.step();await threaded.stepAsync();compare(reference,threaded);
    const masks=(threaded as unknown as {visibilityMasks:Map<string,Uint8Array>}).visibilityMasks,initial=masks.get('blue');
    for(let tick=0;tick<6;tick++){
      for(const sim of [reference,threaded]){
        const tree=sim.state.entities.observed_tree as ResourceNode,building=sim.state.entities.observed_house as Building;
        tree.amount-=1000;building.hp--;sim.state.economies.red!.age=tick<3?1:2;
        (sim.state.entities.attacker as Unit).cargo=tick<3?{resource:'wood',amount:5000}:{resource:null,amount:0};
      }
      reference.step();await threaded.stepAsync();compare(reference,threaded);
      expect(masks.get('blue')).toBe(initial);
      const memory=threaded.state.vision.blue!.memory;
      expect(memory.observed_tree!.amount).toBe(99-tick);expect(memory.observed_tree!.lastSeenTick).toBe(threaded.state.tick);
      expect(memory.observed_house!.hp).toBe((threaded.state.entities.observed_house as Building).hp);
      const detached=threaded.view('blue');detached.fog.visible.length=0;detached.entities.length=0;
      expect(threaded.view('blue')).toEqual(reference.view('blue'));
    }
    // Neither resource disappearance nor supported direct edits to public fog
    // arrays change a source mask. Both must still be reconciled at the boundary.
    for(const sim of [reference,threaded]){delete sim.state.entities.observed_tree;sim.state.navigationRevision++;sim.state.vision.blue!.visible=[];sim.state.vision.blue!.explored=[];}
    reference.step();await threaded.stepAsync();compare(reference,threaded);
    expect(masks.get('blue')).toBe(initial);expect(threaded.state.vision.blue!.memory.observed_tree).toBeUndefined();
    const restored=restoreSimulation(exportSimulationSave(threaded,identity),identity,{preserveEpoch:true});attach(restored);
    for(let tick=0;tick<4;tick++){reference.step();await restored.stepAsync();compare(reference,restored);}
  });
  it.each([true,false])('matches synchronous movement, lethal combat, allied fog and cold continuation (shared=%s)',async shared=>{
    const reference=fixture(shared),threaded=new Simulation(reference.options,reference.capture());attach(threaded);
    for(const sim of [reference,threaded]){
      (sim.state.entities.victim as Unit).hp=1;
      (sim.state.entities.attacker as Unit).cooldown=0;
      send(sim,{kind:'attack_target',unitIds:['attacker'],targetId:'victim',queued:false});
      send(sim,{kind:'move',unitIds:['walker'],target:{xMm:90000,zMm:65000},queued:false});
    }
    for(let tick=0;tick<6;tick++){reference.step();await threaded.stepAsync();compare(reference,threaded);}
    expect(reference.state.entities.victim).toBeUndefined();
    expect(reference.state.entities.walker!.xMm).toBeGreaterThan(80000);
    const fogMm=balance.rules.fogGridM*1000;
    expect(reference.state.vision.blue!.visible.includes(Math.floor(90000/fogMm)*Math.floor(reference.state.widthMm/fogMm)+Math.floor(90000/fogMm))).toBe(shared);
    const restored=restoreSimulation(exportSimulationSave(threaded,identity),identity,{preserveEpoch:true});attach(restored);
    for(let tick=0;tick<4;tick++){reference.step();await restored.stepAsync();compare(reference,restored);}
  });
  it('waits for the complete exact vision result before combat and refuses a reentrant tick',async()=>{
    const sim=fixture(false);(sim.state.entities.victim as Unit).hp=1;(sim.state.entities.attacker as Unit).cooldown=0;
    send(sim,{kind:'attack_target',unitIds:['attacker'],targetId:'victim',queued:false});
    const pool=new VisionWorkerPool();pools.push(pool);let release!:()=>void;
    const barrier=new Promise<void>(resolve=>{release=resolve;});let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    sim.attachVisionExecutor(async(frame,binding)=>{entered();await barrier;return pool.compute(frame,binding);});
    const running=sim.stepAsync();await started;
    expect(sim.state.entities.victim).toBeDefined();await expect(sim.stepAsync()).rejects.toThrow('SIMULATION_STEP_IN_PROGRESS');
    release();await running;expect(sim.state.entities.victim).toBeUndefined();
  });
});
