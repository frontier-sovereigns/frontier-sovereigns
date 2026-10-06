import {describe,it,expect} from 'vitest';
import {controllerPulse,controllerMemoryPulse} from '../src/controller-schedule.js';
const players=Array.from({length:11},(_,index)=>({id:`p${index}`}));
describe('deterministic staggered controller decisions',()=>{
  it.each([5,10,20])('keeps every controller cadence and one memory refresh per second at period %i',period=>{
    const loads=Array.from({length:40},()=>0);
    for(const player of players){
      const pulses:number[]=[],refreshes:number[]=[];
      for(let tick=0;tick<40;tick++){
        const clock={tick,playerId:player.id,players,authoritativeIntervalMs:300};
        if(controllerPulse(clock,period)){pulses.push(tick);loads[tick]!++;}
        if(controllerMemoryPulse(clock,period,20))refreshes.push(tick);
      }
      expect(pulses).toHaveLength(40/period);
      expect(pulses.slice(1).map((tick,index)=>tick-pulses[index]!)).toEqual(Array(pulses.length-1).fill(period));
      expect(refreshes).toHaveLength(2);expect(refreshes[1]!-refreshes[0]!).toBe(20);
    }
    expect(Math.max(...loads)).toBe(Math.ceil(players.length/period));
  });
  it('retains legacy controller schedules for old saves',()=>{
    for(const authoritativeIntervalMs of [undefined,50])for(const player of players)for(let tick=0;tick<40;tick++){
      const clock={tick,playerId:player.id,players,authoritativeIntervalMs};
      expect(controllerPulse(clock,10)).toBe(tick%10===0);
      expect(controllerMemoryPulse(clock,10,20)).toBe(tick%20===0);
    }
  });
});
