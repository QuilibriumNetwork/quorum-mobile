---
type: task
title: "Channel & Group Settings Drawer (mobile) — implementation plan"
status: done
created: 2026-06-17
runtime-test: required (user tests on device before ship)
design: .agents/issues/.done/2026-06-14-channel-group-settings-drawer-design.md
parent: .agents/issues/.done/2026-06-12-channel-group-icon-and-settings.md (sub-task 1)
precedent: components/Chat/DMSettingsSheet.tsx
shared: "@quilibrium/quorum-shared@2.1.0-31 (installed; icon-picker vocabulary verified present)"
---

# Channel & Group Settings Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped inline channel/group editing in the 3457-line (now ~2721-line) `SpaceSettingsModal` with one focused, group-aware bottom-sheet drawer, add the missing affordances (read-only managers, set-as-default, group icons), upgrade the icon picker to the shared cross-platform vocabulary, and add scannable status glyphs (star = default, lock = read-only) to both channel lists.

**Architecture:** A new `ChannelSettingsSheet` bottom-sheet component (built on the shared `BaseModal`/`ActionRow` infra, the same primitives `DMSettingsSheet` uses) opens from a tap on a channel/group row inside the owner-only Channels tab of `SpaceSettingsModal`. It is driven by a discriminated `target` prop (`channel` | `group`). The icon picker is rebuilt on the shared `ICON_OPTIONS` / `ICON_COLORS` / `FILLED_ICONS` / `getIconColorHex` vocabulary (stores a named color token + an `iconVariant`, not raw hex). Nested sheets (icon picker, role picker) layer on top via native RN `Modal` stacking. Existing mutations are reused; two small additive hook extensions are needed (`useUpdateSpace` gains `defaultChannelId`, `useUpdateChannel`/`useUpdateGroup` gain `iconVariant`). `IconSymbol` gains an additive optional `variant` prop so a stored `iconVariant` renders correctly — this is NOT the rejected app-wide icon migration (see Task 1 note).

**Tech Stack:** React Native + Expo (flat Expo Router structure, no `src/`), TypeScript, `@tanstack/react-query` mutations, `@quilibrium/quorum-shared@2.1.0-31`, the mobile skin/theme system (`useTheme`, `Skin.space/font/radius/border`), shared sheet primitives (`BaseModal`, `ActionRow`, `ActionRowGroup`, `useConfirmDialog`).

---

## Scope decisions (locked with the user, 2026-06-17)

1. **Icon picker → upgrade to the shared vocabulary.** Store a named color token (`'blue'`, `'green'`, …) + `iconVariant: 'outline'|'filled'`, resolve to hex at render via `getIconColorHex`. Fixes cross-platform icon render as a side effect.
2. **Colors shown in the picker = a single config constant** (`PICKER_COLORS`) so the count is trivially tunable. Start with **all 12** `ICON_COLORS` laid out in a wrapping row; the user will eyeball on device and may trim to ~7. The layout must not break at any count.
3. **Omit the "Allow threads" row entirely** (no disabled placeholder).
4. **User tests on device.** Each phase is statically verified (`tsc`, `lint`, grep); a runtime test script (Task 12) is handed to the user; nothing merges until the user confirms.

## What this plan does NOT touch (guardrails)

- **Drag-and-drop reorder** — separate task `2026-06-14-channel-drag-and-drop-reorder.md`. The existing up/down-arrow reorder stays. Do not remove it.
- **The in-channel gear** at `app/(tabs)/spaces/[id]/[channelId].tsx:218` — left exactly as-is (always opens `SpaceSettingsModal`).
- **The app-wide IconSymbol → shared Icon migration** (the ~121-file sweep in `2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md`) — REJECTED, do not start. The `variant` prop added in Task 1 is a one-field additive extension to the existing shim, not that migration.
- **Non-owner view** — non-owners only see Account + Members tabs; they never reach the channel list, so the drawer needs **no disabled/permission states**.

---

## File Structure

**New files:**
- `components/Chat/ChannelSettingsSheet.tsx` — the drawer. Group-aware via `target` prop. Owns all editing state that currently lives in `SpaceSettingsModal`. Renders nested icon-picker + role-picker sheets.
- `components/Chat/ChannelManagerRolePickerSheet.tsx` — nested multi-select role checklist for read-only managers (writes `managerRoleIds`).
- `components/ui/ChannelIconPickerSheet.tsx` — the rebuilt icon picker on the shared vocabulary (named color token + variant). New file so the old `IconPicker.tsx` stays untouched until cutover (deleted in Task 11).
- `components/Chat/ChannelStatusGlyphs.tsx` — small reusable row of muted star/lock glyphs, used in both channel lists.

**Modified files:**
- `components/ui/IconSymbol.tsx` — add optional `variant?: 'outline'|'filled'` prop (additive).
- `hooks/chat/useSpaceSettings.ts` — `UpdateSpaceParams` + merge gain `defaultChannelId`.
- `hooks/chat/useChannelManagement.ts` — `UpdateChannelParams` + merge gain `iconVariant`; `UpdateGroupParams` + merge gain `iconVariant`.
- `components/SpaceSettingsModal.tsx` — remove the inline channel/group editing (state vars, handlers, JSX); make channel/group rows open the drawer; mount the drawer + glyphs; delete the old `<IconPicker>` block.
- `app/(tabs)/spaces/[id]/index.tsx` — add status glyphs to the in-space channel rows; route icon color through `getIconColorHex`.

---

## Verified facts this plan relies on (do not re-derive)

