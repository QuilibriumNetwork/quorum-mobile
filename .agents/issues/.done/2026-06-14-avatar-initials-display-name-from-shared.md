---
type: task
title: "Avatar initials — switch mobile to display-name-based initials + shared gradient logic"
status: done
created: 2026-06-14
completed: 2026-06-14
shipped-pr: "QuilibriumNetwork/quorum-mobile#90 (squash 5b7b5f9)"
category: convergence
complexity: medium
runtime-test: required
shared-version: "2.1.0-29 (already installed — NO bump, NO shared work needed)"
triggered-by: "quorum-desktop port-to-mobile audit 2026-06-14 (candidates.md row 34)"
desktop-reference: "quorum-desktop/src/components/user/UserInitials/UserInitials.native.tsx (vestigial, copy-paste reference)"
---

# Avatar initials — display-name-based + shared gradient logic

## What this does (plain terms)

Today, when a user has no profile photo, mobile shows a fallback avatar with initials derived from their **address** — an opaque string — so you see meaningless letters like `"AC"`. Desktop shows initials derived from the **display name** (`"AR"` for "Ada Rivera"), emoji-aware, with a deterministic color and a subtle two-stop gradient (the "Telegram-like" 3D look). This task makes mobile use the same system desktop uses.

The good news: **the entire algorithm is already in `@quilibrium/quorum-shared` and already installed on mobile** (`2.1.0-29`). We're not building or publishing anything shared — we're rewiring mobile's local `DefaultAvatar` to call the shared functions instead of its own worse copies, and consolidating the scattered space-name monograms.

## Why (the gap)

- **Meaningless initials.** Mobile's `getInitials(address)` returns address junk (`address.slice(0,2)` / `@handle.slice(1,3)`). A human can't recognize it. Desktop's `getInitials(displayName)` returns name initials.
- **Inconsistent space avatars.** Mobile has NO single space-avatar component. Space monograms are done 3 different ways: two list screens pass the space *address* into `DefaultAvatar` (→ address junk), and `ApexSubscribeModal.tsx` + `InviteLinkCard.tsx` inline their own `space.name.charAt(0)` (1 char, no color system). Desktop routes both user AND space avatars through ONE component + the same shared functions.
- **Reimplemented worse.** Mobile's local `hashToColor` (HSL) + `getInitials` duplicate — worse — what shared already exports.

## Verified facts (checked 2026-06-14 against the installed dist + repos)

- ✅ **Shared exports are present and typed in mobile's installed `2.1.0-29` dist.** Confirmed in `node_modules/@quilibrium/quorum-shared/dist/utils/avatar.d.ts`:
  - `getInitials(displayName: string): string`
  - `getColorFromDisplayName(displayName: string): string` (DJB2 hash → 32-color palette, pre-desaturated 25%)
  - `lightenColor(hex, percent)` / `darkenColor(hex, percent)`
  This is NOT the "stale dist" problem that blocks other tasks (primaryUsername, byte validators) — these four are really there. **No version bump, no Cassie publish needed.**
- ✅ **`expo-linear-gradient@15.0.8` is already a mobile dependency** (used in `MiniAppsModal`, `Card`, `WalletModal`). The gradient render needs no new dep.
- ✅ **Desktop reference renderer exists** at `quorum-desktop/src/components/user/UserInitials/UserInitials.native.tsx` (~85 lines). It's a *vestigial* desktop file (leftover from the old single-repo cross-platform era) — NOT an importable shared component, so we copy its logic into a mobile-local component. It already imports the shared functions and is the canonical pattern.
- ✅ **`DefaultAvatar` takes only `{ address, size, style }`** today (`components/ui/DefaultAvatar.tsx`). 17 files reference it.
- ✅ **No `SpaceAvatar`/`SpaceIcon` exists on mobile** — confirmed, so the `SpaceIcon` extraction is net-new (small).

## The Telegram-like look — how it's reproduced (answers "can colors/gradients migrate cleanly?")

The sophistication is in PURE FUNCTIONS, already shared — not in the renderer. To reproduce desktop's look 1:1:

