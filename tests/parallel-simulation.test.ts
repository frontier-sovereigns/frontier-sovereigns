import { expect, it } from 'vitest';
import { createSimulation, createLiveSimulation, exportReplay, exportSimulationSave, replayCheckpoint, ReplayRunner, restoreSimulation, type EngineIdentity, type Simulation, type Unit } from '@frontier/simulation';
import { PathWorkerPool } from '../apps/server/src/path-worker-pool.js';
import { VisionWorkerPool } from '../apps/server/src/vision-worker-pool.js';

const identity:EngineIdentity={engineBuildHash:'a'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
function create(){return createSimulation({matchId:'parallel-integration',seed:'parallel-integration',controllers:true,sharedVision:false,factions:[
  {id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},
  {id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'},
  {id:'c',name:'C',teamId:'c',color:'#88ff44',kind:'ai',difficulty:'medium'},
]});}
function command(simulation:Simulation,stop=false){
  const unit=Object.values(simulation.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.typeId==='scout')!;
  const sequence=simulation.state.economies.a!.lastClientSequence+1;
  return simulation.command('a',{protocolVersion:2,matchId:simulation.state.matchId,matchEpoch:simulation.state.matchEpoch,clientCommandId:`order_${sequence}`,clientSequence:sequence,
    command:stop?{kind:'stop',unitIds:[unit.id]}:{kind:'move',unitIds:[unit.id],target:{xMm:unit.xMm+4000,zMm:unit.zMm+2000},queued:false}});
}

it('matches complete simulation, recipient views, cold continuation and replay with real planning and vision threads',async()=>{
  const inline=create(),parallel=restoreSimulation(exportSimulationSave(inline,identity),identity,{preserveEpoch:true});
  const paths=new PathWorkerPool({workerCount:2,checkpointEvery:8}),vision=new VisionWorkerPool({size:2});
  const coldPaths=new PathWorkerPool({workerCount:1}),coldVision=new VisionWorkerPool({size:1});let cold:Simulation|undefined;
  try{
    await parallel.attachPlanningExecutor(paths);parallel.attachVisionExecutor((frame,binding)=>vision.compute(frame,binding));
    await parallel.synchronizeCapture();expect(parallel.capture()).toEqual(inline.capture());
    for(let tick=0;tick<60;tick++){
      if([0,8,12,36].includes(tick)){
        const expected=command(inline,tick===8);expect(command(parallel,tick===8)).toEqual(expected);
        if(cold)expect(command(cold,tick===8)).toEqual(expected);
      }
      inline.step();await parallel.stepAsync();if(cold)await cold.stepAsync();
      if((tick+1)%10===0){
        await parallel.synchronizeCapture();expect(parallel.capture()).toEqual(inline.capture());
        for(const faction of inline.state.factions)expect(parallel.view(faction.id)).toEqual(inline.view(faction.id));
        if(cold){await cold.synchronizeCapture();expect(cold.capture()).toEqual(inline.capture());}
      }
      if(tick===29){cold=restoreSimulation(exportSimulationSave(parallel,identity),identity,{preserveEpoch:true});await cold.attachPlanningExecutor(coldPaths);cold.attachVisionExecutor((frame,binding)=>coldVision.compute(frame,binding));}
    }
    expect(paths.diagnostics().workerCount).toBe(2);
    const checkpoint=replayCheckpoint(parallel),runner=new ReplayRunner(exportReplay(parallel,identity,[checkpoint]),identity);
    expect(runner.advanceTo(60).done).toBe(true);
    expect(JSON.stringify(runner.simulation.capture())).toBe(JSON.stringify(parallel.capture()));
  }finally{await Promise.all([paths.close(),vision.close(),coldPaths.close(),coldVision.close()]);}
},60000);

it('rejects reentrant ticks and saves of a partially advanced asynchronous tick',async()=>{
  const simulation=create(),pool=new PathWorkerPool();
  try{
    await simulation.attachPlanningExecutor(pool);const running=simulation.stepAsync();
    expect(()=>simulation.capture()).toThrow('SAVE_NOT_AT_TICK_BOUNDARY');
    await expect(simulation.stepAsync()).rejects.toThrow('SIMULATION_STEP_IN_PROGRESS');
    await running;await simulation.synchronizeCapture();expect(simulation.capture().state.tick).toBe(1);
  }finally{await pool.close();}
});

it('matches exact 300 ms contact fog, movement, cold saves and views with actual vision workers',async()=>{
  const options={matchId:'coarse-vision-integration',seed:'coarse-vision-integration',authoritativeIntervalMs:300 as const,controllers:false,sharedVision:false,factions:[
    {id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human' as const},
    {id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human' as const},
  ]};
  const scalar=createSimulation(options),payload=scalar.capture(),inline=createLiveSimulation(options,payload),parallel=createLiveSimulation(options,payload);
  const vision=new VisionWorkerPool({size:2,timeoutMs:15000});let phases=0;
  try{
    parallel.attachVisionExecutor((frame,binding)=>{phases++;return vision.compute(frame,binding);});
    const unit=Object.values(payload.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='a'&&entity.typeId==='scout')!;
    for(let frame=0;frame<3;frame++){
      const command={protocolVersion:2,matchId:options.matchId,matchEpoch:inline.state.matchEpoch,clientCommandId:`coarse_order_${frame}`,clientSequence:frame+1,command:frame===1?{kind:'stop',unitIds:[unit.id]}:{kind:'move',unitIds:[unit.id],target:{xMm:unit.xMm+4000,zMm:unit.zMm+2000},queued:false}};
      expect(parallel.command('a',command)).toEqual(inline.command('a',command));
      inline.advanceFrame();await parallel.advanceFrameAsync();
      await inline.synchronizeCapture();await parallel.synchronizeCapture();
      expect(parallel.capture()).toEqual(inline.capture());
      for(const faction of options.factions)expect(parallel.view(faction.id)).toEqual(inline.view(faction.id));
    }
    expect(phases).toBe(18);expect(vision.diagnostics().completed).toBe(18);
    expect(vision.diagnostics().threadIds.every(id=>id>0)).toBe(true);
    const cold=createLiveSimulation(options,parallel.capture());cold.advanceFrame();inline.advanceFrame();
    await cold.synchronizeCapture();await inline.synchronizeCapture();expect(cold.capture()).toEqual(inline.capture());
  }finally{await vision.close();}
});

it('keeps 300 ms authority closed during an awaited contact vision phase',async()=>{
  const simulation=createSimulation({...create().options,authoritativeIntervalMs:300,controllers:false});
  const { VisionMaskKernel }=await import('../packages/simulation/src/vision-mask-kernel.js');
  const kernel=new VisionMaskKernel();let release:()=>void=()=>undefined,entered=false;
  simulation.attachVisionExecutor(async frame=>{if(!entered){entered=true;await new Promise<void>(resolve=>{release=resolve;});}return kernel.compute(frame);});
  const running=simulation.advanceFrameAsync();expect(entered).toBe(true);
  expect(()=>simulation.capture()).toThrow('SAVE_NOT_AT_TICK_BOUNDARY');
  await expect(simulation.advanceFrameAsync()).rejects.toThrow('SIMULATION_STEP_IN_PROGRESS');
  release();await running;await simulation.synchronizeCapture();expect(simulation.capture().state.tick).toBe(6);
});
