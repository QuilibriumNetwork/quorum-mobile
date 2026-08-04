---
type: bug
title: "Every logger call is a no-op in production builds, and logger.debug is dead even in dev"
status: in-progress
priority: high
created: 2026-08-04
updated: 2026-08-04
severity: high (not a defect in itself — it removes the evidence for every OTHER defect)
platforms: quorum-mobile (shared logger, so quorum-desktop has the same first half)
source: found while diagnosing a silently-dropped join on a real device during the join-authentication work (detail held privately)
related:
  - "quorum-desktop .agents/issues/.open/2026-08-01-every-logger-call-is-a-no-op-in-production-builds.md (the desktop half, filed first)"
  - "issues/.open/2026-08-04-mobile-receive-leave-posts-no-message-and-leaves-member-visible.md (diagnosed blind because of this)"
---

# The safety logs we keep adding do not exist where they are needed

## Status

**2026-08-04 — shipped in PR #227** (`fix: warnings and errors survive a release
build, and logger.debug works in dev`), squash-merged to master as `387bb1c`.

**Deliberately NOT moved to `.done/`.** This is a `type: bug`, and its own "How
to verify" section sets the bar at *"Confirm on a real release build, not by
reading — the whole point of this issue is that reading the code is what made
everyone assume the logs were there."* That has not been done. What HAS been
done is stronger than reading (the production bundle was built and inspected,
and a cold start was captured on a physical device), but it is still not the
stated criterion.

**To close this issue:** install `com.quilibrium.quorummobile.preview` from this
branch, cold-start it, and capture
`adb logcat -v time ReactNativeJS:V '*:S'`. Pass = warn lines such as
`[WS-retain] …` appear, and zero `[hub-log] listen-hub` / `[WS-RN]` debug lines
do. That is a definitive yes/no on the shipping configuration and needs no one
to read a terminal.

---

Fixed mobile-side only — no
quorum-shared release needed, because `logger.configure()` is already exported
and is enough to close both holes from the consumer side.

**Policy** (`services/observability/loggingPolicy.ts`, called from `index.js`
before the route tree loads): dev `minLevel: 'debug'`, production
`enabled: true, minLevel: 'warn'`. Option 1 + option 3 of "Fix direction".
Option 2 (the ring buffer) was considered and deliberately deferred — see below.

### What the audit changed about the plan

All 125 `logger.warn` and 5 `logger.error` sites were read before production
logging was switched on. Three findings worth keeping:

1. **`warn` was partly a workaround for hole 2.** The diff that introduced
   `[WS-in] SERVER REJECTED` (PR #180) reads
   `- logger.debug(...)` / `+ logger.warn(..., JSON.stringify(message))`, with a
   comment saying the debug line "was logged at debug and dropped". A line was
   escalated to `warn` *because `debug` was dead*. Fixing hole 2 removes that
   pressure; expect fewer inflated levels from here.
2. **Nothing was ever `__DEV__`-gated** — a repo-wide grep finds zero
   `__DEV__` guards on any logger call. Those 125 lines were dev-only purely
   *because of hole 1*. Switching production on is therefore not "letting
   existing warnings through", it is promoting 125 previously-unreviewed lines
   onto real devices. Hence the audit.
3. **The tier is 89% clean already.** Ids truncated to 8/10/12/16 chars,
   errors reduced to `e.message`, no message plaintext, no key material. The
   convention was real; it just was not load-bearing until now.

### Fixed

- 7 sites printing an untruncated id gained `.slice(0, N)`: `[Kicked]` ×2 and
  `[profile] * broadcast to space failed` ×2 (spaceId), `[messagesDb] migration`
  ×2 (raw storage key), `[DMConversationSettings]` (conversationId).
- The two receive-path logs that printed the frame itself (one **uncapped**)
  now go through `summarizeInbound()` in
  `services/observability/redactInbound.ts` — an allowlist: a field prints its
  value only if named, everything else prints `<type:size>`. A field the server
  starts sending later is redacted by default.
- 2 demotions to `debug`: `[session-confirm] sender session CONFIRMED` (a
  success) and the `!config.allowSync` branch of ConfigSync (the user's own
  setting working as configured). The sibling `!privateKey || !publicKey`
  branch stays `warn` — that one is a fault.

Four further demotion candidates were **rejected on a second read**:
`[poison-guard] deleting N dead envelope(s)` (dead envelopes are a symptom, and
this is field evidence for the DM investigation), `[Deregister] refused to
remove the only device` (returns `'failed'`), `[batch-control] kept in inbox for
retry` (only fires when an owner signature could not be checked), and
`[AudioSpace] join called outside provider` (a real programming error). The
first pass pattern-matched on wording instead of reading the branch.

### Full-fidelity captures are unaffected

`diag/dm-frame-trace` is unaffected by this change: its only two hunks in
`WebSocketContext.tsx` sit at master lines 2728 and 4577, disjoint from all five
edits made here (1447, 1464, 3226, 5656, 5673), so `git debug` rebases it
without conflict. Checked, not assumed.

Going forward, `summarizeInbound` is a standalone module nothing else imports,
so a diag branch that wants raw frames back overrides that one function instead
of patching hot lines inside the receive path. Raw-frame and ratchet-state
instrumentation stays off master, which is where it has always belonged. Note
mobile's rig never dumped key material anyway — it fingerprints `root_key`
through an 8-char FNV-1a hash. `[XPDUMP]`, which does carry live ratchet keys,
is desktop-side and is absent from desktop master too.

### Verified

- 361 tests pass (28 suites), including 11 new ones.
- **The new tests were falsified**: with `installLoggingPolicy` neutered,
  exactly 3 of the 5 policy tests go red — "warn reaches console" and "error
  reaches console" under `__DEV__ = false`, and "debug reaches console" under
  `__DEV__ = true`. The 2 that stay green assert *unchanged* behaviour, so that
  is the correct result. They assert against the real shared logger by spying on
  `console`; a mocked logger would have passed against the bug itself.
- `tsc --noEmit`: 11 errors before the change, 11 after, none in touched files.
- **On-device, via `adb logcat -v time ReactNativeJS:V '*:S'` over 30s on a
  physical Android device mid-sync:**

  | logcat priority | lines in 30s |
  |---|---|
  | D (debug) | 679 |
  | W (warn) | **2** |

  Hole 2 is therefore confirmed on real hardware, not just under jest —
  `[WS-in …] log-since-result …` (`WebSocketContext.tsx:5692`, a `logger.debug`)
  reaches logcat, which was impossible before.

  And this is the production-volume number the plan was missing: **a release
  build would have printed 2 lines in those 30 seconds**, both
  `[WS-retain] replaying N frame(s) from the previous connection (gave up on N
  past the retention limits)` — a genuinely useful signal. Quiet enough to read,
  present enough to diagnose. No `warn` sits on a hot path.

- **Cold start on the same device** (`com.quilibrium.quorummobile.debug`
  force-stopped and relaunched, new PID, 35s capture — a JS reload cannot test
  this, because it reuses the JS global object and `global.Buffer` would already
  be set, masking exactly the ordering bug worth looking for):

  - **0 fatals, 0 `AndroidRuntime` errors, 0 `E` lines, 0 Buffer /
    `ReferenceError` / "is not defined" hits.** `Running "main" with {…}`
    present. The `index.js` placement is safe on a genuine cold boot.
  - `[hub-log] listen-hub hub=… inbox=…` (`WebSocketContext.tsx:6380`, a
    `logger.debug`) appeared **6 times** — hole 2 confirmed on cold start, not
    only on reload.
  - 1558 D / 10 W. Of the 10 warns, **9 are React Native's own "Require cycle"
    notices**, which Metro emits only under `__DEV__` and a release bundle does
    not contain. The tenth is `[WS-retain] replaying 6 frame(s) from the
    previous connection`. So **a release build would print roughly one warn for
    an entire cold boot** — the strongest evidence yet that `minLevel: 'warn'`
    is the right cut.

  The 679 debug lines are concentrated, not diffuse: `[WS-RN]` 221 (inside
  quorum-shared, `logger.debug`, already capped to 200 chars) and
  `[poison-guard] skipped N undecryptable DM envelope(s) this batch` 196
  (`WebSocketContext.tsx:5434`, `logger.debug`, once per batch). Both are
  correctly levelled and invisible in production; they are a dev-ergonomics
  problem, not a policy problem.

- **Inspected the real production bundle**, built with
  `npx expo export:embed --platform android --dev false` (a plain minified
  bundle rather than the `.hbc` Hermes bytecode `expo export` emits, which is
  not greppable). Two things read straight off the shipping artifact:

  ```js
  // module 488 — the policy, minified
  e.installLoggingPolicy=function(){ if(l)return; l=!0,
    n.logger.configure({enabled:!0,minLevel:'warn'}) };

  // module 0 — the entry, in order
  r(d[0]),                          // 1   Buffer polyfill
  r(d[1]),                          // 17  get-random-values
  r(d[2]).installLoggingPolicy(),   // 488 the policy
  r(d[3]), r(d[4]),                 //     background tasks
  r(d[5]).installLivekitWebrtcPolyfill(),
  r(d[6])                           //     expo-router/entry
  ```

  `__DEV__` was substituted `false` and the ternary **constant-folded to
  `'warn'`**; `enabled:!0` is the `true` that overrides the shared module's
  `enabled = false`. The call survives tree-shaking, and it runs third — after
  the Buffer polyfill, before expo-router and every route module. This is what
  rules out the dangerous failure mode: not that production is too *loud*, but
  that `configure()` silently fails to apply and production stays as silent as
  it is today while everyone believes it was fixed.

  Method note: a first grep for `minLevel:"warn"` returned nothing and briefly
  looked like proof of exactly that failure. The bundle uses single quotes. Check
  the pattern before believing the alarm.

### A real leak, found by the review checklist and fixed

The first cut of `summarizeInbound` allowlisted field NAMES but never
constrained the VALUE TYPE:

```ts
summary[key] = typeof value === 'string' ? truncate(value, MAX_FIELD) : value;
```

A server answering `error: { code: 500, inbox: '0x…', detail: '…' }` would have
had that whole object serialised — untruncated address included — because
`error` is on the allowlist. `error` is exactly the field most likely to arrive
structured. Now only primitives print; anything structured falls back to
`shapeOf()` like an unrecognised field.

The regression test was falsified before being trusted: with the fix reverted it
emits
`{"error":{"code":500,"inbox":"0xabcdef0123456789abcdef0123456789","detail":"secret-detail"}}`.

Worth noting how it was caught. The independent review agent dispatched for this
change **died silently, producing a 0-byte output file and no notification** —
so there was no independent review. The bug was found by working through the
adversarial questions written *for* that agent, one of which was "can a
sensitive value land under an allowlisted key name". The checklist carried the
value, not the agent. Write the questions down even when reviewing your own
work, and check that a dispatched review actually returned something.

### Side observation, not chased here

`[poison-guard] skipped 1 undecryptable DM envelope(s) this batch` fired **196
times in 30 seconds** on an ordinary session. Whether that is 196 distinct
undecryptable envelopes or one envelope being re-fetched in a loop was not
determined, but either reading is worth a look and both are relevant to the DM
delivery investigation (#183).
- Every added `.slice()` was traced for null-safety (e.g. `spaceId` is
  hard-returned on null at `WebSocketContext.tsx:846`, long before the `[Kicked]`
  handler at `:1447`) — a throw inside a `catch` block would have been worse
  than the leak it fixes.

### Not done

- **Nothing has been RUN on a release build.** The static check below removes
  essentially all of the doubt (the compiled values are literals, so there is no
  branch left to behave differently), but a `preview` install and logcat capture
  would be the last word. Cheap to do later; not worth blocking on.
- **The ring buffer (option 2) was not built.** Deferred deliberately: a buffer
  of routine chatter evicts the evidence before a user can navigate to a Copy
  button, so it is only worth building over a channel of rare events. Revisit if
  the warn tier proves too noisy or too quiet in the field.

## Two holes, one file

`node_modules/@quilibrium/quorum-shared/src/utils/logger.ts` (READ, verified in
the version mobile actually has installed):

```ts
const LOG_LEVELS = { debug: 0, log: 1, info: 2, warn: 3, error: 4 };
let config = { enabled: true, minLevel: 'log' };

