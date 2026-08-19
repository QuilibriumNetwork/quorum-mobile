/**
 * The reveal ledger: "I have deliberately messaged this partner at least
 * once." It is the ONE predicate every identity emission consults, and it
 * fails CLOSED — a storage error means "do not reveal", the opposite posture
 * from the send-gates (where a redundant push is harmless and they fail
 * open). Both postures are deliberate; do not unify them.
 */
import {
  hasRevealedTo,
  recordReveal,
  clearReveal,
  messagesContainSelfAuthored,
  ensureRevealBootstrap,
} from '../services/dm/dmRevealLedger';

const SELF = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz';
const PARTNER = 'QmThemThemVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzz';

afterEach(() => clearReveal(SELF));

describe('ledger basics', () => {
  it('is unset by default and set after recordReveal', () => {
    expect(hasRevealedTo(SELF, PARTNER)).toBe(false);
    recordReveal(SELF, PARTNER, 1_000);
    expect(hasRevealedTo(SELF, PARTNER)).toBe(true);
  });

  it('is scoped per (self, partner)', () => {
    recordReveal(SELF, PARTNER, 1_000);
    expect(hasRevealedTo(SELF, 'QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz')).toBe(false);
    expect(hasRevealedTo('QmPeerAEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz', PARTNER)).toBe(false);
  });

  it('clearReveal(self, partner) unsets one; clearReveal(self) unsets all of self', () => {
    recordReveal(SELF, PARTNER, 1_000);
    clearReveal(SELF, PARTNER);
    expect(hasRevealedTo(SELF, PARTNER)).toBe(false);
  });
});

describe('messagesContainSelfAuthored (pure bootstrap predicate)', () => {
  it('finds a self-authored message', () => {
    const msgs = [
      { content: { senderId: PARTNER } },
      { content: { senderId: SELF } },
    ];
    expect(messagesContainSelfAuthored(msgs, SELF)).toBe(true);
  });
  it('is false for inbound-only history (a stranger who messaged us)', () => {
    expect(messagesContainSelfAuthored([{ content: { senderId: PARTNER } }], SELF)).toBe(false);
    expect(messagesContainSelfAuthored([], SELF)).toBe(false);
  });
});

describe('ensureRevealBootstrap', () => {
  it('derives a reveal from history exactly once, then serves the ledger', async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [{ content: { senderId: SELF } }],
    });
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
    expect(getMessages).toHaveBeenCalledTimes(1); // second call hit the ledger
  });

  it('stays false (and does NOT persist a negative) for inbound-only history', async () => {
    const getMessages = jest.fn().mockResolvedValue({
      messages: [{ content: { senderId: PARTNER } }],
    });
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(false);
    // A later reply can still flip it — negative is never persisted.
    recordReveal(SELF, PARTNER, 2_000);
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(true);
  });

  it('fails CLOSED when the history read throws', async () => {
    const getMessages = jest.fn().mockRejectedValue(new Error('db closed'));
    expect(await ensureRevealBootstrap(SELF, PARTNER, getMessages)).toBe(false);
  });
});

/**
 * The suite above never exercises the module's own storage-level try/catch:
 * `__mocks__/react-native-mmkv.js` wraps a plain Map whose methods never
 * throw, so `hasRevealedTo`'s and `recordReveal`'s catch branches are dead
 * code from the harness's point of view — an untested assertion that passes
 * either way. Each test here swaps in a store that genuinely throws, using
 * `jest.doMock` + `jest.isolateModules` to get a fresh module instance (the
 * ledger caches its store in a lazy singleton, so the throwing store has to
 * be in place before that module's first use — reusing the already-imported
 * `hasRevealedTo` etc. from the top of this file would just hit the
 * never-throwing automock again).
 */
describe('fail-closed under a store that genuinely throws', () => {
  afterEach(() => {
    jest.dontMock('react-native-mmkv');
    jest.resetModules();
  });

  it('hasRevealedTo returns false when the store read throws', () => {
    jest.resetModules();
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () => {
          throw new Error('mmkv read failed');
        },
        set: () => {},
        remove: () => {},
        getAllKeys: () => [],
      }),
    }));
    let fresh: typeof import('../services/dm/dmRevealLedger');
    jest.isolateModules(() => {
      fresh = require('../services/dm/dmRevealLedger');
    });
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(false);
  });

  it('recordReveal swallows a throwing write and still memoizes true for the session', () => {
    jest.resetModules();
    // getString always reports "nothing stored" — the write genuinely never
    // lands, so a `true` answer below can only come from the in-memory memo,
    // not from a lucky read-after-write.
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () => undefined,
        set: () => {
          throw new Error('mmkv write failed');
        },
        remove: () => {},
        getAllKeys: () => [],
      }),
    }));
    let fresh: typeof import('../services/dm/dmRevealLedger');
    jest.isolateModules(() => {
      fresh = require('../services/dm/dmRevealLedger');
    });
    expect(() => fresh!.recordReveal(SELF, PARTNER, 1_000)).not.toThrow();
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(true);
  });

  it('a throwing read is not memoized: a later successful read still returns the true answer', () => {
    jest.resetModules();
    let calls = 0;
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        // First read is a transient failure; the value is genuinely there
        // (as if a prior session wrote it) from the second read onward.
        getString: () => {
          calls += 1;
          if (calls === 1) throw new Error('transient mmkv failure');
          return JSON.stringify({ at: 1 });
        },
        set: () => {},
        remove: () => {},
        getAllKeys: () => [],
      }),
    }));
    let fresh: typeof import('../services/dm/dmRevealLedger');
    jest.isolateModules(() => {
      fresh = require('../services/dm/dmRevealLedger');
    });
    // Fails closed on the transient throw, and — the point of this test —
    // does NOT cache that false, or the second call below could never recover.
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(false);
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(true);
  });
});

