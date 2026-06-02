import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { setHypersnapOptInChoice } from '@/services/farcaster/hypersnapOptIn';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface HypersnapSignerPromptModalProps {
  visible: boolean;
  onClose: () => void;
  /** Fired after the user makes a choice and the preference is persisted. */
  onDecision?: (optedIn: boolean) => void;
}

export default function HypersnapSignerPromptModal({
  visible,
  onClose,
  onDecision,
}: HypersnapSignerPromptModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const choose = (optedIn: boolean) => {
    setHypersnapOptInChoice(optedIn ? 'opted-in' : 'opted-out');
    onDecision?.(optedIn);
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} showHandle>
      <View style={styles.container}>
        <View style={styles.heroIcon}>
          <IconSymbol name="sparkles" size={28} color={theme.colors.accent} />
        </View>
        <Text style={styles.title}>Earn $SNAP on Farcaster</Text>
        <Text style={styles.subtitle}>
          Create a Hypersnap signer to post and react through Quilibrium's hub.
          Eligible activity earns $SNAP rewards. You can revoke the signer at
          any time.
        </Text>

        <TouchableOpacity style={styles.optionPrimary} onPress={() => choose(true)} activeOpacity={0.7}>
          <View style={styles.optionIconPrimary}>
            <IconSymbol name="bolt.fill" size={22} color={theme.colors.accent} />
          </View>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionTitle}>Create a Hypersnap signer</Text>
            <Text style={styles.optionDesc}>
              We'll register an Ed25519 signer keyed to your Farcaster account.
              Posts, reactions, and profile edits flow through Hypersnap and
              earn $SNAP. Falls back automatically if Hypersnap is unavailable.
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={styles.option} onPress={() => choose(false)} activeOpacity={0.7}>
          <View style={styles.optionIcon}>
            <IconSymbol name="checkmark" size={22} color={theme.colors.accent} />
          </View>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionTitle}>Use classic Farcaster</Text>
            <Text style={styles.optionDesc}>
              Keep using farcaster.xyz for posts and reactions. No signer is
              created. You can opt in any time from Settings.
            </Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.footer}>You can change this in Settings.</Text>
      </View>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(24),
      gap: Skin.space(14),
    },
    heroIcon: {
      alignSelf: 'center',
      width: 56,
      height: 56,
      borderRadius: Skin.radius(28),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface2,
      marginTop: Skin.space(4),
    },
    title: {
      fontSize: Skin.font(22),
      fontWeight: '700',
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: Skin.font(14),
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: Skin.font(20),
    },
    option: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Skin.space(12),
      padding: Skin.space(14),
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.surface3,
      backgroundColor: theme.colors.surface1,
    },
    optionPrimary: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: Skin.space(12),
      padding: Skin.space(14),
      borderRadius: Skin.radius(12),
      borderWidth: Skin.border(1),
      borderColor: theme.colors.accent,
      backgroundColor: theme.colors.surface1,
    },
    optionIcon: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface2,
    },
    optionIconPrimary: {
      width: 40,
      height: 40,
      borderRadius: Skin.radius(20),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface2,
    },
    optionTextWrap: {
      flex: 1,
      gap: Skin.space(2),
    },
    optionTitle: {
      fontSize: Skin.font(16),
      fontWeight: '600',
      color: theme.colors.textStrong,
    },
    optionDesc: {
      fontSize: Skin.font(13),
      color: theme.colors.textMuted,
      lineHeight: Skin.font(18),
    },
    footer: {
      fontSize: Skin.font(12),
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(4),
    },
  });
}
