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
  /** Copy the Quorum address (tappable address line on the Quorum card). */
  onCopyAddress?: () => void;
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
  onCopyAddress,
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
        {showingFarcaster ? (
          <BigProfileCard
            displayName={farcasterProfile?.displayName || user.farcaster?.username || 'Unnamed'}
            avatarUri={farcasterProfile?.pfp?.url || user.farcaster?.pfpUrl}
            username={user.farcaster?.username ? `@${user.farcaster.username}` : undefined}
            fid={user.farcaster?.fid}
            onEdit={onEditFarcaster}
            theme={theme}
            styles={styles}
          />
        ) : (
          <BigProfileCard
            displayName={user.displayName || user.primaryUsername || 'Unnamed'}
            avatarUri={user.profileImage}
            qname={user.primaryUsername ? `${user.primaryUsername}.q` : undefined}
            address={user.address}
            onCopyAddress={onCopyAddress}
            onEdit={onEditQuorum}
            theme={theme}
            styles={styles}
          />
        )}
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
 * The big single-identity profile card (96px avatar, pencil badge) used in the
 * unmerged switcher layout. Renders identity-specific lines under the name:
 *  - Quorum: `.q` name (accent) + a tappable, copyable address.
 *  - Farcaster: @username + FID, with a top-right Disconnect control.
 * Bio is omitted here — it lives in the Profile section below.
 */
function BigProfileCard({
  displayName,
  avatarUri,
  qname,
  username,
  fid,
  address,
  onCopyAddress,
  onEdit,
  theme,
  styles,
}: {
  displayName: string;
  avatarUri?: string | null;
  /** Quorum `.q` primary username, e.g. "alice.q". */
  qname?: string;
  /** Farcaster @handle. */
  username?: string;
  /** Farcaster ID. */
  fid?: number;
  /** Quorum on-chain address (tappable to copy). */
  address?: string;
  onCopyAddress?: () => void;
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

      {/* Quorum: .q name */}
      {qname ? (
        <Text style={[styles.handleText, { color: theme.colors.accent }]}>{qname}</Text>
      ) : null}

      {/* Quorum: tappable address + copy icon */}
      {address ? (
        <TouchableOpacity
          style={styles.addressRow}
          onPress={onCopyAddress}
          accessibilityRole="button"
          accessibilityLabel="Copy address"
        >
          <Text style={styles.addressText}>{truncateAddress(address, 'medium')}</Text>
          <IconSymbol name="doc.on.doc" size={13} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : null}

      {/* Farcaster: @username */}
      {username ? (
        <Text style={styles.handleText}>{username}</Text>
      ) : null}

      {/* Farcaster: FID — same size/style as the username line */}
      {typeof fid === 'number' ? (
        <Text style={styles.handleText}>FID: {fid}</Text>
      ) : null}
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
      position: 'relative',
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(16),
      gap: Skin.space(6),
    },
    // Tappable address line (copy on press) with a trailing copy icon.
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
  });
}
