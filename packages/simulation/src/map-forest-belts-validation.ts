import { balance,MAX_WORLD_ENTITIES,terrainObstacles,type ForestCell,type Position,type ResourceType,type TerrainRegion } from '@frontier/shared';
import { Navigation, type Obstacle } from './navigation.js';

/** Generation-only, host-private metadata. axis x means a constant x coordinate
 * with distances measured along z; axis z means the reverse. */
export interface ForestFrontier {
  id:string;axis:'x'|'z';coordinateMm:number;fromMm:number;toMm:number;depthMm:number;
  crossings:{centerMm:number;widthMm:number;approachMm:number;flareWidthMm:number;bankEdge?:'from'|'to'}[];
}
export interface ForestFrontierValidationInput {
  widthMm:number;heightMm:number;obstacles:readonly Obstacle[];frontiers:readonly ForestFrontier[];
  terrain?:readonly TerrainRegion[];
}
export interface ForestFrontierValidationReport {
  valid:boolean;verifiedFrontiers:number;verifiedCrossings:number;geometryChecks:number;
  frontierId?:string;
  failure?:'INVALID_INPUT'|'WORK_LIMIT'|'OPENING_COUNT'|'OPENING_MISMATCH'|'NARROW_OPENING'|'INCOMPLETE_BELT'|'UNANCHORED_END'|'OBSTRUCTED_APPROACH';
}
export interface ForestBeltSummary {frontiers:number;openings:number;minimumDepthMm:number;treeNodes:number;extraTreeNodes:number}
/** Rebuild generation evidence from the private frontier geometry and real
 * resource objects. Labels in the candidate report do not authorize extra wood
 * or prove that a frontier exists. This is not a faction-topology certificate. */
export function validateForestBeltSummary(input:{frontiers?:readonly ForestFrontier[];resources:readonly (Position&{resource:ResourceType;startRegion?:string;forest?:ForestCell})[];factionCount:number;summary?:ForestBeltSummary}):ForestBeltSummary {
  const {frontiers,resources,factionCount,summary}=input;
  if(!frontiers)throw new Error('MISSING_FOREST_FRONTIERS');
  if(resources.length>balance.rules.maxResourceNodes)throw new Error('RESOURCE_NODE_LIMIT');
  if(frontiers.length>32||!Number.isSafeInteger(factionCount)||factionCount<2||factionCount>balance.rules.factionLimit||!summary||frontiers.some(frontier=>![frontier.coordinateMm,frontier.fromMm,frontier.toMm,frontier.depthMm].every(Number.isSafeInteger)||frontier.crossings.length>balance.maps.forestBelts.preferredOpenings))throw new Error('INVALID_FOREST_BELT_SUMMARY');
  let expectedNeutralWood=0;for(let index=0;index<Math.max(4,factionCount*2);index++)if(index%4===1)expectedNeutralWood+=balance.maps.resourceNodes.expansion.wood;
  let neutralWood=0,treeNodes=0;
  for(const node of resources){
    if(node.resource!=='wood')continue;
    if(!node.startRegion)neutralWood++;
    if(node.forest&&frontiers.some(frontier=>{const normal=frontier.axis==='x'?node.xMm:node.zMm,along=frontier.axis==='x'?node.zMm:node.xMm;return Math.abs(normal-frontier.coordinateMm)<frontier.depthMm/2&&along>frontier.fromMm&&along<frontier.toMm&&!frontier.crossings.some(crossing=>Math.abs(along-crossing.centerMm)<crossing.widthMm/2);}))treeNodes++;
  }
  const derived:ForestBeltSummary={frontiers:frontiers.length,openings:frontiers.reduce((sum,frontier)=>sum+frontier.crossings.length,0),minimumDepthMm:frontiers.length?Math.min(...frontiers.map(frontier=>frontier.depthMm)):0,treeNodes,extraTreeNodes:Math.max(0,neutralWood-expectedNeutralWood)};
  for(const key of Object.keys(derived) as (keyof ForestBeltSummary)[])if(!Number.isSafeInteger(summary[key])||summary[key]!==derived[key])throw new Error('INVALID_FOREST_BELT_SUMMARY');
  return derived;
}
type Interval=readonly [number,number];
const EPSILON=.001;
const merged=(intervals:Interval[]):Interval[]=>{
  const result:[number,number][]=[];
  for(const [start,end] of intervals.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){
    const prior=result.at(-1);if(prior&&start<=prior[1]+EPSILON)prior[1]=Math.max(prior[1],end);else result.push([start,end]);
  }
  return result;
};
const covers=(intervals:Interval[],from:number,to:number)=>merged(intervals).some(([start,end])=>start<=from+EPSILON&&end>=to-EPSILON);
const perpendicular=(frontier:ForestFrontier,normal:number,along:number):Position=>frontier.axis==='x'?{xMm:normal,zMm:along}:{xMm:along,zMm:normal};
const cross=(a:Position,b:Position,c:Position)=>(b.xMm-a.xMm)*(c.zMm-a.zMm)-(b.zMm-a.zMm)*(c.xMm-a.xMm);
export function forestApproachOverlapsObstacle(obstacle:Obstacle,polygon:readonly Position[]):boolean {
  if(obstacle.circle){
    const center={xMm:obstacle.xMm,zMm:obstacle.zMm},signs=polygon.map((point,index)=>cross(point,polygon[(index+1)%polygon.length]!,center));
    if(signs.every(value=>value>=0)||signs.every(value=>value<=0))return true;
    const radius2=obstacle.halfWidth**2;
    return polygon.some((point,index)=>{const end=polygon[(index+1)%polygon.length]!,dx=end.xMm-point.xMm,dz=end.zMm-point.zMm,length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((center.xMm-point.xMm)*dx+(center.zMm-point.zMm)*dz)/length)):0;return (center.xMm-point.xMm-dx*t)**2+(center.zMm-point.zMm-dz*t)**2<radius2-EPSILON;});
  }
  const corners=[{xMm:obstacle.xMm-obstacle.halfWidth,zMm:obstacle.zMm-obstacle.halfHeight},{xMm:obstacle.xMm+obstacle.halfWidth,zMm:obstacle.zMm-obstacle.halfHeight},{xMm:obstacle.xMm+obstacle.halfWidth,zMm:obstacle.zMm+obstacle.halfHeight},{xMm:obstacle.xMm-obstacle.halfWidth,zMm:obstacle.zMm+obstacle.halfHeight}];
  const axes:Position[]=[{xMm:1,zMm:0},{xMm:0,zMm:1},...polygon.map((point,index)=>{const end=polygon[(index+1)%polygon.length]!;return {xMm:end.zMm-point.zMm,zMm:point.xMm-end.xMm};})];
  return axes.every(axis=>{const a=polygon.map(point=>point.xMm*axis.xMm+point.zMm*axis.zMm),b=corners.map(point=>point.xMm*axis.xMm+point.zMm*axis.zMm);return Math.min(...a)<Math.max(...b)-EPSILON&&Math.min(...b)<Math.max(...a)-EPSILON;});
}

