import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import requirements from '../../../data/asset-requirements.json';
import { balance, TEAM_IDENTITIES } from '../../shared/src/index.js';
import { generateAudioAssets } from '../src/audio.js';
import { generateUiAssets, heraldryPattern } from '../src/ui.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const icons=generateUiAssets(),audio=generateAudioAssets();
const requiredIcons=requirements.uiAssets.flatMap(id=>id==='age_icons_1_to_4'?[1,2,3,4].map(age=>`age_icon_${age}`):id==='age_icons_5_to_8'?[5,6,7,8].map(age=>`age_icon_${age}`):id==='eleven_team_heraldry_patterns'?TEAM_IDENTITIES.map((_,index)=>`team_heraldry_${index}`):[id]);

/** Narrow XML grammar for these original vector primitives, independent of a DOM dependency. */
function verifySvg(svg:string){
  expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">')).toBe(true);expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/<(?:script|image|foreignObject|style|animate|iframe|use)\b|\bon[a-z]+\s*=|(?:href|src)\s*=|<!|<\?|javascript:|data:|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i);
  expect(svg).not.toMatch(/\b(?:NaN|Infinity|undefined|null)\b/);
  const allowed=new Set(['svg','g','path','circle','ellipse','rect','defs','clipPath']),stack:string[]=[],ids=new Set<string>(),references:string[]=[];let end=0,shapes=0;
  for(const match of svg.matchAll(/<([^>]+)>/g)){
    expect(svg.slice(end,match.index).trim()).toBe('');end=match.index!+match[0].length;const token=match[1]!,closing=token.startsWith('/'),selfClosing=token.endsWith('/'),name=/^\/?([A-Za-z]+)/.exec(token)?.[1];expect(name&&allowed.has(name),token).toBe(true);
    if(closing){expect(stack.pop()).toBe(name);continue;}
    const attrs=token.slice(name!.length).replace(/\/$/,'');let consumed=0;
    for(const attribute of attrs.matchAll(/\s+([A-Za-z][A-Za-z0-9:-]*)="([^"]*)"/g)){expect(attrs.slice(consumed,attribute.index).trim()).toBe('');consumed=attribute.index!+attribute[0].length;
      const key=attribute[1]!,value=attribute[2]!;expect(value).not.toMatch(/[<>]/);
      if(key==='id'){expect(ids.has(value)).toBe(false);ids.add(value);}for(const ref of value.matchAll(/url\(([^)]+)\)/g)){expect(ref[1]).toMatch(/^#[a-zA-Z][a-zA-Z0-9_-]*$/);references.push(ref[1]!.slice(1));}
      if(['x','y','x1','y1','x2','y2','cx','cy','r','rx','ry','width','height','stroke-width'].includes(key)){expect(Number.isFinite(Number(value))).toBe(true);expect(Math.abs(Number(value))).toBeLessThanOrEqual(128);if(['r','rx','ry','width','height','stroke-width'].includes(key))expect(Number(value)).toBeGreaterThanOrEqual(0);}
      if(key==='d'){expect(value).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9eE+.,\s-]+$/);expect(value.length).toBeGreaterThan(6);}
    }
    expect(attrs.slice(consumed).trim()).toBe('');if(!selfClosing)stack.push(name!);if(['path','circle','ellipse','rect'].includes(name!))shapes++;
  }
  expect(svg.slice(end)).toBe('');expect(stack).toEqual([]);expect(shapes).toBeGreaterThan(0);for(const reference of references)expect(ids.has(reference)).toBe(true);
}

describe('original vector UI source generators',()=>{
  it('covers every expanded required icon and all content/actions without duplicate IDs',()=>{
    const ids=new Set(icons.map(icon=>icon.id));expect(ids.size).toBe(icons.length);for(const id of requiredIcons)expect(ids.has(id),id).toBe(true);
    for(const unit of balance.units)expect(ids.has(`unit_icon_${unit.id}`)).toBe(true);for(const building of balance.buildings)expect(ids.has(`building_icon_${building.id}`)).toBe(true);for(const technology of balance.technologies)expect(ids.has(`tech_icon_${technology.id}`)).toBe(true);
    const actions=['move','attack_move','attack_target','patrol','garrison','attack_ground','hold_position','stop','deploy','pack','repair','build','cancel','demolish','set_rally'];for(const action of actions)expect(ids.has(`action_icon_${action}`)).toBe(true);
    expect(icons.length).toBe(requiredIcons.length+actions.length);
  });
  it('is deterministic and produces finite standalone local vector geometry',()=>{expect(generateUiAssets()).toEqual(icons);for(const icon of icons){expect(icon.id).toMatch(/^[a-z][a-z0-9_]+$/);expect(icon.svg.length).toBeLessThan(12000);verifySvg(icon.svg);}});
  it('has eleven genuinely different heraldic patterns even with every team color replaced by the same ink',()=>{expect(TEAM_IDENTITIES).toHaveLength(11);expect(new Set(TEAM_IDENTITIES.map((_,index)=>hash(heraldryPattern(index,'#111111')))).size).toBe(11);for(let index=0;index<11;index++){const icon=icons.find(item=>item.id===`team_heraldry_${index}`)!;expect(icon.svg).toContain(TEAM_IDENTITIES[index]!.color);expect(icon.svg).toContain(heraldryPattern(index));}});
  it('distinguishes unit/building/technology and age silhouettes, rather than only relabeling identical art',()=>{for(const prefix of ['unit_icon_','building_icon_','tech_icon_','age_icon_']){const group=icons.filter(icon=>icon.id.startsWith(prefix));expect(new Set(group.map(icon=>hash(icon.svg))).size,prefix).toBe(group.length);}});
});

