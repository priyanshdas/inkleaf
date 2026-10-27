// SPDX-License-Identifier: GPL-3.0-or-later
// The phone's end of the phone ↔ computer link (see src/shared/link-protocol.ts).
//
// After scanning the computer's QR code, the phone keeps one request open to
// the computer while Inkleaf is on screen ("anything for me?"), so files sent
// from the computer arrive within a moment. Phones can't run a server that
// computers could reach reliably, so the computer is always the one listening.

import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import type { OpenedFile } from '../shared/api';
import {
  decodePairing, LINK_PATH, open, randomId, seal,
  type Envelope, type LinkEvent, type LinkMessage, type LinkReply, type LinkStatus,
} from '../shared/link-protocol';

interface Paired {
  /** this phone's id, as the computer knows it */
  id: string;
  computer: { id: string; name: string; hosts: string[]; port: number };
  lastSeen: number;
}

interface Helpers {
  toBase64(bytes: Uint8Array): string;
  fromBase64(text: string): Uint8Array;
  intoLibrary(name: string, data: Uint8Array): Promise<OpenedFile>;
  deliver(file: OpenedFile): void;
}

const native = Capacitor.getPlatform() !== 'web';
const SECRET = 'link-secret';

function readPaired(): Paired | null {
  try {
    return JSON.parse(localStorage.getItem('inkleaf.link') ?? 'null') as Paired | null;
  } catch {
    return null;
  }
}
const writePaired = (p: Paired | null) => {
  try {
    if (p) localStorage.setItem('inkleaf.link', JSON.stringify(p));
    else localStorage.removeItem('inkleaf.link');
  } catch {
    // nothing more we can do
  }
};

async function readSecret(): Promise<string> {
  if (!native) return localStorage.getItem('inkleaf.link-secret') ?? '';
  return String((await SecureStorage.get(SECRET).catch(() => '')) ?? '');
}
async function writeSecret(secret: string | null) {
  if (!native) {
    if (secret) localStorage.setItem('inkleaf.link-secret', secret);
    else localStorage.removeItem('inkleaf.link-secret');
    return;
  }
  if (secret) await SecureStorage.set(SECRET, secret);
  else await SecureStorage.remove(SECRET).catch(() => {});
}

/** A friendly name for this phone, from what the browser engine reports. */
function phoneName(): string {
  const ua = navigator.userAgent;
  const android = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(ua);
  if (android) return android[1].trim();
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  return 'Phone';
}

/** One request to the computer. Native HTTP on phones (no mixed-content or cross-site limits). */
async function post(host: string, port: number, body: Envelope & { from?: string }, seconds: number): Promise<{ status: number; data: unknown }> {
  const url = `http://${host}:${port}${LINK_PATH}`;
  if (native) {
    const response = await CapacitorHttp.post({
      url, data: body, headers: { 'content-type': 'application/json' },
      connectTimeout: 4000, readTimeout: seconds * 1000, responseType: 'json',
    });
    return { status: response.status, data: response.data };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal: controller.signal });
    return { status: response.status, data: await response.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
}

