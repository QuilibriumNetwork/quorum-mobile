/**
 * NFTDetailModal - Full-screen NFT detail view
 */

import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import type { NFT } from '@/services/wallet/balanceService';
import { useTheme, type AppTheme } from '@/theme';
import { truncateAddress } from '@/utils/formatAddress';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import React from 'react';
import { Alert, Dimensions, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface NFTDetailModalProps {
  visible: boolean;
  onClose: () => void;
  nft: NFT | null;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function NFTDetailModal({ visible, onClose, nft }: NFTDetailModalProps) {
  const { theme, isDark } = useTheme();
  const styles = createStyles(theme, isDark);

  if (!nft) return null;

  const getChainColor = (chain: string): string => {
    switch (chain) {
      case 'ethereum': return '#627EEA';
      case 'base': return '#0052FF';
      case 'arbitrum': return '#28A0F0';
      case 'optimism': return '#FF0420';
      case 'polygon': return '#8247E5';
      case 'zora': return '#5B5BD6';
      default: return theme.colors.primary;
    }
  };

  const getExplorerUrl = (chain: string, contractAddress: string, tokenId: string): string => {
    const explorers: Record<string, string> = {
      ethereum: 'https://etherscan.io/nft',
      base: 'https://basescan.org/nft',
      arbitrum: 'https://arbiscan.io/nft',
      optimism: 'https://optimistic.etherscan.io/nft',
      polygon: 'https://polygonscan.com/nft',
      zora: 'https://explorer.zora.energy/token',
    };
    const baseUrl = explorers[chain] || explorers.ethereum;
    return `${baseUrl}/${contractAddress}/${tokenId}`;
  };

  const copyToClipboard = async (text: string, label: string) => {
    await Clipboard.setStringAsync(text);
    Alert.alert('Copied', `${label} copied to clipboard`);
  };

  const openExplorer = () => {
    const url = getExplorerUrl(nft.chain, nft.contractAddress, nft.tokenId);
    Linking.openURL(url);
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.9}>
      <View style={styles.header}>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.content}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.contentContainer}
      >
        {/* NFT Image */}
        <View style={styles.imageContainer}>
          {nft.imageUrl || nft.thumbnailUrl ? (
            <Image
              source={{ uri: nft.imageUrl || nft.thumbnailUrl }}
              style={styles.image}
              resizeMode="contain"
            />
          ) : (
            <View style={[styles.image, styles.imagePlaceholder]}>
              <IconSymbol name="photo" size={64} color={theme.colors.textMuted} />
            </View>
          )}
        </View>

        {/* NFT Info */}
        <View style={styles.infoSection}>
          {/* Name */}
          <Text style={styles.nftName}>{nft.name}</Text>

          {/* Collection */}
          {nft.collectionName && (
            <View style={styles.collectionRow}>
              <Text style={styles.collectionLabel}>Collection</Text>
              <Text style={styles.collectionName}>{nft.collectionName}</Text>
            </View>
          )}

          {/* Chain Badge */}
          <View style={styles.chainRow}>
            <View style={[styles.chainBadge, { backgroundColor: getChainColor(nft.chain) + '20' }]}>
              <View style={[styles.chainDot, { backgroundColor: getChainColor(nft.chain) }]} />
              <Text style={[styles.chainText, { color: getChainColor(nft.chain) }]}>
                {nft.chainName}
              </Text>
            </View>
          </View>

          {/* Description */}
          {nft.description && (
            <View style={styles.descriptionSection}>
              <Text style={styles.sectionTitle}>Description</Text>
              <Text style={styles.description}>{nft.description}</Text>
            </View>
          )}

          {/* Details */}
          <View style={styles.detailsSection}>
            <Text style={styles.sectionTitle}>Details</Text>

            {/* Contract Address */}
            <TouchableOpacity
              style={styles.detailRow}
              onPress={() => copyToClipboard(nft.contractAddress, 'Contract address')}
            >
              <Text style={styles.detailLabel}>Contract</Text>
              <View style={styles.detailValueRow}>
                <Text style={styles.detailValue}>{truncateAddress(nft.contractAddress)}</Text>
                <IconSymbol name="doc.on.doc" size={14} color={theme.colors.textMuted} />
              </View>
            </TouchableOpacity>

            {/* Token ID */}
            <TouchableOpacity
              style={styles.detailRow}
              onPress={() => copyToClipboard(nft.tokenId, 'Token ID')}
            >
              <Text style={styles.detailLabel}>Token ID</Text>
              <View style={styles.detailValueRow}>
                <Text style={styles.detailValue} numberOfLines={1}>
                  {(nft.tokenId?.length || 0) > 12 ? truncateAddress(nft.tokenId) : nft.tokenId || 'Unknown'}
                </Text>
                <IconSymbol name="doc.on.doc" size={14} color={theme.colors.textMuted} />
              </View>
            </TouchableOpacity>

            {/* Token Standard */}
            {nft.tokenType && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Standard</Text>
                <Text style={styles.detailValue}>{nft.tokenType}</Text>
              </View>
            )}
          </View>

          {/* View on Explorer Button */}
          <TouchableOpacity style={styles.explorerButton} onPress={openExplorer}>
            <IconSymbol name="arrow.up.right.square" size={18} color={theme.colors.primary} />
            <Text style={styles.explorerButtonText}>View on Explorer</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, isDark: boolean) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(8),
    },
    closeButton: {
      padding: Skin.space(4),
    },
    content: {
      flex: 1,
    },
    contentContainer: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(40),
    },
    imageContainer: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: Skin.radius(16),
      overflow: 'hidden',
      backgroundColor: theme.colors.surface2,
      marginBottom: Skin.space(20),
    },
    image: {
      width: '100%',
      height: '100%',
    },
    imagePlaceholder: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface1,
    },
    infoSection: {
      gap: Skin.space(16),
    },
    nftName: {
      fontSize: Skin.font(24),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
    collectionRow: {
      gap: Skin.space(4),
    },
    collectionLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    collectionName: {
      fontSize: Skin.font(16),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    chainRow: {
      flexDirection: 'row',
    },
    chainBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(16),
      gap: Skin.space(6),
    },
    chainDot: {
      width: 8,
      height: 8,
      borderRadius: Skin.radius(4),
    },
    chainText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    descriptionSection: {
      gap: Skin.space(8),
      paddingTop: Skin.space(8),
    },
    sectionTitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    description: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      lineHeight: Skin.font(20),
    },
    detailsSection: {
      gap: Skin.space(12),
      paddingTop: Skin.space(8),
    },
    detailRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      backgroundColor: theme.colors.surface2,
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
    },
    detailLabel: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
    },
    detailValueRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
    },
    detailValue: {
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
    explorerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
      paddingVertical: Skin.space(14),
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.primary,
      marginTop: Skin.space(8),
    },
    explorerButtonText: {
      fontSize: Skin.font(15),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
  });
