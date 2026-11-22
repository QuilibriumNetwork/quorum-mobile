---
type: task
title: "Avatar clear/absent/value — one shared three-state design (desktop + mobile)"
status: done
created: 2026-07-15
---

# Avatar clear/absent/value — one shared three-state design (desktop + mobile)

**Created:** 2026-07-15
**Status:** design agreed (canonical model = empty string `''` = "no avatar"); desktop
receive + backfill already fixed on branch `fix-userIcon-clear-propagation`; mobile
receive + backfill still to do.
**Repos:** quorum-mobile + quorum-desktop (no quorum-shared change needed).

## Problem

Clearing a per-space avatar didn't propagate, and when partially fixed it "resurrected"
(cleared, then the old image flashed back). Root cause across the whole bug family: code
that distinguishes only TWO avatar states (has-value vs falsy) when there are really
THREE, and the two platforms encoded "no avatar" differently:

- **Desktop:** "no avatar" = the sentinel string `DefaultImages.UNKNOWN_USER` =
  `'/unknown.png'` (`src/utils.ts:4`), referenced in ~34 files, detected at render via
  `.includes(UNKNOWN_USER)`.
- **Mobile:** "no avatar" = `''` / not-a-`data:`-URI. Zero references to any sentinel.

`update-profile` messages cross between the two, so an empty from one side hits a truthy
`||` / `if(x)` on the other and either gets dropped (clear ignored) or backfilled from the
global public profile (old avatar resurrected).

## The design: THREE states, one discriminator, both apps, every layer

Canonical representation (agreed 2026-07-15): **empty string `''` = "no avatar".**

| State | Wire / storage | Meaning | Behavior |
|---|---|---|---|
| **absent** | field omitted (`undefined`) | "not touching my avatar" | keep existing; public-profile backfill ALLOWED |
| **empty** | `''` | "deliberately cleared" | initials; backfill SUPPRESSED (an explicit clear WINS) |
| **value** | `data:…` / url | the avatar | show it |

**The single rule everywhere:** use `!== undefined` (presence), NOT truthiness, as the
discriminator. `''` must be a first-class value that WINS over any fallback, never
collapsed into "absent".

The **render layer needs no change** — verified both sides already treat `''` as "no
image → initials":
- desktop `isLikelyRenderableImage('')` → `false` (`if (!icon) return false`)
- mobile `hasValidAvatar = avatar?.startsWith('data:')` → `false`
- the `UNKNOWN_USER` sentinel also still → initials, so the ~34 desktop render refs stay
  valid. This is NOT a sentinel migration; the sentinel can remain as a render-time
  "no image" marker. We are only fixing the RECEIVE and MERGE/BACKFILL layers.

## Sites to fix (the truthy→presence changes)

### Desktop — DONE (branch `fix-userIcon-clear-propagation`)
1. `src/services/MessageService.ts:1354` + `:1914` — receive guard
   `if (content.userIcon)` → `if (content.userIcon !== undefined)`. ✅
2. `src/hooks/business/user/useMembersWithPublicProfileFallback.ts:131` — backfill
   `local?.userIcon || pub.profile_image` → `userIcon !== undefined ? userIcon :
   (pub.profile_image || undefined)`. ✅ (`useChannelData` maps never-set/sentinel →
   `undefined`, real clear → `''`, so the discriminator is sound.)
3. `src/hooks/business/spaces/useSpaceProfile.ts` `getProfileImageUrl` — the OWN
   Space-Settings avatar preview. Truthy `if (currentMember?.user_icon && ...)` fell
   through to the GLOBAL avatar (`currentPasskeyInfo.pfpUrl`) when the per-space icon was
   cleared (`''`), so the modal showed the old global image instead of initials. Fixed to
   three-state: `user_icon !== undefined` → explicit per-space value ('' = cleared → show
   default, do NOT fall back to global); `undefined` → fall back to global. `showImage`'s
   existing `avatarUrl !== 'var(--unknown-icon)'` check then hides the image correctly.
   (`Account.tsx:154` `hasExistingAvatar` is also global-pfp-based but no longer causes a
   visible bug given the getter fix; left as-is.)
- Runtime-verified 2026-07-15: mobile clear → desktop shows initials, no resurrection
  (after a desktop refresh; the public-profile query is cached 1h — live-update without
  refresh is a separate cache-invalidation nicety, not this bug).

### Mobile — TODO
1. **Receive guards** — `context/WebSocketContext.tsx:2158` and `:3599`:
   `...(profileContent.userIcon ? { profile_image: profileContent.userIcon } : {})`
   → `...(profileContent.userIcon !== undefined ? { profile_image: profileContent.userIcon } : {})`.
   (Mirror of the desktop receive fix — makes a clear from another device land on mobile.)
   - Also check the sibling writes at `:856/:866/:873` (`profile_image: participant.userIcon`)
     — those assign unconditionally, so they already carry `''` through; verify they're
     not re-guarded upstream.
