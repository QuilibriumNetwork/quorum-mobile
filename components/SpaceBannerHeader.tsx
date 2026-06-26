import React from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import {
  getColorFromDisplayName,
  getInitials,
  lightenColor,
  darkenColor,
  type Space,
} from '@quilibrium/quorum-shared';

const BANNER_HEIGHT = 180;
const GRADIENT_HEIGHT = BANNER_HEIGHT * 0.75;
const BUTTON_SIZE = 32;

interface SpaceBannerHeaderProps {
  space: Space;
  insetTop: number;
  onBack: () => void;
  onInvite: () => void;
  onSettings: () => void;
  onDescriptionPress: () => void;
  /** Whole-space notifications muted — shows a bell-off marker by the name. */
  isMuted?: boolean;
}

export function SpaceBannerHeader({
  space,
  insetTop,
  onBack,
  onInvite,
  onSettings,
  onDescriptionPress,
  isMuted = false,
}: SpaceBannerHeaderProps) {
  const { theme, isDark } = useTheme();

  const hasBanner = !!space.bannerUrl;
  const hasIcon = !!space.iconUrl;

  // No banner and no icon: wash the banner in the same deterministic color the
  // space-initials avatar uses, so the empty area carries the space's identity
  // color instead of flat grey. Matches AvatarInitials' gradient recipe.
  const fallbackGradient = React.useMemo(() => {
    if (getInitials(space.spaceName) === '?') {
      return ['#9d9da3', '#7a7a7f'] as const;
    }
    const base = getColorFromDisplayName(space.spaceName);
    return [lightenColor(base, 5), darkenColor(base, 10)] as const;
  }, [space.spaceName]);

  const buttonBg = isDark ? 'rgba(15,15,18,0.65)' : 'rgba(255,255,255,0.65)';
  const iconColor = isDark ? '#fff' : theme.colors.textMain;
  const nameColor = isDark ? '#fff' : theme.colors.textMain;

  // surface1 at 0.92 opacity for the gradient
  const gradientStart = isDark
    ? 'rgba(10,10,11,0.92)'
    : 'rgba(246,246,248,0.92)';

  return (
    <View style={styles.container}>
      {/* ── Background layer ── */}
      {hasBanner ? (
        <Image
          source={{ uri: space.bannerUrl }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      ) : hasIcon ? (
        <IconBannerBackground iconUrl={space.iconUrl} isDark={isDark} />
      ) : (
        <LinearGradient
          colors={fallbackGradient}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      )}

      {/* ── Bottom gradient ── */}
      <LinearGradient
        colors={[gradientStart, 'transparent']}
        start={{ x: 0, y: 1 }}
        end={{ x: 0, y: 0 }}
        style={[styles.gradient, { height: GRADIENT_HEIGHT }]}
      />

      {/* ── Button row ── */}
      <View style={[styles.buttonRow, { paddingTop: insetTop + 8 }]}>
        <FrostedPill style={{ backgroundColor: buttonBg }} onPress={onBack}>
          <IconSymbol name="chevron.left" size={20} color={iconColor} />
        </FrostedPill>
        <View style={styles.rightButtons}>
          <FrostedPill style={{ backgroundColor: buttonBg }} onPress={onInvite}>
            <IconSymbol name="person.badge.plus" size={20} color={iconColor} />
          </FrostedPill>
          <FrostedPill style={{ backgroundColor: buttonBg }} onPress={onSettings}>
            <IconSymbol name="gearshape" size={20} color={iconColor} />
          </FrostedPill>
        </View>
      </View>

      {/* ── Space name (tappable → description sheet) ── */}
      <TouchableOpacity
        style={styles.nameRow}
        onPress={onDescriptionPress}
        activeOpacity={0.7}
        hitSlop={8}
      >
        <Text style={[styles.spaceName, { color: nameColor }]} numberOfLines={1}>
          {space.spaceName}
        </Text>
        {isMuted && (
          <IconSymbol name="bell.slash.fill" size={16} color={nameColor} />
        )}
      </TouchableOpacity>
    </View>
  );
}

// ── Icon-based blurred background (no bannerUrl) ──────────────────────────────

interface IconBannerBgProps {
  iconUrl: string;
  isDark: boolean;
}

function IconBannerBackground({ iconUrl, isDark }: IconBannerBgProps) {
  // We render the icon oversized and centered so it reads as a color wash,
  // not as a recognisable square icon. Platform split: iOS uses BlurView
  // (UIVisualEffectView — fast, beautiful). Android uses RenderEffect (API 31+)
  // or falls back to a semi-transparent overlay for API 24-30 where RenderScript
  // blur on a content-area view can be unreliable.
  return (
    <View style={StyleSheet.absoluteFill}>
      <Image
        source={{ uri: iconUrl }}
        style={styles.iconBg}
        resizeMode="cover"
        blurRadius={Platform.OS === 'ios' ? 0 : 20}
      />
      {Platform.OS === 'ios' ? (
        <BlurView
          tint={isDark ? 'dark' : 'light'}
          intensity={80}
          style={StyleSheet.absoluteFill}
        />
      ) : (
        // Android: opaque-ish overlay that softens the image without relying
        // on RenderScript/RenderEffect consistency inside a content view.
        <>
          <View style={[StyleSheet.absoluteFill, styles.androidOverlay1]} />
          <View style={[StyleSheet.absoluteFill, styles.androidOverlay2]} />
          <View style={[StyleSheet.absoluteFill, styles.androidOverlay3]} />
        </>
      )}
    </View>
  );
}

// ── Frosted pill button ───────────────────────────────────────────────────────

interface FrostedPillProps {
  children: React.ReactNode;
  onPress: () => void;
  style?: object;
}

function FrostedPill({ children, onPress, style }: FrostedPillProps) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.pill, style]} activeOpacity={0.75}>
      {children}
    </TouchableOpacity>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    height: BANNER_HEIGHT,
    width: '100%',
    overflow: 'hidden',
  },
  iconBg: {
    ...StyleSheet.absoluteFillObject,
    // Scale icon to fill the banner as a color wash
    width: '200%',
    height: '200%',
    top: '-50%',
    left: '-50%',
  },
  androidOverlay1: {
    backgroundColor: 'rgba(10,10,11,0.35)',
  },
  androidOverlay2: {
    backgroundColor: 'rgba(10,10,11,0.35)',
  },
  androidOverlay3: {
    backgroundColor: 'rgba(10,10,11,0.35)',
  },
  gradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
  buttonRow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: Skin.space(12),
  },
  rightButtons: {
    flexDirection: 'row',
    gap: Skin.space(8),
  },
  pill: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: Skin.radius(6),
    alignItems: 'center',
    justifyContent: 'center',
  },
  nameRow: {
    position: 'absolute',
    bottom: Skin.space(18),
    left: Skin.space(16),
    right: Skin.space(16),
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  spaceName: {
    fontSize: 20,
    fontWeight: '700',
    flexShrink: 1,
  },
});
