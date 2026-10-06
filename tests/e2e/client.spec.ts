import { capture } from './capture';
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { PlayerView, Position, SessionResponse } from '@frontier/shared';
import { validateHostDiagnosticsResponse } from '../../packages/shared/src/validation';
import type { SaveEnvelope } from '../../packages/simulation/src/persistence-types';
import { Navigation, type Obstacle } from '../../packages/simulation/src/navigation';
import { engineIdentity } from '../../apps/server/src/build-info';
import { terrainBuildable,terrainHeightAt,terrainObstacles } from '../../packages/shared/src/terrain';

const content=JSON.parse(readFileSync('data/balance.v1.json','utf8')) as {rules:{buildingGridM:number};buildings:{id:string;footprintCells:[number,number]}[];units:{id:string;collisionRadiusM:number;moveSpeedMps:number}[]};
const footprints=new Map(content.buildings.map(building=>[building.id,building.footprintCells]));
const radii=new Map(content.units.map(unit=>[unit.id,unit.collisionRadiusM*1000]));
const m1Seed='m1-browser-standard-frontier-v7',replayDirectory='runtime-data/e2e/replays';
const journalNames=()=>new Set(existsSync(replayDirectory)?readdirSync(replayDirectory).filter(name=>/^replay_\d{13}_[a-f0-9]{16}\.ndjson$/.test(name)):[]);

/** This Node-only fixture oracle reads at most the first 16MiB journal line.
 * Neither the private payload nor its geometry enters a browser or attachment. */
function initialFixtureGeometry(priorFiles:ReadonlySet<string>,lobby:SessionResponse['lobby'],views:readonly PlayerView[]):Obstacle[]|undefined {
  const files=[...journalNames()].filter(name=>!priorFiles.has(name));
  if(!files.length)return;if(files.length!==1)throw new Error('M1_FIXTURE_AMBIGUOUS_NEW_JOURNAL');
  const descriptor=openSync(`${replayDirectory}/${files[0]}`,'r'),chunks:Buffer[]=[];let size=0,complete=false;
  try{while(size<16*1024*1024){const chunk=Buffer.alloc(Math.min(65536,16*1024*1024-size)),count=readSync(descriptor,chunk,0,chunk.length,null);if(!count)break;const end=chunk.subarray(0,count).indexOf(10),part=chunk.subarray(0,end<0?count:end);chunks.push(part);size+=part.length;if(end>=0){complete=true;break;}}}finally{closeSync(descriptor);}
  if(!complete){if(size>=16*1024*1024)throw new Error('M1_FIXTURE_HEADER_LIMIT');return;}
  const line=JSON.parse(Buffer.concat(chunks,size).toString('utf8')) as {previous:string;checksum:string;record:{kind:string;initial:SaveEnvelope}};
  const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  if(line.record.kind!=='header'||line.previous!=='0'.repeat(64)||line.checksum!==createHash('sha256').update(line.previous+'\n'+JSON.stringify(line.record)).digest('hex'))throw new Error('M1_FIXTURE_INVALID_HEADER');
  const {checksum,...sealed}=line.record.initial,payload=sealed.payload,state=payload.state,first=views[0]!;
  const factions=(players:readonly {id:string;teamId:string;kind:string}[])=>players.map(({id,teamId,kind})=>({id,teamId,kind})).sort((a,b)=>a.id.localeCompare(b.id));
  if(sealed.formatVersion!==1||checksum!==fingerprint(sealed)||sealed.engineBuildHash!==engineIdentity.engineBuildHash||JSON.stringify(sealed.runtimeProfile)!==JSON.stringify(engineIdentity.runtimeProfile))throw new Error('M1_FIXTURE_ENGINE_MISMATCH');
  if(state.matchId!==first.matchId||state.matchEpoch!==first.matchEpoch||state.tick!==0||payload.contentHash!==first.contentHash||payload.options.seed!==m1Seed||state.map.seed!==m1Seed||lobby.hostSeed!==m1Seed)throw new Error('M1_FIXTURE_MATCH_MISMATCH');
  if(payload.options.mapType!==lobby.settings.mapType||payload.options.mapSize!==(lobby.settings.mapSize??'auto')||lobby.settings.teamPreset!=='free_for_all'||JSON.stringify(factions(state.factions))!==JSON.stringify(factions(lobby.players)))throw new Error('M1_FIXTURE_LOBBY_MISMATCH');
  for(const view of views){
    if(view.matchId!==state.matchId||view.matchEpoch!==state.matchEpoch||view.map.widthMm!==state.widthMm||view.map.heightMm!==state.heightMm||view.map.type!==state.map.type||view.map.generatorVersion!==state.map.generatorVersion||JSON.stringify(view.map.terrain)!==JSON.stringify(state.map.terrain)||JSON.stringify(factions(view.players))!==JSON.stringify(factions(state.factions)))throw new Error('M1_FIXTURE_VIEW_MISMATCH');
    const spawns=view.entities.filter(entity=>entity.ownerId===view.playerId&&(entity.typeId==='scout'||entity.typeId==='town_center'));
    if(spawns.length!==2||new Set(spawns.map(entity=>entity.typeId)).size!==2)throw new Error('M1_FIXTURE_SPAWN_MISSING');
    for(const entity of spawns){const initial=state.entities[entity.id];if(!initial||initial.ownerId!==entity.ownerId||initial.typeId!==entity.typeId||initial.xMm!==entity.xMm||initial.zMm!==entity.zMm)throw new Error('M1_FIXTURE_SPAWN_MISMATCH');}
  }
  const obstacles:Obstacle[]=terrainObstacles(state.map.terrain),grid=content.rules.buildingGridM*1000;
  for(const entity of Object.values(state.entities)){
    if(entity.kind==='unit')continue;
    let halfWidth:number,halfHeight:number;
    if(entity.kind==='resource'){
      if(entity.amount<=0)continue;
      // Exact resourceWorkBounds geometry, including authored forest cells.
      // Importing that module in Playwright would load Node-incompatible raw JSON.
      halfWidth=halfHeight=entity.resource==='wood'&&entity.forest?entity.forest.cellMm/2:entity.resource==='wood'?450:650;
    }else{let[w,h]=footprints.get(entity.typeId)!;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];halfWidth=w*grid/2;halfHeight=h*grid/2;}
    obstacles.push({id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth,halfHeight});
  }
  return obstacles;
}

