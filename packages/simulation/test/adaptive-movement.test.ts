import { describe,expect,it } from 'vitest';
import { balance,buildings,type GameplayCommand,type MovementCadenceTier,type PublicPlayer } from '@frontier/shared';
import { createSimulation,createLiveSimulation,Simulation,type Unit,type Building,type ResourceNode } from '../src/index.js';
import { LocalAvoidance,UnitSpatialIndex } from '../src/movement.js';
import { Navigation } from '../src/navigation.js';
import { PathWorkerPool } from '../../../apps/server/src/path-worker-pool.js';

const factions:PublicPlayer[]=[{id:'a',name:'A',teamId:'a',kind:'human',color:'#3388ff'},{id:'b',name:'B',teamId:'b',kind:'human',color:'#ff8833'}];
function fixture(){
  const options={factions,seed:'adaptive-movement',matchId:'adaptive-movement',controllers:false,sharedVision:false},initial=createSimulation(options),all=Object.values(initial.state.entities);
  initial.state.map.terrain=[];initial.state.entities={};
  const homes=all.filter((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='town_center');
  for(const home of homes){home.xMm=home.ownerId==='a'?30000:initial.state.widthMm-30000;home.zMm=home.ownerId==='a'?30000:initial.state.heightMm-30000;initial.state.entities[home.id]=home;}
  const workers=all.filter((entity):entity is Unit=>entity.kind==='unit'&&entity.typeId==='villager');
  let ownIndex=0;
  for(const worker of workers){const home=homes.find(entity=>entity.ownerId===worker.ownerId)!;worker.xMm=home.xMm+13000;worker.zMm=home.zMm+(worker.ownerId==='a'?ownIndex++:2)*6000;worker.autoGather=false;worker.stance='stand_ground';initial.state.entities[worker.id]=worker;}
  const worker=workers.find(entity=>entity.ownerId==='a')!,builder=workers.filter(entity=>entity.ownerId==='a')[1]!,mover=workers.filter(entity=>entity.ownerId==='a')[2]!;
  worker.cargo={resource:'wood',amount:9000};
  const resource:ResourceNode={id:'adaptive_tree',kind:'resource',typeId:'tree',resource:'wood',ownerId:null,xMm:worker.xMm+7000,zMm:worker.zMm,hp:1,maxHp:1,amount:1000,forest:{cellMm:balance.maps.forestNavigationCellM*1000,patchId:'adaptive_forest'}};
  initial.state.entities[resource.id]=resource;initial.state.navigationRevision++;initial.step();
  return {options,payload:initial.capture(),workerId:worker.id,builderId:builder.id,moverId:mover.id,resourceId:resource.id};
}

describe('adaptive movement decisions with unchanged 50ms movement',()=>{
  it.each([1,2] as MovementCadenceTier[])('coarse tier %i reduces full decisions across frames while retaining exact travel, retargeting, stop and cold continuation',async tier=>{
    const setup=fixture(),options={...setup.options,authoritativeIntervalMs:300 as const},mover=setup.payload.state.entities[setup.moverId] as Unit,target={xMm:180000,zMm:mover.zMm};
    setup.payload.options.authoritativeIntervalMs=300;setup.payload.options.localPlanningMode='deferred-v1';
    mover.orders=[{kind:'move',target,manualOrder:true}];mover.path=[target];mover.pathDestination=target;mover.orderRevision=1;mover.lastProgressTick=setup.payload.state.tick;
    const normal=createLiveSimulation(options,setup.payload),live=createLiveSimulation(options,setup.payload),scalar=new Simulation(options,setup.payload);
    live.setMovementCadenceTier(tier);scalar.setMovementCadenceTier(tier);
    const issue=(command:GameplayCommand)=>{for(const sim of [normal,live,scalar]){const sequence=sim.state.economies.a!.lastClientSequence+1;expect(sim.command('a',{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`coarse_cadence_${sequence}`,clientSequence:sequence,command})).toMatchObject({status:'accepted'});}};
    const positions=(sim:Simulation|ReturnType<typeof createLiveSimulation>)=>Object.values(sim.state.entities).map(entity=>[entity.id,entity.xMm,entity.zMm,entity.hp]);
    const startTick=live.state.tick,startX=mover.xMm,comparisonSpan=tier===1?18:12;
    for(let frame=0;frame<18;frame++){
      if(frame===12){
        expect(live.movementDecisionDiagnostics().full).toBeLessThan(normal.movementDecisionDiagnostics().full);
        expect((live.state.entities[mover.id] as Unit).xMm).toBeGreaterThan(startX+5000);
        issue({kind:'move',unitIds:[mover.id],target:{xMm:160000,zMm:mover.zMm+15000},queued:false});
      }
      if(frame===16)issue({kind:'stop',unitIds:[mover.id]});
      const end=startTick+(frame+1)*comparisonSpan;
      for(const sim of [normal,live,scalar])while(sim.state.tick<end){sim.advanceFrame();await sim.synchronizeCapture();}
      expect(live.capture(),`coarse tier ${tier}, frame ${frame}`).toEqual(scalar.capture());
      // Existing admitted travel keeps normal game speed. A new path request
      // can be admitted at a different authority boundary across cadences, so
      // retargeting thereafter is compared with its identical-cadence oracle.
      if(frame<12)expect(positions(live)).toEqual(positions(normal));
      expect(live.state.tick).toBe(end);
    }
    const cold=createLiveSimulation(options,live.capture());for(const sim of [live,scalar,cold]){sim.advanceFrame();await sim.synchronizeCapture();}
    expect(cold.capture()).toEqual(live.capture());expect(live.capture()).toEqual(scalar.capture());
  });
  it.each([5,8,11])('proves an isolated %i-contact flight once and keeps exact integer positions and local scheduler state',steps=>{
    const nav=new Navigation(20000,20000,[]),normal=new LocalAvoidance(),flight=new LocalAvoidance(),left=new UnitSpatialIndex(),right=new UnitSpatialIndex(),target={xMm:16001,zMm:11333};let body={id:'mover',xMm:3000,zMm:3000,radiusMm:350};
    for(const index of [left,right])index.set(body);for(const local of [normal,flight])local.beginTick(1,1);
    const first=normal.step(body,target,151,nav,left)!;expect(flight.step(body,target,151,nav,right)).toEqual(first);body={...body,...first};for(const index of [left,right])index.set(body);
    const before=flight.exportState(),points=flight.prepareStraightFlight(body,target,151,steps,300,nav,right);expect(points).toHaveLength(steps);expect(flight.exportState()).toEqual(before);const topology=right.topologyVersion();
    for(let offset=0;offset<steps;offset++){
      normal.beginTick(offset+2,1);flight.beginTick(offset+2,1);const expected=normal.step(body,target,151,nav,left)!;
      expect(points![offset]).toEqual(expected);expect(flight.continueProvenStraight(body,target,points![offset]!)).toBe(true);expect(flight.exportState()).toEqual(normal.exportState());
      body={...body,...expected};for(const index of [left,right])index.set(body);expect(right.topologyVersion()).toBe(topology);
    }
    right.set({id:'spawn',xMm:body.xMm+5000,zMm:body.zMm,radiusMm:350});expect(right.topologyVersion()).toBeGreaterThan(topology);
  });
  it('declines a flight with a future static collision or another body reachable envelope without changing local state',()=>{
    for(const obstacle of [false,true]){
      const nav=new Navigation(10000,10000,obstacle?[{id:'wall',xMm:2300,zMm:2000,halfWidth:100,halfHeight:1000}]:[]),local=new LocalAvoidance(),index=new UnitSpatialIndex(),target={xMm:9000,zMm:2000};let body={id:'mover',xMm:1000,zMm:2000,radiusMm:350};index.set(body);local.beginTick(1,1);body={...body,...local.step(body,target,150,nav,index)!};index.set(body);
      if(!obstacle)index.set({id:'approaching',xMm:body.xMm+1500,zMm:body.zMm+1200,radiusMm:350});
      const before=local.exportState();expect(local.prepareStraightFlight(body,target,150,5,300,nav,index)).toBeUndefined();expect(local.exportState()).toEqual(before);
    }
  });
  it.each([1,2,3] as MovementCadenceTier[])('keeps travel, gathering, deposit, construction changes and cold continuation exact at tier %i',tier=>{
    const setup=fixture(),reference=new Simulation(setup.options,setup.payload),live=createLiveSimulation(setup.options,setup.payload);
    reference.setMovementCadenceTier(tier);live.setMovementCadenceTier(tier);
    const issue=(command:GameplayCommand)=>{
      const sequence=reference.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:reference.state.matchId,matchEpoch:reference.state.matchEpoch,clientCommandId:`movement_${sequence}`,clientSequence:sequence,command};
      const receipt=reference.command('a',envelope);expect(live.command('a',envelope)).toEqual(receipt);expect(receipt.status,receipt.code).toBe('accepted');
    };
    issue({kind:'gather',unitIds:[setup.workerId],targetId:setup.resourceId,queued:false});
    issue({kind:'move',unitIds:[setup.moverId],target:{xMm:65000,zMm:42000},queued:false});
    let cold:ReturnType<typeof createLiveSimulation>|undefined;
    const startingWood=reference.state.economies.a!.resources.wood;
    for(let tick=0;tick<180;tick++){
      if(tick===12)issue({kind:'move',unitIds:[setup.moverId],target:{xMm:58000,zMm:47000},queued:false});
      if(tick===20)issue({kind:'build',builderIds:[setup.builderId],buildingType:'house',originCell:{x:20,z:19},rotation:0,queued:false});
      if(tick===24){const house=Object.values(reference.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.typeId==='house')!;issue({kind:'cancel_foundation',foundationId:house.id});}
      reference.step();live.step();cold?.step();
      expect(live.capture(),`tier ${tier}, tick ${tick}`).toEqual(reference.capture());
      if(cold)expect(cold.capture(),`cold tier ${tier}, tick ${tick}`).toEqual(reference.capture());
      if(tick===70)cold=createLiveSimulation(setup.options,live.capture());
      if(tick%20===0)for(const id of ['a','b'])expect(live.view(id)).toEqual(reference.view(id));
    }
    const counts=live.movementDecisionDiagnostics();expect(counts.reused).toBeGreaterThan(30);expect(counts.full).toBeLessThan(reference.movementDecisionDiagnostics().full);
    expect(counts.full+counts.reused).toBe(reference.movementDecisionDiagnostics().full);expect(counts.attempted).toBeGreaterThanOrEqual(counts.reused);
    // A successful deposit is real work at the original rate, not visual travel.
    expect(reference.state.economies.a!.collected.wood).toBeGreaterThan(0);expect(reference.state.economies.a!.resources.wood).toBeGreaterThan(startingWood-100000);
    expect((reference.state.entities[setup.resourceId] as ResourceNode).amount).toBe(0);
    expect(cold!.movementDecisionDiagnostics().reused).toBeGreaterThan(0);
  });

  it('keeps reduced decisions identical with actual parallel planning workers',async()=>{
    const setup=fixture(),reference=new Simulation(setup.options,setup.payload),live=createLiveSimulation(setup.options,setup.payload),pool=new PathWorkerPool({workerCount:2});
    reference.setMovementCadenceTier(3);live.setMovementCadenceTier(3);
    try{
      await live.attachPlanningExecutor(pool);
      const envelope={protocolVersion:2,matchId:reference.state.matchId,matchEpoch:reference.state.matchEpoch,clientCommandId:'parallel_move',clientSequence:1,command:{kind:'move' as const,unitIds:[setup.moverId],target:{xMm:65000,zMm:42000},queued:false}};
      expect(live.command('a',envelope)).toEqual(reference.command('a',envelope));
      for(let tick=0;tick<40;tick++){reference.step();await live.stepAsync();if(tick%10===0||tick===39){await live.synchronizeCapture();expect(live.capture(),`parallel tick ${tick}`).toEqual(reference.capture());}}
      expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(10);expect(pool.diagnostics().workers.every(worker=>worker.threadId>0&&worker.recoveries===0)).toBe(true);
    }finally{await pool.dispose();}
  });

  it('invalidates a warm straight trip immediately when an owned gate closes',()=>{
    const setup=fixture(),home=Object.values(setup.payload.state.entities).find((entity):entity is Building=>entity.kind==='building'&&entity.ownerId==='a')!;
    const gate:Building={...structuredClone(home),id:'adaptive_gate',typeId:'wooden_gate',xMm:50000,zMm:42000,rotation:90,hp:buildings.wooden_gate.maxHp,maxHp:buildings.wooden_gate.maxHp,grantedHp:buildings.wooden_gate.maxHp,work:1,required:1,queue:[],gateMode:'OPEN',gateOpen:true};
    setup.payload.state.entities[gate.id]=gate;setup.payload.state.navigationRevision++;
    const reference=new Simulation(setup.options,setup.payload),live=createLiveSimulation(setup.options,setup.payload);reference.setMovementCadenceTier(3);live.setMovementCadenceTier(3);
    const issue=(command:GameplayCommand)=>{const sequence=reference.state.economies.a!.lastClientSequence+1,envelope={protocolVersion:2,matchId:reference.state.matchId,matchEpoch:reference.state.matchEpoch,clientCommandId:`gate_${sequence}`,clientSequence:sequence,command};const receipt=reference.command('a',envelope);expect(live.command('a',envelope)).toEqual(receipt);expect(receipt.status).toBe('accepted');};
    issue({kind:'move',unitIds:[setup.moverId],target:{xMm:65000,zMm:42000},queued:false});
    for(let tick=0;tick<40;tick++){
      if(tick===7){expect(live.movementDecisionDiagnostics().reused).toBeGreaterThan(0);issue({kind:'set_gate_mode',gateId:gate.id,mode:'LOCKED'});}
      reference.step();live.step();expect(live.capture(),`gate tick ${tick}`).toEqual(reference.capture());
      if(tick>=7)expect((live.state.entities[gate.id] as Building).gateOpen).toBe(false);
    }
  });

  it('wakes immediately for a newly colliding body and preserves the full local solver state',()=>{
    const nav=new Navigation(10000,10000,[]),normal=new LocalAvoidance(),reused=new LocalAvoidance(),left=new UnitSpatialIndex(),right=new UnitSpatialIndex();
    let body={id:'unit',xMm:1000,zMm:2000,radiusMm:350};const target={xMm:9000,zMm:2000};
    for(let tick=1;tick<=6;tick++){
      for(const index of [left,right]){index.set(body);if(tick===4)index.set({id:'blocker',xMm:body.xMm+710,zMm:body.zMm,radiusMm:350});}
      normal.beginTick(tick,1);reused.beginTick(tick,1);
      const expected=normal.step(body,target,100,nav,left),before=reused.exportState(),continued=tick===1?undefined:reused.continueStraight(body,target,100,nav,right);
      if(tick===4){expect(continued).toBeUndefined();expect(reused.exportState()).toEqual(before);}
      const actual=continued??reused.step(body,target,100,nav,right);expect(actual).toEqual(expected);expect(reused.exportState()).toEqual(normal.exportState());
      if(actual)body={...body,...actual};
    }
  });

  it('forces only authorized death/fog publication and never acknowledges ordinary AI view reads',()=>{
    const setup=fixture(),sim=new Simulation(setup.options,setup.payload);sim.setMovementCadenceTier(3);sim.views(['a','b']);
    expect(sim.urgentPublicationRecipients(['a','b'])).toEqual([]);
    const hiddenEnemy=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!;
    expect(sim.view('a').entities.some(entity=>entity.id===hiddenEnemy.id)).toBe(false);hiddenEnemy.hp=0;sim.step();
    expect(sim.urgentPublicationRecipients(['a','b'])).toEqual(['b']);sim.view('b');expect(sim.urgentPublicationRecipients(['b'])).toEqual(['b']);
    sim.publicationProjections([{playerId:'b',sequence:1}]);expect(sim.urgentPublicationRecipients(['a','b'])).toEqual([]);
    sim.state.vision.a!.visible.pop();expect(sim.urgentPublicationRecipients(['a','b'])).toEqual(['a']);
    sim.setMovementCadenceTier(0);expect(sim.urgentPublicationRecipients(['a','b'])).toEqual([]);sim.setMovementCadenceTier(2);expect(sim.urgentPublicationRecipients(['a','b'])).toEqual(['a','b']);
  });
  it('retains authorized urgent recipients at the normal 300ms cadence without hidden-world priority leaks',()=>{
    const setup=fixture(),sim=new Simulation({...setup.options,authoritativeIntervalMs:300},setup.payload);sim.views(['a','b']);
    expect(sim.state.movementCadenceTier).toBe(0);expect(sim.urgentPublicationRecipients(['a','b'])).toEqual([]);
    const hiddenEnemy=Object.values(sim.state.entities).find((entity):entity is Unit=>entity.kind==='unit'&&entity.ownerId==='b')!;
    expect(sim.view('a').entities.some(entity=>entity.id===hiddenEnemy.id)).toBe(false);hiddenEnemy.hp=0;sim.advanceFrame();
    expect(sim.urgentPublicationRecipients(['a','b'])).toEqual(['b']);sim.view('b');expect(sim.urgentPublicationRecipients(['b'])).toEqual(['b']);
    sim.publicationProjections([{playerId:'b',sequence:1}]);expect(sim.urgentPublicationRecipients(['a','b'])).toEqual([]);
    sim.state.vision.a!.visible.pop();expect(sim.urgentPublicationRecipients(['a','b'])).toEqual(['a']);
    expect(()=>sim.urgentPublicationRecipients(['unknown'])).toThrow('NOT_AUTHORIZED');
  });
});
