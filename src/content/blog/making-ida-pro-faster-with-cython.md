+++
Title: IDA Pro and Cython: super-charging the work-horse of reverse engineering
Date: 2025-08-01
Author: Mahmoud
Tags: reverse engineering, cython, ida pro
Classification: blog
Excerpt: Cython and IDA Python for super fast reversing tools
+++

Python is an incredibly powerful language. It powers AI research, backend servers and, crucially for security researchers, the scripting interfaces of the big three disassemblers: `IDA Pro`, `Ghidra` and `Binary Ninja`. Because it is easy to read and write, Python has become the de facto lingua franca of malware analysis and reverse engineering.

That convenience comes with an old and familiar price: speed. Tight loops that crawl through binary blobs or apply heuristic checks can grind to a halt when written in pure Python. The internet is full of "make Python faster" posts: you can embed C, use `pybind11` or `Numba`, or offload work to asynchronous frameworks. In this series I am going to talk about the route I took for IDA plugins: `Cython`.

It has been roughly two years since `Cython 3.0.0` was released, and it had been a while since I used it in anger. At the same time I had been using `IDA Pro` more and more, and I kept running into the same pattern: the workflow is great, the performance is not. This post is part 1 of a series about using Cython to speed up Python-based IDA plugins without giving up the nice parts of IDAPython.

## When REPL-driven productivity hits a performance wall

IDA Pro's strength lies in its interactivity (the I is literally "interactive"). Most people write their first scripts directly in the `IDAPython` console or by dropping a `.py` file into the plugins directory and poking at the database. That REPL-driven workflow is a big reason the community has so many small one-off scripts and quick experiments.

The friction is low:

* clone a repository
* drop a `.py` file into the plugins folder
* press a hotkey and start hacking

The problem is that the same properties that make Python pleasant also make it slow when you start doing serious work. When you build complicated algorithms for deobfuscation, or when you call heavy solvers like `Z3`, function call overhead and dynamic dispatch overhead become bottlenecks. Even fairly simple operations, like scanning a large binary for wildcard patterns, can become noticeably sluggish when written in pure Python and called in a tight loop.

Rewriting everything in C or C++ is rarely attractive:

* the `IDA SDK` changes between versions
* compiling cross-platform plugins is time-consuming
* you need a working build environment on Windows, macOS and Linux
* many C plugins go stale because maintainers cannot keep up

Python plugins, by contrast, tend to be forked and updated much faster. The community thrives on low friction. The question is how to get C-like performance where it matters without throwing away the Python plugin ecosystem.

## Enter Cython

`Cython` is a language and toolchain that compiles Python-like code to C. The official docs describe it as an optimizing static compiler that makes writing C extensions for Python "as easy as Python itself." Any valid Python module is also valid Cython, and you can gradually add type declarations to tune performance.

At a high level, Cython gives you three important capabilities:

* it can call C or C++ functions directly
* it lets you declare C types on variables, function arguments and class attributes
* it can generate efficient, portable C or C++ code that compiles to a regular Python extension module

For reverse engineering work, this means you can keep the flexibility of Python for glue code, UI, and IDA integration, while escaping the interpreter for speed-critical loops. Other projects like `mypyc` and `Numba` target similar spaces, but Cython shines when you need to interoperate with C++ libraries and ship a normal Python package. That is exactly the situation you run into when working with `IDA`'s C++ based SDK and its embedded `CPython`.

## Why Cython for IDA Pro?

The premise is simple: write your plugin in Python, and then selectively annotate the hot paths so that `Cython` can turn them into efficient C. Because Cython compiles down to portable C, you can produce binaries for macOS, Linux and Windows, and for multiple CPython versions, without being locked into `IDA`'s SDK.

Crucially, you do not have to force every contributor to install a compiler toolchain or understand Cython. A Cythonized plugin can still be installed by dropping a single `.py` file into `IDA`'s plugins folder. The compiled speedups are optional extras:

* contributors can work in plain Python for high level logic
* performance critical kernels live in `.pyx` files
* you can publish compiled wheels for users who want maximum speed

This lowers the barrier to entry relative to pure C or C++ while preserving cross platform compatibility. As the `README` for my plugin notes, the goal is to "work with future versions of IDA without needing to compile against the IDA SDK" and to "allow for easier community contributions."

The rest of this post walks through a concrete example of that approach.

## A case study: ida-sigmaker

`ida-sigmaker` is a cross platform plugin that generates unique binary signatures for functions and addresses. Version `1.4.0` was written entirely in Python: you copied `sigmaker.py` into your plugins directory and used `Ctrl+Alt+S` to create signatures. That kept installation friction low, but the core algorithms were bottlenecked by pure Python loops.

