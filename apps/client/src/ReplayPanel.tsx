import { useCallback, useEffect, useRef, useState } from 'react';
import { balance, resolveRuleset, validateConsistentPlayerView, validateReplayListResponse, validateReplayOpenResponse, validateReplayStepResponse, type AuthoritativeIntervalMs, type PlayerView, type ReplayListResponse, type ReplayOpenResponse, type ReplayStepResponse, type SessionResponse } from '@frontier/shared';
import { World } from './World';
import { readPreferences, subscribePreferences } from './preferences';
import { useModalFocus } from './modalFocus';

const clock = (tick: number) => `${Math.floor(tick / balance.rules.simulationHz / 60)}:${String(Math.floor(tick / balance.rules.simulationHz) % 60).padStart(2, '0')}`;
export function replayViewCompatible(view:unknown):view is PlayerView {
  if(!validateConsistentPlayerView(view))return false;
  try{return view.contentHash===resolveRuleset(view.rulesetId,view.maxAge,view.startingResourcePreset).contentHash;}catch{return false;}
}

/** Advance whole committed frames; subframe requests are rounded down by replay. */
export function replayPlaybackStep(cursor: number, endTick: number, authoritativeIntervalMs?: AuthoritativeIntervalMs): { targetTick: number; intervalMs: number } {
  const tickMs = 1000 / balance.rules.simulationHz;
  const ticks = Math.max(1, Math.round(Math.max(100, authoritativeIntervalMs ?? 50) / tickMs));
  const targetTick = Math.min(endTick, cursor + ticks);
  return { targetTick, intervalMs: Math.max(0, targetTick - cursor) * tickMs };
}

