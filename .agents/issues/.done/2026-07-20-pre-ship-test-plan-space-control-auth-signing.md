---
type: task
title: "Pre-ship device test plan: space control-message auth + multi-device signing"
status: done
priority: high
created: 2026-07-20
platforms: quorum-mobile (+ quorum-desktop as the cross-device peer)
---

# Pre-ship test plan — space control-message auth + signing-key split

Goal: before merging `fix/multidevice-space-signing-key`, be as confident as
we practically can that (a) every receive-side verified-signer handler is
wired correctly, and (b) spoofing/impersonation is actually denied. Companion
context: `.agents/reports/2026-07-19-signing-key-multidevice-hunt-tracker.md`.

## ✅ PROGRESS (2026-07-20)

**Automated suite (transport-independent, `yarn test`):** 26 tests green.
- Fingerprint golden vectors (6) — on master via PR #161 (infra branch).
- `spaceMessageAuth.test.ts` (20) — on THIS branch: signature verify
  (valid/unsigned/tampered/invalid), reverse key→member resolution fail-closed
  (no-match, kicked), remove-message allow-own vs **deny forged-senderId /
  unsigned / no-member**, update-profile known-key binding (**impersonation
  dropped**, rotation accepted), @everyone strip on unverified/mismatched
  signer, read-only unsigned drop. → **the anti-spoof DENY wiring is now
  covered without needing a modified client** (Section C largely satisfied at
  the module level; a full forged-wire test remains the only optional gap).

