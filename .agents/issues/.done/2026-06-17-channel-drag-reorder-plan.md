---
type: task
title: "Channel Drag-and-Drop Reorder Implementation Plan"
status: done
created: 2026-06-17
---

# Channel Drag-and-Drop Reorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the up/down chevron buttons on each channel row in the Channels tab with a hand-rolled, handle-based drag-to-reorder gesture (within-group only), with VoiceOver/TalkBack "Move up/down" accessibility actions as the accessible path.

**Architecture:** A new self-contained `DraggableChannelGroup` component renders the rows of one group as an absolutely-positioned reorderable stack driven by `react-native-gesture-handler` (`Gesture.Pan` scoped to a grip handle) + `react-native-reanimated` shared values. `SpaceSettingsModal` swaps its inline `group.channels.map(...)` row markup for this component. Persistence reuses the existing `useReorderChannels` mutation. No new npm dependency. The RN `<Modal>` in `BaseModal` gets its own `GestureHandlerRootView` so gestures fire on Android.

**Tech Stack:** react-native-gesture-handler 2.28.0, react-native-reanimated 4.1.1, react-native-worklets 0.5.1, expo-haptics, @tabler/icons-react-native (already installed). No new deps.

**Source task:** `.agents/issues/.done/2026-06-14-channel-drag-and-drop-reorder.md` (locked decisions + research live there).

**Pre-verified facts (do not re-research):**
- `IconGripVertical` exists at `node_modules/@tabler/icons-react-native/.../IconGripVertical.mjs`. `IconSymbol` has NO grip glyph yet — Task 1 adds `grip.vertical`.
- `BaseModal` (`components/shared/BaseModal.tsx`) wraps content in RN `<Modal>` and has NO `GestureHandlerRootView` → Android gestures inside it are dead until Task 2 fixes it.
- `BaseModal`'s swipe-to-dismiss uses the **legacy RN `PanResponder`** (`hooks/usePanResponder.ts`), not an RNGH gesture. It only captures after `dy > 120` and `onStartShouldSetPanResponder: () => false`, so it will NOT steal a drag that starts on the handle. The real conflict to manage is the inner `ScrollView`.
- The Channels tab content is a RN `<ScrollView>` (`SpaceSettingsModal.tsx:1779`). Rows are uniform height (`channelItem`: `paddingVertical: 8` around a 28px icon).
- Existing move handlers to reuse for a11y: `handleMoveChannelUp` (`SpaceSettingsModal.tsx:1206`), `handleMoveChannelDown` (`:1227`). Local space state pattern: mutate, then `setSpace(getSpace(spaceId))`.
- `useReorderChannels({ spaceId, groupIndex, channelOrder })` exists in `hooks/chat/useChannelManagement.ts:601` — takes the full ordered `channelId[]`, validates, persists, broadcasts.

**Scope guardrails (from locked decisions):** within-group reorder ONLY. No cross-group drag, no group reordering. The chevron buttons are REMOVED; the move handlers STAY (reused by a11y actions). Keep `ScrollView` — do NOT introduce FlashList.

---

## File Structure

- **Modify** `components/ui/IconSymbol.tsx` — add `grip.vertical` → Tabler `IconGripVertical` mapping.
- **Modify** `components/shared/BaseModal.tsx` — wrap modal content in `GestureHandlerRootView`.
- **Create** `components/SpaceSettings/DraggableChannelGroup.tsx` — the reorderable list of rows for ONE group. Owns the Pan gesture, shared values, haptics, drop math, persistence call, and a11y actions. ~220 lines.
- **Modify** `components/SpaceSettingsModal.tsx` — replace the inline channel-row `.map()` (lines ~1835–1872) and the chevron handlers' UI usage with `<DraggableChannelGroup>`. Remove the two `channelArrowButton` `TouchableOpacity`s. Keep `handleMoveChannelUp/Down` (passed down for a11y).

Why a new file: the gesture/animation logic is dense and self-contained; `SpaceSettingsModal.tsx` is already >3000 lines. A focused component is testable in isolation and keeps the modal readable.

---

### Task 1: Add the grip-vertical icon to IconSymbol

