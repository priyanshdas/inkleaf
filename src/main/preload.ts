// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { InkleafApi, MenuCommand, OpenedFile, PickupEvent } from '../shared/api';

const api: InkleafApi = {
  info: () => ipcRenderer.invoke('app:info'),
  agreeToTerms: () => ipcRenderer.invoke('app:agree-terms'),
  packStatus: () => ipcRenderer.invoke('packs:status'),
  ensurePacks: (names: string[]) => ipcRenderer.invoke('packs:ensure', names),
  removePacks: (prefix: string) => ipcRenderer.invoke('packs:remove', prefix),
  onPackProgress: (fn: (p: { received: number; total: number }) => void) => {
    ipcRenderer.on('packs:progress', (_e, p) => fn(p));
  },
  openDialog: () => ipcRenderer.invoke('file:open-dialog'),
  openPath: (path) => ipcRenderer.invoke('file:open-path', path),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  pickPdfs: (title?: string) => ipcRenderer.invoke('file:pick-pdfs', title),
  save: (path, data) => ipcRenderer.invoke('file:save', path, data),
  saveAs: (data, suggestedName) => ipcRenderer.invoke('file:save-as', data, suggestedName),
  saveMany: (files) => ipcRenderer.invoke('file:save-many', files),
  saveCopy: (data, suggestedName, kind) => ipcRenderer.invoke('file:save-copy', data, suggestedName, kind),
  pickImages: () => ipcRenderer.invoke('file:pick-images'),
  pickConvertible: () => ipcRenderer.invoke('file:pick-convertible'),
  officeAvailable: () => ipcRenderer.invoke('convert:office-available'),
  officeToPdf: (name, data) => ipcRenderer.invoke('convert:office', name, data),
  htmlToPdf: (html, page) => ipcRenderer.invoke('convert:html', html, page),
  urlToPdf: (address) => ipcRenderer.invoke('convert:url', address),
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiSave: (config) => ipcRenderer.invoke('ai:save', config),
  aiModels: (config) => ipcRenderer.invoke('ai:models', config),
  aiRemoveKey: (provider) => ipcRenderer.invoke('ai:remove-key', provider),
  aiAsk: (request) => ipcRenderer.invoke('ai:ask', request),
  print: () => ipcRenderer.invoke('window:print'),
  backupOriginal: (path) => ipcRenderer.invoke('backup:original', path),
  openBackups: () => ipcRenderer.send('backup:open'),
  writeRecovery: (id, name, path, data) => ipcRenderer.invoke('recovery:write', id, name, path, data),
  clearRecovery: (id) => ipcRenderer.send('recovery:clear', id),
  recoveries: () => ipcRenderer.invoke('recovery:list'),
  readRecovery: (id) => ipcRenderer.invoke('recovery:read', id),
  checkForUpdates: () => ipcRenderer.send('update:check'),
  defaultAppState: () => ipcRenderer.invoke('default-app:state'),
  makeDefaultApp: () => ipcRenderer.invoke('default-app:make'),
  dismissDefaultApp: () => ipcRenderer.send('default-app:dismiss'),
  receiveCode: () => ipcRenderer.invoke('lock:receive-code'),
  openLocked: (data: Uint8Array) => ipcRenderer.invoke('lock:open', data),
  sendPickup: (id: string, check: string, data: Uint8Array) => ipcRenderer.invoke('pickup:send', id, check, data),
  stopPickup: (id: string) => ipcRenderer.send('pickup:stop', id),
  onPickupEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, e: PickupEvent) => handler(e);
    ipcRenderer.on('pickup:event', listener);
    return () => ipcRenderer.removeListener('pickup:event', listener);
  },
  fetchPickup: (id: string, check: string, nearby: string[]) => ipcRenderer.invoke('pickup:fetch', id, check, nearby),
  forgetPickup: (id: string, token: string) => ipcRenderer.invoke('pickup:forget', id, token),
  installUpdate: () => ipcRenderer.send('update:install'),
  onUpdate: (handler) => {
    ipcRenderer.on('update', (_event, state) => handler(state));
  },
  showInFolder: (path) => ipcRenderer.send('file:show-in-folder', path),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),
  nativeEdit: (command) => ipcRenderer.send('edit:native', command),
  setDocumentState: (state) => ipcRenderer.send('window:document-state', state),
  recentFiles: () => ipcRenderer.invoke('recent:list'),
  openRecent: (path) => ipcRenderer.invoke('recent:open', path),
  setRecentThumb: (path, thumb) => ipcRenderer.send('recent:thumb', path, thumb),
  forgetRecent: (path) => ipcRenderer.invoke('recent:forget', path),
  i18n: (() => {
    try {
      return ipcRenderer.sendSync('i18n:catalog');
    } catch {
      return { locale: 'en', strings: {} };
    }
  })(),
  languageChoice: () => ipcRenderer.invoke('i18n:choice'),
  setLanguage: (choice) => ipcRenderer.invoke('i18n:set', choice),
  theme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.send('theme:set', theme),
  windowCommand: (command) => ipcRenderer.send('window:command', command),

  onMenu: (handler) => {
    ipcRenderer.on('menu', (_event, command: MenuCommand) => handler(command));
  },
  // the system share sheet is a phone thing
  unsupported: ['share'],
  linkStatus: () => ipcRenderer.invoke('link:status'),
  linkPair: () => ipcRenderer.invoke('link:pair'),
  linkJoin: async () => {
    throw new Error('Only the phone app scans a pairing code.');
  },
  linkSend: (id, name, data) => ipcRenderer.invoke('link:send', id, name, data),
  linkForget: (id) => ipcRenderer.invoke('link:forget', id),
  onLinkEvent: (handler) => {
    ipcRenderer.on('link:event', (_event, e) => handler(e));
  },
  onOpenFile: (handler) => {
    ipcRenderer.on('open-file', (_event, file: OpenedFile) => handler(file));
    // Main holds on to files from the command line or Finder until the page
    // is listening, so tell it we're ready for them now.
    ipcRenderer.send('window:ready');
  },
  onSaveBeforeClose: (handler) => {
    ipcRenderer.on('save-before-close', async () => {
      let saved = false;
      try {
        saved = await handler();
      } finally {
        ipcRenderer.send('window:save-before-close-done', saved);
      }
    });
  },
};

contextBridge.exposeInMainWorld('inkleaf', api);
