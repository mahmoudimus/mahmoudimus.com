+++
Title: Evaluation as a repeatable benchmark: how we earned the numbers
Date: 2026-06-13
Status: draft
Author: Mahmoud
Tags: longmemeval, benchmarking, llm-as-judge, evaluation, memory, reproducibility
Classification: blog
Excerpt: How a measurement discipline — not a new architecture — took simba from 0.561 to 0.823 on LongMemEval-S, to parity with the strongest comparable open system, and why we ran the significance test against our own claim. Part 3 of 3 on building a benchmark you'd defend under someone re-running it.
+++

> **The claim, stated with its context, because a number without one is noise.** On
> LongMemEval-S, graded by the *official* per-type judge (deepseek-v4-pro), simba answers
> **0.823** with a deepseek-v4-flash answerer. The strongest comparable system we could
> re-run on the identical judge — hebb-mind — scores **0.7927** (its own raw outputs,
> re-graded on our infrastructure, with a stronger v4-pro answerer). A paired McNemar test
> on the 468 questions both systems answered puts the +3pp gap at **p = 0.18 — not
> statistically significant.** So: at least at parity, point-estimate ahead, not a proven
> beat. The whole post is about why we are allowed to say even that much.

## 1. Why most memory-benchmark numbers are mirages

Before we trusted any number of our own, we went looking for the bar. We surveyed every
LongMemEval-referencing repository we could find — 44 of them — and read each one for the
two things that turn a percentage into a measurement: which **variant** of the dataset it
ran, and which **judge** graded the answers.

Every headline above ~90% fell apart under that scrutiny:

- mem0's 94.8 was Cloud-only; the runnable OSS build collapses to ~0.09 (more on that
  below).
- agent-oss's 98.2 is self-disclaimed in its own README.
- aletheia's 90.5 was hardcoded in a `.tsx` file.
- memanto (89.8) and supermemory (81.6) are proprietary cloud products.
- engram-ai's 91.4 is a *competitor's* cited number, not its own run.
- smriti's "80" is four of five questions.

