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

## Designing the memory operand DSL

One of the trickier parts of x86 encoding is Scale-Index-Base addressing. The Intel syntax looks like `[rbx + rcx*8 + 0x100]`. How do you represent that in C++?

The obvious approach is a function with positional arguments:

```cpp
// Rejected: positional arguments
qword_ptr(rbx, rcx, 8, 0x100);  // base, index, scale, displacement
```

This works, but it is hard to read. Which argument is the scale? Which is the displacement? You have to remember the order every time. It also does not handle the common cases cleanly: what if you only have a base register? What if you only have a displacement?

Instead, the library uses operator overloading to build up an expression tree at compile time:

```cpp
// Accepted: operator-based DSL
qword_ptr(rbx + rcx * s8 + 0x100)
```

This reads almost exactly like the Intel syntax. The trick is that each operator returns a new type that captures the accumulated state.

### Building expressions with operator overloading

The first piece is a `scale_t` template that represents compile-time scale factors:

```cpp
template<int N>
    requires ValidScale<N>
struct scale_t {
    static constexpr int value = N;
};

inline constexpr scale_t<1> s1{};
inline constexpr scale_t<2> s2{};
inline constexpr scale_t<4> s4{};
inline constexpr scale_t<8> s8{};
```

The `ValidScale` concept ensures you can only use 1, 2, 4, or 8. Trying to write `rcx * s3` is a compile error.

Next, `operator*` between a register and a scale produces a `scaled_reg`:

```cpp
template<typename Reg, int Scale>
    requires Register<Reg> && ValidScale<Scale>
struct scaled_reg {
    Reg reg;
    static constexpr int scale = Scale;
};

template<typename Reg, int N>
    requires Register<Reg> && ValidScale<N>
constexpr scaled_reg<Reg, N> operator*(Reg r, scale_t<N>) {
    return scaled_reg<Reg, N>{ r };
}
```

So `rcx * s8` produces a `scaled_reg<rcx_t, 8>`. The scale is baked into the type.

Then `operator+` between a register and a scaled register produces an `address_expr`:

```cpp
template<typename Base, typename Index, int Scale, e_displacement_type DT>
struct address_expr {
    Base base;
    Index index;
    std::int32_t displacement = 0;
    static constexpr int scale = Scale;
    // ...
};

template<typename Base, typename Index, int Scale>
    requires Register<Base> && Register<Index>
constexpr auto operator+(Base b, scaled_reg<Index, Scale> sr) {
    return address_expr<Base, Index, Scale, e_displacement_type::disp0>{
        b, sr.reg, 0
    };
}
```

So `rbx + rcx * s8` produces an `address_expr<rbx_t, rcx_t, 8, disp0>`.

Finally, adding a displacement updates the expression:

```cpp
template<typename Base, typename Index, int Scale, e_displacement_type DT,
         std::integral Disp>
constexpr auto operator+(address_expr<Base, Index, Scale, DT> addr, Disp disp) {
    auto disp32 = static_cast<std::int32_t>(disp);
    if constexpr (sizeof(Disp) == 1) {
        return address_expr<Base, Index, Scale, e_displacement_type::disp8>{
            addr.base, addr.index, disp32
        };
    } else {
        return address_expr<Base, Index, Scale, e_displacement_type::disp32>{
            addr.base, addr.index, disp32
        };
    }
}
```

The displacement type is automatically inferred from the value. Small displacements use `disp8` (one byte), larger ones use `disp32` (four bytes). This affects the final encoding.

### From expression to memory operand

The `qword_ptr` function takes an `address_expr` and produces a `sib_memory_operand`:

```cpp
template<typename Base, typename Index, int Scale, e_displacement_type DT>
constexpr auto qword_ptr(address_expr<Base, Index, Scale, DT> addr) {
    return sib_memory_operand<Base, Index, Scale, 64, DT>{ addr };
}
```

The `sib_memory_operand` type carries everything needed for encoding: the base register, index register, scale factor, operand size, and displacement type. All of this is available at compile time through template parameters.

### Why this matters

The expression-based DSL has several advantages:

1. **Readability**: `qword_ptr(rbx + rcx * s8 + 0x100)` is immediately recognizable as SIB addressing. No need to remember argument order.

