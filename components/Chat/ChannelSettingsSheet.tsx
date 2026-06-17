/**
 * ChannelSettingsSheet — per-item settings drawer for a channel OR a channel
 * group, opened from a row tap inside SpaceSettingsModal (owner-only path).
 * Group-aware via the `target` prop. Hosts nested icon + role pickers.
 *
 * Replaces the inline channel/group editing previously scattered across
 * SpaceSettingsModal (editingChannelId / iconPicker* state + handlers).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity as RNTouchableOpacity, View } from 'react-native';
import { type IconColor } from '@quilibrium/quorum-shared';
import { resolveChannelIconColor } from '@/utils/channelIcon';
import {
  useUpdateChannel,
  useDeleteChannel,
  useUpdateGroup,
  useDeleteGroup,
  useAddChannel,
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
  | { kind: 'group'; spaceId: string; groupIndex: number }
  | { kind: 'create-channel'; spaceId: string; groupIndex: number };

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
  const addChannel = useAddChannel();
  const { data: roles = [] } = useRoles(target?.spaceId);

  const isCreate = target?.kind === 'create-channel';

  // Nested-sheet visibility + back-guard
  const [iconPickerVisible, setIconPickerVisible] = useState(false);
  const [rolePickerVisible, setRolePickerVisible] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const childOpen = iconPickerVisible || rolePickerVisible || isConfirming;
  const guardedClose = useCallback(() => {
    if (childOpen) return;
    onClose();
  }, [childOpen, onClose]);

  // Bump this after every local mutation so `resolved` re-reads storage.
  const [reloadTick, setReloadTick] = useState(0);
  const bumpReload = () => setReloadTick((t) => t + 1);

  // Resolve the live target object fresh from storage.
  // For create-channel: resolves { space, group: null, channel: null } — no channel yet.
  const resolved = useMemo(() => {
    if (!target) return null;
    const space = getSpace(target.spaceId);
    if (!space) return null;
    if (target.kind === 'create-channel') {
      return { space, group: null, channel: null };
    }
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
    if (isCreate) {
      setNameDraft('');
      return;
    }
    setNameDraft(
      target?.kind === 'group' ? resolved.group?.groupName ?? '' : resolved.channel?.channelName ?? ''
    );
  }, [resolved, target?.kind, isCreate]);

  // Create-mode draft state
  const [draftGroupIndex, setDraftGroupIndex] = useState(0);
  const [draftIcon, setDraftIcon] = useState<string | undefined>(undefined);
  const [draftIconColor, setDraftIconColor] = useState<IconColor>('default');
  const [draftIconVariant, setDraftIconVariant] = useState<'outline' | 'filled'>('outline');
  const [draftReadOnly, setDraftReadOnly] = useState(false);
  const [draftManagerRoleIds, setDraftManagerRoleIds] = useState<string[]>([]);
  const [draftSetDefault, setDraftSetDefault] = useState(false);

  // Reset draft state when the drawer opens in create mode
  useEffect(() => {
    if (!visible || !isCreate || !target) return;
    setDraftGroupIndex(target.kind === 'create-channel' ? (target.groupIndex ?? 0) : 0);
    setDraftIcon(undefined);
    setDraftIconColor('default');
    setDraftIconVariant('outline');
    setDraftReadOnly(false);
    setDraftManagerRoleIds([]);
    setDraftSetDefault(false);
    setNameDraft('');
  }, [visible, isCreate, target]);

  if (!visible || !target || !resolved) {
    return null;
  }

  const { space, channel } = resolved;
  const isChannel = target.kind === 'channel';

  const anyPending =
    updateChannel.isPending ||
    updateGroup.isPending ||
    updateSpace.isPending ||
    addChannel.isPending;

  const afterMutation = () => {
    bumpReload();
    onChanged?.();
  };

  const reportMutationError = async (action: string, e: unknown) => {
    await confirm({
      title: 'Could not save',
      message: `Failed to ${action}. ${e instanceof Error ? e.message : 'Please try again.'}`,
      confirmLabel: 'OK',
      cancelLabel: 'Dismiss',
      variant: 'primary',
    });
  };

  const commitName = async () => {
    if (anyPending) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    try {
      if (isChannel) {
        if (trimmed === channel?.channelName) return;
        await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, channelName: trimmed });
      } else {
        if (trimmed === resolved.group?.groupName) return;
        await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, groupName: trimmed });
      }
      afterMutation();
    } catch (e) {
      setNameDraft(isChannel ? channel?.channelName ?? '' : resolved.group?.groupName ?? '');
      await reportMutationError('rename', e);
    }
  };

  const handleIconSelect = async (icon: string, color: IconColor, variant: 'outline' | 'filled') => {
    if (isCreate) {
      setDraftIcon(icon);
      setDraftIconColor(color);
      setDraftIconVariant(variant);
      return;
    }
    if (anyPending) return;
    try {
      if (isChannel) {
        await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon, iconColor: color, iconVariant: variant });
      } else {
        await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon, iconColor: color, iconVariant: variant });
      }
      afterMutation();
    } catch (e) {
      await reportMutationError('update the icon', e);
    }
  };

  const handleIconClear = async () => {
    if (isCreate) {
      setDraftIcon(undefined);
      setDraftIconColor('default');
      setDraftIconVariant('outline');
      return;
    }
    if (anyPending) return;
    try {
      if (isChannel) {
        await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
      } else {
        await updateGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex, icon: '', iconColor: 'default' as IconColor, iconVariant: 'outline' });
      }
      afterMutation();
    } catch (e) {
      await reportMutationError('clear the icon', e);
    }
  };

  const handleToggleReadOnly = async (value: boolean) => {
    if (!isChannel) return;
    if (anyPending) return;
    try {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, isReadOnly: value });
      afterMutation();
    } catch (e) {
      await reportMutationError('change read-only', e);
    }
  };

  const handleManagerRolesConfirm = async (roleIds: string[]) => {
    if (isCreate) {
      setDraftManagerRoleIds(roleIds);
      return;
    }
    if (!isChannel) return;
    // NOTE: no `anyPending` guard here. The role picker auto-saves on each tap and
    // always sends the COMPLETE intended set, so overlapping writes are self-
    // correcting (last one wins). Guarding would silently drop rapid taps.
    try {
      await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId, managerRoleIds: roleIds });
      afterMutation();
    } catch (e) {
      await reportMutationError('update managers', e);
    }
  };

  const handleSetDefault = async (value: boolean) => {
    if (!isChannel || !value) return;
    if (anyPending) return;
    try {
      await updateSpace.mutateAsync({ spaceId: target.spaceId, defaultChannelId: target.channelId });
      afterMutation();
    } catch (e) {
      await reportMutationError('set the default channel', e);
    }
  };

  const handleDelete = async () => {
    setIsConfirming(true);
    try {
      const label = isChannel ? `#${channel?.channelName ?? ''}` : `the "${resolved.group?.groupName ?? ''}" group`;
      const ok = await confirm({
        title: isChannel ? 'Delete Channel' : 'Delete Group',
        message: isChannel
          ? `This permanently deletes ${label} and its messages for everyone.`
          : `This permanently deletes ${label} for everyone. The group must be empty.`,
        confirmLabel: 'Delete',
      });
      if (!ok) return;
      try {
        if (isChannel) {
          await deleteChannel.mutateAsync({ spaceId: target.spaceId, channelId: target.channelId });
        } else {
          await deleteGroup.mutateAsync({ spaceId: target.spaceId, groupIndex: target.groupIndex });
        }
        onChanged?.();
        onClose();
      } catch (e) {
        await confirm({
          title: 'Could not delete',
          message:
            isChannel && target.channelId === space?.defaultChannelId
              ? 'This is the default channel. Set another channel as default first.'
              : 'Delete failed. ' + (e instanceof Error ? e.message : ''),
          confirmLabel: 'OK',
          cancelLabel: 'Dismiss',
          variant: 'primary',
        });
      }
    } finally {
      setIsConfirming(false);
    }
  };

  const handleCreate = async () => {
    if (anyPending) return;
    const trimmed = nameDraft.trim();
    if (!trimmed) return;
    try {
      const created = await addChannel.mutateAsync({
        spaceId: target.spaceId,
        groupIndex: draftGroupIndex,
        channelName: trimmed,
        isReadOnly: draftReadOnly || undefined,
        managerRoleIds: draftReadOnly && draftManagerRoleIds.length ? draftManagerRoleIds : undefined,
        icon: draftIcon,
        iconColor: draftIcon ? draftIconColor : undefined,
      });
      // useAddChannel does NOT persist iconVariant or set default — apply as follow-ups
      if (draftIcon && draftIconVariant === 'filled') {
        await updateChannel.mutateAsync({ spaceId: target.spaceId, channelId: created.channelId, iconVariant: 'filled' });
      }
      if (draftSetDefault) {
        await updateSpace.mutateAsync({ spaceId: target.spaceId, defaultChannelId: created.channelId });
      }
      onChanged?.();
      onClose();
    } catch (e) {
      await reportMutationError('create the channel', e);
    }
  };

  // Derived display values for edit mode
  const managerNames = (channel?.managerRoleIds ?? [])
    .map((id) => roles.find((r) => r.roleId === id)?.displayName)
    .filter(Boolean)
    .join(', ');
  const rawIconColor = isChannel ? channel?.iconColor : resolved.group?.iconColor;
  const iconHex = resolveChannelIconColor(rawIconColor, theme.colors.textMuted);

  // Icon values: in create mode use draft, in edit mode use stored
  const activeIcon = isCreate ? draftIcon : (isChannel ? channel?.icon : resolved.group?.icon);
  const activeIconColor = isCreate ? draftIconColor : ((rawIconColor && !rawIconColor.startsWith('#') ? rawIconColor : 'default') as IconColor);
  const activeIconVariant = isCreate ? draftIconVariant : (isChannel ? channel?.iconVariant : resolved.group?.iconVariant) ?? 'outline';
  const activeIconHex = isCreate
    ? resolveChannelIconColor(draftIcon ? draftIconColor : undefined, theme.colors.textMuted)
    : iconHex;

  return (
    <BaseModal visible={visible} onClose={guardedClose} showHandle height={0.8} avoidKeyboard>
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>
          {isCreate ? 'New channel' : isChannel ? 'Channel settings' : 'Group settings'}
        </Text>

        {/* Create mode: group selector */}
        {isCreate && space && (
          <View style={styles.createSection}>
            <Text style={styles.createSectionLabel}>Group</Text>
            <View style={styles.groupChipRow}>
              {space.groups.map((g, i) => (
                <RNTouchableOpacity
                  key={i}
                  style={[styles.groupChip, draftGroupIndex === i && styles.groupChipSelected]}
                  onPress={() => setDraftGroupIndex(i)}
                >
                  <Text style={[styles.groupChipText, draftGroupIndex === i && styles.groupChipTextSelected]}>
                    {g.groupName}
                  </Text>
                </RNTouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Rename + icon */}
        <View style={styles.renameRow}>
          <TouchableOpacity
            style={[styles.iconPreview, { backgroundColor: activeIconHex + '20' }]}
            onPress={() => setIconPickerVisible(true)}
            accessibilityLabel="Change icon"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <IconSymbol
              name={((activeIcon) || (isCreate || isChannel ? 'hashtag' : 'hashtag')) as IconSymbolName}
              size={20}
              color={activeIconHex}
              variant={activeIconVariant}
            />
          </TouchableOpacity>
          <TextInput
            style={styles.renameInput}
            value={nameDraft}
            onChangeText={setNameDraft}
            onBlur={isCreate ? undefined : commitName}
            onSubmitEditing={isCreate ? undefined : commitName}
            placeholder={isCreate || isChannel ? 'Channel name' : 'Group name'}
            placeholderTextColor={theme.colors.textMuted}
            returnKeyType="done"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Edit mode: channel-specific settings */}
        {isChannel && !isCreate && (
          <>
            <ActionRowGroup style={styles.group}>
              <ActionRow
                icon="lock.fill"
                label="Read-only"
                sublabel="Only managers can post, pin & delete"
                trailing={
                  <Switch
                    value={!!channel?.isReadOnly}
                    onValueChange={handleToggleReadOnly}
                    disabled={anyPending}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                    accessibilityLabel="Read-only"
                  />
                }
              />
              {channel?.isReadOnly && (
                <ActionRow
                  icon="shield.fill"
                  label="Managers"
                  sublabel={managerNames || 'No roles selected'}
                  trailing="chevron"
                  onPress={() => setRolePickerVisible(true)}
                />
              )}
            </ActionRowGroup>

            {channel?.isReadOnly && (channel?.managerRoleIds?.length ?? 0) === 0 && (
              <Text style={styles.warningText}>
                No managers selected — nobody will be able to post in this channel.
              </Text>
            )}

            <ActionRowGroup style={styles.group}>
              <ActionRow
                icon="star.fill"
                label="Set as default channel"
                sublabel={
                  channel?.channelId === space?.defaultChannelId
                    ? 'This is the default channel'
                    : 'New members land here first'
                }
                trailing={
                  <Switch
                    value={channel?.channelId === space?.defaultChannelId}
                    onValueChange={handleSetDefault}
                    disabled={channel?.channelId === space?.defaultChannelId || anyPending}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                    accessibilityLabel="Set as default channel"
                  />
                }
              />
            </ActionRowGroup>
          </>
        )}

        {/* Create mode: channel-specific settings (draft-only) */}
        {isCreate && (
          <>
            <ActionRowGroup style={styles.group}>
              <ActionRow
                icon="lock.fill"
                label="Read-only"
                sublabel="Only managers can post, pin & delete"
                trailing={
                  <Switch
                    value={draftReadOnly}
                    onValueChange={setDraftReadOnly}
                    disabled={anyPending}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                    accessibilityLabel="Read-only"
                  />
                }
              />
              {draftReadOnly && (
                <ActionRow
                  icon="shield.fill"
                  label="Managers"
                  sublabel={
                    draftManagerRoleIds.length > 0
                      ? draftManagerRoleIds
                          .map((id) => roles.find((r) => r.roleId === id)?.displayName)
                          .filter(Boolean)
                          .join(', ')
                      : 'No roles selected'
                  }
                  trailing="chevron"
                  onPress={() => setRolePickerVisible(true)}
                />
              )}
            </ActionRowGroup>

            {draftReadOnly && draftManagerRoleIds.length === 0 && (
              <Text style={styles.warningText}>
                No managers selected — nobody will be able to post in this channel.
              </Text>
            )}

            <ActionRowGroup style={styles.group}>
              <ActionRow
                icon="star.fill"
                label="Set as default channel"
                sublabel="New members land here first"
                trailing={
                  <Switch
                    value={draftSetDefault}
                    onValueChange={setDraftSetDefault}
                    disabled={anyPending}
                    trackColor={{ false: theme.colors.surface5, true: theme.colors.primary }}
                    accessibilityLabel="Set as default channel"
                  />
                }
              />
            </ActionRowGroup>

            {/* Create button */}
            <TouchableOpacity
              style={[styles.createButton, anyPending && styles.createButtonDisabled]}
              onPress={handleCreate}
              disabled={anyPending || !nameDraft.trim()}
            >
              <Text style={styles.createButtonText}>
                {anyPending ? 'Creating…' : 'Create channel'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* Edit mode: delete */}
        {!isCreate && (
          <ActionRowGroup style={styles.group}>
            <ActionRow
              icon="trash"
              label={isChannel ? 'Delete channel' : 'Delete group'}
              destructive
              disabled={anyPending}
              onPress={handleDelete}
            />
          </ActionRowGroup>
        )}

        {confirmDialog}
      </ScrollView>

      <ChannelIconPickerSheet
        visible={iconPickerVisible}
        onClose={() => setIconPickerVisible(false)}
        selectedIcon={activeIcon || undefined}
        selectedColor={activeIconColor}
        selectedVariant={activeIconVariant}
        onSelect={handleIconSelect}
        onClear={handleIconClear}
      />

      {(isChannel || isCreate) && (
        <ChannelManagerRolePickerSheet
          visible={rolePickerVisible}
          onClose={() => setRolePickerVisible(false)}
          roles={roles}
          selectedRoleIds={isCreate ? draftManagerRoleIds : (channel?.managerRoleIds ?? [])}
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
    /** Vertical gap between consecutive ActionRowGroup blocks in the drawer. */
    group: { marginBottom: Skin.space(14) },
    warningText: {
      ...theme.textStyles.footnote,
      color: theme.colors.warning,
      marginTop: Skin.space(-6),
      marginBottom: Skin.space(14),
      paddingHorizontal: Skin.space(4),
    },
    /** Create mode: section label + group chips */
    createSection: {
      marginBottom: Skin.space(14),
    },
    createSectionLabel: {
      ...theme.textStyles.caption1,
      color: theme.colors.textMuted,
      marginBottom: Skin.space(8),
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    groupChipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: Skin.space(8),
    },
    groupChip: {
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(20),
      backgroundColor: theme.colors.surface3,
    },
    groupChipSelected: {
      backgroundColor: theme.colors.primary,
    },
    groupChipText: {
      ...theme.textStyles.caption1,
      color: theme.colors.textMuted,
    },
    groupChipTextSelected: {
      color: theme.colors.textStrong,
    },
    createButton: {
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      marginBottom: Skin.space(24),
    },
    createButtonDisabled: {
      opacity: 0.5,
    },
    createButtonText: {
      ...theme.textStyles.body,
      color: theme.colors.textStrong,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
    },
  });