- **Color** = `getColorFromDisplayName(name)` → deterministic hex from the 32-color desaturated palette. (Shared.)
- **Gradient** (the depth) = a 2-stop `LinearGradient` from `lightenColor(base, 5)` (top) to `darkenColor(base, 10)` (bottom). (Color math shared; `expo-linear-gradient` renders it.)
- **Unknown user** = grey gradient `#9d9da3 → #7a7a7f` (two hardcoded constants).
- **Shape/text** = `borderRadius: size/2`, `fontSize: size*0.4`, white `fontWeight:'500'` text.
- **No shadows** — there are none in desktop's component; the "3D" feel is entirely the gradient. So nothing exotic to port.

Conclusion: mobile gets the identical visual system by importing 4 shared functions + writing one small local renderer. NOT a separate sophisticated implementation.

## Scope — files to change

### 1. Rewrite `components/ui/DefaultAvatar.tsx` (the core change)

- Change props from `{ address, size, style }` to accept a **display name**. Recommended shape: `{ displayName?: string; address?: string; size; style }` — prefer `displayName`; if only `address` is passed (call sites not yet updated), fall back to current address behavior so nothing breaks mid-migration.
- Replace the local `hashToColor` with shared `getColorFromDisplayName(displayName)`.
- Replace the local `getInitials(address)` with shared `getInitials(displayName)`.
- Render the 2-stop `LinearGradient` (`lightenColor`/`darkenColor`) exactly like the desktop reference, instead of the current flat `backgroundColor`. Handle the unknown-user grey gradient (`initials === '?'`).
- Keep `size`/`style` props working.

> Copy the structure of `quorum-desktop/src/components/user/UserInitials/UserInitials.native.tsx` verbatim where possible — it's the proven pattern.

### 2. Update the 17 `DefaultAvatar` call sites to pass a display name

Files (from `grep -rln DefaultAvatar app components`):
`app/(tabs)/messages/dm/[id].tsx`, `app/(tabs)/messages/index.tsx`, `app/(tabs)/profile/index.tsx`, `app/(tabs)/spaces/discover.tsx`, `app/(tabs)/spaces/index.tsx`, `components/Call/InCallScreen.tsx`, `components/Call/IncomingCallScreen.tsx`, `components/Call/OutgoingCallScreen.tsx`, `components/Call/SpaceCallScreen.tsx`, `components/Chat/DirectMessagesList.tsx`, `components/Chat/DirectMessageView.tsx`, `components/Chat/DMChatHeader.tsx`, `components/Chat/MessagesList.tsx`, `components/Chat/ReactionDetailsModal.tsx`, `components/KickUserModal.tsx`, `components/UserProfileModal.tsx` (+ the component itself).

For each: pass the user's resolved display name (whatever the surrounding code already has for the name label). Where a display name genuinely isn't available, leave `address` as the fallback (the prop shape above allows it).

### 3. Extract a `SpaceIcon` component (consolidate space monograms)

- New `components/ui/SpaceIcon.tsx` (or similar): same gradient renderer, fed by `space.name` → `getInitials`/`getColorFromDisplayName`.
- Replace the inline `space.name.charAt(0)` monograms in `components/apex/ApexSubscribeModal.tsx:~361` and `components/Chat/InviteLinkCard.tsx:~197`.
- Replace the `DefaultAvatar`-with-space-address usages in `app/(tabs)/spaces/index.tsx:~63` and `app/(tabs)/spaces/discover.tsx:~90` so spaces get **name** initials, not address junk.
- (Space avatars that currently show an SF Symbol — `SpaceModal.tsx`, `SpaceSettingsModal.tsx` upload placeholders — are intentional "upload an icon" affordances; leave them unless you want name-initials there too. Confirm with the user.)

### 4. Photo-failure fallback wrinkle (`expo-image`)

- `components/ui/CachedAvatar.tsx` uses `expo-image`, which (unlike web `<img onError>`) can't render a React node on load error directly. To show initials when a photo URL fails, wrap with `useState(false)` + `onError={() => setImageError(true)}` → render the new `DefaultAvatar` on error. **Mobile's generic `components/ui/Avatar.tsx` already implements exactly this pattern** — copy it. Wire `HeaderAvatar.tsx` and `UnifiedProfileHeader.tsx` (which fall back to the blue logo today) to the initials fallback if desired (confirm scope with user).

## Out of scope (don't do here)

- No shared-package changes. The functions are already exported.
- The `isValidAvatarUri` duplication (`utils/validation.ts` vs the stricter inline copy in `DirectMessagesList.tsx:43` / `UserProfileModal.tsx:140`) is a real but separate cleanup — note it, fix only if it blocks an avatar showing correctly.

