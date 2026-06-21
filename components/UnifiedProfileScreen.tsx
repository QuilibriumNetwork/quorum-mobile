import ProfileModal, { type ProfileSection } from '@/components/ProfileModal';
import ProfileSplitModeModal from '@/components/ProfileSplitModeModal';
import AuctionsModal from '@/components/qns/AuctionsModal';
import BuyNameModal from '@/components/qns/BuyNameModal';
import MarketplaceModal from '@/components/qns/MarketplaceModal';
import OffersModal from '@/components/qns/OffersModal';
import type { ResaleListing } from '@/services/api/qnsClient';
import UnifiedProfileHeader, { type IdentityTab } from '@/components/UnifiedProfileHeader';
import UnifiedProfileEditModal from '@/components/UnifiedProfileEditModal';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { useFarcasterProfile } from '@/hooks/useFarcasterProfile';
import { updateFarcasterProfile } from '@/services/farcaster/updateProfile';
import { compressAvatarImage } from '@/services/media/imageAttachment';
import { capDisplayName, capBio } from '@/hooks/validation/errorTranslator';
import {
  hasDecidedSplitMode,
  useProfileSplitMode,
} from '@/services/profile/profilePrefs';
import { useTheme, type AppTheme } from '@/theme';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface UnifiedProfileScreenProps {
  onOpenWarpcastImport?: () => void;
}

type EditTarget = 'quorum' | 'farcaster' | 'both' | null;

