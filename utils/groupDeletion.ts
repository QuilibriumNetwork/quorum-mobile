/**
 * The one rule for whether a channel group may be deleted: it must be empty.
 *
 * Channels are nested inside the group object, so deleting a group is a single
 * `space.groups.filter(...)` that takes every channel in it along with it, for every
 * member of the Space, with no undo. Desktop refuses that outright
 * (useGroupManagement.handleDeleteClick blocks on `hasChannels`); mobile shipped the
 * dialog sentence "The group must be empty" without the guard behind it, so the copy
 * told users they were protected from exactly the thing that then happened.
 *
 * This lives outside the hook so the settings sheet can gate the Delete row on the
 * same rule the mutation enforces. The throw inside useDeleteGroup is the correctness
 * boundary, the one a future caller cannot bypass; the disabled row is what stops the
 * user forming the intent at all. Sharing one function means the two cannot drift.
 */
import type { Group } from '@quilibrium/quorum-shared';

/** Why `group` cannot be deleted, phrased for the user, or null if it can be. */
export function groupDeletionBlocker(group: Group): string | null {
  const count = group.channels.length;
  if (count === 0) return null;
  return count === 1
    ? 'This group still contains 1 channel. Move or delete it first.'
    : `This group still contains ${count} channels. Move or delete them first.`;
}
