+++
Title: Deobfuscating Rhadamanthys: Teaching Hex-Rays to Recover a Function It Could Not See
Date: 2026-07-15
Status: draft
draft: true
Author: Mahmoud
Tags: reverse engineering, ida pro, hex-rays, d810, microcode, malware, deobfuscation
Classification: blog
Toc: true
Excerpt: A case study in recovering a Rhadamanthys loader function hidden behind computed jumps, a register-resident binary-search-tree dispatcher, and function tails Hex-Rays removed before d810 could see them.
+++

I started with a function that IDA knew was large and Hex-Rays could barely decompile.

The native function, `sub_40A560`, spans thousands of x86 instructions. IDA's flow graph has hundreds of blocks. The first decompilation either returned `None` or reduced the body to this:

```c
__asm { jmp eax }
```

That single jump was doing two jobs. It hid its immediate destination behind arithmetic and conditional moves, then dropped execution into a flattened state machine whose dispatcher used `ebx` as the state variable. Even after I resolved the jump, the decompiler still showed a large `while (1)` wrapped around a binary search tree of opaque constants.

I wanted the recovery to happen inside [d810](https://github.com/w00tzenheimer/d810-ng), at the microcode level. I also had a rare advantage: a working result to compare against. Melissa Eckardt's [Rhadamanthys loader deobfuscation](https://cyber.wtf/2025/11/19/rhadamanthys-loader-deobfuscation/) explains the protection and comes with a neighboring static rewriter. That tool uses Capstone, Keystone, and pefile. It does not use Unicorn, angr, Triton, or a symbolic executor. It scans the native code, reconstructs the state transitions, rewrites the dispatcher traversal into ordinary branches, and lets Hex-Rays decompile the patched bytes.

That gave me a semantic oracle. If d810's result dropped a call, cleanup path, or conditional arm that the rewriter preserved, I had a bug. A pretty ctree was never enough.

## The protection has two layers

The first layer is a set of computed jumps. Some sites select a target with `cmov`. Others use a `setcc`, a shift, an indexed table read, and a key. The value eventually lands in a register and the block ends in `jmp reg`.

The second layer is control-flow flattening. Once execution reaches the protected region, handlers write a 32-bit state value to `ebx` and return to a dispatcher. The dispatcher is not a linear equality chain. It is a binary search tree with 50 range comparisons and 51 equality leaves. The range nodes narrow the interval with `jge`; the leaves test one state constant with `jnz` or `jz` and route to a handler.

The shape mattered because d810 already knew it. Hodur's `sub_7FFD` uses the same condition-chain family. Rhadamanthys did not need a new dispatcher implementation. Its state variable lived in a register instead of a stack slot, and several older recovery stages assumed every state cell had a stack offset.

The diagnostic database made that failure plain:

```text
router kind       CONDITION_CHAIN
dispatcher rows   51
state stack slot  None
state register    20        # Hex-Rays mreg for ebx
transitions       0
```

The dispatcher map was complete. The transition half of the pipeline had simply declined to run because `state_var_stkoff` was `None`.

## Why I did not use concolic execution for the real function

I first built a smaller x64 fixture with the same kind of indirect jump. d810's existing emulation machinery traced a corridor, learned the two possible destinations, and produced a real conditional branch. That was useful because it proved the delivery mechanism and exposed several IDA integration bugs on a controlled function.

It did not scale to this loader. Whole-function concolic execution resolved 0 of the 190 real computed-goto sites. The trace failed at the entry corridor before it reached useful target selection. I could have kept extending the machine model, but the neighboring rewriter was already telling me something more important: execution was unnecessary.

The values form a finite, static data-flow problem. I replaced the whole-function trace with a monotone forward fixpoint over x86 register and memory value sets. Each block joins its predecessor states, interprets the small instruction vocabulary used by the resolver, and propagates constants until the graph stops changing. A value set is capped so an uncertain path makes the analysis abstain instead of exploding.

That pass resolved all 190 sites.

```text
concolic from entry       0 / 190 targets
static value-set fixpoint 190 / 190 targets
```

Concolic execution is still useful for a corridor the static model cannot fold. It just was not the technique responsible for this recovery.

## A control-flow reference is not a branch

Knowing a target address did not mean Hex-Rays would preserve the condition that chose it.

My first attempt added code references from each indirect-jump site to the two resolved destinations. IDA's graph looked much better. The decompiler's graph was semantically worse. The references supplied topology without coupling the comparison to either target, so local optimization treated the comparison and `cmov` chain as dead. The 51-leaf tree collapsed into nonsense.

The fix was to materialize the condition in native bytes. For a two-way site, the resolver emits the equivalent of:

```asm
cmp state, constant
jcc true_target
jmp false_target
```

If the replacement does not fit at the original site, the patcher relocates the still-live tail and extends the function to include the new jump. This is more invasive than adding references, but it preserves the relationship Hex-Rays needs: this predicate selects these two edges.

That distinction held for every later stage. An edge without its proof was not enough.

## The predicate can be far from the state write

One of the best examples begins near the function entry:

```asm
0040A59D  cmp   [ebp+arg_4], 0
0040A5A1  mov   eax, 0EC71CA67h
0040A5A6  mov   ecx, 0A0716E5Bh
0040A5AB  cmovz ecx, eax
0040A5AE  mov   [esp+var_44C], ecx
```

The selected state sits in a stack temporary for roughly 6,000 bytes of code. Its eventual use is:

```asm
0040BECC  mov   ebx, [esp+var_44C]
0040BED0  cmp   ebx, 0BB2D365h
0040BED6  jl    loc_40B6C0
0040BEDC  jmp   loc_40A607
```

By the time the state enters `ebx`, the flags and registers from `0x40A59D` are long gone. Reconstructing only the final state assignment loses the source predicate. The recovery therefore has to trace stack-carried state choices back to the condition that produced them, then materialize two real microcode arms at a place where the predicate is still available.

This was another place where the reference rewriter kept the investigation grounded. Its `_mem_analysis()` and `_condition_analysis()` do the same job at the native level. d810 needed the microcode equivalent, not a new theory of the protection.

## Generalizing the existing BST recovery

The register-state change was deliberately additive. Recovery records either a stack identity or a register identity:

```python
state_var_stkoff: int | None
state_var_reg: int | None
```

The condition-chain operand matcher learned to recognize `mop_r` when `state_var_reg` is set. Handler scans, pre-header state recovery, and the constant fixpoint now read the selected register cell. Every new argument defaults to `None`, so the existing stack path stays unchanged for Hodur, Approov, Tigress, and the restructuring fixtures.

Once that path was live, the analysis folded the next-state value for all 51 handlers. With the correct dispatcher entry it recovered 69 of 70 transition edges. That result also exposed two topology bugs that had nothing to do with registers.

First, dispatcher recovery had chosen a mid-tree equality node as the entry instead of the high-fan-in loop header. Second, the entry-bridge witness understood an equality-chain endpoint but not the initial handler reached through this range tree. Fixing the register cell alone could not make the handler graph reachable from the real prologue.

At this point the decompiler could remove the dispatcher loop and still be wrong. Several intermediate builds had `while (1) == 0` because dead-code elimination removed both the dispatcher and valid handlers that were no longer reachable. That is why the test eventually checked named calls, cleanup, the message pump, and the terminal return instead of counting loops.

## The function body was not all in the MBA

The next failure looked like transition recovery. It was not.

The resolver could prove a transition from a live handler to a native target, yet that target had no corresponding block in the current microcode graph. The bytes were inside the function's native range. IDA's function model owned them. Hex-Rays had omitted them from the top-level microcode array because no ordinary edge made them reachable when the MBA was built.

Changing maturity did not reveal them. `MMAT_GENERATED` and `MMAT_PREOPTIMIZED` preserve more instruction detail, but they start from the same top-level function flow chart. `DECOMP_ALL_BLKS` did not make the detached ranges part of that graph either. Explicit `mba_ranges_t` generation could produce microcode for those addresses, which proved the code was translatable, but it produced a separate MBA.

This was the actual visibility problem: d810 had proved native control flow that Hex-Rays did not know belonged in the live decompilation.

## The first successful path: salvage at LOCOPT and CALLS

The production solution captures detached ranges as explicit microcode snippets, imports them into the live function, and reconnects them with source-scoped transition evidence.

The timing is awkward. At LOCOPT, local expressions and stack references are usable, but calls have not been fully modeled. At CALLS, call arguments and block flags exist, but earlier optimization may have folded the predicate or removed a state write. The importer therefore carries facts across maturity boundaries:

```text
static native resolver evidence
    -> condition-preserving materialization
    -> LOCOPT detached-range capture
    -> stack and predicate rebasing
    -> CALLS call-template repair
    -> source-scoped transition redirects
    -> Hex-Rays structuring and dead-code elimination
```

Importing a block is more than copying its instructions. A detached snippet has its own stack model and block serials. The live MBA has another. The importer rebases stack operands, remaps successors, preserves native-EA provenance, and replaces call instructions with templates captured at the maturity where Hex-Rays knows their ABI shape.

### Stack coordinates do not survive an MBA boundary

The stack bug took longer than it should have because IDA already had the right native stack-pointer deltas. The bad presentation appeared only after detached microcode crossed into the live MBA.

IDA stack-frame offsets and Hex-Rays decompiler offsets are different coordinate systems. In the decompiler's system, offsets are nonnegative, and IDA frame offset zero maps to `tmpstk_size`. The SDK provides `mba.stkoff_ida2vd()` and `mba.stkoff_vd2ida()` for this reason. Treating a detached snippet's `mop_S` offset as a portable identity was wrong: an explicit-range MBA can choose a different `tmpstk_size` from the owning function, and the same VD offset can describe a different native stack location.

The importer now records the stable identity in IDA frame coordinates. When native stack-variable annotations are available, it keys that identity by both native instruction EA and frame offset. At the destination it converts the IDA offset through the live MBA's `stkoff_ida2vd()` method. This removed the ad hoc arithmetic and, more importantly, made stack identity independent of whichever temporary MBA happened to produce the instruction.

There was a second half to the same problem. Hex-Rays receives transient stack-point data through `hxe_stkpnts`. Function tails, `DECOMP_ALL_BLKS`, function-mode `mba_ranges_t`, `DECOMP_OUTLINE`, and earlier maturity did not make the detached instructions appear in that data. Stock IDAPython exposes the callback object but not the vector mutation needed to insert a point. A narrow optional SDK adapter now upserts an `(EA, spd)` pair. The provider uses native-EA provenance to project `ida_frame.get_spd(function, native_ea)` onto the imported live EA while the transient `stkpnts_t` is still mutable.

That is intentionally a small bridge, not a second stack engine. If the native adapter is unavailable, the provider abstains instead of inventing an SP delta. The existing later-maturity path remains available.

One subtle ownership rule keeps the two paths compatible. PREOPT evidence remains multi-source: it preserves every resolver-proven native source for each `(state, target)` pair because closure construction needs the complete transfer relation. The legacy LOCOPT residual-route bridge is deliberately narrower. After rejecting ambiguous per-source rows, it activates only the deterministic lowest-EA source for each pair. Activating every source could let an imported clone replace a still-live dispatcher frontier. Unselected sources remain on the dispatcher for ordinary state-machine lowering.

The verifier caught one subtle bug here. Hex-Rays requires a call instruction in a block marked `MBL_CALL` to carry a valid `mop_f` argument list in its `d` operand. The SDK verifier reports this as `INTERR 50824`. An imported call could pass d810's initial preflight while the block lacked `MBL_CALL`, then fail later after Hex-Rays recognized the block as call-bearing. Copying a nonempty destination operand was not sufficient. The importer had to preserve the complete call template and its argument-list object.

Call replay had two more ownership rules. A bare call that originally appeared as the source of `m_mov(m_call) -> register` must recover that result owner when imported; otherwise later use-def analysis invents arguments or loses the return value. The nested call result size must also match the enclosing `mop_d` size. Hex-Rays checks that relationship as `INTERR 50768`.

The earlier first-decompile failure, `INTERR 50735`, is a different invariant. The SDK's `mcallinfo_t::verify()` raises it when a call argument's microcode operand size differs from the size of its formal `tinfo_t`. Historically, immediately after the 190 computed jumps were materialized, the first bare `decompile(0x40A560)` returned `None`, failure code `-1`, error EA `0x40A560`, and `INTERR: 50735`; a later d810-driven decompile succeeded. Calling that a generic Hex-Rays instability was too vague.

I could not reproduce that failure with fresh disposable databases under the available Hex-Rays 9.2 and 9.3 runtimes, including the original resolver commit under 9.3. Both now return a cfunc with failure code zero on the first bare attempt. I did not add a blind retry: that could hide a genuinely malformed call. Instead, d810's verifier mirror now diagnoses 50735 with the native call EA, argument index, operand size, and type size, and the end-to-end test requires the first decompile to return both a cfunc and failure code zero.

After those repairs, this path produced oracle-equivalent control flow for `sub_40A560`. It remains the production default because it is the path with the longest regression history.

It also accumulated a lot of machinery around a graph that had already been optimized and pruned. That bothered me. If I encountered the same protection with a different arrangement of calls and shared tails, would I need another month of maturity-specific salvage rules?

## The first PREOPT experiment used the wrong unit

The obvious alternative was to import earlier, at `hxe_preoptimized`, before local optimization and call analysis.

The first experiment generated one detached target at a time. That proved several useful SDK facts. Explicit ranges with native call EAs can survive destination-side CALLS analysis. Fictitious call addresses fail. `MBL_PUSH` and `MBA2_HAS_OUTLINES` matter when Hex-Rays analyzes the imported calls.

The result still did not recover the function. Importing the nine fragments on the current frontier left 54 unresolved transitions. Importing all 64 prepared fragments left the same 54. Earlier maturity did not solve the topology.

The mistake was the unit of recovery. Those targets were not 64 independent snippets. They were pieces of one state-machine region with shared native blocks, conditional state choices, and common call setup. Generating each target separately cloned shared blocks and severed the relationships between them.

## A semantic closure, imported once

The corrected PREOPT design starts from resolver-proven handler entry EAs and builds a conservative closure over the native CFG.

For each seed, it follows direct branches and fall-through edges. It includes handler-tail state writes, both arms of a conditional state choice, call setup, and calls. It stops at a return, a resolver-proven transfer out of the region, or an indirect edge it cannot classify. It then adds the backward dependencies needed to explain a stack-carried state or predicate. Overlapping intervals are merged so every shared native block is translated once.

For this function the closure contained:

```text
38 native blocks
16 merged address ranges
40 proven internal edges
1 generated PREOPT template with 63 blocks
1 import into the live MBA
```

That restored the shared native edge from `0x40BB3D` to `0x40C6DA`, which per-target generation had split across fragments.

The union alone was not enough. Replaying the later control manifest against it still produced 566 lines, 89 rough calls, and four dispatcher loops. The comparable control had 555 lines, 84 calls, and two loops. The regenerated reference had 201 lines. The experiment had disproved per-target generation, but it had not yet explained how the imported closure joined the live graph.

## Boundary ports were the missing abstraction

The final step was to model each edge across the closure boundary as a proof-carrying port.

A port records a stable native source EA, its destination EA, its direct or conditional shape, and which side owns each endpoint. Ownership is either `LIVE` or `IMPORTED`. Conditional ports also retain arm orientation so a true edge cannot be attached as the false edge after Hex-Rays rewrites a block. Terminal ports carry a proven return value and its ABI carrier.

The planner captures those facts before the graph changes. At `hxe_preoptimized`, it binds them to the imported blocks through native-EA provenance. It applies a port only if the live topology still matches the captured proof. If the source is ambiguous, an endpoint is missing, or a return carrier is not unique, it abstains. It never guesses that an unmatched state is a return.

Block serials are coordinates in one MBA at one moment. LOCOPT, CALLS, block insertion, and cleanup can all renumber them, so no boundary-port fact carries a serial across phases. d810 persists native EAs and imported-origin provenance instead, then rebuilds the EA-to-current-block binding against each live MBA. A cached serial is only a hint and must still contain one of the registered anchor EAs. If it does not, the resolver scans the current blocks for a unique instruction anchor or imported-origin match. Address ranges establish which recovered region owns an EA; exact anchors decide which live block may be mutated. Ambiguity makes the port abstain.

The successful run applied 75 ports without one port abstention. It imported 41 blocks into the live MBA. For the terminal path, it restored the return carrier captured at `0x40C7EA` in the imported block anchored at `0x40C898`. Then it stopped modifying the graph and let Hex-Rays perform LOCOPT, CALLS, global optimization, lvar allocation, and structuring.

The final result was 211 lines and 5,671 bytes of pseudocode, with no dispatcher `while (1)`. It had the same ordered named-call inventory and side effects as the freshly regenerated reference. The two stray `HIBYTE` expressions from the earlier build were gone. It contained all six cleanup `free` calls and ended with:

```c
return &off_48B8A4;
```

The GUI and message-loop region was present too:

```c
CreateWindowExW(...);
while ( GetMessageA(&Msg, nullptr, 0, 0) )
{
  TranslateMessage(&Msg);
  DispatchMessageA(&Msg);
}
```

The remaining differences are presentation rather than missing behavior: the reference renders 201 lines, while d810 renders 211; some local names, calling-convention text, and equivalent cleanup expressions differ. The bad-stack-pointer warning is gone, and the recovered guard is the direct expression `sub_40F830() && MessageBoxW(...) == 7` rather than a type-distorted substitute.

## LOCOPT/CALLS and PREOPT are solving the same problem differently

Both approaches recover the function. Their tradeoffs are different.

| Property | LOCOPT/CALLS production path | PREOPT semantic closure |
| --- | --- | --- |
| Recovery unit | Detached mature snippets | One union of the native semantic region |
| Hook point | Capture around LOCOPT, repair and route at CALLS | Import once at `hxe_preoptimized` |
| Topology | Reconstructed after some pruning and folding | Internal native CFG built before import; exact boundary ports added afterward |
| Source ownership | Activate one deterministic lowest-EA source per `(state, target)`; leave the others on the dispatcher | Preserve every resolver-proven source for the complete transfer relation |
| Calls | Preserve or rebuild mature call templates and verifier state | Keep native call EAs and let ordinary CALLS analysis run after import |
| Predicates | Carry evidence across maturities when the live graph folds it | Preserve predicate-producing blocks inside the closure when proven |
| Main strength | Known-good production behavior and broad regression history | Cleaner ownership model and a more reusable unit for future detached regions |
| Current status | Default production path | Profile-gated investigation path |

The LOCOPT/CALLS path is a repair system for mature microcode. The PREOPT path is a composition system for native regions that the top-level MBA omitted. The second design feels more reusable because it gives Hex-Rays a coherent graph earlier instead of reconstructing every semantic relationship after local optimization.

That does not make PREOPT universally better. Native closure is a new subsystem with cut points, dependency recovery, and abstention rules. The late importer has already survived the existing Hodur, Approov, and Tigress suites. Moving the default requires more than one loader, even if this loader is a hard one.

## The SDK operation I wanted does not exist

Hex-Rays already exposes most of the pieces:

- it can generate microcode for explicit address ranges;
- `hxe_preoptimized` lets a plugin modify an MBA before LOCOPT and CALLS;
- the microcode API can create blocks, instructions, and edges;
- the later pipeline can analyze calls and structure a valid graph.

What it does not expose is one operation that says: these detached ranges are owned by this function, these resolver-proven native edges connect them to the live graph, and their stack and call provenance should be preserved as one composable region.

Without that operation, a plugin has to bridge two separately generated MBAs. It must translate block ownership, stack identities, call metadata, and edge provenance while staying inside verifier invariants that are only partly documented. It also has to do this before Hex-Rays prunes the detached side, because an earlier maturity does not change the native flow chart used to build the top-level MBA.

This is a gap in extensibility, not a claim that Hex-Rays cannot decompile Rhadamanthys. Once d810 supplies the missing region and exact edges, Hex-Rays does the hard part very well. Its ordinary optimizer turns the imported microcode into clean conditionals, a normal message loop, and readable cleanup code.

## How I checked the result

The final end-to-end test does not compare only line count or the absence of a dispatcher loop. It decompiles a disposable copy of the loader in a fresh idalib process, runs the public two-round d810 workflow, and checks semantic landmarks from the regenerated native oracle.

The assertions require:

- a nonempty decompilation with no dispatcher `while (1)`;
- the expected zero-argument `sub_40F830()` call;
- the parser call that receives `&Param[13]`;
- one `CreateWindowExW`, `GetMessageA`, `TranslateMessage`, and `DispatchMessageA` call;
- the `MessageBoxW(...) == 7` branch;
- exactly six `free` calls;
- `return &off_48B8A4`.

The committed change passed 5,704 unit tests, plus 146 focused runtime tests and the dedicated Docker semantic-parity test. The full Docker system suite passed 2,853 tests. All 13 import contracts passed, and the architecture scan was clean.

The sample-specific EAs and probe switches live under `tools/scripts/rhad_investigation`. Production recovery does not match `0x40A560`, any Rhadamanthys state constant, or the name of this sample. The generalized pieces operate on storage identity, native-EA provenance, closure ownership, and proof-carrying boundary ports. The PREOPT path is profile-gated, so it does not change the Tigress path unless a profile opts in.

## The useful part of the detour

The reference rewriter's recipe was short: recover the state map, trace state assignments, preserve the predicates, replace dispatcher traversal with real branches, and let dead-code removal erase the dispatcher. d810 now does those same things in microcode.

The long part was learning where each fact had to exist for Hex-Rays to use it. A target without its predicate was not enough. A recovered handler without an entry bridge was not enough. A valid detached MBA without ownership in the live function was not enough. An early import without coherent topology was not enough either.

The step that finally simplified the design was treating the missing body as one semantic region and its external edges as explicit ports. That maps closely to the native rewriter while preserving the reason to do this inside d810: once the graph is valid, Hex-Rays can perform its own call analysis, optimization, and structuring instead of decompiling bytes that another tool patched permanently.
