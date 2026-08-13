/**
 * HeaderAvatar — small circular pfp button for the top-left of every
 * main tab header. Tapping it opens the profile/settings view at the
 * top-level `/account` route.
 *
 * The avatar source mirrors the resolution order used by
 * UnifiedProfileHeader (Quorum profile → Farcaster pfp → fallback) so
 * we don't show a different avatar in the header vs the profile pane.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { router } from 'expo-router';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import * as Skin from '@/theme/skins/geometry';
import { useAuth } from '@/context';
import { useMemberIdentity, useResolvedMemberName } from '@/identity';
import { useTheme } from '@/theme';

const SIZE = 32;

export function HeaderAvatar() {
  const { user } = useAuth();
  const { theme } = useTheme();
  const address = user?.address ?? '';

  // Mirror the resolution order used by UnifiedProfileHeader — Quorum
  // profile image first, then Farcaster pfp as fallback so the header
  // avatar matches the profile screen.
  const uri = user?.profileImage || user?.farcaster?.pfpUrl || undefined;

  // Own name through the SAME verified ladder every other member resolves
  // through, rather than trusting `primaryUsername`/`displayName` off the
  // live auth profile directly. A `.q` elected on this device is still just a
  // CLAIM until it resolves back to this address through a published public
  // profile — the old direct read rendered it as though electing it were
  // proof, which is exactly the forgery `identity/` exists to close, applied
  // here to your own name instead of somebody else's.
  //
  // `global: true`: self has no per-space tier (see `resolveSelfName`'s
  // docstring on the same point) — an ambient Space scope must not let a
  // roster nickname outrank your own QNS name here. `enrich` is left at its
  // default `false`: `IdentityScopeProvider` already requests `selfAddress`'s
  // public profile itself whenever one is set (see its own effect), so this
  // surface asking again would only be a deduped no-op.
  const identity = useMemberIdentity(address);
  const resolved = useResolvedMemberName(address, { global: true });

  // When no tier has a name at all, stay empty rather than falling through to
  // the resolver's own truncated-address fallback: CachedAvatar treats any
  // defined string as a request for initials, and an address-derived initial
  // ("Q" from `Qm7f3a…`) belongs to nobody and would be shared by nearly
  // every user — the same failure the old "Unnamed" fallback had, which this
  // surface already went out of its way to avoid.
  const hasSelfName = !!(identity.qnsName || identity.globalName);
  const fallbackName = hasSelfName ? resolved.name : '';

  return (
    <TouchableOpacity
      onPress={() => router.push('/account')}
      hitSlop={8}
      activeOpacity={0.7}
      accessibilityLabel="Open profile and settings"
    >
      <View
        style={[
          styles.wrap,
          {
            backgroundColor: theme.colors.surface3,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <CachedAvatar source={uri ? { uri } : null} style={styles.avatar} fallbackName={fallbackName} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    borderRadius: Skin.circleOrSquare(SIZE / 2),
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  avatar: {
    width: SIZE,
    height: SIZE,
    borderRadius: Skin.circleOrSquare(SIZE / 2),
  },
});
