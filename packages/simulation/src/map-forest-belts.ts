import { balance, terrainObstacles, type Position, type PublicPlayer } from '@frontier/shared';
import type { GeneratedMap, MapResource, MapSpawn } from './map.js';
import { Navigation,type Obstacle } from './navigation.js';
import { forestApproachOverlapsObstacle,forestCrossingPolygons,type ForestFrontier } from './map-forest-belts-validation.js';

type Rectangle={left:number;top:number;right:number;bottom:number};
type Interval=[number,number];
const cell=balance.maps.forestNavigationCellM*1000;
const rules=balance.maps.forestBelts;
const overlaps=(a:Rectangle,b:Rectangle)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
const rectangle=(obstacle:Obstacle):Rectangle=>({left:obstacle.xMm-obstacle.halfWidth,right:obstacle.xMm+obstacle.halfWidth,top:obstacle.zMm-obstacle.halfHeight,bottom:obstacle.zMm+obstacle.halfHeight});
const slab=(frontier:ForestFrontier):Rectangle=>frontier.axis==='x'?{left:frontier.coordinateMm-frontier.depthMm/2,right:frontier.coordinateMm+frontier.depthMm/2,top:frontier.fromMm,bottom:frontier.toMm}:{left:frontier.fromMm,right:frontier.toMm,top:frontier.coordinateMm-frontier.depthMm/2,bottom:frontier.coordinateMm+frontier.depthMm/2};
const along=(frontier:ForestFrontier,point:Position)=>frontier.axis==='x'?point.zMm:point.xMm;
const normal=(frontier:ForestFrontier,point:Position)=>frontier.axis==='x'?point.xMm:point.zMm;
const merge=(values:Interval[]):Interval[]=>{const result:Interval[]=[];for(const entry of values.sort((a,b)=>a[0]-b[0])){const prior=result.at(-1);if(prior&&entry[0]<=prior[1])prior[1]=Math.max(prior[1],entry[1]);else result.push([...entry]);}return result;};

/** Host-private construction plan. Every crossing reserves its whole flared
 * approach before ordinary resource lots are packed. No runtime work is added. */
export function forestCrossingReservations(frontiers:readonly ForestFrontier[]):Rectangle[]{
  return frontiers.flatMap(frontier=>frontier.crossings.map(crossing=>{
    // Also keep the swept formation's approach end caps clear. The polygonal
    // flare alone does not cover the full radius at the first/last center point.
    const half=frontier.depthMm/2+crossing.approachMm+crossing.widthMm/2,width=crossing.flareWidthMm/2,shift=crossing.bankEdge==='from'?(crossing.flareWidthMm-crossing.widthMm)/2:crossing.bankEdge==='to'?-(crossing.flareWidthMm-crossing.widthMm)/2:0;
    return frontier.axis==='x'?{left:frontier.coordinateMm-half,right:frontier.coordinateMm+half,top:crossing.centerMm+shift-width,bottom:crossing.centerMm+shift+width}:{left:crossing.centerMm+shift-width,right:crossing.centerMm+shift+width,top:frontier.coordinateMm-half,bottom:frontier.coordinateMm+half};
  }));
}

/** Cuts are through the middle of the immutable ridge plots. Their coordinates
 * depend on map dimensions only; choosing which cuts receive trees is private. */
export function forestTerritoryCuts(axes:readonly number[]):number[]{return axes.slice(1).map((value,index)=>Math.round((value+axes[index]!)/2/cell)*cell);}

