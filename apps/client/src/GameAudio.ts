import { units, balance, type PlayerView, type Position } from '@frontier/shared';
import { readPreferences, subscribePreferences, type Preferences } from './preferences';

export interface GameSound { id: string; position?: Position; alert?: string }
/** Sound uses only this recipient's filtered stream. Ghosts never produce events. */
export function deriveAudioEvents(before: PlayerView | null, next: PlayerView): GameSound[] {
  if (!before || before.matchId !== next.matchId || before.playerId !== next.playerId || before.matchEpoch !== next.matchEpoch || next.tick <= before.tick || !['RUNNING', 'FINISHED'].includes(next.status)) return [];
  const events: GameSound[] = [], previous = new Map(before.entities.map(entity => [entity.id, entity]));
  let attacked = false, blocked = false;
  for (const entity of next.entities) {
    if (entity.ghost || entity.garrisonedIn) continue;
    const old = previous.get(entity.id), position = { xMm: entity.xMm, zMm: entity.zMm };
    if (entity.ownerId === next.playerId) {
      if (old && !old.ghost && entity.hp < old.hp) attacked = true;
      if (entity.kind === 'building' && old && (old.progress ?? 1) < 1 && entity.progress === 1) events.push({ id: 'construction_complete', position });
      if (entity.queue?.some(job => job.state === 'population_blocked') && !old?.queue?.some(job => job.state === 'population_blocked')) blocked = true;
    }
    if(old&&!old.ghost&&entity.ward&&old.ward&&entity.ward.current<old.ward.current)events.push({id:entity.ward.current===0?'ward_break':'ward_absorb',position});
    if(old&&!old.ghost&&entity.gateOpen!==undefined&&old.gateOpen!==entity.gateOpen)events.push({id:'gate_mechanism',position});
    if(old&&!old.ghost&&units[entity.typeId]?.tags.includes('colossal')&&Math.hypot(old.xMm-entity.xMm,old.zMm-entity.zMm)>100&&Math.floor(next.tick/balance.rules.simulationHz)>Math.floor(before.tick/balance.rules.simulationHz))events.push({id:'giant_step',position});
    const action = entity.visualAction;
    if (!action || action.startedTick < before.tick || old?.visualAction?.kind === action.kind && old.visualAction.startedTick === action.startedTick) continue;
    const id = ({ gather_food: 'gather_food', gather_wood: 'gather_wood', mine: 'mine', build: 'build', repair: 'build', attack: ['archer', 'skirmisher'].includes(entity.typeId) ? 'arrow' : entity.typeId==='worldbreaker_trebuchet'?'worldbreaker_launch':units[entity.typeId]?.areaDamageBands?.length ? 'siege_launch' : 'melee' } as Record<string, string>)[action.kind];
    if (id) events.push({ id, position });
  }
  const effects = new Set(before.effects?.map(effect => effect.id));
  for (const effect of next.effects ?? []) if (!effects.has(effect.id) && effect.tick > before.tick) {
    if ((effect.kind === 'hit' || effect.kind === 'death') && effect.ownerId === next.playerId) attacked = true;
    if (effect.kind === 'impact') events.push({ id: effect.typeId==='worldbreaker_trebuchet'?'worldbreaker_impact':effect.projectileKind === 'arrow' ? 'arrow' : 'siege_impact', position: effect });
  }
  if (attacked) events.push({ id: 'under_attack', alert: 'Your settlement or army is under attack.' });
  if (blocked) events.push({ id: 'population_blocked', alert: 'Training is waiting for population space. Build a House.' });
  if (next.self.age > before.self.age) events.push({ id: next.self.age>=5?`age_up_${next.self.age}`:'age_up' });
  if (next.status === 'FINISHED' && before.status !== 'FINISHED' && next.result?.winnerTeamId) events.push({ id: next.result.winnerTeamId === next.players.find(player => player.id === next.playerId)?.teamId ? 'victory' : 'defeat' });
  return events;
}

