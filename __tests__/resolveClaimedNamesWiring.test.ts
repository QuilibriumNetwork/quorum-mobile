/**
 * Mobile's configuration must actually reach the shared QNS transport.
 *
 * ## The one unguarded link, until this file existed
 *
 * `resolveClaimedNames` is a four-line function, and every other test in the
 * suite mocks it away — they all stub `@/services/api/qnsClient` at the module
 * boundary, so the real body never runs. That made this the single point in the
 * whole claim-verification chain where a regression shipped silently.
 *
 * MEASURED in independent review: deleting `baseUrl: QNS_API_BASE_URL` from the
 * call produced ZERO failures across all 1189 tests. The bug its own docstring
 * warns about was completely undetectable.
 *
 * ## Why the base URL is worth a test of its own
 *
 * Mobile REGISTERS names through its own client, which honours
 * `EXPO_PUBLIC_QNS_API_URL` (`app.config.js` -> `expo-constants`). Verification
 * goes through shared, which defaults to production. If the override stops
 * flowing, a non-production build registers a name against one resolver and
 * verifies it against another — so every name a tester registers silently fails
 * to verify, and the feature looks broken rather than misconfigured. Nothing in
 * either code path says so.
 *
 * ## Why the signal is here too
 *
 * Same shape of gap: `useVerifiedQnsNames` passes React Query's `signal` in, and
 * the hook-level tests prove the hook passes it to THIS function, but nothing
 * proved this function passes it onward. React Query only cancels a fetch whose
 * queryFn consumed the signal, so a drop here would silently un-do the
 * cancellation behaviour that `claimRecordsAbortSupersededLookup.test.tsx`
 * believes it is testing.
 *
 * Both halves are asserted against a NON-production URL, so a regression that
 * fell back to the production default is caught rather than looking correct.
 */

/** A resolver that is deliberately not the production one, standing in for a
 *  staging build with `EXPO_PUBLIC_QNS_API_URL` set. */
const OVERRIDE_URL = 'https://names.staging.invalid';

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { qnsApiUrl: 'https://names.staging.invalid' } } },
}));

const mockResolveNamesBatch = jest.fn();

// Only `resolveNamesBatch` is stubbed because it is the only thing
// `qnsClient.ts` imports from shared — verified, not assumed. Stubbing the
// whole barrel would otherwise hide an added import behind an `undefined`.
jest.mock('@quilibrium/quorum-shared', () => ({
  resolveNamesBatch: (...args: unknown[]) => mockResolveNamesBatch(...args),
}));

import { resolveClaimedNames } from '@/services/api/qnsClient';

beforeEach(() => {
  mockResolveNamesBatch.mockReset();
  mockResolveNamesBatch.mockResolvedValue({});
});

describe('resolveClaimedNames — the wiring into the shared transport', () => {
  it("sends mobile's configured base URL, not shared's production default", async () => {
    await resolveClaimedNames(['alice']);

    expect(mockResolveNamesBatch).toHaveBeenCalledTimes(1);
    const [, opts] = mockResolveNamesBatch.mock.calls[0];
    expect(opts.baseUrl).toBe(OVERRIDE_URL);
  });

  it('passes the abort signal through', async () => {
    const controller = new AbortController();

    await resolveClaimedNames(['alice'], { signal: controller.signal });

    const [, opts] = mockResolveNamesBatch.mock.calls[0];
    expect(opts.signal).toBe(controller.signal);
  });

  it('forwards the names it was given', async () => {
    await resolveClaimedNames(['alice', 'bob']);

    const [names] = mockResolveNamesBatch.mock.calls[0];
    expect(names).toEqual(['alice', 'bob']);
  });

  it('hands shared a mutable copy rather than the caller’s array', async () => {
    // `resolveNamesBatch` takes `string[]`, and callers pass a memoised array
    // that feeds React Query's key. Handing over the same reference would let a
    // dependency mutate a value this app treats as stable.
    const names = ['alice'];

    await resolveClaimedNames(names);

    const [passed] = mockResolveNamesBatch.mock.calls[0];
    expect(passed).toEqual(names);
    expect(passed).not.toBe(names);
  });

  it('leaves the deadline to shared, so the value is defined in ONE place', async () => {
    // Deliberately absent, not forgotten. Shared's default is the same 30s this
    // client has always used; passing it here would pin the number in a second
    // place and let the two drift. If this ever starts being sent explicitly,
    // that should be a decision, not an accident.
    await resolveClaimedNames(['alice']);

    const [, opts] = mockResolveNamesBatch.mock.calls[0];
    expect(opts.timeoutMs).toBeUndefined();
  });

  it('returns exactly what the transport answered, without reshaping it', async () => {
    // The records are consumed by key elsewhere; a wrapper that helpfully
    // converted the container would break every read site at once.
    const answer = { alice: { address: '0xrecord', resolveKey: 'ab', metadata: null } };
    mockResolveNamesBatch.mockResolvedValue(answer);

    await expect(resolveClaimedNames(['alice'])).resolves.toBe(answer);
  });

  it('lets a transport failure reject rather than reporting nobody as an owner', async () => {
    // `useClaimRecords` caches for an hour and does not retry, so a swallowed
    // error would pin "nobody owns anything" for that hour. Rejecting caches
    // nothing.
    mockResolveNamesBatch.mockRejectedValue(new Error('offline'));

    await expect(resolveClaimedNames(['alice'])).rejects.toThrow('offline');
  });
});
