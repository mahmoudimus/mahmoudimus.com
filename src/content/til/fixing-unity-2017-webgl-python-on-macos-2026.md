---
Title: Patching a compiled Unity DLL with Mono.Cecil
Date: 2026-06-27
Category: debugging
Tags: til, unity, webgl, il2cpp, emscripten, macos, reverse-engineering
Classification: til
Author: Mahmoud
Excerpt: Mono.Cecil can surgically patch an existing compiled .NET DLL, which is exactly what an old Unity 2017 WebGL build needed.
---

Today I learned that Mono.Cecil can patch an existing compiled .NET DLL directly. Not source code. Not a project rebuild. The already-installed DLL on disk.

That was the useful unlock: once I found the bad constant inside Unity's IL2CPP build helper, I could patch the compiled assembly itself and make an old Unity 2017.4.17f1 WebGL build work on modern macOS in 2026.

This came up while restoring a game from 2020 and testing whether the old Android/Unity project could be pushed back through a Unity WebGL build path. The original project source was not available in the normal clean form, so the practical question was whether recovered Unity assets and a skeleton project could produce a browser build at all.

The spike was simple: use Unity-exported assets and skeleton project structure where possible, then see whether the old Unity editor could emit a browser build. The editor was installed at:

```text
/Applications/Unity/Hub/Editor/2017.4.17f1/Unity.app
```

## The blocker

The failure was not a missing gameplay script or broken recovered asset. It was older and dumber:

```text
Executable: /usr/bin/python
```

Modern macOS in 2026 does not provide `/usr/bin/python`. Unity 2017.4.17f1's WebGL/IL2CPP Emscripten path still assumes that it does.

Python 2.7 was available on the machine here:

```text
/Library/Frameworks/Python.framework/Versions/2.7/bin/python
```

But that did not matter, because the macOS code path was hardcoded to the absolute path Apple removed.

The decompiled shape was effectively:

```csharp
public static NPath Python
{
    get
    {
        if (PlatformUtils.IsOSX())
        {
            return new NPath("/usr/bin/python");
        }

        return new NPath("python");
    }
}
```

The non-macOS branch already used `python` from `PATH`. macOS was the special case, and the special case was now wrong.

## The interesting part: patching the DLL

The fix was not to reinstall Unity, rebuild Unity, or try to recreate its IL2CPP build tooling. The fix was to patch Unity's IL2CPP build helper DLL so the macOS branch returns `python` too.

There are two copies of the DLL in this Unity install, and both mattered:

```text
/Applications/Unity/Hub/Editor/2017.4.17f1/Unity.app/Contents/il2cpp/build/Unity.IL2CPP.Building.dll
/Applications/Unity/Hub/Editor/2017.4.17f1/Unity.app/Contents/il2cpp/build/il2cppcore/Unity.IL2CPP.Building.dll
```

I used Mono.Cecil to patch `Unity.IL2CPP.Building.dll`, replacing the `"/usr/bin/python"` string literal with `"python"` in both copies.

That is the part I want to remember. A compiled .NET assembly is still structured metadata and IL. With Mono.Cecil, you can load it, inspect types and methods, find the instruction or string operand you care about, change it, and write the assembly back out. For this case, the behavioral change was tiny, but it lived inside a vendor DLL:

```text
"/usr/bin/python"
```

became:

```text
"python"
```

After patching both DLLs, launch Unity from a shell where Python 2.7 is first:

```sh
export PATH="/Library/Frameworks/Python.framework/Versions/2.7/bin:$PATH"
/Applications/Unity/Hub/Editor/2017.4.17f1/Unity.app/Contents/MacOS/Unity
```

That makes the old Emscripten invocation resolve `python` to the Python 2.7 interpreter Unity 2017 expects, without depending on `/usr/bin/python`.

## Validation

The skeleton Unity 2017 WebGL build succeeded.

The output directory contained the generated WebGL build artifacts.

The log changed from an absolute missing executable:

```text
Executable: /usr/bin/python
```

to a `PATH`-resolved executable:

```text
Filename: python
```

And the build summary was clean:

```text
Result: Succeeded
Errors: 0
```

This does not prove a whole game or app has been recovered. It proves a narrower and useful thing: the Unity 2017 WebGL toolchain can be made to run on this macOS 2026 machine, and a recovered skeleton project can emit a WebGL build.

## Rollback

Do not patch Unity's installed DLLs casually. Keep backups before changing them, and restore the original files if the editor or IL2CPP starts behaving strangely.

The important lesson is not "edit random Unity binaries until it works." It is narrower: when old Unity WebGL fails on modern macOS, check whether IL2CPP is still hardcoding `/usr/bin/python`. If it is, making that lookup respect `PATH` can be enough to bring the old build pipeline back to life.
