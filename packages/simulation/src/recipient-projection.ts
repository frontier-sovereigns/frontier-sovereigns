import { MAX_WORLD_ENTITIES,type PlayerView,type ViewEntity } from '@frontier/shared';
import { sameJson } from '../../shared/src/view-stream-kernel.js';
import { createNativeProjectionScope, type NativeProjection } from './recipient-projection-native.js';

export type ProjectionFields = Omit<PlayerView, 'entities'>;
const ownedFogRetentionCounts={calls:0,reusedInputs:0};
export interface ProjectionFogDelta {visibleAdded:number[];visibleRemoved:number[];exploredAdded:number[]}
export interface ProjectionPatch {
  revision: number; baseRevision: number;
  header: Pick<PlayerView, 'protocolVersion' | 'contentHash' | 'matchId' | 'matchEpoch' | 'playerId' | 'tick' | 'sequence' | 'status'>;
  fields: Partial<ProjectionFields>; removedFields: (keyof ProjectionFields)[];
  entities: { upserts: ViewEntity[]; removed: string[]; order?: string[] };
  /** Private IPC only; bound to the same recipient/base revision as entity edits. */
  fogDelta?: ProjectionFogDelta;
}

const fogInteger=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
function fogCells(map:PlayerView['map']):number {
  const columns=map.widthMm/map.fogCellMm,rows=map.heightMm/map.fogCellMm;
  return Number.isSafeInteger(columns)&&Number.isSafeInteger(rows)&&columns>0&&rows>0&&columns*rows<=102400?columns*rows:0;
}
function canonicalFogArray(values:unknown,cells:number):values is number[] {
  return Array.isArray(values)&&Object.getPrototypeOf(values)===Array.prototype&&Object.keys(values).length===values.length&&values.length<=cells&&values.every((value,index)=>fogInteger(value)&&value<cells&&(index===0||value>values[index-1]!));
}
function subsetFog(part:readonly number[],whole:readonly number[]):boolean {let index=0;for(const cell of part){while(index<whole.length&&whole[index]!<cell)index++;if(whole[index]!==cell)return false;}return true;}
function fogDifference(before:readonly number[],after:readonly number[]):{added:number[];removed:number[]} {
  const added:number[]=[],removed:number[]=[];let a=0,b=0;
  while(a<before.length&&b<after.length){if(before[a]!<after[b]!)removed.push(before[a++]!);else if(after[b]!<before[a]!)added.push(after[b++]!);else{a++;b++;}}
  while(a<before.length)removed.push(before[a++]!);while(b<after.length)added.push(after[b++]!);return {added,removed};
}
const fogArrayBytes=(values:readonly number[])=>2+Math.max(0,values.length-1)+values.reduce((sum,value)=>sum+String(value).length,0);
function projectionFogDelta(before:ProjectionFields,next:ProjectionFields):ProjectionFogDelta|undefined {
  if(['protocolVersion','contentHash','matchId','matchEpoch','playerId'].some(key=>before[key as keyof ProjectionFields]!==next[key as keyof ProjectionFields])||!sameJson(before.map,next.map))return;
  const cells=fogCells(next.map);if(!cells)return;
  for(const fog of [before.fog,next.fog])if(!fog||Object.keys(fog).length!==2||!Object.hasOwn(fog,'visible')||!Object.hasOwn(fog,'explored')||!canonicalFogArray(fog.visible,cells)||!canonicalFogArray(fog.explored,cells)||!subsetFog(fog.visible,fog.explored))return;
  const visible=fogDifference(before.fog.visible,next.fog.visible),explored=fogDifference(before.fog.explored,next.fog.explored);if(explored.removed.length)return;
  const delta={visibleAdded:visible.added,visibleRemoved:visible.removed,exploredAdded:explored.added};
  // Include property names and punctuation: do not expand a dense changed fog.
  const deltaBytes=63+fogArrayBytes(delta.visibleAdded)+fogArrayBytes(delta.visibleRemoved)+fogArrayBytes(delta.exploredAdded);
  const fullBytes=30+fogArrayBytes(next.fog.visible)+fogArrayBytes(next.fog.explored);
  return deltaBytes<fullBytes?delta:undefined;
}
/** Strict reconstruction uses owned arrays and never mutates the earlier base.
 * Complete reconstructed view schema/node/depth/byte checks remain mandatory. */