2. **Backfill merge** — `hooks/useMembersWithPublicProfileFallback.ts` `pickField`
   (`:116-119`). It's timestamp-gated and shared across display_name/profile_image/bio.
   The DELICATE one: its "non-empty wins" rule exists so a PARTIAL update (avatar-only,
   empty name) doesn't blank the name. For avatar CLEAR we need `''` to win **when local
   is the newer source**. Proposed:
   ```ts
   const pickField = (localVal: string | undefined, pubVal: string) => {
     // local wins when it's the newer source — including a deliberate '' clear.
     if (chatIsNewer) return localVal !== undefined ? localVal : (pubVal || '');
     return pubVal || localVal || '';
   };
   ```
   VERIFY this doesn't regress the partial-update name/bio case: a partial avatar-only
   update stamps `profileTimestamp` recent but leaves name — is name `''` or `undefined`
   in that local record? If `undefined`, the fix is safe (falls through to pub). If the
   partial update stores name as `''`, applying this to name would wrongly suppress the
   pub name — in that case, apply the `!== undefined` variant ONLY to the avatar field,
   not via the shared `pickField`. Confirm the stored shape before choosing.
3. Confirm mobile's own render already shows initials for a member whose `profile_image`
   is `''` (via `CachedAvatar`/`DefaultAvatar` fallback path) — expected yes, verify.

## Why no quorum-shared change

`UpdateProfileMessage.userIcon` already exists in shared; we're only changing how each app
APPLIES an incoming value, not the wire type. The `''`-means-clear convention is expressed
purely in send/receive/merge code on both sides. (If we ever wanted the sentinel promoted
to a shared constant that would be additive, but this design deliberately drops the
sentinel from the wire in favor of `''`, so it's unnecessary.)

## Test matrix (both directions)

| Action | Expect |
|---|---|
| mobile clear per-space avatar → desktop | desktop shows initials, no resurrection ✅ (done) |
| desktop clear per-space avatar → mobile | mobile shows initials, no resurrection (mobile TODO) |
| either: set a NEW avatar → other side | new avatar shows |
| either: partial update (name only, avatar untouched) | avatar unchanged, name updates (no regression) |
| member with never-set avatar + public profile | still backfills global avatar (absent≠empty) |

## Committed 2026-07-15

- **mobile** branch `fix-space-profile-updates` (commit 2bc486c): canonicalize
  update-profile branch, send-side explicit-clear, members-query invalidation, initials
  fallback in the space profile editor, receive-side `!== undefined` guards + backfill fix.
- **desktop** branch `fix-userIcon-clear-propagation` (commit 07f41922): receive guards,
  public-profile backfill fix, Space Settings avatar preview three-state, AND User Settings
  display-name hydration (Bug 1 below).

## Adjacent display-name bugs found during testing (2026-07-15)

**Bug 1 — FIXED (desktop, commit 07f41922).** Desktop User Settings display-name field
showed empty. `useUserSettings` `applyConfig` hydrated bio/toggles from config but never
called `setDisplayName`, so the field only ever reflected `currentPasskeyInfo.displayName`
at mount and stayed empty when that was blank — and a save would have written `name: ''`,
wiping the global name. Fixed: `applyConfig` now `setDisplayName(config.name)` when
`config?.name !== undefined`.

**Bug 2 — OPEN (next).** Desktop Space Settings → Account per-space display-name field is
empty even after changing the per-space name on MOBILE (message rows on desktop show the
new name, but the modal field is blank). `useSpaceProfile` seeds the field from
`member?.display_name ?? ''` (member-only, by design). Hypothesis: a SELF-authored
`update-profile` (your own per-space name change echoing to your desktop) updates the
render but does NOT write your OWN `space_members` row on desktop, so `getSpaceMember(self)`
returns an empty/absent name. The per-space SAVE is clobber-safe (change-only gate:
displayName only sent when `!== baseline`, and baseline is also ''), so this is a
hydration/self-echo bug, not data loss — but worth fixing so the field reflects reality.
Next step: trace desktop's update-profile receive handler for `senderId === self` — does it
`saveSpaceMember` for self? Verify desktop's own member row in IndexedDB is actually empty
after a mobile per-space name change before investing in the fix.

**Note:** desktop→mobile delivery is currently failing for ALL messages (normal + profile) —
the known cross-device sync issue. Every "desktop→mobile didn't reflect" test result during
2026-07-15 testing is blocked by that, not by avatar/name logic. Mobile→desktop is the
verified-working direction.

---
*Last updated: 2026-07-15*
