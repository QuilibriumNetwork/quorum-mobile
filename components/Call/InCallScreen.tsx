import React, { useEffect, useState } from 'react';
import { Dimensions, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { RTCView } from 'react-native-webrtc';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { useCall } from '@/context';
import { DefaultAvatar } from '@/components/ui/DefaultAvatar';
import { IconSymbol } from '@/components/ui/IconSymbol';
import type { CallQuality } from '@/services/calling';
import * as Skin from '@/theme/skins/geometry';
import { createSkinnable } from '@/theme/skins/skinnableStyleSheet';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

const QUALITY_COLORS = {
  good: '#34c759',
  fair: '#ffcc00',
  poor: '#ff3b30',
} as const;

function CallQualityIndicator({ quality }: { quality: CallQuality | null }) {
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

export function InCallScreen() {
  const {
    activeCall, hangup, toggleMute, toggleSpeaker, toggleVideo, flipCamera,
    getLocalStream, getRemoteStream,
  } = useCall();
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!activeCall?.startTime) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - activeCall.startTime!);
    }, 1000);
    return () => clearInterval(interval);
  }, [activeCall?.startTime]);

  if (!activeCall) return null;

  const isConnecting = activeCall.state === 'connecting' || activeCall.state === 'reconnecting';
  const isVideo = activeCall.mediaType === 'video';

  // Pull stream URLs at render time. The MediaStream identity is owned
  // by WebRTCManager and changes across ICE restarts; reading on every
  // render ensures RTCView always points at the current stream. activeCall
  // state changes drive the re-render cadence (state transitions to
  // 'connected', 'reconnecting', etc.).
  const localStream = getLocalStream();
  const remoteStream = getRemoteStream();
  const localStreamURL = localStream ? localStream.toURL() : null;
  const remoteStreamURL = remoteStream ? remoteStream.toURL() : null;

  if (isVideo) {
    return (
      <View style={[styles.videoContainer, { backgroundColor: '#000' }]}>
        {/* Remote video (full screen) */}
        {remoteStreamURL ? (
          <RTCView
            streamURL={remoteStreamURL}
            style={styles.remoteVideo}
            objectFit="cover"
            zOrder={0}
          />
        ) : (
          <View style={[styles.remoteVideoPlaceholder, { backgroundColor: theme.colors.surface1 }]}>
            <DefaultAvatar displayName={activeCall.recipientDisplayName} address={activeCall.recipientAddress} size={96} />
            <Text style={[styles.callerName, { color: theme.colors.text }]}>
              {activeCall.recipientDisplayName}
            </Text>
            <Text style={[styles.duration, { color: theme.colors.textSubtle }]}>
              {isConnecting ? 'Connecting...' : formatDuration(elapsed)}
            </Text>
          </View>
        )}

        {/* Local video (picture-in-picture) */}
        {localStreamURL && activeCall.isVideoEnabled && (
          <View style={[styles.localVideoContainer, { top: insets.top + 12 }]}>
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
        <View style={[styles.videoTopBar, { paddingTop: insets.top + 8 }]}>
          <View style={qualityStyles.timerRow}>
            <Text style={styles.videoTimer}>
              {isConnecting ? 'Connecting...' : formatDuration(elapsed)}
            </Text>
            <CallQualityIndicator quality={activeCall.callQuality} />
          </View>
        </View>

        {/* Controls */}
        <View style={[styles.videoControls, { paddingBottom: insets.bottom + 24 }]}>
          <TouchableOpacity
            style={[styles.videoControlButton, activeCall.isMuted && styles.videoControlActive]}
            onPress={toggleMute}
          >
            <IconSymbol name={activeCall.isMuted ? 'mic.slash.fill' : 'mic.fill'} color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.videoControlButton, !activeCall.isVideoEnabled && styles.videoControlActive]}
            onPress={toggleVideo}
          >
            <IconSymbol name={activeCall.isVideoEnabled ? 'video.fill' : 'video.slash.fill'} color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.videoControlButton} onPress={flipCamera}>
            <IconSymbol name="camera.rotate" color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.videoControlButton, activeCall.isSpeakerOn && styles.videoControlActive]}
            onPress={toggleSpeaker}
          >
            <IconSymbol name="speaker.wave.2.fill" color="#fff" size={22} />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.hangupButton, { backgroundColor: theme.colors.danger }]}
            onPress={hangup}
          >
            <IconSymbol name="phone.down" color="#fff" size={24} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Audio-only layout
  return (
    <View style={[styles.container, { paddingTop: insets.top + 60, paddingBottom: Skin.space(80) + insets.bottom, backgroundColor: theme.colors.background }]}>
      <View style={styles.callerInfo}>
        <DefaultAvatar displayName={activeCall.recipientDisplayName} address={activeCall.recipientAddress} size={80} />
        <Text style={[styles.callerName, { color: theme.colors.text }]}>
          {activeCall.recipientDisplayName}
        </Text>
        <View style={qualityStyles.timerRow}>
          <Text style={[styles.duration, { color: theme.colors.textSubtle }]}>
            {isConnecting ? 'Connecting...' : formatDuration(elapsed)}
          </Text>
          <CallQualityIndicator quality={activeCall.callQuality} />
        </View>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={[
            styles.controlButton,
            { backgroundColor: activeCall.isMuted ? theme.colors.primary : theme.colors.surface3 },
          ]}
          onPress={toggleMute}
        >
          <IconSymbol
            name={activeCall.isMuted ? 'mic.slash' : 'mic'}
            color={activeCall.isMuted ? '#fff' : theme.colors.text}
            size={22}
          />
          <Text style={[styles.controlLabel, { color: theme.colors.textSubtle }]}>
            {activeCall.isMuted ? 'Unmute' : 'Mute'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.controlButton,
            { backgroundColor: activeCall.isSpeakerOn ? theme.colors.primary : theme.colors.surface3 },
          ]}
          onPress={toggleSpeaker}
        >
          <IconSymbol
            name="speaker.wave.2"
            color={activeCall.isSpeakerOn ? '#fff' : theme.colors.text}
            size={22}
          />
          <Text style={[styles.controlLabel, { color: theme.colors.textSubtle }]}>
            Speaker
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.hangupButton, { backgroundColor: theme.colors.danger }]}
        onPress={hangup}
      >
        <IconSymbol name="phone.down" color="#fff" size={28} />
      </TouchableOpacity>
    </View>
  );
}

const styles = createSkinnable(() => StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    alignItems: 'center',
    justifyContent: 'space-between',
    // paddingBottom is applied inline (Skin.space(80) + insets.bottom) so it
    // clears the system nav bar in edge-to-edge mode.
  },
  videoContainer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
  },
  remoteVideo: {
    flex: 1,
  },
  remoteVideoPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Skin.space(12),
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
  videoTopBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingVertical: Skin.space(8),
  },
  videoTimer: {
    color: '#fff',
    fontSize: Skin.font(15),
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
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
  callerInfo: {
    alignItems: 'center',
    gap: Skin.space(8),
  },
  callerName: {
    fontSize: Skin.font(24),
    fontWeight: '600',
    marginTop: Skin.space(12),
  },
  duration: {
    fontSize: Skin.font(17),
    fontVariant: ['tabular-nums'],
  },
  controls: {
    flexDirection: 'row',
    gap: Skin.space(40),
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
  timerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Skin.space(8),
  },
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
