import { useCallback, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import {
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import {
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
  /** Toggle the panel. When opening, dismisses the keyboard. */
  togglePanel: (refocus: () => void) => void;
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

export function useComposerPanel(options: ComposerPanelOptions = {}): ComposerPanel {
  const { bottomInset = 0, bottomChromeHeight = 0 } = options;
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  // Last real keyboard height we've observed, kept on the UI thread for the
  // spacer worklet. Seeded from the session cache so a panel opened before this
  // composer ever showed the keyboard still uses a real height when available.
  const lastKeyboardHeight = useSharedValue(lastSessionKeyboardHeight);
  // bottomChromeHeight as a shared value so the worklet picks up changes
  // (rotation, tab-bar show/hide) without a stale closure.
  const chromeHeight = useSharedValue(bottomChromeHeight);
  chromeHeight.value = bottomChromeHeight;
  const restingInset = useSharedValue(bottomInset);
  restingInset.value = bottomInset;
  // panelOpen as a shared value so the spacer worklet can branch without a
  // JS round-trip; mirrored to React state for conditional rendering and to a
  // ref for synchronous reads inside callbacks (avoids stale closures).
  const panelOpenSV = useSharedValue(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(false);

  // Capture the keyboard height whenever it's meaningfully open so the panel
  // can match it. onMove fires continuously; we latch the height and also
  // mirror it to the module-level session cache for future cold opens.
  useKeyboardHandler(
    {
      onMove: (e) => {
        'worklet';
        if (e.height > 0) {
          lastKeyboardHeight.value = e.height;
        }
      },
      onEnd: (e) => {
        'worklet';
        if (e.height > 0) {
          lastKeyboardHeight.value = e.height;
        }
      },
    },
    []
  );

  // Keep the module-level session cache in sync from JS so a future composer
  // mount seeds from the real height. Reading a SharedValue.value from the JS
  // thread is allowed; this runs on render, which is cheap and good enough.
  if (lastKeyboardHeight.value > 0) {
    lastSessionKeyboardHeight = lastKeyboardHeight.value;
  }

  // The spacer height: follow the live keyboard when the panel is closed,
  // otherwise hold the last keyboard height (panel footprint). In both cases we
  // subtract the bottom chrome the composer already sits above, so the pill
  // lands exactly on top of the keyboard/panel rather than overshooting it. The
  // resting bottom inset is added when nothing is open and fades out (via
  // keyboard progress) as the keyboard/panel takes over.
  const spacerHeight = useDerivedValue(() => {
    if (panelOpenSV.value === 1) {
      // Panel fully open: the keyboard footprint minus the chrome we sit above.
      return Math.max(lastKeyboardHeight.value - chromeHeight.value, 0);
    }
    const kb = Math.max(keyboardHeight.value - chromeHeight.value, 0);
    // progress goes 0 -> 1 as the keyboard appears; fade the resting inset out.
    const progress = Math.min(Math.max(keyboardProgress.value, 0), 1);
    return kb + restingInset.value * (1 - progress);
  });

  const openPanel = useCallback(() => {
    panelOpenRef.current = true;
    panelOpenSV.value = 1;
    setPanelOpen(true);
    Keyboard.dismiss();
  }, [panelOpenSV]);

  const closePanel = useCallback(() => {
    // Cheap to call on hot paths (e.g. every keystroke): bail if already closed
    // so we don't write the shared value or schedule a no-op state update.
    if (!panelOpenRef.current) return;
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
    setPanelOpen(false);
  }, [panelOpenSV]);

  const togglePanel = useCallback(
    (refocus: () => void) => {
      if (panelOpenRef.current) {
        closePanel();
        refocus();
      } else {
        openPanel();
      }
    },
    [openPanel, closePanel]
  );

  // When the input refocuses (keyboard comes back), make sure the panel is
  // closed so the spacer switches back to following the keyboard. closePanel
  // already no-ops when the panel isn't open.
  const onInputFocus = closePanel;

  return {
    panelOpen,
    spacerHeight,
    openPanel,
    closePanel,
    togglePanel,
    onInputFocus,
  };
}
