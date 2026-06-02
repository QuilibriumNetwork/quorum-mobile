/**
 * AudioSpaceContext — global state for the single audio space the user
 * is currently joined to. Mirrors `MiniappOverlayContext`: one room at
 * a time, the provider mounts the overlay/sheet, and surfaces around
 * the app dispatch via `useAudioSpace().join(id)`.
 *
 * The provider owns:
 *   - the joined-room state (id, role, room snapshot),
 *   - the LiveKit room handle (so audio survives navigation),
 *   - the heartbeat ticker that keeps the server-side session alive,
 *   - the live-state the overlay reads (active speakers, mic state,
 *     reaction stream).
 *
 * The OS-level audio session stays configured for `playsInSilentMode`
 * + `audio` background mode (already in app.json), so the room keeps
 * playing when the app moves to the background.
 */

import React from 'react';
import { AudioSpaceOverlay } from '@/components/AudioSpaceOverlay';
import { useAuth } from '@/context/AuthContext';
import {
  acceptSpeaker as acceptSpeakerApi,
  acceptStageInvite as acceptStageInviteApi,
  cancelStageInvite as cancelStageInviteApi,
  createAudioRoom as createAudioRoomApi,
  declineStageInvite as declineStageInviteApi,
  endAudioRoom as endAudioRoomApi,
  fetchAudioRoom,
  heartbeatAudioRoom,
  joinAudioRoom,
  leaveAudioRoom,
  listAudioRoomParticipants,
  raiseHand as raiseHandApi,
  removeSpeaker as removeSpeakerApi,
  rsvpAudioRoom as rsvpAudioRoomApi,
  sendReaction as sendReactionApi,
  startScheduledAudioRoom as startScheduledAudioRoomApi,
  updateAudioRoom as updateAudioRoomApi,
  type AudioRoom,
  type AudioRoomCreateFields,
  type AudioRoomParticipant,
  type AudioRoomUpdateFields,
  type SpaceRole,
} from '@/services/spaces/spacesClient';
import {
  connectToSpace,
  fidFromIdentity,
  type ConnectedSpaceRoom,
  type ReactionPayload,
} from '@/services/spaces/livekitRoom';
import {
  fetchSpaceChat,
  submitSpaceChatReply,
  type SpaceChatCast,
} from '@/services/farcaster/spaceChatFetch';
import { mmkvStorage } from '@/services/offline/storage';
import { connectSpaceSocket } from '@/services/spaces/farcasterSpaceSocket';
import { likeCast, unlikeCast, recastCast, unrecastCast } from '@/services/farcasterClient';
import { logger } from '@quilibrium/quorum-shared';
import QuorumCrypto from '../modules/quorum-crypto/src';

export interface ActiveSpaceEntry {
  id: string;
  /** Bumped each `join()` so re-entering an already-active id forces
   *  a fresh fetch / minimize-to-restore cycle. */
  timestamp: number;
  /** Hash of the cast that hosts the audio-space embed. Chat = direct
   *  replies to this cast; sending chat = posting a reply to it. When
   *  omitted (e.g. discovery strip), chat is hidden because there's
   *  no anchor. */
  castHash?: string;
}

export type { SpaceRole } from '@/services/spaces/spacesClient';

export type SpaceConnectionState =
  | 'idle'
  | 'fetching'
  | 'connecting'
  | 'connected'
  /** Room is `scheduled` — we never call `/v1/audio-room/join` (the
   *  server 400s with "is not live") and only render the preview +
   *  RSVP affordance. */
  | 'scheduled'
  | 'error';

/** Ephemeral reaction with a generated id so the overlay can animate
 *  them as a stream (e.g., float-up like Twitter Spaces). */
export interface ReactionEvent {
  id: string;
  emoji: string;
  fid?: number;
  receivedAt: number;
}

interface AudioSpaceContextValue {
  active: ActiveSpaceEntry | null;
  /** Latest server snapshot of the room (title, host, state, ...). */
  room: AudioRoom | null;
  /** Latest participants snapshot — separately polled from the room
   *  snapshot and surfaced on the context for the overlay. */
  participants: AudioRoomParticipant[];
  /** Server-assigned role for the local participant. */
  role: SpaceRole;
  state: SpaceConnectionState;
  error: string | null;
  /** Local mic state — only meaningful when role is 'host' or 'speaker'. */
  micEnabled: boolean;
  /** Local hand-raised state. Listeners use this to request the stage. */
  handRaised: boolean;
  /** Audio output route. True = loudspeaker (default for a space — you're
   *  mostly listening), false = earpiece. Bluetooth/wired headsets
   *  override this regardless. */
  isSpeakerOn: boolean;
  /** Identities of remote participants currently emitting audio. UI
   *  uses this to outline the speaker tiles. */
  activeSpeakerIdentities: string[];
  /** Live reactions to overlay on the sheet (auto-purged after ~3s). */
  reactions: ReactionEvent[];
  /** Chat = direct replies to the space's root cast (polled). */
  chatMessages: SpaceChatCast[];
  /** True when the host has invited the local listener to the stage —
   *  the overlay surfaces an accept/decline modal. */
  hasStageInvite: boolean;
  /** Local RSVP state for the active scheduled room. The server
   *  doesn't currently surface this on the room snapshot, so we keep
   *  it as an optimistic boolean. `null` = unknown / not toggled. */
  hasRsvped: boolean | null;

