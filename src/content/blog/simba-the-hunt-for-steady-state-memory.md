+++
Title: Simba, Part 4: The Hunt for Steady-State Memory
Slug: simba-part-4-hunt-for-steady-state-memory
Date: 2026-07-23
Status: draft
Author: Mahmoud
Tags: memory, debugging, macos, malloc, observability, daemons, postmortem, agents
Classification: blog
Toc: true
Excerpt: A memory daemon that kept ballooning to tens of gigabytes, a five-day forensic hunt, and the observability ladder that finally named every layer of it. This one is about the process — the wrong turns, the instrument that lied, and how to read an allocator call tree like a sentence — because the fixes were easy once the hunt was done.
+++

> **The one-line version:** simba's memory daemon kept ballooning — 8GB, 16GB, eventually a
> 52GB Python process — and every fix I shipped was real and none of them was sufficient.
> This post is not about the fixes. It's about the *hunt*: the instrument that lied to me,
> the ladder of increasingly sharp tools, the false victories, and the final capture that
> read like a sentence once I'd learned the language. The resolution took minutes each
> time. Knowing *what to resolve* took five days, and that process is the transferable part.

## The symptom, and why "restart it" wasn't an answer

simba runs as a local daemon: LanceDB vector store, in-process GGUF embedder, an HTTP API
that every agent session on the machine fires hooks at. It is exactly the kind of process
that should idle at a few hundred megabytes. Instead, over a few days in mid-July, it kept
climbing: watchdog warnings at 3GB, hard-limit restarts at 6GB, then peaks the watchdog
somehow never saw — 16GB, 30GB, and finally a Python process holding a **52GB footprint**
while my machine's fans announced it before Activity Monitor did.

A daemon that leaks invites a lazy answer: restart it on a timer and move on. I had a
watchdog that did exactly that, and it turned the leak into a *cascade* — boot, hooks
re-fire, balloon, hard limit, restart, repeat, a five-minute crash loop that made the
memory layer worse than no memory layer. The restart was treating the symptom I could see.
The whole problem was that I couldn't see the cause.

What follows is organized the way the hunt actually went: as an **observability ladder**,
where each rung earned the next one, and as a sequence of confident diagnoses that were
each *true* and each *not enough*.

## Rung 0: logs tell you THAT, never WHY

The watchdog logged edge-triggered crossings: `soft limit crossed: rss=4967MB`. That's a
smoke alarm — one bit of information, no timeline, no attribution. The first thing I built
wasn't a fix; it was a **ring buffer of RSS samples** surfaced in the health endpoint, so
an incident had a shape instead of a single number. That immediately produced the first
real observation: the balloons weren't slow leaks. They were **bursts** — gigabytes per
30-second tick, sometimes ±3GB within a single window.

That observation constrained everything after it. A slow leak you can catch with periodic
snapshots. A burst you have to catch *in the act*, which means your tooling has to already
be attached when it happens.

## Rung 1: sample at the trigger instant, not after it

The next tool was the stock macOS `sample` — a stack profiler you can point at a live pid.
My first captures were useless in an instructive way: by the time a human (or a
15-second-poll watcher) reacted to a threshold, the burst was over, and every thread
showed as parked. **All threads idle in both captures** is itself data: it means the work
comes in slices shorter than your reaction time.

So the watcher script changed contract: on trigger, `sample` fires *immediately and in the
background* — capture first, ask questions later. The first in-the-act capture paid for
the whole tool: an executor thread spending 89% of its time inside Python's
`TextIOWrapper.read → IncrementalNewlineDecoder.decode`, while the event loop sat at 97%
in `take_gil`[^gil]. One frame stack explained three symptoms I'd been treating as separate
mysteries — the memory burst (a whole multi-megabyte transcript being decoded into
temporary copies), the uniform ~90-second recall latencies (every request queued behind a
held GIL), and the health endpoint going silent (the event loop starved by the same lock).

