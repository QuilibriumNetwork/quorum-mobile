---
type: task
title: "Investigate: is the mobile space-receive cursor-wedge a real bug, or intentional lead-dev design? (Fable handoff)"
status: done
created: 2026-07-21
severity: high (if bug)
area: WebSocket transport / space hub-log receive pipeline
audience: fresh session (Fable) starting on master — READ THIS FIRST, full context below
related:
  - ".agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (master report + Runs 1-6 + §1b)"
  - ".agents/issues/.done/2026-07-21-dev-env-receive-deaf-investigation.md (ROOT CAUSE section + fix)"
  - ".agents/issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (the separate SEND-side bug)"
  - "debug branch `debug/transport-trace` (WSTRACE instrumentation + JS-liveness heartbeat; NOT merged, revert-before-PR)"
---

# Investigate: bug, or intentional design? — mobile space-receive cursor-wedge

## The question (why this task exists)
We (a prior session) believe we found the root cause of the long-standing mobile↔desktop
"messages don't land" problem on the RECEIVE side. But the suspect code is **documented and
deliberate**, and **we cannot ask the lead dev right now.** So before building/shipping a fix,
determine with confidence: **is this a genuine bug, or an intentional design whose rationale we
don't yet understand?** The user explicitly wants the nuanced answer, not a rush to "it's a bug."

