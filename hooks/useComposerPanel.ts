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
   * Resting chrome height (the bottom tab bar's stable height, `54 + insets.bottom`)
   * that the composer sits above when nothing is open.
   *
   * The composer overlay sits at `bottom: 0`, so the spacer is the SINGLE owner
   * of the pill's on-screen position. The spacer holds `max(liveKeyboard,
   * restingChromeHeight + bottomInset)`: at rest it equals the chrome height (the
   * pill floats above the tab bar); as the keyboard rises past it, the live
   * keyboard takes over (the keyboard covers the tab bar). Because position has
   * one owner on the UI thread, the keyboard <-> panel swap can't desync.
   *
   * Pass the RAW tab-bar height here (NOT zeroed while the panel is open):
   * `useBottomTabBarHeight()` is stable across the panel's open/close, and hiding
   * the tab bar is handled by the keyboard/panel footprint exceeding the resting
   * chrome, not by changing this value.
   */
  restingChromeHeight?: number;
  /**
   * Called synchronously whenever the panel opens (true) or closes (false).
   * Fired inside the open/close actions (not via an effect) so dependent UI —
   * e.g. hiding the bottom tab bar — reacts in the same tick with no extra
   * render-cycle latency.
   */
  onPanelVisibilityChange?: (open: boolean) => void;
}

/**
 * Encapsulates the keyboard <-> custom-panel choreography for the message
 * composer: the emoji panel opens downward, replacing the soft keyboard in the
 * same footprint.
 *
 * The composer overlay is anchored at the screen bottom (`bottom: 0`), so the
 * single animated spacer below the input pill is the SOLE owner of the pill's
 * on-screen vertical position. That spacer's height (`max(liveKeyboard,
 * restingChrome)`) drives all of:
 *   - resting — it holds the tab-bar clearance (`restingChromeHeight`) so the
 *     pill floats above the tab bar; and
 *   - keyboard avoidance — when the panel is closed it follows the live keyboard
 *     height, so the pill rides up with the keyboard; and
 *   - the emoji panel — when the panel is open it holds the LAST real keyboard
 *     height (captured while the keyboard was up) so dismissing the soft
 *     keyboard and revealing the panel happens in the same vertical space with
 *     no layout jump.
 *
 * Because position has ONE owner on the UI thread (not a spacer height plus a
 * React-driven overlay offset), the keyboard <-> panel swap has nothing to
 * desync. Returned `spacerHeight` is a Reanimated SharedValue applied as the
 * `height` of a `Reanimated.View` sitting under the pill.
 */
export interface ComposerPanel {
  /** Whether the custom (emoji) panel is currently shown. */
  panelOpen: boolean;
  /**
   * Whether the panel's HEAVY content (the emoji grid) should mount yet. Goes
   * false the instant the panel opens and true once the keyboard-dismiss has
   * settled (or, when the panel is opened with no keyboard up, on the next
   * tick). Lets the caller paint the cheap panel chrome immediately so the panel
   * slides in solid, then mount the ~120-node grid a beat later — hidden behind
   * the keyboard as it slides away, so there's no empty gap and the heavy mount
   * never competes with the open animation's frames. Gated on a real settle
   * event, NOT a frame/time guess.
   */
  panelContentReady: boolean;
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
  const { bottomInset = 0, restingChromeHeight = 0, onPanelVisibilityChange } = options;
  // Keep the latest callback in a ref so the open/close callbacks don't need it
  // in their dep arrays (which would re-create them every render).
  const onVisibilityRef = useRef(onPanelVisibilityChange);
  onVisibilityRef.current = onPanelVisibilityChange;
  const { height: keyboardHeight } = useReanimatedKeyboardAnimation();
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
  // Gates the heavy panel content (emoji grid). False until the keyboard-dismiss
  // settles (or the next tick when opening with no keyboard up), so the cheap
  // chrome paints immediately and the grid mounts a beat later, off the open
  // animation's frames. Read the ref synchronously inside the settle worklet's
  // JS hop; the state drives the actual render.
  const [panelContentReady, setPanelContentReady] = useState(false);
  const panelContentReadyRef = useRef(false);
  const markPanelContentReady = useCallback(() => {
    // Only arm content once the panel is actually open (guards a stray keyboard
    // settle that isn't a panel-open).
    if (!panelOpenRef.current || panelContentReadyRef.current) return;
    panelContentReadyRef.current = true;
    setPanelContentReady(true);
  }, []);
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
          // If we got here because the panel opened (dismissing the keyboard to
          // make room), the dismiss is now complete — mount the heavy grid.
          runOnJS(markPanelContentReady)();
        }
      },
    },
    [markPanelContentReady]
  );

  // The spacer height — the SINGLE owner of the composer pill's on-screen
  // position. The overlay sits at `bottom: 0`, so the spacer alone decides how
  // far the pill floats above the screen bottom. It holds the larger of:
  //   - the resting chrome the pill floats above (tab bar + safe inset), or
  //   - the live keyboard height (which, edge-to-edge, is measured from the true
  //     screen bottom and covers the tab bar's zone).
  // The keyboard rising past the resting chrome, and the panel taking the last
  // keyboard height, are the SAME quantity resolved by one `Math.max` on the UI
  // thread — so the keyboard <-> panel swap has nothing to desync (no second,
  // React-driven position owner). The tab bar is "hidden" simply by the
  // keyboard/panel footprint exceeding the resting chrome; no value flips.
  const spacerHeight = useDerivedValue(() => {
    const restingFootprint = restingChromeHeight + bottomInset;
    if (panelOpenSV.value === 1) {
      // Panel open: hold the last real keyboard height (it reaches the screen
      // bottom). Never drop below the resting chrome.
      return Math.max(lastKeyboardHeight.value, restingFootprint);
    }
    // useReanimatedKeyboardAnimation().height is NEGATIVE-going (0 -> -kbHeight),
    // matching the library's own components which negate it. Flip the sign to
    // get the positive on-screen keyboard height (from the true screen bottom).
    const liveKeyboardHeight = Math.max(-keyboardHeight.value, 0);
    if (closingSV.value === 1) {
      // Closing the panel by summoning the keyboard back: hold the panel
      // footprint and let the RISING keyboard meet it (Math.max) so the pill
      // stays put — seamless once the keyboard catches up.
      return Math.max(liveKeyboardHeight, lastKeyboardHeight.value, restingFootprint);
    }
    // Resting / keyboard following: the larger of the live keyboard and the
    // resting chrome. As the keyboard rises past the chrome it takes over; as it
    // falls it hands back to the chrome — a continuous swap, no progress fade.
    return Math.max(liveKeyboardHeight, restingFootprint);
  });

  const openPanel = useCallback(() => {
    // Any prior close hand-off is moot once we're opening again.
    closingSV.value = 0;
    // Remember whether a keyboard was up at open time — drives the close path.
    const keyboardWasUp = KeyboardController.isVisible();
    openedWithKeyboardRef.current = keyboardWasUp;
    panelOpenRef.current = true;
    panelOpenSV.value = 1;
    // Defer the heavy grid: paint the cheap chrome now, mount the grid once the
    // keyboard-dismiss settles (handled in the keyboard onEnd handler).
    panelContentReadyRef.current = false;
    setPanelContentReady(false);
    onVisibilityRef.current?.(true);
    setPanelOpen(true);
    if (keyboardWasUp) {
      // keepFocus: true hides the soft keyboard but leaves the TextInput focused,
      // so the blinking caret stays visible and emojis insert at the cursor.
      // (RN's Keyboard.dismiss() always blurs, which hides the caret.) The grid
      // mounts when this dismiss settles (keyboard onEnd, height 0).
      KeyboardController.dismiss({ keepFocus: true });
    } else {
      // No keyboard up → no dismiss settle is coming. Mount the grid on the next
      // frame so the chrome still paints first, then the grid fills in.
      requestAnimationFrame(markPanelContentReady);
    }
  }, [panelOpenSV, closingSV, markPanelContentReady]);

  const closePanel = useCallback(() => {
    // Cheap to call on hot paths (e.g. every keystroke): bail if already closed
    // so we don't write the shared value or schedule a no-op state update.
    if (!panelOpenRef.current) return;
    // Plain close (no keyboard hand-off — e.g. hardware-keyboard typing): clear
    // any closing flag so the spacer follows the live keyboard directly.
    closingSV.value = 0;
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
    panelContentReadyRef.current = false;
    setPanelContentReady(false);
    onVisibilityRef.current?.(false);
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
    panelContentReadyRef.current = false;
    setPanelContentReady(false);
    onVisibilityRef.current?.(false);
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
    panelContentReadyRef.current = false;
    setPanelContentReady(false);
    onVisibilityRef.current?.(false);
    setPanelOpen(false);
  }, [panelOpenSV, closingSV]);

  return {
    panelOpen,
    panelContentReady,
    spacerHeight,
    openPanel,
    closePanel,
    togglePanel,
    onInputFocus,
  };
}
