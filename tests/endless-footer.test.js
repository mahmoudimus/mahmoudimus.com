/* Unit test for the endless footer's pure math: the reversible tunnel phase and the
   perspective projection. No DOM, no real rAF. Run: node tests/endless-footer.test.js */
"use strict";
const assert = require("node:assert");
const { computeFrame, project, FOCAL, SPEED } = require("../src/themes/zed/static/js/endless-footer.js");

let passed = 0;
function check(name, fn) { fn(); passed++; console.log("  ok  " + name); }

check("phase is 0 before the region is entered, and clamps at 0", () => {
  assert.strictEqual(computeFrame({ into: 0, vh: 800 }).phase, 0);
  assert.strictEqual(computeFrame({ into: -500, vh: 800 }).phase, 0);
});

check("phase is monotonic and REVERSIBLE with scroll (same input -> same output)", () => {
  const vh = 800;
  let prev = -1;
  for (const into of [0, 100, 400, 800, 1600, 3000]) {
    const ph = computeFrame({ into, vh }).phase;
    assert.ok(ph >= prev, `phase should not decrease as you scroll down (into=${into})`);
    prev = ph;
  }
  // reversible: recomputing at an earlier scroll yields the exact earlier phase
  assert.strictEqual(computeFrame({ into: 400, vh }).phase, computeFrame({ into: 400, vh }).phase);
  assert.ok(computeFrame({ into: 400, vh }).phase < computeFrame({ into: 800, vh }).phase);
});

check("phase advances SPEED periods per half-viewport of scroll", () => {
  const vh = 800;
  assert.ok(Math.abs(computeFrame({ into: vh * 0.5, vh }).phase - SPEED) < 1e-9);
});

check("project: scale is 1 at the camera and decreases with depth", () => {
  assert.ok(Math.abs(project(0, FOCAL) - 1) < 1e-9);
  assert.ok(project(1, FOCAL) < project(0, FOCAL));
  assert.ok(project(8, FOCAL) < project(1, FOCAL));
  assert.ok(project(100, FOCAL) > 0 && project(100, FOCAL) < 0.02, "far copies shrink toward 0");
});

console.log(`\n${passed} checks passed.`);
