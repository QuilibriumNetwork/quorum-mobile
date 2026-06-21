/**
 * composerFootprintSV — module-scope Reanimated shared value holding the chat
 * composer's MEASURED on-screen footprint (the pill plus any reply/edit banner
 * and attachment preview — everything that sits ABOVE the keyboard).
 *
 * Why it exists: when the keyboard is open, KeyboardChatScrollView lifts the
 * list by `max(blankSpace, keyboardHeight + extraContentPadding)`. With no extra
 * padding the keyboard height alone wins, so the list clears the KEYBOARD but
 * NOT the composer pill sitting on top of it — the newest message gets cut by
 * the composer's height. Feeding this footprint as `extraContentPadding` makes
 * the lift clear `keyboard + composer`, so the last message rests just above the
 * pill. Because the composer's height VARIES (single line, wrapped multi-line,
 * image preview, reply banner), it must be measured, not a constant.
 *
 * Why a module-scope shared value (not a store + React state): the producer
 * (MessageInput, deep in a chat screen) and the consumer (the scroll component
 * inside MessagesList, a sibling) have no shared provider, and — critically —
 * the consumer reads it on the UI thread (it's fed straight into a keyboard
 * worklet), so it must NEVER round-trip through a React re-render (that caused
 * the JS-thread-starving render storm in the earlier hand-rolled attempts).
 * `makeMutable` mirrors the existing `composerBottomBusySV` pattern in
 * `composerPanelVisible.ts`.
 */

import { makeMutable, type SharedValue } from 'react-native-reanimated';

// Seeded with a single-line pill's approximate height so the first lift before
// onLayout reports is already roughly right (matches ChatBottomChrome's
// COMPOSER_RESTING_HEIGHT).
export const composerFootprintSV: SharedValue<number> = makeMutable(60);

/**
 * composerPanelFootprintSV — the height the EMOJI PANEL occupies below the pill
 * while it is open (0 when closed). Published by `useComposerPanel`.
 *
 * Needed because the emoji panel is NOT the soft keyboard: tapping the emoji
 * button dismisses the keyboard and shows the panel in its place, so the
 * composer rides up over the panel but KeyboardChatScrollView (which only knows
 * about the keyboard) sees the keyboard go to 0 and would drop the list, hiding
 * the newest message behind the panel. The chat list adds this to
 * `extraContentPadding` so the lift clears `panel + pill` when the panel is open,
 * mirroring how it clears `keyboard + pill` when the keyboard is up.
 */
export const composerPanelFootprintSV: SharedValue<number> = makeMutable(0);

/**
 * composerListFreezeSV — `true` while the emoji panel is open (keyboard down,
 * panel showing). Fed to KeyboardChatScrollView's `freeze` prop.
 *
 * Why: tapping the emoji button DISMISSES the keyboard to reveal the panel. From
 * the keyboard library's point of view that's just a keyboard CLOSE, so its
 * onMove handler actively `scrollTo`s the list down to follow the descending
 * keyboard — the panel is replacing that space, so the list shouldn't move at
 * all. `freeze` is the library's purpose-built switch for exactly this ("useful
 * when dismissing the keyboard to open a bottom sheet — prevents visual
 * disruption while the sheet is visible"). It suppresses the keyboard-driven
 * AND extra-padding-driven auto-scroll while still letting the scrollable range
 * (contentInset) grow for the panel, so the list holds position through the swap.
 * Set true the instant the panel opens (before the dismiss starts) and false the
 * instant it closes, so a returning keyboard is handled normally.
 */
export const composerListFreezeSV: SharedValue<boolean> = makeMutable(false);

/**
 * modalListFreezeSV — `true` while a bottom-sheet modal that dismisses the
 * keyboard is open OVER the chat (e.g. the user-profile sheet). Same purpose as
 * composerListFreezeSV but owned by a different producer, so the two must not
 * clobber each other's boolean. ChatKeyboardScrollView feeds `freeze` the OR of
 * both. Opening such a modal while the composer is focused dismisses the
 * keyboard; without the freeze the keyboard-synced list would chase the
 * descending keyboard down and leave the chat scrolled to a new position after
 * the modal closes.
 */
export const modalListFreezeSV: SharedValue<boolean> = makeMutable(false);
