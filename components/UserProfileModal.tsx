import { BaseModal } from '@/components/shared';
import { KickUserModal } from '@/components/KickUserModal';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import { useAuth } from '@/context';
import { useToast } from '@/context/ToastContext';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { truncateAddress } from '@/utils/formatAddress';
import { useAssignRole, useRemoveFromRole, useSpaces } from '@/hooks/chat';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import type { Role } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';

export interface UserProfileInfo {
  userId: string;
  userName: string;
  userAvatar?: string;
  bio?: string;
  primaryUsername?: string;
  /** Farcaster linkage carried in the user's update-profile broadcast
   *  for this space. Surfaced as a tappable row that routes into the
   *  Farcaster feed at this user's profile. */
  farcasterFid?: number;
  farcasterUsername?: string;
}

interface UserProfileModalProps {
  visible: boolean;
  onClose: () => void;
  user: UserProfileInfo | null;
  onStartDM?: (userId: string) => void;
  onMuteUser?: (userId: string) => void;
  isUserMuted?: boolean;
  spaceId?: string;
  roles?: Role[];
  isSpaceOwner?: boolean;
  /** Optional: caller routes into the Farcaster feed profile view when
   *  the user taps the linked-Farcaster row. Omit to hide the row's
   *  chevron / make it non-interactive. */
  onOpenFarcasterProfile?: (params: { fid: number; username?: string }) => void;
}

