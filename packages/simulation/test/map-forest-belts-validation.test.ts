import { describe,expect,it } from 'vitest';
import { terrainObstacles,type TerrainRegion } from '@frontier/shared';
import { validateForestFrontiers,type ForestFrontier,type ForestFrontierValidationInput } from '../src/map-forest-belts-validation.js';
import { validateBroadMapRoutes } from '../src/map-connectivity.js';
import { Navigation,type Obstacle } from '../src/navigation.js';

const rect=(id:string,left:number,top:number,right:number,bottom:number):Obstacle=>({id,xMm:(left+right)*500,zMm:(top+bottom)*500,halfWidth:(right-left)*500,halfHeight:(bottom-top)*500});
const crossing=(center:number,width=48)=>({centerMm:center*1000,widthMm:width*1000,approachMm:24000,flareWidthMm:(width+12)*1000});
const frontier=(centers=[72,312]):ForestFrontier=>({id:'rival-boundary',axis:'x',coordinateMm:192000,fromMm:0,toMm:384000,depthMm:24000,crossings:centers.map(center=>crossing(center))});
function settings(centers=[72,312]):ForestFrontierValidationInput {
  const layout=frontier(centers),obstacles:Obstacle[]=[];
  // Real touching 3m tree cells, rather than an abstract forest hull. The proof
  // must survive task patch boundaries without inventing passage between trunks.
  for(let z=0;z<384;z+=3)for(let x=180;x<204;x+=3)if(!centers.some(center=>z>=center-24&&z<center+24))obstacles.push(rect(`tree-${x}-${z}`,x,z,x+3,z+3));
  return {widthMm:384000,heightMm:384000,obstacles,frontiers:[layout]};
}
const wall=()=>[rect('north',180,0,204,48),rect('middle',180,96,204,288),rect('south',180,336,204,384)];

