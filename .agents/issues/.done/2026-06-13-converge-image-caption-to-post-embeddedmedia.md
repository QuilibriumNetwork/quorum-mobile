---
type: task
title: Converge image+caption onto post + embeddedMedia (drop embed for sending)
status: done
created: 2026-06-13
updated: 2026-06-14
category: convergence
urgency: Tier 2 (live cross-platform bug — desktop photos lose their image on mobile)
repos: quorum-mobile ONLY (desktop §3 already shipped — see §3)
shared_change: NONE (verified — embeddedMedia present in installed 2.1.0-29; GIF flag derived at render)
version_bump: none
runtime_test: required for §2 (send); §1 (render) is statically verifiable
---

# Converge image+caption onto `post` + `embeddedMedia`

> ## ✅ SHIPPED 2026-06-14 — PR #89 (squash-merged to master, 6d8017f)
> §1 (mobile render of `post`+`embeddedMedia`) and §2 (mobile send) both landed. §3 (desktop send)
> was already done. Files: `components/Chat/types.ts`, `services/space/spaceMessageService.ts`
> (new `buildPostWithEmbeddedMedia` helper), `hooks/chat/useSendEmbedMessage.ts`.
>
> **What's confirmed:** tsc/lint clean; `post` signed over text only on both apps (no signature
> divergence); `embeddedMedia` survives the receive pipeline; **mobile→desktop image+caption
> confirmed at runtime**.
>
> **What's NOT runtime-confirmed:** desktop→mobile render — the test account receives NO desktop
> messages at all (blocked by Symptom B / the open native-decrypt issue
> `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`). The
> render change is purely additive (a new branch for a field mobile previously ignored), so it can't
> regress existing types — but "desktop photo now shows on mobile" needs confirming once a test
> account can actually receive desktop messages. mobile→mobile also not explicitly tested.
>
> **Spun off:** GIFs still render static in mobile chat — pre-existing (mobile never animated chat
> GIFs), out of scope here, tracked in `.agents/issues/.open/2026-06-14-mobile-chat-gifs-render-static-not-animated.md`.

> **STATUS REFRESH (2026-06-14):** re-verified against current code. Findings:
> - **§3 (desktop send) is ALREADY DONE.** Desktop's `useMessageComposer.ts` now emits
>   `{ type:'post', text, embeddedMedia }` for image+caption (`:236`), multi-image (`:263`), AND
>   image-only (`:303`, `text:''`). Desktop **no longer emits `type:'embed'` anywhere** (grep-confirmed).
>   §3 below is kept for the record but requires NO action.
> - **§1 + §2 (mobile render + send) are the remaining work — both mobile-only.** No desktop PR, no
>   shared change, no version bump. `embeddedMedia` IS in the installed `2.1.0-29`
>   (`PostMessage.embeddedMedia?: Array<{type,key,data,mimeType}>`, confirmed in shared src).
> - Line numbers below were re-anchored to current code where noted `[2026-06-14]`.
> - Verification split: **§1 render is statically verifiable** (read field + TS build); **§2 send
>   needs a real runtime send/receive test** (frontmatter `runtime_test: required` applies to §2).

> **Single-repo task now.** All remaining work is in quorum-mobile. The desktop-side change (§3)
> already shipped, so this is no longer cross-repo. Implement §1 + §2 together when time allows;
> §1 alone already makes desktop photos visible on mobile (the user-facing bug) and can land first.

## The bug (live today)

Desktop sends a captioned image as `type:'post'` + `embeddedMedia[]` + `text`
(`quorum-desktop/src/hooks/business/messages/useMessageComposer.ts:184-236` `[2026-06-14]`). Mobile
**never reads `embeddedMedia`** — zero references repo-wide (grep-confirmed 2026-06-14). So:

- `getMessageRenderType` maps a desktop `post` to `'post'` (`components/Chat/types.ts:290+`,
  the `post` case is the default render type).
- `toDisplayMessage` (`types.ts:363`) only sets `imageUrl` for `content.type === 'embed'`
  (`types.ts:411-417` `[2026-06-14]`); for `post` it merely scans the **text** for inline image URLs
  (`types.ts:419-429` `[2026-06-14]`, the `extractImageUrls`/`stripImageUrls` branch), which a
  desktop `embeddedMedia` post does NOT contain.
- Result: **a desktop user's photo+caption renders on mobile as caption text only — the image
  is silently dropped.** (Confirmed still present 2026-06-14: there is NO `content.embeddedMedia`
  branch in `toDisplayMessage`.)

