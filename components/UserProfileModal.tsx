import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { KickUserModal } from '@/components/KickUserModal';
import { MuteUserModal } from '@/components/MuteUserModal';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useTheme, type AppTheme } from '@/theme';
import { useAuth } from '@/context';
import { useToast } from '@/context/ToastContext';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { truncateAddress } from '@/utils/formatAddress';
import { useAssignRole, useRemoveFromRole, useSpaces, useHasPermission } from '@/hooks/chat';
import { useIsUserMuted } from '@/hooks/chat/useIsUserMuted';
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
  /** Channel context, required to broadcast a moderation MuteMessage. */
  channelId?: string;
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
  channelId,
  roles,
  isSpaceOwner,
  onOpenFarcasterProfile,
}: UserProfileModalProps) {
  const { theme, isDark } = useTheme();
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirmDialog();
  const { user: authUser } = useAuth();
  const insets = useSafeAreaInsets();
  const [loadingRoles, setLoadingRoles] = useState<Set<string>>(new Set());
  const [kickVisible, setKickVisible] = useState(false);
  const [muteVisible, setMuteVisible] = useState(false);

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

  const removeRole = async (roleId: string) => {
    if (!spaceId || !user) return;
    // Removing a role broadcasts the change to every member, so confirm it (T1).
    const roleName = userRoles.find(r => r.roleId === roleId)?.displayName;
    const ok = await confirm({
      title: 'Remove Role',
      message: roleName
        ? `Remove the "${roleName}" role from ${user.userName}? This change is visible to everyone in the space.`
        : `Remove this role from ${user.userName}? This change is visible to everyone in the space.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
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

  // Confirm before removing a role from the user (don't fire immediately).
  const handleRemoveRole = (roleId: string) => {
    const role = userRoles.find(r => r.roleId === roleId);
    const roleLabel = role ? role.displayName : 'this role';
    Alert.alert(
      'Remove role',
      `Remove ${roleLabel} from ${user?.userName ?? 'this user'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => { void removeRole(roleId); } },
      ],
    );
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

  // Moderation mute: gated on the VIEWER holding the `user:mute` role permission
  // (NOT isSpaceOwner — receivers can't verify ownership, so owners need a role
  // too; matches the receive-side check). Requires a channel to broadcast on.
  const viewerCanMute = useHasPermission(spaceId, authUser?.address, 'user:mute');
  const canModMute = !!(viewerCanMute && spaceId && channelId && !isSelf && user);
  const { isUserMuted: isModMuted } = useIsUserMuted(spaceId);
  const targetIsModMuted = !!user && isModMuted(user.userId);

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
                {userRoles.map(role => {
                  const isLoading = loadingRoles.has(role.roleId);
                  // Owners can remove a role by tapping anywhere on the pill;
                  // the ✕ is just the affordance. Non-owners get a static badge.
                  // Visual (background tint + color dot) follows the shared
                  // role-color palette from PR #92.
                  const badgeContent = (
                    <>
                      {isLoading ? (
                        <ActivityIndicator size={10} color={role.color} />
                      ) : (
                        <View style={[styles.roleBadgeDot, { backgroundColor: role.color }]} />
                      )}
                      <Text style={[styles.roleBadgeText, { color: role.color }]}>
                        {role.displayName}
                      </Text>
                      {isSpaceOwner && (
                        <IconSymbol name="xmark" size={10} color={role.color} />
                      )}
                    </>
                  );
                  return isSpaceOwner ? (
                    <TouchableOpacity
                      key={role.roleId}
                      style={[styles.roleBadge, { backgroundColor: role.color + '20' }]}
                      onPress={() => handleRemoveRole(role.roleId)}
                      disabled={isLoading}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${role.displayName} role`}
                    >
                      {badgeContent}
                    </TouchableOpacity>
                  ) : (
                    <View key={role.roleId} style={[styles.roleBadge, { backgroundColor: role.color + '20' }]}>
                      {badgeContent}
                    </View>
                  );
                })}
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
        {((onStartDM && !isSelf) || (onMuteUser && !isSelf) || canModMute || canKick) && (
          <View style={styles.actionsContainer}>
            <ActionRowGroup>
              {onStartDM && !isSelf && (
                <ActionRow
                  icon="bubble.left"
                  label="Message"
                  onPress={() => {
                    onStartDM(user.userId);
                    onClose();
                  }}
                />
              )}
              {/* Personal block (viewer-side hide). Task D renames this to
                  "Block"; until then it reads Mute/Unmute. Distinct from the
                  moderation mute below. */}
              {onMuteUser && !isSelf && (
                <ActionRow
                  icon={isUserMuted ? 'bell' : 'bell.slash'}
                  label={isUserMuted ? 'Unmute' : 'Mute'}
                  onPress={() => {
                    onMuteUser(user.userId);
                    onClose();
                  }}
                />
              )}
              {/* Moderation mute (role-gated; silences the user for everyone) */}
              {canModMute && (
                <ActionRow
                  icon="bell.slash.fill"
                  label={targetIsModMuted ? 'Unmute in Space' : 'Mute in Space'}
                  destructive
                  onPress={() => setMuteVisible(true)}
                />
              )}
              {/* Kick (space owners only) - destructive row */}
              {canKick && (
                <ActionRow
                  icon="person.crop.circle.badge.exclamationmark"
                  label="Kick from Space"
                  destructive
                  onPress={() => setKickVisible(true)}
                />
              )}
            </ActionRowGroup>
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
      {canModMute && (
        <MuteUserModal
          visible={muteVisible}
          onClose={() => setMuteVisible(false)}
          spaceId={spaceId!}
          channelId={channelId!}
          userName={user.userName}
          userIcon={hasValidAvatar ? user.userAvatar : undefined}
          userAddress={user.userId}
          isUnmuting={targetIsModMuted}
        />
      )}
      {confirmDialog}
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
      // Tinted fill + a solid color dot (matches the members-list pill) so the
      // pill reads against any drawer surface, not relying on a thin border.
      borderRadius: Skin.radius(14),
      paddingVertical: Skin.space(4),
      paddingHorizontal: Skin.space(10),
    },
    roleBadgeDot: {
      width: 8,
      height: 8,
      borderRadius: Skin.radius(4),
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
      // `border` (= surface6) is the token meant for borders; surface4 is a
      // surface tone that washes out against lighter drawer surfaces. Re-skins.
      borderColor: theme.colors.border,
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
  });
