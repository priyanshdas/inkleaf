// SPDX-License-Identifier: GPL-3.0-or-later
// The phone apps' stand-in for the desktop app's main process.
//
// On a computer, Electron's main process opens and saves files, talks to the
// AI services and downloads language packs, and the editor reaches it through
// window.inkleaf (src/main/preload.ts). On Android and iPhone the editor is
// the same code inside a Capacitor app, and this file provides the same
// window.inkleaf using the phone's own features instead.
//
// How files work on a phone: a phone app can't quietly save back into a file
// it was handed, so Inkleaf keeps its own library (in the app's private
// storage). Opening a PDF copies it into the library, Save saves there, and
// Share or "Save a copy" hands a copy to other apps or the Files app.
//
// This file is loaded as a plain script before the editor. It sets up
// window.inkleaf, finishes the asynchronous set-up (where files live, the
// language packs that ship with the app), then loads the editor itself.

import './polyfills';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { FilePicker } from '@capawesome/capacitor-file-picker';
import { Share } from '@capacitor/share';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';
import { askAi, checkConfig, Http, listModels, mockAnswer, NetworkError } from '../shared/ai-core';
import { AI_PROVIDERS, AiProvider, AiProviderId, checkServerUrl, providerById } from '../shared/ai-providers';
import type {
  AiConfig, AiStatus, AppInfo, CopyKind, InkleafApi, MenuCommand, OpenedFile, PickedFile, RecentFile, RecoveredFile, ThemeSetting,
} from '../shared/api';
import { CONVERTIBLE } from '../shared/api';
import { t, UI_LANGUAGES } from '../shared/i18n';
import { createLink } from './link-client';
import { onPhonePickupEvent, phoneFetchPickup, phoneForgetPickup, phoneOpenLocked, phoneReceiveCode, phoneSendPickup } from './phone-share';
import { checkPhoneUpdates } from './phone-updates';
import { onPhoneAiEvent, phoneAiAsk, phoneAiCancel, phoneAiDownload, phoneAiRemove, phoneAiStatus, phoneAiStop } from './phone-ai';
import { LOCAL_MODELS, localModelById, type LocalAiEvent, type LocalAiStatus } from '../shared/local-models';
import type { UpdateState } from '../shared/api';
import manifest from '../shared/pack-manifest.json';

/** Native helpers that no stock plugin covers (see mobile/android/.../InkleafFilesPlugin.java). */
interface InkleafFilesPlugin {
  saveAs(options: { name: string; mime: string; data: string }): Promise<{ uri: string | null }>;
  saveMany(options: { files: { name: string; mime: string; data: string }[] }): Promise<{ folder: string | null }>;
  print(options: { name: string; data: string }): Promise<void>;
  htmlToPdf(options: { html: string; width?: number; height?: number; landscape?: boolean; margin?: number }): Promise<{ data: string }>;
  urlToPdf(options: { url: string }): Promise<{ data: string; title: string }>;
  takeIncoming(): Promise<{ files: { name: string; data: string }[] }>;
  /** Which app store installed Inkleaf, if any (added in 3.0.2; older builds lack it). */
  installSource?(): Promise<{ store: boolean }>;
  addListener(event: 'incoming', handler: () => void): Promise<{ remove: () => void }>;
}
const Native = registerPlugin<InkleafFilesPlugin>('InkleafFiles');
// the native Android screens drive the editor through this one (see src/renderer/engine.ts)
(window as unknown as { inkleafNative: unknown }).inkleafNative = registerPlugin('InkleafEngine');


const platform = Capacitor.getPlatform() as 'android' | 'ios' | 'web';
/** The Android app draws its own screens; the editor only shows the page. */
const engine = platform === 'android' || (platform === 'web' && /[?&]engine\b/.test(location.search)); // ?engine: try it in a browser
const LIBRARY = 'library';
const PACKS = 'packs';
const RECOVERY = 'recovery';
const BACKUPS = 'backups';

// --- small helpers --------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(`inkleaf.${key}`);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(`inkleaf.${key}`, JSON.stringify(value));
    } catch {
      // storage full or unavailable: the setting just isn't remembered
    }
  },
};

async function readData(path: string): Promise<Uint8Array> {
  const { data } = await Filesystem.readFile({ path, directory: Directory.Data });
  return typeof data === 'string' ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
}

