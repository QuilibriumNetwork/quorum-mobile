import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { FarcasterLogoIcon } from '@/components/ui/FarcasterLogoIcon';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { QuorumLogoIcon } from '@/components/SocialFeed/content/QuorumLogoIcon';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import type { UserInfo } from '@/context/AuthContext';
import type { ProfileAuthor } from '@/hooks/useFarcasterProfile';
import { truncateAddress } from '@/utils/formatAddress';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

/** Which identity the big profile card shows when unmerged with both profiles. */
export type IdentityTab = 'quorum' | 'farcaster';

interface UnifiedProfileHeaderProps {
  user: UserInfo;
  farcasterProfile?: ProfileAuthor | null;
  splitMode: boolean;
  /** Selected identity (unmerged-with-both layout). Owned by the parent. */
  identityTab: IdentityTab;
  onIdentityTabChange: (tab: IdentityTab) => void;
  onEditQuorum?: () => void;
  onEditFarcaster?: () => void;
  onEditUnified?: () => void;
}

const IDENTITY_PILLS: SegmentedPillItem[] = [
  { key: 'quorum', label: 'Quorum', leading: <QuorumLogoIcon size={14} /> },
  { key: 'farcaster', label: 'Farcaster', leading: <FarcasterLogoIcon size={14} /> },
];

