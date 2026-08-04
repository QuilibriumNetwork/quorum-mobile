---
type: task
title: "RESUME HERE — space-manifest sync fix (Android timestamp overflow)"
status: done
created: 2026-06-12
updated: 2026-06-13
branch: fix/space-manifest-sync-to-mobile (merged, deleted)
---

# ✅ THIS FIX IS DONE — merged as PR #79 (1f5a5f5), runtime-verified 2026-06-13.

## NEXT SESSION: mobile -> desktop channel edits don't sync

The user wants to tackle this next. It's the REVERSE direction of the bug above, and it's a SEPARATE, already-investigated issue:
- **Symptom:** rename/delete a channel (or rename the space, reorder, etc.) ON mobile -> doesn't reach desktop (even after desktop refresh).
- **Root cause:** `hooks/chat/useChannelManagement.ts` mutations save locally only — never call `broadcastSpaceUpdate` + `enqueueOutbound` (unlike `useSpaceSettings.ts` / `useRoleManagement.ts` which DO). So the server manifest is never updated; desktop re-fetches the old one. 9 affected mutations (channel add/rename/delete/move/reorder, group add/update/delete/reorder).
- **GOOD NEWS — the fix already exists:** branch `fix/channel-reorder-broadcast`, **OPEN PR #73** ("fix(channels): broadcast space updates from channel/group mutations"), task doc `.agents/issues/.done/2026-05-29-channel-reorder-mutations-should-broadcast.md` (status: ready-for-review). It adds the broadcast pattern to all 9 mutations; was runtime-verified to reach desktop.
- **So next session is likely: review PR #73, rebuild/test it on device (now that build-app.ps1 + the device are set up), and merge** — rather than writing new code. Confirm it still applies cleanly on current master (which now has PR #79 + #76 + #77).
- Note: space RENAME on mobile DOES broadcast already (via useSpaceSettings), so if that also failed to reach desktop in testing it may just have been timing — re-check after PR #73.

---

# (Original resume note — the now-DONE space-manifest fix) — RESUME HERE — space-manifest sync fix

Paused 2026-06-12 (long session, mostly build-environment friction). The **code fix is done and correct**; only the final **rebuild-onto-phone + runtime confirmation** remains.

## The bug (fully diagnosed + confirmed)

Desktop space changes (rename, channel edits, read-only toggles) never synced to Android. Root cause: **Android `QuorumCryptoModule.kt` read message timestamps with `optInt` (32-bit)**; ms-epoch timestamps (~1.7e12) overflowed to negative, so the JS batch path (`WebSocketContext.tsx` ~line 3026, `batch.find(m => m.timestamp === msgResult.timestamp)`) never matched control messages back to their source and **dropped them all** (space-manifest, pin, mute, thread). iOS (64-bit Int) + desktop (JS number) were already correct → Android-only bug. Full detail: [bug doc](2026-06-12-space-manifest-changes-not-syncing-to-mobile-silent-failure.md).

The runtime log proved it: hundreds of `[batch-control] dropped: no original batch message for ts=-1134049747` (NEGATIVE timestamp = the overflow).

## What's DONE (committed on branch `fix/space-manifest-sync-to-mobile`)

- `e833eb5` — instrumentation of all silent space-manifest/batch-control drop points + secondary cache-invalidation fix (channels.bySpace + spaces.all on manifest save).
- `a33857f` — the real fix: `optInt` -> `optLong` at `QuorumCryptoModule.kt:883` + `:1149` (the `modules/` source-of-truth copy).
- **NOT committed but applied to working tree:** the same fix mirrored into `node_modules/quorum-crypto/` (the copy the build actually compiles — see [[file-dep-native-module-build-uses-node-modules-copy]]). This is needed for the build to pick it up but is a node_modules edit (re-applied after any yarn install).
- `.agents/scripts/build-app.ps1` (gitignored, local) — now sets `java.io.tmpdir=<local temp>/` (accented-username fix) AND `ORG_GRADLE_PROJECT_sideBySide=true` (so the dev build installs as `.debug` alongside the real app).

## What REMAINS (to finish)

1. **Rebuild + install** via `.\.agents\scripts\build-app.ps1`. With the sideBySide flag it should produce `com.quilibrium.quorummobile.debug` and install ALONGSIDE the real app.
   - ⚠️ **NEVER uninstall `com.quilibrium.quorummobile`** (real app, real data — see [[never-uninstall-real-app-data-loss]]). Only `.debug` is disposable.
   - Caveat: the sideBySide=true via env var is ~95% confirmed, not 100% proven. After build, verify the APK package name is `...quorummobile.debug` (`aapt dump badging .../app-debug.apk | grep package`) BEFORE trusting the install.
2. **Runtime verify:** change a space on desktop -> confirm it now appears on mobile AND the `[batch-control] dropped: ... ts=-...` spam is GONE (timestamps now match). Expect `[space-manifest] applied + saved for space=...`.
3. **If verified:** decide whether to keep the instrumentation `logger.warn`s or downgrade them to debug-level before the PR (they're noisy). Then PR + squash-merge (optLong fix + cache invalidation; instrumentation optional). Mobile-only.

## Key process lessons saved to memory this session
- [[verify-statically-before-expensive-rebuilds]] — never rebuild speculatively; verify the change is in the compiled file first.
- [[file-dep-native-module-build-uses-node-modules-copy]] — native edits must land in `node_modules/quorum-crypto/` too.
- [[nitromodules-runtime-not-ready-needs-native-rebuild]] — accented-username build bug + the build-app.ps1 button.
- [[never-uninstall-real-app-data-loss]] — never touch the real app package.

*Last updated: 2026-06-12*
