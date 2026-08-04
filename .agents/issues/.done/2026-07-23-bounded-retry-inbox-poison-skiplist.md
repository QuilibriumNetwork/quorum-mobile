---
type: task
title: "Option C: bounded-retry + skip-list for undecryptable inbox envelopes (fix the hoard/poison-batch freeze at the root)"
status: done
created: 2026-07-23
severity: medium (prod correctness) / high (dev testing productivity)
area: WebSocket receive path / message queue drain / native batch
related:
  - ".agents/issues/.done/2026-07-21-dev-env-receive-deaf-investigation.md (SESSION 2: poison-pill DM batch freeze + the hoard)"
  - ".agents/issues/.done/2026-07-21-investigate-receive-cursor-wedge-bug-or-intentional.md (the sibling cursor-wedge fix, 1ce7bb1)"
  - "branch fix/hub-log-catchup-flow-control (watchdog ed1aeaa = the 30s safety net this complements)"
---

# Option C — bounded-retry + skip-list for undecryptable inbox envelopes

## The problem this fixes (one paragraph)
Mobile never deletes an inbox envelope that fails to decrypt ([WebSocketContext.tsx:2937-2939](../../context/WebSocketContext.tsx#L2937) returns without `deleteInboxMessages`). So failed envelopes replay on every connect forever = a monotonically growing **hoard**. When the hoard includes large `init:true` envelopes, the native `batchProcessMessages` call hangs, freezing ALL receive until restart (contained but not fixed by the 30s watchdog in ed1aeaa). Mobile's behavior is *infinite, unbounded retry*; desktop's is *zero retry* (delete on first failure — its documented "black-hole" tradeoff, which risks losing genuinely-transient failures). **Neither is right.** Option C is the middle: retry a bounded number of times so transient failures recover, then give up so the hoard can't grow without bound.

## Design in one line
Track per-envelope decrypt-attempt count (+ first-seen age) in MMKV. Before an envelope enters the native batch, skip it if it's exceeded the attempt cap OR the age cap ("poisoned"). Clear the tracking on successful decrypt. Poisoned envelopes are filtered from processing (never reach the native call → no freeze); server-side deletion of them is an OPTIONAL, flag-gated add-on that isolates the only lead-sensitive behavior.

## Why this is strictly safer than both current behaviors
- vs mobile-now: transient failures still get N chances across reconnects (unchanged recovery), but a permanently-dead envelope stops being fed to the processor after N tries → no freeze, hoard bounded.
- vs desktop/A1: we do NOT delete on first failure, so a transient failure is never thrown away prematurely. We only *stop trying* (and optionally delete) after N proven failures, when "transient" is no longer a plausible explanation.
- The 30s watchdog (ed1aeaa) stays as the safety net for any novel poison pattern.

---

## Does anything belong in quorum-shared? — NO (decision + reasoning)

**Verdict: keep this 100% mobile-local. Nothing goes in `@quilibrium/quorum-shared`.**

- The receive pipeline is not shared: mobile drains via `WebSocketContext.processMessageQueue`; desktop processes via `MessageService`. They are structurally different code paths.
- The storage backend is `react-native-mmkv` — mobile-only. Desktop uses a different persistence layer. So the tracker storage cannot be shared as-is.
- The *policy* (attempt cap, age cap, `isPoisoned` predicate) is a tiny pure function, but **desktop has no consumer for it** — desktop already deletes-on-failure and therefore never hoards, so it has nothing to bound. Putting a single-consumer helper in shared is premature abstraction.
- Precedent: [hubLogCursor.ts](../../services/space/hubLogCursor.ts) is exactly this shape (per-key MMKV receive-path state) and lives mobile-local at `services/space/`, not in shared. Mirror it.
- **Revisit only if** desktop ever adopts bounded-retry (it won't without dropping its delete-on-failure policy); then promote just the pure `isPoisoned(attempts, ageMs, caps)` function to `quorum-shared/src/receipts` or `.../utils`, leaving each client its own storage adapter.

---

## Scope decisions (2026-07-23)

### Client scope: mobile now; desktop = flagged follow-up, NOT bundled
The freeze bug is **mobile-only** — desktop already deletes-on-failure, never hoards, never hangs the
batch. So the immediate fix ships mobile-only. BUT desktop is not "correct" either: delete-on-first-
failure is the opposite failure mode (black-hole — loses transient failures). Bounded-retry is the
right behavior for BOTH clients, so for true consistency desktop should eventually converge onto it.
Reasons NOT to bundle it here: (a) mobile and desktop have SEPARATE server inboxes (each device
deletes only its own mailbox), so the divergence corrupts no shared state — fixing mobile first breaks
nothing; (b) desktop's receive code + storage are structurally different; (c) desktop's delete-on-
failure is a deliberate documented tradeoff and the lead hasn't touched desktop in ~1yr → changing it
is lead-sensitive.
**FOLLOW-UP (raise with lead): converge quorum-desktop's MessageService failure path onto bounded-
retry so both clients handle undecryptable envelopes identically.** Deliberate consistency later, not
accidental divergence.

### Message-type scope: DM / device-inbox envelopes ONLY (REVISED 2026-07-23 after code verification)
**Superseded an earlier "cover both" call.** Verifying the drain loop proved channels must NOT be
skipped:
- **Skipping a channel message would re-open the cursor-wedge the sibling fix (1ce7bb1) just closed.**
  After each batch, [WebSocketContext.tsx:5017-5041](../../context/WebSocketContext.tsx#L5017) advances
  the per-hub cursor along a CONTIGUOUS run of `__logSeq` values found in the batch. If the gate
  removed a channel envelope from the batch, its seq disappears from that scan → the cursor stops at
  the gap → wedge. Proven, not hypothetical.
- **Channels structurally cannot hoard like DMs.** The cursor advances past a contiguous seq
  *regardless of decrypt success* (line 5037), so a channel message that fails to decrypt still lets
  the cursor move past it → `log-since` never refetches it → no infinite replay. DMs live in the
  device inbox, are deleted only on success, and replay forever on failure → the hoard is a DM
  phenomenon. The observed freeze confirms it: `native-batch(sp=0,dm=1)`.
- **`__logSeq`/`__logHub` is set only for hub-log/channel entries** ([5586-5596](../../context/WebSocketContext.tsx#L5586));
  DM envelopes never carry it → filtering DMs from the batch cannot touch the cursor scan. DM-scoping
  is therefore provably cursor-safe.

Conclusion: gate applies only to messages WITHOUT `__logSeq` (i.e. DM / device-inbox). Channel
receive logic, cursor logic, and the sibling fix are left completely untouched. (If space-INBOX
legacy-fan-out messages turn out to hoard on failure too, that is a SEPARATE future analysis of the
`deleteSpaceInboxMessages` failure path — not bundled here, to stay non-destructive.)

---

## Components

### 1. New file: `services/space/inboxAttemptTracker.ts` (mirror hubLogCursor.ts exactly)
MMKV store `id: 'quorum-inbox-attempts'`. Key = `${inboxAddress}/${timestamp}` (globally-unique envelope
id on the server inbox). Value = a plain **number** (attempt count) — same shape as the cursor helper,
no record/JSON needed, because the age check derives from the `timestamp` in the key itself.

```ts
const MAX_DECRYPT_ATTEMPTS = 5;                    // ~5 connects of retries before giving up
const MAX_ENVELOPE_AGE_MS  = 7 * 24 * 60 * 60_000; // 7 days: a still-failing week-old envelope is dead

recordAttempt(inbox, ts): number   // ++count; returns new count
getAttempts(inbox, ts): number
// A NEVER-ATTEMPTED envelope is NEVER poison, regardless of age — it always gets its first try.
// This protects the "user offline 8 days, legit old DM waiting" case from being dropped untried.
isPoisoned(inbox, ts): boolean =
     getAttempts() >= MAX_DECRYPT_ATTEMPTS
  || (getAttempts() >= 1 && (Date.now() - ts) > MAX_ENVELOPE_AGE_MS)
clearAttempt(inbox, ts): void      // on successful decrypt — remove the key (keeps the tracker itself from becoming a second hoard)
```
Notes:
- **CRITICAL SAFETY RULE — age only counts once a message has already failed ≥1 time.** A legit DM
  that arrives old (offline user returning) has `attempts === 0` on first sight → NOT poison → it is
  tried → it decrypts → delivered. Age-based skip can only ever apply to a message we have *already
  attempted and seen fail*. This is what stops the fix from dropping normal users' delayed-but-valid
  messages.
- **Cost for the existing 240 hoard:** connect #1 they're attempted once (the batch hangs → one 30s
  watchdog stall → timeout path records the attempt); from connect #2 on they satisfy
  `attempts ≥ 1 && age > 7d` → skipped forever. Net: ONE 30s stall, once, then clean. (Earlier
  "skip on connect #1 with zero stalls" was traded away deliberately to keep the offline-user case
  safe — the right trade.)
- **Age = the message's own age** (`Date.now() - ts`, ts = envelope send time in ms epoch, confirmed),
  not tracking age.
- Thresholds are conservative-generous: 5 attempts across reconnects is far more than any transient
  key-load race needs, while still bounding the hoard. Tune after one dev run; module consts.
- `clearAttempt` on success means only *currently-failing* envelopes ever hold a key.

### 2. The gate — DM-only skip, at the top of the drain iteration
In `processMessageQueue`, right after `const batch = messageQueueRef.current.splice(0, MAX_BATCH_DRAIN_SIZE)` ([WebSocketContext.tsx:4869](../../context/WebSocketContext.tsx#L4869)) and BEFORE `preclassifyAndGatherState(batch)`:

```
const now = Date.now();
const live = [];
for (const m of batch) {
  const isHubLog = !!(m as any).__logSeq;          // channel entry → NEVER gate (cursor coupling)
  if (!isHubLog && isPoisoned(m.inboxAddress, m.timestamp)) {
    // provably-dead DM envelope: never feed it to the native batch → prevents the freeze.
    // Skip-only: the envelope STAYS on the server (no delete). Fully reversible.
    // OPTIONAL (flag-gated): server-delete here — see §4.
    continue;
  }
  live.push(m);
}
// then: preclassifyAndGatherState(live)  (was: (batch))
```
- `isPoisoned` age uses the envelope's OWN `timestamp` (ms epoch — confirmed by desktop's
  `(Date.now() - envelope.timestamp)/1000` age math), BUT only applies after ≥1 recorded failure (see
  §1 CRITICAL SAFETY RULE). The existing 240 hoard is therefore attempted once (one 30s watchdog stall
  on connect #1) then skipped from connect #2 on — clean thereafter, and no manual A2 cleanup needed.
- Channel (`__logSeq`) entries bypass the gate entirely → cursor scan at 5017-5041 sees every seq it
  expects → sibling fix untouched.

### 3. Attempt counting — driven by the AUTHORITATIVE native result (not inference)
`BatchDMMessageResult` ([native-provider.ts:1316](../../services/crypto/native-provider.ts#L1316)) carries
`status: 'decrypted' | 'init_decrypted' | 'decrypt_failed' | 'no_state' | 'unseal_failed'` and the
original `timestamp`. So after `applyDMGroupResults` ([~4969](../../context/WebSocketContext.tsx#L4969)),
walk `batchOutput.dm_results[].messages`:
- status `decrypted` / `init_decrypted` → `clearAttempt` (a transient failure that recovered resets to zero).
- status `decrypt_failed` / `no_state` / `unseal_failed` → `recordAttempt` (climbs toward the cap).
Map each result back to its `inboxAddress` via the original `batch` by `timestamp` (results carry
`timestamp` explicitly "for inbox deletion matching"; `applyDMGroupResults` already does this join).

Also increment on the **timeout/throw path** ([4921-4941](../../context/WebSocketContext.tsx#L4921)): a
hung batch never returns results, so for every DM message in `batchInput.dm_groups` call `recordAttempt`
— otherwise a freshly-arrived poison DM (too new to trip the age cap) could stall the batch each session
without ever accumulating toward the attempt cap. (The existing hoard is handled by the age cap and does
not depend on this; this bounds NEW poison to at most a few 30s watchdog stalls before it's skipped.)

Note: the JS individual-fallback path swallows errors, so it is not a reliable counting site — the two
sites above (batch results + batch timeout) plus the age cap cover every regime that matters.

### 4. OPTIONAL server-delete of poisoned envelopes (flag-gated — the only lead-sensitive bit)
Default OFF. When `ENABLE_POISON_SERVER_DELETE` is on, at the skip point in §2 also call the appropriate delete for the envelope's inbox type:
- device inbox → `deleteInboxMessages(inbox, [ts], deviceKeyset)`
- space inbox → `deleteSpaceInboxMessages(...)`
- conversation inbox → `deleteConversationInboxMessages(...)`
Isolating deletion behind a flag means the SAFE fix (skip-only, no server mutation, no data risk) ships now; the server-cleanup half can flip on later after a lead ping, without touching any other logic. Skip-only already fully prevents the freeze — server-delete is purely to stop re-downloading the dead envelopes each connect (bandwidth, not correctness).

### 5. Optional: diagnostics
Count poisoned-skips per drain and surface via the existing `[CATCHUP-DIAG]` file writer so we can confirm on-device how many envelopes the gate catches (should equal ~240 on the test account's first post-fix connect, then drop toward 0). Strip with the rest of the diag instrumentation before PR.

---

## Failure-path inventory (where hoard entries are born — for context, NOT all need editing)
The gate in §2 is downstream of all of these, so it catches their output regardless. Listed so we understand coverage:
- [WebSocketContext.tsx:2926-2932](../../context/WebSocketContext.tsx#L2926) — DM "No encryption state" → return (no delete).
- [WebSocketContext.tsx:2937-2939](../../context/WebSocketContext.tsx#L2937) — DM decrypt empty/"Decryption failed" → return (no delete). **Primary hoard source.**
- Various DM `catch → return` sites (2905-2907 unseal error, etc.).
Space-inbox messages that decrypt successfully ARE deleted (20+ `deleteSpaceInboxMessages` call sites, all on success paths), so ordinary space traffic self-cleans — the hoard is dominated by DM decrypt-failures. Good: confirms blast radius is the DM path.

## Test / validation plan
1. Unit-test `inboxAttemptTracker`: attempt increments, cap trip, age trip, clear-on-success resets, key uniqueness.
2. Dev on-device (test account with the ~240 hoard):
   - First connect after fix: gate should skip the ~240 (they're already >5 attempts historically OR trip the age cap immediately since firstSeen unknown → see §Open Q1), native batch stays small, **no 30s watchdog stall**, user messages land.
   - Send 5 browser→mobile: 5/5 land.
   - Confirm tracker doesn't grow for successful traffic (clearAttempt working).
3. Transient-recovery check: force a message to fail once (e.g. delay key load), confirm it recovers on next attempt and its tracker entry clears (does NOT count toward poison).
4. Regression: normal DM + space send/receive both directions still fine.
5. Prod-preview sanity (many spaces + backlog) — no new drops, cursor still advances (sibling fix intact).

## Open questions — mostly RESOLVED by code verification (2026-07-23)
1. ~~First-seen for the existing hoard~~ **RESOLVED:** age uses `envelope.timestamp` (message age) but
   only after ≥1 recorded failure (safety rule protecting offline-user old DMs). Existing hoard = one
   30s stall on connect #1, then skipped forever. No A2 needed.
2. ~~`BatchProcessOutput` shape for success→(inbox,ts) mapping~~ **RESOLVED:** `BatchDMMessageResult`
   carries `status` + `timestamp`; `applyDMGroupResults` already joins results→batch. Count on real
   statuses (§3).
3. ~~Channel/space scope + cursor interaction~~ **RESOLVED:** DM-only; channels bypass the gate because
   skipping them would re-wedge the cursor (proven, 5017-5041). See Scope decisions.
4. **Remaining, minor:** threshold tuning (5 / 7d) — confirm against one dev run. And a quick check that
   no enqueue path other than `messageQueueRef` → `processMessageQueue` reaches the native DM batch
   (the notification-time `hubLogClassifier.ts:143` batch path is space-only + separate; out of scope).

## Relationship to shipped work
- Complements, does not replace, the watchdog (ed1aeaa): watchdog = reactive 30s cap on ANY hung batch; this = proactive prevention so the hung batch never forms from known poison.
- Independent of the cursor-wedge fix (1ce7bb1); both can co-exist and ship together on this branch.
- With Option C in place, the manual A2 one-time cleanup becomes unnecessary — the gate clears the test-account hoard automatically on the first post-fix connect (given Open Q1's envelope-timestamp seeding).

---

## IMPLEMENTED 2026-07-23 (skip-only, DM-only, delete flag OFF)
Files:
- NEW `services/space/inboxAttemptTracker.ts` — MMKV counter + `isInboxEnvelopePoisoned` /
  `recordInboxAttempt` / `clearInboxAttempt` (mirrors hubLogCursor.ts). Safety rule: never-attempted
  envelope is never poison (age only bites after ≥1 recorded failure).
- `context/WebSocketContext.tsx`:
  - import the tracker (next to hubLogCursor).
  - gate: `let batch` + `.filter` after the splice — drop poisoned DM envelopes; hub-log (`__logSeq`)
    entries exempt (cursor-safe).
  - build `dmInboxByTs` from `batchInput.dm_groups` before the native call.
  - timeout/throw path: `recordInboxAttempt` for every DM in the hung batch.
  - after `applyDMGroupResults`: clear on `decrypted`/`init_decrypted`, count on
    `decrypt_failed`/`no_state`; `unseal_failed` deliberately NOT counted (routes to JS fallback).

Verification: `npx tsc --noEmit` — no NEW errors (the lone `throttledMessageHandler`/`MessageHandler`
error is pre-existing on baseline, confirmed by stash-and-recheck). `npx eslint` on both files — exit 0,
no warnings from new code.

Not done (deliberate): server-side delete (flag parked), desktop convergence (lead follow-up), on-device
run against the test-account hoard (expect: one 30s stall on first connect while the hoard is tagged,
then no further stalls; sent test messages land).

---
*Last updated: 2026-07-23*
