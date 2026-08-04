---
type: bug
title: "Clearing a per-space avatar on mobile doesn't clear it on desktop — userIcon empty-string vs UNKNOWN_USER sentinel mismatch"
status: done
created: 2026-07-15
severity: medium (feature gap — avatar clears don't cross platforms; name/bio clears now do)
repo: quorum-mobile (send, now correct) + quorum-desktop (receive guard, FIXED) — cross-repo
area: per-space profile sync / update-profile userIcon
related:
  - "2026-06-16-mobile-send-strips-empty-displayname-clear-not-propagated.md (the send-side strip; FIXED on branch fix-space-profile-updates)"
  - "2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md (Adjacent bug 2 / canonicalize; the update-profile canonicalize branch was added on the same branch)"
discovered-during: "runtime testing of branch fix-space-profile-updates, 2026-07-15 — rename crossed to desktop, avatar-removal did not"
---

# Clearing a per-space avatar on mobile doesn't propagate to desktop

## ✅ RESOLUTION (2026-07-15) — Option B, NOT Option A

The "Proposed fixes" section below originally recommended **Option A** (mobile adopts
desktop's sentinel). **That recommendation was WRONG and is superseded.** Investigating
how to make A work correctly uncovered two facts that flipped the decision:

1. **`DefaultImages.UNKNOWN_USER = '/unknown.png'`** (`quorum-desktop/src/utils.ts:4`) —
   it's a desktop **web-asset path**, not a shared constant. Option A would bake a
   desktop URL into mobile's data model as a magic wire value; mobile (which has ZERO
   refs to it) would also have to special-case that string in its renderer.
2. **Desktop already renders an empty string `''` as initials.** Its avatar detector
   `isLikelyRenderableImage('')` returns `false` (`if (!icon) return false`,
   `UserAvatar.native.tsx`/`.web.tsx`), and every render-side check is
   `avatar && !avatar.includes(UNKNOWN_USER)` — `''` is falsy → initials fallback. So
   the ONLY thing blocking mobile's `''` clear was the single receive-side truthy guard.

**Fix shipped (Option B):** flip desktop's receive guard for `userIcon` from truthy to
`!== undefined` at BOTH receive sites — `quorum-desktop/src/services/MessageService.ts`
`:1348` (saveMessage block) and `:1906` (batch block). No mobile change beyond what
`fix-space-profile-updates` already did (mobile correctly sends `''`). No quorum-shared
change. Clobber-safe: desktop's all-spaces rebroadcast sends the UNKNOWN_USER sentinel,
never `''`, and its per-space sender omits unchanged fields.

- **Branch:** quorum-desktop `fix-userIcon-clear-propagation`.
- **Verified 2026-07-15:** mobile removes per-space avatar → desktop shows initials.
  **Caveat:** required a desktop **refresh** to reflect — the received member updated in
  storage but the already-rendered view didn't re-derive live. Likely a desktop-side
  cache-invalidation gap analogous to mobile's fixed `useSpaceMembers` invalidation
  (Problem C on `fix-space-profile-updates`). Minor follow-up, not blocking; data path is
  correct.

The full analysis below (mechanism, sentinel model, both options) is kept for the record.

## Symptom (observed 2026-07-15, runtime)

On branch `fix-space-profile-updates`, in a space's Settings → Account:
- User A on **mobile** cleared their per-space **display name** (changed it) and
  **removed their avatar**, saved.
- On **desktop** (user B's view of A): the **display name updated correctly**, but
  A's **old avatar is still shown** — the clear didn't cross.

So `displayName` clears now propagate mobile → desktop, but `userIcon` clears do not.

## Why the rename crossed but the avatar didn't

This branch already fixed the mobile **send** side so an explicit clear puts `''` on
the wire for BOTH `displayName` and `userIcon` (mirroring how `bio` worked):
- `services/space/spaceMessageService.ts` `sendUpdateProfileMessage` — content builder
  now uses `displayName !== undefined` / `userIcon !== undefined` (was truthy).
- `components/SpaceSettingsModal.tsx` `handleSaveSpaceProfile` — passes the raw value
  (incl. `''`) when the field changed (was `x || undefined`).

So mobile now correctly sends `userIcon: ''`. The break is on the **desktop receive
side**, and it is NOT symmetric with `displayName`.

## Root cause — desktop's receive guard + desktop's sentinel model

### 1. Desktop receive treats `userIcon` differently from displayName/bio (truthy guard)

`quorum-desktop/src/services/MessageService.ts` (the space `update-profile` receive
handler, ~lines 1345-1353, and a SECOND identical site ~:1862):

```ts
// Upsert-aware merge: omitted field = no change, empty string = clear.
// displayName + bio use `!== undefined` (clearing propagates); userIcon
// keeps the truthy guard.
if (decryptedContent.content.displayName !== undefined) {
  participant.display_name = decryptedContent.content.displayName;
}
if (decryptedContent.content.userIcon) {            // ← TRUTHY GUARD, drops ''
  participant.user_icon = decryptedContent.content.userIcon;
}
if (decryptedContent.content.bio !== undefined) {
  participant.bio = decryptedContent.content.bio;
}
```

Mobile sends `userIcon: ''` → `if ('')` is falsy → desktop skips the assignment →
desktop keeps the old `user_icon`. The comment shows the truthy guard on `userIcon` is
**deliberate**, not an oversight.

### 2. WHY it's deliberate: desktop represents "no avatar" with a SENTINEL, not ''

Desktop's model is that a missing avatar is the non-empty string
`DefaultImages.UNKNOWN_USER`, never `''`:

- **Sender:** the all-spaces rebroadcast sets
  `const userIcon = config.profile_image ?? DefaultImages.UNKNOWN_USER;`
  (`MessageService.ts:~578`, feeding the unconditional `userIcon` at `:590`), and
  `MessageDB.tsx:448` likewise always sends a `userIcon` value. Desktop never puts `''`
  on the wire for a no-avatar user — it puts the sentinel.
- **Renderer:** desktop filters the sentinel back out to trigger its initials fallback,
  e.g. `useChannelData.ts:68-69`
  `userIcon: curr.user_icon?.includes(DefaultImages.UNKNOWN_USER) ? … : …`.

So on desktop, "no avatar" round-trips as a **non-empty sentinel** that its render path
knows to treat as empty. The truthy `if (userIcon)` guard is consistent with that model:
a legit value (real image OR sentinel) is always truthy, and the guard was protecting
against a genuinely absent/empty field from an old/edge client.

### 3. The actual divergence: mobile and desktop disagree on how "no avatar" is encoded

| | "no avatar" on the wire | "no avatar" detected at render |
|---|---|---|
| **Desktop** | `UNKNOWN_USER` sentinel string | `user_icon.includes(UNKNOWN_USER)` |
| **Mobile** | `''` (empty string) | `!avatar?.startsWith('data:')` (e.g. `UserProfileModal.tsx:179`) |

Mobile has **zero** references to `UNKNOWN_USER` (grepped). So the two platforms use
two different conventions for the same concept, and neither speaks the other's. Mobile's
`''`-clear is invisible to desktop; desktop's sentinel-clear would be an unrenderable
literal string on mobile.

## This is NOT fixable by naively flipping the desktop guard

Changing desktop's `if (userIcon)` → `if (userIcon !== undefined)` would let mobile's
`''` through, but then desktop would store `user_icon = ''`. Desktop's render/filter
path keys off the `UNKNOWN_USER` sentinel, not `''`, so `''` may not reliably fall back
to initials there, and it introduces a NEW "empty means clear" semantic that only mobile
speaks — while desktop's own senders still emit the sentinel. That's trading one
half-working convention for two. The fix has to reconcile the encodings, not just open
the gate.

## Proposed fixes (pick one — needs a cross-repo/lead decision)

### Option A — Mobile conforms to desktop's sentinel model (mobile-side, likely cleanest)
Make mobile use `DefaultImages.UNKNOWN_USER` (or an agreed shared constant) instead of
`''` to mean "no avatar", end to end:
1. On avatar clear, mobile **sends the sentinel**, not `''`. Desktop's *unchanged*
   truthy guard accepts it, and desktop's *existing* sentinel-filtering render shows
   initials. **Zero desktop change.**
2. Mobile's **own** receive/render must recognize the sentinel as "no avatar" (today it
   only checks `startsWith('data:')`) so mobile shows initials for a sentinel too, and
   never tries to render the literal string as an image.
3. Ideally the sentinel lives in `quorum-shared` as a single constant both apps import,
   instead of desktop-local `DefaultImages.UNKNOWN_USER`.
- **Pro:** aligns to the established platform convention; no new wire semantic; desktop
  untouched. **Con:** mobile must learn the sentinel on its render side (small), and the
  cleanest form wants a shared constant (shared publish, lead-gated).

### Option B — Desktop receive honors an empty-string clear (desktop-side)
1. Desktop receive: `if (userIcon !== undefined)` at BOTH sites (~:1348 and ~:1862),
   AND map an incoming `''` to whatever desktop's render treats as "no avatar" (i.e.
   normalize `'' → UNKNOWN_USER`, or teach the render/filter path to treat `''` the same
   as the sentinel).
