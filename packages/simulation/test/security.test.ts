import { describe, expect, it } from 'vitest';
import { balance, buildings, validatePlayerView, type ClientCommandEnvelope, type GameplayCommand, type PublicPlayer } from '@frontier/shared';
import { createSimulation, type Building, type Entity, type ResourceNode, type Simulation, type Unit } from '../src/index.js';
import { Navigation } from '../src/navigation.js';

const factions:PublicPlayer[]=[
  {id:'p1',name:'One',teamId:'one',color:'#3388ff',kind:'human'},
  {id:'p2',name:'Two',teamId:'two',color:'#ee7744',kind:'human'},
];
const setup=()=>createSimulation({seed:'security-m1-291',secretIdKey:'test-opaque-id-key',matchId:'security',factions,controllers:false});
const all=(sim:Simulation)=>Object.values(sim.state.entities);
const villager=(sim:Simulation,owner='p1')=>all(sim).find((e):e is Unit=>e.kind==='unit'&&e.ownerId===owner&&e.typeId==='villager')!;
const center=(sim:Simulation,owner='p1')=>all(sim).find((e):e is Building=>e.kind==='building'&&e.ownerId===owner&&e.typeId==='town_center')!;
const envelope=(command:GameplayCommand,id='cmd-1',sequence=1,epoch=1):ClientCommandEnvelope=>({protocolVersion:2,matchId:'security',matchEpoch:epoch,clientCommandId:id,clientSequence:sequence,command});
const material=(sim:Simulation)=>structuredClone({entities:sim.state.entities,economies:Object.fromEntries(Object.entries(sim.state.economies).map(([id,{lastClientSequence,...economy}])=>[id,economy])),status:sim.state.status,projectiles:sim.state.projectiles,sequence:sim.state.sequence,commandLog:sim.state.commandLog});
function observeEnemy(sim:Simulation,target:Entity):Unit {
  const observer=all(sim).find((e):e is Unit=>e.kind==='unit'&&e.ownerId==='p1'&&e.typeId==='scout')!;
  observer.xMm=target.xMm+15000;observer.zMm=target.zMm;sim.step();
  expect(sim.view('p1').entities.some(e=>e.id===target.id&&!e.ghost)).toBe(true);
  return observer;
}