- **Shared `-31` is installed and has the picker vocabulary.** `@quilibrium/quorum-shared@2.1.0-31` in both `package.json` and `node_modules`. `ICON_OPTIONS` (87 icons / 12 tiers), `ICON_COLORS` (12 tokens: default, blue, purple, fuchsia, green, orange, yellow, red, teal, sky, indigo, pink), `FILLED_ICONS` (Set), `getIconColorHex`, and types `IconColor`/`IconOption`/`ColorOption` are all re-exported from the **package root** via `export * from './primitives'` (`dist/index.d.ts:17`). Import them from `'@quilibrium/quorum-shared'` directly (NOT a subpath — there is no `./primitives` export entry).
- **`ICON_OPTIONS` names are kebab-case semantic Tabler names** (`'hashtag'`, `'home'`, `'users'`, `'mood-happy'`, `'lock'`, …). Mobile's `IconSymbol` resolver already handles these via its path-2 PascalCase lookup (`IconSymbol.tsx:344-349`). The new channel-icon default should be `'hashtag'` (Tabler), replacing the old `'number'`.
- **`useUpdateChannel`** (`hooks/chat/useChannelManagement.ts:140-214`) already accepts `channelName`, `channelTopic`, `isReadOnly`, `managerRoleIds`, `icon`, `iconColor`. It does NOT accept `iconVariant` (this plan adds it). Merge block at lines 170-178. It broadcasts via `enqueueOutbound` + `broadcastSpaceUpdate`.
- **`useUpdateGroup`** (`useChannelManagement.ts:378-433`) accepts `groupName`, `icon`, `iconColor`; identifies the group by **`groupIndex`** (array index), not name. Does NOT accept `iconVariant` (this plan adds it). Merge at lines 405-410.
- **`useDeleteChannel`** (`:216-...`) — `{ spaceId, channelId }`; throws if `channelId === space.defaultChannelId`. **`useDeleteGroup`** — `{ spaceId, groupIndex }`; throws if the group contains the default channel.
- **`useUpdateSpace`** (`hooks/chat/useSpaceSettings.ts:49-96`) — `UpdateSpaceParams` (lines 25-37) does NOT accept `defaultChannelId`; merge (63-76) omits it. This plan adds it.
- **Read-only enforcement reads `managerRoleIds`** via shared `canManageReadOnlyChannel(userAddress, false, space, channel)` — returns true iff a role in `channel.managerRoleIds` has the user as a member (no owner bypass). The WRITE path stores `roleId` values, which is exactly what this matches. Used at `[channelId].tsx:109-113`, banner at `SpaceChatArea.tsx:713`, receive-gate at `WebSocketContext.tsx:2124` / `:3362`. **Do not widen permissions.**
- **Roles:** `Role = { roleId, displayName, roleTag, color, members, permissions, isPublic? }`. Source via `useRoles(spaceId)` (`hooks/chat/useRoleManagement.ts:52-65`) — returns `Role[]` with `color` already resolved to a render-safe hex. The picker stores `role.roleId` strings.
- **Sheet infra:** `BaseModal` (RN `Modal`, `transparent`, slide-up, owns backdrop + swipe-dismiss; props `visible/onClose/children/height?/showHandle?/avoidKeyboard?`). Nesting works by rendering another `BaseModal`/`CenterModal` inside children — each is its own native modal layer (no Portal). `ActionRow` props: `label, icon?, onPress?, destructive?, disabled?, sublabel?, trailing? ('chevron' | ReactNode), active?, leading?`. `ActionRowGroup` wraps rows in a `surface2` card and auto-drops the last divider. `useConfirmDialog()` → `{ confirm, confirmDialog }`; `confirm(opts): Promise<boolean>`. All exported from `@/components/shared`.
- **The confirm/back-guard pattern** (from `DMSettingsSheet.tsx:43-50`): a sheet hosting a confirm dialog (or a nested sheet) keeps an `isConfirming` flag and passes a `guardedClose` that no-ops while a child is open, so Android back dismisses the child, not the sheet. Render `{confirmDialog}` inside the sheet's `BaseModal`.
- **Channel row layouts:**
  - `SpaceSettingsModal` Channels tab: `renderChannelsTab` at `:1896-2104`; group header `:1924-1977`; channel rows `:2009-2086`.
  - In-space list: `app/(tabs)/spaces/[id]/index.tsx:122-153`; row order is `[icon][name(flex)][unread badge?][chevron]`. Glyphs go between name and unread badge. The icon color is currently `channel.iconColor || theme.colors.textMuted` (raw) — must become `getIconColorHex(channel.iconColor) ` once colors are named tokens.
- **Inline editing state to remove from `SpaceSettingsModal`** (declarations `:870-879`): `editingChannelId`, `editingChannelName`, `editingGroupIndex`, `editingGroupName`, `iconPickerVisible`, `iconPickerChannelId`. (`newChannelGroupIndex`/`newChannelName` drive **add-channel**, which stays in the modal — do not remove those.) Handlers to remove/relocate: `handleSaveChannelName` (`:1284`), `handleDeleteChannel` (`:1304`), `handleSaveGroupName` (`:1220`), `handleDeleteGroup` (`:1240`). The old `<IconPicker>` render block is `:2668-2697`.

---

## Verification commands (used throughout)

- Type check: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
  - **Baseline matters:** master has pre-existing errors (~107 historically). Before starting, capture the baseline count and compare — the bar is "no NEW errors", not "zero errors".
- Lint: `yarn lint`
- Grep for removed symbols: `npx -y rg "<symbol>" components/ app/`

