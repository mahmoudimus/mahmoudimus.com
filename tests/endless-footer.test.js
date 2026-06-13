/* Unit test for the endless footer's pure scroll->draw math. No DOM, no real rAF —
   we feed mocked scroll geometry and assert the output, including that the
   endless loop-back is seamless (drift is unchanged across a one-period jump).
   Run: node tests/endless-footer.test.js */
"use strict";
const assert = require("node:assert");
const { computeFrame, MESSAGES, SPEED, GAP } = require("../src/themes/zed/static/js/endless-footer.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok  " + name); }

const base = { vh: 800, dpr: 2, fontPx: 400, gapPx: 400 * GAP, loops: 0 };
const period = base.fontPx + base.gapPx;           // 680
const jump = period / (SPEED * base.dpr);          // 566.67

check("drift is 0 at the start", () => {
  const f = computeFrame({ ...base, into: 0 });
  assert.strictEqual(f.drift, 0);
  assert.strictEqual(f.periodPx, period);
});

check("drift stays within [0, period) and advances with scroll", () => {
  const a = computeFrame({ ...base, into: 100 });
  const b = computeFrame({ ...base, into: 300 });
  assert.ok(a.drift >= 0 && a.drift < period);
  assert.ok(b.drift > a.drift, "drift should grow with scroll within one period");
});

check("loop-back is SEAMLESS: drift identical across a one-period jump", () => {
  for (const into of [900, 1500, 2200, 4321]) {
    const here = computeFrame({ ...base, into });
    const after = computeFrame({ ...base, into: into - here.jumpPx }); // == window.scrollTo(scrollY - jumpPx)
    assert.ok(Math.abs(here.drift - after.drift) < 1e-6,
      `drift jumped at into=${into}: ${here.drift} vs ${after.drift}`);
  }
});

check("shouldLoop only fires once fully revealed (>= vh + 2*jump)", () => {
  assert.strictEqual(computeFrame({ ...base, into: base.vh }).shouldLoop, false);
  assert.strictEqual(computeFrame({ ...base, into: base.vh + 1.9 * jump }).shouldLoop, false);
  assert.strictEqual(computeFrame({ ...base, into: base.vh + 2.1 * jump }).shouldLoop, true);
});

check("jumpPx equals one period of scroll", () => {
  assert.ok(Math.abs(computeFrame({ ...base, into: 0 }).jumpPx - jump) < 1e-6);
});

check("messages escalate every 6 loops and clamp at the last", () => {
  assert.strictEqual(computeFrame({ ...base, into: 0, loops: 0 }).text, MESSAGES[0]);
  assert.strictEqual(computeFrame({ ...base, into: 0, loops: 6 }).text, MESSAGES[1]);
  assert.strictEqual(computeFrame({ ...base, into: 0, loops: 18 }).text, MESSAGES[3]);
  assert.strictEqual(computeFrame({ ...base, into: 0, loops: 999 }).text, MESSAGES[MESSAGES.length - 1]);
});

console.log(`\n${passed} checks passed.`);
