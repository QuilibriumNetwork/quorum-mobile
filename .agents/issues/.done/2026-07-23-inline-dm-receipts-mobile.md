---
type: task
title: "Inline DM read/delivery receipts (mobile)"
status: done
created: 2026-07-23
---

# Inline DM read/delivery receipts (mobile)

**Status:** Slices 1+2 implemented (text paths inline; typecheck+lint clean, not yet device-verified). Slice 3 (media) + on-device tuning remain.
**Branch:** `fix/mobile-inline-dm-receipts` (off master)

## Progress

- [x] Slice 1 — leaf (`ReceiptTicks` + base64 `receiptCheckAssets.ts`), muted color, plain-path inline via `MentionableText`.
- [x] Slice 2 — markdown path: inline into last text block, compact fallback row for code/quote/hr endings. Link-card + bodyless posts use a fallback row in `MessagesList`.
- [x] Slice 3 — media (embed/sticker) receipts (branch `fix/mobile-media-receipts`): caption inlines the receipt; captionless embed + stickers get a compact row below. Net-new (none before).
- [ ] On-device tuning: baseline `translateY` nudge + render size (checks fill full 64px height, may read heavy at 12dp — try ~11dp). Confirm `tintColor`+data-URI renders on Android.
      **Owner context:** LaMat flagged mobile DM receipts look bad vs desktop (screenshot 2026-07-21): ticks land on their own line, opening empty gaps between grouped messages; use accent color instead of desktop's muted; and are raw glyphs, not icons.

---

## Goal (user-visible outcome)

In a DM, the delivery/read tick sits **on the same line, trailing the last word** of a text message (Telegram-style), in a **muted color** (not accent), rendered as the **Tabler check** icon (one = delivered, two = read). The empty vertical gap between grouped own-messages disappears. Media messages carry the tick in a compact row directly beneath.

