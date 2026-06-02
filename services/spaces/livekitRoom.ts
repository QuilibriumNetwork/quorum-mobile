/**
 * Thin facade over `livekit-client`'s Room for the audio-spaces use
 * case. The web SDK speaks the LiveKit protocol natively; we just need
 * to:
 *   - configure the iOS/Android audio session (silent-switch +
 *     interrupt-other-apps),
 *   - subscribe to remote audio tracks (auto-play),
 *   - surface the events the overlay UI reads (active-speakers,
 *     participant join/leave, reactions delivered via the data
 *     channel),
 *   - expose imperative mic-toggle / reaction-send / disconnect.
 *
 * The polyfill installed in `index.js` (livekitPolyfill.ts) provides the
 * WebRTC globals, so no further bridge work is needed.
 */

import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalVideoTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Participant,
} from 'livekit-client';
import { AudioModule } from 'expo-audio';
import { logger } from '@quilibrium/quorum-shared';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { MediaStream: WebRtcMediaStream } = require('react-native-webrtc') as { MediaStream: any };

/** Custom data-channel payload we send for emoji reactions. The server
 *  echoes these to every listener via LiveKit's data tracks, so we get
 *  reactions without an extra HTTP round-trip. */
export interface ReactionPayload {
  type: 'reaction';
  emoji: string;
  fid?: number;
}

export interface SpaceRoomEvents {
  onActiveSpeakersChange?: (speakerIdentities: string[]) => void;
  onParticipantsChange?: (count: number) => void;
  onReaction?: (payload: ReactionPayload, from: string | undefined) => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
  onDisconnected?: () => void;
  /** Fired when a remote participant publishes a camera video track.
   *  `streamURL` is the URL `react-native-webrtc`'s `RTCView` accepts;
   *  pass it straight through. The overlay keys these by identity so
   *  it can swap an avatar tile for the live video when one arrives. */
  onRemoteVideoAdded?: (identity: string, streamURL: string) => void;
  /** Counterpart to `onRemoteVideoAdded` — fires when the track is
   *  unpublished, muted, or the participant disconnects. */
  onRemoteVideoRemoved?: (identity: string) => void;
  /** Fired whenever our own camera publication starts or stops.
   *  `streamURL` is `null` when video is off; the same URL the overlay
   *  uses for the local-preview tile. */
  onLocalVideoChanged?: (streamURL: string | null) => void;
}

/** Request microphone permission at the OS level. Returns true when
 *  granted; the caller uses this to decide whether the mic toggle is
 *  available before we ask LiveKit to publish a local track. */
export async function requestMicrophonePermission(): Promise<boolean> {
  try {
    const res = await AudioModule.requestRecordingPermissionsAsync();
    return Boolean(res.granted);
  } catch {
    return false;
  }
}

export interface ConnectedSpaceRoom {
  room: Room;
  /** True once we successfully publish a mic track. The provider tracks
   *  this so the mic button reflects reality. */
  isMicEnabled: () => boolean;
  setMicEnabled: (enabled: boolean) => Promise<boolean>;
  /** Whether the local camera track is currently published. */
  isCameraEnabled: () => boolean;
  /** Publish or unpublish the local camera. Defaults to the user-
   *  facing (selfie) camera; pass `facingMode: 'environment'` for the
   *  rear lens. On failure (token rejects, OS permission denied,
   *  device unavailable) returns the previous state and a structured
   *  reason so callers can surface why. */
  setCameraEnabled: (
    enabled: boolean,
    opts?: { facingMode?: 'user' | 'environment' },
  ) => Promise<{ enabled: boolean; reason?: string; error?: string }>;
  /** Toggle between front and back camera while video is live.
   *  No-op when the local camera isn't published. Returns the new
   *  facing mode or null if the flip failed. */
  flipCamera: () => Promise<'user' | 'environment' | null>;
  sendReaction: (emoji: string, fid?: number) => Promise<void>;
  disconnect: () => Promise<void>;
}

