/**
 * FarcasterCastCard - Renders a Farcaster cast link as an embedded preview
 *
 * Detects Farcaster/Warpcast links in messages and renders them as rich cards
 * showing the cast author, text, and images.
 */

import { IconSymbol } from '@/components/ui/IconSymbol';
import { useFarcasterThread, parseFarcasterUrl, type ThreadCast } from '@/hooks/useFarcasterThread';
import { useTheme, type AppTheme } from '@/theme';
import { isScamCast } from '@/services/farcaster/scamFilter';
import React from 'react';
import {
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Image } from 'expo-image';

// Valid Farcaster URL patterns
const FARCASTER_URL_PATTERNS = [
  /https?:\/\/(?:www\.)?warpcast\.com\/([^\/]+)\/([0-9a-fA-Fx]+)/,
  /https?:\/\/(?:www\.)?farcaster\.xyz\/([^\/]+)\/(0x[a-fA-F0-9]+)/,
];

/**
 * Check if a string contains a Farcaster cast link
 */
export function containsFarcasterLink(text: string): boolean {
  return FARCASTER_URL_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Extract Farcaster link from text
 */
export function extractFarcasterLink(text: string): string | null {
  for (const pattern of FARCASTER_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[0];
    }
  }
  return null;
}

/**
 * Parse a Farcaster URL to get username and cast hash
 */
export function parseFarcasterCastUrl(url: string): { username: string; castHash: string } | null {
  for (const pattern of FARCASTER_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      return {
        username: match[1],
        castHash: match[2],
      };
    }
  }
  return null;
}

/**
 * Strip Farcaster link from text, returning the remaining content
 */
export function stripFarcasterLink(text: string): string | null {
  const link = extractFarcasterLink(text);
  if (!link) return text;

  const stripped = text.replace(link, '').trim();
  return stripped.length > 0 ? stripped : null;
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return 'now';
}

interface FarcasterCastCardProps {
  /** Either supply a URL (the card will fetch the cast)… */
  url?: string;
  /** …or pass an already-fetched cast object directly. */
  cast?: any;
  /** Optional channel-key tag shown above the author when supplied. */
  channelKey?: string;
  /** When true, the card stretches to fill its container instead of capping
   *  at 320px. Used for top-level chat-stream items so they align flush. */
  fullWidth?: boolean;
  onPress?: (username: string, castHashPrefix: string) => void;
  /** Long-press handler — used by the chat stream to open the action sheet. */
  onLongPress?: () => void;
}