export default function UnifiedProfileHeader({
  user,
  farcasterProfile,
  splitMode,
  identityTab,
  onIdentityTabChange,
  onEditQuorum,
  onEditFarcaster,
  onEditUnified,
}: UnifiedProfileHeaderProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const hasFarcaster = Boolean(user.farcaster?.fid);

  if (!hasFarcaster) {
    return <QuorumOnlyHeader user={user} onEdit={onEditQuorum} theme={theme} styles={styles} />;
  }

  // Unmerged with both profiles: one big card + a [Quorum | Farcaster] switcher
  // above it. Swapping changes only this card; the nav pills below are separate.
  if (splitMode) {
    const showingFarcaster = identityTab === 'farcaster';
    // Quorum identity owns the QNS handle + on-chain address; Farcaster identity
    // shows only its @handle (no Quorum address). The address line renders only
    // when `address` is set, so neither identity duplicates it.
    const identity = showingFarcaster
      ? {
          displayName: farcasterProfile?.displayName || user.farcaster?.username || 'Unnamed',
          avatarUri: farcasterProfile?.pfp?.url || user.farcaster?.pfpUrl,
          bio: farcasterProfile?.profile?.bio?.text,
          handle: user.farcaster?.username ? `@${user.farcaster.username}` : undefined,
          handleAccent: false,
          address: undefined as string | undefined,
          onEdit: onEditFarcaster,
        }
      : {
          displayName: user.displayName || user.primaryUsername || 'Unnamed',
          avatarUri: user.profileImage,
          bio: user.bio,
          handle: user.primaryUsername ? `${user.primaryUsername}.q` : undefined,
          handleAccent: Boolean(user.primaryUsername),
          address: user.address,
          onEdit: onEditQuorum,
        };

    return (
      <View style={styles.switcherContainer}>
        {/* 'segmented' (iOS track) look distinguishes the identity switcher from
            the solid nav pills below, so the two rows don't read as one. */}
        <SegmentedPills
          items={IDENTITY_PILLS}
          activeKey={identityTab}
          onChange={(key) => onIdentityTabChange(key as IdentityTab)}
          variant="segmented"
          scrollable={false}
          itemRole="tab"
          style={styles.identitySwitcher}
        />
        <BigProfileCard
          displayName={identity.displayName}
          avatarUri={identity.avatarUri}
          handle={identity.handle}
          handleAccent={identity.handleAccent}
          address={identity.address}
          onEdit={identity.onEdit}
          theme={theme}
          styles={styles}
        />
      </View>
    );
  }

  // Merged mode — show one identity, prefer Quorum display fields with Farcaster
  // as fallback. Handle + address are always shown together.
  const displayName =
    user.displayName ||
    farcasterProfile?.displayName ||
    user.farcaster?.username ||
    'Unnamed';
  const avatarUri = user.profileImage || farcasterProfile?.pfp?.url || user.farcaster?.pfpUrl;
  const bio = user.bio || farcasterProfile?.profile?.bio?.text;

  return (
    <View style={styles.mergedContainer}>
      <TouchableOpacity onPress={onEditUnified} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={avatarUri ? { uri: avatarUri } : null}
          style={styles.mergedAvatar}
          fallbackName={displayName}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>

      <Text style={styles.mergedDisplayName} numberOfLines={1}>
        {displayName}
      </Text>

      <View style={styles.handlesRow}>
        {user.farcaster?.username && (
          <Text style={styles.handleText}>@{user.farcaster.username}</Text>
        )}
        {user.primaryUsername && (
          <Text style={[styles.handleText, { color: theme.colors.accent }]}>
            {user.primaryUsername}.q
          </Text>
        )}
        <Text style={styles.addressText}>{truncateAddress(user.address, 'medium')}</Text>
      </View>

      {bio ? (
        <Text style={styles.bioText} numberOfLines={3}>
          {bio}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The big single-identity profile card (96px avatar, pencil badge, name, handle,
 * bio) used in the unmerged switcher layout. Mirrors the merged/Quorum-only look
 * but renders whichever identity is selected.
 */
function BigProfileCard({
  displayName,
  avatarUri,
  handle,
  handleAccent,
  address,
  onEdit,
  theme,
  styles,
}: {
  displayName: string;
  avatarUri?: string | null;
  handle?: string;
  handleAccent?: boolean;
  address?: string;
  onEdit?: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.bigCardContainer}>
      <TouchableOpacity onPress={onEdit} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={avatarUri ? { uri: avatarUri } : null}
          style={styles.mergedAvatar}
          fallbackName={displayName}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>

      <Text style={styles.mergedDisplayName} numberOfLines={1}>
        {displayName}
      </Text>

      <View style={styles.handlesRow}>
        {handle ? (
          <Text style={[styles.handleText, handleAccent && { color: theme.colors.accent }]}>
            {handle}
          </Text>
        ) : null}
        {address ? (
          <Text style={styles.addressText}>{truncateAddress(address, 'medium')}</Text>
        ) : null}
      </View>
      {/* Bio intentionally omitted here — it's shown in the Profile section
          below, which reflects the selected identity. */}
    </View>
  );
}

function QuorumOnlyHeader({
  user,
  onEdit,
  theme,
  styles,
}: {
  user: UserInfo;
  onEdit?: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const displayName = user.displayName || user.primaryUsername || 'Unnamed';
  return (
    <View style={styles.mergedContainer}>
      <TouchableOpacity onPress={onEdit} activeOpacity={0.8} style={styles.mergedAvatarWrap}>
        <CachedAvatar
          source={user.profileImage ? { uri: user.profileImage } : null}
          style={styles.mergedAvatar}
          fallbackName={displayName}
        />
        <View style={styles.editBadge}>
          <IconSymbol name="pencil" size={12} color="#fff" />
        </View>
      </TouchableOpacity>
      <Text style={styles.mergedDisplayName} numberOfLines={1}>
        {displayName}
      </Text>
      <View style={styles.handlesRow}>
        {user.primaryUsername && (
          <Text style={[styles.handleText, { color: theme.colors.accent }]}>
            {user.primaryUsername}.q
          </Text>
        )}
        <Text style={styles.addressText}>{truncateAddress(user.address, 'medium')}</Text>
      </View>
      {user.bio ? (
        <Text style={styles.bioText} numberOfLines={3}>
          {user.bio}
        </Text>
      ) : null}
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    mergedContainer: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(20),
      gap: Skin.space(6),
    },
    mergedAvatarWrap: {
      marginBottom: Skin.space(4),
    },
    mergedAvatar: {
      width: 96,
      height: 96,
      borderRadius: Skin.radius(48),
      backgroundColor: theme.colors.surface2,
    },
    editBadge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 28,
      height: 28,
      borderRadius: Skin.radius(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.accent,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    mergedDisplayName: {
      fontSize: Skin.font(22),
      fontWeight: '700',
      color: theme.colors.textStrong,
    },
    handlesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      justifyContent: 'center',
      gap: Skin.space(8),
    },
    handleText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    addressText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: 'Menlo',
    },
    bioText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      textAlign: 'center',
      marginTop: Skin.space(6),
      lineHeight: Skin.font(19),
    },
    // Unmerged switcher layout: [Quorum|Farcaster] track + one big card.
    switcherContainer: {
      alignItems: 'center',
      paddingTop: Skin.space(20),
    },
    identitySwitcher: {
      alignSelf: 'center',
      marginBottom: Skin.space(4),
    },
    bigCardContainer: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(16),
      gap: Skin.space(6),
    },
  });
}
