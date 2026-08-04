---
type: task
title: "Dev env: mobile goes deaf to incoming space messages (blocks testing) + self-heal that also fixes prod H-A"
status: done
created: 2026-07-21
severity: high (testing productivity) / medium (prod correctness)
area: WebSocket transport / receive path / dev runtime
related:
  - ".agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (Run 2 = 0/5 dev; Run 4 = 5/5 release; §1b, §7 H-A)"
  - ".agents/issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (the SEND-side sibling; this is the RECEIVE side)"
---

# Dev env receive-deafness — diagnose, then self-heal

## Status

moved to .done/ 2026-07-28 (PR #169 + #170 merges confirmed against git). SHIPPED 2026-07-23 — all receive-side fixes merged via PR #169 + #170; see master report §7e. ⚠️ THIS TASK is complete; the remaining dev-env *latency* work (correctness is fixed, dev is just slow) is tracked in master report §7d and is still open.


## Why this matters (user's framing, 2026-07-21)

LaMat tests in the **dev env**. When incoming messages don't land there, testing is nearly
impossible, forcing a fall-back to prod-preview builds that take **20–25 min each** — a brutal
feedback loop. Making dev receive reliable is a productivity fix, and the same self-heal fixes a
real production gap (H-A) for free.

## Evidence

- **Run 2 (dev):** desktop→mobile space = **0/5**, and the 30s `[WSTRACE] watchdog` line went
  **silent** during the outage (app FOREGROUND + screen ON the whole time → Doze ruled out).
- **Run 4 (prod-preview):** identical test = **5/5**. → the dev outage is a **dev/Metro
  runtime** effect, not a network zombie or a shipped receive bug (under benign conditions).
- Watchdog silence means either the JS thread wasn't executing OR the Metro log pipe dropped
  (logs invisible) while the WS receive was independently dead. **We have not distinguished
  these**, and the fix differs — so diagnose first.

## Step 1 — cheap diagnostic: was JS SUSPENDED, or ALIVE-but-deaf?

WSTRACE can't answer this (its logs go through the same Metro pipe that may be the thing
failing). Use a heartbeat that survives a dropped log pipe:

- Add a temp JS interval (~3s) that **appends `Date.now()` to a file** (expo-file-system) or a
  rolling MMKV array — NOT a console log. Reproduce the dev outage, then read the file.
  - **Timestamps have a GAP** (no ticks for the dead window) → **JS was SUSPENDED** (case A:
    dev runtime paused the bundle/timers).
  - **Timestamps are CONTINUOUS** through the window → **JS was ALIVE**, so the WS receive was
    zombied and only the _log pipe_ was silent (case B).
- (Alt if you prefer no JS change: a tiny native `android.util.Log` heartbeat shows in
  `adb logcat` even in dev, where JS console does not — but the file approach is lower-effort.)

## Step 1 RESULT (2026-07-21) — JS is ALIVE (case B), and it's NOT a deaf socket either

Heartbeat verdict: **all deltas ~3s, fresh file → JS thread ALIVE. Case A (suspension) RULED
OUT.** But a live retest changed the picture again: sending 5 browser→mobile messages produced
**hundreds of log lines and a burst on every send (frames ARE arriving), yet 0 landed.** So the
socket is NOT deaf — messages reach mobile and are **dropped in receive PROCESSING**,
downstream of the WS.