function partition(map:GeneratedMap,factions:readonly PublicPlayer[],axes:{x:readonly number[];z:readonly number[]},depth:number,attempt:number):ForestFrontier[]{
  const teams=new Map(factions.map(faction=>[faction.id,faction.teamId])),frontiers:ForestFrontier[]=[],leaves:{bounds:Rectangle;team:string|undefined}[]=[];
  const split=(bounds:Rectangle,spawns:MapSpawn[]):void=>{
    if(new Set(spawns.map(spawn=>teams.get(spawn.playerId))).size<=1){leaves.push({bounds,team:teams.get(spawns[0]?.playerId??'')});return;}
    const candidates:{axis:'x'|'z';coordinate:number;low:MapSpawn[];high:MapSpawn[];score:number}[]=[];
    for(const axis of ['x','z'] as const)for(const coordinate of axes[axis]){
      if(map.type==='river_divide'&&axis==='x')continue;
      if(coordinate-depth/2<=(axis==='x'?bounds.left:bounds.top)||coordinate+depth/2>=(axis==='x'?bounds.right:bounds.bottom))continue;
      const length=axis==='x'?bounds.bottom-bounds.top:bounds.right-bounds.left;
      if(length<rules.minimumOpenings*balance.maps.naturalBarriers.valleyWidthM*1000+(rules.minimumOpenings-1)*rules.minimumDepthM*1000+cell*4)continue;
      const low=spawns.filter(spawn=>spawn.center[axis==='x'?'xMm':'zMm']<coordinate),high=spawns.filter(spawn=>!low.includes(spawn));
      if(!low.length||!high.length||spawns.some(spawn=>Math.abs(spawn.center[axis==='x'?'xMm':'zMm']-coordinate)<40000+depth/2))continue;
      const leftTeams=new Set(low.map(spawn=>teams.get(spawn.playerId))),rightTeams=new Set(high.map(spawn=>teams.get(spawn.playerId))),splitTeams=[...leftTeams].filter(team=>rightTeams.has(team)).length;
      candidates.push({axis,coordinate,low,high,score:splitTeams*1000000+Math.abs(low.length-high.length)*1000+length/1000});
    }
    candidates.sort((a,b)=>a.score-b.score||a.coordinate-b.coordinate||a.axis.localeCompare(b.axis));
    if(!candidates.length)throw new Error('FOREST_TERRITORY_PARTITION_FAILED');
    // Alternate equally team-preserving splits on generation retries.
    const best=candidates[0]!,eligible=candidates.filter(candidate=>Math.floor(candidate.score/1000000)===Math.floor(best.score/1000000));
    const selected=eligible[attempt%Math.min(3,eligible.length)]!;
    const {axis,coordinate,low,high}=selected;
    frontiers.push({id:`frontier_${frontiers.length+1}`,axis,coordinateMm:coordinate,fromMm:axis==='x'?bounds.top:bounds.left,toMm:axis==='x'?bounds.bottom:bounds.right,depthMm:depth,crossings:[]});
    split(axis==='x'?{...bounds,right:coordinate-depth/2}:{...bounds,bottom:coordinate-depth/2},low);
    split(axis==='x'?{...bounds,left:coordinate+depth/2}:{...bounds,top:coordinate+depth/2},high);
  };
  if(map.type==='river_divide'){
    const river=map.terrain.find(region=>region.kind==='water'&&region.id==='river')!;
    for(const side of ['left','right'] as const){
      const bankSpawns=map.spawns.filter(spawn=>(spawn.center.xMm<map.widthMm/2)===(side==='left'));
      if(!bankSpawns.length)continue;
      const prior=frontiers.length;
      split({left:side==='left'?0:river.xMm+river.widthMm,top:0,right:side==='left'?river.xMm:map.widthMm,bottom:map.heightMm},bankSpawns);
      // A wholly allied bank still receives a defensive forest approach when
      // opponents live across the river. Existing broad bridges remain intact.
      if(frontiers.length===prior&&map.spawns.some(spawn=>!bankSpawns.includes(spawn)&&teams.get(spawn.playerId)!==teams.get(bankSpawns[0]!.playerId))){
        const setback=balance.maps.naturalBarriers.valleyWidthM*1000+depth/2;
        const coordinate=side==='left'?Math.floor((river.xMm-setback)/cell)*cell:Math.ceil((river.xMm+river.widthMm+setback)/cell)*cell;
        if(bankSpawns.some(spawn=>Math.abs(spawn.center.xMm-coordinate)<40000+depth/2))throw new Error('FOREST_BANK_SETTLEMENT_CLEARANCE');
        frontiers.push({id:`frontier_${frontiers.length+1}`,axis:'x',coordinateMm:coordinate,fromMm:0,toMm:map.heightMm,depthMm:depth,crossings:[]});
      }
    }
  }else split({left:0,top:0,right:map.widthMm,bottom:map.heightMm},map.spawns);
  // A long parent seam can border several final territories. Each neighbor
  // segment gets its own two or three openings, not a share of one global pair.
  return frontiers.flatMap(frontier=>{
    const junctions=frontiers.filter(other=>other.axis!==frontier.axis&&(Math.abs(other.fromMm-frontier.coordinateMm)===frontier.depthMm/2||Math.abs(other.toMm-frontier.coordinateMm)===frontier.depthMm/2)&&other.coordinateMm>frontier.fromMm&&other.coordinateMm<frontier.toMm).map(other=>other.coordinateMm);
    const boundaries=[frontier.fromMm,...new Set(junctions.sort((a,b)=>a-b)),frontier.toMm];
    return boundaries.slice(1).map((toMm,index)=>({...frontier,id:`${frontier.id}_${index+1}`,fromMm:boundaries[index]!,toMm,crossings:[]}));
  }).filter(frontier=>{
    if(map.type==='river_divide')return true;
    // BSP cuts can split one alliance while finding a rival boundary elsewhere.
    // Only the final neighboring territories determine which segments need a
    // forest; keeping an allied segment would spend two openings unnecessarily.
    const midpoint=(frontier.fromMm+frontier.toMm)/2;
    const teamAt=(side:number)=>{
      const normalMm=frontier.coordinateMm+side*(frontier.depthMm/2+1),point=frontier.axis==='x'?{xMm:normalMm,zMm:midpoint}:{xMm:midpoint,zMm:normalMm};
      return leaves.find(({bounds})=>point.xMm>=bounds.left&&point.xMm<=bounds.right&&point.zMm>=bounds.top&&point.zMm<=bounds.bottom)?.team;
    };
    return teamAt(-1)!==teamAt(1);
  }).map(frontier=>{
    if(map.type==='river_divide')return frontier;
    // Once allied segments are removed, a T may become a rival-facing corner.
    // Meet at the center of its existing ridge, keeping a physical closed join
    // and a connected frontier graph rather than leaving an isolated end cap.
    for(const parent of frontiers)if(parent.axis!==frontier.axis&&frontier.coordinateMm>=parent.fromMm&&frontier.coordinateMm<=parent.toMm){
      if(frontier.fromMm===parent.coordinateMm+parent.depthMm/2)frontier.fromMm=parent.coordinateMm;
      if(frontier.toMm===parent.coordinateMm-parent.depthMm/2)frontier.toMm=parent.coordinateMm;
    }
    return frontier;
  });
}

