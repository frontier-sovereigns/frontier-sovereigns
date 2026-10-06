import { describe, expect, it } from 'vitest';
import { balance, validateEndpointDiagnosticsResponse, type CommittedUnitActionKind, type SimulationActivityWindow } from '@frontier/shared';
import { ActivityDiagnostics } from './activity-diagnostics.js';

const ticks=60*balance.rules.simulationHz;
const bank=()=>({food:0,wood:0,gold:0,stone:0});
function fixture(){
  const state={matchId:'activity-test',matchEpoch:1,tick:0,factions:[{id:'blue'},{id:'red'}],economies:{blue:{collected:bank()},red:{collected:bank()}},entities:{
    worker:{id:'worker',kind:'unit',ownerId:'blue',hp:25},casualty:{id:'casualty',kind:'unit',ownerId:'blue',hp:25},idle:{id:'idle',kind:'unit',ownerId:'red',hp:25},house:{id:'house',kind:'building',ownerId:'blue',hp:600},
  } as Record<string,{id:string;kind:string;ownerId:string;hp:number}>};
  const collector=new ActivityDiagnostics();collector.synchronize(state);return {state,collector};
}
function packet(activityWindow?:SimulationActivityWindow):unknown {
  const metrics={p50:0,p95:0,max:0};return {endpoint:{configured:false,mode:'unprobed',status:'NOT_CONFIGURED'},scheduler:{active:0,pending:0,concurrency:5,circuit:'closed',retryAfterMs:0,consecutiveFailures:0,completed:0,failed:0,latencyMs:metrics,queueDelayMs:metrics,promptTokens:null,completionTokens:null,prefillMs:null,generationMs:null,commanders:[]},simulation:{tick:1200,tickMs:metrics,debtMs:0,overrunWarning:false,...(activityWindow?{activityWindow}:{})},process:{rssMiB:120}};
}

