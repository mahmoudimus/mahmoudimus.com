+++
Title: Simba, Part 2: The Neuro-Symbolic Bet, and What the Data Did to It
Slug: simba-part-2-neuro-symbolic-bet
Date: 2026-06-13
Author: Mahmoud
Tags: memory, neuro-symbolic, datalog, souffle, z3, clingo, agents, evaluation
Classification: blog
Excerpt: I bet that fact schemas, first-order logic, Datalog and solvers would beat plain store-and-retrieve on the hard questions. Mostly they didn't, and the failures were consistent enough to explain why. Part 2 of 3, a record of measured negatives and the one place symbolic methods earned their keep.
+++

> **The one-line version:** I expected a structured, symbolic memory to beat store-raw[^storeraw] on
> counting, temporal, and conflict questions. It mostly didn't, and the failures were
> consistent enough to explain. The equivalence relation a counting question needs (*what
> counts as one of the thing being counted*) is created by the question, so it can't be
> materialized at write time. Symbolic methods earned their keep in exactly one place:
> replacing **computation** (enumerate-then-`len`, date arithmetic, freshness by `max`).
> They lost everywhere they were asked to replace **judgment** (recognition, relevance,
> canonicalization).

## The bet, stated plainly

It is a reasonable bet, and I want to defend it before I knock it down.

