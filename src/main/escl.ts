// SPDX-License-Identifier: GPL-3.0-or-later
// eSCL (also sold as AirScan or Mopria scan): the way most network printers
// from the last ten years scan, over plain HTTP. They announce themselves on
// the local network with Bonjour (mDNS), as "_uscan._tcp".
//
// This needs no driver at all, so it works the same on Windows, macOS and Linux.

import dgram from 'node:dgram';

export interface EsclScanner { url: string; name: string }

// --- finding them: one Bonjour question, then a short wait for answers -----------------------

const SERVICE = '_uscan._tcp.local';

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean).map((label) => {
    const bytes = Buffer.from(label, 'utf8');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/** A question for every "_uscan._tcp" service on the network. */
export function esclQuery(): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 4); // one question
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(12, 0); // PTR
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, encodeName(SERVICE), tail]);
}

/** Reads a (possibly compressed) name; returns it and where the record carries on. */
function readName(buf: Buffer, start: number): [string, number] {
  const labels: string[] = [];
  let at = start;
  let end = -1;
  for (let hops = 0; hops < 64 && at < buf.length; hops++) {
    const len = buf[at];
    if (len === 0) { at++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (end < 0) end = at + 2;
      at = ((len & 0x3f) << 8) | buf[at + 1];
      continue;
    }
    labels.push(buf.toString('utf8', at + 1, at + 1 + len));
    at += 1 + len;
  }
  return [labels.join('.'), end >= 0 ? end : at];
}

interface Answer { name: string; type: number; data: Buffer; offset: number }

function readAnswers(buf: Buffer): Answer[] {
  const questions = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let at = 12;
  for (let i = 0; i < questions; i++) at = readName(buf, at)[1] + 4;
  const out: Answer[] = [];
  for (let i = 0; i < total && at < buf.length; i++) {
    const [name, next] = readName(buf, at);
    const type = buf.readUInt16BE(next);
    const length = buf.readUInt16BE(next + 8);
    const offset = next + 10;
    out.push({ name: name.toLowerCase(), type, data: buf.subarray(offset, offset + length), offset });
    at = offset + length;
  }
  return out;
}

/** What one Bonjour reply says about the scanners it knows of. */
export function parseEsclReply(buf: Buffer, from: string): EsclScanner[] {
  let answers: Answer[];
  try { answers = readAnswers(buf); } catch { return []; }
  const addresses = new Map<string, string>();
  for (const a of answers) if (a.type === 1 && a.data.length === 4) addresses.set(a.name, [...a.data].join('.'));

  const found: EsclScanner[] = [];
  for (const ptr of answers.filter((a) => a.type === 12 && a.name === SERVICE)) {
    const [instance] = readName(buf, ptr.offset);
    const key = instance.toLowerCase();
    const srv = answers.find((a) => a.type === 33 && a.name === key);
    if (!srv) continue;
    const port = srv.data.readUInt16BE(4);
    const [target] = readName(buf, srv.offset + 6);
    const txt: Record<string, string> = {};
    const record = answers.find((a) => a.type === 16 && a.name === key);
    if (record) {
      for (let at = 0; at < record.data.length;) {
        const len = record.data[at];
        const entry = record.data.toString('utf8', at + 1, at + 1 + len);
        const eq = entry.indexOf('=');
        if (eq > 0) txt[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
        at += 1 + len;
      }
    }
    const host = addresses.get(target.toLowerCase()) ?? from;
    const root = (txt.rs ?? 'eSCL').replace(/^\/+|\/+$/g, '');
    const name = txt.ty || instance.slice(0, instance.length - SERVICE.length - 1).replace(/\\032/g, ' ') || host;
    found.push({ url: `http://${host}:${port}/${root ? `${root}/` : ''}`, name });
  }
  return found;
}

/** Asks the network for eSCL scanners and collects answers for a couple of seconds. */
export function findEsclScanners(waitMs = 2500, target = { address: '224.0.0.251', port: 5353 }): Promise<EsclScanner[]> {
  return new Promise((resolve) => {
    const found = new Map<string, EsclScanner>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', (msg, info) => {
      for (const s of parseEsclReply(msg, info.address)) if (!found.has(s.url)) found.set(s.url, s);
    });
    // sent from a passing port, so replies come straight back to us and
    // nothing else on this computer that listens for Bonjour is disturbed
    socket.bind(0, () => {
      const query = esclQuery();
      socket.send(query, target.port, target.address);
      setTimeout(() => socket.send(query, target.port, target.address), 700);
      setTimeout(finish, waitMs);
    });
  });
}

