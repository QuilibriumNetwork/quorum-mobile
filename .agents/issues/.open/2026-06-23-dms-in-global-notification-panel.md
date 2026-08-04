---
type: task
title: "Add DMs to the global in-app Notifications panel"
status: open
created: 2026-06-23
urgency: low
shared_change: none (in-app only)
version_bump: none
runtime_test: required
related_docs:
  - .agents/docs/2026-06-23-notification-system-mobile-vs-desktop.md
  - .agents/issues/.done/2026-06-23-quorum-mentions-replies-inbox.md
---

# Add DMs to the global Notifications panel

## Idea / rationale

The mobile Notifications tab is a GLOBAL inbox (mentions/replies from spaces +
Farcaster). New Quorum DMs currently do NOT appear there — they only show on the
native lock-screen push + the Messages tab (unread dot + preview). The user, as a
user, would expect the global Notifications panel to surface EVERYTHING new,
including DMs.

Why "desktop doesn't show DMs in a panel" is NOT a blocker: desktop's panel is
PER-SPACE (anchored to a channel-header bell), the less-evolved model. Mobile's
global panel is already the better pattern (docs say so), and desktop will likely
converge to it later. So adding DMs here is a reasonable divergence, not a
mistake. (Counter-point, minor: DMs already have a dedicated Messages tab, so this
is some duplicate signal — accepted as a deliberate "one inbox for everything"
choice.)

## Where DMs are received (the hook point)

DMs are decrypted in `context/WebSocketContext.tsx` on the `decryptedMessage`
path (~line 2681 live, ~line 3695 catch-up) — SEPARATE from the space-message
path that `logMentionOrReply` hooks into. A new DM updates the conversation row
(`lastMessagePreview`, timestamp) but logs NOTHING to the notifications inbox.

## Rough scope (in-app only, no native/shared changes)
1. New entry kind in the inbox log: extend `MentionReplyEntry` (or a parallel
   log) with a `dm` kind carrying { conversationId, senderId, senderDisplayName?,
   preview, createdAt }. Reuse the typed `messagePreview`.
2. Write it from the DM receive path(s) in `WebSocketContext.tsx`, gated by DM
   mute (`isConversationMutedForCurrentUser`) — consistent with the existing
   muted-DM exclusion in `useUnifiedNotifications`.
3. Surface in `useUnifiedNotifications` + the Notifications screen:
   - Either a third section "Direct messages", OR fold DMs into the Quorum
     section. Decide during design (likely its own section + a `DM` source so the
     filter pills become All / Quorum / DMs / Farcaster — but watch small-screen
     pill width at 320px; may need to drop the 4th pill or shorten labels).
   - Row: sender name (when resolved) + preview + time; tap → deep-link to the DM
     (`/(tabs)/messages/dm/<conversationId>`), infra already in `handlePress`.
4. Read-state: DMs already track read via the conversation `lastReadTimestamp`.
   Decide whether the panel's DM rows clear on opening the DM (preferred — reuse
   that) vs the two-level model used for space mentions. Keep it consistent.
5. "Clear all" already wipes the local logs — make sure it covers the DM log too.

## Decisions to make during design
- One "Direct messages" section vs folding into Quorum.
- 4th filter pill vs not (small-screen constraint).
- Whether DM rows respect the same two-level read-state or the conversation's own
  lastReadTimestamp (latter is simpler + already exists).

## Verify
- Receive a DM (app open + app killed→reopen backfill) → row appears in the panel
  with sender + preview; tap deep-links to the DM.
- Muted DM → no row (matches the existing muted-DM exclusion).
- Reading the DM clears its unread state in the panel.
- "Clear all" removes DM rows too.

*Last updated: 2026-06-23*
