/**
 * AuctionsModal - Browse active QNS auctions
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuctions } from '@/hooks/useQNSMarketplace';
import type { Auction } from '@/services/api/qnsClient';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AuctionDetailModal from './AuctionDetailModal';
import * as Skin from '@/theme/skins/geometry';

interface AuctionsModalProps {
  visible: boolean;
  onClose: () => void;
  onPurchaseSuccess?: () => void;
}

function useCountdown(endTime: string | undefined) {
  const [remaining, setRemaining] = React.useState('');

  React.useEffect(() => {
    if (!endTime) return;

    const update = () => {
      const diff = new Date(endTime).getTime() - Date.now();
      if (diff <= 0) {
        setRemaining('Ended');
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      if (hours > 24) {
        const days = Math.floor(hours / 24);
        setRemaining(`${days}d ${hours % 24}h`);
      } else if (hours > 0) {
        setRemaining(`${hours}h ${minutes}m`);
      } else {
        setRemaining(`${minutes}m ${seconds}s`);
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [endTime]);

  return remaining;
}

function AuctionCountdown({ endTime }: { endTime: string }) {
  const remaining = useCountdown(endTime);
  const { theme } = useTheme();
  const isUrgent = new Date(endTime).getTime() - Date.now() < 60 * 60 * 1000; // < 1 hour

  return (
    <Text style={{
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: isUrgent ? theme.colors.danger : theme.colors.textSubtle,
    }}>
      {remaining}
    </Text>
  );
}

export default function AuctionsModal({
  visible,
  onClose,
  onPurchaseSuccess,
}: AuctionsModalProps) {
  const { theme, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [selectedAuction, setSelectedAuction] = React.useState<Auction | null>(null);
  const [detailVisible, setDetailVisible] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: auctions, isLoading, refetch, isRefetching } = useAuctions(
    {
      limit: 50,
      search: debouncedSearch || undefined,
      state: 'active',
    },
    { enabled: visible }
  );

  React.useEffect(() => {
    if (visible) {
      setSearchQuery('');
      setDebouncedSearch('');
    }
  }, [visible]);

  const renderAuction = ({ item }: { item: Auction }) => (
    <TouchableOpacity
      style={styles.auctionCard}
      onPress={() => {
        setSelectedAuction(item);
        setDetailVisible(true);
      }}
      activeOpacity={0.7}
    >
      <View style={styles.auctionHeader}>
        <Text style={styles.auctionName}>@{item.name}</Text>
        <AuctionCountdown endTime={item.ends_at} />
      </View>
      <View style={styles.auctionDetails}>
        <View>
          <Text style={styles.bidLabel}>
            {item.bid_count > 0 ? 'Current bid' : 'Starting price'}
          </Text>
          <View style={styles.bidRow}>
            <Text style={styles.bidAmount}>
              {item.highest_bid || item.starting_price}
            </Text>
            <Text style={styles.bidToken}>{item.token}</Text>
          </View>
        </View>
        <View style={styles.auctionMeta}>
          <Text style={styles.bidCount}>
            {item.bid_count} bid{item.bid_count !== 1 ? 's' : ''}
          </Text>
          {item.instant_buy_price && (
            <Text style={styles.instantBuyText}>
              Buy now: {item.instant_buy_price} {item.token}
            </Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      {isLoading ? (
        <ActivityIndicator size="large" color={theme.colors.primary} />
      ) : (
        <>
          <IconSymbol name="hammer" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No Active Auctions</Text>
          <Text style={styles.emptySubtitle}>
            {debouncedSearch
              ? `No auctions match "${debouncedSearch}"`
              : 'Check back later for new auctions'}
          </Text>
        </>
      )}
    </View>
  );

  return (
    <>
      <BaseModal visible={visible} onClose={onClose} height={0.95} fillHeight>
        <View style={styles.header}>
          <Text style={styles.title}>Auctions</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchContainer}>
          <IconSymbol name="magnifyingglass" size={16} color={theme.colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search auctions..."
            placeholderTextColor={theme.colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <IconSymbol name="xmark.circle.fill" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={auctions?.auctions ?? []}
          renderItem={renderAuction}
          keyExtractor={item => item.id}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={renderEmpty}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={theme.colors.primary}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      </BaseModal>

      <AuctionDetailModal
        visible={detailVisible}
        onClose={() => {
          setDetailVisible(false);
          setSelectedAuction(null);
        }}
        auction={selectedAuction}
        onSuccess={() => {
          setDetailVisible(false);
          setSelectedAuction(null);
          refetch();
          onPurchaseSuccess?.();
        }}
      />
    </>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(12),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    searchContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(12),
      marginHorizontal: Skin.space(20),
      marginBottom: Skin.space(12),
      gap: Skin.space(8),
    },
    searchInput: {
      flex: 1,
      height: 40,
      fontSize: Skin.font(15),
      color: theme.colors.textMain,
    },
    listContent: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 20,
      flexGrow: 1,
    },
    auctionCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(10),
    },
    auctionHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(10),
    },
    auctionName: {
      fontSize: Skin.font(17),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    auctionDetails: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'flex-end',
    },
    bidLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(2),
    },
    bidRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: Skin.space(4),
    },
    bidAmount: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    bidToken: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
    auctionMeta: {
      alignItems: 'flex-end',
    },
    bidCount: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
    },
    instantBuyText: {
      fontSize: Skin.font(11),
      color: theme.colors.success,
      marginTop: Skin.space(2),
    },
    emptyContainer: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(60),
      gap: Skin.space(12),
    },
    emptyTitle: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    emptySubtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      textAlign: 'center',
    },
  });