Conversely mobile sends images as `type:'embed'` + an informal `text?` field that **isn't even
in the shared `EmbedMessage` type** (`services/space/spaceMessageService.ts:983-994` `[2026-06-14]`,
`components/Chat/SpaceChatArea.tsx:414-428`).

The parity report `.agents/reports/2026-06-12-permission-and-message-parity-findings-index.md`
§7 rated this LOW and described it as "caption may be lost" — it's actually the **image** that's
lost. Correct that severity to Tier 2 when this lands.

## Why `post` + `embeddedMedia` is the convergence target (settled 2026-06-13)

`post`+`embeddedMedia` is a strict superset of `embed`:
- carries text + media + reply + thumbnail + full-res in ONE message type;
- the media discriminant is `embeddedMedia[].type` (a string), so new media kinds extend the
  array element, not the top-level message-type union (fewer top-level types = fewer things the
  render switch can fail to recognize — directly relevant to the default-deny hardening task);
- `embed` can't even carry a caption, which is why mobile bolted on an off-type `text?` field.

**`embed` becomes RECEIVE-only legacy everywhere.** Old messages already persisted as
`type:'embed'` (desktop IndexedDB, mobile MMKV) exist forever — both renderers must keep decoding
`embed` indefinitely. Convergence means **stop EMITTING `embed`, not delete the embed renderer.**

## The `embeddedMedia` shape (from shared `2.1.0-26`, already installed)

`PostMessage.embeddedMedia?: Array<{ type: string; key: string; data: string; mimeType: string }>`
(`@quilibrium/quorum-shared/src/types/message.ts:16-21`).

Desktop builds entries as (`useMessageComposer.ts:194-210`):
- `{ type: 'image-thumbnail', key: <uuid>, data: <base64>, mimeType }` — pushed first, only when a
  thumbnail was generated;
- `{ type: 'image', key: <same uuid>, data: <base64>, mimeType }` — the full image;
- (`{ type: 'youtube-thumbnail', key: <videoId>, ... }` for YouTube previews — out of scope here).

`data` is raw base64 (no `data:` prefix); reconstruct a src via
`data:${entry.mimeType};base64,${entry.data}` (desktop's `utils/embeddedMedia.ts:9-18`).

## The GIF flag — derive at render, NO shared field (Option B)

Desktop's `embed` path carries `isLargeGif` (`useMessageComposer.ts:288`). It does **not** mean
"is a GIF" — it means specifically **"a GIF large enough that we generated a separate static
thumbnail"** (`unifiedProcessor.ts:104-112`: `isLargeGif:true` only when
`shouldGenerateGifThumbnail()` passed AND a thumbnail exists). The render behavior it drives:
show the static thumbnail, play the animation in-place on click (vs a small GIF that animates
inline with no thumbnail) — desktop `Message.tsx:1297-1311`.

This is **already represented structurally** in `embeddedMedia`: a large GIF has BOTH an
`image-thumbnail` entry and an `image` entry under the same `key`; a small GIF has only the
`image` entry. So:

> **Derivation rule (use this verbatim on both apps):**
> `isLargeGif` ≡ the `image` entry's `mimeType === 'image/gif'` AND a matching `image-thumbnail`
> entry exists for the same `key`.

GIF *detection* itself is already derivable from `mimeType` / data-URI (desktop's
`createGifDetector`, `Message.tsx:69-76`, checks `data:image/gif` and `.gif` extension). So no flag
needs to travel on the wire and `@quilibrium/quorum-shared` does not change.

## 1. Mobile — RENDER (read `embeddedMedia`)  ← REMAINING WORK, statically verifiable

`components/Chat/types.ts` — in `toDisplayMessage` (`:363` `[2026-06-14]`), add a NEW branch for
`content.type === 'post'` that reads `content.embeddedMedia` (place it alongside the existing
`post` text-URL-scan branch at `:419-429`):
- Find the `image-thumbnail` + `image` entries (match by `key`). Set
  `displayMessage.imageUrl = data:${image.mimeType};base64,${image.data}` and
  `displayMessage.thumbnailUrl` from the thumbnail entry if present.
- Set `displayMessage.renderType = 'embed'` so the existing embed render path renders it (same
  fields it already consumes for native `embed` — `imageUrl`/`thumbnailUrl`/`videoUrl`, set in the
  `content.type === 'embed'` branch at `:411-417` `[2026-06-14]`).
- Keep the `text` as the caption — `getMessageText` is at `types.ts:227` `[2026-06-14]`; confirm a
  `post` caption flows to the rendered bubble the same way an `embed` caption does. A `post` already
  has `text`, so this should just work — verify, don't assume.
