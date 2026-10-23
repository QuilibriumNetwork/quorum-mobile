/**
 * Live direct-cast updates from farcaster.xyz's websocket, as Quilcast and
 * farcaster.xyz receive them, so nothing polls.
 *
 *   →  { messageType: 'dc_authenticate', data: <direct-cast token> }
 *   ←  { messageType: 'refresh-direct-cast-conversation', payload: { conversationId, message } }
 *   ←  { messageType: 'direct-cast-read', payload: { conversationId } }
 *   ←  { messageType: 'refresh-self-direct-casts-inbox', payload: { conversationId } }
 *
 * A dropped connection reconnects with backoff (1 s, doubling to a minute,
 * back to 1 s once a connection has held for 30 s), and `onOpen` says when
 * it's back so the caller can catch up on what was missed. Close code 4001
 * means the token was revoked: the caller mints a new one and connects with
 * it.
 */

import type { DirectCastMessage } from '../farcasterClient';

const WS_URL = 'wss://ws.farcaster.xyz/stream';
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/**
 * How long a connection has to stay up before the backoff starts again from a
 * second. Resetting it as soon as the socket opened meant a server that
 * accepted and then dropped the connection got a reconnect, and an inbox
 * catch-up, every second.
 */
const STABLE_AFTER_MS = 30_000;
/** Close code for a revoked token. */
export const TOKEN_REVOKED = 4001;

export type DirectCastEvent = {
  messageType: string;
  payload?: { conversationId?: string; message?: DirectCastMessage };
};

export interface DirectCastSocketHandlers {
  onEvent: (event: DirectCastEvent) => void;
  /** Connected and authenticated; `reconnected` after a drop. */
  onOpen?: (reconnected: boolean) => void;
  onRevoked?: () => void;
}

export interface DirectCastSocket {
  close: () => void;
}

export function connectDirectCastSocket(token: string, handlers: DirectCastSocketHandlers): DirectCastSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let dropped = false;
  let wait = FIRST_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStable = () => {
    if (stableTimer) clearTimeout(stableTimer);
    stableTimer = null;
  };

  const retry = () => {
    if (closed || retryTimer) return;
    dropped = true;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, wait);
    wait = Math.min(wait * 2, MAX_RETRY_MS);
  };

  const open = () => {
    if (closed) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch {
      retry();
      return;
    }
    ws = socket;

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify({ messageType: 'dc_authenticate', data: token }));
      } catch {
        return; // the close that follows retries
      }
      clearStable();
      stableTimer = setTimeout(() => {
        stableTimer = null;
        wait = FIRST_RETRY_MS;
      }, STABLE_AFTER_MS);
      const reconnected = dropped;
      dropped = false;
      handlers.onOpen?.(reconnected);
    };

    socket.onmessage = (event) => {
      if (closed || typeof event.data !== 'string') return;
      let parsed: DirectCastEvent;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (parsed && typeof parsed.messageType === 'string') handlers.onEvent(parsed);
    };

    // Errors surface as a close; onclose decides what happens next.
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (ws === socket) ws = null;
      clearStable();
      if (closed) return;
      if (event?.code === TOKEN_REVOKED) {
        closed = true;
        handlers.onRevoked?.();
        return;
      }
      retry();
    };
  };

  open();

  return {
    close: () => {
      closed = true;
      clearStable();
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const socket = ws;
      ws = null;
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
