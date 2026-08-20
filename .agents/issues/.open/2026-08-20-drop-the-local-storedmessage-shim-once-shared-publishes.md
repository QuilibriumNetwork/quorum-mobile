---
type: task
title: "Drop the local StoredMessage shim once quorum-shared publishes authenticatedSenderId"
status: open
priority: medium
created: 2026-08-20
updated: 2026-08-20
area: types / cross-repo dependency
related:
  - "quorum-shared PR #85 (declares Message.authenticatedSenderId)"
  - "quorum-mobile PR #264 (added the shim so this repo could ship without waiting)"
  - "quorum-desktop PR #357 (the desktop half; it links quorum-shared locally so it never needed a shim)"
  - "issues/.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md (waiting on the SAME gate — do both in one bump)"
---

# Delete `services/dm/storedMessage.ts` after the next quorum-shared release

## Why this exists

`Message.authenticatedSenderId` is declared in quorum-shared (PR #85, merged to
`master`). This repo does **not** link the local quorum-shared checkout the way
quorum-desktop does — it pins a published version in `package.json`. So the
field is invisible here until a release goes out, and PR #264 would not have
compiled.

Blocking on the release was rejected: a branch that does not compile is not
shippable, and the publish was not imminent. The field is therefore declared
locally:

```ts
// services/dm/storedMessage.ts
export type StoredMessage = Message & { authenticatedSenderId?: string };
```

This is a **deliberate, documented duplication with a removal date**, not an
accident. It is harmless while it lasts — once the published `Message` carries
the field, the intersection simply becomes redundant.

## Why it needs an issue and not just the comment

`storedMessage.ts` says all of the above in its own doc comment, including
"once quorum-shared publishes a version carrying `authenticatedSenderId`, this
whole module can be deleted". That is the right place for it, and it is also
invisible: nobody reads a file they are not already working in. Without a
backlog entry the shim quietly becomes permanent, and the next person to find it
has to re-derive whether it is still needed.

## The gate

**Blocked on:** a quorum-shared release whose `dist/types/message.d.ts` contains
`authenticatedSenderId`. As of 2026-08-20 this repo pins `2.1.0-43`, which
predates it. Confirm before starting:

```bash
grep -c authenticatedSenderId node_modules/@quilibrium/quorum-shared/dist/types/message.d.ts
# 0 = not published yet, this issue stays blocked
```

> **Do this together with the QNS transport cleanup.** That issue
> (`.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md`)
> is waiting on the same thing: a quorum-shared release and a version bump here.
> Bumping once and doing both is strictly cheaper than bumping twice, and the
> RECAP already notes that the pinned `2.1.0-43` also predates shared #82's
> log-redaction fix.

## The work

Small and mechanical. Every use is in the DM path.

- [ ] Bump `@quilibrium/quorum-shared` in `package.json` to the release carrying the field.
- [ ] Replace `StoredMessage` with `Message` at its use sites: `context/WebSocketContext.tsx` (the two DM receive saves and the two space saves), `hooks/chat/useSendDirectMessage.ts` (the optimistic message).
- [ ] Replace `StoredMessageView` with `Partial<Message>` in `services/dm/dmRevealLedger.ts` and `services/dm/dmProfileService.ts`.
- [ ] Delete `services/dm/storedMessage.ts`.
- [ ] `npx tsc --noEmit` — expect the repo's pre-existing baseline and nothing new in the touched files.
- [ ] `npx jest` — 125 files / 1187 tests were green when the shim went in.

⚠️ **Do not change the field's write sites while doing this.** The stamps in
`WebSocketContext.tsx` are written *after* the spread of the wire message, and
`__tests__/dmSelfEchoGuards.test.ts` asserts that ordering deliberately. This is
a type-only cleanup; if a test in that file goes red, something more than the
type changed.

⚠️ **`StoredMessageView` is `Partial<StoredMessage>` on purpose.** An
all-optional type with no property names in common with `Message` trips
TypeScript's weak-type detection, so a real `Message[]` out of storage is not
assignable to it. `Partial<Message>` keeps that working; a hand-written
`{ authenticatedSenderId?: string }` does not.

---
*Last updated: 2026-08-20*
