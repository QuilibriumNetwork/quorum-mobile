---
status: done
created: 2026-06-12
type: task
title: "Channel & group icons + per-item settings drawer (mobile)"
runtime-test: required (UI + a real data bug)
priority: mixed — 0 is a live bug (do now); rest is feature parity + UX
source-audit: ../quorum-desktop\.agents\tasks\port-to-mobile\candidates.md (rows 31, 32, 33; "Channel & group icons" detailed entry + the mobile-settings-UX note)
depends-on:
  - ../quorum-desktop\.agents\tasks\quorum-shared-migration\2026-06-12-promote-icon-picker-vocabulary-to-shared.md (shared icon vocabulary — needed for 2/3 to reach full parity)
related:
  - quorum-shared-migration/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md (Phase 2b icon-vocabulary alignment)
---

# Channel & group icons + per-item settings drawer

User-reported + audit-confirmed cluster around channel/group icons and the cramped inline channel settings. Sub-tasks are ordered: **0 is a live bug (ship it standalone first)**; the rest is parity + a UX refactor that can land together.

---

## 0 — 🐛 BUG: channel-list icons always render the default (ship first, one line) — ✅ DONE

> **✅ FIXED + MERGED — PR #82 (squash `fb81ffe`) on master, 2026-06-13.** The channel row now reads `channel.icon` / `channel.iconColor` (falling back to hashtag + muted color). An icon set in channel settings ON MOBILE now appears in the channels list. Lint + type-check clean. Caveat below still stands: a desktop-set Tabler icon name may not resolve in the list until the vocabulary is unified (sub-task 2). Used `IconSymbol` (the app-wide pattern — 119 files; the shared `Icon` migration is the separate Phase 2 task, not started).

**Symptom (user, 2026-06-12):** a channel icon set in settings saves and shows in the settings modal, but the **channels list** always shows the default hashtag.

**Root cause (verified):** `app/(tabs)/spaces/[id]/index.tsx:118` hardcodes the icon:
```tsx
<IconSymbol name="number" size={18} color={theme.colors.textMuted} />
```
`channel` is in scope (the row uses `channel.channelId` / `channel.channelName`), but `channel.icon` / `channel.iconColor` are never read.

**Fix:**
```tsx
<IconSymbol
  name={(channel.icon || 'number') as IconSymbolName}
  size={18}
  color={channel.iconColor || theme.colors.textMuted}
/>
```
**Caveat:** this surfaces icons saved *on mobile*. A desktop-set icon name (Tabler, e.g. `hashtag`) may still not resolve until the icon vocabulary is unified (sub-task 2 / the shared promotion). That's fine — fix the bug now; cross-platform name resolution lands with parity. **Cost: trivial.** Runtime-test: set a channel icon+color in settings, confirm it now shows in the list.

---

## 1 — Per-item settings drawer for channels AND groups (the UX refactor)

> **📐 DESIGNED 2026-06-14 → [2026-06-14-channel-group-settings-drawer-design.md](2026-06-14-channel-group-settings-drawer-design.md)** (`status: design-review`). Interaction model locked: ONE owner-gated entry point (tap a channel/group row inside `SpaceSettingsModal`); the in-channel gear is left untouched and keeps its consistent "open space settings" meaning for everyone (the "gear → channel drawer" idea was rejected as a role-dependent behavior-switch trap). Group-aware single component; nested role-picker sheet for read-only managers; channel-row status glyphs (star=default, lock=read-only). **Blocked on the shared `2.1.0-30` publish for full icon parity** (the vocabulary is ready in local -30, just unpublished); everything else buildable now, plus one small `useUpdateSpace` extension for set-as-default. See the design doc for the full verified field/mutation map.

**Problem (user, 2026-06-12):** all channel/group settings are crammed into the inline channels list in `SpaceSettingsModal.tsx` — tight, and everything happens on cramped list rows.

**Proposal:** open a **per-item settings drawer/sheet** — tap a channel (or group) → a sheet with all its settings inside: icon picker, rename, read-only toggle (see the read-only task), delete, etc. Precedent already exists: `components/Chat/DMSettingsSheet.tsx` is a per-conversation settings sheet; reuse that pattern (and the shared `ActionSheet` / bottom-sheet infra in `components/shared/`).

