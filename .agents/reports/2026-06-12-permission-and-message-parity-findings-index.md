---
type: report
title: "Session findings index — mobile permission + message-handling parity (cross-repo)"
status: living
created: 2026-06-12
spans-repos: [quorum-shared, quorum-desktop, quorum-mobile]
purpose: "Single source of truth for everything uncovered during the 2026-06-12 permission-enforcement investigation. Read this first to understand the whole picture before diving into any individual bug/task."
---

# Session findings index — permission & message-handling parity

> **Why this doc exists.** A second-pass verification of the mobile permission-enforcement task (`2026-06-12-permission-enforcement-wave-0.md`) uncovered a cluster of related findings spanning all three repos. They are too many to hold in one's head, and they will need to be justified to the lead dev (who owns mobile). This index is the map: what we found, how confident we are, where it's logged, what's fixed, what's pending, and the rationale for each. **Every item links to its detailed doc.**

## Repo-ownership context (why care is needed)

- **quorum-mobile** — primarily the **lead dev's** repo; we have the least experience here. Fixes must be conservative, well-justified, and mirror established desktop patterns. We ARE fixing bugs here now, but every change must be defensible.
- **quorum-desktop** — primarily **our** repo; we have the most experience. Safe to file bugs and reason about intent.
- **quorum-shared** — least complex, **shared** ownership; we're reasonably confident. Changes here ripple to both apps + need a publish, so coordinate.

## The one root cause behind most of this

Clients **cannot verify who the space owner is** (no `ownerAddress` on the wire — privacy requirement, desktop bug #111 / `space-owner-privacy-limitation.md`). Consequences:
1. The only owner-only action that works network-wide is **kick** (ED448-signed, verifiable). Everything else (pin/delete/mute/@everyone/read-only-post) needs a **verifiable role**, enforced **on receipt**.
2. Real enforcement therefore lives on the **receive side**, not the send-side button. The original task assumed "route mobile through shared `hasPermission` = enforcement" — that's wrong; it gates the button, not the wire.
3. Shared `hasPermission` has a buggy **owner-bypass** (`if (isSpaceOwner) return true`) that contradicts the design and shared's own `channelPermissions.ts`.

## Status board

Legend: ✅ fixed & committed · 🟢 ready to implement (scoped) · 📄 documented, deferred · 🔬 needs more investigation

| # | Finding | Severity | Repo(s) | Status | Detail doc |
|---|---|---|---|---|---|
| 1 | **Mobile applies ANY incoming delete with no permission check** — any client can delete anyone's messages on all mobile peers | HIGH (real, propagating) | mobile | ✅ **committed `54c9919`** | this index §1 |
| 2 | **@everyone owner-bypass** — owner-with-no-role spams @everyone; send-side-only enforcement → propagates on desktop | MED (live on desktop) | shared + desktop | 📄 documented | [desktop bug](../../../quorum-desktop/.agents/issues/.done/2026-06-12-everyone-mention-owner-bypass-send-side-only.md) |
| 3 | **Shared `hasPermission` owner-bypass** — root cause of #2 + mobile owner pin/delete button illusion | MED (correctness) | shared (+ desktop/mobile consumers) | 📄 documented, plan written | [cross-repo plan](../issues/.done/2026-06-12-owner-permission-bypass-cross-repo-fix.md) |
| 4 | **Read-only channels unenforced on mobile** — no composer lock (send) AND no receive-side validation (post/embed/sticker propagate) | MED-HIGH | mobile | 🟢 implementing now | this index §4 + Wave 0 task 0.4 |
| 4b | **Desktop read-only receive-side gaps** — sticker/embed bypass the check; post-block is cache-only (resurrects from disk) | MED | desktop | 📄 documented | [desktop bug](../../../quorum-desktop/.agents/issues/.done/2026-06-12-readonly-channel-receive-side-enforcement-gaps.md) |
| 5 | **Mobile mishandles pin/mute/thread on receipt** — saved as JUNK timeline bubbles | MED (user-visible junk) | mobile | ✅ **junk-bubble fixed `2212339`** (drop); pin-sync/mute-sync deferred as features | [mobile bug](../issues/.done/2026-06-12-mobile-saves-pin-mute-thread-control-msgs-as-junk-bubbles.md) |
| 6 | **Cross-platform mute gap** — mobile never receives/applies desktop's broadcast mutes (mobile's own mute is a personal local hide, correctly ungated) | LOW-MED (feature-port) | mobile | 📄 documented | Wave 0 task (dropped-0.3 section) |
| 7 | **Image+caption wire divergence** — desktop `post`+`embeddedMedia`+text vs mobile `embed`+informal `text` cast (not in shared type) | LOW (correctness) | shared + both | 📄 already noted | candidates.md "Image + caption" |