const cueIds = ['selection', 'order_ack', 'gather_wood', 'gather_food', 'mine', 'build', 'construction_complete', 'melee', 'arrow', 'siege_launch', 'siege_impact', 'under_attack', 'population_blocked', 'age_up', 'victory', 'defeat', 'frontier_theme','age_up_5','age_up_6','age_up_7','age_up_8','ward_absorb','ward_break','giant_step','gate_mechanism','worldbreaker_launch','worldbreaker_impact'];
export class GameAudio {
  private context?: AudioContext;
  private master?: GainNode; private musicGain?: GainNode; private effectsGain?: GainNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly voices = new Set<AudioBufferSourceNode>();
  private readonly cooldown = new Map<string, number>();
  private readonly abort = new AbortController();
  private music?: AudioBufferSourceNode;
  private preferences = readPreferences();
  private before: PlayerView | null = null;
  private disposed = false; private loading = false;
  private listenerPosition: Position = { xMm: 0, zMm: 0 };
  private unsubscribe: () => void;
  private readonly unlock = () => { void this.start(); };
  constructor(private readonly alert: (text: string) => void) {
    this.unsubscribe = subscribePreferences(p => this.configure(p));
    window.addEventListener('pointerdown', this.unlock); window.addEventListener('keydown', this.unlock);
  }
  private async start(): Promise<void> {
    if (this.disposed) return;
    try {
      if (!this.context) {
        this.context = new AudioContext(); this.master = this.context.createGain(); this.musicGain = this.context.createGain(); this.effectsGain = this.context.createGain();
        this.musicGain.connect(this.master); this.effectsGain.connect(this.master); this.master.connect(this.context.destination); this.configure(this.preferences);
      }
      await this.context.resume();
      if (this.loading) return; this.loading = true;
      await Promise.all(cueIds.map(async id => {
        const response = await fetch(`/art/audio/${id}.wav`, { signal: this.abort.signal }); if (!response.ok) throw new Error('A sound file could not load.');
        const bytes = await response.arrayBuffer(); if (bytes.byteLength > 2_000_000) throw new Error('Invalid sound file.');
        const buffer = await this.context!.decodeAudioData(bytes); if (!this.disposed) this.buffers.set(id, buffer);
      }));
      if (!this.disposed && this.context && this.musicGain) { this.music = this.context.createBufferSource(); this.music.buffer = this.buffers.get('frontier_theme')!; this.music.loop = true; this.music.connect(this.musicGain); this.music.start(); }
    } catch (error) { if (!this.disposed && !(error instanceof DOMException && error.name === 'AbortError')) this.alert('Sound could not start. Gameplay and text alerts remain available.'); }
  }
  configure(preferences: Preferences): void {
    this.preferences = preferences;
    if (this.master) this.master.gain.value = preferences.muted ? 0 : 1;
    if (this.musicGain) this.musicGain.gain.value = preferences.musicVolume;
    if (this.effectsGain) this.effectsGain.gain.value = preferences.effectsVolume;
  }
  update(view: PlayerView, listener: Position): void {
    this.listenerPosition = listener;
    const events = deriveAudioEvents(this.before, view); this.before = view;
    for (const sound of events) { if (sound.alert) this.alert(sound.alert); this.play(sound.id, sound.position); }
  }
  play(id: string, position?: Position): void {
    const now = performance.now(), interval = id === 'under_attack' ? 8000 : id === 'population_blocked' ? 5000 : id === 'selection' ? 120 : 180;
    if (this.disposed || this.preferences.muted || !this.context || this.context.state !== 'running' || now - (this.cooldown.get(id) ?? -Infinity) < interval) return;
    const buffer = this.buffers.get(id); if (!buffer || this.voices.size >= 16) return;
    const distance = position ? Math.hypot(position.xMm - this.listenerPosition.xMm, position.zMm - this.listenerPosition.zMm) / 1000 : 0;
    if (distance > 70) return;
    this.cooldown.set(id, now);
    const source = this.context.createBufferSource(), gain = this.context.createGain(), pan = this.context.createStereoPanner();
    source.buffer = buffer; gain.gain.value = Math.max(0, 1 - distance / 70); pan.pan.value = position ? Math.max(-.8, Math.min(.8, (position.xMm - this.listenerPosition.xMm) / 45000)) : 0;
    source.connect(gain); gain.connect(pan); pan.connect(this.effectsGain!); this.voices.add(source);
    source.onended = () => { this.voices.delete(source); source.disconnect(); gain.disconnect(); pan.disconnect(); }; source.start();
  }
  clear(): void { this.before = null; this.cooldown.clear(); for (const voice of this.voices) voice.stop(); this.voices.clear(); }
  dispose(): void { this.disposed = true; this.abort.abort(); window.removeEventListener('pointerdown', this.unlock); window.removeEventListener('keydown', this.unlock); this.unsubscribe(); this.clear(); this.music?.stop(); void this.context?.close(); }
}
