/**
 * MnemonicDisplayView - Shows generated mnemonic for backup
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, Share } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import { useTheme, type AppTheme } from '@/theme';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';

interface MnemonicDisplayViewProps {
  mnemonic: string[];
  address?: string;
  onConfirm: () => void;
  onBack: () => void;
}

export function MnemonicDisplayView({
  mnemonic,
  address,
  onConfirm,
  onBack,
}: MnemonicDisplayViewProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(mnemonic.join(' '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.iconContainer}>
          <IconSymbol name="lock.shield.fill" size={32} color={theme.colors.warning ?? theme.colors.primary} />
        </View>
        <Text style={styles.title}>Save Your Recovery Phrase</Text>
        <Text style={styles.subtitle}>
          Write down these 24 words in order and store them in a safe place.
          You will need them to recover your account.
        </Text>
      </View>

      {address && (
        <View style={styles.addressContainer}>
          <Text style={styles.addressLabel}>Your Address</Text>
          <Text style={styles.address} selectable>{address}</Text>
        </View>
      )}

      <Card variant="bordered" style={styles.mnemonicCard}>
        <View style={styles.mnemonicHeader}>
          <Text style={styles.mnemonicTitle}>Recovery Phrase</Text>
          <TouchableOpacity onPress={() => setRevealed(!revealed)}>
            <IconSymbol
              name={revealed ? 'eye.slash.fill' : 'eye.fill'}
              size={20}
              color={theme.colors.textMuted}
            />
          </TouchableOpacity>
        </View>

        <View style={styles.wordGrid}>
          {mnemonic.map((word, index) => (
            <View key={index} style={styles.wordItem}>
              <Text style={styles.wordNumber}>{index + 1}</Text>
              <Text style={[styles.word, !revealed && styles.wordHidden]}>
                {revealed ? word : '••••••'}
              </Text>
            </View>
          ))}
        </View>

        <TouchableOpacity style={styles.copyButton} onPress={handleCopy}>
          <IconSymbol
            name={copied ? 'checkmark' : 'doc.on.doc'}
            size={16}
            color={theme.colors.primary}
          />
          <Text style={styles.copyText}>
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </Text>
        </TouchableOpacity>
      </Card>

      <View style={styles.warning}>
        <IconSymbol name="exclamationmark.triangle.fill" size={20} color={theme.colors.warning ?? '#f59e0b'} />
        <Text style={styles.warningText}>
          Never share your recovery phrase. Anyone with these words can access your account.
        </Text>
      </View>

      <View style={styles.buttons}>
        <Button variant="secondary" onPress={onBack} style={styles.backButton}>
          Back
        </Button>
        <Button variant="primary" onPress={onConfirm} style={styles.confirmButton}>
          I've Saved It
        </Button>
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(32),
      backgroundColor: (theme.colors.warning ?? '#f59e0b') + '20',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(24),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      textAlign: 'center',
      marginBottom: Skin.space(8),
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    addressContainer: {
      alignItems: 'center',
      marginBottom: Skin.space(16),
    },
    addressLabel: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      marginBottom: Skin.space(4),
    },
    address: {
      fontSize: Skin.font(11),
      color: theme.colors.primary,
      fontFamily: 'Courier',
      fontWeight: 'bold',
    },
    mnemonicCard: {
      padding: Skin.space(16),
      marginBottom: Skin.space(16),
    },
    mnemonicHeader: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: Skin.space(16),
    },
    mnemonicTitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.medium.fontFamily,
    },
    wordGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: Skin.space(8),
    },
    wordItem: {
      width: '32%',
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(8),
      paddingVertical: Skin.space(8),
      paddingHorizontal: Skin.space(8),
    },
    wordNumber: {
      fontSize: Skin.font(10),
      color: theme.colors.textSubtle,
      fontFamily: theme.fonts.regular.fontFamily,
      width: 16,
    },
    word: {
      fontSize: Skin.font(12),
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      flex: 1,
    },
    wordHidden: {
      color: theme.colors.textMuted,
    },
    copyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: Skin.space(16),
      paddingVertical: Skin.space(8),
    },
    copyText: {
      fontSize: Skin.font(14),
      color: theme.colors.primary,
      fontFamily: theme.fonts.medium.fontFamily,
      marginLeft: Skin.space(8),
    },
    warning: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: (theme.colors.warning ?? '#f59e0b') + '15',
      borderRadius: Skin.radius(12),
      padding: Skin.space(16),
      marginBottom: Skin.space(24),
    },
    warningText: {
      flex: 1,
      fontSize: Skin.font(14),
      color: theme.colors.textMain,
      fontFamily: theme.fonts.regular.fontFamily,
      marginLeft: Skin.space(12),
      lineHeight: Skin.font(20),
    },
    buttons: {
      flexDirection: 'row',
      gap: Skin.space(12),
      marginTop: 'auto',
    },
    backButton: {
      flex: 1,
    },
    confirmButton: {
      flex: 2,
    },
  });

export default MnemonicDisplayView;
