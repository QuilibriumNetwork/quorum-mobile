---
type: bug
title: Space calls never start (prod API lacks the call endpoints) and a failed start leaves a permanent "call in progress" banner
status: in-progress
created: 2026-08-10
updated: 2026-08-10
---

# Space calls never start, and every failed start leaves a permanent banner

## Symptom (as reported)

Starting a voice/video call in a channel doesn't work — the call never
starts — but a "call in progress / Join" banner appears in the channel and
persists forever. The same banner is also the UI for a genuinely working
call, so it can't just be suppressed.

## TL;DR — two independent root causes, stacked

1. **Server (not fixable in this repo): the production API does not serve
   any of the call endpoints.** Every space-call join dies at its first
   network step with HTTP 404. Calls cannot work in production at all —
   "often broken" is actually "always broken"; any perceived variation is
   in how the failure is (not) surfaced.
2. **Client (ours to fix): the protocol announces the call before knowing
   it exists, and never reconciles.** The `space-call-start` chat message —
   which IS the banner — is broadcast to the channel *before* the join is
   attempted; the join-failure path deliberately does not send
   `space-call-end`; and the banner is derived purely from chat messages
   with no liveness or staleness check. One failed start = one immortal
   banner for every member, forever.

Layer 2 matters even after layer 1 is fixed server-side: a crash, force-kill
or network drop of the last participant would still mint immortal banners.

## Evidence

Claims are labeled MEASURED (recorded observation), READ (code, cited), or
INFERRED (reasoning, needs confirmation).

### MEASURED — the production API has no call routes (2026-08-10)

```
GET  https://api.quorummessenger.com/sfu/room/<any>   → 404 "page not found"
POST https://api.quorummessenger.com/relay/circuit    → 404 "page not found"
POST https://api.quorummessenger.com/sfu/join         → 404 "page not found"
```

Control arm, same host, same moment: `GET /inbox/<junk>` → **400** (a real,
handled route rejecting bad input). So the server is up and routing; the
bare-text `404 page not found` (Go mux default) on the three call routes
means those routes are **not registered** on the production deployment.
`sfu-client.ts` and `relay-client.ts` both build URLs from
`getApiConfig().baseUrl`, which is `https://api.quorummessenger.com` in
production builds with no override (`services/api/config.ts:17-53`).

Repro: `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{}' https://api.quorummessenger.com/relay/circuit`

### READ — the client-side failure chain (file:line)

1. **Start announces before joining** — `app/(tabs)/spaces/[id]/[channelId].tsx:220-257`:
   `startSpaceCall` sends the `space-call-start` message, optimistically
   inserts it into the message cache, `enqueueOutbound`s it to every member,
   and only *then* calls `joinSpaceCall(...)` — **fire-and-forget**: not
   awaited, no `.catch`. The screen-level `catch` (line 254) only covers
   message construction, never the join. A join failure is an unhandled
   promise rejection; the user sees nothing.
2. **Every join dies at step one** — `SpaceCallContext.tsx:626-630` calls
   `relayClient.allocateCircuit(...)` → `relay-client.ts:78-82` throws
   `Circuit allocation failed: 404` (blind-token acquisition fails first
   and falls back to Ed448, but the circuit POST itself 404s regardless).
3. **The failure path deliberately stays silent in the channel** —
   `SpaceCallContext.tsx:936-947`: the catch runs
   `enterEnding('join_error', { announceEnd: false })`. The comment says
   "no 'call ended' bubble belongs in the room" — true for a *joiner*, but
   for the *starter* the start bubble is already in the room, so nothing
   ever closes it.
4. **The banner is pure message-derivation** — `MessagesList.tsx:1082-1112`
   builds `endedSpaceCalls` (callId → endedAt) from `space-call-end`
   messages only; `SpaceCallBubble.tsx` renders "call in progress" + live
   ticking timer + Join button for any start without a matching end. No
   TTL, no liveness probe, nothing.
5. **A tapped Join fails silently too** — `SpaceCallBubble.tsx:85-97`:
   `catch → logger.debug` (a no-op in production builds per the 2026-08-04
   logger finding). Spinner stops, no feedback.

### READ — adjacent defects in the same lifecycle

- **Any leaver ends the banner for everyone** — `SpaceCallContext.tsx:950-954`:
  `leaveCall()` always runs `enterEnding('user_leave', { announceEnd: true })`,
  which posts `space-call-end` even if other participants are still in the
  call. First person to leave a real 3-way call kills the banner (and the
  Join affordance) for the whole channel. Premature-end twin of the
  reported never-ends bug.
- **`room_gone` announces nothing** — `SpaceCallContext.tsx:246-255`: if
  the SFU drops the room (SFU restart, last peer vanishes), every remaining
  client exits with `announceEnd: false` → nobody posts the end message →
  immortal banner again.
