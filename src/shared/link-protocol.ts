// SPDX-License-Identifier: GPL-3.0-or-later
// Phone ↔ computer link, the part both ends share.
//
// The computer runs a small server on the local network (src/main/link.ts).
// To pair, it shows a QR code holding its addresses and a fresh random
// secret; the phone scans it, and from then on that secret is the key both
// sides use. Nothing goes through the internet or any server of ours.
//
// Every request and answer is a JSON envelope { iv, data } where data is
// AES-256-GCM-encrypted JSON. Messages carry a timestamp and a random nonce,
// so a recorded message can't be replayed later. The key itself never
// travels over the network: only through the QR code on the screen.

export const LINK_PORT = 47731;
export const LINK_PATH = '/inkleaf-link/v1';
/** How long the computer accepts a QR code after showing it. */
export const PAIRING_MINUTES = 10;
/** Messages older (or newer) than this are refused. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/** What the QR code says. */
export interface PairingCode {
  /** the computer's id */
  d: string;
  /** the computer's name, shown on the phone */
  n: string;
  /** the computer's addresses on the local network */
  h: string[];
  p: number;
  /** the shared secret, base64url */
  k: string;
}

export type LinkMessage =
  | { type: 'pair'; id: string; name: string }
  | { type: 'hello'; id: string }
  | { type: 'send'; id: string; name: string; data: string }
  | { type: 'poll'; id: string }
  | { type: 'unpair'; id: string };

export type LinkReply =
  | { ok: true; name?: string; files?: { name: string; data: string }[] }
  | { ok: false; error: string };

export interface LinkDevice {
  id: string;
  name: string;
  /** seen in the last minute or so */
  online: boolean;
  lastSeen: number;
}

export interface LinkStatus {
  /** this device's own name */
  name: string;
  /** phones (on a computer) or the computer (on a phone) paired with this device */
  devices: LinkDevice[];
}

export type LinkEvent =
  | { type: 'paired'; name: string }
  | { type: 'received'; name: string; from: string }
  | { type: 'changed' };

// --- encoding ------------------------------------------------------------------------------------

export function b64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function unb64(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomId(bytes = 16): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newSecret(): string {
  return randomId(32);
}

export function encodePairing(code: PairingCode): string {
  return `inkleaf-link:1:${b64url(new TextEncoder().encode(JSON.stringify(code)))}`;
}

export function decodePairing(text: string): PairingCode | null {
  const match = /^inkleaf-link:1:([A-Za-z0-9_-]+)$/.exec(text.trim());
  if (!match) return null;
  try {
    const code = JSON.parse(new TextDecoder().decode(unb64(match[1]))) as PairingCode;
    if (!code.d || !code.k || !Array.isArray(code.h) || !code.h.length || !Number.isInteger(code.p)) return null;
    return code;
  } catch {
    return null;
  }
}

// --- encryption ----------------------------------------------------------------------------------

const keys = new Map<string, Promise<CryptoKey>>();

/** The AES key for a shared secret (derived with HKDF, cached). */
function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = (async () => {
      const raw = await crypto.subtle.importKey('raw', unb64(secret) as BufferSource, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('inkleaf-link'), info: new TextEncoder().encode('v1') },
        raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    })();
    keys.set(secret, key);
  }
  return key;
}

export interface Envelope {
  iv: string;
  data: string;
}

/** Encrypts a message (adding the timestamp and nonce that stop replays). */
export async function seal(secret: string, message: object): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ ...message, at: Date.now(), nonce: randomId(12) }));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), plain));
  return { iv: b64(iv), data: b64(data) };
}

const seenNonces = new Map<string, number>();

/** Decrypts and checks a message. Throws if it was tampered with, is stale or was seen before. */
export async function open<T>(secret: string, envelope: Envelope): Promise<T> {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) as BufferSource }, await keyFor(secret), unb64(envelope.data) as BufferSource);
  const message = JSON.parse(new TextDecoder().decode(plain)) as T & { at: number; nonce: string };
  const now = Date.now();
  if (typeof message.at !== 'number' || Math.abs(now - message.at) > MAX_SKEW_MS) throw new Error('stale message');
  if (seenNonces.has(message.nonce)) throw new Error('replayed message');
  seenNonces.set(message.nonce, now);
  if (seenNonces.size > 5000) {
    for (const [nonce, at] of seenNonces) if (now - at > MAX_SKEW_MS) seenNonces.delete(nonce);
  }
  return message;
}
