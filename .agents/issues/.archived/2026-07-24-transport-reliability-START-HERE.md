---
type: task
title: "Transport reliability — START HERE (consolidated status + send-side work)"
status: archived
created: 2026-07-24
updated: 2026-07-24
severity: high
area: WebSocket transport (send + receive), spaces + DMs
child-tasks:
  - "issues/.done/2026-07-24-layer1-durable-send-remove-preflight-throw.md (Layer 1 — DO NOW)"
  - "issues/.open/2026-07-21-fix-space-append-send-loss-ack-resend.md (Layer 2 — DEFERRED)"
detail-sources:
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (deep master report)"
  - "issues/.open/2026-07-23-dm-send-websocket-not-connected-abort-and-failed-ux.md (DM send bug — folded into Layer 1)"
  - "issues/.done/2026-07-21-dev-env-receive-deaf-investigation.md (receive bug — SHIPPED, historical)"
note: "Every architecture + status claim below was independently verified against the code in BOTH repos on 2026-07-24."
---

# Transport reliability — START HERE

If you are re-orienting, read ONLY this file. It replaces juggling the scattered transport docs.

## The whole situation in five sentences

1. Messages between mobile and desktop had reliability problems for months (delays, losses, dead receipts).
2. The **RECEIVE** side — mobile failing to *get* messages — is **fixed and shipped** (code-verified).
3. Two problems remain, and **both are about SENDING**, not receiving.
4. **DM send** fails *loudly*: ~10-15% show a red "WebSocket not connected" error and never send.
5. **Space send** fails *silently*: ~1-in-5 space messages vanish with no error at all.

Receive = done. Send = two open bugs, split into Layer 1 (do now) and Layer 2 (defer).

## ⚠️ Verified architecture — mobile and desktop use DIFFERENT transports

This is the single most important fact for planning the fix, verified against both repos 2026-07-24:

| | **Mobile** | **Desktop** |
|---|---|---|
| Space history catch-up | **Server-retained hub log** (`listen-hub` + `log-since`) | **P2P mesh sync** (`sync-request → sync-delta`, needs another member *online*) |
| Space message send | `{ type: 'log-append', ...sealedEnvelope }` to the hub, hub replies `log-append-ack` | **No hub log at all** — different broadcast; zero `log-append`/`log-append-ack` in desktop `src` |
| Backfill needs a peer online? | No (hub replays) | Yes |

**Consequences (these correct earlier doc errors):**
- The space silent-loss bug (Layer 2 / "H-B") is a **mobile-only** problem — desktop doesn't append to a hub log, so it can't have this bug.
- Layer 2's fix (an append-ack ledger + resend) is **mobile-only and cannot be shared to desktop** — desktop has no `log-append-ack` to hook into. Any earlier note saying "build it then promote to shared so desktop benefits" is **wrong** and has been corrected.
- Whether desktop will migrate to hub-log someday is an unrecorded product decision — confirm with the lead; do not assume convergence.

## ✅ What SHIPPED (2026-07-23) — verified present in code, do not re-investigate

- **Space receive (PR #169):** hub-log catch-up flow-controlled so the reconnect flood can't overflow the queue and wedge the read cursor. (The "0% then floods in on restart" bug.)
- **DM receive + sessions (PR #170):** native-freeze watchdog + fallback; undecryptable-envelope skip-list + server-delete; init-envelope staleness guard; `ConfirmDoubleRatchetSenderSession` ported; receipt interception + correct ack key.
- **DM receipts UI (#171–#174):** inline read/delivery ticks on mobile.

## 🟢 LAYER 1 — durable send (PR #175 **MERGED** 2026-07-24) → `2026-07-24-layer1-durable-send-remove-preflight-throw.md`

**Shipped scope:** throw-removal core only (9 send sites, DM + space). Retry button + failed-timeout moved to Layer 2.

**Code verified 2026-07-28:** all 9 named send hooks are clean and the string
"WebSocket not connected" appears nowhere in the repo. ⚠️ **On-device airplane-mode
verification is still owed** — that is why the task file is not in `.done/` yet.
*(This heading previously read "PR #175 OPEN"; it merged 2026-07-24.)*


**What:** every send hook (DM *and* space) throws `if (!isConnected) throw ...` before queuing, dropping the message even though a durable outbound queue that would deliver it on reconnect already exists. Remove the throw; let the encrypted envelope flow into `enqueueOutbound` (buffers while offline, flushes on reconnect); mark the UI `queued`/`sending` and only `failed` after a real timeout; wire the existing (unconnected) retry button.

**Why now:** low-risk (mirrors already-shipped desktop behavior + machinery mobile already has), fixes the DM 10-15% loud-abort **entirely**, and fixes the connection-blip failure mode for spaces. Applies to **both** DM and space send paths.

**Not DM-only:** the `!isConnected` throw exists on space hooks too (`useSendSpaceMessage`, `useSendEmbedMessage`, `useEditSpaceMessage`, `useSendStickerMessage`, `useSpaceReactions`) — only the exact string "WebSocket not connected" is DM-specific. Remove the throw on both.

## ⬜ LAYER 2 — space append resend (DEFERRED) → `2026-07-21-fix-space-append-send-loss-ack-resend.md`

**What:** even with a live socket, a `log-append` can die silently; the hub's `log-append-ack` is currently ignored (empty no-op), so a dropped append is never resent → the proven ~1/5 space loss. Fix = watch for the hub's confirmation and resend if it doesn't come.

**Why deferred:** more mechanism and one genuine unknown (below). Layer 1 does not fix this specific case (silent drop on a healthy socket), so expect space loss to persist after Layer 1 — but ship + measure Layer 1 first, then do Layer 2 with real numbers.

**Verified mechanism notes for whoever picks this up:**
- The hub sees only the **sealed** envelope and assigns a **`seq`**; it cannot read the message's ID (it's inside the encrypted blob). So correlation is via `seq`/`request_id`, not messageId.
- `log-append-ack` carries an optional `request_id`, but mobile does **not** currently set one on outbound appends, and **whether the hub echoes it is unverified** — a real hub-side/lead question.
- Dependency-free alternative: confirm delivery by watching for your own message to **reappear in the decrypted `log-since-result`** stream; resend if it doesn't within a timeout. Preferred primary path since it needs no unverified hub feature.
- **Mobile-only.** Lives in `WebSocketContext.tsx` + `spaceMessageService.ts`. Not shareable to desktop.

## Lower-priority follow-ups (master report §0 — not blocking)
- Dev-env receive latency (correctness fine, dev just slow).
- Prune junk encryption-state rows (perf).
- Deregister ghost devices (`deviceCount: 11` seen).

---
*Last updated: 2026-07-24*
