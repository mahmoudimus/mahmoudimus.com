+++
Title: Running the decompiler backwards: rebuilding Hex-Rays microcode from LLVM IR
Date: 2026-06-12
Status: draft
Author: Mahmoud
Tags: reverse engineering, ida pro, hex-rays, decompiler, llvm, microcode
Classification: blog
Excerpt: I have been teaching Hex-Rays to render code it never compiled: hand it microcode built from LLVM IR and let decompile() do the rest. The round trip went from zero to 90 of 109 functions byte-faithful. The most instructive bug was a function I rebuilt too faithfully.
+++

A decompiler is a pipeline. IDA's Hex-Rays takes the bytes of a function, lifts them into an intermediate representation it calls *microcode*, runs that microcode through a dozen maturity levels of optimization (propagation, dead-code elimination, structuring), and finally prints the C-like pseudocode you actually read. Most of the value is in those middle stages: lvar allocation, type recovery, turning a rat's nest of gotos back into `if`/`while`.

For a project I am calling **idavator** I wanted to run that pipeline backwards. Not the usual bytes-to-pseudocode direction. The other one: take a function's logic expressed as *LLVM IR*, rebuild the microcode from it, and let `decompile()` render that. If you can do this, the decompiler becomes a rendering engine. You can lift a function to LLVM, run an LLVM pass over it (a deobfuscation pass, a simplification, a rewrite), and then *drop* the transformed IR back into IDA and read the result as clean pseudocode, lvars and structuring and all, for free.

The lift direction (IDA microcode to LLVM) was already working. This post is about the other half, the **drop** (LLVM to microcode), and specifically about the test that tells you the bridge is sound: the **round trip**. Lift a real function, drop it straight back, and compare the pseudocode you get to the pseudocode you started with. If they match, every joint in the bridge holds. If they do not, you have found a bug. The bugs turned out to be the interesting part.

When I picked this work up, one whole category of function was unsupported: anything that takes the address of a local variable. Today, on GNU `cp`, **90 of 109** such functions round-trip byte-for-byte faithful. Getting there meant arguing with the decompiler about stack pointers, deleting code to become *more* correct, and reverse engineering the decompiler's own binary to read error codes it refused to explain.

## The idea: hand it the simplest microcode and get out of the way

The temptation, when you want to produce microcode, is to produce *good* microcode: optimized, with lvars assigned and the control flow already tidy. That is exactly backwards. Hex-Rays is extraordinarily good at all of that; the trick is to give it the *simplest* valid microcode at the *earliest* maturity and let its own optimizer do the heavy lifting.

The drop hooks `Hexrays_Hooks.preoptimized`, the point just after microcode generation, before the optimizer runs, where the `m_ret` block exists but registers are not yet wired into lvars. It replaces the whole function body with instructions synthesized from the LLVM IR: `mov`s and `add`s and `call`s over scratch registers and stack slots. Then it hands control back, and the normal `decompile()` pipeline wires the CFG, allocates locals, propagates, optimizes, structures, and prints.

Concretely: an LLVM `add` becomes an `m_add` into a fresh kreg; a `getelementptr` becomes an address computation; a call becomes the ABI register moves plus an `m_call`. The converter never tries to be clever. The cleverness is rented from the decompiler.

This works well, right up until the microcode you hand it is subtly invalid. At that point Hex-Rays stops being your renderer and becomes your adversary.

## The decompiler fights back, in error codes

Hand Hex-Rays microcode it does not like and it raises an `INTERR`, an internal consistency assertion, with a bare numeric code and nothing else. `INTERR 50864`. `INTERR 50837`. No message, no context, just a number and a dead decompilation.

The first thing you learn is that these numbers are documented, if you know where to look. The IDA SDK ships `verifier/verify.cpp`, the source of the microcode verifier, and it is a goldmine. Every `MINSN_INTERR` and `MBLOCK_INTERR` is right there with a comment explaining the invariant it checks:

```cpp
case m_xds:
case m_xdu:
  if ( l.size >= d.size )
    mv.MINSN_INTERR(50837); // wrong operand sizes
```

That two-line snippet, for instance, explained a bug I had been staring at. LLVM has a `zext i1 to i8`, a widening from a one-bit value to an eight-bit one. My converter dutifully emitted an `m_xdu` (zero-extend) microcode instruction for it. But IDA sizes both `i1` and `i8` as a single byte, so the source and destination of my "widening" were the same size, and `l.size >= d.size` tripped 50837. The fix is that a same-byte-width cast is not a widening at all; it is a no-op, and you should just alias the operand. One look at the source turned a cryptic number into a one-line fix.

