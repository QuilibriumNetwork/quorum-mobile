---
type: task
title: "Inbox message previews: replace emoji prefixes with app icons (Lucide/SVG)"
status: done
created: 2026-06-16
urgency: low (cosmetic, pre-existing)
shared_change: none
version_bump: none
runtime_test: required
supersedes: 2026-06-13-messagepreview-missing-call-types.md (the call-type GAP is folded in here)
---

# Inbox message previews should use app icons, not emoji

## Why this exists

`utils/messagePreview.ts` builds the one-line preview shown in the unified inbox
for each conversation's latest message. It currently prefixes media/event rows
with **raw emoji**:

- `🎨 Sticker` (`STICKER_PREFIX`)
- `📷 Image` / `📹 Video` (`EMBED_PREFIX` / `VIDEO_PREFIX`)

This violates the standing **"no emoji in production UI"** rule (use Lucide icons
for general UI, custom SVGs for domain symbols). The previews should render the
app's own icon next to the label instead of an emoji glyph.

> **Decision (user, 2026-06-16):** use our icons, not emoji, for these previews.
> Carved out as its own task because it's a UI/rendering change, not the simple
> string fix it first looked like (see "The real scope" below).

## Folds in: the call-type preview gap

While batching the profile-validation shared-migration work, the old task
`2026-06-13-messagepreview-missing-call-types.md` was going to be done inline —
but the only clean way to match the surrounding style was to add MORE emoji
(`📞 Voice call`), which the user correctly flagged. That fix is parked here
instead. The underlying gap is real and should ship WITH the icon change:

`messagePreview`'s `switch` falls through to `default: ''` for `call-event`,
`space-call-start`, and `space-call-end` — even though those ARE persisted and
render in the chat timeline. So an inbox row whose latest message is a call
shows an **empty** preview. Wording should mirror the chat renderer's
`getMessageText` (`components/Chat/types.ts` ~263-283): `Voice call` /
`Video call` (optionally with duration), `Voice call started` / `Video call
started`, `Call ended`.

## The real scope (why it's not a one-liner)

`messagePreview` returns a plain `string` today, and its callers render that
string directly as `<Text>`. To show an icon, EITHER:

- **Option A — change the return shape** to `{ icon?: IconName; text: string }`
  (or a small enum the caller maps to an icon), and update every call site to
  render the icon + text. Cleaner long-term, but touches all consumers.
- **Option B — return a small React node / element** from a sibling helper used
  only by the inbox row component, keeping `messagePreview` as the
  text-only fallback (e.g. notifications) and adding `messagePreviewWithIcon`
  for the row UI. Less invasive to non-UI callers.

Pick based on how many non-UI consumers `messagePreview` has (grep it first —
it's used by at least the unified inbox; check notifications / previews
elsewhere before changing the return type).

## What to do

1. Grep all `messagePreview(` call sites; classify UI (can render an icon) vs
   non-UI (needs a string).
2. Choose Option A or B above.
3. Map each previewed type to an app icon (sticker, image, video, **call**),
   reusing whatever icon component the rest of the app uses (Lucide via the
   shared `Icon`/`IconSymbol` shim, or a domain SVG). Match the chat timeline's
   own iconography for the same types where it has one.
4. Add the missing `call-event` / `space-call-start` / `space-call-end` cases
   with the icon + `getMessageText`-aligned wording.
5. Remove the `STICKER_PREFIX` / `EMBED_PREFIX` / `VIDEO_PREFIX` emoji constants.

## Acceptance criteria

- [ ] No emoji remain in `utils/messagePreview.ts` (or its icon-rendering sibling).
- [ ] Sticker / image / video / call previews show an app icon, not an emoji.
- [ ] A call-event / space-call inbox row shows a non-empty, sensible preview
      consistent with the chat timeline wording.
- [ ] Non-UI consumers (if any) still get a usable plain-text preview.

## Runtime test (required — UI change)

- Inbox row whose latest message is: a sticker, an image, a video, a voice call,
  a video call, a "call started", a "call ended" → each shows the right icon +
  label, no emoji.
- Confirm any notification / non-row consumer still renders correctly.

---
*Created: 2026-06-16 — carved out of the profile-validation batch after the
inline call-type fix would have added emoji against the no-emoji-in-UI rule.
Supersedes the call-type-only task; the gap is folded in here.*
