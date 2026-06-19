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
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { composerBottomBusySV } from '@/services/ui/composerPanelVisible';

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
  /** Whether a soft keyboard is currently up. Lets the composer PRELOAD the
   *  panel in the keyboard's footprint (rendered behind where the OS draws the
   *  keyboard) so dismissing the keyboard reveals an already-painted panel. */
  keyboardVisible: boolean;
  /**
   * Animated height for the spacer/panel container under the pill. Includes
   * the resting bottom safe-area inset when nothing is open, and collapses
   * that inset as the keyboard/panel takes over the space.
   */
  spacerHeight: SharedValue<number>;
  /** UI-thread 1/0: whether the panel content should be painted. Drives the
   *  panel's opacity so it preloads behind a fully-up keyboard and hides in
   *  lockstep as the keyboard descends — no React-lagged peek. */
  panelVisibleSV: DerivedValue<number>;
  /** Show the panel: dismiss the keyboard, hold its footprint. */
  openPanel: () => void;
  /** Hide the panel (caller is responsible for refocusing the input). */
  closePanel: () => void;
  /** Toggle the panel. Opening hides the keyboard (keeping caret focus);
   *  closing brings the keyboard back without moving the pill. */
  togglePanel: () => void;
  /** Call when the input gains focus — collapses the panel without animation fight. */
  onInputFocus: () => void;
  /** Call when the in-panel search field gains focus — lifts the panel above the
   *  keyboard the search field summons so it stays visible. */
  onSearchFocus: () => void;
  /** Call when the in-panel search field loses focus — drops the lift. */
  onSearchBlur: () => void;
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
  // Set while closing the panel BY bringing the keyboard back. During this
  // window the spacer holds the panel footprint until the rising keyboard
  // catches up, so the pill never drops to the bottom and bounces back up.
  const closingSV = useSharedValue(0);
  // Whether the panel was opened while the keyboard was up (input focused). If
  // it was opened with NO keyboard (input unfocused), closing must NOT arm the
  // keyboard hand-off — there's no keyboard coming back, so the spacer should
  // collapse to 0 rather than hold the footprint forever (which leaves a gap).
  const openedWithKeyboardRef = useRef(false);
  // 1 while the in-panel search field is focused. Drives the panel "lift" so it
  // rides above the keyboard the search field summons (see spacer worklet).
  const searchFocusedSV = useSharedValue(0);
  // Keyboard up/down, flipped at animation start so the panel can be preloaded
  // in the keyboard's footprint and revealed when the keyboard dismisses.
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const setKeyboardVisibleJS = useCallback((v: boolean) => {
    setKeyboardVisible(v);
  }, []);

  // Capture the keyboard height whenever it's meaningfully open so the panel
  // can match it. We latch the height on settle and, once the keyboard is fully
  // up, end any in-progress close hand-off.
  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        // Track keyboard up/down so the panel can preload behind it.
        runOnJS(setKeyboardVisibleJS)(e.height > 0);
      },
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
          // Keyboard is up and covering the bottom — the hand-off is done; the
          // tab bar's own keyboard check now keeps it hidden.
          composerBottomBusySV.value = 0;
        } else {
          // Keyboard fully hidden — nothing to bridge to.
          closingSV.value = 0;
          // Release the bottom ONLY if the panel isn't holding it. (On a
          // panel-open dismiss the keyboard also settles at 0, but the panel now
          // owns the bottom and the bar must stay hidden.)
          if (panelOpenSV.value !== 1) composerBottomBusySV.value = 0;
        }
      },
    },
    [setKeyboardVisibleJS]
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
    // useReanimatedKeyboardAnimation().height is NEGATIVE-going (0 -> -kbHeight),
    // matching the library's own components which negate it. Flip the sign to
    // get the positive on-screen keyboard height (from the true screen bottom).
    const liveKeyboardHeight = Math.max(-keyboardHeight.value, 0);
    if (panelOpenSV.value === 1) {
      // Panel open: hold the last real keyboard height (the panel's footprint).
      // When the in-panel SEARCH field is focused, a keyboard rises over the
      // panel — ADD its live height so the whole panel rides up and stays
      // visible above the keyboard. Gated on the search-focus flag (not raw
      // keyboard height) so the keyboard DISMISS that happens during open
      // doesn't transiently inflate the panel.
      const searchLift = searchFocusedSV.value === 1 ? liveKeyboardHeight : 0;
      return Math.max(lastKeyboardHeight.value + searchLift, restingFootprint);
    }
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

  // Whether the emoji panel should be PAINTED (1) or hidden (0), on the UI
  // thread so it tracks the keyboard with no React lag. Painted when:
  //   - the panel is open; or
  //   - a keyboard is essentially fully up (preload behind it, so opening the
  //     panel reveals an already-painted grid).
  // As the keyboard DESCENDS to dismiss-to-idle (panel not open), it drops below
  // the threshold immediately, so the panel hides in lockstep with the slide —
  // no peek in the strip below the tab bar (which a lagged React flag caused).
  const panelVisibleSV = useDerivedValue<number>(() => {
    if (panelOpenSV.value === 1) return 1;
    const liveKeyboardHeight = Math.max(-keyboardHeight.value, 0);
    const kbTarget = lastKeyboardHeight.value;
    // "Essentially up" = within 90% of the last full height. Anything less means
    // the keyboard is rising-not-yet-there or descending — hide the preload.
    return kbTarget > 0 && liveKeyboardHeight >= kbTarget * 0.9 ? 1 : 0;
  });

  const openPanel = useCallback(() => {
    closingSV.value = 0;
    // The composer owns the bottom from now until the keyboard settles — keeps
    // the tab bar hidden across the whole panel↔keyboard hand-off (no flicker).
    composerBottomBusySV.value = 1;
    // Remember whether a keyboard was up at open time — drives the close path.
    openedWithKeyboardRef.current = KeyboardController.isVisible();
    panelOpenRef.current = true;
    panelOpenSV.value = 1;
    onVisibilityRef.current?.(true);
    setPanelOpen(true);
    // keepFocus keeps the caret + insertion point while hiding the keyboard.
    // The panel is already painted behind it, so the dismiss reveals it.
    KeyboardController.dismiss({ keepFocus: true });
  }, [panelOpenSV, closingSV]);

  const closePanel = useCallback(() => {
    // Hot path (every keystroke): bail if already closed.
    if (!panelOpenRef.current) return;
    closingSV.value = 0;
    // Plain close (no keyboard hand-off) — release the bottom immediately.
    composerBottomBusySV.value = 0;
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
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
      // No keyboard settle will fire to release the bottom — release it now.
      composerBottomBusySV.value = 0;
    }
    panelOpenRef.current = false;
    panelOpenSV.value = 0;
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
    onVisibilityRef.current?.(false);
    setPanelOpen(false);
  }, [panelOpenSV, closingSV]);

  // The in-panel search field gained/lost focus: lift the panel above the
  // keyboard it summons (or drop back). See the spacer worklet's search-lift.
  const onSearchFocus = useCallback(() => {
    searchFocusedSV.value = 1;
  }, [searchFocusedSV]);
  const onSearchBlur = useCallback(() => {
    searchFocusedSV.value = 0;
  }, [searchFocusedSV]);

  return {
    panelOpen,
    keyboardVisible,
    spacerHeight,
    panelVisibleSV,
    openPanel,
    closePanel,
    togglePanel,
    onInputFocus,
    onSearchFocus,
    onSearchBlur,
  };
}
