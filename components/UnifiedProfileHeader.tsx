import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import type { UserInfo } from '@/context/AuthContext';
import type { ProfileAuthor } from '@/hooks/useFarcasterProfile';
import { truncateAddress } from '@/utils/formatAddress';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface UnifiedProfileHeaderProps {
  user: UserInfo;
  farcasterProfile?: ProfileAuthor | null;
  splitMode: boolean;
  onEditQuorum?: () => void;
  onEditFarcaster?: () => void;
  onEditUnified?: () => void;
}

export default function UnifiedProfileHeader({
  user,
  farcasterProfile,
  splitMode,
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

  if (splitMode) {
    return (
      <View style={styles.splitContainer}>
        <QuorumCard user={user} onEdit={onEditQuorum} theme={theme} styles={styles} />
        <FarcasterCard
          user={user}
          profile={farcasterProfile}
          onEdit={onEditFarcaster}
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

function QuorumCard({
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
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={onEdit}>
      <CachedAvatar
        source={user.profileImage ? { uri: user.profileImage } : null}
        style={styles.cardAvatar}
        fallbackName={displayName}
      />
      <View style={styles.cardText}>
        <View style={styles.cardLabelRow}>
          <IconSymbol name="shield.fill" size={10} color={theme.colors.accent} />
          <Text style={[styles.cardLabel, { color: theme.colors.accent }]}>Quorum</Text>
        </View>
        <Text style={styles.cardDisplayName} numberOfLines={1}>{displayName}</Text>
        <Text style={styles.cardHandleMuted} numberOfLines={1}>
          {user.primaryUsername ? `${user.primaryUsername}.q` : truncateAddress(user.address, 'short')}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function FarcasterCard({
  user,
  profile,
  onEdit,
  theme,
  styles,
}: {
  user: UserInfo;
  profile?: ProfileAuthor | null;
  onEdit?: () => void;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const displayName =
    profile?.displayName || user.farcaster?.username || 'Unnamed';
  const avatarUri = profile?.pfp?.url || user.farcaster?.pfpUrl;
  return (
    <TouchableOpacity style={styles.card} activeOpacity={0.85} onPress={onEdit}>
      <CachedAvatar
        source={avatarUri ? { uri: avatarUri } : null}
        style={styles.cardAvatar}
        fallbackName={displayName}
      />
      <View style={styles.cardText}>
        <View style={styles.cardLabelRow}>
          <IconSymbol name="person.2.fill" size={10} color={theme.colors.textMuted} />
          <Text style={[styles.cardLabel, { color: theme.colors.textMuted }]}>Farcaster</Text>
        </View>
        <Text style={styles.cardDisplayName} numberOfLines={1}>{displayName}</Text>
        {user.farcaster?.username ? (
          <Text style={styles.cardHandleMuted} numberOfLines={1}>@{user.farcaster.username}</Text>
        ) : null}
      </View>
    </TouchableOpacity>
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
    splitContainer: {
      flexDirection: 'row',
      paddingHorizontal: Skin.space(12),
      paddingTop: Skin.space(10),
      paddingBottom: Skin.space(12),
      gap: Skin.space(8),
    },
    card: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(10),
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.surface1,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
      gap: Skin.space(10),
    },
    cardText: {
      flex: 1,
      minWidth: 0,
    },
    cardLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(3),
    },
    cardLabel: {
      fontSize: Skin.font(10),
      fontWeight: '600',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
    },
    cardAvatar: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface2,
    },
    cardDisplayName: {
      fontSize: Skin.font(14),
      fontWeight: '600',
      color: theme.colors.textStrong,
    },
    cardHandle: {
      fontSize: Skin.font(12),
      fontWeight: '500',
    },
    cardHandleMuted: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
    },
  });
}