This drawer becomes the natural home for several otherwise-cramped affordances: the icon picker (sub-tasks 2/3), the read-only SET toggle + manager-role picker (from the read-only enforcement task / port-to-mobile #27), group icon+color (sub-task 3), rename, delete.

**Gear-icon behavior (user, 2026-06-12):** when viewing a channel, the top-right gear (`app/(tabs)/spaces/[id]/[channelId].tsx:205-206`, currently `handleOpenSpaceSettings`) should open **that channel's settings drawer**, not the general space settings. The channel settings drawer then has a **"Space settings" button** to switch up to the general space settings (the current `SpaceSettingsModal`). So: gear in a channel → channel drawer → (button) → space settings.

**Scope note:** this is a UX design call as much as a build. Confirm the interaction model (does tapping a channel in the *settings* list open the drawer, or only the in-channel gear? probably both) before building. It's the larger piece of this task.

---

## 2 — Channel icon picker: reach full parity with desktop

Mobile HAS a channel icon picker (`components/ui/IconPicker.tsx`, wired in `SpaceSettingsModal.tsx` ~lines 1913-1924, 2570-2599) but it's under-featured vs desktop:

| | Desktop | Mobile today |
|---|---|---|
| Icon count | 49 curated Tabler icons (9 tiers) | 20 SF-Symbol names |
| Outline/filled variant | yes (`iconVariant`, 34 icons have filled) | **none** |
| Color storage | named enum (`'blue'`) | raw hex (`'#3b82f6'`) |

**Do:** consume the **shared icon-picker vocabulary** once it lands (see depends-on: the shared promotion task moves `ICON_OPTIONS` / `ICON_COLORS` / `FILLED_ICONS` + `getIconColorHex` into `@quilibrium/quorum-shared`). Then mobile's picker shows the same 49 icons, gains the outline/filled toggle, and stores **named colors** (resolving to hex via shared `getIconColorHex` at render). This also fixes the cross-platform color mismatch and makes desktop-set icons resolve on mobile (closes the caveat in sub-task 0). Aligns with the deferred Phase 2b in `2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md`.

**If the shared task isn't ready:** an interim mobile-only step is to widen mobile's local `ICON_OPTIONS` toward desktop's set and add a variant toggle — but prefer waiting for the shared vocabulary so the two don't diverge again.

---

## 3 — Group icon + color (entirely absent on mobile)

Desktop has a full group icon picker (`GroupEditorModal`). Mobile's group header row (`SpaceSettingsModal.tsx:1824-1879`) has **no icon affordance**. The `useUpdateGroup` mutation already **accepts** `icon`/`iconColor` (interface ~lines 389-394, honored in the mutation fn) — the UI just never calls that path.

**Do:** surface a group icon picker (ideally inside the per-item drawer from sub-task 1, reusing the same shared picker as sub-task 2) and wire it to `useUpdateGroup({ spaceId, groupIndex, icon, iconColor })`. Shared types (`Group.icon`/`iconColor`/`iconVariant`) already exist. Low cost once the picker + drawer exist.

---

## 4 — Drag-and-drop channel reordering (second pass, nice-to-have)

> **➡️ CARVED OUT 2026-06-14 → [2026-06-14-channel-drag-and-drop-reorder.md](2026-06-14-channel-drag-and-drop-reorder.md)** (`status: open`, low priority). Split into its own task because it's a distinct gesture-UI layer with its own failure modes (scroll conflict, a11y, library choice) — don't entangle it with the settings-drawer build. Do it AFTER the drawer ships so the row tap-target is settled. Mutations already exist.

Desktop reorders channels via drag-and-drop; mobile reorders via up/down arrows in settings (functional but clunkier). A DnD reorder on the mobile channels list would be a nicer parity step. **Lower priority — explicitly a second pass.** Watch the usual RN DnD gotchas (gesture conflict with scroll, accessibility). The reorder mutations already exist (`useReorderChannels` / `useMoveChannel`); this is purely a gesture-UI layer.

---

## Suggested sequencing

1. **Sub-task 0** (the bug) — standalone PR, trivial, ship immediately.
2. **Shared icon vocabulary** lands (separate quorum-shared + desktop PRs — see depends-on).
3. **Sub-tasks 1 + 2 + 3 together** — the per-item drawer is the container; build it, move the channel icon picker into it (now consuming shared vocabulary), add group icon there too, wire the gear→channel-drawer behavior.
4. **Sub-task 4** (DnD reorder) — later, on appetite.

## Verification

- [x] Sub-task 0: channel icon+color set in settings now appears in the channels list. tsc + lint clean. — PR #82 (`fb81ffe`), 2026-06-13.
- [ ] Channel/group icon picker shows the full shared icon set + outline/filled toggle + named colors; cross-platform: an icon set on desktop shows correctly on mobile and vice-versa.
- [ ] Group icon+color settable on mobile and persists/syncs.
- [ ] Gear in a channel opens the channel settings drawer; drawer has a working "Space settings" switch.
- [ ] (if done) DnD channel reorder works and doesn't fight list scroll.

*Last updated: 2026-06-13*
