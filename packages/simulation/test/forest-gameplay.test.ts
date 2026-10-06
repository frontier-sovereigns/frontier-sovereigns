import { expect, it } from 'vitest';
import { createSimulation, exportSimulationSave, restoreSimulation, type Unit, type ResourceNode } from '../src/index.js';
import { validateSimulationSavePayload } from '../src/save-schema.js';
import { Navigation } from '../src/navigation.js';
import { balance,units,validatePlayerView } from '@frontier/shared';
const identity={engineBuildHash:'b'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
type Internals={updateVision():void;nav():Navigation;simplifyMovementRoute(unit:Unit,navigation:Navigation,radiusMm:number):void};
it('retains baseline resources and additional ordinary-yield forest trees through a maximum-roster save and filtered view',()=>{
  const simulation=createSimulation({matchId:'resource-quantity-save',seed:'resource-quantity-save',controllers:false,sharedVision:false,factions:Array.from({length:11},(_,index)=>({id:`p${index}`,name:`Player ${index}`,teamId:`t${index}`,color:'#3388ff',kind:index<6?'human' as const:'ai' as const}))});
  const nodes=Object.values(simulation.state.entities).filter((entity):entity is ResourceNode=>entity.kind==='resource');
  expect(nodes.length).toBeGreaterThanOrEqual(6420);expect(new Set(nodes.map(node=>node.id)).size).toBe(nodes.length);
  expect(nodes.length).toBeLessThanOrEqual(balance.rules.maxResourceNodes);
  expect(nodes.length).toBe(6420+(simulation.state.map.validation.forestBelts?.extraTreeNodes??0));
  const allowed={food:[200,300],wood:[100,250],gold:[300,375],stone:[200,250]};
  for(const node of nodes)expect(allowed[node.resource]).toContain(node.amount/balance.rules.resourceScale);
  const view=simulation.view('p0');expect(validatePlayerView(view)).toBe(true);
  expect(Object.keys(view.map).sort()).toEqual(['fogCellMm','generatorVersion','heightMm','terrain','type','widthMm']);
  expect(view.entities.filter(entity=>entity.kind==='resource').length).toBeLessThan(nodes.length);
  for(const entity of view.entities.filter(entity=>entity.kind==='resource'))expect(entity.amount).toBe(nodes.find(node=>node.id===entity.id)!.amount/balance.rules.resourceScale);
  const save=exportSimulationSave(simulation,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
  expect(simulation.state.map.validation).toMatchObject({forestBelts:{frontiers:expect.any(Number),openings:expect.any(Number),minimumDepthMm:expect.any(Number),treeNodes:expect.any(Number)}});
  const restored=restoreSimulation(save,identity,{preserveEpoch:true});
  expect(Object.values(restored.state.entities).filter(entity=>entity.kind==='resource').sort((a,b)=>a.id.localeCompare(b.id))).toEqual([...nodes].sort((a,b)=>a.id.localeCompare(b.id)));
  expect(restored.state.map.generatorVersion).toBe('7.0.1');
  expect(restored.state.map.validation).toEqual(simulation.state.map.validation);
},30000);
function fixture(columns=3,rows=3){
  const simulation=createSimulation({matchId:'forest-gameplay',seed:'forest-gameplay',controllers:false,sharedVision:false,factions:[
    {id:'a',name:'A',teamId:'a',color:'#3388ff',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ff8844',kind:'human'},
  ]});
  simulation.state.map.terrain=[];let offset=0;const workers:Unit[]=[];
  for(const entity of Object.values(simulation.state.entities)){
    if(entity.kind==='resource'){delete simulation.state.entities[entity.id];continue;}
    if(entity.ownerId==='b'){entity.xMm=230000+(offset++*2500);entity.zMm=230000;}
    else if(entity.kind==='building'){entity.xMm=entity.typeId==='town_center'?86000:76000;entity.zMm=104000;}
    else if(entity.typeId==='villager'){entity.xMm=95000;entity.zMm=99000+workers.length*1400;entity.autoGather=false;workers.push(entity);}
    else{entity.xMm=103000;entity.zMm=95000;}
    if(entity.kind==='unit'){entity.stance='stand_ground';entity.autoGather=false;}
  }
  for(const vision of Object.values(simulation.state.vision)){vision.memory={};vision.actions={};vision.explored=[];}
  const trees:ResourceNode[]=[];
  for(let z=0;z<rows;z++)for(let x=0;x<columns;x++){
    const tree:ResourceNode={id:'forest_'+x+'_'+z,kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:5000,xMm:100000+x*3000,zMm:100000+z*3000,hp:1,maxHp:1,forest:{patchId:'a'.repeat(64),cellMm:3000}};
    simulation.state.entities[tree.id]=tree;trees.push(tree);
  }
  simulation.state.navigationRevision++;(simulation as unknown as Internals).updateVision();return {simulation,workers,trees};
}
it('blocks forest interiors and opens only the depleted tree cell, without changing discovery bounds',()=>{
  const {simulation,trees}=fixture(),internal=simulation as unknown as Internals,center=trees[4]!;
  expect(internal.nav().free(center,350)).toBe(false);expect(internal.nav().free({xMm:101500,zMm:101500},350)).toBe(false);
  center.amount=0;simulation.state.navigationRevision++;
  expect(internal.nav().free(center,350)).toBe(true);expect(internal.nav().free(trees[3]!,350)).toBe(false);
  expect(simulation.view('b').entities.some(entity=>entity.forest)).toBe(false);
});
it.each([[3,3],[6,5]])('redirects an interior gather order in a %sx%s patch to known edges, preserves cold search and all six workers actually harvest',(columns,rows)=>{
  const {simulation,workers,trees}=fixture(columns,rows),target=trees[columns+1]!,initial=trees.reduce((sum,tree)=>sum+tree.amount,0),harvesters=new Set<string>();
  const receipt=simulation.command('a',{protocolVersion:2,matchId:simulation.state.matchId,matchEpoch:1,clientCommandId:'forest_order',clientSequence:1,command:{kind:'gather',unitIds:workers.map(worker=>worker.id),targetId:target.id,queued:false}});
  expect(receipt.status).toBe('accepted');simulation.step();expect(workers.some(worker=>worker.resourceSearch?.purpose==='forest')).toBe(true);
  const save=exportSimulationSave(simulation,identity);expect(validateSimulationSavePayload(save.payload),JSON.stringify(validateSimulationSavePayload.errors)).toBe(true);
  const cold=restoreSimulation(save,identity,{preserveEpoch:true});
  for(let tick=0;tick<1000;tick++){
    simulation.step();if(tick<20)cold.step();if(tick===19)expect(cold.capture()).toEqual(simulation.capture());
    for(const worker of workers)if(worker.cargo.resource==='wood'&&worker.cargo.amount>0)harvesters.add(worker.id);
    if(harvesters.size===6&&simulation.state.economies.a!.collected.wood>0)break;
  }
  expect(harvesters.size).toBe(6);expect(simulation.state.economies.a!.collected.wood).toBeGreaterThan(0);
  expect(initial-trees.reduce((sum,tree)=>sum+tree.amount,0)).toBe(simulation.state.economies.a!.collected.wood+workers.reduce((sum,worker)=>sum+worker.cargo.amount,0));
  expect(workers.every(worker=>worker.orders[0]?.forestIntentId===target.id)).toBe(true);
  expect(simulation.view('a').entities.some(entity=>entity.workTargetId&&entity.workTargetId!==entity.forestIntentId)).toBe(true);
},60000);

it('straightens proved routes while retaining forest clearance and the destination',()=>{
  const {simulation,workers}=fixture(),internal=simulation as unknown as Internals,unit=workers[0]!;
  unit.xMm=95000;unit.zMm=97000;
  const destination={xMm:107000,zMm:97000};
  unit.path=[{xMm:97000,zMm:97500},{xMm:100000,zMm:97000},{xMm:104000,zMm:97000},destination];
  unit.pathRegions=[{region:'5,6',revision:0},{region:'6,6',revision:0}];
  internal.simplifyMovementRoute(unit,internal.nav(),350);
  expect(unit.path).toEqual([destination]);expect(internal.nav().clearLine(unit,unit.path[0]!,350)).toBe(true);
  // A valid detour around the patch must not become a diagonal through wood.
  unit.xMm=95000;unit.zMm=104000;
  unit.path=[{xMm:97000,zMm:104000},{xMm:97000,zMm:97000},{xMm:108000,zMm:97000},{xMm:108000,zMm:104000}];
  const end={...unit.path.at(-1)!};internal.simplifyMovementRoute(unit,internal.nav(),350);
  expect(unit.path.at(-1)).toEqual(end);expect(internal.nav().clearLine(unit,unit.path[0]!,350)).toBe(true);
  for(let index=1;index<unit.path.length;index++)expect(internal.nav().clearLine(unit.path[index-1]!,unit.path[index]!,350)).toBe(true);
});

it('retains route dependency coverage and respects unit radius when straightening',()=>{
  const {simulation,workers}=fixture(),internal=simulation as unknown as Internals,unit=workers[0]!;
  unit.xMm=15000;unit.zMm=20000;unit.path=[{xMm:15500,zMm:19000},{xMm:18000,zMm:20000}];
  unit.pathRegions=[{region:'0,1',revision:0}];const original=structuredClone(unit.path);
  internal.simplifyMovementRoute(unit,new Navigation(64000,64000,[]),350);expect(unit.path).toEqual(original);
  unit.pathRegions.push({region:'1,1',revision:0});
  // The centreline misses the post, but the villager's radius overlaps it.
  const narrow=new Navigation(64000,64000,[{id:'post',xMm:17000,zMm:20400,halfWidth:100,halfHeight:100}]);
  expect(narrow.clearLine(unit,unit.path[1]!,0)).toBe(true);expect(narrow.clearLine(unit,unit.path[1]!,350)).toBe(false);
  internal.simplifyMovementRoute(unit,narrow,350);expect(unit.path).toEqual(original);
});

it('harvests a disclosed outer edge across touching patch identities while preserving the buried forest intent',()=>{
  const {simulation,workers,trees}=fixture(),target=trees[4]!,worker=workers[0]!,internal=simulation as unknown as Internals;
  for(const tree of trees){tree.amount=100000;tree.forest!.patchId=tree===target?'c'.repeat(64):'b'.repeat(64);}
  const unrelated:ResourceNode={...trees[0]!,id:'unrelated_forest',xMm:93000,zMm:93000,forest:{patchId:'d'.repeat(64),cellMm:3000}};
  const hidden:ResourceNode={...trees[0]!,id:'hidden_forest',xMm:125000,zMm:103000,forest:{patchId:'b'.repeat(64),cellMm:3000}};
  simulation.state.entities[unrelated.id]=unrelated;simulation.state.entities[hidden.id]=hidden;simulation.state.navigationRevision++;internal.updateVision();
  const visibleIds=new Set(simulation.view('a').entities.map(entity=>entity.id));
  expect(visibleIds.has(target.id)).toBe(true);expect(visibleIds.has(unrelated.id)).toBe(true);expect(visibleIds.has(hidden.id)).toBe(false);
  const receipt=simulation.command('a',{protocolVersion:2,matchId:simulation.state.matchId,matchEpoch:1,clientCommandId:'joined_forest_order',clientSequence:1,command:{kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false}});
  expect(receipt.status).toBe('accepted');simulation.step();
  expect(worker.resourceSearch?.purpose).toBe('forest');expect(worker.resourceSearch!.targetIds).not.toContain(unrelated.id);expect(worker.resourceSearch!.targetIds).not.toContain(hidden.id);
  expect(worker.resourceSearch!.targetIds.some(id=>trees.some(tree=>tree.id===id&&tree.forest!.patchId!==target.forest!.patchId))).toBe(true);
  for(let tick=0;tick<750&&worker.cargo.amount===0;tick++)simulation.step();
  expect(worker.cargo.resource).toBe('wood');expect(worker.cargo.amount).toBeGreaterThan(0);
  expect(worker.orders[0]?.forestIntentId).toBe(target.id);expect(worker.orders[0]?.targetId).not.toBe(target.id);
  const worked=simulation.state.entities[worker.orders[0]!.targetId!] as ResourceNode;
  expect(worked.forest!.patchId).toBe('b'.repeat(64));expect(visibleIds.has(worked.id)).toBe(true);expect(target.amount).toBe(100000);
},30000);

it('moves opposing mixed army columns through a 48m forest opening without entering solid trees',()=>{
  const {simulation}=fixture(0,0);
  // Keep the ordinary opponent alive but distant. Both columns belong to the
  // same faction, so this isolates physical movement from combat acquisition.
  let parked=0;
  for(const entity of Object.values(simulation.state.entities))if(entity.ownerId==='a'){
    entity.xMm=45000+parked++*2500;entity.zMm=45000;
  }
  const trees:ResourceNode[]=[],cellMm=balance.maps.forestNavigationCellM*1000;
  for(const edge of [76000,148000])for(let row=0;row<8;row++)for(let column=0;column<8;column++){
    const index=trees.length,tree:ResourceNode={id:`belt_pass_tree_${index}`,kind:'resource',ownerId:null,typeId:'tree_oak',resource:'wood',amount:100*balance.rules.resourceScale,
      xMm:100000+(column+.5)*cellMm,zMm:edge+(row+.5)*cellMm,hp:1,maxHp:1,forest:{cellMm,patchId:`belt_pass_${Math.floor(index/30)}`}};
    simulation.state.entities[tree.id]=tree;trees.push(tree);
  }
  const navigation=new Navigation(simulation.state.widthMm,simulation.state.heightMm,trees.map(tree=>({id:tree.id,xMm:tree.xMm,zMm:tree.zMm,halfWidth:cellMm/2,halfHeight:cellMm/2})));
  const columns:Unit[][]=[[],[]],types=['militia','light_cavalry','battering_ram'] as const;
  for(let side=0;side<2;side++)for(let index=0;index<12;index++){
    const typeId=types[index%types.length]!,definition=units[typeId],unit:Unit={id:`belt_pass_unit_${side}_${index}`,kind:'unit',ownerId:'a',typeId,hp:definition.maxHp,maxHp:definition.maxHp,
      xMm:side===0?95000-Math.floor(index/6)*2500:129000+Math.floor(index/6)*2500,zMm:(side===0?112000:136000)+(index%6-2.5)*2500,
      orders:[],path:[],pathRevision:0,cargo:{resource:null,amount:0},gatherRemainder:0,cooldown:0,stance:'stand_ground',repathAtTick:0,orderRevision:0};
    simulation.state.entities[unit.id]=unit;columns[side]!.push(unit);
  }
  simulation.state.navigationRevision++;(simulation as unknown as Internals).updateVision();
  // Twelve-unit formations span 12m along x: leave room for their rear rank
  // and the largest siege radius beyond both physical forest edges.
  const targets=[{xMm:132000,zMm:112000},{xMm:92000,zMm:136000}];
  for(const [side,column]of columns.entries())expect(simulation.command('a',{
    protocolVersion:2,matchId:simulation.state.matchId,matchEpoch:simulation.state.matchEpoch,clientCommandId:`belt_pass_${side}`,clientSequence:side+1,
    command:{kind:'move',unitIds:column.map(unit=>unit.id),target:targets[side]!,queued:false},
  })).toMatchObject({status:'accepted'});
  const army=columns.flat(),destinations=new Map(army.map(unit=>[unit.id,{...unit.orders[0]!.target!}])),crossed=new Set<string>();
  // Derive a finite deadline from actual unit speed and assigned destination.
  // Allow one additional traversal for local avoidance and five seconds for
  // bounded planner/formation admission.
  const directTicks=Math.max(...army.map(unit=>{const target=destinations.get(unit.id)!;return Math.hypot(unit.xMm-target.xMm,unit.zMm-target.zMm)/(units[unit.typeId].moveSpeedMps*1000)*balance.rules.simulationHz;}));
  const maximumTicks=Math.ceil(directTicks*2+5*balance.rules.simulationHz);
  for(const [side,column]of columns.entries())for(const unit of column){
    const target=destinations.get(unit.id)!,radius=units[unit.typeId].collisionRadiusM*1000;
    expect(side===0?target.xMm-radius>124000:target.xMm+radius<100000,`${unit.id} destination clears the forest`).toBe(true);
  }
  for(let tick=0;tick<maximumTicks&&army.some(unit=>unit.orders.length);tick++){
    const before=new Map(army.map(unit=>[unit.id,{xMm:unit.xMm,zMm:unit.zMm}]));simulation.step();
    for(const [side,column]of columns.entries())for(const unit of column){
      expect(navigation.clearLine(before.get(unit.id)!,unit,units[unit.typeId].collisionRadiusM*1000),`${unit.id} at tick ${simulation.state.tick}`).toBe(true);
      expect(unit.hp).toBe(unit.maxHp);
      if(side===0?unit.xMm>124850:unit.xMm<99150)crossed.add(unit.id);
    }
  }
  const pending=army.filter(unit=>unit.orders.length).map(unit=>({id:unit.id,type:unit.typeId,xMm:unit.xMm,zMm:unit.zMm,target:unit.orders[0]?.target,task:unit.taskState,blocked:unit.blockedReason}));
  expect(simulation.state.status).toBe('RUNNING');expect(crossed.size,JSON.stringify({maximumTicks,pending})).toBe(army.length);
  for(const unit of army){
    expect(unit.orders,unit.id).toHaveLength(0);
    const target=destinations.get(unit.id)!;expect(Math.hypot(unit.xMm-target.xMm,unit.zMm-target.zMm),unit.id).toBeLessThanOrEqual(150);
  }
  expect(trees.every(tree=>tree.amount===100*balance.rules.resourceScale)).toBe(true);
},30000);
