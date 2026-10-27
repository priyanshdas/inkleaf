// SPDX-License-Identifier: GPL-3.0-or-later
// Moving a file sent with a pickup code (shared/pickup.ts). Everything here
// is already encrypted by the window; this only carries scrambled bytes.
//
// Same Wi-Fi: while Inkleaf is open, it answers on the local network. The
//   other computer finds it with a broadcast ("who has file K7QF2M4?") or from
//   the addresses in the QR code, and downloads it directly. Nothing leaves
//   the network.
// Anywhere else: it's uploaded to the relay (relay/ in the source), which
//   keeps it until it's picked up, or for 7 days at most.

import { t } from '../shared/i18n';
import { app } from 'electron';
import dgram from 'node:dgram';
import http from 'node:http';
import os from 'node:os';

const DISCOVERY_PORT = 47733;
const DEFAULT_RELAY = 'https://inkleaf-relay.vercel.app';

/** The relay; tests point it at a local stand-in. */
function relay(): string {
  return (!app.isPackaged && process.env.INKLEAF_TEST_RELAY) || DEFAULT_RELAY;
}

// --- serving on this network ---------------------------------------------------------------

const waiting = new Map<string, { check: string; data: Uint8Array; onTaken: () => void }>();
let server: http.Server | null = null;
let serverPort = 0;
let finder: dgram.Socket | null = null;

function localAddresses(): { address: string; broadcast: string }[] {
  const out: { address: string; broadcast: string }[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number), mask = a.netmask.split('.').map(Number);
      out.push({ address: a.address, broadcast: ip.map((p, i) => (p | (~mask[i] & 255))).join('.') });
    }
  }
  return out;
}

async function ensureServing(): Promise<void> {
  if (!server) {
    server = http.createServer((req, res) => {
      const m = /^\/inkleaf-drop\/([0-9A-Z]{7})\/([0-9a-f]{32})$/.exec(req.url ?? '');
      const item = m && waiting.get(m[1]);
      if (req.method !== 'GET' || !item || item.check !== m![2]) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': item.data.length });
      res.end(Buffer.from(item.data), () => item.onTaken());
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '0.0.0.0', () => resolve());
    });
    serverPort = (server.address() as { port: number }).port;
  }
  if (!finder) {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg, from) => {
      try {
        const ask = JSON.parse(msg.toString());
        if (ask?.t === 'inkleaf-find' && waiting.has(ask.id)) {
          socket.send(JSON.stringify({ t: 'inkleaf-here', id: ask.id, port: serverPort }), from.port, from.address);
        }
      } catch {
        // not for us
      }
    });
    socket.on('error', () => { finder = null; });
    await new Promise<void>((resolve) => socket.bind(DISCOVERY_PORT, () => resolve()));
    finder = socket;
  }
}

// --- sending ------------------------------------------------------------------------------------

export type SendEvent =
  | { id: string; state: 'uploading'; percent: number }
  | { id: string; state: 'uploaded' }
  | { id: string; state: 'upload-failed'; message: string }
  | { id: string; state: 'taken' };

/**
 * Offers a sealed file on this network straight away and uploads it to the
 * relay in the background. Resolves to the Wi-Fi addresses (for the QR code).
 */
export async function startSending(id: string, check: string, data: Uint8Array, report: (e: SendEvent) => void): Promise<string[]> {
  let nearby: string[] = [];
  try {
    await ensureServing();
    waiting.set(id, { check, data, onTaken: () => report({ id, state: 'taken' }) });
    nearby = localAddresses().map((a) => `${a.address}:${serverPort}`);
  } catch {
    // no local network: the relay can still carry it
  }
  void upload(id, check, data, report);
  return nearby;
}

