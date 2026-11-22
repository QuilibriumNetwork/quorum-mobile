---
type: task
title: "Unify date/time formatting across the app (shared-first)"
status: in-progress
created: 2026-07-15
---

# Unify date/time formatting across the app (shared-first)

**Status:** DONE (2026-07-16) — mobile leg implemented on `feat/unify-date-formats`, committed. Ready to ship.
**Owner branch (mobile):** `feat/unify-date-formats`.

> **Scope decision (2026-07-16, with user):** unify only the "when was this said" surfaces
> (chat messages, DM inbox list, spaces list, DM list). **Leave the two recency-signal surfaces
> alone** — the Farcaster feed (`SocialFeed/utils.ts`) AND the notifications tab
> (`app/(tabs)/profile/index.tsx`), both of which show sub-hour relative times (`5m ago`).
> Rationale: a feed/notification list wants "how fresh is this?" (`5m ago`); a conversation
> wants "when?" (`16:40` / `Monday`). Forcing one format onto the other makes it worse. If the
> feed↔list inconsistency ever matters, add an opt-in sub-hour mode to shared's
> `formatConversationTime` as a separate cross-repo task (Path C from the discussion).

> **UNBLOCKED 2026-07-16.** Shared `dateFormatting` is now published in `2.1.0-34`
> (npm `latest`). Verified against the published tarball: `formatMessageDate` and
> `formatConversationTime` (plus `describeMessageDate`/`describeConversationTime` and
> the label/options types) are all present in `dist/utils/dateFormatting.d.ts`. So the
> mobile leg is no longer publish-gated — bump `2.1.0-33`→`2.1.0-34`, install, then do
> the mobile call-site swaps below. (Do this when you start the task, not while parked
> on the current unrelated branch.)
Trigger: message timestamps showed the ambiguous locale numeric date (`28/6/2026 16:40`)
on an Italian device (`types.ts formatTime` "older" branch = `toLocaleDateString()`).

---

## Decisions (settled with user 2026-07-15)

1. **Two canonical formatters**, not one — message timestamps and list/row timestamps
   legitimately differ:
   - `formatMessageDate(ts, opts)` — per-message time inside a chat.
   - `formatConversationTime(ts, opts)` — list/row/feed timestamps.
2. **Lives in quorum-shared**, consumed identically by desktop + mobile. Desktop already
   has `src/utils/dateFormatting.ts` but it is NOT in shared, and NOT published.
3. **Shared-first order** (canonical, per `shared-publish-order-new-wire-type`):
   shared → publish → desktop → **mobile LAST**. Desktop can consume shared from source
   without waiting for publish; mobile waits for the npm publish.
4. **Clock = locale-driven** (12h/24h per device via `Intl`/dayjs locale) for BOTH apps.
   This CHANGES desktop's current hard-coded `HH:mm` to locale — intended.
5. **i18n = caller passes labels.** Shared stays i18n-agnostic: the formatter takes an
   optional `labels` object (`{ today, yesterday, at }`) defaulting to English. Desktop
   passes lingui `t\`\`` strings; mobile passes its own i18n. Weekday + relative strings
   localize via the dayjs locale already set by each app.

## API shape (FINAL — structured, reworked 2026-07-15)

Shared owns CALENDAR LOGIC, apps own WORDING. Shared exports:
- `describeMessageDate(ts)` → union: `{kind:'time',time}` | `{kind:'yesterday',time}` |
  `{kind:'weekday',weekday}` | `{kind:'relative',relative}`.
- `describeConversationTime(ts)` → `{kind:'time',time}` | `{kind:'daysAgo',days}` |
  `{kind:'shortDate',date}`.
- String helpers `formatMessageDate(ts,{labels?,compact?})` (labels: `today`,`yesterday`,
  `yesterdayAt:(time)=>string`) and `formatConversationTime(ts)` for simple callers.
Why structured, not label-composing: don't bake "Yesterday at X" word order into shared
(wrong for some locales). Apps compose the sentence with their own i18n.

## Format spec

`formatMessageDate(ts, { labels?, compact? })`:
- Today → locale time (`14:45` or `2:45 PM`)
- Yesterday → `{yesterday} {at} 14:45` (e.g. "Yesterday at 14:45")
- Last week → weekday (`Monday`, via dayjs `dddd`)
- Older → relative (`3 days ago`, `2 months ago`, via dayjs `fromNow`)
- `compact` (mobile list use): today→`{today}`, yesterday→`{yesterday}`, else weekday/relative

`formatConversationTime(ts)`:
- Today → locale time
- 1–6 days → `1d`…`6d`
- Same year → `Jun 28` (dayjs `MMM D`)
- Older year → `Jun 28, 2025` (dayjs `MMM D, YYYY`)

## Shared building blocks already present
- `quorum-shared/src/utils/dayjs.ts` — dayjs w/ utc, timezone, relativeTime, calendar
  plugins extended. NOT re-exported from index (new util imports it relatively — fine).
