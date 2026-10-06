import { performance } from 'node:perf_hooks';
import { createSimulation } from '@frontier/simulation';
import { balance, contentHash, effectiveUnit, type PublicPlayer } from '@frontier/shared';
import { engineIdentity } from '../apps/server/src/build-info.js';

// An ordinary-start diagnostic, intentionally separate from the fast test suite.
// This script reads authoritative accounting but never changes simulation state.
const seed=process.env.FALLBACK_SEED??'m2-fallback-natural-20260919';
// Current ordinary AI first finishes farms near tick 10000. Allow time for
// genuine depletion and paid reseeding; do not accelerate work or inject stock.
const ticks=Number(process.env.FALLBACK_TICKS??36000);
if(!Number.isInteger(ticks)||ticks<1||ticks>36000)throw new Error('INVALID_FALLBACK_TICKS');
const factions:PublicPlayer[]=[
  {id:'a',name:'Alder',teamId:'a',color:'#3388ff',kind:'ai',difficulty:'easy'},
  {id:'b',name:'Birch',teamId:'b',color:'#ee7744',kind:'ai',difficulty:'easy'},
];
const setup=performance.now(),sim=createSimulation({seed,mapType:'river_divide',matchId:'natural-fallback',factions}),started=performance.now();
const resourceTypes=balance.resourceOrder;
const initialNodes=Object.fromEntries(resourceTypes.map(resource=>[resource,Object.values(sim.state.entities).reduce((sum,entity)=>sum+(entity.kind==='resource'&&entity.resource===resource?entity.amount:0),0)]));
const previousFarm=new Map<string,number>();
const carryCapacities=new Map<string,number>();
const farmEvidence=new Map<string,{firstCompletedTick?:number;firstExhaustedTick?:number;firstPaidTick?:number;firstReseedCompletedTick?:number}>();
const paidFarms=new Set<string>(),completedReseeds=new Set<string>(),ledgerOffsets=new Map<string,number>();
let farmHarvest=0,maximumFarmers=0,maximumCargo=0;
function summary(){return factions.map(player=>{
  const entities=Object.values(sim.state.entities).filter(entity=>entity.ownerId===player.id),economy=sim.state.economies[player.id]!;
  return {id:player.id,bank:economy.resources,collected:economy.collected,units:entities.filter(entity=>entity.kind==='unit').length,villagers:entities.filter(entity=>entity.typeId==='villager').length,
    farms:entities.filter(entity=>entity.kind==='building'&&entity.typeId==='farm').map(entity=>({id:entity.id,food:'foodRemaining'in entity?entity.foodRemaining:0,progress:'work'in entity?entity.work/entity.required:0,assigned:'farmerId'in entity&&Boolean(entity.farmerId)})),
    reseedPayments:economy.ledger.filter(entry=>entry.reason==='farm_reseed'&&entry.resource==='wood').length,autoReseed:economy.autoReseed,notices:economy.notifications.slice(-3)};
});}
console.log(JSON.stringify({event:'start',...engineIdentity,contentHash,seed,mapType:'river_divide',setupMs:Math.round(started-setup),tickGoal:ticks,mutations:'ordinary fallback commands only'}));
for(let index=0;index<ticks&&sim.state.status==='RUNNING';index++){
  sim.step();
  for(const economy of Object.values(sim.state.economies))for(const amount of Object.values(economy.resources))if(!Number.isSafeInteger(amount)||amount<0)throw new Error('BANK_INVARIANT');
  for(const player of factions){
    const ledger=sim.state.economies[player.id]!.ledger,evidence=farmEvidence.get(player.id)??{};farmEvidence.set(player.id,evidence);
    for(let i=ledgerOffsets.get(player.id)??0;i<ledger.length;i++){const entry=ledger[i]!;if(entry.reason==='farm_reseed'&&entry.resource==='wood'&&entry.deltaMilli<0&&entry.entityId){paidFarms.add(entry.entityId);evidence.firstPaidTick??=entry.tick;}}
    ledgerOffsets.set(player.id,ledger.length);
  }
  const entities=Object.values(sim.state.entities);
  for(const entity of entities){
    if(entity.kind==='resource'&&(!Number.isSafeInteger(entity.amount)||entity.amount<0))throw new Error('NODE_INVARIANT');
    if(entity.kind==='unit'){
      const economy=sim.state.economies[entity.ownerId]!,key=`${entity.ownerId}:${economy.researchRevision}:${entity.typeId}`;
      let capacity=carryCapacities.get(key);
      if(capacity===undefined){capacity=(effectiveUnit(entity.typeId,economy.technologies).carryCapacity??balance.rules.carryCapacity)*balance.rules.resourceScale;carryCapacities.set(key,capacity);}
      if(!Number.isSafeInteger(entity.cargo.amount)||entity.cargo.amount<0||entity.cargo.amount>capacity)throw new Error(`CARGO_INVARIANT:${JSON.stringify({tick:sim.state.tick,id:entity.id,amount:entity.cargo.amount,capacity,technologies:economy.technologies})}`);
      maximumCargo=Math.max(maximumCargo,entity.cargo.amount);
    }
    if(entity.kind==='building'&&entity.typeId==='farm'){
      const amount=entity.foodRemaining??0,previous=previousFarm.get(entity.id)??0;
      const evidence=farmEvidence.get(entity.ownerId)!;
      if(entity.work>=entity.required){
        evidence.firstCompletedTick??=sim.state.tick;
        if(amount===0)evidence.firstExhaustedTick??=sim.state.tick;
        if(paidFarms.has(entity.id)&&!entity.reseedRequired&&amount>0){completedReseeds.add(entity.ownerId);evidence.firstReseedCompletedTick??=sim.state.tick;}
      }
      if(!Number.isSafeInteger(amount)||amount<0)throw new Error('FARM_FOOD_INVARIANT');
      if(amount<previous)farmHarvest+=previous-amount;previousFarm.set(entity.id,amount);
      const active=entities.filter(worker=>worker.kind==='unit'&&worker.taskState==='gathering'&&worker.orders[0]?.targetId===entity.id).length;
      maximumFarmers=Math.max(maximumFarmers,active);if(active>1)throw new Error('FARMER_INVARIANT');
    }
  }
  if(sim.state.tick%1000===0)console.log(JSON.stringify({event:'progress',tick:sim.state.tick,elapsedMs:Math.round(performance.now()-started),players:summary()}));
}
const conservation=resourceTypes.map(resource=>{
  const remaining=Object.values(sim.state.entities).reduce((sum,entity)=>sum+(entity.kind==='resource'&&entity.resource===resource?entity.amount:0),0);
  const collected=Object.values(sim.state.economies).reduce((sum,economy)=>sum+economy.collected[resource],0),lost=Object.values(sim.state.economies).reduce((sum,economy)=>sum+economy.lostCargo[resource],0);
  const carried=Object.values(sim.state.entities).reduce((sum,entity)=>sum+(entity.kind==='unit'&&entity.cargo.resource===resource?entity.cargo.amount:0),0),extracted=initialNodes[resource]!-remaining+(resource==='food'?farmHarvest:0);
  if(extracted!==collected+lost+carried)throw new Error(`CONSERVATION_${resource}:${JSON.stringify({extracted,collected,lost,carried})}`);
  for(const economy of Object.values(sim.state.economies)){
    const ledger=economy.ledger.filter(entry=>entry.resource===resource).reduce((sum,entry)=>sum+entry.deltaMilli,balance.start.resources[resource]*balance.rules.resourceScale);
    if(ledger!==economy.resources[resource])throw new Error(`LEDGER_${resource}`);
  }
  return {resource,extracted,collected,lost,carried};
});
if(ticks>=18000)for(const player of factions){
  const economy=sim.state.economies[player.id]!;
  if(resourceTypes.some(resource=>economy.collected[resource]<=0))throw new Error(`NO_RESOURCE_INCOME_${player.id}`);
  if(!completedReseeds.has(player.id))throw new Error(`NO_COMPLETED_RESEED_${player.id}:${JSON.stringify(farmEvidence.get(player.id))}`);
}
console.log(JSON.stringify({event:'done',...engineIdentity,contentHash,seed,mapType:'river_divide',tick:sim.state.tick,status:sim.state.status,elapsedMs:Math.round(performance.now()-started),maximumFarmers,maximumCargo,farmHarvest,farmEvidence:Object.fromEntries(farmEvidence),players:summary(),conservation,commands:sim.state.commandLog.length,modelInferenceIncluded:false}));
