import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { setProfileSplitMode } from '@/services/profile/profilePrefs';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface ProfileSplitModeModalProps {
  visible: boolean;
  onClose: () => void;
  /** Called after the user makes a choice (after the flag is persisted). */
  onDecision?: (split: boolean) => void;
}

export default function ProfileSplitModeModal({
  visible,
  onClose,
  onDecision,
}: ProfileSplitModeModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const choose = (split: boolean) => {
    setProfileSplitMode(split);
    onDecision?.(split);
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.6} showHandle>
      <View style={styles.container}>
        <Text style={styles.title}>Keep profiles separate?</Text>
        <Text style={styles.subtitle}>
          You can manage your Quorum and Farcaster profiles independently, or
          treat them as one. Fname and QNS usernames always stay in their own
          system.
        </Text>

        <TouchableOpacity style={styles.option} onPress={() => choose(true)} activeOpacity={0.7}>
          <View style={styles.optionIcon}>
            <IconSymbol name="rectangle.grid.2x2" size={22} color={theme.colors.accent} />
          </View>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionTitle}>Keep separate</Text>
            <Text style={styles.optionDesc}>
              Keep a different name, avatar, and bio for each. You pick which one
              you&apos;re editing each time.
            </Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity style={styles.option} onPress={() => choose(false)} activeOpacity={0.7}>
          <View style={styles.optionIcon}>
            <IconSymbol name="merge" size={22} color={theme.colors.accent} />
          </View>
          <View style={styles.optionTextWrap}>
            <Text style={styles.optionTitle}>Merge</Text>
            <Text style={styles.optionDesc}>
              Your name, avatar, and bio are made the same on both, and editing
              updates both at once. Usernames stay separate.
            </Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.footer}>You can change this any time from the Farcaster section of your profile.</Text>
      </View>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(24),
      gap: Skin.space(16),
    },
    title: {
      fontSize: Skin.font(22),
      fontWeight: '700',
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginTop: Skin.space(8),
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
    optionIcon: {
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
