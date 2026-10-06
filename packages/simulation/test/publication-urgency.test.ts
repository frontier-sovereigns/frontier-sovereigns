import { describe, expect, it } from 'vitest';
import type { VisualAction } from '@frontier/shared';
import { PublicationUrgency } from '../src/publication-urgency.js';
import { ProjectionCredits } from '../src/recipient-projection.js';

const moving=():Record<string,VisualAction>=>({worker:{kind:'move',startedTick:1,facingMilliRad:0},enemy:{kind:'idle',startedTick:1}});
describe('recipient publication urgency',()=>{
  it('requires a first offer, coalesces unchanged actions/ordinary poses, and does not consume a pending removal',()=>{
    const gate=new PublicationUrgency(),actions=moving(),mask=Uint8Array.of(1,1,0);
    expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);gate.published('blue',actions,mask,'RUNNING',1);
    expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(false);actions.worker!.facingMilliRad=100;actions.worker!.startedTick=2;expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(false);
    delete actions.enemy;expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);
    gate.published('blue',actions,mask,'RUNNING',1);expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(false);
  });
  it('latches observed visibility loss until an actual offer, even if visibility returns while encoding has no credit',()=>{
    const gate=new PublicationUrgency(),actions=moving(),original=Uint8Array.of(1,1,0);gate.published('blue',actions,original,'RUNNING',1,true);
    expect(gate.pending('blue',actions,Uint8Array.of(1,0,0),'RUNNING',1,true)).toBe(true);expect(gate.pending('blue',actions,original,'RUNNING',1,true)).toBe(true);
    gate.published('blue',actions,original,'RUNNING',1,true);expect(gate.pending('blue',actions,original,'RUNNING',1,true)).toBe(false);
    expect(gate.pending('blue',actions,Uint8Array.of(1,1,1),'RUNNING',1,true)).toBe(false);
  });
  it('detects generic same-array/same-action mutations without aliasing published data',()=>{
    const gate=new PublicationUrgency(),actions=moving(),mask=Uint8Array.of(1,1);gate.published('blue',actions,mask,'RUNNING',1);mask[1]=0;expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);
    gate.published('blue',actions,mask,'RUNNING',1);actions.worker!.kind='gather_food';expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);
  });
  it('skips mask element reads only with an explicitly certified unchanged identity',()=>{
    let reads=0;const source=Uint8Array.of(1,1,0),mask=new Proxy(source,{get(target,key){if(typeof key==='string'&&/^\d+$/.test(key))reads++;const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}),gate=new PublicationUrgency(),actions=moving();
    gate.published('blue',actions,mask,'RUNNING',1,true);reads=0;expect(gate.pending('blue',actions,mask,'RUNNING',1,true)).toBe(false);expect(reads).toBe(0);
    expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(false);expect(reads).toBeGreaterThan(0);
    source[0]=0;expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);
  });
  it.each(['new','repeat','transition'] as const)('publishes %s observed attacks without using hidden-world events',kind=>{
    const gate=new PublicationUrgency(),mask=Uint8Array.of(1),blue=moving(),red=moving();if(kind==='repeat')blue.enemy={kind:'attack',startedTick:1,durationTicks:4};gate.published('blue',blue,mask,'RUNNING',1);gate.published('red',red,mask,'RUNNING',1);
    const id=kind==='new'?'newly_visible_enemy':'enemy';blue[id]={kind:'attack',startedTick:8,durationTicks:4,facingMilliRad:100};expect(gate.pending('blue',blue,mask,'RUNNING',1)).toBe(true);expect(gate.pending('red',red,mask,'RUNNING',1)).toBe(false);
  });
  it('keeps new noncombat actors on ordinary cadence and isolates recipients and resets',()=>{
    const gate=new PublicationUrgency(),mask=Uint8Array.of(1),actions=moving();gate.published('blue',actions,mask,'RUNNING',1);gate.published('red',actions,mask,'RUNNING',1);actions.recruit={kind:'idle',startedTick:5};expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(false);
    gate.reset('blue');expect(gate.pending('blue',actions,mask,'RUNNING',1)).toBe(true);expect(gate.pending('red',actions,mask,'RUNNING',1)).toBe(false);gate.reset();expect(gate.pending('red',actions,mask,'RUNNING',1)).toBe(true);
  });
  it.each(['PAUSED','FINISHED'] as const)('publishes %s and epoch transitions immediately',status=>{
    const gate=new PublicationUrgency(),mask=Uint8Array.of(1),actions=moving();gate.published('blue',actions,mask,'RUNNING',1);expect(gate.pending('blue',actions,mask,status,1)).toBe(true);gate.published('blue',actions,mask,status,1);expect(gate.pending('blue',actions,mask,status,1)).toBe(false);expect(gate.pending('blue',actions,mask,status,2)).toBe(true);
  });
});

