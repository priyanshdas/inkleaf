// SPDX-License-Identifier: GPL-3.0-or-later
// The built-in AI: a small open model that Inkleaf downloads once and runs on
// this computer. No key, no account, and the document never leaves the
// computer.
//
// The model runs in llama.cpp's own server program (llama-server), started
// when it's needed and stopped after a few idle minutes. Running it as a
// separate program, rather than inside Inkleaf, keeps a crash or a stall in
// the model from taking the editor down with it, and lets llama.cpp use its
// normal memory allocator (Electron's refuses the large blocks a model needs).
// It listens only on this computer, on a port picked at random, and only
// answers requests carrying a key made fresh each time it starts.
//
// Both downloads, llama.cpp from its GitHub releases and the model from
// Hugging Face, are pinned to exact versions and checked against their
// SHA-256 before they're used. A download that's cut off carries on where it
// stopped next time.

import { app } from 'electron';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { t } from '../shared/i18n';
import { LOCAL_MODELS, LocalAiEvent, LocalAiStatus, LocalModel } from '../shared/local-models';
import type { AiRequest } from '../shared/ai-core';

// --- llama.cpp itself ------------------------------------------------------------------------

interface Runtime { file: string; sha256: string; size: number }

/** llama.cpp release b11669. The Vulkan builds use any recent graphics card and fall back to the processor. */
const LLAMA_TAG = 'b11669';
const RUNTIMES: Record<string, Runtime> = {
  'win32-x64': { file: 'llama-b11669-bin-win-vulkan-x64.zip', sha256: '2c07574e7bde71321cb785282b20cc821e951132149eeceeea32ddebdbf0598e', size: 32_182_350 },
  'win32-arm64': { file: 'llama-b11669-bin-win-vulkan-arm64.zip', sha256: '963d3b185362cadca3de643409f916a5ce95dd0f7fd8617ba9ee5d8833ac1ef3', size: 24_817_965 },
  'linux-x64': { file: 'llama-b11669-bin-ubuntu-vulkan-x64.tar.gz', sha256: 'e8709e5ba6c1b093dea7f3de57f4aba842f9a188fba6b465782d65d6fcfa4d9f', size: 30_497_889 },
  'linux-arm64': { file: 'llama-b11669-bin-ubuntu-arm64.tar.gz', sha256: '9ac6fda2058d35677608a06f751a50122ddfa4ce0ddb7f084466b8e79b6d4a99', size: 13_900_160 },
  'darwin-arm64': { file: 'llama-b11669-bin-macos-arm64.tar.gz', sha256: 'dbed55493d72bc1ba2babc8770d669c2289b5bc4ee9fb2a4dfc158d45b7d13fd', size: 12_191_582 },
  'darwin-x64': { file: 'llama-b11669-bin-macos-x64.tar.gz', sha256: 'cab28238d78158109b48deb27b05d50e0dcef56275d2e76da9ca8281526c7532', size: 11_677_404 },
};

/** In development the tests point both downloads at small stand-ins on a local server. */
const testing = () => !app.isPackaged;

