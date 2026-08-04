---
type: task
title: "DM edit-message sync — edits should propagate desktop↔mobile in DMs (parity with spaces)"
status: done
priority: medium
created: 2026-07-16
runtime_test: required (DM cross-device — see the testing caveat)
shared_change: none expected (edit-message wire type already exists + is used by spaces)
version_bump: none expected
---

# DM edit-message sync (desktop↔mobile parity)

## Objective (user, 2026-07-16)

**Message edits should sync perfectly between desktop and mobile — in BOTH spaces and DMs.**
Spaces already do. **DMs are the gap.** Close it so that editing a DM on any client updates the
message on every other client (the peer's device AND your own other devices).

## Why this task exists

Spun out of `2026-06-13-dm-receive-path-default-deny.md`. That task's independent review (2026-07-16)
found that mobile's DM edit is **half-built**, which forced a carve-out (`edit-message` is currently
let through the DM default-deny guard via `DM_GUARD_PASSTHROUGH_TYPES` so it isn't dropped). This
task builds the real thing; when done, **remove `edit-message` from `DM_GUARD_PASSTHROUGH_TYPES`**
(`components/Chat/types.ts`) so the guard treats it as a normal handled type.

## Verified current state (2026-07-16)

Two independent halves, both needed for full sync:

### SEND side — mobile DM edit is LOCAL-ONLY (does NOT transmit)
- `hooks/chat/useEditDirectMessage.ts` — despite its header comment ("Sends an edit-message type
  through the encrypted DM channel"), the body does **no** `sendEncrypted*` call. It only does a
  local `storage.saveMessage` + optimistic cache update (see line ~51 "For DMs, editing is
  local-only"). So a mobile DM edit never reaches the peer or your other devices.
- Contrast SPACE: `hooks/chat/useEditSpaceMessage.ts` → `sendEditMessage` (`services/space/spaceMessageService.ts:802`,
  builds `{ type: 'edit-message', originalMessageId, editedText, editedAt, ... }` and transmits).
  That's the template.

### RECEIVE side — mobile has NO DM edit-message handler
- `edit-message` is handled ONLY on the two SPACE receive paths in `context/WebSocketContext.tsx`:
  live at **~1874**, batch at **~3470**. Neither DM path (JS/fallback ~2820, batch ~4130) has an
  `edit-message` branch, so an incoming DM edit currently falls through to `saveMessage` as
  saved-but-hidden junk (the render filter hides it; the default-deny guard now lets it pass via
  the carve-out rather than dropping it).
- Desktop DOES send DM edits over the wire, with DM-specific anti-spoof auth: `quorum-desktop`
  `src/services/MessageService.ts:1148` / `:1631` (`decryptedContent.content.type === 'edit-message'`),
  plus a unit test "DM edit-message authorization (anti-spoofing)" (`MessageService.unit.test.tsx:471`).
  So desktop→mobile DM edits are a real, currently-dropped scenario.

## Scope — both halves

### 1. SEND: make `useEditDirectMessage` transmit an `edit-message` control message
Mirror `useEditSpaceMessage`/`sendEditMessage` but over the DM transport. Key decisions:
- **Transport: all-devices, not single-session.** DM control messages must reach the peer's
  devices AND your own other devices. Use `sendEncryptedMessageToAllDevices` (the all-devices
  fan-out), NOT `sendEncryptedControlMessage` (single-session) — see the DM-delete precedent and
  [[dm-control-msg-single-session-vs-alldevices-transport]]. Confirm which the delete/remove-message
  DM path uses (`hooks/chat/useDeleteDirectMessage.ts`) and match it.
- Keep the existing local optimistic update (it already works); ADD the wire send.
- Honor the 15-min edit window + the "Save Edit History" gate that's already in the hook.
- Payload shape must match what desktop's DM receive expects and what the space `edit-message`
  uses: `{ type:'edit-message', originalMessageId, editedText, editedAt, editNonce? }` (+ the DM
  auth field convention — see auth note below).

### 2. RECEIVE: add an `edit-message` handler to BOTH DM receive paths
Mirror the space handlers (live 1874 / batch 3470), adapted to DM storage keys
(`spaceId === channelId === senderAddress`) and the DM cache key
(`queryKeys.messages.infinite(senderAddress, senderAddress)`). Must:
- Look up the target by `originalMessageId`; update text + `edits` (respect saveEditHistory) in
  storage AND the React Query cache; do NOT clobber stored history when history is on.
- Place the handler ABOVE the default-deny guard (like every other applied type).
- **Auth (critical — mirror the remove-message DM fix):** authorize the edit by the
  crypto-authenticated session sender (`conversationId.split('/')[0]` / `authenticatedDmSender`),
  NOT the spoofable payload `senderId`. See [[dm-control-msg-auth-session-sender-not-payload]] and
  the existing DM `remove-message` branch (`WebSocketContext.tsx` ~2731 JS / ~4088 batch) for the
  exact pattern. Drop unauthorized edits (debug-log, delete from inbox).
- Delete the processed `edit-message` from the inbox after applying (same cleanup pattern as the
  DM remove-message branch), so it can't replay.

### 3. Remove the carve-out
Once receive is real, delete `edit-message` from `DM_GUARD_PASSTHROUGH_TYPES` in
`components/Chat/types.ts` (the guard will then correctly drop any *malformed* edit that slips past
the handler). Leave the set itself (it's the documented mechanism for future partial features).

## Acceptance
- Editing a DM on mobile updates it on the peer + your own other devices (send side transmits).
- An incoming DM edit (from desktop or another mobile device) updates the stored + displayed
  message, honoring saveEditHistory; the "(edited)" marker shows.
- Edit auth uses the session-authenticated sender, not payload `senderId`; an edit from a
  non-author is dropped.
- Handler sits ABOVE the default-deny guard on both DM paths; `edit-message` removed from
  `DM_GUARD_PASSTHROUGH_TYPES`.
- No inbox replay of a processed edit.
- Spaces edit behavior unchanged (don't touch the space handlers/hook beyond using them as a
  reference).
- Typecheck + lint green.

## Testing caveat
DM cross-device delivery is unreliable ([[dm-cross-device-sync-unreliable-blocks-testing]]).
Prove the SEND side with a `[DELTEST]`-style log that the `edit-message` was posted; test the
RECEIVE side desktop↔desktop or with the dev-inject recipe if available. State clearly in the PR
what was runtime-verified vs review-only, and do an iOS review pass (no runtime iOS).

## References
- Space template: `hooks/chat/useEditSpaceMessage.ts`, `services/space/spaceMessageService.ts:802`
  (send); `context/WebSocketContext.tsx:1874` (live receive) / `:3470` (batch receive).
- DM auth pattern: DM `remove-message` branch `WebSocketContext.tsx` ~2731 (JS) / ~4088 (batch).
- Desktop DM edit: `quorum-desktop` `src/services/MessageService.ts:1148/1631` + unit test
  `MessageService.unit.test.tsx:471`.
- Parent task: `issues/.done/2026-06-13-dm-receive-path-default-deny.md` (the carve-out this removes).

*Last updated: 2026-07-16*