`verify.cpp` decodes most of what you will hit. The ones it does *not* cover are a story for the end.

## "bad sp value at call," or: arguing with the stack pointer

The category that was unsupported when I started, taking the address of a local, is everywhere in real code. `stat(path, &buf)`. `gettimeofday(&tv, NULL)`. Any time a function passes a pointer to one of its own stack variables.

In microcode, the address of a local is `&v`, a stack-variable reference. Rendering it is well understood. But the first time I passed `&local` to a call, the decompiler printed this above the function:

```c
// bad sp value at call has been detected, the output may be wrong!
```

The output, annoyingly, was *correct*: `return memset(v1, 0, sizeof(v1))`, exactly right. But Hex-Rays had flagged it as untrustworthy, and a warning like that is a failed round trip. I needed to understand precisely what made the stack pointer "bad."

Here is the mechanism, and it is a small lesson in how the decompiler thinks. Hex-Rays tracks, for every instruction in a function, the stack pointer delta: how far the stack pointer has moved from where it was at the entry point. At a `call`, it records that delta as the call's `call_spd`, "the sp value at the call instruction." When a call passes a frame address, the decompiler needs that delta to be consistent: the local you are pointing at has to actually live below the current stack pointer.

My converter emitted *every* synthesized instruction at the function's entry address. And at the entry point, the stack pointer delta is zero: the prologue has not run yet, the frame has not been allocated. So when I passed `&local` from an instruction whose recorded stack delta said "the frame does not exist," the decompiler correctly concluded that the pointer was nonsense. Plain calls were fine, because they never materialize a frame address; only `&local` exposed the lie.

