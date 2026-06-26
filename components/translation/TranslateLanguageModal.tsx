/**
 * TranslateLanguageModal — "Translate to…" picker. Lets the user override the
 * device language used as the translation target. Selecting "Device default"
 * clears the override (stored as ''), so the app follows the device language.
 *
 * The value is read/written reactively via MMKV so visible casts/messages
 * re-evaluate their translation toggle the moment it changes.
 */

import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useMMKVString } from 'react-native-mmkv';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import {
  translationPrefsStore,
  K_TARGET_LANGUAGE,
  deviceLanguage,
} from '@/services/translation/translationPrefs';
import { TRANSLATE_LANGUAGES, languageName } from './languages';

export function TranslateLanguageModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { theme } = useTheme();
  const s = styles(theme);
  const [stored, setStored] = useMMKVString(K_TARGET_LANGUAGE, translationPrefsStore);
  const effective = stored && stored.length > 0 ? stored : '';

  const select = (code: string) => {
    setStored(code);
    onClose();
  };

  const device = deviceLanguage();

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7}>
      <ScrollView contentContainerStyle={{ paddingBottom: Skin.space(32) }}>
        <Text style={s.title}>Translate to</Text>
        <Text style={s.subtitle}>
          Posts not in this language show a “See translation” option. Translation runs
          entirely on your device.
        </Text>

        {/* Device default */}
        <TouchableOpacity style={s.row} onPress={() => select('')}>
          <View style={s.rowLeft}>
            <Text style={s.rowLabel}>Device default</Text>
            <Text style={s.rowDescription}>{languageName(device)}</Text>
          </View>
          {effective === '' && (
            <IconSymbol name="checkmark" size={18} color={theme.colors.accent} />
          )}
        </TouchableOpacity>

        {TRANSLATE_LANGUAGES.map((lang) => (
          <TouchableOpacity key={lang.code} style={s.row} onPress={() => select(lang.code)}>
            <Text style={s.rowLabel}>{lang.name}</Text>
            {effective === lang.code && (
              <IconSymbol name="checkmark" size={18} color={theme.colors.accent} />
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>
    </BaseModal>
  );
}

const styles = (theme: AppTheme) =>
  StyleSheet.create({
    title: {
      ...theme.textStyles.title3,
      color: theme.colors.textMain,
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(8),
    },
    subtitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      paddingHorizontal: Skin.space(20),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(12),
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: Skin.space(20),
      paddingVertical: Skin.space(14),
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.colors.border,
    },
    rowLeft: {
      flex: 1,
    },
    rowLabel: {
      ...theme.textStyles.body,
      color: theme.colors.textMain,
    },
    rowDescription: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      marginTop: Skin.space(2),
    },
  });

export default TranslateLanguageModal;
