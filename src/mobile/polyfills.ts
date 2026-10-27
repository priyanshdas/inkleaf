// SPDX-License-Identifier: GPL-3.0-or-later
// Stand-ins for recent JavaScript features that pdf.js uses.
//
// The desktop app ships its own up-to-date browser engine (Electron), but a
// phone app runs in the phone's system web view, which can be a year or two
// older. Each feature is only added when it's missing, so a newer web view
// uses its own. Loaded before the editor, and in front of pdf.js's worker.

/* eslint-disable @typescript-eslint/no-explicit-any */

function define(target: any, name: string, value: unknown) {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

// Map / WeakMap: getOrInsert, getOrInsertComputed
for (const Kind of [Map, WeakMap] as any[]) {
  define(Kind.prototype, 'getOrInsert', function (this: any, key: unknown, value: unknown) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define(Kind.prototype, 'getOrInsertComputed', function (this: any, key: unknown, compute: (key: unknown) => unknown) {
    if (!this.has(key)) this.set(key, compute(key));
    return this.get(key);
  });
}

// Promise.withResolvers, Promise.try
define(Promise, 'withResolvers', function () {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
});
define(Promise, 'try', function (fn: (...args: unknown[]) => unknown, ...args: unknown[]) {
  return new Promise((resolve) => resolve(fn(...args)));
});

// Math.sumPrecise: Neumaier's compensated sum is close enough for drawing pages
define(Math, 'sumPrecise', function (values: Iterable<number>) {
  let sum = 0;
  let compensation = 0;
  let any = false;
  for (const v of values) {
    any = true;
    const t = sum + v;
    compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
    sum = t;
  }
  return any ? sum + compensation : -0;
});

// Uint8Array base64 and hex
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
define(Uint8Array.prototype, 'toBase64', function (this: Uint8Array, options: { alphabet?: string; omitPadding?: boolean } = {}) {
  let binary = '';
  for (let i = 0; i < this.length; i += 0x8000) binary += String.fromCharCode(...this.subarray(i, i + 0x8000));
  let out = btoa(binary);
  if (options.alphabet === 'base64url') out = out.replace(/\+/g, '-').replace(/\//g, '_');
  return options.omitPadding ? out.replace(/=+$/, '') : out;
});
define(Uint8Array, 'fromBase64', function (text: string, options: { alphabet?: string } = {}) {
  let clean = String(text).replace(/\s+/g, '');
  if (options.alphabet === 'base64url') clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
});
define(Uint8Array.prototype, 'toHex', function (this: Uint8Array) {
  let out = '';
  for (const b of this) out += b.toString(16).padStart(2, '0');
  return out;
});
define(Uint8Array, 'fromHex', function (text: string) {
  const out = new Uint8Array(text.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
  return out;
});
void B64;

// Set methods
const setOf = (other: any): Set<unknown> => (other instanceof Set ? other : new Set(other.keys ? other.keys() : other));
define(Set.prototype, 'union', function (this: Set<unknown>, other: any) {
  return new Set([...this, ...setOf(other)]);
});
define(Set.prototype, 'intersection', function (this: Set<unknown>, other: any) {
  const o = setOf(other);
  return new Set([...this].filter((v) => o.has(v)));
});
define(Set.prototype, 'difference', function (this: Set<unknown>, other: any) {
  const o = setOf(other);
  return new Set([...this].filter((v) => !o.has(v)));
});
define(Set.prototype, 'symmetricDifference', function (this: Set<unknown>, other: any) {
  const o = setOf(other);
  return new Set([...[...this].filter((v) => !o.has(v)), ...[...o].filter((v) => !this.has(v))]);
});
define(Set.prototype, 'isSubsetOf', function (this: Set<unknown>, other: any) {
  const o = setOf(other);
  return [...this].every((v) => o.has(v));
});
define(Set.prototype, 'isSupersetOf', function (this: Set<unknown>, other: any) {
  return [...setOf(other)].every((v) => this.has(v));
});
define(Set.prototype, 'isDisjointFrom', function (this: Set<unknown>, other: any) {
  const o = setOf(other);
  return [...this].every((v) => !o.has(v));
});

export {};
