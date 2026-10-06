import { describe, expect, it } from 'vitest';
import { balance, validateContent } from './content.js';
import { placementAreaVisible, placementAreaDiscovered, resourcePlacementBounds, ridgeHeightAt, terrainBuildable, terrainHeightAt, terrainLineOfSight, terrainObstacles, terrainVisionBlockers, type TerrainRegion } from './terrain.js';

describe('Construction resource clearance',()=>{
  it('allows discovered sites to touch impassable mountain faces without exploring the mountain halo',()=>{
    const site={xMm:8000,zMm:8000,widthMm:2000,depthMm:2000},mountain:TerrainRegion={id:'mountain',kind:'ridge',xMm:10000,zMm:0,widthMm:10000,depthMm:20000,elevationMm:5000};
    const discovered=(x:number)=>x<10000;
    expect(placementAreaVisible(site,20000,20000,2000,3200,discovered)).toBe(false);
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,discovered,[mountain])).toBe(true);
    expect(terrainBuildable([mountain],site)).toBe(true);
    expect(terrainBuildable([mountain],{...site,xMm:8001})).toBe(false);
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,()=>false,[mountain])).toBe(false);
  });
  it('does not excuse an unexplored gap, partial mountain cell, bridge or ramp in a planned-site halo',()=>{
    const site={xMm:8000,zMm:8000,widthMm:2000,depthMm:2000},barrier:TerrainRegion={id:'barrier',kind:'cliff',xMm:10000,zMm:0,widthMm:10000,depthMm:20000,elevationMm:5000},known=(x:number)=>x<10000;
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,known,[{...barrier,xMm:10001}])).toBe(false);
    const passage:TerrainRegion={id:'passage',kind:'ramp',xMm:10000,zMm:8000,widthMm:10000,depthMm:2000,axis:'x',startElevationMm:0,endElevationMm:5000};
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,known,[barrier,passage])).toBe(false);
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,known,[{...barrier,kind:'water'},{...barrier,id:'bridge',kind:'bridge',zMm:8000,depthMm:2000}])).toBe(false);
    expect(placementAreaDiscovered(site,20000,20000,2000,3200,known,[{...barrier,widthMm:1000},{...barrier,id:'next',xMm:11000,widthMm:9000}])).toBe(true);
  });
  it('covers tree canopies without shrinking dense forest cells and protects other resource art',()=>{
    expect(resourcePlacementBounds({resource:'wood'},3200)).toEqual({halfWidth:3200,halfHeight:3200});
    expect(resourcePlacementBounds({resource:'wood',forest:{cellMm:8000}},3200)).toEqual({halfWidth:4000,halfHeight:4000});
    for(const resource of ['food','gold','stone'])expect(resourcePlacementBounds({resource},3200)).toEqual({halfWidth:3200,halfHeight:3200});
  });
  it('requires every resource construction exclusion to remain inside the observed placement halo',()=>{
    const content=structuredClone(balance);content.rules.nonTreeBuildingClearanceM=content.rules.treeBuildingClearanceM+.001;
    expect(()=>validateContent(content)).toThrow('Resource construction clearance exceeds observed placement halo');
    content.rules.nonTreeBuildingClearanceM=0;expect(()=>validateContent(content)).toThrow('Invalid content structure');
  });
  it('checks every halo cell including unaligned edges, clipping only at the map boundary',()=>{
    const points:number[][]=[];
    expect(placementAreaVisible({xMm:0,zMm:2000,widthMm:4000,depthMm:4000},20000,20000,2000,3200,(x,z)=>{points.push([x,z]);return true;})).toBe(true);
    expect(points).toHaveLength(20);expect(points.every(([x,z])=>x!>=0&&z!>=0)).toBe(true);
    expect(points).toContainEqual([7000,9000]);
    expect(placementAreaVisible({xMm:0,zMm:2000,widthMm:4000,depthMm:4000},20000,20000,2000,3200,(x,z)=>x!==7000||z!==9000)).toBe(false);
  });
});

const cliff:TerrainRegion={id:'ridge',kind:'cliff',xMm:10000,zMm:0,widthMm:2000,depthMm:20000,elevationMm:6000};
describe('Public terrain line of sight',()=>{
  it('conceals points beyond an impassable cliff while retaining points on the near side',()=>{
    const blockers=terrainVisionBlockers([cliff]),observer={xMm:5000,zMm:10000};
    expect(terrainLineOfSight(blockers,observer,{xMm:9000,zMm:10000})).toBe(true);
    expect(terrainLineOfSight(blockers,observer,{xMm:20000,zMm:10000})).toBe(false);
    expect(terrainLineOfSight(blockers,{xMm:20000,zMm:10000},observer)).toBe(false);
  });
  it('allows sight through the actual ramp gap, preserving adjacent cliff occlusion',()=>{
    const ramp:TerrainRegion={id:'gap',kind:'ramp',xMm:9000,zMm:8000,widthMm:4000,depthMm:4000,axis:'x',startElevationMm:0,endElevationMm:6000};
    const blockers=terrainVisionBlockers([cliff,ramp]);
    expect(terrainLineOfSight(blockers,{xMm:5000,zMm:10000},{xMm:20000,zMm:10000})).toBe(true);
    expect(terrainLineOfSight(blockers,{xMm:5000,zMm:5000},{xMm:20000,zMm:5000})).toBe(false);
  });
  it('does not treat open water, bridges or gentle hills as vision blockers',()=>{
    const terrain:TerrainRegion[]=[{...cliff,id:'river',kind:'water',elevationMm:-1000},{...cliff,id:'hill',kind:'hill',elevationMm:2000},{...cliff,id:'bridge',kind:'bridge',elevationMm:0}];
    expect(terrainVisionBlockers(terrain)).toEqual([]);
    expect(terrainLineOfSight(terrainVisionBlockers(terrain),{xMm:5000,zMm:10000},{xMm:20000,zMm:10000})).toBe(true);
  });
  it('handles diagonal and axis-aligned rays without treating a distant ridge as infinite',()=>{
    const blockers=terrainVisionBlockers([cliff]);
    expect(terrainLineOfSight(blockers,{xMm:0,zMm:0},{xMm:20000,zMm:20000})).toBe(false);
    expect(terrainLineOfSight(blockers,{xMm:5000,zMm:25000},{xMm:20000,zMm:25000})).toBe(true);
    expect(terrainLineOfSight(blockers,{xMm:5000,zMm:0},{xMm:5000,zMm:20000})).toBe(true);
  });
});