> **No automated UI test framework runs in this repo** (mobile isn't run in normal sessions). "Tests" here are: (a) static checks above, (b) the per-task grep/compile assertions, (c) the device test script in Task 12 that the user runs. Where a step says "verify", it means run the stated static check and confirm the stated expected output.

---

## Task 0: Baseline capture

**Files:** none (measurement only)

- [ ] **Step 1: Record the tsc baseline**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: a number N (e.g. 107). Write it at the top of your working notes. Every later "tsc clean" step means "still N, no new errors".

- [ ] **Step 2: Record the lint baseline**

Run: `yarn lint`
Expected: note any pre-existing warnings/errors so new ones are distinguishable.

- [ ] **Step 3: Create the working branch**

```bash
git checkout -b feat/channel-group-settings-drawer
```

---

## Task 1: Add an additive `variant` prop to `IconSymbol`

The shared vocabulary stores filled-ness as a separate `iconVariant` field; the current shim only infers "filled" from a `.fill` suffix. Add an optional `variant` so a stored `iconVariant: 'filled'` renders the `*Filled` Tabler component. Fully backward compatible: no existing call site passes `variant`, so behaviour is unchanged for all 121 call sites.

**Files:**
- Modify: `components/ui/IconSymbol.tsx` (signature ~`:363-374`, resolve call ~`:393-395`)

- [ ] **Step 1: Extend the component signature and filled-resolution**

In `IconSymbol.tsx`, change the props destructure (currently around lines 363-374) to accept `variant`, and compute `wantFilled` from either the `.fill` suffix OR an explicit `variant === 'filled'`:

```tsx
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  variant,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
  variant?: 'outline' | 'filled';
}) {
  // ...existing skin-icon override block stays unchanged...

  const nameStr = String(name);
  const wantFilled = variant === 'filled' || nameStr.endsWith('.fill');
  const Component = resolveTablerComponent(nameStr, wantFilled);
  // ...rest unchanged...
}
```

> Note: when `variant === 'outline'` is passed explicitly for a name that has no `.fill` suffix, `wantFilled` is false — correct. The skin-icon override block above this stays exactly as-is.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: equal to the Task 0 baseline N (no new errors).

- [ ] **Step 3: Commit**

```bash
git add components/ui/IconSymbol.tsx
git commit -m "feat(icons): add additive variant prop to IconSymbol shim"
```

---

## Task 2: Extend mutation hooks (`defaultChannelId`, `iconVariant`)

Three additive params so the drawer can write set-as-default and icon variants. All additive — existing callers unaffected.

**Files:**
- Modify: `hooks/chat/useSpaceSettings.ts` (`UpdateSpaceParams` `:25-37`, merge `:63-76`)
- Modify: `hooks/chat/useChannelManagement.ts` (`UpdateChannelParams` `:140-149`, merge `:170-178`; `UpdateGroupParams` `:378-384`, merge `:405-410`)

- [ ] **Step 1: Add `defaultChannelId` to `useUpdateSpace`**

In `useSpaceSettings.ts`, add to `UpdateSpaceParams` (after `stickers?`):

```ts
  stickers?: Space['stickers'];
  defaultChannelId?: string;
```

And in the `updatedSpace` merge object (after the `stickers:` line, before `modifiedDate:`):

```ts
    stickers: params.stickers ?? space.stickers,
    defaultChannelId: params.defaultChannelId ?? space.defaultChannelId,
    modifiedDate: timestamp,
```

- [ ] **Step 2: Add `iconVariant` to `useUpdateChannel`**

In `useChannelManagement.ts`, add to `UpdateChannelParams` (after `iconColor?`):

```ts
  iconColor?: string;
  iconVariant?: 'outline' | 'filled';
```

And in the `foundChannel` merge (after the `iconColor:` line, before `modifiedDate:`):

```ts
              iconColor: params.iconColor ?? channel.iconColor,
              iconVariant: params.iconVariant ?? channel.iconVariant,
              modifiedDate: Date.now(),
```

- [ ] **Step 3: Add `iconVariant` to `useUpdateGroup`**

In `useChannelManagement.ts`, add to `UpdateGroupParams` (after `iconColor?`):

```ts
  iconColor?: string;
  iconVariant?: 'outline' | 'filled';
```

And in the `updatedGroup` merge (after `iconColor:`):

```ts
        iconColor: params.iconColor ?? group.iconColor,
        iconVariant: params.iconVariant ?? group.iconVariant,
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N (no new errors — `Channel.iconVariant` and `Group.iconVariant` already exist on the shared types; `Space.defaultChannelId` already exists).

- [ ] **Step 5: Commit**

```bash
git add hooks/chat/useSpaceSettings.ts hooks/chat/useChannelManagement.ts
git commit -m "feat(spaces): accept defaultChannelId and iconVariant in update hooks"
```

---

## Task 3: Build the shared-vocabulary icon picker (`ChannelIconPickerSheet`)

New picker on the shared vocabulary. Emits `(name: IconName, color: IconColor, variant: 'outline'|'filled')`. Built on `BaseModal`. The old `IconPicker.tsx` is left alone (deleted in Task 11).

**Files:**
- Create: `components/ui/ChannelIconPickerSheet.tsx`

- [ ] **Step 1: Write the picker component**

Create `components/ui/ChannelIconPickerSheet.tsx`:

```tsx
/**
 * ChannelIconPickerSheet — channel/group icon picker on the SHARED vocabulary.
 *
 * Stores a named color TOKEN (e.g. 'blue') + an iconVariant, NOT raw hex, so
 * icons render consistently across mobile and desktop. Resolve to hex at render
 * via getIconColorHex(). Replaces the legacy components/ui/IconPicker.tsx (which
 * used SF-Symbol names + raw-hex colors and didn't render cross-platform).
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ICON_OPTIONS,
  ICON_COLORS,
  FILLED_ICONS,
  getIconColorHex,
  type IconColor,
} from '@quilibrium/quorum-shared';
import { BaseModal } from '@/components/shared';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

// Single source of truth for which color swatches the picker offers. Trim or
// reorder this freely (the layout wraps to any count). Currently: all 12 tokens.
const PICKER_COLORS: IconColor[] = ICON_COLORS.map((c) => c.value);

const DEFAULT_ICON: IconSymbolName = 'hashtag' as IconSymbolName;

interface ChannelIconPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedIcon?: string;
  selectedColor?: IconColor;
  selectedVariant?: 'outline' | 'filled';
  onSelect: (icon: string, color: IconColor, variant: 'outline' | 'filled') => void;
  onClear: () => void;
}

export function ChannelIconPickerSheet({
  visible,
  onClose,
  selectedIcon,
  selectedColor,
  selectedVariant,
  onSelect,
  onClear,
}: ChannelIconPickerSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [pickedIcon, setPickedIcon] = useState<string>(selectedIcon || (DEFAULT_ICON as string));
  const [pickedColor, setPickedColor] = useState<IconColor>(selectedColor || 'default');
  const [pickedVariant, setPickedVariant] = useState<'outline' | 'filled'>(
    selectedVariant || 'outline'
  );

  const hasFilled = FILLED_ICONS.has(pickedIcon as never);
  const effectiveVariant = hasFilled ? pickedVariant : 'outline';
  const previewHex = getIconColorHex(pickedColor);

  const handleConfirm = () => {
    onSelect(pickedIcon, pickedColor, effectiveVariant);
    onClose();
  };

  const handleClear = () => {
    onClear();
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} showHandle>
      <View style={styles.container}>
        <Text style={styles.title}>Icon</Text>

        {/* Preview */}
        <View style={styles.previewContainer}>
          <View style={[styles.previewCircle, { backgroundColor: previewHex + '20' }]}>
            <IconSymbol
              name={pickedIcon as IconSymbolName}
              size={28}
              color={previewHex}
              variant={effectiveVariant}
            />
          </View>
        </View>

        {/* Variant toggle — only when the picked icon has a filled form */}
        {hasFilled && (
          <View style={styles.variantRow}>
            {(['outline', 'filled'] as const).map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.variantChip, pickedVariant === v && styles.variantChipActive]}
                onPress={() => setPickedVariant(v)}
              >
                <Text
                  style={[
                    styles.variantChipText,
                    pickedVariant === v && styles.variantChipTextActive,
                  ]}
                >
                  {v === 'outline' ? 'Outline' : 'Filled'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Icon grid */}
        <Text style={styles.sectionLabel}>Icon</Text>
        <ScrollView style={styles.iconGrid} showsVerticalScrollIndicator={false}>
          <View style={styles.gridRow}>
            {ICON_OPTIONS.map((opt) => {
              const active = pickedIcon === opt.name;
              return (
                <TouchableOpacity
                  key={opt.name}
                  style={[
                    styles.iconCell,
                    active && { backgroundColor: previewHex + '20', borderColor: previewHex },
                  ]}
                  onPress={() => setPickedIcon(opt.name)}
                  accessibilityLabel={opt.category}
                >
                  <IconSymbol
                    name={opt.name as IconSymbolName}
                    size={20}
                    color={active ? previewHex : theme.colors.textMuted}
                    variant={
                      active && FILLED_ICONS.has(opt.name as never) ? pickedVariant : 'outline'
                    }
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {/* Color row (wraps to any count) */}
        <Text style={styles.sectionLabel}>Color</Text>
        <View style={styles.colorRow}>
          {PICKER_COLORS.map((token) => {
            const hex = getIconColorHex(token);
            return (
              <TouchableOpacity
                key={token}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: hex },
                  pickedColor === token && styles.colorSwatchActive,
                ]}
                onPress={() => setPickedColor(token)}
                accessibilityLabel={token}
              />
            );
          })}
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.clearButton} onPress={handleClear}>
            <Text style={styles.clearButtonText}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmButton, { backgroundColor: previewHex }]}
            onPress={handleConfirm}
          >
            <Text style={styles.confirmButtonText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(20), paddingTop: Skin.space(8), flex: 1 },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(12),
    },
    previewContainer: { alignItems: 'center', marginBottom: Skin.space(12) },
    previewCircle: {
      width: 56,
      height: 56,
      borderRadius: Skin.radius(28),
      alignItems: 'center',
      justifyContent: 'center',
    },
    variantRow: {
      flexDirection: 'row',
      gap: Skin.space(8),
      justifyContent: 'center',
      marginBottom: Skin.space(14),
    },
    variantChip: {
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface3,
    },
    variantChipActive: { backgroundColor: theme.colors.primary },
    variantChipText: { ...theme.textStyles.footnote, color: theme.colors.textMuted },
    variantChipTextActive: { color: '#fff' },
    sectionLabel: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      letterSpacing: 0.5,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
    },
    iconGrid: { maxHeight: 200, marginBottom: Skin.space(16) },
    gridRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Skin.space(8) },
    iconCell: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Skin.space(10), marginBottom: Skin.space(20) },
    colorSwatch: { width: 32, height: 32, borderRadius: Skin.radius(16) },
    colorSwatchActive: {
      borderWidth: Skin.border(3),
      borderColor: '#fff',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3,
      elevation: 4,
    },
    actions: { flexDirection: 'row', gap: Skin.space(12), paddingBottom: Skin.space(8) },
    clearButton: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
    },
    clearButtonText: { ...theme.textStyles.body, color: theme.colors.textMain },
    confirmButton: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      alignItems: 'center',
    },
    confirmButtonText: { ...theme.textStyles.body, color: '#fff' },
  });
