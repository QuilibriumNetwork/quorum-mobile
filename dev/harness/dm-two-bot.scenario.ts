// NETWORKED. The measurement this whole harness was built for: two headless
// mobile clients exchange numbered DMs and count what actually arrives.
//
//   yarn harness:dm                 (runs BOTH sides; do not invoke directly)
//
// One process per bot — this file runs twice, with HARNESS_ROLE=a and =b. Both
// sides run mobile's real client code; the only thing that is not mobile's is
// the WebSocket implementation underneath, which here is Node's rather than
// React Native's.
//
// ── What a result means ────────────────────────────────────────────────────
//
// This isolates the residual that the transport investigation could not close:
// client-side visibility ends at ws.send into RN's native layer, so a drop
// inside that layer could not be excluded. Removing RN's socket while keeping
// every other line of mobile's code is the experiment that separates them.
//
//   loss ≈ 0 both directions  ⟹ mobile's own send/receive logic is not losing
//     these messages. Attention moves to RN's native WebSocket (and to the node
//     write path, which desktop's harness already exercised at 0% loss).
//   loss > 0                  ⟹ RN native is exonerated for that share, and
//     there is now a headless, re-runnable repro of the real defect.
//
// Neither answer is proof on its own — a fresh throwaway pair may simply be the
// population least likely to exhibit an intermittent, account-aged fault. Read
// it as moving probability, not settling the question.
//
// ⚠️ Talks to the PRODUCTION relay with throwaway accounts. See identity.ts.
import { createBot, type MobileBot } from './bot';
import { awaitPeer, publish, waitUntil, type Role } from './rendezvous';

const ROUNDS = Number(process.env.HARNESS_ROUNDS ?? 20);
const SEND_INTERVAL_MS = Number(process.env.HARNESS_SEND_INTERVAL_MS ?? 1500);
const SETTLE_MS = Number(process.env.HARNESS_SETTLE_MS ?? 20_000);

const ROLE = (process.env.HARNESS_ROLE ?? '') as Role;
const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE || (ROLE !== 'a' && ROLE !== 'b') ? describe.skip : describe;

interface Hello {
  address: string;
  inboxAddress: string;
  readyAt: number;
}

/** `A→B #7` / `B→A #7` — the numbering is what makes loss countable per message. */
const label = (from: Role, n: number) => (from === 'a' ? `A→B #${n}` : `B→A #${n}`);
const parse = (text: string): { from: Role; n: number } | null => {
  const m = /^([AB])→[AB] #(\d+)$/.exec(text);
  if (!m) return null;
  return { from: m[1] === 'A' ? 'a' : 'b', n: Number(m[2]) };
};

function textOf(m: { content?: { type?: string; text?: string } }): string {
  return m.content?.type === 'post' ? (m.content.text ?? '') : '';
}

