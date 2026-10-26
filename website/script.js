// Inkleaf website
// Small interactions and smooth navigation.

document.addEventListener("DOMContentLoaded", () => {
  // Smooth scrolling for internal links
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");

      if (!targetId || targetId === "#") return;

      const target = document.querySelector(targetId);

      if (!target) return;

      event.preventDefault();

      target.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  });


  // Reveal sections as they enter the viewport
  const revealItems = document.querySelectorAll(
    ".feature-card, .privacy-section, .opensource-card, .download-container"
  );

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.12,
    }
  );

  revealItems.forEach((item) => {
    item.classList.add("reveal");
    observer.observe(item);
  });
});

const mobileMenuButton = document.querySelector(".mobile-menu-button");
const mobileMenu = document.querySelector(".mobile-menu");

if (mobileMenuButton && mobileMenu) {
  mobileMenuButton.addEventListener("click", () => {
    const isOpen = mobileMenu.classList.toggle("open");

    mobileMenuButton.classList.toggle("active", isOpen);
    mobileMenuButton.setAttribute("aria-expanded", String(isOpen));
  });

  mobileMenu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      mobileMenu.classList.remove("open");
      mobileMenuButton.classList.remove("active");
      mobileMenuButton.setAttribute("aria-expanded", "false");
    });
  });
}

// Downloads: point out the one for this computer, and let the "portable
// version" words inside the Windows card open their own file.
(() => {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'windows' : /Mac OS X|Macintosh/.test(ua) ? 'mac' : /Linux|X11/.test(ua) && !/Android/.test(ua) ? 'linux' : null;
  if (os) document.querySelector(`.download-option[data-os="${os}"]`)?.classList.add('is-yours');

  document.querySelectorAll('.inline-link[data-href]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.location.href = link.dataset.href;
    });
  });
})();
