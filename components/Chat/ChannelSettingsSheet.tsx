/**
 * ChannelSettingsSheet — per-item settings drawer for a channel OR a channel
 * group, opened from a row tap inside SpaceSettingsModal (owner-only path).
 * Group-aware via the `target` prop. Hosts nested icon + role pickers.
 *
 * Replaces the inline channel/group editing previously scattered across
 * SpaceSettingsModal (editingChannelId / iconPicker* state + handlers).
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { getIconColorHex, type IconColor } from '@quilibrium/quorum-shared';
import {
  useUpdateChannel,
  useDeleteChannel,
  useUpdateGroup,
  useDeleteGroup,
} from '@/hooks/chat';
import { useUpdateSpace } from '@/hooks/chat/useSpaceSettings';
import { useRoles } from '@/hooks/chat/useRoleManagement';
import { getSpace } from '@/services/config/spaceStorage';
import { BaseModal, ActionRow, ActionRowGroup } from '@/components/shared';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { ChannelIconPickerSheet } from '@/components/ui/ChannelIconPickerSheet';
import { ChannelManagerRolePickerSheet } from '@/components/Chat/ChannelManagerRolePickerSheet';
import { useConfirmDialog } from '@/hooks/useConfirmDialog';
import { useTheme, type AppTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';

export type ChannelSettingsTarget =
  | { kind: 'channel'; spaceId: string; groupIndex: number; channelId: string }
  | { kind: 'group'; spaceId: string; groupIndex: number };

interface ChannelSettingsSheetProps {
  visible: boolean;
  target: ChannelSettingsTarget | null;
  onClose: () => void;
  /** Called after a mutation so the parent (SpaceSettingsModal) can reload its space copy. */
  onChanged?: () => void;
}

