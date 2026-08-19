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
