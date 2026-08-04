---
type: task
title: "Port typing indicators + global typing toggles to mobile"
status: open
created: 2026-07-24
source: quorum-desktop/.agents/tasks/port-to-mobile/candidates.md rows #7 + #16
shared_change_required: false
---

# Typing indicators + global typing toggles — desktop → mobile port

## 🔴 CORRECTION 2026-08-03 — READ BEFORE SLICE 3

> Desktop shipped a bug in this exact feature and fixed it (desktop #308). **As
> written, slice 3 of this task would reproduce it on mobile.** Everything else
> below still stands.

### The defect desktop had

A typing frame is **not** ephemeral on the wire. `sendEphemeralSpaceControl` goes
through the same send path as an ordinary post, so on the relay it is an ordinary
retained frame. **The relay holds a frame until the client deletes it, and that
delete IS the ack.**

Desktop's space typing intercept returned *before* the ack, so every typing
indicator ever received stayed on the relay and was re-pushed on every `listen`,
forever. MEASURED (`yarn harness space-typing` in quorum-desktop), one run, one
reconnect, with an ordinary post as the control arm:

| | POST (control) | TYPING |
|---|---|---|
| before | redelivered 0x | redelivered **2x** |
| after | redelivered 0x | redelivered **0x** |

⚠️ The 30 s freshness filter in shared `TypingService` does **not** prevent this
and cannot: it drops stale indicators *after* the frame has been received and
unsealed. It defends the UI, not the queue.

This matters because typing is high volume by design (one `typing-start` per 5 s
per scope), so the accumulation is unbounded — and queue depth is what decides
whether perishable control frames get read before they expire.

### What it means for THIS task

**Slice 2 (DM) is safe as written.** It extends `handleDmReceipt`, and every call
site already acks immediately before returning:

```ts
// context/WebSocketContext.tsx:2983-2986, and again at :3330-3333
if (handleDmReceipt(decryptedMessage, conversationId.split('/')[0])) {
  deleteProcessedEnvelope(message.inboxAddress, message.timestamp);
  return;
}
```

**Slice 3 (space) is EXPOSED.** It adds a *new* intercept at the space
decrypt/parse sites, and the text below says only "intercept `typing-start/stop`
**before** the message is treated as a post". Mobile acks per-branch rather than
in a single tail, so a new early return that omits `deleteProcessedEnvelope`
leaks exactly the way desktop did.

**Requirement:** the space typing intercept MUST call
`deleteProcessedEnvelope(message.inboxAddress, message.timestamp)` before
returning — mirror the `handleDmReceipt` pattern above, not just "intercept and
return".

**Acceptance test for slice 3** (do not accept "the indicator shows up" alone):
send one typing frame and one ordinary post, reconnect, and assert **neither** is
redelivered. The post is the control arm — if it comes back too, the test is
measuring the harness rather than the fix. Desktop's
`src/dev/tests/harness/space-typing.scenario.test.ts` is the reference shape.

### Other staleness found while checking

- **Shared version:** this task says it verified against
  `@quilibrium/quorum-shared@2.1.0-36`. The repo now pins **`2.1.0-39`**. The
  exports it relies on are unlikely to have moved, but the verification claim is
  against an older version — re-check rather than trust it.
- **Desktop file:line references below are STALE.** `MessageService.ts` and
  `MessageDB.tsx` have changed substantially since 2026-07-24 (several fixes
  landed 2026-08-01→03). Search by symbol name, not by line number.
- **`source:` in the frontmatter points at `quorum-desktop/.agents/tasks/…`.**
  That tree was restructured; it is now `.agents/issues/port-to-mobile/candidates.md`.
- **Desktop now has `MessageService.ackSpaceFrame`**, a named helper extracted so
  that "every early return must ack first" is discoverable. Mobile has no
  equivalent single helper — `deleteProcessedEnvelope` is called at ~7 sites. Worth
  considering whether mobile wants the same consolidation while doing this work.

Ports **candidate #7 (typing indicators)** and its paired **candidate #16 (global DM/Spaces
typing toggles)** from desktop to mobile. Both are feature-ports: mobile has neither side
today (no send, no receive, no UI, no toggle).

## TL;DR

