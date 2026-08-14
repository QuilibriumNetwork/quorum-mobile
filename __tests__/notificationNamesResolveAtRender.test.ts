/**
 * Notification rows resolve names at RENDER time, through the identity ladder.
 *
 * ## What broke, and why nothing caught it
 *
 * `logMentionOrReply` used to format the author into `senderDisplayName` and
 * bake in-body mention names into the stored preview, on the WebSocket receive
 * path. There is no React tree above that path, so no QNS claim can be
 * verified, so a `.q` could never appear in a notification — for anyone,
 * including the viewer, however the same member rendered one channel away.
 *
 * Every test covering it asserted the baked strings, so they all passed while
 * the feature was missing. The bug was found by an operator noticing the author
 * prefix read a global display name under a member whose `.q` showed
 * everywhere else.
 *
 * Desktop resolves these in its panel (`NotificationPanel.tsx`,
 * `<MemberName spaceId={rowSpaceId} enrich />`), and mobile's own DM rows
 * already did it for the matching "frozen name goes stale" reason.
 *
 * ## Why the pure module and not a mounted panel
 *
 * `partitionNotifications` is where the resolver is applied, and it is pure by
 * design. `useUnifiedNotifications` binds `resolveName` to `@/identity` and the
 * provider tests already prove that ladder verifies claims. Testing here pins
 * the wiring — that a resolver is CONSULTED, scoped to the row's space, and
 * falls back rather than showing a hash — without a renderer.
 */

import { quorumToUnified } from '../services/notifications/partitionNotifications';
import type { NotificationNameResolver } from '../services/notifications/partitionNotifications';

const SPACE = 'space-1';
const AUTHOR = 'QmThemThemgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imTT1';
const VIEWER = 'QmMeMeMeEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imMMM1';

function mentionRow(over: Record<string, unknown> = {}) {
  return {
    id: `${SPACE}:chan:msg-1`,
    kind: 'mention-you' as const,
    spaceId: SPACE,
    spaceName: 'Test Space',
    channelId: 'chan',
    channelName: 'general',
    senderId: AUTHOR,
    senderName: 'Brave Light',
    // The name frozen at write time — a global display name, never a `.q`.
    senderDisplayName: 'Brave Light',
    preview: { kind: 'text' as const, text: `@<${VIEWER}> new` },
    createdAt: 1_000,
    ...over,
  };
}

/** Resolves both participants to `.q` names, and records the scope it was
 *  asked with so the space-ladder wiring can be asserted. */
function resolverSpy() {
  const calls: { address: string; spaceId?: string }[] = [];
  const names: Record<string, string> = {
    [AUTHOR]: 'brave.q',
    [VIEWER]: 'qtest.q',
  };
  const resolve: NotificationNameResolver = (address, spaceId) => {
    calls.push({ address, spaceId });
    return names[address];
  };
  return { resolve, calls };
}

describe('notification rows — the author prefix', () => {
  it('renders the author through the resolver, not the frozen name', () => {
    const { resolve } = resolverSpy();

    const row = quorumToUnified(mentionRow() as never, undefined, resolve);

    expect(row.actorName).toBe('brave.q');
    // The exact symptom that was reported: the write-time global display name
    // surfacing under an author who renders as `.q` everywhere else.
    expect(row.actorName).not.toBe('Brave Light');
  });

  it('asks with the ROW\'s spaceId, so a per-space nickname can outrank the .q', () => {
    // The product rule's one exception. Resolving globally here would show the
    // `.q` for a member who has deliberately renamed themselves in this space,
    // contradicting the channel the notification is about.
    const { resolve, calls } = resolverSpy();

    quorumToUnified(mentionRow() as never, undefined, resolve);

    expect(calls.find((c) => c.address === AUTHOR)?.spaceId).toBe(SPACE);
  });

  it('falls back to the frozen name when nothing resolves', () => {
    // CONTROL ARM. A member who has left, or whose roster never synced, must
    // keep the name the log captured — never degrade to a hash, and never
    // vanish.
    const row = quorumToUnified(mentionRow() as never, undefined, () => undefined);

    expect(row.actorName).toBe('Brave Light');
  });

  it('carries no author at all when neither source has one', () => {
    const row = quorumToUnified(
      mentionRow({ senderDisplayName: undefined }) as never,
      undefined,
      () => undefined,
    );

    expect(row.actorName).toBeUndefined();
  });
});

describe('notification rows — mentions inside the body', () => {
  it('resolves a mention of the viewer to their .q', () => {
    const { resolve } = resolverSpy();

    const row = quorumToUnified(mentionRow() as never, undefined, resolve);

    expect(row.previewText).toBe('@qtest.q new');
  });

  it('scopes body mentions to the row\'s space too', () => {
    const { resolve, calls } = resolverSpy();

    quorumToUnified(mentionRow() as never, undefined, resolve);

    expect(calls.find((c) => c.address === VIEWER)?.spaceId).toBe(SPACE);
  });

  it('truncates an address the resolver cannot name', () => {
    // CONTROL ARM. Never the raw 46-character hash, which would push the
    // message itself off the end of the row.
    const row = quorumToUnified(mentionRow() as never, undefined, () => undefined);

    expect(row.previewText).not.toContain(VIEWER);
    expect(row.previewText).toContain('new');
  });

  it('leaves an already-baked row untouched', () => {
    // BACK-COMPAT. Rows written before this change hold names, not tokens.
    // They must keep rendering exactly as they did — there is no migration.
    const { resolve } = resolverSpy();

    const row = quorumToUnified(
      mentionRow({ preview: { kind: 'text', text: '@GattoPardo Mobile new' } }) as never,
      undefined,
      resolve,
    );

    expect(row.previewText).toBe('@GattoPardo Mobile new');
  });
});
