/**
 * ChatBottomChrome — shared bottom-of-chat layout for SpaceChatArea + DMChatArea.
 *
 * Both chat screens place their message list full-screen and float the composer
 * over the bottom so messages scroll behind it (Telegram-style), with a fade
 * that dissolves messages into the chat background as they reach the composer +
 * tab bar zone. That layout (overlay positioning, gradient, magic numbers) used
 * to be duplicated in both files and drifted (e.g. the DM screen kept a stale
 * container paddingBottom). This component is the single source of truth.
 *
 * Usage:
 *   const listBottomInset = useChatListBottomInset(tabBarHeight);
 *   ...
 *   <MessagesList bottomInset={listBottomInset} ... />
 *   <ChatBottomChrome tabBarHeight={tabBarHeight} surfaceColor={theme.colors.surface1}>
 *     <MessageInput ... />   // or the read-only banner
 *   </ChatBottomChrome>
 */

import { withAlpha } from '@/theme/skins/mergeSkin';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View } from 'react-native';

// Approximate resting height of the single-line composer pill (incl. its
// padding + margin). Used to pad the list bottom and size the fade.
const COMPOSER_RESTING_HEIGHT = 60;

// Breathing room above the composer so the newest message doesn't sit flush
// against the pill. Pads the list bottom only — deliberately NOT the fade height.
const LAST_MESSAGE_GAP = 12;

// Fade distance ABOVE the composer top. Kept at 0 so the gradient STARTS at the
// composer top and never dims messages sitting above the composer (any lead here
// visibly greys the last message line — reported + reverted). The fade covers
// only the composer → tab-bar zone; everything above the composer stays crisp.
const FADE_LEAD = 0;

// The gradient is a SINGLE colour (the chat background) ramping in OPACITY from
// top to bottom — never a different hue, so it can't shift the colour, it just
// makes the background progressively more solid. Three alpha stops:
//   TOP    — at the composer TOP. Transparent, so a message scrolling down
//            DISSOLVES gradually as it passes behind the composer instead of
//            hitting a hard solid edge (the "solid strip cutting an avatar in
//            half" regression). The opaque composer pill covers this zone, so
//            transparency here only affects the brief moment content slides
//            under the pill.
//   GAP    — at the BOTTOM of the composer pill (start of the composer→tab-bar
//            gap). High, so the gap below the pill reads mostly solid.
//   BOTTOM — at the screen bottom (device-button zone). Kept lowish so content
//            stays clearly visible there, matching the lighter ListBottomFade.
// Per scheme: a white (light-skin) scrim reads much stronger than a dark one,
// so the light profile uses lower opacities or content vanishes under it.
const TOP_OPACITY = 0; // transparent at the composer top → smooth dissolve, no hard edge
const GAP_OPACITY_DARK = 0.92;
const GAP_OPACITY_LIGHT = 0.70;
const BOTTOM_OPACITY_DARK = 0.55;
const BOTTOM_OPACITY_LIGHT = 0.30;

/**
 * Bottom content padding a chat MessagesList needs so the newest message rests
 * just above the floating composer + tab bar. Older messages still scroll
 * behind. Keep this in lockstep with ChatBottomChrome's layout — both derive
 * from the same constants.
 */
export function useChatListBottomInset(tabBarHeight: number): number {
  return COMPOSER_RESTING_HEIGHT + tabBarHeight + LAST_MESSAGE_GAP;
}

interface ChatBottomChromeProps {
  /** Height of the floating tab bar, used only to size the bottom fade so it
   *  covers the composer→tab-bar zone. Pass the EFFECTIVE height (0 while the
   *  emoji panel is open, so the fade collapses to just the composer). The
   *  composer's own animated spacer — NOT this prop — positions the pill, so the
   *  overlay sits at `bottom: 0` regardless of this value. */
  tabBarHeight: number;
  /** Chat background color the fade resolves to (theme.colors.surface1). */
  surfaceColor: string;
  /** Current scheme — drives the per-scheme fade opacity. */
  isDark: boolean;
  /** The composer (MessageInput) or the read-only banner. */
  children: React.ReactNode;
}

export function ChatBottomChrome({ tabBarHeight, surfaceColor, isDark, children }: ChatBottomChromeProps) {
  const fadeHeight = tabBarHeight + COMPOSER_RESTING_HEIGHT + FADE_LEAD;
  // The gradient ramps from transparent at the composer top to peak (gap)
  // opacity at the BOTTOM of the composer pill, so content dissolves smoothly
  // as it scrolls behind the pill (no hard solid edge), and the gap below the
  // pill reads solid. The pill sits in the top COMPOSER_RESTING_HEIGHT of the
  // fade zone; below it is the tab-bar gap.
  const gapStop = Math.min(0.95, (FADE_LEAD + COMPOSER_RESTING_HEIGHT) / fadeHeight);
  const gapOpacity = isDark ? GAP_OPACITY_DARK : GAP_OPACITY_LIGHT;
  const bottomOpacity = isDark ? BOTTOM_OPACITY_DARK : BOTTOM_OPACITY_LIGHT;

  return (
    <>
      {/* Bottom fade: a single colour (the chat background) ramping in opacity.
          Low alpha at the top (a gentle hint, same colour as the background so
          it's barely visible), PEAKING by the composer top so the composer→
          tab-bar gap reads solid, then easing back slightly at the screen
          bottom so content stays faintly visible behind the device buttons
          (matching ListBottomFade). Sits behind the composer overlay and
          ignores touches. */}
      <LinearGradient
        colors={[
          withAlpha(surfaceColor, TOP_OPACITY),
          withAlpha(surfaceColor, gapOpacity),
          withAlpha(surfaceColor, bottomOpacity),
        ]}
        locations={[0, gapStop, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.bottomFade, { height: fadeHeight }]}
        pointerEvents="none"
      />

      {/* Composer anchored at the screen bottom (bottom: 0). The composer's own
          animated spacer is the SINGLE owner of the pill's on-screen position:
          at rest it holds the tab-bar clearance so the pill floats above the
          bar; when the keyboard/panel opens it grows to the full keyboard
          height. Anchoring here (not at bottom: tabBarHeight) removes the second,
          React-driven position owner that used to desync the keyboard↔panel
          swap. */}
      <View style={[styles.composerOverlay, { bottom: 0 }]} pointerEvents="box-none">
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  composerOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
  },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
  },
});