- **Shared package: NOTHING to do.** Verified against the installed `@quilibrium/quorum-shared@2.1.0-36`
  (the version mobile currently pins). `TypingService`, `TypingServiceOptions`, `TypingMessage`,
  `TypingScope`, `scopeKey`, `scopeFromMessage` are all root-exported (`export * from './typing'`
  in `dist/index.d.ts` + `dist/index.native.js`), and `typingIndicatorsDM` / `typingIndicatorsSpaces`
  already exist on `UserConfig` (`dist/types/user.d.ts:65-66`). **No shared change, no version bump,
  no publish.** This is a pure mobile-wiring task.
- **We have a working template already on mobile.** The DM-receipt pipeline (shipped 2026-07-19,
  `.done/2026-07-19-dm-receipt-pipeline-and-global-toggles.md`) is the exact analog: a platform-agnostic
  shared service (`ReceiptService`) instantiated once per session in `WebSocketContext`, fed by a
  receive-side control-message intercept, sending via an encrypted-transport callback, flushed on
  `AppState` background, with global toggles in `ProfileModal` via `useUserConfig`. Typing mirrors this
  one-for-one. Read that pipeline before starting.
- **The one genuinely new piece** is the **ephemeral space broadcast** (receipts are DM-only; typing
  also works in space channels). Needs a lean seal-and-broadcast helper in `spaceMessageService.ts`
  that produces a hub `wsEnvelope` for a `TypingMessage` **without** optimistic cache or SQLite persist.

## How the shared `TypingService` works (the contract we wire to)

Source: `quorum-shared/src/typing/service.ts` (+ `types/typing.ts`). Platform-agnostic; no DOM.

- **Constructor** `new TypingService({ selfAddress, sendDM, sendSpace, isEnabledForScope })`:
  - `sendDM(address, msg)` — our encrypted DM transport callback.
  - `sendSpace(spaceId, msg)` — our encrypted space-hub broadcast callback.
  - `isEnabledForScope(scope)` — privacy gate; read the live `typingIndicatorsDM/Spaces` config.
- **Send side:** `notifyTyping(scope)` (throttled 1 start / 5s per scope, gated), `notifyStopped(scope)`
  (explicit stop), `onSettingDisabled('dm'|'space')` (flush active sessions + clear local typists when a
  toggle flips OFF).
- **Receive side:** `onTypingReceived(msg)` (8s TTL per typist, reorder protection, drops self + messages
  older than 30s), `subscribe(scope, listener) => unsubscribe` (listener gets `string[]` of typist addresses).
- **Lifecycle:** `destroy()`.
- **Wire type** `TypingMessage { type:'typing-start'|'typing-stop', senderId, scope:'dm'|'space',
  spaceId?, channelId?, threadId?, timestamp }` — flat, mirrors the receipt-ack shape. Intercepted before
  persist; never saved, never in the sync manifest.

## Desktop reference implementation (what we're mirroring)

- Instantiation + config-ref + `onSettingDisabled` wiring: `quorum-desktop/src/components/context/MessageDB.tsx:1053-1269`.
- Send transports: `MessageService.sendEphemeralDMControl` / `sendEphemeralSpaceControl` (`MessageService.ts:315-356`).
- Receive intercept (before saveMessage, both DM + space paths): `MessageService.ts:494-504` and `:3804-3816`.
- Composer broadcast hook: `useTypingNotifier.ts` (`notifyKeystroke` on change, `notifyMessageSent` on send,
  auto-stop on scope change / unmount / hidden).
- Render subscribe hook + component: `useTypingIndicator.ts` + `components/message/TypingIndicator.tsx`
  (1/2/3 names then "Several people are typing", animated dots, `role="status"`).
- Global toggles UI: `UserSettingsModal/Privacy.tsx:215-260` (two `Switch` rows, DM + Spaces).

## Mobile integration points (verified file:line)

**Service instantiation — `context/WebSocketContext.tsx`:**
- Add a `typingServiceRef` + a `TypingService` built in a `useEffect` keyed on `user?.address`, mirroring the
  `ReceiptService` block at `:5544-5608`.
