// Inkleaf website: three small things.

// 1. The menu line at the top fixes its own typo once, the way you'd fix it
//    in Inkleaf: the word shows misspelt, then gets retyped.
(() => {
  const word = document.querySelector('.demo-word');
  if (!word) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const from = word.dataset.from;
  const to = word.dataset.to;
  word.textContent = from;
  word.classList.add('typing');

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    await wait(1100);
    // back up to where the two spellings differ, then type the rest
    let same = 0;
    while (same < from.length && from[same] === to[same]) same++;
    for (let i = from.length; i > same; i--) {
      word.textContent = from.slice(0, i - 1);
      await wait(110);
    }
    await wait(250);
    for (let i = same + 1; i <= to.length; i++) {
      word.textContent = to.slice(0, i);
      await wait(130);
    }
    await wait(900);
    word.classList.remove('typing');
  })();
})();

// 2. Before and after slider for the cleaned-up scan.
(() => {
  const range = document.getElementById('compare-range');
  const frame = document.querySelector('.compare-frame');
  if (!range || !frame) return;
  const show = () => frame.style.setProperty('--pos', `${range.value}%`);
  range.addEventListener('input', show);
  show();

  // dragging on the picture itself moves it too
  let dragging = false;
  const moveTo = (event) => {
    const box = frame.getBoundingClientRect();
    const percent = ((event.clientX - box.left) / box.width) * 100;
    range.value = String(Math.min(100, Math.max(0, Math.round(percent))));
    show();
  };
  frame.addEventListener('pointerdown', (event) => {
    dragging = true;
    frame.setPointerCapture(event.pointerId);
    moveTo(event);
  });
  frame.addEventListener('pointermove', (event) => dragging && moveTo(event));
  frame.addEventListener('pointerup', () => { dragging = false; });
  frame.addEventListener('pointercancel', () => { dragging = false; });
})();

// 3. Point out the download for this device, and name it on the top button.
(() => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'android'
    : /iPhone|iPad/.test(ua) ? 'ios'
      : /Windows/.test(ua) ? 'windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'mac'
          : /Linux|X11/.test(ua) ? 'linux' : null;
  if (!os) return;
  document.querySelector(`.downloads tr[data-os="${os}"]`)?.classList.add('yours');

  // the Microsoft Store link only means something on Windows
  if (os !== 'windows') document.querySelector('.get .quiet-link')?.remove();

  const names = { windows: 'Windows', linux: 'Linux', android: 'Android' };
  const button = document.getElementById('get-button');
  if (button && names[os]) button.textContent = `Download for ${names[os]}`;
})();
