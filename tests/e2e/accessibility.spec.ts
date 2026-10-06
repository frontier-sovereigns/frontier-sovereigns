import { expect, test, type Locator } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { capture } from './capture';
import { terrainHeightAt } from '../../packages/shared/src/terrain';

const content=JSON.parse(readFileSync('data/balance.v1.json','utf8')) as {technologies:{id:string}[]};
const bootstrap='accessibility-browser-isolated-fixture-token';
let server:ChildProcess|undefined,origin='',output='';
test.beforeAll(async()=>{
  const listener=createServer();await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
  const address=listener.address();if(!address||typeof address==='string')throw new Error('Missing accessibility fixture port');const port=address.port;
  await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));origin=`http://127.0.0.1:${port}`;
  server=spawn(process.execPath,['dist/server/index.js'],{windowsHide:true,env:{...process.env,NODE_ENV:'production',GAME_PORT:String(port),GAME_BIND:'127.0.0.1',GAME_LAN_MODE:'false',GAME_DATA_DIR:`runtime-data/e2e-accessibility-${port}`,HOST_ADMIN_BOOTSTRAP_TOKEN:bootstrap},stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr])stream?.on('data',chunk=>{output=(output+chunk.toString()).slice(-6000);});
  await expect.poll(async()=>{if(server?.exitCode!==null)throw new Error(output);return fetch(`${origin}/api/health`).then(response=>response.ok).catch(()=>false);},{timeout:20000}).toBe(true);
});
test.afterAll(async()=>{if(server&&server.exitCode===null){const closed=new Promise<void>(resolve=>server!.once('exit',()=>resolve()));server.kill('SIGTERM');await closed;}});

