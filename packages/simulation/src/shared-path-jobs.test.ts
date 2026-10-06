import { describe, expect, it } from 'vitest';
import { SharedPathJobs, type SharedCoarseFrontier, type SharedPathMember, type SharedPathJobsState } from './shared-path-jobs.js';
import { componentFromText, importPathSearch } from './path-search-keys.js';

function fixture(limits: ConstructorParameters<typeof SharedPathJobs>[1] = {}) {
  const live = new Map<string, { member: SharedPathMember; frontier: SharedCoarseFrontier }>();
  const adapter = (member: SharedPathMember) => {
    const row = live.get(member.request.unitId);
    return row?.member.request.id === member.request.id && row.member.request.orderRevision === member.request.orderRevision ? row.frontier : undefined;
  };
  const jobs = new SharedPathJobs(adapter, limits);
  const request = (unitId: string, options: { profile?: string; radius?: number; revision?: number; geometry?: number; workClass?: 'interactive' | 'routine' | 'optional'; enqueuedTick?: number; targetX?: number; start?: string; end?: string } = {}) => {
    const profile = options.profile ?? 'blue', from = { xMm: 1500, zMm: 1500 }, target = { xMm: options.targetX ?? 80500, zMm: 1500 };
    const startComponents = [options.start ?? '0,0,0'], endComponents = [options.end ?? '5,0,0'];
    const member: SharedPathMember = { request: { id: `request_${unitId}_${options.revision ?? 1}`, unitId, orderRevision: options.revision ?? 1, profile, from, target, radiusMm: options.radius ?? 400,
      ...(options.workClass ? { workClass: options.workClass, enqueuedTick: options.enqueuedTick ?? 0 } : {}) }, geometryRevision: options.geometry ?? 0, widthMm: 128000, heightMm: 128000, startComponents, endComponents, connectorRegions: ['0,0', '5,0'] };
    const frontier: SharedCoarseFrontier = { profile, radiusMm: member.request.radiusMm, from: { ...from }, target: { ...target }, starts: [129], ends: [208], startComponents: [...startComponents], endComponents: [...endComponents], coarse: importPathSearch({ heap: [{ key: startComponents[0]!, score: 0 }], scores: { [startComponents[0]!]: 0 }, parents: {}, closed: {} },true) };
    live.set(unitId, { member, frontier }); return member;
  };
  return { jobs, live, request, adapter };
}

