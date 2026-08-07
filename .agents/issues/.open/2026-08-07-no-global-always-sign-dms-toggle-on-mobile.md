---
type: task
title: "Add the global \"Always sign Direct Messages\" toggle to mobile settings"
status: open
complexity: low
priority: medium
ai_generated: true
created: 2026-08-07
updated: 2026-08-07
pairs-with: "2026-06-25-port-message-signing-controls.md (shipped the per-conversation/per-space controls; never surfaced the account-level default)"
---

# Add the global "Always sign Direct Messages" toggle to mobile settings

> **⚠️ AI-Generated**: May contain errors. Verify before use.
> Every claim below is READ from the code at the cited `file:line` on 2026-08-07.
> Nothing here was observed at runtime.

**Files**:
- `hooks/useUserConfig.ts:141-150` (add setter, mirroring `updateDeliveryReceipts`)
- `hooks/useUserConfig.ts:182-195` (add a `useSigningSettings()` hook next to `useSyncSettings`)
- `hooks/chat/useDMConversationSettings.ts:72` (module-level cache — see the trap below)
- `components/ProfileModal.tsx:4360-4400` (`PrivacySettingsSection`, "Privacy & Sync")

## What & Why

`UserConfig.nonRepudiable` is the account-level "always sign my DMs" default.
Mobile **reads** it but has **no UI to set it**, so a mobile-only user is
permanently signing every DM by default and cannot change that globally. Desktop
exposes it as a first-class row in Settings → Privacy
([Privacy.tsx:102](../../../../quorum-desktop/src/components/modals/UserSettingsModal/Privacy.tsx#L102)).

This matters more than a normal parity gap because of what the setting *is*.
Signing makes a message provable to a third party who was not in the
conversation: the recipient can show it to anyone and it verifies. Turning it off
is how a user gets deniability. A mobile-only user currently has no way to obtain
that, and the only workaround is to set it on desktop and sync it across, which
requires enabling `allowSync` — the exact feature a deniability-seeking user is
most likely to want off.

Desired state: one switch in Settings → Privacy & Sync, labelled to match
desktop, writing `UserConfig.nonRepudiable`.

## Current state (verified 2026-08-07)

**The machinery is already fully wired. Only the setter and the UI row are missing.**

This is the opposite of the situation in
[2026-06-25-port-message-signing-controls.md](../.done/2026-06-25-port-message-signing-controls.md),
which correctly refused to surface a toggle before the send path honoured it.
Here the send path already does:

| Layer | Status | Reference |
|---|---|---|
| Field exists in shared `UserConfig` | ✅ | `@quilibrium/quorum-shared` `src/types/user.ts:71` |
| Written into a fresh config as `true` | ✅ | `services/config/configService.ts:214` |
| Loaded into a module cache on login | ✅ | `hooks/chat/useDMConversationSettings.ts:94` |
| Consumed as the per-conversation default | ✅ | `app/(tabs)/messages/dm/[id].tsx:269` — `readSetting('isRepudiable') ?? !globalNonRepudiable` |
| Threaded to the send gate | ✅ | `hooks/chat/useSendDirectMessage.ts:298` — `effectiveSkip = isRepudiable ? !!skipSigning : false` |
| **Setter on the config** | ❌ **missing** | no `updateNonRepudiable` in `hooks/useUserConfig.ts` |
| **UI row** | ❌ **missing** | not in `PrivacySettingsSection`, `components/ProfileModal.tsx:4360` |

Defaults already match desktop exactly: `nonRepudiable: true` in both
`getDefaultUserConfig`s, and `?? true` at both read sites. **This task does not
change any default** — it only makes an existing default changeable.

## The trap: the global is a module-level cache, refreshed once per address

`globalNonRepudiable` is a module-level `let`
([useDMConversationSettings.ts:72](../../../hooks/chat/useDMConversationSettings.ts#L72))
assigned only inside `ensureLoaded`
([:94](../../../hooks/chat/useDMConversationSettings.ts#L94)), which early-returns
when `loadedForAddress === address`. It is deliberately cached rather than read
per render, because `getLocalUserConfig` parses the whole config blob.

**Consequence: writing `nonRepudiable` to the config is not enough.** Without an
explicit cache refresh, the new value will not take effect until restart or
re-login, and the toggle will look like it works (the switch moves, the config
persists) while every DM keeps signing. That is a silent failure in a
security-relevant setting, which is the worst shape this bug could take.

The module already has the machinery to do this correctly: `emit()`
([:76](../../../hooks/chat/useDMConversationSettings.ts#L76)) notifies all
`useSyncExternalStore` subscribers, and `resetForLogout`
([:109](../../../hooks/chat/useDMConversationSettings.ts#L109)) is an existing
example of mutating the var and emitting.

## Implementation

1. **Export a cache setter** (`hooks/chat/useDMConversationSettings.ts`, near `resetForLogout`)
   ```ts
   /** Update the cached global signing preference and notify subscribers.
    *  Called by the settings toggle; without this the module cache would keep
    *  serving the pre-toggle value until the next login. */
   export function setGlobalNonRepudiable(value: boolean): void {
     if (globalNonRepudiable === value) return;
     globalNonRepudiable = value;
     emit();
   }
   ```

2. **Add the config setter** (`hooks/useUserConfig.ts`, after `updateReadReceipts` at `:131-140`)
   - Copy `updateDeliveryReceipts` verbatim, swapping the field:
     ```ts
     const updateNonRepudiable = useCallback(
       async (enabled: boolean) => {
         if (!user?.address) return;
         const updated = await updateConfig(user.address, { nonRepudiable: enabled });
         setConfig(updated);
         setGlobalNonRepudiable(enabled); // keep the DM-settings cache in step
       },
       [user?.address]
     );
     ```
   - Add `updateNonRepudiable` to the hook's return object (`:141-150`).

3. **Add a `useSigningSettings()` hook** (`hooks/useUserConfig.ts`, next to `useSyncSettings` at `:182`)
   - Follow `useReceiptSettings` (`:156-169`) exactly:
     ```ts
     export function useSigningSettings() {
       const { config, isLoading, updateNonRepudiable } = useUserConfig();
       return {
         nonRepudiable: config?.nonRepudiable ?? true, // default ON, matches desktop
         isLoading,
         setNonRepudiable: updateNonRepudiable,
       };
     }
     ```

4. **Add the UI row** (`components/ProfileModal.tsx`)
   - Consume `useSigningSettings()` alongside `useSyncSettings()` at `:340`, and
     pass `nonRepudiable` / `onToggleNonRepudiable` / `signingDisabled` into
     `PrivacySettingsSection` at `:2357`.
   - Add a `settingRow` inside the "Privacy & Sync" section (`:4362`), following
     the "Public Profile" row at `:4364-4378` for structure.
   - **Label: "Always sign Direct Messages"** — desktop's exact string
     ([Privacy.tsx:105](../../../../quorum-desktop/src/components/modals/UserSettingsModal/Privacy.tsx#L105)).
     The 2026-06-25 task established that these labels are matched verbatim
     across clients, not paraphrased.
   - Description, adapted from desktop's tooltip to mobile's sentence style:
     "When you sign a message, you confirm it came from your key. When you don't,
     you have plausible deniability. You can also set this per conversation."
   - Icon: use the existing lock glyph already used by the composer signing
     control, so the two surfaces read as the same feature.

**Placement note.** Put it directly under "Public Profile" and above "Enable
Sync". It belongs with the identity-disclosure settings, not with the receipts
group, and the ordering then matches desktop's Privacy tab.

## Verification

✅ **The toggle takes effect without a restart** (this is the whole point of step 1)
   - Open a DM with no per-conversation override. Turn the global setting OFF in
     Settings. Return to the DM **without restarting the app**.
   - Expected: the composer's per-message signing control becomes available
     (`signingOptional` is true, `components/Chat/DMChatArea.tsx:567`).
   - **Then revert step 1 (remove the `setGlobalNonRepudiable` call) and confirm
     this test fails.** If it passes either way the cache refresh is not what is
     being tested and the assertion is worthless.

✅ **A per-conversation override still wins over the global**
   - Set a conversation's own signing setting, then flip the global the other way.
   - Expected: the conversation keeps its own value
     (`readSetting('isRepudiable') ?? !globalNonRepudiable`, `[id].tsx:269`).

✅ **The default is unchanged for existing accounts**
   - An account that has never touched the setting still signs by default
     (`?? true` at both read sites).

✅ **It round-trips through config sync**
   - With `allowSync` on, flip it on mobile and confirm desktop's Privacy tab
     shows the new value after a config pull, and vice versa.
   - Note the known asymmetry: config is pulled on startup/login, not live
     ([2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md](2026-06-22-userconfig-blob-not-live-synced-cross-device-master.md)),
     so allow for a relaunch. That is pre-existing behaviour, not this task's bug.

✅ **TypeScript compiles**
   - Run: `npx tsc --noEmit`

## Definition of Done

- [ ] `setGlobalNonRepudiable` exported and called from the config setter
- [ ] `updateNonRepudiable` + `useSigningSettings()` added, mirroring the receipts pattern
- [ ] Toggle row rendered in Settings → Privacy & Sync with desktop's exact label
- [ ] Takes effect without restart, and the revert-test above goes red
- [ ] Per-conversation override still takes precedence
- [ ] TypeScript passes
- [ ] No console errors

## Related

- [2026-06-25-port-message-signing-controls.md](../.done/2026-06-25-port-message-signing-controls.md) — shipped the per-conversation and per-space controls plus the composer lock; this is the account-level default it never surfaced
- [2026-06-17-dm-conversation-settings-parity.md](../.done/2026-06-17-dm-conversation-settings-parity.md) — the conversation-settings sheet this inherits into
- `quorum-desktop/.agents/docs/features/privacy-settings.md` — what each privacy toggle discloses, and the cross-client default table that surfaced this gap

---

*Last updated: 2026-08-07*
