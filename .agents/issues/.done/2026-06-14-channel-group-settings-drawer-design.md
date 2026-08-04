---
type: task
title: "Per-item settings drawer for channels & groups (mobile) — design"
status: done
created: 2026-06-14
runtime-test: required
blocked-on: "Full icon parity waits on shared 2.1.0-30 publish (icon-picker vocabulary). Everything else is buildable now. See 'Dependencies'."
parent: .agents/issues/.done/2026-06-12-channel-group-icon-and-settings.md (this is the design for sub-task 1)
precedent: components/Chat/DMSettingsSheet.tsx
---

# Per-item settings drawer for channels & groups — design

> **Next step when resumed:** run the `writing-plans` skill to turn this design into an
> implementation plan — but **only after the shared `2.1.0-30` publish + mobile bump** (so the
> icon-picker import surface is known and the drawer is built once with full parity). Decision
> 2026-06-14: do not plan/build piecemeal while waiting. The `-30` publish also unblocks
> `primaryUsername` end-to-end + DM update-profile, so watch for it. (The `-30`-independent slice
> — status glyphs, `useUpdateSpace` extension, drawer shell — *could* be pulled forward if that
> decision changes.)

## What this is

A per-item **settings drawer** (bottom sheet) for channels and channel groups in a space.
Today, channel/group editing is crammed into inline rows in the 3457-line
[SpaceSettingsModal.tsx](../../components/SpaceSettingsModal.tsx) (rename via `editingChannelId`
state, icon via a toggled modal, delete via `Alert.alert`). This task moves all of it into one
focused, group-aware drawer component, and adds a few missing affordances (read-only config,
set-as-default, group icons) plus scannable status glyphs on the channel rows.