That's the first process lesson worth writing down: **when one capture explains three
symptoms, you're finally holding the right instrument.** Correlation across dashboards had
given me three separate investigations. One stack gave me one cause.

The fix for that particular slurp was easy (stream line-by-line, yield between lines, cap
the size). The balloons continued. Which brings me to the shape of the whole hunt.

## The ratchet of "found it!" — and yet

Over the next days, the same pattern repeated with an almost comedic rhythm. Each round: a
capture, a real culprit, a real fix, a night of hope, and a fresh balloon in the morning.
The ledger of *genuine* culprits, each independently confirmed by attribution and each
independently insufficient:

| Round | Culprit found (real!) | And yet |
|---|---|---|
| 1 | consolidation passes pulling the full memory corpus per run | balloons continued |
| 2 | a transcript export decoding whole files under the GIL | balloons continued |
| 3 | an embedding cache grown to 1.3GB, unbounded by design | balloons continued |
| 4 | 13 database scans materializing 1024-dim vectors into ~10M heap objects | balloons continued |
| 5 | a document store retaining full transcripts *and* their line-split copies | balloons continued |
| 6 | a session indexer slurping whole files | **balloons continued** |

Every one of those was a bug. Every fix was measurable in isolation (the cache went from
1.3GB to 16KB; a stats endpoint went from 1.5s to 40ms; the store stopped retaining
21GB of split strings from one giant transcript). And the system still ballooned, because
**a long-lived incident is almost never one cause.** It's sediment: layers laid down over
months of feature work, and draining the lake one layer at a time just exposes the next
layer.

The process failure to avoid here is declaring victory on attribution alone. The discipline
that eventually worked: after every fix, *assume there's another layer* and keep the
instruments armed. The phrase I started using in my notes was "necessary but not
sufficient," and it appears there six times.

## Rung 2: learn to read region shapes

Between stack captures, the cheap tool was `footprint`/`vmmap` region summaries, and they
turned out to carry a fingerprint I learned to read like a field guide:

- **MALLOC_LARGE-dominated** growth = a few enormous buffers. Whole-file reads, giant
  decodes, big materializations. Stack sampling catches these if you're fast.
- **MALLOC_SMALL-dominated** growth (2GB across a thousand regions) = *millions of tiny
  allocations*. Object churn. This shape is nearly invisible to stack sampling — no single
  slice is hot — and it's the shape that tells you you've outgrown sampling entirely.

Round 4's culprit announced itself this way: the region shape flipped from LARGE to
SMALL-dominated, which said "stop looking for one big read; look for something making ten
million small objects." That reframing — from *where is the time going* to *what does the
allocation population look like* — is what justified climbing to the last rung.

## Rung 3: attribution of live bytes, or: arm before the fire

The endgame tool on macOS is `MallocStackLogging` plus `malloc_history -callTree`: for
every *currently live* allocation, the full stack that allocated it, aggregated into a
tree with byte totals. Not where time went — where the **resident gigabytes came from**,
byte by byte, with names.

It has one operational catch that shaped the engineering: the environment variable must be
set **when the process spawns**. You cannot attach it to a running balloon. And my daemon
is spawned by whatever agent session's hook notices it's down — so "just relaunch it
armed" doesn't survive the first automatic restart. The fix was to make arming a
first-class config flag: the hook auto-start path injects the variable when the flag is
set, restarts inherit it through the exec chain, and every boot logs whether it's armed.
That sounds like bureaucracy. It's the difference between forensics being a heroic manual
act and being *ambient* — and the final three culprits were all caught by daemons that had
been armed days earlier by plumbing, not by me being at the keyboard at the right moment.

**Arm before the fire.** If a diagnostic needs to be present at spawn time, it needs to be
config, not ceremony.

## The instrument that lied: resident vs footprint

The most valuable single discovery of the hunt wasn't a leak at all. It was my tripwire.

