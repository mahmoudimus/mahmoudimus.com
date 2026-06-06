/* sig-viz.js -- interactive figures for the signature-search post.
 *
 * No dependencies, no build step. Loaded only on posts with `Viz: true`
 * (see base.html). Each figure is a `<figure data-sig-viz="NAME">` mount.
 *
 * Every frame is real: it is computed by actually running the
 * seed-then-refine match over a small synthetic byte database, the same
 * filter the real algorithm runs. The counts you see are real counts for
 * that input, not a faked geometric curve.
 *
 * The core (PRNG, database build, frame computation) is exported under
 * module.exports so it can be unit-tested with node; the DOM/SVG rendering
 * is guarded behind a `typeof document` check.
 */
(function () {
  "use strict";

  // ---- tiny deterministic PRNG (mulberry32) -------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- pattern tokens -----------------------------------------------------
  // A token is {wild:true} or {v:<byte>}. parsePattern("0F B6 ?? E8") -> tokens.
  function parsePattern(str) {
    return str
      .trim()
      .split(/\s+/)
      .map(function (t) {
        return t === "??" || t === "?" ? { wild: true } : { v: parseInt(t, 16) & 0xff };
      });
  }

  function hex(b) {
    return b.toString(16).toUpperCase().padStart(2, "0");
  }

  function tokenMatches(db, tok, pos) {
    if (pos < 0 || pos >= db.length) return false;
    return tok.wild ? true : db[pos] === tok.v;
  }

  function fullMatch(db, pattern, p) {
    for (let j = 0; j < pattern.length; j++) {
      if (!tokenMatches(db, pattern[j], p + j)) return false;
    }
    return true;
  }

  function findMatches(db, pattern) {
    const out = [];
    for (let p = 0; p + pattern.length <= db.length; p++) {
      if (fullMatch(db, pattern, p)) out.push(p);
    }
    return out;
  }

  // ---- build a synthetic database whose full pattern is unique ------------
  // Fills with a small alphabet (so short prefixes match in many places),
  // plants the pattern once at `target`, plants a deliberate near-miss (all
  // tokens but the last exact one) at `nearMiss` so the final byte does
  // visible work, then breaks any other accidental full match.
  function buildDatabase(opts) {
    const n = opts.n;
    const alphabet = opts.alphabet;
    const pattern = opts.pattern;
    const rng = mulberry32(opts.seed);
    const db = new Uint8Array(n);
    for (let i = 0; i < n; i++) db[i] = alphabet[(rng() * alphabet.length) | 0];

    const exactIdx = [];
    for (let j = 0; j < pattern.length; j++) if (!pattern[j].wild) exactIdx.push(j);
    const lastExact = exactIdx[exactIdx.length - 1];

    function plant(p) {
      for (let j = 0; j < pattern.length; j++) if (!pattern[j].wild) db[p + j] = pattern[j].v;
    }
    // a value guaranteed not to equal the last exact token
    let breaker = alphabet[0];
    for (const a of alphabet) if (a !== pattern[lastExact].v) { breaker = a; break; }

    if (typeof opts.target === "number") plant(opts.target);
    if (typeof opts.nearMiss === "number") {
      plant(opts.nearMiss);
      db[opts.nearMiss + lastExact] = breaker; // matches all but the last byte
    }

    // enforce global uniqueness of the full pattern (keep only `target`)
    for (let guard = 0; guard < 10000; guard++) {
      const extra = findMatches(db, pattern).filter(function (p) {
        return p !== opts.target;
      });
      if (extra.length === 0) break;
      for (const p of extra) db[p + lastExact] = breaker;
    }
    return db;
  }

  // ---- frames: seed on the first exact token, then refine left to right ---
  // Returns one frame per token from the seed onward. Each frame carries the
  // surviving candidate START positions and whether the step was informative
  // (an exact byte that can shrink) or a wildcard (which never shrinks).
  function computeFrames(db, pattern) {
    let seedIdx = 0;
    while (seedIdx < pattern.length && pattern[seedIdx].wild) seedIdx++;

    let cands = [];
    for (let p = 0; p + pattern.length <= db.length; p++) {
      if (tokenMatches(db, pattern[seedIdx], p + seedIdx)) cands.push(p);
    }
    const frames = [
      { upTo: seedIdx, seed: true, informative: true, candidates: cands.slice(), count: cands.length },
    ];
    for (let j = seedIdx + 1; j < pattern.length; j++) {
      const tok = pattern[j];
      cands = cands.filter(function (p) {
        return tokenMatches(db, tok, p + j);
      });
      frames.push({
        upTo: j,
        seed: false,
        informative: !tok.wild,
        candidates: cands.slice(),
        count: cands.length,
      });
    }
    return frames;
  }

  // ---- 2-byte counting-sort index (CSR) -----------------------------------
  function plainDatabase(n, alphabet, seed) {
    const rng = mulberry32(seed);
    const db = new Uint8Array(n);
    for (let i = 0; i < n; i++) db[i] = alphabet[(rng() * alphabet.length) | 0];
    return db;
  }

  // Group every adjacent-byte window start by its 2-byte key, in key order,
  // and lay the buckets out as one flat `positions` array with a `heads`
  // offset array -- the CSR / counting-sort layout the post describes.
  function computeBuckets(db) {
    const map = new Map();
    for (let i = 0; i + 1 < db.length; i++) {
      const key = (db[i] << 8) | db[i + 1];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(i);
    }
    const keys = Array.from(map.keys()).sort(function (a, b) {
      return a - b;
    });
    const positions = [];
    const heads = [];
    const buckets = [];
    let off = 0;
    for (const k of keys) {
      const ps = map.get(k);
      heads.push(off);
      buckets.push({ key: k, hi: k >> 8, lo: k & 0xff, start: off, len: ps.length, positions: ps });
      for (const p of ps) positions.push(p);
      off += ps.length;
    }
    heads.push(off);
    return { buckets: buckets, positions: positions, heads: heads };
  }

  // ---- seed anchors: every exact 1-byte and 2-byte run, by bucket size ----
  function countByte(db, v) {
    let c = 0;
    for (let i = 0; i < db.length; i++) if (db[i] === v) c++;
    return c;
  }
  function countPair(db, hi, lo) {
    let c = 0;
    for (let i = 0; i + 1 < db.length; i++) if (db[i] === hi && db[i + 1] === lo) c++;
    return c;
  }
  function seedAnchors(db, pattern) {
    const anchors = [];
    const seen = {};
    for (let j = 0; j < pattern.length; j++) {
      const t = pattern[j];
      if (!t.wild && !seen["b" + t.v]) {
        seen["b" + t.v] = 1;
        anchors.push({ width: 1, label: hex(t.v), size: countByte(db, t.v), hi: t.v });
      }
    }
    for (let j = 0; j + 1 < pattern.length; j++) {
      if (!pattern[j].wild && !pattern[j + 1].wild) {
        anchors.push({
          width: 2,
          label: hex(pattern[j].v) + " " + hex(pattern[j + 1].v),
          size: countPair(db, pattern[j].v, pattern[j + 1].v),
          hi: pattern[j].v,
          lo: pattern[j + 1].v,
        });
      }
    }
    let mi = 0;
    for (let i = 1; i < anchors.length; i++) if (anchors[i].size < anchors[mi].size) mi = i;
    anchors.forEach(function (a, i) {
      a.chosen = i === mi;
    });
    return anchors;
  }

  // Build a database in which one wildcard-isolated byte (`rareByte`) is the
  // rarest anchor, so a lone byte beats every available pair -- the point of
  // dynamic seed selection. The base alphabet excludes rareByte; it is then
  // sprinkled `rareCount` times, and the full pattern is planted once.
  function buildSeedDatabase(opts) {
    const rng = mulberry32(opts.seed);
    const db = new Uint8Array(opts.n);
    for (let i = 0; i < opts.n; i++) db[i] = opts.alphabet[(rng() * opts.alphabet.length) | 0];
    const pattern = opts.pattern;
    const exactIdx = [];
    for (let j = 0; j < pattern.length; j++) if (!pattern[j].wild) exactIdx.push(j);
    const lastExact = exactIdx[exactIdx.length - 1];
    let breaker = opts.alphabet[0];
    for (const a of opts.alphabet) if (a !== pattern[lastExact].v) { breaker = a; break; }

    function plant(p) {
      for (let j = 0; j < pattern.length; j++) if (!pattern[j].wild) db[p + j] = pattern[j].v;
    }
    if (typeof opts.target === "number") plant(opts.target);
    // sprinkle the rare byte (count includes the one planted at target)
    let placed = countByte(db, opts.rareByte);
    let guard = 0;
    while (placed < opts.rareCount && guard++ < 100000) {
      const p = (rng() * opts.n) | 0;
      if (db[p] !== opts.rareByte && !(p >= opts.target && p < opts.target + pattern.length)) {
        db[p] = opts.rareByte;
        placed++;
      }
    }
    for (let g = 0; g < 10000; g++) {
      const extra = findMatches(db, pattern).filter(function (p) {
        return p !== opts.target;
      });
      if (extra.length === 0) break;
      for (const p of extra) db[p + lastExact] = breaker;
    }
    return db;
  }

  // node export for unit testing -------------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      mulberry32: mulberry32,
      parsePattern: parsePattern,
      buildDatabase: buildDatabase,
      computeFrames: computeFrames,
      findMatches: findMatches,
      tokenMatches: tokenMatches,
      plainDatabase: plainDatabase,
      computeBuckets: computeBuckets,
      seedAnchors: seedAnchors,
      buildSeedDatabase: buildSeedDatabase,
      countByte: countByte,
      countPair: countPair,
    };
  }

  // ========================================================================
  // Browser rendering. Everything below is skipped under node.
  // ========================================================================
  if (typeof document === "undefined") return;

  const SVGNS = "http://www.w3.org/2000/svg";
  function svg(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  const DEFAULTS = {
    refine: {
      n: 360,
      cols: 30,
      seed: 0x53494742,
      alphabet: [0x0f, 0xb6, 0x8b, 0x45, 0xe8, 0x48],
      pattern: "0F B6 ?? 8B 45 ?? E8",
      target: 196,
      nearMiss: 71,
    },
    index: {
      n: 24,
      seed: 0x1234,
      alphabet: [0x8b, 0x45, 0xe8],
    },
    seed: {
      n: 300,
      seed: 0x7777,
      alphabet: [0x8b, 0x45, 0xe8, 0xb6],
      pattern: "0F ?? 8B 45 ?? E8",
      rareByte: 0x0f,
      rareCount: 4,
      target: 150,
    },
    cost: {
      n: 16000000,
      perAnchor: 110000,
      a: 12,
      l: 24,
      aMax: 16,
      lMax: 40,
    },
  };

  function readConfig(mount) {
    const name = mount.getAttribute("data-sig-viz");
    const cfg = Object.assign({}, DEFAULTS[name] || {});
    const inline = mount.querySelector('script[type="application/json"]');
    if (inline) {
      try {
        Object.assign(cfg, JSON.parse(inline.textContent));
      } catch (e) {
        /* fall back to defaults */
      }
    }
    return cfg;
  }

  function buildRefine(mount, cfg) {
    const pattern = parsePattern(cfg.pattern);
    const alphabet = cfg.alphabet.slice();
    // make sure every exact token value is in the alphabet
    for (const tok of pattern) if (!tok.wild && alphabet.indexOf(tok.v) === -1) alphabet.push(tok.v);

    const db = buildDatabase({
      n: cfg.n,
      alphabet: alphabet,
      pattern: pattern,
      seed: cfg.seed,
      target: cfg.target,
      nearMiss: cfg.nearMiss,
    });
    const frames = computeFrames(db, pattern);
    const total = frames[0].count;

    const reduced =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // --- layout ---
    const cols = cfg.cols;
    const rows = Math.ceil(cfg.n / cols);
    const pitch = 12,
      size = 10;
    const gridW = cols * pitch,
      gridH = rows * pitch;

    mount.classList.add("sigviz", "sigviz-refine");

    // pattern chips
    const chips = document.createElement("div");
    chips.className = "sigviz-pattern";
    const chipEls = pattern.map(function (tok, j) {
      const c = document.createElement("span");
      c.className = "sigviz-chip" + (tok.wild ? " wild" : "");
      c.textContent = tok.wild ? "??" : hex(tok.v);
      c.setAttribute("data-tok", String(j));
      chips.appendChild(c);
      return c;
    });

    // svg grid
    const grid = svg("svg", {
      class: "sigviz-grid",
      viewBox: "0 0 " + gridW + " " + gridH,
      role: "img",
    });
    const cells = new Array(cfg.n);
    for (let i = 0; i < cfg.n; i++) {
      const r = svg("rect", {
        x: (i % cols) * pitch,
        y: ((i / cols) | 0) * pitch,
        width: size,
        height: size,
        rx: 1.5,
        class: "cell",
      });
      cells[i] = r;
      grid.appendChild(r);
    }

    // sparkline of count vs step (decay curve)
    const spW = 220,
      spH = 54;
    const spark = svg("svg", { class: "sigviz-spark", viewBox: "0 0 " + spW + " " + spH });
    const maxC = Math.max(1, total);
    const stepX = frames.length > 1 ? spW / (frames.length - 1) : 0;
    function spy(c) {
      return spH - 4 - (Math.log(c + 1) / Math.log(maxC + 1)) * (spH - 8);
    }
    let dPath = "";
    frames.forEach(function (f, k) {
      dPath += (k === 0 ? "M" : "L") + (k * stepX).toFixed(1) + " " + spy(f.count).toFixed(1) + " ";
    });
    spark.appendChild(svg("path", { class: "spark-line", d: dPath }));
    const sparkDot = svg("circle", { class: "spark-dot", r: 3, cx: 0, cy: spy(frames[0].count) });
    spark.appendChild(sparkDot);

    // controls + readout
    const bar = document.createElement("div");
    bar.className = "sigviz-controls";
    function button(label, aria) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-label", aria);
      return b;
    }
    const bReset = button("↺ Reset", "Reset to the seed");
    const bPrev = button("‹ Back", "Remove the last byte");
    const bStep = button("Append byte ›", "Append the next pattern byte");
    const bPlay = button("▶ Play", "Play the refinement");
    const out = document.createElement("output");
    out.className = "sigviz-count";
    out.setAttribute("aria-live", "polite");
    [bReset, bPrev, bStep, bPlay, out].forEach(function (e) {
      bar.appendChild(e);
    });

    const caption = document.createElement("figcaption");

    mount.appendChild(chips);
    mount.appendChild(grid);
    const meta = document.createElement("div");
    meta.className = "sigviz-meta";
    meta.appendChild(spark);
    meta.appendChild(bar);
    mount.appendChild(meta);
    mount.appendChild(caption);

    // --- state + render ---
    let cur = 0;
    let timer = null;

    function render() {
      const f = frames[cur];
      const live = new Set(f.candidates);
      for (let i = 0; i < cfg.n; i++) {
        const startable = i + pattern.length <= cfg.n;
        const c = cells[i];
        const on = live.has(i);
        c.setAttribute(
          "class",
          "cell" + (on ? " on" : "") + (!startable ? " edge" : "") + (on && f.count === 1 ? " win" : "")
        );
      }
      chipEls.forEach(function (c, j) {
        c.classList.toggle("active", j === f.upTo);
        c.classList.toggle("seen", j <= f.upTo);
      });
      sparkDot.setAttribute("cx", (cur * stepX).toFixed(1));
      sparkDot.setAttribute("cy", spy(f.count).toFixed(1));

      const shown = pattern
        .slice(0, f.upTo + 1)
        .map(function (t) {
          return t.wild ? "??" : hex(t.v);
        })
        .join(" ");
      out.textContent = f.count + (f.count === 1 ? " match" : " matches");
      let note;
      if (f.seed) note = "Seed on the first exact byte: " + total + " candidate positions.";
      else if (!f.informative) note = "Appended a wildcard. It matches anything, so the set does not shrink.";
      else if (f.count === 1) note = "The set has collapsed to one position. This length is unique.";
      else note = "Appended an exact byte. Positions that disagree drop out.";
      caption.innerHTML = "<code>" + shown + "</code>: " + note;

      bStep.disabled = cur >= frames.length - 1;
      bPrev.disabled = cur <= 0;
    }

    function go(k) {
      cur = Math.max(0, Math.min(frames.length - 1, k));
      render();
    }
    function stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        bPlay.textContent = "▶ Play";
        bPlay.setAttribute("aria-label", "Play the refinement");
      }
    }
    function play() {
      if (timer) {
        stop();
        return;
      }
      if (cur >= frames.length - 1) go(0);
      bPlay.textContent = "❚❚ Pause";
      bPlay.setAttribute("aria-label", "Pause");
      timer = setInterval(function () {
        if (cur >= frames.length - 1) {
          stop();
          return;
        }
        go(cur + 1);
      }, reduced ? 350 : 900);
    }

    bReset.addEventListener("click", function () {
      stop();
      go(0);
    });
    bPrev.addEventListener("click", function () {
      stop();
      go(cur - 1);
    });
    bStep.addEventListener("click", function () {
      stop();
      go(cur + 1);
    });
    bPlay.addEventListener("click", play);

    render();
  }

  // ---- figure: the 2-byte counting-sort index (CSR) ----------------------
  function buildIndex(mount, cfg) {
    const db = plainDatabase(cfg.n, cfg.alphabet, cfg.seed);
    const csr = computeBuckets(db);
    const buckets = csr.buckets;
    mount.classList.add("sigviz", "sigviz-index");

    // database strip
    const dbPitch = 22,
      dbSize = 20,
      dbH = 24;
    const dbSvg = svg("svg", {
      class: "sigviz-strip",
      viewBox: "0 0 " + cfg.n * dbPitch + " " + dbH,
      role: "img",
    });
    const dbCells = [];
    for (let i = 0; i < cfg.n; i++) {
      dbSvg.appendChild(
        (function () {
          const r = svg("rect", { x: i * dbPitch, y: 2, width: dbSize, height: dbSize, rx: 2, class: "dbcell" });
          dbCells.push(r);
          return r;
        })()
      );
      const t = svg("text", { x: i * dbPitch + dbSize / 2, y: 16, class: "dblabel", "text-anchor": "middle" });
      t.textContent = hex(db[i]);
      dbSvg.appendChild(t);
    }

    // positions array, grouped by key
    const pPitch = 20,
      pSize = 18,
      gap = 8;
    const posMeta = [];
    let x = 0;
    buckets.forEach(function (b, bi) {
      for (let k = 0; k < b.len; k++) {
        posMeta.push({ bi: bi, x: x });
        x += pPitch;
      }
      x += gap;
    });
    const posSvg = svg("svg", { class: "sigviz-strip", viewBox: "0 0 " + x + " 40", role: "img" });
    const posCells = [];
    posMeta.forEach(function (m, idx) {
      const r = svg("rect", { x: m.x, y: 2, width: pSize, height: pSize, rx: 2, class: "poscell" });
      const t = svg("text", { x: m.x + pSize / 2, y: 16, class: "poslabel", "text-anchor": "middle" });
      t.textContent = String(csr.positions[idx]);
      posSvg.appendChild(r);
      posSvg.appendChild(t);
      posCells.push({ rect: r, bi: m.bi });
    });
    buckets.forEach(function (b, bi) {
      const mine = posMeta.filter(function (m) {
        return m.bi === bi;
      });
      const cx = (mine[0].x + mine[mine.length - 1].x + pSize) / 2;
      const t = svg("text", { x: cx, y: 35, class: "keylabel", "text-anchor": "middle" });
      t.textContent = hex(b.hi) + hex(b.lo);
      posSvg.appendChild(t);
    });

    const legend = document.createElement("div");
    legend.className = "sigviz-legend";
    const keyBtns = buckets.map(function (b, bi) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "keybtn";
      btn.textContent = hex(b.hi) + " " + hex(b.lo) + " (" + b.len + ")";
      btn.setAttribute("aria-label", "Show bucket " + hex(b.hi) + hex(b.lo));
      btn.addEventListener("click", function () {
        select(bi);
      });
      legend.appendChild(btn);
      return btn;
    });

    const out = document.createElement("output");
    out.className = "sigviz-count";
    out.setAttribute("aria-live", "polite");
    const caption = document.createElement("figcaption");

    function rowLabel(text) {
      const d = document.createElement("div");
      d.className = "sigviz-rowlabel";
      d.textContent = text;
      return d;
    }
    mount.appendChild(rowLabel("database (one cell per byte)"));
    mount.appendChild(dbSvg);
    mount.appendChild(rowLabel("positions, grouped by 2-byte key: the whole index"));
    mount.appendChild(posSvg);
    mount.appendChild(legend);
    const ctr = document.createElement("div");
    ctr.className = "sigviz-controls";
    ctr.appendChild(out);
    mount.appendChild(ctr);
    mount.appendChild(caption);

    let sel = 0;
    buckets.forEach(function (b, bi) {
      if (b.len > buckets[sel].len) sel = bi;
    });

    function select(bi) {
      sel = bi;
      const b = buckets[bi];
      const inB = new Set(b.positions);
      for (let i = 0; i < cfg.n; i++) {
        dbCells[i].setAttribute(
          "class",
          "dbcell" + (inB.has(i) ? " hit-start" : inB.has(i - 1) ? " hit-cont" : "")
        );
      }
      posCells.forEach(function (pc) {
        pc.rect.classList.toggle("on", pc.bi === bi);
      });
      keyBtns.forEach(function (btn, i) {
        btn.classList.toggle("active", i === bi);
      });
      out.textContent = hex(b.hi) + hex(b.lo) + ": " + b.len + (b.len === 1 ? " spot" : " spots");
      caption.innerHTML =
        "Bucket <code>" + hex(b.hi) + " " + hex(b.lo) + "</code> = <code>positions[" + csr.heads[bi] + ":" +
        csr.heads[bi + 1] + "]</code>, size " + b.len + " = <code>heads[k+1] - heads[k]</code>. One " +
        "counting-sort pass builds this once; every lookup after is an O(1) slice.";
    }
    select(sel);
  }

  // ---- figure: dynamic seed selection + the free 1-byte marginal ----------
  function buildSeed(mount, cfg) {
    const pattern = parsePattern(cfg.pattern);
    const db = buildSeedDatabase({
      n: cfg.n,
      alphabet: cfg.alphabet.slice(),
      seed: cfg.seed,
      pattern: pattern,
      rareByte: cfg.rareByte,
      rareCount: cfg.rareCount,
      target: cfg.target,
    });
    const anchors = seedAnchors(db, pattern);
    const csr = computeBuckets(db);
    const maxSize = Math.max.apply(
      null,
      anchors.map(function (a) {
        return a.size;
      })
    );
    mount.classList.add("sigviz", "sigviz-seed");

    const chips = document.createElement("div");
    chips.className = "sigviz-pattern";
    pattern.forEach(function (tok) {
      const c = document.createElement("span");
      c.className = "sigviz-chip seen" + (tok.wild ? " wild" : "");
      c.textContent = tok.wild ? "??" : hex(tok.v);
      chips.appendChild(c);
    });

    const bars = document.createElement("div");
    bars.className = "sigviz-bars";
    const rowEls = anchors.map(function (a, i) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sigviz-bar" + (a.chosen ? " chosen" : "");
      row.setAttribute("aria-label", "Anchor " + a.label + ", bucket size " + a.size);
      const lab = document.createElement("span");
      lab.className = "bar-label";
      lab.textContent = (a.width === 1 ? "1-byte " : "2-byte ") + a.label;
      const track = document.createElement("span");
      track.className = "bar-track";
      const fill = document.createElement("span");
      fill.className = "bar-fill";
      fill.style.width = ((a.size / maxSize) * 100).toFixed(1) + "%";
      track.appendChild(fill);
      const num = document.createElement("span");
      num.className = "bar-num";
      num.textContent = String(a.size);
      row.appendChild(lab);
      row.appendChild(track);
      row.appendChild(num);
      if (a.chosen) {
        const tag = document.createElement("span");
        tag.className = "bar-tag";
        tag.textContent = "seed";
        row.appendChild(tag);
      }
      row.addEventListener("click", function () {
        select(i);
      });
      bars.appendChild(row);
      return row;
    });

    // positions band, faint-colored by high byte
    const bandW = 600,
      bandH = 16;
    const total = csr.positions.length;
    const cellW = bandW / total;
    const highs = [];
    csr.buckets.forEach(function (b) {
      if (highs.indexOf(b.hi) === -1) highs.push(b.hi);
    });
    const PALETTE = ["#cfe0ee", "#dfe6cf", "#eedfd0", "#e2d6ea", "#d6eae6", "#efe2cf", "#dde0e6"];
    const band = svg("svg", {
      class: "sigviz-band",
      viewBox: "0 0 " + bandW + " " + bandH,
      preserveAspectRatio: "none",
      role: "img",
    });
    const bandCells = [];
    let xi = 0;
    csr.buckets.forEach(function (b) {
      for (let k = 0; k < b.len; k++) {
        const r = svg("rect", {
          x: (xi * cellW).toFixed(2),
          y: 0,
          width: (cellW + 0.4).toFixed(2),
          height: bandH,
          class: "bandcell",
          fill: PALETTE[highs.indexOf(b.hi) % PALETTE.length],
        });
        band.appendChild(r);
        bandCells.push({ hi: b.hi, key: b.key, rect: r });
        xi++;
      }
    });

    const out = document.createElement("output");
    out.className = "sigviz-count";
    out.setAttribute("aria-live", "polite");
    const caption = document.createElement("figcaption");

    const lab = document.createElement("div");
    lab.className = "sigviz-rowlabel";
    lab.textContent = "positions, by 2-byte key: a 1-byte bucket is one contiguous span";
    mount.appendChild(chips);
    mount.appendChild(bars);
    mount.appendChild(lab);
    mount.appendChild(band);
    const ctr = document.createElement("div");
    ctr.className = "sigviz-controls";
    ctr.appendChild(out);
    mount.appendChild(ctr);
    mount.appendChild(caption);

    function select(i) {
      const a = anchors[i];
      const k2 = (a.hi << 8) | a.lo;
      rowEls.forEach(function (r, j) {
        r.classList.toggle("active", j === i);
      });
      bandCells.forEach(function (bc) {
        const on = a.width === 1 ? bc.hi === a.hi : bc.key === k2;
        bc.rect.classList.toggle("lit", on);
      });
      out.textContent = a.label + ": " + a.size + (a.size === 1 ? " position" : " positions");
      if (a.width === 1) {
        caption.innerHTML =
          "The 1-byte anchor <code>" + a.label + "</code> is every key whose high byte is <code>" + hex(a.hi) +
          "</code>: one contiguous span of <code>positions</code>, read off as <code>heads[(b+1)&lt;&lt;8] - " +
          "heads[b&lt;&lt;8]</code>, with no second index or extra memory to keep." +
          (a.chosen ? " And here it is the rarest anchor of all, so a lone byte beats every pair." : "");
      } else {
        caption.innerHTML =
          "The 2-byte anchor <code>" + a.label + "</code> is a single key's slice of <code>positions</code>. " +
          "A pair is never more common than its rarest byte, yet here the lone <code>" + hex(cfg.rareByte) +
          "</code> still wins.";
      }
    }
    let def = 0;
    anchors.forEach(function (a, i) {
      if (a.chosen) def = i;
    });
    select(def);
  }

  // ---- figure: cost contrast (naive rescan vs index-once) ----------------
  function buildCost(mount, cfg) {
    mount.classList.add("sigviz", "sigviz-cost");
    const N = cfg.n,
      per = cfg.perAnchor;
    const refMax = N * cfg.aMax * cfg.lMax; // bar reference = worst case
    let A = cfg.a,
      L = cfg.l;

    function fmt(x) {
      if (x >= 1e9) return (x / 1e9).toFixed(2) + " billion";
      if (x >= 1e6) return (x / 1e6).toFixed(1) + " million";
      if (x >= 1e3) return Math.round(x / 1e3) + "k";
      return String(Math.round(x));
    }

    // sliders
    const sliders = document.createElement("div");
    sliders.className = "sigviz-sliders";
    function slider(text, min, max, val, set) {
      const wrap = document.createElement("label");
      wrap.className = "sigviz-slider";
      const name = document.createElement("span");
      name.className = "slider-name";
      name.textContent = text;
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(min);
      input.max = String(max);
      input.value = String(val);
      input.step = "1";
      const valEl = document.createElement("span");
      valEl.className = "slider-val";
      valEl.textContent = String(val);
      input.addEventListener("input", function () {
        valEl.textContent = input.value;
        set(parseInt(input.value, 10));
        update();
      });
      wrap.appendChild(name);
      wrap.appendChild(input);
      wrap.appendChild(valEl);
      return wrap;
    }
    sliders.appendChild(
      slider("anchors A", 1, cfg.aMax, A, function (v) {
        A = v;
      })
    );
    sliders.appendChild(
      slider("lengths L", 1, cfg.lMax, L, function (v) {
        L = v;
      })
    );

    function costRow(name, cls) {
      const row = document.createElement("div");
      row.className = "cost-row";
      const nm = document.createElement("span");
      nm.className = "cost-name";
      nm.textContent = name;
      const track = document.createElement("span");
      track.className = "cost-track";
      const fill = document.createElement("span");
      fill.className = "cost-fill " + cls;
      track.appendChild(fill);
      const val = document.createElement("span");
      val.className = "cost-val";
      row.appendChild(nm);
      row.appendChild(track);
      row.appendChild(val);
      return { row: row, fill: fill, val: val };
    }
    const naive = costRow("naive rescan", "naive");
    const idx = costRow("index once, then refine", "indexed");

    const ratio = document.createElement("div");
    ratio.className = "cost-ratio";
    ratio.setAttribute("aria-live", "polite");
    const caption = document.createElement("figcaption");

    const note = document.createElement("div");
    note.className = "sigviz-rowlabel";
    note.textContent = "database fixed at N = 16 MB; bytes touched is the unit of work";

    mount.appendChild(sliders);
    mount.appendChild(note);
    mount.appendChild(naive.row);
    mount.appendChild(idx.row);
    mount.appendChild(ratio);
    mount.appendChild(caption);

    function update() {
      const naiveBytes = A * L * N;
      const idxBytes = N + A * per;
      const r = naiveBytes / idxBytes;
      naive.fill.style.width = ((naiveBytes / refMax) * 100).toFixed(2) + "%";
      idx.fill.style.width = ((idxBytes / refMax) * 100).toFixed(3) + "%";
      naive.val.innerHTML =
        fmt(naiveBytes) + " bytes<span class='cost-sub'>" + A * L + " full passes</span>";
      idx.val.innerHTML =
        fmt(idxBytes) + " bytes<span class='cost-sub'>1 pass + " + A + " bucket reads</span>";
      ratio.textContent = "the index does about " + Math.round(r) + "x less work here";
      // at A=12, L=24 the naive side reproduces the measured 462 s
      const naiveSecs = Math.round((naiveBytes / (12 * 24 * N)) * 462);
      caption.innerHTML =
        "Naive rescans the whole database once per length per anchor: <code>A&#183;L</code> full passes, " +
        "<code>O(A&#183;L&#183;N)</code>. The index is built once and then reads only buckets, " +
        "<code>O(N + per-anchor)</code>. At the pure-Python scan rate that produced the measured " +
        "<strong>462 s</strong> (A = 12, L = 24), the naive side here is about <strong>" + naiveSecs +
        " s</strong>; the indexed side stays in the low seconds. Drag the knobs: the naive cost grows with " +
        "the product <code>A&#183;L</code>, the indexed cost barely moves.";
    }
    update();
  }

  const BUILDERS = {
    refine: buildRefine,
    index: buildIndex,
    seed: buildSeed,
    cost: buildCost,
  };

  function init() {
    const mounts = document.querySelectorAll("[data-sig-viz]");
    mounts.forEach(function (mount) {
      const name = mount.getAttribute("data-sig-viz");
      const build = BUILDERS[name];
      if (build) build(mount, readConfig(mount));
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
