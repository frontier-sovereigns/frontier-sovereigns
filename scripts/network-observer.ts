import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocket } from 'ws';
import { SnapshotAssembler, DeltaAssembler, applyViewDelta, balance, resolveRuleset, contentHash, units, buildings, OWNED_ENTITY_FIELDS, validateServerSocketMessage, type ClientCommandEnvelope, type CommandReceipt, type GameplayCommand, type PlayerView, type ServerSocketMessage, type ViewEntity } from '@frontier/shared';
import { PerformanceDiagnostics, ViewDeliveryDiagnostics, type PublicationStamp } from '../apps/server/src/performance-diagnostics.js';
import { capacityDutyCommands, createCapacityDutyMemory, type CapacityDrill } from './load-fixture.js';
import { createPlaythroughMemory, observePlaythrough, planPlaythrough, playthroughCommandSent, playthroughReceipt } from './playthrough-policy.js';

export interface Login {cookie:string;csrf:string;playerId:string;host:boolean}
export type ObserverMode='process'|'inline';
export type StampKey={playerId:string;matchId:string;epoch:number;sequence:number};
export type StampLookup=(key:StampKey)=>Promise<PublicationStamp|undefined>;
export const DELIVERY_JOIN_TIMEOUT_MS=2000;
export interface ObserverConfiguration {
  mode:ObserverMode;baseUrl:string;origin:string;profile:'starting'|'capacity'|'playthrough';profileIndex:number;seed:number;
  performanceDiagnosticsEnabled:boolean;drop:number;latencyMs:number;jitterMs:number;stallProbability:number;stallMs:number;
  drill?:CapacityDrill;
  inlineStampLookup?:(playerId:string,matchId:string,epoch:number,sequence:number)=>PublicationStamp|undefined;
}
export const OBSERVER_RPC_LIMIT=16,OBSERVER_SUMMARY_LIMIT=64*1024,OBSERVER_MESSAGE_LIMIT=4*1024*1024;
export const impairmentRandom=(seed:number,client:number,stream:number,ordinal:number)=>{let state=(seed^Math.imul(client+1,2654435761)^Math.imul(stream,2246822519)^Math.imul(ordinal,3266489917))>>>0;state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function requireThat(condition:unknown,code:string):asserts condition{if(!condition)throw new Error(code);}
export function assertObserverMessageSize(value:unknown,limit=OBSERVER_MESSAGE_LIMIT):void {requireThat(Buffer.byteLength(JSON.stringify(value))<=limit,'OBSERVER_IPC_BYTE_BOUND');}

function footprintObserved(view:PlayerView,entity:ViewEntity,cells:Set<number>):boolean{
  const cell=view.map.fogCellMm,width=view.map.widthMm/cell,height=view.map.heightMm/cell;
  if(entity.kind==='unit'){
    const radius=units[entity.typeId].collisionRadiusM*1000;
    for(let z=Math.max(0,Math.floor((entity.zMm-radius)/cell));z<=Math.min(height-1,Math.floor((entity.zMm+radius)/cell));z++)for(let x=Math.max(0,Math.floor((entity.xMm-radius)/cell));x<=Math.min(width-1,Math.floor((entity.xMm+radius)/cell));x++)if(cells.has(z*width+x)){const dx=Math.max(x*cell-entity.xMm,0,entity.xMm-(x+1)*cell),dz=Math.max(z*cell-entity.zMm,0,entity.zMm-(z+1)*cell);if(dx*dx+dz*dz<=radius*radius)return true;}
    return false;
  }
  let halfWidth=entity.resource==='wood'?450:650,halfHeight=halfWidth;
  if(entity.kind==='building'){let [w,h]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[w,h]=[h,w];halfWidth=w*1000;halfHeight=h*1000;}
  for(let z=Math.max(0,Math.floor((entity.zMm-halfHeight)/cell));z<=Math.min(height-1,Math.ceil((entity.zMm+halfHeight)/cell)-1);z++)for(let x=Math.max(0,Math.floor((entity.xMm-halfWidth)/cell));x<=Math.min(width-1,Math.ceil((entity.xMm+halfWidth)/cell)-1);x++)if(cells.has(z*width+x))return true;
  return false;
}
function inspectView(view:PlayerView,playerId:string,secrets:readonly string[]){
  requireThat(view.playerId===playerId&&view.contentHash===resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).contentHash,'RECIPIENT_OR_CONTENT_MISMATCH');requireThat(view.players.length===11,'FACTION_CAPACITY_MISMATCH');
  const visible=new Set(view.fog.visible),explored=new Set(view.fog.explored),raw=JSON.stringify(view);
  for(const secret of secrets)requireThat(!raw.includes(secret),'VIEW_CREDENTIAL_LEAK');
  for(const key of ['seed','randomState','secretIdKey','receipts','commandLog','economies','controllers','control','runtime'])requireThat(!Object.hasOwn(view,key),'PRIVATE_STATE_LEAK');
  for(const player of view.players)for(const key of ['resources','technologies','goals','memory'])requireThat(!Object.hasOwn(player,key),'PRIVATE_PLAYER_LEAK');
  for(const entity of view.entities){
    if(entity.ownerId===playerId)continue;
    for(const key of OWNED_ENTITY_FIELDS)requireThat(!Object.hasOwn(entity,key),`OWNER_FIELD_LEAK:${key}`);
    requireThat(entity.ghost?entity.kind!=='unit'&&footprintObserved(view,entity,explored):footprintObserved(view,entity,visible),'UNOBSERVED_ENTITY_LEAK');
  }
}

