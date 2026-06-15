import type { AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useFarcasterChannel, type ChannelCast } from '@/hooks/useFarcasterChannel';
import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';
import { ImageViewer, AutoHeightImage, ImageCarousel, VideoPlayer } from '../media';
import { CastText, LinkPreview, QuoteCast, FrameEmbed, LikeIcon, getLikeIconType } from '../content';
import { QuorumIdentityBadge } from '../content/QuorumIdentityBadge';
import { SCREEN_WIDTH, SCREEN_HEIGHT, formatTimestamp, lookupUserByUsername } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface ChannelViewProps {
  channelKey: string;
  token?: string;
  theme: AppTheme;
  onClose: () => void;
  onOpenThread: (username: string, hashPrefix: string) => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
  bottomInset?: number;
}

export function ChannelView({
  channelKey,
  token,
  theme,
  onClose,
  onOpenThread,
  onOpenMiniApp,
  onOpenProfile,
  onOpenChannel,
  likeStates,
  onLikeToggle,
  bottomInset = 0,
}: ChannelViewProps) {
  const {
    channel,
    casts,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useFarcasterChannel({ channelKey, token });

  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleMentionPress = async (username: string) => {
    const fid = await lookupUserByUsername(username);
    if (fid) {
      onOpenProfile(fid, username);
    }
  };

  const renderChannelHeader = () => {
    const frameEmbed = channel?.headerActionMetadata?.frameEmbedNext?.frameEmbed;
    const miniAppUrl = frameEmbed?.button?.action?.url;
    const miniAppTitle = frameEmbed?.button?.title || channel?.headerAction?.title;

    return (
      <View style={styles.headerBackground}>
        {/* Header Image */}
        {channel?.headerImageUrl && (
          <Image
            source={{ uri: channel.headerImageUrl }}
            style={styles.headerImage}
            contentFit="cover"
            cachePolicy="disk"
          />
        )}

        {/* Back button overlay */}
        <TouchableOpacity
          onPress={onClose}
          style={staticStyles.backButton}
        >
          <IconSymbol name="chevron.left" color="#fff" size={20} />
        </TouchableOpacity>

        {/* Channel Info */}
        <View style={[staticStyles.channelInfoContainer, { marginTop: channel?.headerImageUrl ? -24 : 0 }]}>
          <View style={staticStyles.channelInfoRow}>
            {channel?.imageUrl ? (
              <Image
                source={{ uri: channel.imageUrl }}
                style={[
                  styles.channelImage,
                  { borderWidth: channel?.headerImageUrl ? 3 : 0 },
                ]}
                cachePolicy="disk"
              />
            ) : (
              <View style={styles.channelImagePlaceholder}>
                <Text style={staticStyles.channelImagePlaceholderText}>
                  /{channelKey.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <View style={staticStyles.channelNameContainer}>
              <Text style={styles.channelName}>
                /{channel?.name || channelKey}
              </Text>
            </View>
          </View>

          {/* Description */}
          {channel?.description && (
            <Text style={styles.channelDescription}>
              {channel.description}
            </Text>
          )}

          {/* Channel stats */}
          <View style={staticStyles.statsRow}>
            {channel?.followerCount !== undefined && (
              <View style={staticStyles.statItem}>
                <Text style={styles.statCount}>
                  {channel.followerCount.toLocaleString()}
                </Text>
                <Text style={styles.statLabel}>Followers</Text>
              </View>
            )}
            {channel?.memberCount !== undefined && (
              <View style={staticStyles.statItem}>
                <Text style={styles.statCount}>
                  {channel.memberCount.toLocaleString()}
                </Text>
                <Text style={styles.statLabel}>Members</Text>
              </View>
            )}
          </View>

          {/* Mini App Button */}
          {miniAppUrl && miniAppTitle && (
            <TouchableOpacity
              onPress={() => onOpenMiniApp(miniAppUrl)}
              style={styles.miniAppButton}
            >
              <IconSymbol name="play.fill" color="#fff" size={16} />
              <Text style={staticStyles.miniAppButtonText}>
                {miniAppTitle}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.headerDivider} />
      </View>
    );
  };

  const renderCast = (cast: ChannelCast) => {
    const imageUrls = (cast.embeds?.images ?? [])
      .map((img) => img.url)
      .filter((url): url is string => Boolean(url));
    const hasImages = imageUrls.length > 0;
    const videos = (cast.embeds?.videos ?? []).filter((v) => v.url && v.thumbnailUrl);
    const hasVideos = videos.length > 0;

    const frameEmbeds = (cast.embeds?.urls ?? [])
      .filter((u) => u.openGraph?.frameEmbedNext?.frameEmbed)
      .map((u) => ({
        imageUrl: u.openGraph!.frameEmbedNext!.frameEmbed!.imageUrl!,
        buttonTitle: u.openGraph!.frameEmbedNext!.frameEmbed!.button?.title ?? 'Open',
        actionUrl: u.openGraph!.frameEmbedNext!.frameEmbed!.button?.action?.url ?? u.openGraph!.url!,
      }))
      .filter((f) => f.imageUrl);

    const urlPreviews = (cast.embeds?.urls ?? [])
      .filter((u) => u.openGraph?.title && !u.openGraph?.frameEmbedNext?.frameEmbed);

    const quoteCasts = cast.embeds?.casts ?? [];

    const navigateToThread = () => {
      if (cast.author.username && cast.hash) {
        onOpenThread(cast.author.username, cast.hash.slice(0, 10));
      }
    };

    const optimistic = likeStates.get(cast.hash);
    const isLiked = optimistic?.liked ?? cast.viewerContext?.reacted ?? false;
    const likeCount = optimistic?.count ?? (cast.reactions?.count ?? 0);

    return (
      <View
        key={cast.hash}
        style={styles.castContainer}
      >
        <Pressable onPress={navigateToThread}>
          <View style={staticStyles.castHeaderRow}>
            <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
              <CachedAvatar
                source={cast.author.pfp?.url ? { uri: cast.author.pfp.url } : null}
                style={styles.castAvatar}
              />
            </TouchableOpacity>
            <View style={staticStyles.flex1}>
              <View style={staticStyles.castAuthorRow}>
                <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                  <Text style={styles.castAuthorName}>
                    {cast.author.displayName}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.castAuthorMeta}>
                @{cast.author.username} • {formatTimestamp(cast.timestamp)}
              </Text>
              <QuorumIdentityBadge fid={cast.author.fid} theme={theme} compact />
            </View>
          </View>
        </Pressable>

        <Pressable onPress={navigateToThread}>
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
        </Pressable>

        {hasImages && (
          <View style={staticStyles.mediaContainer}>
            {imageUrls.length === 1 ? (
              <AutoHeightImage
                uri={imageUrls[0]}
                maxHeight={SCREEN_HEIGHT * 0.8}
                style={styles.imagePlaceholderBg}
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

        {hasVideos && (
          <View style={staticStyles.mediaContainer}>
            {videos.map((video, index) => (
              <VideoPlayer
                key={index}
                url={video.url!}
                thumbnailUrl={video.thumbnailUrl!}
                width={video.width}
                height={video.height}
                duration={video.duration}
                theme={theme}
              />
            ))}
          </View>
        )}

        {frameEmbeds.length > 0 && (
          <View style={staticStyles.frameEmbedsContainer}>
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

        {urlPreviews.length > 0 && (
          <View style={staticStyles.gap8}>
            {urlPreviews.map((urlEmbed, index) => {
              const linkUrl = urlEmbed.openGraph?.url || urlEmbed.openGraph?.sourceUrl;
              return (
                <LinkPreview
                  key={index}
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
            })}
          </View>
        )}

        {quoteCasts.length > 0 && (
          <View style={staticStyles.gap8}>
            {quoteCasts.map((embeddedCast, index) => (
              <QuoteCast
                key={index}
                cast={embeddedCast as EmbeddedCast}
                theme={theme}
                onPress={() => onOpenThread(embeddedCast.author.username, embeddedCast.hash.slice(0, 10))}
              />
            ))}
          </View>
        )}

        <View style={staticStyles.actionsRow}>
          <TouchableOpacity
            style={staticStyles.actionButton}
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
              <Text style={styles.actionCount}>{likeCount}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={staticStyles.actionButton}
            onPress={navigateToThread}
          >
            <IconSymbol name="bubble.left" color={theme.colors.textMuted} size={16} />
            {(cast.replies?.count ?? 0) > 0 && (
              <Text style={styles.actionCount}>{cast.replies?.count}</Text>
            )}
          </TouchableOpacity>
          <View style={staticStyles.actionButton}>
            <IconSymbol
              name="arrow.triangle.2.circlepath"
              color={cast.viewerContext?.recast ? theme.colors.success : theme.colors.textMuted}
              size={16}
            />
            {(cast.recasts?.count ?? 0) > 0 && (
              <Text style={styles.actionCount}>{cast.recasts?.count}</Text>
            )}
          </View>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {isLoading && casts.length === 0 && (
        <View style={staticStyles.loadingContainer}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      )}

      {error && (
        <View style={staticStyles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <FlashList
        data={casts}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={renderChannelHeader}
        renderItem={({ item }) => renderCast(item)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: Skin.space(32) + bottomInset }}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) {
            fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={staticStyles.footerLoading}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
      />

      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />
    </View>
  );
}

export default ChannelView;

const staticStyles = createSkinnable(() => StyleSheet.create({
  backButton: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: Skin.radius(20),
    padding: Skin.space(8),
    zIndex: 10,
  },
  channelInfoContainer: {
    padding: Skin.space(16),
  },
  channelInfoRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  channelImagePlaceholderText: {
    color: '#fff',
    fontSize: Skin.font(24),
    fontWeight: '700',
  },
  channelNameContainer: {
    flex: 1,
    paddingBottom: Skin.space(4),
  },
  statsRow: {
    flexDirection: 'row',
    gap: Skin.space(16),
    marginTop: Skin.space(12),
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
  },
  miniAppButtonText: {
    color: '#fff',
    fontSize: Skin.font(15),
    fontWeight: '600',
  },
  castHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex1: {
    flex: 1,
  },
  castAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  mediaContainer: {
    marginHorizontal: Skin.space(-12),
  },
  frameEmbedsContainer: {
    marginHorizontal: Skin.space(-12),
    gap: Skin.space(8),
  },
  gap8: {
    gap: Skin.space(8),
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Skin.space(16),
    marginTop: Skin.space(4),
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    padding: Skin.space(20),
  },
  footerLoading: {
    paddingVertical: Skin.space(20),
    alignItems: 'center',
  },
}));

function createStyles(theme: AppTheme) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    headerBackground: {
      backgroundColor: theme.colors.background,
    },
    headerImage: {
      width: SCREEN_WIDTH,
      height: 100,
      backgroundColor: theme.colors.surface3,
    },
    channelImage: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(12),
      marginRight: Skin.space(12),
      backgroundColor: theme.colors.surface3,
      borderColor: theme.colors.background,
    },
    channelImagePlaceholder: {
      width: 64,
      height: 64,
      borderRadius: Skin.radius(12),
      marginRight: Skin.space(12),
      backgroundColor: theme.colors.accent,
      justifyContent: 'center',
      alignItems: 'center',
    },
    channelName: {
      color: theme.colors.textStrong,
      fontSize: Skin.font(22),
      fontWeight: '700',
    },
    channelDescription: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(21),
      marginTop: Skin.space(12),
    },
    statCount: {
      color: theme.colors.textStrong,
      fontWeight: '600',
      fontSize: Skin.font(15),
    },
    statLabel: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(14),
    },
    miniAppButton: {
      backgroundColor: theme.colors.accent,
      borderRadius: Skin.radius(20),
      paddingVertical: Skin.space(10),
      paddingHorizontal: Skin.space(20),
      marginTop: Skin.space(16),
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(8),
    },
    headerDivider: {
      height: 1,
      backgroundColor: theme.colors.surface3,
    },
    castContainer: {
      borderBottomWidth: Skin.border(1),
      borderBottomColor: theme.colors.surface3,
      paddingTop: Skin.space(12),
      paddingBottom: Skin.space(14),
      paddingHorizontal: Skin.space(12),
      gap: Skin.space(10),
    },
    castAvatar: {
      width: 44,
      height: 44,
      borderRadius: Skin.radius(22),
      marginRight: Skin.space(12),
      backgroundColor: theme.colors.surface3,
    },
    castAuthorName: {
      color: theme.colors.textStrong,
      fontWeight: '600',
      fontSize: Skin.font(15),
    },
    castAuthorMeta: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
      marginTop: Skin.space(2),
    },
    castText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(20),
    },
    imagePlaceholderBg: {
      backgroundColor: theme.colors.surface3,
    },
    actionCount: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
    },
    errorText: {
      color: theme.colors.danger,
    },
  });
}