/**
 * Connect to a LiveKit room and wire the callback set. Returns once the
 * connection succeeds or throws on failure — callers should wrap in
 * try/catch and surface the error in the overlay.
 */
export async function connectToSpace(
  livekitUrl: string,
  token: string,
  callbacks: SpaceRoomEvents = {},
): Promise<ConnectedSpaceRoom> {
  // Deliberately NOT calling `setAudioModeAsync` here. `react-native-webrtc`
  // owns the AVAudioSession for the duration of the PeerConnection; setting
  // a category from expo-audio first leaves CoreAudio in a half-configured
  // state, and the second SDP renegotiation tears down audio objects that
  // CoreAudio later tries to query, producing the
  // `HALSystem AudioObjectPropertiesChanged: no such object` warnings and
  // a native crash that takes the JS thread down with no error in Metro.
  // The trade-off: with the iOS silent switch on, playback is muted. For a
  // listener-oriented flow that's acceptable; we can revisit if a use case
  // surfaces that actually needs the override.

  const room = new Room({
    // Auto-subscribe to all tracks — spaces are audio-only and we
    // always want to hear everyone. Disabling this and selecting
    // tracks manually would just add latency.
    adaptiveStream: false,
    dynacast: false,
  });

  // ---- Event wiring -------------------------------------------------
  //
  // All handlers are wrapped in a guard so an uncaught throw inside one
  // doesn't take down the whole JS thread (or leave the audio engine in
  // a half-attached state). Errors surface as a single console warn
  // with the event name so we can find them in Metro instead of going
  // dark mid-handler.
  const safe = <Args extends unknown[]>(name: string, fn: (...a: Args) => void) =>
    (...args: Args): void => {
      try { fn(...args); }
      catch (e) {
        logger.warn(
          `[livekitRoom] handler ${name} threw:`,
          e instanceof Error ? e.message : String(e),
          e instanceof Error ? e.stack : undefined,
        );
      }
    };

  room.on(RoomEvent.ActiveSpeakersChanged, safe('ActiveSpeakersChanged', (speakers) => {
    callbacks.onActiveSpeakersChange?.(speakers.map((s) => s.identity));
  }));

  const emitCount = safe('emitCount', () => {
    // +1 for the local participant (LiveKit's `remoteParticipants` map
    // doesn't include us).
    callbacks.onParticipantsChange?.(room.remoteParticipants.size + 1);
  });
  room.on(RoomEvent.ParticipantConnected, emitCount);
  room.on(RoomEvent.ParticipantDisconnected, emitCount);

  room.on(RoomEvent.DataReceived, safe('DataReceived', (payload, participant) => {
    // Don't gate on DataPacket_Kind: in livekit-client v2 the `kind` argument
    // is frequently undefined, and since RELIABLE === 0 a `kind !== RELIABLE`
    // guard would drop every received packet (which is why remote reactions
    // never showed). The `type === 'reaction'` check below is enough.
    try {
      const text = new TextDecoder().decode(payload);
      const obj = JSON.parse(text);
      if (obj?.type === 'reaction' && typeof obj.emoji === 'string') {
        callbacks.onReaction?.(obj as ReactionPayload, participant?.identity);
      }
    } catch {
      // Non-JSON / non-reaction payloads are not for us — ignore.
    }
  }));

  room.on(RoomEvent.ConnectionStateChanged, safe('ConnectionStateChanged', (state) => {
    callbacks.onConnectionStateChange?.(state);
  }));

  room.on(RoomEvent.Disconnected, safe('Disconnected', () => {
    callbacks.onDisconnected?.();
  }));

  // Build an RTCView-compatible streamURL from any LiveKit Track. The
  // SDK exposes the underlying WebRTC `MediaStreamTrack` via
  // `track.mediaStreamTrack`; we wrap it in `react-native-webrtc`'s
  // `MediaStream` (NOT the browser's polyfilled one — we need the
  // native module's instance for its `.toURL()` method) and pull the
  // URL.
  const trackToStreamURL = (track: Track): string | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const native = (track as any).mediaStreamTrack;
      if (!native) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = new (WebRtcMediaStream as any)([native]);
      return typeof stream?.toURL === 'function' ? stream.toURL() : null;
    } catch {
      return null;
    }
  };

  // Auto-subscribed remote tracks fire here. Audio is routed natively
  // by `react-native-webrtc`; video we have to render ourselves via
  // RTCView, so we extract the stream URL and surface it to the
  // overlay through the callback.
  room.on(RoomEvent.TrackSubscribed, safe('TrackSubscribed', (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) => {
    void publication;
    if (track.kind !== Track.Kind.Video) return;
    if (track.source !== Track.Source.Camera) return;
    const url = trackToStreamURL(track);
    if (url) {
      callbacks.onRemoteVideoAdded?.(participant.identity, url);
    }
  }));
  room.on(RoomEvent.TrackUnsubscribed, safe('TrackUnsubscribed', (
    track: RemoteTrack,
    _pub,
    participant: RemoteParticipant,
  ) => {
    if (track.kind !== Track.Kind.Video) return;
    if (track.source !== Track.Source.Camera) return;
    callbacks.onRemoteVideoRemoved?.(participant.identity);
  }));
  // Treat a remote-mute as "video off" too — the SDK keeps the
  // subscription alive but the frames stop, and rendering a frozen
  // last frame would be confusing.
  room.on(RoomEvent.TrackMuted, safe('TrackMuted', (publication, participant) => {
    if (publication.kind !== Track.Kind.Video) return;
    if (publication.source !== Track.Source.Camera) return;
    if (participant.isLocal) return; // local mute is handled inline below
    callbacks.onRemoteVideoRemoved?.(participant.identity);
  }));
  room.on(RoomEvent.TrackUnmuted, safe('TrackUnmuted', (publication, participant) => {
    if (publication.kind !== Track.Kind.Video) return;
    if (publication.source !== Track.Source.Camera) return;
    if (participant.isLocal) return;
    const t = publication.track;
    if (!t) return;
    const url = trackToStreamURL(t);
    if (url) callbacks.onRemoteVideoAdded?.(participant.identity, url);
  }));
  // A participant leaving — clear their video so it doesn't linger as
  // a frozen tile.
  room.on(RoomEvent.ParticipantDisconnected, safe('ParticipantDisconnected:video', (p) => {
    callbacks.onRemoteVideoRemoved?.(p.identity);
  }));

  await room.connect(livekitUrl, token);
  // First emit so the overlay paints the initial participant count
  // without waiting for someone to come or go.
  emitCount();

  // ---- Returned facade ---------------------------------------------
  let micEnabled = false;
  let cameraEnabled = false;
  // Tracks the facingMode we last requested so flipCamera knows which
  // way to swap. Defaults to user (selfie) — the more common starting
  // position for a social audio/video room.
  let currentFacingMode: 'user' | 'environment' = 'user';
  // Helper that re-derives the local camera stream URL after a
  // publish/unpublish and notifies the caller via the callback. Keeps
  // the "what's our current local preview" lookup centralised.
  const emitLocalVideoState = () => {
    try {
      if (!cameraEnabled) {
        callbacks.onLocalVideoChanged?.(null);
        return;
      }
      const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
      const t = pub?.track as LocalVideoTrack | undefined;
      if (!t) {
        callbacks.onLocalVideoChanged?.(null);
        return;
      }
      const url = trackToStreamURL(t);
      callbacks.onLocalVideoChanged?.(url);
    } catch {
      callbacks.onLocalVideoChanged?.(null);
    }
  };

  return {
    room,
    isMicEnabled: () => micEnabled,
    setMicEnabled: async (enabled) => {
      try {
        if (enabled) {
          const granted = await requestMicrophonePermission();
          if (!granted) return false;
        }
        await room.localParticipant.setMicrophoneEnabled(enabled);
        micEnabled = enabled;
        return enabled;
      } catch {
        return micEnabled;
      }
    },
    flipCamera: async () => {
      if (!cameraEnabled) return null;
      const next: 'user' | 'environment' =
        currentFacingMode === 'user' ? 'environment' : 'user';
      try {
        const pub = room.localParticipant.getTrackPublication(Track.Source.Camera);
        const track = pub?.track as LocalVideoTrack | undefined;
        // react-native-webrtc exposes `_switchCamera()` on the
        // underlying MediaStreamTrack. It swaps the active camera
        // in-place without renegotiating SDP, which is dramatically
        // cheaper than restarting the track. If that path isn't
        // available (RN-webrtc API drift), fall back to LiveKit's
        // setCameraEnabled cycle which is correct but slower.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nativeTrack = (track as any)?.mediaStreamTrack;
        if (nativeTrack && typeof nativeTrack._switchCamera === 'function') {
          nativeTrack._switchCamera();
          currentFacingMode = next;
          // The MediaStreamTrack id stays the same, so the previously
          // emitted local stream URL is still valid — no need to
          // re-emit.
          return next;
        }
        // Fallback: cycle the camera with the new facingMode.
        await room.localParticipant.setCameraEnabled(false);
        await room.localParticipant.setCameraEnabled(true, { facingMode: next });
        currentFacingMode = next;
        emitLocalVideoState();
        return next;
      } catch (e) {
        logger.warn(
          '[livekitRoom] flipCamera failed:',
          e instanceof Error ? e.message : String(e),
        );
        return null;
      }
    },
    sendReaction: async (emoji, fid) => {
      const payload: ReactionPayload = { type: 'reaction', emoji, fid };
      const data = new TextEncoder().encode(JSON.stringify(payload));
      try {
        await room.localParticipant.publishData(data, { reliable: true });
      } catch {
        // The server-side reaction HTTP call is the source of truth;
        // the data-channel fan-out is just a latency optimization.
      }
    },
    isCameraEnabled: () => cameraEnabled,
    setCameraEnabled: async (enabled, opts) => {
      try {
        const facingMode = opts?.facingMode ?? 'user';
        currentFacingMode = facingMode;
        await room.localParticipant.setCameraEnabled(
          enabled,
          enabled ? { facingMode } : undefined,
        );
        cameraEnabled = enabled;
        emitLocalVideoState();
        return { enabled };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Server-side "insufficient permission" wins over the OS
        // permission regex because the SFU string contains the word
        // "permission" too.
        let reason = 'unknown';
        if (/insufficient permission|unauthorized|forbidden|not allowed to publish|failed to publish track/i.test(msg)) reason = 'token-rejected';
        else if (/notallowederror|permission denied|user denied|denied by user/i.test(msg)) reason = 'os-permission-denied';
        else if (/device|hardware|not.?found|no camera/i.test(msg)) reason = 'no-camera';
        else if (/notreadable|in use/i.test(msg)) reason = 'camera-busy';
        logger.warn(
          '[livekitRoom] setCameraEnabled(' + enabled + ') failed:',
          'reason=' + reason,
          'msg=' + msg,
        );
        return { enabled: cameraEnabled, reason, error: msg };
      }
    },
    disconnect: async () => {
      try {
        // Best effort — once we're disconnecting it doesn't matter if
        // the toggles error.
        await room.localParticipant.setMicrophoneEnabled(false);
      } catch { /* ignore */ }
      try {
        await room.localParticipant.setCameraEnabled(false);
      } catch { /* ignore */ }
      await room.disconnect();
    },
  };
}

/** Map a LiveKit identity (typically `fid:<n>`) back to the FID we use
 *  everywhere else. Defensive against alternate identity schemes the
 *  server might choose. */
export function fidFromIdentity(identity: string | undefined): number | null {
  if (!identity) return null;
  const m = identity.match(/(?:^|:)(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

/** Convenience to know whether a participant is actively speaking. */
export function isActiveSpeaker(participant: Participant | RemoteParticipant): boolean {
  return Boolean(participant.isSpeaking);
}

/** Re-export the connection-state enum so the UI doesn't need to import
 *  from `livekit-client` directly. */
export { ConnectionState, Track };
