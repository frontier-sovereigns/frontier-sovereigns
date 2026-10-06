import { expect, it } from 'vitest';
import { MotionTrack, PresentationClock, ProgressTrack, GateTrack } from './MotionTrack';

it('interpolates only committed progress endpoints and resets on blocked, replacement and reversed progress',()=>{
  const track=new ProgressTrack();track.push(.2,0);track.push(.5,300);expect(track.sampleAt(150)).toBeCloseTo(.35);expect(track.sampleAt(100000)).toBe(.5);
  track.push(.5,600,true);expect(track.sampleAt(450)).toBe(.5);track.push(.1,900);expect(track.sampleAt(800)).toBe(.1);
  track.push(1,1200);expect(track.sampleAt(100000)).toBe(1);for(let frame=0;frame<30;frame++)track.push(1,1500+frame*300);
  expect((track as unknown as {samples:unknown[]}).samples).toHaveLength(8);
});
it('plays exact gate transition times and preserves an unfinished opening across frame baselines',()=>{
  const track=new GateTrack(8);track.push(false,0,undefined,true);
  track.push(true,6,{complete:true,fromTick:0,points:[{tick:0,gateOpen:false},{tick:2,gateOpen:true},{tick:6,gateOpen:true}]});
  expect(track.sampleAt(1)).toEqual({open:false,pose:0});expect(track.sampleAt(6)).toEqual({open:true,pose:.5});
  track.push(false,12,{complete:true,fromTick:6,points:[{tick:6,gateOpen:true},{tick:11,gateOpen:false},{tick:12,gateOpen:false}]});
  expect(track.sampleAt(8).pose).toBe(.75);expect(track.sampleAt(10).pose).toBe(1);expect(track.sampleAt(12).pose).toBe(.875);
  track.push(true,18,{complete:false,fromTick:12,points:[{tick:16,gateOpen:true},{tick:18,gateOpen:true}]});
  expect(track.sampleAt(16).open).toBe(false);expect(track.sampleAt(18).open).toBe(true);
  track.push(false,0,undefined,true);expect(track.sampleAt(100)).toEqual({open:false,pose:0});
});

it('renders 125ms behind authoritative samples and interpolates all three position axes', () => {
  const track = new MotionTrack();
  track.push({ x: 0, y: 0, z: 0 }, 0, 1000);
  track.push({ x: 1, y: 2, z: 3 }, 100, 1100);
  track.push({ x: 2, y: 4, z: 6 }, 200, 1200);
  expect(track.sample(1200)).toEqual({ x: 0.75, y: 1.5, z: 2.25 });
  expect(track.sample(1250)).toEqual({ x: 1.25, y: 2.5, z: 3.75 });
});
it('extrapolates position for at most100ms and then stays frozen through a network stall', () => {
  const track = new MotionTrack(); track.push({ x: 0, y: 0, z: 0 }, 0, 1000); track.push({ x: 1, y: 0, z: 0 }, 100, 1100);
  expect(track.sample(1275).x).toBe(1.5);
  expect(track.sample(1325).x).toBe(2);
  expect(track.sample(9000).x).toBe(2);
  expect(track.sample(9000, false).x).toBe(1);
});
it('freezes immediately on disconnect and discards stale velocity on full resync or a new epoch', () => {
  const track = new MotionTrack(); track.push({ x: 0, y: 0, z: 0 }, 100, 1000); track.push({ x: 1, y: 0, z: 0 }, 200, 1100);
  track.freeze({ x: 0.6, y: 0, z: 0 }); expect(track.sample(9000).x).toBe(0.6);
  track.push({ x: 30, y: 2, z: 10 }, 100, 10000, true);
  expect(track.sample(20000)).toMatchObject({ x: 30, y: 2, z: 10 });
});
it.each([.9,.1])('keeps 125ms buffering and 100ms extrapolation wall-clock bounds at speed %s',speed=>{
  const track=new MotionTrack(),received=3000;
  track.push({x:0,y:0,z:0},0,received-200/speed);
  track.push({x:1,y:2,z:3},100,received-100/speed);
  track.push({x:2,y:4,z:6},200,received);
  expect(track.sample(received,true,speed).x).toBeCloseTo(2-1.25*speed);
  expect(track.sample(received+125,true,speed)).toMatchObject({x:2,y:4,z:6});
  expect(track.sample(received+175,true,speed).x).toBeCloseTo(2+.5*speed);
  const capped=track.sample(received+225,true,speed);
  expect(capped.x).toBeCloseTo(2+speed);expect(capped.y).toBeCloseTo(4+2*speed);expect(capped.z).toBeCloseTo(6+3*speed);
  expect(track.sample(received+60000,true,speed)).toEqual(capped);
  expect(track.sample(received+60000,false,speed)).toMatchObject({x:2,y:4,z:6});
  track.freeze({x:1,y:2,z:3});expect(track.sample(10000,true,speed)).toEqual({x:1,y:2,z:3});
  track.push({x:10,y:0,z:0},300,10000,true);expect(track.sample(10500,true,speed)).toMatchObject({x:10,y:0,z:0});
});
it.each([100,150,200,300,450,600] as const)('uses the advertised %sms publication interval with a bounded wall-time buffer',interval=>{
  for(const speed of [1,.1]){
    const track=new MotionTrack(),received=3000,buffer=interval===100?125:interval>=300?interval+50:interval;
    track.setPublicationInterval(interval);expect(track.delayMs).toBe(buffer);
    for(let index=0;index<=4;index++)track.push({x:index,y:index*2,z:index*3},index*interval,received-(4-index)*interval/speed);
    expect(track.sample(received,true,speed).x).toBeCloseTo(4-buffer*speed/interval);
    expect(track.sample(received+buffer,true,speed)).toEqual({x:4,y:8,z:12});
    const capped=track.sample(received+buffer+100,true,speed);
    expect(capped.x).toBeCloseTo(4+100*speed/interval);expect(track.sample(received+60000,true,speed)).toEqual(capped);
  }
});