- `sendDM` callback: reuse the DM control-message transport `sendDmReceiptAck` uses
  (`sendEncryptedMessageToAllDevices`, `:5490-5534`) — fan out the flat `TypingMessage` to the partner's
  devices. (Do **not** fan out typing to our own other devices — only the partner needs it; simpler than receipts.)
- `sendSpace` callback: call the new ephemeral space helper (see slice 3).
- `isEnabledForScope`: read `typingIndicatorsDM` / `typingIndicatorsSpaces` from `getLocalUserConfig(self)`
  (same live-read pattern as `isReceiptEnabled` at `:557-565`).
- `AppState` background → auto-stop active outbound typing (mirror the receipt flush at `:5612-5619`).
- Expose `typingService` (or `subscribeTyping`/`notifyTyping` helpers) on the WebSocket context value so
  chat screens can use it.

**Receive intercept — `context/WebSocketContext.tsx`:**
- DM path: extend `handleDmReceipt` (`:573-610`, called at `:2759` + `:3054`) — or add a sibling `handleTypingControl`
  — to catch `type === 'typing-start' | 'typing-stop'` with `scope === 'dm'`, call
  `typingServiceRef.current?.onTypingReceived(raw)`, and return `true` (intercept, never persist).
- Space path: the space-message decrypt/parse sites (`:1836`, `:3889`, via `handleIncomingMessage` `:712` /
  `applySpaceGroupResults` `:3774`). Intercept `typing-start/stop` **before** the message is treated as a post
  (mirrors desktop `MessageService.ts:3804`).

**Composer broadcast — `components/Chat/DMChatArea.tsx` + `components/Chat/SpaceChatArea.tsx`:**
- DM: `<MessageInput onChangeText={setMessageText} onSend={handleSendDirectMessage}>` at `DMChatArea.tsx:521-525`.
  Wrap `setMessageText` to also fire `notifyTyping({kind:'dm', address})`; wrap `handleSendDirectMessage` to fire
  `notifyStopped`.
- Space: `handleSendMessage` (`SpaceChatArea.tsx:423`) + `<MessageInput>` (`~:798`). Same wrapping with
  `{kind:'space-channel', spaceId, channelId}`. **Gate off** when `isReadOnlyChannel` (composer already knows this,
  `:527`) — no typing broadcast from users who can't post.
- Build a small RN `useTypingNotifier(scope, enabled)` hook mirroring desktop's, but swap `visibilitychange` for
  `AppState`-based auto-stop (RN has no `document`).

**Render — new `components/Chat/TypingIndicator.tsx` (RN):**
- Subscribe hook `useTypingIndicator(scope)` (mirror desktop) → animated three-dot + "{name} is typing" /
  "{a} and {b} are typing" / "{a}, {b} and {c} are typing" / "Several people are typing". Resolve addresses to
  display names via the same member/contact maps the screens already hold.
