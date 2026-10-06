import { describe, expect, it } from 'vitest';
import { cellFromText, cellKey, componentCoordinates, componentFromText, componentKey, componentRegionText, componentText, decimalOrder, exportPathSearch, importPathSearch, regionFromText, regionKey, searchKeyOrder, type SavedPathSearch } from '../src/path-search-keys.js';

describe('internal numeric path-search identities', () => {
  it('is injective across component/radix boundaries and preserves generic fallback text', () => {
    const seen=new Set<number|string>();
    for(const x of [0,1,2,10,65535,65536,-1])for(const z of [0,1,2,10,65535,65536,-1])for(const label of [0,1,2,10,255,256,-1]){
      const key=componentKey(x,z,label),text=`${x},${z},${label}`;
      expect(seen.has(key)).toBe(false);seen.add(key);expect(componentText(key)).toBe(text);expect(componentCoordinates(key)).toEqual([x,z,label]);expect(componentFromText(text)).toBe(key);expect(componentRegionText(key)).toBe(`${x},${z}`);
      expect(typeof key).toBe(x>=0&&x<65536&&z>=0&&z<65536&&label>=0&&label<256?'number':'string');
    }
    expect(componentKey(65535,65535,255)).toBe(2**40-1);expect(componentKey(0,0,0)).toBe(0);
    expect(regionKey(65535,65535)).toBe(2**32-1);expect(regionKey(65536,0)).toBe('65536,0');
    for(const text of ['00,0,0','0,00,0','0,0,00','-0,0,0','1.0,2,0','9007199254740992,0,0','bad','0,0','0,0,0,0'])expect(componentFromText(text)).toBe(text);
    for(const text of ['00,0','-0,0','1.0,0','bad'])expect(regionFromText(text)).toBe(text);
  });
  it('preserves exact decimal code-unit order rather than numeric order', () => {
    const values=[0,1,2,9,10,11,19,20,99,100,101,109,110,999,1000,65535,65536,2**32-1,2**32,Number.MAX_SAFE_INTEGER];
    for(let power=1;power<=15;power++)values.push(10**power-1,10**power,10**power+1);
    let random=1234567;for(let index=0;index<100;index++){random=(Math.imul(random,1664525)+1013904223)>>>0;values.push(random);}
    for(const a of values)for(const b of values){const expected=String(a)<String(b)?-1:String(a)>String(b)?1:0;expect(decimalOrder(a,b)).toBe(expected);expect(searchKeyOrder(a,b,false)).toBe(expected);}
    expect(decimalOrder(2,10)).toBe(1);expect(decimalOrder(1,10)).toBe(-1);
  });
  it('preserves component ordering including label/prefix ties and fallback coordinates', () => {
    const texts=['0,0,0','0,0,2','0,0,10','0,0,100','0,1,0','0,10,0','0,2,0','1,0,0','10,0,0','2,0,0','65535,65535,255','65536,0,0','-1,0,0','00,0,0'];
    for(const a of texts)for(const b of texts)expect(searchKeyOrder(componentFromText(a),componentFromText(b),true)).toBe(a<b?-1:a>b?1:0);
    expect([...texts].map(componentFromText).sort((a,b)=>searchKeyOrder(a,b,true)).map(componentText)).toEqual([...texts].sort());
  });
  it('packs only canonical safe fine-cell keys', () => {
    for(const value of [0,1,2**32-1,2**32,Number.MAX_SAFE_INTEGER]){expect(cellFromText(String(value))).toBe(value);expect(cellKey(value)).toBe(value);}
    for(const value of [-1,Number.MAX_SAFE_INTEGER+1,1e21,Infinity,NaN])expect(cellKey(value)).toBe(String(value));
    for(const text of ['-0','01','1.0','1e2','-1','9007199254740992','Infinity','NaN'])expect(cellFromText(text)).toBe(text);
  });
  it.each([true,false])('preserves saved field/property order, false closed entries and detached boundaries (coarse=%s)',coarse=>{
    const keys=coarse?['2,0,0','10,0,0','0,0,0','65536,0,0']:['20','2','10','0','4294967295','9007199254740991','01'];
    const saved:SavedPathSearch={parents:Object.fromEntries(keys.slice(1).map(key=>[key,keys[0]!])),closed:Object.fromEntries(keys.map((key,index)=>[key,index%2===0])),heap:keys.map((key,index)=>({score:index,key})),scores:Object.fromEntries(keys.map((key,index)=>[key,index]))};
    const expected=JSON.stringify(saved),live=importPathSearch(saved,coarse);
    expect(live.scores).toBeInstanceOf(Map);expect(live.closed).toBeInstanceOf(Map);expect([...live.closed.values()]).toContain(false);expect(JSON.stringify(exportPathSearch(live,coarse))).toBe(expected);
    const exported=exportPathSearch(live,coarse);exported.heap[0]!.key='mutated';exported.scores[keys[0]!]=999;
    saved.parents[keys[1]!]='mutated';saved.heap[0]!.score=999;
    expect(JSON.stringify(exportPathSearch(live,coarse))).toBe(expected);
    const cold=importPathSearch(exportPathSearch(live,coarse),coarse);expect(JSON.stringify(exportPathSearch(cold,coarse))).toBe(expected);
  });
});
