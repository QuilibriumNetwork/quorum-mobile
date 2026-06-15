/**
 * AudioSpaceOverlay — the in-room sheet rendered by AudioSpaceProvider
 * for the active space.
 *
 * Reads connection state, role, mic state, hand-raised state, and the
 * live active-speaker / reaction / chat streams from the provider.
 * The provider owns the LiveKit room and the heartbeat ticker, so this
 * component is purely presentational + dispatches the user actions
 * back through the context API.
 */

import React from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withSequence,
  withTiming,
  withDelay,
} from 'react-native-reanimated';
import { RTCView } from 'react-native-webrtc';
import { CachedAvatar } from '@/components/ui/CachedAvatar';
import { IconSymbol, type IconSymbolName } from '@/components/ui/IconSymbol';
import { EmojiPicker } from '@/components/Chat/EmojiPicker';
import { getRecentEmojis, recordEmojiUsage } from '@/services/emojiFrecency';
import { useAudioSpace, type ReactionEvent } from '@/context/AudioSpaceContext';
import { useAuth } from '@/context/AuthContext';
import { fidFromIdentity } from '@/services/spaces/livekitRoom';
import {
  type AudioRoom,
  type AudioRoomParticipant,
} from '@/services/spaces/spacesClient';
import { type SpaceChatCast } from '@/services/farcaster/spaceChatFetch';
import { useTheme } from '@/theme';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

const QUICK_REACTIONS = ['❤️', '🔥', '👏', '😂', '🙌', '🎉'];

