---
type: bug
title: "Onboarding QR import is very slow (~2 min) and freezes the UI on step 2"
status: open
created: 2026-06-13
severity: medium-high
repo: quorum-mobile
area: onboarding / account import
---

# Onboarding QR import is very slow (~2 min) and freezes the UI

Lead dev is taking care of this

> Observed live 2026-06-13 while re-importing the test user via QR. Not fixed this session — this report captures the diagnosis + the instrumentation needed to debug it properly next time.

## Symptoms (observed)

1. After scanning the QR code, the app shows **"Importing account" for ~2 minutes** before advancing.
2. **Step 2 (farcaster-setup) is frozen for ~1 more minute** — nothing is clickable.
3. Tapping **"Skip"** on step 2: after ~10s the screen *tries* to swipe to step 3, **fails**, and stays on step 2.
4. Eventually it **unfreezes and moves on**.

The freeze pattern (taps queue but don't execute until work finishes) is the classic signature of **heavy synchronous work on the JS thread** blocking the React Native event loop.

## What the QR contains

The QR payload is a bare hex string (~114 hex chars = 57 bytes = a raw **Ed448 private key**). No seed, no config blob. Decoded in `components/onboarding/QRScannerView.tsx:34-55` → `handleImportHex` (`app/(onboarding)/account-setup.tsx:80`) → **`importFromHex`** (`context/OnboardingContext.tsx:504-577`).

## Diagnosis: three slow operations, all effectively on the JS thread

### 1. JS-only Decaf448 scalar multiplication (prime suspect for the CPU freeze)
`importFromHex` → `keyPairFromHex` (`services/onboarding/keyService.ts:337-353`) → `deriveQuilibriumAddressFromPrivateKey` (`keyService.ts:251-263`) calls `deriveDecaf448PublicKey` **twice** (`keyService.ts:219-227`):

```ts
const point = decaf448.Point.BASE.multiply(
  BigInt('0x' + bytesToHex(scalarBytes)) % decaf448.Point.Fn.ORDER
);
```

This is **448-bit elliptic-curve scalar multiplication in pure JS BigInt**, running on Hermes (no BigInt JIT). Two of them, synchronous, blocking the JS thread. On mobile this can be hundreds of ms to seconds each — **no native fallback** (the native QuorumCrypto module is used for other ops but NOT this derivation).

### 2. Three sequential network calls (no parallelism)
`importFromHex` (`OnboardingContext.tsx:514-527`) awaits in strict sequence:
`uploadUserRegistration` (internally: `fetchUserRegistration` GET → Ed448 sign → `uploadRegistration` POST) → then `getConfig` (`getUserSettings` GET). Three serial round-trips; if any is slow or **times out** (check the quorum client's default timeout — a ~60s timeout on a failing call could alone explain a 2-min hang), the spinner stalls.

### 3. Post-signIn deferred block REPEATS the heavy work (the "step 2 freeze")
After `signIn`, `AuthContext` runs a deferred block (`context/AuthContext.tsx:237-364`, after a deliberate 500ms delay) that does, in parallel:
- `uploadUserRegistration` **again** (Ed448 sign + 2 network round-trips),
- `getConfig` **again** (network GET + Ed448 verify + AES-GCM decrypt),
- Farcaster token refresh + optional pfp fetch.
Plus, if the config has spaces, `getConfig` schedules `syncSpacesFromConfig` (`services/config/spaceSyncService.ts:261-285`) which processes spaces **sequentially with a forced `1000ms` sleep between each** (`DELAY_BETWEEN_SPACES_MS`). N spaces = at least N-1 seconds of sleep + per-space network/crypto. This deferred block is what freezes step 2.

The code even acknowledges the freeze: `AuthContext.tsx:235-237` comment "Defer heavy background tasks to not block UI rendering / These operations involve crypto and network calls that can freeze the UI."

### 4. Observability gap (why it's invisible)
`services/config/configService.ts` and `services/config/spaceSyncService.ts` emit **zero log statements** and swallow errors in empty `catch {}` blocks. The Decaf448 derivation also logs nothing. So the entire 2-minute window produces almost no `ReactNativeJS` logcat output — confirmed in the 2026-06-13 capture (36k logcat lines, but only a camera warning + MMKV opens from the app). **You cannot currently measure the crypto-vs-network split from logs.**

## Ranked hypotheses for the 2-minute import

1. **JS Decaf448 BigInt scalar mult (2×)** blocking the JS thread — strongest code evidence; explains the UI freeze specifically.
2. **A network call timing out** (~60s default?) — would explain "2 minutes" better than crypto alone if crypto is only a few seconds. CHECK the quorum client timeout config.
3. **Sequential network round-trips** (3 in import + 2 more in the deferred block, done twice total) on a slow connection.
4. **`syncSpacesFromConfig` 1s-per-space sleep** if the test user has several spaces — adds seconds-to-minutes to the step-2 freeze.

## Suggested instrumentation (do this FIRST next session — JS-only, just a Metro reload, NO native rebuild)

Add timestamped `[perf]` logs to make the split measurable. Wrap each operation with start/end + elapsed ms:

```ts
// helper
const t0 = Date.now(); logger.warn(`[perf] <label> start`);
// ...operation...
logger.warn(`[perf] <label> done ${Date.now() - t0}ms`);
```

Instrument these exact points:
- `context/OnboardingContext.tsx` importFromHex: around `keyPairFromHex` (line ~508), around `initializeEncryptionKeys` (~514), around `uploadUserRegistration` (~515), around `getConfig` (~527). One `[perf]` pair each.
- `services/onboarding/keyService.ts`: inside `deriveQuilibriumAddressFromPrivateKey` (~251) — wrap the two `deriveDecaf448PublicKey` calls (this isolates the pure-JS crypto cost, the #1 suspect).
- `services/onboarding/keyService.ts` `uploadUserRegistration` (~687): time `fetchUserRegistration` vs `uploadRegistration` separately (isolates which network call).
- `services/config/configService.ts` `getConfig` (~297): time `getUserSettings` (network) vs `verifyConfigSignature` vs `decryptConfig` separately. (Also ADD logs here generally — this file is silent.)
- `services/config/spaceSyncService.ts` `syncSpacesFromConfig` (~261): log space count + per-space elapsed + total. (Also silent today.)
- `context/AuthContext.tsx` deferred block (~237): time the whole block + each of encryptionTask / configTask / tokenTask.
- **Check + log the quorum client HTTP timeout** (find the fetch/axios config in `services/api/quorumClient.ts`) — if it's ~60s, a single failing call explains the 2 min.

Then re-onboard once and read the `[perf]` lines via logcat (`adb logcat -v time | grep "\[perf\]"`).

## Likely fixes (decide AFTER measuring)

- If Decaf448 dominates: move `deriveDecaf448PublicKey` into the **native** QuorumCrypto module (Rust), or at minimum run it off the JS thread / chunked so the UI doesn't freeze. (Native change → rebuild.)
- If network dominates: parallelize the independent calls (`Promise.all`), and stop the **double** work — the deferred `AuthContext` block repeats `uploadUserRegistration` + `getConfig` that `importFromHex` already did. De-duplicate.
- If `syncSpacesFromConfig` sleep dominates: reconsider the `1000ms` per-space delay (or do it truly in the background without blocking step 2).
- Regardless: **add the missing logging** to configService/spaceSyncService permanently (the observability gap is its own bug).

## Capture reference
2026-06-13 logcat capture: `<local temp>/onboarding-log.txt` (36,764 lines; app pid 26356, package `com.quilibrium.quorummobile.debug`). Confirms near-zero app JS logging during the slow window.

---

*Last updated: 2026-06-13*
