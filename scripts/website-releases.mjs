// SPDX-License-Identifier: GPL-3.0-or-later
// Fills in the website's "What's new" page with the latest release notes
// from GitHub, and puts the newest version number on the home and download
// pages. The website workflow runs it just before publishing:
//
//   GH_TOKEN=... node scripts/website-releases.mjs
//
// Release notes are written once, on the GitHub release, and show up here by
// themselves. If GitHub can't be reached, the pages stay as they are and the
// site still publishes.
//
// For a quick look without GitHub, pass a saved copy of the API's answer:
//   node scripts/website-releases.mjs releases.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website');
const REPO = 'priyanshdas/inkleaf-releases';
const SHOWN = 8;

const headers = { Accept: 'application/vnd.github.html+json', 'User-Agent': 'inkleaf-website' };
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Replaces what's between <!-- name --> and <!-- /name --> in a page, everywhere it appears. */
function fill(file, name, content) {
  const page = path.join(site, file);
  let html = fs.readFileSync(page, 'utf8');
  const start = `<!-- ${name} -->`, end = `<!-- /${name} -->`;
  let from = 0, changed = false;
  for (;;) {
    const a = html.indexOf(start, from), b = html.indexOf(end, a);
    if (a < 0 || b < 0) break;
    html = html.slice(0, a + start.length) + content + html.slice(b);
    from = a + start.length + content.length + end.length;
    changed = true;
  }
  if (!changed) throw new Error(`${file} has no <!-- ${name} --> markers`);
  fs.writeFileSync(page, html);
}

async function main() {
  const all = process.argv[2]
    ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
    : await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=20`, { headers }).then((r) => {
      if (!r.ok) throw new Error(`GitHub said ${r.status}`);
      return r.json();
    });
  const releases = all.filter((r) => !r.draft && !r.prerelease).slice(0, SHOWN);
  if (!releases.length) throw new Error('GitHub gave back no releases');

  const version = (r) => String(r.tag_name || r.name).replace(/^v/i, '');
  const date = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const eol = '\n';
  const items = releases.map((r, i) => [
    '    <article class="release">',
    `      <div class="release-meta"><h2>${escape(version(r))}</h2><time datetime="${escape(r.published_at)}">${date(r.published_at)}</time>${i === 0 ? '<br><span class="latest">Latest</span>' : ''}</div>`,
    // GitHub's own rendering of the notes, already cleaned of anything unsafe
    `      <div class="release-body">${r.body_html || `<p><a href="${escape(r.html_url)}">Release notes on GitHub</a></p>`}</div>`,
    '    </article>',
  ].join(eol));

  fill(path.join('releases', 'index.html'), 'releases', `${eol}${items.join(eol)}${eol}    `);
  const latest = escape(version(releases[0]));
  // the version search engines read, on the home page
  const home = path.join(site, 'index.html');
  fs.writeFileSync(home, fs.readFileSync(home, 'utf8').replace(/("softwareVersion": ")[^"]*(")/, `$1${latest}$2`));
  fill(path.join('download', 'index.html'), 'version', latest);
  console.log(`Releases: ${releases.map(version).join(', ')}`);
}

main().catch((err) => {
  // never stop the site from publishing over this
  console.warn(`Release notes left as they were: ${err.message}`);
});