- Derive large-GIF behavior from the rule above (thumbnail-present + `image/gif`) for in-place
  playback parity.
- Leave the existing text-URL-scan branch (`:419-429`) in place for back-compat with the old
  "[Media] + inline URL" desktop format, AND keep the native `embed` branch (`:411-417`) — old
  persisted `embed` messages must still render (receive-only legacy).

**Verify §1 statically:** the new branch reads `content.embeddedMedia`, builds the data-URI, sets
`renderType='embed'`; `npx tsc --noEmit` clean; `yarn lint` clean. (§1 makes desktop photos visible
on mobile immediately and can land alone.)

## 2. Mobile — SEND (emit `post` + `embeddedMedia`, stop emitting `embed`)  ← REMAINING WORK, runtime-test required

Current emit is at `services/space/spaceMessageService.ts:983-994` `[2026-06-14]` — builds
`{ type:'embed', ..., imageUrl, text? }` (the off-type `text?` at `:961`). Caller:
`components/Chat/SpaceChatArea.tsx:414-428`.
- Build `embeddedMedia` entries the same way desktop does (thumbnail entry first when a thumbnail
  exists, then the full `image` entry, shared `key` UUID, raw base64 in `data`, `mimeType`) — mirror
  desktop `useMessageComposer.ts:194-208` `[2026-06-14]`.
- Send `{ type:'post', senderId, text: caption || '', embeddedMedia, repliesToMessageId }` instead
  of `{ type:'embed', ..., text }`.
- Mobile's image processing must produce a thumbnail for large GIFs to preserve the in-place-play
  UX (check whether RN image processing already generates one; if not, large GIFs simply animate
  inline — acceptable degradation, note it). **This is the one open investigation inside §2.**
- Image-only-no-caption: same payload with `text: ''`.
- **Runtime test required:** send mobile→desktop image+caption, image-only, and a GIF; confirm each
  renders correctly on desktop (which already consumes `post`+`embeddedMedia`).

## 3. Desktop — SEND  ✅ ALREADY DONE (no action — kept for record)

Re-verified 2026-06-14: desktop's `useMessageComposer.ts` already emits `post`+`embeddedMedia` for
all image cases — text+image (`:236`), multi-image (`:263`), and image-only (`:303`, `text:''`).
**Desktop no longer emits `type:'embed'` anywhere** (grep-confirmed). The original task assumed the
image-only branch still built an `EmbedMessage`; it has since been converted. Nothing to do here.
Desktop's renderer handles `post`+`embeddedMedia` and old `embed` receive-only, as before.

## Acceptance criteria

- [ ] Desktop sends photo+caption → **mobile shows the image AND the caption** (the core bug).
- [ ] Mobile sends photo+caption → desktop shows image + caption (mobile now emits `post`).
- [ ] Mobile sends image-only → renders correctly on both (empty caption, no phantom text).
- [ ] Large GIF (with thumbnail): static thumbnail shown, animates in-place on tap, on BOTH apps,
      via the derived rule (no `isLargeGif` flag on the wire).
- [ ] Small GIF (no thumbnail): animates inline on both.
- [ ] Old persisted `embed` messages still render on both apps (receive-only path intact).
- [ ] No `@quilibrium/quorum-shared` change; mobile + desktop pins unchanged.

## Notes

- **Scope is now mobile-only** (§1 render + §2 send). §3 desktop send already shipped. No shared
  change, no version bump, no desktop PR.
- Sequencing: §1 (render) is the user-visible bug fix and can ship first/alone — it makes desktop
  photos visible on mobile immediately and is statically verifiable. §2 (send) completes the
  convergence and needs a runtime send/receive test. Doing both together is fine when time allows.
- Pairs with `2026-06-13-harden-unsupported-message-type-handling.md` — keeping the top-level
  message-type count low (one media carrier instead of two) is exactly the principle that task
  enforces.
- Related crypto/messaging investigation (separate issues, do not conflate): the image-drop here is
  a RENDER bug, distinct from the desktop sync-path signature bug (fixed on desktop) and Symptom B
  (test user receives nothing). See `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`.

---
*Created: 2026-06-13*
*Last updated: 2026-06-14 — refreshed against current code: §3 (desktop send) found already shipped → scope reduced to mobile-only (§1+§2); re-anchored drifted line numbers; confirmed embeddedMedia present in installed 2.1.0-29; clarified §1-static / §2-runtime verification split.*
