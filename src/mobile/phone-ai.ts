// SPDX-License-Identifier: GPL-3.0-or-later
// The built-in AI on phones: the same Qwen models the computer app uses,
// run by llama.cpp inside the app (InkleafAiPlugin on Android). This side
// says which file to fetch and check, and turns questions into the model's
// chat format; the native side does the downloading and the thinking.

import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { LOCAL_MODELS, localModelById, type LocalAiEvent, type LocalAiStatus } from '../shared/local-models';

interface NativeStatus {
  supported: boolean;
  installed: string[];
  remaining: Record<string, number>;
  downloading: { file: string; received: number; total: number } | null;
  memory: number;
  free: number;
}

interface AiPlugin {
  status(options: { files: string[]; sizes: number[] }): Promise<NativeStatus>;
  download(options: { file: string; url: string; sha256: string; size: number }): Promise<void>;
  cancelDownload(): Promise<void>;
  remove(options: { file: string }): Promise<void>;
  generate(options: { file: string; prompt: string; context: number; maxTokens: number; streamId?: string }): Promise<{ text: string; tokens: number }>;
  stop(): Promise<void>;
  addListener(event: 'progress', handler: (e: { file: string; received: number; total: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'chunk', handler: (e: { streamId: string; text: string }) => void): Promise<PluginListenerHandle>;
}

const Native = registerPlugin<AiPlugin>('InkleafAi');
const byFile = (file: string) => LOCAL_MODELS.find((m) => m.file === file);

const UNSUPPORTED: LocalAiStatus = { supported: false, installed: [], sizes: {}, downloading: null, device: null };

export async function phoneAiStatus(): Promise<LocalAiStatus> {
  try {
    const s = await Native.status({ files: LOCAL_MODELS.map((m) => m.file), sizes: LOCAL_MODELS.map((m) => m.size) });
    const sizes: Record<string, number> = {};
    for (const m of LOCAL_MODELS) sizes[m.id] = s.remaining[m.file] ?? m.size;
    const busy = s.downloading && byFile(s.downloading.file);
    return {
      supported: s.supported,
      installed: s.installed.map((f) => byFile(f)?.id).filter((id): id is string => !!id),
      sizes,
      downloading: busy && s.downloading ? { id: busy.id, received: s.downloading.received, total: s.downloading.total } : null,
      device: null,
      memory: s.memory,
    };
  } catch {
    // no native side (the web build), or an older app
    return UNSUPPORTED;
  }
}

const listeners = new Set<(event: LocalAiEvent) => void>();
const report = (event: LocalAiEvent) => listeners.forEach((l) => l(event));

export function onPhoneAiEvent(handler: (event: LocalAiEvent) => void): () => void {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

let progress: Promise<PluginListenerHandle> | null = null;

/** Starts a download; how it goes arrives as events. */
export async function phoneAiDownload(id: string, relayT: (text: string) => string): Promise<void> {
  const model = localModelById(id);
  progress ??= Native.addListener('progress', (e) => {
    const m = byFile(e.file);
    if (m) report({ type: 'progress', id: m.id, received: e.received, total: e.total });
  });
  try {
    await Native.download({ file: model.file, url: model.url, sha256: model.sha256, size: model.size });
    report({ type: 'done', id: model.id });
  } catch (err) {
    const code = String((err as { code?: string; message?: string })?.code ?? (err as Error)?.message ?? '');
    const message =
      code === 'cancelled' ? ''
      : code === 'space' ? relayT('There isn’t enough free space on this phone for it.')
      : code === 'checksum' ? relayT('The download was damaged on the way. Try again.')
      : relayT('The download didn’t finish. Check the internet connection and try again; it carries on where it stopped.');
    report({ type: 'failed', id: model.id, message });
  }
}

export const phoneAiCancel = () => Native.cancelDownload().catch(() => {});
export const phoneAiRemove = (id: string) => Native.remove({ file: localModelById(id).file });
export const phoneAiStop = () => Native.stop().catch(() => {});

/** Qwen's chat format, with its thinking switched off: an empty think block, as its template does. */
function chat(system: string, prompt: string): string {
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
}

export async function phoneAiAsk(
  id: string,
  request: { system: string; prompt: string; maxTokens: number },
  onChunk: ((text: string) => void) | undefined,
  relayT: (text: string) => string,
): Promise<string> {
  const model = localModelById(id);
  const streamId = Math.random().toString(36).slice(2);
  let started = false;
  const chunks = onChunk
    ? await Native.addListener('chunk', (e) => {
      if (e.streamId !== streamId) return;
      let text = e.text;
      // the model opens with a blank line or two
      if (!started) text = text.replace(/^\s+/, '');
      if (!text) return;
      started = true;
      onChunk(text);
    })
    : null;
  try {
    const { text } = await Native.generate({
      file: model.file,
      prompt: chat(request.system, request.prompt),
      context: model.phone.context,
      maxTokens: Math.min(request.maxTokens, 2048),
      streamId,
    });
    return text.trim();
  } catch (err) {
    const code = String((err as { code?: string; message?: string })?.code ?? (err as Error)?.message ?? '');
    if (code === 'missing') throw new Error(relayT('Download the model first.'));
    if (code === 'too-long') throw new Error(relayT('That’s too much text for the built-in AI on a phone. Try a shorter part of the document.'));
    if (code === 'load') throw new Error(relayT('The model couldn’t start. The phone may be short of memory; close some apps, or pick Quick in AI settings.'));
    throw new Error(relayT('The built-in AI couldn’t answer this time. Try again.'));
  } finally {
    await chunks?.remove();
  }
}
