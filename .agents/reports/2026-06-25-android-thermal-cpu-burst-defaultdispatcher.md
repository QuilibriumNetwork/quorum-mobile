# Report: Android device heat — CPU profile of the live app

**Date:** 2026-06-25
**Reporter:** maintainer (on-device ADB profiling, read-only)
**Severity:** Medium (thermal/battery; no crash, no ANR)
**Status:** Runtime-diagnosed. Root cause in source NOT pinned — for lead dev. Every claim below is backed by a measurement; inferences are labelled as such.

---

## TL;DR (corrected after extended sampling)

Two distinct CPU phases, measured on the **live/release build**:

1. **Startup burst (the big one):** right after launch/connect, the native crypto coroutine thread (`DefaultDispatcher`) ran a **full core at 100% for tens of seconds** (cumulative ~110 s CPU), then **stopped**. Almost certainly initial sync work — decrypting the message backlog + ratchet/DKG setup on connect. **It is NOT an infinite loop** (proven below).

2. **Idle drip (the real bug):** with the app sitting **idle on screen, user touching nothing**, the **React Native JS thread (`mqt_v_js`) burns CPU continuously** — **~21 s of CPU over 185 s of idle = ~11.5 % of a core, sustained** — plus correlated **GC churn (`HeapTaskDaemon`, ~5 s)**. Crypto (`DefaultDispatcher`) is quiet in this phase. Per-interval deltas show **near-continuous churn, not a periodic timer**. During the whole idle window the device held at **skin 38 °C / Thermal Status 1** (first throttle band). Confirmed by a dedicated, pre-committed 3-min sampling run (§4).

**Net:** the heat the user feels comes from (a) a heavy but bounded startup crypto burst, and (b) **ongoing JS-side background work at idle** that has no business running when nothing is on screen. The idle JS activity is the more interesting bug — it points at a **JS timer / resync / poll loop**, not native crypto.

> Note on an earlier draft: I initially reported "DefaultDispatcher spins at 100% continuously at idle." Extended sampling (75 idle samples across two windows) disproved that — see §3. The continuous burn was startup-only. Reporting the correction explicitly so the lead dev doesn't hunt a nonexistent native infinite loop.

---

## Environment

| | |
|---|---|
| Device | Motorola Edge 50 Fusion (`ZY22K3XRLP`) |
| Android | 16 (SDK 36) |
| App package | `com.quilibrium.quorummobile` (**live app, real data — NOT `.debug`**) |
| App version | versionName **1.1.0**, versionCode **45**, built 2026-06-11 |
| App PID during capture | 3726 |
| Method | USB + ADB only, read-only. No Metro / dev env. |

---

## The three threads that went hot (names resolved via `/proc/<pid>/task/<tid>/comm`)

| TID | `comm` | What it is | Role in the heat |
|---|---|---|---|
| 3768 | `DefaultDispatch` | Kotlin `Dispatchers.Default` worker → **native Rust/UniFFI crypto** | Startup burst (~110 s CPU), then idle |
| 3807 | `mqt_v_js` | **React Native JS thread** (Hermes/JSI message queue) | **Burns CPU at idle** (~8.5 s over 3 min idle) |
| 3732 | `HeapTaskDaemon` | **Java GC** background thread | Churns in step with the JS work |

The co-activation of all three (JS hot → GC hot, crypto hot at startup) is the classic signature of **JS driving heavy work and allocating garbage**.

---

## Evidence

### 1. Startup burst — single core at 100% (`top -H`)

```
  TID USER   PR NI S [%CPU] %MEM   TIME+    THREAD
 3768 u0_a602 20 0 R  100   8.7   1:37.51  DefaultDispatch
 ... every other thread ~0% ...
```
State `R` (Running, not blocked). Caught hot in the first minutes after the app was foregrounded.

### 2. schedstat proves it was CPU-bound, not blocked

`/proc/3726/task/3768/schedstat` (ns_running, ns_waiting, slices):
```
109581844556   736604126   3793   →  ~109.6 s running vs ~0.74 s waiting
```
Ran ~99.3% of the time, almost never yielded. Genuine CPU work, not I/O wait.

### 3. It is NOT an infinite loop — burst ends, idle is mostly quiet

- `DefaultDispatch` schedstat across a 3-min idle window: `109581844556` → `109582109246` ns = **+0.0003 s**. Effectively stopped.
- Idle cadence sampling of *all* threads >25% CPU:
  - Window A: **1 / 30** samples hot
  - Window B: **0 / 45** samples hot
  - → at steady-state idle, crypto and most threads are quiet.

### 4. The JS thread runs continuously at idle (the core finding — confirmed by a dedicated 3-min run)

A dedicated, pre-committed protocol: sample each thread's cumulative CPU (ms) every 15 s for 185 s, **screen on, app on conversation list, untouched**, interpret only after all 13 samples in. Raw table:

