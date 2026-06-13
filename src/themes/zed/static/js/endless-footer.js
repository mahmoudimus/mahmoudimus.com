/* Endless footer — a <canvas> wordmark drawn every animation frame from the scroll
   position (stripe.dev's technique). The page content scrolls up and off the
   z-index:-1 region to reveal it; the "mahmoudimus" wordmark recedes into a
   perspective tunnel that advances as you scroll. It is driven purely by absolute
   scroll position, so scrolling back up retraces it exactly (reversible) — no
   scroll-jacking. The links bar stays pinned on top. No audio.

   The scroll/perspective math is pure (computeFrame, project) and exported for tests. */
(function () {
  "use strict";

  var TEXT = "mahmoudimus";
  var FOCAL = 0.9; // perspective focal length (smaller = stronger perspective)
  var DEPTH = 16; // how many wordmark copies deep the tunnel goes
  var SPEED = 1.0; // tunnel periods advanced per half-viewport of scroll

  // PURE: perspective scale for a copy at depth z (z >= 0). 1 at the camera, → 0 far away.
  function project(z, focal) { return focal / (focal + z); }

  // PURE: reversible tunnel phase from scroll geometry. Monotonic with scroll, so
  // scrolling up decreases it and the render retraces exactly.
  //   g = { into, vh }   into = px the region has scrolled into the viewport
  function computeFrame(g) {
    var into = g.into > 0 ? g.into : 0;
    var phase = (into / (g.vh * 0.5)) * SPEED;
    return { phase: phase };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computeFrame: computeFrame, project: project, FOCAL: FOCAL, DEPTH: DEPTH, SPEED: SPEED };
    return; // running under Node for tests — no DOM below
  }

  var region = document.querySelector(".site-footer.endless");
  var canvas = region && region.querySelector(".ef-canvas");
  if (!region || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var dpr = 1, raf = 0;
  var bg = "#3358f4", stroke = "rgba(255,255,255,0.62)", fam = 'Georgia, "Times New Roman", serif';

  function readStyle() {
    var cs = getComputedStyle(canvas);
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") bg = cs.backgroundColor;
    if (cs.color) stroke = cs.color;
    if (cs.fontFamily) fam = cs.fontFamily;
  }
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    readStyle();
  }

  function draw() {
    resize();
    var w = canvas.width, h = canvas.height, vh = window.innerHeight;
    var into = vh - region.getBoundingClientRect().top;

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = stroke; // white — without this the canvas defaults to black
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";

    // base font fitted so the nearest wordmark spans ~94% of the width
    ctx.font = "700 100px " + fam;
    var fitFont = 100 * (w * 0.94 / (ctx.measureText(TEXT).width || 1));

    var phase = reduce ? 0 : computeFrame({ into: into, vh: vh }).phase;

    // The bright white "hero" wordmark sits at heroY; a faint perspective tunnel of
    // ghost copies recedes DOWN from just behind it to a vanishing point at the
    // bottom. As you scroll, ghosts rise toward the hero and merge (reversible).
    var heroY = h * 0.34, vanishY = h * 1.02;
    var STEP = 0.5, N = 40;
    var startI = Math.ceil(phase / STEP);
    for (var k = N; k >= 1; k--) { // ghosts only; the very front is the hero
      var z = (startI + k) * STEP - phase;
      if (z <= 0.28) continue; // keep ghosts clear of the hero (no overlap)
      var s = project(z, FOCAL);
      var fs = fitFont * s;
      if (fs < 2) continue;
      ctx.globalAlpha = Math.pow(s, 1.8) * 0.6; // faint, fading with depth
      ctx.lineWidth = Math.max(0.4, 1.5 * dpr * s);
      ctx.font = "700 " + fs + "px " + fam;
      ctx.strokeText(TEXT, w / 2, vanishY + (heroY - vanishY) * s);
    }
    // the hero: the readable name, crisp bright white, stable
    ctx.globalAlpha = 0.96;
    ctx.lineWidth = Math.max(1.5, 2.4 * dpr);
    ctx.font = "700 " + fitFont + "px " + fam;
    ctx.strokeText(TEXT, w / 2, heroY);
    ctx.globalAlpha = 1;
    canvas.dataset.ef = JSON.stringify({ into: Math.round(into), phase: +phase.toFixed(2) });
  }

  function frame() { draw(); raf = window.requestAnimationFrame(frame); }
  window.addEventListener("resize", resize, { passive: true });
  resize();
  raf = window.requestAnimationFrame(frame);
})();
