---
type: bug
title: "The server rejects every primary .q publish, so nobody can have one"
status: open
priority: high
created: 2026-08-06
updated: 2026-08-06
area: public-profile API / QNS validation
repos: server (quorum messenger API) — no client change can fix this
source: measured 2026-08-06 against api.quorummessenger.com from a mobile dev build
related:
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md"
  - "issues/.open/2026-08-04-qns-names-and-the-identity-coverage-instrument.md"
---

# `POST /users/:addr/public-profile` refuses any `primary_username`

**This needs someone with server access. No client change can work around it.**

## The error

Publishing a public profile that carries a `primary_username` returns:

```
HTTP 400
qns primary username failed validation: qns lookup: Get "./": stopped after 10 redirects
```

The same request without the field succeeds.

## Why this is a configuration fault and not a rejected claim

The obvious reading is that the server checked the claim and found it wanting.
It did not. It never reached QNS.

Two publishes were made from the same account, seconds apart, differing only in
the name:

| name sent | does it resolve on QNS? | result |
|---|---|---|
| `gatto` | no — `GET names.quilibrium.com/resolve/gatto` is 404 | HTTP 400, error string above |
| `lamat` | yes — resolves, to a *different* address | HTTP 400, **byte-identical** error string |

A working ownership check would have to distinguish those two. It does not, so
the failure happens before the name is ever considered. `Get "./"` is a Go HTTP
client error on a relative URL: the QNS base URL the server builds its lookup
from is empty or malformed, so the request resolves against itself and loops
until the redirect limit.

The consequence is that the validation **can never pass, for any name, for any
user, however legitimately they own it.**

## What this explains

- An account that genuinely owns `lamat`, with a public profile, has no
  `primary_username` in its published record. Measured:
  `GET api.quorummessenger.com/users/QmVYRW…/public-profile` returns only
  `bio, display_name, profile_image, signature, timestamp`.
- quorum-desktop hard-codes "always sign v1, never send the field"
  (`src/api/PublicProfileService.ts:22-27`), with a comment attributing it to
  there being no desktop UI. Whatever the intent, it is also the only reason
  desktop never trips this.
- The whole QNS primary-name tier — the rung that outranks a user's display
  name everywhere — has never once worked end to end in production.

## What is NOT broken

Worth stating, because it narrows the fix:

- **The v2 signing payload is fine.** The rejection is `400` from the
  validation step with an explicit message, not a signature failure.
- **Publishing without a name works.** Measured the same minute: a profile went
  from `404` to `200` on a publish carrying no `primary_username`.
- **Un-electing works today.** It publishes with the field omitted, which takes
  the v1 route, which the server accepts.
- **The client is not at fault.** Mobile signs and sends correctly; this is the
  server's own validation step failing on its own outbound request.

## Good news hiding in it

The server *does* intend to validate a claimed primary name against QNS. That
closes an impersonation hole neither client covers: nothing in mobile or desktop
verifies that a claimed `primary_username` resolves back to the claimant, so a
name transferred away but still elected locally would otherwise let two accounts
render as the same `.q`. Once the lookup works, the server refuses that.

Client-side cleanup still matters (clearing the election on transfer and on
make-private, shipped separately) but it is defence in depth rather than the
only line.

## How to reproduce

1. Any account with a public profile.
2. `POST /users/:addr/public-profile` with a `primary_username` field and the
   v2 signature payload.
3. Observe the 400 above. The name's registration status is irrelevant.

## Definition of done

- [ ] The QNS lookup URL used during primary-username validation is configured
      correctly, confirmed by a publish carrying a legitimately owned name
      returning 200.
- [ ] A publish carrying a name the account does NOT own is refused with an
      error that names the actual reason.
- [ ] Re-measure: `GET /users/:addr/public-profile` shows `primary_username`.

## Questions for whoever owns the server

1. What is the validation supposed to check — that the name resolves to the
   publishing address, or only that it exists?
2. Is the QNS base URL an env var that is unset in this deployment?
3. Should `primary_username` be inside `canonicalize`, so a stale relay cannot
   strip it? Today it is covered by the v2 payload but is not part of the
   canonical signed profile fields shared with the space wire.
