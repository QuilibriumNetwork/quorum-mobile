---
type: task
title: "Recovery Key Export — surface both phrase and private key, honestly"
status: open
created: 2026-07-16
---

# Recovery Key Export — surface both phrase and private key, honestly

**Date:** 2026-07-16
**Status:** proposed (design for review)
**Area:** `components/ProfileModal.tsx` — Account section
**Type:** UX redesign (`feat:` / `style:`), self-contained, no storage/crypto/onboarding changes

---

## Problem

In Settings → profile modal, the "Export Recovery Key" flow shows **different things to different users** and never explains why:

- Users whose account was **created** in-app, or **imported from a seed phrase**, see a **12/24-word recovery phrase**.
- Users who **imported from a raw hex private key** see a **hex private key**.

Root cause (confirmed): `handleExportRecoveryPhrase` at `ProfileModal.tsx:816-834` tries `getMnemonic()` first and silently falls back to `getPrivateKey()`. The account genuinely determines the format:

| Onboarding flow | Stored | Can show phrase? |
|---|---|---|
| Create new account (`OnboardingContext.tsx:322-323`) | mnemonic + private key | ✅ |
| Import from mnemonic (`OnboardingContext.tsx:355-356`) | mnemonic + private key | ✅ |
| Import from hex private key (`OnboardingContext.tsx:510`) | private key only | ❌ (no BIP-39 reverse from Ed448 — see `keyService.ts:86`) |

### Why the current UX is bad
1. **"Recovery Key" is vague** — not "phrase", not "private key". Users can't build a mental model or compare notes ("why does mine look different from my friend's?"). This is the origin of the confusion that prompted this task.
2. **The app silently chooses.** A phrase-account user who *wants* the raw hex key (to import the account into another Quilibrium tool) can't get it. And the choice is invisible.
3. **No explanation of the asymmetry.** A hex-import user has no idea their account is structurally different — it reads as a bug, not a fact.

### Hard constraint
**Accounts are not symmetric.** Hex-import accounts have no phrase and never can. The design must NOT offer a phrase button that lies (disabled/empty). It must surface **what the account actually holds**, name each artifact precisely, and explain the difference.

---

## Design

Capability-aware Account section. On modal open, resolve `hasMnemonic` once (a single `getMnemonic()` check, lifted out of the export handler). This drives which controls render. **No secret is fetched or shown until the user explicitly taps and confirms** — same security posture as today.

### A. Account HAS a mnemonic (majority: created / phrase-imported)

Primary export = recovery phrase. Private-key export = a **clearly-labeled** secondary disclosure (per user: the label must say plainly it's the private key in hex, not just "Advanced").

```
Account

  [ 🔑  Export Recovery Phrase              › ]     ← primary

  ▸ Export private key (hex format)                 ← secondary disclosure row
      For importing this account into other
      Quilibrium tools. Most people should use
      the recovery phrase above instead.
      [ Show Private Key (hex) ]
```

- Disclosure row text names the artifact ("Export private key (hex format)") — no bare "Advanced".
- Expanded body explains WHAT it is and WHEN you'd want it.
- Tapping either action → existing confirm dialog (copy tailored per artifact, see D) → existing reveal panel.

### B. Account has ONLY a private key (hex-import)

No phrase exists, so don't pretend. Show the hex export directly + an honest one-liner.

```
Account

  [ 🔑  Export Private Key (hex)            › ]

  ⓘ This account was imported from a private key,
    so it has no recovery phrase.
```

### C. Reveal panel (reused as-is)
The existing reveal (`AccountRecoverySection`, `ProfileModal.tsx:4257-4293`) already renders word-grid vs hex-block correctly and has Copy/Hide. Keep it. Only the *entry points* and *labels* change.

### D. Confirmation copy — tailor per artifact
Current single dialog says "recovery key". Split:
- **Phrase:** "Your recovery phrase is the only way to restore your account. Never share it. Make sure no one is looking at your screen." → confirm "Show Phrase"
- **Private key:** "This is your raw private key. Anyone with it has full control of your account. Never share it. Make sure no one is looking at your screen." → confirm "Show Key"

---

## Implementation (all in `ProfileModal.tsx`)

1. **State** (near `:449-451`): add `hasMnemonic: boolean | null`, resolved on modal open via `getMnemonic()` (length ≥ 12 gate, matching existing logic). Keep existing `showRecoveryPhrase` / `recoveryPhrase` / `hexPrivateKey`.

2. **Split the handler** (`:805-836`): replace single `handleExportRecoveryPhrase` with:
   - `handleShowRecoveryPhrase()` → confirm (phrase copy) → `getMnemonic()` → set `recoveryPhrase`, clear `hexPrivateKey`, reveal.
   - `handleShowPrivateKey()` → confirm (key copy) → `getPrivateKey()` → set `hexPrivateKey`, clear `recoveryPhrase`, reveal.
   Removes the implicit fallback — user chooses, app never substitutes.

3. **`AccountRecoverySection`** (`:4229-4297`): accept `hasMnemonic` + both handlers + a local `showAdvanced` state. Render branch A or B per §Design. Reuse existing reveal panel unchanged.

4. **Styles** (~`:3474-3571`): add a disclosure row style + expanded-body description text + the info-line for the hex-only case. Follow existing `Skin.space/font/radius` + theme tokens. No arbitrary values.

### Out of scope / non-goals
- No changes to key storage, derivation, or onboarding.
- Does not "add" a phrase to hex-import accounts (impossible).
- No shared-package dependency → shippable mobile-side immediately.

---

## Verification (behaviour — device testable)
1. **Created/phrase account:** Account section shows "Export Recovery Phrase" primary + collapsed "Export private key (hex format)" row. Expanding shows explanation + button. Both reveal correctly after confirm; Copy/Hide work.
2. **Hex-import account:** shows "Export Private Key (hex)" + the info line; no phrase button anywhere.
3. Confirm-dialog copy matches the artifact being revealed.
4. No secret is fetched before confirm (verify with a log in each handler, or reason from code).

## Open follow-up (separate, not this task)
Some *created* accounts could theoretically show hex if their mnemonic write failed while the private key survived (`ensurePrivateKey` re-derives key-from-mnemonic, never the reverse). If real hex-display reports come from users who *created* (not imported) accounts, that's a mnemonic-loss bug, not this UX issue — investigate with targeted logging separately.

---
*Last updated: 2026-07-16*
