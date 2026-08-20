// NETWORKED. The control arm for the DM identity reveal rule.
//
//   yarn harness:reveal             (runs BOTH sides; do not invoke directly)
//
// ── The rule under test ────────────────────────────────────────────────────
//
// The SENDER's identity is shown to the receiver. The RECEIVER's identity is
// NOT shown until they deliberately engage back — unless they had already
// messaged that partner before.
//
// So a spammer who messages you learns nothing about you. Reply once and you
// have chosen to be known, permanently, to that person.
//
// ── Why this cannot be a unit test ─────────────────────────────────────────
//
// The failure it guards against is a message that DOES leave the device. A unit
// test asserts against a mocked send seam, so it can only prove the code
// decided not to call the seam — never that nothing reached the peer. The two
// diverge exactly when the leak lives on a path the mock does not model, which
// is where both real leaks in this feature were found (the broadcast sweep, and
// the delete-conversation signal).
//
// Two processes, mobile's real client on both sides, the production relay in
// between, and the assertion made on the STRANGER's stored row. That is the
// only observation that answers "did they learn my name".
//
// ── Why both bots are mobile ───────────────────────────────────────────────
//
// Pairing mobile against desktop would make a failure unreadable. Desktop
// cannot parse mobile's wrapped `dm-update-profile` at all (READ 2026-08-19,
// quorum-desktop MessageService.ts:907 tests `raw.type` and never
// `raw.content.type`), so "the stranger never saw a name" would have two
// completely different explanations and no way to tell them apart. See §D1 of
// the reveal-ledger plan.
//
// ── The two arms ───────────────────────────────────────────────────────────
//
// PHASE 1 (leak):    B is renamed while a stranger's row sits in B's store.
//                    A must NOT learn the new name.
// PHASE 2 (control): B then replies once. A MUST learn B's name.
//
// Phase 2 is not a bonus assertion, it is what makes phase 1 mean anything. A
// dead bench, a broken relay or a bot that never paired all produce "A learned
// nothing", which reads as a pass. Phase 1 is only evidence when phase 2 proves
// the same wire, the same code and the same pair CAN carry a name.
//
// The two phases assert on DIFFERENT strings (`RENAMED` vs B's own display
// name), so it is never ambiguous which one delivered a value.
//
// ── Ordering ───────────────────────────────────────────────────────────────
//
// B must not reply until A has finished observing phase 1, or the reply's
// reveal races A's read and a correct implementation fails intermittently. The
// `phase1-done` rendezvous is that barrier. A publishes it BEFORE asserting, so
// a phase-1 failure on A can never leave B waiting out its timeout.
//
// ⚠️ Talks to the PRODUCTION relay with throwaway accounts. See identity.ts.
import { createBot, type MobileBot } from './bot';
import { awaitPeer, publish, waitUntil, type Role } from './rendezvous';
import { clearReveal, hasRevealedTo } from '@/services/dm/dmRevealLedger';

/** Time given to the relay + receive path after each act. */
const SETTLE_MS = Number(process.env.HARNESS_SETTLE_MS ?? 25_000);

const ROLE = (process.env.HARNESS_ROLE ?? '') as Role;
const PEER: Role = ROLE === 'a' ? 'b' : 'a';
const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE || (ROLE !== 'a' && ROLE !== 'b') ? describe.skip : describe;

// A = the STRANGER. Initiates, and must end the run still not knowing B.
// B = the RECIPIENT. Must not reveal itself until it replies.
const IS_STRANGER = ROLE === 'a';

const BOT_NAME = (role: Role) => `reveal-bot-${role}`;

/**
 * The name B broadcasts while it has NOT yet replied.
 *
 * Unique per run, because the relay redelivers un-acked frames: a fixed string
 * could be satisfied by a leak from a PREVIOUS run and read as this run's pass.
 * Run ids are `run-<epoch ms>`; the tail is unique and stays readable in a log.
 */
const RENAMED = `renamed-${(process.env.HARNESS_RUN_ID ?? 'norun').slice(-8)}`;

interface Hello {
  address: string;
  inboxAddress: string;
  readyAt: number;
}

/** B's preconditions at the moment the rename sweep ran. */
interface Renamed {
  /** Did B hold a conversation row for the stranger? Without it, no leak is possible. */
  hadStrangerRow: boolean;
  /** Was B's ledger clean for the stranger? A stale reveal would license the push. */
  ledgerClearForStranger: boolean;
}

