// SPDX-License-Identifier: GPL-3.0-or-later
// Scanning from a flatbed scanner or all-in-one printer.
//
// Scanners speak one of a few languages, and Inkleaf asks in all of them at
// once, then lists everything it finds:
//
// - WIA, the scanner interface built into Windows (what Windows Scan uses).
// - TWAIN, which older scanners and all-in-ones often have instead of WIA.
//   Most of those drivers are 32-bit, so the 32-bit PowerShell runs them.
// - eSCL (AirScan), how network printers scan. Needs no driver, so it works
//   on every system.
// - SANE on Linux (scanimage), which also covers HP devices through hplip.
//
// Windows' parts run as short PowerShell scripts so Inkleaf needs no native
// add-on. Each scan is one page, returned as an image for the renderer to
// turn into a PDF page.
//
// A scanner's id says which way to reach it: "wia:…", "twain:…", "escl:…" or "sane:…".

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EsclError, esclScan, findEsclScanners } from './escl';
import TWAIN_SOURCE from './twain.cs';

export interface Scanner { id: string; name: string }
export type ScanColor = 'color' | 'gray' | 'bw';
/** Where the paper is: on the glass, or a stack in the document feeder (one side or both). */
export type ScanSource = 'glass' | 'feeder' | 'duplex';
export interface ScanOptions { dpi: number; color: ScanColor; source: ScanSource }
/** The scanned pages, as image files, and the resolution they came at. */
export interface ScanResult { pages: Uint8Array[]; dpi: number }

/** Thrown with a sentence the person can act on. */
export class ScanError extends Error {}

type Relay = (s: string) => string;

const run = (file: string, args: string[], options: { timeout: number }) =>
  new Promise<{ stdout: Buffer; stderr: string }>((resolve, reject) => {
    execFile(file, args, { timeout: options.timeout, windowsHide: true, encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: stderr.toString() }));
      else resolve({ stdout, stderr: stderr.toString() });
    });
  });

const messages = {
  offline: (t: Relay) => t('The scanner isn’t answering. Check it’s switched on and connected, then try again.'),
  busy: (t: Relay) => t('The scanner is busy. Wait for it to finish, or close other apps that are using it, then try again.'),
  cancel: (t: Relay) => t('The scan was cancelled.'),
  nopaper: (t: Relay) => t('The scanner says there’s no paper. Put the page on the glass, or in the feeder, and try again.'),
  cover: (t: Relay) => t('The scanner’s cover is open or it isn’t ready. Close the lid, wait a moment, then try again.'),
  failed: (t: Relay) => t('The scanner didn’t send a page. Check it’s switched on and connected, then try again.'),
  nofeeder: (t: Relay) => t('This scanner doesn’t have a document feeder that Inkleaf can use. Put the page on the glass and pick Glass instead.'),
  noduplex: (t: Relay) => t('This scanner can’t scan both sides of a page. Pick Document feeder instead.'),
};

/** Scan files written to a folder as page-1, page-2…, in order. */
function readPages(dir: string): Uint8Array[] {
  return fs.readdirSync(dir)
    .map((f) => ({ f, n: Number(/^page-(\d+)\./.exec(f)?.[1]) }))
    .filter((p) => p.n > 0)
    .sort((a, b) => a.n - b.n)
    .map((p) => new Uint8Array(fs.readFileSync(path.join(dir, p.f))));
}

// --- Windows: PowerShell ---------------------------------------------------------------------

const windir = () => process.env.SystemRoot || process.env.windir || 'C:\\Windows';

/** PowerShell, given the script as UTF-16 base64 so nothing in it needs quoting. 32-bit when asked. */
function powershell(script: string, timeout: number, bits: 32 | 64 = 64) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n[Console]::OutputEncoding = [Text.Encoding]::UTF8\n${script}`, 'utf16le').toString('base64');
  // on 64-bit Windows the 32-bit PowerShell lives in SysWOW64
  const exe = bits === 32 && process.arch !== 'ia32'
    ? path.join(windir(), 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  return run(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout });
}

const psString = (value: string) => `'${value.replace(/'/g, "''")}'`;

// --- WIA --------------------------------------------------------------------------------------

const WIA_LIST = `
$manager = New-Object -ComObject WIA.DeviceManager
$found = @()
foreach ($info in $manager.DeviceInfos) {
  if ($info.Type -eq 1) { $found += [pscustomobject]@{ id = $info.DeviceID; name = $info.Properties.Item('Name').Value } }
}
ConvertTo-Json -Compress -InputObject @($found)
`;

// WIA property numbers: 6146 colour intent (1 colour, 2 greyscale, 4 black and
// white text), 6147 and 6148 horizontal and vertical resolution; on the
// device, 3088 picks the glass (2) or the feeder (1, plus 4 for both sides)
// and 3096 how many pages each scan takes.
const WIA_PAPER_EMPTY = -2145845245; // 0x80210003

