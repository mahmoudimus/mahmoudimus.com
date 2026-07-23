+++
Title: Running the decompiler backwards, part two: 92.5% of GNU cp, and the bugs that hid inside a passing test
Date: 2026-06-15
Status: draft
Author: Mahmoud
Tags: reverse engineering, ida pro, hex-rays, decompiler, llvm, microcode, verification
Classification: blog
Excerpt: The LLVM-to-microcode round trip now reproduces 310 of 335 functions in GNU cp byte-for-byte — 92.5%. Getting from a narrow proof of concept to most of a real binary was less about new features than about one uncomfortable discovery: the test that said "faithful" was quietly lying, and most of the real work was learning to catch it.
+++

[Part one]({filename}rendering-microcode-from-llvm-ir.md) introduced **idavator**: a bridge that runs IDA's decompiler backwards. The normal direction is bytes to pseudocode. The other direction — the one idavator adds — takes a function's logic as *LLVM IR*, rebuilds Hex-Rays *microcode* from it, and lets `decompile()` render that microcode as clean C, with lvars and types and structuring all recovered for free. The proof that the bridge is sound is the **round trip**: lift a real function to IR, drop it straight back, and compare the pseudocode you get against the pseudocode you started with. Match means every joint holds. Divergence means a bug.

Part one got that round trip from zero to 90 of 109 functions on the address-taking subset of GNU `cp`. This post is about what happened when I pointed it at the *whole* binary and tried to make the number honest. The headline is that **310 of 335 real functions in `cp` now round-trip byte-faithful, 92.5%**. The story underneath it is that I spent most of this stretch not adding capability but discovering that my measurement had been lying to me, and building the discipline to stop it.

If part one was about arguing with the decompiler, part two is about arguing with myself.

## The number that wasn't true

Here is how you measure a round trip, naively. You drop a function. The drop either produces a `cfunc_t` — a decompiled function object — or it does not. So you write the obvious predicate:

```python
real_drop = cf is not None and conv.last_error is None
```

If the drop built something and recorded no error, you call it a success, count it, and move on. I had a sweep that did exactly this across all of `cp`, and it told me I was somewhere north of 300 functions faithful. I believed it for longer than I should have.

The problem is that `real_drop` answers the question "did the drop produce *a* decompilation?" — not the question I actually care about, which is "did it produce *the same* decompilation as the original?" Those come apart in the worst possible way. The converter has fallback paths: when its preferred lowering trips an internal error, it retries with a degraded strategy — a different register allocation, a coarser memory model — and *those retries often succeed at building something*. They set `cf` to a real object. They clear `last_error`. And they return a body that is subtly, confidently wrong: a struct return collapsed to a scalar, a pointer copy rendered as an oversized `memcpy`, an error path that returns the wrong slot.

`real_drop` was `True` for every one of those. The sweep counted them as wins.

I found this the way you always find it: by not trusting a green check and reading the actual output. When I started raw-reading the drop's pseudocode against the native decompile — character by character, not through any diff tool — eleven functions that the sweep scored as faithful were nothing of the sort. They built. They were wrong. The test had been grading "did it run" and reporting it as "is it correct."

This became the first hard rule of the whole effort, and it is worth stating plainly because it generalizes far past this project:

> **The oracle is the native decompile, and the only honest comparison is a raw read of the artifact against it.** Not a structural diff, not the converter's own success flag, not a subagent's summary saying "looks faithful." The thing you ship has to *copy the reference*, and you have to look at it with your own eyes to know.

A structural IR-level diff, it turns out, fails the same way in the other direction: it *over*-counts. The converter legitimately dereferences `alloca` slots that the IR holds by address, so an IR-to-IR comparison flags a whole class of "divergences" that render identically in the final pseudocode. For a while I had two tools — the success flag and the IR diff — and they were wrong in opposite directions, one too lenient and one too strict, and the truth was only ever visible in the rendered C. Every confident number I have given since then is one I got by reading drops against native in a clean process and counting by hand.

## Faithful, or fallback. Never confidently wrong.

Once you accept that a drop can *build and be wrong*, a design question forces itself on you: what should the bridge do when it cannot produce a faithful result?

The tempting answer is "ship the best body it managed to build." That is exactly the trap the degraded retries fell into. A drop that builds a plausible-but-divergent function is *worse than useless*, because the entire value proposition of idavator is trust: you run an LLVM pass over a lifted function and read the result back believing it reflects the real code. A confidently wrong render poisons that. One silent divergence and you can no longer trust any output without re-deriving it, which defeats the point of the tool.

So the rule I settled on — I have been calling it the faithful-or-fallback doctrine — is absolute:

> A building-but-divergent drop is strictly worse than no drop at all. If the bridge cannot reproduce the function faithfully, it must **decline** and fall back to the native decompile, never emit a body it is not sure of.

Enforcing this needed a gate. After the drop builds, before it is allowed to count, a check compares the drop's pseudocode against the function's native pre-drop pseudocode — the reference — using the oracle. If they diverge, the drop is *declined*: `real_drop` flips to `False`, the body is thrown away, and the function is recorded as a native fallback. The degraded retries that used to ship eleven lies now hit this gate and bow out. The honest count dropped when I added it. That was the gate working, not regressing — it was subtracting eleven results that had never been real.

There is a cost. The gate is only as good as the oracle behind it, and as I will get to, the oracle has its own blind spots. But the asymmetry is the right one to bake in: a false *decline* costs you a function you could have had; a false *accept* costs you the credibility of every function you ship. When in doubt, decline.

## "Unrecoverable" is a claim, not a conclusion

The most valuable thing I built this stretch was not code. It was a tripwire in my own reasoning.

When you are deep in a hard bug, there is a specific kind of sentence that feels like relief: *"the decompiler folded that away,"* *"that information is gone by this stage,"* *"this is just an inherent limitation."* Every one of those ends the investigation and, not coincidentally, absolves the code you are working on. That combination — investigation-ending *and* self-exonerating — is exactly the signal that you are about to be wrong. The asymmetry is the bug. A claim that lets you stop looking *and* clears you of responsibility is the one place you are most motivated to quit early, so it deserves the *most* scrutiny, not the least.

So I gave it a rule, which I think of as the exoneration gate:

> Before you accept that a defect is upstream, inherent, or unrecoverable, name the **cheapest experiment that would prove that claim false**, and run it. You almost always hold the reference source. You can compile it. You can dump the actual microcode at the actual maturity. "The optimizer ate it" is a hypothesis with a falsifier one command away.

In this domain the claim that something is "impossible" has, without exception, turned out to mean "I am looking at the wrong pipeline stage." The information the decompiler appears to have destroyed is still alive a maturity level earlier, or in the binary, or in the IR you lifted from. The discipline is to go find the stage where it is still alive instead of writing the epitaph. Half the wins below exist only because a sentence that felt like a conclusion got treated as a claim and falsified.

## Reverse engineering the error codes the source won't explain

Part one covered the easy half of Hex-Rays' internal errors: the microcode verifier ships as source in the SDK's `verify.cpp`, and most `INTERR` codes you hit early are right there with a comment explaining the invariant. The hard half is the codes raised *deep in the optimizer*, during the global passes, where there is no source at all — just a number and a dead decompilation. This stretch lived in that half, so I stopped guessing and reverse engineered the decompiler's own binary, `hexx64`, to recover what the codes actually mean.

The method is mechanical once you accept you have to do it. INTERR codes are integer immediates passed to a raise function, not strings, so text search finds nothing. Instead you scan every instruction in `hexx64` for the immediate value, which lands you on the one function that raises it; you take cross-references to that function; you decompile the predicate that decides to assert; and you read, in the decompiler's own logic, the exact condition you violated. I keep `hexx64` loaded in IDA with a small JSON-RPC bridge in front of it so an agent can drive the disassembly programmatically, and I persist every rename and comment back into the database so the next session inherits the map instead of redoing it.

Two codes were load-bearing this stretch, and decoding them turned two multi-hour walls into specific, addressable bugs.

**`INTERR 50342`** is a value-numbering consistency failure in the first global optimization maturity. The optimizer tracks every definition in a table keyed by value number; the assertion fires when it goes to look up a definition that *should* be registered and finds it absent — an un-numberable def. In my case the root was almost funny once I saw it: the converter was synthesizing every instruction at the function's single entry address, so the per-path return definitions all shared one address and *collided* in the table, becoming mutually un-numberable. The fix was to hand the colliding definitions distinct synthetic addresses so the optimizer could tell them apart. Part one ended with 50342 as an open "real dig"; this is the bottom of that dig.

**`INTERR 52700`** is a lookup miss in a sorted side table the optimizer keeps — a structure indexed by a key that is supposed to have been registered earlier in the pipeline. It fires when the key is absent or past the end of the table. The key, it turned out, was an outgoing stack-call argument: a value that *would* have been registered by the normal `MMAT_CALLS` microcode generation, except that the drop hooks in earlier and bypasses exactly that pass. The drop was passing a stack argument the optimizer had no record of. Knowing *that* — rather than staring at a bare 52700 — is the difference between a fix and a week.

