---
type: task
title: "Task B — Channel-mute UX: per-row dim + bell-off marker"
created: 2026-06-21
status: done
build-order: 3 (pairs with Task A — same surface)
repos: mobile only
risk: low (pure UI)
---

# Task B — Channel/Space mute per-row visual treatment

**Goal:** muted channels should LOOK muted in the channel list — dimmed + a
bell-off marker — matching desktop. Currently mobile's channel mute is invisible in
the UI (you only know via the settings sheet). This is the one channel-mute UX
refinement the user explicitly picked.

Scoped narrow on purpose. Other desktop UX (context-menu mute access, "hide muted
channels" toggle) was NOT selected — see "Out of scope" below.

---

## Desktop reference
`quorum-desktop/.agents/docs/features/channel-space-mute-system.md` §Visual
Treatment: muted channels render at **50% opacity** (`.channel-item-muted`); a
"hide muted channels" toggle can remove them entirely (NOT in our scope).

---

## What to build
- [ ] In the mobile channel-list row component (find it — likely under
      `components/Space/` or wherever channels render in the space screen), read
      muted state for each channel from the **Task A** `UserConfig`-backed source
      (`getLocalMutedChannels(spaceId)` / the shared store). **Depends on Task A**
      so the state is the synced source of truth — do B after A, or at least read
      from the same helper A introduces.
- [ ] Dim muted channel rows (~50% opacity, match desktop; use a token, not an
      arbitrary value — see global frontend rules).
- [ ] Add a small **bell-off** marker on muted rows (icon set already used
      elsewhere — DM mute uses a bell-off badge; reuse that asset for consistency).
- [ ] Space-level mute: when the whole space is muted, reflect it on the space
      entry too (dim / bell-off on the space row or header), consistent with
      desktop's "space mute implies all channels."

## Reactivity
- [ ] Row visual must update INSTANTLY on toggle (no remount). If Task A exposes a
      `useSyncExternalStore`-backed mute source, depend on it. Same lesson as
      `useDMMute` (per-hook `useState` copies don't propagate).

## Out of scope (NOT selected by user — note for later)
- **Context-menu / long-press mute access** on channel rows. Desktop has this;
  user did not pick it. Easy follow-up if wanted.
- **"Hide muted channels" toggle** (`showMutedChannels`). Desktop has it; not
  selected. If added later, it lives near this surface + a `UserConfig` bool.

## Verification
- [ ] Lint clean; uses standard Tailwind/token values (no `opacity-[..]` arbitrary).
- [ ] Runtime (Android): muting a channel dims it + shows bell-off immediately;
      unmuting restores; reflects a mute synced FROM another device (ties to A).
- [ ] iOS review: opacity + icon render; no layout shift from the marker.

## Related
- Depends on: `task-A-channel-mute-sync.md` (shared mute source).
- Pattern: DM-mute bell-off badge (see `dm-mute-behavior-and-pattern.md` §2).
- Frontend rules: standard tokens over arbitrary values; no opacity on TEXT (this
  is row/icon opacity, which is fine).

*Last updated: 2026-06-21*