**Files:**
- Modify: `components/ui/IconSymbol.tsx` (mapping table near line 86)

- [ ] **Step 1: Add the mapping**

In `components/ui/IconSymbol.tsx`, find the icon mapping object (it contains `'line.3.horizontal': tabler('IconMenu2'),` at line 86). Add this line alphabetically near the other `g`/grip entries (or adjacent to `line.3.horizontal`):

```ts
  'grip.vertical': tabler('IconGripVertical'),
```

- [ ] **Step 2: Verify it type-checks and resolves**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no NEW errors (baseline is 23 pre-existing per the test-script header; the count must not increase).

- [ ] **Step 3: Commit**

```bash
git add components/ui/IconSymbol.tsx
git commit -m "feat: add grip.vertical icon for drag handle"
```

---

### Task 2: Make gestures work inside BaseModal on Android

**Files:**
- Modify: `components/shared/BaseModal.tsx:2` (import) and `:136-161` (the `<Modal>` return block)

RN `<Modal>` renders in a separate native view hierarchy, so the app-root `GestureHandlerRootView` (`app/_layout.tsx:321`) does not cover it. Without a `GestureHandlerRootView` inside the modal, RNGH gestures silently no-op on Android. This wrap is inert for all existing `BaseModal` consumers (none currently use RNGH gestures inside it) and `flex: 1` preserves layout.

- [ ] **Step 1: Add the import**

In `components/shared/BaseModal.tsx`, add to the imports (after line 2):

```ts
import { GestureHandlerRootView } from 'react-native-gesture-handler';
```

- [ ] **Step 2: Wrap the modal container**

Replace the `return (` block (currently lines 136-162, the `<Modal>...</Modal>`) so the outer `View style={styles.container}` is wrapped:

```tsx
  return (
    <Modal
      transparent
      visible={visible}
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      testID={testID}
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        <View style={styles.container}>
          {/* Animated backdrop */}
          <Animated.View
            style={[
              styles.backdrop,
              { opacity: backdropAnim },
            ]}
          >
            <TouchableWithoutFeedback onPress={onClose}>
              <View style={StyleSheet.absoluteFillObject} />
            </TouchableWithoutFeedback>
          </Animated.View>

          {/* Animated content */}
          {modalContent}
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
```

- [ ] **Step 3: Verify type-check + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors.
Run: `yarn lint`
Expected: clean at baseline.

- [ ] **Step 4: Sanity-check an existing modal still opens**

This is a manual smoke check at next runtime test, not a blocker for commit. Note in the commit that BaseModal now self-roots gestures.

- [ ] **Step 5: Commit**

```bash
git add components/shared/BaseModal.tsx
git commit -m "fix: root gesture-handler inside BaseModal so modal gestures fire on Android"
```

---

### Task 3: Create DraggableChannelGroup — static render (no drag yet)

Build the component first as a pure visual replacement for the current row markup (icon button + name + status glyphs + grip handle), WITHOUT drag behavior. This isolates the layout from the gesture so a layout regression can't be confused with a gesture bug.

**Files:**
- Create: `components/SpaceSettings/DraggableChannelGroup.tsx`

- [ ] **Step 1: Create the component file**

Create `components/SpaceSettings/DraggableChannelGroup.tsx`:

