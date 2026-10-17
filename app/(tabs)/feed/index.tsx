import FarcasterReimportSheet from '@/components/FarcasterReimportSheet';
import SocialFeedModal, { type SocialFeedModalHandle } from '@/components/SocialFeedModal';
import { ListBottomFade } from '@/components/ui/ListBottomFade';
import { useAuth } from '@/context/AuthContext';
import { getFarcasterCustodyKey, getFarcasterFid } from '@/services/onboarding/secureStorage';
import { feedActiveTabBus } from '@/services/ui/feedActiveTab';
import { useTheme } from '@/theme';
import { useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

export default function FeedScreen() {
  const { farcasterAuthToken, refreshFarcasterToken, user } = useAuth();
  const { theme, isDark } = useTheme();
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
    /** Unique per navigation so re-opening the same profile re-triggers the
     *  feed modal's nav effect even when the tab is already mounted. */
    profileNonce?: string;
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

  type FcState =
    | { kind: 'checking' }
    | { kind: 'connected' }
    | { kind: 'keys-missing'; detail?: string }
    | { kind: 'no-account' };

  // The feed needs a Farcaster account and, to post, react or follow, the
  // account's custody key on this device (it provisions the Hypersnap
  // signer). It does not need the farcaster.xyz auth token: feed reads and
  // every protocol write go through Hypersnap, and AuthContext refreshes the
  // token in the background for the few farcaster.xyz-only features. A
  // farcaster.xyz refusal therefore never blocks this screen.
  //
  // Render-then-validate: with an account on file the feed shows at once and
  // the key check runs in the background. Only a cold start with no account
  // gets the blocking spinner.
  const knownFarcasterAccount = (user?.farcaster?.fid ?? 0) > 0;
  const [fcState, setFcState] = useState<FcState>(
    farcasterAuthToken || knownFarcasterAccount ? { kind: 'connected' } : { kind: 'checking' },
  );
  const [reimportOpen, setReimportOpen] = useState(false);

  const attempt = useCallback(async (blocking: boolean = true) => {
    // Background validations (blocking=false) never flip to the spinner;
    // they only downgrade to an error state once the keys are definitely
    // gone, so the feed stays on screen meanwhile.
    if (blocking) setFcState({ kind: 'checking' });
    if (await getFarcasterCustodyKey()) {
      setFcState({ kind: 'connected' });
      return;
    }
    // No custody key. A forced refreshFarcasterToken re-derives it from the
    // account mnemonic when it can (unforced, a stored token short-circuits
    // that); the token it may also return is incidental here.
    const result = await refreshFarcasterToken({ force: true });
    const [custodyKey, fid] = await Promise.all([
      getFarcasterCustodyKey(),
      getFarcasterFid(),
    ]);
    if (custodyKey) {
      setFcState({ kind: 'connected' });
      return;
    }
    const hasAccount =
      (fid != null && fid > 0) ||
      (user?.farcaster?.fid != null && user.farcaster.fid > 0);
    if (!hasAccount) {
      setFcState({ kind: 'no-account' });
      return;
    }
    setFcState({ kind: 'keys-missing', detail: 'error' in result ? result.detail : undefined });
  }, [refreshFarcasterToken, user?.farcaster?.fid]);

  useEffect(() => {
    // Known account → validate in the background without blocking the
    // feed; no account on file → blocking check (first-run sign-in path).
    void attempt(!knownFarcasterAccount);
  }, [attempt, knownFarcasterAccount]);

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
    return { fid, username: params.profileUsername, nonce: params.profileNonce };
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

  if (fcState.kind === 'keys-missing') {
    // SecureStore has lost the custody key and mnemonic recovery couldn't
    // derive it. The fix is a re-import.
    return (
      <View style={[styles.container, { backgroundColor: theme.colors.surface1 }]}>
        <View style={styles.center}>
          <Text style={[styles.title, { color: theme.colors.textStrong }]}>Re-import needed</Text>
          <Text style={[styles.body, { color: theme.colors.textSubtle }]}>
            Your Hypersnap account info is in your profile but the keys that authenticate you to Hypersnap aren&apos;t on this device anymore. Re-importing restores them in a few seconds.
          </Text>
          {fcState.detail ? (
            <Text style={[styles.detail, { color: theme.colors.textSubtle }]}>{fcState.detail}</Text>
          ) : null}
          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={() => void attempt()}
              style={[styles.action, { borderColor: theme.colors.border }]}
            >
              <Text style={[styles.actionText, { color: theme.colors.textMain }]}>Retry</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setReimportOpen(true)}
              style={[styles.action, { backgroundColor: theme.colors.primary }]}
            >
              <Text style={[styles.actionText, { color: '#fff' }]}>Re-import</Text>
            </TouchableOpacity>
          </View>
        </View>
        <FarcasterReimportSheet
          visible={reimportOpen}
          onClose={() => setReimportOpen(false)}
          onImported={() => {
            // The sheet just persisted the custody key; re-check.
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
      <ListBottomFade surfaceColor={theme.colors.surface1} isDark={isDark} />
    </View>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Skin.space(32),
    gap: Skin.space(12),
  },
  title: {
    fontSize: Skin.font(18),
    fontFamily: Skin.fontFamily('semiBold'),
    fontWeight: '600',
    textAlign: 'center',
  },
  body: {
    fontSize: Skin.font(14),
    textAlign: 'center',
    lineHeight: Skin.font(20),
  },
  detail: {
    fontSize: Skin.font(12),
    textAlign: 'center',
    fontStyle: 'italic',
    opacity: 0.7,
    marginTop: Skin.space(4),
  },
  actionRow: {
    flexDirection: 'row',
    gap: Skin.space(8),
    marginTop: Skin.space(16),
  },
  action: {
    paddingVertical: Skin.space(10),
    paddingHorizontal: Skin.space(20),
    borderRadius: Skin.radius(10),
    borderWidth: Skin.border(1),
    borderColor: 'transparent',
  },
  actionText: {
    fontSize: Skin.font(15),
    fontFamily: Skin.fontFamily('semiBold'),
    fontWeight: '600',
  },
}));
