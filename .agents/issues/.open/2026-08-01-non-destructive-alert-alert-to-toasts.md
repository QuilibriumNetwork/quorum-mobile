---
type: task
title: "Non-destructive feedback: move the remaining Alert.alert sites to toasts / themed dialogs"
status: open
priority: low
ai_generated: true
created: 2026-08-01
updated: 2026-08-01
---

# Non-destructive feedback: move the remaining `Alert.alert` sites off native alerts

> **⚠️ AI-Generated**: May contain errors. Verify before use.

## Read this first — the decision that is ALREADY MADE

**Destructive confirmations are done and are not in scope.** They were standardised in
`.agents/issues/.done/2026-06-13-destructive-operations-confirmation-standard.md`, shipped as
PR #93 (`c601fd1`). That work built `CenterModal`, `ConfirmDialog`, `TypeToConfirmModal` and
`useConfirmDialog`, and migrated every destructive `Alert.alert` (delete channel/group/role/
emoji/sticker, leave space, delete message, delete cast, remove device, reset DM sessions,
disconnect Farcaster, delete DM conversation).

That task considered — and **rejected** — keeping destructive confirms on native alerts. Do
not reopen it. Its decisive reasoning, preserved so nobody has to rediscover it:

> Native alerts *are* HIG-sanctioned for app destructive confirms — the "native-only-for-OS-
> stuff" intuition is **not** an actual platform rule. So native isn't *wrong*. **BUT**
> `Alert.alert`'s `destructive` style only colours the button red **on iOS**; on Android it
> renders as a plain neutral button, with no visual danger cue at all, and that is unfixable
> via the API. A standard whose whole job is making dangerous actions look dangerous cannot
> give half the userbase no red cue.

Note what that argument does *not* cover: it is specifically about **danger cues on
destructive actions**. It says nothing about the alerts this task is about, which are
informational. The weaker, honest argument for those is below — do not borrow the June
reasoning to justify this work, because it does not apply.

## What is actually left

187 `Alert.alert` calls across 42 files. Sampling every call's title shows they are
overwhelmingly **non-destructive feedback**, not confirmations:

| Title | Count | What it really is |
|---|---|---|
| `'Error'` | 62 | failure feedback |
| `'Copied'` | 8 | transient confirmation |
| `'Save failed'` | 4 | failure feedback |
| `'Success'` / `'Saved'` / `'Published'` / `'Vote posted'` / `'Transferred'` … | ~15 | transient confirmation |
| `'Sign in required'` / `'Permission Required'` / `'Publish skin?'` … | ~10 | genuine prompts |

Plus one native `ActionSheetIOS` left at `components/AudioSpaceOverlay.tsx:228`.

## Why it is worth doing (in honest order)

1. **A blocking modal for `'Copied'` is the wrong interaction.** Eight of these stop the app
   and demand a tap to acknowledge that a string reached the clipboard. Transient
   confirmations should not be modal at all.
2. **The app already has the right tool and uses it inconsistently.** `useToast`
   (`showToast({ type: 'error', title, message })`) is used in 18 files. **Nine files use
   BOTH** — the same file sometimes toasts a failure and sometimes blocks on a native alert:
   `app/(onboarding)/complete.tsx`, `components/Call/SpaceCallScreen.tsx`,
   `components/ProfileModal.tsx`, `components/ReportModal.tsx`,
   `components/SocialFeed/ProfileActionButtons.tsx`, `components/UserProfileModal.tsx`,
   `components/WalletModal.tsx`, `components/apex/ApexSubscribeModal.tsx`,
   `components/wallet/SwapModal.tsx`.
3. **The stock-OS-dialog seam.** Native alerts cannot carry the skin (fonts, danger token),
   which is the same seam the June task already called out.
4. **Mild, NOT the driver: iOS 26.** System alerts now render in Liquid Glass. That is
   *correct* for system dialogs and nobody has reported a problem with it. It is not a reason
   to do this work; it is only a reason not to add *new* native alerts. If this task's only
   argument were iOS 26, it should be closed unstarted.

## Scope

**In:**
- Non-destructive `Alert.alert` sites: errors, successes, "copied", info.
- The one remaining `ActionSheetIOS` call.

**Out — deliberately:**
- Destructive confirms. Done. See above.
- Native `Switch` (~30 uses). There is no in-app replacement and a native switch looking
  native is the correct outcome.
- `RefreshControl` (20 uses), text-selection menus, form controls, the keyboard. System
  surfaces where tracking the platform is right.
- Any ambition to "replace all native UI". That is how this sprawls.

## Routing rule to apply

| The alert is… | Becomes | Why |
|---|---|---|
| A transient success (`Copied`, `Saved`, `Published`, `Vote posted`) | `useToast` `type: 'success'` | non-blocking; nothing to decide |
| A failure the user cannot act on (`Error`, `Save failed`) | `useToast` `type: 'error'` | non-blocking; the action already failed |
| A failure that must stop a flow mid-step | `ConfirmDialog` (single action) | blocking is the point |
| A genuine prompt (`Sign in required`, `Publish skin?`) | `ConfirmDialog` | it asks a question |
| A menu of actions | `components/shared/ActionSheet` | already the standard |

The judgement call is row 2 vs row 3. Default to the toast; only block when losing the
message would leave the user believing something succeeded.

## Suggested slices (each ends in something observable on a device)

Do not do this as one 42-file sweep. Take the nine both-styles files first — they are where
the inconsistency is provable by using the app.

1. **Wallet flows** — `WalletModal`, `wallet/SwapModal`. Observable: copying an address, a
   failed swap, and a successful transfer all give consistent non-blocking feedback.
2. **Profile flows** — `ProfileModal`, `UserProfileModal`, `SocialFeed/ProfileActionButtons`.
   Observable: saving a profile, copying an address, a failed follow.
3. **Onboarding + calls** — `(onboarding)/complete.tsx`, `Call/SpaceCallScreen`.
4. **Report + Apex** — `ReportModal`, `apex/ApexSubscribeModal`.
5. **The remaining 33 files**, once the pattern is settled by 1–4.
6. **`AudioSpaceOverlay`'s `ActionSheetIOS`** → `components/shared/ActionSheet`.

## Verification

Each slice is verifiable on Android, which is the whole point — toasts and `ConfirmDialog`
are RN-rendered, so Android is a faithful preview. See
`.agents/docs/ios-ui-pitfalls-android-only-testing.md`.

A grep is the completion check: `grep -rn "Alert.alert" --include=*.tsx --include=*.ts app
components` should return only deliberate, documented survivors (if any).

## Related

- `.agents/issues/.done/2026-06-13-destructive-operations-confirmation-standard.md` — the
  settled destructive-confirm standard and its rationale
- `.agents/reports/2026-06-15-modal-link-row-audit-and-unified-component.md` — the audit
  `components/shared/ActionSheet.tsx` cites
- `.agents/issues/.done/2026-08-01-adopt-ios26-liquid-glass.md` — where the "own the surface"
  argument came from, and its limits

*Last updated: 2026-08-01*
