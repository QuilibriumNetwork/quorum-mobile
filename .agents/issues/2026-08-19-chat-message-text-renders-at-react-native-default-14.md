---
type: bug
title: Chat message body renders at React Native's default 14 with no line height
status: in-progress
created: 2026-08-19
updated: 2026-08-19
---

# Chat message body renders at React Native's default 14 with no line height

Reported from a Motorola Edge 50: message text reads noticeably smaller and more
cramped than Telegram and Discord showing the same paragraph.

## Summary

`messageText` in [MessagesList.tsx](../../components/Chat/MessagesList.tsx) set
**neither `fontSize` nor `lineHeight`**. React Native therefore applied its built-in
default of `14`
(`node_modules/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.cpp:183`
→ `textAttributes.fontSize = 14.0;`) and, with no `lineHeight`, the font's own leading
(≈1.15× for Roboto, so ≈16px).

This is not a device or pixel-density effect. RN font sizes are in density-independent
units, so 14 is the same physical size on every screen. The app also does not disable OS
font scaling anywhere (no `allowFontScaling={false}` in the repo), so the reporter was
seeing the true intended size at the default system font setting.

Both DMs and Space channels are affected: `DMChatArea` and `SpaceChatArea` both render
through the same `MessagesList`.

## Why this is a defect and not a design choice

Three independent signals, none of which depend on taste:

