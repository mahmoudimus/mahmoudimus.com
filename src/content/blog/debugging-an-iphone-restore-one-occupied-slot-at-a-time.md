+++
Title: Debugging a stuck iPhone restore
Slug: debugging-an-iphone-restore-one-occupied-slot-at-a-time
Date: 2026-10-28
Status: published
Author: Mahmoud
Tags: ios, debugging, python, macos, systems, codex
Classification: blog
Excerpt: Hundreds of restored apps were waiting, while new App Store downloads worked. Following the installation logs revealed occupied scheduler slots and a restore operation that survived its app's deletion. Then the log reader ate 42 GB of memory, and the migration acquired an upstream C patch.
+++

I spent much of October 21 debugging an iPhone migration. The useful discovery was that an app's restore operation could survive the deletion of its visible placeholder. You could have no app to open or delete in Settings, yet still have an operation preventing its download.

The more consequential discovery was that cancelling one selected restore could get other apps installing again. After one such intervention, ten apps installed in roughly 100 seconds.

I worked through this with Codex, using device logs and a Python monitor we built during the investigation. The monitor helped recover the queue. Then its native log reader consumed 42 GB of memory. Apparently the new-phone setup experience included a complimentary C memory-management workshop.

## What was actually stuck?

I'd restored an encrypted Finder backup onto a new 1 TB iPhone running iOS 27.0.1. The backup was roughly a terabyte and lived on an external NVMe drive. Finder finished. My Home Screen layout returned, substantial local data was present, and some apps installed.

Hundreds of others remained at Waiting or Loading.

Restarting and force-restarting didn't resolve it. Prioritize Download appeared to do nothing. The phone had roughly half a terabyte available. A new app downloaded normally from the App Store.

That last test narrowed the question. The phone could obtain an app and install it. Something in the restoration path was failing.

I had already done a recovery-mode **Update** through Finder, after which downloads visibly resumed. It helped, but more apps remained stuck. I kept the original encrypted backup. Apple's [recovery instructions](https://support.apple.com/en-us/118106) distinguish trying Update from choosing Restore, which erases the device.

For the next investigation, I queried the app inventory with placeholders included:

```sh
pymobiledevice3 apps list --show-placeholders --udid "$IPHONE_UDID"
```

`IPHONE_UDID` means the explicitly selected target device. Two phones were connected to the Mac.

The first inventory had 1,991 records: 608 non-placeholders, including system apps, 1,045 ordinary placeholders, and 338 demoted placeholders. Those categories mattered. A placeholder is a state to investigate, not sufficient evidence of a broken installation.

## Discord's missing app and surviving operation

I used Console.app, `libimobiledevice`, and a local `pymobiledevice3` checkout to inspect the phone. The relevant services included `appstored`, AirTraffic (`atc`), `installcoordinationd`, and `installd`.

Trying to download Discord produced:

```text
Found existing restore with App Store responsible: false
Prioritizing active restore coordinator which App Store is not responsible
```

Fields extracted from the associated coordinator record were:

```text
intent:IXCoordinatorIntentRestoring
creator/appDRI:AirTraffic
state:IXAppCoordinationStatePlaceholderPromiseNotSet
```

AirTraffic then reported that the asset was not enqueued and could not be prioritized.

The App Store was finding an existing restore operation and delegating the download request to it. That operation wasn't advancing.

I'd already deleted Discord's placeholder. It was absent from Settings and from the placeholder-inclusive inventory. Deleting the visible app hadn't removed all the state associated with restoring it.

We eventually sent an uninstall request through the normal mobile installation service:

```sh
# This is a real uninstall request and can delete local app data.
pymobiledevice3 apps uninstall com.hammerandchisel.discord --udid "$IPHONE_UDID"
```

The device logs showed the restore coordinator being cancelled and unregistered. AirTraffic cancelled its asset sync. `installd` reported:

```text
No bundle container found for identifier com.hammerandchisel.discord
```

It fell back to unregistering the existing record, and the service returned success. There was useful cleanup for an uninstall to perform even though no app bundle existed.

I tried downloading Discord again. It worked. A subsequent query returned installed version 350.0, build 115636.

This used an existing trusted USB connection. There was no jailbreak or manual deletion of files on the phone.

## Finding the queue

The broader restore problem became clearer in the scheduler logs:

```text
Slots used: 3 max slots: 3 active installations: [com.amadeus.sqmobile, com.pranapps.Moodly, com.505games.terraria]
Polling completed, started 0 installations
```

The occupants were SingaporeAir, MoodWell, and Terraria. Repeated polls showed the same apps consuming the reported capacity while no new installations started.

I tried pausing SingaporeAir. The logs acknowledged the pause, but subsequent polls still counted the same three slots. Pausing its work hadn't released its slot.

I was willing to lose this app's local data, so I selected Cancel Download. The phone removed it. The logs showed its app and data containers being destroyed at 12:43:40, followed by placeholder cleanup.

At 12:43:42, the scheduler reported 2/3 slots and started Fan Noise Gen. Other apps followed automatically.

This was much more informative than another restart. We had changed one restore operation and immediately observed new work starting through the released capacity.

