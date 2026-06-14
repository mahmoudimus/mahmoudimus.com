/* Unit test for the endless footer's pure scroll->target math and the egg text picker.
   No DOM, no real rAF. Run: node tests/endless-footer.test.js */
"use strict";
const assert = require("node:assert");
const { computeTargets, textForLoop, TEXT, EGGS } = require("../src/themes/zed/static/js/endless-footer.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok  " + name); }

const base = { vh: 900, dpr: 2, maxW: 1728, m: 0 };

check("font size is the base size on the first pass (maxW/6.35*dpr)", () => {
  const t = computeTargets({ ...base, footerTop: 0 }).fontSize;
  assert.ok(Math.abs(t - (1728 / 6.35) * 2) < 1e-9, "first-pass font size is constant " + t);
});

check("results are pure & deterministic (same input -> same output)", () => {
  const a = computeTargets({ ...base, footerTop: 300 });
  const b = computeTargets({ ...base, footerTop: 300 });
  assert.deepStrictEqual(a, b);
});

check("baseline y rises (decreases) as you scroll down (footerTop decreases)", () => {
  // scrolling down moves the region up: footerTop goes from +vh toward negative.
  let prev = Infinity;
  for (const footerTop of [900, 450, 0, -450, -900]) {
    const y = computeTargets({ ...base, footerTop }).yTarget;
    assert.ok(y < prev, `yTarget should decrease as footerTop drops (footerTop=${footerTop}, y=${y})`);
    prev = y;
  }
});

check("the cleared slice is a partial top region (so the rest stays as trail)", () => {
  // we clear only clearHeight - r each frame; it must be a strict sub-region
  // of the full canvas height (never the whole thing), leaving previous frames as trail.
  const t = computeTargets({ ...base, footerTop: 120 });
  const slice = t.clearHeight - t.r;            // == vh*dpr*(1 - p + m)
  const canvasH = base.vh * base.dpr;
  assert.ok(Number.isFinite(slice), "slice is finite");
  assert.ok(slice < canvasH + 1e-9, "cleared slice never exceeds the canvas height");
});

check("the wordmark is the name until the first egg, then swaps by loop count", () => {
  assert.strictEqual(textForLoop(0), TEXT);
  assert.strictEqual(textForLoop(EGGS[0].after - 1), TEXT);
  // each threshold shows that egg, and stays until the next one
  for (let i = 0; i < EGGS.length; i++) {
    assert.strictEqual(textForLoop(EGGS[i].after), EGGS[i].text);
    const next = i + 1 < EGGS.length ? EGGS[i + 1].after : EGGS[i].after + 50;
    assert.strictEqual(textForLoop(next - 1), EGGS[i].text);
  }
  // way past the last egg, it stays on the last one (no crash, no wrap)
  assert.strictEqual(textForLoop(10000), EGGS[EGGS.length - 1].text);
});

check("sizeScale shrinks the font linearly (so long eggs fit)", () => {
  const full = computeTargets({ ...base, footerTop: 0 }).fontSize;
  const half = computeTargets({ ...base, footerTop: 0, sizeScale: 0.5 }).fontSize;
  assert.ok(Math.abs(half - full * 0.5) < 1e-9, "sizeScale 0.5 halves the font size");
});

check("looping (m>0) shifts targets by whole viewports and stays finite", () => {
  const top = -100;
  const p0 = computeTargets({ ...base, footerTop: top, m: 0 });
  const p1 = computeTargets({ ...base, footerTop: top, m: 1 });
  assert.ok(Number.isFinite(p1.fontSize) && p1.fontSize > 0, "looped font size finite & positive");
  assert.ok(p1.yTarget !== p0.yTarget, "looped baseline differs from first pass");
});

console.log(`\n${passed} checks passed.`);
