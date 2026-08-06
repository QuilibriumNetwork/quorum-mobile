/**
 * Electing and un-electing a primary QNS name, including what the user is told.
 *
 * ## Why this is a module and not two handlers
 *
 * The elect flow appears in three places (the owned-names list, the
 * delegated-names list, and the name detail sheet) and the un-elect flow in
 * two. Every one of them has to do the same three things in the same order:
 * write the field, publish, and then say something that is TRUE about what
 * just happened. The original bug was a handler that did the first and third
 * without the second, and told the user their name was now their username when
 * in fact nothing had left the device.
 *
 * Keeping the sequence here means a call site cannot get it wrong by omission,
 * and it means the message text is reachable from a test — which matters more
 * than it sounds, because "@name is now your primary username" was literally
 * true and completely misleading, and no type or lint rule catches that.
 */

import { NO_PRIMARY_NAME } from '@/utils/primaryName';
import {
  republishSelfProfile,
  type RepublishOutcome,
  type SelfProfileSnapshot,
} from '@/services/profile/republishSelfProfile';

export interface PrimaryNameChangeResult {
  outcome: RepublishOutcome;
  /** Alert title. */
  title: string;
  /** Alert body. Says what reached other people, not just what was saved. */
  body: string;
}

export interface PrimaryNameChangeParams {
  /** The name being elected, or the one being dropped. Used in the message. */
  name: string;
  /** The value to store. `NO_PRIMARY_NAME` un-elects. */
  next: string;
  /** Current user, with `next` NOT yet applied — this applies it. */
  self: SelfProfileSnapshot;
  updateProfile: (updates: { primaryUsername: string }) => void;
}

/**
 * Apply a primary-name change and report what actually happened.
 *
 * The local write comes first and is the source of truth, so a failed publish
 * must not read as a failed election — it reads as "saved here, not yet
 * anywhere else".
 */
export async function changePrimaryName({
  name,
  next,
  self,
  updateProfile,
}: PrimaryNameChangeParams): Promise<PrimaryNameChangeResult> {
  const electing = next !== NO_PRIMARY_NAME;

  updateProfile({ primaryUsername: next });
  // `updateProfile` is a React state update, so `self` still carries the old
  // name; the new one is applied explicitly rather than read back.
  const outcome = await republishSelfProfile({ ...self, primaryUsername: next });

  return { outcome, ...describe(name, electing, outcome) };
}

function describe(
  name: string,
  electing: boolean,
  outcome: RepublishOutcome,
): { title: string; body: string } {
  if (outcome.status === 'failed') {
    return electing
      ? {
          title: 'Primary set, but not published',
          body: `@${name} is saved as your primary username on this device. Publishing it failed, so other people will keep seeing your old name until it goes through.`,
        }
      : {
          title: 'Primary removed, but not published',
          body: `@${name} is no longer your primary username on this device. Publishing that change failed, so other people may still see you as ${name}.q for now.`,
        };
  }

  if (!electing) {
    return {
      title: 'Primary Removed',
      body:
        outcome.status === 'published'
          ? `@${name} is no longer your primary username. You now show up under your display name.`
          : `@${name} is no longer your primary username.`,
    };
  }

  return {
    title: 'Primary Set',
    body:
      outcome.status === 'published'
        ? `@${name} is now your primary username. Other people will see you as ${name}.q.`
        : // Say this plainly instead of implying the name is now visible. A
          // private profile is where the `.q` stops: the published profile is
          // the only thing that carries one to anyone else.
          `@${name} is now your primary username. Your profile is private, so only you can see it. Turn on Public Profile to show ${name}.q to other people.`,
  };
}

/**
 * Whether an action that changed a name's status should also drop it as your
 * primary one.
 *
 * The rule is one sentence: **a name stops being your primary the moment it
 * stops pointing at you.** Making it private stops it resolving; transferring it
 * hands it to somebody else. Making it resolvable does the opposite and must
 * change nothing.
 *
 * Extracted and tested because the call sites express it as a negation
 * (`!makeResolvable`) inside a react-query callback that nothing in CI executes.
 * Flipping that one `!` would mean "making a name resolvable un-elects it" and
 * "making it private leaves it elected" — both silent, both wrong, and neither
 * caught by any type.
 */
export function shouldReleasePrimary(params: {
  /** Is this name the user's currently elected primary? */
  isPrimary: boolean;
  /** Will the name still resolve to this user after the action? */
  stillResolvesToYou: boolean;
}): boolean {
  return params.isPrimary && !params.stillResolvesToYou;
}

/**
 * The clause to append when an action made a name unusable as your primary one
 * and so dropped it: making it private, or transferring it away.
 *
 * Separate from `changePrimaryName` because those actions own their own
 * headline message ("has been transferred") and this is the consequence tacked
 * onto it. Returns empty when the name was not the elected one, so callers can
 * concatenate unconditionally.
 */
export function describeReleasedPrimary(
  name: string,
  outcome: RepublishOutcome | null,
): string {
  if (!outcome) return '';
  if (outcome.status === 'failed') {
    return ` It was your primary name, so it has been removed as primary here, but publishing that change failed. Until it publishes, other people may still see you as ${name}.q.`;
  }
  return ' It was your primary name, so you now show up under your display name.';
}
