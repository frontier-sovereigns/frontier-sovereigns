import {describe,expect,it} from 'vitest';
import {PlanningStallMonitor} from './planning-stall-monitor.js';
const candidate=(index=0,playerId='a')=>({unitId:`unit_${playerId}_${index}`,requestId:`path_${index}`,orderRevision:1,progressTick:20,playerId});
describe('bounded wall-time planning recovery proposals',()=>{
  it('gates recovery on wall-time lack of progress instead of request age or retry attempts',()=>{
    const monitor=new PlanningStallMonitor(),entry=candidate();expect(monitor.recoveryBlocked).toBe(true);
    monitor.observe([entry],0,1);expect(monitor.recoveryBlocked).toBe(false);
    monitor.observe([entry],29999,1);expect(monitor.recoveryBlocked).toBe(false);
    expect(monitor.observe([entry],30000,1)).toEqual([entry]);expect(monitor.recoveryBlocked).toBe(true);
    expect(monitor.observe([entry],30001,1)).toEqual([]);expect(monitor.recoveryBlocked).toBe(true);
    const progressed={...entry,progressTick:21};monitor.observe([progressed],59000,1);expect(monitor.recoveryBlocked).toBe(false);
    monitor.observe([progressed],89000,1);expect(monitor.recoveryBlocked).toBe(true);
    // A newly admitted ready route no longer appears among stalled pending
    // candidates; spending planner credits without a result cannot fake this.
    monitor.observe([],89001,1);expect(monitor.recoveryBlocked).toBe(false);
    monitor.reset();expect(monitor.recoveryBlocked).toBe(true);
  });
  it('does not claim recovery with truncated candidates and clears stale pressure on epoch changes',()=>{
    const monitor=new PlanningStallMonitor(),entries=Array.from({length:2201},(_,index)=>candidate(index));
    monitor.observe(entries,0,1);expect(monitor.recoveryBlocked).toBe(true);
    monitor.observe([entries[0]!],1,1);expect(monitor.recoveryBlocked).toBe(false);
    monitor.observe([entries[0]!],30001,1);expect(monitor.recoveryBlocked).toBe(true);
    monitor.observe([entries[0]!],30002,2);expect(monitor.recoveryBlocked).toBe(false);
    monitor.observe([entries[0]!],0,2);expect(monitor.recoveryBlocked).toBe(false);
  });
  it('waits thirty seconds without motion and resets on useful progress, replacement, epoch or pause',()=>{
    const monitor=new PlanningStallMonitor(),entry=candidate();
    expect(monitor.observe([entry],0,1)).toEqual([]);expect(monitor.observe([entry],29999,1)).toEqual([]);
    expect(monitor.observe([entry],30000,1)).toEqual([entry]);expect(monitor.observe([entry],30001,1)).toEqual([]);
    const progressed={...entry,progressTick:21};expect(monitor.observe([progressed],59000,1)).toEqual([]);expect(monitor.observe([progressed],60000,1)).toEqual([]);
    expect(monitor.observe([{...progressed,orderRevision:2}],89000,1)).toEqual([]);
    expect(monitor.observe([entry],119000,2)).toEqual([]);monitor.reset();expect(monitor.observe([entry],149000,2)).toEqual([]);
  });
  it('limits each boundary to sixteen and rotates fairly between players under a large backlog',()=>{
    const monitor=new PlanningStallMonitor(),entries=Array.from({length:22},(_,index)=>candidate(index,'a')).concat(Array.from({length:22},(_,index)=>candidate(index,'b')));
    monitor.observe(entries,0,'match:1');const first=monitor.observe(entries,30000,'match:1');expect(first).toHaveLength(16);expect(first.filter(entry=>entry.playerId==='a')).toHaveLength(8);expect(first.filter(entry=>entry.playerId==='b')).toHaveLength(8);
    const next=monitor.observe(entries,30001,'match:1');expect(next).toHaveLength(16);expect(next.some(entry=>first.some(prior=>prior.unitId===entry.unitId))).toBe(false);
  });
  it('bounds retention, forgets vanished requests and does not age across clock resets',()=>{
    const monitor=new PlanningStallMonitor(),entries=Array.from({length:2500},(_,index)=>candidate(index));monitor.observe(entries,50000,1);
    expect((monitor as unknown as {entries:Map<string,unknown>}).entries.size).toBe(2200);
    expect(monitor.observe([entries[0]!],0,1)).toEqual([]);expect(monitor.observe([],30000,1)).toEqual([]);expect(monitor.observe([entries[0]!],60000,1)).toEqual([]);
  });
});
