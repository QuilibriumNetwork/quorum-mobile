# DM "delete your own message" (delete for everyone) — mobile

Plain-language reference for what this feature does, why the security fix was
needed, and what is and isn't covered. Written so a non-specialist can defend the
change in review.

## What the feature is

On desktop you can already delete your own DM message and it disappears for the
other person too ("delete for everyone"). Mobile previously only deleted the
message **locally** — it vanished on your phone but the other person (and your
own other devices) still saw it. This change makes mobile match desktop.

## How it works, in one paragraph

When you delete your own DM message, two things happen:
1. **Locally:** the message is removed from your phone immediately (optimistic).
2. **Over the network:** your phone sends a tiny "control message" of type
   `remove-message` (it just says "remove the message with this id") through the
   same encrypted DM channel a normal message uses. Because every device in a
   conversation is its own inbox, that one send is meant to reach the other
   person's device **and** your own other devices, so the delete shows up
   everywhere on the next sync.

On the receiving side, the app sees the `remove-message`, checks it's allowed
(see below), removes the message from its storage + the on-screen list, and does
**not** save the control message as a visible chat bubble.

## The security fix — why it was necessary (the important part)

### The problem
A `remove-message` carries a field called `senderId` that says "who is asking for
this delete." That field is just **text written by whoever sends the message** —
it is not proven by the encryption. The first version of the receive check
compared that text field against the deleted message's stored author field. Both
are text the sender can influence.

That's exploitable: the person you're chatting with knows the id of a message
**you** wrote. They could send a `remove-message` that *claims* `senderId = your
address`, pointing at your message. The naive check would see "claimed deleter ==
message author" and delete **your** message — even though they wrote it, not you.
That breaks the core rule: **only the author can delete their own message; a peer
can never delete a message you wrote.**

### The fix
Encryption already proves *which conversation/session* a message came from — and
therefore who really sent it. That "proven sender" cannot be faked without the
other person's secret keys. The fix authorizes the delete against that **proven
(cryptographically authenticated) sender**, not the text `senderId` field. So:

- A peer can write anything in `senderId`, but they can't change who the
  encryption says they are → they can only delete messages **they** actually
  authored.
- Your own delete still reaches your other devices, because there the proven
  sender is genuinely you.

### Why a subtlety ("multi-device") was handled carefully
When your own delete arrives at your *second* device, the app internally relabels
the conversation to point at the other person (so it files the message in the
right chat). If we read the "proven sender" after that relabel, it would look
like the message came from the other person and your own delete would be
wrongly rejected. So we capture the proven sender **before** that relabel. This
keeps "delete syncs to my own devices" working while still blocking peers.

### Is desktop affected?
Yes — desktop has the same weak check (and, worse, the same pattern in **space**
message deletion, where it gates against role permissions using that spoofable
field, so it could let someone delete *anyone's* space messages). That is tracked
as a separate desktop task; this mobile change does not fix desktop. Mobile's
own **space** delete path has the same latent issue and is tracked as a separate
mobile task. This feature only covers **mobile DM** delete.

## What this change touches (for the curious)

- `hooks/chat/useDeleteDirectMessage.ts` — send the `remove-message` after the
  local delete (best-effort; a send failure never undoes the local delete). Also:
  the send is **not** gated on `isConnected` — it always enqueues, so a transient
  disconnect doesn't silently drop the delete (the WS client flushes its queue on
  reconnect). This fixed a real bug where deletes vanished during brief
  disconnects.
- `hooks/chat/useSendDirectReaction.ts` — the encrypt-and-send helper used by
  reactions was generalized to `sendEncryptedControlMessage` and reused. The
  reaction send behaves identically (the extracted function is the old reaction
  send code verbatim; the reaction wrapper just calls it).
- `context/WebSocketContext.tsx` — two receive branches (a fast "batch" path and
  a "fallback" path) that recognize an incoming `remove-message`, run the
  authorization check, and remove the message. Plus a small pre-existing
  reaction-cleanup bug fixed along the way (inbox cleanup that silently no-op'd
  is now correct; the reaction itself was always applied and is untouched).

## Verification status (what we checked, and what we couldn't)

**Checked and confirmed (does NOT break anything):**
- `tsc`: the 4 changed files have zero type errors (the project's pre-existing
  errors are in untouched files).
- Lint: zero errors on the changed files.
- Reaction send: unchanged behavior — the helper used is the old reaction-send
  code moved verbatim.
- Normal DM/space receive: unaffected — the new branches only run for
  `type === 'remove-message'`; everything else falls through as before.
- Cross-account legit delete on desktop: traced in code — desktop's matching
  auth fix HONORS a real partner's delete (it only blocks the spoof). No
  regression to legitimate deletes.

**Could NOT verify end-to-end (blocked by a pre-existing, separate issue):**
- Live mobile→desktop delete propagation, because desktop↔mobile message delivery
  itself is unreliable (a long-standing infrastructure sync problem tracked
  separately — see `.agents/issues/.open/2026-06-13-desktop-to-mobile-messages-fail-decryption-invalid-signature.md`).
  The delete was confirmed leaving mobile correctly (encrypted to all devices on
  the wire) and desktop's handler was confirmed to honor it in code — but the
  message simply doesn't always arrive, same as normal messages.
- Self-sync to your OWN desktop: desktop deliberately does NOT auto-apply a
  delete that came from your own other device (it can't tell it apart from an
  impersonation attempt, due to an SDK limitation), so it updates on reload. This
  is a documented desktop trade-off, not a mobile bug. Mobile DOES honor self-sync.

## Transport: deletes use the SAME path as normal messages

The delete's `remove-message` is sent through `sendEncryptedMessageToAllDevices`
— the exact transport a normal DM text message uses. It fans out to **every**
device of the recipient and to your own other devices, reusing existing
encrypted sessions and establishing new ones where needed.

This was a deliberate correction. An earlier version of this feature borrowed the
**reaction** transport, which sends through only a single established session and
therefore reaches fewer devices. That is almost certainly why early testing
showed mobile→desktop deletes never landing while normal messages sometimes did:
normal messages fan out to all devices, the old delete path did not. Reactions
still have this single-session limitation (separate, lower-priority).

## Why a delete might still "not land" on the other device

Even with the correct transport, a delete is a no-op on the receiver if the
**original message never arrived there**. The receiver's handler looks up the
target message by id; if it isn't in their storage (because the original didn't
sync), there is nothing to remove and it silently does nothing. So:

- To verify deletion works, delete a message you've **confirmed** is visible on
  the other device.
- If normal messages themselves don't reliably sync mobile→desktop (a separate,
  pre-existing sync issue), deletes will appear unreliable for the same reason —
  they now ride the same rails, so they're only as reliable as normal messages.

*Last updated: 2026-06-25*