Scanning through a large binary to find wildcard patterns or nibble masks is inherently data heavy. In the pure Python version, the plugin relied on nested loops over Python byte sequences and a lot of per iteration Python level work. It worked, but it was not what you would call snappy.

For version `1.6.0` I added optional SIMD speedups using Cython. The `README` now describes sigmaker as a "zero-dependency cross-platform signature maker plugin with optional SIMD (for example `AVX2`, `NEON`, `SSE2`) speedups." If you install sigmaker from PyPI, the setup process will build or download an appropriate wheel for your system. When you load the plugin in `IDA`, it automatically uses the compiled speedups if they are available.

The plugin even exposes this in the UI: there is an icon in the menu bar indicating whether SIMD acceleration is active.

### setup.py and platform detection

To make this work across platforms, I wrote a custom `setup.py` that:

* detects the host platform and architecture using Python's `platform` module
* maps those values to library names and file extensions
* returns platform specific compile and link flags

On Windows it uses `MSVC` compiler flags. On Linux it enables a few warning suppressions. On macOS there is a special branch that sets a minimum supported OS version and adjusts optimization levels so the wheels run on both older and newer releases.

The setup script then calls `cythonize` with directives like:

* `language_level="3"`
* `binding=True`
* `embedsignature=True`

and it disables bounds checking and wraparound indexing for the speed critical code. Finally, it declares and builds the `sigmaker._speedups.simd_scan` extension module and passes the compile and link arguments described above.

### The Cython side: simd_scan.pyx

Inside `src/sigmaker/_speedups/simd_scan.pyx` the core algorithm still looks a lot like Python. The module `cimport`s C types such as `size_t` and `uint8_t` and declares external functions from a header that provides `AVX2` and `NEON` primitives.

It defines a `Signature` class whose constructor parses hex and wildcard strings into bytes and builds nibble masks using tight C loops. The key is that the Python or IDAPython layer only crosses the Python/C boundary once. After that, the matching and scanning loops run entirely in C. The roughly 300 millisecond overhead I was seeing from Python loops over large blobs simply disappears.

From a contributor's point of view, this is not especially exotic. The Cython file still has a normal class and method structure, and you only need to learn a handful of new keywords (`cdef`, `cpdef`, `cimport`) to follow the code. You can work at the Python level and treat the speedups as an implementation detail.

### CI, wheels and distribution

Adding Cython also meant expanding the continuous integration pipeline.

The test workflow still spins up an IDA container and runs unit tests with coverage to make sure the plugin behaves correctly across IDA versions. The difference in v1.6.0 is that the deploy workflow uses `pypa/cibuildwheel` to build wheels for:

* Linux (`x86-64`)
* Windows (`x86-64`)
* macOS (Intel and Apple Silicon)

The `CIBW_BUILD` environment variable pins the supported CPython versions (for example `3.10` through `3.13`). After building wheels, the workflow creates a source distribution, checks it with `Twine`, and uploads both wheels and `sdist` to PyPI if the test matrix passes.

Earlier releases only shipped an `sdist` and left wheel building commented out. Turning on wheel generation means users get pre-built binaries on all major platforms and never have to invoke a compiler themselves.

On the GitHub side, a separate release workflow triggers when a tag starting with `"v"` is pushed. That workflow verifies that tests succeeded, extracts the version, generates a standalone `sigmaker.py` for people who still want the pure Python version, and creates a GitHub release with a Markdown changelog. The deploy workflow then takes care of publishing the corresponding wheels to PyPI.

The `pyproject.toml` lists Cython as both a build requirement and an optional dependency named `"speedups"`. It also includes the `.pyx`, `.pxd`, `.c` and `.cpp` source files in the package so that distributors can rebuild the speedups from source without requiring every end user to have Cython installed.

## A concrete example: FNV-1a import hashes

So far this has been fairly high level. To make things more concrete, let's look at a smaller but very common pattern in reverse engineering: import hashing.

A lot of malware does not store API names in clear text. Instead it stores a hash of the function name (and sometimes the DLL name) and walks the import tables at runtime, computing a hash for each exported name until it finds a match.

`FNV-1a` is one of the most common choices for this. It is simple, fast, and fits nicely into 32-bit or 64-bit registers. When you are writing tooling that emulates this behavior, you can easily end up computing millions of FNV-1a hashes while scanning IATs or resolving indirect calls.

That makes it an ideal candidate for a Python vs Cython comparison.

### Pure Python FNV-1a

Here is a straightforward 64-bit FNV-1a implementation in pure Python:

