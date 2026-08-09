// NETWORKED. Does a claimed `.q` name actually survive the trip to another
// client, and is a claim that is not yours rejected when it lands?
//
//   HARNESS_ROLE=a / =b, one process each — same shape as dm-two-bot.
//
// ── Why this scenario has to exist ─────────────────────────────────────────
//
// The `.q` verification work is testable on one device only in its SENDING
// half. The receiving half cannot be observed there at any effort: Triple
// Ratchet participants cannot decrypt their own echoed messages, so a sender
// never sees its own broadcast arrive (measured 2026-08-09 — electing a name
// logged four `[ProfileSync] broadcast sent` lines and zero receive-side lines,
// with instrumentation sitting at all three storage points).
//
// So before this file, the entire receive path shipped unexercised: whether the
// field survives encryption and the wire, whether the staleness guard admits
// it, whether it lands under the key the resolver reads. Two physical devices
// would answer it once; this answers it every time it runs.
//
// ── What it asserts, and why those two things ──────────────────────────────
//
// 1. DELIVERY — B's stored conversation row carries A's claim under
//    `claimed_primary_username`. That is the plumbing: encrypt → wire →
//    decrypt → merge → persist.
//
// 2. REJECTION — the claim does not verify, because A does not own the name.
//    This is the security property, and it is the case a real user cannot
//    stage: it needs a client that claims a name it has no right to, which the
//    product UI refuses to build.
//
// It deliberately does NOT assert the positive render ("a genuinely owned name
// shows as verified"). That needs a real registered QNS name pointed at a
// throwaway account, which costs money and nothing here owns one. The gap is
// stated rather than papered over: this proves forged claims are refused, not
// that honest ones are accepted.
//
// ⚠️ Talks to the PRODUCTION relay with throwaway accounts. See identity.ts.
import { createBot, type MobileBot } from './bot';
import { awaitPeer, publish, type Role } from './rendezvous';
import { claimedNameBelongsTo } from '@/utils/verifyQnsClaim';
import { resolveClaimedNames, stripUnverifiedNames } from '@/hooks/useVerifiedQnsNames';
import { resolveBatch } from '@/services/api/qnsClient';

const SETTLE_MS = Number(process.env.HARNESS_SETTLE_MS ?? 25_000);

const ROLE = (process.env.HARNESS_ROLE ?? '') as Role;
const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE || (ROLE !== 'a' && ROLE !== 'b') ? describe.skip : describe;

/**
 * The name role A will claim.
 *
 * Deliberately one nobody owns. A name that happened to be registered to
 * somebody else would still fail verification — correctly — but for the wrong
 * reason, and the test would pass while proving less than it appears to.
 * Prefixed and suffixed so it cannot collide with a real registration.
 */
const CLAIMED_NAME = 'harnessclaimzz';

interface Hello {
  address: string;
  inboxAddress: string;
  readyAt: number;
}

maybe(`qns-claim-two-bot (role ${ROLE} — production relay)`, () => {
  it('delivers a .q claim to the peer and refuses to verify it', async () => {
    const bot: MobileBot = await createBot(`qns-bot-${ROLE}`);

    try {
      await bot.waitForConnected();

      // Same reason as dm-two-bot: un-acked frames are redelivered on every
      // listen, so a previous run's leftovers would otherwise be read as this
      // run's traffic.
      await bot.drainInbox();

      publish(ROLE, 'hello', {
        address: bot.identity.address,
        inboxAddress: bot.identity.inboxAddress,
        readyAt: Date.now(),
      } satisfies Hello);
      const theirs = await awaitPeer<Hello>(ROLE, 'hello');

      // A conversation must exist on BOTH sides before a profile broadcast is
      // meaningful: the sender iterates its own conversation rows to find
      // partners, and the receiver drops an update for a partner it has no row
      // for. One DM each way is the cheapest way to create both.
      const startAt = Math.max(theirs.readyAt, Date.now()) + 5_000;
      await new Promise((r) => setTimeout(r, Math.max(0, startAt - Date.now())));
      await bot.send(theirs.address, `hello from ${ROLE}`);
      await new Promise((r) => setTimeout(r, 12_000));

      if (ROLE === 'a') {
        // A claims a name it does not own and broadcasts it exactly as the app
        // does when a user elects a primary name.
        await bot.broadcastProfile({
          displayName: `qns-bot-a`,
          primaryUsername: CLAIMED_NAME,
        });
        // eslint-disable-next-line no-console
        console.log(`[qns-claim a] broadcast claim "${CLAIMED_NAME}"`);
      }

      await new Promise((r) => setTimeout(r, SETTLE_MS));

      if (ROLE === 'b') {
        const row = await bot.conversationWith(theirs.address);
        const stored = row?.claimed_primary_username;

        // eslint-disable-next-line no-console
        console.log(
          `[qns-claim b] row=${row ? 'present' : 'MISSING'} ` +
            `claimed_primary_username=${JSON.stringify(stored)}`
        );

        // (1) DELIVERY. If this fails the transport is broken and no amount of
        // verification logic matters, because nothing ever arrives to verify.
        expect(row).toBeTruthy();
        expect(stored).toBe(CLAIMED_NAME);

        // The claim must NOT have been written into the field the resolver
        // reads. That separation is the whole reason the wire value lands under
        // its own key: surfaces that skip verification (notification previews,
        // conversation titles) read `primary_username`, so a wire claim landing
        // there would render unverified on every one of them.
        expect(row?.primary_username).toBeUndefined();

        // (2) REJECTION, against the REAL resolver over the network — not a
        // mock. A is not the owner of this name, so the claim must not survive.
        const records = await resolveClaimedNames([CLAIMED_NAME], resolveBatch);
        expect(claimedNameBelongsTo(records.get(CLAIMED_NAME), theirs.address)).toBe(false);

        // And end to end: the row, run through the same strip the surfaces use,
        // must come back with nothing to render as a `.q`.
        const rows: {
          address: string;
          claimed_primary_username: string;
          primary_username?: string;
        }[] = [{ address: theirs.address, claimed_primary_username: String(stored) }];
        const [settled] = stripUnverifiedNames(rows, records);
        expect(settled.primary_username).toBeUndefined();

        // eslint-disable-next-line no-console
        console.log('[qns-claim b] delivered, and correctly refused verification');
      }
    } finally {
      await bot.stop();
    }
  }, 180_000);
});