/** Choose a roomy point on a real bounded static route, not an arithmetic point
 * inside an unseen forest. This is authored fixture knowledge, not player AI. */
function fixtureRendezvous(views:readonly PlayerView[],initialObstacles:readonly Obstacle[]):{meeting:Position;remoteRoute:Position[]} {
  const scouts=views.map(view=>view.entities.find(entity=>entity.ownerId===view.playerId&&entity.typeId==='scout')!);
  const obstacles=new Map(initialObstacles.map(obstacle=>[obstacle.id,obstacle])),grid=content.rules.buildingGridM*1000;
  for(const view of views)for(const entity of view.entities)if(entity.kind==='building'&&!entity.ghost){let[w,h]=footprints.get(entity.typeId)!;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];obstacles.set(entity.id,{id:entity.id,xMm:entity.xMm,zMm:entity.zMm,halfWidth:w*grid/2,halfHeight:h*grid/2});}
  if(scouts.some(scout=>!scout))throw new Error('M1_FIXTURE_SCOUT_MISSING');
  const navigation=new Navigation(views[0]!.map.widthMm,views[0]!.map.heightMm,[...obstacles.values()],160000),radius=radii.get('scout')!,speed=content.units.find(unit=>unit.id==='scout')!.moveSpeedMps*1000;
  const route=navigation.path(scouts[0]!,scouts[1]!,radius);
  if(!route)throw new Error('M1_FIXTURE_NO_SCOUT_ROUTE');
  const points=[scouts[0]!,...route],lengths=points.slice(1).map((point,index)=>Math.hypot(point.xMm-points[index]!.xMm,point.zMm-points[index]!.zMm)),total=lengths.reduce((sum,length)=>sum+length,0),candidates:{point:Position;distance:number;offset:number}[]=[];
  let travelled=0;
  for(let index=0;index<lengths.length;index++){
    const start=points[index]!,end=points[index+1]!,length=lengths[index]!;
    for(let distance=0;distance<=length;distance+=2000){const along=travelled+distance;if(!length||along>speed*35||total-along>speed*35)continue;const fraction=distance/length,point={xMm:Math.round(start.xMm+(end.xMm-start.xMm)*fraction),zMm:Math.round(start.zMm+(end.zMm-start.zMm)*fraction)};if(navigation.free(point,8000)&&navigation.clearLine(start,point,radius)&&navigation.clearLine(point,end,radius))candidates.push({point,distance:Math.max(along,total-along),offset:Math.abs(along-total/2)});}
    travelled+=length;
  }
  candidates.sort((a,b)=>a.offset-b.offset||a.point.zMm-b.point.zMm||a.point.xMm-b.point.xMm);
  const chosen=candidates[0];if(!chosen)throw new Error(`M1_FIXTURE_NO_ROOMY_RENDEZVOUS_WITHIN_35S:routeMetres=${Math.round(total/1000)}`);
  // Endpoint-only orders may legitimately explore a longer route through newly
  // discovered forest. Author ordinary queued waypoints for the remote scout;
  // the host keeps the single endpoint order measured by the A0 recorder.
  // The 3m guard also covers the lone scout and rounded minimap input pixels.
  const remoteRoute=navigation.path(scouts[1]!,chosen.point,3000);
  if(!remoteRoute?.length||remoteRoute.length>16)throw new Error('M1_FIXTURE_REMOTE_ROUTE_QUEUE_LIMIT');
  const remotePoints=[scouts[1]!,...remoteRoute],remoteDistance=remotePoints.slice(1).reduce((sum,point,index)=>sum+Math.hypot(point.xMm-remotePoints[index]!.xMm,point.zMm-remotePoints[index]!.zMm),0);
  if(remoteDistance>speed*35)throw new Error('M1_FIXTURE_REMOTE_ROUTE_EXCEEDS_35S');
  console.log(`M1 fixed fixture: standard forest geometry, 8m rendezvous clearance, longest static scout leg ${(chosen.distance/speed).toFixed(1)}s; remote guarded route ${(remoteDistance/speed).toFixed(1)}s through ${remoteRoute.length} ordinary waypoints.`);
  return {meeting:chosen.point,remoteRoute};
}

/** Candidate hints use only the same disclosed geometry a player can see. The
 * real canvas preview, command receipt and completed building remain the proof. */
