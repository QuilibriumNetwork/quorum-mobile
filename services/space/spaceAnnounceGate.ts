// Per-space send gate for the `update-profile` announce — the DECISION half,
// kept free of MMKV so it is directly unit-testable. The persistence shim lives
// in spaceMessageService.
//
// UNTIL 2026-08-02 the rule here was dedup ONLY: `if (last === sig) return null`,
// with no timestamp field, no expiry and no retry. A mobile member announced a
// given identity to a given space exactly ONCE, ever, across app launches and
// reinstalls of the JS bundle. Consequences:
//
// - a member who joined the space LATER never received it — it was broadcast
//   before they were listening and would never be sent again;
// - hub-log replay does NOT rescue them. Mobile's own source says so twice,
//   verbatim: "new joiners only see messages sent after they joined"
//   (context/WebSocketContext.tsx:1297-1303 and :6182-6185);
// - the one escape hatch the code claims to have, `clearProfileBroadcastState`,
//   is documented as running on leave-space/sign-out but is **never called from
//   anywhere** in the repo. Verified 2026-08-01.
//
// The only thing that ever reopened the gate was `MIGRATIONS_KEY` — a hardcoded
// one-off tag that wipes every stored signature, requiring a new app release.
// That mechanism existing at all is the clearest evidence the gap was already
// being felt.
//
// So the gate now EXPIRES, a bounded number of times: an unchanged identity is
// re-announced at most once per ANNOUNCE_INTERVAL_MS, at most
// MAX_ANNOUNCES_PER_IDENTITY times, per space.
//
// ⚠️ WHAT THIS DOES NOT FIX. Three attempts over ~2 days widens the window in
// which a new joiner can hear you; it does not make you discoverable
// indefinitely. A member who joins next month still learns nothing until you
// next change your profile. That gap is architectural — see "What would
// actually close the gap" in
// quorum-desktop/.agents/docs/features/identity-resolution-and-profile-sync.md,
// including why the obvious "everyone announces when someone joins" is
// quadratic in traffic and must not be built.
//
// Cost per attempt: an announce is ONE broadcast, but the relay fans it out to
// every member, so it costs `members × payload` — and the payload is dominated
// by a base64 avatar. That is what the cap is protecting.

import { createProfileAnnounceGate } from '../identity/profileAnnounceGate';

/** Minimum gap between two announces of the SAME identity to the same space. */
export const ANNOUNCE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * How many times an UNCHANGED identity is ever announced to one space.
 *
 * Deliberately the same number as the DM gate and as desktop, so there is one
 * rule to reason about across four call sites rather than four.
 */
export const MAX_ANNOUNCES_PER_IDENTITY = 3;

const gate = createProfileAnnounceGate({
  intervalMs: ANNOUNCE_INTERVAL_MS,
  maxSends: MAX_ANNOUNCES_PER_IDENTITY,
});

export const readAnnounceRecord = gate.readGateRecord;
export const shouldAnnounce = gate.shouldSend;
export const nextAnnounceAttempts = gate.nextAttempts;
export type { ProfileGateRecord as SpaceAnnounceRecord } from '../identity/profileAnnounceGate';
