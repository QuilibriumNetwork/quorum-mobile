---
type: task
title: "Skin gallery: real-color swatches (DEFERRED — needs lead-dev decision)"
status: deferred
created: 2026-06-15
---

# Skin gallery: real-color swatches (DEFERRED — needs lead-dev decision)

**Status:** Deferred. Blocked on a product/architecture decision that must be presented to the lead dev before any implementation.

## Context

We added per-skin preview swatches to the **Skins** modal ([components/skins/SkinsModal.tsx](../../components/skins/SkinsModal.tsx)).

- A swatch is a small (40px) rounded square, split diagonally: top-left triangle = skin **accent**, rest = skin **background** (`surface1`). The chip's own corner radius reflects the skin's geometry (square for square-corner skins, rounder for roomy ones). Component: [components/skins/SkinSwatch.tsx](../../components/skins/SkinSwatch.tsx).
- **My Skins tab** renders real per-skin colors — the full `SkinOverride` is on-device, so `skin.colors[base].accent` / `surface1` and `deriveGeometry(skin)` resolve directly. This work is DONE and should be kept; it has no external dependency.
- **Gallery tab** shows NO swatch (text rows only). A neutral chip was tried but removed: it's a misleading all-grey fake-preview, identical for every skin, since the gallery list does NOT carry per-skin colors. Real gallery previews are what this task unblocks.

## The blocker

`fetchSkinGallery` returns `SkinSummary[]`. A summary has `name`, `base`, `installs`, `description`, `authorName`, and an (always-empty) `thumbnail` — **no color tokens**. The full palette only arrives via `fetchSkin(id)` (one full bundle per skin). So the gallery cannot draw real-color chips from the data it currently receives.

Also discovered: `publishSkin` already accepts + signs + sends an optional `thumbnail` (data:image PNG/JPEG), the server stores it, and the summary returns it — but **no caller ever passes one**, and there is no thumbnail option in the editor. The thumbnail pipeline is scaffolded but dead. It was evidently intended to be auto-generated, not user-uploaded.

## Options to present to the lead dev

### Option 1 — Add color tokens to the gallery API (server change)
Extend the server's gallery summary response to include `accent`, `surface1`, and accent-border info per skin (a handful of values). Mobile maps them in `RawSummary`/`SkinSummary`; the live 40px chip renders real colors with zero images.
- Pros: lightest in-app, always correct, fixes EXISTING published skins immediately, no image generation.
- Cons: requires a **quorum-api** change (separate repo) + redeploy.

### Option 2 — Auto-generate a thumbnail PNG at publish (app change)
At publish time, render the chip to a small PNG via `react-native-svg`'s `Svg.toDataURL()` (confirmed present in 15.12.1 — **no new dependency**) and pass it as `publishSkin({ thumbnail })`. Gallery displays the image.
- Pros: no server schema change (slot already exists); generated automatically (not a manual editor field).
- Cons: heavier per-publish; **existing** published skins stay grey until republished; PNG is overkill for a 40px chip.

### Option 3 — Something else entirely
The lead dev may have a different intent for the gallery preview (e.g. a full mock-card detail view, a different discovery UX, server-side rendered previews). Surface the question openly rather than presupposing 1 vs 2.

## Decisions already made (for the small-chip design)
- Keep the preview to a **40px diagonal chip** (accent + background + corner radius + optional accent border/width). Panel glow was considered but is illegible at 40px — skip it.
- Font preview is out (would require per-row font loading).

## Showable-in-thumbnail feature map (reference)
Accent, background, card color, text/muted color, corner radius, accent border, border width → showable. Panel glow → renderable via SVG blur but subtle/illegible small. Font, spacing scale, wallpaper → skip for the chip.

## Follow-up
- [ ] Present Options 1 / 2 / 3 to the lead dev; ask their intent for the gallery preview and the dead `thumbnail` pipeline.
- [ ] Confirm whether the quorum-api repo is reachable / who owns the gallery endpoint (gates Option 1).
- [ ] Verify the shipped **My Skins** chips visually on device (source is correct; not yet eyeballed live).

---
*Last updated: 2026-06-15*
