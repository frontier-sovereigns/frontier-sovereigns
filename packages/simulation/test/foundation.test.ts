import { describe, expect, it } from 'vitest';
import { createSimulation, SeededRandom, simulationHz } from '../src/index.js';

const options = { seed: 'foundation-59', matchId: 'test', factions: [
  {id:'p1',name:'A',teamId:'one',color:'#3388ff',kind:'human' as const},
  {id:'p2',name:'B',teamId:'two',color:'#ee7744',kind:'human' as const},
] };
describe('M0 deterministic headless foundation', () => {
  it('uses identical serialized state after identical ticks and seeds', () => {
    const a = createSimulation(options), b = createSimulation(options);
    a.step(200); for (let i = 0; i < 200; i++) b.step();
    expect(a.state).toEqual(b.state); expect(simulationHz).toBe(20);
    expect(JSON.parse(JSON.stringify(a.state))).toEqual(a.state);
  });
  it('uses reproducible opaque IDs without a global counter', () => {
    const a = new SeededRandom('a'), b = new SeededRandom('a'), c = new SeededRandom('b');
    expect(a.id()).toEqual(b.id()); expect(a.id()).not.toEqual(c.id());
  });
  it('rejects malformed and stale commands before gameplay mutation and records both replay attempts', () => {
    const sim = createSimulation(options);
    const before = structuredClone(sim.state);
    expect(sim.command('p1', {}).code).toBe('INVALID_COMMAND');
    expect(sim.command('p1', {protocolVersion:2,matchId:'test',matchEpoch:2,clientCommandId:'a',clientSequence:1,command:{kind:'surrender'}}).code).toBe('STALE_MATCH');
    expect(sim.state).toEqual({...before,eventOrdinal:before.eventOrdinal+2});
    expect(sim.journalEvents().map(event=>event.kind)).toEqual(['invalid_command','command']);
  });
  it('freezes ticks while paused and omits host-only data from a viewpoint', () => {
    const sim = createSimulation(options);
    sim.setStatus('PAUSED'); sim.step(100);
    expect(sim.state.tick).toBe(0);
    const view = sim.view('p1');
    expect(view).not.toHaveProperty('randomState');
    expect(view).not.toHaveProperty('receipts');
    expect(view).not.toHaveProperty('seed');
    expect(view.playerId).toBe('p1');
    expect(() => sim.view('missing')).toThrow('NOT_AUTHORIZED');
  });
  it('accepts the new epoch sequence after pausing and invalidating the old epoch',()=>{
    const sim=createSimulation(options),unit=sim.view('p1').entities.find(e=>e.kind==='unit'&&e.ownerId==='p1')!;
    const input={protocolVersion:2,matchId:'test',matchEpoch:1,clientCommandId:'before',clientSequence:100,command:{kind:'stop',unitIds:[unit.id]}};
    expect(sim.command('p1',input).status).toBe('accepted');sim.setStatus('PAUSED');sim.invalidateEpoch();sim.setStatus('RUNNING');
    expect(sim.command('p1',input).code).toBe('STALE_MATCH');
    expect(sim.command('p1',{...input,matchEpoch:2,clientCommandId:'after',clientSequence:1}).status).toBe('accepted');
  });
});