## TL;DR of the suspected mechanism (proven by code + dev repro)
On the space hub-log RECEIVE path, two deliberate pieces interact into a **livelock**:
1. **Overflow drops un-persisted entries** — [WebSocketContext.tsx:5562-5567](../../context/WebSocketContext.tsx#L5562):
   at `MAX_MESSAGE_QUEUE_SIZE` (2000) the queue `splice`s out the OLDEST items (backpressure),
   including catch-up log entries not yet persisted.
2. **Cursor advances only across a contiguous run** — [WebSocketContext.tsx:4959-4967](../../context/WebSocketContext.tsx#L4959):
   `if (seq === advance + 1) advance = seq; else break;` — stops at the first gap, and only
   after persistence.

A dropped entry (1) leaves a seq GAP; the cursor (2) refuses to cross it; `getHubLastSeq`
sticks; every `log-update` re-issues `log-since` from the stuck cursor → same 200 entries
`hasMore=true` → overflow again → drop again → **never converges.** New messages get shoved off
the full queue and are lost.

## THE CRUCIAL NUANCE (this is why the task is "bug or intentional")
The contiguous-cursor logic is **NOT a careless mistake** — its own comment
([WebSocketContext.tsx:4944-4949](../../context/WebSocketContext.tsx#L4944)) explicitly
anticipates the overflow-drop case:

> "Advance the cursor only along a contiguous run from the prior cursor — if there's a gap
> (e.g. queue-overflow dropped older entries), stop at the gap so the next log-since refetches
> what we lost. Doing this AFTER persistence means a crash mid-batch leaves the cursor unchanged."

So the lead dev KNEW overflow could drop entries and INTENDED the refetch as recovery. The
design is sound **if overflow is transient** (occasional drop → refetch catches up → converges).
The suspected bug is narrower and emergent: **under SUSTAINED overflow the refetch itself
overflows, so it never makes progress = livelock.** The missing piece is **flow-control** — the
catch-up fetches faster than the queue can drain, with nothing throttling it.

This is exactly the "could be more nuanced" case the user flagged. The cursor design is
defensible; the gap is an unhandled sustained-overflow regime.

## Evidence (Runs from the master report — all in the space path)
| Run | Setup | Result |
|---|---|---|
| 2 | desktop→mobile, DEV | 0/5; later found = storm, not a dead socket |
| 4 | desktop→mobile, PROD-PREVIEW (benign) | 5/5 — queue never overflowed |
| 6 | desktop→mobile, DEV, instrumented | `watchdog q-in=2000` pinned; `log-since-result entries=200 hasMore=true` looping across ~14 hubs; **JS ALIVE** (heartbeat continuous → NOT suspension) |

Dev triggers overflow always (slow JS + 10ms/msg throttle + 14 spaces × 200 catch-up). Prod
triggers it intermittently (many spaces + backlog after offline, or a slow cellular moment). An
**app restart clears the in-memory queue** → next `log-since` drains without overflow → cursor
crosses the gap → backlog floods in = the classic **"desktop→mobile 0% then flush on restart"**
symptom reported for ~6 months. That symptom match is the strongest argument this is a real
prod bug, not dev-only.

## What Fable should determine (the actual investigation)

**Do NOT rely on git archaeology or desktop for intent — both are dead ends here.** The lead dev
lands 2-3 giant squashed commits for the whole repo (days/weeks of work each), so `git blame`
just points at a monolith with no rationale; and the lead dev has not personally worked on
quorum-desktop in ~1+ year, so desktop reflects >1yr-old thinking, not current intent. Neither
can settle "did they mean to do this."

**Instead, answer it from the CODE'S OWN INTERNAL CONSISTENCY — this needs no history and no
lead dev, and yields a defensible verdict:**

1. **The comment IS the intent statement — test its assumption.** [WebSocketContext.tsx:4944-4949](../../context/WebSocketContext.tsx#L4944)
   states the design's own premise: stop at a gap "so the next `log-since` refetches what we
   lost." That premise ASSUMES the refetch converges. Prove from the code whether it does under
   **sustained** overflow. It does NOT (the refetch re-overflows → re-drops → same gap). So the
   code **violates its own stated assumption in a reachable regime** ⇒ unhandled edge case ⇒
   defensible "bug" verdict, derivable from the code alone. This is the primary line of argument.
2. **Search the CODE (not history) for any convergence guarantee we're missing.** Does the
   server ever stop `hasMore=true`? Is catch-up bounded elsewhere (a space cap, a smaller
   `log-since` page under some condition, upstream backpressure)? If a real convergence
   mechanism exists, the livelock may be dev-only and the prod risk smaller — that would move
   the verdict toward "flawed only under dev's pathological load." If none exists, sustained
   overflow livelocks in prod too. THIS is the crux; resolve it in code.
3. **Desktop = STRUCTURAL comparison only, NOT an intent oracle.** Still worth a look: does
   quorum-desktop's receive pipeline even have this overflow-drop + contiguous-cursor pair? If
   its architecture differs (e.g. no hard-cap drop, or flow-controlled catch-up), that PROVES a
   working alternative exists and that mobile's version is incomplete — evidence toward "bug."
   But do NOT infer "the dev intended mobile to differ" from desktop (it's >1yr stale).
4. **MAX_MESSAGE_QUEUE_SIZE (2000) + MESSAGE_PROCESS_DELAY_MS (10ms):** hard cap with drop-oldest
   vs upstream backpressure — self-consistent with the rest of the pipeline, or the simplest
   thing that happens to break convergence? Judge from the code, not the commit.
5. **Verdict (reachable from code alone):** bug (ship the fix), intentional-but-flawed-under-load
   (fix carefully, preserving the intended transient-overflow recovery), or
   intentional-and-we-misread (don't touch; document the convergence mechanism we missed).

## Proposed fix IF it's a bug (details in the dev-env task)
Preserve the intended contiguous-cursor recovery, but make it CONVERGE by adding flow-control:
- Gate `requestLogSince` on queue depth (don't fetch the next page / don't fan out all ~14 hubs
  while the queue is near cap) → incoming never exceeds drain capacity → no overflow → no gap →
  cursor advances → storm cannot start.
- And/or don't silently drop un-persisted log-tagged synthetics; apply backpressure upstream.
- And/or skip the 10ms per-message throttle for catch-up batches so dev can drain.
- **Validate by forcing overflow in prod-preview** (many spaces + backlog) BEFORE and AFTER.

## Open testing gaps (this run only covered space, browser→mobile)
Not yet tested THIS run — decide if worth it (the code mechanism is already proven, so these are
confirmatory, not load-bearing for the "bug or intentional" question):
- **DMs in dev:** DMs use a different receive path (inbox, not hub-log cursor) so the cursor-wedge
  does NOT apply — BUT DMs share the SAME `messageQueueRef` + 2000-cap drop, so a space-catch-up
  storm could starve DM delivery too. Worth one dev check if we want to know blast radius.
- **mobile→desktop this run:** only browser→mobile was tested here. The SEND-side bug (H-B) is
  covered separately (Run 3, its own task).

## Instrumentation available (debug branch, not merged)
`debug/transport-trace` has WSTRACE (`tx#`/`pending`/`tx-unacked` + `rx` frames + 30s watchdog
`q-in`) and a JS-liveness heartbeat (`read-heartbeat.ps1`, `capture-wstrace-logcat.ps1` in
`.agents/scripts/`). WSTRACE logs only surface in DEV (Metro terminal), not release (Hermes).
All tagged `[WSTRACE]`, revert-before-PR.

---

# VERDICT (2026-07-21, investigated on master @ 2609a78)

## Bottom line
**Intentional-but-flawed-under-load.** The contiguous-cursor + refetch-on-gap recovery is
deliberate and sound for *transient* overflow. But the code contains **no convergence mechanism
whatsoever for sustained overflow** — verified exhaustively — so in that regime it violates its
own comment's stated premise ("the next log-since refetches what we lost": the refetch re-enters
the identical capped queue with identical parameters and makes no progress). Treat it as a
**real bug and ship the flow-control fix**, preserving the contiguous-cursor recovery the design
intends. Every finding below is from master's code, no git archaeology needed.

## How each investigation question resolved

### 1. The comment's premise fails in a reachable regime (primary argument) ✅ bug
The premise assumes the refetch converges. Between one failed catch-up attempt and the next,
**nothing changes**: same page size (200, hardcoded at [WebSocketContext.tsx:5419](../../context/WebSocketContext.tsx#L5419)),
same 2000 cap, same drain rate, no backoff, no state carried across attempts. A retry loop with
zero state change between attempts cannot converge once fill > drain is sustained. Run 6
confirmed empirically (same 200 entries looping across ~14 hubs, `q-in=2000` pinned, JS alive).

### 2. Convergence-guarantee search: NONE exists (the crux) ✅ bug
Searched everything that could bound or pace the catch-up:
- **Queue depth is never read to gate fetching.** `messageQueueRef.current.length` appears only
  in the drain loops and the two drop sites (grep-verified, lines 4828/4910/4956/5001/5453).
  `requestLogSince` gates only on `cancelled` + per-hub `inflight` — neither helps.
- **No backoff, no adaptive page size, no pre-queue dedupe.** `ingestEntries` pushes every entry
  unconditionally; already-persisted entries still occupy queue slots until messageId dedupe far
  downstream.
- **The pagination chain itself DOES terminate** — it advances by the *received* last seq (not
  the cursor, [5472-5474](../../context/WebSocketContext.tsx#L5472)) and ends at
  `has_more=false`. So a single chain is finite; the livelock is the *re-arming*: every
  `log-update` with `seq > stuckCursor` restarts the full refetch from the stuck cursor
  ([5476-5480](../../context/WebSocketContext.tsx#L5476)). In an active space, every new message
  re-triggers the storm. Effect re-runs on `connectionState` flips add more.
- **Only ONE cursor-advance site exists** (the contiguous scan, 4942-4951). No escape hatch, no
  alternative advance path anywhere in the repo.
- **Server side can't be inspected from here**, but the client always asks `limit: 200` and
  nothing in the client protocol suggests server-side pacing.

### 3. Desktop structural comparison ✅ supports bug (never-drop alternative exists)
Desktop **does not consume the hub log at all** (its only hub usage is `postHubDelete` on kick,
MessageService.ts:4572; space receive = legacy `'group'` fan-out + P2P sync-request). Its inbound
queue ([WebsocketProvider.tsx:43-51, 187-195](../../../quorum-desktop/src/components/context/WebsocketProvider.tsx#L43))
is **unbounded — no cap, no drop-oldest, no per-message throttle**. Desktop never discards
received data, so this failure class is structurally impossible there. Proves a working
never-drop architecture exists in the ecosystem (structural evidence only, not an intent oracle).

### 4. Cap + throttle: individually defensible, jointly divergent ✅ bug (emergent)
The 2000-cap drop-oldest is a genuine memory guard, consistent with the dev's documented OOM
concern (the `MAX_BATCH_DRAIN_SIZE` comment at [421-442](../../context/WebSocketContext.tsx#L421):
big drains SIGKILL small devices). Defensible alone. But drop-oldest deletes **exactly the
entries whose contiguity the cursor requires** — plus live messages during a storm. Two
reasonable pieces with no third piece reconciling them = unhandled emergent interaction, not
design.

### 5. Corroborating finds (same subsystem, same session)
- **The dev IS refetch-storm-aware elsewhere:** [messageRecovery.ts:5-6](../../services/space/messageRecovery.ts#L5)
  marks attempted *before* sending "so a stuck server can't cause repeated refetches". The guard
  concept exists in the one-shot path but was never applied to the main log-update loop —
  consistent with "anticipated transient, missed sustained".
- **Latent no-op bug found:** [messageRecovery.ts:38](../../services/space/messageRecovery.ts#L38)
  `setHubLastSeq(addr, 0)` intends to reset the cursor for full replay, but `setHubLastSeq` only
  advances (`seq > cur` guard, hubLogCursor.ts:20) → the reset silently does nothing; it needs
  `clearHubCursor`. Include this one-liner in the fix PR.

## Nuance worth keeping straight (symptom mapping)
Mobile still subscribes to space inboxes, so live messages ALSO arrive via the legacy `'group'`
fan-out (dual-write, dedupe downstream — comment at 5397-5401, resubscribe at 5040-5044). So:
- **A wedged cursor alone doesn't lose new messages** — saturation does. The wedge's role is
  re-arming saturation: each `log-update` restarts the full-backlog refetch.
- **Transient storm** → gap-window messages arrive late (next successful refetch) = the "delayed
  flood" symptom. **Sustained storm** → live messages shoved off the full queue = "0% until
  restart" (restart clears the queue → refetch drains → flood). Both 6-month prod symptoms map
  onto one mechanism at different severities.
- **DM blast radius confirmed statically:** DMs enter the SAME `messageQueueRef` via
  `throttledMessageHandler` (5001-5004); drop-oldest doesn't discriminate, so a space storm
  starves DM delivery too.

## Prod reachability (honest framing)
Dev livelock is **proven** (Run 6). Prod is **strong inference, not runtime-proven**: the
setup fan-out fires all hubs' first pages ~simultaneously after the 1500ms timer (~14 × 200 =
2800 potential arrivals vs the 2000 cap) whenever a real backlog exists, and the 6-month
symptom signature (delay + loss-healed-by-restart) matches exactly; Run 4 (5/5, benign) shows
it's regime-dependent, which fits an intermittent prod bug. Validate by forcing overflow in
prod-preview before claiming fixed (as the fix task already specifies).

## Recommended next step
Implement the fix already sketched in `2026-07-21-dev-env-receive-deaf-investigation.md`,
scoped to preserve intent: (1) gate `requestLogSince`/next-page on queue depth (primary), (2)
stop dropping un-persisted log-tagged synthetics (backpressure upstream instead), (3) skip the
10ms throttle for catch-up batches, (4) the `clearHubCursor` one-liner in messageRecovery.
Needs the user's go-ahead before building (mobile bar).

**DONE 2026-07-21 (user approved):** branch `fix/hub-log-catchup-flow-control`, commit 1ce7bb1.
Implements (1)-(4) plus: 30s expiry on stuck in-flight log-since (a lost result no longer blocks
a hub forever), and truncation-aware pagination (a page cut short by a full queue resumes from
the last visited seq instead of skipping the tail). Awaiting runtime validation.

**Open observation (pre-existing, NOT touched):** an entry with missing `payload.data` is
skipped at ingest and never enqueued, so the contiguous cursor can never cross its seq —
if such entries occur in real logs, that's a second (bounded, non-storm) wedge source.
Unknown whether reachable; the `continue` may be dead defensive code.

---
*Created: 2026-07-21 — verdict added same day.*
