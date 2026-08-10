/**
 * SpaceCallBubble - Renders a space call indicator inline in the message list.
 *
 * Active call:
 *   Shows who started the call, a live elapsed timer, and a "Join" button.
 *   When joined, shows mute/leave controls inline.
 *
 * Ended call:
 *   Shows a static summary with duration.
 *
 * Unavailable call:
 *   A start message whose call is demonstrably over, but whose `space-call-end`
 *   never arrived — a join that failed, a last participant who crashed, an SFU
 *   that dropped the room. Shown as a static summary WITHOUT a duration,
 *   because we know it is over but not when it ended. Before this existed
 *   those bubbles claimed "call in progress" with a running timer forever.
 *   Which of the three applies is decided by `useSpaceCallStatus`.
 */

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { TouchableOpacity } from '@/components/ui/SkinTouchable';
import { IconSymbol } from '@/components/ui/IconSymbol';
import { useSpaceCall } from '@/context/SpaceCallContext';
import { useToast } from '@/context/ToastContext';
import { useSpaceCallStatus } from '@/hooks/chat/useSpaceCallStatus';
import type { AppTheme } from '@/theme';
import type { DisplayMessage } from './types';
import { logger } from '@quilibrium/quorum-shared';
import * as Skin from '@/theme/skins/geometry';
interface SpaceCallBubbleProps {
  message: DisplayMessage;
  /** Whether a matching space-call-end message exists for this callId */
  isEnded: boolean;
  /** Timestamp (ms) of the matching space-call-end message, if ended */
  endedAt?: number;
  /** Space ID for the current space */
  spaceId?: string;
  /** Channel ID for the current channel */
  channelId?: string;
  theme: AppTheme;
}