2. Audit desktop's own senders so none emit an incidental `''` that would now clobber:
   - `useSpaceProfile.ts:282` sends `changed.userIcon ?? baseline.userIcon` — a desktop
     clear would send `''`; confirm that's the intended clear and not an incidental empty.
   - `MessageDB.tsx:448` and `MessageService.ts:590` send the sentinel (not `''`) for
     no-avatar users, so they're safe from the clobber — but re-verify after the change.
- **Pro:** empty-string-as-clear becomes a uniform semantic (matches displayName/bio).
  **Con:** touches desktop's two receive sites + render normalization; must not regress
  the sentinel path; a deliberate guard is being changed, so lead sign-off is warranted.

## Recommendation

**Option A** looks lower-risk: it conforms mobile to the convention desktop already ships
and rendered correctly, needs no change to a deliberately-placed desktop guard, and the
only real work is mobile learning the sentinel on its render side (+ ideally promoting the
constant to shared). Confirm with the lead whether the sentinel should become a shared
constant before wiring it, since that adds a shared publish to the critical path.

## Mobile side status (this branch)

Mobile SEND is already correct for a clear (sends `''`) after `fix-space-profile-updates`.
Whichever option is chosen, the mobile send may need to change (Option A: send sentinel
instead of `''`). The `displayName`/`bio` clears work today because desktop already uses
`!== undefined` for those — only `userIcon` has the sentinel-vs-empty split.

## To confirm next time

- Capture the on-desktop received `update-profile`: is `content.userIcon === ''`
  (mobile sent the clear) reaching `MessageService.ts:~1348`? If yes, it's purely the
  truthy guard + sentinel model as described.
- Confirm desktop's render treats a stored `user_icon = ''` the same as `UNKNOWN_USER`
  (does it fall back to initials?) — decides how much normalization Option B needs.

---
*Last updated: 2026-07-15*
