/* Endless footer — a faithful port of stripe.dev's <EndlessFooter> to vanilla JS.

   It is ONE wordmark, not a stack of copies. As you scroll into the tall z-index:-1
   region, the wordmark scales and slides (its size/position are eased toward targets
   derived purely from the scroll geometry, so scrolling up retraces it). Each frame
   clears only the TOP slice of the canvas, so previous frames linger below — that
   leftover trail is the receding "3D tunnel". Each glyph is stroked, then punched out
   with destination-out, so the interiors are transparent and the accent backdrop shows
   through: white outlines on accent. When the region bottoms out it loops by jumping
   scroll back to the top (endless), with the font size modulated by sin() across loops
   so the zoom feels continuous. No audio.

   The scroll→target math is pure (computeTargets) and exported for tests. */
(function () {
  "use strict";

  var TEXT = "mahmoudimus";

  // PURE: scroll geometry -> animation targets, mirroring stripe.dev's scroll handler.
  //   s = { footerTop, vh, dpr, maxW, m }
  //     footerTop = footer.getBoundingClientRect().top   (CSS px)
  //     vh = innerHeight, dpr = devicePixelRatio, maxW = min(1728, innerWidth)
  //     m  = how many times the region has looped (0 on the first pass)
  // Returns device-pixel targets: fontSize (px), yTarget (baseline), clearHeight, r, p.
  function computeTargets(s) {
    var vh = s.vh, dpr = s.dpr, maxW = s.maxW, m = s.m;
    var f = s.footerTop - vh;
    var p = -((f - m * vh) / vh);
    var t = (maxW / 6.35) * dpr;
    if (m > 0) t -= t * Math.sin(p - 2.2) - 0.1 * t; // pulse the zoom across loops
    var r = t - t / 3.6;
    var o = vh * dpr + r - p * vh * dpr + m * vh * dpr;
    var yTarget = m > 0 ? o + vh * dpr : o;
    return { fontSize: t, yTarget: yTarget, clearHeight: o, r: r, p: p };
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { computeTargets: computeTargets, TEXT: TEXT };
    return; // running under Node for tests — no DOM below
  }

  var footer = document.querySelector(".site-footer.endless");
  var canvas = footer && footer.querySelector(".ef-canvas");
  if (!footer || !canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // live geometry
  var dpr = 1, maxW = 1728, vh = window.innerHeight;
  // looping + easing state (stripe.dev's refs: m, prevF, h, v, b, jY, kB, clearH, rOff)
  var m = 0, prevF = 0, h = 0;
  var v = 0, b = 0;            // eased baseline-y and font-size (device px)
  var jY = 0, kB = 0;          // their targets
  var clearH = 0, rOff = 0;    // the partial-clear height pieces (w, C)
  var stroke = "#ffffff", fam = 'Georgia, "Times New Roman", serif';
  var raf = 0;

  function readStyle() {
    var cs = getComputedStyle(canvas);
    if (cs.color) stroke = cs.color;
    if (cs.fontFamily) fam = cs.fontFamily;
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

  // draw one line glyph-by-glyph: stroke, then knock the interior out (transparent).
  function drawLine(text, x, y, ls) {
    ctx.clearRect(0, 0, canvas.width, clearH - rOff); // partial clear -> trailing tunnel
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
    var width = ctx.measureText(TEXT).width;
    var total = width + ls * (TEXT.length - 1);
    ctx.strokeStyle = stroke;
    ctx.fillStyle = "#000"; // colour irrelevant under destination-out
    ctx.lineWidth = Math.max(1, 2.5 * dpr);
    drawLine(TEXT, canvas.width / 2 - total / 2 + ls / 2, v, ls);
    canvas.dataset.ef = JSON.stringify({ m: m, b: Math.round(b), v: Math.round(v) });
  }

  function onScroll() {
    var rect = footer.getBoundingClientRect();
    var prev = prevF;
    var f = rect.top - vh;
    prevF = f;
    var tg = computeTargets({ footerTop: rect.top, vh: vh, dpr: dpr, maxW: maxW, m: m });
    jY = tg.yTarget; kB = tg.fontSize; clearH = tg.clearHeight; rOff = tg.r;
    h = f - prev;
    if (rect.bottom < vh + 1) {
      // bottomed out — loop endlessly: jump scroll back to the region top and snap.
      m += 1;
      window.scrollTo(0, footer.offsetTop);
      var tg2 = computeTargets({ footerTop: footer.getBoundingClientRect().top, vh: vh, dpr: dpr, maxW: maxW, m: m });
      v = tg2.yTarget; b = tg2.fontSize; jY = tg2.yTarget; kB = tg2.fontSize;
      clearH = tg2.clearHeight; rOff = tg2.r;
    } else if (h > 0 && h < 0.5 * vh) {
      m = 0; // scrolled back up near the top — reset the loop counter
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
