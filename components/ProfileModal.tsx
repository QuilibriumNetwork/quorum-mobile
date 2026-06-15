import ListNameModal from '@/components/ListNameModal';
import ApexSubscribeModal from '@/components/apex/ApexSubscribeModal';
import AuctionsModal from '@/components/qns/AuctionsModal';
import MarketplaceModal from '@/components/qns/MarketplaceModal';
import OffersModal from '@/components/qns/OffersModal';
import NameDetailModal from '@/components/qns/NameDetailModal';
import RegisterPaymentModal from '@/components/qns/RegisterPaymentModal';
import { BaseModal, TypeToConfirmModal } from '@/components/shared';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { ApexAvatarRing, APEX_GOLD } from '@/components/ui/ApexAvatarRing';
import { useApexSubscription, type ApexSubscriptionState } from '@/hooks/useApex';
import { SkinsModal } from '@/components/skins/SkinsModal';
import { useAuth, useWebSocket } from '@/context';
import { useToast } from '@/context/ToastContext';
import { compressAvatarImage } from '@/services/media/imageAttachment';
import { getHypersnapOptInChoice, setHypersnapOptInChoice } from '@/services/farcaster/hypersnapOptIn';
import { provisionHypersnapSigner, forgetHypersnapSigner } from '@/services/farcaster/hypersnapProvision';
import { truncateAddress } from '@/utils/formatAddress';
import {
  useBucketLookup,
  useCheckNameAvailability,
  useGetResaleListingByName,
  usePricing,
  useQNSHealth,
  useRedeemInviteCode,
  useRegisterWithPayment,
  useResolveName,
  useReverseLookup,
  useUpdateResolveKey,
  useValidateInviteCode,
} from '@/hooks/useQNS';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import { useSyncSettings } from '@/hooks/useUserConfig';
import { useOtaUpdate } from '@/hooks/useOtaUpdate';
import { getQuorumClient, type DeviceRegistration } from '@/services/api/quorumClient';
import {
  getGlobalNotificationsEnabled,
  setGlobalNotificationsEnabled,
} from '@/services/notifications/notificationPrefs';
import {
  feedPrefsStore,
  K_SHOW_REPLIES_IN_FEED,
  K_SHOW_NON_FOLLOW_REPLIES,
} from '@/services/farcaster/feedPrefs';
import { useMMKVBoolean, useMMKVString } from 'react-native-mmkv';
import {
  translationPrefsStore,
  K_TARGET_LANGUAGE,
  resolveTarget,
} from '@/services/translation/translationPrefs';
import { languageName } from '@/components/translation/languages';
import { TranslateLanguageModal } from '@/components/translation/TranslateLanguageModal';
import { getAllSpaces } from '@/services/config/spaceStorage';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import {
  deriveFarcasterKeys,
  lookupFarcasterAccount,
  validateFarcasterMnemonic,
} from '@/services/onboarding/farcasterService';
import {
  deriveAddress,
  generateNonce,
  generateStealthOwnership,
  getFullStealthKeyMaterial,
  getStealthKeyMaterial,
  signStealthOwnership,
  stealthOwnershipToApi,
  uploadUserRegistrationWithDevices,
  verifyStealthOwnership
} from '@/services/onboarding/keyService';
import {
  getDeviceKeyset,
  getMnemonic,
  getPrivateKey,
  getPublicKey,
  storeFarcasterAuthToken,
  storeFarcasterAuthTokenExpiresAt,
  storeFarcasterCustodyKey,
  storeFarcasterFid,
  storeFarcasterSignerKey,
} from '@/services/onboarding/secureStorage';
import { maybeSendUpdateProfileMessage } from '@/services/space/spaceMessageService';
import { isDevModeLocal, setDevModeLocal, getApiConfig } from '@/services/api/config';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback } from 'react';
import { ActivityIndicator, Alert, Dimensions, Image, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';
interface ProfileModalProps {
  visible: boolean;
  onClose: () => void;
  onOpenWarpcastImport?: () => void;
  isRouteMode?: boolean;
  /** When true, suppresses the built-in profile header + avatar/name row.
   *  Used when embedding inside UnifiedProfileScreen which renders its own header. */
  hideHeader?: boolean;
  /** Optional callback invoked when the user picks a new avatar image. */
  onAvatarPicked?: (dataUri: string) => void;
  /** When provided, marketplace / auctions / offers actions are delegated to the
   *  parent (which renders the modals outside this view). Avoids issues with
   *  nested RN Modals inside a horizontal ScrollView pager. */
  onOpenMarketplace?: () => void;
  onOpenAuctions?: () => void;
  onOpenOffers?: () => void;
}

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

function CallScreeningSection({ theme }: { theme: AppTheme }) {
  const [enabled, setEnabled] = React.useState(() => {
    const { getCallScreening } = require('@/context/CallContext');
    return getCallScreening();
  });

  return (
    <View style={{ paddingHorizontal: Skin.space(16), marginBottom: Skin.space(24) }}>
      <Text style={{ fontSize: Skin.font(13), fontWeight: '600', color: theme.colors.textMuted, marginBottom: Skin.space(8), textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Calls
      </Text>
      <View style={{ backgroundColor: theme.colors.surface2, borderRadius: Skin.radius(12), padding: Skin.space(14) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, marginRight: Skin.space(12) }}>
            <Text style={{ fontSize: Skin.font(15), color: theme.colors.textMain }}>Screen Unknown Callers</Text>
            <Text style={{ fontSize: Skin.font(12), color: theme.colors.textMuted, marginTop: Skin.space(2) }}>
              Only ring for people you have a conversation with
            </Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={(v) => {
              const { setCallScreening } = require('@/context/CallContext');
              setCallScreening(v);
              setEnabled(v);
            }}
            trackColor={{ true: theme.colors.primary }}
          />
        </View>
      </View>
    </View>
  );
}

function DevModeSection({ theme }: { theme: AppTheme }) {
  const [isLocal, setIsLocal] = React.useState(isDevModeLocal());
  const config = getApiConfig();

  return (
    <View style={{ paddingHorizontal: Skin.space(16), marginBottom: Skin.space(24) }}>
      <Text style={{ fontSize: Skin.font(13), fontWeight: '600', color: theme.colors.textMuted, marginBottom: Skin.space(8), textTransform: 'uppercase', letterSpacing: 0.5 }}>
        Developer
      </Text>
      <View style={{ backgroundColor: theme.colors.surface2, borderRadius: Skin.radius(12), padding: Skin.space(14) }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flex: 1, marginRight: Skin.space(12) }}>
            <Text style={{ fontSize: Skin.font(15), color: theme.colors.textMain }}>Use Local API</Text>
            <Text style={{ fontSize: Skin.font(12), color: theme.colors.textMuted, marginTop: Skin.space(2) }}>
              {isLocal ? config.baseUrl : 'Connects to production'}
            </Text>
          </View>
          <Switch
            value={isLocal}
            onValueChange={(v) => {
              setDevModeLocal(v);
              setIsLocal(v);
              Alert.alert(
                'API Changed',
                `Now using ${v ? 'localhost' : 'production'}. Restart the app for the change to take full effect.`,
              );
            }}
            trackColor={{ true: theme.colors.primary }}
          />
        </View>
      </View>
    </View>
  );
}

function OtaUpdateSection({ theme }: { theme: AppTheme }) {
  const {
    isUpdateAvailable,
    isUpdatePending,
    isChecking,
    isDownloading,
    currentlyRunning,
    availableUpdate,
    checkError,
    checkNow,
    applyUpdate,
  } = useOtaUpdate();

  // Short identifier — full updateId is a UUID, not user-friendly. Fall
  // back to the runtime version when the embedded build hasn't been
  // replaced by a downloaded update yet (currentlyRunning.updateId is
  // null in that case).
  const fmt = (u: {
    updateId?: string | null;
    createdAt?: Date | null;
    runtimeVersion?: string | null;
  }) => {
    const id = u.updateId ? u.updateId.slice(0, 8) : `runtime ${u.runtimeVersion ?? '?'}`;
    const when = u.createdAt ? new Date(u.createdAt).toLocaleString() : '';
    return when ? `${id} · ${when}` : id;
  };

  const showApply = isUpdateAvailable || isUpdatePending;
  const buttonLabel = isDownloading
    ? 'Downloading…'
    : isUpdatePending
      ? 'Restart to apply'
      : 'Update now';

  return (
    <View style={{ paddingHorizontal: Skin.space(16), marginBottom: Skin.space(24) }}>
      <Text style={{ fontSize: Skin.font(13), fontWeight: '600', color: theme.colors.textMuted, marginBottom: Skin.space(8), textTransform: 'uppercase', letterSpacing: 0.5 }}>
        App Updates
      </Text>
      <View style={{ backgroundColor: theme.colors.surface2, borderRadius: Skin.radius(12), padding: Skin.space(14), gap: Skin.space(10) }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: Skin.font(13), color: theme.colors.textMuted }}>Current</Text>
          <Text style={{ fontSize: Skin.font(13), color: theme.colors.textMain, flex: 1, textAlign: 'right', marginLeft: Skin.space(12) }} numberOfLines={1}>
            {fmt(currentlyRunning)}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ fontSize: Skin.font(13), color: theme.colors.textMuted }}>Latest</Text>
          <Text style={{ fontSize: Skin.font(13), color: theme.colors.textMain, flex: 1, textAlign: 'right', marginLeft: Skin.space(12) }} numberOfLines={1}>
            {availableUpdate
              ? fmt(availableUpdate)
              : isChecking
                ? 'Checking…'
                : 'Up to date'}
          </Text>
        </View>

        {checkError && (
          <Text style={{ fontSize: Skin.font(12), color: theme.colors.danger ?? '#ff3b30' }}>
            {checkError.message}
          </Text>
        )}

        <View style={{ flexDirection: 'row', gap: Skin.space(8), marginTop: Skin.space(4) }}>
          <TouchableOpacity
            onPress={checkNow}
            disabled={isChecking}
            style={{
              flex: 1,
              paddingVertical: Skin.space(10),
              borderRadius: Skin.radius(8),
              backgroundColor: theme.colors.surface3,
              alignItems: 'center',
              opacity: isChecking ? 0.5 : 1,
            }}
          >
            <Text style={{ fontSize: Skin.font(14), color: theme.colors.textMain }}>
              {isChecking ? 'Checking…' : 'Check for updates'}
            </Text>
          </TouchableOpacity>

          {showApply && (
            <TouchableOpacity
              onPress={applyUpdate}
              disabled={isDownloading}
              style={{
                flex: 1,
                paddingVertical: Skin.space(10),
                borderRadius: Skin.radius(8),
                backgroundColor: '#0A84FF',
                alignItems: 'center',
                flexDirection: 'row',
                justifyContent: 'center',
                gap: Skin.space(6),
                opacity: isDownloading ? 0.6 : 1,
              }}
            >
              <IconSymbol name="bolt.fill" size={13} color="#fff" />
              <Text style={{ fontSize: Skin.font(14), color: '#fff', fontWeight: '600' }}>{buttonLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </View>
  );
}

export default function ProfileModal({
  visible,
  onClose,
  onOpenWarpcastImport,
  isRouteMode = false,
  hideHeader = false,
  onOpenMarketplace,
  onOpenAuctions,
  onOpenOffers,
}: ProfileModalProps) {
  const { theme, isDark, activeSkin } = useTheme();
  const { user, signOut, updateProfile } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const { showToast } = useToast();
  const { allowSync, setAllowSync, isLoading: isSyncLoading } = useSyncSettings();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const [activeTab, setActiveTab] = React.useState<'profile' | 'premium' | 'settings'>('profile');
  const [usernameSearch, setUsernameSearch] = React.useState('');
  const [inviteCode, setInviteCode] = React.useState('');
  // Reset App Data — type-to-confirm (T3: the only catastrophic op; wipes keys).
  const [showResetConfirm, setShowResetConfirm] = React.useState(false);
  // Hypersnap signer opt-in. Mirrors the MMKV-persisted choice that the
  // first-run prompt writes; this switch is the only way to change the
  // choice after that prompt has been answered.
  const [hypersnapEnabled, setHypersnapEnabled] = React.useState<boolean>(
    () => getHypersnapOptInChoice() === 'opted-in'
  );
  const [hypersnapBusy, setHypersnapBusy] = React.useState(false);
  // Notifications toggle. Backed by MMKV via notificationPrefs so the
  // setting persists across launches AND is read by showMessageNotification
  // at presentation time. Previously this was plain React state with no
  // persistence and no gating — the toggle did nothing.
  const [notifications, setNotificationsState] = React.useState<boolean>(() =>
    getGlobalNotificationsEnabled()
  );
  const setNotifications = React.useCallback((next: boolean) => {
    setNotificationsState(next);
    setGlobalNotificationsEnabled(next);
  }, []);
  // Feed reply toggles. Default: show replies (ON), hide non-follow replies
  // (OFF). Backed by MMKV so the feed hook (subscribed to the same keys)
  // re-filters live.
  const [showRepliesInFeedRaw, setShowRepliesInFeed] = useMMKVBoolean(
    K_SHOW_REPLIES_IN_FEED,
    feedPrefsStore,
  );
  const showRepliesInFeed = showRepliesInFeedRaw ?? true;
  const [showNonFollowRepliesRaw, setShowNonFollowReplies] = useMMKVBoolean(
    K_SHOW_NON_FOLLOW_REPLIES,
    feedPrefsStore,
  );
  const showNonFollowReplies = showNonFollowRepliesRaw ?? false;
  const [isSyncToggling, setIsSyncToggling] = React.useState(false);

  // Quorum Apex subscription — card in the premium tab + gold avatar ring
  const apexState = useApexSubscription();
  const [apexModalMode, setApexModalMode] = React.useState<'subscribe' | 'renew' | null>(null);

  // Marketplace listing modal state
  const [listNameModalVisible, setListNameModalVisible] = React.useState(false);
  const [nameToList, setNameToList] = React.useState<string | null>(null);
  const [skinsOpen, setSkinsOpen] = React.useState(false);
  const [translateOpen, setTranslateOpen] = React.useState(false);
  const [storedTarget] = useMMKVString(K_TARGET_LANGUAGE, translationPrefsStore);
  const targetLanguageName = languageName(resolveTarget(storedTarget));
  const [showNamePickerModal, setShowNamePickerModal] = React.useState(false);

  // Registration payment modal state
  const [registerPaymentVisible, setRegisterPaymentVisible] = React.useState(false);
  const [registerPaymentName, setRegisterPaymentName] = React.useState('');

  // Marketplace modal state
  const [marketplaceModalVisible, setMarketplaceModalVisible] = React.useState(false);

  // Name detail modal state
  const [nameDetailVisible, setNameDetailVisible] = React.useState(false);
  const [selectedNameForDetail, setSelectedNameForDetail] = React.useState('');

  // Auctions modal state
  const [auctionsModalVisible, setAuctionsModalVisible] = React.useState(false);

  // Offers modal state
  const [offersModalVisible, setOffersModalVisible] = React.useState(false);

  // Editable profile fields
  const [isEditing, setIsEditing] = React.useState(false);
  const [editDisplayName, setEditDisplayName] = React.useState(user?.displayName || '');
  const [editBio, setEditBio] = React.useState(user?.bio || '');
  const [isSaving, setIsSaving] = React.useState(false);

  // Recovery phrase / private key display
  const [showRecoveryPhrase, setShowRecoveryPhrase] = React.useState(false);
  const [recoveryPhrase, setRecoveryPhrase] = React.useState<string[] | null>(null);
  const [hexPrivateKey, setHexPrivateKey] = React.useState<string | null>(null);

  // Farcaster import
  const [showFarcasterImport, setShowFarcasterImport] = React.useState(false);
  const [farcasterMnemonic, setFarcasterMnemonic] = React.useState('');
  const [farcasterImporting, setFarcasterImporting] = React.useState(false);
  const [farcasterError, setFarcasterError] = React.useState<string | null>(null);

  // Device management
  const [deviceRegistrations, setDeviceRegistrations] = React.useState<DeviceRegistration[]>([]);
  const [currentDeviceInboxAddress, setCurrentDeviceInboxAddress] = React.useState<string | null>(null);
  const [pendingRemovals, setPendingRemovals] = React.useState<string[]>([]);
  const [isLoadingDevices, setIsLoadingDevices] = React.useState(false);
  const [isRemovingDevice, setIsRemovingDevice] = React.useState(false);

  // Warpcast wallet import
  const { shouldPromptImport: hasWarpcastWallet, isImported: hasImportedWarpcastWallet, importedWallet } = useWarpcastWallet();

  // QNS launch countdown state - Jan 7, 2026 14:00 UTC
  const [countdown, setCountdown] = React.useState<{ days: number; hours: number; minutes: number; seconds: number } | null>(() => {
    const launchDate = new Date('2026-01-07T14:00:00Z');
    const now = new Date();
    const diff = launchDate.getTime() - now.getTime();
    if (diff <= 0) return null;
    return {
      days: Math.floor(diff / (1000 * 60 * 60 * 24)),
      hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
      minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
      seconds: Math.floor((diff % (1000 * 60)) / 1000),
    };
  });

  // Reset edit state when modal opens/closes or user changes
  React.useEffect(() => {
    if (visible && user) {
      setEditDisplayName(user.displayName || '');
      setEditBio(user.bio || '');
      setIsEditing(false);
      setShowRecoveryPhrase(false);
      setRecoveryPhrase(null);
      setShowFarcasterImport(false);
      setFarcasterMnemonic('');
      setFarcasterError(null);
      setPendingRemovals([]);
      // Re-read the persisted Hypersnap choice — the first-run prompt (or
      // another surface) may have changed it since this modal last opened.
      setHypersnapEnabled(getHypersnapOptInChoice() === 'opted-in');
      // Load device registrations
      loadDeviceRegistrations();
    }
  }, [visible, user]);

  // Toggle the Hypersnap signer opt-in. Enabling provisions immediately so
  // the user gets feedback here rather than waiting for the feed-mounted
  // lifecycle hook; disabling clears the local signer record (the on-chain
  // KEY_REMOVE is intentionally not issued — the key simply stops being used).
  const handleToggleHypersnap = React.useCallback(async (value: boolean) => {
    const fid = user?.farcaster?.fid;
    if (!fid) return;
    setHypersnapEnabled(value);
    if (!value) {
      setHypersnapOptInChoice('opted-out');
      try {
        await forgetHypersnapSigner();
      } catch {
        // Local cleanup only — nothing user-actionable if it fails.
      }
      showToast({ type: 'success', title: 'Hypersnap signer disabled' });
      return;
    }
    setHypersnapOptInChoice('opted-in');
    setHypersnapBusy(true);
    try {
      await provisionHypersnapSigner(fid);
      showToast({
        type: 'success',
        title: 'Hypersnap signer enabled',
        message: 'Eligible Farcaster activity now earns $SNAP.',
      });
    } catch (e) {
      // Stay opted-in: the feed lifecycle hook retries automatically.
      showToast({
        type: 'error',
        title: "Couldn't create signer",
        message: e instanceof Error ? e.message : 'It will retry automatically.',
      });
    } finally {
      setHypersnapBusy(false);
    }
  }, [user?.farcaster?.fid, showToast]);

  // Load device registrations from server
  const loadDeviceRegistrations = React.useCallback(async () => {
    if (!user?.address) return;

    setIsLoadingDevices(true);
    try {
      // Get current device's inbox address
      const deviceKeyset = await getDeviceKeyset();
      if (deviceKeyset) {
        setCurrentDeviceInboxAddress(deviceKeyset.inboxAddress);
      }

      // Fetch user registration from server
      const client = getQuorumClient();
      const registration = await client.fetchUserRegistration(user.address);
      if (registration?.device_registrations) {
        // Sort so current device is first
        const sorted = [...registration.device_registrations].sort((a, b) => {
          const aIsCurrent = a.inbox_registration.inbox_address === deviceKeyset?.inboxAddress;
          const bIsCurrent = b.inbox_registration.inbox_address === deviceKeyset?.inboxAddress;
          if (aIsCurrent && !bIsCurrent) return -1;
          if (!aIsCurrent && bIsCurrent) return 1;
          return 0;
        });
        setDeviceRegistrations(sorted);
      }
    } catch (e) {
      // Device registration fetch failed — show empty device list
      logger.warn('[devices] failed to load device registrations', e);
    } finally {
      setIsLoadingDevices(false);
    }
  }, [user?.address]);

  // Memoized so the extracted React.memo sections below (which receive
  // `styles` as a prop) aren't invalidated on every render.
  const styles = React.useMemo(() => createStyles(theme, isDark, insets), [theme, isDark, insets]);

  const { confirm, confirmDialog } = useConfirmDialog();

  // Handle device removal
  const handleRemoveDevice = React.useCallback((identityPublicKey: string) => {
    void (async () => {
      const ok = await confirm({
        title: 'Remove Device',
        message:
          'Are you sure you want to remove this device? It will no longer be able to receive encrypted messages for your account.',
        confirmLabel: 'Remove',
      });
      if (!ok) return;
      if (!user?.address) return;

      setIsRemovingDevice(true);
      try {
        // Get our keys for signing
        const [userPrivateKey, userPublicKey, deviceKeyset] = await Promise.all([
          getPrivateKey(),
          getPublicKey(),
          getDeviceKeyset(),
        ]);

        if (!userPrivateKey || !userPublicKey || !deviceKeyset) {
          throw new Error('Missing keys for device removal');
        }

        // Filter out the device to remove
        const remainingDevices = deviceRegistrations.filter(
          (d) => d.identity_public_key !== identityPublicKey
        );

        // Upload updated registration
        await uploadUserRegistrationWithDevices(
          user.address,
          userPublicKey,
          userPrivateKey,
          remainingDevices
        );

        // Update local state
        setDeviceRegistrations(remainingDevices);
        Alert.alert('Success', 'Device removed successfully.');
      } catch (error) {
        Alert.alert('Error', 'Failed to remove device. Please try again.');
      } finally {
        setIsRemovingDevice(false);
      }
    })();
  }, [user?.address, deviceRegistrations, confirm]);

  // Handle reset all DM sessions
  const handleResetAllSessions = React.useCallback(() => {
    void (async () => {
      const ok = await confirm({
        title: 'Reset All DM Sessions',
        message:
          'This will reset all your encrypted DM sessions. Your next message to each contact will establish a fresh secure connection.\n\nUse this if you are experiencing persistent decryption errors.',
        confirmLabel: 'Reset All',
      });
      if (!ok) return;
      encryptionStateStorage.clearAll();
      Alert.alert('Success', 'All DM sessions have been reset. Your next message to each contact will establish a fresh secure connection.');
    })();
  }, [confirm]);

  // Public profile opt-in — requires explicit consent via a confirmation
  // dialog the FIRST time the user enables it, since flipping this means
  // publishing your profile to a public endpoint anyone can read.
  const handleTogglePublicProfile = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        const hasFC = !!user?.farcaster?.fid && !!user?.farcaster?.custodyAddress;
        const fcNote = hasFC
          ? '\n\nYour Farcaster account will be linked to your Quorum identity, enabling mutual followers on Farcaster who also use Quorum to call you.'
          : '';
        Alert.alert(
          'Make profile public?',
          `Your display name, profile picture, and bio will be readable by anyone with your Quorum address — including people outside of the spaces you share. Existing space members will see your latest profile even if they joined before you set it. You can turn this off at any time.${fcNote}`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Make Public',
              style: 'destructive',
              onPress: async () => {
                if (!user?.address) return;
                updateProfile({ isProfilePublic: true });

                // Generate the Farcaster link FIRST (when applicable)
                // so we can include it in the public-profile POST. The
                // server validates the Quorum-side signature and
                // populates the `farcaster-fid/<fid> → address` reverse
                // index in the same atomic batch as the profile write.
                let farcasterLink: Awaited<ReturnType<typeof import('@/services/calling/farcaster-link').generateFarcasterLink>> = null;
                if (hasFC && user.address) {
                  try {
                    const { generateFarcasterLink } = await import('@/services/calling/farcaster-link');
                    farcasterLink = await generateFarcasterLink(
                      user.farcaster!.fid,
                      user.farcaster!.custodyAddress!,
                      user.address,
                    );
                    if (farcasterLink) {
                      // Keep a local copy for offline use / call screening.
                      const { saveConfig, getConfig } = await import('@/services/config');
                      const config = await getConfig(user.address);
                      await saveConfig({ ...config, farcasterLink });
                    }
                  } catch (e) {
                    // Link generation failed — fall through and publish
                    // without it. Profile is still public, just without
                    // the cross-identity badge.
                    logger.warn('[publicProfile] farcaster link generation failed', e);
                  }
                }

                // Publish to the public-profile endpoint so other users
                // can fetch even when we don't share a space yet, and
                // (when farcasterLink is set) the server can answer
                // by-fid lookups for Quorum-aware Farcaster clients.
                try {
                  const { publishPublicProfile } = await import('@/services/profile/publicProfile');
                  await publishPublicProfile({
                    address: user.address,
                    displayName: user.displayName || user.username || '',
                    profileImage: user.profileImage || '',
                    bio: user.bio || '',
                    primaryUsername: user.primaryUsername,
                    farcasterLink: farcasterLink ?? undefined,
                  });
                } catch (e) {
                  // Non-fatal — toggle is still on locally; next save
                  // attempt will retry the publish.
                  logger.warn('[publicProfile] publish failed', e);
                  showToast({
                    type: 'error',
                    title: "Couldn't publish profile",
                    message: 'Your profile is public locally; publishing will be retried on your next profile save.',
                  });
                }
              },
            },
          ],
        );
      } else {
        updateProfile({ isProfilePublic: false });
        // Best-effort delete of the published profile. Even if this
        // fails the toggle is off locally and the server's record
        // becomes stale on the next publish (POST is timestamp-newer-
        // wins).
        if (user?.address) {
          (async () => {
            try {
              const { unpublishPublicProfile } = await import('@/services/profile/publicProfile');
              await unpublishPublicProfile(user.address);
            } catch (e) {
              logger.warn('[publicProfile] unpublish failed', e);
              showToast({
                type: 'error',
                title: "Couldn't remove public profile",
                message: 'Your profile may still be publicly visible. Try toggling again.',
              });
            }
          })();
        }
      }
    },
    [updateProfile, user, showToast],
  );

  const handleToggleSync = React.useCallback(async (enabled: boolean) => {
    setIsSyncToggling(true);
    try {
      await setAllowSync(enabled);
      if (enabled) {
        Alert.alert(
          'Sync Enabled',
          'Your profile, spaces, and keys will now sync between your devices. Note: This increases metadata visibility of your account.'
        );
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to update sync setting. Please try again.');
    } finally {
      setIsSyncToggling(false);
    }
  }, [setAllowSync]);

  const handleResetAppData = async () => {
    setShowResetConfirm(false);
    // Clear React Query cache
    queryClient.clear();
    // Sign out clears MMKV storage and secure storage
    await signOut();
    onClose();
  };

  const handleExportRecoveryPhrase = React.useCallback(() => {
    Alert.alert(
      'Export Recovery Key',
      'Your recovery key is the only way to restore your account. Never share it with anyone. Make sure no one is looking at your screen.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Show Key',
          style: 'destructive',
          onPress: async () => {
            // First try mnemonic
            const phrase = await getMnemonic();
            if (phrase && phrase.length >= 12) {
              setRecoveryPhrase(phrase);
              setHexPrivateKey(null);
              setShowRecoveryPhrase(true);
              return;
            }

            // Fall back to hex private key
            const privateKey = await getPrivateKey();
            if (privateKey && privateKey.length > 0) {
              setHexPrivateKey(privateKey);
              setRecoveryPhrase(null);
              setShowRecoveryPhrase(true);
              return;
            }

            Alert.alert('Error', 'Could not retrieve recovery key.');
          },
        },
      ]
    );
  }, []);

  const handleCopyRecoveryPhrase = React.useCallback(async () => {
    if (recoveryPhrase) {
      await Clipboard.setStringAsync(recoveryPhrase.join(' '));
      Alert.alert('Copied', 'Recovery phrase copied to clipboard. Make sure to store it securely and clear your clipboard.');
    } else if (hexPrivateKey) {
      await Clipboard.setStringAsync(hexPrivateKey);
      Alert.alert('Copied', 'Private key copied to clipboard. Make sure to store it securely and clear your clipboard.');
    }
  }, [recoveryPhrase, hexPrivateKey]);

  const handleHideRecoveryPhrase = React.useCallback(() => {
    setShowRecoveryPhrase(false);
    setRecoveryPhrase(null);
    setHexPrivateKey(null);
  }, []);

  const handleImportFarcaster = async () => {
    if (!farcasterMnemonic.trim()) {
      setFarcasterError('Please enter your recovery phrase');
      return;
    }

    const words = farcasterMnemonic.trim().split(/\s+/);
    if (words.length !== 12 && words.length !== 24) {
      setFarcasterError('Recovery phrase must be 12 or 24 words');
      return;
    }

    if (!validateFarcasterMnemonic(words)) {
      setFarcasterError('Invalid recovery phrase');
      return;
    }

    setFarcasterImporting(true);
    setFarcasterError(null);

    try {
      // Derive keys from mnemonic
      const keys = deriveFarcasterKeys(words);

      // Look up account from custody address using official Farcaster API
      const account = await lookupFarcasterAccount(keys.custodyAddress, keys.custodyPrivateKey);

      if (!account) {
        setFarcasterError('No Farcaster account found for this recovery phrase');
        setFarcasterImporting(false);
        return;
      }

      // Store Farcaster keys and auth token securely
      const storePromises = [
        storeFarcasterCustodyKey(keys.custodyPrivateKey),
        storeFarcasterSignerKey(keys.signerPrivateKey),
        storeFarcasterFid(account.fid),
      ];
      if (account.authToken) {
        storePromises.push(storeFarcasterAuthToken(account.authToken));
        if (account.authTokenExpiresAt != null) {
          storePromises.push(storeFarcasterAuthTokenExpiresAt(account.authTokenExpiresAt));
        }
      }
      await Promise.all(storePromises);

      // Update user profile with Farcaster info
      updateProfile({
        farcaster: {
          fid: account.fid,
          username: account.username,
          signerPublicKey: keys.signerPublicKey,
          custodyAddress: keys.custodyAddress,
        },
      });

      // Reset state and show success
      setShowFarcasterImport(false);
      setFarcasterMnemonic('');
      Alert.alert('Success', `Connected as @${account.username}`);
    } catch (error) {
      setFarcasterError('Failed to import Farcaster account. Please try again.');
    } finally {
      setFarcasterImporting(false);
    }
  };

  const handleDisconnectFarcaster = () => {
    void (async () => {
      const ok = await confirm({
        title: 'Disconnect Farcaster',
        message: 'Are you sure you want to disconnect your Farcaster account?',
        confirmLabel: 'Disconnect',
      });
      if (!ok) return;
      updateProfile({ farcaster: undefined });
    })();
  };

  const handlePickImage = React.useCallback(async () => {
    if (!user?.address) return;

    // Request permission
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission Required', 'Please grant photo library access to change your profile picture.');
      return;
    }

    // Launch image picker. `quality: 0.8` only re-encodes when the
    // picker materializes a new file (it doesn't always — some
    // pickers hand back the original asset URI). We rely on
    // compressAvatarImage below to enforce a hard size cap so a
    // huge phone photo can't end up as the user's profile_image.
    // base64 here is best-effort; we'll re-base64 after compression.
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
        Alert.alert(
          'Could not process image',
          'Try a smaller photo or one in a common format (JPEG/PNG).',
        );
        return;
      }
      const profileImage = compressed.dataUri;
      updateProfile({ profileImage });

      // Broadcast profile image update to all spaces
      const spaces = getAllSpaces();
      if (spaces.length > 0) {
        enqueueOutbound(async () => {
          const envelopes: string[] = [];

          for (const space of spaces) {
            try {
              // Avatar-only update: only send userIcon. Don't include
              // displayName — the receiver would treat its presence as
              // a write and clobber whatever they had if it's empty.
              const updateResult = await maybeSendUpdateProfileMessage({
                spaceId: space.spaceId,
                channelId: space.defaultChannelId,
                senderAddress: user.address,
                userIcon: profileImage,
              });
              if (updateResult) {
                envelopes.push(updateResult.wsEnvelope);
              }
            } catch (e) {
              // Profile broadcast to this space failed — skip and continue with others
              logger.warn('[profile] avatar broadcast to space failed', space.spaceId, e);
            }
          }

          return envelopes;
        });
      }

      // Mirror to the public-profile endpoint when the user is public.
      // Re-derive the Farcaster link each publish so the by-fid index
      // stays current — cheap (in-memory crypto over a 32-byte key) and
      // means an avatar update doesn't accidentally drop the link.
      if (user.isProfilePublic) {
        let farcasterLink: Awaited<ReturnType<typeof import('@/services/calling/farcaster-link').generateFarcasterLink>> = null;
        if (user.farcaster?.fid && user.farcaster?.custodyAddress && user.address) {
          try {
            const { generateFarcasterLink } = await import('@/services/calling/farcaster-link');
            farcasterLink = await generateFarcasterLink(
              user.farcaster.fid,
              user.farcaster.custodyAddress,
              user.address,
            );
          } catch (e) {
            // Link generation failed — publish without it.
            logger.warn('[publicProfile] farcaster link generation failed', e);
          }
        }
        try {
          const { publishPublicProfile } = await import('@/services/profile/publicProfile');
          await publishPublicProfile({
            address: user.address,
            displayName: user.displayName || user.username || '',
            profileImage,
            bio: user.bio || '',
            primaryUsername: user.primaryUsername,
            farcasterLink: farcasterLink ?? undefined,
          });
        } catch (e) {
          logger.warn('[publicProfile] publish on avatar change failed', e);
          showToast({
            type: 'error',
            title: "Couldn't publish new avatar",
            message: 'Your avatar was updated locally but failed to publish publicly.',
          });
        }
      }
    }
  }, [user, enqueueOutbound, updateProfile, showToast]);

  const handleSaveProfile = async () => {
    if (!user?.address) return;

    setIsSaving(true);
    try {
      const newDisplayName = editDisplayName.trim() || '';
      const newBio = editBio.trim() || '';

      // Update local profile
      updateProfile({
        displayName: newDisplayName || undefined,
        bio: newBio || undefined,
      });

      // Broadcast profile update to all spaces
      const spaces = getAllSpaces();
      if (spaces.length > 0) {
        enqueueOutbound(async () => {
          const envelopes: string[] = [];

          for (const space of spaces) {
            try {
              // Send only the fields that actually changed in this save.
              // Including a bare userIcon: '' would have clobbered the
              // recipients' avatar of us. Display name is always
              // included since this is the "save profile" handler that
              // owns the display-name field; bio follows the public
              // profile gate.
              const result = await maybeSendUpdateProfileMessage({
                spaceId: space.spaceId,
                channelId: space.defaultChannelId,
                senderAddress: user.address,
                displayName: newDisplayName || undefined,
                bio: user.isProfilePublic ? newBio : undefined,
              });
              if (result) {
                envelopes.push(result.wsEnvelope);
              }
            } catch (e) {
              // Profile broadcast to this space failed — skip and continue with others
              logger.warn('[profile] profile broadcast to space failed', space.spaceId, e);
            }
          }

          return envelopes;
        });
      }

      // If the user's profile is public, also re-publish to the public
      // endpoint so non-space-members who look us up see the latest.
      // Re-derive the Farcaster link so the by-fid index is refreshed
      // each publish (cheap and idempotent server-side).
      if (user.isProfilePublic) {
        let farcasterLink: Awaited<ReturnType<typeof import('@/services/calling/farcaster-link').generateFarcasterLink>> = null;
        if (user.farcaster?.fid && user.farcaster?.custodyAddress && user.address) {
          try {
            const { generateFarcasterLink } = await import('@/services/calling/farcaster-link');
            farcasterLink = await generateFarcasterLink(
              user.farcaster.fid,
              user.farcaster.custodyAddress,
              user.address,
            );
          } catch (e) {
            // Non-fatal — publish without it.
            logger.warn('[publicProfile] farcaster link generation failed', e);
          }
        }
        try {
          const { publishPublicProfile } = await import('@/services/profile/publicProfile');
          await publishPublicProfile({
            address: user.address,
            displayName: newDisplayName || user.username || '',
            profileImage: user.profileImage || '',
            bio: newBio || '',
            primaryUsername: user.primaryUsername,
            farcasterLink: farcasterLink ?? undefined,
          });
        } catch (e) {
          logger.warn('[publicProfile] publish on save failed', e);
          showToast({
            type: 'error',
            title: "Couldn't publish profile update",
            message: 'Your profile was saved locally but failed to publish publicly.',
          });
        }
      }

      setIsEditing(false);
    } catch (e) {
      logger.warn('[profile] save failed', e);
      showToast({
        type: 'error',
        title: "Couldn't save profile",
        message: e instanceof Error ? e.message : 'Please try again.',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditDisplayName(user?.displayName || '');
    setEditBio(user?.bio || '');
    setIsEditing(false);
  };


  // Format hex public key as Qm-style address using proper derivation
  const formatResolveKeyAsAddress = (hexKey: string): string => {
    try {
      // deriveAddress handles hex input (with or without 0x prefix)
      // and returns a proper Qm... base58 address
      const address = deriveAddress(hexKey);
      // Truncate for display
      return `${address.slice(0, 8)}...${address.slice(-6)}`;
    } catch {
      return hexKey.slice(0, 16) + '...';
    }
  };

  // Copy user address to clipboard
  const handleCopyAddress = React.useCallback(async () => {
    if (!user?.address) return;
    await Clipboard.setStringAsync(user.address);
    Alert.alert('Copied', 'Address copied to clipboard');
  }, [user?.address]);

  // QNS health check - determine if service is available
  const { isServiceDown, isLoading: isCheckingHealth } = useQNSHealth();

  // QNS launch countdown - Jan 7, 2026 14:00 UTC
  const QNS_LAUNCH_DATE = React.useMemo(() => new Date('2026-01-07T14:00:00Z'), []);

  // Always calculate countdown - will be displayed when service is unavailable
  React.useEffect(() => {
    const updateCountdown = () => {
      const now = new Date();
      const diff = QNS_LAUNCH_DATE.getTime() - now.getTime();

      if (diff <= 0) {
        setCountdown(null);
        return;
      }

      const days = Math.floor(diff / (1000 * 60 * 60 * 24));
      const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);

      setCountdown({ days, hours, minutes, seconds });
    };

    updateCountdown();
    const interval = setInterval(updateCountdown, 1000);

    return () => clearInterval(interval);
  }, [QNS_LAUNCH_DATE]);

  // QNS hooks for username registration
  const debouncedUsernameSearch = React.useMemo(() => {
    const trimmed = usernameSearch.trim().toLowerCase();
    return trimmed.length >= 1 ? trimmed : '';
  }, [usernameSearch]);

  const {
    data: availability,
    isLoading: isCheckingAvailability,
    error: availabilityError,
  } = useCheckNameAvailability(debouncedUsernameSearch, 'username', {
    enabled: debouncedUsernameSearch.length >= 1,
  });

  // Resolve the name when it's not available (to show the resolved address)
  const {
    data: resolvedName,
    isLoading: isResolvingName,
  } = useResolveName(debouncedUsernameSearch, {
    enabled: debouncedUsernameSearch.length >= 1 && availability?.available === false,
  });

  const { data: pricing } = usePricing();

  // Get stealth key material for bucket lookup
  const [stealthKeyMaterial, setStealthKeyMaterial] = React.useState<{
    viewKeyMaterial: Uint8Array;
    spendPubKey: Uint8Array;
    bucketTag: number;
  } | null>(null);

  // Load stealth key material on mount
  React.useEffect(() => {
    const loadStealthKeys = async () => {
      try {
        if (!user?.quilibriumAddress) {
          return;
        }

        // Get mnemonic for proper key derivation (needed for mnemonic accounts)
        const mnemonic = await getMnemonic();
        const privateKey = await getPrivateKey();

        const keyMaterial = getStealthKeyMaterial(
          user.quilibriumAddress,
          mnemonic ?? undefined,
          privateKey ?? undefined
        );

        // Also extract viewPubKey from address for comparison
        const cleanAddr = user.quilibriumAddress.replace('0x', '');
        const viewPubKeyFromAddr = cleanAddr.slice(0, 112); // First 56 bytes as hex

        setStealthKeyMaterial(keyMaterial);
      } catch (e) {
        // Stealth key derivation failed — non-critical, leave material as null
        logger.warn('[qns] stealth key derivation failed', e);
      }
    };
    if (visible && user?.quilibriumAddress) {
      loadStealthKeys();
    }
  }, [visible, user?.quilibriumAddress]);

  // Bucket lookup for stealth ownership records
  const {
    data: bucketRecords,
    isLoading: isLoadingBucketRecords,
  } = useBucketLookup(stealthKeyMaterial?.bucketTag, {
    enabled: stealthKeyMaterial !== null,
  });

  // Reverse lookup to find names that resolve to our public key (delegated names)
  // The QNS API expects the ed448 public key with 0x prefix
  const reverseKeyParam = user?.publicKey ? (user.publicKey.startsWith('0x') ? user.publicKey : `0x${user.publicKey}`) : undefined;
  const {
    data: reverseResolvedNames,
    isLoading: isLoadingReverseNames,
  } = useReverseLookup(reverseKeyParam, {
    enabled: !!reverseKeyParam && !isCheckingHealth && !isServiceDown,
  });

  // Filter bucket records to find our owned names and track which are resolvable
  const { ownedNames: existingNames, serverResolvableNames } = React.useMemo(() => {
    if (!bucketRecords || !stealthKeyMaterial) {
      return { ownedNames: [], serverResolvableNames: [] as string[] };
    }

    // Handle both array format and legacy cached format { records: [...] }
    const records = Array.isArray(bucketRecords)
      ? bucketRecords
      : (bucketRecords as any)?.records;

    if (!Array.isArray(records)) {
      return { ownedNames: [], serverResolvableNames: [] as string[] };
    }

    const ownedNames: string[] = [];
    const resolvableNames: string[] = [];
    for (const record of records) {
      // Bucket API returns name directly, not in header
      const recordName = (record as any).name || record.header?.name;

      // Check if this record's ownership belongs to us
      if (record.ownership?.one_time_key && record.ownership?.verification_key) {
        try {
          // Decode base64 keys
          const oneTimeKey = Uint8Array.from(atob(record.ownership.one_time_key), c => c.charCodeAt(0));
          const verificationKey = Uint8Array.from(atob(record.ownership.verification_key), c => c.charCodeAt(0));

          // Verify ownership
          const isOwned = verifyStealthOwnership(
            stealthKeyMaterial.viewKeyMaterial,
            stealthKeyMaterial.spendPubKey,
            oneTimeKey,
            verificationKey
          );

          if (isOwned && recordName) {
            ownedNames.push(recordName);
            // Check if this name has a resolve key set (is publicly resolvable)
            if ((record as any).resolve_key) {
              resolvableNames.push(recordName);
            }
          }
        } catch (e) {
          // Stealth ownership verification failed for this record — skip
          logger.warn('[qns] stealth ownership verification failed for record', recordName, e);
        }
      }
    }

    return { ownedNames, serverResolvableNames: resolvableNames };
  }, [bucketRecords, stealthKeyMaterial]);

  // Initialize resolvableNames from server data when bucket records load
  React.useEffect(() => {
    if (serverResolvableNames.length > 0) {
      setResolvableNames(prev => {
        const newSet = new Set(prev);
        serverResolvableNames.forEach(name => newSet.add(name));
        return newSet;
      });
    }
  }, [serverResolvableNames]);

  // Delegated names: names that resolve to our address but we don't own
  // These are names someone else registered and pointed to our address
  const delegatedNames = React.useMemo(() => {
    if (!reverseResolvedNames || reverseResolvedNames.length === 0) {
      return [];
    }
    const ownedSet = new Set(existingNames);
    return reverseResolvedNames.filter(name => !ownedSet.has(name));
  }, [reverseResolvedNames, existingNames]);

  const isLoadingExistingNames = isLoadingBucketRecords || isLoadingReverseNames;

  // Find a name's stealth ownership record among the bucket records.
  // The server only exposes ownership markers via GET /bucket/{tag}, so child
  // modals (NameDetailModal, ListNameModal) receive the matched record as a prop.
  const findBucketRecord = React.useCallback(
    (name: string) => {
      if (!bucketRecords || !name) return null;
      const records = Array.isArray(bucketRecords)
        ? bucketRecords
        : (bucketRecords as any)?.records;
      if (!Array.isArray(records)) return null;
      return records.find(r => ((r as any).name || r.header?.name) === name) ?? null;
    },
    [bucketRecords]
  );

  const selectedNameDetailRecord = React.useMemo(
    () => findBucketRecord(selectedNameForDetail),
    [findBucketRecord, selectedNameForDetail]
  );

  const nameToListRecord = React.useMemo(
    () => findBucketRecord(nameToList ?? ''),
    [findBucketRecord, nameToList]
  );

  const { mutate: registerWithPayment, isPending: isRegistering } = useRegisterWithPayment();

  // Invite code hooks
  const {
    data: inviteCodeValidation,
    isLoading: isValidatingInviteCode,
    error: inviteCodeError,
  } = useValidateInviteCode(inviteCode.trim() || undefined, {
    enabled: inviteCode.trim().length >= 1,
  });

  const { mutate: redeemInviteCode, isPending: isRedeeming } = useRedeemInviteCode();
  const { mutate: updateResolveKey, isPending: isUpdatingResolveKey } = useUpdateResolveKey();

  // Track which names have been made resolvable (locally after successful API call)
  const [resolvableNames, setResolvableNames] = React.useState<Set<string>>(new Set());

  const handleMakeResolvable = (name: string) => {
    if (!user?.quilibriumAddress || !user?.publicKey || !bucketRecords) return;

    // Find the record for this name to get its stealth markers
    const record = bucketRecords.find(r => (r as any).name === name || r.header?.name === name);
    if (!record?.ownership?.one_time_key || !record?.ownership?.verification_key) {
      Alert.alert('Error', 'Could not find ownership record for this name');
      return;
    }

    // Capture the validated markers so the async onPress closure below has
    // non-undefined values (the guard above can't narrow record.ownership
    // through the closure boundary).
    const oneTimeKeyB64 = record.ownership.one_time_key;
    const verificationKeyB64 = record.ownership.verification_key;

    Alert.alert(
      'Make Name Resolvable',
      `Allow others to look up your public key via @${name}?\n\nThis enables encrypted messaging to your address.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Enable',
          onPress: async () => {
            try {
              // Get mnemonic and private key for signing
              const mnemonic = await getMnemonic();
              const privateKey = await getPrivateKey();

              // Get full stealth key material (view + spend)
              const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );

              // Decode the stealth markers from the bucket record
              const oneTimeKey = Uint8Array.from(atob(oneTimeKeyB64), c => c.charCodeAt(0));
              const verificationKey = Uint8Array.from(atob(verificationKeyB64), c => c.charCodeAt(0));

              // Generate timestamp and nonce
              const timestamp = Math.floor(Date.now() / 1000);
              const nonce = generateNonce();

              // Sign with stealth private key (x = H(viewPrivKey * oneTimeKey) + spendPrivKey)
              // This proves ownership without revealing the wallet address
              const signature = signStealthOwnership(
                viewKeyMaterial,
                spendKeyMaterial,
                oneTimeKey,
                verificationKey,
                name,
                'username',
                timestamp,
                nonce
              );

              updateResolveKey(
                {
                  name,
                  nameType: 'username',
                  resolveKey: user.publicKey, // ed448 public key as hex
                  signature,
                  timestamp,
                  nonce,
                  // Note: walletAddress not sent for Quilibrium stealth ownership
                },
                {
                  onSuccess: () => {
                    // Track that this name is now resolvable
                    setResolvableNames(prev => new Set([...prev, name]));
                    Alert.alert('Success', `@${name} is now publicly resolvable!`);
                  },
                  onError: (error) => {
                    Alert.alert('Error', error instanceof Error ? error.message : 'Failed to update');
                  },
                }
              );
            } catch (error) {
              Alert.alert('Error', error instanceof Error ? error.message : 'Failed to sign request');
            }
          },
        },
      ]
    );
  };

  const handleRedeemInviteCode = () => {
    if (!inviteCodeValidation?.valid || !user?.quilibriumAddress) return;

    // Check if user has searched for a different name than the reserved one
    const hasSearchedName = debouncedUsernameSearch && availability?.available;
    const isUsingSearchedName = hasSearchedName &&
      debouncedUsernameSearch !== inviteCodeValidation.reserved_name;

    // Determine which name to register:
    // - If user searched for an available name, use that
    // - Otherwise use the reserved name (if any)
    // - If neither, prompt user to search
    let nameToRegister: string;
    let governancePoints: number;

    if (hasSearchedName) {
      // User searched for an available name - use it
      nameToRegister = debouncedUsernameSearch;
      governancePoints = availability?.governance_points || 0;
    } else if (inviteCodeValidation.reserved_name) {
      // Use the reserved name
      nameToRegister = inviteCodeValidation.reserved_name;
      governancePoints = inviteCodeValidation.governance_points || 0;
    } else {
      // General-use code with no search - prompt user
      Alert.alert('Search Required', 'Please search for an available username first, then redeem your invite code.');
      return;
    }

    // Build the confirmation message
    let message = `Claim @${nameToRegister} for free?\n\nYou'll earn ${governancePoints} governance points.`;
    if (isUsingSearchedName && inviteCodeValidation.reserved_name) {
      message += `\n\nNote: This will free up @${inviteCodeValidation.reserved_name} for others to claim.`;
    }

    Alert.alert(
      'Redeem Invite Code',
      message,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Redeem',
          onPress: () => {
            try {
              // Generate stealth ownership markers for privacy
              const stealth = generateStealthOwnership(user.quilibriumAddress);
              const ownership = stealthOwnershipToApi(stealth);

              // If using a searched name (different from reserved), pass name/nameType
              // This tells the API to register the searched name and free the reserved one
              const redeemParams = isUsingSearchedName || !inviteCodeValidation.reserved_name
                ? {
                    inviteCode: inviteCode.trim(),
                    ownership,
                    name: nameToRegister,
                    nameType: 'username' as const,
                  }
                : { inviteCode: inviteCode.trim(), ownership };

              redeemInviteCode(
                redeemParams,
                {
                  onSuccess: (registration) => {
                    Alert.alert(
                      'Success!',
                      `You've claimed @${registration.name}!\n\nGovernance points earned: ${registration.governance_points}`
                    );
                    setInviteCode('');
                    setUsernameSearch('');
                    // Refresh stealth key material to trigger bucket lookup refresh
                    if (stealthKeyMaterial) {
                      setStealthKeyMaterial({ ...stealthKeyMaterial });
                    }
                  },
                  onError: (error) => {
                    Alert.alert('Error', error instanceof Error ? error.message : 'Failed to redeem invite code');
                  },
                }
              );
            } catch (error) {
              Alert.alert('Error', 'Failed to generate ownership proof');
            }
          },
        },
      ]
    );
  };

  const handleClaimUsername = () => {
    if (!debouncedUsernameSearch || !availability?.available) return;

    // Open in-app payment modal for paid registration
    setRegisterPaymentName(debouncedUsernameSearch);
    setRegisterPaymentVisible(true);
  };

  const profileContent = (
    <>
      {/* Header */}
      {!hideHeader && (
        <View style={styles.header}>
          <Text style={styles.title}>Profile</Text>
          {activeTab === 'profile' && !isEditing && (
            <TouchableOpacity onPress={() => setIsEditing(true)} style={styles.editButton}>
              <IconSymbol name="pencil" size={18} color={theme.colors.primary} />
              <Text style={styles.editButtonText}>Edit</Text>
            </TouchableOpacity>
          )}
          {activeTab === 'profile' && isEditing && (
            <View style={styles.editActions}>
              <TouchableOpacity onPress={handleCancelEdit} style={styles.cancelButton}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handleSaveProfile} style={styles.saveButton} disabled={isSaving}>
                {isSaving ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.saveButtonText}>Save</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Tabs */}
      <View style={styles.tabs}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'profile' && styles.tabActive]}
          onPress={() => setActiveTab('profile')}
        >
          <Text style={[styles.tabText, activeTab === 'profile' && styles.tabTextActive]}>Profile</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'premium' && styles.tabActive]}
          onPress={() => setActiveTab('premium')}
        >
          <Text style={[styles.tabText, activeTab === 'premium' && styles.tabTextActive]}>Premium</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'settings' && styles.tabActive]}
          onPress={() => setActiveTab('settings')}
        >
          <Text style={[styles.tabText, activeTab === 'settings' && styles.tabTextActive]}>Settings</Text>
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} style={styles.scrollContent}>
        {activeTab === 'profile' && (
          <ProfileTabSection
            styles={styles}
            theme={theme}
            hideHeader={hideHeader}
            user={user}
            isEditing={isEditing}
            editDisplayName={editDisplayName}
            editBio={editBio}
            onChangeDisplayName={setEditDisplayName}
            onChangeBio={setEditBio}
            onPickImage={handlePickImage}
            onCopyAddress={handleCopyAddress}
            isApexActive={apexState.isActive}
          />
        )}

        {activeTab === 'premium' && (
          <>
            {/* Quorum Apex */}
            <ApexSectionCard
              styles={styles}
              apexState={apexState}
              onOpenApexModal={setApexModalMode}
            />

            {/* Premium Banner */}
            <View style={[styles.premiumBanner, { backgroundColor: theme.colors.primary }]}>
              <IconSymbol name="star.fill" size={32} color="#fff" />
              <Text style={styles.premiumTitle}>Claim Your Username</Text>
              <Text style={styles.premiumSubtitle}>
                Secure a unique @username on the Quilibrium network
              </Text>
            </View>

            {/* Launch Countdown, Loading, or Service Unavailable */}
            {(isCheckingHealth || isServiceDown) && (
              <View style={styles.countdownContainer}>
                {isCheckingHealth ? (
                  <>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                    <Text style={[styles.countdownSubtitle, { marginTop: Skin.space(16) }]}>
                      Checking service availability...
                    </Text>
                  </>
                ) : countdown ? (
                  <>
                    <Text style={styles.countdownTitle}>Claims Unlocking</Text>
                    <Text style={styles.countdownSubtitle}>
                      Username claims with the Quilibrium Name Service unlock in
                    </Text>
                    <View style={styles.countdownTimer}>
                      <View style={styles.countdownUnit}>
                        <Text style={styles.countdownValue}>{countdown.days}</Text>
                        <Text style={styles.countdownLabel}>days</Text>
                      </View>
                      <Text style={styles.countdownSeparator}>:</Text>
                      <View style={styles.countdownUnit}>
                        <Text style={styles.countdownValue}>{countdown.hours.toString().padStart(2, '0')}</Text>
                        <Text style={styles.countdownLabel}>hours</Text>
                      </View>
                      <Text style={styles.countdownSeparator}>:</Text>
                      <View style={styles.countdownUnit}>
                        <Text style={styles.countdownValue}>{countdown.minutes.toString().padStart(2, '0')}</Text>
                        <Text style={styles.countdownLabel}>min</Text>
                      </View>
                      <Text style={styles.countdownSeparator}>:</Text>
                      <View style={styles.countdownUnit}>
                        <Text style={styles.countdownValue}>{countdown.seconds.toString().padStart(2, '0')}</Text>
                        <Text style={styles.countdownLabel}>sec</Text>
                      </View>
                    </View>
                    <Text style={styles.countdownDate}>January 7, 2026 at 14:00 UTC</Text>
                  </>
                ) : (
                  <>
                    <Text style={styles.countdownTitle}>Service Unavailable</Text>
                    <Text style={styles.countdownSubtitle}>
                      The Quilibrium Name Service is temporarily unavailable. Please try again later.
                    </Text>
                  </>
                )}
              </View>
            )}

            {/* Only show content when service is confirmed available */}
            {!isCheckingHealth && !isServiceDown && (
              <>
            {/* Existing Names */}
            {existingNames && existingNames.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Your Names</Text>
                {existingNames.map((name) => {
                  const isResolvable = resolvableNames.has(name);
                  const isPrimary = user?.primaryUsername === name;
                  return (
                    <TouchableOpacity
                      key={name}
                      style={styles.usernameItem}
                      onPress={() => {
                        setSelectedNameForDetail(name);
                        setNameDetailVisible(true);
                      }}
                      activeOpacity={0.7}
                    >
                      <View style={styles.usernameLeft}>
                        <Text style={styles.usernameText}>@{name}</Text>
                        <Text style={styles.availabilityText}>
                          {isPrimary ? 'Primary username' : isResolvable ? 'Publicly resolvable' : 'Registered to you'}
                        </Text>
                      </View>
                      <View style={styles.usernameRight}>
                        {isResolvable ? (
                          isPrimary ? (
                            <View style={styles.primaryBadge}>
                              <IconSymbol name="star.fill" size={14} color={theme.colors.primary} />
                              <Text style={styles.primaryText}>Primary</Text>
                            </View>
                          ) : (
                            <TouchableOpacity
                              style={styles.setPrimaryButton}
                              onPress={() => {
                                updateProfile({ primaryUsername: name });
                                Alert.alert('Primary Set', `@${name} is now your primary username.`);
                              }}
                            >
                              <Text style={styles.setPrimaryButtonText}>Set as Primary</Text>
                            </TouchableOpacity>
                          )
                        ) : (
                          <TouchableOpacity
                            style={styles.resolveButton}
                            onPress={() => handleMakeResolvable(name)}
                            disabled={isUpdatingResolveKey}
                          >
                            <Text style={styles.resolveButtonText}>
                              {isUpdatingResolveKey ? 'Updating...' : 'Make Resolvable'}
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </TouchableOpacity>
                  );
                })}
                {/* List on Marketplace Button — requires ownership */}
                <TouchableOpacity
                  style={styles.marketplaceButton}
                  onPress={() => {
                    if (existingNames.length === 1) {
                      // Only one name, list it directly
                      setNameToList(existingNames[0]);
                      setListNameModalVisible(true);
                    } else {
                      // Multiple names, show picker modal
                      setShowNamePickerModal(true);
                    }
                  }}
                >
                  <IconSymbol name="tag.fill" size={18} color={theme.colors.primary} />
                  <Text style={styles.marketplaceButtonText}>List on Marketplace</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* Marketplace / Auctions / Offers — discovery actions, always visible */}
            <View style={styles.section}>
              <TouchableOpacity
                style={styles.marketplaceButton}
                onPress={() => onOpenMarketplace ? onOpenMarketplace() : setMarketplaceModalVisible(true)}
              >
                <IconSymbol name="storefront.fill" size={18} color={theme.colors.primary} />
                <Text style={styles.marketplaceButtonText}>Browse Marketplace</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.marketplaceButton}
                onPress={() => onOpenAuctions ? onOpenAuctions() : setAuctionsModalVisible(true)}
              >
                <IconSymbol name="hammer.fill" size={18} color={theme.colors.primary} />
                <Text style={styles.marketplaceButtonText}>Auctions</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.marketplaceButton}
                onPress={() => onOpenOffers ? onOpenOffers() : setOffersModalVisible(true)}
              >
                <IconSymbol name="envelope.fill" size={18} color={theme.colors.primary} />
                <Text style={styles.marketplaceButtonText}>Offers</Text>
              </TouchableOpacity>
            </View>

            {/* Delegated Names - names that resolve to our address but we don't own */}
            {delegatedNames && delegatedNames.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Delegated to You</Text>
                <Text style={[styles.settingDescription, { marginBottom: Skin.space(12) }]}>
                  These names resolve to your address but are owned by someone else.
                </Text>
                {delegatedNames.map((name) => {
                  const isPrimary = user?.primaryUsername === name;
                  return (
                    <View key={name} style={styles.usernameItem}>
                      <View style={styles.usernameLeft}>
                        <Text style={styles.usernameText}>@{name}</Text>
                        <Text style={styles.availabilityText}>
                          {isPrimary ? 'Primary username' : 'Resolves to your address'}
                        </Text>
                      </View>
                      <View style={styles.usernameRight}>
                        {isPrimary ? (
                          <View style={styles.primaryBadge}>
                            <IconSymbol name="star.fill" size={14} color={theme.colors.primary} />
                            <Text style={styles.primaryText}>Primary</Text>
                          </View>
                        ) : (
                          <TouchableOpacity
                            style={styles.setPrimaryButton}
                            onPress={() => {
                              updateProfile({ primaryUsername: name });
                              Alert.alert('Primary Set', `@${name} is now your primary username.`);
                            }}
                          >
                            <Text style={styles.setPrimaryButtonText}>Set as Primary</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Invite Code Section */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Have an Invite Code?</Text>
              <Text style={[styles.settingDescription, { marginBottom: Skin.space(12) }]}>
                Enter your invite code to claim a reserved username for free.
              </Text>
              <View style={styles.searchContainer}>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Enter invite code..."
                  placeholderTextColor={theme.colors.textMuted}
                  value={inviteCode}
                  onChangeText={setInviteCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={styles.searchButton}>
                  {isValidatingInviteCode ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (
                    <IconSymbol name="ticket.fill" size={20} color={theme.colors.textMuted} />
                  )}
                </View>
              </View>

              {/* Invite Code Result */}
              {inviteCode.trim().length >= 1 && !isValidatingInviteCode && inviteCodeValidation && (
                <View style={[
                  styles.usernameItem,
                  !inviteCodeValidation.valid && styles.usernameItemTaken,
                  { marginTop: Skin.space(16) }
                ]}>
                  <View style={styles.usernameLeft}>
                    {inviteCodeValidation.valid ? (
                      inviteCodeValidation.reserved_name ? (
                        // Reserved name code - shows specific name
                        <>
                          <Text style={styles.usernameText}>@{inviteCodeValidation.reserved_name}</Text>
                          <Text style={styles.availabilityText}>
                            Free claim - {inviteCodeValidation.governance_points} governance points
                          </Text>
                        </>
                      ) : (
                        // General-use code - user can choose any available name
                        <>
                          <Text style={styles.usernameText}>✓ Valid Invite Code</Text>
                          <Text style={styles.availabilityText}>
                            Search for any available username below to claim it free
                          </Text>
                        </>
                      )
                    ) : (
                      <>
                        <Text style={[styles.usernameText, styles.usernameTextTaken]}>Invalid Code</Text>
                        <Text style={styles.availabilityText}>
                          {inviteCodeValidation.reason || 'This invite code is not valid'}
                        </Text>
                      </>
                    )}
                  </View>
                  <View style={styles.usernameRight}>
                    {inviteCodeValidation.valid ? (
                      inviteCodeValidation.reserved_name ? (
                        // Reserved name code - can redeem directly
                        <TouchableOpacity
                          style={styles.buyButton}
                          onPress={handleRedeemInviteCode}
                          disabled={isRedeeming}
                        >
                          {isRedeeming ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={styles.buyButtonText}>Redeem</Text>
                          )}
                        </TouchableOpacity>
                      ) : (
                        // General-use code - show checkmark, redeem button will be on search result
                        <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success} />
                      )
                    ) : (
                      <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.danger} />
                    )}
                  </View>
                </View>
              )}
            </View>

            {/* Search Section */}
            <View style={styles.searchSection}>
              <Text style={styles.sectionTitle}>Search for a Username</Text>
              <View style={styles.searchContainer}>
                <TextInput
                  style={styles.searchInput}
                  placeholder="Enter username..."
                  placeholderTextColor={theme.colors.textMuted}
                  value={usernameSearch}
                  onChangeText={setUsernameSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={styles.searchButton}>
                  {isCheckingAvailability ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : (
                    <IconSymbol name="magnifyingglass" size={20} color={theme.colors.textMuted} />
                  )}
                </View>
              </View>

              {/* Search Result */}
              {debouncedUsernameSearch.length >= 1 && !isCheckingAvailability && availability && (
                <View style={[
                  styles.usernameItem,
                  !availability.available && !resolvedName?.resolveKey && styles.usernameItemTaken,
                  { marginTop: Skin.space(16) }
                ]}>
                  <View style={styles.usernameLeft}>
                    <Text style={[
                      styles.usernameText,
                      !availability.available && !resolvedName?.resolveKey && styles.usernameTextTaken
                    ]}>
                      @{debouncedUsernameSearch}
                    </Text>
                    {availability.available ? (
                      <Text style={styles.availabilityText}>
                        Available - {availability.governance_points} governance points
                      </Text>
                    ) : resolvedName?.resolveKey ? (
                      <Text style={styles.resolvedAddressText} numberOfLines={1}>
                        {formatResolveKeyAsAddress(resolvedName.resolveKey)}
                      </Text>
                    ) : isResolvingName ? (
                      <Text style={styles.availabilityText}>Resolving...</Text>
                    ) : (
                      <Text style={styles.availabilityText}>
                        {availability.reason || 'Not available'}
                      </Text>
                    )}
                  </View>
                  <View style={styles.usernameRight}>
                    {availability.available && (
                      inviteCodeValidation?.valid ? (
                        // Any valid invite code - show free claim button
                        <TouchableOpacity
                          style={[styles.buyButton, { backgroundColor: theme.colors.success }]}
                          onPress={handleRedeemInviteCode}
                          disabled={isRedeeming}
                        >
                          {isRedeeming ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={styles.buyButtonText}>Claim Free</Text>
                          )}
                        </TouchableOpacity>
                      ) : (
                        // No invite code - show price
                        <>
                          <Text style={styles.priceText}>{availability.price_quil} QUIL</Text>
                          <TouchableOpacity
                            style={styles.buyButton}
                            onPress={handleClaimUsername}
                            disabled={isRegistering}
                          >
                            {isRegistering ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <Text style={styles.buyButtonText}>Buy</Text>
                            )}
                          </TouchableOpacity>
                        </>
                      )
                    )}
                    {!availability.available && resolvedName?.resolveKey && (
                      <View style={styles.resolvedBadge}>
                        <IconSymbol name="checkmark.seal.fill" size={16} color={theme.colors.success} />
                        <Text style={styles.resolvedText}>Registered</Text>
                      </View>
                    )}
                    {!availability.available && !resolvedName?.resolveKey && !isResolvingName && (
                      <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.danger} />
                    )}
                    {!availability.available && isResolvingName && (
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                    )}
                  </View>
                </View>
              )}

            </View>

            {/* Benefits Section */}
            <View style={styles.benefitsSection}>
              <Text style={styles.sectionTitle}>Benefits</Text>
              <View style={styles.benefitItem}>
                <IconSymbol name="person.badge.shield.checkmark.fill" size={20} color={theme.colors.primary} />
                <Text style={styles.benefitText}>
                  Unique identity across the Quilibrium network
                </Text>
              </View>
              <View style={styles.benefitItem}>
                <IconSymbol name="hand.thumbsup.fill" size={20} color={theme.colors.primary} />
                <Text style={styles.benefitText}>
                  Earn governance points to participate in QNS decisions
                </Text>
              </View>
              <View style={styles.benefitItem}>
                <IconSymbol name="link" size={20} color={theme.colors.primary} />
                <Text style={styles.benefitText}>
                  Easy-to-share address for receiving messages and payments
                </Text>
              </View>
            </View>

            {/* Pricing Info */}
            {pricing && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Pricing Tiers</Text>
                {pricing.tiers.map((tier, index) => (
                  <View key={index} style={styles.infoRow}>
                    <Text style={styles.infoLabel}>
                      {tier.min_length === tier.max_length
                        ? `${tier.min_length} characters`
                        : `${tier.min_length}-${tier.max_length} characters`}
                    </Text>
                    <Text style={styles.infoValue}>{tier.price_quil} QUIL</Text>
                  </View>
                ))}
              </View>
            )}
              </>
            )}
          </>
        )}

        {activeTab === 'settings' && (
          <>
            {/* Privacy & Sync, Notifications, Feed Settings */}
            <PrivacyFeedSettingsSection
              styles={styles}
              theme={theme}
              isProfilePublic={!!user?.isProfilePublic}
              onTogglePublicProfile={handleTogglePublicProfile}
              allowSync={allowSync}
              onToggleSync={handleToggleSync}
              syncDisabled={isSyncLoading || isSyncToggling}
              notifications={notifications}
              onToggleNotifications={setNotifications}
              showRepliesInFeed={showRepliesInFeed}
              onToggleShowReplies={setShowRepliesInFeed}
              showNonFollowReplies={showNonFollowReplies}
              onToggleShowNonFollowReplies={setShowNonFollowReplies}
            />

            {/* Appearance */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Appearance</Text>
              <TouchableOpacity style={styles.settingRow} onPress={() => setSkinsOpen(true)}>
                <View style={styles.settingLeft}>
                  <Text style={styles.settingLabel}>Skins</Text>
                  <Text style={styles.settingDescription}>
                    {activeSkin
                      ? `Active: ${activeSkin.meta.name}`
                      : 'Customize colors, fonts, and background'}
                  </Text>
                </View>
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.settingRow} onPress={() => setTranslateOpen(true)}>
                <View style={styles.settingLeft}>
                  <Text style={styles.settingLabel}>Translate to</Text>
                  <Text style={styles.settingDescription}>
                    {`On-device translation target: ${targetLanguageName}`}
                  </Text>
                </View>
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
            </View>

            {/* Farcaster */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Farcaster</Text>
              {user?.farcaster ? (
                // Connected state
                <>
                  <View style={styles.farcasterConnected}>
                    <View style={styles.farcasterInfo}>
                      <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success} />
                      <View style={styles.farcasterDetails}>
                        <Text style={styles.farcasterUsername}>@{user.farcaster.username}</Text>
                        <Text style={styles.farcasterFid}>FID: {user.farcaster.fid}</Text>
                      </View>
                    </View>
                    <TouchableOpacity
                      style={styles.farcasterDisconnectButton}
                      onPress={handleDisconnectFarcaster}
                    >
                      <Text style={styles.farcasterDisconnectText}>Disconnect</Text>
                    </TouchableOpacity>
                  </View>
                  {/* Hypersnap signer opt-in */}
                  <View style={[styles.farcasterConnected, { marginTop: Skin.space(12) }]}>
                    <View style={{ flex: 1, marginRight: Skin.space(12) }}>
                      <Text style={{ fontSize: Skin.font(15), color: theme.colors.textMain }}>Hypersnap Signer</Text>
                      <Text style={{ fontSize: Skin.font(12), color: theme.colors.textMuted, marginTop: Skin.space(2) }}>
                        Post and react through Quilibrium's hub to earn $SNAP
                      </Text>
                    </View>
                    {hypersnapBusy ? (
                      <ActivityIndicator size="small" color={theme.colors.primary} />
                    ) : (
                      <Switch
                        value={hypersnapEnabled}
                        onValueChange={handleToggleHypersnap}
                        trackColor={{ true: theme.colors.primary }}
                      />
                    )}
                  </View>
                  {/* Warpcast Wallet Import */}
                  {hasWarpcastWallet && !hasImportedWarpcastWallet && onOpenWarpcastImport && (
                    <TouchableOpacity
                      style={[styles.actionButton, { marginTop: Skin.space(12), alignItems: 'flex-start' }]}
                      onPress={() => {
                        if (isRouteMode) {
                          // In route mode, just open the import modal directly (no need to close ProfileModal)
                          onOpenWarpcastImport();
                        } else {
                          // In modal mode, close ProfileModal first then open import modal
                          onClose();
                          setTimeout(onOpenWarpcastImport, 300);
                        }
                      }}
                    >
                      <IconSymbol name="wallet.pass.fill" size={20} color={theme.colors.primary} style={{ marginTop: Skin.space(2) }} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.actionButtonText}>Import Warpcast Wallet</Text>
                        <Text style={[styles.settingDescription, { marginTop: Skin.space(4), marginLeft: Skin.space(12) }]}>
                          Import your Warpcast embedded wallet to use alongside your Quorum wallet
                        </Text>
                      </View>
                      <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} style={{ marginTop: Skin.space(2) }} />
                    </TouchableOpacity>
                  )}
                  {hasImportedWarpcastWallet && importedWallet && (
                    <View style={[styles.farcasterConnected, { marginTop: Skin.space(12) }]}>
                      <View style={styles.farcasterInfo}>
                        <IconSymbol name="wallet.pass.fill" size={20} color={theme.colors.primary} />
                        <View style={styles.farcasterDetails}>
                          <Text style={styles.farcasterUsername}>Warpcast Wallet</Text>
                          <Text style={styles.farcasterFid}>
                            {importedWallet.address.slice(0, 10)}...{importedWallet.address.slice(-6)}
                          </Text>
                        </View>
                      </View>
                      <IconSymbol name="checkmark.circle.fill" size={20} color={theme.colors.success} />
                    </View>
                  )}
                </>
              ) : !showFarcasterImport ? (
                // Not connected state
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => setShowFarcasterImport(true)}
                >
                  <IconSymbol name="person.badge.plus" size={20} color={theme.colors.textMain} />
                  <Text style={styles.actionButtonText}>Import Farcaster Account</Text>
                  <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
                </TouchableOpacity>
              ) : (
                // Import state
                <View style={styles.farcasterImportContainer}>
                  <Text style={styles.farcasterImportDescription}>
                    Enter your Farcaster recovery phrase (12 or 24 words) to import your account.
                  </Text>
                  <TextInput
                    style={styles.farcasterMnemonicInput}
                    value={farcasterMnemonic}
                    onChangeText={(text) => {
                      setFarcasterMnemonic(text);
                      setFarcasterError(null);
                    }}
                    placeholder="Enter recovery phrase..."
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    numberOfLines={3}
                    textAlignVertical="top"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!farcasterImporting}
                  />
                  {farcasterError && (
                    <View style={styles.farcasterErrorContainer}>
                      <IconSymbol name="exclamationmark.circle.fill" size={16} color={theme.colors.danger} />
                      <Text style={styles.farcasterErrorText}>{farcasterError}</Text>
                    </View>
                  )}
                  <View style={styles.farcasterImportActions}>
                    <TouchableOpacity
                      style={styles.farcasterCancelButton}
                      onPress={() => {
                        setShowFarcasterImport(false);
                        setFarcasterMnemonic('');
                        setFarcasterError(null);
                      }}
                      disabled={farcasterImporting}
                    >
                      <Text style={styles.farcasterCancelText}>Cancel</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[styles.farcasterImportButton, farcasterImporting && styles.farcasterImportButtonDisabled]}
                      onPress={handleImportFarcaster}
                      disabled={farcasterImporting}
                    >
                      {farcasterImporting ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.farcasterImportButtonText}>Import</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>

            {/* Account Actions */}
            <AccountRecoverySection
              styles={styles}
              theme={theme}
              showRecoveryPhrase={showRecoveryPhrase}
              recoveryPhrase={recoveryPhrase}
              hexPrivateKey={hexPrivateKey}
              onExport={handleExportRecoveryPhrase}
              onCopy={handleCopyRecoveryPhrase}
              onHide={handleHideRecoveryPhrase}
            />

            {/* Device Keys */}
            <DeviceKeysSection
              styles={styles}
              theme={theme}
              isLoadingDevices={isLoadingDevices}
              deviceRegistrations={deviceRegistrations}
              currentDeviceInboxAddress={currentDeviceInboxAddress}
              isRemovingDevice={isRemovingDevice}
              onRemoveDevice={handleRemoveDevice}
              onResetAllSessions={handleResetAllSessions}
            />

            {/* Calls */}
            <CallScreeningSection theme={theme} />

            {/* App Updates (OTA) */}
            <OtaUpdateSection theme={theme} />

            {/* Developer — only visible in dev builds */}
            {__DEV__ && <DevModeSection theme={theme} />}

            {/* Danger Zone */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Danger Zone</Text>
              <TouchableOpacity style={[styles.actionButton, styles.dangerButton]} onPress={() => setShowResetConfirm(true)}>
                <IconSymbol name="arrow.counterclockwise" size={20} color={theme.colors.danger} />
                <Text style={[styles.actionButtonText, styles.dangerText]}>Reset App Data</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </ScrollView>
    </>
  );

  // In route mode, render directly without modal wrapper
  if (isRouteMode) {
    return (
      <>
        <View style={[styles.routeContainer, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
          {profileContent}
        </View>

        {/* Registration Payment Modal */}
        <RegisterPaymentModal
          visible={registerPaymentVisible}
          onClose={() => {
            setRegisterPaymentVisible(false);
            setRegisterPaymentName('');
          }}
          name={registerPaymentName}
          nameType="username"
          priceQuil={availability?.price_quil ?? 0}
          onSuccess={() => {
            setUsernameSearch('');
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        {/* Marketplace Modal */}
        <MarketplaceModal
          visible={marketplaceModalVisible}
          onClose={() => setMarketplaceModalVisible(false)}
          onPurchaseSuccess={() => {
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        {/* Name Detail Modal */}
        <NameDetailModal
          visible={nameDetailVisible}
          onClose={() => {
            setNameDetailVisible(false);
            setSelectedNameForDetail('');
          }}
          name={selectedNameForDetail}
          nameType="username"
          nameRecord={selectedNameDetailRecord}
          isResolvable={resolvableNames.has(selectedNameForDetail)}
          isPrimary={user?.primaryUsername === selectedNameForDetail}
          onListName={(n) => {
            setNameToList(n);
            setListNameModalVisible(true);
          }}
          onRefresh={() => {
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        {/* Auctions Modal */}
        <AuctionsModal
          visible={auctionsModalVisible}
          onClose={() => setAuctionsModalVisible(false)}
          onPurchaseSuccess={() => {
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        {/* Offers Modal */}
        <OffersModal
          visible={offersModalVisible}
          onClose={() => setOffersModalVisible(false)}
          onRefresh={() => {
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        {/* List Name on Marketplace Modal */}
        <ListNameModal
          visible={listNameModalVisible}
          onClose={() => {
            setListNameModalVisible(false);
            setNameToList(null);
          }}
          name={nameToList ?? ''}
          nameType="username"
          nameRecord={nameToListRecord}
          onSuccess={() => {
            // Refresh bucket records to update listing status
            if (stealthKeyMaterial) {
              setStealthKeyMaterial({ ...stealthKeyMaterial });
            }
          }}
        />

        <SkinsModal visible={skinsOpen} onClose={() => setSkinsOpen(false)} />

        <TranslateLanguageModal visible={translateOpen} onClose={() => setTranslateOpen(false)} />

        {/* Quorum Apex subscribe / renew */}
        <ApexSubscribeModal
          visible={apexModalMode !== null}
          onClose={() => setApexModalMode(null)}
          mode={apexModalMode ?? 'subscribe'}
        />

        {/* Name Picker Modal for multiple names */}
        <BaseModal
          visible={showNamePickerModal}
          onClose={() => setShowNamePickerModal(false)}
          height={0.4}
        >
          <View style={styles.namePickerHeader}>
            <Text style={styles.namePickerTitle}>Select a Name</Text>
            <TouchableOpacity onPress={() => setShowNamePickerModal(false)}>
              <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          </View>
          <Text style={styles.namePickerSubtitle}>Choose which name to list on the marketplace</Text>
          <ScrollView style={styles.namePickerList}>
            {existingNames?.map((name) => (
              <TouchableOpacity
                key={name}
                style={styles.namePickerItem}
                onPress={() => {
                  setShowNamePickerModal(false);
                  setNameToList(name);
                  setListNameModalVisible(true);
                }}
              >
                <IconSymbol name="at" size={18} color={theme.colors.primary} />
                <Text style={styles.namePickerItemText}>{name}</Text>
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              </TouchableOpacity>
            ))}
          </ScrollView>
        </BaseModal>

        {/* Reset App Data — type-to-confirm (T3, type "reset") */}
        <TypeToConfirmModal
          visible={showResetConfirm}
          title="Reset App Data"
          body="This permanently deletes all your data, including your private keys. Back up your recovery phrase first — this cannot be undone."
          keyword="reset"
          confirmLabel="Reset App Data"
          onConfirm={handleResetAppData}
          onCancel={() => setShowResetConfirm(false)}
        />
        {/* Destructive confirms (Remove Device, Reset DM Sessions, Disconnect
            Farcaster). The dialog must live in BOTH the route-mode and modal-mode
            returns — route mode is how Settings opens this screen. */}
        {confirmDialog}
      </>
    );
  }

  // In modal mode, wrap with BaseModal
  return (
    <>
      <BaseModal
        visible={visible}
        onClose={onClose}
        height={0.9}
        avoidKeyboard
      >
        {profileContent}
      </BaseModal>

      {/* QNS Website Browser Modal */}
      {/* Registration Payment Modal */}
      <RegisterPaymentModal
        visible={registerPaymentVisible}
        onClose={() => {
          setRegisterPaymentVisible(false);
          setRegisterPaymentName('');
        }}
        name={registerPaymentName}
        nameType="username"
        priceQuil={availability?.price_quil ?? 0}
        onSuccess={() => {
          setUsernameSearch('');
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      {/* Marketplace Modal */}
      <MarketplaceModal
        visible={marketplaceModalVisible}
        onClose={() => setMarketplaceModalVisible(false)}
        onPurchaseSuccess={() => {
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      {/* Name Detail Modal */}
      <NameDetailModal
        visible={nameDetailVisible}
        onClose={() => {
          setNameDetailVisible(false);
          setSelectedNameForDetail('');
        }}
        name={selectedNameForDetail}
        nameType="username"
        nameRecord={selectedNameDetailRecord}
        isResolvable={resolvableNames.has(selectedNameForDetail)}
        isPrimary={user?.primaryUsername === selectedNameForDetail}
        onListName={(n) => {
          setNameToList(n);
          setListNameModalVisible(true);
        }}
        onRefresh={() => {
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      {/* Auctions Modal */}
      <AuctionsModal
        visible={auctionsModalVisible}
        onClose={() => setAuctionsModalVisible(false)}
        onPurchaseSuccess={() => {
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      {/* Offers Modal */}
      <OffersModal
        visible={offersModalVisible}
        onClose={() => setOffersModalVisible(false)}
        onRefresh={() => {
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      {/* List Name on Marketplace Modal */}
      <ListNameModal
        visible={listNameModalVisible}
        onClose={() => {
          setListNameModalVisible(false);
          setNameToList(null);
        }}
        name={nameToList ?? ''}
        nameType="username"
        nameRecord={nameToListRecord}
        onSuccess={() => {
          // Refresh bucket records to update listing status
          if (stealthKeyMaterial) {
            setStealthKeyMaterial({ ...stealthKeyMaterial });
          }
        }}
      />

      <SkinsModal visible={skinsOpen} onClose={() => setSkinsOpen(false)} />

      <TranslateLanguageModal visible={translateOpen} onClose={() => setTranslateOpen(false)} />

      {/* Quorum Apex subscribe / renew */}
      <ApexSubscribeModal
        visible={apexModalMode !== null}
        onClose={() => setApexModalMode(null)}
        mode={apexModalMode ?? 'subscribe'}
      />

      {/* Name Picker Modal for multiple names */}
      <BaseModal
        visible={showNamePickerModal}
        onClose={() => setShowNamePickerModal(false)}
        height={0.4}
      >
        <View style={styles.namePickerHeader}>
          <Text style={styles.namePickerTitle}>Select a Name</Text>
          <TouchableOpacity onPress={() => setShowNamePickerModal(false)}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <Text style={styles.namePickerSubtitle}>Choose which name to list on the marketplace</Text>
        <ScrollView style={styles.namePickerList}>
          {existingNames?.map((name) => (
            <TouchableOpacity
              key={name}
              style={styles.namePickerItem}
              onPress={() => {
                setShowNamePickerModal(false);
                setNameToList(name);
                setListNameModalVisible(true);
              }}
            >
              <IconSymbol name="at" size={18} color={theme.colors.primary} />
              <Text style={styles.namePickerItemText}>{name}</Text>
              <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          ))}
        </ScrollView>
      </BaseModal>

      {/* Reset App Data — type-to-confirm (T3, type "reset") */}
      <TypeToConfirmModal
        visible={showResetConfirm}
        title="Reset App Data"
        body="This permanently deletes all your data, including your private keys. Back up your recovery phrase first — this cannot be undone."
        keyword="reset"
        confirmLabel="Reset App Data"
        onConfirm={handleResetAppData}
        onCancel={() => setShowResetConfirm(false)}
      />
      {confirmDialog}
    </>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    routeContainer: {
      flex: 1,
      paddingBottom: Skin.space(90), // Clear the blur tab bar
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    editButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    editButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    editActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    cancelButton: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(12),
    },
    cancelButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    saveButton: {
      backgroundColor: theme.colors.primary,
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(16),
      minWidth: 60,
      alignItems: 'center',
    },
    saveButtonText: {
      fontSize: Skin.font(14),
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    tabs: {
      flexDirection: 'row',
      marginHorizontal: Skin.space(20),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    tab: {
      flex: 1,
      paddingVertical: Skin.space(12),
      alignItems: 'center',
      borderBottomWidth: Skin.border(2),
      borderBottomColor: 'transparent',
    },
    tabActive: {
      borderBottomColor: theme.colors.primary,
    },
    tabText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    tabTextActive: {
      color: theme.colors.primary,
    },
    scrollContent: {
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(20),
    },
    profileHeader: {
      flexDirection: 'row',
      marginBottom: Skin.space(24),
    },
    avatarContainer: {
      position: 'relative',
      marginRight: Skin.space(16),
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: Skin.radius(40),
    },
    avatarPlaceholder: {
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    editAvatarButton: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      width: 28,
      height: 28,
      borderRadius: Skin.radius(14),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    profileInfo: {
      flex: 1,
      justifyContent: 'center',
    },
    displayName: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
    },
    displayNameInput: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.primary,
      paddingVertical: Skin.space(4),
    },
    username: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      marginRight: Skin.space(6),
    },
    usernameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(2),
    },
    userId: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
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
    bioInput: {
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(12),
      borderRadius: Skin.radius(8),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      lineHeight: Skin.font(20),
      minHeight: 100,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.primary,
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(12),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    infoLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    infoValue: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      maxWidth: '50%',
    },
    infoValueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      flexShrink: 1,
    },
    premiumBanner: {
      padding: Skin.space(24),
      borderRadius: Skin.radius(16),
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    premiumTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: isDark ? theme.colors.textMain : '#ffffff',
      marginTop: Skin.space(12),
      marginBottom: Skin.space(8),
    },
    premiumSubtitle: {
      fontSize: Skin.font(14),
      color: isDark ? theme.colors.textSubtle : '#ffffffcc',
      textAlign: 'center',
    },
    // Quorum Apex card (premium tab)
    apexCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(16),
      borderWidth: Skin.border(1),
      borderColor: APEX_GOLD + '66',
      padding: Skin.space(16),
      marginBottom: Skin.space(24),
    },
    apexHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    apexTitle: {
      flex: 1,
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    apexDaysLeft: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: APEX_GOLD,
    },
    apexExpired: {
      fontSize: Skin.font(13),
      color: theme.colors.danger,
    },
    apexPitch: {
      fontSize: Skin.font(14),
      lineHeight: Skin.font(20),
      color: theme.colors.textMuted,
      marginTop: Skin.space(8),
    },
    apexMetaText: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginTop: Skin.space(6),
    },
    apexSpacesLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: Skin.space(14),
      marginBottom: Skin.space(6),
    },
    apexSpaceRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      paddingVertical: Skin.space(3),
    },
    apexSpaceName: {
      flex: 1,
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
    },
    apexLockNote: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontStyle: 'italic',
      marginTop: Skin.space(8),
    },
    apexButton: {
      backgroundColor: APEX_GOLD,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(12),
      alignItems: 'center',
      marginTop: Skin.space(14),
    },
    apexButtonText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#1A1505',
    },
    countdownContainer: {
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(24),
      borderRadius: Skin.radius(16),
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    countdownTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    countdownSubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginBottom: Skin.space(20),
    },
    countdownTimer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(16),
    },
    countdownUnit: {
      alignItems: 'center',
      minWidth: 50,
    },
    countdownValue: {
      fontSize: Skin.font(32),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    countdownLabel: {
      fontSize: Skin.font(11),
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      marginTop: Skin.space(4),
    },
    countdownSeparator: {
      fontSize: Skin.font(28),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMuted,
      marginHorizontal: Skin.space(4),
      marginBottom: Skin.space(16),
    },
    countdownDate: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    searchSection: {
      marginBottom: Skin.space(24),
    },
    searchContainer: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      overflow: 'hidden',
    },
    searchInput: {
      flex: 1,
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(12),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    searchButton: {
      paddingHorizontal: Skin.space(16),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
    },
    usernameItem: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(8),
    },
    usernameItemTaken: {
      opacity: 0.5,
    },
    usernameLeft: {
      flex: 1,
    },
    usernameText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(4),
    },
    usernameTextTaken: {
      textDecorationLine: 'line-through',
    },
    availabilityText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    resolvedAddressText: {
      fontSize: Skin.font(11),
      color: theme.colors.primary,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    resolveButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(6),
    },
    resolveButtonText: {
      color: '#fff',
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    resolvedBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
      backgroundColor: theme.colors.success + '20',
      borderRadius: Skin.radius(6),
    },
    resolvedText: {
      color: theme.colors.success,
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    primaryBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingHorizontal: Skin.space(8),
      paddingVertical: Skin.space(4),
      backgroundColor: theme.colors.primary + '20',
      borderRadius: Skin.radius(6),
    },
    primaryText: {
      color: theme.colors.primary,
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    setPrimaryButton: {
      backgroundColor: theme.colors.surface3,
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(6),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.primary,
    },
    setPrimaryButtonText: {
      color: theme.colors.primary,
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    usernameRight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    priceText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    buyButton: {
      backgroundColor: theme.colors.primary,
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(16),
    },
    buyButtonText: {
      fontSize: Skin.font(12),
      color: '#ffffff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    benefitsSection: {
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(12),
      marginBottom: Skin.space(24),
    },
    benefitItem: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: Skin.space(12),
    },
    benefitText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      marginLeft: Skin.space(12),
      flex: 1,
    },
    settingRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(12),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    settingLeft: {
      flex: 1,
      marginRight: Skin.space(16),
    },
    settingLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      marginBottom: Skin.space(4),
    },
    settingDescription: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(8),
    },
    actionButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      flex: 1,
      marginLeft: Skin.space(12),
    },
    dangerButton: {
      backgroundColor: theme.colors.danger + '20',
    },
    dangerText: {
      color: theme.colors.danger,
    },
    recoveryPhraseContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    recoveryPhraseWarning: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.warning + '20',
      padding: Skin.space(12),
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(16),
      gap: Skin.space(8),
    },
    recoveryPhraseWarningText: {
      fontSize: Skin.font(13),
      color: theme.colors.warning,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      flex: 1,
    },
    recoveryPhraseGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    recoveryPhraseWord: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(8),
      minWidth: '30%',
    },
    recoveryPhraseIndex: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginRight: Skin.space(6),
      minWidth: 20,
    },
    recoveryPhraseText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    hexKeyContainer: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
    },
    hexKeyLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    hexKeyText: {
      fontSize: Skin.font(12),
      color: theme.colors.textMain,
      fontFamily: 'monospace',
      lineHeight: Skin.font(18),
    },
    recoveryPhraseActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: Skin.space(16),
      gap: Skin.space(12),
    },
    copyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.primary + '20',
      gap: Skin.space(6),
    },
    copyButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    hideButton: {
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    hideButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    // Farcaster styles
    farcasterConnected: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(8),
    },
    farcasterInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    farcasterDetails: {
      gap: Skin.space(2),
    },
    farcasterUsername: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    farcasterFid: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
    },
    farcasterDisconnectButton: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.danger + '20',
    },
    farcasterDisconnectText: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    farcasterImportContainer: {
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(8),
    },
    farcasterImportDescription: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(12),
      lineHeight: Skin.font(18),
    },
    farcasterMnemonicInput: {
      backgroundColor: theme.colors.surface3,
      padding: Skin.space(12),
      borderRadius: Skin.radius(8),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      minHeight: 80,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.border,
    },
    farcasterErrorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginTop: Skin.space(8),
    },
    farcasterErrorText: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
    },
    farcasterImportActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: Skin.space(12),
      marginTop: Skin.space(12),
    },
    farcasterCancelButton: {
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(16),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface3,
    },
    farcasterCancelText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    farcasterImportButton: {
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(20),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.primary,
      minWidth: 80,
      alignItems: 'center',
    },
    farcasterImportButtonDisabled: {
      opacity: 0.6,
    },
    farcasterImportButtonText: {
      fontSize: Skin.font(14),
      color: '#fff',
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    // Device management styles
    deviceLoadingContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(20),
      gap: Skin.space(8),
    },
    deviceLoadingText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    deviceListContainer: {
      marginTop: Skin.space(12),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      overflow: 'hidden',
    },
    deviceItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: Skin.space(12),
      paddingHorizontal: Skin.space(16),
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.border,
    },
    deviceInfo: {
      flex: 1,
      marginRight: Skin.space(12),
    },
    deviceHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginBottom: Skin.space(4),
    },
    deviceLabel: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    deviceLabelCurrent: {
      color: theme.colors.primary,
    },
    deviceAddress: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.regular.fontFamily,
    },
    deviceRemoveButton: {
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(12),
      borderRadius: Skin.radius(6),
      backgroundColor: theme.colors.danger + '20',
      minWidth: 70,
      alignItems: 'center',
    },
    deviceRemoveText: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    deviceEmptyText: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      paddingVertical: Skin.space(20),
    },
    actionButtonContent: {
      flex: 1,
      marginLeft: Skin.space(12),
    },
    actionButtonSubtext: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    marketplaceButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary + '15',
      padding: Skin.space(14),
      borderRadius: Skin.radius(8),
      marginTop: Skin.space(8),
      gap: Skin.space(8),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.primary + '30',
    },
    marketplaceButtonText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    // Name Picker Modal styles
    namePickerHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(8),
    },
    namePickerTitle: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    namePickerSubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      paddingHorizontal: Skin.space(20),
      marginBottom: Skin.space(16),
    },
    namePickerList: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    namePickerItem: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(10),
      gap: Skin.space(12),
    },
    namePickerItemText: {
      flex: 1,
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
  });

