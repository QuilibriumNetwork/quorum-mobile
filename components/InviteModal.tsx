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
  getShortenedInviteLink,
  useCopyInviteLink,
  useGenerateInvite,
  useGeneratePublicInvite,
} from '@/hooks/chat/useInviteManagement';
import { getSpace, holdsSpaceOwnerKey } from '@/services/config/spaceStorage';
import { isPublicInvite } from '@/services/space/inviteService';
import { useTheme, type AppTheme } from '@/theme';
import type { EdgeInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState, useEffect } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Skin from '@/theme/skins/geometry';

interface InviteModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  spaceName: string;
}

/**
 * `generatePublicInviteLink` and `generatePrivateInviteLink` throw implementation
 * diagnostics that name internals ("Owner key not found for space…", "The invite
 * pool was not initialized.") and were rendered verbatim in the error banner.
 * Translate the two known ones. Anything unrecognised passes through unchanged,
 * so a genuinely unexpected failure keeps the only detail we have about it.
 */
function friendlyInviteError(error: unknown): string {
  const raw = error instanceof Error ? error.message : '';
  if (raw.includes('Owner key not found')) {
    return 'Only a space owner can create a public invite link for this space.';
  }
  if (raw.includes('invite pool was not initialized')) {
    return "One-time invite links aren't available for this space.";
  }
  return raw || 'Failed to generate invite';
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
  const [republished, setRepublished] = useState(false);
  const [renewed, setRenewed] = useState(false);
  const [inviteType, setInviteType] = useState<'private' | 'public'>('private');
  const [hasLoadedExistingInvite, setHasLoadedExistingInvite] = useState(false);

  const generateInviteMutation = useGenerateInvite();
  const generatePublicInviteMutation = useGeneratePublicInvite();
  const copyLinkMutation = useCopyInviteLink();

  // Only an owner may mint a link. A member reaching this modal has a public
  // link to share (the entry points are gated on exactly that), so they get a
  // read-only view: link, Copy, Share, and nothing that would fail for them.
  const isSpaceOwner = useMemo(() => holdsSpaceOwnerKey(spaceId), [spaceId]);

  // Check for existing public invite URL when modal opens
  // Only run once per modal open to avoid overriding user actions
  useEffect(() => {
    if (visible && spaceId && !hasLoadedExistingInvite) {
      const space = getSpace(spaceId);
      // Truthiness is not enough: kickUser overwrites inviteUrl with a
      // `quorum://join#…` value, which parses as no known invite format. Showing
      // it here offered a dead link to Copy and Share after any kick.
      const stored = space?.inviteUrl;
      if (stored && isPublicInvite(stored)) {
        setInviteLink(stored);
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
        // Only meaningful when replacing a link already on screen; harmless on
        // the first generate, where the link appearing is its own confirmation.
        setRenewed(true);
        setTimeout(() => setRenewed(false), 2000);
      }
    } catch (error) {
      // Failed to generate invite
    }
  }, [spaceId, inviteType, generateInviteMutation, generatePublicInviteMutation]);

  // Republishing returns the same URL, so without a transient confirmation the
  // button appears to do nothing at all.
  const handleRepublish = useCallback(async () => {
    try {
      const result = await generatePublicInviteMutation.mutateAsync({ spaceId });
      setInviteLink(result.inviteLink);
      setGeneratedType('public');
      setRepublished(true);
      setTimeout(() => setRepublished(false), 2500);
    } catch {
      // The error banner above already renders the mutation's error.
    }
  }, [spaceId, generatePublicInviteMutation]);

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
    setRepublished(false);
    setRenewed(false);
    setInviteType('private');
    setHasLoadedExistingInvite(false);
    onClose();
  }, [onClose]);

  const isGenerating = generateInviteMutation.isPending || generatePublicInviteMutation.isPending;
  const hasError = generateInviteMutation.error || generatePublicInviteMutation.error;

  return (
    /* The link view is far shorter than the generate view (one-line URL, two
       actions, a callout), so a single fixed height left a large dead area under
       the content. fillHeight is kept so the ScrollView stays bounded and can
       still scroll at large font scales. */
    <BaseModal
      visible={visible}
      onClose={handleClose}
      height={!isSpaceOwner ? (inviteLink ? 0.4 : 0.35) : inviteLink ? 0.5 : 0.65}
      fillHeight
      avoidKeyboard
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>Invite to {spaceName}</Text>
          <Text style={styles.subtitle}>
            {isSpaceOwner
              ? 'Generate a link to invite others to this space'
              : 'Share this space with someone new'}
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
          {!inviteLink && !isSpaceOwner ? (
            /* Should be unreachable: every entry point is gated on the same
               `canInviteToSpace` rule, so a member only gets here when a valid
               public link exists. Deliberately not a designed empty state —
               just an honest line instead of a blank sheet if the link is
               withdrawn while the modal is open. */
            <View style={styles.generateSection}>
              <View style={styles.iconContainer}>
                <IconSymbol name="link" size={48} color={theme.colors.textMuted} />
              </View>
              <Text style={styles.infoText}>
                This space has no invite link to share right now. Only a space
                owner can create one.
              </Text>
            </View>
          ) : !inviteLink ? (
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
                    name="person"
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
                  <Text style={styles.errorBannerText}>{friendlyInviteError(hasError)}</Text>
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

              {/* One line, elided in the MIDDLE: the head shows which app the link
                  opens and the tail keeps it visually distinct from another space's
                  link. The full string is never something a user reads or retypes,
                  so wrapping it over four rows only cost height and legibility. */}
              <View style={styles.linkContainer}>
                <Text style={styles.linkInput} numberOfLines={1}>
                  {getShortenedInviteLink(inviteLink)}
                </Text>
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

              {/* Owner-only. The callout distinguishes a public link from a
                  one-time one, which is a distinction only whoever minted it
                  has to make. A member has one link and two things to do with
                  it, so the same text reads as filler. */}
              {isSpaceOwner && (
                <View style={[styles.warningBanner, generatedType === 'public' && styles.infoBanner]}>
                  <IconSymbol
                    name={generatedType === 'public' ? 'info.circle' : 'exclamationmark.circle'}
                    size={16}
                    color={generatedType === 'public' ? theme.colors.primary : (theme.colors.warning ?? '#f59e0b')}
                  />
                  {/* NOT styles.infoText here: that style belongs to the generate
                      screen's standalone description and carries textAlign:'center'
                      plus a 24pt bottom margin, which inside this banner read as a
                      centred paragraph with a mystery gap under it. */}
                  <Text style={[styles.warningText, generatedType === 'public' && styles.infoBannerText]}>
                    {generatedType === 'public'
                      ? 'Anyone with this link can join, and it does not expire.'
                      : 'This link can only be used once. Generate a new link for each person you want to invite.'}
                  </Text>
                </View>
              )}

              {/* Republishing can fail too, and the banner in the generate view
                  above is not rendered here — so without this the only feedback
                  from a failed republish was the spinner stopping. */}
              {isSpaceOwner && hasError && (
                <View style={styles.errorBanner}>
                  <IconSymbol
                    name="exclamationmark.triangle.fill"
                    size={16}
                    color={theme.colors.danger}
                  />
                  <Text style={styles.errorBannerText}>{friendlyInviteError(hasError)}</Text>
                </View>
              )}

              {/* A member may share the link but never mint one, so neither
                  maintenance control is theirs. */}
              {!isSpaceOwner ? null : generatedType === 'public' ? (
                /* Republishing is maintenance, not part of sharing: it refreshes the
                   server-side eval and manifest and returns the byte-identical URL.
                   Naming the SITUATION rather than the mechanism is what makes it
                   self-explanatory — someone whose link works has no question to ask,
                   and someone whose invitee is stuck recognises their case instantly.
                   That is why this needs no confirmation step. */
                <TouchableOpacity
                  style={styles.troubleshootRow}
                  onPress={handleRepublish}
                  disabled={isGenerating}
                  accessibilityRole="button"
                  accessibilityLabel="Link not working? Republish it"
                >
                  {isGenerating ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : republished ? (
                    <>
                      <IconSymbol
                        name="checkmark"
                        size={14}
                        color={theme.colors.success ?? '#22c55e'}
                      />
                      <Text style={styles.troubleshootDone}>Link republished</Text>
                    </>
                  ) : (
                    <>
                      <Text style={styles.troubleshootLabel}>Link not working?</Text>
                      <Text style={styles.troubleshootAction}>Republish</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={styles.regenerateButton}
                  onPress={handleGenerateInvite}
                  disabled={isGenerating}
                >
                  {/* Same reasoning as the settings sheet: two one-time links look
                      identical to the eye, so success has to be stated. */}
                  {isGenerating ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : renewed ? (
                    <>
                      <IconSymbol
                        name="checkmark"
                        size={16}
                        color={theme.colors.success ?? '#22c55e'}
                      />
                      <Text style={styles.troubleshootDone}>New link ready</Text>
                    </>
                  ) : (
                    <>
                      <IconSymbol name="arrow.clockwise" size={16} color={theme.colors.primary} />
                      <Text style={styles.regenerateButtonText}>Generate New Link</Text>
                    </>
                  )}
                </TouchableOpacity>
              )}
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
      color: theme.colors.textSubtle,
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
      borderRadius: Skin.circleOrSquare(48),
      backgroundColor: theme.colors.primary + '15',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: Skin.space(24),
    },
    infoText: {
      fontSize: Skin.font(14),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
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
      color: theme.colors.textSubtle,
    },
    inviteTypeButtonTextActive: {
      color: '#fff',
    },
    infoBanner: {
      backgroundColor: theme.colors.primary + '15',
    },
    // Colour-only override of warningText. Deliberately does NOT reuse infoText,
    // whose centring and bottom margin are meant for the generate screen.
    infoBannerText: {
      color: theme.colors.primary,
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
      paddingHorizontal: Skin.space(14),
      paddingVertical: Skin.space(12),
      marginBottom: Skin.space(12),
      justifyContent: 'center',
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
    // Subordinate on purpose: a maintenance action rendered as prominently as
    // Copy and Share is what made users ask what it was for.
    troubleshootRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: Skin.space(10),
      gap: Skin.space(6),
    },
    troubleshootLabel: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textSubtle,
    },
    troubleshootAction: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.primary,
    },
    troubleshootDone: {
      fontSize: Skin.font(13),
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.success ?? '#22c55e',
    },
  });