```tsx
import React, { useCallback } from 'react';
import { View, Text, StyleSheet, AccessibilityActionEvent } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import type { Channel } from '@quilibrium/quorum-shared';

// Fixed row height drives the reorder math. Matches `channelItem` in
// SpaceSettingsModal: paddingVertical 8 (x2) + 28px icon button = 44.
export const CHANNEL_ROW_HEIGHT = 44;

export interface DraggableChannelGroupProps {
  groupIndex: number;
  channels: Channel[];
  defaultChannelId: string;
  /**
   * Ref to the RNGH ScrollView wrapping the Channels tab. Threaded down to the
   * Pan gesture (Task 5) so a drag wins over the scroll. In Task 3 (static,
   * pre-drag) this is unused — accept it now so the prop shape is stable.
   * Typed loosely (object | null) to avoid importing the RNGH ScrollView ref
   * type into this file; the gesture only needs the ref object.
   */
  scrollRef: React.RefObject<unknown>;
  /** Resolve a channel iconColor to a hex string (passed from the modal). */
  resolveIconColor: (iconColor: string | undefined, fallback: string) => string;
  /** Tapping a row opens that channel's settings drawer. */
  onOpenChannel: (channelId: string) => void;
  /** Renders the lock/star status glyphs for a channel. */
  renderStatusGlyphs: (channel: Channel) => React.ReactNode;
  /** a11y: move a channel up one position within its group. */
  onMoveUp: (groupIndex: number, channelIndex: number) => void;
  /** a11y: move a channel down one position within its group. */
  onMoveDown: (groupIndex: number, channelIndex: number) => void;
  /** Persist a new full channel order for this group. */
  onReorder: (groupIndex: number, channelOrder: string[]) => void;
}

export function DraggableChannelGroup({
  groupIndex,
  channels,
  defaultChannelId,
  scrollRef,
  resolveIconColor,
  onOpenChannel,
  renderStatusGlyphs,
  onMoveUp,
  onMoveDown,
  onReorder,
}: DraggableChannelGroupProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const handleAccessibilityAction = useCallback(
    (channelIndex: number) => (e: AccessibilityActionEvent) => {
      if (e.nativeEvent.actionName === 'moveUp') onMoveUp(groupIndex, channelIndex);
      else if (e.nativeEvent.actionName === 'moveDown') onMoveDown(groupIndex, channelIndex);
    },
    [groupIndex, onMoveUp, onMoveDown]
  );

  return (
    <View style={{ height: channels.length * CHANNEL_ROW_HEIGHT }}>
      {channels.map((channel, channelIndex) => {
        const a11yActions = [];
        if (channelIndex > 0) a11yActions.push({ name: 'moveUp', label: 'Move up' });
        if (channelIndex < channels.length - 1)
          a11yActions.push({ name: 'moveDown', label: 'Move down' });

        return (
          <View
            key={channel.channelId}
            style={[styles.row, { top: channelIndex * CHANNEL_ROW_HEIGHT }]}
            accessibilityRole="none"
            accessibilityLabel={`Channel ${channel.channelName}`}
            accessibilityActions={a11yActions}
            onAccessibilityAction={handleAccessibilityAction(channelIndex)}
          >
            <TouchableOpacity
              style={[
                styles.iconButton,
                channel.icon && {
                  backgroundColor:
                    resolveIconColor(channel.iconColor, theme.colors.textMuted) + '20',
                },
              ]}
              onPress={() => onOpenChannel(channel.channelId)}
            >
              <IconSymbol
                name={(channel.icon || 'hashtag') as IconSymbolName}
                size={14}
                color={resolveIconColor(channel.iconColor, theme.colors.textMuted)}
                variant={channel.iconVariant ?? 'outline'}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.nameContainer}
              onPress={() => onOpenChannel(channel.channelId)}
              accessibilityLabel={`Channel ${channel.channelName}. Double tap to open settings.`}
            >
              <Text style={styles.name}>{channel.channelName}</Text>
            </TouchableOpacity>
            {renderStatusGlyphs(channel)}
            <View style={styles.handle} importantForAccessibility="no-hide-descendants">
              <IconSymbol name="grip.vertical" size={16} color={theme.colors.textMuted} />
            </View>
          </View>
        );
      })}
    </View>
  );
}

const createStyles = (theme: ReturnType<typeof useTheme>['theme']) =>
  StyleSheet.create({
    row: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: CHANNEL_ROW_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      backgroundColor: theme.colors.surface3,
    },
    iconButton: {
      width: 28,
      height: 28,
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: Skin.space(6),
    },
    nameContainer: { flex: 1 },
    name: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    handle: {
      padding: Skin.space(8),
      marginLeft: Skin.space(4),
    },
  });
```

- [ ] **Step 2: Verify type-check**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors. (If `useTheme()['theme']` typing complains, the local `ThemeType` pattern from `BaseModal.tsx:12` — `type ThemeType = ReturnType<typeof createTheme>` importing `createTheme` from `@/theme/themes` — is the established workaround; mirror it.)

- [ ] **Step 3: Commit**

