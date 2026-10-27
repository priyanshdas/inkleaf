// SPDX-License-Identifier: GPL-3.0-or-later
// Talking to the AI services, shared by the desktop app (main process) and the
// phone apps (their bridge). Only the networking differs, so it's passed in:
// Node's fetch on the desktop, the native HTTP client on phones (a web page
// can't call these services directly because of browser security rules).

import { t } from './i18n';
import { isMobile } from './platform';
import { LANGUAGES } from './languages';
import { AiProvider, checkServerUrl, providerById } from './ai-providers';
import type { AiConfig } from './api';

export interface HttpRequest {
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON text */
  body?: string;
  /** give up after this long */
  seconds: number;
}

export interface HttpResponse {
  status: number;
  /** the parsed JSON body, or null if there wasn't one */
  data: unknown;
}

/** Thrown by an Http function when the server never answered. */
export class NetworkError extends Error {
  constructor(public readonly timedOut: boolean) {
    super(timedOut ? 'timed out' : 'unreachable');
  }
}

export type Http = (url: string, request: HttpRequest) => Promise<HttpResponse>;

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens: number;
}

/** Where to send a request, and as whom. */
export interface AiTarget {
  provider: AiProvider;
  url: string;
  key: string;
  model: string;
}

/** Checks what the settings screen sent before anything is saved. */
export function checkConfig(config: AiConfig): { provider: AiProvider; key: string; model: string; url: string } {
  const provider = providerById(config.provider);
  const key = String(config.key ?? '').trim();
  if (key && provider.keyPrefix && !key.startsWith(provider.keyPrefix)) {
    throw new Error(t('That doesn’t look like a {name} key. It starts with {prefix}.', { name: provider.name, prefix: provider.keyPrefix }));
  }
  if (key && /\s/.test(key)) throw new Error(t('That key has spaces in it. Copy it again, without anything around it.'));
  let url = provider.baseUrl;
  if (provider.id === 'local' || provider.id === 'custom') {
    const checked = checkServerUrl(String(config.url ?? ''));
    if (!checked) throw new Error(isMobile() ? t('Use an address starting with https://, or http:// for a computer on your local network.') : t('Use an address starting with https://, or http:// for this computer and your local network.'));
    url = checked;
  }
  const model = String(config.model ?? '').trim();
  if (!model) throw new Error(t('Choose a model.'));
  return { provider, key, model, url };
}

const authHeaders = (provider: AiProvider, key: string): Record<string, string> =>
  provider.protocol === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : key ? { authorization: `Bearer ${key}` } : {};

/** Makes the request, turning "no answer" into a message a person can act on. */
async function call(http: Http, provider: AiProvider, url: string, request: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(url, request);
  } catch (err) {
    if (err instanceof NetworkError && err.timedOut) throw new Error(t('{name} took too long to answer. Try again, or pick a faster model.', { name: provider.name }));
    const where = url.replace(/\/(models|messages|agent|chat\/completions)$/, '');
    if (provider.onDevice && isMobile()) throw new Error(t('Couldn’t reach the AI on your computer at {url}. Check that Ollama or LM Studio is running, accepts connections from your network, and that both are on the same Wi-Fi.', { url: where }));
    if (provider.onDevice) throw new Error(t('Couldn’t reach the AI on this computer at {url}. Check that Ollama or LM Studio is running.', { url: where }));
    throw new Error(t('Couldn’t reach {name}. Check your internet connection.', { name: provider.company }));
  }
}

/** Turns an error response into something a person can act on. */
function failure(provider: AiProvider, response: HttpResponse): Error {
  const body = response.data as { error?: { message?: string } | string; message?: string } | null;
  const detail = typeof body?.error === 'string' ? body.error : body?.error?.message ?? body?.message;
  const name = provider.onDevice ? (isMobile() ? t('The AI on your computer') : t('The AI on this computer')) : provider.company;
  if (response.status === 401 || response.status === 403) return new Error(t('{name} didn’t accept the API key. Check it in Tools › AI settings.', { name }));
  if (response.status === 404 && provider.protocol !== 'anthropic') return new Error(t('{name} doesn’t know that model. Pick another in Tools › AI settings.', { name }));
  if (response.status === 429) return new Error(t('{name} says you’re sending requests too quickly or your credit has run out. Try again in a moment.', { name }));
  return new Error(detail ?? t('{name} returned an error ({status}).', { name, status: response.status }));
}

const ok = (response: HttpResponse) => response.status >= 200 && response.status < 300;

/** The chat models a provider offers right now. */
export async function listModels(http: Http, provider: AiProvider, url: string, key: string): Promise<string[]> {
  if (provider.protocol === 'perplexity') return provider.models;
  if (provider.needsKey && !key) throw new Error(t('Paste your API key first.'));
  const response = await call(http, provider, `${url}/models`, { headers: authHeaders(provider, key), seconds: 20 });
  if (!ok(response)) throw failure(provider, response);
  const body = response.data as { data?: { id?: string; name?: string }[]; models?: { name?: string }[] } | null;
  const ids = (body?.data ?? body?.models ?? []).map((m) => String((m as { id?: string }).id ?? m.name ?? '').replace(/^models\//, '')).filter(Boolean);
  // chat models only: skip embeddings, speech, images and the like
  const chat = ids.filter((id) => !/embed|whisper|tts|dall-e|image|moderation|audio|transcribe|realtime|search-preview|rerank/i.test(id));
  return [...new Set(chat)].sort();
}

/** One question to the chosen AI; resolves with the text of the answer. */
export async function askAi(http: Http, target: AiTarget, request: AiRequest): Promise<string> {
  const { provider, url, key, model } = target;
  const system = String(request.system);
  const prompt = String(request.prompt);
  const maxTokens = Math.min(16000, Math.max(256, request.maxTokens | 0));
  // local models on modest hardware can be slow
  const seconds = provider.onDevice ? 600 : 180;
  const headers = { 'content-type': 'application/json', ...authHeaders(provider, key) };

  if (provider.protocol === 'anthropic') {
    const response = await call(http, provider, `${url}/messages`, {
      method: 'POST', headers, seconds,
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!ok(response)) throw failure(provider, response);
    const body = response.data as { content?: { type: string; text?: string }[] } | null;
    return (body?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }

  if (provider.protocol === 'perplexity') {
    // the Agent API: an effort preset, no web search, so it answers from the document alone
    const response = await call(http, provider, `${url}/agent`, {
      method: 'POST', headers, seconds,
      body: JSON.stringify({ effort: model, instructions: system, input: prompt, max_output_tokens: maxTokens }),
    });
    if (!ok(response)) throw failure(provider, response);
    const body = response.data as { output_text?: string; output?: { type: string; content?: { type: string; text?: string }[] }[] } | null;
    if (body?.output_text) return body.output_text;
    return (body?.output ?? []).filter((o) => o.type === 'message')
      .flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('');
  }

  // OpenAI and everything that speaks its chat completions API
  const tokens = provider.id === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const response = await call(http, provider, `${url}/chat/completions`, {
    method: 'POST', headers, seconds,
    body: JSON.stringify({ model, ...tokens, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  if (!ok(response)) throw failure(provider, response);
  const body = response.data as { choices?: { message?: { content?: string | { type: string; text?: string }[] } }[] } | null;
  const content = body?.choices?.[0]?.message?.content ?? '';
  const text = typeof content === 'string' ? content : content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  // some local reasoning models think out loud first
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
}

/** The test stand-in: answers without a key or a network. */
export function mockAnswer(request: AiRequest): string {
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
