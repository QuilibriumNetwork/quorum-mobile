import { NativeModule, requireNativeModule, type EventSubscription } from 'expo-modules-core';

/**
 * Keypair result from key generation
 */
export interface KeyPair {
  public_key: number[];
  private_key: number[];
}

/**
 * Message ciphertext from encryption
 */
export interface MessageCiphertext {
  ciphertext: string;
  initialization_vector: string;
  associated_data?: string;
}

/**
 * Payload of the `onCallAction` event, emitted when the user acts on the native
 * call UI (CallKit on iOS, the call notification on Android).
 *
 * Mirrors what the native side actually sends: `ios/QuorumCryptoModule.swift`
 * (the four CXProvider delegate methods) and Android's `handleCallAction`.
 * `muted` accompanies only `setMuted` and `held` only `setHeld`, which is why
 * both are optional.
 */
export type CallActionEvent = {
  action: 'answer' | 'end' | 'setMuted' | 'setHeld';
  callId: string;
  muted?: boolean;
  held?: boolean;
};

/** Events this module emits. Declared so addListener can type its callback. */
export type QuorumCryptoEvents = {
  onCallAction: (event: CallActionEvent) => void;
};

/**
 * QuorumCrypto native module interface
 *
 * Provides cryptographic operations using the channel Rust crate
 * via uniffi-generated Swift/Kotlin bindings.
 *
 * ⚠️ `addListener` is declared here by hand rather than inherited, and passing
 * an events map to `NativeModule<...>` does not work. In expo-modules-core
 * 3.0.29 the exported type is
 *
 *     type NativeModule<TEventsMap> = typeof ExpoGlobal.NativeModule<EventsMap>
 *
 * — the *constructor* type, with TEventsMap declared and then discarded. So
 * `extends NativeModule<X>` inherits no instance members (hence "Property
 * 'addListener' does not exist") and silently ignores X. Declaring the one
 * method this module actually exposes is self-contained and survives whatever
 * upstream does with that type next.
 */
interface QuorumCryptoModule extends NativeModule {
  /** Subscribe to a module event. Currently only `onCallAction` is emitted. */
  addListener<EventName extends keyof QuorumCryptoEvents>(
    eventName: EventName,
    listener: QuorumCryptoEvents[EventName]
  ): EventSubscription;

  // Native call integration (CallKit on iOS, notification on Android)
  reportIncomingCall(callId: string, callerName: string, hasVideo: boolean): Promise<boolean>;
  reportOutgoingCall(callId: string, calleeName: string, hasVideo: boolean): Promise<boolean>;
  reportOutgoingCallConnected(callId: string): Promise<boolean>;
  reportCallConnected(callId: string): Promise<boolean>;
  reportCallEnded(callId: string): Promise<boolean>;

  // Audio session (iOS)
  prepareAudioSession(): Promise<boolean>;
  releaseAudioSession(): Promise<boolean>;
  /**
   * Toggle loudspeaker output during an active call. Resolves to false
   * if the platform's audio session couldn't be reconfigured (rare —
   * usually means there's no active call, in which case the call UI
   * shouldn't be invoking this anyway).
   *
   * iOS: AVAudioSession.overrideOutputAudioPort(.speaker | .none).
   * Android: AudioManager.setSpeakerphoneOn() while pinning the audio
   * mode to MODE_IN_COMMUNICATION.
   */
  setSpeakerphoneEnabled(enabled: boolean): Promise<boolean>;
  /**
   * Start the platform-specific foreground call lifecycle so a
   * backgrounded app keeps the WebRTC pipeline alive for the duration
   * of the call.
   *
   * Android: starts QuorumCallService as a foreground service with a
   * persistent notification ("In a Quorum call · <displayName>"),
   * declared with foregroundServiceType="microphone". Without this,
   * Android suspends the app within seconds of backgrounding and the
   * call dies.
   *
   * iOS: no-op. The OS handles backgrounded calls automatically via
   * the `audio` and `voip` UIBackgroundModes plus the active
   * AVAudioSession that prepareAudioSession sets up. Method exists so
   * JS can call it unconditionally without Platform checks.
   *
   * Idempotent — calling multiple times for the same call is safe.
   */
  startCallService(callId: string, displayName: string, hasVideo: boolean): Promise<boolean>;
  /**
   * Stop the foreground call service (Android) / no-op (iOS).
   * Idempotent — safe to call when no service is running.
   */
  stopCallService(): Promise<boolean>;

  // Key Generation
  generateX448(): Promise<string>;
  generateEd448(): Promise<string>;
  getPublicKeyX448(privateKey: string): Promise<string>;
  getPublicKeyEd448(privateKey: string): Promise<string>;

  // Signing
  signEd448(privateKey: string, message: string): Promise<string>;
  verifyEd448(publicKey: string, message: string, signature: string): Promise<string>;

  // Inbox Message Encryption (Sealed Sender)
  encryptInboxMessage(input: string): Promise<string>;
  decryptInboxMessage(input: string): Promise<string>;

  // X3DH Key Agreement
  senderX3dh(input: string): Promise<string>;
  receiverX3dh(input: string): Promise<string>;

  // Double Ratchet
  newDoubleRatchet(input: string): Promise<string>;
  doubleRatchetEncrypt(input: string): Promise<string>;
  doubleRatchetDecrypt(input: string): Promise<string>;

  // Triple Ratchet
  newTripleRatchet(input: string): Promise<string>;
  tripleRatchetInitRound1(input: string): Promise<string>;
  tripleRatchetInitRound2(input: string): Promise<string>;
  tripleRatchetInitRound3(input: string): Promise<string>;
  tripleRatchetInitRound4(input: string): Promise<string>;
  tripleRatchetEncrypt(input: string): Promise<string>;
  tripleRatchetDecrypt(input: string): Promise<string>;

  /**
   * Resize the triple ratchet to generate invite evals
   * Input: JSON string with { ratchet_state: string, other: string (hex), id: number, total: number }
   * Output: JSON string of number[][] (array of eval byte arrays)
   */
  tripleRatchetResize(input: string): Promise<string>;

  /**
   * Batch unseal multiple encrypted envelopes in a single native call.
   * Eliminates N JS-native bridge crossings for N messages.
   *
   * Input: JSON string with:
   *   hub_private_key: number[] (Ed448 private key bytes)
   *   config_private_key?: number[] (X448 config key bytes, preferred over hub-derived)
   *   messages: Array<{ ephemeral_public_key: string (hex), envelope: string (JSON ciphertext) }>
   *
   * Output: JSON string with:
   *   results: Array<{ plaintext: string } | { error: string }>
   */
  batchUnsealEnvelopes(input: string): Promise<string>;

  /**
   * Process an entire batch of messages in a single native call.
   * Handles unseal + TR/DR decrypt for all messages, eliminating 2N-5N bridge crossings.
   *
   * Input: JSON string (see BatchProcessInput type in native-provider.ts)
   * Output: JSON string (see BatchProcessOutput type in native-provider.ts)
   */
  batchProcessMessages(input: string): Promise<string>;
}

// This call loads the native module object from the JSI
export default requireNativeModule<QuorumCryptoModule>('QuorumCrypto');