describe('M1 command authority and deduplication',()=>{
  function treePlacementFixture(){
    const sim=setup(),worker=villager(sim),tree=structuredClone(all(sim).find((e):e is ResourceNode=>e.kind==='resource'&&e.resource==='wood')!);
    sim.state.map.terrain=[];
    for(const entity of all(sim))if(entity.kind==='resource')delete sim.state.entities[entity.id];else if(entity.ownerId==='p1'){entity.xMm=40000;entity.zMm=40000;}
    worker.xMm=17000;worker.zMm=22000;worker.orders=[];
    tree.xMm=27000;tree.zMm=22000;delete tree.forest;sim.state.entities[tree.id]=tree;
    sim.state.navigationRevision++;
    // Explicit observed fixture: construction checks explored cells as well as
    // current sight, so both parts of the disclosed observation must agree.
    const masks=(sim as unknown as {visibilityMasks:Map<string,Uint8Array>}).visibilityMasks;
    const fog=balance.rules.fogGridM*1000,columns=Math.floor(sim.state.widthMm/fog),mask=new Uint8Array(columns*Math.floor(sim.state.heightMm/fog)).fill(1);masks.set('p1',mask);
    sim.state.vision.p1!.explored=Array.from(mask.keys());sim.state.vision.p1!.memory={};
    const command:GameplayCommand={kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:10,z:10},rotation:0,queued:false};
    return {sim,tree,command,mask,fog,columns};
  }
  it.each([0,90,180,270] as const)('rejects tree canopy overlap outside the trunk without spending (%i degrees)',rotation=>{
    const {sim,tree,command}=treePlacementFixture(),before=structuredClone(sim.state.economies.p1!.resources);
    expect(tree.xMm-450).toBeGreaterThan(24000); // Trunk is outside the house.
    expect(sim.command('p1',envelope({...command,rotation})).code).toBe('PLACEMENT_BLOCKED');
    expect(sim.state.economies.p1!.resources).toEqual(before);
  });
  it.each(['cleared','outside clearance'] as const)('permits construction when the neighboring tree is %s',mode=>{
    const {sim,tree,command}=treePlacementFixture();if(mode==='cleared')tree.amount=0;else tree.xMm=28000;
    expect(sim.command('p1',envelope(command))).toMatchObject({status:'accepted',code:'OK'});
  });
  it('rejects undiscovered tree-clearance cells before querying occupancy',()=>{
    const {sim,tree,command,mask,fog,columns}=treePlacementFixture(),cell=Math.floor(tree.zMm/fog)*columns+Math.floor(tree.xMm/fog);mask[cell]=0;sim.state.vision.p1!.explored=sim.state.vision.p1!.explored.filter(index=>index!==cell);
    const occupied=sim.command('p1',envelope(command));delete sim.state.entities[tree.id];
    const empty=sim.command('p1',envelope(command,'empty-halo',2));
    expect(occupied.code).toBe('PLACEMENT_UNAVAILABLE');expect(empty.code).toBe(occupied.code);
  });
  it('rejects a wall beside tree foliage while retaining atomic construction',()=>{
    const {sim,tree}=treePlacementFixture();tree.xMm=25000;tree.zMm=21000;
    const before=structuredClone(sim.state.economies.p1!.resources);
    expect(sim.command('p1',envelope({kind:'build_wall',builderIds:[villager(sim).id],material:'palisade',cells:[{x:10,z:10}],queued:false})).code).toBe('PLACEMENT_BLOCKED');
    expect(sim.state.economies.p1!.resources).toEqual(before);
  });
  it.each((['food','gold','stone'] as const).flatMap(resource=>(['house','farm','market'] as const).map(buildingType=>({resource,buildingType}))))('protects $resource art beside a $buildingType, then opens the site after depletion',({resource,buildingType})=>{
    const {sim,tree,command}=treePlacementFixture(),rotation=buildingType==='market'?90:0,grid=balance.rules.buildingGridM*1000,def=buildings[buildingType],width=def.footprintCells[rotation===90?1:0],depth=def.footprintCells[rotation===90?0:1];
    tree.resource=resource;tree.typeId={food:'forage_patch',gold:'gold_deposit',stone:'stone_quarry'}[resource];
    tree.xMm=(10+width)*grid+balance.rules.nonTreeBuildingClearanceM*1000-100;tree.zMm=(10+depth/2)*grid;
    sim.state.economies.p1!.age=4;sim.state.economies.p1!.resources={food:1000000,wood:1000000,gold:1000000,stone:1000000};
    const before=structuredClone(sim.state.economies.p1!.resources),proposal={...command,buildingType,rotation} as GameplayCommand;
    expect(tree.xMm-650).toBeGreaterThan((10+width)*grid);
    expect(sim.command('p1',envelope(proposal))).toMatchObject({status:'rejected',code:'PLACEMENT_BLOCKED'});
    expect(sim.state.economies.p1!.resources).toEqual(before);
    tree.amount=0;sim.state.navigationRevision++;
    expect(sim.command('p1',envelope(proposal,'depleted-site',2))).toMatchObject({status:'accepted',code:'OK'});
  });
  it.each(['food','gold','stone'] as const)('rejects atomic wall placement beside %s art and permits it after depletion',resource=>{
    const {sim,tree}=treePlacementFixture();tree.resource=resource;tree.typeId={food:'forage_patch',gold:'gold_deposit',stone:'stone_quarry'}[resource];tree.xMm=25000;tree.zMm=21000;
    const before=structuredClone(sim.state.economies.p1!.resources),proposal:GameplayCommand={kind:'build_wall',builderIds:[villager(sim).id],material:'palisade',cells:[{x:10,z:10}],queued:false};
    expect(sim.command('p1',envelope(proposal)).code).toBe('PLACEMENT_BLOCKED');expect(sim.state.economies.p1!.resources).toEqual(before);
    tree.amount=0;sim.state.navigationRevision++;
    expect(sim.command('p1',envelope(proposal,'depleted-wall-site',2))).toMatchObject({status:'accepted',code:'OK'});
  });
  it.each(['food','gold','stone'] as const)('does not disclose hidden %s when its construction halo is undiscovered',resource=>{
    const {sim,tree,command,mask,fog,columns}=treePlacementFixture();tree.resource=resource;
    const cell=Math.floor(tree.zMm/fog)*columns+Math.floor(tree.xMm/fog);mask[cell]=0;sim.state.vision.p1!.explored=sim.state.vision.p1!.explored.filter(index=>index!==cell);
    const occupied=sim.command('p1',envelope(command));delete sim.state.entities[tree.id];
    expect(occupied.code).toBe('PLACEMENT_UNAVAILABLE');expect(sim.command('p1',envelope(command,'empty-resource-halo',2)).code).toBe(occupied.code);
  });
  it.each(['ai','caretaker'] as const)('enforces %s walking clearance at admission even for a stale placement, while retaining manual placement freedom',source=>{
    const {sim,tree,command}=treePlacementFixture();delete sim.state.entities[tree.id];
    sim.configureAssistant('p1',{enabled:true,modelId:'host',reserve:{food:0,wood:0,gold:0,stone:0}});
    const neighbor={...structuredClone(center(sim)),id:'nearby_house',typeId:'house' as const,xMm:28000,zMm:22000};sim.state.entities[neighbor.id]=neighbor;sim.state.navigationRevision++;
    const before=structuredClone(sim.state.economies.p1!.resources);
    expect(sim.command('p1',envelope(command),source).code).toBe('PLACEMENT_BLOCKED');expect(sim.state.economies.p1!.resources).toEqual(before);
    expect(sim.command('p1',envelope(command,'manual-placement',2),'human').status).toBe('accepted');
  });
  it('keeps AI walls away from ordinary buildings without separating joined wall segments',()=>{
    const {sim,tree}=treePlacementFixture();delete sim.state.entities[tree.id];
    sim.configureAssistant('p1',{enabled:true,modelId:'host',reserve:{food:0,wood:0,gold:0,stone:0}});
    const neighbor={...structuredClone(center(sim)),id:'wall_neighbor',typeId:'house' as const,xMm:26000,zMm:21000};sim.state.entities[neighbor.id]=neighbor;sim.state.navigationRevision++;
    const command:GameplayCommand={kind:'build_wall',builderIds:[villager(sim).id],material:'palisade',cells:[{x:10,z:10},{x:11,z:10}],queued:false};
    expect(sim.command('p1',envelope(command),'ai').code).toBe('PLACEMENT_BLOCKED');
    delete sim.state.entities[neighbor.id];sim.state.navigationRevision++;
    expect(sim.command('p1',envelope(command,'joined-wall',2),'ai').status).toBe('accepted');
  });
  it('rejects unsafe faction identifiers before populating authoritative dictionaries',()=>{
    for(const id of ['__proto__','constructor','prototype','toString','bad:id',''])expect(()=>createSimulation({seed:'ids',matchId:'ids',factions:[{...factions[0]!,id},factions[1]!]})).toThrow('INVALID_FACTION_ID');
  });
  it('rejects inherited property names as player identities before inspecting match state',()=>{
    const sim=setup();sim.setStatus('PAUSED');
    const before=structuredClone(sim.state),command=envelope({kind:'move',unitIds:[villager(sim).id],target:{xMm:180000,zMm:180000},queued:false});
    for(const id of ['__proto__','constructor','toString']){
      expect(sim.command(id,command).code).toBe('NOT_AUTHORIZED');
      expect(()=>sim.view(id)).toThrow('NOT_AUTHORIZED');
    }
    expect(sim.state).toEqual({...before,eventOrdinal:before.eventOrdinal+3});
    expect(sim.journalEvents().slice(-3).every(event=>event.kind==='command'&&event.receipt.code==='NOT_AUTHORIZED')).toBe(true);
  });
  it('rejects a mixed own/enemy selection atomically',()=>{
    const sim=setup(),own=villager(sim),enemy=villager(sim,'p2'),before=material(sim);
    expect(sim.command('p1',envelope({kind:'move',unitIds:[own.id,enemy.id],target:{xMm:180000,zMm:190000},queued:false})).code).toBe('INVALID_REFERENCE');
    expect(material(sim)).toEqual(before);
  });
  it('returns the same nonrevealing error for hidden and nonexistent attack/gather targets',()=>{
    for(const kind of ['attack_target','gather'] as const){
      const sim=setup(),own=villager(sim),known=new Set(sim.view('p1').entities.map(e=>e.id)),hidden=kind==='attack_target'?villager(sim,'p2'):all(sim).find(e=>e.kind==='resource'&&!known.has(e.id))!;
      expect(sim.view('p1').entities.some(e=>e.id===hidden.id)).toBe(false);
      const before=material(sim);
      const hiddenReceipt=sim.command('p1',envelope({kind,unitIds:[own.id],targetId:hidden.id,queued:false},'hidden',1));
      const missingReceipt=sim.command('p1',envelope({kind,unitIds:[own.id],targetId:'invented-target',queued:false},'missing',2));
      expect(hiddenReceipt.code).toBe('INVALID_REFERENCE');expect(missingReceipt.code).toBe(hiddenReceipt.code);
      expect(material(sim)).toEqual(before);
    }
  });
  it('checks visibility before reporting hidden placement occupancy',()=>{
    const sim=setup(),enemy=center(sim,'p2'),worker=villager(sim),before=material(sim);
    const first=sim.command('p1',envelope({kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:Math.floor(enemy.xMm/2000),z:Math.floor(enemy.zMm/2000)},rotation:0,queued:false},'occupied',1));
    const second=sim.command('p1',envelope({kind:'build',builderIds:[worker.id],buildingType:'house',originCell:{x:10,z:10},rotation:0,queued:false},'empty',2));
    expect(first.code).toBe('PLACEMENT_UNAVAILABLE');expect(second.code).toBe(first.code);expect(material(sim)).toEqual(before);
  });
  it('does not let another player operate an enemy producer or foundation',()=>{
    const sim=setup(),enemy=center(sim,'p2'),before=material(sim);
    expect(sim.command('p1',envelope({kind:'train',buildingId:enemy.id,unitType:'villager',quantity:1},'train',1)).code).toBe('INVALID_REFERENCE');
    expect(sim.command('p1',envelope({kind:'continue_build',builderIds:[villager(sim).id],foundationId:enemy.id,queued:false},'continue',2)).code).toBe('INVALID_REFERENCE');
    expect(sim.command('p1',envelope({kind:'set_rally',buildingId:enemy.id,target:{xMm:0,zMm:0}},'rally',3)).code).toBe('INVALID_REFERENCE');
    expect(material(sim)).toEqual(before);
  });
  it('deduplicates a purchase despite JSON property reordering and rejects changed content',()=>{
    const sim=setup(),purchase=envelope({kind:'train',buildingId:center(sim).id,unitType:'villager',quantity:1});
    const receipt=sim.command('p1',purchase),after=structuredClone(sim.state);
    expect(receipt.status).toBe('accepted');
    const reordered=JSON.parse(JSON.stringify(purchase,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).reverse()):value));
    expect(sim.command('p1',reordered)).toEqual(receipt);expect(sim.state).toEqual({...after,eventOrdinal:after.eventOrdinal+1});
    expect(sim.command('p1',{...purchase,command:{...purchase.command,quantity:2}}).code).toBe('COMMAND_ID_REUSED');
    expect(sim.command('p1',{...purchase,clientSequence:2}).code).toBe('COMMAND_ID_REUSED');expect(sim.state).toEqual({...after,eventOrdinal:after.eventOrdinal+3});
    expect(sim.journalEvents().slice(-3).map(event=>event.kind==='command'?event.receipt.code:'unexpected')).toEqual(['OK','COMMAND_ID_REUSED','COMMAND_ID_REUSED']);
  });
  it('deduplicates per player and rejects stale sequences without new spending',()=>{
    const sim=setup();
    for(const owner of ['p1','p2'])expect(sim.command(owner,envelope({kind:'train',buildingId:center(sim,owner).id,unitType:'villager',quantity:1},'shared-command-id',10)).status).toBe('accepted');
    const before=material(sim);
    expect(sim.command('p1',envelope({kind:'train',buildingId:center(sim).id,unitType:'villager',quantity:1},'new-id',9)).code).toBe('STALE_SEQUENCE');
    expect(material(sim)).toEqual(before);
  });
  it('keeps receipts identical when an unseen opponent submits additional commands',()=>{
    const quiet=setup(),busy=setup();
    const first=envelope({kind:'train',buildingId:center(quiet).id,unitType:'villager',quantity:1},'own-first',1);
    const original=quiet.command('p1',first);expect(busy.command('p1',first)).toEqual(original);
    expect(original).toMatchObject({status:'accepted',sequence:1});
    const enemy=villager(busy,'p2');expect(busy.view('p1').entities.some(entity=>entity.id===enemy.id)).toBe(false);
    for(let i=1;i<=20;i++)expect(busy.command('p2',envelope({kind:'set_stance',unitIds:[enemy.id],stance:i%2?'aggressive':'defensive'},`hidden-${i}`,i)).status).toBe('accepted');
    expect(busy.view('p1')).toEqual(quiet.view('p1'));
    const second=envelope({kind:'train',buildingId:center(quiet).id,unitType:'villager',quantity:1},'own-second',2);
    expect(busy.command('p1',second)).toEqual(quiet.command('p1',second));
    const invalid=envelope({kind:'attack_target',unitIds:[villager(quiet).id],targetId:'unobserved-target',queued:false},'own-invalid',3);
    const rejected=quiet.command('p1',invalid);expect(busy.command('p1',invalid)).toEqual(rejected);
    expect(rejected).toMatchObject({status:'rejected',code:'INVALID_REFERENCE',sequence:3});
    for(const command of [first,{...first,clientSequence:4},{...invalid,matchEpoch:99},{unknown:true}])expect(busy.command('p1',command)).toEqual(quiet.command('p1',command));
    expect(busy.command('p1',first)).toEqual(original);
    expect(busy.command('constructor',first)).toMatchObject({code:'NOT_AUTHORIZED',sequence:0});
    expect(quiet.state.commandLog.map(entry=>entry.sequence)).toEqual([1,2]);
    expect(busy.state.commandLog.map(entry=>entry.sequence)).toEqual(Array.from({length:22},(_,index)=>index+1));
    expect(busy.state.sequence-quiet.state.sequence).toBe(20);
  });
  it('invalidates old epochs, pauses admission, and rejects finished-match commands',()=>{
    const sim=setup(),command=envelope({kind:'move',unitIds:[villager(sim).id],target:{xMm:180000,zMm:180000},queued:false});
    sim.invalidateEpoch();const before=structuredClone(sim.state);expect(sim.command('p1',command).code).toBe('STALE_MATCH');expect(sim.state).toEqual({...before,eventOrdinal:before.eventOrdinal+1});
    sim.setStatus('PAUSED');expect(sim.command('p1',{...command,matchEpoch:2}).code).toBe('MATCH_PAUSED');
    sim.setStatus('FINISHED');expect(sim.command('p1',{...command,matchEpoch:2}).code).toBe('MATCH_FINISHED');
    expect(villager(sim).orders).toHaveLength(0);
  });
  it('bounds queued orders across all selected units without partial admission',()=>{
    const sim=setup(),first=villager(sim),second=all(sim).find((e):e is Unit=>e.kind==='unit'&&e.ownerId==='p1'&&e.typeId==='villager'&&e.id!==first.id)!;
    for(let i=0;i<balance.rules.orderQueueLimit;i++)expect(sim.command('p1',envelope({kind:'move',unitIds:[first.id],target:{xMm:180000+i,zMm:180000},queued:true},`queue-${i}`,i+1)).status).toBe('accepted');
    const before=material(sim);
    expect(sim.command('p1',envelope({kind:'move',unitIds:[first.id,second.id],target:{xMm:180000,zMm:180000},queued:true},'overflow',100)).code).toBe('ORDER_QUEUE_FULL');expect(material(sim)).toEqual(before);expect(second.orders).toHaveLength(0);
    expect(sim.command('p1',envelope({kind:'stop',unitIds:[first.id]},'clear',101)).status).toBe('accepted');expect(first.orders).toHaveLength(0);
  });
  it('rejects foreign cancellation and refunds a waiting job only once',()=>{
    const sim=setup(),producer=center(sim);
    expect(sim.command('p1',envelope({kind:'train',buildingId:producer.id,unitType:'villager',quantity:2},'purchase',1)).status).toBe('accepted');
    const before=material(sim);
    const cancel=envelope({kind:'cancel_job',buildingId:producer.id,jobId:producer.queue[1]!.id},'cancel',2);
    expect(sim.command('p2',cancel).code).toBe('INVALID_REFERENCE');
    expect(material(sim)).toEqual(before);
    const receipt=sim.command('p1',cancel),after=material(sim);
    expect(receipt.status).toBe('accepted');expect(producer.queue).toHaveLength(1);
    expect(sim.view('p1').self.resources.food).toBe(150);
    expect(sim.command('p1',cancel)).toEqual(receipt);expect(material(sim)).toEqual(after);
  });
});

