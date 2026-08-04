---
type: bug
title: "GIFs render as a static image in mobile chat (no animation, no click-to-play) — pre-existing, surfaced during image convergence"
status: open
created: 2026-06-14
severity: low-medium (cosmetic / feature gap — image still shows, just frozen)
repo: quorum-mobile (render side); interacts with desktop's GIF UX
area: chat media rendering / GIF playback
related:
  - ".agents/issues/.done/2026-06-13-converge-image-caption-to-post-embeddedmedia.md (surfaced while implementing this; that task does NOT aim to fix GIF animation)"
discovered-during: "runtime testing of branch render-desktop-embeddedmedia-images (the post+embeddedMedia convergence)"
---

# GIFs render as a frozen static image in mobile chat

## Symptom (observed 2026-06-14, runtime)

- A **large GIF sent from mobile** renders as a **static image on BOTH mobile and desktop** (no
  animation, no play button).
- A **large GIF sent from desktop** renders **correctly on desktop** (static thumbnail + click-to-play
  animates in place). (Desktop→mobile delivery couldn't be tested — blocked by a separate issue, see
  "Not the cause".)
- Reloading the app and sending a **fresh** GIF made **no difference** — still static.

## What is PROVEN

### 1. Mobile sends the GIF bytes intact (source is NOT flattening it)
`services/media/imageAttachment.ts:226-255` — the GIF branch explicitly does **not** compress or run
the image through `ImageManipulator` ("For GIFs, we don't compress (would lose animation)"). It reads
the raw file as base64 (`:237-239`) and ships `data:image/gif;base64,…` with `mimeType: 'image/gif'`.
So genuine animated-GIF bytes leave the device. The static rendering is a **decode/display** problem,
not a data problem.

### 2. Mobile has NEVER animated GIFs in chat (pre-existing, not introduced by the convergence work)
The chat image renderer is `AutoHeightImage` (`components/SocialFeed/media/AutoHeightImage.tsx`), used
by `EmbedMessageImage` in `components/Chat/MessagesList.tsx:192-219`. It renders via `expo-image`
(`<ExpoImage source={{ uri }} contentFit="cover" />`, `AutoHeightImage.tsx:67-72`) with **no
GIF/animation handling of any kind**. Git history confirms this file has **never** had GIF-specific
logic (`git log -S "gif"` on it is empty; unchanged in intent since initial release). So "static GIF
on mobile" is the baseline behavior, independent of the `post`+`embeddedMedia` convergence.

### 3. Mobile generates NO real static thumbnail for GIFs
`imageAttachment.ts:248` sets `thumbnailUrl: imageUrl` for GIFs — the "thumbnail" is the **full GIF
bytes**, not a distinct still frame. (Desktop, by contrast, has `src/utils/imageProcessing/gifProcessor.ts`
`generateGifThumbnail`, which produces a genuine separate static frame — that distinct thumbnail is
exactly what powers desktop's "static thumbnail + click-to-play" UX.)

### 4. Why desktop also shows a mobile-sent GIF as static
Desktop derives its GIF behavior from the `embeddedMedia` shape (`Message.tsx:1156-1157`):
`isLargeGif = isGif && thumbnailSrc !== fullSrc`. The convergence send path now de-duplicates the
identical thumbnail (it would otherwise double the payload), so a mobile GIF arrives with only an
`image` entry → `thumbnailSrc === fullSrc` → `isLargeGif = false`. In that case desktop's documented
behavior (`Message.tsx:82`) is "small GIF → the src IS the GIF, so it animates immediately." So desktop
**should** animate a mobile-sent GIF inline. That it was observed **static on desktop** is NOT fully
explained yet and needs a captured message to confirm (see "Open / not yet proven").

## NOT the cause (ruled out)

- **NOT the `post`+`embeddedMedia` convergence (branch `render-desktop-embeddedmedia-images`).** Mobile
  GIFs were static before that work too (renderer never animated them). The convergence neither caused
  nor is expected to fix GIF animation. The branch's dedup-thumbnail change is a payload/correctness
  improvement, unrelated to animation.
- **NOT a data/encoding problem.** Animated GIF bytes are sent intact (PROVEN #1).
- **NOT the desktop→mobile delivery failure** (a separate open issue — the test user receives no
  desktop messages at all; see `2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`).
  That blocks testing desktop→mobile GIFs but is a different bug.

## Open / not yet proven

- **expo-image 3.0.11 GIF behavior with base64 data URIs.** expo-image is generally documented to
  animate GIFs by default, but whether `3.0.11` autoplays an **animated GIF passed as a
  `data:image/gif;base64,…` URI** (vs a file/http URI) is NOT confirmed. This is the most likely lever.
  Do NOT assume from memory — check the installed expo-image version's docs/changelog (Context7) before
  changing anything. A `data:` URI or a missing autoplay default could be the whole cause on mobile.
- **Why a mobile-sent GIF is static on DESKTOP** despite desktop's "small GIF animates inline" path.
  Capture the actual on-desktop message for a mobile GIF and confirm: does it arrive as a `post` with a
  single `image` (`image/gif`) entry? Does `createGifDetector` fire on the data URI? Is `isLargeGif`
  correctly false? One captured message resolves it.
- `RNImage.getSize(uri, …)` at `AutoHeightImage.tsx:50` is called with the full base64 data URI for
  sizing — unlikely to affect animation, but worth noting if dimensions look wrong too.

## Suggested fix direction (NOT yet validated — investigate first)

1. **Mobile inline animation (most likely the real fix):** confirm expo-image's animated-GIF support
   for data URIs in `3.0.11`; if it needs a prop or a different source form, set it in `AutoHeightImage`
   (or branch GIFs to a component/config that autoplays). This would give inline animation on mobile —
   the "acceptable degradation" target. Verify version-specific behavior via docs first.
2. **Mobile click-to-play parity (larger, optional):** generate a real static thumbnail for large GIFs
   on mobile (mirror desktop's `gifProcessor.generateGifThumbnail`) and emit it as a distinct
   `image-thumbnail` entry. Then both apps get the static-thumbnail + click-to-play UX. Bigger lift;
   only worth it if inline animation isn't considered enough.

## Scope note

This is a **rendering / media-feature gap**, separate from the cross-platform image *delivery*
convergence. The convergence task (`2026-06-13-converge-image-caption-to-post-embeddedmedia.md`)
fixes "desktop images don't appear on mobile at all" and should not be blocked on GIF animation —
its own acceptance criteria treat inline GIF animation as nice-to-have, and static GIFs are a
pre-existing condition, not a regression it introduced.

---
*Created: 2026-06-14*