// --- scanning --------------------------------------------------------------------------------

export class EsclError extends Error {
  constructor(readonly reason: 'busy' | 'offline' | 'failed' | 'nopaper' | 'nofeeder' | 'noduplex') { super(reason); }
}

const timed = (ms: number) => AbortSignal.timeout(ms);

type Source = 'glass' | 'feeder' | 'duplex';

async function capabilities(url: string, source: Source) {
  const res = await fetch(`${url}ScannerCapabilities`, { signal: timed(15_000) });
  if (!res.ok) throw new EsclError('offline');
  const xml = await res.text();
  // sizes are in 300ths of an inch
  const section = source === 'glass'
    ? /<scan:Platen>([\s\S]*?)<\/scan:Platen>/.exec(xml)?.[1]
    : /<scan:Adf>([\s\S]*?)<\/scan:Adf>/.exec(xml)?.[1];
  if (section === undefined && source !== 'glass') throw new EsclError('nofeeder');
  const caps = section ?? xml;
  const width = Number(/<scan:MaxWidth>(\d+)</.exec(caps)?.[1]) || 2550;
  const height = Number(/<scan:MaxHeight>(\d+)</.exec(caps)?.[1]) || 3508;
  const resolutions = [...caps.matchAll(/<scan:XResolution>(\d+)</g)].map((m) => Number(m[1])).filter((n) => n > 0);
  const duplex = /<scan:AdfDuplexInputCaps>/.test(caps) || /<scan:AdfOptions>[\s\S]*Duplex/.test(caps);
  return { width, height, resolutions, duplex };
}

const closest = (wanted: number, offered: number[]) =>
  offered.length ? offered.reduce((best, n) => (Math.abs(n - wanted) < Math.abs(best - wanted) || (Math.abs(n - wanted) === Math.abs(best - wanted) && n > best) ? n : best)) : wanted;

/**
 * Scans from the glass (one page) or the feeder (every page in it, on one or
 * both sides). Returns JPEGs and the resolution they were scanned at, which
 * can differ a little from the one asked for.
 */
export async function esclScan(url: string, dpi: number, color: 'color' | 'gray' | 'bw', source: Source = 'glass'): Promise<{ pages: Uint8Array[]; dpi: number }> {
  let caps;
  try { caps = await capabilities(url, source); } catch (err) { throw err instanceof EsclError ? err : new EsclError('offline'); }
  if (source === 'duplex' && !caps.duplex) throw new EsclError('noduplex');
  const resolution = closest(dpi, caps.resolutions);
  // black and white pages are scanned in grey and turned into clean black text afterwards,
  // since few scanners send one-bit JPEGs
  const mode = color === 'color' ? 'RGB24' : 'Grayscale8';
  const settings = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${caps.width}</pwg:Width>
      <pwg:Height>${caps.height}</pwg:Height>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${source === 'glass' ? 'Platen' : 'Feeder'}</pwg:InputSource>${source === 'duplex' ? '\n  <scan:Duplex>true</scan:Duplex>' : ''}
  <scan:ColorMode>${mode}</scan:ColorMode>
  <scan:XResolution>${resolution}</scan:XResolution>
  <scan:YResolution>${resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;

  let job: Response;
  try {
    job = await fetch(`${url}ScanJobs`, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: settings, signal: timed(30_000) });
  } catch {
    throw new EsclError('offline');
  }
  if (job.status === 503 || job.status === 409) throw new EsclError(source === 'glass' ? 'busy' : 'nopaper');
  const location = job.headers.get('location');
  if (job.status !== 201 || !location) throw new EsclError('failed');
  const jobUrl = new URL(location, url).href.replace(/\/$/, '');

  // each page comes once the scanner has finished it; until then it may say
  // it's busy. From the feeder, "not found" means there are no more.
  const pages: Uint8Array[] = [];
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    let page: Response;
    try {
      page = await fetch(`${jobUrl}/NextDocument`, { signal: timed(3 * 60_000) });
    } catch {
      if (pages.length) break;
      throw new EsclError('offline');
    }
    if (page.ok) {
      const bytes = new Uint8Array(await page.arrayBuffer());
      if (!bytes.length) throw new EsclError('failed');
      pages.push(bytes);
      if (source === 'glass') break;
      continue;
    }
    if (page.status === 503) { await new Promise((r) => setTimeout(r, 1000)); continue; }
    if (page.status === 404 && pages.length) break;
    throw new EsclError(page.status === 404 && source !== 'glass' ? 'nopaper' : 'failed');
  }
  if (!pages.length) throw new EsclError('offline');
  return { pages, dpi: resolution };
}
