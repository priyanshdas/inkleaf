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
import { AI_PROVIDERS, AiProvider, AiProviderId, checkServerUrl, providerById } from '../shared/ai-providers';
import { AiRequest, askAi, checkConfig, Http, listModels as listProviderModels, mockAnswer, NetworkError } from '../shared/ai-core';
import type { AiConfig, AiStatus } from '../shared/api';
import { app, safeStorage } from 'electron';
import { generate, isInstalled, localStatus } from './local-ai';
import { localModelById } from '../shared/local-models';
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

// new installs start on the built-in AI: free, private, and no key to find
const empty = (): Stored => ({ provider: 'builtin', keys: {}, models: {}, urls: {} });

function read(): Stored {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file(), 'utf8'));
  } catch {
    return empty();
  }
  // version 2.3 and earlier kept one Anthropic key and a fast/best choice
  if (typeof raw.key === 'string') {
    // (they keep using it; the built-in AI is only the default for new setups)
    return { ...empty(), provider: 'anthropic', keys: { anthropic: raw.key }, models: { anthropic: raw.model === 'best' ? 'claude-sonnet-5-5' : 'claude-haiku-5-5' } };
  }
  const stored = { ...empty(), ...raw } as Stored;
  if (!AI_PROVIDERS.some((p) => p.id === stored.provider)) stored.provider = 'builtin';
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
  if (provider.id === 'builtin') return isInstalled(modelFor(provider, stored));
  if (provider.needsKey && !stored.keys[provider.id]) return false;
  return !!urlFor(provider, stored) && !!modelFor(provider, stored);
}

/**
 * How much of a document to send in one request. Cloud models take whole
 * books; small models on this computer have far less room.
 */
function budgetFor(provider: AiProvider, stored: Stored): number {
  if (provider.id === 'builtin') return localModelById(modelFor(provider, stored)).budget;
  if (provider.id === 'local') return 24_000;
  return 120_000;
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
    budget: budgetFor(provider, stored),
    local: localStatus(),
  };
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
  if (provider.id === 'builtin' && !isInstalled(model) && !mock()) throw new Error(t('Download the model first.'));
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

/** Node's fetch, with a timeout, in the shape ai-core expects. */
const http: Http = async (url, request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.seconds * 1000);
  let response: Response;
  try {
    response = await fetch(url, { method: request.method ?? 'GET', headers: request.headers, body: request.body, signal: controller.signal });
  } catch (err) {
    throw new NetworkError((err as Error).name === 'AbortError');
  } finally {
    clearTimeout(timer);
  }
  return { status: response.status, data: await response.json().catch(() => null) };
};

/**
 * The models a provider offers right now, for the settings screen. Uses the
 * key being typed if there is one, otherwise the saved key.
 */
export async function listModels(config: Partial<AiConfig>): Promise<string[]> {
  const provider = providerById(config.provider);
  if (provider.id === 'builtin') return provider.models;
  if (mock() && process.env.INKLEAF_AI_MOCK !== 'real') return [...provider.models, `${provider.id}-test-model`];
  const url = provider.id === 'local' || provider.id === 'custom' ? checkServerUrl(String(config.url ?? '')) : cloudUrl(provider);
  if (!url) throw new Error(t('Use an address starting with https://, or http:// for this computer and your local network.'));
  const key = String(config.key ?? '').trim() || keyFor(provider, read());
  return listProviderModels(http, provider, url, key);
}

/**
 * One question to the chosen AI; resolves with the text of the answer. The
 * built-in AI also hands over the answer in pieces as it's written; the
 * others answer all at once.
 */
export async function ask(request: AiRequest, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  if (mock() && process.env.INKLEAF_AI_MOCK !== 'real') {
    const answer = mockAnswer(request);
    onChunk?.(answer);
    return answer;
  }
  const stored = read();
  const provider = providerById(stored.provider);
  if (!isReady(provider, stored)) {
    if (provider.id === 'builtin') throw new Error(t('Download the built-in AI model first (Tools › AI settings).'));
    throw new Error(t('Set up an AI service first (Tools › AI settings).'));
  }
  if (provider.id === 'builtin') return generate(modelFor(provider, stored), request, onChunk, signal);
  return askAi(http, { provider, url: urlFor(provider, stored), key: keyFor(provider, stored), model: modelFor(provider, stored) }, request);
}
