// SPDX-License-Identifier: GPL-3.0-or-later
// The computer's end of the phone link (see src/shared/link-protocol.ts).
//
// A small HTTP server on the local network, started only when the person
// pairs a phone or already has one paired. Everything it accepts must be
// encrypted with a key that was shown on this screen as a QR code, so other
// people on the same Wi-Fi can't send files in or read what's sent out.

import { t } from '../shared/i18n';
import { app, safeStorage } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  b64, encodePairing, LINK_PATH, LINK_PORT, newSecret, open, PAIRING_MINUTES, randomId, seal, unb64,
  type Envelope, type LinkDevice, type LinkEvent, type LinkMessage, type LinkReply, type LinkStatus,
} from '../shared/link-protocol';

interface StoredDevice {
  id: string;
  name: string;
  /** the shared secret, encrypted with the system keychain when it can be */
  key: string;
  sealed: boolean;
  pairedAt: number;
}

interface Stored {
  id: string;
  devices: StoredDevice[];
}

const file = () => path.join(app.getPath('userData'), 'link.json');
const MAX_BODY = 200 * 1024 * 1024;
/** A long poll waits this long for something to send before answering "nothing yet". */
const POLL_SECONDS = 25;

let stored: Stored | null = null;
function load(): Stored {
  if (stored) return stored;
  try {
    stored = JSON.parse(readFileSync(file(), 'utf8')) as Stored;
  } catch {
    stored = { id: randomId(), devices: [] };
  }
  return stored;
}
const save = () => writeFileSync(file(), JSON.stringify(load()), { mode: 0o600 });

const secretOf = (device: StoredDevice) =>
  device.sealed ? safeStorage.decryptString(Buffer.from(device.key, 'base64')) : device.key;

function sealSecret(secret: string): { key: string; sealed: boolean } {
  if (safeStorage.isEncryptionAvailable()) return { key: safeStorage.encryptString(secret).toString('base64'), sealed: true };
  return { key: secret, sealed: false };
}

const computerName = () => os.hostname().replace(/\.local$/, '') || 'Computer';

/** IPv4 addresses on private networks: where a phone on the same Wi-Fi can reach us. */
function localAddresses(): string[] {
  // tests run on machines with no home network: let them name an address (never in the installed app)
  if (!app.isPackaged && process.env.INKLEAF_TEST_LINK_HOSTS) return process.env.INKLEAF_TEST_LINK_HOSTS.split(',');
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  // home Wi-Fi first: 192.168.x is the most common
  return out.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

// --- state while running -------------------------------------------------------------------------

let server: Server | null = null;
let port = 0;
/** QR secrets shown recently, waiting for a phone to use them. */
const pending = new Map<string, number>();
const lastSeen = new Map<string, number>();
const outbox = new Map<string, { name: string; data: string }[]>();
const waiting = new Map<string, () => void>();

let notify: (event: LinkEvent) => void = () => {};
let deliver: (file: { name: string; data: Uint8Array; from: string }) => void = () => {};

export function startLink(handlers: { onEvent: (e: LinkEvent) => void; onFile: (f: { name: string; data: Uint8Array; from: string }) => void }) {
  notify = handlers.onEvent;
  deliver = handlers.onFile;
  // only listen on the network when there's a phone to talk to
  if (load().devices.length) void listen().catch(() => {});
}

function listen(): Promise<void> {
  if (server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => void handle(req, res));
    const tryPort = (p: number) => {
      s.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && p !== 0) tryPort(0);
        else reject(err);
      });
      s.listen(p, '0.0.0.0', () => {
        server = s;
        port = (s.address() as { port: number }).port;
        resolve();
      });
    };
    tryPort(LINK_PORT);
  });
}

export function stopLink() {
  const closing = server;
  server = null;
  if (!closing) return;
  closing.close();
  // close() only stops new connections; a phone could keep using one it already has open.
  // Idle ones go now, the rest once any last reply (such as "you were removed") has gone out.
  closing.closeIdleConnections();
  setTimeout(() => closing.closeAllConnections(), 1000).unref();
}