A conversational memory accumulates facts over months. The hard
[LongMemEval](https://github.com/xiaowu0162/LongMemEval) questions are exactly the ones a
relational engine is built for: *how many Korean restaurants have I mentioned?* (a
`COUNT`), *what is my current address?* (a `latest` over a dated series), *do these two
statements conflict?* (a satisfiability[^sat] check). A pile of raw turns answers none of these
natively. A pile of structured facts, `(actor, relation, object, value, date)` rows,
answers all of them with a query.

So the plan wrote itself. Extract atomic facts at write time. Key them by entity. Layer
deterministic aggregators on top: counting via Datalog/[Souffle](https://github.com/souffle-lang/souffle)[^datalog],
conflict via [Z3](https://github.com/Z3Prover/z3)[^z3], temporal via a date evaluator. The LLM
does the messy natural-language part once, at ingestion; from then on you query a clean
schema. This is the neuro-symbolic dream, and it is not a naive one: it's the architecture
half the 2026 memory literature converged on.

I built it. Then I measured it. Here is what the data did.

## I didn't try it once, I tried it six ways

It would be misleading to present this as one clean experiment with one clean negative. I
*wanted* the bet to win, so I gave it six swings, each a response to the last one's
failure. The LLM wrote Python to solve the query directly: too brittle, code catered to
the eval. So I backed off codegen and tried **typed extraction**: pull `(entity,
attribute, value)` triples with a parts-of-speech-aware prompt. The values were fine; the
*types* drifted, the same fact landing under three different predicates across turns. So I
added **slot canonicalization**[^canon]: normalize each fact into a fixed real-world slot,
`(canonical_entity, canonical_predicate, frozen_qualifiers)`, so the surface grammar
couldn't pick the ontology. That fixed drift and broke counting, because canonicalizing to
*one* identity is exactly wrong for enumeration. So I tried **dual identity** (emit two
projections per fact, a slot identity for state and an instance identity for counting) and
then a **focused two-pass** extraction on top of that.

Each fix was reasonable. Each was a response to a real failure in the previous one. And
somewhere in the middle of that arc I fooled myself: a couple of the intermediate probes
looked like wins, and I said so, until a closer look showed I had been feeding the
*baseline* a degraded input (rendered frames instead of the rich text the experimental arm
got), which had quietly cratered the thing I was comparing against. The "win" was a
measurement artifact. I retracted it. (That scar is why Part 3 is so insistent about
calibrating the instrument before trusting the delta: I learned that one the hard way, on
myself.)

When the dust settled, the six-probe arc was a **measured negative against plain
store-raw** on gold-evidence oracle conditions[^oracle]. But the *shape* of how each fix failed was
identical, and that shape is the real finding. The fact-index experiment below is the
cleanest single instance of it, so I'll tell that one in full.

## The fact-index experiment: extraction was great, lookup was wrong

The first thing to de-risk was extraction quality. I had a prior scar: routing QA through
[simba](https://github.com/mahmoudimus/simba)'s summarizing digest collapsed oracle QA from
**0.700 to 0.089**, because extract-and-summarize destroys counts, dates, and verbatim
recall, and only soft preferences survive. So I tested whether a *structuring* extractor
("every fact atomic, never merge, preserve counts and dates") could rebuild a
complete-enough fact set from raw turns without the same loss.

It could. Cleanly.

| bucket | RAW turns | GOLD evidence | structured facts (EXT-B) |
|---|---|---|---|
| knowledge-update | 0.867 | 0.800 | **1.000** |
| multi-session (count) | 0.467 | 0.800 | 0.667 |
| single-session-user | 0.667 | 0.733 | 0.733 |
| temporal-reasoning | 0.933 | 1.000 | 1.000 |
| **overall** | **0.733** | **0.833** | **0.850** |

The structuring extractor produced ~104 atomic facts per question and *recovered the
gold-evidence ceiling*: it even beat it on knowledge-update, because atomic dated
value-change facts make "pick the latest" trivial. "Index, don't summarize" went from an
argument to a measurement. Extraction was not the wall.

The lookup was.

I keyed the facts by entity and queried with entity-exact clustering. On a counting
question (*"how many items of clothing did I buy?"*, gold answer 3) it missed **3 of 4**
queries. The mechanism is precise and it is the whole story of this post:

> The extractor tagged the facts with **specific instances**: `black jeans from levi`,
> `boots from zara`, `green sweater`, seventeen distinct entities. The question asks about
> a **class**: `clothing`. The class `clothing` matches no instance by key, and its
> embedding sits far below threshold from any of them. The lookup returns empty. The answer
> fails.

The de-risk run had worked only because it fed *all* the facts and let the answerer see
every clothing item at once. The moment I added the entity filter (the thing that makes a
fact index an *index*), class-counting broke.

I tried the obvious repair: drop entity-exact clustering, retrieve facts semantically.
Worse. Overall **0.717 (raw) → 0.633 (semantic-over-facts)**, and multi-session counting
collapsed **0.533 → 0.267**. Top-N semantic filtering fragments the answer that used to
live in one turn across facts it can't reassemble. Filtered facts scored *below* raw turns.

Every filtering lookup I built lost the instances counting needs. That was three
independent measurements pointing the same way, and it forced the question underneath them.

## The deeper insight: the group-by key is supplied by the question

Here is the thing I missed in the bet, and the thing that re-derives store-raw from first
principles rather than from a benchmark.

A counting query is a `GROUP BY`[^groupby] over an equivalence relation[^equiv]. *How many Korean
restaurants?* requires deciding what counts as **one** Korean restaurant: distinct named
places? distinct visits? distinct cuisines that happen to be Korean? That equivalence
relation is the join key, and **it is supplied by the question.** It is frequently not
present in the source at all until the question defines it. Nobody, at the moment they
mentioned eating bibimbap, tagged that turn with the class `Korean restaurant` under the
grouping the future question would impose.

You cannot pre-materialize a group-by key you have not yet been asked for. Any write-time
schema commits to *some* equivalence relation (entity identity, in my case) and that
relation is the wrong one for every query that groups differently. The fact index didn't
have a bug. It had the wrong key, and there is no right key to pick in advance, because the
right key is a function of a question that hasn't arrived.

The corollary is the load-bearing one. There is exactly one kind of fact whose identity is
**query-independent**: intrinsic state. *The latest value of an attribute.* The slot
`(actor, relation, object, attribute, value, unit, observed_at, source_span)` has a
canonical identity no matter who asks: there is one current address, one current job, one
latest 5K time. That is worth canonicalizing at write time, and it's exactly where the
structured layer won (knowledge-update 1.000). Everything else (counting, comparison,
aggregation over a question-defined class) has a *query-created* identity and must defer to
answer time, over the complete raw evidence, where the question is finally present to
define the grouping.

This is why store-raw keeps winning. Not because structure is bad. Because most of the
structure a query needs doesn't exist until the query does.

## Where symbolic won, sharply

The same analysis says exactly where the symbolic layer *should* pay off: not at storage,
but at **computation**, once the question has supplied the grouping and the complete
evidence is in hand. And there, it pays off hard.

Give the answerer the complete fact set and split the task: the LLM **enumerates** the
distinct instances (semantic membership, easy for it), then Python computes `len()` (exact,
hard for it). Counting goes from **0.30 (raw) → 0.55 (free-form feed-all) → 0.75
(enumerate-then-`len`)**.

| counting approach | multi-session accuracy |
|---|---|
| raw retrieval | 0.30 |
| feed-all, LLM counts in free-form | 0.55 |
| LLM enumerates → Python `len()` | **0.75** |

The LLM miscounts in prose; hand it the easy job and let code do the arithmetic. Temporal
arithmetic is the same shape: the LLM writes a small `datetime` program, a sandbox executes
it, and I measured zero execution failures. Freshness is `max(observed_at)` in code, not
the model's judgment. This *is* the NL→Datalog/Souffle intuition, vindicated: `len` is
Souffle's `count`. The neuro-symbolic split is real.

The boundary is just sharper than the bet assumed. **Symbolic methods replace computation,
not judgment.** Everything on the computation side of that line (counting, date math,
freshness) wins. Everything on the judgment side (deciding which facts are relevant,
recognizing that two statements contradict, choosing the canonical form) stays with the
LLM, and the solver inherits the LLM's blindness rather than curing it.

I proved that boundary by failing at it. I built a Z3-backed contradiction detector
(ProofOfThought-style: LLM formalizes a claim pair, Z3 checks satisfiability). On genuine
contradictions it was perfect, 23/23, matching the fuzzy LLM detector. But formalization
success was 1.00 *and it didn't matter on the hard cases*: the LLM has to **recognize**
incompatibility to emit the mutual-exclusion rule. Where it doesn't recognize the conflict,
it formalizes the pair into non-colliding predicates, and Z3 *correctly* reports SAT. Z3 is
sound. It can't see what the LLM can't see. The symbolic layer added **verifiability (a
proof), not recall.** Recognition is judgment, and judgment doesn't move to the solver.

## The four-variant cap

The most recent and most decisive measurement. After reaching 0.823 on LongMemEval-S, I
went hunting for headroom in answer-time computation: surely a smarter engine could squeeze
out the remaining counting misses. I built four, each more principled than the last, and
ran every one as a paired A/B on the 48-question wrong-in-either subset.

| variant | what it does | net (fixed − broken) |
|---|---|---|
| rows-v1 | LLM codegen over retrieved rows | negative (12 fixed / 15 broken) |
| rows-v6 | LLM query-plan + fixed Python three-valued evaluator | +2..+4 |
| rows-v7 | [clingo](https://github.com/potassco/clingo) possible-worlds backend (brave/cautious = possible/certain) | wash (8/47 vs Python's 10/47) |
| rows-v8 | LLM tool-calling + proof-anchored self-verify | +2 (7 fixed / 5 broken) |

All four landed in the same narrow **+2-to-+4 band.** A principled possible-worlds engine
with proofs moved nothing over a hand-written Python evaluator. The reason is the invariant
from the fact-index work, confirmed a fourth independent time: **answer-time computation is
capped by extraction recall.** Counting misses because enumerating over ~80 mixed
answer-time memories drops instances. No router, no engine, no verifier fixes incomplete
input. They all rearrange the same impoverished rows. The evaluator was *never* the
bottleneck.

The self-verify pass deserves its own line, because "have the model check its work" sounds
like free accuracy and isn't. Audited over 21 cases: precision 0.50, recall 0.27[^precrec], **zero
auto-corrections applied.** The model rubber-stamped wrong answers (11) more often than it
caught them (4), even anchored to a deterministic proof. The mechanism is sound the rare
time it engages (one clean catch cited the certain/possible gap correctly) but the LLM
re-affirms more than it re-derives. Self-judgment is weak; external deterministic signal
helps only the case it engages, and it engages unreliably.

So I stopped the answer-time-variant treadmill. The cap is upstream, at extraction recall,
and that's recoverable only at **write time** (per-session, one short session in view)
which is the next campaign, not more engine cleverness.

## The open frontier: ambiguity-preserving runtimes

There is one symbolic direction I have *not* killed, because I haven't been able to test it
properly yet, and it follows directly from the group-by insight, so I want to name it
plainly as a research thread rather than a result.

If the equivalence relation is supplied by the question, and questions are often
*ambiguous* about it (*"few months"*: two? six?), then the right move may be to stop
resolving the ambiguity and start **preserving** it. The LLM emits not a rigid query but an
**ambiguity model**: the vague terms left as named parameters with candidate values, plus
declared null/partial-data policies, and a program parameterized over them, with the
invariant that no vague constant is ever inlined. A fixed engine then sweeps the parameter
lattice and reports the answer *as a function of interpretation*, flagging sensitivity.
Sometimes the most useful output is "**23 to 25, regardless of whether 'few' means 2 or 6
months**", and the insensitivity is itself the answer.

The formal scaffolding for this already exists and is decades old: Imieliński-Lipski
c-tables give **certain** answers (true in all worlds) and **possible** answers (true in
some), which is exactly ASP brave/cautious entailment[^asp], which I prototyped on clingo.
Provenance semirings (Green-Karvounarakis-Tannen) and their implementation in
[Scallop](https://github.com/scallop-lang/scallop) (Datalog parameterized over semirings)
are the compilation target if the intents outgrow an 80-line hand-written evaluator.

The genuinely open part: the text-to-SQL ambiguity literature (AMBROSIA at NeurIPS 2024,
AmbiQT, AmbiSQL) treats ambiguity as something to **resolve**: enumerate the
interpretations, or ask the user, *before* emitting rigid code. None of them compile to a
runtime that *keeps* the ambiguity and evaluates over it. simba's open thread sits exactly
in that gap. I think it's interesting. I have not yet shown it's a win, and this post does
not claim it is one.

## The verdict

Neuro-symbolic methods earn their place in a memory system, but a narrower place than the
bet assumed. They belong wherever they replace **computation** (counting by `len`, dates by
`datetime`, freshness by `max`) and those wins are large and real. They do not belong where
they'd replace **judgment**: relevance, recognition, canonicalization, and above all the
choice of equivalence relation, which the question owns and the schema can't anticipate.

The substrate underneath all of it is store-raw plus answer-time reasoning over complete
evidence, not because structure failed, but because I now understand *why* it must:
intrinsic state has a query-independent identity worth canonicalizing; everything else has
an identity the question creates, and you can't index against a question you haven't been
asked. The fact index, the semantic-fact lookup, the Z3 conflict detector, and four
answer-time engines all told me the same thing from different directions. I published every
one.

That left one real question hanging over the whole series: how do you *prove* claims like
these without fooling yourself? Every number above is a paired A/B on one calibrated axis,
and there's a real discipline behind making those numbers mean something. Part 3 is about
the benchmark: how I built one I'd defend under someone else re-running it.

---

*Numbers above are LongMemEval oracle and -S, deepseek-v4-flash answerer / deepseek-v4-pro
judge unless noted; n is small on the isolating probes (15/bucket on the ceiling work, 48
on the answer-time subset) and stated where it matters. Every lever discussed shipped
default-off behind a `simba config` flag; the harnesses and per-question verdicts are in
the repo.*

[^storeraw]: store-raw is simba's core choice: keep each conversation turn verbatim and defer all interpretation to query time, instead of extracting and summarizing facts when the turn is first written. The bet is that summarizing early throws away detail you can't get back.
[^sat]: A satisfiability check asks whether a set of logical statements can all be true at the same time. If two statements contradict, no assignment of values satisfies both and the checker reports "unsatisfiable" (the conflict). The general problem is called SAT.
[^datalog]: Datalog is a small declarative query language: you write facts and rules, and an engine derives everything that follows (counts, joins, reachability) without you writing the loops. Soufflé is a fast Datalog engine. The appeal here is doing aggregation with rules instead of ad-hoc code.
[^z3]: Z3 is a solver (an "SMT" solver) that takes logical constraints and decides whether they can all hold at once, returning a satisfying example or proving none exists. Here it checks whether two remembered facts actually contradict.
[^canon]: To canonicalize is to collapse the many surface forms of the same thing into one standard form (a "canonical" key), so "NYC" and "New York City" resolve to a single entity. Useful for stable state, wrong for counting, where the distinctions are exactly what you need.
[^oracle]: Gold-evidence oracle conditions are a deliberately generous test: the system is handed the exact evidence a question needs (an "oracle" stands in for perfect retrieval), so the score measures reasoning over that evidence in isolation, not whether retrieval found it. A negative result under conditions this easy is a strong result.
[^groupby]: GROUP BY is the database operation that buckets rows by a chosen key and aggregates each bucket (count, sum, latest). "How many Korean restaurants" is a GROUP BY whose key decides what counts as one restaurant.
[^equiv]: An equivalence relation is the rule that decides when two things count as "the same" for grouping or counting (same named place? same visit? same cuisine?). It is the key a GROUP BY groups on, and the post's point is that the question, not the stored data, supplies it.
[^precrec]: For a detector, precision is how often its "found one" calls are actually correct, and recall is what fraction of the real cases it catches. Here the self-checker had precision 0.50 (half its flags were wrong) and recall 0.27 (it caught about a quarter of the errors). This is the detector sense of recall, not recall@k.
[^asp]: Answer Set Programming (ASP) is a logic-programming style where you state constraints and a solver enumerates the consistent "possible worlds." An answer is cautious (certain) if it holds in every world and brave (possible) if it holds in at least one. clingo is a popular ASP solver.
