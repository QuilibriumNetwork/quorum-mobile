/**
 * CastThreadModal — slide-up overlay that opens a Farcaster cast's thread
 * (replies and surrounding context) without leaving the current screen.
 * Used by the space chat to expand inline casts in place, so the user
 * doesn't get bounced into the feed tab.
 */

import { ThreadDetailView } from '@/components/SocialFeed/views/ThreadDetailView';
import { BaseModal } from '@/components/shared';
import { ReportModal } from '@/components/ReportModal';
import { useAuth } from '@/context/AuthContext';
import { useMiniappOverlay } from '@/context/MiniappOverlayContext';
import { useTheme } from '@/theme';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

interface CastThreadModalProps {
  visible: boolean;
  onClose: () => void;
  username: string;
  castHashPrefix: string;
}

export default function CastThreadModal({
  visible,
  onClose,
  username,
  castHashPrefix,
}: CastThreadModalProps) {
  const { theme } = useTheme();
  const { user, farcasterAuthToken } = useAuth();
  const { openMiniapp } = useMiniappOverlay();
  const [likeStates] = useState(() => new Map<string, { liked: boolean; count: number }>());
  const [followStates] = useState(() => new Map<number, boolean>());
  const [reportTarget, setReportTarget] = useState<
    { castHash: string; castAuthorFid?: number } | null
  >(null);

  return (
    <BaseModal visible={visible} onClose={onClose} height={0.92} avoidKeyboard fillHeight>
      <View style={{ flex: 1 }}>
        <ThreadDetailView
          username={username}
          castHashPrefix={castHashPrefix}
          token={farcasterAuthToken ?? undefined}
          currentUserFid={user?.farcaster?.fid}
          theme={theme}
          onClose={onClose}
          onOpenMiniApp={(url) => openMiniapp({ url })}
          onOpenProfile={() => router.push('/(tabs)/feed')}
          onOpenChannel={(channelKey) => router.push({ pathname: '/feed', params: { channelKey } })}
          likeStates={likeStates}
          onLikeToggle={() => { /* like handling lives in the feed tab */ }}
          followStates={followStates}
          onFollow={() => { /* follow handling lives in the feed tab */ }}
          onReport={(castHash, castAuthorFid) => setReportTarget({ castHash, castAuthorFid })}
        />
        <ReportModal
          visible={!!reportTarget}
          onClose={() => setReportTarget(null)}
          target={reportTarget ? { type: 'cast', ...reportTarget } : null}
        />
      </View>
    </BaseModal>
  );
}
