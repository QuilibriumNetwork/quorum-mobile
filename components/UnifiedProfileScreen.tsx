import ProfileModal, { type ProfileSection } from '@/components/ProfileModal';
import ProfileSplitModeModal from '@/components/ProfileSplitModeModal';
import AuctionsModal from '@/components/qns/AuctionsModal';
import BuyNameModal from '@/components/qns/BuyNameModal';
import MarketplaceModal from '@/components/qns/MarketplaceModal';
import OffersModal from '@/components/qns/OffersModal';
import type { ResaleListing } from '@/services/api/qnsClient';
import { ProfileView } from '@/components/SocialFeedModal';
import UnifiedProfileHeader from '@/components/UnifiedProfileHeader';
import UnifiedProfileEditModal from '@/components/UnifiedProfileEditModal';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';
import { useAuth } from '@/context/AuthContext';
import { useFarcasterProfile } from '@/hooks/useFarcasterProfile';
import {
  hasDecidedSplitMode,
  useProfileSplitMode,
} from '@/services/profile/profilePrefs';
import { useTheme, type AppTheme } from '@/theme';
import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
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
  const { user, farcasterAuthToken } = useAuth();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [splitMode] = useProfileSplitMode();
  const [decisionModalVisible, setDecisionModalVisible] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [editPickerVisible, setEditPickerVisible] = useState(false);
  const [castLikeStates] = useState<Map<string, { liked: boolean; count: number }>>(() => new Map());
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
  type ProfilePill = ProfileSection | 'casts';
  const pills = useMemo<SegmentedPillItem[]>(() => {
    const list: SegmentedPillItem[] = [
      { key: 'profile', label: 'Profile' },
      { key: 'premium', label: 'Premium' },
      { key: 'settings', label: 'Settings' },
    ];
    if (hasFarcaster) {
      list.push({ key: 'farcaster', label: 'Farcaster' });
      list.push({ key: 'casts', label: 'Casts' });
    }
    return list;
  }, [hasFarcaster]);

  const [activePill, setActivePill] = useState<ProfilePill>('profile');

  // If the active pill becomes unavailable (e.g. Farcaster disconnected while on
  // the Farcaster/Casts pill), fall back to Profile.
  useEffect(() => {
    if (!hasFarcaster && (activePill === 'farcaster' || activePill === 'casts')) {
      setActivePill('profile');
    }
  }, [hasFarcaster, activePill]);

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
        onEditQuorum={() => setEditTarget('quorum')}
        onEditFarcaster={() => setEditTarget('farcaster')}
        onEditUnified={handleEditRequest}
      />

      <SegmentedPills
        items={pills}
        activeKey={activePill}
        onChange={(key) => setActivePill(key as ProfilePill)}
        variant="solid"
        scrollable
        centerOnSelect
        style={styles.pillRow}
        contentContainerStyle={styles.pillRowContent}
      />

      <View style={styles.content}>
        {activePill === 'casts' ? (
          user.farcaster?.fid ? (
            <ProfileView
              fid={user.farcaster.fid}
              token={farcasterAuthToken ?? undefined}
              theme={theme}
              currentUserFid={user.farcaster.fid}
              hideBackButton={true}
              onClose={() => {}}
              onOpenThread={(username, hashPrefix) =>
                router.push({
                  pathname: '/(tabs)/feed',
                  params: { username, castHashPrefix: hashPrefix },
                })
              }
              onOpenMiniApp={(url) => router.push({ pathname: '/browser', params: { url } })}
              onOpenProfile={() => router.push('/(tabs)/feed')}
              onOpenChannel={() => router.push('/(tabs)/feed')}
              likeStates={castLikeStates}
              onLikeToggle={() => {
                // Like handling is owned by the feed tab; ignore in profile view.
              }}
              bottomInset={insets.bottom}
            />
          ) : null
        ) : (
          <ProfileModal
            visible={true}
            onClose={() => {}}
            onOpenWarpcastImport={onOpenWarpcastImport}
            isRouteMode={true}
            hideHeader={true}
            hideTabBar={true}
            activeSection={activePill}
            onOpenMarketplace={() => setMarketplaceModalVisible(true)}
            onOpenAuctions={() => setAuctionsModalVisible(true)}
            onOpenOffers={() => setOffersModalVisible(true)}
          />
        )}
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
      paddingVertical: Skin.space(8),
    },
    pillRowContent: {
      paddingHorizontal: Skin.space(16),
    },
    content: {
      flex: 1,
    },
  });
}