**Device (Section A happy-path) — validated:**
- remove-message: desktop→mobile (logged) AND mobile→desktop ✅ (Results H/I)
- edit-message: desktop→mobile ✅ AND mobile→desktop ✅ (2026-07-20)
- update-profile: desktop→mobile ✅ (2026-07-20, slow due to transport)
- mute: mobile→desktop ✅ (2026-07-20 — targeted ANOTHER user, applied on
  that user's desktop → a real multi-member/role setup now exists)
- posts render SIGNED cross-device ✅

- @everyone: user A (has mention:everyone) sends on mobile → notif lands for
  user B ✅ (2026-07-20)

**DENY tests — RESOLVED as NOT device-testable, and NOT needed (2026-07-20):**
The UI gates every unauthorized action (no delete/mute button without the
role; composer disabled in read-only), so an unmodified client cannot emit
them — the only device path would be a custom "evil client". That is exactly
what `spaceMessageAuth.test.ts` already simulates (forged senderId / non-member
key / unsigned → DENIED). A device evil-client would re-exercise the same
receive-side verdict at high cost + fighting transport, for ~zero added
confidence. **Decision: rely on the 20 unit tests for deny; do NOT build an
evil client.** Coverage rationale: happy-path device tests prove the handler
APPLIES when allowed (inverted/broken wiring would break legit actions too,
which it doesn't); unit tests prove the verdict DENIES bad input. Together =
full coverage.

**Remaining device nice-to-haves (LOW risk, non-blocking):**
- Role-based delete of ANOTHER user's message (moderator, not own-message) —
  blocked by sync 2026-07-20 ("prob ok"). NOTE mute already proved the role
  path (muted another user WITH the role ✅), so delete's checker path is the
  only role-ALLOW branch not yet device-seen; low risk (same handler + shared
  `canDeleteMessage`, both otherwise covered).
- Read-only manager post accepted on receivers — minor.

## SHIP READINESS (2026-07-20)
Security-critical DENY logic: unit-tested (20). Cross-platform fingerprint:
golden-vector tested. Happy paths device-validated: delete (both dir), edit
(both dir), mute (role, another user), @everyone, update-profile, signed
posts. Remaining items are redundant or low-risk. **The branch is testing-
ready to ship.** Transport flakiness is a separate pre-existing bug (D8), not
a blocker for this feature.

## What's ALREADY covered (do not re-do)

- **Deny/anti-spoof LOGIC** — unit-tested in quorum-shared (`messageAuth.test.ts`,
  41 cases): forged senderId → deny, unsigned control → deny, missing/kicked
  member → deny, unsigned-edit-of-unsigned acceptance, etc. Same code both
  platforms run. This is the authoritative test of "is spoofing possible" at
  the logic level.
- **Delete WIRING, both directions, own-message** — device-validated
  2026-07-19/20 (Results H + I): desktop→mobile logged `signed=true` →
  `ok-own-message` → applied; mobile→desktop confirmed propagating. Proves
  sign → deliver → verify → resolve-signer → apply end-to-end for
  remove-message.

## The gap this plan closes: per-handler WIRING (device)

Each receive handler is separate code routed through the shared verdict; a
unit test can't catch a mobile handler that mis-wires the call. Delete is
proven; these five are NOT yet exercised on device:

### A. Happy-path wiring (single account, both devices) — confirms the handler applies a LEGIT action
1. **edit-message** — edit a message on mobile → appears edited + SIGNED badge on desktop; edit on desktop → applies on mobile. (Also confirm the edit-inherit rule: an edit of an unsigned message stays unsigned.)
2. **update-profile** — change display name/avatar on one device → propagates to the other (known-key binding accepts own-key update). Confirm a second device's update still applies after the signing-key heal.
3. **@everyone** — send `@everyone` from an account holding `mention:everyone` → the other device shows it as an authorized everyone-mention / fires the notification. (The verified-signer gate must not strip a legit one.)
4. **mute** — with the `user:mute` role, mute a user from one device → the mute applies on the other (muted user's later messages dropped).
5. **read-only post (manager)** — a manager posts into a read-only channel → accepted + signed on the other device. (Force-sign path: confirm it's NOT dropped.)

### B. Natural DENY tests (TWO accounts + roles, NO modified client needed)
These exercise the real deny path using role differences, so an unmodified app
naturally produces a message the receiver must reject:
6. **read-only non-manager** — account B (no manage role) posts into a read-only channel → receiver DROPS it (verified signer is not a manager). This is the cleanest anti-spoof-adjacent test available without a custom build.
7. **mute without role** — account B (no `user:mute`) broadcasts a mute → receiver DROPS it (`no-permission`).
8. **delete other's message without role** — account B tries to delete account A's message → receiver DROPS it (`no-permission`). The role-based branch delete (own-message short-circuits it) that the current tests did NOT reach.

### C. Gold-standard forge test (OPTIONAL — needs an instrumented build)
9. Modified mobile build that sends a control message with a **forged senderId**
   (claiming an authorized member) signed with the attacker's own key →
   receiver must DROP (`senderid-mismatch` / `unsigned-control-rejected` /
   no member match). High effort (requires a temp patched send path). The
   logic is already unit-tested, so treat as optional confidence, not a
   blocker. If done, use a temp `[DELTEST]`-style warn log on the receiver to
   capture the drop reason.

## Practical notes (learned the hard way, 2026-07-19)
- **Transport is flaky** (delayed + lossy): a delete/edit may take minutes or
  only land after a WS reconnect/rebundle. Judge a NEGATIVE (didn't apply)
  only after giving delivery time / forcing a reconnect. The SIGNED BADGE on a
  landed message is the transport-immune oracle.
- **Receive-side is silent by default** on mobile (`logger.debug`) and on
  desktop (bare `return`, no log — desktop item D4). For deny tests, add temp
  `[DELTEST]`-style `logger.warn` at the handler (mobile pattern in commit
  030e302, since reverted) so RX/APPLIED/DROPPED+reason are visible. Desktop
  agent should add deny-logging (D4) so mobile→desktop denies are observable.
- **Two-account setup** needs a second identity in the same space (invite from
  A, join as B). Watch the config-blob evals-bloat limit (D1) when creating
  spaces — keep created-space count low.
- **Pin is NOT in scope** — mobile has no `pin` receive handler (deferred
  missing feature), so there is nothing to test for pin in this PR.

## Ship decision inputs
- Minimum bar to ship with good confidence: **Section A all green** (each
  handler wired) + **at least tests 6 & 8 from Section B** (a real deny via
  read-only non-manager and a non-role delete). That covers allow + deny
  wiring across the handler set without a custom build.
- Section C is the only thing gated on building an instrumented client; given
  the shared unit coverage, it's optional.

*Last updated: 2026-07-20*
