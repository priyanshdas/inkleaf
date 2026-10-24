// SPDX-License-Identifier: GPL-3.0-or-later
// Optional AI tools (summarise, translate), using the person's own Anthropic
// API key. Off until a key is added; the key is encrypted with the
// operating system's keychain (safeStorage) and only ever sent to Anthropic.
// Requests go from here, the main process, so the page itself still can't
// reach the internet.

import { LANGUAGES } from '../shared/languages';
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const MODELS = { fast: 'claude-haiku-5-5', best: 'claude-sonnet-5-5' } as const;
export type AiModel = keyof typeof MODELS;

const file = () => path.join(app.getPath('userData'), 'ai.json');

interface Stored {
  key: string; // base64 of the encrypted key
  model: AiModel;
}

function read(): Stored | null {
  try {
    return JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}

/** Lets the tests exercise the AI tools without a key or a network. */
const mock = () => !app.isPackaged && !!process.env.INKLEAF_AI_MOCK;

export function aiStatus(): { ready: boolean; model: AiModel; canEncrypt: boolean } {
  const stored = read();
  return { ready: mock() || !!stored?.key, model: stored?.model ?? 'fast', canEncrypt: safeStorage.isEncryptionAvailable() };
}

export function setKey(key: string, model: AiModel) {
  const trimmed = key.trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed)) throw new Error('That doesn’t look like an Anthropic API key. It starts with sk-ant-.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer can’t store the key securely, so it wasn’t saved.');
  const stored: Stored = { key: safeStorage.encryptString(trimmed).toString('base64'), model: model === 'best' ? 'best' : 'fast' };
  writeFileSync(file(), JSON.stringify(stored), { mode: 0o600 });
}

export function setModel(model: AiModel) {
  const stored = read();
  if (stored) writeFileSync(file(), JSON.stringify({ ...stored, model: model === 'best' ? 'best' : 'fast' }), { mode: 0o600 });
}

export function removeKey() {
  if (existsSync(file())) rmSync(file());
}

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** One question to Claude; resolves with the text of the answer. */
export async function ask(request: AiRequest): Promise<string> {
  if (mock()) return mockAnswer(request);
  const stored = read();
  if (!stored?.key) throw new Error('Add your Anthropic API key first (Tools › AI settings).');
  const key = safeStorage.decryptString(Buffer.from(stored.key, 'base64'));
  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODELS[stored.model] ?? MODELS.fast,
        max_tokens: Math.min(16000, Math.max(256, request.maxTokens | 0)),
        system: String(request.system),
        messages: [{ role: 'user', content: String(request.prompt) }],
      }),
    });
  } catch {
    throw new Error('Couldn’t reach Anthropic. Check your internet connection.');
  }
  const body = await response.json().catch(() => null) as { content?: { type: string; text?: string }[]; error?: { message?: string } } | null;
  if (!response.ok) {
    if (response.status === 401) throw new Error('Anthropic didn’t accept the API key. Check it in Tools › AI settings.');
    if (response.status === 429) throw new Error('Anthropic says you’re sending requests too quickly or your credit has run out. Try again in a moment.');
    throw new Error(body?.error?.message ?? `Anthropic returned an error (${response.status}).`);
  }
  return (body?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

function mockAnswer(request: AiRequest): string {
  const lines = request.prompt.match(/<lines>([\s\S]*)<\/lines>/);
  if (lines) {
    // "translation": each line, led by the language's own name, so the
    // tests can see both that it happened and that the script is drawn
    const list = JSON.parse(lines[1]) as string[];
    const target = LANGUAGES.find((l) => request.system?.includes(`into ${l.name}.`));
    return JSON.stringify(list.map((l) => `[${target?.native ?? 'T'}] ${l}`));
  }
  return 'Summary: this is a test summary of the document.\n\n- First key point\n- Second key point';
}