class SocketObserver {
  private deliveryMetrics:PerformanceDiagnostics|undefined;
  private deliveryDiagnostics:ViewDeliveryDiagnostics|undefined;
  private processDelivery:ProcessDeliveryDiagnostics|undefined;
  private policy:ReturnType<typeof createPlaythroughMemory>|undefined;
  private dutyMemory=createCapacityDutyMemory();
  private impair=false;
  private awaitingSnapshot=true;
  private frozen:ObserverMeasurement|undefined;
  private purchaseId:string|undefined;
  failure:Error|undefined;
  deliverySnapshot(){return this.deliveryMetrics?{...this.deliveryMetrics.snapshot(),movement:this.processDelivery?.snapshot()??this.deliveryDiagnostics!.snapshot(),scope:this.config.mode==='process'?'Observer-local issue to certified application; cross-process server delivery age, accepted-to-application and first-move-to-application are unknown. No renderer.':'Inline same-host monotonic certificate timing; no renderer.'}:undefined;}
  communication?:Extract<ServerSocketMessage,{type:'communication'}>['state'];
  socket?:WebSocket;view?:PlayerView;assembly=new SnapshotAssembler();deltaAssembly=new DeltaAssembler();generation=0;sequence=0;closed=false;loadingKey='';lastResync=-Infinity;receiveDue=0;sendDue=0;replicationOrdinal=0;outboundOrdinal=0;
  timers=new Set<NodeJS.Timeout>();receipts=new Map<string,CommandReceipt[]>();sentAt=new Map<string,number>();rtts:number[]=[];
  unresolved=new Map<string,ClientCommandEnvelope>();retryUnresolved=false;
  dropNextReceipt=false;
  measuringSince=0;downstreamBins:number[]=[];upstreamBins:number[]=[];largestFullViewBytes=0;
  metrics={receivedBytes:0,sentBytes:0,receivedFrames:0,sentFrames:0,snapshotChunks:0,deltaChunks:0,chunkedDeltas:0,fullSnapshots:0,deltas:0,views:0,droppedReplicationFrames:0,deliberatelyDroppedReceipts:0,unresolvedReplays:0,decodeRecoveries:0,resyncRequests:0,connections:0,commands:0,receipts:0,receiptOutcomes:{} as Record<string,number>,secrecyChecks:0,maxViewEntities:0,maxFrameBytes:0,headOfLineStalls:0,maxQueuedDeliveryMs:0};
  constructor(public session:Login,readonly config:ObserverConfiguration,private readonly stampLookup:StampLookup=async()=>undefined){
    this.deliveryMetrics=config.performanceDiagnosticsEnabled?new PerformanceDiagnostics():undefined;
    if(this.deliveryMetrics){if(config.mode==='process')this.processDelivery=new ProcessDeliveryDiagnostics(this.deliveryMetrics,stampLookup);else this.deliveryDiagnostics=new ViewDeliveryDiagnostics(this.deliveryMetrics);}
  }
  private get profileIndex(){return this.config.profileIndex;}
  private get secrets(){return [this.session.cookie.split('=')[1]!,this.session.csrf].filter(Boolean);}
  private random(stream:number,ordinal:number){return impairmentRandom(this.config.seed,this.profileIndex,stream,ordinal);}
  schedule(callback:()=>void,delay:number){if(delay<=0){callback();return;}const timer=setTimeout(()=>{this.timers.delete(timer);callback();},delay);this.timers.add(timer);}
  async connect(){
    this.deliveryDiagnostics?.reset();this.processDelivery?.reset();
    this.retryUnresolved=true;
    this.closed=false;this.view=undefined;this.awaitingSnapshot=true;this.assembly=new SnapshotAssembler();this.deltaAssembly.reset();this.receiveDue=this.sendDue=0;const generation=++this.generation,socket=this.socket=new WebSocket(this.config.baseUrl.replace('http:','ws:')+'/ws?deltaChunks=1',{headers:{origin:this.config.origin,cookie:this.session.cookie}});
    socket.on('error',()=>{if(!this.closed)this.failure=new Error('SOCKET_ERROR');});
    socket.on('close',()=>{if(!this.closed&&generation===this.generation)this.failure=new Error('SOCKET_CLOSED');});
    socket.on('message',buffer=>{
      try{
        const raw=buffer.toString(),size=Buffer.byteLength(raw);this.metrics.receivedBytes+=size;this.metrics.receivedFrames++;this.metrics.maxFrameBytes=Math.max(this.metrics.maxFrameBytes,size);requireThat(size<=65536,'WIRE_FRAME_LIMIT');
        if(this.measuringSince){const bin=Math.floor((performance.now()-this.measuringSince)/1000);this.downstreamBins[bin]=(this.downstreamBins[bin]??0)+size;}
        const message:unknown=JSON.parse(raw);requireThat(validateServerSocketMessage(message),'INVALID_SERVER_MESSAGE');
        if(message.type==='snapshot_chunk')this.metrics.snapshotChunks++;if(message.type==='delta_chunk')this.metrics.deltaChunks++;if(message.type==='delta')this.metrics.deltas++;
        for(const secret of this.secrets)requireThat(!raw.includes(secret),'WIRE_CREDENTIAL_LEAK');
        if(this.impair&&(message.type==='snapshot_chunk'||message.type==='delta_chunk'||message.type==='delta')&&this.random(1,++this.replicationOrdinal)<this.config.drop){this.metrics.droppedReplicationFrames++;return;}
        const now=performance.now(),delay=this.impair?this.config.latencyMs+this.random(2,this.metrics.receivedFrames)*this.config.jitterMs:0;this.receiveDue=Math.max(now+delay,this.receiveDue);if(this.impair&&this.random(4,this.metrics.receivedFrames)<this.config.stallProbability){this.receiveDue+=this.config.stallMs;this.metrics.headOfLineStalls++;}this.metrics.maxQueuedDeliveryMs=Math.max(this.metrics.maxQueuedDeliveryMs,this.receiveDue-now);requireThat(this.timers.size<2000,'IMPAIRMENT_QUEUE_BOUND');this.schedule(()=>{if(generation===this.generation&&!this.closed)try{this.receive(message);}catch(error){this.failure=error instanceof Error?error:new Error('RECEIVE_FAILED');}},this.receiveDue-now);
      }catch(error){this.failure=error instanceof Error?error:new Error('DECODE_FAILED');}
    });
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('CONNECT_TIMEOUT')),10000);socket.once('open',()=>{clearTimeout(timer);this.metrics.connections++;resolve();});socket.once('error',()=>{clearTimeout(timer);reject(new Error('CONNECT_FAILED'));});});
  }
  receive(message:ServerSocketMessage){
    if(message.type==='error')throw new Error(`SERVER_ERROR:${message.code}`);
    if(message.type==='communication'){this.communication=message.state;return;}
    if(message.type==='receipt'){const outcome=message.receipt.code??message.receipt.status;this.metrics.receiptOutcomes[outcome]=(this.metrics.receiptOutcomes[outcome]??0)+1;}
    if(message.type==='receipt'&&this.dropNextReceipt){this.dropNextReceipt=false;this.metrics.deliberatelyDroppedReceipts++;return;}
    if(message.type==='receipt'){this.processDelivery?.receipt(message.receipt);this.unresolved.delete(message.receipt.clientCommandId);this.metrics.receipts++;const list=this.receipts.get(message.receipt.clientCommandId)??[];requireThat(list.length<16,'DUPLICATE_RECEIPT_BOUND');list.push(message.receipt);this.receipts.set(message.receipt.clientCommandId,list);const sent=this.sentAt.get(message.receipt.clientCommandId);if(sent!==undefined){requireThat(this.rtts.length<100000,'RECEIPT_TIMING_SAMPLE_BOUND');this.rtts.push(performance.now()-sent);this.sentAt.delete(message.receipt.clientCommandId);}if(this.receipts.size>1024){const oldest=[...this.receipts.keys()].find(id=>id!==this.purchaseId);if(oldest)this.receipts.delete(oldest);}const policy=this.policy;if(policy)playthroughReceipt(policy,message.receipt);return;}
    let view:PlayerView|undefined;
    if((message.type==='delta'||message.type==='delta_chunk')&&this.awaitingSnapshot){if(this.assembly.expire(performance.now()))this.recover();return;}
    if(message.type==='snapshot_chunk'){
      if(this.view&&message.playerId===this.view.playerId&&message.contentHash===this.view.contentHash&&message.matchId===this.view.matchId&&(message.matchEpoch<this.view.matchEpoch||message.matchEpoch===this.view.matchEpoch&&(message.sequence<this.view.sequence||!this.awaitingSnapshot&&message.sequence===this.view.sequence)))return;
      this.deltaAssembly.reset();this.awaitingSnapshot=true;
      const result=this.assembly.push(message,performance.now());if(result.status==='rejected'){this.recover();return;}if(result.status==='complete'){view=result.view;this.metrics.fullSnapshots++;}
    }else if(message.type==='snapshot'){this.assembly.reset();this.deltaAssembly.reset();view=message.view;this.metrics.fullSnapshots++;}
    else if(message.type==='delta_chunk'){
      const base=this.view;
      if(base&&message.playerId===base.playerId&&message.contentHash===base.contentHash&&message.matchId===base.matchId&&message.matchEpoch===base.matchEpoch&&message.sequence<=base.sequence)return;
      if(!base||message.playerId!==this.session.playerId||message.playerId!==base.playerId||message.contentHash!==base.contentHash||message.matchId!==base.matchId||message.matchEpoch!==base.matchEpoch||message.baseSequence!==base.sequence){this.recover();return;}
      const result=this.deltaAssembly.push(message,performance.now());if(result.status==='rejected'){this.recover();return;}if(result.status!=='complete')return;
      view=applyViewDelta(base,result.delta)??undefined;if(!view){this.recover();return;}this.metrics.chunkedDeltas++;
    }
    else if(message.type==='delta'){if(!this.view){this.recover();return;}view=applyViewDelta(this.view,message.delta)??undefined;if(!view){this.recover();return;}}
    if(!view)return;if(this.view&&view.matchEpoch===this.view.matchEpoch&&view.sequence<this.view.sequence)return;
    this.assembly.reset();this.deltaAssembly.reset();this.awaitingSnapshot=false;
    const appliedAt=this.deliveryMetrics?.now();inspectView(view,this.session.playerId,this.secrets);this.largestFullViewBytes=Math.max(this.largestFullViewBytes,Buffer.byteLength(JSON.stringify(view)));this.metrics.secrecyChecks++;this.metrics.views++;this.metrics.maxViewEntities=Math.max(this.metrics.maxViewEntities,view.entities.length);this.view=view;this.sequence=Math.max(this.sequence,view.self.lastCommandSequence);
    if(this.measuringSince){if(this.deliveryDiagnostics){const stamp=this.config.inlineStampLookup?.(view.playerId,view.matchId,view.matchEpoch,view.sequence);this.deliveryDiagnostics.observe(view,stamp);}this.processDelivery?.observe(view,appliedAt!);}
    const policy=this.policy;if(policy)observePlaythrough(view,policy);
    if(this.retryUnresolved){this.retryUnresolved=false;for(const [id,envelope]of this.unresolved){if(envelope.matchId!==view.matchId||envelope.matchEpoch!==view.matchEpoch)this.unresolved.delete(id);else{this.metrics.unresolvedReplays++;this.send(envelope);}}}
    if(view.status==='LOADING'){const key=`${view.matchId}:${view.matchEpoch}`;if(this.loadingKey!==key){this.loadingKey=key;this.send({type:'loaded',contentHash: view.contentHash,matchId:view.matchId,matchEpoch:view.matchEpoch},false);}}
  }
  recover(){this.metrics.decodeRecoveries++;this.view=undefined;this.awaitingSnapshot=true;this.assembly.reset();this.deltaAssembly.reset();this.resync();}
  resync(){if(performance.now()-this.lastResync<500)return;this.awaitingSnapshot=true;this.assembly.reset();this.deltaAssembly.reset();this.lastResync=performance.now();this.metrics.resyncRequests++;this.send({type:'resync'});}
  send(value:unknown,delayed=true){
    if(value&&typeof value==='object'&&'clientCommandId'in value&&typeof value.clientCommandId==='string')this.sentAt.set(value.clientCommandId,performance.now());
    const generation=this.generation,raw=JSON.stringify(value),now=performance.now(),delay=this.impair&&delayed?this.config.latencyMs+this.random(3,++this.outboundOrdinal)*this.config.jitterMs:0;this.sendDue=Math.max(now+delay,this.sendDue);
    this.schedule(()=>{if(generation!==this.generation||this.closed||this.socket?.readyState!==WebSocket.OPEN)return;const bytes=Buffer.byteLength(raw);this.metrics.sentFrames++;this.metrics.sentBytes+=bytes;if(this.measuringSince){const bin=Math.floor((performance.now()-this.measuringSince)/1000);this.upstreamBins[bin]=(this.upstreamBins[bin]??0)+bytes;}this.socket.send(raw);},this.sendDue-now);
  }
  command(command:GameplayCommand):ClientCommandEnvelope{
    requireThat(this.view,'COMMAND_WITHOUT_VIEW');const envelope:ClientCommandEnvelope={protocolVersion:2,matchId:this.view.matchId,matchEpoch:this.view.matchEpoch,clientCommandId:`load_${this.session.playerId}_${++this.sequence}`,clientSequence:this.sequence,command};this.unresolved.set(envelope.clientCommandId,envelope);requireThat(this.unresolved.size<=200,'UNACKNOWLEDGED_COMMAND_BOUND');this.metrics.commands++;this.sentAt.set(envelope.clientCommandId,performance.now());if(this.measuringSince){this.deliveryDiagnostics?.commandIssued(this.session.playerId,envelope);this.processDelivery?.commandIssued(envelope);}const policy=this.policy;if(policy)playthroughCommandSent(policy,envelope);this.send(envelope);return envelope;
  }
  async disconnect(){this.deliveryDiagnostics?.reset();this.processDelivery?.reset();this.closed=true;this.generation++;for(const timer of this.timers)clearTimeout(timer);this.timers.clear();const socket=this.socket;if(socket&&socket.readyState!==WebSocket.CLOSED){socket.close();await Promise.race([new Promise<void>(resolve=>socket.once('close',()=>resolve())),sleep(1000)]);if(Number(socket.readyState)!==WebSocket.CLOSED)socket.terminate();}}

  state():ObserverState {
    const view=this.view;
    const state:ObserverState={pid:process.pid,memory:process.memoryUsage(),metrics:{...this.metrics,receiptOutcomes:{...this.metrics.receiptOutcomes}},unresolvedCount:this.unresolved.size,
      receipts:this.purchaseId?[[this.purchaseId,this.receipts.get(this.purchaseId)??[]]]:[],failureCode:this.failure?.message??null,
      communication:this.communication?{messages:this.communication.messages.map(({text,source,channel,senderId})=>({text,source,channel,senderId}))}:undefined,
      view:view?{playerId:view.playerId,matchId:view.matchId,matchEpoch:view.matchEpoch,tick:view.tick,sequence:view.sequence,status:view.status,self:{resources:{...view.self.resources},population:view.self.population,technologies:view.self.technologies},players:view.players,result:view.result,enemyAiVisible:view.entities.some(entity=>entity.ownerId?.startsWith('ai_'))}:undefined};
    assertObserverMessageSize(state,OBSERVER_SUMMARY_LIMIT);return state;
  }
  async operation(operation:ObserverOperation):Promise<unknown>{
    if(this.failure&&operation.kind!=='capture'&&operation.kind!=='disconnect'&&operation.kind!=='shutdown')throw this.failure;
    switch(operation.kind){
      case 'connect':this.session=operation.session;await this.connect();return;
      case 'disconnect':case 'shutdown':await this.disconnect();return;
      case 'first-purchase':{
        const view=this.view;requireThat(view,'PURCHASE_WITHOUT_VIEW');this.dropNextReceipt=operation.dropReceipt;
        const capacity=this.config.profile==='capacity',home=view.entities.find(entity=>entity.ownerId===this.session.playerId&&entity.typeId===(capacity?'market':'town_center'));requireThat(home,'PURCHASE_BUILDING_MISSING');
        const expectedFood=view.self.resources.food-(capacity?balance.rules.market.tradeLot:units.villager.cost.food);
        const envelope=this.command(capacity?{kind:'market_trade',marketId:home.id,side:'sell',resource:'food',lots:1}:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1});this.purchaseId=envelope.clientCommandId;return {envelope,expectedFood};
      }
      case 'send':this.send(operation.envelope);return;
      case 'resync':if(operation.force)this.lastResync=-Infinity;this.resync();return;
      case 'impair':this.impair=operation.enabled;return;
      case 'measure':this.measuringSince=performance.now();this.rtts.length=0;this.impair=true;if(this.config.profile==='playthrough')this.policy=createPlaythroughMemory();return;
      case 'orders':{
        const view=this.view;if(!view||view.status!=='RUNNING')return;
        if(this.config.profile==='capacity'){requireThat(this.config.drill,'CAPACITY_DRILL_MISSING');for(const command of capacityDutyCommands(view,this.config.drill,this.dutyMemory))this.command(command);return;}
        if(this.config.profile==='playthrough'){requireThat(this.policy,'PLAYTHROUGH_POLICY_MISSING');for(const command of planPlaythrough(view,this.policy))this.command(command);return;}
        const own=view.entities.filter(entity=>entity.ownerId===view.playerId),nodes=view.entities.filter(entity=>entity.kind==='resource'&&!entity.ghost&&(entity.amount??0)>0),workers=own.filter(entity=>entity.typeId==='villager');
        for(const [workerIndex,worker]of workers.entries())if(worker.order==='idle'){const resource=(['wood','food','food','gold','wood','stone'] as const)[workerIndex%6],node=nodes.filter(node=>node.resource===resource).sort((a,b)=>Math.hypot(a.xMm-worker.xMm,a.zMm-worker.zMm)-Math.hypot(b.xMm-worker.xMm,b.zMm-worker.zMm))[0];if(node)this.command({kind:'gather',unitIds:[worker.id],targetId:node.id,queued:false});}
        const scout=own.find(entity=>entity.typeId==='scout');if(scout?.order==='idle'){const target={xMm:Math.max(1000,Math.min(view.map.widthMm-1000,scout.xMm+(this.profileIndex%2?6000:-6000))),zMm:Math.max(1000,Math.min(view.map.heightMm-1000,scout.zMm+4000))};this.command({kind:'move',unitIds:[scout.id],target,queued:false});}return;
      }
      case 'capture':{
        if(this.frozen)return this.frozen;
        this.processDelivery?.expire();
        const result:ObserverMeasurement=structuredClone({...this.state(),playerId:this.session.playerId,hostPlayer:this.session.host,downstreamBins:this.downstreamBins,rtts:this.rtts,largestFullViewBytes:this.largestFullViewBytes,deliveryDiagnostics:this.deliverySnapshot(),telemetry:this.policy?{playerId:this.session.playerId,...this.policy.telemetry}:undefined,measuredDurationMs:this.measuringSince?performance.now()-this.measuringSince:0});
        assertObserverMessageSize(result);if(operation.freeze)this.frozen=result;return result;
      }
    }
  }
}

