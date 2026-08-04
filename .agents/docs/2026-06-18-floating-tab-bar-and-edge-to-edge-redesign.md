# Floating Tab Bar + Edge-to-Edge Chrome Redesign

Context doc for the nav-bar redesign shipped on branch `feat/nav-bar-redesign` (session 2026-06-18). **Still in testing — not merged.** Read this before reverting, tweaking, or extending any of it.

> Status as of 2026-06-18: authored + device-tested by the user on a Motorola Edge 50 Fusion (Android, 3-button nav). NOT yet tested on iOS. Branch carries a NATIVE dependency (`expo-navigation-bar`) so a clean install / teammate needs a rebuild before merge.

---

## What changed, in one paragraph

The five-tab default bottom tab bar became a custom **full-width strip** (`AppTabBar`) with the user avatar as the leftmost item, a primary icon row, and an expandable secondary row (Wallet/Bookmarks/Discover/MiniApps/QNS) revealed by a vertical `⋮`. The app already had `edgeToEdgeEnabled: true`, so content draws behind the system bars; we **hardened safe-area insets** across every screen that had hardcoded bottom/top padding, made the **system nav-bar button tint theme-aware** (`expo-navigation-bar`), and reworked the **bottom of every content surface** so lists scroll full-height to the device edge behind the bar, with a **gradient scrim** dissolving content into the background. Chat screens additionally float the composer over the message list (Telegram-style).

---

## The commits (revert units)

In order on `feat/nav-bar-redesign`:

1. `floating tab bar redesign` — `AppTabBar`, avatar-in-bar, secondary row, header cleanup (removed `HeaderAvatar` from 5 screens, left-aligned headings).
2. `harden safe-area insets for edge-to-edge` — the 9 inset fixes + `expo-navigation-bar` button tint + removed invalid `android.navigationBar.backgroundColor`.
3. `QNS brand mark in tab bar` — `QnsIcon` in the secondary row.
4. `float chat composer over messages with bottom fade` — chat layout restructure + `ChatBottomChrome`.
5. `full-bleed list tabs with shared bottom fade scrim` — `ListBottomFade` + `FloatingTabScreen`, applied to Spaces/Messages/Notifications/Wallet/Feed/MiniApps.
6. `lift feed compose FAB above tab bar; reorder tab icons` — FAB fix + Messages-before-Spaces.
7. `unify message/cast row width via shared constant` — `Skin.contentRowPaddingH()`.
8. `tune chat bottom fade opacity profile` — the gradient alpha tuning.
9. `correct secondary-row focus accent; pad expanded tab bar` — `focusedLeafName` fix + `EXPANDED_V_PADDING`.
10. `raise the composer pill` + `brighten the composer pill top rim` — pill rim + shadow (later folded into theme tokens, see 11).
11. `make composer + bottom fades light-theme aware` — per-scheme semantic tokens (`composerPillBg`/`composerPillBorder`/`tabBarIconInactive`) + per-scheme fade opacities; threaded `isDark` to the fades. **This supersedes the hardcoded rim/opacity values from commits 8 and 10.**
12. `refine composer pill + emoji panel for light theme` — emoji panel shares `composerPillBg` + rim border; `composerPanelBand`/`composerPanelBandActive` tokens; per-scheme pill shadow.
13. `floatingShadow() helper` — canonical floating-button shadow in `geometry.ts`, adopted in `AudioSpaceOverlay`/`MinimizedMiniappChip`.
14. `feed reply editor/FAB clear the tab bar; thinner composer icons` — `IconSymbol.strokeWidth` prop (composer icons 1.5); feed stack screens (thread/profile/channel) pass `floatingTabBarPadding` as `bottomInset` in route mode; thread ScrollView padding now includes `bottomInset`.
15. `robust keyboard avoidance for feed reply (keyboard-controller)` — ported the thread reply off `KeyboardAvoidingView` onto `react-native-keyboard-controller`'s `KeyboardAwareScrollView`. `bottomOffset:64` keeps Post visible for typical replies (definitive sticky-footer fix tracked in `.agents/issues/.open/2026-06-19-feed-reply-pin-post-button-above-keyboard.md`).
16. `additive bottom inset on hand-rolled modal sheets` — `Math.max(inset, gap)` → `inset + gap` on `CreateSpaceSheet`, `EditHistoryModal`, `MessageActionSheet`, `FarcasterReimportSheet`, `ReportModal`.