```python
# fnv_py.py

FNV_OFFSET_BASIS_64 = 0xCBF29CE484222325
FNV_PRIME_64 = 0x100000001B3
FNV_MASK_64 = 0xFFFFFFFFFFFFFFFF


def fnv1a_hash_py(data):
    """Simple 64-bit FNV-1a implementation in pure Python.

    Accepts bytes, bytearray, memoryview or str (UTF-8 encoded).
    """
    if isinstance(data, str):
        data = data.encode("utf-8")

    # Make sure we have a bytes-like object
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError(f"unsupported type: {type(data)!r}")

    h = FNV_OFFSET_BASIS_64
    for b in data:
        # FNV-1a step (xor then multiply)
        h = (h ^ b) * FNV_PRIME_64 & FNV_MASK_64
    return h
```

This is already fast enough for small scripts, and it works fine inside `IDAPython`. But if you start calling it hundreds of thousands of times while walking import tables across large firmware images, you will feel the overhead of the Python loop.

### Cython FNV-1a

Now here is a Cython version of the same function. It looks similar, but we give the compiler much more information about types and turn the inner loop into straight C:

```python
# fnv1a.pyx
# cython: language_level=3, boundscheck=False, wraparound=False

import cython
from cython import Py_ssize_t, uchar, ulonglong


@cython.locals(
    i=Py_ssize_t,
    n=Py_ssize_t,
    seed=ulonglong,
    prime=ulonglong,
    c=uchar,
    mask=ulonglong,
)
@cython.returns(ulonglong)
def fnv1a_hash(data):
    """64-bit FNV-1a hash function.

    Accepts bytes, bytearray, memoryview or str (UTF-8 encoded).
    """
    seed = <ulonglong>0xCBF29CE484222325
    prime = <ulonglong>0x100000001B3
    mask = <ulonglong>0xFFFFFFFFFFFFFFFF

    # Normalize input once at the Python level
    if isinstance(data, str):
        data = data.encode("utf-8")
    elif not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError(f"unsupported type: {type(data)!r}")

    cdef Py_ssize_t i, n = len(data)
    cdef uchar c

    for i in range(n):
        c = <uchar>data[i]
        # same FNV-1a step as the Python version
        seed = (seed ^ c) * prime & mask

    return seed
```

There are a few important details here:

* We disable bounds checking and negative index wraparound at the top of the file. That removes safety checks from the hot loop.
* We declare all locals with concrete C types: `Py_ssize_t` for indices, `uchar` for bytes, `ulonglong` for the 64-bit hash state.
* We normalize the input once at the Python level (handling `str` and type checks) and then stay in C for the loop.

From Python or IDAPython, you would import this just like any other module:

```python
# inside IDA or normal Python
from fnv1a import fnv1a_hash

print(fnv1a_hash(b"kernel32.dll!CreateFileA"))
```

The call boundary between Python and Cython happens once per string, and the inner loop runs at C speed.

## A simple performance harness

You do not have to take this on faith. You can benchmark the two implementations outside of IDA to get a feel for the speedup before wiring Cython into a plugin.

Create a small script like this:

```python
# bench_fnv.py

import timeit

from fnv_py import fnv1a_hash_py
from fnv1a import fnv1a_hash as fnv1a_hash_cy


def main():
    # Pretend these are API names we are hashing while walking an import table
    symbols = [
        b"kernel32.dll!CreateFileA",
        b"kernel32.dll!ReadFile",
        b"kernel32.dll!WriteFile",
        b"kernel32.dll!CloseHandle",
        b"ntdll.dll!ZwQueryInformationProcess",
        b"ntdll.dll!ZwProtectVirtualMemory",
    ] * 100

    iters = 50_000

    # Use lambda callables to benchmark the functions with timeit
    t_py = timeit.timeit(lambda: [fnv1a_hash_py(s) for s in symbols], number=iters)
    t_cy = timeit.timeit(lambda: [fnv1a_hash_cy(s) for s in symbols], number=iters)

    print(f"Python  fnv1a: {t_py:.3f} s")
    print(f"Cython  fnv1a: {t_cy:.3f} s")
    if t_cy > 0:
        print(f"Speedup: {t_py / t_cy:.1f}x")


if __name__ == "__main__":
    main()
```

Run it once with just the pure Python implementation available, and once with the compiled Cython module on your `PATH`. On a typical desktop you should see a clear improvement in the Cython version, especially as you bump up the number of iterations.

In an IDA context, the pattern looks like this:

* use pure Python for all the glue logic (enumerating segments, walking imports, updating comments)
* call into a small Cython module like `fnv1a_hash` for tight inner loops

This is the same pattern used in ida-sigmaker: you cross the Python/C boundary once, do a lot of work in Cython (or C++), and then return a simple result to IDA.

## Low hanging fruit: compiling existing Python code

When I first went back to Cython I did not start by sprinkling `cdef` everywhere. I wanted a quick win.

The experiment was simple:

 1. Take the existing pure Python code.
 2. Paste it into a `.pyx` file.
 3. Compile it without adding any `cdef` functions or C types.

