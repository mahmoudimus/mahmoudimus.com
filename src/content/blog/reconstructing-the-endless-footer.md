+++
Title: Reconstructing the endless footer
Date: 2026-06-12
Author: Mahmoud
Tags: web, canvas, javascript, css, animation, frontend
Classification: blog
Status: draft
Excerpt: stripe.dev has a footer that scrolls forever — the wordmark swells into giant outlines you fall through, and it never ends. I wanted one for my own name, so I rebuilt the effect from nothing but the way it behaves. Here is the reconstruction, and why every screenshot I took while building it was a lie.
+++

If you scroll to the bottom of [stripe.dev](https://stripe.dev), the page refuses to end. The "stripe" wordmark swells until the letters are taller than the viewport, you fall through their outlines, and the whole thing keeps going no matter how far you scroll. Scroll back up and it rewinds. It is the most over-built footer on the internet and I have wanted one ever since I first saw it.

So I built one for **mahmoudimus**. This post is how I reconstructed the effect from the outside — by reasoning about what it must be doing rather than how I assumed it worked — and the embarrassing testing detour that ate most of an evening. The proof is at the bottom of this very page; go scroll it, then come back.

## The wrong mental model

My first instinct was that the tunnel is *many copies* of the word, drawn at different depths with a perspective transform — a little particle field of "mahmoudimus" receding to a vanishing point. I wrote that. It worked, in the sense that pixels appeared. But it never looked right. The copies overlapped into mush, the spacing fought me, and the motion was subtly wrong: the real thing is smoother and somehow has *fewer things* in it than my version, even though my version was the one trying to look minimal.

The unlock was realizing the effect is not a crowd. It is **one word**. Everything that looks like depth is a trick of how the canvas is cleared. Once I stopped drawing dozens of copies and started drawing exactly one, every problem I had been fighting disappeared.

## One word, driven by scroll

The wordmark's size and vertical position are not animated by a clock. They are *functions of the scroll position*. That single decision is the whole personality of the effect.

The footer is a tall region sitting after the page content. As you scroll into it, I read how far its top has moved past the top of the viewport, turn that into a progress value, and from progress compute a font size and a baseline `y`. It is a pure function — same scroll, same frame, every time:

```js
// scroll geometry -> what to draw, with no hidden state
//   footerTop = footer.getBoundingClientRect().top
//   vh = innerHeight, dpr = devicePixelRatio, maxW = min(1728, innerWidth)
//   m  = how many times we have looped (0 on the first pass)
function computeTargets({ footerTop, vh, dpr, maxW, m }) {
  const f = footerTop - vh;
  const p = -((f - m * vh) / vh);          // scroll progress through this pass
  let t = (maxW / 6.35) * dpr;             // font size
  if (m > 0) t -= t * Math.sin(p - 2.2) - 0.1 * t; // breathe across loops
  const r = t - t / 3.6;
  const o = vh * dpr + r - p * vh * dpr + m * vh * dpr; // baseline y
  return { fontSize: t, yTarget: m > 0 ? o + vh * dpr : o, clearHeight: o, r };
}
```

The constants are not principled. `6.35`, `3.6`, `2.2` are numbers I nudged until the motion felt right, and I would not defend any of them in a code review. What matters is the *shape*: size and position fall straight out of scroll position with nothing remembered between frames.

That purity buys something I would otherwise have had to engineer: **reversibility for free**. Because the frame is a function of scroll and nothing else, scrolling back up doesn't replay a recording — it recomputes the earlier frames exactly, because the inputs are exactly the earlier inputs. There is no undo stack because there is no state to undo.

The render loop never touches scroll. It just eases the actual size and `y` toward whatever the latest scroll target was, so motion stays buttery even if scroll events arrive in chunks:

```js
function loop() {
  v += (yTarget - v) * 0.1;   // ease toward the scroll-derived targets
  b += (fontSize - b) * 0.1;
  render();
  requestAnimationFrame(loop);
}
```

## The trail *is* the tunnel

Here is the trick I had been faking with copies. Each frame, I clear only the **top slice** of the canvas — not the whole thing:

```js
ctx.clearRect(0, 0, canvas.width, clearHeight - r); // a partial clear
```

The current, biggest version of the word is drawn near the top. Everything below the cleared slice is *leftover paint from previous frames*, back when the word was smaller and sat higher. As the word grows from one frame to the next, it leaves a wake of its former selves stacked beneath it — and that wake reads, unmistakably, as depth. The "3D tunnel of receding copies" is a single word plus a `clearRect` that is deliberately too short. One line of arithmetic does what my entire particle field was straining to imitate.

## White outlines on blue

The letters are not filled in. For each glyph I stroke the outline, then switch the canvas compositing mode to `destination-out` and fill it — which doesn't paint, it *erases* — punching the interior back to transparent:

```js
for (const ch of text) {
  ctx.globalCompositeOperation = "source-over";
  ctx.strokeText(ch, x, y);              // draw the outline
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillText(ch, x, y);                // knock the inside back out
  x += ctx.measureText(ch).width + ls;   // ls is negative — tight spacing
}
```

The canvas sits over an accent-colored backdrop, so the knocked-out interiors reveal that blue. You get crisp white outlines whose insides are exactly the same color as the field around them. It has to be done glyph by glyph, not on the whole string at once: at the tight (negative) letter-spacing the effect uses, adjacent letters overlap, and a single full-string knockout would erase its neighbors' strokes. Per-glyph stroke-then-erase keeps every outline intact.

## Making it endless

A scroll region is finite — mine is `200vh` — so it cannot actually scroll forever. When you reach the bottom, I jump the scroll position back to the top of the region and increment a loop counter `m`:

```js
if (footer.getBoundingClientRect().bottom < vh + 1) {
  m += 1;
  window.scrollTo(0, footer.offsetTop); // seamless jump back to the top
}
```

The math keys off `m`, so the word picks up visually where it left off and the seam is invisible. Across loops I also modulate the font size by `sin(p)` so the zoom *breathes* — it speeds up and eases off instead of sawtoothing back to the start. It is the visual cousin of a [Shepard tone](https://en.wikipedia.org/wiki/Shepard_tone), the audio illusion of a pitch that rises forever without ever getting higher. (The inspiration actually plays a tone as you scroll; I left mine silent.)

## The reveal is pure CSS

None of the JavaScript is responsible for the footer appearing. The region lives at `z-index: -1` behind the page, and the canvas inside it is `position: fixed`:

```css
.site-footer.endless { position: relative; z-index: -1; height: 200vh; }
.ef-backdrop { position: fixed; inset: 0; background: var(--accent); }
.ef-canvas   { position: fixed; height: 100vh; max-width: 1728px; /* … */ }
```

The page content is an opaque block that scrolls up and off; the fixed canvas and its accent backdrop, parked behind it, are simply uncovered. The one piece of stacking trivia that makes it work: the opaque page background lives on the `html` element, and negative-`z-index` children paint *on top of the root element's background* but *behind* normal content. So the footer sits in a perfect sandwich — above the page's base color, below the page's content — and the menu bar floats on top, fixed, never scrolling away.

## Every screenshot I took was a lie

Now the part I am least proud of. I build with a headless browser in the loop: change code, render, screenshot, look. For this effect the screenshots kept coming back **blank**, or showing the wordmark in flat black instead of white. So I would "fix" the color, screenshot, still wrong, fix something else, screenshot, still wrong. I went around this loop more times than I will admit. The code was fine the entire time.

The culprit was `requestAnimationFrame`. Browsers throttle rAF in tabs that aren't visible, and an automation tab is, as far as the compositor is concerned, never visible — `document.visibilityState` is `"hidden"`. So the callback **never fired**. My draw loop had not run a single frame. I was screenshotting a canvas that had never been painted and drawing conclusions about my drawing code from it.

Two things got me out.

First, make the part that can be wrong *not need a browser at all*. The motion is that one pure `computeTargets` function, so it gets ordinary Node unit tests — no DOM, no rAF, no flakiness:

```js
const base = { vh: 900, dpr: 2, maxW: 1728, m: 0 };

// reversibility: identical input must give identical output
assert.deepStrictEqual(
  computeTargets({ ...base, footerTop: 300 }),
  computeTargets({ ...base, footerTop: 300 }),
);

// the baseline moves one way as you scroll in
let prev = Infinity;
for (const footerTop of [900, 450, 0, -450, -900]) {
  const { yTarget } = computeTargets({ ...base, footerTop });
  assert.ok(yTarget < prev); prev = yTarget;
}

// the cleared slice is always a sub-region, so a trail always survives
const t = computeTargets({ ...base, footerTop: 120 });
assert.ok(t.clearHeight - t.r < base.vh * base.dpr);
```

Those tests pinned down everything that actually mattered about the effect — that it retraces, that it moves monotonically, that there is always a trail — without ever opening a browser.

Second, to see a *real frame*, I had to drive the loop by hand in a tab the OS thinks is asleep. `setTimeout` is no help; background tabs clamp it to roughly once per second, far too slow for an ease that converges over dozens of frames. But a `MessageChannel` `postMessage` is **not** throttled when the tab is hidden. So I shimmed `requestAnimationFrame` to pump its callbacks through a message channel, injected the shim before the page loaded, and the animation ran at full speed inside a tab the compositor had written off:

```js
// a rAF that keeps firing even in a hidden/occluded tab
(function () {
  let q = [];
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    const cbs = q; q = [];
    for (const cb of cbs) cb(performance.now());
  };
  window.requestAnimationFrame = (cb) => { q.push(cb); ch.port2.postMessage(0); };
})();
```

The first screenshot after that showed the giant white wordmark and its receding wake, exactly what should have been on screen the whole time. The lesson I keep relearning: **when a visual harness shows you nothing, suspect the harness.** The pixels were never the ground truth. The visibility state was.

## What it adds up to

The finished effect is about 140 lines. A pure function turns scroll into a size and a position. A deliberately-too-short `clearRect` turns one word into a tunnel. A stroke-then-erase turns solid letters into outlines over a colored field. A scroll jump turns a finite region into an infinite one. None of the pieces is clever on its own; the whole is much more than its parts, which is the nicest kind of thing to build.

The proof is at the bottom of this page. Scroll down. Keep going — it won't stop. Then scroll back up and watch it rewind, exactly, because there was never anything to rewind.
