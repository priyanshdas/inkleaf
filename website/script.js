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

// 2. Before and after slider for the cleaned-up scan. The slider itself is
//    invisible and covers the picture, so dragging the handle (or anywhere on
//    the picture) and the arrow keys all work.
(() => {
  const range = document.getElementById('compare-range');
  const frame = document.querySelector('.compare-frame');
  if (!range || !frame) return;
  const show = () => {
    const v = Number(range.value);
    frame.style.setProperty('--pos', `${v}%`);
    frame.classList.toggle('near-left', v < 18);
    frame.classList.toggle('near-right', v > 82);
  };
  range.addEventListener('input', show);
  show();

  const start = () => frame.classList.add('dragging');
  const stop = () => frame.classList.remove('dragging');
  range.addEventListener('pointerdown', start);
  range.addEventListener('pointerup', stop);
  range.addEventListener('pointercancel', stop);
  range.addEventListener('blur', stop);

  // the first time it scrolls into view, nudge the handle once so it's
  // obvious it moves
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
  let touched = false;
  range.addEventListener('pointerdown', () => { touched = true; }, { once: true });
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    seen.disconnect();
    const path = [50, 34, 66, 50];
    const t0 = performance.now(), each = 650;
    const step = (now) => {
      if (touched) return;
      const k = Math.min((now - t0) / each, path.length - 1);
      const i = Math.min(Math.floor(k), path.length - 2), f = k - i;
      const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
      range.value = String(Math.round(path[i] + (path[i + 1] - path[i]) * e));
      show();
      if (k < path.length - 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 400);
  }, { threshold: 0.6 });
  seen.observe(frame);
})();

// 2b. The video at the top: a pause button, and no autoplay for people who
//     asked their system for less motion.
(() => {
  const video = document.getElementById('shot-video');
  const toggle = document.getElementById('shot-toggle');
  if (!video || !toggle) return;
  const label = () => {
    const paused = video.paused;
    toggle.textContent = paused ? 'Play' : 'Pause';
    toggle.setAttribute('aria-pressed', String(paused));
  };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    video.removeAttribute('autoplay');
    video.pause();
  }
  toggle.addEventListener('click', () => { if (video.paused) video.play(); else video.pause(); });
  video.addEventListener('play', label);
  video.addEventListener('pause', label);
  label();
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
