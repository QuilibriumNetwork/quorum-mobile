---
type: task
title: "Drop the local StoredMessage shim once quorum-shared publishes authenticatedSenderId"
status: done
priority: medium
created: 2026-08-20
updated: 2026-08-21
area: types / cross-repo dependency
related:
  - "quorum-shared PR #85 (declares Message.authenticatedSenderId)"
  - "quorum-mobile PR #264 (added the shim so this repo could ship without waiting)"
  - "quorum-desktop PR #357 (the desktop half; it links quorum-shared locally so it never needed a shim)"
  - "issues/.open/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md (waiting on the SAME gate — do both in one bump)"
---

# Delete `services/dm/storedMessage.ts` after the next quorum-shared release

## Status

**2026-08-21 — shipped in PR #265** (`refactor(dm): drop the local StoredMessage
shim now that shared declares the field`).

The gate opened with quorum-shared `2.1.0-45`, which declares
`authenticatedSenderId` at `dist/types/message.d.ts:309`. The version bump landed
on `master` as its own `chore:` commit (`bff5cfa`) ahead of this work, so the PR
carries only the cleanup.

The shim is deleted and every use site now names `Message` directly. Verified:

- `npx tsc --noEmit` — **12 errors, identical to the pre-bump baseline**, and
  none in any touched file. The baseline was MEASURED both ways (installed
  `2.1.0-43`, counted, restored `2.1.0-45`, counted) rather than assumed.
- `npx jest` — **125 suites / 1187 tests green**, exactly the count recorded
  below when the shim went in.
- `npx eslint` on the five touched files — 0 errors.

**One step was not in the plan above: a test asserts on the source text.**
`__tests__/dmSelfEchoGuards.test.ts:137` matched the literal string
`'channelId, authenticatedSenderId: undefined } as StoredMessage'`, so renaming
the type necessarily moved it to `... } as Message`. That is a rename following
a rename, not a weakened guard — proven by mutation: deleting
`authenticatedSenderId: undefined` from the batch-path literal turns the test
red, and restoring it turns it green. The security property the test exists for
(a space save strips the wire marker) is untouched.

The `Partial<StoredMessage>` weak-type rationale did not just evaporate with the
file. It moved to a comment on `messagesContainSelfAuthored` in
`dmRevealLedger.ts`, since that is now the only place the constraint binds.

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

- [x] Bump `@quilibrium/quorum-shared` in `package.json` to the release carrying the field. → `2.1.0-45`, commit `bff5cfa` on `master`.
- [x] Replace `StoredMessage` with `Message` at its use sites: `context/WebSocketContext.tsx` (the two DM receive saves and the two space saves), `hooks/chat/useSendDirectMessage.ts` (the optimistic message).
- [x] Replace `StoredMessageView` with `Partial<Message>` in `services/dm/dmRevealLedger.ts` and `services/dm/dmProfileService.ts`.
- [x] Delete `services/dm/storedMessage.ts`.
- [x] Update the source-text literal in `__tests__/dmSelfEchoGuards.test.ts` that names the type. *(Not foreseen above — see Status.)*
- [x] `npx tsc --noEmit` — expect the repo's pre-existing baseline and nothing new in the touched files. → 12 errors, baseline unchanged.
- [x] `npx jest` — 125 files / 1187 tests were green when the shim went in. → still 125 / 1187.

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
*Last updated: 2026-08-21*