describe('bounded committed-action diagnostics',()=>{
  it('preserves complete minute coverage for 300ms frames and counts actual slice activity rather than six copies of a pose',()=>{
    const {state,collector}=fixture();
    for(let fromTick=0;fromTick<ticks;fromTick+=6){
      collector.synchronize(state);state.tick=fromTick+6;
      const actions=fromTick<600?[{id:'worker',playerId:'blue',kind:'move' as const,ticks:2},{id:'worker',playerId:'blue',kind:'gather_wood' as const,ticks:1}]:[];
      if(fromTick===0)actions.push({id:'casualty',playerId:'blue',kind:'move',ticks:1});
      if(fromTick===594){delete state.entities.casualty;state.economies.blue.collected.wood=7000;}
      const frame={fromTick,toTick:state.tick,actions};collector.observeFrame(state,frame);collector.observeFrame(state,frame);
      if(state.tick<ticks)expect(collector.snapshot(state)).toBeUndefined();
    }
    const snapshot=collector.snapshot(state)!;
    expect(snapshot).toMatchObject({fromTick:0,toTick:ticks,actionTicks:{move:201,gather_wood:100},factions:[{uniqueActiveUnits:2,activeSurvivingUnits:1,survivingUnits:1,depositedMilli:{wood:7000}},{uniqueActiveUnits:0,survivingUnits:1}]});
    expect(validateEndpointDiagnosticsResponse(packet(snapshot))).toBe(true);
  });
  it('rejects skipped coarse frames and unearned action counts instead of filling the missing time',()=>{
    const {state,collector}=fixture();state.tick=6;collector.observeFrame(state,{fromTick:0,toTick:6,actions:[{id:'worker',playerId:'blue',kind:'move',ticks:7}]});
    expect(collector.snapshot(state)).toBeUndefined();
    state.tick=18;collector.observeFrame(state,{fromTick:12,toTick:18,actions:[{id:'worker',playerId:'blue',kind:'move',ticks:6}]});
    for(let fromTick=18;fromTick<18+ticks;fromTick+=6){state.tick=fromTick+6;collector.observeFrame(state,{fromTick,toTick:state.tick,actions:[]});}
    expect(collector.snapshot(state)).toMatchObject({fromTick:18,toTick:18+ticks,actionTicks:{}});
  });
  it('counts actual action ticks across a complete minute, distinguishes casualties and idle survivors, and credits only deposits',()=>{
    const {state,collector}=fixture();
    for(let tick=1;tick<=ticks;tick++){
      collector.synchronize(state);state.tick=tick;
      const actions:{id:string;playerId:string;kind:CommittedUnitActionKind}[]=tick<=400?[{id:'worker',playerId:'blue',kind:'move'}]:tick<=800?[{id:'worker',playerId:'blue',kind:'gather_wood'}]:[];
      if(tick===1)actions.push({id:'casualty',playerId:'blue',kind:'move'});
      if(tick===800){delete state.entities.casualty;state.economies.blue.collected.wood+=15000;}
      collector.observe(state,actions);collector.observe(state,actions);
      if(tick<ticks)expect(collector.snapshot(state)).toBeUndefined();
    }
    const result=collector.snapshot(state)!;
    expect(result).toEqual({matchId:'activity-test',matchEpoch:1,fromTick:0,toTick:ticks,actionTicks:{move:401,gather_wood:400},factions:[
      {playerId:'blue',uniqueActiveUnits:2,activeSurvivingUnits:1,survivingUnits:1,actionTicks:{move:401,gather_wood:400},depositedMilli:{...bank(),wood:15000}},
      {playerId:'red',uniqueActiveUnits:0,activeSurvivingUnits:0,survivingUnits:1,actionTicks:{},depositedMilli:bank()},
    ]});
    // Multiple host polls neither consume nor extend the record, and cannot mutate it.
    result.factions[0]!.depositedMilli.wood=999;result.actionTicks.move=0;
    expect(collector.snapshot(state)!.factions[0]!.depositedMilli.wood).toBe(15000);expect(collector.snapshot(state)!.actionTicks.move).toBe(401);
    for(let tick=ticks+1;tick<=2*ticks;tick++){state.tick=tick;collector.observe(state,[]);}
    expect(collector.snapshot(state)).toMatchObject({fromTick:ticks,toTick:2*ticks,actionTicks:{},factions:[{uniqueActiveUnits:0,depositedMilli:bank()},{uniqueActiveUnits:0,depositedMilli:bank()}]});
  });
  it('resets partial and completed records on an epoch change, rollback, or another match',()=>{
    const {state,collector}=fixture();
    for(let tick=1;tick<=ticks;tick++){state.tick=tick;collector.observe(state,[{id:'worker',playerId:'blue',kind:'build'}]);}
    expect(collector.snapshot(state)).toBeDefined();state.matchEpoch++;expect(collector.snapshot(state)).toBeUndefined();
    for(let i=0;i<500;i++){state.tick++;collector.observe(state,[{id:'worker',playerId:'blue',kind:'repair'}]);}
    state.tick=20;collector.synchronize(state);expect(collector.snapshot(state)).toBeUndefined();
    for(let i=0;i<ticks;i++){state.tick++;collector.observe(state,[]);}
    expect(collector.snapshot(state)).toMatchObject({matchEpoch:2,fromTick:20,toTick:20+ticks,actionTicks:{}});
    state.matchId='other-match';expect(collector.snapshot(state)).toBeUndefined();
  });
  it('never fills an unobserved tick gap or a paused tick with invented action time',()=>{
    const {state,collector}=fixture();
    for(let i=0;i<ticks;i++)collector.observe(state,[{id:'worker',playerId:'blue',kind:'attack'}]);
    expect(collector.snapshot(state)).toBeUndefined();state.tick=10000;collector.observe(state,[{id:'worker',playerId:'blue',kind:'attack'}]);
    for(let i=0;i<ticks-1;i++){state.tick++;collector.observe(state,[]);}
    expect(collector.snapshot(state)).toBeUndefined();state.tick++;collector.observe(state,[]);
    expect(collector.snapshot(state)).toMatchObject({fromTick:10000,toTick:10000+ticks,actionTicks:{}});
  });
  it('strictly decodes the optional host-only window and rejects private unit identifiers or idle action counts',()=>{
    const {state,collector}=fixture();for(let tick=1;tick<=ticks;tick++){state.tick=tick;collector.observe(state,[]);}const result=collector.snapshot(state)!;
    expect(validateEndpointDiagnosticsResponse(packet())).toBe(true);expect(validateEndpointDiagnosticsResponse(packet(result))).toBe(true);
    for(const bad of [{...result,unitIds:['worker']},{...result,actionTicks:{idle:1200}},{...result,factions:[{...result.factions[0],depositedMilli:{...bank(),wood:-1}}]}])expect(validateEndpointDiagnosticsResponse(packet(bad as SimulationActivityWindow))).toBe(false);
  });
});