// --- talking to phones ------------------------------------------------------------------------

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    // the phone app's web view sends from its own origin
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('too big');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') return reply(res, 204, null);
  if (req.method !== 'POST' || req.url !== LINK_PATH) return reply(res, 404, { ok: false });
  let envelope: Envelope & { from?: string };
  try {
    envelope = JSON.parse(await readBody(req));
  } catch {
    return reply(res, 400, { ok: false });
  }

  // which key? a paired phone's, or one of the QR codes on screen
  const device = load().devices.find((d) => d.id === envelope.from);
  const candidates = device ? [secretOf(device)] : [...pending.keys()];
  let message: LinkMessage | null = null;
  let secret = '';
  for (const s of candidates) {
    try {
      message = await open<LinkMessage>(s, envelope);
      secret = s;
      break;
    } catch {
      // not this key
    }
  }
  // unknown sender or tampered message: say nothing useful
  if (!message) return reply(res, 403, { ok: false });

  const answer = async (body: LinkReply) => reply(res, 200, await seal(secret, body));

  if (!device) {
    if (message.type !== 'pair') return reply(res, 403, { ok: false });
    pending.delete(secret);
    const store = load();
    store.devices = store.devices.filter((d) => d.id !== message!.id);
    store.devices.push({ id: message.id, name: String(message.name).slice(0, 60) || 'Phone', ...sealSecret(secret), pairedAt: Date.now() });
    save();
    lastSeen.set(message.id, Date.now());
    notify({ type: 'paired', name: message.name });
    return answer({ ok: true, name: computerName() });
  }

  lastSeen.set(device.id, Date.now());
  switch (message.type) {
    case 'hello':
      notify({ type: 'changed' });
      return answer({ ok: true, name: computerName() });
    case 'send': {
      const name = String(message.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'Document.pdf';
      deliver({ name, data: unb64(message.data), from: device.name });
      notify({ type: 'received', name, from: device.name });
      return answer({ ok: true });
    }
    case 'poll': {
      const queued = outbox.get(device.id) ?? [];
      if (!queued.length) {
        // hold the request open until there's something to send, or time runs out
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_SECONDS * 1000);
          waiting.get(device.id)?.();
          waiting.set(device.id, () => {
            clearTimeout(timer);
            resolve();
          });
          req.on('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        waiting.delete(device.id);
        // removed on this computer while it waited: tell the phone, so it stops asking
        if (!load().devices.some((d) => d.id === device.id)) return reply(res, 403, { ok: false });
      }
      const files = outbox.get(device.id) ?? [];
      outbox.delete(device.id);
      if (res.writableEnded || res.destroyed) {
        // the phone went away mid-wait: keep the files for next time
        if (files.length) outbox.set(device.id, files);
        return;
      }
      return answer({ ok: true, files });
    }
    case 'unpair':
      forget(device.id);
      return answer({ ok: true });
    default:
      return reply(res, 400, { ok: false });
  }
}

// --- what the window asks for ------------------------------------------------------------------

/** Shows a new QR code. Starts listening if needed. */
export async function startPairing(): Promise<{ code: string; addresses: string[]; port: number }> {
  const addresses = localAddresses();
  if (!addresses.length) throw new Error(t('This computer isn’t on a local network. Connect it to the same Wi-Fi as your phone.'));
  await listen();
  const secret = newSecret();
  pending.set(secret, Date.now());
  setTimeout(() => pending.delete(secret), PAIRING_MINUTES * 60 * 1000);
  return { code: encodePairing({ d: load().id, n: computerName(), h: addresses, p: port, k: secret }), addresses, port };
}

export function linkStatus(): LinkStatus {
  const now = Date.now();
  const devices: LinkDevice[] = load().devices.map((d) => {
    const seen = lastSeen.get(d.id) ?? 0;
    return { id: d.id, name: d.name, lastSeen: seen, online: now - seen < 70_000 };
  });
  return { name: computerName(), devices };
}

/** Queues a file for a phone; it picks it up on its next poll. */
export function sendToDevice(id: string, name: string, data: Uint8Array) {
  if (!load().devices.some((d) => d.id === id)) throw new Error(t('That phone isn’t paired any more.'));
  const queue = outbox.get(id) ?? [];
  queue.push({ name, data: b64(data) });
  outbox.set(id, queue);
  waiting.get(id)?.();
}

export function forget(id: string) {
  const store = load();
  store.devices = store.devices.filter((d) => d.id !== id);
  save();
  outbox.delete(id);
  waiting.get(id)?.();
  if (!store.devices.length && !pending.size) stopLink();
  notify({ type: 'changed' });
}

void existsSync;
