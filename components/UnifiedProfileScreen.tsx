import ProfileModal from '@/components/ProfileModal';
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
import { useAuth } from '@/context/AuthContext';
import { useFarcasterProfile } from '@/hooks/useFarcasterProfile';
import {
  hasDecidedSplitMode,
  useProfileSplitMode,
} from '@/services/profile/profilePrefs';
import { useTheme, type AppTheme } from '@/theme';
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
  const { width } = useWindowDimensions();
  const router = useRouter();

  const [splitMode] = useProfileSplitMode();
  const [decisionModalVisible, setDecisionModalVisible] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [editPickerVisible, setEditPickerVisible] = useState(false);
  const [castLikeStates] = useState<Map<string, { liked: boolean; count: number }>>(() => new Map());
  // Marketplace-family modals are rendered at this level (not inside ProfileModal)
  // so they don't sit inside the horizontal pager's ScrollView, which can leave
  // the pager's active page unable to receive touches after dismiss.
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

  // Page indices - dynamically built based on farcaster presence
  const pages = useMemo(() => {
    const pageList: { key: string; label: string }[] = [{ key: 'quorum', label: 'Profile' }];
    if (hasFarcaster) {
      pageList.push({ key: 'casts', label: 'Casts' });
    }
    return pageList;
  }, [hasFarcaster]);

  const [activePageIndex, setActivePageIndex] = useState(0);
  const scrollRef = useRef<ScrollView | null>(null);

  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offsetX = e.nativeEvent.contentOffset.x;
      const idx = Math.round(offsetX / width);
      if (idx !== activePageIndex && idx >= 0 && idx < pages.length) {
        setActivePageIndex(idx);
      }
    },
    [activePageIndex, pages.length, width],
  );

  const goToPage = (i: number) => {
    setActivePageIndex(i);
    scrollRef.current?.scrollTo({ x: i * width, animated: true });
  };

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
    // visible gap between the header and the Quorum/Farcaster segment
    // selector.
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <UnifiedProfileHeader
        user={user}
        farcasterProfile={farcasterAuthor}
        splitMode={splitMode}
        onEditQuorum={() => setEditTarget('quorum')}
        onEditFarcaster={() => setEditTarget('farcaster')}
        onEditUnified={handleEditRequest}
      />

      {pages.length > 1 && (
        <View style={styles.segmentBar}>
          {pages.map((page, i) => (
            <TouchableOpacity
              key={page.key}
              style={[styles.segment, i === activePageIndex && styles.segmentActive]}
              onPress={() => goToPage(i)}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.segmentLabel,
                  i === activePageIndex && { color: theme.colors.accent, fontWeight: '600' },
                ]}
              >
                {page.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScroll}
        scrollEventThrottle={16}
        style={styles.pager}
      >
        {pages.map((page) => (
          <View key={page.key} style={{ width }}>
            {page.key === 'quorum' && (
              <ProfileModal
                visible={true}
                onClose={() => {}}
                onOpenWarpcastImport={onOpenWarpcastImport}
                isRouteMode={true}
                hideHeader={true}
                onOpenMarketplace={() => setMarketplaceModalVisible(true)}
                onOpenAuctions={() => setAuctionsModalVisible(true)}
                onOpenOffers={() => setOffersModalVisible(true)}
              />
            )}
            {page.key === 'casts' && user.farcaster?.fid && (
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
            )}
          </View>
        ))}
      </ScrollView>

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
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (target: 'quorum' | 'farcaster' | 'both') => void;
  theme: AppTheme;
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
          bottom: 40,
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
    segmentBar: {
      flexDirection: 'row',
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface3,
      paddingHorizontal: Skin.space(16),
    },
    segment: {
      flex: 1,
      paddingVertical: Skin.space(12),
      alignItems: 'center',
      borderBottomWidth: Skin.border(2),
      borderBottomColor: 'transparent',
    },
    segmentActive: {
      borderBottomColor: theme.colors.accent,
    },
    segmentLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    pager: {
      flex: 1,
    },
  });
}
