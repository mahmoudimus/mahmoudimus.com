+++
Title: How do you know your Cython hot loop is fast enough?
Date: 2026-05-31
Author: Mahmoud
Tags: reverse engineering, cython, ida pro, performance, profiling
Classification: blog
Excerpt: You Cythonized the hot loop and it got faster. Now the hard question: is it optimal, and how would you even tell?
+++

A while back I [wrote about using Cython to speed up IDA Pro plugins](/blog/2025/08/ida-pro-and-cython-super-charging-the-work-horse-of-reverse-engineering/): you keep the Python plugin ecosystem, you cross the Python/C boundary once, and you let the heavy loop run as C. The running example was `ida-sigmaker`, my signature-maker plugin, which got optional SIMD speedups in v1.6.0.

That post ended on an optimistic note. You paste a hot loop into a `.pyx` file, add some `cdef` declarations, and it gets several times faster. Ship it.

But there is a question it left open, and it is the one I kept coming back to once the easy wins were spent: **is the compiled loop actually fast, or just faster?** A 5x speedup feels great right up until you find out the same loop could have been 50x. And the usual Python answer, "run cProfile," falls apart the moment your hot code is doing what you wanted it to do, which is running as C with the GIL released.

This post is about how I answered that question for sigmaker's hottest kernel, without guessing. The short version: I ran three checks, the first two told me the code was clean, and the third one told me to stop optimizing. The interesting part is that "stop optimizing" was the correct, money-saving answer, and I would never have known it from staring at the code.

## The kernel in question

Sigmaker builds a unique byte signature for a function by growing a pattern until only one place in the database matches it. The inner engine keeps a sorted array of candidate positions (every place a short seed pattern currently matches) and refines it one byte at a time. For each new byte of the signature, it walks the candidate array, reads the one byte at `position + offset`, keeps the candidate if that byte matches, and drops it otherwise. The survivors get compacted to the front of the same array in place.

In Cython that kernel is `refine_offsets`, and it looks almost exactly like the Python you would write:

```python
# simd_scan.pyx (trimmed)
def refine_offsets(const unsigned char[:] data_view,
                   unsigned int[:] cands, Py_ssize_t count,
                   Py_ssize_t j, int value, int mask) nogil:
    cdef Py_ssize_t r, w = 0
    cdef unsigned int c
    cdef int target = value & mask
    for r in range(count):
        c = cands[r]
        if (data_view[c + j] & mask) == target:
            cands[w] = c
            w += 1
    return w
```

Two pointers, one branch, one byte read per candidate. The GIL is released for the whole thing. This is the loop that runs millions of times during a search, so if anything in the plugin deserves to be optimal, it is this.

So: is it?

## Check 1: did the source actually compile to C?

The first failure mode with Cython is subtle. Your code looks like C, but a stray untyped variable or an implicit Python object can quietly drag a chunk of the loop back through the CPython API, and you would never see it. The interpreter overhead you thought you escaped is still there, hidden behind C-looking syntax.

Cython ships a tool that shows you exactly this. Run:

```
cython -a src/sigmaker/_speedups/simd_scan.pyx
```

and you get `simd_scan.html`: your source, with every line tinted from white (pure C, no Python API) to deep yellow (lots of CPython calls). Click any line and it expands to the generated C so you can see what it actually emitted.

For the refine loop, every line came back white. About 720 of the file's 816 lines were pure C; the only ones with any yellow were the `def` signatures themselves, where Cython has to unpack the Python-level arguments once on entry. Inside the loop, nothing touches the interpreter.

That is the check most people stop at, and it is worth being clear about what it does and does not tell you. White means there is no hidden Python overhead. It does **not** mean the C is fast. A perfectly white loop can still be a bad loop. Annotation rules out one specific mistake; it says nothing about whether the machine code is any good.

## Check 2: did the C compiler do its job?

The next layer down is what `clang` did with the C that Cython emitted. The thing I most wanted to know was whether the compiler vectorized my loops, because that is where the SIMD speedup is supposed to come from. Clang will tell you if you ask:

```
clang -O3 -Rpass=loop-vectorize \
      -Rpass-missed=loop-vectorize \
      -Rpass-analysis=loop-vectorize \
      -c simd_scan.cpp
```

`-Rpass` reports every loop it vectorized; `-Rpass-missed` reports the ones it gave up on; `-Rpass-analysis` explains why. On my build, 21 loops vectorized and around 570 did not. That second number sounds alarming until you look at them: the overwhelming majority are Cython's reference-counting and bounds-setup glue, loops that were never going to vectorize and do not matter.

Two of the "missed" reports were mine, and they were the interesting ones. The compiler's explanation for the compaction loop was, in effect, that the control flow could not be replaced with a branchless select, which is its polite way of saying "you have a data-dependent write here and I cannot prove how many elements you produce." The other was a scatter-style loop the compiler would not touch because the writes were not a reduction it could reason about.

Now, the loops the compiler *could* vectorize, it did. If you want to confirm that rather than trust the report, disassemble the shared object:

```
otool -tV simd_scan.cpython-310-darwin.so   # macОS; objdump -d on Linux
```

In the byte-scanning kernel you can see the NEON instructions right there: `cmeq` to compare sixteen bytes at once, `and.16b` to apply the mask, the whole anchor scan running wide. The SIMD I was paying for is real and it is in the binary.

So after two checks I knew: the source is clean C, the compiler vectorized everything it could, and the one hot loop that did not vectorize did not vectorize for a real structural reason. The obvious next move is to attack that structural reason. Restructure the candidate data so the compaction becomes branchless, get the compiler to vectorize it, win.

This is exactly where I almost wasted a weekend.

