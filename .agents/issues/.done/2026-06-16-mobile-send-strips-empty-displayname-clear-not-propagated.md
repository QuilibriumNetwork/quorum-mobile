---
type: bug
title: "Mobile per-space save strips an empty displayName, so clearing a per-space name never reaches other clients"
status: done
severity: medium
created: 2026-06-16
found_by: user testing PR #105, 2026-06-16
area: profile sync (send side) + shared spaceMessageService
related:
  - PR #105 (honor-displayname-clear fixed the RECEIVE side; this is the symmetric SEND-side gap)
  - issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md (Symptom B — blocks runtime-verifying any fix)
---

# Mobile strips an empty displayName on send → per-space name clears don't propagate

## Symptom (observed in app, 2026-06-16)

In a space's Settings → Account, the user cleared their per-space **display name**
on **mobile** and saved. Locally the field is now empty. But on **desktop**, the
old per-space name is still shown — the clear never propagated mobile → desktop.

(Reported alongside a separate desktop → mobile non-delivery, which is the known
Symptom B crypto wall, NOT this bug.)

## Root cause (verified in source)

This is the **symmetric counterpart** of the receive-side fix shipped in PR #105
(`honor-displayname-clear`): mobile's *receivers* now honor `displayName: ''` as a
deliberate clear, but mobile's *senders* refuse to put an empty displayName on the
wire. Two layers strip it:

1. **`components/SpaceSettingsModal.tsx` `handleSaveSpaceProfile` (~line 718-719):**
   ```ts
   if (spaceProfileDisplayName !== spaceProfileBaseline.displayName) {
     params.displayName = spaceProfileDisplayName || undefined;   // '' → undefined
   }
   ```
   The change IS detected (`!== baseline`), but `|| undefined` converts the cleared
   value to `undefined`, i.e. "field omitted" → receiver reads omission as "no change".
   (Note `bio` two lines down sends the raw value, so bio-clear is NOT stripped here —
   only displayName and userIcon get the `|| undefined` treatment.)

2. **`services/space/spaceMessageService.ts` `sendUpdateProfileMessage` (~line 823):**
   ```ts
   ...(displayName ? { displayName } : {}),   // truthy guard — drops '' even if passed
   ```
   So even if SpaceSettingsModal passed `''`, the service layer strips it. The dedup
   signature `profileBroadcastSignature` (~line 858) also uses `if (p.displayName)`
   (truthy), so a clear wouldn't even register as a new payload.
   Compare `bio` at ~line 825: `...(bio !== undefined && { bio })` — already correct.

## Why it's not a one-line fix (clobber risk)

`spaceMessageService` is shared by **multiple senders**, including the **on-connect
rebroadcast** (`WebSocketContext.tsx`, the profile-rebroadcast useEffect) which blasts
ALL profile fields on every reconnect. The truthy-strip at line 823 is what protects
that path from broadcasting an incidental empty field and clobbering everyone's stored
value. The comment at `SendUpdateProfileParams` (lines 795-799) documents this on purpose.

So honoring a clear requires distinguishing **"user explicitly cleared this field"
(send `''`)** from **"this field happens to be empty, leave it alone" (omit)** — intent
that lives at the call site, not in the service.

## Suggested fix (for a focused follow-up PR — runtime-test gated by Symptom B)

Mirror exactly how `bio` already works (it threads an explicit empty through):

1. **`spaceMessageService.ts`**
   - `sendUpdateProfileMessage` line 823: `...(displayName ? ...)` → `...(displayName !== undefined ? { displayName } : {})`.
   - `profileBroadcastSignature`: change `if (p.displayName)` → `if (p.displayName !== undefined)` so a clear produces a distinct signature and isn't deduped away.
2. **`SpaceSettingsModal.tsx` line 719:** when the field changed, pass the raw value (including `''`), not `|| undefined`:
   `params.displayName = spaceProfileDisplayName;`
3. **Audit every other caller** of `maybeSendUpdateProfileMessage` / `sendUpdateProfileMessage` and confirm each passes `undefined` (NOT `''`) when it means "no change":
   - `WebSocketContext.tsx` on-connect rebroadcast — passes `displayName || undefined` ✓ (must stay `undefined`)
   - `ProfileModal.tsx` space loop — passes `newDisplayName || undefined` ✓
   - `UnifiedProfileEditModal.tsx` `saveQuorum` space loop — passes `name || undefined` ✓
   Only the explicit per-space save (SpaceSettingsModal) should emit `''`.
4. Consider doing the same for **userIcon** clears if avatar-removal should propagate (separate question; out of scope unless wanted).

## Verification (BLOCKED on Symptom B)

The end-to-end test (clear per-space name on mobile → desktop reflects it) requires
working mobile↔desktop delivery. Desktop→mobile is currently blocked by Symptom B, and
mobile→desktop delivery should be confirmed too. Static verification (grep the call
sites, tsc) is possible now; the runtime confirmation must wait for the crypto path.

## NOT this bug

- **Desktop → mobile changes not appearing on mobile** = Symptom B (known crypto wall),
  not this. This bug is strictly the mobile → other-clients *send* of a CLEAR.

---
*Created: 2026-06-16 — found while testing PR #105's receive-side honor-displayname-clear;
this is the unaddressed send-side half. Fix scoped above; deferred to a focused PR because
it touches the shared rebroadcast path (clobber risk) and can't be runtime-verified until
the crypto delivery path works.*
