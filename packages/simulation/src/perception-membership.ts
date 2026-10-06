import { balance, buildings, units } from '@frontier/shared';
import type { Building, Entity, ResourceNode } from './state.js';
import { changedVisionMaskWords } from './vision-mask-kernel.js';

interface RecordEntry {entity:Entity;ordinal:number;kind:Entity['kind'];ownerId:string|null;typeId:string;x:number;z:number;rotation:number;garrisoned:boolean;pending:boolean;wood:boolean;cells:number[];observed:number}
interface ResourceDifference {previous:readonly ResourceNode[];resources:readonly ResourceNode[];entered:ResourceNode[];exited:ResourceNode[]}
interface Group {mask:Uint8Array;members:Set<string>;actorMembers:Set<string>;ordered?:Entity[];visibleStatics?:Entity[];visibleResources?:ResourceNode[];visibleBuildings?:Building[];resourceChanges?:{previous:readonly ResourceNode[];before:Map<string,ResourceNode|undefined>};resourceDifference?:ResourceDifference;actors:Map<string,{revision:number;entities:Entity[]}>;statics:Map<string,{revision:number;entities:Entity[]}>;recipients:Map<string,{revision:number;entities:Entity[]}>}
/** Exact, derived dependencies. Discovery uses trunks, never forest work cells.
 * Canonical entities remain owned by the simulation; no record is exported. */
