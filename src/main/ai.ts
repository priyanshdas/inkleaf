// SPDX-License-Identifier: GPL-3.0-or-later
// Optional AI tools (summarise, translate). The person picks a provider:
// Claude, ChatGPT, Gemini, Grok, Perplexity, a model running on their own
// computer, or any OpenAI-compatible service. Off until they set one up.
//
// Keys are encrypted with the operating system's keychain (safeStorage), one
// per provider, and each key is only ever sent to its own provider. Requests
// go from here, the main process, so the page itself still can't reach the
// internet.

import { t } from '../shared/i18n';
import { LANGUAGES } from '../shared/languages';
import { AI_PROVIDERS, AiProvider, AiProviderId, checkServerUrl, providerById } from '../shared/ai-providers';
import type { AiConfig, AiStatus } from '../shared/api';
import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const file = () => path.join(app.getPath('userData'), 'ai.json');

interface Stored {
  provider: AiProviderId;
  /** base64 of each encrypted key, by provider */
  keys: Partial<Record<AiProviderId, string>>;
  /** the chosen model, by provider */
  models: Partial<Record<AiProviderId, string>>;
  /** server addresses for the local and custom providers */
  urls: Partial<Record<AiProviderId, string>>;
}

const empty = (): Stored => ({ provider: 'anthropic', keys: {}, models: {}, urls: {} });

function read(): Stored {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return empty();
  }
  // version 2.3 and earlier kept one Anthropic key and a fast/best choice
  if (typeof raw.key === 'string') {
    return { ...empty(), keys: { anthropic: raw.key }, models: { anthropic: raw.model === 'best' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5' } };
  }
  const stored = { ...empty(), ...raw } as Stored;
  if (!AI_PROVIDERS.some((p) => p.id === stored.provider)) stored.provider = 'anthropic';
  return stored;
}

const write = (stored: Stored) => writeFileSync(file(), JSON.stringify(stored), { mode: 0o600 });

/** Lets the tests exercise the AI tools without a key or a network. */
const mock = () => !app.isPackaged && !!process.env.INKLEAF_AI_MOCK;

/** In development the tests can point the cloud providers at a stand-in server. */
const cloudUrl = (provider: AiProvider) => (!app.isPackaged && process.env.INKLEAF_AI_TEST_BASE) || provider.baseUrl;
const urlFor = (provider: AiProvider, stored: Stored) => (provider.id === 'local' || provider.id === 'custom' ? stored.urls[provider.id] ?? provider.baseUrl : cloudUrl(provider));
const modelFor = (provider: AiProvider, stored: Stored) => stored.models[provider.id] ?? provider.models[0] ?? '';
const keyFor = (provider: AiProvider, stored: Stored) => {
  const sealed = stored.keys[provider.id];
  return sealed ? safeStorage.decryptString(Buffer.from(sealed, 'base64')) : '';
};

function isReady(provider: AiProvider, stored: Stored): boolean {
  if (provider.needsKey && !stored.keys[provider.id]) return false;
  return !!urlFor(provider, stored) && !!modelFor(provider, stored);
}

export function aiStatus(): AiStatus {
  const stored = read();
  const provider = providerById(stored.provider);
  return {
    ready: mock() || isReady(provider, stored),
    provider: provider.id,
    model: modelFor(provider, stored),
    url: urlFor(provider, stored),
    hasKey: Object.fromEntries(Object.keys(stored.keys).map((id) => [id, true])),
    models: stored.models,
    urls: stored.urls,
    canEncrypt: safeStorage.isEncryptionAvailable(),
  };
}

function checkConfig(config: AiConfig): { provider: AiProvider; key: string; model: string; url: string } {
  const provider = providerById(config.provider);
  const key = String(config.key ?? '').trim();
  if (key && provider.keyPrefix && !key.startsWith(provider.keyPrefix)) {
    throw new Error(t('That doesn’t look like a {name} key. It starts with {prefix}.', { name: provider.name, prefix: provider.keyPrefix }));
  }
  if (key && /\s/.test(key)) throw new Error(t('That key has spaces in it. Copy it again, without anything around it.'));
  let url = provider.baseUrl;
  if (provider.id === 'local' || provider.id === 'custom') {
    const checked = checkServerUrl(String(config.url ?? ''));
    if (!checked) throw new Error(t('Use an address starting with https://, or http:// for this computer and your local network.'));
    url = checked;
  }
  const model = String(config.model ?? '').trim();
  if (!model) throw new Error(t('Choose a model.'));
  return { provider, key, model, url };
}

export function saveConfig(config: AiConfig) {
  const { provider, key, model, url } = checkConfig(config);
  const stored = read();
  if (key) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('This computer can’t store the key securely, so it wasn’t saved.'));
    stored.keys[provider.id] = safeStorage.encryptString(key).toString('base64');
  } else if (provider.needsKey && !stored.keys[provider.id]) {
    throw new Error(t('Paste your API key first.'));
  }
  stored.provider = provider.id;
  stored.models[provider.id] = model;
  if (provider.id === 'local' || provider.id === 'custom') stored.urls[provider.id] = url;
  write(stored);
}

export function removeKey(id: AiProviderId) {
  const stored = read();
  delete stored.keys[providerById(id).id];
  if (Object.keys(stored.keys).length || Object.keys(stored.urls).length) write(stored);
  else if (existsSync(file())) rmSync(file());
}

