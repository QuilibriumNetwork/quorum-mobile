/**
 * Polyfill the WebRTC globals that `livekit-client` expects. We use
 * the browser-style SDK instead of `@livekit/react-native` because
 * the latter peer-depends on `@livekit/react-native-webrtc`, a hard
 * fork of `react-native-webrtc`. We already ship the upstream
 * `react-native-webrtc` for 1:1 calls; installing both would register
 * two native WebRTC modules on iOS and break the build.
 *
 * Side-effect import. Call before any `livekit-client` code runs.
 */

import {
  MediaStream,
  MediaStreamTrack,
  RTCIceCandidate,
  RTCPeerConnection,
  RTCRtpReceiver,
  RTCRtpSender,
  RTCSessionDescription,
  mediaDevices,
  registerGlobals,
} from 'react-native-webrtc';

let installed = false;

export function installLivekitWebrtcPolyfill(): void {
  if (installed) return;
  installed = true;

  // react-native-webrtc ships its own global registrar that installs
  // the bulk of the standard names — call it first, then patch up the
  // pieces it omits.
  try {
    registerGlobals();
  } catch {
    // Older versions of react-native-webrtc don't expose registerGlobals;
    // fall through to the manual assignment below.
  }

  const g = globalThis as Record<string, unknown>;

  // Hermes doesn't ship DOMException, but `livekit-client` references
  // it at module-evaluation time (it throws DOMException subclasses on
  // SDP / track errors). A minimal Error subclass satisfies both the
  // `instanceof` checks and the constructor signature the SDK uses.
  if (typeof g.DOMException !== 'function') {
    class DOMExceptionShim extends Error {
      readonly code: number;
      constructor(message = '', name = 'Error') {
        super(message);
        this.name = name;
        this.code = 0;
      }
    }
    g.DOMException = DOMExceptionShim;
  }

  g.RTCPeerConnection ??= RTCPeerConnection;
  g.RTCSessionDescription ??= RTCSessionDescription;
  g.RTCIceCandidate ??= RTCIceCandidate;
  g.MediaStream ??= MediaStream;
  g.MediaStreamTrack ??= MediaStreamTrack;
  g.RTCRtpSender ??= RTCRtpSender;
  g.RTCRtpReceiver ??= RTCRtpReceiver;

  // livekit-client reads `navigator.mediaDevices.{getUserMedia, enumerateDevices}`
  // directly. The web sdk doesn't care about anything else on `navigator`.
  if (typeof g.navigator !== 'object' || g.navigator === null) {
    g.navigator = {} as any;
  }
  const nav = g.navigator as { mediaDevices?: unknown; userAgent?: string };
  if (!nav.mediaDevices) nav.mediaDevices = mediaDevices;
  // Some livekit-client paths sniff userAgent to gate codec choices.
  // Provide a benign string so the absence isn't itself an error.
  if (typeof nav.userAgent !== 'string') nav.userAgent = 'ReactNativeWebRTC/1.0';

  // ---- DOM shim for remote-audio playback --------------------------
  //
  // RemoteAudioTrack.attach() inside livekit-client creates an
  // <audio> element via document.createElement('audio'), sets
  // srcObject = stream, and calls .play(). On Hermes there is no DOM
  // — that path would throw on `document` undefined. react-native-webrtc
  // already auto-routes received audio to the device speaker without
  // a media element, so the shim here only needs to satisfy the
  // SDK's attach() contract — accept srcObject + play() and otherwise
  // be a no-op.

  interface ShimAudioElement {
    id: string;
    autoplay: boolean;
    muted: boolean;
    volume: number;
    paused: boolean;
    srcObject: unknown;
    style: Record<string, string>;
    setAttribute: (k: string, v: string) => void;
    removeAttribute: (k: string) => void;
    getAttribute: (k: string) => string | null;
    addEventListener: (type: string, fn: () => void) => void;
    removeEventListener: (type: string, fn: () => void) => void;
    appendChild: (n: unknown) => unknown;
    remove: () => void;
    play: () => Promise<void>;
    pause: () => void;
    load: () => void;
  }

  const createAudioElement = (): ShimAudioElement => {
    const attrs: Record<string, string> = {};
    return {
      id: '',
      autoplay: true,
      muted: false,
      volume: 1,
      paused: false,
      srcObject: null,
      style: {},
      setAttribute: (k, v) => { attrs[k] = v; },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (n) => n,
      remove: () => {},
      play: async () => { /* audio is routed natively */ },
      pause: () => {},
      load: () => {},
    };
  };

  const docCurrent = g.document as { createElement?: (tag: string) => unknown } | undefined;
  if (!docCurrent || typeof docCurrent.createElement !== 'function') {
    const docBody = {
      appendChild: (n: unknown) => n,
      removeChild: (n: unknown) => n,
    };
    g.document = {
      // Only `audio` matters for livekit's audio-element creation. For
      // any other tag, return a generic shim with the same surface so
      // we don't break a random sniffer path.
      createElement: (tag: string) => {
        if (tag.toLowerCase() === 'audio') return createAudioElement();
        return createAudioElement();
      },
      body: docBody,
      head: docBody,
      addEventListener: () => {},
      removeEventListener: () => {},
      // visibility is read by some libraries to gate work; pretend the
      // page is visible.
      visibilityState: 'visible',
      hidden: false,
    } as unknown;
  }

  // `window` shim. livekit-client calls window.addEventListener /
  // window.removeEventListener (e.g., in Room#handleDisconnect for
  // 'beforeunload' / 'pagehide' wiring). Hermes' globalThis has no
  // such methods, so the SDK crashes mid-disconnect. We install
  // no-op listener methods that match the DOM signature; nothing
  // here ever fires events back, which is correct — there's no page
  // lifecycle to observe on RN.
  if (typeof g.window === 'undefined' || g.window === null) {
    g.window = g;
  }
  const win = g.window as {
    addEventListener?: (...a: unknown[]) => void;
    removeEventListener?: (...a: unknown[]) => void;
    dispatchEvent?: (...a: unknown[]) => boolean;
  };
  if (typeof win.addEventListener !== 'function') {
    win.addEventListener = () => {};
  }
  if (typeof win.removeEventListener !== 'function') {
    win.removeEventListener = () => {};
  }
  if (typeof win.dispatchEvent !== 'function') {
    win.dispatchEvent = () => true;
  }
}
