---
type: task
title: "Add ghost-session prune to DM sends using a registration-sourced device list"
status: open
created: 2026-07-24
related:
  - "issues/.done/2026-07-24-dm-session-confirm-row-mismatch-x3dh-every-send.md (FIXED parent)"
---

# Ghost-session prune (desktop parity), done safely

Desktop prunes DM session rows whose tag matches no registered device inbox on every send
(MessageService.ts ~L3081). Mobile's PR #177 deliberately shipped WITHOUT this prune: the code
review found that `sendEncryptedMessageToAllDevices` callers pass device lists of varying
completeness (some only the recipient's devices), and pruning against a partial list would
delete healthy own-device sync sessions. A first implementation also operated on a stale
in-memory snapshot (deleted rows could still be selected for sending in the same call).

**Requirements for the safe version:**
1. Build the valid-inbox set from FRESH-ish registrations of BOTH users (the TTL-cached
   `fetchUserRegistration` makes this cheap), never from the caller-provided device list.
2. After pruning, rebuild (or filter) the in-memory `existingStates` array before session
   selection.
3. Keep tagless rows exempt (receiver-side/legacy rows).
4. Skip entirely when either registration fetch fails.

**Why it matters:** legacy rows tagged with conversation-inbox addresses (pre-#177 peers) and
rows for deregistered devices accumulate forever without it; they cost storage scans and one
init-envelope per send each.

---
*Last updated: 2026-07-24*