## The question I should have asked first

Before restructuring anything, there is one question worth more than the other two combined: **would vectorizing that loop even help?**

Vectorizing a loop makes the *computation* faster. It is only worth doing if the computation is the bottleneck. If the loop spends its time waiting for memory rather than computing, then making the compute four times wider just gets you to the waiting four times sooner. You would do real work, the benchmark would not move, and you would not understand why.

The honest way to settle this is to measure whether the loop is compute-bound or memory-bound before touching it. On Linux with real hardware you would reach for `perf stat` and read the cache-miss and stall counters straight off the CPU. I work on an Apple machine and run the test matrix in an emulated-amd64 Docker image, so I have no real performance counters to read in either place. I needed a way to prove compute-bound versus memory-bound that does not depend on hardware counters at all.

## Check 3: the working-set sweep

Here is the trick. Keep the loop completely fixed, run the exact same number of iterations doing the exact same work, and change only one thing: how far apart in memory the bytes it touches are.

The refine loop reads one byte per candidate. So I hold the candidate count fixed (two million probes, every run) and spread those candidates across a buffer that grows from a couple of megabytes to half a gigabyte. The number of instructions executed is identical at every size. The only thing that changes is the stride between probes, which walks the access pattern from "contiguous and prefetchable" when the buffer is small to "a fresh cache line, then a fresh page, every probe" when the buffer is large.

If the loop is compute-bound, the cost per candidate stays flat: same instructions, same time. If it is memory-bound, the cost per candidate climbs as the working set falls out of each level of cache.

Here is what it does, measured natively on my M-series laptop (the bench is `tests/perf/working_set_sweep.py` in the repo):

```
 footprint(MB)  stride(B)  t_step(ms)   ns/cand
           1.9          1        0.72     0.358
           7.6          4        0.79     0.393
          30.5         16        0.85     0.426
          62.9         33        1.04     0.522
         127.8         67        2.86     1.428
         255.6        134        6.96     3.479
         511.2        268        8.68     4.342
```

Same two million probes on every row. The only thing that changed is where in memory they landed. The cost per candidate goes from 0.36 nanoseconds when the data sits in cache to 4.34 nanoseconds when it lives in DRAM. That is a 12x collapse, and not one instruction changed to cause it.

That is the whole answer. The refine loop is memory-latency-bound. The byte comparison, the masking, the branch, all the arithmetic the compiler refused to vectorize, is essentially free. What the loop actually does all day is wait for a byte to arrive from memory. Making that already-free comparison run sixteen-wide would optimize the part that was never the problem. The benchmark would not have moved, exactly as the theory predicts, and I would have spent a weekend building a data structure to achieve nothing.

This also reframes what "optimal" means for this kernel. It is not "use the widest SIMD available." It is "touch memory as few times, and as locally, as possible." The lever is upstream: pick a rarer seed so the candidate array starts smaller, so refine has fewer bytes to go fetch in the first place. Sigmaker spends its cleverness on seed selection because that is the part the sweep says actually costs money. Wider compute would not.

## The smaller sibling: def versus cdef call overhead

While I had the harness out, I checked one more thing, because it is the other classic Cython "optimization" people reach for: the cost of the Python/C call boundary itself. `refine_offsets` is a `def` function, so every call pays for Python argument unpacking and for acquiring the two memoryviews. The folklore says to make it `cdef` and call it from inside Cython to skip all that.

So I measured the boundary in isolation, by calling refine with a count of zero so the only thing timed is entry and exit: about 160 nanoseconds per call, flat. A large search makes on the order of 165,000 such calls, which works out to roughly 26 milliseconds of pure call overhead across an entire signature generation. That is low single digits of a percent of the total search time.

I could claw that back by batching the whole refine sequence into one `nogil` call. But that one call would then own the loop that updates IDA's progress bar and checks whether the user hit cancel, and collapsing it would make the plugin feel frozen on a long search. Trading a couple of percent of throughput for a responsive cancel button is the wrong trade. So this "optimization" stays unbuilt too, for a reason I can point at instead of a hunch.

## So when is a Cython kernel optimal?

Not when it is fast. When you have checked the three things that can actually be wrong and found nothing left to fix:

1. **Annotation (`cython -a`)** tells you the source compiled to real C with no hidden interpreter overhead. White loop, good. This catches the most common Cython mistake and nothing else.
2. **The vectorization report (`-Rpass`) plus the disassembly (`otool -tV` / `objdump -d`)** tell you the C compiler did what it could, and let you see the actual SIMD instructions in the binary rather than hoping they are there.
3. **The working-set sweep** tells you whether the loop is even compute-bound, which decides whether vectorizing it is worth a single minute of your time. If the cost per element climbs as the footprint grows, the loop is memory-bound and your effort belongs upstream, in touching less memory, not in faster arithmetic.

`perf stat` and its cache-miss counters are the gold standard for that third check, and if you have real hardware and a real Linux box, use them. The sweep is what you do when you do not: it needs nothing but a loop you can feed inputs of different sizes, and it gives you the one bit you actually need, compute-bound or memory-bound, without a single hardware counter.

The lesson I keep relearning is that the hardest part of optimization is not making code faster. It is knowing when to stop, and being able to prove to yourself that stopping is correct. Two of my three checks said the code was clean. The third said the thing I most wanted to optimize was already free, and that the honest move was to put the screwdriver down. The sweep that told me so is eight rows of a table and about ninety lines of Python, and it saved me from a weekend of beautiful, vectorized, pointless work.

If you want to run it on your own kernel, the harness is in the repo at `tests/perf/working_set_sweep.py`. Point it at your loop, fix the iteration count, sweep the footprint, and read the last column.