/** The complete flare and neck footprints, shared by candidate selection and
 * the independent actual-obstacle proof. Bank-edge flares widen only on land. */
export function forestCrossingPolygons(frontier:ForestFrontier,crossing:ForestFrontier['crossings'][number]):Position[][] {
  const half=frontier.depthMm/2,levels=[frontier.coordinateMm-half-crossing.approachMm,frontier.coordinateMm-half,frontier.coordinateMm+half,frontier.coordinateMm+half+crossing.approachMm],widths=[crossing.flareWidthMm,crossing.widthMm,crossing.widthMm,crossing.flareWidthMm],shift=crossing.bankEdge?(crossing.bankEdge==='from'?1:-1)*(crossing.flareWidthMm-crossing.widthMm)/2:0,centers=[crossing.centerMm+shift,crossing.centerMm,crossing.centerMm,crossing.centerMm+shift];
  return Array.from({length:3},(_,segment)=>[perpendicular(frontier,levels[segment]!,centers[segment]!-widths[segment]!/2),perpendicular(frontier,levels[segment+1]!,centers[segment+1]!-widths[segment+1]!/2),perpendicular(frontier,levels[segment+1]!,centers[segment+1]!+widths[segment+1]!/2),perpendicular(frontier,levels[segment]!,centers[segment]!+widths[segment]!/2)]);
}

/** Exact generation-time proof, with bounded work and no runtime navigation work.
 * Count connected gaps in real geometry, not supplied portal labels or multiple
 * formation lanes through one opening. Every closed part of the full-depth strip
 * is tiled by actual rectangle blockers; this rejects even sub-unit cracks. Check
 * whole flared approaches, then retain the separate all-pair broad-route proof. */
