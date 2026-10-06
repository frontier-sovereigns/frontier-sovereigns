export interface MotionPoint { x: number; y: number; z: number }
import type { PublicationIntervalMs, VisualTrace } from '@frontier/shared';
export interface TimedMotionPoint extends MotionPoint { time: number }
interface Sample extends TimedMotionPoint { connected: boolean }
export interface MotionTrace { points: readonly TimedMotionPoint[]; complete: boolean }
type PublicationInterval = PublicationIntervalMs;
const bufferFor = (interval?: PublicationInterval): number => interval !== undefined && interval >= 300 ? interval + 50 : interval === 200 ? 200 : interval === 150 ? 150 : 125;

/** A shared presentation clock: animation and certified movement use the same
 * delayed game time. The delay is bounded in wall time, including slow games. */
export class PresentationClock {
  private committed = 0;
  private received = 0;
  private first = 0;
  private presented: number | undefined;
  private delay = 125;
  private started = false;
  push(committedMs: number, receivedMs: number, interval?: PublicationInterval, reset = false): void {
    if (reset || !this.started || committedMs < this.committed) {
      this.first = committedMs; this.presented = undefined; this.started = true;
    }
    this.committed = committedMs; this.received = receivedMs; this.delay = bufferFor(interval);
  }
  sample(nowMs: number, speed = 1, advancing = true): number {
    if (!this.started) return 0;
    if (!advancing) return this.presented ?? this.committed;
    const requested = this.committed + (Math.max(0, nowMs - this.received) - this.delay) * speed;
    // Never animate an uncommitted future interval. Coarse streams retain one
    // advertised frame plus 50 ms, so continuous rendering needs no speculation.
    this.presented = Math.min(this.committed, Math.max(this.first, this.presented ?? requested, requested));
    return this.presented;
  }
}

/** Display-only progress between received endpoints, never a predicted rate. */
export class ProgressTrack {
  private samples: {time:number;value:number}[] = [];
  push(value:number,time:number,reset=false):void {
    const last=this.samples.at(-1);
    if(reset||last&&(time<last.time||value<last.value))this.samples=[];
    if(this.samples.at(-1)?.time===time)this.samples.pop();
    this.samples.push({time,value});this.samples=this.samples.slice(-8);
  }
  sampleAt(time:number):number {
    const first=this.samples[0],last=this.samples.at(-1);if(!first||!last)return 0;
    if(time<=first.time)return first.value;
    for(let index=1;index<this.samples.length;index++){const a=this.samples[index-1]!,b=this.samples[index]!;if(time<=b.time)return a.value+(b.value-a.value)*(time-a.time)/(b.time-a.time);}
    return last.value;
  }
}

/** Exact observed gate transitions; interpolation changes the mesh pose only. */
export class GateTrack {
  private samples:{tick:number;open:boolean;from:number}[]=[];
  constructor(private readonly durationTicks:number){}
  push(open:boolean,tick:number,trace:VisualTrace|undefined,reset=false):void {
    if(reset||!this.samples.length){this.samples=[{tick,open,from:Number(open)}];return;}
    if(trace?.complete){
      const baseline=this.sampleAt(trace.fromTick).pose;
      this.samples=this.samples.filter(point=>point.tick<=trace.fromTick);
      for(const point of trace.points)if(point.gateOpen!==undefined)this.append(point.gateOpen,point.tick,baseline);
    }else this.append(open,tick);
    this.samples=this.samples.slice(-16);
  }
  private append(open:boolean,tick:number,baseline=Number(open)):void {
    const last=this.samples.at(-1);if(last?.open===open)return;
    const from=last?this.sampleAt(tick).pose:baseline;
    if(last?.tick===tick)this.samples.pop();
    this.samples.push({tick,open,from});
  }
  sampleAt(tick:number):{open:boolean;pose:number} {
    let point=this.samples[0];if(!point)return {open:false,pose:0};
    for(const next of this.samples){if(next.tick>tick)break;point=next;}
    const progress=Math.max(0,Math.min(1,(tick-point.tick)/this.durationTicks));
    return {open:point.open,pose:point.from+(Number(point.open)-point.from)*progress};
  }
}

/** Position-only rendering buffer. Gameplay values never enter this class. */
export class MotionTrack {
  private samples: Sample[] = [];
  private received = 0;
  private frozen: MotionPoint | null = null;
  private bufferMs = 125;
  private presentedTime: number | undefined;
  private certified = false;
  get delayMs(): number { return this.bufferMs; }
  readonly maximumExtrapolationMs = 100;

  setPublicationInterval(intervalMs?: PublicationInterval): void { this.bufferMs = bufferFor(intervalMs); }