```bash
git add components/SpaceSettings/DraggableChannelGroup.tsx
git commit -m "feat: DraggableChannelGroup static row layout (no drag yet)"
```

---

### Task 4: Wire DraggableChannelGroup into SpaceSettingsModal (replace chevrons)

Swap the inline row markup for the new component. The list now renders identically but with a grip handle instead of chevrons, and a11y move actions wired up. Drag still inert — that lands in Task 5.

**Files:**
- Modify: `components/SpaceSettingsModal.tsx` (import; the row `.map()` at ~1835-1872; remove chevron `TouchableOpacity`s)

- [ ] **Step 1: Add the imports + the scroll ref**

Near the other component imports in `SpaceSettingsModal.tsx`:

```ts
import { DraggableChannelGroup } from '@/components/SpaceSettings/DraggableChannelGroup';
import { ScrollView as GHScrollView } from 'react-native-gesture-handler';
```

Inside the `SpaceSettingsModal` component body (near the other refs/state, e.g. next to where `useState`/`useRef` are used), create the ref the Channels-tab scroll view and the drag gesture will share:

```ts
const channelsScrollRef = useRef<React.ComponentRef<typeof GHScrollView>>(null);
```

(`useRef` is already imported in this file; if not, add it to the `react` import.)

- [ ] **Step 2: Add a reorder handler**

`useReorderChannels` is imported alongside `useMoveChannel`. Add the hook call near `moveChannelMutation` (line 790) and a handler near `handleMoveChannelDown` (after line 1245):

```ts
// near the other channel mutations (~line 790):
const reorderChannelsMutation = useReorderChannels();

// after handleMoveChannelDown (~line 1245):
const handleReorderChannels = useCallback(
  async (groupIndex: number, channelOrder: string[]) => {
    try {
      await reorderChannelsMutation.mutateAsync({ spaceId, groupIndex, channelOrder });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch {
      // mutation handles its own error state
    }
  },
  [spaceId, reorderChannelsMutation]
);
```

Confirm `useReorderChannels` is in the import from `@/hooks/chat` (it is exported from `hooks/chat/index.ts`); if not present in the existing import list alongside `useMoveChannel`, add it.

- [ ] **Step 3: Replace the channel rows**

In `renderChannelsTab`, replace the entire `{group.channels.map((channel, channelIndex) => ( ... ))}` block (lines ~1835-1872, the `<View style={styles.channelItem}>` ... including both chevron `TouchableOpacity`s and their `<View style={styles.channelActions}>`) with:

```tsx
          <DraggableChannelGroup
            groupIndex={groupIndex}
            channels={group.channels}
            defaultChannelId={space?.defaultChannelId ?? ''}
            scrollRef={channelsScrollRef}
            resolveIconColor={resolveChannelIconColor}
            onOpenChannel={(channelId) =>
              setDrawerTarget({ kind: 'channel', spaceId, groupIndex, channelId })
            }
            renderStatusGlyphs={(channel) => (
              <ChannelStatusGlyphs
                channel={channel}
                defaultChannelId={space?.defaultChannelId ?? ''}
              />
            )}
            onMoveUp={handleMoveChannelUp}
            onMoveDown={handleMoveChannelDown}
            onReorder={handleReorderChannels}
          />
```

Leave the `{group.channels.length === 0 && (...)}` empty-state block immediately after it as-is.

- [ ] **Step 4: Remove now-dead styles (optional, defer if risky)**

`styles.channelActions`, `styles.channelArrowButton`, `styles.channelArrowDisabled` (lines 3244-3254) are now unused. Lint will flag unused styles only if the repo's eslint config does so — check `yarn lint` output. If flagged, delete those three style keys. If not flagged, leave them (removing is cosmetic; avoid churn). The `channelItem` style key may still be referenced elsewhere — grep before deleting it: `Grep channelItem components/SpaceSettingsModal.tsx`.

- [ ] **Step 5: Verify type-check + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors.
Run: `yarn lint`
Expected: clean (or only the unused-style warnings handled in Step 4).

- [ ] **Step 6: Commit**

```bash
git add components/SpaceSettingsModal.tsx
git commit -m "feat: render channel rows via DraggableChannelGroup; replace chevrons with grip handle + a11y move actions"
```