- Shared has NO `@lingui/core` → cannot use `t\`\`` in shared (hence "caller passes labels").

---

## Steps

### 1. quorum-shared (DONE — merged + PUBLISHED in 2.1.0-34, verified 2026-07-16)
- [x] Add `src/utils/dateFormatting.ts` with `formatMessageDate` + `formatConversationTime`.
      Locale-driven clock via `Intl.DateTimeFormat` (NOT dayjs `LT` — localizedFormat
      plugin isn't extended in shared's dayjs). Labels via optional param, English
      defaults. No lingui.
- [x] Export from `src/utils/index.ts` barrel (`export * from './dateFormatting'`).
- [x] 12 vitest cases — all pass. dist gitignored in shared (built on publish).
- [x] PR: https://github.com/QuilibriumNetwork/quorum-shared/pull/55 (branch
      `feat-unified-date-formatting`). Commit `feat(utils): add locale-driven message and
      conversation date formatters`.
- [x] **DONE: shared merged + published in `2.1.0-34`** (npm `latest`; `formatMessageDate`
      + `formatConversationTime` verified in the published dist 2026-07-16). Mobile step 3
      is unblocked. Note: pre-existing `Input.native.tsx` TS error in shared is unrelated.

### 2. quorum-desktop (DONE — PR open)
- [x] Desktop `src/utils/dateFormatting.ts` is now a thin shim over shared's string
      helpers, binding lingui labels (`yesterdayAt` keeps the phrase translatable as one
      unit). `(ts, compact)` signature preserved → no call-site changes. Clock now
      locale-driven (intended). `formatMuteRemaining` untouched.
- [x] Typechecks clean against the linked shared build.
- [x] PR: https://github.com/QuilibriumNetwork/quorum-desktop/pull/228 (branch
      `consume-shared-date-formatters`). Desktop consumes shared via `link:` — no publish wait.

### 3. quorum-mobile (DONE — `feat/unify-date-formats`, 2026-07-16)
Dep was already at `2.1.0-34` (installed, formatters verified in dist). Added
`utils/dateFormat.ts` (binds English labels once → `formatMessageTime` + `formatRowTime`).
- [x] `components/Chat/types.ts` `formatTime` → shared `formatMessageDate` (via `formatMessageTime`).
      Drives BOTH DM and Space per-message time (the reported bug). Callers unchanged.
- [x] `app/(tabs)/messages/index.tsx` `formatRelativeTime` → `formatRowTime` (`formatConversationTime`).
- [x] `app/(tabs)/spaces/index.tsx` inline formatter → `formatRowTime`.
- [x] `components/Chat/DirectMessagesList.tsx` `formatRelativeTime` → `formatRowTime`.
- [~] `components/SocialFeed/utils.ts` `formatTimestamp` (+ dup in `SocialFeedModal.tsx`) —
      **LEFT AS-IS** (Path A decision: feed keeps `5s/3m/2h` recency format). De-dup not done
      (out of scope; both copies keep the feed format). Track separately if desired.
- [~] `app/(tabs)/profile/index.tsx` `formatTime` — **LEFT AS-IS.** It's the unified
      notifications tab (Farcaster + Quorum), same recency-signal UX as the feed → keeps
      `just now / Nm ago / Nh ago`. (Task originally guessed "conversation"; corrected to
      recency to match the feed decision — user agreed 2026-07-16.)
- [x] Mobile-localized (English) labels passed via `utils/dateFormat.ts`.
- [x] Local formatter bodies now delegate (names kept, one call site each — minimal diff).
- [x] Verified: 0 new tsc/lint errors. Runtime: easy to eyeball (just look at timestamps).

## Open question for the feed — RESOLVED (Path A, 2026-07-16)
Feed keeps its own `5s/3m/2h` sub-hour format; NOT moved to the shared conversation format.
Same for the notifications tab. Rationale in the Scope decision at the top.

## Survey snapshot (mobile, 2026-07-15) — the 6 formatters found
| Site | fn | today | yest | week | older |
|---|---|---|---|---|---|
| msg (DM+Space) | types.ts formatTime | 4:40 PM | Yesterday at 4:40 PM | — | **28/6/2026 16:40** |
| inbox list | messages/index formatRelativeTime | 4:40 PM | Yesterday | Mon | 28/6/2026 |
| spaces list | spaces/index inline | 4:40 PM | — | Mon | 28/6/2026 |
| DM list | DirectMessagesList formatRelativeTime | 4:40 PM | Yesterday at 4:40 PM | — | 28/6/2026 16:40 |
| feed+casts | SocialFeed/utils + SocialFeedModal (dup) | 5s/3m/2h | | | Jun 28 |
| profile | profile/index formatTime | 4:40 PM | Yesterday | | Jun 28 |

*Last updated: 2026-07-16 — UNBLOCKED: shared date formatters published in 2.1.0-34.*
