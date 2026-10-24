// SPDX-License-Identifier: GPL-3.0-or-later
// Runs the Rust core (compiled to WebAssembly) off the main thread.
// See core/src/lib.rs for the other side of this interface.

interface CoreExports {
  memory: WebAssembly.Memory;
  ik_alloc(len: number): number;
  ik_free(ptr: number, len: number): void;
  ik_output_ptr(): number;
  ik_output_len(): number;
  ik_info_ptr(): number;
  ik_info_len(): number;
  ik_clear(): void;
  ik_inspect(ptr: number, len: number): number;
  ik_decrypt(ptr: number, len: number, pwPtr: number, pwLen: number): number;
  ik_redact(ptr: number, len: number, jobsPtr: number, jobsLen: number): number;
  ik_finalize(ptr: number, len: number): number;
  ik_font_file(ptr: number, len: number, reqPtr: number, reqLen: number): number;
  ik_compress(ptr: number, len: number, levelPtr: number, levelLen: number): number;
  ik_protect(ptr: number, len: number, reqPtr: number, reqLen: number): number;
  ik_repair(ptr: number, len: number): number;
}

export interface CoreRequest {
  id: number;
  op: 'inspect' | 'decrypt' | 'redact' | 'finalize' | 'font' | 'compress' | 'protect' | 'repair';
  pdf: Uint8Array;
  /** Password for decrypt, JSON jobs for redact, JSON request for font. */
  arg?: string;
}

export interface CoreResponse {
  id: number;
  ok: boolean;
  pdf?: Uint8Array;
  info?: any;
  error?: string;
}

let core: CoreExports | null = null;

async function load(): Promise<CoreExports> {
  if (core) return core;
  const response = await fetch(new URL('./core.wasm', self.location.href));
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  core = instance.exports as unknown as CoreExports;
  return core;
}

function copyIn(c: CoreExports, bytes: Uint8Array): [number, number] {
  const ptr = c.ik_alloc(bytes.length);
  new Uint8Array(c.memory.buffer, ptr, bytes.length).set(bytes);
  return [ptr, bytes.length];
}

function run(c: CoreExports, request: CoreRequest): CoreResponse {
  const [pdfPtr, pdfLen] = copyIn(c, request.pdf);
  const extra = new TextEncoder().encode(request.arg ?? '');
  const [argPtr, argLen] = copyIn(c, extra);

  let status: number;
  try {
    switch (request.op) {
      case 'inspect': status = c.ik_inspect(pdfPtr, pdfLen); break;
      case 'decrypt': status = c.ik_decrypt(pdfPtr, pdfLen, argPtr, argLen); break;
      case 'redact': status = c.ik_redact(pdfPtr, pdfLen, argPtr, argLen); break;
      case 'finalize': status = c.ik_finalize(pdfPtr, pdfLen); break;
      case 'font': status = c.ik_font_file(pdfPtr, pdfLen, argPtr, argLen); break;
      case 'compress': status = c.ik_compress(pdfPtr, pdfLen, argPtr, argLen); break;
      case 'protect': status = c.ik_protect(pdfPtr, pdfLen, argPtr, argLen); break;
      case 'repair': status = c.ik_repair(pdfPtr, pdfLen); break;
    }
  } finally {
    c.ik_free(pdfPtr, pdfLen);
    c.ik_free(argPtr, argLen);
  }

  // memory.buffer may have grown during the call, so read views afresh
  const out = new Uint8Array(c.memory.buffer, c.ik_output_ptr(), c.ik_output_len()).slice();
  const infoText = new TextDecoder().decode(new Uint8Array(c.memory.buffer, c.ik_info_ptr(), c.ik_info_len()));
  c.ik_clear();

  const info = infoText ? JSON.parse(infoText) : {};
  if (status !== 0) return { id: request.id, ok: false, error: info.error ?? 'Unknown error in PDF core' };
  return { id: request.id, ok: true, pdf: out.length ? out : undefined, info };
}

self.onmessage = async (event: MessageEvent<CoreRequest>) => {
  const request = event.data;
  try {
    const response = run(await load(), request);
    const transfer = response.pdf ? [response.pdf.buffer as ArrayBuffer] : [];
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (err) {
    // A panic in Rust aborts the instance; start fresh next time.
    core = null;
    (self as unknown as Worker).postMessage({ id: request.id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};
