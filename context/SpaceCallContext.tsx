/**
 * SpaceCallContext — manages state for space (group) calls using the SFU.
 *
 * Unlike DM calls (CallContext), space calls:
 * - Do NOT use CallKit/ConnectionService
 * - Do NOT show a full-screen overlay
 * - Controls are inline in SpaceCallBubble
 * - Each participant connects to the SFU via their own 2-hop relay circuit
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { Platform } from 'react-native';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import { useQueryClient } from '@tanstack/react-query';
import { logger, queryKeys, type Message } from '@quilibrium/quorum-shared';
import { useAuth } from './AuthContext';
import { useWebSocket } from './WebSocketContext';
import { signForRelay } from './CallContext';
import { SFUClient } from '@/services/calling/sfu-client';
import { RelayClient } from '@/services/calling/relay-client';
import type { CallQuality } from '@/services/calling/webrtc-manager';
import type { TurnCredentials } from '@/services/calling/relay-client';
import * as callDiag from '@/services/calling/callDiagnostics';
import QuorumCrypto from '../modules/quorum-crypto/src';

/**
 * Enforce constant bitrate on Opus codec in an SDP string.
 * Prevents relay nodes from inferring speech patterns via traffic volume.
 */
function enforceConstantBitrate(sdp: string): string {
  const lines = sdp.split('\r\n');
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith('a=fmtp:111 ') && !line.includes('cbr=1')) {
      result.push(line + ';cbr=1');
    } else {
      result.push(line);
    }
  }
  return result.join('\r\n');
}

/**
 * Explicit lifecycle phase. The previous ad-hoc model used
 * `activeRoomId != null` to mean "in a call" plus a scatter of refs
 * (joinInProgressRef, pcRef) to disambiguate the connecting / connected
 * / leaving sub-states. That made transitions implicit and
 * fork-prone — e.g. a renegotiation error path and a user leave could
 * both run cleanup. This enum is now the source of truth, validated by
 * the `LEGAL_TRANSITIONS` map below.
 *
 *   idle → joining   on joinCall()
 *   joining → connected   on SFU answer applied
 *   joining → ending      on error during join, or user leaves mid-join
 *   connected → recovering  on PC disconnected/failed
 *   recovering → connected  on PC connected within RECOVERY_TIMEOUT_MS
 *   recovering → ending     on timeout or 3+ consecutive reneg failures
 *   connected → ending      on user leave
 *   ending    → idle        once cleanup completes
 */
export type SpaceCallPhase =
  | 'idle'
  | 'joining'
  | 'connected'
  | 'recovering'
  | 'ending';

const LEGAL_TRANSITIONS: Record<SpaceCallPhase, SpaceCallPhase[]> = {
  idle: ['joining'],
  joining: ['connected', 'ending'],
  connected: ['recovering', 'ending'],
  recovering: ['connected', 'ending'],
  ending: ['idle'],
};

/**
 * How long the PC can stay disconnected before we give up and end the
 * call with `recovery_timeout`. ICE renomination on transient network
 * hiccups (lock-screen, wifi roam) typically lands within 5–8s; 12s is
 * a conservative window that still bounds the time the user stares at
 * "Reconnecting…".
 */
const RECOVERY_TIMEOUT_MS = 12000;

export interface SpaceCallState {
  /** Lifecycle phase. UI can render "Reconnecting…" on `recovering`. */
  phase: SpaceCallPhase;
  activeRoomId: string | null;
  spaceId: string | null;
  channelId: string | null;
  participants: string[];
  isMuted: boolean;
  isVideoEnabled: boolean;
  /**
   * Loudspeaker on/off. Drives the speaker button in SpaceCallScreen.
   * On voice (audio-only) calls iOS routes to the earpiece by default
   * for the voiceChat audio session mode; this toggles the override.
   * For video calls iOS already routes to the speaker via
   * defaultToSpeaker, but the toggle still works to let the user pin
   * earpiece if they prefer.
   */
  isSpeakerOn: boolean;
  callQuality: CallQuality | null;
  // Addresses currently emitting audio above the speaking threshold.
  // Updated on a fast cadence from `pc.getStats()` audioLevel readings.
  speakingAddresses: string[];
}

export interface SpaceCallContextValue {
  state: SpaceCallState;
  /** Whether the full-screen call view is minimized to PiP */
  isOverlayMinimized: boolean;
  setOverlayMinimized: (minimized: boolean) => void;
  joinCall: (roomId: string, spaceId: string, channelId: string, withVideo?: boolean) => Promise<void>;
  leaveCall: () => Promise<void>;
  toggleMute: () => void;
  toggleVideo: () => void;
  toggleSpeaker: () => void;
  flipCamera: () => void;
  getLocalStream: () => MediaStream | null;
  getRemoteStream: () => MediaStream | null;
  /**
   * Returns a plain-text dump of the in-memory diagnostic buffer for the
   * current (or most recently ended) call. Privacy-preserving: structural
   * events only, peer-indexed not address-keyed. Intended for hidden
   * surface → clipboard copy. Returns null if no buffer exists.
   */
  getDiagnosticsText: () => string | null;
}

