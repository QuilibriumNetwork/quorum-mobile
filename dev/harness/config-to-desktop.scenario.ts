// CROSS-CLIENT, the OTHER direction. MOBILE publishes a user config; desktop
// reads it back.
//
//   yarn harness:config-to-desktop     (this half — publish only)
//
// The existing `config-cross` scenario runs desktop → mobile. That direction
// alone is not symmetric evidence: the two ConfigService implementations are
// independent code sharing only a type, so "desktop's blob decrypts on mobile"
// says nothing about whether mobile's blob decrypts on desktop. Encryption,
// signing and field ordering are all written twice, and the known
// merge-asymmetry issue exists because the two drifted apart.
//
// This half is deliberately the mirror image of desktop's
// `config-cross.scenario.test.ts`: publish for the shared throwaway account,
// prove the row really landed, then write what was published to a handoff file
// for the other client to assert against.
//
// ─── The file name avoids "config-cross" on purpose ─────────────────────────
//
// `yarn harness config-cross` passes its argument to jest as a path PATTERN, so
// a file named `config-cross-publish` would be picked up by the existing
// desktop → mobile run as well. Two scenarios would then write and read the
// same account's row in an order jest does not guarantee, and the resulting
// failure would look like a protocol bug rather than a naming accident.
//
// ⚠️ Writes a REAL settings row on production for the throwaway bot account.
//
// ─── The desktop half is not written yet ────────────────────────────────────
//
// This scenario is complete and stands alone: it proves mobile can publish, and
// leaves the handoff on disk. The reading half belongs in quorum-desktop, which
// was not available to change in this session. Everything it needs is fixed
// here — the path and shape below are the contract, and it should mirror
// mobile's `config-cross.scenario.ts` (staleness guard included).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { UserConfig } from '@quilibrium/quorum-shared';
import { loadOrCreateIdentity } from './identity';
import {
  getConfig,
  saveConfig,
  getLocalUserConfig,
  clearConfigStorage,
} from '@/services/config/configService';
import { readLastPublish } from '@/services/config/lastPublish';

const OFFLINE = process.env.HARNESS_OFFLINE === '1';

/**
 * A DIFFERENT file from `config-cross.json`, which carries the desktop → mobile
 * direction. One file for both would let each run overwrite the other's
 * evidence, and a direction could then pass against the opposite direction's
 * values without either client having done anything.
 */
const HANDOFF = resolve(__dirname, '.state/rendezvous/config-from-mobile.json');

const maybe = OFFLINE ? describe.skip : describe;

maybe('config sync, mobile → desktop (networked — production)', () => {
  it('publishes a config for the shared account and hands it off to desktop', async () => {
    const bot = await loadOrCreateIdentity('config-sync-bot');
    // Truncated: a full account address in a log is an identity, and logs get
    // pasted into issues.
    const short = `${bot.address.slice(0, 8)}…`;

    const stamp = Date.now();
    // Distinctive enough that desktop adopting a stale row cannot pass by
    // coincidence, and covering both a short string and a bulk field — the name
    // alone would pass even if the image were being dropped in transit.
    const published = {
      name: `mobile-cross-${stamp}`,
      profile_image:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    };

    clearConfigStorage();
    await saveConfig({
      address: bot.address,
      spaceIds: [],
      items: [],
      allowSync: true,
      nonRepudiable: true,
      timestamp: 0,
      notificationSettings: {},
      bookmarks: [],
      deletedBookmarkIds: [],
      ...published,
    } as unknown as UserConfig);

    // The instrument doubles as the assertion, as it does in the two-device
    // scenario. Anything but 'published' means the upload never landed, and
    // writing a handoff at that point would send desktop to fail against a row
    // that was never there — pointing the verdict at the wrong client.
    const record = readLastPublish();
    expect(record?.outcome).toBe('published');
    expect(record?.payloadBytes).toBeGreaterThan(0);

    // 'published' means the POST was accepted. It does not mean the row can be
    // read back. Desktop's half makes the same distinction for the same reason,
    // and it is the only check that separates "accepted" from "stored".
    clearConfigStorage();
    expect(getLocalUserConfig(bot.address)).toBeNull();
    const stored = await getConfig(bot.address);
    expect(stored.name).toBe(published.name);

    console.log(
      `[config-cross] mobile published as ${short} bytes=${record?.payloadBytes} name=${published.name}`
    );

    mkdirSync(dirname(HANDOFF), { recursive: true });
    writeFileSync(
      HANDOFF,
      JSON.stringify({ publishedBy: 'mobile', at: Date.now(), ...published }, null, 2)
    );
    console.log(`[config-cross] handoff written for desktop: ${HANDOFF}`);
  }, 300_000);
});
