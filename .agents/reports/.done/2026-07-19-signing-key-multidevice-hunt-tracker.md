---
type: report
title: "MASTER TRACKER: space signing/auth multi-device hunt (mobile + desktop, 2 agents)"
status: ARCHIVED 2026-07-20 — mobile mission complete (both PRs shipped). Historical record.
created: 2026-07-19
platforms: quorum-mobile + quorum-shared + quorum-desktop
---

> **ARCHIVED 2026-07-20.** The mobile mission is done: verified-signer auth
> (PR #160) and the multi-device signing-key split (PR #162) shipped to master,
> device-validated + unit-tested (26 tests). Open items were extracted to
> durable homes so nothing depends on this archived doc:
>
> - Multi-device inbox-key bug (mobile fixed/shipped, desktop gaps + durable
>   follow-up): detail held privately, see `.agents/AGENTS.md` -> Security-sensitive issues
> - Transport flakiness (D8, the big open one): `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`
> - Add-only sync / ghost spaces (M2): `.agents/issues/.open/2026-07-19-config-sync-add-only-deleted-spaces-linger.md`
> - New space one-launch-late (M3): `.agents/issues/.open/2026-07-19-new-desktop-space-appears-one-launch-late-on-mobile.md`
> - Sticker sealHubEnvelope arg-swap: `.agents/issues/.done/2026-07-19-sticker-sealhubenvelope-args-swapped.md`
> - Config-400 evals-bloat (#108) + desktop D-items (D2/D3/D4/D7): desktop
>   agent's `.agents/` (relayed there during the hunt).
>   Everything below is the historical hunt record.

---

# Space signing & multi-device auth — master tracker

> One page to keep the whole 2026-07-19 cross-repo effort straight: what
> shipped, what broke, who owns what, how to test, and the plain-language
> explanations LaMat needs for the lead. TWO agents are working in parallel:
> the MOBILE agent (this repo) and the DESKTOP agent (quorum-desktop).

## The story so far, in plain language

1. **The original security bug:** space actions like delete/edit/mute were
   trusted based on a name tag (`senderId`) the sender writes themselves. A
   hacked client could wear anyone's name tag and delete/edit anyone's
   messages. Fix: trust only the cryptographic SIGNATURE on the message, and
   look up who owns the signing key ("verified signer").
   → Shipped: desktop PR #241/#242/#243, mobile PR #160. ✅
2. **The multi-device hole this exposed:** every device invents its OWN
   signing key when a space syncs to it, but everyone's member list only
   knows the key of the device that originally created/joined the space. So
   signed actions from a "second device" look like forgeries and get dropped.
   Fix: split the key's two jobs — the per-device "mailbox" key stays
   per-device; the per-user "signing" key (the original join key) is shared
   to all the user's devices through the already-encrypted settings sync.
   → Mobile: implemented (branch `fix/multidevice-space-signing-key`).
   → Desktop: implemented for NEW spaces only (commit 42d42a5f0) — gaps below.
3. **Testing keeps hitting NEW desktop bugs** (config upload 400, silent
   drops, missing member binding on sync) — tracked below.

## Current state per repo

### quorum-mobile (THIS repo — mobile agent)

| Item                                         | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Verified-signer auth (receive, live+batch)   | ✅ SHIPPED master (PR #160, d3c6113)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Signing-key split (send/sync/heal/migration) | ✅ code-complete on branch `fix/multidevice-space-signing-key` (d973102, 8b1e64c, 1cf8fce), reviewed, NOT yet merged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Known mobile leftovers                       | sticker sealHubEnvelope arg-swap (pre-existing, `.agents/bugs/2026-07-19-sticker-...md`); pin receive = missing feature (planned follow-up); test environment task (`.agents/issues/.open/2026-07-19-mobile-test-environment-and-test-audit.md`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| M3 (new)                                     | **New desktop space appears one app-launch LATE on mobile.** The space sync in `getConfig` is deferred (`InteractionManager.runAfterInteractions`) and fire-and-forget, so the space is written to storage AFTER the spaces list has rendered → invisible until the next launch reloads from storage. Confirmed 2026-07-19 (space seen only on 2nd open; log showed `local == remote` on 2nd open = 1st open had already adopted+synced it in the background). NOT the timestamp-deadlock bug (that branch did NOT fire — `KEEPING LOCAL` never logged). Fix: invalidate/refresh the spaces query after `syncSpacesFromConfig` completes so the new space shows without a manual restart. Confusing for real users ("made a space on desktop, not on my phone").                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | MEDIUM |
| M2 (new)                                     | **Config sync is ADD-ONLY — deleted spaces never disappear on the other device.** `syncSpacesFromConfig` adds/heals spaces present in the config but has NO reconciliation: nothing removes a local space when it drops out of the config's `spaceIds`. Observed 2026-07-19: spaces deleted on desktop still show on mobile. (Compounded by D1: desktop's deletions may not have published at all while its uploads were 400ing.) Fix: after sync, remove local spaces whose id is absent from the authoritative config space list (guard against wiping spaces during a partial/failed config fetch — only reconcile against a config that actually loaded). Likely a mirror gap on desktop; check both. **→ DESKTOP CONFIRMED same add-only bug (`ConfigService.ts:110`, `if (!existingSpace)` add-only; no removal branch) and wrote a design task: desktop `.agents/tasks/2026-07-19-space-deletion-ghost-cleanup.md`. KEY DESIGN (mobile should mirror the contract): do NOT reconcile "absent from config" (ambiguous with the existing Restore-Spaces recovery tool, which re-adds DB-not-in-config spaces). Instead add synced `deletedSpaceIds` TOMBSTONES (mirror the existing `deletedBookmarkIds`/`deletedUserNoteAddresses` pattern); reconciliation purges ONLY tombstoned ids → safe against partial/failed config fetches, and stops fighting the recovery tool. Also: make delete instant+offline via the action queue (seal the leave envelope up front, optimistic local purge, queue the network notify) — `delete-space` is currently not queued on either platform.** | MEDIUM |
| M1 (new)                                     | `saveConfig` swallows upload failures silently (`catch { /* continue */ }`, configService.ts:561) AND still persists the local copy with a fresh timestamp — same can't-publish+won't-listen deadlock shape as desktop's D6, and it made the evals-bloat 400 invisible during testing. Fix: log the failure loudly (status + size of payload), and don't let a failed sync advance the freshness timestamp used by getConfig's newer-wins comparison.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | HIGH   |

### quorum-desktop (desktop agent) — OPEN ITEMS TO RELAY

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Severity                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| D1  | **Config save rejected by server (400 "invalid config missing data")** → **ROOT CAUSE FOUND (2026-07-19, via bug-tracker sweep): KNOWN bug #108** — `2025-12-09-encryption-state-evals-bloat.md`. Every space a user CREATES stores ~10,000 private-invite evals (~2MB) inside its encryption state; the config upload includes those states; 2+ created spaces exceed the server's ~4MB limit → the server returns exactly this 400. Joined spaces carry ~0 evals. Open since December, never fixed, now sitting on the security cut-over's critical path. The `QmVBXRsHg…` missing-state row is a bystander. **MOBILE IS EQUALLY AFFECTED** (uploads the same eval-bloated states, and its saveConfig catch is fully silent) — creating the test space on mobile likely pushed the phone's blob over the limit too, which is why it never appeared on desktop and Metro showed nothing. **→ FULLY DIAGNOSED (desktop, 2026-07-19), NOT code-fixed — understood + a manual unblock exists.** See desktop `.agents/bugs/2025-12-09-encryption-state-evals-bloat.md`: (a) the public-invite rework (`MAX_PUBLIC_EVALS=1`) is already on BOTH platforms and does NOT shrink the blob; both still store a 10k pool (desktop = SDK default, mobile passes `10000`). (b) the config upload filters spaceKeys to `config.spaceIds` (desktop `ConfigService.ts:476-479`), so ghost/leftover spaces are NOT uploaded — the 400 is the REAL created spaces (~2MB each; 2 created ≈ 4MB ≈ limit). (c) mobile "feels" fine because it treats config save as non-fatal on create + swallows the 400 (M1), so creation always looks successful while sync silently breaks; plus the test spaces were created on desktop (mobile only synced them, ~0 evals). (d) live desktop account confirmed `config.spaceIds`=4 vs `getSpaces()`=13 → 9 ghost rows, ~19MB local; unblocked manually via a DevTools `window.__messageDB` script (trim real created spaces' eval pool to a small KEEP + purge ghost rows/states). Durable fix (both platforms, lead's blob-contract call): shrink pool at creation (desktop SDK already accepts `total?`) or trim evals from the upload only. | CRITICAL — root cause known, manual unblock available, code fix pending lead |
| D7  | **Corrupted spaces cannot be deleted**: rows with missing keys (`hubKey: undefined`, e.g. space `QmP9UpsBTJ514…` "Bb") make `SpaceService.deleteSpace` hard-fail ("Unable to leave Space due to incomplete configuration") — users are trapped with debris they can neither use nor remove. Add a force-delete path: when the hub key is missing, skip the network leave and remove the local rows (space, keys, encryption state, members, messages). Note these rows are already EXCLUDED from the config upload, so they do NOT contribute to the D1 size problem.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | MEDIUM (UX/cleanup; observed 2026-07-19)                                     |
| D6  | **Suspected receive deadlock + invisible skip paths**: `getConfig` silently returns the LOCAL config when its timestamp is newer/equal (`ConfigService.ts:66-73`), and the skip logs (`saved config is out of date`, `received config with invalid signature!`) do NOT contain "ConfigService" — a filtered console shows nothing. VERIFY: does `saveConfig` persist the local copy (with fresh timestamp) even when the server POST fails? If yes, a device whose saves 400 also permanently REJECTS incoming configs (can't publish + won't listen) — explains the mobile-created space never appearing on desktop despite refreshes. Fix: don't advance the local timestamp on failed sync (or track a separate lastSyncedTimestamp), and log every skip with a greppable prefix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | CRITICAL (pairs with D1)                                                     |
| D2  | Sync path writes NO self member row binding → on a desktop that synced a space, the other device's signing key resolves to no member → control messages silently denied even post-fix. Mobile's `spaceSyncService.ts` shows the shape (bind the SIGNING address, idempotent re-anchor).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | HIGH                                                                         |
| D3  | No migration for PRE-fix spaces (commit says "stay broken until re-add") → contradicts works-out-of-the-box; implement promotion at config save (desktop's member-table oracle is sound: their sync never writes self rows).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | HIGH                                                                         |
| D4  | Control-message denials are bare `return`s — no log at any level → testing is blind. Add drop logs with the verdict reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | MEDIUM (observability)                                                       |
| D5  | (already fixed by them: #243 update-profile poisoning; read-only completion #242)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                            |

### D8 — TRANSPORT / DELIVERY (cross-repo; the real remaining blocker for testing)

Space message + control-message delivery is flaky in BOTH ways: **delayed**
(desktop→mobile 0% for minutes then all-at-once ~2 min batches; a WS
reconnect/rebundle reliably flushes a stuck backlog) AND **genuinely lost**
(some never arrive). Deletes ride the same transport — the reason they
"didn't apply" was non-delivery, NOT auth (auth verifies fine once delivered,
Result H). This is the pre-existing bug, now fully re-diagnosed:

- Mobile home + full retest: `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md` (updated 2026-07-19 — signature half RESOLVED, residual is pure transport).
- **Desktop connection:** the DM-delivery master (`.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md`) is RESOLVED but its residual — _"isolated single-frame wire loss with no auto-resend — tracked in the auto-heal task"_ — matches today's genuine SPACE-message loss. Likely shared root (hub frame loss + no resend + drain-only-on-reconnect). Desktop agent: check whether the space path shares that residual, and whether the auto-heal/resend task covers space frames too.
- **Also owed on desktop (D4):** control-message denials are silent bare `return`s → the mobile→desktop delete direction is unobservable. Add deny-logging so tomorrow's reverse-direction test is visible.
- Did NOT edit desktop's tracked `.agents/` (desktop agent has uncommitted `.agents/` work on the shared branch) — this note is the relay.

### Cross-platform CONTRACT (both agents must keep matching)

- Blob `spaceKeys[].keys[]` may carry `keyId: 'signing'` (shape identical to
  other key entries). It is the join-bound ed448 keypair.
- Create/join: save the join keypair under BOTH `'inbox'` and `'signing'`.
- Sync: fresh per-device `'inbox'` (mailbox) is fine; NEVER discard/overwrite
  the signing identity; bind the local self member row to the SIGNING address.
- Send: sign with `signing ?? inbox`.
- A device that provably owns the correct key must never lose it; guesses
  must yield to the blob (see "provenance" below).

## The provenance mechanism (plain-language, for the lead)

Problem it solves: for spaces that existed BEFORE the split, devices must
figure out the correct signing key. A device can "promote" (guess) its own
key — but a device that synced the space long ago would guess WRONG, and an
early rule ("never overwrite an existing key") would then lock the wrong
guess in forever.

Solution: every stored signing key carries a LOCAL label saying how the
device got it:

- **origin** — "I created/joined this space with this key." Certain. Never
  replaced by anything.
- **adopted** — "It arrived through the settings sync from another device."
- **promoted** — "I guessed it during migration." Uncertain.

One rule: _certain keys are untouchable; guesses always yield to whatever
arrives via sync._ So wrong guesses self-correct on the next sync, correct
keys can never be lost, and no user interaction is ever needed. The label
never leaves the device (it is not uploaded).

## DECISIVE NARROWING (2026-07-19): it's DESKTOP-specific, not the server

Mobile config POST **succeeds in ~1s** (same account, same server); desktop
POST times out. → server + network are FINE; the problem is desktop-only.
Best explanation: **evals live on the CREATING device**, and these spaces
were created on DESKTOP → desktop's blob carries ~2MB/space of evals, mobile
only synced them (~0 evals) → desktop's upload is huge, mobile's is tiny.
(Imperfect fit with "4-5 created worked weeks ago" → possible added
server-slowdown or branch factor, but the device asymmetry is strong.)

Two desktop-side unblocks:

1. **Shrink desktop's blob** — evals-trim in the config upload (the real #108
   fix; keep full evals locally, strip from the uploaded state). Unblocks
   desktop-as-publisher.
2. **Fix desktop sync gaps (D2 + D6)** so the PHONE can be the publisher:
   create the space on mobile (POST works in 1s) → desktop receives via GET
   (not the failing POST) → desktop adopts the signing key + sends messages
   (hub post, also not the failing POST) → the PHONE validates (badge +
   delete). Sending msgs and receiving config are DIFFERENT ops from the
   failing config POST, so this route sidesteps desktop's upload entirely —
   IF desktop actually picks up the new config (D6) and binds the signing
   key on sync (D2). Try this before the evals-trim.

## THE SINGLE PREREQUISITE FOR ANY TESTING (read this first)

Everything routes through **one operation: the desktop config SAVE (config
POST)**. New space, healing existing spaces, even creating a space to invite
from — all call `saveConfig`. While that POST fails (currently: timeout),
NOTHING is testable, regardless of method. The fixes are done + reviewed;
the blocker is the config-sync transport, not the fixes.

Once config save works, the whole test is ~3 min:
create 1 space ON DESKTOP → it appears on mobile → post from mobile →
badge shows SIGNED on desktop (validates signing-key split + auth) →
delete from mobile → applies on desktop (validates auth fix). Create on
desktop (not mobile) to sidestep the desktop self-member-row gap (D2).

So the gating question is NOT "how do I create a space" — it is "how do I
make the desktop config POST succeed". Current belief: server-side/network
(size falsified), so it may clear on its own; the mobile-vs-desktop config
save is the diagnostic that says server-wide vs desktop-specific.

## ✅ RESULT G (2026-07-19): SIGNING-KEY SPLIT VALIDATED (send/post path)

Fresh space created on desktop → synced to mobile → **post from mobile shows
SIGNED on desktop.** This proves the full chain: mobile adopted desktop's
signing key via config sync, signed with it, desktop verified against the
member table. The exact failure from this morning (unsigned badge, Result B)
is FIXED. Core of the day's work confirmed working end-to-end.

DELETE still inconclusive: mobile→desktop delete didn't apply, no desktop log.
Ambiguous because (a) transport loss ~2/3 (2 of 3 posts also didn't land), and
(b) desktop denies unauthorized control msgs SILENTLY (D4). Since posts verify
(key + member binding proven correct), a delete signed with the SAME key
_should_ authorize (own-message) — so leading hypothesis = the delete envelope
was transport-lost, NOT denied. Next: retry deletes several times to beat the
2/3 loss; if a delete consistently fails on a message KNOWN to be on desktop,
escalate to instrumentation (mobile: confirm delete enqueued; desktop: D4 deny
logging + check the control-type scope-bound fingerprint spaceId/channelId
match). NOTE the control-msg fingerprint is scope-bound (spaceId+channelId)
while posts are not — the one place posts-work-but-deletes-fail could be
deterministic rather than transport.

## ✅ RESULT I (2026-07-20): DELETE mobile→desktop CONFIRMED propagating

User confirmed a mobile-sent delete applies on desktop. NOTE: no `[DELTEST]`
logs appear in this direction BY DESIGN — those logs are mobile-only + receive-
side, so mobile→desktop (mobile=sender, desktop=receiver) has nothing to print
them (mobile doesn't log sends; desktop has no DELTEST logs). Visual
confirmation on desktop = the proof. Together with Result H (desktop→mobile,
logged), **both delete directions now validated.**

Remaining caveat unchanged: both tests are single-account OWN-message deletes
(prove sign→deliver→verify→resolve→apply wiring both ways). The ROLE-based /
anti-spoof-DENY scenarios need a two-account test; that verdict logic is
unit-tested in shared (41 cases), so only the wiring needed device proof.

## ✅ RESULT H (2026-07-19): DELETE AUTH VALIDATED (desktop→mobile) — hard logged evidence

`[DELTEST live] RX remove-message … signed=true` → `APPLIED … verdict=ok-own-message`
for 4 desktop deletes; user confirms the messages disappeared on mobile. This
single result validates THREE things at once (all required to reach that
verdict): (1) the scope-bound control-message signature verified cross-platform
(kills the deletes-fail-where-posts-pass worry); (2) desktop's signing key
resolved to the member = the **signing-key split works**; (3) the delete
applied. So the auth fix + signing-key split + control fingerprint are proven
for desktop→mobile.

IMPORTANT CAVEATS (do not overclaim):

- The deletes only landed after a REBUNDLE — the app restart reconnected the WS
  and flushed a 30-min-delayed inbox. Confirms transport DELAY (pre-existing,
  separate) vs our auth (correct). Rebundle fixed nothing in code.
- `ok-own-message` = single-account own-message path. It exercises verify +
  resolve-signer + apply, but NOT the ROLE gate or the anti-spoof DENY (deleting
  someone else's message / a forged senderId). Those need a TWO-ACCOUNT test.
  The role/anti-spoof VERDICT logic is unit-tested in shared (41 cases); the
  wiring is now proven for own-message.
- Mobile→desktop delete still NOT directly confirmed (desktop denies silently,
  D4; transport delayed). Strong symmetry argument it works (desktop→mobile
  delete ✅ + mobile→desktop signed posts ✅), but no direct evidence until
  desktop adds deny-logging or a desktop reconnect flushes + shows it.

## ⚠️ TRANSPORT IS DELAYED, NOT LOST (2026-07-19) — recalibrates the delete verdict

User observation: desktop→mobile messages appeared 0% at first, then **ALL
landed together after ~2 min**; mobile→desktop feels ~50-70%, variable.
→ delivery is DELAYED/BATCHED (hub-log catch-up bursts), not permanent loss.
This is the KNOWN pre-existing bug `.agents/bugs/2026-06-13-desktop-to-mobile-
messages-fail-decryption-invalid-signature.md` (open ~months, "needs retest").

**Is it caused by today's work? NO** (architectural, not measured): all of
today's changes are AUTHORIZATION-layer (which key signs, does the receiver
trust it) — none touch the DELIVERY/hub-transport layer. No mechanism by which
signing-key work changes delivery timing. Orthogonal; pre-existing.

**Recalibrates the DELETE verdict (Result G):** "delete didn't apply + no
desktop log" is INCONCLUSIVE, not a failure — with ~2-min batched delivery, an
immediate check happens BEFORE the delete control-message is delivered, and an
undelivered delete looks identical to a denied one (desktop denies silently,
D4). **Corrected delete test:** delete on mobile → WAIT 3-5 min (a full
delivery batch) → check desktop. Only if it still fails after several patient
attempts on messages KNOWN to be on desktop is it a real auth problem → then
need desktop D4 deny-logging to see the verdict. DO NOT claim deletions
work OR fail until tested with delivery latency accounted for.

## Test protocol (and why testing felt so hard)

- **The signed/unsigned BADGE on a received post is the primary oracle** —
  immune to the flaky transport (judge only posts that visibly arrived).
  Signed badge on a cross-device post = the whole key chain works.
- Deletes are a SECONDARY check: they ride the same flaky transport
  (~50% loss observed 2026-07-19) and desktop currently drops them silently
  (D4), so "delete didn't apply + no log" is ambiguous.
- Config round-trip primer (existing spaces, after D1/D3 land): bookmark
  toggle on the space's create device (= config save) → kill+reopen the
  other device (= config fetch). One-time per space; end users get this
  automatically through normal background sync.
- Clean steady-state test: create a NEW space post-fix and check the badge
  from the other device.

## Test log

- 2026-07-19 A: mobile→desktop delete dropped, desktop logged
  `invalid address for signature` → confirmed the multi-device key bug. ✅ diagnosis
- 2026-07-19 B (post-fix builds, PRE-heal): post lands but badge UNSIGNED,
  delete silently ignored → phone still signing wrong key; heal blocked
  because desktop never publishes (D1+D3), desktop denies silently (D4).
- 2026-07-19 C: desktop "Create a Space" fails outright → D1 (config 400).
- 2026-07-19 D: space created ON MOBILE doesn't appear on desktop after 5min
  - page refresh → under investigation: either mobile's upload silently
    failed, or desktop's receive choked (possibly related to the D1 broken
    row). NO ACCOUNT WIPE — the data is not the problem.
  * Expected once visible on desktop: badge on mobile-sent post should be
    SIGNED (desktop verifies fine with no member row); delete may STILL be
    silently denied until D2 lands (no member binding on synced spaces).
- 2026-07-19 F: after deleting created spaces on desktop, the 400 is GONE
  (only the 1 corrupted row is filtered now) but space creation now TIMES OUT
  — `Save operation timed out after 30s` / `signal is aborted without reason`,
  via `fetchWithRetry` (3× retries per attempt = ~90s of hammering a large
  blob). Config POST hangs rather than rejecting. Cause not certain from
  client logs: transient server slowness OR blob still large (healthy created
  spaces keep ~2MB evals each and are NOT filtered). Either way = infra, not
  the security code. Timeout mechanism VERIFIED in desktop `src/api/baseTypes.ts`:
  config POST is a mutate → `defaultMutateTimeout = 22s`, `defaultRetryLimit = 2`,
  wrapped in a 30s `useModalSaveState` UI limit. So >22s server processing =
  abort ×3 = the "timed out after 30s" modal error. Working assessment: the
  400 (over hard cap) became a TIMEOUT once deletions dropped the blob under
  the cap. Timeout mechanism VERIFIED (`src/api/baseTypes.ts`):
  `defaultMutateTimeout = 22s`, `defaultRetryLimit = 2`, 30s `useModalSaveState`
  UI wrapper → >22s server processing = abort ×3 = "timed out after 30s".
  **SIZE HYPOTHESIS FALSIFIED (user, 2026-07-19):** user had 4-5 CREATED
  spaces working fine for weeks (~8-10MB); now 2 CREATED spaces (~4MB) time
  out. LESS data now fails than more data succeeded before → not blob size,
  and deleting more does NOT help (that advice retracted). Leading hypothesis
  now: **server-side or network** — Quilibrium config API slower/degraded/
  rate-limited/limit-changed, or transient network. Outside our repos; nothing
  to clean up in the account; MAY clear on its own tomorrow if transient.
  Secondary: desktop `fix-multidevice-signing-key` branch introduced
  something (rule out via main-vs-branch).
  **DECISIVE NEXT DIAGNOSTIC (uses mobile's existing size log):** trigger a
  config save from MOBILE (same account, same server). Mobile ALSO times out
  → server/account-wide (wait it out). Mobile SUCCEEDS (`settings POSTED ok
(blob …KB)`) → desktop-specific → then test desktop `main` vs the signing
  branch. The `blob …KB` number also finally measures the real payload size.
  space still invisible; console filtered on "ConfigService" shows ZERO
  lines. Filter was masking the relevant logs (they lack the prefix — D6);
  the pattern matches the D6 receive-deadlock hypothesis. **User testing
  PAUSED** — remaining diagnosis belongs to the desktop agent with real
  instrumentation, not manual console reading.

## Next actions

1. **NO-CODE TEST UNBLOCK (user, ~5 min):** the blobs are over the size
   limit because of CREATED spaces (~2MB each). Leave/delete old junk test
   spaces the account CREATED (on desktop UI), and delete the invisible
   mobile-created test space on the phone. Once each device's blob is back
   under ~4MB, config sync resumes by itself → then re-run the new-space
   badge test. (Long-term fix is code, below — this just unblocks today.)
2. **Joint code fix decision (both agents + product trade-off):** stop
   uploading the eval pool inside synced encryption states (trim/cap evals
   in the config upload only; local state untouched). Trade-off to accept:
   a second/restored device can't generate PRIVATE invites until the SDK
   supports on-demand evals (public invites unaffected). Both platforms
   must trim identically (blob contract). Alternative: SDK on-demand evals
   (#108's proposal, bigger).
3. **Relay to desktop agent:** D1 root cause (#108) + D6 timestamp-deadlock
   verification + D2 (self member row binding on sync) + D3 (pre-fix space
   promotion) + D4 (deny logging). Mobile mirrors: M1.
4. After sync resumes: the single decisive test — new space, cross-device
   post shows SIGNED badge, then delete crosses. Mobile branch
   `fix/multidevice-space-signing-key` ships once that passes.

_Last updated: 2026-07-19_
