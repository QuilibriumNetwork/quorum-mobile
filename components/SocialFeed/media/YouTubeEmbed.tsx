import type { AppTheme } from '@/theme';
import React, { useMemo, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import YoutubePlayer from 'react-native-youtube-iframe';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

interface YouTubeEmbedProps {
  /** Video ID. May be undefined if only a playlist is provided. */
  videoId?: string;
  /** Optional playlist ID. When set, the player loads the playlist (and starts
   *  with `videoId` if provided, otherwise the first video). */
  playlistId?: string;
  theme: AppTheme;
  /** Optional: override the inline player width (defaults to screen width). */
  width?: number;
}

/**
 * Inline YouTube player. Wraps `react-native-youtube-iframe`, which handles
 * the WebView origin/IFrame-API complexity that the player needs to render
 * reliably on iOS and Android.
 */
export function YouTubeEmbed({ videoId, playlistId, theme, width }: YouTubeEmbedProps) {
  // When the caller doesn't supply a width, measure the parent so the
  // player sits inside whatever container (cast card, inset list, etc.)
  // hosts it. Previously we fell back to `SCREEN_WIDTH` and the player
  // overflowed any container with horizontal padding.
  const [measured, setMeasured] = useState<number | null>(null);
  const w = width ?? measured ?? 0;
  const h = Math.round((w * 9) / 16);
  const [loadError, setLoadError] = useState(false);
  const containerStyle = useMemo(
    () => [
      staticStyles.container,
      { width: w, height: h, backgroundColor: theme.colors.surface3 },
    ],
    [w, h, theme.colors.surface3],
  );

  if (!videoId && !playlistId) return null;

  // First render before onLayout fires: emit a self-measuring shell so
  // the second pass has a real width to use.
  if (width == null && measured == null) {
    return (
      <View
        style={{ width: '100%', aspectRatio: 16 / 9, backgroundColor: theme.colors.surface3, borderRadius: Skin.radius(8) }}
        onLayout={(e) => setMeasured(Math.floor(e.nativeEvent.layout.width))}
      />
    );
  }

  const externalFallbackUrl = videoId
    ? `https://www.youtube.com/watch?v=${videoId}${playlistId ? `&list=${playlistId}` : ''}`
    : `https://www.youtube.com/playlist?list=${playlistId}`;

  if (loadError) {
    return (
      <Pressable
        style={[
          staticStyles.fallback,
          { backgroundColor: theme.colors.surface2, borderColor: theme.colors.surface3 },
        ]}
        onPress={() => Linking.openURL(externalFallbackUrl).catch(() => {})}
      >
        <View style={staticStyles.fallbackInner}>
          <Text style={[staticStyles.fallbackTitle, { color: theme.colors.textStrong }]}>
            YouTube
          </Text>
          <Text style={[staticStyles.fallbackSub, { color: theme.colors.textMuted }]} numberOfLines={2}>
            This video can't play here. Tap to open on YouTube.
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={containerStyle}>
      <YoutubePlayer
        height={h}
        width={w}
        // YoutubePlayer requires a videoId; if only a playlist was provided,
        // pass an empty string and let `playList` drive playback.
        videoId={videoId ?? ''}
        playList={playlistId}
        playListStartIndex={0}
        webViewProps={{
          allowsFullscreenVideo: true,
          allowsInlineMediaPlayback: true,
          mediaPlaybackRequiresUserAction: false,
        }}
        initialPlayerParams={{
          modestbranding: true,
          rel: false,
          preventFullScreen: false,
        }}
        onError={(err: string) => {
          // err is one of: 'invalid_parameter' | 'HTML5_error' | 'video_not_found'
          //                | 'embed_not_allowed' (and a few others)
          // Skip transient HTML5 errors; fall back on definitive failures.
          const fatal = err === 'invalid_parameter' || err === 'video_not_found' || err === 'embed_not_allowed';
          // Don't fall back on per-item playlist errors — the player skips them.
          if (fatal && !playlistId) setLoadError(true);
        }}
      />
    </View>
  );
}

const staticStyles = createSkinnable(() => StyleSheet.create({
  container: {
    overflow: 'hidden',
    borderRadius: Skin.radius(8),
  },
  fallback: {
    borderRadius: Skin.radius(8),
    borderWidth: Skin.border(1),
    paddingVertical: Skin.space(14),
    paddingHorizontal: Skin.space(14),
  },
  fallbackInner: {
    gap: Skin.space(4),
  },
  fallbackTitle: {
    fontSize: Skin.font(14),
    fontWeight: '600',
  },
  fallbackSub: {
    fontSize: Skin.font(13),
    lineHeight: Skin.font(18),
  },
}));

export interface YouTubeMatch {
  videoId?: string;
  playlistId?: string;
}

/**
 * Parse a YouTube URL into video and/or playlist IDs. Returns null if the URL
 * isn't a recognizable YouTube link or doesn't reference any playable content.
 */
export function parseYouTubeUrl(rawUrl: string | undefined | null): YouTubeMatch | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');

  const ID_RE = /^[a-zA-Z0-9_-]{6,}$/;
  const PL_RE = /^[a-zA-Z0-9_-]{6,}$/;

  const videoId = (id: string | null | undefined) => (id && ID_RE.test(id) ? id : undefined);
  const playlistId = (id: string | null | undefined) => (id && PL_RE.test(id) ? id : undefined);

  // youtu.be/<videoId>?list=<playlistId>
  if (host === 'youtu.be') {
    const v = parsed.pathname.slice(1).split('/')[0];
    const list = parsed.searchParams.get('list');
    const m: YouTubeMatch = {
      videoId: videoId(v),
      playlistId: playlistId(list),
    };
    return m.videoId || m.playlistId ? m : null;
  }

  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const list = parsed.searchParams.get('list');
    // /playlist?list=<playlistId>
    if (parsed.pathname === '/playlist') {
      const pl = playlistId(list);
      return pl ? { playlistId: pl } : null;
    }
    // /watch?v=<videoId>[&list=<playlistId>]
    if (parsed.pathname === '/watch') {
      const m: YouTubeMatch = {
        videoId: videoId(parsed.searchParams.get('v')),
        playlistId: playlistId(list),
      };
      return m.videoId || m.playlistId ? m : null;
    }
    // /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
    const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live|v)\/([a-zA-Z0-9_-]{6,})/);
    if (pathMatch) {
      return {
        videoId: videoId(pathMatch[1]),
        playlistId: playlistId(list),
      };
    }
  }

  return null;
}