function openIntervals(frontier:ForestFrontier,terrain:readonly Obstacle[]):Interval[]{
  const opaque:Interval[]=[],half=frontier.depthMm/2;
  for(const obstacle of terrain){
    const normalHalf=frontier.axis==='x'?obstacle.halfWidth:obstacle.halfHeight,alongHalf=frontier.axis==='x'?obstacle.halfHeight:obstacle.halfWidth,n=normal(frontier,obstacle),a=along(frontier,obstacle);
    if(a+alongHalf<=frontier.fromMm||a-alongHalf>=frontier.toMm)continue;
    if(n+normalHalf<=frontier.coordinateMm-half||n-normalHalf>=frontier.coordinateMm+half)continue;
    if(n-normalHalf>frontier.coordinateMm-half||n+normalHalf<frontier.coordinateMm+half)throw new Error(`FOREST_PARTIAL_TERRAIN_ANCHOR:${frontier.id}`);
    if(a+alongHalf>frontier.fromMm&&a-alongHalf<frontier.toMm)opaque.push([Math.max(frontier.fromMm,a-alongHalf),Math.min(frontier.toMm,a+alongHalf)]);
  }
  const result:Interval[]=[];let cursor=frontier.fromMm;
  for(const [from,to]of merge(opaque)){if(from>cursor)result.push([cursor,from]);cursor=Math.max(cursor,to);}
  if(cursor<frontier.toMm)result.push([cursor,frontier.toMm]);return result;
}

