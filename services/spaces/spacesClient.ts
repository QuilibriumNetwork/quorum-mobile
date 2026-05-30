/**
 * HTTP client for Farcaster audio spaces. Endpoint paths, body field
 * names (`roomId`, `targetFid`, `raised`, `activeSpeakerFids`) and
 * response envelopes (`{ data: { result: ... } }`) were derived from
 * authenticated network traces against `client.farcaster.xyz`.
 *
 * Auth: bearer token issued by `client.farcaster.xyz`; reuses the
 * token already cached for the cast API (`farcasterAuthToken` from
 * AuthContext).
 *
 * Convention notes (important — easy to get wrong):
 *   - POST bodies use `roomId`, NOT `id`.
 *   - GET params use `roomId` (query string) for room-scoped fetches.
 *   - Snapshot envelope is `result.room` / `result.rooms` /
 *     `result.participants` / `result.messages`.
 */

import { logger } from '@quilibrium/quorum-shared';

const BASE_URL = 'https://client.farcaster.xyz';

function commonHeaders(token: string): Record<string, string> {
  return {
    accept: '*/*',
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    origin: 'https://farcaster.xyz',
    referer: 'https://farcaster.xyz/',
  };
}

/** Centralized failure logger. Most callers wrap in try/catch and
 *  swallow the error (so a transient snapshot 500 doesn't blow up the
 *  overlay), which makes diagnosing real failures painful. Logging
 *  here means every non-2xx response and every network error shows up
 *  in the Metro console regardless of what the caller does. */
function logSpacesFailure(
  method: 'GET' | 'POST',
  path: string,
  status: number | null,
  body: string,
): void {
  const trimmed = body.length > 400 ? `${body.slice(0, 400)}…` : body;
  logger.warn(
    `[spaces] ${method} ${path} ${status ?? 'network-error'}${trimmed ? ` :: ${trimmed}` : ''}`,
  );
}

