/**
 * ActionSheet — reusable themed bottom sheet for contextual actions.
 *
 * Drop-in replacement for ActionSheetIOS / Alert.alert that:
 *   - Matches the app's dark/light theme
 *   - Renders consistently on iOS and Android
 *   - Supports an optional icon per action
 *   - Marks destructive actions in red
 *
 * Dismissed by tapping the backdrop or swiping down (inherited from BaseModal);
 * there is no separate Cancel row, matching the rest of the app's sheets.
 *
 * @example
 *   <ActionSheet
 *     visible={visible}
 *     onClose={() => setVisible(false)}
 *     title="Asset"
 *     message="0.5 ETH"
 *     actions={[
 *       { label: 'Send', icon: 'arrow.up.right', onPress: handleSend },
 *       { label: 'Delete', icon: 'trash', onPress: handleDelete, destructive: true },
 *     ]}
 *   />
 */

import React, { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { BaseModal } from '@/components/shared/BaseModal';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { textStyles, useTheme, type AppTheme } from '@/theme';
import { haptics } from '@/utils/haptics';
import * as Skin from '@/theme/skins/geometry';

export interface ActionSheetAction {
  label: string;
  icon?: string;
  /** Runs after the sheet animates closed */
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  /** Optional title shown at the top in bold */
  title?: string;
  /** Optional secondary message under the title */
  message?: string;
  /** List of tappable actions — rendered vertically */
  actions: ActionSheetAction[];
}

export function ActionSheet({
  visible,
  onClose,
  title,
  message,
  actions,
}: ActionSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const handleActionPress = useCallback(
    (action: ActionSheetAction) => {
      if (action.disabled) return;
      haptics.selection();
      // Close first so the user sees the sheet dismiss, then run the action
      // on next tick. Prevents visual awkwardness when the action opens
      // another modal.
      onClose();
      setTimeout(() => action.onPress(), 120);
    },
    [onClose],
  );

  return (
    <BaseModal visible={visible} onClose={onClose} showHandle>
      <View style={styles.container}>
        {(title || message) && (
          <View style={styles.header}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {message ? <Text style={styles.message}>{message}</Text> : null}
          </View>
        )}

        <View style={styles.actions}>
          {actions.map((action, index) => {
            const isLast = index === actions.length - 1;
            const color = action.disabled
              ? theme.colors.textMuted
              : action.destructive
                ? theme.colors.danger
                : theme.colors.textMain;
            return (
              <TouchableOpacity
                key={`${action.label}-${index}`}
                style={[styles.actionRow, isLast && styles.actionRowLast]}
                onPress={() => handleActionPress(action)}
                activeOpacity={0.6}
                disabled={action.disabled}
              >
                {action.icon ? (
                  // icon name is validated by IconSymbol's mapping at runtime;
                  // the strict union type is too narrow for a generic wrapper.
                  <IconSymbol name={action.icon as IconSymbolName} size={20} color={color} />
                ) : (
                  <View style={styles.iconSpacer} />
                )}
                <Text style={[styles.actionLabel, { color }]}>
                  {action.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(12),
      paddingBottom: Skin.space(8),
    },
    header: {
      alignItems: 'center',
      paddingHorizontal: Skin.space(8),
      paddingTop: Skin.space(4),
      paddingBottom: Skin.space(14),
    },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    message: {
      ...theme.textStyles.subheadline,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(2),
    },
    actions: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(14),
      overflow: 'hidden',
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(14),
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(14),
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.surface4,
    },
    actionRowLast: {
      borderBottomWidth: 0,
    },
    iconSpacer: {
      width: 20,
    },
    actionLabel: {
      ...theme.textStyles.body,
      flex: 1,
    },
  });