export function validateForestFrontiers(input:ForestFrontierValidationInput):ForestFrontierValidationReport {
  const report:ForestFrontierValidationReport={valid:false,verifiedFrontiers:0,verifiedCrossings:0,geometryChecks:0};
  const {widthMm,heightMm,obstacles,frontiers,terrain=[]}=input;
  const rules=balance.maps.forestBelts,unitsPerM=balance.rules.positionUnitsPerM,minimumOpening=balance.maps.naturalBarriers.valleyWidthM*unitsPerM,minimumApproach=rules.approachLengthM*unitsPerM;
  const fail=(failure:ForestFrontierValidationReport['failure'],frontierId?:string):ForestFrontierValidationReport=>({...report,failure,...(frontierId?{frontierId}:{})});
  if(![widthMm,heightMm].every(value=>Number.isFinite(value)&&value>0&&value<=640000)||frontiers.length>32||obstacles.length>MAX_WORLD_ENTITIES+4096||new Set(frontiers.map(frontier=>frontier.id)).size!==frontiers.length||obstacles.some(obstacle=>![obstacle.xMm,obstacle.zMm,obstacle.halfWidth,obstacle.halfHeight].every(Number.isFinite)||Math.abs(obstacle.xMm)>1280000||Math.abs(obstacle.zMm)>1280000||obstacle.halfWidth<=0||obstacle.halfHeight<=0||obstacle.halfWidth>640000||obstacle.halfHeight>640000||(obstacle.circle&&obstacle.halfWidth!==obstacle.halfHeight)))return fail('INVALID_INPUT');
  if(obstacles.reduce((count,obstacle)=>count+(Math.ceil(obstacle.halfWidth/4000)+2)*(Math.ceil(obstacle.halfHeight/4000)+2),0)>1000000)return fail('WORK_LIMIT');
  if(terrain.length>64||terrain.some(region=>![region.xMm,region.zMm,region.widthMm,region.depthMm].every(Number.isFinite)||region.xMm<0||region.zMm<0||region.widthMm<=0||region.depthMm<=0||region.xMm+region.widthMm>widthMm||region.zMm+region.depthMm>heightMm))return fail('INVALID_INPUT');
  const waterGeometry=terrainObstacles(terrain.filter(region=>region.kind==='water'||region.kind==='bridge'));
  const actualObstacles=new Map(obstacles.map(obstacle=>[obstacle.id,obstacle]));
  if(waterGeometry.some(geometry=>{const actual=actualObstacles.get(geometry.id);return !actual||actual.circle||actual.xMm!==geometry.xMm||actual.zMm!==geometry.zMm||actual.halfWidth!==geometry.halfWidth||actual.halfHeight!==geometry.halfHeight;}))return fail('INVALID_INPUT');
  const maximumWork=Math.max(1000000,balance.rules.maxResourceNodes*512);
  const charge=()=>{if(++report.geometryChecks>maximumWork)throw new Error('FOREST_FRONTIER_WORK_LIMIT');};
  const joins=new Map(frontiers.map(frontier=>[frontier,new Set<ForestFrontier>()])),anchored=new Set<ForestFrontier>();
  const nav=new Navigation(widthMm,heightMm,[...obstacles]);
  try {
    for(const frontier of frontiers){
      const {axis,coordinateMm,fromMm,toMm,depthMm}=frontier,normalLimit=axis==='x'?widthMm:heightMm,alongLimit=axis==='x'?heightMm:widthMm,half=depthMm/2;
      const waterAnchor=(endpoint:number,sign:number):boolean=>{
        const river=terrain.some(region=>region.kind==='water'&&(axis==='x'
          ?region.xMm===0&&region.widthMm===widthMm&&Math.abs((sign<0?region.zMm+region.depthMm:region.zMm)-endpoint)<=EPSILON
          :region.zMm===0&&region.depthMm===heightMm&&Math.abs((sign<0?region.xMm+region.widthMm:region.xMm)-endpoint)<=EPSILON));
        if(!river)return false;
        const outside=endpoint+sign*.01,intervals:Interval[]=[];
        for(const obstacle of waterGeometry){charge();const a=axis==='x'?obstacle.zMm:obstacle.xMm,extent=axis==='x'?obstacle.halfHeight:obstacle.halfWidth;if(a-extent<=outside&&a+extent>=outside){const n=axis==='x'?obstacle.xMm:obstacle.zMm,r=axis==='x'?obstacle.halfWidth:obstacle.halfHeight;intervals.push([n-r,n+r]);}}
        return covers(intervals,coordinateMm-half,coordinateMm+half);
      };
      if(!frontier.id||!['x','z'].includes(axis)||![coordinateMm,fromMm,toMm,depthMm].every(Number.isFinite)||depthMm<rules.minimumDepthM*unitsPerM||depthMm>rules.maximumDepthM*unitsPerM||coordinateMm-half<0||coordinateMm+half>normalLimit||fromMm<0||toMm>alongLimit||fromMm>=toMm||frontier.crossings.length<rules.minimumOpenings||frontier.crossings.length>rules.preferredOpenings||frontier.crossings.some(crossing=>![crossing.centerMm,crossing.widthMm,crossing.approachMm,crossing.flareWidthMm].every(Number.isFinite)||crossing.widthMm<=0||crossing.approachMm<minimumApproach||crossing.flareWidthMm<crossing.widthMm+minimumApproach/2||(crossing.bankEdge!==undefined&&!['from','to'].includes(crossing.bankEdge))))return fail('INVALID_INPUT',frontier.id);
      for(const crossing of frontier.crossings)if(crossing.bankEdge){const endpoint=crossing.bankEdge==='from'?fromMm:toMm,sign=crossing.bankEdge==='from'?-1:1;if(Math.abs(crossing.centerMm+sign*crossing.widthMm/2-endpoint)>EPSILON||!waterAnchor(endpoint,sign))return fail('UNANCHORED_END',frontier.id);}
      const openings=frontier.crossings.map(crossing=>[crossing.centerMm-crossing.widthMm/2,crossing.centerMm+crossing.widthMm/2] as const).sort((a,b)=>a[0]-b[0]);
      if(openings.some(([start,end],index)=>start<fromMm||end>toMm||(start===fromMm&&!frontier.crossings.some(crossing=>crossing.bankEdge==='from'&&crossing.centerMm-crossing.widthMm/2===start))||(end===toMm&&!frontier.crossings.some(crossing=>crossing.bankEdge==='to'&&crossing.centerMm+crossing.widthMm/2===end))||(index>0&&start<=openings[index-1]![1])))return fail('OPENING_COUNT',frontier.id);
      if(frontier.crossings.some(crossing=>crossing.widthMm<minimumOpening))return fail('NARROW_OPENING',frontier.id);
      const geometry=obstacles.map(obstacle=>({obstacle,normal:axis==='x'?obstacle.xMm:obstacle.zMm,along:axis==='x'?obstacle.zMm:obstacle.xMm,normalHalf:axis==='x'?obstacle.halfWidth:obstacle.halfHeight,alongHalf:axis==='x'?obstacle.halfHeight:obstacle.halfWidth}));
      const blocked:Interval[]=[];
      for(const rectangle of geometry){
        charge();const offset=Math.abs(rectangle.normal-coordinateMm);let extent=rectangle.alongHalf;
        if(rectangle.obstacle.circle){if(offset>=rectangle.obstacle.halfWidth)continue;extent=Math.sqrt(rectangle.obstacle.halfWidth**2-offset**2);}
        else if(offset>rectangle.normalHalf+EPSILON)continue;
        const start=Math.max(fromMm,rectangle.along-extent),end=Math.min(toMm,rectangle.along+extent);if(start<end)blocked.push([start,end]);
      }
      const actual:Interval[]=[];let cursor=fromMm;
      for(const [start,end] of merged(blocked)){if(start>cursor+EPSILON)actual.push([cursor,start]);cursor=Math.max(cursor,end);}
      if(cursor<toMm-EPSILON)actual.push([cursor,toMm]);
      if(actual.length!==frontier.crossings.length)return fail('OPENING_COUNT',frontier.id);
      if(actual.some(([start,end],index)=>Math.abs(start-openings[index]![0])>EPSILON||Math.abs(end-openings[index]![1])>EPSILON))return fail('OPENING_MISMATCH',frontier.id);
      // Sweep all rectangle boundaries: the active rectangles and complete depth
      // coverage are constant between adjacent event coordinates, so no sampling
      // lattice can miss a tiny unintended seam in the closed forest.
      const events=new Map<number,{enter:number[];leave:number[]}>();
      const event=(along:number)=>{let value=events.get(along);if(!value){value={enter:[],leave:[]};events.set(along,value);}return value;};
      event(fromMm);event(toMm);for(const [start,end] of openings){event(start);event(end);}
      const rectangles=geometry.filter(rectangle=>!rectangle.obstacle.circle&&rectangle.normal+rectangle.normalHalf>=coordinateMm-half&&rectangle.normal-rectangle.normalHalf<=coordinateMm+half);
      rectangles.forEach((rectangle,index)=>{const start=Math.max(fromMm,rectangle.along-rectangle.alongHalf),end=Math.min(toMm,rectangle.along+rectangle.alongHalf);if(start<end){event(start).enter.push(index);event(end).leave.push(index);}});
      const ordered=[...events.keys()].sort((a,b)=>a-b),active=new Set<number>();
      for(let index=0;index<ordered.length-1;index++){
        const start=ordered[index]!,end=ordered[index+1]!,changes=events.get(start)!;
        for(const id of changes.leave)active.delete(id);for(const id of changes.enter)active.add(id);
        if(openings.some(([left,right])=>start>=left&&end<=right))continue;
        const intervals=[...active].map(id=>{charge();const rectangle=rectangles[id]!;return [rectangle.normal-rectangle.normalHalf,rectangle.normal+rectangle.normalHalf] as const;});
        if(!covers(intervals,coordinateMm-half,coordinateMm+half))return fail('INCOMPLETE_BELT',frontier.id);
      }
      // A partition must join another validated frontier or the map boundary.
      // An isolated ridge/cap is not a global anchor: units could simply walk
      // around its far end. Also prove solid geometry just beyond the junction.
      for(const [endpoint,sign] of [[fromMm,-1],[toMm,1]] as const){
        if((sign===-1&&endpoint===0)||(sign===1&&endpoint===alongLimit)){anchored.add(frontier);continue;}
        const parents=frontiers.filter(parent=>parent!==frontier&&(parent.axis===axis
          ?Math.abs(parent.coordinateMm-coordinateMm)<=EPSILON&&(sign===-1?Math.abs(parent.toMm-endpoint):Math.abs(parent.fromMm-endpoint))<=EPSILON
          :Math.abs(parent.coordinateMm-endpoint)<=parent.depthMm/2+EPSILON&&coordinateMm>=parent.fromMm-EPSILON&&coordinateMm<=parent.toMm+EPSILON&&!parent.crossings.some(crossing=>Math.abs(crossing.centerMm-coordinateMm)<crossing.widthMm/2)));
        const onWater=waterAnchor(endpoint,sign);
        if(!parents.length&&!onWater)return fail('UNANCHORED_END',frontier.id);
        if(onWater)anchored.add(frontier);
        for(const parent of parents){joins.get(frontier)!.add(parent);joins.get(parent)!.add(frontier);}
        const outside=endpoint+sign*.01,intervals:Interval[]=[];
        for(const rectangle of rectangles){charge();if(rectangle.along-rectangle.alongHalf<=outside&&rectangle.along+rectangle.alongHalf>=outside)intervals.push([rectangle.normal-rectangle.normalHalf,rectangle.normal+rectangle.normalHalf]);}
        if(!covers(intervals,coordinateMm-half,coordinateMm+half))return fail('UNANCHORED_END',frontier.id);
      }
      for(const crossing of frontier.crossings){
        for(const polygon of forestCrossingPolygons(frontier,crossing)){
          if(polygon.some(point=>point.xMm<0||point.xMm>widthMm||point.zMm<0||point.zMm>heightMm))return fail('OBSTRUCTED_APPROACH',frontier.id);
          const left=Math.min(...polygon.map(point=>point.xMm)),right=Math.max(...polygon.map(point=>point.xMm)),top=Math.min(...polygon.map(point=>point.zMm)),bottom=Math.max(...polygon.map(point=>point.zMm));
          for(const obstacle of obstacles){charge();if(obstacle.xMm+obstacle.halfWidth<=left||obstacle.xMm-obstacle.halfWidth>=right||obstacle.zMm+obstacle.halfHeight<=top||obstacle.zMm-obstacle.halfHeight>=bottom)continue;if(forestApproachOverlapsObstacle(obstacle,polygon))return fail('OBSTRUCTED_APPROACH',frontier.id);}
        }
        charge();if(!nav.clearLine(perpendicular(frontier,coordinateMm-half-crossing.approachMm,crossing.centerMm),perpendicular(frontier,coordinateMm+half+crossing.approachMm,crossing.centerMm),crossing.widthMm/2))return fail('OBSTRUCTED_APPROACH',frontier.id);
        report.verifiedCrossings++;
      }
      report.verifiedFrontiers++;
    }
    // Partition seams connect back to the map boundary. A self-supporting group
    // of finite caps cannot certify an otherwise bypassable island of barriers.
    const queue=[...anchored];for(let cursor=0;cursor<queue.length;cursor++)for(const next of joins.get(queue[cursor]!)!)if(!anchored.has(next)){anchored.add(next);queue.push(next);}
    const isolated=frontiers.find(frontier=>!anchored.has(frontier));if(isolated)return fail('UNANCHORED_END',isolated.id);
    report.valid=true;return report;
  } catch(error){if(error instanceof Error&&error.message==='FOREST_FRONTIER_WORK_LIMIT')return fail('WORK_LIMIT');throw error;}
}
