/**
 * ChatKeyboardScrollView — the scroll container the chat MessagesList renders
 * through (via FlashList's `renderScrollComponent`). It wraps the keyboard
 * library's purpose-built `KeyboardChatScrollView`, which lifts the list content
 * in lockstep with the keyboard on the UI thread (smooth, 60/120fps, identical
 * on iOS and Android) so the newest messages rise WITH the keyboard instead of
 * being hidden behind it.
 *
 * Why this and not a hand-rolled translate / padding-on-keyboard-event: every
 * hand-rolled attempt either lagged (React-state padding races the keyboard) or
 * stormed (per-frame re-renders of the heavy list). This component does the
 * lift natively on the UI thread with zero React re-renders. See
 * `.agents/tasks/2026-06-19-keyboard-synced-chat-list-scroll.md` for the full
 * decision log.
 *
 * Integration notes (from the v1.21.11 type defs):
 * - `keyboardLiftBehavior="always"` — bottom messages always lift with the
 *   keyboard (Telegram/WhatsApp). The behaviour we want.
 * - `blankSpace` (SharedValue) — a minimum inset floor. Total bottom padding is
 *   `max(blankSpace, keyboardPadding + extraContentPadding)`, so the keyboard
 *   "absorbs into" the resting composer+tab-bar clearance rather than adding on
 *   top of it (this is what stops the over-lift the hand-rolled version had).
 * - `extraContentPadding` (SharedValue) — extra room from non-keyboard growth,
 *   i.e. the composer growing to multi-line / showing an image / reply banner.
 * - `inverted={false}` — our list renders oldest→newest with
 *   `startRenderingFromBottom`, it is NOT an inverted list.
 * - Do NOT also wrap the list in KeyboardAvoidingView/KeyboardAwareScrollView —
 *   nesting scroll solutions conflicts. `renderScrollComponent` is the path.
 */

import React, { forwardRef } from 'react';
import type { ScrollViewProps } from 'react-native';
import { KeyboardChatScrollView } from 'react-native-keyboard-controller';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';
import { composerFootprintSV, composerPanelFootprintSV, composerListFreezeSV } from '@/services/ui/composerFootprint';

export interface ChatKeyboardScrollViewExtraProps {
  /** Minimum bottom-inset floor (resting composer + tab-bar clearance). The
   *  keyboard absorbs into this rather than adding to it. */
  blankSpace?: SharedValue<number>;
  /** Extra padding from the composer growing (multi-line / image / reply). */
  extraContentPadding?: SharedValue<number>;
  /** Fires when the effective content inset changes — used to compute a correct
   *  scrollToEnd target while the keyboard is open (Android doesn't reflect the
   *  synthetic inset in onScroll). */
  onContentInsetChange?: (insets: { top: number; bottom: number }) => void;
}

type Props = ScrollViewProps & ChatKeyboardScrollViewExtraProps;

export const ChatKeyboardScrollView = forwardRef<any, Props>(
  ({ blankSpace, extraContentPadding, onContentInsetChange, ...props }, ref) => {
    // The non-keyboard padding the list must clear above the keyboard:
    //   composerFootprintSV       — the measured pill (+ reply/edit banner,
    //                               image preview); makes the keyboard-open lift
    //                               clear `keyboard + pill`, not just `keyboard`.
    //   composerPanelFootprintSV  — the emoji panel's below-pill height while the
    //                               panel is open (0 otherwise). The panel is not
    //                               the keyboard, so when it's open the library's
    //                               own keyboard lift is 0; adding the panel
    //                               footprint here makes the list clear
    //                               `panel + pill` so the newest message stays
    //                               visible above the panel.
    // A caller-provided extraContentPadding wins if given.
    const composerExtra = useDerivedValue(
      () => composerFootprintSV.value + composerPanelFootprintSV.value,
    );
    return (
      <KeyboardChatScrollView
        ref={ref}
        inverted={false}
        keyboardLiftBehavior="always"
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        blankSpace={blankSpace}
        extraContentPadding={extraContentPadding ?? composerExtra}
        // Freeze the keyboard-driven auto-scroll while the emoji panel is open:
        // opening the panel dismisses the keyboard, which the library would
        // otherwise chase by scrolling the list down (the panel replaces that
        // space, so the list must hold). The scrollable range still grows for the
        // panel via contentInset (not gated by freeze). See composerListFreezeSV.
        freeze={composerListFreezeSV}
        onContentInsetChange={onContentInsetChange}
        {...props}
      />
    );
  },
);

ChatKeyboardScrollView.displayName = 'ChatKeyboardScrollView';
