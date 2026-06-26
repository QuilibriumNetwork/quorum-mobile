/**
 * ChannelManagerRolePickerSheet — multi-select roles that may manage a
 * read-only channel. Writes channel.managerRoleIds (roleId values). Mirrors how
 * the shared canManageReadOnlyChannel enforcement READS managerRoleIds: a user
 * may post, delete, and pin messages iff one of these roles lists them as a
 * member. Do NOT widen this.
 */
import React, { useState, useEffect } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Role } from '@quilibrium/quorum-shared';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

interface ChannelManagerRolePickerSheetProps {
  visible: boolean;
  onClose: () => void;
  roles: Role[];
  selectedRoleIds: string[];
  onConfirm: (roleIds: string[]) => void;
}

export function ChannelManagerRolePickerSheet({
  visible,
  onClose,
  roles,
  selectedRoleIds,
  onConfirm,
}: ChannelManagerRolePickerSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [picked, setPicked] = useState<Set<string>>(new Set(selectedRoleIds));

  // Re-sync when reopened with a different selection.
  useEffect(() => {
    if (visible) setPicked(new Set(selectedRoleIds));
  }, [visible, selectedRoleIds]);

  // Auto-save on each tap (consistent with the rest of the drawer — no Done
  // button). Compute the next set, update local state for the checkmarks, and
  // commit it immediately via onConfirm.
  const toggle = (roleId: string) => {
    const next = new Set(picked);
    if (next.has(roleId)) next.delete(roleId);
    else next.add(roleId);
    setPicked(next);
    onConfirm(Array.from(next));
  };

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.6} showHandle>
      <View style={styles.container}>
        <Text style={styles.title}>Channel Managers</Text>
        <Text style={styles.subtitle}>Members of selected roles can post, delete, and pin messages in this read-only channel.</Text>

        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          <ActionRowGroup>
            {roles.length === 0 ? (
              <ActionRow label="No roles in this space yet" disabled />
            ) : (
              roles.map((role) => {
                const isPicked = picked.has(role.roleId);
                return (
                  <ActionRow
                    key={role.roleId}
                    label={role.displayName}
                    leading={<View style={[styles.dot, { backgroundColor: role.color }]} />}
                    trailing={
                      <IconSymbol
                        name={isPicked ? 'checkmark.circle.fill' : 'circle'}
                        size={22}
                        color={isPicked ? theme.colors.primary : theme.colors.textMuted}
                      />
                    }
                    onPress={() => toggle(role.roleId)}
                  />
                );
              })
            )}
          </ActionRowGroup>
        </ScrollView>
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(16), paddingTop: Skin.space(8), flex: 1 },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(4),
    },
    subtitle: {
      ...theme.textStyles.footnote,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginBottom: Skin.space(14),
    },
    list: { flex: 1, marginBottom: Skin.space(12) },
    dot: { width: 12, height: 12, borderRadius: Skin.radius(6) },
  });