export function applyProjectionFogDelta(base:PlayerView['fog'],delta:ProjectionFogDelta,map:PlayerView['map']):PlayerView['fog'] {
  const invalid=():never=>{throw new Error('INVALID_PROJECTION_TRANSFER');},cells=fogCells(map);
  if(!cells||!delta||typeof delta!=='object'||Object.keys(delta).length!==3||!['visibleAdded','visibleRemoved','exploredAdded'].every(key=>Object.hasOwn(delta,key)))return invalid();
  for(const values of [base.visible,base.explored,delta.visibleAdded,delta.visibleRemoved,delta.exploredAdded])if(!canonicalFogArray(values,cells))return invalid();
  const apply=(prior:readonly number[],added:readonly number[],removed:readonly number[]):number[]=>{
    if(!added.length&&!removed.length)return prior as number[];
    const result:number[]=[];let a=0,b=0,c=0;
    while(a<prior.length||b<added.length){
      if(b<added.length&&(a===prior.length||added[b]!<prior[a]!)){if(c<removed.length&&removed[c]!<=added[b]!)return invalid();result.push(added[b++]!);}
      else{const value=prior[a++]!;if(b<added.length&&added[b]===value||c<removed.length&&removed[c]!<value)return invalid();if(c<removed.length&&removed[c]===value)c++;else result.push(value);}
    }
    if(c!==removed.length||result.length>cells)return invalid();return result;
  };
  const visible=apply(base.visible,delta.visibleAdded,delta.visibleRemoved),explored=apply(base.explored,delta.exploredAdded,[]);
  if(!subsetFog(visible,explored))return invalid();return {visible,explored};
}

/** Non-authoritative recipient cache. Reconcile only after acquiring encoder
 * credit; observations and last-seen memory continue independently in Simulation.
 * Records are replaced absolutely, never mutated after an export takes ownership. */
