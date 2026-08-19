---
type: task
title: "Fire-and-forget dynamic imports have no .catch(), so a module-resolution failure is an unhandled rejection"
status: open
priority: low
created: 2026-08-19
updated: 2026-08-19
area: error handling / code health
related:
  - "issues/2026-08-18-dm-identity-reveal-ledger-plan.md (added three more instances of this pre-existing pattern)"
---

# `void import(...).then(...)` without a `.catch()`

## Summary

Several fire-and-forget call sites use this shape:

```ts
void import('@/services/dm/dmProfileService').then(({ someFn }) => someFn(...));
```

The called function has its own internal `try/catch`, so a throw *inside* it is
handled. What is NOT handled is a rejection of the **dynamic `import()` itself**
— a module-resolution failure produces an unhandled promise rejection.

## Why it is worth a small cleanup

Three of these paths are on hot or latency-sensitive code (a message send's
`onSuccess`, a WebSocket receive callback, call signalling) and each carries a
stated requirement that it must never throw into the path that calls it. The
requirement is met for every realistic failure except this one narrow case, so
the guarantee is *almost* airtight rather than airtight, and the gap is
invisible in review because the inner `try/catch` looks like full coverage.

## Known instances

READ, 2026-08-19. This is a pre-existing pattern, not something introduced by
one change:

- `components/ProfileModal.tsx:1176`, `:1286` (pre-existing)
- `components/UnifiedProfileEditModal.tsx:240` (pre-existing)
- `hooks/chat/useSendDirectMessage.ts` — the `onDeliberateDmSend` trigger
- `hooks/chat/useSendDirectEmbedMessage.ts` — same
- `context/WebSocketContext.tsx` — the `autoRevealOnInboundSession` trigger
- `context/CallContext.tsx` — the offer/answer reveal trigger

Re-grep before starting; the list may have grown.

## Fix

Add a `.catch()` that logs and swallows, matching the repo's logging
conventions. Check `__tests__/loggingPolicy.test.ts` first — it constrains what
may be logged, and identity-bearing values such as addresses must be truncated
rather than logged raw.

Consider a tiny shared helper so the next such call site gets it for free,
rather than seven hand-written catches that can drift.

## Status

Open, not started. Triaged as a single follow-up item by the whole-branch review
of the DM identity reveal ledger branch, which judged it "not a new class of bug,
just more of it" and explicitly non-blocking.

---
*Last updated: 2026-08-19*
