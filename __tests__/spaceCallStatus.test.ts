/**
 * What a space-call banner should say, given what we actually know.
 *
 * The bug this exists for: the banner was derived from chat messages alone —
 * a `space-call-start` with no matching `space-call-end` rendered "call in
 * progress" with a live ticking timer and a Join button, forever. Nothing ever
 * asked whether the call still existed. One failed start (and in production
 * every start fails, see the issue) minted a banner no one could ever clear.
 *
 * The branches below are all invisible from the UI — you cannot tell by looking
 * at a phone whether "unavailable" came from a confirmed-dead room or from a
 * fetch that timed out. That asymmetry is the whole reason this logic is a pure
 * function with tests rather than an `if` inside a component.
 *
 * The rule that matters most: **unknown is not dead.** A probe we could not
 * complete (offline, server hiccup) must never be rendered as "this call is
 * over" — that would hide a real, joinable call from someone on a flaky train
 * connection. Only a room the server actively denies is dead.
 */
import {
  deriveSpaceCallStatus,
  SPACE_CALL_GRACE_MS,
  SPACE_CALL_STALE_MS,
} from '../services/calling/spaceCallStatus';

const START = 1_700_000_000_000;

/** `startedAt` fixed, `now` expressed as an offset from it — reads like the timeline. */
const at = (offsetMs: number) => START + offsetMs;

