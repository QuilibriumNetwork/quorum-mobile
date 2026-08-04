---
type: task
title: "Port DM + Space message-signing controls to mobile (Always-sign toggle + per-message composer lock + send-path gating)"
status: done
created: 2026-06-25
source: spun out of #35 (DM conversation settings parity), Q4 repudiability — lead-dev confirmed 2026-06-25 to use desktop's "Always sign messages" pattern everywhere
priority: medium
effort: medium (send-path crypto + composer UI on both DM and Space surfaces)
pairs-with: 2026-06-17-dm-conversation-settings-parity.md (the DM "Always sign messages" toggle MUST NOT ship visible until send-path honors it)
---

# Make message-signing controls real on mobile

## Lead-dev decision (2026-06-25)

Use desktop's pattern everywhere: the user-facing control is **"Always sign
messages"** (a conversation/space setting), default **ON**. This is the
repudiability Q4 that had been open in
`.agents/reports/2026-06-21-dm-delete-semantics-desktop-vs-mobile.md`.

> "We'll use 'Sign messages' in the option everywhere instead of repudiable
> messages — same pattern desktop uses."

Wording note: desktop's exact labels are **"Always sign messages"** (DM/New-DM
dialog) and **"Require Message Signing"** (Space owner setting). Match those
verbatim, not a paraphrase like "Sign Messages".

## Why this is its own task (not a label change)

The DM "Always sign messages" toggle is **functional on desktop** — it gates the
send path, and pairs with a per-message lock/unlock button in the composer.
Mobile has **none** of that machinery. Surfacing the toggle alone would ship a
dead control (the exact mistake we avoided with edit-history). So this is a
feature port, spun out of the mute/edit-history branch
(`feat/dm-mute-native-suppress-and-edit-history`), which deliberately did NOT
surface the signing toggle.

## How desktop actually wires it (verified 2026-06-25)

Stored field is `isRepudiable` (DM: `conversation.isRepudiable`; Space:
`space.isRepudiable`). The UI presents the **inverse** — signing ON ⇔
`isRepudiable === false`. Default everywhere is `isRepudiable` unset → treated as
"sign" (`nonRepudiable ?? true`).

**The send gate (the part mobile is missing):**

- DM — `src/components/direct/DirectMessage.tsx:399`:
  ```ts
  const effectiveSkip = nonRepudiable ? false : skipSigning;
  ```
  `nonRepudiable` = the conversation's "Always sign messages" value
  (`= !isRepudiable`). When ON → always sign (per-message button overridden).
  When OFF → defer to `skipSigning` (the per-message composer lock button).
- Space — `src/components/space/Channel.tsx:402/508/553/609/650`:
  ```ts
  const effectiveSkip = space?.isRepudiable ? skipSigning : false;
  ```
  i.e. when signing is **required** (`!space.isRepudiable`) → always sign; when
  the owner left it optional (`space.isRepudiable`) → defer to the per-message
  `skipSigning` button.
- `effectiveSkip` is threaded down to `MessageService.submitMessage` /
  `submitChannelMessage` as the `skipSigning` arg; the service signs only when
  `!skipSigning` (`MessageService.ts:2597`, `4757`, `4890`, `5002`, `5082`).

**The per-message composer button:** `MessageComposer.tsx:869-883` renders a
lock/unlock icon (`skipSigning ? 'unlock' : 'lock'`) that toggles `skipSigning`
in `DirectMessage.tsx:1088-1089` (DM) and `Channel.tsx` (Space). Only meaningful
when the conversation/space allows opt-out (i.e. signing not forced).

## Current mobile state (verified 2026-06-25)

| Piece | Desktop | Mobile |
|---|---|---|
| DM "Always sign messages" toggle | ✅ Conversation Settings + New DM dialog | ❌ not surfaced (held out of the mute/edit-history branch) |
| DM send honors the flag | ✅ `effectiveSkip` | ❌ **always signs** unconditionally (`hooks/chat/useSendDirectMessage.ts:199`, no `skipSigning`, never reads `isRepudiable`) |
| Per-message composer lock button | ✅ `skipSigning` | ❌ not implemented |
| Space "Require Message Signing" (owner) | ✅ | ✅ exists — `components/SpaceSettingsModal.tsx:1411` ("Require Message Signing"), inverted value already correct (`value={!isRepudiable}`) |
| Space send honors `space.isRepudiable` | ✅ | ⚠️ **VERIFY** — `services/space/spaceMessageService.ts` signs (lines ~328, ~439); confirm whether it already gates on `isRepudiable`/`skipSigning` or always signs |
| Space per-message composer lock | ✅ | ❌ not implemented |

The mobile DM `DMSettingsSheet.tsx` already carries `isRepudiable` +
`onToggleRepudiable` props (left optional/unused on purpose) so the eventual
wire-up is small. `app/(tabs)/messages/dm/[id].tsx` has a
`updateConversationSetting({ ... })` helper ready to persist `isRepudiable`.

## What to do

1. **Send-path gating (the core).**
   - DM: `useSendDirectMessage.ts` — read the conversation's `isRepudiable`,
     compute `effectiveSkip = !isRepudiable ? false : skipSigning` (signing
     ON when `isRepudiable` is false/unset), and only attach the signature when
     `!effectiveSkip`. Default = sign.
   - Space: `services/space/spaceMessageService.ts` — first CONFIRM current
     behavior, then gate on `space.isRepudiable` mirroring desktop's
     `effectiveSkip = space?.isRepudiable ? skipSigning : false`.
2. **Per-message composer lock button.** Add a lock/unlock control to the mobile
   composer that toggles a `skipSigning` state, shown only when the
   conversation/space permits opt-out (DM: `isRepudiable === true`; Space:
   `space.isRepudiable === true`). Thread `skipSigning` into the send calls.
3. **Surface the DM "Always sign messages" toggle** in `DMSettingsSheet.tsx`
   (inverse of `isRepudiable`, default ON) and wire `onToggleRepudiable` from
   `[id].tsx` via the existing `updateConversationSetting` helper. Do this LAST,
   only after 1 makes it functional.
4. **(Optional) New-DM dialog toggle.** Desktop also exposes "Always sign
   messages" at conversation-creation time (New Direct Message dialog). Decide
   whether mobile needs it on first send or can default ON and let the user
   change it in settings.
5. **Verify both directions, both surfaces:** ON → every message signed (button
   overridden/hidden); OFF → per-message lock button decides; receiver verifies
   signatures correctly in both cases (don't break decrypt for unsigned msgs).

## Files

- `hooks/chat/useSendDirectMessage.ts` — DM send-path signing gate
- `services/space/spaceMessageService.ts` — Space send-path signing gate (verify first)
- mobile composer (DM + Space) — per-message lock/unlock button + `skipSigning` state
- `components/Chat/DMSettingsSheet.tsx` + `app/(tabs)/messages/dm/[id].tsx` —
  surface the DM "Always sign messages" toggle (props already present)
- `components/SpaceSettingsModal.tsx` — Space label already correct; no change
  unless the send-path verify turns up a gap

## Caveats

- Touches the **crypto send path** on both surfaces — not zero-risk. Static-
  verify the signature attach/skip in the exact compiled path, runtime-verify
  send+receive both ways before shipping (see memory
  `verify-statically-before-expensive-rebuilds`).
- Receiver-side signature verification must tolerate intentionally-unsigned
  messages (when the sender opted out) without dropping them.

*Last updated: 2026-06-25*
