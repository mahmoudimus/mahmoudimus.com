+++
Title: Simba, Part 1: A Local-First Memory Layer for Coding Agents
Slug: simba-part-1-local-first-memory-layer
Date: 2026-06-13
Author: Mahmoud
Tags: memory, agents, claude code, hooks, retrieval, rag, local-first
Classification: blog
Toc: true
Excerpt: How simba started: coding agents open every session blank, and the founding idea was to fire under Claude Code's hooks to inject memory into the agent's context rather than make it query a database. Part 1 of 3 on building and measuring a local-first agent memory layer.
+++

## The problem: the agent starts every session as a stranger

A coding agent is brilliant for an hour and then born again, blank, the next morning.
Every new session it opens to an empty context window. It doesn't know the architecture
decision you made together yesterday, or *why* you made it. It re-suggests the library you
already rejected. It re-derives the build incantation you worked out last week. It steps on
the same gotcha (the flag that's actually `--replace`, the test that needs the date
prefix) that cost you an hour the first time. You find yourself re-explaining your own
project to a collaborator who was *there* for all of it and remembers none of it.

The frustrating part is that the model isn't the problem. Inside a session it reasons fine.
The problem is that everything it learned with you evaporates at the session boundary,
because the only memory it has is the context window, and the window resets. The agent is
not unintelligent. It is *amnesiac*. And amnesia is not a reasoning failure you can fix
with a smarter model. It's a plumbing failure: the right information from the past simply
isn't in front of the model when it thinks.

