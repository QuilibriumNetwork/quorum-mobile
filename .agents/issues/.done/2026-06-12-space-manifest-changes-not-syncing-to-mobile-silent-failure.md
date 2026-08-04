---
type: bug
title: "Desktop space changes (name, channels, read-only) don't reach mobile — Android 32-bit timestamp overflow drops all control messages"
status: done
fixed-in: "PR #79 (squash 1f5a5f5) on master"
created: 2026-06-12
severity: high
repo: quorum-mobile
root-cause: "Android QuorumCryptoModule.kt used optInt (32-bit) to read the millisecond-epoch timestamp; it overflowed to negative, so the JS batch path could never match control messages back to their source and dropped them all (space-manifest, etc.). iOS (64-bit Int) and desktop (JS number) were already correct."
fix: "optInt -> optLong at QuorumCryptoModule.kt:883 (space) + 1149 (DM). Native change -> needs rebuild."
index: ../reports/2026-06-12-permission-and-message-parity-findings-index.md
---

# Desktop space changes don't sync to mobile (Android timestamp overflow)

> **✅ FIXED + RUNTIME-VERIFIED + MERGED (PR #79, squash `1f5a5f5`, 2026-06-13).** Root cause: Android-only 32-bit `optInt` timestamp overflow dropped all incoming control messages. Fix: `optInt` -> `optLong`. **Runtime-verified on a physical Android device 2026-06-13**: a live desktop space change (rename + add channel) appeared on mobile within seconds, `[space-manifest] applied + saved` logged, and the previous hundreds of negative-timestamp `[batch-control] dropped` errors were GONE (0). The instrumentation below revealed the failure (the NEGATIVE `ts=-1134049747`); the handler-gate analysis further down was pre-diagnosis hypothesis, kept for history.
>
> **Note — the REVERSE direction (mobile -> desktop) is a SEPARATE bug, not this one.** Channel rename/delete (and other channel/group edits) made ON mobile don't reach desktop because `hooks/chat/useChannelManagement.ts` never broadcasts (no `broadcastSpaceUpdate`/`enqueueOutbound`). That's already documented + fixed on branch `fix/channel-reorder-broadcast` (task `2026-05-29-channel-reorder-mutations-should-broadcast.md`), unmerged. Not part of this fix.

> Found 2026-06-12 while verifying the read-only enforcement work. **Confirmed at runtime:** changed a space name + set a channel read-only + removed channels on desktop; on mobile the changes do NOT appear, and a full JS bundle reload (cache wiped, fresh read from MMKV) still shows the old state — so the updated manifest **never made it into mobile's storage**.

## Confirmed root cause (Android 32-bit timestamp overflow)

The instrumentation produced hundreds of:
```
WARN  [batch-control] dropped: no original batch message for ts=-1134049747
WARN  [batch-control] dropped: no original batch message for ts=-1131649751
```
The **negative timestamp** is the smoking gun. Trace:

1. Control messages (incl. `space-manifest`) arrive via the batch hub-log path and are decrypted by the native Android crypto module.
2. `modules/quorum-crypto/android/.../QuorumCryptoModule.kt:883` (space) and `:1149` (DM) read the timestamp with **`msg.optInt("timestamp", 0)`** — `optInt` is **32-bit**. A real ms-epoch timestamp (~`1.749e12`) overflows int32 and wraps to a negative value (e.g. `-1134049747`). That wrapped value is echoed into every result via `put("timestamp", timestamp)`.
3. Back in JS, `context/WebSocketContext.tsx` (batch path, ~line 3026) matches the result to its source message by **strict timestamp equality**: `batch.find(m => m.timestamp === msgResult.timestamp)`. The source message has the correct full-precision timestamp; the result has the overflowed negative one. **The match never succeeds**, so `originalMsg` is `undefined` and the control message is dropped — never reaching `handleIncomingMessage` / the space-manifest handler.

**Why only control messages broke:** regular `decrypted`/`plaintext` results operate on `msgResult.decrypted_message` directly and never do the timestamp lookup. Only `control` results need to find the original message → only they hit the failing match.

**Why Android-only:** iOS reads `msg["timestamp"] as? Int` and `Int` is 64-bit on Apple silicon (`QuorumCryptoModule.swift:930/1242`) — no overflow. Desktop/shared use `timestamp: number` (64-bit JS double) — no overflow. Android was the sole outlier.

**Fix applied:** `optInt` -> `optLong` (64-bit) at `QuorumCryptoModule.kt:883` and `:1149`. `optLong` preserves the full value; the `put("timestamp", ...)` calls then serialize it correctly; the JS match succeeds; control messages flow. **Native change -> requires `build-app.ps1` rebuild before it takes effect.**

This is a real mobile (Android) bug, fixed on mobile. Desktop and iOS were already correct, so there is nothing to change there.

---

## Original symptom (pre-diagnosis)

A space change made on desktop (rename, add/remove channels, set channel read-only, etc.) does not reflect on mobile. Confirmed it's not a UI cache issue: after a full bundle reload (which re-reads MMKV) the change is still absent, so the data isn't in mobile storage at all.

## Why it matters now

This is the upstream cause of the read-only ENFORCE feature "not working" for newly-set read-only channels. Our enforcement (PR #76) is correct — it reads `isReadOnly` from the stored channel — but if the manifest carrying `isReadOnly` never saved, there's nothing to enforce. (A read-only channel set long ago, before this failure or which did sync, DOES enforce correctly on mobile — verified.)

## Root cause area: the space-manifest handler fails 100% silently

`context/WebSocketContext.tsx` `case 'space-manifest'` (the handler that applies desktop's manifest broadcasts) has **~10 failure exits, none of which logged anything**, and an **empty catch block** that swallowed every thrown error:

```ts
} catch (err) {
  if (err instanceof Error) {
  }   // ← empty. all throws vanished.
}
```

So the manifest was being rejected at one of these gates with zero evidence:

| Gate | Condition | Was it logged? |
|---|---|---|
| no `manifest` field | `!manifest` | no (`break`) |
| `getSpaceRegistration` network call | throws on network error / 404 | no (empty catch) |
| owner key check | `manifest.owner_public_key` not in `spaceReg.owner_public_keys` | no (`break`) |
| Ed448 signature | `verifyEd448` returns false / throws | no |
| config key | `getSpaceKey(spaceId,'config')` null | no (`break`) |
| `JSON.parse(space_manifest)` | not valid JSON | no (empty catch) |
| `decryptInboxMessage` | stale/missing config key → throws | no (empty catch) |
| `JSON.parse(decryptedText)` | garbled decryption | no (empty catch) |
| batch path: `control_payload` falsy | native returned no payload | no (silent skip) |
| batch path: `originalMsg` not found | timestamp mismatch | no (silent skip) |

## Ranked suspects (hypotheses — not yet confirmed which one)

1. **Config-key mismatch after a kick/rekey (most likely).** If anyone was kicked from this space, the config key rotates. Remaining members get a `'rekey'` control message; if mobile missed/failed to process it (its handler ALSO had an empty catch), mobile keeps the OLD config key and `decryptInboxMessage` throws on every future manifest → silent drop.
2. **`getSpaceRegistration` network failure.** The handler does a live HTTP GET while processing each manifest; any transient failure silently kills the update (no retry/queue).
3. **Signature byte-mismatch** between desktop's signer (`broadcastSpaceUpdate.ts` signs `TextEncoder(ciphertext)+timestamp`) and mobile's verifier (`TextEncoder(manifest.space_manifest)+timestamp`). If serialization differs, all manifests fail systematically.
4. **Batch-path drop** (`control_payload` falsy / `originalMsg` not found) before the handler is even reached.

## What was done (this branch: `debug/space-manifest-sync-logging`)

**Instrumentation only — no behavior change.** Added distinct `logger.warn` calls (tag `[space-manifest]` and `[batch-control]`) to every silent failure exit + the empty catch + a success line, including the truncated `spaceId` and the failure reason. **No keys or decrypted content are logged.** This makes the next reproduction self-diagnosing.

### Secondary finding (logged, not the primary cause)
Even on SUCCESS, the handler updates `queryKeys.spaces.detail` + `spaces.all` but never invalidates `queryKeys.channels.bySpace(spaceId)` (which `useChannels` reads, `staleTime: 5min`). So even when a manifest DOES save, channel-level UI changes (name, read-only) can lag up to 5 min / until remount. This is a real but secondary bug — fix alongside the root cause once identified.

## Next step (diagnosis)

Reproduce: change a space on desktop, watch mobile Metro/logcat for `[space-manifest]` / `[batch-control]` lines. The reason in the log identifies the exact gate. Then fix that specific root cause (and the secondary channels-invalidation issue).

Greppable strings to look for:
- `[space-manifest] received for space=` — handler was reached
- `[space-manifest] applied + saved for space=` — success
- `[space-manifest] dropped: ...` — which gate rejected it
- `[batch-control] dropped: ...` — dropped before reaching the handler

---

*Last updated: 2026-06-12*
