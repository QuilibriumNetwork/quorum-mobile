---
type: test-script
title: "PR #105 — profile validation: manual test script + copy-paste strings"
created: 2026-06-16
pr: 105 (feat/converge-profile-validation-to-shared)
---

# PR #105 manual test script

Reload Metro first (pure-JS change, no native rebuild). Limits: **display name ≤ 32 bytes**,
**bio ≤ 256 bytes**. A byte ≈ a character for plain ASCII; an emoji is ~4 bytes, an accented
letter ~2.

**Behavior to expect (two distinct mechanisms):**
- **Length** is a **silent hard cap by bytes** — the field simply won't accept more than 32/256
  bytes. No error for length; the input just stops (and a paste is trimmed to fit). This is
  intentional: editing long text on mobile is painful, so we cap instead of nagging. (Byte-accurate,
  so emoji/accents count correctly — unlike a plain character cap.)
- **Content rules** (`.q` suffix, impersonation, reserved names, XSS) **show a red live inline
  error** the moment they're violated, and **disable the Save button** until fixed. These can't be
  prevented by a length cap, so they get explicit feedback.

So: you will NOT see a "too long" error anymore (the cap prevents it). You WILL see errors for
`.q` / `admin` / `<script>` etc., with Save greyed out.

---

## WHERE to test — the 4 editors

| # | Editor | How to open |
|---|--------|-------------|
| 1 | **Onboarding profile** | Fresh account / import flow → "Profile Setup" step |
| 2 | **Global profile edit** (`UnifiedProfileEditModal`) | Your profile → tap a profile **card** in the header (Quorum or Farcaster side) → the edit modal opens. *(In split/unmerged profiles the card itself is the button — see the discoverability bug task.)* |
| 3 | **Your profile inline** (`ProfileModal`) | Where ProfileModal shows with its own header + an **Edit** (pencil) button. NOTE: in the main profile *route* the inline name field is hidden (`hideHeader`), so test name validation via editor #2; bio is testable here. |
| 4 | **Per-space profile** | Open a space → **Space Settings** → **Account** tab → "Display name" / "Bio" for this space |

The main one to test is **#2 (global edit)** — that's your real display-name + bio path.

---

## WHAT to test — copy-paste strings

For **each** editor above, paste each string into the matching field and confirm the result.

### Display name field

| Paste this | Expect |
|---|---|
| `Alice` | ✅ accepted, no error, saves |
| `this name is definitely way too long to fit` | 🔒 **silently capped** — only the first 32 bytes are kept; the field stops accepting more. No error. |
| `ada.q` | ❌ red "**A name ending in \".q\" is reserved for verified QNS names**" + Save disabled |
| `admin` | ❌ red "**That name is not allowed**" (impersonation) + Save disabled |
| `everyone` | ❌ red "**That name is reserved**" (mention-reserved) + Save disabled |
| `😀😀😀😀😀😀😀😀😀😀` (10 emoji) | 🔒 **capped at 8 emoji** (8 × 4 = 32 bytes); the 9th/10th won't enter. Proves BYTE-accurate capping, not char (a char cap would've allowed all 10). |
| `<script>x</script>` | ❌ red "**Display name cannot contain special characters**" (XSS) + Save disabled |
| *(clear the field, leave empty)* | ✅ no error — empty = "use my global/QNS name" (a deliberate clear) |

> The emoji row is the key one: the field should stop you at 8 emoji, not let you type 32 of them.
> That proves the cap counts bytes, not characters.

### Bio field

| Paste this | Expect |
|---|---|
| `Just a normal short bio.` | ✅ accepted, saves |
| *(paste the LONG ASCII block below — 300 chars)* | 🔒 **silently trimmed to 256 chars/bytes** on paste; no error |
| `<script>alert(1)</script>` | ❌ red "**Bio cannot contain special characters**" + Save disabled |
| *(clear the field, leave empty)* | ✅ no error — empty clears the bio |

**Long bio paste (300 chars — should be trimmed to 256 on paste):**

```
Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum
```

**Emoji bio byte test (paste this — should trim to 64 emoji = 256 bytes):**

```
😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀
```
(65 emoji × 4 bytes = 260 → trimmed to 64 emoji = 256 bytes.)

---

## Farcaster publish hard-block (only if the test user has a linked Farcaster account)

In editor #2, choose the **Farcaster** or **Both** scope, set an over-limit name or bio, Save.

- Expect: blocked **locally** with "Display name is too long" / "Bio is too long" **before any
  network call** — NOT an opaque error from Farcaster's servers.

---

## Per-space display-name CLEAR (cross-platform) — ⛔ CURRENTLY BLOCKED, do not run

This is the `honor-displayname-clear` (receive-side) half of the PR. It can only be observed
when **desktop → mobile delivery works**, and that path is currently broken by the known
**Symptom B** crypto wall (`bugs/2026-06-13-desktop-to-mobile-...md`). So this test is **not
runnable right now** — skip it; it's not a reflection of this PR.

When delivery is restored, the intended test is:
1. On **desktop**: set a per-space display name → **mobile** shows it on your member row.
2. On **desktop**: **clear** it (empty field) + save → **mobile reverts** to your global/QNS name.
3. A bio-only / avatar-only desktop edit does NOT wipe the mobile-stored name.

> **Separate known bug found 2026-06-16 (the SEND direction):** clearing a per-space name on
> **mobile** does NOT propagate to desktop — mobile strips the empty displayName on send. That's
> a different, pre-existing gap (the symmetric counterpart to this receive-side fix), filed at
> `issues/.done/2026-06-16-mobile-send-strips-empty-displayname-clear-not-propagated.md`. Not part of
> this PR; fix deferred to a focused follow-up.

---

## Quick pass/fail summary to report back

- [ ] #2 global edit: long name is silently capped at 32 bytes (emoji stops at 8); no "too long" error
- [ ] #2 global edit: ".q" / "admin" / "everyone" / "<script>" show the right live error AND grey out Save
- [ ] #2 global edit: long bio paste trims to 256; normal bio saves
- [ ] Save button is visibly disabled (greyed) while any content error is showing, re-enables when fixed
- [ ] Empty name / empty bio: no error (valid clear), Save enabled
- [ ] (#1, #3, #4) same behavior in onboarding / inline / per-space
- [ ] Farcaster scope: over-limit can't be entered (capped); content errors block save locally (if FC linked)
- [ ] Per-space clear reflects on mobile (if testable past Symptom B)

---
*Created: 2026-06-16 — for PR #105 manual testing.*
