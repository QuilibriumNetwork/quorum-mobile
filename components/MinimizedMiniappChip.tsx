/**
 * MinimizedMiniappChip — floating restore affordance for the active
 * minimized miniapp. Reads directly from `MiniappOverlayContext` so
 * the WebView never unmounts: tapping the chip restores the same
 * BrowserModal instance, JS state intact.
 *
 * Tap → restore (slide back in).
 * Long-press → fully dismiss the miniapp.
 */

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useFloatingTabBarPadding } from '@/hooks/useFloatingTabBarPadding';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

export function MinimizedMiniappChip() {
  const { theme } = useTheme();
  // Sit just above the tab bar (its footprint = tab bar height + nav bar inset).
  const tabBarClearance = useFloatingTabBarPadding();
  const { entry, minimized, restoreMiniapp, closeMiniapp } = useMiniappOverlay();

  if (!entry || !minimized) return null;

  let domain = '';
  try {
    domain = new URL(entry.url).hostname.replace(/^www\./, '');
  } catch {
    domain = entry.url;
  }

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        // Above the tab bar (clears the bar + system nav bar in edge-to-edge).
        bottom: tabBarClearance,
        left: 12,
        right: 12,
      }}
    >
      <Pressable
        onPress={restoreMiniapp}
        onLongPress={closeMiniapp}
        style={({ pressed }) => ({
          alignSelf: 'flex-start',
          backgroundColor: theme.colors.surface3,
          borderRadius: Skin.radius(18),
          paddingVertical: Skin.space(8),
          paddingHorizontal: Skin.space(12),
          flexDirection: 'row',
          alignItems: 'center',
          gap: Skin.space(8),
          opacity: pressed ? 0.85 : 1,
          ...Skin.floatingShadow(),
        })}
      >
        <CachedAvatar
          source={entry.iconUrl ? { uri: entry.iconUrl } : null}
          style={{
            width: 22,
            height: 22,
            borderRadius: Skin.radius(6),
            backgroundColor: theme.colors.surface1,
          }}
        />
        <Text
          style={{ color: theme.colors.textStrong, fontSize: Skin.font(13) }}
          numberOfLines={1}
        >
          Resume {entry.name ?? domain}
        </Text>
        <IconSymbol name="chevron.right" size={14} color={theme.colors.textMuted} />
      </Pressable>
    </View>
  );
}