describe('M1 recipient-authorized state',()=>{
  it('observes a building through its visible footprint and preserves corner-view ghost knowledge',()=>{
    const sim=setup(),observer=villager(sim),enemy=center(sim,'p2'),position={xMm:enemy.xMm-7200,zMm:enemy.zMm-7200};
    observer.xMm=position.xMm;observer.zMm=position.zMm;sim.step();
    const first=sim.view('p1'),centerCell=Math.floor(enemy.zMm/first.map.fogCellMm)*(first.map.widthMm/first.map.fogCellMm)+Math.floor(enemy.xMm/first.map.fogCellMm);
    expect(first.fog.visible).not.toContain(centerCell);
    expect(first.entities.find(e=>e.id===enemy.id)?.ghost).not.toBe(true);
    expect(first.entities.some(e=>e.id===enemy.id)).toBe(true);
    expect(sim.command('p1',envelope({kind:'attack_target',unitIds:[observer.id],targetId:enemy.id,queued:false})).status).toBe('accepted');
    sim.step(40);expect(enemy.hp).toBeLessThan(enemy.maxHp);
    const seenHp=sim.view('p1').entities.find(e=>e.id===enemy.id)!.hp;
    expect(sim.command('p1',envelope({kind:'stop',unitIds:[observer.id]},'stop-corner',2)).status).toBe('accepted');
    observer.xMm=center(sim).xMm;observer.zMm=center(sim).zMm+25000;sim.step();
    expect(sim.view('p1').entities.find(e=>e.id===enemy.id)).toMatchObject({ghost:true,hp:seenHp});
    enemy.hp=0;sim.step();
    expect(sim.view('p1').entities.find(e=>e.id===enemy.id)).toMatchObject({ghost:true,hp:seenHp});
    observer.xMm=position.xMm;observer.zMm=position.zMm;sim.step();
    expect(sim.view('p1').fog.visible).not.toContain(centerCell);
    expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(false);
  });
  it('omits enemy live data, queues, cargo, banks, seed and IDs until observed',()=>{
    const sim=setup(),hidden=all(sim).filter(e=>e.ownerId==='p2');
    sim.command('p2',envelope({kind:'train',buildingId:center(sim,'p2').id,unitType:'villager',quantity:1}));
    villager(sim,'p2').cargo={resource:'gold',amount:99000};
    center(sim,'p2').rally={xMm:170000,zMm:190000};
    const view=sim.view('p1'),packet=JSON.stringify(view);
    expect(validatePlayerView(view)).toBe(true);
    for(const e of hidden)expect(packet).not.toContain(e.id);
    for(const key of ['secretIdKey','entityNonce','randomState','receipts','commandLog','economies','collected','spent'])expect(view).not.toHaveProperty(key);
    const enemyCenter=center(sim,'p2');observeEnemy(sim,enemyCenter);
    const observed=sim.view('p1').entities.find(e=>e.id===enemyCenter.id)!;
    for(const entity of sim.view('p1').entities.filter(e=>e.ownerId==='p2')){
      for(const key of ['queue','cargo','order','rally','taskState','queuedOrderCount','blockedReason','recentLedger','notifications','autoReseed','farmerAssigned','demolitionTicksRemaining'])expect(entity).not.toHaveProperty(key);
    }
    expect(observed.queue).toBeUndefined();expect(observed.cargo).toBeUndefined();expect(observed.order).toBeUndefined();
    for(const key of ['seed','secretIdKey','spawns','resources','validation'])expect(sim.view('p1').map).not.toHaveProperty(key);
    expect(sim.view('p1').self.resources.gold).toBe(balance.start.resources.gold);
  });
  it('keeps enemy building ghosts stale after unseen damage and destruction',()=>{
    const sim=setup(),enemy=center(sim,'p2'),observer=observeEnemy(sim,enemy),seen=sim.view('p1').entities.find(e=>e.id===enemy.id)!;
    observer.xMm=center(sim).xMm;observer.zMm=center(sim).zMm+25000;sim.step();
    enemy.hp=123;sim.step();
    let ghost=sim.view('p1').entities.find(e=>e.id===enemy.id)!;expect(ghost.ghost).toBe(true);expect(ghost.hp).toBe(seen.hp);
    enemy.hp=0;sim.step();ghost=sim.view('p1').entities.find(e=>e.id===enemy.id)!;expect(ghost.ghost).toBe(true);expect(ghost.hp).toBe(seen.hp);
    observer.xMm=seen.xMm+15000;observer.zMm=seen.zMm;sim.step();expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(false);
  });
  it('conceals enemy units and never turns owned destroyed buildings into stale ghosts',()=>{
    const sim=setup(),enemy=villager(sim,'p2'),observer=observeEnemy(sim,enemy);
    observer.xMm=center(sim).xMm;observer.zMm=center(sim).zMm+25000;sim.step();
    expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(false);enemy.hp=0;sim.step();expect(sim.view('p1').entities.some(e=>e.id===enemy.id)).toBe(false);
    const home=center(sim);home.hp=0;sim.step();expect(sim.view('p1').entities.some(e=>e.id===home.id)).toBe(false);
  });
  it('gives allied shared vision only when enabled, without sharing banks or private queues',()=>{
    const roster=[...factions,{id:'p3',name:'Ally',teamId:'one',color:'#11cc88',kind:'human' as const}];
    const shared=createSimulation({seed:'shared',matchId:'shared',factions:roster,controllers:false,sharedVision:true});
    const separate=createSimulation({seed:'shared',matchId:'shared',factions:roster,controllers:false,sharedVision:false});
    const ally=all(shared).find(e=>e.ownerId==='p3'&&e.typeId==='town_center')!;
    expect(shared.view('p1').entities.find(e=>e.id===ally.id)?.queue).toBeUndefined();
    expect(shared.view('p1').entities.some(e=>e.id===ally.id)).toBe(true);
    expect(separate.view('p1').entities.some(e=>e.id===ally.id)).toBe(false);
  });
});

