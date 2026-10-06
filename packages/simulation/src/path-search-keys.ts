/** Internal numeric search identities. Public/save keys retain their exact text.
 * The mixed-radix domain fits below 2^40; generic coordinates use string keys,
 * which cannot alias a packed number. No 32-bit bitwise truncation is used. */
export type SearchKey = number | string;
export interface SavedPathSearch { heap: { key: string; score: number }[]; scores: Record<string, number>; parents: Record<string, string>; closed: Record<string, boolean> }
export interface PathSearch { heap: { key: SearchKey; score: number }[]; scores: Map<SearchKey, number>; parents: Map<SearchKey, SearchKey>; closed: Map<SearchKey, boolean> }
const AXIS = 65536, LABELS = 256;
export function regionKey(x: number, z: number): SearchKey {
  return Number.isInteger(x) && Number.isInteger(z) && x >= 0 && z >= 0 && x < AXIS && z < AXIS ? x * AXIS + z : `${x},${z}`;
}
export function regionFromText(text: string): SearchKey {
  const values = text.split(',').map(Number); if (values.length !== 2 || `${values[0]},${values[1]}` !== text) return text;
  return regionKey(values[0]!, values[1]!);
}
export function componentKey(x: number, z: number, label: number): SearchKey {
  const region = regionKey(x, z);
  return typeof region === 'number' && Number.isInteger(label) && label >= 0 && label < LABELS ? region * LABELS + label : `${x},${z},${label}`;
}
export function componentCoordinates(key: SearchKey): [number, number, number] {
  if (typeof key === 'string') return key.split(',').map(Number) as [number, number, number];
  const region = Math.floor(key / LABELS); return [Math.floor(region / AXIS), region % AXIS, key % LABELS];
}
export function componentText(key: SearchKey): string {
  if (typeof key === 'string') return key; const [x, z, label] = componentCoordinates(key); return `${x},${z},${label}`;
}
export function componentFromText(text: string): SearchKey {
  const values = text.split(',').map(Number); if (values.length !== 3) return text;
  const packed = componentKey(values[0]!, values[1]!, values[2]!); return componentText(packed) === text ? packed : text;
}
export function componentRegionText(key: SearchKey): string {
  if (typeof key === 'string') return key.slice(0, key.lastIndexOf(','));
  const region = Math.floor(key / LABELS); return `${Math.floor(region / AXIS)},${region % AXIS}`;
}
export function cellFromText(text: string): SearchKey {
  const number = Number(text); return Number.isSafeInteger(number) && number >= 0 && String(number) === text ? number : text;
}
export function cellKey(cell: number): SearchKey { return Number.isSafeInteger(cell) && cell >= 0 ? cell : String(cell); }
/** Exact code-unit order of canonical nonnegative decimal integers, including
 * prefix ties (2 sorts after 10). Component delimiters sort before all digits. */
export function decimalOrder(a: number, b: number): number {
  if (a === b) return 0;
  let ap = 1, bp = 1; while (a / ap >= 10) ap *= 10; while (b / bp >= 10) bp *= 10;
  for (;;) {
    const ad = Math.floor(a / ap), bd = Math.floor(b / bp); if (ad !== bd) return ad < bd ? -1 : 1;
    if (ap === 1 || bp === 1) return ap === bp ? 0 : ap === 1 ? -1 : 1;
    a %= ap; b %= bp; ap /= 10; bp /= 10;
  }
}
export function searchKeyOrder(a: SearchKey, b: SearchKey, coarse: boolean): number {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') {
    if (!coarse) return decimalOrder(a, b);
    const ac = componentCoordinates(a), bc = componentCoordinates(b);
    return decimalOrder(ac[0], bc[0]) || decimalOrder(ac[1], bc[1]) || decimalOrder(ac[2], bc[2]);
  }
  const at = coarse ? componentText(a) : String(a), bt = coarse ? componentText(b) : String(b); return at < bt ? -1 : at > bt ? 1 : 0;
}
export const createPathSearch = (): PathSearch => ({ heap: [], scores: new Map(), parents: new Map(), closed: new Map() });
export function importPathSearch(saved: SavedPathSearch, coarse: boolean): PathSearch {
  const key = coarse ? componentFromText : cellFromText;
  return { ...saved, heap: saved.heap.map(item => ({ ...item, key: key(item.key) })), scores: new Map(Object.entries(saved.scores).map(([k, v]) => [key(k), v])), parents: new Map(Object.entries(saved.parents).map(([k, v]) => [key(k), key(v)])), closed: new Map(Object.entries(saved.closed).map(([k, v]) => [key(k), v])) };
}
export function exportPathSearch(search: PathSearch, coarse: boolean): SavedPathSearch {
  const key = coarse ? componentText : String;
  // Object construction restores JavaScript's integer-property enumeration;
  // Map insertion order alone would change fine-search replay serialization.
  return { ...search, heap: search.heap.map(item => ({ ...item, key: key(item.key) })), scores: Object.fromEntries([...search.scores].map(([k, v]) => [key(k), v])), parents: Object.fromEntries([...search.parents].map(([k, v]) => [key(k), key(v)])), closed: Object.fromEntries([...search.closed].map(([k, v]) => [key(k), v])) };
}