export function ChannelSettingsSheet({ visible, target, onClose, onChanged }: ChannelSettingsSheetProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const { confirm, confirmDialog } = useConfirmDialog();

  const updateChannel = useUpdateChannel();
  const deleteChannel = useDeleteChannel();
  const updateGroup = useUpdateGroup();
  const deleteGroup = useDeleteGroup();
  const updateSpace = useUpdateSpace();
  const { data: roles = [] } = useRoles(target?.spaceId);

  // Nested-sheet visibility + back-guard
  const [iconPickerVisible, setIconPickerVisible] = useState(false);
  const [rolePickerVisible, setRolePickerVisible] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const childOpen = iconPickerVisible || rolePickerVisible || isConfirming;
  const guardedClose = () => {
    if (childOpen) return;
    onClose();
  };

  // Bump this after every local mutation so `resolved` re-reads storage. Using a
  // counter (not mutation.isSuccess) because isSuccess latches true after the
  // first mutation and would never re-trigger the memo on the 2nd+ edit.
  const [reloadTick, setReloadTick] = useState(0);
  const bumpReload = () => setReloadTick((t) => t + 1);

  // Resolve the live target object fresh from storage (cheap). Returns the
  // space + the channel/group. Re-reads whenever the target, visibility, or
  // reloadTick changes.
  const resolved = useMemo(() => {
    if (!target) return null;
    const space = getSpace(target.spaceId);
    if (!space) return null;
    const group = space.groups[target.groupIndex];
    if (!group) return null;
    if (target.kind === 'group') return { space, group, channel: null };
    const channel = group.channels.find((c) => c.channelId === target.channelId) ?? null;
    return { space, group, channel };
  }, [target, visible, reloadTick]);

  // Local rename buffer
  const [nameDraft, setNameDraft] = useState('');
  useEffect(() => {
    if (!resolved) return;
    setNameDraft(
      target?.kind === 'group' ? resolved.group.groupName : resolved.channel?.channelName ?? ''
    );
  }, [resolved, target?.kind]);

  if (!target || !resolved) {
    return (
      <BaseModal visible={visible} onClose={guardedClose} showHandle height={0.5}>
        <View style={styles.container} />
      </BaseModal>
    );
  }

  const { space, channel } = resolved;
  const isChannel = target.kind === 'channel';

  const afterMutation = () => {
    bumpReload();
    onChanged?.();
  };

  const commitName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    if (isChannel) {
      if (trimmed === channel?.channelName) return;
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, channelName: trimmed });
    } else {
      if (trimmed === resolved.group.groupName) return;
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, groupName: trimmed });
    }
    afterMutation();
  };

  const handleIconSelect = async (icon: string, color: IconColor, variant: 'outline' | 'filled') => {
    if (isChannel) {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon, iconColor: color, iconVariant: variant });
    } else {
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon, iconColor: color, iconVariant: variant });
    }
    afterMutation();
  };

  const handleIconClear = async () => {
    if (isChannel) {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
    } else {
      await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
    }
    afterMutation();
  };

  const handleToggleReadOnly = async (value: boolean) => {
    if (!isChannel) return;
    await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, isReadOnly: value });
    afterMutation();
  };

  const handleManagerRolesConfirm = async (roleIds: string[]) => {
    if (!isChannel) return;
    await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, managerRoleIds: roleIds });
    afterMutation();
  };

  const handleSetDefault = async (value: boolean) => {
    if (!isChannel || !value) return; // only set; can't un-set without choosing another
    await updateSpace.mutateAsync({ spaceId: target.spaceId, defaultChannelId: target.channelId });
    afterMutation();
  };

  const handleDelete = async () => {
    setIsConfirming(true);
    const label = isChannel ? `#${channel?.channelName ?? ''}` : `the "${resolved.group.groupName}" group`;
    const ok = await confirm({
      title: isChannel ? 'Delete Channel' : 'Delete Group',
      message: isChannel
        ? `This permanently deletes ${label} and its messages for everyone.`
        : `This permanently deletes ${label} for everyone. The group must be empty.`,
      confirmLabel: 'Delete',
    });
    setIsConfirming(false);
    if (!ok) return;
    try {
      if (isChannel) {
        await deleteChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId });
      } else {
        await deleteGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex });
      }
      onChanged?.(); // refresh parent; the drawer is closing so no bumpReload needed
      onClose();
    } catch (e) {
      await confirm({
        title: 'Could not delete',
        message:
          isChannel && target.channelId === space.defaultChannelId
            ? 'This is the default channel. Set another channel as default first.'
            : 'Delete failed. ' + (e instanceof Error ? e.message : ''),
        confirmLabel: 'OK',
        cancelLabel: 'Dismiss',
        variant: 'primary',
      });
    }
  };

  const managerNames = (channel?.managerRoleIds ?? [])
    .map((id) => roles.find((r) => r.roleId === id)?.displayName)
    .filter(Boolean)
    .join(', ');
  const activeIconColor = (isChannel ? channel?.iconColor : resolved.group.iconColor) ?? 'default';
  const iconHex = getIconColorHex(activeIconColor as IconColor);

  return (
    <BaseModal visible={visible} onClose={guardedClose} showHandle height={0.8} avoidKeyboard>
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{isChannel ? 'Channel settings' : 'Group settings'}</Text>

        {/* Rename + icon */}
        <View style={styles.renameRow}>
          <TouchableOpacity
            style={[styles.iconPreview, { backgroundColor: iconHex + '20' }]}
            onPress={() => setIconPickerVisible(true)}
            accessibilityLabel="Change icon"
          >
            <IconSymbol
              name={((isChannel ? channel?.icon : resolved.group.icon) || 'hashtag') as IconSymbolName}
              size={20}
              color={iconHex}
              variant={(isChannel ? channel?.iconVariant : resolved.group.iconVariant) ?? 'outline'}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.renameInput}
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={commitName}
            onSubmitEditing={commitName}
            placeholder={isChannel ? 'Channel name' : 'Group name'}
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="done"
          />
        </View>

        {isChannel && (
          <>
            <ActionRowGroup>
              <ActionRow
                label="Read-only"
                sublabel="Only managers can post"
                trailing={
                  <Switch
                    value={!!channel?.isReadOnly}
                    onValueChange={handleToggleReadOnly}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
              {channel?.isReadOnly && (
                <ActionRow
                  label="Managers"
                  sublabel={managerNames || 'No roles selected'}
                  trailing="chevron"
                  onPress={() => setRolePickerVisible(true)}
                />
              )}
            </ActionRowGroup>

            <ActionRowGroup>
              <ActionRow
                label="Set as default channel"
                sublabel={
                  channel?.channelId === space.defaultChannelId
                    ? 'This is the default channel'
                    : 'New members land here first'
                }
                trailing={
                  <Switch
                    value={channel?.channelId === space.defaultChannelId}
                    onValueChange={handleSetDefault}
                    disabled={channel?.channelId === space.defaultChannelId}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                  />
                }
              />
            </ActionRowGroup>
          </>
        )}

        <ActionRowGroup>
          <ActionRow
            icon="trash"
            label={isChannel ? 'Delete channel' : 'Delete group'}
            destructive
            onPress={handleDelete}
          />
        </ActionRowGroup>

        {confirmDialog}
      </ScrollView>

      <ChannelIconPickerSheet
        visible={iconPickerVisible}
        onClose={() => setIconPickerVisible(false)}
        selectedIcon={(isChannel ? channel?.icon : resolved.group.icon) || undefined}
        selectedColor={activeIconColor as IconColor}
        selectedVariant={(isChannel ? channel?.iconVariant : resolved.group.iconVariant) ?? 'outline'}
        onSelect={handleIconSelect}
        onClear={handleIconClear}
      />

      {isChannel && (
        <ChannelManagerRolePickerSheet
          visible={rolePickerVisible}
          onClose={() => setRolePickerVisible(false)}
          roles={roles}
          selectedRoleIds={channel?.managerRoleIds ?? []}
          onConfirm={handleManagerRolesConfirm}
        />
      )}
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: { paddingHorizontal: Skin.space(16), paddingTop: Skin.space(8) },
    title: {
      ...theme.textStyles.headline,
      color: theme.colors.textStrong,
      textAlign: 'center',
      marginBottom: Skin.space(16),
    },
    renameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(10),
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(10),
      marginBottom: Skin.space(14),
    },
    renameInput: { flex: 1, ...theme.textStyles.body, color: theme.colors.textMain, padding: 0 },
    iconPreview: {
      width: 36,
      height: 36,
      borderRadius: Skin.radius(18),
      alignItems: 'center',
      justifyContent: 'center',
    },
  });
