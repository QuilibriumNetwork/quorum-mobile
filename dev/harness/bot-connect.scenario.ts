// NETWORKED. Mounts a full headless mobile client and lets it bring ITSELF up.
//
//   yarn harness bot-connect          (skip with HARNESS_OFFLINE=1)
//
// This is the proof that the provider-rendering approach works at all: the bot
// never calls connect(). It mounts WebSocketProvider authenticated, and mobile's
// own effect loads the device keys, opens the socket and subscribes to the device
// inbox. If this passes, mobile's connect path runs headlessly end to end.
//
// ⚠️ Talks to the PRODUCTION relay with a throwaway account. See identity.ts.
import { createBot } from './bot';

const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE ? describe.skip : describe;

maybe('bot-connect (networked — production relay)', () => {
  it('a mounted bot connects and subscribes without being told to', async () => {
    const bot = await createBot('connect-bot');
    try {
      await bot.waitForConnected();
      expect(bot.connectionState()).toBe('connected');

      // The device must be in the account's registration, read back from the
      // relay rather than trusted locally — a device missing there is how the
      // "peer prunes sessions for an unregistered device" failure starts.
      const reg = await bot.registration();
      const inboxes = (reg?.device_registrations ?? []).map(
        (d: { inbox_registration?: { inbox_address?: string } }) =>
          d.inbox_registration?.inbox_address
      );
      expect(inboxes).toContain(bot.identity.inboxAddress);

      // Device count is worth seeing in the log: harness runs that mint a new
      // device every time would show it climbing, and would also inflate the
      // send fan-out this bench measures.
      // eslint-disable-next-line no-console
      console.log(
        `[bot-connect] ${bot.identity.address.slice(0, 12)} ` +
          `devices=${(reg?.device_registrations ?? []).length} ` +
          `inbox=${bot.identity.inboxAddress.slice(0, 16)}`
      );

      // Stay up briefly: a socket that connects and immediately drops would
      // otherwise read as success.
      await new Promise((r) => setTimeout(r, 3000));
      expect(bot.connectionState()).toBe('connected');
    } finally {
      await bot.stop();
    }
  }, 180_000);
});
