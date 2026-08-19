---
type: task
title: Bundle Inter, tokenise the reading surfaces, and guard the font rules
status: in-progress
created: 2026-08-19
updated: 2026-08-19
---

# Bundle Inter, tokenise the reading surfaces, and guard the font rules

Grew out of [2026-08-19-chat-message-text-renders-at-react-native-default-14.md](2026-08-19-chat-message-text-renders-at-react-native-default-14.md).
Fixing the message size exposed that a size number means nothing while the typeface is
whatever each handset happens to ship.

## Why

`DEFAULT_FONT_FAMILY` was `'System'` — San Francisco on iOS, and on Android whatever the OEM
ships. So the app rendered differently on every Android handset, and never matched desktop,
which has used Inter all along.

This is not theoretical. During the size investigation the reporter observed Quorum text
looking different from Telegram's at the same nominal size on the same screen, and the
typeface was one of the reasons the comparison would not settle.

## Static faces, not one variable font

Desktop ships a single variable Inter and sets `font-weight` numerically. Mobile cannot:

> "Variable fonts, including variable font implementations in OTF and TTF, do not have
> support across all platforms." ... "For full platform support, use static fonts."
> — Expo docs, *Fonts*

Corroborating: the official `@expo-google-fonts/inter` package ships **18 static instances
and no variable build**. And the font this branch deleted, `AtAeroVARVF.ttf`, was itself a
variable font sitting in the repo unreferenced.

So each weight is its own file and its own family name (`INTER_FACES` in
[theme/fonts.ts](../../theme/fonts.ts)). This is a genuine platform divergence from desktop,
not a shortcut.

Five faces ship: 400/500/600/700/900, ~334KB each, ~1.68MB total uncompressed. Weighed
against a 279MB installed APK that is 0.6%, so no weight was dropped to save space — dropping
900 would have left the theme advertising a `heavy` face that silently rendered as bold.

**600 is now first-class.** It is the app's most-used weight by a wide margin (137 call
sites) and the font map did not define it, so it was being satisfied by whatever the OS
considered nearest.

## Two font bugs that only exist once a font is bundled

Both are invisible to TypeScript and to unit tests. Both shipped during this work before the
check existed.

1. **Orphan weight** — a style block sets `fontWeight` with no `fontFamily`. Harmless under
   the platform font; with a bundled font that block silently stays on the DEVICE font while
   everything around it is Inter. **101 of these existed.** The visible symptom is two
   typefaces inside one card, which reads as "something looks off" rather than as a bug — it
   is exactly what made the Farcaster feed look wrong.
2. **Crossed pair** — `fontFamily` names one face and `fontWeight` names another, so the
   platform synthesizes the difference and Android draws smeared faux-bold.

`yarn check:fonts` ([scripts/check-fonts.js](../../scripts/check-fonts.js)) fails on either.
It reported 103 real problems on its first run and reports zero now, so it is a check that
can actually fail rather than a green light that means nothing.

## Tokenised reading surfaces

Sizes were literals (`Skin.font(17)`) scattered across call sites. Retuning the message size
took seven files and still missed one, leaving a Farcaster cast author name *smaller than the
cast beneath it*.

Now chat messages, casts, usernames and cast author names all spread
`theme.textStyles.body` / `.headline`. Changing the reading size is one line in
[theme/fonts.ts](../../theme/fonts.ts), and `headline` and `body` share a size deliberately
so a name can never drift below the text it heads.

## `Skin.fontFamily()`

Static `createSkinnable` stylesheets have no `theme` in scope, so they could only set a
weight — which is precisely how 59 of the orphans arose. `Skin.fontFamily()` in
[theme/skins/geometry.ts](../../theme/skins/geometry.ts) is the direct counterpart to the
existing `Skin.font()`, and returns the skin's single embedded face when one is active,
matching `makeFonts`.

## Loading

Joins the font gate the root layout already had for skins
([app/_layout.tsx](../../app/_layout.tsx)), so it runs concurrently with auth init rather
than adding a serial wait. It logs its own duration: the cost differs a lot between a release
build (faces in the app bundle) and dev (Metro serves them over the network), and without a
number those two are indistinguishable from a regression.

Failure is non-fatal by design — React Native falls back to the platform font, which is what
shipped before Inter existed here.

## Status

Complete on branch `feat/bundle-inter-and-chat-typography`.

- `npx tsc --noEmit` — 4 files report errors, all untouched by this branch
  (`app/explore.tsx`, `components/BrowserModal.tsx`, `services/calling/*`), identical to the
  pre-branch set.
- `yarn lint` — 300 errors, all pre-existing (278 are `@tabler/icons-*` imports in a
  generated registry, 21 JSX apostrophes, 1 missing display name). Verified by linting the
  pre-change files and comparing output.
- `yarn check:fonts` — green.
- **Regression audit**: filtering every font/style line out of the 70-file diff leaves only
  the `skinReady`→`fontsReady` rename, the added `ensureUiFontLoaded()` in the existing boot
  gate, and the `makeFonts`/`makeTextStyles` signature change. Nothing touches messaging,
  encryption, storage, sync, auth or navigation.

**Not measured:** the actual font load time on device. The loader logs it; the number was
never captured because the log buffer rolled over.

**Not verified:** iOS, and skins carrying an embedded font.

## Follow-up

An in-app text size setting, as Telegram, WhatsApp, Discord and Signal all ship. This
session is the argument for it: a base size correct at system scale 1.0 will always look
larger than a scale-ignoring competitor on a handset set above 1.0, and no single number
resolves that. The user should hold the last multiplier, not the yardstick.

---

*Last updated: 2026-08-19*
