+++
Title: Building a compile-time x86 assembler in C++20
Date: 2026-01-26
Author: Mahmoud
Tags: c++, assembly, x86, constexpr, cpp20, reverse engineering
Classification: blog
Excerpt: Using C++20 concepts and constexpr to encode x86 instructions at compile time
+++

When you write shellcode by hand, you typically end up with something like this:

```cpp
const uint8_t shellcode[] = {
    0x48, 0x89, 0xc3,  // mov rbx, rax
    0x48, 0x83, 0xc0, 0x10,  // add rax, 0x10
    0xc3  // ret
};
```

It works, but it is error prone. Did I get the REX prefix right? Is `0x89` the correct opcode for that `mov` variant? The only way to find out is to run it and see what happens, or disassemble it and compare against what you intended.

The alternative is to use an assembler at runtime, like Keystone or AsmJit. But those add dependencies and runtime overhead. For security research and exploit development, you often want shellcode that is baked directly into the binary at compile time, with no runtime assembly step.

This post is about `static_asm`, a header-only C++20 library that encodes x86 and x86-64 instructions entirely at compile time. The machine code bytes end up in your binary as if you had written them by hand, but with full type safety and readable syntax.

## What does it look like?

Here is a simple example:

```cpp
#include "static_asm.hpp"

using namespace static_asm::x86::registers;
using namespace static_asm::x86::instructions;

constexpr auto shellcode = core::assemble(
    push(rbp),
    mov(rbp, rsp),
    sub(rsp, 0x28),
    mov(rcx, 0x12345678),
    xor_(rdx, rdx),
    call(rax),
    add(rsp, 0x28),
    pop(rbp),
    ret()
);
```

The variable `shellcode` is a `std::array<uint8_t, 25>`. The size is computed at compile time. The bytes are computed at compile time. If you mess up an operand, you get a compiler error, not a crash at runtime.

## Why C++20 concepts matter

The real magic is type safety through concepts. In x86, you cannot `mov` a 64-bit register into a 32-bit register. You cannot use an immediate as a destination. You cannot use LEA with a register operand. These are all encoding errors that would produce garbage bytes.

With C++20 concepts, the compiler catches these mistakes before your code ever runs:

```cpp
mov(eax, rbx);      // error: size mismatch (32-bit dest, 64-bit src)
add(0x10, rax);     // error: immediate cannot be destination
lea(rax, rbx);      // error: LEA requires memory operand
```

The constraint looks like this:

```cpp
template <typename Op1, typename Op2>
    requires (Register<Op1> && (Register<Op2> || Immediate<Op2> || Memory<Op2>))
          && (Op1::size == Op2::size || Immediate<Op2>)
inline constexpr auto mov(Op1 dst, Op2 src);
```

The compiler error messages are actually readable:

```
error: no matching function for call to 'mov'
note: candidate template ignored: constraints not satisfied
note: because 'Op1::size == Op2::size' evaluated to false
```

This is a big deal. When you are writing shellcode for a CTF or a security assessment, the last thing you want is to debug encoding errors at 2am. The type system catches them for you.

## The encoding layer

Under the hood, the library has to deal with all the complexity of x86 encoding: REX prefixes, ModR/M bytes, SIB bytes, displacement sizes, immediate sizes, and opcode extensions. Each instruction function returns a `std::array<uint8_t, N>` where N is known at compile time.

For example, `mov(rax, rbx)` needs to:

1. Determine that we need a REX.W prefix (64-bit operands)
2. Choose the correct opcode (0x89 for reg-to-reg mov)
3. Encode the ModR/M byte with the register indices
4. Return the three-byte array `{0x48, 0x89, 0xd8}`

All of this happens in `constexpr` functions. The compiler evaluates them during compilation and embeds the result directly in your binary.

The `core::assemble()` function concatenates multiple instruction arrays:

```cpp
template<class... Ts>
    requires(FixedByteArray<Ts> && ...)
constexpr auto assemble(const Ts&... inputs) {
    return detail::concat(inputs...);
}
```

Because the sizes are known at compile time, the concatenation is just a compile-time loop that copies bytes into a larger array. No allocations, no runtime overhead.

## SIB addressing

One of the trickier parts of x86 encoding is Scale-Index-Base addressing. The library supports the full syntax:

```cpp
mov(rax, qword_ptr(rbx + rcx * s8 + 0x100));
```

This compiles to the correct bytes with a SIB byte encoding scale=8, index=rcx, base=rbx, and a 32-bit displacement. The `s8` is a compile-time scale factor, and the memory operand type carries all the information needed to encode the instruction.

## Cross-platform CI with -Werror

One of the more tedious parts of maintaining a header-only C++ library is making sure it compiles cleanly across compilers. The library builds with `-Werror` (treat warnings as errors) on:

- GCC 11+ (Linux)
- Clang 14+ (Linux, macOS)
- MSVC 2022 (Windows)

This required fixing a few platform-specific issues:

**Signed/unsigned comparison**: GCC and Clang warn about comparing `int` loop indices with `size_t` bounds. The fix is to use `std::size_t` for the loop variable.

**MSVC unknown pragma**: MSVC warns about `#pragma clang diagnostic` directives. The fix is to disable warning C4068.

**MSVC conversion warnings**: MSVC warns about intentional truncation when encoding immediates. The fix is to disable warning C4244 for the test target.

**MSVC unreachable code**: MSVC warns about switch statements where not all control paths return a value, even when the default case is supposed to be unreachable. The fix is to use `__assume(false)` on MSVC and `__builtin_unreachable()` on GCC/Clang.

**Test discovery timeout**: MSVC Debug builds take longer to discover tests via GoogleTest. The default 5-second timeout was not enough. The fix is to set `DISCOVERY_TIMEOUT 30` in the CMake configuration.

None of these are especially interesting on their own, but together they add up to a lot of time spent on platform quirks. CI with `-Werror` catches regressions before they land.

## The release workflow

The library ships as both a modular header set and a single amalgamated header. The release workflow:

1. Waits for CI to pass
2. Checks if a version tag exists at the tested commit
3. Generates the single-header amalgamation using `quom`
4. Tests that the amalgamated header compiles
5. Creates a GitHub release with the header attached

This means releases only happen when all tests pass on all platforms. The single header is convenient for users who want to drop one file into their project.

## Executing the code

Once you have the bytes, how do you actually run them? There are a few options.

The library includes an `emit()` function that uses inline assembly to inject the bytes directly into the instruction stream:

```cpp
constexpr auto code = core::assemble(
    mov(rax, 42),
    ret()
);

core::emit(code);  // Returns 42
```

This only works on GCC and Clang with `-O2` optimization. MSVC does not support inline assembly for x64.

For cross-platform code, you can allocate executable memory and call it as a function pointer:

```cpp
#ifdef _WIN32
void* mem = VirtualAlloc(nullptr, code.size(),
                         MEM_COMMIT | MEM_RESERVE,
                         PAGE_EXECUTE_READWRITE);
#else
void* mem = mmap(nullptr, code.size(),
                 PROT_READ | PROT_WRITE | PROT_EXEC,
                 MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
#endif

memcpy(mem, code.data(), code.size());
auto func = reinterpret_cast<int(*)()>(mem);
int result = func();
```

For shellcode injection use cases, you would use `WriteProcessMemory` or similar APIs to copy the bytes into a target process.

## What is missing

The library does not support SIMD or AVX instructions yet. For most shellcode and JIT use cases, the general-purpose instructions are enough. Adding SIMD would require a lot more encoding logic and testing.

Labels and relocations are also not implemented. Currently you specify offsets manually. A label system would be nice for longer code sequences:

```cpp
// Hypothetical future API
auto code = assemble(
    label("loop"),
    dec(ecx),
    jnz("loop")
);
```

This would require tracking label positions and patching jump offsets, which adds complexity.

## Try it out

The library is available at [github.com/mahmoudimus/static_asm](https://github.com/mahmoudimus/static_asm). You can use it via CMake FetchContent or by downloading the single-header release.

```cmake
FetchContent_Declare(
    static_asm
    GIT_REPOSITORY https://github.com/mahmoudimus/static_asm.git
    GIT_TAG v0.1.0
)
FetchContent_MakeAvailable(static_asm)
target_link_libraries(your_target PRIVATE static_asm::static_asm)
```

If you work on shellcode, JIT compilers, or just want to learn x86 encoding in a hands-on way, give it a try. The type safety alone is worth it.
