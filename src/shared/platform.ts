// SPDX-License-Identifier: GPL-3.0-or-later
// What the app is running on. The desktop app and the phone apps share the
// same editor; the phone bridge (src/mobile/bridge.ts) says it's a phone,
// which commands it can't offer there, and where language packs live.

interface Host {
  mobile?: boolean;
  unsupported?: string[];
  packBase?: string;
}

const host = (): Host => (globalThis as { inkleaf?: Host }).inkleaf ?? {};

/** True in the Android and iPhone apps. */
export const isMobile = (): boolean => !!host().mobile;

/** False for commands this device can't do (opening a new window on a phone, say). */
export const supports = (command: string): boolean => !(host().unsupported ?? []).includes(command);

/** Address of a language pack file (an OCR model or a font) for fetch(). */
export const packUrl = (name: string): string => (host().packBase ?? './packs/') + name;
