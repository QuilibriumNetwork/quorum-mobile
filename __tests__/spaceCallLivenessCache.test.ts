/**
 * The memo behind the space-call banner's liveness probe.
 *
 * This is the stateful half of the banner fix, and the half that fails
 * quietly: a cache that holds a wrong verdict too long hides a joinable call,
 * and one that holds nothing turns a scroll through a channel's history into a
 * request per bubble per pass. Neither is visible on a phone.
 *
 * The probe is injected here, so these tests assert the caching rules
 * themselves and never touch the network.
 */
import {
  fetchLiveness,
  peekLiveness,
  resetLivenessCache,
  LIVENESS_TTL_MS,
} from '../services/calling/livenessCache';
import type { SpaceCallLiveness } from '../services/calling/spaceCallStatus';

const CALL = 'QmCallerA-1700000000000-ab12cd';
const NOW = 1_700_000_000_000;

/** A probe that records its calls and resolves when told to. */
function makeProbe(value: SpaceCallLiveness) {
  const calls: string[] = [];
  let release!: (v: SpaceCallLiveness) => void;
  const gate = new Promise<SpaceCallLiveness>((resolve) => {
    release = resolve;
  });
  return {
    calls,
    release: () => release(value),
    fn: (callId: string) => {
      calls.push(callId);
      return gate;
    },
  };
}

beforeEach(() => {
  resetLivenessCache();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('peekLiveness', () => {
  it('knows nothing before anything has been asked', () => {
    expect(peekLiveness(CALL)).toBe('unknown');
  });

  it('knows nothing about a bubble with no call id', () => {
    expect(peekLiveness(undefined)).toBe('unknown');
  });

  it('does not mutate, so repeated reads during render agree', () => {
    // React can invoke a render twice. If peek pruned expired entries as a
    // side effect, the second pass could see a different answer than the first.
    const probe = makeProbe('gone');
    const pending = fetchLiveness(CALL, probe.fn);
    probe.release();
    return pending.then(() => {
      jest.setSystemTime(NOW + LIVENESS_TTL_MS.gone + 1);
      expect(peekLiveness(CALL)).toBe('unknown');
      expect(peekLiveness(CALL)).toBe('unknown');
    });
  });
});

describe('fetchLiveness', () => {
  it('asks the probe when nothing is known', async () => {
    const probe = makeProbe('live');
    const pending = fetchLiveness(CALL, probe.fn);
    probe.release();
    await expect(pending).resolves.toBe('live');
    expect(probe.calls).toEqual([CALL]);
  });

  it('serves a cached answer without asking again', async () => {
    const first = makeProbe('gone');
    const pending = fetchLiveness(CALL, first.fn);
    first.release();
    await pending;

    const second = makeProbe('live');
    await expect(fetchLiveness(CALL, second.fn)).resolves.toBe('gone');
    expect(second.calls).toEqual([]);
  });

  it('collapses concurrent asks for the same call into one request', async () => {
    // The real trigger: several bubbles for the same call mount in the same
    // frame, or a row remounts mid-flight.
    const probe = makeProbe('live');
    const a = fetchLiveness(CALL, probe.fn);
    const b = fetchLiveness(CALL, probe.fn);
    const c = fetchLiveness(CALL, probe.fn);
    probe.release();

    await expect(Promise.all([a, b, c])).resolves.toEqual(['live', 'live', 'live']);
    expect(probe.calls).toEqual([CALL]);
  });

  it('asks again for a different call', async () => {
    const probe = makeProbe('gone');
    const pending = Promise.all([
      fetchLiveness(CALL, probe.fn),
      fetchLiveness('other-call-id', probe.fn),
    ]);
    probe.release();
    await pending;
    expect(probe.calls).toEqual([CALL, 'other-call-id']);
  });

  describe('a live answer goes stale quickly — the room can die any moment', () => {
    it('stops serving the cached value once its ttl passes', async () => {
      const first = makeProbe('live');
      const pending = fetchLiveness(CALL, first.fn);
      first.release();
      await pending;

      jest.setSystemTime(NOW + LIVENESS_TTL_MS.live + 1);
      expect(peekLiveness(CALL)).toBe('unknown');

      const second = makeProbe('gone');
      const refetch = fetchLiveness(CALL, second.fn);
      second.release();
      await expect(refetch).resolves.toBe('gone');
      expect(second.calls).toEqual([CALL]);
    });

    it('still serves it just before the ttl passes', async () => {
      const probe = makeProbe('live');
      const pending = fetchLiveness(CALL, probe.fn);
      probe.release();
      await pending;

      jest.setSystemTime(NOW + LIVENESS_TTL_MS.live - 1);
      expect(peekLiveness(CALL)).toBe('live');
    });
  });

  describe('a gone answer is held longer — call ids are never reused', () => {
    it('outlives the live ttl', async () => {
      const probe = makeProbe('gone');
      const pending = fetchLiveness(CALL, probe.fn);
      probe.release();
      await pending;

      jest.setSystemTime(NOW + LIVENESS_TTL_MS.live + 1);
      expect(peekLiveness(CALL)).toBe('gone');
    });

    it('but still ages out, so a wrong verdict cannot pin a bubble forever', async () => {
      const probe = makeProbe('gone');
      const pending = fetchLiveness(CALL, probe.fn);
      probe.release();
      await pending;

      jest.setSystemTime(NOW + LIVENESS_TTL_MS.gone + 1);
      expect(peekLiveness(CALL)).toBe('unknown');
    });
  });

  describe('an unreachable probe is never cached', () => {
    it('leaves nothing behind, so the next attempt really re-asks', async () => {
      const first = makeProbe('unknown');
      const pending = fetchLiveness(CALL, first.fn);
      first.release();
      await expect(pending).resolves.toBe('unknown');
      expect(peekLiveness(CALL)).toBe('unknown');

      const second = makeProbe('live');
      const retry = fetchLiveness(CALL, second.fn);
      second.release();
      await expect(retry).resolves.toBe('live');
      expect(second.calls).toEqual([CALL]);
    });

    it('clears a previously cached answer rather than keeping a stale one', async () => {
      const first = makeProbe('live');
      const cached = fetchLiveness(CALL, first.fn);
      first.release();
      await cached;

      // Force past the live ttl so the next fetch actually runs the probe.
      jest.setSystemTime(NOW + LIVENESS_TTL_MS.live + 1);
      const second = makeProbe('unknown');
      const pending = fetchLiveness(CALL, second.fn);
      second.release();
      await pending;

      expect(peekLiveness(CALL)).toBe('unknown');
    });
  });
});