Each is independently revertable. Commit 5 depends on commit 2's inset work; commit 4 introduced `ChatBottomChrome` that commits 8 + 11 tune. If reverting the look, start from 11/12 (they own the final per-scheme values).

Related deferred work (tracked as `.agents/tasks/.todo/` files, NOT in this branch):
- `2026-06-19-feed-reply-pin-post-button-above-keyboard.md` — sticky-footer so the reply Post button is always visible.
- `2026-06-19-modal-close-affordance-consistency.md` — standardize X-button / backdrop-dismiss across modals (forms can lose input on stray backdrop tap; X presence currently tracks the QNS/wallet code cluster, not modal type).

---

## Files and what they own

### New shared pieces (single source of truth — change these, not the call sites)

| File | Owns |
|------|------|
| `components/ui/AppTabBar.tsx` | The whole custom tab bar. Constants `PRIMARY_ROW_HEIGHT=54`, `SECONDARY_ROW_HEIGHT=62`, `EXPANDED_V_PADDING=12` (extra top/bottom room, animated, when expanded to two rows), `H_MARGIN=0`, `BOTTOM_MARGIN=0`, `PILL_RADIUS=0` (full-width strip mode — was a floating pill, flattened to a strip on the user's call). Also owns the `focusedLeafName` logic that stops a primary icon from lighting up when a nested SECONDARY-row route (`discover`, `apps`) is focused. |
| `components/Chat/ChatBottomChrome.tsx` | Chat composer overlay + bottom-fade gradient + `COMPOSER_RESTING_HEIGHT=60`, `FADE_LEAD=56`. Fade alpha is PER-SCHEME (`TOP_OPACITY=0` always; `GAP_OPACITY_DARK=0.92`/`_LIGHT=0.70`; `BOTTOM_OPACITY_DARK=0.55`/`_LIGHT=0.30`) — takes an `isDark` prop. Plus `useChatListBottomInset(tabBarHeight)`. |
| `components/ui/ListBottomFade.tsx` | The list-screen scrim (no composer). `TAB_BAR_HEIGHT=54`, per-scheme `MAX_OPACITY_DARK=0.85`/`MAX_OPACITY_LIGHT=0.55` — takes an `isDark` prop. |
| `components/ui/FloatingTabScreen.tsx` | Wrapper for list tabs: fills background, renders `ListBottomFade` (forwarding `isDark`), exposes `listBottomPadding` via render-prop. Takes `surfaceColor` + `isDark`. |
| `hooks/useFloatingTabBarPadding.ts` | Canonical bottom content-padding for any list under the floating bar: `TAB_BAR_HEIGHT(54) + insets.bottom + EXTRA(24)`. |
| `theme/skins/geometry.ts` → `contentRowPaddingH()` | Shared horizontal padding (= `space(16)`) for message/cast rows so feed + chat match width. |
| `theme/skins/geometry.ts` → `floatingShadow()` | Canonical drop shadow for floating buttons/chips (FABs, search pill, minimized miniapp chip): a tight crisp lift (offset 2 / radius 4 / elevation 4) that doesn't read as a muddy halo on light. Adopted in `AudioSpaceOverlay`, `MinimizedMiniappChip`. Surfaces needing a big soft shadow (modals, sheets, toasts) keep their own. |
| `theme/themes.ts` semantic tokens | Per-scheme colour tokens (resolved via `surf()`/`pick()`, skin-override aware): `composerPillBg` (raised surface4 on dark, near-white surface0 on light), `composerPillBorder` (faint white rim on dark, grey edge=surface6 on light), `composerPanelBand` + `composerPanelBandActive` (emoji-panel category strip + selected pill, derived a subtle step off the panel base), `tabBarIconInactive` (textMuted on dark, stronger textSubtle on light). This is the canonical way to make these surfaces scheme-correct — DON'T branch `isDark` inline in components for colours; add a token. (Fade OPACITY and the pill SHADOW are not colours, so those stay `isDark`/`theme.dark` branches on the component.) |
| `components/ui/IconSymbol.tsx` → `strokeWidth` prop | Outline-icon line thickness, forwarded to Tabler's `strokeWidth` (default 2; composer emoji + paperclip use 1.5). Only forwarded when set. **Tabler's `stroke` prop is the COLOR, not the width** — passing a number to `stroke` errors `"1.5" is not a valid color or brush` and renders the icon invisible. |
| `components/ui/QnsIcon.tsx` | Self-contained QNS SVG brand mark (mirrors quorum-shared's `qns` custom icon). |

### Touched screens

- `app/(tabs)/_layout.tsx` — custom `tabBar` prop; `TAB_BAR_CONTENT_HEIGHT=54` kept in `tabBarStyle.height` so `useBottomTabBarHeight()` still returns correct clearance for chat composer screens even though the visual bar is custom.
- `app/(tabs)/spaces|messages|profile/index.tsx` — wrapped in `FloatingTabScreen`; `HeaderAvatar` removed; headings left-aligned.
- `app/(tabs)/wallet/index.tsx`, `app/(tabs)/profile/apps.tsx` — `ListBottomFade` drop-in (they keep their own header, so not the full wrapper).
- `components/WalletModal.tsx`, `components/MiniAppsModal.tsx`, `components/SocialFeedModal.tsx` — route-mode bottom-padding moved onto the SCROLLABLE's `contentContainerStyle` (see gotcha below); feed FAB lifted; feed `userPanel` spacer dropped in route mode.
- `app/(tabs)/spaces/[id]/[channelId].tsx`, `app/(tabs)/messages/dm/[id].tsx` — removed container `paddingBottom`; full-screen chat area; `ChatBottomChrome`.
- `components/Chat/SpaceChatArea.tsx`, `DMChatArea.tsx` — render through `ChatBottomChrome`.
- `components/Chat/MessageInput.tsx` — container background now `transparent` (only the pill carries a surface, so messages show behind it).
- `components/Chat/MessagesList.tsx` — added `bottomInset` prop on `contentContainerStyle`; row uses `contentRowPaddingH()`.

---

## The non-obvious decisions (why it's built this way)

1. **The tab bar is a full-width strip, not a floating pill.** It started as a floating pill (margins + radius + shadow) per the original design, but the user flattened it (`H_MARGIN/BOTTOM_MARGIN/PILL_RADIUS = 0`, no shadow) because the pill's width visibly mismatched the full-width chat composer. The pill machinery is still in the file (constants set to 0) so it's a one-line revert to bring the pill back.

2. **`useBottomTabBarHeight()` still works with a custom `tabBar`.** React Navigation doesn't measure a custom bar, so we keep `tabBarStyle.height = 54 + insets.bottom` in `screenOptions`. Chat composer screens read this. If you change the bar height, change it in BOTH `AppTabBar` (`PRIMARY_ROW_HEIGHT`) and `_layout.tsx` (`TAB_BAR_CONTENT_HEIGHT`).

3. **Edge-to-edge was ALREADY on.** `app.json` had `edgeToEdgeEnabled: true` before this session. The inset fixes weren't enabling a risky switch — they were fixing screens that hadn't caught up to a mode already live. Lower risk than it looked.

4. **System nav-bar background is NOT set by us.** In edge-to-edge on Android 15, `navigationBar.backgroundColor` is deprecated/ignored — the app content drawing behind the transparent nav bar provides the colour. The old `android.navigationBar.backgroundColor` in app.json was actually an INVALID Expo config field (expo-doctor confirmed). We removed it. The native `enforceNavigationBarContrast=true` in `android/.../styles.xml` is the contrast safety net; `expo-navigation-bar`'s `setButtonStyleAsync` (in `_layout.tsx` `StatusBarWrapper`) makes the button icons theme-aware (the one genuine cross-OEM gap).

5. **Keyboard avoidance is owned by the composer, not the screen.** When we pulled the composer out of flex flow into an absolute overlay (`bottom: tabBarHeight`), the keyboard handling stayed intact because it lives in `MessageInput`'s own animated spacer. The math: overlay at `bottom: tabBarHeight`, spacer grows by `keyboard − tabBarHeight`, total = `keyboard`. Don't move the keyboard logic to the screen.

---

## Critical gotchas (these cost real debugging time this session)

- **Bottom padding MUST go on the scrollable's `contentContainerStyle`, NOT an outer View.** Wallet looked broken because the route-mode `paddingBottom` was on the outer `routeContainer` View — that shrinks the scroll area so content stops short, instead of letting content scroll UNDER the bar. The fix is always: padding on the FlashList/ScrollView/FlatList `contentContainerStyle`. This is the #1 recurring mistake.

- **Feed had a hidden `userPanel` bottom spacer.** `SocialFeedModal` rendered `<View style={{height: userPanelHeight}}/>` after its list, reserving dead space. In route mode that left a gap above the bar. Made it `{!isRouteMode && ...}`.

- **`withAlpha(color, 0)` beats the `'transparent'` keyword in gradients.** `'transparent'` interpolates as transparent-BLACK on some platforms → faint dark halo when ramping to a light surface. `withAlpha(surfaceColor, 0)` keeps the same RGB at alpha 0 → clean ramp. Used in `ChatBottomChrome`.

- **The chat gradient top stop MUST be alpha 0.** Any tint at the top dims messages ABOVE the composer (a regression we hit and reverted). Only ramp opacity from the composer top downward.

- **`surface1` is not always hex.** A wallpaper skin makes it `rgba()` via `sheer()`/`withAlpha()`. Don't string-concat `${surface1}00` for transparency — use `withAlpha()` (handles hex + rgba) or the `'transparent'`/zero-alpha approach.

- **Route-mode vs modal-mode branching.** WalletModal/MiniAppsModal/SocialFeedModal each render in BOTH a tab (route mode) and as a BaseModal. EVERY bottom/padding change here is gated to `isRouteMode` — the modal path is shared and must stay untouched.

- **A static audit can be CONFIDENTLY WRONG about occlusion — verify on device.** An early audit declared the Farcaster thread reply FAB "safe" because it assumed the pushed stack screen *covered* the floating tab bar. It didn't — the bar renders over the stack, so the reply editor + FAB sat hidden behind it. The lesson: "this overlay covers the bar" is a claim to TEST on a device, not assume. Bottom-anchored interactive elements on any surface that renders under the floating bar need `floatingTabBarPadding`, not `insets.bottom`. (And the `bottomInset` prop fed three things — list padding, editor position, FAB — but the thread ScrollView *also* hardcoded its own `paddingBottom: 16` that ignored the prop; grep for hardcoded paddings that bypass the inset you're threading.)

- **`Math.max(insets.bottom, gap)` is the wrong formula for nav-bar clearance — use `insets.bottom + gap`.** `max()` swallows the gap whenever `insets.bottom >= gap` (Android 3-button nav ≈ 36-48px), so the button ends flush against the nav buttons. Several hand-rolled modal sheets had this. The shared `BaseModal` does it right (`paddingBottom: insets.bottom`, additive context). For any new bottom-anchored content, additive.

- **Don't reinvent keyboard avoidance — the project already has `react-native-keyboard-controller`.** RN's `KeyboardAvoidingView` needs per-platform/per-context magic numbers (the feed thread used `behavior: ios?'padding':'height'` + offset math) and breaks across route-mode (`adjustResize`) vs modal-mode (`adjustNothing`). The library's `KeyboardAwareScrollView` (for scroll content) / `KeyboardStickyView` (to pin a bar to the keyboard) handle all four cases uniformly. `KeyboardProvider` is already at the app root. The chat composer uses the library's lower-level `useReanimatedKeyboardAnimation` (the SharedValue is NEGATIVE-going, 0→−height — negate it).

- **Tabler RN: `strokeWidth` is the line thickness; `stroke` is the COLOR.** `IconSymbol` now exposes `strokeWidth`. Passing a number to `stroke` errors `"1.5" is not a valid color or brush` and renders the icon INVISIBLE with no crash. Also: don't pass `stroke={undefined}` to every icon — only forward when set, or you blank all icons.

- **The EmojiPicker is NOT a nav-bar bottom sheet** — it opens in the keyboard's footprint below the composer (`marginBottom: keyboardHeight`) and has an `embedded` mode. Don't "fix" it with `insets.bottom` like the other sheets; its layout is already correct.

---

## Tuning knobs (where to change the look)

| Want to change | Edit |
|----------------|------|
| Tab bar height | `PRIMARY_ROW_HEIGHT` in `AppTabBar.tsx` AND `TAB_BAR_CONTENT_HEIGHT` in `_layout.tsx` |
| Extra room when the bar is expanded | `EXPANDED_V_PADDING` in `AppTabBar.tsx` |
| Bring back the floating pill | `H_MARGIN`/`BOTTOM_MARGIN`/`PILL_RADIUS` + shadow in `AppTabBar.tsx` |
| List-screen scrim darkness | `MAX_OPACITY_DARK` / `MAX_OPACITY_LIGHT` in `ListBottomFade.tsx` |
| Chat gap / device-button opacity | `GAP_OPACITY_DARK/_LIGHT`, `BOTTOM_OPACITY_DARK/_LIGHT` in `ChatBottomChrome.tsx` (keep `TOP_OPACITY=0`) |
| How high the chat fade starts above the composer | `FADE_LEAD` in `ChatBottomChrome.tsx` |
| List content clearance from the bar | `EXTRA` in `useFloatingTabBarPadding.ts` |
| Message/cast row width | `contentRowPaddingH()` in `geometry.ts` (one change hits feed + chat) |
| Composer pill colour / rim (per scheme) | `composerPillBg` / `composerPillBorder` tokens in `themes.ts` |
| Composer pill shadow strength | `shadowOpacity`/`elevation` on `pill` in `MessageInput.tsx` |
| Tab-bar inactive icon colour (per scheme) | `tabBarIconInactive` token in `themes.ts` |

---

## Known open items / not done

- **iOS untested.** All device verification was Android (Motorola). The geometry is platform-agnostic but unverified on iPhone.
- **Blur for the device-button zone** — user asked, we deferred (native dep `expo-blur` + another rebuild + Android blur-quality risk). The gradient covers the need for now.
- **Light-mode** — addressed via per-scheme tokens + per-scheme fade opacities (commit 11). The light VALUES (pill tone, fade opacities, icon contrast) are eyeballed starting points; verify on a light skin and a couple of custom skins and nudge the per-scheme numbers if needed.
- **Custom skins** — the colour tokens flow through the skin-override path, so custom skins inherit correct surfaces. Fade opacities are scheme-binary (dark/light) only — a very low-contrast custom skin might want its own tuning, but none reported.
- **Merge gate**: `expo-navigation-bar` is native → don't merge until a rebuild is in the team's hands.

---

## Reusable patterns

The generalized "scroll-to-edge + bottom gradient + custom bar" recipe (for porting to other apps) is written up as a standalone tutorial: `<local tutorials folder>/react-native-edge-to-edge-floating-bar-and-bottom-fade.md`.

---
*Last updated: 2026-06-19*