describe('deriveSpaceCallStatus', () => {
  describe('being in the call outranks everything else', () => {
    it('stays live even when an end message says otherwise', () => {
      // Any participant leaving announces the end today, so this fires while
      // the rest of the room is still talking. Collapsing the banner under
      // someone who is mid-sentence is the worst possible reading of it.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        endedAt: at(60_000),
        selfInCall: true,
        now: at(120_000),
      });
      expect(status.state).toBe('live');
      expect(status.reason).toBe('self-in-call');
    });

    it('stays live when the probe cannot find the room', () => {
      // Our own open connection is better evidence than a failed lookup.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        selfInCall: true,
        now: at(10 * 60_000),
      });
      expect(status.state).toBe('live');
    });

    it('stays live past the staleness cutoff — a long call is still a call', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        selfInCall: true,
        now: at(SPACE_CALL_STALE_MS + 60_000),
      });
      expect(status.state).toBe('live');
    });

    it('is not joinable and needs no probe — we are already in it', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        selfInCall: true,
        now: at(120_000),
      });
      expect(status.joinable).toBe(false);
      expect(status.shouldProbe).toBe(false);
    });
  });

  describe('an explicit end message is authoritative', () => {
    it('reports ended even while the room still probes live', () => {
      // A live room plus an end message happens today because ANY participant
      // leaving announces the end (see F4 in the issue). Resurrecting the
      // banner from the probe would make it flap between ended and live at the
      // end of every call, which is worse than the premature end it would fix.
      // The end-semantics fix belongs upstream, not here.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        endedAt: at(60_000),
        liveness: 'live',
        now: at(120_000),
      });
      expect(status.state).toBe('ended');
      expect(status.reason).toBe('end-message');
      expect(status.joinable).toBe(false);
    });

    it('reports ended when the call is still inside the grace window', () => {
      // A very short call — started and ended within the grace window. Grace
      // must not override a real end message.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        endedAt: at(5_000),
        liveness: 'unknown',
        now: at(10_000),
      });
      expect(status.state).toBe('ended');
    });

    it('stops probing once ended — nothing left to learn', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        endedAt: at(60_000),
        now: at(120_000),
      });
      expect(status.shouldProbe).toBe(false);
    });
  });

  describe('a confirmed-live room is joinable', () => {
    it('reports live long after the grace window has passed', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'live',
        now: at(45 * 60_000),
      });
      expect(status.state).toBe('live');
      expect(status.reason).toBe('room-confirmed-live');
      expect(status.joinable).toBe(true);
    });

    it('keeps probing a live call so it flips when the room dies', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'live',
        now: at(45 * 60_000),
      });
      expect(status.shouldProbe).toBe(true);
    });
  });

  describe('the grace window covers a call that has not finished starting', () => {
    it('reports live when the room is not there YET', () => {
      // The starter's own `sfu/join` has not completed, or the start message
      // reached this device before the room existed. Rendering "unavailable"
      // here would flash a dead banner on every healthy call.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        now: at(5_000),
      });
      expect(status.state).toBe('live');
      expect(status.reason).toBe('within-grace');
      expect(status.joinable).toBe(true);
    });

    it('holds at the exact edge of the window, then gives up one ms later', () => {
      const onEdge = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        now: at(SPACE_CALL_GRACE_MS),
      });
      expect(onEdge.state).toBe('live');

      const pastEdge = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        now: at(SPACE_CALL_GRACE_MS + 1),
      });
      expect(pastEdge.state).toBe('unavailable');
    });

    it('survives a clock that puts the start in the future', () => {
      // Message timestamps come from other devices. A peer whose clock runs
      // ahead must not produce a negative elapsed that trips the stale branch.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        now: at(-90_000),
      });
      expect(status.state).toBe('live');
    });
  });

  describe('a room the server denies is over', () => {
    it('reports unavailable, not joinable, past the grace window', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        now: at(10 * 60_000),
      });
      expect(status.state).toBe('unavailable');
      expect(status.reason).toBe('room-gone');
      expect(status.joinable).toBe(false);
    });

    it('stops probing — a dead room does not come back', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'gone',
        now: at(10 * 60_000),
      });
      expect(status.shouldProbe).toBe(false);
    });
  });

  describe('an unreachable probe is not a dead call', () => {
    it('keeps a recent call joinable when liveness cannot be determined', () => {
      // Offline, or the request failed. The user can still tap Join; if it
      // fails they get a toast. Declaring the call over on our own guess would
      // hide a real one.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        now: at(10 * 60_000),
      });
      expect(status.state).toBe('live');
      expect(status.reason).toBe('liveness-unknown');
      expect(status.joinable).toBe(true);
    });

    it('treats a never-probed call the same as an unreachable one', () => {
      // First render, before the probe resolves. Omitting `liveness` entirely
      // must behave like 'unknown', never like 'gone'.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        now: at(10 * 60_000),
      });
      expect(status.state).toBe('live');
      expect(status.reason).toBe('liveness-unknown');
    });

    it('gives up once the call is implausibly old', () => {
      // The offline fallback cannot run forever, or a zombie from last week
      // still shows a ticking timer to someone with no connection.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        now: at(SPACE_CALL_STALE_MS),
      });
      expect(status.state).toBe('unavailable');
      expect(status.reason).toBe('stale-no-end');
      expect(status.joinable).toBe(false);
    });

    it('does not probe a call already past the staleness cutoff', () => {
      // Scrolling back through a channel full of historical zombies must not
      // fire a request per bubble — time alone settles those.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        now: at(SPACE_CALL_STALE_MS + 60_000),
      });
      expect(status.shouldProbe).toBe(false);
    });

    it('still probes a call inside the cutoff', () => {
      const status = deriveSpaceCallStatus({
        startedAt: START,
        liveness: 'unknown',
        now: at(10 * 60_000),
      });
      expect(status.shouldProbe).toBe(true);
    });
  });

  describe('the zombie banner this was written for', () => {
    it('renders a failed start as unavailable instead of forever-in-progress', () => {
      // The exact reported repro: a start message was broadcast, the join
      // 404'd, no end message was ever sent, and the banner outlived the app.
      // Before this function, the same inputs produced "call in progress" with
      // a running timer and a Join button, indefinitely.
      const status = deriveSpaceCallStatus({
        startedAt: START,
        endedAt: undefined,
        liveness: 'gone',
        now: at(3 * 60 * 60_000),
      });
      expect(status.state).toBe('unavailable');
      expect(status.joinable).toBe(false);
      expect(status.shouldProbe).toBe(false);
    });
  });
});