describe('bounded urgent recipient credits',()=>{
  it('promotes an unsent urgent recipient without exceeding four byte leases',()=>{
    const credits=new ProjectionCredits();credits.subscribe(['a','b','c','d','e','f']);credits.prioritize(['f']);
    expect(credits.eligible()).toEqual(['f','a','b','c']);expect(credits.eligible()).toEqual(['f','a','b','c']);
    for(const id of credits.eligible())credits.reserve(id,1);
    expect(credits.eligible()).toEqual([]);expect(credits.inventory()).toMatchObject({active:4,pending:2,reservedBytes:128*1024*1024});
    expect(()=>credits.reserve('e',1)).toThrow('PROJECTION_CREDIT_REQUIRED');
    credits.acknowledge('a',credits.generation,1);expect(credits.eligible()).toEqual(['d']);
  });
  it('retains urgency behind an in-flight transfer without replacing its revision',()=>{
    const credits=new ProjectionCredits();credits.subscribe(['a','b','c','d','e','f']);for(const id of credits.eligible())credits.reserve(id,1);
    credits.request(['a','b','c','d','e','f']);credits.prioritize(['a','f']);expect(credits.eligible()).toEqual([]);
    credits.acknowledge('b',credits.generation,1);expect(credits.eligible()).toEqual(['f']);credits.reserve('f',1);
    expect(()=>credits.reserve('a',2)).toThrow('PROJECTION_CREDIT_REQUIRED');credits.acknowledge('a',credits.generation,1);
    expect(credits.eligible()).toEqual(['a']);credits.reserve('a',2);expect(credits.inventory().active).toBe(4);
    expect(()=>credits.acknowledge('a',credits.generation,1)).toThrow('STALE_PROJECTION_CREDIT');
  });
  it('serves the oldest ordinary recipient after four urgent selections during a continuous storm',()=>{
    const credits=new ProjectionCredits(),ids=['ordinary','u1','u2','u3','u4','u5'];credits.subscribe(ids);credits.prioritize(ids.slice(1));
    const served:string[]=[],revisions=new Map<string,number>();
    for(let turn=0;turn<20;turn++){
      const id=credits.eligible()[0]!,revision=(revisions.get(id)??0)+1;revisions.set(id,revision);served.push(id);credits.reserve(id,revision);
      credits.acknowledge(id,credits.generation,revision);credits.request([id]);if(id!=='ordinary')credits.prioritize([id]);
    }
    expect(served.slice(0,5)).toEqual(['u1','u2','u3','u4','ordinary']);
    expect(served.filter(id=>id==='ordinary')).toHaveLength(4);expect(new Set(served)).toEqual(new Set(ids));
  });
  it('retains old-generation byte ownership through reset and ignores unknown or already served priority requests',()=>{
    const credits=new ProjectionCredits();credits.subscribe(['a','b','c','d']);const oldGeneration=credits.generation;
    for(const id of credits.eligible())credits.reserve(id,1);credits.reset();credits.subscribe(['a','b','c','d','e','f']);credits.prioritize(['f','unknown']);
    expect(credits.eligible()).toEqual([]);expect(credits.inventory()).toMatchObject({active:4,retired:4,pending:6});
    credits.acknowledge('a',oldGeneration,1);expect(credits.eligible()).toEqual(['f']);credits.reserve('f',1);credits.prioritize(['f']);
    credits.acknowledge('f',credits.generation,1);expect(credits.eligible()).toEqual(['a']);expect(credits.inventory().pending).toBe(5);
    expect(credits.acknowledge('a',oldGeneration,1)).toBe(false);
  });
});
