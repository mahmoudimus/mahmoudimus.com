---
Title: Debugging Hidden Whitespace in Makefiles with `od -c`
Date: 2025-08-21
category: debugging
tags: makefile, debugging, od, whitespace, bash, linux
classification: til
author: Mahmoud
excerpt: A (single) stray trailing space in a Makefile can cause hours of debugging...
---

Today I learned how `od -c` can save you hours when tracking down a deceptively simple whitespace issue in a Makefile. The culprit? A hidden trailing space that was invisible in my text editor but wreaking havoc on variable assignments. That one invisible trailing space...

## The Problem

I was working on a Makefile with a volume name variable that looked correct:

```makefile
VOL := $(shell basename "$(PWD)" | tr -d '[:space:]')_usr # space-stripped volume name
```

But when I ran `make snapshot-usr`, I saw:

```bash
>> Creating snapshot .usr_snapshot.tar.gz from volume 'sig_usr '
```

Notice the trailing space after `sig_usr`? That space shouldn't be there, and it was causing issues downstream.

## The Debugging Journey

### Step 1: Verify the Shell Command Works

First, I tested the shell command directly:

```bash
$ basename "$PWD" | tr -d '\n' | od -c
s   i   g
```

The command correctly produced `sig` with no trailing whitespace. So the issue wasn't with the shell logic.

### Step 2: Check the Full Command

```bash
$ echo "$(basename "$PWD" | tr -d '\n')_usr" | od -c
s   i   g   _   u   s   r  \n
```

This also looked correct - just `sig_usr` followed by a newline from echo. The trailing space had to be coming from somewhere else.

### Step 3: The `make -n` Revelation

Using `make -n` to see what commands would actually run:

```bash
$ make -n snapshot-usr | grep "echo.*volume"
echo ">> Creating snapshot .usr_snapshot.tar.gz from volume 'sig_usr '"
```

There it was! The trailing space was definitely in the VOL variable. But where?

### Step 4: The `od -c` Breakthrough

The key insight came from using `od -c` (octal dump with character format) on the Makefile itself:

```bash
$ sed -n '6p' Makefile | od -c
0000000    V   O   L                           ?   =       $   (   s   h
0000020    e   l   l       b   a   s   e   n   a   m   e       "   $   $
0000040    P   W   D   "       |       t   r       -   d       '   \   n
0000060    '   )   _   u   s   r       #       s   p   a   c    e   -   s
0000100    t   r   i   p   p   e   d       v   o   l   u   m    e       n
0000120    a   m   e  \n
```

Look closely at the output around `_usr`. Can you see it?

```bash
_   u   s   r       #
```

There's a space character between `r` and `#`... that trailing space was being included in the VOL variable definition.

## The Fix

Simple fix, just remove the trailing space:

```makefile
# Before (with trailing space)
VOL ?= $(shell basename "$$PWD" | tr -d '\n')_usr # comment

# After (space removed)
VOL ?= $(shell basename "$$PWD" | tr -d '\n')_usr
```

## `od`

Unlike the `xxd` or `hexdump` commands, the `od` command is included in the [POSIX](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/od.html) specification, so you'll find it installed in many systems without relying on third-party package managers.

The next time you see unexpected behavior in a Makefile, remember: sometimes the bug is hiding in plain sight, invisible to the naked eye! 🔍 And knowing that sweet sweet command-line fu can save you HOURS of debugging.
