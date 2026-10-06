/** Original deterministic synthesized cues. Mono PCM; no samples or external recordings. */
export interface GeneratedAudio { id: string; wav: Uint8Array; durationSeconds: number; sampleRate: number }
const sampleRate = 22050;
type Tone = { at: number; duration: number; hz: number; endHz?: number; gain: number; wave?: 'sine'|'triangle'|'noise'; attack?: number };
function render(id: string, tones: Tone[], durationSeconds: number): GeneratedAudio {
  const samples = Math.ceil(durationSeconds * sampleRate), buffer = new ArrayBuffer(44 + samples * 2), view = new DataView(buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  const mix = new Float32Array(samples); let seed = [...id].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 737);
  for (const tone of tones) {
    const first = Math.round(tone.at * sampleRate), length = Math.ceil(tone.duration * sampleRate); let phase = 0, filtered = 0;
    for (let i = 0; i < length && first + i < samples; i++) {
      const t = i / sampleRate, fraction = i / length, envelope = Math.min(1, t / (tone.attack ?? .008)) * (1 - fraction) ** 2;
      phase += 2 * Math.PI * (tone.hz + ((tone.endHz ?? tone.hz) - tone.hz) * fraction) / sampleRate;
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      filtered = filtered * .65 + ((seed >>> 0) / 2147483648 - 1) * .35;
      const wave = tone.wave === 'noise' ? filtered : tone.wave === 'triangle' ? 2 / Math.PI * Math.asin(Math.sin(phase)) : Math.sin(phase);
      mix[first + i]! += tone.gain * envelope * wave;
    }
  }
  // Fixed soft limiting protects ears and makes overlapping attacks click-free.
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.round(Math.tanh(mix[i]!) * .78 * 32767), true);
  return { id, wav: new Uint8Array(buffer), durationSeconds, sampleRate };
}
const t = (hz: number, at = 0, duration = .25, gain = .4, wave: Tone['wave'] = 'sine', endHz?: number): Tone => ({ hz, at, duration, gain, wave, ...(endHz === undefined ? {} : { endHz }) });
export function generateAudioAssets(): GeneratedAudio[] {
  const cues: [string, Tone[], number][] = [
    ['selection', [t(510, 0, .09, .24), t(765, .035, .09, .12)], .15],
    ['order_ack', [t(340, 0, .1, .25), t(510, .07, .17, .24)], .28],
    ['gather_wood', [t(180, 0, .09, .8, 'triangle', 90), t(500, 0, .06, .4, 'noise')], .15],
    ['gather_food', [t(900, 0, .1, .16, 'noise'), t(430, .035, .13, .13)], .2],
    ['mine', [t(1450, 0, .13, .24), t(2170, 0, .1, .14), t(350, 0, .07, .2, 'noise')], .2],
    ['build', [t(240, 0, .065, .55, 'triangle', 120), t(1050, .01, .04, .22, 'noise')], .13],
    ['construction_complete', [t(330, 0, .35, .25), t(440, .12, .35, .25), t(660, .24, .48, .3)], .8],
    ['melee', [t(250, 0, .085, .46, 'noise'), t(720, .008, .13, .2, 'triangle', 310)], .2],
    ['arrow', [t(1000, 0, .16, .28, 'noise'), t(570, 0, .08, .16, 'sine', 180)], .2],
    ['siege_launch', [t(85, 0, .4, .48, 'triangle', 46), t(600, .06, .3, .42, 'noise')], .5],
    ['siege_impact', [t(70, 0, .7, .55, 'sine', 28), t(800, 0, .5, .85, 'noise')], .85],
    ['under_attack', [t(390, 0, .18, .3, 'triangle'), t(520, .2, .2, .28, 'triangle'), t(390, .44, .24, .3, 'triangle')], .75],
    ['population_blocked', [t(290, 0, .2, .22), t(230, .17, .25, .25)], .48],
    ['age_up', [t(262, 0, .8, .22), t(330, .18, .8, .22), t(392, .36, .8, .24), t(524, .58, 1.1, .3)], 1.8],
    ['victory', [t(294, 0, .8, .2, 'triangle'), t(370, .2, .8, .22), t(440, .4, .8, .25), t(588, .65, 1.2, .3)], 2],
    ['defeat', [t(330, 0, .9, .23), t(294, .28, .9, .23), t(220, .6, 1.3, .25)], 2],
  ];
  for(let age=5;age<=8;age++)cues.push([`age_up_${age}`,[t(130.81,0,1.4,.2,'triangle'),t(196,.18,1.3,.18),t(261.63,.4,1.4,.22),t([329.63,349.23,392,523.25][age-5]!,.7,1.8,.23)],2.6]);
  cues.push(['ward_absorb',[t(740,0,.35,.18),t(1110,.03,.25,.09)],.5],['ward_break',[t(780,0,.6,.2,'triangle',120),t(600,0,.45,.4,'noise')],.8],['giant_step',[t(46,0,.6,.5,'sine',23),t(230,0,.3,.35,'noise')],.7],['gate_mechanism',[t(150,0,.8,.3,'triangle',65),t(440,.1,.7,.22,'noise')],1],['worldbreaker_launch',[t(50,0,1.1,.45,'triangle',24),t(360,.1,.9,.4,'noise')],1.3],['worldbreaker_impact',[t(38,0,1.8,.5,'sine',18),t(600,0,1.4,.75,'noise')],2]);
  const melody = [196, 247, 294, 247, 220, 262, 330, 294, 196, 294, 392, 330, 247, 220, 196, 147];
  const music: Tone[] = melody.flatMap((hz, i) => [t(hz, i * 1.5, 2.6, .13), t(hz * 2, i * 1.5 + .02, 1.9, .035, 'triangle'), t(i < 8 ? 98 : 73.5, i * 1.5, 1.4, .055)]);
  return [...cues.map(([id, tones, duration]) => render(id, tones, duration)), render('frontier_theme', music, 26.5)];
}
