---
type: bug
title: "Custom emoji/sticker lose PNG transparency (black background added) on import — pre-existing"
status: open
created: 2026-07-16
severity: medium (visible defect — transparent emoji/stickers get an opaque black box)
repo: quorum-mobile
area: custom assets / image picking (emoji + sticker)
related:
  - "services/media/customAssets.ts (processEmojiAsset / processStickerAsset / resizeImage)"
  - ".agents/issues/.done/2026-06-24-plug-mobile-into-shared-image-config.md (surfaced during device test of the config-only adoption; that PR did NOT touch format handling)"
discovered-during: "runtime device test of feat/adopt-shared-image-config (2026-07-16)"
---

# Custom emoji/sticker lose transparency (black background) on import

## Symptom (observed 2026-07-16, device)

- Importing a **transparent-background PNG** as a custom emoji (and sticker) produces an emoji with a
  **solid black background** instead of preserving alpha. The transparency is gone by the time the
  asset is stored/rendered.

## NOT the cause (ruled out)

- **NOT the shared-image-config adoption (`feat/adopt-shared-image-config`).** That change only sourced
  the numeric limits (`maxSize`, `quality`) from shared `IMAGE_CONFIGS`; it touched **zero** format
  lines. `git diff` on `customAssets.ts` for that commit shows no `format`/`PNG`/`JPEG`/`SaveFormat`
  changes. The resize path already saved (and still saves) `ImageManipulator.SaveFormat.PNG`
  (`customAssets.ts:103`), so our re-encode is not flattening alpha.
- **NOT the downstream PNG resize.** `resizeImage` correctly uses `SaveFormat.PNG` — PNG supports alpha,
  and it only runs when the longest axis exceeds `maxSize`. Small transparent emoji that skip resize
  ALSO show the black box, which points upstream of our resize.

## Most likely root cause (needs confirmation, do not assume from memory)

**`allowsEditing: true` on the picker.** `pickEmoji` launches the library picker with
`allowsEditing: true, aspect: [1,1]` (`customAssets.ts:136-137`) to let the user crop to square. On
**Android**, expo-image-picker's built-in crop/edit UI is known to **composite the image onto an opaque
(black) background**, discarding the alpha channel — this happens inside the native picker, BEFORE any
of our code sees the bytes, so our PNG re-encode can't recover it. (`pickSticker` does NOT set
`allowsEditing`, so if stickers ALSO show the black box, the cause is elsewhere — e.g. the `base64:true`
picker output being JPEG-encoded, or `manipulateAsync` needing an explicit alpha-preserving path.
Test emoji vs sticker separately to localize.)

## How to confirm it's this and not our code

1. Temporarily set `allowsEditing: false` in `pickEmoji` and re-import the same transparent PNG. If
   transparency is preserved → the native crop UI is the culprit (expected).
2. If it's STILL black with `allowsEditing:false`, log the `mimeType` and first bytes of `asset.base64`
   from the picker — check whether the picker is already handing us a JPEG (no alpha) regardless.
3. Confirm against the installed **expo-image-picker version's** docs/changelog (Context7) — the
   `allowsEditing` alpha-flatten behavior is version-specific and has shifted across releases. Do not
   fix from memory.

## Suggested fix direction (validate first)

- If the crop UI is the cause: either drop `allowsEditing` for emoji (accept non-square emoji, which
  the aspect-preserving resize already supports), or replace the native crop with an in-app cropper that
  preserves alpha. Dropping `allowsEditing` is the cheap fix but changes the square-crop UX.
- Ensure `manipulateAsync` output stays PNG for any input that had alpha (already true) and that the
  picker itself is asked for PNG-capable output where the API allows.

## Scope note

Pre-existing, independent of the shared-image-config work. Surfaced during that PR's device test but is
a separate render/import defect. Filed so it isn't lost; not a blocker for the config adoption PR
(which is a pure numeric-sourcing refactor and does not regress this).

---
*Created: 2026-07-16*
