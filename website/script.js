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