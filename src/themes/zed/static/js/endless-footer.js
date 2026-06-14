/* Endless footer — a canvas wordmark perspective-tunnel, in the spirit of stripe.dev's,
   reconstructed for vanilla JS.

   As you scroll into the tall region, the "mahmoudimus" wordmark streams toward you out
   of a vanishing point: a stack of copies receding into the distance, each nearer one
   bigger, the front one filling the width, then exiting past the bottom while a new one
   appears at the back. It loops endlessly (the region jumps its scroll back to the top
   when you reach the bottom), so you can keep scrolling forever; scrolling back up
   retraces it. No audio.

   The whole tunnel is RECOMPUTED from the scroll phase every frame and the canvas is
   fully cleared first — nothing is carried over from previous frames. That makes it
   deterministic and immune to non-smooth scrolling (iOS momentum, the loop's scrollTo),
   which a frame-to-frame "trail" technique is not.

   Easter eggs: the longer you keep scrolling (the more times the region loops, m), the
   wordmark swaps to a sequence of messages. Back off near the top and it resets.

   The scroll→phase math is pure (computePhase) and exported for tests. */
(function () {
  "use strict";

  var TEXT = "mahmoudimus";

  // tunnel tuning
  var SPEED = 2.0;   // tunnel periods advanced per viewport of scroll
  var STEP = 0.5;    // depth gap between consecutive copies
  var FOCAL = 0.9;   // perspective focal length (smaller = stronger perspective)
  var N = 44;        // how many copies deep the tunnel is drawn

  // Wordmark swaps keyed on the loop counter m (how many times you've cycled the
  // region). Reward sustained scrolling; pick the last egg whose `after <= m`.
  var EGGS = [
    { after: 2, text: "still scrolling?" },
    { after: 4, text: "I…am…MAHMOUDIMUS" },
    { after: 6, text: "okay, show off" },
    { after: 9, text: "go outside" },
    { after: 13, text: "we can stop now" },
    { after: 18, text: "fine. you win." },
  ];

  // PURE: which wordmark to show after m loops.
  function textForLoop(m) {
    var t = TEXT;
    for (var i = 0; i < EGGS.length; i++) if (m >= EGGS[i].after) t = EGGS[i].text;
    return t;
  }

  // PURE: a continuous, monotonic scroll phase that drives the tunnel depth. It rises as
  // you scroll down and stays continuous across the endless loop — the m term exactly
  // cancels the scrollTo reset (at the bottom footerTop≈-vh,m → at the top footerTop≈0,m+1
  // both give the same phase). Reversible: same scroll → same phase.
  //   s = { footerTop, vh, m }   footerTop = footer.getBoundingClientRect().top (CSS px)
  function computePhase(s) {
    return s.m + (s.vh - s.footerTop) / s.vh;
  }

  // PURE: perspective scale for a copy at depth z (>= 0). 1 at the camera, → 0 far away.
  function project(z) { return FOCAL / (FOCAL + z); }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computePhase: computePhase, project: project, textForLoop: textForLoop,
                       TEXT: TEXT, EGGS: EGGS, SPEED: SPEED, STEP: STEP };
    return; // running under Node for tests — no DOM below
  }

  var footer = document.querySelector(".site-footer.endless");
  var canvas = footer && footer.querySelector(".ef-canvas");
  if (!footer || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var dpr = 1, vh = window.innerHeight;
  var m = 0, prevF = 0, h = 0;        // loop counter + scroll-direction tracking
  var curText = TEXT;
  var stroke = "#ffffff", field = "#3358f4", fam = 'Georgia, "Times New Roman", serif';
  var raf = 0;

  function readStyle() {
    var cs = getComputedStyle(canvas);
    if (cs.color) stroke = cs.color;
    if (cs.fontFamily) fam = cs.fontFamily;
    // accent field colour (canvas background) — painted opaque so nothing flashes through.
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") field = cs.backgroundColor;
  }

  function resize() {
    vh = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.round(rect.width * dpr), hgt = Math.round(rect.height * dpr);
    // only resize on a real change (>120px tolerance avoids mobile URL-bar thrash)
    if (canvas.width !== w || Math.abs(canvas.height - hgt) > 120) { canvas.width = w; canvas.height = hgt; }
    readStyle();
  }

  function render() {
    var W = canvas.width, H = canvas.height;
    // full, opaque clear every frame — the tunnel is redrawn from scratch, so there is
    // no trail to accumulate (the cause of the iOS pile-up flicker).
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = stroke;
    ctx.lineJoin = "round";
    ctx.textBaseline = "alphabetic";

    var phase = computePhase({ footerTop: footer.getBoundingClientRect().top, vh: vh, m: m }) * SPEED;
    if (phase < 0) phase = 0;

    // precompute glyph advances once (at 100px) so we don't measureText per copy
    ctx.font = "700 100px " + fam;
    var adv = [], baseW = 0;
    for (var i = 0; i < curText.length; i++) { adv[i] = ctx.measureText(curText.charAt(i)).width; baseW += adv[i]; }
    var fitFont = 100 * (W * 0.92 / (baseW || 1)); // front copy spans ~92% of the width

    var heroY = H * 0.90, vanishY = H * 0.08;       // front near the bottom, vanish near the top
    var startI = Math.floor(phase / STEP);
    for (var k = N; k >= 0; k--) {
      var z = (startI + k) * STEP - phase;          // depth of this copy (cycles as phase rises)
      if (z <= 0.05) continue;
      var s = project(z);
      var fs = fitFont * s;
      if (fs < 3) continue;
      var scale = fs / 100, ls = -fs / 20;
      var total = baseW * scale + ls * (curText.length - 1);
      var cx = W / 2 - total / 2 + ls / 2;
      var yy = vanishY + (heroY - vanishY) * s;
      ctx.globalAlpha = Math.min(1, s * 1.7);       // fade with depth
      ctx.lineWidth = Math.max(0.5, 2.3 * dpr * s);
      ctx.font = "700 " + fs + "px " + fam;
      for (var j = 0; j < curText.length; j++) { ctx.strokeText(curText.charAt(j), cx, yy); cx += adv[j] * scale + ls; }
    }
    ctx.globalAlpha = 1;
    canvas.dataset.ef = JSON.stringify({ m: m, phase: +phase.toFixed(2), t: curText });
  }

  function onScroll() {
    var rect = footer.getBoundingClientRect();
    var f = rect.top - vh;
    h = f - prevF;
    prevF = f;
    if (rect.bottom < vh + 1) {
      m += 1;                          // bottomed out — loop endlessly
      window.scrollTo(0, footer.offsetTop);
      curText = textForLoop(m);
    } else if (h > 0 && h < 0.5 * vh) {
      m = 0;                           // scrolled back up near the top — reset
      curText = textForLoop(m);
    }
  }

  function loop() { render(); raf = window.requestAnimationFrame(loop); }

  resize();
  curText = textForLoop(m);
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () { resize(); onScroll(); }, { passive: true });
  if (reduce) { render(); }
  else { raf = window.requestAnimationFrame(loop); }
})();
