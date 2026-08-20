import type { Message } from '@quilibrium/quorum-shared';

/**
 * A message as it is STORED on this device, which is a superset of the message
 * as it travels on the wire.
 *
 * ⚠️ WHY THIS TYPE EXISTS AT ALL, and why it is not just `Message`.
 *
 * `authenticatedSenderId` is declared on `Message` in quorum-shared, but this
 * repo pins a PUBLISHED version of that package (see package.json) rather than
 * linking the local checkout the way quorum-desktop does. So the field is not
 * visible here until a release goes out, and without this type the security fix
 * that depends on it would not compile — an unshippable branch.
 *
 * Declaring the field locally decouples the two: this repo compiles and ships
 * today against the currently published quorum-shared, and keeps working
 * unchanged after the release lands (the intersection simply becomes redundant).
 *
 * ONCE quorum-shared PUBLISHES a version carrying `authenticatedSenderId`, this
 * whole module can be deleted and every `StoredMessage` replaced with `Message`.
 * Nothing else needs to change. Until then, do not "simplify" it away.
 *
 * ⚠️ THE FIELD IS PERSISTED BUT NEVER TRANSMITTED. It records the sender the
 * CRYPTO LAYER authenticated for the frame a row came from — the only
 * trustworthy answer to "who actually sent this", because `content.senderId` is
 * plaintext the sending client writes. See `dmRevealLedger.ts` for what reads
 * it, and the two stamps in `context/WebSocketContext.tsx` for how it is
 * written (always AFTER the spread of the wire message, or a forged payload
 * value would win).
 */
export type StoredMessage = Message & {
  authenticatedSenderId?: string;
};

/**
 * A partial view of a stored row.
 *
 * Used for the ledger's history scan, which cares about exactly one field. It
 * is `Partial<StoredMessage>` rather than `{ authenticatedSenderId?: string }`
 * on purpose: an all-optional type with NO properties in common with `Message`
 * trips TypeScript's weak-type detection, so a real `Message[]` from storage
 * would not be assignable to it. Sharing `Message`'s property names avoids that
 * while still letting tests pass bare `{ authenticatedSenderId }` objects.
 */
export type StoredMessageView = Partial<StoredMessage>;
