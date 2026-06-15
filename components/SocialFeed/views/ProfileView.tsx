import type { AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { Image } from 'expo-image';
import { FlashList } from '@shopify/flash-list';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useFarcasterProfile, type ProfileCast } from '@/hooks/useFarcasterProfile';
import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';
import { ImageViewer, AutoHeightImage, ImageCarousel, VideoPlayer } from '../media';
import { CastText, LinkPreview, QuoteCast, FrameEmbed, LikeIcon, getLikeIconType } from '../content';
import { QuorumIdentityBadge } from '../content/QuorumIdentityBadge';
import { ProfileOverflowButton } from '../ProfileOverflowButton';
import { ProfileActionButtons } from '../ProfileActionButtons';
import { SCREEN_WIDTH, SCREEN_HEIGHT, formatTimestamp, lookupUserByUsername } from '../utils';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface ProfileViewProps {
  fid: number;
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

export function ProfileView({
  fid,
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
}: ProfileViewProps) {
  const {
    author,
    casts,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useFarcasterProfile({ fid, token });

  const [viewerState, setViewerState] = useState<{ images: string[]; index: number } | null>(null);

  const styles = useMemo(() => createStyles(theme), [theme]);

  const handleMentionPress = async (username: string) => {
    const userFid = await lookupUserByUsername(username);
    if (userFid) {
      onOpenProfile(userFid, username);
    }
  };

  const renderProfileHeader = () => {
    if (!author) return null;

    return (
      <View style={styles.headerBackground}>
        {/* Banner */}
        <TouchableOpacity
          activeOpacity={author.profile?.bannerImageUrl ? 0.8 : 1}
          onPress={() => author.profile?.bannerImageUrl && setViewerState({ images: [author.profile.bannerImageUrl], index: 0 })}
          style={staticStyles.banner}
        >
          {author.profile?.bannerImageUrl ? (
            <Image
              source={{ uri: author.profile.bannerImageUrl }}
              style={styles.bannerImage}
              contentFit="cover"
              cachePolicy="disk"
            />
          ) : (
            <View style={styles.bannerPlaceholder} />
          )}
        </TouchableOpacity>

        {/* Avatar */}
        <View style={staticStyles.avatarSection}>
          <View style={staticStyles.avatarRow}>
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => author.pfp?.url && setViewerState({ images: [author.pfp.url], index: 0 })}
            >
              <CachedAvatar
                source={author.pfp?.url ? { uri: author.pfp.url } : null}
                style={styles.avatar}
              />
            </TouchableOpacity>
            <ProfileOverflowButton targetFid={fid} username={author.username} theme={theme} />
          </View>

          {/* Name and username */}
          <View style={staticStyles.nameSection}>
            <View style={staticStyles.nameRow}>
              <Text style={styles.displayName}>
                {author.displayName}
              </Text>
              {author.profile?.accountLevel === 'pro' && (
                <IconSymbol name="star.fill" color={theme.colors.warning} size={16} />
              )}
            </View>
            <Text style={styles.username}>
              @{author.username}
            </Text>
            <QuorumIdentityBadge fid={author.fid} theme={theme} />
          </View>

          {/* Bio */}
          {author.profile?.bio?.text && (
            <Text style={styles.bio}>
              {author.profile.bio.text}
            </Text>
          )}

          {/* Location */}
          {author.profile?.location?.description && (
            <View style={staticStyles.locationRow}>
              <IconSymbol name="mappin" color={theme.colors.textMuted} size={14} />
              <Text style={styles.locationText}>
                {author.profile.location.description}
              </Text>
            </View>
          )}

          {/* Follower/Following counts */}
          <View style={staticStyles.statsRow}>
            <View style={staticStyles.statItem}>
              <Text style={styles.statCount}>
                {(author.followingCount ?? 0).toLocaleString()}
              </Text>
              <Text style={styles.statLabel}>Following</Text>
            </View>
            <View style={staticStyles.statItem}>
              <Text style={styles.statCount}>
                {(author.followerCount ?? 0).toLocaleString()}
              </Text>
              <Text style={styles.statLabel}>Followers</Text>
            </View>
          </View>

          <ProfileActionButtons
            fid={fid}
            username={author.username}
            displayName={author.displayName}
            pfpUrl={author.pfp?.url}
            isFollowing={author.viewerContext?.following}
            theme={theme}
          />
        </View>

        <View style={styles.headerDivider} />
      </View>
    );
  };

  const renderCast = (cast: ProfileCast) => {
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
              <View style={staticStyles.nameRow}>
                <TouchableOpacity onPress={() => onOpenProfile(cast.author.fid, cast.author.username)}>
                  <Text style={styles.castAuthorName}>
                    {cast.author.displayName}
                  </Text>
                </TouchableOpacity>
                {cast.channel?.key && (
                  <TouchableOpacity onPress={() => onOpenChannel(cast.channel!.key!)}>
                    <Text style={styles.channelLink}>/{cast.channel.key}</Text>
                  </TouchableOpacity>
                )}
              </View>
              <Text style={styles.castMeta}>
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
                style={styles.imagePlaceholder}
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
          <View style={staticStyles.embedGap}>
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
          <View style={staticStyles.embedGap}>
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
        <View style={staticStyles.centeredLoader}>
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
        ListHeaderComponent={renderProfileHeader}
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
            <View style={staticStyles.footerLoader}>
              <ActivityIndicator color={theme.colors.accent} />
            </View>
          ) : null
        }
      />

      {/* Back button */}
      <TouchableOpacity
        onPress={onClose}
        style={staticStyles.backButton}
      >
        <IconSymbol name="chevron.left" color="#fff" size={20} />
      </TouchableOpacity>

      <ImageViewer
        visible={viewerState !== null}
        images={viewerState?.images}
        initialIndex={viewerState?.index}
        onClose={() => setViewerState(null)}
      />
    </View>
  );
}

