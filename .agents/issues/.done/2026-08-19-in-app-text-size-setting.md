---
type: task
title: In-app text size setting, so the user holds the last multiplier
status: open
created: 2026-08-19
updated: 2026-08-19
---

# In-app text size setting, so the user holds the last multiplier

Follow-up to [2026-08-19-chat-message-text-renders-at-react-native-default-14.md](../2026-08-19-chat-message-text-renders-at-react-native-default-14.md)
and [2026-08-19-bundle-inter-and-tokenise-the-type-scale.md](../2026-08-19-bundle-inter-and-tokenise-the-type-scale.md).

## Why, and why this is not a nice-to-have

PR #260 spent a long session trying to find one message size that felt right. It did not
converge, and the reason is structural rather than a failure of taste:

- React Native sizes in `sp`, so our text **scales with the user's system font setting**.
- Telegram sizes through `dp()` (`Theme.java` → `chat_msgTextPaint.setTextSize(dp(SharedConfig.fontSize))`),
  so **its text never scales**.
- The reporter's handset sits at scale **1.15**, not 1.0.

On that device, Quorum is 15% larger than Telegram for *any* base that is correct at scale
1.0. The only way to match Telegram there is to ship a base that shortchanges every user at
1.0. There is no number that satisfies both, so the argument recurs every time someone looks.

Evidence it recurs: across one session the same reader called 16 "slightly too small" at
scale 1.0 and 18.4 "too big" at 1.15 — the same person, the same eyes, two settings.

**Every major messenger reached the same conclusion.** Telegram ships a size slider
(default 16, range 12–30, `SharedConfig.fontSize`). So do WhatsApp, Discord and Signal. They
did not do it for fun; they did it because the system font scale is a blunt instrument
applied to every app at once, and people want separate control over the app they read most.

## Design sketch

The groundwork is already in: the reading surfaces resolve through
`theme.textStyles.body` / `.headline` ([theme/fonts.ts](../../theme/fonts.ts)), and
`makeTextStyles` already takes a scale argument that a skin's `fontScale` flows through. A
user preference is a second multiplier into the same place, not a new mechanism.

1. **Persist a preference.** MMKV, alongside the appearance preference read synchronously at
   boot in [app/_layout.tsx](../../app/_layout.tsx) — it must be available before first paint
   or text renders at the default and reflows.
2. **Feed it into `makeTextStyles`.** It already multiplies; the user's factor composes with
   the skin's `fontScale`. Do NOT add a second scaling path.
3. **Settings row** with a live preview of a real message, not an abstract slider. The whole
   difficulty in #260 was judging a number in the abstract.
4. **Range.** Telegram uses 12–30 on a 16 base, i.e. roughly 0.75x–1.9x. Something like
   0.85–1.3 in a few discrete steps is probably right here; discrete steps beat a continuous
   slider because they are reproducible when someone reports a problem.

## Watch out for

- **`Skin.font()` is a separate path.** Many sizes still go through it rather than the type
  scale, so a naive implementation will scale message text and leave everything around it
  fixed — exactly the "author name smaller than the cast" bug from #260, at a larger scale.
  Decide deliberately whether the setting affects only the reading surfaces (Telegram's
  behaviour) or all text.
- **Fixed-height containers.** `messageHeader` was pinned to a literal and clipped as text
  scaled; it now multiplies by `PixelRatio.getFontScale()`. A user multiplier is a *second*
  source of growth that `getFontScale()` does not know about, so that fix does not
  automatically cover it. `yarn check:fonts` does not catch this class — consider extending
  it, or grep for `height: Skin.font(`.
- **Do not remove system font-scale support.** Honouring the OS setting is an accessibility
  requirement; the in-app control is additive.

## Acceptance

- A user can change message text size in settings and see it apply immediately, with the
  choice surviving a restart.
- Chat messages and Farcaster casts move together (they share the `body` token).
- Author names and usernames stay the same size as the body they head.
- Nothing clips at the largest in-app step combined with system font scale 1.3.

---

*Last updated: 2026-08-19*
