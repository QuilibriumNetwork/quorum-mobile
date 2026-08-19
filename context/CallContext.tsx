import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import { Platform } from 'react-native';
import type { MediaStream } from 'react-native-webrtc';
import { hexToBytes, logger, type Message } from '@quilibrium/quorum-shared';
import { useAuth, useWebSocket } from '@/context';
import { mmkvStorage } from '@/services/offline/storage';
import {
  WebRTCManager,
  RelayClient,
  createCallOffer,
  createCallAnswer,
  createCallReject,
  createCallHangup,
  createCallIceCandidate,
  createCallEvent,
  createCallRenegotiate,
} from '@/services/calling';
import type { TurnCredentials, CallQuality } from '@/services/calling';
import {
  reportIncomingCall as nativeReportIncomingCall,
  reportOutgoingCall as nativeReportOutgoingCall,
  reportOutgoingCallConnected as nativeReportOutgoingCallConnected,
  reportCallConnected as nativeReportCallConnected,
  reportCallEnded as nativeReportCallEnded,
  onNativeCallAction,
} from '@/services/calling/native-call';
import { sendEncryptedMessageToAllDevices } from '@/hooks/chat/useSendDirectMessage';
import QuorumCrypto from '@/modules/quorum-crypto/src';
import { encryptionStateStorage } from '@/services/crypto/encryption-state-storage';
import { getDeviceKeyset } from '@/services/onboarding/secureStorage';
import { getQuorumClient } from '@/services/api/quorumClient';
import { ensurePrivateKey } from '@/services/onboarding/keyService';
import { NativeCryptoProvider } from '@/services/crypto/native-provider';
import { base64ToHex } from '@/utils/encoding';

const log = logger.scope('[Call]');

export type CallState =
  | 'idle'
  | 'offering'
  | 'ringing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

export interface ActiveCall {
  callId: string;
  conversationId: string;
  recipientAddress: string;
  recipientDisplayName: string;
  recipientAvatar: string;
  direction: 'outgoing' | 'incoming';
  mediaType: 'audio' | 'video';
  state: CallState;
  startTime: number | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  isVideoEnabled: boolean;
  circuitId: string | null;
  endReason: string | null;
  callQuality: CallQuality | null;
}

export interface IncomingCallInfo {
  callId: string;
  conversationId: string;
  callerAddress: string;
  callerDisplayName: string;
  callerAvatar: string;
  mediaType: 'audio' | 'video';
  sdp: string;
  relayCredentials: TurnCredentials;
  circuitId: string;
  receivedAt: number;
}

export interface InitiateCallParams {
  conversationId: string;
  recipientAddress: string;
  recipientDisplayName: string;
  recipientAvatar: string;
  mediaType: 'audio' | 'video';
}

export interface CallContextValue {
  activeCall: ActiveCall | null;
  incomingCall: IncomingCallInfo | null;
  initiateCall: (params: InitiateCallParams) => Promise<void>;
  acceptCall: (callId: string) => Promise<void>;
  rejectCall: (callId: string) => Promise<void>;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  toggleVideo: () => void;
  flipCamera: () => void;
  getLocalStream: () => MediaStream | null;
  getRemoteStream: () => MediaStream | null;
}

const CallContext = createContext<CallContextValue | null>(null);

const RING_TIMEOUT_MS = 30000;
const ROTATION_WINDOW_MS = 300000;  // 5 minutes
const ROTATION_JITTER_MS = 30000;   // ±30 seconds
const CALL_SCREENING_KEY = 'call:screenUnknown';

/**
 * Compute the next aligned rotation boundary: the next 5-minute wall-clock
 * mark (e.g. :00, :05, :10, :15...) plus random jitter in [-30s, +30s].
 * All calls rotate in the same window, making it harder to correlate
 * circuit teardown/creation times across different conversations.
 */
function nextRotationTime(): number {
  const now = Date.now();
  const windowStart = Math.ceil(now / ROTATION_WINDOW_MS) * ROTATION_WINDOW_MS;
  const jitter = (Math.random() * 2 - 1) * ROTATION_JITTER_MS;
  return windowStart + jitter;
}

function isCallScreeningEnabled(): boolean {
  const val = mmkvStorage.getItem(CALL_SCREENING_KEY);
  return val === null || val === 'true'; // default: on
}

export function setCallScreening(enabled: boolean): void {
  mmkvStorage.setItem(CALL_SCREENING_KEY, enabled ? 'true' : 'false');
}

export function getCallScreening(): boolean {
  return isCallScreeningEnabled();
}

