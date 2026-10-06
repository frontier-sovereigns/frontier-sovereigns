import { describe,expect,it } from 'vitest';
import { balance,units,type PublicPlayer } from '@frontier/shared';
import { forestCandidates,forestClearingComponents,proveForestClearing,resourceWorkBounds,resourceWorkPoints } from '../src/forest-navigation.js';
import { Navigation,type Obstacle } from '../src/navigation.js';
import { generateMap,MAP_GENERATOR_VERSION } from '../src/map.js';

const cellMm=balance.maps.forestNavigationCellM*balance.rules.positionUnitsPerM;
const workerRadius=units.villager.collisionRadiusM*balance.rules.positionUnitsPerM;
function patch(columns=6,rows=5){return Array.from({length:columns*rows},(_,index)=>({id:`tree_${index}`,resource:'wood' as const,amount:100,xMm:16000+index%columns*cellMm,zMm:16000+Math.floor(index/columns)*cellMm,forest:{patchId:'forest_a',cellMm}}));}
const obstacles=(nodes:ReturnType<typeof patch>):Obstacle[]=>nodes.filter(node=>node.amount>0).map(node=>({id:node.id,xMm:node.xMm,zMm:node.zMm,...resourceWorkBounds(node)}));

describe('authored forest occupancy and accessible work edges',()=>{
  it('closes internal tree gaps while sparse trees keep their trunk footprint',()=>{
    const nodes=patch(),nav=new Navigation(60000,60000,obstacles(nodes));
    expect(resourceWorkBounds({resource:'wood'})).toEqual({halfWidth:450,halfHeight:450});
    expect(resourceWorkBounds({resource:'gold'})).toEqual({halfWidth:650,halfHeight:650});
    expect(nav.free({xMm:17500,zMm:17500},workerRadius)).toBe(false);
    expect(nav.clearLine({xMm:8000,zMm:19000},{xMm:40000,zMm:19000},workerRadius)).toBe(false);
    const edge=nodes[0]!,interior=nodes[14]!;
    expect(resourceWorkPoints(edge,workerRadius).some(point=>nav.free(point,workerRadius))).toBe(true);
    expect(resourceWorkPoints(interior,workerRadius).some(point=>nav.free(point,workerRadius))).toBe(false);
  });
  it('opens only depleted cells and preserves all previously legal positions and a cleared passage',()=>{
    const nodes=patch(),before=new Navigation(60000,60000,obstacles(nodes)),samples=[];
    for(let z=8000;z<=38000;z+=1000)for(let x=8000;x<=40000;x+=1000){const point={xMm:x,zMm:z};if(before.free(point,workerRadius))samples.push(point);}
    const crossing={from:{xMm:22000,zMm:9000},to:{xMm:22000,zMm:37000}};
    expect(before.clearLine(crossing.from,crossing.to,workerRadius)).toBe(false);
    for(let row=0;row<5;row++)nodes[row*6+2]!.amount=0;
    const after=new Navigation(60000,60000,obstacles(nodes));
    expect(samples.every(point=>after.free(point,workerRadius))).toBe(true);
    expect(after.clearLine(crossing.from,crossing.to,units.trebuchet.collisionRadiusM*1000)).toBe(true);
    expect(after.free(nodes[13]!,workerRadius)).toBe(false);
  });
  it.each([2000,4000])('preserves an authored offset %i mm corridor without merging adjacent patches',gap=>{
    const nodes=patch(1,4),other=nodes.map((node,index)=>({...node,id:`other_${index}`,xMm:node.xMm+cellMm+gap,forest:{patchId:'forest_b',cellMm}}));
    const nav=new Navigation(60000,60000,obstacles([...nodes,...other])),xMm=nodes[0]!.xMm+cellMm/2+gap/2;
    expect(nav.clearLine({xMm,zMm:9000},{xMm,zMm:32000},units.trebuchet.collisionRadiusM*1000)).toBe(true);
  });
  it('ignores only the worked tree cell and still rejects a wall across its contact gap',()=>{
    const node=patch(1,1)[0]!,point=resourceWorkPoints(node,workerRadius)[0]!,surface={xMm:node.xMm-cellMm/2,zMm:node.zMm};
    const tree=obstacles([node]),nav=new Navigation(60000,60000,tree);
    expect(nav.free(point,workerRadius)).toBe(true);expect(nav.clearLine(point,surface,0,node.id)).toBe(true);
    const wall={id:'wall',xMm:(point.xMm+surface.xMm)/2,zMm:surface.zMm,halfWidth:50,halfHeight:2000};
    expect(new Navigation(60000,60000,[...tree,wall]).clearLine(point,surface,0,node.id)).toBe(false);
  });
  it('proves every wood cell through legal reversible frontier paths without removing a real tree',()=>{
    const nodes=patch(),before=structuredClone(nodes),solid=obstacles(nodes),start={xMm:7000,zMm:7000};
    const sequence=proveForestClearing(60000,60000,solid,nodes,start,workerRadius);
    expect(sequence).toHaveLength(nodes.length);expect(new Set(sequence).size).toBe(nodes.length);expect(nodes).toEqual(before);
    const removed=new Set<string>();
    for(const id of sequence!){
      const node=nodes.find(node=>node.id===id)!,nav=new Navigation(60000,60000,solid.filter(obstacle=>!removed.has(obstacle.id)));
      expect(resourceWorkPoints(node,workerRadius).some(point=>nav.path(start,point,workerRadius)!==null)).toBe(true);removed.add(id);
    }
    const sealed=[...solid,{id:'left',xMm:11000,zMm:22000,halfWidth:1000,halfHeight:13000},{id:'right',xMm:36000,zMm:22000,halfWidth:1000,halfHeight:13000},{id:'top',xMm:23500,zMm:10000,halfWidth:13500,halfHeight:1000},{id:'bottom',xMm:23500,zMm:34000,halfWidth:13500,halfHeight:1000}];
    expect(proveForestClearing(60000,60000,sealed,nodes,start,workerRadius)).toBeNull();
  });
  it('chooses only positive disclosed members of the intended patch within its bound',()=>{
    const nodes=patch(),target=nodes[14]!,foreign={...nodes[0]!,id:'foreign',xMm:nodes[0]!.xMm-6000,forest:{patchId:'forest_b',cellMm}},distant={...nodes[1]!,id:'distant',xMm:target.xMm+31000},empty={...nodes[2]!,id:'empty',amount:0};
    const known=[nodes[0]!,nodes[14]!,foreign,distant,empty],candidates=forestCandidates(known,target,{xMm:0,zMm:0});
    expect(candidates.map(node=>node.id)).toEqual([nodes[0]!.id,nodes[14]!.id]);
    expect(candidates).not.toContain(nodes[1]);expect(known).toHaveLength(5);
  });
  it('follows touching disclosed patch identities without admitting an unseen bridge or unrelated forest',()=>{
    const target=patch(1,1)[0]!,neighbor={...target,id:'neighbor',xMm:19000,forest:{patchId:'neighbor_patch',cellMm}},fragment={...neighbor,id:'fragment',xMm:25000};
    const unrelated={...neighbor,id:'unrelated',xMm:31000,forest:{patchId:'unrelated_patch',cellMm}},hiddenBridge={...unrelated,id:'hidden_bridge',xMm:28000},distant={...neighbor,id:'distant',xMm:target.xMm+31000};
    const known=[target,neighbor,fragment,unrelated,distant],before=structuredClone(known);
    expect(forestCandidates(known,target,target).map(node=>node.id)).toEqual([target.id,neighbor.id,fragment.id]);
    expect(forestCandidates([...known,hiddenBridge],target,target).map(node=>node.id)).toContain(unrelated.id);
    expect(forestCandidates([{...target,amount:0},neighbor,fragment,unrelated],{...target,amount:0},target).map(node=>node.id)).toEqual([neighbor.id,fragment.id]);
    expect(known).toEqual(before);
  });
  it('checks local clearing paths in world coordinates and leaves neighboring patches solid',()=>{
    const nodes=patch(3,3).map(node=>({...node,xMm:node.xMm+100000,zMm:node.zMm+100000})),solid=obstacles(nodes),before=structuredClone(solid),start={xMm:107000,zMm:107000};
    let checked=0;
    expect(proveForestClearing(640000,640000,solid,nodes,start,workerRadius,path=>{checked++;return path.every(point=>point.xMm>100000&&point.zMm>100000);})).toHaveLength(nodes.length);
    expect(checked).toBeGreaterThan(0);expect(solid).toEqual(before);
    const center={...nodes[4]!,forest:{patchId:'separate_patch',cellMm}};
    expect(proveForestClearing(640000,640000,solid,[center],start,workerRadius)).toBeNull();
    expect(proveForestClearing(640000,640000,solid,nodes,start,workerRadius,()=>false)).toBeNull();
  });
  it('retains whole-map detours when the nearby crop has no accessible approach',()=>{
    const nodes=patch(1,1),wall={id:'long_wall',xMm:12000,zMm:20000,halfWidth:1000,halfHeight:20000},solid=[...obstacles(nodes),wall],start={xMm:7000,zMm:7000};
    let outsideCrop=false;
    const sequence=proveForestClearing(60000,60000,solid,nodes,start,workerRadius,path=>{outsideCrop ||= path.some(point=>point.zMm>40000);return true;});
    expect(sequence).toEqual([nodes[0]!.id]);expect(outsideCrop).toBe(true);
  });
  it('includes blockers crossing the crop boundary even when their centers lie outside it',()=>{
    const nodes=patch(1,1).map(node=>({...node,xMm:node.xMm+100000,zMm:node.zMm+100000})),start={xMm:107000,zMm:107000};
    const cover={id:'cover_from_outside',xMm:160000,zMm:116000,halfWidth:46000,halfHeight:3000};
    expect(proveForestClearing(640000,640000,[...obstacles(nodes),cover],nodes,start,workerRadius)).toBeNull();
  });
  it('groups touching physical forests across patch identities without bridging a real gap',()=>{
    const nodes=patch(3,3).map((node,index)=>({...node,forest:{patchId:`patch_${index}`,cellMm}})),before=structuredClone(nodes),last=nodes.at(-1)!;
    const apart={...last,id:'apart',xMm:last.xMm+cellMm+1},empty={...nodes[0]!,id:'empty',amount:0},gold={...nodes[0]!,id:'gold',resource:'gold' as const};
    expect(forestClearingComponents([...nodes,apart,empty,gold]).map(component=>component.map(node=>node.id))).toEqual([nodes.map(node=>node.id),['apart']]);
    expect(nodes).toEqual(before);
    expect(()=>forestClearingComponents(Array.from({length:balance.rules.maxResourceNodes+1},()=>nodes[0]!))).toThrow('FOREST_COMPONENT_LIMIT');
    expect(()=>forestClearingComponents([{...nodes[0]!,forest:{patchId:'oversized',cellMm:Number.MAX_SAFE_INTEGER}}])).toThrow('INVALID_FOREST_CELL_GEOMETRY');
  });
  it('peels buried task patches only through a legal physical-component clearing sequence',()=>{
    const nodes=patch(8,8).map((node,index)=>({...node,forest:{patchId:index===27||index===28||index===35||index===36?'buried':`border_${Math.floor(index/16)}`,cellMm}})),solid=obstacles(nodes),start={xMm:7000,zMm:7000};
    const buried=nodes.filter(node=>node.forest.patchId==='buried');
    expect(proveForestClearing(60000,60000,solid,buried,start,workerRadius)).toBeNull();
    const components=forestClearingComponents(nodes);expect(components).toHaveLength(1);
    const sequence=proveForestClearing(60000,60000,solid,components[0]!,start,workerRadius);
    expect(sequence).toHaveLength(nodes.length);expect(new Set(sequence).size).toBe(nodes.length);
    const removed=new Set<string>();
    for(const id of sequence!){
      const node=nodes.find(node=>node.id===id)!,nav=new Navigation(60000,60000,solid.filter(obstacle=>!removed.has(obstacle.id))),bounds=resourceWorkBounds(node);
      expect(resourceWorkPoints(node,workerRadius).some(point=>{
        const surface={xMm:Math.max(node.xMm-bounds.halfWidth,Math.min(node.xMm+bounds.halfWidth,point.xMm)),zMm:Math.max(node.zMm-bounds.halfHeight,Math.min(node.zMm+bounds.halfHeight,point.zMm))};
        return nav.free(point,workerRadius)&&nav.clearLine(point,surface,0,node.id)&&nav.path(start,point,workerRadius)!==null;
      })).toBe(true);
      removed.add(id);
    }
  });
  it.each(['open_frontier','river_divide'] as const)('generates %s with bounded forest identity, unchanged starting wood and qualified edge travel',mapType=>{
    const factions:PublicPlayer[]=Array.from({length:2},(_,index)=>({id:`p${index}`,name:`Player ${index}`,kind:'human',teamId:`t${index}`,color:'#3388ff'}));
    const map=generateMap({seed:'forest-rules',factions,mapType});
    expect(map.generatorVersion).toBe(MAP_GENERATOR_VERSION);expect(map.generatorVersion).toBe('7.0.1');
    expect(map.resources.filter(node=>node.resource==='wood').every(node=>node.forest?.cellMm===cellMm)).toBe(true);
    expect(map.resources.filter(node=>node.resource!=='wood').every(node=>!node.forest)).toBe(true);
    for(const report of map.validation.spawnReports){expect(report.resources.wood).toBe(balance.maps.spawnResourceMinimum.wood);expect(report.travelMm.wood).toBeLessThanOrEqual(30000);}
    expect(map.validation.travelVariation.wood).toBeLessThanOrEqual(balance.maps.startingTravelVariationFraction);
  });
});
