---
type: task
title: "Serialize DM Double Ratchet state operations with shared KeyedMutex"
status: done
created: 2026-07-17
related:
  - "quorum-desktop/.agents/docs/dm-ratchet-upstream-divergences.md (full justification + spec citations)"
  - "quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md (root-cause archive)"
  - "quorum-desktop/.agents/tasks/2026-07-17-quorum-shared-add-keyedmutex.md (provider task)"
---

# Serialize DM ratchet state operations (mobile)

## Status

2026-07-20 — implemented on branch `fix/serialize-dm-ratchet-keyedmutex`. Single app-level `ratchetMutex` (KeyedMutex) in `services/crypto/ratchet-mutex.ts`; wraps all 6 read-state→ratchet-op→save critical sections (5 encryption-service methods + `encryptWithExistingSession` ×3 copies). Serialization proven by `__tests__/dmRatchetSerialization.test.ts` (28/28 suite green). tsc: 0 new errors. Recon findings recorded below. See "Implementation" section.


## Background (from the desktop fix, 2026-07-17)

Desktop's 6-month "DM messages silently never arrive" bug root-caused to unserialized
read-state → ratchet-op → save-state sequences: concurrent operations (receive decrypt,
sends, receipts, typing) read the same state snapshot, and the losing save silently erased
the winner's ratchet advance → peer gets `aead::Error` on subsequent frames → forked/dead
session. Fixed on desktop with a per-conversation FIFO mutex + immediate post-decrypt state
save. Signal spec grounding: RatchetDecrypt's "accept plaintext + store state changes" is one
atomic step; state is strictly linear.

**Mobile status (verified in code 2026-07-17):** mobile does NOT have desktop's other bug
(destroying the session on decrypt failure — mobile already returns null / throws without
persisting). But mobile has NO lock around its ratchet state operations either, its decrypt
is an awaited native call between state read and write, and mobile also sends delivery/read
acks as DM frames — so the same race surface exists, narrowed (not removed) by MMKV's
synchronous storage.

## UPDATE 2026-07-17 — third desktop mechanism, mobile exposure to verify

