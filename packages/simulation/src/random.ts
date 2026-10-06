import { createHmac } from 'node:crypto';

/** Serializable map PRNG. Raw PRNG state is never exposed as an entity reference. */
export class SeededRandom {
  state: number;
  private nonce = 0;
  private readonly key: string;
  constructor(seed: string | number) {
    this.key=String(seed);
    let value=2166136261;
    for(const char of this.key)value=Math.imul(value^char.charCodeAt(0),16777619)>>>0;
    this.state=value||1;
  }
  next():number{let v=this.state;v^=v<<13;v^=v>>>17;v^=v<<5;this.state=v>>>0;return this.state/4294967296;}
  id():string{return `e_${createHmac('sha256',this.key).update(`entity:${++this.nonce}`).digest('hex').slice(0,32)}`;}
}