## Verification gates

Static:
- [ ] `npx tsc --noEmit` clean.
- [ ] `yarn lint` clean.
- [ ] `grep -rn "hashToColor\|slice(0, 2).toUpperCase" components/ui/DefaultAvatar.tsx` → gone (replaced by shared imports).
- [ ] No remaining inline `space*.charAt(0)` monograms (grep `charAt(0)` in `components/apex`, `components/Chat`).

Runtime (the phone is up this session — eyeball it):
- [ ] A user with no photo shows **name** initials (e.g. "NA"), not address junk, with the gradient (not flat color).
- [ ] The same user always gets the **same color** (deterministic).
- [ ] A name starting with an emoji shows the emoji.
- [ ] An empty/"Unknown User" name shows `?` on the grey gradient.
- [ ] A space with no icon shows its **name** initial(s) with a gradient, consistently across the spaces list, discover, invite card, and apex modal.
- [ ] A photo that fails to load falls back to initials (not the blue logo / blank).
- [ ] Cross-check one avatar against desktop for the same user — colors should match (both use `getColorFromDisplayName`).

## Done criteria

- `DefaultAvatar` + new `SpaceIcon` both render display-name initials via shared `getInitials`/`getColorFromDisplayName` with the 2-stop gradient.
- All call sites pass a display name (address only as fallback where no name exists).
- Static + runtime gates green.
- One mobile PR (self-merge when confident — this is mobile, so be sure; but it's UI-only, no wire/protocol change, no shared change, so risk is low).

---

## Completion record (2026-06-14) — shipped PR #90 (squash 5b7b5f9)

**Done as specified**, plus three in-scope additions discovered during implementation (all user-approved):

- **New `components/ui/AvatarInitials.tsx`** — single shared renderer (initials + 2-stop gradient) used by both `DefaultAvatar` and `SpaceIcon`, so the gradient logic lives in one place (mirrors the desktop reference verbatim: `#9d9da3`/`#7a7a7f` grey gradient, `lightenColor(base,5)`/`darkenColor(base,10)`).
- **`DefaultAvatar`** rewritten to `{ displayName?, address?, size, style }`; 18 call sites updated to pass a real name (address kept as fallback). `SpaceCallScreen` participant avatars keep `address` (raw addresses, no name available — the allowed fallback case).
- **New `components/ui/SpaceIcon.tsx`** — consolidated space monograms previously done 4+ ways: spaces list, discover, apex modal, invite card, **and the SocialFeed space picker** (the last one was not in the original scope grep — found by a full app-wide `charAt(0)` sweep).

**Additions beyond original scope (approved mid-task):**
1. **Scope #1 (headers):** `HeaderAvatar` + `UnifiedProfileHeader` (4 variants) now show name initials instead of the blue logo on photo-miss/fail, via a new **opt-in** `CachedAvatar` `fallbackName` prop. (Scope #2, the SF-Symbol space-upload placeholders, was explicitly SKIPPED per user.)
2. **Member-list bug (user-reported during the session):** `SpaceSettingsModal.tsx:1739` was a *fourth* inline monogram (`member.display_name.charAt(0)` on a flat `surface5` bg → "initial but no color"). Now uses `DefaultAvatar` → gradient. This was the symptom the user saw on the phone.
3. **Farcaster feed:** all 10 `CachedAvatar` author icons in `SocialFeedModal.tsx` now pass `fallbackName={author.displayName || author.username}`. Verified safe: the `fallbackName` prop is **opt-in**, a real pfp always wins, and there was no pre-existing default-pfp injection (only `CachedAvatar`'s blue logo). The feed fallback rarely fires in practice (Farcaster/Neynar almost always returns a pfp) but is a strict improvement for optimistic posts, in-flight stub casts, and image load failures. See [[cachedavatar-fallbackname-opt-in-farcaster-safe]] memory.

**Verification:** `tsc` and `eslint` error counts identical to baseline before/after (zero new issues introduced); grep gates green (no `hashToColor`/address `slice` in `DefaultAvatar`, no inline space `charAt(0)` in apex/Chat). Runtime: user tested on the phone before shipping.

**Left out of scope (noted for later):** `MiniAppsModal.tsx:394` still uses inline `app.name.charAt(0)` for **mini-app** icons — different domain (app icons, not user/space avatars); applying the gradient there is a design choice, not a consistency fix.
