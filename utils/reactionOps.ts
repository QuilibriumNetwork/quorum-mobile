/**
 * One reaction control message applied to a message's reactions.
 *
 * The semantics are the DM path's (WebSocketContext `applyDMGroupResults`): an
 * emoji matches by id or name; adding is idempotent per member; removing takes
 * that member out and drops an emoji nobody is left on. Used where a reaction
 * is applied to a message that is being stored, so it can't depend on the
 * cache-side helpers in the receive handlers.
 */
import type { Message } from '@quilibrium/quorum-shared';

export type Reactions = NonNullable<Message['reactions']>;

export interface ReactionOp {
  kind: 'add' | 'remove';
  /** The emoji, as the reaction control message carries it. */
  reaction: string;
  senderId: string;
  /** Space (or, for a DM, conversation address) the target message is in. */
  spaceId: string;
}

export function applyReactionOp(current: Message['reactions'] | undefined, op: ReactionOp): Reactions {
  const reactions = current || [];
  if (op.kind === 'add') {
    const existing = reactions.find((r) => r.emojiId === op.reaction || r.emojiName === op.reaction);
    if (existing) {
      if (existing.memberIds.includes(op.senderId)) return reactions;
      return reactions.map((r) =>
        r === existing ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, op.senderId] } : r,
      );
    }
    return [
      ...reactions,
      { emojiId: op.reaction, emojiName: op.reaction, spaceId: op.spaceId, count: 1, memberIds: [op.senderId] },
    ];
  }
  return reactions
    .map((r) => {
      if (r.emojiId !== op.reaction && r.emojiName !== op.reaction) return r;
      const memberIds = r.memberIds.filter((id) => id !== op.senderId);
      if (memberIds.length === 0) return null;
      return { ...r, count: memberIds.length, memberIds };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
