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

// Extra fade distance ABOVE the composer top so the gradient is already mostly
// opaque by the time it reaches the composer — the composer→tab-bar gap reads as
// dissolved rather than showing crisp messages.
const FADE_LEAD = 56;

// The gradient is a SINGLE colour (the chat background) ramping in OPACITY from
// top to bottom — never a different hue, so it can't shift the colour, it just
// makes the background progressively more solid. Three alpha stops:
//   TOP    — at the very top of the fade zone (ABOVE the composer). MUST stay
//            fully transparent so messages there are crisp — any tint here
//            dims content above the composer (a regression).
//   GAP    — by the composer top (upper end of the composer→tab-bar gap). High
//            so the gap reads as mostly solid / not see-through.
//   BOTTOM — at the screen bottom (device-button zone). Kept lowish so content
//            stays clearly visible there, matching the lighter ListBottomFade.
// Per scheme: a white (light-skin) scrim reads much stronger than a dark one,
// so the light profile uses lower opacities or content vanishes under it.
const TOP_OPACITY = 0; // always fully transparent (don't dim messages above the composer)
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
  return COMPOSER_RESTING_HEIGHT + tabBarHeight;
}

interface ChatBottomChromeProps {
  /** Height of the floating tab bar the composer sits above (0 when hidden,
   *  e.g. while the emoji panel is open so the panel reaches the screen bottom). */
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
  // The composer top sits FADE_LEAD px down from the top of the fade zone; we
  // want peak opacity there so the composer→tab-bar gap reads solid.
  const gapStop = Math.min(0.95, FADE_LEAD / fadeHeight);
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

      {/* Composer floats over the bottom of the list, just above the tab bar
          (bottom: tabBarHeight). When the keyboard opens, the composer's own
          animated spacer grows by (keyboard − tabBarHeight) so the pill lands
          exactly on the keyboard. */}
      <View style={[styles.composerOverlay, { bottom: tabBarHeight }]} pointerEvents="box-none">
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
