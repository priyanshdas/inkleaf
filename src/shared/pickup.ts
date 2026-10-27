// SPDX-License-Identifier: GPL-3.0-or-later
// Pickup codes: sending a file so the other person only needs a code (or its
// QR code) to get it, over the same Wi-Fi or through the relay.
//
// A code is 24 characters: a 7-character id that says which file, and a
// 17-character secret (85 random bits) that never leaves the two devices.
// From the secret come the AES-256 key the file is encrypted with and a
// token that lets whoever has the code delete it from the relay. The relay
// and anything in between only ever see the id and scrambled bytes.
//
//   "INKSEND1" | 12-byte nonce | AES-256-GCM(2-byte name length, name, file) + tag
//
// The website's download page (website/get/) does the same steps in the
// browser; keep the two in step.

import { base32, cleanCode, groupCode } from './lock';

const MAGIC = new TextEncoder().encode('INKSEND1');

export interface Pickup {
  /** "K7QF2-M4TDX-…": what people type */
  code: string;
  /** which file, for the relay and the Wi-Fi search */
  id: string;
  /** a hash of the delete token, part of where the file is stored */
  check: string;
  /** proves to the relay that you may delete it */
  deleteToken: string;
  key: CryptoKey;
}

export const PICKUP_PAGE = 'https://priyanshdas.github.io/inkleaf/get/';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function derive(id: string, secret: string): Promise<Pickup> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey', 'deriveBits']);
  const salt = enc.encode(`inkleaf-send:${id}`);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('key') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const token = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('delete') }, base, 128));
  const check = new Uint8Array(await crypto.subtle.digest('SHA-256', token)).slice(0, 16);
  return { code: groupCode(id + secret), id, check: hex(check), deleteToken: hex(token), key };
}

export async function newPickup(): Promise<Pickup> {
  const all = base32(crypto.getRandomValues(new Uint8Array(15))).slice(0, 24);
  return derive(all.slice(0, 7), all.slice(7));
}

/**
 * Reads a pickup code as typed or pasted, or the link from its QR code.
 * Any Wi-Fi addresses in the link (for a quicker direct transfer) come back too.
 */
export async function readPickup(text: string): Promise<{ pickup: Pickup; nearby: string[] } | null> {
  let code = text.trim(), nearby: string[] = [];
  const hash = code.indexOf('#');
  if (/^https?:\/\//i.test(code) && hash >= 0) {
    const [first, ...rest] = code.slice(hash + 1).split('&');
    code = first;
    for (const part of rest) if (part.startsWith('l=')) nearby = part.slice(2).split(',').filter((a) => /^[\d.]+:\d+$/.test(a));
  }
  const clean = cleanCode(code);
  if (!/^[0-9A-HJKMNP-TV-Z]{24}$/.test(clean)) return null;
  return { pickup: await derive(clean.slice(0, 7), clean.slice(7)), nearby };
}

/** The link in the QR code: opens the download page, and Inkleaf reads it too. */
export function pickupLink(pickup: Pickup, nearby: string[] = []): string {
  return `${PICKUP_PAGE}#${pickup.code.replace(/-/g, '')}${nearby.length ? `&l=${nearby.join(',')}` : ''}`;
}

export async function sealForPickup(pickup: Pickup, name: string, file: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const nameBytes = new TextEncoder().encode(name).slice(0, 1000);
  const plain = new Uint8Array(2 + nameBytes.length + file.length);
  new DataView(plain.buffer).setUint16(0, nameBytes.length);
  plain.set(nameBytes, 2);
  plain.set(file, 2 + nameBytes.length);
  const aad = new TextEncoder().encode(`INKSEND1${pickup.id}`);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, pickup.key, plain));
  const out = new Uint8Array(MAGIC.length + 12 + sealed.length);
  out.set(MAGIC);
  out.set(iv, MAGIC.length);
  out.set(sealed, MAGIC.length + 12);
  return out;
}

export async function openPickup(pickup: Pickup, data: Uint8Array): Promise<{ name: string; file: Uint8Array } | null> {
  if (data.length < MAGIC.length + 12 + 16 || MAGIC.some((b, i) => data[i] !== b)) return null;
  try {
    const aad = new TextEncoder().encode(`INKSEND1${pickup.id}`);
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: data.slice(MAGIC.length, MAGIC.length + 12), additionalData: aad }, pickup.key, data.slice(MAGIC.length + 12)));
    const length = new DataView(plain.buffer).getUint16(0);
    return { name: new TextDecoder().decode(plain.slice(2, 2 + length)), file: plain.slice(2 + length) };
  } catch {
    return null;
  }
}
