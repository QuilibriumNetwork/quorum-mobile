# Headless DM harness (mobile) — slice 1

Run **mobile's own client code** in Node, with no device, no emulator and no
Metro. Slice 1 proves the toolchain; later slices add identity, transport and
two-bot DM scenarios.

```bash
yarn harness:smoke     # offline, no keys, no network — safe anywhere
yarn harness           # every scenario
```

## Why this exists

The DM investigation
(`.agents/bugs/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md`)
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
| `shim.ts` | browser globals the SDK bundle touches at import (`window.Buffer`) |
| `smoke.scenario.ts` | offline: WASM loads, real keys, sign+verify with tamper rejection |
| `../../jest.harness.config.js` | node env, SDK alias, `*.scenario.ts` matcher |

## Status

- **Slice 1 — toolchain proven.** WASM loads under mobile's jest; the crate
  really executes (sign/verify, tampered message rejected). App suite unaffected:
  13 suites / 108 tests, unchanged.
- Slices 2-4 (crypto-provider shim, storage shims, DM core extraction, two-bot
  scenarios) are specced in
  `quorum-desktop/.agents/tasks/2026-07-27-cross-platform-dm-harness.md` — note
  that plan lives in the **desktop** repo, because `.agents/` is gitignored here.