function detectEnvironment(): boolean {
  if (typeof __DEV__ !== 'undefined') return __DEV__;   // React Native
  ...
}
config.enabled = detectEnvironment();                    // runs once at import

function shouldLog(level) {
  if (!config.enabled) return false;                     // <-- before the level check
  return LOG_LEVELS[level] >= LOG_LEVELS[config.minLevel];
}
```

**Hole 1 — production is completely silent.** `__DEV__` is `false` in a released
RN/Hermes bundle, so `config.enabled` is `false`, and `shouldLog` bails before it
ever considers the level. `logger.error` is discarded exactly like
`logger.debug`. There is no severity that survives.

**Hole 2 — `debug` is dead in dev too.** `minLevel` defaults to `'log'` (1) and
`debug` is 0, so `0 >= 1` is false. Every `logger.debug(...)` in the app is
unreachable even with Metro attached.

Nothing calls `logger.configure()` or `logger.enable()` anywhere in the shipping
app (grep: the only call site is `dev/harness/shim.ts`, dev tooling that the app
never loads). Both are exported and would work — they are simply never used.

## Why this is high and not a nit

The whole control-message hardening programme (#217, #221, #222, and the join
work of 2026-08-04) is built on **fail closed, and log the reason**. Every one of
those reason strings goes to a logger that is off in production:

- `[control-auth] join dropped: <reason>` — `warn`
- `[control-auth] leave dropped: ...` — `warn`
- `[control-auth] <type> dropped: owner signature ...` — `warn`
- `[control-auth] join accepted` / `leave accepted` — `debug`, so dead **everywhere**

So a user whose genuine join is rejected in the field generates **no evidence at
all**. That is not hypothetical: on 2026-08-04 a bug did exactly this — a real
desktop join was silently dropped on mobile, the member appeared as a bare
address, and the only reason it was ever diagnosed is that it was caught on a
DEV build during a deliberate test. In production it would have been an
unexplainable "sometimes people don't show up properly" report.

Hole 2 also cost real time the same day: the `accepted` line was searched for in
a Metro log where it could never have appeared, and its absence was nearly read
as evidence of a second bug.

## Fix direction

Not obvious enough to just do — it is a shared-package change affecting both
clients, so it wants a decision rather than a patch:

1. **Let `warn` and `error` through in production.** Smallest change: move the
   `enabled` check after the level check, or make `detectEnvironment` set
   `minLevel: 'warn'` in production instead of disabling outright. Cost: console
   noise for real users, and log lines can leak identifiers — the existing calls
   already slice ids to 12 chars, which suggests that was considered.
2. **A local diagnostics ring buffer.** Keep the console silent but retain the
   last N warn/error lines in memory, exportable from a debug screen. No leakage
   by default, and an actual artifact to ask a user for.
3. **Fix `minLevel` for dev at least**, so `logger.debug` works when `__DEV__`.
   Cheapest of the three and independently worth doing.

(1) and (3) are small. (2) is the one that actually pays off for field bugs.
Desktop's issue proposes the same shapes; do these together so the two clients
do not diverge on logging behaviour.

## Interim workaround for anyone debugging

`logger.configure({ minLevel: 'debug' })` and `logger.enable()` are both
exported and work. Calling them early in app startup (temporarily, behind a dev
flag) restores full logging for a debugging session.

## How to verify

- A `logger.debug` line appears in Metro on a dev build.
- Whatever policy is chosen for production, a dropped control message leaves a
  retrievable trace — console, buffer or both — on a release build.
- Confirm on a real release build, not by reading: the whole point of this issue
  is that reading the code is what made everyone assume the logs were there.

*Last updated: 2026-08-04*