The watchdog gated on **resident set size** — the number `ps` gives you, the number every
watchdog tutorial reaches for. The 52GB process that finally forced a full stop showed
**~360MB resident** at the moment its physical footprint read 52GB. macOS had compressed
and swapped the balloon *out of residency*, so the metric my alarm watched went **down**
as the disaster got worse. The hard limit never tripped. It structurally could not trip.

The numbers diverge exactly when it matters: a healthy process's resident and footprint
track each other; a ballooning process's footprint (which counts dirty + compressed +
swapped pages — the number Activity Monitor shows, the number the OS uses when it decides
to kill something) runs away while the compressor politely shrinks residency. My watchdog
was reading the one number engineered to look fine under pressure.

The fix was one field in a struct the code already parsed. Finding it required watching a
52GB process sail under a 6GB limit and refusing to call that anything but the alarm's
fault. **Audit your tripwire against the number your OS actually uses to kill you** — and
when a limit that should have fired didn't, treat the limit as the bug before the leak.

## Reading the final capture like a sentence

With the watchdog honest and everything armed, the last balloon gave itself up in a single
call tree, and I want to show the reading process, because this is the most transferable
skill of the whole arc. The tree said, in order:

1. `thread_start → ... → context_run → partial_vectorcall` — *these allocations happened
   on executor threads*, and the `Context.run`-wrapping-a-`partial` shape is precisely
   what Python's `asyncio.to_thread` compiles to. So: async handlers offloading sync work.
2. `_io_TextIOWrapper_read` holding ~2GB raw readalls plus enormous UTF-8/newline decode
   buffers — *someone reads an entire multi-gigabyte text file in one call*.
3. `unicode_split` holding ~2.4GB across ~85,000 live strings — *and then splits the whole
   thing on newlines*.
4. Five live instances of the pattern — *five concurrent requests were doing this at
   capture time*, a number I could line up against the daemon's per-endpoint request
   counters like matching fingerprints at a crime scene.

Read aloud, the tree is a sentence: *"executor threads, serving concurrent hook requests,
each read an entire ~2GB transcript into one string and split it into lines."* At that
point you don't debug — you **grep for the sentence**: whole-file `read_text()` followed
by `.split("\n")`, reachable from a hook handler. It matched a function whose job was to
find the *last* thinking block in a transcript — data that lives at the *end* of the file —
by reading all of it, on the highest-frequency hook the host exposes, the one that fires
on **every single tool call**.

Two details from that final culprit deserve their own lines, because both are reusable
warnings:

- **The guard was inverted.** A sibling code path had a "cheap gate": skip the expensive
  scan when the file is small. Which means it paid the whole-file cost *precisely and only
  for the giant files*. Every "skip if small" fast path is an "always pay when big" slow
  path wearing a disguise; the gate protected exactly the cases that didn't need it.
- **The logs went quiet at the moment of the crime.** The daemon's access log stopped dead
  ninety seconds before the capture, while memory tripled. The server only logs a request
  *on completion* — in-flight requests are invisible — so silence during a spike wasn't
  absence of evidence, it was the evidence. Completion-logged systems go dark exactly
  during their disasters.

And the fuel: the multi-gigabyte transcripts belonged to long-running agent sessions in
*other* projects on the machine — one session's rollout file had been forked from another
giant, a lineage quietly minting 2GB files that every tool call then re-read. Frequency
multiplied by file size. Nothing in the memory system's own project would ever have
reproduced it, which is why every synthetic test I wrote came back innocent.

## Parking a fire you can't put out tonight

