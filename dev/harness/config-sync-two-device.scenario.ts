// NETWORKED. Does a setting made on one device actually reach another device?
//
// This is the first end-to-end measurement of config sync in this repo. Every
// existing check of it is a unit test against mocked storage and a mocked
// server; nothing has ever encrypted a real blob, POSTed it to the real relay,
// fetched it back, verified its signature and decrypted it. So "config sync
// works" has been an assumption, and several open issues suggest it may not be
// a safe one.
//
// ⚠️ Writes to a REAL settings row on production, for a throwaway bot account
// created by identity.ts. It never touches a human's account.
//
// Run: yarn harness config-sync          (skipped by HARNESS_OFFLINE=1)
//
// ─── Why one process is correct here, unlike the DM harness ─────────────────
//
// The DM harness insists on one bot per process, because mobile reaches ratchet
// and session state through module singletons that two bots would silently
// share. Config sync has no such state: it is encrypt → POST → GET → decrypt,
// keyed only on the account's private key. Its one singleton is the MMKV config
// store, and `clearConfigStorage()` empties that deterministically.
//
// So "a second device" is modelled as: same account, same keys, EMPTY local
// store. That is precisely what a reinstall or a new phone is, and it exercises
// the real wire format rather than a simulation of it. What it deliberately does
// NOT model is two devices publishing concurrently — that needs two processes,
// and it is the obvious next scenario.
//
// ─── Reading a failure honestly ─────────────────────────────────────────────
//
// If the adopt assertions fail, check the signature path BEFORE concluding the
// protocol is broken. `verifyConfigSignature` catches its own errors and returns
// false, and `getConfig` then returns the local config with no complaint — which
// looks exactly like "the remote never arrived". quorum-crypto-shim.ts exists
// for that reason, and the first assertion below is there to catch its absence
// rather than let it masquerade as a product bug.
import type { UserConfig } from '@quilibrium/quorum-shared';
import { loadOrCreateIdentity } from './identity';
import {
  getConfig,
  saveConfig,
  getLocalUserConfig,
  saveLocalUserConfig,
  clearConfigStorage,
} from '@/services/config/configService';
import { readLastPublish } from '@/services/config/lastPublish';

const OFFLINE = process.env.HARNESS_OFFLINE === '1';
const maybe = OFFLINE ? describe.skip : describe;

/** A value no other account would coincidentally hold, so adoption is provable. */
const marker = (label: string) => `harness-${label}-${Date.now()}`;

const baseConfig = (address: string, allowSync: boolean): UserConfig =>
  ({
    address,
    spaceIds: [],
    items: [],
    allowSync,
    nonRepudiable: true,
    timestamp: 0,
    notificationSettings: {},
    bookmarks: [],
    deletedBookmarkIds: [],
  }) as unknown as UserConfig;

maybe('config sync, two devices on one account (networked — production)', () => {
  it('carries a setting from one device to another, and keeps sync off device-local', async () => {
    const bot = await loadOrCreateIdentity('config-sync-bot');
    // Truncated on purpose: a full account address in a log is an identity, and
    // logs get pasted into issues. Six characters correlate lines without
    // identifying anything.
    const short = `${bot.address.slice(0, 8)}…`;

    // ── DEVICE A: publish ────────────────────────────────────────────────────
    clearConfigStorage();
    const nameA = marker('device-a');
    const deviceA = { ...baseConfig(bot.address, true), name: nameA } as UserConfig;

    await saveConfig(deviceA);

    const published = readLastPublish();
    // The instrument doubles as the assertion. If this is not 'published', the
    // upload never landed and every check below would be measuring nothing.
    expect(published?.outcome).toBe('published');
    expect(published?.payloadBytes).toBeGreaterThan(0);

    // The size nobody has measured on a real mobile publish. The server's true
    // limit is still unknown (two recorded readings contradict each other), and
    // this is the only place a real number is produced.
    console.log(
      `[config-sync] account=${short} published bytes=${published?.payloadBytes} spaces=${published?.spacesPublished}`
    );

    // ── DEVICE B: a reinstall, same account, empty local store ───────────────
    clearConfigStorage();
    expect(getLocalUserConfig(bot.address)).toBeNull();

    const adopted = await getConfig(bot.address);

    // THE measurement. Anything else failing here is a rig problem; this is the
    // product question.
    expect(adopted.name).toBe(nameA);
    console.log(`[config-sync] device B adopted name from the server: ${adopted.name === nameA}`);

    // A fresh device starts at OFF whatever the blob says, and the blob above
    // says `true`. This is the behaviour the device-local change introduced, and
    // the reason a restored phone pulls its settings but publishes nothing until
    // the user opts in.
    expect(adopted.allowSync).toBe(false);
    expect(getLocalUserConfig(bot.address)?.allowSync).toBe(false);

    // ── DEVICE B: a blob that says ON must not switch this device back on ────
    // The scenario the whole slice exists for: another device is still
    // publishing `allowSync: true`, and this one has been switched off.
    const local = getLocalUserConfig(bot.address)!;
    saveLocalUserConfig({
      ...local,
      allowSync: false,
      // Behind the server, so the remote genuinely wins and the adopt path runs.
      // Without this getConfig short-circuits on the equal-timestamp branch and
      // the assertion below would pass without exercising anything.
      timestamp: (local.timestamp ?? 0) - 1000,
    });

    const afterPull = await getConfig(bot.address);

    expect(afterPull.name).toBe(nameA); // the rest of the blob still arrives
    expect(afterPull.allowSync).toBe(false); // ...but not this field
    expect(getLocalUserConfig(bot.address)?.allowSync).toBe(false);

    // ── CONTROL ARM ─────────────────────────────────────────────────────────
    // Without it, a device-local rule hardcoded to `false` would satisfy every
    // assertion above while quietly disabling sync for every user.
    const onDevice = getLocalUserConfig(bot.address)!;
    saveLocalUserConfig({
      ...onDevice,
      allowSync: true,
      timestamp: (onDevice.timestamp ?? 0) - 1000,
    });

    const withSyncOn = await getConfig(bot.address);

    expect(withSyncOn.allowSync).toBe(true);
    expect(getLocalUserConfig(bot.address)?.allowSync).toBe(true);
  }, 300_000);

  it('a second published change also reaches the other device', async () => {
    // One round trip can pass on a stale row that happened to match. A second
    // publish with a different value proves the row is really being rewritten
    // and re-read, which is what "sync" means.
    const bot = await loadOrCreateIdentity('config-sync-bot');

    clearConfigStorage();
    const nameB = marker('device-a-second');
    await saveConfig({ ...baseConfig(bot.address, true), name: nameB } as UserConfig);
    expect(readLastPublish()?.outcome).toBe('published');

    clearConfigStorage();
    const adopted = await getConfig(bot.address);

    expect(adopted.name).toBe(nameB);
  }, 300_000);
});