export interface ObserverState {
  pid:number;memory:NodeJS.MemoryUsage;metrics:SocketObserver['metrics'];unresolvedCount:number;receipts:[string,CommandReceipt[]][];failureCode:string|null;
  communication?:{messages:Pick<Extract<ServerSocketMessage,{type:'communication'}>['state']['messages'][number],'text'|'source'|'channel'|'senderId'>[]};
  view?:Pick<PlayerView,'playerId'|'matchId'|'matchEpoch'|'tick'|'sequence'|'status'|'players'|'result'>&{self:Pick<PlayerView['self'],'resources'|'population'|'technologies'>;enemyAiVisible:boolean};
}
export interface ObserverMeasurement extends ObserverState {playerId:string;hostPlayer:boolean;downstreamBins:number[];rtts:number[];largestFullViewBytes:number;deliveryDiagnostics?:ReturnType<SocketObserver['deliverySnapshot']>;telemetry?:ReturnType<typeof createPlaythroughMemory>['telemetry']&{playerId:string};measuredDurationMs:number}
export type ObserverOperation={kind:'connect';session:Login}|{kind:'disconnect'|'shutdown'|'measure'|'orders'}|{kind:'first-purchase';dropReceipt:boolean}|{kind:'send';envelope:ClientCommandEnvelope}|{kind:'resync';force?:boolean}|{kind:'impair';enabled:boolean}|{kind:'capture';freeze:boolean};

