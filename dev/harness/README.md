# Headless DM harness (mobile)

Run **mobile's own client code** in Node, with no device, no emulator and no
Metro.

```bash
yarn harness:smoke        # offline, no keys, no network — safe anywhere
yarn harness              # every scenario (networked ones hit production)
yarn harness:dm           # the two-bot DM measurement — see below
yarn harness:config-sync  # does a setting on one device reach another? — see below
yarn harness:config-to-desktop  # mobile publishes for desktop to read — see below
```

## Config sync (`yarn harness:config-sync`)

The first end-to-end measurement of config sync in this repo. Everything else
checking it is a unit test against a mocked store and a mocked server; nothing
had ever encrypted a real blob, POSTed it, fetched it back, verified its
signature and decrypted it.

```
[config-sync] account=Qm……… published bytes=594 spaces=0
[config-sync] device B adopted name from the server: true
```

**One process is correct here, unlike the DM harness.** That rule exists because
DM state lives in ratchet/session singletons two bots would share. Config sync
has none: it is encrypt → POST → GET → decrypt, keyed only on the account key.
Its one singleton is the MMKV config store, and `clearConfigStorage()` empties it
deterministically — so "a second device" is *same account, same keys, empty local
store*, which is exactly what a reinstall is. Two devices publishing
**concurrently** is not modelled, and does need two processes.

`payloadBytes` in that first line is a real reading against the unknown server
size limit, which two earlier recorded observations contradict each other about.
Worth appending to the measurement log when the account shape is interesting.

### Cross-client: desktop → mobile

`config-sync-two-device` drives mobile's client on BOTH ends, so it proves the
wire format round-trips but says nothing about the other client. The two
`ConfigService` implementations are independent code sharing only a type, and
the known merge-asymmetry issue exists because they drifted.

`config-cross.scenario.ts` closes that. Run it **from the desktop repo**, which
owns the orchestrator:

```bash
cd ../quorum-desktop && yarn harness:config-cross
```

Desktop publishes a config for the shared throwaway account (it loads the key
this repo persists at `.state/config-sync-bot.json`), writes what it published
to `.state/rendezvous/config-cross.json`, then mobile pulls and asserts against
that file — not against a constant, which two repos can drift into agreeing
about without either having sent it.

The halves are sequential rather than concurrent, unlike the DM measurement.
That is a property of what is measured: a config is a row on a server, so one
client writes and the other reads later. DMs need both peers live because
delivery itself is under test.

Mobile's half refuses a handoff older than 30 minutes. Without that, a stale
file lets the run pass against a row desktop wrote days ago, which is a green
that proves nothing.

### Cross-client: mobile → desktop (`yarn harness:config-to-desktop`)

One direction is not symmetric evidence. "Desktop's blob decrypts on mobile"
says nothing about the reverse, because encryption, signing and field ordering
are written twice, once per client.

```bash
yarn harness:config-to-desktop
```

Mobile publishes for the shared account, proves the row landed by reading it
straight back off the relay, and writes what it sent to
`.state/rendezvous/config-from-mobile.json`.

**The reading half does not exist yet.** It belongs in quorum-desktop and should
mirror `config-cross.scenario.ts` here: read that file, refuse a handoff older
than 30 minutes, assert `name` and `profile_image` both arrive. Until it is
written, this scenario proves mobile publishes and nothing about desktop
adopting it.

A separate handoff file from `config-cross.json`, on purpose — sharing one would
let each direction overwrite the other's evidence, and a run could then pass
against values the client under test never sent. The scenario's filename avoids
the substring `config-cross` for a related reason: `yarn harness config-cross`
is a jest path *pattern*, so a colliding name would drag this publisher into the
desktop → mobile run, in an order jest does not guarantee.

> ⚠️ **A rig fault here impersonates a product bug, and did once.**
> `verifyConfigSignature` catches its own errors and returns `false`, after which
> `getConfig` silently keeps the local config. That is indistinguishable from
> "the remote never arrived". Two causes have already produced it: a missing
> `modules/quorum-crypto` mapping, and the dynamic-import transform being applied
> twice (see `babel.harness.js`). Check the signature path before concluding the
> protocol is broken.

`HARNESS_OFFLINE=1 yarn harness` skips everything networked.

## The measurement

`yarn harness:dm` starts **two processes**, one bot each, pairs them through a
run directory, exchanges numbered DMs and reports loss per direction:

```
[dm] A→B: sent=40 arrived=40 loss=0.0%
[dm] B→A: sent=40 arrived=40 loss=0.0%
[dm] total: 80/80 delivered
[dm] no loss.
```