- **Crash/force-kill of the last participant** — no path exists to post the
  end message. Immortal banner.
- **`phase: connected` is set on SDP answer, before ICE actually connects**
  (`SpaceCallContext.tsx:885-897`) — with TURN infra unreachable the app
  would claim "connected" and only recover via `pc_failed` later. Cosmetic
  today (we die long before this), relevant once the server side ships.
- **DM calls are equally dead** — `CallContext.tsx:252,395` uses the same
  `allocateCircuit` against the same 404 route. Worth one manual confirm,
  but the code path admits no other outcome in production.

### READ — desktop has no space-call feature

`space-call-start` exists only as a type in
`quorum-shared/src/types/message.ts:262`. quorum-desktop has zero rendering
or send-side code for it (repo-wide grep). Mobile is the only client that
can mint these messages; desktop members presumably see nothing for them.
No desktop semantics exist to copy — and per
[[mobile-desktop-parity-is-the-objective]] this whole feature is a
mobile-only divergence to flag.

### INFERRED — how it got here

The calling stack arrived in bulk upstream drops (`git log`:
"catching up public repo", "latest updates") — Lead Dev's code, presumably
developed against a dev/staging server where `/relay/circuit` and `/sfu/*`
exist(ed). Production either never got them or they were removed. **Needs
Lead Dev confirmation** — we cannot see the server repo from here.

## Potential fixes

Ordered; F1-F3 are client-side UX/reliability and safe to do without
protocol opinions. F4 changes message semantics and F5 is server-side —
both are Lead Dev territory (see [[quorum-mobile-architecture-caution]]).

- **F1 — transactional start.** Generate the `callId`, run the join
  (circuit + SFU + local media) first, and only send `space-call-start`
  after the join succeeds. On failure: toast ("Couldn't start the call"),
  no channel message, no banner. This alone eliminates the reported
  repro. Requires moving callId generation out of
  `sendSpaceCallStartMessage` (trivial — it's a local template string,
  `spaceMessageService.ts:1269`).
- **F2 — surface failures.** Await the join everywhere; replace the
  debug-only catches in `startSpaceCall` and `SpaceCallBubble.handleJoin`
  with a toast (ToastContext already exists; repo is mid-migration off
  `Alert.alert` anyway). Kills the silent-failure class including the
  unhandled rejection.
- **F3 — liveness-gated banner.** For a non-ended start bubble, verify the
  room actually exists before presenting it as live: `GET /sfu/room/:id`
  (`sfu-client.ts getRoomInfo`) on bubble mount + slow poll while visible.
  Room absent → render the "ended/unavailable" state instead of a live
  timer + Join. Grace window (~60s from the start message) covers the gap
  where the starter hasn't completed `sfu/join` yet; on network error fall
  back to time-based staleness (a start older than a few hours with no end
  is stale) rather than declaring death while offline. This retroactively
  neutralizes every immortal banner already sitting in history, and covers
  the crash/`room_gone` cases F1 can't. Note: while prod still 404s, every
  banner correctly renders as unavailable — which is the truth.