async function getJson<T>(path: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: commonHeaders(token),
    });
  } catch (e) {
    logSpacesFailure('GET', path, null, e instanceof Error ? e.message : String(e));
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logSpacesFailure('GET', path, res.status, body);
    throw new Error(`${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, token: string, body: unknown = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: commonHeaders(token),
      body: JSON.stringify(body),
    });
  } catch (e) {
    logSpacesFailure('POST', path, null, e instanceof Error ? e.message : String(e));
    throw e;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    logSpacesFailure('POST', path, res.status, text);
    throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Bundle-shape for a Farcaster user (subset used by the audio-room
 *  payloads). The full server-side shape is larger; we keep only what
 *  the UI reads to stay tolerant of additions. */
export interface SpaceUser {
  fid: number;
  username?: string;
  displayName?: string;
  pfp?: { url?: string };
  /** Some endpoints denormalize the pfp url onto the root, so accept
   *  both. */
  pfpUrl?: string;
}

export type SpaceRole = 'host' | 'cohost' | 'speaker' | 'listener';

/** Per-participant pending stage invite. Set when a host has invited
 *  this user to the stage; cleared by accept/decline. */
export interface PendingStageInvite {
  role: SpaceRole;
  inviterFid: number;
}

export interface AudioRoomParticipant {
  user: SpaceUser;
  role: SpaceRole;
  pendingInvite?: PendingStageInvite | null;
  /** Listener-side: whether this participant has their hand up. */
  handRaised?: boolean;
  joinedAt?: string;
}

export interface AudioRoom {
  id: string;
  title?: string;
  description?: string;
  /** Denormalized host user — rendered directly via
   *  `room.host.displayName` / `room.host.pfp.url`. */
  host: SpaceUser;
  state: 'scheduled' | 'live' | 'ended' | string;
  /** ISO timestamp. Present once the room transitions to `live`. */
  startedAt?: string;
  /** ISO timestamp. Present for `scheduled` rooms. */
  scheduledAt?: string;
  endedAt?: string;
  listenerCount?: number;
  /** Channel key when the space is hosted inside a channel. */
  channelKey?: string;
  /** Hash of the cast that hosts the space embed. Direct replies to
   *  this cast are the space's chat thread; sending chat = posting a
   *  reply to it. Surfaced on the snapshot regardless of how the user
   *  reached the space (cast embed OR discovery strip). */
  rootCastHash?: string;
  /** FID of the cast author — same as `host.fid` in practice but
   *  surfaced separately by the server. */
  rootCastFid?: number;
}

export interface AudioRoomJoinResult {
  /** LiveKit cloud signaling URL (`wss://<host>.livekit.cloud`),
   *  served at `result.wsUrl`. */
  wsUrl: string;
  /** Short-lived JWT for the LiveKit room (`result.token`). */
  token: string;
  /** Role the server assigned us — usually 'listener' on first join. */
  role: SpaceRole;
  room: AudioRoom;
  /** The viewer's own FID, surfaced for telemetry / participant
   *  matching. Optional because not all server builds return it. */
  viewerFid?: number;
}

/** Standard envelope used by virtually every audio-room response. */
type Envelope<T> = { result: T };

// ---- Read-side -----------------------------------------------------

// We log the first room-fetch response per session so we can see every
// field the server returns (e.g., to discover whether the room snapshot
// carries an undocumented castHash / castId pointer for chat). Set this
// to `false` after the schema is settled.
let loggedRoomShape = false;

/** Read-only room snapshot used by the discovery card and the in-room
 *  poll. */
export async function fetchAudioRoom(roomId: string, token: string): Promise<AudioRoom | null> {
  try {
    const env = await getJson<Envelope<{ room: AudioRoom } & Record<string, unknown>>>(
      `/v1/audio-room?roomId=${encodeURIComponent(roomId)}`,
      token,
    );
    if (!loggedRoomShape) {
      loggedRoomShape = true;
      logger.log(
        '[spaces] /v1/audio-room raw room shape (first call only):',
        JSON.stringify(env.result),
      );
    }
    return env.result?.room ?? null;
  } catch {
    return null;
  }
}

export async function listAudioRoomParticipants(
  roomId: string,
  token: string,
): Promise<AudioRoomParticipant[]> {
  // Don't swallow — failures here mean an empty participant list
  // surfaces in the overlay with no clue why. `logSpacesFailure` in
  // getJson logs the HTTP layer; we let the throw bubble so the
  // caller's try/catch (which gives the diagnostic context) fires.
  const env = await getJson<Envelope<{ participants: AudioRoomParticipant[] }>>(
    `/v1/audio-room/participants?roomId=${encodeURIComponent(roomId)}`,
    token,
  );
  return env.result?.participants ?? [];
}

/** Currently-live audio rooms (the discovery list). */
export async function listLiveAudioRooms(
  token: string,
  limit = 30,
): Promise<AudioRoom[]> {
  try {
    const env = await getJson<Envelope<{ rooms: AudioRoom[] }>>(
      `/v1/audio-rooms?limit=${limit}`,
      token,
    );
    return env.result?.rooms ?? [];
  } catch {
    return [];
  }
}

/** Upcoming (scheduled) audio rooms. */
export async function listScheduledAudioRooms(
  token: string,
  limit = 30,
): Promise<AudioRoom[]> {
  try {
    const env = await getJson<Envelope<{ rooms: AudioRoom[] }>>(
      `/v1/audio-rooms/scheduled?limit=${limit}`,
      token,
    );
    return env.result?.rooms ?? [];
  } catch {
    return [];
  }
}

/** Read-only chat history for an audio room. Chat is a read-only
 *  surface server-side: messages can be fetched via this GET, but
 *  there is no HTTP send endpoint, so we poll. */
export interface AudioRoomChatMessage {
  id?: string;
  fid?: number;
  /** Denormalized user — present on some responses. */
  user?: SpaceUser;
  text: string;
  createdAt?: string | number;
}

export async function getAudioRoomChat(
  roomId: string,
  token: string,
): Promise<AudioRoomChatMessage[]> {
  try {
    const env = await getJson<Envelope<{ messages?: AudioRoomChatMessage[] }>>(
      `/v1/audio-room/chat?roomId=${encodeURIComponent(roomId)}`,
      token,
    );
    return env.result?.messages ?? [];
  } catch {
    return [];
  }
}

// ---- Write-side: lifecycle ----------------------------------------

export async function joinAudioRoom(roomId: string, token: string): Promise<AudioRoomJoinResult> {
  const env = await postJson<Envelope<AudioRoomJoinResult>>(
    `/v1/audio-room/join`,
    token,
    { roomId },
  );
  const result = env.result;
  if (!result?.wsUrl || !result?.token) {
    throw new Error('audio-room/join: missing wsUrl/token');
  }
  if (!result.room) throw new Error('audio-room/join: missing room payload');
  return {
    wsUrl: result.wsUrl,
    token: result.token,
    role: result.role ?? 'listener',
    room: result.room,
    viewerFid: result.viewerFid,
  };
}

export async function leaveAudioRoom(roomId: string, token: string): Promise<void> {
  await postJson(`/v1/audio-room/leave`, token, { roomId });
}

/** Heartbeat. Ticked every 10s; carries the FIDs of the participants
 *  we're currently hearing so the server can drive listener-side
 *  active-speaker rendering for clients without a direct LiveKit
 *  feed. */
export async function heartbeatAudioRoom(
  roomId: string,
  token: string,
  activeSpeakerFids: number[] = [],
): Promise<void> {
  await postJson(`/v1/audio-room/heartbeat`, token, {
    roomId,
    activeSpeakerFids,
  });
}

/** Host-only: end the room for everyone. Returns the final room
 *  snapshot (with `state === 'ended'`). */
export async function endAudioRoom(roomId: string, token: string): Promise<AudioRoom | null> {
  try {
    const env = await postJson<Envelope<{ room: AudioRoom }>>(
      `/v1/audio-room/end`,
      token,
      { roomId },
    );
    return env.result?.room ?? null;
  } catch {
    return null;
  }
}

/** Host-only: start a previously-scheduled room (flip state from
 *  `scheduled` to `live`). Returns the updated room. */
export async function startScheduledAudioRoom(
  roomId: string,
  token: string,
): Promise<AudioRoom | null> {
  try {
    const env = await postJson<Envelope<{ room: AudioRoom }>>(
      `/v1/audio-room/start-scheduled`,
      token,
      { roomId },
    );
    return env.result?.room ?? null;
  } catch {
    return null;
  }
}

/** Host-only: update room metadata (title, description, scheduledAt,
 *  channelKey). All fields are optional; the server merges over the
 *  existing record. */
export interface AudioRoomUpdateFields {
  title?: string;
  description?: string;
  scheduledAt?: string;
  channelKey?: string | null;
}

export async function updateAudioRoom(
  roomId: string,
  fields: AudioRoomUpdateFields,
  token: string,
): Promise<AudioRoom | null> {
  try {
    const env = await postJson<Envelope<{ room: AudioRoom }>>(
      `/v1/audio-room/update`,
      token,
      { roomId, ...fields },
    );
    return env.result?.room ?? null;
  } catch {
    return null;
  }
}

/** Create a new audio room. `scheduledAt` makes it a scheduled room;
 *  omit to start immediately. Returns the freshly-created room. */
export interface AudioRoomCreateFields {
  title: string;
  description?: string;
  scheduledAt?: string;
  channelKey?: string;
}

export async function createAudioRoom(
  fields: AudioRoomCreateFields,
  token: string,
): Promise<AudioRoom | null> {
  try {
    const env = await postJson<Envelope<{ room: AudioRoom }>>(
      `/v1/audio-rooms`,
      token,
      fields,
    );
    return env.result?.room ?? null;
  } catch {
    return null;
  }
}

// ---- Write-side: listener actions ---------------------------------

export async function raiseHand(roomId: string, raised: boolean, token: string): Promise<void> {
  await postJson(`/v1/audio-room/raise-hand`, token, { roomId, raised });
}

export async function sendReaction(roomId: string, emoji: string, token: string): Promise<void> {
  await postJson(`/v1/audio-room/reaction`, token, { roomId, emoji });
}

/** RSVP / un-RSVP to a scheduled room. Body field name `rsvped`
 *  follows the same toggle-flag convention as `raised` on
 *  `raise-hand`. */
export async function rsvpAudioRoom(
  roomId: string,
  rsvped: boolean,
  token: string,
): Promise<void> {
  await postJson(`/v1/audio-room/rsvp`, token, { roomId, rsvped });
}

// ---- Write-side: stage-invite handshake ---------------------------

/** Listener-side: accept the host's stage invite. The next snapshot
 *  will show our role as the invited role (`speaker` or `cohost`) and
 *  the LiveKit room will publish-enable our local participant. */
export async function acceptStageInvite(roomId: string, token: string): Promise<void> {
  await postJson(`/v1/audio-room/accept-stage-invite`, token, { roomId });
}

export async function declineStageInvite(roomId: string, token: string): Promise<void> {
  await postJson(`/v1/audio-room/decline-stage-invite`, token, { roomId });
}

// ---- Write-side: host actions -------------------------------------

/** Host-only: invite or accept a user onto the speaker stage. When the
 *  target has raised their hand, this accepts; when they haven't, it
 *  fires an unsolicited invite that the target accepts/declines via
 *  the listener-side endpoints. */
export async function acceptSpeaker(
  roomId: string,
  targetFid: number,
  token: string,
): Promise<void> {
  await postJson(`/v1/audio-room/accept-speaker`, token, { roomId, targetFid });
}

/** Host-only: rescind a pending stage invite before the target acts. */
export async function cancelStageInvite(
  roomId: string,
  targetFid: number,
  token: string,
): Promise<void> {
  await postJson(`/v1/audio-room/cancel-stage-invite`, token, { roomId, targetFid });
}

/** Host-only: demote a speaker back to the audience. */
export async function removeSpeaker(
  roomId: string,
  targetFid: number,
  token: string,
): Promise<void> {
  await postJson(`/v1/audio-room/remove-speaker`, token, { roomId, targetFid });
}
