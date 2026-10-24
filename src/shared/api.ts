// SPDX-License-Identifier: GPL-3.0-or-later
// The bridge between the sandboxed renderer and the main process.
// preload.ts implements it; the renderer sees it as `window.inkleaf`.

export interface OpenedFile {
  path: string | null;
  name: string;
  data: Uint8Array;
}

export interface PickedFile {
  name: string;
  data: Uint8Array;
}

export type MenuCommand =
  | 'new' | 'open' | 'save' | 'save-as' | 'close'
  | 'undo' | 'redo' | 'copy' | 'cut' | 'paste' | 'delete' | 'duplicate' | 'select-all-pages'
  | 'zoom-in' | 'zoom-out' | 'zoom-reset' | 'zoom-fit-width' | 'zoom-fit-page' | 'toggle-sidebar'
  | 'insert-pdf' | 'insert-blank' | 'extract' | 'split' | 'rotate-left' | 'rotate-right' | 'delete-pages'
  | 'shortcuts' | 'about' | 'next-tab' | 'prev-tab' | 'close-tab'
  | 'theme-system' | 'theme-light' | 'theme-dark' | 'toggle-inspector'
  | 'find' | 'print' | 'compress' | 'protect' | 'ocr' | 'compare' | 'decor' | 'remove-decor'
  | 'images-to-pdf' | 'pdf-to-images' | 'pdf-to-word' | 'crop' | 'uncrop-page' | 'uncrop-all' | 'form-builder'
  | 'mode-continuous' | 'mode-spread' | 'mode-single' | 'check-updates' | 'show-comments' | 'show-bookmarks'
  | 'toggle-autosave' | 'open-backups' | 'open-github' | 'report-problem' | 'donate'
  | 'convert-to-pdf' | 'convert-from-pdf' | 'web-to-pdf' | 'scan-to-pdf' | 'repair' | 'pdf-to-pdfa'
  | 'ai-summarize' | 'ai-translate' | 'ai-settings' | 'all-tools' | 'unlock' | 'terms' | 'privacy';

export type ThemeSetting = 'system' | 'light' | 'dark';

export interface RecentFile {
  path: string;
  name: string;
  openedAt: number;
  /** Small PNG of the first page, as a data URL. */
  thumb: string | null;
}

export interface AppInfo {
  version: string;
  platform: NodeJS.Platform;
  electron: string;
  /** False when running from source. */
  packaged: boolean;
  /** The computer's account name, the default author for comments. */
  userName: string;
  /** True when the person hasn't agreed to the current terms yet (builds with no installer page). */
  needsAgreement: boolean;
}

export type UpdateState =
  | { state: 'checking' }
  | { state: 'none' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }
  | { state: 'unavailable'; reason: string };

export type CopyKind = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'txt' | 'md' | 'html';

/** Files Inkleaf can turn into a PDF (besides PDFs themselves). */
export const CONVERTIBLE = ['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xls', 'ods', 'csv', 'pptx', 'ppt', 'odp', 'txt', 'md', 'markdown', 'html', 'htm', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];

export interface HtmlPage {
  width?: number;
  height?: number;
  landscape?: boolean;
  margin?: number;
}

/** Unsaved work kept safe in case the app closes unexpectedly. */
export interface RecoveredFile {
  id: string;
  name: string;
  /** Where the document lives on disk, if it had been saved before. */
  path: string | null;
  savedAt: number;
}

export interface InkleafApi {
  info(): Promise<AppInfo>;
  /** Records that the person agreed to the terms and privacy policy. */
  agreeToTerms(): Promise<void>;

  /** Which language pack files exist, and whether each is downloaded. */
  packStatus(): Promise<Record<string, { size: number; installed: boolean }>>;
  /** Downloads any of these pack files that aren't on disk yet. */
  ensurePacks(names: string[]): Promise<void>;
  /** Deletes downloaded packs whose names start with the prefix ('' for all). */
  removePacks(prefix: string): Promise<void>;
  onPackProgress(fn: (progress: { received: number; total: number }) => void): void;

  /** Shows the system Open dialog. Resolves to null if the user cancels. */
  openDialog(): Promise<OpenedFile | null>;
  /** Opens a file the user dropped onto the window. */
  openPath(path: string): Promise<OpenedFile>;
  /** Absolute path of a dropped File, or '' when it has none. */
  pathForFile(file: File): string;

