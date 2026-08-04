---
type: task
title: "Check SPACE/channel message sends for the same latency bugs found in DMs"
status: open
created: 2026-07-24
related:
  - "issues/.open/2026-07-24-dm-send-latency-10s-production.md (the DM investigation; PR #176 shipped the caches)"
  - "issues/.done/2026-07-24-dm-session-confirm-row-mismatch-x3dh-every-send.md (DM session-confirm loop)"
  - "../quorum-desktop/.agents/tasks/transport/README.md"
---

# Audit space sends for the DM latency bugs

The DM send path had three per-send taxes (measured 2026-07-24). Verify whether the space send
path (`services/space/spaceMessageService.ts`, Triple Ratchet) shares them:

1. **SecureStore re-reads per send** — PR #176's in-memory cache in
   `services/onboarding/secureStorage.ts` is global, so any space-path call to
   `getPrivateKey`/`getPublicKey`/`getDeviceKeyset` is already fixed. CHECK: does the space path
   read other SecureStore/MMKV values per send (hub keys, TR state) at comparable cost?
2. **Per-send network fetches** — DMs re-fetched both users' registrations every send. CHECK:
   does the space path fetch anything per send (manifests, member lists, hub info) that could be
   TTL-cached?
3. **Session re-init loops** — DMs re-ran X3DH ×6 devices per send because sessions never
   confirmed. CHECK: does the TR state get reused cleanly across sends, or is there any
   re-derive/re-init per message?

**How to measure:** re-add the send-path instrumentation by reverting commit `6f6e3f0` on a debug
branch, add equivalent timing around the space send (`log-append` path), send channel messages on
a real space, read `[SEND-TIMING]` from logcat (device must reload the JS bundle after checkout).

---
*Last updated: 2026-07-24*
