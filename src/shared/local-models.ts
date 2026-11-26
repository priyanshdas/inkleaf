// SPDX-License-Identifier: GPL-3.0-or-later
// The AI models Inkleaf can download and run itself, with no key and no
// account (see src/main/local-ai.ts). Each one is pinned to an exact file and
// checked against its SHA-256 after downloading, the same way language packs
// are.
//
// All four are Qwen 3.5 (Apache 2.0) at different sizes, from one small enough
// for an old laptop to one that wants a strong computer. They all read and
// write the languages Inkleaf's menus come in. Quick is the default. The phone
// app runs the very same files (mobile/android/app/src/main/cpp), and the
// Windows installer offers the same list (scripts/installer-ai.mjs).

import { msg } from './i18n';

export interface LocalModel {
  id: string;
  /** Short name in the picker. */
  name: string;
  blurb: string;
  /** The model's size as its makers give it, for the installer's details. */
  params: string;
  /** Memory a computer should have to run it comfortably, in bytes. */
  memory: number;
  file: string;
  url: string;
  sha256: string;
  /** Bytes, for the progress bar and the "needs X GB" note. */
  size: number;
  /** How much of a document fits in one question, in characters. */
  budget: number;
  /** Tokens of context the model is run with. */
  context: number;
  /**
   * The same model on a phone, which has only its processor to run it on:
   * less of the document per question, so answers don't take minutes.
   */
  phone: { blurb: string; budget: number; context: number; memory: number };
}

const HF = 'https://huggingface.co';

export const LOCAL_MODELS: LocalModel[] = [
  {
    id: 'qwen3.5-0.8b',
    name: msg('Lite'),
    blurb: msg('Small and fast, for older or slower computers. Simpler answers.'),
    params: '0.8B',
    memory: 4e9,
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: `${HF}/lmstudio-community/Qwen3.5-0.8B-GGUF/resolve/26bab2c9369648924251c0ebb3dae012f5147707/Qwen3.5-0.8B-Q4_K_M.gguf`,
    sha256: 'f5b14da98939b60bbe1019a964eba656407e1e0b64f1fe3003ff6d650e93bfec',
    size: 527_502_816,
    budget: 10_000,
    context: 8192,
    phone: { blurb: msg('Small and fast, for older phones. Simpler answers.'), budget: 6_000, context: 4096, memory: 3e9 },
  },
  {
    id: 'qwen3.5-2b',
    name: msg('Quick'),
    blurb: msg('Fine on most laptops. Good for summaries and questions.'),
    params: '2B',
    memory: 8e9,
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    url: `${HF}/lmstudio-community/Qwen3.5-2B-GGUF/resolve/bb84e11355a036e28f080c7793fa6d22b7c4e344/Qwen3.5-2B-Q4_K_M.gguf`,
    sha256: '0bfe35afc9f05b7fac3fa04925e051ac7939a42a8a17ea11afc99701bea826cc',
    size: 1_270_808_032,
    budget: 14_000,
    context: 8192,
    phone: { blurb: msg('Fine on most phones. Good for summaries and questions.'), budget: 6_000, context: 4096, memory: 4e9 },
  },
  {
    id: 'qwen3.5-4b',
    name: msg('Better'),
    blurb: msg('Better answers and translations. Best with a graphics card or a recent computer.'),
    params: '4B',
    memory: 8e9,
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    url: `${HF}/lmstudio-community/Qwen3.5-4B-GGUF/resolve/f9f88ac3e234be915e23811a6d28ea287bdb927e/Qwen3.5-4B-Q4_K_M.gguf`,
    sha256: '25082a7dd3776cc3c741c6347d3bd04523f05796607b3fbc32fa3a25dfa1418c',
    size: 2_707_513_696,
    budget: 24_000,
    context: 12288,
    phone: { blurb: msg('Better answers and translations, but slower. Needs a phone with 8 GB of memory.'), budget: 6_000, context: 4096, memory: 7e9 },
  },
  {
    id: 'qwen3.5-9b',
    name: msg('Best'),
    blurb: msg('The best answers and translations. Needs a strong computer, ideally with a graphics card.'),
    params: '9B',
    memory: 16e9,
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    url: `${HF}/lmstudio-community/Qwen3.5-9B-GGUF/resolve/1379f25c6b505a3fc737bd7818cb09389cf807c1/Qwen3.5-9B-Q4_K_M.gguf`,
    sha256: 'cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13',
    size: 5_627_044_256,
    budget: 32_000,
    context: 16384,
    phone: { blurb: msg('The best answers, but very slow on a phone. Needs a phone with 12 GB of memory.'), budget: 6_000, context: 4096, memory: 11e9 },
  },
];

/** The one picked until someone chooses: fine on most computers. */
export const DEFAULT_LOCAL_MODEL = 'qwen3.5-2b';

export const localModelById = (id: string | undefined) =>
  LOCAL_MODELS.find((m) => m.id === id) ?? LOCAL_MODELS.find((m) => m.id === DEFAULT_LOCAL_MODEL)!;

export interface LocalAiStatus {
  /** Whether this computer can run the built-in AI at all. */
  supported: boolean;
  /** Model ids that are downloaded and checked. */
  installed: string[];
  /** Bytes each model still needs to download, including llama.cpp itself the first time. */
  sizes: Record<string, number>;
  /** The model being downloaded, if any, and how far it's got. */
  downloading: { id: string; received: number; total: number } | null;
  /** The graphics card (or "CPU") it last ran on. */
  device: string | null;
  /** Phones: how much memory it has, in bytes, so the bigger model can come with a warning. */
  memory?: number;
}

export type LocalAiEvent =
  | { type: 'progress'; id: string; received: number; total: number }
  | { type: 'done'; id: string }
  | { type: 'failed'; id: string; message: string };