export default function UserProfileModal({
  visible,
  onClose,
  user,
  onStartDM,
  onMuteUser,
  isUserMuted,
  spaceId,
  roles,
  isSpaceOwner,
  onOpenFarcasterProfile,
}: UserProfileModalProps) {
  const { theme, isDark } = useTheme();
  const { showToast } = useToast();
  const { user: authUser } = useAuth();
  const insets = useSafeAreaInsets();
  const [loadingRoles, setLoadingRoles] = useState<Set<string>>(new Set());
  const [kickVisible, setKickVisible] = useState(false);

  const assignRoleMutation = useAssignRole();
  const removeRoleMutation = useRemoveFromRole();

  const styles = createStyles(theme, isDark, insets);

  // Roles the user currently has
  const userRoles = useMemo(() => {
    if (!roles || !user) return [];
    return roles.filter(r => r.members.includes(user.userId));
  }, [roles, user]);

  // Roles available to assign (ones the user doesn't have)
  const availableRoles = useMemo(() => {
    if (!roles || !user) return [];
    return roles.filter(r => !r.members.includes(user.userId));
  }, [roles, user]);

  // Shared spaces
  const { data: mySpaces } = useSpaces();

  const handleAssignRole = async (roleId: string) => {
    if (!spaceId || !user) return;
    setLoadingRoles(prev => new Set(prev).add(roleId));
    try {
      await assignRoleMutation.mutateAsync({
        spaceId,
        roleId,
        userAddress: user.userId,
      });
    } catch (e) {
      showToast({
        type: 'error',
        title: 'Failed to assign role',
        message: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setLoadingRoles(prev => {
        const next = new Set(prev);
        next.delete(roleId);
        return next;
      });
    }
  };

  const handleRemoveRole = async (roleId: string) => {
    if (!spaceId || !user) return;
    setLoadingRoles(prev => new Set(prev).add(roleId));
    try {
      await removeRoleMutation.mutateAsync({
        spaceId,
        roleId,
        userAddress: user.userId,
      });
    } catch (e) {
      showToast({
        type: 'error',
        title: 'Failed to remove role',
        message: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setLoadingRoles(prev => {
        const next = new Set(prev);
        next.delete(roleId);
        return next;
      });
    }
  };


  // Copy address to clipboard
  const handleCopyAddress = async () => {
    if (!user?.userId) return;
    await Clipboard.setStringAsync(user.userId);
    Alert.alert('Copied', 'Address copied to clipboard');
  };

  // Check if avatar is a valid data URI
  const hasValidAvatar = user?.userAvatar?.startsWith('data:');

  const showRolesSection = roles && roles.length > 0 && (userRoles.length > 0 || isSpaceOwner);

  // Whether this profile is the current user's own. Message/Mute/Kick don't
  // make sense on yourself.
  const isSelf = !!(user && authUser?.address && user.userId === authUser.address);

  // Space owners can kick any member other than themselves
  const canKick = !!(isSpaceOwner && spaceId && !isSelf);

  if (!user) return null;

  return (
    <BaseModal
      visible={visible}
      onClose={onClose}
      height={0.55}
    >
      <ScrollView showsVerticalScrollIndicator={false} style={styles.scrollContent}>
        {/* Profile Header */}
        <View style={styles.profileHeader}>
          <View style={styles.avatarContainer}>
            {hasValidAvatar ? (
              <Image source={{ uri: user.userAvatar }} style={styles.avatar} />
            ) : (
              <DefaultAvatar displayName={user.userName} address={user.userId} size={100} style={styles.avatar} />
            )}
          </View>
          <Text style={styles.displayName}>{user.userName}</Text>
          {user.primaryUsername && (
            <Text style={styles.username}>@{user.primaryUsername}</Text>
          )}
          <TouchableOpacity onPress={handleCopyAddress} style={styles.addressRow}>
            <Text style={styles.userId}>{truncateAddress(user.userId)}</Text>
            <IconSymbol name="doc.on.doc" size={12} color={theme.colors.textMuted} />
          </TouchableOpacity>
          {user.farcasterFid && user.farcasterFid > 0 ? (
            <TouchableOpacity
              onPress={() => {
                if (onOpenFarcasterProfile && user.farcasterFid) {
                  onOpenFarcasterProfile({ fid: user.farcasterFid, username: user.farcasterUsername });
                }
              }}
              disabled={!onOpenFarcasterProfile}
              style={styles.farcasterRow}
            >
              <IconSymbol name="globe" size={12} color={theme.colors.primary} />
              <Text style={styles.farcasterText}>
                {user.farcasterUsername ? `@${user.farcasterUsername}` : `FID ${user.farcasterFid}`}
                {user.farcasterUsername ? ` · FID ${user.farcasterFid}` : ''}
              </Text>
              {onOpenFarcasterProfile ? (
                <IconSymbol name="chevron.right" size={12} color={theme.colors.textMuted} />
              ) : null}
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Roles Section */}
        {showRolesSection && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Roles</Text>

            {/* Current roles */}
            {userRoles.length > 0 && (
              <View style={styles.rolesRow}>
                {userRoles.map(role => (
                  <View key={role.roleId} style={[styles.roleBadge, { borderColor: role.color }]}>
                    {loadingRoles.has(role.roleId) ? (
                      <ActivityIndicator size={10} color={role.color} />
                    ) : null}
                    <Text style={[styles.roleBadgeText, { color: role.color }]}>
                      {role.displayName}
                    </Text>
                    {isSpaceOwner && (
                      <TouchableOpacity
                        onPress={() => handleRemoveRole(role.roleId)}
                        disabled={loadingRoles.has(role.roleId)}
                        hitSlop={6}
                      >
                        <IconSymbol name="xmark" size={10} color={role.color} />
                      </TouchableOpacity>
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* Available roles to assign (owner only) */}
            {isSpaceOwner && availableRoles.length > 0 && (
              <View style={styles.rolesRow}>
                {availableRoles.map(role => (
                  <TouchableOpacity
                    key={role.roleId}
                    style={styles.addRoleBadge}
                    onPress={() => handleAssignRole(role.roleId)}
                    disabled={loadingRoles.has(role.roleId)}
                  >
                    {loadingRoles.has(role.roleId) ? (
                      <ActivityIndicator size={10} color={theme.colors.textMuted} />
                    ) : (
                      <IconSymbol name="plus" size={10} color={theme.colors.textMuted} />
                    )}
                    <Text style={styles.addRoleBadgeText}>
                      {role.roleTag}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Bio Section */}
        {user.bio && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Bio</Text>
            <View style={styles.bioContainer}>
              <Text style={styles.bioText}>{user.bio}</Text>
            </View>
          </View>
        )}

        {/* Actions - styled as tappable rows */}
        {((onStartDM && !isSelf) || (onMuteUser && !isSelf) || canKick) && (
          <View style={styles.actionsContainer}>
            {onStartDM && !isSelf && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={() => {
                    onStartDM(user.userId);
                    onClose();
                  }}
                >
                  <IconSymbol name="bubble.left" size={20} color={theme.colors.textMain} />
                  <Text style={styles.actionRowText}>Message</Text>
                </TouchableOpacity>
              </>
            )}
            {onMuteUser && !isSelf && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={() => {
                    onMuteUser(user.userId);
                    onClose();
                  }}
                >
                  <IconSymbol
                    name={isUserMuted ? 'bell' : 'bell.slash'}
                    size={20}
                    color={theme.colors.textMain}
                  />
                  <Text style={styles.actionRowText}>
                    {isUserMuted ? 'Unmute' : 'Mute'}
                  </Text>
                </TouchableOpacity>
              </>
            )}
            {/* Kick (space owners only) - destructive row */}
            {canKick && (
              <>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.actionRow}
                  onPress={() => setKickVisible(true)}
                >
                  <IconSymbol name="person.crop.circle.badge.exclamationmark" size={20} color={theme.colors.danger} />
                  <Text style={[styles.actionRowText, styles.dangerText]}>Kick from Space</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </ScrollView>

      {canKick && (
        <KickUserModal
          visible={kickVisible}
          onClose={() => setKickVisible(false)}
          spaceId={spaceId!}
          userName={user.userName}
          userIcon={hasValidAvatar ? user.userAvatar : undefined}
          userAddress={user.userId}
        />
      )}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    scrollContent: {
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(8),
    },
    profileHeader: {
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    avatarContainer: {
      marginBottom: Skin.space(16),
    },
    avatar: {
      width: 100,
      height: 100,
      borderRadius: Skin.radius(50),
    },
    displayName: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
      textAlign: 'center',
    },
    username: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.primary,
      marginBottom: Skin.space(4),
      textAlign: 'center',
    },
    userId: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
    addressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    farcasterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginTop: Skin.space(8),
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface2,
    },
    farcasterText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMain,
    },
    section: {
      marginBottom: Skin.space(24),
    },
    sectionTitle: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(12),
    },
    bioContainer: {
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(12),
      borderRadius: Skin.radius(8),
    },
    bioText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      lineHeight: Skin.font(20),
    },
    rolesRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
      marginBottom: Skin.space(8),
    },
    roleBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      borderWidth: Skin.border(1),
      borderRadius: Skin.radius(14),
      paddingVertical: Skin.space(4),
      paddingHorizontal: Skin.space(10),
    },
    roleBadgeText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    addRoleBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface4,
      borderStyle: 'dashed',
      borderRadius: Skin.radius(14),
      paddingVertical: Skin.space(4),
      paddingHorizontal: Skin.space(10),
    },
    addRoleBadgeText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    actionsContainer: {
      marginBottom: Skin.space(24),
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.border ?? theme.colors.surface3,
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(14),
      gap: Skin.space(12),
    },
    actionRowText: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    dangerText: {
      color: theme.colors.danger,
    },
  });