This is the part of the work that feels excessive right up until it saves you an afternoon, and then it just feels like the job.

## A boundary, labeled honestly

Not every wall comes down, and the exoneration gate cuts both ways: it forbids you from *calling* something a boundary cheaply, but once you have actually run the falsifying experiments, it lets you record a real one — with proof.

`backupfile_internal` was the last function in `cp` tripping `INTERR 52700`, and it has an unusual shape: its one outgoing stack argument is the *address of a local*, `&local`, passed at a non-trivial point in the frame. The decompiler registers a bare `&local` stack argument in that sorted side table only when the call's recorded stack-pointer delta is exactly zero. `backupfile_internal`'s call to `numbered_backup` sits mid-frame, at a stack delta of −152, so the lookup misses and 52700 fires.

The obvious fix is to force the call's recorded delta to zero, which is the value the native decompile carries. I ran the sweep across the whole plausible range of deltas, and the result was clean and damning: only a non-negative delta *registers* the argument, and only a non-negative delta *corrupts* the body — because forcing the delta to zero lies about the real −152 frame, so every address-taken local in the function maps to the wrong slot and Hex-Rays emits "local variable allocation has failed." Registration and correctness were mutually exclusive across the entire range. The alternative — materializing the address into a register and spilling it the way the native code does — regressed a sibling function that was already faithful, and tripped 50342 on a second path whose own fix re-broke the first.

That is a boundary. But it is a *specific, recoverable* boundary, not an inherent one, and the distinction matters enough to be worth the words. The native decompile builds this function fine; it does so because its microcode generation constructs a stack-pointer-consistent outgoing-argument region — a frame rebuild that is orthogonal to the stack-argument mechanism I was poking at. The recovery path is known. It is just larger than the bug, and it couples with 50342. So `backupfile_internal` stays a faithful native fallback, documented with the experiments that prove the boundary and the path that would cross it. "Deferred, with a map" is an honest place to leave a function. "Impossible" would have been a lie, and the gate exists to catch exactly that lie.

## The canary, again — this time as a red herring

Part one's most-told bug was the stack canary: the lesson that you must *delete* the `-fstack-protector` boilerplate to match the reference, because Hex-Rays elides it from its final pseudocode, and reconstructing it faithfully makes your output diverge from a reference that does not contain it. *Do not reconstruct what the optimizer already erased.* I stand by that lesson. This stretch it came back to bite me from the other side, and the way it did is the most instructive thing here.

Three of `cp`'s core functions — `do_copy`, `copy`, `copy_internal`, the heart of the program — were all declining. They all carry a canary. The native decompile of each *renders the canary read* as a visible statement, while the drop folds it away. So the hypothesis wrote itself, and it was seductive precisely because it inverted the part-one lesson into a tidy symmetry: *native keeps the canary for these functions and the drop folds it, so the divergence is the canary; restore the read faithfully and all three flip.* I built it — lowered the read into a distinct stack slot meant to survive the optimizer's dead-code elimination exactly the way native's does.

It regressed twelve faithful functions and flipped zero.

What killed the hypothesis was running the falsifier instead of admiring the symmetry. The decline gate's oracle does not compare raw text; it canonicalizes both bodies first. And in Hex-Rays' collapsed-declaration form, a *dead, undeclared* local — which the folded canary is — is transparent to that canonical form. I checked it directly: take a known-faithful function whose native body carries the canary read and whose drop omits it, and ask the oracle whether they match. They match. The oracle is *already invariant to the canary*. Then the clincher: for the copy family, `matches(native, drop)` and `matches(canary_stripped_native, drop)` return the *same* answer. Stripping the canary from the reference changes nothing. The canary was not the divergence. It was not even *a* divergence. It was a coincidence sitting next to the real one, and my fix had spent its effort making twelve other functions render the dead read as a bare call statement — a *new* divergence — for no gain.

I reverted all of it and committed the falsification as a test, so the dead end is mapped and nobody walks it again. The real blockers behind those three functions turned out to be entirely unrelated: a variable-length-array stack-probe loop in `do_copy`, a scalar byte-pun through a stack `alloca` in `copy_internal`. Different archaeology, each.

The lesson is sharper than part one's, and it is about method rather than microcode: *falsify before you build, especially when the hypothesis is elegant and especially when it flatters a lesson you already believe.* A symmetric, satisfying explanation that absolves you of looking further is the exoneration gate's tripwire wearing a clever disguise. The cheapest experiment — strip the suspected cause from the reference and see if the verdict moves — costs one function evaluation and would have saved a day.

## A garbage pointer that came out of a regex

