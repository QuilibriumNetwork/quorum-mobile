---
type: bug
title: "A disconnected composer queued exactly one message, then went quiet"
status: done
priority: high
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
area: composer / send path (DM + space)
related:
  - "issues/.done/2026-07-24-layer1-durable-send-remove-preflight-throw.md (the change that exposed this)"
---

# A disconnected composer queued exactly one message, then went quiet

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Symptoms

While offline (airplane mode), the first message could be composed and sent
normally: the bubble appeared with its `sending` spinner and queued for
delivery. Every send after that was impossible. The composer's send button sat
on a persistent spinner and would not accept another message for the entire
duration of the disconnect.

Found by LaMat on-device 2026-08-01, while running the airplane-mode verification
that the Layer 1 durable-send task still owed. It blocked that verification:
the test plan calls for several messages queued offline to check flush order
and duplicates, and only one could be sent.

## Root cause

A second-order effect of Layer 1, not a defect in it. Both composers gated
sending on the send mutation's `isPending`. That was harmless while a send
always settled in well under a second, but the durable outbound queue changed
what "pending" means: a send started while disconnected stays pending until
the socket reopens. So `isPending` stayed true for the whole offline window,
and everything gated on it stayed shut.

There were **two independent gates**, and fixing either alone still loses
messages:

1. **The button.** `isSending` (`DMChatArea.tsx:531`, `SpaceChatArea.tsx:801`)
   was bound to `mutation.isPending`, and feeds `canSend` in
   `MessageInput.tsx:376`, which drives `disabled` on the send button and swaps
   the icon for an `ActivityIndicator`. This is the visible half, and the only
   half that is obvious from the device.
2. **The handler.** `handleSendDirectMessage` (`DMChatArea.tsx:266`) and
   `handleSendMessage` (`SpaceChatArea.tsx:424`) both opened with
   `if (mutation.isPending) return;`. This is the half that actually drops the
   send. With only the button fixed, taps would land and go nowhere silently.

## Fix

Drop both gates (branch `fix/offline-composer-allows-one-message-only`).

The optimistic bubble already carries its own per-message spinner
(`MessagesList.tsx:1398`), which is the honest indicator now that `sent` is
driven by real transmission rather than by enqueue. The composer-level spinner
was duplicating it while blocking input.

Double-tap protection is retained without `isPending`: the empty-text guard in
each handler and `canSend` in `MessageInput` both fail once `setMessageText('')`
has rendered, and a repeat inside one frame is not a human input rate.

## Verified

LaMat on-device 2026-08-01, airplane mode, DM and space: multiple messages
compose and queue while disconnected, and deliver on reconnect.

## Side note: why the mutation stays pending offline

The gates fired because `isPending` stays true for the whole disconnect. That
is the mutation behaving as designed, not a second defect — a send genuinely is
in flight until the socket reopens. It only became a problem because two pieces
of UI treated "pending" as "busy for a moment".

> **Retracted 2026-08-01.** An earlier version of this note named the
> timeout-less `apiClient.fetchUserRegistration` (`useSendDirectMessage.ts:363`)
> as the cause. That was a guess and it does not fit: that line runs only when
> the recipient has no known devices AND no existing session, which is not the
> case in an established DM. Nothing was ever measured — `logger.debug` is
> suppressed by default (`minLevel` is `log`, and nothing calls
> `logger.configure`), and JS console output does not reach logcat, so the
> offline window produces no evidence at all. Do not carry this forward as a
> diagnosis.

## Real follow-up: the outbound queue does not survive the app process

Found 2026-08-01 while discussing the above. `outboundQueue` and
`pendingEnvelopes` are plain in-memory instance fields on the WS client
(`quorum-shared/src/transport/rn-websocket.ts:45,52`) with no persistence. So
Layer 1's durability is **process-lifetime durability**: it survives a
disconnect, not an app restart.

Reproduced by LaMat: offline → send → reload the app → back online. The message
never delivered, and its bubble kept spinning indefinitely.

This is not an artificial sequence. Android reclaims backgrounded apps on its
own, so the same loss happens unprompted: send offline, background, get killed,
message silently gone.

There is currently no way out for that bubble. `onFlushed` cannot fire for a
queue that no longer exists; there is no timeout to flip it to `failed` (that
needs Layer 2's delivery confirmation — see the Layer 1 task's FINDING note on
why a naive timer is wrong); and the Retry button is §3, deferred to Layer 2.

Tracked as its own bug: `issues/.open/2026-08-01-outbound-queue-lost-on-app-restart.md`.

---

_Last updated: 2026-08-01_