// ---------------------------------------------------------------------------
// Memoized sections
//
// ProfileModal carries a lot of state (~60 hooks); any state change re-renders
// the entire tree. The self-contained sections below are extracted into
// React.memo components so they only re-render when the props they actually
// read change. `styles` is memoized above, and all callbacks passed in are
// stable (useCallback), so memo bail-outs actually take effect.
// ---------------------------------------------------------------------------

type ProfileStyles = ReturnType<typeof createStyles>;
type ProfileUser = ReturnType<typeof useAuth>['user'];

/**
 * Quorum Apex card — sits at the top of the premium tab. Three states:
 * never subscribed (pitch + Subscribe), active (membership details +
 * locked spaces + Renew), expired (expiry date + Renew).
 */
const ApexSectionCard = React.memo(function ApexSectionCard({
  styles,
  apexState,
  onOpenApexModal,
}: {
  styles: ProfileStyles;
  apexState: ApexSubscriptionState;
  onOpenApexModal: (mode: 'subscribe' | 'renew') => void;
}) {
  const { subscription, isActive, daysLeft } = apexState;

  // Resolve the chosen spaces' names from locally-joined spaces; spaces
  // the user hasn't joined fall back to a truncated address. Slots are
  // aggregated per space — a subscriber may assign multiple slots (even
  // all four) to one space, so render "Name ×N" instead of repeated rows.
  const spaceEntries = React.useMemo(() => {
    if (!subscription) return [];
    const local = new Map(getAllSpaces().map((s) => [s.spaceId, s.spaceName]));
    const counts = new Map<string, number>();
    for (const address of subscription.space_addresses) {
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([address, count]) => ({
      address,
      count,
      name: local.get(address) || truncateAddress(address),
    }));
  }, [subscription]);

  // Never subscribed — gold pitch card
  if (!subscription) {
    return (
      <View style={styles.apexCard}>
        <View style={styles.apexHeaderRow}>
          <IconSymbol name="crown.fill" size={20} color={APEX_GOLD} />
          <Text style={styles.apexTitle}>Quorum Apex</Text>
        </View>
        <Text style={styles.apexPitch}>
          Support 4 communities of your choice and get a gold ring on your profile — $25/month
        </Text>
        <TouchableOpacity style={styles.apexButton} onPress={() => onOpenApexModal('subscribe')}>
          <Text style={styles.apexButtonText}>Subscribe</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Subscribed (active) or expired
  return (
    <View style={styles.apexCard}>
      <View style={styles.apexHeaderRow}>
        <IconSymbol name="crown.fill" size={20} color={APEX_GOLD} />
        <Text style={styles.apexTitle}>Quorum Apex</Text>
        {isActive ? (
          <Text style={styles.apexDaysLeft}>{daysLeft} days left</Text>
        ) : (
          <Text style={styles.apexExpired}>
            Expired {new Date(subscription.period_end).toLocaleDateString()}
          </Text>
        )}
      </View>

      <Text style={styles.apexMetaText}>
        Member since {new Date(subscription.subscribed_since).toLocaleDateString()} • paying in{' '}
        {subscription.token}
      </Text>

      <Text style={styles.apexSpacesLabel}>Supported spaces</Text>
      {spaceEntries.map((entry) => (
        <View key={entry.address} style={styles.apexSpaceRow}>
          <IconSymbol name="checkmark.circle.fill" size={14} color={APEX_GOLD} />
          <Text style={styles.apexSpaceName} numberOfLines={1}>
            {entry.name}
            {entry.count > 1 ? ` ×${entry.count}` : ''}
          </Text>
        </View>
      ))}
      {isActive && (
        <Text style={styles.apexLockNote}>
          Supported spaces are locked until your next renewal.
        </Text>
      )}

      <TouchableOpacity style={styles.apexButton} onPress={() => onOpenApexModal('renew')}>
        <Text style={styles.apexButtonText}>Renew</Text>
      </TouchableOpacity>
    </View>
  );
});

const ProfileTabSection = React.memo(function ProfileTabSection({
  styles,
  theme,
  hideHeader,
  user,
  isEditing,
  editDisplayName,
  editBio,
  onChangeDisplayName,
  onChangeBio,
  onPickImage,
  onCopyAddress,
  isApexActive,
}: {
  styles: ProfileStyles;
  theme: AppTheme;
  hideHeader: boolean;
  user: ProfileUser;
  isEditing: boolean;
  editDisplayName: string;
  editBio: string;
  onChangeDisplayName: (text: string) => void;
  onChangeBio: (text: string) => void;
  onPickImage: () => void;
  onCopyAddress: () => void;
  /** Gold Apex ring around the user's own avatar. */
  isApexActive: boolean;
}) {
  return (
    <>
      {/* Profile Header — hidden when parent supplies its own */}
      {!hideHeader && (
        <View style={styles.profileHeader}>
          <TouchableOpacity style={styles.avatarContainer} onPress={onPickImage}>
            <ApexAvatarRing active={isApexActive} size={80}>
              {user?.profileImage ? (
                <Image source={{ uri: user.profileImage }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarPlaceholder]}>
                  <IconSymbol name="person.fill" size={40} color={theme.colors.textMuted} />
                </View>
              )}
            </ApexAvatarRing>
            <View style={styles.editAvatarButton}>
              <IconSymbol name="camera.fill" size={16} color={theme.colors.textMain} />
            </View>
          </TouchableOpacity>
          <View style={styles.profileInfo}>
            {isEditing ? (
              <TextInput
                style={styles.displayNameInput}
                value={editDisplayName}
                onChangeText={onChangeDisplayName}
                placeholder="Display Name"
                placeholderTextColor={theme.colors.textMuted}
                autoCapitalize="words"
              />
            ) : (
              <Text style={styles.displayName}>
                {user?.displayName || 'Anonymous'}
              </Text>
            )}
            {user?.username && (
              <View style={styles.usernameRow}>
                <Text style={styles.username}>@{user.username}</Text>
              </View>
            )}
            <Text style={styles.userId}>
              {user?.address ? truncateAddress(user.address) : ''}
            </Text>
          </View>
        </View>
      )}

      {/* Bio Section */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Bio</Text>
        {isEditing ? (
          <TextInput
            style={styles.bioInput}
            value={editBio}
            onChangeText={onChangeBio}
            placeholder="Tell us about yourself..."
            placeholderTextColor={theme.colors.textMuted}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        ) : (
          <View style={styles.bioContainer}>
            <Text style={styles.bioText}>
              {user?.bio || 'No bio yet. Tap Edit to add one.'}
            </Text>
          </View>
        )}
      </View>

      {/* Account Info */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account Info</Text>
        <TouchableOpacity style={styles.infoRow} onPress={onCopyAddress}>
          <Text style={styles.infoLabel}>Address</Text>
          <View style={styles.infoValueRow}>
            <Text style={[styles.infoValue, { maxWidth: undefined }]} numberOfLines={1}>
              {user?.address ? truncateAddress(user.address) : 'N/A'}
            </Text>
            <IconSymbol name="doc.on.doc" size={14} color={theme.colors.textMuted} />
          </View>
        </TouchableOpacity>
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>Privacy Level</Text>
          <Text style={styles.infoValue}>
            {user?.privacyLevel ? user.privacyLevel.charAt(0).toUpperCase() + user.privacyLevel.slice(1) : 'Standard'}
          </Text>
        </View>
        {user?.farcaster && (
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Farcaster</Text>
            <Text style={styles.infoValue}>@{user.farcaster.username}</Text>
          </View>
        )}
      </View>
    </>
  );
});

const PrivacyFeedSettingsSection = React.memo(function PrivacyFeedSettingsSection({
  styles,
  theme,
  isProfilePublic,
  onTogglePublicProfile,
  allowSync,
  onToggleSync,
  syncDisabled,
  notifications,
  onToggleNotifications,
  showRepliesInFeed,
  onToggleShowReplies,
  showNonFollowReplies,
  onToggleShowNonFollowReplies,
}: {
  styles: ProfileStyles;
  theme: AppTheme;
  isProfilePublic: boolean;
  onTogglePublicProfile: (enabled: boolean) => void;
  allowSync: boolean;
  onToggleSync: (enabled: boolean) => void;
  syncDisabled: boolean;
  notifications: boolean;
  onToggleNotifications: (enabled: boolean) => void;
  showRepliesInFeed: boolean;
  onToggleShowReplies: (enabled: boolean) => void;
  showNonFollowReplies: boolean;
  onToggleShowNonFollowReplies: (enabled: boolean) => void;
}) {
  return (
    <>
      {/* Privacy & Sync Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Privacy & Sync</Text>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Public Profile</Text>
            <Text style={styles.settingDescription}>
              Let anyone see your display name, picture, bio, and QNS username — even outside shared spaces. Off by default.
            </Text>
          </View>
          <Switch
            value={isProfilePublic}
            onValueChange={onTogglePublicProfile}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={isProfilePublic ? '#ffffff' : '#f4f3f4'}
          />
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Enable Sync</Text>
            <Text style={styles.settingDescription}>
              Sync your profile, spaces, and keys between devices. Increases metadata visibility.
            </Text>
          </View>
          <Switch
            value={allowSync}
            onValueChange={onToggleSync}
            disabled={syncDisabled}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={allowSync ? '#ffffff' : '#f4f3f4'}
          />
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Show Online Status</Text>
            <Text style={styles.settingDescription}>Let others see when you're active</Text>
          </View>
          <Switch
            value={true}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={'#ffffff'}
          />
        </View>
      </View>

      {/* Notification Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Notifications</Text>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Push Notifications</Text>
            <Text style={styles.settingDescription}>Receive notifications on your device</Text>
          </View>
          <Switch
            value={notifications}
            onValueChange={onToggleNotifications}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={notifications ? '#ffffff' : '#f4f3f4'}
          />
        </View>
      </View>

      {/* Feed Settings */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Feed</Text>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Show replies in main feed</Text>
            <Text style={styles.settingDescription}>
              Include reply casts in your main feed (thread views always show replies)
            </Text>
          </View>
          <Switch
            value={showRepliesInFeed}
            onValueChange={onToggleShowReplies}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={showRepliesInFeed ? '#ffffff' : '#f4f3f4'}
          />
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingLeft}>
            <Text style={styles.settingLabel}>Show replies from non-followed in main feed</Text>
            <Text style={styles.settingDescription}>
              Include replies from people you don't follow in your main feed
            </Text>
          </View>
          <Switch
            value={showNonFollowReplies}
            onValueChange={onToggleShowNonFollowReplies}
            disabled={!showRepliesInFeed}
            trackColor={{ false: theme.colors.surface4, true: theme.colors.accent }}
            thumbColor={showNonFollowReplies ? '#ffffff' : '#f4f3f4'}
          />
        </View>
      </View>
    </>
  );
});

const AccountRecoverySection = React.memo(function AccountRecoverySection({
  styles,
  theme,
  showRecoveryPhrase,
  recoveryPhrase,
  hexPrivateKey,
  onExport,
  onCopy,
  onHide,
}: {
  styles: ProfileStyles;
  theme: AppTheme;
  showRecoveryPhrase: boolean;
  recoveryPhrase: string[] | null;
  hexPrivateKey: string | null;
  onExport: () => void;
  onCopy: () => void;
  onHide: () => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Account</Text>
      {!showRecoveryPhrase ? (
        <TouchableOpacity style={styles.actionButton} onPress={onExport}>
          <IconSymbol name="key.fill" size={20} color={theme.colors.textMain} />
          <Text style={styles.actionButtonText}>Export Recovery Key</Text>
          <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
        </TouchableOpacity>
      ) : (
        <View style={styles.recoveryPhraseContainer}>
          <View style={styles.recoveryPhraseWarning}>
            <IconSymbol name="exclamationmark.triangle.fill" size={20} color={theme.colors.warning} />
            <Text style={styles.recoveryPhraseWarningText}>
              Never share this {recoveryPhrase ? 'phrase' : 'key'} with anyone!
            </Text>
          </View>
          {recoveryPhrase ? (
            // Display mnemonic as word grid
            <View style={styles.recoveryPhraseGrid}>
              {recoveryPhrase.map((word, index) => (
                <View key={index} style={styles.recoveryPhraseWord}>
                  <Text style={styles.recoveryPhraseIndex}>{index + 1}.</Text>
                  <Text style={styles.recoveryPhraseText}>{word}</Text>
                </View>
              ))}
            </View>
          ) : hexPrivateKey ? (
            // Display hex private key
            <View style={styles.hexKeyContainer}>
              <Text style={styles.hexKeyLabel}>Private Key (Hex)</Text>
              <Text style={styles.hexKeyText} selectable>
                {hexPrivateKey}
              </Text>
            </View>
          ) : null}
          <View style={styles.recoveryPhraseActions}>
            <TouchableOpacity style={styles.copyButton} onPress={onCopy}>
              <IconSymbol name="doc.on.doc" size={16} color={theme.colors.primary} />
              <Text style={styles.copyButtonText}>Copy</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.hideButton} onPress={onHide}>
              <Text style={styles.hideButtonText}>Hide</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
});

const DeviceKeysSection = React.memo(function DeviceKeysSection({
  styles,
  theme,
  isLoadingDevices,
  deviceRegistrations,
  currentDeviceInboxAddress,
  isRemovingDevice,
  onRemoveDevice,
  onResetAllSessions,
}: {
  styles: ProfileStyles;
  theme: AppTheme;
  isLoadingDevices: boolean;
  deviceRegistrations: DeviceRegistration[];
  currentDeviceInboxAddress: string | null;
  isRemovingDevice: boolean;
  onRemoveDevice: (identityPublicKey: string) => void;
  onResetAllSessions: () => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Device Keys</Text>
      <Text style={styles.settingDescription}>
        Manage devices registered to your account for encrypted messaging.
      </Text>

      {isLoadingDevices ? (
        <View style={styles.deviceLoadingContainer}>
          <ActivityIndicator size="small" color={theme.colors.primary} />
          <Text style={styles.deviceLoadingText}>Loading devices...</Text>
        </View>
      ) : deviceRegistrations.length > 0 ? (
        <View style={styles.deviceListContainer}>
          {deviceRegistrations.map((device) => {
            const isCurrentDevice = device.inbox_registration.inbox_address === currentDeviceInboxAddress;
            const inboxAddr = device.inbox_registration.inbox_address;
            const displayAddr = inboxAddr.length > 16
              ? `${inboxAddr.slice(0, 8)}...${inboxAddr.slice(-6)}`
              : inboxAddr;

            return (
              <View key={device.identity_public_key} style={styles.deviceItem}>
                <View style={styles.deviceInfo}>
                  <View style={styles.deviceHeader}>
                    <IconSymbol
                      name={isCurrentDevice ? 'iphone' : 'desktopcomputer'}
                      size={16}
                      color={isCurrentDevice ? theme.colors.primary : theme.colors.textMuted}
                    />
                    <Text style={[styles.deviceLabel, isCurrentDevice && styles.deviceLabelCurrent]}>
                      {isCurrentDevice ? 'This device' : 'Other device'}
                    </Text>
                  </View>
                  <Text style={styles.deviceAddress} numberOfLines={1}>
                    {displayAddr}
                  </Text>
                </View>
                {!isCurrentDevice && (
                  <TouchableOpacity
                    style={styles.deviceRemoveButton}
                    onPress={() => onRemoveDevice(device.identity_public_key)}
                    disabled={isRemovingDevice}
                  >
                    {isRemovingDevice ? (
                      <ActivityIndicator size="small" color={theme.colors.danger} />
                    ) : (
                      <Text style={styles.deviceRemoveText}>Remove</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={styles.deviceEmptyText}>No devices registered</Text>
      )}

      {/* Reset All Sessions */}
      <TouchableOpacity
        style={[styles.actionButton, { marginTop: Skin.space(16) }]}
        onPress={onResetAllSessions}
      >
        <IconSymbol name="arrow.triangle.2.circlepath" size={20} color={theme.colors.warning} />
        <View style={styles.actionButtonContent}>
          <Text style={styles.actionButtonText}>Reset All DM Sessions</Text>
          <Text style={styles.actionButtonSubtext}>Fix persistent encryption errors</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
});
