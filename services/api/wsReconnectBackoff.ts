/**
 * Reconnect pacing for the Quorum WebSocket.
 *
 * The shared client (`createRNWebSocketClient` in quorum-shared) can only
 * retry on a fixed interval: it was created with 2 s and no attempt limit, so
 * a relay outage or a dead network meant a new socket every 2 s, each one
 * re-sending `listen` for every inbox and `log-since` for every space as soon
 * as it opened — and, when the relay came back, every client reconnecting in
 * the same 2 s step.
 *
 * The client takes `maxReconnectAttempts: 0` to stop retrying on its own, and
 * this scheduler drives retries through its public `connect()` instead:
 * exponential backoff with jitter, capped at RECONNECT_MAX_MS, and back to the
 * short first step once a connection has stayed up for RECONNECT_STABLE_MS.
 */

import type { WebSocketConnectionState } from '@quilibrium/quorum-shared';

/** Ceiling of the first retry's delay. */
export const RECONNECT_BASE_MS = 1_000;
/** Ceiling of any retry's delay. */
export const RECONNECT_MAX_MS = 30_000;
/** A connection that stays up this long resets the backoff. */
export const RECONNECT_STABLE_MS = 30_000;

/**
 * Delay before retry number `attempt` (0-based): uniformly in the upper half
 * of `min(MAX, BASE * 2^attempt)`. The jitter spreads clients that lost the
 * relay together; keeping the lower half out keeps the growth real.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

export interface ReconnectSchedulerOptions {
  /** Open the socket. Called when a scheduled retry comes due. */
  reconnect: () => void;
  now?: () => number;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (t: ReturnType<typeof setTimeout>) => void;
}

export interface ReconnectScheduler {
  /**
   * Whether the app wants the socket open. Only a socket the app wants is
   * retried; a deliberate disconnect (sign-out, unmount) must set this false
   * BEFORE closing, so the resulting 'disconnected' does not schedule a retry.
   */
  setWanted(wanted: boolean): void;
  /**
   * Feed every client state change through this. Returns the state to report
   * to the UI: 'reconnecting' while a retry is scheduled, otherwise `state`.
   */
  onStateChange(state: WebSocketConnectionState): WebSocketConnectionState;
  /** Drop a scheduled retry, for a caller about to connect right now. */
  cancelPending(): void;
  /** True while a retry is scheduled. */
  readonly pending: boolean;
}

export function createReconnectScheduler(options: ReconnectSchedulerOptions): ReconnectScheduler {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));

  let wanted = false;
  let attempt = 0;
  let connectedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelPending = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  return {
    setWanted(next) {
      wanted = next;
      if (!next) {
        cancelPending();
        attempt = 0;
      }
    },

    onStateChange(state) {
      if (state === 'connected') {
        connectedAt = now();
        cancelPending();
        return state;
      }
      if (state !== 'disconnected') return state;

      // Reset only for a connection that proved itself. One that opens and
      // drops straight away (relay refusing us, a captive portal) keeps
      // backing off instead of hammering at the first step forever.
      if (connectedAt !== null && now() - connectedAt >= RECONNECT_STABLE_MS) attempt = 0;
      connectedAt = null;

      if (!wanted) return state;
      if (timer === null) {
        const delay = reconnectDelay(attempt, random);
        attempt += 1;
        timer = setTimer(() => {
          timer = null;
          if (wanted) options.reconnect();
        }, delay);
      }
      return 'reconnecting';
    },

    cancelPending,

    get pending() {
      return timer !== null;
    },
  };
}