Knobs: `HARNESS_ROUNDS`, `HARNESS_SEND_INTERVAL_MS`, `HARNESS_SETTLE_MS`.
Diagnostics: `HARNESS_LOG_DEBUG=1` turns on mobile's own `logger.debug` lines
(subscriptions, routing); `HARNESS_CRYPTO_DEBUG=1` reports crate-level crypto
failures with the function that produced them.

### 📊 Then append a row to the measurement log

**`quorum-desktop/.agents/docs/transport-measurements.md`** — one row per run:
date, what ran, the configuration, the result, and one line on what it changed.
Append-only; never rewrite a past row. (It lives in the desktop repo because
quorum-mobile's `.agents/` is gitignored, so nothing written here is shared or
recoverable.)

Record the **class** of the result, `arrival` or `decrypt`. A frame that arrives
and fails AEAD is *not* lost, and conflating the two has been the most expensive
mistake in this investigation.

Include the account shape and device count. They are variables in their own right:
every mobile bench result so far is on fresh single-device throwaways, which is
the least stressed configuration there is and **not** the one the field loss was
measured in.

**One bot per process, and that is not negotiable.** Mobile reaches storage
through module singletons, so two bots in one process would share identity and
ratchet state. `jest.isolateModulesAsync` isolates static require-graphs (proven
in `two-bot-feasibility.scenario.ts`) but *not* lazy `require()`s, which run
after the isolate closes — a silent leak that would fuse the two devices being
compared. See the header of `bot.ts`.

### Reading a result honestly

`leftOnMyInbox` in the per-role summary is the number of frames still queued on
that bot's device inbox. It is the difference between two very different
findings: frames still sitting there **arrived and were not consumed** (a
receive/session problem), while an empty inbox with missing messages means they
were never posted or went elsewhere. A delivery count alone cannot tell them
apart — an early run showed 100% "loss" that was in fact 40 frames delivered
perfectly and refused by the receiver's session.

Also drain before measuring (the scenario does): the relay redelivers un-acked
frames forever, so a run started on a backlog counts a previous run's
undecryptable leftovers as fresh losses.

## Why this exists

The DM investigation
(`.agents/issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md`)
ends at a wall: frames are handed to `ws.send`, signed, socket open, and never
arrive. Client visibility stops there, because below it is React Native's native
WebSocket. §26 puts the drop at ~80% node-side with that exact residual
unresolved.

Two `dm-loss` runs on the desktop harness (2026-07-28) measured **0.0% loss in
both directions**, on fresh throwaways and on aged multi-device accounts. That
is the first desktop-side measurement of this drop, and it moves probability
toward the RN native layer — but it does not isolate it, because desktop differs
from mobile in more than the transport.

**This harness is the single-variable experiment.** Mobile's client code, on
Node's `ws` transport:

- loss **disappears** ⟹ RN's native WebSocket is the culprit. Client-side, fixable.
- loss **appears** ⟹ RN native is exonerated; it is mobile's send logic or
  node-side handling of mobile-shaped writes, with a headless repro to hand over.

Every previous round changed platform, transport and client code together. This
changes one thing.

## ⚠️ What it deliberately does NOT test

The harness runs the Rust channel crate's **WASM** build, because Node cannot
load the ARM `.so` that the app uses through uniffi. Consequences, and they are
real:

- **The uniffi bridge is not exercised** — `parseNativeResult`, the base64/JSON
  round-trips, `ratchet-mutex` under genuine native async timing.
- **The native batch decrypt path cannot run at all.** `batchUnsealEnvelopes` and
  `batchProcessMessages` are native-only with no WASM equivalent. Scenarios must
  force the per-message path.
- **SQLCipher is not exercised** — the harness drops `PRAGMA key`.

A green harness therefore does **not** mean mobile is healthy. It means the
layers this harness covers are healthy.

## How it stays out of the app's way

| concern | how |
|---|---|
| `yarn test` collecting these files | Scenarios are `*.scenario.ts`. The app's `testMatch` is `**/*.test.ts` — it never matches. **`jest.config.js` is not modified.** |
| a new test-runner dependency | None. Reuses the installed jest via a separate `jest.harness.config.js`. |
| `package.json` / `yarn.lock` churn | Two script lines. **No dependency added**, no lockfile change, no `yarn install`, so the `postinstall` cache wipe never runs. |
| the app bundle | Nothing in `app/`, `components/`, `services/` or `hooks/` imports `dev/harness`. Metro never sees it. |

## The SDK alias — read before you touch `jest.harness.config.js`

The app has never needed `@quilibrium/quilibrium-js-sdk-channels` and **must not
gain it as a dependency**. Mobile reaches the Rust channel crate through uniffi
(`libchannel.so`, ARM machine code); the SDK carries the same crate's *other*
binding, the WASM one, which is the only build a Node process can execute.

