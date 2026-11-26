// SPDX-License-Identifier: GPL-3.0-or-later
// "Get started": the built-in AI offered once, the first time InkLeaf opens.
//
// The Windows installer asks about the AI models itself (build/installer.nsh).
// Everywhere else (the Microsoft Store, the portable build, Linux, macOS)
// there's no installer page to ask on, so the app asks instead, with the same
// choices: a list of the models, what each is good for, how big it is and how
// much memory it wants, and a tick to download any of them. It doesn't show
// if a model is already downloaded (by the installer, say), and once it's
// been answered it stays away. Help › Get Started brings it back.

import { t } from '../shared/i18n';
import { DEFAULT_LOCAL_MODEL, LOCAL_MODELS, LocalAiEvent, LocalModel } from '../shared/local-models';
import type { InkleafApi } from '../shared/api';
import { h, isModalOpen, modal, toast } from './ui';

const DONE_KEY = 'inkleaf.getStarted';

const gb = (bytes: number) => (bytes / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 });
const size = (bytes: number) => (bytes >= 1e9 ? t('{n} GB', { n: gb(bytes) }) : t('{n} MB', { n: Math.max(1, Math.round(bytes / 1e6)).toLocaleString() }));

function markDone() {
  try {
    localStorage.setItem(DONE_KEY, '1');
  } catch {
    // private storage: it may ask again next time, which is harmless
  }
}

function answered(): boolean {
  try {
    return !!localStorage.getItem(DONE_KEY);
  } catch {
    return true;
  }
}

/** On start-up: offers the built-in AI if it's never been offered and none is downloaded yet. */
export async function maybeGetStarted(api: InkleafApi, store: boolean) {
  if (answered() || !api.localAiDownload) return;
  const status = await api.aiStatus().catch(() => null);
  const local = status?.local;
  if (!local?.supported) return;
  if (local.installed.length) {
    markDone();
    return;
  }
  // let whatever opened with the app (a file, a message) settle first
  for (let i = 0; i < 20 && isModalOpen(); i++) await new Promise((r) => setTimeout(r, 500));
  if (isModalOpen()) return;
  await getStarted(api, store);
}

/** The Get Started dialog: pick models, then download them with progress. */
export async function getStarted(api: InkleafApi, store: boolean) {
  const status = await api.aiStatus();
  const local = status.local;
  if (!local?.supported || !api.localAiDownload) {
    toast(t('The built-in AI doesn’t run on this kind of computer.'), 'info', 5000);
    return;
  }
  const installed = new Set(local.installed);
  const wanted = new Set<string>();

  const select = h('select', { class: 'field-select', 'aria-label': t('Model') }) as HTMLSelectElement;
  for (const m of LOCAL_MODELS) select.append(new Option(`${t(m.name)} (${size(local.sizes[m.id] ?? m.size)})`, m.id));
  select.value = DEFAULT_LOCAL_MODEL;

  const details = h('div', { class: 'get-started-details' });
  const tick = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const tickText = h('span');
  const tickRow = h('label', { class: 'check get-started-tick' }, tick, tickText);
  const total = h('p', { class: 'field-hint get-started-total' });

  const model = () => LOCAL_MODELS.find((m) => m.id === select.value) ?? LOCAL_MODELS[0];

  function draw() {
    const m = model();
    details.replaceChildren(
      h('p', {}, t(m.blurb)),
      h('dl', { class: 'facts' },
        h('dt', {}, t('Download')), h('dd', {}, size(local!.sizes[m.id] ?? m.size)),
        h('dt', {}, t('Memory')), h('dd', {}, t('{n} GB or more is best', { n: Math.round(m.memory / 1e9) })),
        h('dt', {}, t('Model')), h('dd', {}, `${m.file.replace(/-Q\d.*$/, '')} · Apache 2.0`),
      ),
    );
    if (installed.has(m.id)) {
      tick.checked = true;
      tick.disabled = true;
      tickText.textContent = t('Already downloaded');
    } else {
      tick.disabled = false;
      tick.checked = wanted.has(m.id);
      tickText.textContent = t('Download this model');
    }
    const picked = LOCAL_MODELS.filter((x) => wanted.has(x.id));
    // each size from status includes the AI engine while it's not downloaded
    // yet; count the engine once
    const left = (x: LocalModel) => local!.sizes[x.id] ?? x.size;
    const engine = Math.max(0, ...picked.map((x) => left(x) - x.size));
    const bytes = picked.reduce((sum, x) => sum + Math.min(left(x), x.size), 0) + engine;
    total.textContent = picked.length
      ? t('Will download: {names} ({size} in all).', { names: picked.map((x) => t(x.name)).join(', '), size: size(bytes) })
      : t('Nothing is ticked yet. You can add AI models any time from Tools › AI Settings.');
  }
  select.addEventListener('change', draw);
  tick.addEventListener('change', () => {
    if (tick.checked) wanted.add(select.value);
    else wanted.delete(select.value);
    draw();
  });
  draw();

  const body = h('div', { class: 'get-started' },
    h('p', {}, t('InkLeaf PDF can summarise, translate and answer questions about your PDFs with AI that runs on this computer: no account, and your files never leave it.')),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, t('Model')), select),
    details,
    tickRow,
    total,
    store ? h('p', { class: 'field-hint' }, t('Tip: InkLeaf PDF is in your Start menu. To keep it on the taskbar, right-click it there and choose Pin to taskbar.')) : null,
  );

  const choice = await modal({
    title: t('Get started with InkLeaf PDF'),
    body,
    wide: true,
    dismissValue: 'skip',
    buttons: [
      { label: t('Skip'), value: 'skip' },
      { label: t('Download'), value: 'download', primary: true },
    ],
  });
  markDone();
  const picked = LOCAL_MODELS.filter((m) => wanted.has(m.id) && !installed.has(m.id));
  if (choice !== 'download' || !picked.length) return;
  await downloadAll(api, picked, !status.ready || status.provider === 'builtin');
}