The fix is almost funny in its narrowness. You do not need to model the prologue or fake a stack adjustment. (I tried `add_user_stkpnt`; it does nothing useful, because `get_spd` reports the delta *before* an instruction, so you can never change the entry point's own delta.) You just need to give the *one* call that passes a frame address an instruction address where the frame genuinely exists: the deepest-stack point in the real function, which is `argmin` of `get_spd` over the function's instructions, and which is exactly `-stacksize`. Move only that call there. Leave everything else at the entry. The decompiler's own stack analysis then agrees with itself, and the warning is gone.

This is the recurring shape of the whole project: you are not fixing the decompiler, you are removing a small inconsistency so that its *own* correct analysis stops misbehaving.

## The canary you have to delete to be correct

This is the bug I keep telling people about, because it inverts the instinct that drives the entire project.

A lot of `cp`'s functions are built with `-fstack-protector`. On Linux that means the compiler reads a *stack canary* from thread-local storage at `fs:0x28`, stashes it, runs the function body, re-reads the canary at the end, and if the two do not match, calls `__stack_chk_fail` and aborts. It is boilerplate that brackets the real work.

When idavator lifts one of these functions to LLVM, the canary is right there in the IR: a call to the `__readfsqword` intrinsic, a comparison, and a branch to a `__stack_chk_fail` block. So when I dropped the IR back, my converter tried to faithfully rebuild it, and immediately hit a wall: `__readfsqword` is a Hex-Rays helper intrinsic that does not resolve to a real address, and reconstructing it is fiddly.

I spent a while trying to model it properly. Then someone asked me a deceptively simple question: *does `__readfsqword` even mean anything when you are running IDA on a Mac?*

The answer sent me to check something I should have checked first. I decompiled the original, un-dropped function, the reference I was trying to match, and looked for the canary.

It was not there.

Hex-Rays *elides the stack protector from its final pseudocode.* The canary read, the comparison, the fail branch: the optimizer recognizes the whole pattern as boilerplate that does not affect the function's result, and folds it away before it ever prints. The faithful output, the one I was grading myself against, has no `__readfsqword` in it.

Which means my instinct was worse than hard. It was *wrong*. Reconstructing the canary faithfully would make my output diverge from the reference, because the reference does not have a canary in it. The correct thing to do is the thing the optimizer does: make it disappear.

So that is what the drop does now. It models every `__readfsqword` read as a single shared, never-written scratch register. Because the "saved" canary and the "re-read" canary become the *same* register, the comparison the function performs is `K == K`, which is trivially always true. Hex-Rays folds the constant comparison, sees that the `__stack_chk_fail` branch is unreachable, and prunes it. The canary vanishes, exactly as it does for genuinely compiled code, and the rendered function matches the reference. `__stack_chk_fail` itself is dropped on the floor; the `unreachable` that follows it is routed to the return block so the dead branch is well-formed enough to be pruned.

The lesson generalized into a rule I now apply everywhere in this work: do not reconstruct what the optimizer already erased. The decompiler's faithful output is a *fixed point* of its own optimizer. To match it, your microcode has to be something the optimizer would have produced, which sometimes means handing it a foldable no-op instead of the real, semantically faithful thing. Unblocking the canary lifted the faithful count from 72 to 88 functions in one change, because nearly every function with a stack buffer carries one.

## When the decompiler will not tell you what is wrong

The last category is the one `verify.cpp` does not cover.

Noreturn calls (`xalloc_die`, `abort`, the error paths) were tripping `INTERR 51774`, which the source decodes as "should be `BLT_0WAY`": a block ending in a function that never returns must have no successors. That much was clear, and the fix is to have the converter stop splitting a basic block at a noreturn call and mark that block as terminal. Simple functions started working.

Complex functions then failed with a *new* number: `INTERR 50342`. And 50342 is not in `verify.cpp`. It is raised somewhere deeper in the decompiler, during the optimization passes, with no source available to me at all.

This is where you do the thing that feels excessive until it saves you an afternoon: you reverse engineer the decompiler itself. Hex-Rays ships as a binary, `hexx64`, and I keep a copy loaded in IDA with an MCP server in front of it: a small JSON-RPC bridge that lets me query the disassembly programmatically. INTERR codes are not strings, they are integers passed to a raise-function, so grepping for "50342" finds nothing. But you can scan every instruction in the binary for the immediate value `50342`:

```python
for fea in idautils.Functions():
    f = ida_funcs.get_func(fea)
    for h in idautils.Heads(f.start_ea, f.end_ea):
        if idc.get_operand_value(h, 0) == 50342 or idc.get_operand_value(h, 1) == 50342:
            hits.append(ida_funcs.get_func_name(fea))
```

That points straight at the one function in `hexx64` that raises it, and from there you can read the predicate that decides to assert. The error code the decompiler would not explain becomes a function you can decompile and reason about. (To even *capture* a late INTERR like this you have to pass a `hexrays_failure_t` to `decompile` and read its `.code` and `.desc()`, because the failure happens after the early verifier, not during it. `'INTERR: 50342'` is what comes back.)

Where that one stands: I located the assertion but have not yet fixed the underlying issue, which is that dropping a noreturn block's dead outgoing edge leaves a phi node in a successor expecting an incoming value from a path that no longer exists. That is a real dig, not a quick fix, and it is the next thing on the list.

## An aside on counting straight

One more trap, because it cost me a wrong number before I caught it. To measure progress I drop every candidate function and ask the oracle whether the result matches. The fast way is to do them all in one IDA session. The fast way is also *wrong*: IDA's decompiler holds global state that does not fully reset between functions, so an earlier drop quietly perturbs a later one, and functions that are perfectly faithful in isolation get scored as divergent.

The only reliable measurement is one function per fresh process. It is slower, and IDA's headless library happens to crash after about forty database open/close cycles, so you batch it across several invocations. But it is the difference between "72 faithful" and the truth, and between believing a regression and chasing a ghost. When a sweep says a function diverged, I no longer believe it until I have seen it fail in a clean process.

## Where this is going

The round trip is the proof harness, not the product. The product is the ability to run an LLVM transformation over a lifted function (a deobfuscation pass, an MBA simplification, a structural rewrite) and read the result back in IDA as if you had decompiled it natively. Every function the drop reproduces faithfully is one more function whose transformed version you can trust.

The remaining tail is the genuinely hard part: indirect calls through function pointers, where you have to hand-build the call-info structure the decompiler normally infers from a prototype; the noreturn phi-edge problem behind `INTERR 50342`; struct locals with layouts the parser does not yet compute. Each is a small archaeology project of its own.

But the shape of the work has been consistent enough to write down, and it is the most useful thing I have taken from it. You are not fighting the decompiler. You are removing the inconsistencies that make its own correct analysis misbehave, even when that means deleting code that was really there, because the decompiler had already decided it did not matter.
