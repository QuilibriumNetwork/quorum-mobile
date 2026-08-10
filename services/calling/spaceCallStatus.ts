/**
 * What a space-call banner should say, given what we actually know.
 *
 * A space call is announced to a channel as a `space-call-start` chat message
 * and closed with a matching `space-call-end`. The banner used to be derived
 * from those two messages alone, which quietly assumed the end message always
 * arrives. It does not: a start whose join fails, a last participant who
 * crashes, or an SFU that drops the room all leave a start with no end — and
 * the channel then showed "call in progress", with a running timer and a Join
 * button, forever.
 *
 * So the end message is treated as one input among three: the messages, a
 * liveness probe against the SFU, and the clock. Kept pure and separate from
 * the component so each branch can be tested — none of them is observable by
 * looking at a phone.
 */

/**
 * What a room-liveness probe found.
 *
 * `gone` and `unknown` are deliberately different answers. `gone` is the
 * server telling us the room is not there; `unknown` is us failing to ask
 * (offline, timeout, 5xx). Collapsing them would render a real, joinable call
 * as "over" whenever the network hiccups — the failure mode this whole module
 * exists to avoid, one level down.
 */
export type SpaceCallLiveness = 'live' | 'gone' | 'unknown';

/** What the bubble should render. */
export type SpaceCallState =
  /** A `space-call-end` message exists. Show a static summary with duration. */
  | 'ended'
  /** Believed joinable. Show the "in progress" bubble with a live timer. */
  | 'live'
  /**
   * No end message, but the call is not live. Show a static "unavailable"
   * summary with NO duration — we know it is over, not when it ended.
   */
  | 'unavailable';

/** Why {@link deriveSpaceCallStatus} decided what it did. Diagnostics and tests. */
export type SpaceCallStatusReason =
  | 'self-in-call'
  | 'end-message'
  | 'room-confirmed-live'
  | 'within-grace'
  | 'liveness-unknown'
  | 'room-gone'
  | 'stale-no-end';

export interface SpaceCallStatus {
  state: SpaceCallState;
  reason: SpaceCallStatusReason;
  /** Whether to offer Join. */
  joinable: boolean;
  /** Whether the caller should (keep) probing room liveness. */
  shouldProbe: boolean;
}

/**
 * How long after the start message we keep presenting a call as live without
 * confirmation.
 *
 * The room does not exist the instant the message does: the starter's own
 * `sfu/join` is still in flight, and other members receive the message over
 * the relay some seconds later. Without this window every healthy call would
 * flash "unavailable" on first paint.
 */
export const SPACE_CALL_GRACE_MS = 60_000;

/**
 * How old a start message can be before we call it over on the clock alone,
 * without a probe.
 *
 * This is only reached when liveness is `unknown` — i.e. we could not ask. It
 * bounds the offline fallback so a zombie from last week does not show a
 * ticking timer to someone with no connection.
 *
 * Trade-off, deliberately taken: past this cutoff we stop probing entirely, so
 * a genuinely continuous call running longer than 12 hours would be shown as
 * unavailable to someone who has not already probed it. That is judged far
 * less likely than the alternative cost — scrolling a channel full of
 * historical calls firing a request per bubble, forever, to re-learn what the
 * clock already implies.
 */
export const SPACE_CALL_STALE_MS = 12 * 60 * 60 * 1000;

export interface DeriveSpaceCallStatusInput {
  /** Timestamp (ms) of the `space-call-start` message. */
  startedAt: number;
  /** Timestamp (ms) of the matching `space-call-end`, if one has arrived. */
  endedAt?: number | null;
  /** Latest probe result. Omitted means "not probed yet" — same as `unknown`. */
  liveness?: SpaceCallLiveness;
  /**
   * Whether THIS device is currently in this call. Ground truth, not inference:
   * our own call context has an open peer connection to the room. Outranks
   * every other input, including an end message (which any participant's leave
   * emits today) and a probe that failed.
   */
  selfInCall?: boolean;
  /** Current wall clock (ms). Injected so the branches are testable. */
  now: number;
}

export function deriveSpaceCallStatus(
  input: DeriveSpaceCallStatusInput,
): SpaceCallStatus {
  const { startedAt, endedAt, liveness = 'unknown', selfInCall = false, now } = input;

  // Message timestamps come from other devices, so a peer whose clock runs
  // ahead can put the start in the future. Clamp rather than let a negative
  // elapsed fall through the age comparisons.
  const elapsed = Math.max(0, now - startedAt);

  const reason = ((): SpaceCallStatusReason => {
    // We are in the call. Nothing we could read from a message or a probe is
    // better evidence than an open connection, and rendering "ended" or
    // "unavailable" under someone who is actively talking would be absurd.
    if (selfInCall) return 'self-in-call';
    // An explicit end wins over everything, including a probe that still says
    // live. Today ANY participant leaving announces the end, so live-plus-ended
    // is a state that really occurs; resurrecting the banner from the probe
    // would make it flap at the end of every call. Fixing WHO announces the end
    // is a protocol change that belongs upstream, not a render-time guess.
    if (endedAt != null) return 'end-message';
    if (liveness === 'live') return 'room-confirmed-live';
    // Checked before `gone`: during the grace window "not there" means "not
    // there yet".
    if (elapsed <= SPACE_CALL_GRACE_MS) return 'within-grace';
    if (liveness === 'gone') return 'room-gone';
    if (elapsed >= SPACE_CALL_STALE_MS) return 'stale-no-end';
    // Could not ask, and the call is recent enough to still be real. Leave it
    // joinable: a join that fails surfaces a toast, whereas hiding a live call
    // leaves the user no way to discover it.
    return 'liveness-unknown';
  })();

  const state: SpaceCallState =
    reason === 'end-message'
      ? 'ended'
      : reason === 'room-gone' || reason === 'stale-no-end'
        ? 'unavailable'
        : 'live';

  return {
    state,
    reason,
    // Being in the call is the one live state you cannot join — the bubble
    // shows in-call controls there instead of a Join button. Same reason it
    // needs no probe: our own connection already answers the question.
    joinable: state === 'live' && reason !== 'self-in-call',
    shouldProbe: state === 'live' && reason !== 'self-in-call',
  };
}
