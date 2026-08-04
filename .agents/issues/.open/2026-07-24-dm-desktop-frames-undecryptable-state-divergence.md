---
type: bug
title: "DM messages silently fail to deliver (mobile <-> desktop)"
status: open
created: 2026-07-24
severity: high (silent, permanent message loss both directions)
area: DM Double Ratchet / session handshake / multi-device
objective: DMs deliver reliably in BOTH directions on BOTH pairings — desktop<->mobile AND mobile<->mobile. mobile<->mobile is the majority case and has never been testable (one phone).
next: "NEXT SESSION: the mobile↔mobile rounds ARE DONE (§27, rounds 28-29, 2026-07-26). Headline: the node write-layer black hole REPRODUCES phone↔phone — 8/25 frames A→B, ALL confirmed handed to the socket (sig=1), size-blind, and strongly DIRECTIONAL this round (32% one way, ~0% the other). That is a second, unrelated receiver showing the same loss ⇒ strongest evidence yet that it is node-side. ACTION 1: post the §27.2 table + fingerprint list as a comment on issue #183. ACTION 2: decide on mitigation 1, resend-with-dedupe (§26.1) — a 32% directional loss with no client-visible signal cannot be fixed receive-side, and it works whether the drop is node- or native-side (LaMat-gated, still unbuilt). ⚠️ RIG CHANGED: [DM-recv wire] was only on the individual decrypt path and made round 28 report 21 phantom losses (§27.1, added to §E); a twin log now covers applyDMGroupResults and both sites carry a path:'batch'|'individual' field. Committed on diag/dm-frame-trace — get onto it with `git debug` (never by SHA: it rebases, and a stale SHA is exactly how round 28 under-logged arrivals and faked losses). Mobile-side loss numbers in ANY earlier round are upper bounds, not measurements (rounds reporting PERFECT delivery are unaffected). Before the next round, clear the two unrelated undecryptable storm conversations (A inbox QmNsHYeYaA, B inbox QmWHzJSMnF) — they inject a dead frame every ~16 s. Send path still FROZEN (§23)."
related:
  - "UPSTREAM HANDOFF: https://github.com/QuilibriumNetwork/quorum-mobile/issues/183 (both remaining root causes, lead-facing, repro inlined)"
  - "issues/.open/2026-07-26-spaces-log-append-ack-ignored-silent-write-loss.md (SPILLOVER, context only: Spaces writes ride the same ws.send path this doc measured, and the hub-log write ack is discarded — code-read only, no Spaces round ever run)"
  - "issues/.done/2026-07-25-mobile-per-device-conversation-inbox.md (active work)"
  - "quorum-desktop/.agents/tasks/transport/dm-ratchet-upstream-divergences.md (all 7 shipped divergences, lead-dev facing)"
  - "quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md (desktop master — mechanism catalogue)"
  - "issues/.done/2026-07-24-dm-session-confirm-row-mismatch-x3dh-every-send.md (FIXED parent)"
---

# DM messages silently fail to deliver (mobile ↔ desktop)

> **Agent orientation.** This document has two halves.
> **PART I (§A-§E) is what you read** — current model, what is ruled out, what is
> open, how to investigate, and what we got wrong. It is kept current.
> **PART II (§0-§20-octies) is the ARCHIVE** — the chronological investigation,
> 22 live rounds. It is primary evidence and is NOT kept current: it contains
> conclusions that were later retracted, argued persuasively at the time. **Do
> not act on anything in PART II without checking §E first.**

---

## §A. CURRENT MODEL — what we believe today

**The symptom:** DMs silently never arrive. Historically ~6 months. The bug is a
**concentration of independent defects in one pipeline**, not one root cause —
which is why each fix was real and the symptom survived.

> ⚠️ **FALSIFIED 2026-07-26.** The paragraph below is the load-bearing premise
> for much of this document, and it is no longer true. **desktop↔desktop
> reproduced the full failure**: 0 of 10 delivered in BOTH directions on an
> established session, healed only by a manual reset. Frames arrived and failed
> AEAD (21/21 joined by fingerprint), so it is not transport loss. Anything here
> that reasons "d↔d is healthy, therefore the cause is mobile-side" must be
> re-derived. Full write-up, rig and open leads:
> `quorum-desktop/.agents/tasks/transport/2026-07-26-dm-desktop-to-desktop-resurfaced.md`.
> Note this also strengthens issue #183: the node write-layer drop already
> reproduced phone↔phone with a different receiver implementation, so it is
> platform-independent and desktop was simply never measured for it.

**The decisive observation (LaMat, 2026-07-25):** _desktop↔desktop has no issues.
Only pairings involving mobile break._ This is now EXPLAINED: the two fatal
defects were both in mobile's SEND path (shared conversation inbox
§20-quinquies; missing accept §20-sexies), and both shipped in **PR #180**.
The accept deadlock is gone from live traffic — round 19's reset-from-mobile
pass was 5/5 both directions, the first clean pass in this bug's history.

**What remains open, after rounds 24-26 (§21-§24) — read those four sections
for the current picture; the numbered items below are kept for continuity
and updated in place:**

0. **THE TWO LEAD-DEV ITEMS — FILED as
   [quorum-mobile issue #183](https://github.com/QuilibriumNetwork/quorum-mobile/issues/183)
   (self-contained, repro inlined, transparency note included); LaMat pings
   the Lead via DM. Both outside this repo:**
   (a) **Upstream crate bug (§23):** a receiver whose first-ever processed
   frame sits at chain position > 0 forks permanently at the next DH turn —
   deterministic repro `.agents/scripts/dr-advanced-start-fork.mjs`. Dormant
   until frame loss supplies the trigger; mobile pairings supply it
   constantly (see item 2), desktop↔desktop essentially never — which is why
   d↔d looks healthy. Mobile's re-key-per-unconfirmed-send accidentally
   shields against it (every announce starts the peer at position 0), so the
   SEND PATH IS FROZEN until the crate is fixed.
   (b) **Node-side silent write drop (§24, refined §25):** frames handed to
   the native socket, signed, connection open, still never retrievable —
   ~12% in round 27 (signed-field presence does NOT protect; round 26's
   10/10 read-ack kill still unexplained). The client cannot discriminate
   further because **the protocol has no write-ack or error frame** — a
   rejected write is indistinguishable from a delivered one. The ask for
   the Lead: what does the node's write path drop silently, and/or add a
   write-ack.

1. **SOLVED AS A MECHANISM (fix not yet built): the decrypt failures on
   desktop's CONFIRMED branch** (§11/§13b/§14d family). Offline replay
   proved the failing frames are healthy ciphertext from the correct session
   that arrive **ahead of desktop's ratchet root** (an intermediate frame
   was lost, so the frame's epoch is unreachable until later traffic
   advances the root — then it decrypts fine, proven frame-by-frame). #253
   doesn't heal it because its **wall-clock retry budget expires seconds
   before the state catches up** (all four frames in round 24; same in
   round 23 — the `dfe9e96` theory is dead, the divergence is live on
   master). Fix direction: state-aware retry (re-attempt retained frames on
   every successful decrypt for the session), not a bigger timeout.
   **Perspective (post-mapping):** when redelivery outlives the gap this
   class SELF-HEALS (message "9" recovered live); in round 24 it permanently
   ate only read-acks. Real but demoted — the write-layer feeds it and
   causes the direct message loss.
2. **Frames that leave mobile's drain and never arrive — CHARACTERIZED in
   round 26 (§24).** Round 24: 13/29 (~45%); round 26: JS layer EXONERATED
   ([WS-frame] proves native handoff with socket open; socket-loss recovery
   works) and the loss is TYPE-CORRELATED (read-acks 10/10 dead, posts
   11/11 delivered) ⇒ prime suspect is item 0(b), the server-side silent
   drop. Every such loss is also a potential trigger for 0(a). Round 27
   (sig= field) decides.
3. **NEW (round 24): the init-embed payload drop — BOTH directions lost
   exactly the first post-reset message.** Desktop side LOCATED: the init
   path's bare silent catch (`MessageService.ts` ~L3733) deletes the frame
   from the server on ANY post-install error, no logging — "1" entered the
   happy path (SESSION REPLACED logged) and vanished inside it. Fix: log +
   retain instead of delete. Mobile mirror (d1, `WebSocketContext` ~L2935)
   code read pending.
4. **Delete-by-timestamp collateral loss (§16c)** — unproven but structurally
   real, and unobservable by construction (see §20-undecies on survivorship
   bias). The desktop diag branch now detects collisions among arrived frames
   and refuses the colliding delete, so if it ever fires it self-proves.
   Round 24: guard armed, zero firings; survivor timestamps ms-distinct —
   §16c does NOT explain defect 2's loss rate.

### Shipped and merged (7)

| PR   | Repo    | Fix                                                                                                                                                                          |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #252 | desktop | Reset keeps inbox ROUTING (deleting mappings orphaned the peer permanently)                                                                                                  |
| #253 | desktop | Retain undecryptable frames for retry + ack on success + time-bounded budget                                                                                                 |
| #254 | desktop | Send with the NEWEST session for a device                                                                                                                                    |
| #255 | desktop | Absolute age bound on init envelopes (guard was blind with zero rows — i.e. right after a reset)                                                                             |
| #178 | mobile  | Ratchet state resurrecting / lost on background                                                                                                                              |
| #179 | mobile  | Send with the NEWEST session for a device                                                                                                                                    |
| #180 | mobile  | Per-device conversation inbox (§20-quinquies) + the SDK accept (§20-sexies) + server rejections unswallowed + accept recorded only once the whole batch exists               |
| #256 | desktop | Init path: no silent delete of the embedded first message (log + isolate + retry + retain + age-bounded salvage) — the m1 fix (§21)                                          |
| #181 | mobile  | DM receive failures logged everywhere (was fully silent) — the d1-class visibility fix (§21)                                                                                 |
| #182 | mobile  | Flat control frames (typing!) no longer crash the save + all 18 DM ack-deletes now sign with the right key + messageId-less backstop — kills the crash-redeliver flood (§22) |

All verified by tests; #253 verified live recovering real frames; #180's accept
verified live (round 19: 0/3 → 5/5). #256's live verification rides the next
capture round (reset + first message is exactly its scenario).

---

## §B. RULED OUT — do not re-investigate

Each of these cost real effort. They are settled by running-code evidence.