export class RecipientProjection {
  private revision = 0;
  private fields?: ProjectionFields;
  private records = new Map<string, ViewEntity>();
  private order: string[] = [];
  private seen = new Set<string>();
  private nextOrder: string[] = [];
  private changed: ViewEntity[] = [];
  private retained = new Map<string, unknown>();
  private ownedFog?:{visible:number[];explored:number[];fog:PlayerView['fog']};
  private ownedMemories = new WeakMap<ViewEntity,{tick:number|undefined;action:ViewEntity['visualAction'];view:ViewEntity}>();
  private nativeScope?: ReturnType<typeof createNativeProjectionScope>;
  begin(): void { this.nativeScope?.invalidate(); this.seen.clear(); this.nextOrder = []; this.changed = []; }
  invalidateExports(): void { this.nativeScope?.invalidate(); this.ownedFog=undefined; }
  closeExports(): void { this.nativeScope?.close(); this.ownedFog=undefined; }
  static fogRetentionDiagnostics(){return {...ownedFogRetentionCounts};}
  detachedExport(patch: ProjectionPatch): NativeProjection {
    return (this.nativeScope ??= createNativeProjectionScope()).prepare(structuredClone(patch));
  }
  prior(id: string): Readonly<ViewEntity> | undefined { return this.records.get(id); }
  remembered(value: ViewEntity): void {
    const prior = this.records.get(value.id);
    const keys=Object.keys(value);
    const unchanged = prior?.ghost === true && Object.keys(prior).length === keys.length + (Object.hasOwn(value, 'ghost') ? 0 : 1)
      && keys.every(key => sameJson(prior[key as keyof ViewEntity], value[key as keyof ViewEntity]));
    this.entity(unchanged ? prior : { ...structuredClone(value), ghost: true });
  }
  /** Only the private live simulation may certify this payload contract: common
   * fields change by replacing the observation, while timestamp/action have
   * explicit scalar/identity checks. Editable callers must use remembered(). */
  rememberedOwned(value:ViewEntity):void {
    const cached=this.ownedMemories.get(value);
    if(cached&&cached.tick===value.lastSeenTick&&cached.action===value.visualAction&&this.records.get(value.id)===cached.view){this.entity(cached.view);return;}
    const view={...structuredClone(value),ghost:true};this.ownedMemories.set(value,{tick:value.lastSeenTick,action:value.visualAction,view});this.entity(view);
  }
  /** Static map/fog arrays are copied only after their public values change. */
  retain<T>(key: string, value: T): T {
    if(key==='fog')this.ownedFog=undefined;
    const prior = this.retained.get(key);
    if (this.retained.has(key) && sameJson(prior, value)) return prior as T;
    const owned = structuredClone(value); this.retained.set(key, owned); return owned;
  }
  /** Fog inputs remain publicly mutable: compare their contents every time.
   * Keep the unchanged half privately owned instead of cloning an entire explored
   * map whenever a moving unit changes only current visibility. */
  retainFog(visible:number[],explored:number[]):PlayerView['fog'] {
    this.ownedFog=undefined;
    return this.reconcileFog(visible,explored);
  }
  /** Private live-owner contract: both inputs are replaced, never edited, when
   * their values change. The certificate refers only to input identities; the
   * retained output still owns detached arrays and is safe for native posting.
   * Editable callers and any restored custom reader must use retainFog(). */
  retainFogOwned(visible:number[],explored:number[]):PlayerView['fog'] {
    ownedFogRetentionCounts.calls=Math.min(Number.MAX_SAFE_INTEGER,ownedFogRetentionCounts.calls+1);
    const proof=this.ownedFog?.fog===this.retained.get('fog')?this.ownedFog:undefined;
    const fog=this.reconcileFog(visible,explored,proof);
    this.ownedFog={visible,explored,fog};return fog;
  }
  private reconcileFog(visible:number[],explored:number[],proof?:RecipientProjection['ownedFog']):PlayerView['fog'] {
    const prior=this.retained.get('fog') as PlayerView['fog']|undefined;
    const equal=(before:number[]|undefined,after:number[]):boolean=>{
      if(!Array.isArray(before)||before.length!==after.length)return false;
      for(let index=0;index<after.length;index++)if(before[index]!==after[index]&&!sameJson(before[index],after[index]))return false;
      return true;
    };
    const unchanged=(key:'visible'|'explored',input:number[])=>{
      if(proof?.[key]===input){ownedFogRetentionCounts.reusedInputs=Math.min(Number.MAX_SAFE_INTEGER,ownedFogRetentionCounts.reusedInputs+1);return true;}
      return equal(prior?.[key],input);
    };
    const sameVisible=unchanged('visible',visible),sameExplored=unchanged('explored',explored);
    if(prior&&sameVisible&&sameExplored)return prior;
    const owned={visible:sameVisible?prior!.visible:structuredClone(visible),explored:sameExplored?prior!.explored:structuredClone(explored)};
    this.retained.set('fog',owned);return owned;
  }
  entity(value: ViewEntity): void {
    if (this.seen.has(value.id)) throw new Error('DUPLICATE_PROJECTION_ENTITY');
    if (this.nextOrder.length >= MAX_WORLD_ENTITIES) throw new Error('SNAPSHOT_TOO_LARGE');
    this.seen.add(value.id); this.nextOrder.push(value.id);
    const prior = this.records.get(value.id);
    if (!prior || !sameJson(prior, value)) { this.records.set(value.id, value); this.changed.push(value); }
  }
  finish(next: ProjectionFields): ProjectionPatch { return this.finishExport(next, false); }
  finishNative(next: ProjectionFields): NativeProjection { return this.finishExport(next, true); }
  private finishExport(next: ProjectionFields, native: false): ProjectionPatch;
  private finishExport(next: ProjectionFields, native: true): NativeProjection;
  private finishExport(next: ProjectionFields, native: boolean): ProjectionPatch | NativeProjection {
    // JSON omits undefined object properties. Preserve that deletion semantics
    // explicitly because an absolute field patch cannot convey it as undefined.
    next = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as ProjectionFields;
    const fields: Partial<ProjectionFields> = {}, removedFields: (keyof ProjectionFields)[] = [];
    for (const key of Object.keys(next) as (keyof ProjectionFields)[]) if (!this.fields || !Object.hasOwn(this.fields, key) || !sameJson(this.fields[key], next[key])) Object.assign(fields, { [key]: next[key] });
    if (this.fields) for (const key of Object.keys(this.fields) as (keyof ProjectionFields)[]) if (!Object.hasOwn(next, key)) removedFields.push(key);
    const removed: string[] = [];
    for (const id of this.records.keys()) if (!this.seen.has(id)) { removed.push(id); this.records.delete(id); }
    const orderChanged = this.order.length !== this.nextOrder.length || this.order.some((id, index) => id !== this.nextOrder[index]);
    const { protocolVersion, contentHash, matchId, matchEpoch, playerId, tick, sequence, status } = next;
    const fogDelta=this.fields&&Object.hasOwn(fields,'fog')?projectionFogDelta(this.fields,next):undefined;
    if(fogDelta)delete fields.fog;
    const patch: ProjectionPatch = { revision: this.revision + 1, baseRevision: this.revision,
      header: { protocolVersion, contentHash, matchId, matchEpoch, playerId, tick, sequence, status }, fields, removedFields,
      entities: { upserts: this.changed, removed, ...(!this.revision || orderChanged ? { order: this.nextOrder } : {}) },...(fogDelta?{fogDelta}:{}) };
    // Transfer contains only changed records. Export mutation cannot corrupt the
    // retained base, and future source mutations cannot alter a queued transfer.
    const detached = native ? (this.nativeScope ??= createNativeProjectionScope()).prepare(patch) : structuredClone(patch);
    this.revision++; this.fields = next; this.order = this.nextOrder; this.changed = [];
    return detached;
  }
  inventory() { return { revision: this.revision, entities: this.records.size, fields: this.fields ? Object.keys(this.fields).length : 0 }; }
}

/** A slot reserves the maximum permitted transfer size before any DTO work.
 * Busy recipients retain one latest target marker, never a queue of full views. */
