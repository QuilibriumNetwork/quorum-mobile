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

import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View } from 'react-native';

// Approximate resting height of the single-line composer pill (incl. its
// padding + margin). Used to pad the list bottom and size the fade.
const COMPOSER_RESTING_HEIGHT = 60;

// Extra fade distance ABOVE the composer top so the gradient is already mostly
// solid by the time it reaches the composer — the composer→tab-bar gap reads as
// dissolved rather than showing crisp messages.
const FADE_LEAD = 56;

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
  /** The composer (MessageInput) or the read-only banner. */
  children: React.ReactNode;
}

export function ChatBottomChrome({ tabBarHeight, surfaceColor, children }: ChatBottomChromeProps) {
  return (
    <>
      {/* Bottom fade: continuous transparent→solid gradient. Solid at the very
          bottom of the screen, fading up to transparent FADE_LEAD px above the
          composer top, so the composer→tab-bar gap reads as dissolved. Sits
          behind the composer overlay (rendered first) and ignores touches. */}
      <LinearGradient
        colors={['transparent', surfaceColor]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[styles.bottomFade, { height: tabBarHeight + COMPOSER_RESTING_HEIGHT + FADE_LEAD }]}
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
