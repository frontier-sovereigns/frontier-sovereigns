import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatMessage, ChatStateResponse, PlayerView, SessionResponse } from '@frontier/shared';
import { Communications, CommanderSummary, commanderModeLabel } from './Communications';
import type { World } from './World';

const players: PlayerView['players'] = [{ id: 'me', name: 'Aster', teamId: 'one', kind: 'human', color: '#54bec9' }, { id: 'ally', name: 'Alder', teamId: 'one', kind: 'ai', color: '#e4a85c', aiMode: 'fallback' }, { id: 'enemy', name: 'Briar', teamId: 'two', kind: 'ai', color: '#a6be67', aiMode: 'model' }];
const view: PlayerView = { protocolVersion: 2, contentHash: 'presentation-fixture', matchId: 'fixture', matchEpoch: 1, tick: 20, sequence: 2, playerId: 'me', status: 'RUNNING', map: { widthMm: 100000, heightMm: 100000, fogCellMm: 2000 }, self: { lastCommandSequence: 0, resources: { food: 0, wood: 0, gold: 0, stone: 0 }, age: 1, population: 0, populationCap: 15, populationLimit: 120, reservedPopulation: 0 }, players, entities: [], fog: { visible: [], explored: [] } };
const session = { protocolVersion: 2, contentHash: 'presentation-fixture', csrfToken: null, host: false, playerId: 'me', lobby: { status: 'RUNNING', players: [], settings: { aiCount: 2, mapType: 'open_frontier', populationLimit: 120, sharedVision: true }, canStart: false } } as SessionResponse;
const message = (changes: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'message_1', tick: 10, senderId: 'ally', channel: 'team', source: 'model', text: 'I plan to defend your base.', requestId: 'request_abcdef', status: 'planned', ...changes });
function render(messages: ChatMessage[], sendHumanChat = false, currentView = view) { const state: ChatStateResponse = { messages, pings: [], sendHumanChat }; return renderToStaticMarkup(createElement(Communications, { view: currentView, session, state, world: { camera: { target: { x: 1, z: 1 } } } as World, close: () => undefined, changed: async () => undefined })); }

it('renders untrusted text as text and keeps model plans distinct from authoritative completion', () => {
  const html = render([message({ text: '<img src=x onerror="doSomething()"> I completed everything.' })]);
  expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  expect(html).toContain('Model reply'); expect(html).toContain('request-planned'); expect(html).not.toContain('request-completed');
  const completed = render([message(), message({ id: 'message_2', source: 'system', status: 'completed', text: 'Requested transfer completed.' })]);
  expect(completed).toContain('System outcome'); expect(completed).toContain('request-completed');
  expect(completed.match(/data-request-id="request_abcdef"/g)).toHaveLength(2);
});
it('keeps presets available with human text forwarding off and exposes only allied AI request choices', () => {
  const html = render([]);
  expect(html).toContain('Free-form text is not sent to the model'); expect(html).toContain('Request base defense');
  expect(html).toContain('value="ally"'); expect(html).not.toContain('value="enemy"');
  expect(commanderModeLabel('fallback')).toContain('rule-based commander active'); expect(commanderModeLabel('model')).toBe('Strategic model active');
});

it('shows defeated commanders as eliminated and excludes them from active model and fallback totals', () => {
  const current = { ...view, players: players.map(player => ({ ...player, defeated: player.id === 'ally' })) };
  const html = render([], false, current);
  expect(html).toContain('<b>Alder</b><small>Eliminated</small>');
  expect(html).not.toContain('value="ally"');
  expect(commanderModeLabel('model', true)).toBe('Eliminated');
  expect(commanderModeLabel('fallback', true)).toBe('Eliminated');
  const summary = (roster: PlayerView['players']) => renderToStaticMarkup(createElement(CommanderSummary, { players: roster, open: () => undefined }));
  expect(summary(current.players)).toContain('Strategic model active');
  expect(summary(current.players)).toContain('1 model / 0 rule-based · 1 eliminated');
  const fallback = players.map(player => ({ ...player, defeated: player.id === 'enemy' }));
  expect(summary(fallback)).toContain('0 model / 1 rule-based · 1 eliminated');
  const eliminated = summary(players.map(player => ({ ...player, defeated: true })));
  expect(eliminated).toContain('All AI factions eliminated');
  expect(eliminated).toContain('0 model / 0 rule-based · 2 eliminated');
  expect(eliminated).not.toContain('commander active');
  expect(summary([players[0]!])).toBe('');
});