/** Joins private certificates asynchronously, retaining application time in this
 * process. Server timestamps are never subtracted from this process's clock. */
export class ProcessDeliveryDiagnostics {
  private issued=new Map<string,{envelope:ClientCommandEnvelope;atMs:number;pendingEligibleJoins:number}>();
  private inFlight=0;private generation=0;private previous?:{matchId:string;epoch:number;tick:number;atMs:number};
  constructor(private readonly metrics:PerformanceDiagnostics,private readonly lookup:StampLookup){}
  reset(){if(this.issued.size)this.metrics.count('deliveredMoveBoundaryCensored',this.issued.size);this.issued.clear();this.previous=undefined;this.generation++;}
  commandIssued(envelope:ClientCommandEnvelope){
    if(envelope.command.kind!=='move'||envelope.command.queued!==false)return;this.expire();
    // The observer cannot infer the server's idle-unit eligibility from issuance.
    // Keep every candidate in the denominator, including explicitly counted overflow.
    this.metrics.count('deliveredMoveIssued');
    if(this.issued.size>=64||[...this.issued.values()].reduce((sum,item)=>sum+(item.envelope.command.kind==='move'?item.envelope.command.unitIds.length:0),0)+envelope.command.unitIds.length>4096){this.metrics.count('deliveredMoveOverflow');return;}
    this.issued.set(envelope.clientCommandId,{envelope,atMs:this.metrics.now(),pendingEligibleJoins:0});this.metrics.count('deliveredMoveCandidatesTracked');
  }
  receipt(receipt:CommandReceipt){if(receipt.status!=='accepted'&&this.issued.delete(receipt.clientCommandId))this.metrics.count('deliveredMoveRejected');}
  expire(){const now=this.metrics.now();for(const [id,item]of this.issued)if(now-item.atMs>10000&&item.pendingEligibleJoins===0){this.issued.delete(id);this.metrics.count('deliveredMoveUncertifiedAtDeadline');}}
  observe(view:PlayerView,appliedAtMs:number){
    if(view.status!=='RUNNING'){this.reset();return;}const previous=this.previous;
    if(!Number.isFinite(appliedAtMs)||appliedAtMs<0){this.metrics.count('deliveryApplicationClockInvalid');this.expire();return;}
    if(previous?.matchId===view.matchId&&(view.matchEpoch<previous.epoch||view.matchEpoch===previous.epoch&&view.tick<=previous.tick)){this.metrics.count('repeatedOrStaleTickViews');this.expire();return;}
    if(previous?.matchId===view.matchId&&previous.epoch===view.matchEpoch)this.metrics.sample('viewDeliveryInterval',appliedAtMs-previous.atMs);
    this.previous={matchId:view.matchId,epoch:view.matchEpoch,tick:view.tick,atMs:appliedAtMs};this.metrics.count('distinctRunningTickViews');
    for(const [id,item]of this.issued)if(item.envelope.matchId!==view.matchId||item.envelope.matchEpoch!==view.matchEpoch){this.issued.delete(id);this.metrics.count('deliveredMoveBoundaryCensored');}
    const candidates=new Map([...this.issued].filter(([,item])=>appliedAtMs>=item.atMs&&appliedAtMs-item.atMs<=10000));
    if(!candidates.size){this.expire();return;}if(this.inFlight>=16){this.metrics.count('deliveryJoinOverflow');this.expire();return;}
    // Protect the captured application timestamp before consulting the current
    // clock: validation/auditing or IPC can finish after the delivery deadline.
    for(const item of candidates.values())item.pendingEligibleJoins++;
    this.expire();
    // Only commanded own bodies are retained, never the complete reconstructed view.
    const ids=new Set([...candidates.values()].flatMap(item=>item.envelope.command.kind==='move'?item.envelope.command.unitIds:[]));
    const bodies=new Map(view.entities.filter(entity=>ids.has(entity.id)&&entity.ownerId===view.playerId&&entity.kind==='unit'&&!entity.ghost&&!entity.garrisonedIn).map(entity=>[entity.id,{xMm:entity.xMm,zMm:entity.zMm,action:entity.visualAction?.kind}]));
    const key:StampKey={playerId:view.playerId,matchId:view.matchId,epoch:view.matchEpoch,sequence:view.sequence},tick=view.tick,generation=this.generation;this.inFlight++;
    let timer:NodeJS.Timeout|undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('OBSERVER_JOIN_TIMEOUT')),DELIVERY_JOIN_TIMEOUT_MS);timer.unref();});
    let lookup:Promise<PublicationStamp|undefined>;try{lookup=this.lookup(key);}catch(error){lookup=Promise.reject(error);}
    void Promise.race([lookup,timeout]).then(stamp=>{
      if(generation!==this.generation){this.metrics.count('deliveryJoinBoundaryCensored');return;}
      if(!stamp||stamp.matchId!==key.matchId||stamp.matchEpoch!==key.epoch||stamp.sequence!==key.sequence||stamp.tick!==tick){this.metrics.count('deliveryStampMissing');return;}
      for(const certificate of stamp.movements??[]){
        const item=candidates.get(certificate.commandId),body=bodies.get(certificate.unitId);
        if(!item||this.issued.get(certificate.commandId)!==item||certificate.playerId!==key.playerId||certificate.commandSequence!==item.envelope.clientSequence||!Number.isSafeInteger(certificate.orderRevision)||!Number.isSafeInteger(certificate.firstMoveTick)||certificate.firstMoveTick>tick||!body||body.xMm!==certificate.xMm||body.zMm!==certificate.zMm||!['move','carry'].includes(body.action??'')||appliedAtMs<item.atMs||appliedAtMs-item.atMs>10000)continue;
        this.metrics.sample('commandIssuedToDeliveredMove',appliedAtMs-item.atMs);this.metrics.count('deliveredMoveCompleted');this.issued.delete(certificate.commandId);
      }
    }).catch(error=>this.metrics.count(generation!==this.generation?'deliveryJoinBoundaryCensored':error instanceof Error&&error.message==='OBSERVER_JOIN_TIMEOUT'?'deliveryJoinTimedOut':'deliveryJoinFailed')).finally(()=>{if(timer)clearTimeout(timer);this.inFlight--;for(const item of candidates.values())item.pendingEligibleJoins--;this.expire();});
  }
  snapshot(){return {pendingCommands:this.issued.size,pendingJoins:this.inFlight,commandsAwaitingEligibleJoins:[...this.issued.values()].filter(item=>item.pendingEligibleJoins>0).length,commandLimit:64,unitLimit:4096,joinLimit:16,timeoutMs:10000,joinTimeoutMs:DELIVERY_JOIN_TIMEOUT_MS,clock:'observer-local monotonic',serverToObserverAbsoluteAge:null,eligibility:'All issued nonqueued Move candidates are counted, including overflow. Only previously idle own-unit transitions receive server certificates; eligibility is unknown for other issued candidates. Uncertified deadline expiry can mean ineligibility, unavailable certificates or missing delivery; it is not proof of non-delivery.',scope:'Issue to first applied authorized own-unit movement matched by asynchronous server certificate. Application timestamp must be within ten seconds of issue and is captured before lookup; IPC join latency is excluded. Pre-deadline application joins settle within the separate bounded join timeout before expiry. No cross-process clock mapping or rendered action claim.'};}
}

