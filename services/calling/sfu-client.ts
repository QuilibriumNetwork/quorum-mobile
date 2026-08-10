/**
 * SFU Client — communicates with the quorum-api SFU endpoints for space/group calls.
 *
 * The SFU manages rooms (one per active space call). Each participant sends
 * an SDP offer and receives an answer. Media flows through TURN relays to the SFU,
 * which forwards it to all other participants without decrypting.
 */

import { getApiConfig } from '../api/config';
import { logger } from '@quilibrium/quorum-shared';
import type { SpaceCallLiveness } from './spaceCallStatus';
export interface SFUJoinParams {
  roomId: string;
  spaceId: string;
  channelId: string;
  sdpOffer: string;
  address: string;
  signMessage: (msg: string) => Promise<string>;
}

export interface SFUJoinResult {
  sdpAnswer: string;
  participants: string[];
}

export interface SFULeaveParams {
  roomId: string;
  address: string;
  signMessage: (msg: string) => Promise<string>;
}

export interface SFURoomInfo {
  roomId: string;
  spaceId: string;
  channelId: string;
  participants: string[];
  active: boolean;
  createdAt: number;
}

export class SFUClient {
  private getBaseUrl(): string {
    return getApiConfig().baseUrl;
  }

  /**
   * Join a space call room. Sends an SDP offer and receives the SFU's answer.
   * The server authenticates via Ed448 signature on the join payload.
   */
  async joinRoom(params: SFUJoinParams): Promise<SFUJoinResult> {
    const timestamp = Date.now().toString();
    const signPayload = `sfu:join:${params.roomId}:${params.address}:${timestamp}`;
    const signature = await params.signMessage(signPayload);

    const url = `${this.getBaseUrl()}/sfu/join`;
    logger.debug(`[SFUClient] POST ${url} (room=${params.roomId})`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: params.roomId,
        space_id: params.spaceId,
        channel_id: params.channelId,
        address: params.address,
        sdp_offer: params.sdpOffer,
        signature,
        timestamp,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      logger.debug(`[SFUClient] join failed: ${response.status} ${errBody}`);
      throw new Error(`SFU join failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      sdpAnswer: data.sdp_answer,
      participants: data.participants ?? [],
    };
  }

  /**
   * Leave a space call room. Best-effort — the SFU also detects disconnects.
   */
  async leaveRoom(params: SFULeaveParams): Promise<void> {
    const timestamp = Date.now().toString();
    const signPayload = `sfu:leave:${params.roomId}:${params.address}:${timestamp}`;
    const signature = await params.signMessage(signPayload);

    const url = `${this.getBaseUrl()}/sfu/leave`;
    logger.debug(`[SFUClient] POST ${url} (room=${params.roomId})`);

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_id: params.roomId,
          address: params.address,
          signature,
          timestamp,
        }),
      });
    } catch {
      // Best-effort — the SFU will detect the disconnect via PeerConnection state
      logger.debug('[SFUClient] leave request failed (best-effort)');
    }
  }

  /**
   * Is this room live right now?
   *
   * Deliberately NOT expressed as `getRoomInfo() != null`. That helper folds
   * "the server says there is no such room" together with "the request never
   * completed" into a single `null`, and the two must not be confused by the
   * caller that decides whether to show a channel a joinable call: treating an
   * offline probe as a dead room would hide a real call from anyone with a
   * flaky connection.
   *
   * - `live`    — the room exists and is active.
   * - `gone`    — the server answered, and there is nothing to join.
   * - `unknown` — we failed to ask (offline, timeout, 5xx). Says nothing about
   *               the room.
   *
   * ⚠️ REVISIT WHEN THE CALL ROUTES SHIP (issue 2026-08-10-space-calls-dead-
   * endpoints-and-stale-banner, fix F5). Mapping 404 → `gone` is truthful only
   * while production serves no `/sfu/*` route at all: every probe 404s, no call
   * can be live, and "nothing to join" is the correct answer. Once the routes
   * exist, a 404 from a rolling deploy or a canary without the route becomes
   * indistinguishable from "that room is over", and a caller treating `gone` as
   * authoritative would hide a genuinely joinable call from everyone not
   * already in it. At that point distinguish the two — by response shape, or by
   * demanding a second confirming probe — rather than by status code alone.
   */
  async probeRoomLiveness(
    roomId: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<SpaceCallLiveness> {
    const url = `${this.getBaseUrl()}/sfu/room/${encodeURIComponent(roomId)}`;
    const controller = new AbortController();
    // A probe that never settles would leave the banner permanently
    // "unknown", which renders as live — the exact stuck state this replaced.
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 404) return 'gone';
      if (!response.ok) return 'unknown';
      const data = await response.json();
      return data?.active ? 'live' : 'gone';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get room info (participant list, active state).
   * Returns null if the room doesn't exist or is inactive.
   */
  async getRoomInfo(roomId: string): Promise<SFURoomInfo | null> {
    const url = `${this.getBaseUrl()}/sfu/room/${roomId}`;

    try {
      const response = await fetch(url);
      if (!response.ok) return null;

      const data = await response.json();
      if (!data.active) return null;

      return {
        roomId: data.room_id,
        spaceId: data.space_id ?? '',
        channelId: data.channel_id ?? '',
        participants: data.participants ?? [],
        active: data.active,
        createdAt: data.created_at ?? 0,
      };
    } catch {
      return null;
    }
  }
}