One more process move worth naming, because nobody writes it down. Midway through, with
the machine genuinely at risk and the root cause still unnamed, the right call was not to
keep debugging — it was to make the system *safely inert* without uninstalling anything.
The daemon's port got a **decoy**: a ten-megabyte stdlib HTTP server answering `200
{"status": "decoy"}` to everything. Every session's auto-start saw a "healthy" daemon and
stood down; every hook call failed soft; nothing could resurrect the real daemon behind my
back, because the auto-start machinery *itself* was the resurrection vector. Brake first,
debug later — and design the brake so the system's own reflexes can't fight it.

## The coda: what steady state looks like

The fixes, once the hunt had named their targets, were almost anticlimactic — bounded tail
windows for anything that inspects a transcript (the last thinking block does not require
the first two gigabytes), honest retained-bytes accounting for caches that keep line-split
copies (a `getsizeof(text) * 2` estimate undercounts per-line object overhead by an order
of magnitude on short-lined content — measured 11.7× on one input — so the store's LRU
believed it was under budget while holding gigabytes), a footprint-gated watchdog that
annotates *both* numbers on every trip line so the divergence itself becomes a logged
signal, and lint gates that make the whole bug class — unprojected scans, unbounded reads —
a test failure instead of a code-review hope.

Two days of unattended real traffic later: 42 hours of uptime, footprint respiring between
0.4 and 3.3GB, hard limit untouched. And one last discipline check that ties this post to
the evaluation one: my original target was a 2GB cap, and the post-fix data says the
daemon's *healthy* footprint breathes above that. So the limit stays where the
measurements put it, not where my wish did. Tightening a tripwire past the system's real
respiration doesn't make the system smaller; it makes the alarm a liar in the other
direction.

## The checklist I actually keep now

The whole hunt, compressed into the rules I'd hand a friend at hour zero:

1. **Timeline before tools.** A ring buffer of samples turns "it's big" into a shape;
   burst vs leak decides everything downstream.
2. **Capture at the trigger, not after.** If all threads look idle, your reaction time is
   the bug in the instrument.
3. **One capture explaining three symptoms beats three dashboards explaining none.**
4. **Fixes are real AND insufficient.** Multi-month incidents are sediment. After every
   victory, re-arm and assume another layer.
5. **Region shapes are fingerprints.** Few-huge-buffers and millions-of-tiny-objects are
   different crimes with different ideal instruments.
6. **Arm before the fire.** Spawn-time diagnostics must be config-plumbed, or they'll be
   absent for every capture that matters.
7. **Audit the tripwire.** When a limit that should have fired didn't, the alarm is the
   first suspect. Know whether your number is resident or footprint, and which one your
   OS believes.
8. **Read call trees as sentences, then grep for the sentence.**
9. **Silence is data.** Completion-logged systems go quiet during the event; count
   in-flight work against request counters.
10. **Park safely when you must stop.** A decoy that satisfies the system's reflexes is
    worth more than a heroic all-nighter — the machine you're protecting is also the
    machine you're debugging on.

None of this is novel tooling. `sample`, `vmmap`, `malloc_history` ship with the OS; the
ring buffer is forty lines; the decoy is fifteen. What took five days was not access to
instruments — it was climbing the ladder in order, believing each capture over my own
prior, and refusing the two temptations that stretch incidents into months: declaring
victory at the first real culprit, and blaming the leak when the alarm was the liar.

---

*The fixes referenced here all landed as ordinary PRs in [simba](https://github.com/mahmoudimus/simba)
with red-first tests and config-gated caps; the forensic watcher, the arming flag, and the
watchdog metrics are in the repo. Parts 1–3 of this series cover the memory layer itself:
[the local-first evidence layer](/blog/2026/06/simba-part-1-local-first-memory-layer/),
[the neuro-symbolic bet](/blog/2026/06/simba-part-2-neuro-symbolic-bet/), and the
evaluation discipline. This one is the operations bill for all of it.*

[^gil]: Python's Global Interpreter Lock (GIL) allows only one thread to execute Python bytecode at a time. A C-level operation that holds it for a long stretch (like decoding a huge file into a string) freezes every other Python thread in the process — which is how one background read can stall an entire async server, its health checks included.
