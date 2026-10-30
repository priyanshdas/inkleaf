// Moves the files in this folder to where they belong in the Android
// project, then removes the folder. Run it once from D:\inkleaf:
//
//   node android-update/place.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const app = path.join(root, 'mobile/android/app/src/main/java/io/github/priyanshdas/inkleaf');
const ui = path.join(root, 'mobile/android/ui/src/main/java/io/github/priyanshdas/inkleaf/ui');

const places = {
  'MainActivity.kt': app,
  'InkleafFilesPlugin.java': app,
  'InkleafAi.kt': app,
  'InkleafAiPlugin.kt': app,
  'ToolsScreen.kt': ui,
  'OtherScreens.kt': ui,
  'ReaderScreen.kt': ui,
};

for (const [name, folder] of Object.entries(places)) {
  const from = path.join(here, name);
  if (!fs.existsSync(from)) continue;
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(from, path.join(folder, name));
  console.log(`${name} -> ${path.relative(root, folder)}`);
}

fs.rmSync(here, { recursive: true, force: true });
console.log('Done. This folder has been removed.');