it('routes to a legal exact endpoint even when its navigation-cell center is obstructed',()=>{
  const navigation=new Navigation(20000,20000,[{id:'obstacle',xMm:10250,zMm:10000,halfWidth:2000,halfHeight:2000}]);
  const from={xMm:3000,zMm:10000},target={xMm:12650,zMm:10200};
  expect(navigation.free(target,350)).toBe(true);
  expect(navigation.free({xMm:12500,zMm:10500},350)).toBe(false);
  for(const [start,end] of [[from,target],[target,from]]){
    const path=navigation.path(start!,end!,350);
    expect(path).not.toBeNull();
    let prior=start!;for(const point of path!){expect(navigation.clearLine(prior,point,350)).toBe(true);prior=point;}
    expect(path!.at(-1)).toEqual(end);
  }
});

it('routes from a physically clear position beside a circular unit instead of treating its corners as solid',()=>{
  const nav=new Navigation(384000,384000,[
    {id:'scout',xMm:137500,zMm:200500,halfWidth:550,halfHeight:550,circle:true},
    {id:'house',xMm:138000,zMm:204000,halfWidth:2000,halfHeight:2000},
  ]);
  const from={xMm:136900,zMm:201222},target={xMm:144000,zMm:200000};
  expect(Math.hypot(from.xMm-137500,from.zMm-200500)).toBeGreaterThan(550+350);
  expect(nav.free(from,350)).toBe(true);
  const path=nav.path(from,target,350);expect(path).not.toBeNull();
  let prior=from;for(const point of path!){expect(nav.clearLine(prior,point,350)).toBe(true);prior=point;}
  expect(path!.at(-1)).toEqual(target);
});

it('closes the final diagonal gap until circular unit combat range is actually reached',()=>{
  const sim=setup(),attacker=villager(sim),target=villager(sim,'p2');
  // Isolate the diagonal combat geometry from generated forest/ridge occlusion.
  // The production seed now places this former empty test arena inside a ridge.
  sim.state.map.terrain=[];
  for(const entity of all(sim))if(entity.kind!=='unit'&&Math.abs(entity.xMm-180800)<10000&&Math.abs(entity.zMm-180800)<10000)delete sim.state.entities[entity.id];
  sim.state.navigationRevision++;
  attacker.xMm=180000;attacker.zMm=180000;target.xMm=181600;target.zMm=181600;
  sim.step();
  expect(target.hp).toBe(target.maxHp);
  expect(sim.command('p1',envelope({kind:'attack_target',unitIds:[attacker.id],targetId:target.id,queued:false})).status).toBe('accepted');
  sim.step(40);
  expect(target.hp).toBeLessThan(target.maxHp);
});