So the question [simba](https://github.com/mahmoudimus/simba) started from wasn't "how do I build a better model" or even "how do
I build a database of memories." It was narrower and more mechanical: **at the moment the
agent is about to reason, how do I get the relevant piece of the past back into its
context, without the human having to paste it in, and without the agent having to know to
ask?**

## The seed idea: don't make the agent query memory, inject it

The conventional answer is a tool. Give the agent a `search_memory()` function and hope it
remembers to call it. I rejected that on day one, for a simple reason: an amnesiac doesn't
know what it has forgotten. An agent that has lost the context of last week's decision also
has no idea that there *is* a memory worth fetching, so it never makes the call. Memory you
have to remember to use is memory you won't use.

The seed idea, the actual genesis of simba, was the realization that Claude Code (and
Codex) expose **hooks**: lifecycle points where an external program fires and can write
text straight into the agent's context. A `UserPromptSubmit` hook runs the instant you hit
enter, *before* the model sees your prompt, and whatever it prints as `additionalContext`
becomes part of what the model reads. A `SessionStart` hook fires as the window opens. A
`PreToolUse` hook fires just before the agent acts.

That changes the shape of the whole problem. Memory doesn't have to be a drawer the agent
opens. It can be **ambient**: something that *appears* in the agent's context at exactly
the right lifecycle moment, unbidden, because a hook put it there. You ask "where do I
deploy?" and before the model answers, the `UserPromptSubmit` hook has already quietly
injected the three relevant memories about your deploy setup. The agent doesn't search. It
just… already knows, the way a colleague who read the room already knows.

So simba began not as a vector database but as **a hook that injects**. Fire under the
agent's lifecycle; pull the relevant slice of the past; write it into the context window at
the moment of reasoning. Everything else simba is (the vector store, the keyword mirror,
the recall pipeline, the whole rest of this series) grew up *underneath* that one move, to
answer the question it immediately raised: *given that I get exactly one shot to inject the
right context at the right instant, what do I inject, and how do I find it?*

That reframes the engineering problem precisely. The memory layer is the constraint, not
the LLM. If the right evidence isn't in the window when the agent reasons, no amount of
model quality recovers it; and the hook only fires once, so what it injects has to be
*right*. That single observation shaped everything downstream: simba's job is to put the
*complete relevant evidence* in front of the agent at the moment of reasoning, and nothing
more.

A few constraints I set for myself up front, and held:

- **Local-first.** No external services, no API key to embed text, no data leaving the
  machine. A developer's session history is sensitive, and a memory layer that phones
  home is a memory layer you can't fully trust.
- **Pure Python, in-process.** Everything lives under `src/simba/`. The embedding model
  loads in-process; there's no sidecar embedding API to babysit.
- **Append-only.** Memory is never overwritten. You can add, you can mark, you can
  supersede, but the original turn stays on disk. Forgetting should be a retrieval
  decision, not a destructive write.
- **Everything is config.** Every tunable is a field on a `@configurable` dataclass,
  gettable and settable via `simba config get/set <section>.<key>`[^config]. No hidden constants,
  no env-var-only knobs. If I can't A/B it from the CLI, it doesn't ship.

## The architecture, concretely

simba attaches to the agent (Claude Code, and Codex via a parallel hook set) through the
hook system. Six lifecycle hooks do the work:

| Hook | When it fires | What it does |
|---|---|---|
| `SessionStart` | session opens | auto-starts the daemon (polls 15× at 300ms), injects core rules, shows memory count |
| `UserPromptSubmit` | you submit a prompt | recalls relevant memories, suggests files |
| `PreToolUse` | before a tool call | injects context based on what the agent is about to do |
| `PostToolUse` | after a tool call | observes outcomes |
| `PreCompact` | before context compaction | exports the transcript so nothing is lost to the compactor |
| `Stop` | turn ends | reinforces core rules, watches for the confirmation signal |

The protocol is deliberately boring: each hook reads JSON from stdin and writes
`{ hookSpecificOutput: { hookEventName, additionalContext } }` to stdout. Hooks fail
*silently*: if the daemon is down or a condition isn't met, they exit 0 and get out of
the way. A memory layer that breaks your agent is worse than no memory layer.

Underneath the hooks, storage and retrieval are two cooperating stores:

- A **LanceDB** vector store at `.simba/memory/memories.lance`, the source of truth.
- A **derived SQLite FTS5** keyword mirror at `.simba/memory/memory_fts.db`: bm25 and
  trigram over the same content, rebuilt from the vector store, never authoritative.

Recall is **hybrid**: I run a vector query and a BM25[^bm25] query in parallel and fuse the two
ranked lists with Reciprocal Rank Fusion[^rrf] (`memory.hybrid_enabled`, on by default). Vector
search catches paraphrase and semantic match; BM25 catches the exact identifier, the
error string, the file path that an embedding smears into its neighborhood. Fusing them
is strictly better than either alone, and it's cheap.

Embeddings[^embedding] are **[GGUF](https://huggingface.co/docs/hub/gguf) models loaded in-process** via [llama-cpp-python](https://github.com/abetlen/llama-cpp-python), with no embedding
service. The default is [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) (Q4_K_M, ~81MB, auto-downloaded on first
run), with task prefixes that matter more than they look: `search_document` when storing,
`search_query` when recalling. Two similarity thresholds gate behavior: `0.35` minimum to
surface a memory on recall, `0.92` to call two memories duplicates.

That's the whole shape: hooks in, hybrid recall over a local vector store plus a keyword
mirror, in-process embeddings, append-only, every knob exposed. Nothing exotic. The
interesting decision is what I *don't* do.

## The founding bet: store raw

Here is the fork in the road every memory system reaches at write time. A conversation
turn comes in. Do you:

1. **Extract and summarize** it now (pull out the facts, canonicalize them, write a tidy
   structured record) and store *that*; or
2. **Store the raw turn**, index it lightly, and defer all interpretation to read time?

Most memory systems take road 1. It's seductive: storage is small, records are clean,
recall returns neat facts. simba took road 2, and the bet was explicit: **extract-at-store
is lossy, and the loss is unrecoverable.**

The reasoning is not just "raw is safer." It's structural. A memory layer's real job
factors into two steps:

```
f(question, history) → answer
   = reason(question, retrieve(history))
```

`retrieve` turns history into evidence; `reason` turns a question plus evidence into an
answer. Extract-at-store collapses this: it tries to do part of `reason`'s work at write
time, before it has seen the question. But the question is what defines what matters.

Counting makes this concrete. "How many Korean restaurants did I go to?" is parameterized
by an equivalence relation the *question* supplies: does one count distinct named places,
or visits, or cuisines? That identity is *query-created*. It often isn't even present in
the source until the question defines it, so it cannot be materialized at write time. A
summarizer that decided yesterday what was worth keeping has already thrown away the
distinction the question will ask about tomorrow.

The only thing with a query-independent identity worth canonicalizing is current *state*
(actor, relation, object, value, observed-at, source). Everything else (counts,
comparisons, aggregations) should defer to answer time, over raw evidence. That re-derives
*why* store-raw is correct, not just that it tested better.

So simba's product boundary is a single line:

> **simba is the evidence layer. The host agent is the reasoning layer.** Hooks retrieve
> the most complete relevant evidence; they do not compute answers.

This is foreshadowing. I later built the structured/extracted layers anyway (typed
slots, focused extraction, the whole arc) to put the bet to the test rather than assume it.
**On gold-evidence oracle conditions, that arc was a measured negative against plain
store-raw.** Part 2 walks through those experiments. Part 3 measures the failure mode in
the wild: an extract-at-store system tuned for GPT-4 collapses to ~0.09 QA when you swap in
a weaker answerer, while simba's store-raw holds, because store-raw never bet the farm on
the write-time model getting the extraction right.

## The first external numbers

Internal evals[^eval] lie to you. Mine saturated: recall@1[^recall] of 1.0 on authored test data can't
discriminate between a good retriever and a great one. So the first real signal came from
external benchmarks: **[LoCoMo](https://github.com/snap-research/locomo)** and **[LongMemEval](https://github.com/xiaowu0162/LongMemEval)**, scored as deterministic recall@k of
the gold evidence turns (no LLM judge yet, that's later posts).

The first LoCoMo numbers, hybrid recall only, reranker[^reranker] and expansion off:

| Slice | recall@5 |
|---|---|
| OVERALL | 0.573 |
| single-hop | 0.684 |
| single-hop-factual | 0.663 |
| adversarial | 0.554 |
| **multi-hop** | **0.305** |
| **open-domain** | **0.270** |

Single-hop retrieval was solid out of the gate. Multi-hop[^multihop] was the floor, and it stayed the
floor. That 0.31 was the headline gap, mirrored on LongMemEval's weakest slice
(multi-session r@5 ≈ 0.62 against an overall 0.78). One grounding gotcha worth flagging
because it nearly fooled me: LoCoMo turns use *relative* time ("yesterday"), gold answers
are *absolute* ("7 May 2023"). Prefix each turn with its session date or QA collapses
(a 50-question sample scored 0.082 without dates vs 0.280 with). Recall barely moves; the
answer does. I'll return to that asymmetry.

The instinct, faced with a multi-hop gap, is to build retrieval cleverness: a knowledge
graph to bridge entities, query decomposition to chase sub-questions. I built both, and
measured both at scale. Both failed:

- **KG-into-recall** (co-occurrence *and* sparse typed-LLM graphs): negative. I borrowed a
  GraphRAG-style pipeline (vector seed, graph traversal, fold bridged memories into the
  fusion) and it *hurt*. The conversational graph is near-complete (everything bridges to
  everything), so the fold adds no discriminative signal and displaces genuine vector hits.
  Multi-hop r@5 0.271 → 0.243; mrr dropped. The diagnostic that settled it: 100% of
  multi-hop questions already had their gold turns mutually reachable. Reachability was
  never the problem.
- **Query decomposition**: neutral. A 42-question sample looked like +2pp; at n=281 it was
  0.305 → 0.300, noise. The sub-queries retrieve the *same* turns, because they share the
  same entities.

The one thing that moved multi-hop was a **reranker**, an LLM relevance pass over the
candidates already retrieved (multi-hop r@5 0.280 → 0.476, +70% relative). And that is the
tell. The reranker didn't *add* evidence. It *reordered* evidence that recall had already
surfaced but mis-ranked. The gold turns were in the pool the whole time.

So the first measured lesson, the one that named the thesis:

> **Multi-hop is reasoning, not retrieval.** The evidence was already retrievable. The
> difficulty lives at reasoning time, not in cleverer recall. Levers that try to *add*
> evidence fail; levers that *re-order* and *reason over* the complete set win.

(A coda that reinforced the same point from the opposite direction: when I later put a
*stronger embedder* through the same bake-off (bge-large-en-v1.5 over the nomic default),
it won decisively and lifted *every* axis, including the weak ones. The lesson isn't "don't
improve retrieval." It's that the lever is **completeness of the evidence set**, not
topological tricks on top of it.)

## The north star

Pull it together and the design has one center of gravity. simba's job is to retrieve the
complete relevant evidence a full-context analyst would want, and to stop there. Reasoning
(counting, comparing, resolving which dated value is current) belongs to the agent that
has the question in hand.

Stated as the acceptance metric I now hold every change to: not top-k relevance, but
**evidence-set recovery**: did the retrieved set *contain* everything the answer needs,
before anyone reasoned over it? A reranker (or any lever) earns its place only if it
recovers the complete evidence, not if it merely nudges recall@k.

That's the bet, made on day one and stated as a boundary. The rest of this series is me
trying to break it. Part 2 takes the hardest swing: a neuro-symbolic write-time layer that
tries to do at storage what I argued storage can't do, and reports whether it
worked.

---

*Next: **[Part 2, the neuro-symbolic bet](/blog/2026/06/simba-part-2-neuro-symbolic-bet/).** Numbers in this post are recall@k of gold
evidence on LoCoMo and LongMemEval (no LLM judge); hybrid recall with reranker/expansion
off unless a comparison says otherwise; ±run-to-run variance applies. The QA-accuracy
story, and the judge that grades it, come in Parts 2 and 3.*

[^eval]: An eval (evaluation) is a fixed test set plus an automatic scoring procedure used to measure how well the system performs, so two versions can be compared on the same yardstick.
[^recall]: recall@k measures retrieval. Of the pieces of evidence the correct answer actually needs, it is the fraction that land in the top k results the system returns. recall@1 looks only at the single top result; recall@5 at the top five. It says nothing about whether the final answer was right, only whether the needed evidence was retrieved.
[^config]: simba exposes every tunable as a named setting (like `memory.hybrid_enabled`) that you read or change from the command line with `simba config get` and `simba config set`. "On by default" means the setting ships active out of the box; you would run `simba config set <key> false` to turn it off.
[^embedding]: An embedding is a list of numbers (a vector) that represents a piece of text, arranged so that texts with similar meaning sit close together. It lets a search match by meaning, so "where do I deploy" can find a note about deployment even with no words in common.
[^bm25]: BM25 is a classic keyword-ranking formula, the kind a traditional search engine uses. It scores a document by how often the query's exact words appear in it, which complements embedding search on identifiers, error strings, and file paths.
[^rrf]: Reciprocal Rank Fusion merges two ranked lists into one by combining each item's rank position across the lists, so items both methods rank highly rise to the top. It needs no tuning and no shared score scale.
[^reranker]: A reranker is a second pass that takes the candidates already retrieved and reorders them by relevance, usually with a stronger and slower model than the first-stage search. It can only reshuffle what retrieval already found; it cannot add missing evidence.
[^multihop]: A "hop" is one step of looking something up, like following a single link from one fact to a related one. A single-hop question is answered in one such lookup, from one place in the history. A multi-hop question needs several: you retrieve two or more separate pieces of evidence and join them. "Where does the person I met in Tokyo work?" is multi-hop: first find who you met in Tokyo, then look up where they work. That joining step is what makes multi-hop the hard, interesting case, and why this post keeps separating retrieval (finding the pieces) from reasoning (connecting them).