const staticStyles = createSkinnable(() => StyleSheet.create({
  banner: {
    width: SCREEN_WIDTH,
    height: 120,
  },
  avatarSection: {
    paddingHorizontal: Skin.space(16),
    marginTop: Skin.space(-40),
  },
  avatarRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  nameSection: {
    marginTop: Skin.space(12),
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
    marginTop: Skin.space(8),
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
  castHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  flex1: {
    flex: 1,
  },
  mediaContainer: {
    marginHorizontal: Skin.space(-12),
  },
  frameEmbedsContainer: {
    marginHorizontal: Skin.space(-12),
    gap: Skin.space(8),
  },
  embedGap: {
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
  centeredLoader: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    padding: Skin.space(20),
  },
  footerLoader: {
    paddingVertical: Skin.space(20),
    alignItems: 'center',
  },
  backButton: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: Skin.radius(20),
    padding: Skin.space(8),
    zIndex: 10,
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
    bannerImage: {
      width: '100%',
      height: '100%',
      backgroundColor: theme.colors.surface3,
    },
    bannerPlaceholder: {
      width: '100%',
      height: '100%',
      backgroundColor: theme.colors.accent,
      opacity: 0.3,
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: Skin.radius(40),
      borderWidth: Skin.border(4),
      borderColor: theme.colors.background,
      backgroundColor: theme.colors.surface3,
    },
    displayName: {
      color: theme.colors.textStrong,
      fontSize: Skin.font(22),
      fontWeight: '700',
    },
    username: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(15),
      marginTop: Skin.space(2),
    },
    bio: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(21),
      marginTop: Skin.space(12),
    },
    locationText: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
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
    headerDivider: {
      height: 1,
      backgroundColor: theme.colors.surface3,
      marginTop: Skin.space(16),
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
    channelLink: {
      color: theme.colors.accent,
      fontSize: Skin.font(13),
    },
    castMeta: {
      color: theme.colors.textMuted,
      fontSize: Skin.font(13),
      marginTop: Skin.space(2),
    },
    castText: {
      color: theme.colors.textMain,
      fontSize: Skin.font(15),
      lineHeight: Skin.font(20),
    },
    imagePlaceholder: {
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

export default ProfileView;