const wiaScan = (id: string, dpi: number, color: ScanColor, source: ScanSource, dir: string) => `
$manager = New-Object -ComObject WIA.DeviceManager
$info = $null
foreach ($candidate in $manager.DeviceInfos) { if ($candidate.DeviceID -eq ${psString(id)}) { $info = $candidate } }
if (-not $info) { throw 'INKLEAF:gone' }
$device = $info.Connect()
function Set-WiaProperty($target, $id, $value) {
  foreach ($p in $target.Properties) { if ($p.PropertyID -eq $id) { try { $p.Value = $value; return $true } catch { return $false } } }
  return $false
}
function Get-Code($err) {
  $x = $err.Exception
  while ($x) { if ($x -is [System.Runtime.InteropServices.COMException]) { return $x.HResult }; $x = $x.InnerException }
  return 0
}
$feeder = ${source === 'glass' ? '$false' : '$true'}
if ($feeder) {
  if (-not (Set-WiaProperty $device 3088 ${source === 'duplex' ? 5 : 1})) { throw 'INKLEAF:${source === 'duplex' ? 'noduplex' : 'nofeeder'}' }
  [void](Set-WiaProperty $device 3096 1)
} else {
  [void](Set-WiaProperty $device 3088 2)
}
$item = $device.Items.Item(1)
[void](Set-WiaProperty $item 6146 ${color === 'color' ? 1 : color === 'gray' ? 2 : 4})
[void](Set-WiaProperty $item 6147 ${dpi})
[void](Set-WiaProperty $item 6148 ${dpi})
# JPEG keeps colour scans small; some drivers only hand over their own format
$jpeg = $true
$n = 0
while ($true) {
  try {
    if ($jpeg) {
      try { $image = $item.Transfer('{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}') }
      catch { if ((Get-Code $_) -eq ${WIA_PAPER_EMPTY}) { throw }; $jpeg = $false; $image = $item.Transfer() }
    } else { $image = $item.Transfer() }
  } catch {
    # the feeder running out after the first page is how a stack ends
    if ($n -gt 0 -and $feeder) { break }
    throw
  }
  $n++
  $image.SaveFile((Join-Path ${psString(dir)} ("page-" + $n + ".img")))
  if (-not $feeder) { break }
}
`;

/** Turns WIA's error numbers into something useful. */
function wiaMessage(text: string, t: Relay): string {
  // WIA's numbers show up in hex or as negative decimals, depending on where they came from
  const has = (...codes: number[]) => codes.some((c) => text.toLowerCase().includes(`0x${c.toString(16)}`) || text.includes(String(c - 0x100000000)));
  if (/INKLEAF:gone/.test(text) || has(0x80210015, 0x80210005, 0x8021000a)) return messages.offline(t);
  if (/INKLEAF:nofeeder/.test(text)) return messages.nofeeder(t);
  if (/INKLEAF:noduplex/.test(text)) return messages.noduplex(t);
  if (has(0x80210006, 0x80210007, 0x8021000d)) return messages.busy(t);
  if (has(0x80210064)) return messages.cancel(t);
  if (has(0x80210003)) return messages.nopaper(t);
  if (has(0x80210016, 0x80210008)) return messages.cover(t);
  if (/80040154|ComObject/i.test(text)) return t('Windows’ scanning service (WIA) isn’t available on this computer.');
  return messages.failed(t);
}

async function wiaList(): Promise<Scanner[]> {
  const { stdout } = await powershell(WIA_LIST, 30_000);
  const text = stdout.toString('utf8').trim();
  if (!text) return [];
  const parsed = JSON.parse(text) as Scanner | Scanner[];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((s) => s?.id).map((s) => ({ id: `wia:${s.id}`, name: s.name }));
}

