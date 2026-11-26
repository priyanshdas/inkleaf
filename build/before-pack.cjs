// SPDX-License-Identifier: GPL-3.0-or-later
// Runs before electron-builder packs the app ("beforePack" in package.json).
// Windows builds (installer, portable and Microsoft Store) get File
// Explorer's PDF thumbnail maker and previewer, and PDFium (scripts/thumbnails.mjs),
// and the installer gets its list of AI models (scripts/installer-ai.mjs).

const path = require('node:path');
const { pathToFileURL } = require('node:url');

module.exports = async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const { prepareThumbnails } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'thumbnails.mjs')).href);
  await prepareThumbnails();
  // the installer's list of AI models, from the app's own (scripts/installer-ai.mjs)
  const fs = require('node:fs');
  const { installerAi } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'installer-ai.mjs')).href);
  fs.writeFileSync(path.join(__dirname, 'installer-ai.nsh'), installerAi());
};