test('M7 game HUD and technology controls remain usable at 1280x720 with 80 and 150 percent interface scales',async({browser},testInfo)=>{
  test.setTimeout(120000);const context=await browser.newContext({viewport:{width:1280,height:720}}),page=await context.newPage(),state=capture(page),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    // Observe the real Web Audio graph without changing its connections, sounds
    // or gains. This verifies the audible path's controls, not speaker hardware.
    const gains:GainNode[]=[],edges=new Map<AudioNode,AudioNode[]>(),createGain=AudioContext.prototype.createGain,connect=AudioNode.prototype.connect;
    AudioContext.prototype.createGain=function(){const gain=createGain.call(this);gains.push(gain);return gain;};
    AudioNode.prototype.connect=function(this:AudioNode,...args:unknown[]){const result=Reflect.apply(connect,this,args);if(args[0] instanceof AudioNode){const destinations=edges.get(this)??[];destinations.push(args[0]);edges.set(this,destinations);}return result;} as typeof connect;
    Reflect.set(window,'__qaAudioGains',()=>{
      const master=gains.find(gain=>edges.get(gain)?.some(node=>node instanceof AudioDestinationNode));
      const music=[...edges].find(([node])=>node instanceof AudioBufferSourceNode&&node.loop)?.[1].find(node=>node instanceof GainNode) as GainNode|undefined;
      const effects=gains.find(gain=>gain!==music&&edges.get(gain)?.includes(master!));
      return {state:master?.context.state,master:master?.gain.value,music:music?.gain.value,effects:effects?.gain.value};
    });
  });
  const whollyVisible=async(control:Locator)=>{await expect(control).toBeVisible();const rect=(await control.boundingBox())!;expect(rect.x).toBeGreaterThanOrEqual(-1);expect(rect.y).toBeGreaterThanOrEqual(-1);expect(rect.x+rect.width).toBeLessThanOrEqual(1281);expect(rect.y+rect.height).toBeLessThanOrEqual(721);expect(await control.evaluate(element=>{const rect=element.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return hit===element||element.contains(hit);})).toBe(true);};
  const accepted=async(kind:string,before:number)=>{await expect.poll(()=>state.commands.slice(before).find(command=>command.command.kind===kind)?.clientCommandId).toBeTruthy();const command=state.commands.slice(before).find(command=>command.command.kind===kind)!;await expect.poll(()=>state.receipts.find(receipt=>receipt.clientCommandId===command.clientCommandId)?.status).toBe('accepted');};
  try{
    await mkdir('runtime-data/e2e',{recursive:true});await page.goto(origin);await page.getByRole('tab',{name:'Host access'}).click();await page.getByLabel('HOST ACCESS TOKEN').fill(bootstrap);await page.getByRole('button',{name:'Open host controls'}).click();await expect(page.locator('.invite-code')).toBeVisible();
    await page.getByLabel('AI COMMANDERS').selectOption('1');await expect(page.getByLabel('AI COMMANDERS')).toHaveValue('1');
    await page.getByLabel('YOUR NAME').fill('Layout Aster');await page.getByRole('button',{name:'Join as host-player'}).click();await page.getByRole('button',{name:'Ready to begin'}).click();await page.getByRole('button',{name:'Begin match'}).click();
    await expect.poll(()=>state.view?.status,{timeout:45000}).toBe('RUNNING');
    // Hover and actual pointer dispatch share the same recipient-visible target.
    // Recenter through the real minimap; no renderer handles or hidden state.
    await page.getByRole('button',{name:'Select villagers',exact:true}).click();
    async function targetPixel(point:{xMm:number;zMm:number},height:number,lookAheadMm=0){
      await page.keyboard.press('Home');
      const snapshot=state.view!,box=(await page.getByTestId('minimap').boundingBox())!;
      const alpha=-Math.PI/2.6;
      const x=Math.round(box.x+(point.xMm+Math.cos(alpha)*lookAheadMm)/snapshot.map.widthMm*box.width),y=Math.round(box.y+(point.zMm+Math.sin(alpha)*lookAheadMm)/snapshot.map.heightMm*box.height);
      await page.mouse.click(x,y);
      const focus={xMm:Math.round((x-box.x)/box.width*snapshot.map.widthMm),zMm:Math.round((y-box.y)/box.height*snapshot.map.heightMm)};
      const beta=.82,radius=45,offset=[radius*Math.cos(alpha)*Math.sin(beta),radius*Math.cos(beta),radius*Math.sin(alpha)*Math.sin(beta)];
      const forward=offset.map(value=>-value/radius),right=[-Math.sin(alpha),0,Math.cos(alpha)],up=[forward[1]!*right[2]!,forward[2]!*right[0]!-forward[0]!*right[2]!,-forward[1]!*right[0]!];
      const terrain=snapshot.map.terrain??[],elevation=(terrainHeightAt(terrain,point.xMm,point.zMm)-terrainHeightAt(terrain,focus.xMm,focus.zMm))/1000;
      const relative=[(point.xMm-focus.xMm)/1000-offset[0]!,elevation+height-offset[1]!, (point.zMm-focus.zMm)/1000-offset[2]!];
      const dot=(axis:number[])=>relative.reduce((sum,value,index)=>sum+value*axis[index]!,0),scale=720/(2*Math.tan(.4));
      return{x:640+dot(right)*scale/dot(forward),y:360-dot(up)*scale/dot(forward)};
    }
    const mineral=state.view!.entities.some(entity=>entity.resource==='gold'&&!entity.ghost&&(entity.amount??0)>0)?'gold':'stone';
    for(const resource of ['wood',mineral] as const){
      // Choose the camera-facing edge of the visible cluster. Projecting a
      // rear tree's ground point can correctly hit a nearer tree's crown.
      const alpha=-Math.PI/2.6;
      const node=state.view!.entities.filter(entity=>entity.kind==='resource'&&entity.resource===resource&&!entity.ghost&&(entity.amount??0)>0).sort((a,b)=>(b.xMm-a.xMm)*Math.cos(alpha)+(b.zMm-a.zMm)*Math.sin(alpha))[0];expect(node).toBeDefined();
      const pixel=await targetPixel(node!,1);await page.mouse.move(pixel.x,pixel.y);
      await expect(page.getByTestId('context-action')).toHaveText(resource==='wood'?(node!.forest?'Right-click · Chop wood at forest edge':'Right-click · Chop wood'):`Right-click · Mine ${resource}`);
      await expect(page.getByTestId('world-canvas')).toHaveCSS('cursor','pointer');
      await page.screenshot({path:testInfo.outputPath(`context-${resource}.png`)});
      const before=state.commands.length;await page.mouse.click(pixel.x,pixel.y,{button:'right'});await accepted('gather',before);
      expect(state.commands.slice(before).find(command=>command.command.kind==='gather')!.command).toMatchObject({kind:'gather',targetId:node!.id});
      await page.getByRole('button',{name:'Stop selected units',exact:true}).click();
    }
    const town=state.view!.entities.find(entity=>entity.typeId==='town_center'&&entity.ownerId===state.view!.playerId)!,townPixel=await targetPixel(town,3);
    await page.getByRole('tab',{name:'orders',exact:true}).click();await page.getByRole('button',{name:'Attack target',exact:true}).click();await page.mouse.move(townPixel.x,townPixel.y);
    await expect(page.getByTestId('context-action')).toHaveText('Click · Cannot attack allies');
    await expect(page.getByTestId('world-canvas')).toHaveCSS('cursor','not-allowed');
    const beforeInvalidAttack=state.commands.length;await page.mouse.click(townPixel.x,townPixel.y);const invalidTick=state.view!.tick;
    await expect.poll(()=>state.view!.tick).toBeGreaterThan(invalidTick+2);expect(state.commands.length).toBe(beforeInvalidAttack);
    await page.screenshot({path:testInfo.outputPath('context-friendly-attack-blocked.png')});await page.getByRole('tab',{name:'economy',exact:true}).click();await page.keyboard.press('Escape');await page.keyboard.press('Home');
    for(const scale of [80,150]){
      await page.getByRole('button',{name:'Select villagers',exact:true}).click();
      const selection=await page.locator('.selection-heading h2').innerText(),beforeDialog=state.commands.length,launcher=page.getByRole('button',{name:'Game settings',exact:true});
      await launcher.click();const close=page.getByRole('button',{name:'Close settings',exact:true});
      // The real launcher click must contain focus immediately, without the
      // fixture manually moving focus into the dialog before sending hotkeys.
      await expect(close).toBeFocused();await page.keyboard.press(scale===80?'x':'k');await page.keyboard.press(scale===80?'.':'i');await page.keyboard.press('Home');
      const dialogTick=state.view!.tick;await expect.poll(()=>state.view!.tick).toBeGreaterThan(dialogTick+2);expect(state.commands.length).toBe(beforeDialog);await expect(page.locator('.selection-heading h2')).toHaveText(selection);
      await page.keyboard.press('Shift+Tab');await expect(page.getByRole('button',{name:'Restore defaults',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(close).toBeFocused();
      await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Settings & controls'})).toHaveCount(0);await expect(launcher).toBeFocused();await launcher.click();
      const slider=page.getByLabel('Interface scale');await slider.focus();await slider.press(scale===80?'Home':'End');await expect(slider).toHaveValue(String(scale));
      if(scale===80){
        await page.getByLabel('Music volume').focus();await page.keyboard.press('Home');await page.keyboard.press('ArrowRight');
        await page.getByLabel('Effects volume').focus();await page.keyboard.press('End');await page.keyboard.press('ArrowLeft');
        await page.getByRole('checkbox',{name:'Mute all sound',exact:true}).check();
        await expect.poll(()=>page.evaluate(()=>{const values=Reflect.get(window,'__qaAudioGains')();return {...values,music:Math.round(values.music*100),effects:Math.round(values.effects*100)};})).toEqual({state:'running',master:0,music:1,effects:99});
        await page.getByRole('checkbox',{name:'Mute all sound',exact:true}).uncheck();await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'__qaAudioGains')().master)).toBe(1);
        await page.getByRole('checkbox',{name:'Reduced motion',exact:true}).check();await expect(page.locator('html')).toHaveAttribute('data-reduced-motion','true');
        await close.click();await page.getByRole('button',{name:'End as draw',exact:true}).click();
        expect(await page.getByRole('button',{name:'Confirm draw',exact:true}).evaluate(element=>getComputedStyle(element).transitionProperty)).toBe('none');
        await page.keyboard.press('Escape');await launcher.click();
        await page.getByRole('checkbox',{name:'Reduced motion',exact:true}).uncheck();await expect(page.locator('html')).toHaveAttribute('data-reduced-motion','false');
      }
      await page.getByRole('button',{name:'Rebind Stop',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Settings & controls'})).toBeVisible();await expect(page.getByRole('button',{name:'Rebind Stop',exact:true})).toHaveText(scale===80?'X':'K');
      await page.getByRole('button',{name:'Rebind Next idle Villager',exact:true}).click();await page.keyboard.press('i');await page.getByRole('button',{name:'Rebind Stop',exact:true}).click();await page.keyboard.press('k');await page.getByRole('button',{name:'Close settings',exact:true}).click();
      await expect(launcher).toBeFocused();
      await page.keyboard.press('i');await expect(page.locator('.selection-heading h2')).toHaveText('Villager');
      const hoverNode=state.view!.entities.find(entity=>entity.kind==='resource'&&!entity.ghost&&(entity.amount??0)>0);expect(hoverNode).toBeDefined();
      // At150% the dock occupies the middle of the screen. Recenter through
      // the minimap so a known resource projects into the exposed upper field.
      const hoverPixel=await targetPixel(hoverNode!,1,12000);
      expect(await page.getByTestId('world-canvas').evaluate((canvas,point)=>document.elementFromPoint(point.x,point.y)===canvas,hoverPixel)).toBe(true);
      await page.mouse.move(hoverPixel.x,hoverPixel.y);const hoverCue=page.getByTestId('context-action');await expect(hoverCue).toBeVisible();
      const hoverBox=(await hoverCue.boundingBox())!;expect(hoverBox.x).toBeGreaterThanOrEqual(0);expect(hoverBox.y).toBeGreaterThanOrEqual(0);expect(hoverBox.x+hoverBox.width).toBeLessThanOrEqual(1280);expect(hoverBox.y+hoverBox.height).toBeLessThanOrEqual(720);
      await expect(hoverCue).toHaveCSS('pointer-events','none');await expect(hoverCue).toHaveCSS('font-size',`${13*scale/100}px`);
      const commands=state.commands.length;await page.keyboard.press('k');await accepted('stop',commands);
      for(const name of ['Game settings','Technology tree','Select Town Center','Select villagers','Stop selected units','Gather wood','Build House'])await whollyVisible(page.getByRole('button',{name,exact:true}));
      await page.getByRole('button',{name:'Select villagers',exact:true}).click();await page.keyboard.press('i');await expect(page.locator('.selection-heading h2')).toHaveText('Villager');
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
      await page.screenshot({path:`runtime-data/e2e/m7-hud-${scale}-1280.png`});
      const beforeGather=state.commands.length;await page.getByRole('button',{name:'Gather wood',exact:true}).click();await accepted('gather',beforeGather);await page.keyboard.press('k');
      await page.getByRole('button',{name:'Technology tree',exact:true}).click();const tree=page.getByRole('dialog',{name:'Technology tree'});await whollyVisible(tree);expect((await tree.boundingBox())!.height).toBeGreaterThanOrEqual(320);await expect(tree.locator('.technology-card')).toHaveCount(29);
      await whollyVisible(page.getByRole('button',{name:'Close technology tree',exact:true}));
      const last=page.getByTestId(`technology-${content.technologies.at(-1)!.id}`);await last.getByRole('button').scrollIntoViewIfNeeded();await whollyVisible(last.getByRole('button'));await page.screenshot({path:`runtime-data/e2e/m7-tech-${scale}-1280.png`});
      await tree.hover();await page.mouse.wheel(0,-20000);await page.getByRole('button',{name:'Close technology tree',exact:true}).click();
      await page.getByRole('button',{name:'Select Town Center',exact:true}).click();await expect(page.locator('.selection-heading h2')).toHaveText('Town Center');await whollyVisible(page.getByRole('button',{name:'Train Villager',exact:true}));
    }
    // Destructive confirmations choose their safe dismissal first, suppress the
    // rebound gameplay key immediately, and restore their actual launcher.
    await page.getByRole('button',{name:'Select villagers',exact:true}).click();
    for(const name of ['End as draw','Surrender']){
      const launcher=page.getByRole('button',{name,exact:true}),before=state.commands.length;
      await launcher.click();await expect(page.getByRole('button',{name:'Keep playing',exact:true})).toBeFocused();await page.keyboard.press('k');
      const tick=state.view!.tick;await expect.poll(()=>state.view!.tick).toBeGreaterThan(tick+2);expect(state.commands.length).toBe(before);
      await page.keyboard.press('Escape');await expect(launcher).toBeFocused();
    }
    await page.getByRole('button',{name:'Select Town Center',exact:true}).click();
    const demolish=page.getByRole('button',{name:'Demolish',exact:true});await demolish.click();await expect(page.getByRole('button',{name:'Keep building',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');await expect(demolish).toBeFocused();
    await page.getByRole('button',{name:'Select villagers',exact:true}).click();await page.getByRole('button',{name:'Game settings',exact:true}).click();
    await page.getByRole('button',{name:'Rebind Stop',exact:true}).click();await page.keyboard.press('ArrowUp');await page.getByRole('button',{name:'Close settings',exact:true}).click();
    const arrowBefore=state.commands.length;await page.keyboard.press('ArrowUp');await accepted('stop',arrowBefore);

    await page.getByRole('button',{name:'Pause',exact:true}).click();await expect.poll(()=>state.view?.status).toBe('PAUSED');
    const saves=page.getByRole('button',{name:'Saves and recovery',exact:true});await saves.click();await expect(page.getByRole('button',{name:'Close saves and recovery',exact:true})).toBeFocused();
    await page.getByLabel('Save name',{exact:true}).fill('QA modal focus checkpoint');await page.getByRole('button',{name:/^Save match/}).click();
    await expect(page.getByRole('status').filter({hasText:'Save written successfully'})).toBeVisible();
    const load=page.getByRole('button',{name:'Load save QA modal focus checkpoint',exact:true});await load.click();
    const child=page.getByRole('alertdialog',{name:'Confirm save load'});await expect(child.getByRole('button',{name:'Keep current match',exact:true})).toBeFocused();
    await page.keyboard.press('Tab');await expect(child.getByRole('button',{name:'Confirm load'})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(child.getByRole('button',{name:'Keep current match',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');await expect(child).toHaveCount(0);await expect(page.getByRole('dialog',{name:'Host saves and recovery'})).toBeVisible();await expect(load).toBeFocused();
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Host saves and recovery'})).toHaveCount(0);await expect(saves).toBeFocused();
    await saves.click();await page.getByRole('button',{name:'AI endpoint & diagnostics',exact:true}).click();await expect(page.getByRole('button',{name:'Close AI endpoint',exact:true})).toBeFocused();
    await page.keyboard.press('Escape');await expect(page.getByRole('dialog',{name:'Host AI endpoint'})).toHaveCount(0);
    expect(errors).toEqual([]);expect(state.protocolErrors).toEqual([]);
    await testInfo.attach('hud-scale-evidence',{body:JSON.stringify({viewport:{width:1280,height:720},scales:[80,150],browser:browser.version(),errors,commands:state.commands,receipts:state.receipts}),contentType:'application/json'});
  }finally{await context.close();}
});
