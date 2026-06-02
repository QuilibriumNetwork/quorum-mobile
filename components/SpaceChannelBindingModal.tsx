import { BaseModal } from '@/components/shared';
import SpaceChannelBindingPicker from '@/components/SpaceChannelBindingPicker';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface SpaceChannelBindingModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
}

export default function SpaceChannelBindingModal({
  visible,
  onClose,
  spaceId,
}: SpaceChannelBindingModalProps) {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.85} avoidKeyboard>
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Linked Farcaster channels</Text>
          <TouchableOpacity onPress={onClose}>
            <IconSymbol name="xmark" size={20} color={theme.colors.textMuted} />
          </TouchableOpacity>
        </View>
        <SpaceChannelBindingPicker spaceId={spaceId} enabled={visible} />
      </ScrollView>
    </BaseModal>
  );
}

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(20),
      paddingBottom: Skin.space(40),
      gap: Skin.space(12),
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    title: {
      fontSize: Skin.font(18),
      fontWeight: '700',
      color: theme.colors.textStrong,
    },
  });
}
