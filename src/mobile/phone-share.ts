// SPDX-License-Identifier: GPL-3.0-or-later
// Share securely on phones: the phone's side of what src/main/device-key.ts
// and src/main/pickup.ts do on a computer.
//
// Receive code: the phone gets its own X25519 key pair the first time it's
// needed. The private half is kept in the phone's secure storage (the Android
// Keystore), like API keys are; the editor only ever sees the public receive
// code and the PDFs it opens.
//
// Pickup codes: a phone sends through the relay only. It can't reliably keep a
// server running for others on the Wi-Fi, since Android pauses apps in the
// background. When receiving, it tries the sender's Wi-Fi addresses from the
// QR code first (a computer sending on the same network), then the relay.
// Everything here is already encrypted by the editor; this only moves
// scrambled bytes.

import { CapacitorHttp } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { PickupEvent } from '../shared/api';
import { openLocked, receiveCodeFor, type OpenResult } from '../shared/lock';

const RELAY = 'https://inkleaf-relay.vercel.app';
const KEY_NAME = 'device-key';

// --- receive code -----------------------------------------------------------------------------

interface StoredKey { publicKey: string; privateKey: string; created: string }

const toB64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

let cached: { publicKey: Uint8Array; privateKey: CryptoKey } | null = null;

async function loadKey(create: boolean, relayT: (text: string) => string) {
  if (cached) return cached;
  let stored: StoredKey | null = null;
  try {
    const raw = await SecureStorage.get(KEY_NAME);
    stored = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) as StoredKey : null;
  } catch {
    stored = null;
  }
  if (!stored) {
    if (!create) return null;
    let pair: CryptoKeyPair;
    try {
      pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    } catch {
      throw new Error(relayT('This phone’s web engine is too old for receive codes. Update Android System WebView from the Play Store, then try again.'));
    }
    stored = {
      publicKey: toB64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
      privateKey: toB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
      created: new Date().toISOString(),
    };
    await SecureStorage.set(KEY_NAME, JSON.stringify(stored));
  }
  const privateKey = await crypto.subtle.importKey('pkcs8', fromB64(stored.privateKey) as BufferSource, { name: 'X25519' }, false, ['deriveBits']);
  cached = { publicKey: fromB64(stored.publicKey), privateKey };
  return cached;
}

export async function phoneReceiveCode(relayT: (text: string) => string): Promise<string> {
  const keys = await loadKey(true, relayT);
  return receiveCodeFor(keys!.publicKey);
}

export async function phoneOpenLocked(data: Uint8Array): Promise<OpenResult> {
  const keys = await loadKey(false, (s) => s).catch(() => null);
  if (!keys) return { ok: false, reason: 'other-device' };
  return openLocked(new Uint8Array(data), keys.privateKey, keys.publicKey);
}

// --- sending ----------------------------------------------------------------------------------

const listeners = new Set<(event: PickupEvent) => void>();
const report = (event: PickupEvent) => listeners.forEach((l) => l(event));

export function onPhonePickupEvent(handler: (event: PickupEvent) => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** Uploads a sealed file to the relay in the background. A phone offers nothing on the Wi-Fi itself. */
export async function phoneSendPickup(id: string, check: string, data: Uint8Array, relayT: (text: string, vars?: Record<string, string | number>) => string): Promise<string[]> {
  void (async () => {
    try {
      report({ id, state: 'uploading', percent: 0 });
      const start = await CapacitorHttp.post({
        url: `${RELAY}/api/drop?action=start`,
        headers: { 'content-type': 'application/json' },
        data: { id, check, size: data.length },
        connectTimeout: 20_000, readTimeout: 30_000,
      });
      if (start.status === 413) throw new Error(relayT('It’s too big to send over the internet (100 MB at most).'));
      if (start.status < 200 || start.status >= 300) throw new Error(relayT('The relay didn’t accept it ({status}).', { status: start.status }));
      const ticket = (typeof start.data === 'string' ? JSON.parse(start.data) : start.data) as { clientToken?: string; uploadUrl?: string; pathname: string };
      if (ticket.uploadUrl) {
        const put = await fetch(ticket.uploadUrl, { method: 'PUT', body: data as BodyInit });
        if (!put.ok) throw new Error(relayT('The upload didn’t finish ({status}).', { status: put.status }));
      } else if (ticket.clientToken) {
        // Vercel Blob takes uploads straight from the page (its storage allows any origin)
        const { put } = await import('@vercel/blob/client');
        await put(ticket.pathname, new Blob([data as BlobPart]), {
          access: 'public', token: ticket.clientToken, contentType: 'application/octet-stream',
          multipart: data.length > 8 * 1024 * 1024,
          onUploadProgress: (p) => report({ id, state: 'uploading', percent: Math.round(p.percentage) }),
        });
      } else {
        throw new Error(relayT('The relay sent back something unexpected.'));
      }
      report({ id, state: 'uploaded' });
    } catch (err) {
      const offline = err instanceof TypeError || /network|timeout|resolve host/i.test(String((err as Error)?.message));
      report({ id, state: 'upload-failed', message: offline ? relayT('This phone seems to be offline.') : (err as Error).message });
    }
  })();
  return [];
}

// --- receiving --------------------------------------------------------------------------------

/** GETs bytes with the native HTTP client (no web-page rules about cross-site or plain-http addresses). */
async function getBytes(url: string, seconds: number): Promise<Uint8Array | null> {
  try {
    const response = await CapacitorHttp.get({ url, responseType: 'arraybuffer', connectTimeout: seconds * 1000, readTimeout: seconds * 1000 });
    if (response.status < 200 || response.status >= 300) return null;
    return typeof response.data === 'string' ? fromB64(response.data) : new Uint8Array(response.data as ArrayBuffer);
  } catch {
    return null;
  }
}

export async function phoneFetchPickup(id: string, check: string, nearby: string[]): Promise<{ ok: true; data: Uint8Array; via: 'wifi' | 'internet' } | { ok: false; reason: 'gone' | 'offline' }> {
  const path = `/inkleaf-drop/${id}/${check}`;
  for (const address of nearby.slice(0, 4)) {
    if (!/^[\d.]+:\d+$/.test(address)) continue;
    const data = await getBytes(`http://${address}${path}`, 3);
    if (data) return { ok: true, data, via: 'wifi' };
  }
  try {
    const where = await CapacitorHttp.get({ url: `${RELAY}/api/drop?id=${id}&check=${check}`, connectTimeout: 15_000, readTimeout: 15_000 });
    if (where.status < 200 || where.status >= 300) return { ok: false, reason: 'gone' };
    const { url } = (typeof where.data === 'string' ? JSON.parse(where.data) : where.data) as { url: string };
    const data = await getBytes(`${url}?fresh=${Date.now()}`, 300);
    return data ? { ok: true, data, via: 'internet' } : { ok: false, reason: 'gone' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

export async function phoneForgetPickup(id: string, token: string): Promise<void> {
  try {
    await CapacitorHttp.post({ url: `${RELAY}/api/drop?action=delete`, headers: { 'content-type': 'application/json' }, data: { id, token }, connectTimeout: 15_000, readTimeout: 15_000 });
  } catch {
    // it expires on its own anyway
  }
}