| Ruled out                                                               | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| **The crypto core** (Rust `channel` crate) — ⚠️ EXONERATION AMENDED §23 | Serde struct arities identical between mobile's `.so` and the SDK wasm; zero structs unique to either. Then empirically: out-of-order delivery, cross-epoch stragglers, 6 consecutive missed epochs, receive-state rollback — **all recover**. 40/40 decrypts under sustained alternating ratchets. **BUT §23 found the one untested cell: a receiver whose FIRST-ever processed frame is at chain position > 0 forks permanently at the next DH turn** (`dr-advanced-start-fork.mjs`, deterministic). Mid-chain gaps stay exonerated. | §10b, §12b, §13c, **§23** |
| **Skip limits**                                                         | Tolerates ~100 skipped messages; observed gaps are 1-9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §13c                      |
| **Envelope escaping / the blanket unescape**                            | A real envelope is nested JSON with base64 leaves — **zero backslashes**, so the five `includes('\\')` sites never fire. Verified byte-identical round-trip. Dead code.                                                                                                                                                                                                                                                                                                                                                                | §10c                      |
| **Desktop row ambiguity**                                               | 20/20 decrypts had `match: 1`, `fellBack: false`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | §14a                      |
| **Desktop state serialization / the mutex**                             | `stFp` chain unbroken across 20 decrypts and 92 saves: every read is exactly the previous save. Clears mechanism 2 of the desktop master report on the DM path.                                                                                                                                                                                                                                                                                                                                                                        | §14b                      |
| **"The two sides are on different sessions"**                           | DH fingerprints overlap exactly (`dhr` == peer's `dhsPub`). Correctly paired.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | §13a                      |
| **Root-key mismatch as a divergence signal**                            | A healthy 40/40 session shows the two sides' `root_key` differing at every round. **Never use this as a signal.**                                                                                                                                                                                                                                                                                                                                                                                                                      | §13a                      |
| **Transport loss (mobile→desktop)**                                     | With a working join key, frames mobile sent were found arriving at desktop. They arrive; they fail to decrypt.                                                                                                                                                                                                                                                                                                                                                                                                                         | §18                       |

---

## §C. OPEN — ranked

1. ~~Baseline round~~ **DONE — round 24 (§21), fully mapped.** Verdict:
   divergence live on master; mechanism found (frames ahead of the ratchet +
   budget-death, see §A.1); message loss attributed: 3 of 4 to the
   write-layer, 1 of 4 to the init-embed payload drop (§A.3). Next code
   work, in order: desktop init-path read (§A.3), desktop #253 state-aware
   retry, mobile per-frame send-loop instrumentation for the write-layer
   round (§21 NEXT list).
2. **The write-layer loss — NOW THE PRIMARY TARGET** (round 24: 13 of 29
   frames, ~45%, never arrived; round 21: 5 of 7). Rejection logging armed
   and silent this time — the frames likely never reach the server inbox.
   The transport (`rn-websocket.ts`) already error-logs batch aborts and
   per-frame send failures, and requeues frames into `pendingEnvelopes` on
   socket slip — but RN's `ws.send` is fire-and-forget into the native
   layer, and in-memory queues die with the process. No positive write-ack
   exists in the protocol. Check first: the §21 second-instance question
   (drain-race would explain everything silently); then instrument the
   actual per-frame `ws.send` loop (the current `[DM-send wire]` logs at
   prepare-end, BEFORE the loop).
3. **Delete-by-timestamp (§16c) — now instrumented.** The §20-octies
   retraction over-corrected: a collaterally-deleted frame is unobservable BY
   CONSTRUCTION (it dies on the server unread), so "no collision observed
   among survivors" is survivorship bias, not evidence of absence. Mobile
   writes ~6 frames per message in a tight burst and two live frames have
   shared a timestamp (§15a). The desktop diag branch detects collisions among
   arrived frames and refuses the colliding delete (`[DM-ack collision]`) —
   one firing proves it. The API-shaped fix still needs the Lead Dev.
4. **`RX-NOSTATE` / `DROP-noEncState` are silent drops on BOTH platforms.** A
   frame for an inbox we hold no state for proves the peer is on a stale
   session. Re-initialising instead of discarding makes the pairing
   self-healing regardless of cause.
5. **The `sentAccept` write at `WebSocketContext.tsx` ~L2949 — DEMOTED to
   cleanup** (was "do this before anything else"; see §E and §20-undecies).
   The round-23 desktop log disproves the theory that it was masking a live
   deadlock. It is still semantically wrong in one narrow way: the
   trial-decrypt loop runs over ALL of the conversation's states, so
   `successInboxId` can be a DIFFERENT row than the arrival inbox, and the
   flag is then set on a row whose announcement was never proven. Removing the
   write is safe (it is redundant with `markAcceptSent`; worst case mobile
   keeps announcing, which is what desktop does to everyone, harmlessly) —
   but do it with tests, after the baseline round, not first. Do NOT re-add
   the unsigned-frame self-heal (§20-nonies): measured, wrong, reverted.
6. **mobile↔mobile — untested, degraded-not-deadlocked** (§20-octies-bis has
   the scope table). Mobile's receiver dispatches on frame shape, so the
   accept bug churned X3DH per message rather than deadlocking; #180 should
   end the churn. **Testable without a second phone:** run a second account on
   an Android emulator alongside the physical device. Emulator SecureStore is
   flaky across restarts (§7b — may mint a new device identity), which is
   tolerable for a single-session test and is itself the environment the
   registration-ghost problem lives in.
7. **Ghost/legacy device accumulation.** Registration merges device entries and
   never removes them; mobile re-X3DHs to every one on every send (45 of 54
   sends in one capture). Waste and write-amplification (×6 per message), not
   proven loss. Desktop has a plan file (`9341bf498`). **Note:** "ghost" was a
   bad word — these are real devices LaMat uses. Multi-device is normal and must
   not lose messages.
8. **New-device history (UNVERIFIED, Lead Dev question).** Fan-out happens at
   SEND time against the registration as it was then. Offline devices are fine
   (frames queue), but a device **added after** a message was sent was never a
   target. Whether history reaches it depends on a separate sync/backup path
   that nobody has checked.

---

## §D. HOW TO INVESTIGATE — tooling that exists

**Reach for these before booking device time.** LaMat runs the devices; a manual
round costs him minutes and can only answer one question, so make the logs
self-sufficient.

- **`envFp`** — envelope fingerprint logged on BOTH sides, giving an exact 1:1
  frame join across the two logs. **The only valid frame identity** — server
  timestamps are NOT unique (§15a). Both sides must hash the _same_ bytes (the
  inner `envelope` field); getting this wrong invalidated a whole round.
- **`[XPDUMP]` + `.agents/scripts/dr-replay.mjs <desktop.log>`** — on decrypt
  failure, dumps the exact ratchet state + sealed frame (chunked to survive
  DevTools' ~5k truncation, one dump per distinct frame). Replays a **real**
  failure offline, so you can cross-test frames against states with **zero device
  time**. This is what found §16. **Now on `diag/dm-frame-join` too**
  (§20-undecies), so the frame-join rig and offline replay run together —
  round 23 was un-replayable because they were on separate branches.
- **`[DM-diag] armed`** — startup marker on BOTH diag branches. A capture
  without it is from a stale build and is INVALID (the §5b failure). Check it
  before sending anything.
- **`.agents/scripts/dr-core-harness.mjs`** — drives the real crypto core in Node.
- **`.agents/scripts/capture-xptrace.bat`** (timestamped, never overwrites,
  hints refreshed for the current rig) and **`reset-adb.bat`** (self-elevating,
  for a wedged adb server).
- **Desktop console capture: empty text filter, log level = Warnings + Errors.**
  Both instrumentation streams are `console.warn`; this keeps transport errors and
  MessageService warnings while excluding the info/debug flood.

### The diag rig — `git debug` (READ THIS BEFORE ANY CAPTURE ROUND)

Instrumentation lives on **local, never-pushed branches**. Keep them; master
carries none of it (audited 2026-07-27, see "Log hygiene" below).

| Repo             | Rig branch            | Rebases onto |
| ---------------- | --------------------- | ------------ |
| `quorum-mobile`  | `diag/dm-frame-trace` | `master`     |
| `quorum-desktop` | `diag/dm-frame-join`  | `main`       |

**Both repos have a `git debug` alias. Run it instead of checking out by hand:**

```
git debug
```

It refuses to run on a dirty tree, fast-forwards the base branch, rebases the
rig onto it, re-applies the mobile node_modules transport patch, and prints a
BUILD CHECK proving what is actually compiled in — probe counts AND the shipped
fixes. Expected mobile output:

```
send row probe  : 1  (want 1)
send wire probe : 1  (want 1)
recv wire probe : 2  (want 2: individual+batch)
ws transport    : 1  (want 1, index.native.js is what Metro loads)
sent_accept fix : 2  (want >=1)
ratchet mutex   : 2  (want >=1)
send-state pick : 3  (want >=1)
```

Any line short of its `want` means **do not capture** — the build is wrong.
Mobile's script is `.agents/scripts/git-debug.sh` (edit `DIAG_BRANCH` there if
the rig ever moves).

> ⚠️ **Do NOT pin rig SHAs in this document.** `git debug` rebases, so any SHA
> written here is stale the next time it runs. This is not hypothetical: §27.1
> exists because a round was captured from `99a6a23` when `049f9ef` was
> current, and it faked 21 losses. The branch NAME plus the BUILD CHECK output
> is the durable reference; SHAs in PART II are historical records of what ran
> in that round, not instructions.

The transport patch is the fragile part: `node_modules` is not tracked, so any
`yarn install` silently disarms it (this invalidated round 25). `git debug`
re-applies it every run, but still confirm `[WS-diag] transport patch armed`
in the logcat alongside `[DM-diag] armed` — **no marker, no round.**

Both directions join by `envFp` (send AND recv twins on both sides). See
§20-undecies + §21 for rig contents.

**Superseded rigs** (kept for reference; do not capture from them):
`quorum-mobile` `test/dm-instrumented-v2`, `test/dm-fix-instrumented`,
`debug/dm-cross-platform-trace`, `debug/transport-trace`,
`fix/dm-session-confirm`; `quorum-desktop` `test/dm-fix-instrumented` and
`debug/dm-cross-platform-trace`. The one thing they hold that the current rig
does **not** is `[XPTRACE] DROP-deviceInbox` / `DROP-convInbox` — receive-side
_why-did-decrypt-fail_ probes (ratchet root-key fingerprint + chain lengths per
candidate state). The current rig logs frame _arrival_, not drop _reason_. They
were deliberately not folded in: the investigation moved to node-side write
loss, where frames never arrive at all, so those probes would not fire — and
the current rig is validated (corrected in round 28) whereas they are not. If a
future round needs drop reasons, port them from `test/dm-instrumented-v2`
(the drop site still exists on master, `if (!decryptedText)` in
`context/WebSocketContext.tsx`).

### Log hygiene — master vs rig

Audited 2026-07-27: **no rig instrumentation has leaked to `master`.** No diag
branch is an ancestor of master, and master contains zero occurrences of
`XPTRACE`, `WSTRACE`, `DM-recv wire`, `DM-send wire`, `DM-send row`, `rig=` or
the armed marker. Keep it that way — rig probes stay on the rig branch.

What master legitimately keeps is anomaly reporting, not tracing:
`logger.warn` only where a genuinely unexpected condition would otherwise be
silent (unsigned accept not recorded, device skipped for a missing ephemeral
key or unusable `sendingInbox`, confirmed-envelope signing degraded), plus
`logger.debug` send-lifecycle lines. Both are safe to keep: the shared logger
(`quorum-shared/src/utils/logger.ts`) no-ops entirely when `__DEV__` is false,
and its default `minLevel: 'log'` filters `debug` out even in dev. Nothing here
reaches a production build.

> **Teardown when closed:** delete the `[XPDUMP]` logs in `$QM_CAPTURE_DIR/` —
> they contain **real key material**. The branches are harmless.

---

## §E. RETRACTED — claims we argued confidently and got wrong

**Read this before trusting anything in PART II.** Each was evidence-backed at the
time. The archive still contains the original persuasive prose.

| Claim                                                                                                                                                                  | Where argued           | Why it was wrong                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The two sides are on different sessions"                                                                                                                              | §12c                   | DH fingerprints proved correct pairing (§13a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Root-key non-overlap indicates divergence                                                                                                                              | §11, §12c              | A healthy session also shows disjoint roots (§13a).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| "Delete-on-failure is refuted as a cause"                                                                                                                              | §12b                   | The harness test was **mis-specified** — it dropped frames _before_ arrival and left them retriable, never modelling the deletion. The hypothesis was right; §16 proved it with real frames.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| "8 of 15 failures were benign duplicates"                                                                                                                              | §14c                   | Built on frame timestamps being unique. They are not (§15a). Earlier "all fresh" readings were closer to the truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `invalid initialization envelope` caused by the staleness-guard hole                                                                                                   | §20-quater             | Actually the missing accept (§20-sexies). The age-bound fix (#255) is still valid on its own merits, but it was not causing those errors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| "The server never accepted those writes"                                                                                                                               | §20-septies            | Retracted by §20-octies — frames do arrive and the retry recovers them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| mobile↔mobile "recovery CONVERGES", catastrophic form does not apply                                                                                                   | §20a.2                 | Predates §20-quinquies and §20-sexies. The accept deadlock applies in full with no desktop involved. **Assume broken.** _(Itself later corrected AGAIN by §20-octies-bis: mobile's receiver dispatches on frame shape, so mobile↔mobile churned, it did not deadlock — "converges" survives with new reasoning. Still untested.)_                                                                                                                                                                                                                                                                                                                                       |
| Round 23: "desktop persistently UNCONFIRMED; mobile kept sending the one shape desktop cannot accept; the L2949 `sentAccept` write is the prime suspect — do it first" | §20-nonies, §20-decies | The round-23 desktop log (`localhost-1784998468215.log`) contains **ZERO `invalid initialization envelope` errors and zero Confirm-branch activity** — desktop was confirmed the whole time and never rejected a plain frame. Its 18 failures are 4 distinct FRESH frames failing AEAD on the CONFIRMED branch (ratchet divergence, §11/§13b family). The heal's "hundreds of firings" fired on the raw `inbox_public_key` field before unseal/decrypt/staleness — consistent with the redelivered stale-frame flood (5-day-old backlog visible in the same log), not with live desktop traffic. §20-undecies has the full re-read. L2949 is demoted to cleanup (§C.5). |

| "desktop↔desktop has no issues; only pairings involving mobile break" | §A | **Falsified 2026-07-26**: d↔d reproduced 0/10 both directions, frames arriving and failing AEAD. It was a control assumption, never an instrumented measurement — d↔d had never been captured with the full rig. See `quorum-desktop/.agents/tasks/transport/2026-07-26-dm-desktop-to-desktop-resurfaced.md`. |
| A capture window is a measurement of loss | throughout | **No.** A capture stopped while frames are in flight scores them as LOST. A "5-frame loss" on 2026-07-26 was pure truncation — every frame arrived after the log was saved. Wait 2-3 min before saving, and treat loss counts from short windows as upper bounds. |
| Round 28: "B→A lost 21 of 24 frames; mobile↔mobile is catastrophically worse than any desktop pairing" | §27.1 | The **rig** was incomplete, not the link. `[DM-recv wire]` existed only on the individual decrypt path, so every batch-decrypted DM was invisible and scored as lost. LaMat's device observation (1 loss, not 21) was correct. Fixed in §27.1; round 29 re-measured at 32%/~0%. |

**The meta-lesson, worth more than any single finding:** every wrong turn here
came from a hypothesis that _explained the evidence_ but was never tested against
running code. The ones that survived were tested — struct extraction from
binaries, the Node harness, offline frame replay. When a theory can be checked
offline, check it before spending LaMat's device time.

**The §27 corollary — instrumentation is a hypothesis too.** Round 28 produced a
confident, precise, entirely wrong 21-frame loss claim because the rig only
logged one of two decrypt paths. Absence of a log line is _not_ evidence of
absence of a frame until you have checked that the log line covers every path
the frame can take. **When the device contradicts the rig, suspect the rig
first** — the user watching the screen is ground truth, the instrumentation is a
derived measurement.

---

# PART II — ARCHIVE (chronological, NOT kept current)

> Everything below is the investigation as it happened, rounds 1-22. It is
> preserved as primary evidence, including the mistakes. **Check §E before acting
> on any conclusion here.**

## §0. Original orientation (2026-07-24) — HISTORICAL; PART I supersedes this

**State of the world (2026-07-24 end of day).** Two PRs shipped and squash-merged to
quorum-mobile master:

- **PR #176** (`5cef7e0`): in-memory cache for SecureStore keys + 5-min TTL cache for
  `fetchUserRegistration`. Send latency dropped ~10s → ~3s.
- **PR #177** (`c1eb1cb`): the session-tag fix. Mobile now (a) stores the SDK session tag
  (= sender's device inbox) and the full return-inbox key set on recipient sessions
  (send-ready at birth), (b) emits SDK-standard tags in its init envelopes, (c) SIGNS
  confirmed-session envelopes with the conversation-inbox key, (d) subscribes/push-registers/
  recognizes ALL of its session inboxes (per-address keypair store), (e) bounds retries on
  undecryptable frames. Live-verified: sessions confirm (~16s, via the peer's receipt),
  confirmed sends skip X3DH, survive restarts.

**What was deliberately NOT done:**

- The desktop-parity **ghost prune** (deletes rows whose tag matches no registered device) —
  dropped after code review; see the task file. Do not re-add it casually.
- **Attempt 1** (branch `fix/dm-session-confirm`, abandoned, unmerged): rewrote the unconfirmed
  re-send as desktop's ForceSenderInit (reuse session + stored ephemeral). It broke
  deliverability — advanced-state envelopes to DEVICE inboxes are undecryptable for receivers
  that can't track the session — and fed a retry loop. **Do not repeat this.** The SDK model
  works because ForceSenderInit frames go to the peer's per-session conversation inbox where a
  live session row exists; mobile's unconfirmed rows target device inboxes.

**Architecture caution (from LaMat):** quorum-mobile was written by the Lead Dev; differences
from desktop are not automatically bugs. The authoritative protocol reference is the shared SDK
(`quorum-desktop/node_modules/@quilibrium/quilibrium-js-sdk-channels/src/channel/channel.ts` —
read `NewDoubleRatchetSenderSession`, `NewDoubleRatchetRecipientSession`,
`DoubleRatchetInboxEncrypt[ForceSenderInit]`, `ConfirmDoubleRatchetSenderSession`,
`DoubleRatchetInboxDecrypt`). Require behavioral evidence before changing architecture; when
ambiguous, write a question for the Lead Dev instead of guessing.

**Working with LaMat during live testing:** he runs the devices; go ONE step at a time, tell him
exactly what to do and what you expect to see, and wait for his observation before the next
step. Do not declare anything fixed off a single success — this bug is NONDETERMINISTIC.

## §1. The bug

After PR #177 unblocked mobile's receive path, desktop's frames reach the phone and pass the
echo gate, but SOME fail the inner Double-Ratchet decrypt against EVERY stored state row of the
conversation:

```
[RX-VERIFY] DM frame inbox=QmYJsKLWaj9g device=false ourConvInbox=true init=true dr=false
[RX-VERIFY] trial-decrypt FAILED on 16 state(s), dropping frame ts=1784901349601
```

- Nondeterministic: desktop message #1 rendered; message #2 and several receipts never
  decrypted (permanently lost — content unrecoverable).
- Because receipts are among the failing frames, mobile's sent messages show no ticks.
- The unseal layer succeeds (envelope opens); it's the DR layer that has no matching state ⇒
  desktop encrypted with a ratchet state mobile has no counterpart for: a fork, or desktop
  selecting a stale session row.

## §2. Evidence collected 2026-07-24

- Test pairing: mobile = `QmQuCGpEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imXST1`, desktop = `QmYVto…`.
  Both are shared multi-client test accounts (each ~3-5 registered devices: dev mobile, second
  phone, browser profiles, preview build). During part of the day a SECOND desktop instance was
  logged into the MOBILE account — its receipts/messages were correctly received and filed by
  the new code, but cross-client state clobbering during that window is a candidate confounder.
- Mobile's encryption store was wiped clean at 15:27 (134MB → 4KB), so the failing states were
  all created FRESH by post-fix code — this is not legacy debris.
- Timeline of the observed failure: fresh sessions 15:27 → confirm 15:28:18 → confirmed sends
  OK → desktop frames from ~15:55 onward failed trial-decrypt on all rows.

## §3. NEW datapoint (evening): manual reset restores delivery

LaMat: messages desktop→mobile stopped landing again; after "reset encryption session" in the
conversation settings, they started landing again. This is the classic pre-2026-07-17 desktop
pattern ("reset works, then dies") and strongly suggests the states DIVERGE OVER TIME during
normal traffic — not a one-off from today's churn. Prime suspects, in order:

1. **Desktop-side unserialized/forked state under receipt load** — the desktop master report's
   mechanism 2; its mutex may not cover a path that mobile's new traffic pattern (signed
   confirmed sends + receipts to per-session inboxes) now exercises.
2. **Desktop selecting a stale session row** for mobile among several (its rows for mobile's
   OLD conversation-inbox tags vs new device-inbox tags — mixed-tag transition).
3. **Mobile-side fork** in the confirmed-send or receive save path (less likely — mobile
   serializes via ratchetMutex and saves inside the lock, but not disproven).

## §4. Investigation plan (do this, in order)

1. **Two clients only** (one desktop QmYVto, one mobile QmQuCG). Confirm no other client is
   logged into either account.
2. **Instrument BOTH sides before any test:**
   - _Desktop:_ open browser devtools console. Desktop already logs loudly on session events
     (`[MessageService]` warns). Add temporary warn logs in `submitMessage`'s DM branch
     (quorum-desktop/src/services/MessageService.ts ~L3069-3186): which state row was selected
     per target inbox (tag, inboxId, `sending_inbox.inbox_address`, sent_accept, and
     `JSON.parse(state).ratchet_state` chain lengths), and which branch ran
     (InboxEncrypt / ForceSenderInit / NewSenderSession). Desktop's debug kit:
     `quorum-desktop/.agents/tools/dm-debug/` (console snippets incl. encryption-states diff).
   - _Mobile:_ logcat capture: `adb logcat -v time ReactNativeJS:V *:S > file` (console.warn
     reaches logcat in dev builds; logger.debug does NOT). Re-add receive probes by reverting
     the probe-strip in PR #177's history, or re-insert warn logs at the echo gate /
     trial-decrypt / init-session outcomes in context/WebSocketContext.tsx (~L2680-3050).
     MMKV ground truth: `adb exec-out run-as com.quilibrium.quorummobile.debug cat
files/mmkv/quorum-encryption > dump.bin`, then extract printable runs with Python regex
     (rows are JSON with conversationId/inboxId/tag/sendingInbox/timestamp fields).
3. **Reproduce:** mobile→desktop one message; desktop reply; repeat until a desktop frame fails
   on mobile (nondeterministic — may need bursts, receipts amplify). On each failure, capture
   BOTH sides: desktop's selected row + branch for that send, and mobile's stored rows for the
   arrival inbox.
4. **Diff the states:** does desktop's selected row correspond to ANY mobile row (match by
   receiving_inbox/tag)? If desktop picked a row mobile never had → stale-row selection
   (fix desktop's row selection or complete the tag transition). If the rows correspond but
   ratchet positions diverged → fork (find the unserialized write; check both sides' save
   ordering around receipts).
5. **Useful tools already in the repo:** `.agents/scripts/clear-dm-encryption-state.sh`
   (mobile store wipe, debug builds only, ADB_SERIAL selects device).

## §5. Mitigations already in place

- Mobile bounds retries on undecryptable frames (PR #177) — no infinite redelivery loops.
- Manual "reset encryption session" recovers the pairing (proven again this evening).
- The long-term protocol answer for residual loss is delivery-receipt-driven resend
  (`quorum-desktop/.agents/tasks/transport/2026-07-17-dm-dead-session-autoheal.md`) — a message that
  fails decrypt is otherwise gone forever because desktop deletes undecryptable frames.

## §5b. Round-1 live attempt (2026-07-25) — direction FLIPPED, desktop not armed

LaMat ran 7 desktop→mobile + 7 mobile→desktop:

- **desktop→mobile: 7/7 landed** (the direction the title describes did not fail this run).
- **mobile→desktop: first 2 landed, then 5 messages + all receipts lost.** Classic
  "works then dies", but on the mobile→desktop leg. The bug is BIDIRECTIONAL and
  nondeterministic — do not assume a direction when investigating.
- **Zero [XPTRACE] logs on desktop** despite 7 sends that should have hit the
  instrumented text path ⇒ the running desktop app was NOT executing branch code
  (stale build / not restarted). Round-2 instrumentation adds an unmissable
  `[XPTRACE] armed` startup marker on BOTH sides — if you don't see it, the capture
  is invalid; fix that before testing.

Desktop-side suspects for mobile→desktop loss (all now instrumented):

- the historic **D3a bare catch** in the init-envelope path (any error silently
  deletes the frame — zero console output),
- the **staleness guard** refusing mobile's init-wrapped re-sends (was logger.debug),
- **RX-NOSTATE** (mobile targeting an inbox desktop doesn't hold),
- decrypt failures in Confirm / InboxDecrypt (already logged at error, now with
  row fingerprints).
  Mobile-side: **SEND-SKIP** sites (silent `continue` in the fan-out) would mean the
  frame was never sent at all — also now logged. A logged mobile SEND fires inside
  the outbound drain, i.e. the frame was really handed to an open socket.

## §6. Round-2 instrumentation READY (2026-07-25) — branches + capture protocol

**Bidirectional**: every DM send site and every receive outcome is logged on BOTH
platforms, with the same non-reversible fingerprint (`rootFp` = FNV-1a of
root_key — never key material; `sLen`/`rLen` = chain lengths; `tag`/`inboxId`/
`send` = truncated addresses). **Pure-additive logging, no behavior change.**
Debug branches only — never merge:

- **Desktop:** branch `debug/dm-cross-platform-trace`, commit `8dedcbb29`
  (`src/services/MessageService.ts`).
- **Mobile:** branch `debug/dm-cross-platform-trace`, commit `f5d031f`
  (`context/WebSocketContext.tsx` + `hooks/chat/useSendDirectMessage.ts`).

### Event catalogue

| Event                                                                                           | Side    | Meaning                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `armed` / `armed (desktop MessageService)`                                                      | both    | The RUNNING code is instrumented. **No armed marker at startup ⇒ stale build, capture invalid.**                                                                                                          |
| `SEND {site, tgt, branch/row, kind}`                                                            | both    | A frame was encrypted for target inbox `tgt`. Desktop sites: text/edit/ctl/retry; mobile sites: init-first/init-unconf/confirmed/fan-new/fan-reinit/fan-conf. Mobile SEND fires at actual socket handoff. |
| `SEND-SKIP {site, tgt}`                                                                         | mobile  | Fan-out silently skipped a target — the frame was NEVER sent (different failure class than undecryptable).                                                                                                |
| `PRUNE {row}`                                                                                   | desktop | A session row was deleted pre-send (prune→NewSenderSession right after = prune-induced fork suspect).                                                                                                     |
| `RX {arrival, branch, row}`                                                                     | desktop | Session-inbox frame entering decrypt, with the pre-decrypt row.                                                                                                                                           |
| `RX-OK {row/arrival}`                                                                           | both    | Successful decrypt; row is the post-advance state.                                                                                                                                                        |
| `RX-FAIL {branch, err, row}`                                                                    | desktop | Decrypt threw; frame skipped, session kept.                                                                                                                                                               |
| `RX-INIT / RX-INIT-INSTALLED / RX-INIT-STALE / RX-INIT-FAIL`                                    | both\*  | Init-envelope path: arrival / session replaced / staleness-guard refusal / the historic D3a silent-delete catch (desktop).                                                                                |
| `DROP-*` (`convInbox`, `deviceInbox`, `noEncState`, `unseal`, `noMapping`, `final`, `initNull`) | mobile  | Every silent receive drop, with stored-row fingerprints where available.                                                                                                                                  |
| `RX-NOSTATE {arrival}`                                                                          | desktop | Frame for an inbox desktop has no state for (dropped unread).                                                                                                                                             |

**Join key:** sender's `SEND.tgt` (or `row.send`) == receiver's `arrival`. Then
compare `rootFp`/`sLen` between the sender's row and the receiver's rows.

### Capture protocol (LaMat runs the devices)

1. **Two clients only** (no second desktop on either account).
2. **Desktop:** fully quit and relaunch the app from the branch (hot reload is
   not enough — MessageService survives it). DevTools console, filter `XPTRACE`.
   **Confirm `[XPTRACE] armed` appears at startup before testing.**
3. **Mobile:** Metro from the branch, reload the app. Start capture:
   `adb logcat -c` then
   `adb logcat -v time ReactNativeJS:V *:S > $QM_CAPTURE_DIR/xptrace-mobile.log`.
   **Confirm two armed lines (mobile rx + mobile tx) appear in the log.**
4. **Reproduce both directions** in bursts with receipts on, until either
   direction loses a message/tick. Note wall-clock time of first failure.
5. Hand back both logs (console export + logcat file).

### Reading the diff

- Receiver has **no `RX*`/`DROP*` at all** for a sender's `SEND.tgt` → frame lost
  in transit or receiver not subscribed to that inbox (or sender `SEND-SKIP`ed).
- `RX-NOSTATE` / `DROP-noEncState` / `DROP-noMapping` → sender targets an inbox
  the receiver doesn't hold → stale-row selection / tag-transition gap.
- `RX-FAIL` / `DROP-final` with matching row but different `rootFp` or jumped
  `sLen` → ratchet fork; look for the preceding unserialized write (a
  `PRUNE`+`NewSenderSession` pair, or `fan-reinit` on mobile, just before).
- `RX-INIT-STALE` on live traffic → the staleness guard is eating legitimate
  re-inits (timestamp-unit or clock-skew bug).
- `RX-INIT-FAIL` → the D3a catch is eating mobile's init frames (the silent
  killer candidate for "first 2 landed, next 5 vanished").

**Teardown when done:** delete both `debug/dm-cross-platform-trace` branches —
diagnostic-only, none of it ships.

## §7. Round-2 capture FINDINGS (2026-07-25) — armed on both sides, partial logs

Test: 7 desktop→mobile (7/7 landed), 7 mobile→desktop (3/7 landed, receipts dead).
Desktop console pasted (truncated); logcat file came out EMPTY (redirect failed),
mobile log manually copied (partial). Round 3 fixes both (see below).

**Identity map (this pairing):**

- Desktop device inbox `QmccZfeHAWf5`; desktop's row for the dev phone:
  tag `QmTCcmbzP6oP`, recv `QmXGSZak1bsU`, send `QmNofrMKNtUV` (CONFIRMED).
- Mobile's mirror row: tag `QmccZfeHAWf5`, inboxId `QmNofrMKNtUV`,
  send `QmXGSZak1bsU`, acc:true. This one confirmed session carries ALL real
  dev-phone↔desktop traffic.

**Proven findings:**

1. **Ghost-device init storm (the dominant pathology).** The two accounts'
   registrations contain ~5 dead device inboxes (`QmYTED4BqsiL`, `QmZBRDjrJg4X`,
   `QmdvayLztsFL`, `QmPYQwYNUna9`, `QmfXtZttnfaq`). Mobile's fan-out does a
   **fresh X3DH (`fan-reinit`) to every ghost on EVERY send** — every text,
   typing event, and receipt spawns 5 new one-shot sessions (new rootFp each,
   sLen1/rLen0, never confirmed). Desktop symmetrically `ForceSenderInit`s into
   4 ghosts with sLen 231–249 (hundreds of unconfirmed sends). Consequences:
   mobile holds **19 states for ONE conversation** (12 sharing ghost tag
   QmPYQwYNUna9) and every incoming ghost reply produces a `DROP-convInbox
tried:19` wall — this is the original report's "16 states" symptom.
2. **Mobile fan-reinit storage collision:** all 5 ghost rows are saved with the
   SAME `inboxId` (the shared return conv inbox, e.g. `QmTj2tsN5t5h`), and the
   store keys rows by (conversationId, inboxId) → the 5 rows overwrite each
   other, last writer wins. Real bug, currently only hits ghost rows.
3. **Desktop's prune deletes live-but-unregistered devices' sessions.** Frames
   tagged `QmYBwXDRKaNs` (round 1) and `QmWUwfdB3ECg` (round 2) arrived at
   desktop during the tests; desktop installed sessions for them, then its
   text-send PRUNE deleted them (tag not in the registration list).
   Install→prune→reinstall churn every message. LaMat is certain NO third device
   was open — see the corrected interpretation below.
4. **On the one real confirmed session**, both sides advanced linearly in the
   visible window (incl. one legitimate DH ratchet: mobile rootFp 65326ad0 →
   de71f13a, chains reset — root changing over time is NORMAL); but desktop shows
   repeated `RX-FAIL` AEAD on that inbox with its row stuck at rLen6.
   Indistinguishable (without frame ts) between harmless redelivered duplicates
   and the actual 4 lost texts. **This is the ONE remaining question.**

### §7b. ROOT-CAUSE HYPOTHESIS (2026-07-25, evening) — device-identity rotation + registration ghost accumulation

LaMat confirmed NO third device was open during either round. Then the round-1 tag
(`QmYBwXDRKaNs`) and round-2 tag (`QmWUwfdB3ECg`) are **the dev phone itself,
under two different device identities** — the local device keyset ROTATED
between the two test rounds. Code audit confirms the mechanism exists:

1. **Silent keyset regeneration.** `AuthContext.tsx` ~L260: on startup, if
   `getDeviceKeyset()` returns null, it calls `initializeEncryptionKeys()`.
   That function (`keyService.ts` ~L527) regenerates the ENTIRE keyset —
   including a brand-new device inbox address — if ANY ONE of the five
   SecureStore items reads as missing. SecureStore on the Android emulator is
   known-flaky across restarts ⇒ a single transient null read mints a whole new
   device identity. All failure paths are `logger.debug` (invisible in logcat).
2. **Ghost accumulation by design.** `uploadUserRegistration` (`keyService.ts`
   ~L708-737) MERGES: fetches the existing registration, keeps every old device
   entry, appends the new keyset. Nothing ever removes a dead entry. Every
   regeneration permanently adds one ghost device to the account. The ~5 ghosts
   per account are past incarnations of the same two physical clients.
3. **When the post-regeneration upload fails** (silent), the phone's CURRENT
   identity is missing from the server registration ⇒ desktop's
   registration-sourced prune deletes every session tagged with it (captured
   live: PRUNE of tags Y and W) ⇒ current-identity sessions never survive long
   enough to confirm ⇒ init-envelope treadmill.
4. Everything in §7.1/§7.2 follows: fan-out sprays fresh X3DH into the ghost
   list on every send, 19 states accumulate, ghost replies produce DROP walls,
   and real traffic nondeterministically rides rows that desktop keeps pruning.

**Live proof pending (round 3):** mobile now logs `TX-CTX {me}` (its current
device inbox) on every send. If `me` differs across app restarts, rotation is
proven; `me` vs the registration list separates mechanism 1 from 3.

**Fix directions (Lead Dev call — his architecture):**

- Never regenerate silently: if SecureStore partially fails, retry/alert;
  regenerating a device identity should be loud and re-register atomically.
- Registration hygiene: prune own dead device entries on upload (or cap/expire).
- Desktop prune vs unregistered-live-devices tension (the deferred ghost-prune
  task) becomes moot once identities stop rotating, but the prune's
  delete-then-blackhole behavior on a MISSING registration entry is still
  worth revisiting.

**Round-3 instrumentation (committed, amended into the same branch commits):**
every xp log now carries `t` (wall clock, aligns the two logs) and receive
events carry `ts` (the frame's server timestamp — same ts failing repeatedly =
duplicate redelivery noise; distinct fresh ts failing = the real loss).
Capture script: `.agents/scripts/capture-xptrace.bat` (one click; writes a
TIMESTAMPED `$QM_CAPTURE_DIR/xptrace-mobile-<stamp>.log` per run and never
overwrites an earlier capture — it used to clobber a single fixed filename).

**Round-3 protocol:** (1) power OFF / log out the third device (tag
QmWUwfdB3ECg — second phone/preview build), (2) run the .bat, reload app,
verify armed lines, (3) short burst both directions till a loss, (4) desktop
console: right-click → "Save as…" (full export, not paste), plus the .log file.

**Fix candidates already visible (pending lead-dev routing, do NOT ship from
this debug branch):** stop fresh-X3DH-per-message to never-confirming devices
(backoff or registration-freshness gate); fix the fan-reinit (conv,inboxId) key
collision; reconcile desktop's registration-sourced prune with live-but-
unregistered devices (the deferred ghost-prune task, now with live evidence).

## §8. Round-4 capture (2026-07-25 later) — the loss localized to ratchet-epoch boundaries

Test: desktop→mobile 5/5, mobile→desktop 2/5. Full logcat captured
(archived as `$QM_CAPTURE_DIR/xptrace-mobile-round4-2026-07-25.log`, 206 XPTRACE
lines — this is the evidence §8 rests on, keep it); desktop console pasted
(truncated again — full "Save as" export still outstanding).

**Facts established:**

1. **`TX-CTX me = QmTCcmbzP6oP`** — mobile ran under its REGISTERED identity all
   session (a Metro reload did NOT rotate it). The §7b rotation hypothesis is
   NOT confirmed for reloads; yesterday's Y/W tags may have been the second
   phone (on yesterday, off today) or a rarer rotation. Kill+full-restart test
   still pending but deprioritized. The registration-merge ghost accumulation
   (§7b.2) remains a code-verified fact regardless of which mechanism minted
   the ghosts.
2. **The 10 immortal redelivery mines are confirmed self-sustaining:** the SAME
   init envelopes (identical envTs, tags Y+W) redelivered ~20h later at desktop
   startup, reinstalled again, pruned again. The prune DEFEATS the staleness
   guard: the guard compares an incoming init envelope against existing rows;
   the prune deletes those rows; the replay then looks fresh and reinstalls.
   Prune ↔ redelivery is a closed loop needing no live sender.
3. **Mobile's send ledger on the real session is perfectly linear** — 5 posts
   across three ratchet epochs (rootFp de71f13a → e0befcbf → a71d2c51, sLen
   monotonic within each). No forks, no regressions on mobile TX.
4. **ALL 23 mobile-side drops were on the REAL session inbox (QmNofrMKNtUV)**,
   not ghost inboxes — and per the new `ts` field they were **7 DISTINCT FRESH
   desktop frames** (all ts inside the capture window; each retried 1-5× then
   poisoned by the bounded-retry list). So: 7 fresh desktop frames died at
   mobile, 3 fresh mobile posts died at desktop, on a session that was
   simultaneously delivering other frames fine in BOTH directions.
5. Both sides DH-ratcheted every few seconds (3 epochs in ~90s) — typing +
   receipts churn the ratchet constantly.

**Working hypothesis (sharp, testable in CODE, no more device runs needed):**
frames are orphaned at **DH-ratchet epoch boundaries**. In Double Ratchet,
frames from the previous sending chain that are still in flight when the
receiver ratchets must be recovered via `previous_chain_length` + skipped-key
storage. Desktop uses the JS SDK (`channel.ts`); mobile uses its own NATIVE
DR implementation (`cryptoProvider.doubleRatchetDecrypt/Encrypt`). If the two
implementations disagree on `previous_*_chain_length` semantics or skipped-key
bookkeeping, late frames from the pre-ratchet chain fail AEAD on both ends —
exactly the observed signature (partial, bidirectional, worse under receipt/
typing churn, "reset fixes it" because reset re-syncs epochs).

**Next action: side-by-side code audit** of mobile's native DR (previous-chain
handling, skipped_keys_map, header-key rotation) vs SDK `channel.ts`
`DoubleRatchetEncrypt/Decrypt`. Secondary: get one full desktop console export
("Save as") to pair frame-level ts against mobile's ledger.

## §9. Code audit + past-week commit review (2026-07-25)

**DR implementation comparison (§8 next-action) — result:**

- Desktop SDK's `DoubleRatchetEncrypt/Decrypt` call `ch.js_double_ratchet_*` — a
  WASM build of the Rust `channel` crate. Mobile's `cryptoProvider.doubleRatchet*`
  goes through UniFFI bindings to the SAME Rust crate
  (`modules/quorum-crypto/android/.../uniffi/channel/channel.kt`, prebuilt .so in
  `jniLibs/`). **Both platforms share one Rust core; a core ratchet-math
  divergence is unlikely.** Residual risks: (a) version skew between mobile's
  bundled .so and the SDK wasm (mobile module v0.1.0 metadata vs SDK 2.1.1 —
  opaque, needs Lead Dev confirmation), and (b) the wrapper layer:
- **Wrapper hazard found:** `services/crypto/encryption-service.ts` has FIVE
  sites doing blanket unescape (`\" → "`, `\\ → \`) on envelope/state strings
  behind an `includes('\\')` heuristic (L298, 554, 772, 860, 972). Ratchet
  states/envelopes are nested JSON-in-JSON where `\"` is LEGITIMATE — a blanket
  unescape corrupts exactly the payloads that carry skipped-keys/prev-chain
  data. Strong candidate for the epoch-boundary losses; needs a targeted test
  (round-trip a state containing nested escapes through each site).

**Past-week commit review (mobile #164-#177, desktop #246-#251) — verdict: no
outright breakage found; the week's fixes demonstrably improved behavior**
(sessions now stay confirmed across ratchets — `acc:true` stable in round-4;
sends linear; identity stable; retries bounded). Two structural concerns:

1. **Bounded-retry poisoning (#170/#177) can convert transient out-of-order
   into permanent loss:** a frame arriving BEFORE the frame that would advance
   the receiver into its epoch fails decrypt, gets retried ~5× within ~a
   minute, then poisoned — even though it might decrypt once the epoch frame
   lands. Round-4 drops showed 1-5 attempts then poison. Mitigation idea:
   longer poison horizon, or only poison frames older than several minutes.
2. **Receipts + typing (#164) multiplied ratchet churn** (3 DH epochs in ~90s
   in round 4). Not a defect, but it amplifies any epoch-boundary weakness —
   explains why loss got MORE visible as the receipt work landed.

Note: desktop already has `9341bf498 docs: add device-registration
ghost-accumulation plan` — the ghost problem (§7b.2) has a desktop-side plan
file; align with it rather than inventing a new one.

## §10. Round-5 — device-free lab work (2026-07-25): crypto core EXONERATED, defects found in the state-persistence layer

No devices used. Two open hypotheses (§8 epoch-boundary divergence, §9 wrapper
unescape) were tested directly and **both are refuted**; the investigation moves
down to how mobile PERSISTS ratchet state.

### §10a. Method — running the real crypto core in Node

The SDK ships the compiled core (`quilibrium-js-sdk-channels/src/wasm/channelwasm_bg.wasm`)
plus its wasm-bindgen glue, so it can be driven straight from Node. Harness kept at
**`.agents/scripts/dr-core-harness.mjs`** (`node .agents/scripts/dr-core-harness.mjs`;
needs the SDK repo as a sibling checkout, or `SDK_DIR=…`). It builds a real
X3DH-established DR pair and exercises the ratchet. **Reach for this before booking
a device session.** Gotchas for whoever extends it:
device identity/pre/ephemeral keys are all **x448** (`NewDeviceKeyset` uses
`js_generate_x448`; ed448 is only for inbox signing keys), keygen returns
`number[]` (not base64), and the X3DH result IS base64.

### §10b. §8 hypothesis (DH-epoch divergence) — REFUTED, twice over

1. **Static:** both platforms link the same Rust `channel` crate. Extracting serde
   struct descriptors from the SDK wasm and from mobile's
   `jniLibs/arm64-v8a/libchannel.so` gives **identical arity for every shared
   wire/state struct** — `DoubleRatchetParticipantJson: 14`,
   `P2PChannelEnvelopeJson: 3`, `MessageCiphertextJson: 3`, `PeerInfoJson: 3`,
   `SealedInboxMessage{Encrypt,Decrypt}Request: 3`, `TripleRatchetParticipantJson: 24`.
   **Zero structs exist only in the .so.** The wasm-only extras
   (`DoubleRatchetStateAndEnvelope`, `NewDoubleRatchetParameters`, `SenderX3DH`, …)
   are the JSON-API request wrappers, which on mobile are UniFFI records declared
   in `uniffi/channel/channel.kt` instead. **This closes §9's residual risk (a),
   version skew: there is none in the wire or state format.**
   (`libchannel.so` and `libuniffi_channel.so` are byte-identical, 1,985,664 bytes.)
2. **Empirical:** the core recovers out-of-order and cross-epoch frames correctly.
   Same-chain frames delivered 2,0,1 all decrypt (skipped-key storage works,
   `rLen` does not regress). Then, across a real DH ratchet: stragglers encrypted on
   the sender's PREVIOUS chain, delivered AFTER a post-ratchet frame, **all decrypt
   successfully**. `previous_sending_chain_length` bookkeeping is sound.

⇒ Late frames crossing an epoch boundary are NOT orphaned by the ratchet math.
The §8 "next action" (side-by-side DR audit) is **done and closed**.

### §10c. §9 wrapper hazard (blanket unescape) — REFUTED

A real envelope is `{"protocol_identifier":512,"message_header":{ciphertext,
initialization_vector,associated_data},"message_body":{…}}` — nested JSON
**objects**, all leaf values base64. Base64's alphabet contains no backslash, so a
well-formed envelope contains **zero** backslashes, and the five
`includes('\\')`-guarded unescape sites in `services/crypto/encryption-service.ts`
(L298, 554, 772, 860, 972) never fire. Verified end to end: through the init path
(`JSON.stringify` into `InitializationEnvelope` → `JSON.parse` on receipt) the
envelope round-trips byte-identical, the unescape is a no-op, and the envelope
still decrypts. The sites are dead code, not a corruption source. Worth deleting
for clarity, but **not the bug** — deprioritize.

### §10d. NEW: two proven defects in `services/crypto/encryption-state-storage.ts`

All ratchet-state writes go through a batching queue (`pendingWrites`, flushed at
100ms or 10 entries); reads consult the queue before MMKV. Two invariant breaks,
each pinned by a **currently-failing** test in
`__tests__/encryptionStateDurability.test.ts` (run: `npx jest __tests__/encryptionStateDurability.test.ts`):

1. **Deleted sessions resurrect (ACTIVE).** `deleteEncryptionState` (L231) and
   `deleteAllEncryptionStates` (L242) call `storage.remove()` but never drop the
   key from `pendingWrites`. So after a reset: `getEncryptionState` **still returns
   the deleted row** (the queue is read first), and the next flush writes it back
   to MMKV. Reachable on every "reset encryption session" — the exact recovery
   action LaMat relies on — whenever a write for that conversation is in the 100ms
   window, which receipt/typing churn makes routine. Prime suspect for
   **"reset works, then dies again quickly"** and for §8.2's immortal-row behavior.
2. **Stale queued write clobbers a newer immediate write (LATENT).**
   `saveEncryptionState(…, immediate=true)` (L210) writes straight to MMKV without
   clearing the queued entry; the flush then overwrites it with the **older** value.
   Test shows on-disk state going `ratchet-2` → `ratchet-1`, i.e. a ratchet
   REGRESSION after the frame is already on the wire. Currently unreachable —
   **no caller passes `immediate: true`** — but the parameter is documented "use
   for critical sends", so the first person to follow that advice silently corrupts
   sessions. Fix it before it is used.

### §10e. NEW: durability exposure — nothing ever flushes

`flushPendingWrites()` (L152) has **zero callers** anywhere in the app. Combined
with batching, a ratchet advance stays off-disk for ≥100ms after the frame is
transmitted, and on Android a backgrounded app's JS timers can be frozen
indefinitely — so a pending advance may never flush before the process is reaped.
The peer has consumed the frame; mobile restarts behind. This is a
persistence-layer explanation for **restart-spanning divergence** that needs no
ratchet-math bug, and it fits §8.2 (identical init envelopes still being
redelivered ~20h later). Not proven to be the round-4 loss — those failures
happened mid-session with no restart — so treat it as a real, separate exposure.
Fix: flush on `AppState` background/inactive, and after any DM ratchet advance.

### §10f. Incidental — pre-existing stale test

`__tests__/confirmSenderSession.test.ts` has 1 failing case ("confirms on success…"):
it expects `tag: "QmPeerReturnInbox"` but gets `"QmOurConversationInbox"`. That is
PR #177 deliberately preserving the row's own tag (`tag: state.tag || unsealed.tag`,
encryption-service.ts ~L587) — the test was never updated. **Stale test, not a
regression** (confirmed: it fails identically with this session's changes stashed).
Baseline before today: 49 pass / 1 fail.

### §10g. Where this leaves the investigation

Ruled out: ratchet math, cross-platform core skew, envelope escaping.
Still open: **which row mobile selects, and whether its advance survives.** The
storage layer is now the strongest suspect, alongside the already-proven §7.2
`(conversationId, inboxId)` collision — note defect 1 above and §7.2 are the same
class of bug (the store's key/lifecycle model, not the crypto).

**Next actions, in order:**

1. Fix the two §10d defects (drop the key from `pendingWrites` on delete; clear it
   on immediate write) — small, self-contained, testable; the failing tests turn green.
2. Add the lifecycle flush (§10e).
3. Re-examine §7.2's collision for whether any REAL (non-ghost) row can collide —
   this is the remaining path to mid-session loss with no restart.
4. Only then go back to devices; a full desktop console export ("Save as") is still
   outstanding for frame-level `ts` pairing.

### §10h. Fix SHIPPED to a branch (2026-07-25) — awaiting live verification

`fix/dm-state-persistence` = master + one commit `0dbb88a`
("fix: stop DM ratchet state resurrecting or regressing in the write queue"):
both §10d defects + the §10e lifecycle flush (storage now flushes itself on
`AppState !== 'active'`, so no caller has to remember). Also un-stales the §10f
`confirmSenderSession` assertion and adds the `@/` jest `moduleNameMapper`.
**Suite 50/50 green** (was 47/3); `tsc` error count unchanged at 22 pre-existing,
none in the touched files.

**Test on `test/dm-fix-instrumented`** = that fix + cherry-picked `55630d1`
(the XPTRACE instrumentation). This is the branch to BUILD and run on the phone:
it has the fix AND full tracing. Verified `armed` markers present
(`WebSocketContext.tsx:142` mobile rx, `useSendDirectMessage.ts:64` mobile tx).
Desktop needs no change — still on its own `debug/dm-cross-platform-trace`
(head `5d2bf097f`; note §6's `8dedcbb29` is stale, round-3 amended the commit).

Branches are deliberately split so the fix never sits downstream of a commit that
must never merge: merge `fix/dm-state-persistence`, delete `test/dm-fix-instrumented`.

**Expectation management:** this is NOT presumed to be the whole bug. Defect 2 is
latent and the durability gap does not explain round-4's mid-session losses (no
restart involved). Defect 1 (reset resurrection) is the only one proven to fire in
normal use. If loss persists on the instrumented build, the next suspect is §10g.3
(the §7.2 row collision) — which is why the tracing is still attached.

## §11. Round-6 (2026-07-25, 11:47-11:54) — VERDICT: mobile is clean, the loss is desktop failing to follow the peer's DH ratchet

First capture with BOTH sides armed AND the fix provably loaded
(`armed {"side":"mobile storage","fix":"state-persistence"}` at 11:51:24).
Result: **desktop→mobile 5/5, mobile→desktop 2/5.**
Logs: `$QM_CAPTURE_DIR/xptrace-mobile-20260725-114747.log` +
`$QM_CAPTURE_DIR/localhost-1784973250503.log` (round 5's pair is
`…-113320.log` + `localhost-1784972190901.log`; round 4 is
`xptrace-mobile-round4-2026-07-25.log`).

**1. Mobile is no longer losing anything.** 196 RX-OK, **zero DROP-\* events**,
across two consecutive runs (round 5: 69 RX-OK / 0 drops). Round 4 had 23 drops.
Mobile's send ledger is strictly linear within every epoch and its identity is
stable (`me = QmTCcmbzP6oP`, matching desktop's tag for it) — no rotation, no
forks, no resurrection. The §10d/§10e work is doing its job; the receive path
this bug file was opened about is behaving.

**2. Every remaining loss is desktop-side, and all of it is REAL.** 15 RX-FAIL,
and per frame `ts` **all 15 are FRESH** — not one duplicate redelivery (round 5
had 3 benign dups among 6). So 15 genuinely lost frames in ~90 seconds, against
only 4 successful decrypts.

**3. Mechanism, reproduced 4 times across 2 runs — desktop's receiving chain
freezes and cannot follow mobile's DH ratchet.** Desktop decrypts only in a
brief window immediately after ITS OWN ratchet fires, then re-freezes at a
fixed `rLen` until the next one:

| desktop ratchet | root                | window                | then                                           |
| --------------- | ------------------- | --------------------- | ---------------------------------------------- |
| 11:52:34.848    | ba9d36be → b8249587 | 1 decrypt (rLen 7)    | **7 consecutive FRESH failures**, rLen stuck 7 |
| 11:53:26.276    | b8249587 → cc7e9be6 | 3 decrypts (rLen 7→9) | **8 consecutive FRESH failures**, rLen stuck 9 |

Meanwhile mobile ratchets normally (51456667 → e260823e → 87585351) and keeps
decrypting desktop perfectly. The asymmetry is the bug: **mobile follows
desktop's ratchets; desktop does not follow mobile's.** This is exactly why
"the first desktop→mobile message always lands and later ones don't" — and why
a session reset temporarily fixes it (it re-syncs both sides into one epoch).

All failures are `branch=InboxDecrypt` with
`SyntaxError: Unexpected token 'D', "Decryption"…` — i.e. the Rust core
returned `Decryption failed:` (AEAD) and desktop's wrapper tried to `JSON.parse`
that error string. **Secondary desktop bug:** that wrapper should detect the
error rather than throw a misleading `SyntaxError` (mobile's
`parseDoubleRatchetDecryptResult` already does exactly this check).

**4. The shared crate is exonerated a second time (Q4 in the harness).** Ten
rounds of the exact observed traffic shape — post + read-ack + delivery-ack per
round, with a peer reply forcing a DH ratchet every round — gives
**40 decrypted, 0 failed**, with both roots advancing each round. The crate
handles sustained alternating ratchets correctly, so this is desktop's
DRIVER code, not the cryptography (consistent with §10b's struct-identity
finding).

**5. Ghost storm undiminished** (unchanged by any of this): 10 RX-INIT /
10 RX-INIT-INSTALLED for the dead tags `QmWUwfdB3ECg` + `QmYBwXDRKaNs`, 2 PRUNEs
of those same tags, and mobile still fan-reinits to 5 ghosts on every send
(round 5: 45 of 54 SENDs were wasted X3DH to dead devices). Independent of the
ratchet bug, but it is most of the DM traffic on the wire.

### §11a. Next actions — the investigation has moved to quorum-desktop

1. **Desktop DR receive path** (`MessageService.ts` `InboxDecrypt` branch +
   whatever persists the post-decrypt state): why does the state that results
   from desktop's own DH ratchet fail to recognize the peer's NEXT ratchet?
   Prime suspect is the receiving header-key pair (`current_receiving_header_key`
   / `next_receiving_header_key`) not being carried correctly through desktop's
   save/load, since detecting a peer ratchet requires decrypting the header with
   `next_receiving_header_key`. Note desktop's row logs `pSLen` but never a
   previous-RECEIVING length — worth logging to confirm.
2. **Fix the `JSON.parse` on the error string** so desktop reports AEAD failures
   honestly instead of `SyntaxError` (mirror mobile's result-object approach).
3. Mobile-side follow-ups are now lower priority: the §7.2 `(conversationId,
inboxId)` collision and the ghost fan-out (§7.1) — neither is causing the
   observed loss, but the fan-out is pure waste.
4. Mobile's `fix/dm-state-persistence` (`0dbb88a`) is ready to merge on its own
   merits — 50/50 tests green, two runs with zero mobile-side drops.

Reusable tooling: `.agents/scripts/dr-core-harness.mjs` now carries Q1-Q4;
add a question to it before booking device time.

## §12. Desktop fix-audit + Q5 recovery experiments (2026-07-25) — the delete-on-failure hypothesis is REFUTED

### §12a. Audit of the desktop DM fixes — all intact, no regression

Read `quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md`
(three mechanisms) + `2026-07-17-dm-aead-error-frame-drops.md`. Verified each fix
against current desktop code:

| Fix                                           | Where                                                                        | Status                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| 1. Preserve session on decrypt failure (#235) | `MessageService.ts:3756`, `3848`                                             | ✓ both catches skip frame, keep session |
| 2. Per-conversation ratchet mutex (#236/#237) | `dmRatchetMutex.runExclusive` ×6; fresh read at 3683, immediate save at 3828 | ✓ intact                                |
| 3. Stale init-envelope guard (#238)           | `isStaleInitEnvelope` wired at 3447                                          | ✓ intact                                |

14 commits touched `MessageService.ts` since 2026-07-17 (per-device signing #245/#249/#250,
DM settings sync #248, edit refactor #246, security #241-#243). **None weakened the three
fixes.** Signing operates outside the DR envelope and cannot cause `aead::Error`.
**Conclusion: the earlier work is still valuable and did not cause this.**

Two gaps remain open, both flagged on 2026-07-17 and never closed:

- **Reset bypasses the mutex.** `ConversationSettingsModal.tsx:226` calls
  `deleteEncryptionStates` directly — a reset racing an in-flight decrypt can resurrect a
  deleted row. Same defect class as mobile's §10d.1, still open on desktop.
- **Failed frames are deleted** (`deleteInboxMessages` in both catches, 3772/3864), so any
  frame that fails once is unrecoverable. Long-standing, not a regression.

### §12b. Q5 — what actually makes a DR receiver permanently stuck? (harness, device-free)

Scratch script modelling the round-6 signature. **The receiver turned out to be far more
robust than assumed — three plausible mechanisms all self-heal:**

| Scenario                                                               | Result                            |
| ---------------------------------------------------------------------- | --------------------------------- |
| S1 — receiver misses EVERY frame of an epoch, then gets the next       | **RECOVERS**                      |
| S2 — sender ratchets TWICE while receiver misses everything            | **RECOVERS**                      |
| S3 — receiver's state rolled back (lost-update fork on receive)        | **RECOVERS**, 4/4 later frames OK |
| S4 — frame that failed against a stale copy, retried on the good state | **RECOVERS**                      |

⇒ **Hypothesis B (delete-on-failure destroys the ratchet trigger) is REFUTED.** Frame loss,
epoch lag and receive-side rollback are all recoverable in the core, so none of them explains
a permanently frozen `rLen`. Deleting failed frames is still wrong (it discards data that
_would_ decrypt later, per S4) but it is **not** the cause of the freeze.

### §12c. ⚠️ SUPERSEDED BY §13 — this hypothesis was WRONG, do not act on it

Combined with §11's finding that mobile and desktop **never share a root-key fingerprint**
(mobile {51456667, 87585351, e260823e} vs desktop {b8249587, ba9d36be, cc7e9be6}, zero
overlap), and with Double Ratchet's property that both parties converge on the SAME root key
after each completed DH step, the surviving explanation is that the two sides hold
**genuinely different sessions that happen to share inbox addresses** — i.e. one side
re-created its session at some point while the other kept the old one. Nothing transient
(loss, lag, rollback) can produce a permanent freeze; a session mismatch can.

Caveat, honestly: 3 root samples per side is not proof of non-convergence, only strong
suggestion. This needs one targeted instrumentation round, NOT another blind fix.

**Next action — cheap and decisive:** add to BOTH sides' XPTRACE row fingerprint a hash of
the ratchet DH keypair (`sending_ephemeral_private_key` → public, and `receiving_ephemeral_key`).
If mobile's `receiving_ephemeral_key` ≠ desktop's current sending public (and vice versa), the
sessions are not paired, and the question becomes _where_ one side re-created it (desktop's
PRUNE → `NewSenderSession`, or mobile's `fan-reinit`). If they DO match, the divergence is
inside the root chain itself and the next suspect is state serialization on one side.

## §13. Round-7 (2026-07-25, 12:34-12:38) — DH-pairing proof. Sessions ARE paired; §12c retracted

Both sides armed with the new DH fingerprints (`dhr`/`dhs`, plus desktop `dhsPub`).
**desktop→mobile 5/5, mobile→desktop 0/5** (worst yet).
Logs: `xptrace-mobile-20260725-123416.log` + `localhost-1784975899235.log`.

### §13a. TWO OF MY OWN INFERENCES WERE WRONG — corrected here

1. **Root-key non-overlap is NORMAL, not evidence of divergence.** The Q4 harness
   run — a perfectly healthy session, 40/40 decrypts — shows alice's and bob's
   `root_key` differing at EVERY round (`aliceRoot=V3YMDWgr bobRoot=JBUG5NWb`, …).
   Each side sits at a different point of the shared root chain at any instant.
   **Never again use root-fingerprint mismatch as a divergence signal.**
2. **§12c ("the two sides are on different sessions") is REFUTED.** The DH
   fingerprints prove pairing: mobile's `dhr` (desktop's public as mobile holds it)
   and desktop's `dhsPub` (desktop's public, derived) **overlap exactly** —
   `8d6923b3` and `ae268757` both present on both sides. Mobile is correctly
   tracking desktop's ratchet keys. One session, correctly paired.

### §13b. What the DH data actually shows — desktop is chronically one ratchet behind

- **Mobile regenerated its DH keypair 3×** (`dhs`: 0da33ce2 → 5fd58cf3 → 53720c99).
- **Desktop only ever adopted 2 mobile publics** (`dhr`: 4ae9a8ff → 69fafcfd),
  and the second only at 12:37:29 — **51 seconds and 6 failed frames** after mobile
  had moved to that key at 12:36:38.
- **Desktop's `rLen` never advanced past 7 for the entire ~2-minute capture.**
  Exactly **1 successful decrypt** against 10 RX-FAILs.
- Of mobile's 5 posts: **3 failed AEAD at desktop, 2 produced no desktop `RX` at
  all** (never reached its decrypt path). Two distinct failure modes again.
- Ghost storm worse than ever: **18 RX-INIT / 16 RX-INIT-INSTALLED**, every one for
  the two dead tags `QmYBwXDRKaNs` + `QmWUwfdB3ECg`, and **each install mints a NEW
  receiving inbox** (16 new session rows in 90s). Desktop pruned only 4.
  **None touched the real session row** — verified, so the init flood is not
  clobbering it, but it is most of the traffic and it churns desktop's row table.

### §13c. The crate is now exhaustively exonerated (Q5 + skip-limit tests)

| Test                                                           | Result                                  |
| -------------------------------------------------------------- | --------------------------------------- |
| Receiver misses a whole epoch, gets the next frame             | RECOVERS                                |
| Sender ratchets twice while receiver misses everything         | RECOVERS                                |
| Receiver state rolled back (lost-update fork on receive)       | RECOVERS                                |
| Frame failed on a stale copy, retried on good state            | RECOVERS                                |
| **6 consecutive epochs** with the receiver missing every frame | **RECOVERS all 6**                      |
| Skipped-message tolerance in one chain                         | OK to 100; `Skip limit exceeded` by 500 |

Observed gaps are 1-9 messages — two orders of magnitude below the skip ceiling.
So the freeze is **not** explainable by frame loss, epoch lag, receive-state
rollback, or skip limits. The Rust core recovers from all of them.

### §13d. Where the search now stands

Established: one correctly-paired session; mobile healthy in both directions;
desktop able to ratchet (it did once) but failing on almost every frame and never
advancing its receiving chain. The crate recovers from every transient condition
we can construct, so desktop must be feeding it a state that is wrong in a way
none of the above models — i.e. the defect is in **desktop's state handling around
the decrypt**, not in the protocol or the frames.

Next candidates, in order:

1. **Instrument desktop's row COUNT and identity per decrypt.** `getEncryptionStates`
   returns every row for the conversation and the receive path picks by
   `inboxId === message.inboxAddress`. With 16 new ghost rows minted in 90s, log how
   many rows exist and whether more than one matches — a duplicate/ambiguous match
   would explain decrypting against the wrong copy.
2. **Log the state string's identity (hash) at read and at save** in the locked
   section, to prove the state that went into decrypt is the one that came out of
   the previous save — i.e. catch an overwrite between operations despite the mutex.
3. Reconcile with the fact that desktop DID succeed once at 12:37:29: whatever is
   wrong is intermittent, which fits an ordering/selection problem rather than a
   corrupted key.

Not yet worth doing: any further crypto-core testing (exhausted), and any fix
based on §12c (retracted).

## §14. Round-8 (2026-07-25, 12:52-12:58) — both probes NEGATIVE; desktop's state handling is clean

desktop→mobile 5/5, mobile→desktop 2/5. Logs: `xptrace-mobile-20260725-125234.log`

- `localhost-1784977090101.log`.

### §14a. Probe 1 (row ambiguity) — NEGATIVE

Across all 20 decrypts: `match: 1` every time, `fellBack: false` every time
(6-8 rows per conversation, exactly one matching the arrival inbox). All 20 RX
arrivals were on the real inbox `QmXGSZak1bsU`. **Duplicate/ambiguous row
selection is ruled out.**

### §14b. Probe 2 (state identity) — NEGATIVE, and it clears a whole bug class

The `stFp` chain is **unbroken**: every `RX` reads exactly the `stFp` written by
the preceding `SAVE` for that inbox, through 20 decrypts and 92 saves. Example:

```
SAVE rx-inboxdecrypt stFp=2265c179 → RX stFp=2265c179 → SAVE stFp=59d47683 → RX stFp=59d47683 …
```

**No overwrite, no stale copy, no lost update — the per-conversation mutex is
doing its job.** This definitively clears mechanism 2 of the desktop master
report (unserialized read-modify-write) AND the equivalent of mobile's §10d
concern on desktop's DM path. Do not re-investigate that class.

Incidental: desktop wrote ratchet state **86× from sends** vs **6× from
receives** (`send-encryptAndSendDm` 56, `send-submitMessage-b` 30,
`rx-inboxdecrypt` 6). Receipts/typing utterly dominate ratchet churn.

### §14c. ⚠️ MEASUREMENT CORRECTION — earlier "fresh failure" counts were INFLATED

`RX-OK` does not log the frame `ts`, so previous rounds could not dedupe failures
against _successes_ — only against other failures. With success-tracking added:

- **8 of 15 failures were duplicates of already-consumed frames** (benign
  redelivery — desktop had already decrypted them).
- **6 distinct frames genuinely lost**, against **6 decrypted**.

So the true loss rate is ~50% of delivered frames, not the near-total loss the
raw RX-FAIL counts suggested. §11/§13's "all fresh" figures should be read with
this caveat. **Fix for next round: log `ts` on `RX-OK` too.**

### §14d. The sharp remaining anomaly — same state, same chain, different outcome

With the receiver state **identical** (`stFp=f369655e`, `rLen=10`):

| Frame           | Result                                                   |
| --------------- | -------------------------------------------------------- |
| ts 12:57:07.368 | **FAIL**                                                 |
| ts 12:57:14.188 | **RX-OK** — and it triggers the DH ratchet (rLen 10 → 7) |

Correlating with mobile's ledger (chain `fcd61ea8`, indices 0-8, `sLen` strictly
monotonic so mobile's sends ARE properly serialized): desktop **failed mobile's
chain-index 0 and 2, then succeeded on index 6** — same chain, same receiver
state. Harness S1 proves index 0 _should_ have worked and triggered the ratchet.

⇒ The frames themselves differ from what a clean DR would produce, OR they are
not the bytes mobile emitted. This is now a **wire/frame-level** question, not a
state-handling one.

### §14e. Second, independent problem: frames never arrive

Of mobile's 9 sends on chain `fcd61ea8`, desktop's app only ever saw 5 (no `RX`
at all for indices 1, 3, 4, 5). All arrivals were on the correct inbox, so these
are **not misrouted — they never reached desktop**. Transport loss, separate from
the decrypt failures, and it needs its own fix (the auto-heal/resend task).

### §14f. Next probe — envelope fingerprint on both sides

Add a fingerprint of the DR envelope bytes: mobile logs `fp(envelope)` at send,
desktop logs `fp(message.encryptedContent)` at receive. That gives a **1:1 frame
join key** (replacing timestamp guessing) and separates two remaining
possibilities:

- bytes match, decrypt still fails → mobile produced a frame from a state it did
  not persist (mobile-side fork on the send path), or
- bytes differ / never appear → wire corruption or delivery loss.

Also add `ts` to `RX-OK` (see §14c) so future rounds dedupe correctly.

Ruled out so far: crypto core (§10b, §12b, §13c), envelope escaping (§10c),
desktop row selection (§14a), desktop state serialization (§14b), session
pairing (§13a).

## §15. Round-9 (2026-07-25, 13:16-13:22) — ⚠️ FRAME TIMESTAMPS ARE NOT UNIQUE; all prior duplicate-counting was unsound

desktop→mobile 5/5, mobile→desktop 1/5 (the 4th landed, not the 1st).
Logs: `xptrace-mobile-20260725-131621.log` + `localhost-1784978535073.log`.

### §15a. THE METHODOLOGICAL FINDING — retract §14c

With `envFp` (fingerprint of the sealed frame) on both sides, the real identity
of each frame is finally visible. On the real session inbox:

- **13 decrypt events, 13 DISTINCT `envFp`, ZERO true duplicates.**
- **2 timestamps were each shared by two DIFFERENT frames:**
  - `ts 13:20:39.706` → `RX-OK envFp=f76141fd` **and** `RX-FAIL envFp=88f31633`
  - `ts 13:21:35.435` → `RX-OK envFp=8ec6e184` **and** `RX-FAIL envFp=b7a21ad2`

⇒ **`message.timestamp` does NOT uniquely identify a frame.** Every earlier
round classified failures as "duplicate redelivery" by matching `ts`, which was
wrong. **§14c's correction ("8 of 15 were benign duplicates") is itself
RETRACTED** — those were most likely distinct frames that genuinely failed. The
original "all fresh" readings in §11/§13 were closer to the truth.

**Rule going forward: only `envFp` identifies a frame. Never use `ts`.**

This also has a product implication beyond diagnostics: if desktop dedupes or
tracks frames by `(inbox, timestamp)` anywhere, that logic is unsound — two live
frames really do share a timestamp.

### §15b. Real numbers for this round

**3 decrypted / 10 failed, out of 13 distinct frames delivered. No redeliveries
at all.** Desktop's `rLen` moved only 7 → 8 → 9 across the whole capture.

### §15c. Tooling fixed (both were silently broken this round)

1. **XPDUMP was truncated to nothing usable.** DevTools hard-truncates any single
   logged string at ~5k chars on export — every dump was cut at exactly 5031
   chars, so the JSON never parsed and the replay found 0 records. Desktop now
   emits each dump in 1500-char chunks (`[XPDUMP] <dump>/<idx>/<total> …`) and
   `dr-replay.mjs` reassembles them, refusing incomplete sets.
2. **Mobile's `envFp` covered only 4 of 6 send sites** — the two that carry the
   real traffic (`fan-conf`, `fan-reinit`) were missed, so the 1:1 join could not
   be built from mobile's side this round. All 6 now covered.

### §15d. Console capture settings (learned the hard way)

LaMat had been filtering the desktop console by `XPTRACE`, so `[XPDUMP]` lines were
excluded from earlier saves and all non-XPTRACE context (transport errors,
`!found` drops, MessageService warnings) has been invisible for the whole
investigation. Correct setting: **empty text filter, log level = Warnings +
Errors only** — both instrumentation streams are `console.warn`, and that
excludes the hundreds-per-minute info/debug flood.

## §16. ROOT CAUSE FOUND (2026-07-25, round 10, offline replay) — desktop DELETES frames that would decrypt seconds later

First working offline replay. 6 `[XPDUMP]` records reassembled from
`localhost-1784979212723.log`; each carries the exact ratchet-state row AND the
exact sealed frame desktop failed on, so the failure is reproducible in Node.

### §16a. The proof

Replaying each dump faithfully reproduces the live result: **unseal OK, ratchet
`aead::Error`** — so the frames really are addressed to desktop and its inbox key
opens them; only the DR layer fails.

Then, cross-multiplying every captured FRAME against every captured STATE:

| Frame (arrival)       | Decrypts against                           |
| --------------------- | ------------------------------------------ |
| #1 (13:32:08)         | **state#5 (13:32:43), state#6 (13:33:01)** |
| #2, #3, #4 (13:32:27) | **state#5, state#6**                       |
| #5 (13:32:34)         | **state#1-#4 (13:32:08-29)**               |
| #6 (13:33:01)         | none of the six                            |

**Five of the six frames desktop threw away are decryptable against a state
desktop itself held within ~35 seconds.**

And the mechanism is pinned exactly — emptying `skipped_keys_map` on the later
state makes it fail again:

```
frame#1 vs state#5:  with skipped = OK  |  skipped-map emptied = FAIL
frame#1 vs state#6:  with skipped = OK  |  skipped-map emptied = FAIL
```

State#1-#4 are root `269bce15`; state#5-#6 are root `9fa6d6fd` with one more
skipped entry (22 → 23). So:

1. A frame arrives while desktop's receiving chain is behind the sender's current
   chain → AEAD fails.
2. **Desktop deletes the frame from the server inbox immediately**
   (`deleteInboxMessages` in the `InboxDecrypt` catch block,
   `MessageService.ts` ~L3864, and the `Confirm` catch ~L3772).
3. Seconds later desktop performs its DH ratchet and **stores exactly the skipped
   message keys that frame needed**.
4. The frame is already gone. Permanently unrecoverable.

That is the loss. Not the crypto, not state serialization, not row selection.

### §16b. I have to retract my own §12b refutation

§12a flagged delete-on-failure as a suspect; §12b then "refuted" it because
harness S1/S2 showed a receiver recovering after missing frames. **That test was
mis-specified**: it dropped frames _before_ arrival and left them retriable. The
real sequence is _arrive → fail → get deleted → receiver ratchets → too late_.
The harness never modelled the deletion. Hypothesis B was correct; my refutation
was not. (This is also why every "the core recovers from everything" result was
true yet irrelevant.)

### §16c. SECOND DEFECT — deletion is keyed by a non-unique timestamp

`deleteInboxMessages(inbox, [message.timestamp], …)` deletes by **timestamp**,
and §15a proved two distinct live frames share a timestamp. So one failed frame
can delete a **sibling frame that was never processed** — silent collateral loss,
independent of the ratchet. Any other code keyed on `(inbox, timestamp)` is
suspect for the same reason.

### §16c-bis. Provenance: PRE-EXISTING (~10 months), not caused by the recent fixes

`git blame` on the delete inside the `InboxDecrypt` catch:

```
75d76f0c5a  LaMat 2025-09-30   await this.deleteInboxMessages(
54759a2083  LaMat 2026-07-17     freshKeys.receiving_inbox,     <- variable rename only (#236)
75d76f0c5a  LaMat 2025-09-30     [message.timestamp],
75d76f0c5a  LaMat 2025-09-30     this.apiClient
```

The delete — **and the delete-by-timestamp** — date from `75d76f0c5a`
(2025-09-30, original MessageService). The only recent touch is #236 renaming
`keys` → `freshKeys` as part of the fresh-read-inside-the-lock change. PR #235
("preserve session on decrypt failure") added only the two `logger.error` lines;
it did not introduce the delete.

**But the recent fixes changed its IMPACT, which is why it surfaced now:**

- _Before #235_, a decrypt failure tore down the whole session, so the deletion
  was moot — the conversation was dead and a reset followed. The bug was masked
  by a bigger one.
- _After #235_, the session survives, so the conversation keeps running and each
  deletion becomes an isolated, permanent, single-message loss.
- Receipts + typing (#164 and the desktop receipt work) multiplied ratchet churn,
  so frames far more often arrive while the receiver is momentarily behind —
  which is precisely the condition that triggers the delete.

This closes a loop in the desktop master report, which already logged exactly
this symptom as an unexplained residual: _"isolated single-frame wire loss (one
message vanishes, conversation continues, sender sees the missing delivery
checkmark) with no automatic resend. Observed once post-fix."_ It is not wire
loss. It is desktop deleting a frame it could have decrypted ~30s later.

### §16d. Fix direction (desktop)

Do not delete a frame on first decrypt failure. Options, cheapest first:

1. **Bounded retry window** — keep the frame, retry after the session advances;
   delete only after N attempts or T seconds (mobile already bounds retries this
   way, PR #177). The skipped-key evidence says a retry ~30s later would have
   succeeded for 5 of 6 frames here.
2. Delete by a **unique frame identity** (envelope hash), never by timestamp.
3. Keep the head-of-line protection the deletion was introduced for by skipping
   past a bad frame _without_ deleting it.

This is desktop-side and belongs with the desktop DM master report. Mobile's
`fix/dm-state-persistence` (`0dbb88a`) remains independently valid.

### §16e. Tooling note

`.agents/scripts/dr-replay.mjs` now works end to end (chunked dumps reassembled;
`frame` is the full SealedMessage, so the unseal needs its
`ephemeral_public_key`). The cross-product and skipped-key probes that produced
this result were ad-hoc scripts over the same dumps — **this is now the fastest
path for any further DM question, with zero device time.**

## §17. Fix VERIFIED live (2026-07-25, round 11) — frames now recover; a second gap found and closed

Desktop built from `test/dm-fix-instrumented` (retry fix + full instrumentation).
Result: desktop→mobile 5/6, mobile→desktop 2/6.
Log: `localhost-1784982721408.log` + `xptrace-mobile-20260725-142933.log`.

### §17a. The fix works — proven by frame identity

Tracking each frame by `envFp` through its whole outcome history:

| Frame      | History                  | Recovered after    |
| ---------- | ------------------------ | ------------------ |
| `242602f7` | FAIL, FAIL, FAIL, **OK** | 19.6s / 3 attempts |
| `41ca3e4e` | FAIL, FAIL, FAIL, **OK** | 20.2s / 3 attempts |
| `9fcc736c` | FAIL ×6, **OK**          | 40.9s / 6 attempts |

**Three frames decrypted after previously failing.** Under the old code every one
would have been deleted on attempt 1 and lost forever. The retry budget is
correctly sized: recovery took 3-6 attempts and 20-41s, comfortably inside
8 attempts / 5 minutes.

### §17b. Regression found in the same capture — and fixed

Two frames were decrypted **12 times each**. Before the retry change: **0 frames
decrypted more than once**; after: 2. Cause: **the confirmed-session path never
acked a frame it successfully decrypted.** It relied on
delete-on-first-failure to clear the inbox, so a successful frame was just left
on the server. Invisible while failures were deleted instantly; once frames are
retained, the server redelivers them and each redelivery decrypts again.

Fixed by `ackProcessedFrame` (delete on successful decrypt, never throws).
Pre-existing gap, exposed rather than created by the retry change — but it only
becomes harmful _with_ retention, so both commits belong together.

### §17c. Remaining loss — and why "18 still lost" overstates it

Failure distribution across 25 frames: 4 never failed, **10 failed exactly once**,
5 failed 3×, 4 failed 6×, 2 failed 9×.

The 10 single-failure frames were **retained, not deleted** — they simply were not
redelivered inside the ~3-minute capture. Their fate is unknown, not lost. Only
the 2 frames at 9 failures actually exhausted the budget and were given up on
(intended behaviour).

### §17d. The new desktop→mobile miss is NOT decryption

Mobile: **323 RX-OK, zero DROP-\* events** — fourth consecutive clean run. So the
one desktop→mobile message that did not land never reached mobile's decrypt path
at all. That is the **transport gap** (§14e), unaffected by this fix, and it now
demonstrably bites in both directions.

### §17e. State of the fix

`fix/dm-retain-undecryptable-frames` (off `main`), two commits:

- `27af898f7` retain-for-retry + `frameRetry.ts` + 9 unit tests
- `f8b26b2db` ack on successful decrypt

497 tests pass, 0 type errors, no debug code on the branch.
`test/dm-fix-instrumented` carries the same two fixes plus all instrumentation.

**Next, in priority order:**

1. Re-verify with the ack fix in place — expect the 12× repeats to vanish and the
   recovery count to hold or rise.
2. The transport gap (frames never arriving, both directions) is now the largest
   remaining source of loss. That is the resend-on-missing-receipt work
   (`quorum-desktop/.agents/tasks/transport/2026-07-17-dm-dead-session-autoheal.md`).
3. Ghost-device init storm (§7.1/§13b.5) — pure waste, still untouched.

## §18. Round-13 (2026-07-25, 15:04) — frames DO arrive; it is NOT transport loss. Desktop's session is frozen solid.

With the envelope-fingerprint join key finally correct on both sides (desktop was
hashing the WHOLE sealed message while mobile hashed the inner `envelope` field —
my bug, flagged in §15c and not fixed until `bf5e7e9b5`), the dumps now join
exactly to mobile's send ledger:

| Frame `envFp`  | Mobile logged sending it as       |
| -------------- | --------------------------------- |
| `4f8f214f`     | read-ack                          |
| **`a0b6c072`** | **the post that "never arrived"** |
| `c6fb9327`     | delivery-ack                      |
| `19b0eabd`     | the single message sent at 15:04  |

**Every one of them reached desktop and failed to decrypt.** So the loss in this
direction is NOT the transport gap — the frames arrive, desktop cannot use them.
Earlier rounds' "never arrived at desktop" conclusions were drawn with a broken
join key and must be re-checked before being trusted.

**Desktop's session is frozen, not merely behind.** All five dumps carry the
IDENTICAL state fingerprint `stFp=e000ac31` across 14:47 → 15:04 (17 minutes):
root `ac4cb16a`, sLen 6, pS 15, rLen 13, skipped 26, dhs `83c4ca6e`,
dhr `e7223a03`. And there are **zero `SAVE` events in the whole capture** —
desktop wrote no DM ratchet state at all in that window.

⇒ The retry fix cannot help here by construction: retrying only pays off if the
state eventually advances, and this state never moves. §16's fix addresses frames
that are _transiently_ early (verified working, §17); it does nothing for a
session that has stopped ratcheting altogether.

**The open question is therefore the ONSET**: what makes desktop's receiving
chain stop advancing in the first place? Every capture so far has begun _after_
the session was already dead. Next capture must start from a **fresh session**
(reset first) and record from the very first message, so the transition from
healthy to frozen is inside the window.

## §19. ONSET FOUND (2026-07-25, round 14) — a desktop-side session reset is ONE-SIDED: it mints a new receiving inbox and never tells mobile

LaMat reset from desktop, reloaded both, sent one message each way.
desktop→mobile arrived; mobile→desktop failed **on the very first message**.
Logs: `xptrace-mobile-20260725-150828.log` + `localhost-1784985015286.log`.

### §19a. The sequence, from the logs

| Time               | Event                                                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15:08:38-39        | Desktop startup replays 5 redelivered frames against the OLD row (`recv=QmXGSZak1bsU`, rLen 13, 7 rows) — all `RX-FAIL`                                                            |
| **15:09:24**       | **Reset.** Desktop mints NEW rows. Its row for the dev phone (`tag=QmTCcmbzP6oP`) now has **`recv=QmaxrRPM59LP`** — a brand-new receiving inbox. Five ghost rows minted alongside. |
| 15:09:24, :45, :48 | **`RX-NOSTATE arrival=QmXGSZak1bsU`** ×3 — frames arriving at the OLD inbox, silently dropped                                                                                      |

Mobile, meanwhile, sent all four frames to **`tgt=QmXGSZak1bsU`** with
**`acc=True`**, `root=037edda0`, sLen 9→12 — i.e. **mobile still holds its old
CONFIRMED session and is still writing to the inbox desktop just abandoned.**

### §19b. The mechanism

**Desktop's reset is unilateral.** It deletes its own rows and creates a new
session with a new receiving inbox address, but mobile is never informed. Mobile's
confirmed session remains valid from its point of view, so it keeps sending to the
dead inbox forever. Desktop has no state for that inbox, so every frame is dropped
as `RX-NOSTATE` — **silently, with nothing sent back to mobile.**

desktop→mobile keeps working because desktop's post-reset sends go out as
init/new-session envelopes to mobile's DEVICE inbox, which mobile's receive path
accepts. Only the mobile→desktop direction dies.

This explains the entire long-standing pattern:

- **"Reset fixes it"** — the desktop→mobile direction recovers immediately.
- **"…then it breaks again"** — mobile→desktop was never fixed; it is dead from
  the instant of the reset and stays dead until mobile ALSO re-inits.
- **First message after a reset fails** — exactly as observed here.
- Why every earlier capture found a frozen desktop row: the row mobile was feeding
  had been orphaned by a reset, so it could never advance.

### §19c. Why §16's fix could not have helped this

The retry fix keeps frames that fail _decrypt_. These frames never reach a
decrypt — they are dropped at `RX-NOSTATE`, before any ratchet is consulted.
Different code path, different failure. §16 remains valid for what it fixes
(§17 verified it recovering real frames); it is simply orthogonal to this.

### §19d. Fix directions

1. **Make reset two-sided.** A reset must reach the peer so it drops its
   confirmed session and re-inits. Desktop already _handles_ an inbound
   `delete-conversation` reset signal (`MessageService.ts`, both decrypt
   branches) — so the machinery exists; what is missing is that a local reset
   does not reliably deliver that signal to the peer, and/or mobile does not act
   on it. Verify both halves.
2. **Stop `RX-NOSTATE` being silent.** A frame for an inbox we hold no state for
   is a definitive signal that the peer is using a stale session. Desktop should
   respond (re-init toward that peer) rather than drop unread. This makes the
   pairing self-healing regardless of how the divergence arose — and would have
   masked the whole class of bug.
3. Registration hygiene / ghost pruning remains separate (§7).

**This supersedes the "transport gap" framing in §14e/§17d for this direction:**
the frames arrive; they are dropped for want of state.

## §20. SHIPPED — three PRs open (2026-07-25)

All three are one focused mechanism each, all of them mechanisms of THIS bug.
Nothing in them is a side quest; the symptom was always a concentration of
separate defects, which is why it survived ~6 months.

| PR                                                                           | Repo           | Mechanism                                                                                                                                                                                                                                                                  | Status                  |
| ---------------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| [desktop #252](https://github.com/QuilibriumNetwork/quorum-desktop/pull/252) | quorum-desktop | **Reset destroyed inbox routing** (§19) — the ONSET. Reset deleted inbox mappings, orphaning the peer's confirmed session; peer kept writing to an address desktop no longer recognised → every frame silently dropped, permanently one-way. Mobile always had this right. | open, 488 tests green   |
| [desktop #253](https://github.com/QuilibriumNetwork/quorum-desktop/pull/253) | quorum-desktop | **Frames deleted before they could decrypt** (§16) — retain-for-retry + ack-on-success + widened budget. Proven by offline replay (5 of 6 deleted frames decrypted against a state held ~35s later) and verified live (§17: 3 frames recovered).                           | open, 497 tests green   |
| [mobile #178](https://github.com/QuilibriumNetwork/quorum-mobile/pull/178)   | quorum-mobile  | **Ratchet state resurrecting / not surviving backgrounding** (§10d, §10e) — delete now clears the write queue, immediate writes supersede queued ones, storage flushes on background.                                                                                      | open, 50/50 tests green |

**Merge order recommendation:** #252 first (one line of behaviour, largest
impact — it is why resets only ever half-worked), then #253, then #178.
Per LaMat's flow: squash-merge, pull, re-branch from fresh master/main.

### §20-bis. Round-15 (2026-07-25) — one-sided reset does NOT propagate; found and fixed

LaMat's product challenge was correct and important: **a reset must be one-sided.**
One user resets, their next message carries a fresh init envelope, both sides
converge. Requiring both users to reset is unusable. Advice earlier in this
session to "reset both" was a workaround for an already-corrupted pairing and
should NOT be read as how the feature works.

Tested on merged main/master (no instrumentation): desktop-only reset →
**mobile→desktop still dead**, desktop→mobile fine. That pinned it.

**Cause** (`hooks/chat/useSendDirectMessage.ts`, fan-out device loop):

```js
tagMatches.find((s) => s.sendingInbox?.inbox_public_key) ?? tagMatches[0];
```

Several rows legitimately share one device tag. When the peer resets they mint a
NEW receiving inbox and announce it in their init envelope, but they cannot
delete our old row — so we hold BOTH a stale confirmed row (pointing at the
abandoned inbox) and the fresh one. Both look send-ready; the stale one is first
in insertion order, so it won every time. Every message went to a dead inbox.

**Fixed:** [mobile #179](https://github.com/QuilibriumNetwork/quorum-mobile/pull/179)
— prefer the NEWEST send-ready row, extracted to a pure `selectSendState` helper
with 7 unit tests (57/57 suite green).

**Honest correction to §19/§20:** desktop #252 is a real bug fix (mobile's own
code documents that routing must survive a reset) but is **NOT sufficient on its
own** to restore inbound delivery after a reset — the ratchet state is still
deleted, so the frame is dropped for a different reason. #179 is the piece that
actually makes a one-sided reset propagate. Do not read #252 as closing this.

### §20-ter. Round-16 (2026-07-25) — the failure FLIPPED SIDES, revealing the same bug on desktop

After merging #179 (mobile), LaMat reset from **mobile** and sent first:
**mobile→desktop 4/5, desktop→mobile 0/5, no read receipts either direction.**

Compare with round 15 (reset from **desktop**): desktop→mobile fine,
mobile→desktop dead. **The dead direction is always the one pointing back at
whoever reset.** That symmetry is the diagnosis: it is the PEER's send-side
session selection that fails to adopt the new session, so whichever side did not
reset keeps writing to an abandoned inbox.

#179 fixed that selection on mobile only. Desktop had the identical defect at
**four** send sites:

```js
sets.find((s) => s.tag === inbox); // first match, no recency
```

Receipts travel the same send path, which is exactly why read receipts died in
both directions — a corroborating detail, not a separate bug.

**Fixed:** [desktop #254](https://github.com/QuilibriumNetwork/quorum-desktop/pull/254)
— one pure `orderSessionsForSend` helper (send-ready first, then newest) applied
at all four sites; 504 tests green, 7 new. **MERGED**, `main` = `9ef40b5ae`.

**#179 and #254 are two halves of one fix.** Neither works alone: whichever side
resets, it is the OTHER side's selection that must adopt the new session. This
also explains why earlier rounds each looked like a different bug — LaMat was
unknowingly testing whichever half was still broken.

### §20-quater. Round-17 — the staleness guard had a hole exactly at reset

Reset from desktop, desktop sent first: desktop→mobile landed, mobile→desktop
did not. Desktop console (no XPTRACE needed — the shipped `logger.warn` told the
whole story):

```
SESSION REPLACED by init envelope  envelopeAgeSeconds: 94125  replacedRows: 0
SESSION REPLACED by init envelope  envelopeAgeSeconds: 94089  replacedRows: 1
SESSION REPLACED by init envelope  envelopeAgeSeconds: -0     replacedRows: 1
… DM decrypt failed (Confirm…) invalid initialization envelope   ×5
… DM frame for unknown inbox — no encryption state, dropping unread  ×2
```

Two **26-hour-old** init envelopes installed themselves into the freshly-reset
state before mobile's real init arrived. Cause: `isStaleInitEnvelope` rule 1 —
`if (existingRowTimestamps.length === 0) return false`. **A reset deletes every
row, so the guard is blind precisely when the user resets.** The churn left the
pairing desynced and mobile's frames hit an inbox with no state.

**Fixed:** [desktop #255](https://github.com/QuilibriumNetwork/quorum-desktop/pull/255)
— absolute age bound (10 min) applied BEFORE the relative rules, so it holds with
zero rows. 508 tests green. **MERGED**, `main` = `f0a34807d`.

**LaMat also observed messages from an EARLIER failed test arriving after a mobile
reload.** That is #253 working as designed — those frames would previously have
been deleted on first failure and lost forever. Late delivery is the fix, read as
a symptom.

## §20-quinquies. THE STRUCTURAL ONE (2026-07-25) — mobile shares one conversation inbox across ALL of a peer's devices

LaMat's observation cracked it: **desktop↔desktop has no issues; only pairings
involving mobile break.** That maps onto a storage-model difference:

- **Desktop** mints a fresh inbox keyset PER SESSION and stores rows under
  `inboxId: session.receiving_inbox.inbox_address` → every device gets its own
  inbox and its own row. Multi-device safe.
- **Mobile** reuses ONE conversation inbox (`getConversationInboxKeypair(conversationId)`,
  `useSendDirectMessage.ts` ~L1140) and stores rows under `(conversationId, inboxId)`
  → **all of a peer's devices collapse onto one key and overwrite each other.**
  Last writer wins; the other sessions are silently destroyed.

Two devices is enough. A phone + a desktop is the ordinary case. **This is §7.2,
which I wrongly dismissed as "only hits ghost rows" — those were LaMat's real
devices.** Correcting two of my own framings: "ghost devices" was wrong and let a
real defect be waved away, and "some of your pain is environmental" was wrong —
multi-device is normal and must not lose messages.

**Predicts the observed matrix exactly:** desktop↔desktop ✅ fine,
mobile↔desktop ✅ broken both directions, **mobile↔mobile predicted broken and
probably worst** (both sides collide) — untested, do NOT assume healthy.

This is upstream of the six shipped fixes. They are all real, but the collision
keeps manufacturing the conditions (orphaned inboxes, stale rows, sessions that
cannot be adopted) that those fixes then cope with.

**Full design + migration plan:**
`issues/.done/2026-07-25-mobile-per-device-conversation-inbox.md` — **do this next.**

## §20-sexies. THE ACCEPT IS MISSING (2026-07-25, live round 18) — mobile branches its send on the wrong field, so a peer's unconfirmed session can NEVER confirm

The §20-quinquies per-device inbox fix was implemented (mobile branch
`fix/per-device-conversation-inbox`, 13a6b9e, 67/67 green) and **live-tested: it
did not restore delivery.** It is still correct and stays in — it is upstream
plumbing — but the pairing dies for a different, sharper reason found in the
capture.

**Live result** (LaMat, both rounds on the branch build, desktop on `f0a34807d`):

| Round | Setup                                   | mobile→desktop | desktop→mobile |
| ----- | --------------------------------------- | -------------- | -------------- |
| 1     | reset from MOBILE, mobile sends first   | **1/3**        | 3/3            |
| 2     | reset from DESKTOP, desktop sends first | **0/3**        | 3/3            |

Round 2's desktop console, once per mobile frame:

```
DM decrypt failed (ConfirmDoubleRatchetSenderSession) — skipping frame, keeping session
Error: invalid initialization envelope
```

**Mechanism, from SDK source (authoritative, not inference):**

- `DoubleRatchetInboxEncrypt` (channel.ts L976+) branches the send on
  **`state.sent_accept`**, NOT on whether the peer's inbox key is known:
  `sent_accept ? <plain DR frame> : <InitializationEnvelope>`, then persists
  `sent_accept: true`. **Every session's first outbound frame is init-wrapped** —
  that frame IS the accept, carrying our return inbox so the peer's unconfirmed
  sender session can confirm.
- Desktop `MessageService.ts` (~L3660) picks its decrypt path from its own row:
  `sending_inbox.inbox_public_key === ''` → `ConfirmDoubleRatchetSenderSession`,
  which (channel.ts L1079+) throws `invalid initialization envelope` unless the
  plaintext carries the full `return_inbox_*` + `tag` + `message` + `user_address`.
- **Mobile branches on `sendingInbox.inbox_public_key === ''` instead.** Since
  #177 a recipient session is born holding the peer's FULL return-inbox keyset,
  so that field is already set and mobile's first reply goes out as a PLAIN
  frame. `sentAccept` exists on mobile's `EncryptionState`, is written in three
  places and preserved by every save — and is **read by no send path at all**.

**And desktop init-wraps EVERY frame it sends.** Its state blob is
`{ratchet_state, receiving_inbox, sending_inbox, tag}` — `sentAccept` lives in a
separate DB column that is never put back in (`MessageService.ts` L958-994), so
`sent_accept` is `undefined` inside the SDK encrypt and the plain-frame branch
never runs. The SDK's plain branch is dead code in production. **Mobile is the
only participant that ever emits a bare DR frame.**

**This is a deadlock, not a race.** Whoever resets holds an unconfirmed sender
session; the peer's replies are never init-wrapped; every frame is rejected.
It explains §20-ter's symmetry ("the dead direction is always the one pointing
back at whoever reset") without any send-selection defect, and it explains why
desktop↔desktop is fine: desktop follows the SDK and always sends its accept.

**FIXED on the branch — commit 8194b01, 78/78 green, awaiting live test.**
`services/crypto/sessionSendShape.ts` now decides the wire shape
(`init | accept | plain | unsendable`) and `markAcceptSent` records the accept
after the frame exists. The accept reuses the EXISTING ratchet and only wraps
it — `ConfirmDoubleRatchetSenderSession` decrypts with
`encryption_state.ratchet_state` (channel.ts L1123), so a fresh X3DH there would
replace the very session the peer's frames are encrypted against. Full write-up,
including the three risks weighed: `issues/.done/2026-07-25-mobile-per-device-conversation-inbox.md`.

### §20-sexies-bis. Live result of the accept fix (2026-07-25, round 19) — the deadlock is GONE; a narrower loss remains

| Round | Setup                    | mobile→desktop | desktop→mobile | desktop errors during the round |
| ----- | ------------------------ | -------------- | -------------- | ------------------------------- |
| 1     | reset from DESKTOP       | 1/4            | 4/4            | 1× `DoubleRatchetInboxDecrypt`  |
| 2     | reset from MOBILE        | **5/5**        | **5/5**        | **none**                        |
| 3     | both restarted, no reset | 4/6            | 6/6            | 2× `DoubleRatchetInboxDecrypt`  |

**Round 2 is the first clean pass in this bug's history.** The
`invalid initialization envelope` flood is gone from live traffic — the
instances still visible in round 1 appeared **on page reload, before any message
was sent**, i.e. stale frames the server redelivers from the earlier broken
rounds (retained by #253). Do not read them as current failures.

**What remains** is one mechanism, and round 3 pins its shape: 2 frames lost, 2
failures logged, exactly. The seal opens (correct inbox, correct keys, signature
accepted) and the **inner** ratchet decrypt fails — mobile encrypted with a
session desktop holds no counterpart for. This is the §11/§13b class and it is
now the ONLY thing left.

**Next step is measurement, not another hypothesis.** Mobile commit `e5e04b1`
adds `[DM-send row]`, one warn per send carrying: how many rows share the device
tag, which row was chosen, the target inbox, the send shape, the timestamp, and
a ratchet-state fingerprint. Six sends distinguish the leading candidate —
mobile holding several rows for one device and alternating between them, since
`selectSendState` breaks ties by recency and a receive on row A can outrank a
send on row B — from a genuine DH-step divergence. If the row count is 1 and the
fingerprint advances monotonically, the mobile side is exonerated and the search
returns to desktop.

### §20-sexies-ter. Round 20 (2026-07-25) — mobile's SEND side is EXONERATED by measurement; the counting itself is now the blocker

`[DM-send row]` (mobile `e5e04b1`) across 7 fan-outs, mobile→desktop 3/6:

- **`rows: 1` for every device, every batch.** The multi-row/alternation
  hypothesis is REFUTED. `chose` is stable per device across all batches
  (`QmccZfeHAW` → `QmPvNryzuj` every time), confirming the PART 1 per-device
  inbox fix holds under live traffic.
- **The live session's ratchet advances monotonically and never repeats:**
  `e36e4917 → 49a723f6 → b05b54ce → 71f3d807 → 1951f931 → 77617f68 → 90687f62`.
  No regression, no resurrection. Mobile's send-side state handling is clean.
- **Ghost-device storm QUANTIFIED:** every message fans out to 6 devices, of
  which **5 are dead and take a full X3DH `init` every single time** — they can
  never confirm, so they never leave the init path. 6× the crypto and 6× the
  frames per message sent. Waste, not loss (§7.1), but now measured, and a
  likely contributor to send latency.

**The blocker is now measurement, not a missing hypothesis.** 6 sent, 3
delivered, only **2** decrypt failures logged: one lost message produced no
desktop error at all. And desktop's console cannot be trusted for counting,
because #253 retains undecryptable frames and retries them, so poison from
earlier broken rounds reappears on every page load (confirmed live: the round-1
`invalid initialization envelope` burst fired on reload BEFORE any message was
sent). Receipt ticks cannot substitute either — a read receipt appeared on a
message desktop never displayed, corroborating
`issues/.done/2026-07-24-dm-false-receipt-ticks-on-undelivered-message.md`.

**Frame identity is now instrumented on BOTH sides** (sha256 of the sealed
envelope, the only field both platforms see byte-for-byte; timestamps are not
unique, §15a):

| Repo           | Branch                                          | Line                                                                                                        |
| -------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| quorum-mobile  | `fix/per-device-conversation-inbox` (`1a4705d`) | `[DM-send wire]` — logged inside the outbound drain, so it is proof of TRANSMISSION, not merely preparation |
| quorum-desktop | `diag/dm-frame-join` (`e210197b6`, NOT on main) | `[DM-recv wire]` on arrival + the fingerprint attached to both decrypt-failure logs                         |

Joining the two answers, for each lost message: did it reach the wire, did it
arrive, and did it fail — or was it never transmitted at all. A fingerprint
repeating across page loads identifies a retried poison frame and excludes it
from the count.

## §20-septies. ROUND 21 (2026-07-25) — THE REMAINING LOSS IS NOT DECRYPTION. Frames leave mobile and never arrive.

Frame-level join of `[DM-send wire]` (mobile) against `[DM-recv wire]` (desktop
`diag/dm-frame-join`), sha256 of the sealed envelope as identity. Mobile sent 7
frames to the live desktop session inbox `Qmf2FQwwoj`:

| fp       | sent (mobile) | arrived (desktop) | decrypt failure naming it |
| -------- | ------------- | ----------------- | ------------------------- |
| 404f3f77 | ✅            | **0**             | 0                         |
| 80c8a592 | ✅            | **0**             | 0                         |
| 2067a36b | ✅            | **0**             | 0                         |
| fd52378f | ✅            | **0**             | 0                         |
| 55b42bf1 | ✅            | ✅ 1              | 0                         |
| 646bd1ad | ✅            | **0**             | 0                         |
| fa4ccd2d | ✅            | ✅ 1              | 0                         |

**Two of seven arrived. Both decrypted cleanly.**

**There was not a single decryption failure of new traffic in the entire round.**
The one `DM decrypt failed` line in the whole desktop log names `fd2f159b`, a
frame with `ts: 1784994956847` — from the PREVIOUS round — redelivered twice by
the #253 retention. Every ratchet-divergence theory (§8, §11, §13b) is
irrelevant to this round: nothing failed to decrypt.

**The loss is between mobile's socket and desktop's inbound handler.** This is a
transport / inbox-write problem, not a crypto problem. After six months of
ratchet work, that is the reframing this bug needed.

### Why "written but not delivered" is the weaker explanation

Desktop demonstrably pulls backlogs, including on this very inbox:

| inbox      | frames seen | fresh this round | oldest                     |
| ---------- | ----------- | ---------------- | -------------------------- |
| QmcZ8KH9Uq | 96          | 17               | 1784561256980 (5 days old) |
| QmX5HGMe8a | 14          | 10               | 1784560799910              |
| Qmf2FQwwoj | 4           | 2                | 1784994956847              |

Desktop surfaced a 12-minute-old frame on `Qmf2FQwwoj` **twice** during this
window while five fresh frames never appeared at all. If they had been stored
server-side, the same catch-up that keeps resurrecting `fd2f159b` should have
found them. So the leading hypothesis is that **the server never accepted those
writes** — not that it accepted and failed to deliver them.

### The amplification suspect

Every mobile message writes **6 frames**: 1 to the live session inbox and 5 full
X3DH inits to dead devices that can never confirm (§20-sexies-ter). Mobile is
therefore issuing ~6× the inbox writes it needs, in a tight loop on one socket.
Any per-connection write limit, backpressure drop, or server-side rejection is
6× more likely to bite. This makes the ghost-device storm a candidate CAUSE of
the loss rather than mere waste, which is a change of status for §7.1/§20a.3.

### Test 1 RESULT (2026-07-25): the writes were REJECTED, not merely undelivered

Desktop was refreshed after the lossy run. **The missing frames did not appear.**
They are not sitting on the server awaiting delivery — the server never accepted
them. Combined with the catch-up evidence above, "written but not delivered" is
now excluded.

### THE SWALLOWED CHANNEL (found immediately after, mobile `c708dbe`)

The server's only way to report a refused write is an inbound error payload.
`WebSocketContext.throttledMessageHandler` had:

```js
if ("error" in message && message.error) {
  logger.debug(`[WS-in ${me}] error msg`, message.error); // ← debug, then dropped
  return;
}
```

Captures run at warn level, so **every rejection the server has ever reported in
this investigation was invisible.** A refused inbox write was
indistinguishable from a delivered one: the frame left the socket, never reached
the peer, and nothing anywhere said why. This is the same silent-failure class
as `RX-NOSTATE` (§20a.1) and the pre-#252 drops, on the send side.

Promoted to `logger.warn` with the full payload, plus a second warn for any
inbound frame that is neither an error, a known frame type, nor a sealed message
— in case rejections arrive in another shape.

**Run the lossy scenario again and read `[WS-in …] SERVER REJECTED`.** If the
server states a reason, the six-month search ends there. Note the protocol has
no positive ack for a write, so absence of an error is not proof of acceptance.

### Still queued if the server says nothing

**Collapse the fan-out to confirmed sessions only** (temporary diagnostic: send
only where `sessionSendShape === 'plain'`, i.e. 1 frame per message instead of 6) and repeat. If delivery goes to 6/6, write amplification is implicated and
the ghost prune becomes a delivery fix, not an optimisation.

### Bonus, now proven rather than suspected

LaMat saw **read-receipt ticks on all 6 messages** while only 2 ever reached
desktop. Frame identity proves those ticks are fabricated, corroborating
`issues/.done/2026-07-24-dm-false-receipt-ticks-on-undelivered-message.md` with hard
evidence. Most likely mechanism: a read receipt marks everything up to a
timestamp as read, so the 2 frames that did arrive marked the other 5 read.
**Receipt ticks must never be used as evidence of delivery in this
investigation.**

## §20-octies. ROUND 22 (2026-07-25) — ⚠️ RETRACTS the §20-septies "writes were rejected" reading. Frames DO arrive; the retry recovers them; the permanent loss looks like DELETE-BY-TIMESTAMP

Same instrumentation, one more round (4/6 displayed, "last landed first"). The
join is much richer than round 21 and it overturns my own conclusion.

**Frame-level timeline on the live inbox:**

```
02b2cc85 (msg1) arrives → FAILS  DoubleRatchetInboxDecrypt
de6c4492 (msg2) arrives → FAILS
7fea7509 (msg3) arrives → FAILS
bd6dd1cf (msg5) arrives → FAILS
f8a1e458 (msg7) arrives → SUCCEEDS
02b2cc85 (msg1) arrives AGAIN → succeeds
de6c4492 (msg2) again → succeeds
7fea7509 (msg3) again → succeeds
bd6dd1cf (msg5) again → succeeds
```

**#253 is working exactly as designed.** Four frames failed on first delivery,
were retained, were redelivered, and decrypted on the second pass. LaMat's "they
didn't land in order, last landed first" IS that retry — msg7 decrypted
immediately, the rest surfaced after their retries. Out-of-order display is the
recovery mechanism, not a separate defect.

### ⚠️ Correction to §20-septies

I concluded there that "the server never accepted those writes". **That is not
supported.** This round shows frames arriving normally, and a better explanation
covers both rounds' observations (never arrived AND never on refresh AND no
server error): **the frames were written, then DELETED from the server before
being read.**

`ackProcessedFrame` (MessageService.ts L328) deletes by **timestamp**:

```js
await this.deleteInboxMessages(receivingInbox, [timestamp], this.apiClient);
```

§16c already established that two distinct live frames can share a server
timestamp, so **any ack can take an unread sibling with it**. That was recorded
as "mitigated, not fixed, by #253" (§20a.4). This round is evidence that it is
actively causing permanent loss, not a theoretical hazard.

### ⚠️ …and this hypothesis is NOT supported by its own evidence. Do not act on it yet.

Challenged and re-checked (2026-07-25). The collateral-delete mechanism requires
two frames to **share a timestamp value**. The round-22 evidence does not show
that, and cannot:

- Every server timestamp actually observed on this inbox is distinct and
  **seconds apart**: 660980, 664833, 677420, 696871, 711215.
- The two missing frames **never arrived, so desktop never logged a server
  timestamp for them at all.** Their values are unknown. The "~565ms apart"
  figure in the earlier draft was mobile's LOCAL send time, not a server
  timestamp — it says nothing about collision. That was a reasoning error.
- The delete API is called with an explicit list of exact values, signed
  individually (`inbox_address + timestamps.join('')`), so the client's intent
  is exact-match. **Whether the SERVER matches exactly or as a range/`<=` is
  unverified** — nobody has checked, and if it is a range the whole picture
  changes. This is the single most valuable unknown here.

So §16c remains a real, documented, unfixed hazard, but there is **no evidence
it caused this round's loss**, and the earlier summary table naming it the owner
of "frames that never arrive" overstated what the prose supports. Corrected
below. Do not take this to the Lead Dev as an API request on this evidence.

### Where the remaining loss actually lives

| symptom                                       | mechanism                                                                                                                              | owner                                         |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| out-of-order / late display                   | #253 retry working                                                                                                                     | none — expected                               |
| first-attempt decrypt failures that self-heal | desktop receive-state race                                                                                                             | desktop, low priority (self-healing)          |
| **frames that never arrive and never return** | **UNKNOWN.** §16c is a candidate but is unsupported by this round's evidence (see above); the server's delete semantics are unverified | **unassigned — needs measurement, not a fix** |

**IF it is ever shown to fire, the fix needs a frame identity in the delete
API** — §16c said exactly this. **Do not raise it with the Lead Dev on the
current evidence.** The cheap prerequisite is to establish the server's delete
semantics (exact value vs range) and to catch one real timestamp collision.
Until the API accepts one, desktop mitigations: only ack when the inbox holds a
single frame at that timestamp, or stop deleting and let the server expire
frames. **This needs the Lead Dev** — it is an API-shaped question, not a client
one.

### §20-octies-bis. SCOPE — which pairings each remaining mechanism affects

Checked, not assumed: **mobile deletes processed frames by timestamp too**
(`deleteInboxMessages(message.inboxAddress, [message.timestamp], dk)`, ~20 call
sites in WebSocketContext), so §16c is NOT a desktop-only defect. And mobile
never deletes a FAILED frame — it replays on every reconnect, bounded by
`inboxAttemptTracker` (5 attempts, then permanently skipped on that device).

| Mechanism | Lives in | mobile→desktop | desktop→mobile | desktop↔desktop | mobile↔mobile |
| --------- | -------- | -------------- | -------------- | --------------- | ------------- |

**The asymmetry that decides all of this** (checked 2026-07-25): the two
receivers dispatch differently.

- **Desktop dispatches on ITS OWN session state.** While
  `sending_inbox.inbox_public_key === ''` it calls
  `ConfirmDoubleRatchetSenderSession`, which **throws on a plain frame**. A peer
  that sends plain before desktop is confirmed is rejected outright.
- **Mobile dispatches on the FRAME'S SHAPE** (`unsealedContent.type === 'dr'` →
  decrypt with the existing ratchet, else init path). Mobile **tolerates** a
  plain frame on an unconfirmed row.

So the missing accept was fatal only against a DESKTOP receiver.

| Mechanism                                                | Lives in            | mobile→desktop | desktop→mobile | desktop↔desktop | mobile↔mobile                   |
| -------------------------------------------------------- | ------------------- | -------------- | -------------- | --------------- | ------------------------------- |
| Missing accept (§20-sexies, FIXED 8194b01)               | mobile's SEND       | **was fatal**  | no             | no              | degraded, not fatal — see below |
| Shared conversation inbox (§20-quinquies, FIXED 13a6b9e) | mobile's SEND       | **was fatal**  | no             | no              | **applied on both sides**       |
| First-attempt decrypt failure, self-heals on retry       | RECEIVER state race | seen           | not seen       | not seen        | unknown                         |
| Collateral delete by non-unique timestamp (§16c)         | both receivers      | possible       | possible       | possible        | possible                        |
| 5-attempt permanent skip (`inboxAttemptTracker`)         | mobile's RECEIVE    | no             | **yes**        | no              | **yes, both sides**             |
| Ghost fan-out (6 frames/message)                         | both senders        | yes            | yes            | yes             | yes                             |

**Consequences worth stating plainly:**

1. The two defects fixed on the branch were **mobile-send-side**, which is why
   desktop↔desktop was always clean and why every mobile→desktop pairing broke.
2. **mobile↔mobile was NOT deadlocked by the missing accept** — mobile's
   receiver tolerates plain frames. What it suffered instead: the initiator's
   session could never be confirmed (the peer's plain replies carry no return
   inbox), so **every message re-ran a full X3DH and replaced the session**.
   Functional but churning, and fragile to any reordering or redelivery, since
   a late frame decrypts against a session that has since been replaced. That
   is close to §20a.2's "converges", so §20a.2's conclusion survives even
   though its reasoning predates all of this. **The accept fix ends the churn
   here too** (the recipient side now announces, so the initiator confirms).
3. **mobile↔mobile carries a permanent-loss path the other pairings do not:**
   after 5 failed attempts a frame is skipped forever on that device, while it
   still sits on the server. Desktop retries a failure within seconds (#253);
   mobile retries on reconnect and then gives up. Any receive-side race hurts
   mobile↔mobile far more than mobile↔desktop.
4. §16c is platform-neutral (both clients delete by timestamp), so
   desktop↔desktop is exposed too; but see the retraction above — there is no
   evidence it has actually fired.
5. The ghost fan-out multiplies every sender's write rate by ~6.

**Residual weakness in the accept fix, not yet closed:** `sentAccept` is set on _assertion_ for a
recipient session (we sent it), not proof. A lost accept re-arms the one-way
death on a narrower window. The wire carries the signal to fix it — the SDK
signs only when `sending_inbox.inbox_public_key !== ''`, so an incoming frame on
one of our conversation inboxes with an empty `inbox_public_key` proves the
sender is still unconfirmed and our accept never landed. Clearing the flag on
that observation makes the handshake self-healing.

**Not yet explained:** round 1's messages 2-3 failed with
`DoubleRatchetInboxDecrypt` on a row desktop considered confirmed — a real
ratchet divergence, same family as §11/§13b. Instrument (§20b `envFp`) rather
than guess if it survives PART 2.

## §20-nonies. ROUND 23 — the self-healing accept was WRONG and is REVERTED (69e7363). But its noise is a real signal.

`dfe9e96` cleared `sentAccept` whenever a frame arrived unsigned on one of our
conversation inboxes. Live result: it fired **hundreds of times** in a few
minutes, so it is reverted (78/78 green). The rule as written is unusable.

**What the noise means, though, is worth picking up tomorrow.** Two facts sit
together and cannot both be innocent:

1. Desktop's frames were arriving at mobile's conversation inbox **unsigned**,
   over and over. The SDK signs only when `sending_inbox.inbox_public_key !== ''`,
   so this says desktop's row **did not hold mobile's return-inbox key** —
   i.e. desktop was persistently UNCONFIRMED, which is exactly the state in
   which it rejects mobile's plain frames.
2. Mobile's send shape stayed `"shape":"plain"` throughout
   (`[DM-send row]`), and mobile→desktop was **1/4**.

So mobile kept sending the one shape desktop cannot accept, while desktop kept
signalling it was unconfirmed. The flag was being reset to `true` faster than
the revert-me code could clear it — prime suspect: `WebSocketContext` (~L2949)
sets `sentAccept: true` when it patches `sendingInbox` from an incoming init
envelope. **That patch conflates the two directions**: learning THEIR return
inbox is not evidence they have OURS. `confirmSenderSession` setting the flag is
justified (their reply reached the inbox we advertised); this second site is not.

**Next session starts here.** It is a small, testable change (stop setting
`sentAccept` at that site, or set it only when the envelope proves receipt of
our inbox), and it is a better lead than the delete-by-timestamp one. Do NOT
re-add the unsigned-frame heuristic — measured, wrong, reverted.

## §20-decies. BRANCH MAP + REVIEW OUTCOME (2026-07-25 end of session) — READ BEFORE TOUCHING ANYTHING

### Where the code lives

| Repo           | Where                                              | Contents                                                                                                                                                        | State                  |
| -------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| quorum-mobile  | **`master` = `a780a80`**                           | The 4 fixes, squash-merged as **PR #180**. No diagnostics. 80/80 tests, typecheck 20 vs the old master's 22.                                                    | **SHIPPED 2026-07-25** |
| quorum-mobile  | `diag/dm-frame-trace` (local, unpushed)            | `master` + `6267385` `[DM-send row]` + `cd01e0d` `[DM-send wire]`. Rebuilt ON TOP of the merged master, so checking it out gives the shipped code plus the rig. | **never merge**        |
| quorum-desktop | `diag/dm-frame-join` (local, unpushed) `e210197b6` | `[DM-recv wire]` + frame fingerprint on both decrypt-failure logs. Purely additive; `main` verified clean at `f0a34807d`.                                       | **never merge**        |

**Desktop had NO fixes this session** — the only desktop commit is the
diagnostic above, so there was nothing to PR. `main` is untouched.

Both diag branches are **local to LaMat's machine and unpushed**, matching the
convention in §20b for the earlier XPTRACE rigs. The commit hashes are recorded
here so they can be found again after any branch pruning.

**The two diag branches are the frame-identity rig.** Check both out together to
re-arm a capture: mobile logs `[DM-send wire]` (proof of transmission, per
frame), desktop logs `[DM-recv wire]` (proof of arrival), joined by a sha256 of
the sealed envelope. That join is what produced §20-septies and §20-octies, and
it is the ONLY sound way to count frames here — server timestamps are not unique
(§15a) and receipt ticks are fabricated (§20-septies).

### What shipped in `fix/dm-session-handshake`

1. Per-device conversation inbox (§20-quinquies).
2. The accept (§20-sexies) — took reset-from-mobile from 0/3 to 5/5 both ways.
3. Server rejections no longer swallowed (§20-septies).
4. **Never record an accept that did not reach the wire** — see below.

### Three independent reviews (2026-07-25)

Correctness/regression, cross-platform interop, and silent-failure, run
separately against the same diff. Verdicts: `SHIP WITH FIXES`, `INTEROP SAFE`,
`NEW SILENT FAILURES FOUND (3)`.

All three converged on ONE mechanism, which was then fixed: **`sentAccept` was
being set on optimism.** Three distinct ways it could be recorded for an accept
that never landed, each re-arming the exact deadlock this work exists to fix:

- **Batch abort.** `markAcceptSent` ran inside `buildAcceptSend`, mid-loop. Any
  device throwing later in the same fan-out rejects the whole callback, and the
  transport discards every frame **without requeueing**
  (`rn-websocket.processQueues`: logs, `continue`). The flag survived; the frame
  never existed. Ghost devices make that throw plausible, not theoretical.
  → the flag is now flipped only after the whole batch is built.
- **Unsigned accept.** `signConfirmedEnvelope` degrades to unsigned rather than
  throwing, and a conversation inbox rejects an unsigned write. → sent, but not
  recorded; the next send announces again.
- **Embed path with no return-inbox keys.** It advertised the DEVICE inbox with
  empty signing keys (which the peer's confirm step rejects) and recorded the
  accept anyway. → falls back to the plain send, and says so.

Independently verified SAFE by review: the fan-out restructure (order,
duplicates, prep/loop equivalence), `sessionSendShape`'s truth table against the
original condition, `buildInitEnvelopeSend` as a faithful merge of both original
builders, the deleted `getConversationInboxKeypair` (zero callers, incl. iOS
notification code), `ourConversationInbox`, the new inbound-payload guard (drops
nothing legitimate), space/channel handling (untouched), and the revert's
completeness.

**Known, accepted residual:** `sentAccept` still means "we put it on the wire",
not "they got it". A frame lost AFTER the queue accepts it still strands the
session. Strictly narrower than before this work, and the self-heal attempt for
it was measured and reverted (§20-nonies).

**Known coverage gap (not a regression):** `useSendDirectReaction.ts` never
init-wraps, so a reaction sent as the FIRST thing on a peer-opened session is
still dropped by a desktop peer. A text message first repairs it.

### NEXT DEBUGGING STEP — ⚠️ SUPERSEDED by §20-undecies, do NOT start here

> **⚠️ (2026-07-25, later the same day):** step 1 below rested on §20-nonies's
> reading of round 23, which the round-23 desktop log DISPROVES (zero
> `invalid initialization envelope` — desktop was never unconfirmed). See §E
> and §20-undecies. The L2949 write is demoted to cleanup (§C.5); the actual
> next step is the baseline round in §20-undecies.

**1. The `sentAccept` write at `WebSocketContext.tsx` ~L2949 is the prime
suspect and is NOT yet touched.** It sets `sentAccept: true` when patching
`sendingInbox` from an incoming init envelope. That conflates the two
directions: learning THEIR return inbox is not evidence they have OURS.
`confirmSenderSession` setting the flag is justified (their reply reached the
inbox we advertised); this second site is not. Round 23 showed desktop
signalling "still unconfirmed" hundreds of times while mobile's send shape
stayed `plain` — consistent with this site resetting the flag faster than
anything could clear it. Small, testable, and it does not need a device to
reason about. **Do this before anything else.**

**2. Do NOT re-add the unsigned-frame self-heal** (§20-nonies): measured, wrong,
reverted.

**3. Do NOT take delete-by-timestamp to the Lead Dev** on current evidence
(§20-octies retraction). Prerequisites first: establish the server's delete
semantics (exact value vs range — unverified, and the client cannot see it), and
catch one real timestamp collision.

**4. mobile↔mobile is still untested** and is the majority case. Needs a second
Android device. Both fixes must work simultaneously there.

### §20a. Still open after these three

1. **`RX-NOSTATE` / `DROP-noEncState` are silent drops on BOTH platforms.** A
   frame for an inbox we hold no state for is proof the peer is on a stale
   session; both sides discard it instead of re-initialising. Fixing this makes
   the pairing self-healing regardless of cause — belt-and-braces over #252,
   and it closes the transient mobile↔mobile window below. **Recommended next.**
2. ⚠️ **CORRECTED TWICE — read §20-octies-bis, which supersedes both this entry
   and the retraction that was stapled to it.** The retraction (that the accept
   deadlock "applies to mobile↔mobile in full, so it does NOT converge, assume
   broken") is a reasonable inference that **the code does not support**, and
   two separate sessions reached it independently, so it is worth stating
   precisely why it is wrong:
   **the deadlock needs a receiver that dispatches on its own session state.**
   Desktop does (`ConfirmDoubleRatchetSenderSession` throws on a plain frame
   while its row is unconfirmed). **Mobile does not** — `WebSocketContext`'s
   conversation-inbox branch dispatches on the FRAME'S shape
   (`unsealedContent.type === 'dr'` → decrypt with the existing ratchet), so a
   plain frame on an unconfirmed row still decrypts. mobile↔mobile therefore
   never deadlocked; it churned a full X3DH per message because the initiator's
   session could never confirm. Degraded and fragile to reordering, not dead —
   so the original "converges" conclusion below survives, even though its
   reasoning predates §20-quinquies and §20-sexies. **Still untested.**
   ~~mobile↔mobile assessment (code-read, untested — LaMat cannot test it).~~
   This bug's catastrophic form does NOT apply: both sides preserve inbox
   keypairs and mappings on reset, so the address stays valid and routable and
   recovery CONVERGES. But a transient one-way window remains — after a reset the
   resetter has no ratchet state, so the peer's frames hit `DROP-noEncState` and
   are dropped until the resetter sends something and triggers a re-init.
   Supporting evidence: mobile as receiver logged zero drops across four
   captures (241/323/196/… RX-OK) — no mobile reset occurred during them.
   Item 1 above closes this window.
3. **Ghost-device init storm** (§7.1, §13b.5) — pure waste (45 of 54 sends were
   X3DH to dead devices in one capture), not loss. Desktop has a plan file
   (`9341bf498`).
4. **Delete-by-timestamp is unsound** (§16c) — two distinct live frames share a
   server timestamp, so any delete can take a sibling with it. Needs the API to
   accept a frame identity. Mitigated, not fixed, by #253.

### §20b. KEEP THESE — the instrumentation branches (do not delete casually)

The XPTRACE/XPDUMP rigs are the only reason this bug was solvable, and they are
reusable for any future DM investigation. **Keep the branches; they are unpushed
local branches, so note the commits before pruning anything.**

| Repo           | Branch                          | Contents                                                                                                                                                                          |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quorum-desktop | `test/dm-fix-instrumented`      | full desktop rig: XPTRACE (send/receive/save/prune, row+state fingerprints, DH keypair fingerprints, row-ambiguity probes) + `[XPDUMP]` chunked replay dumps, on top of the fixes |
| quorum-desktop | `debug/dm-cross-platform-trace` | the same rig on plain `main` (no fixes)                                                                                                                                           |
| quorum-mobile  | `test/dm-fix-instrumented`      | mobile rig: XPTRACE on every send site + every receive outcome, envelope fingerprints, DH fingerprints                                                                            |

**Capabilities worth remembering** (all built this session):

- `envFp` — envelope fingerprint logged on BOTH sides gives an exact 1:1 frame
  join across the two logs. **Only valid identity for a frame** — server
  timestamps are NOT unique (§15a).
- `[XPDUMP]` — on decrypt failure, dumps the exact ratchet state + sealed frame,
  chunked to survive DevTools' ~5k truncation, one dump per distinct frame.
  Replay with `.agents/scripts/dr-replay.mjs <desktop.log>` to reproduce a real
  failure offline and iterate with ZERO device time. This is what found §16.
- `.agents/scripts/dr-core-harness.mjs` — drives the real crypto core in Node
  (Q1-Q4). Reach for it before booking a device session.
- `.agents/scripts/capture-xptrace.bat` (timestamped, never overwrites) and
  `reset-adb.bat` (self-elevating, for a wedged adb server).
- Desktop console capture: **empty text filter, log level = Warnings + Errors**.
  Both streams are `console.warn`; that excludes the info/debug flood while
  keeping transport errors and MessageService warnings.

**Teardown, when the investigation is truly closed:** delete the `[XPDUMP]` logs
in `$QM_CAPTURE_DIR/` — they contain **real key material**. The branches
themselves are harmless (never merged) and worth keeping.

## §20-undecies. INDEPENDENT REVIEW + ROUND-23 RE-READ (2026-07-25, fresh session) — §20-nonies RETRACTED; rig upgraded; START THE NEXT SESSION HERE

A fresh session reviewed the whole investigation from scratch: re-derived the
accept mechanism from SDK source, re-verified rounds 21-22 from the raw logs
(both reproduce the doc's tables exactly), and then re-read round 23 against
its desktop log. Everything below is checked against code or logs, not
inferred.

### The retraction (see §E, last row)

The round-23 desktop log (`localhost-1784998468215.log`, the only capture of
that round) shows:

- **Zero `invalid initialization envelope`. Zero Confirm-branch activity.**
  Desktop was CONFIRMED for the entire capture and never rejected a plain
  frame. §20-nonies's core claim ("desktop persistently unconfirmed, mobile
  kept sending the one shape desktop cannot accept") is disproven.
- The 18 `DM decrypt failed (DoubleRatchetInboxDecrypt)` lines are **4
  distinct FRESH frames** on the live inbox `Qmf2FQwwoj` (`d371208d` ×8,
  `a16542a8` ×5, `6ca1ef62` ×4, `98397dbc` ×1), each a single server frame
  redelivered by #253 and failing AEAD on every attempt until the retry
  budget died. That is a **genuine ratchet divergence** (§11/§13b family) —
  a different failure class from the handshake entirely.
- The heal (`dfe9e96`) triggered on the raw `sealedMessage.inbox_public_key`
  **before unseal, before decrypt, with no staleness check**. Every frame
  desktop ever sent while unconfirmed (every reset in rounds 13-19) sits
  undeleted on mobile's conversation inboxes with `inbox_public_key: ''` and
  re-drains on every reconnect — the same log shows 5-day-old backlog frames
  arriving in bulk. The "hundreds of firings" were archaeology, not live
  signal.

**Open question the retraction creates:** round 22's failures self-healed on
redelivery; round 23's did not. Round 23 is also the only round where
`dfe9e96` was live, flip-flopping mobile's send shape under churn. Whether
the persistent divergence (a) was caused by the heal and died with its revert,
or (b) is still live on current master, is **undecided — and it is the first
thing to test** (protocol below). No mobile logcat exists for round 23, and
the desktop diag branch had no XPDUMP, so the failures cannot be replayed
after the fact. Both gaps are now closed.

### Negative result worth keeping

The round-10/13 XPDUMP states (frozen-session era) were reassembled and
inspected: desktop's row had a **fully populated** `sending_inbox` (address +
all three keys, 114 hex chars each). So the frozen sessions were NOT caused by
a corrupted/partial sending_inbox — that hypothesis is dead for those rounds.

### New structural finding — desktop persists an UNVALIDATED sending_inbox

`DoubleRatchetInboxDecrypt` (SDK channel.ts L1176-1200) rebuilds
`sending_inbox` from ANY decryptable init-wrapped frame checking only
`user_address` — unlike `Confirm`'s seven-field validation — and desktop
persists it wholesale (`MessageService.ts` ~L3751, `sending_inbox:
maybeInit.sending_inbox`). Mobile's equivalent patch site validates all four
fields (WebSocketContext ~L2935); desktop has no guard. A decryptable
init-wrapped frame with partial fields silently de-confirms (`''` → Confirm
branch → rejects every plain frame) or breaks sends (`undefined` → signing
throws). Mobile's pre-#180 embed path emitted exactly such envelopes; current
mobile builders cannot (`sessionReturnInbox` validates all four halves — the
`''` fallbacks in `buildAcceptSend` are dead code). Not the observed mechanism
in any analyzed round (see the negative result above), but a standing landmine.
The diag branch now logs `[DM-recv partial-init]` if it ever happens; a proper
validation guard is a small desktop parity fix for later.

### §16c re-armed — the §20-octies retraction was survivorship bias

§20-octies demanded an observed timestamp collision among counted frames. But
a frame collaterally deleted by a sibling's ack **never reaches the receiver
— its timestamp is unobservable by construction.** Absence of collisions
among survivors is not evidence of absence. Given §15a (two live frames DID
share a timestamp) and the ×6 write burst per mobile message, §16c stays a
live suspect for "frames that never arrive and never return". The diag branch
turns it self-proving: `[DM-ts collision]` fires when two distinct fps share
one (inbox, timestamp); both delete paths refuse the colliding delete and log
`[DM-ack collision]`. One firing settles it.

### Transport reviewed (write-layer context)

`rn-websocket.ts` (pinned shared package) is more robust than assumed: a
`prepareMessage` throw logs `Error processing outbound message` and drops that
batch; per-frame `ws.send` failures and socket slips push frames into
`pendingEnvelopes` for retry, logged as errors. All of these reach the logcat
capture. Remaining blind spots: RN's `ws.send` is fire-and-forget into the
native layer (no delivery guarantee, no protocol write-ack), and the in-memory
queues die with the process. `[DM-send wire]` logs at the END of the prepare
callback — before the actual per-frame `ws.send` loop — so it proves the drain
ran with the socket open, not that every frame left the device.

### The rig, current state (authoritative branch map)

| Repo           | Branch (local, unpushed, NEVER merge) | Head        | Contents                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| quorum-mobile  | `diag/dm-frame-trace`                 | `924a369`   | master + `[DM-send row]` (per send: rows/chose/shape/state fp) + `[DM-send wire]` (per frame in the drain: target + envFp) + `[DM-diag] armed` startup marker                                                                                                             |
| quorum-desktop | `diag/dm-frame-join`                  | `a23a6cebd` | main (rebased) + `[DM-recv wire]` (arrival + envFp + ts) + fp on both decrypt-failure logs + **[XPDUMP] offline-replay on both failure branches** + `[DM-ts collision]`/`[DM-ack collision]` guard + `[DM-recv partial-init]` watchdog + `[DM-diag] armed` startup marker |

Desktop: tsc clean, 508/508 tests. Mobile: tsc at the 20-error master
baseline, shape/inbox suites green. `capture-xptrace.bat` hints refreshed for
this rig. `dr-replay.mjs` parses the XPDUMP chunk format as emitted
(`[XPDUMP] n/i/total chunk`), SDK sibling checkout verified present.

### NEXT SESSION — the baseline round (run this before touching any code)

1. Mobile: build/run from `diag/dm-frame-trace`. Desktop: run from
   `diag/dm-frame-join` (full quit + relaunch, not hot reload).
2. Start `capture-xptrace.bat`; desktop DevTools console with empty filter,
   Warnings+Errors. **Confirm `[DM-diag] armed` on BOTH sides before sending
   anything** — no marker, no round.
3. Reset from either side, then ~6 messages each direction with receipts on.
   Note per message: delivered or not.
4. Read the result:
   - **Clean both ways** → round 23's divergence was heal-induced (it died
     with the revert). The handshake work is done; move to the write-layer
     loss (§C.2) and mobile↔mobile (§C.6).
   - **Persistent decrypt failures** → the divergence is live. The XPDUMPs in
     the desktop console replay offline via `dr-replay.mjs` — cross-test the
     failing frames against the dumped states BEFORE booking another device
     round.
   - **Frames sent but never arriving** → write-layer confirmed live; check
     mobile's log for `SERVER REJECTED` / `Error sending outbound envelope` /
     `Error processing outbound message`, and desktop for `[DM-ts collision]`.
5. Save both logs (the .bat file plus desktop "Save as"), hand them to the
   analysis session with this doc.

---

## §21. ROUND 24 (2026-07-26) — THE BASELINE ROUND. Mechanism of the "persistent" decrypt failures FOUND by offline replay: frames arrive AHEAD of desktop's ratchet; the #253 retry budget dies just before the state catches up

Protocol per §20-undecies, executed clean: both diag branches armed
(mobile `924a369`, desktop `a23a6cebd`), desktop console cleared at round
start, reset from mobile, then 12 alternating messages EACH way (LaMat extended
the ~6 to 12). **Result: mobile→desktop 8/12; desktop→mobile 12/12.**

Logs: `$QM_CAPTURE_DIR/xptrace-mobile-20260726-100646.log` +
`$QM_CAPTURE_DIR/localhost-1785053747365.log`.

### The frame join (mobile → desktop inbox `QmaFUtuMvU`)

- Mobile used ONE session row (`QmPHUqZcmF`), `rows:1`, `shape:plain` for
  every send to the live device, the whole round. **No session churn, no
  accept churn — the #180 handshake fixes are holding.** (The 5 ghost devices
  re-init forever as expected.)
- **29 plain frames sent** to `QmaFUtuMvU`. **16 arrived** (by envFp),
  **13 never arrived** — ~45% write-layer loss, with ZERO transport errors on
  mobile (`SERVER REJECTED`/outbound-error logging armed and silent) and zero
  `[DM-ts collision]` / `[DM-ack collision]` on desktop.
- Of the 16 arrived: 12 decrypted clean; **4 failed AEAD persistently**
  (`56a5c6a5`, `39c16f3d`, `c0f07328`, `d83a007e`), XPDUMPs #8–11. Later
  frames on the same session decrypted fine AFTER earlier ones were still
  failing (`d388409e` clean at 10:15:18 after `d83a007e` failed ×4) — the
  §14d anomaly reproduced under full instrumentation.
- Round 23's old inbox `Qmf2FQwwoj` was still redelivering two frames
  (`bc366938`, `a0008163`) that still fail — the round-23 divergence did NOT
  die with the `dfe9e96` revert. **Baseline verdict: option (b) — live on
  master.** But the mechanism is now known and it is NOT a corrupt session:

### The offline replay result (the decisive evidence)

`dr-replay.mjs`: all 4 frames unseal OK, fail at the inner ratchet with
`aead::Error`, state unchanged. Then the cross-test (scratchpad
`dr-header.mjs`, frames × states):

| frame                               | vs own arrival state | vs later dumped states         |
| ----------------------------------- | -------------------- | ------------------------------ |
| `56a5c6a5` (st#8, root `e7b85234`)  | FAIL                 | **OK vs st#9, st#10, st#11**   |
| `39c16f3d` (st#9, root `aa036b4c`)  | FAIL                 | **OK vs st#11**                |
| `c0f07328` (st#10, root `aa036b4c`) | FAIL                 | **OK vs st#11**                |
| `d83a007e` (st#11, root `f355d107`) | FAIL                 | (no later dump exists to test) |

**The frames are healthy ciphertext from the correct session. They arrive
AHEAD of desktop's ratchet root** — an intermediate frame (one of the 13
lost) carried the epoch step desktop needed, so the next frame's epoch is
unreachable until later successful traffic advances the root; then the
"failed" frame decrypts fine. This explains §14d ("same state, same chain,
different outcome") and §13b ("chronically one ratchet behind")
mechanically.

### Why #253 didn't heal it (the second defect)

Redelivery timing vs when each frame BECAME decryptable:

- `56a5c6a5`: attempts 10:13:20, ~10:13:38; decryptable from ~10:14:04.
  No attempt after.
- `39c16f3d`: 5 attempts 10:14:04→10:14:35; decryptable from 10:14:42.
- `c0f07328`: 4 attempts 10:14:11→10:14:40; decryptable from 10:14:42.
- `d83a007e`: 4 attempts ending ~10:15:0x; root moved past it at 10:15:18.

**Every retry fired while the state was still behind; the time-bounded
budget died seconds before the state caught up, every time.** Round 22
"self-healed" because the gap happened to close inside the budget window;
rounds 23/24 didn't. The budget is wall-clock; the condition it's waiting on
is state-advance. Fix direction (desktop): re-attempt retained frames on
every successful decrypt for the same session (event-driven), and/or keep
them until session reset instead of a wall-clock budget. Also note: some
redeliveries produced NO decrypt-failure log (e.g. `39c16f3d` 5 arrivals /
4 failures) — inspect whether the dedup path skips the attempt entirely.

### What feeds it all: the write-layer loss is now the primary target

13/29 frames (~45%) left mobile's prepare callback with the socket open and
were never seen by desktop — not even once across a full round of server
redelivery cycles (un-acked frames redeliver repeatedly; these NEVER
appeared), so they likely never made it onto the server inbox at all.
Interleaving is irregular (single misses and burst-pair misses, no clean
alternation). All candidate mechanisms in §C.2 remain; §16c can't explain it
(survivor server-timestamps are ms-resolution and seconds apart).

### LaMat's answers + frame identities (same day) — the mapping is COMPLETE

LaMat: missing on desktop = **1, 3, 7, 12**. One desktop + one mobile only
(second-instance/drain-race hypothesis DEAD). Read receipts all visible but
non-diagnostic (a read-ack marks all previous as read — separate small bug,
noted, not now).

Decrypting the recoverable failed frames (plaintext via cross-test):

- `56a5c6a5` (b16) = **read-ack**. `c0f07328` (b22) = **read-ack**.
- `39c16f3d` (b21) = **message "9"** — which IS visible on desktop: its 5th
  delivery (~10:14:3x) landed after b24/b25 advanced the root and decrypted
  silently (5 arrivals / 4 failure logs). **#253 healed it live** — round-22
  behavior, confirmed frame-exact.
- `d83a007e` (b27): 4/4 failures in-capture, no later state to test;
  likely another read-ack (all posts around it are visible).

So the missing four map: **"1" = init-embed payload drop** (sent 10:09:40
while unconfirmed → embedded in the handshake init; desktop accepted the
session from it but never displayed the embedded message — the classic
"first message after reset vanishes", now isolated as its own desktop-side
defect). **"3", "7", "12" = write-layer** (b7 10:10:54, b15 10:13:09, b31
10:15:22 — never reached the server). Alternation fits an every-other-send
pattern with two burst-pair losses (b4+b5, b28+b29); no two consecutive
losses outside bursts.

**Reframe after this round:** the ratchet-lag failure class ate ZERO chat
messages here (two read-acks; delayed "9" by 30 s). The user-facing loss is
(a) the write-layer, (b) the init-embed payload drop. The state-aware retry
fix is still right (b16/b27's redeliveries stopped before their heal
point — under lighter traffic that's a permanently lost message), but it is
no longer the headline.

### LATE ADDITION (same session): d→m was 11/12, and the m1 drop is LOCATED

LaMat: **desktop→mobile also lost its FIRST message (d1)** — 11/12, not 12/12.
Both directions lost exactly the first message after the reset.

Desktop-side code read (m1): the desktop log proves b2 (the init embedding
"1", server ts 10:09:43.460) was received and processed — `SESSION REPLACED
by init envelope … replacedRows: Array(1)` (replacing b1's row; b1 was a
bare same-tag announce whose own install log predates the console clear).
The embedded payload is decrypted at `MessageService.ts` L3479 and saved at
L3677+ — but the init path's catch (`MessageService.ts` ~L3733) is a **bare
silent catch that DELETES the frame from the server**: any throw between
install and display (config lookup, saveMessage, notification hook,
addMessage) logs NOTHING and destroys the only copy. The `else`
"Failed to decrypt" line is absent from the log, so the happy path was
entered; "1" died inside it; the catch buried the error and the frame.
Delete-on-failure again (§16 lesson), on the init path, with zero logging.
**Fix direction: log the error, and retain (do NOT delete) the frame on
failure so redelivery can retry it.**

**d1 (mirror) — code read done, mechanism narrowed to two candidates.**
Mobile's logcat for the round is SPOTLESS (zero decrypt failures, zero
drops, one `[session-confirm] sender session CONFIRMED` at 10:09:54 —
desktop's first init-wrapped frame confirming mobile's sender session).
Mobile's receive paths are silent-failure minefields mirroring desktop's:
Path-1 device-inbox init has a bare catch (~L2790); the conversation-inbox
init branch's catch (~L3003) and the outer per-message catch (~L3409) are
both silent. Structural hazard found: `confirmSenderSession` advances the
ratchet BEFORE the persistence runs — a throw after confirm leaves the
frame on the server where every redelivery now fails decrypt (position
consumed) → bounded attempts (`recordInboxAttempt`) → permanent skip-list,
all with zero logging. d1 is EITHER (a) never-arrived (desktop-side
write/routing during the reset window; desktop has no send
instrumentation, cannot tell from these logs) or (b) confirm-payload
processed, then silently dropped between save and render. The reopen
checks below discriminate (a) from (b) for both m1 and d1.

**Reopen checks RUN (LaMat): both NO.** Neither m1 nor d1 ever reached
storage on the receiving side. m1: died on desktop's init happy path
BEFORE the save; the silent catch swallowed the error and deleted the only
copy from the server — unrecoverable, mechanism confirmed. d1: never
persisted on mobile; exact drop point still ambiguous between
(a) never-arrived (desktop write/routing in the reset window) and
(b) arrived-as-the-10:09:54-confirm, then threw after the ratchet advance
and before the save — both sub-paths are logging-free, so the existing
capture cannot discriminate. Desktop-side send instrumentation (a
`[DM-send wire]` twin on the desktop diag branch) settles it next round.

### FIXES BUILT + RIG UPGRADED (2026-07-26, same session) — awaiting ship

**Fix branches (tests green, unshipped):**

| Repo           | Branch                         | Head        | Contents                                                                                                                                                                                                                                                                                                                                    | Verified                        |
| -------------- | ------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| quorum-desktop | `fix/dm-init-embed-loss`       | `d8973d4aa` | Init path: log every failure; isolate settings/intercept/notification/UI-cache from the save; retry saveMessage once; RETAIN frame on post-decrypt failure (delete only pre-decrypt, logged); stale-refused inits salvage a young (<10 min) embedded post before defusing (upsert-deduped by messageId); processed control frames now acked | tsc clean, 508/508              |
| quorum-mobile  | `fix/dm-receive-error-logging` | `ce8ba87`   | Logging only, no behavior change: error logs in the three bare catches (device-inbox init, conversation-inbox init/confirm, outer per-message), warns on all-states-undecryptable + failed conversation-inbox init, debugs on trial-decrypt misses                                                                                          | tsc at 20-error baseline, 80/80 |

**Diag rig additions (local, NEVER merge):**

- desktop `diag/dm-frame-join` → `10ccc4991`: **[DM-send wire] twin** at the
  outbound choke point (constructor-wrapped `enqueueOutbound`) — every
  outgoing 'direct' frame logged with target inbox + envFp. 508/508.
- mobile `diag/dm-frame-trace` → `6fe862a`: **[DM-recv wire] twin** (every
  arriving DM frame: inbox + envFp + init flag) — both directions now join
  1:1 by fp.
- mobile transport patch (node_modules, NOT tracked):
  `.agents/scripts/patch-rn-ws-diag.mjs` patches the RN client's drain loop
  in the pinned shared package — logs `[WS-frame] sent len/ib/ba` AT each
  `ws.send` call (the gap `[DM-send wire]` can't see), plus mid-batch
  socket-loss requeues and pending flushes. Emits `[WS-diag] transport
patch armed` on client creation. **Re-run the script after ANY yarn
  install** (patch-package can't diff this package on this machine — its
  temp re-install step fails; script is idempotent). `capture-xptrace.bat`
  hints updated to check BOTH armed markers.
- Note: mobile now pins shared `2.1.0-36` (atlas's `2.1.0-29` note is stale).

**SHIPPED (same day):** desktop **PR #256** (main `4ee521cfc`), mobile
**PR #181** (master `3518d69`). Both diag branches rebased on top —
desktop `diag/dm-frame-join` → `2d223f246` (tsc clean, 508/508), mobile
`diag/dm-frame-trace` → `8968862` (20-error baseline, 80/80). The next
capture round runs fixes + full rig together and targets the write-layer
loss (§C.2) with per-frame send visibility on both sides. Before that
round: re-run the transport patch script + rebuild both diag builds.

1. ~~Desktop init-path code read~~ **DONE — silent catch + delete-on-failure
   found (above), fix BUILT (table above).** Mobile mirror read for d1 also
   done (see the d1 section above).
2. **Desktop #253 code read:** budget semantics + what stops redelivery
   (server drain cadence vs local budget); design the state-aware retry
   (re-attempt retained frames after every successful decrypt on the same
   session).
3. **Write-layer instrumentation for the next round (mobile diag branch):**
   per-frame logging INSIDE the `ws.send` loop (current `[DM-send wire]`
   fires at prepare-end, before the loop) + socket readyState per frame —
   discriminates JS-handed-to-native vs dropped-before-native. Server-side
   presence is already discriminated by redelivery (lost frames never
   redeliver → never written).

---

## §22. ROUND 25 (2026-07-26, after #256/#181) — d→m has ZERO transit loss; its losses are TWO newly-visible mobile defects: the receipt-save crash (124 hits) and the unconfirmed re-key race (d1's killer)

Same protocol on the upgraded rig. **m→d 9/12** (lost m1, m10, m12);
**d→m 11/12** (lost d1; d8 arrived late and rendered after d9). Logs:
`xptrace-mobile-20260726-113938.log` + `localhost-1785059081415.log`.

**Rig caveats (both fixed for next round):** (1) `[WS-frame]` was ABSENT —
Metro resolves the package's `"react-native"` entry (`dist/index.native.js`),
and the patch had only been applied to `dist/index.js` ("main"). The script
now patches all three bundles (`index.native.js`, `index.js`, `index.mjs`).
(2) The armed markers were missing from the logcat only because the app
wasn't reloaded after `logcat -c` — the diag lines themselves proved the
build. Protocol: reload the app AFTER starting the .bat.

### m→d (desktop inbox `QmWRxuh4SA`, device inbox `QmccZfeHAW`)

34 batches: 1 pre-reset (old inbox), 3 init-embedded to `QmccZfeHAW`
(11:40:27 reset announce; **11:40:34 = m1's carrier; 11:41:13 = m2's**),
30 plain. Desktop processed init #1 and #3 cleanly (two `SESSION REPLACED`,
zero init-path errors, zero salvage fires — #256's scenario never triggered).
**Init #2 (`95c38bf4`, m1) NEVER ARRIVED — m1 died in transit this round.**
Round 24's m1 died on desktop's silent catch (now fixed); round 25's died in
the write layer: the "first message" symptom has had two distinct killers in
two rounds. Plain frames: 25/30 arrived; never arrived: `02ff0338`
(11:43:27), `8046dc7a`, `618189f8`, `e69b0ac5`, `ba090740` (11:44:03) —
m10 + m12 + 3 receipts. Total transit loss 6/34 (~18%; round 24 was ~45%).
**All 6 desktop AEAD strugglers self-healed** (each shows arrivals =
failures + 1; XPDUMPs #1-6 exist but no persistent divergence this round).

### d→m (mobile inbox `QmS5kYo5LK`) — the reveal

Desktop sent 40 frames; **mobile received 40/40 — ZERO transit loss in this
direction.** Every d→m loss is mobile-side processing, and #181's logging
caught both mechanisms red-handed:

1. **THE RECEIPT-SAVE CRASH — 124 firings.** Identical error every time:
   `NativeStatement.finalizeSync … NOT NULL constraint failed:
messages.message_id`. Flat read-acks (top-level `type:'read-ack'`, no
   `content`, no `messageId`) get past the receipt interception on this path
   and reach `storage.saveMessage`, which throws. The throw hits the outer
   catch BEFORE the ratchet state or ack happens, so the frame redelivers
   and re-crashes on every drain cycle (observed 12, 11, 10, 9, 8… arrivals
   per receipt frame, each re-decrypting because the advanced state is never
   persisted). 99 hits on the live round-25 inbox, 25 on round-24's
   `QmPHUqZcmFDA` backlog still cycling. **This is the engine of the
   permanent backlog drip and per-reconnect amplification, fully silent
   until #181.** Fix: intercept flat receipts on every decrypt path (and/or
   reject messageId-less saves gracefully) + ack the frame.
2. **THE UNCONFIRMED RE-KEY RACE — d1's killer.** Desktop's frames 1-3
   (11:40:48-11:41:05, d1 among them) were sent between desktop's session
   install #1 (from the reset announce) and install #2 (from m2's carrier —
   because m1's carrier, which would have been install #2, was lost in
   transit). All three were **undecryptable by every state mobile holds**
   (5 attempts each, `undecryptable by ALL states`). After install #2,
   desktop's re-announce (frame #4, 11:41:17) confirmed mobile's session
   (`[session-confirm]` 11:41:18) and frames 4+ decrypted. Mechanism: while
   the session is unconfirmed, each mobile init-embedded send supersedes the
   ratchet the peer derives, and a LOST announce widens the dead window —
   every peer frame keyed to the superseded ratchet is permanently
   unrecoverable. SDK-level code read pending (which layer re-keys:
   the envelope build or the row).
   _(Round 24's d1 died differently — post-confirm, pre-save. Two killers
   for the "first message" in BOTH directions across two rounds.)_
3. **d8 arrived late via redelivery and healed** (the retry machinery
   working as designed on mobile's clean path) — but rendered AFTER d9:
   the chat orders by arrival, not `createdDate`. Separate cosmetic bug.

### Where this leaves the map

- The **write layer** remains the only transit killer, m→d only this round
  (6/34), and next round finally has `[WS-frame]` actually loaded.
- **Desktop's receive stack was clean this round** (all strugglers healed;
  #253's budget didn't bite at this traffic rate).
- **Mobile's receive stack is the newly-exposed defect cluster**: the
  receipt-save crash (top priority — compounding, affects every DM
  conversation continuously) and the re-key race (first-message killer).
- Next fixes, in order: (1) mobile receipt interception + graceful save
  rejection + ack, (2) the re-key race code read, then fix, (3) round 26.

**(1) SHIPPED same day as mobile PR #182** (master `34b8434`): the crashers
were desktop's TYPING INDICATORS (flat `typing-start`/`typing-stop`, no
messageId — mobile had zero typing handling). Fix: handleDmReceipt consumes
them; ALL 18 DM ack-by-delete sites converted to `deleteProcessedEnvelope`
(the batch path + every control-message fold was deleting conversation-inbox
frames with the DEVICE key — failed signature verification server-side,
frames redelivered forever, the helper's own comment described the storm);
messageId-less payloads consumed-with-warning on both paths. Diag branch
rebased → `99a6a23` (baseline tsc, 80/80). Expected effect: the crash-loop
flood AND the historic backlog drip drain permanently on the next run.
Remaining before round 26: the re-key race code read (§22.2).

---

## §23. THE RE-KEY RACE ROOT-CAUSED OFFLINE (2026-07-26, same session) — an UPSTREAM CRATE BUG under it; mobile's re-key is wrong-for-the-stated-reason but ACCIDENTALLY LOAD-BEARING. Send path frozen; goes to the Lead Dev

Zero device time — code read + the wasm harness. Repro:
`.agents/scripts/dr-advanced-start-fork.mjs` (deterministic, ~100 lines).

### The code-level finding (mobile)

`buildInitEnvelopeSend` (useSendDirectMessage ~L942) serves BOTH first-contact
and the re-init of an unconfirmed session, and calls
`encryptMessageForNewDevice` (encryption-service L203) which — per its own
comment — "Always establish[es] a new session for this device": **fresh X3DH
per send, overwriting the row in place** (same inboxId, so the send-row diag
shows `rows:1` with a changing ts — round 25's exact trace). The branch
comment's justification ("the receiver … won't be able to decrypt" an
advanced-state message) is **REFUTED** by the harness: a fresh receiver
decrypts an advanced-position first frame fine (cases 1/2/4 below). The
single-device flow (L816-897) already reuses the stored X3DH ephemerals +
advances one session — the correct pattern, never applied to the fan-out.

Round-25 mechanics, fully explained: reset announce = session gen-A
(install#1 on desktop); m1's send re-keyed to gen-B (its carrier LOST in
transit); m2's send re-keyed to gen-C (install#2). Desktop's frames 1-3
(gen-A) were dead against all six of mobile's states (gen-C + 5 ghosts) —
d1's grave. `[session-confirm]` at 11:41:18 = gen-C aligning.

### The crate-level finding (upstream — the big one)

Harness matrix (each cell a pristine X3DH pair; `dr-advanced-start-fork.mjs`):

| Receiver's first-ever frame            | Later alternation                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pos 0, in order (A)                    | clean                                                                                                                                                                          |
| pos 0, then skip a mid-chain frame (B) | clean                                                                                                                                                                          |
| **pos 2, never saw 0/1 (C)**           | **first frame decrypts; then the sender's direction is PERMANENTLY dead from the first DH turn** (receiver's direction keeps working; retries never heal — root fork, not lag) |
| **pos 1, never saw 0 (D)**             | first post-turn frame lost, then re-syncs                                                                                                                                      |

\*\*Trigger: the receiver's FIRST-ever processed frame sits at chain position

> 0.\*\* Mid-session gaps are handled (skipped keys); a skipped START poisons
> the first DH turn's bookkeeping. This is in the Rust `channel` crate (shared
> by every client), amends §B's exoneration, and is a clean candidate mechanism
> for the residual live §11/§13b family (one-directional divergence, peer's
> direction healthy — the exact signature).

### Why nothing ships now

Mobile's re-key-per-send **accidentally guarantees pos-0 starts** for every
announce the peer processes (each generation's embedded message is its
position 0) — it dodges the crate bug at the cost of the generational dead
windows (d1). The naive reuse-fix (one session, re-wrapped announces) makes
case C the NORM whenever an announce is lost in transit. Both futures need
the crate fixed first, OR a mobile design change (per-GENERATION return
inboxes — extending #180's own per-session-inbox pattern so old generations
stay receivable until one confirms). Either way: **Lead Dev decision;
send path untouched.** The repro script is self-contained and runs against
the SDK checkout in seconds.

---

## §24. ROUND 26 (2026-07-26) — d→m PERFECT for the first time; #182 verified live; the m→d write-layer loss is TYPE-CORRELATED (read-acks 10/10 dead), pointing at a server-side silent drop

**Ledger: m→d 9/12 (lost m2, m3, m6); d→m 12/12 — the first fully clean
direction in this bug's history.** Logs: `xptrace-mobile-20260726-122925.log`

- `localhost-1785062139585.log`.

**#182 verified live:** processing-FAILED crash-loops 124 → **0**;
undecryptable-by-all-states warns 86 → **1**; the historic backlog drip is
GONE. d→m 12/12 rides on it.

**Rig caveat (analysis limitation, my error):** the mobile repo had been left
on `master` after the §23 code read, so the app ran WITHOUT the diag layer —
no `[DM-send row]`/`[DM-send wire]`/fp joins, and `[DM-diag] armed` was
absent (the no-marker-no-round rule would have caught it; it wasn't checked).
The transport patch lives in node_modules and WAS live: 822 `[WS-frame]`
lines. Repo is back on `diag/dm-frame-trace`; marker discipline re-armed.

### What the transport probe proved (the round's purpose)

- **The JS layer is EXONERATED.** Every desktop-bound frame logged
  `[WS-frame] sent` with the socket OPEN. One mid-batch socket loss hit a
  6-frame batch (12:32:44); all 6 requeued and **flushed 2 s later** —
  the recovery machinery works.
- **The loss is TYPE-CORRELATED, not random.** To desktop's inbox
  (`QmVVbUmff5`): ~34 frames handed to native, 19 distinct arrived.
  By size class: **1810-byte frames (read-ack-sized): 10/10 LOST — 100%**;
  1858-byte frames (posts): 11/11 arrived; 3106/3110 init-wrapped: ~7/9.
  Same path, same session, same minutes — systematically different fates.
  A frame the native socket accepted, for a type the server never delivers
  and never redelivers ⇒ **server-side silent drop is the prime suspect**.
  The server cannot see plaintext types — its only visible discriminators
  are inbox, size, and the SIGNATURE FIELDS. The transport patch now logs
  `sig=` per frame (v2); **round 27 decides the signature hypothesis.**
- Two AEAD failures (`14899593` = m6's slot — permanent; `388cfc64` —
  healed on redelivery) decrypt against **no** available dumped state.
  Two candidate parents, BOTH in the frozen design zone: §23's fork class
  (case D), or a generation-straddle (mobile master still re-keys per
  unconfirmed send and 3106-class init frames flowed all round — a plain
  frame from generation X arriving after desktop replaced to generation Y
  is equally unrecoverable). Distinguishing them needs round 27's full
  send-side session logging.
- m2/m3 could not be mapped to frames this round (no send-side fp joins —
  the master-build miss). Round 27's full rig covers it.

### Round-27 pre-flight (delta from §20-undecies)

Mobile: `diag/dm-frame-trace`, re-run `patch-rn-ws-diag.mjs` (now v2 with
`sig=`), rebuild, and REQUIRE all three markers: `[DM-diag] armed`,
`[WS-diag] transport patch armed` (mobile logcat), `[DM-diag] armed`
(desktop). No marker, no round — enforced this time.

---

## §25. ROUND 27 (2026-07-26) — best round ever (m→d 11/12, d→m 12/12); the sig hypothesis WEAKENED (signed frames vanish too); healing confirmed at scale; the black hole is ~12% and type-blind this round

No reset (same session as round 26 continuing — no init/handshake traffic).
Full rig live (both layers proved by their own output; startup markers again
predate the logcat window — reload AFTER starting the .bat, next time).
Logs: `xptrace-mobile-20260726-131040.log` + `localhost-1785064512265.log`.

**Ledger:** m→d 11/12 (only m4); d→m 12/12 (second consecutive perfect
round). Loss-rate trend across rounds: 45% (r24) → ~18% (r25) → 13/34 (r26)
→ **4/34 (r27)**.

- **All 34 desktop-bound frames went out SIGNED (`sig=1`)** on the
  long-confirmed session. The 4 that never arrived (`e3e1d03c` = m4,
  `0c03f413`, `0c59debb`, `64e1c389` — the other three invisible
  receipts/control) were **signed, handed to the native socket, connection
  open**. The simple signature hypothesis (unsigned ⇒ dropped) is
  **WEAKENED**: presence of the field doesn't protect. Still open whether
  the signatures VALIDATE node-side (sig=1 only proves non-empty — §22's
  wrong-key ack-deletes show mobile can sign with a wrong key), and round
  26's 10/10 read-ack kill remains unexplained. Only the node side can
  discriminate further: **no write-ack or error frame exists in the
  protocol**, so a rejected/unwritten frame is indistinguishable from a
  delivered one at the client. That protocol gap is now the sharpest
  formulation of the ask for the Lead.
- **Transport recovery verified again, at the frame level:** two mid-round
  socket drops requeued their batches and the flush delivered them ~1.7 s
  later; both frames arrived (one, `8bf7d3b0`, then healed through the
  decrypt-retry cycle too).
- **The decrypt-failure class churned hard and healed COMPLETELY: 51
  failure lines, 12 XPDUMP'd frames, 0 permanent losses** — every one
  recovered on redelivery (round-22 behavior at 25× the volume). The
  #253-successor (state-aware retry) remains the right hardening but the
  current machinery held this round.
- Backlog inboxes down to 14 lines each (draining, per #182).

**"Luck or improvement?" — both, quantifiable.** Real improvement: every
receive-side mechanism is dead (typing-crash flood, wrong-key acks,
init-path destruction), d→m is stable at 12/12, and decrypt failures now
heal instead of accumulating. Remaining luck: the ~12% write-layer black
hole is type-blind and ate mostly invisible receipts this round — m4 just
drew the short straw. Until the node-side write path is understood (or the
protocol gains a write-ack), every round will lose a few frames and the
victim selection is chance.

---

## §26. CLIENT-SIDE OPTIONS WHILE THE UPSTREAM ITEMS ARE PENDING (2026-07-26, assessment — nothing built yet)

The two ROOT CAUSES are upstream (issue #183), but RESILIENCE against both is
buildable client-side. Ranked by value/risk:

1. **Resend-with-dedupe against the write-layer black hole (HIGH value, LOW
   risk, mobile).** Both receivers upsert-dedupe by messageId (proven:
   desktop's IndexedDB `put`, mobile's explicit messageExists check +
   SQLite), so re-sending a post as a NEW frame at a later ratchet position
   is invisible when the first copy arrived and a full save when it didn't.
   Two designs: (a) blind double-write per post (~12% loss → ~1.4%; trivial,
   no feedback needed, costs one extra frame per message); (b) resend-on-no-
   delivery-ack (cleaner, but delivery acks are settings-gated OFF by
   default and ride the same lossy path — needs an internal always-on ack
   distinct from user-facing receipts, which is a protocol-ish decision).
   Recommend (a) now, (b) only with the Lead. NOT frozen-zone: a resend is
   an ordinary next frame on the confirmed session — no handshake/session
   semantics touched. Receipts/controls can stay single-write (invisible
   losses) or be included cheaply.
2. **Auto-reset on persistent AEAD failure (MEDIUM value, MEDIUM risk,
   both clients).** Converts a §23 fork (permanent one-way death) into a
   self-healing blip: if N distinct FRESH frames on one session fail AEAD
   across every retry within M minutes, trigger the session-reset flow
   automatically (rate-limited, e.g. once/hour/conversation). Care needed:
   must not fire on the healable lag class (round 27: 51 failures, all
   healed — the detector must require retry-exhaustion, not first-failure),
   and reset loops must be impossible. Hold until the Lead answers #183 —
   if the crate gets fixed, this shrinks to pure insurance.
3. **mobile↔mobile round — coverage, not a fix. DECIDED: two physical
   devices, one PC (LaMat has a second device).** Fully supported: one Metro
   serves both devices simultaneously (`dev-start-mobile.ps1 -Serial <id>`
   exists for exactly this); `capture-xptrace.bat <serial>` now captures
   per-device (run twice, two terminals — serials from `adb devices`;
   output files carry the serial in the name). Device 2: install the
   dev-client APK once, sign in with a second account (fresh install =
   fresh device identity). Full rig on BOTH ends — every frame joins by
   fp in both directions. Alternatives considered and parked: same-device
   dev+preview (works store-and-forward but the release preview app is a
   logging black box — smoke test only); emulator (historically broken on
   this machine — LAN IP baked into the dev client, fix path via 10.0.2.2).
4. **Small fry (any time):** read-acks mark-all-previous-as-read (LaMat,
   round 24); chat orders by arrival instead of createdDate (d8, round 25);
   desktop state-aware retry hardening (optional — current machinery went
   51/51); the §C.5 L2949 sentAccept cleanup (with tests).

**Confidence that the ROOT CAUSES are out of client reach:** crate fork
~99% (the repro drives the wasm crate functions directly, zero app code in
the loop). Node write path ~80% — the honest residual: client JS visibility
ends at `ws.send` into RN's native layer, so a native-layer drop cannot be
fully excluded; the round-26 type-correlation (10/10 read-acks vs 11/11
posts) argues for content-systematic server-side validation over random
native loss, and mitigation 1 works either way.

---

## §27. ROUNDS 28-29 (2026-07-26) — THE FIRST mobile↔mobile ROUNDS. A rig blind spot made round 28's receive side unusable and was fixed mid-session; round 29 is the first trustworthy both-ends phone↔phone trace. **The write-layer black hole REPRODUCES mobile↔mobile — 8/25 frames, all confirmed handed to the socket, size-blind, one direction only**

Two physical devices, USB, both on `diag/dm-frame-trace` + transport patch v2.
Device **A** = Motorola Edge 50 Fusion (`ZY22K3XRLP`), device **B** = Samsung A40
(`<device-1-serial>`). Both rounds: 4/4 armed markers, **zero `processing FAILED` on
either end, zero `socket lost mid-batch` requeues** — the §22 fixes hold on the
mobile↔mobile pairing too.

### §27.1 THE RIG WAS LYING — `[DM-recv wire]` only covered ONE of the two decrypt paths

Round 28's join said B→A lost 21 of 24 frames. LaMat's device notes said 1. The
notes were right.

`[DM-recv wire]` was instrumented **only in `handleIncomingMessage`**
(`WebSocketContext.tsx:2694`). The **batch** decrypt path,
`applyDMGroupResults` (`WebSocketContext.tsx:4498`), had no equivalent — so
**every DM that batch-decrypted successfully was invisible to the join.** The
individual path only ever sees init-wrapped frames, control frames and batch
failures, so the rig recorded exactly the frames that went wrong and silently
dropped the ones that went right.

The bias is one-directional and it is systematic: **it can only over-report
loss, never under-report it.** In round 28 it hit one direction and not the
other for a mechanical reason — A had never confirmed its session, so A's sends
were 146/168 `init`-shaped and took the _individual_ path on B (logged), while
B's replies were plain double-ratchet and took the _batch_ path on A (invisible).

**Fixed** (diag branch, receive side only — send path untouched): a twin
`[DM-recv wire]` in `applyDMGroupResults` computing the fingerprint over the
same envelope bytes (`JSON.parse(original.encryptedContent).envelope`), emitted
only for frames the batch actually consumed, so anything handed to
`fallbackMessages` is still logged once by `handleIncomingMessage` and no frame
is double-counted. Both sites now carry a `path` field (`'batch'` /
`'individual'`) so the fix is verifiable rather than assumed. Round 29
immediately surfaced **31 arrivals that round 28 would have scored as losses**
(17 on A, 14 on B). tsc at the 20-error baseline, 80/80 suites green.

**What this retroactively affects.** Any earlier round whose _mobile_ receive
counts came from `[DM-recv wire]` may have over-stated loss wherever the batch
path was in play. Rounds that reported **perfect** delivery (d→m 12/12, §24/§25)
are unaffected — under-counting arrivals cannot manufacture a perfect score. But
mobile-side loss figures in rounds that reported losses should be treated as
upper bounds, not measurements. The m→d direction is unaffected throughout
(that join reads desktop's log, a different rig).

### §27.2 Round 29 — the first clean phone↔phone measurement

Reset performed on **B**, first message from B, 10 messages each way.
LaMat's device-observed losses: **B1, A1, A3, A4, A7** (5/20 = 25%).

| direction | frames at peer inbox | delivered | lost        | undecryptable |
| --------- | -------------------- | --------- | ----------- | ------------- |
| A → B     | 25                   | 17        | **8 (32%)** | 0             |
| B → A     | 19                   | 18        | 1           | 0             |

The single B→A loss is the **final** frame of the capture (`1672076b`,
16:27:07.112, ~0.5 s before the captures were stopped) — almost certainly
truncation, not a drop. Treat B→A as effectively lossless this round.

**All 8 A→B losses reached the socket.** Every one has a matching
`[WS-frame] sent` at the same instant, addressed to B's inbox, `sig=1`:

```
16:24:50.671 fp=15a659e0 -> QmaCPpR4pr  REACHED SOCKET len=3106 sig=1
16:25:29.063 fp=6257da83 -> QmXfZSMpdg  REACHED SOCKET len=3106 sig=1
16:25:44.847 fp=dbb1cbb1 -> QmXfZSMpdg  REACHED SOCKET len=1858 sig=1
16:26:00.348 fp=8fea5881 -> QmXfZSMpdg  REACHED SOCKET len=1810 sig=1
16:26:18.618 fp=165a92bb -> QmXfZSMpdg  REACHED SOCKET len=3106 sig=1
16:26:19.581 fp=986d295f -> QmXfZSMpdg  REACHED SOCKET len=3106 sig=1
16:26:35.747 fp=dcd622d4 -> QmXfZSMpdg  REACHED SOCKET len=1858 sig=1
16:26:51.373 fp=9bd275cb -> QmXfZSMpdg  REACHED SOCKET len=1810 sig=1
```

**Zero never-left-JS. Zero arrived-but-undecryptable.** Signed, socket-open,
never retrievable — the §24-§25 black-hole signature exactly, now on a pairing
with a **completely different receiver implementation** (a second phone instead
of desktop). This is the strongest available evidence that the drop is
node-side: two unrelated receivers, same loss.

**It is size-blind.** Losses distribute proportionally across every wire length,
which kills any MTU / size-threshold explanation:

| wire len | delivered | lost |
| -------- | --------- | ---- |
| 1810     | 2         | 2    |
| 1858     | 4         | 2    |
| 1926     | 2         | 0    |
| 3106     | 7         | 4    |

**It is strongly directional this round** — 32% one way, ~0% the other, same
two devices, same minutes, same hub. §25 already weakened the "signed frames
survive" hypothesis; this weakens "uniform ~12% both ways" too. The rate is not
a constant of the link; something about the _sender's_ state or path selection
gates it. Worth carrying into the next round as an explicit question rather than
an assumption.

### §27.3 Two side findings

**A ~90-second stale-inbox window after a reset.** After B reset, A's first two
frames (16:23:39, 16:24:50) still targeted `QmaCPpR4pr` — B's **pre-reset**
inbox — before switching to `QmXfZSMpdg` at 16:25:13. The first got through
(B was still listening on the old inbox), the second was lost. LaMat's `A1` sits
in this window. Not necessarily a defect (the peer keeps the old inbox alive),
but it is a real interval where sends are addressed at a doomed target and it is
worth knowing it lasts ~90 s, not milliseconds.

**Round 28: a session-confirm frame permanently undecryptable — §23 seen live
phone↔phone.** B's `accept` (`ed1c6aff`, envelope `ts=1785074178953`) arrived on
A **five times** on a ~16 s redelivery cadence and was
`undecryptable by ALL states (states=6)` every single time. A therefore never
confirmed and re-keyed on every send for the whole round (**146 of 168 send rows
`init`-shaped**) — the re-key-per-unconfirmed-send behaviour of §23 caught in the
act, doing its accidental shielding job. Note the conversation still delivered in
both directions, so the confirm frame is **not** on the delivery critical path;
its loss costs re-key churn, not messages.

**Both phones carry unrelated undecryptable redelivery storms.** A: inbox
`QmNsHYeYaA` (round 28 also `QmPFdAD9cw` and `QmP8UxYei7`), ~16 s redelivery
cadence, 41 drop lines over 10 distinct frames in round 28, 17 over 5 in round 29. B: inbox `QmWHzJSMnF`, 5 drops. Neither is the A↔B conversation, and no
storm fingerprint appears in the peer's log or in the device's own sends, so
both are separate already-broken conversations predating these rounds. **Clear
them before the next round** or they keep polluting the drop counts.

> **Correction (same session).** An earlier draft of this paragraph claimed the
> storm set "grows monotonically and never drains". **That is wrong** — it was
> read off a single capture, where new frames joining the retry rotation looks
> like unbounded growth. Comparing the two captures 28 minutes apart:
> **zero fingerprint overlap** between round 28's 10 frames and round 29's 5.
> Individual frames DO drain, at ~3-4 retries each, exactly as the log line
> says ("dropping after bounded retries"). The retry budget works. What
> persists is the _conversation_ — it keeps producing new frames this device
> cannot decrypt. That is still a real defect (a DM thread that can never
> decrypt anything, with no in-app recovery) and it is the strongest live
> evidence yet for the §26.2 auto-reset-on-persistent-AEAD mitigation, but the
> mechanism is "permanently broken session", not "leaking retry queue". The
> difference matters: the fix is session reset, not retry-budget tuning.

### §27.4 What this changes

- **Issue #183, item 2 (node write path) is strengthened materially.** The black
  hole is not a mobile↔desktop artifact: it reproduces phone↔phone, size-blind,
  with all frames confirmed handed to the socket. Post the round-29 table +
  fingerprint list as a comment.
- **The ~12% figure should be restated as a range, not a constant** (32% one
  direction, ~0% the other, in a single round). This is the one #183 claim that
  needs amending, and the asymmetry may HELP the Lead localise it: a uniform
  random drop does not produce 33%/0% between two peers on the same hub in the
  same minutes. It points at per-writer or per-inbox state on the node rather
  than a blanket sampling loss. Worth sending upstream as a question, not just
  as extra loss data.
- **Mitigation 1 (resend-with-dedupe, §26.1) gets stronger.** A 32% directional
  loss with no client-visible signal is not survivable by any amount of receive-
  side hardening, and it is the one mitigation that works whether the drop is
  node-side or native-side.
- **Rig discipline:** an instrumentation gap produced a confident, wrong,
  20-frame loss claim in round 28. It was caught only because LaMat's device
  observation contradicted it. **Device observation outranks the rig** — when
  they disagree, suspect the rig first. Added to §E.

### §27.5 Is there a NEW client-side lever on the loss? Four discriminators tested — all negative

The directional asymmetry (33% vs ~0%, same devices, same minutes, same hub) is
the kind of result that can point back at the sender, so it was worth testing
whether anything client-side gates the drop. Everything checked came back
negative:

| Discriminator           | Result                                                                            | What it rules out                                    |
| ----------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Wire size**           | losses proportional at every length (2/4 @1810, 2/6 @1858, 4/11 @3106)            | MTU / size-threshold / chunking bug                  |
| **Send shape**          | all 8 losses `plain`; the one `accept` delivered                                  | shape-specific serialisation defect                  |
| **Session confirmed?**  | A was CONFIRMED in round 29 (24 `plain` rows, no re-key churn) and still lost 33% | the §23 unconfirmed-re-key path as the cause of loss |
| **Reached the socket?** | 8/8 have a matching `[WS-frame] sent`, `sig=1`, correct target inbox              | any JS-layer drop, queue overflow, or send-path bug  |

**Conclusion: no new client-side lever on the black hole.** The frames are
well-formed, correctly addressed, signed, of unremarkable size, sent on a
healthy confirmed session, and confirmed handed to the transport. Client
visibility genuinely ends at `ws.send`. This does not _prove_ node-side (the
native-layer residual from §26 still stands, ~80%), but it does mean no
client-side **fix** is reachable from this evidence — only a client-side
**mitigation**, which is why §26.1 resend-with-dedupe is now the highest-value
item on the board.

The two client-side defects rounds 28-29 DID surface are both real but neither
addresses the loss: the permanently-broken-conversation state (§27.3, argues for
§26.2 auto-reset-on-persistent-AEAD) and the ~90 s stale-inbox window (§27.3,
unquantified — worth one targeted look, not yet shown to be a defect).

---

_Last updated: 2026-07-26_