SingaporeAir later downloaded normally from the App Store. That didn't recover the local data we'd deleted. Apple's [storage documentation](https://support.apple.com/en-us/108429) explains the distinction between offloading an app, which retains its documents and data, and deleting it. For this experiment, the device logs confirmed deletion.

Three slots was the capacity reported in this session. I wouldn't assume it's a universal iOS limit. Later observations also showed active transfers that weren't represented in the latest counted slot snapshot.

## An error message needs a counterexample

There was a tempting shortcut in the Discord logs: treat `not enqueued and cannot be prioritized` as a signature of a stalled restore.

Thunderspace disproved that. It logged the same message, then completed about five seconds later.

The message described a failed prioritization request at a particular time. To diagnose a persistent problem, we needed observations over time and evidence about what the app did next.

This distinction would matter again once the monitor was allowed to uninstall things.

## Building a monitor

Tapping individual apps was useful for experiments. With roughly two thousand app records, it wasn't a practical recovery procedure.

The Python monitor polls the placeholder-inclusive inventory, sleeps for 30 seconds between polls, and reads live logs in a background process. It also collects bounded persisted log archives when live scheduler messages are quiet.

The archive fallback fixed an early observability bug. The first version kept reporting unknown slot counts because the last useful scheduler message had happened before it started listening. Reading history recovered that message. We retained its original timestamp: an archive fetched at 14:00 could contain a slot snapshot from 13:58, but couldn't turn it into a new observation.

Before sending an uninstall, the tool appends a durable record to a JSONL ledger. It appends the result separately, including an uncertain outcome if the request times out. The record includes the bundle ID, app name, and an App Store link when an exact store ID is available. An offline `reinstall-list` command lets me find the removed apps afterward.

That ledger is a record of deletion, not a backup of the deleted data.

Automatic removal is opt-in. It excludes normally installed apps, system apps, and demoted placeholders. It attempts one app at a time, checks the evidence again immediately before acting, and stops after an uncertain outcome. The default limit is three attempts per run.

At 14:49:58 it uninstalled Terraria. The inventories around that intervention were:

| Time, PDT | Installed records | Observation |
| --- | ---: | --- |
| 14:49:58 | 704 | Inventory captured before the uninstall |
| 14:51:05 | 711 | Seven apps installed; one record removed |
| 14:51:38 | 714 | Three more apps installed |

Miyako Color was then downloading at a reported 40.87 MB/s. The result strongly supported the occupied-slot diagnosis, without explaining why Terraria's restore had stopped advancing in the first place.

## The policy bugs

The first automatic policy waited for the whole queue to stop making progress. Any successful installation reset its timer.

That missed partial failure. MoodWell and Merrill Edge could remain idle while the available capacity installed other apps indefinitely. The queue was moving, but some of its occupants weren't.

We changed to a per-app inactivity timer. Progress by one app would protect that app; an unrelated completion wouldn't reset its neighbor's timer. The interval was configurable with `--stall-seconds`, defaulting to 150 seconds.

Then I ran it with 90 seconds and got:

```text
Auto-uninstall: blocked; stall threshold 90.0s; attempts 0/3;
scheduler queue is not known full.
```

We'd left the full-queue requirement in place. At 2/3 occupancy it prevented action and reset the timers. The per-app change hadn't fully implemented the behavior I wanted.

Removing that requirement let a retained occupant keep its own timer as other slots filled or emptied. Counts still had to be consistent with the listed occupants. Unknown evidence, disconnection, or a daemon mismatch prevented action. Historical evidence required another successful archive acquisition after the observation window.

The earlier tests had passed. Some of them were explicitly checking the full-queue requirement. They verified the policy we'd written, including the part that was wrong for the recovery task.

## Slow is different from idle

Large games made another distinction useful: elapsed download time versus time since positive progress.

At 15:41:40, Baldur's Gate II had been downloading for about 261 seconds. It was reporting 13.51 MB/s, with positive progress 0.1 seconds ago. A 90-second inactivity timer should leave it alone.

We tracked reported throughput, remaining time where available, and separate download and installation phases. We couldn't safely infer byte counts from `fractionCompleted`: SingaporeAir reached about `0.599` while downloading and `0.720` after entering Installing. It was weighted progress for the whole operation.

SingaporeAir's declared 106,472,032-byte download phase lasted 3.333 seconds; installation took another 7.517 seconds. Those observations were useful for testing the timing code. They weren't a sensible deadline for a much larger game.

Missing progress logs can still hide useful work. Automatic removal remains a heuristic with a real data-loss tradeoff. I accepted it for these placeholders and preserved the source backup.

## Debugging the wording

The report with Baldur's Gate II's active transfer also said:

```text
Scheduler: stale; slots 2/3; evidence age 150s
```

An adjacent app line said "stale observation." It looked as though the monitor had classified a healthy download as stalled.

The 150 seconds described the age of the slot snapshot. Transfer updates arrived separately and were current. We had two observations with different ages and a display that encouraged me to read one age as applying to both.

The revised wording separates them. This is abbreviated:

```text
Slot snapshot: stale; reported slots 2/3; snapshot age 150s.
Baldur's Gate II: listed in slot snapshot; ACTIVE download.
Transfer Baldur's Gate II: reported 13.51 MB/s;
last positive progress 0.1s ago.
Auto-uninstall: NO ACTION (blocked); history confirmation loading.
```

Old speeds say "last reported." Missing recent activity says "unknown." Waiting for evidence says "NO ACTION."

These labels matter when the next action can delete data. An operator should be able to distinguish an old measurement from a current diagnosis without reading the monitor's source.

## The queue debugger eats the Mac

At this point the phone was making progress. This seemed like a reasonable moment for the diagnostic tool to become the emergency.

`idevicesyslog` reached **42 GB of memory**. I had to kill it.

I had started the day trying to copy my apps. I was now supervising a log reader that had interpreted "keep an eye on the phone" as "consume the host computer." The phone was getting healthier. The Mac had become the patient.

Our Python monitor kept bounded records and capped archive output on disk. Neither protected us from the native executable allocating memory internally. A 512 MiB file limit is of limited comfort when the process writing the file has quietly become a 42 GB dirigible.

We reproduced the growth with a short, read-only live-log run. Its measured footprint went from 0.3 MiB at startup to 37.1, then 83.7, then 195.1 MiB by about ten seconds. The heap inspector reported **573,369 leaked allocations totalling 230,700,816 bytes**.

The installed library was `libimobiledevice` 1.4.0. Its live receive loop allocated a buffer for each log packet, passed it to a synchronous callback, and went around again. Simplified:

```c
void *buf = malloc(rlen);
/* receive the log packet into buf */
oswt->cbfunc(buf, received, oswt->user_data);
/* next packet */
```

There was no `free(buf)` after the callback. The process filters were downstream of that allocation, so asking for messages from only a few services didn't prevent the leak. The messages we didn't want were also being given a permanent, non-refundable reservation in RAM.

Upstream had already added the missing normal-path release. We backported it into a private build and also released archive buffers and live buffers on receive-error exits. The monitor uses that private executable and library; the Homebrew installation is unchanged.

The comparison was reassuring:

| Measurement | Installed 1.4.0 | Patched private build |
| --- | ---: | ---: |
| Sampled live footprint | Reached 195.1 MiB by about 10 seconds | Around 10-12 MiB after startup over 20 seconds |
| Leaked allocations reported by the heap scan | 573,369 | 11 |
| Total leaked bytes reported | 230,700,816 | 400 |

These were short runs, not a soak test, and 400 leaked bytes still isn't zero. But the log reader had stopped trying to become the largest object in the room.

We also added an independent watchdog for live, archive, and decoder child processes. It checks every 250 ms and kills its owned child above a sampled 512 MiB threshold. On macOS it checks physical footprint as well as resident memory, so compressed memory counts. A trip stops the monitor instead of restarting the same problem indefinitely. Rapid allocations can overshoot between checks; this is containment rather than an operating-system hard limit.

Before sending a patch upstream, we checked current master. The successful live-stream path was already fixed by [5ca453f, following issue #1677](https://github.com/libimobiledevice/libimobiledevice/commit/5ca453f9e3950b1f24b51e4cdf255236e34254c4). The archive loop and live receive-error exits still leaked. Our follow-up, [PR #1760: Free archive and failed live-receive buffers](https://github.com/libimobiledevice/libimobiledevice/pull/1760), covers those remaining paths. It's open, not merged.

The upstream diff is six insertions and one deletion. A local test driver supplied a mock transport to the actual worker and archive function bodies: one of six buffer-lifetime cases passed before the patch, and all six passed afterward. The project build checks passed too.

So the itinerary was now: migrate phone, inspect restore coordinators, build a queue debugger, debug the debugger, patch a C library, submit an upstream PR. I don't remember Finder mentioning this part of the progress bar.

## Downloaded, installed, still grey

The next morning, Discord supplied one more disagreement. Its installation log said "Install complete," and the inventory listed it as installed. Tapping it still failed. SpringBoard reported that the application was "unknown to FrontBoard."

Downloading the app again had not made it launchable. A normal iPhone restart did: after restarting, I opened Discord successfully. That confirmed recovery for Discord, though it did not establish that every restored app or its data was intact.

The queue had been one problem. The phone's view of what it could launch was another. Naturally, the icon's contribution to this distinction was to remain grey.

## What this established

By the October 21 read-only check at 16:43:57, the inventory had reached 951 installed records, with 699 ordinary placeholders and 338 demoted placeholders. The patched helper provided live completions and a successful archive lookup, then exited cleanly. Full restoration and app-data integrity were still unverified.

We had evidence for a narrower result: cancelling selected restore operations was followed by the scheduler admitting new work, and a targeted uninstall cleared Discord's surviving coordinator so it could download again.

The useful way to think about this phone was as several services maintaining related state. An app bundle, its placeholder, and its restore operation could disagree about what existed. The Home Screen exposed very little of that disagreement.

The decisive experiment took two seconds to show up in the logs: cancel SingaporeAir, see a slot released, see another app start. Most of the work was figuring out which two seconds to pay attention to.