export function createLink(helpers: Helpers) {
  const handlers: ((event: LinkEvent) => void)[] = [];
  const emit = (event: LinkEvent) => handlers.forEach((h) => h(event));
  let polling = false;
  let active = true;
  /** The address that last worked goes first. */
  let preferred = '';

  /** Sends one message to the paired computer, trying each of its addresses. */
  async function talk(message: LinkMessage, seconds = 30): Promise<LinkReply> {
    const paired = readPaired();
    const secret = await readSecret();
    if (!paired || !secret) throw new Error(window.inkleafT('This phone isn’t connected to a computer yet.'));
    const hosts = [...new Set([preferred, ...paired.computer.hosts].filter(Boolean))];
    let lastError: unknown = null;
    for (const host of hosts) {
      try {
        const envelope = await seal(secret, message);
        const response = await post(host, paired.computer.port, { ...envelope, from: paired.id }, seconds);
        if (response.status === 403) throw Object.assign(new Error('forgotten'), { forgotten: true });
        if (response.status !== 200) throw new Error(`status ${response.status}`);
        const reply = await open<LinkReply>(secret, response.data as Envelope);
        preferred = host;
        writePaired({ ...paired, lastSeen: Date.now() });
        return reply;
      } catch (err) {
        if ((err as { forgotten?: boolean }).forgotten) {
          // the computer no longer knows this phone (it was removed there)
          writePaired(null);
          await writeSecret(null);
          emit({ type: 'changed' });
          throw new Error(window.inkleafT('Your computer has forgotten this phone. Connect them again.'));
        }
        lastError = err;
      }
    }
    void lastError;
    throw new Error(window.inkleafT('Couldn’t reach {name}. Check that it’s on, Inkleaf is open, and both are on the same Wi-Fi.', { name: paired.computer.name }));
  }

  /** Keeps asking the computer for files while Inkleaf is on screen. */
  async function pollLoop() {
    if (polling) return;
    polling = true;
    let wait = 2000;
    try {
      while (active && readPaired()) {
        try {
          const reply = await talk({ type: 'poll', id: readPaired()!.id }, 35);
          wait = 2000;
          if (reply.ok && reply.files?.length) {
            for (const f of reply.files) {
              const opened = await helpers.intoLibrary(f.name, helpers.fromBase64(f.data));
              helpers.deliver(opened);
              emit({ type: 'received', name: opened.name, from: readPaired()?.computer.name ?? '' });
            }
          }
          emit({ type: 'changed' });
        } catch {
          // the computer is off or on another network: try again, more slowly
          await new Promise((resolve) => setTimeout(resolve, wait));
          wait = Math.min(wait * 2, 30_000);
        }
      }
    } finally {
      polling = false;
    }
  }

  // follow the app coming and going from the screen
  document.addEventListener('visibilitychange', () => {
    active = document.visibilityState === 'visible';
    if (active) void pollLoop();
  });
  setTimeout(() => void pollLoop(), 1000);

  return {
    async linkStatus(): Promise<LinkStatus> {
      const paired = readPaired();
      return {
        name: phoneName(),
        devices: paired
          ? [{ id: paired.computer.id, name: paired.computer.name, lastSeen: paired.lastSeen, online: Date.now() - paired.lastSeen < 70_000 }]
          : [],
      };
    },
    async linkPair(): Promise<{ code: string; addresses: string[]; port: number }> {
      throw new Error('Phones scan the code a computer shows.');
    },
    async linkJoin(code: string): Promise<{ name: string }> {
      const pairing = decodePairing(code);
      if (!pairing) throw new Error(window.inkleafT('That isn’t an Inkleaf code. On your computer, open Tools › Connect a phone.'));
      const id = readPaired()?.id ?? randomId();
      for (const host of pairing.h) {
        try {
          const envelope = await seal(pairing.k, { type: 'pair', id, name: phoneName() });
          const response = await post(host, pairing.p, envelope, 15);
          if (response.status !== 200) continue;
          const reply = await open<LinkReply>(pairing.k, response.data as Envelope);
          if (!reply.ok) continue;
          await writeSecret(pairing.k);
          writePaired({ id, computer: { id: pairing.d, name: reply.name ?? pairing.n, hosts: pairing.h, port: pairing.p }, lastSeen: Date.now() });
          preferred = host;
          emit({ type: 'paired', name: reply.name ?? pairing.n });
          void pollLoop();
          return { name: reply.name ?? pairing.n };
        } catch {
          // try the computer's next address
        }
      }
      throw new Error(window.inkleafT('Couldn’t reach {name}. Check that it’s on, Inkleaf is open, and both are on the same Wi-Fi.', { name: pairing.n }));
    },
    async linkSend(_deviceId: string, name: string, data: Uint8Array): Promise<void> {
      const reply = await talk({ type: 'send', id: readPaired()?.id ?? '', name, data: helpers.toBase64(data) }, 120);
      if (!reply.ok) throw new Error(reply.error);
    },
    async linkForget(): Promise<void> {
      const paired = readPaired();
      if (paired) await talk({ type: 'unpair', id: paired.id }, 8).catch(() => {});
      writePaired(null);
      await writeSecret(null);
      emit({ type: 'changed' });
    },
    onLinkEvent(handler: (event: LinkEvent) => void) {
      handlers.push(handler);
    },
  };
}