2. **Type safety**: Invalid combinations fail at compile time. You cannot use RSP as an index register (x86 does not allow it). You cannot use scale factors other than 1, 2, 4, 8.

3. **Automatic optimization**: The displacement type is inferred from the value. Small offsets use compact encodings.

4. **Composability**: You can build up expressions in pieces. `auto base = rbx + rcx * s4; auto mem = qword_ptr(base + offset);`

The downside is complexity. The operator overloads produce a web of template instantiations that can be hard to debug. But the user-facing API is clean, and the complexity is hidden in the implementation.

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

## Why amalgamate at all?

The library ships as both a modular header set and a single amalgamated header. But why bother with amalgamation in 2026? We have vcpkg, Conan, and CMake's FetchContent. Package managers handle dependencies. Build systems handle includes. Who needs a single file?

The answer is friction.

### The security research context

When you are doing security research, reverse engineering, or CTF competitions, you often work in constrained environments:

- Corporate machines with locked-down package managers
- VMs spun up for malware analysis that you do not want to pollute with dev tools
- Contest environments where you cannot install arbitrary software
- Quick experiments where you just want to test an idea

In these contexts, "add this to your CMakeLists.txt and run cmake" is not a one-liner. It is a commitment. You need CMake installed. You need network access for FetchContent. You need write access to create build directories.

A single header file changes the equation:

```cpp
// Just copy the file and go
#include "static_asm.hpp"
```

No build system. No package manager. No network. Copy one file, add one include, compile.

### Compile time benefits

SQLite popularized amalgamation for a different reason: compile times. When you compile 130 separate files, the compiler has to:

- Parse each file independently
- Resolve includes repeatedly
- Generate separate object files
- Link them together

With a single amalgamated file, the compiler sees everything at once. It can inline more aggressively, eliminate redundant parsing, and skip the linking step entirely. SQLite reports 5-20% faster compiles with the amalgamated build.

For a small library like static_asm this matters less. But for users who include it in a larger project, every bit helps.

### When package managers make sense

Amalgamation is not always the answer. If you are building a serious project with proper dependency management, FetchContent or vcpkg is better:

```cmake
FetchContent_Declare(
    static_asm
    GIT_REPOSITORY https://github.com/mahmoudimus/static_asm.git
    GIT_TAG v0.1.0
)
FetchContent_MakeAvailable(static_asm)
target_link_libraries(your_target PRIVATE static_asm::static_asm)
```

This gives you version pinning, transitive dependencies, and proper CMake integration. The modular headers also make it easier to navigate the code in an IDE.

The point is to offer both options. Serious projects use the package. Quick experiments use the single header. Everyone is happy.

## Choosing an amalgamation tool

Amalgamation is the process of combining multiple source files into one, made famous by SQLite's `sqlite3.c` which concatenates over 130 files into a single compilation unit.

There are several C++ amalgamation tools available:

- [**quom**](https://github.com/Viatorus/quom): Python-based, resolves `#include` directives and finds related source files. Actively maintained.
- [**Heady**](https://github.com/JamesBoer/Heady): Requires marking functions with `inline_t` macros that get replaced during transformation. More manual setup.
- [**Amalgamate**](https://github.com/vinniefalco/Amalgamate) (vinniefalco): The original tool, written in C++. Requires building from source.
- [**cpp-amalgamate**](https://github.com/Felerius/cpp-amalgamate): Designed for competitive programming submissions. Does not handle preprocessor guards well.
- [**shrpnsld/amalgamate**](https://github.com/shrpnsld/amalgamate): Bash-based, works on macOS stock Bash. More control but more verbose configuration.

I chose quom for a few reasons:

1. **Zero preparation**: quom works with existing code. No `inline_t` macros, no special annotations. Point it at your main header and it figures out the include graph.

2. **Python-based**: Easy to install (`pip install quom`), easy to run in CI. No compilation step.

3. **Handles the common case well**: For a header-only library with a clear entry point (`static_asm.hpp`), quom just works. It recursively inlines local includes and strips duplicate `#pragma once` directives.

4. **Actively maintained**: quom has recent commits and responds to issues.

The command is simple:

```bash
quom include/static_asm.hpp single_include/static_asm.hpp \
    -I include --trim
```

The `--trim` flag removes leading/trailing whitespace from the output. The result is a single header that can be dropped into any project.

## Automating amalgamation in CI

Running quom locally works, but you do not want to manually generate and upload the amalgamated header every time you release. The goal is: push a tag, and the single header appears on the releases page automatically.

Here is the GitHub Actions workflow that makes it happen. The key steps are:

### 1. Install quom

```yaml
- name: Set up Python
  uses: actions/setup-python@v5
  with:
    python-version: '3.12'

- name: Install quom
  run: pip install quom
```

### 2. Generate the amalgamated header with a version banner

```yaml
- name: Generate single-header
  run: |
    mkdir -p single_include
    VERSION=${{ steps.version.outputs.tag }}

    # Create a header banner with version and license info
    cat > /tmp/header.txt << EOF
    // static_asm - Compile-time x86/x86-64 assembler for C++20
    // Version: ${VERSION}
    // https://github.com/mahmoudimus/static_asm
    //
    // SPDX-License-Identifier: BSL-1.0 OR MIT
    EOF

    # Run quom to generate the amalgamation
    quom include/static_asm.hpp /tmp/amalgamated.hpp \
      -I include --trim

    # Combine banner + amalgamated code
    cat /tmp/header.txt /tmp/amalgamated.hpp > single_include/static_asm.hpp
```

The version banner is important. When someone downloads `static_asm.hpp` six months from now, they can see which version it is without having to diff against the repository.

### 3. Test that the amalgamation actually works

```yaml
- name: Test single-header
  run: |
    cat > /tmp/test.cpp << 'EOF'
    #include "single_include/static_asm.hpp"
    using namespace static_asm::x86::registers;
    using namespace static_asm::x86::instructions;
    int main() {
        constexpr auto code = static_asm::core::assemble(mov(rax, rbx), ret());
        static_assert(code.size() == 4);
        return 0;
    }
    EOF
    g++ -std=c++20 -I. /tmp/test.cpp -o /tmp/test && /tmp/test
```

This catches amalgamation bugs before they reach users. If quom misses a header or mangles an include, the test fails and the release does not happen.

### 4. Attach the header to the GitHub release

```yaml
- name: Create Release
  uses: softprops/action-gh-release@v2
  with:
    files: single_include/static_asm.hpp
    tag_name: ${{ steps.version.outputs.tag }}
    generate_release_notes: true
```

The `files` parameter is an array of paths to upload as release assets. Users see a download link right on the release page.

## The release workflow

The library uses GitHub Actions to automate releases. The workflow is split into two jobs to ensure releases only happen when tests pass.

The [release workflow](https://github.com/mahmoudimus/static_asm/blob/master/.github/workflows/release.yml) has three triggers:

1. **Tag push**: When you push a `v*` tag, it triggers a release
2. **CI completion**: When CI passes, it checks if a version tag points at the tested commit
3. **Manual dispatch**: For testing, you can trigger it manually from the Actions UI

The `workflow_run` trigger is the key to safe releases:

```yaml
on:
  workflow_run:
    workflows: [CI]
    types:
      - completed
```

When CI completes successfully, the release workflow checks if any `v*` tag points at the tested commit:

```bash
TAG=$(git tag --points-at HEAD | grep -E '^v' | head -n1)
if [ -z "$TAG" ]; then
    echo "No v* tag at HEAD; skipping release."
fi
```

If a tag exists, it generates the amalgamated header, tests it, and creates the release using [softprops/action-gh-release](https://github.com/softprops/action-gh-release):

```yaml
- name: Create Release
  uses: softprops/action-gh-release@v2
  with:
    files: single_include/static_asm.hpp
    tag_name: ${{ steps.version.outputs.tag }}
    generate_release_notes: true
```

The `files` parameter attaches the amalgamated header to the release as a downloadable asset. Users can grab it directly from the [releases page](https://github.com/mahmoudimus/static_asm/releases).

This workflow pattern ensures:

- Releases only happen when all CI jobs pass
- The released code is exactly what was tested
- No manual steps required beyond pushing a tag

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