export class ProjectionCredits {
  readonly transferByteLimit = 32 * 1024 * 1024;
  readonly globalByteLimit = 128 * 1024 * 1024;
  private rows = new Map<string, { pending: boolean; urgent?: boolean; active?: number; lastRevision?: number }>();
  private retired = new Set<string>();
  private reservedInGeneration = false;
  private generationValue = 0;
  private urgentBurst = 0;
  private readonly maximumUrgentBurst = 4;
  get generation() { return this.generationValue; }
  reset(): number {
    // Reset cancels bases, not byte ownership of transfers already in another
    // thread. Those slots are released only by their old-generation ACKs.
    for (const [id, row] of this.rows) if (row.active !== undefined) this.retired.add(`${this.generationValue}:${id}:${row.active}`);
    this.generationValue++; this.rows.clear(); this.reservedInGeneration = false; this.urgentBurst = 0; return this.generationValue;
  }
  subscribe(playerIds: readonly string[]): string[] {
    if (playerIds.length > 11 || new Set(playerIds).size !== playerIds.length || playerIds.some(id => typeof id !== 'string' || !id.length || id.length > 128)) throw new Error('INVALID_PROJECTION_SUBSCRIBERS');
    if (this.reservedInGeneration && (playerIds.length !== this.rows.size || playerIds.some(id => !this.rows.has(id)))) throw new Error('PROJECTION_MEMBERSHIP_RESET_REQUIRED');
    const removed: string[] = [];
    for (const [id, row] of this.rows) if (!playerIds.includes(id)) { if (row.active !== undefined) this.retired.add(`${this.generationValue}:${id}:${row.active}`); this.rows.delete(id); removed.push(id); }
    for (const id of playerIds) if (!this.rows.has(id)) this.rows.set(id, { pending: true });
    return removed;
  }
  request(playerIds: readonly string[]): void { for (const id of playerIds) { const row = this.rows.get(id); if (row) row.pending = true; } }
  /** Promote only an already requested publication. Urgency is authorized by the
   * simulation; this marker cannot allocate a slot or replace an in-flight view. */
  prioritize(playerIds: readonly string[]): void { for (const id of playerIds) { const row = this.rows.get(id); if (row?.pending) row.urgent = true; } }
  eligible(): string[] {
    let available = this.globalByteLimit / this.transferByteLimit - this.retired.size - [...this.rows.values()].filter(row => row.active !== undefined).length;
    const candidates = [...this.rows].filter(([, row]) => row.pending && row.active === undefined), result: string[] = [];
    let burst = this.urgentBurst;
    while (available > 0 && candidates.length) {
      const urgent = burst < this.maximumUrgentBurst ? candidates.findIndex(([, row]) => row.urgent) : -1;
      // A continuously urgent faction cannot starve the oldest ordinary update.
      // When everyone is urgent, retain the existing round-robin order.
      const ordinary = burst >= this.maximumUrgentBurst ? candidates.findIndex(([, row]) => !row.urgent) : -1;
      const [candidate] = candidates.splice(urgent >= 0 ? urgent : ordinary >= 0 ? ordinary : 0, 1);
      result.push(candidate![0]); available--; burst = urgent < 0 ? 0 : burst + 1;
    }
    return result;
  }
  reserve(playerId: string, revision: number): void {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('INVALID_PROJECTION_REVISION');
    const row = this.rows.get(playerId);
    if (!row || row.active !== undefined || !row.pending || !this.eligible().includes(playerId)) throw new Error('PROJECTION_CREDIT_REQUIRED');
    if (revision <= (row.lastRevision ?? 0)) throw new Error('INVALID_PROJECTION_REVISION');
    this.urgentBurst = row.urgent && this.urgentBurst < this.maximumUrgentBurst ? this.urgentBurst + 1 : 0;
    row.active = revision; row.pending = false; delete row.urgent;
    row.lastRevision = revision;
    this.reservedInGeneration = true;
    // A newly released early slot must not jump ahead of waiting recipients.
    this.rows.delete(playerId); this.rows.set(playerId, row);
  }
  acknowledge(playerId: string, generation: number, revision: number): boolean {
    if (this.retired.delete(`${generation}:${playerId}:${revision}`)) return true;
    const row = this.rows.get(playerId);
    if (generation < this.generationValue || !row) return false;
    if (generation !== this.generationValue || row.active !== revision) throw new Error('STALE_PROJECTION_CREDIT');
    delete row.active; return true;
  }
  inventory() { const active = this.retired.size + [...this.rows.values()].filter(row => row.active !== undefined).length; return { generation: this.generationValue, recipients: this.rows.size, active, retired: this.retired.size, pending: [...this.rows.values()].filter(row => row.pending).length, reservedBytes: active * this.transferByteLimit, globalByteLimit: this.globalByteLimit }; }
}