/**
 * Finding 1: a plain `${self}:${partner}` key is not injective over
 * arbitrary strings — self="A", partner="B:C" and self="A:B", partner="C"
 * both produced "A:B:C". Not exploitable with real base58 addresses (they
 * exclude ':'), but nothing enforced that, and Tasks 5-7 route
 * caller-supplied strings through this module. The test below is written to
 * PASS under the current (JSON-array) key encoding and FAIL under the old
 * template — see the RED proof in the fix report for the reverted-and-run
 * evidence.
 */
describe('key collision safety', () => {
  afterEach(() => {
    clearReveal('A');
    clearReveal('A:B');
  });

  it('two pairs that would collide under a naive `self:partner` key do not contaminate each other', () => {
    recordReveal('A', 'B:C', 1_000);
    expect(hasRevealedTo('A', 'B:C')).toBe(true);
    // Under the old `${self}:${partner}` template both pairs key to
    // "A:B:C" — this would read true here too, for a partner who never
    // received or sent anything.
    expect(hasRevealedTo('A:B', 'C')).toBe(false);
  });

  it('treats an empty self or partner as unusable: hasRevealedTo fails closed and recordReveal refuses to write', () => {
    expect(hasRevealedTo('', PARTNER)).toBe(false);
    expect(hasRevealedTo(SELF, '')).toBe(false);
    recordReveal('', PARTNER, 1_000);
    expect(hasRevealedTo('', PARTNER)).toBe(false); // still false — the write was refused, not merely unread
  });

  it('clearReveal with a malformed (empty) self is a no-op and does not touch other selfs\' real records', () => {
    recordReveal(SELF, PARTNER, 1_000);
    clearReveal(''); // malformed self, no partner — would sweep by prefix if not guarded
    expect(hasRevealedTo(SELF, PARTNER)).toBe(true); // untouched
  });
});

/**
 * Finding 2: recordReveal's catch previously swallowed a durable-write
 * failure with no signal at all. A systematic MMKV failure would otherwise
 * silently degrade every device to bootstrap-only reveals forever. The
 * warning must identify which partner without logging their raw address —
 * debug logs get pasted into issues and chats, and an address is identity-
 * bearing data.
 */
describe('write-failure telemetry', () => {
  afterEach(() => {
    jest.dontMock('react-native-mmkv');
    jest.resetModules();
  });

  it('logs a truncated-address warning, never the raw address, when the write throws', () => {
    jest.resetModules();
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () => undefined,
        set: () => {
          throw new Error('mmkv write failed');
        },
        remove: () => {},
        getAllKeys: () => [],
      }),
    }));
    let fresh: typeof import('../services/dm/dmRevealLedger');
    jest.isolateModules(() => {
      fresh = require('../services/dm/dmRevealLedger');
    });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fresh!.recordReveal(SELF, PARTNER, 1_000);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const loggedText = warnSpy.mock.calls[0].map(String).join(' ');
      expect(loggedText).not.toContain(PARTNER);
      expect(loggedText).not.toContain(SELF);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * Finding 3: clearReveal's own catch (`memo.clear()`) was the one catch
 * branch in the module still unexercised even after the round-1 coverage —
 * same mechanism (a genuinely throwing store), applied to the prefix-sweep
 * path instead of a read or a write.
 */
describe('clearReveal fail-safe under a genuinely throwing store', () => {
  afterEach(() => {
    jest.dontMock('react-native-mmkv');
    jest.resetModules();
  });

  it('recovers via memo.clear() when the store throws during the prefix sweep', () => {
    jest.resetModules();
    jest.doMock('react-native-mmkv', () => ({
      createMMKV: () => ({
        getString: () => undefined,
        set: () => {},
        remove: () => {},
        getAllKeys: () => {
          throw new Error('mmkv getAllKeys failed');
        },
      }),
    }));
    let fresh: typeof import('../services/dm/dmRevealLedger');
    jest.isolateModules(() => {
      fresh = require('../services/dm/dmRevealLedger');
    });
    fresh!.recordReveal(SELF, PARTNER, 1_000); // store.set succeeds here — memoized true
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(true);
    expect(() => fresh!.clearReveal(SELF)).not.toThrow();
    // Memo cleared by the catch; the fallback read also says false (nothing
    // was ever actually stored in this mock), so the ledger settles closed.
    expect(fresh!.hasRevealedTo(SELF, PARTNER)).toBe(false);
  });
});
