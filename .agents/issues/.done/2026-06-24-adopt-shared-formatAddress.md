---
type: task
title: "Adopt shared `formatAddress`, drop device-width `scaleFactor`"
status: done
created: 2026-06-24
---

# Adopt shared `formatAddress`, drop device-width `scaleFactor`

**Status:** DONE — 2026-06-26, branch `feat/adopt-shared-format-address` (unblocked: shared `formatAddress` confirmed published + type-resolving in `2.1.0-33`, the version mobile was already pinned to → step 1 was a no-op).
**Author:** plan, 2026-06-24
**Scope:** quorum-mobile only (the mobile leg of the cross-repo address-formatting consolidation)
**Depends on:** `formatAddress` landed in `@quilibrium/quorum-shared` `master` (PR #49, merged 2026-06-24). Mobile is pinned to `2.1.0-32`; this task is blocked until shared is **published** at a version > `2.1.0-33` and mobile bumps its pin.

---

## Why

Address truncation was implemented independently in all three repos (desktop, mobile, shared) with inconsistent char counts and separators. quorum-shared now has one canonical helper, `formatAddress(address, start = 6, end = 6)`, and quorum-desktop has already migrated to it (branch `feat/consolidate-address-formatting`). This task brings mobile onto the same helper so a given preset renders **identically** on desktop and mobile.

`formatAddress` is **Qm-aware**: every Quilibrium address is a CIDv0 (`Qm` + 44 base58 chars), and the `Qm` prefix is a constant multihash header carrying zero entropy. The helper keeps `Qm` visible (brand) but counts `start` *after* it, so `start`/`end` are meaningful entropy chars. Defaults (6/6) give a true 12-char anchor, e.g. `QmQuCGpE…imXST1`. This hardens identity labels against address-grinding/impersonation. (Full rationale lives in the desktop-side task: `quorum-desktop/.agents/tasks/.todo/2026-06-23-consolidate-address-formatting-to-shared.md`.)

## Decisions already settled (2026-06-24)

1. **Drop `scaleFactor` entirely.** Mobile's current `utils/formatAddress.ts` scales the leading char count by *device width* (`Dimensions.get('window').width / 393`, capped 1.5×). This is removed. Rationale:
   - It scaled by phone size, NOT by the label's actual container, so it never fit-to-width: a cramped DM row and a wide profile header got the same result on one device.
   - It only ever changed output on tablets / large phones (>393pt); normal phones already saw `scaleFactor ≈ 1.0` (no effect).
   - It is the one non-portable piece (React Native `Dimensions`), so it could never move into shared anyway.
   - Dropping it gives true cross-platform parity: a preset renders the same on desktop and mobile.
2. **Keep mobile's `truncateAddress(addr, mode)` wrapper** (non-breaking for the ~31 existing call sites), but have each mode delegate to shared `formatAddress` for the actual slice (this is option (a) from the cross-repo plan).
3. **Modes map to fixed `start`/`end` pairs** — today's phone (`scaleFactor ≈ 1.0`) values frozen as constants, matching desktop:
   - `short → (4, 3)`
   - `medium → (6, 4)`
   - `long → (8, 6)`
4. **`truncateName`'s default also loses `scaleFactor`.** It currently uses `Math.round(16 * scaleFactor)`; replace with a fixed `16`. (When the `scaleFactor` constant is deleted, this default breaks otherwise.) Note: this slightly changes tablet behavior — long names cap at 16 chars like phones instead of up to 24. That is the intended parity outcome, not a regression.
5. **Separator stays `…`** (Unicode `…`), already mobile's house style and shared's.

## Current mobile state (audit 2026-06-24)

`utils/formatAddress.ts` exports three things:
- `truncateAddress(addr, mode)` — modes `short/medium/long`, device-scaled `start`, fixed `end`, `…`. ~31 call sites across ~17 files.
- `formatAddress(addr, chars = 6)` — symmetric `chars`/`chars`, `…`. (Note: name collides with the shared export; see step 4 below.)
- `truncateName(name, maxLength?)` — default `Math.round(16 * scaleFactor)`.

Plus ~18 UI sites that bypass the util with inline slices (mixing `8/4`, `8/6`, `10/8`, `10/6`, `6/4`, `4/3` and `...` ASCII vs `…` Unicode). The visible DM-list one is `DirectMessagesList.tsx:107` (`8/4`).

## Steps

### 1. Bump the shared pin
- Bump `@quilibrium/quorum-shared` in `package.json` from `2.1.0-32` to the newly **published** version (whatever the desktop-side PR's publish produced — confirm it is published, not just merged to `master`).
- Reinstall, confirm `formatAddress` resolves from the package.

### 2. Refactor `utils/formatAddress.ts`
- Remove `import { Dimensions }`, `SCREEN_WIDTH`, `BASE_WIDTH`, `scaleFactor`.
- Re-export or wrap the shared `formatAddress`. **Name-collision caveat:** mobile already exports a local `formatAddress(addr, chars)`. Decide one of:
  - (a) Replace the local `formatAddress` with a re-export of the shared one (shared is `start, end`; local was symmetric `chars` — check the ~N call sites of the local `formatAddress` and migrate them, since `formatAddress(a, 6)` would now mean `start=6, end=6` which is actually the same symmetric result for equal args — verify each).
  - (b) Keep mobile's symmetric `formatAddress` under a different local name and import shared as the canonical one.
  Prefer (a) if the call-site audit shows they're all symmetric anyway.
- Rewrite `truncateAddress(addr, mode)` to delegate:
  ```ts
  import { formatAddress } from '@quilibrium/quorum-shared';

  const MODES = {
    short:  [4, 3],
    medium: [6, 4],
    long:   [8, 6],
  } as const;

  export function truncateAddress(
    address: string | undefined,
    mode: 'short' | 'medium' | 'long' = 'medium',
  ): string {
    if (!address) return 'Unknown';
    const [start, end] = MODES[mode];
    return formatAddress(address, start, end);
  }
  ```
  (Confirm the `!address → 'Unknown'` behavior is still wanted; shared `formatAddress` returns `''` for falsy. Keep mobile's `'Unknown'` here if any call site relies on it.)
- Replace `truncateName`'s default with fixed `16`; drop `scaleFactor` from it.

### 3. Migrate the ~18 inline-slice sites
- Point each at `truncateAddress(addr, mode)` (or shared `formatAddress` directly), starting with `DirectMessagesList.tsx:107`.
- Standardize separators on `…`; drop the inline `...` ASCII variants.

### 4. Verify
- `yarn tsc --noEmit` (or mobile's typecheck script) clean.
- Mobile build + key screens: DM list, conversation header, profile, wallet/QNS sites that showed addresses.
- Eyeball tablet rendering once: confirm labels look balanced now that they no longer get bonus leading chars (expected: a bit more empty space next to them, nothing truncated/overflowing).

## Guardrails
- **Additive on shared already done** — this task only changes mobile. No shared changes here.
- **Parity is the goal:** after this, desktop and mobile render the same truncation for the same preset/args.
- Per the don't-break-mobile rule, this runs on mobile's own cadence; it does not block desktop (already merged-to-branch).

---

## Implementation notes (2026-06-26)

**Blocker was already clear.** Mobile was pinned to `2.1.0-33`, which already contains a published, type-resolving `formatAddress` (runtime bundles `dist/index.{js,mjs,native.js}` export it; types resolve via the `dist/index.d.ts → utils → formatting` `export *` barrel chain). Step 1 (bump pin) was a no-op — no `package.json` change, no reinstall.

**`utils/formatAddress.ts` rewrite (option (a)):**
- Dropped `Dimensions`/`SCREEN_WIDTH`/`BASE_WIDTH`/`scaleFactor`.
- `truncateAddress(addr, mode)` now delegates to shared `formatAddress` via a `MODES` map (`short [4,3]`, `medium [6,4]`, `long [8,6]`). Kept the mobile-specific `!address → 'Unknown'` and `@username` passthrough (shared also passes `@` through, but the `'Unknown'` default is mobile-only and some call sites chain on it).
- Replaced the local symmetric `formatAddress(addr, chars)` with a **re-export of shared's** `formatAddress`. The one non-`truncateAddress` caller — `app/(onboarding)/complete.tsx:151` `formatAddress(addr, 8)` (a Qm account address) — now renders Qm-aware `start=8, end=6` instead of symmetric 8/8. Intended parity change, looks correct for an account address.
- `truncateName` default `Math.round(16 * scaleFactor)` → fixed `16`. (Note: `truncateName` has no callers in the app — kept per task instruction #4 rather than deleted.)

**Inline sites migrated (scope = Quilibrium identity addresses only; wallet/QNS/tx-hash/EVM/Solana/BTC/pubkey sites deliberately left alone — confirmed with user 2026-06-26):**
- `components/Chat/DirectMessagesList.tsx:107` (`8/4`) → `truncateAddress(addr, 'long')` (8/6). Collapsed the whole `@`/length/else block since the util handles all three.
- `components/Chat/MessageMarkdownRenderer.native.tsx` — local `truncate()` (6/4) removed; `mention_user` fallback now `truncateAddress(node.address)` (medium 6/4).
- `components/ProfileModal.tsx` — `formatResolveKeyAsAddress` (derived Qm addr, 8/6) and device inbox addr (8/6) → `truncateAddress(addr, 'long')`.
- `components/SocialFeedModal.tsx:719` (one-sided `slice(0,12)+'...'`) → `truncateAddress(conv.address)`.
- `components/ShareInviteSheet.tsx:173` — label fallback + sublabel → `truncateAddress` (sublabel now two-sided `medium`).
- `services/notifications/sharedKeystore.ts:128` (one-sided `slice(0,6)…`) → `truncateAddress(participants[0])`.

**Mode choice rationale:** each site got the preset matching its *original* char count and desktop's preset — NOT a blanket `long`. `8/x` sites → `long`; `6/4` sites → `medium` (default). The `8/4` DM-list site rounded to `long` (8/6) since modes are now fixed pairs (the old `end:4` for the 8-start preset is gone — desktop renders `long` as 8/6).

**Verification:** `npx tsc --noEmit` → 22 errors, identical to clean-master baseline (zero new; all pre-existing in calling/webrtc/crypto/expo-router, none in touched files). `expo lint` on touched files → only pre-existing warnings + 2 pre-existing `no-unescaped-entities` errors at `ShareInviteSheet.tsx:156` (not my lines). No runtime test run (statically-verifiable change, per mobile cross-repo posture).

---

*Last updated: 2026-06-26*
