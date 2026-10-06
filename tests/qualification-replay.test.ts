import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { createSimulation, createReplayRecording, exportReplay, replayCheckpoint, simulationChecksum, type EngineIdentity } from '@frontier/simulation';
import { assertQualificationReceiptReplay, qualificationReceiptWaitReady, verifyTerminalReplay, retainTerminalReplayEvidence } from '../scripts/qualification-replay.js';

it('classifies pause/epoch invalidation after a receipt-replay precheck without weakening paid command deduplication',()=>{
  const simulation=createSimulation({seed:'receipt-boundary-race',matchId:'receipt_boundary',controllers:false,
    factions:[{id:'a',name:'A',teamId:'a',color:'#aabbcc',kind:'human'},{id:'b',name:'B',teamId:'b',color:'#ddeeff',kind:'human'}]});
  const initial=simulation.view('a'),home=initial.entities.find(entity=>entity.ownerId==='a'&&entity.typeId==='town_center')!;
  const command={protocolVersion:2,matchId:initial.matchId,matchEpoch:initial.matchEpoch,clientCommandId:'paid_once',clientSequence:1,
    command:{kind:'train',buildingId:home.id,unitType:'villager',quantity:1}};
  const paid=simulation.command('a',command);expect(paid.status).toBe('accepted');
  const bank={...simulation.state.economies.a!.resources},spent={...simulation.state.economies.a!.spent};
  const repeated=simulation.command('a',command);
  expect(()=>assertQualificationReceiptReplay(paid,repeated,'setup')).not.toThrow();
  expect(()=>assertQualificationReceiptReplay(paid,repeated,'reconnect')).not.toThrow();
  // This is the passing harness precheck. The worker then overload-pauses before
  // it drains the queued duplicate, so the exact old envelope must become stale.
  expect(simulation.view('a').matchEpoch).toBe(command.matchEpoch);
  simulation.setStatus('PAUSED');simulation.invalidateEpoch();
  // A lost-receipt reconnect discards this old unresolved envelope on its first
  // new-epoch view. No replay will arrive: reject the boundary before polling it.
  const waitingForDiscardedReplay=vi.fn(()=>false);
  expect(()=>qualificationReceiptWaitReady([{expected:command,observed:simulation.view('a')}],waitingForDiscardedReplay,'setup')).toThrow('SETUP_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY');
  expect(waitingForDiscardedReplay).not.toHaveBeenCalled();
  const stale=simulation.command('a',command);expect(stale).toMatchObject({status:'rejected',code:'STALE_MATCH'});
  expect(()=>assertQualificationReceiptReplay(paid,stale,'setup')).toThrow('SETUP_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY');
  expect(()=>assertQualificationReceiptReplay(paid,stale,'reconnect')).toThrow('RECONNECT_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY');
  expect(simulation.state.economies.a!.resources).toEqual(bank);expect(simulation.state.economies.a!.spent).toEqual(spent);
  expect(simulation.view('a').entities.find(entity=>entity.id===home.id)!.queue).toHaveLength(1);
  // A different same-boundary cached receipt, or a receipt for another command,
  // remains a real mismatch; neither is excused as an overload boundary.
  expect(()=>assertQualificationReceiptReplay(paid,{...repeated,tick:repeated.tick+1},'setup')).toThrow('DUPLICATE_RECEIPT_CHANGED');
  expect(()=>assertQualificationReceiptReplay(paid,{...repeated,sequence:repeated.sequence+1},'reconnect')).toThrow('RECONNECT_DUPLICATE_CHANGED');
  expect(()=>assertQualificationReceiptReplay(paid,{...stale,clientCommandId:'wrong_command'},'setup')).toThrow('DUPLICATE_RECEIPT_CHANGED');
});

it('keeps missing same-epoch receipts pending through reconnect and resync instead of inferring an overload',()=>{
  const expected={matchId:'receipt_boundary',matchEpoch:3};
  let observed:typeof expected|undefined,unresolvedReplays=0,receipts=0;
  const ready=()=>qualificationReceiptWaitReady([{expected,observed}],()=>Boolean(observed)&&unresolvedReplays===1&&receipts===1,'setup');
  expect(ready()).toBe(false); // Reconnect has no complete snapshot yet.
  observed={...expected};expect(ready()).toBe(false); // Receipt was lost, within the same match.
  unresolvedReplays=1;expect(ready()).toBe(false); // A resend alone does not pass recovery.
  observed=undefined;expect(ready()).toBe(false); // Resync temporarily removes the local view.
  observed={...expected};receipts=1;expect(ready()).toBe(true);
  // A genuinely missing receipt remains false for the caller's existing timeout.
  receipts=0;for(let poll=0;poll<3;poll++)expect(ready()).toBe(false);
});

