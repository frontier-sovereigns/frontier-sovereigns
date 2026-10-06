import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { balance, resolveRuleset, PROTOCOL_VERSION, validateSessionResponse, validateChatStateResponse, type ChatStateResponse, type ClientCommandEnvelope, type GameplayCommand, type PlayerView, type SessionResponse } from '@frontier/shared';
import type { World } from './World';
import { ViewStream, nextCommandSequence, type StreamResult } from './ViewStream';
import type { CommandObservation } from './Tutorial';
import { browserDeliveryDiagnostics, browserResponseProbe } from './BrowserResponseDiagnostics';

const readStorage = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const writeStorage = (key: string, value: string): void => { try { localStorage.setItem(key, value); } catch { /* Private mode can disallow storage; in-memory dedup still works. */ } };
function commandId(): string { return `cmd_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`; }

export function gameSocketUrl(locationHref: string): URL {
  const url = new URL('/ws', locationHref); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('deltaChunks', '1'); return url;
}

export function useGame(session: SessionResponse | null, setSession: Dispatch<SetStateAction<SessionResponse | null>>, world: RefObject<World | null>, onError: (error: string) => void, graphicsReady: boolean, beginSessionRotation: () => () => void) {
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef<PlayerView | null>(null);
  const synchronized = useRef(false);
  const pending = useRef(new Map<string, ClientCommandEnvelope>());
  const commandOrigins = useRef(new Map<string, Omit<CommandObservation, 'envelope'|'receipt'>>());
  const [commandObservations, setCommandObservations] = useState<CommandObservation[]>([]);
  const sequences = useRef(new Map<string, number>());
  const [view, setView] = useState<PlayerView | null>(null);
  const [connection, setConnection] = useState('Connecting');
  const [receipt, setReceipt] = useState('');
  const [pendingCount, setPendingCount] = useState(0);
  const [communication, setCommunication] = useState<ChatStateResponse | null>(null);
  const communicationVersion = useRef(0);
  const sessionRef = useRef(session); sessionRef.current = session;

  const refreshCommunication = useCallback(async () => {
    const playerId = sessionRef.current?.playerId, epoch = latest.current?.matchEpoch, version = communicationVersion.current;
    if (!playerId) { setCommunication(null); return; }
    const response = await fetch('/api/chat', { credentials: 'same-origin' }); const value: unknown = await response.json();
    if (!response.ok || !validateChatStateResponse(value)) throw new Error('Could not receive authorized messages.');
    if (sessionRef.current?.playerId === playerId && latest.current?.matchEpoch === epoch && communicationVersion.current === version) { communicationVersion.current++; setCommunication(value); }
  }, []);

  useEffect(() => {
    if (latest.current && latest.current.playerId !== session?.playerId) { browserResponseProbe.observe(probe=>probe.boundary('recipient-change')); synchronized.current = false; latest.current = null; setView(null); setCommunication(null); pending.current.clear(); setPendingCount(0); world.current?.showLobby(); }
    if ((!session?.host && !session?.playerId) || !graphicsReady) return;
    let stopped = false, timer = 0, monitor = 0, failures = 0;
    function connect() {
      if (stopped) return;
      browserDeliveryDiagnostics.boundary();
      const url = gameSocketUrl(window.location.href);
      const connection = new WebSocket(url); socket.current = connection;
      const settings=sessionRef.current?.lobby.settings;
      const stream = new ViewStream(sessionRef.current?.playerId,resolveRuleset(settings?.rulesetId,settings?.maxAge,settings?.startingResourcePreset).contentHash);
      let loadedKey = '', resentKey = '', lastViewAt = performance.now();
      synchronized.current = false;
      world.current?.setStreamActive(false);
      const handle = (result: StreamResult, receivedAtMs?:number): void => {
        if (result.type === 'pending') return;
        if (result.type === 'resync') {
          browserDeliveryDiagnostics.boundary();
          browserResponseProbe.observe(probe=>probe.boundary('resynchronizing'));
          synchronized.current = false;
          world.current?.setStreamActive(false); setConnection('Synchronizing');
          if (result.reason) onError(result.reason);
          if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'resync' }));
          return;
        }
        if (result.type === 'event') {
          const message = result.message;
          if (message.type === 'communication') { communicationVersion.current++; setCommunication(message.state); return; }
          if (message.type === 'command_received') {
            // Receipt confirms only authenticated queue admission, not gameplay
            // validation or execution. Keep the command pending for its decision.
            const command = pending.current.get(message.commandId);
            if (command?.clientSequence === message.sequence) {
              browserResponseProbe.observe(probe=>probe.gatewayReceived(message.commandId,message.sequence,receivedAtMs));
              setReceipt('Order received; awaiting host decision');
            }
            return;
          }
          if (message.type === 'lobby') {
            stream.setContentHash(resolveRuleset(message.lobby.settings.rulesetId,message.lobby.settings.maxAge,message.lobby.settings.startingResourcePreset).contentHash);
            setSession((current) => current ? { ...current, lobby: message.lobby } : current);
            if (['SETUP', 'LOBBY', 'ARCHIVED'].includes(message.lobby.status)) {
              browserDeliveryDiagnostics.boundary();
              browserResponseProbe.observe(probe=>probe.boundary('lobby-boundary'));
              synchronized.current = false; stream.reset(); latest.current = null; setView(null); setCommunication(null); pending.current.clear(); setPendingCount(0); setReceipt(''); world.current?.showLobby(); loadedKey = ''; resentKey = ''; setConnection('Connected');
            } else if (message.lobby.status === 'COUNTDOWN' && latest.current) {
              latest.current = { ...latest.current, status: 'COUNTDOWN' }; setView(latest.current);
            }
            return;
          }
          if (message.type === 'error') { onError(message.code.replaceAll('_', ' ')); return; }
          const envelope = pending.current.get(message.receipt.clientCommandId), observed = commandOrigins.current.get(message.receipt.clientCommandId);
          browserResponseProbe.observe(probe=>probe.receipt(message.receipt,receivedAtMs));
          if (envelope && observed) setCommandObservations(events => [...events, { envelope, receipt: message.receipt, ...observed }].slice(-96));
          commandOrigins.current.delete(message.receipt.clientCommandId);
          pending.current.delete(message.receipt.clientCommandId); setPendingCount(pending.current.size);
          const missing = Object.entries(message.receipt.missingResources ?? {}).filter(([, amount]) => amount > 0).map(([resource, amount]) => `${amount} ${resource}`).join(', ');
          const code = message.receipt.code === 'ORDER_QUEUE_FULL' ? `Order queue full: at most ${balance.rules.orderQueueLimit} queued orders per unit` : message.receipt.code?.replaceAll('_', ' ') ?? 'Order rejected';
          const rejection = `${code}${missing ? ` - missing ${missing}` : ''}`;
          setReceipt(message.receipt.status === 'accepted' ? 'Order accepted' : rejection);
          if (message.receipt.status === 'rejected') onError(rejection);
          return;
        }
        const next = result.view;
        synchronized.current = true;
        if (latest.current && (latest.current.matchId !== next.matchId || latest.current.matchEpoch !== next.matchEpoch || latest.current.playerId !== next.playerId)) setCommandObservations([]);
        latest.current = next; lastViewAt = performance.now();
        const applyStartedMs=performance.now();
        world.current?.setView(next, result.resetInterpolation); world.current?.setStreamActive(next.status === 'RUNNING'); setView(next); setConnection('Connected');
        browserDeliveryDiagnostics.applied(next,applyStartedMs);
        browserResponseProbe.observe(probe=>probe.applied(next,receivedAtMs??performance.now()));
        const key = `${next.matchId}-${next.matchEpoch}`;
        for (const id of commandOrigins.current.keys()) if (!pending.current.has(id)) commandOrigins.current.delete(id);
        for (const [id, command] of pending.current) if (command.matchId !== next.matchId || command.matchEpoch !== next.matchEpoch) pending.current.delete(id);
        setPendingCount(pending.current.size);
        if (next.status === 'LOADING' && loadedKey !== key && world.current) {
          loadedKey = key;
          world.current.scene.executeWhenReady(() => { if (!stopped && connection.readyState === WebSocket.OPEN && latest.current?.matchId === next.matchId && latest.current.matchEpoch === next.matchEpoch) connection.send(JSON.stringify({ type: 'loaded', contentHash:next.contentHash, matchId: next.matchId, matchEpoch: next.matchEpoch })); });
        }
        if (next.status === 'RUNNING' && resentKey !== key) {
          resentKey = key;
          for (const command of pending.current.values()) connection.send(JSON.stringify(command));
        }
      };
      connection.onopen = () => {
        failures = 0; if (sessionRef.current?.playerId) handle(stream.requestSnapshot(performance.now())); else setConnection('Connected');
        monitor = window.setInterval(() => {
          if (stopped || connection.readyState !== WebSocket.OPEN) return;
          browserResponseProbe.observe(probe=>probe.poll());
          handle(stream.poll(performance.now()));
          const expectedViewIntervalMs = (latest.current?.publicationIntervalMs ?? 1000 / balance.rules.replicationHz) / (latest.current?.simulationSpeed ?? 1);
          if(!stream.synchronizing&&latest.current?.status==='RUNNING')browserDeliveryDiagnostics.poll(Math.max(500,5*expectedViewIntervalMs),document.visibilityState!=='visible');
          if (!stream.synchronizing && latest.current?.status === 'RUNNING' && performance.now() - lastViewAt > Math.max(500, 5 * expectedViewIntervalMs)) setConnection('Delayed');
        }, 250);
      };
      connection.onmessage = (event: MessageEvent<string>) => {
        if (stopped) return;
        const receivedAtMs=performance.now();browserDeliveryDiagnostics.message(receivedAtMs);
        if (typeof event.data !== 'string' || event.data.length > 16 * 1024 * 1024) { handle(stream.requestSnapshot(performance.now(), 'Invalid host message size.')); return; }
        let message: unknown; try { message = JSON.parse(event.data); } catch { handle(stream.requestSnapshot(performance.now(), 'Invalid host message. Requesting a new viewpoint.')); return; }
        const result=stream.ingest(message, performance.now());browserDeliveryDiagnostics.validated(performance.now()-receivedAtMs);
        handle(result,receivedAtMs);
      };
      connection.onerror = () => { if (stopped) return; browserDeliveryDiagnostics.boundary(); browserResponseProbe.observe(probe=>probe.boundary('connection-error')); synchronized.current = false; setConnection('Connection interrupted'); world.current?.setStreamActive(false); };
      connection.onclose = () => {
        if (stopped) return;
        browserDeliveryDiagnostics.boundary();
        browserResponseProbe.observe(probe=>probe.boundary('reconnecting'));
        synchronized.current = false; window.clearInterval(monitor); stream.reset(); world.current?.setStreamActive(false); setConnection('Reconnecting');
        timer = window.setTimeout(async () => {
          if (stopped) return;
          const csrf = sessionRef.current?.csrfToken;
          const finishSessionRotation = beginSessionRotation();
          try {
            const response = await fetch('/api/reconnect', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, body: '{}' });
            if (response.ok) { const refreshed: unknown = await response.json(); if (!validateSessionResponse(refreshed)) throw new Error('Invalid reconnect response'); sessionRef.current = refreshed; setSession(refreshed); }
            else if (response.status === 401) { setConnection('Session expired'); onError('Your session expired. Reopen the lobby to reconnect.'); return; }
          } catch { /* Retry after an unavailable host. The current viewpoint stays frozen. */ }
          finally { finishSessionRotation(); }
          connect();
        }, Math.min(5000, 1000 * ++failures));
      };
    }
    connect();
    return () => { browserDeliveryDiagnostics.boundary(); browserResponseProbe.observe(probe=>probe.boundary('connection-owner-disposed'));  stopped = true; synchronized.current = false; window.clearTimeout(timer); window.clearInterval(monitor); world.current?.setStreamActive(false); socket.current?.close(); socket.current = null; };
  }, [session?.host, session?.playerId, graphicsReady, setSession, world, onError, beginSessionRotation]);

  const send = useCallback((command: GameplayCommand) => {
    const current = latest.current;
    if (!current || !synchronized.current || current.status !== 'RUNNING' || socket.current?.readyState !== WebSocket.OPEN) { onError(current?.status === 'PAUSED' ? 'The host has paused the game.' : 'Waiting for the host connection.'); return; }
    if (pending.current.size >= 60) { onError('Waiting for outstanding orders.'); return; }
    const key = `frontier-sequence-${current.playerId}-${current.matchId}-${current.matchEpoch}`;
    let sequence: number; try { sequence = nextCommandSequence(sequences.current.get(key) ?? 0, readStorage(key), current.self.lastCommandSequence); } catch (error) { onError(error instanceof Error ? error.message : 'Could not allocate a command sequence.'); return; } sequences.current.set(key, sequence); writeStorage(key, String(sequence));
    const envelope: ClientCommandEnvelope = { protocolVersion: PROTOCOL_VERSION, matchId: current.matchId, matchEpoch: current.matchEpoch, clientCommandId: commandId(), clientSequence: sequence, command };
    commandOrigins.current.set(envelope.clientCommandId, { sentTick: current.tick,
      ...(command.kind === 'train' ? { initialUnitIds: current.entities.filter(e => e.ownerId === current.playerId && e.kind === 'unit').map(e => e.id) } : {}),
      ...(command.kind === 'move' ? { origins: Object.fromEntries(current.entities.filter(e => command.unitIds.includes(e.id) && e.ownerId === current.playerId).map(e => [e.id, { xMm: e.xMm, zMm: e.zMm }])) } : {}),
      ...(command.kind === 'attack_target' ? { targetHp: current.entities.find(e => e.id === command.targetId && !e.ghost)?.hp } : {}),
    });
    pending.current.set(envelope.clientCommandId, envelope); setPendingCount(pending.current.size); setReceipt('Order sent');
    browserResponseProbe.observe(probe=>probe.issue(envelope,current));
    try{socket.current.send(JSON.stringify(envelope));}catch(error){browserResponseProbe.observe(probe=>probe.boundary('send-failed'));throw error;}
  }, [onError]);

  return { view, connection, receipt, pendingCount, send, communication, refreshCommunication, commandObservations };
}