describe('independent shared coarse jobs', () => {
  it('stays dormant for unmatched work and automatically admits a compatible second request', () => {
    const { jobs, request } = fixture();
    expect(jobs.consider(request('a'))).toEqual([]); expect(jobs.hasJobs).toBe(false);
    expect(jobs.services('blue', 0)).toEqual([]);
    expect(jobs.consider(request('b', { targetX: 81000 }))).toEqual(['a', 'b']);
    expect(jobs.inventory()).toEqual({ jobs: 1, members: 2, waiting: 0 });
    expect(jobs.services('blue', 0)).toEqual([{ id: 'blue:1', profile: 'blue', workClass: 'interactive', enqueuedTick: 0 }]);
    expect(jobs.isMember('a')).toBe(true); expect(jobs.isMember('b')).toBe(true);
  });
  it('never combines faction, radius, geometry or different endpoint component proofs', () => {
    const { jobs, request } = fixture(); jobs.consider(request('seed'));
    for (const [id, options] of [
      ['red', { profile: 'red' }], ['larger', { radius: 500 }], ['changed', { geometry: 1 }],
      ['start', { start: '1,0,0' }], ['end', { end: '4,0,0' }], ['oversized', { radius: 1001 }],
    ] as const) expect(jobs.consider(request(id, options))).toEqual([]);
    expect(jobs.hasJobs).toBe(false); expect(jobs.consider(request('compatible'))).toEqual(['seed', 'compatible']);
  });
  it('owns a detached frontier, uses one service position and survives founding-member cancellation', () => {
    const { jobs, request, live } = fixture(); jobs.consider(request('founder', { workClass: 'interactive' })); jobs.consider(request('follower', { workClass: 'routine', targetX: 81200 }));
    live.get('founder')!.frontier.coarse.scores.set(componentFromText('0,0,0'),999);
    jobs.cancel('founder'); live.delete('founder');
    expect(jobs.services('blue', 10)).toEqual([{ id: 'blue:1', profile: 'blue', workClass: 'routine', enqueuedTick: 0 }]);
    const result = jobs.advance('blue:1', frontier => { expect(frontier.coarse.scores.get(componentFromText('0,0,0'))).toBe(0); return { status: 'ready', chain: ['0,0,0', '5,0,0'] }; });
    expect(result.status).toBe('ready'); if (result.status === 'ready') expect(result.members.map(member => member.request.target.xMm)).toEqual([81200]);
    expect(jobs.hasJobs).toBe(false); expect(jobs.isMember('follower')).toBe(false);
  });
  it('inherits the highest surviving class and ages routine members without extra member service grants', () => {
    const { jobs, request } = fixture(); jobs.consider(request('optional', { workClass: 'optional' })); jobs.consider(request('routine', { workClass: 'routine', enqueuedTick: 10 }));
    expect(jobs.services('blue', 49)[0]!.workClass).toBe('routine'); expect(jobs.services('blue', 50)[0]!.workClass).toBe('interactive');
    jobs.consider(request('urgent', { workClass: 'interactive', enqueuedTick: 30 })); expect(jobs.services('blue', 40)).toHaveLength(1);
    expect(jobs.services('blue', 40)[0]!.enqueuedTick).toBe(30);
    jobs.cancel('urgent'); jobs.cancel('routine'); expect(jobs.services('blue', 100)[0]!.workClass).toBe('optional');
    jobs.cancel('optional'); expect(jobs.inventory()).toEqual({ jobs: 0, members: 0, waiting: 0 });
  });
  it('invalidates all members only for relevant own knowledge and preserves foreign/distant work', () => {
    const { jobs, request } = fixture(); jobs.consider(request('a')); jobs.consider(request('b')); const before = jobs.exportState();
    expect(jobs.invalidate('red', new Set(['0,0']))).toEqual([]); expect(jobs.exportState()).toEqual(before);
    expect(jobs.invalidate('blue', new Set(['7,7']))).toEqual([]); expect(jobs.exportState()).toEqual(before);
    expect(jobs.invalidate('blue', new Set(['1,1'])).map(member => member.request.unitId)).toEqual(['a', 'b']);
    expect(jobs.hasJobs).toBe(false); expect(jobs.isMember('a')).toBe(false);
  });
  it('bounds jobs and membership, leaving excess requests on ordinary search rather than reporting blocked', () => {
    const { jobs, request } = fixture({ jobsPerProfile: 1, membersPerJob: 2 });
    jobs.consider(request('a')); jobs.consider(request('b'));
    expect(jobs.consider(request('c'))).toEqual([]); expect(jobs.consider(request('d'))).toEqual([]);
    expect(jobs.inventory()).toEqual({ jobs: 1, members: 2, waiting: 2 });
    expect(jobs.services('blue', 0)).toHaveLength(1);
    expect(() => new SharedPathJobs(() => undefined, { membersPerJob: 1 })).toThrow('INVALID_SHARED_PATH_LIMIT');
    expect(() => new SharedPathJobs(() => undefined, { jobsPerProfile: 65 })).toThrow('INVALID_SHARED_PATH_LIMIT');
  });
  it('repairs non-endpoint shared dependencies once and admits peers using the new geometry identity', () => {
    const { jobs, request, adapter } = fixture(); jobs.consider(request('a')); jobs.consider(request('b'));
    const before = jobs.exportState().jobs[0]!; let repairs = 0;
    expect(jobs.invalidate('blue', new Set(['1,1']), { geometryRevision: 1, frontier: frontier => { repairs++; expect(frontier.coarse.scores.get(0)).toBe(0); } })).toEqual([]);
    const after = jobs.exportState().jobs[0]!;
    expect(repairs).toBe(1); expect(after.id).toBe(before.id); expect(after.frontier).toEqual(before.frontier);
    expect(after.geometryRevision).toBe(1); expect(after.members.every(member => member.geometryRevision === 1)).toBe(true);
    expect(jobs.consider(request('c', { geometry: 1 }))).toEqual(['c']); expect(jobs.inventory().jobs).toBe(1);
    const cold = new SharedPathJobs(adapter); cold.importState(JSON.parse(JSON.stringify(jobs.exportState()))); expect(cold.exportState()).toEqual(jobs.exportState());
    jobs.invalidate('blue', new Set(['7,7']), { geometryRevision: 2, frontier: () => { throw new Error('DISTANT_REPAIR'); } });
    expect(jobs.consider(request('d', { geometry: 2 }))).toEqual(['d']); expect(jobs.exportState().jobs[0]!.id).toBe(before.id);
  });
  it('restarts edited endpoints and every member connector even when a repair adapter is available', () => {
    for (const region of ['0,0', '5,0', '2,2']) {
      const { jobs, request } = fixture(); jobs.consider(request('a')); const follower = request('b'); follower.connectorRegions.push('2,2'); jobs.consider(follower);
      expect(jobs.invalidate('blue', new Set([region]), { geometryRevision: 1, frontier: () => { throw new Error('UNSAFE_REPAIR'); } }).map(member => member.request.unitId)).toEqual(['a', 'b']);
      expect(jobs.hasJobs).toBe(false);
    }
  });
  it('releases a dependency-cap job for a fresh search and never confuses that with a proven block', () => {
    const { jobs, request } = fixture({ dependenciesPerJob: 10 }); jobs.consider(request('a')); jobs.consider(request('b'));
    expect(jobs.hasJobs).toBe(true);
    const result = jobs.advance('blue:1', frontier => { frontier.currentComponent = componentFromText('3,3,0'); return { status: 'pending' }; });
    expect(result.status).toBe('restart'); expect(jobs.hasJobs).toBe(false);
  });
  it('shares one immutable dependency list until the frontier or membership extends it', () => {
    const { jobs, request } = fixture(); jobs.consider(request('a')); jobs.consider(request('b'));
    const first = jobs.dependencies('a'); expect(jobs.dependencies('b')).toBe(first); expect(Object.isFrozen(first)).toBe(true);
    jobs.advance('blue:1', frontier => { const key=componentFromText('3,3,0');frontier.currentComponent = key; frontier.edgeCursor = 0; frontier.coarse.closed.set(key,true); frontier.coarse.scores.set(key,1); frontier.coarse.parents.set(key,componentFromText('0,0,0')); return { status: 'pending' }; });
    expect(jobs.dependencies('a')).not.toBe(first); expect(jobs.dependencies('a')).toBe(jobs.dependencies('b')); expect(jobs.dependencies('a')).toContain('3,3');
  });
  it('preserves waiting admission, frontier progress, membership and priority through cold continuation', () => {
    const { jobs, request, adapter } = fixture(); jobs.consider(request('a', { workClass: 'routine' })); jobs.consider(request('b')); jobs.consider(request('waiting', { profile: 'red' }));
    jobs.advance('blue:1', frontier => { const one=componentFromText('1,0,0'),two=componentFromText('2,0,0');frontier.currentComponent = one; frontier.edgeCursor = 0; frontier.coarse.closed.set(one,true); frontier.coarse.scores.set(one,1); frontier.coarse.parents.set(one,componentFromText('0,0,0')); frontier.coarse.scores.set(two,2); frontier.coarse.parents.set(two,one); return { status: 'pending' }; });
    const saved = jobs.exportState(), cold = new SharedPathJobs(adapter); cold.importState(saved);
    expect(cold.exportState()).toEqual(saved); expect(cold.services('blue', 50)).toEqual(jobs.services('blue', 50));
    saved.jobs[0]!.frontier.coarse.scores['0,0,0'] = 777; expect(cold.exportState()).toEqual(jobs.exportState());
    const peer = request('red_peer', { profile: 'red' }); expect(cold.consider(peer)).toEqual(jobs.consider(peer));
    const finish = () => ({ status: 'ready' as const, chain: ['0,0,0', '5,0,0'] });
    expect(cold.advance('blue:1', finish)).toEqual(jobs.advance('blue:1', finish)); expect(cold.exportState()).toEqual(jobs.exportState());
  });
  it('keeps job IDs and saved ordering exact across one or multiple profile owners', () => {
    const { jobs, request, adapter } = fixture(), blue = new SharedPathJobs(adapter), red = new SharedPathJobs(adapter);
    const redA = request('r1', { profile: 'red' }), blueA = request('b1'), redB = request('r2', { profile: 'red' }), blueB = request('b2');
    for (const member of [redA, blueA, redB, blueB]) jobs.consider(member);
    for (const member of [blueA, blueB]) blue.consider(member); for (const member of [redA, redB]) red.consider(member);
    const left = blue.exportState(), right = red.exportState();
    const merged: SharedPathJobsState = { version: 1, serials: { ...left.serials, ...right.serials }, waiting: [...left.waiting, ...right.waiting], jobs: [...left.jobs, ...right.jobs] };
    expect(merged).toEqual(jobs.exportState());
  });
  it('round-trips numeric component zero and detaches all cold-import frontier fields', () => {
    const {jobs,request,adapter}=fixture();jobs.consider(request('a'));jobs.consider(request('b'));
    jobs.advance('blue:1',frontier=>{frontier.currentComponent=0;frontier.edgeCursor=3;frontier.coarse.closed.set(0,true);return {status:'pending'};});
    const saved=jobs.exportState(),expected=JSON.stringify(saved),cold=new SharedPathJobs(adapter);cold.importState(saved);
    cold.advance('blue:1',frontier=>{expect(frontier.currentComponent).toBe(0);expect(frontier.coarse.closed.get(0)).toBe(true);return {status:'pending'};});
    expect(JSON.stringify(cold.exportState())).toBe(expected);
    const frontier=saved.jobs[0]!.frontier;frontier.from.xMm++;frontier.target.zMm++;frontier.starts[0]=frontier.starts[0]!+1;frontier.ends[0]=frontier.ends[0]!+1;frontier.startComponents[0]='1,1,1';frontier.endComponents[0]='1,1,1';frontier.coarse.heap[0]!.score=999;
    expect(JSON.stringify(cold.exportState())).toBe(expected);
  });
  it('rejects stale member bindings, missing dependencies and mismatched geometry on restore atomically', () => {
    const { jobs, request, adapter, live } = fixture(); jobs.consider(request('a')); jobs.consider(request('b')); const saved = jobs.exportState();
    for (const mutate of [
      (state: SharedPathJobsState) => { state.jobs[0]!.members[0]!.request.orderRevision++; },
      (state: SharedPathJobsState) => { state.jobs[0]!.dependencies = []; },
      (state: SharedPathJobsState) => { state.jobs[0]!.geometryRevision++; },
      (state: SharedPathJobsState) => { state.jobs[0]!.members.push(state.jobs[0]!.members[0]!); },
      (state: SharedPathJobsState) => { state.jobs[0]!.frontier.endComponents = ['7,7,0']; },
    ]) {
      const changed = structuredClone(saved); mutate(changed); const restored = new SharedPathJobs(adapter);
      expect(() => restored.importState(changed)).toThrow(); expect(restored.inventory()).toEqual({ jobs: 0, members: 0, waiting: 0 });
    }
    live.delete('a'); expect(() => new SharedPathJobs(adapter).importState(saved)).toThrow('INVALID_SHARED_PATH_MEMBER');
  });
});
