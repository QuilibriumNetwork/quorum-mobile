/**
 * Ancestor hydration for feed thread units must be HARD-BOUNDED.
 *
 * ## The property this pins
 *
 * `hooks/useFeedThreadAncestors.ts` walks a reply's parent chain to let the
 * feed render `root … parent reply`. Thread depth is controlled by whoever
 * posted the casts, not by the viewer, so — exactly like the fan-out ceiling
 * pinned by `threadDetailViewFetchBound.test.tsx` — the walk must have a
 * ceiling that a hostile 100-deep thread cannot exceed. The implementation
 * makes the ceiling structural (three chained `useFarcasterCast` slots);
 * this test measures it from the outside: for a depth-10 chain, no more than
 * `MAX_ANCESTOR_FETCHES` distinct cast lookups are ever issued.
 *
 * ## What is mocked, and why
 *
 * `@quilibrium/quorum-shared`'s `useFarcasterCast` — replaced with a
 * synchronous fixture lookup that records every enabled request. The real
 * hook's React Query/hypersnap plumbing is irrelevant to the counting
 * property; a synchronous mock also means the whole chain resolves in one
 * render pass, so the test needs no async choreography.
 */
import { renderHook } from '@testing-library/react-native';
import {
  MAX_ANCESTOR_FETCHES,
  useFeedThreadAncestors,
} from '@/hooks/useFeedThreadAncestors';

// `mock`-prefixed so the hoisted jest.mock factory may close over them.
const mockRequestedHashes: string[] = [];
const mockFixtures: Record<string, MockCast | null> = {};

interface MockCast {
  hash: string;
  parentHash?: string;
  parentAuthor?: { fid: number };
}

jest.mock('@quilibrium/quorum-shared', () => ({
  ...jest.requireActual('@quilibrium/quorum-shared'),
  useFarcasterCast: (
    hash: string | undefined,
    _fid: number | undefined,
    options?: { enabled?: boolean },
  ) => {
    if (hash && options?.enabled !== false) {
      mockRequestedHashes.push(hash);
      return { data: mockFixtures[hash] ?? null };
    }
    return { data: undefined };
  },
}));

/** Install a root-first chain of `depth` casts; returns the tip's seed. */
function installChain(depth: number): { parentHash: string; parentAuthorFid: number } {
  for (const k of Object.keys(mockFixtures)) delete mockFixtures[k];
  let parent: MockCast | undefined;
  for (let i = 0; i < depth; i++) {
    const cast: MockCast = {
      hash: `0xcast${i}`,
      parentHash: parent?.hash,
      parentAuthor: parent ? { fid: 1000 + i - 1 } : undefined,
    };
    mockFixtures[cast.hash] = cast;
    parent = cast;
  }
  // The tip is a NEW cast replying to the deepest installed cast.
  return { parentHash: parent!.hash, parentAuthorFid: 1000 + depth - 1 };
}

beforeEach(() => {
  mockRequestedHashes.length = 0;
});

describe('useFeedThreadAncestors', () => {
  it('never issues more than MAX_ANCESTOR_FETCHES lookups, even at depth 10', () => {
    const seed = installChain(10);
    const { result } = renderHook(() => useFeedThreadAncestors(seed, true));
    expect(new Set(mockRequestedHashes).size).toBeLessThanOrEqual(MAX_ANCESTOR_FETCHES);
    expect(result.current.ancestors.length).toBeLessThanOrEqual(MAX_ANCESTOR_FETCHES);
    expect(result.current.rootKnown).toBe(false); // root is beyond the ceiling
  });

  it('resolves parent-only for a depth-1 reply and knows it found the root', () => {
    const seed = installChain(1);
    const { result } = renderHook(() => useFeedThreadAncestors(seed, true));
    expect(result.current.ancestors.map((c) => c.hash)).toEqual(['0xcast0']);
    expect(result.current.rootKnown).toBe(true);
    expect(new Set(mockRequestedHashes).size).toBe(1);
  });

  it('walks to the root of a depth-3 chain (root, then two replies)', () => {
    const seed = installChain(3);
    const { result } = renderHook(() => useFeedThreadAncestors(seed, true));
    // Nearest first: parent, grandparent, great-grandparent (= root).
    expect(result.current.ancestors.map((c) => c.hash)).toEqual([
      '0xcast2',
      '0xcast1',
      '0xcast0',
    ]);
    expect(result.current.rootKnown).toBe(true);
  });

  it('truncates at the first unresolved level — no holes in the chain', () => {
    const seed = installChain(3);
    mockFixtures['0xcast1'] = null; // grandparent lookup fails
    const { result } = renderHook(() => useFeedThreadAncestors(seed, true));
    expect(result.current.ancestors.map((c) => c.hash)).toEqual(['0xcast2']);
    // 0xcast2 is itself a reply, so the conversation continues above.
    expect(result.current.rootKnown).toBe(false);
  });

  it('fetches nothing when disabled (self-chains hydrate no ancestors)', () => {
    const seed = installChain(5);
    const { result } = renderHook(() => useFeedThreadAncestors(seed, false));
    expect(mockRequestedHashes).toHaveLength(0);
    expect(result.current.ancestors).toEqual([]);
  });

  it('fetches nothing for a non-reply or a URL-parent cast', () => {
    const { result } = renderHook(() =>
      useFeedThreadAncestors({ parentHash: undefined, parentAuthorFid: undefined }, true),
    );
    expect(mockRequestedHashes).toHaveLength(0);
    expect(result.current.ancestors).toEqual([]);
    expect(result.current.rootKnown).toBe(false);
  });

  it('fetches nothing when the parent fid is unknown (hypersnap needs it)', () => {
    const { result } = renderHook(() =>
      useFeedThreadAncestors({ parentHash: '0xsomewhere', parentAuthorFid: 0 }, true),
    );
    expect(mockRequestedHashes).toHaveLength(0);
    expect(result.current.ancestors).toEqual([]);
  });
});
