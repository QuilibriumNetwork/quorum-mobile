import type { EmbeddedCast } from '@/hooks/useFarcasterFeed';

export type FeedFilter = 'all' | 'media' | 'governance' | 'node-ops' | 'events';

export interface VideoEmbed {
  url?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface UrlEmbed {
  url?: string;
  title?: string;
  description?: string;
  domain?: string;
  image?: string;
  useLargeImage?: boolean;
  isFarcasterLink?: boolean;
  farcasterUsername?: string;
  farcasterCastHash?: string;
  isQuorumInvite?: boolean;
  snapUrl?: string;
  /** Farcaster Frame v2 / miniapp metadata. Renderers should prefer the snap UI
   *  when the URL is detected as a snap, otherwise show this as a frame card. */
  frameImageUrl?: string;
  frameButtonTitle?: string;
  frameActionUrl?: string;
}

export interface QuoteCastEmbed {
  cast: EmbeddedCast;
  username: string;
  hashPrefix: string;
}

export interface FrameEmbedInfo {
  imageUrl: string;
  buttonTitle: string;
  actionUrl: string;
}

export interface FeedPost {
  id: string;
  hash: string;
  username: string;
  authorFid: number;
  authorName: string;
  authorHandle: string;
  authorAvatar?: string;
  channel?: string;
  /** Parent cast hash (set on replies). */
  parentHash?: string;
  /** Parent URL — channel URL for channel posts, source URL for off-Farcaster replies. */
  parentUrl?: string;
  /** Parent author FID — username is resolved by the renderer. */
  parentAuthorFid?: number;
  isPro?: boolean;
  time: string;
  content: string;
  stats: {
    likes: string;
    replies: string;
    shares: string;
  };
  tags: string[];
  mediaUrls: string[];
  videos: VideoEmbed[];
  urlPreviews: UrlEmbed[];
  quoteCasts: QuoteCastEmbed[];
  frameEmbeds: FrameEmbedInfo[];
  filter: FeedFilter;
  viewerHasLiked?: boolean;
  viewerHasRecast?: boolean;
  viewerIsFollowing?: boolean;
  /** /hegemony governance: set when this cast is a `PROPOSAL:` cast, with the
   *  reputation-weighted FOR/AGAINST point tallies. Drives the vote block. */
  isProposal?: boolean;
  votesFor?: number;
  votesAgainst?: number;
}

export interface ThreadInfo {
  username: string;
  castHashPrefix: string;
}

export interface MiniAppInfo {
  url: string;
}

export interface ProfileInfo {
  fid: number;
  username?: string;
}

export interface ChannelNavInfo {
  channelKey: string;
}

// Common navigation props used by views
export interface ViewNavigationProps {
  onOpenThread: (username: string, hashPrefix: string) => void;
  onOpenMiniApp: (url: string) => void;
  onOpenProfile: (fid: number, username?: string) => void;
  onOpenChannel: (channelKey: string) => void;
  likeStates: Map<string, { liked: boolean; count: number }>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => void;
}
