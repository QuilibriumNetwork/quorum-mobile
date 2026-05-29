# Quorum Mobile

The mobile app for **Quorum**, the world's first fully private and decentralized group messenger. Powered by Quilibrium and the libp2p stack, Quorum runs over TCP, QUIC, Websockets, or even LoRa — across the traditional internet, local networks, or off-grid setups.

This repository is the **React Native + Expo** mobile client (iOS and Android).

**Available Platforms:**

- **Mobile** - React Native + Expo (this repo)
- **Web Browser** - [Live app (beta)](https://app.quorummessenger.com/)
- **Desktop** - [quorum-desktop](https://github.com/QuilibriumNetwork/quorum-desktop) (Electron + web)

- [Official website](https://www.quorummessenger.com/) - [FAQ](https://www.quorummessenger.com/faq)

## Repository Ecosystem

Quorum is built as a **multi-repository ecosystem** where shared functionality is centralized:

| Repository | Purpose |
|------------|---------|
| **[quorum-mobile](https://github.com/QuilibriumNetwork/quorum-mobile)** | React Native + Expo mobile app (this repo) |
| **[quorum-desktop](https://github.com/QuilibriumNetwork/quorum-desktop)** | Web + Electron desktop app |
| **[quorum-shared](https://github.com/QuilibriumNetwork/quorum-shared)** | Shared types, hooks, sync protocol (`@quilibrium/quorum-shared`) |

All clients sync via the protocol defined in `quorum-shared`, so messages, bookmarks, and user settings stay in sync across devices.

## Setup and Development

### Prerequisites

- **Node.js v20.19.2** (see `.node-version`)
- **Yarn**
- For iOS: macOS with Xcode (Xcode 14.0-compatible project format — see `PREBUILD.md`)
- For Android: Android Studio with NDK
- A local clone of [`quorum-shared`](https://github.com/QuilibriumNetwork/quorum-shared) alongside this repo (referenced as `file:../quorum-shared` in `package.json`)

### Install

```bash
yarn install
```

### Run

```bash
yarn start              # Start Expo dev server
yarn android            # Build and run on Android
yarn ios                # Build and run on iOS
yarn web                # Start web version
```

### Code Quality

```bash
yarn lint               # Run ESLint
npx tsc --noEmit        # TypeScript type checking
```

### Cache Management

```bash
yarn clean              # Clear watchman, Metro, and temp caches
```

## Native Build Notes

- The committed `ios/` and `android/` directories are the **source of truth** for native projects — EAS reads them directly. Do not run `expo prebuild`; the npm script is aliased to print a warning and exit. See [`PREBUILD.md`](PREBUILD.md) for rationale and the safe-prebuild procedure if you genuinely need it.
- **Native crypto module** lives at `modules/quorum-crypto/` — a Rust-based encryption/signing module built with Nitro, with native implementations in `android/` and `ios/` subdirectories.

## Architecture Overview

- **Routing**: Expo Router (file-based, in `app/`)
- **State**: 3-tier — React Context (`context/`) for auth and connections, React Query for server state with MMKV persistence, MMKV (`react-native-mmkv`) for fast local storage
- **Sync**: `@quilibrium/quorum-shared` (types, hooks, sync protocol)
- **New Architecture**: Enabled (`app.json`)