- **F4 — end-announcement semantics (flag to Lead Dev, don't freelance).**
  `space-call-end` should mean "the call is over", not "I left": post it
  only when leaving as the last participant (SFU participant list is
  available at leave time), and let `room_gone` announce when the room is
  observed dead. With F3 in place the end message becomes a hint rather
  than the source of truth, so this can wait for his call.
- **F5 — server: register the call routes.** Report to Lead Dev with the
  MEASURED section above. Nothing in this repo can fix a missing route.

## Automated tests

> **Correction (2026-08-10):** an earlier revision of this doc claimed the
> repo had "zero app-level unit tests". That was wrong — there are **57**
> tracked suites in `__tests__/`, run by `yarn test` (jest-expo preset,
> configured in `jest.config.js`). The error came from a glob that returned
> only `node_modules` hits and was truncated before reaching the real ones.
> The conventions below follow those existing suites.

**Doing: unit tests on the extracted derivation function.** The F3 logic is
genuinely branchy (end-message precedence, grace window, room-gone vs
probe-unreachable, staleness cutoff) and every branch is invisible from the
UI — the exact "silently wrong for months" shape. Extracted as a pure
`deriveSpaceCallStatus({ startedAt, endedAt, liveness, now })` in
`services/calling/spaceCallStatus.ts`, tested in
`__tests__/spaceCallStatus.test.ts`.

**Not doing (deliberately): the `call-infra` harness scenario.** Proposed in
an earlier revision, dropped on review. Its pass branch cannot be validated
against anything while the endpoints 404, so it would be a test whose green
path is guesswork — the kind that manufactures false confidence. Its
diagnostic value is already delivered by the curl probe recorded above. The
right time to build it is the day the routes ship, when it can be validated
against a working server. Standing scope limit either way: Node cannot run
`react-native-webrtc`, so the media plane (ICE/DTLS/RTP through TURN) is not
cold-testable at any effort.

Manual UI residue (one short scripted pass, after fixes): start a call on
the phone → expect a toast and **no** banner in the channel; existing
historical banners → expect "unavailable/ended" rendering. Pass/fail only.

## Status

**2026-08-10 — shipped in PR #248** (`fix: a call that never started no longer
leaves a permanent join banner`). F1, F2 and F3 landed; **F4 and F5 remain
open**, so this issue stays in progress. Root cause was established first (both
layers measured/read, none inferred-only).

Layer 2 (the client-side zombie banner) is fixed. **Layer 1 is not and cannot be
fixed here** — production still serves no call routes, so space calls and DM
calls alike still do not work. What changed is that failing now costs a toast
instead of a permanent artifact.

Device-confirmed by Kyn on 2026-08-10: starting a voice/video call in a channel
shows the error toast and leaves **no banner**. Not yet confirmed on device: that
pre-existing zombie banners in channel history now render as "call ended" (the
retroactive half of F3), and the offline behaviour.

Shipped in this branch:

- **F1** — `startSpaceCall` joins the room before announcing anything
  (`[channelId].tsx`). `joinCall` now returns `Promise<boolean>` so a join
  declined as a duplicate cannot announce a call that does not exist;
  `createSpaceCallId` was split out of `sendSpaceCallStartMessage` so the
  caller can hold the id across both steps.
- **F2** — start and join failures raise toasts instead of a `logger.debug`
  that is a no-op in production. The header's call buttons show a spinner
  while the join is in flight, since that now blocks for seconds.
- **F3** — the banner is derived from a liveness probe and the clock, not
  from messages alone: `deriveSpaceCallStatus` (pure) +
  `livenessCache` (memo) + `useSpaceCallStatus` (hook) +
  `SFUClient.probeRoomLiveness`. Calls that died without an end message now
  read as ended, **including the ones already in channel history**.

33 unit tests across `__tests__/spaceCallStatus.test.ts` and
`__tests__/spaceCallLivenessCache.test.ts`; full suite 59 suites / 790 tests
green; `tsc --noEmit` unchanged at the pre-existing 11 errors (none in these
files); eslint clean. Every rule was mutation-checked — the implementation
was deliberately broken to confirm the relevant test goes red, because a
suite that cannot fail is worse than none.

Reviewed by an independent agent; all four findings addressed (the
row-recycling flicker, the untested cache, the 404-vs-F5 coupling, and this
section, which the first version of the commit left saying "no code changes
yet").

Still open, and why this file is not in `.done/`:

- **F5 — the server does not serve the call routes.** Nothing in this repo can
  fix it, and until it ships no call of any kind works. Needs the Lead Dev.
- **F4 — end-announcement semantics.** Any participant leaving still announces
  the call's end for everyone. Protocol decision, needs the Lead Dev.
- **The 404 → `gone` mapping** in `probeRoomLiveness` is correct only while F5
  is unshipped; it carries an explicit revisit note at the call site.
- **DM calls are broken by the same missing routes** (`CallContext.tsx:395`
  allocates from `/relay/circuit`). Untouched here, and they leave no stale
  artifact — a DM call announces its END as a `call-event`, so a failure renders
  as a static "failed" row. That asymmetry is exactly why the zombie banner was
  a space-call-only bug.
- **iOS**: the header busy state is Android-only so far, checklist item #13.

## Verification

What a device pass can and cannot show, given the server side is dead:

1. **Start a call in a channel.** Expect: spinner in the header, then a
   "Could not start the call" toast, and **no banner in the channel**. This
   is the reported bug, gone. (Before: a permanent "call in progress"
   banner.)
2. **Look at an existing zombie banner** from before this fix. Expect: "Voice
   call ended" / "Video call ended", static, no timer, no Join button.
3. **Airplane mode, then open a channel with a recent zombie.** Expect: it
   still shows as in progress rather than being declared dead on a guess.
   This is the deliberate asymmetry — unknown is not dead.

A real joinable call cannot be exercised until F5 ships. The media plane
(ICE/DTLS/RTP through TURN) has never been observed working in production
and remains unverifiable from here.

## Open questions

1. For Lead Dev: are `/relay/circuit`, `/sfu/join`, `/sfu/room/:id`
   expected on `api.quorummessenger.com`, or does calling target a
   different deployment that mobile's config should point at?
2. For Lead Dev: intended `space-call-end` semantics (any-leaver vs
   last-leaver) — see F4.
3. Is the space-call feature meant to be mobile-only for now? Desktop has
   no trace of it.

*Last updated: 2026-08-10*