- Place it just above the composer in `DMChatArea` and `SpaceChatArea` (reserve height / absolute-overlay so it
  doesn't shift the list — check against the keyboard-avoidance layout both screens already use).

**Config + settings UI:**
- `hooks/useUserConfig.ts`: add `useTypingSettings()` mirroring `useReceiptSettings()` (`:159-172`) with
  `setTypingIndicatorsDM` / `setTypingIndicatorsSpaces` mirroring the `updateConfig(..., { deliveryReceipts })`
  setters at `:127` / `:136`.
- `components/ProfileModal.tsx` settings section: add two `Switch` rows next to the receipt toggles (`~:825-846`),
  mirroring `handleToggleDeliveryReceipts`. On a toggle flip to OFF, call `typingService.onSettingDisabled('dm'|'space')`
  so active sessions stop and local indicators clear immediately (mirrors desktop `MessageDB.tsx:1080-1085`).

## Plan — vertical slices (each ends in something testable on an Android device)

### Slice 1 — Global typing toggles (UI + persistence), no signaling yet
- Add `useTypingSettings()` to `useUserConfig.ts`; add the two `Switch` rows to `ProfileModal` settings.
- **User-visible outcome:** two new "Typing indicators in DMs" / "Typing indicators in Spaces" switches in
  Profile → Settings that persist and sync across devices (default OFF). Nothing else changes yet.
- Ships independently; zero signaling risk.

### Slice 2 — DM typing end-to-end (send + receive + render)
- Instantiate `TypingService` in `WebSocketContext` (DM `sendDM` callback + `isEnabledForScope`).
- Add the DM receive intercept to `handleDmReceipt`.
- Add `useTypingNotifier` + wire `DMChatArea` composer; add RN `TypingIndicator` above the DM composer.
- Wire `onSettingDisabled('dm')` on the DM toggle.
- **User-visible outcome:** with the DM toggle ON on both devices, typing in a DM shows "X is typing…" on the
  partner's screen; it clears on send / stop / 8s idle; toggling OFF hides it immediately. (Test desktop↔mobile too.)
- **Known limitation to carry from desktop:** in a brand-new DM with no established Double Ratchet session, typing
  silently no-ops until the first real message bootstraps the session. Acceptable (fire-and-forget).

### Slice 3 — Space typing end-to-end
- Add a lean `sendEphemeralSpaceControl(spaceId, msg)` to `services/space/spaceMessageService.ts`: seal the
  `TypingMessage` into a hub `wsEnvelope` via the same Triple-Ratchet + `sealHubEnvelope` path as `sendSpaceMessage`,
  but **skip** optimistic cache + SQLite persist; return the envelope for `enqueueOutbound`.
- Wire the `sendSpace` callback + the space receive intercept + `SpaceChatArea` composer + render the indicator in
  space channels; wire `onSettingDisabled('space')`.
- **User-visible outcome:** with the Spaces toggle ON, typing in a space channel shows the typist(s) to other members
  (up to "Several people are typing"); read-only-channel users broadcast nothing.
- **This slice carries the only real unknown** — confirm the ephemeral seal path works without the persist machinery
  (see Risks). Do a short recon spike in `spaceMessageService.ts` before building the full callback.

## iOS review checklist (Android-only testing → iOS is a review responsibility)

- **AppState, not `visibilitychange`.** The notifier's auto-stop and the service's background flush must key off
  `AppState` (`background`/`inactive`), not a web lifecycle event. Verify iOS backgrounding fires a `typing-stop`.
- **Keyboard-avoidance layout.** The indicator sits between the list and the composer — verify it doesn't collide
  with the iOS `keyboardWillShow` path or the safe-area / home-indicator inset both chat screens already handle.
- **Reserved height / no layout jank.** Prefer an absolute overlay or reserved row so the indicator appearing/vanishing
  doesn't push the message list on iOS.
- **Real-device races.** Near-zero emulator latency hides ordering bugs; the 5s throttle / 8s TTL / reorder protection
  live in shared, but verify the compose→send→stop ordering doesn't leave a stuck indicator over Wi-Fi/P2P.

## Risks / open questions

1. **Ephemeral space broadcast (slice 3)** — main unknown. `sendSpaceMessage` is tightly coupled to optimistic cache
   + persist. Need to confirm the seal/envelope layer can be called standalone for a non-persisted control message.
   Recon `spaceMessageService.ts` first; if the seal path can't be cleanly separated, slice 3 grows.
2. **Thread scope** — shared `TypingScope` supports `thread`, but mobile has no threads yet (candidate #3, unshipped).
   Scope this task to `dm` + `space-channel` only; thread typing rides the future threads port.
3. **Self-device fan-out** — receipts fan acks to our own other devices; typing does not need to (partner-only for DM,
   hub-broadcast for space). Keep the DM typing send partner-only to avoid self-echo indicators (the service also drops
   self by `senderId`, but not sending is cheaper).

## Out of scope

- Threads typing (no threads on mobile yet — see risk 2).
- Any per-conversation typing override (desktop has only the two global toggles; match that).
- Shared-package changes (none needed).

## Cross-repo note

Per the atlas, port-to-mobile is normally lead-dev reference and we don't push to mobile unhinged — this is a scoped
plan, not a shipped change. Since it touches user-facing mobile behavior, the actual build wants the higher mobile
confidence bar + an explicit iOS review pass, and the lead should be told (Telegram, one line) when it's ready to ship.
When this graduates, update `port-to-mobile/candidates.md` rows #7/#16 from 📋 to 🚧 with a pointer to this file.
