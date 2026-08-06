---
type: bug
title: "Public Profile can be ON with nothing published, forever, and the UI says otherwise"
status: open
priority: medium
created: 2026-08-06
updated: 2026-08-06
area: public profile / settings
repos: quorum-mobile (check quorum-desktop for the same shape)
source: measured 2026-08-06 on a device whose toggle had been on for weeks with a 404 behind it
related:
  - "issues/2026-08-06-decouple-qns-primary-name-from-public-profile-design.md"
  - "issues/.open/2026-08-06-server-rejects-every-primary-username-publish.md"
---

# The toggle is local state that never reconciles with the server

## The symptom

A test account had **Public Profile ON** — untouched for weeks, restored from
synced config — while `GET /users/:addr/public-profile` returned **404**. No
record existed at all. The settings row meanwhile read:

> Let anyone see your display name, picture, bio, and QNS username, even
> outside shared spaces.

Nobody could see any of it. There was nothing to see.

## Why

The publish happens only at the moment the toggle is flipped
(`handleTogglePublic`, `components/ProfileModal.tsx`) or when a profile edit
happens to run one. Nothing else ever checks. So any of these leaves the user
permanently mismatched:

- the publish at flip time failed (offline, server error, app killed mid-flight)
- the toggle arrived from synced config on a new install, where no publish is
  ever attempted for it
- the record was deleted server-side afterwards

The toggle is stored locally and synced as config. The published record lives on
the server. Nothing reconciles the two, and nothing retries.

The failure is silent in the worst direction for a privacy control: the user
believes they are discoverable and is not. It is the same shape as the primary
`.q` bug next door — local state asserting something the server was never told.

## Not the same as the QNS server bug

Distinct causes, and this one is fixable on the client. This bug is "no publish
was ever attempted, or one failed and was forgotten". That one is "the publish
is attempted correctly and the server refuses it". They were measured in the
same session and it would be easy to conflate them.

## Sketch of a fix

Reconcile on a cheap trigger rather than adding a background job:

- On app foreground, or on opening the privacy settings, if `isProfilePublic`
  is true, `GET` the own public profile. A 404 means republish.
- Cheap because the own profile is already fetched and cached for other
  reasons.
- Failing that, at minimum surface the mismatch in the settings row rather than
  asserting a state that was never verified.

Do NOT make the toggle itself await the publish. The local setting is the
user's intent and should not be held hostage to the network; the gap is the
absence of any later reconciliation, not the optimistic write.

## Definition of done

- [ ] A device with `isProfilePublic` true and no published record republishes
      without the user doing anything.
- [ ] Verified by deleting the record server-side and confirming it comes back.
- [ ] Check quorum-desktop for the same gap (its publish is centralised in
      `useUserSettings.saveChanges`, so it likely shares the shape).