---

### Task 5: Add the drag gesture + animation + haptics + persistence

Now make the grip handle draggable. This is the core. The pattern: a `Gesture.Pan()` on each row's handle drives an `activeIndex` and a `translateY` shared value; on each frame the other rows shift to open a gap; on release we compute the final order and persist.

**Files:**
- Modify: `components/SpaceSettings/DraggableChannelGroup.tsx`

- [ ] **Step 1: Add the animation + gesture imports**

At the top of `DraggableChannelGroup.tsx`, add:

```tsx
import { useMemo } from 'react'; // add to the existing 'react' import
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import * as Haptics from 'expo-haptics';
```

> **Review fixes baked in here (verified against installed packages):**
> - `SharedValue` is a NAMED export of `react-native-reanimated` 4.1.1 — `Animated.SharedValue` does NOT exist and would be a compile error. Import the type and use bare `SharedValue<...>` in `DraggableRowProps`.
> - `runOnJS` re-exported from `react-native-reanimated` is `@deprecated` in 4.1.1 → import it from `react-native-worklets` (its curried call shape `runOnJS(fn)(args)` is unchanged).

- [ ] **Step 2: Add shared values and the position helper inside the component**

Inside `DraggableChannelGroup`, before the `return`, add:

```tsx
  // Index currently being dragged (-1 = none), and the dragged row's finger offset.
  const activeIndex = useSharedValue(-1);
  const translateY = useSharedValue(0);
  // The order the rows are visually arranged in (indices into `channels`).
  // Initialised to identity; mutated live during a drag.
  const positions = useSharedValue<number[]>(channels.map((_, i) => i));

  // Keep positions in sync if the channel list changes between drags
  // (e.g. after a persist re-sync). Identity order is correct post-persist.
  React.useEffect(() => {
    positions.value = channels.map((_, i) => i);
  }, [channels, positions]);

  const persistOrder = useCallback(
    (visualOrder: number[]) => {
      const channelOrder = visualOrder.map((i) => channels[i].channelId);
      onReorder(groupIndex, channelOrder);
    },
    [channels, groupIndex, onReorder]
  );

  const haptic = useCallback((style: 'light' | 'medium' | 'select') => {
    if (style === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    else if (style === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    else Haptics.selectionAsync();
  }, []);
```

- [ ] **Step 3: Build a per-row draggable subcomponent**

Replace the `channels.map(...)` body in the `return` with a render of a new inner `<DraggableRow>` per channel, and define that subcomponent. The Pan gesture is attached ONLY to the handle via a nested `GestureDetector`. Add this inner component ABOVE `DraggableChannelGroup` (it receives shared values as props):