it.each(['setup','reconnect'] as const)('checks every actual observed match and epoch before an incomplete or completed %s predicate',phase=>{
  const expected={matchId:'receipt_boundary',matchEpoch:3};
  for(const observed of [{...expected,matchEpoch:4},{...expected,matchId:'replacement_match'}])for(const complete of [false,true]){
    const ready=vi.fn(()=>complete);
    // The first recipient lacks a resync snapshot; it must not short-circuit the
    // later recipient's proven boundary change, even if receipts already arrived.
    expect(()=>qualificationReceiptWaitReady([{expected,observed:undefined},{expected,observed}],ready,phase)).toThrow(`${phase==='setup'?'SETUP':'RECONNECT'}_MATCH_BOUNDARY_CHANGED_DURING_RECEIPT_REPLAY`);
    expect(ready).not.toHaveBeenCalled();
  }
});

const identity: EngineIdentity = { engineBuildHash: 'a'.repeat(64), runtimeProfile: { nodeVersion: process.version, platform: process.platform, arch: process.arch } };
function fixture() {
  const sim = createSimulation({ seed: 'terminal-replay-verification', matchId: 'terminal_replay', controllers: false,
    factions: [{ id: 'a', name: 'A', teamId: 'a', color: '#aabbcc', kind: 'human' }, { id: 'b', name: 'B', teamId: 'b', color: '#ddeeff', kind: 'human' }] });
  const home = sim.view('a').entities.find(entity => entity.ownerId === 'a' && entity.typeId === 'town_center')!;
  expect(sim.command('a', { protocolVersion: 2, matchId: sim.state.matchId, matchEpoch: sim.state.matchEpoch,
    clientCommandId: 'paid_worker', clientSequence: 1, command: { kind: 'train', buildingId: home.id, unitType: 'villager', quantity: 1 } }).status).toBe('accepted');
  sim.step(420); const middle = replayCheckpoint(sim); sim.invalidateEpoch(2); sim.step(5); sim.endAsDraw();
  const recording = exportReplay(sim, identity, [middle, replayCheckpoint(sim)]);
  return { sim, recording, expected: { matchId: sim.state.matchId, matchEpoch: sim.state.matchEpoch, tick: sim.state.tick, result: sim.state.result! } };
}
describe('terminal recording qualification', () => {
  it('replays paid gameplay through intermediate and terminal checksums without inference', async () => {
    const { sim, recording, expected } = fixture(), request = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('NO_INFERENCE'));
    try {
      expect(await verifyTerminalReplay(recording, identity, expected)).toMatchObject({ passed: true, checksum: simulationChecksum(sim), endTick: 425, checkpoints: 2, timingQualificationEligible: false });
      expect(request).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });
  it('rejects missing terminal evidence and validly sealed divergent checkpoints', async () => {
    const { recording, expected } = fixture();
    const reseal = (checkpoints: typeof recording.checkpoints) => createReplayRecording(recording.initial, recording.events, checkpoints, recording.endTick, recording.endOrdinal);
    expect(await verifyTerminalReplay(reseal(recording.checkpoints.slice(0, 1)), identity, expected)).toMatchObject({ passed: false, code: 'TERMINAL_REPLAY_CHECKPOINT_MISSING' });
    const changed = structuredClone(recording.checkpoints); changed.at(-1)!.checksum = 'b'.repeat(64);
    expect(await verifyTerminalReplay(reseal(changed), identity, expected)).toMatchObject({ passed: false, code: `REPLAY_STATE_DIVERGENCE:${recording.endTick}:${recording.endOrdinal}` });
    expect(await verifyTerminalReplay(recording, identity, { ...expected, matchId: 'different_match' })).toMatchObject({ passed: false, code: 'TERMINAL_REPLAY_BOUNDARY_MISMATCH' });
    expect(await verifyTerminalReplay(recording, identity, { ...expected, result: { ...expected.result, winnerTeamId: 'a' } })).toMatchObject({ passed: false, code: 'TERMINAL_REPLAY_RESULT_MISMATCH' });
  });
});

