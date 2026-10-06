import { useEffect, useMemo, useRef, useState } from 'react';
import { validateAssistantOptionsResponse, validateAssistantPreferences, type AssistantOptionsResponse, type AssistantPreferences, type SessionResponse } from '@frontier/shared';
import { useModalFocus } from './modalFocus';

const resources = ['food', 'wood', 'gold', 'stone'] as const;
const labels: Record<AssistantOptionsResponse['assistant']['status'], string> = {
  manual: 'You are in control', model: 'AI Pilot active', fallback: 'Rule-based AI Pilot active',
  paused: 'AI Pilot paused', unavailable: 'Selected model unavailable',
};

export function AssistantPanel({ session, selectedIds = [], close }: { session: SessionResponse; selectedIds?: string[]; close: () => void }) {
  const modal = useModalFocus(true, close);
  const [data, setData] = useState<AssistantOptionsResponse | null>(null), [draft, setDraft] = useState<AssistantPreferences | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const editing = useRef(false), mutation = useRef(false), revision = useRef(0), mounted = useRef(true);
  const editable = ['LOBBY', 'RUNNING', 'PAUSED'].includes(session.lobby.status) && !session.lobby.settings.tutorial;
  const canRelease = editable && ['RUNNING', 'PAUSED'].includes(session.lobby.status);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function accept(value: unknown, resetDraft: boolean) {
    if (!validateAssistantOptionsResponse(value)) throw new Error('The host returned incompatible AI Pilot settings.');
    setData(value);
    if (resetDraft || !editing.current) setDraft(structuredClone(value.assistant.preferences));
  }
  useEffect(() => {
    let stopped = false, pending = false, controller: AbortController | undefined;
    async function poll() {
      if (stopped || pending || mutation.current) return;
      pending = true; controller = new AbortController(); const observedRevision = revision.current;
      try {
        const response = await fetch('/api/assistant', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const value: unknown = await response.json();
        if (!response.ok) throw new Error('Could not read your AI Pilot settings.');
        if (!stopped && observedRevision === revision.current) accept(value, false);
      } catch (problem) { if (!stopped && observedRevision === revision.current) setError(problem instanceof Error ? problem.message : 'AI Pilot settings are unavailable.'); }
      finally { pending = false; }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 3000);
    return () => { stopped = true; window.clearInterval(timer); controller?.abort(); };
  }, [session.playerId]);
  async function request(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(session.csrfToken ? { 'X-CSRF-Token': session.csrfToken } : {}) }, body: JSON.stringify(body) });
    const value: unknown = await response.json();
    if (!response.ok) { const problem = value as { message?: string; code?: string }; throw new Error((problem.message ?? problem.code ?? 'AI Pilot update failed.').replaceAll('_', ' ')); }
    return value;
  }
  async function action(work: () => Promise<void>) {
    if (mutation.current) return;
    mutation.current = true; revision.current++; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (problem) { setError(problem instanceof Error ? problem.message : 'AI Pilot update failed.'); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function save(preferences: AssistantPreferences) {
    if (!validateAssistantPreferences(preferences)) throw new Error('Choose a model and enter whole resource reserves between 0 and 1,000,000.');
    const value = await request('/api/assistant', preferences); accept(value, true); editing.current = false;
    setNotice(preferences.enabled ? 'AI Pilot enabled. You can continue giving orders.' : 'AI Pilot paused. Existing game orders continue.');
  }
  async function release(entityIds: string[]) {
    // Bound each request and leave time for the owner's write bucket to refill.
    for (let offset = 0; offset < entityIds.length; offset += 200) {
      if (offset) await new Promise<void>(resolve => window.setTimeout(resolve, 1000));
      if (!mounted.current) return;
      accept(await request('/api/assistant/release', { entityIds: entityIds.slice(offset, offset + 200) }), false);
    }
    setNotice('Selected units and buildings returned to AI Pilot control.');
  }
  const protectedIds = data?.assistant.protectedEntityIds ?? [];
  const protectedSet = useMemo(() => new Set(data?.assistant.protectedEntityIds ?? []), [data?.assistant.protectedEntityIds]);
  const protectedSelected = [...new Set(selectedIds)].filter(id => protectedSet.has(id));
  const selectedModel = data?.models.find(model => model.id === draft?.modelId);
  return <div className="dialog-overlay"><section ref={modal} className="endpoint-panel host-recovery" role="dialog" aria-modal="true" aria-label="AI Pilot">
    <header><div><span className="eyebrow">YOUR COMMAND</span><h2>AI Pilot</h2></div><button className="quiet-button" aria-label="Close AI Pilot" onClick={close}>Close</button></header>
    <p className="small-copy">Choose a model supplied by your host to manage your faction. Watch it play or give your own orders at any time.</p>
    {error && <p role="alert" className="recovery-error">{error}</p>}{notice && <p role="status" className="recovery-notice">{notice}</p>}
    {data && <div className="endpoint-current" role="status"><b>{labels[data.assistant.status]}</b><span>{data.models.find(model => model.id === data.assistant.preferences.modelId)?.label ?? 'No model selected'}</span></div>}
    {!editable && <p className="small-copy">{session.lobby.settings.tutorial ? 'AI Pilot is unavailable in guided practice.' : 'AI Pilot can be changed in the lobby or during a match.'}</p>}
    {draft && data ? <form onSubmit={event => { event.preventDefault(); void action(() => save(draft)); }}>
      <fieldset disabled={busy || !editable} className="endpoint-section">
        <label>AI PILOT MODEL<select aria-label="AI Pilot model" value={draft.modelId ?? ''} onChange={event => { editing.current = true; setDraft({ ...draft, modelId: event.target.value || null, ...(event.target.value ? {} : { enabled: false }) }); }}>
          <option value="">Choose a model</option>{data.models.map(model => <option key={model.id} value={model.id} disabled={!model.available}>{model.label}{model.available ? '' : ' (unavailable)'}</option>)}
          {draft.modelId && !selectedModel && <option value={draft.modelId} disabled>Previously selected model unavailable</option>}
        </select></label>
        <label className="checkbox-label"><input type="checkbox" aria-label="Enable AI Pilot" checked={draft.enabled} disabled={!selectedModel?.available} onChange={event => { editing.current = true; setDraft({ ...draft, enabled: event.target.checked }); }}/>Enable AI Pilot</label>
        <h3>Keep resources for your orders</h3><p className="small-copy">AI Pilot spending leaves these amounts available for you. Your own orders can spend them.</p>
        <div className="endpoint-fields">{resources.map(resource => <label key={resource}>{resource.toUpperCase()} RESERVE<input aria-label={`${resource} reserve`} type="number" min={0} max={1000000} step={1} required value={draft.reserve[resource]} onChange={event => { editing.current = true; setDraft({ ...draft, reserve: { ...draft.reserve, [resource]: Number(event.target.value) } }); }}/></label>)}</div>
        <button className="primary endpoint-save" disabled={draft.enabled && !selectedModel?.available}>Save AI Pilot settings</button>
      </fieldset>
      {data.assistant.preferences.enabled && <button type="button" className="quiet-button" disabled={busy || !editable} onClick={() => void action(() => save({ ...data.assistant.preferences, enabled: false }))}>Pause AI Pilot now</button>}
    </form> : <p className="small-copy">Reading your AI Pilot settings...</p>}
    {data && <section className="endpoint-section"><h3>Your manual orders</h3><p className="small-copy">Manual tasks are protected while they run. AI Pilot resumes after a brief idle period; ongoing orders and Stop or Hold remain yours until released. {protectedIds.length} protected.</p><button className="quiet-button" disabled={busy || !canRelease || !protectedSelected.length} onClick={() => void action(() => release(protectedSelected))}>Return selected to AI Pilot ({protectedSelected.length})</button>{protectedIds.length > 0 && <button className="quiet-button" disabled={busy || !canRelease} onClick={() => void action(() => release([...new Set(protectedIds)]))}>Return all protected to AI Pilot</button>}<p className="small-copy">Close this panel to select units or buildings, then reopen AI Pilot to return your selection. Your auto-reseed preference stays in effect.</p></section>}
  </section></div>;
}