```tsx
interface DraggableRowProps {
  channel: Channel;
  index: number;
  count: number;
  styles: ReturnType<typeof createStyles>;
  theme: ReturnType<typeof useTheme>['theme'];
  activeIndex: SharedValue<number>;
  translateY: SharedValue<number>;
  positions: SharedValue<number[]>;
  // Same loose ref type as DraggableChannelGroupProps.scrollRef.
  // `.simultaneousWithExternalGesture` accepts a ref to any RNGH-aware
  // component; we cast at the call site to satisfy its overload.
  scrollRef: React.RefObject<unknown>;
  iconColor: string;
  iconBg: string | undefined;
  statusGlyphs: React.ReactNode;
  a11yActions: { name: string; label: string }[];
  onOpen: () => void;
  onAccessibilityAction: (e: AccessibilityActionEvent) => void;
  onSwapHaptic: () => void;
  onLiftHaptic: () => void;
  onDropHaptic: () => void;
  onPersist: (visualOrder: number[]) => void;
}

function DraggableRow({
  channel, index, count, styles, theme,
  activeIndex, translateY, positions, scrollRef,
  iconColor, iconBg, statusGlyphs, a11yActions,
  onOpen, onAccessibilityAction,
  onSwapHaptic, onLiftHaptic, onDropHaptic, onPersist,
}: DraggableRowProps) {
  const ROW = CHANNEL_ROW_HEIGHT;

  // Memoize the gesture so GestureDetector doesn't re-attach it on every
  // frame (positions.value changes re-render all rows during a drag). Shared
  // values are read by ref inside worklets, so no deps are captured.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(0) // handle is dedicated; activate on movement
        // Let a drag that starts on the handle win over the parent scroll
        // instead of being cancelled by it (the #1 Android "drag does nothing"
        // cause). Requires the RNGH ScrollView from Task 5 Step 5. The cast
        // narrows our loose RefObject<unknown> to the GestureRef shape RNGH
        // wants (React.RefObject<React.ComponentType | undefined>).
        .simultaneousWithExternalGesture(
          scrollRef as React.RefObject<React.ComponentType | undefined>
        )
        .onStart(() => {
          activeIndex.value = index;
          translateY.value = 0;
          runOnJS(onLiftHaptic)();
        })
        .onUpdate((e) => {
          translateY.value = e.translationY;
          // Current visual slot of this row:
          const currentSlot = positions.value.indexOf(index);
          const targetSlot = Math.max(
            0,
            Math.min(count - 1, currentSlot + Math.round(e.translationY / ROW))
          );
          if (targetSlot !== currentSlot) {
            const next = [...positions.value];
            next.splice(currentSlot, 1);
            next.splice(targetSlot, 0, index);
            positions.value = next;
            runOnJS(onSwapHaptic)();
          }
        })
        .onEnd(() => {
          const finalOrder = positions.value;
          runOnJS(onPersist)(finalOrder);
          runOnJS(onDropHaptic)();
        })
        .onFinalize(() => {
          activeIndex.value = -1;
          translateY.value = 0;
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, count, scrollRef]
  );

  const animatedStyle = useAnimatedStyle(() => {
    const isActive = activeIndex.value === index;
    const slot = positions.value.indexOf(index);
    if (isActive) {
      // Dragged row follows the finger from its ORIGINAL top.
      return {
        top: index * ROW,
        transform: [
          { translateY: translateY.value },
          { scale: withSpring(1.03) },
        ],
        zIndex: 999,
        elevation: 8,
        shadowColor: '#000',
        shadowOpacity: 0.3,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
        backgroundColor: theme.colors.surface4,
      };
    }
    // Non-dragged rows spring to their current slot.
    return {
      top: index * ROW,
      transform: [
        { translateY: withSpring((slot - index) * ROW, { damping: 20 }) },
        { scale: 1 },
      ],
      zIndex: 0,
      elevation: 0,
      shadowOpacity: 0,
      backgroundColor: theme.colors.surface3,
    };
  });

  return (
    <Animated.View
      style={[styles.row, animatedStyle]}
      accessibilityRole="none"
      accessibilityLabel={`Channel ${channel.channelName}`}
      accessibilityActions={a11yActions}
      onAccessibilityAction={onAccessibilityAction}
    >
      <TouchableOpacity
        style={[styles.iconButton, iconBg ? { backgroundColor: iconBg } : null]}
        onPress={onOpen}
      >
        <IconSymbol
          name={(channel.icon || 'hashtag') as IconSymbolName}
          size={14}
          color={iconColor}
          variant={channel.iconVariant ?? 'outline'}
        />
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.nameContainer}
        onPress={onOpen}
        accessibilityLabel={`Channel ${channel.channelName}. Double tap to open settings.`}
      >
        <Text style={styles.name}>{channel.channelName}</Text>
      </TouchableOpacity>
      {statusGlyphs}
      <GestureDetector gesture={pan}>
        {/* Row container owns the Move up/down a11y actions, so hide the
            handle from screen readers to avoid a redundant focus stop. */}
        <View style={styles.handle} importantForAccessibility="no-hide-descendants">
          <IconSymbol name="grip.vertical" size={16} color={theme.colors.textMuted} />
        </View>
      </GestureDetector>
    </Animated.View>
  );
}
```

- [ ] **Step 4: Render DraggableRow from the group, threading the shared values**

Replace the `channels.map(...)` inside `DraggableChannelGroup`'s `return` with:

```tsx
      {channels.map((channel, channelIndex) => {
        const a11yActions: { name: string; label: string }[] = [];
        if (channelIndex > 0) a11yActions.push({ name: 'moveUp', label: 'Move up' });
        if (channelIndex < channels.length - 1)
          a11yActions.push({ name: 'moveDown', label: 'Move down' });
        const color = resolveIconColor(channel.iconColor, theme.colors.textMuted);
        return (
          <DraggableRow
            key={channel.channelId}
            channel={channel}
            index={channelIndex}
            count={channels.length}
            styles={styles}
            theme={theme}
            activeIndex={activeIndex}
            translateY={translateY}
            positions={positions}
            scrollRef={scrollRef}
            iconColor={color}
            iconBg={channel.icon ? color + '20' : undefined}
            statusGlyphs={renderStatusGlyphs(channel)}
            a11yActions={a11yActions}
            onOpen={() => onOpenChannel(channel.channelId)}
            onAccessibilityAction={handleAccessibilityAction(channelIndex)}
            onLiftHaptic={() => haptic('light')}
            onSwapHaptic={() => haptic('select')}
            onDropHaptic={() => haptic('medium')}
            onPersist={persistOrder}
          />
        );
      })}
```

Remove the now-unused static row JSX from Task 3 (the non-animated `<View style={[styles.row, { top: ... }]}>` block) — `DraggableRow` replaces it entirely. Keep the outer `<View style={{ height: channels.length * CHANNEL_ROW_HEIGHT }}>` wrapper.

- [ ] **Step 5: Let the drag coexist with the parent ScrollView**

The Pan is on the handle only, so the row body and empty space still scroll. But a vertical pan starting on the handle can still be intercepted by the `ScrollView`. The `GHScrollView` import and `channelsScrollRef` were already added in Task 4 Step 1. Now (a) make the Channels-tab scroll container the RNGH one and (b) attach the ref so the gesture's `simultaneousWithExternalGesture` has something to reference.

In `renderChannelsTab` (`SpaceSettingsModal.tsx:1779`), replace the outer `<ScrollView ...>` / `</ScrollView>` tags with `<GHScrollView ref={channelsScrollRef} ...>` / `</GHScrollView>` — keep ALL existing props (`style`, `contentContainerStyle`, `showsVerticalScrollIndicator`, `keyboardShouldPersistTaps`), just add the `ref`. This makes RNGH aware of the scroll so the handle pan composes cleanly via the `.simultaneousWithExternalGesture(scrollRef)` in `DraggableRow`. Do NOT change any other `ScrollView` in the file — only the Channels tab's.

- [ ] **Step 6: Verify type-check + lint**

Run: `npx tsc --noEmit --jsx react-jsx --skipLibCheck`
Expected: no new errors.
Run: `yarn lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add components/SpaceSettings/DraggableChannelGroup.tsx components/SpaceSettingsModal.tsx
git commit -m "feat: drag-to-reorder channels within a group (handle + reanimated + haptics)"
```

---

### Task 6: Runtime verification (physical devices)

No automated tests — this is gesture-and-render behavior. Run the device test below. There is no unit-testable seam that meaningfully covers drag; attempting one would test the mock, not the gesture.

- [ ] **Step 1: Build + run on a physical ANDROID device first**

