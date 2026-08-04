---
type: bug
title: "Chat message list jumps back to the first message again — regression of the 2026-06-22 modal-jump fix"
status: done
created: 2026-07-27
---

# Chat message list jumps back to the first message again — regression of the 2026-06-22 modal-jump fix

**Status:** ✅ SOLVED (2026-07-27). Verified on-device by LaMat: the image-enlarge and
Fix Encryption paths no longer scroll the conversation back to its start.
**Regression of:** `.agents/issues/.done/2026-06-21-chat-list-jumps-to-top-on-modal-open.md`
(read that first — it establishes the mechanism, the falsified theories, and why the fix
must live inside the library worklet).

## Symptom

In a DM (and equally in a Space channel), an action that puts a surface over the chat
scrolls the message list back toward the **start of the conversation**. Reported paths:

- tap an image to enlarge it (`ImageViewer`) — the list behind it scrolls to the start
- tap **Fix Encryption** in the DM settings sheet (confirm dialog → sheet close → native
  `Alert`) — worst case, several spurious events in a row clamp the list to y=0

Long-pressing a message (`MessageActionSheet`) does **not** reproduce it. That asymmetry
is the diagnostic tell — see below.

## Root cause

The 2026-06-22 fix guards the library's scrolling worklet with `e.target <= 0`: a native
`<Modal>` that grabs input focus emits a keyboard-geometry event with **no focused
TextInput**, and that guard drops it.

On **2026-06-26**, commit `bf5768c` ("light/dark theme contrast, Android nav bar, and
modal/onboarding polish", PR #141) added `statusBarTranslucent` + `navigationBarTranslucent`
to `BaseModal`, `CenterModal`, `ImageViewer` and `VideoViewer` — four days after the fix
was verified on-device, so the original acceptance run could not have caught it.

Those flags make the dialog window edge-to-edge over the Activity, which changes which
window owns focus/insets. The focus-less event these modals emit now arrives with a
**positive `target`**, so it walks straight past the `e.target <= 0` guard.

`MessageActionSheet` is the control: it uses a plain `<Modal transparent animationType="slide">`
with **no** translucent flags, still surrenders focus, still reports `target <= 0`, and
still does not jump. Every other chat surface — `BaseModal` (DM settings, emoji picker,
reaction details, bookmarks, pinned, channel settings, user profile) and `CenterModal`
(every destructive confirm) — carries the flags and is affected.

### Why a no-op event moves the list at all

With the guard bypassed, `onMove` runs for an event that reports `height === 0` while the
keyboard is already closed. The arithmetic is not a no-op:

1. `onStart` (never guarded, by design) takes its keyboard-closing branch and rewrites
   `offsetBeforeScroll = scroll - actualOpenShift`.
2. `actualOpenShift` still holds the shift from the **last real keyboard open** — nothing
   ever cleared it, because it is only rewritten when `effective > 0`.
3. `onMove` then computes `clampedScrollTarget(offsetBeforeScroll, 0, …)` and
   `scrollTo`s there — i.e. it yanks the list **up by a stale keyboard height**.
4. `clampedScrollTarget` floors at 0, so repeated events (modal open + close + a native
   `Alert`) walk the list to the very top: the first message of the conversation.

That is exactly the reported symptom, and it explains why "Fix Encryption" (three
surfaces in a row) is worse than a single image tap.

## The fix

`patches/react-native-keyboard-controller+1.21.11.patch`, extended with two hunks. The
original `e.target <= 0` guard is kept unchanged.

**1. NO-OP EVENT guard** (`onMove`, and safely also `onStart`):

```ts
if (freeze.value || e.target <= 0 || (e.height === 0 && padding.value === 0)) {
  return;
}
```

A keyboard event reporting height 0 while we already believe the keyboard is closed has
nothing to animate. This discriminator is **modal-agnostic** — it does not care about
`target`, window flags, or whether the surface is an RN `<Modal>` at all, so it also
covers native `Alert.alert` and system permission dialogs.

A genuine keyboard close is untouched: `padding` still holds the open height for the whole
close animation (it is only zeroed in `onEnd`), so every real frame passes the guard.
A genuine open is untouched: `onStart` sets `padding` to the full height before the first
`onMove` runs.

The 2026-06-22 doc warns that gating `onStart`/`onEnd` leaves `padding` stale and kills
the cold-open emoji-panel lift. That objection does **not** apply here: this condition
asserts `padding` is _already_ 0, so skipping the `padding.value = effective` bookkeeping
cannot make it stale. `onEnd` is left ungated.

**2. Clear the stale open-shift** (`onEnd`, defence in depth):

```ts
} else if (effective === 0) {
  actualOpenShift.value = 0;
}
```

Once the keyboard has finished closing, the open-shift has served its purpose —
`onStart`'s close branch already consumed it to restore `offsetBeforeScroll`. Zeroing it
means that even if some future focus-less event slips through both guards, the arithmetic
degrades to `scrollTo(scroll)`, a no-op, instead of a jump. A real open recomputes it in
this same handler at the end of its own animation.

## Verify / re-test

`node_modules` changed, so a Metro **cache reset** is required, not just a reload:
`.\.agents\scripts\dev-start-mobile-wifi.ps1 -ResetCache`

Acceptance (Android + iOS, scroll up into history first, then):

- **DM, keyboard down:** tap an image → enlarge and close → list holds position.
- **DM:** gear → Fix Encryption → confirm → dismiss the native alert → list holds position.
- **DM:** gear → Delete Conversation → _cancel_ → list holds position.
- **DM:** long-press a message → each drawer action (react, reply, bookmark, edit
  history, report, delete-confirm) → list holds position.
- **Space channel:** same sweep — tap an image, long-press → drawer actions, pinned
  messages, bookmarks, channel settings, a pfp tap → list holds position.
- **Regression check on the keyboard itself:** tap the composer → list lifts with the
  keyboard; dismiss → it settles back. Send a message → still scrolls to your own
  message. Emoji panel opens/closes without the list drifting.

## Files

- `patches/react-native-keyboard-controller+1.21.11.patch` — THE FIX (two added hunks).
- No app-code changes. `MessagesList` is shared by `DMChatArea` and `SpaceChatArea`, and
  both scroll through the same `ChatKeyboardScrollView`, so the single patch covers DMs
  and Spaces together.

## Note for the next regression

The trigger was a _styling_ change (`navigationBarTranslucent`) silently invalidating a
behavioural guard in an unrelated patch. If a future PR adds or removes translucent/
edge-to-edge flags on a modal that can appear over a chat, re-run the acceptance sweep
above. The NO-OP EVENT guard is meant to make that class of change harmless, since it no
longer depends on which window owns focus.

_Last updated: 2026-07-27_
