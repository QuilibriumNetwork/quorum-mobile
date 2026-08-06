---
type: bug
title: "Desktop ↔ mobile space messaging: desktop→mobile dropped at decrypt_failed; mobile→desktop arrives with 'invalid signature' warning"
status: open
created: 2026-06-13
severity: high
repo: quorum-mobile + quorum-desktop
area: messaging / E2E crypto / signature verification
discovered-during: "manual testing of branch harden-unsupported-message-types — confirmed NOT caused by that change (see scope note)"
related:
  - "quorum-desktop/.agents/bugs/2026-06-13-space-members-missing-no-join-row.md (the missing-space_members-row problem, desktop side)"
  - "../.done/2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md (same family: desktop→mobile silently dropped in the batch path; that one was an Android optInt timestamp overflow, fixed PR #79)"
  - "../reports/2026-06-12-permission-and-message-parity-findings-index.md"
---

# Desktop ↔ mobile messaging broken: two independent failures

## Status

NEEDS FULL RETEST (2026-07-02): five relevant fixes shipped since the last update (mobile #88 joinedAt, #89 post+embeddedMedia, #142 signing controls; desktop #199 member upsert + null-guard, #202 sync-path 'post' fix) but neither core symptom has been re-observed since. Adjacent bug 2 (update-profile canonicalize) FIXED 2026-07-15 (mobile branch fix-space-profile-updates, commit 2bc486c — canonicalizeContent now has an update-profile branch matching shared byte-for-byte; mobile→desktop profile updates verify). Two earlier root-cause theories (address-format mismatch; native-vs-WASM Ed448) REFUTED by direct test — do not resurrect.


> **Capturing a round for this bug?** The DM diagnostic rig lives on the local,
> never-pushed branch `diag/dm-frame-trace`; `master` carries none of it. Get onto
> it with **`git debug`** — it refuses to run on a dirty tree, rebases the rig onto
> master, re-applies the `node_modules` transport patch (wiped by every
> `yarn install`), and prints a BUILD CHECK proving which probes and shipped fixes
> are actually compiled in. **Never check out the rig by SHA** — `git debug`
> rebases, so SHAs written in docs go stale immediately, and a round captured from
> a stale head already faked 21 losses once. Full rig docs:
> [§D of the DM master report](2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md)
> and [scripts/README.md](../.done/2026-06-21-mute-and-block-overhaul/README.md).

Two symptoms, observed together, that turn out to be **causally independent** (an early
analysis wrongly fused them under one "identity mismatch" cause):

| Direction | Text | Image | Observed behaviour |
|-----------|------|-------|--------------------|
| Desktop → mobile | ❌ never appears | ❌ never appears | Arrives over the wire, then dropped at the native decrypt gate (`decrypt_failed`) before the handler runs |
| Mobile → desktop | ✅ arrives | ✅ arrives | But every message shows **"message does not have a valid signature. This may not be from the sender."** |

> Pre-reload, mobile→desktop text looked like it wasn't arriving and only images did; a full
> Metro reload fixed that — it was a stale-bundle artifact. The table above is the stable state.

The "invalid signature" warning is emitted on the **desktop** side only (the string does not exist
in quorum-mobile source — grepped).

---

> **➡️ HANDOFF 2026-07-20:** the pure-transport residual described below now has its own
> master report with full code recon, ranked hypotheses (zombie socket / fire-and-forget
> sends / ignored log-append-acks), a ready instrumentation branch (`debug/transport-trace`)
> and a live test protocol: `.agents/issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md`.
> Track transport work THERE; this report stays as the signature/decrypt history archive.

## ⚡⚡ RETEST 2026-07-19 — SIGNATURE HALF RESOLVED; residual is PURE TRANSPORT (delay + loss)

Effectively the retest this report has been waiting for, run during the space
control-message-auth + multi-device-signing work (see
`.agents/reports/2026-07-19-signing-key-multidevice-hunt-tracker.md`, Results
G/H). Same account, desktop + physical Android, a fresh space.

**Symptom A ("invalid signature" mobile→desktop) — appears RESOLVED.**
- mobile→desktop posts now render **SIGNED** on desktop (badge), and
  desktop→mobile deletes verify on mobile with `signed=true` →
  `verdict=ok-own-message` → applied (temp `[DELTEST]` warn logs in
  `WebSocketContext.tsx` remove-message handlers, live + batch). So the
  (publicKey, messageBytes, signature) triple now agrees cross-platform.
- Why it's fixed: (a) mobile **removed its local `canonicalizeContent`** and
  now builds the messageId via shared **`buildMessageFingerprint`** for BOTH
  send and receive (branch `fix/multidevice-space-signing-key` + auth PR
  #160) — this closes the last input-divergence class the 2026-06-14 analysis
  narrowed to (control types also now scope-bind spaceId+channelId, verified
  matching). (b) the **signing-key split** makes a synced device sign with the
  join-bound key its member row actually binds (was: a per-device key nobody
  could resolve). Adjacent bug 2 (update-profile canonicalize) is moot — there
  is no local canonicalize branch to drift anymore.

**Residual is PURE DELIVERY/TRANSPORT — this is now the whole bug:**
- desktop→mobile can show **0% for minutes, then ALL land at once (~2 min
  batches)**; a **rebundle / WS reconnect reliably flushes a stuck backlog**
  (30-min-delayed deletes all delivered + applied immediately on restart).
- mobile→desktop feels **~50-70%, variable**; and **genuine loss** occurs too
  (some messages never arrive, not just delayed) — so it's delay AND loss.
- **control messages (deletes) ride the same delayed transport** — the reason
  deletes "didn't apply" was non-delivery, not the auth (auth verified fine
  once delivered).
- The signature/auth LAYER is exonerated; the failure is in **delivery/hub
  transport + the inbox flush trigger** (why does a backlog only drain on
  reconnect, and why is anything permanently lost?).

**Diagnostic lever for the next session:** the `[DELTEST live/batch] RX /
APPLIED / DROPPED` warn logs make the receive side fully visible (RX = reached
JS; none = dropped before JS at the native decrypt gate or never delivered).
Pair with the WS drain/drop probes documented at the bottom of this file to
localize delay-vs-native-drop. (These `[DELTEST]` logs are temporary, being
reverted before the signing branch ships.)

**Still owed on the DESKTOP side:** control-message denials are silent bare
`return`s (no log) → the mobile→desktop delete direction can't be observed;
desktop agent should add deny-logging (tracker item D4). And the DM-transport
master (`quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-
unreliable-master.md`, now marked solved) may need reopening if the SPACE
delay/flush pattern shares a root with it.

---

## ⚡ What changed since 2026-06-14 (verified in both repos' code, 2026-07-02)

Five fixes shipped that touch this bug's terrain. **Nobody has re-run the repro since** — the
symptom table above describes the pre-fix world and may be substantially stale. The cheapest
next action is now a **retest**, not more analysis.

| Fix | Where | Status | What it changes here |
|---|---|---|---|
| `joinedAt` in mobile join signature (Adjacent bug 1) | mobile PR #88 | ✅ shipped (`useSpaceActions.ts:586-625`) | mobile joins now verify on desktop → mobile senders can get a `space_members` row via the join path |
| `post`+`embeddedMedia` convergence — render AND send | mobile PR #89 | ✅ shipped (render `components/Chat/types.ts:424-446`; send `spaceMessageService.ts:1073-1149`) | the live-app "desktop images never show on mobile" issue should be FIXED; mobile also no longer sends space images as `embed` — it emits desktop's `post`+`embeddedMedia` shape |
| Sync-path hardcoded `'post'` in messageId recompute (Symptom A leading suspect) | desktop PR #202 (2026-06-14) | ✅ shipped (now `message.content.type`, `MessageService.ts:~4292`) | the confirmed desktop defect that nulled signatures on non-post synced messages is gone |
| Member upsert + participant-null guard | desktop PR #199 (2026-06-13) | ✅ shipped (verify block `MessageService.ts:~3269-3330`) | desktop now recovers a member row from normal message traffic when the join broadcast was missed, AND fixed a TypeError that **silently dropped messages on non-repudiable spaces** when `participant` was null — a drop path this report never knew about |
| Message signing controls (spaces + DMs) | mobile PR #142 (2026-06-26) | ✅ shipped | mobile space/DM sends can now legitimately be **unsigned**; desktop's verify block only runs when `publicKey && signature` are present, so unsigned mobile messages bypass the warning entirely |

**Still NOT done (re-verified 2026-07-02):**
- ~~**Adjacent bug 2** — mobile `canonicalizeContent` has no `update-profile` branch~~
  **RESOLVED (superseded 2026-07-19):** first fixed 2026-07-15 (update-profile branch added), then
  made fully moot when mobile **removed `canonicalizeContent` entirely** and adopted shared
  `buildMessageFingerprint` for all types (see the 2026-07-19 retest section above). No local
  canonicalize remains to diverge.
- **Symptom B native probe** — never added (no `reason` field in `QuorumCryptoModule.kt`).
  The dev-app "nothing appears" state was never diagnosed further.
- Line-drift note: the JS drop gate is now `WebSocketContext.tsx:3295` (was `:3017`); desktop's
  live verify block is now `MessageService.ts:3269-3330` (was `:3164-3228`). Mobile is now on
  shared `2.1.0-33` (raw evidence below was captured on `-26`/`-29`).

**Why a retest comes first:** #202 removes the leading Symptom-A suspect; #199 + #88 attack both
causes of the null `participant` AND remove a silent drop on non-repudiable spaces; #89 should fix
the live-app image half outright. Any of Symptom A / Symptom B may already be gone, changed shape,
or been reduced to the still-unfixed update-profile case. See the reordered Next steps.

**Live datapoint (user-reported 2026-07-02, post-all-fixes):** message delivery is still failing —
**DMs mostly** (messages between different users not landing), **channels occasionally** (rare).
So the shipped fixes did not fully resolve delivery. Note the scope split: this report diagnoses
the SPACE/channel path (hub broadcast + native batch decrypt); **DM delivery rides a different
transport** (per-user inbox + Double-Ratchet sessions) and now has its own master report:
`quorum-desktop/.agents/bugs/2026-07-02-dm-message-delivery-unreliable-master.md` — created
2026-07-02 with a full code walk (three silent-drop sites found in desktop's DM receive path, incl.
a decrypt-fail handler that deletes both the message AND the session), four ranked hypotheses, and
a ready-to-run desktop↔desktop debug-session kit. The rare channel failures belong to THIS
report's retest; the DM failures belong to that one.

---

## Current understanding (2026-06-14, after deep cross-repo verification + a live crypto test)

**Two theories have been REFUTED by direct evidence — do not resurrect either:**

1. **❌ Address-format mismatch.** Claimed desktop derived raw-32-byte addresses while mobile used
   the 34-byte multihash `Qm…` form. FALSE. The misread was desktop's `sha256.digest(pk).bytes`,
   which in the `multiformats` lib IS the 34-byte multihash (`[0x12,0x20,…]`), not the raw digest.
   **Runtime-proven both sides emit the identical `Qm…` address** from the same key
   (`QmPeerEEgVKpYZKYuFu2J49zHXnA8vZtEqHMtpB4imzzzz`). Lead dev also confirmed desktop addresses are
   the `Qm…` form. → No format mismatch, no migration, no "which side moves" decision.

2. **❌ Native-vs-WASM Ed448 incompatibility.** Claimed mobile's native Rust Ed448 signatures don't
   verify under desktop's WASM Ed448. FALSE. Direct test: a fixed keypair + fixed message, signed by
   mobile native `signEd448` (live app, temp probe in `app/_layout.tsx`, since reverted), checked
   against desktop WASM `js_verify_ed448` (Node, same `channelwasm_bg.wasm` the app loads). The two
   signatures were **byte-identical** and WASM verified the native sig (`'true'`). They're almost
   certainly the same Rust `channel` crate compiled two ways (mobile UniFFI `libchannel.so`; desktop
   wasm-bindgen `channelwasm`). → The signature primitive is sound; the failure is in the *inputs*.

### Symptom A — mobile → desktop "invalid signature" on every post/image

Walking the exact desktop verify block (`MessageService.ts:3164-3228`) with real values:

- Runs only on **non-repudiable** spaces (`!space.isRepudiable`, :3166). Mobile creates spaces
  non-repudiable by default (`spaceService.ts:159`, `isRepudiable ?? false`), so the block runs.
  **(PROVEN.)**
- `participant` (`getSpaceMember(senderId)`) is **null** for a mobile sender (no `space_members`
  row — see Symptom-A-root). With it null, `inboxMismatch` evaluates to `undefined` (falsy) and
  does **NOT** fire. **(PROVEN — re-ran the exact JS expression: `!false && undefined !== addr &&
  undefined` → `undefined`.)**
- `messageIdMismatch` is **false** for a normal `post`: mobile's `canonicalizeContent` and shared's
  `canonicalize` produce byte-identical output for `post`/`embed`/`sticker`/`reaction`/
  `remove-message`/`edit-message`, and the messageId hash inputs (`nonce + type + senderId +
  canonical`) plus the base64 of the signed bytes are byte-identical across platforms. **(PROVEN,
  side-by-side read + runtime check.)**
- So control reaches `ch.js_verify_ed448(...)` (:3214) and it returns ≠ `'true'`. **(PROVEN by
  elimination.)** And the primitive is sound (theory #2 above), so for a REAL message **the
  (publicKey, messageBytes, signature) triple desktop feeds the verifier must differ from what
  mobile actually signed.**

**⚠️ ALL three mechanical sub-hypotheses have now been TESTED and REFUTED (2026-06-14). The
signature path is correct in isolation — the bug is NOT in the offline-reproducible logic.**

- **A1 — wrong public key. ❌ REFUTED.** Reproduced mobile's full send (compute messageId → sign
  with inbox priv → hex-encode sig for the wire) and desktop's full verify (recompute messageId →
  `js_verify_ed448` with the attached pubkey), using a real Ed448 keypair via the WASM. Keys are
  **57 bytes** (correct Ed448), formats line up (mobile stores keys as hex; desktop feeds
  `Buffer.from(publicKey,'hex')`), and **verify returns `'true'`**. The attached pubkey matches the
  signing key.
- **A2 — messageId divergence. ❌ REFUTED.** Computed mobile's `canonicalizeContent`-based messageId
  vs desktop's `canonicalize`-based recompute for the same inputs: **byte-identical** for `post`
  (string AND array text), `post` with unicode (emoji/accents), and `embed`. The only divergence is
  a `post` with NO `text` field at all (mobile → `""`, shared → `undefined`) — a malformed/empty
  message nobody sends. So desktop's recompute == mobile's signed bytes for every real message type.
- **A3 — signature hex/base64 round-trip. ❌ REFUTED** (covered by the A1 full-chain test, which
  includes mobile's `sig b64 → hex` wire conversion and desktop's `hex → b64` verify conversion —
  the round-trip survives and verify passes).

**What the refutations leave (genuinely needs a captured live message — NOT offline-resolvable):**
The clean simulation of the documented path PASSES, so the live failure must come from a difference
between that path and reality. Remaining candidates, in rough likelihood order:
1. **CONFIRMED desktop defect (leading lead): the sync-receive path hardcodes `'post'`.**
   `MessageService.ts:4188-4193` recomputes the messageId with the literal string `'post'` instead
   of `message.content.type`, then at `:4199-4201` compares it to the transmitted `messageId` and
   **nulls publicKey+signature on mismatch**. For a real `post` this is correct (`'post'` == the
   type). For an **`embed` / `sticker` / any non-post**, the recompute is wrong → mismatch → signature
   nulled → message effectively rejected. The **live** receive path (`:3182`) correctly uses
   `decryptedContent.content.type`, so this defect is **sync-path-only**. This maps onto the live
   observation **"text (`post`) works, images (`embed`) don't"** IF real mobile→desktop messages reach
   desktop via the sync path. **Still UNPROVEN: that real images traverse `:4185` rather than the
   correct live path — that's the one fact left to confirm, and it needs a real message.** (This is a
   DESKTOP-side fix — `'post'` → `message.content.type` at `:4189`.)
