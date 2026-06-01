+++
Title: Growing a unique function signature without rescanning the binary
Date: 2026-05-31
Author: Mahmoud
Tags: reverse engineering, ida pro, algorithms, string algorithms, cython
Classification: blog
Math: true
Viz: true
Excerpt: One function took 462 seconds to fingerprint. Here is the algorithm that turned that into a couple of seconds, and why it is really an old string-matching idea run backwards.
+++

A byte signature is how a reverse engineer says "this function, the one I named and annotated last week, is the same code over here in the new build." You pick a sequence of bytes from the function, wildcard out the parts that move between compiles (relative call targets, absolute addresses), and you are left with a pattern like `48 8B ?? ?? E8 ?? ?? ?? ?? 85 C0` that you can search for. If that pattern matches exactly one place in the database, it is a name you can carry across rebuilds.

The catch is in those three words: *exactly one place*. A pattern that is too short matches all over the binary. A pattern that is too long is brittle and slow to search. What you actually want is the **shortest** prefix of the function that is unique in the database. My IDA Pro plugin, [ida-sigmaker](https://github.com/mahmoudimus/ida-sigmaker), generates that for you on a hotkey.

For a long time it generated it slowly. On one real 16 MB module, fingerprinting a single function took **462 seconds**. Seven and a half minutes, for one function, in an interactive disassembler where you might want to do this fifty times in a session. This post is about the algorithm that took that to a couple of seconds, and about how it turned out to be a well-known string-matching trick pointed in an unusual direction.

## Stating the problem

It pays to be precise about what "matches" means. The database $D$ is the program's segment bytes laid end to end, of length $N$ in the tens of millions (so $N \sim 10^7$). A pattern $P = (t_0, \dots, t_{\ell-1})$ is a sequence of tokens; each token $t_j$ is either an exact byte (value $v_j$, mask $m_j = \texttt{0xFF}$) or a wildcard (mask $m_j = \texttt{0x00}$, which matches anything). $P$ matches $D$ at position $p$ when every token agrees under its own mask:

$$\forall j \in [0, \ell): \quad (D[p+j] \wedge m_j) = (v_j \wedge m_j),$$

where $\wedge$ is bitwise AND. Gather the matches into one set,

$$M(P) = \lbrace p \in [0, N-\ell] : P \text{ matches } D \text{ at } p \rbrace,$$

and what the plugin computes is the shortest growing prefix $P_\ell$ (the first $\ell$ tokens of the decoded function) whose match set has collapsed to a single position:

$$\ell^\ast = \min \lbrace \ell : |M(P_\ell)| = 1 \rbrace.$$

Everything below is about finding $\ell^\ast$ without reading all $N$ bytes more than once.

## The naive method, and why it is quadratic

Here is the obvious way to find the shortest unique signature. Start with a short pattern. Scan the whole database, count the matches. If there is more than one, append the next byte of the function and scan again. Repeat until the count drops to one.

It works, and it is slow for a reason that is easy to miss. Each time you append a byte, you rescan the *entire* database from scratch. If the answer is $L = \ell^\ast - \ell_{\min} + 1$ lengths away from where you started, that is $L$ full scans of an $N$-byte database, so $O(L \cdot N)$. And the search usually has to try several starting points, because the best signature might begin a few bytes into the function, or might need to grow past the function's end. Call that $A$ anchors. Now you are at

$$T_{\text{naive}} = O(A \cdot L \cdot N).$$

With $N$ in the tens of millions, even a SIMD-accelerated scan that rips through memory at full bandwidth is doing $A \cdot L$ of those passes. That is where the 462 seconds went. The whole optimization is one idea: get the $L$ and the $A$ out from in front of the $N$.

## Idea 1: the match set only ever shrinks

The first observation is almost too simple. When you append a byte to a pattern, you are adding a constraint. A position that did not match the longer pattern certainly did not match because of the new byte, but every position that matches the longer pattern *also* matched the shorter one. The set of matching positions can only get smaller as the pattern grows. It never gains a member.

Put it formally. Appending a token only adds a constraint, so the match set is monotonically non-increasing in the length $\ell$:

$$M(P_{\ell+1}) \subseteq M(P_\ell).$$

That means rescanning is pure waste. The next set is just the previous one filtered by the new token:

$$M(P_{\ell+1}) = \lbrace p \in M(P_\ell) : (D[p+\ell] \wedge m_\ell) = (v_\ell \wedge m_\ell) \rbrace.$$

Keep the positions where the new byte also matches, drop the rest, and never look at the rest of the database again.

So the shape of the algorithm changes. Pay once to build an initial set of candidate positions (call this the **seed**), then **refine**: walk the candidates, check one byte each, keep the survivors. Each refinement step costs $O(|M(P_\ell)|)$, proportional to the current candidate count, not $O(N)$. And since the candidate set only shrinks, those steps get cheaper as you go.

How much cheaper is worth pinning down, because that decay is what makes the search fast in practice. Monotonicity by itself only promises that $R$ refinement steps after a seed of size $C_0$ cost

$$\sum_{r=0}^{R-1} |M_r| \le R \cdot C_0,$$

which is just "no step is bigger than the seed." The reason it is actually fast is stronger. If each informative exact byte keeps at most a fraction $\alpha < 1$ of the candidates, the surviving counts decay geometrically and the whole refinement chain is bounded by a constant multiple of the seed:

$$\mathbb{E}\left[\sum_{r=0}^{R-1} |M_r|\right] \le C_0 \sum_{r=0}^{R-1} \alpha^r < \frac{C_0}{1-\alpha}.$$

Wildcard tokens have $\alpha = 1$: they never shrink the set, so they are not informative steps, and the expensive filtering skips them entirely. A wildcard-heavy pattern simply has fewer informative steps $R$.

Here is that collapse on a small synthetic database. Each cell is a position in the bytes; the seed lights up every place the first exact byte occurs, and appending each further byte drops the positions that disagree. Wildcards add a step but no shrink. Step through it, or press play, and watch it fall to a single match (the counts are computed by actually running the filter, not faked):

<figure data-sig-viz="refine">
  <noscript>This figure is interactive: it animates the candidate set shrinking as each byte of the pattern is appended, and needs JavaScript.</noscript>
</figure>

This is the "seed-then-refine" recurrence, and it is the backbone of the whole thing. It leaves exactly one question: how do you build that first seed cheaply? Because if seeding still costs a full $O(N)$ scan, and you do it once per anchor, you have just moved the $O(A \cdot N)$ blowup somewhere else.

## Idea 2: index the binary once, by byte pair

The seed is "every position where some short, exact run of the pattern occurs." If the pattern has the exact bytes `48 8B` at some offset, the seed is every place `48 8B` appears in the database. Finding those by scanning is $O(N)$. Finding them by *lookup* is free, if you built the right table first.

So before the search starts, I make one pass over the database and bucket every adjacent byte pair by its value. There are only 65,536 possible pairs, so this is a textbook counting sort. Formally, the bucket for a 2-byte key $k$ is

$$B_k = \lbrace p \in [0, N-1) : D[p] = \lfloor k/256 \rfloor \text{ and } D[p+1] = k \bmod 256 \rbrace,$$

and the index stores every bucket back to back in one flat `positions` array, with a `heads` offset array marking where each key's bucket begins (a counting-sort / CSR layout). So bucket $k$ is the slice `positions[heads[k] : heads[k+1]]`, and its size $|B_k| =$ `heads[k+1] - heads[k]` is an $O(1)$ subtraction.

```
key 0x488B  ->  positions[ heads[0x488B] : heads[0x488C] ]  =  every offset where "48 8B" starts
```

Building it is a two-pass counting sort over the $N-1$ adjacent windows: $O(N)$ time and $O(N + 2^{16})$ space, paid once. The payoff is that it is built once and reused across every anchor in the search, so that single shared $O(N)$ replaces all the per-anchor full scans. Seeding a pattern with an exact pair of key $k$ at offset $s$ now costs only $O(|B_k|)$: read the bucket and shift each hit back to a pattern start,

$$M_{\text{seed}} = \lbrace p - s : p \in B_k, \text{ pattern fits} \rbrace.$$

The bucket *is* the seed.

Here is the whole index for a tiny 24-byte database. Click a key to see its bucket: the matching pairs light up in the database (each highlighted cell is the start of that byte pair), and the bucket itself is just one contiguous slice of the flat `positions` array.

<figure data-sig-viz="index">
  <noscript>This figure is interactive: it shows the 2-byte counting-sort index for a small database, and needs JavaScript.</noscript>
</figure>

## Idea 3: seed from the rarest run, and get single bytes for free

Seeding costs $O(|B_k|)$, so the bucket you want is the smallest one. A real pattern has several exact byte pairs in it, so pick the rarest. `E8` is a `call` opcode and shows up everywhere; a pair anchored on a `0F` prefix might be hundreds of times rarer. Starting from the rare one means fewer candidates enter the refine chain, which makes everything downstream cheaper.

Then there is a nice bonus that I did not expect going in. Sometimes a single rare byte is more selective than any pair the pattern offers. You would think supporting single-byte seeds means building a second index over individual bytes. It does not, and this is the part of the design I am most fond of.

Because the byte-pair keys are laid out in numerical order, $k = (b \ll 8) \mid c$, all 256 pairs that start with a given byte $b$ sit in one contiguous block of the `positions` array. So the count of every position where byte $b$ occurs is the union of those 256 buckets, and it telescopes into a single subtraction on the `heads` array I already have:

$$\lvert B_b^{(1)} \rvert = \sum_{c=0}^{255} \lvert B_{(b \ll 8) \mid c} \rvert = \texttt{heads}[(b{+}1) \ll 8] - \texttt{heads}[b \ll 8],$$

and the 1-byte candidate list is the single slice `positions[heads[b << 8] : heads[(b+1) << 8]]`. The 1-byte buckets fall out of the 2-byte table for free, with no second index and no extra memory to maintain.

Seed selection is then an argmin over both widths,

$$(s^\ast, w^\ast) = \arg\min_{(s, w)} \lvert B_{\mathrm{key}(s, w)}^{(w)} \rvert,$$

taken over every exact 1-byte and 2-byte run the pattern offers. And because the 1-byte options are a superset of the 2-byte ones, the seed bucket you land on is never larger than the best pair alone could give:

$$C_0 = |B^{(w^\ast)}| \le \min_{\text{2-byte runs}} |B_k|.$$

A smaller $C_0$ feeds straight back into the decay bound from Idea 1: fewer candidates enter refinement, so the whole chain is cheaper, in both the worst case and the geometric average.

Here are the anchors a pattern offers, each with its real bucket size from a database. The rarest one, the chosen seed, is highlighted. Click any anchor to see its positions in the index band below: a 2-byte anchor is a single key's slice, while a 1-byte anchor is one contiguous span of the same array, the free marginal. In this case the lone `0F`, isolated by wildcards, is rarer than the only available pair, so a single byte wins the seed.

<figure data-sig-viz="seed">
  <noscript>This figure is interactive: it compares seed-anchor bucket sizes and shows the contiguous 1-byte marginal, and needs JavaScript.</noscript>
</figure>

There is also a case where the right move is to *not* seed yet. If the pattern is still very short (shorter than five useful bytes, in practice), even its rarest run is common, and seeding would enumerate a big fraction of the database for nothing. And if the only bytes available so far are all wildcards, there is no exact byte to key the index on at all. In both cases the search defers seeding until the pattern is long enough, or exact enough, to be worth anchoring. That "don't seed a prefix that cannot be selective" rule turned out to matter more than any clever indexing, which I will come back to.

## Idea 4: refine in place, allocate once

Refinement is the inner loop, so it has to be tight. The candidates are positions in the database, which fit in 32-bit integers, so they live in one typed `uint32` buffer allocated at seed time. Each refine step compacts the survivors to the front of that same buffer with a two-pointer scan: a read cursor walks every candidate, and a write cursor trails behind it and copies down only the ones that still match.

```
w = 0
for r in 0 .. count-1:
    c = cands[r]
    if c + j is in range and (database[c + j] & mask) == target:
        cands[w] = c          # keep the survivor
        w += 1
return w                      # the new, smaller count
```

The write cursor never outruns the read cursor ($w \le r$ at every step), so a survivor is never clobbered before it is read. The buffer only shrinks, and it is never reallocated. A large function runs this loop on the order of 165,000 times during a search and allocates exactly zero times after the seed. That property, "one buffer, only shrinks," is what keeps the constant factor low.

## What it costs now

Add it up. The work splits into one shared stage and a per-anchor stage:

- Index build (the counting sort): $O(N)$, once per search.
- Seed selection (walk the tokens, compare bucket sizes): $O(\ell)$, per anchor.
- Seed enumeration (materialize the candidate set): $O(C_0)$, per anchor.
- Refinement (all informative steps): $O\bigl(\sum_r \lvert M_r \rvert\bigr) \subseteq O(R C_0)$, per anchor.

Written as one expression, the whole search costs

$$O(N) + \sum_{\text{anchors}} O\bigl(\ell + C_0 + \textstyle\sum_r |M_r|\bigr),$$

against the naive $O(A \cdot L \cdot N)$. The database-sized term $N$ is paid once and shared; everything per-anchor is sized by the seed bucket $C_0$ and its shrinking set of survivors, never by $N$.

That is the difference between $O(A \cdot L \cdot N)$ and "one scan plus some bookkeeping." On that 16 MB module, the function that took 462 seconds now finishes in a couple of seconds. Nothing got a magic speedup. There are just far fewer full passes over the database: one shared build instead of $A \cdot L$ scans.

Drag the two knobs that actually multiply, the number of anchors `A` and how many lengths the signature grows through `L`, and watch the two costs diverge:

<figure data-sig-viz="cost">
  <noscript>This figure is interactive: it contrasts the naive and indexed cost as you vary the number of anchors and lengths, and needs JavaScript.</noscript>
</figure>

## This is YARA's trick, run backwards

None of these pieces are new on their own, and it is worth being honest about that. The exact, wildcard-free version of "shortest unique substring starting here" is a studied problem in string algorithms, called left-bounded shortest unique substring, with linear-time suffix-array solutions. The masked version touches the literature on pattern matching with wildcards. Inverted byte buckets, seed-and-verify, monotone candidate filtering: all standard.

The closest practical relative lives in the same neighborhood as my plugin. [YARA](https://github.com/VirusTotal/yara), the malware-rule scanner, does exactly this seed-then-refine dance: it picks a short, rare, non-wildcard substring of a rule (an "atom"), finds everywhere that atom occurs, then verifies the full masked rule at each hit. Seed on something rare, refine the rest. That is the recurrence above.

The twist is the direction. YARA already knows the pattern it is looking for and uses the atom to find it fast. I do not have a pattern; I am trying to *grow the shortest one that happens to be unique*. So the byte-pair index plays the role of YARA's atom oracle, and the monotone in-place filter plays the role of its verifier, but the goal is inverted: instead of matching a known signature, the search discovers the shortest signature that matches in exactly one place. It is the same machinery aimed the other way. I have not seen that particular composition packaged up anywhere, which is the honest extent of the novelty claim: not a new theory but a new application. One cheap trick holds it together: the free 1-byte marginal.

## The optimizations I talked myself out of

The most useful part of this whole exercise was the things I did *not* build, because the reasons are more instructive than the code would have been.

The tempting one is **block refinement**: instead of checking one byte per candidate, group the exact bytes into runs and compare a whole run at once with a wide 64-bit or SIMD load. Fewer instructions, so faster, right? I built a benchmark that constructs the exact case this should win, and it did not move. The refine loop is bound by memory bandwidth, not instruction count. It is already a tight stride-1 sweep, which is the access pattern a CPU streams fastest, and wider-but-fewer compares do nothing for a loop that is waiting on memory rather than on the ALU. I [wrote separately about how I proved that](/blog/2026/05/how-do-you-know-your-cython-hot-loop-is-fast-enough/), because the technique for proving "this loop is memory-bound, stop optimizing the compute" is reusable on its own.

The other one was **spaced-seed intersection**: the index buckets come out already sorted, so for a pattern like `8B ?? ?? 45` you could grab both byte buckets and intersect them with a two-pointer merge. But seeding from the rarest byte and refining against the rest already *is* that intersection, and it only ever touches the smaller bucket. An explicit merge has to read both buckets end to end, which is strictly more work the moment one of them is common.

Here is the punchline, and it is a little deflating. When I finally profiled the slow functions properly, the index build was about 0.05 seconds and the refine kernel about 0.1 seconds. Neither was the problem. The time was going to two boring places: an inner loop that mapped seed candidates one boxed Python integer at a time, and a full database scan that fired whenever a pattern started with nothing but wildcards. The wins were "stop running this loop in the Python interpreter" and "don't scan the whole database for a prefix that cannot anchor anything." Not a cleverer data structure. The kind of thing you only find by measuring.

## Cython, briefly

The algorithm is correct in pure Python, but it is not *fast* in pure Python, because the hot kernels are exactly the loops CPython is worst at: tens of millions of per-byte operations where the interpreter's boxing and dispatch overhead dwarfs the actual work. Three kernels moved into a Cython extension and run as C, with the GIL released so the IDA UI stays live:

- The counting-sort **index build**, as C loops over a typed byte view.
- The in-place **refine** compaction, which dropped from about 14 seconds (a Python list-comprehension called 165,000 times) to about 0.28 seconds, roughly 50x.
- The seed **candidate map**, the last $O(C_0)$ loop still in Python, which cut the worst function from about 12 seconds to about 1 second.

The bridge that makes this work is `array.array('I')`. A candidate set is at the same time a first-class Python object the orchestration code can slice and return, and a zero-copy `uint32` memoryview the C kernel compacts in place. The same buffer is both, so candidates cross the Python/C boundary with no marshalling and no per-call allocation. That is what lets "allocate once, only shrink" hold across the whole search.

If you want the rigorous version, with the match-set algebra, the complexity bounds stated properly, and the references into the string-algorithms literature, it lives in [ALGORITHM.md](https://github.com/mahmoudimus/ida-sigmaker/blob/main/ALGORITHM.md) in the repo. This post is the story; that document is the proof.