```

> **Token names are verified present:** `theme.textStyles` has `headline`, `body`, `callout`, `subheadline`, `footnote` (`theme/fonts.ts:107-115`) — used the same way in `components/shared/ActionSheet.tsx:159,173`. There is **no `title` token** — do not use one (this plan doesn't). `theme.colors.textStrong`/`textMuted`/`textMain`/`surface2`/`surface3`/`surface5`/`primary` are all valid (used across the shared sheets).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N. If `theme.textStyles.*` errors appear, apply the fallback note above and re-run.

- [ ] **Step 3: Commit**

```bash
git add components/ui/ChannelIconPickerSheet.tsx
git commit -m "feat(icons): channel icon picker on shared vocabulary (named color + variant)"
```

---

## Task 4: Build the manager-role picker (`ChannelManagerRolePickerSheet`)

Nested multi-select checklist of `space.roles`. Reveals when read-only is ON. Stores `roleId[]`.

**Files:**
- Create: `components/Chat/ChannelManagerRolePickerSheet.tsx`

- [ ] **Step 1: Write the role-picker sheet**

Create `components/Chat/ChannelManagerRolePickerSheet.tsx`:

```tsx
/**
 * ChannelManagerRolePickerSheet — multi-select roles that may manage/post in a
 * read-only channel. Writes channel.managerRoleIds (roleId values). Mirrors how
 * the shared canManageReadOnlyChannel enforcement READS managerRoleIds: a user
 * may post iff one of these roles lists them as a member. Do NOT widen this.
 */
import React, { useState, useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Role } from '@quilibrium/quorum-shared';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ChannelManagerRolePickerSheetProps {
  visible: boolean;
  onClose: () => void;
  roles: Role[];
  selectedRoleIds: string[];
  onConfirm: (roleIds: string[]) => void;
}

export function ChannelManagerRolePickerSheet({
  visible,
  onClose,
  roles,
  selectedRoleIds,
  onConfirm,
}: ChannelManagerRolePickerSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [picked, setPicked] = useState<Set<string>>(new Set(selectedRoleIds));

  // Re-sync when reopened with a different selection.
  useEffect(() => {
    if (visible) setPicked(new Set(selectedRoleIds));
  }, [visible, selectedRoleIds]);

  const toggle = (roleId: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const handleDone = () => {
    onConfirm(Array.from(picked));
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.6} showHandle>
      <View style={styles.container}>
        <Text style={styles.title}>Channel Managers</Text>
        <Text style={styles.subtitle}>Roles that can post in this read-only channel</Text>

        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          <ActionRowGroup>
            {roles.length === 0 ? (
              <ActionRow label="No roles in this space yet" disabled />
            ) : (
              roles.map((role) => (
                <ActionRow
                  key={role.roleId}
                  label={role.displayName}
                  leading={<View style={[styles.dot, { backgroundColor: role.color }]} />}
                  trailing={picked.has(role.roleId) ? 'chevron' : undefined}
                  active={picked.has(role.roleId)}
                  onPress={() => toggle(role.roleId)}
                />
              ))
            )}
          </ActionRowGroup>
        </ScrollView>

        <TouchableOpacity style={styles.doneButton} onPress={handleDone}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(16), paddingTop: Skin.space(8), flex: 1 },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(4),
    },
    subtitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: Skin.space(14),
    },
    list: { flex: 1, marginBottom: Skin.space(12) },
    dot: { width: 12, height: 12, borderRadius: Skin.radius(6) },
    doneButton: {
      paddingVertical: Skin.space(14),
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.primary,
      alignItems: 'center',
      marginBottom: Skin.space(8),
    },
    doneText: { ...theme.textStyles.body, color: '#fff' },
  });
```

> The `active` + chevron combination is the codebase's "selected" affordance (`ActionRow.active` gives a success tint). If you prefer a clearer checkbox, swap `trailing` for an `IconSymbol name={picked ? 'checkmark.circle.fill' : 'circle'}`. Keep it consistent with how multi-select appears elsewhere (grep `ActionRow` usages first).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.

- [ ] **Step 3: Commit**

```bash
git add components/Chat/ChannelManagerRolePickerSheet.tsx
git commit -m "feat(channels): manager-role picker sheet for read-only channels"
```

---

## Task 5: Build the status-glyphs component (`ChannelStatusGlyphs`)

Reusable muted star (default) / lock (read-only) glyphs for both channel lists.

**Files:**
- Create: `components/Chat/ChannelStatusGlyphs.tsx`

- [ ] **Step 1: Write the component**

Create `components/Chat/ChannelStatusGlyphs.tsx`:

```tsx
/**
 * ChannelStatusGlyphs — small muted glyphs trailing a channel name so state is
 * scannable without opening the drawer. star = default channel, lock = read-only.
 * Both can show at once. Deliberately subtle (no bg, no label).
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { Channel, Space } from '@quilibrium/quorum-shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ChannelStatusGlyphsProps {
  channel: Pick<Channel, 'channelId' | 'isReadOnly'>;
  defaultChannelId: Space['defaultChannelId'];
  size?: number;
}

export function ChannelStatusGlyphs({ channel, defaultChannelId, size = 13 }: ChannelStatusGlyphsProps) {
  const { theme } = useTheme();
  const isDefault = channel.channelId === defaultChannelId;
  const isReadOnly = !!channel.isReadOnly;
  if (!isDefault && !isReadOnly) return null;

  return (
    <View style={styles.row}>
      {isDefault && <IconSymbol name="star.fill" size={size} color={theme.colors.textMuted} />}
      {isReadOnly && <IconSymbol name="lock.fill" size={size} color={theme.colors.textMuted} />}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) },
});
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.

- [ ] **Step 3: Commit**

```bash
git add components/Chat/ChannelStatusGlyphs.tsx
git commit -m "feat(channels): scannable status glyphs (default/read-only)"
```

---

## Task 6: Build the drawer shell + channel rows (`ChannelSettingsSheet`)

The core component. This task builds the **channel** variant with: rename, icon, read-only toggle + managers row, set-as-default toggle, delete. The **group** variant is added in Task 7. Nested pickers wired in Task 8 (this task wires their visibility state and the icon picker; the role picker is wired here too since read-only depends on it).

**Files:**
- Create: `components/Chat/ChannelSettingsSheet.tsx`

- [ ] **Step 1: Define the target type and component skeleton**

Create `components/Chat/ChannelSettingsSheet.tsx`:

```tsx
/**
 * ChannelSettingsSheet — per-item settings drawer for a channel OR a channel
 * group, opened from a row tap inside SpaceSettingsModal (owner-only path).
 * Group-aware via the `target` prop. Hosts nested icon + role pickers.
 *
 * Replaces the inline channel/group editing previously scattered across
 * SpaceSettingsModal (editingChannelId / iconPicker* state + handlers).
 */
