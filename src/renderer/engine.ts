// SPDX-License-Identifier: GPL-3.0-or-later
// Engine mode: the editor without its own buttons, driven by the native phone app.
//
// The Android app draws every screen itself (Kotlin + Compose) and keeps this
// page running underneath just to show and edit the PDF. It sends commands
// through window.inkleafEngine.call(), and hears back through the
// InkleafEngine plugin: one reply per command, plus a "state" message whenever
// something it shows changes (the page number, undo, the chosen tool…).

import type { RecentFile } from '../shared/api';
import type { EditorDoc } from './document';
import type { Editor } from './editor';
import { decorTexts } from './decor';
import { AnnotationMode, pageViewport } from './pdf';
import { drawAnnots, type Transform } from './render';
import type { ToolStyles } from './styles';
import type { Tool } from './types';
import type { Viewer } from './viewer';

interface EnginePlugin {
  state(options: { state: EngineState }): Promise<void>;
  event(options: { type: string; text?: string; kind?: string }): Promise<void>;
  reply(options: { id: number; ok: boolean; result?: unknown; error?: string }): Promise<void>;
}
// registered by the phone side (src/mobile/bridge.ts), which owns the Capacitor runtime
const Native = {
  get plugin() {
    return (window as unknown as { inkleafNative: EnginePlugin }).inkleafNative;
  },
  state: (o: { state: EngineState }) => Native.plugin.state(o),
  event: (o: { type: string; text?: string; kind?: string }) => Native.plugin.event(o),
  reply: (o: { id: number; ok: boolean; result?: unknown; error?: string }) => Native.plugin.reply(o),
};

/** What the app needs from the editor to drive it. */
export interface EngineHost {
  docs(): { id: string; doc: EditorDoc }[];
  active(): { id: string; doc: EditorDoc } | null;
  activate(id: string): void;
  close(id: string, discard: boolean): Promise<boolean>;
  openPath(path: string): Promise<void>;
  run(command: string): Promise<unknown>;
  startSign(): Promise<void>;
  hubTool(command: string): Promise<unknown>;
  startImage(): Promise<void>;
  save(): Promise<boolean>;
  autosave: { enabled: boolean; state(doc: EditorDoc): string };
  editor: Editor;
  viewer: Viewer;
}

export interface EngineState {
  docs: { id: string; name: string; path: string | null; dirty: boolean; pages: number; saveState: string }[];
  active: string | null;
  page: number;
  pages: number;
  zoom: number;
  tool: Tool;
  styles: ToolStyles;
  canUndo: boolean;
  canRedo: boolean;
  /** what's selected on the page, if anything: its kind ("ink", "text"…) */
  selection: string | null;
  editingText: boolean;
  /** a dialog or menu of the editor's own is open: the app shows the page full screen until it closes */
  overlay: boolean;
  busy: string | null;
  autosave: boolean;
}

let host: EngineHost;
let busyText: string | null = null;

function snapshot(): EngineState {
  const active = host.active();
  const doc = active?.doc ?? null;
  const viewer = host.viewer;
  const editor = host.editor;
  const page = doc && viewer.currentPageId ? doc.pageIndex(viewer.currentPageId) + 1 : 0;
  return {
    docs: host.docs().map(({ id, doc: d }) => ({
      id, name: d.name, path: d.path, dirty: d.dirty, pages: d.pages.length, saveState: host.autosave.state(d),
    })),
    active: active?.id ?? null,
    page,
    pages: doc?.pages.length ?? 0,
    zoom: viewer.scale,
    tool: editor.tool,
    styles: editor.styles,
    canUndo: !!doc?.canUndo,
    canRedo: !!doc?.canRedo,
    selection: editor.selectedAnnot()?.type ?? null,
    editingText: editor.text.active,
    overlay: !!document.querySelector('#modal-root .modal-backdrop, #menus .menu'),
    busy: busyText,
    autosave: host.autosave.enabled,
  };
}

let queued = 0;
let last = '';
/** Tells the app something changed. Coalesced to one message per frame, and only when it differs. */
export function notify() {
  if (!host || queued) return;
  queued = requestAnimationFrame(() => {
    queued = 0;
    const state = snapshot();
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    void Native.state({ state }).catch(() => {});
  });
}

/** Long work in progress (or done, with null). */
export function setBusy(text: string | null) {
  busyText = text;
  notify();
}

/** Messages the editor would show as a toast become the app's own. */
export function sendToast(text: string, kind: string) {
  void Native.event({ type: 'toast', text, kind }).catch(() => {});
}

/** A small picture of one page, with everything drawn on it, as a data URL. */
async function pageImage(index: number, width: number): Promise<string> {
  const doc = host.active()?.doc;
  const ref = doc?.pages[index];
  if (!doc || !ref) throw new Error('No such page');
  const page = await doc.sources.get(ref.src)!.pdf.getPage(ref.index + 1);
  const rotation = doc.displayRotation(ref);
  const viewport = pageViewport(page, width / doc.displaySize(ref).width, rotation, ref.crop);
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
  drawAnnots(ctx, viewport.transform as Transform, [...decorTexts(doc, ref), ...doc.annots(ref.id)], doc.images);
  const url = canvas.toDataURL('image/jpeg', 0.8);
  canvas.width = canvas.height = 0;
  return url;
}

