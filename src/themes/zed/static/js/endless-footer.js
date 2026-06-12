/* Endless footer: drive the wordmark reveal from how far the footer region has
   scrolled into view, exposed as the CSS var --ef (0..1). This replaces CSS
   scroll-driven timelines, which freeze on the sticky/pinned wordmark. */
(function () {
  var footer = document.querySelector(".site-footer.endless");
  if (!footer) return;

  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    footer.style.setProperty("--ef", "1");
    return;
  }

  var ticking = false;
  function update() {
    ticking = false;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    var top = footer.getBoundingClientRect().top;
    // 0 when the region's top sits at the viewport bottom (just entering),
    // 1 once it has risen a full viewport (panel revealed/pinned).
    var p = (vh - top) / vh;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    footer.style.setProperty("--ef", p.toFixed(3));
  }
  function onScroll() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  update();
})();
