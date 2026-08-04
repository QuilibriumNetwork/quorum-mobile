---
type: task
title: "Space folders — Telegram-style pill bar (filter, not DnD)"
status: open
created: 2026-06-17
source: port-to-mobile candidates #25
priority: medium
effort: medium
ux-decision: Option A (pill bar) — decided 2026-06-17
depends-on: 2026-06-17-horizontal-pill-menu-ux-improvements.md (SegmentedPills primitive)
---

# Space folders — Telegram-style pill bar

## Problem

Desktop has full space folders (collapsible, named, colored, create-by-drag). Mobile's **data layer already round-trips folders correctly** — `services/config/configService.ts` reads/writes/validates the `items: NavItem[]` array (`validateItems`, `MAX_FOLDERS = 20`, `MAX_SPACES_PER_FOLDER`, key-filtering of stale spaces). But the **Spaces tab UI ignores `items` entirely**: `app/(tabs)/spaces/index.tsx:111-137` builds a flat `SpaceItem[]` from `spaces`, sorts by timestamp, and renders one FlashList. Folders synced from desktop are silently flattened — no folder UI, no editor, no way to create one on mobile.

## UX decision (locked 2026-06-17): Option A — pill bar

A horizontally-scrolling row of folder "pills" at the top of the Spaces list. Tap a pill → filter the list to that folder's spaces. NOT desktop's collapsible-groups + drag-to-create model (rejected: DnD on mobile lists fights scroll + accessibility, higher cost, worse touch UX). The pill bar reads the SAME `items` data desktop writes, so cross-device folders Just Work.

## Data shape (shared `NavItem`, confirmed in `-31`)

