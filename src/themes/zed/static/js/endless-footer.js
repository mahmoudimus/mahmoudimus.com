/* Endless footer — a <canvas> wordmark drawn every animation frame from the scroll
   position (the technique stripe.dev uses; a continuously-redrawn canvas composites
   reliably where a static position:fixed element does not). The page content scrolls
   up and off the z-index:-1 region to reveal it; a seamless repeating stream of the
   wordmark scrolls upward, and it loops endlessly with escalating text. No audio.

   The scroll->draw math lives in computeFrame(), a pure function exported for tests. */
(function () {
  "use strict";

  var MESSAGES = [
    "mahmoudimus",
    "still scrolling?",
    "it really is endless",
    "okay — you can stop now ❤️",
  ];
  var SPEED = 0.6; // wordmark stream rises at this fraction of scroll distance
  var GAP = 0.7; // vertical gap between repeats, as a fraction of the font size

  // PURE (no DOM): given the scroll geometry, return what to draw this frame.
  //   g = { into, vh, dpr, fontPx, gapPx, loops }
  //     into   px the region has scrolled into the viewport (vh - region.top)
  //     fontPx fitted font size in canvas px;  gapPx gap in canvas px
  // returns { text, periodPx, drift, jumpPx, shouldLoop }
  function computeFrame(g) {
    var periodPx = g.fontPx + g.gapPx; // canvas px between repeated wordmarks
    var driftRaw = (g.into > 0 ? g.into : 0) * SPEED * g.dpr;
    var drift = ((driftRaw % periodPx) + periodPx) % periodPx; // 0..periodPx, wraps
    var jumpPx = periodPx / (SPEED * g.dpr); // scroll px == one period (seamless loop)
    var shouldLoop = g.into >= g.vh + 2 * jumpPx; // only once fully revealed + room
    var msg = MESSAGES[Math.min(Math.floor(g.loops / 6), MESSAGES.length - 1)];
    return { text: msg, periodPx: periodPx, drift: drift, jumpPx: jumpPx, shouldLoop: shouldLoop };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computeFrame: computeFrame, MESSAGES: MESSAGES, SPEED: SPEED, GAP: GAP };
    return; // running under Node for tests — no DOM below
  }

  var region = document.querySelector(".site-footer.endless");
  var canvas = region && region.querySelector(".ef-canvas");
  if (!region || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var dpr = 1, raf = 0, loops = 0;
  // colors + font read from resolved computed styles (so nested var() is substituted)
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
    var text = MESSAGES[Math.min(Math.floor(loops / 6), MESSAGES.length - 1)];

    // fit the wordmark to ~90% of the canvas width
    ctx.font = "700 100px " + fam;
    var fontPx = 100 * (w * 0.9 / (ctx.measureText(text).width || 1));
    ctx.font = "700 " + fontPx + "px " + fam;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(1.5, 2 * dpr);
    ctx.strokeStyle = stroke;

    // space repeats by viewport height (not font size) so the count is consistent
    // across mobile/desktop (~2.4 per screen) instead of crowding on narrow screens.
    var period = Math.max(fontPx * (1 + GAP), h * 0.42);
    var f = computeFrame({ into: into, vh: vh, dpr: dpr, fontPx: fontPx, gapPx: period - fontPx, loops: loops });

    ctx.fillStyle = bg; // solid panel behind the wordmark
    ctx.fillRect(0, 0, w, h);
    if (reduce) {
      ctx.strokeText(text, w / 2, h * 0.62); // static, no motion
    } else {
      for (var y = h + f.periodPx; y > -f.periodPx; y -= f.periodPx) {
        ctx.strokeText(text, w / 2, y - f.drift);
      }
      if (f.shouldLoop) { loops += 1; window.scrollTo(0, window.scrollY - f.jumpPx); }
    }
    // tiny live snapshot for the integration test
    canvas.dataset.ef = JSON.stringify({ into: Math.round(into), loops: loops, drift: Math.round(f.drift) });
  }

  function frame() { draw(); raf = window.requestAnimationFrame(frame); }
  window.addEventListener("resize", resize, { passive: true });
  resize();
  raf = window.requestAnimationFrame(frame);
})();
