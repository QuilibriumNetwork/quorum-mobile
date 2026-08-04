---
type: bug
title: "Channel icons don't appear to sync between mobile and desktop — icon-name vocabulary mismatch (not a sync bug)"
status: done
created: 2026-06-13
solved: 2026-06-22
severity: low
repo: quorum-mobile
resolution: "Fixed by PR #107 (merged 2026-06-17): mobile's ChannelIconPickerSheet now imports ICON_OPTIONS from @quilibrium/quorum-shared and defaults to 'hashtag' — i.e. it emits the SAME shared Tabler vocabulary desktop uses, so a channel icon picked on either platform renders on both. The broader full-IconSymbol migration (task 2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md, Phase 4) is a separate architectural cleanup, NOT this bug. Symptom confirmed gone by user 2026-06-22. Verified against merged PR + the import in ChannelIconPickerSheet.tsx, not the stale frontmatter."
root-cause: "The icon VALUE syncs fine inside the space manifest (same channel.icon / channel.iconColor field on both platforms). But mobile's IconPicker emits SF-Symbol-style names ('number', 'bell.fill', 'magnifyingglass') while desktop's IconPicker emits Tabler names ('hashtag', 'users', 'bell'). Each platform can't render the other's vocabulary, so a synced icon falls back to a default and looks like 'the change didn't sync'."
fix: "Unify the icon vocabulary across platforms — migrate mobile fully onto the shared quorum-shared Icon primitive (Tabler) so both apps pick from and render the same names. Tracked by task 2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md (Phase 2)."
related-solved: .solved/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md
related-task: 2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md
---

# Channel icons don't render cross-platform (vocabulary mismatch)

## Symptom

- Join a desktop-created space with channel icons -> icons appear on mobile (because
  the migration already made `IconSymbol` fail-soft + map many names).
- Change a channel icon on mobile -> does NOT reflect on desktop.
- Change a channel icon on desktop -> does NOT reflect on mobile.

Looks like a one-/no-direction sync bug. It is NOT. Lower priority than the
name/channel sync bugs, which now work both ways.

## Why it is NOT a sync bug

The icon rides inside the space manifest exactly like the channel name does. Names now
sync both ways (verified), and the icon uses the **same fields** on both platforms:
`channel.icon` + `channel.iconColor` (confirmed: desktop reads `channel.icon` in
`SpaceSettingsModal/Channels.tsx`, `ChannelItem.tsx`; mobile writes `icon`/`iconColor`
via `useUpdateChannel`). So the value travels. The render is the problem.

## Root cause (icon-name vocabulary mismatch)

Mobile and desktop pick from **different icon vocabularies**:

| Platform | IconPicker emits | Example values |
|---|---|---|
| Mobile | SF-Symbol-style names | `'number'`, `'bell.fill'`, `'magnifyingglass'`, `'sparkles'` (`components/ui/IconPicker.tsx`) |
| Desktop | Tabler names | `hashtag`, `users`, `bell`, `flame` (`quorum-desktop/.../IconPicker/types.ts`) |

When mobile saves `'bell.fill'` and desktop tries to render it as a Tabler name, there
is no match -> desktop shows its default. Vice versa: desktop saves `hashtag`, mobile's
`IconSymbol` has no Tabler mapping for it -> renders fallback. The live tell in the
Metro logs:

```
WARN  IconSymbol: no Tabler mapping for "hashtag", rendering nothing.
```

## Relationship to the already-solved crash bug

`.solved/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md` fixed the
**crash** (mobile threw on unknown icon names; now it fails soft + maps ~180 legacy
names). It did NOT unify the two pickers' vocabularies, so cross-platform icon
*rendering* still doesn't round-trip. This bug tracks that remaining gap.

## Fix direction (separate work)

Complete the migration so both platforms share ONE icon vocabulary via the shared
`Icon` primitive (Tabler) — including making mobile's IconPicker offer the same Tabler
names desktop offers, so a picked icon renders identically everywhere. Tracked by
task `2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md` (Phase 2 / call-site
sweep + picker vocabulary).

## Verification (once fixed)

- [ ] Pick a channel icon on mobile -> renders the same icon on desktop
- [ ] Pick a channel icon on desktop -> renders the same icon on mobile
- [ ] No `IconSymbol: no Tabler mapping` warnings for picker-offered icons

## Related

- Solved crash precursor: [.solved/2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md](2026-06-09-iconsymbol-throws-on-tabler-icon-names-from-desktop.md)
- Migration task: [2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md](../.deferred/2026-06-09-migrate-iconsymbol-to-shared-icon-primitive.md)
- Mobile IconPicker: `components/ui/IconPicker.tsx`
- Desktop IconPicker: `quorum-desktop/src/components/space/IconPicker/types.ts`

---

*Last updated: 2026-06-13*
