/**
 * NameDetailModal - View and manage an owned QNS name
 * Shows registration details, listing status, and actions (list, cancel, transfer)
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import {
  useGetResaleListingByName,
  useUpdateResolveKey,
} from '@/hooks/useQNS';
import type { NameRecord } from '@/services/api/qnsClient';
import {
  useCancelResaleListing,
  useTransferOwnership,
  useOffersForName,
} from '@/hooks/useQNSMarketplace';
import {
  generateNonce,
  getFullStealthKeyMaterial,
  signResaleListing,
  signStealthOwnership,
} from '@/services/onboarding/keyService';
import { getMnemonic, getPrivateKey } from '@/services/onboarding/secureStorage';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface NameDetailModalProps {
  visible: boolean;
  onClose: () => void;
  name: string;
  nameType: 'username' | 'domain';
  isResolvable: boolean;
  isPrimary: boolean;
  /**
   * The stealth ownership record for this name, found in the owner's bucket
   * (GET /bucket/{tag}). The server only exposes ownership markers via the
   * bucket route, so the parent (which already holds the bucket records)
   * passes the matched record down.
   */
  nameRecord?: NameRecord | null;
  onListName?: (name: string) => void;
  onRefresh?: () => void;
}

export default function NameDetailModal({
  visible,
  onClose,
  name,
  nameType,
  isResolvable,
  isPrimary,
  nameRecord,
  onListName,
  onRefresh,
}: NameDetailModalProps) {
  const { theme, isDark } = useTheme();
  const { user, updateProfile } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);

  const [showTransfer, setShowTransfer] = React.useState(false);
  const [transferAddress, setTransferAddress] = React.useState('');
  const [isTransferring, setIsTransferring] = React.useState(false);
  const [isCancelling, setIsCancelling] = React.useState(false);

  const { data: listing, isLoading: isLoadingListing } = useGetResaleListingByName(name, {
    enabled: visible && !!name,
  });

  const { data: offers } = useOffersForName(name, {
    enabled: visible && !!name,
  });

  const { mutate: cancelListing } = useCancelResaleListing();
  const { mutate: transferOwnership } = useTransferOwnership();
  const { mutate: updateResolveKey, isPending: isUpdatingResolveKey } = useUpdateResolveKey();

  const isListed = listing && (listing.state === 'active' || listing.state === 'locked');
  const pendingOffers = offers?.filter(o => o.state === 'pending') ?? [];

  // Reset state when modal opens
  React.useEffect(() => {
    if (visible) {
      setShowTransfer(false);
      setTransferAddress('');
    }
  }, [visible]);

  const handleSetPrimary = () => {
    updateProfile({ primaryUsername: name });
    Alert.alert('Primary Set', `@${name} is now your primary username.`);
  };

  /**
   * Update (set or clear) the public resolve key for this name.
   * Passing `resolveKey: undefined` makes the name private (unresolvable);
   * passing the user's ed448 public key makes it publicly resolvable.
   * The signature is over (name, nameType, timestamp, nonce) in both
   * directions, so the same signing flow covers resolve and unresolve.
   */
  const submitResolveKeyUpdate = async (makeResolvable: boolean) => {
    if (!user?.quilibriumAddress || !nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
      Alert.alert('Error', 'Could not retrieve ownership information.');
      return;
    }
    if (makeResolvable && !user?.publicKey) {
      Alert.alert('Error', 'Could not retrieve your public key.');
      return;
    }

    try {
      const mnemonic = await getMnemonic();
      const privateKey = await getPrivateKey();
      const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
        user.quilibriumAddress,
        mnemonic ?? undefined,
        privateKey ?? undefined
      );

      const oneTimeKey = Uint8Array.from(atob(nameRecord.ownership.one_time_key), c => c.charCodeAt(0));
      const verificationKey = Uint8Array.from(atob(nameRecord.ownership.verification_key), c => c.charCodeAt(0));
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();

      const signature = signResaleListing(
        viewKeyMaterial,
        spendKeyMaterial,
        oneTimeKey,
        verificationKey,
        name,
        nameType,
        timestamp,
        nonce
      );

      updateResolveKey({
        name,
        nameType,
        // Omit the resolve key to make the name private; include the ed448
        // public key (57 bytes / 114 hex chars) to make it resolvable.
        resolveKey: makeResolvable ? user.publicKey : undefined,
        signature,
        timestamp,
        nonce,
      }, {
        onSuccess: () => {
          Alert.alert(
            'Success',
            makeResolvable
              ? `@${name} is now publicly resolvable.`
              : `@${name} is now private and no longer resolvable.`
          );
          onRefresh?.();
        },
        onError: (err) => {
          Alert.alert('Error', err instanceof Error ? err.message : 'Failed to update resolve key');
        },
      });
    } catch (err) {
      Alert.alert('Error', makeResolvable ? 'Failed to make name resolvable' : 'Failed to make name private');
    }
  };

  const handleMakeResolvable = () => submitResolveKeyUpdate(true);

  const handleMakePrivate = () => {
    Alert.alert(
      'Make Private',
      `Stop resolving @${name}? Others will no longer be able to find your address by this name. You keep ownership and can make it resolvable again at any time.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Make Private', style: 'destructive', onPress: () => submitResolveKeyUpdate(false) },
      ]
    );
  };

  const handleCancelListing = () => {
    if (!listing || !nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
      Alert.alert('Error', 'Could not retrieve listing or ownership info.');
      return;
    }

    const { one_time_key: oneTimeKeyB64, verification_key: verificationKeyB64 } = nameRecord.ownership;

    Alert.alert(
      'Cancel Listing',
      `Are you sure you want to remove @${name} from the marketplace?`,
      [
        { text: 'Keep Listed', style: 'cancel' },
        {
          text: 'Cancel Listing',
          style: 'destructive',
          onPress: async () => {
            setIsCancelling(true);
            try {
              const mnemonic = await getMnemonic();
              const privateKey = await getPrivateKey();
              if (!user?.quilibriumAddress) throw new Error('No address');

              const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );

              const oneTimeKey = Uint8Array.from(atob(oneTimeKeyB64), c => c.charCodeAt(0));
              const verificationKey = Uint8Array.from(atob(verificationKeyB64), c => c.charCodeAt(0));
              const timestamp = Math.floor(Date.now() / 1000);
              const nonce = generateNonce();

              const signature = signResaleListing(
                viewKeyMaterial,
                spendKeyMaterial,
                oneTimeKey,
                verificationKey,
                name,
                nameType,
                timestamp,
                nonce
              );

              const listingId = listing.listing_id || listing.id;
              if (!listingId) throw new Error('No listing ID');

              cancelListing({
                listingId,
                signature,
                timestamp,
                nonce,
              }, {
                onSuccess: () => {
                  Alert.alert('Listing Cancelled', `@${name} has been removed from the marketplace.`);
                  onRefresh?.();
                  setIsCancelling(false);
                },
                onError: (err) => {
                  Alert.alert('Error', err instanceof Error ? err.message : 'Failed to cancel listing');
                  setIsCancelling(false);
                },
              });
            } catch (err) {
              Alert.alert('Error', 'Failed to cancel listing');
              setIsCancelling(false);
            }
          },
        },
      ]
    );
  };

  const handleTransfer = async () => {
    if (!transferAddress || !/^0x[a-fA-F0-9]{40}$/.test(transferAddress)) {
      Alert.alert('Invalid Address', 'Please enter a valid Ethereum address.');
      return;
    }

    if (!nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key || !user?.quilibriumAddress) {
      Alert.alert('Error', 'Could not retrieve ownership information.');
      return;
    }

    const { one_time_key: oneTimeKeyB64, verification_key: verificationKeyB64 } = nameRecord.ownership;

    Alert.alert(
      'Transfer Name',
      `Transfer @${name} to ${transferAddress.slice(0, 6)}...${transferAddress.slice(-4)}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Transfer',
          style: 'destructive',
          onPress: async () => {
            setIsTransferring(true);
            try {
              const mnemonic = await getMnemonic();
              const privateKey = await getPrivateKey();
              const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
                user.quilibriumAddress,
                mnemonic ?? undefined,
                privateKey ?? undefined
              );

              const oneTimeKey = Uint8Array.from(atob(oneTimeKeyB64), c => c.charCodeAt(0));
              const verificationKey = Uint8Array.from(atob(verificationKeyB64), c => c.charCodeAt(0));
              const timestamp = Math.floor(Date.now() / 1000);
              const nonce = generateNonce();

              // The server verifies transfers against the "transfer" message type
              // (not the name type) - see qns-api resolution.go
              const signature = signStealthOwnership(
                viewKeyMaterial,
                spendKeyMaterial,
                oneTimeKey,
                verificationKey,
                name,
                'transfer',
                timestamp,
                nonce
              );

              // New ownership: Ethereum address
              const newOwnership = { type: 'ethereum' as const, address: transferAddress };

              transferOwnership({
                name,
                nameType,
                newOwnership,
                signature,
                timestamp,
                nonce,
              }, {
                onSuccess: () => {
                  Alert.alert('Transferred', `@${name} has been transferred.`);
                  onRefresh?.();
                  onClose();
                  setIsTransferring(false);
                },
                onError: (err) => {
                  Alert.alert('Error', err instanceof Error ? err.message : 'Failed to transfer');
                  setIsTransferring(false);
                },
              });
            } catch (err) {
              Alert.alert('Error', 'Failed to transfer name');
              setIsTransferring(false);
            }
          },
        },
      ]
    );
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.75}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Name Details</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {/* Name Display */}
        <View style={styles.nameContainer}>
          <Text style={styles.nameLabel}>@{name}</Text>
          <View style={styles.badgeRow}>
            {isPrimary && (
              <View style={[styles.badge, { backgroundColor: isDark ? 'theme.colors.accentSoft' : 'theme.colors.accentSoft' }]}>
                <IconSymbol name="star.fill" size={12} color={theme.colors.primary} />
                <Text style={[styles.badgeText, { color: theme.colors.primary }]}>Primary</Text>
              </View>
            )}
            {isResolvable && (
              <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.1)' }]}>
                <IconSymbol name="checkmark.seal.fill" size={12} color={theme.colors.success} />
                <Text style={[styles.badgeText, { color: theme.colors.success }]}>Resolvable</Text>
              </View>
            )}
            {isListed && (
              <View style={[styles.badge, { backgroundColor: isDark ? 'rgba(245, 158, 11, 0.15)' : 'rgba(245, 158, 11, 0.1)' }]}>
                <IconSymbol name="tag.fill" size={12} color={theme.colors.warning} />
                <Text style={[styles.badgeText, { color: theme.colors.warning }]}>Listed</Text>
              </View>
            )}
          </View>
        </View>

        {/* Listing Info */}
        {isListed && listing && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Marketplace Listing</Text>
            <View style={styles.infoCard}>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Price</Text>
                <Text style={styles.infoValue}>{listing.price_amount} {listing.price_token}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Seller receives</Text>
                <Text style={styles.infoValue}>{listing.seller_amount} {listing.price_token}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Status</Text>
                <Text style={[styles.infoValue, { textTransform: 'capitalize' }]}>{listing.state}</Text>
              </View>
            </View>
          </View>
        )}

        {/* Pending Offers */}
        {pendingOffers.length > 0 && (
          <View style={styles.section}>
            <View style={styles.offerBadge}>
              <IconSymbol name="envelope.fill" size={16} color={theme.colors.primary} />
              <Text style={styles.offerBadgeText}>
                {pendingOffers.length} pending offer{pendingOffers.length > 1 ? 's' : ''}
              </Text>
            </View>
          </View>
        )}

        {/* Actions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Actions</Text>

          {/* Set as Primary */}
          {isResolvable && !isPrimary && (
            <TouchableOpacity style={styles.actionButton} onPress={handleSetPrimary}>
              <IconSymbol name="star" size={18} color={theme.colors.primary} />
              <View style={styles.actionContent}>
                <Text style={styles.actionText}>Set as Primary</Text>
                <Text style={styles.actionSubtext}>Use this as your main username</Text>
              </View>
              <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}

          {/* Make Resolvable */}
          {!isResolvable && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleMakeResolvable}
              disabled={isUpdatingResolveKey}
            >
              <IconSymbol name="globe" size={18} color={theme.colors.success} />
              <View style={styles.actionContent}>
                <Text style={styles.actionText}>Make Resolvable</Text>
                <Text style={styles.actionSubtext}>Allow others to find your address by name</Text>
              </View>
              {isUpdatingResolveKey ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              )}
            </TouchableOpacity>
          )}

          {/* Make Private (stop resolving) — only when currently resolvable */}
          {isResolvable && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleMakePrivate}
              disabled={isUpdatingResolveKey}
            >
              <IconSymbol name="lock.fill" size={18} color={theme.colors.textMuted} />
              <View style={styles.actionContent}>
                <Text style={styles.actionText}>Make Private</Text>
                <Text style={styles.actionSubtext}>Stop resolving this name (you keep ownership)</Text>
              </View>
              {isUpdatingResolveKey ? (
                <ActivityIndicator size="small" color={theme.colors.primary} />
              ) : (
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              )}
            </TouchableOpacity>
          )}

          {/* List on Marketplace */}
          {!isListed && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                onClose();
                onListName?.(name);
              }}
            >
              <IconSymbol name="tag.fill" size={18} color={theme.colors.warning} />
              <View style={styles.actionContent}>
                <Text style={styles.actionText}>List on Marketplace</Text>
                <Text style={styles.actionSubtext}>Sell this name to another user</Text>
              </View>
              <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}

          {/* Cancel Listing */}
          {isListed && listing?.state === 'active' && (
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleCancelListing}
              disabled={isCancelling}
            >
              <IconSymbol name="xmark.circle" size={18} color={theme.colors.danger} />
              <View style={styles.actionContent}>
                <Text style={[styles.actionText, { color: theme.colors.danger }]}>Cancel Listing</Text>
                <Text style={styles.actionSubtext}>Remove from the marketplace</Text>
              </View>
              {isCancelling ? (
                <ActivityIndicator size="small" color={theme.colors.danger} />
              ) : (
                <IconSymbol name="chevron.right" size={16} color={theme.colors.textMuted} />
              )}
            </TouchableOpacity>
          )}

          {/* Transfer */}
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => setShowTransfer(!showTransfer)}
          >
            <IconSymbol name="arrow.right.arrow.left" size={18} color={theme.colors.textMuted} />
            <View style={styles.actionContent}>
              <Text style={styles.actionText}>Transfer Ownership</Text>
              <Text style={styles.actionSubtext}>Send this name to another address</Text>
            </View>
            <IconSymbol
              name={showTransfer ? 'chevron.down' : 'chevron.right'}
              size={16}
              color={theme.colors.textMuted}
            />
          </TouchableOpacity>

          {/* Transfer Input */}
          {showTransfer && (
            <View style={styles.transferContainer}>
              <TextInput
                style={styles.transferInput}
                placeholder="0x..."
                placeholderTextColor={theme.colors.textMuted}
                value={transferAddress}
                onChangeText={setTransferAddress}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[
                  styles.transferButton,
                  (!transferAddress || isTransferring) && styles.transferButtonDisabled,
                ]}
                onPress={handleTransfer}
                disabled={!transferAddress || isTransferring}
              >
                {isTransferring ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.transferButtonText}>Transfer</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean, insets: EdgeInsets) =>
  StyleSheet.create({
    content: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: insets.bottom + 20,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    nameContainer: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    nameLabel: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
      marginBottom: Skin.space(8),
    },
    badgeRow: {
      flexDirection: 'row',
      gap: Skin.space(8),
    },
    badge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingVertical: Skin.space(3),
      paddingHorizontal: Skin.space(8),
      borderRadius: Skin.radius(10),
    },
    badgeText: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    section: {
      marginBottom: Skin.space(20),
    },
    sectionTitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    infoCard: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
    },
    infoRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(6),
    },
    infoLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    infoValue: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    offerBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      backgroundColor: isDark ? 'theme.colors.accentSoft' : 'theme.colors.accentSubtle',
      padding: Skin.space(12),
      borderRadius: Skin.radius(10),
    },
    offerBadgeText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    actionButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(10),
      padding: Skin.space(14),
      marginBottom: Skin.space(8),
      gap: Skin.space(12),
    },
    actionContent: {
      flex: 1,
    },
    actionText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    actionSubtext: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      marginTop: Skin.space(2),
    },
    transferContainer: {
      flexDirection: 'row',
      gap: Skin.space(8),
      marginBottom: Skin.space(8),
    },
    transferInput: {
      flex: 1,
      height: 44,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(10),
      paddingHorizontal: Skin.space(12),
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: 'monospace',
    },
    transferButton: {
      height: 44,
      paddingHorizontal: Skin.space(16),
      backgroundColor: theme.colors.danger,
      borderRadius: Skin.radius(10),
      justifyContent: 'center',
      alignItems: 'center',
    },
    transferButtonDisabled: {
      opacity: 0.5,
    },
    transferButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
  });
