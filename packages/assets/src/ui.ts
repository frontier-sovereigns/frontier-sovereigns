import { balance, units, buildings, technologies, TEAM_IDENTITIES } from '@frontier/shared';

/** Original vector artwork, drawn in a common 64-unit square. No external art/fonts. */
export interface GeneratedIcon { id: string; svg: string }
const ink = '#e9d5a3', dark = '#203835', pale = '#adc8b0';
const path = (d: string, fill = ink, extra = '') => `<path d="${d}" fill="${fill}" ${extra}/>`;
const line = (d: string, color = ink, width = 3) => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const circle = (x: number, y: number, r: number, fill = ink) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}"/>`;
const frame = (body: string, background = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${background ? `<rect x="2" y="2" width="60" height="60" rx="9" fill="${dark}"/><rect x="4" y="4" width="56" height="56" rx="7" fill="none" stroke="#d2bc793b"/>` : ''}${body}</svg>`;
const shield = (body = '') => path('M16 12 L48 12 L46 38 Q43 48 32 55 Q21 48 18 38 Z', pale) + path('M21 17 L43 17 L41 36 Q39 43 32 48 Q25 43 23 36 Z', dark) + body;
const sword = () => path('M35 9 L39 14 L29 39 L25 37 Z') + line('M20 33 L35 40 M25 40 L21 49', pale, 4) + circle(20, 51, 3, pale);
const axe = () => line('M21 53 L40 12', pale, 5) + path('M38 12 Q55 16 50 28 L32 25 Z') + path('M35 13 L27 11 L24 21 L32 25 Z', '#b5bdc3');
const pick = () => line('M22 52 L41 13', pale, 5) + path('M22 12 Q43 8 53 26 Q39 20 20 21 Z');
const bow = () => line('M24 10 Q55 32 24 54', ink, 4) + line('M24 10 L36 32 L24 54', pale, 1.8) + line('M11 32 L51 32', pale, 2.5) + path('M54 32 L46 27 L46 37 Z');
const wheat = () => line('M30 55 L34 13', pale, 3) + [0, 1, 2].map(i => path(`M${33-i} ${22+i*9} Q${17-i} ${22+i*9} ${23-i} ${13+i*9} Q${32-i} ${14+i*9} ${33-i} ${22+i*9} Z`) + path(`M${34-i} ${25+i*9} Q${48-i} ${23+i*9} ${44-i} ${14+i*9} Q${35-i} ${16+i*9} ${34-i} ${25+i*9} Z`)).join('');
const ore = (gold: boolean) => path('M11 43 L20 22 L40 14 L54 36 L44 51 L20 52 Z', gold ? '#deb760' : '#9daeb8') + path('M20 22 L32 33 L40 14 L54 36 L32 33 L20 52 Z', gold ? '#f3d48a' : '#ccd1cd') + line('M11 43 L32 33 L44 51', dark, 2);
const wheel = () => circle(32, 33, 19, pale) + circle(32, 33, 14, dark) + line('M32 19 L32 47 M18 33 L46 33 M22 23 L42 43 M22 43 L42 23', ink, 3) + circle(32, 33, 4);
const house = (stone = false) => path('M15 31 L49 31 L49 52 L15 52 Z', stone ? '#b7c0b7' : '#bca178') + path('M9 31 L32 12 L55 31 Z') + path('M28 39 L37 39 L37 52 L28 52 Z', dark) + path('M19 35 L24 35 L24 41 L19 41 Z', dark);
const tower = () => path('M20 18 L26 18 L26 24 L30 24 L30 18 L35 18 L35 24 L39 24 L39 18 L45 18 L45 51 L19 51 Z', pale) + path('M28 39 Q32 29 37 39 L37 51 L28 51 Z', dark) + line('M25 30 L27 30 M38 30 L40 30', dark, 3);
const horse = () => path('M13 42 L18 29 L36 29 L41 16 L48 12 L53 21 L50 31 L43 31 L41 42 L40 54 L35 54 L34 42 L23 42 L21 54 L16 54 L17 42 Z', pale) + path('M17 30 L11 32 L8 42 L12 44 Z') + circle(48, 20, 1.6, dark);
const person = () => circle(32, 17, 7, pale) + path('M24 28 L40 28 L44 43 L37 43 L38 55 L32 55 L29 44 L26 55 L20 55 L25 41 L19 41 Z');
function unitIcon(id: string): string {
  switch (id) {
    case 'villager': return person() + line('M45 25 L49 54', pale, 3) + path('M43 25 L52 24 L53 29 L44 30 Z', pale);
    case 'scout': return horse() + path('M26 13 L39 18 L28 24 Z') + line('M26 13 L26 35', dark, 3);
    case 'militia': return shield() + sword();
    case 'spearman': return shield() + line('M31 52 L37 17', ink, 3) + path('M38 7 L43 20 L33 19 Z');
    case 'archer': return bow();
    case 'skirmisher': return shield(circle(32, 30, 6)) + line('M12 54 L49 14', ink, 3) + path('M53 9 L51 21 L44 16 Z');
    case 'light_cavalry': return horse() + line('M26 13 L22 38', ink, 4) + path('M24 11 L29 8 L29 18 Z');
    case 'knight': return horse() + path('M27 13 Q26 6 34 8 L38 17 L36 31 L25 31 Z') + line('M30 15 L38 15', dark, 2);
    case 'battering_ram': return path('M9 32 L19 19 L46 19 L55 32 Z') + path('M13 34 L51 34 L51 46 L13 46 Z', pale) + line('M7 39 L57 39', dark, 5) + circle(20, 49, 5) + circle(46, 49, 5);
    case 'catapult': return line('M13 47 L52 47 M29 45 L29 25 M21 35 L40 35 M29 33 L43 13', pale, 5) + path('M38 10 Q43 6 49 10 L48 16 L40 17 Z') + circle(19, 52, 5) + circle(46, 52, 5);
    case 'trebuchet': return line('M12 53 L49 53 M18 50 L29 24 L43 50 M18 16 L48 28', pale, 4) + path('M13 12 L24 12 L24 25 L13 25 Z') + line('M48 28 L53 40', ink, 2) + circle(52, 42, 4);
    case 'ironhide_ram': case 'colossus_ram': return unitIcon('battering_ram') + (id==='colossus_ram'?tower():shield()).replaceAll('#203835','#354642');
    case 'warwolf_trebuchet': case 'worldbreaker_trebuchet': return unitIcon('trebuchet') + circle(48,12,id==='worldbreaker_trebuchet'?8:5,pale) + line('M8 58 L56 58',ink,3);
    case 'rune_catapult': return unitIcon('catapult') + line('M43 6 L40 14 L47 12 L44 20',pale,2);
    case 'wardbreaker_ballista': return bow() + line('M12 50 L52 50 M21 40 L21 53 M45 40 L45 53',pale,4);
    case 'stone_warden': case 'crown_colossus': return person() + (id==='crown_colossus'?`<g transform="translate(16 -5) scale(.5)">${tower()}</g>`:path('M44 27 L55 27 L55 38 L44 38 Z',pale)) + line('M32 26 L28 34 L36 34 L32 42',dark,2);
    default: throw new Error(`UNKNOWN_UNIT_ICON:${id}`);
  }
}
function buildingIcon(id: string): string {
  switch (id) {
    case 'house': return house();
    case 'town_center': return house() + path('M27 26 L27 8 L37 8 L37 26 Z', pale) + path('M23 9 L32 4 L41 9 Z') + line('M11 35 L11 52 M53 35 L53 52', pale, 3);
    case 'mill': return house() + circle(32, 29, 4, dark) + line('M18 15 L46 43 M46 15 L18 43', pale, 5);
    case 'lumber_camp': return path('M9 30 L30 18 L52 30 Z') + line('M14 31 L14 52 M47 31 L47 52', pale, 4) + path('M19 41 L43 33 L47 42 L23 51 Z', '#ba9465') + circle(24, 46, 5, ink) + circle(24, 46, 2, dark);
    case 'mining_camp': return path('M8 30 L30 17 L52 30 Z') + line('M13 31 L13 51 M48 31 L48 51', pale, 4) + `<g transform="translate(12 16) scale(.65)">${pick()}</g>`;
    case 'farm': return path('M8 42 L27 27 L56 38 L36 55 Z', '#977a53') + line('M14 43 L30 31 M24 47 L40 35 M34 51 L49 40', pale, 2) + `<g transform="translate(13 -1) scale(.65)">${wheat()}</g>`;
    case 'barracks': return house() + `<g transform="translate(15 8) scale(.6)">${sword()}</g>`;
    case 'archery_range': return path('M8 49 L20 19 L46 19 L55 49 Z', '#ac936a') + circle(33, 35, 13, pale) + circle(33, 35, 9, dark) + circle(33, 35, 5) + circle(33, 35, 2, dark);
    case 'stable': return house() + `<g transform="translate(18 21) scale(.52)">${horse()}</g>`;
    case 'blacksmith': return house(true) + path('M29 15 L29 7 L37 7 L37 19 Z', pale) + path('M22 37 L45 37 L38 43 L37 48 L25 48 L27 43 Z', dark);
    case 'market': return path('M12 28 L49 28 L55 38 L7 38 Z') + line('M13 38 L13 53 M49 38 L49 53', pale, 4) + path('M11 46 L51 46 L51 52 L11 52 Z', '#b39564') + line('M19 29 L17 38 M31 29 L31 38 M43 29 L45 38', dark, 3);
    case 'siege_workshop': return house(true) + `<g transform="translate(31 30) scale(.42)">${wheel()}</g>`;
    case 'university': return path('M10 24 L32 11 L54 24 Z') + path('M9 50 L55 50 L55 54 L9 54 Z', pale) + line('M16 27 L16 47 M27 27 L27 47 M38 27 L38 47 M49 27 L49 47', pale, 5) + circle(32, 19, 3, dark);
    case 'watchtower': return tower();
    case 'fortress': return `<g transform="translate(-4 8) scale(.72)">${tower()}</g><g transform="translate(25 8) scale(.72)">${tower()}</g>` + path('M24 34 L40 34 L40 53 L24 53 Z') + path('M29 43 Q32 37 35 43 L35 53 L29 53 Z', dark);
    case 'palisade_wall': return [0, 1, 2, 3, 4].map(i => path(`M${9+i*10} 24 L${13+i*10} 16 L${17+i*10} 24 L${17+i*10} 52 L${9+i*10} 52 Z`, i % 2 ? pale : ink)).join('') + line('M9 32 L57 32 M9 45 L57 45', dark, 3);
    case 'stone_wall': return path('M8 19 L17 19 L17 27 L24 27 L24 19 L34 19 L34 27 L41 27 L41 19 L55 19 L55 53 L8 53 Z', pale) + line('M9 36 L54 36 M9 45 L54 45 M22 28 L22 36 M40 28 L40 36 M32 36 L32 45 M18 45 L18 53 M46 45 L46 53', dark, 2);
    case 'wooden_gate': case 'stone_gate': return path('M9 19 L19 19 L19 25 L45 25 L45 19 L55 19 L55 54 L44 54 L44 35 Q32 23 20 35 L20 54 L9 54 Z', id === 'stone_gate' ? pale : ink) + line('M25 34 L25 53 M32 31 L32 53 M39 34 L39 53 M22 43 L42 43', '#bf9763', 3);
    case 'monument': return path('M11 52 L53 52 L49 46 L15 46 Z', pale) + path('M24 45 L28 18 L36 18 L40 45 Z') + path('M24 17 L32 7 L40 17 Z', pale) + circle(32, 31, 4, dark);
    case 'grand_citadel': case 'runic_citadel': case 'titan_citadel': case 'eternal_citadel': return buildingIcon('fortress') + `<g transform="translate(17 -7) scale(.65)">${tower()}</g>` + (id==='grand_citadel'?'':line('M30 12 L35 8 L31 20 L38 17',ink,2)) + (id==='eternal_citadel'?path('M18 10 L22 3 L28 10 L32 2 L37 10 L43 3 L46 11 Z'):'');
    case 'great_siege_yard': return house(true) + `<g transform="translate(2 17) scale(.7)">${wheel()}</g>`;
    case 'rune_forge': return buildingIcon('blacksmith') + line('M45 8 L41 17 L48 15 L44 26',ink,3);
    case 'ward_spire': return path('M24 52 L29 15 L32 6 L36 15 L42 52 Z',pale) + line('M29 25 L35 22 L30 35 L37 32',dark,2) + circle(32,17,6,ink);
    case 'bastion_wall': case 'runestone_wall': case 'titan_wall': case 'eternal_wall': return buildingIcon('stone_wall') + line('M12 56 L51 56',ink,4) + (id==='bastion_wall'?'':line('M30 28 L26 36 L35 34 L31 42',ink,2));
    case 'bastion_gate': case 'runestone_gate': case 'titan_gate': case 'eternal_gate': return buildingIcon('stone_gate') + path('M8 12 L19 12 L19 19 L8 19 Z M45 12 L56 12 L56 19 L45 19 Z') + (id==='bastion_gate'?'':line('M31 17 L28 24 L36 22',ink,2));
    default: throw new Error(`UNKNOWN_BUILDING_ICON:${id}`);
  }
}
function techIcon(id: string): string {
  const legendary=technologies[id];
  if(legendary?.minAge>=5){const base=legendary.researchedAt==='market'?wheat()+circle(49,43,8):id.endsWith('_engineering')?tower()+`<g transform="translate(28 31) scale(.4)">${wheel()}</g>`:shield()+sword();return `<g transform="translate(0 -4) scale(1 .9)">${base}</g>`+Array.from({length:legendary.minAge-4},(_,i)=>circle(20+i*8,56,2.5,pale)).join('');}

  const level = Number(id.at(-1)), tier = id.startsWith('elite_') ? 3 : id.startsWith('veteran_') ? 2 : Number.isInteger(level) && level > 0 ? level : 1;
  const body = /^(veteran|elite)_archer$/.test(id) ? person() + `<g transform="translate(16 8) scale(.7)">${bow()}</g>` : id.startsWith('forestry') ? axe() : id.startsWith('mining') ? pick() : ['wheelbarrow', 'hand_cart'].includes(id) ? wheel() + (id === 'hand_cart' ? line('M9 14 L52 14 L46 24 L18 24 Z', pale, 3) : '') : id.startsWith('farming') ? wheat() : id.startsWith('forging') ? sword() : id.startsWith('fletching') ? bow() : id.startsWith('melee_armor') ? shield(line('M25 24 L39 39 M39 24 L25 39', ink, 3)) : id.startsWith('ranged_armor') ? shield(circle(32, 30, 7)) : id === 'masonry' ? buildingIcon('stone_wall') : unitIcon(id.replace(/^(veteran|elite)_/, ''));
  return `<g transform="translate(0 -3) scale(1 .9)">${body}</g>` + Array.from({ length: tier }, (_, i) => path(`M${27-(tier-1)*5+i*10} 55 L${32-(tier-1)*5+i*10} 50 L${37-(tier-1)*5+i*10} 55 L${32-(tier-1)*5+i*10} 59 Z`, pale)).join('');
}
export function heraldryPattern(index: number, color = dark): string {
  switch (index) {
    case 0: return line('M5 48 L48 5 M16 59 L59 16', color, 7);
    case 1: return path('M26 6 L38 6 L38 25 L57 25 L57 37 L38 37 L38 59 L26 59 L26 37 L7 37 L7 25 L26 25 Z', color);
    case 2: return line('M8 39 L32 20 L56 39 M8 54 L32 35 L56 54', color, 6);
    case 3: return line('M8 20 L56 20 M8 33 L56 33 M8 46 L56 46', color, 6);
    case 4: return line('M11 11 L53 53 M53 11 L11 53', color, 8);
    case 5: return [17, 32, 47].flatMap(x => [17, 32, 47].map(y => circle(x, y, 4, color))).join('');
    case 6: return path('M32 8 L54 32 L32 56 L10 32 Z', color) + path('M32 21 L42 32 L32 43 L22 32 Z', '#e9d5a3');
    case 7: return path('M9 51 L9 40 L20 40 L20 29 L31 29 L31 18 L42 18 L42 7 L55 7 L55 20 L44 20 L44 31 L33 31 L33 42 L22 42 L22 55 L9 55 Z', color);
    case 8: return circle(32, 32, 10, color) + Array.from({ length: 8 }, (_, i) => `<g transform="rotate(${i*45} 32 32)">${path('M29 6 L35 6 L34 17 L30 17 Z', color)}</g>`).join('');
    case 9: return path('M32 9 L56 51 L8 51 Z', color) + path('M32 26 L42 44 L22 44 Z', '#e9d5a3');
    case 10: return `<g fill="none" stroke="${color}" stroke-width="5"><circle cx="25" cy="27" r="13"/><circle cx="39" cy="39" r="13"/></g>`;
    default: throw new Error('UNKNOWN_TEAM_PATTERN');
  }
}
export function generateUiAssets(): GeneratedIcon[] {
  const icons = new Map<string, string>([
    ['food_icon', wheat()], ['wood_icon', path('M12 27 L44 16 L53 37 L20 49 Z', '#b89869') + circle(20, 39, 10) + circle(20, 39, 6, '#b89869') + circle(20, 39, 2, dark) + line('M28 29 L44 24 M32 39 L47 33', dark, 2)], ['gold_icon', ore(true)], ['stone_icon', ore(false)], ['population_icon', person()], ['idle_worker_icon', person() + circle(49, 19, 10, dark) + line('M49 12 L49 20 L54 23', ink, 2)],
    ['selection_ring', '<ellipse cx="32" cy="36" rx="26" ry="17" fill="none" stroke="#b9e3c0" stroke-width="4"/>'],
    ['rally_flag', line('M21 10 L21 56', pale, 3) + path('M23 11 L53 16 L43 25 L53 34 L23 29 Z')],
    ['move_marker', line('M9 24 L9 12 L21 12 M43 12 L55 12 L55 24 M9 40 L9 52 L21 52 M43 52 L55 52 L55 40', pale, 3) + path('M32 18 L43 34 L36 34 L36 47 L28 47 L28 34 L21 34 Z')],
    ['attack_marker', line('M12 12 L52 52 M52 12 L12 52', '#e8ad82', 5) + '<circle cx="32" cy="32" r="22" fill="none" stroke="#e8ad82" stroke-width="3"/>'],
    ['valid_placement', line('M9 32 L25 48 L55 16', '#b5dcbd', 6)], ['invalid_placement', line('M14 14 L50 50 M50 14 L14 50', '#f0b39a', 6)],
  ]);
  const forward = line('M12 32 L50 32', pale, 5) + path('M39 20 L54 32 L39 44 Z');
  const crosshair = '<circle cx="32" cy="32" r="17" fill="none" stroke="#e9d5a3" stroke-width="3"/>' + line('M32 7 L32 24 M32 40 L32 57 M7 32 L24 32 M40 32 L57 32', pale, 3);
  const actionArt: Record<string, string> = {
    move: forward, attack_move: sword() + `<g transform="translate(14 20) scale(.65)">${forward}</g>`, attack_target: crosshair,
    patrol: line('M12 24 L50 24 M52 40 L14 40', pale, 4) + path('M44 16 L54 24 L44 32 Z M20 32 L10 40 L20 48 Z'),
    garrison: house(true) + path('M27 31 L37 31 L37 41 L44 41 L32 52 L20 41 L27 41 Z', dark),
    attack_ground: crosshair + path('M10 53 L54 53 L54 57 L10 57 Z', pale),
    hold_position: shield(path('M27 22 L37 22 L37 39 L27 39 Z')), stop: path('M17 17 L47 17 L47 47 L17 47 Z'),
    deploy: line('M32 11 L32 52 M12 48 L32 27 L52 48', pale, 4) + path('M27 15 L32 6 L37 15 Z'),
    pack: line('M12 17 L32 37 L52 17 M14 52 L50 52', pale, 4) + path('M27 36 L37 36 L32 46 Z'),
    repair: house() + `<g transform="translate(16 12) scale(.65)">${pick()}</g>`, build: house(), cancel: line('M15 15 L49 49 M49 15 L15 49', pale, 6),
    demolish: house() + line('M12 13 L52 53', dark, 5), set_rally: line('M18 10 L18 54', pale, 4) + path('M21 12 L53 17 L39 28 L21 26 Z'),
  };
  for (const [id, body] of Object.entries(actionArt)) icons.set(`action_icon_${id}`, body);
  for (let age = 1; age <= 8; age++) icons.set(`age_icon_${age}`, age === 1 ? house() : age === 2 ? house(true) + line('M10 54 L54 54', ink, 3) : age === 3 ? buildingIcon('fortress') : age===4?buildingIcon('monument'):buildingIcon(['grand_citadel','runic_citadel','titan_citadel','eternal_citadel'][age-5]!)+Array.from({length:age-4},(_,i)=>circle(20+i*8,57,2.2,pale)).join(''));
  for (const unit of Object.values(units)) icons.set(`unit_icon_${unit.id}`, unitIcon(unit.id));
  for (const building of Object.values(buildings)) icons.set(`building_icon_${building.id}`, buildingIcon(building.id)+(building.minAge>=5?Array.from({length:building.minAge-4},(_,i)=>circle(20+i*8,57,2.2,pale)).join(''):''));
  for (const tech of Object.values(technologies)) icons.set(`tech_icon_${tech.id}`, techIcon(tech.id));
  const result = [...icons].map(([id, body]) => ({ id, svg: frame(body) }));
  TEAM_IDENTITIES.forEach((team, index) => result.push({ id: `team_heraldry_${index}`, svg: frame(`<defs><clipPath id="shield"><path d="M7 6 L57 6 L55 40 Q49 52 32 61 Q15 52 9 40 Z"/></clipPath></defs><g clip-path="url(#shield)"><rect width="64" height="64" fill="${team.color}"/>${heraldryPattern(index)}</g>`, false) }));
  return result;
}
