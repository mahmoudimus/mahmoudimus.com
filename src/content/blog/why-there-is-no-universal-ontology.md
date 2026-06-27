+++
Title: Why There Isn't a Universal Ontology of Everything
Slug: why-there-is-no-universal-ontology
Date: 2026-06-27
Status: draft
draft: true
Author: Mahmoud
Tags: simba, ontology, knowledge-graphs, agents, evaluation, ambiguity
Classification: blog
Toc: true
Excerpt: I wanted a database that could tell Simba whether Big Sur is in the United States, boots count as clothing, and a church food drive counts as faith-related. The first one is a lookup. The second is scoped. The third is an argument. That distinction is the whole problem.
+++

> **The one-line version:** I wanted a generalized ontology database: the world's nouns,
> places, types, and relationships, with stable vernacular edges Simba could just query.
> The good news is that pieces of it exist. The bad news is that the universal version is
> the wrong abstraction. `Big Sur -> California -> United States` is a lookup. `boots ->
> clothing` is scoped. `church food drive -> faith-related event` is an argument. Treating
> those three edges as the same kind of thing is how you build a very confident system that
> is wrong in exactly the cases that matter.

## The question that started this

This came out of a very concrete failure while building Simba's answer layer.

One of the benchmark rows asked whether a trip to Big Sur should count as a trip in the
United States. The evidence said "Big Sur"; the question wanted "United States"; the system
needed the containment chain:

```text
Big Sur
  -> California
  -> United States
```

That is exactly the kind of thing a machine should not need to rediscover from prose. It
should be a boring lookup. So we added a tiny local location ratifier and it worked: if the
candidate unit's location is Big Sur and the question asks for trips in the United States,
the ratifier can promote the unit from contested to included, with a provenance path you
can inspect.

The obvious next question was the dangerous one:

> Why hasn't somebody already built the generalized version of this? A database of the
> world, all the common vernacular, all the relationships, agreed upon and ready to query?

It is a reasonable question. It is also a trap, because geography is one of the friendliest
ontology domains we get.

## Places are the easy case

Geographic containment has unusually nice properties.

Places have names, aliases, coordinates, administrative boundaries, and relatively stable
parent-child relationships. Big Sur is in California. California is in the United States.
There are edge cases, disputed borders, historical names, and ambiguous place strings, but
the core shape is still database-shaped.

For that class of fact, a ratifier can be boring:

```text
claim: Big Sur is inside the United States
source: local gazetteer / GeoNames / Wikidata-style graph
path: Big Sur -> California -> United States
scope: geography
confidence: high
```

This is why projects like GeoNames, OpenStreetMap, Wikidata, DBpedia, YAGO, and similar
knowledge graphs are useful. They do not solve all of semantics, but for named entities
and many containment or identity questions, they are exactly the right substrate.

The mistake is generalizing from that success too quickly.

## The first crack: boots are clothing, but not only clothing

Take the edge:

```text
boots -> clothing
```

It feels almost as obvious as Big Sur being in California. If the question is:

> How many clothing items do I need to pick up?

then boots probably count.

But boots are not just clothing. They are also footwear. They can be fashion items, hiking
gear, winter gear, workwear, costume pieces, or personal protective equipment. If the
question is:

> How many protective items did I buy for the job site?

the same boots may count under a different type. If the question is:

> How many fashion accessories did I get?

maybe not.

The edge `boots -> clothing` is not false. It is just not enough. It needs scope: what is
the question's answer variable, what domain are we operating in, and what level of
strictness does the user expect?

That is already a different kind of edge than geography. It is reusable, but it is not
context-free in the same way.

## The real crack: vernacular category boundaries

Now take:

```text
Domino's -> food delivery service
```

There is no universal, context-free answer.

In ordinary speech, yes: Domino's delivers food. In a marketplace taxonomy, maybe no:
Domino's is a restaurant, while DoorDash is a delivery service. In a memory query, maybe
yes again: if I am trying to remember which services I used to get food delivered, Domino's
belongs in the set.

Or:

```text
church food drive -> faith-related event
```

One careful reader says yes: it is organized by a church and belongs to religious
community life. Another careful reader says no: the activity itself is charitable, not
devotional. Both readings are defensible. If a benchmark collapses that ambiguity to one
number, the answer layer should not silently pretend the other reading never existed.

This is not a missing database row. It is a semantic judgment.

That sentence is the whole thing.

## Existing ontologies are real, and still not enough

I do not want to make the lazy claim that "nobody has done this." People have done a lot of
it:

- **GeoNames** and **OpenStreetMap** are strong for places.
- **Wikidata**, **DBpedia**, and **YAGO** are broad entity graphs.
- **WordNet** and **BabelNet** help with senses, synonyms, and hypernyms.
- **ConceptNet** captures commonsense associations.
- **Cyc**, **SUMO**, **DOLCE**, and **schema.org** encode formal or semi-formal world
  models.
- **UMLS**, **MeSH**, **AGROVOC**, **Getty AAT**, and similar systems are excellent inside
  their domains.

These are not failures. They are useful. Simba should use them when the edge they ratify
matches the question being asked.

But none of them is the universal vernacular oracle. They do not settle every "does X
count as Y?" question in the way a user, benchmark, or application needs. And I no longer
think that is because the right graph has not been assembled yet.

The missing piece is not storage. It is context-sensitive ratification.

## The wrong architecture: one ontology to rule them all

The tempting architecture is:

```text
question
  -> universal ontology lookup
  -> answer
```

That works in some domains. Geography, units, some identifiers, some well-governed
taxonomies: absolutely. Use the database. Do not ask an LLM to hallucinate the containment
graph of California.

But on semantic category boundaries, a global graph either becomes too rigid or encodes
every local convention as an edge until the graph stops meaning anything.

If the graph says:

```text
Domino's -> restaurant
restaurant != food_delivery_service
therefore exclude Domino's
```

that may be right in one task and wrong in another. If the graph says:

```text
Domino's -> food_delivery_service
```

same problem, opposite direction.

The deeper issue is that "agreed upon by humanity" is the wrong standard. Humanity does
not agree at the granularity these queries require. And even when it does, the local
question may need a different operational definition.

## The better architecture: ratifiers, not oracles

The better shape for Simba is not one ontology. It is a stack of bounded ratifiers:

```text
local evidence facts
  + question intent
  + typed ontology ratifiers
  + provenance
  + ambiguity envelope when ratifiers disagree
```

A geography ratifier can say:

```text
Big Sur -> California -> United States
source: gazetteer
scope: geography
status: accepted
```

A lexical/type ratifier can say:

```text
boots -> clothing
source: WordNet / local type graph
scope: consumer goods
status: accepted-for-this-question
```

A semantic boundary ratifier might say:

```text
church food drive -> faith-related event
source: adjudication / model proposal / human review
scope: event category boundary
status: contestable
```

Those three records should not have the same semantics.

The first is close to database truth. The second is a scoped lexical judgment. The third
is an argument. If the system flattens them into one kind of edge, it has already lost the
plot.

## LLMs should propose, not become the ontology

The model is useful here, but only if we keep its role narrow.

The pattern I trust is:

```text
LLM proposes a candidate relationship
ratifier checks it against a trusted source or local policy
system records provenance
answer layer uses only accepted or explicitly-contested edges
```

The LLM can propose that Big Sur is in California. The geography ratifier should own
whether that edge is accepted.

The LLM can propose that boots are clothing. The type ratifier should own whether that
edge is accepted for the question.

The LLM can propose that a church food drive may count as faith-related. The system should
preserve that as a contestable reading, not silently promote it to a global fact.

This boundary matters because LLMs are excellent proposal engines and unstable ontology
databases. If the model emits the ontology and the answer layer treats it as ratified, the
system is just laundering a guess through formal-looking structure.

I have already made that mistake in smaller forms. A graph can look principled while doing
decorative work. A formal fact can be false because the model collapsed a distinction it
should have preserved. The fix is not more formal syntax. The fix is making the ratifier,
scope, and provenance load-bearing.

## What this changes in Simba

The path is not to build "the ontology of the world."

The path is to build smaller ratifiers whose authority is explicit:

1. **Database-like ratifiers** for stable domains: geography, units, time, identifiers.
2. **Lexical/type ratifiers** for reusable relationships: `boots -> clothing`,
   `Big Sur -> place`, `USD -> money`.
3. **Intent-aware ratifiers** for answer variables: is this value the threshold, the
   current balance, the historical value, or a distractor?
4. **Contestability detectors** for category-boundary cases where two readings are
   genuinely defensible.
5. **Provenance records** for every edge the answer layer relies on.

The goal is not omniscience. It is disciplined humility.

When the edge is known, use it.

When the edge is inferred, say who inferred it and why.

When the edge is contestable, keep both readings alive.

When the edge is out of scope, refuse to pretend.

That is less glamorous than "a database of all the world." It is also closer to something
that can actually work.

The useful system is willing to say:

```text
This edge is known.
This edge is inferred.
This edge is contested.
This edge is out of scope.
```

That is the difference between an ontology oracle and an honest reasoning system.