export function AudioSpaceOverlay() {
  const {
    active,
    room,
    participants,
    role,
    state,
    error,
    micEnabled,
    handRaised,
    activeSpeakerIdentities,
    reactions,
    chatMessages,
    hasStageInvite,
    hasRsvped,
    minimized,
    minimize,
    restore,
    leave,
    toggleMic,
    toggleHand,
    isSpeakerOn,
    toggleSpeaker,
    reactWith,
    sendChat,
    replyToChat,
    toggleChatLike,
    toggleChatRecast,
    chatLikeStates,
    chatRecastStates,
    acceptStageInvite,
    declineStageInvite,
    promoteToSpeaker,
    cancelStageInvite,
    demoteSpeaker,
    endRoom,
    startScheduled,
    toggleRsvp,
    cameraEnabled,
    toggleCamera,
    localCameraStreamURL,
    localCameraFacing,
    flipCamera,
    remoteVideoStreams,
  } = useAudioSpace();
  const { theme } = useTheme();
  const { user } = useAuth();
  const localFid = user?.farcaster?.fid;
  // Build the per-FID video lookup once per render. Local participant's
  // stream is held separately because LiveKit doesn't surface it as a
  // remote subscription — we fold it in here so tiles can use a
  // uniform lookup regardless of whose FID they belong to.
  const videoStreamForFid = React.useCallback(
    (fid: number): string | null => {
      if (localFid != null && fid === localFid) return localCameraStreamURL;
      return remoteVideoStreams[fid] ?? null;
    },
    [localFid, localCameraStreamURL, remoteVideoStreams],
  );
  const [reactionTrayOpen, setReactionTrayOpen] = React.useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = React.useState(false);
  // Fast-pick reactions: the user's top-5 by frecency, padded with defaults.
  const [quickReactions, setQuickReactions] = React.useState<string[]>(QUICK_REACTIONS);
  React.useEffect(() => {
    if (!reactionTrayOpen) return;
    let cancelled = false;
    getRecentEmojis(5).then((recent) => {
      if (cancelled || recent.length === 0) return;
      const merged = [...recent];
      for (const d of QUICK_REACTIONS) {
        if (merged.length >= 5) break;
        if (!merged.includes(d)) merged.push(d);
      }
      setQuickReactions(merged.slice(0, 5));
    });
    return () => { cancelled = true; };
  }, [reactionTrayOpen]);

  // Send a reaction and record it for frecency (the full picker tracks its own).
  const sendReaction = React.useCallback((emoji: string) => {
    void reactWith(emoji);
    void recordEmojiUsage(emoji);
  }, [reactWith]);

  const [cameraToggling, setCameraToggling] = React.useState(false);
  const handleToggleCamera = React.useCallback(async () => {
    if (cameraToggling) return;
    setCameraToggling(true);
    try {
      const result = await toggleCamera();
      if (result.reason && !result.enabled) {
        // Surface the specific failure so the user understands why
        // nothing happened. Distinguish server-side gate ("you can't
        // publish video as a listener") from OS-side permission
        // (which they can fix in Settings).
        const reason = result.reason;
        if (reason === 'role-not-allowed-to-publish') {
          Alert.alert(
            'Video unavailable',
            'Only hosts and speakers can turn on video in a space.',
          );
        } else if (reason === 'token-rejected') {
          Alert.alert(
            'Video unavailable',
            'The host has not granted you video permission yet.',
          );
        } else if (reason === 'os-permission-denied') {
          Alert.alert(
            'Camera access denied',
            'Enable camera access for this app in Settings to turn on video.',
          );
        } else if (reason === 'no-camera' || reason === 'camera-busy') {
          Alert.alert(
            'Camera unavailable',
            'This device has no camera available right now.',
          );
        }
      }
    } finally {
      setCameraToggling(false);
    }
  }, [cameraToggling, toggleCamera]);
  const [chatOpen, setChatOpen] = React.useState(false);

  if (!active) return null;
  if (minimized) {
    return <MinimizedPill onRestore={restore} room={room} />;
  }

  const speakers = participants.filter(
    (p) => p.role === 'host' || p.role === 'cohost' || p.role === 'speaker',
  );
  const listeners = participants.filter((p) => p.role === 'listener');

  // FIDs currently emitting audio (LiveKit identities → fid). Used to
  // outline the corresponding tile.
  const activeFids = new Set(
    activeSpeakerIdentities
      .map((id) => fidFromIdentity(id))
      .filter((n): n is number => n !== null),
  );

  const canHostAct = role === 'host' || role === 'cohost';
  const hostFid = room?.host?.fid;

  // Host action sheet on tile long-press: invite/cancel/remove
  // depending on the target's current state.
  const openHostActions = (p: AudioRoomParticipant) => {
    const fid = p.user.fid;
    if (!canHostAct || fid === hostFid) return;
    const label = p.user.displayName || p.user.username || `fid:${fid}`;
    const isSpeaker = p.role === 'speaker' || p.role === 'cohost';
    const hasPendingInvite = Boolean(p.pendingInvite);

    const options: string[] = [];
    const handlers: (() => void)[] = [];
    if (isSpeaker) {
      options.push('Remove from speakers');
      handlers.push(() => demoteSpeaker(fid));
    } else if (hasPendingInvite) {
      options.push('Cancel invite');
      handlers.push(() => cancelStageInvite(fid));
    } else {
      options.push('Invite to speak');
      handlers.push(() => promoteToSpeaker(fid));
    }
    options.push('Cancel');

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: options.length - 1,
          destructiveButtonIndex: isSpeaker ? 0 : undefined,
          title: label,
        },
        (idx) => {
          if (idx >= 0 && idx < handlers.length) handlers[idx]();
        },
      );
    } else {
      Alert.alert(label, undefined, [
        {
          text: options[0],
          onPress: handlers[0],
          style: isSpeaker ? 'destructive' : 'default',
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const handleEndRoom = () => {
    Alert.alert(
      'End this space?',
      'Everyone will be disconnected.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'End', style: 'destructive', onPress: () => endRoom() },
      ],
    );
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      // A scheduled space isn't an active call, so there's nothing to keep
      // alive in the background — dismissing should fully close it, not leave
      // a draggable pill behind. Live/connecting spaces still minimize.
      onRequestClose={state === 'scheduled' ? leave : minimize}
      statusBarTranslucent
    >
      <View style={[styles.backdrop, { backgroundColor: 'rgba(0,0,0,0.6)' }]}>
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.colors.surface1 },
            // When chat is open, commit to a definite height so the
            // chat panel's `flex: 1` has space to fill. Without this
            // the sheet sizes to its content, which for chat means
            // zero — the panel collapses and no messages render.
            chatOpen && styles.sheetExpanded,
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <View
                style={[
                  styles.statePill,
                  {
                    backgroundColor:
                      state === 'error'
                        ? theme.colors.danger
                        : room?.state === 'live'
                          ? '#FF3B30'
                          : theme.colors.accent,
                  },
                ]}
              >
                {room?.state === 'live' && state === 'connected' && (
                  <View style={styles.liveDot} />
                )}
                <Text style={styles.statePillText}>
                  {state === 'fetching' || state === 'connecting'
                    ? 'CONNECTING'
                    : state === 'error'
                      ? 'ERROR'
                      : room?.state?.toUpperCase() ?? 'AUDIO SPACE'}
                </Text>
              </View>
              <Text
                style={[styles.title, { color: theme.colors.textStrong }]}
                numberOfLines={2}
              >
                {room?.title || 'Audio space'}
              </Text>
              {error && (
                <Text
                  style={{ color: theme.colors.danger, fontSize: Skin.font(12), marginTop: Skin.space(4) }}
                  numberOfLines={2}
                >
                  {error}
                </Text>
              )}
            </View>
            {canHostAct && (
              <Pressable onPress={handleEndRoom} hitSlop={12} style={styles.headerActionButton}>
                <Text style={{ color: theme.colors.danger, fontWeight: '600' }}>End</Text>
              </Pressable>
            )}
            <Pressable
              onPress={state === 'scheduled' ? leave : minimize}
              hitSlop={12}
              style={styles.closeButton}
            >
              <IconSymbol
                name={state === 'scheduled' ? 'xmark' : 'chevron.down'}
                size={22}
                color={theme.colors.textMuted}
              />
            </Pressable>
          </View>

          {!room && state !== 'error' && (
            <View style={{ alignItems: 'center', paddingVertical: Skin.space(32) }}>
              <ActivityIndicator color={theme.colors.textMuted} />
            </View>
          )}

          {room && state === 'scheduled' && (
            <ScheduledPreview
              room={room}
              hasRsvped={hasRsvped}
              onToggleRsvp={toggleRsvp}
              canHostAct={canHostAct}
              onStartScheduled={startScheduled}
              theme={theme}
            />
          )}

          {room && state !== 'scheduled' && !chatOpen && (
            <ScrollView contentContainerStyle={{ paddingBottom: Skin.space(24) }}>
              {speakers.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionLabel, { color: theme.colors.textMuted }]}>
                    Speakers
                  </Text>
                  <View style={styles.grid}>
                    {speakers.map((p) => {
                      const isSelf = localFid === p.user.fid;
                      return (
                        <ParticipantTile
                          key={p.user.fid}
                          participant={p}
                          speaking={activeFids.has(p.user.fid)}
                          highlight
                          videoStreamURL={videoStreamForFid(p.user.fid)}
                          // Mirror only the local selfie view — front
                          // camera in a mirror feels natural; a rear
                          // camera or someone else's stream should
                          // never be mirrored.
                          mirror={isSelf && localCameraFacing === 'user'}
                          onFlipCamera={isSelf && cameraEnabled ? flipCamera : undefined}
                          onLongPress={canHostAct ? () => openHostActions(p) : undefined}
                        />
                      );
                    })}
                  </View>
                </View>
              )}

              {listeners.length > 0 && (
                <View style={styles.section}>
                  <Text style={[styles.sectionLabel, { color: theme.colors.textMuted }]}>
                    Listeners · {listeners.length}
                  </Text>
                  <View style={styles.grid}>
                    {listeners.map((p) => (
                      <ParticipantTile
                        key={p.user.fid}
                        participant={p}
                        speaking={false}
                        highlight={false}
                        videoStreamURL={null}
                        mirror={false}
                        onLongPress={canHostAct ? () => openHostActions(p) : undefined}
                      />
                    ))}
                  </View>
                </View>
              )}
            </ScrollView>
          )}

          {room && state !== 'scheduled' && chatOpen && (
            // flex: 1 wrapper so the ChatPanel (and its flex: 1 message
            // list) fills the fixed-height sheet and pins the input to the
            // bottom, where the keyboard pad lifts it.
            <View style={{ flex: 1, minHeight: 0 }}>
              <ChatPanel
                messages={chatMessages}
                onSend={sendChat}
                onReply={replyToChat}
                onLikeToggle={toggleChatLike}
                onRecastToggle={toggleChatRecast}
                likeStates={chatLikeStates}
                recastStates={chatRecastStates}
                theme={theme}
              />
            </View>
          )}

          {/* Floating reaction stream — live mode only. */}
          {state !== 'scheduled' && <ReactionStream reactions={reactions} />}

          {/* Reaction tray */}
          {reactionTrayOpen && (
            <View
              style={[
                styles.reactionTray,
                { backgroundColor: theme.colors.surface2, borderTopColor: theme.colors.surface3 },
              ]}
            >
              {quickReactions.map((emoji) => (
                <Pressable
                  key={emoji}
                  onPress={() => {
                    sendReaction(emoji);
                    setReactionTrayOpen(false);
                  }}
                  hitSlop={6}
                  style={({ pressed }) => ({
                    padding: Skin.space(8),
                    borderRadius: Skin.radius(24),
                    backgroundColor: pressed ? theme.colors.surface3 : 'transparent',
                  })}
                >
                  <Text style={{ fontSize: Skin.font(28) }}>{emoji}</Text>
                </Pressable>
              ))}
              {/* Break out to the full emoji picker (inline — no second modal). */}
              <Pressable
                onPress={() => {
                  setReactionTrayOpen(false);
                  setEmojiPickerOpen(true);
                }}
                hitSlop={6}
                accessibilityLabel="More emoji"
                style={({ pressed }) => ({
                  padding: Skin.space(8),
                  borderRadius: Skin.radius(24),
                  backgroundColor: pressed ? theme.colors.surface3 : theme.colors.surface3,
                })}
              >
                <IconSymbol name="plus" size={24} color={theme.colors.textMain} />
              </Pressable>
            </View>
          )}

          {/* Full emoji picker — rendered inline within the overlay so we
              don't stack a second Modal. Sends any emoji as a reaction. */}
          {emojiPickerOpen && (
            <View style={styles.emojiPickerPanel}>
              {/* Tap outside the sheet to dismiss. */}
              <Pressable
                style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.5)' }]}
                onPress={() => setEmojiPickerOpen(false)}
              />
              <EmojiPicker
                embedded
                visible
                theme={theme}
                onClose={() => setEmojiPickerOpen(false)}
                onSelectEmoji={(emoji) => {
                  // The picker records its own frecency via trackEmoji.
                  void reactWith(emoji);
                  setEmojiPickerOpen(false);
                }}
              />
            </View>
          )}

          {/* Stage-invite prompt — accept/decline lives above the
              control bar so it's never missed. */}
          {hasStageInvite && (
            <View
              style={[
                styles.stagePrompt,
                {
                  backgroundColor: theme.colors.surface2,
                  borderColor: theme.colors.accent,
                },
              ]}
            >
              <Text style={[styles.stagePromptText, { color: theme.colors.textStrong }]}>
                The host invited you to speak.
              </Text>
              <View style={{ flexDirection: 'row', gap: Skin.space(8) }}>
                <Pressable
                  onPress={() => declineStageInvite()}
                  style={[styles.stagePromptButton, { backgroundColor: theme.colors.surface3 }]}
                >
                  <Text style={{ color: theme.colors.textMain, fontWeight: '600' }}>Decline</Text>
                </Pressable>
                <Pressable
                  onPress={() => acceptStageInvite()}
                  style={[styles.stagePromptButton, { backgroundColor: theme.colors.accent }]}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Join stage</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* Control bar — live mode only. Scheduled mode renders
              its own action row inside <ScheduledPreview>. Order:
              Mic, Camera, [Raise hand for listeners], React, Chat,
              Leave. Camera sits next to Mic because they're the two
              publishing controls. */}
          {state !== 'scheduled' && (
          <View style={[styles.controlBar, { borderTopColor: theme.colors.surface3 }]}>
            {(() => {
              const canPublishLocal =
                role === 'host' || role === 'cohost' || role === 'speaker';
              return (
                <>
                  <ControlButton
                    icon={micEnabled ? 'mic.fill' : 'mic.slash.fill'}
                    label={canPublishLocal ? (micEnabled ? 'Mute' : 'Unmute') : 'Mic'}
                    theme={theme}
                    disabled={!canPublishLocal || state !== 'connected'}
                    active={micEnabled}
                    onPress={toggleMic}
                  />
                  <ControlButton
                    icon={cameraEnabled ? 'video.fill' : 'video.slash.fill'}
                    label={cameraEnabled ? 'Stop' : 'Camera'}
                    theme={theme}
                    disabled={!canPublishLocal || state !== 'connected' || cameraToggling}
                    active={cameraEnabled}
                    onPress={handleToggleCamera}
                  />
                  <ControlButton
                    icon="hand.raised.fill"
                    label={handRaised ? 'Lower' : 'Raise'}
                    theme={theme}
                    disabled={canPublishLocal || state !== 'connected'}
                    active={handRaised}
                    onPress={toggleHand}
                  />
                </>
              );
            })()}
            <ControlButton
              icon={isSpeakerOn ? 'speaker.wave.2.fill' : 'speaker.wave.1.fill'}
              label={isSpeakerOn ? 'Speaker' : 'Earpiece'}
              theme={theme}
              disabled={state !== 'connected'}
              active={isSpeakerOn}
              onPress={toggleSpeaker}
            />
            <ControlButton
              icon="heart.fill"
              label="React"
              theme={theme}
              disabled={state !== 'connected'}
              onPress={() => setReactionTrayOpen((v) => !v)}
            />
            <ControlButton
              icon="message.fill"
              label={chatOpen ? 'Hide' : 'Chat'}
              theme={theme}
              // Cast anchor comes from `join({castHash})` (cast embed
              // path) OR `room.rootCastHash` on the snapshot
              // (discovery-strip path). Either is sufficient for chat.
              disabled={state !== 'connected' || !(active?.castHash || room?.rootCastHash)}
              active={chatOpen}
              onPress={() => setChatOpen((v) => !v)}
            />
            <ControlButton
              icon="xmark"
              label="Leave"
              theme={theme}
              onPress={leave}
            />
          </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

/** Renders the scheduled-mode preview: title, host, scheduled-at,
 *  RSVP toggle (listener-side), and Start-now (host-side). */
function ScheduledPreview({
  room,
  hasRsvped,
  onToggleRsvp,
  canHostAct,
  onStartScheduled,
  theme,
}: {
  room: AudioRoom;
  hasRsvped: boolean | null;
  onToggleRsvp: () => Promise<void>;
  canHostAct: boolean;
  onStartScheduled: () => Promise<void>;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const host = room.host;
  const hostPfp = host?.pfp?.url ?? host?.pfpUrl;
  const hostName = host?.displayName || host?.username || (host ? `fid:${host.fid}` : '');

  const scheduledLabel = React.useMemo(() => {
    if (!room.scheduledAt) return null;
    const at = new Date(room.scheduledAt);
    if (Number.isNaN(at.getTime())) return null;
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (at.toDateString() === now.toDateString()) return `Today at ${time}`;
    if (at.toDateString() === tomorrow.toDateString()) return `Tomorrow at ${time}`;
    return `${at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${time}`;
  }, [room.scheduledAt]);

  const isRsvped = hasRsvped === true;

  return (
    <View style={{ paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(16), gap: Skin.space(16) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(12) }}>
        <CachedAvatar
          source={hostPfp ? { uri: hostPfp } : null}
          style={{
            width: 56,
            height: 56,
            borderRadius: Skin.radius(28),
            backgroundColor: theme.colors.surface3,
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            style={{ color: theme.colors.textStrong, fontSize: Skin.font(14), fontWeight: '600' }}
            numberOfLines={1}
          >
            {hostName} · hosting
          </Text>
          {scheduledLabel && (
            <Text
              style={{ color: theme.colors.textMuted, fontSize: Skin.font(13), marginTop: Skin.space(2) }}
            >
              {scheduledLabel}
            </Text>
          )}
        </View>
      </View>

      {room.description && (
        <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(14), lineHeight: Skin.font(20) }}>
          {room.description}
        </Text>
      )}

      <View style={{ flexDirection: 'row', gap: Skin.space(10) }}>
        <Pressable
          onPress={onToggleRsvp}
          style={({ pressed }) => ({
            flex: 1,
            paddingVertical: Skin.space(12),
            borderRadius: Skin.radius(12),
            backgroundColor: isRsvped ? theme.colors.surface3 : theme.colors.accent,
            opacity: pressed ? 0.85 : 1,
            alignItems: 'center',
          })}
        >
          <Text
            style={{
              color: isRsvped ? theme.colors.textMain : '#fff',
              fontWeight: '600',
            }}
          >
            {isRsvped ? 'RSVP’d' : 'RSVP'}
          </Text>
        </Pressable>
        {canHostAct && (
          <Pressable
            onPress={onStartScheduled}
            style={({ pressed }) => ({
              flex: 1,
              paddingVertical: Skin.space(12),
              borderRadius: Skin.radius(12),
              backgroundColor: theme.colors.danger,
              opacity: pressed ? 0.85 : 1,
              alignItems: 'center',
            })}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Start now</Text>
          </Pressable>
        )}
      </View>

      <Text
        style={{
          color: theme.colors.textMuted,
          fontSize: Skin.font(12),
          textAlign: 'center',
          marginTop: Skin.space(4),
        }}
      >
        This space goes live at the scheduled time.
      </Text>
    </View>
  );
}

/**
 * Track the on-screen keyboard height. We can't lean on
 * `KeyboardAvoidingView` here: this panel lives inside a bottom-anchored,
 * fixed-height `<Modal statusBarTranslucent>`, where KAV's frame
 * measurement is unreliable and its `behavior="padding"` ends up adding
 * little or nothing — so the input stays pinned behind the keyboard.
 * Measuring the keyboard directly and padding the panel ourselves is
 * deterministic and, crucially, doesn't touch the sheet's height. iOS gets
 * the pre-animation `will*` events for a smoother lift; Android only emits
 * `did*`.
 */
function useKeyboardHeight(): number {
  const [height, setHeight] = React.useState(0);
  React.useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, (e) =>
      setHeight(e.endCoordinates?.height ?? 0),
    );
    const hideSub = Keyboard.addListener(hideEvt, () => setHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);
  return height;
}

function ChatPanel({
  messages,
  onSend,
  onReply,
  onLikeToggle,
  onRecastToggle,
  likeStates,
  recastStates,
  theme,
}: {
  messages: SpaceChatCast[];
  onSend: (text: string) => Promise<void>;
  onReply: (targetCastHash: string, text: string) => Promise<void>;
  onLikeToggle: (castHash: string, currentlyLiked: boolean, currentCount: number) => Promise<void>;
  onRecastToggle: (castHash: string, currentlyRecasted: boolean, currentCount: number) => Promise<void>;
  likeStates: Map<string, { liked: boolean; count: number }>;
  recastStates: Map<string, { recasted: boolean; count: number }>;
  theme: ReturnType<typeof useTheme>['theme'];
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const inputRef = React.useRef<TextInput>(null);
  const [draft, setDraft] = React.useState('');
  // The chat message being replied to (null = top-level chat to the host cast).
  const [replyTarget, setReplyTarget] = React.useState<SpaceChatCast | null>(null);
  const trimmed = draft.trim();
  const keyboardHeight = useKeyboardHeight();

  // Look up a message's parent (the cast it replies to) within the loaded list.
  // Top-level chat replies to the host cast, which isn't in the list, so those
  // resolve to undefined and show no reply indicator.
  const byHash = React.useMemo(() => {
    const map = new Map<string, SpaceChatCast>();
    for (const m of messages) map.set(m.hash, m);
    return map;
  }, [messages]);

  // y-offset of each message row within the scroll content, for tap-to-scroll.
  const rowYRef = React.useRef<Map<string, number>>(new Map());
  // Briefly highlight a message after scrolling to it (mirrors DM chat).
  const [highlightedHash, setHighlightedHash] = React.useState<string | null>(null);
  const highlightOpacity = useSharedValue(0);
  React.useEffect(() => {
    if (!highlightedHash) return;
    highlightOpacity.value = withSequence(
      withTiming(1, { duration: 0 }),
      withDelay(200, withTiming(0, { duration: 1500 })),
    );
    const t = setTimeout(() => setHighlightedHash(null), 1700);
    return () => clearTimeout(t);
  }, [highlightedHash]);

  // Accent rgb for the highlight tint (alpha animated in the worklet).
  const accent = theme.colors.accent;
  const ar = parseInt(accent.slice(1, 3), 16) || 88;
  const ag = parseInt(accent.slice(3, 5), 16) || 101;
  const ab = parseInt(accent.slice(5, 7), 16) || 242;
  const highlightStyle = useAnimatedStyle(() => ({
    backgroundColor: `rgba(${ar}, ${ag}, ${ab}, ${highlightOpacity.value * 0.18})`,
  }));

  const scrollToHash = React.useCallback((hash: string) => {
    const y = rowYRef.current.get(hash);
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    setTimeout(() => setHighlightedHash(hash), 300);
  }, []);

  const startReply = React.useCallback((m: SpaceChatCast) => {
    setReplyTarget(m);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  React.useEffect(() => {
    // Auto-scroll to the latest as messages arrive, and again when the
    // keyboard opens so the newest message stays visible above the input.
    requestAnimationFrame(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, keyboardHeight]);

  const submit = React.useCallback(() => {
    if (!trimmed) return;
    setDraft('');
    if (replyTarget) {
      const target = replyTarget;
      setReplyTarget(null);
      void onReply(target.hash, trimmed);
    } else {
      void onSend(trimmed);
    }
  }, [onSend, onReply, trimmed, replyTarget]);

  return (
    <View style={{ flex: 1, paddingBottom: keyboardHeight }}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: Skin.space(16), paddingVertical: Skin.space(8), gap: Skin.space(10) }}
        keyboardShouldPersistTaps="handled"
      >
        {messages.length === 0 && (
          <Text style={{ color: theme.colors.textMuted, textAlign: 'center', paddingVertical: Skin.space(24) }}>
            No messages yet.
          </Text>
        )}
        {messages.map((m, i) => {
          const fid = m.author.fid;
          const pfpUrl = m.author.pfpUrl;
          const displayName = m.author.displayName ?? m.author.username;
          // Optimistic stubs (not yet confirmed by the server) have no real
          // cast hash, so they can't be liked/recast/replied to yet.
          const isLocal = m.hash.startsWith('local-');
          const likeOpt = likeStates.get(m.hash);
          const liked = likeOpt?.liked ?? m.liked ?? false;
          const likeCount = likeOpt?.count ?? m.likeCount ?? 0;
          const recastOpt = recastStates.get(m.hash);
          const recasted = recastOpt?.recasted ?? m.recasted ?? false;
          const recastCount = recastOpt?.count ?? m.recastCount ?? 0;
          const replyCount = m.replyCount ?? 0;
          // The cast this message replies to, if it's in the loaded list.
          const parent = m.parentHash ? byHash.get(m.parentHash) : undefined;
          return (
            <Animated.View
              key={m.hash ?? `${fid}-${m.timestamp}-${i}`}
              onLayout={(e) => rowYRef.current.set(m.hash, e.nativeEvent.layout.y)}
              style={[
                {
                  flexDirection: 'row',
                  gap: Skin.space(8),
                  paddingHorizontal: Skin.space(6),
                  paddingVertical: Skin.space(3),
                  borderRadius: Skin.radius(8),
                },
                m.hash === highlightedHash ? highlightStyle : null,
              ]}
            >
              <CachedAvatar
                source={pfpUrl ? { uri: pfpUrl } : null}
                style={{ width: 28, height: 28, borderRadius: Skin.radius(14), backgroundColor: theme.colors.surface3 }}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                {parent && (
                  <Pressable
                    onPress={() => scrollToHash(parent.hash)}
                    hitSlop={6}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4), marginBottom: Skin.space(2) }}
                    accessibilityLabel="Go to replied message"
                  >
                    <IconSymbol name="arrowshape.turn.up.left.fill" size={11} color={theme.colors.textMuted} />
                    <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.textMuted, fontSize: Skin.font(12) }}>
                      {(parent.author.displayName ?? parent.author.username ?? `fid:${parent.author.fid}`)}: {parent.text}
                    </Text>
                  </Pressable>
                )}
                <Text style={{ color: theme.colors.textMain, fontWeight: '600', fontSize: Skin.font(13) }}>
                  {displayName || `fid:${fid}`}
                </Text>
                <Text style={{ color: theme.colors.textMain, fontSize: Skin.font(14), marginTop: Skin.space(2) }}>
                  {m.text}
                </Text>
                {!isLocal && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(18), marginTop: Skin.space(6) }}>
                    <Pressable
                      onPress={() => void onLikeToggle(m.hash, liked, likeCount)}
                      hitSlop={8}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}
                      accessibilityLabel={liked ? 'Unlike' : 'Like'}
                    >
                      <IconSymbol name={liked ? 'heart.fill' : 'heart'} size={14} color={liked ? theme.colors.danger : theme.colors.textMuted} />
                      {likeCount > 0 && (
                        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }}>{likeCount}</Text>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={() => startReply(m)}
                      hitSlop={8}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}
                      accessibilityLabel="Reply"
                    >
                      <IconSymbol name="bubble.left" size={14} color={theme.colors.textMuted} />
                      {replyCount > 0 && (
                        <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12) }}>{replyCount}</Text>
                      )}
                    </Pressable>
                    <Pressable
                      onPress={() => void onRecastToggle(m.hash, recasted, recastCount)}
                      hitSlop={8}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: Skin.space(4) }}
                      accessibilityLabel={recasted ? 'Undo recast' : 'Recast'}
                    >
                      <IconSymbol name="arrow.triangle.2.circlepath" size={14} color={recasted ? theme.colors.success : theme.colors.textMuted} />
                      {recastCount > 0 && (
                        <Text style={{ color: recasted ? theme.colors.success : theme.colors.textMuted, fontSize: Skin.font(12) }}>{recastCount}</Text>
                      )}
                    </Pressable>
                  </View>
                )}
              </View>
            </Animated.View>
          );
        })}
      </ScrollView>
      {replyTarget && (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: Skin.space(12),
            paddingVertical: Skin.space(6),
            backgroundColor: theme.colors.surface2,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.surface3,
          }}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(12), flex: 1 }} numberOfLines={1}>
            Replying to {replyTarget.author.displayName ?? replyTarget.author.username ?? `fid:${replyTarget.author.fid}`}
          </Text>
          <Pressable onPress={() => setReplyTarget(null)} hitSlop={8} accessibilityLabel="Cancel reply">
            <IconSymbol name="xmark" size={14} color={theme.colors.textMuted} />
          </Pressable>
        </View>
      )}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: Skin.space(8),
          paddingHorizontal: Skin.space(12),
          paddingVertical: Skin.space(8),
          backgroundColor: theme.colors.surface2,
          borderTopWidth: replyTarget ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: theme.colors.surface3,
        }}
      >
        <TextInput
          ref={inputRef}
          value={draft}
          onChangeText={setDraft}
          placeholder={replyTarget ? 'Write a reply' : 'Say something'}
          placeholderTextColor={theme.colors.textMuted}
          style={{
            flex: 1,
            minHeight: 36,
            maxHeight: 100,
            paddingHorizontal: Skin.space(12),
            paddingVertical: Skin.space(8),
            borderRadius: Skin.radius(18),
            fontSize: Skin.font(14),
            color: theme.colors.textMain,
            backgroundColor: theme.colors.surface3,
          }}
          multiline
          maxLength={500}
          returnKeyType="send"
          onSubmitEditing={submit}
          blurOnSubmit
        />
        <Pressable
          onPress={submit}
          disabled={!trimmed}
          hitSlop={8}
          style={({ pressed }) => [
            {
              width: 36,
              height: 36,
              borderRadius: Skin.radius(18),
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.accent,
            },
            (pressed || !trimmed) && { opacity: 0.5 },
          ]}
        >
          <IconSymbol name="paperplane.fill" size={18} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