This is the design for **sub-task 1** of the parent task. Sub-tasks 0 (icon-list bug) shipped
already (PR #82). Sub-task 4 (drag-and-drop reorder) is **carved out into its own task** —
see "Out of scope".

## Decided interaction model (the point of this brainstorm)

### Entry point — ONE door, owner-gated
- The drawer opens **only** by tapping a channel row (or group header row) **inside
  `SpaceSettingsModal`**. Owner-gated there; `SpaceSettingsModal` already renders a
  separate non-owner view (members/account), so non-owners simply never see an editable
  channel list and the drawer is unreachable for them — **no disabled states to build.**
- **The in-channel gear is NOT touched.** It keeps its single, consistent meaning for
  everyone: open `SpaceSettingsModal` (owners → management tabs; non-owners → members/account).

### Why not the in-channel gear (rejected, and why)
The gear at [`[channelId].tsx:218`](../../app/(tabs)/spaces/[id]/[channelId].tsx#L218) is rendered
**unconditionally** (outside the `isSpaceOwner` guard that wraps the invite button at :213), so
**all members see it**. The original task floated "gear → channel drawer". Rejected because:
- Branching the gear by role (owner → channel drawer, non-owner → space settings) makes **one
  control mean two different things based on a role the user can change**. An owner learns "gear =
  channel settings"; the same gear means "space settings" for everyone else — a learned-behavior
  trap. The user explicitly rejected this.
- Resolution (user's call): **keep the gear consistent for everyone**; channel editing lives in
  exactly one owner-gated place (the `SpaceSettingsModal` list). Trade-off accepted: editing a
  channel is a slightly longer path (gear → space settings → tap channel → drawer), fine for an
  occasional admin action.

### Flow
```
[any member] tap gear → [SpaceSettingsModal]
                            │  (owner only) tap a channel / group row
                            ▼
                      [Channel/Group settings drawer]
                            │  Close → back to SpaceSettingsModal
```
No "Space settings →" escalation row is needed (you're already in space settings).

## Component architecture

New component `components/Chat/ChannelSettingsSheet.tsx` (name TBD), **group-aware** via a
discriminated target prop:

```ts
type ChannelSettingsTarget =
  | { kind: 'channel'; spaceId: string; groupIndex: number; channelId: string }
  | { kind: 'group';   spaceId: string; groupIndex: number };
```

- **Bottom sheet**, not the centered modal `DMSettingsSheet` uses — it must host **nested
  sheets layered on top** (icon picker, manager-role picker). Build on the shared sheet infra in
  [components/shared/](../../components/shared/) (`BaseModal`/`ActionSheet`) rather than
  hand-rolling the overlay like `DMSettingsSheet` does.
- **One component, conditional rows** keyed on `kind` (DRY): channel shows the full row set;
  group shows rename/icon/delete only.
- Editing state currently scattered in `SpaceSettingsModal` (`editingChannelId`,
  `iconPickerVisible`, `editingChannelName`, etc.) **moves into** this component, shrinking that
  file. Existing mutations are reused unchanged: `useUpdateChannel`, `useDeleteChannel`,
  `useUpdateGroup`, `useUpdateSpace` (see the one extension below).
- Drawer `visible` + `target` state lives **inside `SpaceSettingsModal`** (a local
  `drawerTarget`) — the migration is self-contained to that one file + the new component.

## Drawer contents

### Channel drawer rows (top → bottom)
| Row | Field | Mutation status |
|---|---|---|
| **Rename** | `channel.channelName` | ✅ `useUpdateChannel` |
| **Icon + color** | `channel.icon` / `iconColor` / `iconVariant` | ✅ mutation accepts; **picker blocked on -30** |
| **Read-only** (toggle) | `channel.isReadOnly` | ✅ `useUpdateChannel` |
| **→ Managers** (only when read-only ON) | `channel.managerRoleIds[]` | ✅ `useUpdateChannel`; reads `space.roles` |
| **Set as default channel** (toggle) | `space.defaultChannelId` | ⚠️ needs `useUpdateSpace` extended (see Dependencies) |
| **Allow threads** | `channel.allowThreads` | placeholder — disabled "Coming soon" (feature unsupported on mobile) |
| **Delete channel** | — | ✅ `useDeleteChannel`; single-confirm dialog per the destructive-ops standard |

### Group drawer rows
Rename (`group.groupName`) · Icon + color (`useUpdateGroup` already accepts `icon`/`iconColor` —
currently unwired on mobile; this closes parent sub-task 3) · Delete.

### The read-only → managers flow
Toggling **read-only ON** does **not** immediately open a picker. It reveals a **"Managers"**
row showing the current selection (e.g. "Admins, Moderators"). Tapping that row opens a **nested
role-picker sheet on top of the drawer** — a multi-select checklist of `space.roles`. Keeps the
toggle action cheap and lets the user revisit the selection without toggling off/on. Writes
`managerRoleIds` via `useUpdateChannel`. (Chosen over an inline expanding section so the main
drawer stays compact and the role list can be long.)

### Confirmations
Delete (channel and group) uses a **single-confirm dialog**, aligning with
[2026-06-13-destructive-operations-confirmation-standard.md](2026-06-13-destructive-operations-confirmation-standard.md)
(T2) — explicitly NOT double-tap.

## Channel-row status glyphs (scannable state)

On each **channel list row** (both the in-space list at
[`[id]/index.tsx`](../../app/(tabs)/spaces/[id]/index.tsx) and the list inside
`SpaceSettingsModal`), show small muted glyphs so state is scannable without opening the drawer:

| State | Glyph | Condition |
|---|---|---|
| Default channel | star (`star.fill`) | `channel.channelId === space.defaultChannelId` |
| Read-only | lock (`lock.fill`) | `channel.isReadOnly === true` |

- `textMuted` color, ~13–14px, trailing the channel name. No background, no label — deliberately
  subtle. Both can show at once (default + read-only) → render side by side.
- Uses the existing `IconSymbol` (app-wide pattern) → **no shared dependency**; these glyphs can
  ship **independently of the -30 block**, even before the drawer (they only *read* the fields).
- Placement must not collide with the row's existing trailing affordances (unread badge / time) —
  finalize against the current row layout at build time.

## Dependencies

1. **Full icon parity → blocked on shared `2.1.0-30` publish.** Verified 2026-06-14: the
   icon-picker vocabulary (`ICON_OPTIONS` 49 icons, `ICON_COLORS` named enum, `FILLED_ICONS`,
   `getIconColorHex`) is **NOT** in the published `2.1.0-29` dist (exact-word grep = 0 in
   `dist/index.native.js`), but **IS** present, exported, and already built in the **local
   `2.1.0-30`** source (`src/primitives/Icon/pickerVocabulary.ts` → re-exported via
   `src/primitives/index.ts`; present in local `dist/index.native.js`). So full parity is purely
   a **publish + mobile-bump** away — no further shared *work*. The `-30` publish is the same
   bottleneck already gating `primaryUsername` end-to-end + DM update-profile (Cassie / npm
   access; no auto-publish CI). **Decision (user): wait for the -30 publish, then build the
   drawer once with full icon parity** — no interim under-featured picker, no swap step.
2. **`useUpdateSpace` does not currently accept `defaultChannelId`.** Verified 2026-06-14: the
   merge in [useSpaceSettings.ts](../../hooks/chat/useSpaceSettings.ts) (~lines 24-36) omits
   `defaultChannelId`, so the "Set as default" toggle needs a small extension — add
   `defaultChannelId?` to `UpdateSpaceParams` and to the merged `Space`. Contained, no shared
   dependency, buildable now.
3. **Read-only enforcement already exists** ([SpaceChatArea.tsx:730](../../components/Chat/SpaceChatArea.tsx#L730)
   renders a read-only banner) — this task adds the *configuration* UI, not the enforcement.
   Confirm the manager-role *write* path matches how enforcement *reads* `managerRoleIds` before
   relying on it. The space-owner permission model has a known nuance (see memory
   `space-owner-only-kick-no-implicit-permissions`); mirror the gate the existing channel
   mutations already enforce — do NOT widen permissions in this task.

## Out of scope (carved out)

- **Drag-and-drop channel reorder** → its own task,
  `2026-06-14-channel-drag-and-drop-reorder.md` (parent sub-task 4). It touches the same channel
  rows as this drawer (drag handle vs tap-to-open), so the DnD task must ensure its gesture
  doesn't fight the row's tap target. Existing up/down-arrow reorder stays until then.
- **"Allow threads" functionality** — threads are unsupported on mobile; this task only reserves
  a disabled placeholder row.
- **The full icon-picker UI parity** — its *vocabulary* dependency is documented above; the
  drawer's icon row is the seam where it lands once -30 publishes.

## Verification (when built)

Static:
- [ ] `npx tsc --noEmit` clean.
- [ ] `yarn lint` clean.
- [ ] No remaining inline channel/group editing state in `SpaceSettingsModal` (moved into the sheet).

Runtime (required — UI + real data writes):
- [ ] Owner: tap a channel row in `SpaceSettingsModal` → drawer opens with that channel's settings.
- [ ] Rename / icon / read-only / set-default / delete each persist and sync (check a second client).
- [ ] Read-only ON → "Managers" row appears → nested role picker writes `managerRoleIds`; the
      read-only banner enforces it in the channel.
- [ ] Set-as-default moves the star; only one channel is default per space.
- [ ] Group drawer: rename / icon / delete persist.
- [ ] Status glyphs: star on the default channel, lock on read-only channels, both when both — in
      both channel lists.
- [ ] Non-owner: gear opens space settings (members/account view); no editable channel list, drawer
      unreachable. Gear behaves identically for owner and non-owner (always space settings).

---
*Last updated: 2026-06-14*