import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { IconColor } from '@quilibrium/quorum-shared';
import {
  useUpdateChannel,
  useDeleteChannel,
  useUpdateGroup,
  useDeleteGroup,
} from '@/hooks/chat';
import { useUpdateSpace } from '@/hooks/chat/useSpaceSettings';
import { useRoles } from '@/hooks/chat/useRoleManagement';
import { getSpace } from '@/services/config/spaceStorage';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { ChannelIconPickerSheet } from '@/components/ui/ChannelIconPickerSheet';
import { ChannelManagerRolePickerSheet } from '@/components/Chat/ChannelManagerRolePickerSheet';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useTheme, type AppTheme } from '@/theme';
import { getIconColorHex } from '@quilibrium/quorum-shared';
import { Switch } from 'react-native';
import * as Skin from '@/theme/skins/geometry';

export type ChannelSettingsTarget =
  | { kind: 'channel'; spaceId: string; groupIndex: number; channelId: string }
  | { kind: 'group'; spaceId: string; groupIndex: number };

interface ChannelSettingsSheetProps {
  visible: boolean;
  target: ChannelSettingsTarget | null;
  onClose: () => void;
  /** Called after a mutation so the parent (SpaceSettingsModal) can reload its space copy. */
  onChanged?: () => void;
}

export function ChannelSettingsSheet({ visible, target, onClose, onChanged }: ChannelSettingsSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { confirm, confirmDialog } = useConfirmDialog();

  const updateChannel = useUpdateChannel();
  const deleteChannel = useDeleteChannel();
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const updateSpace = useUpdateSpace();
  const { data: roles = [] } = useRoles(target?.spaceId);

  // Nested-sheet visibility + back-guard
  const [iconPickerVisible, setIconPickerVisible] = useState(false);
  const [rolePickerVisible, setRolePickerVisible] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const childOpen = iconPickerVisible || rolePickerVisible || isConfirming;
  const guardedClose = () => {
    if (childOpen) return;
    onClose();
  };

  // Bump this after every local mutation so `resolved` re-reads storage. Using a
  // counter (not mutation.isSuccess) because isSuccess latches true after the
  // first mutation and would never re-trigger the memo on the 2nd+ edit.
  const [reloadTick, setReloadTick] = useState(0);
  const bumpReload = () => setReloadTick((t) => t + 1);

  // Resolve the live target object fresh from storage (cheap). Returns the
  // space + the channel/group. Re-reads whenever the target, visibility, or
  // reloadTick changes.
  const resolved = useMemo(() => {
    if (!target) return null;
    const space = getSpace(target.spaceId);
    if (!space) return null;
    const group = space.groups[target.groupIndex];
    if (!group) return null;
    if (target.kind === 'group') return { space, group, channel: null };
    const channel = group.channels.find((c) => c.channelId === target.channelId) ?? null;
    return { space, group, channel };
  }, [target, visible, reloadTick]);

  // Local rename buffer
  const [nameDraft, setNameDraft] = useState('');
  React.useEffect(() => {
    if (!resolved) return;
    setNameDraft(
      target?.kind === 'group' ? resolved.group.groupName : resolved.channel?.channelName ?? ''
    );
  }, [resolved, target?.kind]);

  if (!target || !resolved) {
    return (
      <BaseModal visible={visible} onClose={guardedClose} showHandle height={0.5}>
        <View style={styles.container} />
      </BaseModal>
    );
  }

  const { space, channel } = resolved;
  const isChannel = target.kind === 'channel';

  // ---- handlers added in subsequent steps ----

  return (
    <BaseModal visible={visible} onClose={guardedClose} showHandle height={0.8} avoidKeyboard>
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{isChannel ? 'Channel settings' : 'Group settings'}</Text>

        {/* rows added in Step 2 / Task 7 */}

        {confirmDialog}
      </ScrollView>

      {/* Nested pickers (Task 8) */}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(16), paddingTop: Skin.space(8) },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(16),
    },
    group: { marginBottom: Skin.space(14) },
    renameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(10),
      marginBottom: Skin.space(14),
    },
    renameInput: { flex: 1, ...theme.textStyles.body, color: theme.colors.textMain, padding: 0 },
    iconPreview: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
```

- [ ] **Step 2: Add the channel rows + handlers**

Replace the `// ---- handlers added in subsequent steps ----` marker with the channel handlers, and the `{/* rows added in Step 2 / Task 7 */}` marker with the channel JSX. Insert this block (handlers above `return`, JSX inside the ScrollView):

Handlers (place above the `return`). The `afterMutation` helper refreshes both the drawer's own view (`bumpReload`) and the parent modal (`onChanged`):