/**
 * Backwards-compatible video-only helper. Prefer `parseYouTubeUrl` to handle
 * playlist-only URLs.
 */
export function parseYouTubeId(rawUrl: string | undefined | null): string | null {
  return parseYouTubeUrl(rawUrl)?.videoId ?? null;
}

const YT_URL_RE =
  /https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)\/[^\s)]+/gi;

/**
 * Find all YouTube URLs inside a free-text body. Returns a deduped list of
 * matches, optionally excluding any URLs that are already covered by another
 * embed source (to avoid rendering the same video twice).
 */
export function extractYouTubeMatchesFromText(
  text: string | undefined | null,
  excludeUrls: Iterable<string | undefined> = [],
): { url: string; match: YouTubeMatch }[] {
  if (!text) return [];

  // Build an "already covered" set keyed by videoId / playlistId so we dedupe
  // even when the URL forms differ (youtu.be vs youtube.com/watch).
  const coveredKeys = new Set<string>();
  for (const u of excludeUrls) {
    const m = parseYouTubeUrl(u);
    if (m?.videoId) coveredKeys.add(`v:${m.videoId}`);
    if (m?.playlistId) coveredKeys.add(`p:${m.playlistId}`);
  }

  const seen = new Set<string>();
  const results: { url: string; match: YouTubeMatch }[] = [];
  const matches = text.matchAll(YT_URL_RE);
  for (const m of matches) {
    const raw = m[0];
    const cleaned = raw.replace(/[.,;:!?)]+$/, '');
    const parsedMatch = parseYouTubeUrl(cleaned);
    if (!parsedMatch) continue;
    const key = `${parsedMatch.videoId ? `v:${parsedMatch.videoId}` : ''}|${parsedMatch.playlistId ? `p:${parsedMatch.playlistId}` : ''}`;
    if (seen.has(key)) continue;
    if (parsedMatch.videoId && coveredKeys.has(`v:${parsedMatch.videoId}`)) continue;
    if (!parsedMatch.videoId && parsedMatch.playlistId && coveredKeys.has(`p:${parsedMatch.playlistId}`)) continue;
    seen.add(key);
    results.push({ url: cleaned, match: parsedMatch });
  }
  return results;
}