async function writeData(path: string, bytes: Uint8Array) {
  await Filesystem.writeFile({ path, directory: Directory.Data, data: toBase64(bytes), recursive: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await Filesystem.stat({ path, directory: Directory.Data });
    return true;
  } catch {
    return false;
  }
}

/** A file name that's safe to store, and not already taken in the library. */
async function libraryPath(name: string): Promise<string> {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'Document.pdf';
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '.pdf';
  for (let n = 1; ; n++) {
    const candidate = `${LIBRARY}/${n === 1 ? stem : `${stem} (${n})`}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
}

const baseName = (path: string) => path.split('/').pop() ?? path;

const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', html: 'text/html', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip',
};
const mimeFor = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

const CONVERTIBLE_TYPES = [
  'application/pdf', 'image/*', 'text/plain', 'text/markdown', 'text/html', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text', 'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation', 'application/rtf',
];

async function pick(types: string[], multiple: boolean): Promise<PickedFile[]> {
  try {
    const result = await FilePicker.pickFiles({ types, limit: multiple ? 0 : 1, readData: true });
    return result.files.map((f) => ({ name: f.name, data: fromBase64(f.data ?? '') }));
  } catch (err) {
    // closing the picker isn't an error
    if (/cancel/i.test(String((err as Error)?.message ?? err))) return [];
    throw err;
  }
}

const cancelled = (err: unknown) => /cancel/i.test(String((err as Error)?.message ?? err));

// --- recent files -----------------------------------------------------------------------------

function recents(): RecentFile[] {
  return store.get<RecentFile[]>('recent', []);
}

function remember(path: string, name: string) {
  const list = recents().filter((r) => r.path !== path);
  const old = recents().find((r) => r.path === path);
  list.unshift({ path, name, openedAt: Date.now(), thumb: old?.thumb ?? null });
  store.set('recent', list.slice(0, 30));
}

/** Copies a PDF into the library so it can be saved, and remembers it. */
async function intoLibrary(name: string, data: Uint8Array): Promise<OpenedFile> {
  if (!/\.pdf$/i.test(name)) return { path: null, name, data };
  const path = await libraryPath(name);
  await writeData(path, data);
  remember(path, baseName(path));
  return { path, name: baseName(path), data };
}

// --- language packs --------------------------------------------------------------------------

type PackEntry = { url: string; size: number; sha256: string };
const PACK_FILES = (manifest as { files: Record<string, PackEntry> }).files;
const BUNDLED_OCR = ['eng', 'hin', 'ben', 'ita'];
let packProgress: (p: { received: number; total: number }) => void = () => {};

async function packInstalled(name: string): Promise<boolean> {
  try {
    const info = await Filesystem.stat({ path: `${PACKS}/${name}`, directory: Directory.Data });
    return info.size === PACK_FILES[name]?.size;
  } catch {
    return false;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function downloadPack(name: string, onProgress: (received: number) => void) {
  const entry = PACK_FILES[name];
  const partial = `${PACKS}/${name}.part`;
  let listener: { remove: () => void } | null = null;
  try {
    listener = await Filesystem.addListener('progress', (p) => onProgress(Math.min(p.bytes, entry.size)));
    await Filesystem.downloadFile({ url: entry.url, path: partial, directory: Directory.Data, recursive: true, progress: true });
  } catch {
    throw new Error(window.inkleafT('Couldn’t download the language pack. Check your internet connection and try again.'));
  } finally {
    listener?.remove();
  }
  const bytes = await readData(partial);
  if (bytes.length !== entry.size || (await sha256(bytes)) !== entry.sha256) {
    await Filesystem.deleteFile({ path: partial, directory: Directory.Data }).catch(() => {});
    throw new Error(window.inkleafT('The downloaded language pack didn’t match what Inkleaf expected, so it wasn’t kept. Please try again.'));
  }
  await Filesystem.rename({ from: partial, to: `${PACKS}/${name}`, directory: Directory.Data, toDirectory: Directory.Data });
  onProgress(entry.size);
}

/** The OCR languages that ship inside the app, copied next to the downloaded ones once. */
async function installBundledOcr() {
  for (const code of BUNDLED_OCR) {
    const target = `${PACKS}/ocr/${code}.traineddata.gz`;
    if (await exists(target)) continue;
    const response = await fetch(`./vendor/tesseract/lang/${code}.traineddata.gz`);
    if (response.ok) await writeData(target, new Uint8Array(await response.arrayBuffer()));
  }
}

// --- AI -----------------------------------------------------------------------------------------
// Settings live in local storage; keys go in the phone's secure key store
// (Android Keystore, iOS Keychain).

interface AiStored {
  provider: AiProviderId;
  models: Partial<Record<AiProviderId, string>>;
  urls: Partial<Record<AiProviderId, string>>;
  hasKey: Partial<Record<AiProviderId, boolean>>;
}

const aiStored = (): AiStored => ({ provider: 'builtin', models: {}, urls: {}, hasKey: {}, ...store.get<Partial<AiStored>>('ai', {}) });
const keyName = (id: AiProviderId) => `ai-key-${id}`;
const aiMock = () => platform === 'web' && store.get('ai-mock', false);

async function aiKey(id: AiProviderId): Promise<string> {
  try {
    return String((await SecureStorage.get(keyName(id))) ?? '');
  } catch {
    return '';
  }
}

const aiUrl = (provider: AiProvider, stored: AiStored) =>
  provider.id === 'local' || provider.id === 'custom' ? stored.urls[provider.id] ?? '' : store.get<string>('ai-test-base', '') || provider.baseUrl;
const aiModel = (provider: AiProvider, stored: AiStored) => stored.models[provider.id] ?? provider.models[0] ?? '';
const aiReady = (provider: AiProvider, stored: AiStored) =>
  (!provider.needsKey || !!stored.hasKey[provider.id]) && !!aiUrl(provider, stored) && !!aiModel(provider, stored);

// The built-in AI, in the web build's test mode: pretends to download, so
// its settings can be tried in a browser.
const mockListeners = new Set<(event: LocalAiEvent) => void>();
const mockLocal = (): LocalAiStatus => ({
  supported: true, installed: store.get<string[]>('ai-mock-installed', []), downloading: null, device: null, memory: 6e9,
  sizes: Object.fromEntries(LOCAL_MODELS.map((m) => [m.id, m.size])),
});
async function mockDownload(id: string) {
  const total = localModelById(id).size;
  for (const part of [0.3, 0.7, 1]) {
    await new Promise((r) => setTimeout(r, 150));
    mockListeners.forEach((l) => l({ type: 'progress', id, received: total * part, total }));
  }
  store.set('ai-mock-installed', [...new Set([...store.get<string[]>('ai-mock-installed', []), id])]);
  mockListeners.forEach((l) => l({ type: 'done', id }));
}
const localStatus = () => (aiMock() ? Promise.resolve(mockLocal()) : phoneAiStatus());

/** The native HTTP client, which isn't bound by a web page's cross-site rules. */
const nativeHttp: Http = async (url, request) => {
  try {
    const response = await CapacitorHttp.request({
      url,
      method: request.method ?? 'GET',
      headers: request.headers,
      data: request.body ? JSON.parse(request.body) : undefined,
      connectTimeout: request.seconds * 1000,
      readTimeout: request.seconds * 1000,
      responseType: 'json',
    });
    return { status: response.status, data: typeof response.data === 'string' ? safeJson(response.data) : response.data ?? null };
  } catch (err) {
    throw new NetworkError(/timed? ?out/i.test(String((err as Error)?.message ?? err)));
  }
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// --- theme ---------------------------------------------------------------------------------------

function applyTheme(theme: ThemeSetting) {
  const root = document.documentElement;
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// --- the API -----------------------------------------------------------------------------------

const menuHandlers: ((command: MenuCommand) => void)[] = [];
const openHandlers: ((file: OpenedFile) => void)[] = [];
let saveBeforeClose: (() => Promise<boolean>) | null = null;
let filesRoot = '';

/** Translations for messages made here, before or alongside the editor's own. */
declare global {
  interface Window {
    inkleaf: InkleafApi;
    inkleafT: (english: string, vars?: Record<string, string | number>) => string;
  }
}

function loadCatalog(): { locale: string; strings: Record<string, string> } {
  const choice = store.get<string>('language', 'system');
  const wanted = choice === 'system' ? systemLanguage() : choice;
  if (wanted === 'en' || !(UI_LANGUAGES as readonly string[]).includes(wanted)) return { locale: 'en', strings: {} };
  try {
    // synchronous on purpose: the editor reads the language as it starts
    const request = new XMLHttpRequest();
    request.open('GET', `./i18n/${wanted}.json`, false);
    request.send();
    const parsed = JSON.parse(request.responseText) as { strings?: Record<string, string> };
    return { locale: wanted, strings: parsed.strings ?? {} };
  } catch {
    return { locale: 'en', strings: {} };
  }
}

function systemLanguage(): string {
  for (const tag of navigator.languages ?? [navigator.language]) {
    const lower = tag.toLowerCase();
    if (lower.startsWith('zh')) return /hant|tw|hk|mo/.test(lower) ? 'zh-TW' : 'zh-CN';
    const base = lower.split('-')[0];
    if ((UI_LANGUAGES as readonly string[]).includes(base)) return base;
  }
  return 'en';
}

const unsupported: string[] = [
  // there's one window, no menu bar to quit from, and Android picks the app for PDFs itself
  'new-window', 'devtools', 'fullscreen', 'quit', 'default-app',
  // keyboard shortcuts don't mean much without a keyboard
  'shortcuts',
];
if (platform === 'web') unsupported.push('print', 'web-to-pdf');

const api: InkleafApi & {
  shareFile(data: Uint8Array, name: string): Promise<void>;
} = {
  mobile: true,
  engine,
  unsupported,
  packBase: './packs/', // replaced once the storage folder is known

  i18n: loadCatalog(),

  async info(): Promise<AppInfo> {
    const info = platform === 'web' ? { version: 'web' } : await App.getInfo();
    return {
      version: info.version,
      platform: platform as AppInfo['platform'],
      electron: '',
      packaged: platform !== 'web',
      userName: store.get('author-default', ''),
      needsAgreement: !store.get('agreed', false),
    };
  },
  async agreeToTerms() {
    store.set('agreed', true);
  },

  async packStatus() {
    const out: Record<string, { size: number; installed: boolean }> = {};
    await Promise.all(Object.entries(PACK_FILES).map(async ([name, entry]) => {
      out[name] = { size: entry.size, installed: await packInstalled(name) };
    }));
    return out;
  },
  async ensurePacks(names) {
    const missing: string[] = [];
    for (const name of names) if (PACK_FILES[name] && !(await packInstalled(name))) missing.push(name);
    const total = missing.reduce((n, name) => n + PACK_FILES[name].size, 0);
    let done = 0;
    for (const name of missing) {
      await downloadPack(name, (received) => packProgress({ received: done + received, total }));
      done += PACK_FILES[name].size;
    }
  },
  async removePacks(prefix) {
    for (const name of Object.keys(PACK_FILES)) {
      if (name.startsWith(prefix)) await Filesystem.deleteFile({ path: `${PACKS}/${name}`, directory: Directory.Data }).catch(() => {});
    }
  },
  onPackProgress(fn) {
    packProgress = fn;
  },

  async openDialog() {
    const [file] = await pick(['application/pdf', ...CONVERTIBLE_TYPES], false);
    return file ? intoLibrary(file.name, file.data) : null;
  },
  async openPath() {
    throw new Error('Not available on this device.');
  },
  pathForFile: () => '',
  pickPdfs: () => pick(['application/pdf'], true),

  async save(path, data) {
    if (!path.startsWith(`${LIBRARY}/`)) throw new Error('Inkleaf can only save into its own library here.');
    await writeData(path, data);
    remember(path, baseName(path));
  },
  async saveAs(data, suggestedName) {
    // new documents go into the library; "Save a copy" and Share put copies elsewhere
    const path = await libraryPath(suggestedName.replace(/(\.pdf)?$/i, '.pdf'));
    await writeData(path, data);
    remember(path, baseName(path));
    return path;
  },
  async saveMany(files) {
    if (platform === 'web') {
      for (const f of files) await api.saveCopy(f.data, f.name, 'pdf');
      return 'Downloads';
    }
    try {
      const { folder } = await Native.saveMany({ files: files.map((f) => ({ name: f.name, mime: mimeFor(f.name), data: toBase64(f.data) })) });
      return folder;
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
  },
  async saveCopy(data, suggestedName, _kind: CopyKind) {
    if (platform === 'web') {
      const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data as BlobPart])), download: suggestedName });
      link.click();
      return suggestedName;
    }
    try {
      const { uri } = await Native.saveAs({ name: suggestedName, mime: mimeFor(suggestedName), data: toBase64(data) });
      return uri;
    } catch (err) {
      if (cancelled(err)) return null;
      throw err;
    }
  },
  async shareFile(data, name) {
    const path = `share/${name.replace(/[\\/:*?"<>|]/g, '_')}`;
    await Filesystem.writeFile({ path, directory: Directory.Cache, data: toBase64(data), recursive: true });
    const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache });
    try {
      await Share.share({ title: name, files: [uri] });
    } catch (err) {
      if (!cancelled(err)) throw err;
    }
  },
  pickImages: () => pick(['image/*'], true),
  pickConvertible: () => pick(CONVERTIBLE_TYPES, true),

  async officeAvailable() {
    return false;
  },
  async officeToPdf() {
    throw new Error('LibreOffice isn’t available on this device.');
  },
  async htmlToPdf(html, page) {
    const { data } = await Native.htmlToPdf({ html, width: page?.width, height: page?.height, landscape: page?.landscape, margin: page?.margin });
    return fromBase64(data);
  },
  async urlToPdf(address) {
    const { data, title } = await Native.urlToPdf({ url: address });
    return { pdf: fromBase64(data), title };
  },

  async aiStatus(): Promise<AiStatus> {
    const stored = aiStored();
    const local = await localStatus();
    // the built-in AI is the default where it can run; otherwise a cloud service is
    if (stored.provider === 'builtin' && !local.supported) stored.provider = 'anthropic';
    const provider = providerById(stored.provider);
    const builtin = provider.id === 'builtin';
    const model = builtin ? localModelById(stored.models.builtin) : null;
    return {
      ready: aiMock() || (model ? local.installed.includes(model.id) : aiReady(provider, stored)),
      provider: provider.id,
      model: aiModel(provider, stored),
      url: aiUrl(provider, stored),
      hasKey: stored.hasKey,
      models: stored.models,
      urls: stored.urls,
      canEncrypt: true,
      // the built-in AI runs on the phone's processor, so it gets less at once
      budget: model ? model.phone.budget : provider.onDevice ? 24_000 : 120_000,
      local,
    };
  },
  async aiSave(config: AiConfig) {
    const { provider, key, model, url } = checkConfig(config);
    const stored = aiStored();
    if (provider.id === 'builtin' && !(await localStatus()).installed.includes(localModelById(model).id)) {
      throw new Error(window.inkleafT('Download the model first.'));
    }
    if (key) {
      await SecureStorage.set(keyName(provider.id), key);
      stored.hasKey[provider.id] = true;
    } else if (provider.needsKey && !stored.hasKey[provider.id]) {
      throw new Error(window.inkleafT('Paste your API key first.'));
    }
    stored.provider = provider.id;
    stored.models[provider.id] = model;
    if (provider.id === 'local' || provider.id === 'custom') stored.urls[provider.id] = url;
    store.set('ai', stored);
  },
  async aiModels(config) {
    const provider = providerById(config.provider);
    if (aiMock()) return [...provider.models, `${provider.id}-test-model`];
    const url = provider.id === 'local' || provider.id === 'custom' ? checkServerUrl(String(config.url ?? '')) : aiUrl(provider, aiStored());
    if (!url) throw new Error(window.inkleafT('Use an address starting with https://, or http:// for this computer and your local network.'));
    const key = String(config.key ?? '').trim() || (await aiKey(provider.id));
    return listModels(nativeHttp, provider, url, key);
  },
  async aiRemoveKey(id) {
    await SecureStorage.remove(keyName(id)).catch(() => {});
    const stored = aiStored();
    delete stored.hasKey[id];
    store.set('ai', stored);
  },
  async aiAsk(request, onChunk) {
    if (aiMock()) return mockAnswer(request);
    const stored = aiStored();
    if (stored.provider === 'builtin') return phoneAiAsk(localModelById(stored.models.builtin).id, request, onChunk, window.inkleafT);
    const provider = providerById(stored.provider);
    if (!aiReady(provider, stored)) throw new Error(window.inkleafT('Set up an AI service first (Tools › AI settings).'));
    return askAi(nativeHttp, { provider, url: aiUrl(provider, stored), key: await aiKey(provider.id), model: aiModel(provider, stored) }, request);
  },

  async aiStop() {
    await phoneAiStop();
  },
  async localAiDownload(id) {
    if (aiMock()) return void mockDownload(id);
    void phoneAiDownload(id, window.inkleafT);
  },
  async localAiCancelDownload() {
    await phoneAiCancel();
  },
  async localAiRemove(id) {
    if (aiMock()) return store.set('ai-mock-installed', store.get<string[]>('ai-mock-installed', []).filter((x) => x !== id));
    await phoneAiRemove(id);
  },
  onLocalAiEvent(listener) {
    mockListeners.add(listener);
    const off = onPhoneAiEvent(listener);
    return () => {
      mockListeners.delete(listener);
      off();
    };
  },

  async print() {
    // phones use printPdf below; this only runs if that's missing
    return { ok: false, reason: 'use-native' };
  },
  async printPdf(name, data) {
    await Native.print({ name, data: toBase64(data) });
  },
  // Documents live in Inkleaf's own library. Before one is first saved over
  // (by auto-save, say), a copy goes into backups, the newest 40 kept, so a
  // bad change can still be undone after the app closes.
  async backupOriginal(path) {
    if (!path.startsWith(`${LIBRARY}/`) || !(await exists(path))) return;
    const data = await readData(path);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    await writeData(`${BACKUPS}/${id}.pdf`, data);
    const list = [{ id, name: baseName(path), savedAt: Date.now(), size: data.length }, ...store.get<BackupEntry[]>('backups', [])];
    for (const old of list.splice(40)) await Filesystem.deleteFile({ path: `${BACKUPS}/${old.id}.pdf`, directory: Directory.Data }).catch(() => {});
    store.set('backups', list);
  },
  openBackups() {},
  async listBackups() {
    return store.get<BackupEntry[]>('backups', []);
  },
  async openBackup(id) {
    const entry = store.get<BackupEntry[]>('backups', []).find((b) => b.id === id);
    if (!entry) throw new Error(t('That backup is no longer there.'));
    const data = await readData(`${BACKUPS}/${entry.id}.pdf`);
    const date = new Date(entry.savedAt).toISOString().slice(0, 10);
    return intoLibrary(entry.name.replace(/\.pdf$/i, '') + ` (backup ${date}).pdf`, data);
  },

  async writeRecovery(id, name, path, data) {
    await writeData(`${RECOVERY}/${id}.pdf`, data);
    store.set('recovery', { ...store.get<Record<string, RecoveredFile>>('recovery', {}), [id]: { id, name, path, savedAt: Date.now() } });
  },
  clearRecovery(id) {
    const all = store.get<Record<string, RecoveredFile>>('recovery', {});
    delete all[id];
    store.set('recovery', all);
    Filesystem.deleteFile({ path: `${RECOVERY}/${id}.pdf`, directory: Directory.Data }).catch(() => {});
  },
  async recoveries() {
    // only offer what's left from before this launch
    return Object.values(store.get<Record<string, RecoveredFile>>('recovery', {})).filter((r) => r.savedAt < startedAt);
  },
  readRecovery: (id) => readData(`${RECOVERY}/${id}.pdf`),

  checkForUpdates() {
    void phoneUpdateCheck(true);
  },
  async defaultAppState() { return { state: 'unsupported' as const, dismissed: true }; },
  async makeDefaultApp() { return 'unsupported' as const; },
  dismissDefaultApp() {},
  // Share securely (see phone-share.ts)
  receiveCode: () => phoneReceiveCode(window.inkleafT),
  openLocked: (data) => phoneOpenLocked(data),
  sendPickup: (id, check, data) => phoneSendPickup(id, check, data, window.inkleafT),
  stopPickup() {
    // nothing is offered on the Wi-Fi from a phone, and the relay copy stays until it's picked up
  },
  onPickupEvent: (handler) => onPhonePickupEvent(handler),
  fetchPickup: (id, check, nearby) => phoneFetchPickup(id, check, nearby),
  forgetPickup: (id, token) => phoneForgetPickup(id, token),
  installUpdate() {},
  onUpdate(handler) {
    updateHandlers.push(handler);
  },
  showInFolder() {},

  openExternal(url) {
    if (/^https?:/i.test(url)) void Browser.open({ url });
    else window.open(url, '_system');
  },
  nativeEdit(command) {
    document.execCommand(command);
  },
  setDocumentState() {},

  async recentFiles() {
    // drop entries whose file has gone (deleted by the person or the system)
    const list = recents();
    const kept: RecentFile[] = [];
    for (const r of list) if (await exists(r.path)) kept.push(r);
    if (kept.length !== list.length) store.set('recent', kept);
    return kept;
  },
  async openRecent(path) {
    const data = await readData(path);
    remember(path, baseName(path));
    return { path, name: baseName(path), data };
  },
  setRecentThumb(path, thumb) {
    store.set('recent', recents().map((r) => (r.path === path ? { ...r, thumb } : r)));
  },
  async forgetRecent(path) {
    store.set('recent', recents().filter((r) => r.path !== path));
  },

  async languageChoice() {
    return store.get('language', 'system');
  },
  async setLanguage(choice) {
    store.set('language', choice);
    location.reload();
    return true;
  },
  async theme() {
    return store.get<ThemeSetting>('theme', 'system');
  },
  setTheme(theme) {
    store.set('theme', theme);
    applyTheme(theme);
  },
  windowCommand(command) {
    if (command === 'quit') void App.exitApp();
  },

  onMenu(handler) {
    menuHandlers.push(handler);
  },
  onOpenFile(handler) {
    openHandlers.push(handler);
  },
  onSaveBeforeClose(handler) {
    saveBeforeClose = handler;
  },

  ...createLink({ toBase64, fromBase64, intoLibrary, deliver: (file: OpenedFile) => openHandlers.forEach((h) => h(file)) }),
};

const startedAt = Date.now();

interface BackupEntry { id: string; name: string; savedAt: number; size: number }

const updateHandlers: ((state: UpdateState) => void)[] = [];
async function phoneUpdateCheck(manual: boolean) {
  if (platform === 'web') return;
  const [{ version }, fromStore] = await Promise.all([
    App.getInfo(),
    Native.installSource ? Native.installSource().then((r) => r.store).catch(() => false) : Promise.resolve(false),
  ]);
  await checkPhoneUpdates({ current: version, manual, store, fromStore, relayT: window.inkleafT, report: (s) => updateHandlers.forEach((h) => h(s)) });
}

// a plain translation helper for messages made in this file; the editor's own
// i18n module reads the same catalog once it loads
window.inkleafT = (english, vars = {}) => {
  let fingerprint = 0x811c9dc5;
  for (let i = 0; i < english.length; i++) fingerprint = Math.imul(fingerprint ^ english.charCodeAt(i), 0x01000193) >>> 0;
  const text = api.i18n.strings[fingerprint.toString(36).padStart(7, '0')] ?? english;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
};

window.inkleaf = api;
applyTheme(store.get<ThemeSetting>('theme', 'system'));

// --- files handed to Inkleaf by other apps ("Open with", "Share") ---------------------------------

async function takeIncoming() {
  if (platform === 'web') return;
  const { files } = await Native.takeIncoming().catch(() => ({ files: [] as { name: string; data: string }[] }));
  for (const f of files) {
    const opened = await intoLibrary(f.name, fromBase64(f.data));
    openHandlers.forEach((h) => h(opened));
  }
}

// --- start-up ------------------------------------------------------------------------------------

async function prepare() {
  if (platform !== 'web') {
    const { uri } = await Filesystem.getUri({ path: PACKS, directory: Directory.Data });
    filesRoot = uri;
    api.packBase = `${Capacitor.convertFileSrc(uri)}/`;
    await installBundledOcr().catch(() => {});

    // with native screens, the app handles the back button itself
    if (!engine) App.addListener('backButton', ({ canGoBack }) => {
      // close whatever is on top (a menu, a dialog), the way Esc does on a computer
      const top = document.querySelector('.modal-backdrop.show, .menu');
      if (top) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return;
      }
      // then an open drawer (the page list, properties)
      if (!window.dispatchEvent(new Event('inkleaf-back', { cancelable: true }))) return;
      if (canGoBack) history.back();
      else void App.minimizeApp();
    });
    // leaving the app is the phone's version of closing the window: save first
    App.addListener('pause', () => {
      void saveBeforeClose?.();
    });
    Native.addListener('incoming', () => void takeIncoming());
  }
}

const ready = prepare().catch((err) => console.error('Inkleaf couldn’t finish starting', err));
void filesRoot;
void menuHandlers;
void CONVERTIBLE;
void AI_PROVIDERS;
void Encoding;

ready.then(() => {
  // now the editor can start
  const script = document.createElement('script');
  script.type = 'module';
  script.src = './app.js';
  document.head.append(script);
  // files that arrived before the editor was listening
  setTimeout(() => void takeIncoming(), 1500);
  // once a day, quietly: is there a newer version?
  setTimeout(() => void phoneUpdateCheck(false), 15_000);
});