function visibleBuildingSites(view:PlayerView,type:'house'|'barracks',home:{xMm:number;zMm:number}){
  const grid=content.rules.buildingGridM*1000,[width,depth]=footprints.get(type)!,fog=view.map.fogCellMm,columns=Math.ceil(view.map.widthMm/fog),visible=new Set(view.fog.visible),sites:{xMm:number;zMm:number;distance:number}[]=[];
  for(let dz=-12;dz<=12;dz++)for(let dx=-12;dx<=12;dx++){
    const left=(Math.floor(home.xMm/grid)+dx)*grid,top=(Math.floor(home.zMm/grid)+dz)*grid,right=left+width*grid,bottom=top+depth*grid;
    if(left<0||top<0||right>view.map.widthMm||bottom>view.map.heightMm||!terrainBuildable(view.map.terrain??[],{xMm:left,zMm:top,widthMm:width*grid,depthMm:depth*grid}))continue;
    let seen=true;for(let z=Math.floor(top/fog);z<Math.ceil(bottom/fog);z++)for(let x=Math.floor(left/fog);x<Math.ceil(right/fog);x++)if(!visible.has(z*columns+x))seen=false;if(!seen)continue;
    if(view.entities.some(entity=>{
      if(entity.ghost||entity.garrisonedIn||entity.kind==='resource'&&(entity.amount??0)<=0)return false;
      let halfWidth:number,halfHeight:number;
      if(entity.kind==='building'){let[w,h]=footprints.get(entity.typeId)!;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];halfWidth=w*grid/2;halfHeight=h*grid/2;}
      else halfWidth=halfHeight=entity.kind==='unit'?radii.get(entity.typeId)!:entity.forest?entity.forest.cellMm/2:entity.resource==='wood'?450:650;
      return entity.xMm+halfWidth>left&&entity.xMm-halfWidth<right&&entity.zMm+halfHeight>top&&entity.zMm-halfHeight<bottom;
    }))continue;
    sites.push({xMm:left+grid/2,zMm:top+grid/2,distance:Math.hypot(left+width*grid/2-home.xMm,top+depth*grid/2-home.zMm)});
  }
  return sites.sort((a,b)=>a.distance-b.distance||a.zMm-b.zMm||a.xMm-b.xMm);
}

test.describe('isolated authority fixture',()=>{
  let server:ChildProcess|undefined,origin='',serverOutput='';
  const bootstrap='normal300-browser-fixture-not-a-real-host-token';
  // This case owns its server, data and one-use bootstrap. The original M1
  // case below still owns the configured global server's bootstrap session.
  test.beforeAll(async()=>{
    const listener=createServer();
    await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});
    const address=listener.address();if(!address||typeof address==='string')throw new Error('No normal300 fixture port');
    const port=address.port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
    mkdirSync('runtime-data',{recursive:true});const dataDir=mkdtempSync('runtime-data/e2e-normal300-');origin=`http://127.0.0.1:${port}`;
    server=spawn(process.execPath,['dist/server/index.js'],{windowsHide:true,env:{...process.env,NODE_ENV:'production',FRONTIER_FRAME_MS:'300',GAME_PORT:String(port),GAME_BIND:'127.0.0.1',GAME_LAN_MODE:'false',GAME_DATA_DIR:dataDir,HOST_ADMIN_BOOTSTRAP_TOKEN:bootstrap},stdio:['ignore','pipe','pipe']});
    for(const stream of [server.stdout,server.stderr])stream?.on('data',chunk=>{serverOutput=(serverOutput+chunk.toString()).slice(-6000);});
    await expect.poll(async()=>{
      if(server?.exitCode!==null)throw new Error(`Normal300 fixture host exited: ${serverOutput}`);
      return fetch(`${origin}/api/health`).then(response=>response.ok).catch(()=>false);
    },{timeout:20000}).toBe(true);
  });
  test.afterAll(async()=>{
    if(server&&server.exitCode===null){const closed=new Promise<void>(resolve=>server!.once('exit',()=>resolve()));server.kill('SIGTERM');await closed;}
  });

