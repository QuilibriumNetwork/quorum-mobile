/**
 * Self-echo guards in the DM receive path must compare against the address REF,
 * never `user?.address` from the enclosing closure.
 *
 * Why this test is static rather than behavioural: the guards live inside
 * `handleIncomingMessage` / `applyDMGroupResults` in WebSocketContext, two
 * ~2000-line `useCallback`s wired to the websocket, MMKV, SQLite and the native
 * crypto module. There is no harness that can drive a frame through them, so the
 * invariant is asserted against the source text instead.
 *
 * The failure this prevents (shipped once, survived a fix, resurfaced):
 * WebSocketProvider mounts before AuthContext restores the user, so `user` is
 * null on the first render. Both receive callbacks depend only on stable
 * singletons (queryClient, the memoised storage adapter, and callbacks derived
 * from those), so they are created ONCE with `user === null` and never
 * recreated. Every `user?.address` inside them then evaluates to `undefined`
 * forever, and each self-echo guard silently becomes dead code — our own
 * messages echoed from another device are treated as a stranger's, creating a
 * phantom conversation with ourselves that wears our own name and avatar.
 *
 * `fullUserAddrRef.current` is reassigned on every render, so it is correct
 * regardless of when the callback was created.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_PATH = path.join(__dirname, '..', 'context', 'WebSocketContext.tsx');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/**
 * Self-comparisons still reading the stale closure. These are the space-message
 * paths, tracked separately because enabling them changes which copy of your own
 * space message renders (echo vs optimistic update) and needs its own testing.
 * Anything NOT listed here is a new regression.
 */
const KNOWN_STALE_CLOSURE_SITES = [
  'if (participant.address === user?.address) {',
  'if (senderId && senderId === user?.address) {',
];

/** Guards that must be ref-based, as exact source lines. */
const REQUIRED_REF_GUARDS = [
  // Path 1 — init envelope: self-echo with no channelId is unattributable.
  'if (initSenderAddress === fullUserAddrRef.current) {',
  // Path 2 — subsequent message on an established session.
  'if (senderAddress === fullUserAddrRef.current && decryptedMessage.channelId) {',
  '} else if (senderAddress === fullUserAddrRef.current) {',
  // Drop our own profile off the row so it can't overwrite the partner's.
  'if (authenticatedDmSender && authenticatedDmSender === fullUserAddrRef.current) {',
  // Native batch path.
  'const isSelfSyncEcho = senderAddress === fullUserAddrRef.current;',
];

const trimmedLines = source.split('\n').map((line) => line.trim());

describe('DM self-echo guards', () => {
  it.each(REQUIRED_REF_GUARDS)('compares against the ref: %s', (guard) => {
    expect(trimmedLines).toContain(guard);
  });

  it('gates delete-conversation-self on the CRYPTO sender in BOTH receive paths', () => {
    // ⚠️ THIS IS A SECURITY GATE, NOT A CORRECTNESS ONE.
    //
    // `selfContent.senderId` is plaintext the SENDER WROTE. On its own it is
    // not a gate but a suggestion: any peer could seal a frame claiming to be
    // us, and this device would delete the conversation and every message in
    // it. The payload half is still required (it identifies a genuine
    // self-sync signal), but it must be ANDed with the address the crypto
    // layer authenticated, which no sender can forge:
    //
    //   fallback path → `authenticatedDmSender`, captured pre-rewrite
    //   batch path    → `isSelfSyncEcho`, derived from the pre-rewrite sender
    //
    // Asserted as source text for the same reason as the guards above: these
    // live inside two ~2000-line websocket callbacks with no drivable harness.

    // If this goes red: the payload-only form is back, and ANY PEER CAN WIPE
    // THE CONVERSATION. That is the vulnerability, not a style regression.
    const payloadOnlyGate =
      'const isSelfSender = !!selfContent.senderId && selfContent.senderId === fullUserAddrRef.current;';
    expect(trimmedLines.filter((line) => line === payloadOnlyGate)).toHaveLength(0);

    // Both gates still exist...
    expect(trimmedLines.filter((line) => line === 'const isSelfSender =')).toHaveLength(2);
    // ...and each carries its crypto-authenticated half. Red here means the
    // fallback path lost `authenticatedDmSender`...
    expect(
      trimmedLines.filter((line) => line === 'authenticatedDmSender === fullUserAddrRef.current;')
    ).toHaveLength(1);
    // ...or the batch path lost `isSelfSyncEcho`.
    expect(trimmedLines.filter((line) => line === 'isSelfSyncEcho;')).toHaveLength(1);
  });

  it('stamps the authenticated sender on BOTH receive saves, AFTER the spread', () => {
    // ⚠️ THE GAP THIS CLOSES, measured 2026-08-20: deleting BOTH stamp lines
    // outright left 39/39 tests green across every DM test file. The gate
    // assertions above cover the delete path's READ side; nothing covered the
    // WRITE side that feeds the reveal ledger. So the ledger could silently
    // start seeing no provenance at all, and no test would notice.
    //
    // Ordering is the security half. `decryptedMessage` is JSON the sender
    // authored, so it can contain `authenticatedSenderId`. Spread LAST, the
    // attacker's value wins and the marker becomes attacker-chosen while still
    // looking authoritative — strictly worse than having no marker.
    const stamps = [
      'authenticatedSenderId: authenticatedDmSender || undefined,', // JS path
      'authenticatedSenderId: senderAddress || undefined,', // batch path
    ];

    // Red on any of these means, in order: a receive-path stamp was deleted;
    // it was duplicated so the index below is ambiguous; or it moved above the
    // spread, which is the attacker-wins ordering.
    const spreadAboveEachStamp = stamps.map((stamp) => {
      const occurrences = trimmedLines.filter((l) => l === stamp).length;
      const at = trimmedLines.indexOf(stamp);
      // Bounded lookback: these literals are ~12 lines, so 30 is generous
      // without reaching a neighbouring one.
      const window = at === -1 ? [] : trimmedLines.slice(Math.max(0, at - 30), at);
      return { stamp, occurrences, spreadIsAbove: window.includes('...decryptedMessage,') };
    });

    expect(spreadAboveEachStamp).toEqual(
      stamps.map((stamp) => ({ stamp, occurrences: 1, spreadIsAbove: true }))
    );
  });

  it('space saves strip the marker instead of inheriting it from the wire', () => {
    // Space frames are an unvalidated cast of attacker-authored JSON. Nothing
    // reads a marker on a space row today, so this is defence in depth — but
    // enforcing the rule only on DM paths leaves "no wire value ever survives"
    // true by coincidence rather than by construction.
    expect(
      trimmedLines.filter((l) => l === 'authenticatedSenderId: undefined,')
    ).toHaveLength(1); // the live path's named literal
    expect(
      source.includes('channelId, authenticatedSenderId: undefined } as StoredMessage')
    ).toBe(true); // the batch path's inline literal
  });

  it('introduces no new self-comparison against the stale closure', () => {
    const offenders = trimmedLines.filter(
      (line) => /===\s*user\?\.address/.test(line) && !KNOWN_STALE_CLOSURE_SITES.includes(line)
    );

    // If this fails, use `fullUserAddrRef.current` instead of `user?.address`.
    // Only add to KNOWN_STALE_CLOSURE_SITES if the surrounding callback genuinely
    // lists `user` in its dependency array.
    expect(offenders).toEqual([]);
  });
});
