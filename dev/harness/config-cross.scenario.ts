// CROSS-CLIENT. DESKTOP publishes a user config; this half reads it back.
//
//   yarn harness:config-cross     (from the DESKTOP repo — runs both halves)
//   yarn harness config-cross     (this half alone, after desktop has published)
//
// This is the mobile half, and it is the one that matters: everything checked
// before it was same-client. Mobile's own `config-sync-two-device` scenario
// proves mobile round-trips its OWN blob — real evidence about the wire format,
// but silent about the other client. The two ConfigService implementations are
// independent code sharing only a type, and the known merge-asymmetry issue
// exists precisely because they drifted apart.
//
// The desktop half publishes as the SAME account, using the throwaway key this
// repo's harness owns (dev/harness/.state/config-sync-bot.json), then writes
// what it published to a handoff file. This half asserts against that file
// rather than a constant, so the two repos cannot drift into agreeing with each
// other about a value neither actually sent.
//
// ⚠️ Ordering is real, not cosmetic. Without a fresh handoff this scenario has
// nothing to verify, and a stale one would let it pass against a row desktop
// wrote days ago. Both are guarded below rather than left to produce a
// confident wrong answer.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadOrCreateIdentity } from './identity';
import { getConfig, getLocalUserConfig, clearConfigStorage } from '@/services/config/configService';

const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const HANDOFF = resolve(__dirname, '.state/rendezvous/config-cross.json');

/** How old a handoff may be before it is treated as a different run's leftovers. */
const MAX_HANDOFF_AGE_MS = 30 * 60 * 1000;

const maybe = OFFLINE ? describe.skip : describe;

maybe('config sync, desktop → mobile (networked — production)', () => {
  it('adopts a config that DESKTOP published for the same account', async () => {
    if (!existsSync(HANDOFF)) {
      throw new Error(
        `No handoff at ${HANDOFF}.\n` +
          'The desktop half publishes first. From the desktop repo:\n' +
          '  yarn harness config-cross'
      );
    }

    const handoff = JSON.parse(readFileSync(HANDOFF, 'utf8')) as {
      publishedBy: string;
      at: number;
      name: string;
      profile_image: string;
    };

    // A stale handoff is the failure mode that would quietly turn this into a
    // no-op: the assertions would still pass, against a row from an old run,
    // while proving nothing about the code as it stands today.
    const age = Date.now() - handoff.at;
    expect(handoff.publishedBy).toBe('desktop');
    if (age > MAX_HANDOFF_AGE_MS) {
      throw new Error(
        `Handoff is ${Math.round(age / 60_000)} minutes old, which is older than this ` +
          'check trusts. Re-run the desktop half so the row on the relay matches it.'
      );
    }

    // Same account as desktop published for — this repo owns the key.
    const bot = await loadOrCreateIdentity('config-sync-bot');

    // A brand-new device: nothing local at all, so everything asserted below
    // can only have come off the relay.
    clearConfigStorage();
    expect(getLocalUserConfig(bot.address)).toBeNull();

    const adopted = await getConfig(bot.address);

    // THE cross-client assertion. A short string and a bulk field, because the
    // name alone would pass even if the image were being dropped.
    expect(adopted.name).toBe(handoff.name);
    expect((adopted as unknown as { profile_image?: string }).profile_image).toBe(
      handoff.profile_image
    );

    // Desktop published `allowSync: true`. Mobile must still refuse to inherit
    // it — this is the device-local rule, now proven across clients rather than
    // only against mobile's own blob.
    expect(adopted.allowSync).toBe(false);

    console.log(
      `[config-cross] mobile adopted desktop's config: name=${adopted.name === handoff.name} image=${
        (adopted as unknown as { profile_image?: string }).profile_image ===
        handoff.profile_image
      }`
    );
  }, 300_000);
});
