/**
 * Wire dialects of the `dm-update-profile` control message.
 *
 * There are two on the network today, and both are live in shipped clients:
 *
 *  - WRAPPED: a full Message envelope, payload under `content`, synthetic
 *    `messageId` ('dm-profile-…'). What THIS client sends.
 *  - FLAT: the bare payload at top level — `{ type, senderId, displayName,
 *    userIcon, bio? }` — no `content`, no `messageId`. What desktop sends,
 *    the same family as its flat delivery/read-ack receipts.
 *
 * The receive path must accept BOTH. Before this parser existed the flat
 * dialect matched no interceptor and fell through to the no-messageId
 * backstop, which consumed it without applying — so a desktop partner's
 * rename never reached this device's conversation row, silently, forever.
 */
export interface DmProfileUpdatePayload {
  senderId?: string;
  displayName?: string;
  userIcon?: string;
  bio?: string;
  /** Presence-exact: '' is a deliberate un-election and must survive parsing. */
  primaryUsername?: string;
}

type AnyRecord = Record<string, unknown>;

function fieldsFrom(src: AnyRecord): DmProfileUpdatePayload {
  return {
    senderId: typeof src.senderId === 'string' ? src.senderId : undefined,
    displayName: typeof src.displayName === 'string' ? src.displayName : undefined,
    userIcon: typeof src.userIcon === 'string' ? src.userIcon : undefined,
    bio: typeof src.bio === 'string' ? src.bio : undefined,
    primaryUsername:
      typeof src.primaryUsername === 'string' ? src.primaryUsername : undefined,
  };
}

export function parseDmProfileUpdate(decrypted: unknown): DmProfileUpdatePayload | null {
  if (!decrypted || typeof decrypted !== 'object') return null;
  const msg = decrypted as AnyRecord;

  // Wrapped first: the content payload is the authored one, so it wins if
  // both shapes are somehow present on one object.
  const content = msg.content as AnyRecord | undefined;
  if (content && typeof content === 'object' && content.type === 'dm-update-profile') {
    return fieldsFrom(content);
  }
  if (msg.type === 'dm-update-profile') {
    return fieldsFrom(msg);
  }
  return null;
}
