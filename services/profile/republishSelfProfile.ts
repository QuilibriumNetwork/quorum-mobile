/**
 * Republish your own public profile after something changed WHICH NAME YOU
 * RESOLVE TO.
 *
 * ## Why this exists
 *
 * Electing a QNS name as primary used to be a purely local act: the handler
 * wrote `primaryUsername` onto the in-memory user and showed an alert. Nothing
 * left the device. Since a `.q` reaches other people ONLY inside the published
 * public profile, "Set as Primary" changed what YOU saw and nothing about what
 * anyone else saw — indefinitely, or until some unrelated edit (a new avatar, a
 * bio change) happened to trigger a publish and carried the name along by
 * accident.
 *
 * That is the shape of the bug this fixes, and it generalises. Four different
 * actions change which name you resolve to:
 *
 *   - electing a name primary
 *   - un-electing it
 *   - making a name private, when it was the primary one
 *   - transferring a name away, when it was the primary one
 *
 * All four are display-name changes, so all four run the same publish. Naming
 * it once is what makes that true rather than aspirational — the previous
 * arrangement had the publish block copy-pasted at each of the four *profile
 * editing* call sites, and the QNS actions simply never got a copy.
 *
 * ## What it deliberately does not do
 *
 * It does not broadcast to spaces. The space `update-profile` message has no
 * field for a QNS name, so there is nothing to send; spacemates learn your `.q`
 * by fetching your public profile. Giving the `.q` its own wire field is a
 * separate, larger change (it is what would let a user with a PRIVATE profile
 * show a `.q` at all).
 *
 * It also does not touch Farcaster. In merged mode the Farcaster display name
 * should follow your resolved Quorum name, but that write is user-visible on
 * another network and needs its own confirmation step.
 *
 * ## Best-effort, and honest about it
 *
 * The local election is the source of truth and is already saved by the time
 * this runs. A failed publish therefore must not look like a failed election.
 * This returns an outcome instead of throwing so the caller can say the right
 * thing: `not-public` is a normal, non-error state (nothing is published
 * because nothing is public), while `failed` warrants telling the user their
 * change has not reached anyone yet.
 */

import { logger } from '@quilibrium/quorum-shared';

/**
 * Deferred `require` rather than `await import()`.
 *
 * Both are lazy — Metro has no code splitting, so a dynamic import on React
 * Native is a Promise-wrapped require and buys nothing a require does not.
 * What it does cost is testability: jest's VM refuses dynamic import without a
 * node flag, and the refusal arrives as a rejected promise INSIDE the try
 * block, so a test asserting the failure path goes green while never reaching
 * the code it claims to cover. Matches how the API client loads its dev
 * overlay.
 */
const loadPublicProfile = () =>
  require('@/services/profile/publicProfile') as typeof import('@/services/profile/publicProfile');
const loadFarcasterLink = () =>
  require('@/services/calling/farcaster-link') as typeof import('@/services/calling/farcaster-link');

/**
 * The subset of the auth user this needs. Structural rather than `UserInfo` so
 * callers must pass the values EXPLICITLY — `updateProfile` is a React state
 * update, so the `user` object in scope still holds the old name when this is
 * called right after electing. Spreading the override in at the call site
 * (`{ ...user, primaryUsername: next }`) makes that impossible to forget.
 */
export interface SelfProfileSnapshot {
  address: string;
  displayName?: string;
  username?: string;
  profileImage?: string;
  bio?: string;
  isProfilePublic?: boolean;
  /** Empty string un-elects; see `NO_PRIMARY_NAME`. */
  primaryUsername?: string;
  farcaster?: { fid?: number; custodyAddress?: string };
}

export type RepublishOutcome =
  /** Reached the server. Other users will see the new name. */
  | { status: 'published' }
  /** Profile is private, so there is no published record to update. Expected. */
  | { status: 'not-public' }
  /** Local change stands, but nobody else can see it yet. */
  | { status: 'failed'; error: unknown };

export async function republishSelfProfile(
  self: SelfProfileSnapshot,
): Promise<RepublishOutcome> {
  if (!self.address) return { status: 'not-public' };
  if (!self.isProfilePublic) return { status: 'not-public' };

  // Re-derive the Farcaster link on every publish so the server's
  // `farcaster-fid/<fid> → address` index stays current. Cheap (in-memory
  // crypto over a 32-byte key) and, more importantly, omitting it would DROP
  // an existing link — the POST replaces the record wholesale, so a publish
  // without the link silently unlinks the two identities.
  let farcasterLink:
    | Awaited<ReturnType<typeof import('@/services/calling/farcaster-link').generateFarcasterLink>>
    | null = null;
  if (self.farcaster?.fid && self.farcaster?.custodyAddress) {
    try {
      const { generateFarcasterLink } = loadFarcasterLink();
      farcasterLink = await generateFarcasterLink(
        self.farcaster.fid,
        self.farcaster.custodyAddress,
        self.address,
      );
    } catch (e) {
      // Non-fatal: publish the name change without refreshing the link rather
      // than losing the name change over it.
      logger.warn('[publicProfile] farcaster link generation failed', e);
    }
  }

  try {
    const { publishPublicProfile } = loadPublicProfile();
    await publishPublicProfile({
      address: self.address,
      displayName: self.displayName || self.username || '',
      profileImage: self.profileImage || '',
      bio: self.bio || '',
      // Falsy (including the empty-string un-elect sentinel) makes
      // publishPublicProfile omit `primary_username` entirely and sign the v1
      // payload — byte-identical to a user who never elected a name. That is
      // what makes un-electing actually clear the field server-side rather
      // than needing a separate "clear" route.
      primaryUsername: self.primaryUsername,
      farcasterLink: farcasterLink ?? undefined,
    });
    return { status: 'published' };
  } catch (error) {
    logger.warn('[publicProfile] republish after name change failed', error);
    return { status: 'failed', error };
  }
}
