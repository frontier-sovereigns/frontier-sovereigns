import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import { validateAiModelCatalogResponse, validateSessionResponse, type AiModelChoice, type SessionResponse } from '@frontier/shared';
import { World } from './World';
import { useGame } from './useGame';
import { GameHud } from './GameHud';
import { HostRecovery } from './HostRecovery';
import { ReplayPanel } from './ReplayPanel';
import { EndpointPanel } from './EndpointPanel';
import { AssistantPanel } from './AssistantPanel';
import { HostLobbyOptions, FactionOptions } from './LobbyOptions';
import { AssetIcon } from './AssetIcon';
import { SettingsPanel } from './SettingsPanel';
import { readPreferences, subscribePreferences, writePreferences } from './preferences';
import { GameAudio } from './GameAudio';

const bootstrapErrors: Record<string, string> = {
  BOOTSTRAP_LOCAL_ONLY: "Host access is available only at the host computer's local browser address. Use the Host browser address shown in the server console.",
  BOOTSTRAP_EXPIRED: 'This host access token has expired. Restart the game server to get a new token, then use it within 10 minutes.',
  BOOTSTRAP_USED: 'This host access token has already been used. Return to the browser session, profile and local address that opened host controls. If you need a new token, save any running match before stopping and restarting the game server.',
  BOOTSTRAP_REJECTED: 'The host access token was not accepted. Copy the one-time token printed below Host browser in the server console and try again.',
};

