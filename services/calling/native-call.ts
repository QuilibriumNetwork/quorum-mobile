/**
 * Native call integration bridge.
 *
 * On iOS, uses CallKit to display the native incoming-call UI (works on
 * lock screen, integrates with Do Not Disturb, manages audio routes).
 *
 * On Android, uses ConnectionService to show an incoming-call notification
 * in the system notification shade.
 *
 * Falls back gracefully — callers should catch errors and use the React
 * Native CallOverlay as a fallback.
 */

import { Platform } from 'react-native';
// EventSubscription, not Subscription — renamed in expo-modules-core 3.x.
import { type EventSubscription } from 'expo-modules-core';
import * as Device from 'expo-device';
import QuorumCrypto from '../../modules/quorum-crypto/src/QuorumCryptoModule';

// CallKit on iOS simulator auto-ends calls immediately after reporting them.
// Skip native integration on simulator — use the React Native overlay instead.
const useNativeCallUI = Device.isDevice;

export type NativeCallAction =
  | { type: 'answerCall'; callId: string }
  | { type: 'endCall'; callId: string }
  | { type: 'setMuted'; callId: string; muted: boolean }
  | { type: 'setHeld'; callId: string; held: boolean };

/**
 * Report an incoming call to the native call UI (CallKit / ConnectionService).
 *
 * Resolves once the native UI is displayed. Rejects if the native layer
 * is unavailable or the call was suppressed by Do Not Disturb.
 */
export async function reportIncomingCall(
  callId: string,
  callerName: string,
  hasVideo: boolean,
): Promise<void> {
  if (!useNativeCallUI) return;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    await QuorumCrypto.reportIncomingCall(callId, callerName, hasVideo);
  }
}

/**
 * Report that an outgoing call has started (so the system shows it in
 * the native call list / notification).
 */
export async function reportOutgoingCall(
  callId: string,
  calleeName: string,
  hasVideo: boolean,
): Promise<void> {
  if (!useNativeCallUI) return;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    await QuorumCrypto.reportOutgoingCall(callId, calleeName, hasVideo);
  }
}

/**
 * Report that an outgoing call connected (ring → connected).
 */
export async function reportOutgoingCallConnected(
  callId: string,
): Promise<void> {
  if (!useNativeCallUI) return;
  if (Platform.OS === 'ios') {
    await QuorumCrypto.reportOutgoingCallConnected(callId);
  }
}

/**
 * Report that a call (incoming or outgoing) has connected.
 */
export async function reportCallConnected(callId: string): Promise<void> {
  if (!useNativeCallUI) return;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    await QuorumCrypto.reportCallConnected(callId);
  }
}

/**
 * Report that a call has ended (from our side).
 */
export async function reportCallEnded(callId: string): Promise<void> {
  if (!useNativeCallUI) return;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    await QuorumCrypto.reportCallEnded(callId);
  }
}

/**
 * Subscribe to native call actions (user answered/declined from the
 * native UI). Returns an unsubscribe function.
 */
export function onNativeCallAction(
  handler: (action: NativeCallAction) => void,
): EventSubscription {
  // Listen on the module itself. Since Expo SDK 52 a NativeModule already IS an
  // EventEmitter, so the `new EventEmitter(QuorumCrypto)` wrapper this used to
  // build is the constructor overload expo marks @deprecated for exactly that
  // reason — same listener registry either way. Dropping it also lets the
  // events map on QuorumCryptoModule type the callback, which is what removed
  // the four casts that used to be on every field below.
  return QuorumCrypto.addListener('onCallAction', (event) => {
    const { callId } = event;

    switch (event.action) {
      case 'answer':
        handler({ type: 'answerCall', callId });
        break;
      case 'end':
        handler({ type: 'endCall', callId });
        break;
      case 'setMuted':
        handler({ type: 'setMuted', callId, muted: event.muted ?? false });
        break;
      case 'setHeld':
        handler({ type: 'setHeld', callId, held: event.held ?? false });
        break;
    }
  });
}

/**
 * Check if native call integration is available on this device.
 */
export function isNativeCallAvailable(): boolean {
  if (!useNativeCallUI) return false;
  return typeof QuorumCrypto.reportIncomingCall === 'function';
}
