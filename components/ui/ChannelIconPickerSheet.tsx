/**
 * ChannelIconPickerSheet — channel/group icon picker on the SHARED vocabulary.
 *
 * Stores a named color TOKEN (e.g. 'blue') + an iconVariant, NOT raw hex, so
 * icons render consistently across mobile and desktop. Resolve to hex at render
 * via getIconColorHex(). Replaces the legacy components/ui/IconPicker.tsx (which
 * used SF-Symbol names + raw-hex colors and didn't render cross-platform).
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ICON_OPTIONS,
  ICON_COLORS,
  FILLED_ICONS,
  getIconColorHex,
  type IconColor,
} from '@quilibrium/quorum-shared';
import { BaseModal } from '@/components/shared';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

// Single source of truth for which color swatches the picker offers. Trim or
// reorder this freely (the layout wraps to any count). Currently: all 12 tokens.
const PICKER_COLORS: IconColor[] = ICON_COLORS.map((c) => c.value);

const DEFAULT_ICON: IconSymbolName = 'hashtag' as IconSymbolName;

interface ChannelIconPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedIcon?: string;
  selectedColor?: IconColor;
  selectedVariant?: 'outline' | 'filled';
  onSelect: (icon: string, color: IconColor, variant: 'outline' | 'filled') => void;
  onClear: () => void;
}

export function ChannelIconPickerSheet({
  visible,
  onClose,
  selectedIcon,
  selectedColor,
  selectedVariant,
  onSelect,
  onClear,
}: ChannelIconPickerSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [pickedIcon, setPickedIcon] = useState<string>(selectedIcon || (DEFAULT_ICON as string));
  const [pickedColor, setPickedColor] = useState<IconColor>(selectedColor || 'default');
  const [pickedVariant, setPickedVariant] = useState<'outline' | 'filled'>(
    selectedVariant || 'outline'
  );

  const hasFilled = FILLED_ICONS.has(pickedIcon as never);
  const effectiveVariant = hasFilled ? pickedVariant : 'outline';
  const previewHex = getIconColorHex(pickedColor);

  const handleConfirm = () => {
    onSelect(pickedIcon, pickedColor, effectiveVariant);
    onClose();
  };

  const handleClear = () => {
    onClear();
    onClose();
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.7} showHandle>
      <View style={styles.container}>
        <Text style={styles.title}>Icon</Text>

        {/* Preview */}
        <View style={styles.previewContainer}>
          <View style={[styles.previewCircle, { backgroundColor: previewHex + '20' }]}>
            <IconSymbol
              name={pickedIcon as IconSymbolName}
              size={28}
              color={previewHex}
              variant={effectiveVariant}
            />
          </View>
        </View>

        {/* Variant toggle — only when the picked icon has a filled form */}
        {hasFilled && (
          <View style={styles.variantRow}>
            {(['outline', 'filled'] as const).map((v) => (
              <TouchableOpacity
                key={v}
                style={[styles.variantChip, pickedVariant === v && styles.variantChipActive]}
                onPress={() => setPickedVariant(v)}
              >
                <Text
                  style={[
                    styles.variantChipText,
                    pickedVariant === v && styles.variantChipTextActive,
                  ]}
                >
                  {v === 'outline' ? 'Outline' : 'Filled'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Icon grid */}
        <Text style={styles.sectionLabel}>Icon</Text>
        <ScrollView style={styles.iconGrid} showsVerticalScrollIndicator={false}>
          <View style={styles.gridRow}>
            {ICON_OPTIONS.map((opt) => {
              const active = pickedIcon === opt.name;
              return (
                <TouchableOpacity
                  key={opt.name}
                  style={[
                    styles.iconCell,
                    active && { backgroundColor: previewHex + '20', borderColor: previewHex },
                  ]}
                  onPress={() => setPickedIcon(opt.name)}
                  accessibilityLabel={opt.category}
                >
                  <IconSymbol
                    name={opt.name as IconSymbolName}
                    size={20}
                    color={active ? previewHex : theme.colors.textMuted}
                    variant={
                      active && FILLED_ICONS.has(opt.name as never) ? pickedVariant : 'outline'
                    }
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {/* Color row (wraps to any count) */}
        <Text style={styles.sectionLabel}>Color</Text>
        <View style={styles.colorRow}>
          {PICKER_COLORS.map((token) => {
            const hex = getIconColorHex(token);
            return (
              <TouchableOpacity
                key={token}
                style={[
                  styles.colorSwatch,
                  { backgroundColor: hex },
                  pickedColor === token && styles.colorSwatchActive,
                ]}
                onPress={() => setPickedColor(token)}
                accessibilityLabel={token}
              />
            );
          })}
        </View>

        {/* Actions */}
        <View style={styles.actions}>
          <TouchableOpacity style={styles.clearButton} onPress={handleClear}>
            <Text style={styles.clearButtonText}>Reset</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmButton, { backgroundColor: previewHex }]}
            onPress={handleConfirm}
          >
            <Text style={styles.confirmButtonText}>Apply</Text>
          </TouchableOpacity>
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(20), paddingTop: Skin.space(8), flex: 1 },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(12),
    },
    previewContainer: { alignItems: 'center', marginBottom: Skin.space(12) },
    previewCircle: {
      width: 56,
      height: 56,
      borderRadius: Skin.radius(28),
      alignItems: 'center',
      justifyContent: 'center',
    },
    variantRow: {
      flexDirection: 'row',
      gap: Skin.space(8),
      justifyContent: 'center',
      marginBottom: Skin.space(14),
    },
    variantChip: {
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface3,
    },
    variantChipActive: { backgroundColor: theme.colors.primary },
    variantChipText: { ...theme.textStyles.footnote, color: theme.colors.textMuted },
    variantChipTextActive: { color: '#fff' },
    sectionLabel: {
      ...theme.textStyles.footnote,
      color: theme.colors.textMuted,
      letterSpacing: 0.5,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
    },
    iconGrid: { maxHeight: 200, marginBottom: Skin.space(16) },
    gridRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Skin.space(8) },
    iconCell: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: Skin.border(2),
      borderColor: 'transparent',
    },
    colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Skin.space(10), marginBottom: Skin.space(20) },
    colorSwatch: { width: 32, height: 32, borderRadius: Skin.radius(16) },
    colorSwatchActive: {
      borderWidth: Skin.border(3),
      borderColor: '#fff',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 3,
      elevation: 4,
    },
    actions: { flexDirection: 'row', gap: Skin.space(12), paddingBottom: Skin.space(8) },
    clearButton: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      backgroundColor: theme.colors.surface3,
      alignItems: 'center',
    },
    clearButtonText: { ...theme.textStyles.body, color: theme.colors.textMain },
    confirmButton: {
      flex: 1,
      paddingVertical: Skin.space(12),
      borderRadius: Skin.radius(10),
      alignItems: 'center',
    },
    confirmButtonText: { ...theme.textStyles.body, color: '#fff' },
  });