async function upload(id: string, check: string, data: Uint8Array, report: (e: SendEvent) => void) {
  try {
    report({ id, state: 'uploading', percent: 0 });
    const res = await fetch(`${relay()}/api/drop?action=start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, check, size: data.length }),
    });
    if (res.status === 413) throw new Error(t('It’s too big to send over the internet (100 MB at most). People on the same Wi-Fi can still get it.'));
    if (!res.ok) throw new Error(t('The relay didn’t accept it ({status}).', { status: res.status }));
    const ticket = await res.json() as { clientToken?: string; uploadUrl?: string; pathname: string };
    if (ticket.uploadUrl) {
      // a relay that takes the file itself (self-hosted, or the tests' stand-in)
      const put = await fetch(ticket.uploadUrl, { method: 'PUT', body: Buffer.from(data) });
      if (!put.ok) throw new Error(t('The upload didn’t finish ({status}).', { status: put.status }));
    } else if (ticket.clientToken) {
      const { put } = await import('@vercel/blob/client');
      await put(ticket.pathname, Buffer.from(data), {
        access: 'public', token: ticket.clientToken, contentType: 'application/octet-stream',
        multipart: data.length > 8 * 1024 * 1024,
        onUploadProgress: (p) => report({ id, state: 'uploading', percent: Math.round(p.percentage) }),
      });
    } else {
      throw new Error(t('The relay sent back something unexpected.'));
    }
    report({ id, state: 'uploaded' });
  } catch (err) {
    const offline = err instanceof TypeError;
    report({ id, state: 'upload-failed', message: offline ? t('This computer seems to be offline.') : (err as Error).message });
  }
}

/** Stops offering a file on this network (it may still be on the relay). */
export function stopSending(id: string) {
  waiting.delete(id);
}

// --- receiving ----------------------------------------------------------------------------------

async function fetchWithin(url: string, ms: number): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/** Asks the local network who has this file. */
function findNearby(id: string, ms = 1500): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const done = (answer: string | null) => {
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), ms);
    socket.on('error', () => done(null));
    socket.on('message', (msg, from) => {
      try {
        const reply = JSON.parse(msg.toString());
        if (reply?.t === 'inkleaf-here' && reply.id === id && Number.isInteger(reply.port)) done(`${from.address}:${reply.port}`);
      } catch {
        // not for us
      }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const ask = Buffer.from(JSON.stringify({ t: 'inkleaf-find', id }));
      const targets = new Set(['255.255.255.255', ...localAddresses().map((a) => a.broadcast)]);
      for (const target of targets) socket.send(ask, DISCOVERY_PORT, target);
    });
  });
}

export type FetchResult =
  | { ok: true; data: Uint8Array; via: 'wifi' | 'internet' }
  | { ok: false; reason: 'gone' | 'offline' };

/** Gets a sealed file: from the same Wi-Fi if it's there, otherwise from the relay. */
export async function fetchPickup(id: string, check: string, nearby: string[]): Promise<FetchResult> {
  const path = `/inkleaf-drop/${id}/${check}`;
  for (const address of nearby.slice(0, 4)) {
    const data = await fetchWithin(`http://${address}${path}`, 2500);
    if (data) return { ok: true, data, via: 'wifi' };
  }
  const found = await findNearby(id);
  if (found) {
    const data = await fetchWithin(`http://${found}${path}`, 60_000);
    if (data) return { ok: true, data, via: 'wifi' };
  }
  try {
    const res = await fetch(`${relay()}/api/drop?id=${id}&check=${check}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return { ok: false, reason: 'gone' };
    const { url } = await res.json() as { url: string };
    // a fresh copy, never a cached one: once it's picked up it should be gone
    const file = await fetch(`${url}?fresh=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(5 * 60_000) });
    if (!file.ok) return { ok: false, reason: 'gone' };
    return { ok: true, data: new Uint8Array(await file.arrayBuffer()), via: 'internet' };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** Once it's safely opened: remove it from the relay, so nobody else can fetch even the scrambled copy. */
export async function forgetPickup(id: string, deleteToken: string): Promise<void> {
  try {
    await fetch(`${relay()}/api/drop?action=delete`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, token: deleteToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // it expires on its own anyway
  }
}