const SpaceCallContext = createContext<SpaceCallContextValue | null>(null);

const initialState: SpaceCallState = {
  phase: 'idle',
  activeRoomId: null,
  spaceId: null,
  channelId: null,
  participants: [],
  isMuted: false,
  isVideoEnabled: false,
  isSpeakerOn: false,
  callQuality: null,
  speakingAddresses: [],
};

// audioLevel is per-frame [0..1]; 0.05 catches speech without flickering on
// background noise. Once seen, hold for SPEAKING_HOLD_MS so the indicator
// doesn't strobe between syllables.
const SPEAKING_THRESHOLD = 0.05;
const SPEAKING_HOLD_MS = 600;
const SPEAKING_POLL_MS = 500;

export function SpaceCallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { enqueueOutbound } = useWebSocket();
  const queryClient = useQueryClient();
  const [state, setState] = useState<SpaceCallState>(initialState);
  const [isOverlayMinimized, setOverlayMinimized] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const controlChannelRef = useRef<any>(null);
  // Synchronous mirror of state.phase — closures over the React state read
  // stale values. Updated inside transition() before the setState that
  // mirrors it, so synchronous guards see the truth.
  const phaseRef = useRef<SpaceCallPhase>('idle');
  const recoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endingInFlightRef = useRef(false);
  const enterEndingRef = useRef<(reason: string, opts?: { announceEnd?: boolean }) => Promise<void>>(
    () => Promise.resolve(),
  );
  // Pairs with releaseAudioSession() on cleanup so iOS routing returns to
  // the default profile after the call.
  const audioSessionActiveRef = useRef(false);
  const renegErrorCountRef = useRef(0);
  // Serializes the renegotiation handler so back-to-back offers can't both
  // hit setRemoteDescription while the PC is in have-remote-offer (which
  // throws InvalidStateError and wedges the SFU answer for the call).
  const renegChainRef = useRef<Promise<void>>(Promise.resolve());
  const sfuClientRef = useRef(new SFUClient());
  const relayClientRef = useRef(new RelayClient());
  const circuitIdRef = useRef<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const qualityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speakingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // remote-track-id → participant address. SFU stamps event.streams[0].id
  // as "stream-<addr>", so inbound-rtp stats (which only carry
  // trackIdentifier) can be mapped back.
  const trackToAddrRef = useRef<Map<string, string>>(new Map());
  const speakingHoldRef = useRef<Map<string, number>>(new Map());

  // Poll room info to keep participant list up to date
  const startParticipantPolling = useCallback((roomId: string) => {
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = setInterval(async () => {
      try {
        const info = await sfuClientRef.current.getRoomInfo(roomId);
        if (info) {
          setState(prev => {
            // Emit a delta event with COUNTS only — never the addresses
            // themselves. This is enough to see "we missed a leave" or
            // "we're stuck at 1 participant" without identifying anyone.
            const prevSet = new Set(prev.participants);
            const nextSet = new Set(info.participants);
            let added = 0;
            let removed = 0;
            for (const a of nextSet) if (!prevSet.has(a)) added++;
            for (const a of prevSet) if (!nextSet.has(a)) removed++;
            if (added > 0 || removed > 0) {
              callDiag.pushEvent('participants.delta', {
                added,
                removed,
                total: info.participants.length,
              });
            }
            return { ...prev, participants: info.participants };
          });
        } else {
          // Room no longer active — the SFU has dropped it, usually
          // because the last other participant left. End the call so
          // resources release rather than sitting on a dead room.
          setState(prev => {
            if (prev.participants.length > 0) {
              callDiag.pushEvent('participants.delta', {
                added: 0,
                removed: prev.participants.length,
                total: 0,
                roomGone: true,
              });
            }
            return { ...prev, participants: [] };
          });
          if (phaseRef.current === 'connected' || phaseRef.current === 'recovering') {
            // Schedule outside the interval callback to avoid mutating
            // state mid-iteration. Use the ref so we always get the
            // latest enterEnding implementation.
            setTimeout(() => {
              if (phaseRef.current === 'connected' || phaseRef.current === 'recovering') {
                enterEndingRef.current('room_gone', { announceEnd: false }).catch(() => { /* noop */ });
              }
            }, 0);
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);
  }, []);

  const stopParticipantPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const startQualityMonitor = useCallback(() => {
    if (qualityIntervalRef.current) clearInterval(qualityIntervalRef.current);

    let prevBytesSent = 0;
    let prevBytesReceived = 0;
    let prevTimestamp = 0;

    qualityIntervalRef.current = setInterval(async () => {
      // Stats are only meaningful (and worth the bridge cost) while the
      // call is actually connected — skip during recovery/teardown ticks.
      if (phaseRef.current !== 'connected') return;
      const pc = pcRef.current;
      if (!pc) return;

      try {
        const stats = await (pc as any).getStats();
        let rtt = 0;
        let jitter = 0;
        let packetsLost = 0;
        let packetsReceived = 0;
        let totalBytesSent = 0;
        let totalBytesReceived = 0;
        const now = Date.now();

        stats.forEach((report: any) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            if (report.currentRoundTripTime != null) {
              rtt = report.currentRoundTripTime * 1000;
            }
          }
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            if (report.jitter != null) jitter = report.jitter * 1000;
            if (report.packetsLost != null) packetsLost += report.packetsLost;
            if (report.packetsReceived != null) packetsReceived += report.packetsReceived;
            if (report.bytesReceived != null) totalBytesReceived += report.bytesReceived;
          }
          if (report.type === 'outbound-rtp') {
            if (report.bytesSent != null) totalBytesSent += report.bytesSent;
          }
        });

        const totalPackets = packetsReceived + packetsLost;
        const packetLoss = totalPackets > 0 ? packetsLost / totalPackets : 0;

        let bitrate = 0;
        if (prevTimestamp > 0) {
          const elapsedMs = now - prevTimestamp;
          if (elapsedMs > 0) {
            const bytesDelta = (totalBytesSent - prevBytesSent) + (totalBytesReceived - prevBytesReceived);
            bitrate = (bytesDelta * 8) / elapsedMs;
          }
        }
        prevBytesSent = totalBytesSent;
        prevBytesReceived = totalBytesReceived;
        prevTimestamp = now;

        let level: CallQuality['level'] = 'fair';
        if (rtt > 400 || packetLoss > 0.1) level = 'poor';
        else if (rtt < 150 && packetLoss < 0.02) level = 'good';

        setState(prev => ({
          ...prev,
          callQuality: { rtt, packetLoss, jitter, bitrate: Math.round(bitrate), level },
        }));
      } catch {
        // Ignore stats errors
      }
    }, 3000);
  }, []);

  const stopQualityMonitor = useCallback(() => {
    if (qualityIntervalRef.current) {
      clearInterval(qualityIntervalRef.current);
      qualityIntervalRef.current = null;
    }
  }, []);

  const startSpeakingMonitor = useCallback(() => {
    if (speakingIntervalRef.current) clearInterval(speakingIntervalRef.current);
    speakingIntervalRef.current = setInterval(async () => {
      // Speaking indicators only matter (and audioLevel only flows) while
      // connected — skip the getStats bridge call otherwise.
      if (phaseRef.current !== 'connected') return;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await (pc as any).getStats();
        const now = Date.now();
        const hold = speakingHoldRef.current;

        stats.forEach((report: any) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            const level: number | undefined = report.audioLevel;
            if (level == null) return;
            const trackId: string | undefined = report.trackIdentifier;
            const addr = trackId ? trackToAddrRef.current.get(trackId) : undefined;
            if (!addr) return;
            if (level >= SPEAKING_THRESHOLD) {
              hold.set(addr, now + SPEAKING_HOLD_MS);
            }
          } else if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            const level: number | undefined = report.audioLevel;
            if (level == null) return;
            const selfAddr = user?.address;
            if (!selfAddr) return;
            if (level >= SPEAKING_THRESHOLD) {
              hold.set(selfAddr, now + SPEAKING_HOLD_MS);
            }
          }
        });

        // Build the current speaking list from holds that haven't expired.
        const next: string[] = [];
        for (const [addr, until] of hold) {
          if (until > now) next.push(addr);
          else hold.delete(addr);
        }
        next.sort();

        setState(prev => {
          if (
            prev.speakingAddresses.length === next.length &&
            prev.speakingAddresses.every((a, i) => a === next[i])
          ) {
            return prev;
          }
          return { ...prev, speakingAddresses: next };
        });
      } catch {
        // Ignore stats errors
      }
    }, SPEAKING_POLL_MS);
  }, [user?.address]);

  const stopSpeakingMonitor = useCallback(() => {
    if (speakingIntervalRef.current) {
      clearInterval(speakingIntervalRef.current);
      speakingIntervalRef.current = null;
    }
    speakingHoldRef.current.clear();
  }, []);

  /**
   * Validate and apply a phase transition. The ref is updated
   * synchronously so callbacks downstream of the same tick read the
   * new phase; state is mirrored on the next render so UI updates.
   * Illegal transitions are emitted as diagnostic events and rejected
   * — this is intentional: an illegal attempt is almost always a
   * latent bug we'd want to see post-mortem, not paper over.
   *
   * Returns true if the transition was applied.
   */
  const transition = useCallback((to: SpaceCallPhase, reason: string): boolean => {
    const from = phaseRef.current;
    if (from === to) return false; // idempotent, but not worth a diag event
    if (!LEGAL_TRANSITIONS[from].includes(to)) {
      callDiag.pushEvent('phase.illegal', { from, to, reason });
      logger.debug(`[SpaceCall] illegal transition ${from} → ${to} (${reason})`);
      return false;
    }
    callDiag.pushEvent('phase.transition', { from, to, reason });
    phaseRef.current = to;
    setState(prev => (prev.phase === to ? prev : { ...prev, phase: to }));
    return true;
  }, []);

  /** Pure resource teardown — no state changes, no diag end. */
  const cleanupResources = useCallback(() => {
    stopParticipantPolling();
    stopQualityMonitor();
    stopSpeakingMonitor();
    if (recoveryTimeoutRef.current) {
      clearTimeout(recoveryTimeoutRef.current);
      recoveryTimeoutRef.current = null;
    }

    let tracksStopped = 0;
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        try { track.stop(); } catch { /* noop */ }
        tracksStopped++;
      });
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      // Explicitly drop refs to remote tracks so RTCView teardown isn't
      // racing against the SFU stopping them.
      try {
        remoteStreamRef.current.getTracks().forEach(t => {
          try { remoteStreamRef.current!.removeTrack(t); } catch { /* noop */ }
        });
      } catch { /* noop */ }
      remoteStreamRef.current = null;
    }
    if (controlChannelRef.current) {
      try { controlChannelRef.current.close(); } catch {}
      controlChannelRef.current = null;
    }
    renegChainRef.current = Promise.resolve();
    renegErrorCountRef.current = 0;
    trackToAddrRef.current.clear();
    if (pcRef.current) {
      try { pcRef.current.close(); } catch { /* noop */ }
      pcRef.current = null;
    }
    // Release circuit
    if (circuitIdRef.current) {
      relayClientRef.current.releaseCircuit(circuitIdRef.current).catch(() => {});
      circuitIdRef.current = null;
    }
    // Release iOS audio session so post-call audio routing returns to the
    // system default. Paired with prepareAudioSession at join.
    if (audioSessionActiveRef.current) {
      audioSessionActiveRef.current = false;
      if (Platform.OS === 'ios') {
        QuorumCrypto.releaseAudioSession().catch(() => { /* noop */ });
      }
    }
    callDiag.pushEvent('cleanup.done', { tracksStopped });
  }, [stopParticipantPolling, stopQualityMonitor, stopSpeakingMonitor]);

  /**
   * Centralized exit path. Idempotent — multiple callers (user hangup,
   * pc.connectionState=failed, recovery timeout, reneg failure, error
   * during join) can all call this without double-cleanup or duplicated
   * "space-call-end" messages. Transitions through `ending` and back to
   * `idle`, finalizes the diagnostic buffer with the supplied reason.
   *
   * @param reason  short structured code for telemetry (`user_leave`,
   *                `recovery_timeout`, `pc_failed`, `reneg_failed`,
   *                `join_error`, `room_gone`)
   * @param opts.announceEnd  whether to emit space-call-end into the
   *                channel. False for paths where we never reached
   *                connected, so the room doesn't get a phantom
   *                "call ended" bubble.
   */
  const enterEnding = useCallback(async (
    reason: string,
    opts: { announceEnd?: boolean } = {},
  ): Promise<void> => {
    if (endingInFlightRef.current) return;
    // Already idle — nothing to end. This protects against re-entrancy
    // when a join cancels mid-flight (the catch path also calls
    // enterEnding) and against any caller invoking us on a stale call.
    if (phaseRef.current === 'idle') return;
    endingInFlightRef.current = true;

    // Capture routing fields before we reset state. Reading via the
    // setState callback returns the current React-state value without
    // mutating, which avoids stale-closure issues from awaiting other
    // mutations earlier in this tick.
    let snapRoomId: string | null = null;
    let snapSpaceId: string | null = null;
    let snapChannelId: string | null = null;
    setState(prev => {
      snapRoomId = prev.activeRoomId;
      snapSpaceId = prev.spaceId;
      snapChannelId = prev.channelId;
      return prev;
    });

    transition('ending', reason);
    callDiag.pushEvent('call.end.start', { reason });

    // Best-effort SFU.leave so the server frees the slot promptly
    // rather than waiting on its disconnect detector.
    if (snapRoomId && user?.address) {
      try {
        await sfuClientRef.current.leaveRoom({
          roomId: snapRoomId,
          address: user.address,
          signMessage: signForRelay,
        });
        callDiag.pushEvent('sfu.leave.ack');
      } catch {
        callDiag.pushEvent('sfu.leave.err');
      }
    }

    // Emit the space-call-end bubble (only for "real" endings — not
    // for joins that failed before we ever connected).
    const announce = opts.announceEnd ?? true;
    if (announce && snapSpaceId && snapChannelId && snapRoomId && user?.address) {
      try {
        const { sendSpaceCallEndMessage } = await import('@/services/space/spaceMessageService');
        const result = await sendSpaceCallEndMessage({
          spaceId: snapSpaceId,
          channelId: snapChannelId,
          senderAddress: user.address,
          callId: snapRoomId,
        });
        enqueueOutbound(async () => [result.wsEnvelope]);
        const messagesKey = queryKeys.messages.infinite(snapSpaceId, snapChannelId);
        queryClient.setQueryData<{ pages: { messages: Message[] }[]; pageParams: unknown[] }>(
          messagesKey,
          (old) => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map((page, i) =>
                i === 0 ? { ...page, messages: [...page.messages, result.message] } : page,
              ),
            };
          },
        );
      } catch {
        // Best-effort
      }
    }

    cleanupResources();
    setState(initialState);
    setOverlayMinimized(false);
    transition('idle', reason);
    callDiag.endCall(reason);

    // Tear down the Android foreground service. Best-effort fire-and-
    // forget — by this point the WebRTC pipeline is already closed by
    // cleanupResources, so even if the service hangs around for a tick
    // longer than needed there's nothing left to background-keep-alive.
    QuorumCrypto.stopCallService().catch(() => { /* noop */ });

    endingInFlightRef.current = false;
  }, [transition, cleanupResources, user, enqueueOutbound, queryClient]);

  // Mirror the latest enterEnding into the ref so long-lived closures
  // (participant poller, PC handlers, datachannel onmessage) all invoke
  // the current implementation even after re-renders.
  enterEndingRef.current = enterEnding;

  const joinCall = useCallback(async (roomId: string, spaceId: string, channelId: string, withVideo: boolean = false) => {
    if (!user?.address || !signForRelay) {
      throw new Error('Not authenticated');
    }

    // If we're mid-leaving from a prior call, wait for it to finish
    // before starting a new one — otherwise we'd race the cleanup.
    if (phaseRef.current === 'ending') {
      callDiag.pushEvent('call.duplicate_join_blocked', { reason: 'ending' });
      return;
    }
    // If we're already in a call (connected/recovering), leave first.
    if (phaseRef.current === 'connected' || phaseRef.current === 'recovering') {
      await enterEnding('user_leave', { announceEnd: true });
    }
    if (!transition('joining', 'user_join')) {
      callDiag.pushEvent('call.duplicate_join_blocked', { reason: 'already_joining' });
      return;
    }

    try {
      callDiag.startCall();
      callDiag.pushEvent('call.start', { withVideo });

      logger.debug(`[SpaceCall] Joining room ${roomId}`);

      const circuit = await relayClientRef.current.allocateCircuit({
        callerAddress: user.address,
        signMessage: signForRelay,
      });
      circuitIdRef.current = circuit.circuitId;
      callDiag.pushEvent('circuit.allocated');

      const turnCredentials: TurnCredentials = circuit.relayA;

      if (Platform.OS === 'ios') {
        try {
          await QuorumCrypto.prepareAudioSession();
          await new Promise(resolve => setTimeout(resolve, 200));
          audioSessionActiveRef.current = true;
          callDiag.pushEvent('audio.session.prewarmed');
        } catch {
          callDiag.pushEvent('audio.session.failed');
        }
      }

      const pc = new RTCPeerConnection({
        iceServers: [{
          urls: turnCredentials.turnUrls,
          username: turnCredentials.username,
          credential: turnCredentials.password,
        }],
        iceTransportPolicy: 'relay',
      });
      pcRef.current = pc;
      callDiag.pushEvent('pc.created');

      // connected → disconnected arms recovery (RECOVERY_TIMEOUT_MS window),
      // returns to connected on its own if ICE renegotiates, otherwise ends.
      // failed is terminal and skips recovery.
      (pc as any).onconnectionstatechange = () => {
        const cs = (pc as any).connectionState as string | undefined;
        if (!cs) return;
        // If a stale pc fires after we've torn down, ignore.
        if (pcRef.current !== pc) return;
        callDiag.pushEvent('pc.state', { state: cs, phase: phaseRef.current });

        if (cs === 'connected') {
          if (phaseRef.current === 'recovering') {
            if (recoveryTimeoutRef.current) {
              clearTimeout(recoveryTimeoutRef.current);
              recoveryTimeoutRef.current = null;
            }
            transition('connected', 'pc_recovered');
          }
        } else if (cs === 'disconnected') {
          if (phaseRef.current === 'connected') {
            if (transition('recovering', 'pc_disconnected')) {
              if (recoveryTimeoutRef.current) clearTimeout(recoveryTimeoutRef.current);
              recoveryTimeoutRef.current = setTimeout(() => {
                recoveryTimeoutRef.current = null;
                if (phaseRef.current === 'recovering') {
                  enterEndingRef.current('recovery_timeout').catch(() => { /* noop */ });
                }
              }, RECOVERY_TIMEOUT_MS);
            }
          }
        } else if (cs === 'failed') {
          if (phaseRef.current === 'connected' || phaseRef.current === 'recovering') {
            // Defer to next tick so we don't unmount mid-event.
            setTimeout(() => {
              if (pcRef.current === pc) {
                enterEndingRef.current('pc_failed').catch(() => { /* noop */ });
              }
            }, 0);
          }
        }
      };
      (pc as any).oniceconnectionstatechange = () => {
        const ics = (pc as any).iceConnectionState as string | undefined;
        if (!ics) return;
        if (pcRef.current !== pc) return;
        callDiag.pushEvent('pc.ice.state', { state: ics });
      };

    // Union all incoming tracks into a single persistent MediaStream rather
    // than replacing the ref with event.streams[0]. Replacing breaks
    // multi-participant video tiles and silences audio on iOS (AVAudioSession
    // routing requires the track stays in a stream we hold).
    if (!remoteStreamRef.current) {
      remoteStreamRef.current = new MediaStream([]);
    }
    (pc as any).ontrack = (event: any) => {
      if (pcRef.current !== pc) return;
      const incoming = event.track;
      if (!incoming) return;
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream([]);
      }
      const stream = remoteStreamRef.current;
      // pion replays existing transceiver tracks on renegotiation.
      const existing = stream.getTracks().find(t => t.id === incoming.id);
      if (!existing) {
        stream.addTrack(incoming);
      }
      // Record track→participant for speaking detection. The SFU labels
      // each forwarded track's stream as "stream-<addr>".
      const sfuStreamId: string | undefined = event.streams?.[0]?.id;
      let pIdx = -1;
      if (sfuStreamId && sfuStreamId.startsWith('stream-') && incoming.id) {
        const addr = sfuStreamId.slice('stream-'.length);
        trackToAddrRef.current.set(incoming.id, addr);
        pIdx = callDiag.peerIndex(addr);
      }
      callDiag.pushEvent('peer.track', {
        peerIndex: pIdx,
        kind: incoming.kind ?? 'unknown',
        deduped: !!existing,
      });
      // When a participant leaves, the SFU stops the corresponding output
      // track. Drop it from the union stream so getTracks() reflects the
      // live set.
      incoming.addEventListener?.('ended', () => {
        try { stream.removeTrack(incoming); } catch { /* noop */ }
        const endedAddr = incoming.id ? trackToAddrRef.current.get(incoming.id) : undefined;
        const endedIdx = endedAddr ? callDiag.peerIndex(endedAddr) : -1;
        if (incoming.id) trackToAddrRef.current.delete(incoming.id);
        callDiag.pushEvent('peer.track.ended', {
          peerIndex: endedIdx,
          kind: incoming.kind ?? 'unknown',
        });
      });
    };

    // Open the renegotiation datachannel BEFORE creating the offer so the
    // SFU sees it via OnDataChannel and can push SDP offers when the room's
    // track set changes (participant joins/leaves, video toggle).
    const controlChannel = (pc as any).createDataChannel('sfu-control', {
      ordered: true,
    });
    controlChannelRef.current = controlChannel;
    controlChannel.onmessage = (event: any) => {
      // Chain each offer onto the prior renegotiation so we never enter
      // setRemoteDescription while another offer is mid-await — two close
      // messages would race and InvalidStateError leaves the SFU's
      // renegInFlight stuck for the rest of the call. On consecutive
      // failures we attempt rollback and then end with reason `reneg_failed`.
      renegChainRef.current = renegChainRef.current.then(async () => {
        const startedAt = Date.now();
        let phase: string = 'parse';
        try {
          callDiag.pushEvent('dc.reneg.start');
          const msg = JSON.parse(event.data);
          if (msg?.type !== 'offer' || typeof msg.sdp !== 'string') {
            callDiag.pushEvent('dc.reneg.done', {
              ms: Date.now() - startedAt,
              noop: true,
            });
            return;
          }
          phase = 'setRemoteDescription';
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }),
          );
          phase = 'createAnswer';
          const answer = await pc.createAnswer();
          if (answer.sdp) {
            answer.sdp = enforceConstantBitrate(answer.sdp);
          }
          phase = 'setLocalDescription';
          await pc.setLocalDescription(answer);
          phase = 'send';
          controlChannel.send(JSON.stringify({ type: 'answer', sdp: answer.sdp ?? '' }));
          renegErrorCountRef.current = 0;
          callDiag.pushEvent('dc.reneg.done', { ms: Date.now() - startedAt });
        } catch (e) {
          const errName = (e instanceof Error && e.name) ? e.name : 'Error';
          const signalingState = (pc as any).signalingState as string | undefined;
          renegErrorCountRef.current += 1;
          callDiag.pushEvent('dc.reneg.error', {
            ms: Date.now() - startedAt,
            phase,
            err: errName,
            signalingState: signalingState ?? 'unknown',
            consecutive: renegErrorCountRef.current,
          });
          logger.debug('[SpaceCall] control message error:', e);
          if (signalingState === 'have-remote-offer') {
            try {
              await pc.setLocalDescription({ type: 'rollback' } as any);
              callDiag.pushEvent('dc.reneg.rollback', { ok: true });
            } catch {
              callDiag.pushEvent('dc.reneg.rollback', { ok: false });
            }
          }
          if (renegErrorCountRef.current >= 3) {
            const dyingPc = pc;
            setTimeout(() => {
              if (pcRef.current === dyingPc) {
                enterEndingRef.current('reneg_failed').catch(() => { /* noop */ });
              }
            }, 0);
          }
        }
      });
    };

      const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: withVideo
          ? { facingMode: 'user', width: 640, height: 480, frameRate: 24 }
          : false,
      });
      localStreamRef.current = stream;
      stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
      });
      callDiag.pushEvent('media.local.acquired', {
        audio: stream.getAudioTracks().length > 0,
        video: stream.getVideoTracks().length > 0,
      });

      // Pre-allocate recvonly transceivers so multi-participant SFU rooms
      // can absorb senders without renegotiating until > N participants.
      // Video slots reserved even for voice calls since participants can
      // add video mid-call.
      const RECVONLY_AUDIO_SLOTS = 15;
      for (let i = 0; i < RECVONLY_AUDIO_SLOTS; i++) {
        (pc as any).addTransceiver('audio', { direction: 'recvonly' });
      }
      const RECVONLY_VIDEO_SLOTS = 15;
      for (let i = 0; i < RECVONLY_VIDEO_SLOTS; i++) {
        (pc as any).addTransceiver('video', { direction: 'recvonly' });
      }
      callDiag.pushEvent('media.transceivers.preallocated', {
        audio: RECVONLY_AUDIO_SLOTS,
        video: RECVONLY_VIDEO_SLOTS,
      });

      const offer = await pc.createOffer({});
      if (offer.sdp) {
        offer.sdp = enforceConstantBitrate(offer.sdp);
      }
      await pc.setLocalDescription(offer);
      callDiag.pushEvent('sdp.offer.created');

      const sfuAt = Date.now();
      const result = await sfuClientRef.current.joinRoom({
        roomId,
        spaceId,
        channelId,
        sdpOffer: offer.sdp ?? '',
        address: user.address,
        signMessage: signForRelay,
      });
      callDiag.pushEvent('sfu.join.ack', {
        rttMs: Date.now() - sfuAt,
        participants: result.participants.length,
      });
      // Pre-register peer indices in SFU-returned order for deterministic
      // diag-buffer indexing.
      for (const addr of result.participants) {
        if (addr !== user.address) callDiag.peerIndex(addr);
      }

      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'answer', sdp: result.sdpAnswer })
      );
      callDiag.pushEvent('sdp.answer.applied');

      // Promote phase before installing room state so a PC-fires-connected
      // race sees the correct from phase. transition() bails if we're
      // already in `ending` (user left mid-join).
      if (!transition('connected', 'sfu_ack_applied')) {
        // We must have been ended/cancelled mid-join. The catch path
        // would have already torn down resources; just bail.
        throw new Error('join cancelled');
      }
      setState(prev => ({
        ...prev,
        activeRoomId: roomId,
        spaceId,
        channelId,
        participants: result.participants,
        isMuted: false,
        isVideoEnabled: withVideo,
        // Video calls default to loudspeaker (iOS prepareAudioSession
        // sets defaultToSpeaker); voice calls start on the earpiece.
        // Mirror that initial state here so the toggle button shows the
        // right active state on first paint.
        isSpeakerOn: withVideo,
        callQuality: null,
        speakingAddresses: [],
      }));

      // Start polling for participant updates
      startParticipantPolling(roomId);
      startQualityMonitor();
      startSpeakingMonitor();

      // Promote the call to a foreground service (Android) so the
      // WebRTC pipeline survives backgrounding. No-op on iOS where
      // the `voip`/`audio` UIBackgroundModes + active AVAudioSession
      // already cover this.
      try {
        const { getSpace } = await import('@/services/config/spaceStorage');
        const spaceMeta = getSpace(spaceId);
        const displayName = spaceMeta?.spaceName || 'Space call';
        await QuorumCrypto.startCallService(roomId, displayName, withVideo);
      } catch (svcErr) {
        // Non-fatal — call still runs in the foreground; only
        // backgrounding behavior is degraded.
        logger.debug('[SpaceCall] startCallService failed:', svcErr);
      }

      logger.debug(`[SpaceCall] Joined room ${roomId} with ${result.participants.length} participant(s)`);
    } catch (e) {
      callDiag.pushEvent('call.join.error', {
        err: (e instanceof Error && e.name) ? e.name : 'Error',
      });
      // Run the centralized exit path. announceEnd=false because we
      // never connected — no "call ended" bubble belongs in the room.
      // If the failure happened while still in `joining`, transition to
      // `ending` legally; if a downstream handler already moved us past
      // joining (rare), enterEnding is a no-op via endingInFlightRef.
      await enterEnding('join_error', { announceEnd: false });
      throw e;
    }
  }, [user, transition, enterEnding, startParticipantPolling, startQualityMonitor, startSpeakingMonitor]);

  const leaveCall = useCallback(async () => {
    // All exit paths funnel through enterEnding — the announcement,
    // cleanup, state reset, and diag.endCall live in one place there.
    await enterEnding('user_leave', { announceEnd: true });
  }, [enterEnding]);

  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      const newMuted = !state.isMuted;
      audioTracks.forEach(track => {
        track.enabled = !newMuted;
      });
      setState(prev => ({ ...prev, isMuted: newMuted }));
    }
  }, [state.isMuted]);

  /**
   * Flip the call's audio output between the loudspeaker and the
   * default route (earpiece, or whatever the audio session would pick —
   * Bluetooth/headphones override unconditionally regardless of this).
   * Optimistic: we update the UI state immediately and let the native
   * setSpeakerphoneEnabled call run async. If it fails the visible
   * state may be inconsistent with the actual route for a moment, but
   * the user's expected control is fast and the cost of a stale icon
   * is small.
   */
  const toggleSpeaker = useCallback(() => {
    setState(prev => {
      const next = !prev.isSpeakerOn;
      QuorumCrypto.setSpeakerphoneEnabled(next).catch((e) => {
        logger.debug('[SpaceCall] setSpeakerphoneEnabled failed:', e);
      });
      callDiag.pushEvent('audio.speaker.toggle', { on: next });
      return { ...prev, isSpeakerOn: next };
    });
  }, []);

  const toggleVideo = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    if (videoTracks.length === 0) {
      // No video track was acquired at join — true mid-call addition would
      // require getUserMedia for video + renegotiation. For now, only allow
      // toggling when a video track exists from the start.
      logger.debug('[SpaceCall] toggleVideo: no video track to toggle (call started without video)');
      return;
    }
    setState(prev => {
      const next = !prev.isVideoEnabled;
      videoTracks.forEach(track => { track.enabled = next; });
      return { ...prev, isVideoEnabled: next };
    });
  }, []);

  const flipCamera = useCallback(() => {
    if (!localStreamRef.current) return;
    const videoTracks = localStreamRef.current.getVideoTracks();
    videoTracks.forEach(track => {
      // react-native-webrtc exposes _switchCamera on video tracks
      if (typeof (track as any)._switchCamera === 'function') {
        (track as any)._switchCamera();
      }
    });
  }, []);

  const getLocalStream = useCallback((): MediaStream | null => {
    return localStreamRef.current;
  }, []);

  const getRemoteStream = useCallback((): MediaStream | null => {
    return remoteStreamRef.current;
  }, []);

  const getDiagnosticsText = useCallback((): string | null => {
    const text = callDiag.formatForExport();
    return text === 'call-diag: no buffer' ? null : text;
  }, []);

  // Memoized so a provider re-render that doesn't change the call state
  // doesn't re-render every useSpaceCall() consumer. (During a call, the
  // audio-level/quality polling intervals update `state` frequently — see
  // the deeper note: that high-frequency state ideally lives outside the
  // shared context value so only the overlay subscribes to it.)
  const contextValue = useMemo<SpaceCallContextValue>(
    () => ({
      state,
      isOverlayMinimized,
      setOverlayMinimized,
      joinCall,
      leaveCall,
      toggleMute,
      toggleVideo,
      toggleSpeaker,
      flipCamera,
      getLocalStream,
      getRemoteStream,
      getDiagnosticsText,
    }),
    [
      state,
      isOverlayMinimized,
      setOverlayMinimized,
      joinCall,
      leaveCall,
      toggleMute,
      toggleVideo,
      toggleSpeaker,
      flipCamera,
      getLocalStream,
      getRemoteStream,
      getDiagnosticsText,
    ],
  );

  return (
    <SpaceCallContext.Provider value={contextValue}>
      {children}
    </SpaceCallContext.Provider>
  );
}

export function useSpaceCall(): SpaceCallContextValue {
  const context = useContext(SpaceCallContext);
  if (!context) {
    throw new Error('useSpaceCall must be used within a SpaceCallProvider');
  }
  return context;
}
