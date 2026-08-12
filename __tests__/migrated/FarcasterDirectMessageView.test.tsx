/**
 * `FarcasterDirectMessageView.tsx` is one of rows 15-16 of this migration
 * pass, and its outcome is different from every other row: NO code changed.
 *
 * ## Why this file has no render test pinning a `.q`
 *
 * The row's original description read `conversation.displayName` as "a
 * Quorum conversation name read raw", the same shape as row 15's genuine
 * defect in `SocialFeedModal.tsx`. Tracing the actual data instead of the
 * one-line description shows it is not:
 *
 * - This component only ever renders when `isFarcasterConversation` is true
 *   (`app/(tabs)/messages/dm/[id].tsx:500-518`).
 * - EVERY Farcaster conversation object — real or the synthetic one built
 *   for a first-time DM — carries a synthetic `fid:<n>` address, never a
 *   Quorum one (`hooks/chat/useFarcasterDirectCasts.ts:73`; the synthetic
 *   branch at `app/(tabs)/messages/dm/[id].tsx:126`).
 * - `conversation.displayName` is populated entirely from Farcaster fields:
 *   `fc.name ?? counterParty?.displayName ?? counterParty?.username`
 *   (`hooks/chat/useFarcasterDirectCasts.ts:75`).
 *
 * So the raw read here is Farcaster's own conversation-title field, not a
 * Quorum name — routing `conversation.address` through `@/identity` would
 * be the exact mistake the brief for this migration warns against: treating
 * a `fid:<n>` synthetic address as a member address, which can render
 * somebody else's name (or, more likely here, nobody's — no roster entry
 * would ever exist for a `fid:` key). The file's other raw reads (per-message
 * senders in a Farcaster group DM) are Farcaster cast authors, resolved
 * upstream by `directCastToDisplayMessage` and out of this file entirely.
 *
 * ## What this test actually pins
 *
 * A cheap, static tripwire rather than a full render test (this screen's own
 * import graph — `MessagesList`, `MessageInput`, `ChatBottomChrome` — is
 * substantial, and mounting it fully would not exercise anything this row
 * changed). If a future edit adds `@/identity` to this file's imports, this
 * test goes red immediately, forcing whoever makes that change to re-read
 * the reasoning above and `__tests__/rawNameFieldAudit.test.ts`'s matching
 * EXCEPTIONS entry before proceeding.
 */
import { readFileSync } from 'fs';

describe('FarcasterDirectMessageView — deliberately NOT routed through the member resolver', () => {
  it('does not import from @/identity', () => {
    const source = readFileSync('components/Chat/FarcasterDirectMessageView.tsx', 'utf8');
    expect(source).not.toMatch(/from ['"]@\/identity['"]/);
  });
});