async function wiaScanPages(id: string, o: ScanOptions, t: Relay): Promise<ScanResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-scan-'));
  try {
    await powershell(wiaScan(id, o.dpi, o.color, o.source, dir), 15 * 60_000);
    const pages = readPages(dir);
    if (!pages.length) throw new Error('none');
    return { pages, dpi: o.dpi };
  } catch (err) {
    throw new ScanError(wiaMessage(String((err as { stderr?: string }).stderr ?? err), t));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- TWAIN ------------------------------------------------------------------------------------

// The C# is compiled each time (a second or two); nothing is left behind.
const twainScript = (call: string) => `
Add-Type -TypeDefinition @'
${TWAIN_SOURCE}
'@
${call}
`;

/** Scanners Windows offers through TWAIN; ones that are really WIA in disguise are left to WIA. */
export function parseTwainList(output: string, bits: 32 | 64): Scanner[] {
  const found: Scanner[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [tag, legacy, name] = line.split('\t');
    if (tag !== 'SOURCE' || !name?.trim() || /^WIA-/i.test(name)) continue;
    found.push({ id: `twain:${bits}:${legacy === '1' ? 'L' : 'M'}:${name}`, name: name.trim() });
  }
  return found;
}

async function twainList(bits: 32 | 64): Promise<Scanner[]> {
  // the 64-bit TWAIN manager is only there if a 64-bit driver installed it
  if (bits === 64 && !fs.existsSync(path.join(windir(), 'System32', 'TWAINDSM.dll'))) return [];
  const call = bits === 32
    ? 'try { [Inkleaf.Twain]::List($true) } catch { [Inkleaf.Twain]::List($false) }'
    : '[Inkleaf.Twain]::List($false)';
  const { stdout } = await powershell(twainScript(call), 45_000, bits);
  return parseTwainList(stdout.toString('utf8'), bits);
}

async function twainScanPages(id: string, o: ScanOptions, t: Relay): Promise<ScanResult> {
  const m = /^(32|64):([LM]):(.*)$/s.exec(id);
  if (!m) throw new ScanError(messages.offline(t));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-scan-'));
  try {
    const call = `[Inkleaf.Twain]::Scan(${m[2] === 'L' ? '$true' : '$false'}, ${psString(m[3])}, ${o.dpi}, ${psString(o.color)}, ${psString(o.source)}, ${psString(dir)})`;
    const { stdout } = await powershell(twainScript(call), 16 * 60_000, m[1] === '32' ? 32 : 64);
    const result = stdout.toString('utf8').trim().split(/\r?\n/).pop() ?? '';
    const pages = readPages(dir);
    if (result.startsWith('OK') && pages.length) return { pages, dpi: o.dpi };
    const reason = result.split('\t')[1] as keyof typeof messages | undefined;
    throw new ScanError((reason && messages[reason] ? messages[reason] : messages.failed)(t));
  } catch (err) {
    if (err instanceof ScanError) throw err;
    throw new ScanError(messages.failed(t));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- Linux: SANE ------------------------------------------------------------------------------

/** `device 'hpaio:/usb/...' is a Hewlett-Packard HP_LaserJet_M1005 all-in-one` */
export function parseScanimageList(output: string): Scanner[] {
  const found: Scanner[] = [];
  for (const line of output.split('\n')) {
    const m = /^device [`'](.+?)' is a (.+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[2].replace(/\b(flatbed scanner|all-in-one|multi-function peripheral|virtual device)\b/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    found.push({ id: m[1], name: name || m[1] });
  }
  return found;
}

class SaneMissing extends Error {}

async function saneList(): Promise<Scanner[]> {
  try {
    const { stdout } = await run('scanimage', ['-L'], { timeout: 60_000 });
    return parseScanimageList(stdout.toString('utf8'))
      // network scanners SANE finds through its AirScan add-on are listed by Inkleaf's own eSCL
      .filter((s) => !/^(airscan|escl):/i.test(s.id))
      .map((s) => ({ id: `sane:${s.id}`, name: s.name }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SaneMissing();
    return [];
  }
}

/** The names this scanner's driver gives the feeder, read from its options. */
export function saneSources(help: string): { feeder?: string; duplex?: string } {
  const line = /--source\s+([^\n]*?)\s*\[/.exec(help)?.[1] ?? '';
  const names = line.split('|').map((n) => n.trim()).filter(Boolean);
  return {
    feeder: names.find((n) => /adf|feeder|automatic/i.test(n) && !/duplex|back/i.test(n)),
    duplex: names.find((n) => /duplex/i.test(n)),
  };
}

async function saneScanPages(id: string, o: ScanOptions, t: Relay): Promise<ScanResult> {
  const mode = o.color === 'color' ? 'Color' : o.color === 'gray' ? 'Gray' : 'Lineart';
  const args = ['-d', id, `--resolution=${o.dpi}`, `--mode=${mode}`];
  if (o.source !== 'glass') {
    const { stdout } = await run('scanimage', ['-d', id, '-A'], { timeout: 60_000 }).catch(() => ({ stdout: Buffer.alloc(0) }));
    const names = saneSources(stdout.toString('utf8'));
    const name = o.source === 'duplex' ? names.duplex : names.feeder;
    if (!name) throw new ScanError((o.source === 'duplex' && names.feeder ? messages.noduplex : messages.nofeeder)(t));
    // a stack: scanimage writes page-1.png, page-2.png… until the feeder is empty
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkleaf-scan-'));
    try {
      let stderr = '';
      try {
        await run('scanimage', [...args, `--source=${name}`, '--format=png', `--batch=${path.join(dir, 'page-%d.png')}`], { timeout: 15 * 60_000 });
      } catch (err) {
        stderr = String((err as { stderr?: string }).stderr ?? '');
      }
      const pages = readPages(dir);
      if (pages.length) return { pages, dpi: o.dpi };
      if (/busy/i.test(stderr)) throw new ScanError(messages.busy(t));
      throw new ScanError(/out of documents|no (more )?doc|empty/i.test(stderr) || !stderr ? messages.nopaper(t) : messages.failed(t));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  try {
    const { stdout } = await run('scanimage', [...args, '--format=png'], { timeout: 5 * 60_000 });
    if (!stdout.length) throw new Error('empty');
    return { pages: [new Uint8Array(stdout)], dpi: o.dpi };
  } catch (err) {
    const text = String((err as { stderr?: string }).stderr ?? '');
    if (/busy/i.test(text)) throw new ScanError(messages.busy(t));
    // some drivers name their modes differently; colour always works
    if (/mode/i.test(text) && mode !== 'Color') return saneScanPages(id, { ...o, color: 'color' }, t);
    throw new ScanError(messages.failed(t));
  }
}

// --- eSCL -------------------------------------------------------------------------------------

async function esclList(): Promise<Scanner[]> {
  return (await findEsclScanners()).map((s) => ({ id: `escl:${s.url}`, name: s.name }));
}

async function esclScanPages(url: string, o: ScanOptions, t: Relay): Promise<ScanResult> {
  try {
    return await esclScan(url, o.dpi, o.color, o.source);
  } catch (err) {
    throw new ScanError((err instanceof EsclError ? messages[err.reason] : messages.failed)(t));
  }
}

// --- all of them ------------------------------------------------------------------------------

export function scanningSupported(): boolean {
  return process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin';
}

const LABEL: Record<string, string> = { wia: 'WIA', twain: 'TWAIN', escl: 'eSCL', sane: '' };

/**
 * Every scanner that can be reached now, through any of the ways above. Can
 * take a few seconds while devices wake up. One way failing doesn't hide the
 * others; if nothing is found and a way failed, that's what's reported.
 */
export async function listScanners(t: Relay): Promise<Scanner[]> {
  const ways: [string, Promise<Scanner[]>][] = [];
  if (process.platform === 'win32') {
    ways.push(['wia', wiaList()], ['twain', twainList(32)], ['twain', twainList(64)]);
  }
  if (process.platform === 'linux') ways.push(['sane', saneList()]);
  ways.push(['escl', esclList()]);

  const results = await Promise.allSettled(ways.map(([, p]) => p));
  const found: Scanner[] = [];
  let problem: unknown = null;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') found.push(...r.value);
    else if (!problem || ways[i][0] === 'wia' || r.reason instanceof SaneMissing) problem = r.reason;
  });

  // the same scanner reached two ways gets its way named, so the two can be told apart
  const counts = new Map<string, number>();
  for (const s of found) counts.set(s.name.toLowerCase(), (counts.get(s.name.toLowerCase()) ?? 0) + 1);
  const named = found.map((s) => {
    const label = LABEL[s.id.split(':')[0]];
    return (counts.get(s.name.toLowerCase()) ?? 0) > 1 && label ? { ...s, name: `${s.name} (${label})` } : s;
  });
  if (named.length || !problem) return named;

  if (problem instanceof SaneMissing) {
    throw new ScanError(t('Scanning needs SANE. Install the “sane-utils” package (on Fedora, “sane-backends”), and “hplip” for HP printers, then try again.'));
  }
  throw new ScanError(wiaMessage(String((problem as { stderr?: string }).stderr ?? problem), t));
}

export const RESOLUTIONS = [75, 100, 150, 200, 300, 400, 600];

/** Scans one page from the glass, or every page in the feeder. Images are JPEG, PNG or BMP. */
export async function scanPages(id: string, options: Partial<ScanOptions>, t: Relay): Promise<ScanResult> {
  const o: ScanOptions = {
    dpi: RESOLUTIONS.includes(Number(options.dpi)) ? Number(options.dpi) : 200,
    color: options.color === 'gray' || options.color === 'bw' ? options.color : 'color',
    source: options.source === 'feeder' || options.source === 'duplex' ? options.source : 'glass',
  };
  const colon = id.indexOf(':');
  const way = id.slice(0, colon);
  const rest = id.slice(colon + 1);
  if (way === 'wia' && process.platform === 'win32') return wiaScanPages(rest, o, t);
  if (way === 'twain' && process.platform === 'win32') return twainScanPages(rest, o, t);
  if (way === 'sane' && process.platform === 'linux') return saneScanPages(rest, o, t);
  if (way === 'escl') return esclScanPages(rest, o, t);
  throw new ScanError(t('Scanning from a scanner isn’t available on this computer yet.'));
}
