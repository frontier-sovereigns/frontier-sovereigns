import { expect, it } from 'vitest';
import { buildings, units, type BuildingId, type GameplayCommand, type PlayerView, type Position } from '@frontier/shared';
import { createSimulation } from '../src/index.js';
import { buildingCommand } from '../src/caretaker.js';
import { knownNavigation, scoutDestination } from '../src/ai-exploration.js';

it('AT-05 standard-start legal-command economy, militia training and combat victory',async()=>{
  const sim=createSimulation({seed:'standard-loop-05',matchId:'loop',factions:[
    {id:'blue',name:'Blue',teamId:'blue',color:'#3388ff',kind:'human'},
    {id:'red',name:'Red',teamId:'red',color:'#ee7744',kind:'human'},
  ]});
  let sequence=0;const receipts:string[]=[],send=(command:GameplayCommand)=>{const n=++sequence;const result=sim.command('blue',{protocolVersion:2,matchId:'loop',matchEpoch:1,clientCommandId:`loop_${n}`,clientSequence:n,command});if(result.status==='rejected')receipts.push(result.code!);return result.status==='accepted';};
  const initial=sim.view('blue'),base=initial.entities.find(e=>e.ownerId==='blue'&&e.typeId==='town_center')!;
  // The second authenticated faction deploys its starting force into the field.
  // Both sides use standard starts and ordinary commands; the Town Center keeps its full defenses.
  const redView=sim.view('red');let redSequence=0;
  for(const [index,unit]of redView.entities.filter(e=>e.ownerId==='red'&&e.kind==='unit').entries()){
    const n=++redSequence;
    expect(sim.command('red',{protocolVersion:2,matchId:'loop',matchEpoch:1,clientCommandId:`red_${n}`,clientSequence:n,command:{kind:'move',unitIds:[unit.id],target:{xMm:redView.map.widthMm/2+24000,zMm:redView.map.heightMm/2+12000+index*3200},queued:false}}).status).toBe('accepted');
  }
  const builders=initial.entities.filter(e=>e.ownerId==='blue'&&e.typeId==='villager'),builder=builders[0]!.id,logger=builders[1]!.id;
  const targetWorkers=14,targetMilitia=24;
  const requiredPopulation=targetWorkers*units.villager.population+targetMilitia*units.militia.population+units.scout.population;
  // Train the complete assault force without waiting forever for an unnecessary
  // extra house in a settled footprint. Every required house still uses a paid,
  // legally discovered site selected from this player's ordinary observation.
  const extraHouses=Math.ceil(Math.max(0,requiredPopulation-initial.self.populationCap)/buildings.house.populationProvided);
  const sites:BuildingId[]=['barracks',...Array<BuildingId>(extraHouses).fill('house')];
  let siteIndex=0,siteCandidate=0,pendingSiteId:string|undefined,assault=false,assaultTick:number|undefined,woodGathered=false,woodSpent=0,lastTarget='',rallied=false;let lastView:PlayerView=initial;
  // Search public map regions from our own known start. Opposing starts now use
  // the perimeter; repeating one eastern interior destination cannot find them.
  const corners=[{xMm:initial.map.widthMm*.1,zMm:initial.map.heightMm*.1},{xMm:initial.map.widthMm*.9,zMm:initial.map.heightMm*.1},{xMm:initial.map.widthMm*.1,zMm:initial.map.heightMm*.9},{xMm:initial.map.widthMm*.9,zMm:initial.map.heightMm*.9}].map(point=>({xMm:Math.round(point.xMm),zMm:Math.round(point.zMm)})).sort((a,b)=>Math.hypot(b.xMm-base.xMm,b.zMm-base.zMm)-Math.hypot(a.xMm-base.xMm,a.zMm-base.zMm));
  const searchPoints=[corners[0]!,{xMm:Math.round(initial.map.widthMm*.6),zMm:Math.round(initial.map.heightMm*.55)},...corners.slice(1)];
  let searchIndex=0,searchStarted=-1;
  const milestones=new Set<string>();
  const rally=initial.entities.find(entity=>entity.ownerId==='blue'&&entity.typeId==='scout')!;
  let scoutIndex=0,scoutTarget:Position|undefined;
  expect(send({kind:'set_stance',unitIds:[rally.id],stance:'stand_ground'})).toBe(true);
  // Keep the economy alive throughout the attack. Five militia plus a worker
  // rush cannot reliably conquer a fully defended Town Center; stage militia
  // with continued food/gold income and replace losses through legal training.
  const wallStart=performance.now();
  for(let tick=0;tick<24000&&sim.state.status==='RUNNING';tick+=20){
    if(performance.now()-wallStart>180000)break;
    if(tick%2000===0)await new Promise(resolve=>setTimeout(resolve,0));
    const view=sim.view('blue');lastView=view;
    const own=view.entities.filter(e=>e.ownerId==='blue'),workers=own.filter(e=>e.typeId==='villager'),militia=own.filter(e=>e.typeId==='militia'),town=own.find(e=>e.typeId==='town_center')!,barracks=own.find(e=>e.typeId==='barracks'&&e.progress===1);
    // Scout during paid production. Forest belts and distant starts require
    // earned route knowledge before sending the whole army across the map.
    const scout=own.find(entity=>entity.id===rally.id);
    if(!assault&&tick%100===0&&scout&&(scout.order==='idle'||scout.taskState==='blocked')){
      const enemies=view.entities.filter(entity=>entity.ownerId==='red'&&!entity.ghost);
      const target=scoutDestination(view,scout,enemies,knownNavigation(view),scoutIndex,scout.taskState==='blocked'?scoutTarget:undefined);
      if(target&&send({kind:'move',unitIds:[scout.id],target,queued:false})){scoutIndex++;scoutTarget=target;}
    }
    const collectedWood=view.self.resources.wood+woodSpent-initial.self.resources.wood;
    if(collectedWood>0)milestones.add('wood');
    if(!woodGathered&&collectedWood>=200){woodGathered=true;send({kind:'stop',unitIds:[logger]});}
    if(own.filter(e=>e.typeId==='house'&&e.progress===1).length>1)milestones.add('house');
    if(workers.length>6)milestones.add('villager');if(militia.length)milestones.add('militia');
    {
      // A paid explored-fog plan is not yet a completed house. Keep its builder
      // assigned; if newly observed occupancy prevents activation, cancel only
      // that unmaterialized plan and try another ordinary legal site.
      if(pendingSiteId){
        const site=own.find(entity=>entity.id===pendingSiteId),worker=workers.find(entity=>entity.id===builder);
        if(site?.progress===1){siteIndex++;siteCandidate=0;pendingSiteId=undefined;}
        else if(site?.pendingConstruction&&site.blockedReason==='PLACEMENT_BLOCKED'){
          if(send({kind:'cancel_foundation',foundationId:site.id})){woodSpent-=buildings[sites[siteIndex]!].cost.wood;pendingSiteId=undefined;siteCandidate=(siteCandidate+1)%32;}
        }else if(site&&worker&&tick%200===0&&(worker.order!=='build'||worker.taskState==='blocked'))send({kind:'continue_build',builderIds:[builder],foundationId:site.id,queued:false});
      }
      if(siteIndex<sites.length&&!pendingSiteId&&!own.some(e=>e.kind==='building'&&(e.progress??1)<1)){
        const site=sites[siteIndex]!;
        // Use disclosed terrain/occupancy to select a legal origin. Dense new
        // resource layouts can occupy any formerly convenient fixed offset.
        // This remains an ordinary command; authoritative admission proves access.
        if(view.self.resources.wood>=buildings[site].cost.wood){
          const proposal=buildingCommand(view,site,base,workers.filter(worker=>worker.id===builder),siteCandidate);
          if(proposal){if(send(proposal)){pendingSiteId=sim.view('blue').entities.find(entity=>entity.ownerId==='blue'&&entity.kind==='building'&&!own.some(prior=>prior.id===entity.id))!.id;woodSpent+=buildings[site].cost.wood;}else siteCandidate=(siteCandidate+1)%32;}
        }
      }
      const allBuilt=siteIndex===sites.length&&!own.some(e=>e.kind==='building'&&(e.progress??1)<1);
      for(const [index,worker]of workers.entries())if(worker.order==='idle'&&(worker.id!==builder||allBuilt)){
        const resource=worker.id===logger&&!woodGathered?'wood':workers.length>=9&&index>=workers.length-3?'gold':'food';
        const nodes=view.entities.filter(e=>e.resource===resource&&!e.ghost&&(e.amount??0)>0);
        const target=nodes[index%Math.max(1,nodes.length)];if(target)send({kind:'gather',unitIds:[worker.id],targetId:target.id,queued:false});
      }
      if(barracks&&!rallied)rallied=send({kind:'set_rally',buildingId:barracks.id,target:{xMm:rally.xMm,zMm:rally.zMm}});
      if(!assault&&tick%200===0){const arrived=militia.filter(unit=>unit.order==='move'&&Math.hypot(unit.xMm-rally.xMm,unit.zMm-rally.zMm)<8000);if(arrived.length)send({kind:'stop',unitIds:arrived.map(unit=>unit.id)});}
      if(barracks&&militia.length+(barracks.queue?.length??0)<targetMilitia&&view.self.resources.food>=60&&view.self.resources.gold>=20&&(barracks.queue?.length??0)<1)send({kind:'train',buildingId:barracks.id,unitType:'militia',quantity:1});
      const reserve=militia.length+(barracks?.queue?.length??0)<targetMilitia?60:0;
      if(workers.length+(town.queue?.length??0)<targetWorkers&&view.self.resources.food>=50+reserve&&(town.queue?.length??0)<1)send({kind:'train',buildingId:town.id,unitType:'villager',quantity:1});
      if(!assault&&workers.length>=targetWorkers&&militia.length>=targetMilitia&&siteIndex===sites.length){
        assault=true;assaultTick=tick;
        const knownBase=view.entities.find(entity=>entity.ownerId==='red'&&entity.typeId==='town_center');
        if(knownBase)searchPoints.unshift({xMm:knownBase.xMm,zMm:knownBase.zMm});
        send({kind:'attack_move',unitIds:own.filter(e=>e.kind==='unit'&&e.typeId!=='villager').map(e=>e.id),target:searchPoints[searchIndex]!,queued:false});searchStarted=tick;
      }
    }
    if(assault){
      const enemies=view.entities.filter(e=>e.ownerId==='red'&&!e.ghost&&e.kind==='unit').sort((a,b)=>a.hp-b.hp);
      const target=enemies[0]??view.entities.find(e=>e.ownerId==='red'&&e.typeId==='town_center'&&!e.ghost);
      const knownBase=view.entities.find(e=>e.ownerId==='red'&&e.typeId==='town_center');
      const army=own.filter(e=>e.kind==='unit'&&e.typeId!=='villager');
      if(target){const unassigned=target.id!==lastTarget?army:army.filter(e=>e.order!=='attack');if(unassigned.length)send({kind:'attack_target',unitIds:unassigned.map(e=>e.id),targetId:target.id,queued:false});lastTarget=target.id;}
      else if(knownBase){
        // A discovered fortress remains the assault objective when the scout
        // dies or vision briefly lapses. Its remembered position is public to
        // this player; only a currently visible enemy may receive attack_target.
        const objective=`remembered:${knownBase.id}`,unassigned=objective!==lastTarget?army:army.filter(unit=>unit.order==='idle');
        if(unassigned.length)send({kind:'attack_move',unitIds:unassigned.map(unit=>unit.id),target:{xMm:knownBase.xMm,zMm:knownBase.zMm},queued:false});
        lastTarget=objective;
      }
      else if(army.length&&tick%200===0){
        const point=searchPoints[searchIndex]!,arrived=army.filter(unit=>Math.hypot(unit.xMm-point.xMm,unit.zMm-point.zMm)<18000).length;
        if(arrived>army.length/2||tick-searchStarted>=7200){searchIndex=(searchIndex+1)%searchPoints.length;searchStarted=tick;lastTarget='';send({kind:'attack_move',unitIds:army.map(unit=>unit.id),target:searchPoints[searchIndex]!,queued:false});}
        else{const idle=army.filter(unit=>unit.order==='idle');if(idle.length)send({kind:'attack_move',unitIds:idle.map(unit=>unit.id),target:point,queued:false});}
      }
    }
    sim.step(20);
  }
  const result=sim.view('blue');
  expect(result.result?.winnerTeamId,JSON.stringify({tick:sim.state.tick,assault,assaultTick,searchIndex,searchStarted,searchTarget:searchPoints[searchIndex],siteIndex,woodGathered,milestones:[...milestones],bank:{resources:lastView.self.resources,population:lastView.self.population,populationCap:lastView.self.populationCap},enemy:lastView.entities.filter(e=>e.ownerId==='red').map(e=>({type:e.typeId,hp:e.hp})),army:lastView.entities.filter(e=>e.ownerId==='blue'&&e.kind==='unit').map(e=>({type:e.typeId,x:e.xMm,z:e.zMm,order:e.order,task:e.taskState,blocked:e.blockedReason})),planning:sim.pathDiagnostics(),rejections:[...new Set(receipts)]})).toBe('blue');
  expect([...milestones]).toEqual(expect.arrayContaining(['wood','house','villager','militia']));
  console.info('AT-05 scripted two-human field battle and conquest',{seed:'standard-loop-05',tick:result.tick,winner:result.result!.winnerTeamId,survivingPopulation:result.self.population});
},200000);
