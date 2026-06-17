/**
 * ChannelIconPickerSheet — channel/group icon picker on the SHARED vocabulary.
 *
 * Stores a named color TOKEN (e.g. 'blue') + an iconVariant, NOT raw hex, so
 * icons render consistently across mobile and desktop. Resolve to hex at render
 * via getIconColorHex(). Replaces the legacy components/ui/IconPicker.tsx (which
 * used SF-Symbol names + raw-hex colors and didn't render cross-platform).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ICON_OPTIONS,
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
// reorder this freely (the layout wraps to any count). Rainbow order, neutral first.
const PICKER_COLORS: IconColor[] = [
  'default', 'red', 'orange', 'yellow', 'green', 'teal', 'sky', 'blue', 'indigo', 'purple', 'fuchsia', 'pink',
];

const DEFAULT_ICON: IconSymbolName = 'hashtag' as IconSymbolName;

type IconVariant = 'outline' | 'filled';

interface ChannelIconPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedIcon?: string;
  selectedColor?: IconColor;
  selectedVariant?: IconVariant;
  onSelect: (icon: string, color: IconColor, variant: IconVariant) => void;
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
  const [pickedVariant, setPickedVariant] = useState<IconVariant>(selectedVariant || 'outline');

  // Re-sync from props each time the sheet opens, so reopening for a different
  // channel/group (or after an edit) shows that item's current icon/color/variant
  // rather than the last-picked values (state persists across open/close).
  useEffect(() => {
    if (!visible) return;
    setPickedIcon(selectedIcon || (DEFAULT_ICON as string));
    setPickedColor(selectedColor || 'default');
    setPickedVariant(selectedVariant || 'outline');
  }, [visible, selectedIcon, selectedColor, selectedVariant]);

  // The whole grid renders in the selected variant, and the FILLED tab shows
  // only icons that actually have a filled form (matches desktop's picker — a
  // clean single-style list, never a mixed outline/filled jumble).
  const filteredIcons = useMemo(
    () =>
      pickedVariant === 'filled'
        ? ICON_OPTIONS.filter((opt) => FILLED_ICONS.has(opt.name as never))
        : ICON_OPTIONS,
    [pickedVariant]
  );

  const previewHex = getIconColorHex(pickedColor);

  // Pick black/white text for contrast against the chosen swatch color.
  const applyTextColor = (() => {
    const h = previewHex.replace('#', '');
    if (h.length < 6) return '#fff';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? '#1a1a1a' : '#fff';
  })();

  const handleConfirm = () => {
    onSelect(pickedIcon, pickedColor, pickedVariant);
    onClose();
  };

  const handleClear = () => {
    setPickedVariant('outline');
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
              variant={pickedVariant}
            />
          </View>
        </View>

        {/* Variant toggle — switches the whole grid between outline and filled
            (filled shows only icons that have a filled form). */}
        <View style={styles.variantRow}>
          {(['outline', 'filled'] as const).map((v) => {
            const active = pickedVariant === v;
            return (
              <TouchableOpacity
                key={v}
                style={[styles.variantChip, active && styles.variantChipActive]}
                onPress={() => setPickedVariant(v)}
                accessibilityLabel={v === 'outline' ? 'Outline icons' : 'Filled icons'}
                accessibilityState={{ selected: active }}
              >
                <IconSymbol
                  name="circle"
                  size={16}
                  color={active ? theme.colors.primary : theme.colors.textMuted}
                  variant={v}
                />
                <Text style={[styles.variantChipText, active && styles.variantChipTextActive]}>
                  {v === 'outline' ? 'Outline' : 'Filled'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Icon grid */}
        <Text style={styles.sectionLabel}>Icon</Text>
        <ScrollView style={styles.iconGrid} showsVerticalScrollIndicator={false} nestedScrollEnabled>
          <View style={styles.gridRow}>
            {filteredIcons.map((opt) => {
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
                    variant={pickedVariant}
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
                hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
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
            <Text style={[styles.confirmButtonText, { color: applyTextColor }]}>Apply</Text>
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
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface3,
    },
    variantChipActive: {
      backgroundColor: theme.colors.surface5,
      borderWidth: Skin.border(1),
      borderColor: theme.colors.primary,
    },
    variantChipText: { ...theme.textStyles.footnote, color: theme.colors.textMuted },
    variantChipTextActive: { color: theme.colors.textStrong },
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