```tsx
  const afterMutation = () => {
    bumpReload();
    onChanged?.();
  };

  const commitName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    if (isChannel) {
      if (trimmed === channel?.channelName) return;
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, channelName: trimmed });
    } else {
      if (trimmed === resolved.group.groupName) return;
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, groupName: trimmed });
    }
    afterMutation();
  };

  const handleIconSelect = async (icon: string, color: IconColor, variant: 'outline' | 'filled') => {
    if (isChannel) {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon, iconColor: color, iconVariant: variant });
    } else {
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon, iconColor: color, iconVariant: variant });
    }
    afterMutation();
  };

  const handleIconClear = async () => {
    if (isChannel) {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
    } else {
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
    }
    afterMutation();
  };

  const handleToggleReadOnly = async (value: boolean) => {
    if (!isChannel) return;
    await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, isReadOnly: value });
    afterMutation();
  };

  const handleManagerRolesConfirm = async (roleIds: string[]) => {
    if (!isChannel) return;
    await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, managerRoleIds: roleIds });
    afterMutation();
  };

  const handleSetDefault = async (value: boolean) => {
    if (!isChannel || !value) return; // only set; can't un-set without choosing another
    await updateSpace.mutateAsync({ spaceId: target.spaceId, defaultChannelId: target.channelId });
    afterMutation();
  };

  const handleDelete = async () => {
    setIsConfirming(true);
    const label = isChannel ? `#${channel?.channelName ?? ''}` : `the “${resolved.group.groupName}” group`;
    const ok = await confirm({
      title: isChannel ? 'Delete Channel' : 'Delete Group',
      message: isChannel
        ? `This permanently deletes ${label} and its messages for everyone.`
        : `This permanently deletes ${label} for everyone. The group must be empty.`,
      confirmLabel: 'Delete',
    });
    setIsConfirming(false);
    if (!ok) return;
    try {
      if (isChannel) {
        await deleteChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId });
      } else {
        await deleteGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex });
      }
      onChanged?.(); // refresh parent; the drawer is closing so no bumpReload needed
      onClose();
    } catch (e) {
      await confirm({
        title: 'Could not delete',
        message:
          isChannel && target.channelId === space.defaultChannelId
            ? 'This is the default channel. Set another channel as default first.'
            : 'Delete failed. ' + (e instanceof Error ? e.message : ''),
        confirmLabel: 'OK',
        cancelLabel: 'Dismiss',
        variant: 'primary',
      });
    }
  };

  const managerNames = (channel?.managerRoleIds ?? [])
    .map((id) => roles.find((r) => r.roleId === id)?.displayName)
    .filter(Boolean)
    .join(', ');
  const iconHex = getIconColorHex((channel?.iconColor ?? 'default') as IconColor);