```
ts        mqt_v_js_ms  DefaultDispatch_ms  HeapTaskDaemon_ms  skin_C  status
07:47:45  85000        (quiet)             19062              38.006  1
07:48:46  93057        ...                 20982              38.006  1
07:49:46  97153        ...                 22510              38.006  1
07:50:48  106346       (quiet)             24288              38.006  1
```

| Thread | start | end | **delta over 185 s idle** | % of one core |
|---|---|---|---|---|
| `mqt_v_js` (JS) | 85000 ms | 106346 ms | **+21,346 ms (~21.3 s CPU)** | **~11.5 % continuous** |
| `HeapTaskDaemon` (GC) | 19062 ms | 24288 ms | **+5,226 ms (~5.2 s CPU)** | ~2.8 % |
| `DefaultDispatch` (crypto) | flat | flat | **~0** | quiet |

**Per-15s-interval JS deltas:** 2352, 1463, 1162, 3080, 583, 1282, 1381, 850, 1094, 677, 1314, 6108 ms.
→ **Near-continuous churn, not a single periodic timer.** The JS thread is doing sustained background work every interval (with one larger blip at the end), not waking briefly every N seconds. This rules out "occasional keepalive" and points at a **continuous loop / re-render storm / short-interval resync**.

→ With nothing on screen and no user input, **JS burned ~21 s of CPU in ~3 min (~11.5 % of a core, sustained) and forced ~5 s of GC.** Skin temp held at exactly **38 °C (Thermal Status 1, first throttle band) for the entire idle window.** This is the heat the user feels during normal "just-sitting-there" use.

### 5. Thermals confirm it's real, and CPU-driven

During a hot window (`dumpsys thermalservice`):
```
CPU0..CPU7: 50–58 °C   ← hottest = CPU (matches single/few-core burn)
GPU:        41–48 °C   (moderate — not a rendering problem)
skin:       ~38 °C
battery:    28 °C
```
After 3 min of *idle* the device still read **skin 38 °C, Thermal Status 1** (first throttle band; skin threshold table starts throttling at 38 °C). So even the idle drip is thermally non-trivial.

### 6. Logcat silent; no ANR / GC-spam / frame drops in log

`adb logcat --pid=3726` produced no app output during bursts (release build strips logs). No `ANR`, `Skipped N frames`, or `Davey`. Rules out main-thread block and rendering overhead as the cause.

---

## Interpretation — measured vs inferred

**Measured (high confidence):**
- A startup crypto burst pins a core ~110 s then stops. ✅
- At idle, the JS thread keeps consuming CPU (~8.5 s / 3 min) with correlated GC. ✅
- CPU (not GPU) is the hot subsystem; device reaches first throttle band. ✅

**Inferred (for lead dev to confirm — NOT measured):**
- Startup burst = backlog decryption + ratchet/DKG setup (because crypto runs on `DefaultDispatcher` and the burst coincides with connect). Plausible, not proven — I never captured a native stack (needs root; this is a production device).
- Idle JS burn = a **JS-side timer / resync / poll loop** (e.g. WebSocket keepalive/resync, periodic recompute, a `setInterval`, or a render loop re-running). The `mqt_v_js` + GC signature fits JS work creating objects on a schedule. **This is the most actionable lever.**

**Relevant source (where crypto is dispatched):**
- `modules/quorum-crypto/android/src/main/java/expo/modules/quorumcrypto/QuorumCryptoModule.kt`
  - `private val cryptoScope = CoroutineScope(Dispatchers.Default)` (line 26); imports `uniffi.channel.*` (Rust). All handlers are on-demand `AsyncFunction`s — **no Kotlin `while`/poll loop**, confirming the native side isn't self-looping; it's driven from JS.

---

## Suggested next steps for lead dev

1. **Hunt the idle JS work first** — it's the clearest bug. Look for `setInterval`/timers/resync that fire with no UI mounted: WebSocket keepalive/resync, notification polling, a recurring config/blob refetch, or a component re-rendering on a timer. A JS profiler (Hermes sampling profiler) or temporary timing logs around suspected intervals will name it fast.
2. **Confirm the startup burst is bounded and expected** — if it's backlog decrypt/DKG, fine; verify it isn't re-running on every reconnect (which would re-heat repeatedly during flaky network).
3. Consider debounce/cache/cancellation for both so reconnect/idle don't recompute.

---

## Reproduce (read-only, safe)

```bash
PID=$(adb shell pidof com.quilibrium.quorummobile)
# hot threads with real names:
adb shell top -H -b -n 1 -p $PID | awk 'NR>7 && $9+0>25 {print $1, $9"%"}' \
  | while read tid pct; do echo "$(adb shell cat /proc/$PID/task/$tid/comm) $pct"; done
# CPU-bound vs blocked (run twice, diff field 1 = ns running):
adb shell cat /proc/$PID/task/<TID>/schedstat
# idle drip: diff mqt_v_js schedstat field 1 across a few minutes of idle
adb shell dumpsys thermalservice | grep -E "Thermal Status|mName=skin"
```

**Do NOT uninstall the app** — live build, real user data. All profiling above is read-only.

*Last updated: 2026-06-25*