it('follows certified turns and stops instead of a chord through the intervening obstacle',()=>{
  const track=new MotionTrack();track.setPublicationInterval(300);
  const points=[{time:0,x:0,y:0,z:0},{time:100,x:1,y:0,z:0},{time:200,x:1,y:0,z:1},{time:300,x:1,y:0,z:1}];
  track.pushTrace(points.at(-1)!,300,1300,{complete:true,points});
  expect(track.sampleAt(50)).toEqual({x:.5,y:0,z:0});expect(track.sampleAt(150)).toEqual({x:1,y:0,z:.5});
  expect(track.sampleAt(250)).toEqual({x:1,y:0,z:1});expect(track.sample(60000,true)).toEqual({x:1,y:0,z:1});
});
it('holds across coalesced trace gaps and resumes only at certified coverage',()=>{
  const track=new MotionTrack(),point=(time:number,x:number,z=0)=>({time,x,y:0,z});
  track.pushTrace(point(300,3),300,1300,{complete:true,points:[point(0,0),point(300,3)]});
  track.pushTrace(point(900,9,3),900,1900,{complete:true,points:[point(600,9),point(900,9,3)]});
  expect(track.sampleAt(450)).toEqual({x:3,y:0,z:0});expect(track.sampleAt(599)).toEqual({x:3,y:0,z:0});
  expect(track.sampleAt(600)).toEqual({x:9,y:0,z:0});expect(track.sampleAt(750)).toEqual({x:9,y:0,z:1.5});
});
it.each(['overflow','missing','invalid-endpoint','backwards','over-capacity'] as const)('never guesses a route for %s trace coverage',failure=>{
  const track=new MotionTrack(),point=(time:number,x:number)=>({time,x,y:0,z:0});
  track.pushTrace(point(300,3),300,1300,{complete:true,points:[point(0,0),point(300,3)]});
  const trace=failure==='missing'?undefined:{complete:failure!=='overflow',points:failure==='invalid-endpoint'?[point(300,3),point(600,9)]:failure==='backwards'?[point(500,5),point(300,3),point(600,6)]:failure==='over-capacity'?Array.from({length:17},(_,i)=>point(300+i*18.75,3+i*3/16)):[point(300,3),point(600,6)]};
  track.pushTrace(point(600,6),600,1600,trace);
  expect(track.sampleAt(450)).toEqual({x:3,y:0,z:0});expect(track.sampleAt(600)).toEqual({x:6,y:0,z:0});
});
it('replaces certified history on resync and never retains a hidden route across a new epoch',()=>{
  const track=new MotionTrack();track.pushTrace({x:3,y:0,z:0},300,1300,{complete:true,points:[{time:0,x:0,y:0,z:0},{time:300,x:3,y:0,z:0}]});
  track.freeze({x:2,y:0,z:0});expect(track.sampleAt(300)).toEqual({x:2,y:0,z:0});
  track.pushTrace({x:10,y:0,z:10},0,2000,undefined,true);expect(track.sampleAt(150)).toEqual({x:10,y:0,z:10});
});
it.each([300,450,600] as const)('keeps a %sms stream moving and animating continuously on the same delayed clock',interval=>{
  const clock=new PresentationClock(),track=new MotionTrack();track.setPublicationInterval(interval);
  clock.push(0,1000,interval,true);track.pushTrace({x:0,y:0,z:0},0,1000,undefined,true);
  const samples:number[]=[];
  for(let time=0;time<=1800;time+=25){
    if(time&&time%interval===0){clock.push(time,1000+time,interval);track.pushTrace({x:time/1000,y:0,z:0},time,1000+time,{complete:true,points:[{time:time-interval,x:(time-interval)/1000,y:0,z:0},{time,x:time/1000,y:0,z:0}]});}
    const shown=clock.sample(1000+time);if(time>=interval*2)samples.push(shown);expect(track.sampleAt(shown).x).toBeCloseTo(shown/1000);
  }
  for(let i=1;i<samples.length;i++)expect(samples[i]!-samples[i-1]!).toBe(25);
  expect(clock.sample(10000)).toBe(1800);expect(track.sampleAt(clock.sample(20000)).x).toBe(1.8);
});
it('keeps certified presentation monotonic through 300/450/600ms degradation and recovery',()=>{
  const clock=new PresentationClock(),track=new MotionTrack();let committed=0,wall=1000,lastShown=0;
  clock.push(0,wall,300,true);track.pushTrace({x:0,y:0,z:0},0,wall,undefined,true);
  for(const interval of [300,450,600,450,300] as const){
    for(let frame=0;frame<3;frame++){
      const from=committed;committed+=interval;wall+=interval;track.setPublicationInterval(interval);clock.push(committed,wall,interval);
      track.pushTrace({x:committed/1000,y:0,z:0},committed,wall,{complete:true,points:[{time:from,x:from/1000,y:0,z:0},{time:committed,x:committed/1000,y:0,z:0}]});
      for(let elapsed=0;elapsed<interval;elapsed+=25){const shown=clock.sample(wall+elapsed);expect(shown).toBeGreaterThanOrEqual(lastShown);expect(shown).toBeLessThanOrEqual(committed);expect(track.sampleAt(shown).x).toBeCloseTo(shown/1000);lastShown=shown;}
    }
  }
  expect(clock.sample(wall+10000)).toBe(committed);expect(track.sampleAt(committed+10000,true).x).toBe(committed/1000);
});
it('keeps coarse presentation monotonic across cadence changes and freezes on pause',()=>{
  const clock=new PresentationClock();clock.push(0,1000,100,true);clock.push(600,1600,100);expect(clock.sample(1700)).toBe(575);
  clock.push(900,1900,300);expect(clock.sample(1900)).toBe(575);expect(clock.sample(1950)).toBe(600);
  expect(clock.sample(2100,1,false)).toBe(600);expect(clock.sample(2100,.1)).toBe(885);
  clock.push(0,10000,300,true);expect(clock.sample(11000)).toBe(0);
});
it('holds the rendered timeline on a larger buffer, then resumes without reverse motion or an unbounded freeze',()=>{
  const track=new MotionTrack();for(let index=0;index<5;index++)track.push({x:index,y:0,z:0},index*100,1000+index*100);
  const before=track.sample(1500);expect(before.x).toBe(3.75);
  track.setPublicationInterval(200);expect(track.sample(1500)).toEqual(before);expect(track.sample(1550)).toEqual(before);
  expect(track.sample(1600).x).toBe(4);expect(track.sample(1650).x).toBe(4.5);
  track.setPublicationInterval(100);expect(track.sample(1650).x).toBe(5);expect(track.sample(60000).x).toBe(5);
});
it.each(['resync','epoch','disconnect'] as const)('discards adaptive history at a %s boundary and returns to the default cadence',boundary=>{
  const track=new MotionTrack();track.setPublicationInterval(200);track.push({x:0,y:0,z:0},100,1000);track.push({x:1,y:0,z:0},200,1100);track.sample(1400);
  if(boundary==='disconnect'){track.freeze({x:.5,y:0,z:0});expect(track.sample(9000)).toEqual({x:.5,y:0,z:0});}
  track.setPublicationInterval();track.push({x:20,y:4,z:6},boundary==='epoch'?0:500,10000,boundary!=='epoch');expect(track.delayMs).toBe(125);expect(track.sample(60000)).toMatchObject({x:20,y:4,z:6});
});
