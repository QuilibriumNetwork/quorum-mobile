import FarcasterReimportSheet from '@/components/FarcasterReimportSheet';
import HypersnapSignerPromptModal from '@/components/HypersnapSignerPromptModal';
import SocialFeedModal, { type SocialFeedModalHandle } from '@/components/SocialFeedModal';
import { useAuth } from '@/context/AuthContext';
import { useHypersnapSignerLifecycle } from '@/hooks/useHypersnapSignerLifecycle';
import { getFarcasterCustodyKey, getFarcasterFid } from '@/services/onboarding/secureStorage';
import { feedActiveTabBus } from '@/services/ui/feedActiveTab';
import { useTheme } from '@/theme';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

export default function FeedScreen() {
  const { farcasterAuthToken, refreshFarcasterToken, user } = useAuth();
  const { theme } = useTheme();
  const params = useLocalSearchParams<{
    username?: string;
    castHashPrefix?: string;
    channelKey?: string;
    /** Deep-link to a Farcaster user's profile view. Set by callers
     *  that have just a fid (e.g. UserProfileModal's linked-Farcaster
     *  tap handler). Without `castHashPrefix`, the modal pushes a
     *  profile screen instead of a thread. */
    profileFid?: string;
    profileUsername?: string;
  }>();

  // Imperative handle to SocialFeedModal — driven by the
  // feed-tab-tap-while-already-on-feed bus from (tabs)/_layout.tsx.
  // SocialFeedModal decides what "back to here" means based on its
  // own state (in a thread? scrolled? at top?).
  const feedModalRef = useRef<SocialFeedModalHandle | null>(null);
  useEffect(() => {
    return feedActiveTabBus.register(() => {
      feedModalRef.current?.handleActiveTabTap();
    });
  }, []);

  // Hypersnap signer opt-in prompt + background renewal. Mounted on the
  // feed view since that's where the user is when they'd act on it.
  const hypersnap = useHypersnapSignerLifecycle({ fid: user?.farcaster?.fid });

  type FcState =
    | { kind: 'checking' }
    | { kind: 'connected' }
    | { kind: 'token-missing'; detail?: string; reason: 'no-credentials' | 'api-rejected' | 'unknown' }
    | { kind: 'no-account' };

  const [fcState, setFcState] = useState<FcState>(
    farcasterAuthToken ? { kind: 'connected' } : { kind: 'checking' },
  );
  const [reimportOpen, setReimportOpen] = useState(false);

  const attempt = useCallback(async () => {
    setFcState({ kind: 'checking' });
    const result = await refreshFarcasterToken();
    if ('token' in result) {
      setFcState({ kind: 'connected' });
      return;
    }
    // No token. Decide which message to show.
    const [custodyKey, fid] = await Promise.all([
      getFarcasterCustodyKey(),
      getFarcasterFid(),
    ]);
    const hasAccount =
      !!custodyKey ||
      (fid != null && fid > 0) ||
      (user?.farcaster?.fid != null && user.farcaster.fid > 0);
    if (!hasAccount) {
      setFcState({ kind: 'no-account' });
      return;
    }
    // We have an account on file but the refresh failed.
    setFcState({
      kind: 'token-missing',
      reason:
        result.error === 'no-credentials'
          ? 'no-credentials'
          : result.error === 'api-rejected'
            ? 'api-rejected'
            : 'unknown',
      detail: result.detail,
    });
  }, [refreshFarcasterToken, user?.farcaster?.fid]);

  useEffect(() => {
    if (farcasterAuthToken) {
      setFcState({ kind: 'connected' });
      return;
    }
    void attempt();
  }, [farcasterAuthToken, attempt]);

  // `username` is optional now — miniapp `viewCast` and other surfaces
  // give us just the hash. The thread fetcher's hypersnap path doesn't
  // need a username; the legacy fallback won't fire in that case.
  const initialThread = params.castHashPrefix
    ? { username: params.username ?? '', castHashPrefix: params.castHashPrefix }
    : undefined;
  const initialChannel = params.channelKey ? { channelKey: params.channelKey } : undefined;
  const initialProfile = (() => {
    const fid = params.profileFid ? parseInt(params.profileFid, 10) : NaN;
    if (!Number.isFinite(fid) || fid <= 0) return undefined;
    return { fid, username: params.profileUsername };
  })();

  if (fcState.kind === 'checking') {
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surface1 }]}>
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.textMuted} />
        </View>
      </View>
    );
  }

  if (fcState.kind === 'token-missing') {
    // Different copy depending on why the refresh failed. The
    // "no-credentials" path means SecureStore is missing the custody
    // key and mnemonic recovery couldn't derive one — most reliable
    // fix is re-import. "api-rejected" usually means the Farcaster
    // API rate-limited us or the token rotated; a plain retry works.
    const isCredentialIssue = fcState.reason === 'no-credentials';
    const title = isCredentialIssue
      ? 'Re-import needed'
      : 'Reconnecting to Farcaster';
    const body = isCredentialIssue
      ? "Your Farcaster account info is in your profile but the keys that authenticate you to Farcaster aren't on this device anymore. Re-importing restores them in a few seconds."
      : "Your account is imported but the auth token isn't reachable right now. Tap Retry — this usually clears within a few seconds.";
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surface1 }]}>
        <View style={styles.center}>
          <Text style={[styles.title, { color: theme.colors.textStrong }]}>{title}</Text>
          <Text style={[styles.body, { color: theme.colors.textMuted }]}>{body}</Text>
          {fcState.detail ? (
            <Text style={[styles.detail, { color: theme.colors.textMuted }]}>{fcState.detail}</Text>
          ) : null}
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={() => void attempt()}
              style={[styles.action, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.actionText, { color: theme.colors.textMain }]}>Retry</Text>
            </TouchableOpacity>
            {isCredentialIssue && (
              <TouchableOpacity
                onPress={() => setReimportOpen(true)}
                style={[styles.action, { backgroundColor: theme.colors.primary }]}
              >
                <Text style={[styles.actionText, { color: '#fff' }]}>Re-import</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
        <FarcasterReimportSheet
          visible={reimportOpen}
          onClose={() => setReimportOpen(false)}
          onImported={() => {
            // The sheet just persisted custody/signer keys. Trigger
            // refresh; the token comes back from refreshFarcasterAuthToken
            // since the new custody key is now in SecureStore.
            void attempt();
          }}
        />
      </View>
    );
  }

  // 'connected' or 'no-account' — modal handles its own "Account
  // Required" overlay for genuinely-unconfigured users.
  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surface1 }]}>
      <SocialFeedModal
        ref={feedModalRef}
        visible={true}
        token={farcasterAuthToken ?? undefined}
        onClose={() => {
          // No-op — this is a tab route, not a modal
        }}
        initialThread={initialThread}
        initialChannel={initialChannel}
        initialProfile={initialProfile}
        isRouteMode={true}
      />
      <HypersnapSignerPromptModal
        visible={hypersnap.promptVisible}
        onClose={hypersnap.dismissPrompt}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  detail: {
    fontSize: 12,
    textAlign: 'center',
    fontStyle: 'italic',
    opacity: 0.7,
    marginTop: 4,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 16,
  },
  action: {
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  actionText: {
    fontSize: 15,
    fontWeight: '600',
  },
});
