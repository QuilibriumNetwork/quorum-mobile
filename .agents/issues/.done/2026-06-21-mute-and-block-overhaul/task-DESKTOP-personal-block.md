---
type: task
title: "Task DESKTOP — add personal Block-user to desktop"
created: 2026-06-21
status: done
repos: desktop (consumes shared blockedUsers field from Task D)
risk: shipped
---

# Task DESKTOP — personal Block-user on desktop

## Status

lead greenlit; shipped on desktop in PR #207 (merged to main 2026-06-22)


## ✅ DONE (2026-06-22)

The lead greenlit desktop parity ("Want desktop to get the same personal block
too?" → **yes**), so the feature was built and shipped on desktop:
**`quorum-desktop` PR #207 — "feat: desktop personal block-user"** (squash-merged
to `main`, commit `0013d62e`).

What shipped (matches the sketch below, with decisions resolved):
- New config-backed hook `src/hooks/business/user/useBlockUser.ts`, scoped
  **per space**, reading/writing `UserConfig.blockedUsers[spaceId]` via the
  shared `isUserBlocked` / `getBlockedUsersForSpace` helpers. Optimistic React
  Query update + action-queue persistence (mirrors `useDMMute`), syncs
  cross-device via the UserConfig blob.
- **Render-time** filter in `useChannelMessages.ts` (NOT receive-time) — blocked
  senders' messages are hidden from the rendered list only, fully reversible;
  deliberately kept separate from the moderation `muted_users` receive-time path.
- New `BlockUserModal.tsx` confirm modal (three-fact copy: hides all their
  messages past+new · only for you · only in this space), wired through
  `useModalState` + `ModalProvider`.
- Block/Unblock action in the `UserProfile` card, restyled as a quiet action
  list aligned to the modal color scheme; icons `hand-stop` (block) /
  `hand-off` (unblock).
- Added `hand-off` icon to **quorum-shared** (committed to `master`, `2f65021`)
  since it didn't exist yet.
- Translated all new strings into all 30 locales.
- Also fixed an unrelated crash in `useUserProfileModal` (synthetic event with no
  `currentTarget` when opened from the member list).

Decisions resolved (were open questions below): **per-space** scope (matches
mobile), **render-time** reversible filter, **confirm modal** with one-tap
unblock, Block button color **neutral/secondary** (not danger — softer than the
moderation Mute/Kick).

---

## Historical context (the original gap doc — kept for record)

This started as a **task file only** (no code), per the atlas rule
("don't decide for the lead" — cross-platform gaps are the lead's call). The gap
and the lead-question draft below are preserved as the record of how it got here;
the question was asked and answered (yes), and the work shipped (above).

---

## The gap

Mobile has a **personal Block** (viewer-side hide: hide a user's messages from YOUR
own stream — `hooks/chat/useUserMuting.ts`, soon `useBlockUser` per Task D).
**Desktop has NO equivalent.** Desktop's only per-user feature is **moderation
mute** (`useUserMuting` — role-gated, broadcasts, silences for everyone). It has
no personal block: an explore over desktop `src/` found zero `blockUser /
blockedUsers / ignoreUser / hideUser` of any kind
(`quorum-desktop/.agents/docs/features/mute-user-system.md` confirms: "no personal
ignore list, no `blockedUsers` field on `UserConfig`").

So: a user can personally hide someone on mobile but not on desktop, and the choice
wouldn't sync. Task D adds `UserConfig.blockedUsers` to shared (additive) — once
that lands, desktop CAN consume the same synced field to offer the same feature.

## Original implementation sketch (now shipped — see DONE section above)
- Consume `UserConfig.blockedUsers` (added by Task D in shared).
- Filter blocked users' messages from the local rendered stream (desktop already
  has `isUserMuted`-style filtering at receive in `MessageService.addMessage` —
  a viewer-side block is a SEPARATE, permission-less, local-only filter; do not
  conflate with the moderation `muted_users` path).
- Add a "Block"/"Unblock" action to the desktop `UserProfile` card, distinct from
  the existing moderation "Mute" button.
- Same per-space-vs-global scope decision as Task D.

## Message that was sent to the lead (Telegram, short — atlas §4) — ANSWERED: yes
> Heads up: mobile has a personal "block user" (hide someone's messages from your
> own feed) that desktop doesn't. I'm making mobile's version sync via a new
> `blockedUsers` field on the shared UserConfig. Want desktop to get the same
> personal block too (so it syncs both ways), or keep it mobile-only for now?

Lead's answer: **yes** — desktop gets the same personal block, syncing both ways.
Shipped per the DONE section above.

## Related
- Mobile side: `task-D-personal-block-user.md`
- Desktop moderation mute (the thing it's NOT): 
  `quorum-desktop/.agents/docs/features/mute-user-system.md`
- Atlas §4 (talking to the lead): `../quorum-atlas.md`

*Last updated: 2026-06-22*
