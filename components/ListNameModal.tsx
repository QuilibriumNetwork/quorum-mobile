/**
 * ListNameModal - Modal for listing a QNS name on the marketplace
 * Allows user to set price and specify an Ethereum address for receiving payment
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import { useCreateResaleListing } from '@/hooks/useQNS';
import type { NameRecord } from '@/services/api/qnsClient';
import {
  generateNonce,
  getFullStealthKeyMaterial,
  signResaleListing,
} from '@/services/onboarding/keyService';
import { getMnemonic, getPrivateKey } from '@/services/onboarding/secureStorage';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface ListNameModalProps {
  visible: boolean;
  onClose: () => void;
  name: string;
  nameType: 'username' | 'domain';
  /**
   * The stealth ownership record for this name from the owner's bucket
   * (GET /bucket/{tag}) - the only route that exposes ownership markers.
   */
  nameRecord?: NameRecord | null;
  onSuccess?: () => void;
}

export default function ListNameModal({
  visible,
  onClose,
  name,
  nameType,
  nameRecord,
  onSuccess,
}: ListNameModalProps) {
  const { theme } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);

  // Form state
  const [priceAmount, setPriceAmount] = React.useState('');
  const [priceToken, setPriceToken] = React.useState<'wQUIL' | 'USDC'>('wQUIL');
  const [sellerAddress, setSellerAddress] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const { mutate: createListing, isPending: isCreatingListing } = useCreateResaleListing();

  // Reset form when modal opens
  React.useEffect(() => {
    if (visible) {
      setPriceAmount('');
      setPriceToken('wQUIL');
      setSellerAddress('');
    }
  }, [visible]);

  const validateEthAddress = (address: string): boolean => {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  };

  const handleSubmit = async () => {
    // Validate inputs
    if (!priceAmount || parseFloat(priceAmount) <= 0) {
      Alert.alert('Invalid Price', 'Please enter a valid price greater than 0.');
      return;
    }

    if (!sellerAddress) {
      Alert.alert('Missing Address', 'Please enter an Ethereum address to receive payment.');
      return;
    }

    if (!validateEthAddress(sellerAddress)) {
      Alert.alert(
        'Invalid Address',
        'Please enter a valid Ethereum address (0x followed by 40 hex characters).'
      );
      return;
    }

    if (!nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
      Alert.alert('Error', 'Could not retrieve ownership keys for this name.');
      return;
    }

    if (!user?.quilibriumAddress) {
      Alert.alert('Error', 'User address not found.');
      return;
    }

    setIsSubmitting(true);

    try {
      // Get mnemonic and private key for signing
      const mnemonic = await getMnemonic();
      const privateKey = await getPrivateKey();

      // Get full stealth key material
      const { viewKeyMaterial, spendKeyMaterial } = getFullStealthKeyMaterial(
        user.quilibriumAddress,
        mnemonic ?? undefined,
        privateKey ?? undefined
      );

      // Decode ownership keys from base64
      const oneTimeKey = Uint8Array.from(
        atob(nameRecord.ownership.one_time_key),
        (c) => c.charCodeAt(0)
      );
      const verificationKey = Uint8Array.from(
        atob(nameRecord.ownership.verification_key),
        (c) => c.charCodeAt(0)
      );

      // Generate timestamp and nonce
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = generateNonce();

      // Sign the listing
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

      // Create the listing
      createListing(
        {
          name,
          nameType,
          priceToken,
          priceAmount,
          sellerAddress,
          signature,
          timestamp,
          nonce,
        },
        {
          onSuccess: (listing) => {
            Alert.alert(
              'Listed!',
              `@${name} has been listed for ${priceAmount} ${priceToken}.\n\nYou will receive ${listing.seller_amount} ${priceToken} (99%) when it sells.`,
              [
                {
                  text: 'OK',
                  onPress: () => {
                    onSuccess?.();
                    onClose();
                  },
                },
              ]
            );
          },
          onError: (error) => {
            const message = error instanceof Error ? error.message : 'Failed to create listing';
            Alert.alert('Error', message);
          },
        }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to sign listing';
      Alert.alert('Error', message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const isLoading = isSubmitting || isCreatingListing;

  // Calculate 99% seller amount for preview
  const sellerAmount = priceAmount ? (parseFloat(priceAmount) * 0.99).toFixed(2) : '0.00';
  const feeAmount = priceAmount ? (parseFloat(priceAmount) * 0.01).toFixed(2) : '0.00';

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} avoidKeyboard>
      <View style={styles.header}>
        <Text style={styles.title}>List on Marketplace</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Name being listed */}
        <View style={styles.nameSection}>
          <IconSymbol name="tag.fill" size={24} color={theme.colors.primary} />
          <Text style={styles.nameText}>@{name}</Text>
        </View>

        {/* Price Input */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Price</Text>
          <View style={styles.priceRow}>
            <TextInput
              style={styles.priceInput}
              value={priceAmount}
              onChangeText={setPriceAmount}
              placeholder="0.00"
              placeholderTextColor={theme.colors.textMuted}
              keyboardType="decimal-pad"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.tokenSelector}>
              <TouchableOpacity
                style={[
                  styles.tokenButton,
                  priceToken === 'wQUIL' && styles.tokenButtonActive,
                ]}
                onPress={() => setPriceToken('wQUIL')}
              >
                <Text
                  style={[
                    styles.tokenButtonText,
                    priceToken === 'wQUIL' && styles.tokenButtonTextActive,
                  ]}
                >
                  wQUIL
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.tokenButton,
                  priceToken === 'USDC' && styles.tokenButtonActive,
                ]}
                onPress={() => setPriceToken('USDC')}
              >
                <Text
                  style={[
                    styles.tokenButtonText,
                    priceToken === 'USDC' && styles.tokenButtonTextActive,
                  ]}
                >
                  USDC
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Fee breakdown */}
          {priceAmount && parseFloat(priceAmount) > 0 && (
            <View style={styles.feeBreakdown}>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>You receive (99%)</Text>
                <Text style={styles.feeValue}>
                  {sellerAmount} {priceToken}
                </Text>
              </View>
              <View style={styles.feeRow}>
                <Text style={styles.feeLabel}>Marketplace fee (1%)</Text>
                <Text style={styles.feeValueMuted}>
                  {feeAmount} {priceToken}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Ethereum Address Input */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Payment Address</Text>
          <Text style={styles.sectionDescription}>
            Enter the Ethereum address where you want to receive payment when your name sells.
          </Text>
          <TextInput
            style={styles.addressInput}
            value={sellerAddress}
            onChangeText={setSellerAddress}
            placeholder="0x..."
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
          />
          {sellerAddress && !validateEthAddress(sellerAddress) && (
            <View style={styles.errorRow}>
              <IconSymbol name="exclamationmark.circle.fill" size={14} color={theme.colors.danger} />
              <Text style={styles.errorText}>Invalid Ethereum address</Text>
            </View>
          )}
        </View>

        {/* Info Box */}
        <View style={styles.infoBox}>
          <IconSymbol name="info.circle.fill" size={18} color={theme.colors.primary} />
          <Text style={styles.infoText}>
            Your name will be listed on the QNS marketplace. When purchased, ownership will
            automatically transfer to the buyer and payment will be sent to your specified address.
          </Text>
        </View>
      </ScrollView>

      {/* Submit Button */}
      <View style={styles.footer}>
        <TouchableOpacity
          style={[
            styles.submitButton,
            (isLoading || !priceAmount || !sellerAddress || !validateEthAddress(sellerAddress)) &&
              styles.submitButtonDisabled,
          ]}
          onPress={handleSubmit}
          disabled={
            isLoading || !priceAmount || !sellerAddress || !validateEthAddress(sellerAddress)
          }
        >
          {isLoading ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconSymbol name="tag.fill" size={18} color="#fff" />
              <Text style={styles.submitButtonText}>List for Sale</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    closeButton: {
      padding: Skin.space(8),
    },
    content: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    nameSection: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface2,
      padding: Skin.space(16),
      borderRadius: Skin.radius(12),
      marginBottom: Skin.space(24),
      gap: Skin.space(10),
    },
    nameText: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
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
      marginBottom: Skin.space(8),
    },
    sectionDescription: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      marginBottom: Skin.space(12),
      lineHeight: Skin.font(18),
    },
    priceRow: {
      flexDirection: 'row',
      gap: Skin.space(12),
    },
    priceInput: {
      flex: 1,
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(14),
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    tokenSelector: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      padding: Skin.space(4),
    },
    tokenButton: {
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(6),
    },
    tokenButtonActive: {
      backgroundColor: theme.colors.primary,
    },
    tokenButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    tokenButtonTextActive: {
      color: '#fff',
    },
    feeBreakdown: {
      marginTop: Skin.space(12),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
    },
    feeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingVertical: Skin.space(4),
    },
    feeLabel: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
    },
    feeValue: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.success,
    },
    feeValueMuted: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    addressInput: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(8),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(14),
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    errorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginTop: Skin.space(8),
    },
    errorText: {
      fontSize: Skin.font(12),
      color: theme.colors.danger,
    },
    infoBox: {
      flexDirection: 'row',
      backgroundColor: theme.colors.primary + '15',
      borderRadius: Skin.radius(8),
      padding: Skin.space(12),
      gap: Skin.space(10),
      marginBottom: Skin.space(24),
    },
    infoText: {
      flex: 1,
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
    },
    footer: {
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(16),
      paddingBottom: Skin.space(16),
      borderTopWidth: Skin.border(1),
      borderTopColor: theme.colors.border,
    },
    submitButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(16),
      gap: Skin.space(8),
    },
    submitButtonDisabled: {
      opacity: 0.5,
    },
    submitButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
  });
