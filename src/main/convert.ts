// SPDX-License-Identifier: GPL-3.0-or-later
// The parts of file conversion that need the main process:
//
// - LibreOffice. If it's installed, Word, Excel and PowerPoint files (and
//   their OpenDocument cousins) are converted with it, which keeps their
//   layout exactly. It runs headless with its own throwaway profile, so it
//   never disturbs a LibreOffice window the user has open.
// - HTML to PDF. The renderer turns documents into HTML when LibreOffice
//   isn't available; this prints that HTML to a PDF in a hidden window that
//   can't run scripts or reach the network.

import { t } from '../shared/i18n';
import { app, BrowserWindow, session } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Formats LibreOffice can turn into a PDF. */
export const OFFICE_FORMATS = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'];

let officePath: string | null | undefined;

function onPath(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Where LibreOffice's command-line program is, or null if it isn't installed. */
export function findOffice(): string | null {
  if (officePath !== undefined) return officePath;
  // lets the tests try the built-in converters on a machine that has it
  if (!app.isPackaged && process.env.INKLEAF_NO_OFFICE) return (officePath = null);
  const candidates = process.platform === 'win32'
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'C:\\Program Files (x86)']
        .filter(Boolean).map((dir) => path.join(dir!, 'LibreOffice', 'program', 'soffice.exe'))
    : process.platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice', path.join(os.homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice')]
      : ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice'];
  officePath = candidates.find((c) => existsSync(c)) ?? onPath('soffice') ?? onPath('libreoffice') ?? null;
  return officePath;
}

function run(file: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error((err as NodeJS.ErrnoException).code === 'ETIMEDOUT' || err.killed ? t('LibreOffice took too long.') : (stderr || err.message).trim()));
      else resolve();
    });
  });
}

/** Converts an office document to PDF with LibreOffice. */
export async function officeToPdf(name: string, data: Uint8Array): Promise<Uint8Array> {
  const soffice = findOffice();
  if (!soffice) throw new Error(t('LibreOffice isn’t installed.'));
  const ext = path.extname(name).toLowerCase().slice(1);
  if (!OFFICE_FORMATS.includes(ext)) throw new Error(t('.{ext} files can’t be converted with LibreOffice.', { ext }));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'inkleaf-convert-'));
  try {
    // a plain file name: LibreOffice and some shells dislike unusual characters
    const input = path.join(work, `document.${ext}`);
    await fs.writeFile(input, data);
    const profile = pathToFileURL(path.join(app.getPath('userData'), 'LibreOfficeProfile')).href;
    await run(soffice, [
      `-env:UserInstallation=${profile}`,
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nologo',
      '--convert-to', 'pdf', '--outdir', work, input,
    ], 180_000);
    const output = path.join(work, 'document.pdf');
    if (!existsSync(output)) throw new Error(t('LibreOffice didn’t produce a PDF. The file may be damaged or password-protected.'));
    return new Uint8Array(await fs.readFile(output));
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export interface HtmlPage {
  /** Page size in inches; A4 when missing. */
  width?: number;
  height?: number;
  landscape?: boolean;
  /** Margins in inches; about 2 cm when missing. */
  margin?: number;
}

/**
 * Prints HTML to a PDF. The page can only show what's inside it: scripts are
 * off and every request other than the page itself and inline data is
 * refused, so a converted document can't phone home.
 */
export async function htmlToPdf(html: string, page: HtmlPage = {}): Promise<Uint8Array> {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'inkleaf-html-'));
  const file = path.join(work, 'page.html');
  await fs.writeFile(file, html, 'utf8');
  const target = pathToFileURL(file).href;
  const ses = session.fromPartition('inkleaf-convert');
  ses.webRequest.onBeforeRequest((details, done) => done({ cancel: !(details.url === target || details.url.startsWith('data:')) }));
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, session: ses, images: true, spellcheck: false },
  });
  try {
    await win.loadURL(target);
    const margin = page.margin ?? 0.8;
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: !!page.landscape,
      pageSize: page.width && page.height ? { width: page.width, height: page.height } : 'A4',
      margins: { top: margin, bottom: margin, left: margin, right: margin },
      preferCSSPageSize: true,
    });
    return new Uint8Array(pdf);
  } finally {
    win.destroy();
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Prints a web page from the internet to a PDF. It loads in its own private
 * session (no cookies or logins from anywhere else), with scripts on so
 * modern pages render, but it can't open windows or navigate away from
 * ordinary web addresses.
 */
export async function urlToPdf(address: string, page: HtmlPage = {}): Promise<{ pdf: Uint8Array; title: string }> {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`);
  } catch {
    throw new Error(t('That doesn’t look like a web address.'));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(t('Only web addresses (http or https) can be printed.'));

  const ses = session.fromPartition(`inkleaf-web-${Date.now()}`);
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 1600,
    webPreferences: { javascript: true, sandbox: true, session: ses, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, next) => {
    if (!/^https?:/i.test(next)) event.preventDefault();
  });
  try {
    await Promise.race([
      win.loadURL(url.href),
      new Promise((_, reject) => setTimeout(() => reject(new Error(t('The page took too long to load.'))), 45_000)),
    ]);
    // give late pictures and fonts a moment
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const margin = page.margin ?? 0.4;
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: !!page.landscape,
      pageSize: 'A4',
      margins: { top: margin, bottom: margin, left: margin, right: margin },
    });
    return { pdf: new Uint8Array(pdf), title: win.webContents.getTitle() || url.hostname };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION/i.test(message)) throw new Error(t('Couldn’t reach that page. Check the address and your internet connection.'));
    throw err;
  } finally {
    win.destroy();
    await ses.clearStorageData().catch(() => {});
  }
}