1. **The composer already uses 16/22.**
   [MessageInput.tsx:1501-1502](../../components/Chat/MessageInput.tsx#L1501-L1502). You
   type at 16 and the sent message renders at 14.
2. **Desktop renders the same content at 16/24.** `.message-post-content` in
   `quorum-desktop/src/styles/_chat.scss` sets no `font-size`, inheriting `:root` — browser
   default 16px with `line-height: 1.5` from `src/styles/_base.scss:14`. Mobile was ~12%
   smaller with ~30% tighter lines, against the stated parity goal.
3. **The emoji code already assumed 16.**
   [MentionableText.tsx:525](../../components/Chat/MentionableText.tsx#L525) and `:571` do
   `style?.fontSize || 16`. Because no size was set, that fallback was live — emoji-only
   messages scaled off 16 while the text beside them drew at 14.

## External reference points

| Source | Size | Line height | Ratio |
|---|---|---|---|
| **Was: Quorum mobile message body** | **14** | **~16 (font default)** | **~1.17** |
| Quorum mobile composer input | 16 | 22 | 1.38 |
| Quorum desktop message body | 16px | 24px | 1.5 |
| Telegram Android default (`SharedConfig.java:313`, `:603`) | 16sp | — | — |
| Material Design 3 Body Large (Compose `TypeScaleTokens.kt`) | 16sp | 24sp | 1.5 |
| iOS HIG Body | 17pt | 22pt | 1.29 |
| This repo's `textStyles.body` ([theme/fonts.ts:109](../../theme/fonts.ts#L109)) | 17 | 22 | 1.29 |

Telegram's constant is `AndroidUtilities.isTablet() && !AndroidUtilities.isFold() ? 18 : 16`,
i.e. 16 on phones — measured from the current `DrKLO/Telegram` source, not recalled.

## Fix

**16/22** — matches the composer exactly, matches desktop's 16, matches the Android
convention, and keeps a tighter ratio than desktop's 1.5 so a narrow phone column does not
lose messages per screen.

### The 17 detour, recorded so it is not repeated

16 was briefly raised to 17 and then returned to 16. The reasoning that produced 17 was:
the reporter judged 16 "slightly too small" and 18.4 "too big" at two different system font
scales, so ~17 sat between the brackets, and 17 is iOS HIG Body.

**That bracketing was measured against the wrong instrument.** Telegram was the yardstick,
and Telegram sizes through `dp()` rather than `sp()` — it never scales with the user's font
setting. Comparing a scale-respecting app to a scale-ignoring one, on a handset that is not
at scale 1.0, cannot converge: at any scale above 1.0 our text is larger than Telegram's for
*any* base that is correct at 1.0.

17 then read too large on device, because raising the token also raised the name beside every
message (see below), putting ~20px of prominent text on a 1.15 handset.

Lesson: calibrate a base size at scale 1.0, against the app's own composer and desktop —
not against a competitor on a non-default scale.

Changed, all in chat rendering:

- `messageText` → explicit `16/22`
- `linkText` → explicit `16/22` (a sibling `<Text>` in the `messageWithLink` row, so it
  inherits nothing and would otherwise have stayed at 14)
- `messageUser` → `14/20` → `16/22` (a name smaller than the message under it inverts the
  hierarchy; desktop's sender name likewise inherits the 16px body)
- `messageHeader.height` → `20` → `22`, so the fixed line box still holds the username
- markdown `heading` → `17` → `20/26`. The explicit `lineHeight` is required: headings
  render as `[baseTextStyle, styles.heading]`, so without it a 20px glyph keeps the body's
  22 line box.
- markdown `inlineCode` → `13` → `14`, `codeText` → `13` → `14/20`

## Deliberately not changed

- `messageTime` (12) and `replyIndicatorText` (12) — genuine caption sizes; 12 against a 16
  body is the standard hierarchy.
- Preview surfaces (pinned panel, bookmarks, search results) — smaller preview text there
  is intentional.
- **The font family.** `DEFAULT_FONT_FAMILY = 'System'` ([theme/fonts.ts:21](../../theme/fonts.ts#L21))
  → Roboto on Android, San Francisco on iOS, while desktop uses Inter. A real parity gap,
  but a minor one (Inter's x-height is only slightly above Roboto's) and not the cause of
  the reported smallness. Bundling Inter on mobile is a separate decision with its own
  tradeoffs (app size, loss of native feel; Telegram and WhatsApp use the system font,
  Discord bundles its own).
- **A user-facing font size setting**, Telegram-style. Worth doing, but it needs a persisted
  setting, settings UI, and threading through the chat renderers — its own task.

## Shipped alongside

Sizing alone would have left the app rendering in whatever font each Android OEM ships, so
the branch grew to cover that too — see
[2026-08-19-bundle-inter-and-tokenise-the-type-scale.md](2026-08-19-bundle-inter-and-tokenise-the-type-scale.md).
The two are one branch and one review; they are separate files only because one is a defect
and the other is work that did not exist before.

The sizes above now come from `theme.textStyles.body` / `.headline` rather than literals, so
a future retune is one line in [theme/fonts.ts](../../theme/fonts.ts).

## Status

Code change complete on branch `feat/bundle-inter-and-chat-typography`.

- `npx tsc --noEmit` — no errors in either changed file. The errors it does report
  (`app/explore.tsx`, `components/BrowserModal.tsx`, `services/calling/*`) are pre-existing
  and unrelated.
- `npx eslint` on both changed files — output byte-identical before and after the change
  (verified by stashing the diff and re-running). 4 pre-existing findings, 0 new.

**Confirmed on Android** (Motorola Edge 50, system font scale 1.15): 16/22 was reported as
looking good on device.

**Confirmed at Android's maximum font scale (1.3):** usernames render fully, no clipping.
That test also drove a real fix — `messageHeader` pinned its height to the same number as
the username's `lineHeight`, and React Native scales a lineHeight by the OS font scale but
never scales a container height, so the two diverged as the user raised their text size. The
height is now multiplied by `PixelRatio.getFontScale()`. This was pre-existing (master had
20 in a 20 box, the same 1:1 trap) but is materially worse on iOS, where Dynamic Type reaches
roughly 3x.

**iOS remains unverified** — no iOS device available to the reporter. Checklist item 15 in
[ios-verification-checklist.md](../docs/ios-verification-checklist.md) covers it.

### Testing gotcha worth remembering

Judging a size on a handset that is not at system font scale 1.0 wastes a lot of time. This
device also has a **Motorola-specific `device_font_scale` key** alongside Android's standard
`font_scale`; writing only the standard one leaves the Settings UI showing a stale value.
Both must be set together:

```
adb shell settings put system font_scale 1.0
adb shell settings put system device_font_scale 1.0
```

An app must be force-closed (not JS-reloaded) to pick up a scale change, because static
stylesheets read it once at creation.

---

*Last updated: 2026-08-19*