describe('distinct forest-frontier crossing proof',()=>{
  it.each([{centers:[72,312]},{centers:[72,192,312]}])('proves separate wide openings and full-depth touching forest cells ($centers)',({centers})=>{
    const input=settings(centers),report=validateForestFrontiers(input);
    expect(report).toMatchObject({valid:true,verifiedFrontiers:1,verifiedCrossings:centers.length});
    expect(report.geometryChecks).toBeLessThan(1000000);
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    for(const center of centers)for(const radius of [400,550,850,24000])expect(nav.clearLine({xMm:156000,zMm:center*1000},{xMm:228000,zMm:center*1000},radius)).toBe(true);
  });
  it('does not count two labeled lanes through one wide opening as distinct crossings',()=>{
    const input=settings();input.obstacles=[rect('north',180,0,204,48),rect('south',180,336,204,384)];
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'OPENING_COUNT'});
  });
  it('rejects an extra narrow crack that a normal unit could use',()=>{
    const input=settings();input.obstacles=[rect('north-a',180,0,204,12),rect('north-b',180,13,204,48),...wall().slice(1)];
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    expect(nav.clearLine({xMm:168000,zMm:12500},{xMm:216000,zMm:12500},400)).toBe(true);
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'OPENING_COUNT'});
  });
  it('rejects a belt with less than its promised depth even if the seam stays closed',()=>{
    const input=settings();input.obstacles=input.obstacles.filter(obstacle=>obstacle.id!=='tree-180-12');
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'INCOMPLETE_BELT'});
  });
  it('rejects narrower crossings and falsely declared portal widths',()=>{
    const input=settings();input.frontiers=[{...frontier(),crossings:[crossing(72,42),crossing(312)]}];
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'NARROW_OPENING'});
    input.frontiers=[{...frontier(),crossings:[crossing(72,54),crossing(312)]}];
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'OPENING_MISMATCH'});
  });
  it.each([false,true])('checks the entire flared approach, including a blocker outside the center sweep (circle=%s)',circle=>{
    const input=settings(),blocker=rect('approach-blocker',157,99,159,101);if(circle)blocker.circle=true;
    input.obstacles=[...input.obstacles,blocker];
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    expect(nav.clearLine({xMm:156000,zMm:72000},{xMm:228000,zMm:72000},24000)).toBe(true);
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'OBSTRUCTED_APPROACH'});
  });
  it('rejects an unanchored segment end while accepting a solid parent-belt junction',()=>{
    const input=settings();input.frontiers=[{...frontier(),fromMm:6000}];input.obstacles=[rect('north',180,6,204,48),...wall().slice(1)];
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'UNANCHORED_END'});
    const joined:ForestFrontier={id:'child',axis:'z',coordinateMm:192000,fromMm:0,toMm:192000,depthMm:24000,crossings:[crossing(48),crossing(120)]};
    input.frontiers=[frontier(),joined];input.obstacles=[...wall(),rect('child-west',0,180,24,204),rect('child-middle',72,180,96,204),rect('child-east',144,180,192,204)];
    expect(validateForestFrontiers(input)).toMatchObject({valid:true,verifiedFrontiers:2,verifiedCrossings:4});
  });
  it('does not accept a finite cap as an anchor when units can walk around it',()=>{
    const input=settings();input.frontiers=[{...frontier(),fromMm:6000}];
    input.obstacles=[rect('north',180,6,204,48),...wall().slice(1),rect('misleading-cap',180,5.9,204,6.1)];
    expect(validateForestFrontiers(input)).toMatchObject({valid:false,failure:'UNANCHORED_END'});
  });
  it('joins an L at a real full-depth corner while rejecting missing corners and finite capped arms',()=>{
    const north:ForestFrontier={...frontier([48,120]),id:'north-arm',toMm:192000};
    const west:ForestFrontier={id:'west-arm',axis:'z',coordinateMm:192000,fromMm:0,toMm:192000,depthMm:24000,crossings:[crossing(48),crossing(120)]};
    const input:ForestFrontierValidationInput={widthMm:384000,heightMm:384000,frontiers:[north,west],obstacles:[
      ...[[0,24],[72,96],[144,192]].map(([from,to],index)=>rect(`north-${index}`,180,from!,204,to!)),
      ...[[0,24],[72,96],[144,192]].map(([from,to],index)=>rect(`west-${index}`,from!,180,to!,204)),
      rect('full-depth-corner',180,180,204,204),
    ]};
    expect(validateForestFrontiers(input)).toMatchObject({valid:true,verifiedFrontiers:2,verifiedCrossings:4});
    expect(validateForestFrontiers({...input,obstacles:input.obstacles.filter(obstacle=>obstacle.id!=='full-depth-corner')})).toMatchObject({valid:false,failure:'UNANCHORED_END'});
    // Merely being half a strip away is not an anchor. Generation must extend
    // its metadata into the actual solid corner, preserving strict joins.
    expect(validateForestFrontiers({...input,frontiers:[north,{...west,toMm:180000}]})).toMatchObject({valid:false,failure:'UNANCHORED_END'});
    const finite={...input,frontiers:input.frontiers.map(arm=>({...arm,fromMm:6000})),obstacles:[...input.obstacles.filter(obstacle=>!['north-0','west-0'].includes(obstacle.id)),rect('north-0',180,6,204,24),rect('west-0',6,180,24,204),rect('north-cap',180,5.9,204,6.1),rect('west-cap',5.9,180,6.1,204)]};
    expect(validateForestFrontiers(finite)).toMatchObject({valid:false,failure:'UNANCHORED_END'});
  });
  it('proves separate crossings on every final neighboring border through a closed T junction',()=>{
    const north:ForestFrontier={...frontier([48,120]),id:'north-border',coordinateMm:144000,toMm:192000};
    const south:ForestFrontier={...frontier([264,336]),id:'south-border',coordinateMm:144000,fromMm:192000};
    const child:ForestFrontier={id:'west-border',axis:'z',coordinateMm:192000,fromMm:0,toMm:132000,depthMm:24000,crossings:[crossing(33),crossing(99)]};
    const input:ForestFrontierValidationInput={widthMm:384000,heightMm:384000,frontiers:[north,south,child],obstacles:[
      ...[[0,24],[72,96],[144,240],[288,312],[360,384]].map(([from,to],index)=>rect(`parent-${index}`,132,from!,156,to!)),
      ...[[0,9],[57,75],[123,132]].map(([from,to],index)=>rect(`child-${index}`,from!,180,to!,204)),
    ]};
    expect(validateForestFrontiers(input)).toMatchObject({valid:true,verifiedFrontiers:3,verifiedCrossings:6});
  });
  it.each(['from','to'] as const)('counts a 48m bank lane with a flare toward land at a proved river edge (%s)',bankEdge=>{
    const terrain:TerrainRegion[]=[{id:'river',kind:'water',xMm:186000,zMm:0,widthMm:12000,depthMm:384000,elevationMm:-1500}];
    const side:ForestFrontier={id:'bank',axis:'z',coordinateMm:192000,fromMm:bankEdge==='from'?198000:0,toMm:bankEdge==='from'?384000:186000,depthMm:24000,crossings:bankEdge==='from'?[{...crossing(222),bankEdge},crossing(312)]:[crossing(48),{...crossing(162),bankEdge}]};
    const cells=bankEdge==='from'?[[246,288],[336,384]]:[[0,24],[72,138]];
    const input:ForestFrontierValidationInput={widthMm:384000,heightMm:384000,frontiers:[side],terrain,obstacles:[...terrainObstacles(terrain),...cells.map(([from,to],index)=>rect(`trees-${index}`,from!,180,to!,204))]};
    expect(validateForestFrontiers(input)).toMatchObject({valid:true,verifiedFrontiers:1,verifiedCrossings:2});
    const unmarked=structuredClone(input);delete unmarked.frontiers[0]!.crossings.find(crossing=>crossing.bankEdge)!.bankEdge;
    expect(validateForestFrontiers(unmarked)).toMatchObject({valid:false,failure:'OPENING_COUNT'});
    const finite=structuredClone(input);finite.terrain=[{...terrain[0]!,zMm:100000,depthMm:180000}];finite.obstacles=[...terrainObstacles(finite.terrain),...input.obstacles.filter(obstacle=>obstacle.id.startsWith('trees-'))];
    expect(validateForestFrontiers(finite)).toMatchObject({valid:false,failure:'UNANCHORED_END'});
    const bridge=structuredClone(input);bridge.terrain=[...terrain,{id:'bridge',kind:'bridge',xMm:184000,zMm:180000,widthMm:16000,depthMm:24000,elevationMm:0}];bridge.obstacles=[...terrainObstacles(bridge.terrain),...input.obstacles.filter(obstacle=>obstacle.id.startsWith('trees-'))];
    expect(validateForestFrontiers(bridge)).toMatchObject({valid:false,failure:'UNANCHORED_END'});
    expect(validateForestFrontiers({...input,obstacles:input.obstacles.filter(obstacle=>obstacle.id.startsWith('trees-'))})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
  });
  it('keeps the independent all-pair formation proof in addition to the opening count',()=>{
    const input=settings();expect(validateForestFrontiers(input).valid).toBe(true);
    const routes=validateBroadMapRoutes({...input,passageWidthMm:32000,settlements:[{playerId:'west',xMm:60000,zMm:192000},{playerId:'east',xMm:324000,zMm:192000}]});
    expect(routes.valid).toBe(true);expect(routes.pairs[0]!.routeCount).toBe(2);
  });
  it('is deterministic, does not change the map, and fails closed on invalid input',()=>{
    const input=settings(),before=structuredClone(input),first=validateForestFrontiers(input);expect(validateForestFrontiers(input)).toEqual(first);expect(input).toEqual(before);
    expect(validateForestFrontiers({...input,widthMm:Infinity})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
    expect(validateForestFrontiers({...input,frontiers:[{...frontier(),depthMm:15000}]})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
    expect(validateForestFrontiers({...input,frontiers:[{...frontier(),crossings:[crossing(72)]}]})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
  });
});
