# Dev: force-unblock a user that's stuck blocked (no UI path)

Personal "Block" (`useBlockUser`) hides a user's messages everywhere in a space, so a
blocked user disappears from the stream AND you can only reach their profile via the
Space Settings members list — which is sometimes incomplete (missing members; suspected
config/member sync gap). If the blocked user isn't in that list, there is currently **no
UI way to unblock them**. This is the dev escape hatch.

There is no browser-style JS console on a React Native app, so you can't paste a snippet
into a console. The reliable mobile equivalent is a **throwaway one-shot effect**, run
once, then removed. Confirmed working 2026-06-22.

## Facts (so the snippet targets the right storage)
- Block state lives in `UserConfig.blockedUsers[spaceId]: string[]` (per-space).
- Local config MMKV instance: **`createMMKV({ id: 'quorum-config' })`**.
- Config key: **`user_config:<address>`** (prefix `user_config:`).
- `auth:user` lives in a DIFFERENT store (`mmkvStorage`, `services/offline/storage`), so
  prefer reading the address from the in-memory `user` object, not MMKV.
- Helpers: `getLocalUserConfig(address)` / `saveLocalUserConfig(config)` /
  `saveConfig(config)` — all in `services/config/configService.ts`.

## How to run it (the one-shot)

Add this TEMPORARY effect inside the `AuthProvider` component body in
`context/AuthContext.tsx` (it has `user` in scope and already imports from
`@/services/config`). Add `getLocalUserConfig, saveLocalUserConfig` to that import.
Set `TARGET` to the address you need to unblock.

```tsx
// TEMP DEV ONE-SHOT — unblock a stuck-blocked user. REMOVE after it runs.
useEffect(() => {
  if (!__DEV__) return;
  const addr = user?.address;
  if (!addr) return;
  const TARGET = 'Qm...PUT_ADDRESS_HERE';
  const cfg = getLocalUserConfig(addr);
  if (!cfg) return;
  const bu = ((cfg as any).blockedUsers ?? {}) as Record<string, string[]>;
  let removed = 0;
  for (const sid of Object.keys(bu)) {
    const before = bu[sid]?.length ?? 0;
    bu[sid] = (bu[sid] ?? []).filter((a) => a !== TARGET);
    removed += before - bu[sid].length;
  }
  if (removed > 0) {
    (cfg as any).blockedUsers = bu;
    saveLocalUserConfig(cfg);   // local
    void saveConfig(cfg);        // sync outbound (if allowSync)
    console.log(`[temp-unblock] removed ${TARGET} from ${removed} space(s); reload.`);
  } else {
    console.log('[temp-unblock] target not in blockedUsers (already clear).');
  }
}, [user?.address]);
```

Steps: paste it in → reload the app (JS only, no rebuild) → watch the Metro terminal for
`[temp-unblock] removed …` → reload once more so the user reappears → **delete the effect
and revert the import**.

## Generalising
- To unblock ALL users in a space, drop the `.filter(... !== TARGET)` and set
  `bu[sid] = []` for the relevant `sid`.
- The same pattern works for any stuck UserConfig field (e.g. a stuck channel/space mute
  in `mutedChannels` / `notificationSettings[sid].isMuted`).
- A proper fix (a "Blocked users" management surface so this never strands a user) is an
  open product decision — desktop has the same gap. Tracked in the mute-and-block-overhaul
  folder / Task D discussion, not yet built.

*Last updated: 2026-06-22*