## What's actually FIXED so far

### §1 — Mobile receive-side delete validation ✅ committed `54c9919`
- **What:** both `remove-message` receive handlers (live `WebSocketContext.tsx` ~1818, batch ~3048) now validate the sender's permission before applying a delete, via shared `createChannelPermissionChecker({ userAddress: senderId, isSpaceOwner: false, ... }).canDeleteMessage(target)`.
- **Rule:** honor if own-message OR read-only-manager OR sender has a `message:delete` role; else drop (+ clear inbox). No owner bypass (receivers can't verify ownership).
- **Why safe:** self-deletes never reach these handlers (filtered upstream as self-echoes; local removal is optimistic), so legitimate own-deletes are unaffected.
- **Grounding:** mirrors desktop `MessageService.ts` remove-message receive validation exactly.

### §4 — Read-only channel enforcement 🟢 (implementing this session)
- **Send-side:** compute `canManageReadOnlyChannel(user.address, false, space, currentChannel)` in `[channelId].tsx`, pass `disabled={!canPost}` to `MessageInput` + a lock banner. Stops the honest client initiating.
- **Receive-side (the real enforcement):** in both live + batch paths, before the generic save, drop incoming `post`/`embed`/`sticker` to a read-only channel from a non-manager. **Built SOLID — covers all 3 postable types (not desktop's post-only gap) and is durable (drops before storage.saveMessage, so it can't resurrect from disk like desktop's cache-only block).**
- **Grounding:** desktop enforces the same rule (with the gaps noted in #4b, which we're a) NOT replicating and b) filing as a desktop bug).

## What needs to be DONE (logged, not forgotten)

### §5 — Mobile mishandles pin/mute/thread on receipt 📄
- **Problem:** desktop sends `pin`, `mute`, `thread` control messages. Mobile's `WebSocketContext` has NO handler for them → they fall through to the generic `storage.saveMessage()` → **saved as junk message bubbles in the channel**, and the intended action (pin a message / apply a mute / update thread metadata) **never happens**.
- **Severity:** user-visible (garbage bubbles when a desktop user pins/mutes/threads), but not data-loss or access-control. Medium.
- **Desktop reference:** `pin` → `MessageService.ts:1172`; `mute` → ~1830; `thread` → `threadService.handleThreadReceive()` ~1251.
- **Note:** ties to #6 (mute) — applying received mutes is part of the same gap. Thread is a bigger feature-port (mobile has no threads at all — see candidates.md row 3).
- **Action:** dedicated bug doc to be written this session (see todo).

### §7 — Image+caption wire divergence 📄 (already in candidates.md)
- desktop image+caption = `type:'post'` + `embeddedMedia[]` + `text`; mobile = `type:'embed'` + informal `text?` (not in shared `EmbedMessage`). Cross-platform: caption may not survive. Logged in `quorum-desktop/.agents/tasks/port-to-mobile/candidates.md` ("Image + caption — NO PORT NEEDED (verified)" — but the divergence note understates that the caption can be lost cross-platform; revisit when touching embeds).

## Deferred cross-repo work (needs coordination + a shared publish)

The **shared owner-bypass cleanup (#2 + #3)** is the one piece that crosses into shared+desktop and needs a `quorum-shared` publish. Full 4-phase plan with version mechanics + 4 open decisions: [2026-06-12-owner-permission-bypass-cross-repo-fix.md](../issues/.done/2026-06-12-owner-permission-bypass-cross-repo-fix.md). NOT on fire — owner pin/delete is a harmless local illusion; @everyone is annoyance-grade. Tackle deliberately when ready to coordinate a release.

## How to justify all this to the lead dev (the through-line)

Every fix here follows ONE consistent principle, already proven in desktop's own code: **permission enforcement for space content lives on the RECEIVE side, because no client can verify ownership.** Desktop does this for delete, pin, mute, and (partially) read-only. Mobile was missing the receive-side checks entirely, so it trusted any signed control/content message. We are bringing mobile to parity with desktop's receive-side validation, reusing the SAME shared helpers desktop uses (`createChannelPermissionChecker`, `canManageReadOnlyChannel`) so the rules can't drift. Where desktop itself has gaps (read-only sticker/embed bypass), we filed desktop bugs and built mobile WITHOUT those gaps.

---

*Last updated: 2026-06-12*