So the harness config resolves it from the sibling desktop checkout:

```
../quorum-desktop/node_modules/@quilibrium/quilibrium-js-sdk-channels
```

On this machine that path is a **yarn-link symlink to the SDK source repo**,
which has no `node_modules` of its own — which is why `@babel/runtime` is also
mapped back to mobile's tree. If the SDK ever stops resolving, check that link
first.

Requirement: a `quorum-desktop` checkout beside this repo with dependencies
installed. Desktop's own harness already depends on a sibling SDK checkout for
the WASM binary, so this is the existing convention rather than a new one.

## ⚠️ Safety

- **Throwaway or dedicated test accounts only.** Never a personal identity.
- `dev/harness/.state/` and `dev/harness/logs/` are gitignored because they hold
  **real device keysets and ratchet key material**. Never commit them.
- Scenarios talk to **production** by default, the same relay the app uses. Runs
  create real registrations and real frames.
- Bots must persist their device keyset and reuse it, or every run adds a device
  registration to the account — feeding the known ghost-device accumulation
  problem.

## Layout

| file | role |
|---|---|
| `shim.ts` | browser globals the SDK bundle touches at import; optional debug logging |
| `babel.harness.js` | app babel config + one transform: lazy `import()` → `require` |
| `wasm-provider-shim.ts` | the crypto seam — WASM in place of uniffi, plus the native error conventions mobile's code expects |
| `wasm-signing-shim.ts`, `crypto-barrel-shim.ts` | the other two spellings of that seam |
| `context-barrel-shim.ts` | narrows `@/context` to the DM contexts |
| `mmkv-shim.ts`, `securestore-shim.ts`, `sqlite-shim.ts`, `filesystem-shim.ts`, `react-native-shim.ts` | device APIs with no Node equivalent |
| `react-test-renderer.d.ts` | ambient types for the untyped renderer — a local declaration, not a devDependency, because the harness adds none |
| `identity.ts` | registers/reuses an account through mobile's own onboarding |
| `bot.ts` | a full headless client: renders mobile's real `WebSocketProvider` |
| `rendezvous.ts`, `run-two-bots.mjs` | pairs two bot processes and reports loss |
| `*.scenario.ts` | the scenarios themselves |
| `../../jest.harness.config.js` | node env, module seams, `*.scenario.ts` matcher |

## Status

Mobile's real client code runs headlessly end to end: onboarding, connect,
subscribe, DM send and DM receive. Measured 2026-07-28 on production, two
throwaway accounts, one device each:

**40 rounds each direction — 80/80 delivered, 0.0% loss, zero decrypt failures,
both inboxes empty at the end.**

What that does and does not mean: mobile's own send/receive logic does not lose
these messages when RN's native WebSocket is removed. It moves probability
toward the native layer; it does not settle it, because a fresh two-device pair
may simply be the population least likely to show an intermittent, account-aged
fault. Treat it as one variable eliminated, not a verdict.

Three findings that cost real time and are worth knowing before touching this:

1. **The two crypto backends are not interchangeable at the error level.** They
   implement the same `CryptoProvider` interface, but mobile's native provider
   reports a decrypt failure as `{message: [], decryptionError}` and
   base64-decodes a string `message`, while `WasmCryptoProvider` throws for some
   errors and passes others through untouched. Mobile's app code is written
   against the native conventions, so an unbridged WASM provider turned a
   recoverable failure into `SyntaxError: Unexpected token 'D'` thrown far from
   its cause. `wasm-provider-shim.ts` now mirrors the native conventions.
2. **Simultaneous session open forks the pair.** Having both bots send from the
   same instant failed all 50 messages of a 25-round run on X3DH while every
   frame arrived perfectly — and the forked state persisted into later runs
   through retained undecryptable frames. The baseline scenario has one
   initiator; simultaneous open deserves its own scenario.
3. **App suite unaffected**: 13 suites / 108 tests, unchanged. `jest.config.js`
   is untouched, no dependency was added, `yarn.lock` was never modified.
4. **Optional-call syntax on a required method hides an API rename.**
   `ping` and `transport` called `ws.listen?.([...])`; `RNWebSocketClient` has
   never had `listen()` — the method is `subscribe()`. The `?.` swallowed it, so
   the subscribe never ran and both scenarios still passed, because their only
   assertion re-checked a connection that was already up. `tsc` had been
   reporting it the whole time and nothing runs `tsc`. Call required members
   unguarded here: a loud failure is the entire value of a scenario.

*Last updated: 2026-08-17*