2. **The wire mutates the triple.** Hub-envelope serialization re-encodes `publicKey`/`signature`/a
   content field between mobile send and desktop verify (a field reordered, re-cased, or re-typed).
3. **Real data differs from the sample** (the real inbox key isn't 57 bytes; content carries extra
   fields the canonicalize ignores but the messageId/signature don't).

Confirming #1 or capturing the actual on-desktop triple requires a real message — that is the
remaining work that genuinely needs the live/dev app, not offline analysis.

**Symptom-A-root (why `participant` is null for mobile senders) — PROVEN, two compounding causes:**
1. **Transport.** Desktop's own bug doc (`2026-06-13-space-members-missing-no-join-row.md`) shows
   52% of senders lack a `space_members` row because join broadcasts are fire-and-forget and often
   never arrive — hits desktop↔desktop too, independent of mobile.
2. **Missing `joinedAt` in mobile's join signature (mobile-specific, see Adjacent bug 1).**

> Nulling the signature is cosmetic-ish for `post` (renders with a warning). For `update-profile`
> it's worse — desktop drops the message entirely (Adjacent bug 2).

### Symptom B — desktop → mobile dropped at `decrypt_failed`

**Member state is NOT the cause.** `space_members` is **never an input to decryption** — not in the
JS batch assembly (`WebSocketContext.tsx:2798-2834` passes only `tr_state`, `tr_fallback_state`,
hub/config private keys, self-address) nor in the native decryptor (`QuorumCryptoModule.kt` /
`.swift`). No code path links a missing member row to any `decrypt_failed` site. **(PROVEN.)**

`decrypt_failed` is **four different failures** under one label (`QuorumCryptoModule.kt`,
`batchProcessMessages` from :792):

| Site | Meaning | Implication |
|------|---------|-------------|
| `:962` | unsealed payload `type` ∉ {control, message} | serialization/format — NOT ratchet |
| `:1001` | empty TR envelope after extraction | wire-format |
| `:1019` | empty TR state for `${spaceId}/${spaceId}` | ratchet never bootstrapped / cleared |
| `:1059` | TR decrypt threw on BOTH primary + fallback | genuine ratchet / `peer_id_map` divergence |

**HYPOTHESIS B (leading, not yet observed live):** site `:1019` or `:1059` — a Triple-Ratchet
session / `peer_id_map` mismatch, downstream of the same missed-join-broadcast transport problem.
Independent of Symptom A.

> **⚠️ TWO ENVIRONMENTS — do not conflate (clarified 2026-06-14):** the symptom differs by env,
> and the two envs differ in TWO variables at once (user account AND build), so neither result
> cleanly explains the other.
>
> | Env | Build | User | Code-instrumentable? | desktop→mobile result |
> |-----|-------|------|----------------------|-----------------------|
> | **Live app** | production (shipped) | a real, different user | ❌ no — can't add probes | **TEXT appears**, images/GIFs do NOT |
> | **Dev app** | Metro / local build | the **test user** | ✅ yes — this is the debug env | **NOTHING appears** (original Symptom B) |
>
> **What the live-app result proves (and only this):** desktop→mobile decryption is NOT
> categorically broken — a healthy account on a production build CAN decrypt desktop's text.
> Decryption is type-agnostic (decrypts bytes, not "text vs image"), so text appearing means the
> ratchet/session is fine there. This **kills "desktop→mobile crypto is fundamentally incompatible"**
> as a universal claim.
>
> **What it does NOT tell us:** why the **test user on the dev build** still gets NOTHING. The two
> envs differ in BOTH the account (test vs real → different join/session/ratchet state) AND the build
> (dev native module + `-29` shared vs production). Either or both could explain the dev-app failure.
> Do not assume the live-app behaviour transfers.
>
> **✅ The live-app "text yes / images no" half is SOLVED and is NOT a crypto bug.** The image is
> dropped at RENDER, not decrypt: desktop sends a captioned image as `type:'post'` + an
> `embeddedMedia[]` array, and **mobile never reads `embeddedMedia`** (zero refs repo-wide) — it only
> extracts an image when `content.type === 'embed'`, so a desktop `post`+`embeddedMedia` renders as
> caption text only, image silently dropped. Fully diagnosed with the mobile-side render fix
> specified in **`.agents/issues/.done/2026-06-13-converge-image-caption-to-post-embeddedmedia.md`** (§1 is
> the standalone fix; mobile-only, no shared change). This is SEPARATE from the desktop sync-path
> `'post'` signature bug (now fixed on desktop) and from Symptom B (test user gets nothing). Three
> distinct issues — keep them separate.
>
> **Actionable next step — debug in the DEV app (the one you can instrument AND the one fully
> broken).** The "nothing appears" dev-app state is the original, reproducible Symptom B. Add the
> native per-site `reason` probe to learn which of the four `decrypt_failed` sites fires for the test
> user — that single fact picks ratchet (`:1019`/`:1059`) vs format (`:962`/`:1001`). (Native rebuild
> required — see Next steps #2.)
>
> **The live-app image-only failure is a SEPARATE, currently un-probeable observation.** Can't add
> code to the production build, so it's a "note it, can't chase it directly" data point — likely a
> POST-decrypt embed fetch/render issue (a healthy account decrypts the `embed` but the image
> URL/bytes don't load), but UNPROVEN. If it later reproduces in the dev app, localize with a JS probe
> on the space receive path (does the `embed` reach `saveMessage`? the `imageUrl` value? any
> fetch/render error?). Ruled out by reading (not causes): the DM-preview `embed` branch
> (`WebSocketContext.tsx:2493`, preview text only, DM path) and the read-only-channel gate
> (`:3285-3306`, drops `post`/`embed`/`sticker` **equally**).

> **Caveat (relevant once the dev-app decrypt is unblocked):** mobile's space SEND path is
> **hub-envelope-only, no Triple Ratchet** (`spaceMessageService.ts:314-315`). If desktop→mobile
> space messages are also hub-only, a TR `decrypt_failed` would be surprising and points at
> `:962`/`:1001` (format) instead. The native per-site `reason` probe resolves this.

---

## Adjacent bugs — confirmed, independently fixable (no format risk)

**1. Missing `joinedAt` in mobile's join signature. ✅ FIXED — shipped in mobile PR #88
(verified in code 2026-07-02: `hooks/chat/useSpaceActions.ts:586-625` signs the 10-field blob
ending in `joinedAt`).** Original finding kept for the record: desktop verifies the join signature over a
10-field blob ending in `participant.joinedAt` (`MessageService.ts:3251-3261`); mobile signs a
**9-field** blob ending at `displayName`, and its participant object has no `joinedAt`
(`useSpaceActions.ts:589-597`, `:604-616`). Desktop concatenates the literal `"undefined"` →
join-signature verify fails → the `if (result==='true')` branch is skipped → `saveSpaceMember` is
never called → **mobile members never get a `space_members` row on desktop via the join path.**
(PROVEN, both repos quoted.) Conditional second divergence: mobile signs the join blob with `btoa()`
(latin1) vs desktop's `Buffer.from(...,'utf-8')` — only diverges for non-ASCII display names/icons.
*Fix:* add `joinedAt` to mobile's signed blob + participant object (and align the encoding).

**2. `update-profile` canonicalize divergence. ✅ FIXED 2026-07-15 (mobile branch
fix-space-profile-updates, commit 2bc486c).** Was: `canonicalizeContent` had no
`update-profile` branch and fell to `JSON.stringify(content)`, while shared's `canonicalize`
returns `type + displayName + userIcon` (raw concat, no `?? ''` fallback — verified against the
installed 2.1.0-33 bundle) → messageId hashes never matched → signature nulled → desktop silently
dropped mobile's profile updates. Fix added the matching branch to
`services/space/spaceMessageService.ts` (`content.type + displayName + userIcon`, no fallback).
Mobile→desktop profile updates (name change) runtime-confirmed crossing 2026-07-15.

> Neither fix is *guaranteed* to resolve Symptom A or B — they fix real adjacent defects. The
> `joinedAt` fix does remove one of the two reasons `participant` is null on desktop.

---

## Next steps (in priority order — REORDERED 2026-07-02 after the five shipped fixes)

1. **RETEST the full matrix before any new analysis.** Desktop + mobile in the same space, both
   directions, text AND image, on current builds (mobile master w/ shared `2.1.0-33` + #88/#89/#142;
   desktop w/ #199/#202). Record per cell: appears? / warning? / nothing. Expectations if the
   shipped fixes did their job: mobile→desktop non-post no longer signature-nulled (#202); mobile
   senders gain a member row via join (#88) or first message (#199); desktop→mobile images render
   (#89). Whatever still fails defines the REAL remaining bug — everything below is conditional on
   this.
2. **If mobile→desktop still warns "invalid signature": one-message in-situ probe (desktop).** For
   ONE real mobile→desktop post, log just before the verify call (now `MessageService.ts:~3315`):
   `{ inboxMismatch, messageIdMismatch, desktop-recomputed messageId hex vs received
   decryptedContent.messageId, received publicKey, js_verify_ed448 result }`. The
   recomputed-vs-mobile-signed bytes tell wrong-key vs messageId-divergence vs round-trip apart.
   (JS-only, no native rebuild.)
3. **If desktop→mobile (dev app) still shows nothing: native per-site `reason` probe (mobile).**
   Add a distinguishing `reason` at each of the four `decrypt_failed` sites so the JS gate (now
   `WebSocketContext.tsx:3295`) logs WHICH fired — picks `:1019/:1059` (ratchet) vs `:962/:1001`
   (format), and resolves the hub-only-vs-TR caveat. **Requires a native rebuild**
   (`.\.agents\scripts\build-app.ps1`); per memory `verify-statically-before-expensive-rebuilds`,
   confirm the edit is in the exact compiled file first. quorum-crypto is a `file:` dep copied into
   `node_modules` — the edit may need to land in `node_modules/quorum-crypto/` too (memory
   `file-dep-native-module-build-uses-node-modules-copy`).
4. **Ship the remaining adjacent fix: `update-profile` branch in mobile's `canonicalizeContent`**
   (`spaceMessageService.ts:150-227`) matching shared's `type + displayName + userIcon`. Statically
   verifiable, small, valuable regardless of how the retest goes — without it, mobile space-profile
   updates keep failing desktop's messageId check.

---

## Raw evidence (captured 2026-06-13; probes since reverted)

> Gathered on mobile pinned to the stale `@quilibrium/quorum-shared@2.1.0-26`. Mobile is now on
> `2.1.0-29` (PR #84). The `-29` bump did **NOT** fix either symptom (re-tested 2026-06-14, JS-only
> Metro reload). The `decrypt_failed` failure is at least partly native, which a JS-only dist bump
> wouldn't touch — consistent with "no change". So the specific logcat below predates `-29`, but the
> symptoms reproduce unchanged.

Three temp probes in `WebSocketContext.tsx`:
1. `[WS-PROBE] draining N` (top of `processMessageQueue` drain) — **FIRED** on desktop→mobile: the
   message reaches mobile and enters the pipeline.
2. `[SpaceMsg] type=…` (handler entry, `:1665`) — **DID NOT fire**: never reached the handler.
3. Drop-gate probe (`:3017`) — **FIRED** with `status=decrypt_failed`:
   ```
   LOG  [WS-PROBE] draining 1 incoming msg(s)
   LOG  [WS-PROBE] space msg DROPPED status=decrypt_failed space=Qma7EGH7 ts=1781363395580
   LOG  [WS-PROBE] draining 2 incoming msg(s)
   LOG  [WS-PROBE] space msg DROPPED status=decrypt_failed space=Qma7EGH7 ts=1781363400687
   ```
   Every desktop→mobile message in space `Qma7EGH7` dropped at `decrypt_failed` (status was
   `decrypt_failed`, NOT `unseal_failed` — the outer envelope unsealed fine; failure is later).

The drop point — `context/WebSocketContext.tsx:3017`, inside `applySpaceGroupResults`:
```ts
if (msgResult.status === 'unseal_failed' || msgResult.status === 'decrypt_failed') {
  continue;   // desktop message silently dropped here, before the [SpaceMsg] log
}
```

### How to reproduce
1. Desktop + mobile in the same space.
2. Desktop → mobile: nothing appears on mobile.
3. Mobile → desktop: appears on desktop with the invalid-signature warning.
4. With probes re-added: `[WS-PROBE] draining` fires, `[SpaceMsg] type=` does not, `DROPPED
   status=decrypt_failed` fires for the desktop message.

> **Scope note — NOT caused by the message-type default-deny work.** Found while testing branch
> `harden-unsupported-message-types`, but these messages are dropped at the native-decrypt gate
> (`WebSocketContext.tsx:3017`), strictly BEFORE any code that branch touches. Pre-existing.

---

## Reference appendix

### Re-instrumentation snippets (probes are reverted; re-add as needed)
**JS side** (`context/WebSocketContext.tsx`) — promote `logger.debug` → `logger.log` (debug is
suppressed by default, memory `shared-logger-debug-hidden-by-default`; JS logs go to the **Metro
terminal**, not adb logcat):
- `:1665` entry log: `logger.debug(\`[SpaceMsg] type=...\`)` → `logger.log(...)`.
- Drain probe — in `processMessageQueue` after the `splice`:
  `logger.log(\`[WS-PROBE] draining ${batch.length} incoming msg(s)\`);`
- Drop-gate probe — at the `unseal_failed || decrypt_failed` gate (`:3017`):
  `logger.log(\`[WS-PROBE] DROPPED status=${msgResult.status} space=${spaceId?.slice(0,8)} ts=${msgResult.timestamp}\`);`

**Native side** (`modules/quorum-crypto/android/src/main/java/expo/modules/quorumcrypto/QuorumCryptoModule.kt`)
— add a `reason` at each `decrypt_failed` site, e.g. `:962` → `put("reason","payload_type="+payloadType)`,
`:1019`/`:1059` → the caught exception message. Requires a native rebuild (see Next steps #2).

### Native code map (where decrypt_failed is produced)
- JS drop gate: `context/WebSocketContext.tsx:3017` (`applySpaceGroupResults`).
- Native batch decryptor: `QuorumCryptoModule.kt` `batchProcessMessages` (from `:792`). `decrypt_failed`
  at `:962` (bad payload type), `:1001` (empty TR envelope), `:1019`, `:1059` (ratchet decrypt fail).
  `unseal_failed` at `:897/:910/:930/:942`.
- iOS equivalent: `modules/quorum-crypto/ios/QuorumCryptoModule.swift` (check whether Android-only).

### Dev-environment entry points (project memory)
- **Build the app:** `.\.agents\scripts\build-app.ps1` (one-button native rebuild).
- **Start Metro:** `.agents/scripts/dev-start-mobile.ps1` (phone) or `dev-start-emulator.ps1`.
- **🚨 NEVER uninstall `com.quilibrium.quorummobile`** — real app, real user data. Only the `.debug`
  package is safe. (memory `never-uninstall-real-app-data-loss`)
- Native code: `modules/quorum-crypto/{android,ios}/`. JS bridge: `services/crypto/native-provider.ts`
  (status union types at `:1265` and `:1317`).

---
*Created: 2026-06-13*
*Last updated: 2026-07-19*
