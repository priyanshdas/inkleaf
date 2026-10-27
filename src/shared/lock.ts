// SPDX-License-Identifier: GPL-3.0-or-later
// Locking a PDF so that only one person's device can open it.
//
// Every copy of Inkleaf on a computer has its own key pair (main/device-key.ts).
// The public half is its "receive code". To lock a file for someone, Inkleaf
// makes a one-off key pair, combines its private half with their public key
// (X25519), turns the result into an AES-256 key (HKDF-SHA256) and encrypts the
// PDF with it (AES-256-GCM). Only the device holding the matching private key
// can work out the same AES key again. No passwords, nothing to leak.
//
// The locked data is:
//   "INKLOCK1" | 8-byte fingerprint of the receive code | 32-byte one-off
//   public key | 12-byte nonce | encrypted (2-byte name length, name, PDF) + tag
// The first 60 bytes are also authenticated, so none of them can be swapped.
//
// It all uses Web Crypto, which the window and Node both have.

const MAGIC = new TextEncoder().encode('INKLOCK1');
const INFO = new TextEncoder().encode('inkleaf-lock v1');
const HEADER = 8 + 8 + 32 + 12;

/** Crockford's base32: no I, L, O or U, so codes are easy to read out and type. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(bytes: Uint8Array): string {
  let out = '', bits = 0, value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** The letters of a typed or pasted code, forgiving the usual mix-ups (O for 0, I or L for 1). */
export function cleanCode(text: string): string {
  return text.toUpperCase().replace(/^INKLEAF-TO:/, '').replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}

function unbase32(text: string): Uint8Array | null {
  const out: number[] = [];
  let bits = 0, value = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** "K7QF2-M4TDX-8WNAP-3RJ9C": groups of five. */
export function groupCode(code: string): string {
  return code.match(/.{1,5}/g)?.join('-') ?? code;
}

// --- codes for "anyone with the code" ------------------------------------------------------

/** A new 20-character code: 100 random bits, far beyond guessing. */
export function newShareCode(): string {
  return groupCode(base32(crypto.getRandomValues(new Uint8Array(13))).slice(0, 20));
}

/** If `typed` is a share code with odd spacing or case, the way it was written when locked. */
export function asShareCode(typed: string): string | null {
  const clean = cleanCode(typed);
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(clean) ? groupCode(clean) : null;
}

// --- receive codes -------------------------------------------------------------------------

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

/** The receive code for a 32-byte public key: the key plus a 2-byte check, in base32. */
export async function receiveCodeFor(publicKey: Uint8Array): Promise<string> {
  const check = (await sha256(publicKey)).slice(0, 2);
  const all = new Uint8Array(34);
  all.set(publicKey);
  all.set(check, 32);
  return base32(all);
}

/** The public key in a receive code, or null if it's mistyped or cut short. */
export async function publicKeyFrom(code: string): Promise<Uint8Array | null> {
  const clean = cleanCode(code);
  if (clean.length !== 55) return null;
  const bytes = unbase32(clean);
  if (!bytes || bytes.length < 34) return null;
  const key = bytes.slice(0, 32);
  const check = (await sha256(key)).slice(0, 2);
  return check[0] === bytes[32] && check[1] === bytes[33] ? key : null;
}

async function fingerprint(publicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(publicKey)).slice(0, 8);
}

async function aesKey(shared: ArrayBuffer, oneOff: Uint8Array, recipient: Uint8Array, use: KeyUsage): Promise<CryptoKey> {
  const salt = new Uint8Array(64);
  salt.set(oneOff);
  salt.set(recipient, 32);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: INFO }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
}

// --- locking and opening -----------------------------------------------------------------

export async function lockFor(recipient: Uint8Array, name: string, pdf: Uint8Array): Promise<Uint8Array> {
  const oneOff = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
  const theirs = await crypto.subtle.importKey('raw', recipient as BufferSource, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, oneOff.privateKey, 256);
  const oneOffPublic = new Uint8Array(await crypto.subtle.exportKey('raw', oneOff.publicKey));

  const header = new Uint8Array(HEADER);
  header.set(MAGIC);
  header.set(await fingerprint(recipient), 8);
  header.set(oneOffPublic, 16);
  header.set(crypto.getRandomValues(new Uint8Array(12)), 48);

  const nameBytes = new TextEncoder().encode(name).slice(0, 1000);
  const plain = new Uint8Array(2 + nameBytes.length + pdf.length);
  new DataView(plain.buffer).setUint16(0, nameBytes.length);
  plain.set(nameBytes, 2);
  plain.set(pdf, 2 + nameBytes.length);

  const key = await aesKey(shared, oneOffPublic, recipient, 'encrypt');
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: header.slice(48), additionalData: header }, key, plain));
  const out = new Uint8Array(HEADER + sealed.length);
  out.set(header);
  out.set(sealed, HEADER);
  return out;
}

export type OpenResult =
  | { ok: true; name: string; pdf: Uint8Array }
  | { ok: false; reason: 'other-device' | 'damaged' };

/** Opens locked data with this device's key pair. */
export async function openLocked(data: Uint8Array, privateKey: CryptoKey, publicKey: Uint8Array): Promise<OpenResult> {
  if (data.length < HEADER + 16 || MAGIC.some((b, i) => data[i] !== b)) return { ok: false, reason: 'damaged' };
  const header = data.slice(0, HEADER);
  const mine = await fingerprint(publicKey);
  if (mine.some((b, i) => header[8 + i] !== b)) return { ok: false, reason: 'other-device' };
  try {
    const oneOffPublic = header.slice(16, 48);
    const theirs = await crypto.subtle.importKey('raw', oneOffPublic, { name: 'X25519' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, privateKey, 256);
    const key = await aesKey(shared, oneOffPublic, publicKey, 'decrypt');
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.slice(48), additionalData: header }, key, data.slice(HEADER)));
    const nameLength = new DataView(plain.buffer).getUint16(0);
    return { ok: true, name: new TextDecoder().decode(plain.slice(2, 2 + nameLength)), pdf: plain.slice(2 + nameLength) };
  } catch {
    return { ok: false, reason: 'damaged' };
  }
}
