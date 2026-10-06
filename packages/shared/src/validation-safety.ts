import type { ErrorObject, ValidateFunction } from 'ajv';
const unsafeJson = Symbol('unsafe JSON');
/** One safety policy for validation and detached capture; descriptors never read property getters. */
function walkJson(value: unknown, depth: number, budget: { remaining: number }, capture: boolean, enumerableOnly: boolean): unknown {
  if (--budget.remaining < 0 || depth > 32) return unsafeJson;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return capture ? value : true;
  if (typeof value === 'number') return Number.isFinite(value) ? (capture ? value : true) : unsafeJson;
  if (typeof value !== 'object') return unsafeJson;
  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length: unknown = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (Object.getPrototypeOf(value) !== Array.prototype || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > budget.remaining || Object.keys(value).length !== length) return unsafeJson;
    const copy: unknown[] | undefined = capture ? [] : undefined;
    for (let i = 0; i < length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (!descriptor || !('value' in descriptor)) return unsafeJson;
      const child = walkJson(descriptor.value, depth + 1, budget, capture, enumerableOnly);
      if (child === unsafeJson) return unsafeJson;
      if (copy) copy.push(child);
    }
    return copy ?? true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unsafeJson;
  const copy: Record<string, unknown> | undefined = capture ? Object.create(prototype) : undefined;
  // Keep descriptor reads (never invoke accessors), without allocating a full
  // descriptor dictionary and one entry-pair array for every property.
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return unsafeJson;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || (enumerableOnly && !descriptor.enumerable)) return unsafeJson;
    const child = walkJson(descriptor.value, depth + 1, budget, capture, enumerableOnly);
    if (child === unsafeJson) return unsafeJson;
    if (copy) {
      if (descriptor.enumerable) copy[key] = child;
      else Object.defineProperty(copy, key, { value: child, enumerable: false, writable: true, configurable: true });
    }
  }
  return copy ?? true;
}
/** Reject non-JSON objects, accessors, dangerous keys, nonfinite numbers and deep input before schema work. */
export function isSafeJson(value: unknown, depth = 0, budget = { remaining: 20000 }): boolean { return walkJson(value, depth, budget, false, false) !== unsafeJson; }

/** Only called on JSON.parse's private result, without a reviver or caller-owned references. */
function safeParsedJson(value: unknown, depth: number, budget: { remaining: number }): boolean {
  if (--budget.remaining < 0 || depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    if (value.length > budget.remaining) return false;
    for (let i = 0; i < value.length; i++) if (!safeParsedJson(value[i], depth + 1, budget)) return false;
  } else {
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false;
      if (!safeParsedJson((value as Record<string, unknown>)[key], depth + 1, budget)) return false;
    }
  }
  return true;
}

export type StrictValidator<T> = ((value: unknown) => value is T) & { errors: ErrorObject[] | null | undefined };
type CapturingValidator<T> = StrictValidator<T> & {
  capture(value: unknown, options?: { enumerableOnly?: boolean }): T | undefined;
  parseJson(text: unknown, maxBytes: number): T | undefined;
};
export function protect<T>(compiled: ValidateFunction<T>, semantic?: (value: T) => boolean, nodeBudget = 20000): CapturingValidator<T> {
  const unsafe = () => { validate.errors = [{ instancePath: '', schemaPath: '', keyword: 'safeJson', params: {}, message: 'must contain only bounded plain JSON data' }]; return false; };
  const check = (value: unknown): value is T => {
    const valid = compiled(value);
    validate.errors = compiled.errors;
    if (valid && semantic && !semantic(value)) {
      validate.errors = [{ instancePath: '', schemaPath: '', keyword: 'semantic', params: {}, message: 'semantic constraints failed' }];
      return false;
    }
    return valid;
  };
  const validate: CapturingValidator<T> = Object.assign((value: unknown): value is T => {
    if (!isSafeJson(value, 0, { remaining: nodeBudget })) return unsafe();
    return check(value);
  }, {
    errors: null as ErrorObject[] | null | undefined,
    /** The result is caller-owned. Only a private owner may retain it as trusted data. */
    capture(value: unknown, options?: { enumerableOnly?: boolean }): T | undefined {
      let copy: unknown;
      try { copy = walkJson(value, 0, { remaining: nodeBudget }, true, options?.enumerableOnly === true); }
      catch { unsafe(); return undefined; }
      if (copy === unsafeJson) { unsafe(); return undefined; }
      return check(copy) ? copy : undefined;
    },
    /** The parsed tree is owned by this call. Arbitrary object inputs still require capture(). */
    parseJson(text: unknown, maxBytes: number): T | undefined {
      if (typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || maxBytes < 0) { unsafe(); return undefined; }
      // A UTF-16 code-unit count is a cheap lower bound on UTF-8 bytes. Check both
      // before parsing; even the temporary encoding allocation is bounded here.
      if (text.length > maxBytes || new TextEncoder().encode(text).length > maxBytes) {
        validate.errors = [{ instancePath: '', schemaPath: '', keyword: 'maxBytes', params: { limit: maxBytes }, message: 'must fit the JSON byte limit' }];
        return undefined;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { unsafe(); return undefined; }
      if (!safeParsedJson(parsed, 0, { remaining: nodeBudget })) { unsafe(); return undefined; }
      return check(parsed) ? parsed : undefined;
    },
  });
  return validate;
}
