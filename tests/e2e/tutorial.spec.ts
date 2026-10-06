import { capture } from './capture';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Locator } from '@playwright/test';
import type { BalanceData, BuildingId, GameplayCommand, Position, ViewEntity } from '@frontier/shared';
import { terrainBuildable, terrainHeightAt, terrainObstacles } from '../../packages/shared/src/terrain';

const content=JSON.parse(readFileSync('data/balance.v1.json','utf8')) as BalanceData;
const buildings=Object.fromEntries(content.buildings.map(building=>[building.id,building]));
const bootstrap='tutorial-browser-isolated-fixture-token';
let server:ChildProcess|undefined,origin='',serverOutput='';

test.beforeAll(async()=>{
  const listener=createServer();await new Promise<void>((done,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',done);});
  const address=listener.address();if(!address||typeof address==='string')throw new Error('No tutorial fixture port');const port=address.port;
  await new Promise<void>((done,reject)=>listener.close(error=>error?reject(error):done()));origin=`http://127.0.0.1:${port}`;
  await mkdir('runtime-data/e2e',{recursive:true});
  server=spawn(process.execPath,['dist/server/index.js'],{windowsHide:true,env:{...process.env,NODE_ENV:'production',GAME_PORT:String(port),GAME_BIND:'127.0.0.1',GAME_LAN_MODE:'false',GAME_DATA_DIR:`runtime-data/e2e-tutorial-${port}`,HOST_ADMIN_BOOTSTRAP_TOKEN:bootstrap},stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr])stream?.on('data',chunk=>{serverOutput=(serverOutput+chunk.toString()).slice(-10000);});
  await expect.poll(async()=>{if(server?.exitCode!==null)throw new Error(`Tutorial host exited: ${serverOutput}`);return fetch(`${origin}/api/health`).then(response=>response.ok).catch(()=>false);},{timeout:20000}).toBe(true);
});
test.afterAll(async()=>{if(server&&server.exitCode===null){const closed=new Promise<void>(done=>server!.once('exit',()=>done()));server.kill('SIGTERM');await closed;}});

test('M7 all nine quiet-practice lessons use real UI, normal resources, actual production and visible combat',async({browser},testInfo)=>{
  test.setTimeout(1_200_000);
  const context=await browser.newContext({viewport:{width:1280,height:720}}),host=await context.newPage();host.setDefaultTimeout(12000);
  const state=capture(host),progress=host.getByRole('progressbar',{name:'Tutorial progress'});
  let playerId='',base:ViewEntity|undefined;
  const mine=()=>state.view!.entities.filter(entity=>entity.ownerId===playerId&&!entity.ghost);
  const entity=(id:string)=>state.view!.entities.find(item=>item.id===id);
  async function accepted<K extends GameplayCommand['kind']>(kind:K,before:number){
    await expect.poll(()=>state.commands.slice(before).some(envelope=>envelope.command.kind===kind)).toBe(true);
    const envelope=state.commands.slice(before).find(item=>item.command.kind===kind)!;
    await expect.poll(()=>state.receipts.find(receipt=>receipt.clientCommandId===envelope.clientCommandId)?.status).toBe('accepted');return envelope;
  }
  async function milestone(name:string,count:number){
    await expect(progress).toHaveAttribute('value',String(count));
    await host.screenshot({path:`runtime-data/e2e/m7-tutorial-${name}.png`});
    await testInfo.attach(`tutorial-${name}-authorized-evidence`,{body:JSON.stringify({view:state.view,commands:state.commands,receipts:state.receipts,protocolErrors:state.protocolErrors}),contentType:'application/json'});
    console.log(`M7 tutorial: ${name}, ${count}/9, tick ${state.view!.tick}, bank ${JSON.stringify(state.view!.self.resources)}.`);
  }
  async function slider(control:Locator,value:number,min:number,step=1){await control.focus();await control.press('Home');for(let next=min;next<value;next+=step)await control.press('ArrowRight');await expect(control).toHaveValue(String(value));}
  async function minimapOrder(point:Position){const rect=(await host.getByTestId('minimap').boundingBox())!;await host.mouse.click(rect.x+point.xMm/state.view!.map.widthMm*rect.width,rect.y+point.zMm/state.view!.map.heightMm*rect.height,{button:'right'});}
  function scoutBlockers(point:Position):string[]{
    const view=state.view!,radius=content.units.find(unit=>unit.id==='scout')!.collisionRadiusM*1000;
    if(point.xMm<radius||point.zMm<radius||point.xMm>view.map.widthMm-radius||point.zMm>view.map.heightMm-radius)return ['map-boundary'];
    const intersects=(xMm:number,zMm:number,halfWidth:number,halfHeight:number)=>Math.hypot(Math.max(0,Math.abs(point.xMm-xMm)-halfWidth),Math.max(0,Math.abs(point.zMm-zMm)-halfHeight))<radius;
    const blocked=terrainObstacles(view.map.terrain??[]).filter(item=>intersects(item.xMm,item.zMm,item.halfWidth,item.halfHeight)).map(item=>item.id);
    // Recipient records only, including remembered occupancy. A depleted tree
    // no longer occupies its forest cell. Moving units are not static blockers.
    for(const item of view.entities){
      if(item.kind==='unit'||item.hp<=0||item.kind==='resource'&&(item.amount??0)<=0)continue;
      const definition=buildings[item.typeId];let halfX=definition?definition.footprintCells[0]*content.rules.buildingGridM*500:item.forest?item.forest.cellMm/2:item.resource==='wood'?450:650,halfZ=definition?definition.footprintCells[1]*content.rules.buildingGridM*500:halfX;
      if((item.rotation??0)%180)[halfX,halfZ]=[halfZ,halfX];if(intersects(item.xMm,item.zMm,halfX,halfZ))blocked.push(item.id);
    }
    return blocked;
  }
  async function scoutOrder(preferred:Position,scoutId:string,attempted=new Set<string>()):Promise<Position>{
    await host.getByRole('button',{name:'Select army',exact:true}).click();await host.keyboard.press('2');
    const rect=(await host.getByTestId('minimap').boundingBox())!,map=state.view!.map;
    const offsets=Array.from({length:49},(_,index)=>({x:(index%7-3)*4000,z:(Math.floor(index/7)-3)*4000})).sort((a,b)=>Math.hypot(a.x,a.z)-Math.hypot(b.x,b.z)||a.z-b.z||a.x-b.x);
    for(const offset of offsets){
      // Integer DOM coordinates remove mouse-event rounding ambiguity. Validate
      // GameHud's resulting world coordinate, rather than the intended waypoint.
      const x=Math.round(rect.x+(preferred.xMm+offset.x)/map.widthMm*rect.width),y=Math.round(rect.y+(preferred.zMm+offset.z)/map.heightMm*rect.height);
      if(x<rect.x||y<rect.y||x>=rect.x+rect.width||y>=rect.y+rect.height)continue;
      const point={xMm:Math.min(map.widthMm-1,Math.round((x-rect.x)/rect.width*map.widthMm)),zMm:Math.min(map.heightMm-1,Math.round((y-rect.y)/rect.height*map.heightMm))},key=`${point.xMm},${point.zMm}`;
      if(attempted.has(key)||scoutBlockers(point).length)continue;
      attempted.add(key);const before=state.commands.length;await host.mouse.click(x,y,{button:'right'});const envelope=await accepted('move',before);
      if(envelope.command.kind!=='move')throw new Error('Missing ordinary Scout move');
      expect(envelope.command.unitIds,'The remembered control group must select only the Scout').toEqual([scoutId]);expect(envelope.command.target).toEqual(point);expect(scoutBlockers(envelope.command.target),'The actual minimap target must clear known occupancy and the Scout radius').toEqual([]);
      console.log(`M7 tutorial: ordinary Scout move to legal minimap coordinate (${point.xMm},${point.zMm}).`);return point;
    }
    throw new Error(`No legal disclosed Scout waypoint among 49 public candidates near (${preferred.xMm},${preferred.zMm}).`);
  }
  async function focus(point:Position):Promise<Position>{
    const minimap=host.getByTestId('minimap'),rect=(await minimap.boundingBox())!,tag=`TUTORIAL_FOCUS_${state.view!.tick}_${point.xMm}`;
    // Read only the coordinates of the real DOM click, including browser rounding.
    await minimap.evaluate((element,{map,tag})=>element.addEventListener('click',event=>{const e=event as MouseEvent,bounds=element.getBoundingClientRect();console.debug(tag+' '+JSON.stringify({xMm:Math.round((e.clientX-bounds.left)/bounds.width*map.widthMm),zMm:Math.round((e.clientY-bounds.top)/bounds.height*map.heightMm)}));},{once:true}),{map:state.view!.map,tag});
    const observed=host.waitForEvent('console',message=>message.text().startsWith(tag+' '));await host.mouse.click(Math.round(rect.x+point.xMm/state.view!.map.widthMm*rect.width),Math.round(rect.y+point.zMm/state.view!.map.heightMm*rect.height));return JSON.parse((await observed).text().slice(tag.length+1)) as Position;
  }
  function screen(point:Position,elevation=0,target:Position=base!){
    const viewport=host.viewportSize()!,alpha=-Math.PI/2.6,beta=.82,radius=45,offset=[radius*Math.cos(alpha)*Math.sin(beta),radius*Math.cos(beta),radius*Math.sin(alpha)*Math.sin(beta)];
    const forward=offset.map(value=>-value/radius),right=[Math.cos(alpha+Math.PI/2),0,Math.sin(alpha+Math.PI/2)],up=[forward[1]!*right[2]!,forward[2]!*right[0]!-forward[0]!*right[2]!,-forward[1]!*right[0]!];
    const ground=terrainHeightAt(state.view!.map.terrain??[],target.xMm,target.zMm)/1000,relative=[(point.xMm-target.xMm)/1000-offset[0]!,elevation-ground-offset[1]!, (point.zMm-target.zMm)/1000-offset[2]!];
    const dot=(direction:number[])=>relative.reduce((sum,value,index)=>sum+value*direction[index]!,0),scale=viewport.height/(2*Math.tan(.4));
    return{x:viewport.width/2+dot(right)*scale/dot(forward),y:viewport.height/2-dot(up)*scale/dot(forward)};
  }
  const grid=content.rules.buildingGridM*1000;
  function clearSite(x:number,z:number,width:number,depth:number){
    const view=state.view!,bounds={xMm:x*grid,zMm:z*grid,widthMm:width*grid,depthMm:depth*grid},columns=Math.ceil(view.map.widthMm/view.map.fogCellMm),visible=new Set(view.fog.visible);
    if(bounds.xMm<0||bounds.zMm<0||bounds.xMm+bounds.widthMm>=view.map.widthMm||bounds.zMm+bounds.depthMm>=view.map.heightMm||!terrainBuildable(view.map.terrain??[],bounds))return false;
    for(let dz=0;dz<depth;dz++)for(let dx=0;dx<width;dx++)if(!visible.has(Math.floor((bounds.zMm+(dz+.5)*grid)/view.map.fogCellMm)*columns+Math.floor((bounds.xMm+(dx+.5)*grid)/view.map.fogCellMm)))return false;
    return !view.entities.some(item=>{const definition=buildings[item.typeId];let halfX=definition?definition.footprintCells[0]*grid/2:item.kind==='unit'?900:item.forest?item.forest.cellMm/2:item.resource==='wood'?800:1000,halfZ=definition?definition.footprintCells[1]*grid/2:halfX;if((item.rotation??0)%180)[halfX,halfZ]=[halfZ,halfX];return item.xMm+halfX>bounds.xMm-350&&item.xMm-halfX<bounds.xMm+bounds.widthMm+350&&item.zMm+halfZ>bounds.zMm-350&&item.zMm-halfZ<bounds.zMm+bounds.depthMm+350;});
  }
  function candidates(width:number,depth:number){const found:{x:number;z:number;distance:number}[]=[];for(let dx=-18000;dx<=18000;dx+=grid)for(let dz=-18000;dz<=18000;dz+=grid){const x=Math.round((base!.xMm+dx-width*grid/2)/grid),z=Math.round((base!.zMm+dz-depth*grid/2)/grid);if(clearSite(x,z,width,depth))found.push({x,z,distance:Math.hypot(dx,dz)});}return found.sort((a,b)=>a.distance-b.distance||a.z-b.z||a.x-b.x);}
  async function selectWorkers(){await host.getByRole('button',{name:'Select villagers',exact:true}).click();await host.getByRole('tab',{name:'economy',exact:true}).click();}
  async function gather(resource:'food'|'wood'|'gold'){await selectWorkers();await expect(host.getByRole('button',{name:`Gather ${resource}`,exact:true})).toBeEnabled();const before=state.commands.length;await host.getByRole('button',{name:`Gather ${resource}`,exact:true}).click();return accepted('gather',before);}
  async function place(type:BuildingId){
    const definition=buildings[type]!,beforeIds=new Set(mine().filter(item=>item.typeId===type).map(item=>item.id));
    await host.getByRole('button',{name:'Select Town Center',exact:true}).click();await selectWorkers();
    for(const site of candidates(definition.footprintCells[0],definition.footprintCells[1]).slice(0,24)){
      const point={xMm:(site.x+.45)*grid,zMm:(site.z+.45)*grid},pixel=screen(point,terrainHeightAt(state.view!.map.terrain??[],point.xMm,point.zMm)/1000);
      if(pixel.x<360||pixel.x>1130||pixel.y<180||pixel.y>605)continue;
      await host.getByRole('button',{name:`Build ${definition.name}`,exact:true}).click();await host.mouse.move(pixel.x,pixel.y);
      if(!(await host.locator('.placement-notice').innerText()).includes('Clear visible site')){await host.keyboard.press('Escape');await selectWorkers();continue;}
      const before=state.commands.length;await host.mouse.click(pixel.x,pixel.y);await accepted('build',before);
      await expect.poll(()=>mine().some(item=>item.typeId===type&&!beforeIds.has(item.id))).toBe(true);const created=mine().find(item=>item.typeId===type&&!beforeIds.has(item.id))!;
      await expect.poll(()=>entity(created.id)?.progress,{timeout:70000}).toBe(1);return created;
    }
    throw new Error(`No clear canvas ${type} site after checking authorized terrain, fog, footprints and previews.`);
  }
  try{
    await host.goto(origin);await host.getByRole('tab',{name:'Host access'}).click();await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap);await host.getByRole('button',{name:'Open host controls'}).click();await expect(host.locator('.invite-code')).toBeVisible();
    await host.getByLabel('Private map seed').fill('m7-guided-practice-browser');await host.getByRole('button',{name:'Set seed',exact:true}).click();await expect(host.getByRole('button',{name:'Set seed',exact:true})).toBeDisabled();
    await host.getByRole('checkbox',{name:'Guided quiet practice',exact:true}).click();await expect(host.getByRole('checkbox',{name:'Guided quiet practice',exact:true})).toBeChecked();await expect(host.getByLabel('AI COMMANDERS')).toHaveValue('1');
    await host.getByLabel('YOUR NAME').fill('Tutorial Aster');await host.getByRole('button',{name:'Join as host-player'}).click();

    await host.getByRole('button',{name:'Settings & controls',exact:true}).click();const settings=host.getByRole('dialog',{name:'Settings & controls'});
    for(const value of [80,150]){
      await slider(host.getByLabel('Interface scale'),value,80,5);await expect(settings).toBeVisible();await expect(host.getByRole('button',{name:'Close settings'})).toBeInViewport();
      expect(await host.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
      await host.screenshot({path:`runtime-data/e2e/m7-settings-${value}-1280.png`});
    }
    await slider(host.getByLabel('Music volume'),20,0);await slider(host.getByLabel('Effects volume'),65,0);await host.getByRole('checkbox',{name:'Mute all sound'}).check();await expect(host.getByLabel('Music volume')).toHaveValue('20');await expect(host.getByLabel('Effects volume')).toHaveValue('65');
    for(const [action,key]of [['Next idle Villager','i'],['Return to base','End'],['Stop','k']]){await host.getByRole('button',{name:`Rebind ${action}`,exact:true}).click();await host.keyboard.press(key!);await expect(host.getByRole('button',{name:`Rebind ${action}`,exact:true})).toHaveText(key==='End'?'End':key!.toUpperCase());}
    await slider(host.getByLabel('Interface scale'),100,80,5);await host.getByRole('checkbox',{name:'Mute all sound'}).uncheck();await host.getByRole('button',{name:'Close settings',exact:true}).click();
    await host.setViewportSize({width:1440,height:900});await host.getByRole('button',{name:'Ready to begin'}).click();await host.getByRole('button',{name:'Begin match'}).click();
    await expect.poll(()=>state.view?.status,{timeout:45000}).toBe('RUNNING');playerId=state.view!.playerId;base=mine().find(item=>item.typeId==='town_center')!;
    expect(state.view!.self.resources).toEqual(content.start.resources);expect(mine().filter(item=>item.typeId==='villager')).toHaveLength(content.start.units.villager);expect(state.view!.players).toHaveLength(2);
    const initialIds=new Set(mine().map(item=>item.id)),initialFog=new Set(state.view!.fog.explored);
    await expect(host.getByRole('region',{name:'Guided first game'})).toBeVisible();

    // Lesson 1 uses the genuinely rebound idle-worker shortcut.
    await host.keyboard.press('i');await expect(host.locator('.selection-heading h2')).toHaveText('Villager');await milestone('01-selection',1);
    // A minimap order is an ordinary pointer-generated move, observed on the wire.
    const moveBefore=state.commands.length;await minimapOrder({xMm:base.xMm-6500,zMm:base.zMm+16500});const move=await accepted('move',moveBefore);expect(move.command.kind).toBe('move');
    await expect(progress).toHaveAttribute('value','2',{timeout:30000});await milestone('02-movement',2);

    // Modal key suppression is tested with a selected unit while the match runs.
    await host.getByRole('button',{name:'Game settings',exact:true}).click();const commandCount=state.commands.length;await expect(host.getByRole('button',{name:'Close settings'})).toBeFocused();await host.keyboard.press('k');await host.keyboard.press('i');await host.keyboard.press('End');
    const modalTick=state.view!.tick;await expect.poll(()=>state.view!.tick).toBeGreaterThan(modalTick+5);expect(state.commands.length).toBe(commandCount);await host.getByRole('button',{name:'Close settings'}).click();
    const stoppedBefore=state.commands.length;await host.keyboard.press('k');await accepted('stop',stoppedBefore);
    await focus({xMm:base.xMm+30000,zMm:base.zMm+30000});await host.keyboard.press('End');const homePixel=screen(base,3);await host.mouse.click(homePixel.x,homePixel.y);await expect(host.locator('.selection-heading h2')).toHaveText('Town Center');

    const foodBefore=state.view!.self.resources.food;await gather('food');await expect.poll(()=>mine().some(item=>(item.cargo?.amount??0)>0),{timeout:30000}).toBe(true);await expect.poll(()=>state.view!.self.resources.food,{timeout:60000}).toBeGreaterThan(foodBefore);await milestone('03-cargo-deposit',3);
    const house=await place('house');expect(initialIds.has(house.id)).toBe(false);await milestone('04-completed-house',4);

    // Save and reload a paused real match; local lesson history must survive without
    // inventing a fresh baseline that would count existing buildings as new work.
    const journalTick=state.view!.tick;await expect.poll(()=>state.view!.tick).toBeGreaterThan(journalTick+content.rules.simulationHz+2);
    await host.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>state.view!.status).toBe('PAUSED');
    await host.getByRole('button',{name:'Saves and recovery',exact:true}).click();await host.getByLabel('Save name').fill('Tutorial after real house');await host.getByRole('button',{name:'Save match'}).click();await expect(host.getByRole('status').filter({hasText:'Save written successfully'})).toBeVisible();await host.getByRole('button',{name:'Close saves and recovery'}).click();
    const fullBefore=state.fullViews;await host.reload();await expect.poll(()=>state.fullViews,{timeout:30000}).toBeGreaterThan(fullBefore);await expect.poll(()=>state.view?.status).toBe('PAUSED');await expect(progress).toHaveAttribute('value','4');await expect(host.getByRole('region',{name:'Guided first game'})).toContainText('Lessons wait');
    await host.getByRole('button',{name:'Game settings',exact:true}).click();await expect(host.getByRole('button',{name:'Rebind Next idle Villager'})).toHaveText('I');await expect(host.getByRole('button',{name:'Rebind Stop',exact:true})).toHaveText('K');await expect(host.getByLabel('Music volume')).toHaveValue('20');await expect(host.getByLabel('Effects volume')).toHaveValue('65');await host.getByRole('button',{name:'Close settings'}).click();
    await host.getByRole('button',{name:'Resume',exact:true}).click();await expect.poll(()=>state.view!.status).toBe('RUNNING');

    await host.getByRole('button',{name:'Select Town Center',exact:true}).click();const trainBefore=state.commands.length;await host.getByRole('button',{name:'Train Villager',exact:true}).click();await accepted('train',trainBefore);await gather('wood');
    await expect.poll(()=>mine().filter(item=>item.typeId==='villager').length,{timeout:45000}).toBe(content.start.units.villager+1);await milestone('05-trained-villager',5);
    // Remember the existing scout via the normal control-group hotkey, before army
    // production. It will explore unexplored fog in the final lesson.
    await host.getByRole('button',{name:'Select army',exact:true}).click();await host.keyboard.press('Control+2');await host.getByLabel('Unit stance').selectOption('stand_ground');
    await gather('wood');const requiredWood=buildings.palisade_wall!.cost.wood*3+buildings.barracks!.cost.wood+buildings.mill!.cost.wood;
    console.log(`M7 tutorial: gathering the ordinary ${requiredWood} wood needed for three walls, Barracks and Mill.`);
    await expect.poll(()=>state.view!.self.resources.wood,{timeout:120000}).toBeGreaterThanOrEqual(requiredWood);

    await host.getByRole('button',{name:'Select Town Center',exact:true}).click();await selectWorkers();await host.getByRole('button',{name:'Stop selected units',exact:true}).click();
    let wallCommand:ReturnType<typeof state.commands.at>|undefined;
    for(const site of candidates(3,1).slice(0,30)){
      const begin=screen({xMm:(site.x+.5)*grid,zMm:(site.z+.5)*grid}),end=screen({xMm:(site.x+2.5)*grid,zMm:(site.z+.5)*grid});
      if([begin,end].some(point=>point.x<365||point.x>1130||point.y<190||point.y>595))continue;
      await selectWorkers();await host.getByRole('tab',{name:'fortifications',exact:true}).click();await host.getByRole('button',{name:'Build Palisade Wall',exact:true}).click();await host.mouse.move(begin.x,begin.y);await host.mouse.down();await host.mouse.move(end.x,end.y,{steps:10});
      const valid=(await host.locator('.placement-notice').innerText()).includes('Clear visible wall path'),before=state.commands.length;
      if(!valid){await host.keyboard.press('Escape');await host.mouse.up();continue;}await host.mouse.up();wallCommand=await accepted('build_wall',before);break;
    }
    expect(wallCommand?.command.kind).toBe('build_wall');if(wallCommand!.command.kind!=='build_wall')throw new Error('Missing ordinary wall order');const cells=wallCommand!.command.cells;expect(cells.length).toBeGreaterThanOrEqual(3);
    console.log(`M7 tutorial: accepted ${cells.length} wall cells; waiting for actual worker construction.`);
    await expect.poll(()=>cells.every(cell=>mine().some(item=>item.typeId==='palisade_wall'&&item.progress===1&&Math.floor(item.xMm/grid)===cell.x&&Math.floor(item.zMm/grid)===cell.z)),{timeout:80000}).toBe(true);await milestone('06-real-palisades',6);

    const barracks=await place('barracks');await gather('food');const militia=content.units.find(unit=>unit.id==='militia')!;
    await expect.poll(()=>state.view!.self.resources.food,{timeout:90000}).toBeGreaterThanOrEqual(militia.cost.food*3);
    await host.getByLabel('Select building',{exact:true}).selectOption(barracks.id);await host.getByLabel('Training quantity').selectOption('3');const troopsBefore=state.commands.length;await host.getByRole('button',{name:'Train Militia',exact:true}).click();await accepted('train',troopsBefore);
    await selectWorkers();await place('mill');await gather('food');await expect.poll(()=>mine().filter(item=>item.typeId==='militia'&&!initialIds.has(item.id)).length,{timeout:100000}).toBe(3);await milestone('07-company-produced',7);

    // Discover mining legally with the remembered scout. No seed-derived locations
    // or hidden entities enter the controller; each direction is a public map probe.
    const scoutId=mine().find(item=>item.typeId==='scout')!.id;
    if(!state.view!.entities.some(item=>item.resource==='gold'&&!item.ghost)){
      for(const [dx,dz]of [[-16000,-16000],[0,-21000],[16000,-16000],[-22000,0]]){
        await scoutOrder({xMm:base.xMm+dx!,zMm:base.zMm+dz!},scoutId);
        try{await expect.poll(()=>state.view!.entities.some(item=>item.resource==='gold'&&!item.ghost),{timeout:18000}).toBe(true);break;}catch{/* The next ordinary scouting direction may reveal an accessible seam. */}
      }
    }
    await gather('gold');const age=content.ages.find(item=>item.id===2)!;console.log(`M7 tutorial: mining and depositing ${age.cost.gold} gold for Settlement Age; current ${state.view!.self.resources.gold}.`);await expect.poll(()=>state.view!.self.resources.gold,{timeout:150000}).toBeGreaterThanOrEqual(age.cost.gold);
    await gather('food');console.log(`M7 tutorial: gathering and depositing ${age.cost.food} food; current ${state.view!.self.resources.food}.`);await expect.poll(()=>state.view!.self.resources.food,{timeout:270000}).toBeGreaterThanOrEqual(age.cost.food);
    await host.getByRole('button',{name:'Select Town Center',exact:true}).click();await host.getByRole('tab',{name:'Research & ages',exact:true}).click();const advanceBefore=state.commands.length;await host.getByRole('button',{name:`Advance to ${age.name}`,exact:true}).click();await accepted('advance_age',advanceBefore);
    const ageStart=state.view!.tick;await expect.poll(()=>entity(base!.id)?.queue?.[0]?.kind).toBe('age');await expect(progress).toHaveAttribute('value','7');await host.screenshot({path:'runtime-data/e2e/m7-tutorial-age-in-progress.png'});console.log(`M7 tutorial: the paid age job is active for its real ${age.researchSeconds}-second duration.`);
    await expect.poll(()=>state.view!.self.age,{timeout:125000}).toBe(2);expect(state.view!.tick-ageStart).toBeGreaterThanOrEqual(age.researchSeconds*content.rules.simulationHz-10);await milestone('08-normal-age',8);

    const exploredBefore=new Set(state.view!.fog.explored),direction=base.xMm<state.view!.map.widthMm/2?1:-1;
    const enemyHouse=()=>state.view!.entities.filter(item=>item.ownerId&&item.ownerId!==playerId&&!item.ghost&&item.typeId==='house').sort((a,b)=>Math.hypot(a.xMm-entity(scoutId)!.xMm,a.zMm-entity(scoutId)!.zMm)-Math.hypot(b.xMm-entity(scoutId)!.xMm,b.zMm-entity(scoutId)!.zMm))[0];
    for(let step=1;step<=12&&!enemyHouse();step++){
      const point={xMm:Math.max(16000,Math.min(state.view!.map.widthMm-16000,base.xMm+direction*step*18000)),zMm:Math.max(16000,Math.min(state.view!.map.heightMm-16000,step<9?base.zMm:base.zMm+(step%2?1:-1)*25000))};
      console.log(`M7 tutorial: Scout explores public waypoint ${step} (${point.xMm},${point.zMm}); no hidden target information.`);
      const attempted=new Set<string>();
      for(let attempt=0;attempt<3;attempt++){
        const actual=await scoutOrder(point,scoutId,attempted);
        try{await expect.poll(()=>Boolean(enemyHouse())||!!entity(scoutId)&&Math.hypot(entity(scoutId)!.xMm-actual.xMm,entity(scoutId)!.zMm-actual.zMm)<5000,{timeout:45000}).toBe(true);break;}
        catch(error){
          // A newly disclosed occupied destination justifies a nearby public
          // alternative. Unexplained route/arrival failures remain test failures.
          const blockers=scoutBlockers(actual);if(!blockers.length||attempt===2)throw error;
          console.log(`M7 tutorial: newly disclosed occupancy blocks (${actual.xMm},${actual.zMm}): ${blockers.join(',')}; selecting a nearby legal public target.`);
        }
      }
    }
    const target=enemyHouse();expect(target,'A live practice house must be found through real fog exploration').toBeDefined();expect(state.view!.fog.explored.some(cell=>!exploredBefore.has(cell))).toBe(true);expect(state.view!.fog.explored.length).toBeGreaterThan(initialFog.size);
    await host.getByRole('button',{name:'Select army',exact:true}).click();await host.getByLabel('Unit stance').selectOption('stand_ground');const camera=await focus(target!),pixel=screen(target!,2,camera),attackBefore=state.commands.length,hp=target!.hp;
    await host.mouse.click(pixel.x,pixel.y,{button:'right'});const attack=await accepted('attack_target',attackBefore);expect(attack.command.kind==='attack_target'&&attack.command.targetId).toBe(target!.id);
    await expect.poll(()=>{const live=entity(target!.id);return live&&!live.ghost&&live.hp<hp||state.view!.effects?.some(effect=>effect.kind==='death'&&effect.entityId===target!.id);},{timeout:90000}).toBe(true);await milestone('09-visible-combat',9);await expect(host.getByRole('region',{name:'Guided first game'})).toContainText('You completed every lesson through real game actions.');
    expect(state.errors).toEqual([]);expect(state.protocolErrors).toEqual([]);expect(state.receipts.filter(receipt=>receipt.status==='rejected')).toEqual([]);
    const recordedKinds=new Set(state.commands.map(envelope=>envelope.command.kind));for(const kind of ['move','gather','build','train','build_wall','advance_age','attack_target'])expect(recordedKinds.has(kind as GameplayCommand['kind']),kind).toBe(true);
    await host.getByRole('button',{name:'End as draw',exact:true}).click();await host.getByRole('button',{name:'Confirm draw',exact:true}).click();await expect(host.getByTestId('match-results')).toContainText('Draw');
  }catch(error){await testInfo.attach('tutorial-failure-authorized-state',{body:JSON.stringify({state,serverOutput}),contentType:'application/json'});await host.screenshot({path:'runtime-data/e2e/m7-tutorial-failure.png'}).catch(()=>undefined);throw error;}
  finally{await context.close();}
});
