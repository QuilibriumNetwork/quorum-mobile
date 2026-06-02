/**
 * farcasterSpaceSocket — connects to Farcaster's realtime WebSocket for the
 * duration of an audio-space session and surfaces server-broadcast reaction
 * events.
 *
 * This is how the official Farcaster client receives *others'* reactions: the
 * reaction POST (`/v1/audio-room/reaction`) is fanned out by the server over
 * this socket to everyone subscribed to the room. The LiveKit data channel
 * can't do this reliably — a listener has no publish permission, so their
 * reaction would never reach anyone. The protocol mirrors the web client:
 *
 *   →  { messageType: 'authenticate', data: 'Bearer <token>' }
 *   →  { messageType: 'audio_room_subscribe', data: { roomId } }
 *   ←  { messageType: 'audio-room-reaction', payload: { emoji, fid } }
 */

const WS_URL = 'wss://ws.farcaster.xyz/stream';
const RECONNECT_DELAY_MS = 2000;

export interface SpaceSocketCallbacks {
  onReaction?: (emoji: string, fid: number) => void;
}

export interface SpaceSocketHandle {
  close: () => void;
}

export function connectSpaceSocket(
  roomId: string,
  token: string,
  callbacks: SpaceSocketCallbacks,
): SpaceSocketHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, RECONNECT_DELAY_MS);
  };

  const open = () => {
    if (closed) return;
    try {
      ws = new WebSocket(WS_URL);
    } catch {
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      try {
        ws?.send(JSON.stringify({ messageType: 'authenticate', data: `Bearer ${token}` }));
        ws?.send(JSON.stringify({ messageType: 'audio_room_subscribe', data: { roomId } }));
      } catch {
        /* ignore — reconnect will retry */
      }
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      try {
        const msg = JSON.parse(ev.data);
        if (msg?.messageType === 'audio-room-reaction' && msg.payload) {
          const { emoji, fid } = msg.payload;
          if (typeof emoji === 'string' && typeof fid === 'number') {
            callbacks.onReaction?.(emoji, fid);
          }
        }
      } catch {
        /* non-JSON / unrelated frame — ignore */
      }
    };

    // Errors surface as a close; let onclose drive reconnection.
    ws.onerror = () => { /* no-op */ };
    ws.onclose = () => {
      if (!closed) scheduleReconnect();
    };
  };

  open();

  return {
    close: () => {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