function runtimeFor(): (Runtime & { url: string }) | null {
  const test = testing() && process.env.INKLEAF_TEST_LLAMA_RUNTIME;
  if (test) return JSON.parse(test);
  const runtime = RUNTIMES[`${process.platform}-${process.arch}`];
  return runtime ? { ...runtime, url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${runtime.file}` } : null;
}

const root = () => path.join(app.getPath('userData'), 'ai');
const runtimeDir = () => path.join(root(), `llama-${LLAMA_TAG}`);
const modelsDir = () => path.join(root(), 'models');
const OK = '.ok';

/** The server program inside the unpacked release (its folder layout differs by platform). */
function findServer(dir: string): string | null {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const look = (folder: string, depth: number): string | null => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) if (e.isFile() && e.name === name) return path.join(folder, e.name);
    if (depth > 0) for (const e of entries) if (e.isDirectory()) {
      const found = look(path.join(folder, e.name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  return look(dir, 2);
}

const runtimeInstalled = () => existsSync(path.join(runtimeDir(), OK)) && !!findServer(runtimeDir());

// --- the models ------------------------------------------------------------------------------

function catalogue(): LocalModel[] {
  const test = testing() && process.env.INKLEAF_TEST_LOCAL_MODELS;
  if (!test) return LOCAL_MODELS;
  const overrides = JSON.parse(test) as Partial<LocalModel>[];
  return LOCAL_MODELS.map((m, i) => ({ ...m, ...overrides[i] }));
}
const modelById = (id: string) => catalogue().find((m) => m.id === id) ?? catalogue()[0];
const modelFile = (model: LocalModel) => path.join(modelsDir(), model.file);

export function isInstalled(id: string): boolean {
  const model = modelById(id);
  try {
    return runtimeInstalled() && existsSync(modelFile(model) + OK) && statSync(modelFile(model)).size === model.size;
  } catch {
    return false;
  }
}

// --- status ----------------------------------------------------------------------------------

let downloading: { id: string; received: number; total: number; stop: AbortController } | null = null;
/** The graphics card (or "CPU") the model last ran on, from llama.cpp's own log. */
let device: string | null = null;

/** Bytes still to fetch for a model, including llama.cpp the first time. */
function downloadSize(id: string): number {
  const runtime = runtimeFor();
  const model = modelById(id);
  return (existsSync(modelFile(model) + OK) ? 0 : model.size) + (runtime && !runtimeInstalled() ? runtime.size : 0);
}

export function localStatus(): LocalAiStatus {
  return {
    supported: !!runtimeFor(),
    installed: catalogue().filter((m) => isInstalled(m.id)).map((m) => m.id),
    sizes: Object.fromEntries(catalogue().map((m) => [m.id, downloadSize(m.id)])),
    downloading: downloading && { id: downloading.id, received: downloading.received, total: downloading.total },
    device,
  };
}

export function removeModel(id: string) {
  const model = modelById(id);
  if (server?.model === model.id) stopServer();
  for (const f of [modelFile(model), modelFile(model) + OK, `${modelFile(model)}.part`]) rmSync(f, { force: true });
  // llama.cpp goes too once no model is left to use it
  if (!catalogue().some((m) => existsSync(modelFile(m) + OK))) {
    stopServer();
    rmSync(runtimeDir(), { recursive: true, force: true });
  }
}

// --- downloading -----------------------------------------------------------------------------

export function cancelDownload() {
  downloading?.stop.abort();
}

function hashExisting(file: string, hash: ReturnType<typeof createHash>): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve()).on('error', reject);
  });
}

/**
 * Fetches one file to `dest`, resuming from `dest.part` if an earlier try was
 * cut off, and checks it against its SHA-256 before putting it in place.
 */
async function fetchChecked(url: string, sha256: string, size: number, dest: string, signal: AbortSignal, onBytes: (n: number) => void) {
  const part = `${dest}.part`;
  let hash = createHash('sha256');
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > size) {
    rmSync(part);
    have = 0;
  }
  if (have) {
    await hashExisting(part, hash);
    onBytes(have);
  }
  let response: Response;
  try {
    response = await fetch(url, { headers: have ? { range: `bytes=${have}-` } : {}, signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(t('Couldn’t reach the download server. Check your internet connection and try again.'));
  }
  // a server that ignores the range sends the whole file again
  if (have && response.status !== 206) {
    onBytes(-have);
    have = 0;
    hash = createHash('sha256');
  }
  if (!response.ok || !response.body) throw new Error(t('The download server returned an error ({status}).', { status: response.status }));

  const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
  const finished = new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      onBytes(value.length);
    }
  } finally {
    out.end();
    await finished;
  }
  if (statSync(part).size !== size || hash.digest('hex') !== sha256) {
    rmSync(part, { force: true });
    throw new Error(t('The download didn’t match what was expected, so it was deleted. Try again.'));
  }
  renameSync(part, dest);
}

/** Unpacks llama.cpp with the system's tar, which reads .zip too on Windows 10 and later. */
function unpack(archive: string, into: string): Promise<void> {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', archive, '-C', into], { windowsHide: true }, (err) => {
      if (err) reject(new Error(t('Couldn’t unpack the built-in AI ({reason}).', { reason: err.message })));
      else resolve();
    });
  });
}

/**
 * Downloads a model, and llama.cpp the first time, reporting progress as it
 * goes. A cancelled download keeps what it has for next time.
 */
export async function downloadModel(id: string, send: (event: LocalAiEvent) => void): Promise<void> {
  if (downloading) throw new Error(t('A model is already downloading.'));
  const model = modelById(id);
  if (isInstalled(model.id)) return;
  const runtime = runtimeFor();
  if (!runtime) throw new Error(t('The built-in AI doesn’t run on this kind of computer.'));

  const stop = new AbortController();
  const total = downloadSize(model.id);
  const state = (downloading = { id: model.id, received: 0, total, stop });
  let last = 0;
  const onBytes = (n: number) => {
    state.received += n;
    const now = Date.now();
    if (now - last > 250) {
      last = now;
      send({ type: 'progress', id: model.id, received: state.received, total });
    }
  };

  try {
    mkdirSync(modelsDir(), { recursive: true });
    if (!runtimeInstalled()) {
      const archive = path.join(root(), runtime.file);
      await fetchChecked(runtime.url, runtime.sha256, runtime.size, archive, stop.signal, onBytes);
      rmSync(runtimeDir(), { recursive: true, force: true });
      mkdirSync(runtimeDir(), { recursive: true });
      await unpack(archive, runtimeDir());
      rmSync(archive, { force: true });
      if (!findServer(runtimeDir())) throw new Error(t('The built-in AI download was incomplete. Try again.'));
      writeFileSync(path.join(runtimeDir(), OK), runtime.sha256);
    }
    if (!existsSync(modelFile(model) + OK)) {
      await fetchChecked(model.url, model.sha256, model.size, modelFile(model), stop.signal, onBytes);
      writeFileSync(modelFile(model) + OK, model.sha256);
    }
    send({ type: 'done', id: model.id });
  } catch (err) {
    send({ type: 'failed', id: model.id, message: stop.signal.aborted ? '' : (err as Error).message || String(err) });
    if (!stop.signal.aborted) throw err;
  } finally {
    downloading = null;
  }
}

// --- running the server ----------------------------------------------------------------------

interface Server { model: string; process: ChildProcess; url: string; key: string; ready: Promise<void> }
let server: Server | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const IDLE_MS = 5 * 60_000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let cardName: Promise<string | null> | null = null;

/**
 * The graphics card llama.cpp will use, by name, from `llama-server
 * --list-devices` ("Vulkan0: NVIDIA GeForce RTX 5060 Laptop GPU (8151 MiB,
 * 7600 MiB free)"). Null when it only has the processor.
 */
function graphicsCard(program: string): Promise<string | null> {
  cardName ??= new Promise((resolve) => {
    execFile(program, ['--list-devices'], { cwd: path.dirname(program), windowsHide: true, timeout: 20_000 }, (_err, stdout, stderr) => {
      const line = `${stdout}\n${stderr}`.split('\n').map((l) => l.trim()).find((l) => /^\w+\d+: /.test(l) && !/^CPU/i.test(l));
      resolve(line ? line.replace(/^\w+\d+: /, '').replace(/\s*\(\d+ MiB.*$/, '').trim() || null : null);
    });
  });
  return cardName;
}

function stopServer() {
  const current = server;
  server = null;
  if (current && current.process.exitCode === null) current.process.kill();
}

/** Starts llama-server with a model. `gpu: false` keeps it on the processor. */
async function startServer(id: string, gpu: boolean): Promise<Server> {
  const model = modelById(id);
  const program = findServer(runtimeDir());
  if (!program || !isInstalled(model.id)) throw new Error(t('Download the built-in AI model first (Tools › AI settings).'));
  const port = await freePort();
  const key = randomBytes(24).toString('hex');
  const args = [
    '--model', modelFile(model),
    '--host', '127.0.0.1', '--port', String(port), '--api-key', key,
    '--ctx-size', String(model.context), '--parallel', '1',
    '--n-gpu-layers', gpu ? '999' : '0',
    // answer straight away rather than thinking out loud first
    '--reasoning-budget', '0',
    '--no-webui',
  ];
  const binDir = path.dirname(program);
  const child = spawn(program, args, {
    cwd: binDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LD_LIBRARY_PATH: [binDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  });
  // llama.cpp's own log, kept in memory for error messages and in a file for
  // anyone looking into a problem; it also says which device the model went to
  let log = '';
  // the processor retry adds to the graphics card attempt's log rather than replacing it
  const logFile = createWriteStream(path.join(root(), 'llama-server.log'), { flags: gpu ? 'w' : 'a' });
  logFile.write(`--- ${new Date().toISOString()} ${gpu ? 'graphics card' : 'processor only'}: ${model.file}\n`);
  // llama.cpp writes its log to both outputs, depending on the build
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.setEncoding('utf8');
    stream.on('data', (text: string) => {
      log = (log + text).slice(-64_000);
      logFile.write(text);
    });
  }
  child.once('exit', () => logFile.end());
  /** A graphics card the model went onto, if llama.cpp's log names one. */
  const loadedOn = () => {
    const offloaded = log.match(/offloaded (\d+)\/(\d+) layers to GPU/);
    if (offloaded && Number(offloaded[1]) === 0) return null;
    // "using device Vulkan0 (NVIDIA GeForce RTX 5060 Laptop GPU) (0000:01:00.0) - 7800 MiB free"
    const named = log.match(/using device \w+ \(([^)\n]+)\)/) ?? log.match(/ggml_vulkan: \d+ = ([^(|\n]+)/);
    return named ? named[1].trim() : null;
  };

  const url = `http://127.0.0.1:${port}`;
  let exited: number | null = null;
  child.once('exit', (code) => (exited = code ?? -1));
  child.once('error', () => (exited = -1));
  const ready = (async () => {
    const started = Date.now();
    while (Date.now() - started < 180_000) {
      if (exited !== null) {
        const reason = log.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        throw new Error(t('The built-in AI stopped while starting ({reason}).', { reason: reason || String(exited) }));
      }
      try {
        const health = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${key}` } });
        if (health.ok) {
          device = gpu ? loadedOn() ?? (await graphicsCard(program)) ?? 'CPU' : 'CPU';
          return;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    child.kill();
    throw new Error(t('The built-in AI took too long to start.'));
  })();
  return { model: model.id, process: child, url, key, ready };
}

async function ensureServer(id: string): Promise<Server> {
  if (server && server.model === id && server.process.exitCode === null) {
    await server.ready;
    return server;
  }
  stopServer();
  let started: Server;
  try {
    started = server = await startServer(id, true);
    await started.ready;
  } catch (gpuError) {
    // an old or unusual graphics driver can fail where the processor won't
    stopServer();
    try {
      started = server = await startServer(id, false);
      await started.ready;
    } catch {
      stopServer();
      throw gpuError;
    }
  }
  started.process.once('exit', () => {
    if (server === started) server = null;
  });
  return started;
}

let busy = 0;
/** One answer at a time; the server is started with a single slot. */
let queue: Promise<unknown> = Promise.resolve();

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!busy) stopServer();
  }, IDLE_MS);
}

/**
 * Answers one request with the built-in model. Text arrives in pieces through
 * onChunk as it's written; the promise resolves with the whole answer.
 */
export function generate(id: string, request: AiRequest, onChunk?: (text: string) => void, signal?: AbortSignal): Promise<string> {
  const run = queue.then(async () => {
    if (signal?.aborted) return '';
    busy++;
    try {
      const { url, key } = await ensureServer(id);
      let response: Response;
      try {
        response = await fetch(`${url}/v1/chat/completions`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
            max_tokens: Math.min(4000, Math.max(64, request.maxTokens | 0)),
            temperature: 0.3,
            stream: true,
            chat_template_kwargs: { enable_thinking: false },
          }),
        });
      } catch (err) {
        if (signal?.aborted) return '';
        throw new Error(t('The built-in AI stopped unexpectedly. Try again.'));
      }
      if (!response.ok || !response.body) {
        const body = await response.text().catch(() => '');
        if (/context|too long|exceed/i.test(body)) throw new Error(t('That’s too much text for the built-in AI at once. Try fewer pages, or a cloud AI in Tools › AI settings.'));
        throw new Error(t('The built-in AI returned an error ({status}).', { status: response.status }));
      }

      // server-sent events: "data: {json}" lines, ending with "data: [DONE]"
      let answer = '';
      let pending = '';
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline).trim();
            pending = pending.slice(newline + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            let piece = '';
            try {
              piece = JSON.parse(data).choices?.[0]?.delta?.content ?? '';
            } catch {
              continue;
            }
            // the model opens with blank lines before its answer
            if (!answer) piece = piece.replace(/^\s+/, '');
            if (!piece) continue;
            answer += piece;
            onChunk?.(piece);
          }
        }
      } catch (err) {
        if (!signal?.aborted) throw err;
      }
      return answer.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    } finally {
      busy--;
      touch();
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** Stops llama.cpp when Inkleaf quits. */
export function shutdownLocalAi() {
  if (idleTimer) clearTimeout(idleTimer);
  stopServer();
}
