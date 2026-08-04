---
type: task
title: "Profile screen — single pill-row navigation"
status: open
created: 2026-06-20
---

# Profile screen — single pill-row navigation

**Status:** APPROVED by lead (2026-06-20) — implementing.
**Branch:** `profile-pill-navigation`.
**Mockup:** `<local mockups dir>/quorum-profile-pills-mockup.html` (4 frames: Settings / Farcaster / Casts pill active + Quorum-only user).

---

## Goal

Replace the current **two-level navigation** on the profile screen with a **single horizontal pill row**, for a cleaner, flatter UX.

### Current (two levels)
- Page-level pager in `UnifiedProfileScreen`: **Account** / **Casts** (segment bar).
- Inner tabs inside `ProfileModal`: **Profile** / **Premium** / **Settings**.
- Result: users track "where am I" on two axes; the relationship between levels is unclear (why is Casts a peer of Account, but Settings a child of it?).

### Proposed (one level)
One horizontal pill row: **Profile · Premium · Settings · Farcaster · Casts**
- Pills scroll horizontally; active pill auto-scrolls into view; subtle right-edge fade hints at overflow.
- Identity cards (Quorum / Farcaster) stay above the pills — they're identity display + edit entry, not navigation.

---

## Pill behavior

| Pill | Content | Condition |
|------|---------|-----------|
| Profile | Bio + Account Info (today's inner "Profile" tab) | always |
| Premium | Apex / premium (today's inner "Premium" tab) | always |
| Settings | **Quorum-only** settings: Privacy & Sync, Notifications, Appearance, Account (recovery), Device Keys, Calls, App Updates, Developer, Danger Zone | always |
| Farcaster | **Everything from today's Farcaster section**: @username/FID + Disconnect, feed-reply toggles, Hypersnap Signer, Import Warpcast Wallet | only if FC connected |
| Casts | The user's own cast feed (today's "Casts" page) | only if FC connected |

**Conditional pills:** `Farcaster` and `Casts` render only when `user?.farcaster?.fid` is set. A Quorum-only user sees just **Profile · Premium · Settings**.

**Decision (confirmed with user):** the Farcaster config block is **moved OUT of Settings** into the Farcaster pill — no duplication. Settings becomes purely Quorum.

---

## Implementation notes (from code recon)

- **`components/UnifiedProfileScreen.tsx`** owns the page-level pager today (`pages` array, `activePageIndex`, horizontal `ScrollView` with `pagingEnabled`). The pill row replaces the `segmentBar` + pager. `pages` is already dynamic for Casts — extend the same pattern to all 5 pills.
- **`components/ProfileModal.tsx`** currently owns its own inner-tab state (`activeTab: 'profile' | 'premium' | 'settings'`) and renders its own tab bar (`ProfileModal.tsx` ~line 1578). To drive everything from one pill row:
  - **Lift selection up:** `UnifiedProfileScreen` owns the active pill; pass the selected section into `ProfileModal` as a prop and hide ProfileModal's internal tab bar (mirror the existing `hideHeader` prop pattern — add e.g. `activeSection` + `hideTabBar`).
  - Settings tab in ProfileModal must **drop the Farcaster `<View style={styles.section}>` block** (the connected/not-connected/import states ~line 2113) — that moves to the Farcaster pill content.
  - The Farcaster pill content reuses the exact JSX already in the Settings Farcaster block (username/FID, feed toggles, Hypersnap, Warpcast import). All its state/handlers already live in `ProfileModal` scope.
- **Feed toggles** (`showRepliesInFeed`, `showNonFollowReplies`) are already confirmed Farcaster-only (`hooks/useFarcasterFeed.ts` is the sole consumer; keys in `services/farcaster/feedPrefs.ts`). They belong in the Farcaster pill.
- **Casts** content already exists as `ProfileView` from `SocialFeedModal` (rendered in the current Casts page).

### Pill row UI
- Horizontal scrollable row of pills. Active = accent bg (`#0287f2`) + white text; inactive = `surface2` bg + `textMuted` text.
- Min 44px touch target — don't shrink to force-fit 5 pills; let them scroll.
- Auto-scroll active pill into view on selection.
- Right-edge fade (`linear-gradient(to right, transparent, bg)`) as overflow affordance.

---

## Open questions / risks

- **Five pills are wide** on a narrow phone — horizontal scroll is the accepted answer (X / Warpcast pattern). Confirm lead is OK with scroll vs. wanting a different grouping.
- **Identity card vs Farcaster pill overlap:** the top Farcaster identity card and the Farcaster pill both reference the FC account. Keep the card as identity/edit-entry; the pill is config. No functional overlap, but worth a sentence to the lead.
- Verify no other screen renders `ProfileModal` in a non-route mode that still needs the old inner tab bar (recon during this session: `ProfileModal` is rendered in exactly one place — the embedded route-mode use in `UnifiedProfileScreen` — so the inner tab bar is effectively only used there).

---

## Acceptance

- One pill row, no nested tabs, on the profile screen.
- Farcaster + Casts pills hidden for Quorum-only users.
- Settings contains zero Farcaster config; all FC config lives under the Farcaster pill.
- Pills scroll; active pill always visible; 44px targets.
- `npx tsc --noEmit --skipLibCheck` clean (baseline: 23 pre-existing errors unrelated to profile).

---

*Created: 2026-06-20*