```

Channel JSX (inside the ScrollView, replacing the rows marker). For the **group** variant, Task 7 wraps the channel-only rows in `{isChannel && (...)}`:

```tsx
        {/* Rename + icon */}
        <View style={styles.renameRow}>
          <TouchableOpacity
            style={[styles.iconPreview, { backgroundColor: iconHex + '20' }]}
            onPress={() => setIconPickerVisible(true)}
            accessibilityLabel="Change icon"
          >
            <IconSymbol
              name={((isChannel ? channel?.icon : resolved.group.icon) || 'hashtag') as IconSymbolName}
              size={20}
              color={iconHex}
              variant={(isChannel ? channel?.iconVariant : resolved.group.iconVariant) ?? 'outline'}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.renameInput}
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={commitName}
            onSubmitEditing={commitName}
            placeholder={isChannel ? 'Channel name' : 'Group name'}
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="done"
          />
        </View>

        {isChannel && (
          <>
            <ActionRowGroup>
              <ActionRow
                label="Read-only"
                sublabel="Only managers can post"
                trailing={
                  <Switch
                    value={!!channel?.isReadOnly}
                    onValueChange={handleToggleReadOnly}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
              {channel?.isReadOnly && (
                <ActionRow
                  label="Managers"
                  sublabel={managerNames || 'No roles selected'}
                  trailing="chevron"
                  onPress={() => setRolePickerVisible(true)}
                />
              )}
            </ActionRowGroup>

            <ActionRowGroup>
              <ActionRow
                label="Set as default channel"
                sublabel={
                  channel?.channelId === space.defaultChannelId
                    ? 'This is the default channel'
                    : 'New members land here first'
                }
                trailing={
                  <Switch
                    value={channel?.channelId === space.defaultChannelId}
                    onValueChange={handleSetDefault}
                    disabled={channel?.channelId === space.defaultChannelId}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
            </ActionRowGroup>
          </>
        )}

        <ActionRowGroup>
          <ActionRow
            icon="trash"
            label={isChannel ? 'Delete channel' : 'Delete group'}
            destructive
            onPress={handleDelete}
          />
        </ActionRowGroup>
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N. (The nested pickers aren't rendered yet — Task 8 — but the visibility state and handlers compile now.)

- [ ] **Step 4: Commit**

```bash
git add components/Chat/ChannelSettingsSheet.tsx
git commit -m "feat(channels): channel settings drawer shell + channel rows"
```

---

## Task 7: Add the group variant

The group drawer shows rename + icon + delete only (the channel-only block is already guarded by `isChannel`). Verify the group path renders correctly and the delete/empty-group message is right.

**Files:**
- Modify: `components/Chat/ChannelSettingsSheet.tsx`

- [ ] **Step 1: Confirm group rows render**

The Task 6 JSX already conditions the read-only/default blocks on `isChannel`, so a `group` target shows only rename+icon+delete. Verify:
- The rename row's icon uses `resolved.group.icon` / `resolved.group.iconVariant` when `!isChannel` — already handled by the ternary in the JSX.
- `iconHex` in Task 6 reads `channel?.iconColor` which is undefined for a group. Fix it to be target-aware. Change the `iconHex` line to:

```tsx
  const activeIconColor = (isChannel ? channel?.iconColor : resolved.group.iconColor) ?? 'default';
  const iconHex = getIconColorHex(activeIconColor as IconColor);
```

- [ ] **Step 2: Confirm the group delete message + guard**

`useDeleteGroup` throws if the group contains the default channel; the catch in `handleDelete` already surfaces a generic failure. Improve the group case message — in `handleDelete`'s catch, the channel-specific default message is fine; for a group failure the generic branch fires, which is acceptable. (Optional: add a group-specific "Group must be empty / can't contain the default channel" message — only if you can distinguish the cause from the error text.)

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.

- [ ] **Step 4: Commit**

```bash
git add components/Chat/ChannelSettingsSheet.tsx
git commit -m "feat(channels): group variant for settings drawer (rename/icon/delete)"
```

---

## Task 8: Wire the nested pickers into the drawer

**Files:**
- Modify: `components/Chat/ChannelSettingsSheet.tsx`

- [ ] **Step 1: Render the nested sheets**

Replace the `{/* Nested pickers (Task 8) */}` marker (after the main `</ScrollView>`, still inside the outer `BaseModal`) with:

```tsx
      <ChannelIconPickerSheet
        visible={iconPickerVisible}
        onClose={() => setIconPickerVisible(false)}
        selectedIcon={(isChannel ? channel?.icon : resolved.group.icon) || undefined}
        selectedColor={activeIconColor as IconColor}
        selectedVariant={(isChannel ? channel?.iconVariant : resolved.group.iconVariant) ?? 'outline'}
        onSelect={handleIconSelect}
        onClear={handleIconClear}
      />

      {isChannel && (
        <ChannelManagerRolePickerSheet
          visible={rolePickerVisible}
          onClose={() => setRolePickerVisible(false)}
          roles={roles}
          selectedRoleIds={channel?.managerRoleIds ?? []}
          onConfirm={handleManagerRolesConfirm}
        />
      )}
```

> These render inside the outer `BaseModal` so they stack as nested native modals on top of the drawer (verified pattern: `IconPicker` over `SpaceSettingsModal`, `ConfirmDialog` over `DMSettingsSheet`). The `childOpen`/`guardedClose` logic from Task 6 already prevents the drawer from dismissing while a picker or confirm is open.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.

- [ ] **Step 3: Commit**

```bash
git add components/Chat/ChannelSettingsSheet.tsx
git commit -m "feat(channels): wire nested icon + role pickers into settings drawer"
```

---

## Task 9: Integrate the drawer into `SpaceSettingsModal` + remove inline editing

Make channel/group rows open the drawer; mount the drawer; add glyphs to the modal's channel rows; remove the old inline editing state, handlers, and the old `<IconPicker>`. **Keep add-channel and the up/down reorder arrows.**

**Files:**
- Modify: `components/SpaceSettingsModal.tsx`

- [ ] **Step 1: Add drawer state + import**

Add the import near the other component imports:

```tsx
import { ChannelSettingsSheet, type ChannelSettingsTarget } from '@/components/Chat/ChannelSettingsSheet';
import { ChannelStatusGlyphs } from '@/components/Chat/ChannelStatusGlyphs';
```

Add state near the other channel state (replacing the soon-to-be-removed editing state at `:870-879`):

```tsx
const [drawerTarget, setDrawerTarget] = useState<ChannelSettingsTarget | null>(null);
```

- [ ] **Step 2: Make group header + channel rows open the drawer**

In `renderChannelsTab` (`:1896-2104`):

- **Group header** (`:1949-1958`, the non-editing `TouchableOpacity` that set `editingGroupIndex`): change its `onPress` to:
  ```tsx
  onPress={() => setDrawerTarget({ kind: 'group', spaceId, groupIndex })}
  ```
  Remove the inline group rename `TextInput`/checkmark/xmark branch (`:1929-1947`) — the drawer owns rename now. Keep the `+` (add channel) and the group's own row layout.

- **Channel name** (`:2048-2056`, the `TouchableOpacity` that set `editingChannelId`): change its `onPress` to:
  ```tsx
  onPress={() => setDrawerTarget({ kind: 'channel', spaceId, groupIndex, channelId: channel.channelId })}
  ```
  Remove the inline channel rename `TextInput`/checkmark/xmark branch (`:2026-2046`). Remove the per-row **icon button** (`:2011-2023`) that opened the old icon picker — icon editing moves into the drawer. **Keep** the up/down chevrons and trash? → No: move delete into the drawer too. **Decision:** keep up/down arrows (reorder stays out of scope); REMOVE the per-row trash (delete now lives in the drawer). Replace the old "default" text badge (`:2058-2062`) with `<ChannelStatusGlyphs channel={channel} defaultChannelId={space?.defaultChannelId} />`.

  > Net per-row affordances after this task: `[icon (display only, opens drawer via name tap)] [name → opens drawer] [status glyphs] [▲][▼] [no trash]`. Tapping the icon area should also open the drawer (wrap icon+name in one `TouchableOpacity`, or give the icon the same `onPress`).

- [ ] **Step 3: Extract a named `loadSpace` and mount the drawer**

`SpaceSettingsModal` holds `space` in local `useState` (`:534`) and reloads it via an **inline** `useEffect` (`:535-540`) plus scattered `setSpace(getSpace(spaceId))` / `setSpace(updated)` calls in the old mutation handlers. There is **no named reload function** today. Extract one so the drawer can trigger a reload after its own mutations.

Replace the inline effect (`:535-540`) with a `useCallback` + effect:

```tsx
  const loadSpace = useCallback(() => {
    if (spaceId) setSpace(getSpace(spaceId));
  }, [spaceId]);

  useEffect(() => {
    if (visible) loadSpace();
  }, [visible, loadSpace]);
```

(Ensure `useCallback` is imported from `react`.)

Then, where the old `<IconPicker>` was rendered (`:2668-2697`), replace that whole block with:

```tsx
      <ChannelSettingsSheet
        visible={!!drawerTarget}
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
        onChanged={loadSpace}
      />
```

> The drawer's own mutations also invalidate the `['spaces', spaceId]` query (every update hook does, e.g. `useUpdateChannel` `onSuccess`), but `SpaceSettingsModal` reads from local `space` state, not that query — so `onChanged={loadSpace}` is what actually refreshes the modal's channel list (e.g. the star glyph moving after set-as-default). Keep it.

- [ ] **Step 4: Remove dead inline-editing code**

Delete these now-unused declarations (`:870-879`): `editingChannelId`, `editingChannelName`, `editingGroupIndex`, `editingGroupName`, `iconPickerVisible`, `iconPickerChannelId`. **Keep** `newChannelGroupIndex`, `newChannelName` (add-channel).

Delete these now-unused handlers: `handleSaveChannelName` (`:1284`), `handleDeleteChannel` (`:1304`), `handleSaveGroupName` (`:1220`), `handleDeleteGroup` (`:1240`). **Keep** `handleAddChannel`, `handleMoveChannelUp/Down`, and the group add/delete-via-`+` stays only if still referenced — if `handleDeleteGroup` is removed, ensure the group header no longer has a trash button calling it (move group delete into the drawer; remove the header trash button at `:1970-1975`).

Remove the now-unused `IconPicker` import.

> `useUpdateChannel`/`useDeleteChannel`/`useUpdateGroup`/`useDeleteGroup` instances in the modal (`:792-796`) may become unused if no other code path uses them. Leave an instance only if still referenced (add-channel uses `useAddChannel`; reorder uses `useMoveChannel`). Remove genuinely-unused mutation instances to keep lint clean.

- [ ] **Step 5: Type-check + lint + grep for leftovers**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N (or lower if removals fixed pre-existing unused-var errors).

Run: `yarn lint`
Expected: no new errors; ideally fewer unused-var warnings than baseline.

Run: `npx -y rg "editingChannelId|editingChannelName|editingGroupIndex|editingGroupName|iconPickerVisible|iconPickerChannelId|handleSaveChannelName|handleSaveGroupName" components/SpaceSettingsModal.tsx`
Expected: **no matches** (all inline-editing state/handlers removed).

Run: `npx -y rg "from '@/components/ui/IconPicker'" components/SpaceSettingsModal.tsx`
Expected: **no matches**.

- [ ] **Step 6: Commit**

```bash
git add components/SpaceSettingsModal.tsx
git commit -m "feat(channels): open settings drawer from SpaceSettingsModal; remove inline editing"
```

---

## Task 10: Add status glyphs + named-color rendering to the in-space channel list

**Files:**
- Modify: `app/(tabs)/spaces/[id]/index.tsx` (rows `:122-153`)

- [ ] **Step 1: Import the glyphs + the color resolver**

Add imports:

```tsx
import { ChannelStatusGlyphs } from '@/components/Chat/ChannelStatusGlyphs';
import { getIconColorHex, type IconColor } from '@quilibrium/quorum-shared';
```

- [ ] **Step 2: Route the channel icon color through `getIconColorHex` and add glyphs**

Replace the channel `IconSymbol` (`:131-135`) and add the glyphs after the name (`:138`). New row body:

```tsx
                  <IconSymbol
                    name={(channel.icon || 'hashtag') as IconSymbolName}
                    size={18}
                    color={
                      channel.iconColor
                        ? getIconColorHex(channel.iconColor as IconColor)
                        : theme.colors.textMuted
                    }
                    variant={channel.iconVariant ?? 'outline'}
                  />
                  <Text style={styles.channelName} numberOfLines={1}>
                    {channel.channelName}
                  </Text>
                  <ChannelStatusGlyphs
                    channel={channel}
                    defaultChannelId={spaceData.defaultChannelId}
                  />
                  {unread > 0 && (
```

> **Back-compat note:** legacy channels store a raw hex in `iconColor` (e.g. `'#3b82f6'`), not a token. `getIconColorHex` warns + returns the default gray for an unknown value, so legacy-hex channels would go gray. To preserve legacy hex: `const c = channel.iconColor; const color = !c ? theme.colors.textMuted : c.startsWith('#') ? c : getIconColorHex(c as IconColor);`. Use this guarded form in BOTH this file and the picker preview/`SpaceSettingsModal` if legacy channels exist in the test data. Decide at build time by inspecting a real space's stored `iconColor`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.

- [ ] **Step 4: Commit**

```bash
git add "app/(tabs)/spaces/[id]/index.tsx"
git commit -m "feat(channels): status glyphs + named icon colors in in-space channel list"
```

---

## Task 11: Delete the legacy `IconPicker`

Only after Task 9 removed its last usage.

**Files:**
- Delete: `components/ui/IconPicker.tsx`

- [ ] **Step 1: Confirm no references remain**

Run: `npx -y rg "IconPicker" components/ app/ hooks/`
Expected: matches only for `ChannelIconPickerSheet` (different name) — **no `from '@/components/ui/IconPicker'`** and no `<IconPicker`.

- [ ] **Step 2: Delete the file**

```bash
git rm components/ui/IconPicker.tsx
```

- [ ] **Step 3: Type-check + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck 2>&1 | Select-String "error TS" | Measure-Object | Select-Object -ExpandProperty Count`
Expected: baseline N.
Run: `yarn lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(icons): remove legacy IconPicker (replaced by shared-vocab picker)"
```

---

## Task 12: Device test script (handed to the user — nothing merges before this passes)

**Files:** none (this is the runtime checklist; copy into `.agents/tests/2026-06-17-channel-drawer-test-script.md` for the user)

> The user runs the app via the dev scripts in `.agents/scripts/` (e.g. `dev-start-emulator.ps1` / `dev-start-mobile.ps1`). Agents do NOT run the Expo app. Capture results, fix, re-hand.

- [ ] **Owner entry:** Open a space you own → gear → Channels tab → tap a channel row → drawer opens with that channel's settings. Tap a group header → group drawer opens (rename/icon/delete only).
- [ ] **Rename:** Edit the name field, dismiss keyboard → persists; reopen the drawer → new name shown; check a second client → synced.
- [ ] **Icon picker:** Open it → 87 icons in a scroll grid; tap one with a filled form → the Outline/Filled chips appear → switch to Filled → preview updates. Pick a color → preview + grid highlight update. Apply → channel row shows the new icon/color/variant. Cross-check on desktop → icon renders (vocabulary parity).
- [ ] **Color count call:** Eyeball the color row. Decide whether 12 is too many for the layout; if so, trim `PICKER_COLORS` in `ChannelIconPickerSheet.tsx` to ~7 and re-test. (This is the deferred "7 vs all" decision.)
- [ ] **Read-only + managers:** Toggle Read-only ON → "Managers" row appears → tap → role checklist → select a role → Done → drawer shows the role name. Go into the channel as a NON-manager user → read-only banner blocks posting; as a member of the selected role → can post. (Confirms write matches `canManageReadOnlyChannel`.)
- [ ] **Set as default:** Toggle "Set as default" on a non-default channel → star glyph moves to it in both lists; the previously-default channel loses its star; only one default exists. The currently-default channel's toggle is on + disabled.
- [ ] **Delete channel:** Delete a non-default channel → single confirm → gone for everyone (check second client). Try to delete the default channel → blocked with the "set another default first" message.
- [ ] **Group drawer:** Rename / icon / delete a group persist + sync. Deleting a non-empty group is blocked with a clear message.
- [ ] **Status glyphs:** star on the default channel, lock on read-only channels, both when both — in BOTH the in-space list and the SpaceSettingsModal list. Placement doesn't collide with the unread badge.
- [ ] **Nested-sheet back behaviour (Android):** With the icon picker open, press Back → picker closes, drawer stays. Back again → drawer closes. Same for the role picker and the delete confirm.
- [ ] **Non-owner:** As a non-owner, gear → only Account + Members tabs; no channel list; drawer unreachable. Gear behaves identically to owner (always space settings).
- [ ] **Legacy data:** Open a space whose channels were created on desktop / older mobile (raw-hex or Tabler icon names) → icons still render (no gray-out regression). If they gray out, apply the legacy-hex guard from Task 10 Step 2 everywhere icon color is resolved.

---

## Ship checklist (after the user confirms device tests pass)

- [ ] `npx tsc --noEmit --jsx react-jsx --skipLibCheck` — no new errors vs baseline.
- [ ] `yarn lint` — clean (no new).
- [ ] `npx -y rg "editingChannelId|iconPickerVisible|from '@/components/ui/IconPicker'" components/` → no matches.
- [ ] Branch name + PR title self-explanatory, no internal jargon (memory: `branch-pr-names-self-explanatory`). Suggested PR title: **"Channel & group settings drawer + shared-vocab icon picker"**.
- [ ] Per-fix commits become the PR body; squash-merge; delete the REMOTE branch only (memory: `never-delete-local-branch-on-ship`).
- [ ] Tell the lead (Telegram, short) that mobile shipped a user-facing channel/group settings drawer + moved the icon picker onto the shared vocabulary (cross-platform icon parity). This touches mobile UX → worth a heads-up per the atlas.

---

## Self-review notes (author)

- **Spec coverage:** rename ✓ (Task 6), icon+color+variant ✓ (Task 3/6/8), read-only toggle ✓, managers row + nested picker ✓ (Task 4/6/8), set-as-default ✓ (Task 2/6), delete single-confirm ✓ (Task 6), group rename/icon/delete ✓ (Task 7), status glyphs both lists ✓ (Task 5/9/10), one owner-gated entry / gear untouched ✓ (Task 9 + guardrails), "Allow threads" omitted ✓ (scope decision 3), DnD out of scope ✓ (guardrails). Icon parity via shared vocab ✓ (Task 3).
- **Hook prerequisites:** `defaultChannelId` (Task 2) gates set-as-default; `iconVariant` (Task 2) gates filled icons; both verified absent today and added additively.
- **Risk to watch:** legacy raw-hex `iconColor` values vs the new named-token rendering (Task 10 Step 2 guard). Decide against real test data before shipping.
- **Not re-litigated:** the interaction model (locked in the design); the app-wide IconSymbol migration (rejected, untouched).

---
*Last updated: 2026-06-17*