function chooseCrossings(map:GeneratedMap,frontiers:ForestFrontier[],obstacles:readonly Obstacle[],attempt:number):Map<string,Interval[]>{
  const terrain=terrainObstacles(map.terrain),gaps=new Map<string,Interval[]>(),width=balance.maps.naturalBarriers.valleyWidthM*1000,approach=rules.approachLengthM*1000,nav=new Navigation(map.widthMm,map.heightMm,[...obstacles]);
  for(const frontier of frontiers){
    const intervals=openIntervals(frontier,terrain);gaps.set(frontier.id,intervals);
    const choices:{interval:number;crossing:ForestFrontier['crossings'][number];score:number}[]=[];
    const river=map.type==='river_divide'?map.terrain.find(region=>region.kind==='water'&&region.id==='river'):undefined;
    const bankEdge=river&&frontier.axis==='z'?(frontier.fromMm===river.xMm+river.widthMm?'from':frontier.toMm===river.xMm?'to':undefined):undefined;
    const addChoice=(interval:number,crossing:ForestFrontier['crossings'][number],score:number)=>{
      const [bounds]=forestCrossingReservations([{...frontier,crossings:[crossing]}]);
      if(!bounds)return;
      const polygons=forestCrossingPolygons(frontier,crossing);
      const point=(normal:number):Position=>frontier.axis==='x'?{xMm:normal,zMm:crossing.centerMm}:{xMm:crossing.centerMm,zMm:normal};
      const reach=frontier.depthMm/2+crossing.approachMm;
      if(bounds.left<0||bounds.top<0||bounds.right>map.widthMm||bounds.bottom>map.heightMm||obstacles.some(obstacle=>overlaps(bounds,rectangle(obstacle))&&polygons.some(polygon=>forestApproachOverlapsObstacle(obstacle,polygon)))||!nav.clearLine(point(frontier.coordinateMm-reach),point(frontier.coordinateMm+reach),crossing.widthMm/2)||frontiers.some(other=>other!==frontier&&overlaps(bounds,slab(other))))return;
      choices.push({interval,crossing,score});
    };
    for(const [index,[from,to]]of intervals.entries()){
      const remainder=(to-from)%cell;
      if(bankEdge==='from'&&from===frontier.fromMm)addChoice(index,{centerMm:from+(width+remainder)/2,widthMm:width+remainder,approachMm:approach,flareWidthMm:width+remainder+approach/2,bankEdge},-1);
      if(bankEdge==='to'&&to===frontier.toMm)addChoice(index,{centerMm:to-(width+remainder)/2,widthMm:width+remainder,approachMm:approach,flareWidthMm:width+remainder+approach/2,bankEdge},-1);
      for(const neck of new Set([width,width+remainder]))for(const offset of new Set([0,remainder]))for(let start=from+offset+(from===frontier.fromMm?cell*2:0);start+neck<=to-(to===frontier.toMm?cell*2:0);start+=cell){
        const crossing={centerMm:start+neck/2,widthMm:neck,approachMm:approach,flareWidthMm:neck+approach/2};
        addChoice(index,crossing,Math.abs(crossing.centerMm-(from+to)/2));
      }
    }
    // Local width proofs do not choose a global pair of independent formation
    // routes. Retries must explore different valid mouths as well as partitions
    // instead of repeating the same center-biased arrangement fifty times.
    const ranking=Math.floor(attempt/3)%3;
    choices.sort((a,b)=>ranking===1?a.crossing.centerMm-b.crossing.centerMm:ranking===2?b.crossing.centerMm-a.crossing.centerMm:a.score-b.score||a.crossing.centerMm-b.crossing.centerMm);
    let selected:typeof choices|undefined,work=0;
    const tiled=(entries:typeof choices)=>intervals.every(([from,to],index)=>{
      let cursor=from;
      for(const {crossing}of entries.filter(entry=>entry.interval===index).sort((a,b)=>a.crossing.centerMm-b.crossing.centerMm)){
        const start=crossing.centerMm-crossing.widthMm/2;if((start-cursor)%cell)return false;cursor=crossing.centerMm+crossing.widthMm/2;
      }
      return (to-cursor)%cell===0;
    });
    const search=(target:number,entries:typeof choices,index:number):void=>{
      if(selected||++work>50000)return;
      if(entries.length===target){if((!bankEdge||entries.some(entry=>entry.crossing.bankEdge===bankEdge))&&tiled(entries))selected=[...entries];return;}
      for(let i=index;i<choices.length;i++){
        const choice=choices[i]!;
        if(entries.some(prior=>Math.abs(prior.crossing.centerMm-choice.crossing.centerMm)<(prior.crossing.widthMm+choice.crossing.widthMm)/2+rules.minimumDepthM*1000))continue;
        search(target,[...entries,choice],i+1);if(selected)return;
      }
    };
    // The large Long War frontier uses the allowed two broad openings. Filling
    // the optional third opening with real trees preserves defensive geography
    // and leaves room for ordinary-yield late-game stock beyond the approaches.
    const preferred=map.startingResourcePreset==='long_war'&&map.type==='open_frontier'&&map.spawns.length>=9?rules.minimumOpenings:rules.preferredOpenings;
    for(let target=preferred;target>=rules.minimumOpenings&&!selected;target--){work=0;search(target,[],0);}
    if(!selected)throw new Error(`FOREST_CROSSING_LAYOUT_FAILED:${frontier.id}`);
    frontier.crossings=selected.map(choice=>choice.crossing).sort((a,b)=>a.centerMm-b.centerMm);
  }
  return gaps;
}

/** Redistribute existing wood objects into continuous belts, adding real neutral
 * trees when necessary. Nearby starter allocations stay exact; yields never rise. */
