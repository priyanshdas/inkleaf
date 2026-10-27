// SPDX-License-Identifier: GPL-3.0-or-later
// This computer's own key pair, for PDFs locked to one person's device
// (see shared/lock.ts). It's made the first time it's needed. The private
// half is sealed with the operating system's keychain (safeStorage) and never
// leaves this process: the window only ever sees the public receive code and
// the PDFs it opens.

import { t } from '../shared/i18n';
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openLocked, receiveCodeFor, type OpenResult } from '../shared/lock';

interface Stored {
  publicKey: string;
  /** PKCS#8, base64; sealed with safeStorage unless `sealed` is false (tests only) */
  privateKey: string;
  sealed: boolean;
  created: string;
}

const file = () => path.join(app.getPath('userData'), 'device-key.json');

// tests on a Linux box without a keychain can keep the key in the clear
const plainAllowed = () => !app.isPackaged && process.env.INKLEAF_TEST_PLAIN_KEYS === '1';

let cached: { publicKey: Uint8Array; privateKey: CryptoKey } | null = null;

function read(): Stored | null {
  if (!existsSync(file())) return null;
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Stored;
  } catch {
    return null;
  }
}

async function load(create: boolean): Promise<{ publicKey: Uint8Array; privateKey: CryptoKey } | null> {
  if (cached) return cached;
  let stored = read();
  if (!stored) {
    if (!create) return null;
    const sealable = safeStorage.isEncryptionAvailable();
    if (!sealable && !plainAllowed()) {
      throw new Error(t('This computer can’t store a private key securely, so it can’t have a receive code. On Linux, this needs a keyring such as GNOME Keyring or KWallet.'));
    }
    const pair = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
    stored = {
      publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64'),
      privateKey: sealable ? safeStorage.encryptString(pkcs8).toString('base64') : pkcs8,
      sealed: sealable,
      created: new Date().toISOString(),
    };
    writeFileSync(file(), JSON.stringify(stored), { mode: 0o600 });
  }
  const pkcs8 = stored.sealed ? safeStorage.decryptString(Buffer.from(stored.privateKey, 'base64')) : stored.privateKey;
  if (!stored.sealed && !plainAllowed()) throw new Error(t('This computer’s receive key isn’t stored securely.'));
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(pkcs8, 'base64'), { name: 'X25519' }, false, ['deriveBits']);
  cached = { publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64')), privateKey };
  return cached;
}

/** This computer's receive code, making the key pair if there isn't one yet. */
export async function receiveCode(): Promise<string> {
  const keys = await load(true);
  return receiveCodeFor(keys!.publicKey);
}

/** Opens a PDF that was locked for a device. */
export async function openForThisDevice(data: Uint8Array): Promise<OpenResult> {
  const keys = await load(false).catch(() => null);
  // no key here at all: it can't have been locked for this computer
  if (!keys) return { ok: false, reason: 'other-device' };
  return openLocked(new Uint8Array(data), keys.privateKey, keys.publicKey);
}
