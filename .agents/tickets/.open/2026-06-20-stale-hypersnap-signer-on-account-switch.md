---
type: bug
title: "Stale Hypersnap signer when switching Farcaster accounts (connect A → disconnect → connect B)"
status: open
severity: low (pre-existing, likely self-heals)
created: 2026-06-20
found_by: edge-case review during profile-identity-switcher work
shared_change: none
pre_existing: true (same behavior on master)
---

# Stale Hypersnap signer / opt-in when connecting a different Farcaster account

## Scenario

1. User connects Farcaster account **A** and turns the Hypersnap signer **ON**
   (provisions a signer for A's FID; `optInChoice = 'opted-in'`).
2. User **disconnects** Farcaster (`handleDisconnectFarcaster` →
   `updateProfile({ farcaster: undefined })` only — matches master; we
   deliberately do NOT clear keys on disconnect).
3. User connects a **different** account **B** via the import form.

## What happens (traced in code)

- **Core FC keys are clean.** `handleImportFarcaster`
  (`components/ProfileModal.tsx` ~887-899) calls `storeFarcasterCustodyKey`,
  `storeFarcasterSignerKey`, `storeFarcasterFid`, `storeFarcasterAuthToken` —
  all `SecureStore.setItemAsync`, which **overwrites** A's values with B's. No
  A/B mixing for custody/signer/FID/token.

- **Hypersnap signer + opt-in are STALE.** The import flow never touches:
  - the Hypersnap **signer record** — `hypersnapSignerStore` is a single global
    `SIGNER_KEY` slot (NOT keyed by FID — see
    `services/farcaster/hypersnapAdapters.ts:26-38`). It still holds **A's**
    signer (provisioned for A's FID).
  - the **opt-in choice** (`hypersnap.optInChoice`,
    `services/farcaster/hypersnapOptIn.ts`) — still `'opted-in'`.

- **Result:** after connecting B, the Hypersnap switch shows **ON** for B, but
  the stored signer belongs to **A's FID**. The UI is momentarily misleading.

## Why it's low severity

`verifyLocalSigner` (`services/farcaster/hypersnapProvision.ts` ~88+) checks the
local signer pubkey against the FID's registered signers and returns `'absent'`
for a stale record, which should trigger a re-provision for B's FID on first
Hypersnap use. So it **likely self-heals** functionally; the only artifact is the
switch reading "on" before the first post/react re-provisions.

## Pre-existing

This is **not a regression** from the profile-identity-switcher work. Master's
disconnect also clears nothing, and the import flow is identical. We explicitly
chose to keep master's disconnect behavior (no key cleanup) this session.

## Clean fix (if/when wanted — NOT done now)

On a **successful import**, reset the Hypersnap state so B starts fresh:
```ts
await forgetHypersnapSigner();             // clears the global signer record
setHypersnapOptInChoice('unset');          // switch defaults OFF for B
```
Place this in `handleImportFarcaster` right after the new keys are stored. This
fires only when actually connecting an account (safer than clearing on
disconnect), and makes B start with the switch OFF + no stale signer. The
re-enable would then go through the normal Hypersnap opt-in path.

(Considered an in-app "re-enable Hypersnap" callout for this case but it's
unnecessary if we don't clear state — and if we DO add the reset above, the
normal opt-in prompt/switch already covers re-enabling.)

---
*Created: 2026-06-20*
