---
type: task
title: "Add joinedAt to mobile's space-join signature so desktop saves mobile members"
status: done
created: 2026-06-14
shipped: "PR #88 (fix/mobile-join-signature-joinedat), merged to master 2026-06-14. Statically verified (tsc + lint clean, encoding match confirmed in Node)."
runtime-confirmed: "NO — whether mobile members now get a space_members row on desktop is not separately confirmed; depends on desktop receiving the mobile join, which is entangled with the still-open Symptom B delivery issue (see related bug doc)."
severity: medium-high
repo: quorum-mobile (mobile-only change; no shared/desktop edits)
verifiable: statically (TS build + side-by-side field match; no app run required to confirm correctness)
related:
  - ".agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md (Adjacent bug 1 — this task fixes it)"
  - "quorum-desktop/.agents/bugs/2026-06-13-space-members-missing-no-join-row.md (the desktop-side symptom this contributes to)"
---

# Add `joinedAt` to mobile's space-join signature

## The problem in one paragraph

When a mobile user joins a space, mobile broadcasts a **signed** "join" control message announcing
its identity. Desktop verifies that signature before saving the member to its local `space_members`
table. But the two clients sign **different things**: desktop's signature covers a **10-field** blob
ending in a `joinedAt` timestamp, while mobile signs a **9-field** blob that stops at `displayName`
and never sends `joinedAt` at all. So desktop's verify always fails for mobile joins → it never
calls `saveSpaceMember` → **mobile users render on desktop as a truncated 6-char address with a
blank initials avatar instead of their real name/pfp**, and it never self-heals (normal chat
messages don't create member rows). This task aligns mobile's join with desktop's.

## What is PROVEN (verified 2026-06-14, both repos read directly)

**Desktop SEND — the canonical reference mobile must match**
(`quorum-desktop/src/services/InvitationService.ts`):
- `:823` — `joinedAt: Date.now()` → a JS **number** (milliseconds since epoch).
- `:826-838` — signs `address + id + inboxAddress + pubKey + inboxKey + identityKey + preKey +
  userIcon + displayName + participant.joinedAt`, via `Buffer.from(str, 'utf-8').toString('base64')`.
  In the concatenation, `participant.joinedAt` (a number) coerces to its decimal string, e.g.
  `"1781363395580"`.

**Desktop VERIFY** (`quorum-desktop/src/services/MessageService.ts`):
- `:3251-3263` — rebuilds the SAME 10-field blob ending in `participant.joinedAt` and verifies.
- `:3269-3277` — only on verify `=== 'true'` does it call `saveSpaceMember({ ..., joinedAt:
  participant.joinedAt })`. `joinedAt` is typed `number` (`:3282`). No else branch → silent drop on
  failure.

**Mobile SEND — what's wrong** (`quorum-mobile`):
- `hooks/chat/useSpaceActions.ts:589-597` — `msgToSign` is the **9-field** blob, ends at
  `displayName`. No `joinedAt`.
- `:598` — encoded with **`btoa(msgToSign)`** (latin1), NOT `Buffer.from(...,'utf-8')`.
- `:604-616` — the `participant` object has **no `joinedAt`** field.
- `services/space/spaceMessageService.ts:460-472` — the `JoinParticipant` interface has **no
  `joinedAt`** field (so even if you add it to the object, TS would flag it / it could be stripped).

## The fix (mobile-only, three edits)

1. **`services/space/spaceMessageService.ts`** — add `joinedAt: number;` to the `JoinParticipant`
   interface (`:460-472`), e.g. right after `displayName` to mirror desktop's field order.

2. **`hooks/chat/useSpaceActions.ts`** — in the join builder:
   - Mint the timestamp once so the signed value and the object value are identical:
     `const joinedAt = Date.now();`
   - Append it to the signed blob as the **last** field, exactly matching desktop's order:
     ```ts
     const msgToSign = user!.address + ratchet.id + inboxAddress + pubKeyHex +
       inboxKeyHex + identityKeyHex + preKeyHex + userIcon + displayName + joinedAt;
     ```
     (Template-concatenating a number coerces it to the same decimal string desktop produces.)
   - Add `joinedAt` to the `participant` object (`:604-616`) so it goes out on the wire:
     `joinedAt,`

3. **Encoding alignment (do this in the SAME edit — it's part of matching desktop byte-for-byte).**
   Mobile encodes the signed string with `btoa(...)` (`:598`); desktop uses
   `Buffer.from(str, 'utf-8').toString('base64')`. For pure-ASCII these match, but `btoa` **throws or
   diverges on non-ASCII** (emoji / accented display names, non-ASCII pfp URLs). Replace `btoa` with
   a UTF-8 base64 encoding that matches desktop. Mobile already imports byte helpers (e.g.
   `bytesToBase64`, `bytesToHex` from the crypto utils used elsewhere in this file) — use a UTF-8
   encode → base64 path, e.g. `bytesToBase64(new TextEncoder().encode(msgToSign))`, mirroring how
   `spaceMessageService.ts` builds `messageIdBase64` from bytes. Confirm the helper used produces the
   same bytes as Node's `Buffer.from(str,'utf-8')` for a non-ASCII sample before relying on it.

## Verification (no app run needed for correctness)

1. **Side-by-side field check.** Put mobile's new `msgToSign` next to desktop's `msg`
   (`InvitationService.ts:826-836`). Confirm: same 10 fields, same order, `joinedAt` last, both as a
   number coerced to a decimal string.
2. **Encoding check.** In Node, confirm the helper you used equals
   `Buffer.from(sample, 'utf-8').toString('base64')` for an input containing a non-ASCII char (e.g.
   an emoji or `é`). They must match.
3. **`npx tsc --noEmit`** clean (the new interface field + object field type-check).
4. **`yarn lint`** clean.

## Important caveats — read before shipping

- **Do NOT claim this fixes the broader "invalid signature on every message" bug.** That is a
  separate, still-open investigation (Symptom A in the bug doc — leading sub-hypothesis A2). This
  task fixes the **missing-member-row** defect specifically. It DOES remove one of the two reasons a
  mobile sender's `participant` is null on desktop (the other is transport — join broadcasts that
  never arrive, which this doesn't touch).
- **Rollout asymmetry (low risk, but be deliberate).** This changes what mobile signs. After the
  fix, a mobile user's join verifies on desktop; before it, it didn't. There's no migration needed
  (joins are transient announcements, not stored signed state), but old vs new mobile builds will
  sign joins differently during the rollout window — that's expected and fine. Note it in the PR.
- **iOS parity.** The join builder in `useSpaceActions.ts` is JS (shared across platforms), so this
  is not Android-specific — no native change required. Confirm there's no second, platform-specific
  join path before assuming one edit covers both.
- **Branch / PR naming** must be self-explanatory to other devs (no internal jargon) — e.g.
  `fix/mobile-join-signature-joinedat`. (memory `branch-pr-names-self-explanatory`)

## Files touched
- `services/space/spaceMessageService.ts` — `JoinParticipant` interface (`:460-472`).
- `hooks/chat/useSpaceActions.ts` — join builder (`:589-616`): signed blob, participant object,
  encoding.

---
*Created: 2026-06-14*