Use `.\.agents\scripts\dev-start-mobile.ps1` (or the emulator script). If native changed, rebuild via `.\.agents\scripts\build-app.ps1`. (Adding `react-native-gesture-handler`'s `ScrollView`/`GestureHandlerRootView` does NOT add native modules — no rebuild needed unless something else changed. Verify statically first per [[verify-statically-before-expensive-rebuilds]].)

- [ ] **Step 2: Walk the verification checklist**

- [ ] Owner → gear → Channels tab. Each channel row shows a **grip handle** on the trailing edge (no chevrons).
- [ ] **Android:** drag a channel by its grip handle → it lifts (scale + shadow), other rows part to open a gap, drop reorders. (If drag does NOTHING on Android, the BaseModal `GestureHandlerRootView` from Task 2 is missing/broken — check first.)
- [ ] Order persists after closing/reopening the modal; syncs to a second client (desktop).
- [ ] Drag does NOT scroll the list out from under you, and does NOT dismiss the modal sheet.
- [ ] Tap a row BODY (not the handle) → opens that channel's settings drawer (tap still works).
- [ ] Haptics: a tick on lift, a tick per position swap, a firmer tap on drop.
- [ ] VoiceOver (iOS) + TalkBack (Android): focus a row → "Move up"/"Move down" actions available; first row has no Move up, last row no Move down; invoking them reorders.
- [ ] iOS visual pass: lifted-row shadow/scale reads correctly; no z-fighting.
- [ ] Single-channel group: handle present, drag is a no-op (nothing to reorder), no crash.

- [ ] **Step 3: Report pass/fail per box.** Fix failures against the relevant task above; do not mark the source task done until all green.

---

## Self-Review

**Spec coverage** (against `2026-06-14-channel-drag-and-drop-reorder.md` verification list):
- "Drag reorders within group; persists + syncs" → Task 5 + Task 6.
- "Drag doesn't fight scroll / modal dismiss" → Task 5 Step 5 (RNGH ScrollView) + pre-verified PanResponder threshold; Task 6 checks.
- "Tap-to-open still works" → handle-scoped gesture (Task 5); Task 6 check.
- "Android drag works in modal" → Task 2; Task 6 check.
- "VoiceOver/TalkBack Move up/down" → Task 3 (actions) + Task 4 (wiring); Task 6 check.
- "Haptics lift/swap/drop" → Task 5 Step 2-3; Task 6 check.
- "Chevrons gone, move handlers kept" → Task 4 Step 3 (rows replaced) keeps `handleMoveChannelUp/Down` for a11y.
- "tsc + lint clean" → verify step in every task.

**Placeholder scan:** No TBD/TODO/"handle edge cases". Every code step shows full code. The one deliberate conditional ("delete unused styles if lint flags") has an explicit grep-first guard, not a vague instruction.

**Type consistency:** `CHANNEL_ROW_HEIGHT` (exported const) used in Task 3, 5. `positions`/`activeIndex`/`translateY` shared values defined in Task 5 Step 2, consumed by `DraggableRow` props in Step 3, threaded in Step 4 — names match. `onReorder(groupIndex, channelOrder)` signature matches `handleReorderChannels` (Task 4) and `persistOrder` (Task 5). `useReorderChannels` param shape `{ spaceId, groupIndex, channelOrder }` matches `hooks/chat/useChannelManagement.ts:592`.

**One known soft spot flagged for the implementer:** the `positions`-based reorder math (Task 5 Step 3 `onUpdate`) is the part most likely to need tuning on-device — specifically the gap-shift `withSpring` and the `Math.round(translationY / ROW)` slot calc. If rows jitter or the gap lags, that block is where to adjust (e.g. damping, or only recomputing the slot past a half-row threshold). This is expected gesture-tuning, not a design gap.

**Adversarial review applied (2026-06-17).** A fresh code-reviewer verified the plan against installed packages and the live `SpaceSettingsModal.tsx`. Fixes folded in:
- BLOCKER — `Animated.SharedValue<...>` doesn't exist in Reanimated 4.1.1 → import named `SharedValue` and use it bare (Task 5 Step 1 + `DraggableRowProps`).
- BLOCKER — `accessible={false}` on a row also carrying `accessibilityActions` removes it from the a11y tree, silently killing Move up/down → changed to `accessibilityRole="none"` + label, handle hidden via `importantForAccessibility="no-hide-descendants"` (Tasks 3 + 5).
- SHOULD-FIX — missing `simultaneousWithExternalGesture` (the source task's #1 Android failure mode) → `scrollRef` now threaded `SpaceSettingsModal → DraggableChannelGroup → DraggableRow`, gesture declares it (Tasks 4 + 5).
- SHOULD-FIX — `runOnJS` is `@deprecated` from reanimated in 4.1.1 → import from `react-native-worklets` (Task 5 Step 1).
- SHOULD-FIX — gesture object re-created every frame → wrapped in `useMemo` (Task 5 Step 3).
Verified-correct and left as-is: `activateAfterLongPress(0)` (real RNGH 2.28 method, `0` = activate on movement), array ops + SharedValue-array assignment inside worklets, the drag geometry (no double-count), and all cited line numbers/symbols.

---
*Last updated: 2026-06-17*