  /** Picks PDFs to merge in. Their paths stay private to the main process. */
  pickPdfs(title?: string): Promise<PickedFile[]>;

  /** Overwrites a file this window opened or saved earlier. */
  save(path: string, data: Uint8Array): Promise<void>;
  /** Shows Save As; resolves to the chosen path, or null if cancelled. */
  saveAs(data: Uint8Array, suggestedName: string): Promise<string | null>;
  /** Asks for a folder and writes several files into it. Resolves to the folder or null. */
  saveMany(files: { name: string; data: Uint8Array }[]): Promise<string | null>;
  /** Save As for a derived file (compressed, protected, Word) that isn't the open document. */
  saveCopy(data: Uint8Array, suggestedName: string, kind: CopyKind): Promise<string | null>;
  /** Picks pictures to turn into a PDF. */
  pickImages(): Promise<PickedFile[]>;
  /** Picks documents, spreadsheets, slides, text or pictures to turn into PDFs. */
  pickConvertible(): Promise<PickedFile[]>;
  /** Whether LibreOffice is installed (for exact Word, Excel and PowerPoint conversion). */
  officeAvailable(): Promise<boolean>;
  /** Converts an office file to PDF with LibreOffice. */
  officeToPdf(name: string, data: Uint8Array): Promise<Uint8Array>;
  /** Prints self-contained HTML to a PDF. */
  htmlToPdf(html: string, page?: HtmlPage): Promise<Uint8Array>;
  /** Prints a web page (by address) to a PDF. */
  urlToPdf(address: string): Promise<{ pdf: Uint8Array; title: string }>;
  /** Optional AI tools, with the person's own Anthropic API key. */
  aiStatus(): Promise<{ ready: boolean; model: 'fast' | 'best'; canEncrypt: boolean }>;
  aiSetKey(key: string, model: 'fast' | 'best'): Promise<void>;
  aiSetModel(model: 'fast' | 'best'): Promise<void>;
  aiRemoveKey(): Promise<void>;
  aiAsk(request: { system: string; prompt: string; maxTokens: number }): Promise<string>;
  /** Shows the system print dialog for the current page contents. */
  print(): Promise<{ ok: boolean; reason?: string }>;
  /** Copies a file into the backups folder before it's first auto-saved over. */
  backupOriginal(path: string): Promise<void>;
  openBackups(): void;
  /** Keeps a copy of unsaved work; cleared once it's saved or closed. */
  writeRecovery(id: string, name: string, path: string | null, data: Uint8Array): Promise<void>;
  clearRecovery(id: string): void;
  /** Work left behind by a session that didn't close normally. */
  recoveries(): Promise<RecoveredFile[]>;
  readRecovery(id: string): Promise<Uint8Array>;
  /** Looks for a newer version now (also happens on its own at start-up). */
  checkForUpdates(): void;
  /** Restarts into a downloaded update. */
  installUpdate(): void;
  onUpdate(handler: (state: UpdateState) => void): void;
  showInFolder(path: string): void;

  /** Opens a web page in the user's browser. */
  openExternal(url: string): void;

  /** Runs a native edit command in the focused text field. */
  nativeEdit(command: 'undo' | 'redo' | 'copy' | 'cut' | 'paste'): void;

  /** Title and unsaved state for the window; dirtyCount covers every tab. */
  setDocumentState(state: { title: string; dirty: boolean; path: string | null; dirtyCount: number; dirtyName: string }): void;

  recentFiles(): Promise<RecentFile[]>;
  openRecent(path: string): Promise<OpenedFile>;
  setRecentThumb(path: string, thumb: string): void;
  forgetRecent(path: string): Promise<void>;

  theme(): Promise<ThemeSetting>;
  setTheme(theme: ThemeSetting): void;
  /** Window-level actions for the in-app menu on Windows and Linux. */
  windowCommand(command: 'new-window' | 'devtools' | 'fullscreen' | 'quit'): void;

  onMenu(handler: (command: MenuCommand) => void): void;
  onOpenFile(handler: (file: OpenedFile) => void): void;
  /** Main asks us to save before the window closes. Resolve true once saved. */
  onSaveBeforeClose(handler: () => Promise<boolean>): void;
}

declare global {
  interface Window {
    inkleaf: InkleafApi;
  }
}