export function App() {
  const localHostAccess = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useRef<World | null>(null);
  const [session, commitSession] = useState<SessionResponse | null>(null);
  const sessionRevision = useRef(0), sessionRefreshHolds = useRef(0), currentSession = useRef(session); currentSession.current = session;
  const setSession = useCallback<Dispatch<SetStateAction<SessionResponse | null>>>(update => { sessionRevision.current++; commitSession(update); }, []);
  const beginSessionRotation = useCallback(() => {
    sessionRefreshHolds.current++; sessionRevision.current++; let released = false;
    return () => { if (!released) { released = true; sessionRefreshHolds.current--; sessionRevision.current++; } };
  }, []);
  const [error, setError] = useState('');
  const [graphicsError, setGraphicsError] = useState<string | null>(null);
  const [graphicsReady, setGraphicsReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'join' | 'host' | 'rejoin'>('join');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [token, setToken] = useState('');
  const [rejoinToken, setRejoinToken] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false), [hostModels, setHostModels] = useState<AiModelChoice[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false), [preferences, setPreferences] = useState(readPreferences);
  const [audioAlert, setAudioAlert] = useState<{ text: string; at: number } | null>(null);
  const audio = useRef<GameAudio | null>(null), sounded = useRef(new Set<string>());
  const game = useGame(session, setSession, world, setError, graphicsReady, beginSessionRotation);

  useEffect(() => {
    if (!session?.host) { setHostModels([]); return; }
    let stopped = false; const controller = new AbortController();
    void fetch('/api/host/models', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      const value: unknown = await response.json();
      if (response.ok && validateAiModelCatalogResponse(value) && !stopped) setHostModels(value.models.map(model => ({ id: model.id, label: model.label, available: model.enabled && model.configured })));
    }).catch(() => undefined);
    return () => { stopped = true; controller.abort(); };
  }, [session?.host, endpointOpen]);

  useEffect(() => { audio.current = new GameAudio(text => setAudioAlert({ text, at: Date.now() })); const unsubscribe = subscribePreferences(setPreferences); return () => { unsubscribe(); audio.current?.dispose(); audio.current = null; }; }, []);
  useEffect(() => { document.documentElement.style.setProperty('--ui-scale', String(preferences.uiScale)); document.documentElement.dataset.reducedMotion = String(preferences.reducedMotion); world.current?.setPreferences(preferences); }, [preferences]);
  useEffect(() => { if (game.view && world.current) audio.current?.update(game.view, { xMm: world.current.camera.target.x * 1000, zMm: world.current.camera.target.z * 1000 }); else audio.current?.clear(); }, [game.view]);
  useEffect(() => { for (const event of game.commandObservations) if (!sounded.current.has(event.envelope.clientCommandId)) { sounded.current.add(event.envelope.clientCommandId); if (event.receipt.status === 'accepted') audio.current?.play('order_ack'); else if (event.receipt.code === 'INSUFFICIENT_RESOURCES') audio.current?.play('population_blocked'); } if (sounded.current.size > 192) sounded.current = new Set(game.commandObservations.map(e => e.envelope.clientCommandId)); }, [game.commandObservations]);
  useEffect(() => { if (!audioAlert) return; const timer = window.setTimeout(() => setAudioAlert(null), 8000); return () => window.clearTimeout(timer); }, [audioAlert]);

  const refresh = useCallback(async () => {
    const revision = sessionRevision.current, held = sessionRefreshHolds.current > 0;
    const response = await fetch('/api/session', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not reach the game host. Check that the server is running.');
    const next: unknown = await response.json();
    if (!validateSessionResponse(next)) throw new Error('The host returned an incompatible session. Reload the page after updating the game.');
    // Cookie rotation invalidates the old session. A poll issued before/during
    // reconnect may legitimately return anonymous, but cannot replace its result.
    if (held || sessionRefreshHolds.current || revision !== sessionRevision.current) return currentSession.current ?? next;
    setSession(next);
    return next;
  }, [setSession]);

  useEffect(() => {
    void refresh().catch((e: Error) => setError(e.message));
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 2500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!canvas.current) return;
    let cancelled = false;
    try {
      world.current = new World(canvas.current, setGraphicsError);
      const current = world.current; current.setPreferences(readPreferences());
      void current.ready.then(() => { if (!cancelled && world.current === current) setGraphicsReady(true); }).catch((e: unknown) => { if (!cancelled) setGraphicsError(e instanceof Error ? e.message : 'The required 3D assets could not load.'); });
    } catch (e) { setGraphicsError(e instanceof Error ? e.message : 'The 3D renderer could not start.'); }
    return () => { cancelled = true; world.current?.dispose(); world.current = null; };
  }, []);

  async function post(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(session?.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}) },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { message?: string; error?: string; code?: string };
        const bootstrapMessage = path === '/api/bootstrap' ? bootstrapErrors[problem.code ?? ''] : undefined;
        throw new Error(bootstrapMessage ?? problem.message ?? problem.code ?? problem.error ?? `Request failed (${response.status}).`);
      }
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'The request failed.'); }
    finally { setBusy(false); }
  }

  function join(e: FormEvent) {
    e.preventDefault();
    void post('/api/join', { name: name.trim(), inviteCode: session?.host ? session.lobby.inviteCode ?? '' : invite.trim(), ...(session?.host ? { hostPlayer: true } : {}) });
  }

  const lobbyEditable = !session || ['SETUP', 'LOBBY'].includes(session.lobby.status);
  const me = session?.lobby.players.find((p) => p.id === session.playerId);
  const players = session?.lobby.players ?? [];
  const teamOptions = [...new Set([...players.map((player) => player.teamId), ...Array.from({ length: 11 }, (_, index) => `team_${index + 1}`)])];
  const teamName = (id: string) => /^team_\d+$/.test(id) ? `Team ${id.slice(5)}` : `${players.find((player) => player.teamId === id)?.name ?? 'Independent'}'s team`;

  if (game.view && session && world.current) return <main className="app game-mode">
    <canvas ref={canvas} className="world-canvas" aria-label="Interactive 3D frontier battlefield" data-testid="world-canvas" />
    <GameHud view={game.view} session={session} world={world.current} connection={game.connection} receipt={game.receipt} pendingCount={game.pendingCount} error={error} clearError={() => setError('')} send={game.send} post={post} openRecovery={() => setRecoveryOpen(true)} communication={game.communication} refreshCommunication={game.refreshCommunication} openSettings={() => setSettingsOpen(true)} openEndpoint={() => setEndpointOpen(true)} preferences={preferences} audio={audio.current} commandObservations={game.commandObservations} />
    {assistantOpen && session?.playerId && <AssistantPanel session={session} close={() => setAssistantOpen(false)} />}
    {settingsOpen && <SettingsPanel preferences={preferences} change={writePreferences} close={() => setSettingsOpen(false)} />}
    {audioAlert && <div className="sound-text-alert" role="status">{audioAlert.text}</div>}
    {recoveryOpen && session.host && <HostRecovery session={session} refreshSession={refresh} close={() => setRecoveryOpen(false)} openReplay={() => { setRecoveryOpen(false); setReplayOpen(true); }} openEndpoint={() => { setRecoveryOpen(false); setEndpointOpen(true); }} />}
    {replayOpen && session.host && ['LOBBY', 'FINISHED'].includes(session.lobby.status) && <ReplayPanel session={session} close={() => setReplayOpen(false)} />}
    {endpointOpen && session.host && <EndpointPanel session={session} close={() => setEndpointOpen(false)} />}
    {graphicsError && <section className="graphics-error" role="alert"><div className="eyebrow">GRAPHICS NEED ATTENTION</div><h2>Graphics recovery</h2><p>{graphicsError}</p><button className="primary" onClick={() => window.location.reload()}>Retry graphics<span>↻</span></button></section>}
    <div className="small-screen-notice">Desktop mouse and keyboard are required for gameplay. Use a window at least 1024 × 680.</div>
  </main>;

  return <main className={`app lobby-mode ${session?.host ? 'host-lobby' : ''} ${session?.playerId ? 'joined-lobby' : ''}`}>
    <canvas ref={canvas} className="world-canvas" aria-label="Interactive 3D frontier landscape" data-testid="world-canvas" />
    <div className="vignette" />
    <header className="masthead">
      <a className="brand" href="/" aria-label="Frontier Sovereigns home"><span className="crest" aria-hidden="true">F</span><span>FRONTIER<br /><b>SOVEREIGNS</b></span></a>
      <div className="lobby-tools"><a className="quiet-button" href="/asset-gallery">Asset gallery</a><button className="quiet-button" onClick={() => setSettingsOpen(true)}>Settings & controls</button><div className="status-pill"><i className={session ? 'online' : ''} />{session ? 'CONNECTED TO SERVER' : 'CONNECTING TO HOST'}</div></div>
    </header>
    <section className="lobby-panel">
      <div className="eyebrow">A NEW CHAPTER IN THE MAKING</div>
      <h1>Every empire<br /> starts <em>here.</em></h1>
      <p className="intro">Raise a settlement. Lead your people.<br />Make your mark on the frontier.</p>

      {!session?.playerId && !session?.host && <div className="tabs" role="tablist" aria-label="Connect to game">
        <button role="tab" aria-selected={mode === 'join'} className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>Join a game</button>
        <button role="tab" aria-selected={mode === 'rejoin'} className={mode === 'rejoin' ? 'active' : ''} onClick={() => setMode('rejoin')}>Rejoin saved game</button>
        {localHostAccess && <button role="tab" aria-selected={mode === 'host'} className={mode === 'host' ? 'active' : ''} onClick={() => setMode('host')}>Host access</button>}
      </div>}

      {!session?.playerId && lobbyEditable && (mode === 'join' || session?.host) && <form onSubmit={join} className="connect-form">
        <label>YOUR NAME<input autoComplete="nickname" maxLength={24} minLength={1} required value={name} onChange={(e) => setName(e.target.value)} placeholder="Choose your commander name" /></label>
        {!session?.host && <label>INVITATION CODE<input autoComplete="off" maxLength={96} required value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Enter the code from your host" /></label>}
        <button className="primary" disabled={busy || !session || !graphicsReady || !!graphicsError}>{busy ? 'Connecting…' : session?.host ? 'Join as host-player' : 'Enter the frontier'}<span>↗</span></button>
      </form>}

      {!session?.playerId && mode === 'rejoin' && <form className="connect-form" onSubmit={(event) => { event.preventDefault(); void post('/api/rejoin', { token: rejoinToken.trim() }).then(() => setRejoinToken('')); }}><p className="small-copy">Use the fresh slot invitation issued by the host after restoring a save. Your name and faction are preserved.</p><label>REJOIN TOKEN<input aria-label="Rejoin token" autoComplete="off" required maxLength={256} value={rejoinToken} onChange={(event) => setRejoinToken(event.target.value)} placeholder="Fresh invitation for your command" /></label><button className="primary" disabled={busy || !session || !graphicsReady}>Reclaim my command<span>&#8599;</span></button></form>}
      {!session?.host && !session?.playerId && mode === 'join' && !lobbyEditable && <p className="small-copy">A match is already active. Use a fresh rejoin invitation to reclaim a restored command, or wait for the next lobby.</p>}

      {localHostAccess && !session?.host && !session?.playerId && mode === 'host' && <form onSubmit={(e) => { e.preventDefault(); void post('/api/bootstrap', { token: token.trim() }).then(() => setToken('')); }} className="connect-form">
        <p className="small-copy">Copy the one-time token printed below Host browser in the server console. Use only the host computer's local browser address shown there. The token works once and expires after 10 minutes. A private backup is saved in host-bootstrap.txt at the path printed in the console.</p>
        <label>HOST ACCESS TOKEN<input type="password" autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} placeholder="One-time token" /></label>
        <button className="primary" disabled={busy || !session}>{busy ? 'Authenticating…' : 'Open host controls'}<span>↗</span></button>
      </form>}

      {session?.playerId && lobbyEditable && <div className="joined-card"><span className="eyebrow">YOUR COMMAND</span><h2>{me?.name ?? 'Commander'}</h2><p>{me?.ready ? 'Ready. Waiting for the host to begin.' : 'Mark yourself ready when your company is assembled.'}</p><button className="primary" disabled={busy || !graphicsReady || !!graphicsError} onClick={() => void post('/api/ready', { ready: !me?.ready })}>{me?.ready ? 'Cancel ready' : 'Ready to begin'}<span>{me?.ready ? '✓' : '↗'}</span></button><button className="quiet-button leave-slot" disabled={busy || session.lobby.status !== 'LOBBY'} onClick={() => void post('/api/leave', {})}>Leave player slot</button></div>}

      {session&&lobbyEditable&&<p className="small-copy">Maximum age {session.lobby.settings.maxAge??8} / {session.lobby.settings.startingResourcePreset==='long_war'?'Plentiful distant reserves':'Standard resources'} / Equal starting banks.</p>}
      {session?.playerId && lobbyEditable && <button className="quiet-button" onClick={() => setAssistantOpen(true)}>AI Pilot</button>}

      {session?.host && <div className="host-controls">
        <div className="eyebrow">HOST CONTROLS</div>
        <button className="quiet-button host-recovery-button" aria-label="Saves and recovery" onClick={() => setRecoveryOpen(true)}>Saves & recovery</button>
        {lobbyEditable ? <>
        <label>INVITATION CODE<output className="invite-code">{session.lobby.inviteCode ?? 'Unavailable'}</output></label><button className="quiet-button replace-invitation" disabled={busy || session.lobby.status !== 'LOBBY'} onClick={() => void post('/api/host/invite', {})}>Replace invitation</button>
        <label className="checkbox-label tutorial-lobby"><input type="checkbox" aria-label="Guided quiet practice" checked={session.lobby.settings.tutorial ?? false} disabled={busy || players.some(p => p.kind === 'human' && !p.hostPlayer)} onChange={e => void post('/api/host/lobby', e.target.checked ? { tutorial: true, aiCount: 1, teamPreset: 'free_for_all', mapType: 'open_frontier', mapSize: 'small', populationLimit: 120, sharedVision: false, monumentVictory: false, caretakerEnabled: false } : { tutorial: false })}/>Guided quiet practice</label>
        {session.lobby.settings.tutorial && <p className="small-copy">One host-player and a quiet practice opponent. Standard resources, costs and fog apply. The opponent defends itself but makes no plans or model requests.</p>}
        <fieldset className="match-configuration" disabled={busy || session.lobby.settings.tutorial}>
        <div className="host-row"><label>AI COMMANDERS<select value={session.lobby.settings.aiCount} disabled={busy} onChange={(e) => void post('/api/host/lobby', { aiCount: Number(e.target.value) })}>{[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}</select></label><button className="quiet-button endpoint-shortcut" onClick={() => setEndpointOpen(true)}>AI endpoint & diagnostics</button></div>
        <div className="host-row"><label>MAP<select aria-label="Map type" value={session.lobby.settings.mapType} disabled={busy} onChange={(e) => void post('/api/host/lobby', { mapType: e.target.value })}><option value="open_frontier">Open Frontier</option><option value="river_divide">River Divide</option></select></label><label>POPULATION<select value={session.lobby.settings.populationLimit} disabled={busy} onChange={(e) => void post('/api/host/lobby', { populationLimit: Number(e.target.value) })}>{[80, 120, 200].map((limit) => <option key={limit}>{limit}</option>)}</select></label></div>
        <label className="checkbox-label"><input type="checkbox" checked={session.lobby.settings.sharedVision} disabled={busy} onChange={(e) => void post('/api/host/lobby', { sharedVision: e.target.checked })} />Share vision with teammates</label>
        <label className="checkbox-label"><input type="checkbox" checked={session.lobby.settings.monumentVictory ?? false} disabled={busy} onChange={(e) => void post('/api/host/lobby', { monumentVictory: e.target.checked })} />Enable Monument victory / maximum age {session.lobby.settings.maxAge??8}, ten-minute hold</label>
        <HostLobbyOptions lobby={session.lobby} busy={busy} post={post} />
        </fieldset>
        <button className="primary" disabled={busy || !session.lobby.canStart || !graphicsReady || !!graphicsError} onClick={() => void post('/api/host/start', {})}>Begin match<span>↗</span></button>
        {!session.lobby.canStart && <p className="small-copy">At least two opposing factions and all human players ready are required.</p>}
        </> : <div className="host-running-summary"><h2>Match {session.lobby.status.toLowerCase()}</h2><p className="small-copy">The dedicated host continues running while this browser is open or closed. Manage saved slots and reconnection from Saves & recovery.</p>{['RUNNING', 'PAUSED'].includes(session.lobby.status) && <button className="primary" disabled={busy} onClick={() => void post('/api/host/pause', { paused: session.lobby.status !== 'PAUSED' })}>{session.lobby.status === 'PAUSED' ? 'Resume match' : 'Pause match'}</button>}</div>}
      </div>}

      {error && <div className="notice error" role="alert">{error.replaceAll('_', ' ')}<button className="text-button" onClick={() => { setError(''); void refresh().catch((e: Error) => setError(e.message)); }}>Retry connection</button></div>}
      <div className="scope-note"><span className="scope-dot" /><div>Your frontier, your company<span>Gather · build · train · advance · conquer</span></div></div>
    </section>

    <aside className="lobby-roster">
      <div className="eyebrow">THE COMPANY</div><h2>{players.length ? 'Commanders assembled' : 'The frontier awaits'}</h2>
      {players.length ? <ul>{players.map((player) => <li key={player.id}><span className="player-mark" style={{ backgroundColor: player.color }}><AssetIcon id={`team_heraldry_${player.pattern ?? 0}`} className="roster-heraldry"/></span><span className="roster-identity">{player.name}<small>{player.kind === 'ai' ? session?.lobby.settings.tutorial ? 'Quiet practice opponent' : 'Independent commander' : player.assistant?.enabled ? 'AI-assisted commander' : player.hostPlayer ? 'Host-player' : 'Remote commander'}</small>{session?.host && lobbyEditable ? <select className="team-select" aria-label={`${player.name} team`} disabled={busy || session.lobby.settings.tutorial} value={player.teamId} onChange={(e) => void post('/api/host/team', { playerId: player.id, teamId: e.target.value })}>{teamOptions.map((id) => <option value={id} key={id}>{teamName(id)}</option>)}</select> : <small>{teamName(player.teamId)}</small>}{session?.host && lobbyEditable && <FactionOptions player={player} busy={busy} post={post} />}{session?.host && lobbyEditable && player.kind === 'ai' && <label>MODEL<select aria-label={`${player.name} model`} value={player.aiModelId ?? 'host'} disabled={busy || session.lobby.settings.tutorial || !hostModels.length} onChange={event => void post('/api/host/ai-model', { playerId: player.id, modelId: event.target.value })}>{hostModels.length ? hostModels.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{model.available ? '' : ' (disabled)'}</option>) : <option value="host">Host model</option>}</select></label>}</span><b>{player.kind === 'ai' || player.ready ? 'READY' : 'WAITING'}</b>{session?.host && lobbyEditable && player.kind === 'human' && player.id !== session.playerId && <button className="remove-player" aria-label={`Remove ${player.name}`} disabled={busy} onClick={() => void post('/api/host/remove-player', { playerId: player.id })}>×</button>}</li>)}</ul> : <p>Invite your company.<br />Write your own history.</p>}
      <div className="lobby-meta"><span>{session?.lobby.settings.mapType === 'river_divide' ? 'RIVER DIVIDE' : 'OPEN FRONTIER'}</span><span>FOUNDING AGE</span></div>
    </aside>

    {recoveryOpen && session?.host && <HostRecovery session={session} refreshSession={refresh} close={() => setRecoveryOpen(false)} openReplay={() => { setRecoveryOpen(false); setReplayOpen(true); }} openEndpoint={() => { setRecoveryOpen(false); setEndpointOpen(true); }} />}
    {replayOpen && session?.host && ['LOBBY', 'FINISHED'].includes(session.lobby.status) && <ReplayPanel session={session} close={() => setReplayOpen(false)} />}
    {endpointOpen && session?.host && <EndpointPanel session={session} close={() => setEndpointOpen(false)} />}
    {assistantOpen && session?.playerId && <AssistantPanel session={session} close={() => setAssistantOpen(false)} />}
    {settingsOpen && <SettingsPanel preferences={preferences} change={writePreferences} close={() => setSettingsOpen(false)} />}
    {audioAlert && <div className="sound-text-alert" role="status">{audioAlert.text}</div>}
    <footer className="lobby-footer"><span>ORIGINAL 3D REAL-TIME STRATEGY</span><span>WASD pan <b>·</b> Scroll zoom <b>·</b> Middle-drag rotate</span><span>{graphicsReady ? 'WEBGL2' : 'CHECKING GRAPHICS'}</span></footer>
    {graphicsError && <section className="graphics-error" role="alert"><div className="eyebrow">GRAPHICS NEED ATTENTION</div><h2>Let’s get your frontier ready.</h2><p>{graphicsError}</p><button className="primary" onClick={() => window.location.reload()}>Retry graphics<span>↻</span></button></section>}
    <div className="small-screen-notice">Desktop mouse and keyboard are required for gameplay. Use a window at least 1024 × 680.</div>
  </main>;
}