/** Persistent mini-pill shown when the user dismisses the modal but
 *  the room is still connected. Tap to restore the full sheet; drag
 *  to reposition (the pill otherwise blocks text inputs and tab bar
 *  hit-targets). On release the pill snaps to the nearer edge of the
 *  screen with its vertical offset clamped to the on-screen safe
 *  area, mirroring the iOS picture-in-picture interaction. */
const PILL_WIDTH = 220;
const PILL_HEIGHT = 56;
const PILL_MARGIN = 12;
const PILL_DRAG_SLOP = 4;

function MinimizedPill({
  room,
  onRestore,
}: {
  room: AudioRoom | null;
  onRestore: () => void;
}) {
  const { theme } = useTheme();
  const { width: screenW, height: screenH } = Dimensions.get('window');
  // Y / X bounds. Top reserved for the status bar / notch; bottom for
  // home indicator + the tab bar — same offset the old static pill
  // used. The X bounds let the pill snap to either left/right edge.
  const minY = 60;
  const maxY = screenH - PILL_HEIGHT - (Platform.OS === 'ios' ? 100 : 80);
  const minX = PILL_MARGIN;
  const maxX = screenW - PILL_WIDTH - PILL_MARGIN;

  const tx = useSharedValue(maxX); // start docked right
  const ty = useSharedValue(maxY);
  const dragging = useSharedValue(0); // 0/1 for press-feedback opacity
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);

  const pan = Gesture.Pan()
    .activeOffsetX([-PILL_DRAG_SLOP, PILL_DRAG_SLOP])
    .activeOffsetY([-PILL_DRAG_SLOP, PILL_DRAG_SLOP])
    .onBegin(() => {
      startX.value = tx.value;
      startY.value = ty.value;
      dragging.value = 1;
    })
    .onUpdate((e) => {
      tx.value = Math.max(minX, Math.min(maxX, startX.value + e.translationX));
      ty.value = Math.max(minY, Math.min(maxY, startY.value + e.translationY));
    })
    .onEnd((e) => {
      // Snap to nearer side. Velocity-aware so a quick flick lands
      // even if the pill hasn't crossed the midpoint yet.
      const projected = tx.value + e.velocityX * 0.12;
      const midpoint = (minX + maxX) / 2;
      const target = projected < midpoint ? minX : maxX;
      tx.value = withSpring(target, { damping: 18, stiffness: 220 });
      dragging.value = 0;
    })
    .onFinalize(() => { dragging.value = 0; });

  // Tap-to-restore. We hook it as a separate gesture so the pan's slop
  // window doesn't eat a quick tap.
  const tap = Gesture.Tap().maxDuration(250).onEnd((_e, success) => {
    if (success) runOnJS(onRestore)();
  });
  const composed = Gesture.Simultaneous(pan, tap);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: tx.value },
      { translateY: ty.value },
    ],
    opacity: dragging.value ? 0.9 : 1,
  }));

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <GestureDetector gesture={composed}>
        <Animated.View
          style={[
            {
              position: 'absolute',
              top: 0,
              left: 0,
              width: PILL_WIDTH,
              height: PILL_HEIGHT,
              flexDirection: 'row',
              alignItems: 'center',
              gap: Skin.space(10),
              paddingVertical: Skin.space(10),
              paddingHorizontal: Skin.space(14),
              borderRadius: PILL_HEIGHT / 2,
              backgroundColor: theme.colors.surface3,
              shadowColor: '#000',
              shadowOpacity: 0.2,
              shadowRadius: 8,
              shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            },
            style,
          ]}
        >
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: Skin.radius(14),
              backgroundColor: theme.colors.danger,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <IconSymbol name="mic.fill" size={14} color="#fff" />
          </View>
          <Text
            style={{ flex: 1, color: theme.colors.textMain, fontWeight: '600' }}
            numberOfLines={1}
          >
            {room?.title || 'Audio space'}
          </Text>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function ReactionStream({ reactions }: { reactions: ReactionEvent[] }) {
  if (reactions.length === 0) return null;
  return (
    <View pointerEvents="none" style={styles.reactionStream}>
      {reactions.map((r) => (
        <Text key={r.id} style={styles.floatingReaction}>
          {r.emoji}
        </Text>
      ))}
    </View>
  );
}

