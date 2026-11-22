// SPDX-License-Identifier: GPL-3.0-or-later
// Fills in the contributors list on the website with everyone who has
// committed to InkLeaf PDF, from GitHub. The website workflow runs it just
// before publishing:
//
//   GH_TOKEN=... node scripts/website-contributors.mjs
//
// Profile pictures are saved next to the page, so visitors' browsers never
// have to ask GitHub for them. Bots are left out. If GitHub can't be reached
// the list already in index.html stays as it is and the site still publishes.
//
// For a quick look without GitHub, pass a saved copy of the API's answer:
//   node scripts/website-contributors.mjs contributors.json

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website');
const page = path.join(site, 'index.html');
const pictures = path.join(site, 'contributors');
const REPO = 'priyanshdas/inkleaf';

const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'inkleaf-website' };
if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;

async function api(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Saves a small copy of someone's GitHub picture; null if it can't be fetched. */
async function savePicture(person) {
  if (!person.avatar_url) return null;
  try {
    const url = new URL(person.avatar_url);
    url.searchParams.set('s', '96');
    const res = await fetch(url, { headers: { 'User-Agent': headers['User-Agent'] } });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : 'jpg';
    const file = `${person.login.toLowerCase().replace(/[^a-z0-9-]/g, '')}.${ext}`;
    fs.mkdirSync(pictures, { recursive: true });
    fs.writeFileSync(path.join(pictures, file), Buffer.from(await res.arrayBuffer()));
    return `contributors/${file}`;
  } catch {
    return null;
  }
}

async function main() {
  const people = process.argv[2]
    ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
    : await api(`https://api.github.com/repos/${REPO}/contributors?per_page=100`);

  const humans = people.filter((p) => p.type === 'User' && !/\[bot\]$/i.test(p.login));
  if (!humans.length) throw new Error('GitHub gave back no contributors');

  const items = [];
  for (const person of humans) {
    // the contributors list only has usernames; the profile has the real name, if they set one
    let name = person.name ?? null;
    if (!name && !process.argv[2]) name = (await api(`https://api.github.com/users/${person.login}`).catch(() => ({}))).name ?? null;
    const picture = await savePicture(person);
    const commits = person.contributions === 1 ? '1 commit' : `${person.contributions} commits`;
    const face = picture
      ? `<img src="${picture}" alt="" width="48" height="48" loading="lazy">`
      : `<span class="contributor-initial" aria-hidden="true">${escape((name || person.login)[0].toUpperCase())}</span>`;
    items.push(
      `        <li><a href="https://github.com/${escape(person.login)}">${face}`
      + `<span class="contributor-name">${escape(name || person.login)}</span>`
      + `<span class="contributor-meta">${name && name !== person.login ? `@${escape(person.login)} · ` : ''}${commits}</span></a></li>`,
    );
  }

  const html = fs.readFileSync(page, 'utf8');
  const start = '<!-- contributors -->', end = '<!-- /contributors -->';
  const a = html.indexOf(start), b = html.indexOf(end);
  if (a < 0 || b < a) throw new Error('index.html has no <!-- contributors --> markers');
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const filled = html.slice(0, a + start.length) + eol + items.join(eol) + eol + '        ' + html.slice(b);
  fs.writeFileSync(page, filled);
  console.log(`Contributors: ${humans.map((p) => p.login).join(', ')}`);
}

main().catch((err) => {
  // never stop the site from publishing over this
  console.warn(`Contributors list left as it was: ${err.message}`);
});
