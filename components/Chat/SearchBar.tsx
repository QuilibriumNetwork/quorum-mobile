import type { AppTheme } from '@/theme';
import React, { useRef, useEffect } from 'react';
import { StyleSheet, TextInput, View, Text } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import * as Skin from '@/theme/skins/geometry';

interface SearchBarProps {
  query: string;
  onChangeQuery: (text: string) => void;
  onClose: () => void;
  resultCount: number;
  onNavigateToResult?: (index: number) => void;
  theme: AppTheme;
}

export const SearchBar = React.memo(function SearchBar({
  query,
  onChangeQuery,
  onClose,
  resultCount,
  theme,
}: SearchBarProps) {
  const inputRef = useRef<TextInput>(null);
  const styles = createStyles(theme);

  useEffect(() => {
    // Auto-focus when mounted
    const timer = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
        <IconSymbol name="magnifyingglass" color={theme.colors.textMuted} size={16} />
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={query}
          onChangeText={onChangeQuery}
          placeholder="Search messages..."
          placeholderTextColor={theme.colors.textMuted}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <Text style={styles.resultCount}>
            {resultCount} {resultCount === 1 ? 'result' : 'results'}
          </Text>
        )}
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <IconSymbol name="xmark" color={theme.colors.textMuted} size={16} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

const createStyles = (theme: AppTheme) => StyleSheet.create({
  container: {
    backgroundColor: theme.colors.surface3,
    borderBottomWidth: Skin.border(1),
    borderBottomColor: theme.colors.border,
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(8),
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.colors.surface5,
    borderRadius: Skin.radius(8),
    paddingHorizontal: Skin.space(10),
    paddingVertical: Skin.space(6),
  },
  input: {
    flex: 1,
    color: theme.colors.textMain,
    fontSize: Skin.font(14),
    marginLeft: Skin.space(8),
    fontFamily: theme.fonts.regular.fontFamily,
    paddingVertical: Skin.space(2),
  },
  resultCount: {
    color: theme.colors.textSubtle,
    fontSize: Skin.font(12),
    marginRight: Skin.space(8),
    fontFamily: theme.fonts.regular.fontFamily,
  },
  closeButton: {
    padding: Skin.space(4),
  },
});

export default SearchBar;