What survived was a much lower, much more honest band. On the full LongMemEval-S, scored
in-repo by a real judge: hebb-mind **0.79** (DeepSeek-V4-Pro — simba's exact axis),
CortexDB **0.766** (official GPT-4o judge, keyword-only retrieval — a floor), mempalace
**0.74**. The headline 90s were cloud, marketing, oracle-variant, hardcoded, or
self-disclaimed. **A benchmark number means nothing without its (variant + judge).** That
sentence is the entire motivation for everything that follows. The one directly comparable
external point — hebb-mind, on the same DeepSeek-V4 judge family — sat at 0.79. That became
our bar, and our first honest measurement of simba on the same data was **0.561**. The gap
looked like a chasm. It was not one thing.

## 2. Building a program, not a spike

The eval did not start as a program. It started as a **spike** — the smallest thing that
would produce a number. Our first external evaluation (the PR that gave simba its first
LoCoMo/LongMemEval figures) was exactly the rushed kind of harness everyone writes first:
every rerun **re-embedded the entire corpus** from scratch; the numbers lived only in
**stdout**, never stored, so two runs couldn't be compared except by scrolling back;
datasets were **ad-hoc files in `/tmp`**; and — the worst of it — the **answerer graded its
own answers**, the same model playing student and examiner. It produced a number. It could
not produce a *trustworthy* number, and it certainly couldn't produce the *same* number
twice.

That spike was good enough to locate the weakness (multi-hop) and nothing more. The moment
we wanted to move a number and *believe the move*, every one of those shortcuts became a
source of doubt: was the delta real, or did re-embedding shuffle something; was the grade
fair, or was the model flattering itself? So before chasing a single point of accuracy, we
rebuilt the eval as a piece of software held to the same standard as the product. The
reason 0.561 → 0.823 was even possible in a weekend is that rebuild — we stopped
re-measuring by hand.

The pieces, all living under `src/simba/eval/`:

- **A deterministic dev/test split.** `splits.py` buckets each case by a stable SHA-1 hash
  of its id — no RNG, no state, reproducible across runs and machines. Levers get chosen on
  dev; the number we report comes from test. The discipline is one sentence: **tune on dev,
  report on test, never tune to the number.** (We were honest with ourselves that
  LongMemEval-S has no native held-out split, so its levers are protocol/architecture
  choices, A/B'd on small subsets, not per-question fits — and we said so in the writeup.)
- **Persistent caches for the expensive parts.** Embeddings and judge verdicts are cached
  on disk and keyed by content. This is not a nicety; it is what made iteration affordable.
  Our cloud LLM path runs ~17s per call — a single full recall ablation once ran 2h20m on
  494 queries without finishing before we killed it. Caching the embeddings and re-grading
  only changed answers is the difference between a lever taking minutes and taking a
  workday.
- **An append-only `results.jsonl` and a generated leaderboard.** Every run appends a row
  with its full memory/judge config snapshot. `leaderboard.py` reads that JSONL — the
  source of truth — and *derives* `BENCHMARKS.md`, which carries a "do not edit by hand"
  banner and its caveats baked in, so the committed file reads honestly on its own.
- **One CLI.** `simba eval bench longmemeval --qa` runs the whole thing; `simba eval
  leaderboard` regenerates the table. A CI smoke test runs a tiny slice so the harness
  itself can't silently rot.

None of this moved the number directly. It is what let the number move *credibly*.

## 3. The diagnostic that made retrieval debuggable

The first thing we built that paid off was not a feature — it was a debugger for
retrieval. Scoring "memory quality" as one accuracy number tells you nothing about *where*
a miss happened. So we split the retrieval signal into two metrics, scored on evidence-set
recovery rather than QA:

- **`pool_complete@N`** — is the *full* gold evidence set even in the top-N candidates?
  This is the first-stage candidate-generation ceiling. A reranker can never exceed it.
- **`complete@k`** — did reranking land that evidence in the usable top-k? This isolates
  rerank lift.

On top of those, a four-bucket classifier forces every miss into exactly one of
`candidate_generation | reranking | reasoning | success`. The rule we held to all weekend:
**don't optimize "memory quality" — optimize the failure bucket.**

This immediately killed a class of wasted effort and redirected another. Counting questions
turned out to be purely *breadth-bound*: `pool_complete@20 = 0.40 → @80 = 1.00`. The
evidence was being retrieved; it just sat at ranks 20–40, below the context window. No
reranker change could ever have fixed it — and we'd have spent days on reranking if the
split hadn't told us so. Widening the candidate pool recovered all of it (answer accuracy
0.40 → 0.56), and the invariant *strengthened* at scale on the real ~491-turn LongMemEval-S
haystacks. The split also caught the opposite trap: a pointwise cross-encoder reranker
*helps* "latest" queries (complete@5 0.7 → 0.8) but *hurts* multi-endpoint temporal ones
hard (0.65 → 0.20), because it promotes the single most-relevant turn and demotes the
co-required one, breaking the evidence *set*. The principled answer was intent-gated
reranking, not blanket default-on — a verdict we'd never have reached from a single
accuracy number.

## 4. Calibrating the axis before trusting any number

A judge is a measuring instrument. We refused to report deltas through an instrument we
hadn't calibrated.

**The judge.** We re-judged 122 LoCoMo triples with both deepseek-v4-pro and GPT-4o using
simba's exact judge prompt. Agreement was **98.4%**, Cohen's **κ = 0.90** ("almost
perfect"), and the disagreements were symmetric — *zero* net bias. A test system's
aggregate accuracy came out **0.0902 under both judges, identical**. That validated the
deepseek-v4 axis as a GPT-4o-equivalent grader, which let us retire GPT-4o (deprecated
anyway) without losing comparability to the published GPT-4o-judged literature.

**The answerer.** A calibrated judge does not tell you whether your *answerer* is
penalizing you — verification is not generation, so we had to run it. Holding retrieval and
judge fixed, we swapped only the answerer across 122 LoCoMo cases: deepseek-v4-flash
**0.377** vs gpt-4o **0.311**, delta −0.066, McNemar **p ≈ 0.15 — not significant**. The
honest claim is "no penalty," not "deepseek is better" (gpt-4o is a 2024 model). But it
means our same-axis numbers do not *understate* simba by using a cheaper answerer.

| Calibration | Method | Result | Verdict |
|---|---|---|---|
| Judge: deepseek-v4-pro vs GPT-4o | re-judge 122 LoCoMo triples, same prompt | 98.4% agree, κ=0.90, zero bias | validated GPT-4o-equivalent grader |
| Answerer: deepseek-v4-flash vs gpt-4o | swap answerer only, fixed retrieval+judge, n=122 | 0.377 vs 0.311, McNemar p≈0.15 | non-penalizing — deepseek suffices |

The calibration paid an unexpected dividend. Reproducing mem0 on this *same* axis — same
answerer, same judge, same 122 cases — exposed the runnable OSS build at **~0.09**, against
its ~66% marketing config. We are explicit that this is **not** a "simba beats mem0" claim:
we ran mem0's free `mem0.Memory` with a deepseek answerer and bge-small, not its hosted
GPT-4 paper stack. The defensible finding is about *architecture robustness*: simba's
store-raw design reads the LLM only at answer time, where a near-frontier model suffices,
so it is robust to a weaker LLM. mem0's extract-facts-at-store design is only as good as
its *write-time* LLM and collapses off GPT-4 (it hallucinated dates, summarized away the
specifics temporal questions need). The same-axis exposure is a finding about *where in the
pipeline the LLM dependency lives*, not a leaderboard scalp.

## 5. The "measure what ships" fixes that *were* the gains

Here is the uncomfortable part: about half of the 22-point gap was not a modeling deficit.
It was our harness measuring something subtly different from the product — always in a
direction that *understated* us.

- **The homemade judge deflated us.** Our judge was a generic binary "same meaning as
  gold?" prompt. Every published system uses the official LongMemEval *per-type* templates:
  a rubric judge for preference questions, off-by-one tolerance for temporal, old-and-new
  tolerance for knowledge-update. Re-grading identical outputs on the official judge was
  **+3.6pp** (p = 5e-4). Our own instrument had been marking us down — the preference slice
  was scoring 0.069 purely because rubric golds auto-fail a "same meaning" check.
- **The missing Current-Date anchor.** Our reader passed no "Current Date," so every "how
  long ago…" question was structurally unanswerable. The official reader always provides it,
  and in production the host agent always knows today's date — so adding it is *fidelity*,
  not benchmark-gaming. It was **+0.111 overall, and temporal reasoning doubled, 0.417 →
  0.833.**
- **A regression we shipped, caught because the bench ran the shipping config.** v0.7.0
  enabled answer-time conflict surfacing by default — a real win on contradiction
  benchmarks. But "what is my *current* address?" retrieves both the old and new value, the
  detector flags them as a conflict, and the directive tells the model not to pick a side —
  exactly wrong when recency resolves it. Knowledge-update cratered to **0.25**. We caught
  it within 24 hours *because the benchmark ran the config that ships*, and the fix
  (intent-gating the directive: 0.25 → 0.958 on knowledge-update) is live in v0.7.1.

Stacking the fidelity fixes and the measured levers gives the ladder. Every step is a
full-470 run, every lever was A/B'd:

| Step | Change | LME-S |
|---|---|---|
| baseline | yesterday's shipped config, homemade generic judge | 0.561 |
| #1 | official per-type judge + Current-Date + conflict-off + reader rules (P2) | 0.7495 |
| #2 | + intent-gated context k=80 for multi-session (gate: complete@80 = 0.90) | 0.7702 |
| #3 | + temporal questions answered via executed Python codegen (A/B +0.141) | 0.7809 |
| #4 | + intent-gated preference synthesis reader (2x2 0.167 → 0.793) | **0.823** |

By type at 0.823: knowledge-update 0.901, multi-session 0.711, single-session-assistant
0.857, preference 0.900, single-session-user 0.875, temporal 0.827. None of the climb was a
novel architecture. It was protocol fidelity, a self-inflicted regression, breadth, and
computation-pushed-into-code.

## 6. The integrity capstone: we ran the significance test on ourselves

This is the step most "we beat X" posts skip. With simba at 0.823 and a comparable bar in
hand, the temptation is to publish the +3pp and move on. Instead we re-graded hebb-mind's
own raw outputs through our identical official judge (it reproduced its published 0.790 on
our infrastructure — its number is real, not a judge artifact), and ran a **paired McNemar
test** on the 468 questions both systems answered:

- simba **0.8226** vs hebb-mind **0.7927**
- discordant pairs: 54 simba-only-right, 40 hebb-only-right (n = 94)
- exact two-sided **p = 0.18 — not statistically significant**

The point-estimate lead (+3.0pp, +14 questions) is real, but it is within noise at
LongMemEval-S's sample size — and run-to-run variance on the softer slices is itself ≈±1pp.
So the defensible claim is *parity*: at least as good as the strongest comparable open
system, from a *weaker* answerer, point-estimate ahead, not a proven beat. We would need a
wider margin or more questions to say "win," and we will not say it until we can.

The published kill list is part of the same method — the dead ends are the credibility of
the live number:

| Killed lever | Why |
|---|---|
| Cross-encoder rerank in eval (blanket) | hurts multi-endpoint temporal 0.65 → 0.20; intent-gate instead |
| NLI conflict detection (×3 model families) | NLI "contradiction" is same-scene; memory conflict is cross-time |
| ARM3 date-disjoint conflict carve-out | failed its SubtleMemory gate (0.722 < 0.944) — date-disjointness can't tell an update from a genuine conflict |
| GPT-4o answerer | non-penalizing but not better (McNemar p≈0.15); deepseek suffices |
| Entity-bridge / PPR / IRCoT multi-hop retrieval | all measured negative — multi-hop is reasoning, not recall |
| V4-Pro reader | +0.028 ≈ 2 cases at n=72, noise-level; flash suffices |

We held to one rule the whole time: **never chase 1.0.** A saturated benchmark has stopped
discriminating between variants; 1.0 is the *failure* condition for an eval, not the
target. When recall climbs toward the ceiling, the job is to make the dataset harder, not
to celebrate.

## 7. Repeatability: the number reproduces

The 0.823 is not a one-off lab result. The full stack reproduces from a clean checkout via
`simba eval bench longmemeval --qa` plus the bench config flags, and every lever that built
it shipped as config-gated `src/simba` code with byte-identical defaults: question_date
(PR #66), official per-type judge (#67), the knowledge-update intent-gate (#68),
aggregation breadth (#69), and the bench-reader levers — reader style, preference
synthesis, temporal codegen (#71). All of it is **live in v0.7.1 on PyPI**, which also
fixes the v0.7.0 knowledge-update regression that had been shipping. The per-question
verdicts sit in `stacked_final4_results.jsonl`; the run config snapshot lives in the
append-only `results.jsonl`. Anyone can re-grade us.

## 8. The moral

The credibility of a benchmark number *is* the result. A number that survives someone else
re-running it — on a calibrated judge, on the variant you named, with the dead ends
published — is worth more than a higher number that doesn't. We can defend 0.823 because we
can hand you the judge, the split logic, the cache, the per-question verdicts, and a
significance test that we ran *against our own claim* and that came back inconclusive on the
"win." That inconclusive result is not a weakness of the writeup; it is the writeup working.

The next lever with measured headroom is not more answer-time cleverness — our four
increasingly elaborate answer-time computation layers all landed in the same narrow band,
because they all rearranged the same incomplete extracted rows. The frontier is **write-time
extraction (the L1 lever)**: structuring the evidence per-session, where recall is still
recoverable, instead of at answer time, where it isn't. That is the campaign that could turn
the point-estimate lead into a significant one. We will measure it the same way — tune on
dev, report on test, calibrate the axis, publish the kills — and if it doesn't work, we'll
tell you that too.

---

*All numbers are LongMemEval-S, official per-type judge (deepseek-v4-pro), answerer
deepseek-v4-flash unless noted; ±1pp run-to-run variance; the abstention slice is excluded
on both sides. Calibration figures are LoCoMo (n=122). Methodology, the full kill list, and
per-question verdicts are in the repo.*