function ParticipantTile({
  participant,
  speaking,
  highlight,
  videoStreamURL,
  mirror,
  onFlipCamera,
  onLongPress,
}: {
  participant: AudioRoomParticipant;
  speaking: boolean;
  highlight: boolean;
  /** When non-null, the tile renders a video preview instead of the
   *  circular avatar. `mirror` only applies when this is the local
   *  participant's selfie-style camera. */
  videoStreamURL: string | null;
  mirror: boolean;
  /** Only set on the local participant's tile when their camera is
   *  on. Renders a small flip button overlay; tapping swaps front/
   *  back lenses without renegotiating the LiveKit track. */
  onFlipCamera?: () => Promise<void> | void;
  onLongPress?: () => void;
}) {
  const { theme } = useTheme();
  const borderColor = speaking
    ? theme.colors.success
    : highlight
      ? theme.colors.accent
      : 'transparent';
  const hasVideo = videoStreamURL != null;
  // Wider, rectangular tile for video so the 16:9 preview has room.
  // Falls back to the original circular avatar tile when there's no
  // video — keeps the audio-only experience visually identical.
  const tileWidth = hasVideo ? 120 : 72;
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={350}
      style={{ alignItems: 'center', width: tileWidth }}
    >
      {hasVideo ? (
        <View
          style={{
            width: tileWidth - 8,
            height: 96,
            borderRadius: Skin.radius(12),
            borderWidth: Skin.border(2),
            borderColor,
            overflow: 'hidden',
            backgroundColor: theme.colors.surface3,
            position: 'relative',
          }}
        >
          <RTCView
            streamURL={videoStreamURL}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={mirror}
            zOrder={0}
          />
          {participant.handRaised && (
            <View style={[styles.handBadge, { backgroundColor: theme.colors.accent }]}>
              <Text style={{ fontSize: Skin.font(11) }}>✋</Text>
            </View>
          )}
          {onFlipCamera && (
            <Pressable
              onPress={() => { void onFlipCamera(); }}
              hitSlop={8}
              style={({ pressed }) => ({
                position: 'absolute',
                top: 6,
                right: 6,
                width: 26,
                height: 26,
                borderRadius: Skin.radius(13),
                backgroundColor: 'rgba(0,0,0,0.55)',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <IconSymbol name="camera.rotate" size={14} color="#fff" />
            </Pressable>
          )}
        </View>
      ) : (
        <View
          style={[
            styles.avatarWrap,
            { borderColor },
          ]}
        >
          <CachedAvatar
            source={
              participant.user.pfp?.url
                ? { uri: participant.user.pfp.url }
                : participant.user.pfpUrl
                  ? { uri: participant.user.pfpUrl }
                  : null
            }
            style={{
              width: 56,
              height: 56,
              borderRadius: Skin.radius(28),
              backgroundColor: theme.colors.surface3,
            }}
          />
          {participant.handRaised && (
            <View style={[styles.handBadge, { backgroundColor: theme.colors.accent }]}>
              <Text style={{ fontSize: Skin.font(11) }}>✋</Text>
            </View>
          )}
        </View>
      )}
      <Text
        style={[styles.participantName, { color: theme.colors.textMain }]}
        numberOfLines={1}
      >
        {participant.user.displayName
          || participant.user.username
          || `fid:${participant.user.fid}`}
      </Text>
      {(participant.role === 'host' || participant.role === 'cohost') && (
        <Text style={[styles.roleLabel, { color: theme.colors.textMuted }]}>
          {participant.role}
        </Text>
      )}
    </Pressable>
  );
}

function ControlButton({
  icon,
  label,
  theme,
  onPress,
  disabled,
  active,
}: {
  icon: IconSymbolName;
  label: string;
  theme: ReturnType<typeof useTheme>['theme'];
  onPress?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: Skin.space(4),
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: Skin.radius(24),
          backgroundColor: active ? theme.colors.accent : theme.colors.surface2,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <IconSymbol
          name={icon}
          size={22}
          color={active ? '#fff' : theme.colors.textMain}
        />
      </View>
      <Text style={{ color: theme.colors.textMuted, fontSize: Skin.font(11) }}>{label}</Text>
    </Pressable>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: Skin.radius(16),
    borderTopRightRadius: Skin.radius(16),
    paddingTop: Skin.space(12),
    maxHeight: '90%',
  },
  sheetExpanded: {
    // Fixed height for chat mode so the ChatPanel's flex: 1 message list
    // has space. 85% lines up roughly with where the speaker grid
    // already lands when filled, so toggling between modes doesn't
    // make the sheet jump.
    height: '85%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: Skin.space(16),
    paddingBottom: Skin.space(12),
    gap: Skin.space(12),
  },
  headerActionButton: {
    paddingHorizontal: Skin.space(8),
    paddingVertical: Skin.space(4),
  },
  statePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(4),
    alignSelf: 'flex-start',
    borderRadius: Skin.radius(4),
    paddingHorizontal: Skin.space(6),
    paddingVertical: Skin.space(2),
    marginBottom: Skin.space(6),
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: Skin.radius(3),
    backgroundColor: '#fff',
  },
  statePillText: {
    color: '#fff',
    fontSize: Skin.font(11),
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: Skin.font(18),
    fontWeight: '600',
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    paddingHorizontal: Skin.space(16),
    paddingTop: Skin.space(16),
  },
  sectionLabel: {
    fontSize: Skin.font(12),
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: Skin.space(12),
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Skin.space(12),
  },
  avatarWrap: {
    width: 60,
    height: 60,
    borderRadius: Skin.radius(30),
    borderWidth: Skin.border(2),
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  handBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: Skin.radius(10),
    alignItems: 'center',
    justifyContent: 'center',
  },
  participantName: {
    fontSize: Skin.font(12),
    marginTop: Skin.space(4),
    textAlign: 'center',
  },
  roleLabel: {
    fontSize: Skin.font(11),
    marginTop: Skin.space(2),
  },
  reactionTray: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingVertical: Skin.space(8),
    paddingHorizontal: Skin.space(12),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  emojiPickerPanel: {
    // Full-bleed overlay with the picker anchored to the bottom. The picker's
    // own container carries `marginBottom: keyboardHeight`, so it lifts above
    // the keyboard exactly like the chat emoji picker (a flex-end sheet).
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    zIndex: 50,
  },
  reactionStream: {
    position: 'absolute',
    bottom: 90,
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: Skin.space(4),
  },
  floatingReaction: {
    fontSize: Skin.font(32),
    opacity: 0.95,
  },
  controlBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: Skin.space(16),
    paddingHorizontal: Skin.space(16),
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stagePrompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(12),
    marginHorizontal: Skin.space(12),
    marginBottom: Skin.space(8),
    padding: Skin.space(12),
    borderRadius: Skin.radius(12),
    borderWidth: Skin.border(1),
  },
  stagePromptText: {
    flex: 1,
    fontSize: Skin.font(14),
    fontWeight: '500',
  },
  stagePromptButton: {
    paddingHorizontal: Skin.space(12),
    paddingVertical: Skin.space(8),
    borderRadius: Skin.radius(16),
  },
}));