// Check if we have an existing conversation with this address
function hasConversationWith(address: string): boolean {
  // DM conversation IDs contain the address — check a few formats
  const key1 = `conversation:${address}/${address}`;
  const key2 = `conversations:direct`;
  const listData = mmkvStorage.getItem(key2);
  if (!listData) return false;
  try {
    const conversations = JSON.parse(listData);
    return conversations.some((c: { address?: string; conversationId?: string }) =>
      c.address === address || c.conversationId?.includes(address)
    );
  } catch {
    return false;
  }
}


// Sign a message with Ed448 using the correct base64 encoding that the
// native module (and Go server verification) expects.
export async function signForRelay(message: string): Promise<string> {
  const privateKeyHex = await ensurePrivateKey();
  if (!privateKeyHex) throw new Error('Private key not found');

  const privateKeyBytes = hexToBytes(privateKeyHex);
  const privateKeyBase64 = btoa(String.fromCharCode(...privateKeyBytes));

  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);
  const messageBase64 = btoa(String.fromCharCode(...messageBytes));

  const crypto = new NativeCryptoProvider();
  const signatureBase64 = await crypto.signEd448(privateKeyBase64, messageBase64);
  return base64ToHex(signatureBase64);
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { enqueueOutbound, subscribe, isConnected } = useWebSocket();

  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);

  const webrtcRef = useRef(new WebRTCManager());
  const relayClientRef = useRef(new RelayClient());
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCandidatesRef = useRef<Map<string, any[]>>(new Map());
  const circuitRotationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const paddingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether we're in the post-hangup padding phase (call ended for UI
  // but WebRTC connection still alive sending silence frames until next boundary)
  const isPaddingRef = useRef(false);

  // Track whether native call UI (CallKit/ConnectionService) is active
  // for the current call, so we can report state transitions.
  const nativeCallActiveRef = useRef(false);

  const clearRingTimeout = useCallback(() => {
    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
  }, []);

  const stopCircuitRotation = useCallback(() => {
    if (circuitRotationTimerRef.current) {
      clearTimeout(circuitRotationTimerRef.current);
      circuitRotationTimerRef.current = null;
    }
  }, []);

  const cancelPadding = useCallback(async () => {
    if (paddingTimeoutRef.current) {
      clearTimeout(paddingTimeoutRef.current);
      paddingTimeoutRef.current = null;
    }
    if (isPaddingRef.current) {
      isPaddingRef.current = false;
      await webrtcRef.current.cleanup();
    }
  }, []);

  // Circuit rotation: periodically swap to a new relay to limit traffic
  // correlation by relay nodes. Only applies to 1-to-1 DM calls.
  const activeCallRef = useRef(activeCall);
  activeCallRef.current = activeCall;

  const startCircuitRotation = useCallback(() => {
    stopCircuitRotation();

    const scheduleNext = () => {
      const targetTime = nextRotationTime();
      const delay = Math.max(targetTime - Date.now(), 0);
      log.debug(`next circuit rotation in ${Math.round(delay / 1000)}s`);

      circuitRotationTimerRef.current = setTimeout(async () => {
        const call = activeCallRef.current;
        if (!call || call.state !== 'connected' || !user) {
          // If the call ended but we're padding, don't schedule another rotation
          if (!isPaddingRef.current) {
            scheduleNext();
          }
          return;
        }

        log.debug('circuit rotation: allocating new circuit...');
        const oldCircuitId = call.circuitId;

        try {
          const newCircuit = await relayClientRef.current.allocateCircuit({
            callerAddress: user.address,
            signMessage: signForRelay,
            regionHint: undefined,
          });

          // Determine which relay credentials to use:
          // - Outgoing calls: we're the caller, use relayA for ourselves
          // - Incoming calls: we're the callee, use relayB for ourselves
          const ourCredentials = call.direction === 'outgoing'
            ? newCircuit.relayA
            : newCircuit.relayB;
          const theirCredentials = call.direction === 'outgoing'
            ? newCircuit.relayB
            : newCircuit.relayA;

          // Perform ICE restart with our new TURN credentials
          const offer = await webrtcRef.current.performIceRestart(ourCredentials);

          // Send renegotiation offer to remote with their new TURN credentials
          const renego = createCallRenegotiate({
            senderId: user.address,
            recipientAddress: call.recipientAddress,
            callId: call.callId,
            sdp: offer.sdp,
            relayCredentials: theirCredentials,
          });

          await sendSignalRef.current?.(
            call.conversationId,
            call.recipientAddress,
            renego,
          );

          // Update our circuit ID
          setActiveCall(prev => prev ? {
            ...prev,
            circuitId: newCircuit.circuitId,
          } : null);

          // Release the old circuit
          if (oldCircuitId) {
            relayClientRef.current.releaseCircuit(oldCircuitId);
          }

          log.debug('circuit rotation: complete');
        } catch (error) {
          // Rotation failed — log and retry on next boundary. Don't end the call.
          log.debug('circuit rotation failed (will retry):', error);
        }

        // Schedule the next rotation at the following boundary
        scheduleNext();
      }, delay);
    };

    scheduleNext();
  }, [user, stopCircuitRotation]);

  // Ref for sendSignal so circuit rotation can use it without circular deps
  const sendSignalRef = useRef<((conversationId: string, recipientAddress: string, message: Message) => Promise<void>) | null>(null);

  const sendSignal = useCallback(async (
    conversationId: string,
    recipientAddress: string,
    message: Message,
  ) => {
    if (!user || !isConnected) return;

    const deviceKeyset = await getDeviceKeyset();
    if (!deviceKeyset) return;

    const apiClient = getQuorumClient();
    const { toAllDeviceInfos } = await import('@/hooks/chat/useRecipientRegistration');

    let allTargetDevices: Array<{
      identityKey: number[];
      signedPreKey: number[];
      inboxAddress: string;
      inboxEncryptionKey: number[];
    }> = [];

    try {
      const recipientReg = await apiClient.fetchUserRegistration(recipientAddress);
      if (recipientReg) {
        allTargetDevices = toAllDeviceInfos(recipientReg);
      }
    } catch {
      // Network failure fetching recipient registration — fall through to empty check below
    }

    if (allTargetDevices.length === 0) return;

    // Identity: NONE. sendSignal is the one transport for every call-signaling
    // frame (offer, answer, ICE candidates, hangup, renegotiate, event), and
    // several of those fire on automatic paths with no fresh human act behind
    // them (an ICE candidate is emitted by WebRTC on its own schedule; hangup
    // also fires from onConnectionStateChange on a dropped connection, not
    // only from a user tapping "end call"; renegotiate-answer fires from
    // circuit rotation). Attaching a display_name/user_icon here would let a
    // stranger who merely rings (or whose call drops) harvest identity the
    // same way an automatic DM receipt would — see the receipt-ack transport
    // in WebSocketContext.tsx for the twin case. A deliberately placed call
    // does not get identity via this frame; a partner already revealed to
    // (via a prior deliberate DM) is unaffected because the call UI reads
    // their identity from local state, not from this outbound signal.
    await sendEncryptedMessageToAllDevices(
      conversationId,
      recipientAddress,
      message,
      allTargetDevices,
      enqueueOutbound,
      subscribe,
      {
        identityPublicKey: deviceKeyset.identityPublicKey,
        inboxAddress: deviceKeyset.inboxAddress,
        inboxEncryptionPublicKey: deviceKeyset.inboxEncryptionPublicKey,
      },
      user.address,
    );
  }, [user, isConnected, enqueueOutbound, subscribe]);

  // Keep sendSignalRef in sync for circuit rotation callbacks
  sendSignalRef.current = sendSignal;

  const initiateCall = useCallback(async (params: InitiateCallParams) => {
    if (!user || activeCall) return;

    // If a previous call is still in post-hangup padding, cancel it first
    // so the WebRTC manager and relay client are free for the new call.
    if (isPaddingRef.current) {
      await cancelPadding();
    }

    const senderId = user.address;

    setActiveCall({
      callId: '',
      conversationId: params.conversationId,
      recipientAddress: params.recipientAddress,
      recipientDisplayName: params.recipientDisplayName,
      recipientAvatar: params.recipientAvatar,
      direction: 'outgoing',
      mediaType: params.mediaType,
      state: 'offering',
      startTime: null,
      isMuted: false,
      isSpeakerOn: false,
      isVideoEnabled: params.mediaType === 'video',
      circuitId: null,
      endReason: null,
      callQuality: null,
    });

    try {
      const circuit = await relayClientRef.current.allocateCircuit({
        callerAddress: senderId,
        signMessage: signForRelay,
        regionHint: undefined,
      });

      const webrtc = webrtcRef.current;
      await webrtc.createConnection({
        turnCredentials: circuit.relayA,
      });

      await webrtc.getLocalMedia({
        audio: true,
        video: params.mediaType === 'video',
      });

      webrtc.onCallQualityChange = (quality) => {
        setActiveCall(prev => prev ? { ...prev, callQuality: quality } : null);
      };

      webrtc.onConnectionStateChange = (state) => {
        log.debug(`connectionState: ${state}`);
        if (state === 'connected') {
          webrtc.startQualityMonitor();
          // Start circuit rotation for privacy hardening
          // Circuit rotation disabled: the current implementation
          // releases the old TURN relay before the remote peer has
          // processed the renegotiation offer, creating a window where
          // neither side has a working media path → ICE fails → call
          // drops. Proper fix requires a two-phase handoff (keep old
          // circuit alive until the new one is confirmed). Tracked
          // separately. Calls still work through a single relay
          // circuit for the full duration — the privacy degradation
          // (relay sees a longer-lived connection) is real but
          // secondary to calls actually completing.
          // startCircuitRotation();
          // Report to native call UI that the outgoing call connected.
          // Read callId from activeCall state since const callId isn't
          // available in this closure's scope yet.
          if (nativeCallActiveRef.current) {
            setActiveCall(prev => {
              if (prev?.callId) {
                nativeReportOutgoingCallConnected(prev.callId).catch(() => {});
              }
              return prev ? { ...prev, state: 'connected', startTime: Date.now() } : null;
            });
          } else {
            setActiveCall(prev => prev ? {
              ...prev,
              state: 'connected',
              startTime: Date.now(),
            } : null);
          }
          // Promote to Android foreground service so backgrounding
          // doesn't kill the WebRTC pipeline. iOS handles this via
          // CallKit + UIBackgroundModes — the call below is a no-op
          // there. Reads state after the setActiveCall to get the
          // recipient display name.
          setActiveCall(prev => {
            if (prev) {
              QuorumCrypto.startCallService(
                prev.callId,
                prev.recipientDisplayName || prev.recipientAddress.slice(0, 12),
                prev.mediaType === 'video',
              ).catch((e) => log.debug('startCallService failed:', e));
            }
            return prev;
          });
        } else if (state === 'disconnected' || state === 'failed') {
          webrtc.stopQualityMonitor();
          stopCircuitRotation();
          endCallRef.current?.(state === 'failed' ? 'Connection failed' : 'Disconnected');
        }
      };

      webrtc.onIceConnectionStateChange = (state) => {
        log.debug(`iceConnectionState: ${state}`);
      };

      const offer = await webrtc.createOffer({ video: params.mediaType === 'video' });
      webrtc.startIceTimeout(15000);

      const { message: offerMsg, callId } = createCallOffer({
        senderId,
        recipientAddress: params.recipientAddress,
        sdp: offer.sdp,
        mediaType: params.mediaType,
        relayCredentials: circuit.relayB,
        circuitId: circuit.circuitId,
      });

      // Set ICE candidate handler AFTER callId is known so candidates
      // carry the correct callId (must match the offer's callId for the
      // callee to accept them).
      webrtc.onIceCandidate = (candidate) => {
        if (!candidate) return;
        log.debug(`iceCandidate: ${candidate.candidate?.slice(0, 60)}`);
        const icMsg = createCallIceCandidate({
          senderId,
          recipientAddress: params.recipientAddress,
          callId,
          candidate: JSON.stringify(candidate),
        });
        sendSignal(params.conversationId, params.recipientAddress, icMsg);
      };

      setActiveCall(prev => prev ? {
        ...prev,
        callId,
        circuitId: circuit.circuitId,
        state: 'ringing',
      } : null);

      // Report outgoing call to native call UI (CallKit on iOS)
      nativeReportOutgoingCall(
        callId,
        params.recipientDisplayName,
        params.mediaType === 'video',
      ).then(() => {
        nativeCallActiveRef.current = true;
        log.debug('native outgoing call reported');
      }).catch((err) => {
        log.debug('native outgoing call report failed (overlay fallback):', err);
        nativeCallActiveRef.current = false;
      });

      await sendSignal(params.conversationId, params.recipientAddress, offerMsg);

      ringTimeoutRef.current = setTimeout(async () => {
        setActiveCall(prev => {
          if (prev && prev.state === 'ringing') {
            webrtcRef.current.cleanup();
            relayClientRef.current.releaseCircuit(circuit.circuitId);
            // End the native call UI too
            if (nativeCallActiveRef.current) {
              nativeReportCallEnded(callId).catch(() => {});
              nativeCallActiveRef.current = false;
            }
            return { ...prev, state: 'ended', endReason: 'No answer' };
          }
          return prev;
        });
      }, RING_TIMEOUT_MS);

    } catch (error) {
      log.debug('initiateCall error:', error);
      setActiveCall(prev => prev ? {
        ...prev,
        state: 'ended',
        endReason: error instanceof Error ? error.message : 'Failed to start call',
      } : null);
      await webrtcRef.current.cleanup();
    }
  }, [user, activeCall, sendSignal, startCircuitRotation, stopCircuitRotation, cancelPadding]);

  const acceptCall = useCallback(async (callId: string) => {
    if (!user || !incomingCall || incomingCall.callId !== callId) return;

    // If a previous call is still in post-hangup padding, cancel it first
    if (isPaddingRef.current) {
      await cancelPadding();
    }

    const info = incomingCall;
    setIncomingCall(null);
    clearRingTimeout();

    setActiveCall({
      callId: info.callId,
      conversationId: info.conversationId,
      recipientAddress: info.callerAddress,
      recipientDisplayName: info.callerDisplayName,
      recipientAvatar: info.callerAvatar,
      direction: 'incoming',
      mediaType: info.mediaType,
      state: 'connecting',
      startTime: null,
      isMuted: false,
      isSpeakerOn: false,
      isVideoEnabled: info.mediaType === 'video',
      circuitId: info.circuitId,
      endReason: null,
      callQuality: null,
    });

    try {
      const webrtc = webrtcRef.current;

      await webrtc.createConnection({
        turnCredentials: info.relayCredentials,
      });

      await webrtc.getLocalMedia({
        audio: true,
        video: info.mediaType === 'video',
      });

      webrtc.onCallQualityChange = (quality) => {
        setActiveCall(prev => prev ? { ...prev, callQuality: quality } : null);
      };

      webrtc.onConnectionStateChange = (state) => {
        log.debug(`B connectionState: ${state}`);
        if (state === 'connected') {
          webrtc.startQualityMonitor();
          // Start circuit rotation for privacy hardening
          // Circuit rotation disabled: the current implementation
          // releases the old TURN relay before the remote peer has
          // processed the renegotiation offer, creating a window where
          // neither side has a working media path → ICE fails → call
          // drops. Proper fix requires a two-phase handoff (keep old
          // circuit alive until the new one is confirmed). Tracked
          // separately. Calls still work through a single relay
          // circuit for the full duration — the privacy degradation
          // (relay sees a longer-lived connection) is real but
          // secondary to calls actually completing.
          // startCircuitRotation();
          // Report connected to native call UI
          if (nativeCallActiveRef.current) {
            nativeReportCallConnected(info.callId).catch(() => {});
          }
          setActiveCall(prev => prev ? {
            ...prev,
            state: 'connected',
            startTime: Date.now(),
          } : null);
          // Promote to Android foreground service so the call survives
          // backgrounding. No-op on iOS (CallKit + UIBackgroundModes
          // handle it). Mirror of the outgoing-call path above.
          QuorumCrypto.startCallService(
            info.callId,
            info.callerDisplayName || info.callerAddress.slice(0, 12),
            info.mediaType === 'video',
          ).catch((e) => log.debug('startCallService failed:', e));
        } else if (state === 'disconnected' || state === 'failed') {
          webrtc.stopQualityMonitor();
          stopCircuitRotation();
          endCallRef.current?.(state === 'failed' ? 'Connection failed' : 'Disconnected');
        }
      };

      webrtc.onIceConnectionStateChange = (state) => {
        log.debug(`B iceConnectionState: ${state}`);
      };

      webrtc.onIceCandidate = (candidate) => {
        if (!candidate) return;
        log.debug(`B iceCandidate: ${candidate.candidate?.slice(0, 60)}`);
        const icMsg = createCallIceCandidate({
          senderId: user.address,
          recipientAddress: info.callerAddress,
          callId: info.callId,
          candidate: JSON.stringify(candidate),
        });
        sendSignal(info.conversationId, info.callerAddress, icMsg);
      };

      log.debug(`B setting remote offer, sdp length: ${info.sdp?.length}`);
      await webrtc.setRemoteOffer({
        type: 'offer',
        sdp: info.sdp,
      } as any);

      log.debug('B creating answer...');
      const answer = await webrtc.createAnswer();
      webrtc.startIceTimeout(15000);
      log.debug(`B answer created, sdp length: ${answer.sdp?.length}`);

      const answerMsg = createCallAnswer({
        senderId: user.address,
        recipientAddress: info.callerAddress,
        callId: info.callId,
        sdp: answer.sdp,
      });

      await sendSignal(info.conversationId, info.callerAddress, answerMsg);

      // Apply any ICE candidates that arrived before we accepted
      const buffered = pendingCandidatesRef.current.get(info.callId) || [];
      if (buffered.length > 0) {
        log.debug(`applying ${buffered.length} buffered ICE candidate(s)`);
        for (const candidate of buffered) {
          try {
            await webrtc.addIceCandidate(candidate);
          } catch {
            // ICE candidates can become stale — safe to skip individual failures
          }
        }
        pendingCandidatesRef.current.delete(info.callId);
      }

    } catch (error) {
      log.debug('acceptCall error:', error);
      setActiveCall(prev => prev ? {
        ...prev,
        state: 'ended',
        endReason: error instanceof Error ? error.message : 'Failed to answer',
      } : null);
      await webrtcRef.current.cleanup();
    }
  }, [user, incomingCall, clearRingTimeout, sendSignal, startCircuitRotation, stopCircuitRotation, cancelPadding]);

  // Silent reject: dismiss locally without sending a reject signal, which
  // would leak presence metadata to the caller.
  const rejectCall = useCallback(async (callId: string) => {
    if (!incomingCall || incomingCall.callId !== callId) return;
    setIncomingCall(null);
    clearRingTimeout();
    if (nativeCallActiveRef.current) {
      nativeReportCallEnded(callId).catch(() => {});
      nativeCallActiveRef.current = false;
    }
  }, [incomingCall, clearRingTimeout]);

  const endCallRef = useRef<((reason: string) => Promise<void>) | null>(null);
  endCallRef.current = async (reason: string) => {
    if (!user || !activeCall) return;

    clearRingTimeout();
    stopCircuitRotation();

    // Send hangup signal to the other side immediately
    const hangupMsg = createCallHangup({
      senderId: user.address,
      recipientAddress: activeCall.recipientAddress,
      callId: activeCall.callId,
    });
    sendSignal(activeCall.conversationId, activeCall.recipientAddress, hangupMsg);

    // Determine call event type based on what happened
    const duration = activeCall.startTime
      ? Math.floor((Date.now() - activeCall.startTime) / 1000)
      : undefined;

    let event: 'completed' | 'missed' | 'declined' | 'failed';
    if (duration) {
      event = 'completed';
    } else if (activeCall.direction === 'outgoing') {
      event = 'failed';
    } else {
      event = 'missed';
    }

    const eventMsg = createCallEvent({
      senderId: user.address,
      recipientAddress: activeCall.recipientAddress,
      callId: activeCall.callId,
      mediaType: activeCall.mediaType,
      event,
      duration,
    });
    sendSignal(activeCall.conversationId, activeCall.recipientAddress, eventMsg);

    // Report ended to native call UI
    if (nativeCallActiveRef.current) {
      nativeReportCallEnded(activeCall.callId).catch(() => {});
      nativeCallActiveRef.current = false;
    }

    QuorumCrypto.stopCallService().catch(() => { /* noop */ });

    // Post-hangup padding: keep the circuit alive sending CBR silence until
    // the next rotation boundary so relay nodes can't correlate teardown
    // with call end. Only when media was actually flowing.
    const wasConnected = activeCall.state === 'connected';
    const circuitId = activeCall.circuitId;

    if (wasConnected && circuitId) {
      // Mute everything but keep the encoder producing CBR silence frames
      webrtcRef.current.muteForPadding();
      isPaddingRef.current = true;

      const teardownAt = nextRotationTime();
      const delay = Math.max(teardownAt - Date.now(), 0);
      log.debug(`post-hangup padding: holding circuit for ${Math.round(delay / 1000)}s until next boundary`);

      paddingTimeoutRef.current = setTimeout(async () => {
        log.debug('padding complete, releasing circuit');
        isPaddingRef.current = false;
        paddingTimeoutRef.current = null;
        await webrtcRef.current.cleanup();
        relayClientRef.current.releaseCircuit(circuitId);
      }, delay);
    } else {
      // Not connected (ringing, offering, etc.) — clean up immediately
      if (circuitId) {
        relayClientRef.current.releaseCircuit(circuitId);
      }
      await webrtcRef.current.cleanup();
    }

    // UI shows call as ended immediately regardless of padding
    setActiveCall(prev => prev ? { ...prev, state: 'ended', endReason: reason } : null);
  };

  const hangup = useCallback(async () => {
    await endCallRef.current?.('Hung up');
  }, []);

  const toggleMute = useCallback(() => {
    setActiveCall(prev => {
      if (!prev) return null;
      const newMuted = !prev.isMuted;
      webrtcRef.current.setAudioEnabled(!newMuted);
      return { ...prev, isMuted: newMuted };
    });
  }, []);

  const toggleSpeaker = useCallback(() => {
    setActiveCall(prev => {
      if (!prev) return null;
      const next = !prev.isSpeakerOn;
      QuorumCrypto.setSpeakerphoneEnabled(next).catch(() => {});
      return { ...prev, isSpeakerOn: next };
    });
  }, []);

  const toggleVideo = useCallback(() => {
    setActiveCall(prev => {
      if (!prev) return null;
      const newEnabled = !prev.isVideoEnabled;
      webrtcRef.current.setVideoEnabled(newEnabled);
      return { ...prev, isVideoEnabled: newEnabled };
    });
  }, []);

  const flipCamera = useCallback(() => {
    webrtcRef.current.flipCamera();
  }, []);

  // Handle incoming call signaling messages from WebSocket
  const handleCallSignal = useCallback((message: Message) => {
    if (!user) return;

    const content = message.content as any;
    const contentType = content.type as string;

    // Drop stale call signals — if the message is older than 60 seconds,
    // it's from a previous session and should be ignored.
    if (message.createdDate && Date.now() - message.createdDate > 60000) {
      return;
    }

    switch (contentType) {
      case 'call-offer': {
        // Reject stale call-offers: the TURN credential username contains
        // the expiry timestamp (format: "<expiry>:<random>"). If expired,
        // the TURN allocation will fail — silently drop the offer.
        const credUsername = content.relayCredentials?.username || '';
        const expiryStr = credUsername.split(':')[0];
        const expiry = parseInt(expiryStr, 10);
        if (expiry && Date.now() / 1000 > expiry) {
          log.debug(`dropping expired call-offer (expired ${Math.round(Date.now() / 1000 - expiry)}s ago)`);
          return;
        }

        if (activeCall) {
          return;
        }

        // Screen unknown callers: allow if we have an existing conversation
        // OR if they have a verified Farcaster link and we're mutual follows.
        // Prevents unsolicited call spam. No reject signal sent (no presence leak).
        if (isCallScreeningEnabled() && !hasConversationWith(content.senderId)) {
          // TODO: async Farcaster mutual follow check — fetch caller's public
          // profile, verify their FarcasterLink signatures, check mutual follow
          // status via Farcaster API. For now, only conversation-based screening.
          log.debug(`screening: dropped call from unknown ${content.senderId.slice(0, 12)}`);
          return;
        }

        const incomingInfo: IncomingCallInfo = {
          callId: content.callId,
          conversationId: message.spaceId,
          callerAddress: content.senderId,
          callerDisplayName: content.senderId.slice(0, 12),
          callerAvatar: '',
          mediaType: content.mediaType || 'audio',
          sdp: content.sdp,
          relayCredentials: {
            username: content.relayCredentials.username,
            password: content.relayCredentials.password,
            turnUrls: content.relayCredentials.turnUrls || content.relayCredentials.turn_urls,
            ttl: content.relayCredentials.ttl,
            nodeId: '',
          },
          circuitId: content.circuitId,
          receivedAt: Date.now(),
        };

        setIncomingCall(incomingInfo);

        // Report to native call UI (CallKit on iOS, notification on Android).
        // This is a 1-to-1 DM call so we use native integration.
        // If native reporting fails, the React Native overlay still works.
        nativeReportIncomingCall(
          content.callId,
          incomingInfo.callerDisplayName,
          (content.mediaType || 'audio') === 'video',
        ).then(() => {
          nativeCallActiveRef.current = true;
          log.debug('native incoming call reported');
        }).catch((err) => {
          log.debug('native incoming call report failed (overlay fallback):', err);
          nativeCallActiveRef.current = false;
        });

        ringTimeoutRef.current = setTimeout(() => {
          setIncomingCall(prev => {
            if (prev && prev.callId === content.callId) {
              // Also end the native call UI if it was active
              if (nativeCallActiveRef.current) {
                nativeReportCallEnded(content.callId).catch(() => {});
                nativeCallActiveRef.current = false;
              }
              return null;
            }
            return prev;
          });
        }, RING_TIMEOUT_MS);
        break;
      }

      case 'call-answer': {
        if (!activeCall || activeCall.callId !== content.callId) return;
        clearRingTimeout();

        setActiveCall(prev => prev ? { ...prev, state: 'connecting' } : null);

        webrtcRef.current.setRemoteAnswer({
          type: 'answer',
          sdp: content.sdp,
        } as any).catch(err => {
          log.debug('setRemoteAnswer error:', err);
        });
        break;
      }

      case 'call-reject': {
        if (activeCall && activeCall.callId === content.callId) {
          endCallRef.current?.(content.reason === 'busy' ? 'Busy' : 'Declined');
        }
        if (incomingCall && incomingCall.callId === content.callId) {
          clearRingTimeout();
          setIncomingCall(null);
        }
        break;
      }

      case 'call-hangup': {
        if (activeCall && activeCall.callId === content.callId) {
          endCallRef.current?.('Call ended');
        }
        if (incomingCall && incomingCall.callId === content.callId) {
          clearRingTimeout();
          // Dismiss native call UI if the remote side hung up while ringing
          if (nativeCallActiveRef.current) {
            nativeReportCallEnded(content.callId).catch(() => {});
            nativeCallActiveRef.current = false;
          }
          setIncomingCall(null);
        }
        break;
      }

      case 'call-ice-candidate': {
        const candidateCallId = content.callId;
        if (activeCall && activeCall.callId === candidateCallId) {
          try {
            const candidate = JSON.parse(content.candidate);
            log.debug(`adding ICE candidate for active call`);
            webrtcRef.current.addIceCandidate(candidate);
          } catch {
            // Malformed candidate JSON or stale ICE candidate — skip
          }
        } else if (incomingCall && incomingCall.callId === candidateCallId) {
          // Buffer candidates that arrive before the call is accepted.
          // They'll be applied in acceptCall after the PeerConnection is ready.
          const buf = pendingCandidatesRef.current.get(candidateCallId) || [];
          buf.push(JSON.parse(content.candidate));
          pendingCandidatesRef.current.set(candidateCallId, buf);
          log.debug(`buffered ICE candidate (${buf.length}) for pending call`);
        }
        break;
      }

      case 'call-renegotiate': {
        if (!activeCall || activeCall.callId !== content.callId) return;

        log.debug('received circuit rotation renegotiate');
        (async () => {
          try {
            const newCreds = {
              username: content.relayCredentials.username,
              password: content.relayCredentials.password,
              turnUrls: content.relayCredentials.turnUrls || content.relayCredentials.turn_urls,
              ttl: content.relayCredentials.ttl,
              nodeId: '',
            };

            webrtcRef.current.updateIceServers(newCreds);
            await webrtcRef.current.setRemoteOffer({
              type: 'offer',
              sdp: content.sdp,
            } as any);

            const answer = await webrtcRef.current.createAnswer();
            const answerMsg = createCallAnswer({
              senderId: user.address,
              recipientAddress: activeCall.recipientAddress,
              callId: activeCall.callId,
              sdp: answer.sdp,
            });
            await sendSignal(activeCall.conversationId, activeCall.recipientAddress, answerMsg);

            log.debug('circuit rotation renegotiate answer sent');
        } catch (error) {
          // Renegotiation failed — the existing connection may still work.
          // Don't end the call; the initiator will retry on next tick.
          log.debug('circuit rotation renegotiate failed:', error);
          }
        })();
        break;
      }
    }
  }, [user, activeCall, incomingCall, clearRingTimeout, sendSignal]);

  // Auto-clear ended calls after a brief delay
  useEffect(() => {
    if (activeCall?.state === 'ended') {
      const timer = setTimeout(() => setActiveCall(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [activeCall?.state]);

  // Register the call signaling handler with WebSocket context
  const { registerCallSignalingHandler } = useWebSocket() as any;
  useEffect(() => {
    if (registerCallSignalingHandler) {
      return registerCallSignalingHandler(handleCallSignal);
    }
  }, [registerCallSignalingHandler, handleCallSignal]);

  // Subscribe to native call actions (CallKit answer/decline, Android notification actions).
  // Uses refs for acceptCall/rejectCall/hangup to avoid re-subscribing on every render.
  const acceptCallRef = useRef(acceptCall);
  acceptCallRef.current = acceptCall;
  const rejectCallRef = useRef(rejectCall);
  rejectCallRef.current = rejectCall;
  const hangupRef = useRef(hangup);
  hangupRef.current = hangup;
  const incomingCallRef = useRef(incomingCall);
  incomingCallRef.current = incomingCall;

  useEffect(() => {
    if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

    const subscription = onNativeCallAction((action) => {
      log.debug(`native action: ${action.type} callId=${action.callId}`);
      switch (action.type) {
        case 'answerCall': {
          // Find the matching incoming call — CallKit uses UUIDs, so we
          // need to match by checking the current incomingCall state.
          const currentIncoming = incomingCallRef.current;
          if (currentIncoming) {
            acceptCallRef.current(currentIncoming.callId);
          }
          break;
        }
        case 'endCall': {
          // Could be declining an incoming call or ending an active call
          const currentIncoming = incomingCallRef.current;
          if (currentIncoming) {
            rejectCallRef.current(currentIncoming.callId);
          } else {
            hangupRef.current();
          }
          break;
        }
        case 'setMuted': {
          if ('muted' in action) {
            // Sync mute state from native UI
            setActiveCall(prev => {
              if (!prev) return null;
              webrtcRef.current.setAudioEnabled(!action.muted);
              return { ...prev, isMuted: action.muted };
            });
          }
          break;
        }
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  // Stable accessors that return the current stream from the underlying
  // WebRTCManager. The streams change identity over the call's lifetime
  // (initial getUserMedia, ICE-restart re-attach, etc.), so we hand back
  // the live ref each call rather than caching.
  const getLocalStream = useCallback(() => webrtcRef.current.getLocalStream(), []);
  const getRemoteStream = useCallback(() => webrtcRef.current.getRemoteStream(), []);

  const value = useMemo<CallContextValue>(() => ({
    activeCall,
    incomingCall,
    initiateCall,
    acceptCall,
    rejectCall,
    hangup,
    toggleMute,
    toggleSpeaker,
    toggleVideo,
    flipCamera,
    getLocalStream,
    getRemoteStream,
  }), [activeCall, incomingCall, initiateCall, acceptCall, rejectCall, hangup, toggleMute, toggleSpeaker, toggleVideo, flipCamera, getLocalStream, getRemoteStream]);

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) {
    throw new Error('useCall must be used within a CallProvider');
  }
  return context;
}