**Leading mechanism: receive-queue SATURATION drop (dev-specific).** The earliest WSTRACE paste
showed the watchdog at **`q-in=2000`** = `MAX_MESSAGE_QUEUE_SIZE` (the cap). At the cap the
pipeline drops oldest (backpressure, ~[WebSocketContext.tsx:5009](../../context/WebSocketContext.tsx#L5009)).
In dev the `log-since` catch-up flood (200-entry batches per hub) + the 10ms-per-message throttle
(`MESSAGE_PROCESS_DELAY_MS`) + verbose logging fill the queue faster than it drains → test
messages dropped. Release drains fast enough → Run 4 = 5/5. Plausible vicious cycle: drops →
cursor lag → re-fetch 200 → more flood → more drops.

- **CONFIRMED (2026-07-21 live log):** `watchdog state=connected rx-age=2s q-in=2000
tx-unacked=42 app=active` — queue **pinned at the 2000 cap** while the socket is alive
  (rx-age=2s). The preceding lines show the flood source: `log-since` fired across ~14 hubs,
  each returning `rx log-since-result entries=200 hasMore=true` — i.e. re-downloading 200 old
  entries PER SPACE, with more paginating behind. That floods the 2000-cap queue → drop-oldest
  → the user's new message is collateral.
- **The vicious cycle (root cause):** dropped entries never persist → the hub cursor
  (`getHubLastSeq`) never advances → the next `log-update` triggers another `log-since` that
  returns the SAME 200 `hasMore=true` → re-floods → re-drops. Self-perpetuating. Dev can't drain
  it because of the 10ms-per-message throttle (`MESSAGE_PROCESS_DELAY_MS`): 10ms x thousands of
  flood entries >> the rate they arrive, so the queue sits permanently at cap. Release drains
  fast enough → Run 4 = 5/5.
- `tx-unacked=42`: appends piling up unacked during the flood. Mostly the per-space device-key
  **re-announce** appends (one per hub per reconnect), not user messages — relevant context for
  the H-B fix (its ledger must tag only USER-message appends, else these announce appends would
  resend-loop).
- **Revised fix direction** (socket is fine, so NOT force-reconnect):
  1. **Break the cycle:** ensure the hub cursor advances on receipt/ingest, not only after
     successful downstream processing — so a transient drop can't wedge `log-since` into
     re-fetching the same 200 forever. (Verify where `setHubLastSeq`/cursor advance happens
     relative to the drop point — likely THE fix.)
  2. **Stop dropping received data:** raise/rework `MAX_MESSAGE_QUEUE_SIZE` backpressure so
     catch-up entries aren't silently dropped; and skip/shrink the 10ms throttle for catch-up
     (`log-since-result`) batches so dev can actually drain them.
  3. **Shrink the flood:** smaller `log-since` page and/or coalesce per-hub catch-up so a
     reconnect doesn't fan out 200 x 14 at once.
  4. Quiet our own WSTRACE verbose per-frame logging — it worsens the dev slowdown AND makes the
     terminal unreadable (user could not extract signal from the flood).
- rx-age watchdog force-reconnect + NetInfo bridge remains the separate PROD H-A fix; this dev
  problem is a different mechanism (queue drop from catch-up flood, not a deaf/zombie socket).

## ROOT CAUSE FOUND (2026-07-21) — cursor-wedge on queue overflow (AFFECTS PROD)

Reading the receive pipeline pinned the exact mechanism — a client bug, not transport:

1. **Overflow drops un-persisted entries** — [WebSocketContext.tsx:5562-5567](../../context/WebSocketContext.tsx#L5562):
   when `messageQueueRef.length >= MAX_MESSAGE_QUEUE_SIZE` (2000) it `splice`s out the OLDEST
   items, including catch-up log entries not yet persisted.
2. **Cursor advances only contiguously** — [WebSocketContext.tsx:4959-4967](../../context/WebSocketContext.tsx#L4959):
   `if (seq === advance + 1) advance = seq; else break;` — stops at the first gap.

Overflow (1) punches a gap; the cursor (2) refuses to cross it, so `getHubLastSeq` sticks.
Every `log-update` re-issues `log-since` from the stuck cursor → same 200 `hasMore=true` →
overflow again → gap again. **Self-perpetuating catch-up storm; new messages shoved off the
full queue.** (Setup-effect re-runs on each `connectionState` flip — deps
`[connectionState, registerLogFrameHandler, enqueueOutbound, processMessageQueue]`, line 5662 —
amplify but are not the root; the log-update→log-since→gap loop self-sustains.)

**AFFECTS PRODUCTION — this is not dev-only.** It is conditional on the queue overflowing:

- Dev: always (slow JS + 10ms throttle + 14 spaces x 200 catch-up) → queue pinned at 2000 →
  unusable.
- Prod: intermittently — many spaces + accumulated backlog (offline return) or a slow cellular
  moment overflows the queue → gap → wedge → messages silently stop landing.
- **An app restart clears the in-memory queue** → next `log-since` drains without overflow →
  cursor crosses the gap → backlog floods in. **This is exactly the 6-month symptom
  "desktop→mobile 0% then all land on restart."** The bug plausibly IS that symptom's receive
  half. (Run 4 = 5/5 only because that moment was benign and never overflowed.)

### The fix (ships to prod; mobile-side, this pipeline is not in shared)

Make the cursor always able to advance = **never drop un-persisted catch-up entries**:

1. **Flow-control the catch-up (primary):** don't fetch the next `log-since` page (and don't
   fan out all ~14 hubs at once) while the queue is near cap — gate `requestLogSince` on queue
   depth so incoming entries never exceed what the queue can hold. Bounds the flood to the
   drain rate; the queue never overflows; no gaps; cursor advances; storm cannot start.
2. **Don't silently drop log-tagged synthetics on overflow** — if a hard cap is kept, apply
   backpressure UPSTREAM (pause reads / defer fetch) instead of splicing out un-persisted
   entries mid-sequence.
3. **Drain faster:** skip/shrink the 10ms `MESSAGE_PROCESS_DELAY_MS` for `log-since-result`
   catch-up batches (they're already batch-ingested; the per-message yield is what starves dev).
4. Confirm in prod-preview by forcing overflow (many spaces + backlog) BEFORE claiming fixed.

## Step 2 — (SUPERSEDED by root cause above) earlier self-heal sketch, kept for the prod H-A angle

Regardless of A vs B, the cure is the same shape: **notice we went deaf, then force a fresh
socket + `log-since` catch-up.** Build a watchdog-driven self-heal:

- On each watchdog tick, compute **wall-clock gap** since the last tick. If `gap >> interval`
  (e.g. > 3× 30s) → we were asleep (case A) → on wake, **force reconnect + re-run `log-since`
  for all active hubs** (the catch-up already exists in the setup effect at
  [WebSocketContext.tsx:5550-5590](../../context/WebSocketContext.tsx#L5550); factor it into a
  callable `catchUpAllHubs()` and invoke it here).
- Also, if `state=connected` but `rx-age` exceeds a threshold while we know the peer is active
  (case B / prod H-A zombie) → same remedy: force-close the socket and reconnect (don't trust
  `isConnected`; §3 finding 3 of the master report — the current foreground handler only
  reconnects on `!isConnected`, which a zombie defeats).
- Add a **NetInfo → force-reconnect** bridge (wifi↔cell / NAT rebind), currently missing
  (master report §3 finding 2).

Why this helps dev testing specifically: the moment the dev runtime resumes the JS thread, the
gap detector fires and flushes the backlog within one tick — instead of the current "wait
minutes for the OS to close the socket, then batch." In practice: messages appear seconds after
the app becomes responsive again, not after a manual reload.

## Caveat (do not oversell)

If case A is a hard _suspend_ where even the watchdog interval never resumes until a full
reload, the in-JS gap detector can't run either — then the lever is an **AppState/native
foreground signal** forcing `catchUpAllHubs()` on resume, plus accepting that a wedged dev
bundle sometimes just needs a reload. Confirm with Step 1 which regime we're in before
promising "dev becomes fully reliable." The prod-H-A half of the fix (rx-age + NetInfo
force-reconnect) is solid regardless.

## SESSION 2 FINDINGS (2026-07-21 evening) — THE DEEPER BUG: poison-pill DM batch freeze

Runtime-diagnosed on-device (temp `[CATCHUP-DIAG]` file instrumentation + adb readback,
branch `fix/hub-log-catchup-flow-control`):

1. **The drain loop was FROZEN, not slow.** `drained` counter stopped dead while JS stayed
   alive: `processMessageQueue` was stuck forever on
   `await cryptoProvider.batchProcessMessages()` — stage `native-batch(sp=0,dm=1)`, same
   stageTs across samples minutes apart, reproducible across app restarts. One hung native
   call = ALL receive (spaces + DMs) dead until restart.
2. **The poison group:** the device inbox holds **~240 all-`init:true` envelopes dating back
   ~2 months** (a few 92KB, mostly ~2.4KB), `states: 0`. The native DM batch containing them
   never resolves (hung or >30s pathological).
3. **Why the hoard exists:** decrypt-failure paths return WITHOUT `deleteInboxMessages`
   (e.g. [WebSocketContext.tsx:2937](../../context/WebSocketContext.tsx#L2937)) — failed
   messages replay on every connect forever. Desktop deletes even failures (its own
   documented black-hole tradeoff) and so never hoards.
4. **Flood scale:** ~7,000 live-path messages redelivered by the node in one dev session —
   likely large parts of space history replay on every connect too (space-inbox copies may
   also never be deleted; VERIFY before treating as fact).
5. **Shipped containment (commit ed1aeaa):** 30s watchdog race around the native batch call;
   on timeout → throw into the existing individual-processing fallback (proven to complete;
   poison messages fail cleanly there) + disable DM native batching for the session +
   capture the poison group summary into the diag file. Confirmed live: timeout fired,
   drain resumed at ~11 msg/s, queue fell from pinned-2000, user's messages landed.
6. **Open (lead-sensitive):** what to do with the hoard — server-side delete of
   permanently-failing inbox messages (desktop parity; permanent, loses nothing real) vs
   client-side attempted/skip list (conservative, no server mutation). Every dev connect
   pays the reflood + one 30s watchdog stall until resolved. Also open: the Kotlin root
   cause (WHY the init-envelope batch never resolves) — needs native-side work.

## RESUME HERE (2026-07-22) — state of the branch and next actions

**Branch `fix/hub-log-catchup-flow-control`, 3 commits ahead of master:**

- `1ce7bb1` fix: flow-control hub-log catch-up (cursor-wedge fix — SHIPPABLE, runtime-validated)
- `a003017` chore: temp diag file writer `[CATCHUP-DIAG]` (**REVERT before PR**)
- `ed1aeaa` fix: watchdog + DM-batch circuit breaker (SHIPPABLE, runtime-validated; contains a
  few `[CATCHUP-DIAG]` lines to strip when reverting a003017)
- Working tree clean. Phone (Motorola, ZY22K3XRLP) has this bundle loaded; diag file at
  `files/catchup-diag.json` readable via `.agents/scripts/read-catchup-diag.ps1`.

**Runtime-proven end state (user-confirmed):** desktop→mobile space messages LAND again in
dev; watchdog fires once/session (~30s stall) then drain runs ~11 msg/s. mobile→desktop was
already landing consistently this session. Hub cursors were still 0 at close (gate correctly
yields to the live reflood; catch-up completes when the flood subsides) — worth re-checking
cursors advance on a quieter connect tomorrow.

**Next actions, in order:**

1. **Verify space-inbox deletion question** (finding 4): does mobile ever
   `deleteInboxMessages` for SPACE inbox messages after processing? If not, whole space
   history refloods every connect (~7k msgs seen). Verify in code before treating as fact.
2. **Hoard containment decision** (finding 6): draft the two options (server delete of
   permanently-failing messages = desktop parity vs client-side skip-list), pick a
   recommendation, and ping the lead on Telegram before shipping either.
3. **Kotlin root cause** (why the init-envelope DM batch never resolves) — separate,
   needs native rebuild to iterate; consider a standalone task file.
4. When 1-3 are settled: revert the `[CATCHUP-DIAG]` instrumentation, re-run typecheck/lint,
   PR the branch (self-explanatory PR text; no internal jargon), and re-check the
   cursor-advance + forced-overflow validation in prod-preview per the fix section above.
5. Also still open on OTHER fronts: send-side H-B fix (own task), and the verdict task's
   payload-less-entry observation (minor).

## Relationship to the send fix

This is the RECEIVE-side sibling of `2026-07-21-fix-space-append-send-loss-ack-resend.md`.
Together they are the two halves of "mobile transport self-heals instead of silently losing":
send = resend-on-missing-ack, receive = force-catch-up-on-deafness. Can ship independently.

---

_Last updated: 2026-07-21_
