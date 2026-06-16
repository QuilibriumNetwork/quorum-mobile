import { useCallback, useRef, useState } from 'react';
import {
  KeyboardController,
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import {
  runOnJS,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

export interface ComposerPanelOptions {
  /** Bottom safe-area inset to leave below the pill when nothing is open. */
  bottomInset?: number;
  /**
   * Height of any chrome (e.g. a bottom tab bar) the composer already sits
   * above. The keyboard height reported by the OS is measured from the true
   * bottom of the screen, but the composer's layout origin is this many pixels
   * higher, so we subtract it from the keyboard footprint to avoid overshooting
   * the top of the keyboard.
   */
  bottomChromeHeight?: number;
}

/**
 * Encapsulates the keyboard <-> custom-panel choreography for the message
 * composer: the emoji panel opens downward, replacing the soft keyboard in the
 * same footprint.
 *
 * The composer renders a single animated spacer below the input pill. That
 * spacer's height drives both:
 *   - keyboard avoidance — when the panel is closed it follows the live
 *     keyboard height, so the pill rides up with the keyboard; and
 *   - the emoji panel — when the panel is open it holds the LAST real keyboard
 *     height (captured while the keyboard was up) so dismissing the soft
 *     keyboard and revealing the panel happens in the same vertical space with
 *     no layout jump.
 *
 * Returned `spacerHeight` is a Reanimated SharedValue to be applied as the
 * `height` of a `Reanimated.View` sitting under the pill.
 */
export interface ComposerPanel {
  /** Whether the custom (emoji) panel is currently shown. */
  panelOpen: boolean;
  /**
   * Animated height for the spacer/panel container under the pill. Includes
   * the resting bottom safe-area inset when nothing is open, and collapses
   * that inset as the keyboard/panel takes over the space.
   */
  spacerHeight: SharedValue<number>;
  /** Show the panel: dismiss the keyboard, hold its footprint. */
  openPanel: () => void;
  /** Hide the panel (caller is responsible for refocusing the input). */
  closePanel: () => void;
  /** Toggle the panel. Opening hides the keyboard (keeping caret focus);
   *  closing brings the keyboard back without moving the pill. */
  togglePanel: () => void;
  /** Call when the input gains focus — collapses the panel without animation fight. */
  onInputFocus: () => void;
}

// Sensible fallback before we've ever seen the keyboard (first open on a fresh
// launch). Close to a typical Android/iOS keyboard height; it's only used for
// the very first panel-open before a real measurement lands. Cached at module
// scope so that after the first time the keyboard is shown in a session, every
// subsequent cold panel-open (even on a freshly mounted composer) starts from
// the real measured height instead of this constant.
const FALLBACK_KEYBOARD_HEIGHT = 290;
let lastSessionKeyboardHeight = FALLBACK_KEYBOARD_HEIGHT;
function rememberSessionKeyboardHeight(height: number) {
  if (height > 0) lastSessionKeyboardHeight = height;
}

export function useComposerPanel(options: ComposerPanelOptions = {}): ComposerPanel {
  const { bottomInset = 0, bottomChromeHeight = 0 } = options;
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  // Last real keyboard height we've observed, kept on the UI thread for the
  // spacer worklet. Seeded from the session cache so a panel opened before this
  // composer ever showed the keyboard still uses a real height when available.
  const lastKeyboardHeight = useSharedValue(lastSessionKeyboardHeight);
  // panelOpen as a shared value so the spacer worklet can branch without a
  // JS round-trip; mirrored to React state for conditional rendering and to a
  // ref for synchronous reads inside callbacks (avoids stale closures).
  const panelOpenSV = useSharedValue(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(false);
  // Set while closing the panel BY bringing the keyboard back. During this
  // window the spacer holds the panel footprint until the rising keyboard
  // catches up, so the pill never drops to the bottom and bounces back up.
  const closingSV = useSharedValue(0);
  // Whether the panel was opened while the keyboard was up (input focused). If
  // it was opened with NO keyboard (input unfocused), closing must NOT arm the
  // keyboard hand-off — there's no keyboard coming back, so the spacer should
  // collapse to 0 rather than hold the footprint forever (which leaves a gap).
  const openedWithKeyboardRef = useRef(false);

  // Capture the keyboard height whenever it's meaningfully open so the panel
  // can match it. We latch the height on settle and, once the keyboard is fully
  // up, end any in-progress close hand-off.
  useKeyboardHandler(
    {
      onEnd: (e) => {
        'worklet';
        if (e.height > 0) {
          lastKeyboardHeight.value = e.height;
          // The keyboard has finished appearing — the close hand-off is done,
          // so the spacer can resume plainly following the live keyboard.
          closingSV.value = 0;
          // Mirror the settled height to the JS-thread module cache so a future
          // composer mount can seed from it. Hopping to JS only on settle (not
          // every onMove frame) keeps this cheap, and avoids reading a shared
          // value during render (which Reanimated strict mode warns about).
          runOnJS(rememberSessionKeyboardHeight)(e.height);
        } else {
          // Keyboard fully hidden — nothing is bridging to, clear the flag.
          closingSV.value = 0;
        }
      },
    },
    []
  );

  // The spacer height: follow the live keyboard when the panel is closed,
  // otherwise hold the last keyboard height (panel footprint). In both cases we
  // subtract the bottom chrome the composer already sits above, so the pill
  // lands exactly on top of the keyboard/panel rather than overshooting it. The
  // resting bottom inset is added when nothing is open and fades out (via
  // keyboard progress) as the keyboard/panel takes over.
  const spacerHeight = useDerivedValue(() => {
    if (panelOpenSV.value === 1) {
      // Panel fully open: the tab bar is hidden, so the panel takes the FULL
      // keyboard height (no chrome subtraction) and reaches the screen bottom.
      // Not subtracting bottomChromeHeight here also makes open instant — the
      // height doesn't depend on the store round-trip that zeroes the chrome.
      return Math.max(lastKeyboardHeight.value, 0);
    }
    // useReanimatedKeyboardAnimation().height is NEGATIVE-going (0 -> -kbHeight),
    // matching the library's own components which negate it. Flip the sign to
    // get the positive on-screen keyboard height.
    const liveKeyboardHeight = -keyboardHeight.value;
    const kb = Math.max(liveKeyboardHeight - bottomChromeHeight, 0);
    if (closingSV.value === 1) {
      // Closing the panel by summoning the keyboard back. The tab bar reappears
      // on close, so the target is the chrome-subtracted keyboard footprint.
      // Hold it and let the RISING keyboard meet it (Math.max) so the pill stays
      // put — seamless once the keyboard catches up.
      const target = Math.max(lastKeyboardHeight.value - bottomChromeHeight, 0);
      return Math.max(kb, target);
    }
    // progress goes 0 -> 1 as the keyboard appears; fade the resting inset out.
    const progress = Math.min(Math.max(keyboardProgress.value, 0), 1);
    return kb + bottomInset * (1 - progress);
  });

  const openPanel = useCallback(() => {
    // Any prior close hand-off is moot once we're opening again.
    closingSV.value = 0;
    // Remember whether a keyboard was up at open time — drives the close path.
    openedWithKeyboardRef.current = KeyboardController.isVisible();
    panelOpenRef.current = true;
    panelOpenSV.value = 1;
    setPanelOpen(true);
    // keepFocus: true hides the soft keyboard but leaves the TextInput focused,
    // so the blinking caret stays visible and emojis insert at the cursor.
    // (RN's Keyboard.dismiss() always blurs, which hides the caret.)
    KeyboardController.dismiss({ keepFocus: true });
  }, [panelOpenSV, closingSV]);

  const closePanel = useCallback(() => {
    // Cheap to call on hot paths (e.g. every keystroke): bail if already closed
    // so we don't write the shared value or schedule a no-op state update.
    if (!panelOpenRef.current) return;
    // Plain close (no keyboard hand-off — e.g. hardware-keyboard typing): clear
    // any closing flag so the spacer follows the live keyboard directly.
    closingSV.value = 0;
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
    setPanelOpen(false);
  }, [panelOpenSV, closingSV]);

  // Close the panel AND bring the keyboard back, holding the pill's position
  // throughout (no drop-and-bounce). Order matters: arm the closing hand-off
  // and summon the keyboard BEFORE flipping panelOpen, so the spacer never
  // sees the "panel closed, keyboard still down" state with a 0 footprint.
  // setFocusTo('current') re-opens the keyboard on the still-focused input
  // (the panel kept focus via dismiss({ keepFocus: true })), which a plain
  // .focus() on an already-focused input would not reliably do.
  const closePanelAndRestoreKeyboard = useCallback(() => {
    if (!panelOpenRef.current) return;
    if (openedWithKeyboardRef.current) {
      // Opened with the keyboard up: bring it back and hold the footprint
      // during the hand-off so the pill doesn't drop-and-bounce.
      closingSV.value = 1;
      KeyboardController.setFocusTo('current');
    } else {
      // Opened with NO keyboard: nothing is coming back, so just collapse the
      // spacer (don't arm the hand-off — that would leave a permanent gap).
      closingSV.value = 0;
    }
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
    setPanelOpen(false);
  }, [panelOpenSV, closingSV]);

  const togglePanel = useCallback(() => {
    if (panelOpenRef.current) {
      closePanelAndRestoreKeyboard();
    } else {
      openPanel();
    }
  }, [openPanel, closePanelAndRestoreKeyboard]);

  // When the input gains focus (e.g. user taps the text field) while the panel
  // is open, the keyboard is on its way back — arm the same closing hand-off so
  // the pill holds position instead of dropping and bouncing.
  const onInputFocus = useCallback(() => {
    if (!panelOpenRef.current) return;
    closingSV.value = 1;
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
    setPanelOpen(false);
  }, [panelOpenSV, closingSV]);

  return {
    panelOpen,
    spacerHeight,
    openPanel,
    closePanel,
    togglePanel,
    onInputFocus,
  };
}