maybe(`dm-two-bot (role ${ROLE} — production relay)`, () => {
  it('exchanges numbered DMs with the peer process and counts arrivals', async () => {
    const peer: Role = ROLE === 'a' ? 'b' : 'a';
    const bot: MobileBot = await createBot(`dm-bot-${ROLE}`);

    // Numbers this side RECEIVED from the peer, deduped: the relay redelivers
    // un-acked frames, so a raw arrival count would overstate delivery. A set of
    // distinct message numbers is the honest measure of "did it get through".
    const receivedFromPeer = new Set<number>();
    const sentByMe: number[] = [];

    try {
      await bot.waitForConnected();

      // Clear the device inbox BEFORE pairing. Un-acked frames are redelivered
      // on every listen, so a previous run's undecryptable leftovers would
      // otherwise arrive during this one — and since they carry no readable
      // text they cannot be told apart from this run's traffic by content. The
      // first measured runs saw exactly that: six failures whose timestamps
      // belonged to a run fifteen minutes earlier.
      // Device count is load-bearing, not decoration: a send fans out to EVERY
      // registered device, so a stale device makes every message produce frames
      // nobody holds keys for. Printing it here means a run can never be read
      // without knowing how many devices were in play.
      const myReg = await bot.registration();
      // eslint-disable-next-line no-console
      console.log(
        `[dm-two-bot ${ROLE}] devices=${(myReg?.device_registrations ?? []).length} ` +
          `myInbox=${bot.identity.inboxAddress.slice(0, 16)}`
      );

      const drained = await bot.drainInbox();
      if (drained > 0) {
        // eslint-disable-next-line no-console
        console.log(`[dm-two-bot ${ROLE}] drained ${drained} stale frame(s) before starting`);
      }

      publish(ROLE, 'hello', {
        address: bot.identity.address,
        inboxAddress: bot.identity.inboxAddress,
        readyAt: Date.now(),
      } satisfies Hello);

      const theirs = await awaitPeer<Hello>(ROLE, 'hello');
      const mine = { readyAt: Date.now() };

      // Both sides derive the same instant from the same two numbers, so neither
      // starts sending before the other is listening. A bot that began early
      // would post frames to an unsubscribed inbox and count them as lost.
      const startAt = Math.max(theirs.readyAt, mine.readyAt) + 5_000;
      const endAt = startAt + ROUNDS * SEND_INTERVAL_MS + SETTLE_MS;

      // eslint-disable-next-line no-console
      console.log(
        `[dm-two-bot ${ROLE}] me=${bot.identity.address.slice(0, 12)} ` +
          `peer=${theirs.address.slice(0, 12)} rounds=${ROUNDS}`
      );

      const trySend = async (n: number) => {
        try {
          await bot.send(theirs.address, label(ROLE, n));
          sentByMe.push(n);
        } catch (err) {
          // A send that throws is a different failure from a message that
          // vanishes silently, and conflating them would misattribute the loss.
          // eslint-disable-next-line no-console
          console.error(`[dm-two-bot ${ROLE}] send #${n} threw:`, (err as Error).message);
        }
      };

      bot.onSaved = (m) => {
        const text = textOf(m);
        const tag = text ? parse(text) : null;
        // Only the peer's messages count as arrivals — the save seam also fires
        // for this bot's own outgoing messages, which would otherwise inflate
        // the received count to a perfect score no matter what the wire did.
        if (!tag || tag.from !== peer) return;
        const isNew = !receivedFromPeer.has(tag.n);
        receivedFromPeer.add(tag.n);
        // B answers each distinct message once. Replying on a redelivery would
        // send the same number twice and corrupt the sent list.
        if (ROLE === 'b' && isNew) void trySend(tag.n);
      };

      await waitUntil(startAt);

      // ONE initiator. Both sides sending from the same instant looked like the
      // natural design and was wrong: it makes the pair establish sessions in
      // both directions simultaneously, and a 25-round run failed all 50
      // messages on X3DH while the frames themselves arrived perfectly. That is
      // a session-establishment race, not transport loss, and mixing the two
      // makes the number meaningless.
      //
      // So A initiates and B echoes each message it receives. Both directions
      // are still measured — B's replies traverse the wire independently — but
      // only one side opens the session, which is also how a real conversation
      // starts. (Simultaneous open is worth a scenario of its own; it is a real
      // and interesting case, just not this baseline.)
      if (ROLE === 'a') {
        for (let n = 1; n <= ROUNDS; n++) {
          await trySend(n);
          await waitUntil(startAt + n * SEND_INTERVAL_MS);
        }
      }

      await waitUntil(endAt);

      publish(ROLE, 'result', {
        role: ROLE,
        address: bot.identity.address,
        sent: sentByMe,
        received: [...receivedFromPeer].sort((x, y) => x - y),
      });

      // A bare "received 0" cannot distinguish "nothing arrived" from "arrived
      // but was not recognised", and those point at completely different
      // suspects. The breakdown of what the app actually persisted separates
      // them.
      const leftOnInbox = await bot.inboxDepth();
      const kinds = new Map<string, number>();
      for (const m of bot.captured) {
        const k = (m.content as { type?: string } | undefined)?.type ?? '<none>';
        kinds.set(k, (kinds.get(k) ?? 0) + 1);
      }
      // eslint-disable-next-line no-console
      console.log(
        `[dm-two-bot ${ROLE}] sent=${sentByMe.length}/${ROUNDS} ` +
          `received_from_peer=${receivedFromPeer.size} ` +
          `persisted=${bot.captured.length} ` +
          `leftOnMyInbox=${leftOnInbox} ` +
          `kinds={${[...kinds].map(([k, v]) => `${k}:${v}`).join(',')}} ` +
          `texts=[${bot.captured.map(textOf).filter(Boolean).slice(0, 12).join('|')}]`
      );

      // Local assertion only. The pass/fail on LOSS is the orchestrator's, because
      // only it sees both sides — this side cannot know how many the peer sent.
      // B's send count is driven by what arrives, so only A's is fixed.
      if (ROLE === 'a') expect(sentByMe.length).toBe(ROUNDS);
    } finally {
      await bot.stop();
    }
  }, 60 * 60 * 1000);
});
