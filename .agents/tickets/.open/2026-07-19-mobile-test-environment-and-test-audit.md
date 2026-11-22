---
type: task
title: "Mobile test-coverage audit (jest env SHIPPED; decide what ELSE to test)"
status: open
priority: low
created: 2026-07-19
platforms: quorum-mobile
---

# Mobile test environment + test audit

## Status

BACKLOG) — Phase 1+2 DONE/SHIPPED 2026-07-20 (jest-expo env #161; auth wiring tests #162; `yarn test` = 26 green). Phase 3 AUDIT DONE 2026-07-20 (prioritized list appended below). Remaining = *implementing* the Tier-1 suites; each is a small independent PR. Not urgent — the security-critical tests are shipped.


## Why

Mobile has **zero test infrastructure** (verified 2026-07-19: no runner, no
`test` script, no test files, no jest/vitest in devDependencies). Desktop has a
real unit suite (`src/dev/tests/`, e.g. `MessageService.unit.test.tsx` §3b–3e
covering control-message auth) and quorum-shared has 41 tests on `messageAuth`
alone. Mobile is the only repo of the three where nothing is executable-verified.

This matters more than usual here: LaMat's review levers are behaviour and
tests — green/red is a signal he can read, diffs are not (see AGENTS.md task
decomposition section). A test suite is his objective safety net on mobile the
same way it already is on desktop.

Why mobile never had tests: the message logic historically lived inside
`context/WebSocketContext.tsx` (~5,000-line React context tangled with the WS
client, React Query, and native modules) — untestable without heavy mocking.
That changed with the space-auth work (branch
`fix/space-control-message-auth-signatures`): logic extracted into plain
modules like `services/space/spaceMessageAuth.ts` with only two mockable
native touchpoints. Extraction-then-test is now a viable pattern.

## Scope

### Phase 1 — environment setup

1. Add `jest-expo` preset + `jest` + `@types/jest` (devDependencies), a
   `"test": "jest"` script, and a `jest.config.js` scoped to `**/*.test.ts(x)`.
2. Mocks for the native touchpoints the first suite needs:
   - `services/crypto/native-signing-provider` (`verifyEd448` → controllable
     boolean, or a pure-JS ed448 impl if trivially available)
   - `services/storage/mmkvAdapter` (`getSpaceMembers` / `getSpaceMember` →
     in-memory fixtures)
   - `react-native-mmkv` / Nitro modules generally (jest-expo handles most RN
     core; native custom modules need manual `jest.mock`)
3. Machine note: Jest runs in plain Node — the Metro/Watchman
   accented-username problems on this machine do NOT apply. Keep
   `--runInBand`-friendly config anyway.
4. Wire `yarn test` into the repo docs (CLAUDE.md verification commands) so
   agents run it alongside tsc + lint.

### Phase 2 — first suite: space message auth (the motivating feature)

Mirror desktop's §3b–3e wiring tests for mobile's own glue (the shared verdict
logic is already covered by 41 tests in quorum-shared — do NOT re-test it):

1. **Cross-platform golden vectors (highest value):** fixed
   nonce/sender/space/channel/content for a `post`, `remove-message`,
   `edit-message`, `mute` → assert `generateMessageIdHash` /
   `buildMessageFingerprint` produce byte-identical fingerprints + messageIds
   to hardcoded expected values (generate the expected values once from
   shared/desktop). This permanently pins the canonicalization + scope-binding
   agreement whose silent drift was the core cross-platform failure mode this
   feature fixed. Any future divergence = red test instead of "deletes stopped
   syncing".
2. **`spaceMessageAuth.ts` wiring** (mocked verifier + member fixtures):
   - forged senderId (valid signature, own key) → verdict deny
   - claimed member missing from member table → fail closed (deny)
   - kicked member's key → deny
   - tampered wire messageId → `verifySpaceMessageSignature` null
   - unsigned control message → deny regardless of `isRepudiable`
   - unsigned edit of unsigned own message, repudiable space → allow
   - `isUpdateProfileAuthorized`: registered key + mismatched senderId →
     false; unknown key (rotation) → true; unsigned → false
   - `shouldStripEveryoneMention`: unverified → strip; verified+match → keep

### Phase 3 — repo-wide test audit (INSTRUCTION — do not do in this session)

After Phase 1–2 land, run a dedicated audit pass over the mobile codebase to
decide what ELSE deserves tests. Ground rules for that audit:

- Target **pure/extractable logic**, not components or the React contexts.
  Candidates to evaluate: `utils/editHistory` (applyReceivedEdit/
  buildLocalEdits replay + history semantics), `utils/messagePreview`,
  `services/notifications/logMentionOrReply` (classify()),
  `services/notifications/notificationPrefs`, mention extraction call sites,
  `services/space/modMuteStorage` (expiry/replay), hub log cursor/sync
  helpers, DM receive guards if extractable.
- For logic still trapped inside `WebSocketContext.tsx`, the audit should
  recommend **extract-then-test** targets (the spaceMessageAuth precedent),
  not context-mounting tests.
- Explicitly out of scope: UI/component snapshot tests, E2E (Detox/Maestro) —
  low confidence per maintenance unit; device testing covers that layer.
- Output: a prioritized list (value × effort) appended to this task file, each
  item with the concrete module and 3–5 example cases.

## Sequencing / notes

- Do NOT block the space-auth PR on this — shared already tests the verdict
  logic; device testing covers the wiring for that branch.
- Phase 2 depends on the space-auth branch being merged (or run against it).
- `.agents/` is gitignored on mobile, but the test files themselves are
  normal repo code — commit them; branch name/PR text must stay
  self-explanatory (no internal jargon).

---

# Phase 3 — repo-wide test audit (RESULTS, 2026-07-20)

Method: read every candidate the Scope section named plus a sweep of `utils/*`
and `services/*` for pure/extractable logic. Judged each on **value** (does a
silent regression here cause a real, hard-to-notice user-facing bug?) × **effort**
(native coupling, whether the logic is already exported). Confirmed the harness:
`yarn jest` runs green in ~1.5s with no MMKV mock present yet.

## Key finding: build ONE shared in-memory MMKV mock first (the enabling step)

Almost every remaining high-value target is a plain function that reads/writes
an MMKV store (`createMMKV({ id })`, or `createMirroredMMKV` which wraps it).
There is currently **no MMKV mock** — that single missing piece is what gates
Tier 1. Write it once and 4 suites unlock with near-zero per-suite cost:

- `jest/mockMMKV.js`: a ~30-line `Map`-backed implementation of the methods the
  app uses (`getString/set/remove/getAllKeys/getBoolean/getNumber/contains/
clearAll`), with a `createMMKV()` factory returning a fresh store per `id`.
- Wire via `jest.mock('react-native-mmkv', () => require('./jest/mockMMKV'))`
  (or a per-suite `jest.mock`). This also covers `createMirroredMMKV`, since it
  calls `createMMKV` internally — **but** note `mirroredMMKV.ts` takes the iOS
  branch when `Platform.OS === 'ios'` (jest-expo's default) and then
  `require`s the native `QuorumCryptoModule`. For `notificationPrefs` tests
  either set `Platform.OS = 'android'` in the suite or `jest.mock` the
  `@/services/storage/mirroredMMKV` module directly. Prefer mocking
  `mirroredMMKV` — smaller blast radius.
- Add `jest.useFakeTimers()` support in mind: expiry-based modules assert on
  `Date.now()`; drive it with `jest.setSystemTime`.

This mock is itself worth a tiny sanity test, but its real payoff is Tier 1.

## Tier 1 — high value × low effort (do these; each a small standalone PR)

### T1.1 `utils/editHistory.ts` — edit replay guard (ZERO native coupling)

Pure functions, only a type import. This is the dedup/history-integrity core a
replayed edit-message must not corrupt — a silent regression = "my edit history
vanished" or a duplicate delivery wiping stored versions. Highest value-per-line
in the repo and testable with no mocks at all.

- `buildLocalEdits`: `saveEditHistory` false → `[]`; true + no prior → single
  entry; true + prior → appended (order preserved).
- `applyReceivedEdit`: same `editNonce` already in `lastModifiedHash` →
  `changed:false` and `edits` returned UNTOUCHED (the replay no-op).
- empty/absent `editNonce` (legacy sender) → guard skipped, always applies.
- `saveEditHistory` false on receive → `edits:[]` even when `current.edits` had
  prior versions (the OFF-drops-history contract).
- new nonce → `changed:true`, `lastModifiedHash` set to the nonce, entry appended.

### T1.2 `services/space/modMuteStorage.ts` — moderation-mute expiry + replay

MMKV mock + fake timers. Security-adjacent: a mute that doesn't expire keeps a
user silenced past their term; a missed replay guard re-applies a rescinded mute.

- `isUserMuted` true inside window, false once `expiresAt <= now` (lazy expiry via
  `setSystemTime`); `expiresAt` undefined → muted forever.
- `getMuteRecord` returns the record inside window, `null` once lapsed.
- `hasMuteId` true after `setMute` (replay guard); `markMuteIdSeen` marks an
  unmute echo so it can't re-trigger work.
- `removeMute` clears the record; `subscribeMutes`/`getMutesVersion` bumps on
  every write (one emit per mutation).
- malformed stored JSON → `isUserMuted` false / `getMuteRecord` null (defensive).

### T1.3 `services/notifications/mentionReplyLog.ts` — dedup, bound, 2-level read

MMKV mock. Drives the Notifications-tab inbox + per-channel bubbles; the
two-level read model (tab badge vs per-channel) is exactly the settled UX and is
easy to break silently.

- `appendMentionReplyLog` dedups by `id` (same msg via live + catch-up → ONE
  row), result is newest-first.
- log is bounded at `MAX_ENTRIES` (append a 201st → length stays 200, newest
  kept).
- `markChannelMentionsRead` never moves the watermark backwards (`Math.max`).
- `getUnreadCountForChannel` counts only `createdAt > readAt` and only that
  channel's entries.
- `getQuorumTabUnreadCount` (Level 1) is independent of per-channel read marks;
  `markQuorumTabSeen` clears it without marking any channel read.
- `getMentionReplyLog` coerces a legacy preview shape and returns `[]` on
  malformed storage.

### T1.4 `utils/messagePreview.ts` — preview/coerce branch matrix (ZERO coupling)

Type-only imports (`IconSymbolName`, shared types), so no mocks. Feeds the inbox,
DM list, and notification rows; `coerceMessagePreview` is explicitly "never
throws" defensive-on-read code that only tests can keep honest.

- `messagePreview` per content type: `post`/`event` array-join; `embed` video vs
  image; `call-event` missed/video/voice; `reaction` text; join/leave/kick/
  update-profile/remove-message kinds; unknown type → `{kind:'text',text:''}`.
- `coerceMessagePreview`: legacy string strips the emoji prefix; already-typed
  passthrough (with absent `text` defaulting to `''`); legacy raw-content object
  routes through `messagePreview`; `null`/junk → empty; never throws.
- `messageSenderName`: `'You'` for self; `display_name`/`name` from the member
  map; address truncation fallback; `undefined` when no address.
- `previewKindIcon` mapping is stable (a change here silently drops row icons —
  pin it; the docstring already warns the keys are IconSymbol-verified).

## Tier 2 — high value × medium effort

### T2.1 `services/notifications/notificationPrefs.ts` — mute resolution + mirror

MMKV mock + the `mirroredMMKV`/Platform caveat above + stub the fire-and-forget
`./pushPrefsSync` dynamic import. The global→space→channel gate and the
"unmute synced from another device re-enables the gate" mirror logic both have
real, subtle failure modes.

- `shouldNotifyForContext`: global off → false regardless; space off → false even
  if channel on; both on → true; context-less (`spaceId` omitted) respects global
  only.
- `getMutedSpaceIds` returns only explicit `false` spaces (defaults don't count).
- `mirrorSpaceMuteState`: a muted channel gate goes off; a channel NO LONGER in
  the muted set is re-enabled to `true`; `spaceMuted` flips the space gate;
  `knownChannelIds` defensively re-enables the rest.
- `readLegacyMutesForSpace` round-trips what `mirrorSpaceMuteState` wrote.

### T2.2 `services/notifications/logMentionOrReply.ts` — `classify()` precedence

`classify` is currently a module-private function → **export it** (tiny change,
the spaceMessageAuth precedent of a testable surface) rather than testing through
the MMKV-writing `logMentionOrReply`. Mock `@/services/config`
(`getLocalNotificationTypes`); let shared `getUserRoles`/`isMentionedWithSettings`
run for real. This is the inbox-vs-badge "can never disagree" guarantee.

- self sender (`sender === me`) → `null` (never self-notify).
- reply takes precedence over mention when a message is both.
- `reply` type disabled in prefs → falls through to mention classification.
- priority order among mentions: you > everyone > roles.
- no `userAddress` → `null`; a type the user disabled produces `null`.

## Tier 3 — lower value or higher effort (opportunistic / bundle-in)

- `utils/encoding.ts` — pure base64/hex/number-array converters with 8+ call
  sites. Cheap (no coupling) but low marginal risk. Cases: `base64ToHex` ↔
  `hexToBase64` round-trip, `numberArrayToBase64`, empty input, odd-length hex.
  Worth adding if a converter ever misbehaves; not on its own PR.
- `services/emojiFrecency.ts` — decay/ranking is pure but `private` and coupled
  to `expo-file-system`, and the code itself calls the data "non-critical". If
  ever touched, extract `calculateDecayedScore` + the ranking into a pure helper
  and test that; don't mock the filesystem just for this.
- `utils/formatMuteRemaining.ts`, `utils/validation.ts`, `utils/dateFormat.ts`,
  `utils/formatAddress.ts` — trivial formatters; the latter two mostly delegate
  to already-tested quorum-shared. Very low marginal value; skip unless a bug
  surfaces.

## Extract-then-test (recommended targets, NOT ready as unit tests)

Following the `spaceMessageAuth.ts` precedent (extract plain logic out of the
~5,000-line `WebSocketContext.tsx`, then unit-test the module):

- **DM receive guards** — dedup, the phantom "conversation-with-myself" row
  filtering, and receipt handling are still inline in `WebSocketContext`. High
  value (these are live cross-device bug areas), but blocked on extraction into
  e.g. `services/dm/dmReceiveGuards.ts` first. Recommend that extraction as its
  own task; the tests follow for free.
- **`services/notifications/hubLogClassifier.ts`** — heavily native (crypto +
  api + encryption-state store). Not a unit target; the iOS NSE path is covered
  by device testing. Leave out.

## Reaffirmed out of scope (per the Phase 3 ground rules)

UI/component snapshot tests; Detox/Maestro E2E; and
`services/farcaster/mentionExtraction.ts` (couples to `QueryClient` + the
network hypersnap client — an integration concern, not a unit one).

## Suggested sequencing

1. `jest/mockMMKV.js` (+ a one-liner sanity test).
2. T1.1 editHistory (no dependency on the mock — can land in parallel/first).
3. T1.2 modMuteStorage, T1.3 mentionReplyLog, T1.4 messagePreview.
4. T2.1 notificationPrefs, T2.2 logMentionOrReply (export `classify`).
5. File the DM-guards extraction as a separate task; tests come with it.

Each is an independent, self-explanatory PR (real repo code — commit it; no
`.agents/` jargon in branch/PR text).

_Last updated: 2026-07-20_
