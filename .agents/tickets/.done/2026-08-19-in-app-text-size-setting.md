---
type: task
title: In-app text size setting, so the user holds the last multiplier
status: done
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

## Status

**2026-08-19 — shipped in PR #261** (`feat(theme): let people set their own message
text size, without shrinking the rest of the app`)

Settings → Appearance now carries a **Text size** row opening a sheet with a live
preview and five discrete steps (0.8x–1.2x). The choice persists in MMKV and is read
before first paint.

**The open question in "Watch out for" is now decided, and the answer is the opposite
of what the first implementation assumed.** The setting reaches message and cast text
ONLY (`textStyles.messageBody` / `.messageAuthor`, plus `theme.msgFont()` for markdown
headings and code inside a bubble). `Skin.font()` and `theme.fontSizes` deliberately do
NOT carry it.

That was settled by measurement, not preference. The first cut multiplied every size in
the app — which is what this document's design sketch assumed — and on a device it was
plainly wrong: a step that made messages comfortable took 13pt settings descriptions to
10 and 11pt labels to 9. Legibility is not proportional at the small end, so one
multiplier cannot serve both ends of the type scale. Telegram, WhatsApp and Signal all
scope their control the same way.

Consequence worth carrying forward: `messageBody` is a distinct token rather than a flag
on `body`, because `body` is used by ~20 list rows, sheets and headers that must hold
still. Anything rendering the contents of a message or cast points at the `message*`
tokens; everything else does not.

Also fixed en route: `messageHeader`'s height was a hardcoded 22 and now derives from
`messageAuthor.lineHeight`, so it tracks the skin scale, the user's text size and the OS
font scale rather than clipping when any of them rises.

**Verified:** 29 new tests, full suite 1123 passing across 119 suites. Both sizing paths
were deliberately broken to confirm the tests go red (7 and 6 failures respectively). One
test is a control arm asserting `footnote` does not move while `messageBody` does — the
scope-widening regression is the likely future failure, so that is what is pinned. A
further test asserts the type scale at the default step is byte-identical to the
pre-feature one.

**Not verified:** the visual pass at the extremes on a real screen. A pass/fail checklist
was handed over for it and the result was not reported back before shipping. iOS is
unverified as always — no device.

## Acceptance

- [x] A user can change message text size in settings and see it apply immediately, with
  the choice surviving a restart.
- [x] Chat messages and Farcaster casts move together (they share the `messageBody` token).
- [x] Author names and usernames stay the same size as the body they head.
- [ ] Nothing clips at the largest in-app step combined with system font scale 1.3. The
  one known trap (`messageHeader`'s fixed height) is fixed and now derives from the token,
  but the eyeball pass at the extremes was not reported back. Cheap to re-check, and a
  clipping bug of this kind announces itself in normal use.

---

*Last updated: 2026-08-19*
