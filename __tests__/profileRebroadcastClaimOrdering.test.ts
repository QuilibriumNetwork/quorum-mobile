/**
 * The connect-time profile rebroadcast must not mark itself done before it acts.
 *
 * ## The bug this exists to prevent, which shipped once already
 *
 * `WebSocketContext` fingerprints the broadcast-relevant profile fields and
 * defers the actual send by 4 seconds, so it does not collide with the log
 * catch-up. The effect's cleanup clears that timer.
 *
 * The shipped version recorded the fingerprint BEFORE arming the timer:
 *
 *     if (ref.current === sig) return;
 *     ref.current = sig;                      // ← claimed here
 *     const t = setTimeout(…broadcast…, 4000);
 *     return () => clearTimeout(t);           // ← cancelled on any re-run
 *
 * Any re-render inside the 4s window ran the cleanup and cancelled the pending
 * broadcast. The effect then re-ran, found the fingerprint already recorded, and
 * returned early — so nothing rescheduled the work. The profile change was lost
 * with no error and nothing to retry. Measured on device: a re-render landed
 * 1.3s in, and the broadcast never happened.
 *
 * This was never only about `.q` names. The fingerprint also covers display
 * name, avatar and the Farcaster pair, so a rename or an avatar change could
 * equally fail to reach spacemates, leaving them rendering a stale identity.
 *
 * The fix: claim the fingerprint INSIDE the timer callback. A cancelled attempt
 * then leaves no trace, so the next run still sees a changed fingerprint and
 * schedules again — churn defers the broadcast instead of destroying it.
 *
 * ## Why a source-text test
 *
 * This is a `useEffect` ordering invariant inside a ~7000-line provider that no
 * test renders. Reverting the fix leaves the entire suite green, which is how it
 * shipped: neither reading nor CI caught it, and only an `adb logcat` capture
 * started before the action proved it. Asserting on the source is the cheap way
 * to pin the one line that matters. Same approach as `receiptWiring.test.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

const SOURCE_PATH = path.join(__dirname, '..', 'context', 'WebSocketContext.tsx');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

/** Slice the source between two anchors, failing loudly if either moved. */
function section(startAnchor: string, endAnchor: string): string {
  const start = source.indexOf(startAnchor);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(endAnchor, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const rebroadcastEffect = () =>
  section(
    'const lastProfileRebroadcastSigRef = useRef<string | null>(null);',
    'return () => clearTimeout(t);',
  );

/**
 * The claim `ref.current = sig`, excluding the `===` comparison in the guard.
 * A plain `indexOf` would be quietly satisfied by the guard line.
 */
const CLAIM = /lastProfileRebroadcastSigRef\.current\s*=(?!=)\s*sig/;

describe('the connect-time profile rebroadcast', () => {
  it('claims the fingerprint inside the timer, not before arming it', () => {
    // The whole bug in one assertion. If the claim moves back above the
    // setTimeout, a re-render inside the 4s window silently destroys the
    // broadcast instead of deferring it.
    const body = rebroadcastEffect();
    const claim = body.search(CLAIM);
    const timer = body.indexOf('setTimeout(');

    expect(claim).toBeGreaterThan(-1);
    expect(timer).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(timer);
  });

  it('still returns early on an unchanged fingerprint, so this is not "always send"', () => {
    // The fix must not be achieved by deleting the dedupe. An unchanged profile
    // on every reconnect has to stay a no-op on the wire.
    const body = rebroadcastEffect();
    expect(body).toMatch(/if\s*\(lastProfileRebroadcastSigRef\.current === sig\)\s*return;/);
    // And that guard belongs before the timer, or it stops suppressing anything.
    expect(body.indexOf('=== sig')).toBeLessThan(body.indexOf('setTimeout('));
  });

  it('clears the fingerprint when the deferred work throws, so it retries', () => {
    // A failed import or spaces lookup must not be recorded as the canonical
    // last broadcast — that is the same permanent-block failure by another
    // route.
    expect(rebroadcastEffect()).toMatch(/lastProfileRebroadcastSigRef\.current\s*=(?!=)\s*null/);
  });
});

describe('the rebroadcast fingerprint', () => {
  // These pin the sibling defect fixed alongside the race: electing a primary
  // name touches no other profile field, so if the name is absent from either
  // the fingerprint or the dep array, an in-session election reaches nobody
  // while a fresh launch still works. `primaryNameBroadcastSignature.test.ts`
  // covers the wire-level signature functions; this covers the effect that
  // decides whether to call them at all.

  it('includes the primary name, so electing one re-triggers the effect', () => {
    expect(rebroadcastEffect()).toMatch(/p:\s*user\.primaryUsername/);
  });

  it('is watched by a dep array that includes the primary name', () => {
    // Without this dep the effect never re-runs on an election, so the
    // fingerprint above is never recomputed and the change is invisible.
    const deps = section('return () => clearTimeout(t);', '  const value = useMemo');
    expect(deps).toMatch(/user\?\.primaryUsername/);
  });
});