function formatElapsed(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

export function SpaceCallBubble({
  message,
  isEnded,
  endedAt,
  spaceId,
  channelId,
  theme,
}: SpaceCallBubbleProps) {
  const isVideo = message.spaceCallMediaType === 'video';
  const iconName = isVideo ? 'video' : 'speaker.wave.2';
  const label = isVideo ? 'Video' : 'Voice';
  const callId = message.spaceCallId;

  const { state: spaceCallState, joinCall, setOverlayMinimized } = useSpaceCall();
  const { showToast } = useToast();

  // Whether we are currently in THIS call
  const isInThisCall = spaceCallState.activeRoomId === callId;
  const isJoining = useRef(false);
  const [joining, setJoining] = useState(false);

  // The clock the whole bubble reads: it drives the visible timer AND the
  // staleness/grace branches in the status, so the two can never disagree.
  const [now, setNow] = useState(() => Date.now());

  // `isEnded` is the caller's verdict (it holds the whole message list and
  // matched the end message); `endedAt` is only the timestamp for the
  // duration. Keep them agreeing here so an end without a timestamp still
  // reads as ended rather than falling through to the liveness branches.
  const endedAtMs = isEnded ? (endedAt ?? message.timestamp) : undefined;

  const status = useSpaceCallStatus({
    callId,
    startedAt: message.timestamp,
    endedAt: endedAtMs,
    selfInCall: isInThisCall,
    now,
  });

  useEffect(() => {
    // Only a live call needs a ticking clock. Once the bubble settles into
    // ended or unavailable, `now` freezes \u2014 which is also what keeps the
    // status stable instead of re-deciding every second forever.
    if (status.state !== 'live') return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [status.state]);

  const elapsed =
    status.state === 'ended' && endedAtMs != null
      ? Math.max(0, Math.floor((endedAtMs - message.timestamp) / 1000))
      : Math.max(0, Math.floor((now - message.timestamp) / 1000));

  const handleJoin = async () => {
    if (!callId || !spaceId || !channelId || isJoining.current) return;
    isJoining.current = true;
    setJoining(true);
    try {
      // A `false` return means the join was declined as a duplicate (we are
      // already joining or still tearing down a previous call) \u2014 a no-op, not
      // a failure, so it gets no toast.
      await joinCall(callId, spaceId, channelId, isVideo);
    } catch (e) {
      logger.debug('[SpaceCallBubble] Failed to join:', e);
      showToast({
        type: 'error',
        title: 'Could not join the call',
        message: 'The call service could not be reached. Please try again.',
      });
    } finally {
      isJoining.current = false;
      setJoining(false);
    }
  };

  const styles = createStyles(theme);

  if (status.state === 'ended') {
    // Static ended summary
    return (
      <View style={styles.container}>
        <View style={styles.endedRow}>
          <IconSymbol name={iconName} size={16} color={theme.colors.textMuted} />
          <Text style={styles.endedText}>
            {label} call {'\u00B7'} {formatElapsed(elapsed)}
          </Text>
        </View>
      </View>
    );
  }

  if (status.state === 'unavailable') {
    // Over, but nobody told the channel when. Saying "ended" without inventing
    // a duration is the honest version of what we know.
    return (
      <View style={styles.container}>
        <View style={styles.endedRow}>
          <IconSymbol name={iconName} size={16} color={theme.colors.textMuted} />
          <Text style={styles.endedText}>{label} call ended</Text>
        </View>
      </View>
    );
  }

  // Active call bubble
  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <View style={styles.headerRow}>
          <View style={styles.iconPulseContainer}>
            <View style={[styles.iconCircle, { backgroundColor: theme.colors.success + '22' }]}>
              <IconSymbol name={iconName} size={18} color={theme.colors.success} />
            </View>
          </View>
          <View style={styles.headerText}>
            <Text style={styles.title}>{label} call in progress</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              Started by {message.userName} {'\u00B7'} {formatElapsed(elapsed)}
            </Text>
            {isInThisCall && spaceCallState.participants.length > 0 && (
              <Text style={styles.participantCount}>
                {spaceCallState.participants.length} participant{spaceCallState.participants.length !== 1 ? 's' : ''}
              </Text>
            )}
          </View>
        </View>
        <View style={styles.actionsRow}>
          {isInThisCall ? (
            <View style={styles.inCallRow}>
              <View style={styles.inCallIndicator}>
                <IconSymbol
                  name={spaceCallState.isMuted ? 'mic.slash.fill' : 'speaker.wave.2.fill'}
                  size={14}
                  color={spaceCallState.isMuted ? theme.colors.danger : theme.colors.success}
                />
                <Text style={[styles.inCallText, { color: theme.colors.textMain }]}>
                  In call {'\u00B7'} {formatElapsed(elapsed)}
                </Text>
                {/* Call quality dot */}
                {spaceCallState.callQuality && (
                  <View
                    style={[
                      styles.qualityDot,
                      {
                        backgroundColor:
                          spaceCallState.callQuality.level === 'good'
                            ? theme.colors.success
                            : spaceCallState.callQuality.level === 'fair'
                              ? '#f0ad4e'
                              : theme.colors.danger,
                      },
                    ]}
                  />
                )}
              </View>
              <TouchableOpacity
                style={[styles.expandButton, { backgroundColor: theme.colors.surface4 }]}
                onPress={() => setOverlayMinimized(false)}
                activeOpacity={0.7}
              >
                <IconSymbol name="arrow.up.left.and.arrow.down.right" size={14} color={theme.colors.textMain} />
                <Text style={[styles.expandButtonText, { color: theme.colors.textMain }]}>Expand</Text>
              </TouchableOpacity>
            </View>
          ) : status.joinable ? (
            <TouchableOpacity
              style={styles.joinButton}
              onPress={handleJoin}
              activeOpacity={0.7}
              disabled={joining}
            >
              {joining ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.joinButtonText}>Join</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const createStyles = (theme: AppTheme) =>
  StyleSheet.create({
    container: {
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(6),
      alignItems: 'center',
    },
    bubble: {
      backgroundColor: theme.colors.surface2,
      borderRadius: Skin.radius(12),
      padding: Skin.space(14),
      width: '100%',
      maxWidth: 400,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.surface6,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(12),
    },
    iconPulseContainer: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconCircle: {
      width: 40,
      height: 40,
      borderRadius: Skin.circleOrSquare(20),
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerText: {
      flex: 1,
    },
    title: {
      fontSize: Skin.font(15),
      fontWeight: '600',
      color: theme.colors.textMain,
    },
    subtitle: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(2),
    },
    participantCount: {
      fontSize: Skin.font(12),
      color: theme.colors.textSubtle,
      marginTop: Skin.space(2),
    },
    actionsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: Skin.space(12),
      gap: Skin.space(12),
    },
    joinButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(6),
      backgroundColor: theme.colors.success ?? '#34c759',
      paddingHorizontal: Skin.space(16),
      paddingVertical: Skin.space(8),
      borderRadius: Skin.radius(8),
      minWidth: 80,
    },
    joinButtonText: {
      color: '#fff',
      fontSize: Skin.font(14),
      fontWeight: '600',
    },
    // Compact "In call" indicator (replaces inline controls when joined)
    inCallRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    inCallIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(6),
    },
    inCallText: {
      fontSize: Skin.font(14),
      fontWeight: '500',
      fontVariant: ['tabular-nums'] as any,
    },
    expandButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: Skin.space(4),
      paddingHorizontal: Skin.space(10),
      paddingVertical: Skin.space(6),
      borderRadius: Skin.radius(8),
    },
    expandButtonText: {
      fontSize: Skin.font(13),
      fontWeight: '600',
    },
    qualityDot: {
      width: 8,
      height: 8,
      borderRadius: Skin.circle(4),
    },
    // Ended state
    endedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: Skin.space(6),
      paddingVertical: Skin.space(4),
    },
    endedText: {
      fontSize: Skin.font(13),
      color: theme.colors.textSubtle,
    },
  });