export default function UnifiedProfileScreen({
  onOpenWarpcastImport,
}: UnifiedProfileScreenProps) {
  const { theme } = useTheme();
  const { user, farcasterAuthToken, updateProfile } = useAuth();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [splitMode, setSplitMode] = useProfileSplitMode();
  const [decisionModalVisible, setDecisionModalVisible] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [editPickerVisible, setEditPickerVisible] = useState(false);
  // Marketplace-family modals are rendered at this level (not inside ProfileModal)
  // so dismissing them doesn't leave the embedded ProfileModal unable to receive
  // touches.
  const [marketplaceModalVisible, setMarketplaceModalVisible] = useState(false);
  const [auctionsModalVisible, setAuctionsModalVisible] = useState(false);
  const [offersModalVisible, setOffersModalVisible] = useState(false);
  const [buyListing, setBuyListing] = useState<ResaleListing | null>(null);

  const hasFarcaster = Boolean(user?.farcaster?.fid);

  // First-time decision prompt: if user has Farcaster but hasn't chosen a mode, ask.
  useEffect(() => {
    if (hasFarcaster && !hasDecidedSplitMode()) {
      setDecisionModalVisible(true);
    }
  }, [hasFarcaster]);

  const { author: farcasterAuthor } = useFarcasterProfile({
    fid: user?.farcaster?.fid ?? 0,
    token: farcasterAuthToken ?? undefined,
    enabled: hasFarcaster,
  });

  // One flat pill row replaces the old two-level nav. Profile / Premium /
  // Settings always show; Farcaster + Casts only when a Farcaster account is
  // connected (config / feed that don't apply to Quorum-only users).
  const pills = useMemo<SegmentedPillItem[]>(() => {
    const list: SegmentedPillItem[] = [
      { key: 'profile', label: 'Profile' },
      { key: 'premium', label: 'Premium' },
      { key: 'settings', label: 'Settings' },
    ];
    // The Farcaster pill (account, feed prefs, Hypersnap, Warpcast, "My Casts")
    // only applies when a Farcaster account is connected.
    if (hasFarcaster) {
      list.push({ key: 'farcaster', label: 'Farcaster' });
    }
    return list;
  }, [hasFarcaster]);

  const [activePill, setActivePill] = useState<ProfileSection>('profile');

  // Which identity the big profile card shows in the unmerged switcher layout.
  const [identityTab, setIdentityTab] = useState<IdentityTab>('quorum');

  // Disconnecting Farcaster removes the Farcaster pill + switcher. Derive safe
  // values for THIS render so there's no one-frame window where the Farcaster
  // section/identity renders without a Farcaster account (avoids a blank flash).
  const effectiveActivePill: ProfileSection =
    !hasFarcaster && activePill === 'farcaster' ? 'profile' : activePill;
  const effectiveIdentityTab: IdentityTab = !hasFarcaster ? 'quorum' : identityTab;

  // Persist the fallback so the state matches what we render (also resets the
  // identity tab so reconnecting doesn't silently land on the Farcaster card).
  useEffect(() => {
    if (!hasFarcaster && activePill === 'farcaster') setActivePill('profile');
    if (!hasFarcaster && identityTab === 'farcaster') setIdentityTab('quorum');
  }, [hasFarcaster, activePill, identityTab]);

  // Open the current user's own cast feed (their ProfileView) via the feed tab's
  // existing profileFid deep-link. Surfaced from the Farcaster section's
  // "My Casts" row instead of a dedicated pill.
  const handleViewMyCasts = useCallback(() => {
    const fid = user?.farcaster?.fid;
    if (!fid) return;
    router.push({
      pathname: '/(tabs)/feed',
      params: {
        profileFid: String(fid),
        profileUsername: user?.farcaster?.username ?? '',
        // Unique per tap so the feed tab (already mounted) re-navigates to the
        // profile even when the same fid is pushed again. Without it,
        // useLocalSearchParams returns identical params and nothing re-fires.
        profileNonce: String(Date.now()),
      },
    });
  }, [router, user?.farcaster?.fid, user?.farcaster?.username]);

  // Copy the Quorum address (tappable address line on the Quorum big card).
  const handleCopyAddress = useCallback(() => {
    if (!user?.address) return;
    void Clipboard.setStringAsync(user.address);
    showToast({ type: 'success', title: 'Address copied' });
  }, [user?.address, showToast]);

  // Merge: reconcile name/bio/pfp across both identities, then enter merged mode.
  // Per-field rule: whichever side has content wins; Quorum wins ties; if Quorum
  // is empty for a field, pull Farcaster's value into it. After this both systems
  // hold the same value per field, so the merged (Quorum-preferred) display is
  // accurate on both sides. ProfileModal confirms before calling this.
  const handleMergeProfiles = useCallback(async () => {
    const fcName = farcasterAuthor?.displayName?.trim() || '';
    const fcBio = farcasterAuthor?.profile?.bio?.text?.trim() || '';
    const fcPfp = farcasterAuthor?.pfp?.url || '';
    const qName = user?.displayName?.trim() || '';
    const qBio = user?.bio?.trim() || '';
    const qPfp = user?.profileImage || '';

    // --- Pull Farcaster -> Quorum for any field Quorum is missing ---
    const quorumUpdates: { displayName?: string; bio?: string; profileImage?: string } = {};
    if (!qName && fcName) quorumUpdates.displayName = fcName;
    if (!qBio && fcBio) quorumUpdates.bio = fcBio;
    if (!qPfp && fcPfp) {
      // Convert the remote FC pfp to a data URI (like the picker) so it displays
      // AND broadcasts to peers, not just a bare stored URL.
      try {
        const compressed = await compressAvatarImage(fcPfp, 512, 512);
        if (compressed?.dataUri) quorumUpdates.profileImage = compressed.dataUri;
      } catch {
        // If the image can't be fetched/compressed, skip the pfp pull; the rest
        // of the merge still proceeds.
      }
    }
    if (Object.keys(quorumUpdates).length > 0) {
      updateProfile(quorumUpdates);
    }

    // --- Push Quorum -> Farcaster for fields Quorum has (Quorum wins) ---
    if (farcasterAuthToken) {
      const fcFields: { displayName?: string; bio?: string; pfp?: string } = {};
      // Only push a field to Farcaster when it would actually change it (Quorum
      // had content that differs), capped to Farcaster's byte limits.
      if (qName && capDisplayName(qName) !== fcName) fcFields.displayName = capDisplayName(qName);
      if (qBio && capBio(qBio) !== fcBio) fcFields.bio = capBio(qBio);
      // Push the Quorum pfp (data URI) to Farcaster only when Quorum had its own.
      if (qPfp) fcFields.pfp = qPfp;

      if (Object.keys(fcFields).length > 0) {
        try {
          const res = await updateFarcasterProfile(farcasterAuthToken, fcFields);
          if (!res.ok) {
            showToast({ type: 'error', title: 'Farcaster not fully updated', message: res.error });
          }
        } catch {
          showToast({ type: 'error', title: "Couldn't update Farcaster", message: 'Your Quorum profile was merged; Farcaster will sync on your next edit.' });
        }
      }
    } else if (qName || qBio || qPfp) {
      // No Farcaster token — can't push. Merge the display anyway; warn.
      showToast({ type: 'info', title: 'Reconnect Farcaster to sync', message: 'Merged your profile view; Farcaster will update when you reconnect.' });
    }

    setSplitMode(false);
  }, [farcasterAuthor, user?.displayName, user?.bio, user?.profileImage, farcasterAuthToken, updateProfile, showToast, setSplitMode]);

  const handleEditRequest = () => {
    if (!hasFarcaster) {
      setEditTarget('quorum');
      return;
    }
    if (!splitMode) {
      setEditTarget('both');
    } else {
      setEditPickerVisible(true);
    }
  };

  const styles = useMemo(() => createStyles(theme), [theme]);

  if (!user) return null;

  return (
    // The host (profile tab) renders an opaque Stack header above us
    // that already covers the status-bar safe area, so we don't add
    // another `insets.top` here — that would double up and leave a
    // visible gap between the header and the pill row.
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <UnifiedProfileHeader
        user={user}
        farcasterProfile={farcasterAuthor}
        splitMode={splitMode}
        identityTab={effectiveIdentityTab}
        onIdentityTabChange={setIdentityTab}
        onEditQuorum={() => setEditTarget('quorum')}
        onEditFarcaster={() => setEditTarget('farcaster')}
        onEditUnified={handleEditRequest}
        onCopyAddress={handleCopyAddress}
      />

      <SegmentedPills
        items={pills}
        activeKey={effectiveActivePill}
        onChange={(key) => setActivePill(key as ProfileSection)}
        variant="solid"
        scrollable
        centerOnSelect
        style={styles.pillRow}
        // Center the row only when there are few pills (merged/Quorum-only:
        // Profile/Premium/Settings always fit). With the 5-pill split layout we
        // keep left-aligned so the row can scroll without clipping on narrow
        // screens. flexGrow makes the centered content fill the viewport.
        contentContainerStyle={[
          styles.pillRowContent,
          pills.length <= 3 && styles.pillRowContentCentered,
        ]}
      />

      <View style={styles.content}>
        <ProfileModal
          visible={true}
          onClose={() => {}}
          onOpenWarpcastImport={onOpenWarpcastImport}
          isRouteMode={true}
          hideHeader={true}
          hideTabBar={true}
          activeSection={effectiveActivePill}
          onViewMyCasts={handleViewMyCasts}
          // Merge when unmerged; unmerge when merged. ProfileModal confirms first;
          // here we just flip the split-mode display flag (no data is altered).
          onMergeProfiles={splitMode ? () => { void handleMergeProfiles(); } : undefined}
          onUnmergeProfiles={!splitMode ? () => setSplitMode(true) : undefined}
          // After connecting Farcaster, jump to the Farcaster pill.
          onFarcasterConnected={() => setActivePill('farcaster')}
          farcasterIdentity={{
            // Only drive the Profile section to Farcaster when unmerged AND the
            // header switcher is on Farcaster.
            active: splitMode && hasFarcaster && effectiveIdentityTab === 'farcaster',
            displayName: farcasterAuthor?.displayName || user.farcaster?.username,
            bio: farcasterAuthor?.profile?.bio?.text,
            username: user.farcaster?.username,
            fid: user.farcaster?.fid,
          }}
          // The header shows the identity switcher only when unmerged with both
          // profiles — that's when Bio carries a brand icon.
          dualIdentity={splitMode && hasFarcaster}
          onOpenMarketplace={() => setMarketplaceModalVisible(true)}
          onOpenAuctions={() => setAuctionsModalVisible(true)}
          onOpenOffers={() => setOffersModalVisible(true)}
        />
      </View>

      {/* Decision modal (first-time prompt) */}
      <ProfileSplitModeModal
        visible={decisionModalVisible}
        onClose={() => setDecisionModalVisible(false)}
      />

      {/* Edit target picker (split mode) */}
      <EditTargetPicker
        visible={editPickerVisible}
        onClose={() => setEditPickerVisible(false)}
        onPick={(t) => {
          setEditPickerVisible(false);
          setEditTarget(t);
        }}
        theme={theme}
        bottomInset={insets.bottom}
      />

      {/* Unified edit modal */}
      {editTarget && (
        <UnifiedProfileEditModal
          visible={true}
          scope={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}

      {/* Marketplace-family modals — hosted here (outside the pager) so dismissing
          them doesn't leave the embedded ProfileModal unable to receive touches. */}
      {marketplaceModalVisible && (
        <MarketplaceModal
          visible={true}
          onClose={() => setMarketplaceModalVisible(false)}
          onPickListing={(listing) => {
            // Close the marketplace first so we don't stack two modals (RN
            // doesn't present nested <Modal>s reliably on iOS), then open the
            // buy modal.
            setMarketplaceModalVisible(false);
            setBuyListing(listing);
          }}
        />
      )}
      <BuyNameModal
        visible={buyListing !== null}
        listing={buyListing}
        onClose={() => setBuyListing(null)}
        onSuccess={() => setBuyListing(null)}
      />
      {auctionsModalVisible && (
        <AuctionsModal
          visible={true}
          onClose={() => setAuctionsModalVisible(false)}
        />
      )}
      {offersModalVisible && (
        <OffersModal
          visible={true}
          onClose={() => setOffersModalVisible(false)}
        />
      )}
    </View>
  );
}

function EditTargetPicker({
  visible,
  onClose,
  onPick,
  theme,
  bottomInset,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (target: 'quorum' | 'farcaster' | 'both') => void;
  theme: AppTheme;
  bottomInset: number;
}) {
  if (!visible) return null;
  return (
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <TouchableOpacity
        style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
        activeOpacity={1}
        onPress={onClose}
      />
      <View
        style={{
          position: 'absolute',
          left: 20,
          right: 20,
          bottom: Math.max(40, bottomInset + 20),
          backgroundColor: theme.colors.surface1,
          borderRadius: Skin.radius(14),
          padding: Skin.space(16),
          gap: Skin.space(8),
        }}
      >
        <Text
          style={{
            color: theme.colors.textStrong,
            fontSize: Skin.font(16),
            fontWeight: '600',
            marginBottom: Skin.space(4),
          }}
        >
          Edit which profile?
        </Text>
        <TouchableOpacity
          style={{ paddingVertical: Skin.space(12), flexDirection: 'row', alignItems: 'center', gap: Skin.space(10) }}
          onPress={() => onPick('quorum')}
        >
          <IconSymbol name="shield.fill" size={20} color={theme.colors.accent} />
          <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(15) }}>Quorum profile</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={{ paddingVertical: Skin.space(12), flexDirection: 'row', alignItems: 'center', gap: Skin.space(10) }}
          onPress={() => onPick('farcaster')}
        >
          <IconSymbol name="person.2.fill" size={20} color={theme.colors.textMuted} />
          <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(15) }}>Farcaster profile</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    root: {
      flex: 1,
    },
    pillRow: {
      flexGrow: 0,
      paddingTop: Skin.space(8),
      paddingBottom: Skin.space(4),
    },
    pillRowContent: {
      paddingHorizontal: Skin.space(16),
    },
    // Applied only with few pills: fill the viewport and center them.
    pillRowContentCentered: {
      flexGrow: 1,
      justifyContent: 'center',
    },
    content: {
      flex: 1,
    },
  });
}
