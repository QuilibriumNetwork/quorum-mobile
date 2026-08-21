---
type: task
title: "Shared's QnsBatchResult should be built on a null prototype — a claimed name is attacker text used as an object key"
status: open
priority: low
complexity: small
created: 2026-08-21
updated: 2026-08-21
area: identity resolution / QNS / shared package
repos: quorum-shared (the change); quorum-desktop and quorum-mobile both consume it
source: found by two independent reviewers during the mobile transport migration (2026-08-21)
related:
  - "issues/2026-08-17-shared-qns-transport-hardcodes-url-and-has-no-timeout.md (the migration that surfaced it)"
  - "quorum-shared src/qns/resolveBatch.ts"
---

# `QnsBatchResult` should be built on a null prototype

## Not a live vulnerability

Nothing here is exploitable today. Two reviewers attacked it independently and
neither could construct an impersonation. This is a hardening task, filed
because the safety is **incidental** rather than asserted, and because the thing
that makes it safe is not visible at the place it would break.

Do not raise the priority without a working exploit.

## What & why

`resolveNamesBatch` returns records keyed by name:

```
src/qns/resolveBatch.ts    out[name] = records[index] ?? null
```

`name` is a CLAIMED username. It arrives over the network, from an untrusted
peer, and it reaches that line as a property name on a plain object. So a claim
can be the literal string `__proto__`, `constructor`, or `toString`.

Mobile only started caring on 2026-08-21. Its claim records used to be a `Map`,
where a key is inert; adopting this transport made them a plain object.

## What actually happens (MEASURED 2026-08-21, both reviewers, independently)

- `constructor`, `toString`, `hasOwnProperty` and friends become ordinary own
  properties that shadow the inherited member on that one object. No global
  effect.
- `__proto__` does NOT become an own property. The bracket assignment invokes
  the legacy `Object.prototype.__proto__` **setter**, so it reassigns the result
  object's prototype to the record (or to `null` for an unregistered name).
  Reading it back returns the same record via the paired getter, so it appears
  to round-trip correctly.
- `Object.prototype` itself is never touched, and an unrelated name that was
  never in the request still reads as `undefined`.

## Why it is currently safe, and why that is thin

Two independent reasons, neither of them stated at the call site:

1. **The shape of the write.** It is one flat assignment onto a fresh
   per-request object, not a recursive merge. The pattern that makes prototype
   pollution dangerous — `target[a][b] = v` writing *into* a polluted
   prototype — does not exist here.
2. **The shape of the read.** `claimedNameBelongsTo` only trusts
   `record?.resolveKey` / `record?.resolve_key`. No inherited `Object.prototype`
   member has either field, so a lookup that walks the chain still fails closed.

Both are true today. Neither is enforced, and both are the kind of thing a
refactor changes without noticing:

- merging two `QnsBatchResult`s (spreading chunk results together, or merging
  answers across identities) would introduce exactly the nested-write pattern
  reason 1 relies on being absent
- relaxing the predicate to something like "any non-null record verifies" would
  remove reason 2 outright

## Proposed change

Build the result with a null prototype, so there is nothing to inherit and
nothing to reassign:

```ts
const out: QnsBatchResult = Object.create(null);
```

Cheap, local, and it makes the safety structural rather than a consequence of
two unrelated facts holding at once. Consider also skipping or rejecting a
`__proto__`-named entry outright, since no such QNS name can be legitimately
registered.

## Watch out for

- **`Object.create(null)` has no `hasOwnProperty`, `toString` or
  `Object.prototype` at all.** Any consumer calling `records.hasOwnProperty(x)`
  or interpolating the object into a string will now throw. Audit both clients
  before changing it. `Object.keys`, `Object.entries`, spread and `in` are all
  fine.
- **`JSON.stringify` still works**, so mobile's persistence exclusion reasoning
  is unaffected.
- The return TYPE does not change, so no consumer needs updating for types
  alone.

## Steps

- [ ] Switch `resolveNamesBatch`'s accumulator to `Object.create(null)`
- [ ] Add tests for `__proto__`, `constructor` and `toString` as requested names,
      asserting the returned object has no inherited members and that a
      `__proto__` entry is a real key rather than a prototype reassignment
- [ ] Grep both clients for `.hasOwnProperty(`, string interpolation of a batch
      result, and anything merging two results together
- [ ] Publish and bump both clients

## Definition of done

- [ ] A claimed name cannot reach a prototype slot on the result object
- [ ] The property is asserted by a test rather than inherited from the shape of
      the surrounding code
- [ ] No consumer breaks on the missing `Object.prototype`

## Already covered on mobile, do not duplicate

Mobile pinned the OUTCOME on its side in `__tests__/verifiedQnsNames.test.ts`
("a claimed name that collides with Object.prototype", 6 cases including a
control). Those stay useful regardless — they guard mobile's read path, which is
the half shared cannot see. This issue is about the write path.

---

*Last updated: 2026-08-21*
