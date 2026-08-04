---
type: bug
title: "Mobile ↔ desktop message delivery unreliable (delay + loss + dead receipts) — master report"
status: open
created: 2026-07-20
updated: 2026-07-23
severity: high
repo: quorum-mobile (primary) + quorum-desktop (peer) + server (hub/inbox delivery)
area: WebSocket transport / hub-log (space) delivery / DM inbox delivery / Double Ratchet sessions / receipts
related:
  - "issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (the ONE remaining transport bug — space send loss H-B)"
  - "issues/.done/2026-07-23-bounded-retry-inbox-poison-skiplist.md (SHIPPED #170)"
  - "issues/.done/2026-07-23-port-init-envelope-staleness-guard-to-mobile.md (SHIPPED #170)"
  - "issues/.done/2026-07-23-port-confirm-sender-session-to-mobile.md (SHIPPED #170)"
  - "issues/.done/2026-07-21-dev-env-receive-deaf-investigation.md (receive-deaf diagnosis; SHIPPED)"
  - "quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md (desktop DM-session fixes, 2026-07-17 — mobile mirrored these in #170)"
  - "quorum-desktop/.agents/tasks/2026-07-21-device-registration-ghost-accumulation-cross-platform.md (ghost devices — amplifier, not root)"
---

# Mobile ↔ desktop message delivery (master report)

> **Capturing a round for this bug?** The DM diagnostic rig lives on the local,
> never-pushed branch `diag/dm-frame-trace`; `master` carries none of it. Get onto
> it with **`git debug`** — it refuses to run on a dirty tree, rebases the rig onto
> master, re-applies the `node_modules` transport patch (wiped by every
> `yarn install`), and prints a BUILD CHECK proving which probes and shipped fixes
> are actually compiled in. **Never check out the rig by SHA** — `git debug`
> rebases, so SHAs written in docs go stale immediately, and a round captured from
> a stale head already faked 21 losses once. Full rig docs:
> [§D of the DM master report](2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md)
> and [scripts/README.md](../.done/2026-06-21-mute-and-block-overhaul/README.md).

**One-line:** for ~6 months, messages between mobile and desktop were delayed (arriving in batches,
flushed by a reconnect/restart), sometimes permanently lost, and DM receipts never rendered.
Root-caused and largely fixed 2026-07-23 as a stack of cooperating defects across the space-receive,
DM-receive, and DM-session layers.

---

## §0. STATUS & REMAINING WORK (read this first)

