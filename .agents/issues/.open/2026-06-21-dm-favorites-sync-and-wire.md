---
type: task
title: "DM favorites — sync across devices (UserConfig.favoriteDMs) + wire into the UI"
status: open
created: 2026-06-21
source: spun out of #35 work — noticed while building DM mute
priority: low-medium
effort: small (mirrors the mute work)
---

# DM favorites: sync + wire

## Why this exists

While building DM mute, we found `hooks/chat/useDMFavorites.ts` exists but:
1. Stores favorites in a **device-local MMKV** store (`dm-favorites`) — does NOT
   sync across devices. Desktop stores favorites in `UserConfig.favoriteDMs`
   (already on the shared `UserConfig` type), which syncs.
2. Is **not wired into the live UI**. The only consumer,
   `components/Chat/DirectMessagesList.tsx`, is **dead code** (not imported or
   rendered anywhere). The real messages screen is
   `app/(tabs)/messages/index.tsx`.

Desktop exposes "Add to Favorites" in the conversation-list **context menu**
(not the settings modal), and favorited DMs sort to the top.

## Not part of #35

#35 is the conversation-settings sheet (mute, repudiable, edit-history, delete).
Favorites is a context-menu action on desktop, a separate surface. Captured here
so it isn't lost.

## What to do (mirror the mute work)

1. **Migrate `useDMFavorites` to config-backed** (`UserConfig.favoriteDMs`),
   following the same **bookmark pattern** used for mute: store in config, read
   straight back from the local MMKV config (NOT via the `user` object), sync
   outbound via `saveConfig` when `allowSync` is on, with a one-time migration of
   the legacy `dm-favorites` store. Use a module-level shared store +
   `useSyncExternalStore` so all consumers update live (the same fix mute needed
   — see `hooks/chat/useDMMute.ts` as the reference implementation).
2. **Preserve `favoriteDMs` on inbound `getConfig`** (add to the explicit
   preservation list in `services/config/configService.ts`, next to
   `mutedConversations`) so sync can't silently drop it.
3. **Wire the UI** in `app/(tabs)/messages/index.tsx`: favorited DMs sort to the
   top; expose an "Add to / Remove from Favorites" action. Where to put the
   action depends on the long-press decision — if we later adopt the desktop-style
   context menu (the "V2" option discussed for #35's long-press), favorites is a
   natural item there. For now it has no home in the full-settings-sheet UI we
   shipped, so this likely waits for that context menu.
4. Consider a favorite indicator on the row (desktop uses a distinct avatar
   border, `dm-favorite-avatar`).

## Dependency / sequencing note

The natural home for the favorites action is the desktop-style compact context
menu (Favorites / Mute / Settings / Delete) that was deferred to a possible #35
"V2". If that menu is built, do favorites with it. The config-backed migration
(steps 1-2) is independent and can land anytime.

## Files

- `hooks/chat/useDMFavorites.ts` — config-backed rewrite (mirror `useDMMute.ts`)
- `services/config/configService.ts` — preserve `favoriteDMs` on `getConfig`;
  add `getLocalFavoriteDMs` / `setFavoriteDMs` helpers
- `app/(tabs)/messages/index.tsx` — sort + action + indicator
- `components/Chat/DirectMessagesList.tsx` — dead code; either delete or revive
  intentionally (don't leave it as a divergent parallel implementation)

*Last updated: 2026-06-21*