/** A separate filtered renderer. It has no gameplay command connection or model client. */
export function ReplayPanel({ session, close }: { session: SessionResponse; close: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), world = useRef<World | null>(null);
  const abort = useRef<AbortController | null>(null), alive = useRef(true), busyRef = useRef(false), playingRef = useRef(false);
  const [list, setList] = useState<ReplayListResponse | null>(null), [opened, setOpened] = useState<ReplayOpenResponse | null>(null);
  const [view, setView] = useState<PlayerView | null>(null), [playerId, setPlayerId] = useState('');
  const [targetTick, setTargetTick] = useState(0), [progress, setProgress] = useState(0), [busy, setBusy] = useState(false), [playing, setPlaying] = useState(false);
  const [error, setError] = useState(''), [graphicsError, setGraphicsError] = useState<string | null>(null);
  const cursor = useRef(0), playbackInterval = useRef<AuthoritativeIntervalMs | undefined>(undefined);
  const pause = useCallback(() => { playingRef.current = false; setPlaying(false); world.current?.setStreamActive(false); }, []);
  const modal = useModalFocus(true, () => { pause(); close(); });
  useEffect(() => {
    alive.current = true;
    if (canvas.current) try { world.current = new World(canvas.current, setGraphicsError); world.current.setPreferences(readPreferences()); void world.current.ready.catch(problem => { if (alive.current) setGraphicsError(problem instanceof Error ? problem.message : 'Replay assets could not load.'); }); } catch (problem) { setGraphicsError(problem instanceof Error ? problem.message : 'Replay graphics could not start.'); }
    const unsubscribe = subscribePreferences(preferences => world.current?.setPreferences(preferences));
    return () => { unsubscribe(); alive.current = false; playingRef.current = false; abort.current?.abort(); world.current?.dispose(); world.current = null; };
  }, []);
  const readList = useCallback(async () => {
    setError('');
    try { const response = await fetch('/api/host/replays', { credentials: 'same-origin' }); const value: unknown = await response.json(); if (!response.ok || !validateReplayListResponse(value)) throw new Error('Could not read compatible completed recordings.'); if (alive.current) setList(value); }
    catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : 'Could not read recordings.'); }
  }, []);
  useEffect(() => { void readList(); }, [readList]);
  async function request(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController(); abort.current = controller;
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(session.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}) }, body: JSON.stringify(body) });
    const value: unknown = await response.json();
    if (!response.ok) { const problem = value as { code?: string; message?: string }; throw new Error((problem.message ?? problem.code ?? 'Replay operation failed.').replaceAll('_', ' ')); }
    return value;
  }
  async function seek(target: number, viewpoint = playerId, replay = opened, animate = false): Promise<ReplayStepResponse | null> {
    if (!replay || !viewpoint || busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError('');
    const desired = Math.max(replay.startTick, Math.min(replay.endTick, Math.round(target)));
    try {
      await world.current?.ready;
      if (!alive.current) return null;
      let step: ReplayStepResponse;
      do {
        const started = performance.now();
        const value = await request('/api/host/replay/step', { targetTick: desired, playerId: viewpoint });
        if (!validateReplayStepResponse(value) || value.replayId !== replay.replayId || value.view.playerId !== viewpoint || !replayViewCompatible(value.view)) throw new Error('Incompatible replay viewpoint. The last complete frame is retained.');
        step = value; if (!alive.current) return null; setProgress(step.tick);
        // Long seeks stay below the host HTTP budget even when reconstruction is fast.
        if (!step.done) await new Promise((resolve) => setTimeout(resolve, Math.max(0, 50 - (performance.now() - started))));
      } while (!step.done && alive.current);
      if (!alive.current) return null;
      const changedViewpoint = view?.playerId !== viewpoint;
      world.current?.setView(step.view, !animate || changedViewpoint); world.current?.setStreamActive(animate && playingRef.current);
      if (changedViewpoint) { const base = step.view.entities.find((entity) => entity.ownerId === viewpoint && entity.typeId === 'town_center'); if (base) world.current?.focus(base.xMm, base.zMm); world.current?.select([]); }
      cursor.current = step.tick; playbackInterval.current = step.view.authoritativeIntervalMs; setTargetTick(step.tick); setView(step.view); return step;
    } catch (problem) { if (alive.current) { setError(problem instanceof Error ? problem.message : 'Replay could not advance.'); pause(); } return null; }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  async function open(replayId: string) {
    if (busyRef.current) return; pause(); busyRef.current = true; setBusy(true); setError('');
    let replay: ReplayOpenResponse | null = null;
    try { const value = await request('/api/host/replay/open', { replayId }); if (!validateReplayOpenResponse(value)) throw new Error('Incompatible replay metadata.'); replay = value; if (!alive.current) return; playbackInterval.current = undefined; setOpened(value); setPlayerId(value.players[0]?.id ?? ''); setView(null); cursor.current = value.startTick; setTargetTick(value.startTick); setProgress(value.startTick); }
    catch (problem) { if (alive.current) setError(problem instanceof Error ? problem.message : 'The recording could not open.'); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
    if (replay && alive.current) await seek(replay.startTick, replay.players[0]?.id, replay);
  }
  const seekRef = useRef(seek); seekRef.current = seek;
  useEffect(() => {
    if (!playing || !opened) return;
    playingRef.current = true; let cancelled = false;
    const play = async () => {
      while (!cancelled && playingRef.current && cursor.current < opened.endTick) {
        const started = performance.now(), next = replayPlaybackStep(cursor.current, opened.endTick, playbackInterval.current);
        const result = await seekRef.current(next.targetTick, playerId, opened, true);
        if (!result) break;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, next.intervalMs - (performance.now() - started))));
      }
      if (!cancelled) pause();
    };
    void play(); return () => { cancelled = true; playingRef.current = false; };
  }, [playing, opened, playerId, pause]);
  const displayed = view?.players.find((player) => player.id === playerId);
  return <section ref={modal} className="replay-panel" role="dialog" aria-modal="true" aria-label="Completed match replay">
    <canvas className="replay-canvas" ref={canvas} aria-label="Replay 3D battlefield" data-testid="replay-canvas" />
    <header className="replay-heading"><div><span className="eyebrow">THE HOST'S CHRONICLE</span><h2>Return to the frontier</h2><p>Completed recordings only. Exact replay requires the same engine, content and supported runtime. Replay uses recorded decisions and never calls the model.</p></div><button className="quiet-button" aria-label="Close replay" onClick={() => { pause(); close(); }}>Close replay</button></header>
    <aside className="replay-recordings"><div className="recovery-section-heading"><h3>Recordings</h3><button className="quiet-button" disabled={busy || playing} onClick={() => void readList()}>Refresh</button></div>{list?.recordings.map((recording) => <button key={recording.id} className={opened?.replayId === recording.id ? 'active' : ''} disabled={busy || playing} aria-label={`Open replay ${recording.id}`} onClick={() => void open(recording.id)}><b>{new Date(recording.createdAt).toLocaleString()}</b><span>{clock(recording.startTick)} to {clock(recording.endTick)}</span><small>{Math.ceil(recording.bytes / 1024)} KiB</small></button>)}{list && !list.recordings.length && <p className="small-copy">Finish a match to create a recording.</p>}{list?.warnings.map((warning) => <p className="recovery-error" key={`${warning.id}-${warning.code}`}>{warning.id}: {warning.code.replaceAll('_', ' ')}</p>)}</aside>
    {error && <p className="replay-error" role="alert">{error}</p>}{graphicsError && <p className="replay-error" role="alert">{graphicsError}</p>}
    {opened && <footer className="replay-timeline"><div className="replay-viewpoint"><label>COMMANDER VIEW<select aria-label="Replay viewpoint" value={playerId} disabled={busy || playing} onChange={(event) => { pause(); setPlayerId(event.target.value); void seek(cursor.current, event.target.value); }}>{opened.players.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}</select></label><div><b>{displayed?.name ?? 'Loading viewpoint'}</b><small>Fog and information follow this commander's recorded viewpoint.</small></div><output aria-label="Replay time">{clock(view?.tick ?? opened.startTick)} / {clock(opened.endTick)}</output></div><div className="replay-seek"><input type="range" aria-label="Replay timeline" min={opened.startTick} max={opened.endTick} step={1} disabled={busy || playing} value={targetTick} onChange={(event) => setTargetTick(Number(event.target.value))} /><button className="quiet-button" disabled={busy || playing} onClick={() => void seek(targetTick)}>Seek to {clock(targetTick)}</button></div><div className="replay-buttons"><button className="quiet-button" disabled={busy || playing} onClick={() => void seek(opened.startTick)}>Beginning</button><button className="quiet-button" disabled={busy || playing} onClick={() => void seek(cursor.current - balance.rules.simulationHz * 10)}>Back 10 seconds</button><button className="primary" disabled={!playing && (busy || !view || cursor.current >= opened.endTick)} onClick={() => playing ? pause() : setPlaying(true)}>{playing ? 'Pause replay' : 'Play replay'}</button><button className="quiet-button" disabled={busy || playing} onClick={() => void seek(cursor.current + balance.rules.simulationHz * 10)}>Forward 10 seconds</button><button className="quiet-button" disabled={busy || playing} onClick={() => void seek(opened.endTick)}>End</button><span role="status">{busy && !playing ? `Reconstructing ${clock(progress)}...` : playing ? 'Playing at normal speed' : 'Paused'}</span></div></footer>}
  </section>;
}
