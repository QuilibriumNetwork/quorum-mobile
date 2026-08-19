/**
 * DMChatHeader — the top bar for a direct-message conversation.
 *
 * A thin composition over ScreenHeader, which owns all header geometry and
 * explains why these bars are drawn in React Native rather than by the native
 * navigation stack. Only the DM-specific content lives here: a tappable
 * avatar + name that opens the counterparty's profile, and the call/settings
 * controls (all suppressed for Farcaster conversations, which have neither).
 *
 * Two identity namespaces meet in this one bar, and the rule for keeping them
 * apart is the same one the feed surfaces follow:
 *
 *   Quorum DM      → the name IS the ladder's answer (roster → `.q` → global).
 *   Farcaster DM   → the name is Farcaster's own, and a linked Quorum `.q`
 *                    appears BENEATH it as a badge, never in place of it.
 *
 * The badge is reached by looking the fid up against the server's fid→address
 * link and resolving that address; the fid itself is never a ladder input.
 */

import type { AppTheme } from '@/theme';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { ScreenHeader, headerIconHitSlop } from '@/components/ui/ScreenHeader';
import { QuorumIdentityBadge } from '@/components/SocialFeed/content/QuorumIdentityBadge';
import { useResolvedName } from '@/identity';
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';

interface DMChatHeaderProps {
  /** Avatar URL, if the conversation has one. */
  icon?: string;
  /** Counterparty address. For a Quorum conversation the header resolves its
   *  own display name from this (global scope — a DM has no per-space
   *  nickname) rather than trusting a name string the caller already computed,
   *  so the title text and the avatar's initials can never disagree about who
   *  this conversation is with. Also feeds the deterministic initials avatar
   *  fallback, which it still does for Farcaster (a stable per-conversation
   *  colour seed, not a name lookup). */
  address: string;
  /** The conversation's own title, used ONLY when `isFarcasterConversation`.
   *  A Farcaster conversation's `address` is a synthetic `fid:<n>` string, so
   *  there is nothing there for the Quorum resolver to resolve — and handing
   *  it one anyway does not fail loudly: no tier matches, the truncating
   *  fallback returns the short string unchanged, and the header renders
   *  "fid:1043504" where a name belongs. Farcaster carries its own name
   *  (`fc.name ?? counterParty.displayName ?? counterParty.username`), and
   *  this is it. A linked Quorum `.q` does not come from here — it is reached
   *  by resolving the ADDRESS behind the fid, and is shown as a badge next to
   *  the Farcaster name rather than replacing it. */
  displayName?: string;
  /** Safe-area top inset — the bar paints into the status bar area itself. */
  insetTop: number;
  onBack: () => void;
  /** Tapping the avatar or name opens the same profile modal an in-chat pfp does. */
  onTitlePress: () => void;
  /**
   * Farcaster DMs are read through the upstream API and support neither calls
   * nor our DM settings, so the whole trailing group is dropped for them.
   */
  isFarcasterConversation: boolean;
  /**
   * The counterparty's Farcaster fid, for a ONE-TO-ONE Farcaster DM only.
   * Drives the linked-Quorum-identity badge under the name, so a Farcaster
   * contact who also uses Quorum is recognisable here the same way they are
   * in the feed.
   *
   * Omitted for a group, where the header names the GROUP and there is no
   * single counterparty a badge could describe — `farcasterFid` is populated
   * from `viewerContext.counterParty` even then, so gating on it alone would
   * pin one arbitrary member's Quorum identity to the whole conversation.
   *
   * Safe to `enrich` on: the badge issues one fid→address lookup per mount and
   * this header mounts exactly one, which is the bounded fan-out the badge's
   * own prop doc requires of its caller. The uncapped case it warns about is a
   * feed rendering hundreds of casts at once, not a single conversation title.
   */
  farcasterFid?: number;
  onVideoCall: () => void;
  onAudioCall: () => void;
  onOpenSettings: () => void;
  /** Dev-only test-burst affordance; pass undefined outside __DEV__. */
  onDevBurst?: () => void;
  theme: AppTheme;
}

