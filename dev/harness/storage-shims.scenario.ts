// Offline. Proves the storage shims by driving mobile's REAL storage module,
// not by testing the shims in isolation.
//
// Testing a shim against itself proves nothing — it would pass even if the shim
// disagreed with what mobile's code actually expects. So this imports
// services/storage/messagesDb unmodified and exercises its real schema, real
// SQL and real migration path. If the shim's contract is wrong, that module
// breaks here rather than three slices later inside a DM scenario.
//
// Run: yarn harness
// Static imports throughout: moduleNameMapper substitutes the shims at
// RESOLUTION time, so import style is irrelevant to whether they apply. (An
// earlier draft used dynamic import() for supposed ordering control — it bought
// nothing and jest's CJS runner rejects it without --experimental-vm-modules.)
import { __resetAllMMKV, createMMKV } from './mmkv-shim';
import { __resetAllDatabases, openDatabaseSync } from './sqlite-shim';
import * as ss from './securestore-shim';
import * as messagesDb from '@/services/storage/messagesDb';
import { NativeCryptoProvider } from './wasm-provider-shim';

describe('storage shims (offline)', () => {
  afterEach(() => {
    __resetAllDatabases();
    __resetAllMMKV();
  });

  it("opens mobile's real message DB and round-trips a message through it", async () => {
    // messagesDb derives its SQLCipher key from the account ed448 private key in
    // SecureStore, and returns null if it is absent. Seeding it here mirrors what
    // onboarding does on a device.
    //
    // This is the hazard the securestore shim's header warns about, caught in
    // practice: an unseeded store looks to mobile like a first run. Here it only
    // costs a null DB, but on the identity path the same gap makes keyService
    // regenerate the whole device keyset and register a NEW device — against a
    // real account, that silently feeds the ghost-device problem. Seed fully.
    const ed = await new NativeCryptoProvider().generateEd448();
    const privHex = Buffer.from(new Uint8Array(ed.private_key)).toString('hex');
    await ss.setItemAsync('quorum.privateKey', privHex);

    const opened = await messagesDb.ensureDb();
    expect(opened).not.toBeNull();

    const spaceId = 'harness-space';
    const channelId = 'harness-channel';
    const message = {
      messageId: 'msg-1',
      spaceId,
      channelId,
      createdDate: 1_700_000_000_000,
      modifiedDate: 1_700_000_000_000,
      content: { type: 'post', senderId: 'sender-1', text: 'stored headlessly' },
    };

    await messagesDb.saveMessage(message as never);

    // getMessages returns GetMessagesResult — `{ messages, nextCursor,
    // prevCursor }`, with `messages` non-optional. The previous read guessed at
    // that shape, treating the result as possibly an array itself; the array
    // branch was unreachable and could not be typed, and the `?? []`-style
    // fallback would have turned a genuinely empty read into a pass rather than
    // the failure it should be. Read the field directly and let a shape change
    // break here.
    const back = await messagesDb.getMessages({ spaceId, channelId, limit: 10 } as never);
    expect(back.messages.length).toBeGreaterThan(0);
  });

  it('rolls a transaction back when the callback throws', async () => {
    // messagesDb's migration relies on this: a crash mid-channel must roll back
    // so the next launch re-migrates cleanly instead of finding half-written
    // rows. node:sqlite has no withTransactionSync, so the shim drives
    // BEGIN/COMMIT/ROLLBACK by hand — if that is wrong, durability is silently
    // gone and only shows up as corruption much later.
    const d = openDatabaseSync('rollback-test.db');
    d.execSync('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT);');
    d.runSync('INSERT INTO t (id, v) VALUES (?, ?);', [1, 'committed']);

    expect(() => {
      d.withTransactionSync(() => {
        d.runSync('INSERT INTO t (id, v) VALUES (?, ?);', [2, 'rolled back']);
        throw new Error('boom');
      });
    }).toThrow('boom');

    const all = d.getAllSync<{ id: number }>('SELECT id FROM t ORDER BY id;');
    expect(all.map((r) => r.id)).toEqual([1]);
  });

  it('swallows SQLCipher pragmas rather than throwing', async () => {
    // messagesDb opens with `PRAGMA key = "x'...'"`. node:sqlite has no such
    // pragma and would throw, which would make the DB unopenable here. The
    // harness DB is therefore PLAINTEXT — encryption at rest stays device-only.
    const d = openDatabaseSync('cipher-test.db');
    expect(() => d.execSync(`PRAGMA key = "x'deadbeef'";`)).not.toThrow();
    expect(() => d.execSync('PRAGMA journal_mode = WAL;')).not.toThrow();
  });

  it('keeps MMKV type semantics — getString must not return a number', async () => {
    // Real MMKV does not coerce across types, and mobile branches on `?? null`
    // in several places. A shim that coerced would make those branches behave
    // differently here than on device, which is the kind of divergence that
    // makes a harness untrustworthy.
    const s = createMMKV({ id: 'types' });
    s.set('n', 42);
    expect(s.getString('n')).toBeUndefined();
    expect(s.getNumber('n')).toBe(42);

    // Same id must return the same store — mobile calls createMMKV at module
    // scope from several files and relies on sharing.
    createMMKV({ id: 'types' }).set('shared', 'yes');
    expect(s.getString('shared')).toBe('yes');
  });

  it('namespaces SecureStore by keychainService', async () => {
    await ss.setItemAsync('k', 'a', { keychainService: 'svc-1' });
    await ss.setItemAsync('k', 'b', { keychainService: 'svc-2' });
    expect(await ss.getItemAsync('k', { keychainService: 'svc-1' })).toBe('a');
    expect(await ss.getItemAsync('k', { keychainService: 'svc-2' })).toBe('b');
    expect(await ss.getItemAsync('k')).toBeNull();
  });
});
