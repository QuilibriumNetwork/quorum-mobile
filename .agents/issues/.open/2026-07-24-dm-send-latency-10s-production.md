---
type: bug
title: "DM send takes ~10-11s — reproduces in production (live app + preview build), not dev-only"
status: open
created: 2026-07-24
updated: 2026-08-16
severity: medium-high (every DM takes ~10s to send for the affected account; pending a fresh-account test to confirm whether all users are hit or only churn-affected accounts)
area: DM send path / native crypto bridge (quorum-crypto) / encryption-state storage / device registration fetch
related:
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (§0 item 3: junk encryption-state cleanup, '8052 state rows ... every DM op iterates them'; §5 Run 5 'prod-preview instant' — see reconciliation below)"
  - "PR #175 (honest send-status work; makes the slow send visible but does NOT cause it and is out of its scope)"
---

# DM send takes ~10-11s (production, not dev-only)

## Status

**2026-08-16 — partially fixed; verify what remains.** The 2026-07-27 recap
recorded this as partially fixed by PR #176, with the remainder likely closed by
PR #177, pending a verification that never happened. Measure whether the latency
still reproduces before starting, rather than assuming either state.

_Carried over from `RECAP.md`'s 2026-07-27 audit, which flagged this file as
possibly stale. Recorded here so the caveat travels with the issue instead of
living only in a dashboard that has to be regenerated to be believed._


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

## Symptom

Sending a DM takes **~10-11 seconds** before it is actually transmitted. **Confirmed 2026-07-24 in
BOTH a preview production build AND the real live app** — so this is a genuine production bug, not a
dev-environment artifact.

