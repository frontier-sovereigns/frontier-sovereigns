import { describe,expect,it } from 'vitest';
import { validateBroadMapRoutes, type BroadMapRouteInput } from '../src/map-connectivity.js';
import { Navigation,type Obstacle } from '../src/navigation.js';

const rectangle=(id:string,x:number,z:number,width:number,depth:number):Obstacle=>({id,xMm:x*1000,zMm:z*1000,halfWidth:width*500,halfHeight:depth*500});
const settings=(obstacles:Obstacle[]=[]):BroadMapRouteInput=>({widthMm:320000,heightMm:320000,passageWidthMm:32000,obstacles,settlements:[{playerId:'west',xMm:60000,zMm:160000},{playerId:'east',xMm:260000,zMm:160000}]});
const wallWithGap=(gap:number):Obstacle[]=>[rectangle('north',160,(160-gap/2)/2,24,160-gap/2),rectangle('south',160,240+gap/4,24,160-gap/2)];
describe('broad natural map route proof',()=>{
  it('proves two full-width routes around a ridge using real swept geometry',()=>{
    const input=settings([rectangle('ridge',160,160,40,160)]),result=validateBroadMapRoutes(input);
    expect(result.valid).toBe(true);expect(result.pairs).toHaveLength(1);expect(result.pairs[0]!.routeCount).toBe(2);
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    for(const route of result.pairs[0]!.routes)for(let i=1;i<route.length;i++)expect(nav.clearLine(route[i-1]!,route[i]!,16000)).toBe(true);
    expect(result.geometryQueries).toBeLessThan(300000);expect(result.searchNodes).toBeLessThan(5000000);
  });
  it('does not count neighboring grid paths through one 48m choke as two routes',()=>{
    const result=validateBroadMapRoutes(settings(wallWithGap(48)));
    expect(result.valid).toBe(false);expect(result.pairs[0]).toMatchObject({routeCount:1,reason:'NO_INDEPENDENT_ROUTE'});
  });
  it('rejects a 12m gap even though a siege unit can individually pass it',()=>{
    const input=settings(wallWithGap(12)),nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    expect(nav.clearLine(input.settlements[0]!,input.settlements[1]!,850)).toBe(true);
    expect(validateBroadMapRoutes(input).pairs[0]).toMatchObject({routeCount:0,reason:'NO_BROAD_ROUTE'});
  });
  it('accepts a sufficiently broad shared valley carrying two separated formations',()=>{
    expect(validateBroadMapRoutes(settings(wallWithGap(80))).valid).toBe(true);
  });
  it('rejects a figure-eight landscape with loops on either side of one mandatory neck',()=>{
    const input=settings([...wallWithGap(48),rectangle('west-island',110,160,12,64),rectangle('east-island',210,160,12,64)]);
    const result=validateBroadMapRoutes(input);expect(result.valid).toBe(false);expect(result.pairs[0]!.routeCount).toBeLessThan(2);
  });
  it.each(['forest','starting-building'])('includes %s obstructions in the final route proof',id=>{
    const ridge=rectangle('ridge',160,160,40,224),input=settings([ridge]);expect(validateBroadMapRoutes(input).valid).toBe(true);
    input.obstacles=[ridge,rectangle(id,160,24,40,48)];const result=validateBroadMapRoutes(input);
    expect(result.valid).toBe(false);expect(result.pairs[0]!.routeCount).toBe(1);
  });
  it('cannot use a third player settlement as the alternative route',()=>{
    const input=settings([rectangle('ridge',160,160,40,224)]);
    input.settlements=[...input.settlements,{playerId:'north',xMm:160000,zMm:24000}];
    const result=validateBroadMapRoutes(input);expect(result.valid).toBe(false);expect(result.pairs[0]).toMatchObject({fromPlayerId:'west',toPlayerId:'east',routeCount:1});
  });
  it('connects both broad exits to the actual rally without crossing the occupied town center',()=>{
    const input=settings([rectangle('ridge',160,160,40,160),rectangle('town-west',60,160,10,10),rectangle('town-east',260,160,10,10)]);
    input.settlements=input.settlements.map(s=>({...s,origin:{xMm:s.xMm,zMm:s.zMm+12000}}));
    const result=validateBroadMapRoutes(input);expect(result.valid).toBe(true);
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    for(const access of result.pairs[0]!.accessRoutes)for(const [which,index] of [['from',0],['to',1]] as const){
      const route=access[which],settlement=input.settlements[index]!;expect(route[0]).toEqual(settlement.origin);
      for(const point of route)expect(Math.hypot(point.xMm-settlement.xMm,point.zMm-settlement.zMm)).toBeLessThanOrEqual(40000-850);
      for(let i=1;i<route.length;i++)expect(nav.clearLine(route[i-1]!,route[i]!,850)).toBe(true);
    }
  });
  it('fails closed when the rally cannot reach any mouth within its own clearing',()=>{
    const input=settings([rectangle('blocked-origin',60,160,12,12)]),result=validateBroadMapRoutes(input);
    expect(result.valid).toBe(false);expect(result.pairs[0]).toMatchObject({routeCount:0,reason:'NO_BROAD_EXIT'});
  });
  it('is deterministic and rejects invalid/unbounded geometry',()=>{
    const input=settings([rectangle('ridge',160,160,40,160)]);expect(validateBroadMapRoutes(input)).toEqual(validateBroadMapRoutes(input));
    expect(validateBroadMapRoutes({...input,widthMm:Infinity})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
    expect(validateBroadMapRoutes({...input,cellMm:1})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
    expect(validateBroadMapRoutes({...input,settlements:[input.settlements[0]!,{playerId:'overlap',xMm:70000,zMm:160000}]})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
  });
  it('proves all 55 player pairs at the supported eleven-settlement capacity',()=>{
    const input:BroadMapRouteInput={widthMm:640000,heightMm:640000,passageWidthMm:32000,obstacles:[],settlements:Array.from({length:11},(_,i)=>({playerId:`p${i}`,xMm:320000+Math.round(Math.cos(i*Math.PI*2/11)*240000),zMm:320000+Math.round(Math.sin(i*Math.PI*2/11)*240000)}))};
    const result=validateBroadMapRoutes(input);expect(result.valid).toBe(true);expect(result.pairs).toHaveLength(55);expect(result.pairs.every(pair=>pair.routeCount===2)).toBe(true);
    expect(result.geometryQueries).toBeLessThan(300000);expect(result.searchNodes).toBeLessThan(5000000);
  });
  it.each(['near','far'] as const)('shares generation corridor reservations with %s ordering while retaining all eleven-home route proofs',sharedCorridorOrder=>{
    const input:BroadMapRouteInput={widthMm:640000,heightMm:640000,passageWidthMm:32000,obstacles:[],settlements:Array.from({length:11},(_,i)=>({playerId:`p${i}`,xMm:320000+Math.round(Math.cos(i*Math.PI*2/11)*240000),zMm:320000+Math.round(Math.sin(i*Math.PI*2/11)*240000)}))};
    const ordinary=validateBroadMapRoutes(input),shared=validateBroadMapRoutes({...input,preferSharedCorridors:true,sharedCorridorOrder});
    expect(shared.valid).toBe(true);expect(shared.pairs).toHaveLength(55);expect(shared.pairs.every(pair=>pair.routeCount===2)).toBe(true);
    const area=(report:typeof shared)=>{const cells=new Set<string>();for(const pair of report.pairs)for(const path of pair.routes)for(let i=1;i<path.length;i++){const a=path[i-1]!,b=path[i]!;for(let z=Math.floor((Math.min(a.zMm,b.zMm)-16000)/3000);z<=Math.ceil((Math.max(a.zMm,b.zMm)+16000)/3000);z++)for(let x=Math.floor((Math.min(a.xMm,b.xMm)-16000)/3000);x<=Math.ceil((Math.max(a.xMm,b.xMm)+16000)/3000);x++)cells.add(`${x}:${z}`);}return cells.size;};
    expect(area(shared)).toBeLessThan(area(ordinary));expect(shared.searchNodes).toBeLessThan(5000000);
    // Generation preference cannot turn a single narrow crossing into two.
    expect(validateBroadMapRoutes({...settings(wallWithGap(48)),preferSharedCorridors:true,sharedCorridorOrder}).valid).toBe(false);
  });
  it('finds a side route when the shortest witness cuts off the alternative at a clearing',()=>{
    // Reduced from the eleven-faction landscape: changing endpoint mouths alone
    // still chose a central shortest witness and incorrectly rejected this layout.
    const input:BroadMapRouteInput={widthMm:640000,heightMm:640000,passageWidthMm:32000,settlements:[
      {playerId:'east',xMm:600000,zMm:44000,origin:{xMm:600000,zMm:56000},clearanceRadiusMm:56000},
      {playerId:'west',xMm:42000,zMm:44000,origin:{xMm:42000,zMm:56000},clearanceRadiusMm:56000},
    ],obstacles:[
      {id:'east-blocker',xMm:600000,zMm:202000,halfWidth:56000,halfHeight:56000,circle:true},
      {id:'north-blocker',xMm:202000,zMm:44000,halfWidth:56000,halfHeight:56000,circle:true},
    ]};
    const result=validateBroadMapRoutes(input);expect(result.valid).toBe(true);expect(result.pairs[0]!.routeCount).toBe(2);
    const nav=new Navigation(input.widthMm,input.heightMm,[...input.obstacles]);
    for(const route of result.pairs[0]!.routes)for(let i=1;i<route.length;i++)expect(nav.clearLine(route[i-1]!,route[i]!,16000)).toBe(true);
  });
  it('refines shared roads without losing any full-width proof or accepting a narrow sole crossing',()=>{
    const input:BroadMapRouteInput={widthMm:640000,heightMm:640000,passageWidthMm:32000,obstacles:[],preferSharedCorridors:true,sharedCorridorOrder:'far',refineSharedCorridors:true,settlements:Array.from({length:11},(_,i)=>({playerId:`p${i}`,xMm:320000+Math.round(Math.cos(i*Math.PI*2/11)*240000),zMm:320000+Math.round(Math.sin(i*Math.PI*2/11)*240000)}))};
    const result=validateBroadMapRoutes(input),nav=new Navigation(input.widthMm,input.heightMm,[]);
    expect(result.valid).toBe(true);expect(result.pairs).toHaveLength(55);expect(result.pairs.every(pair=>pair.routeCount===2)).toBe(true);expect(result.searchNodes).toBeLessThanOrEqual(5000000);
    for(const pair of result.pairs)for(const route of pair.routes)for(let i=1;i<route.length;i++)expect(nav.clearLine(route[i-1]!,route[i]!,16000)).toBe(true);
    expect(validateBroadMapRoutes({...settings(wallWithGap(48)),preferSharedCorridors:true,sharedCorridorOrder:'far',refineSharedCorridors:true}).valid).toBe(false);
  });
  it('treats prepaid passage land only as a preference and validates its bounded mask',()=>{
    const input=settings(wallWithGap(48)),cells=new Uint8Array(Math.floor(input.widthMm/3000)*Math.floor(input.heightMm/3000)).fill(1);
    expect(validateBroadMapRoutes({...input,preferSharedCorridors:true,refineSharedCorridors:true,sharedCorridorSeed:{cellMm:3000,cells}}).valid).toBe(false);
    expect(validateBroadMapRoutes({...input,sharedCorridorSeed:{cellMm:3000,cells:cells.subarray(1)}})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
    cells[0]=2;expect(validateBroadMapRoutes({...input,sharedCorridorSeed:{cellMm:3000,cells}})).toMatchObject({valid:false,failure:'INVALID_INPUT'});
  });
});