Not every bug this stretch was epistemological. Some were just good, concrete bugs, and `do_copy` had a satisfying one.

Its degraded body contained this store:

```c
*(_QWORD *)0xFFFFFFFFFFFFFFFF = v40;
```

A write through the address `-1`. Native, of course, had `x_tmp_2.src_info = v40;` — a perfectly ordinary struct field assignment. The drop had manufactured a wild pointer out of nothing.

The trail led to a name-resolution helper in the converter. This particular struct field is written through a no-op `bitcast` of an interior-aggregate global, and that routing meant the field's address was resolved by a code path that, unlike its sibling, never called the interior-global decoder. So it fell through to a last-ditch fallback that pulls a trailing integer out of the operand's *textual representation*. And the textual representation of that global is its full LLVM definition line:

```
@data_24188 = global i64 -1
```

The fallback's regex dutifully matched the trailing `-1` and handed it back as the store address. The struct field's offset became the integer `-1`, which is `0xFFFFFFFFFFFFFFFF`, and a field assignment became a write to the highest address in memory. The fix is two lines: have the interior-global decoder run *before* the textual-integer fallback, so a named global is resolved as a global instead of being scraped for whatever number happens to trail its definition. The store renders correctly now, and a toggle test pins the bug so it cannot creep back. It is the kind of bug that is invisible to a structural diff and obvious the instant you read the actual output — which is the whole thesis of this post in miniature.

## The matcher still lies, a little

I will end on the loose thread, because pretending it is tied would betray the entire point.

`copy` round-trips as faithful. `real_drop` is `True`, the gate accepts it, it counts toward the 310. And when I raw-read it against native, there is exactly one difference in the entire function:

```c
// native
__assert_fail("valid_options (options)", "../src/copy.c", 0xBC3u, "copy");
// drop
_assert_fail("valid_options (options)", "../src/copy.c", 0xBC3u, "copy");
```

One underscore. Native names the libc handler `__assert_fail`; the drop renders `_assert_fail`. The IR is correct — it declares and calls the two-underscore symbol — so the underscore is lost in the converter's name rendering, and the gate's oracle treats the one-character difference as benign and accepts the body.

Here is the honest reading. That divergence is cosmetic; it is the same function, the same four arguments, a display decoration on a library symbol. Calling `copy` faithful is morally fine. *But the matcher tolerated a real textual difference*, which means the matcher's notion of "faithful" is slightly looser than the raw read's, which means the 310 is an estimate with a known direction of error: some unknown number of the functions I am counting as faithful differ from native in ways the oracle waved through. The `_assert_fail` case happens to be trivial. I do not get to assume the next one is, and the only way to know is to keep raw-reading.

So 92.5% is the most honest number I can give, with the asterisk that honesty requires: it is measured by an oracle that I have now caught being lenient once, and the true figure is "92.5% minus however many cosmetic-or-worse divergences a full hand audit would surface." That is a better place to be than where I started this stretch — believing a count produced by a flag that meant "it ran" — but it is not certainty, and saying otherwise would be the exact failure this whole post is about.

## Where it stands

The round trip reproduces **310 of 335 functions in GNU `cp` byte-for-byte, 92.5%**, and every one of those was verified by reading the drop against the native decompile in a clean process, not by trusting a checkmark. The remaining tail is genuinely hard and genuinely specific: variable-length-array stack probes, scalar byte-puns through `alloca`, the frame-rebuild that `backupfile_internal` needs. Each is its own small dig, and each is now mapped rather than mysterious.

But the durable output of this stretch is not the percentage. It is a short list of rules that I think apply well past decompilers:

- **The artifact is the truth; the test is a proxy.** A passing check that means "it ran" is not the same as "it is correct," and the gap is exactly where the worst bugs live. Read the artifact.
- **Refuse to ship confidently wrong.** When you cannot produce a correct result, decline and fall back. A plausible lie is worse than an honest gap, because it costs you the credibility of everything else you produced.
- **"Unrecoverable" is a hypothesis.** Name its cheapest falsifier and run it. The claims that end an investigation *and* absolve you are the ones to distrust most.
- **Falsify elegant explanations hardest.** The symmetric story that flatters something you already believe is where you will fool yourself, and the experiment that would catch it is usually one command.
- **When the tool won't explain itself, read its binary.** The error code with no documentation is a function you can decompile.

Part one's lesson was that you are not fighting the decompiler, you are removing the inconsistencies that make its own correct analysis misbehave. Part two's lesson is the one aimed inward: most of the distance between a demo and a number you can defend is not capability. It is the discipline to disbelieve your own green checks until you have read what they are actually grading.
