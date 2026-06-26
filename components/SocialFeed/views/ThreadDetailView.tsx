import type { AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { parseFarcasterUrl, useFarcasterThread, type FlattenedCast } from '@/hooks/useFarcasterThread';
import { useBlockedFids } from '@/hooks/useBlockedFids';
import { useMutedFids } from '@/hooks/useMutedFids';
import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';
import { ImageViewer, AutoHeightImage, ImageCarousel, VideoPlayer, YouTubeEmbed, parseYouTubeUrl, extractYouTubeMatchesFromText } from '../media';
import { CastText, LinkPreview, QuoteCast, FrameEmbed, LikeIcon, getLikeIconType, SnapEmbed, useSnapDetection, SnapIcon } from '../content';
import { QuorumIdentityBadge } from '../content/QuorumIdentityBadge';
import { SCREEN_HEIGHT, formatTimestamp, lookupUserByUsername } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';


interface ThreadDetailViewProps {
  username: string;
  castHashPrefix: string;
  token?: string;
  currentUserFid?: number;
  theme: AppTheme;
  onClose: () => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  followStates: Map<number, boolean>;
  onFollow: (fid: number) => void;
  /** Report any cast in the thread (main + replies). When undefined the
   *  flag icon is hidden. */
  onReport?: (castHash: string, castAuthorFid?: number) => void;
  /** Opens the tip flow for a cast. When undefined the tip (snap) icon is
   *  hidden — surfaces without a mounted TipModal simply omit this. */
  onTipPress?: (target: {
    castHash: string;
    castText: string;
    authorFid: number;
    authorUsername: string;
    authorDisplayName?: string;
  }) => void;
  bottomInset?: number;
}

export function ThreadDetailView({
  username,
  castHashPrefix,
  token,
  currentUserFid,
  theme,
  onClose,
  onOpenMiniApp,
  onOpenProfile,
  onOpenChannel,
  likeStates,
  onLikeToggle,
  followStates,
  onFollow,
  onReport,
  onTipPress,
  bottomInset = 0,
}: ThreadDetailViewProps) {
  const { parentCasts, mainCast, replies, isLoading, error, channelContext } = useFarcasterThread({
    username,
    castHashPrefix,
    token,
  });

  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);
  const [selectedThread, setSelectedThread] = useState<{ username: string; castHashPrefix: string } | null>(null);
  // Replies from blocked/muted users are collapsed to a placeholder until
  // tapped. Tracks the cast hashes the viewer chose to reveal this session.
  const [revealedBlocked, setRevealedBlocked] = useState<Set<string>>(() => new Set());
  const { fids: blockedFids } = useBlockedFids();
  const { fids: mutedFids } = useMutedFids();

  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleMentionPress = async (mentionUsername: string) => {
    const fid = await lookupUserByUsername(mentionUsername);
    if (fid) {
      onOpenProfile(fid, mentionUsername);
    }
  };

  const renderCast = (cast: FlattenedCast, isMain = false) => {
    // Blocked/muted-user replies are replaced with a tap-to-reveal
    // placeholder. The main cast (the one the viewer navigated to) is
    // never hidden.
    const isBlocked =
      !isMain && cast.author.fid > 0 && blockedFids.has(cast.author.fid);
    const isMuted =
      !isMain && cast.author.fid > 0 && mutedFids.has(cast.author.fid);
    if ((isBlocked || isMuted) && !revealedBlocked.has(cast.hash)) {
      const isNestedBlocked = cast.depth > 0;
      const blockedBorderWidth = isNestedBlocked ? Math.min(cast.depth * 2, 6) : 0;
      return (
        <TouchableOpacity
          key={cast.hash}
          activeOpacity={0.7}
          onPress={() =>
            setRevealedBlocked((prev) => {
              const next = new Set(prev);
              next.add(cast.hash);
              return next;
            })
          }
          style={{
            borderTopWidth: Skin.border(1),
            borderTopColor: theme.colors.surface3,
            paddingVertical: Skin.space(14),
            borderLeftWidth: blockedBorderWidth,
            borderLeftColor: theme.colors.accent,
            paddingLeft: Skin.space(12),
            paddingRight: Skin.space(12),
            flexDirection: 'row',
            alignItems: 'center',
            gap: Skin.space(8),
          }}
        >
          <IconSymbol name="nosign" color={theme.colors.textMuted} size={16} />
          <Text style={styles.mutedText13}>
            This user has been {isBlocked ? 'blocked' : 'muted'}, tap to show message
          </Text>
        </TouchableOpacity>
      );
    }

    const imageUrls = (cast.embeds?.images ?? [])
      .map((img) => img.url)
      .filter((url): url is string => Boolean(url));
    const hasImages = imageUrls.length > 0;
    const videos = (cast.embeds?.videos ?? []).filter((v) => v.url && v.thumbnailUrl);
    const hasVideos = videos.length > 0;

    // Each URL embed renders exactly once: snap detection + frame fallback +
    // link preview happen inline below, so we don't split into separate lists.
    const frameEmbeds: { imageUrl: string; buttonTitle: string; actionUrl: string }[] = [];
    const embeddedCasts = cast.embeds?.casts ?? [];
    const urlPreviews = (cast.embeds?.urls ?? [])
      .filter((u) => {
        if (u.openGraph?.frameEmbedNext?.frameUrl || u.openGraph?.frameEmbedNext?.frameEmbed?.imageUrl) return true;
        const url = u.openGraph?.url || u.openGraph?.sourceUrl || '';
        // Drop farcaster.xyz cast links that are already shown as a quote cast
        if (url.includes('farcaster.xyz/')) {
          const parsed = parseFarcasterUrl(url);
          if (parsed) {
            const alreadyEmbedded = embeddedCasts.some((c: any) =>
              c?.hash?.toLowerCase().startsWith(parsed.castHashPrefix.toLowerCase())
            );
            if (alreadyEmbedded) return false;
          }
        }
        return u.openGraph?.title;
      });

    const isNested = cast.depth > 0;
    const borderWidth = isNested ? Math.min(cast.depth * 2, 6) : 0;

    const optimistic = likeStates.get(cast.hash);
    const isLiked = optimistic?.liked ?? cast.viewerContext?.reacted ?? false;
    const likeCount = optimistic?.count ?? (cast.reactions?.count ?? 0);

    const channelName = cast.channel?.key || cast.channel?.name ||
      (isMain && channelContext ? (channelContext.key || channelContext.name) : null) ||
      (() => {
        if (cast.parentUrl) {
          const channelMatch = cast.parentUrl.match(/(?:farcaster|warpcast)\.(?:xyz|com)\/~\/channel\/([^\/\?]+)/);
          if (channelMatch) return channelMatch[1];
        }
        return null;
      })();

    return (
      <View
        key={cast.hash}
        style={{
          borderTopWidth: isMain ? 0 : 1,
          borderTopColor: theme.colors.surface3,
          paddingTop: isMain ? 0 : 12,
          paddingBottom: Skin.space(14),
          borderLeftWidth: borderWidth,
          borderLeftColor: theme.colors.accent,
          paddingLeft: isNested ? 12 : 12,
          paddingRight: Skin.space(12),
          gap: Skin.space(10),
        }}
      >
        {/* Header row */}
        <View style={staticStyles.row}>
          {isMain && (
            <TouchableOpacity onPress={onClose} style={staticStyles.backButton}>
              <IconSymbol name="chevron.left" color={theme.colors.textMain} size={24} />
            </TouchableOpacity>
          )}
          <View style={staticStyles.avatarContainer}>
            <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
              <CachedAvatar
                source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
                style={styles.avatar}
              />
            </TouchableOpacity>
            {/* Follow button - show when not following and has valid fid */}
            {(() => {
              const isFollowing = followStates.get(cast.author.fid) ?? (cast.author.viewerContext?.following === false ? false : true);
              return !isFollowing && cast.author.fid > 0 && (
                <TouchableOpacity
                  style={styles.followBadge}
                  onPress={() => onFollow(cast.author.fid)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <IconSymbol name="plus" size={10} color="#fff" />
                </TouchableOpacity>
              );
            })()}
          </View>
          <View style={staticStyles.flex1}>
            <View style={staticStyles.rowGap6}>
              <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                <Text style={styles.displayName}>
                  {cast.author.displayName}
                </Text>
              </TouchableOpacity>
              {channelName && (
                <TouchableOpacity onPress={() => onOpenChannel(channelName)}>
                  <Text style={styles.channelName}>
                    /{channelName}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <Text style={styles.usernameTimestamp}>
              @{cast.author.username} • {formatTimestamp(cast.timestamp)}
            </Text>
            <QuorumIdentityBadge fid={cast.author.fid} theme={theme} compact />
          </View>
        </View>

        {/* Parent context */}
        {isMain && (() => {
          const isChannelUrl = cast.parentUrl?.match(/(?:farcaster|warpcast)\.(?:xyz|com)\/~\/channel\//);
          const showUrlContext = cast.parentUrl && !isChannelUrl;
          const showUserContext = cast.parentAuthor && !cast.parentUrl;

          if (!showUrlContext && !showUserContext) return null;

          return (
            <View style={staticStyles.rowGap6}>
              <IconSymbol
                name={showUrlContext ? 'link' : 'arrowshape.turn.up.left'}
                color={theme.colors.textMuted}
                size={14}
              />
              {showUrlContext ? (
                <Text style={styles.mutedText13} numberOfLines={1}>
                  replying to{' '}
                  <Text style={styles.accentText}>
                    {(() => {
                      try {
                        return new URL(cast.parentUrl!).hostname.replace('www.', '');
                      } catch {
                        return cast.parentUrl;
                      }
                    })()}
                  </Text>
                </Text>
              ) : (
                <Text style={styles.mutedText13}>
                  replying to <Text style={styles.accentText}>@{cast.parentAuthor!.username}</Text>
                </Text>
              )}
            </View>
          );
        })()}

        {/* Content */}
        {cast.text.length > 0 && (
          <CastText
            text={cast.text}
            style={styles.castText}
            theme={theme}
            enableTranslate
            onMentionPress={handleMentionPress}
            onChannelPress={onOpenChannel}
          />
        )}

        {/* Images */}
        {hasImages && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth }}>
            {imageUrls.length === 1 ? (
              <AutoHeightImage
                uri={imageUrls[0]}
                maxHeight={SCREEN_HEIGHT * 0.8}
                style={styles.imageBg}
                onPress={() => setViewerState({ images: imageUrls, index: 0 })}
              />
            ) : (
              <ImageCarousel
                urls={imageUrls}
                maxHeight={SCREEN_HEIGHT * 0.8}
                theme={theme}
                onImagePress={(_, index) => setViewerState({ images: imageUrls, index })}
              />
            )}
          </View>
        )}

        {/* Videos */}
        {hasVideos && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth }}>
            {videos.map((video, index) => (
              <VideoPlayer
                key={index}
                url={video.url!}
                thumbnailUrl={video.thumbnailUrl!}
                width={video.width}
                height={video.height}
                theme={theme}
              />
            ))}
          </View>
        )}

        {/* Frame embeds */}
        {frameEmbeds.length > 0 && (
          <View style={{ marginHorizontal: Skin.space(-12) - borderWidth, gap: Skin.space(8) }}>
            {frameEmbeds.map((frame, index) => (
              <FrameEmbed
                key={index}
                imageUrl={frame.imageUrl}
                buttonTitle={frame.buttonTitle}
                actionUrl={frame.actionUrl}
                theme={theme}
                onPress={() => onOpenMiniApp(frame.actionUrl)}
              />
            ))}
          </View>
        )}

        {/* URL previews */}
        {urlPreviews.length > 0 && (
          <View style={staticStyles.gap8}>
            {urlPreviews.map((urlEmbed, index) => (
              <ThreadUrlEmbed
                key={index}
                urlEmbed={urlEmbed}
                theme={theme}
                token={token}
                currentUserFid={currentUserFid}
                onOpenMiniApp={onOpenMiniApp}
                onOpenProfile={onOpenProfile}
              />
            ))}
          </View>
        )}

        {/* Inline YouTube URLs in cast text (deduped against explicit embeds) */}
        <InlineYouTubeFromText
          text={cast.text}
          excludeUrls={(cast.embeds?.urls ?? []).map((u: any) => u.openGraph?.url ?? u.openGraph?.sourceUrl)}
          theme={theme}
        />

        {/* Quote casts */}
        {cast.embeds?.casts && cast.embeds.casts.length > 0 && (
          <View style={staticStyles.gap8}>
            {cast.embeds.casts.map((embeddedCast, index) => (
              <QuoteCast
                key={index}
                cast={embeddedCast as EmbeddedCast}
                theme={theme}
                onPress={() => setSelectedThread({
                  username: embeddedCast.author.username,
                  castHashPrefix: embeddedCast.hash.slice(0, 10),
                })}
              />
            ))}
          </View>
        )}

        {/* Stats row */}
        <View style={staticStyles.statsRow}>
          <TouchableOpacity
            style={staticStyles.rowGap6}
            onPress={() => onLikeToggle(cast.hash, isLiked, likeCount)}
          >
            <LikeIcon
              type={getLikeIconType(cast.text)}
              isLiked={isLiked}
              color={theme.colors.textMuted}
              activeColor={theme.colors.danger}
              size={16}
            />
            {likeCount > 0 && (
              <Text style={styles.mutedText13}>{likeCount}</Text>
            )}
          </TouchableOpacity>
          <View style={staticStyles.rowGap6}>
            <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={16} />
            {(cast.replies?.count ?? 0) > 0 && (
              <Text style={styles.mutedText13}>{cast.replies?.count}</Text>
            )}
          </View>
          {onTipPress && cast.author.fid > 0 && cast.author.fid !== currentUserFid && (
            <TouchableOpacity
              style={staticStyles.rowGap6}
              onPress={() => onTipPress({
                castHash: cast.hash,
                castText: cast.text ?? '',
                authorFid: cast.author.fid,
                authorUsername: cast.author.username,
                authorDisplayName: cast.author.displayName,
              })}
              hitSlop={8}
            >
              <SnapIcon color={theme.colors.textMuted} size={16} />
            </TouchableOpacity>
          )}
          {onReport && (
            <TouchableOpacity
              style={staticStyles.rowGap6}
              onPress={() => onReport(cast.hash, cast.author?.fid)}
              hitSlop={8}
            >
              <IconSymbol name="flag" color={theme.colors.textMuted} size={16} />
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {error && !mainCast && (
        <View style={staticStyles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {mainCast ? (
        <ScrollView style={staticStyles.flex1} contentContainerStyle={{ paddingBottom: Skin.space(32) + bottomInset }}>
          {/* Parent chain — when the user taps a reply notification we
              land on the reply, but they need the conversation context
              above it to make sense of the thread. Parent casts are
              rendered above the main cast at depth 0, dimmed slightly
              by the same `depth` shading the renderer applies to
              nested replies, so the visual hierarchy is "context →
              target → discussion". */}
          {parentCasts.length > 0 && (
            <View>
              {parentCasts.map((parent) => renderCast({ ...parent, depth: 0 }))}
            </View>
          )}
          {renderCast({ ...mainCast, depth: 0 }, true)}
          {isLoading && replies.length === 0 && (
            <View style={{ padding: Skin.space(24), alignItems: 'center' }}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          )}
          {replies.length > 0 && (
            <View>
              {replies.map((reply) => renderCast(reply))}
            </View>
          )}
        </ScrollView>
      ) : isLoading ? (
        <View style={staticStyles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : null}

      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />
    </View>
  );
}

export default ThreadDetailView;

/**
 * Routes a single URL embed to the right renderer: SnapEmbed if the URL
 * responds with snap content-type, otherwise FrameEmbed if frame metadata is
 * present, otherwise a plain LinkPreview.
 */
function InlineYouTubeFromText({
  text,
  excludeUrls,
  theme,
}: {
  text: string | undefined;
  excludeUrls: (string | undefined)[];
  theme: AppTheme;
}) {
  const matches = useMemo(
    () => extractYouTubeMatchesFromText(text, excludeUrls),
    [text, excludeUrls],
  );
  if (matches.length === 0) return null;
  return (
    <View style={staticStyles.gap8}>
      {matches.map(({ url, match }) => (
        <YouTubeEmbed
          key={url}
          videoId={match.videoId}
          playlistId={match.playlistId}
          theme={theme}
        />
      ))}
    </View>
  );
}

function ThreadUrlEmbed({
  urlEmbed,
  theme,
  token,
  currentUserFid,
  onOpenMiniApp,
  onOpenProfile,
}: {
  urlEmbed: any;
  theme: AppTheme;
  token?: string;
  currentUserFid?: number;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
}) {
  const linkUrl: string | undefined = urlEmbed.openGraph?.url || urlEmbed.openGraph?.sourceUrl;
  const snapUrl: string | undefined = urlEmbed.openGraph?.frameEmbedNext?.frameUrl;
  const candidateUrl = snapUrl || linkUrl;
  const isSnap = useSnapDetection(candidateUrl);

  if (isSnap === true && candidateUrl) {
    return (
      <SnapEmbed
        url={candidateUrl}
        theme={theme}
        token={token}
        userFid={currentUserFid}
        onOpenUrl={(u) => onOpenMiniApp(u)}
        onOpenProfile={(fid) => onOpenProfile(fid)}
        onOpenMiniApp={(u) => onOpenMiniApp(u)}
      />
    );
  }

  const youTube = parseYouTubeUrl(linkUrl);
  if (youTube) {
    return <YouTubeEmbed videoId={youTube.videoId} playlistId={youTube.playlistId} theme={theme} />;
  }

  const frameEmbed = urlEmbed.openGraph?.frameEmbedNext?.frameEmbed;
  const frameImageUrl: string | undefined = frameEmbed?.imageUrl;
  const frameAction: string | undefined = frameEmbed?.button?.action?.url ?? linkUrl;
  if (frameImageUrl && frameAction) {
    return (
      <FrameEmbed
        imageUrl={frameImageUrl}
        buttonTitle={frameEmbed?.button?.title ?? 'Open'}
        actionUrl={frameAction}
        theme={theme}
        onPress={() => onOpenMiniApp(frameAction)}
      />
    );
  }

  return (
    <LinkPreview
      url={linkUrl}
      title={urlEmbed.openGraph?.title}
      description={urlEmbed.openGraph?.description}
      domain={urlEmbed.openGraph?.domain}
      image={urlEmbed.openGraph?.image}
      useLargeImage={urlEmbed.openGraph?.useLargeImage}
      theme={theme}
      onPress={linkUrl ? () => onOpenMiniApp(linkUrl) : undefined}
    />
  );
}

const staticStyles = createSkinnable(() => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowGap6: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  backButton: {
    marginRight: Skin.space(12),
  },
  avatarContainer: {
    position: 'relative',
    marginRight: Skin.space(12),
  },
  flex1: {
    flex: 1,
  },
  gap8: {
    gap: Skin.space(8),
  },
  statsRow: {
    flexDirection: 'row',
    gap: Skin.space(16),
    marginTop: Skin.space(4),
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    padding: Skin.space(20),
  },
}));

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      // Match the rest of the social feed surfaces — using `background`
      // here left the loading state showing a different color from the
      // outer feed/thread overlays which use surface1.
      backgroundColor: theme.colors.surface1,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      backgroundColor: theme.colors.surface3,
    },
    followBadge: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 18,
      height: 18,
      borderRadius: Skin.radius(9),
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.primary,
      borderWidth: Skin.border(2),
      borderColor: theme.colors.background,
    },
    displayName: {
      color: theme.colors.textStrong,
      fontWeight: '600',
      fontSize: Skin.font(15),
    },
    channelName: {
      color: theme.colors.accent,
      fontSize: Skin.font(13),
    },
    usernameTimestamp: {
      color: theme.colors.textSubtle,
      fontSize: Skin.font(13),
      marginTop: Skin.space(2),
    },
    mutedText13: {
      color: theme.colors.textSubtle,
      fontSize: Skin.font(13),
    },
    accentText: {
      color: theme.colors.accent,
    },
    castText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(20),
    },
    imageBg: {
      backgroundColor: theme.colors.surface3,
    },
    errorText: {
      color: theme.colors.danger,
    },
  });
}
