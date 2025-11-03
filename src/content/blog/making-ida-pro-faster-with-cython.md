+++
Title: IDA Pro and Cython: super‑charging the work‑horse of reverse engineering
Date: 2025-08-01
Author: Mahmoud
Status: draft
Tags: reverse engineering, cython, ida pro
Classification: blog
Excerpt: Cython and IDA Python for super fast reversing tools
+++

Python is an incredibly powerful language – a work‑horse that powers AI research, backend servers and, crucially for security researchers, the scripting interfaces of the big three disassemblers: IDA Pro, Ghidra and Binary Ninja.  Because it is easy to read and write, Python has become the de facto lingua franca of malware analysis and reverse engineering.  Yet it has an Achilles’ heel: speed.  Tight loops that crawl through binary blobs or apply heuristic checks can grind to a halt when written in pure Python.  The internet is littered with “make Python faster” articles; you can embed C, use pybind11 or Numba, or offload work to asynchronous frameworks.  In this post, I want to talk about the route I took: Cython.

## When REPL‑driven productivity meets performance

IDA Pro’s strength lies in its interactivity – the I stands for interactive – and Python scripts are often written directly in the IDA Python console.  This REPL‑driven workflow lowers the barrier to experimentation and collaboration: anyone can clone a repository, drop a .py file into their plugins folder and start hacking.  But the price of comfort is performance.  When you build complicated algorithms for deobfuscation or call heavy solvers like Z3, speed matters, and Python’s function call overhead can become a bottleneck.  Rewriting everything in C or C++ is rarely an option because the IDA SDK changes between versions and compiling cross‑platform plugins is time‑consuming.  Many C plugins go stale; Python plugins are forked and updated much faster.  The community thrives on low friction.

## Enter Cython

Cython is a language that allows you to write Python‑like code that is compiled to C.  The official documentation describes it as an optimising static compiler that makes writing C extensions for Python “as easy as Python itself” ￼.  Any valid Python code is valid Cython, and you can gradually add type declarations to tune performance.  Cython lets you call C or C++ functions natively ￼ and declare C types on variables and class attributes so the compiler can generate efficient C code ￼.  For reverse engineering, this means we can maintain the flexibility of Python while escaping its interpreter for speed‑critical loops.  Other projects like mypyc and Numba occupy similar niches, but Cython shines when you need to interoperate with C++ libraries – exactly the case when working with IDA’s C++‑based SDK.

## Why Cython for IDA Pro?

The premise is simple: adorn your Python with the right types and Cython will make your code faster.  Because Cython compiles down to portable C, it works across macOS, Linux and Windows and across CPython versions ￼.  A Cython plugin can still be installed by dropping a single .py file into IDA’s plugins folder; the compiled speed‑ups are optional extras.  Contributors can work in Python for the high‑level logic and only touch Cython for the performance‑critical kernels.  This lowers the barrier to entry relative to pure C/C++ while preserving cross‑platform compatibility.  As the README for my plugin notes, the goal is to “work with future versions of IDA without needing to compile against the IDA SDK” and to “allow for easier community contributions” ￼.

## A case study: `ida-sigmaker`

`ida-sigmaker` is a cross‑platform plugin that generates unique binary signatures for functions and addresses.  Version 1.4.0 was written entirely in Python: you copied sigmaker.py into your plugins directory and used Ctrl + Alt + S to create signatures.  This kept installation friction low, but scanning through a large binary to find wildcard patterns or nibble masks was sluggish.

For version 1.6.0 I added optional SIMD speed‑ups using Cython.  The README now describes sigmaker as a “zero‑dependency cross‑platform signature maker plugin with optional SIMD (e.g. AVX2/NEON/SSE2) speedups” ￼.  If you pip install sigmaker, the setup process will build or download the appropriate wheel for your system, and the plugin will automatically use the compiled speed‑ups ￼.  It even displays an icon in the menu bar indicating whether SIMD is enabled ￼.

