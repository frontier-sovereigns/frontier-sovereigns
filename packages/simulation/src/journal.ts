import type { JournalBatch, JournalEvent } from './persistence-types.js';

/** Disk ownership lives outside the tick worker. Overflow is explicit, never silent. */
export class JournalBuffer {
  private events:{event:JournalEvent;bytes:number}[]=[];
  private bytes=0;
  private gapBeforeOrdinal:number|undefined;
  append(event:JournalEvent):void {
    const copy=structuredClone(event),bytes=Buffer.byteLength(JSON.stringify(copy));this.events.push({event:copy,bytes});this.bytes+=bytes;
    while(this.events.length>4096||this.bytes>16*1024*1024){const removed=this.events.shift()!;this.bytes-=removed.bytes;this.gapBeforeOrdinal=removed.event.ordinal+1;}
  }
  drain(throughOrdinal:number,limit=512):JournalBatch {
    if(!Number.isSafeInteger(limit)||limit<1||limit>4096)throw new Error('INVALID_JOURNAL_LIMIT');
    const entries=this.events.splice(0,limit);for(const entry of entries)this.bytes-=entry.bytes;
    const result:JournalBatch={events:entries.map(entry=>entry.event),throughOrdinal,...(this.gapBeforeOrdinal!==undefined?{gapBeforeOrdinal:this.gapBeforeOrdinal}:{})};this.gapBeforeOrdinal=undefined;return result;
  }
  peek():JournalEvent[]{return structuredClone(this.events.map(entry=>entry.event));}
}