export const DMChatHeader = React.memo(function DMChatHeader({
  icon,
  address,
  displayName,
  insetTop,
  onBack,
  onTitlePress,
  isFarcasterConversation,
  farcasterFid,
  onVideoCall,
  onAudioCall,
  onOpenSettings,
  onDevBurst,
  theme,
}: DMChatHeaderProps) {
  const styles = React.useMemo(() => createStyles(theme), [theme]);
  // `global`: a DM has no per-space nickname. `enrich`: bounded to exactly one
  // address per mount (this header renders one conversation at a time), so
  // the profile fetch that makes a `.q` possible here is affordable.
  //
  // The empty address for a Farcaster conversation is how the resolver is
  // told there is nothing to resolve — the hook still runs unconditionally
  // (Rules of Hooks), it just resolves nothing and issues no fetch. Same
  // technique the DM screen already uses for its own copy of this ladder.
  const resolvedQuorumName = useResolvedName(isFarcasterConversation ? '' : address, {
    global: true,
    enrich: true,
  });
  const title = isFarcasterConversation ? (displayName || 'Unknown') : resolvedQuorumName;

  return (
    <ScreenHeader
      insetTop={insetTop}
      onBack={onBack}
      accessibilityBackLabel="Back to messages"
      theme={theme}
      title={
        <TouchableOpacity
          onPress={onTitlePress}
          activeOpacity={0.7}
          hitSlop={8}
          style={styles.titleRow}
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}'s profile`}
        >
          {icon ? (
            <Image source={{ uri: icon }} style={styles.avatar} />
          ) : (
            <DefaultAvatar resolvedName={title} address={address} size={28} />
          )}
          <View style={styles.nameColumn}>
            <Text style={styles.name} numberOfLines={1}>
              {title}
            </Text>
            {/* Renders nothing at all when this fid has no linked Quorum
                identity, which is the common case — so the bar stays a plain
                single-line title for an ordinary Farcaster contact and only
                grows the second line for someone who merged their profiles. */}
            {isFarcasterConversation && farcasterFid ? (
              <QuorumIdentityBadge fid={farcasterFid} theme={theme} compact enrich />
            ) : null}
          </View>
        </TouchableOpacity>
      }
      right={
        isFarcasterConversation ? undefined : (
          <>
            {onDevBurst && (
              <TouchableOpacity
                onPress={onDevBurst}
                hitSlop={headerIconHitSlop}
                accessibilityRole="button"
                accessibilityLabel="DM test burst (dev)"
              >
                <IconSymbol name="flask" color={theme.colors.textMuted} size={20} />
              </TouchableOpacity>
            )}
            <TouchableOpacity
              onPress={onVideoCall}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Start a video call"
            >
              <IconSymbol name="video" color={theme.colors.primary} size={20} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onAudioCall}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Start a voice call"
            >
              <IconSymbol name="phone" color={theme.colors.primary} size={20} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onOpenSettings}
              hitSlop={headerIconHitSlop}
              accessibilityRole="button"
              accessibilityLabel="Conversation settings"
            >
              <IconSymbol name="gearshape" color={theme.colors.textMain} size={20} />
            </TouchableOpacity>
          </>
        )
      }
    />
  );
});

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(8),
      minWidth: 0,
    },
    avatar: {
      width: 28,
      height: 28,
      borderRadius: Skin.circleOrSquare(14),
      backgroundColor: theme.colors.surface5,
    },
    // Stacks the name over the linked-identity badge. `minWidth: 0` is what
    // lets the name actually truncate instead of pushing the trailing controls
    // off the bar — a flex child's default min-width is its content.
    nameColumn: {
      flexShrink: 1,
      minWidth: 0,
      justifyContent: 'center',
    },
    name: {
      flexShrink: 1,
      ...theme.textStyles.headline,
      fontFamily: theme.fonts.bold.fontFamily,
      fontWeight: theme.fonts.bold.fontWeight,
      color: theme.colors.textMain,
    },
  });

export default DMChatHeader;