### setup.py

To make this possible I wrote a custom setup.py that detects the host platform and architecture using Python’s platform module and maps them to library names and file extensions ￼.  The script returns platform‑specific compile and link flags – MSVC flags on Windows and warning suppressions on Linux ￼, with a special branch for macOS that sets a minimum OS version and adjusts optimisation levels ￼.  It then calls cythonize with directives like language_level='3', binding=True and embedsignature=True while disabling bounds checking and wraparound indexing ￼.  Finally, it compiles the sigmaker._speedups.simd_scan module, passing the compile and link arguments ￼.

Within `src/sigmaker/_speedups/simd_scan.pyx` the core algorithm looks deceptively like Python.  The file cimports C types (size_t, uint8_t) and declares external functions from a header that provide AVX2 and NEON primitives ￼.  It defines a Signature class whose constructor parses hex and wildcard strings into bytes and builds nibble masks using C loops ￼.  Because the function crosses the Python/C boundary only once and then runs entirely in C, the ~330 ms of Python loop overhead evaporates.  For developers reading the code, there is still a familiar class and method structure; you only need to learn a handful of cdef and cimport keywords.

### CI harness and wheel generation

Adding Cython meant expanding the continuous‑integration pipeline.  Our test workflow still spins up an IDA container and runs unit tests with coverage ￼.  The difference is the deploy.yml workflow in v1.6.0.  It uses the pypa/cibuildwheel action to build wheels for Linux (x86‑64), Windows (x86‑64) and both Intel and Apple‑Silicon macOS runners ￼.  The CIBW_BUILD environment variable specifies support for CPython 3.10–3.13 ￼.  After building wheels, the workflow builds a source distribution, checks it with Twine and uploads both wheels and sdist to PyPI if the release passes tests ￼.  In earlier releases the wheel‑build matrix was commented out ￼, leaving only an sdist; turning on wheel generation ensures users on all platforms get pre‑built binaries.

### Publishing and versioning

A separate release.yml triggers when a tag starting with v is pushed.  It verifies that tests succeeded, extracts the version, and generates a standalone sigmaker.py for users who want the pure‑Python version ￼.  It then uses softprops/action-gh-release to create a GitHub release with a friendly Markdown body ￼.  The deploy workflow subsequently publishes the wheels to PyPI.  The pyproject.toml lists Cython as both a build requirement and an optional dependency named speedups ￼, and it includes .pyx, .pxd, .c and .cpp files in the package so that source distributions can be rebuilt by distribution packagers ￼.  This careful packaging means Linux distros can rebuild the speed‑ups without requiring users to install Cython.

## Direct experience with Cython: low‑hanging fruit

When I first started experimenting with Cython, I wanted a quick win.  I took my existing Python code, pasted it into a .pyx file and compiled it without adding any cdef functions.  The result was a binary module that still used the Python C API for every call but eliminated some overhead because Python calls within the module become direct C calls.  This technique won’t magically optimise dictionary lookups (those still use Python’s dictionary implementation), but for tight loops it often gives a 2×–3× improvement.  It is an easy way to get a dopamine hit before investing in deeper type annotations.  Once you identify hotspots with a profiler, you can selectively add cdef declarations and call C++ functions directly.  The pattern for high‑performance IDA plugins is to cross the Python/C++ boundary exactly once: gather inputs in Python, run your heavy algorithm in Cython (calling out to C++), then return a simple result.

Here’s a minimal example of how to build a Cython extension with setuptools:

.. """XZCython

.. Cython:
..   -> interface: *.pxd           # not allows pure python `def`s
..   -> wrapper, *.pyx  &  *.py    # same name `interface` will be automatically searched
.. After compiled:
..   -> linux: *.so
..   -> windows: *.pyd
.. Note:
..     `wrapper` should be different name with `interface`,
..     otherwise, signatures inside wrapper will be used instead

.. Compiler directives:
..     https://cython.readthedocs.io/en/latest/src/userguide/source_files_and_compilation.html#compiler-directives

.. Some important directives:
..     # distutils: language = C++
..     # distutils: libraries = lib1  lib2
..     # distutils: include_dirs = dir1  dir2
..     # distutils: sources = s.c  s.cpp
..     # cython: language_level = 3        # python version, no need
..     #link: https://cython.readthedocs.io/en/latest/src/userguide/source_files_and_compilation.html

.. Decorators:
..     @cython.exceptval(check=True)
..     @cython.cfunc       # create `cdef` function
..     @cython.cclass      # create `cdef class`
..     @cython.ccall       # create `cpdef` function
..     @cython.locals      # local variables
..     @cython.inline      # equivalent with C inline
..     @cython.returns
..     @cython.profile
..     @cython.declare

.. Keywords:
..     `cdef`      : used for internal C functions
..     `cpdef`     : visible to Python

..     cdef class cls
..     cdef [public|inline] [int|str|bint] var
..     cdef [struct|union|enum] block

..     DEF key value       # work like macros in compiling time


.. Compile Process:
..     1) generate C/C++ source codes:
..         cython source.pyx   # new file: `source.c` or `source.cpp`
    
..     2) compile:
..         gcc -pthread -B /home/xiang/Applications/miniconda3/compiler_compat \
..             -Wsign-compare -g -fwrapv -O3 -Wall -fPIC       \
..             -I/home/xiang/Applications/miniconda3/include/python3.8 \
..             -I/all/my/includes \
..             -c source.cpp       -o source.o
..         g++ -pthread -B /home/xiang/Applications/miniconda3/compiler_compat -shared \
..             -L/home/xiang/Applications/miniconda3/lib       \
..             -Wl,-rpath=/home/xiang/Applications/miniconda3/lib      \
..             -I/all/my/includes \
..             allmyobjs.o         -o final.so
.. """


.. from setuptools import Extension, setup
.. from Cython.Build import cythonize

.. setup(
..     name='obj',
..     ext_modules = cythonize([Extension("queue", ["queue.pyx"])])
.. )


.. """Files

.. # interface file: cqueue.pxd
.. # (selectively copy-and-paste of header file)
.. cdef extern from "queue.h":
..     ctypedef struct Queue:
..         pass
..     Queue* queue_new()


.. # wrapper file: queue.pyx
.. # (following compiler directives should be defined)
.. # distutils: sources = path/to/source/queue.c
.. # distutils: include_dirs = path/to/source/
.. cimport cqueue
.. cdef func(int a):
..     pass
.. cdef class Temp:
..     def __cinit__(self):
..         pass
..     def __dealloc__(self):
..         pass
.. """


It's been roughly two years since Cython released version 3.0.0, and it's been a while since I've dabbled with it. I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster. I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster.
	
I've been using IDA Pro for a while now, and I've noticed that it's not the fastest. I've also noticed that the internet is littered with articles about how to make IDA Pro faster.




Direct experience with Cython:

> I get that if I adorn my python3 with types the right way, cython can uplift C betterer, but if I don't adorn my python3 and only use core imports (no pip) do I get any benefit?
I have some humongous (for me) dict lookups I am doing on strings, counting in ints, and if I could 2x or 3x faster without having to recode I'd love it. The Cython web is directed at people willing to recode, I am ultimately willing but I wish there was some low hanging fruit evidence: is this even plausibly going to get faster or is dict() walk cost just "it is what it is" ?

> Oddly, it looks like across pickle dump/load I get some improvement. Does pickle restoring consume less memory than raw-made?


> You will ~likely get some improvement by directly putting your python code in a .pyx file and compiling it (without using any cdef functions). In most cases it will be as if you were calling the Python C API directly in a compiled C file. In my experience, the biggest difference will be a reduction in the function call overhead so it is better for tight loops.