  /** Legacy fine-cadence snapshots retain their bounded velocity interpolation. */
  push(point: MotionPoint, authoritativeMs: number, receivedMs: number, reset = false): void {
    this.prepare(authoritativeMs, receivedMs, reset); this.certified = false;
    if (this.samples.at(-1)?.time === authoritativeMs) this.samples.pop();
    this.samples.push({ x: point.x, y: point.y, z: point.z, time: authoritativeMs, connected: true });
    this.trim();
  }

  /** Only interpolate host-certified past segments. Missing/coalesced coverage
   * and overflow are a hold followed by reconciliation, never a guessed chord. */
  pushTrace(point: MotionPoint, authoritativeMs: number, receivedMs: number, trace: MotionTrace | undefined, reset = false): void {
    this.prepare(authoritativeMs, receivedMs, reset); this.certified = true;
    const points = trace?.points ?? [], endpoint = points.at(-1);
    const valid = trace?.complete && points.length >= 1 && points.length <= 16
      && endpoint?.time === authoritativeMs && this.samePoint(endpoint, point)
      && points.every((sample, index) => Number.isFinite(sample.time) && Number.isFinite(sample.x) && Number.isFinite(sample.y) && Number.isFinite(sample.z)
        && sample.time <= authoritativeMs && (index === 0 || sample.time > points[index - 1]!.time));
    if (!valid) {
      if (this.samples.at(-1)?.time === authoritativeMs) this.samples.pop();
      this.samples.push({ x: point.x, y: point.y, z: point.z, time: authoritativeMs, connected: false });
      this.trim(); return;
    }
    const start = points[0]!, existing = this.samples.find(sample => sample.time === start.time);
    const retained = this.samples.filter(sample => sample.time < start.time);
    // The first trace sample certifies a point, not the unreported interval
    // leading to it. Preserve a previous certified link only for the same point.
    this.samples = retained;
    for (let index = 0; index < points.length; index++) this.samples.push({ ...points[index]!, connected: index > 0 || !!existing && existing.connected && this.samePoint(existing, start) });
    this.trim();
  }
  private prepare(authoritativeMs: number, receivedMs: number, reset: boolean): void {
    if (reset || !this.samples.length || authoritativeMs < this.samples.at(-1)!.time) { this.samples = []; this.presentedTime = undefined; }
    this.received = receivedMs; this.frozen = null;
  }
  private trim(): void { this.samples = this.samples.slice(-64); }
  private samePoint(a: MotionPoint, b: MotionPoint): boolean { return a.x === b.x && a.y === b.y && a.z === b.z; }
  freeze(point: MotionPoint): void { this.frozen = { x: point.x, y: point.y, z: point.z }; }
  sample(nowMs: number, extrapolate = true, simulationSpeed = 1): MotionPoint {
    const first = this.samples[0], last = this.samples.at(-1);
    if (this.frozen) return this.frozen;
    if (!first || !last) return { x: 0, y: 0, z: 0 };
    const requested = last.time + (Math.max(0, nowMs - this.received) - this.delayMs) * simulationSpeed;
    const ceiling = last.time + (extrapolate && !this.certified ? this.maximumExtrapolationMs * simulationSpeed : 0);
    const time = Math.min(ceiling, Math.max(first.time, this.presentedTime ?? requested, requested));
    this.presentedTime = time;
    return this.sampleAt(time, extrapolate, simulationSpeed);
  }
  /** Sample the global presentation clock, retaining no entity-specific drift. */
  sampleAt(time: number, extrapolate = false, simulationSpeed = 1): MotionPoint {
    if (this.frozen) return this.frozen;
    const first = this.samples[0], last = this.samples.at(-1);
    if (!first || !last) return { x: 0, y: 0, z: 0 };
    if (time <= first.time) return { x: first.x, y: first.y, z: first.z };
    for (let index = 1; index < this.samples.length; index++) {
      const a = this.samples[index - 1]!, b = this.samples[index]!;
      if (time <= b.time) return b.connected || time === b.time ? this.interpolate(a, b, (time - a.time) / (b.time - a.time)) : { x: a.x, y: a.y, z: a.z };
    }
    if (this.certified || !extrapolate || this.samples.length === 1) return { x: last.x, y: last.y, z: last.z };
    const previous = this.samples.at(-2)!;
    return this.interpolate(previous, last, 1 + Math.min(this.maximumExtrapolationMs * simulationSpeed, time - last.time) / (last.time - previous.time));
  }
  private interpolate(a: MotionPoint, b: MotionPoint, fraction: number): MotionPoint { return { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction, z: a.z + (b.z - a.z) * fraction }; }
}