### ✅ Shipped to master 2026-07-23
| Area | What was broken | Fix | Where |
|---|---|---|---|
| **Space receive** | Cursor-wedge storm: queue overflow drops un-persisted catch-up entries → cursor wedges at the gap → same page refetched forever → live messages lost until restart ("0% then flush on restart") | Flow-control catch-up; don't drop un-persisted entries; drain faster; expire stuck in-flight; truncation-aware pagination | **PR #169** (`7a6ccc3`) |
| **DM receive freeze** | A poison init-envelope batch hangs the native call forever → whole receive drain frozen until restart | 30s watchdog + circuit breaker → fall back to individual path, disable DM native-batch for session | PR #170 |
| **DM envelope hoard** | Undecryptable envelopes never deleted → replay every connect forever → multi-minute drains | Bounded-retry skip-list (5 attempts / 7-day age) + server-delete of provably-dead (old + ≥2 failures) envelopes | PR #170 |
| **DM zombie sessions** | Stale init envelopes silently replace healthy sessions with dead ratchets on every reconnect | Init-envelope staleness guard (port of desktop's); refuse + server-delete stale; route init through JS path | PR #170 |
| **DM session never confirms** | Mobile lacked `ConfirmDoubleRatchetSenderSession` → sessions churn forever (8000+ state rows seen), receipts fail 100% | Port the SDK confirm step; complete the handshake on the peer's first reply | PR #170 |
| **DM receipts missing** | Init-wrapped acks decrypted but skipped the receipt handler; and acks deleted with wrong key → redelivery storm starving fresh acks | Intercept receipts on the JS init path; sign ack-by-delete with the inbox-matching key | PR #170 |
| **Space signing/auth** (earlier) | Space control-message + multi-device signatures | per-user / per-device signing | #160, #162, #168 |

### ⬜ Still to do — to make delivery fully solid
1. **[HIGH] Send-side reliability (two variants, ONE cure = durable send + resend).**
   - **Space (H-B):** mobile→desktop channel `log-append` is fire-and-forget with the server ack
     ignored; a send dropped on a bad socket is gone with no resend (~1/5 lost in release testing).
     Design: `issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md`.
   - **DM (~10-15%, user-observed):** DM send throws "WebSocket not connected" pre-flight when
     `isConnected` is false → message never queued/sent; plus the retry button exists but isn't wired
     for DMs. At 1-in-7 to 1-in-10 this is a high-severity reliability gap, not an edge case.
     `issues/.open/2026-07-23-dm-send-websocket-not-connected-abort-and-failed-ux.md`.
   - Both want the same fix: enqueue into the existing durable outbound buffer + flush/resend on
     reconnect instead of hard-failing. Strong candidate for a shared "durable send + resend" module.
     **Top remaining reliability item.**
2. **[MED] Dev-env receipt/message latency (~1-2 min).** Correctness is fixed; dev is just slow
   (residual reflood + throttle + junk-state cost). Prod-preview was ~instant (Run 5). Verify in
   preview before optimizing; a dev-only throttle/batch tune is the likely lever. Needed for UI work
   on receipts.
3. **[MED] Junk encryption-state cleanup.** The churn era left dozens–thousands of unconfirmed state
   rows on the test accounts (one conversation at 8052 rows); every DM op iterates them. One-time
   prune (drop unconfirmed rows older than the newest confirmed session). Not a correctness bug now
   that churn is stopped, but a perf drag + the likely main cause of item 2's latency.
4. **[MED] Ghost-device deregistration.** `deviceCount: 11` on a test account (repeated resets never
   deregister). Desktop fans DM/ack sends to every registered device inbox → each ghost = wasted
   dead envelopes forever. Desktop task exists:
   `quorum-desktop/.agents/tasks/2026-07-21-device-registration-ghost-accumulation-cross-platform.md`.
5. **[LOW] Desktop convergence on bounded-retry.** Desktop deletes on first decrypt failure
   (black-hole risk); mobile now does bounded-retry. Converge desktop for consistency (lead-sensitive).
6. **[LOW] Adverse-conditions receive test.** All validation was foreground + screen-on + LAN. H-A
   (real zombie socket) not disproven for background/Doze/cellular/NAT-rebind — a deliberate adverse
   pass would close it. Lower priority than the confirmed items.

---

## §1. Symptom signature (what users saw)

- **desktop→mobile:** channel + DM messages show 0% for minutes, then ALL land at once (~2-min
  batches); a reconnect/restart reliably flushes the stuck backlog. Delay-dominant; content intact.
  DM **receipts never rendered at all.**
- **mobile→desktop:** ~50-70%, variable, with genuine permanent loss (some messages never arrive).
- **desktop↔desktop:** far more reliable (stable network, and desktop already had the 2026-07-17 fixes).
- Two message families share one WebSocket: **space/channel** (per-hub log: `log-append`/`log-update`/
  `log-since`) and **DMs** (per-inbox durable delivery, ack-by-delete, Double Ratchet sessions).

---

## §2. The tier model (mental map of the whole bug)

The "mobile DMs/messages unreliable" disease was never one bug. It was layers, each hiding the next:

- **Tier 1 — Space receive transport** (cursor-wedge storm). Space-path. → fixed #169.
- **Tier 2 — DM receive plumbing** (native freeze, envelope hoard). DM-path, but lives in the shared
  drain loop. → fixed #170.
- **Tier 3 — Space send transport** (fire-and-forget append loss, H-B). Space-path. → OPEN.
- **Tier 4 — DM session layer** (zombie replacement, no confirmation, receipt routing, ack keys).
  DM-path. → fixed #170.

Spaces are touched by tiers 1 and 3 only. Tiers 2 and 4 are DM-only (and gated to DM code paths, so
they cannot affect space message flow — verified: the poison filter exempts hub-log `__logSeq`
entries, and `recordInboxAttempt` is only called from DM decrypt-failure branches).

---

## §3. Root-cause detail per shipped fix

### Tier 1 — Space cursor-wedge storm (#169)
Reconnect fans out `log-since` across every hub (200-entry pages). The flood overflows the 2000-cap
message queue, which drops the oldest entries — including un-persisted catch-up entries. A dropped
entry leaves a seq gap; the per-hub cursor only advances along a contiguous run
([WebSocketContext.tsx:5199-5210](../../context/WebSocketContext.tsx#L5199)), so it wedges. Every
`log-update` then refetches the same page from the stuck cursor → re-overflow → never converges; live
messages pushed off the full queue. App restart clears the in-memory queue → drains once → heals =
the "0% then flush on restart" signature. Proven live (JS heartbeat confirmed the thread was ALIVE, so
NOT suspension). Fix = gate catch-up on queue depth so it can't outrun the drain.

### Tier 2 — DM native freeze + hoard (#170)
Undecryptable DM envelopes are never deleted (desktop deletes even failures; mobile did not), so they
replay every connect forever. A test inbox held ~240 all-`init:true` envelopes (2026-06-25 → 07-17)
that hung the native `batchProcessMessages` call → froze the entire drain. Fixes: 30s watchdog +
circuit breaker (contain the freeze); bounded-retry skip-list (stop feeding provably-dead envelopes);
server-delete of old + repeatedly-failed envelopes (stop the reflood). All DM-scoped: hub-log entries
are exempt from the poison filter, so spaces are untouched.

### Tier 4 — DM session layer (#170)
Mirrors desktop's 2026-07-17 DM-session fixes (mobile had 2 of 3, missing the staleness guard) plus
new work:
- **Staleness guard** — refuse init envelopes not strictly newer than the sessions they'd replace;
  server-delete refused ones. Tolerance widened to 30 min for mobile drain latency (a fresh
  ack-as-init arriving 2-4 min late was falsely refused under desktop's 120s).
- **Session confirmation** — port `ConfirmDoubleRatchetSenderSession`: process the peer's first reply,
  validate the full return-inbox field set, decrypt under the ratchet mutex, store the peer's full
  sending inbox + `sentAccept:true`. Without it, sessions never confirm → both sides init-wrap every
  message → endless new-session churn.
- **Receipt interception on the JS init path** — init-wrapped acks were decrypted then skipped the
  receipt handler (a regression from routing init to JS for the staleness guard).
- **Ack-by-delete key fix** — conversation-inbox acks were deleted with the DEVICE key → server
  rejected → same acks redelivered forever, starving fresh receipts.

---

## §4. What is exonerated / already fixed (do not re-investigate)

| Layer | Verdict | Evidence |
|---|---|---|
| Signature/auth (space) | ✅ exonerated 2026-07-19 (+ #160/#162/#168 fixes) | posts render signed; deletes verify once delivered |
| Cross-platform crypto (Ed448, canonicalize, messageId) | ✅ sound | shared `buildMessageFingerprint`; golden-vector tests (#161) |
| Desktop DM session death (3 mechanisms) | ✅ fixed 2026-07-17 desktop; mirrored on mobile #170 | desktop solved master report |
| Mobile DM ratchet serialization | ✅ fixed #165 | `ratchetMutex.runExclusive` |
| Space cursor-wedge (Tier 1) | ✅ fixed #169 | this report |
| DM freeze/hoard/session/receipts (Tiers 2+4) | ✅ fixed #170 | live-validated 2026-07-23 |

---

## §5. Evidence archive (condensed — historical, for provenance)

Instrumented runs 2026-07-21 (branch `debug/transport-trace`, WSTRACE — DEV-ONLY, release Hermes logs
don't reach logcat) and 2026-07-23 (`[CATCHUP-DIAG]`/`[RECEIPT-DIAG]`, stripped pre-merge):

- **Run 2 (dev):** desktop→mobile space 0/5 while User A's 2nd browser got all 5 → fault localized to
  mobile RECEIVE path. Watchdog silent during outage → first read as suspension; **later disproven**
  by JS heartbeat (thread alive) → it was the Tier-1 cursor-wedge storm, not suspension.
- **Run 3 (prod-preview):** space mobile→desktop 4/5, 1 permanently lost → **H-B (Tier 3) is real,
  ships to prod, not a dev artifact.**
- **Run 4 (prod-preview):** browser→mobile space 5/5 → Tier-1 wedge is regime-dependent (that moment
  was benign / never overflowed).
- **Run 5 (prod-preview):** DMs both directions 5/5 **with receipts** → the clean baseline; note this
  was a DIFFERENT device/account pairing whose sessions happened to be healthy.
- **2026-07-23 (dev, `QmQuCG…` mobile ↔ `QmYVto…` desktop):** the failing pairing. Chased the Tier-4
  chain to ground: forked sessions → dead receipts → found missing confirm primitive → after all
  #170 fixes, receipts arrive/decrypt/render (ticks) for fresh messages, churn stopped, storms ended.
  Account labels flip-flopped during testing — anchor on ADDRESSES, not "User A/B".

Key incidental findings: `deviceCount: 11` (ghost devices, item 0.4); one conversation with 8052
state rows (churn debris, item 0.3); state rows with `tag ≠ inboxId` (possible row-field
contamination in the ephemeral-cache/trial-decrypt update path — worth a look if any DM oddity recurs).

---

## §6. Key code references (post-merge, on master)

- Space cursor advance (contiguous run): [WebSocketContext.tsx:5199-5210](../../context/WebSocketContext.tsx#L5199)
- Poison filter (hub-log exempt): [WebSocketContext.tsx:4993](../../context/WebSocketContext.tsx#L4993)
- `recordInboxAttempt` sites (all DM decrypt-failure branches): 2743, 2979, 3021, 3035, 5102, 5147
- Init-envelope staleness guard: `services/crypto/initEnvelopeGuard.ts`
- Bounded-retry tracker: `services/space/inboxAttemptTracker.ts`
- Session confirmation: `encryption-service.ts` `confirmSenderSession`
- Space send (`log-append`, fire-and-forget — the H-B fix target): `services/space/spaceMessageService.ts`

---

## §7. Related but SEPARATE (don't fold in)

- **Mobile DM ratchet serialization** — shipped (#165); §8-era "zero lock" notes are outdated.
- **Ghost-device accumulation** — desktop task; amplifier for the hoard, not a root cause.
- **Desktop `dm-dead-session-autoheal`** — desktop's resend-on-missing-receipt; the DM analogue of the
  Tier-3 space resend. Mobile's confirm fix (#170) removed the need for the manual reset that
  motivated it.