  join: (id: string, opts?: { castHash?: string }) => void;
  leave: () => void;
  toggleMic: () => Promise<void>;
  toggleHand: () => Promise<void>;
  /** Swap the audio output between loudspeaker and earpiece. */
  toggleSpeaker: () => void;
  reactWith: (emoji: string) => Promise<void>;
  acceptStageInvite: () => Promise<void>;
  declineStageInvite: () => Promise<void>;
  /** Host-only — invite or accept a listener onto the speaker stage. */
  promoteToSpeaker: (fid: number) => Promise<void>;
  /** Host-only — rescind a pending invite (target hasn't acted yet). */
  cancelStageInvite: (fid: number) => Promise<void>;
  /** Host-only — demote a speaker back to the audience. */
  demoteSpeaker: (fid: number) => Promise<void>;
  /** Host-only — end the room for everyone. */
  endRoom: () => Promise<void>;
  /** Host-only — start a previously-scheduled room now. */
  startScheduled: () => Promise<void>;
  /** Host-only — edit room metadata (title, description, scheduledAt). */
  updateRoom: (fields: AudioRoomUpdateFields) => Promise<void>;
  /** Create a new audio room. Omit `scheduledAt` for an immediate
   *  live room (the returned room's `state` will be `live` and the
   *  caller can `join(room.id)` directly); include it for a scheduled
   *  room (`state: 'scheduled'`). Returns the freshly-created room
   *  (or null on failure). */
  createSpace: (fields: AudioRoomCreateFields) => Promise<AudioRoom | null>;
  /** Listener-side: RSVP / un-RSVP a scheduled room. Mutates without
   *  joining; used by the embed card before the room is live. */
  rsvp: (roomId: string, rsvped: boolean) => Promise<void>;
  /** Toggle RSVP for the currently active scheduled room. */
  toggleRsvp: () => Promise<void>;

  /** True when the user has dismissed the modal but the connection is
   *  still active (mini-pill shown). */
  minimized: boolean;
  /** Hide the modal without leaving the room. */
  minimize: () => void;
  /** Bring the modal back when minimized. */
  restore: () => void;
  /** Send a chat message (posts a reply to the space's root cast). */
  sendChat: (text: string) => Promise<void>;
  /** Reply to a specific chat message (posts a reply to its cast hash). */
  replyToChat: (targetCastHash: string, text: string) => Promise<void>;
  /** Like/unlike a chat message via the Farcaster API. Toggles based on
   *  the passed current state; optimistic with rollback. */
  toggleChatLike: (castHash: string, currentlyLiked: boolean, currentCount: number) => Promise<void>;
  /** Recast/unrecast a chat message via the Farcaster API. */
  toggleChatRecast: (castHash: string, currentlyRecasted: boolean, currentCount: number) => Promise<void>;
  /** Optimistic per-message like state (hash → {liked, count}). */
  chatLikeStates: Map<string, { liked: boolean; count: number }>;
  /** Optimistic per-message recast state (hash → {recasted, count}). */
  chatRecastStates: Map<string, { recasted: boolean; count: number }>;

  /** Local camera publish state. Only meaningful for host/cohost/
   *  speaker roles — gated server-side. */
  cameraEnabled: boolean;
  /** Toggle the local camera. Returns the resulting state and, on
   *  failure, a structured reason so callers can surface "OS
   *  permission denied" vs "server rejected" appropriately. */
  toggleCamera: () => Promise<{ enabled: boolean; reason?: string; error?: string }>;
  /** RTCView-compatible stream URL for the local camera preview, or
   *  null when video is off / unavailable. */
  localCameraStreamURL: string | null;
  /** Current local camera facing — `user` is the selfie/front lens,
   *  `environment` is the rear lens. Used to control `RTCView.mirror`
   *  on the preview tile. */
  localCameraFacing: 'user' | 'environment';
  /** Toggle between front and back camera. No-op when camera off. */
  flipCamera: () => Promise<void>;
  /** RTCView-compatible stream URL per remote participant FID. Used
   *  by `ParticipantTile` to render video in place of the avatar. */
  remoteVideoStreams: Record<number, string>;
}

const Ctx = React.createContext<AudioSpaceContextValue | null>(null);

export function useAudioSpace(): AudioSpaceContextValue {
  const ctx = React.useContext(Ctx);
  if (!ctx) {
    return {
      active: null,
      room: null,
      participants: [],
      role: 'listener',
      state: 'idle',
      error: null,
      micEnabled: false,
      handRaised: false,
      isSpeakerOn: true,
      activeSpeakerIdentities: [],
      reactions: [],
      chatMessages: [],
      hasStageInvite: false,
      hasRsvped: null,
      join: () => {
        logger.warn('[AudioSpace] join called outside provider');
      },
      leave: () => {},
      toggleMic: async () => {},
      toggleHand: async () => {},
      toggleSpeaker: () => {},
      reactWith: async () => {},
      acceptStageInvite: async () => {},
      declineStageInvite: async () => {},
      promoteToSpeaker: async () => {},
      cancelStageInvite: async () => {},
      demoteSpeaker: async () => {},
      endRoom: async () => {},
      startScheduled: async () => {},
      updateRoom: async () => {},
      rsvp: async () => {},
      toggleRsvp: async () => {},
      minimized: false,
      minimize: () => {},
      restore: () => {},
      sendChat: async () => {},
      replyToChat: async () => {},
      toggleChatLike: async () => {},
      toggleChatRecast: async () => {},
      chatLikeStates: new Map(),
      chatRecastStates: new Map(),
      cameraEnabled: false,
      toggleCamera: async () => ({ enabled: false, reason: 'no-provider' }),
      localCameraStreamURL: null,
      localCameraFacing: 'user',
      flipCamera: async () => {},
      remoteVideoStreams: {},
      createSpace: async () => null,
    };
  }
  return ctx;
}

/** Heartbeat interval. Server expires unheartbeated participants on
 *  the order of ~60s; ticking every 10s leaves enough margin for one
 *  miss without the server dropping us. */
const HEARTBEAT_INTERVAL_MS = 10_000;
const REACTION_TTL_MS = 3_000;
/** How often we re-pull the room snapshot while joined. Faster than
 *  the embed card's 15s so the in-room UI (participant list, chat,
 *  stage-invite signal) reacts within a few seconds. A real WS bridge
 *  would replace this; until that's verified against an authenticated
 *  trace, polling is the safest reactivity story. */
const ROOM_POLL_INTERVAL_MS = 5_000;

