---
type: doc
title: "Message Transport Architecture — DMs and Spaces (cross-platform)"
status: living
created: 2026-07-24
audience: any agent or dev who needs the full picture of how a message gets from one client to another — encryption, sealing, delivery, receive, decrypt, ack — for BOTH direct messages and spaces, on BOTH desktop and mobile
related:
  - "quorum-desktop/.agents/docs/cryptographic-architecture.md (the crypto MENTAL MODEL — key hierarchy, Double vs Triple Ratchet, signing vs encryption; read it alongside this)"
  - "quorum-desktop/.agents/docs/debugging/dm-architecture-and-debug-playbook.md (DM identity/profile sync + desktop debug ladder)"
  - "quorum-desktop/.agents/tasks/transport/dm-ratchet-upstream-divergences.md (why decrypt-failure no longer destroys the session; Signal-spec justification)"
  - "docs/inbox-envelope-lifecycle-and-poison-guard.md (mobile: what an inbox is, delete-on-ack, the bounded-retry poison guard)"
  - "issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md (mobile transport master report — the tier model)"
  - "issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md (the current OPEN receive bug)"
  - "quorum-desktop/.agents/bugs/.solved/2026-07-02-dm-message-delivery-unreliable-master.md (desktop transport master — mechanism catalogue + invariants)"
  - "Quilibrium Docs/docs/learn/02-communication/ + /03-oblivious-hypergraph/ (the decentralized NETWORK beneath the relay: BlossomSub, mixnet/SLRP routing, addressing, content-addressed hypergraph storage)"
---

# Message Transport Architecture — DMs and Spaces

> **Scope.** This doc is the *transport pipeline*: how a composed message becomes an
> encrypted envelope, reaches the other client's mailbox, gets decrypted, rendered, and
> acknowledged — and where DMs and Spaces differ, and where desktop and mobile differ. It
> deliberately does **not** re-explain the crypto primitives; for the key hierarchy, Double
> vs Triple Ratchet, and signing-vs-encryption, read
> [cryptographic-architecture.md](../../../quorum-desktop/.agents/docs/cryptographic-architecture.md)
> first. This is the "how does it actually move" companion to that "what are the keys" doc.

> **AI-assisted, verified against code + live testing 2026-07-24.** The mobile DM session
> model section reflects PR #177 (session-tag alignment). Verify before relying on any exact
> line number — file paths are stable, line anchors drift.

---

## Table of Contents