describe('original PCM audio source generators',()=>{
  it('contains every required cue and one ambient score with deterministic audible payloads',()=>{
    expect(audio.map(cue=>cue.id).sort()).toEqual([...requirements.audioAssets,'frontier_theme'].sort());expect(new Set(audio.map(cue=>cue.id)).size).toBe(audio.length);
    const again=generateAudioAssets();for(let index=0;index<audio.length;index++)expect(hash(again[index]!.wav)).toBe(hash(audio[index]!.wav));
    expect(new Set(audio.map(cue=>hash(cue.wav.subarray(44)))).size).toBe(audio.length);
  });
  for(const id of [...requirements.audioAssets,'frontier_theme'])it(`${id}: RIFF length, mono16 PCM, audible finite signal and silent edges`,()=>{
    const cue=audio.find(item=>item.id===id)!,view=new DataView(cue.wav.buffer,cue.wav.byteOffset,cue.wav.byteLength),ascii=(offset:number,count:number)=>String.fromCharCode(...cue.wav.subarray(offset,offset+count));
    expect(ascii(0,4)).toBe('RIFF');expect(ascii(8,4)).toBe('WAVE');expect(ascii(12,4)).toBe('fmt ');expect(ascii(36,4)).toBe('data');expect(view.getUint32(4,true)+8).toBe(cue.wav.length);expect(view.getUint32(16,true)).toBe(16);expect(view.getUint16(20,true)).toBe(1);expect(view.getUint16(22,true)).toBe(1);expect(view.getUint16(34,true)).toBe(16);expect(view.getUint16(32,true)).toBe(2);
    const rate=view.getUint32(24,true),length=view.getUint32(40,true)/2;expect(rate).toBe(cue.sampleRate);expect(rate).toBeGreaterThanOrEqual(22050);expect(view.getUint32(28,true)).toBe(rate*2);expect(length).toBe(Math.ceil(rate*cue.durationSeconds));expect(cue.wav.length).toBe(44+length*2);
    let peak=0,energy=0,active=0,total=0;for(let i=0;i<length;i++){const sample=view.getInt16(44+i*2,true)/32768;if(!Number.isFinite(sample))throw new Error('NONFINITE_PCM');peak=Math.max(peak,Math.abs(sample));energy+=sample*sample;total+=sample;if(Math.abs(sample)>.001)active++;}
    expect(peak).toBeGreaterThan(.025);expect(peak).toBeLessThan(.79);expect(Math.sqrt(energy/length)).toBeGreaterThan(.003);expect(active/length).toBeGreaterThan(.15);expect(Math.abs(total/length)).toBeLessThan(.01);
    expect(view.getInt16(44,true)).toBe(0);for(let i=length-32;i<length;i++)expect(view.getInt16(44+i*2,true)).toBe(0);
    if(id==='frontier_theme'){expect(cue.durationSeconds).toBeGreaterThanOrEqual(20);expect(cue.durationSeconds).toBeLessThanOrEqual(120);}else{expect(cue.durationSeconds).toBeGreaterThan(.05);expect(cue.durationSeconds).toBeLessThanOrEqual(3);}
  });
  it('keeps short interaction cues brief and strategic feedback longer than repeated gathering sounds',()=>{const duration=(id:string)=>audio.find(cue=>cue.id===id)!.durationSeconds;for(const id of ['selection','order_ack','gather_food','gather_wood','mine','build','melee','arrow'])expect(duration(id)).toBeLessThanOrEqual(.3);for(const id of ['construction_complete','under_attack','age_up','victory','defeat'])expect(duration(id)).toBeGreaterThanOrEqual(.7);expect(duration('siege_impact')).toBeGreaterThan(duration('melee'));});
});

describe('generated host manifest local artifact paths',()=>{
  it('maps every listed SVG/WAV to a checked file inside the public art directory with correct byte/hash metadata',async()=>{
    // This validates the last generated artifact set; source-coverage checks above are
    // independent so a stale manifest cannot certify newly added generator content.
    const root=resolve('apps/client/public'),manifest=JSON.parse(await readFile(resolve(root,'asset-manifest.json'),'utf8')) as {schemaVersion:number;ui:{id:string;path:string;bytes:number;sha256:string}[];audio:{id:string;path:string;bytes:number;sha256:string}[]};
    expect(manifest.schemaVersion).toBe(2);const ids=new Set<string>();
    for(const [kind,entries]of [['icons',manifest.ui],['audio',manifest.audio]] as const)for(const item of entries){expect(ids.has(item.id)).toBe(false);ids.add(item.id);expect(item.path).toBe(`/art/${kind}/${item.id}.${kind==='icons'?'svg':'wav'}`);expect(item.path).toMatch(/^\/art\/(?:icons|audio)\/[a-z][a-z0-9_]+\.(?:svg|wav)$/);
      const file=resolve(root,item.path.slice(1));expect(file.startsWith(resolve(root,'art')+sep)).toBe(true);const bytes=await readFile(file);expect(bytes.length).toBe(item.bytes);expect(hash(bytes)).toBe(item.sha256);if(kind==='icons')verifySvg(bytes.toString('utf8').trim());
    }
    for(const id of requiredIcons)expect(ids.has(id),`generated ${id}`).toBe(true);for(const id of requirements.audioAssets)expect(ids.has(id),`generated ${id}`).toBe(true);
  });
});
