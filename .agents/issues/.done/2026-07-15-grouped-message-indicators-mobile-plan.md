---
type: task
title: "Implementation plan: per-message indicators on grouped (continuation) rows — MOBILE"
status: done
created: 2026-07-15
---

# Implementation plan: per-message indicators on grouped (continuation) rows — MOBILE

**Status:** DONE — shipped in mobile PR #149 (squash-merged to master `40332bb`, 2026-07-15).
Android-tested on the Edge 50 (display + flush-left alignment confirmed); iOS reasoned
via review. Final scope: `(edited)` + unsigned + spinner in a row below continuation
rows; pinned/bookmark deliberately omitted. Receipt-inline decision moved to the
DM-receipt-toggles task ([../2026-06-25-dm-receipt-toggles.md](2026-06-25-dm-receipt-toggles.md)).
**Branch:** `feat/grouped-message-inline-indicators`
**Created:** 2026-07-15
**Scope:** quorum-mobile only (desktop shipped first — see below)
**Design:** [2026-06-28-grouped-message-indicators-design.md](2026-06-28-grouped-message-indicators-design.md) (approved)
**Bug:** [2026-06-28-grouped-message-indicators-missing.md](2026-06-28-grouped-message-indicators-missing.md)
**Desktop reference (SHIPPED):** `quorum-desktop` PR #226 (docs) + #227 (code), merged 2026-07-15.

> Mobile is the higher-bar repo (atlas §2): needs an explicit **iOS review pass**
> (atlas §3) plus static verification (TS build + lint). Runtime-test on Android
> (Motorola Edge 50, reference device) before shipping.

---

## Goal (observable outcome)

In a grouped conversation (several consecutive messages from the same sender), each
**continuation row** shows its own per-message indicators in a small row below the
content. Today they're all dropped because the whole `messageHeader` View is hidden on
compact rows.

**How you'll verify it:** open a channel, send 3+ messages in a row from one account,
edit one → the edited continuation row shows `(edited)` below it; an unsigned sender's
continuation rows show the warning; first-in-group / standalone rows are visually
identical to before (no regression).

---

## Scope decision (mobile is DELIBERATELY simpler than desktop)

Desktop shows four indicators inline on continuation rows (edited, unsigned, pinned,
bookmark). **Mobile shows only two** — plus the sending spinner:

| Indicator | On continuation rows | Rationale |
|---|---|---|
| `(edited)` | **Show** — row below, item 1 | describes this message; no other surface |
| unsigned-warning | **Show** — row below, item 2 (same row, beside edited) | trust signal for this message; no other surface. Per-message, NOT per-group (mixed group where msg 1 is unsigned but 2–3 signed must not look uniformly signed) |
| sending spinner | **Show** — row below, when `isSending` | transient per-message feedback; currently ALSO dropped on compact rows (same bug). Restore it here |
| pinned | **Drop** | pinned messages have a dedicated pinned-list surface in the channel; per-row repetition is redundant noise |
| bookmark | **Drop** | bookmarks have a dedicated BookmarksPanel; same reasoning |
| receipt | N/A | mobile DM receipts aren't wired into rows yet |

This is a mobile simplification chosen by the developer (the lead's "desktop has more"
call is being made explicitly, not by oversight) — **note the divergence in the PR** so
it isn't mistaken for an incomplete port. `(edited)` and unsigned sit on ONE row below
the text (not stacked). Icons still can't flow inline in RN `<Text>` (SVG), so
"same line" = a tidy two-item row below the content, not inline-with-the-last-word.

---

## Key structural facts (verified against current mobile code)