test('300ms authority presents authorized motion, separate command receipt and reconnect',async({browser},testInfo)=>{
  test.setTimeout(90000);
  const hostContext=await browser.newContext({viewport:{width:1440,height:900}}),remoteContext=await browser.newContext({viewport:{width:1280,height:720}});
  const host=await hostContext.newPage(),remote=await remoteContext.newPage(),state=capture(host),guest=capture(remote);
  host.setDefaultTimeout(10000);remote.setDefaultTimeout(10000);
  try{
    await host.goto(origin);await host.getByRole('tab',{name:'Host access',exact:true}).click();
    await host.getByLabel('HOST ACCESS TOKEN').fill(bootstrap);await host.getByRole('button',{name:'Open host controls'}).click();
    await expect(host.locator('.invite-code')).toBeVisible();const invite=await host.locator('.invite-code').innerText();
    await host.getByLabel('AI COMMANDERS').selectOption('0');
    await host.getByLabel('YOUR NAME').fill('Frame host');await host.getByRole('button',{name:'Join as host-player'}).click();
    await remote.goto(origin);await remote.getByLabel('YOUR NAME').fill('Frame guest');await remote.getByLabel('INVITATION CODE').fill(invite);await remote.getByRole('button',{name:'Enter the frontier'}).click();
    // This is a transport/render smoke, not a random-seed generation census.
    // Keep the ordinary Long War map reproducible, including retry cost.
    await host.getByLabel('Private map seed',{exact:true}).fill('normal300-browser-fixed-v1');
    const [seedResponse]=await Promise.all([host.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/host/seed'),host.getByRole('button',{name:'Set seed',exact:true}).click()]);
    expect(seedResponse.ok()).toBe(true);
    await host.getByLabel('Frame host team',{exact:true}).selectOption('team_1');await host.getByLabel('Frame guest team',{exact:true}).selectOption('team_2');
    await host.getByRole('button',{name:'Ready to begin'}).click();await remote.getByRole('button',{name:'Ready to begin'}).click();
    const [startResponse]=await Promise.all([host.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/host/start',{timeout:35000}),host.getByRole('button',{name:'Begin match'}).click()]);
    expect(startResponse.ok(),`Fixture match start failed (${startResponse.status()}): ${serverOutput}`).toBe(true);
    await expect.poll(()=>state.view?.status,{timeout:35000}).toBe('RUNNING');await expect.poll(()=>guest.view?.status,{timeout:35000}).toBe('RUNNING');
    const initial=structuredClone(state.view!),enemy=guest.view!.playerId,scout=initial.entities.find(entity=>entity.ownerId===initial.playerId&&entity.typeId==='scout')!;
    expect(initial.maxAge).toBe(8);expect(initial.rulesetId).toBe('legendary_ages_v1');expect(initial.startingResourcePreset).toBe('long_war');
    expect(initial.authoritativeIntervalMs).toBe(300);expect(initial.publicationIntervalMs).toBe(300);expect(initial.committedTimeMs).toBe(initial.tick*50);
    expect(initial.entities.some(entity=>entity.ownerId===enemy)).toBe(false);
    const destination=visibleBuildingSites(initial,'house',scout).find(point=>Math.hypot(point.xMm-scout.xMm,point.zMm-scout.zMm)>5000);
    expect(destination).toBeDefined();await host.bringToFront();await host.keyboard.press('Home');await host.getByRole('button',{name:'Select army',exact:true}).click();
    const rect=(await host.getByTestId('minimap').boundingBox())!;
    await host.evaluate(()=>{window.frontierResponseDiagnostics.enable();window.frontierResponseDiagnostics.labelNext('e2e-normal300-authorized-move');});
    // Ordinary handler/socket/authority/render path; synthetic input deliberately
    // cannot qualify physical input-to-display latency.
    await host.getByTestId('minimap').evaluate((canvas,point)=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
      canvas.dispatchEvent(new MouseEvent('contextmenu',{view:window,bubbles:true,cancelable:true,button:2,clientX:point.x,clientY:point.y}));resolve();
    }))),{x:rect.x+destination!.xMm/initial.map.widthMm*rect.width,y:rect.y+destination!.zMm/initial.map.heightMm*rect.height});
    await expect.poll(()=>state.commands.find(command=>command.command.kind==='move')?.clientCommandId).toBeTruthy();
    const command=state.commands.find(command=>command.command.kind==='move')!;
    await expect.poll(()=>state.receipts.find(receipt=>receipt.clientCommandId===command.clientCommandId)?.status).toBe('accepted');
    await expect.poll(()=>state.view?.entities.find(entity=>entity.id===scout.id)?.motionTrace?.complete,{timeout:10000}).toBe(true);
    const movingView=structuredClone(state.view!),motion=movingView.entities.find(entity=>entity.id===scout.id)!.motionTrace!;
    expect(motion.points.length).toBeGreaterThanOrEqual(2);expect(motion.points.at(-1)!.tick).toBe(movingView.tick);
    expect(motion.points.every((point,index)=>point.tick<=movingView.tick&&(!index||point.tick>motion.points[index-1]!.tick))).toBe(true);
    await expect.poll(async()=>{const report=await host.evaluate(()=>window.frontierResponseDiagnostics.report());return report.evidence?.rows.find(row=>row.commandId===command.clientCommandId)?.outcome;},{timeout:15000}).toBe('rendered');
    const report=await host.evaluate(()=>{const report=window.frontierResponseDiagnostics.report();window.frontierResponseDiagnostics.disable();return report;}),sample=report.evidence!.samples.find(sample=>sample.commandId===command.clientCommandId)!;
    expect(report.faults).toBe(0);expect(report.evidence!.timingQualificationEligible).toBe(false);
    expect(sample.gatewayReceivedMs).toBeGreaterThanOrEqual(0);expect(sample.authoritativeDecisionMs).toBeGreaterThanOrEqual(sample.gatewayReceivedMs!);
    expect(sample.completeRenderedMs).toBeGreaterThanOrEqual(sample.firstAppliedMs!);expect(sample.rendered).toBe(sample.eligible);expect(sample.eligible).toBeGreaterThan(0);
    expect(state.view!.committedTimeMs).toBe(state.view!.tick*50);expect(state.view!.frameRevision!).toBeGreaterThan(initial.frameRevision!);
    expect(state.view!.entities.some(entity=>entity.ownerId===enemy)).toBe(false);
    await testInfo.attach('normal300-authorized-response-evidence',{body:JSON.stringify(report,null,2),contentType:'application/json'});
    // Always-on delivery counters require no command recording or private state.
    const delivery=await host.evaluate(()=>window.frontierDeliveryDiagnostics.report());
    for(const phase of ['messageGap','completeViewGap','advancingViewGap','parseAndValidation','worldApply','applyToRender'] as const)expect(delivery.metrics[phase]?.samples,phase).toBeGreaterThan(0);
    expect(delivery.recentGaps.length).toBeLessThanOrEqual(32);
    const diagnostics=await (await host.request.get(`${origin}/api/host/diagnostics`)).json();
    expect(validateHostDiagnosticsResponse(diagnostics)).toBe(true);
    expect(diagnostics.publicationDelivery.scope).toBe('gateway_publication_socket_callbacks');
    expect(diagnostics.publicationDelivery.channels.some((row:{playerId:string;completedViews:number})=>row.playerId===initial.playerId&&row.completedViews>0)).toBe(true);
    expect((await remote.request.get(`${origin}/api/host/diagnostics`)).status()).toBe(403);
    await testInfo.attach('normal300-delivery-evidence',{body:JSON.stringify({browser:delivery,gateway:diagnostics.publicationDelivery},null,2),contentType:'application/json'});
    const viewsBefore=state.fullViews;await host.reload();await expect(host.getByTestId('game-hud')).toBeVisible({timeout:20000});
    await expect.poll(()=>state.fullViews).toBeGreaterThan(viewsBefore);expect(state.view!.playerId).toBe(initial.playerId);expect(state.view!.authoritativeIntervalMs).toBe(300);
    expect(state.errors).toEqual([]);expect(guest.errors).toEqual([]);expect(state.protocolErrors).toEqual([]);expect(guest.protocolErrors).toEqual([]);
  }catch(error){await testInfo.attach('normal300-authorized-browser-state',{body:JSON.stringify({host:state,guest}),contentType:'application/json'});throw error;}
  finally{await hostContext.close();await remoteContext.close();}
});
});