```ts
type NavItem =
  | { type: 'space'; id: string }
  | { type: 'folder'; id: string; name: string; spaceIds: string[];
      icon?: string; color?: FolderColor; iconVariant?: 'outline'|'filled';
      createdDate: number; modifiedDate: number };
```
`UserConfig.items?: NavItem[]`. `FolderColor = string`. No shared work, no version bump — mobile already on `2.1.0-31`. (`validateItems`/`MAX_FOLDERS` are mobile-local in `configService.ts`, already enforced — reuse them, don't re-add.)

## UX decisions (locked 2026-06-18)

Resolved in design session — do not re-open without a specific reason:

1. **Multi-folder membership — not supported.** A space belongs to at most one folder. Filter logic is simple: `folder.spaceIds.includes(spaceId)`.
2. **Uncategorized spaces** — no "Uncategorized" pill. "All" pill (always first, default-selected) shows the full flat list including uncategorized spaces. Folder pills filter to their members only.
3. **Pill bar visibility** — only rendered when at least one folder exists. Hidden for users with no folders.
4. **Folder creation entry point** — a dedicated folder icon is always present in the Spaces tab header (alongside the existing compass + plus icons). Tapping it opens the folder management screen (see below). This is the only creation entry point on mobile; there is no `+` pill in the bar.
5. **Long-press on a pill** — opens a shortcut sheet for that specific folder (rename, color, delete, manage spaces). This is a power-user shortcut; the canonical path is the folder management screen. A one-time hint ("Hold to edit") appears on first pill bar render to teach the gesture.
6. **Empty folders — keep, never auto-delete.** Tapping an empty folder pill shows an empty state. Explicit delete is the only removal path, via the folder management screen or the long-press shortcut sheet. ⚠️ **Desktop fix needed**: desktop currently auto-deletes empty folders — align it to keep-on-empty behavior (flag to lead dev).
7. **Folder ordering** — preserve `items` array order from `UserConfig` (same order as desktop). No mobile reorder for now; reorder on desktop is reflected in pill order on mobile.

### Folder management screen

Reachable via the header folder icon (always) or long-press on a pill (shortcut). Contains:
- Ordered list of folders with drag handles to reorder
- Tap a folder → folder detail: rename, change color/icon, add/remove spaces (searchable space list with checkboxes)
- Delete folder (explicit, with confirmation)
- "New folder" button (creation entry point)

⚠️ **Flag to lead dev (Telegram):** keep-empty-folders decision requires a desktop-side fix. Draft on request.

Send the lead a 2-line Telegram once scoped (per atlas §4 — anything touching mobile UX the lead may care about). Draft on request.

## Implementation sketch

1. **Read `items`** in the spaces tab — pull `UserConfig.items` (via the same config hook the tab/`configService` already uses) alongside `spaces`.
2. **Build the pill model** — derive `folders = items.filter(i => i.type === 'folder')`. Prepend a synthetic "All" pill.
3. **Pill bar component** — build on the shared `SegmentedPills` primitive (`components/ui/SegmentedPills.tsx` + `hooks/useCenteredPillScroll.ts`, shipped by the [pill-menu task](../.done/2026-06-17-horizontal-pill-menu-ux-improvements.md)). Do NOT hand-roll another scrollable pill row. `SpaceFolderPills.tsx` becomes a thin wrapper: derive folder items from `items`, prepend a synthetic "All" pill, render `<SegmentedPills scrollable centerOnSelect ... />`, map `onChange` → `setActiveFolderId`. The primitive already supplies scroll/centering (tap-to-center), token-driven active state, 44pt hit targets, and a11y — see the mapping table below. New component `components/Spaces/SpaceFolderPills.tsx` (or similar).

   **Variant — use `variant="solid"`, NOT `tinted`** (updated 2026-06-17 after the pill-menu implementation). The folder bar is a row of many similar pills where one is selected — the same situation as the wallet/swap chain selectors. We found `tinted` makes the active-vs-rest difference too subtle there (selected pill only marginally more prominent). The chain selectors converged on `solid`: **active pill = full solid color + white text; rest pills = dimmed wash of their own color.** Folders carry a per-folder `color`, so `solid` + `accentColor` gives each folder identity at rest and an unmistakable active state. The "All" pill (no color) falls back to the app accent. Re-evaluate on device, but start at `solid`.

   **`SegmentedPills` ↔ folders mapping (against the SHIPPED component API):**
   - Folder name + icon → `SegmentedPillItem.label` + `.icon` (`icon` is an `IconSymbolName`)
   - Per-folder color → `SegmentedPillItem.accentColor` (per-item override; drives solid fill when active, dim wash at rest)
   - "All" pill default-selected → `activeKey` (non-null string, e.g. `'all'`)
   - Tap → filter + land selection → `centerOnSelect` (default on when `scrollable`)
   - Optional space-count line ("3 spaces") → `SegmentedPillItem.subtitle` (two-line pill, added for the Receive chain selector — available if wanted)
   - Custom leading element (e.g. a folder-color chip/avatar) → `SegmentedPillItem.leading` (arbitrary `ReactNode`). **NOTE:** there is NO `imageUrl` prop — image chips were intentionally left bespoke. Use `leading` if a custom chip is needed.

   > **Caveat:** the primitive only covers the bar's render/scroll/style layer. The folder edit sheet, "add to folder" action sheet, and the `configService` writeback (steps 5–6) are still net-new for this task — not provided by `SegmentedPills`.
4. **Filter the list** — when `activeFolderId` is set, restrict `items` (the existing `SpaceItem[]` memo) to `folder.spaceIds`; "All" = no filter. Keep the existing search + timestamp sort within the filtered set.
5. **Folder management screen** — new screen/modal opened from the header folder icon. Shows ordered folder list with drag-to-reorder. Tapping a folder opens a detail view: name input, color/icon picker, searchable space list with checkboxes for membership. "New folder" button at top/bottom. Delete with confirmation. Writes back to `items` via `configService` (validate + broadcast for cross-device sync).
6. **Long-press a pill** — shortcut sheet for that folder only (rename, color, delete, manage spaces). One-time "Hold to edit" hint on first pill bar render. This is a secondary path; canonical management is the screen above.
7. **Header folder icon** — always visible in the Spaces tab header alongside compass + plus. No space rows are long-pressed; no changes to `SpaceSettingsModal`. Honor `MAX_FOLDERS = 20` (disable "New folder" at cap with a snackbar).
8. **a11y** — pills are buttons with `accessibilityRole="button"` + selected state; 44pt hit targets (iOS HIG); long-press shortcut has a tap-accessible alternative via the header icon.

## Files to touch

- `app/(tabs)/spaces/index.tsx` — read `items`, add pill bar above the FlashList, filter by `activeFolderId`, add folder icon to header
- `components/Spaces/SpaceFolderPills.tsx` (new) — the pill bar, a thin wrapper over `components/ui/SegmentedPills.tsx` (NOT a fresh scrollable row); includes one-time long-press hint
- `components/ui/SegmentedPills.tsx` + `hooks/useCenteredPillScroll.ts` — **dependency, reuse only.** Shipped by the [pill-menu task](../.done/2026-06-17-horizontal-pill-menu-ux-improvements.md); do not re-implement pill scroll/centering/styling here.
- `components/Spaces/FolderManagementScreen.tsx` (new) — full folder management: ordered list, drag-to-reorder, create, folder detail (name/color/icon/space membership), delete
- `services/config/configService.ts` — reuse existing `items` write/validate path; confirm it broadcasts on change (cross-device sync)

## iOS review notes (Android-only testing — atlas §3)

- Pill bar horizontal scroll vs the vertical list scroll: verify no gesture arbitration issue on iOS (nested scroll resolves differently than Android).
- 44pt hit targets on pills (iOS stricter than Android).
- Safe-area: pill bar sits below the header; no bottom-inset concern, but check it doesn't collide with the search field.

## Notes

- No shared change, no version bump.
- Data layer is done; this is purely the mobile Spaces-tab UX build + a writeback path for folder membership.
- Reuses the cross-platform `items` contract, so a folder made on desktop appears as a pill on mobile and vice-versa once the writeback broadcasts.
- **Depends on the [pill-menu primitive task](../.done/2026-06-17-horizontal-pill-menu-ux-improvements.md)** for `SegmentedPills` + `useCenteredPillScroll`. As of 2026-06-17 the primitive is **built on branch `feat/segmented-pills-primitive`** (awaiting device test + PR). It now supports: `tinted` + `solid` variants, per-item `accentColor`, `danger`, `subtitle` (two-line), `leading`/`trailing` (arbitrary ReactNode), `emojiSize`/`iconSize`, `allowReselect`, fixed/scrollable. Pick this up AFTER that branch ships so the bar is a wrapper, not a rebuild.

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row 25 (detailed entry "25. Space folders").

*Last updated: 2026-06-18 — full mobile UX design session. Locked: no multi-folder membership, no uncategorized pill, keep empty folders (+ desktop fix needed), folder icon always in header as creation/management entry point, long-press pill as power-user shortcut with one-time hint, folder ordering from `items` array. Updated implementation sketch and files-to-touch accordingly.*