export class PerceptionMembership {
  private dimensions='';
  private records=new Map<string,RecordEntry>();
  private cells=new Map<number,Set<string>>();
  private groups=new Map<string,Group>();
  private ownedActors=new Map<string,Set<string>>();
  private ownedRevision=new Map<string,number>();
  private ownedStaticRevision=new Map<string,number>();
  private dirty=new Set<string>();
  private scanGeneration=0;
  private reconciled=0;
  private rechecked=0;
  private resourceCompared=0;
  private ownedWorld:readonly Entity[]|undefined;
  private ownedWidthMm=0;
  private ownedHeightMm=0;
  private ownedActorCount=0;
  private ownedGeometryRevision:number|undefined;
  private ownedNextOrdinal=0;
  private footprint(entity:Entity,columns:number,rows:number,fog:number):number[]{
    if(entity.kind==='building'&&entity.pendingConstruction)return [];
    if(entity.kind==='unit'){
      if(entity.garrisonedIn)return [];
      const radius=units[entity.typeId].collisionRadiusM*1000,center=Math.floor(entity.zMm/fog)*columns+Math.floor(entity.xMm/fog),result=center>=0&&center<columns*rows?[center]:[];
      for(let z=Math.max(0,Math.floor((entity.zMm-radius)/fog));z<=Math.min(rows-1,Math.floor((entity.zMm+radius)/fog));z++)for(let x=Math.max(0,Math.floor((entity.xMm-radius)/fog));x<=Math.min(columns-1,Math.floor((entity.xMm+radius)/fog));x++){
        const dx=Math.max(x*fog-entity.xMm,0,entity.xMm-(x+1)*fog),dz=Math.max(z*fog-entity.zMm,0,entity.zMm-(z+1)*fog),cell=z*columns+x;
        if(dx*dx+dz*dz<=radius*radius&&cell!==center)result.push(cell);
      }
      return result;
    }
    let minX:number,maxX:number,minZ:number,maxZ:number;
    if(entity.kind==='resource'){
      const radius=entity.resource==='wood'?450:650;
      minX=Math.max(0,Math.floor((entity.xMm-radius)/fog));maxX=Math.min(columns-1,Math.ceil((entity.xMm+radius)/fog)-1);
      minZ=Math.max(0,Math.floor((entity.zMm-radius)/fog));maxZ=Math.min(rows-1,Math.ceil((entity.zMm+radius)/fog)-1);
    }else{
      let [width,height]=buildings[entity.typeId].footprintCells;if(entity.rotation===90||entity.rotation===270)[width,height]=[height,width];
      const grid=balance.rules.buildingGridM*1000,firstX=entity.xMm-width*grid/2+fog/2,firstZ=entity.zMm-height*grid/2+fog/2;
      minX=Math.floor(firstX/fog);minZ=Math.floor(firstZ/fog);
      maxX=minX+Math.max(0,Math.ceil((entity.xMm+width*grid/2-firstX)/fog))-1;maxZ=minZ+Math.max(0,Math.ceil((entity.zMm+height*grid/2-firstZ)/fog))-1;
    }
    const result:number[]=[];
    // Linear indexing intentionally preserves established off-grid fixture rules.
    for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++){const cell=z*columns+x;if(cell>=0&&cell<columns*rows)result.push(cell);}
    return result;
  }
  private invalidate(group:Group,kind:Entity['kind'],id:string,wasVisible=true):void{
    group.ordered=undefined;if(kind!=='resource')group.actors.clear();group.recipients.clear();if(kind!=='unit'){group.statics.clear();group.visibleStatics=undefined;}
    if(kind==='resource'){
      if(group.visibleResources)group.resourceChanges={previous:group.visibleResources,before:new Map()};
      // Record the baseline only once when a source changes several times
      // before observation. Other index commits cannot consume these changes.
      if(group.resourceChanges&&!group.resourceChanges.before.has(id))group.resourceChanges.before.set(id,wasVisible?this.records.get(id)?.entity as ResourceNode:undefined);
      group.visibleResources=undefined;group.resourceDifference=undefined;
    }
    if(kind==='building')group.visibleBuildings=undefined;
  }
  private ownerChanged(ownerId:string,staticChanged:boolean):void{this.ownedRevision.set(ownerId,(this.ownedRevision.get(ownerId)??0)+1);if(staticChanged)this.ownedStaticRevision.set(ownerId,(this.ownedStaticRevision.get(ownerId)??0)+1);}
  private remove(id:string,record:RecordEntry):void{for(const cell of record.cells){const entries=this.cells.get(cell);entries?.delete(id);if(!entries?.size)this.cells.delete(cell);}if(record.ownerId!==null){const owned=this.ownedActors.get(record.ownerId);if(owned?.delete(id))this.ownerChanged(record.ownerId,record.kind==='building');if(!owned?.size)this.ownedActors.delete(record.ownerId);}for(const group of this.groups.values())if(group.members.delete(id)){group.actorMembers.delete(id);this.invalidate(group,record.kind,id);}this.records.delete(id);}
  /** One phase scan handles source lifetime and supported direct fixture edits.
   * Only changed footprints touch cell dependency sets; no faction repeats it. */
  synchronize(world:readonly Entity[],widthMm:number,heightMm:number):boolean{
    this.ownedWorld=undefined;
    return this.reconcile(world,widthMm,heightMm,false);
  }
  /** Exclusive simulation-owner path. The owner must replace the world array
   * for every membership/order change, keep resource geometry immutable, and
   * supply all live actors. Generic callers retain full reconciliation above.
   * Actor motion, garrison and ownership still read live fields each phase. */
  synchronizeOwned(world:readonly Entity[],actors:readonly Entity[],widthMm:number,heightMm:number,staticRevision?:number):boolean{
    const sameDimensions=this.ownedWidthMm===widthMm&&this.ownedHeightMm===heightMm,stable=this.ownedWorld===world&&sameDimensions&&this.ownedActorCount===actors.length;
    // The native owner increments this revision for every static membership
    // change and never edits resource geometry. New unit IDs append to the
    // canonical world; deletion preserves relative order. Retaining ordinal
    // holes avoids invalidating every later tree when an early unit dies.
    const lifetime=!stable&&!!this.ownedWorld&&sameDimensions&&Number.isSafeInteger(staticRevision)&&staticRevision!>=0&&this.ownedGeometryRevision===staticRevision&&this.appendOnlyActors(actors);
    const incremental=stable||lifetime;
    // Failed or thrown partial scans can never certify the next incremental call.
    this.ownedWorld=undefined;
    if(!this.reconcile(incremental?actors:world,widthMm,heightMm,incremental,lifetime))return false;
    this.ownedWorld=world;this.ownedWidthMm=widthMm;this.ownedHeightMm=heightMm;this.ownedActorCount=actors.length;
    this.ownedGeometryRevision=staticRevision;if(!incremental)this.ownedNextOrdinal=world.length;
    return true;
  }
  /** Validate actor lifetime/order before touching records. Unsupported custom
   * replacement/reordering and a missing building take the full-world path. */
  private appendOnlyActors(actors:readonly Entity[]):boolean{
    if(this.ownedNextOrdinal+actors.length>=Number.MAX_SAFE_INTEGER)return false;
    const seen=new Set<string>();let ordinal=-1,appended=false;
    for(const entity of actors){
      if(entity.kind==='resource'||seen.has(entity.id))return false;seen.add(entity.id);
      const prior=this.records.get(entity.id);
      if(!prior){if(entity.kind!=='unit')return false;appended=true;continue;}
      if(appended||prior.entity!==entity||prior.kind!==entity.kind||prior.ordinal<=ordinal)return false;
      ordinal=prior.ordinal;
    }
    for(const ids of this.ownedActors.values())for(const id of ids)if(!seen.has(id)&&this.records.get(id)!.kind!=='unit')return false;
    return true;
  }
  private reconcile(world:readonly Entity[],widthMm:number,heightMm:number,actorsOnly:boolean,actorLifetime=false):boolean{
    const fog=balance.rules.fogGridM*1000,columns=Math.floor(widthMm/fog),rows=Math.floor(heightMm/fog),dimensions=`${columns}:${rows}`;
    if(!Number.isSafeInteger(columns)||!Number.isSafeInteger(rows)||columns<=0||rows<=0||columns*rows>2_000_000)return false;
    if(this.dimensions!==dimensions){this.dimensions=dimensions;this.records.clear();this.cells.clear();this.groups.clear();this.ownedActors.clear();this.ownedRevision.clear();this.ownedStaticRevision.clear();this.dirty.clear();}
    // The existing record lookup also proves lifetime and duplicate IDs. Marks
    // belong only to this reconciliation; failed scans never prune records.
    if(this.scanGeneration===Number.MAX_SAFE_INTEGER){for(const record of this.records.values())record.observed=0;this.scanGeneration=0;}
    const generation=++this.scanGeneration;
    for(let index=0;index<world.length;index++){
      const entity=world[index]!,id=entity.id,prior=this.records.get(id);
      if(prior?.observed===generation||actorsOnly&&(entity.kind==='resource'||(prior?prior.entity!==entity:!actorLifetime||entity.kind!=='unit')))return false;
      const ordinal=actorsOnly?(prior?.ordinal??this.ownedNextOrdinal++):index;this.reconciled++;
      if(prior)prior.observed=generation;
      const rotation=entity.kind==='building'?entity.rotation:0,garrisoned=entity.kind==='unit'&&Boolean(entity.garrisonedIn),pending=entity.kind==='building'&&Boolean(entity.pendingConstruction),wood=entity.kind==='resource'&&entity.resource==='wood';
      const changed=!prior||prior.kind!==entity.kind||prior.ownerId!==entity.ownerId||prior.typeId!==entity.typeId||prior.x!==entity.xMm||prior.z!==entity.zMm||prior.rotation!==rotation||prior.garrisoned!==garrisoned||prior.pending!==pending||prior.wood!==wood;
      if(changed){
        const nextCells=this.footprint(entity,columns,rows,fog);
        const sameCells=prior&&prior.cells.length===nextCells.length&&prior.cells.every((cell,index)=>cell===nextCells[index]);
        if(prior&&prior.kind===entity.kind&&prior.ownerId===entity.ownerId&&(sameCells||entity.kind==='unit')){
          if(prior.ordinal!==ordinal||prior.entity!==entity){if(entity.ownerId!==null)this.ownerChanged(entity.ownerId,entity.kind==='building');for(const group of this.groups.values())if(group.members.has(id))this.invalidate(group,entity.kind,id);}
          // A unit crossing fog cells is not necessarily entering/leaving any
          // recipient's view. Keep its live ordered membership until commit
          // checks the new footprint; movement alone does not rebuild rosters.
          if(!sameCells){
            for(const cell of prior.cells){const entries=this.cells.get(cell);entries?.delete(id);if(!entries?.size)this.cells.delete(cell);}
            prior.cells=nextCells;for(const cell of nextCells){const entries=this.cells.get(cell)??new Set<string>();entries.add(id);this.cells.set(cell,entries);}this.dirty.add(id);
          }
          prior.entity=entity;prior.ordinal=ordinal;prior.typeId=entity.typeId;prior.x=entity.xMm;prior.z=entity.zMm;prior.rotation=rotation;prior.garrisoned=garrisoned;prior.pending=pending;prior.wood=wood;continue;
        }
        if(prior)this.remove(id,prior);
        const record:RecordEntry={entity,ordinal,kind:entity.kind,ownerId:entity.ownerId,typeId:entity.typeId,x:entity.xMm,z:entity.zMm,rotation,garrisoned,pending,wood,cells:nextCells,observed:generation};
        this.records.set(id,record);for(const cell of record.cells){const entries=this.cells.get(cell)??new Set<string>();entries.add(id);this.cells.set(cell,entries);}this.dirty.add(id);
        if(entity.kind!=='resource'){const owned=this.ownedActors.get(entity.ownerId)??new Set<string>();owned.add(id);this.ownedActors.set(entity.ownerId,owned);this.ownerChanged(entity.ownerId,entity.kind==='building');}
      }else{
        if(prior.ordinal!==ordinal||prior.entity!==entity){if(entity.ownerId!==null)this.ownerChanged(entity.ownerId,entity.kind==='building');for(const group of this.groups.values())if(group.members.has(id))this.invalidate(group,entity.kind,id);}
        prior.entity=entity;prior.ordinal=ordinal;
      }
    }
    if(!actorsOnly){for(const [id,record]of this.records)if(record.observed!==generation)this.remove(id,record);}
    else if(actorLifetime){for(const ids of this.ownedActors.values())for(const id of ids){const record=this.records.get(id)!;if(record.observed!==generation)this.remove(id,record);}}
    return true;
  }
  commit(results:readonly {key:string;mask:Uint8Array}[]):void{
    const retained=new Set<string>();
    for(const {key,mask}of results){
      retained.add(key);let group=this.groups.get(key);const candidates=new Set(this.dirty);
      if(!group||group.mask.length!==mask.length){group={mask,members:new Set(),actorMembers:new Set(),actors:new Map(),statics:new Map(),recipients:new Map()};this.groups.set(key,group);for(const id of this.records.keys())candidates.add(id);}
      // Phase masks are privately owned immutable outputs. The same referenced
      // buffer is not a baseline for detecting its own in-place mutations.
      else if(group.mask!==mask){
        const changed=changedVisionMaskWords(group.mask,mask);
        if(changed){for(const word of changed)for(let cell=word*32;cell<Math.min(mask.length,word*32+32);cell++)if(mask[cell]!==group.mask[cell])for(const id of this.cells.get(cell)??[])candidates.add(id);}
        else for(let cell=0;cell<mask.length;cell++)if(mask[cell]!==group.mask[cell])for(const id of this.cells.get(cell)??[])candidates.add(id);
      }
      for(const id of candidates){const record=this.records.get(id);if(!record)continue;this.rechecked++;const seen=record.cells.some(cell=>Boolean(mask[cell])),prior=group.members.has(id);if(seen!==prior){if(seen){group.members.add(id);if(record.kind!=='resource')group.actorMembers.add(id);}else{group.members.delete(id);group.actorMembers.delete(id);}this.invalidate(group,record.kind,id,prior);}}
      group.mask=mask;
    }
    for(const key of this.groups.keys())if(!retained.has(key))this.groups.delete(key);this.dirty.clear();
  }
  visible(key:string,id:string):boolean{return this.groups.get(key)?.members.has(id)??false;}
  members(key:string):readonly Entity[]{const group=this.groups.get(key);if(!group)return [];return group.ordered??=Array.from(group.members,id=>this.records.get(id)!).sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity);}
  actors(key:string,ownerId:string):readonly Entity[]{
    const group=this.groups.get(key),revision=this.ownedRevision.get(ownerId)??0,prior=group?.actors.get(ownerId);if(prior?.revision===revision)return prior.entities;
    // Resource-only visibility changes neither invalidate this cache nor enter
    // its candidate roster, even in a world containing thousands of trees.
    const ids=new Set(this.ownedActors.get(ownerId));for(const id of group?.actorMembers??[])ids.add(id);
    const entities=Array.from(ids,id=>this.records.get(id)!).sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity);group?.actors.set(ownerId,{revision,entities});return entities;
  }
  /** Visible entities plus every owned actor, including garrisoned units, in
   * original world order. Presentation fields are read live by the caller. */
  recipients(key:string,ownerId:string):readonly Entity[]{
    const group=this.groups.get(key),revision=this.ownedRevision.get(ownerId)??0,prior=group?.recipients.get(ownerId);if(prior?.revision===revision)return prior.entities;
    const ids=new Set(this.ownedActors.get(ownerId));for(const id of group?.members??[])ids.add(id);
    const entities=Array.from(ids,id=>this.records.get(id)!).sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity);group?.recipients.set(ownerId,{revision,entities});return entities;
  }
  /** Every recipient sharing this vision group observes the same static roster.
   * Exclude hidden owned buildings: memory refresh separately skips own actors.
   * Only this derived roster is shared, never recipient memory or action data. */
  visibleStatics(key:string):readonly Entity[]{
    const group=this.groups.get(key);if(!group)return [];
    return group.visibleStatics??=Array.from(group.members,id=>this.records.get(id)!).filter(record=>record.kind!=='unit').sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity);
  }
  /** Resource payloads are immutable except for owner-notified gathering. A
   * recipient retains its own previous roster, so other membership readers and
   * repeated same-tick commits cannot consume its entry/exit events. Returned
   * observations preserve world order, including newly observed buildings. */
  resourceObservations(key:string,previous:readonly ResourceNode[]|undefined,changed:ReadonlySet<ResourceNode>):{resources:readonly ResourceNode[];exited:readonly ResourceNode[];observations:readonly Entity[]}{
    const group=this.groups.get(key);if(!group)return {resources:[],exited:previous??[],observations:[]};
    const resources=group.visibleResources??=this.visibleStatics(key).filter((entity):entity is ResourceNode=>entity.kind==='resource');
    if(group.resourceChanges){
      const changes=group.resourceChanges,entered:ResourceNode[]=[],exited:ResourceNode[]=[];
      for(const [id,before]of changes.before){const record=group.members.has(id)?this.records.get(id):undefined,current=record?.kind==='resource'?record.entity as ResourceNode:undefined;if(before!==current){if(before)exited.push(before);if(current)entered.push(current);}}
      this.resourceCompared=Math.min(Number.MAX_SAFE_INTEGER,this.resourceCompared+changes.before.size);
      group.resourceDifference={previous:changes.previous,resources,entered,exited};group.resourceChanges=undefined;
    }
    if(!previous)return {resources,exited:[],observations:this.visibleStatics(key)};
    const buildings=group.visibleBuildings??=Array.from(group.actorMembers,id=>this.records.get(id)!).filter(record=>record.kind==='building').sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity as Building);
    const updates=new Set<ResourceNode>(),exited:ResourceNode[]=[];
    if(resources!==previous){
      const delta=group.resourceDifference;
      if(delta?.previous===previous&&delta.resources===resources){for(const resource of delta.entered)updates.add(resource);exited.push(...delta.exited);}
      else{this.resourceCompared=Math.min(Number.MAX_SAFE_INTEGER,this.resourceCompared+previous.length+resources.length);const prior=new Set(previous),current=new Set(resources);for(const resource of resources)if(!prior.has(resource))updates.add(resource);for(const resource of previous)if(!current.has(resource))exited.push(resource);}
    }
    for(const resource of changed)if(group.members.has(resource.id)&&this.records.get(resource.id)?.entity===resource)updates.add(resource);
    if(!updates.size)return {resources,exited,observations:buildings};
    const pending=[...updates].sort((a,b)=>this.records.get(a.id)!.ordinal-this.records.get(b.id)!.ordinal),observations:Entity[]=[];
    let index=0;for(const building of buildings){const ordinal=this.records.get(building.id)!.ordinal;while(index<pending.length&&this.records.get(pending[index]!.id)!.ordinal<ordinal)observations.push(pending[index++]!);observations.push(building);}while(index<pending.length)observations.push(pending[index++]!);
    return {resources,exited,observations};
  }
  /** Current visible statics and owned buildings, in canonical world order.
   * Unit lifetime, movement and ownership do not invalidate this separate roster.
   * Callers append remembered observations to their own array, never this cache. */
  statics(key:string,ownerId:string):readonly Entity[]{
    const group=this.groups.get(key),revision=this.ownedStaticRevision.get(ownerId)??0,prior=group?.statics.get(ownerId);if(prior?.revision===revision)return prior.entities;
    const ids=new Set<string>();
    for(const id of this.ownedActors.get(ownerId)??[])if(this.records.get(id)!.kind!=='unit')ids.add(id);
    for(const id of group?.members??[])if(this.records.get(id)!.kind!=='unit')ids.add(id);
    const entities=Array.from(ids,id=>this.records.get(id)!).sort((a,b)=>a.ordinal-b.ordinal).map(record=>record.entity);group?.statics.set(ownerId,{revision,entities});return entities;
  }
  inventory(){return {entities:this.records.size,cells:this.cells.size,groups:this.groups.size,reconciled:this.reconciled,rechecked:this.rechecked,resourceCompared:this.resourceCompared};}
}