/** Downloads the models one after another, in a dialog showing how far each has got. */
async function downloadAll(api: InkleafApi, models: LocalModel[], useWhenDone: boolean) {
  const rows = new Map<string, { bar: HTMLElement; meter: HTMLElement; state: HTMLElement }>();
  const list = h('div', { class: 'get-started-progress' }, ...models.map((m) => {
    const bar = h('span', { style: 'width:0%' });
    const meter = h('span', { class: 'meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': t(m.name) }, bar);
    const state = h('span', { class: 'get-started-state' }, t('Waiting'));
    rows.set(m.id, { bar, meter, state });
    return h('div', { class: 'get-started-row' }, h('strong', {}, t(m.name)), meter, state);
  }));
  const note = h('p', { class: 'field-hint' }, t('You can keep working while it downloads. A download that’s stopped carries on from where it got to next time.'));

  let stopped = false;
  let closeDialog: (value: string) => void = () => {};
  const dialog = modal({
    title: t('Downloading the built-in AI'),
    body: h('div', {}, list, note),
    dismissValue: 'stop',
    buttons: [{ label: t('Stop'), value: 'stop' }],
    onOpen: (close) => (closeDialog = close),
  });
  void dialog.then((value) => {
    if (value === 'stop') {
      stopped = true;
      void api.localAiCancelDownload?.();
    }
  });

  const done: string[] = [];
  const failed: string[] = [];
  for (const m of models) {
    if (stopped) break;
    const row = rows.get(m.id)!;
    row.state.textContent = t('Starting…');
    const result = await new Promise<LocalAiEvent>((resolve) => {
      const off = api.onLocalAiEvent?.((event) => {
        if (event.id !== m.id) return;
        if (event.type === 'progress') {
          const percent = Math.round((event.received / Math.max(1, event.total)) * 100);
          row.bar.style.width = `${percent}%`;
          row.meter.setAttribute('aria-valuenow', String(percent));
          row.state.textContent = `${size(event.received)} / ${size(event.total)}`;
          return;
        }
        off?.();
        resolve(event);
      });
      void api.localAiDownload!(m.id);
    });
    if (result.type === 'done') {
      done.push(m.id);
      row.bar.style.width = '100%';
      row.state.textContent = t('Downloaded');
    } else {
      if (result.type === 'failed' && result.message) failed.push(`${t(m.name)}: ${result.message}`);
      row.state.textContent = stopped ? t('Stopped') : t('Didn’t download');
    }
  }
  if (!stopped) closeDialog('done');

  if (done.length && useWhenDone) {
    // use the first one downloaded, unless another AI was already set up
    await api.aiSave({ provider: 'builtin', model: done[0] }).catch(() => {});
  }
  if (failed.length) toast(failed.join(' '), 'error', 9000);
  else if (done.length) toast(t('The built-in AI is ready. Try Tools › Ask This PDF.'), 'success', 6000);
}