> **Correction (2026-07-24):** an earlier version of this report concluded "dev-only, prod is
> instant," based on the transport master report's Run 5. That was WRONG — direct testing on
> live + preview reproduces the ~10-11s. Run 5's "instant" was a _different, healthy_ device/account
> pairing (the report itself flags Run 5 as "a DIFFERENT device/account pairing whose sessions
> happened to be healthy") and is not representative of the churned test account.

## What is NOT the cause (ruled out 2026-07-24)

- **Not the native crypto build mode.** `libchannel.so` / `libuniffi_channel.so` are ~1.9 MB each (release-compiled; a debug Rust lib would be 20-100 MB). And it's slow in release builds anyway.
- **Not ghost-device count alone.** `[SEND-TIMING]` showed the same ~10s at `devices=6` (recipient 2 + sender 5) as at `devices=15`. Reducing device count barely helped.
- **Not a dev-runtime effect** (Hermes-in-dev, RN-bridge-dev): it reproduces in optimized production builds, so the cause is constant across build types.

## Measured breakdown (temporary `[SEND-TIMING]` logs, since removed)

- `sign` ≈ **2.6-3.5s** for a SINGLE Ed448 signature (should be sub-millisecond). Roughly constant regardless of device count.
- per-device encryption ≈ **~1s each** (`fromPrep` ≈ 6-7s for 6 devices).
- Two `fetchUserRegistration` network round-trips on every send (part of `prep`).
- Successive rapid sends **stack** (total grew 12s → 15s → 22s across 3 quick sends) → the send path serializes.

To reproduce the numbers, re-add `logger.warn('[SEND-TIMING] ...')` timing around signing, device
gathering, and the `onFlushed` callback in `hooks/chat/useSendDirectMessage.ts`. NOTE: use
`console.log` or `logger.warn` — `logger.debug` is filtered out of the dev terminal.

## Leading hypothesis: junk encryption-state bloat (churn debris)

Because it's slow in prod too, the cause is **data or per-call work, not build mode.** The strongest
candidate: the test account accumulated **thousands of unconfirmed Double-Ratchet state rows** during
the churn era (the master report saw **one conversation at 8052 rows** and lists "[MED] Junk
encryption-state cleanup" precisely because _"every DM op iterates them"_). If signing/encryption
reads or iterates that state per operation (× devices), thousands of junk rows would make every
crypto call take seconds — in dev AND prod — and would be **worse on churned accounts, fast on fresh
ones.** This also reconciles Run 5 ("instant" on a healthy pairing) vs. this account (slow).

**Decisive cheap test: send a DM from a BRAND-NEW account (no churn history).** If it's fast, the
cause is junk state → the fix is pruning unconfirmed/old state rows (master report item 3). If a
fresh account is ALSO ~10s, junk state is exonerated and it's one of the below.

## Other hypotheses (if the fresh-account test is also slow)

1. **Native bridge / per-call cost.** The module uses JNA (`net.java.dev.jna`) for the uniffi bindings; if each `signEd448` / encrypt call carries heavy per-call marshaling or the Rust channel crate re-initializes/re-derives state per call, that's seconds × operations. Profile Kotlin-side (time inside the Expo module around the uniffi call) vs the JS `await` to localize bridge-vs-compute.
2. **Per-send registration re-fetch.** Every send to an established conversation re-fetches BOTH users' registrations over the network (`hooks/chat/useSendDirectMessage.ts` ~line 290 fallback) instead of using cached device info / existing sessions. Wasteful regardless; a real fix independent of the crypto cost.
3. **Send-path serialization** (the stacking): sends process one at a time (and behind inbound in the WS client's `processQueues`).

## First steps for the investigator (in order)

1. **Fresh-account send test** — brand-new account, time one DM. Fast ⇒ junk state; slow ⇒ hypotheses 1-3. This one test splits the whole problem.
2. If junk state: measure the state-row count for the conversation (encryption-state storage) and prototype a prune of unconfirmed/old rows; re-time.
3. If not junk state: add Kotlin-side timing around ONE `signEd448` uniffi call to separate JNA/bridge time from Rust execution time.
4. Regardless: fix hypothesis 2 (stop re-fetching both registrations every send) — it's a clear win.

## Investigation session 2026-07-24 (Fable) — code analysis + instrumentation branch

**Branch `debug/dm-send-latency-timing`** (commit `6023f80`) carries full `[SEND-TIMING]`
instrumentation. ONE dev-run send on the affected account should localize the whole ~10s.
Instrumented points:

- `signMessageIdHash` — splits `getPrivateKey` / `getPublicKey` (SecureStore reads) from the
  native `signEd448` call. If the 2.6-3.5s "sign" is mostly SecureStore or mostly bridge-await,
  this shows it directly.
- `sendEncryptedMessageToAllDevices` — logs **`getEncryptionStates` row count + duration**
  (the junk-state hypothesis measured directly, no fresh account needed), session split
  (new vs existing), keypair prep, subscribe, **queueWait** (time the prep callback waits for
  its slot in the WS `processQueues` drain — hypothesis 3), per-device encrypt duration, and
  total prep-callback time up to `onFlushed`.
- `encryptionService.encryptMessageForNewDevice` — splits mutexWait / establishSession (X3DH,
  3-4 native calls) / drEncrypt per device.
- `encryption-state-storage` — global slow-call logging (>50ms) on `getEncryptionStates` and
  `getStatesByInboxId`, so RECEIVE-path scans on the churned conversation show up too,
  whatever the caller.
- **JS event-loop lag probe** — runs for 20s from mutation start, logs any >200ms stall and the
  max lag. Key discriminator, see below.

**Analysis findings that motivated this instrumentation:**

1. **A single native call cannot be intrinsically serialized behind others.** The Kotlin module
   runs every crypto `AsyncFunction` on `CoroutineScope(Dispatchers.Default)` (multi-threaded,
   [QuorumCryptoModule.kt:26](../../modules/quorum-crypto/android/src/main/java/expo/modules/quorumcrypto/QuorumCryptoModule.kt#L26)) —
   so a 3s `signEd448` is NOT the Rust code being slow and NOT (by itself) queueing behind
   `batchProcessMessages`. Since the timing was measured JS-side, the leading explanation is
   **JS-thread saturation**: every `await` in the send path (sign does 3: two SecureStore reads
   - one native call) must wait for the JS event loop to be free before its resolution runs.
     Three awaits × ~1s stall each ≈ the constant 2.6-3.5s. The lag probe proves/disproves this
     in one run.
2. **The junk-state mechanism is real and on the JS thread.**
   [encryption-state-storage.ts `getEncryptionStates`](../../services/crypto/encryption-state-storage.ts#L183)
   does one synchronous MMKV `getString` + `JSON.parse` of a full ratchet-state blob **per row**.
   At 8052 rows × multi-KB blobs that's a multi-second synchronous JS-thread stall per call. It
   is called on EVERY send ([useSendDirectMessage.ts:889](../../hooks/chat/useSendDirectMessage.ts#L889))
   and — worse — on the RECEIVE path per init envelope
   ([encryption-service.ts:821](../../services/crypto/encryption-service.ts#L821) in
   `initializeRecipientSession`) plus ~8 more sites in WebSocketContext. On a churned account the
   receive drain can therefore keep the JS thread pinned, which would ALSO explain the slow
   "sign" (see 1) and the send stacking. Fresh accounts have few rows ⇒ fast. This unifies all
   the observations without needing the crypto layer to be slow at all.
3. **Send prep runs inside the WS drain** (`enqueueOutbound` callback), serialized behind
   inbound queue processing — `queueWait` measures that directly (hypothesis 3).

**How to run:** `git checkout debug/dm-send-latency-timing`, start the dev app on the affected
account, send ONE DM, collect every `[SEND-TIMING]` line. NOTE: the app must RELOAD the JS bundle
after checkout (restart the app) — on 2026-07-24 the first test showed no logs because the device
was still running the pre-checkout bundle.

## ⚡ MEASURED RESULTS 2026-07-24 (two live sends, Motorola Edge 50 Fusion, dev build via logcat)

| Component                                                               | Send #1 (5.25s total)   | Send #2 (8.40s total)                   | Verdict                                        |
| ----------------------------------------------------------------------- | ----------------------- | --------------------------------------- | ---------------------------------------------- |
| SecureStore reads (getPrivateKey + getPublicKey + getDeviceKeyset)      | **2.24s**               | **1.75s**                               | constant tax, every send                       |
| fetchUserRegistration ×2 (network)                                      | 0.52s                   | **3.69s** (recipient fetch alone 3.53s) | variable, every send                           |
| Per-device encrypt, 6 devices, ALL unconfirmed → full X3DH re-init each | **2.47s**               | **2.94s**                               | constant tax, every send                       |
| nativeSignEd448                                                         | 0.68s (contended)       | **0.10s** (uncontended)                 | native crypto is FINE                          |
| getEncryptionStates scan                                                | rows=37, 1-2ms          | same                                    | **junk-state hypothesis DEAD on this account** |
| queueWait (WS drain)                                                    | 6ms                     | 0ms                                     | not a factor                                   |
| JS-loop maxLag                                                          | 1.68s spikes throughout | same                                    | inflates every await                           |

**Diagnosis — the ~10s is three independent per-send taxes, all fixable, none of them native crypto:**

1. **~1.5-2.2s: SecureStore/Keystore reads on every send.** `getPrivateKey` ≈ 750-900ms,
   `getDeviceKeyset` ≈ 665ms, `getPublicKey` ≈ 80-160ms — every single send re-reads immutable
   keys through Android Keystore. The old report's "sign ≈ 2.6-3.5s" was ~85% SecureStore +
   await-scheduling, NOT Ed448 (nativeSignEd448=101ms uncontended). **Fix: in-memory cache of
   the three values after first read.**
2. **~0.5-3.7s: two registration fetches on every send** (hypothesis 2 confirmed; recipient
   fetch hit 3.5s on send #2). `allTargetDevices` arrives empty from the caller so the fallback
   always fires. **Fix: cache registrations (TTL) or pass devices from the conversation screen.**
3. **~1.7-2.9s: ALL 6 device sessions are permanently UNCONFIRMED** (`session split: newSession=0
existingSession=6`, every one taking the `unconfirmed-session re-init` branch). Every send —
   and every receipt/edit/profile fan-out (a phantom 6-envelope prep with no mutationFn ran at
   app start) — re-runs full X3DH + init-envelope for 6 devices. Sessions only confirm when the
   peer REPLIES from that device; ghost devices never reply ⇒ never confirm ⇒ full X3DH forever.
   This ties the latency directly to ghost-device accumulation (master item 0.4) and/or a confirm
   step that isn't landing even for the ACTIVE peer device despite #170. **Fix: investigate why
   the active device's session doesn't confirm; deregister ghosts; consider capping re-init
   fan-out.**

Sends stack because each pays all three taxes serially on a saturated JS loop (maxLag 1.7s).

## Note on scope

Earlier this report said "do not touch crypto — prod is fine." **That guidance is retracted:** prod
is NOT fine. But still profile to localize the cost (junk state vs bridge vs Rust vs network) BEFORE
optimizing — and native/Rust changes may need lead-dev / crypto expertise (LaMat is not confident
touching the crypto layer directly).

---

_Last updated: 2026-07-24_
