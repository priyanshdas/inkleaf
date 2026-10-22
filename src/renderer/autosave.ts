// SPDX-License-Identifier: GPL-3.0-or-later
// Auto-save and crash recovery.
//
// Auto-save writes a document back to its file a few seconds after you stop
// changing it, like a word processor. It only touches files that already
// live on disk; a new, never-saved document has nowhere to go yet. The first
// time a file is auto-saved over in a session, the original is copied to the
// Backups folder first.
//
// Crash recovery is separate and always on: about once a minute, any
// unsaved work (including untitled documents, and everything when auto-save
// is off) is copied somewhere safe. If Inkleaf doesn't close normally, it
// offers those copies back next time.

import type { EditorDoc } from './document';
import { newId } from './geometry';

const KEY = 'inkleaf.autosave';
/** Quiet time after the last change before auto-saving. */
const AUTOSAVE_DELAY = 2500;
/** How often unsaved work is copied for recovery. */
const RECOVERY_EVERY = 60_000;

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'off' | 'error' | 'new';

interface Tracked {
  timer: number;
  /** Recovery file id for this document. */
  recoveryId: string;
  /** The state last copied for recovery, to skip copies when nothing changed. */
  recovered: unknown;
  error: string | null;
}

export interface AutosaveHost {
  docs(): EditorDoc[];
  /** True while a gesture or text edit is in progress; saving waits for it. */
  busy(): boolean;
  /** Writes the document to its file and marks what was saved. */
  write(doc: EditorDoc): Promise<void>;
  /** Called whenever any document's save state may have changed. */
  changed(): void;
}

export class AutoSave {
  private tracked = new WeakMap<EditorDoc, Tracked>();
  private saving = new Set<EditorDoc>();
  enabled: boolean;

  constructor(private host: AutosaveHost) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      // storage unavailable: default on
    }
    this.enabled = saved !== 'off';
    window.setInterval(() => this.copyForRecovery(), RECOVERY_EVERY);
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch {
      // fine
    }
    if (on) for (const doc of this.host.docs()) this.schedule(doc);
    this.host.changed();
  }

  private info(doc: EditorDoc): Tracked {
    let t = this.tracked.get(doc);
    if (!t) {
      t = { timer: 0, recoveryId: newId('rec').replace(/[^A-Za-z0-9_-]/g, ''), recovered: null, error: null };
      this.tracked.set(doc, t);
    }
    return t;
  }

  /** Can this document be auto-saved to its file? */
  private eligible(doc: EditorDoc): boolean {
    // a protected original would be saved without its protection: that
    // should be a decision, not something that happens in the background
    return this.enabled && !!doc.path && !doc.wasProtected;
  }

  state(doc: EditorDoc): SaveState {
    const t = this.info(doc);
    if (this.saving.has(doc)) return 'saving';
    if (t.error && doc.dirty) return 'error';
    if (!doc.dirty) return 'saved';
    if (!doc.path) return 'new';
    return this.eligible(doc) ? 'saving' : this.enabled ? 'unsaved' : 'off';
  }

  error(doc: EditorDoc): string | null {
    return this.info(doc).error;
  }

  /** Called after every committed change (and undo/redo) to a document. */
  schedule(doc: EditorDoc) {
    const t = this.info(doc);
    clearTimeout(t.timer);
    if (!doc.dirty || !this.eligible(doc)) {
      this.host.changed();
      return;
    }
    t.timer = window.setTimeout(() => this.run(doc), AUTOSAVE_DELAY);
    this.host.changed();
  }

  private async run(doc: EditorDoc) {
    const t = this.info(doc);
    if (!doc.dirty || !this.eligible(doc) || !this.host.docs().includes(doc)) return;
    if (this.host.busy() || this.saving.has(doc)) {
      t.timer = window.setTimeout(() => this.run(doc), 800);
      return;
    }
    this.saving.add(doc);
    this.host.changed();
    try {
      await window.inkleaf.backupOriginal(doc.path!);
      await this.host.write(doc);
      t.error = null;
      this.forget(doc);
    } catch (err) {
      t.error = (err as Error)?.message ?? String(err);
    } finally {
      this.saving.delete(doc);
      this.host.changed();
    }
    // more edits arrived while saving: go round again
    if (doc.dirty && !t.error) this.schedule(doc);
  }

  /** Copies unsaved work somewhere safe, for after a crash. */
  async copyForRecovery() {
    const { exportPdf } = await import('./exporter');
    for (const doc of this.host.docs()) {
      const t = this.info(doc);
      if (!doc.dirty) continue;
      const version = doc.version();
      if (t.recovered === version.snapshot) continue;
      try {
        const { bytes } = await exportPdf(doc);
        await window.inkleaf.writeRecovery(t.recoveryId, doc.name, doc.path, bytes);
        t.recovered = version.snapshot;
      } catch (err) {
        console.warn('recovery copy failed', err);
      }
    }
  }

  /** The document was saved or closed: its recovery copy isn't needed. */
  forget(doc: EditorDoc) {
    const t = this.info(doc);
    clearTimeout(t.timer);
    t.recovered = null;
    window.inkleaf.clearRecovery(t.recoveryId);
  }

  /** Saves everything that can be auto-saved, now (before closing). */
  async flush(): Promise<void> {
    for (const doc of this.host.docs()) {
      if (doc.dirty && this.eligible(doc)) {
        clearTimeout(this.info(doc).timer);
        await this.run(doc);
      }
    }
  }
}
