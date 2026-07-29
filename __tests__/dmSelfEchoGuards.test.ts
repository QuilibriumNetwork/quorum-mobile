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

  it('gates delete-conversation-self on the ref in BOTH receive paths', () => {
    const gate =
      'const isSelfSender = !!selfContent.senderId && selfContent.senderId === fullUserAddrRef.current;';
    // One in handleIncomingMessage (fallback path), one in applyDMGroupResults.
    expect(trimmedLines.filter((line) => line === gate)).toHaveLength(2);
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