describe('Impassable rocky ridge relief',()=>{
  const ridge:TerrainRegion={id:'rocky-range',kind:'ridge',xMm:7300,zMm:8100,widthMm:16000,depthMm:40000,elevationMm:18000};
  it('keeps every visual slope within the full rectangular movement barrier and rejects building on it',()=>{
    expect(terrainObstacles([ridge])).toEqual([{id:'terrain_rocky-range_0',xMm:15300,zMm:28100,halfWidth:8000,halfHeight:20000}]);
    const elevations:number[]=[];
    for(let z=ridge.zMm;z<=ridge.zMm+ridge.depthMm;z+=2000)for(let x=ridge.xMm;x<=ridge.xMm+ridge.widthMm;x+=2000){
      const height=terrainHeightAt([ridge],x,z);elevations.push(height);
      expect(Number.isInteger(height)).toBe(true);expect(height).toBeGreaterThanOrEqual(1800);expect(height).toBeLessThanOrEqual(18000);
      expect(height).toBe(ridgeHeightAt(ridge,x,z));
    }
    expect(new Set(elevations).size).toBeGreaterThan(20);
    for(const [x,z]of [[7299,28000],[23301,28000],[15300,8099],[15300,48101]])expect(terrainHeightAt([ridge],x!,z!)).toBe(0);
    expect(terrainBuildable([ridge],{xMm:8000,zMm:10000,widthMm:2000,depthMm:2000})).toBe(false);
    expect(terrainBuildable([ridge],{xMm:24000,zMm:10000,widthMm:2000,depthMm:2000})).toBe(true);
  });
  it('blocks sight and cannot be cut by a legacy ramp descriptor',()=>{
    const ramp:TerrainRegion={id:'ramp',kind:'ramp',xMm:6000,zMm:20000,widthMm:20000,depthMm:12000,axis:'x',startElevationMm:0,endElevationMm:6000};
    expect(terrainObstacles([ridge,ramp])).toEqual(terrainObstacles([ridge]));
    expect(terrainLineOfSight(terrainVisionBlockers([ridge,ramp]),{xMm:6000,zMm:24000},{xMm:25000,zMm:24000})).toBe(false);
  });
  it('allows flat forest cells flush against every ridge face while rejecting any penetration',()=>{
    const faces=[{xMm:ridge.xMm-3000,zMm:ridge.zMm+9000},{xMm:ridge.xMm+ridge.widthMm,zMm:ridge.zMm+9000},{xMm:ridge.xMm+6000,zMm:ridge.zMm-3000},{xMm:ridge.xMm+6000,zMm:ridge.zMm+ridge.depthMm}];
    for(const [index,point]of faces.entries()){
      const footprint={...point,widthMm:3000,depthMm:3000};
      expect(terrainBuildable([ridge],footprint)).toBe(true);
      const offset=index===0?{xMm:point.xMm+1}:index===1?{xMm:point.xMm-1}:index===2?{zMm:point.zMm+1}:{zMm:point.zMm-1};
      expect(terrainBuildable([ridge],{...footprint,...offset})).toBe(false);
    }
    const plateau:TerrainRegion={...ridge,kind:'plateau',elevationMm:6000};
    expect(terrainBuildable([plateau],{xMm:plateau.xMm+plateau.widthMm-2000,zMm:plateau.zMm+9000,widthMm:3000,depthMm:3000})).toBe(false);
  });
  it('preserves saved legacy plateau/cliff elevations and their navigable ramp',()=>{
    const plateau:TerrainRegion={id:'saved-plateau',kind:'plateau',xMm:10000,zMm:10000,widthMm:36000,depthMm:30000,elevationMm:6000};
    const ramp:TerrainRegion={id:'saved-ramp',kind:'ramp',xMm:24000,zMm:40000,widthMm:12000,depthMm:12000,axis:'z',startElevationMm:6000,endElevationMm:0};
    expect(terrainHeightAt([plateau,cliff,ramp],30000,20000)).toBe(6000);
    expect(terrainHeightAt([plateau,cliff,ramp],30000,46000)).toBe(3000);
    expect(terrainBuildable([plateau],{xMm:24000,zMm:24000,widthMm:4000,depthMm:4000})).toBe(true);
  });
});
