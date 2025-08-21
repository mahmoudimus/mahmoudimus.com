---
Title: Using nasm to compile a minimal runnable example on MacOS / Darwin
Date: 2025-08-20
Category: Python
Tags: til, reverse-engineering, nasm, assembly
Classification: til
Author: Mahmoud
Excerpt: Using nasm to compile a minimal runnable example on MacOS / Darwin
---
Assuming you're using homebrew, `brew install nasm`

Then, use the following `hello_world.asm` as a simple example:

```nasm
; ----------------------------------------------------------------------------------------
; This is an macOS console program that writes "Hello, World" on one line and then exits.
; It uses puts from the C library.  
;
; To assemble:
;
;     nasm -fmacho64 helloworld.asm
;     clang -arch x86_64 helloworld.o -o helloworld
;
; To run:
;
;     ./helloworld
;
; ----------------------------------------------------------------------------------------

          global    _main
          extern    _puts

          section   .text
_main:    push      rbx                     ; Call stack must be aligned
          lea       rdi, [rel message]      ; First argument is address of message
          call_puts                   ; puts(message)
          pop       rbx                     ; Fix up stack before returning
          ret                          ; invoke operating system to exit

          section   .data
message:  db        "Hello, World", 10      ; note the newline at the end
```

And you're done!

## Warning

When running, you'll get a warning:

> `ld: warning: no platform load command ..., assuming: macOS`

You can safely ignore this, but if you really want to make it go away, you can use `-Wl,-ld_classic` like so: `clang -arch x86_64 helloworld.o -o helloworld -Wl,-ld_classic`. You might get another warning as `-ld_classic` is using an older linker that is soon to be deprecated by Apple, so really, I haven't figured out a way to use `nasm` and link it without a warning on MacOS.
