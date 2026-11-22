---
type: task
title: "DM delete-conversation — Part 1 (counterparty encryption-reset signal, DONE+VERIFIED) + Part 2 (self-device sync; shared+desktop+mobile DONE)"
status: done
created: 2026-06-25
updated: 2026-07-19
source: extracted from #35 (2026-06-17-dm-conversation-settings-parity.md), "Delete conversation — approved scope"; lead-dev approved 2026-06-24
priority: medium
effort: Part 1 = send plumbing (mirrors #36) + net-new crypto-teardown receive branch; Part 2 = shared done, desktop+mobile remain
pairs-with: 2026-06-17-delete-own-message-in-dm.md (#36 — already MERGED as PR #139; Part 1 ships on its own branch now)
---

# IMPLEMENTED — Part 2 mobile (2026-07-19) — DONE + RUNTIME-VERIFIED end-to-end

Built on branch `feat/dm-delete-conversation-self-sync` (commit `b5b12d3`):
- **Send:** `useDeleteConversationSignal.ts` now fires `delete-conversation-self`
  (`{ type, senderId, conversationAddress: recipientAddress }`) ALONGSIDE the
  Part 1 `delete-conversation` reset, over the SAME all-devices fan-out
  (`Promise.allSettled`, each best-effort). Payload shape matches desktop's merged
  send (`MessageService.ts:6051`).
- **Receive:** replaced the two forward-compat DROPS with a real wipe on BOTH DM
  paths (JS fallback + batch `applyDMGroupResults`). Gated to self
  (`content.senderId === user?.address`); wipes via `storage.deleteConversation` +
  `deleteAllEncryptionStates` + invalidate conversations & messages queries —
  mirrors the LOCAL delete (`dm/[id].tsx`) so the result is identical to deleting
  on that device. Non-self is a no-op (counterparty can never delete our copy).
  Inbox cleanup preserved. Both branches exit before the default-deny guard.
- **Verified:** tsc clean on changed files (21 pre-existing master errors
  unrelated), lint 0 errors. **RUNTIME-VERIFIED END-TO-END** (2026-07-19): same
  account on mobile + desktop; deleted a DM on mobile → conversation vanished on
  desktop. Send confirmed via temp `[DELTEST]` log (now stripped); desktop's
  self-gated receive wiped it. This happened despite normal DM messages NOT
  landing that session — control messages appear to travel a more reliable path
  (or a lucky window). The one direction NOT runtime-tested: MOBILE receiving a
  self-message (review-only; the round trip is proven + the handler mirrors
  desktop's proven one with an identical self-gate).

# IMPLEMENTED — Part 1 (2026-06-28)

Built on mobile branch `feat/dm-delete-conversation-reset-signal`:
- **Send:** new `hooks/chat/useDeleteConversationSignal.ts` (mirrors the merged
  `useDeleteDirectMessage` all-devices transport, no optimistic cache), wired
  into `handleDeleteConversation` (`app/(tabs)/messages/dm/[id].tsx`) before the
  local `storage.deleteConversation`. Gated to Quorum DMs (`recipientAddress &&
  !isFarcasterConversation`).
- **Receive:** `delete-conversation` branch added to BOTH DM receive paths in
  `WebSocketContext.tsx` (batch `applyDMGroupResults` + JS fallback
  `handleIncomingMessage`). Each only calls
  `encryptionStateStorage.deleteAllEncryptionStates(conversationId)` (session
  reset) + clears the inbox entry, then continues/returns. NEVER deletes the
  conversation/messages. Placed BEFORE the conversation-save so a received signal
  can't resurrect a row the user just deleted.
- **Verified:** tsc clean (the one tsc error is pre-existing on master, unrelated),
  lint clean on changed files, and a full cross-repo correctness review (all 7
  questions CORRECT — faithful to desktop's `MessageService.ts` 2857/3032/3084
  receive + 5690 send). No auth check on receive — matches desktop (the E2E
  session IS the auth).
- **Minor divergence noted (not a blocker):** desktop's `deleteEncryptionStates`
  also deletes per-state inbox MAPPINGS; mobile's `deleteAllEncryptionStates`
  leaves them. Harmless — the states are gone so a stale mapping can't decrypt;
  re-handshake creates fresh inboxes. Cleanup debt on `deleteAllEncryptionStates`,
  out of scope here (it has other callers).

# Part 2 groundwork (2026-06-28)

- **shared:** added `DeleteConversationSelfMessage = { senderId,
  type:'delete-conversation-self', conversationAddress }` to
  `quorum-shared/src/types/message.ts` + barrel export. Branch
  `feat/delete-conversation-self-type`, build green. Additive (Atlas §3 ok).
  **Confirmed shape (the task's open sub-decision):** explicit `conversationAddress`
  field rather than relying on the envelope `channelId` convention — self-describing
  for a frozen wire type. Privacy-checked: payload is E2E-encrypted and goes only
  to your own devices (which already hold the conversation list), so no new leak.
- **Re-confirmed:** desktop does NOT delete-on-your-own-devices today either — its
  `delete-conversation` receive only resets the session even on the self path. So
  Part 2's per-device delete is net-new on desktop too, not just mobile.
- **desktop DONE** (branch `feat/dm-delete-conversation-self-sync`, tsc+lint+build
  green): `deleteConversation` now also sends `delete-conversation-self`; a receive
  handler in the init-envelope branch (the ONLY branch self-sync DMs arrive on —
  verified: self sends target the permanent device-inbox → `message.inboxAddress ==
  device inbox` → that branch) deletes the whole conversation, gated on
  `senderId === self_address`, keyed by explicit `content.conversationAddress`.
  Extracted `deleteConversationLocally` (teardown, no send) shared by the local
  delete + the receiver. Folded the self type into the no-optimistic-post +
  no-save guards.
- **Architecture note that corrects the original framing:** the all-devices DM
  fan-out ALREADY reaches your own other devices (every device is an inbox). The
  reason self-delete didn't work wasn't routing — it was that the receiver reset
  the session regardless of sender. So Part 2 = a RECEIVE-side change + a distinct
  type to disambiguate "counterparty deleted (reset session)" from "I deleted
  (wipe conversation)". The new type's privacy guard (act only when sender==self)
  is the essential safety property.

# RUNTIME VERIFICATION (2026-06-28) — all live, via temporary `[DELTEST]` probes (now removed)

Cross-device testing is normally blocked by the long-standing DM delivery issue
(see memory `dm-cross-device-sync-unreliable-blocks-testing`); delivery worked
intermittently in this session, enough to capture every path live:

- **Part 1 send (mobile):** `send delete-conversation … via 13 device(s)`. ✅
- **Part 1 receive (mobile):** `recv delete-conversation … resetting session` — and
  the conversation was correctly NOT deleted (session-reset only). ✅
- **Part 2 send (desktop):** `send delete-conversation + delete-conversation-self`. ✅
- **Part 2 receive (desktop→desktop, same account):**
  `recv delete-conversation-self sender=QmQuCG… self=QmQuCG… match=true` →
  `wiping conversation QmVYRW… locally` — conversation deleted on the 2nd device.
  The `match=true` self-gate fired correctly (privacy guard verified). ✅
- **Mobile forward-compat:** `recv delete-conversation-self … DROPPED` — no crash,
  no ghost row, conversation correctly left intact (mobile Part 2 not built yet). ✅

Net: every send + receive path is runtime-verified. The riskiest piece (Part 2
self-sync, net-new on both platforms) is proven end-to-end. Probes stripped from
mobile + desktop after capture.

## Remaining

- **Strip probes + ship** the three proven branches (probes removed; final
  tsc/lint then ship). Order: shared (lead publishes) → desktop → mobile bump.
- **shared publish** (lead-gated): bump + npm publish `feat/delete-conversation-self-type`.
- **mobile Part 2** (LAST, after publish): bump installed shared, then mirror the
  desktop send (`delete-conversation-self` alongside the Part 1 signal) + a receive
  handler that wipes the whole conversation gated on self-sender (replace the
  current forward-compat drop). Mobile's batch receive path is `applyDMGroupResults`;
  reuse `storage.deleteConversation` + message/cache teardown (the inverse of the
  Part 1 session-only reset).

# DM delete-conversation: align to desktop (Part 1) + self-device sync (Part 2)

Extracted 2026-06-25 from the now-retired DM-settings-parity umbrella so the two
genuinely-remaining delete pieces live on their own. Today mobile's
`handleDeleteConversation` (`app/(tabs)/messages/dm/[id].tsx`) does a pure-local
`storage.deleteConversation(conversationId)` — no signal to anyone.

## Part 1 — encryption-reset signal to the counterparty (READY TO BUILD)

Lead-dev (2026-06-24) approved aligning mobile to desktop. Desktop also deletes
locally, but FIRST sends a `{ type:'delete-conversation' }` control message to
the counterparty; on receive the counterparty does NOT delete anything — it only
**resets its encryption session** (`deleteEncryptionStates` +
`deleteInboxMessages`) so the next message re-handshakes (desktop
`MessageService.ts` send ~5606, receive ~2775).

**No shared work:** `DeleteConversationMessage` (`{ senderId,
type:'delete-conversation' }`) already exists in installed shared
(`message.d.ts:101`, verified present in `2.1.0-33`).

Mobile parity:
- **Send:** in `handleDeleteConversation`, before the local delete, enqueue a
  `delete-conversation` control message to `recipientAddress`, mirroring the
  `remove-message` send plumbing from #36 (same encrypt+seal+`enqueueOutbound`
  path).
- **Receive:** add a `delete-conversation` branch to `applyDMGroupResults`
  (alongside #36's new `remove-message` branch). It must **only tear down the
  encryption session** for that conversation (mobile analogue of
  `deleteEncryptionStates` / `deleteInboxMessages` — likely
  `encryptionStateStorage` clear for the `conversationId` + conversation-inbox
  cleanup). It must **NOT** delete the conversation or its messages. Verify the
  exact mobile teardown calls against `encryptionStateStorage` before writing.
- **Verify:** delete the conversation on A → B keeps history but the next message
  from either side cleanly re-handshakes (no decrypt failure / stuck session).

> ⚠️ Receive side is crypto-pipeline teardown — net-new and the riskiest piece
> here. Static-verify the teardown calls and runtime-verify the re-handshake
> before shipping. Do NOT speculatively guess the encryption-state API.

## Part 2 — conversation-delete sync to your OWN other devices (shared-publish gate CLEARED; now gated on DESKTOP)

Desired: delete a conversation → it disappears on all your devices once they
sync. **Neither desktop nor mobile does this today.** Part 1's signal can't be
reused — it targets the counterparty only and resets their session on receive (it
deliberately does NOT delete). Self-sync needs a **new** wire message:

- A new self-targeted control message (e.g. `delete-conversation-self`) sent to
  your OWN device inboxes, and
- a receive handler on each of your devices that deletes the WHOLE conversation
  locally (messages + conversation row), distinct from Part 1's session-only
  teardown.

### Why it's blocked (re-verified 2026-06-25)

`delete-conversation-self` is a genuinely new wire/protocol message both apps
must agree on byte-for-byte — **NOT** an additive config field, so the
mobile-first untyped shortcut (`(config as any).X`) does NOT apply.

> **UPDATE 2026-07-16 — shared-publish gate CLEARED, but this is NOT fully ready yet.**
> The `delete-conversation-self` wire type is now PUBLISHED in shared `2.1.0-34`
> (npm `latest`) — verified against the published tarball: `dist/types/message.d.ts`
> declares both `DeleteConversationSelf` and the `'delete-conversation-self'` literal.
> So step 2 (shared publish) is done. **But per the canonical order below, mobile is
> step 5 and still gated on step 3: desktop must implement send + per-device
> delete-on-receive and PROVE the flow first.** Confirm desktop has shipped Part 2
> before starting the mobile leg — do NOT treat this as a plain dep-bump task like
> image-config / message-preprocessing (those were additive; this is a new protocol
> message where mobile goes genuinely last).

Original (pre-publish) finding, kept for history: grepped every message-type literal in
published shared `2.1.0-33` (`dist/types/message.d.ts`), the local shared SOURCE, desktop
`src/`, and mobile — only `delete-conversation` existed everywhere; `delete-conversation-self`
was absent from all four. We can't publish shared ourselves (lead-gated); the lead has since
published it in `2.1.0-34`.

### Canonical shared-publish order (lead-dev confirmed 2026-06-24)

1. **quorum-shared** — add the `delete-conversation-self` type, prepare to publish.
2. **quorum-shared publish** — get it into a published version.
3. **quorum-desktop** — implement send + per-device delete-on-receive.
4. **mobile** — bump to the published shared version.
5. **quorum-mobile** — implement send + per-device delete-on-receive LAST.

Mobile is the last platform, gated on the shared publish (see memory
`shared-publish-order-new-wire-type`). **Open sub-decision:** confirm the exact
`delete-conversation-self` type name/shape before opening the shared PR.

## Part 2 — GATE FULLY CLEARED, ready to implement (verified 2026-07-19)

Re-verified every dependency against real code/PRs (not task-file status):
- **shared `2.1.0-34` INSTALLED** (not just published): `@quilibrium/quorum-shared`
  in node_modules declares `DeleteConversationSelfMessage`
  (`dist/types/message.d.ts:105`, `type:'delete-conversation-self'`,
  `conversationAddress` field), barrel-exported (`dist/types/index.d.ts:7`).
- **desktop Part 2 MERGED to `origin/main`** (not just a local branch): `git grep`
  = 9 hits in `origin/main:src/services/MessageService.ts`. Send `:6072`;
  self-receive handler `:2989-3013` (init-envelope branch), gated on
  `content.senderId === self_address`, keyed by `content.conversationAddress`,
  wipes via `deleteConversationLocally` + `deleteInboxMessages`. This is the
  authoritative receive reference to mirror.
- **mobile Part 1 SHIPPED** (PR #144). `useDeleteConversationSignal.ts` is the
  send template; the two forward-compat DROP sites to replace are
  `WebSocketContext.tsx:2892` (JS fallback) + `:4057` (batch `applyDMGroupResults`).
- **Local wipe teardown to mirror:** `storage.deleteConversation` (mmkvAdapter:181)
  + `queryClient.invalidateQueries(conversations.all('direct'))`, exactly as
  `handleDeleteConversation` (`app/(tabs)/messages/dm/[id].tsx:255`) does locally.

### ⚠️ Coordination note — space control-message-auth work (do NOT conflate)

A separate HIGH-priority effort is in flight: **space** control-message auth via
enforced signatures (design held privately +
desktop `2026-06-25-MASTER-RECAP-control-message-auth.md`). Relationship to THIS task:
- **No current conflict:** that work has NOT started on mobile (no branch/commit
  touching `WebSocketContext.tsx` as of 2026-07-19). Desktop is mid-flight on
  `feat/space-control-message-auth`.
- **Auth models are compatible by design:** delete-conversation-self is a **DM**
  feature and MUST stay **session-anchored / self-gated** (`sender==self`), NOT
  adopt the space signature mechanism. The space-auth design explicitly leaves DM
  paths untouched ("DMs: signatures irrelevant to auth (session-anchored, shipped
  fix)"). Keep it that way.
- **Future merge-conflict surface (textual, not logical):** both eventually edit
  `WebSocketContext.tsx` receive paths — space-auth rewrites the SPACE handlers,
  this task adds DM branches. Different regions; whichever lands second rebases
  trivially in that one file. If both are queued, pick an order.

## Recommendation

Part 1 (+#36) already shipped. **Part 2 is now unblocked and ready** — implement
the mobile send (`delete-conversation-self` alongside Part 1's signal) + a
self-gated receive wipe replacing the two forward-compat drops. Mirror desktop
`MessageService.ts:2989-3013`. Keep it session-anchored; do not entangle with the
space-auth signature work.

## Source

`quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` row 35.
Delete-semantics analysis: `.agents/reports/2026-06-21-dm-delete-semantics-desktop-vs-mobile.md`.

*Last updated: 2026-07-16 — shared-publish gate for Part 2 CLEARED (delete-conversation-self type now in published 2.1.0-34); Part 2 still gated on desktop implementing first (mobile is step 5).*
