/**
 * SpaceCallScreen - Full-screen view for an active space (group) call.
 *
 * Shows:
 * - Top bar: channel name, participant count, elapsed timer
 * - Center: participant avatar(s) for audio, or video grid for video
 * - Bottom bar: mute, toggle camera, flip camera, speaker, leave
 * - Minimize button (top-right) to shrink to PiP overlay
 */

import React, { useEffect, useState } from 'react';
import { Alert, Dimensions, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import * as Clipboard from 'expo-clipboard';
import { RTCView } from 'react-native-webrtc';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { useSpaceCall } from '@/context/SpaceCallContext';
import { useToast } from '@/context/ToastContext';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import type { CallQuality } from '@/services/calling/webrtc-manager';
import { logger } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface SpaceCallScreenProps {
  onMinimize: () => void;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

const QUALITY_COLORS = {
  good: '#34c759',
  fair: '#ffcc00',
  poor: '#ff3b30',
} as const;

function QualityIndicator({ quality }: { quality: CallQuality | null }) {
  const [showDetail, setShowDetail] = useState(false);

  if (!quality) return null;

  const level = quality.level;
  const color = QUALITY_COLORS[level];
  const barCount = level === 'good' ? 3 : level === 'fair' ? 2 : 1;

  return (
    <TouchableOpacity
      style={qualityStyles.container}
      onPress={() => setShowDetail(prev => !prev)}
      activeOpacity={0.7}
    >
      <View style={qualityStyles.bars}>
        {[1, 2, 3].map(i => (
          <View
            key={i}
            style={[
              qualityStyles.bar,
              { height: 4 + i * 4 },
              i <= barCount
                ? { backgroundColor: color }
                : { backgroundColor: 'rgba(255,255,255,0.25)' },
            ]}
          />
        ))}
      </View>
      {showDetail && (
        <Text style={qualityStyles.detailText}>
          {Math.round(quality.rtt)}ms
        </Text>
      )}
    </TouchableOpacity>
  );
}

export function SpaceCallScreen({ onMinimize }: SpaceCallScreenProps) {
  const { state, leaveCall, toggleMute, toggleVideo, toggleSpeaker, flipCamera, getLocalStream, getRemoteStream, getDiagnosticsText } = useSpaceCall();
  const { theme } = useTheme();
  const { showToast } = useToast();
  const insets = useSafeAreaInsets();
  const [elapsed, setElapsed] = useState(0);
  const [callStartTime] = useState(() => Date.now());

  // Elapsed timer
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - callStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [callStartTime]);

  // Get stream URLs for RTCView
  const localStream = getLocalStream();
  const remoteStream = getRemoteStream();
  const localStreamURL = localStream ? localStream.toURL() : null;
  const remoteStreamURL = remoteStream ? remoteStream.toURL() : null;

  const isVideo = state.isVideoEnabled;
  const participantCount = state.participants.length;

  const handleLeave = async () => {
    try {
      await leaveCall();
    } catch (e) {
      logger.debug('[SpaceCallScreen] Failed to leave:', e);
    }
  };

  // Hidden surface — long-pressing the leave button opens a confirmation
  // showing the in-memory diagnostic buffer for *this* call (structural
  // events only; no identifiers). The user can then choose to copy it to
  // clipboard. Nothing is uploaded automatically. This is the only way
  // the buffer leaves the device.
  const handleLeaveLongPress = async () => {
    const text = getDiagnosticsText();
    if (!text) return;
    // Preview the first ~600 chars so the user sees what they're about
    // to copy — this is non-trivial: the buffer is plaintext events.
    const preview = text.length > 600 ? text.slice(0, 600) + '\n…' : text;
    Alert.alert(
      'Copy call diagnostics?',
      `${preview}\n\nThis contains structural call events only (no addresses, no SDP). Copy to clipboard?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Copy',
          onPress: async () => {
            try {
              await Clipboard.setStringAsync(text);
              showToast({ type: 'success', title: 'Copied', message: 'Call diagnostics copied to clipboard.' });
            } catch {
              showToast({ type: 'error', title: 'Copy Failed', message: 'Could not copy diagnostics to clipboard.' });
            }
          },
        },
      ],
    );
  };

  if (isVideo) {
    return (
      <View style={[styles.container, { backgroundColor: '#000' }]}>
        {/* Remote video (full-screen background) */}
        {remoteStreamURL ? (
          <RTCView
            streamURL={remoteStreamURL}
            style={styles.remoteVideo}
            objectFit="cover"
            zOrder={0}
          />
        ) : (
          <View style={styles.videoPlaceholder}>
            <DefaultAvatar address={state.participants[0] ?? 'space'} size={96} />
            <Text style={styles.placeholderText}>
              Waiting for others...
            </Text>
          </View>
        )}

        {/* Local video PiP */}
        {localStreamURL && state.isVideoEnabled && (
          <View style={[styles.localVideoContainer, { top: insets.top + 56 }]}>
            <RTCView
              streamURL={localStreamURL}
              style={styles.localVideo}
              objectFit="cover"
              zOrder={1}
              mirror
            />
          </View>
        )}

        {/* Top bar */}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <View style={styles.topBarLeft}>
            <View style={styles.topBarInfo}>
              <Text style={styles.topBarTitle} numberOfLines={1}>
                {state.phase === 'recovering' ? 'Reconnecting…' : 'Space Call'}
              </Text>
              <View style={styles.topBarMeta}>
                <Text style={styles.topBarTimer}>{formatDuration(elapsed)}</Text>
                <Text style={styles.topBarSeparator}>{'\u00B7'}</Text>
                <IconSymbol name="person.2.fill" size={14} color="rgba(255,255,255,0.7)" />
                <Text style={styles.topBarParticipants}>{participantCount}</Text>
                <QualityIndicator quality={state.callQuality} />
              </View>
            </View>
          </View>
          <TouchableOpacity
            style={styles.minimizeButton}
            onPress={onMinimize}
            activeOpacity={0.7}
          >
            <IconSymbol name="arrow.down.right.and.arrow.up.left" size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Bottom controls */}
        <View style={[styles.videoControls, { paddingBottom: insets.bottom + 24 }]}>
          <TouchableOpacity
            style={[styles.videoControlButton, state.isMuted && styles.videoControlActive]}
            onPress={toggleMute}
          >
            <IconSymbol name={state.isMuted ? 'mic.slash.fill' : 'mic.fill'} color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.videoControlButton, !state.isVideoEnabled && styles.videoControlActive]}
            onPress={toggleVideo}
          >
            <IconSymbol name={state.isVideoEnabled ? 'video.fill' : 'video.slash.fill'} color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.videoControlButton} onPress={flipCamera}>
            <IconSymbol name="camera.rotate" color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.videoControlButton, state.isSpeakerOn && styles.videoControlActive]}
            onPress={toggleSpeaker}
          >
            <IconSymbol
              name={state.isSpeakerOn ? 'speaker.wave.2.fill' : 'speaker.wave.1.fill'}
              color="#fff"
              size={22}
            />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.hangupButton, { backgroundColor: theme.colors.danger }]}
            onPress={handleLeave}
            onLongPress={handleLeaveLongPress}
            delayLongPress={1500}
          >
            <IconSymbol name="phone.down" color="#fff" size={24} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Audio-only layout
  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
      {/* Top bar — container already applies insets.top, so only add spacing. */}
      <View style={[styles.audioTopBar, { paddingTop: Skin.space(8) }]}>
        <View style={styles.topBarLeft}>
          <View style={styles.topBarInfo}>
            <Text style={[styles.audioTopBarTitle, { color: theme.colors.textMain }]} numberOfLines={1}>
              Space Call
            </Text>
            <View style={styles.topBarMeta}>
              <Text style={[styles.audioTopBarTimer, { color: theme.colors.textSubtle }]}>
                {formatDuration(elapsed)}
              </Text>
              <Text style={[styles.topBarSeparator, { color: theme.colors.textMuted }]}>{'\u00B7'}</Text>
              <IconSymbol name="person.2.fill" size={14} color={theme.colors.textMuted} />
              <Text style={[styles.audioTopBarParticipants, { color: theme.colors.textMuted }]}>
                {participantCount}
              </Text>
              <QualityIndicator quality={state.callQuality} />
            </View>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.minimizeButton, { backgroundColor: theme.colors.surface4 }]}
          onPress={onMinimize}
          activeOpacity={0.7}
        >
          <IconSymbol name="arrow.down.right.and.arrow.up.left" size={18} color={theme.colors.textMain} />
        </TouchableOpacity>
      </View>

      {/* Center: participant avatars in a circle layout */}
      <View style={styles.audioCenter}>
        <View style={styles.avatarGrid}>
          {state.participants.length === 0 ? (
            <View style={styles.avatarItem}>
              <DefaultAvatar address="space" size={80} />
              <Text style={[styles.avatarLabel, { color: theme.colors.textMuted }]}>
                Waiting...
              </Text>
            </View>
          ) : (
            state.participants.slice(0, 6).map((participant, index) => {
              const isSpeaking = state.speakingAddresses.includes(participant);
              return (
                <View key={participant || index} style={styles.avatarItem}>
                  <View
                    style={[
                      styles.avatarRing,
                      isSpeaking && [
                        styles.avatarRingSpeaking,
                        { borderColor: theme.colors.primary },
                      ],
                    ]}
                  >
                    <DefaultAvatar address={participant} size={64} />
                  </View>
                </View>
              );
            })
          )}
          {state.participants.length > 6 && (
            <View style={styles.avatarItem}>
              <View style={[styles.moreParticipants, { backgroundColor: theme.colors.surface4 }]}>
                <Text style={[styles.moreParticipantsText, { color: theme.colors.textMain }]}>
                  +{state.participants.length - 6}
                </Text>
              </View>
            </View>
          )}
        </View>
      </View>

      {/* Bottom controls */}
      <View style={[styles.audioControls, { paddingBottom: insets.bottom + 24 }]}>
        <TouchableOpacity
          style={[
            styles.controlButton,
            { backgroundColor: state.isMuted ? theme.colors.primary : theme.colors.surface3 },
          ]}
          onPress={toggleMute}
        >
          <IconSymbol
            name={state.isMuted ? 'mic.slash.fill' : 'mic.fill'}
            color={state.isMuted ? '#fff' : theme.colors.textMain}
            size={22}
          />
          <Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>
            {state.isMuted ? 'Unmute' : 'Mute'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.controlButton,
            { backgroundColor: state.isVideoEnabled ? theme.colors.primary : theme.colors.surface3 },
          ]}
          onPress={toggleVideo}
        >
          <IconSymbol
            name={state.isVideoEnabled ? 'video.fill' : 'video.slash.fill'}
            color={state.isVideoEnabled ? '#fff' : theme.colors.textMain}
            size={22}
          />
          <Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>
            Video
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.controlButton,
            { backgroundColor: state.isSpeakerOn ? theme.colors.primary : theme.colors.surface3 },
          ]}
          onPress={toggleSpeaker}
        >
          <IconSymbol
            name={state.isSpeakerOn ? 'speaker.wave.2.fill' : 'speaker.wave.1.fill'}
            color={state.isSpeakerOn ? '#fff' : theme.colors.textMain}
            size={22}
          />
          <Text style={[styles.controlLabel, { color: theme.colors.textMuted }]}>
            Speaker
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.hangupButton, { backgroundColor: theme.colors.danger }]}
          onPress={handleLeave}
        >
          <IconSymbol name="phone.down" color="#fff" size={28} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9998,
  },
  // Top bar (shared structure)
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Skin.space(16),
    paddingBottom: Skin.space(12),
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  audioTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Skin.space(16),
    paddingBottom: Skin.space(12),
  },
  topBarLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  topBarInfo: {
    flex: 1,
  },
  topBarTitle: {
    color: '#fff',
    fontSize: Skin.font(17),
    fontWeight: '600',
  },
  audioTopBarTitle: {
    fontSize: Skin.font(17),
    fontWeight: '600',
  },
  topBarMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(6),
    marginTop: Skin.space(2),
  },
  topBarTimer: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: Skin.font(13),
    fontVariant: ['tabular-nums'],
  },
  audioTopBarTimer: {
    fontSize: Skin.font(13),
    fontVariant: ['tabular-nums'],
  },
  topBarSeparator: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: Skin.font(13),
  },
  topBarParticipants: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: Skin.font(13),
  },
  audioTopBarParticipants: {
    fontSize: Skin.font(13),
  },
  minimizeButton: {
    width: 36,
    height: 36,
    borderRadius: Skin.radius(18),
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Skin.space(12),
  },
  // Video layout
  remoteVideo: {
    flex: 1,
  },
  videoPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1a1a1a',
    gap: Skin.space(12),
  },
  placeholderText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: Skin.font(15),
  },
  localVideoContainer: {
    position: 'absolute',
    right: 12,
    width: 100,
    height: 140,
    borderRadius: Skin.radius(12),
    overflow: 'hidden',
    borderWidth: Skin.border(2),
    borderColor: 'rgba(255,255,255,0.3)',
  },
  localVideo: {
    flex: 1,
  },
  videoControls: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Skin.space(16),
    paddingVertical: Skin.space(20),
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  videoControlButton: {
    width: 48,
    height: 48,
    borderRadius: Skin.radius(24),
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoControlActive: {
    backgroundColor: 'rgba(255,255,255,0.4)',
  },
  // Audio layout
  audioCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Skin.space(24),
    maxWidth: SCREEN_WIDTH - 64,
  },
  avatarItem: {
    alignItems: 'center',
    gap: Skin.space(6),
  },
  avatarRing: {
    borderWidth: Skin.border(3),
    borderColor: 'transparent',
    borderRadius: Skin.radius(999),
    padding: Skin.space(2),
  },
  avatarRingSpeaking: {
    // borderColor is set inline from theme.colors.primary so the ring
    // matches the user's accent. Width/padding stay constant so the
    // surrounding layout doesn't shift when speaking toggles.
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  avatarLabel: {
    fontSize: Skin.font(12),
  },
  moreParticipants: {
    width: 64,
    height: 64,
    borderRadius: Skin.radius(32),
    alignItems: 'center',
    justifyContent: 'center',
  },
  moreParticipantsText: {
    fontSize: Skin.font(16),
    fontWeight: '600',
  },
  audioControls: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Skin.space(24),
    paddingVertical: Skin.space(20),
  },
  controlButton: {
    width: 72,
    height: 72,
    borderRadius: Skin.radius(20),
    alignItems: 'center',
    justifyContent: 'center',
    gap: Skin.space(4),
  },
  controlLabel: {
    fontSize: Skin.font(11),
  },
  hangupButton: {
    width: 72,
    height: 72,
    borderRadius: Skin.radius(36),
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

const qualityStyles = createSkinnable(() => StyleSheet.create({
  container: {
    flexDirection: 'column',
    alignItems: 'center',
    gap: Skin.space(2),
  },
  bars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Skin.space(2),
  },
  bar: {
    width: 4,
    borderRadius: Skin.radius(1),
  },
  detailText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: Skin.font(10),
    fontVariant: ['tabular-nums'],
  },
}));
