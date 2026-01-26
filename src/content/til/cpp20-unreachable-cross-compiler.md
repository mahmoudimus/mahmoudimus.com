---
Title: C++20 doesn't have std::unreachable() - here's what to use instead
Date: 2026-01-26
Category: C++
Tags: til, cpp, cpp20, cross-platform, msvc, gcc, clang
Classification: til
Author: Mahmoud
Excerpt: std::unreachable() is C++23, not C++20. Here's a portable alternative.
---

Today I learned that `std::unreachable()` is a C++23 feature, not C++20. I hit this when trying to fix MSVC warning C4715 ("not all control paths return a value") in a switch statement's default case.

## The Problem

I had switch statements like this that needed to indicate the default case was unreachable:

```cpp
inline constexpr auto opcodeext_alu(e_instruction_id id) {
    switch (id) {
    case e_instruction_id::add: return e_opcode_alu_extension::add;
    case e_instruction_id::sub: return e_opcode_alu_extension::sub;
    // ... other cases ...
    default:
        std::unreachable();  // C++23 only!
    }
}
```

GCC and Clang were happy, but MSVC complained about `std::unreachable()` not being available.

## The Fix

Use compiler intrinsics directly:

```cpp
namespace detail {
    [[noreturn]] inline void unreachable_impl() {
#if defined(_MSC_VER) && !defined(__clang__)
        __assume(false);
#else
        __builtin_unreachable();
#endif
    }
}
```

Then use `detail::unreachable_impl()` in your switch defaults.

## Why not just suppress the warning?

Using `#pragma warning(disable: 4715)` or pragma clang diagnostic push/pop works, but it's hiding a potentially real bug. The explicit unreachable marker documents intent and helps the optimizer.

## Bonus: constexpr context

If you need this in a `constexpr` function and want a compile-time error if the unreachable path is actually taken, you might think to add:

```cpp
if (std::is_constant_evaluated()) {
    throw "unreachable code in constexpr";
}
```

But MSVC doesn't like `throw` in constexpr functions (even though C++20 technically allows it). The simpler version without the constexpr check works fine - the compiler will still catch invalid paths at compile time because the function won't return a value.
