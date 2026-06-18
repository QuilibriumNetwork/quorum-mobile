/**
 * FloatingTabScreen — shared bottom-of-screen treatment for the floating-tab-bar
 * tabs (Spaces, Messages, Notifications, Feed, Wallet, Mini Apps, …).
 *
 * In edge-to-edge mode the tab bar floats over the screen bottom and content is
 * meant to scroll all the way to the device edge, behind the bar. This wrapper
 * centralises everything that makes that work and look right, so it can be
 * tweaked or reverted in ONE place:
 *
 *   1. Fills the screen background (so there's no gap behind the content).
 *   2. Renders the ListBottomFade scrim (dims content scrolling into the
 *      tab-bar / device-button zone).
 *   3. Hands the screen's scrollable the correct bottom content-inset via a
 *      render-prop, so the last item clears the floating bar.
 *
 * Usage (render-prop hands you the bottom padding for your list):
 *
 *   <FloatingTabScreen surfaceColor={theme.colors.surface1}>
 *     {({ listBottomPadding }) => (
 *       <FlashList
 *         ...
 *         contentContainerStyle={{ paddingBottom: listBottomPadding }}
 *       />
 *     )}
 *   </FloatingTabScreen>
 *
 * The wrapper does NOT add top padding or a header — screens own their own
 * header + top inset. It only governs the bottom treatment.
 */

import { ListBottomFade } from '@/components/ui/ListBottomFade';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

interface FloatingTabScreenRenderArgs {
  /** Bottom content padding for the screen's list so its last item clears the
   *  floating tab bar. Pass into contentContainerStyle.paddingBottom. */
  listBottomPadding: number;
}

interface FloatingTabScreenProps {
  /** Screen background the fade resolves toward (theme.colors.surface1). */
  surfaceColor: string;
  /** Extra styles for the outer container (e.g. paddingTop: insets.top). */
  style?: StyleProp<ViewStyle>;
  /** Render-prop receiving the bottom padding the screen's list should use,
   *  or plain children if the screen wires padding itself. */
  children: React.ReactNode | ((args: FloatingTabScreenRenderArgs) => React.ReactNode);
}

export function FloatingTabScreen({ surfaceColor, style, children }: FloatingTabScreenProps) {
  const listBottomPadding = useFloatingTabBarPadding();

  return (
    <View style={[styles.container, { backgroundColor: surfaceColor }, style]}>
      {typeof children === 'function' ? children({ listBottomPadding }) : children}
      <ListBottomFade surfaceColor={surfaceColor} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
