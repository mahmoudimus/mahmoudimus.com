---
Title: Running a split APK on Android Emulator
Date: 2026-06-30
Category: debugging
Tags: til, android, adb, unity, il2cpp, app-bundle, reverse-engineering
Classification: til
Author: Mahmoud
Excerpt: A Unity game died instantly on the emulator with Android's generic crash dialog. The real cause was an App Bundle installed from base.apk alone, so the native libraries were never there.
---

Today I learned that Android's generic "This App Keeps Closing" dialog can mean something very specific: you installed an *App Bundle* from `base.apk` alone, and the config splits — including the one carrying the native libraries — never made it onto the device.

This came up while bringing an old Unity Android game back to life on an emulator. The app installed without complaint, then closed itself the instant it launched. The dialog tells you nothing. The interesting part is everything it hides.

## Step 1: get the real error

The dialog is a dead end. The actual exception is sitting in `logcat`. Clear the buffer, launch the activity, dump the log:

```sh
adb -s emulator-5554 logcat -c
adb -s emulator-5554 shell am start -W -n com.example.game/com.unity3d.player.UnityPlayerActivity
adb -s emulator-5554 logcat -d | grep -E "FATAL|UnsatisfiedLink|AndroidRuntime"
```

And there it was:

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.UnsatisfiedLinkError: No implementation found for void
    com.unity3d.player.UnityPlayer.nativeRestartActivityIndicator()
    (tried Java_com_unity3d_player_UnityPlayer_nativeRestartActivityIndicator and ...)
    - is the library loaded, e.g. System.loadLibrary?
    at com.unity3d.player.UnityPlayer.nativeRestartActivityIndicator(Native Method)
    at com.unity3d.player.UnityPlayer.resume(Unknown Source:37)
    at com.unity3d.player.UnityPlayerActivity.onResume(Unknown Source:5)
```

`UnsatisfiedLinkError` with "is the library loaded?" means the Java side called into native code that isn't there. For a Unity app, the entire engine is native (`libunity.so`, `libmain.so`, `libil2cpp.so`). If those `.so` files are missing, the app starts, reaches `onResume`, calls into Unity, and dies.

## Step 2: the tell

So where were the native libraries? Ask the package manager what it actually installed:

```sh
adb -s emulator-5554 shell pm path com.example.game
```

```text
package:/data/app/~~.../com.example.game-.../base.apk
```

One line. Only `base.apk`. That is the whole bug.

Modern Android apps ship as an **App Bundle**, not a single monolithic APK. The store splits one app into several APKs:

- `base.apk` — Java/Dex, manifest, shared resources
- `config.arm64_v8a.apk` — the native `.so` libraries for that ABI
- `config.xhdpi.apk` — density-specific resources
- `config.en.apk` — language resources

The native libraries don't live in `base.apk`. They live in the ABI split. Installing `adb install base.apk` by hand gets you a base with no engine — exactly the crash above. You can confirm what's where without a device:

```sh
unzip -l config.arm64_v8a.apk | grep '\.so$'
```

```text
lib/arm64-v8a/libil2cpp.so
lib/arm64-v8a/liblz4.so
lib/arm64-v8a/libmain.so
lib/arm64-v8a/libunity.so
```

All of it is in the split that never got installed.

### Not an ABI mismatch

The obvious first guess for "old APK crashes on emulator" is an ABI mismatch: an ARM-only app on an x86 image. Worth ruling out, and it was wrong here. The emulator reported:

```sh
adb -s emulator-5554 shell getprop ro.product.cpu.abi
# arm64-v8a
```

An `arm64-v8a` emulator (the default on Apple Silicon) runs the `arm64-v8a` libraries natively. The architecture matched fine. The libraries simply weren't installed.

## The fix

Install the base and its splits together with `install-multiple`, so they land as one app:

```sh
adb -s emulator-5554 install-multiple -r \
  base.apk \
  config.arm64_v8a.apk \
  config.xhdpi.apk \
  config.en.apk
```

Then verify the splits are present — four entries now, not one:

```sh
adb -s emulator-5554 shell pm path com.example.game
```

```text
package:/data/app/~~.../base.apk
package:/data/app/~~.../split_config.arm64_v8a.apk
package:/data/app/~~.../split_config.en.apk
package:/data/app/~~.../split_config.xhdpi.apk
```

Launch it, then check the process is still alive a moment later and that nothing fatal landed:

```sh
adb -s emulator-5554 shell am start -n com.example.game/com.unity3d.player.UnityPlayerActivity
adb -s emulator-5554 shell pidof com.example.game           # prints a PID = still running
adb -s emulator-5554 logcat -d | grep -E "FATAL|UnsatisfiedLink"   # silence = good
```

The process stayed up, `logcat` showed `ActivityTaskManager: Displayed ... UnityPlayerActivity`, and the "keeps closing" dialog was gone.

## A gotcha along the way

Two emulators were attached, and one was `offline`:

```text
emulator-5554   device   ...
emulator-5566   offline  ...
```

With more than one device, a bare `adb shell getprop ...` fails with `adb: more than one device/emulator` (or quietly talks to the wrong one). Every command above is pinned with `-s emulator-5554` for that reason. When `adb` acts strangely, run `adb devices -l` first and target explicitly.

One more shell trap: in `zsh`, an unquoted variable does **not** word-split, so stashing `D="-s emulator-5554"` and writing `adb $D shell` sends `adb` one argument `"-s emulator-5554"` instead of two — and you get `adb: -s requires an argument`. Either quote-split deliberately or just write the flag out each time.

## The takeaway

When an Android app shows "This App Keeps Closing" on an emulator and you suspect the install:

1. **Read `logcat`, not the dialog.** `adb logcat -c`, launch, `logcat -d | grep FATAL`. The generic dialog is never the real error.
2. **`UnsatisfiedLinkError` on a Unity (or any native) app points at the libraries**, not your code.
3. **`pm path <pkg>` showing only `base.apk` means you dropped the splits.** Reinstall the bundle with `adb install-multiple`, native ABI split included.

The native libraries were never broken. They were never installed.