type Args = Record<string, unknown>;

const commands: Record<string, (args: Args) => unknown> = {
  state: () => snapshot(),
  open: () => host.run('open'),
  new: () => host.run('new'),
  openPath: (a) => host.openPath(String(a.path)),
  activate: (a) => host.activate(String(a.id)),
  close: (a) => host.close(String(a.id), a.discard === true),
  save: () => host.save(),
  tool: (a) => {
    // signatures and pictures are chosen first, then placed with a tap
    if (a.tool === 'sign') return host.startSign();
    if (a.tool === 'image') return host.startImage();
    return host.editor.setTool(a.tool as Tool);
  },
  style: (a) => host.editor.applyStyle(a.group as keyof ToolStyles, a.patch as never),
  undo: () => host.run('undo'),
  redo: () => host.run('redo'),
  deleteSelection: () => host.run('delete'),
  duplicate: () => host.run('duplicate'),
  editText: () => host.editor.editSelectedText(),
  deselect: () => {
    if (host.editor.text.active) host.editor.text.finish();
    host.editor.select(null);
  },
  run: (a) => host.run(String(a.command)),
  /** A tool from the Tools tab (the same list as the desktop's All tools). */
  hubTool: async (a) => {
    if (a.needsDoc && !host.active()) {
      await host.run('open');
      if (!host.active()) return;
    }
    return host.hubTool(String(a.command));
  },
  goToPage: (a) => {
    const doc = host.active()?.doc;
    const ref = doc?.pages[Number(a.page) - 1];
    if (ref) host.viewer.scrollToPage(ref.id);
  },
  fit: (a) => (a.mode === 'page' ? host.viewer.fitPage() : host.viewer.fitWidth()),
  pageImage: (a) => pageImage(Number(a.index), Number(a.width) || 240),
  /** Where the app leaves room for the page, in CSS pixels from the top and bottom of this view. */
  area: (a) => {
    const root = document.documentElement.style;
    const top = Math.max(0, Number(a.top) || 0), bottom = Math.max(0, Number(a.bottom) || 0);
    if (root.getPropertyValue('--engine-top') === `${top}px` && root.getPropertyValue('--engine-bottom') === `${bottom}px`) return;
    root.setProperty('--engine-top', `${top}px`);
    root.setProperty('--engine-bottom', `${bottom}px`);
    // keep the same spot of the page in view while the space grows or shrinks
    requestAnimationFrame(() => host.viewer.layout());
  },
  /** The translations the app's own screens use, the same ones as the editor's. */
  catalog: () => window.inkleaf.i18n,
  recents: async (): Promise<RecentFile[]> => window.inkleaf.recentFiles(),
  forgetRecent: (a) => window.inkleaf.forgetRecent(String(a.path)),
  agree: () => window.inkleaf.agreeToTerms(),
  info: () => window.inkleaf.info(),
  linkStatus: () => window.inkleaf.linkStatus(),
  linkForget: (a) => window.inkleaf.linkForget(String(a.id)),
  setTheme: (a) => window.inkleaf.setTheme(a.theme as 'system' | 'light' | 'dark'),
  theme: () => window.inkleaf.theme(),
  languageChoice: () => window.inkleaf.languageChoice(),
  setLanguage: (a) => window.inkleaf.setLanguage(String(a.choice)),
  /** Closes whatever dialog of the editor's own is open, as the back button would. */
  back: () => {
    const open = document.querySelector('#modal-root .modal-backdrop, #menus .menu');
    if (open) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return !!open;
  },
};

export function startEngine(h: EngineHost) {
  host = h;
  document.documentElement.classList.add('engine');
  (window as unknown as { inkleafEngine: unknown }).inkleafEngine = {
    async call(message: { id: number; cmd: string; args?: Args }) {
      const run = commands[message.cmd];
      try {
        if (!run) throw new Error(`Unknown command: ${message.cmd}`);
        const result = await run(message.args ?? {});
        await Native.reply({ id: message.id, ok: true, result: result ?? null });
      } catch (err) {
        await Native.reply({ id: message.id, ok: false, error: String((err as Error)?.message ?? err) });
      }
      notify();
    },
  };

  const { editor, viewer } = h;
  for (const name of ['toolchange', 'selectionchange', 'stylechange']) editor.addEventListener(name, notify);
  for (const name of ['pagechange', 'zoom', 'modechange']) viewer.addEventListener(name, notify);
  // the editor's own dialogs and menus come and go here
  const watch = new MutationObserver(notify);
  for (const id of ['modal-root', 'menus']) watch.observe(document.getElementById(id)!, { childList: true, subtree: true });

  void Native.event({ type: 'ready' }).catch(() => {});
  notify();
}
