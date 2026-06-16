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
 * `height` of a `Reanimated.View` sitting under the pill. `panelHeight` is the
 * plain-JS pixel height to size the emoji panel's content.
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
  /** Static pixel height to lay the panel content out at (last keyboard height). */
  panelHeight: number;
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
// the very first panel-open before a real measurement lands.
const FALLBACK_KEYBOARD_HEIGHT = 290;

export function useComposerPanel(options: ComposerPanelOptions = {}): ComposerPanel {
  const { bottomInset = 0 } = options;
  const { height: keyboardHeight, progress: keyboardProgress } = useReanimatedKeyboardAnimation();
  // Last real keyboard height we've observed, kept on the UI thread for the
  // spacer worklet and mirrored to JS state for panel content sizing.
  const lastKeyboardHeight = useSharedValue(FALLBACK_KEYBOARD_HEIGHT);
  const [panelHeight, setPanelHeight] = useState(FALLBACK_KEYBOARD_HEIGHT);
  // panelOpen as a shared value so the spacer worklet can branch without a
  // JS round-trip; mirrored to React state for conditional rendering.
  const panelOpenSV = useSharedValue(0);
  const [panelOpen, setPanelOpen] = useState(false);
  const panelOpenRef = useRef(false);

  // Capture the keyboard height whenever it's meaningfully open so the panel
  // can match it. onMove fires continuously; we only latch the peak.
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

  // The spacer height: follow the live keyboard when the panel is closed,
  // otherwise hold the last keyboard height (panel footprint). The resting
  // bottom safe-area inset is added on top, and fades out (via keyboard
  // progress) as the keyboard/panel takes over so we don't double-count it.
  const spacerHeight = useDerivedValue(() => {
    if (panelOpenSV.value === 1) {
      // Panel fully open: just the keyboard footprint, no resting inset.
      return lastKeyboardHeight.value;
    }
    const kb = Math.max(keyboardHeight.value, 0);
    // progress goes 0 -> 1 as the keyboard appears; fade the resting inset out.
    const restingInset = bottomInset * (1 - Math.min(Math.max(keyboardProgress.value, 0), 1));
    return kb + restingInset;
  });

  const openPanel = useCallback(() => {
    // Snapshot the measured height for content layout before dismissing.
    setPanelHeight(Math.round(lastKeyboardHeight.value) || FALLBACK_KEYBOARD_HEIGHT);
    panelOpenRef.current = true;
    panelOpenSV.value = 1;
    setPanelOpen(true);
    Keyboard.dismiss();
  }, [lastKeyboardHeight, panelOpenSV]);

  const closePanel = useCallback(() => {
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

  // When the input refocuses (keyboard comes back), make sure the panel flag
  // is cleared so the spacer switches back to following the keyboard.
  const onInputFocus = useCallback(() => {
    if (panelOpenRef.current) {
      panelOpenRef.current = false;
      panelOpenSV.value = 0;
      setPanelOpen(false);
    }
  }, [panelOpenSV]);

  return {
    panelOpen,
    spacerHeight,
    panelHeight,
    openPanel,
    closePanel,
    togglePanel,
    onInputFocus,
  };
}
