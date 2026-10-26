// SPDX-License-Identifier: GPL-3.0-or-later
// The AI services Inkleaf can talk to. Everything about a provider that the
// settings screen and the main process both need lives here, so adding one
// is a single entry.
//
// Model names change every few months, so the lists below are only starting
// points: the settings screen can also ask the provider for its current list.

import { msg } from './i18n';

/** How a provider expects to be called. */
export type AiProtocol = 'anthropic' | 'openai' | 'perplexity';

export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'xai' | 'perplexity' | 'local' | 'custom';

export interface AiProvider {
  id: AiProviderId;
  /** What people call it. */
  name: string;
  /** The company, for the privacy notice ("sends the text to …"). */
  company: string;
  protocol: AiProtocol;
  /** Where requests go. Local and custom servers let the person change it. */
  baseUrl: string;
  /** False for servers on the person's own computer, which usually don't want one. */
  needsKey: boolean;
  /** Keys from this provider start like this (only used as a hint and a sanity check). */
  keyPrefix?: string;
  /** Where to get a key, shown under the key field. */
  keyUrl?: string;
  /** Models suggested before the live list is loaded, cheapest first. */
  models: string[];
  /** True when nothing leaves the computer. */
  onDevice?: boolean;
  /** One line under the name in the picker. */
  blurb: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'anthropic', name: 'Claude', company: 'Anthropic', protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1', needsKey: true, keyPrefix: 'sk-ant-', keyUrl: 'console.anthropic.com',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    blurb: msg('Careful, accurate summaries and translations.'),
  },
  {
    id: 'openai', name: 'ChatGPT', company: 'OpenAI', protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1', needsKey: true, keyPrefix: 'sk-', keyUrl: 'platform.openai.com/api-keys',
    models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'],
    blurb: msg('OpenAI’s GPT models.'),
  },
  {
    id: 'gemini', name: 'Gemini', company: 'Google', protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', needsKey: true, keyUrl: 'aistudio.google.com/apikey',
    models: ['gemini-flash-latest', 'gemini-pro-latest'],
    blurb: msg('Google’s models, with a free tier for light use.'),
  },
  {
    id: 'xai', name: 'Grok', company: 'xAI', protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1', needsKey: true, keyPrefix: 'xai-', keyUrl: 'console.x.ai',
    models: ['grok-4.7'],
    blurb: msg('xAI’s Grok models.'),
  },
  {
    id: 'perplexity', name: 'Perplexity', company: 'Perplexity', protocol: 'perplexity',
    baseUrl: 'https://api.perplexity.ai/v1', needsKey: true, keyPrefix: 'pplx-', keyUrl: 'perplexity.ai/account/api',
    // Perplexity's Agent API takes an "effort" preset rather than a model name
    models: ['fast', 'low', 'medium'],
    blurb: msg('Perplexity’s Agent API.'),
  },
  {
    id: 'local', name: msg('AI on this computer'), company: msg('this computer'), protocol: 'openai',
    baseUrl: 'http://localhost:11434/v1', needsKey: false, onDevice: true,
    models: [],
    blurb: msg('Ollama, LM Studio or any local server. Free, and nothing leaves your computer.'),
  },
  {
    id: 'custom', name: msg('Other service'), company: msg('the server you chose'), protocol: 'openai',
    baseUrl: '', needsKey: false,
    models: [],
    blurb: msg('Any service with an OpenAI-compatible API, such as OpenRouter, Groq or Mistral.'),
  },
];

export const providerById = (id: string | undefined): AiProvider =>
  AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];

/** Common local servers, offered as one-click addresses. */
export const LOCAL_SERVERS = [
  { name: 'Ollama', url: 'http://localhost:11434/v1' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1' },
  { name: 'Jan', url: 'http://localhost:1337/v1' },
  { name: 'llama.cpp', url: 'http://localhost:8080/v1' },
];

/**
 * Plain http is only allowed to this computer and the local network; anything
 * further away has to be https so the key and the document aren't sent in
 * the clear.
 */
export function checkServerUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol === 'https:') return url.href.replace(/\/+$/, '');
  if (url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host === '::1' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return local ? url.href.replace(/\/+$/, '') : null;
}
