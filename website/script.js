// InkLeaf PDF website: a few small things, on every page that has them.

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// 0. Links to the old one-page site (#download, #roadmap…) go to their new pages.
(() => {
  const moved = {
    '#download': 'download/', '#roadmap': 'roadmap/', '#what-it-does': 'features/',
    '#about': 'about/', '#contributors': 'about/#contributors', '#code-signing': 'about/#code-signing',
  };
  const to = moved[location.hash];
  if (to && !/\/(download|roadmap|features|about|releases)\//.test(location.pathname)) location.replace(to);
})();

// 1. Light or dark: follows the system until the toggle is used, then remembers.
(() => {
  const button = document.querySelector('.theme-toggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const root = document.documentElement;
    const now = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = now === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem('inkleaf-theme', next);
    } catch {
      // private browsing: it just won't be remembered
    }
  });
})();

// 2. The menu on narrow screens.
(() => {
  const button = document.querySelector('.menu-button');
  const nav = document.getElementById('nav');
  if (!button || !nav) return;
  button.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
})();

// 3. The page at the top fixes its own typo once, the way you'd fix it in
//    InkLeaf PDF: the word shows misspelt, then gets retyped.
(() => {
  const word = document.querySelector('.demo-word');
  if (!word || reducedMotion) return;
  const from = word.dataset.from;
  const to = word.dataset.to;
  word.textContent = from;
  word.classList.add('typing');
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    await wait(1400);
    // back up to where the two spellings differ, then type the rest
    let same = 0;
    while (same < from.length && from[same] === to[same]) same++;
    for (let i = from.length; i > same; i--) {
      word.textContent = from.slice(0, i - 1);
      await wait(120);
    }
    await wait(260);
    for (let i = same + 1; i <= to.length; i++) {
      word.textContent = to.slice(0, i);
      await wait(140);
    }
    await wait(1600);
    word.classList.remove('typing');
  })();
})();

// 4. Before and after slider for the cleaned-up scan. The slider itself is
//    invisible and covers the picture, so dragging anywhere and the arrow keys work.
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
})();

// 5. The video of the app: a pause button, and no autoplay for people who asked for less motion.
(() => {
  const video = document.getElementById('shot-video');
  const toggle = document.getElementById('shot-toggle');
  if (!video || !toggle) return;
  const label = () => {
    toggle.textContent = video.paused ? 'Play' : 'Pause';
    toggle.setAttribute('aria-pressed', String(video.paused));
  };
  if (reducedMotion) {
    video.removeAttribute('autoplay');
    video.pause();
  }
  toggle.addEventListener('click', () => (video.paused ? video.play() : video.pause()));
  video.addEventListener('play', label);
  video.addEventListener('pause', label);
  label();
})();

// 6. Point out the download for this device, and name it on the top button.
(() => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'android'
    : /iPhone|iPad/.test(ua) ? 'ios'
      : /Windows/.test(ua) ? 'windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'mac'
          : /Linux|X11/.test(ua) ? 'linux' : null;
  if (!os) return;
  document.querySelector(`.download[data-os="${os}"]`)?.classList.add('yours');
  const names = { windows: 'Windows', linux: 'Linux', android: 'Android' };
  const button = document.getElementById('get-button');
  if (button && names[os]) button.textContent = `Download for ${names[os]}`;
})();