// --- talking to the provider -----------------------------------------------------------

/** fetch with a timeout, turning network failures into a plain message */
async function call(provider: AiProvider, url: string, init: RequestInit, seconds: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error(t('{name} took too long to answer. Try again, or pick a faster model.', { name: provider.name }));
    if (provider.onDevice) throw new Error(t('Couldn’t reach the AI on this computer at {url}. Check that Ollama or LM Studio is running.', { url: url.replace(/\/(models|messages|agent|chat\/completions)$/, '') }));
    throw new Error(t('Couldn’t reach {name}. Check your internet connection.', { name: provider.company }));
  } finally {
    clearTimeout(timer);
  }
}

/** Turns an error response into something a person can act on. */
async function failure(provider: AiProvider, response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as { error?: { message?: string } | string; message?: string } | null;
  const detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message;
  const name = provider.onDevice ? t('The AI on this computer') : provider.company;
  if (response.status === 401 || response.status === 403) return new Error(t('{name} didn’t accept the API key. Check it in Tools › AI settings.', { name }));
  if (response.status === 404 && provider.protocol !== 'anthropic') return new Error(t('{name} doesn’t know that model. Pick another in Tools › AI settings.', { name }));
  if (response.status === 429) return new Error(t('{name} says you’re sending requests too quickly or your credit has run out. Try again in a moment.', { name }));
  return new Error(detail ?? t('{name} returned an error ({status}).', { name, status: response.status }));
}

const authHeaders = (provider: AiProvider, key: string): Record<string, string> =>
  provider.protocol === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : key ? { authorization: `Bearer ${key}` } : {};

/**
 * The models a provider offers right now, for the settings screen. Uses the
 * key being typed if there is one, otherwise the saved key.
 */
export async function listModels(config: Partial<AiConfig>): Promise<string[]> {
  const provider = providerById(config.provider);
  if (mock() && process.env.INKLEAF_AI_MOCK !== 'real') return [...provider.models, `${provider.id}-test-model`];
  if (provider.protocol === 'perplexity') return provider.models;
  const stored = read();
  const url = provider.id === 'local' || provider.id === 'custom' ? checkServerUrl(String(config.url ?? '')) : cloudUrl(provider);
  if (!url) throw new Error(t('Use an address starting with https://, or http:// for this computer and your local network.'));
  const key = String(config.key ?? '').trim() || keyFor(provider, stored);
  if (provider.needsKey && !key) throw new Error(t('Paste your API key first.'));
  const response = await call(provider, `${url}/models`, { headers: authHeaders(provider, key) }, 20);
  if (!response.ok) throw await failure(provider, response);
  const body = await response.json().catch(() => null) as { data?: { id?: string; name?: string }[]; models?: { name?: string }[] } | null;
  const ids = (body?.data ?? body?.models ?? []).map((m) => String((m as { id?: string }).id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  // chat models only: skip embeddings, speech, images and the like
  const chat = ids.filter((id) => !/embed|whisper|tts|dall-e|image|moderation|audio|transcribe|realtime|search-preview|rerank/i.test(id));
  return [...new Set(chat)].sort();
}

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** One question to the chosen AI; resolves with the text of the answer. */
export async function ask(request: AiRequest): Promise<string> {
  if (mock() && process.env.INKLEAF_AI_MOCK !== 'real') return mockAnswer(request);
  const stored = read();
  const provider = providerById(stored.provider);
  if (!isReady(provider, stored)) throw new Error(t('Set up an AI service first (Tools › AI settings).'));
  const key = keyFor(provider, stored);
  const url = urlFor(provider, stored);
  const model = modelFor(provider, stored);
  const system = String(request.system);
  const prompt = String(request.prompt);
  const maxTokens = Math.min(16000, Math.max(256, request.maxTokens | 0));
  // local models on modest hardware can be slow
  const seconds = provider.onDevice ? 600 : 180;
  const headers = { 'content-type': 'application/json', ...authHeaders(provider, key) };

  if (provider.protocol === 'anthropic') {
    const response = await call(provider, `${url}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    }, seconds);
    if (!response.ok) throw await failure(provider, response);
    const body = await response.json() as { content?: { type: string; text?: string }[] };
    return (body.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }

  if (provider.protocol === 'perplexity') {
    // the Agent API: an effort preset, no web search, so it answers from the document alone
    const response = await call(provider, `${url}/agent`, {
      method: 'POST', headers,
      body: JSON.stringify({ effort: model, instructions: system, input: prompt, max_output_tokens: maxTokens }),
    }, seconds);
    if (!response.ok) throw await failure(provider, response);
    const body = await response.json() as { output_text?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] };
    if (body.output_text) return body.output_text;
    return (body.output ?? []).filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  }

  // OpenAI and everything that speaks its chat completions API
  const tokens = provider.id === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const response = await call(provider, `${url}/chat/completions`, {
    method: 'POST', headers,
    body: JSON.stringify({ model, ...tokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  }, seconds);
  if (!response.ok) throw await failure(provider, response);
  const body = await response.json() as { choices?: { message?: { content?: string | { type: string; text?: string }[] } }[] };
  const content = body.choices?.[0]?.message?.content ?? '';
  const text = typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  // some local reasoning models think out loud first
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
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
