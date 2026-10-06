import { useEffect, useState } from 'react';
import { defaultPreferences, HOTKEYS, keyLabel, rebind, type Hotkey, type Preferences } from './preferences';
import { useModalFocus } from './modalFocus';

export function SettingsPanel({ preferences, change, close }: { preferences: Preferences; change: (next: Preferences) => void; close: () => void }) {
  const [capture, setCapture] = useState<Hotkey | null>(null), [error, setError] = useState('');
  const panel = useModalFocus(true, close);
  useEffect(() => {
    if (!capture) return;
    const key = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') { setCapture(null); return; }
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey && event.key !== 'Alt') { setError('Use one key. Ctrl assigns control groups; Shift queues commands.'); return; }
      try { change(rebind(preferences, capture, event.key)); setCapture(null); setError(''); }
      catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not bind that key.'); }
    };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [capture, preferences, change]);
  return <div className="settings-overlay" data-gameplay-hotkeys="suspend"><section ref={panel} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-heading">
    <header><div><span className="eyebrow">MAKE YOURSELF AT HOME</span><h2 id="settings-heading">Settings & controls</h2></div><button className="quiet-button" aria-label="Close settings" onClick={close}>Close</button></header>
    <div className="settings-grid"><label>Graphics quality<select aria-label="Graphics quality" value={preferences.quality} onChange={e => change({ ...preferences, quality: e.target.value as Preferences['quality'] })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><small>Changes shadows, resolution, detail distance and effects. Visibility rules stay the same.</small></label><label>Interface size — {Math.round(preferences.uiScale * 100)}%<input aria-label="Interface scale" type="range" min="80" max="150" step="5" value={Math.round(preferences.uiScale * 100)} onChange={e => change({ ...preferences, uiScale: Number(e.target.value) / 100 })}/><small>80–150%. Panels scroll when space is limited.</small></label></div>
    <div className="settings-checks"><label><input type="checkbox" checked={preferences.reducedMotion} onChange={e => change({ ...preferences, reducedMotion: e.target.checked })}/>Reduced motion</label><label><input type="checkbox" checked={preferences.edgePan} onChange={e => change({ ...preferences, edgePan: e.target.checked })}/>Pan at screen edges</label><label><input type="checkbox" checked={preferences.muted} onChange={e => change({ ...preferences, muted: e.target.checked })}/>Mute all sound</label></div>
    <div className="settings-grid"><label>Music — {Math.round(preferences.musicVolume * 100)}%<input aria-label="Music volume" type="range" min="0" max="100" value={Math.round(preferences.musicVolume * 100)} onChange={e => change({ ...preferences, musicVolume: Number(e.target.value) / 100 })}/></label><label>Effects — {Math.round(preferences.effectsVolume * 100)}%<input aria-label="Effects volume" type="range" min="0" max="100" value={Math.round(preferences.effectsVolume * 100)} onChange={e => change({ ...preferences, effectsVolume: Number(e.target.value) / 100 })}/></label></div>
    <p className="settings-copy">Important alerts also appear as text. Each faction has its own color and heraldic pattern. Arrow keys pan until assigned to another action. Mouse wheel zooms; middle-drag rotates. Shift queues orders; Ctrl + a group key assigns that group.</p>
    <h3>Keyboard</h3><p className="settings-copy">Choose an action, then press its new key. Escape cancels rebinding. Controls are suspended while a dialog or text field has focus.</p>
    {error && <p role="alert" className="notice">{error}</p>}
    <div className="keybindings">{(Object.keys(HOTKEYS) as Hotkey[]).map(action => <div key={action}><span>{HOTKEYS[action][0]}</span><button className="quiet-button" aria-label={`Rebind ${HOTKEYS[action][0]}`} aria-pressed={capture === action} onClick={() => { setCapture(action); setError(''); }}>{capture === action ? 'Press a key…' : keyLabel(preferences.bindings[action])}</button></div>)}</div>
    <footer><button className="quiet-button" onClick={() => { setCapture(null); setError(''); change(defaultPreferences()); }}>Restore defaults</button><span>Settings are saved on this browser when storage is available.</span></footer>
  </section></div>;
}