LaMat verifies by sending a burst of short DMs (like the screenshot's "1..5") and confirming the ticks tuck beside each line with no dead space, plus a markdown message and an image.

---

## The governing constraint (why this isn't a copy-paste from desktop)

Desktop inlines the tick with one CSS rule — `.has-inline-suffix > p:last-of-type { display: inline; }` (`quorum-desktop/src/components/message/Message.scss:316`) — so the trailing receipt joins the last line's box and wraps with it.

**React Native has no `display:inline`, no `float`, no text-wrap-around-a-sibling.** Yoga is flexbox-only. In RN an element shares a text line and wraps with the text **only if it is a child of the same `<Text>`.** The two RN elements that legally flow inside `<Text>`: nested `<Text>`, and `<Image>`. `react-native-svg` components (i.e. `IconSymbol`) do **not** — they ignore the text box and break wrapping (refs: react-native-svg #892, hybridheroes.de inline-icons writeup).

**Consequence:** the receipt must be a nested inline child of the terminal text run. The current implementation violates this — it's a sibling block with `alignSelf:'flex-end'` + `marginTop` — which is the entire cause of the own-line gap.

---

## Current state (what exists today)

- `components/Chat/MessagesList.tsx:796-813` — `renderReceipt(item)`: builds a block-level `<Text>` with glyph `✓︎`/`✓︎✓︎`.
- Styles `MessagesList.tsx:1656-1665` — `receiptIndicator` (`alignSelf:'flex-end'`, `color: textSubtle`, `marginTop:2`), `receiptIndicatorRead` (`color: primary` ← the wrong accent color).
- Called **only** in `renderPostMessage` at `MessagesList.tsx:1207`, as a sibling **after** the `<MessageRenderer>` output. → own line, gap, accent.
- **Not** called in `renderEmbedMessage` (967) or `renderStickerMessage` (1038) → media has no receipt at all today.

Body text takes one of three terminal shapes (all must be handled):

| Path                      | When                                                                         | Terminal                                        | File                                         |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| `MentionableText`         | no markdown (plain line, bare mention, emoji-only) — **the screenshot case** | single `<Text>`                                 | `MentionableText.tsx:458` / `:518`           |
| `MessageMarkdownRenderer` | has markdown                                                                 | `<View>` of per-block `<Text>`/`<View>`         | `MessageMarkdownRenderer.native.tsx:441-492` |
| media renderers           | embed/sticker                                                                | image/View, caption re-enters `MessageRenderer` | `MessagesList.tsx:988-1025`                  |

Dispatch: `MessageRenderer.tsx` routes plain→`MentionableText`, markdown→`MessageMarkdownRenderer`.

Desktop parity reference (color/semantics): `Message.tsx:1048-1064` (one check delivered / two read, both same node), `Message.scss:264-294` (`color: var(--color-text-muted)` for both; `.read` only tightens spacing via `svg + svg { margin-left:-6px }`).

---

## Design (locked)

Branch by content type — same as Telegram/WhatsApp/desktop, because a text line and an image share no anchor:

| Content type                                                   | Placement                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Text** (plain, or markdown ending in paragraph/heading/list) | inline child appended to the **terminal `<Text>`'s last run** — trails last word, wraps when the last line is full |
| **Media, no caption** (image/sticker/video)                    | compact **right-aligned row directly beneath** the media (LaMat's call: row-below for now, revisit overlay later)  |
| **Media + caption**                                            | trails the **caption** (falls back to the text rule, since the caption re-enters `MessageRenderer`)                |
| **Degenerate** (markdown ending in code/`hr`)                  | compact trailing micro-row beneath — rare fallback                                                                 |

### Leaf element: inline `<Image>` Tabler check, bundled as base64 data-URI (LaMat's call — not icon font, not expo-asset file)

- `<ReceiptTicks read={boolean} />` returns a `<Text>`-embeddable inline `<Image>`.
- **Two pre-composed states, each a single `<Image>`:** `receipt-check` (one check, delivered) and `receipt-check-double` (two checks with the tight overlap baked into the asset, read). One `<Image>` per state → simplest inline element, best baseline behavior, overlap is pixel-perfect from design instead of tuned in RN layout.
- **Source = base64 data-URI in a `.ts` module, NOT `require()` of a file under `assets/`.** This is the deliberate anti-pit choice (see Risks → apex). A data-URI source lives in the JS bundle (a string), so it never passes through expo-updates' `createReleaseUpdatesResources` / `app.manifest` → the stale-manifest blanking that hit apex **structurally cannot** happen. One crisp raster per state (~36-48px source) downscaled to display size; no @2x/@3x density set.
- **Color is 100% in code:** the raster is a flat template (opaque shape, transparent bg); `tintColor: theme.colors.textMuted` recolors it at runtime. Full theme control, re-themes with skins, per-state color trivial if ever wanted. Both states use `textMuted`; delivered = one check, read = two. Never `primary`.
  - Tabler check reference to trace the shape from: `assets/icons/iconset/Check.jsx` (SVG); `IconSymbol` maps `checkmark`→Tabler check.
- **Display size:** 12dp height (matches desktop's 12px). Single = 12×12; double ≈ 18×12 (3:2). Set explicit `<Image>` width/height to the double asset's real aspect so it never stretches.
- Baseline: inline `<Image>` in `<Text>` can sit slightly off-baseline (documented RN caveat) — expect a small `transform:[{translateY}]` nudge; tune on device.
- **Verify on Android in Slice 1:** `tintColor` + data-URI `<Image>` is standard but has historical Android flakiness on old RN — confirm it tints/renders before building on it. Fallback if it misbehaves: file assets + `build-prod-variant.ps1` guard (Risks → apex).

---

## Implementation plan (thread one `receipt` node)

Vertical slices, each independently checkable on device.

### Slice 1 — Leaf + color + plain-path inline (fixes the screenshot)

1. Add the two Tabler-check rasters as **base64 data-URI constants in a `.ts` module** (e.g. `components/Chat/receiptCheckAssets.ts`): `RECEIPT_CHECK` (single) and `RECEIPT_CHECK_DOUBLE` (overlap baked in). Flat template shape, transparent bg. NOT files under `assets/` (anti-pit — see Risks → apex).
2. New `components/Chat/ReceiptTicks.tsx`: single `<Image source={{uri}}>` per state (`read`→double, else single); `tintColor = textMuted`; explicit width/height to the asset aspect. **Confirm tint+render on Android first.**
3. `MessageRenderer.tsx`: add `receipt?: React.ReactNode` prop; forward to `MentionableText`.
4. `MentionableText.tsx`: accept `receipt`; render it as the **last child inside the terminal `<Text>`** — cover both branches: no-special-content (`:458`), special-content (`:518`), emoji-only (`:455`), and thread past the `renderWithToggle` wrapper (`:134`) so it lands in the inner `<Text>`, not the outer `<View>`.
5. `MessagesList.tsx renderPostMessage`: stop rendering `renderReceipt` as a sibling; instead pass the ticks into `<MessageRenderer receipt={...}>`. Delete the old `renderReceipt` block usage for the text path.
6. Keep the `isDM && item.userId === currentUserId && (deliveredAt||readAt)` gate that `renderReceipt` had (`:798-799`).

**Check:** short DM burst → ticks beside each line, no gap, muted color, Tabler shape.

### Slice 2 — Markdown path

7. `MessageMarkdownRenderer.native.tsx`: accept `receipt`; when the **last block is paragraph/heading/list**, append the receipt as the final inline child inside that block's `<Text>` (`:454`/`:448`/`:470`). When the last block is `code`/`hr`/`blockquote`, render a compact trailing micro-row beneath the container instead.
8. `MessageRenderer.tsx`: forward `receipt` to `MessageMarkdownRenderer` too.

**Check:** markdown message (bold + a trailing sentence) → tick trails last word; a message ending in a code block → tick in a small row below.

### Slice 3 — Media

9. `renderEmbedMessage` / `renderStickerMessage` (`MessagesList.tsx:967` / `:1038`): add the receipt. If a caption exists (embed `item.content`), pass `receipt` into that `<MessageRenderer>` (text rule). If no caption, render a compact right-aligned row beneath the media (reuse a shared `receiptRow` style).
10. Remove the now-unused `renderReceipt` function and `receiptIndicator`/`receiptIndicatorRead` styles once all paths are migrated.

**Check:** image DM (no caption) → tick row under image; captioned image → tick trails caption.

---

## Risks / tuning notes

- **apex stale-manifest pit (the reason for data-URI, not file assets).** A new JS-`require`d image under `assets/` can render fine in dev but **blank in local `.preview`/release builds**, because expo-updates' `createReleaseUpdatesResources` task stays `UP-TO-DATE` and re-ships a **stale `app.manifest`** that predates the new asset (`expo-asset` then can't resolve the embedded copy). **Mitigation chosen: bundle the icon as a base64 data-URI so it never touches the asset manifest.** If we ever fall back to file assets: test local release only via `build-prod-variant.ps1` (it deletes the stale generated bundle/asset outputs first), and if a tick is blank in `.preview` but fine in dev, **suspect stale manifest FIRST** (grep the asset name in `app.manifest`), not a real bug — that misdiagnosis is exactly what burned time last round.
- **Baseline alignment** of inline `<Image>` in `<Text>` — the main visual risk; budget device tuning (`translateY`, `lineHeight`).
- **Android `tintColor`** on a data-URI `<Image>` — confirm it recolors correctly on Android in Slice 1 (works in modern RN, but historical flakiness on old RN; verify before building on it).
- **Overlap spacing** for the double check — tune `marginLeft` to match desktop's tightness without clipping.
- Media receipt is **net-new** (none today) — make sure the gate matches the text path (own message, DM, delivered/read set) so we don't show ticks on incoming media.
- Icon-font route remains the documented upgrade path if vector-scaling ticks are ever wanted; layout/threading work is identical, only the leaf differs.

---

## Files

- `components/Chat/MessagesList.tsx` (renderPostMessage, renderEmbedMessage, renderStickerMessage, renderReceipt removal, styles)
- `components/Chat/MessageRenderer.tsx` (new `receipt` prop, forward)
- `components/Chat/MentionableText.tsx` (inline receipt in terminal Text)
- `components/Chat/MessageMarkdownRenderer.native.tsx` (last-block receipt + micro-row fallback)
- `components/Chat/ReceiptTicks.tsx` (new)
- `components/Chat/receiptCheckAssets.ts` (new — base64 data-URI constants; NO file assets, anti-pit)

Desktop reference (read-only): `quorum-desktop/src/components/message/Message.tsx:1040-1125`, `Message.scss:264-346`, `MessageMarkdownRenderer.tsx:851-862`.

_Last updated: 2026-07-23_
