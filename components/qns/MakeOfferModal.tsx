/**
 * MakeOfferModal - Make an offer on a marketplace listing or a name
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import { useCreateOfferOnListing, useCreateOfferOnName } from '@/hooks/useQNSMarketplace';
import { getWalletPrivateKey, signQNSSignatureMessage } from '@/hooks/useQNSPayment';
import { useWalletKeys } from '@/hooks/useWallet';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useWarpcastWallet } from '@/hooks/useWarpcastWallet';
import {
  generateStealthOwnership,
  stealthOwnershipToApi,
} from '@/services/onboarding/keyService';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface MakeOfferModalProps {
  visible: boolean;
  onClose: () => void;
  // Provide either listing or name+nameType
  listingId?: string;
  name?: string;
  nameType?: 'username' | 'domain';
  listingToken?: 'wQUIL' | 'USDC';
  onSuccess?: () => void;
}

const EXPIRY_OPTIONS = [
  { label: '1 day', hours: 24 },
  { label: '2 days', hours: 48 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
];

export default function MakeOfferModal({
  visible,
  onClose,
  listingId,
  name,
  nameType = 'username',
  listingToken,
  onSuccess,
}: MakeOfferModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);
  const { refetch: fetchKeys } = useWalletKeys();
  const { activeWallet, activeType } = useWalletSelection();
  const { importedWallet } = useWarpcastWallet();

  const [token, setToken] = React.useState<'wQUIL' | 'USDC'>(listingToken || 'USDC');
  const [amount, setAmount] = React.useState('');
  const [expiryHours, setExpiryHours] = React.useState(72);

  const { mutate: createOfferListing, isPending: isCreatingListing } = useCreateOfferOnListing();
  const { mutate: createOfferName, isPending: isCreatingName } = useCreateOfferOnName();

  const isSubmitting = isCreatingListing || isCreatingName;

  React.useEffect(() => {
    if (visible) {
      setToken(listingToken || 'USDC');
      setAmount('');
      setExpiryHours(72);
    }
  }, [visible, listingToken]);

  const handleSubmit = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Invalid Amount', 'Please enter a valid offer amount.');
      return;
    }

    if (!user?.quilibriumAddress || !activeWallet) {
      Alert.alert('Error', 'Wallet not found.');
      return;
    }

    try {
      const stealth = generateStealthOwnership(user.quilibriumAddress);
      const ownership = stealthOwnershipToApi(stealth);

      // Sign the QNS signature message (EIP-191) so the server can verify the buyer address
      const walletPrivateKey = await getWalletPrivateKey(activeType, importedWallet, fetchKeys);
      const { address: buyerAddress, signature } = await signQNSSignatureMessage(walletPrivateKey);

      const callbacks = {
        onSuccess: () => {
          Alert.alert('Offer Sent', `Your offer of ${amount} ${token} has been submitted.`);
          onSuccess?.();
          onClose();
        },
        onError: (err: Error) => {
          Alert.alert('Error', err.message || 'Failed to create offer');
        },
      };

      if (listingId) {
        // Listing offers always use the listing's token, so no token is sent
        createOfferListing({
          listingId,
          amount,
          buyerAddress,
          buyerOwnership: ownership,
          expiresInHours: expiryHours,
          signature,
        }, callbacks);
      } else if (name) {
        createOfferName({
          name,
          nameType,
          token,
          amount,
          buyerAddress,
          buyerOwnership: ownership,
          expiresInHours: expiryHours,
          signature,
        }, callbacks);
      }
    } catch (err) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create offer');
    }
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.65}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Make Offer</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        {name && (
          <View style={styles.nameContainer}>
            <Text style={styles.nameLabel}>@{name}</Text>
          </View>
        )}

        {/* Token Selector (only if not locked to listing token) */}
        {!listingToken && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Token</Text>
            <View style={styles.tokenSelector}>
              {(['USDC', 'wQUIL'] as const).map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.tokenOption, token === t && styles.tokenOptionSelected]}
                  onPress={() => setToken(t)}
                >
                  <Text style={[styles.tokenOptionText, token === t && styles.tokenOptionTextSelected]}>
                    {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Amount */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Offer Amount</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.priceInput}
              placeholder="0.00"
              placeholderTextColor={theme.colors.textMuted}
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
            />
            <Text style={styles.inputToken}>{token}</Text>
          </View>
        </View>

        {/* Expiration */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Expires In</Text>
          <View style={styles.expirySelector}>
            {EXPIRY_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.hours}
                style={[styles.expiryOption, expiryHours === opt.hours && styles.expiryOptionSelected]}
                onPress={() => setExpiryHours(opt.hours)}
              >
                <Text style={[styles.expiryText, expiryHours === opt.hours && styles.expiryTextSelected]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Fee Disclosure */}
        <View style={styles.feeInfo}>
          <IconSymbol name="info.circle" size={14} color={theme.colors.textMuted} />
          <Text style={styles.feeInfoText}>
            1% platform fee will be applied if the offer is accepted
          </Text>
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitButton, (isSubmitting || !amount) && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isSubmitting || !amount}
        >
          {isSubmitting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.submitButtonText}>Send Offer</Text>
          )}
        </TouchableOpacity>
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
      padding: Skin.space(12),
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    nameLabel: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.primary,
    },
    section: { marginBottom: Skin.space(20) },
    sectionTitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textSubtle,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    tokenSelector: { flexDirection: 'row', gap: Skin.space(8) },
    tokenOption: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface2,
      alignItems: 'center',
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    tokenOptionSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: isDark ? 'theme.colors.accentSoft' : 'theme.colors.accentSubtle',
    },
    tokenOptionText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textSubtle,
    },
    tokenOptionTextSelected: { color: theme.colors.primary },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(10),
    },
    priceInput: {
      flex: 1,
      height: 44,
      paddingHorizontal: Skin.space(14),
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
    },
    inputToken: {
      paddingHorizontal: Skin.space(14),
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    expirySelector: { flexDirection: 'row', gap: Skin.space(8) },
    expiryOption: {
      flex: 1,
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface2,
      alignItems: 'center',
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    expiryOptionSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: isDark ? 'theme.colors.accentSoft' : 'theme.colors.accentSubtle',
    },
    expiryText: { fontSize: Skin.font(13), color: theme.colors.textSubtle },
    expiryTextSelected: {
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    feeInfo: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      marginBottom: Skin.space(20),
    },
    feeInfoText: { fontSize: Skin.font(13), color: theme.colors.textSubtle },
    submitButton: {
      height: 50,
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      justifyContent: 'center',
      alignItems: 'center',
    },
    submitButtonDisabled: { opacity: 0.5 },
    submitButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: '#fff',
    },
  });
