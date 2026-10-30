// SPDX-License-Identifier: GPL-3.0-or-later
// Update check for the phone app. The APK from GitHub can't replace itself the
// way the computer app does, so this only looks: once a day, and whenever
// someone taps Check for updates, it asks GitHub for the newest release and,
// if it's newer than this one, the editor offers to download it. Android then
// installs it over this version, keeping everything.
//
// Copies installed from an app store are updated by the store, so they don't
// check at all.

import { CapacitorHttp } from '@capacitor/core';
import type { UpdateState } from '../shared/api';

const LATEST = 'https://api.github.com/repos/priyanshdas/inkleaf-releases/releases/latest';
const RELEASES = 'https://github.com/priyanshdas/inkleaf-releases/releases/latest';
const DAY = 24 * 60 * 60 * 1000;

/** Compares "3.0.10" with "3.0.9" the way people expect. */
export function newer(candidate: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

interface Store {
  get<T>(key: string, fallback: T): T;
  set(key: string, value: unknown): void;
}

/**
 * Checks GitHub. `manual` reports every outcome ("up to date", errors);
 * the daily check only speaks up when there's something new.
 */
export async function checkPhoneUpdates(options: {
  current: string;
  manual: boolean;
  store: Store;
  fromStore: boolean;
  report: (state: UpdateState) => void;
  relayT: (text: string) => string;
}) {
  const { current, manual, store, report, relayT } = options;
  if (options.fromStore) {
    if (manual) report({ state: 'unavailable', reason: relayT('This copy of Inkleaf came from an app store, which keeps it up to date.') });
    return;
  }
  if (!manual && Date.now() - store.get<number>('update-checked', 0) < DAY) return;
  if (manual) report({ state: 'checking' });
  try {
    const response = await CapacitorHttp.get({ url: LATEST, headers: { accept: 'application/vnd.github+json' }, connectTimeout: 15_000, readTimeout: 15_000 });
    if (response.status < 200 || response.status >= 300) throw new Error(`GitHub (${response.status})`);
    const release = (typeof response.data === 'string' ? JSON.parse(response.data) : response.data) as {
      tag_name?: string; assets?: { name: string; browser_download_url: string }[];
    };
    store.set('update-checked', Date.now());
    const version = String(release.tag_name ?? '').replace(/^v/i, '');
    const apk = release.assets?.find((a) => a.name === 'Inkleaf-Android.apk');
    if (!version || !apk || !newer(version, current)) {
      if (manual) report({ state: 'none' });
      return;
    }
    // the daily check mentions each new version once; a manual check always does
    if (!manual && store.get('update-offered', '') === version) return;
    store.set('update-offered', version);
    report({ state: 'available', version, url: apk.browser_download_url, page: RELEASES });
  } catch (err) {
    if (manual) report({ state: 'error', message: String((err as Error)?.message ?? err) });
  }
}
