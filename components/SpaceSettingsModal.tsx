/**
 * SpaceSettingsModal - Modal for managing space settings
 *
 * Tabs (for space owners):
 * - General: Space name, description, icon, banner
 * - Account: Profile in this space, notification settings
 * - Roles: View/manage roles and permissions
 * - Emojis: Custom emoji management
 * - Stickers: Custom sticker management
 * - Invites: Generate and share invite links
 * - Danger: Delete space
 *
 * Tabs (for non-owners):
 * - Account: Profile in this space, notification settings (with leave option)
 */

import { KickUserModal } from '@/components/KickUserModal';
import SpaceChannelBindingPicker from '@/components/SpaceChannelBindingPicker';
import ShareInviteSheet from '@/components/ShareInviteSheet';
import { BaseModal, TypeToConfirmModal } from '@/components/shared';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { IconPicker } from '@/components/ui/IconPicker';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { useAuth, useWebSocket } from '@/context';
import { getMMKVAdapter } from '@/services/storage/mmkvAdapter';
import { maybeSendUpdateProfileMessage } from '@/services/space/spaceMessageService';
import * as ImagePicker from 'expo-image-picker';
import { useGenerateInvite, useGeneratePublicInvite } from '@/hooks/chat/useInviteManagement';
import {
  useAddRole,
  useDeleteRole,
  useRoles,
  useUpdateRole,
} from '@/hooks/chat/useRoleManagement';
import {
  useAddChannel,
  useUpdateChannel,
  useDeleteChannel,
  useAddGroup,
  useUpdateGroup,
  useDeleteGroup,
  useMoveChannel,
  useReorderChannels,
} from '@/hooks/chat';
import { useSpaceMembers } from '@/hooks/chat/useSpaces';
import { useStartDirectMessage } from '@/hooks/chat/useStartDirectMessage';
import { useUserMuting } from '@/hooks/chat/useUserMuting';
import { useDeleteSpace, useLeaveSpace, useUpdateSpace } from '@/hooks/chat/useSpaceSettings';
import { useSpaceApexConfig, useSetSpaceApexConfig } from '@/hooks/useApex';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import type { ApexToken } from '@/services/apex/config';
import { getErrorMessage } from '@/utils/error';
import { getSpace, getSpaceKey } from '@/services/config/spaceStorage';
import {
  getChannelNotificationsEnabled,
  getSpaceNotificationsEnabled,
  setChannelNotificationsEnabled,
  setSpaceNotificationsEnabled,
} from '@/services/notifications/notificationPrefs';
// NativeCryptoProvider and getApiConfig imported dynamically in handlePublishToDirectory
// to avoid module-level import failures on some devices
import { pickEmoji, pickSticker } from '@/services/media/customAssets';
import { pickImage, compressAvatarImage } from '@/services/media/imageAttachment';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { truncateAddress } from '@/utils/formatAddress';
import { hexToBytes, findRoleConflict, getUniqueRoleDefaults, type Emoji, type Permission, type Role, type Space, type Sticker } from '@quilibrium/quorum-shared';
import * as Clipboard from 'expo-clipboard';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import type { UserProfileInfo } from '@/components/UserProfileModal';

const UserProfileModal = React.lazy(() => import('@/components/UserProfileModal'));
import { ActivityIndicator, Alert, Dimensions, Image, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@quilibrium/quorum-shared';
import {
  validateSpaceName,
  validateSpaceDescription,
  MAX_NAME_LENGTH,
} from '@quilibrium/quorum-shared';
import {
  translateValidationResult,
  translateValidationResults,
} from '@/hooks/validation/errorTranslator';
import * as Skin from '@/theme/skins/geometry';
const { height: SCREEN_HEIGHT } = Dimensions.get('window');

interface SpaceSettingsModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  onSpaceDeleted?: () => void;
  onSpaceLeft?: () => void;
  isUserMuted?: (userId: string) => boolean;
  onToggleMuteUser?: (userId: string) => void;
}

type TabType = 'general' | 'account' | 'members' | 'channels' | 'linked' | 'roles' | 'emojis' | 'stickers' | 'invites' | 'danger';

// Validation constants
// Name min/max + XSS now come from @quilibrium/quorum-shared (validateSpaceName);
// MAX_NAME_LENGTH is imported for the input's maxLength prop. MAX_DESCRIPTION_LENGTH
// stays local — it's the mobile cap passed into shared validateSpaceDescription and
// shown in the char counter.
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_EMOJIS = 50;
const MAX_STICKERS = 50;

// Role colors are now a shared palette: roles store a named token and a default
// color is derived from the roleId in useAddRole (getDefaultRoleColor), resolved
// to hex on read in useRoles (getRoleColorHex). No local random-hex palette.

// Available permissions for roles
const AVAILABLE_PERMISSIONS: { value: Permission; label: string }[] = [
  { value: 'mention:everyone', label: 'Mention Everyone' },
  { value: 'message:pin', label: 'Pin Messages' },
  { value: 'user:mute', label: 'Mute Users' },
  { value: 'message:delete', label: 'Delete Messages' },
];

// RoleEditor component for inline editing
interface RoleEditorProps {
  role: Role;
  /** All roles in the space — used to validate tag/name uniqueness on save. */
  allRoles: Role[];
  spaceId: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
  onDelete: () => void;
}

