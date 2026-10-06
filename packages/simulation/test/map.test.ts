import { appendFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { balance, legendaryExpansion, terrainBuildable, terrainHeightAt, terrainObstacles, units, type MapType, type PublicPlayer, type ResourceBank, type TerrainRegion } from '@frontier/shared';
import { buildCandidate, generateMap, mapGenerationAttempts, validateGeneratedMap, type GeneratedMap, type MapOptions } from '../src/map.js';
import { Navigation } from '../src/navigation.js';

const factions=(count:number):PublicPlayer[]=>Array.from({length:count},(_,index)=>({id:`p${index+1}`,name:`Player ${index+1}`,teamId:`team${index+1}`,color:'#3388ff',kind:'human'}));
const types:MapType[]=['open_frontier','river_divide'];

describe('Legendary Long War map guarantees',()=>{
  it.each(types.flatMap(mapType=>[2,11].map(count=>({mapType,count}))))('reserves reachable giant-building plots and fair ordinary-yield outer stock on $mapType for $count factions',({mapType,count})=>{
    let map:GeneratedMap|undefined;const failures:string[]=[];
    // Production already retries invalid private layouts. Keep this capacity
    // check bounded rather than requiring the very first sampled layout to fit.
    for(const attempt of count===11?[0,4,8,12,16]:[0])try{
      const candidate=buildCandidate({seed:'tenfold-natural-resources',factions:factions(count),mapType,rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war'},attempt);
      candidate.validation=validateGeneratedMap(candidate);map=candidate;break;
    }catch(error){failures.push(error instanceof Error?error.message:String(error));}
    if(!map)throw new Error(failures.join('; '));
    expect(map.validation.connected).toBe(true);expect(map.validation.longWar!.homeSites).toHaveLength(count);
    expect(map.validation.broadRoutes).toMatchObject({minimumWidthMm:32000,independentRoutes:2,verifiedPairs:count*(count-1)/2});
    expect(map.resources.length).toBeLessThanOrEqual(32000);
    for(const resource of ['wood','gold','stone'] as const){
      expect(map.validation.longWar!.nonStartingResources[resource]).toBeGreaterThanOrEqual(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*count);
      expect(map.validation.longWar!.outerAccessVariation[resource]).toBeLessThanOrEqual(.15);
      const kinds=['food','wood','gold','stone'] as const,yieldPerNode=({wood:250,gold:375,stone:250} as const)[resource];
      const ordinary=Array.from({length:Math.max(4,count*2)},(_,index)=>kinds[index%4]).filter(kind=>kind===resource).length*balance.maps.resourceNodes.expansion[resource];
      const beltNeutral=resource==='wood'?map.resources.filter(node=>node.resource==='wood'&&!node.startRegion&&map.forestFrontiers!.some(frontier=>{const normal=frontier.axis==='x'?node.xMm:node.zMm,along=frontier.axis==='x'?node.zMm:node.xMm;return Math.abs(normal-frontier.coordinateMm)<frontier.depthMm/2&&along>frontier.fromMm&&along<frontier.toMm&&!frontier.crossings.some(crossing=>Math.abs(along-crossing.centerMm)<crossing.widthMm/2);})).length:0;
      const additional=Math.max(0,Math.ceil(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*count/yieldPerNode)-Math.max(ordinary,beltNeutral));
      const expected=Math.ceil(additional*.5/count);
      for(const home of map.spawns)expect(map.resources.filter(node=>node.resource===resource&&node.outerRegion===home.playerId)).toHaveLength(expected);
    }
    for(const node of map.resources)expect(node.amount).toBe((node.startRegion?{food:200,wood:100,gold:300,stone:200}:{food:300,wood:250,gold:375,stone:250})[node.resource]);
  },30000);
  it('rejects missing outer stock allocation and swapping stock into another home region',()=>{
    const original=buildCandidate({seed:'tenfold-natural-resources',factions:factions(2),mapType:'open_frontier',rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war'},0);
    original.validation=validateGeneratedMap(original);
    const missing=structuredClone(original);for(const node of missing.resources){delete node.outerRegion;delete node.outerEntry;}
    expect(()=>validateGeneratedMap(missing)).toThrow('INVALID_LONG_WAR_OUTER_ALLOCATION');
    const swapped=structuredClone(original),first=swapped.resources.find(node=>node.resource==='gold'&&node.outerRegion==='p1'&&!node.outerEntry)!,second=swapped.resources.find(node=>node.resource==='gold'&&node.outerRegion==='p2'&&!node.outerEntry)!;
    first.outerRegion='p2';second.outerRegion='p1';
    expect(()=>validateGeneratedMap(swapped)).toThrow('CROSS_REGION_OUTER_RESOURCE');
  },30000);
});
describe('Long War production generation startup',()=>{
  const capacityOptions:MapOptions={seed:'m5-capacity-private-seed',mapType:'open_frontier',mapSize:'large',rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war',factions:Array.from({length:11},(_,index)=>({id:index<6?`p_${String(index+1).padStart(24,'0')}`:`ai_${index-5}`,name:`Player ${index+1}`,teamId:index<6?'team_humans':'team_commanders',color:'#3388ff',kind:index<6?'human':'ai'}))};
  it('diversifies crowded allied setbacks while retaining every private candidate exactly once',()=>{
    const attempts=mapGenerationAttempts(capacityOptions),sequential=Array.from({length:balance.maps.maxGenerationAttempts},(_,index)=>index);
    expect(attempts[0]).toBe(0);expect(attempts.slice(0,8)).toEqual([0,9,18,27,1,10,19,28]);
    expect(attempts).toHaveLength(sequential.length);expect(new Set(attempts).size).toBe(sequential.length);expect([...attempts].sort((a,b)=>a-b)).toEqual(sequential);
    for(const options of [{...capacityOptions,mapType:'river_divide' as const},{...capacityOptions,startingResourcePreset:'standard' as const},{...capacityOptions,factions:capacityOptions.factions.slice(0,8)},{...capacityOptions,factions:capacityOptions.factions.map((faction,index)=>({...faction,teamId:`team_${index}`}))}])expect(mapGenerationAttempts(options)).toEqual(sequential);
  });
  it.each([{change:{rulesetId:'unknown_ruleset'},code:'UNKNOWN_RULESET'},{change:{maxAge:9},code:'INVALID_AGE_CAP'}])('preserves the generator rejection for $code before retry ordering',({change,code})=>{
    const options={...capacityOptions,...change} as unknown as MapOptions;
    expect(mapGenerationAttempts(options)).toEqual(Array.from({length:balance.maps.maxGenerationAttempts},(_,index)=>index));
    expect(()=>generateMap(options)).toThrow(`MAP_GENERATION_FAILED:${code}`);
  });
  it.each(['m5-capacity-private-seed','tenfold-natural-resources'])('starts six allied humans versus five AI on %s with complete Long War proofs within the existing initialization budget',seed=>{
    const began=performance.now(),map=generateMap({...capacityOptions,seed}),elapsed=performance.now()-began;
    const evidence={check:'long-war-grouped-capacity-generation',seed,elapsedMs:Math.round(elapsed),candidate:map.validation.attempt,resources:map.resources.length};
    if(process.env.OPEN_FRONTIERS_MAP_REPORT)appendFileSync(process.env.OPEN_FRONTIERS_MAP_REPORT,JSON.stringify(evidence)+'\n');
    expect(elapsed).toBeLessThan(30000);expect(map.validation.connected).toBe(true);expect(map.spawns).toHaveLength(11);expect(map.validation.longWar!.homeSites).toHaveLength(11);
    expect(map.validation.broadRoutes).toMatchObject({minimumWidthMm:32000,independentRoutes:2,verifiedPairs:55});
    expect(map.validation.forestBelts!.minimumDepthMm).toBeGreaterThanOrEqual(18000);
    for(const report of map.validation.spawnReports)expect(report.resources).toEqual(balance.maps.spawnResourceMinimum);
    for(const resource of ['wood','gold','stone'] as const){expect(map.validation.longWar!.nonStartingResources[resource]).toBeGreaterThanOrEqual(legendaryExpansion.longWar.perFactionNonStartingMinimum[resource]*11);expect(map.validation.longWar!.outerAccessVariation[resource]).toBeLessThanOrEqual(.15);}
    // A retry-order version bump must not bypass the existing forest proofs.
    for(const generatorVersion of ['7.0.0','7.0.1']){
      expect(()=>validateGeneratedMap({...map,generatorVersion,forestFrontiers:undefined})).toThrow('MISSING_FOREST_FRONTIERS');
      expect(()=>validateGeneratedMap({...map,generatorVersion,validation:{...map.validation,forestBelts:{...map.validation.forestBelts!,treeNodes:0}}})).toThrow('INVALID_FOREST_BELT_SUMMARY');
    }
  },30000);
  it.each([{count:8,mapType:'open_frontier' as const,teams:true},{count:11,mapType:'open_frontier' as const,teams:false},{count:11,mapType:'river_divide' as const,teams:false}])('starts $count factions on $mapType within the existing worker initialization budget',({count,mapType,teams})=>{
    const roster=factions(count).map((faction,index)=>({...faction,...(teams?{teamId:index<4?'pilots':'opponents',kind:index<4?'human' as const:'ai' as const}:{})}));
    const began=performance.now(),map=generateMap({seed:'tenfold-natural-resources',factions:roster,mapType,rulesetId:'legendary_ages_v1',maxAge:8,startingResourcePreset:'long_war'}),elapsed=performance.now()-began;
    const evidence={check:'long-war-production-generation',mapType,factions:count,teams:teams?2:count,elapsedMs:Math.round(elapsed),attempt:map.validation.attempt,resources:map.resources.length};
    if(process.env.OPEN_FRONTIERS_MAP_REPORT)appendFileSync(process.env.OPEN_FRONTIERS_MAP_REPORT,JSON.stringify(evidence)+'\n');
    expect(elapsed).toBeLessThan(30000);expect(map.validation.connected).toBe(true);expect(map.validation.longWar!.homeSites).toHaveLength(count);
  },30000);
});
describe('M2 generated map validity and fairness',()=>{
  it.each(types.flatMap(mapType=>[
    {mapType,count:2,nodes:1160,total:{food:36000,wood:90000,gold:45000,stone:30000},expansion:{food:12000,wood:30000,gold:15000,stone:10000}},
    {mapType,count:4,nodes:2320,total:{food:72000,wood:180000,gold:90000,stone:60000},expansion:{food:24000,wood:60000,gold:30000,stone:20000}},
    {mapType,count:11,nodes:6420,total:{food:204000,wood:510000,gold:240000,stone:160000},expansion:{food:72000,wood:180000,gold:75000,stone:50000}}
  ]))('preserves base resource allocations and ordinary yields with extra belt trees on $mapType for $count factions',({mapType,count,nodes,total,expansion})=>{
    const map=generateMap({seed:'tenfold-natural-resources',factions:factions(count),mapType});
    const sum=(entries:typeof map.resources)=>entries.reduce<ResourceBank>((bank,node)=>{bank[node.resource]+=node.amount;return bank;},{food:0,wood:0,gold:0,stone:0});
    const quantities=(entries:typeof map.resources)=>entries.reduce<ResourceBank>((bank,node)=>{bank[node.resource]++;return bank;},{food:0,wood:0,gold:0,stone:0});
    expect(map.generatorVersion).toBe('7.0.1');
    const extraTrees=map.validation.forestBelts!.extraTreeNodes;
    expect(extraTrees).toBeGreaterThanOrEqual(0);
    expect(map.resources).toHaveLength(nodes+extraTrees);expect(map.validation.resourceNodes).toBe(nodes+extraTrees);
    expect(sum(map.resources)).toEqual({...total,wood:total.wood+extraTrees*250});
    expect(sum(map.resources.filter(node=>!node.startRegion))).toEqual({...expansion,wood:expansion.wood+extraTrees*250});
    for(const spawn of map.spawns){
      const starting=map.resources.filter(node=>node.startRegion===spawn.playerId);
      expect(quantities(starting)).toEqual({food:60,wood:300,gold:50,stone:50});
      expect(sum(starting)).toEqual({food:12000,wood:30000,gold:15000,stone:10000});
    }
    expect(quantities(map.resources.filter(node=>!node.startRegion))).toEqual({food:expansion.food/300,wood:expansion.wood/250+extraTrees,gold:expansion.gold/375,stone:expansion.stone/250});
    for(const node of map.resources){
      expect(Number.isSafeInteger(node.amount)&&node.amount>0).toBe(true);
      expect(node.amount).toBe((node.startRegion?{food:200,wood:100,gold:300,stone:200}:{food:300,wood:250,gold:375,stone:250})[node.resource]);
    }
  },15000);
  it.each(types)('honors an explicit larger lobby map with a two-faction tree budget on %s',mapType=>{
    const map=generateMap({seed:'explicit-large',factions:factions(2),mapType,mapSize:'large'});expect([map.widthMm,map.heightMm]).toEqual([640000,640000]);expect(map.validation.connected).toBe(true);
    expect(map.resources).toHaveLength(1160+map.validation.forestBelts!.extraTreeNodes);expect(map.validation.forestBelts!.frontiers).toBeGreaterThan(0);
    expect(map.validation.forestBelts!.extraTreeNodes).toBeGreaterThan(0);
    expect(()=>generateMap({seed:'undersized',factions:factions(5),mapSize:'small'})).toThrow('MAP_SIZE_TOO_SMALL');expect(()=>generateMap({seed:'undersized',factions:factions(9),mapSize:'medium'})).toThrow('MAP_SIZE_TOO_SMALL');
  });
  it.each(types.flatMap(mapType=>[{mapType,count:4,allies:3},{mapType,count:8,allies:4}]))('builds rival forest frontiers for $allies allies among $count factions on $mapType',({mapType,count,allies})=>{
    const roster=factions(count).map((faction,index)=>({...faction,teamId:index<allies?'allied_a':'allied_b'}));
    const map=generateMap({seed:'rival-belts-team-budget',factions:roster,mapType});
    expect(map.forestFrontiers!.length).toBeGreaterThan(0);
    expect(map.validation.forestBelts!.frontiers).toBe(map.forestFrontiers!.length);
    expect(map.validation.forestBelts!.openings).toBe(map.forestFrontiers!.reduce((sum,frontier)=>sum+frontier.crossings.length,0));
    expect(map.validation.forestBelts!.minimumDepthMm).toBeGreaterThanOrEqual(18000);
    expect(map.validation.forestBelts!.treeNodes).toBeGreaterThan(0);
    expect(map.validation.broadRoutes!.verifiedPairs).toBe(count*(count-1)/2);
    for(const report of map.validation.spawnReports)expect(report.resources).toEqual(balance.maps.spawnResourceMinimum);
  });
  it.each(types)('puts mixed interleaved allied pairs far from their opponents on $type',mapType=>{
    const roster=factions(4).map((faction,index)=>({...faction,teamId:index%2===0?'allies_a':'allies_b',kind:index<2?'human' as const:'ai' as const}));
    const map=generateMap({seed:'live-feedback-2v2',factions:roster,mapType});
    const distance=(a:string,b:string)=>{const first=map.spawns.find(spawn=>spawn.playerId===a)!.center,second=map.spawns.find(spawn=>spawn.playerId===b)!.center;return Math.hypot(first.xMm-second.xMm,first.zMm-second.zMm);};
    for(const first of roster)for(const second of roster){
      if(first.id===second.id)continue;
      if(first.teamId!==second.teamId)expect(distance(first.id,second.id)).toBeGreaterThan(300000);
      else expect(distance(first.id,second.id)).toBeGreaterThanOrEqual(80000);
    }
    expect(map.validation.connected).toBe(true);
    for(const report of map.validation.spawnReports)expect(report.resources).toEqual(balance.maps.spawnResourceMinimum);
    for(const variation of Object.values(map.validation.travelVariation))expect(variation).toBeLessThanOrEqual(balance.maps.startingTravelVariationFraction);
    const reordered=generateMap({seed:'live-feedback-2v2',factions:[...roster].reverse(),mapType});
    for(const spawn of map.spawns)expect(reordered.spawns.find(other=>other.playerId===spawn.playerId)!.center).toEqual(spawn.center);
  });
  it.each(types)('separates all eleven factions in six-versus-five without sacrificing starting resource access on $type',mapType=>{
    const roster=factions(11).map((faction,index)=>({...faction,teamId:index<6?'team_a':'team_b'}));
    const map=generateMap({seed:'maximum-allied-separation',factions:roster,mapType});
    expect(map.spawns).toHaveLength(11);expect(map.validation.connected).toBe(true);
    for(let i=0;i<roster.length;i++)for(let j=0;j<i;j++){
      const a=map.spawns[i]!.center,b=map.spawns[j]!.center,separation=Math.hypot(a.xMm-b.xMm,a.zMm-b.zMm);
      expect(separation).toBeGreaterThanOrEqual(roster[i]!.teamId===roster[j]!.teamId?80000:300000);
    }
    for(const report of map.validation.spawnReports)expect(report.resources).toEqual(balance.maps.spawnResourceMinimum);
    for(const variation of Object.values(map.validation.travelVariation))expect(variation).toBeLessThanOrEqual(balance.maps.startingTravelVariationFraction);
  });
  it.each(types.flatMap(type=>Array.from({length:10},(_,index)=>({type,count:index+2}))))('validates $type for $count factions across three fixed seeds',({type,count})=>{
    for(const seed of ['m2-smoke','m2-fairness-001','m2-fairness-002']){
      const map=generateMap({seed,factions:factions(count),mapType:type});
      const size=balance.maps.sizes.find(size=>count>=size.factions[0]!&&count<=size.factions[1]!)!;
      expect([map.widthMm,map.heightMm]).toEqual(size.cells.map(value=>value*2000));
      expect(map.validation.connected).toBe(true);
      expect(map.validation.attempt).toBeGreaterThanOrEqual(1);
      expect(map.validation.attempt).toBeLessThanOrEqual(balance.maps.maxGenerationAttempts);
      expect(map.validation.expansionPatches).toBeGreaterThanOrEqual(count*2);
      expect(map.validation.resourceNodes).toBeLessThanOrEqual(balance.rules.maxResourceNodes);
      expect(map.validation.broadRoutes).toMatchObject({minimumWidthMm:32000,independentRoutes:2,verifiedPairs:count*(count-1)/2});
      expect(map.terrain.some(region=>region.kind==='ridge')).toBe(true);
      expect(map.terrain.some(region=>region.id==='plateau')).toBe(false);
      expect(map.terrain.length).toBeLessThanOrEqual(64);
      for(const report of map.validation.spawnReports){
        expect(report.resources).toEqual(balance.maps.spawnResourceMinimum);
        for(const resource of balance.resourceOrder){
          expect(report.travelMm[resource]).toBeGreaterThan(0);
          expect(report.travelMm[resource]).toBeLessThanOrEqual(resource==='food'||resource==='wood'?30000:45000);
          expect(map.validation.travelVariation[resource]).toBeLessThanOrEqual(balance.maps.startingTravelVariationFraction);
        }
      }
      for(const spawn of map.spawns){
        expect(spawn.buildings.map(building=>building.typeId).sort()).toEqual(['house','town_center']);
        expect(spawn.units.filter(unit=>unit.typeId==='villager')).toHaveLength(6);
        expect(spawn.units.filter(unit=>unit.typeId==='scout')).toHaveLength(1);
      }
      const nav=new Navigation(map.widthMm,map.heightMm,terrainObstacles(map.terrain));
      for(const ramp of map.terrain.filter(region=>region.kind==='ramp')){
        const top={xMm:ramp.xMm+ramp.widthMm/2,zMm:ramp.zMm-3000},bottom={xMm:ramp.xMm+ramp.widthMm/2,zMm:ramp.zMm+ramp.depthMm+3000};
        expect(nav.clearLine(top,bottom,units.trebuchet.collisionRadiusM*1000)).toBe(true);
        expect(terrainHeightAt(map.terrain,top.xMm,top.zMm)).toBe(6000);
        expect(terrainHeightAt(map.terrain,bottom.xMm,bottom.zMm)).toBe(0);
      }
      if(type==='river_divide'){
        const river=map.terrain.find(region=>region.id==='river')!;
        expect(nav.free({xMm:map.widthMm/2,zMm:10000},350)).toBe(false);
        expect(map.terrain.filter(region=>region.kind==='bridge')).toHaveLength(Math.min(balance.maps.forestBelts.preferredOpenings,Math.ceil(size.factions[1]!/2)));
        for(const bridge of map.terrain.filter(region=>region.kind==='bridge'))expect(bridge.depthMm).toBeGreaterThanOrEqual(balance.maps.naturalBarriers.valleyWidthM*1000);
        for(const spawn of map.spawns)for(const node of map.resources.filter(node=>node.startRegion===spawn.playerId))expect(node.xMm<river.xMm).toBe(spawn.center.xMm<river.xMm);
      }
    }
  },15000);
  it('replays identical seeds and keeps generated placements separate from public terrain',()=>{
    const a=generateMap({seed:'repeatable',factions:factions(2)}),b=generateMap({seed:'repeatable',factions:factions(2)}),c=generateMap({seed:'different',factions:factions(2)});
    expect(a).toEqual(b);expect(a.spawns).not.toEqual(c.spawns);
    const publicMap={type:a.type,generatorVersion:a.generatorVersion,widthMm:a.widthMm,heightMm:a.heightMm,terrain:a.terrain};
    expect(Object.keys(publicMap)).not.toContain('seed');
    expect(JSON.stringify(publicMap)).not.toContain('startRegion');
  });
  it('rejects invalid faction counts, duplicated IDs and unsupported map types',()=>{
    expect(()=>generateMap({seed:'bad',factions:factions(1)})).toThrow('INVALID_MAP_FACTIONS');
    expect(()=>generateMap({seed:'bad',factions:factions(12)})).toThrow('INVALID_MAP_FACTIONS');
    expect(()=>generateMap({seed:'bad',factions:[factions(2)[0]!,factions(2)[0]!]})).toThrow('INVALID_MAP_FACTIONS');
    expect(()=>generateMap({seed:'bad',factions:factions(2),mapType:'unlisted' as MapType})).toThrow('INVALID_MAP_TYPE');
  });
  it('reports explicit generation failure after the configured retry limit',()=>{
    const path=vi.spyOn(Navigation.prototype,'path').mockReturnValue(null);
    try{
      expect(()=>generateMap({seed:'unreachable',factions:factions(2)})).toThrow('MAP_GENERATION_FAILED:TRAPPED_STARTING_UNIT');
      expect(path).toHaveBeenCalledTimes(balance.maps.maxGenerationAttempts);
    }finally{path.mockRestore();}
  });
  it('rejects blocked, overlapping, understocked and unreachable starting layouts',()=>{
    const original=generateMap({seed:'mutation',factions:factions(2)});
    const overlap=structuredClone(original);overlap.spawns[1]!.center={...overlap.spawns[0]!.center};
    expect(()=>validateGeneratedMap(overlap)).toThrow('INVALID_MAP_SPAWNS');
    const blocked=structuredClone(original);blocked.spawns[0]!.units[0]!.position={...blocked.spawns[0]!.center};
    expect(()=>validateGeneratedMap(blocked)).toThrow('TRAPPED_STARTING_UNIT');
    const building=structuredClone(original);building.spawns[0]!.buildings[1]!.position={...building.spawns[0]!.center};
    expect(()=>validateGeneratedMap(building)).toThrow('INVALID_STARTING_BUILDING');
    const stock=structuredClone(original);stock.resources.find(node=>node.resource==='wood'&&node.startRegion==='p1')!.amount=1;
    expect(()=>validateGeneratedMap(stock)).toThrow('INVALID_RESOURCE_YIELD');
    const missing=structuredClone(original);missing.spawns[0]!.units.pop();
    expect(()=>validateGeneratedMap(missing)).toThrow('INVALID_STARTING_COUNTS');
    const resource=structuredClone(original);resource.resources[0]!.xMm=-100;
    expect(()=>validateGeneratedMap(resource)).toThrow('INVALID_RESOURCE_NODE');
  });
  it('rejects missing resource objects and inflated yields even when the aggregate stock is retained',()=>{
    const original=generateMap({seed:'quantity-not-durability',factions:factions(2)});
    for(const starting of [true,false]){
      const missing=structuredClone(original),index=missing.resources.findIndex(node=>Boolean(node.startRegion)===starting&&node.resource==='food');
      missing.resources.splice(index,1);
      expect(()=>validateGeneratedMap(missing)).toThrow('INVALID_RESOURCE_QUANTITY');
      const consolidated=structuredClone(original),sameGroup=consolidated.resources.filter(node=>Boolean(node.startRegion)===starting&&node.resource==='food'&&(!starting||node.startRegion==='p1'));
      sameGroup[0]!.amount+=sameGroup[1]!.amount;
      consolidated.resources.splice(consolidated.resources.indexOf(sameGroup[1]!),1);
      expect(()=>validateGeneratedMap(consolidated)).toThrow('INVALID_RESOURCE_QUANTITY');
    }
    const inflated=structuredClone(original);inflated.resources.find(node=>node.resource==='wood')!.amount*=10;
    expect(()=>validateGeneratedMap(inflated)).toThrow('INVALID_RESOURCE_YIELD');
  });
  it('retains the resource safety ceiling above the full eleven-faction map budget',()=>{
    expect(balance.rules.maxResourceNodes).toBeGreaterThanOrEqual(6420);
    const oversized=generateMap({seed:'resource-node-ceiling',factions:factions(2)});
    oversized.resources=Array.from({length:balance.rules.maxResourceNodes+1},()=>({...oversized.resources[0]!}));
    expect(()=>validateGeneratedMap(oversized)).toThrow('RESOURCE_NODE_LIMIT');
  });
  it('rejects missing frontier geometry and summary counts that disagree with the actual trees and openings',()=>{
    const original=generateMap({seed:'forest-summary-integrity',factions:factions(2)});
    for(const key of ['frontiers','openings','minimumDepthMm','treeNodes','extraTreeNodes'] as const){
      const changed=structuredClone(original);changed.validation.forestBelts![key]++;
      expect(()=>validateGeneratedMap(changed),key).toThrow();
    }
    const missing=structuredClone(original);delete missing.forestFrontiers;
    expect(()=>validateGeneratedMap(missing)).toThrow('MISSING_FOREST_FRONTIERS');
    const empty=structuredClone(original);empty.forestFrontiers=[];
    expect(()=>validateGeneratedMap(empty)).toThrow('INVALID_FOREST_BELT_SUMMARY');
  });
  it('uses the same terrain for crossings, cliff collision, slope placement and height sampling',()=>{
    const map=generateMap({seed:'terrain',factions:factions(2),mapType:'river_divide'});
    const nav=new Navigation(map.widthMm,map.heightMm,terrainObstacles(map.terrain));
    const ridge=map.terrain.find(region=>region.kind==='ridge')!;
    expect(terrainBuildable(map.terrain,{xMm:ridge.xMm+6000,zMm:ridge.zMm+6000,widthMm:6000,depthMm:6000})).toBe(false);
    expect(nav.clearLine({xMm:ridge.xMm-4000,zMm:ridge.zMm+10000},{xMm:ridge.xMm+4000,zMm:ridge.zMm+10000},350)).toBe(false);
    expect(terrainHeightAt(map.terrain,map.widthMm/2,10000)).toBe(-1500);
    const bridge=map.terrain.find(region=>region.kind==='bridge')!;
    expect(terrainHeightAt(map.terrain,map.widthMm/2,bridge.zMm+6000)).toBe(0);
    // Legacy saved height geometry remains supported even though new maps replace
    // the isolated square plateau with ridges and broad ground-level valleys.
    const legacy:TerrainRegion[]=[{id:'old',kind:'plateau',xMm:10000,zMm:10000,widthMm:36000,depthMm:30000,elevationMm:6000},{id:'old-ramp',kind:'ramp',xMm:22000,zMm:39000,widthMm:12000,depthMm:18000,axis:'z',startElevationMm:6000,endElevationMm:0}];
    expect(terrainBuildable(legacy,{xMm:16000,zMm:16000,widthMm:6000,depthMm:6000})).toBe(true);
    expect(terrainHeightAt(legacy,28000,48000)).toBe(3000);
  });
  it.each(types)('reserves distinct full-width forest crossings after all resource placement on %s',mapType=>{
    const map=generateMap({seed:'reserved-army-valleys',factions:factions(11),mapType}),rules=balance.maps.naturalBarriers;
    expect(map.forestFrontiers!.length).toBeGreaterThan(0);
    expect(map.validation.forestBelts!.treeNodes).toBeGreaterThan(0);
    const obstacles=[...terrainObstacles(map.terrain),...map.resources.map((node,index)=>({id:`resource_${index}`,xMm:node.xMm,zMm:node.zMm,halfWidth:node.forest?node.forest.cellMm/2:650,halfHeight:node.forest?node.forest.cellMm/2:650}))];
    const nav=new Navigation(map.widthMm,map.heightMm,obstacles);
    for(const frontier of map.forestFrontiers!){
      expect(frontier.depthMm).toBeGreaterThanOrEqual(balance.maps.forestBelts.minimumDepthM*1000);
      expect(frontier.depthMm).toBeLessThanOrEqual(balance.maps.forestBelts.maximumDepthM*1000);
      expect(frontier.crossings.length).toBeGreaterThanOrEqual(2);expect(frontier.crossings.length).toBeLessThanOrEqual(3);
      for(const crossing of frontier.crossings){
        expect(crossing.widthMm).toBeGreaterThanOrEqual(rules.valleyWidthM*1000);
        const distance=frontier.depthMm/2+crossing.approachMm;
        const point=(normal:number)=>frontier.axis==='x'?{xMm:normal,zMm:crossing.centerMm}:{xMm:crossing.centerMm,zMm:normal};
        expect(nav.clearLine(point(frontier.coordinateMm-distance),point(frontier.coordinateMm+distance),crossing.widthMm/2)).toBe(true);
      }
    }
  });
  it.each(types)('keeps public terrain independent of player identity, alliances and human or AI control on %s',mapType=>{
    const roster=factions(4),a=generateMap({seed:'public-landscape',factions:roster,mapType}),b=generateMap({seed:'public-landscape',factions:roster.map((faction,index)=>({...faction,kind:'ai' as const,teamId:index<2?'allied_a':'allied_b'})),mapType});
    expect(a.terrain).toEqual(b.terrain);expect(a.spawns).not.toEqual(b.spawns);
    const c=generateMap({seed:'public-landscape',factions:roster.map(faction=>({...faction,kind:'ai' as const})),mapType});
    expect(c.spawns).toEqual(a.spawns);expect(c.resources).toEqual(a.resources);
  });
  it.each([4,8])('keeps independently private River Divide starts when all %s capacity slots are occupied',count=>{
    const first=generateMap({seed:'private-river-slots-a',factions:factions(count),mapType:'river_divide'}),second=generateMap({seed:'private-river-slots-b',factions:factions(count),mapType:'river_divide'});
    const coordinates=(map:typeof first)=>map.spawns.map(spawn=>`${spawn.center.xMm},${spawn.center.zMm}`).sort();
    expect(coordinates(first)).not.toEqual(coordinates(second));
    for(const map of [first,second])expect(map.validation.connected).toBe(true);
  });
  it('rejects narrowing a reserved valley or crossing after placement',()=>{
    const original=generateMap({seed:'barrier-mutations',factions:factions(2),mapType:'river_divide'});
    const ridge=structuredClone(original);ridge.terrain.find(region=>region.kind==='ridge')!.xMm=80000;
    expect(()=>validateGeneratedMap(ridge)).toThrow('RIDGE_OBSTRUCTS_RESERVED_VALLEY');
    const resource=structuredClone(original),node=resource.resources.find(node=>!node.startRegion&&node.resource==='food')!,frontier=resource.forestFrontiers![0]!,crossing=frontier.crossings[0]!;
    node.xMm=frontier.axis==='x'?frontier.coordinateMm:crossing.centerMm;node.zMm=frontier.axis==='x'?crossing.centerMm:frontier.coordinateMm;
    expect(()=>validateGeneratedMap(resource)).toThrow('INVALID_FOREST_FRONTIER');
    const bridge=structuredClone(original);bridge.terrain.find(region=>region.kind==='bridge')!.depthMm=12000;
    expect(()=>validateGeneratedMap(bridge)).toThrow('NARROW_CROSSING');
    const forest=structuredClone(original);forest.resources.find(node=>node.forest)!.xMm=450;
    expect(()=>validateGeneratedMap(forest)).toThrow('INVALID_FOREST_CELL');
  });
  it('keeps increased woodland in bounded patches outside the broad riverbanks',()=>{
    const map=generateMap({seed:'attached-forest-belts',factions:factions(11),mapType:'river_divide'}),patches=new Map<string,typeof map.resources>();
    for(const node of map.resources.filter(node=>node.resource==='wood')){
      expect(node.forest).toBeDefined();
      const members=patches.get(node.forest!.patchId)??[];members.push(node);patches.set(node.forest!.patchId,members);
    }
    for(const members of patches.values()){
      expect(members.length).toBeLessThanOrEqual(balance.maps.resourceNodes.forestPatchLimit);
      expect(new Set(members.map(node=>node.startRegion)).size).toBe(1);
      for(const node of members){
        expect(node.forest!.cellMm).toBe(balance.maps.forestNavigationCellM*1000);
        if(!node.startRegion)expect(Math.abs(node.xMm-map.widthMm/2)-node.forest!.cellMm/2-6000).toBeGreaterThanOrEqual(32000);
      }
    }
    for(const spawn of map.spawns)expect([...patches.values()].filter(members=>members[0]!.startRegion===spawn.playerId).length).toBeGreaterThanOrEqual(10);
    expect(map.validation.broadRoutes).toMatchObject({minimumWidthMm:32000,independentRoutes:2,verifiedPairs:55});
  });
});