/** How long an optimistic chat message persists in MMKV before we
 *  give up waiting for the server to confirm it. Farcaster reply
 *  propagation typically lands within seconds; 10 minutes is the
 *  cliff at which we assume the cast failed and stop re-surfacing
 *  the stub on reload. */
const PENDING_CHAT_TTL_MS = 10 * 60_000;
const PENDING_CHAT_KEY_PREFIX = 'audio-space-pending-chat:v1:';

interface PendingChatEntry {
  hash: string;
  text: string;
  timestamp: number;
  parentHash: string;
  author: SpaceChatCast['author'];
}

function pendingChatKey(castHash: string): string {
  return `${PENDING_CHAT_KEY_PREFIX}${castHash.toLowerCase()}`;
}

function loadPendingChat(castHash: string): PendingChatEntry[] {
  try {
    const raw = mmkvStorage.getItem(pendingChatKey(castHash));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingChatEntry[];
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((e) => now - e.timestamp < PENDING_CHAT_TTL_MS);
  } catch {
    return [];
  }
}

function savePendingChat(castHash: string, entries: PendingChatEntry[]): void {
  try {
    if (entries.length === 0) {
      mmkvStorage.removeItem(pendingChatKey(castHash));
    } else {
      mmkvStorage.setItem(pendingChatKey(castHash), JSON.stringify(entries));
    }
  } catch { /* ignore */ }
}

/** Drop pending entries that the server has now mirrored back. We
 *  match by author FID + exact text content within a 30-second
 *  window of the optimistic timestamp — distinct enough that two
 *  different real messages from the same author wouldn't collide,
 *  generous enough to cover propagation jitter. */
function reconcilePending(
  pending: PendingChatEntry[],
  server: SpaceChatCast[],
): PendingChatEntry[] {
  if (pending.length === 0) return pending;
  return pending.filter((p) => {
    const match = server.find((s) =>
      s.author.fid === p.author.fid
      && s.text === p.text
      && Math.abs(s.timestamp - p.timestamp) < 30_000,
    );
    return !match;
  });
}

/** Merge a pending list into a server-fetched list, oldest-first by
 *  timestamp. Pending entries that match a server message are dropped
 *  upstream by `reconcilePending`. */