export function addForestBelts(map:GeneratedMap,factions:readonly PublicPlayer[],axes:{x:readonly number[];z:readonly number[]},obstacles:readonly Obstacle[],attempt:number,makeTree:(position:Position,owner:string|undefined,serial:number)=>MapResource):void {
  let lastFailure='UNKNOWN';
  for(const depthM of [rules.targetDepthM])try{
    const frontiers=partition(map,factions,axes,depthM*1000,attempt),intervals=chooseCrossings(map,frontiers,obstacles,attempt),positions:Position[]=[];
    for(const frontier of frontiers)for(const [from,to]of intervals.get(frontier.id)!){
      let cursor=from;
      const closed:Interval[]=[];
      for(const crossing of frontier.crossings.filter(crossing=>crossing.centerMm>from&&crossing.centerMm<to)){closed.push([cursor,crossing.centerMm-crossing.widthMm/2]);cursor=crossing.centerMm+crossing.widthMm/2;}
      closed.push([cursor,to]);
      for(const [start,end]of closed){
        if((end-start)%cell)throw new Error(`FOREST_CELL_TILING_FAILED:${frontier.id}`);
        for(let alongMm=start+cell/2;alongMm<end;alongMm+=cell)for(let normalMm=frontier.coordinateMm-frontier.depthMm/2+cell/2;normalMm<frontier.coordinateMm+frontier.depthMm/2;normalMm+=cell){
          if(positions.length>=balance.rules.maxResourceNodes)throw new Error('RESOURCE_NODE_LIMIT');
          positions.push(frontier.axis==='x'?{xMm:normalMm,zMm:alongMm}:{xMm:alongMm,zMm:normalMm});
        }
      }
    }
    const quotas=new Map(map.spawns.map(spawn=>[spawn.playerId,balance.maps.resourceNodes.starting.wood-map.resources.filter(node=>node.resource==='wood'&&node.startRegion===spawn.playerId).length]));
    let neutral=0;for(let index=0;index<Math.max(4,factions.length*2);index++)if(index%4===1)neutral+=balance.maps.resourceNodes.expansion.wood;
    // Keep the same neutral count and original per-node yields, but distribute
    // neutral Long War woodland through the belts instead of only the last
    // visited frontier. Starting quotas remain exact and bank-local.
    const bank=(point:Position)=>map.type==='river_divide'&&point.xMm>=map.widthMm/2?1:0;
    const bankPositions=[0,0],bankQuotas=[0,0],bankSeen=[0,0];
    if(map.startingResourcePreset==='long_war'&&map.type==='open_frontier'){
      for(const point of positions)bankPositions[bank(point)]!++;
      for(const spawn of map.spawns)bankQuotas[bank(spawn.center)]!+=quotas.get(spawn.playerId)!;
    }
    const neutralQuota=bankPositions.map((count,index)=>Math.max(0,count-bankQuotas[index]!));
    const trees:MapResource[]=[];
    for(const [index,position]of positions.entries()){
      const side=bank(position),ordinal=bankSeen[side]!++,spreadNeutral=map.startingResourcePreset==='long_war'&&map.type==='open_frontier'&&Math.floor((ordinal+1)*neutralQuota[side]!/bankPositions[side]!)>Math.floor(ordinal*neutralQuota[side]!/bankPositions[side]!);
      const owners=spreadNeutral?[]:map.spawns.filter(spawn=>(quotas.get(spawn.playerId)??0)>0&&(map.type!=='river_divide'||(position.xMm<map.widthMm/2)===(spawn.center.xMm<map.widthMm/2))).sort((a,b)=>(a.center.xMm-position.xMm)**2+(a.center.zMm-position.zMm)**2-((b.center.xMm-position.xMm)**2+(b.center.zMm-position.zMm)**2)||a.playerId.localeCompare(b.playerId));
      const owner=owners[0]?.playerId;
      if(owner)quotas.set(owner,quotas.get(owner)!-1);else neutral--;
      trees.push(makeTree(position,owner,index));
    }
    const baseline=factions.length*Object.values(balance.maps.resourceNodes.starting).reduce((sum,count)=>sum+count,0)+Array.from({length:Math.max(4,factions.length*2)},(_,index)=>balance.maps.resourceNodes.expansion[(['food','wood','gold','stone'] as const)[index%4]!]).reduce((sum,count)=>sum+count,0);
    if(baseline+Math.max(0,-neutral)>balance.rules.maxResourceNodes)throw new Error('RESOURCE_NODE_LIMIT');
    map.forestFrontiers=frontiers;map.resources.push(...trees);
    map.validation.forestBelts={frontiers:frontiers.length,openings:frontiers.reduce((sum,frontier)=>sum+frontier.crossings.length,0),minimumDepthMm:frontiers.length?Math.min(...frontiers.map(frontier=>frontier.depthMm)):0,treeNodes:trees.length,extraTreeNodes:Math.max(0,-neutral)};
    return;
  }catch(error){lastFailure=error instanceof Error?error.message:'UNKNOWN';}
  throw new Error(lastFailure);
}
