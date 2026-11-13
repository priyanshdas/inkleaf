// SPDX-License-Identifier: GPL-3.0-or-later
// Adds to the Microsoft Store package's manifest what electron-builder
// doesn't write itself (it runs this once the manifest is made, through
// "appxManifestCreated" in package.json):
//
// - File Explorer's preview pane for PDFs. A packaged app can't add one with
//   the registry like the installed copy does (src/main/default-app.ts), so
//   the package names Windows' own PDF previewer (the one Microsoft Edge
//   installs) for Inkleaf's PDF type.
// - Thumbnails of PDFs in File Explorer: Inkleaf's own thumbnail maker
//   (native/thumbnails), declared as a COM class in the package and named
//   as the thumbnail handler for PDFs.
// - Starting at sign-in. A packaged app needs a startup task in its
//   manifest; it starts switched off, and Settings in Inkleaf switches it on
//   (src/main/desktop.ts). It's started with --hidden, so it waits in the tray.

const fs = require('node:fs');

/** Inkleaf's thumbnail maker (native/thumbnails/inkleaf-thumbs.cpp). */
const INKLEAF_THUMBNAILS = '{1EBEB7F8-27A7-4B2A-A890-88C35591D436}';
/** Edge's PDF preview handler; the same one default-app.ts falls back on. */
const EDGE_PDF_PREVIEW = '{3A84F9C2-6164-485C-A7D9-4B27F8AC009E}';

module.exports = function addToManifest(manifestPath) {
  let xml = fs.readFileSync(manifestPath, 'utf8');

  const namespaces = {
    desktop2: 'http://schemas.microsoft.com/appx/manifest/desktop/windows10/2',
    uap10: 'http://schemas.microsoft.com/appx/manifest/uap/windows10/10',
    com: 'http://schemas.microsoft.com/appx/manifest/com/windows10',
  };
  for (const [prefix, uri] of Object.entries(namespaces)) {
    if (!xml.includes(`xmlns:${prefix}=`)) xml = xml.replace('<Package', `<Package\n   xmlns:${prefix}="${uri}"`);
  }
  // newer parts of the manifest are skipped by Windows versions that don't know them
  const ignorable = 'IgnorableNamespaces="uap desktop desktop2 uap10 com rescap"';
  xml = /IgnorableNamespaces="[^"]*"/.test(xml) ? xml.replace(/IgnorableNamespaces="[^"]*"/, ignorable) : xml.replace('<Package', `<Package ${ignorable}`);

  const executable = /<Application [^>]*Executable="([^"]+)"/.exec(xml)?.[1];
  if (!executable) throw new Error('appx-manifest.js: no Executable on the Application');

  // the preview pane and thumbnails, on the PDF file type
  const pdfType = /(<uap:FileTypeAssociation Name="pdf">[\s\S]*?<\/uap:SupportedFileTypes>)/;
  if (!pdfType.test(xml)) throw new Error('appx-manifest.js: no file type association for PDFs in the manifest');
  if (!xml.includes('desktop2:DesktopPreviewHandler')) {
    xml = xml.replace(pdfType, `$1\n              <desktop2:ThumbnailHandler Clsid="${INKLEAF_THUMBNAILS}" />\n              <desktop2:DesktopPreviewHandler Clsid="${EDGE_PDF_PREVIEW}" />`);
  }

  // the thumbnail maker itself: Explorer loads it in a separate process (a COM surrogate)
  const folder = executable.includes('\\') ? executable.slice(0, executable.lastIndexOf('\\') + 1) : '';
  if (!xml.includes('windows.comServer')) {
    xml = xml.replace('<Extensions>', `<Extensions>
        <com:Extension Category="windows.comServer">
          <com:ComServer>
            <com:SurrogateServer DisplayName="Inkleaf PDF thumbnails">
              <com:Class Id="${INKLEAF_THUMBNAILS.slice(1, -1)}" Path="${folder}resources\\thumbnails\\inkleaf-thumbs.dll" ThreadingModel="STA" />
            </com:SurrogateServer>
          </com:ComServer>
        </com:Extension>`);
  }

  // the startup task, switched off until the person turns it on
  if (!xml.includes('windows.startupTask')) {
    xml = xml.replace('</Extensions>', `
        <desktop:Extension Category="windows.startupTask" Executable="${executable}" EntryPoint="Windows.FullTrustApplication" uap10:Parameters="--hidden">
          <desktop:StartupTask TaskId="InkleafStartup" Enabled="false" DisplayName="Inkleaf" />
        </desktop:Extension>
      </Extensions>`);
  }

  fs.writeFileSync(manifestPath, xml);
};