1. **Three renderers hide the header on compact rows**, same `{!isCompact && (<View
   style={styles.messageHeader}>…</View>)}` pattern:
   - `renderPostMessage` — header [MessagesList.tsx:1079-1098](../../components/Chat/MessagesList.tsx#L1079)
     (pinned, `(edited)`, unsigned-warning, sending spinner)
   - `renderEmbedMessage` — header [MessagesList.tsx:926-932](../../components/Chat/MessagesList.tsx#L926)
     (user/time + unsigned-warning)
   - `renderStickerMessage` — header [MessagesList.tsx:995-1002](../../components/Chat/MessagesList.tsx#L995)

2. **A message can be both `isSending` and `isCompact`** (`isSending` computed at
   [~1037](../../components/Chat/MessagesList.tsx#L1037); `isCompact` at ~1069). Today the
   spinner lives in the header ([~1090](../../components/Chat/MessagesList.tsx#L1090)),
   hidden on compact rows — so a sending continuation row currently shows no spinner.
   The new row restores it.

3. Values already in scope per renderer: `isCompact`, `item.isEdited`,
   `item.originalMessage?.signature` (via `renderUnsignedWarning`), `isSending` (post
   renderer). Reused as-is: `editedIndicator` style (~1577), `renderUnsignedWarning`
   (~730), `sendingIndicator` style.

4. **Translate toggle interaction (mobile-specific).** Translatable messages render a
   "See translation" link below the text, inside the text renderer
   (`MentionableText.renderWithToggle` [~109-123](../../components/Chat/MentionableText.tsx#L109)).
   Our row renders after the `MessageRenderer` call, so it lands BELOW the translate link
   (`text → See translation → (edited) ⚠`). Accepted (zero translation-wiring changes);
   the compact + translatable + has-indicator intersection is rare.

5. One helper, not a component (mirrors desktop's "local node" call; zero reuse
   outside this file).

---

## Steps (each ends in something testable)

### Step 1 — `renderCompactIndicators` helper + style
Near `renderUnsignedWarning` (~730):
```tsx
// On compact continuation rows the whole header is hidden, dropping the per-message
// indicators. Reproduce the two that matter — (edited) + unsigned — on one small row
// below the content (pinned/bookmark deliberately omitted: they have dedicated
// surfaces). Include the sending spinner, also dropped on compact rows today.
// Returns null when empty so no stray row renders.
const renderCompactIndicators = useCallback(
  (item: DisplayMessage, opts?: { isSending?: boolean }) => {
    const isEdited = item.isEdited;
    const showUnsigned =
      item.renderType !== 'system' && item.renderType !== 'error' &&
      !item.originalMessage?.signature &&
      item.sendStatus !== 'sending' && item.sendStatus !== 'failed';
    const isSending = opts?.isSending;
    if (!isEdited && !showUnsigned && !isSending) return null;
    return (
      <View style={styles.compactIndicatorRow}>
        {isEdited && <Text style={styles.editedIndicator}>(edited)</Text>}
        {renderUnsignedWarning(item)}
        {isSending && (
          <ActivityIndicator size="small" color={theme.colors.textMuted}
            style={styles.sendingIndicator} />
        )}
      </View>
    );
  },
  [styles, theme, renderUnsignedWarning]
);
```
Add style near `editedIndicator` (~1577):
```tsx
compactIndicatorRow: {
  flexDirection: 'row',
  alignItems: 'center',
  marginTop: Skin.space(2),
},
```
- **Expected observation:** nothing yet (helper defined, not called).
- **Note:** `editedIndicator` carries `marginLeft:6` and `renderUnsignedWarning` too,
  so items space evenly without a container gap. `renderUnsignedWarning`'s `translateY:1`
  was tuned for a baseline header row — verify it sits level in this `center` row (may
  want 0); iOS pass. If `(edited)`'s leading `marginLeft:6` looks off as the first item,
  drop it or add a compact-variant style.

### Step 2 — Wire into `renderPostMessage`
Inside the content `View`, after the text/link block (~1147), before invite/farcaster:
```tsx
{isCompact && renderCompactIndicators(item, { isSending })}
```
Add `renderCompactIndicators` to the renderer dep array (~1186).
- **Test now (primary observable):** grouped text messages — edited row shows
  `(edited)` below; unsigned sender's rows show the warning; rapid 2nd send shows the
  spinner; first-in-group rows unchanged (header path).
- **Guard:** `isCompact &&` — first-in-group is not compact, so its indicators stay in
  the header (no double render).

### Step 3 — Wire into `renderEmbedMessage` + `renderStickerMessage`
Below the media, both branches (design rule 5):
```tsx
{isCompact && renderCompactIndicators(item)}
```
(no `isSending` — not the rapid-send path for media.) Add the helper to both dep arrays
(~977, ~1021).
- **Test now:** grouped image/embed + sticker as continuation rows from an unsigned
  sender, or edit one → indicator row below the media. Empty case renders nothing.

### Step 4 — Static verification
- `npx tsc --noEmit --jsx react-jsx --skipLibCheck` clean.
- `yarn lint` clean (watch exhaustive-deps on the three renderers).

### Step 5 — iOS review pass + Android runtime test (atlas §3)
We only runtime-test Android. Explicit iOS-divergence review:
- No native Modal / keyboard / safe-area / Switch / TextInput surface touched → low iOS
  risk. Main check: the `translateY:1` unsigned nudge in a `center` row on iOS.
- State in the PR: "iOS unverified — reasoned via review" (atlas §3).
- **Android runtime (Edge 50):** grouped channel (edited below, unsigned sender below,
  spinner on rapid send), grouped embed + sticker, first-in-group rows unchanged.

---

## Verification before calling it done
- TS build + lint clean.
- Grouped channel: `(edited)` + unsigned on a row below each affected continuation row;
  spinner on an in-flight continuation row; first-in-group + standalone rows
  byte-identical to before.
- Grouped embed + sticker: indicator row below media; empty case renders nothing.
- Pinned/bookmarked grouped messages show NO per-row indicator (by design).
- iOS review pass done + limits stated in the PR.

## Shipping
One mobile branch (`feat/grouped-message-inline-indicators`), one PR (atlas §2/§6).
Self-explanatory branch/PR name, no internal jargon (other devs don't read `.agents/`).
Purely additive to mobile; touches no shared/wire types → no shared publish, no
cross-device coordination. **PR must note the deliberate divergence from desktop**
(pinned/bookmark omitted on mobile rows — dedicated surfaces exist). Higher mobile bar
satisfied by: statically verifiable + Android runtime test + explicit iOS review.

## Follow-ups (NOT this slice)
- **Unsigned inline glyph spike** — try `'⚠︎'` tinted, screenshot on Edge 50 AND
  Samsung A40. If a clean tintable triangle on both → unsigned + `(edited)` could move
  inline (hug the last word). If either renders the color emoji / tofu → keep row-below.
- **DM receipts in mobile rows** — unwired (receive-side wiring not done); separate
  task. **When wired, receipts should be treated DIFFERENTLY from the other indicators:
  render them INLINE, hugging the last word (WhatsApp-style), NOT in the row-below
  group.** Reason: receipts (✓ delivered / ✓✓ read) appear on EVERY one of your own DM
  messages, so a row-below would fire on nearly every continuation row — including
  one-word messages — stacking `word / ✓✓ / word / ✓✓` and defeating grouping. The
  other indicators (edited/unsigned/pinned) are occasional, so row-below is fine; the
  receipt is omnipresent, so it must be inline. Implementation: use a **checkmark font
  glyph** (`✓` U+2713 / `✓✓`), which is text and flows inline natively — avoids the
  SVG-in-`<Text>` limitation that blocks the icon indicators. Plain checkmark glyphs are
  far safer than `⚠` (no aggressive emoji-presentation default) but still confirm the
  tinted monochrome render on Edge 50 + Samsung A40. Gate like desktop: own messages
  only, DMs only (not channels). Desktop reference: `receiptIndicator`,
  `Message.tsx` ~1084 (two `check` Icons for read, one for delivered).

*Last updated: 2026-07-15*