type ParentMessage={kind:'init';id:number;session:Login;configuration:ObserverConfiguration}|{kind:'rpc';id:number;operation:ObserverOperation}|{kind:'stamp-result';id:number;stamp?:PublicationStamp};
type ChildMessage={kind:'result';id:number;value?:unknown;state:ObserverState}|{kind:'summary';state:ObserverState}|{kind:'failure';code:string}|{kind:'stamp';id:number;key:StampKey};
const safeFailure=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]*(?::[A-Za-z0-9_:-]{1,120})?$/.test(error.message)?error.message:'OBSERVER_FAILED';

/** An allow-list prevents inherited model/API credentials and NODE_OPTIONS from
 * entering trusted QA children. Sessions travel only over this private IPC pipe. */
export function observerEnvironment(environment:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const allowed=new Set(['path','systemroot','windir','comspec','temp','tmp','tmpdir','userprofile','home','appdata','localappdata','programfiles','programfiles(x86)','programdata','pathext','lang','lc_all']);
  return Object.fromEntries(Object.entries(environment).filter(([key,value])=>value!==undefined&&allowed.has(key.toLowerCase())));
}

export class NetworkObserver {
  private inline?:SocketObserver;private child?:ChildProcess;private current?:ObserverState;
  private inlineStateAt=-Infinity;
  private operationTail:Promise<unknown>=Promise.resolve();private queuedOperations=0;
  private requestId=0;private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private ownFailure?:Error;private closing=false;private lastHeartbeat=0;
  constructor(public session:Login,private readonly configuration:()=>ObserverConfiguration,private readonly execution:'bundled-production'|'source-tsx'){}
  get state(){if(this.inline&&performance.now()-this.inlineStateAt>=1000){this.current=this.inline.state();this.inlineStateAt=performance.now();}return this.current;}
  get view(){return this.state?.view;}
  get metrics(){return this.state?.metrics??{receivedBytes:0,sentBytes:0,receivedFrames:0,sentFrames:0,snapshotChunks:0,deltaChunks:0,chunkedDeltas:0,fullSnapshots:0,deltas:0,views:0,droppedReplicationFrames:0,deliberatelyDroppedReceipts:0,unresolvedReplays:0,decodeRecoveries:0,resyncRequests:0,connections:0,commands:0,receipts:0,receiptOutcomes:{},secrecyChecks:0,maxViewEntities:0,maxFrameBytes:0,headOfLineStalls:0,maxQueuedDeliveryMs:0};}
  get receipts(){return new Map(this.state?.receipts??[]);}
  get unresolved(){return {size:this.state?.unresolvedCount??0};}
  get communication(){return this.state?.communication;}
  get pid(){return this.child?.pid??(this.inline?process.pid:undefined);}
  get memory(){return this.state?.memory;}
  get failure(){if(this.child&&!this.closing&&this.lastHeartbeat&&performance.now()-this.lastHeartbeat>15000)return new Error('OBSERVER_HEARTBEAT_TIMEOUT');return this.ownFailure??(this.state?.failureCode?new Error(this.state.failureCode):undefined);}
  private fail(error:Error){this.ownFailure??=error;for(const entry of this.pending.values()){clearTimeout(entry.timer);entry.reject(error);}this.pending.clear();}
  private sendIpc(message:ParentMessage){assertObserverMessageSize(message);requireThat(this.child?.connected,'OBSERVER_IPC_DISCONNECTED');this.child.send(message,error=>{if(error)this.fail(new Error('OBSERVER_IPC_SEND_FAILED'));});}
  private async request(message:Omit<Extract<ParentMessage,{kind:'rpc'}>,'id'>|Omit<Extract<ParentMessage,{kind:'init'}>,'id'>):Promise<unknown>{
    requireThat(this.pending.size<OBSERVER_RPC_LIMIT,'OBSERVER_RPC_PENDING_BOUND');const id=++this.requestId;
    return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);const error=new Error('OBSERVER_RPC_TIMEOUT');reject(error);this.fail(error);},20000);this.pending.set(id,{resolve,reject,timer});try{this.sendIpc({...message,id});}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});
  }
  private async ensure(){
    if(this.inline||this.child)return;const configuration=this.configuration();
    if(configuration.mode==='inline'){this.inline=new SocketObserver(this.session,configuration);return;}
    const entry=fileURLToPath(new URL(this.execution==='bundled-production'?'./network-observer.js':'./network-observer-worker.ts',import.meta.url));
    // Node 22 fork forwards these options to spawn; @types/node's ForkOptions
    // omits windowsHide even though the runtime's spawn path supports it.
    const options:ForkOptions&{windowsHide:boolean}={cwd:process.cwd(),windowsHide:true,execArgv:this.execution==='bundled-production'?[]:['--import','tsx'],env:observerEnvironment(process.env),stdio:['ignore','ignore','ignore','ipc'],serialization:'json'};
    const child=this.child=fork(entry,[],options);
    this.lastHeartbeat=performance.now();child.on('error',()=>this.fail(new Error('OBSERVER_PROCESS_ERROR')));
    child.on('exit',()=>{if(!this.closing)this.fail(new Error('OBSERVER_PROCESS_EXITED'));});
    child.on('message',(raw:unknown)=>{
      try{
        assertObserverMessageSize(raw);const message=raw as ChildMessage;this.lastHeartbeat=performance.now();
        if(message.kind==='failure'){this.fail(new Error(safeFailure(new Error(message.code))));return;}
        if(message.kind==='stamp'){
          requireThat(message.key.playerId===this.session.playerId,'OBSERVER_STAMP_RECIPIENT_MISMATCH');const stamp=configuration.inlineStampLookup?.(message.key.playerId,message.key.matchId,message.key.epoch,message.key.sequence);this.sendIpc({kind:'stamp-result',id:message.id,stamp});return;
        }
        requireThat(message.kind==='summary'||message.kind==='result','OBSERVER_MESSAGE_KIND');assertObserverMessageSize(message.state,OBSERVER_SUMMARY_LIMIT);requireThat(message.state.pid===child.pid,'OBSERVER_PID_MISMATCH');this.current=message.state;
        if(message.kind==='result'){const pending=this.pending.get(message.id);requireThat(pending,'OBSERVER_UNEXPECTED_REPLY');this.pending.delete(message.id);clearTimeout(pending.timer);pending.resolve(message.value);}
      }catch(error){this.fail(new Error(safeFailure(error)));}
    });
    const {inlineStampLookup:_,...serializable}=configuration;await this.request({kind:'init',session:this.session,configuration:serializable});
  }
  async operation<T=void>(operation:ObserverOperation):Promise<T>{
    requireThat(this.queuedOperations<OBSERVER_RPC_LIMIT,'OBSERVER_OPERATION_QUEUE_BOUND');this.queuedOperations++;
    const run=this.operationTail.then(async()=>{await this.ensure();if(this.inline){const result=await this.inline.operation(operation);this.current=this.inline.state();this.inlineStateAt=performance.now();return result as T;}return await this.request({kind:'rpc',operation}) as T;}).finally(()=>{this.queuedOperations--;});
    this.operationTail=run.catch(()=>{});return run;
  }
  async connect(){await this.operation({kind:'connect',session:this.session});}
  async disconnect(){if(this.inline||this.child?.connected)await this.operation({kind:'disconnect'});}
  async send(envelope:ClientCommandEnvelope){await this.operation({kind:'send',envelope});}
  async resync(force=false){await this.operation({kind:'resync',force});}
  async purchase(dropReceipt:boolean){return this.operation<{envelope:ClientCommandEnvelope;expectedFood:number}>({kind:'first-purchase',dropReceipt});}
  async capture(freeze=false){return this.operation<ObserverMeasurement>({kind:'capture',freeze});}
  async shutdown(){
    this.closing=true;try{if(this.inline)await this.inline.disconnect();else if(this.child?.connected)await Promise.race([this.operation({kind:'shutdown'}),sleep(3000)]);}catch{}
    const child=this.child;if(child){if(child.connected)child.disconnect();if(child.exitCode===null&&child.signalCode===null){await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(1000)]);if(child.exitCode===null&&child.signalCode===null)child.kill();}}
    this.fail(new Error('OBSERVER_SHUTDOWN'));
  }
}