function mergeChat(server: SpaceChatCast[], pending: PendingChatEntry[]): SpaceChatCast[] {
  if (pending.length === 0) return server;
  const out = [...server];
  for (const p of pending) {
    out.push({
      hash: p.hash,
      text: p.text,
      timestamp: p.timestamp,
      parentHash: p.parentHash,
      author: p.author,
    });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

export function AudioSpaceProvider({ children }: { children: React.ReactNode }) {
  const { farcasterAuthToken, user } = useAuth();
  const localFid = user?.farcaster?.fid;

  const [active, setActive] = React.useState<ActiveSpaceEntry | null>(null);
  const [room, setRoom] = React.useState<AudioRoom | null>(null);
  const [participants, setParticipants] = React.useState<AudioRoomParticipant[]>([]);
  const [role, setRole] = React.useState<SpaceRole>('listener');
  const [state, setState] = React.useState<SpaceConnectionState>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [micEnabled, setMicEnabled] = React.useState(false);
  const [handRaised, setHandRaised] = React.useState(false);
  // Audio output route. Default loudspeaker — a space is a listening
  // experience, so earpiece-by-default (iOS voiceChat) would be wrong.
  // The ref lets the connect handler apply the current preference without
  // a stale closure.
  const [isSpeakerOn, setIsSpeakerOn] = React.useState(true);
  const isSpeakerOnRef = React.useRef(true);
  const [activeSpeakerIdentities, setActiveSpeakerIdentities] = React.useState<string[]>([]);
  const [reactions, setReactions] = React.useState<ReactionEvent[]>([]);
  const [chatMessages, setChatMessages] = React.useState<SpaceChatCast[]>([]);
  // Optimistic per-message like/recast state, keyed by cast hash. Mirrors the
  // feed's pattern so taps reflect immediately and roll back on API failure.
  const [chatLikeStates, setChatLikeStates] = React.useState<Map<string, { liked: boolean; count: number }>>(new Map());
  const [chatRecastStates, setChatRecastStates] = React.useState<Map<string, { recasted: boolean; count: number }>>(new Map());
  const [hasRsvped, setHasRsvped] = React.useState<boolean | null>(null);
  const [minimized, setMinimized] = React.useState(false);
  const [cameraEnabled, setCameraEnabled] = React.useState(false);
  const [localCameraStreamURL, setLocalCameraStreamURL] = React.useState<string | null>(null);
  const [localCameraFacing, setLocalCameraFacing] = React.useState<'user' | 'environment'>('user');
  // Keyed by FID. We translate LiveKit's identity strings (`fid:<n>`)
  // back to numeric FIDs at the wire boundary so the overlay can look
  // up streams by the same key it uses for participants.
  const [remoteVideoStreams, setRemoteVideoStreams] = React.useState<Record<number, string>>({});

  // Persistent handles. Refs so the connection lifecycle survives
  // re-renders without being torn down each time the overlay rerenders.
  const connectedRef = React.useRef<ConnectedSpaceRoom | null>(null);
  const heartbeatRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const roomPollRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest active id snapshot, so async effects can check whether the
  // user has since joined a different room and bail out.
  const activeIdRef = React.useRef<string | null>(null);
  // Previous role, so we can detect listener→speaker transitions to
  // auto-prompt mic enable after the host accepts a stage invite.
  const prevRoleRef = React.useRef<SpaceRole>('listener');
  // Effective cast anchor for chat. Seeded from `join({castHash})` and
  // promoted from `room.rootCastHash` after the first snapshot poll
  // when not provided at join time. Lives in a ref so callbacks
  // (sendChat, the chat-button gate) can read the latest value without
  // re-binding when the value transitions from undefined → discovered.
  const castHashRef = React.useRef<string | undefined>(undefined);
  // Locally-sent chat messages that haven't yet been mirrored back by
  // the server. Persisted to MMKV so a reload before propagation
  // doesn't lose the user's message.
  const pendingChatRef = React.useRef<PendingChatEntry[]>([]);
  // Live mirror of activeSpeakerIdentities — read inside the heartbeat
  // tick so we can surface the active FIDs without re-binding the
  // interval on every change.
  const activeSpeakerIdsRef = React.useRef<string[]>([]);
  React.useEffect(() => { activeSpeakerIdsRef.current = activeSpeakerIdentities; }, [activeSpeakerIdentities]);

  const teardown = React.useCallback(async () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (roomPollRef.current) {
      clearInterval(roomPollRef.current);
      roomPollRef.current = null;
    }
    const connected = connectedRef.current;
    connectedRef.current = null;
    if (connected) {
      try { await connected.disconnect(); } catch { /* ignore */ }
    }
    setRoom(null);
    setParticipants([]);
    setRole('listener');
    prevRoleRef.current = 'listener';
    setMicEnabled(false);
    setHandRaised(false);
    setIsSpeakerOn(true);
    isSpeakerOnRef.current = true;
    setActiveSpeakerIdentities([]);
    setReactions([]);
    setChatMessages([]);
    setHasRsvped(null);
    setMinimized(false);
    setCameraEnabled(false);
    setLocalCameraStreamURL(null);
    setLocalCameraFacing('user');
    setRemoteVideoStreams({});
    castHashRef.current = undefined;
    pendingChatRef.current = [];
    setState('idle');
    setError(null);
  }, []);

  const join = React.useCallback((id: string, opts?: { castHash?: string }) => {
    const doJoin = () => {
      // Never enter a new space minimized.
      setMinimized(false);
      castHashRef.current = opts?.castHash;
      // If we have the anchor immediately (cast-embed entry), prime the
      // pending queue from MMKV right away. The discovery-strip path
      // (no castHash at join) defers this to the first poll tick that
      // adopts `room.rootCastHash`.
      if (opts?.castHash) {
        const persisted = loadPendingChat(opts.castHash);
        pendingChatRef.current = persisted;
        if (persisted.length > 0) {
          setChatMessages(mergeChat([], persisted));
        }
      }
      setActive({ id, timestamp: Date.now(), castHash: opts?.castHash });
    };

    const prevId = activeIdRef.current;
    if (prevId && prevId !== id) {
      // Switching from another (possibly minimized) space: fully LEAVE it
      // first — tell the server, disconnect, and reset state — so we don't
      // strand a ghost participant in the old room or carry its state (incl.
      // the minimized mini-pill) into the new one. `teardown` is async and
      // its resets would clobber the new space's state, so join only AFTER it
      // settles.
      activeIdRef.current = null;
      if (farcasterAuthToken) {
        leaveAudioRoom(prevId, farcasterAuthToken).catch(() => { /* ignore */ });
      }
      teardown().finally(doJoin);
    } else {
      doJoin();
    }
  }, [farcasterAuthToken, teardown]);

  const leave = React.useCallback(() => {
    const id = active?.id;
    setActive(null);
    activeIdRef.current = null;
    void teardown();
    if (id && farcasterAuthToken) {
      // Fire-and-forget the server-side leave so the host's UI updates
      // even if we crash on the way out.
      leaveAudioRoom(id, farcasterAuthToken).catch(() => { /* ignore */ });
    }
  }, [active?.id, farcasterAuthToken, teardown]);

  // ---- Connection lifecycle ----------------------------------------
  React.useEffect(() => {
    if (!active || !farcasterAuthToken) return;
    activeIdRef.current = active.id;
    let cancelled = false;

    // Refs the live-room block needs but the scheduled-preview block
    // also defines so the poll loop can drive a scheduled→live
    // transition. Declared up front to keep both branches symmetric.
    let livePollStarted = false;

    const startLivePoll = (roomId: string, initialCastHash: string | undefined) => {
      if (livePollStarted) return;
      livePollStarted = true;
      // Effective cast anchor for this poll loop. Seeded from whatever
      // the caller passed to `join()` (set when entering from a cast
      // embed). If absent, we adopt the `rootCastHash` from the first
      // successful room snapshot — discovery-strip joins start with
      // no anchor but the snapshot fills it in, so chat works either
      // way after the first poll tick.
      let castHash = initialCastHash;
      const pull = async () => {
        if (activeIdRef.current !== roomId) return;
        try {
          const [snap, parts] = await Promise.all([
            fetchAudioRoom(roomId, farcasterAuthToken),
            listAudioRoomParticipants(roomId, farcasterAuthToken),
          ]);
          if (activeIdRef.current !== roomId) return;
          if (snap) {
            setRoom(snap);
            if (!castHash && snap.rootCastHash) {
              castHash = snap.rootCastHash;
              castHashRef.current = castHash;
              // First time we learn the anchor: pull persisted pending
              // entries for this thread back into memory so a reload
              // before propagation doesn't drop the user's message.
              if (pendingChatRef.current.length === 0) {
                pendingChatRef.current = loadPendingChat(castHash);
              }
            }
          }
          setParticipants(parts);

          // Chat = direct replies to the host cast. Fetched per tick
          // so a newly-discovered anchor (from the snapshot above) is
          // honoured immediately. Pending optimistic entries are
          // merged in until the server confirms them.
          if (castHash) {
            const chat = await fetchSpaceChat(castHash);
            if (activeIdRef.current !== roomId) return;
            // Backfill missing author pfps. Hypersnap sometimes returns no
            // pfp_url for a sender's own just-posted reply, which would render
            // the placeholder. The live participant list carries each user's
            // Farcaster pfp by fid; the current user's own profile is the
            // authoritative source for their own messages (they may be a
            // listener and not in `parts`).
            const pfpByFid = new Map<number, string>();
            for (const p of parts) {
              const url = p.user.pfp?.url ?? p.user.pfpUrl;
              if (p.user.fid != null && url) pfpByFid.set(p.user.fid, url);
            }
            if (localFid != null && user?.farcaster?.pfpUrl) {
              pfpByFid.set(localFid, user.farcaster.pfpUrl);
            }
            const enriched = chat.map((c) => {
              if (c.author.pfpUrl) return c;
              const url = pfpByFid.get(c.author.fid);
              return url ? { ...c, author: { ...c.author, pfpUrl: url } } : c;
            });
            const remaining = reconcilePending(pendingChatRef.current, chat);
            if (remaining.length !== pendingChatRef.current.length) {
              pendingChatRef.current = remaining;
              savePendingChat(castHash, remaining);
            }
            setChatMessages(mergeChat(enriched, remaining));
          }

          if (localFid != null) {
            const self = parts.find((p) => p.user.fid === localFid);
            if (self && self.role !== prevRoleRef.current) {
              prevRoleRef.current = self.role;
              setRole(self.role);
            }
            if (self && typeof self.handRaised === 'boolean') {
              setHandRaised(self.handRaised);
            }
          }
        } catch {
          // Snapshot failures are non-fatal — the LiveKit audio
          // stream is what carries the experience, this is just
          // metadata.
        }
      };
      void pull();
      roomPollRef.current = setInterval(() => { void pull(); }, ROOM_POLL_INTERVAL_MS);
    };

    const run = async () => {
      try {
        setState('fetching');
        setError(null);

        // Always look up the room first. Scheduled rooms 400 on
        // `/v1/audio-room/join` with "is not live" — we never want
        // that error path to fire for them.
        const snapshot = await fetchAudioRoom(active.id, farcasterAuthToken);
        if (cancelled || activeIdRef.current !== active.id) return;
        if (!snapshot) {
          throw new Error('Room not found');
        }
        setRoom(snapshot);

        if (snapshot.state === 'scheduled') {
          // Preview mode — no LiveKit, no heartbeat. We only poll the
          // snapshot so a scheduled→live transition (host taps Start)
          // can promote the user into the live flow without making
          // them re-tap.
          setState('scheduled');
          const schedPull = async () => {
            if (activeIdRef.current !== active.id) return;
            const next = await fetchAudioRoom(active.id, farcasterAuthToken);
            if (activeIdRef.current !== active.id || !next) return;
            setRoom(next);
            if (next.state === 'live') {
              // Tear down the scheduled poll; the live branch will
              // install its own.
              if (roomPollRef.current) {
                clearInterval(roomPollRef.current);
                roomPollRef.current = null;
              }
              // Re-enter the live path by re-running. The active
              // entry stays the same; the next render will see
              // `room.state === 'live'` and drop us into the live
              // branch via the effect re-run below.
              void run();
            } else if (next.state === 'ended') {
              setState('idle');
            }
          };
          roomPollRef.current = setInterval(() => { void schedPull(); }, ROOM_POLL_INTERVAL_MS);
          return;
        }

        if (snapshot.state === 'ended') {
          setState('error');
          setError('This space has ended');
          return;
        }

        // Live room — proceed with the LiveKit handshake.
        const join = await joinAudioRoom(active.id, farcasterAuthToken);
        if (cancelled || activeIdRef.current !== active.id) return;

        setRoom(join.room);
        setRole(join.role);
        setState('connecting');

        const connected = await connectToSpace(join.wsUrl, join.token, {
          onActiveSpeakersChange: setActiveSpeakerIdentities,
          onReaction: (payload: ReactionPayload) => {
            // Append + auto-purge so the overlay can animate them as a
            // short-lived stream without growing an unbounded array.
            const ev: ReactionEvent = {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              emoji: payload.emoji,
              fid: payload.fid,
              receivedAt: Date.now(),
            };
            setReactions((prev) => [...prev, ev]);
            setTimeout(() => {
              setReactions((prev) => prev.filter((r) => r.id !== ev.id));
            }, REACTION_TTL_MS);
          },
          onDisconnected: () => {
            // The server kicked us — clean up local state but leave the
            // active entry so the overlay can show an "ended" message
            // before the user dismisses.
            setState('idle');
          },
          onLocalVideoChanged: (url) => {
            setLocalCameraStreamURL(url);
            setCameraEnabled(url != null);
          },
          onRemoteVideoAdded: (identity, url) => {
            const fid = fidFromIdentity(identity);
            if (fid == null) return;
            setRemoteVideoStreams((prev) => ({ ...prev, [fid]: url }));
          },
          onRemoteVideoRemoved: (identity) => {
            const fid = fidFromIdentity(identity);
            if (fid == null) return;
            setRemoteVideoStreams((prev) => {
              if (!(fid in prev)) return prev;
              const next = { ...prev };
              delete next[fid];
              return next;
            });
          },
        });
        if (cancelled || activeIdRef.current !== active.id) {
          await connected.disconnect();
          return;
        }
        connectedRef.current = connected;
        setState('connected');

        // Apply the audio-output preference now that WebRTC owns the
        // session. Defaults to loudspeaker so a listener doesn't have to
        // hold the phone to their ear. Fire-and-forget — a failure just
        // leaves the OS default route.
        QuorumCrypto.setSpeakerphoneEnabled(isSpeakerOnRef.current).catch((e) => {
          logger.debug(
            '[AudioSpace] setSpeakerphoneEnabled on connect failed:',
            e instanceof Error ? e.message : e,
          );
        });

        // Server-side keep-alive — `/v1/audio-room/heartbeat` keeps the
        // local participant in the participant list (otherwise we'd be
        // garbage-collected after ~60s and the host's view would show
        // us drop out). We also report the FIDs we're currently
        // hearing so the server-side active-speaker fanout reflects
        // local LiveKit reality.
        // Only host/cohost report active-speaker presence — listeners
        // stay silent and rely on the LiveKit signaling channel to
        // keep their seat. Heartbeating from listeners would just
        // burn requests without changing server-side state.
        const tickHeartbeat = () => {
          if (activeIdRef.current !== active.id) return;
          const currentRole = prevRoleRef.current;
          if (currentRole !== 'host' && currentRole !== 'cohost') return;
          const fids = activeSpeakerIdsRef.current
            .map((id) => fidFromIdentity(id))
            .filter((n): n is number => n !== null);
          heartbeatAudioRoom(active.id, farcasterAuthToken, fids)
            .catch(() => { /* ignore */ });
        };
        heartbeatRef.current = setInterval(tickHeartbeat, HEARTBEAT_INTERVAL_MS);
        tickHeartbeat();

        startLivePoll(active.id, active.castHash);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Failed to join space';
        logger.warn('[AudioSpace] join failed:', msg);
        setError(msg);
        setState('error');
      }
    };

    run();
    return () => {
      cancelled = true;
      // Don't tear down if the effect is just re-running for the same
      // active id (e.g., a parent re-render); only on actual leave do
      // we want to disconnect, which the `leave()` callback handles.
    };
  }, [active, farcasterAuthToken]);

  // ---- Action handlers ---------------------------------------------
  const canPublishLocal = role === 'host' || role === 'cohost' || role === 'speaker';

  const toggleMic = React.useCallback(async () => {
    const connected = connectedRef.current;
    if (!connected || !canPublishLocal) return;
    const next = !micEnabled;
    const applied = await connected.setMicEnabled(next);
    setMicEnabled(applied);
  }, [canPublishLocal, micEnabled]);

  // Swap loudspeaker <-> earpiece. Optimistic: flip the UI immediately and
  // let the native override run async (mirrors SpaceCallContext). A stale
  // icon for a moment beats a laggy control.
  const toggleSpeaker = React.useCallback(() => {
    setIsSpeakerOn((prev) => {
      const next = !prev;
      isSpeakerOnRef.current = next;
      QuorumCrypto.setSpeakerphoneEnabled(next).catch((e) => {
        logger.debug(
          '[AudioSpace] setSpeakerphoneEnabled failed:',
          e instanceof Error ? e.message : e,
        );
      });
      return next;
    });
  }, []);

  const toggleCamera = React.useCallback(async () => {
    const connected = connectedRef.current;
    if (!connected) return { enabled: false, reason: 'not-connected' };
    if (!canPublishLocal) return { enabled: false, reason: 'role-not-allowed-to-publish' };
    const next = !cameraEnabled;
    // The wire-layer (`livekitRoom.setCameraEnabled`) drives the
    // actual setLocalCameraStreamURL + setCameraEnabled state via the
    // onLocalVideoChanged callback we wired in `run()`. We just return
    // its structured result so callers can surface failure reasons.
    // Cameras default to user-facing — we reset to 'user' when
    // turning on so a previously flipped session doesn't preserve the
    // rear lens silently.
    if (next) setLocalCameraFacing('user');
    return connected.setCameraEnabled(next, { facingMode: 'user' });
  }, [canPublishLocal, cameraEnabled]);

  const flipCamera = React.useCallback(async () => {
    const connected = connectedRef.current;
    if (!connected) return;
    const result = await connected.flipCamera();
    if (result) setLocalCameraFacing(result);
  }, []);

  const toggleHand = React.useCallback(async () => {
    if (!active || !farcasterAuthToken) return;
    const next = !handRaised;
    setHandRaised(next);
    try {
      await raiseHandApi(active.id, next, farcasterAuthToken);
    } catch {
      // Roll back on failure.
      setHandRaised((v) => !v);
    }
  }, [active, farcasterAuthToken, handRaised]);

  const acceptStageInvite = React.useCallback(async () => {
    if (!active || !farcasterAuthToken) return;
    try {
      await acceptStageInviteApi(active.id, farcasterAuthToken);
      // Server flips our role to 'speaker' on the next snapshot, which
      // the poll picks up. We also auto-enable the mic so the user
      // doesn't land on a "speaker but silent" state — they can mute
      // afterward via the control bar.
      setTimeout(() => {
        connectedRef.current?.setMicEnabled(true).then((on) => setMicEnabled(on));
      }, 500);
    } catch {
      // No state mutation on failure — keeps the modal visible so the
      // user can retry.
    }
  }, [active, farcasterAuthToken]);

  const declineStageInvite = React.useCallback(async () => {
    if (!active || !farcasterAuthToken) return;
    try {
      await declineStageInviteApi(active.id, farcasterAuthToken);
    } catch { /* ignore */ }
  }, [active, farcasterAuthToken]);

  // Host-action gate. Cohosts share the same write powers as hosts.
  const canHostAct = role === 'host' || role === 'cohost';

  const refreshParticipants = React.useCallback(async () => {
    if (!active || !farcasterAuthToken) return;
    const parts = await listAudioRoomParticipants(active.id, farcasterAuthToken);
    if (activeIdRef.current === active.id) setParticipants(parts);
  }, [active, farcasterAuthToken]);

  const promoteToSpeaker = React.useCallback(async (fid: number) => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      await acceptSpeakerApi(active.id, fid, farcasterAuthToken);
      await refreshParticipants();
    } catch { /* ignore */ }
  }, [active, canHostAct, farcasterAuthToken, refreshParticipants]);

  const cancelStageInvite = React.useCallback(async (fid: number) => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      await cancelStageInviteApi(active.id, fid, farcasterAuthToken);
      await refreshParticipants();
    } catch { /* ignore */ }
  }, [active, canHostAct, farcasterAuthToken, refreshParticipants]);

  const demoteSpeaker = React.useCallback(async (fid: number) => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      await removeSpeakerApi(active.id, fid, farcasterAuthToken);
      await refreshParticipants();
    } catch { /* ignore */ }
  }, [active, canHostAct, farcasterAuthToken, refreshParticipants]);

  const endRoom = React.useCallback(async () => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      await endAudioRoomApi(active.id, farcasterAuthToken);
    } catch { /* ignore */ }
    setActive(null);
    activeIdRef.current = null;
    void teardown();
  }, [active, canHostAct, farcasterAuthToken, teardown]);

  const startScheduled = React.useCallback(async () => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      const updated = await startScheduledAudioRoomApi(active.id, farcasterAuthToken);
      if (updated && activeIdRef.current === active.id) setRoom(updated);
    } catch { /* ignore */ }
  }, [active, canHostAct, farcasterAuthToken]);

  const updateRoom = React.useCallback(async (fields: AudioRoomUpdateFields) => {
    if (!active || !farcasterAuthToken || !canHostAct) return;
    try {
      const updated = await updateAudioRoomApi(active.id, fields, farcasterAuthToken);
      if (updated && activeIdRef.current === active.id) setRoom(updated);
    } catch { /* ignore */ }
  }, [active, canHostAct, farcasterAuthToken]);

  const createSpace = React.useCallback(
    async (fields: AudioRoomCreateFields): Promise<AudioRoom | null> => {
      if (!farcasterAuthToken) return null;
      try {
        const room = await createAudioRoomApi(fields, farcasterAuthToken);
        return room;
      } catch (e) {
        logger.warn('[AudioSpace] createSpace failed:', e instanceof Error ? e.message : e);
        return null;
      }
    },
    [farcasterAuthToken],
  );

  /** Standalone RSVP — does NOT require an active joined room. The
   *  embed card calls this directly for scheduled rooms. */
  const rsvp = React.useCallback(async (roomId: string, rsvped: boolean) => {
    if (!farcasterAuthToken) return;
    try {
      await rsvpAudioRoomApi(roomId, rsvped, farcasterAuthToken);
    } catch { /* ignore */ }
  }, [farcasterAuthToken]);

  /** Minimize the modal so the user can keep using the app while
   *  the audio stream continues. */
  const minimize = React.useCallback(() => setMinimized(true), []);
  const restore = React.useCallback(() => setMinimized(false), []);

  /** Send a chat message into the LiveKit data channel. Receivers
   *  catch it via `RoomEvent.ChatMessage` and our `onChat` wire-up
   *  appends it to `chatMessages`. */
  /** Post a reply to the space's root cast. Optimistically renders
   *  immediately and persists the stub to MMKV so a reload before the
   *  reply propagates doesn't lose it. The cast anchor is read from
   *  `castHashRef` so the discovery-strip path — where we only learn
   *  the anchor after the first room snapshot — works the same as the
   *  cast-embed path. */
  // Shared post path. `parentHash` is the cast being replied to (the host
  // anchor for top-level chat, or a specific chat message's hash for a reply).
  // The pending stub is always persisted under the host anchor so it's part of
  // the space's pending set and reconciles when the poll picks it up.
  const postChatReply = React.useCallback(async (parentHash: string, text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const persistAnchor = castHashRef.current;
    if (!persistAnchor || !farcasterAuthToken || localFid == null) return;

    const pending: PendingChatEntry = {
      hash: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      timestamp: Date.now(),
      parentHash,
      author: {
        fid: localFid,
        username: user?.farcaster?.username,
        // Prefer the explicit displayName from the user profile; fall
        // back to the Farcaster username so we always have something
        // readable. Pfp comes from the Farcaster mirror.
        displayName: user?.displayName ?? user?.farcaster?.username,
        pfpUrl: user?.farcaster?.pfpUrl,
      },
    };
    pendingChatRef.current = [...pendingChatRef.current, pending];
    savePendingChat(persistAnchor, pendingChatRef.current);
    // Surface immediately rather than waiting for the next poll.
    setChatMessages((prev) => [...prev, {
      hash: pending.hash,
      text: pending.text,
      timestamp: pending.timestamp,
      parentHash: pending.parentHash,
      author: pending.author,
    }]);

    try {
      await submitSpaceChatReply(parentHash, trimmed, farcasterAuthToken);
    } catch (e) {
      logger.warn('[AudioSpace] chat send failed:', e instanceof Error ? e.message : e);
      // Drop the pending stub if the send itself errored — there's
      // nothing in flight that will mirror back.
      pendingChatRef.current = pendingChatRef.current.filter((p) => p.hash !== pending.hash);
      savePendingChat(persistAnchor, pendingChatRef.current);
      setChatMessages((prev) => prev.filter((m) => m.hash !== pending.hash));
    }
  }, [farcasterAuthToken, localFid, user?.displayName, user?.farcaster?.username, user?.farcaster?.pfpUrl]);

  const sendChat = React.useCallback((text: string) => {
    const anchor = castHashRef.current;
    if (!anchor) return Promise.resolve();
    return postChatReply(anchor, text);
  }, [postChatReply]);

  /** Reply to a specific chat message (its cast hash becomes the parent). */
  const replyToChat = React.useCallback((targetCastHash: string, text: string) => {
    return postChatReply(targetCastHash, text);
  }, [postChatReply]);

  /** Like/unlike a chat message via the Farcaster API. Optimistic + rollback. */
  const toggleChatLike = React.useCallback(
    async (castHash: string, currentlyLiked: boolean, currentCount: number) => {
      if (!farcasterAuthToken) return;
      const nextLiked = !currentlyLiked;
      const nextCount = nextLiked ? currentCount + 1 : Math.max(0, currentCount - 1);
      setChatLikeStates((prev) => new Map(prev).set(castHash, { liked: nextLiked, count: nextCount }));
      try {
        if (nextLiked) await likeCast({ token: farcasterAuthToken, castHash });
        else await unlikeCast({ token: farcasterAuthToken, castHash });
      } catch {
        setChatLikeStates((prev) =>
          new Map(prev).set(castHash, { liked: currentlyLiked, count: currentCount }),
        );
      }
    },
    [farcasterAuthToken],
  );

  /** Recast/unrecast a chat message via the Farcaster API. Optimistic + rollback. */
  const toggleChatRecast = React.useCallback(
    async (castHash: string, currentlyRecasted: boolean, currentCount: number) => {
      if (!farcasterAuthToken) return;
      const nextRecasted = !currentlyRecasted;
      const nextCount = nextRecasted ? currentCount + 1 : Math.max(0, currentCount - 1);
      setChatRecastStates((prev) =>
        new Map(prev).set(castHash, { recasted: nextRecasted, count: nextCount }),
      );
      try {
        if (nextRecasted) await recastCast({ token: farcasterAuthToken, castHash });
        else await unrecastCast({ token: farcasterAuthToken, castHash });
      } catch {
        setChatRecastStates((prev) =>
          new Map(prev).set(castHash, { recasted: currentlyRecasted, count: currentCount }),
        );
      }
    },
    [farcasterAuthToken],
  );

  /** Toggle RSVP for the currently active scheduled room. Updates the
   *  local flag optimistically and rolls back on failure. */
  const toggleRsvp = React.useCallback(async () => {
    if (!active || !farcasterAuthToken) return;
    const next = !(hasRsvped ?? false);
    setHasRsvped(next);
    try {
      await rsvpAudioRoomApi(active.id, next, farcasterAuthToken);
    } catch {
      setHasRsvped(!next);
    }
  }, [active, farcasterAuthToken, hasRsvped]);

  const reactWith = React.useCallback(async (emoji: string) => {
    if (!active || !farcasterAuthToken) return;
    // Echo locally first so the sender sees their own reaction with no
    // round-trip lag.
    const ev: ReactionEvent = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      emoji,
      receivedAt: Date.now(),
    };
    setReactions((prev) => [...prev, ev]);
    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r.id !== ev.id));
    }, REACTION_TTL_MS);

    // The server is the source of truth: it fans the reaction out to every
    // subscriber over the Farcaster WebSocket (see the effect below). We don't
    // use the LiveKit data channel — a listener can't publish data, so peer
    // fan-out would silently drop their reactions.
    try {
      await sendReactionApi(active.id, emoji, farcasterAuthToken);
    } catch {
      // Server-side failure isn't fatal for the local UX; nothing to
      // roll back since reactions are ephemeral.
    }
  }, [active, farcasterAuthToken]);

  // Receive other participants' reactions via Farcaster's realtime socket.
  // The reaction POST above is broadcast by the server to everyone subscribed
  // to the room; we subscribe for the lifetime of the active space and drop
  // our own fid (already echoed locally in reactWith).
  React.useEffect(() => {
    const roomId = active?.id;
    if (!roomId || !farcasterAuthToken) return;
    const handle = connectSpaceSocket(roomId, farcasterAuthToken, {
      onReaction: (emoji, fid) => {
        if (fid === localFid) return;
        const ev: ReactionEvent = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          emoji,
          fid,
          receivedAt: Date.now(),
        };
        setReactions((prev) => [...prev, ev]);
        setTimeout(() => {
          setReactions((prev) => prev.filter((r) => r.id !== ev.id));
        }, REACTION_TTL_MS);
      },
    });
    return () => handle.close();
  }, [active?.id, farcasterAuthToken, localFid]);

  // Final cleanup on unmount — covers the case where the provider is
  // torn down (logout, hot reload) without the user explicitly leaving.
  React.useEffect(() => {
    return () => {
      void teardown();
    };
  }, [teardown]);

  // Stage-invite signal — the host has flagged us via the per-
  // participant `pendingInvite` record. The overlay surfaces an
  // accept/decline affordance until we act.
  const hasStageInvite = React.useMemo(() => {
    if (role !== 'listener' || localFid == null) return false;
    const self = participants.find((p) => p.user.fid === localFid);
    return Boolean(self?.pendingInvite);
  }, [participants, role, localFid]);

  const value = React.useMemo<AudioSpaceContextValue>(
    () => ({
      active,
      room,
      participants,
      role,
      state,
      error,
      micEnabled,
      handRaised,
      isSpeakerOn,
      activeSpeakerIdentities,
      reactions,
      chatMessages,
      hasStageInvite,
      hasRsvped,
      join,
      leave,
      toggleMic,
      toggleHand,
      toggleSpeaker,
      reactWith,
      acceptStageInvite,
      declineStageInvite,
      promoteToSpeaker,
      cancelStageInvite,
      demoteSpeaker,
      endRoom,
      startScheduled,
      updateRoom,
      rsvp,
      toggleRsvp,
      minimized,
      minimize,
      restore,
      sendChat,
      replyToChat,
      toggleChatLike,
      toggleChatRecast,
      chatLikeStates,
      chatRecastStates,
      cameraEnabled,
      toggleCamera,
      localCameraStreamURL,
      localCameraFacing,
      flipCamera,
      remoteVideoStreams,
      createSpace,
    }),
    [
      active,
      room,
      participants,
      role,
      state,
      error,
      micEnabled,
      handRaised,
      isSpeakerOn,
      activeSpeakerIdentities,
      reactions,
      chatMessages,
      hasStageInvite,
      hasRsvped,
      join,
      leave,
      toggleMic,
      toggleHand,
      toggleSpeaker,
      reactWith,
      acceptStageInvite,
      declineStageInvite,
      promoteToSpeaker,
      cancelStageInvite,
      demoteSpeaker,
      endRoom,
      startScheduled,
      updateRoom,
      rsvp,
      toggleRsvp,
      minimized,
      minimize,
      restore,
      sendChat,
      replyToChat,
      toggleChatLike,
      toggleChatRecast,
      chatLikeStates,
      chatRecastStates,
      cameraEnabled,
      toggleCamera,
      localCameraStreamURL,
      localCameraFacing,
      flipCamera,
      remoteVideoStreams,
      createSpace,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <AudioSpaceOverlay />
    </Ctx.Provider>
  );
}
