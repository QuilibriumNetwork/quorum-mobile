---
type: bug
title: "Farcaster DM: pfps show as initials inside the conversation (both users), while the DM list shows the photo"
status: open
priority: medium
created: 2026-08-19
area: Farcaster DMs / avatars
related:
  - "issues/.open/2026-08-18-dm-identity-reveal-ledger-plan.md (NOT covered there — that plan is Quorum E2EE DM identity; Farcaster is a separate namespace with API-served pfps)"
---

# Farcaster DM: in-conversation pfps fall back to initials on a fresh device

## Symptom (observed 2026-08-19, Android emulator, fresh test account)

- Open an existing Farcaster DM: **both** users' avatars — self and partner —
  render as the colored-initials fallback. Usernames render normally.
- The **DM list** shows the partner's real photo for the same conversation.
- The **same conversation on a long-used real device** shows both photos
  normally.

The initials are the *deliberate* fallback (confirmed by the operator: colored
initials, not empty circles), so rendering and layout are fine — the photo
either never had a URL or its fetch failed, and the degrade worked as designed.

## Why the two surfaces differ (READ)

| Surface | Avatar source | Renderer |
|---|---|---|
| DM list | conversation row `icon` (http URL) | core RN `<Image>` — `components/Chat/DirectMessagesList.tsx:150` |
| Inside the conversation | per-message `senderContext.pfp.url` from the Farcaster API — `components/Chat/types.ts:570` (`directCastToDisplayMessage`) | `CachedAvatar` (expo-image, disk cache) via `MessagesList.renderAvatar` (~line 842) |

Usernames come from the SAME `senderContext` object (`displayName ?? username`,
`types.ts:571`) and they load — so `senderContext` itself is present.

Empty `pfp.url` and a failed image fetch are **visually identical by design**
(`CachedAvatar` falls back to the same initials a missing source gets, so a
404 doesn't render differently). The observation cannot split them.

## Two candidate causes, one discriminating step

1. **The API response carries no `pfp` for this session/account** while
   carrying names. Both users affected at once fits a response-level cause.
2. **expo-image fetch fails on the fresh emulator** (cold cache), while the
   real device serves the same photos from its warm disk cache without ever
   refetching. Emulator logcat showed no image errors in the buffer (weak
   signal — the buffer was hours deep and image failures may not log there).

**Discriminator:** log `message.senderContext?.pfp` (presence + URL) in
`directCastToDisplayMessage` (`components/Chat/types.ts:569-571`) and open the
conversation once. URL present → cause 2 (chase expo-image/network on the
emulator, and check whether the FC feed's avatars — same component — load).
URL absent → cause 1 (compare the raw direct-cast API response against what
the app version on the real device receives; check for version skew or a
viewer-context/auth difference for fresh sessions).

## Explicitly out of scope

The 2026-08-18 DM identity plan (dialect fix + reveal ledger) does not and
should not cover this: Farcaster identities are a different namespace (fid,
API-served profile, no encryption session, no ladder), and routing them
through the Quorum resolver is a known wrong move recorded in the identity
migration's constraints.

---
*Last updated: 2026-08-19*
