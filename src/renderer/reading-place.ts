// SPDX-License-Identifier: GPL-3.0-or-later
// The page you were on in each PDF, so it opens there again: after closing
// its tab, opening it from Recent Files, double-clicking it next week, or
// opening it from another app (calibre's "View", say).
//
// Each file is remembered by where it is and by its PDF fingerprint, the ID
// every PDF carries, so a copy that another app hands over from a temporary
// folder still finds its page. Kept on this device only, for the last 200 files.

const KEY = 'inkleaf.readingPlace';
const KEEP = 200;

type Places = Record<string, { page: number; at: number }>;

function load(): Places {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Places;
  } catch {
    return {};
  }
}

const keysFor = (path: string | null, fingerprint: string | null) =>
  [path ? `path:${path}` : null, fingerprint ? `id:${fingerprint}` : null].filter((k): k is string => !!k);

/** Remembers the page (counted from 0) a file was on. Page 0 just forgets it. */
export function rememberPage(path: string | null, fingerprint: string | null, page: number) {
  const keys = keysFor(path, fingerprint);
  if (!keys.length) return;
  const places = load();
  for (const key of keys) {
    if (page > 0) places[key] = { page, at: Date.now() };
    else delete places[key];
  }
  // only the most recent ones, so this never grows without end
  const kept = Object.entries(places).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP * 2);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage full or switched off: it just won't be remembered
  }
}

/** The page to open a file on, or 0 for the first page. */
export function lastPage(path: string | null, fingerprint: string | null): number {
  const places = load();
  // the newest of what's known about it, by place or by fingerprint
  const found = keysFor(path, fingerprint).map((k) => places[k]).filter(Boolean).sort((a, b) => b.at - a.at)[0];
  return found && Number.isInteger(found.page) && found.page > 0 ? found.page : 0;
}