The result is a binary extension that still uses the Python C API for every operation, but avoids some overhead because calls inside the compiled module become direct C calls instead of going through the normal Python dispatch machinery.

This technique will not magically optimize everything. Dictionary lookups, for example, still use Python's `dict` implementation. But for tight loops over simple data types it often yields a 2x or 3x improvement, which is more than enough to see if it is worth investing in deeper type annotations.

Once you have that first bump, you can use a profiler to identify hotspots and then selectively:

* add `cdef` declarations for local variables
* convert hot functions to `cdef` or `cpdef`
* move heavy string and bytes processing into C loops
* call out to C or C++ helper functions from Cython

The pattern that works best for high performance IDA plugins is:

* gather inputs at the Python or `IDAPython` level
* cross the Python/C boundary exactly once
* run the heavy algorithm entirely in Cython (calling C or C++ as needed)
* return a simple result back to Python

The ida-sigmaker speedups and the FNV-1a example both follow this pattern.

Here is a minimal example of building a Cython extension with setuptools:

```python
from setuptools import Extension, setup
from Cython.Build import cythonize

setup(
    name="sigmaker_speedups",
    ext_modules=cythonize(
        [
            Extension(
                "sigmaker._speedups.simd_scan",
                ["src/sigmaker/_speedups/simd_scan.pyx"],
                language="c++",
                include_dirs=["src/include"],
            )
        ]
    ),
)
```

This is not the full `setup.py` used by ida-sigmaker, but it shows the core pieces: point `cythonize` at your `.pyx` file, declare that it should be compiled as C++, and pass include directories if you are calling into C or C++ headers.

## Appendix: essential Cython concepts

If you have never used Cython before, the terminology can be confusing. This is a very short crash course, focused on the parts that matter for IDA plugins.

### Files and modules

Cython code is usually split into:

* interface files: `*.pxd`
* implementation or wrapper files: `*.pyx`
* optional pure Python modules: `*.py`

A `.pxd` file declares the C functions, types, and structs you want to expose to Cython. It is roughly the Cython equivalent of a C header file. A `.pyx` file contains the Python visible logic and uses `cimport` to pull in declarations from `.pxd` files.

After compilation you get:

* `.so` files on Linux and macOS
* `.pyd` files on Windows

These behave like normal extension modules from the point of view of Python and `IDAPython`: you import them, and Python loads the shared object.

One important convention: the wrapper `.pyx` file should not have the same name as its corresponding `.pxd` "interface" file. Otherwise the function signatures in the wrapper can override the declarations from the `.pxd` file in ways that are confusing.

### Compiler directives and setup

Cython's behavior is controlled by compiler directives. You can specify them inline as comments at the top of a `.pyx` file, or you can pass them from `setup.py` via `cythonize`.

A minimal example using setup.py looks like this:

```python
from setuptools import Extension, setup
from Cython.Build import cythonize

setup(
    name="obj",
    ext_modules=cythonize(
        [
            Extension(
                "queue",
                ["queue.pyx"],
                language="c++",
            )
        ]
    ),
)
```

And here is a toy interface and wrapper pair:

```python
# cqueue.pxd
cdef extern from "queue.h":
    ctypedef struct Queue:
        pass
    Queue* queue_new()
```

```python
# queue.pyx
# distutils: sources = path/to/source/queue.c
# distutils: include_dirs = path/to/source/

cimport cqueue

cdef func(int a):
    # your Cython accelerated logic here
    pass

cdef class Temp:
    def __cinit__(self):
        pass

    def __dealloc__(self):
        pass
```

To compile manually, you can:

 1. run `cython queue.pyx` to produce `queue.c` or `queue.cpp`
 2. compile that C or C++ file with your platform compiler
 3. link it into a shared object that Python can import

In practice, you will usually let setuptools or cibuildwheel handle these steps when you run `python setup.py build_ext -inplace` or similar commands in CI.

The important takeaway is that you do not need to Cythonize your entire plugin at once. You can start with one small `.pyx` file, build and import it, and then gradually move hot code paths over as you profile.

## What is next? (stay tuned for part 2)

This post focused on why Cython is a good fit for IDA Pro plugins and walked through a concrete example in ida-sigmaker, plus a smaller FNV-1a example that you can benchmark yourself.

In part 2, I will switch from theory to practice and build a minimal Cython accelerated IDA plugin from scratch:

* creating the folder layout
* writing the smallest useful `.pyx` file
* compiling it into a `.pyd` or `.so`
* loading it inside IDA
* comparing pure Python vs compiled performance
* adding the first `cdef` based optimization

If you have ever wanted to ship a faster IDA plugin without touching the IDA SDK directly, part 2 is for you.
