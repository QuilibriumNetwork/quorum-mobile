/**
 * CreateAuctionModal - Create an auction for an owned QNS name
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useAuth } from '@/context';
import { useCreateAuction, useAuctionInfo } from '@/hooks/useQNSMarketplace';
import type { NameRecord } from '@/services/api/qnsClient';
import {
  generateNonce,
  getFullStealthKeyMaterial,
  signResaleListing,
} from '@/services/onboarding/keyService';
import { getMnemonic, getPrivateKey } from '@/services/onboarding/secureStorage';
import { useWalletSelection } from '@/hooks/useWalletSelection';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface CreateAuctionModalProps {
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

const DURATION_OPTIONS = [24, 48, 72, 168]; // hours

export default function CreateAuctionModal({
  visible,
  onClose,
  name,
  nameType,
  nameRecord,
  onSuccess,
}: CreateAuctionModalProps) {
  const { theme, isDark } = useTheme();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, isDark, insets);
  const { activeWallet } = useWalletSelection();

  const [token, setToken] = React.useState<'wQUIL' | 'USDC'>('USDC');
  const [startingPrice, setStartingPrice] = React.useState('');
  const [instantBuyPrice, setInstantBuyPrice] = React.useState('');
  const [durationHours, setDurationHours] = React.useState(48);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const { data: auctionInfo } = useAuctionInfo({ enabled: visible });
  const { mutate: createAuction, isPending: isCreating } = useCreateAuction();

  React.useEffect(() => {
    if (visible) {
      setToken('USDC');
      setStartingPrice('');
      setInstantBuyPrice('');
      setDurationHours(48);
    }
  }, [visible]);

  const handleSubmit = async () => {
    if (!startingPrice || parseFloat(startingPrice) <= 0) {
      Alert.alert('Invalid Price', 'Please enter a valid starting price.');
      return;
    }

    if (instantBuyPrice && parseFloat(instantBuyPrice) <= parseFloat(startingPrice)) {
      Alert.alert('Invalid Price', 'Instant buy price must be higher than starting price.');
      return;
    }

    if (!nameRecord?.ownership?.one_time_key || !nameRecord?.ownership?.verification_key) {
      Alert.alert('Error', 'Could not retrieve ownership keys.');
      return;
    }

    if (!user?.quilibriumAddress || !activeWallet) {
      Alert.alert('Error', 'User address not found.');
      return;
    }

    setIsSubmitting(true);

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

      createAuction({
        name,
        nameType,
        token,
        startingPrice,
        instantBuyPrice: instantBuyPrice || undefined,
        durationHours,
        sellerAddress: activeWallet.address,
        signature,
        timestamp,
        nonce,
      }, {
        onSuccess: () => {
          Alert.alert('Auction Created', `Auction for @${name} has been created.`);
          onSuccess?.();
          onClose();
          setIsSubmitting(false);
        },
        onError: (err) => {
          Alert.alert('Error', err instanceof Error ? err.message : 'Failed to create auction');
          setIsSubmitting(false);
        },
      });
    } catch (err) {
      Alert.alert('Error', 'Failed to create auction');
      setIsSubmitting(false);
    }
  };

  const formatDuration = (hours: number): string => {
    if (hours >= 168) return '7 days';
    if (hours >= 72) return '3 days';
    if (hours >= 48) return '2 days';
    return '1 day';
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.8}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Create Auction</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.nameContainer}>
          <Text style={styles.nameLabel}>@{name}</Text>
        </View>

        {/* Token Selector */}
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

        {/* Starting Price */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Starting Price</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.priceInput}
              placeholder="0.00"
              placeholderTextColor={theme.colors.textMuted}
              value={startingPrice}
              onChangeText={setStartingPrice}
              keyboardType="decimal-pad"
            />
            <Text style={styles.inputToken}>{token}</Text>
          </View>
        </View>

        {/* Instant Buy Price (Optional) */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Instant Buy Price (Optional)</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.priceInput}
              placeholder="Leave empty for no instant buy"
              placeholderTextColor={theme.colors.textMuted}
              value={instantBuyPrice}
              onChangeText={setInstantBuyPrice}
              keyboardType="decimal-pad"
            />
            <Text style={styles.inputToken}>{token}</Text>
          </View>
        </View>

        {/* Duration */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Duration</Text>
          <View style={styles.durationSelector}>
            {DURATION_OPTIONS.map(h => (
              <TouchableOpacity
                key={h}
                style={[styles.durationOption, durationHours === h && styles.durationOptionSelected]}
                onPress={() => setDurationHours(h)}
              >
                <Text style={[styles.durationText, durationHours === h && styles.durationTextSelected]}>
                  {formatDuration(h)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Fee Info */}
        {auctionInfo && (
          <View style={styles.feeInfo}>
            <IconSymbol name="info.circle" size={14} color={theme.colors.textMuted} />
            <Text style={styles.feeInfoText}>
              Platform fee: {auctionInfo.platform_fee_percent}% of sale price
            </Text>
          </View>
        )}

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitButton, (isSubmitting || isCreating || !startingPrice) && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isSubmitting || isCreating || !startingPrice}
        >
          {isSubmitting || isCreating ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.submitButtonText}>Create Auction</Text>
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
      padding: Skin.space(16),
      alignItems: 'center',
      marginBottom: Skin.space(20),
    },
    nameLabel: {
      fontSize: Skin.font(24),
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
    durationSelector: { flexDirection: 'row', gap: Skin.space(8) },
    durationOption: {
      flex: 1,
      paddingVertical: Skin.space(10),
      borderRadius: Skin.radius(8),
      backgroundColor: theme.colors.surface2,
      alignItems: 'center',
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    durationOptionSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: isDark ? 'theme.colors.accentSoft' : 'theme.colors.accentSubtle',
    },
    durationText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
    durationTextSelected: {
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
    feeInfoText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
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
