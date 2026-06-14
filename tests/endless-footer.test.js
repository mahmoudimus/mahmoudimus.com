/* Unit test for the endless footer's pure math: the reversible scroll phase, the
   perspective projection, and the egg text picker. No DOM, no real rAF.
   Run: node tests/endless-footer.test.js */
"use strict";
const assert = require("node:assert");
const { computePhase, project, textForLoop, TEXT, EGGS, STEP } = require("../src/themes/zed/static/js/endless-footer.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok  " + name); }

check("phase rises monotonically as you scroll down (footerTop decreases)", () => {
  const vh = 900;
  let prev = -Infinity;
  for (const footerTop of [900, 450, 0, -450, -900]) {
    const ph = computePhase({ footerTop, vh, m: 0 });
    assert.ok(ph > prev, `phase should increase as footerTop drops (footerTop=${footerTop}, ph=${ph})`);
    prev = ph;
  }
});

check("phase is continuous across the endless loop (bottom@m == top@m+1)", () => {
  const vh = 900;
  const atBottom = computePhase({ footerTop: -vh, vh, m: 0 }); // about to loop
  const atTopNext = computePhase({ footerTop: 0, vh, m: 1 });  // just looped (scrollTo top, m++)
  assert.ok(Math.abs(atBottom - atTopNext) < 1e-9, `loop seam should be continuous (${atBottom} vs ${atTopNext})`);
});

check("phase is pure & reversible (same scroll -> same phase)", () => {
  assert.strictEqual(computePhase({ footerTop: 120, vh: 800, m: 2 }),
                     computePhase({ footerTop: 120, vh: 800, m: 2 }));
});

check("project: scale is 1 at the camera and decreases with depth", () => {
  assert.ok(Math.abs(project(0) - 1) < 1e-9);
  assert.ok(project(1) < project(0));
  assert.ok(project(8) < project(1));
  assert.ok(project(100) > 0 && project(100) < 0.02, "far copies shrink toward 0");
});

check("the wordmark is the name until the first egg, then swaps by loop count", () => {
  assert.strictEqual(textForLoop(0), TEXT);
  assert.strictEqual(textForLoop(EGGS[0].after - 1), TEXT);
  for (let i = 0; i < EGGS.length; i++) {
    assert.strictEqual(textForLoop(EGGS[i].after), EGGS[i].text);
    const next = i + 1 < EGGS.length ? EGGS[i + 1].after : EGGS[i].after + 50;
    assert.strictEqual(textForLoop(next - 1), EGGS[i].text);
  }
  assert.strictEqual(textForLoop(10000), EGGS[EGGS.length - 1].text);
});

console.log(`\n${passed} checks passed.`);
