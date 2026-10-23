/**
 * What a silent push is about, as far as the background push task cares.
 *
 * The relay sends three push types, each stamped into the payload's `type`
 * (quorum-api: `hub-log` in server/hublog.go, `inbox` in server/client.go,
 * `farcaster` in server/farcaster_push.go). Kept free of expo-task-manager so
 * the decision is testable without registering the task.
 */

/**
 * Whether a push should trigger the Farcaster direct-cast check.
 *
 * `hub-log` and `inbox` pushes are Quorum space and DM messages: they say
 * nothing about Farcaster, so fetching the direct-cast inbox for each one was
 * a network round trip per Quorum message for no reason. A `farcaster` push,
 * or one whose type we can't read (an older relay, a payload shape we don't
 * recognise), still runs it: an unneeded fetch is cheaper than a missed DM.
 */
export function pushWarrantsFarcasterDmCheck(pushType: unknown): boolean {
  return pushType !== 'hub-log' && pushType !== 'inbox';
}
