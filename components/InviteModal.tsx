/**
 * InviteModal - Modal for generating and sharing space invite links
 *
 * Provides:
 * - Generate invite link button
 * - Copy to clipboard
 * - Share via system share sheet
 */

import { BaseModal } from '@/components/shared';
import ShareInviteSheet from '@/components/ShareInviteSheet';
import { IconSymbol } from '@/components/ui/IconSymbol';
import {
  useCopyInviteLink,
  useGenerateInvite,
  useGeneratePublicInvite,
} from '@/hooks/chat/useInviteManagement';
import { getSpace } from '@/services/config/spaceStorage';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React, { useCallback, useState, useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface InviteModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  spaceName: string;
}

export default function InviteModal({
  visible,
  onClose,
  spaceId,
  spaceName,
}: InviteModalProps) {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(theme, insets);

  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [generatedType, setGeneratedType] = useState<'private' | 'public' | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviteType, setInviteType] = useState<'private' | 'public'>('private');
  const [hasLoadedExistingInvite, setHasLoadedExistingInvite] = useState(false);

  const generateInviteMutation = useGenerateInvite();
  const generatePublicInviteMutation = useGeneratePublicInvite();
  const copyLinkMutation = useCopyInviteLink();

  // Check for existing public invite URL when modal opens
  // Only run once per modal open to avoid overriding user actions
  useEffect(() => {
    if (visible && spaceId && !hasLoadedExistingInvite) {
      const space = getSpace(spaceId);
      if (space?.inviteUrl) {
        // Space already has a public invite URL - show it
        setInviteLink(space.inviteUrl);
        setGeneratedType('public');
        setInviteType('public');
      }
      setHasLoadedExistingInvite(true);
    }
  }, [visible, spaceId, hasLoadedExistingInvite]);

  const handleGenerateInvite = useCallback(async () => {
    try {
      if (inviteType === 'public') {
        const result = await generatePublicInviteMutation.mutateAsync({ spaceId });
        setInviteLink(result.inviteLink);
        setGeneratedType('public');
      } else {
        const result = await generateInviteMutation.mutateAsync({ spaceId });
        setInviteLink(result.inviteLink);
        setGeneratedType('private');
      }
    } catch (error) {
      // Failed to generate invite
    }
  }, [spaceId, inviteType, generateInviteMutation, generatePublicInviteMutation]);

  const handleCopyLink = useCallback(async () => {
    if (!inviteLink) return;

    try {
      await copyLinkMutation.mutateAsync(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      // Failed to copy link
    }
  }, [inviteLink, copyLinkMutation]);

  // Share opens the in-app contact picker first; the system share sheet
  // is one tap deeper via the sheet's "More options" button.
  const [shareSheetVisible, setShareSheetVisible] = useState(false);
  const handleShare = useCallback(() => {
    if (!inviteLink) return;
    setShareSheetVisible(true);
  }, [inviteLink]);

  const handleClose = useCallback(() => {
    setInviteLink(null);
    setGeneratedType(null);
    setCopied(false);
    setInviteType('private');
    setHasLoadedExistingInvite(false);
    onClose();
  }, [onClose]);

  const isGenerating = generateInviteMutation.isPending || generatePublicInviteMutation.isPending;
  const hasError = generateInviteMutation.error || generatePublicInviteMutation.error;

  return (
    <BaseModal visible={visible} onClose={handleClose} height={0.65} fillHeight avoidKeyboard>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Invite to {spaceName}</Text>
          <Text style={styles.subtitle}>
            Generate a link to invite others to this space
          </Text>
        </View>

        {/* Content — scrollable so the generate UI, warnings, and link
            actions fit on small-screen phones where the modal's 50%
            height isn't enough to show everything at once. */}
        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {!inviteLink ? (
            // Generate button
            <View style={styles.generateSection}>
              <View style={styles.iconContainer}>
                <IconSymbol name="link" size={48} color={theme.colors.primary} />
              </View>

              {/* Invite Type Toggle */}
              <View style={styles.inviteTypeToggle}>
                <TouchableOpacity
                  style={[
                    styles.inviteTypeButton,
                    inviteType === 'private' && styles.inviteTypeButtonActive,
                  ]}
                  onPress={() => setInviteType('private')}
                >
                  <IconSymbol
                    name="person.fill"
                    size={16}
                    color={inviteType === 'private' ? '#fff' : theme.colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.inviteTypeButtonText,
                      inviteType === 'private' && styles.inviteTypeButtonTextActive,
                    ]}
                  >
                    One-Time
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.inviteTypeButton,
                    inviteType === 'public' && styles.inviteTypeButtonActive,
                  ]}
                  onPress={() => setInviteType('public')}
                >
                  <IconSymbol
                    name="globe"
                    size={16}
                    color={inviteType === 'public' ? '#fff' : theme.colors.textMuted}
                  />
                  <Text
                    style={[
                      styles.inviteTypeButtonText,
                      inviteType === 'public' && styles.inviteTypeButtonTextActive,
                    ]}
                  >
                    Public Link
                  </Text>
                </TouchableOpacity>
              </View>

              <Text style={styles.infoText}>
                {inviteType === 'private'
                  ? 'Generate a one-time use invite link. Each link can only be used by one person.'
                  : 'Generate a reusable public invite link. Anyone with this link can join.'}
              </Text>

              {hasError && (
                <View style={styles.errorBanner}>
                  <IconSymbol name="exclamationmark.triangle.fill" size={16} color={theme.colors.danger} />
                  <Text style={styles.errorBannerText}>
                    {hasError instanceof Error ? hasError.message : 'Failed to generate invite'}
                  </Text>
                </View>
              )}

              <TouchableOpacity
                style={[styles.primaryButton, isGenerating && styles.primaryButtonDisabled]}
                onPress={handleGenerateInvite}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <>
                    <IconSymbol name="link.badge.plus" size={20} color="#fff" />
                    <Text style={styles.primaryButtonText}>
                      Generate {inviteType === 'public' ? 'Public' : 'Invite'} Link
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            // Invite link display and actions
            <View style={styles.linkSection}>
              <Text style={styles.linkLabel}>Invite Link</Text>

              <View style={styles.linkContainer}>
                <ScrollView
                  style={styles.linkScroll}
                  nestedScrollEnabled
                  showsVerticalScrollIndicator
                >
                  <TextInput
                    style={styles.linkInput}
                    value={inviteLink}
                    editable={false}
                    selectTextOnFocus
                    multiline
                  />
                </ScrollView>
              </View>

              <View style={styles.linkActions}>
                <TouchableOpacity
                  style={[styles.actionButton, copied && styles.actionButtonSuccess]}
                  onPress={handleCopyLink}
                  disabled={copyLinkMutation.isPending}
                >
                  <IconSymbol
                    name={copied ? 'checkmark' : 'doc.on.doc'}
                    size={18}
                    color={copied ? '#fff' : theme.colors.textMain}
                  />
                  <Text style={[styles.actionButtonText, copied && styles.actionButtonTextSuccess]}>
                    {copied ? 'Copied!' : 'Copy'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={handleShare}
                >
                  <IconSymbol name="square.and.arrow.up" size={18} color={theme.colors.textMain} />
                  <Text style={styles.actionButtonText}>Share</Text>
                </TouchableOpacity>
              </View>

              <View style={[styles.warningBanner, generatedType === 'public' && styles.infoBanner]}>
                <IconSymbol
                  name={generatedType === 'public' ? 'info.circle' : 'exclamationmark.circle'}
                  size={16}
                  color={generatedType === 'public' ? theme.colors.primary : (theme.colors.warning ?? '#f59e0b')}
                />
                <Text style={[styles.warningText, generatedType === 'public' && styles.infoText]}>
                  {generatedType === 'public'
                    ? 'Anyone with this link can join. You can regenerate it at any time to invalidate the old link.'
                    : 'This link can only be used once. Generate a new link for each person you want to invite.'}
                </Text>
              </View>

              <TouchableOpacity
                style={styles.regenerateButton}
                onPress={handleGenerateInvite}
                disabled={isGenerating}
              >
                {isGenerating ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <>
                    <IconSymbol name="arrow.clockwise" size={16} color={theme.colors.primary} />
                    <Text style={styles.regenerateButtonText}>Generate New Link</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>

      </View>
      {inviteLink && (
        <ShareInviteSheet
          visible={shareSheetVisible}
          onClose={() => setShareSheetVisible(false)}
          inviteLink={inviteLink}
          spaceName={spaceName}
        />
      )}
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
      textAlign: 'center',
    },
    subtitle: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      textAlign: 'center',
      marginTop: Skin.space(4),
    },
    content: {
      flex: 1,
    },
    contentInner: {
      // Bottom padding above the safe area so the last action button has
      // breathing room when the user scrolls to the end.
      paddingBottom: Math.max(insets.bottom, 16),
    },
    generateSection: {
      alignItems: 'center',
      paddingVertical: Skin.space(24),
    },
    iconContainer: {
      width: 96,
      height: 96,
      borderRadius: Skin.radius(48),
      backgroundColor: theme.colors.primary + '15',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(24),
    },
    infoText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      textAlign: 'center',
      lineHeight: Skin.font(20),
      marginBottom: Skin.space(24),
      paddingHorizontal: Skin.space(16),
    },
    inviteTypeToggle: {
      flexDirection: 'row',
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(4),
      marginBottom: Skin.space(20),
      gap: Skin.space(4),
    },
    inviteTypeButton: {
      flex: 1,
      flexDirection: 'row',
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(12),
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: Skin.radius(10),
      gap: Skin.space(6),
    },
    inviteTypeButtonActive: {
      backgroundColor: theme.colors.primary,
    },
    inviteTypeButtonText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMuted,
    },
    inviteTypeButtonTextActive: {
      color: '#fff',
    },
    infoBanner: {
      backgroundColor: theme.colors.primary + '15',
    },
    primaryButton: {
      flexDirection: 'row',
      paddingVertical: Skin.space(14),
      paddingHorizontal: Skin.space(24),
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
    linkSection: {
      flex: 1,
    },
    linkLabel: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
      marginBottom: Skin.space(8),
    },
    linkContainer: {
      backgroundColor: theme.colors.surface3,
      borderRadius: Skin.radius(12),
      padding: Skin.space(12),
      marginBottom: Skin.space(12),
      maxHeight: 120,
    },
    linkScroll: {
      maxHeight: 96,
    },
    linkInput: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      lineHeight: Skin.font(18),
    },
    linkActions: {
      flexDirection: 'row',
      gap: Skin.space(12),
      marginBottom: Skin.space(16),
    },
    actionButton: {
      flex: 1,
      flexDirection: 'row',
      paddingVertical: Skin.space(12),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.bgButtonSubtle,
      borderRadius: Skin.radius(12),
      gap: Skin.space(8),
    },
    actionButtonSuccess: {
      backgroundColor: theme.colors.success ?? '#22c55e',
    },
    actionButtonText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textMain,
    },
    actionButtonTextSuccess: {
      color: '#fff',
    },
    warningBanner: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      padding: Skin.space(12),
      backgroundColor: (theme.colors.warning ?? '#f59e0b') + '15',
      borderRadius: Skin.radius(8),
      marginBottom: Skin.space(16),
      gap: Skin.space(8),
    },
    warningText: {
      flex: 1,
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.warning ?? '#f59e0b',
      lineHeight: Skin.font(18),
    },
    regenerateButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(12),
      gap: Skin.space(8),
    },
    regenerateButtonText: {
      fontSize: Skin.font(15),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
  });
