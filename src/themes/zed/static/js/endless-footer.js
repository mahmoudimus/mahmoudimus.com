/* Endless footer — a canvas wordmark that scales and loops as you scroll, an
   endless-footer effect in the spirit of stripe.dev's, reconstructed for vanilla JS.

   It is ONE wordmark, not a stack of copies. As you scroll into the tall z-index:-1
   region, the wordmark scales and slides (its size/position are eased toward targets
   derived purely from the scroll geometry, so scrolling up retraces it). Each frame
   clears only the TOP slice of the canvas, so previous frames linger below — that
   leftover trail is the receding "3D tunnel". Each glyph is stroked, then punched out
   with destination-out, so the interiors are transparent and the accent backdrop shows
   through: white outlines on accent. When the region bottoms out it loops by jumping
   scroll back to the top (endless), with the font size modulated by sin() across loops
   so the zoom feels continuous. No audio.

   Easter eggs: the longer you keep scrolling (the more times the region loops, m), the
   wordmark swaps to a sequence of messages. Back off and it resets to the name.

   The scroll→target math is pure (computeTargets) and exported for tests. */
(function () {
  "use strict";

  var TEXT = "mahmoudimus";

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

  // PURE: scroll geometry -> animation targets.
  //   s = { footerTop, vh, dpr, maxW, m, sizeScale? }
  //     footerTop = footer.getBoundingClientRect().top   (CSS px)
  //     vh = innerHeight, dpr = devicePixelRatio, maxW = min(1728, innerWidth)
  //     m  = how many times the region has looped (0 on the first pass)
  //     sizeScale = width-fit factor for the current text (1 = the default wordmark)
  // Returns device-pixel targets: fontSize (px), yTarget (baseline), clearHeight, r, p.
  function computeTargets(s) {
    var vh = s.vh, dpr = s.dpr, maxW = s.maxW, m = s.m;
    var sizeScale = s.sizeScale == null ? 1 : s.sizeScale;
    var f = s.footerTop - vh;
    var p = -((f - m * vh) / vh);
    var t = (maxW / 6.35) * dpr * sizeScale;
    if (m > 0) t -= t * Math.sin(p - 2.2) - 0.1 * t; // pulse the zoom across loops
    var r = t - t / 3.6;
    var o = vh * dpr + r - p * vh * dpr + m * vh * dpr;
    var yTarget = m > 0 ? o + vh * dpr : o;
    return { fontSize: t, yTarget: yTarget, clearHeight: o, r: r, p: p };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computeTargets: computeTargets, textForLoop: textForLoop, TEXT: TEXT, EGGS: EGGS };
    return; // running under Node for tests — no DOM below
  }

  var footer = document.querySelector(".site-footer.endless");
  var canvas = footer && footer.querySelector(".ef-canvas");
  if (!footer || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // live geometry
  var dpr = 1, maxW = 1728, vh = window.innerHeight;
  // looping + easing state
  var m = 0, prevF = 0, h = 0;
  var v = 0, b = 0;            // eased baseline-y and font-size (device px)
  var jY = 0, kB = 0;          // their easing targets
  var clearH = 0, rOff = 0;    // the partial-clear height pieces
  var curText = TEXT, curScale = 1; // current wordmark + its width-fit factor
  var stroke = "#ffffff", field = "#3358f4", fam = 'Georgia, "Times New Roman", serif';
  var raf = 0;

  function readStyle() {
    var cs = getComputedStyle(canvas);
    if (cs.color) stroke = cs.color;
    if (cs.fontFamily) fam = cs.fontFamily;
    // the accent field colour (canvas background) — painted INTO the bitmap so the
    // field is never transparent (no page-bg flash through it on iOS during scroll).
    if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)") field = cs.backgroundColor;
  }

  function resize() {
    maxW = Math.min(1728, window.innerWidth);
    vh = window.innerHeight;
    dpr = window.devicePixelRatio || 1;
    var rect = canvas.getBoundingClientRect();
    var w = Math.round(rect.width * dpr);
    var hgt = Math.round(rect.height * dpr);
    // only resize on a real change (>120px tolerance avoids mobile URL-bar thrash)
    if (canvas.width !== w || Math.abs(canvas.height - hgt) > 120) {
      canvas.width = w; canvas.height = hgt;
    }
    readStyle();
  }

  // width-fit factor so a longer egg shrinks to roughly the default wordmark's width
  // (and never grows a short one past it). Measured at any size — the ratio is linear.
  function fitScale(text) {
    if (text === TEXT) return 1;
    ctx.font = "700 100px " + fam;
    var defW = ctx.measureText(TEXT).width || 1;
    var curW = ctx.measureText(text).width || 1;
    return curW > defW ? defW / curW : 1;
  }

  // pick the current wordmark + fit for the loop count, refreshing module state
  function refreshText() {
    curText = textForLoop(m);
    curScale = fitScale(curText);
  }

  // draw one line glyph-by-glyph: stroke, then knock the interior out (transparent).
  function drawLine(text, x, y, ls) {
    // repaint the top slice with the OPAQUE accent (was clearRect → transparent). Keeps
    // the receding-trail effect (only the top slice is repainted) while ensuring the
    // field is never transparent, so nothing flashes through it during scroll.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = field;
    ctx.fillRect(0, 0, canvas.width, clearH - rOff);
    var cx = x;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeText(ch, cx, y);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + ls;
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function render() {
    ctx.font = "700 " + b + "px " + fam;
    var ls = -b / 20; // tight letter-spacing, proportional to size
    var width = ctx.measureText(curText).width;
    var total = width + ls * (curText.length - 1);
    ctx.strokeStyle = stroke;
    ctx.fillStyle = "#000"; // colour irrelevant under destination-out
    ctx.lineWidth = Math.max(1, 2.5 * dpr);
    drawLine(curText, canvas.width / 2 - total / 2 + ls / 2, v, ls);
    canvas.dataset.ef = JSON.stringify({ m: m, b: Math.round(b), v: Math.round(v), t: curText });
  }

  function onScroll() {
    var rect = footer.getBoundingClientRect();
    var prev = prevF;
    var f = rect.top - vh;
    prevF = f;
    refreshText();
    var tg = computeTargets({ footerTop: rect.top, vh: vh, dpr: dpr, maxW: maxW, m: m, sizeScale: curScale });
    jY = tg.yTarget; kB = tg.fontSize; clearH = tg.clearHeight; rOff = tg.r;
    h = f - prev;
    if (rect.bottom < vh + 1) {
      // bottomed out — loop endlessly: jump scroll back to the region top and snap.
      m += 1;
      window.scrollTo(0, footer.offsetTop);
      refreshText();
      var tg2 = computeTargets({ footerTop: footer.getBoundingClientRect().top, vh: vh, dpr: dpr, maxW: maxW, m: m, sizeScale: curScale });
      v = tg2.yTarget; b = tg2.fontSize; jY = tg2.yTarget; kB = tg2.fontSize;
      clearH = tg2.clearHeight; rOff = tg2.r;
    } else if (h > 0 && h < 0.5 * vh) {
      m = 0; // scrolled back up near the top — reset the loop counter (and the wordmark)
      refreshText();
      var tg0 = computeTargets({ footerTop: rect.top, vh: vh, dpr: dpr, maxW: maxW, m: m, sizeScale: curScale });
      jY = tg0.yTarget; kB = tg0.fontSize; clearH = tg0.clearHeight; rOff = tg0.r;
    }
  }

  function loop() {
    v += (jY - v) * 0.1;
    b += (kB - b) * 0.1;
    render();
    raf = window.requestAnimationFrame(loop);
  }

  resize();
  onScroll();
  v = jY; b = kB; // start snapped to target (no ease-in from zero)
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", function () { resize(); onScroll(); }, { passive: true });
  if (reduce) { render(); }
  else { raf = window.requestAnimationFrame(loop); }
})();