1. [The two conversation types at a glance](#1-the-two-conversation-types-at-a-glance)
2. [Shared substrate: the network, inboxes, envelopes, ack-by-delete](#2-shared-substrate-the-network-inboxes-envelopes-ack-by-delete)
3. [DM pipeline](#3-dm-pipeline)
4. [Space pipeline](#4-space-pipeline)
5. [Desktop vs mobile divergences](#5-desktop-vs-mobile-divergences)
6. [Failure modes and where to look](#6-failure-modes-and-where-to-look)
7. [Debugging toolkit](#7-debugging-toolkit)

---

## 1. The two conversation types at a glance

| | **DMs (1:1)** | **Spaces (group channels)** |
|---|---|---|
| Encryption | **Double Ratchet**, per device-pair session | **Triple Ratchet**, one session per space (established at join) |
| Needs private key at encrypt time | **Yes** (key agreement each chain) | **No** (ratchet_state holds the symmetric keys) |
| Signing key | UserKeyset (Ed448) | per-space **inbox/signing key** (see multi-device note) |
| Delivery target | recipient's per-conversation/device **inbox mailbox** | the space **hub log** (primary) + legacy per-member group inbox (fan-out) |
| Fan-out | one sealed copy **per target device** (recipient's devices + your other devices) | one hub broadcast reaches all members; the relay/network distributes |
| Catch-up on reconnect | re-subscribe to inboxes; relay redelivers undeleted envelopes | **durable hub log** replayed via `log-since` cursor (mobile); desktop historically fetch-once |
| Identity/profile propagation | captured at session init; updated by `dm-update-profile` control msg | `join` + `update-profile` control msgs over the hub log |

The single most important structural fact: **DMs are POP3-style mailboxes** (download →
process → delete-from-relay), while **space channels are a durable append-only log** with a
per-hub cursor. This is why space messages are structurally hoard-proof and DMs are not
(see §2 and the [poison-guard doc](inbox-envelope-lifecycle-and-poison-guard.md)).

---

## 2. Shared substrate: the network, inboxes, envelopes, ack-by-delete

### 2.0 What the client actually connects to (be precise here)

Quilibrium is a **decentralized network** — a P2P mesh of nodes running BlossomSub (an extended
GossipSub) over mixnet routing (SLRP), with a content-addressed hypergraph data store; there is
no single central server that holds "all of Quorum's data." (Foundations:
`Quilibrium Docs/docs/learn/02-communication/` and `/03-oblivious-hypergraph/`.)

**However**, the Quorum apps do not speak the P2P protocol directly. They open a WebSocket to a
**Quorum-operated API/relay endpoint** — `wss://api.quorummessenger.com/ws` in production,
`ws://<host>:5000/ws` in local dev (`services/api/config.ts`) — plus an HTTPS base
(`api.quorummessenger.com`) for registration and inbox-delete calls. That relay is the client's
point of contact; it serves the inbox mailboxes and the space hub log described below and bridges
to the underlying Quilibrium network. So in this doc, **"the relay" = the Quorum API endpoint the
app talks to**, and "the network" = the decentralized Quilibrium substrate beneath it.

Two consequences matter for transport reasoning:
- **End-to-end encryption means the relay cannot read message content.** Envelopes are sealed
  with keys only the participants hold (Double/Triple Ratchet); the relay stores and forwards
  opaque blobs. A compromised or curious relay is a metadata/availability concern, not a
  content-confidentiality one.
- **The relay behaves, from the client's side, like a durable mailbox store** (the POP3-like
  pattern below). Whether a given inbox is served from relay-local storage, the hypergraph, or a
  mix is an implementation detail of the relay/network that this client-side doc does **not**
  assert — describe observable client behavior, and point here to the Quilibrium docs for the
  network internals rather than guessing.

### 2.1 Inboxes, envelopes, ack-by-delete

Both message types ride the same WebSocket to the relay and both ultimately land in an **inbox
mailbox** addressed by a base58 address.

- **Envelope** = the sealed, encrypted blob the relay stores and delivers. Unsealing (opening
  the outer envelope with an inbox/hub key) is separate from decrypting the inner ratchet
  payload — a frame can unseal fine yet fail the inner decrypt (this is exactly the current
  open DM bug).
- **Ack-by-delete.** There is no separate ACK frame. A client signals "I processed this" by
  calling a delete against its relay mailbox. Until it does, the relay **redelivers** the
  envelope on every reconnect/re-listen. This is the durability guarantee AND the source of
  redelivery storms when a frame can't be processed.
- **Three inbox flavors / three signing keys / three delete helpers** (mobile,
  `context/WebSocketContext.tsx`): **device inbox** (`deleteInboxMessages`, Ed448 device key —
  carries DMs), **space inbox** (`deleteSpaceInboxMessages`, space inbox key — legacy `'group'`
  channel fan-out), **conversation inbox** (`deleteConversationInboxMessages`, per-conversation
  key — carries DM replies for an established session).
- **`deleteInboxMessages` deletes only the undecrypted envelope from YOUR OWN relay mailbox.**
  It never touches your local decrypted message DB, the sender's copy, or any other recipient.
  The worst it can cost is your own device's future chance to re-process that one envelope.

**Delete-on-failure policy differs by client and is a real tradeoff** (see
[poison-guard doc §4](inbox-envelope-lifecycle-and-poison-guard.md)): desktop deletes even on
decrypt failure (never hoards, but black-holes transient failures); mobile historically never
deleted on failure (transient-safe, but hoards → could freeze the native batch); mobile now
does **bounded retry** (N attempts / age cap, then skip — the middle ground).

---

## 3. DM pipeline

### 3.1 The session model (mobile, as of PR #177)

A DM "session" is a Double Ratchet state row. Mobile keys these rows and selects them by a
**tag**, and the tag semantics are the crux of most DM delivery bugs.

- **The `tag` is the SENDER's device inbox address** — it is the session's identity. Both the
  sender's send-path (select session by `tag === target device inbox`) and the receiver's
  storage agree on it. This matches the SDK
  (`NewDoubleRatchetSenderSession`/`DoubleRatchetInboxEncrypt` set
  `tag = keyset.inbox_keyset.inbox_address`).
- **A recipient session is born send-ready.** The init envelope carries the sender's full
  return-inbox key set (encryption + signing public AND private). When you receive a first
  message, the session you create from it can immediately be used to reply — no separate
  confirmation round-trip needed in that direction. (Pre-#177 mobile discarded the tag and
  blanked the return keys, so these born-ready sessions were invisible to the send path and
  never usable → endless re-handshaking. That was the #177 fix.)
- **Confirmation** (`confirmSenderSession`, mirrors SDK `ConfirmDoubleRatchetSenderSession`)
  only matters for the *initiator before any reply*: your first sends are wrapped in init
  envelopes (`sendingInbox.inbox_public_key === ''` = unconfirmed); the peer's first reply
  (itself init-wrapped, carrying their return keys) confirms the session — fills the peer's
  return inbox, sets `sentAccept`, and ends init-wrapping. After that, sends take the cheap
  `DoubleRatchetInboxEncrypt` path (one DR encrypt, no X3DH, no init envelope).
- **Confirmed-session sends are SIGNED** with the conversation-inbox signing key the peer
  shared at confirmation (`inbox_public_key` + `inbox_signature` on the sealed message). The
  relay verifies writes to a registered conversation inbox against that key. Unsigned
  confirmed-path frames are dropped downstream (this path was dead code until #177 made
  sessions actually confirm, so the missing signing surfaced only then).
- **Per-conversation inbox keypairs are stored TWICE**: keyed by conversationId (legacy,
  last-writer-wins) AND by inbox address (`conversationInboxByAddr:<addr>`). The per-address
  store is what lets the client subscribe to, push-register, and recognize **every** session
  inbox after a restart — not just the most recent one per conversation. (Missing this was the
  "messages arrive minutes later or never after restart" bug: the client stopped listening on
  all but the last inbox, so peer replies sat unheard until the peer fell back to the device
  inbox.)

### 3.2 Send path (mobile)

`hooks/chat/useSendDirectMessage.ts` → `sendEncryptedMessageToAllDevices`:

```
compose → generate messageId (SHA-256 of nonce+'post'+sender+text) → [sign messageId w/ Ed448]
  → gather target devices: recipient's devices + your OTHER devices (multi-device sync)
      (from allRecipientDevices/allSenderDevices, else fetchUserRegistration — TTL-cached, PR #176)
  → per device: pick the session row by tag; prefer a send-ready (confirmed) row
      ├─ confirmed  → DoubleRatchetInboxEncrypt path → seal → SIGN → sealed message
      ├─ unconfirmed→ DR-encrypt + wrap in InitializationEnvelope (tag = own device inbox)
      └─ no session → establishSession (X3DH) → init envelope
  → enqueueOutbound(prepare): buffered; the WS client flushes on socket-OPEN (honest "sent")
```

Key points: optimistic UI bubble ('sending') flips to 'sent' only inside the socket-OPEN drain
(`onFlushed`), so an offline/queued message is never falsely shown as sent (PR #175). The send
does NOT gate on `isConnected` — it enqueues and the buffer flushes on reconnect.

### 3.3 Receive path (mobile)

`context/WebSocketContext.tsx` DM branch (~L2650–3050):

```
WS frame → is it on our device inbox / one of our conversation inboxes? (echo gate)
  → unseal envelope (device or conversation inbox key)
  → classify: init envelope (MessageCiphertext) vs subsequent (DoubleRatchet)
  → init on device inbox:
       existing session? confirmSenderSession (may CONFIRM) or trial-decrypt existing states
       else initializeRecipientSession → receiver X3DH → store BORN-READY session (tag = envelope tag)
  → subsequent on conversation inbox: decryptMessage against the mapped session
  → on success: parse Message; intercept receipts/control msgs; else persist + render; ack-by-delete
  → on failure: recordInboxAttempt (bounded-retry) and return (do NOT delete)
```

All ratchet ops go through `ratchetMutex.runExclusive(conversationId, …)` and save state
inside the lock (Signal-spec: "accept plaintext + store state changes" is one atomic step;
concurrent read-modify-write forks the ratchet — this was a desktop root cause, PR #236/#237).

### 3.4 Identity/profile over DMs

Captured once at session init from the envelope's `display_name`/`user_icon`; thereafter only
a `dm-update-profile` control message (sent when the user saves their global profile) updates
it. Full detail + the three read/write paths:
[dm-architecture-and-debug-playbook.md](../../../quorum-desktop/.agents/docs/debugging/dm-architecture-and-debug-playbook.md).

---

## 4. Space pipeline

### 4.1 Encryption + signing

Spaces use one **Triple Ratchet** session per space, established at join. Encryption needs no
private key at send time — the `ratchet_state` (in `encryption_states`, keyed
`spaceId/spaceId`) holds the symmetric keys. Messages are signed with the per-space
**signing key**; see the multi-device "mailbox key vs signing key" section in
[cryptographic-architecture.md](../../../quorum-desktop/.agents/docs/cryptographic-architecture.md)
— the per-space inbox key plays two roles with opposite lifetimes (per-device mailbox vs
per-user signing identity), and per-device signing is admitted via a master-signed
`announce-keys` statement.

### 4.2 Two delivery mechanisms (dual-write, deduped)

Channel messages reach members **two** ways:

1. **Hub log via `log-since` cursor — the primary path.** The space is an append-only log
   served by the relay. A sealed **hub envelope** (`SealHubEnvelope`) is appended
   (`log-append`); members receive `log-update` pushes and, on reconnect/foreground, catch up
   with `log-since` from a **per-hub cursor** (`services/space/hubLogCursor.ts`,
   `hubLogSync.ts`). The cursor advances along a **contiguous run** of `__logSeq` values in
   each drained batch **whether or not each entry decrypted**, so a single undecryptable channel
   message doesn't wedge the cursor and can't replay forever — **channels are structurally
   hoard-proof** (contrast DMs). The durable log is also the general fix for the desktop
   "fetch-once-at-startup, never reconcile" class of staleness bugs.
2. **Space inbox (legacy `'group'` fan-out).** A per-member copy in the space inbox, deleted on
   successful processing. Ordinary channel traffic self-cleans here.

### 4.3 Control vs post messages

The hub log carries both posts and **control messages** (`join`, `leave`, `kick`,
`update-profile`, `remove-message`, `edit-message`, `pin`, `mute`). Control messages and
`@everyone` posts are authorized against the **cryptographically verified Ed448 signer**
(`resolveVerifiedSender` → `authorizeControlMessage`), never the spoofable
`content.senderId`; unsigned/invalid → dropped (fail closed). The control-message fingerprint
binds `spaceId + channelId` to prevent cross-space replay. Because the hub log **replays every
handler on every reconnect**, control-message handlers must be upsert-safe / null-safe and
durable-path enforcement must match cache-path enforcement, or replay resurrects blocked
content. Full rules: crypto-arch "Control-Message Authorization" + desktop `features/security.md`.

### 4.4 Sync envelopes (peer-directed)

Distinct from hub broadcasts: `SealSyncEnvelope`/`UnsealSyncEnvelope` carry directed
peer-to-peer sync traffic (`sync-request`, `sync-info`, `sync-initiate`, `sync-manifest`,
`sync-delta`) for space config/manifest reconciliation — not user chat.

---

## 5. Desktop vs mobile divergences

These are the differences most likely to bite a cross-platform investigation. **Mobile was
written by the Lead Dev; divergences are often intentional — verify against the SDK before
"fixing" one to match the other.**

| Aspect | Desktop | Mobile |
|---|---|---|
| Primary store | IndexedDB | MMKV (sync, on JS thread) + SQLite (messages) |
| Crypto binding | WASM (`channel` SDK direct) | native lib via JNA bridge (Kotlin/Swift Expo module) |
| Space receive catch-up | historically **fetch-once at startup** (staleness bug class) | **durable hub log** replayed via `log-since` on every reconnect/foreground |
| DM decrypt-failure policy | **delete envelope** (never hoard, black-holes transients) | **bounded retry** then skip (poison guard) |
| DM decrypt failure destroying session | fixed 2026-07-17 (PR #235: skip frame, keep session) | never had the bug (returns null without persisting) |
| Ratchet serialization | `dmRatchetMutex` (PR #236/#237) | `ratchetMutex.runExclusive` (PR #165) |
| Per-device signing heal | new-space path only | also heals already-synced spaces on every config receive |
| DM session tag / per-address inbox store | SDK-native throughout | aligned to SDK in **PR #177** (was divergent before) |

**The transport master reports are required reading for cross-platform work:** mobile
[2026-07-20-...-transport-delay-loss-master.md](../issues/.open/2026-07-20-mobile-desktop-message-transport-delay-loss-master.md)
(the tier model: space-receive / DM-receive / space-send / DM-session) and desktop
[2026-07-02-dm-message-delivery-unreliable-master.md](../../../quorum-desktop/.agents/issues/.done/2026-07-02-dm-message-delivery-unreliable-master.md)
(three cooperating defects + the §2 invariants every DM change must respect).

---

## 6. Failure modes and where to look

| Symptom | Most likely layer | Start here |
|---|---|---|
| DM send slow (seconds) | unconfirmed sessions re-running X3DH per device; SecureStore/registration re-reads | PR #176/#177; `issues/.open/2026-07-24-dm-send-latency-10s-production.md` |
| DM sent shows no ticks | receipts are failing frames, OR confirmed-send was unsigned | §3.1 signing; the open divergence bug below |
| desktop→mobile DM lands sometimes, not others | inner DR decrypt fails against all stored states (state divergence/fork) | **OPEN:** `issues/.open/2026-07-24-dm-desktop-frames-undecryptable-state-divergence.md` |
| DM "arrives minutes later" after restart | client not subscribed to the right conversation inbox | §3.1 per-address store; PR #177 |
| DM redelivery loop / native batch freeze | undecryptable envelope hoard | [poison-guard doc](inbox-envelope-lifecycle-and-poison-guard.md) |
| Space message 0% then floods on restart | Tier-1 cursor-wedge storm | mobile transport master §3 (fixed #169) |
| Space message permanently lost mobile→desktop | Tier-3 fire-and-forget `log-append` loss | mobile transport master §0 item 1 (OPEN) |
| Space profile/roster stale until restart | desktop fetch-once-at-startup class | dm-playbook "fetch-once" section; hub-log migration |
| Control action (delete/edit/pin) from 2nd device ignored | per-device signing not admitted | crypto-arch "Multi-Device Signing" |

**Recurring lesson (both master reports):** a session dying with a *silent* console is almost
always state **replacement/divergence**, not state corruption — "successfully processed" ≠
"should have been processed." Instrument the branch that *accepts* a frame, not just the ones
that throw.

---

## 7. Debugging toolkit

- **Mobile logcat** (dev builds; `console.warn` reaches logcat, `logger.debug` does NOT):
  `adb logcat -v time ReactNativeJS:V *:S > file`.
- **Mobile encryption-state store dump** (ground truth for session rows):
  `adb exec-out run-as com.quilibrium.quorummobile.debug cat files/mmkv/quorum-encryption > dump.bin`,
  then extract printable JSON runs (rows carry conversationId/inboxId/tag/sendingInbox/timestamp).
- **Mobile clean-slate:** `.agents/scripts/clear-dm-encryption-state.sh` (wipes only the session
  store; debug builds only; `ADB_SERIAL=<serial>` selects device).
- **Desktop:** browser devtools console (MessageService logs loudly on session events);
  `quorum-desktop/.agents/tools/dm-debug/` console snippets (state-diff, profile-sources).
- **Cross-platform rule:** desktop instrumentation is in a browser console the agent can't read
  directly — the human must relay it. Mobile is adb-observable by the agent. Plan two-sided
  captures accordingly.
- **Pacing:** live hardware testing is human-paced and this bug class is nondeterministic. One
  step at a time, state the expected observation before each step, never declare fixed on a
  single success.

---
*Last updated: 2026-07-24*
