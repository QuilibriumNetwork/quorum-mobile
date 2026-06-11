/**
 * NewConversationModal - Modal for starting a new DM conversation
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BaseModal } from '@/components/shared';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { useConversations } from '@/hooks/chat/useConversations';
import { useStorageAdapter } from '@/context/StorageContext';
import { useResolveName } from '@/hooks/useQNS';
import { deriveAddress } from '@/services/onboarding/keyService';
import * as Skin from '@/theme/skins/geometry';

interface NewConversationModalProps {
  visible: boolean;
  onClose: () => void;
  onConversationCreated: (conversationId: string) => void;
}

// Validate address format: Base58 multihash (Qm...) or username (@...)
function isValidAddress(address: string): boolean {
  if (!address) return false;
  const trimmed = address.trim();

  // Username format: @username (alphanumeric, underscores, min 1 char after @)
  if (trimmed.startsWith('@')) {
    const username = trimmed.slice(1);
    return /^[a-zA-Z0-9_]{1,}$/.test(username);
  }

  // Base58 multihash format (starts with Qm, 46 chars total for CIDv0)
  // Also accept other valid Base58 characters for flexibility
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{32,}$/;
  return base58Regex.test(trimmed);
}

// Check if input is a username
function isUsername(address: string): boolean {
  return address.trim().startsWith('@');
}

export default function NewConversationModal({
  visible,
  onClose,
  onConversationCreated,
}: NewConversationModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const storage = useStorageAdapter();
  const styles = createStyles(theme, insets);

  const [address, setAddress] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolvedAddress, setResolvedAddress] = useState<string | null>(null);

  // Extract username for QNS lookup (without @ prefix)
  const usernameToResolve = useMemo(() => {
    const trimmed = address.trim();
    if (trimmed.startsWith('@') && trimmed.length > 1) {
      return trimmed.slice(1);
    }
    return '';
  }, [address]);

  // Resolve QNS name when searching for @username
  const {
    data: resolvedName,
    isLoading: isResolvingName,
    error: resolveError,
    refetch: retryResolveName,
  } = useResolveName(usernameToResolve, {
    enabled: usernameToResolve.length >= 1,
  });

  // Derive address from resolveKey when name is resolved
  useEffect(() => {
    if (resolvedName?.resolveKey) {
      try {
        const derivedAddr = deriveAddress(resolvedName.resolveKey);
        setResolvedAddress(derivedAddr);
      } catch (err) {
        setResolvedAddress(null);
      }
    } else {
      setResolvedAddress(null);
    }
  }, [resolvedName]);

  // Get existing conversations to check for duplicates
  const { data: conversationsPages } = useConversations({ type: 'direct' });
  const existingConversations = useMemo(() => {
    if (!conversationsPages?.pages) return [];
    return conversationsPages.pages.flatMap(page => page.conversations);
  }, [conversationsPages]);

  // Normalize address for comparison and storage
  // If it's a username and we have a resolved address, use that
  const normalizedAddress = useMemo(() => {
    const trimmed = address.trim();
    if (trimmed.startsWith('@') && resolvedAddress) {
      return resolvedAddress;
    }
    return trimmed;
  }, [address, resolvedAddress]);

  // Check if conversation already exists
  const existingConversation = useMemo(() => {
    if (!normalizedAddress || normalizedAddress.startsWith('@')) return undefined;
    const searchAddress = normalizedAddress.toLowerCase();
    return existingConversations.find(
      c => c.address?.toLowerCase() === searchAddress
    );
  }, [existingConversations, normalizedAddress]);

  // Validation state
  const isInputValid = isValidAddress(address);
  // For @usernames, also require that it's resolvable (has resolveKey)
  const isUsernameResolvable = usernameToResolve
    ? !!resolvedAddress
    : true;
  const isValid = isInputValid && isUsernameResolvable;
  const canCreate = isValid && !existingConversation && !isCreating && !isResolvingName;

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;

    setIsCreating(true);
    setError(null);

    try {
      // For @usernames, use the resolved Qm address
      const targetAddress = address.trim().startsWith('@') && resolvedAddress
        ? resolvedAddress
        : address.trim();

      // Generate conversation ID (format: address/address)
      const conversationId = `${targetAddress}/${targetAddress}`;

      // Save conversation to storage
      await storage.saveConversation({
        conversationId,
        address: targetAddress,
        type: 'direct',
        timestamp: Date.now(),
        displayName: usernameToResolve ? `@${usernameToResolve}` : undefined,
        icon: undefined,
        lastReadTimestamp: undefined,
      });

      // Close modal and navigate to conversation
      onClose();
      onConversationCreated(conversationId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conversation');
    } finally {
      setIsCreating(false);
    }
  }, [canCreate, address, resolvedAddress, usernameToResolve, storage, onClose, onConversationCreated]);

  const handleOpenExisting = useCallback(() => {
    if (existingConversation) {
      onClose();
      onConversationCreated(existingConversation.conversationId);
    }
  }, [existingConversation, onClose, onConversationCreated]);

  const handleClose = useCallback(() => {
    setAddress('');
    setError(null);
    onClose();
  }, [onClose]);

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.6} avoidKeyboard>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>New Message</Text>
        </View>

        {/* Address Input */}
        <View style={styles.inputSection}>
          <Text style={styles.label}>Recipient</Text>
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.input}
              value={address}
              onChangeText={setAddress}
              placeholder="Address (Qm...) or username (@...)"
              placeholderTextColor={theme.colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              editable={!isCreating}
            />
            {address.length > 0 && (
              <TouchableOpacity
                style={styles.clearButton}
                onPress={() => setAddress('')}
              >
                <IconSymbol name="xmark.circle.fill" size={20} color={theme.colors.textMuted} />
              </TouchableOpacity>
            )}
          </View>

          {/* Validation feedback */}
          {address.length > 0 && !isInputValid && (
            <Text style={styles.errorText}>
              Enter a valid address (Qm...) or username (@...)
            </Text>
          )}
          {/* Username resolution status */}
          {usernameToResolve && isInputValid && (
            isResolvingName ? (
              <View style={styles.resolvingBanner}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={styles.resolvingText}>
                  Looking up @{usernameToResolve}...
                </Text>
              </View>
            ) : resolvedAddress ? (
              <View style={styles.resolvedBanner}>
                <IconSymbol name="checkmark.circle.fill" size={16} color={theme.colors.success} />
                <Text style={styles.resolvedBannerText}>
                  @{usernameToResolve} → {resolvedAddress.slice(0, 8)}...{resolvedAddress.slice(-6)}
                </Text>
              </View>
            ) : resolvedName ? (
              <Text style={styles.errorText}>
                @{usernameToResolve} is registered but not publicly resolvable
              </Text>
            ) : resolveError ? (
              <View style={styles.resolveErrorRow}>
                <Text style={styles.errorText}>
                  @{usernameToResolve} not found
                </Text>
                <TouchableOpacity
                  onPress={() => retryResolveName()}
                  accessibilityRole="button"
                  accessibilityLabel="Retry lookup"
                >
                  <Text style={styles.retryText}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : null
          )}
          {existingConversation && (
            <TouchableOpacity style={styles.existingBanner} onPress={handleOpenExisting}>
              <IconSymbol name="info.circle" size={16} color={theme.colors.primary} />
              <Text style={styles.existingText}>
                Conversation exists. Tap to open.
              </Text>
            </TouchableOpacity>
          )}
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>

        {/* Action Buttons */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={handleClose}
            disabled={isCreating}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.createButton, !canCreate && styles.createButtonDisabled]}
            onPress={handleCreate}
            disabled={!canCreate}
          >
            {isCreating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <IconSymbol name="paperplane.fill" size={18} color="#fff" />
                <Text style={styles.createButtonText}>Start Chat</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
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
    inputSection: {
      marginTop: Skin.space(8),
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
    input: {
      flex: 1,
      paddingVertical: Skin.space(14),
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
    },
    clearButton: {
      padding: Skin.space(4),
    },
    errorText: {
      marginTop: Skin.space(8),
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.danger ?? '#ef4444',
    },
    resolveErrorRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    retryText: {
      marginTop: Skin.space(8),
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    existingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(12),
      padding: Skin.space(12),
      backgroundColor: theme.colors.primary + '15',
      borderRadius: Skin.radius(8),
      gap: Skin.space(8),
    },
    existingText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.primary,
    },
    resolvingBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(12),
      padding: Skin.space(12),
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(8),
      gap: Skin.space(8),
    },
    resolvingText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    resolvedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(12),
      padding: Skin.space(12),
      backgroundColor: theme.colors.success + '15',
      borderRadius: Skin.radius(8),
      gap: Skin.space(8),
    },
    resolvedBannerText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.success,
    },
    actions: {
      flexDirection: 'row',
      marginTop: Skin.space(24),
      gap: Skin.space(12),
    },
    cancelButton: {
      flex: 1,
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
    },
    cancelButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    createButton: {
      flex: 1,
      flexDirection: 'row',
      paddingVertical: Skin.space(14),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderRadius: Skin.radius(12),
      gap: Skin.space(8),
    },
    createButtonDisabled: {
      opacity: 0.5,
    },
    createButtonText: {
      fontSize: Skin.font(16),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: '#fff',
    },
  });
