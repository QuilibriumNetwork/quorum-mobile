/**
 * OffersModal - View and manage received and sent offers
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import {
  useOffersForOwner,
  useOffersByBuyer,
  useAcceptOffer,
  useRejectOffer,
  useCancelOffer,
} from '@/hooks/useQNSMarketplace';
import { useOfferPayment, type MarketplaceBuyStep } from '@/hooks/useQNSPayment';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import {
  generateNonce,
  getFullStealthKeyMaterial,
  getStealthKeyMaterial,
  signStealthOwnership,
} from '@/services/onboarding/keyService';
import { getMnemonic, getPrivateKey } from '@/services/onboarding/secureStorage';
import { getQNSClient, type Offer } from '@/services/api/qnsClient';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';
import { SegmentedPills, type SegmentedPillItem } from '@/components/ui/SegmentedPills';

interface OffersModalProps {
  visible: boolean;
  onClose: () => void;
  ownerAddress?: string;
  buyerAddress?: string;
  onRefresh?: () => void;
}

type TabType = 'received' | 'sent';

export default function OffersModal({
  visible,
  onClose,
  ownerAddress,
  buyerAddress,
  onRefresh: parentRefresh,
}: OffersModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);
  const { activeWallet } = useWalletSelection();

  const [activeTab, setActiveTab] = React.useState<TabType>('received');
  const [processingOfferId, setProcessingOfferId] = React.useState<string | null>(null);

  // Use owner address from wallet if not provided
  const effectiveOwnerAddress = ownerAddress || activeWallet?.address;
  const effectiveBuyerAddress = buyerAddress || activeWallet?.address;

  const {
    data: receivedOffers,
    isLoading: isLoadingReceived,
    refetch: refetchReceived,
    isRefetching: isRefetchingReceived,
  } = useOffersForOwner(effectiveOwnerAddress, { enabled: visible && activeTab === 'received' });

  const {
    data: sentOffers,
    isLoading: isLoadingSent,
    refetch: refetchSent,
    isRefetching: isRefetchingSent,
  } = useOffersByBuyer(effectiveBuyerAddress, { enabled: visible && activeTab === 'sent' });

  const { mutate: acceptOffer } = useAcceptOffer();
  const { mutate: rejectOffer } = useRejectOffer();
  const { mutate: cancelOffer } = useCancelOffer();

  React.useEffect(() => {
    if (visible) setActiveTab('received');
  }, [visible]);

  const handleAcceptOffer = async (offer: Offer) => {
    if (!user?.quilibriumAddress || !activeWallet || !offer.name) return;
    const offerName = offer.name;

    Alert.alert(
      'Accept Offer',
      `Accept ${offer.amount} ${offer.token} for @${offer.name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Accept',
          onPress: async () => {
            setProcessingOfferId(offer.id);
            try {
              const mnemonic = await getMnemonic();
              const privateKey = await getPrivateKey();
              const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );

              // Look up the stealth ownership markers via the owner's bucket -
              // the only route that exposes them (GET /bucket/{tag})
              const { bucketTag } = getStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );
              const nameRecord = await getQNSClient().getNameRecordFromBucket(bucketTag, offerName);
              if (!nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
                throw new Error('Could not retrieve ownership information');
              }

              const oneTimeKey = Uint8Array.from(atob(nameRecord.ownership.one_time_key), c => c.charCodeAt(0));
              const verificationKey = Uint8Array.from(atob(nameRecord.ownership.verification_key), c => c.charCodeAt(0));
              const timestamp = Math.floor(Date.now() / 1000);
              const nonce = generateNonce();

              // The server verifies offer acceptance against the offer ID with
              // the "offer" message type - see qns-api offer.go
              const signature = signStealthOwnership(
                viewKeyMaterial,
                spendKeyMaterial,
                oneTimeKey,
                verificationKey,
                offer.id,
                'offer',
                timestamp,
                nonce
              );

              acceptOffer({
                offerId: offer.id,
                ownerAddress: activeWallet.address,
                signature,
                timestamp,
                nonce,
              }, {
                onSuccess: () => {
                  Alert.alert('Offer Accepted', 'The buyer will now be prompted to complete payment.');
                  refetchReceived();
                  parentRefresh?.();
                  setProcessingOfferId(null);
                },
                onError: (err) => {
                  Alert.alert('Error', err instanceof Error ? err.message : 'Failed to accept offer');
                  setProcessingOfferId(null);
                },
              });
            } catch (err) {
              Alert.alert('Error', 'Failed to accept offer');
              setProcessingOfferId(null);
            }
          },
        },
      ]
    );
  };

  const handleRejectOffer = (offer: Offer) => {
    if (!user?.quilibriumAddress || !offer.name) return;
    const offerName = offer.name;

    Alert.alert(
      'Reject Offer',
      `Reject the offer of ${offer.amount} ${offer.token} for @${offer.name}?`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setProcessingOfferId(offer.id);
            try {
              const mnemonic = await getMnemonic();
              const privateKey = await getPrivateKey();
              const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );

              // Look up the stealth ownership markers via the owner's bucket -
              // the only route that exposes them (GET /bucket/{tag})
              const { bucketTag } = getStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );
              const nameRecord = await getQNSClient().getNameRecordFromBucket(bucketTag, offerName);
              if (!nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
                throw new Error('Could not retrieve ownership information');
              }

              const oneTimeKey = Uint8Array.from(atob(nameRecord.ownership.one_time_key), c => c.charCodeAt(0));
              const verificationKey = Uint8Array.from(atob(nameRecord.ownership.verification_key), c => c.charCodeAt(0));
              const timestamp = Math.floor(Date.now() / 1000);
              const nonce = generateNonce();

              // The server verifies offer rejection against the offer ID with
              // the "reject" message type - see qns-api offer.go
              const signature = signStealthOwnership(
                viewKeyMaterial,
                spendKeyMaterial,
                oneTimeKey,
                verificationKey,
                offer.id,
                'reject',
                timestamp,
                nonce
              );

              rejectOffer({
                offerId: offer.id,
                signature,
                timestamp,
                nonce,
              }, {
                onSuccess: () => {
                  refetchReceived();
                  setProcessingOfferId(null);
                },
                onError: (err) => {
                  Alert.alert('Error', err instanceof Error ? err.message : 'Failed to reject offer');
                  setProcessingOfferId(null);
                },
              });
            } catch (err) {
              Alert.alert('Error', 'Failed to reject offer');
              setProcessingOfferId(null);
            }
          },
        },
      ]
    );
  };

  const handleCancelOffer = (offer: Offer) => {
    if (!activeWallet) return;
    const cancelBuyerAddress = activeWallet.address;

    Alert.alert(
      'Cancel Offer',
      `Cancel your offer of ${offer.amount} ${offer.token} for @${offer.name}?`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Offer',
          style: 'destructive',
          onPress: () => {
            setProcessingOfferId(offer.id);
            const timestamp = Math.floor(Date.now() / 1000);
            const nonce = generateNonce();
            // The server authenticates cancellation by matching buyer_address
            const signature = btoa(`cancel:${offer.id}:${timestamp}:${nonce}`);

            cancelOffer({
              offerId: offer.id,
              buyerAddress: cancelBuyerAddress,
              signature,
              timestamp,
              nonce,
            }, {
              onSuccess: () => {
                refetchSent();
                setProcessingOfferId(null);
              },
              onError: (err) => {
                Alert.alert('Error', err instanceof Error ? err.message : 'Failed to cancel offer');
                setProcessingOfferId(null);
              },
            });
          },
        },
      ]
    );
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'pending': return theme.colors.warning;
      case 'accepted': return theme.colors.success;
      case 'rejected': return theme.colors.danger;
      case 'cancelled': return theme.colors.textMuted;
      case 'expired': return theme.colors.textMuted;
      default: return theme.colors.textMuted;
    }
  };

  const formatDate = (date: string | number) => {
    // Numeric dates from the API are unix seconds
    return new Date(typeof date === 'number' ? date * 1000 : date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const renderOffer = ({ item }: { item: Offer }) => {
    const isProcessing = processingOfferId === item.id;
    const isPending = item.state === 'pending';

    return (
      <View style={styles.offerCard}>
        <View style={styles.offerHeader}>
          <Text style={styles.offerName}>@{item.name}</Text>
          <View style={[styles.stateBadge, { backgroundColor: `${getStateColor(item.state)}20` }]}>
            <Text style={[styles.stateText, { color: getStateColor(item.state) }]}>
              {item.state}
            </Text>
          </View>
        </View>
        <View style={styles.offerDetails}>
          <View>
            <Text style={styles.offerAmount}>{item.amount} {item.token}</Text>
            <Text style={styles.offerDate}>
              {activeTab === 'received'
                ? `From ${item.buyer_address.slice(0, 6)}...${item.buyer_address.slice(-4)}`
                : `Expires ${formatDate(item.expires_at)}`
              }
            </Text>
          </View>
          {isPending && (
            <View style={styles.actionButtons}>
              {activeTab === 'received' ? (
                <>
                  <TouchableOpacity
                    style={[styles.acceptButton, isProcessing && styles.buttonDisabled]}
                    onPress={() => handleAcceptOffer(item)}
                    disabled={isProcessing}
                  >
                    {isProcessing ? (
                      <ActivityIndicator size="small" color="#fff" />
                    ) : (
                      <Text style={styles.acceptButtonText}>Accept</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.rejectButton, isProcessing && styles.buttonDisabled]}
                    onPress={() => handleRejectOffer(item)}
                    disabled={isProcessing}
                  >
                    <Text style={styles.rejectButtonText}>Reject</Text>
                  </TouchableOpacity>
                </>
              ) : (
                <TouchableOpacity
                  style={[styles.cancelButton, isProcessing && styles.buttonDisabled]}
                  onPress={() => handleCancelOffer(item)}
                  disabled={isProcessing}
                >
                  {isProcessing ? (
                    <ActivityIndicator size="small" color={theme.colors.danger} />
                  ) : (
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      </View>
    );
  };

  const currentOffers = activeTab === 'received' ? receivedOffers : sentOffers;
  const isLoading = activeTab === 'received' ? isLoadingReceived : isLoadingSent;
  const isRefetching = activeTab === 'received' ? isRefetchingReceived : isRefetchingSent;
  const onRefresh = activeTab === 'received' ? refetchReceived : refetchSent;

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      {isLoading ? (
        <ActivityIndicator size="large" color={theme.colors.primary} />
      ) : (
        <>
          <IconSymbol name="envelope.open" size={48} color={theme.colors.textMuted} />
          <Text style={styles.emptyTitle}>No Offers</Text>
          <Text style={styles.emptySubtitle}>
            {activeTab === 'received'
              ? 'You have no incoming offers'
              : 'You have no outgoing offers'
            }
          </Text>
        </>
      )}
    </View>
  );

  const pendingReceivedCount = receivedOffers
    ? receivedOffers.filter((o) => o.state === 'pending').length
    : 0;

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} fillHeight>
      <View style={styles.header}>
        <Text style={styles.title}>Offers</Text>
        <TouchableOpacity onPress={onClose}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      {/* Tabs */}
      <SegmentedPills
        style={styles.tabs}
        scrollable={false}
        items={[
          {
            key: 'received',
            label: 'Received',
            trailing:
              pendingReceivedCount > 0 ? (
                <View style={styles.tabBadge}>
                  <Text style={styles.tabBadgeText}>{pendingReceivedCount}</Text>
                </View>
              ) : undefined,
          },
          { key: 'sent', label: 'Sent' } as SegmentedPillItem,
        ]}
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as TabType)}
      />

      <FlatList
        data={currentOffers ?? []}
        renderItem={renderOffer}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={renderEmpty}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={onRefresh}
            tintColor={theme.colors.primary}
          />
        }
        showsVerticalScrollIndicator={false}
      />
    </BaseModal>
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
    tabs: {
      paddingHorizontal: Skin.space(20),
      marginBottom: Skin.space(12),
    },
    tabBadge: {
      backgroundColor: theme.colors.accent,
      borderRadius: Skin.radius(10),
      minWidth: 18,
      height: 18,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: Skin.space(5),
    },
    tabBadgeText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.surface0,
    },
    listContent: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 20,
      flexGrow: 1,
    },
    offerCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      marginBottom: Skin.space(10),
    },
    offerHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(8),
    },
    offerName: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    stateBadge: {
      paddingVertical: Skin.space(2),
      paddingHorizontal: Skin.space(8),
      borderRadius: Skin.radius(8),
    },
    stateText: {
      fontSize: Skin.font(11),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      textTransform: 'capitalize',
    },
    offerDetails: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    offerAmount: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    offerDate: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    actionButtons: {
      flexDirection: 'row',
      gap: Skin.space(8),
    },
    acceptButton: {
      backgroundColor: theme.colors.success,
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(14),
      borderRadius: Skin.radius(8),
    },
    acceptButtonText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
    rejectButton: {
      backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.1)',
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(14),
      borderRadius: Skin.radius(8),
    },
    rejectButtonText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.danger,
    },
    cancelButton: {
      backgroundColor: isDark ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.1)',
      paddingVertical: Skin.space(6),
      paddingHorizontal: Skin.space(14),
      borderRadius: Skin.radius(8),
    },
    cancelButtonText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.danger,
    },
    buttonDisabled: {
      opacity: 0.5,
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
      color: theme.colors.textMuted,
      textAlign: 'center',
    },
  });