/** Poll a bot's stored row for a partner until `want` holds, or time out. */
async function pollRow(
  bot: MobileBot,
  partner: string,
  want: (row: Record<string, unknown> | null) => boolean,
  timeoutMs: number
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    last = await bot.conversationWith(partner);
    if (want(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  return last;
}

maybe(`dm-reveal-two-bot (role ${ROLE} — production relay)`, () => {
  it('hides the recipient from a stranger, then reveals on reply', async () => {
    const bot: MobileBot = await createBot(BOT_NAME(ROLE));

    try {
      await bot.waitForConnected();

      // Un-acked frames are redelivered on every listen, so without this a run
      // starts on whatever the last one left queued — and for THIS scenario a
      // leftover identity frame is indistinguishable from a fresh leak.
      const drained = await bot.drainInbox();

      // The ledger is the thing under test, so start it from a known-empty
      // state rather than trusting one. The harness MMKV shim is in-memory
      // (mmkv-shim.ts) so this is belt-and-braces today; it keeps the scenario
      // meaningful if that ever becomes a disk store.
      clearReveal(bot.identity.address);

      // eslint-disable-next-line no-console
      console.log(
        `[reveal ${ROLE}] ${IS_STRANGER ? 'STRANGER' : 'RECIPIENT'} ` +
          `me=${bot.identity.address.slice(0, 12)} drained=${drained}`
      );

      publish(ROLE, 'hello', {
        address: bot.identity.address,
        inboxAddress: bot.identity.inboxAddress,
        readyAt: Date.now(),
      } satisfies Hello);
      const theirs = await awaitPeer<Hello>(ROLE, 'hello');

      // Neither side acts before both are listening — a frame posted to an
      // unsubscribed inbox would look like a delivery failure rather than the
      // privacy behaviour being measured.
      await waitUntil(Math.max(theirs.readyAt, Date.now()) + 5_000);

      if (IS_STRANGER) {
        // ── A: make contact. This half is SUPPOSED to reveal A. ────────────
        // Initiating is consent under the rule, so A's identity travelling here
        // is correct — and it is what creates the row on B that a leak needs in
        // order to be possible at all.
        //
        // Opening the conversation first is not ceremony: the send hook only
        // UPDATES an existing row, and the receive path drops an identity
        // update for a partner with no row. Without this, A could not observe a
        // leak even if one were sent, and phase 1 would pass vacuously.
        await bot.startConversation(theirs.address);
        await bot.send(theirs.address, 'hello from a stranger');

        const b = await awaitPeer<Renamed>(ROLE, 'renamed');

        // Give a leak every chance to arrive before declaring there was none.
        // A pass must mean "nothing came", not "we did not wait".
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        const leakRow = await bot.conversationWith(theirs.address);
        const leakedName = leakRow?.displayName;

        // Release B to reply. Published BEFORE any assertion below, so a
        // phase-1 failure here cannot strand B on its rendezvous timeout.
        publish(ROLE, 'phase1-done', { at: Date.now() });

        // ── PHASE 2 observation ───────────────────────────────────────────
        await awaitPeer<{ at: number }>(ROLE, 'replied');
        const revealRow = await pollRow(
          bot,
          theirs.address,
          (r) => typeof r?.displayName === 'string' && r.displayName !== '',
          SETTLE_MS
        );
        const revealedName = revealRow?.displayName;
        const expected = BOT_NAME(PEER);

        // Both observations in one line, always printed, whichever assertion
        // below fails. Reading them together is what tells you if the bench was
        // alive — which a single failing expect() never does.
        // eslint-disable-next-line no-console
        console.log(
          `[reveal a] RESULT phase1(leak)=${JSON.stringify(leakedName)} ` +
            `must_not_be="${RENAMED}" | phase2(control)=${JSON.stringify(revealedName)} ` +
            `must_be="${expected}" | preconditions row=${b.hadStrangerRow} ` +
            `ledgerClear=${b.ledgerClearForStranger}`
        );

        // Asserted in dependency order, so the failure message names the layer
        // that actually broke rather than the one that noticed.

        // (1) PRECONDITIONS. A vacuous run must fail loudly, not pass quietly.
        //     No row on B ⇒ the sweep had nothing to leak to. No row on A ⇒
        //     an inbound update would be dropped before it could be observed.
        expect(b.hadStrangerRow).toBe(true);
        expect(b.ledgerClearForStranger).toBe(true);
        expect(leakRow).toBeTruthy();

        // (2) CONTROL ARM. Proves this pair CAN carry a name over this wire.
        //     Without it, (3) is satisfied for free by any dead bench.
        expect(revealedName).toBe(expected);

        // (3) THE LEAK ASSERTION — the security property. Before the reveal
        //     ledger, the sweep pushed B's new name to every row it held,
        //     including a stranger's.
        expect(leakedName).not.toBe(RENAMED);

        // eslint-disable-next-line no-console
        console.log('[reveal a] PASS — hidden from a stranger, revealed on reply');
      } else {
        // ── B: PHASE 1 — rename while NOT having replied ───────────────────
        // Wait for the stranger's message to land so the row exists before the
        // sweep runs. Without it the sweep skips A for a completely different
        // reason and the whole run proves nothing.
        const row = await pollRow(bot, theirs.address, (r) => !!r, SETTLE_MS);
        const hadStrangerRow = !!row;
        const ledgerClearForStranger = !hasRevealedTo(bot.identity.address, theirs.address);

        // eslint-disable-next-line no-console
        console.log(
          `[reveal b] precondition strangerRow=${hadStrangerRow} ` +
            `ledgerClear=${ledgerClearForStranger}`
        );

        // Mobile's REAL sweep — the exact path that leaked before the fix, when
        // it pushed identity to every conversation row it could enumerate.
        await bot.broadcastProfile({ displayName: RENAMED });
        // eslint-disable-next-line no-console
        console.log(`[reveal b] swept rename "${RENAMED}"`);

        publish(ROLE, 'renamed', {
          hadStrangerRow,
          ledgerClearForStranger,
        } satisfies Renamed);

        // THE BARRIER. Replying before A has read its row would race the
        // phase-1 observation and fail a correct implementation intermittently.
        await awaitPeer<{ at: number }>(ROLE, 'phase1-done');

        // ── PHASE 2 — one deliberate reply. Now the reveal is consented. ────
        await bot.send(theirs.address, 'a deliberate reply');
        publish(ROLE, 'replied', { at: Date.now() });
        // eslint-disable-next-line no-console
        console.log('[reveal b] replied — reveal is now consented');

        // Hold the socket open while the reveal push lands on A. Exiting here
        // would tear it down mid-push and turn a real reveal into a false
        // negative on the control arm.
        await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
      }
    } finally {
      await bot.stop();
    }
  }, 10 * 60 * 1000);
});