function RoleEditor({ role, allRoles, spaceId, theme, styles, onDelete }: RoleEditorProps) {
  const [displayName, setDisplayName] = useState(role.displayName);
  const [roleTag, setRoleTag] = useState(role.roleTag);
  const [permissions, setPermissions] = useState<Permission[]>(role.permissions);
  const [isPublic, setIsPublic] = useState(role.isPublic !== false);
  const [showPermissions, setShowPermissions] = useState(false);
  // Inline error when the typed tag/name collides with another role. The text
  // stays as the user typed it (so they can fix it); nothing is persisted.
  const [conflictError, setConflictError] = useState<string | null>(null);

  const updateRoleMutation = useUpdateRole();

  const hasChanges = useMemo(() => {
    return (
      displayName !== role.displayName ||
      roleTag !== role.roleTag ||
      JSON.stringify([...permissions].sort()) !== JSON.stringify([...role.permissions].sort()) ||
      isPublic !== (role.isPublic !== false)
    );
  }, [displayName, roleTag, permissions, isPublic, role]);

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;
    // The tag is normalized the same way the mutation stores it, so validate
    // the normalized value. Block the save (and surface an inline error) if the
    // tag or name collides with another role in the space.
    const normalizedTag = roleTag.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const conflict = findRoleConflict(
      allRoles,
      { roleTag: normalizedTag, displayName },
      role.roleId,
    );
    if (conflict) {
      setConflictError(
        conflict.field === 'roleTag'
          ? `Tag "@${normalizedTag}" is already used by another role`
          : `Name "${displayName.trim()}" is already used by another role`,
      );
      return;
    }
    setConflictError(null);
    try {
      await updateRoleMutation.mutateAsync({
        spaceId,
        roleId: role.roleId,
        displayName,
        roleTag: normalizedTag,
        permissions,
        isPublic,
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to save role');
    }
  }, [spaceId, role.roleId, allRoles, displayName, roleTag, permissions, isPublic, hasChanges, updateRoleMutation]);

  // Auto-save when permissions or isPublic change (toggle actions)
  const isInitialMount = React.useRef(true);
  React.useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (hasChanges) {
      handleSave();
    }
  }, [permissions, isPublic]);

  const togglePermission = useCallback((perm: Permission) => {
    setPermissions(prev =>
      prev.includes(perm) ? prev.filter(p => p !== perm) : [...prev, perm]
    );
  }, []);

  return (
    <View style={styles.roleItem}>
      <View style={styles.roleHeader}>
        <View style={[styles.roleColorDot, { backgroundColor: role.color }]} />
        <View style={styles.roleInfo}>
          <TextInput
            style={[styles.roleNameInput, { color: role.color }]}
            value={displayName}
            onChangeText={(text) => { setDisplayName(text); setConflictError(null); }}
            onBlur={handleSave}
            placeholder="Role Name"
            placeholderTextColor={theme.colors.textMuted}
          />
          <View style={styles.roleTagRow}>
            <Text style={styles.roleTagPrefix}>@</Text>
            <TextInput
              style={styles.roleTagInput}
              value={roleTag}
              onChangeText={(text) => { setRoleTag(text.toLowerCase().replace(/[^a-z0-9_]/g, '')); setConflictError(null); }}
              onBlur={handleSave}
              placeholder="tag"
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
          {conflictError ? (
            <Text style={styles.roleConflictError}>{conflictError}</Text>
          ) : null}
        </View>
        <View style={styles.roleActions}>
          <TouchableOpacity
            style={styles.roleActionButton}
            onPress={() => {
              setIsPublic(!isPublic);
            }}
          >
            <IconSymbol
              name={isPublic ? 'eye' : 'eye.slash'}
              size={18}
              color={theme.colors.textMuted}
            />
          </TouchableOpacity>
          <TouchableOpacity style={styles.roleActionButton} onPress={onDelete}>
            <IconSymbol name="trash" size={18} color={theme.colors.danger} />
          </TouchableOpacity>
        </View>
      </View>

      {/* Permissions section */}
      <TouchableOpacity
        style={styles.rolePermissionsHeader}
        onPress={() => setShowPermissions(!showPermissions)}
      >
        <Text style={styles.rolePermissionsLabel}>Permissions:</Text>
        <Text style={styles.rolePermissionsValue}>
          {permissions.length > 0
            ? permissions.map(p => p.split(':')[1]).join(', ')
            : 'None'}
        </Text>
        <IconSymbol
          name={showPermissions ? 'chevron.up' : 'chevron.down'}
          size={14}
          color={theme.colors.textMuted}
        />
      </TouchableOpacity>

      {showPermissions && (
        <View style={styles.permissionsList}>
          {AVAILABLE_PERMISSIONS.map((perm) => (
            <TouchableOpacity
              key={perm.value}
              style={styles.permissionItem}
              onPress={() => {
                togglePermission(perm.value);
              }}
            >
              <View style={[
                styles.permissionCheckbox,
                permissions.includes(perm.value) && styles.permissionCheckboxChecked
              ]}>
                {permissions.includes(perm.value) && (
                  <IconSymbol name="checkmark" size={12} color="#fff" />
                )}
              </View>
              <Text style={styles.permissionLabel}>{perm.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {updateRoleMutation.isPending && (
        <View style={styles.roleSavingIndicator}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
        </View>
      )}
    </View>
  );
}

const APEX_TOKEN_CHOICES: ApexToken[] = ['wQUIL', 'SNAP', 'USDC'];
const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Apex section (General tab, owner-only) — publish which token this space
 * accepts for Quorum Apex subscriptions and the ETH address payouts go to.
 * Inline success/error feedback only: this sits inside a native modal, so
 * root toasts would render underneath it.
 */
function ApexConfigSection({
  spaceAddress,
  theme,
  styles,
}: {
  spaceAddress: string;
  theme: AppTheme;
  styles: ReturnType<typeof createStyles>;
}) {
  const { data: existingConfig, isLoading: isConfigLoading } = useSpaceApexConfig(spaceAddress);
  const setApexConfig = useSetSpaceApexConfig();
  const { builtinWallet } = useWalletSelection();

  const [token, setToken] = useState<ApexToken>('wQUIL');
  const [payoutAddress, setPayoutAddress] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null
  );

  // Populate from the published config once it loads; otherwise prefill
  // the payout with the owner's built-in ETH wallet address.
  const initializedRef = React.useRef(false);
  useEffect(() => {
    if (initializedRef.current) return;
    if (existingConfig) {
      initializedRef.current = true;
      setToken(existingConfig.token);
      setPayoutAddress(existingConfig.payout_address);
    } else if (existingConfig === null && builtinWallet?.address) {
      initializedRef.current = true;
      setPayoutAddress(builtinWallet.address);
    }
  }, [existingConfig, builtinWallet?.address]);

  const trimmedAddress = payoutAddress.trim();
  // The zero address is rejected everywhere downstream (payment service,
  // contract, server) because ERC20 transfers to it revert or burn — fail
  // it here so the owner finds out before saving.
  const isZeroAddress =
    trimmedAddress.toLowerCase() === '0x0000000000000000000000000000000000000000';
  const isValidAddress = ETH_ADDRESS_RE.test(trimmedAddress) && !isZeroAddress;
  const addressError =
    trimmedAddress.length > 0 && !isValidAddress
      ? isZeroAddress
        ? 'The zero address would burn payments — use a real wallet address'
        : 'Enter a valid Ethereum address (0x + 40 hex characters)'
      : null;

  const handleSave = () => {
    if (!isValidAddress || setApexConfig.isPending) return;
    setFeedback(null);
    setApexConfig.mutate(
      {
        spaceAddress,
        token,
        payoutAddress: trimmedAddress,
      },
      {
        onSuccess: () => setFeedback({ type: 'success', text: 'Apex settings saved.' }),
        onError: (error) =>
          setFeedback({
            type: 'error',
            text: getErrorMessage(error) || 'Failed to save Apex settings.',
          }),
      }
    );
  };

  return (
    <>
      <View style={styles.divider} />
      <Text style={styles.sectionTitle}>Apex</Text>
      <Text style={styles.sectionDescription}>
        Let Apex subscribers support this space. Choose the token you accept and where payouts go.
      </Text>
      {existingConfig?.subscriber_count != null && (
        <Text style={[styles.sectionDescription, { marginTop: Skin.space(8) }]}>
          {existingConfig.subscriber_count} active subscriber
          {existingConfig.subscriber_count === 1 ? '' : 's'} currently support
          {existingConfig.subscriber_count === 1 ? 's' : ''} this space.
        </Text>
      )}

      {/* Token chips */}
      <View style={{ flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(12) }}>
        {APEX_TOKEN_CHOICES.map((choice) => {
          const isSelected = token === choice;
          return (
            <TouchableOpacity
              key={choice}
              onPress={() => {
                setToken(choice);
                setFeedback(null);
              }}
              style={{
                paddingVertical: Skin.space(8),
                paddingHorizontal: Skin.space(16),
                borderRadius: Skin.radius(16),
                backgroundColor: isSelected ? theme.colors.primary : theme.colors.surface2,
              }}
            >
              <Text
                style={{
                  fontSize: Skin.font(13),
                  fontWeight: '600',
                  color: isSelected ? '#fff' : theme.colors.textMain,
                }}
              >
                {choice}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Payout address */}
      <Text style={[styles.sectionDescription, { marginTop: Skin.space(16), marginBottom: Skin.space(4) }]}>
        Payout address (Ethereum)
      </Text>
      <TextInput
        value={payoutAddress}
        onChangeText={(text) => {
          setPayoutAddress(text);
          setFeedback(null);
        }}
        placeholder="0x…"
        placeholderTextColor={theme.colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={{
          backgroundColor: theme.colors.surface2,
          color: theme.colors.textMain,
          borderRadius: Skin.radius(10),
          padding: Skin.space(12),
          fontSize: Skin.font(14),
        }}
      />
      {addressError && <Text style={styles.errorText}>{addressError}</Text>}
      {feedback && (
        <Text
          style={{
            fontSize: Skin.font(13),
            marginTop: Skin.space(6),
            color: feedback.type === 'success' ? (theme.colors.success ?? '#22c55e') : theme.colors.danger,
          }}
        >
          {feedback.text}
        </Text>
      )}

      <TouchableOpacity
        onPress={handleSave}
        disabled={!isValidAddress || setApexConfig.isPending || isConfigLoading}
        style={{
          marginTop: Skin.space(12),
          alignSelf: 'flex-start',
          paddingVertical: Skin.space(10),
          paddingHorizontal: Skin.space(20),
          borderRadius: Skin.radius(10),
          backgroundColor:
            isValidAddress && !setApexConfig.isPending && !isConfigLoading
              ? theme.colors.primary
              : theme.colors.surface3,
          opacity: isValidAddress && !setApexConfig.isPending && !isConfigLoading ? 1 : 0.6,
        }}
      >
        {setApexConfig.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: Skin.font(14) }}>
            Save Apex settings
          </Text>
        )}
      </TouchableOpacity>
    </>
  );
}

export default function SpaceSettingsModal({
  visible,
  onClose,
  spaceId,
  onSpaceDeleted,
  onSpaceLeft,
  isUserMuted,
  onToggleMuteUser,
}: SpaceSettingsModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();

  // Determine if user is space owner
  const isSpaceOwner = useMemo(() => {
    const ownerKey = getSpaceKey(spaceId, 'owner');
    return !!ownerKey;
  }, [spaceId]);

  // Tapping a member avatar opens their profile (same as tapping an avatar on
  // a message). This is the members-list entry point for viewing a profile,
  // messaging/muting the user, and — for owners — assigning/removing roles.
  const [selectedUserProfile, setSelectedUserProfile] = useState<UserProfileInfo | null>(null);
  const startDirectMessage = useStartDirectMessage();
  // Own the mute logic locally (same hook the channel screen uses) so the
  // members-list profile modal can Mute/Unmute regardless of whether the
  // parent passed mute props. Falls back to the parent props if provided.
  const { toggleMuteUser: localToggleMuteUser, isUserMuted: localIsUserMuted } = useUserMuting(spaceId);
  const toggleMuteUser = onToggleMuteUser ?? localToggleMuteUser;
  const isUserMutedFn = isUserMuted ?? localIsUserMuted;

  // Load space data
  const [space, setSpace] = useState<Space | null>(null);
  useEffect(() => {
    if (visible && spaceId) {
      const loadedSpace = getSpace(spaceId);
      setSpace(loadedSpace);
    }
  }, [visible, spaceId]);

  // Per-space notification preference. Anyone can mute/unmute their
  // own copy of a space — this is a local user setting, not a
  // space-wide config. Persisted in MMKV; gates
  // showMessageNotification at presentation time.
  const [spaceNotificationsOn, setSpaceNotificationsOn] = useState<boolean>(() =>
    getSpaceNotificationsEnabled(spaceId),
  );
  useEffect(() => {
    if (visible && spaceId) {
      setSpaceNotificationsOn(getSpaceNotificationsEnabled(spaceId));
    }
  }, [visible, spaceId]);
  const handleToggleSpaceNotifications = useCallback((next: boolean) => {
    setSpaceNotificationsOn(next);
    setSpaceNotificationsEnabled(spaceId, next);
  }, [spaceId]);

  // Per-channel notification preferences. Map keyed by channelId
  // mirrors what's in MMKV; we re-read on open so a fresh modal
  // shows current state. Channel-level mute is independent of the
  // space-level toggle — if the space is muted nothing notifies
  // regardless of channel toggle (gating is in
  // services/notifications/pushReceivedTask.ts).
  const [channelNotifMap, setChannelNotifMap] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!visible || !spaceId || !space) return;
    const next: Record<string, boolean> = {};
    for (const group of space.groups ?? []) {
      for (const ch of group.channels ?? []) {
        next[ch.channelId] = getChannelNotificationsEnabled(spaceId, ch.channelId);
      }
    }
    setChannelNotifMap(next);
  }, [visible, spaceId, space]);
  const handleToggleChannelNotifications = useCallback(
    (channelId: string, next: boolean) => {
      setChannelNotifMap(prev => ({ ...prev, [channelId]: next }));
      setChannelNotificationsEnabled(spaceId, channelId, next);
    },
    [spaceId],
  );

  // Per-space profile — overrides the user's global profile for this
  // space only. Stored on the SpaceMember record keyed by
  // (spaceId, userAddress). The receive-side update-profile handler
  // is upsert-aware (only writes fields that are present), so we
  // only broadcast fields the user actually edited.
  const [spaceProfileDisplayName, setSpaceProfileDisplayName] = useState<string>('');
  const [spaceProfileBio, setSpaceProfileBio] = useState<string>('');
  const [spaceProfileImage, setSpaceProfileImage] = useState<string>('');
  // Snapshot of the values that are currently on the SpaceMember
  // record — used to compute "did anything actually change" so we
  // only broadcast when the user pressed Save after editing
  // something. Also lets the Save button disable itself when
  // there's nothing to send.
  const [spaceProfileBaseline, setSpaceProfileBaseline] = useState<{
    displayName: string;
    bio: string;
    profileImage: string;
  }>({ displayName: '', bio: '', profileImage: '' });
  const [spaceProfileSaving, setSpaceProfileSaving] = useState(false);

  useEffect(() => {
    if (!visible || !spaceId || !user?.address) return;
    let cancelled = false;
    (async () => {
      try {
        const adapter = getMMKVAdapter();
        const member = await adapter.getSpaceMember(spaceId, user.address);
        if (cancelled) return;
        const displayName = member?.display_name ?? '';
        const bio = member?.bio ?? '';
        const profileImage = member?.profile_image ?? '';
        setSpaceProfileDisplayName(displayName);
        setSpaceProfileBio(bio);
        setSpaceProfileImage(profileImage);
        setSpaceProfileBaseline({ displayName, bio, profileImage });
      } catch {
        // Member record missing or unreadable — leave fields empty.
      }
    })();
    return () => { cancelled = true; };
  }, [visible, spaceId, user?.address]);

  const handlePickSpaceProfileImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Photo library access is needed to change your space avatar.');
      return;
    }
    // base64 deferred to compressAvatarImage which enforces a hard
    // size cap so a giant phone photo can't bloat the broadcast or
    // the public-profile JSON for this user.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      base64: false,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const compressed = await compressAvatarImage(
        asset.uri,
        asset.width ?? 512,
        asset.height ?? 512,
      );
      if (!compressed) {
        Alert.alert('Could not process image', 'Try a smaller photo.');
        return;
      }
      setSpaceProfileImage(compressed.dataUri);
    }
  }, []);

  const spaceProfileDirty =
    spaceProfileDisplayName !== spaceProfileBaseline.displayName ||
    spaceProfileBio !== spaceProfileBaseline.bio ||
    spaceProfileImage !== spaceProfileBaseline.profileImage;

  const handleSaveSpaceProfile = useCallback(async () => {
    if (!user?.address || !space || !spaceProfileDirty || spaceProfileSaving) return;
    setSpaceProfileSaving(true);
    try {
      // Optimistically update the local SpaceMember so the UI
      // reflects the new values immediately. Receivers apply the
      // same fields on their end when our update-profile broadcast
      // lands. Note: clearing fields (e.g. removing the avatar)
      // works locally but the current update-profile wire shape
      // skips empty fields, so other members keep seeing the old
      // value until we add a clear-field signal. Tracked as a known
      // limitation; flag if you hit it.
      const adapter = getMMKVAdapter();
      const existing = await adapter.getSpaceMember(spaceId, user.address);
      const merged = {
        ...(existing ?? {}),
        address: user.address,
        inbox_address: existing?.inbox_address ?? '',
        display_name: spaceProfileDisplayName,
        bio: spaceProfileBio,
        profile_image: spaceProfileImage,
      };
      await adapter.saveSpaceMember(spaceId, merged as never);

      // Broadcast — only fields that actually changed since baseline
      // get included so we don't clobber stale fields with empty
      // values. maybeSendUpdateProfileMessage gates duplicate sends.
      const channelId = space.defaultChannelId;
      const params: {
        spaceId: string;
        channelId: string;
        senderAddress: string;
        displayName?: string;
        userIcon?: string;
        bio?: string;
        farcasterFid?: number;
        farcasterUsername?: string;
      } = {
        spaceId,
        channelId,
        senderAddress: user.address,
      };
      if (spaceProfileDisplayName !== spaceProfileBaseline.displayName) {
        params.displayName = spaceProfileDisplayName || undefined;
      }
      if (spaceProfileBio !== spaceProfileBaseline.bio) {
        params.bio = spaceProfileBio;
      }
      if (spaceProfileImage !== spaceProfileBaseline.profileImage) {
        params.userIcon = spaceProfileImage || undefined;
      }
      // Auto-include Farcaster linkage whenever the user has one.
      // The broadcast gate (maybeSendUpdateProfileMessage) dedupes
      // against the previous signature, so re-saving without
      // Farcaster changes won't re-send. Receivers persist these
      // onto SpaceMember for use in UserProfileModal.
      if (user.farcaster?.fid && user.farcaster.fid > 0) {
        params.farcasterFid = user.farcaster.fid;
        if (user.farcaster.username) {
          params.farcasterUsername = user.farcaster.username;
        }
      }
      const res = await maybeSendUpdateProfileMessage(params);
      if (res) {
        enqueueOutbound(async () => [res.wsEnvelope]);
      }

      setSpaceProfileBaseline({
        displayName: spaceProfileDisplayName,
        bio: spaceProfileBio,
        profileImage: spaceProfileImage,
      });
    } catch (e) {
      Alert.alert('Save failed', e instanceof Error ? e.message : 'Could not update your profile for this space.');
    } finally {
      setSpaceProfileSaving(false);
    }
  }, [
    user?.address,
    space,
    spaceId,
    spaceProfileDirty,
    spaceProfileSaving,
    spaceProfileDisplayName,
    spaceProfileBio,
    spaceProfileImage,
    spaceProfileBaseline,
    enqueueOutbound,
  ]);

  // Tab state - default to 'account' for non-owners
  const [activeTab, setActiveTab] = useState<TabType>(isSpaceOwner ? 'general' : 'account');

  // Track content area height for ScrollView
  const [contentHeight, setContentHeight] = useState<number>(0);

  // Reset tab when modal opens
  useEffect(() => {
    if (visible) {
      setActiveTab(isSpaceOwner ? 'general' : 'account');
    }
  }, [visible, isSpaceOwner]);

  // Mutations
  const updateSpaceMutation = useUpdateSpace();
  const deleteSpaceMutation = useDeleteSpace();
  const leaveSpaceMutation = useLeaveSpace();

  // Roles
  const { data: roles = [] } = useRoles(spaceId);
  const addRoleMutation = useAddRole();
  const updateRoleMutation = useUpdateRole();
  const deleteRoleMutation = useDeleteRole();

  // Channels
  const addChannelMutation = useAddChannel();
  const updateChannelMutation = useUpdateChannel();
  const deleteChannelMutation = useDeleteChannel();
  const addGroupMutation = useAddGroup();
  const updateGroupMutation = useUpdateGroup();
  const deleteGroupMutation = useDeleteGroup();
  const moveChannelMutation = useMoveChannel();
  const reorderChannelsMutation = useReorderChannels();

  // Members
  const { data: members = [] } = useSpaceMembers(spaceId, { enabled: !!spaceId });

  // Invites
  const generateInviteMutation = useGenerateInvite();
  const generatePublicInviteMutation = useGeneratePublicInvite();

  // General tab state
  const [spaceName, setSpaceName] = useState('');
  const [description, setDescription] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [bannerUrl, setBannerUrl] = useState('');
  const [isRepudiable, setIsRepudiable] = useState(true);

  // Initialize form when space loads
  useEffect(() => {
    if (space) {
      setSpaceName(space.spaceName);
      setDescription(space.description || '');
      setIconUrl(space.iconUrl || '');
      setBannerUrl(space.bannerUrl || '');
      setIsRepudiable(space.isRepudiable);
    }
  }, [space]);

  // Invite state
  const [generatedInviteLink, setGeneratedInviteLink] = useState<string | null>(null);
  const [generatedInviteType, setGeneratedInviteType] = useState<'private' | 'public' | null>(null);
  const [inviteType, setInviteType] = useState<'private' | 'public'>('private');
  const [hasLoadedExistingInvite, setHasLoadedExistingInvite] = useState(false);

  // Check for existing public invite URL when modal opens or tab changes to invites
  // Only run once per modal open to avoid overriding user actions
  useEffect(() => {
    if (visible && spaceId && activeTab === 'invites' && !hasLoadedExistingInvite) {
      const spaceData = getSpace(spaceId);
      if (spaceData?.inviteUrl) {
        // Space already has a public invite URL - show it
        setGeneratedInviteLink(spaceData.inviteUrl);
        setGeneratedInviteType('public');
        setInviteType('public');
      }
      setHasLoadedExistingInvite(true);
    }
  }, [visible, spaceId, activeTab, hasLoadedExistingInvite]);

  // Directory submission
  const [directorySubmitting, setDirectorySubmitting] = useState(false);
  const [directorySubmitted, setDirectorySubmitted] = useState(false);

  // Delete/Leave confirmation
  const [showDeleteSpaceConfirm, setShowDeleteSpaceConfirm] = useState(false);
  const { confirm, confirmDialog } = useConfirmDialog();

  // Kick modal state
  const [kickTarget, setKickTarget] = useState<{
    address: string;
    displayName: string;
    userIcon?: string;
  } | null>(null);

  // Emoji/Sticker state
  const [isUploadingEmoji, setIsUploadingEmoji] = useState(false);
  const [isUploadingSticker, setIsUploadingSticker] = useState(false);
  const [editingEmojiId, setEditingEmojiId] = useState<string | null>(null);
  const [editingStickerName, setEditingStickerName] = useState<string | null>(null);
  const [editingEmojiName, setEditingEmojiName] = useState('');
  const [editingStickerNameValue, setEditingStickerNameValue] = useState('');

  // Channel/Group editing state
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editingChannelName, setEditingChannelName] = useState('');
  const [editingGroupIndex, setEditingGroupIndex] = useState<number | null>(null);
  const [editingGroupName, setEditingGroupName] = useState('');
  const [newChannelGroupIndex, setNewChannelGroupIndex] = useState<number | null>(null);
  const [newChannelName, setNewChannelName] = useState('');

  // Icon picker state
  const [iconPickerVisible, setIconPickerVisible] = useState(false);
  const [iconPickerChannelId, setIconPickerChannelId] = useState<string | null>(null);

  // Validation
  const nameError = useMemo(
    () => translateValidationResult(validateSpaceName(spaceName)) ?? null,
    [spaceName]
  );

  const descriptionError = useMemo(
    () =>
      translateValidationResults(
        validateSpaceDescription(description, MAX_DESCRIPTION_LENGTH)
      )[0] ?? null,
    [description]
  );

  const hasGeneralChanges = useMemo(() => {
    if (!space) return false;
    return (
      spaceName.trim() !== space.spaceName ||
      description.trim() !== (space.description || '') ||
      iconUrl !== (space.iconUrl || '') ||
      bannerUrl !== (space.bannerUrl || '') ||
      isRepudiable !== space.isRepudiable
    );
  }, [space, spaceName, description, iconUrl, bannerUrl, isRepudiable]);

  // Handlers
  const handleClose = useCallback(() => {
    setGeneratedInviteLink(null);
    setGeneratedInviteType(null);
    setInviteType('private');
    setHasLoadedExistingInvite(false);
    setShowDeleteSpaceConfirm(false);
    setKickTarget(null);
    onClose();
  }, [onClose]);

  const handleSaveGeneral = useCallback(async () => {
    if (nameError || descriptionError) return;

    try {
      await updateSpaceMutation.mutateAsync({
        spaceId,
        spaceName: spaceName.trim(),
        // keep "" so a cleared description saves (undefined would fall back to the old value)
        description: description.trim(),
        iconUrl: iconUrl || undefined,
        bannerUrl: bannerUrl || undefined,
        isRepudiable,
      });
      // Reload space
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to save changes');
    }
  }, [spaceId, spaceName, description, iconUrl, bannerUrl, isRepudiable, nameError, descriptionError, updateSpaceMutation]);

  const handlePickIcon = useCallback(async () => {
    const result = await pickImage('library');
    if (result.success && result.attachment) {
      setIconUrl(result.attachment.imageUrl);
    }
  }, []);

  const handlePickBanner = useCallback(async () => {
    const result = await pickImage('library');
    if (result.success && result.attachment) {
      setBannerUrl(result.attachment.imageUrl);
    }
  }, []);

  const handleGenerateInvite = useCallback(async () => {
    try {
      if (inviteType === 'public') {
        const result = await generatePublicInviteMutation.mutateAsync({ spaceId });
        setGeneratedInviteLink(result.inviteLink);
        setGeneratedInviteType('public');
      } else {
        const result = await generateInviteMutation.mutateAsync({ spaceId });
        setGeneratedInviteLink(result.inviteLink);
        setGeneratedInviteType('private');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to generate invite link');
    }
  }, [spaceId, inviteType, generateInviteMutation, generatePublicInviteMutation]);

  const handleCopyInvite = useCallback(async () => {
    if (generatedInviteLink) {
      await Clipboard.setStringAsync(generatedInviteLink);
      Alert.alert('Copied', 'Invite link copied to clipboard');
    }
  }, [generatedInviteLink]);

  // Share now opens the in-app contact picker first (ShareInviteSheet);
  // the OS share sheet is one tap deeper via the sheet's "More options".
  const [shareSheetVisible, setShareSheetVisible] = useState(false);
  const handleShareInvite = useCallback(() => {
    if (generatedInviteLink && space) {
      setShareSheetVisible(true);
    }
  }, [generatedInviteLink, space]);

  // Emoji handlers
  const handleUploadEmoji = useCallback(async () => {
    if (!space || (space.emojis?.length ?? 0) >= MAX_EMOJIS) {
      Alert.alert('Limit Reached', `You can only have ${MAX_EMOJIS} custom emojis`);
      return;
    }

    setIsUploadingEmoji(true);
    try {
      const result = await pickEmoji();
      if (result.cancelled) {
        setIsUploadingEmoji(false);
        return;
      }
      if (!result.success || !result.asset) {
        Alert.alert('Error', result.error || 'Failed to upload emoji');
        setIsUploadingEmoji(false);
        return;
      }

      const newEmoji: Emoji = {
        id: result.asset.id,
        name: result.asset.name,
        imgUrl: result.asset.imgUrl,
      };

      const updatedEmojis = [...(space.emojis || []), newEmoji];
      await updateSpaceMutation.mutateAsync({
        spaceId,
        emojis: updatedEmojis,
      });

      // Reload space
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to upload emoji');
    } finally {
      setIsUploadingEmoji(false);
    }
  }, [space, spaceId, updateSpaceMutation]);

  const handleDeleteEmoji = useCallback(async (emojiId: string) => {
    if (!space) return;

    const ok = await confirm({
      title: 'Delete Emoji',
      message: 'Are you sure you want to delete this emoji? This removes it for everyone in the space.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const updatedEmojis = (space.emojis || []).filter(e => e.id !== emojiId);
      await updateSpaceMutation.mutateAsync({
        spaceId,
        emojis: updatedEmojis,
      });

      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to delete emoji');
    }
  }, [space, spaceId, updateSpaceMutation, confirm]);

  const handleSaveEmojiName = useCallback(async (emojiId: string) => {
    if (!space || !editingEmojiName.trim()) {
      setEditingEmojiId(null);
      return;
    }

    const sanitized = editingEmojiName.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 32);
    if (!sanitized) {
      setEditingEmojiId(null);
      return;
    }

    try {
      const updatedEmojis = (space.emojis || []).map(e =>
        e.id === emojiId ? { ...e, name: sanitized } : e
      );
      await updateSpaceMutation.mutateAsync({
        spaceId,
        emojis: updatedEmojis,
      });

      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to rename emoji');
    } finally {
      setEditingEmojiId(null);
    }
  }, [space, spaceId, editingEmojiName, updateSpaceMutation]);

  // Sticker handlers
  const handleUploadSticker = useCallback(async () => {
    if (!space || (space.stickers?.length ?? 0) >= MAX_STICKERS) {
      Alert.alert('Limit Reached', `You can only have ${MAX_STICKERS} custom stickers`);
      return;
    }

    setIsUploadingSticker(true);
    try {
      const result = await pickSticker();
      if (result.cancelled) {
        setIsUploadingSticker(false);
        return;
      }
      if (!result.success || !result.asset) {
        Alert.alert('Error', result.error || 'Failed to upload sticker');
        setIsUploadingSticker(false);
        return;
      }

      const newSticker: Sticker = {
        id: result.asset.id,
        name: result.asset.name,
        imgUrl: result.asset.imgUrl,
      };

      const updatedStickers = [...(space.stickers || []), newSticker];
      await updateSpaceMutation.mutateAsync({
        spaceId,
        stickers: updatedStickers,
      });

      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to upload sticker');
    } finally {
      setIsUploadingSticker(false);
    }
  }, [space, spaceId, updateSpaceMutation]);

  const handleDeleteSticker = useCallback(async (stickerId: string) => {
    if (!space) return;

    const ok = await confirm({
      title: 'Delete Sticker',
      message: 'Are you sure you want to delete this sticker? This removes it for everyone in the space.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      const updatedStickers = (space.stickers || []).filter(s => s.id !== stickerId);
      await updateSpaceMutation.mutateAsync({
        spaceId,
        stickers: updatedStickers,
      });

      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to delete sticker');
    }
  }, [space, spaceId, updateSpaceMutation, confirm]);

  const handleSaveStickerName = useCallback(async (stickerId: string) => {
    if (!space || !editingStickerNameValue.trim()) {
      setEditingStickerName(null);
      return;
    }

    const sanitized = editingStickerNameValue.toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 32);
    if (!sanitized) {
      setEditingStickerName(null);
      return;
    }

    try {
      const updatedStickers = (space.stickers || []).map(s =>
        s.id === stickerId ? { ...s, name: sanitized } : s
      );
      await updateSpaceMutation.mutateAsync({
        spaceId,
        stickers: updatedStickers,
      });

      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to rename sticker');
    } finally {
      setEditingStickerName(null);
    }
  }, [space, spaceId, editingStickerNameValue, updateSpaceMutation]);

  const handleAddRole = useCallback(async () => {
    try {
      // Auto-numbered unique defaults ("New Role 2", "newrole-2", …) so
      // repeatedly tapping add never creates duplicate-named roles (this
      // section auto-saves; there is no save gate to validate against).
      const { displayName, roleTag } = getUniqueRoleDefaults(roles);
      await addRoleMutation.mutateAsync({
        spaceId,
        displayName,
        roleTag,
        // color omitted — the hook derives a stable token from the roleId.
        permissions: [],
        isPublic: true,
      });
    } catch (error) {
      Alert.alert('Error', 'Failed to add role');
    }
  }, [spaceId, addRoleMutation, roles]);

  const handleDeleteRole = useCallback(async (roleId: string) => {
    const ok = await confirm({
      title: 'Delete Role',
      message: 'Are you sure you want to delete this role? It will be removed from every member who has it. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteRoleMutation.mutateAsync({ spaceId, roleId });
    } catch (error) {
      Alert.alert('Error', 'Failed to delete role');
    }
  }, [spaceId, deleteRoleMutation, confirm]);

  // Channel/Group handlers
  const handleAddGroup = useCallback(async () => {
    try {
      await addGroupMutation.mutateAsync({
        spaceId,
        groupName: 'New Group',
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to add group');
    }
  }, [spaceId, addGroupMutation]);

  const handleSaveGroupName = useCallback(async (groupIndex: number) => {
    if (!editingGroupName.trim()) {
      setEditingGroupIndex(null);
      return;
    }
    try {
      await updateGroupMutation.mutateAsync({
        spaceId,
        groupIndex,
        groupName: editingGroupName.trim(),
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to update group');
    } finally {
      setEditingGroupIndex(null);
    }
  }, [spaceId, editingGroupName, updateGroupMutation]);

  const handleDeleteGroup = useCallback(async (groupIndex: number) => {
    const group = space?.groups[groupIndex];
    if (!group) return;

    if (group.channels.length > 0) {
      Alert.alert('Cannot Delete', 'Please delete or move all channels first');
      return;
    }

    const ok = await confirm({
      title: 'Delete Group',
      message: `Are you sure you want to delete "${group.groupName}"? This removes the group for everyone in the space.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteGroupMutation.mutateAsync({ spaceId, groupIndex });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to delete group');
    }
  }, [space, spaceId, deleteGroupMutation, confirm]);

  const handleAddChannel = useCallback(async (groupIndex: number) => {
    if (!newChannelName.trim()) {
      setNewChannelGroupIndex(null);
      return;
    }
    try {
      await addChannelMutation.mutateAsync({
        spaceId,
        groupIndex,
        channelName: newChannelName.trim(),
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
      setNewChannelName('');
      setNewChannelGroupIndex(null);
    } catch (error) {
      Alert.alert('Error', 'Failed to add channel');
    }
  }, [spaceId, newChannelName, addChannelMutation]);

  const handleSaveChannelName = useCallback(async (channelId: string) => {
    if (!editingChannelName.trim()) {
      setEditingChannelId(null);
      return;
    }
    try {
      await updateChannelMutation.mutateAsync({
        spaceId,
        channelId,
        channelName: editingChannelName.trim(),
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error) {
      Alert.alert('Error', 'Failed to update channel');
    } finally {
      setEditingChannelId(null);
    }
  }, [spaceId, editingChannelName, updateChannelMutation]);

  const handleDeleteChannel = useCallback(async (channelId: string, channelName: string) => {
    const ok = await confirm({
      title: 'Delete Channel',
      message: `Are you sure you want to delete #${channelName}? This removes the channel and its messages for everyone. This cannot be undone.`,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await deleteChannelMutation.mutateAsync({ spaceId, channelId });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch (error: unknown) {
      if (error instanceof Error && error.message?.includes('default channel')) {
        Alert.alert('Cannot Delete', 'You cannot delete the default channel');
      } else {
        Alert.alert('Error', 'Failed to delete channel');
      }
    }
  }, [spaceId, deleteChannelMutation, confirm]);

  const handleMoveChannelUp = useCallback(async (groupIndex: number, channelIndex: number) => {
    if (channelIndex === 0) return;
    const group = space?.groups[groupIndex];
    if (!group) return;

    const channel = group.channels[channelIndex];
    try {
      await moveChannelMutation.mutateAsync({
        spaceId,
        channelId: channel.channelId,
        fromGroupIndex: groupIndex,
        toGroupIndex: groupIndex,
        toPosition: channelIndex - 1,
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch {
      // Mutation handles its own error state
    }
  }, [space, spaceId, moveChannelMutation]);

  const handleMoveChannelDown = useCallback(async (groupIndex: number, channelIndex: number) => {
    const group = space?.groups[groupIndex];
    if (!group || channelIndex >= group.channels.length - 1) return;

    const channel = group.channels[channelIndex];
    try {
      await moveChannelMutation.mutateAsync({
        spaceId,
        channelId: channel.channelId,
        fromGroupIndex: groupIndex,
        toGroupIndex: groupIndex,
        toPosition: channelIndex + 1,
      });
      const updated = getSpace(spaceId);
      setSpace(updated);
    } catch {
      // Mutation handles its own error state
    }
  }, [space, spaceId, moveChannelMutation]);

  const handleDeleteSpace = useCallback(async () => {
    setShowDeleteSpaceConfirm(false);
    try {
      await deleteSpaceMutation.mutateAsync({ spaceId });
      handleClose();
      onSpaceDeleted?.();
    } catch (error) {
      Alert.alert('Error', 'Failed to delete space');
    }
  }, [spaceId, deleteSpaceMutation, handleClose, onSpaceDeleted]);

  // Channel + member counts shown in the Delete-Space type-to-confirm modal
  // (mirrors desktop's Danger.tsx stats).
  const deleteSpaceStats = useMemo(
    () => [
      { label: 'Channels', value: (space?.groups ?? []).reduce((n, g) => n + (g.channels?.length ?? 0), 0) },
      { label: 'Members', value: members.length },
    ],
    [space?.groups, members.length],
  );

  const handleLeaveSpace = useCallback(async () => {
    const ok = await confirm({
      title: 'Leave Space',
      message: "You won't be able to rejoin unless you are re-invited. Your existing messages will NOT be deleted.",
      confirmLabel: 'Leave Space',
    });
    if (!ok) return;
    try {
      await leaveSpaceMutation.mutateAsync({ spaceId });
      handleClose();
      onSpaceLeft?.();
    } catch (error) {
      Alert.alert('Error', 'Failed to leave space');
    }
  }, [spaceId, leaveSpaceMutation, handleClose, onSpaceLeft, confirm]);

  // Owner tabs
  const ownerTabs: { key: TabType; label: string; icon: string }[] = [
    { key: 'general', label: 'General', icon: 'gearshape' },
    { key: 'account', label: 'Account', icon: 'person' },
    { key: 'members', label: 'Members', icon: 'person.2' },
    { key: 'channels', label: 'Channels', icon: 'number' },
    { key: 'linked', label: 'Linked', icon: 'link' },
    { key: 'roles', label: 'Roles', icon: 'shield' },
    { key: 'emojis', label: 'Emojis', icon: 'face.smiling' },
    { key: 'stickers', label: 'Stickers', icon: 'star' },
    { key: 'invites', label: 'Invites', icon: 'square.and.arrow.up' },
    { key: 'danger', label: 'Danger', icon: 'exclamationmark.triangle' },
  ];

  // Non-owner tabs
  const memberTabs: { key: TabType; label: string; icon: string }[] = [
    { key: 'account', label: 'Account', icon: 'person' },
    { key: 'members', label: 'Members', icon: 'person.2' },
  ];

  const tabs = isSpaceOwner ? ownerTabs : memberTabs;

  // Tab content renderers
  const renderGeneralTab = () => (
    <View
      style={styles.tabContentWrapper}
      onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)}
    >
      <ScrollView
        style={contentHeight > 0 ? { height: contentHeight } : undefined}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.generalTabContainer}
      >
      {/* Space Name */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Space Name</Text>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={spaceName}
            onChangeText={setSpaceName}
            placeholder="Enter space name"
            placeholderTextColor={theme.colors.textMuted}
            maxLength={MAX_NAME_LENGTH}
          />
        </View>
        {spaceName.length > 0 && nameError && (
          <Text style={styles.errorText}>{nameError}</Text>
        )}
      </View>

      {/* Description */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Description</Text>
        <View style={[styles.inputContainer, styles.textAreaContainer]}>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Enter description"
            placeholderTextColor={theme.colors.textMuted}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            maxLength={MAX_DESCRIPTION_LENGTH + 50}
          />
        </View>
        <View style={styles.charCountRow}>
          {descriptionError && <Text style={styles.errorText}>{descriptionError}</Text>}
          <Text style={[styles.charCount, descriptionError && styles.charCountError]}>
            {description.length}/{MAX_DESCRIPTION_LENGTH}
          </Text>
        </View>
      </View>

      {/* Icon */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Space Icon</Text>
        <TouchableOpacity style={styles.imagePickerButton} onPress={handlePickIcon}>
          {iconUrl ? (
            <Image source={{ uri: iconUrl }} style={styles.iconPreview} />
          ) : (
            <View style={styles.iconPlaceholder}>
              <IconSymbol name="photo" size={24} color={theme.colors.textMuted} />
            </View>
          )}
          <Text style={styles.imagePickerText}>
            {iconUrl ? 'Change Icon' : 'Upload Icon'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Banner */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Space Banner</Text>
        <TouchableOpacity style={styles.imagePickerButton} onPress={handlePickBanner}>
          {bannerUrl ? (
            <Image source={{ uri: bannerUrl }} style={styles.bannerPreview} />
          ) : (
            <View style={styles.bannerPlaceholder}>
              <IconSymbol name="photo" size={24} color={theme.colors.textMuted} />
            </View>
          )}
          <Text style={styles.imagePickerText}>
            {bannerUrl ? 'Change Banner' : 'Upload Banner'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Message signing toggle */}
      <View style={styles.toggleRow}>
        <View style={styles.toggleInfo}>
          <Text style={styles.toggleLabel}>Require Message Signing</Text>
          <Text style={styles.toggleDescription}>
            When enabled, senders confirm messages come from their key. When disabled, senders have plausible deniability.
          </Text>
        </View>
        <Switch
          value={!isRepudiable}
          onValueChange={(value) => setIsRepudiable(!value)}
          trackColor={{ false: theme.colors.surface4, true: theme.colors.primary }}
          thumbColor="#fff"
        />
      </View>

      {/* Save button at bottom of scroll content */}
      <TouchableOpacity
        style={[
          styles.saveButton,
          styles.generalSaveButton,
          !hasGeneralChanges && styles.saveButtonDisabled,
          (nameError || descriptionError) && styles.saveButtonDisabled,
        ]}
        onPress={handleSaveGeneral}
        disabled={!hasGeneralChanges || !!nameError || !!descriptionError || updateSpaceMutation.isPending}
      >
        {updateSpaceMutation.isPending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.saveButtonText}>Save Changes</Text>
        )}
      </TouchableOpacity>

      {/* Quorum Apex — owner-only (the General tab is owner-gated) */}
      <ApexConfigSection spaceAddress={spaceId} theme={theme} styles={styles} />
      </ScrollView>
    </View>
  );

  const renderAccountTab = () => (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.tabContentContainer}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.sectionTitle}>Your Profile in This Space</Text>
      <Text style={styles.sectionDescription}>
        Override your display name, avatar, and bio for this space only.
        Other spaces and your global profile are unaffected.
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: Skin.space(12) }}>
        <TouchableOpacity
          onPress={handlePickSpaceProfileImage}
          activeOpacity={0.8}
          style={{
            width: 72,
            height: 72,
            borderRadius: Skin.radius(36),
            backgroundColor: theme.colors.surface3,
            justifyContent: 'center',
            alignItems: 'center',
            overflow: 'hidden',
          }}
        >
          {spaceProfileImage ? (
            <Image source={{ uri: spaceProfileImage }} style={{ width: 72, height: 72 }} />
          ) : (
            <IconSymbol name="person.crop.circle" color={theme.colors.textMuted} size={36} />
          )}
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: Skin.space(16) }}>
          <Text style={[styles.sectionDescription, { marginBottom: Skin.space(4) }]}>Avatar</Text>
          <TouchableOpacity onPress={handlePickSpaceProfileImage}>
            <Text style={{ color: theme.colors.primary, fontSize: Skin.font(14) }}>
              {spaceProfileImage ? 'Change image' : 'Choose image'}
            </Text>
          </TouchableOpacity>
          {spaceProfileImage ? (
            <TouchableOpacity onPress={() => setSpaceProfileImage('')} style={{ marginTop: Skin.space(4) }}>
              <Text style={{ color: theme.colors.danger, fontSize: Skin.font(13) }}>Remove</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <Text style={[styles.sectionDescription, { marginTop: Skin.space(16), marginBottom: Skin.space(4) }]}>Display name</Text>
      <TextInput
        value={spaceProfileDisplayName}
        onChangeText={setSpaceProfileDisplayName}
        placeholder={user?.displayName || user?.username || 'Your name in this space'}
        placeholderTextColor={theme.colors.textMuted}
        maxLength={64}
        style={{
          backgroundColor: theme.colors.surface2,
          color: theme.colors.textMain,
          borderRadius: Skin.radius(10),
          padding: Skin.space(12),
          fontSize: Skin.font(15),
        }}
      />

      <Text style={[styles.sectionDescription, { marginTop: Skin.space(16), marginBottom: Skin.space(4) }]}>Bio</Text>
      <TextInput
        value={spaceProfileBio}
        onChangeText={setSpaceProfileBio}
        placeholder="Tell this space about yourself"
        placeholderTextColor={theme.colors.textMuted}
        multiline
        numberOfLines={3}
        maxLength={280}
        style={{
          backgroundColor: theme.colors.surface2,
          color: theme.colors.textMain,
          borderRadius: Skin.radius(10),
          padding: Skin.space(12),
          fontSize: Skin.font(15),
          minHeight: 72,
          textAlignVertical: 'top',
        }}
      />

      <TouchableOpacity
        onPress={handleSaveSpaceProfile}
        disabled={!spaceProfileDirty || spaceProfileSaving}
        style={{
          marginTop: Skin.space(12),
          alignSelf: 'flex-start',
          paddingVertical: Skin.space(10),
          paddingHorizontal: Skin.space(20),
          borderRadius: Skin.radius(10),
          backgroundColor: spaceProfileDirty && !spaceProfileSaving ? theme.colors.primary : theme.colors.surface3,
          opacity: spaceProfileDirty && !spaceProfileSaving ? 1 : 0.6,
        }}
      >
        {spaceProfileSaving ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: Skin.font(14) }}>Save profile</Text>
        )}
      </TouchableOpacity>

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Notifications</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: Skin.space(4) }}>
        <View style={{ flex: 1, paddingRight: Skin.space(12) }}>
          <Text style={styles.sectionDescription}>
            Notify me when messages are posted in this space.
          </Text>
        </View>
        <Switch
          value={spaceNotificationsOn}
          onValueChange={handleToggleSpaceNotifications}
          trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
          thumbColor={'#ffffff'}
        />
      </View>

      {/* Per-channel mute. Listed under the space toggle so users can
          turn the space on but silence specific noisy channels (or
          turn the space off but keep one channel unmuted — gating
          treats space-off as overriding, so the per-channel toggle
          really only matters when the space is on, but we keep them
          interactive either way to make the data model obvious). */}
      {(space?.groups ?? []).some(g => (g.channels ?? []).length > 0) && (
        <View style={{ marginTop: Skin.space(8) }}>
          <Text style={[styles.sectionDescription, { marginBottom: Skin.space(8), opacity: spaceNotificationsOn ? 1 : 0.5 }]}>
            Channels
          </Text>
          {(space?.groups ?? []).map(group => (
            (group.channels ?? []).map(channel => {
              const channelOn = channelNotifMap[channel.channelId] ?? true;
              return (
                <View
                  key={channel.channelId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: Skin.space(6),
                    opacity: spaceNotificationsOn ? 1 : 0.5,
                  }}
                >
                  <Text style={{ flex: 1, color: theme.colors.textMain, fontSize: Skin.font(14), paddingRight: Skin.space(12) }}>
                    # {channel.channelName}
                  </Text>
                  <Switch
                    value={channelOn}
                    onValueChange={(next) => handleToggleChannelNotifications(channel.channelId, next)}
                    trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
                    thumbColor={'#ffffff'}
                  />
                </View>
              );
            })
          ))}
        </View>
      )}

      {/* Leave space button (for non-owners) */}
      {!isSpaceOwner && (
        <>
          <View style={styles.divider} />
          <View style={styles.dangerSection}>
            <Text style={styles.dangerTitle}>Leave this Space</Text>
            <Text style={styles.dangerDescription}>
              You won't be able to rejoin unless you are re-invited. Your existing messages will NOT be deleted.
            </Text>
            <TouchableOpacity
              style={[styles.dangerButton, styles.dangerButtonOutline]}
              onPress={handleLeaveSpace}
              disabled={leaveSpaceMutation.isPending}
            >
              {leaveSpaceMutation.isPending ? (
                <ActivityIndicator size="small" color={theme.colors.danger} />
              ) : (
                <Text style={styles.dangerButtonOutlineText}>
                  Leave Space
                </Text>
              )}
            </TouchableOpacity>
          </View>
        </>
      )}
    </ScrollView>
  );

  // Helper to get roles for a member
  const getMemberRoles = (memberAddress: string): Role[] => {
    return roles.filter(role => role.members.includes(memberAddress));
  };


  const renderMembersTab = () => (
    <>
    <ScrollView
      style={styles.membersScrollView}
      showsVerticalScrollIndicator={true}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.tabContentContainer}
    >
        <Text style={styles.sectionDescription}>
          {members.length} member{members.length !== 1 ? 's' : ''} in this space
        </Text>

        {members.map((member) => {
          const memberRoles = getMemberRoles(member.address);
          return (
            <View key={member.address} style={styles.memberItem}>
              <TouchableOpacity
                style={styles.memberAvatar}
                activeOpacity={0.7}
                onPress={() => {
                  // Enrich with fields the SpaceMember record carries that the
                  // shared type doesn't declare (farcaster linkage).
                  const m = member as typeof member & {
                    farcasterFid?: number;
                    farcasterUsername?: string;
                  };
                  setSelectedUserProfile({
                    userId: member.address,
                    userName: member.display_name || member.name || truncateAddress(member.address),
                    userAvatar: member.profile_image,
                    bio: member.bio,
                    farcasterFid: m.farcasterFid,
                    farcasterUsername: m.farcasterUsername,
                  });
                }}
              >
                {member.profile_image ? (
                  <Image source={{ uri: member.profile_image }} style={styles.memberAvatarImage} />
                ) : (
                  <DefaultAvatar
                    displayName={member.display_name || member.name}
                    address={member.address}
                    size={44}
                  />
                )}
              </TouchableOpacity>
              <View style={styles.memberInfo}>
                <Text style={styles.memberName}>
                  {member.display_name || member.name || truncateAddress(member.address)}
                </Text>
                <Text style={styles.memberAddress}>{truncateAddress(member.address)}</Text>
                {memberRoles.length > 0 && (
                  <View style={styles.memberRolesRow}>
                    {memberRoles.map((role) => (
                      <View key={role.roleId} style={[styles.memberRoleBadge, { backgroundColor: role.color + '20' }]}>
                        <View style={[styles.memberRoleDot, { backgroundColor: role.color }]} />
                        <Text style={[styles.memberRoleText, { color: role.color }]}>{role.displayName}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              {member.isKicked ? (
                <View style={styles.kickedBadge}>
                  <Text style={styles.kickedBadgeText}>Kicked</Text>
                </View>
              ) : member.address !== user?.address ? (
                <View style={styles.memberActions}>
                  {onToggleMuteUser && (
                    <TouchableOpacity
                      style={[styles.muteButton, isUserMuted?.(member.address) && styles.muteButtonActive]}
                      onPress={() => onToggleMuteUser(member.address)}
                    >
                      <IconSymbol
                        name={isUserMuted?.(member.address) ? 'bell.fill' : 'bell.slash.fill'}
                        size={12}
                        color={isUserMuted?.(member.address) ? theme.colors.primary : theme.colors.textMuted}
                      />
                    </TouchableOpacity>
                  )}
                  {isSpaceOwner && (
                    <TouchableOpacity
                      style={styles.kickButton}
                      onPress={() => setKickTarget({
                        address: member.address,
                        displayName: member.display_name || member.name || truncateAddress(member.address),
                        userIcon: member.profile_image,
                      })}
                    >
                      <Text style={styles.kickButtonText}>Kick</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ) : null}
            </View>
          );
        })}

        {members.length === 0 && (
          <View style={styles.emptyState}>
            <IconSymbol name="person.2" size={48} color={theme.colors.textMuted} />
            <Text style={styles.emptyStateText}>No members yet</Text>
            <Text style={styles.emptyStateDescription}>
              Invite people to join this space
            </Text>
          </View>
        )}
    </ScrollView>

    {selectedUserProfile && (
      <Suspense fallback={null}>
        <UserProfileModal
          visible
          onClose={() => setSelectedUserProfile(null)}
          user={selectedUserProfile}
          spaceId={spaceId}
          roles={roles}
          isSpaceOwner={isSpaceOwner}
          onStartDM={(userId) => {
            setSelectedUserProfile(null);
            startDirectMessage(userId);
          }}
          onMuteUser={(userId) => toggleMuteUser(userId)}
          isUserMuted={isUserMutedFn(selectedUserProfile.userId)}
        />
      </Suspense>
    )}
    </>
  );

  const renderChannelsTab = () => (
    <ScrollView
      style={styles.membersScrollView}
      contentContainerStyle={styles.tabContentContainer}
      showsVerticalScrollIndicator={true}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.sectionDescription}>
        Manage channel groups and channels. Use the arrows to reorder channels.
      </Text>

      <TouchableOpacity
        style={styles.addButton}
        onPress={handleAddGroup}
        disabled={addGroupMutation.isPending}
      >
        {addGroupMutation.isPending ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <>
            <IconSymbol name="plus" size={16} color={theme.colors.primary} />
            <Text style={styles.addButtonText}>Add Group</Text>
          </>
        )}
      </TouchableOpacity>

      {(space?.groups ?? []).map((group, groupIndex) => (
        <View key={`group-${groupIndex}`} style={styles.channelGroupContainer}>
          {/* Group Header */}
          <View style={styles.channelGroupHeader}>
            {editingGroupIndex === groupIndex ? (
              <View style={styles.editingInputRow}>
                <TextInput
                  style={styles.channelGroupNameInput}
                  value={editingGroupName}
                  onChangeText={setEditingGroupName}
                  autoFocus
                  onSubmitEditing={() => handleSaveGroupName(groupIndex)}
                />
                <TouchableOpacity
                  style={styles.confirmButton}
                  onPress={() => handleSaveGroupName(groupIndex)}
                >
                  <IconSymbol name="checkmark" size={16} color={theme.colors.primary} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={() => setEditingGroupIndex(null)}
                >
                  <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.channelGroupNameContainer}
                onPress={() => {
                  setEditingGroupIndex(groupIndex);
                  setEditingGroupName(group.groupName);
                }}
              >
                <Text style={styles.channelGroupName}>{group.groupName}</Text>
                <IconSymbol name="pencil" size={12} color={theme.colors.textMuted} />
              </TouchableOpacity>
            )}
            <View style={styles.channelGroupActions}>
              <TouchableOpacity
                style={styles.channelGroupActionButton}
                onPress={() => {
                  setNewChannelGroupIndex(groupIndex);
                  setNewChannelName('');
                }}
              >
                <IconSymbol name="plus" size={16} color={theme.colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.channelGroupActionButton}
                onPress={() => handleDeleteGroup(groupIndex)}
              >
                <IconSymbol name="trash" size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            </View>
          </View>

          {/* New Channel Input */}
          {newChannelGroupIndex === groupIndex && (
            <View style={styles.newChannelRow}>
              <Text style={styles.channelHashSymbol}>#</Text>
              <TextInput
                style={styles.newChannelInput}
                value={newChannelName}
                onChangeText={setNewChannelName}
                placeholder="channel-name"
                placeholderTextColor={theme.colors.textMuted}
                autoFocus
                autoCapitalize="none"
                onSubmitEditing={() => handleAddChannel(groupIndex)}
              />
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={() => handleAddChannel(groupIndex)}
              >
                <IconSymbol name="checkmark" size={16} color={theme.colors.primary} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setNewChannelGroupIndex(null)}
              >
                <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>
          )}

          {/* Channels List */}
          {group.channels.map((channel, channelIndex) => (
            <View key={channel.channelId} style={styles.channelItem}>
              <TouchableOpacity
                style={[styles.channelIconButton, channel.icon && { backgroundColor: (channel.iconColor || theme.colors.textMuted) + '20' }]}
                onPress={() => {
                  setIconPickerChannelId(channel.channelId);
                  setIconPickerVisible(true);
                }}
              >
                <IconSymbol
                  name={(channel.icon || 'number') as IconSymbolName}
                  size={14}
                  color={channel.iconColor || theme.colors.textMuted}
                />
              </TouchableOpacity>
              {editingChannelId === channel.channelId ? (
                <View style={styles.editingInputRow}>
                  <TextInput
                    style={styles.channelNameInput}
                    value={editingChannelName}
                    onChangeText={setEditingChannelName}
                    autoFocus
                    autoCapitalize="none"
                    onSubmitEditing={() => handleSaveChannelName(channel.channelId)}
                  />
                  <TouchableOpacity
                    style={styles.confirmButton}
                    onPress={() => handleSaveChannelName(channel.channelId)}
                  >
                    <IconSymbol name="checkmark" size={16} color={theme.colors.primary} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => setEditingChannelId(null)}
                  >
                    <IconSymbol name="xmark" size={16} color={theme.colors.textMuted} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={styles.channelNameContainer}
                  onPress={() => {
                    setEditingChannelId(channel.channelId);
                    setEditingChannelName(channel.channelName);
                  }}
                >
                  <Text style={styles.channelName}>{channel.channelName}</Text>
                </TouchableOpacity>
              )}
              {channel.channelId === space?.defaultChannelId && (
                <View style={styles.defaultChannelBadge}>
                  <Text style={styles.defaultChannelText}>default</Text>
                </View>
              )}
              <View style={styles.channelActions}>
                <TouchableOpacity
                  style={[styles.channelArrowButton, channelIndex === 0 && styles.channelArrowDisabled]}
                  onPress={() => handleMoveChannelUp(groupIndex, channelIndex)}
                  disabled={channelIndex === 0}
                >
                  <IconSymbol name="chevron.up" size={14} color={channelIndex === 0 ? theme.colors.surface5 : theme.colors.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.channelArrowButton, channelIndex === group.channels.length - 1 && styles.channelArrowDisabled]}
                  onPress={() => handleMoveChannelDown(groupIndex, channelIndex)}
                  disabled={channelIndex === group.channels.length - 1}
                >
                  <IconSymbol name="chevron.down" size={14} color={channelIndex === group.channels.length - 1 ? theme.colors.surface5 : theme.colors.textMuted} />
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.channelDeleteButton}
                  onPress={() => handleDeleteChannel(channel.channelId, channel.channelName)}
                >
                  <IconSymbol name="trash" size={14} color={theme.colors.danger} />
                </TouchableOpacity>
              </View>
            </View>
          ))}

          {group.channels.length === 0 && (
            <Text style={styles.emptyGroupText}>No channels in this group</Text>
          )}
        </View>
      ))}

      {(space?.groups ?? []).length === 0 && (
        <View style={styles.emptyState}>
          <IconSymbol name="number" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateText}>No channel groups</Text>
          <Text style={styles.emptyStateDescription}>
            Add a group to organize your channels
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const renderRolesTab = () => (
    <ScrollView
      style={styles.membersScrollView}
      contentContainerStyle={styles.tabContentContainer}
      showsVerticalScrollIndicator={true}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.sectionDescription}>
        Click on the role name and tag to edit them. Grant delete and mute permissions carefully.
      </Text>

      <TouchableOpacity
        style={styles.addButton}
        onPress={handleAddRole}
        disabled={addRoleMutation.isPending}
      >
        {addRoleMutation.isPending ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <>
            <IconSymbol name="plus" size={16} color={theme.colors.primary} />
            <Text style={styles.addButtonText}>Add Role</Text>
          </>
        )}
      </TouchableOpacity>

      {roles.map((role) => (
        <RoleEditor
          key={role.roleId}
          role={role}
          allRoles={roles}
          spaceId={spaceId}
          theme={theme}
          styles={styles}
          onDelete={() => handleDeleteRole(role.roleId)}
        />
      ))}

      {roles.length === 0 && (
        <View style={styles.emptyState}>
          <IconSymbol name="shield" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateText}>No roles yet</Text>
          <Text style={styles.emptyStateDescription}>
            Add roles to organize permissions and mentions
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const renderEmojisTab = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabContentContainer} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionDescription}>
        Add up to {MAX_EMOJIS} custom emoji ({space?.emojis?.length ?? 0}/{MAX_EMOJIS}). Custom emojis can only be used within this Space.
      </Text>

      <TouchableOpacity
        style={[styles.addButton, isUploadingEmoji && styles.addButtonDisabled]}
        onPress={handleUploadEmoji}
        disabled={isUploadingEmoji}
      >
        {isUploadingEmoji ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <>
            <IconSymbol name="plus" size={16} color={theme.colors.primary} />
            <Text style={styles.addButtonText}>Upload Emoji</Text>
          </>
        )}
      </TouchableOpacity>

      {(space?.emojis ?? []).map((emoji) => (
        <View key={emoji.id} style={styles.emojiItem}>
          <Image source={{ uri: emoji.imgUrl }} style={styles.emojiImage} />
          {editingEmojiId === emoji.id ? (
            <View style={styles.emojiEditContainer}>
              <TextInput
                style={styles.emojiEditInput}
                value={editingEmojiName}
                onChangeText={setEditingEmojiName}
                autoFocus
                maxLength={32}
                onBlur={() => handleSaveEmojiName(emoji.id)}
                onSubmitEditing={() => handleSaveEmojiName(emoji.id)}
              />
            </View>
          ) : (
            <TouchableOpacity
              style={styles.emojiNameContainer}
              onPress={() => {
                setEditingEmojiId(emoji.id);
                setEditingEmojiName(emoji.name);
              }}
            >
              <Text style={styles.emojiName}>:{emoji.name}:</Text>
              <IconSymbol name="pencil" size={14} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.emojiDelete}
            onPress={() => handleDeleteEmoji(emoji.id)}
          >
            <IconSymbol name="trash" size={18} color={theme.colors.danger} />
          </TouchableOpacity>
        </View>
      ))}

      {(space?.emojis ?? []).length === 0 && (
        <View style={styles.emptyState}>
          <IconSymbol name="face.smiling" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateText}>No custom emojis</Text>
          <Text style={styles.emptyStateDescription}>
            Upload custom emojis for your Space
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const renderStickersTab = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabContentContainer} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionDescription}>
        Add up to {MAX_STICKERS} custom stickers ({space?.stickers?.length ?? 0}/{MAX_STICKERS}). Custom stickers can only be used within this Space.
      </Text>

      <TouchableOpacity
        style={[styles.addButton, isUploadingSticker && styles.addButtonDisabled]}
        onPress={handleUploadSticker}
        disabled={isUploadingSticker}
      >
        {isUploadingSticker ? (
          <ActivityIndicator size="small" color={theme.colors.primary} />
        ) : (
          <>
            <IconSymbol name="plus" size={16} color={theme.colors.primary} />
            <Text style={styles.addButtonText}>Upload Sticker</Text>
          </>
        )}
      </TouchableOpacity>

      {(space?.stickers ?? []).map((sticker) => (
        <View key={sticker.id} style={styles.stickerItem}>
          <Image source={{ uri: sticker.imgUrl }} style={styles.stickerImage} />
          {editingStickerName === sticker.id ? (
            <View style={styles.stickerEditContainer}>
              <TextInput
                style={styles.stickerEditInput}
                value={editingStickerNameValue}
                onChangeText={setEditingStickerNameValue}
                autoFocus
                maxLength={32}
                onBlur={() => handleSaveStickerName(sticker.id)}
                onSubmitEditing={() => handleSaveStickerName(sticker.id)}
              />
            </View>
          ) : (
            <TouchableOpacity
              style={styles.stickerNameContainer}
              onPress={() => {
                setEditingStickerName(sticker.id);
                setEditingStickerNameValue(sticker.name);
              }}
            >
              <Text style={styles.stickerName}>{sticker.name}</Text>
              <IconSymbol name="pencil" size={14} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.stickerDelete}
            onPress={() => handleDeleteSticker(sticker.id)}
          >
            <IconSymbol name="trash" size={18} color={theme.colors.danger} />
          </TouchableOpacity>
        </View>
      ))}

      {(space?.stickers ?? []).length === 0 && (
        <View style={styles.emptyState}>
          <IconSymbol name="star" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyStateText}>No custom stickers</Text>
          <Text style={styles.emptyStateDescription}>
            Upload custom stickers for your Space
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const isGeneratingInvite = generateInviteMutation.isPending || generatePublicInviteMutation.isPending;

  const renderInvitesTab = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabContentContainer} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionTitle}>Generate Invite Link</Text>

      {/* Invite Type Toggle */}
      <View style={styles.inviteTypeToggle}>
        <TouchableOpacity
          style={[
            styles.inviteTypeButton,
            inviteType === 'private' && styles.inviteTypeButtonActive,
          ]}
          onPress={() => {
            setInviteType('private');
            setGeneratedInviteLink(null);
          }}
        >
          <IconSymbol
            name="person.fill"
            size={16}
            color={inviteType === 'private' ? '#fff' : theme.colors.textMuted}
          />
          <Text
            style={[
              styles.inviteTypeButtonText,
              inviteType === 'private' && styles.inviteTypeButtonTextActive,
            ]}
          >
            One-Time
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[
            styles.inviteTypeButton,
            inviteType === 'public' && styles.inviteTypeButtonActive,
          ]}
          onPress={() => {
            setInviteType('public');
            setGeneratedInviteLink(null);
          }}
        >
          <IconSymbol
            name="globe"
            size={16}
            color={inviteType === 'public' ? '#fff' : theme.colors.textMuted}
          />
          <Text
            style={[
              styles.inviteTypeButtonText,
              inviteType === 'public' && styles.inviteTypeButtonTextActive,
            ]}
          >
            Public Link
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionDescription}>
        {inviteType === 'private'
          ? 'Generate a one-time use invite link. Each link can only be used by one person.'
          : 'Generate a reusable public invite link. Anyone with this link can join.'}
      </Text>

      {!generatedInviteLink ? (
        <TouchableOpacity
          style={styles.generateButton}
          onPress={handleGenerateInvite}
          disabled={isGeneratingInvite}
        >
          {isGeneratingInvite ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconSymbol name="link" size={18} color="#fff" />
              <Text style={styles.generateButtonText}>
                Generate {inviteType === 'public' ? 'Public' : 'Invite'} Link
              </Text>
            </>
          )}
        </TouchableOpacity>
      ) : (
        <View style={styles.inviteLinkContainer}>
          <View style={styles.inviteLinkBox}>
            <Text style={styles.inviteLinkText} numberOfLines={2}>
              {generatedInviteLink}
            </Text>
          </View>
          <View style={styles.inviteLinkActions}>
            <TouchableOpacity style={styles.inviteLinkButton} onPress={handleCopyInvite}>
              <IconSymbol name="doc.on.doc" size={18} color={theme.colors.primary} />
              <Text style={styles.inviteLinkButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.inviteLinkButton} onPress={handleShareInvite}>
              <IconSymbol name="square.and.arrow.up" size={18} color={theme.colors.primary} />
              <Text style={styles.inviteLinkButtonText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.inviteLinkButton}
              onPress={() => {
                setGeneratedInviteLink(null);
                setGeneratedInviteType(null);
              }}
            >
              <IconSymbol name="arrow.clockwise" size={18} color={theme.colors.primary} />
              <Text style={styles.inviteLinkButtonText}>New</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.inviteHint}>
            {generatedInviteType === 'public'
              ? 'This public link can be shared freely. Regenerate to invalidate the old link.'
              : 'This link can only be used once. Generate a new link for each person.'}
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const handlePublishToDirectory = async () => {
    if (!space || !spaceId || directorySubmitting) return;

    setDirectorySubmitting(true);
    try {
      // Use the space owner key (not the user's identity key)
      const ownerKey = getSpaceKey(spaceId, 'owner');
      if (!ownerKey) throw new Error('Space owner key not found. You may not be the owner of this space.');
      const publicKeyHex = ownerKey.publicKey;
      const privateKeyHex = ownerKey.privateKey;

      // Read invite URL from local storage (set by inviteService when generating a public link)
      const localSpace = getSpace(spaceId);
      const inviteUrl = localSpace?.inviteUrl || space.inviteUrl || generatedInviteLink || '';
      if (!inviteUrl) throw new Error('Space must have a public invite link. Create one in the Invites tab first.');

      const spaceName = space.spaceName;
      const description = space.description || space.spaceName;
      const timestamp = Date.now();

      // Server verifies: sign(spaceAddress + name + description + inviteLink + BE_uint64(timestamp))
      const encoder = new TextEncoder();
      const tsBytes = new Uint8Array(8);
      const view = new DataView(tsBytes.buffer);
      view.setBigUint64(0, BigInt(timestamp));

      const payloadParts = [
        encoder.encode(spaceId),
        encoder.encode(spaceName),
        encoder.encode(description),
        encoder.encode(inviteUrl),
        tsBytes,
      ];
      const payloadLen = payloadParts.reduce((s, p) => s + p.length, 0);
      const payload = new Uint8Array(payloadLen);
      let offset = 0;
      for (const part of payloadParts) {
        payload.set(part, offset);
        offset += part.length;
      }

      const { NativeCryptoProvider } = await import('@/services/crypto/native-provider');
      const crypto = new NativeCryptoProvider();
      const privateKeyBytes = hexToBytes(privateKeyHex);
      const privateKeyBase64 = btoa(String.fromCharCode(...privateKeyBytes));
      const payloadBase64 = btoa(String.fromCharCode(...payload));
      const sigBase64 = await crypto.signEd448(privateKeyBase64, payloadBase64);
      const sigBinary = atob(sigBase64);
      let sigHex = '';
      for (let i = 0; i < sigBinary.length; i++) {
        sigHex += sigBinary.charCodeAt(i).toString(16).padStart(2, '0');
      }

      const { getApiConfig } = await import('@/services/api/config');
      const config = getApiConfig();

      logger.debug('[DirectorySubmit] payload check:', {
        space_address_len: spaceId.length,
        name_len: spaceName.length,
        desc_len: description.length,
        invite_len: inviteUrl.length,
        icon_len: (space.iconUrl || '').length,
        pubkey_len: publicKeyHex.length,
        sig_len: sigHex.length,
        timestamp,
      });

      const response = await fetch(`${config.baseUrl}/directory/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          space_address: spaceId,
          name: spaceName,
          description,
          icon: space.iconUrl || '',
          invite_link: inviteUrl,
          owner_public_key: publicKeyHex,
          owner_signature: sigHex,
          timestamp,
          category: 'community',
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Failed: ${response.status}`);
      }

      setDirectorySubmitted(true);
      Alert.alert('Submitted', 'Your space has been submitted for review. It will appear in Explore once approved.');
    } catch (error) {
      Alert.alert('Error', error instanceof Error ? error.message : 'Failed to submit');
    } finally {
      setDirectorySubmitting(false);
    }
  };

  const renderDangerTab = () => (
    <ScrollView style={styles.tabContent} contentContainerStyle={styles.tabContentContainer} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View style={styles.inputSection}>
        <Text style={styles.label}>Submit to Explorer</Text>
        <Text style={styles.toggleDescription}>
          Submit this space to the public directory so anyone can find it in the Explore tab. Requires admin approval.
        </Text>
        <TouchableOpacity
          style={[
            styles.saveButton,
            { marginTop: Skin.space(12) },
            (directorySubmitting || directorySubmitted) && styles.saveButtonDisabled,
          ]}
          onPress={handlePublishToDirectory}
          disabled={directorySubmitting || directorySubmitted}
        >
          {directorySubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.saveButtonText}>
              {directorySubmitted ? 'Submitted for Review' : 'Submit to Explorer'}
            </Text>
          )}
        </TouchableOpacity>
      </View>

      <View style={[styles.dangerSection, { marginTop: Skin.space(24) }]}>
        <Text style={[styles.dangerTitle, { color: theme.colors.danger }]}>
          Delete this Space
        </Text>
        <Text style={styles.dangerDescription}>
          This action cannot be undone and will permanently remove all the Space settings.
          To delete the Space, you must first delete all Channels.
        </Text>
        <TouchableOpacity
          style={styles.dangerButton}
          onPress={() => setShowDeleteSpaceConfirm(true)}
          disabled={deleteSpaceMutation.isPending}
        >
          {deleteSpaceMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.dangerButtonText}>Delete Space</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderLinkedTab = () => (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.generalTabContainer}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.sectionTitle}>Linked Farcaster channels</Text>
      <Text style={[styles.sectionDescription, { marginBottom: Skin.space(12) }]}>
        Casts from linked channels appear inline at the top of this space's chat
        screens. Bindings are local to your device.
      </Text>
      <SpaceChannelBindingPicker spaceId={spaceId} hideDescription />
    </ScrollView>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return renderGeneralTab();
      case 'account':
        return renderAccountTab();
      case 'members':
        return renderMembersTab();
      case 'channels':
        return renderChannelsTab();
      case 'linked':
        return renderLinkedTab();
      case 'roles':
        return renderRolesTab();
      case 'emojis':
        return renderEmojisTab();
      case 'stickers':
        return renderStickersTab();
      case 'invites':
        return renderInvitesTab();
      case 'danger':
        return renderDangerTab();
      default:
        return null;
    }
  };

  if (!space) {
    return null;
  }

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.80} avoidKeyboard fillHeight>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Space Settings</Text>
          <Text style={styles.subtitle}>{space.spaceName}</Text>
        </View>

        {/* Tab bar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <IconSymbol
                name={tab.icon as IconSymbolName}
                size={18}
                color={
                  activeTab === tab.key
                    ? tab.key === 'danger'
                      ? theme.colors.danger
                      : theme.colors.primary
                    : theme.colors.textMuted
                }
              />
              <Text
                style={[
                  styles.tabText,
                  activeTab === tab.key && styles.tabTextActive,
                  tab.key === 'danger' && activeTab === tab.key && { color: theme.colors.danger },
                ]}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Tab content */}
        {renderTabContent()}
      </View>

      {/* Kick User Modal */}
      {kickTarget && (
        <KickUserModal
          visible={true}
          onClose={() => setKickTarget(null)}
          spaceId={spaceId}
          userName={kickTarget.displayName}
          userIcon={kickTarget.userIcon}
          userAddress={kickTarget.address}
        />
      )}

      {/* Icon Picker Modal */}
      <IconPicker
        visible={iconPickerVisible}
        onClose={() => {
          setIconPickerVisible(false);
          setIconPickerChannelId(null);
        }}
        selectedIcon={iconPickerChannelId ? (space?.groups ?? []).flatMap(g => g.channels).find(c => c.channelId === iconPickerChannelId)?.icon : undefined}
        selectedColor={iconPickerChannelId ? (space?.groups ?? []).flatMap(g => g.channels).find(c => c.channelId === iconPickerChannelId)?.iconColor : undefined}
        onSelect={(icon, color) => {
          if (iconPickerChannelId) {
            updateChannelMutation.mutate({
              spaceId,
              channelId: iconPickerChannelId,
              icon,
              iconColor: color,
            });
          }
        }}
        onClear={() => {
          if (iconPickerChannelId) {
            updateChannelMutation.mutate({
              spaceId,
              channelId: iconPickerChannelId,
              icon: '',
              iconColor: '',
            });
          }
        }}
        theme={theme}
      />
      {generatedInviteLink && space && (
        <ShareInviteSheet
          visible={shareSheetVisible}
          onClose={() => setShareSheetVisible(false)}
          inviteLink={generatedInviteLink}
          spaceName={space.spaceName}
        />
      )}

      {/* Delete Space — type-to-confirm (T3, desktop parity: type "delete") */}
      <TypeToConfirmModal
        visible={showDeleteSpaceConfirm}
        title="Delete Space"
        body="This permanently removes the Space and all its settings. This cannot be undone."
        keyword="delete"
        confirmLabel="Delete Space"
        stats={deleteSpaceStats}
        onConfirm={handleDeleteSpace}
        onCancel={() => setShowDeleteSpaceConfirm(false)}
      />
      {confirmDialog}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: Skin.space(16),
    },
    tabContentWrapper: {
      flex: 1,
    },
    header: {
      paddingVertical: Skin.space(12),
      alignItems: 'center',
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
    },
    subtitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(4),
    },
    tabBar: {
      flexGrow: 0,
      marginBottom: Skin.space(16),
    },
    tabBarContent: {
      gap: Skin.space(8),
      paddingHorizontal: Skin.space(4),
    },
    tab: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
      gap: Skin.space(6),
    },
    tabActive: {
      backgroundColor: theme.colors.surface1,
    },
    tabText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    tabTextActive: {
      color: theme.colors.primary,
    },
    tabContent: {
      flex: 1,
    },
    membersScrollView: {
      maxHeight: SCREEN_HEIGHT * 0.6,
    },
    tabContentContainer: {
      paddingBottom: Skin.space(16),
    },
    generalTabContainer: {
      paddingBottom: Math.max(insets.bottom, 32),
    },
    inputSection: {
      marginBottom: Skin.space(16),
    },
    label: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    inputContainer: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(16),
    },
    textAreaContainer: {
      paddingVertical: Skin.space(8),
    },
    input: {
      paddingVertical: Skin.space(14),
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    textArea: {
      minHeight: 80,
      paddingVertical: Skin.space(8),
    },
    charCountRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: Skin.space(4),
    },
    charCount: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginLeft: 'auto',
    },
    charCountError: {
      color: theme.colors.danger,
    },
    errorText: {
      marginTop: Skin.space(8),
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger,
    },
    imagePickerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      gap: Skin.space(12),
    },
    iconPreview: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(12),
    },
    iconPlaceholder: {
      width: 48,
      height: 48,
      borderRadius: Skin.radius(12),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    bannerPreview: {
      width: 120,
      height: 48,
      borderRadius: Skin.radius(8),
    },
    bannerPlaceholder: {
      width: 120,
      height: 48,
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    imagePickerText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(16),
    },
    toggleInfo: {
      flex: 1,
      marginRight: Skin.space(16),
    },
    toggleLabel: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    toggleDescription: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    saveButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      alignItems: 'center',
    },
    generalSaveButton: {
      marginTop: Skin.space(8),
    },
    saveButtonDisabled: {
      opacity: 0.5,
    },
    saveButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
    sectionTitle: {
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
      marginBottom: Skin.space(8),
    },
    sectionDescription: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginBottom: Skin.space(16),
      lineHeight: Skin.font(20),
    },
    divider: {
      height: 1,
      backgroundColor: theme.colors.surface4,
      marginVertical: Skin.space(24),
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(12),
      gap: Skin.space(8),
      marginBottom: Skin.space(16),
    },
    addButtonText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    roleItem: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    roleHeader: {
      flexDirection: 'row',
      alignItems: 'center',
    },
    roleColorDot: {
      width: 12,
      height: 12,
      borderRadius: Skin.radius(6),
      marginRight: Skin.space(12),
    },
    roleInfo: {
      flex: 1,
    },
    roleTag: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    roleName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    roleActions: {
      flexDirection: 'row',
      gap: Skin.space(8),
    },
    roleActionButton: {
      padding: Skin.space(8),
    },
    roleTagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(2),
    },
    roleTagPrefix: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    roleTagInput: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      padding: 0,
      minWidth: 60,
    },
    roleNameInput: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      padding: 0,
    },
    roleConflictError: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
      marginTop: Skin.space(4),
    },
    rolePermissionsHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(8),
      paddingTop: Skin.space(8),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.surface4,
    },
    rolePermissionsLabel: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginRight: Skin.space(8),
    },
    rolePermissionsValue: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      flex: 1,
    },
    permissionsList: {
      marginTop: Skin.space(8),
      gap: Skin.space(8),
    },
    permissionItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
    },
    permissionCheckbox: {
      width: 20,
      height: 20,
      borderRadius: Skin.radius(4),
      borderWidth: Skin.border(2),
      borderColor: theme.colors.surface5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    permissionCheckboxChecked: {
      backgroundColor: theme.colors.primary,
      borderColor: theme.colors.primary,
    },
    permissionLabel: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    roleSavingIndicator: {
      position: 'absolute',
      top: 8,
      right: 8,
    },
    emptyState: {
      alignItems: 'center',
      paddingVertical: Skin.space(48),
    },
    emptyStateText: {
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginTop: Skin.space(16),
    },
    emptyStateDescription: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(8),
      textAlign: 'center',
    },
    emojiItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    emojiImage: {
      width: 32,
      height: 32,
      borderRadius: Skin.radius(4),
    },
    emojiName: {
      flex: 1,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      marginLeft: Skin.space(12),
    },
    emojiDelete: {
      padding: Skin.space(8),
    },
    stickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    stickerImage: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(8),
    },
    stickerName: {
      flex: 1,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      marginLeft: Skin.space(12),
    },
    stickerDelete: {
      padding: Skin.space(8),
    },
    // Emoji/sticker editing styles
    addButtonDisabled: {
      opacity: 0.5,
    },
    emojiNameContainer: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: Skin.space(12),
    },
    emojiEditContainer: {
      flex: 1,
      marginLeft: Skin.space(12),
    },
    emojiEditInput: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface4,
      borderRadius: Skin.radius(6),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
    },
    stickerNameContainer: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      marginLeft: Skin.space(12),
    },
    stickerEditContainer: {
      flex: 1,
      marginLeft: Skin.space(12),
    },
    stickerEditInput: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface4,
      borderRadius: Skin.radius(6),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
    },
    generateButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      gap: Skin.space(8),
    },
    generateButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
    inviteLinkContainer: {
      marginTop: Skin.space(8),
    },
    inviteLinkBox: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    inviteLinkText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    inviteLinkActions: {
      flexDirection: 'row',
      marginTop: Skin.space(12),
      gap: Skin.space(12),
    },
    inviteLinkButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(12),
      gap: Skin.space(6),
    },
    inviteLinkButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    inviteTypeToggle: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(4),
      marginBottom: Skin.space(16),
      gap: Skin.space(4),
    },
    inviteTypeButton: {
      flex: 1,
      flexDirection: 'row',
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(12),
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: Skin.radius(10),
      gap: Skin.space(6),
    },
    inviteTypeButtonActive: {
      backgroundColor: theme.colors.primary,
    },
    inviteTypeButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    inviteTypeButtonTextActive: {
      color: '#fff',
    },
    inviteHint: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(12),
      textAlign: 'center',
    },
    dangerSection: {
      backgroundColor: theme.colors.danger + '15',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    dangerTitle: {
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
      marginBottom: Skin.space(8),
    },
    dangerDescription: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginBottom: Skin.space(16),
      lineHeight: Skin.font(20),
    },
    dangerButton: {
      backgroundColor: theme.colors.danger,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      alignItems: 'center',
    },
    dangerButtonOutline: {
      backgroundColor: 'transparent',
      borderWidth: Skin.border(1),
      borderColor: theme.colors.danger,
    },
    dangerButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
    dangerButtonOutlineText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.danger,
    },
    // Member styles
    memberItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    memberAvatar: {
      marginRight: Skin.space(12),
    },
    memberAvatarImage: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
    },
    memberInfo: {
      flex: 1,
    },
    memberName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    memberAddress: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.mono?.fontFamily || theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    memberRolesRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(6),
      marginTop: Skin.space(6),
    },
    memberRoleBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(3),
      borderRadius: Skin.radius(10),
      gap: Skin.space(4),
    },
    memberRoleDot: {
      width: 6,
      height: 6,
      borderRadius: Skin.radius(3),
    },
    memberRoleText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    kickedBadge: {
      backgroundColor: theme.colors.danger + '20',
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
      borderRadius: Skin.radius(6),
    },
    kickedBadgeText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.danger,
    },
    memberActions: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      gap: Skin.space(8),
    },
    muteButton: {
      width: 28,
      height: 28,
      borderRadius: Skin.radius(14),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
    },
    muteButtonActive: {
      backgroundColor: theme.colors.primary + '20',
    },
    kickButton: {
      backgroundColor: theme.colors.danger + '20',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(6),
    },
    kickButtonText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.danger,
    },
    // Channel management styles
    channelGroupContainer: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      marginBottom: Skin.space(12),
      overflow: 'hidden',
    },
    channelGroupHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(10),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface4,
    },
    channelGroupNameContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      flex: 1,
    },
    channelGroupName: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    channelGroupNameInput: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface4,
      borderRadius: Skin.radius(6),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
      flex: 1,
    },
    channelGroupActions: {
      flexDirection: 'row',
      gap: Skin.space(4),
    },
    channelGroupActionButton: {
      padding: Skin.space(6),
    },
    channelItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface4,
    },
    channelHashSymbol: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
      marginRight: Skin.space(4),
    },
    channelIconButton: {
      width: 28,
      height: 28,
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center' as const,
      justifyContent: 'center' as const,
      marginRight: Skin.space(6),
    },
    channelNameContainer: {
      flex: 1,
    },
    channelName: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    channelNameInput: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      backgroundColor: theme.colors.surface4,
      borderRadius: Skin.radius(6),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
      flex: 1,
    },
    channelActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(2),
    },
    channelArrowButton: {
      padding: Skin.space(6),
    },
    channelArrowDisabled: {
      opacity: 0.3,
    },
    channelDeleteButton: {
      padding: Skin.space(6),
      marginLeft: Skin.space(4),
    },
    defaultChannelBadge: {
      backgroundColor: theme.colors.primary + '20',
      paddingHorizontal: Skin.space(6),
      paddingVertical: Skin.space(2),
      borderRadius: Skin.radius(4),
      marginRight: Skin.space(8),
    },
    defaultChannelText: {
      fontSize: Skin.font(10),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
      textTransform: 'uppercase',
    },
    newChannelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(8),
      backgroundColor: theme.colors.surface4,
    },
    newChannelInput: {
      flex: 1,
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      paddingVertical: Skin.space(4),
    },
    newChannelCancel: {
      padding: Skin.space(6),
    },
    emptyGroupText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      textAlign: 'center',
      paddingVertical: Skin.space(16),
    },
    editingInputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flex: 1,
      gap: Skin.space(4),
    },
    confirmButton: {
      padding: Skin.space(6),
      backgroundColor: theme.colors.primary + '20',
      borderRadius: Skin.radius(6),
    },
    cancelButton: {
      padding: Skin.space(6),
    },
  });