export function FarcasterCastCard({ url, cast: providedCast, channelKey, fullWidth = false, onPress, onLongPress }: FarcasterCastCardProps) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Parse the URL to get username and cast hash (only when a URL was provided)
  const parsed = url ? parseFarcasterCastUrl(url) : null;

  // Fetch the cast data only if we don't already have one
  const { mainCast, isLoading, error } = useFarcasterThread({
    username: parsed?.username ?? '',
    castHashPrefix: parsed?.castHash ?? '',
    enabled: !!parsed && !providedCast,
  });

  // Use the supplied cast first, fall back to fetched
  const cast = providedCast ?? mainCast;

  // Suppress wallet-drainer typo-squat casts (hyrpia.xyz). See
  // services/farcaster/scamFilter.ts. This is the chat-stream embed
  // path; list-level paths (feed, thread) filter the source array.
  if (cast && isScamCast(cast as unknown as Parameters<typeof isScamCast>[0])) {
    return null;
  }

  const handlePress = () => {
    if (onPress) {
      const username = cast?.author?.username ?? parsed?.username;
      const castHash = cast?.hash ?? parsed?.castHash;
      if (username && castHash) {
        onPress(username, castHash.slice(0, 10));
        return;
      }
    }
    if (url) {
      Linking.openURL(url);
    }
  };

  // Error state
  if (error) {
    return (
      <TouchableOpacity style={styles.errorContainer} onPress={handlePress}>
        <IconSymbol name="link" size={16} color={theme.colors.textMuted} />
        <Text style={styles.errorText} numberOfLines={1}>
          {url}
        </Text>
      </TouchableOpacity>
    );
  }

  // Loading state
  if (isLoading || !cast) {
    return (
      <View style={styles.container}>
        <View style={styles.skeletonHeader}>
          <View style={styles.skeletonAvatar} />
          <View style={styles.skeletonName} />
        </View>
        <View style={styles.skeletonText} />
        <View style={styles.skeletonTextShort} />
      </View>
    );
  }

  const hasImage = cast.embeds?.images && cast.embeds.images.length > 0;
  const imageUrl = hasImage ? cast.embeds?.images?.[0]?.url : null;

  return (
    <TouchableOpacity
      style={[styles.container, fullWidth && { maxWidth: undefined, width: '100%' }]}
      onPress={handlePress}
      onLongPress={onLongPress}
      delayLongPress={300}
      activeOpacity={0.8}
    >
      {channelKey && (
        <View style={styles.channelTag}>
          <IconSymbol name="number" size={11} color={theme.colors.accent} />
          <Text style={styles.channelTagText}>/{channelKey}</Text>
        </View>
      )}
      {/* Header with author info */}
      <View style={styles.header}>
        <Image
          source={
            cast.author.pfp?.url
              ? { uri: cast.author.pfp.url }
              : require('../../assets/images/quorum-symbol-bg-blue.png')
          }
          style={styles.avatar}
        />
        <View style={styles.authorInfo}>
          <Text style={styles.displayName} numberOfLines={1}>
            {cast.author.displayName}
          </Text>
          <Text style={styles.username} numberOfLines={1}>
            @{cast.author.username}
          </Text>
        </View>
        <Text style={styles.timestamp}>
          {formatRelativeTime(cast.timestamp)}
        </Text>
        <IconSymbol name="arrow.up.right" size={14} color={theme.colors.textMuted} />
      </View>

      {/* Cast text */}
      <Text style={styles.castText} numberOfLines={4}>
        {cast.text}
      </Text>

      {/* Image preview */}
      {imageUrl && (
        <Image
          source={{ uri: imageUrl }}
          style={styles.image}
          contentFit="cover"
        />
      )}

      {/* Footer with engagement */}
      <View style={styles.footer}>
        <View style={styles.statItem}>
          <IconSymbol name="bubble.left" size={14} color={theme.colors.textMuted} />
          <Text style={styles.statText}>{cast.replies?.count ?? 0}</Text>
        </View>
        <View style={styles.statItem}>
          <IconSymbol name="arrow.2.squarepath" size={14} color={theme.colors.textMuted} />
          <Text style={styles.statText}>{cast.recasts?.count ?? 0}</Text>
        </View>
        <View style={styles.statItem}>
          <IconSymbol name="heart" size={14} color={theme.colors.textMuted} />
          <Text style={styles.statText}>{cast.reactions?.count ?? 0}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border,
      overflow: 'hidden',
      marginTop: 8,
      maxWidth: 320,
    },
    channelTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 12,
      paddingTop: 8,
    },
    channelTagText: {
      fontSize: 11,
      fontWeight: '600',
      color: theme.colors.accent,
      letterSpacing: 0.3,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      paddingBottom: 8,
    },
    avatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.colors.surface3,
      marginRight: 8,
    },
    authorInfo: {
      flex: 1,
    },
    displayName: {
      fontSize: 14,
      fontFamily: theme.fonts.medium.fontFamily,
      fontWeight: theme.fonts.medium.fontWeight,
      color: theme.colors.textStrong,
    },
    username: {
      fontSize: 13,
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    timestamp: {
      fontSize: 12,
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
      marginRight: 4,
    },
    castText: {
      fontSize: 14,
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMain,
      lineHeight: 20,
      paddingHorizontal: 12,
      paddingBottom: 8,
    },
    image: {
      width: '100%',
      height: 160,
      backgroundColor: theme.colors.surface3,
    },
    footer: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.surface3,
      gap: 16,
    },
    statItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    statText: {
      fontSize: 12,
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    errorContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.surface3,
      borderRadius: 8,
      padding: 10,
      marginTop: 8,
      gap: 8,
      maxWidth: 320,
    },
    errorText: {
      flex: 1,
      fontSize: 13,
      fontFamily: theme.fonts.regular.fontFamily,
      color: theme.colors.textMuted,
    },
    // Skeleton loading styles
    skeletonHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 12,
      paddingBottom: 8,
    },
    skeletonAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      marginRight: 8,
    },
    skeletonName: {
      width: 120,
      height: 16,
      borderRadius: 4,
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
    },
    skeletonText: {
      width: '90%',
      height: 14,
      borderRadius: 4,
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      marginHorizontal: 12,
      marginBottom: 6,
    },
    skeletonTextShort: {
      width: '60%',
      height: 14,
      borderRadius: 4,
      backgroundColor: theme.colors.surface5 ?? theme.colors.surface3,
      marginHorizontal: 12,
      marginBottom: 12,
    },
  });

export default FarcasterCastCard;
