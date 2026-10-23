/**
 * When to cut post-hangup padding short.
 *
 * After a connected DM call ends, CallContext keeps the circuit alive sending
 * CBR silence until the next rotation boundary, so a relay can't line circuit
 * teardown up with the moment the call ended. The teardown is a JS
 * setTimeout, and JS timers don't fire while the app is in the background on
 * Android, so a user who hangs up and leaves the app kept streaming silence
 * until they next opened it — minutes or hours of audio bandwidth instead of
 * at most one rotation window.
 *
 * Ending the padding at the moment the app is backgrounded gives up some of
 * the timing cover: teardown then lines up with "the user left the app", which
 * often follows hangup closely. That is the accepted cost; padding that never
 * ends is worse for the user than a weaker decorrelation for the one call. If
 * the app stays in the foreground the padding still runs to the boundary.
 */

export type PaddingAppStateAction = 'end-now' | 'keep';

/**
 * What to do with padding in progress when the app changes state.
 *
 * - `background`: end it now, because the timer that would end it won't run.
 * - `active` with the deadline already passed: end it now. Covers a padding
 *   that outlived its boundary without a `background` event (iOS can go
 *   inactive → suspended, and the timer may be late on resume).
 * - anything else (`inactive`, `active` before the deadline): leave it to the
 *   timer. `inactive` fires for control-centre pulls and the app switcher
 *   peek, which are not the user leaving.
 */
export function paddingActionForAppState(
  nextState: string,
  deadline: number | null,
  now: number,
): PaddingAppStateAction {
  if (nextState === 'background') return 'end-now';
  if (nextState === 'active' && deadline !== null && now >= deadline) return 'end-now';
  return 'keep';
}