export function runObserverProcess(){
  requireThat(process.send,'OBSERVER_REQUIRES_PRIVATE_IPC');let client:SocketObserver|undefined,stopped=false,rpcActive=false,stampId=0;
  const joins=new Map<number,{resolve:(stamp:PublicationStamp|undefined)=>void;timer:NodeJS.Timeout}>();
  let ipcPending=0;
  function send(message:ChildMessage){assertObserverMessageSize(message);requireThat(ipcPending<32,'OBSERVER_IPC_QUEUE_BOUND');requireThat(process.connected,'OBSERVER_PARENT_DISCONNECTED');ipcPending++;process.send!(message,error=>{ipcPending--;if(error)stop();});}
  const lookup:StampLookup=key=>new Promise((resolve,reject)=>{requireThat(joins.size<16,'OBSERVER_JOIN_PENDING_BOUND');const id=++stampId;const timer=setTimeout(()=>{joins.delete(id);reject(new Error('OBSERVER_JOIN_TIMEOUT'));},DELIVERY_JOIN_TIMEOUT_MS);joins.set(id,{resolve,timer});send({kind:'stamp',id,key});});
  async function stop(){if(stopped)return;stopped=true;clearInterval(heartbeat);for(const entry of joins.values()){clearTimeout(entry.timer);entry.resolve(undefined);}joins.clear();await client?.disconnect();if(process.connected)process.disconnect();}
  const heartbeat=setInterval(()=>{if(!client||stopped)return;try{send({kind:'summary',state:client.state()});}catch(error){try{send({kind:'failure',code:safeFailure(error)});}finally{void stop();}}},1000);
  process.on('disconnect',()=>void stop());
  process.on('message',(raw:unknown)=>{
    void (async()=>{
      assertObserverMessageSize(raw);const message=raw as ParentMessage;
      if(message.kind==='stamp-result'){const join=joins.get(message.id);if(join){joins.delete(message.id);clearTimeout(join.timer);join.resolve(message.stamp);}return;}
      requireThat(!rpcActive,'OBSERVER_CONCURRENT_RPC');rpcActive=true;
      try{
        if(message.kind==='init'){requireThat(!client,'OBSERVER_ALREADY_INITIALIZED');requireThat(message.configuration.mode==='process','OBSERVER_MODE_MISMATCH');client=new SocketObserver(message.session,message.configuration,lookup);send({kind:'result',id:message.id,state:client.state()});return;}
        requireThat(message.kind==='rpc'&&client,'OBSERVER_NOT_INITIALIZED');const value=await client.operation(message.operation);send({kind:'result',id:message.id,value,state:client.state()});if(message.operation.kind==='shutdown')await stop();
      }finally{rpcActive=false;}
    })().catch(error=>{try{send({kind:'failure',code:safeFailure(error)});}catch{}void stop();});
  });
}
