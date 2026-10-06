export const HOTKEYS = {
  panForward: ['Pan forward', 'w'], panBack: ['Pan backward', 's'], panLeft: ['Pan left', 'a'], panRight: ['Pan right', 'd'], cameraHome: ['Return to base', 'home'], health: ['Show health bars', 'alt'],
  cancel: ['Cancel / clear selection', 'escape'], rotateLeft: ['Rotate placement left', 'q'], rotateRight: ['Rotate placement right', 'e'], townCenter: ['Next Town Center', 'h'], idleWorker: ['Next idle Villager', '.'], stop: ['Stop', 'x'], move: ['Move', 'm'], attackMove: ['Attack move', 'b'], attackTarget: ['Attack target', 't'], patrol: ['Patrol', 'p'], garrison: ['Garrison', 'g'], attackGround: ['Attack ground', 'f'], holdPosition: ['Hold position', 'j'],
  group1: ['Control group 1', '1'], group2: ['Control group 2', '2'], group3: ['Control group 3', '3'], group4: ['Control group 4', '4'], group5: ['Control group 5', '5'], group6: ['Control group 6', '6'], group7: ['Control group 7', '7'], group8: ['Control group 8', '8'], group9: ['Control group 9', '9'],
} as const;
export type Hotkey = keyof typeof HOTKEYS;
export interface Preferences {
  quality: 'low'|'medium'|'high'; uiScale: number; muted: boolean; musicVolume: number; effectsVolume: number;
  reducedMotion: boolean; edgePan: boolean; bindings: Record<Hotkey, string>;
}
const storageKey = 'frontier.preferences.v1', changed = 'frontier-preferences-changed';
const keyAllowed = (key: unknown): key is string => typeof key === 'string' && (/^[a-z0-9.,;/'\[\]\\=\-]$/.test(key) || ['escape', 'home', 'end', 'pageup', 'pagedown', 'tab', 'alt', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'insert', 'delete'].includes(key));
export function defaultPreferences(): Preferences {
  return { quality: 'medium', uiScale: 1, muted: false, musicVolume: .16, effectsVolume: .55, reducedMotion: typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches, edgePan: false, bindings: Object.fromEntries(Object.entries(HOTKEYS).map(([id, [, key]]) => [id, key])) as Record<Hotkey, string> };
}
export function validPreferences(value: unknown): value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as Preferences;
  return Object.keys(p).sort().join(',') === 'bindings,edgePan,effectsVolume,musicVolume,muted,quality,reducedMotion,uiScale'
    && ['low', 'medium', 'high'].includes(p.quality) && Number.isFinite(p.uiScale) && p.uiScale >= .8 && p.uiScale <= 1.5
    && typeof p.muted === 'boolean' && typeof p.reducedMotion === 'boolean' && typeof p.edgePan === 'boolean'
    && [p.musicVolume, p.effectsVolume].every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    && !!p.bindings && typeof p.bindings === 'object' && Object.keys(p.bindings).sort().join(',') === Object.keys(HOTKEYS).sort().join(',')
    && Object.values(p.bindings).every(keyAllowed) && new Set(Object.values(p.bindings)).size === Object.keys(HOTKEYS).length;
}
let inMemory: Preferences | undefined;
export function readPreferences(): Preferences {
  if (inMemory) return structuredClone(inMemory);
  try { const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null'); if (validPreferences(parsed)) return structuredClone(inMemory = parsed); } catch { /* Storage is optional. */ }
  return structuredClone(inMemory = defaultPreferences());
}
export function writePreferences(preferences: Preferences): void {
  if (!validPreferences(preferences)) throw new Error('Invalid controls or accessibility settings.');
  inMemory = structuredClone(preferences);
  try { localStorage.setItem(storageKey, JSON.stringify(preferences)); } catch { /* The current session still uses these settings. */ }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(changed));
}
export function subscribePreferences(listener: (preferences: Preferences) => void): () => void {
  const update = () => listener(readPreferences()), storage = (event: StorageEvent) => { if (event.key === storageKey) { inMemory = undefined; update(); } };
  window.addEventListener(changed, update); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changed, update); window.removeEventListener('storage', storage); };
}
export function suppressGameplayHotkeys(target: EventTarget | null): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('[data-modal-active]')
    || typeof HTMLElement !== 'undefined' && target instanceof HTMLElement && (target.isContentEditable || !!target.closest('input, textarea, select, [data-gameplay-hotkeys="suspend"], [role="dialog"], [role="alertdialog"]'));
}
const panAliases = { panForward: 'arrowup', panBack: 'arrowdown', panLeft: 'arrowleft', panRight: 'arrowright' } as const;
export function heldPanKey(keys: ReadonlySet<string>, action: keyof typeof panAliases, preferences: Pick<Preferences, 'bindings'>): boolean {
  if (keys.has(preferences.bindings[action])) return true;
  const alias = panAliases[action];
  return keys.has(alias) && !Object.values(preferences.bindings).includes(alias);
}
export function matchesHotkey(event: Pick<KeyboardEvent, 'key'>, action: Hotkey, preferences: Pick<Preferences, 'bindings'>): boolean {
  return event.key.toLowerCase() === preferences.bindings[action];
}
export const keyLabel = (key: string) => ({ arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', escape: 'Esc', home: 'Home', alt: 'Alt', tab: 'Tab', backspace: 'Backspace', delete: 'Delete', insert: 'Insert', pageup: 'PgUp', pagedown: 'PgDn', end: 'End' }[key] ?? key.toUpperCase());
export function rebind(preferences: Preferences, action: Hotkey, key: string): Preferences {
  key = key.toLowerCase();
  if (!keyAllowed(key)) throw new Error('Choose a letter, number, punctuation, arrow, or navigation key. Browser shortcuts and modifier combinations are reserved.');
  const conflict = Object.entries(preferences.bindings).find(([id, binding]) => id !== action && binding === key);
  if (conflict) throw new Error(`${keyLabel(key)} is already assigned to ${HOTKEYS[conflict[0] as Hotkey][0]}. Change that binding first.`);
  return { ...preferences, bindings: { ...preferences.bindings, [action]: key } };
}
