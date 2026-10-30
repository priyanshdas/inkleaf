// SPDX-License-Identifier: GPL-3.0-or-later
// Stand-ins for the built-in AI's downloads, so the tests can run the whole
// path (download, check, unpack, start, answer, stop) without fetching
// gigabytes or running a real model.
//
// startFakeLlamaDownloads() serves a small "llama.cpp release" whose
// llama-server is the script at the bottom of this file, plus two small
// "model" files. The stand-in server answers like llama-server does:
// /health, and streamed /v1/chat/completions.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export async function startFakeLlamaDownloads() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-fake-llama-'));
  // the "release": a folder holding llama-server, packed like the real ones
  const folder = path.join(work, 'llama-test');
  fs.mkdirSync(folder);
  const server = path.join(folder, 'llama-server');
  fs.writeFileSync(server, `#!${process.execPath}\nimport(${JSON.stringify(fileURLToPath(import.meta.url))}).then((m) => m.runFakeServer());\n`);
  fs.chmodSync(server, 0o755);
  execFileSync('tar', ['-czf', path.join(work, 'runtime.tar.gz'), '-C', work, 'llama-test']);
  const files = {
    'runtime.tar.gz': fs.readFileSync(path.join(work, 'runtime.tar.gz')),
    'quick.gguf': Buffer.alloc(300_000, 7),
    'better.gguf': Buffer.alloc(200_000, 9),
  };
  const seen = { requests: [], ranges: 0 };

  const httpServer = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    seen.requests.push(name);
    const body = files[name];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
    if (range) {
      seen.ranges++;
      const from = Number(range[1]);
      res.writeHead(206, { 'content-length': body.length - from, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` });
      res.end(body.subarray(from));
      return;
    }
    // sent slowly, in pieces, so progress can be seen
    res.writeHead(200, { 'content-length': body.length });
    let at = 0;
    const step = () => {
      if (at >= body.length) return res.end();
      res.write(body.subarray(at, at + 50_000));
      at += 50_000;
      setTimeout(step, 30);
    };
    step();
  });
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  return {
    seen,
    env: {
      INKLEAF_TEST_LLAMA_RUNTIME: JSON.stringify({ file: 'runtime.tar.gz', url: `${base}/runtime.tar.gz`, sha256: sha(files['runtime.tar.gz']), size: files['runtime.tar.gz'].length }),
      INKLEAF_TEST_LOCAL_MODELS: JSON.stringify([
        { file: 'quick.gguf', url: `${base}/quick.gguf`, sha256: sha(files['quick.gguf']), size: files['quick.gguf'].length },
        // a wrong hash, to see a bad download refused
        { file: 'better.gguf', url: `${base}/better.gguf`, sha256: '0'.repeat(64), size: files['better.gguf'].length },
      ]),
    },
    close: () => {
      httpServer.close();
      fs.rmSync(work, { recursive: true, force: true });
    },
  };
}

/** The stand-in llama-server: reads the same options and answers the same requests. */
export function runFakeServer() {
  const args = process.argv.slice(2);
  const option = (name) => args[args.indexOf(name) + 1];
  if (args.includes('--list-devices')) {
    process.stdout.write('Available devices:\n  Vulkan0: Test GPU (8151 MiB, 7600 MiB free)\n');
    process.exit(0);
  }
  const port = Number(option('--port'));
  const key = option('--api-key');
  // like the real one at its normal log level: no device named, so Inkleaf asks with --list-devices
  process.stderr.write('srv  load_model: loading model\nsrv  llama_server: model loaded\n');
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const request = JSON.parse(body);
        const prompt = request.messages.at(-1).content;
        const question = /\nQuestion: (.*)$/.exec(prompt)?.[1];
        const answer = question
          ? `Built-in answer to: ${question}\n\n- The total is 18,450 rupees (p. 1).`
          : '- A summary point from the built-in AI\n- Another point';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const pieces = ['\n\n', ...answer.match(/.{1,12}/gs)];
        let i = 0;
        const next = () => {
          if (i >= pieces.length) {
            res.end('data: [DONE]\n\n');
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
          setTimeout(next, 15);
        };
        next();
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');
  process.on('SIGTERM', () => process.exit(0));
}
