/**
 * SpaceModal - Modal for creating or joining a space
 *
 * Two tabs:
 * - Create: Enter space name, optional description, and create
 * - Join: Enter invite link to join existing space
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator, Image, ScrollView } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useSpaces } from '@/hooks/chat/useSpaces';
import { useCreateSpace, useJoinSpace, useValidateInvite } from '@/hooks/chat/useSpaceActions';
import { useWebSocket } from '@/context/WebSocketContext';
import { useToast } from '@/context/ToastContext';
import { haptics } from '@/utils/haptics';
import * as Skin from '@/theme/skins/geometry';
import { SegmentedPills } from '@/components/ui/SegmentedPills';
import {
  validateSpaceName,
  validateSpaceDescription,
  MAX_NAME_LENGTH,
} from '@quilibrium/quorum-shared';
import {
  translateValidationResult,
  translateValidationResults,
} from '@/hooks/validation/errorTranslator';

interface SpaceModalProps {
  visible: boolean;
  onClose: () => void;
  onSpaceCreated?: (spaceId: string) => void;
  onSpaceJoined?: (spaceId: string) => void;
  initialTab?: 'create' | 'join';
}

type TabType = 'create' | 'join';

// Space name min/max + XSS validation now come from @quilibrium/quorum-shared
// (validateSpaceName). MAX_NAME_LENGTH is imported for the input's maxLength prop.
// MAX_DESCRIPTION_LENGTH stays local — it's a mobile UI affordance passed into the
// shared validateSpaceDescription(description, maxLength).
const MAX_DESCRIPTION_LENGTH = 300;

// Invite link validation
function isValidInviteLink(link: string): boolean {
  if (!link) return false;
  const trimmed = link.trim();
  // Accept various formats:
  // - Full URL: https://quorummessenger.com/i/...
  // - Short URL: quorummessenger.com/i/...
  // - qm.one URLs: https://qm.one/#... or https://qm.one/invite/#...
  // - Just the invite code: Qm... or other base58
  // - Any URL with hash fragment containing spaceId parameter
  return (
    trimmed.includes('quorummessenger.com/i/') ||
    trimmed.includes('qm.one/') ||
    trimmed.includes('/i/') ||
    (trimmed.includes('#') && trimmed.includes('spaceId=')) ||
    /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,}$/.test(trimmed)
  );
}

export default function SpaceModal({
  visible,
  onClose,
  onSpaceCreated,
  onSpaceJoined,
  initialTab,
}: SpaceModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);
  const { subscribe, enqueueOutbound } = useWebSocket();

  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'join');

  // Create tab state
  const [spaceName, setSpaceName] = useState('');
  const [description, setDescription] = useState('');

  // Join tab state
  const [inviteLink, setInviteLink] = useState('');

  // Mutations
  const createSpaceMutation = useCreateSpace();
  const joinSpaceMutation = useJoinSpace();
  const { data: validatedSpace, isLoading: isValidating, error: validationError } = useValidateInvite(inviteLink);
  const { showToast } = useToast();

  // Surface validation errors as a toast that appears AFTER the modal
  // dismisses — the modal's overlay otherwise covers the toast at the
  // top of the screen. The dedupe ref prevents firing twice for the
  // same error (React Query re-emits while debouncing).
  const lastReportedErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!validationError) {
      lastReportedErrorRef.current = null;
      return;
    }
    const message = validationError instanceof Error
      ? validationError.message
      : 'Invalid invite link';
    if (lastReportedErrorRef.current === message) return;
    lastReportedErrorRef.current = message;
    // Close the modal first; show toast on a delay so the modal
    // overlay has time to dismiss.
    onClose();
    setTimeout(() => {
      showToast({
        type: 'error',
        title: "Couldn't validate invite",
        message,
        duration: 6000,
      });
    }, 200);
  }, [validationError, onClose, showToast]);

  // Check if already a member
  const { data: spaces } = useSpaces();
  const isAlreadyMember = useMemo(() => {
    if (!validatedSpace || !spaces) return false;
    return spaces.some((s) => s.spaceId === validatedSpace.spaceId);
  }, [validatedSpace, spaces]);

  // Validation (shared validators + mobile string translator)
  const nameError = translateValidationResult(validateSpaceName(spaceName)) ?? null;
  const descriptionError =
    translateValidationResults(
      validateSpaceDescription(description, MAX_DESCRIPTION_LENGTH)
    )[0] ?? null;
  const canCreate = !nameError && !descriptionError && !createSpaceMutation.isPending;
  const canJoin = isValidInviteLink(inviteLink) && validatedSpace && !isAlreadyMember && !joinSpaceMutation.isPending;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;

    try {
      haptics.light();
      const result = await createSpaceMutation.mutateAsync({
        name: spaceName.trim(),
        description: description.trim() || undefined,
      });

      if (result?.spaceId) {
        // Subscribe to the new space inbox immediately
        if (result.inboxAddress) {
          await subscribe([result.inboxAddress]);
        }
        onClose();
        haptics.success();
        onSpaceCreated?.(result.spaceId);
      }
    } catch (error) {
      haptics.error();
    }
  }, [canCreate, spaceName, description, createSpaceMutation, onClose, onSpaceCreated, subscribe]);

  const handleJoin = useCallback(async () => {
    if (!canJoin) return;

    try {
      haptics.light();
      const result = await joinSpaceMutation.mutateAsync({
        inviteLink: inviteLink.trim(),
      });

      if (result?.spaceId) {
        // Subscribe to the new space inbox immediately
        if (result.inboxAddress) {
          await subscribe([result.inboxAddress]);
        }

        // Send join control message to announce ourselves to other participants
        if (result.joinMessageEnvelope) {
          enqueueOutbound(async () => [result.joinMessageEnvelope!]);
        }

        // Hook the new space into the per-hub log transport. The
        // on-connect orchestrator only registers spaces it knew about at
        // start, so a freshly joined space wouldn't get listen-hub or
        // log-since until reconnect without this call.
        const { subscribeAndCatchUpHubLog } = await import('@/services/space/hubLogSync');
        void subscribeAndCatchUpHubLog(result.spaceId, enqueueOutbound);

        onClose();
        haptics.success();
        onSpaceJoined?.(result.spaceId);
      }
    } catch (error) {
      haptics.error();
    }
  }, [canJoin, inviteLink, joinSpaceMutation, onClose, onSpaceJoined, subscribe, enqueueOutbound]);

  const handleClose = useCallback(() => {
    setSpaceName('');
    setDescription('');
    setInviteLink('');
    onClose();
  }, [onClose]);

  const renderTabs = () => (
    <SegmentedPills
      style={styles.tabContainer}
      scrollable={false}
      pillShape="rect"
      items={[
        { key: 'join', label: 'Join' },
        { key: 'create', label: 'Create' },
      ]}
      activeKey={activeTab}
      onChange={(key) => setActiveTab(key as TabType)}
    />
  );

  const renderCreateTab = () => (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.tabContentScroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {/* Space Name */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Space Name</Text>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={spaceName}
            onChangeText={setSpaceName}
            placeholder="Enter a name for your Space"
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="words"
            autoCorrect={false}
            editable={!createSpaceMutation.isPending}
            maxLength={MAX_NAME_LENGTH}
          />
          {spaceName.length > 0 && (
            <TouchableOpacity style={styles.clearButton} onPress={() => setSpaceName('')}>
              <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        {spaceName.length > 0 && nameError && (
          <Text style={styles.errorText}>{nameError}</Text>
        )}
      </View>

      {/* Description */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Description (optional)</Text>
        <View style={[styles.inputContainer, styles.textAreaContainer]}>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Enter a description for your Space"
            placeholderTextColor={theme.colors.textMuted}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            editable={!createSpaceMutation.isPending}
            maxLength={MAX_DESCRIPTION_LENGTH + 50} // Allow some overflow for error display
          />
        </View>
        <View style={styles.charCountRow}>
          {descriptionError && <Text style={styles.errorText}>{descriptionError}</Text>}
          <Text style={[styles.charCount, descriptionError && styles.charCountError]}>
            {description.length}/{MAX_DESCRIPTION_LENGTH}
          </Text>
        </View>
      </View>

      {/* Error display */}
      {createSpaceMutation.error && (
        <View style={styles.errorBanner}>
          <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorBannerText}>
            {createSpaceMutation.error instanceof Error
              ? createSpaceMutation.error.message
              : 'Failed to create space'}
          </Text>
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={handleClose}
          disabled={createSpaceMutation.isPending}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, !canCreate && styles.primaryButtonDisabled]}
          onPress={handleCreate}
          disabled={!canCreate}
        >
          {createSpaceMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconSymbol name="plus.circle.fill" size={18} color="#fff" />
              <Text style={styles.primaryButtonText}>Create Space</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  const renderJoinTab = () => (
    <ScrollView
      style={styles.tabContent}
      contentContainerStyle={styles.tabContentScroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {/* Validated Space Preview */}
      {validatedSpace && (
        <View style={styles.spacePreview}>
          {validatedSpace.iconUrl ? (
            <Image source={{ uri: validatedSpace.iconUrl }} style={styles.spaceIcon} />
          ) : (
            <View style={styles.spaceIconPlaceholder}>
              <IconSymbol name="person.3.fill" size={24} color={theme.colors.textMuted} />
            </View>
          )}
          <Text style={styles.spaceName}>{validatedSpace.spaceName}</Text>
          {validatedSpace.description && (
            <Text style={styles.spaceDescription} numberOfLines={2}>
              {validatedSpace.description}
            </Text>
          )}
          {isAlreadyMember && (
            <View style={styles.memberBadge}>
              <IconSymbol name="checkmark.circle.fill" size={14} color={theme.colors.success ?? '#22c55e'} />
              <Text style={styles.memberBadgeText}>Already a member</Text>
            </View>
          )}
        </View>
      )}

      {/* If no validated space, show placeholder */}
      {!validatedSpace && !isValidating && (
        <View style={styles.spacePreviewPlaceholder}>
          <View style={styles.spaceIconPlaceholder}>
            <IconSymbol name="questionmark" size={24} color={theme.colors.textMuted} />
          </View>
          <Text style={styles.placeholderText}>Enter an invite link to preview the space</Text>
        </View>
      )}

      {/* Loading state */}
      {isValidating && (
        <View style={styles.spacePreviewPlaceholder}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={styles.placeholderText}>Validating invite...</Text>
        </View>
      )}

      {/* Invite Link Input */}
      <View style={styles.inputSection}>
        <Text style={styles.label}>Invite Link</Text>
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={inviteLink}
            onChangeText={setInviteLink}
            placeholder="https://quorummessenger.com/i/..."
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!joinSpaceMutation.isPending}
          />
          {inviteLink.length > 0 && (
            <TouchableOpacity style={styles.clearButton} onPress={() => setInviteLink('')}>
              <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>
        {validationError && (
          <Text style={styles.errorText}>
            {validationError instanceof Error ? validationError.message : 'Invalid invite link'}
          </Text>
        )}
      </View>

      {/* Error display */}
      {joinSpaceMutation.error && (
        <View style={styles.errorBanner}>
          <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.danger} />
          <Text style={styles.errorBannerText}>
            {joinSpaceMutation.error instanceof Error
              ? joinSpaceMutation.error.message
              : 'Failed to join space'}
          </Text>
        </View>
      )}

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={handleClose}
          disabled={joinSpaceMutation.isPending}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.primaryButton, !canJoin && styles.primaryButtonDisabled]}
          onPress={handleJoin}
          disabled={!canJoin}
        >
          {joinSpaceMutation.isPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <>
              <IconSymbol name="arrow.right.circle.fill" size={18} color="#fff" />
              <Text style={styles.primaryButtonText}>
                {isAlreadyMember ? 'Joined' : 'Join Space'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.75} avoidKeyboard>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Add Space</Text>
        </View>

        {/* Tabs */}
        {renderTabs()}

        {/* Tab Content */}
        {activeTab === 'create' ? renderCreateTab() : renderJoinTab()}
      </View>
    </BaseModal>
  );
}

const createStyles = (theme: AppTheme, insets: EdgeInsets) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: Skin.space(20),
    },
    header: {
      paddingVertical: Skin.space(16),
      alignItems: 'center',
    },
    title: {
      fontSize: Skin.font(20),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
    },
    tabContainer: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(4),
      marginBottom: Skin.space(20),
    },
    tabContent: {
      flex: 1,
    },
    // flexGrow keeps the content filling the sheet on normal phones (so the
    // actions stay pinned to the bottom via marginTop:'auto'), while letting
    // it scroll when content + keyboard exceed the sheet height on tall /
    // foldable screens (issue #7).
    tabContentScroll: {
      flexGrow: 1,
      paddingBottom: insets.bottom + Skin.space(20),
    },
    inputSection: {
      marginBottom: Skin.space(16),
    },
    label: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    inputContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      paddingHorizontal: Skin.space(16),
    },
    textAreaContainer: {
      alignItems: 'flex-start',
      paddingVertical: Skin.space(8),
    },
    input: {
      flex: 1,
      paddingVertical: Skin.space(14),
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    textArea: {
      minHeight: 80,
      paddingVertical: Skin.space(8),
    },
    clearButton: {
      padding: Skin.space(4),
    },
    charCountRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: Skin.space(4),
    },
    charCount: {
      fontSize: Skin.font(12),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginLeft: 'auto',
    },
    charCountError: {
      color: theme.colors.danger,
    },
    errorText: {
      marginTop: Skin.space(8),
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger,
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: Skin.space(12),
      backgroundColor: theme.colors.danger + '15',
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(16),
      gap: Skin.space(8),
    },
    errorBannerText: {
      flex: 1,
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger,
    },
    spacePreview: {
      alignItems: 'center',
      paddingVertical: Skin.space(24),
      marginBottom: Skin.space(16),
    },
    spacePreviewPlaceholder: {
      alignItems: 'center',
      paddingVertical: Skin.space(24),
      marginBottom: Skin.space(16),
    },
    spaceIcon: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(16),
      marginBottom: Skin.space(12),
    },
    spaceIconPlaceholder: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(16),
      backgroundColor: theme.colors.surface4,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(12),
    },
    spaceName: {
      fontSize: Skin.font(18),
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textStrong,
      textAlign: 'center',
    },
    spaceDescription: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginTop: Skin.space(8),
      paddingHorizontal: Skin.space(16),
    },
    placeholderText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
      textAlign: 'center',
      marginTop: Skin.space(8),
    },
    memberBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(12),
      paddingHorizontal: Skin.space(12),
      paddingVertical: Skin.space(6),
      backgroundColor: (theme.colors.success ?? '#22c55e') + '15',
      borderRadius: Skin.radius(16),
      gap: Skin.space(6),
    },
    memberBadgeText: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.success ?? '#22c55e',
    },
    actions: {
      flexDirection: 'row',
      marginTop: 'auto',
      paddingTop: Skin.space(16),
      gap: Skin.space(12),
    },
    cancelButton: {
      flex: 1,
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(12),
    },
    cancelButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    primaryButton: {
      flex: 1,
      flexDirection: 'row',
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      gap: Skin.space(8),
    },
    primaryButtonDisabled: {
      opacity: 0.5,
    },
    primaryButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
  });