describe('host-only terminal replay evidence retention', () => {
  const directories: string[] = [];
  async function archiveFixture() {
    const root = await mkdtemp(join(tmpdir(), 'terminal-replay-evidence-')); directories.push(root);
    const sourceDirectory = join(root, 'source'), archiveDirectory = join(root, 'archive');
    await mkdir(sourceDirectory); return { root, sourceDirectory, archiveDirectory };
  }
  afterEach(async () => {
    for (const root of directories.splice(0)) {
      const within = relative(tmpdir(), root);
      expect(!isAbsolute(within) && !within.startsWith('..') && within.startsWith('terminal-replay-evidence-')).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });
  const name = (index: number, extension = 'json') => `replay_${1700000000000 + index}_${index.toString(16).padStart(16, '0')}.${extension}`;

  it('retains corrupt JSON and incomplete journals verbatim, without unrelated files or their contents in metadata', async () => {
    const options = await archiveFixture(), corrupt = Buffer.from('{"broken":\u0000\xff'), journal = Buffer.from('{"incomplete":');
    await writeFile(join(options.sourceDirectory, name(1)), corrupt);
    await writeFile(join(options.sourceDirectory, name(1, 'ndjson')), journal);
    await writeFile(join(options.sourceDirectory, 'endpoint.json'), 'private-endpoint-credential');
    await writeFile(join(options.sourceDirectory, 'replay_not_a_valid_id.json'), 'unrelated');
    const result = await retainTerminalReplayEvidence(options);
    expect(result.files).toHaveLength(2); expect(result.skipped).toEqual([]);
    expect(await readFile(join(options.archiveDirectory, name(1)))).toEqual(corrupt);
    expect(await readFile(join(options.archiveDirectory, name(1, 'ndjson')))).toEqual(journal);
    expect(result.files.find(file => file.name === name(1))).toMatchObject({ bytes: corrupt.length, sha256: createHash('sha256').update(corrupt).digest('hex') });
    expect(JSON.stringify(result)).not.toContain('private-endpoint-credential');
    expect((await readdir(options.archiveDirectory)).sort()).toEqual([name(1), name(1, 'ndjson')].sort());
    expect(result).toMatchObject({ hostOnly: true, timingQualificationEligible: false });
  });

  it('excludes regular directories and junctions/symlinks even when they have replay names', async () => {
    const options = await archiveFixture(), outside = join(options.root, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'private.json'), 'must-not-be-followed');
    await mkdir(join(options.sourceDirectory, name(2)));
    await symlink(outside, join(options.sourceDirectory, name(3)), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await retainTerminalReplayEvidence(options);
    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { name: name(2), code: 'TERMINAL_REPLAY_EVIDENCE_LINK_OR_NON_FILE' },
      { name: name(3), code: 'TERMINAL_REPLAY_EVIDENCE_LINK_OR_NON_FILE' },
    ]));
    expect(await readdir(options.archiveDirectory)).toEqual([]);
  });

  it('rejects links anywhere in source or archive directory trees', async () => {
    const options = await archiveFixture(), linked = join(options.root, 'linked');
    await writeFile(join(options.sourceDirectory, name(1)), 'corrupt');
    await symlink(options.sourceDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const source = await retainTerminalReplayEvidence({ ...options, sourceDirectory: linked });
    const destination = await retainTerminalReplayEvidence({ ...options, archiveDirectory: join(linked, 'nested') });
    for (const result of [source, destination]) {
      expect(result.files).toEqual([]);
      expect(result.skipped).toContainEqual({ code: 'TERMINAL_REPLAY_EVIDENCE_LINK_OR_NON_DIRECTORY' });
    }
    expect(await readdir(options.sourceDirectory)).toEqual([name(1)]);
  });

  it('reports its file/byte bounds and retains only the newest bounded evidence', async () => {
    const options = await archiveFixture();
    for (let index = 0; index < 10; index++) await writeFile(join(options.sourceDirectory, name(index)), 'x');
    const result = await retainTerminalReplayEvidence(options);
    expect(result.files.map(file => file.name)).toEqual(Array.from({ length: 8 }, (_, index) => name(9 - index)));
    expect(result.skipped).toContainEqual({ code: 'TERMINAL_REPLAY_EVIDENCE_FILE_LIMIT' });
    const large = await open(join(options.sourceDirectory, name(20)), 'w');
    try { await large.truncate(result.limits.fileBytes + 1); } finally { await large.close(); }
    const oversized = await retainTerminalReplayEvidence({ ...options, archiveDirectory: join(options.root, 'large-archive'), preferredId: name(20).slice(0, -5) });
    expect(oversized.files).toEqual([]);
    expect(oversized.skipped).toContainEqual({ name: name(20), code: 'TERMINAL_REPLAY_EVIDENCE_BYTE_LIMIT' });
  });

  it('never overwrites existing archives and rejects an unsafe preferred ID', async () => {
    const options = await archiveFixture(); await mkdir(options.archiveDirectory);
    await writeFile(join(options.sourceDirectory, name(1)), 'new-corrupt-evidence');
    await writeFile(join(options.archiveDirectory, name(1)), 'retained-original');
    const existing = await retainTerminalReplayEvidence({ ...options, preferredId: name(1).slice(0, -5) });
    expect(existing.files).toEqual([]); expect(existing.skipped).toHaveLength(1);
    expect(await readFile(join(options.archiveDirectory, name(1)), 'utf8')).toBe('retained-original');
    const unsafe = await retainTerminalReplayEvidence({ ...options, preferredId: '../endpoint' });
    expect(unsafe.files).toEqual([]);
    expect(unsafe.skipped).toContainEqual({ code: 'TERMINAL_REPLAY_EVIDENCE_INVALID_ID' });
  });
});
