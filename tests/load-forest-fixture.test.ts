import { describe,expect,it } from 'vitest';
import { balance,type PublicPlayer } from '@frontier/shared';
import { restoreSimulation,type EngineIdentity,type ResourceNode,type Unit } from '@frontier/simulation';
import { capacityDutyCommands,createCapacityDutyMemory,createCapacityFixture,validateCapacityGeometry } from '../scripts/load-fixture.js';

const identity:EngineIdentity={engineBuildHash:'9'.repeat(64),runtimeProfile:{nodeVersion:process.version,platform:process.platform,arch:process.arch}};
const roster=(count:number):PublicPlayer[]=>Array.from({length:count},(_,index)=>({id:`p${index}`,name:`Player ${index}`,teamId:`t${index}`,kind:index<6?'human':'ai',color:'#123456'}));
const options={factions:roster(2),identity,populationLimit:120 as const,seed:'forest-capacity-fixture'};
function resources(fixture:ReturnType<typeof createCapacityFixture>){return Object.values(fixture.save.payload.state.entities).filter((entity):entity is ResourceNode=>entity.kind==='resource');}

describe('separate capacity forest fixture',()=>{
  it('leaves default v1 unchanged and preserves every entity ID, resource total and faction duty in v2',()=>{
    const legacy=createCapacityFixture(options),explicit=createCapacityFixture({...options,forest:false}),forest=createCapacityFixture({...options,forest:true});
    expect(explicit).toEqual(legacy);expect(legacy.provenance.generator).toBe('capacity-fixture-v1');expect(resources(legacy).some(node=>node.forest)).toBe(false);
    expect(forest.provenance.generator).toBe('capacity-forest-v2');expect(forest.provenance.resourceLayout).toBe('finite-town-forest-bands-v2');expect(forest.provenance.workloadMembershipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(forest.drills).toEqual(legacy.drills);expect(Object.keys(forest.save.payload.state.entities)).toEqual(Object.keys(legacy.save.payload.state.entities));
    for(const resource of balance.resourceOrder){
      const amounts=(fixture:typeof forest)=>resources(fixture).filter(node=>node.resource===resource).map(node=>[node.id,node.amount]);
      expect(amounts(forest)).toEqual(amounts(legacy));
    }
    expect(resources(forest).filter(node=>node.forest)).toHaveLength(24);expect(resources(forest)).toHaveLength(8000);
    expect(forest.provenance.townEdgeNodesPerFaction).toBe(legacy.provenance.townEdgeNodesPerFaction-5);
    expect(createCapacityFixture({...options,forest:true}).provenance.workloadMembershipHash).toBe(forest.provenance.workloadMembershipHash);
  });
  it.each([120,200] as const)('retains eleven-faction %i capacity, all buildings/walls and collision-safe forest workers',populationLimit=>{
    const fixture=createCapacityFixture({...options,factions:roster(11),populationLimit,forest:true}),entities=Object.values(fixture.save.payload.state.entities);
    expect(entities.filter(entity=>entity.kind==='unit')).toHaveLength(populationLimit*11);
    expect(fixture.provenance).toMatchObject({expectedUnits:populationLimit*11,nonWallBuildingsPerFaction:80,wallEquivalentCellsPerFaction:160,resourceNodes:8000,forestCells:132,forestPatches:11,runtimeGrantsOrRespawns:false});
    expect(validateCapacityGeometry(entities)).toBeGreaterThan(0);
    expect(new Set(resources(fixture).flatMap(node=>node.forest?[node.forest.patchId]:[])).size).toBe(11);
  });
  it('starts every designated woodworker outside cells and permits real authorized edge gathering',()=>{
    const fixture=createCapacityFixture({...options,forest:true}),sim=restoreSimulation(fixture.save,identity,{preserveEpoch:true}),ids=Object.values(fixture.drills).flatMap(drill=>drill.resourceWorkers.filter(worker=>worker.resource==='wood').map(worker=>worker.workerId));
    sim.step();
    for(const faction of sim.state.factions){
      const commands=capacityDutyCommands(sim.view(faction.id),fixture.drills[faction.id]!,createCapacityDutyMemory()).filter(command=>command.kind==='gather'&&command.unitIds.some(id=>ids.includes(id)));
      expect(commands).toHaveLength(7);
      for(const command of commands){const sequence=sim.state.economies[faction.id]!.lastClientSequence+1,receipt=sim.command(faction.id,{protocolVersion:2,matchId:sim.state.matchId,matchEpoch:sim.state.matchEpoch,clientCommandId:`wood-${sequence}`,clientSequence:sequence,command});expect(receipt.status,receipt.code).toBe('accepted');}
    }
    sim.step(5);expect(ids.every(id=>(sim.state.entities[id] as Unit).cargo.amount>0)).toBe(true);
    expect(ids.every(id=>(sim.state.entities[id] as Unit).orders[0]?.forestIntentId!==undefined)).toBe(true);
  });
});
