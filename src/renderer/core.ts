// SPDX-License-Identifier: GPL-3.0-or-later
import type { CoreRequest, CoreResponse } from './core-worker';

export interface Inspection {
  encrypted: boolean;
  opensWithoutPassword: boolean;
  pageCount: number;
}

export interface RedactJob {
  page: number;
  rects: { x0: number; y0: number; x1: number; y1: number }[];
}

export interface RedactReport {
  removedGlyphs: number;
  pagesChanged: number[];
  warnings: string[];
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: CoreResponse) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker('./core-worker.js', { type: 'module' });
    worker.onmessage = (event: MessageEvent<CoreResponse>) => {
      pending.get(event.data.id)?.resolve(event.data);
      pending.delete(event.data.id);
    };
  }
  return worker;
}

function call(op: CoreRequest['op'], pdf: Uint8Array, arg?: string): Promise<CoreResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve });
    // copy so the caller's bytes aren't detached by the transfer
    const copy = pdf.slice();
    getWorker().postMessage({ id, op, pdf: copy, arg } satisfies CoreRequest, [copy.buffer]);
  });
}

async function expectPdf(response: CoreResponse): Promise<Uint8Array> {
  if (!response.ok || !response.pdf) throw new Error(response.error ?? 'The PDF core returned nothing');
  return response.pdf;
}

export type CompressLevel = 'light' | 'balanced' | 'strong';

export interface CompressReport {
  before: number;
  after: number;
  imagesShrunk: number;
  duplicatesMerged: number;
  streamsDeflated: number;
}

export interface ProtectOptions {
  userPassword: string;
  ownerPassword: string;
  allowPrint: boolean;
  allowCopy: boolean;
  allowEdit: boolean;
}

export const core = {
  async inspect(pdf: Uint8Array): Promise<Inspection> {
    const r = await call('inspect', pdf);
    if (!r.ok) throw new Error(r.error);
    return r.info as Inspection;
  },

  async decrypt(pdf: Uint8Array, password: string): Promise<Uint8Array> {
    return expectPdf(await call('decrypt', pdf, password));
  },

  async redact(pdf: Uint8Array, jobs: RedactJob[]): Promise<{ pdf: Uint8Array; report: RedactReport }> {
    const r = await call('redact', pdf, JSON.stringify(jobs));
    return { pdf: await expectPdf(r), report: r.info as RedactReport };
  },

  async finalize(pdf: Uint8Array): Promise<Uint8Array> {
    return expectPdf(await call('finalize', pdf));
  },

  async compress(pdf: Uint8Array, level: CompressLevel): Promise<{ pdf: Uint8Array; report: CompressReport }> {
    const r = await call('compress', pdf, JSON.stringify(level));
    return { pdf: await expectPdf(r), report: r.info as CompressReport };
  },

  /** Rebuilds a damaged file from whatever objects can be found. */
  async repair(pdf: Uint8Array): Promise<{ pdf: Uint8Array; pages: number }> {
    const r = await call('repair', pdf);
    return { pdf: await expectPdf(r), pages: r.info.pages };
  },

  /** AES-256 encryption. The randomness comes from the browser's CSPRNG. */
  async protect(pdf: Uint8Array, options: ProtectOptions): Promise<Uint8Array> {
    const seed = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    return expectPdf(await call('protect', pdf, JSON.stringify({ ...options, seed })));
  },

  /** The font file embedded for `name` on a page (zero-based), if it's one we can reuse. */
  async fontFile(pdf: Uint8Array, page: number, name: string): Promise<{ data: Uint8Array; kind: string; baseFont: string }> {
    const r = await call('font', pdf, JSON.stringify({ page, name }));
    return { data: await expectPdf(r), kind: r.info.kind, baseFont: r.info.baseFont };
  },
};