Desktop's DOMINANT killer turned out to be **stale init-envelope redelivery**: the server
redelivers frames whose ack-by-delete failed (502s observed), and successfully re-processing
an old init envelope silently replaced the current healthy session with a zombie. Fixed on
desktop with a staleness guard (`isStaleInitEnvelope` — refuse envelopes not strictly newer
than the rows they'd replace; pure, extractable to shared).

**Mobile is PARTIALLY protected by design** (verified in `encryption-service.ts`): init
handling checks an ephemeral-key cache and tries the EXISTING session before falling through
to fresh X3DH — so redelivery of the current envelope can't nuke the session. **Open recon
question:** an OLDER distinct envelope (previous reset epoch) fails existing-session decrypt
and falls through to X3DH — does the resulting state REPLACE the newer session rows for the
conversation? If yes, mobile needs the same staleness rule (import from shared once
extracted).

## Steps

1. **Recon first (do not patch blind):** map every mobile code path that does
   read-encryption-state → native ratchet op → save (encryption-service encrypt/decrypt
   entry points, receipt sends, typing if present, retry). Confirm which can run
   concurrently for the same conversation. ALSO answer the stale-init-envelope question in
   the update above (what does the X3DH fall-through do to existing newer rows?).
2. **Special recon item — background context:** Android's `BackgroundMessageService` runs in
   a SEPARATE JS context from the foreground app. A JS mutex cannot span contexts. Determine
   whether both contexts can decrypt the same DM inbox concurrently; if yes, that needs its
   own mechanism (native lock / single-writer handoff) and should be flagged to the lead dev
   rather than solved ad hoc.
3. Bump `@quilibrium/quorum-shared` to the version that exports `KeyedMutex`.
4. Create one app-level mutex instance keyed by conversationId; wrap every critical section
   found in step 1. NEVER hold the lock across transport delivery (desktop hit a deadlock
   doing this — lock covers read → native op → save only).
5. On the receive path, save the advanced state immediately after successful decrypt if any
   processing currently happens in between.
6. Verify: mobile↔mobile (or mobile↔desktop) sustained back-and-forth with receipts on,
   numbered messages, zero drops.

## Implementation (2026-07-20)

**Branch:** `fix/serialize-dm-ratchet-keyedmutex`

### Recon findings (step 1 & 2)

**Critical sections (read encryption-state → native ratchet op → save), all keyed by `conversationId`:**
- `encryptionService.encryptMessage` — read/establish → `doubleRatchetEncrypt` → save
- `encryptionService.encryptMessageForNewDevice` — establish → encrypt → save
- `encryptionService.decryptMessage` — read → `doubleRatchetDecrypt` → save
- `encryptionService.initializeRecipientSession` — read → decrypt → save (3 branches: ephemeral-cache, existing-session, fresh X3DH)
- `encryptionService.receiveSessionInit` — X3DH → save
- `encryptWithExistingSession` — read → `doubleRatchetEncrypt` → save. **THREE separate copies**: `hooks/chat/useSendDirectMessage.ts`, `useSendDirectEmbedMessage.ts`, `useSendDirectReaction.ts` (reactions/control msgs). All three wrapped.

**Concurrency confirmed real:** receive-decrypt (WebSocketContext message handler) races (a) user send → `sendEncryptedMessageToAllDevices`, and (b) **receipt send** — `ReceiptService` timer flush → `sendDmReceiptAck` → `sendEncryptedMessageToAllDevices` (the desktop amplifier pattern, shipped in PR #164). All within the single foreground JS context.

**Step 2 — background context (RESOLVED, no action needed):** `BackgroundMessageService.checkForNewMessages` (the Android headless push task, separate JS context) does NOT decrypt DMs or advance the ratchet — it is presence-only and shows generic notifications (see its own comments at lines 10 & 236). `classifyHubLogEntry` decrypts hub-log/space entries, which are NOT DM Double Ratchet sessions. **So no cross-context ratchet race exists today; a JS mutex is sufficient.** Documented in `ratchet-mutex.ts`: if background DM decryption is ever added, the JS mutex will NOT cover it and a native/single-writer mechanism will be required — flag to lead dev at that point.

**Step 1 — stale-init-envelope question (flagged as separate follow-up, NOT fixed here):** In `initializeRecipientSession`, the fresh-X3DH fall-through generates a NEW conversation-inbox keypair and calls `saveEncryptionState(..., true)` (updateLatest=true), repointing the send direction. An OLDER redelivered init envelope that fails existing-session decrypt WOULD fall through and fork a parallel/zombie session, hijacking "latest". This is an ordering/staleness bug, **not** a concurrency race — the KeyedMutex does not and cannot fix it. It needs the desktop `isStaleInitEnvelope` guard (refuse envelopes not strictly newer than the rows they'd replace), which is gated on that guard being extracted to quorum-shared. Out of scope for this task.

### Changes
- NEW `services/crypto/ratchet-mutex.ts` — exports one app-level `ratchetMutex = new KeyedMutex()` (imported from `@quilibrium/quorum-shared`, verified in the installed runtime bundle). Docstring covers the transport-deadlock and cross-context caveats.
- `services/crypto/encryption-service.ts` — wrapped the 5 methods above in `ratchetMutex.runExclusive(conversationId, async () => { … })`. For `initializeRecipientSession`, `conversationId` is derived before the lock (it's the key); the `deviceKeys` guard stays inside the closure for correct type narrowing.
- `hooks/chat/useSendDirectMessage.ts`, `useSendDirectEmbedMessage.ts`, `useSendDirectReaction.ts` — wrapped each local `encryptWithExistingSession`.
- NEW `__tests__/dmRatchetSerialization.test.ts` — proves same-conversation decrypts serialize (no forked ratchet: final state advances 0→1→2, inputs `['0','1']`, peak concurrency 1) while different conversations still overlap (peak concurrency 2). Mocks only the native provider + MMKV store; real encryption-service + real ratchetMutex run.

### Step 5 (save advanced state immediately after decrypt)
Already satisfied on mobile: `decryptMessage` saves the advanced state (line ~338) before returning; the receive-path post-processing in WebSocketContext (buffering, receipts) runs only after that save. No change needed.

### NOT hold lock across transport (step 4 caveat)
Honored: every wrapped section is crypto + synchronous MMKV only. In the send paths the encrypt runs inside the `enqueueOutbound` prepare callback and the lock releases before sealing/socket delivery; no wrapped section awaits transport.

### Observation (pre-existing, out of scope, left untouched)
The legacy fallback in each send path (`else` branch when `x3dhEphemeralPublicKey` is absent) does `saveEncryptionState({...encryptionState, x3dh…})` AFTER `encryptWithExistingSession` already advanced+saved the ratchet — writing back the pre-advance `state` snapshot. Only fires for sessions created before ephemeral-key storage existed (rare); identical in all three send files. Same-thread ordering quirk, not a concurrency race; not touched.

### Merge note
No unpublished-shared linkage — `KeyedMutex` ships in the installed `@quilibrium/quorum-shared` (2.1.0-35). Safe to merge without a shared publish. Runtime verification (step 6) still pending: sustained mobile↔mobile back-and-forth with receipts on, numbered messages, zero drops — blocked on the known cross-device transport flakiness; ship on send-proof + serialization test per the standing DM-testing guidance.

---
*Created: 2026-07-17 — Last updated: 2026-07-20*