test('M1 two authenticated browser viewpoints gather, build, train, fight, reconnect, and finish', async ({ browser }) => {
  test.setTimeout(240000);
  const hostContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const remoteContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const host = await hostContext.newPage(), remote = await remoteContext.newPage();
  host.setDefaultTimeout(10000); remote.setDefaultTimeout(10000);
  const hostState = capture(host), remoteState = capture(remote);
  try {
    await host.goto('/'); await host.getByRole('tab', { name: 'Host access' }).click();
    await host.getByLabel('HOST ACCESS TOKEN').fill('e2e-bootstrap-token-not-for-real-hosts');
    await host.getByRole('button', { name: 'Open host controls' }).click();
    await expect(host.locator('.invite-code')).toBeVisible();
    const invite = await host.locator('.invite-code').innerText();
    // Keep the default fallback commander: two humans and one independently controlled AI.
    await host.getByLabel('YOUR NAME').fill('Aster'); await host.getByRole('button', { name: 'Join as host-player' }).click();
    await remote.goto('/'); await remote.getByLabel('YOUR NAME').fill('Birch'); await remote.getByLabel('INVITATION CODE').fill(invite); await remote.getByRole('button', { name: 'Enter the frontier' }).click();
    await host.getByLabel('Private map seed',{exact:true}).fill(m1Seed);
    const [seedResponse]=await Promise.all([host.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/host/seed'),host.getByRole('button',{name:'Set seed',exact:true}).click()]);
    expect(seedResponse.ok()).toBe(true);
    const [presetResponse]=await Promise.all([host.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/host/lobby'),host.getByRole('button',{name:'Preset Free for all',exact:true}).click()]);
    expect(presetResponse.ok()).toBe(true);
    // App.post deliberately leaves successful POST bodies unread and refreshes
    // the session separately. Read the same bounded session through the shared
    // authenticated request context, rather than waiting on that browser body.
    const fixtureSession=await host.request.get('/api/session',{timeout:10000});expect(fixtureSession.ok()).toBe(true);
    let fixtureLobby:SessionResponse['lobby'];try{fixtureLobby=((await fixtureSession.json()) as SessionResponse).lobby;}finally{await fixtureSession.dispose();}
    expect(fixtureLobby.settings.teamPreset).toBe('free_for_all');expect(fixtureLobby.settings.aiCount).toBe(1);expect(fixtureLobby.players).toHaveLength(3);expect(fixtureLobby.hostSeed).toBe(m1Seed);
    const priorJournals=journalNames();
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click();
    await expect(host.getByRole('button', { name: 'Begin match' })).toBeEnabled();
    // Worker initialization has its own bounded request. The client loading
    // window begins after it completes, then both viewpoints verify assets and
    // acknowledge their initial view before the countdown can advance.
    const [startResponse] = await Promise.all([
      host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/host/start', { timeout: 35000 }),
      host.getByRole('button', { name: 'Begin match' }).click(),
    ]);
    expect(startResponse.ok(), `Match initialization returned HTTP ${startResponse.status()}`).toBe(true);
    await expect(host.getByTestId('game-hud')).toBeVisible({ timeout: 30000 }); await expect(remote.getByTestId('game-hud')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => hostState.view?.status, { timeout: 30000 }).toBe('RUNNING'); await expect.poll(() => remoteState.view?.status, { timeout: 30000 }).toBe('RUNNING');
    console.log('M1 browser: both viewpoints running; verifying secrecy and gathering.');
    const firstHost = structuredClone(hostState.view!), firstRemote = structuredClone(remoteState.view!);
    expect(firstHost.playerId).not.toBe(firstRemote.playerId);
    expect(firstHost.entities.some((entity) => entity.ownerId === firstRemote.playerId)).toBe(false);
    expect(firstRemote.entities.some((entity) => entity.ownerId === firstHost.playerId)).toBe(false);
    expect(firstHost.players.filter((player) => player.kind === 'ai')).toHaveLength(1);
    let fixtureObstacles:Obstacle[]|undefined;
    await expect.poll(()=>{fixtureObstacles=initialFixtureGeometry(priorJournals,fixtureLobby,[firstHost,firstRemote]);return Boolean(fixtureObstacles);},{timeout:15000}).toBe(true);

    await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
    await host.getByRole('button', { name: 'Gather wood', exact: true }).click();
    await expect.poll(() => hostState.commands.some((command) => command.command.kind === 'gather')).toBe(true);
    await expect.poll(() => hostState.view!.self.resources.wood, { timeout: 65000 }).toBeGreaterThan(firstHost.self.resources.wood);
    console.log('M1 browser: wood deposited; constructing house and barracks.');

    async function place(type: 'house' | 'barracks') {
      const before = hostState.view!.entities.filter((entity) => entity.ownerId === firstHost.playerId && entity.typeId === type).length;
      await host.keyboard.press('Home');
      await host.getByRole('button', { name: 'Select Town Center', exact: true }).click();
      await host.getByRole('button', { name: 'Select villagers', exact: true }).click();
      const snapshot=hostState.view!,home=snapshot.entities.find(entity=>entity.ownerId===firstHost.playerId&&entity.typeId==='town_center')!,canvas=host.getByTestId('world-canvas'),box=(await canvas.boundingBox())!;
      // Home restores the ordinary camera. Project known legal origins instead
      // of hoping a short fixed pixel list avoids newly occupied forest cells.
      const alpha=-Math.PI/2.6,beta=.82,radius=45,offset=[radius*Math.cos(alpha)*Math.sin(beta),radius*Math.cos(beta),radius*Math.sin(alpha)*Math.sin(beta)],forward=offset.map(value=>-value/radius),right=[-Math.sin(alpha),0,Math.cos(alpha)],up=[forward[1]!*right[2]!,forward[2]!*right[0]!-forward[0]!*right[2]!,-forward[1]!*right[0]!],scale=box.height/(2*Math.tan(.4));
      const projected=visibleBuildingSites(snapshot,type,home).map(site=>{
        const relative=[(site.xMm-home.xMm)/1000-offset[0]!, (terrainHeightAt(snapshot.map.terrain??[],site.xMm,site.zMm)-terrainHeightAt(snapshot.map.terrain??[],home.xMm,home.zMm))/1000-offset[1]!, (site.zMm-home.zMm)/1000-offset[2]!],dot=(axis:number[])=>relative.reduce((sum,value,index)=>sum+value*axis[index]!,0),depth=dot(forward);
        return {...site,x:box.x+box.width/2+dot(right)*scale/depth,y:box.y+box.height/2-dot(up)*scale/depth};
      }).filter(point=>point.x>box.x+20&&point.y>box.y+20&&point.x<box.x+box.width-20&&point.y<box.y+box.height-20);
      const candidates=await canvas.evaluate((element,points)=>points.filter(point=>document.elementFromPoint(point.x,point.y)===element).slice(0,24),projected);
      const attempts:{xMm:number;zMm:number;preview:string}[]=[];
      for (const {x,y,xMm,zMm} of candidates) {
        await host.getByRole('button', { name: `Build ${type === 'house' ? 'House' : 'Barracks'}`, exact: true }).click();
        await host.mouse.move(x,y);await canvas.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
        const preview=await host.locator('.placement-notice').innerText();attempts.push({xMm,zMm,preview});
        if (!preview.includes('Clear visible site')) { await host.keyboard.press('Escape'); await host.getByRole('button', { name: 'Select villagers', exact: true }).click(); continue; }
        const issuedBefore=hostState.commands.length;
        await host.mouse.click(x,y);
        try {
          await expect.poll(() => hostState.view!.entities.filter((entity) => entity.ownerId === firstHost.playerId && entity.typeId === type).length, { timeout: 2500 }).toBeGreaterThan(before);
          const issued=hostState.commands.slice(issuedBefore).find(command=>command.command.kind==='build'&&command.command.buildingType===type);expect(issued).toBeDefined();
          await expect.poll(()=>hostState.receipts.find(receipt=>receipt.clientCommandId===issued!.clientCommandId)?.status).toBe('accepted');return;
        }
        catch { const dismiss = host.getByRole('button', { name: 'Dismiss alert' }); if (await dismiss.isVisible()) await dismiss.click(); }
      }
      throw new Error(`No accepted visible ${type} placement using the real canvas preview: ${JSON.stringify(attempts)}`);
    }
    await place('house');
    await expect.poll(() => hostState.view!.self.populationCap, { timeout: 45000 }).toBeGreaterThan(firstHost.self.populationCap);
    await place('barracks');
    await expect.poll(() => hostState.view!.entities.some((entity) => entity.ownerId === firstHost.playerId && entity.typeId === 'barracks' && entity.progress === 1), { timeout: 50000 }).toBe(true);
    console.log('M1 browser: both buildings completed; training units.');
    await host.getByRole('button', { name: 'Select Barracks', exact: true }).click(); await host.getByRole('button', { name: 'Train Militia', exact: true }).click();
    await host.getByRole('button', { name: 'Select Town Center', exact: true }).click(); await host.getByRole('button', { name: 'Train Villager', exact: true }).click();
    await expect.poll(() => hostState.view!.entities.filter((entity) => entity.ownerId === firstHost.playerId && entity.typeId === 'militia').length, { timeout: 40000 }).toBeGreaterThan(0);
    await expect.poll(() => hostState.view!.entities.filter((entity) => entity.ownerId === firstHost.playerId && entity.typeId === 'villager').length, { timeout: 35000 }).toBeGreaterThan(6);
    await host.screenshot({ path: 'runtime-data/e2e/m1-settlement.png' });
    console.log('M1 browser: units trained; commanding both armies toward shared battle.');

    // Both browser-controlled scouts meet using actual minimap orders, then exchange damage.
    const hostScout = firstHost.entities.find((entity) => entity.ownerId === firstHost.playerId && entity.typeId === 'scout')!;
    const {meeting,remoteRoute} = fixtureRendezvous([hostState.view!,remoteState.view!],fixtureObstacles!);
    fixtureObstacles=undefined;
    for (const [page, state] of [[host, hostState], [remote, remoteState]] as const) {
      await page.getByRole('button', { name: 'Select army', exact: true }).click();
      const box = (await page.getByTestId('minimap').boundingBox())!;
      if(page===host)await test.step('A0 synthetic minimap input reaches authorized application and an actual Babylon draw',async()=>{
        // Observe this already-required battle order. Keep the camera at the own
        // idle army until its first draw, then perform the original camera jump.
        // This is a causal integration assertion, not a latency qualification.
        await page.bringToFront();await page.keyboard.press('Home');
        await expect.poll(()=>state.view?.entities.find(entity=>entity.id===hostScout.id)?.order).toBe('idle');
        await expect.poll(()=>state.view?.entities.find(entity=>entity.id===hostScout.id)?.visualAction?.kind).toBe('idle');
        const ownIds=new Set(state.view!.entities.filter(entity=>entity.ownerId===state.view!.playerId).map(entity=>entity.id)),before=state.commands.length;
        await page.evaluate(()=>{window.frontierResponseDiagnostics.enable();window.frontierResponseDiagnostics.labelNext('e2e-synthetic-idle-army-move');});
        try{
          // Synthetic DOM input uses the ordinary minimap handler and command
          // socket. Dispatch in the baseline RAF task so a CDP round trip cannot
          // let a newer snapshot replace the just-rendered idle boundary. The
          // remote player uses ordinary trusted mouse input below.
          await page.getByTestId('minimap').evaluate((canvas,point)=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
            canvas.dispatchEvent(new MouseEvent('contextmenu',{view:window,bubbles:true,cancelable:true,button:2,clientX:point.x,clientY:point.y}));resolve();
          }))),{x:box.x+meeting.xMm/state.view!.map.widthMm*box.width,y:box.y+meeting.zMm/state.view!.map.heightMm*box.height});
          await expect.poll(()=>state.commands.slice(before).find(command=>command.command.kind==='move')?.clientCommandId).toBeTruthy();
          const command=state.commands.slice(before).find(command=>command.command.kind==='move')!;
          expect(Object.keys(command).sort()).toEqual(['clientCommandId','clientSequence','command','matchEpoch','matchId','protocolVersion']);
          await expect.poll(()=>state.receipts.find(receipt=>receipt.clientCommandId===command.clientCommandId)?.status).toBe('accepted');
          const admission=await page.evaluate(()=>window.frontierResponseDiagnostics.report()),row=admission.evidence?.rows.find(row=>row.commandId===command.clientCommandId);
          expect(row,'The browser must record its ordinary outgoing command').toBeDefined();
          expect(row!.eligible,`An own idle action must be attributable: ${JSON.stringify(row!.excluded)}`).toBeGreaterThan(0);
          await expect.poll(async()=>{const report=await page.evaluate(()=>window.frontierResponseDiagnostics.report());return report.evidence?.rows.find(row=>row.commandId===command.clientCommandId)?.outcome;},{timeout:15000}).toBe('rendered');
          const report=await page.evaluate(()=>window.frontierResponseDiagnostics.report()),evidence=report.evidence!,sample=evidence.samples.find(sample=>sample.commandId===command.clientCommandId)!,completed=evidence.rows.find(row=>row.commandId===command.clientCommandId)!;
          expect(report.faults).toBe(0);expect(evidence.timingQualificationEligible).toBe(false);
          expect(evidence.counts).toMatchObject({issued:1,accepted:1,rendered:1,pending:0,rejected:0,cancelled:0,timedOut:0,boundaryCensored:0,overflow:0});
          expect(sample.applied).toBe(sample.eligible);expect(sample.rendered).toBe(sample.eligible);
          expect(sample.firstReceivedMs).toBeGreaterThanOrEqual(0);expect(sample.firstAppliedMs).toBeGreaterThanOrEqual(sample.firstReceivedMs!);
          expect(sample.firstMotionMs).toBeGreaterThanOrEqual(0);expect(sample.firstRenderedMs).toBeGreaterThanOrEqual(sample.firstAppliedMs!);
          expect(sample.completeRenderedMs).toBeGreaterThanOrEqual(sample.firstRenderedMs!);
          expect(completed.units.every(unit=>ownIds.has(unit.id))).toBe(true);
          expect(evidence.rows.length).toBeLessThanOrEqual(evidence.limits.active+evidence.limits.history);
          expect(completed.units.length).toBeLessThanOrEqual(evidence.limits.unitsPerCommand);
          expect(state.commands.slice(before)).toHaveLength(1); // Recording never injects gameplay commands.
        }finally{
          const report=await page.evaluate(()=>{const report=window.frontierResponseDiagnostics.report();window.frontierResponseDiagnostics.disable();return report;});
          await test.info().attach('a0-browser-response-evidence',{body:JSON.stringify(report,null,2),contentType:'application/json'});
          expect(await page.evaluate(()=>window.frontierResponseDiagnostics.report().enabled)).toBe(false);
        }
      });else{
        expect(remoteRoute.length).toBeLessThanOrEqual(16);
        const pixelError=Math.hypot(state.view!.map.widthMm/box.width/2,state.view!.map.heightMm/box.height/2);
        expect(pixelError+radii.get('scout')!,'The guarded route must cover scout radius and minimap rounding').toBeLessThan(3000);
        for(const [index,point] of remoteRoute.entries()){
          const before=state.commands.length;
          if(index>0)await page.keyboard.down('Shift');
          try{await page.mouse.click(Math.round(box.x+point.xMm/state.view!.map.widthMm*box.width),Math.round(box.y+point.zMm/state.view!.map.heightMm*box.height),{button:'right'});}
          finally{if(index>0)await page.keyboard.up('Shift');}
          await expect.poll(()=>state.commands.slice(before).find(command=>command.command.kind==='move')?.clientCommandId).toBeTruthy();
          const command=state.commands.slice(before).find(command=>command.command.kind==='move')!;
          expect(command.command).toMatchObject({kind:'move',queued:index>0,unitIds:[firstRemote.entities.find(entity=>entity.ownerId===firstRemote.playerId&&entity.typeId==='scout')!.id]});
          await expect.poll(()=>state.receipts.find(receipt=>receipt.clientCommandId===command.clientCommandId)?.status).toBe('accepted');
          expect(state.commands.slice(before)).toHaveLength(1);
        }
      }
      await page.mouse.click(box.x + meeting.xMm / state.view!.map.widthMm * box.width, box.y + meeting.zMm / state.view!.map.heightMm * box.height);
    }
    await expect.poll(() => hostState.view!.entities.some((entity) => entity.ownerId === firstRemote.playerId && entity.kind === 'unit'), { timeout: 45000 }).toBe(true);
    await expect.poll(() => [hostState.view!, remoteState.view!].some((view) => view.entities.some((entity) => entity.kind === 'unit' && entity.hp < entity.maxHp)), { timeout: 30000 }).toBe(true);
    await host.screenshot({ path: 'runtime-data/e2e/m1-battle.png' });
    console.log('M1 browser: visible battle damage observed; checking reconnect and results.');
    for (const view of [hostState.view!, remoteState.view!]) for (const entity of view.entities.filter((entity) => entity.ownerId !== view.playerId)) { expect(entity.queue).toBeUndefined(); expect(entity.cargo).toBeUndefined(); expect(entity.order).toBeUndefined(); }

    const identity = hostState.view!.playerId, fullViewsBeforeReload = hostState.fullViews; await host.reload(); await expect(host.getByTestId('game-hud')).toBeVisible({ timeout: 30000 }); await expect.poll(() => hostState.fullViews).toBeGreaterThan(fullViewsBeforeReload); await expect.poll(() => hostState.view?.playerId).toBe(identity);
    // Gathering continues through reconnect; compare the current authorized
    // snapshot with the HUD rather than freezing an earlier bank value.
    await expect.poll(async () => (await host.getByTestId('resource-wood').textContent()) === `${Math.floor(hostState.view!.self.resources.wood)}wood`).toBe(true);
    await remote.getByRole('button', { name: 'Surrender', exact: true }).click(); await remote.getByRole('button', { name: 'Confirm surrender' }).click();
    await host.getByRole('button', { name: 'Surrender', exact: true }).click(); await host.getByRole('button', { name: 'Confirm surrender' }).click();
    await expect(host.getByTestId('match-results')).toBeVisible(); await expect(remote.getByTestId('match-results')).toBeVisible();
    await host.getByRole('button', { name: 'Return to lobby' }).click();
    await expect(host.getByRole('button', { name: 'Ready to begin' })).toBeVisible();
    await expect(remote.getByRole('button', { name: 'Ready to begin' })).toBeVisible();
    await expect(host.getByTestId('game-hud')).toHaveCount(0); await expect(remote.getByTestId('game-hud')).toHaveCount(0);
    // Drop only this loader acknowledgement to exercise the real host's 30s failure recovery.
    await remote.evaluate(() => {
      const original = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data === 'string' && JSON.parse(data).type === 'loaded') return;
        original.call(this, data);
      };
    });
    await host.getByRole('button', { name: 'Ready to begin' }).click(); await remote.getByRole('button', { name: 'Ready to begin' }).click();
    const [rematchStartResponse] = await Promise.all([
      host.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/host/start', { timeout: 35000 }),
      host.getByRole('button', { name: 'Begin match' }).click(),
    ]);
    expect(rematchStartResponse.ok(), `Rematch initialization returned HTTP ${rematchStartResponse.status()}`).toBe(true);
    await expect(host.getByTestId('game-hud')).toBeVisible({ timeout: 30000 });
    await expect(host.getByRole('button', { name: 'Ready to begin' })).toBeVisible({ timeout: 40000 });
    await expect(host.getByTestId('game-hud')).toHaveCount(0); await expect(remote.getByTestId('game-hud')).toHaveCount(0);
    console.log('M1 browser: results, rematch lobby, and dropped-load acknowledgement recovery passed.');
    expect(hostState.errors).toEqual([]); expect(remoteState.errors).toEqual([]);
    expect(hostState.protocolErrors).toEqual([]); expect(remoteState.protocolErrors).toEqual([]);
  } catch (error) {
    await test.info().attach('authorized-browser-diagnostics', { body: JSON.stringify({ host: hostState, remote: remoteState }), contentType: 'application/json' });
    throw error;
  } finally { await hostContext.close(); await remoteContext.close(); }
});
