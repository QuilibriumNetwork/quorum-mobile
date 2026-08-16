---
type: bug
title: Photoless users all render as the same Quorum mark
status: done
created: 2026-08-16
updated: 2026-08-16
---

# Photoless users all render as the same Quorum mark

## Status

**2026-08-16 — shipped in PR #251** (`fix: a photoless avatar shows the person,
not the Quorum mark`).

Verified in-session: 999 tests pass across 107 suites, and five guard tests were
measured red against the pre-fix tree before being accepted. No new type errors
(11 pre-existing, byte-identical before and after).

## Symptom

A user with no profile picture rendered as a **static Quorum brand mark**,
identical for every such user, on most Farcaster surfaces. Open a thread where
four photoless people replied and all four rows showed the same blue square.

The same user rendered correct initials elsewhere in the app, so the identity of
a photoless person changed depending on which screen you were looking at.

## Cause

`components/ui/CachedAvatar.tsx` took an OPTIONAL `fallbackName`. Supplied, a
missing photo rendered `DefaultAvatar` (initials on a deterministic colour).
Omitted, it fell back to `assets/images/quorum-symbol-bg-blue.png`.

So the default was the worst available option, and forgetting one prop was
enough to get it. **21 call sites across 17 files** omitted it. Most were
components extracted out of `SocialFeedModal.tsx` into their own files where the
prop did not follow — a diff no reviewer catches by eye, because the extracted
code looks correct in isolation.

Two further avatars bypassed the component entirely and hardcoded the mark into
a bare `<Image>`, so they were invisible to any fix scoped to `CachedAvatar`:

- `components/Chat/FarcasterCastCard.tsx` — cast author
- `components/SocialFeedModal.tsx` — **the main feed's post row**

23 broken avatar surfaces in total.

## Fix

`fallbackName` is now **required** and the brand-mark path is deleted, so an
omission is a compile error instead of a silent visual bug. Every call site
passes the name ALREADY RENDERED as that avatar's label, so the two cannot
disagree. `''` remains legal and explicit for the genuinely-nameless case and
renders the neutral `?` glyph.

This converges on desktop, whose `UserAvatar` has always required `displayName`
and has no logo fallback at all (`quorum-desktop/src/components/user/UserAvatar/
UserAvatar.tsx`). The divergence was mobile's.

### Also fixed here

- **Latent recycling bug.** `imageError` was never reset when the photo changed.
  In a `FlashList` row one instance is reused across many people, so a single
  404 latched the failure and everyone who later landed in that slot rendered as
  initials despite having a photo. Desktop has carried the reset since it was
  written; this copy never had it. The blast radius grew from 16 to 37 sites
  with this change, which is why it was fixed here rather than deferred.
- **Fade-in** dropped for recycled rows (per-cell fades compound into a shimmer
  during fast scroll) and kept for the two avatars that mount once — the profile
  header and the edit preview — where an abruptly appearing large photo is the
  more jarring of the two.
- **Non-person icons** (Farcaster channels, mini-apps, tokens, wallet assets)
  now show initials of the entity name. For a token this also removes a
  false-endorsement problem: an unbranded token wearing the Quorum mark reads as
  a claim that the token IS Quorum.

## Guard tests

`__tests__/cachedAvatarFallback.test.tsx`. Each of these was measured red
against the pre-fix tree:

- no image renders when there is neither a photo nor a name
- a photo that fails to load degrades to initials
- a changed photo retries after a previous failure
- no `<CachedAvatar>` call site omits the name
- the brand asset is never referenced as a face, with the one genuine logo
  placement (the account-creation screen) allowlisted

The last one exists because requiring a prop only governs code that goes through
the component. The two bare-`<Image>` sites kept shipping the bug while a green
suite implied the class was closed.

> **A note worth keeping.** The first draft of these tests asserted "name
> present, no photo yields initials". Measured against the pre-fix tree, they
> all PASSED — that path was never broken, the defect only ever appeared on
> omission. They were deleted rather than shipped. A test that cannot fail is
> worse than no test, because it manufactures confidence.

## Deliberately not done

- `components/wallet/AssetDetailModal.tsx` has two placeholder paths that
  disagree by one letter (`US` vs `U`). Unifying them means downgrading the
  better one, to fix an inconsistency only visible on image-load failure.
- `components/ui/AvatarInitials.tsx` sets no `accessibilityLabel`; desktop's
  equivalent sets `role="img"` and an aria-label. Pre-existing, and now a
  one-file fix since names are threaded through every call site. Worth a
  follow-up.
- Initials below ~28px render at 6-10px. Acceptable because the name is always
  shown as adjacent text and the deterministic colour still separates people.

## Related

- `.agents/issues/.open/2026-08-16-mobile-lets-you-finish-onboarding-with-no-display-name.md`
  — found while tracing this: mobile lets you skip setting a display name,
  desktop does not, which is what makes a nameless avatar reachable at all.
