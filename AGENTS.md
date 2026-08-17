# AGENTS.md

This is the **Quorum Mobile** repository — the React Native / Expo mobile client for Quorum messenger.

---

## Product Context

Quorum is a group messenger running on a decentralized P2P network with end-to-end encryption.

**Core hierarchy**:
- **Space** — top-level community (a server-like container)
- **Channel** — text channel inside a Space
- **DM** — direct messages, separate from Spaces
- **Space sidebar** — left-rail navigation between Spaces

**UX Philosophy**:
- **Familiar patterns first** — users expect conventional messenger behavior (navigation, message lists, reactions, mentions, threads). Lean on established mobile-messenger conventions rather than inventing new ones.
- **Intentional deviations only** — when the UI diverges from common patterns, the deviation should be documented and purposeful (accessibility, privacy defaults, P2P-specific affordances).

Beyond chat, the mobile app also ships:
- **Farcaster** integration (social feed, casts, DMs, mini-apps, Warpcast wallet import)
- **Wallet** (multi-chain: Bitcoin, Ethereum/viem, Solana, Polkadot, Kaspa)
- **QNS** (Quorum Name Service + marketplace)
- **Voice/video calls** (WebRTC, both DM and space calls)
- **In-app browser** (mini-app host runtime)
- **Governance** hooks

---

## Multi-Repository Ecosystem

Quorum is built as a **multi-repo ecosystem**. This repo is one of three:

| Repository | Purpose |
|------------|---------|
| **[quorum-desktop](https://github.com/QuilibriumNetwork/quorum-desktop)** | Web + Electron desktop app |
| **[quorum-mobile](https://github.com/QuilibriumNetwork/quorum-mobile)** | React Native + Expo mobile app (this repo) |
| **[quorum-shared](https://github.com/QuilibriumNetwork/quorum-shared)** | Shared types, hooks, sync protocol |

All clients sync data via `@quilibrium/quorum-shared`. **This repo consumes it as a pinned npm version** (see `package.json`), not as a local path — unlike desktop, which uses `link:../quorum-shared`. When implementing features, check if desktop has it and use shared types for sync compatibility.

**Full Guide**: [Quorum Ecosystem Architecture](.agents/docs/quorum-shared-architecture.md)

---

## Quick Start for AI Development

**IMPORTANT**: Before starting ANY task, check these files:

1. **[.agents/AGENTS.md](.agents/AGENTS.md)** — documentation workflow guidelines
2. **[.agents/INDEX.md](.agents/INDEX.md)** — find specific documentation for your task

**🔒 `.agents/issues/.secret/` — gitignored, never committed.** Issue write-ups that
describe an attack working against code users are running today (mechanism,
`file:line` pointers, vulnerable code, repro steps) are created in `.secret/` from
the start and kept out of `INDEX.md`. Ordinary reliability, data-loss and
correctness bugs are filed normally, however serious. Full rule and the release
procedure: [.agents/AGENTS.md](.agents/AGENTS.md) → "Security-sensitive issues".

---

## Commands

```bash
# Development
yarn start              # Start Expo dev server
yarn android            # expo run:android
yarn ios                # expo run:ios
yarn web                # expo start --web

# Code quality
yarn lint               # expo lint (ESLint 9, flat config)
npx tsc --noEmit        # TypeScript type checking

# Cache management
yarn clean              # Clear watchman, Metro, and temp caches
yarn reset-project      # scripts/reset-project.js
```

### Native build

- **Do NOT run `expo prebuild`.** The npm script is intentionally aliased to print a warning and exit non-zero. The committed `ios/` and `android/` folders are the **source of truth** (EAS reads them directly) and contain manual customizations (e.g. `QuorumNotificationService` target, App Group entitlements, pinned objectVersion) that are not declared in `app.json` and would be lost.
- If you genuinely need to prebuild, follow the snapshot/restore flow in [PREBUILD.md](PREBUILD.md) using `yarn prebuild:snapshot` and `yarn prebuild:restore`.
- EAS config: `eas.json`. App config: `app.config.js` + `app.json`.

---

## Repository Structure

```
quorum-mobile/
├── app/                        # Expo Router (file-based routing)
│   ├── (onboarding)/          # Onboarding flow
│   │   ├── index.tsx
│   │   ├── account-setup.tsx
│   │   ├── profile-setup.tsx
│   │   ├── privacy-setup.tsx
│   │   ├── farcaster-setup.tsx
│   │   └── complete.tsx
│   ├── (tabs)/                # Main tab navigator
│   │   ├── messages/          # DMs + spaces chat
│   │   ├── spaces/            # Space list / management
│   │   ├── feed/              # Farcaster feed
│   │   ├── wallet/            # Multi-chain wallet
│   │   ├── profile/
│   │   └── account/
│   ├── apps.tsx               # Mini-apps screen
│   ├── chat.tsx, explore.tsx, feed.tsx, settings.tsx, wallet.tsx
│   └── _layout.tsx            # Root layout with providers
│
├── components/                 # React components
│   ├── Chat/                  # Chat UI (MessagesList, ChannelHeader, EmojiPicker, etc.)
│   ├── Call/                  # Voice/video call UI
│   ├── SocialFeed/            # Farcaster feed components
│   ├── onboarding/
│   ├── qns/                   # Quorum Name Service UI
│   ├── wallet/                # Wallet UI
│   ├── shared/
│   ├── ui/                    # Themed primitives
│   └── *Modal.tsx             # Top-level modals (Space, Profile, Invite, MiniApp, etc.)
│
├── context/                    # React Context providers
│   ├── AuthContext.tsx        # User auth, encryption keys
│   ├── WebSocketContext.tsx   # E2E encrypted messaging transport
│   ├── ApiClientContext.tsx   # API client with auth
│   ├── CallContext.tsx        # DM calls
│   ├── SpaceCallContext.tsx   # Space calls
│   ├── OnboardingContext.tsx
│   ├── StorageContext.tsx     # MMKV
│   └── ToastContext.tsx
│
├── services/                   # Business logic
│   ├── api/                   # quorumClient, qnsClient, queryConfig
│   ├── crypto/                # Encryption, signing, native provider, space-session
│   ├── calling/               # WebRTC orchestration
│   ├── farcaster/             # Farcaster client/services
│   ├── miniapp/               # Mini-app host runtime
│   ├── media/                 # Image/audio handling
│   ├── notifications/         # Push + in-app notifications
│   ├── observability/         # Logging / telemetry
│   ├── offline/               # MMKV persistence for React Query
│   ├── onboarding/            # Key generation, secure storage
│   ├── profile/
│   ├── reporting/             # User/content reporting
│   ├── space/                 # Space-side logic
│   ├── storage/
│   ├── ui/
│   ├── wallet/                # Multi-chain wallet logic
│   ├── polyfills/             # RN polyfills (crypto, buffer, etc.)
│   ├── emojiFrecency.ts
│   └── farcasterClient.ts
│
├── hooks/                      # Custom hooks
│   ├── chat/                  # ~35 chat hooks (useMessages, useSpaces, useReactions, ...)
│   ├── useFarcaster*.ts       # Farcaster integration (feed, thread, profile, search, ...)
│   ├── useWallet*.ts          # Wallet, WalletSelection, WarpcastWallet
│   ├── useQNS*.ts             # QNS, QNSMarketplace, QNSPayment
│   ├── useUnifiedNotifications.ts, useGovernance.ts, useOTAUpdate.ts, ...
│
├── modules/quorum-crypto/      # Native Rust crypto module (Nitro)
├── plugins/                    # Expo config plugins
├── patches/                    # patch-package patches
├── scripts/                    # Repo scripts (reset, prebuild snapshot/restore)
├── theme/, constants/, utils/, data/, assets/, splash-assets/
│
└── .agents/                    # Development documentation
    ├── docs/                  # Architecture & feature guides
    ├── issues/                # Bugs AND tasks being worked on right now
    │   └── .secret/          # NEVER TRACKED - exploitable security detail
    └── INDEX.md
```

---

## @quilibrium/quorum-shared

Consumed as a **pinned npm version** — see the exact pin in `package.json`. Bump it with
`yarn add @quilibrium/quorum-shared@<version>`; list published versions with
`npm view @quilibrium/quorum-shared versions --json`.

> **Do not change this to `link:../quorum-shared`,** even though desktop uses that. The line is
> committed, so it travels to every branch, rewrites `yarn.lock` into a state that breaks a
> fresh `yarn install` for everyone else, and **EAS cloud builds cannot resolve it**. To test
> against unpublished shared changes, swap the package at the `node_modules` level only and
> leave `package.json`/`yarn.lock` untouched — full workflow in
> [.agents/docs/local-shared-dev-workflow.md](.agents/docs/local-shared-dev-workflow.md).

Import shared types, hooks, and utilities:

```typescript
// Types
import type { Space, Message, Channel, UserConfig } from '@quilibrium/quorum-shared';

// Utilities
import { logger } from '@quilibrium/quorum-shared';

// Sync utilities
import { SyncService, createMemberDigest } from '@quilibrium/quorum-shared';

// Hooks
import { useSpaces, useMessages } from '@quilibrium/quorum-shared';
```

**Full Reference**: [Quorum Ecosystem Architecture](.agents/docs/quorum-shared-architecture.md)

---

## Architecture

### Routing (Expo Router 6)
File-based routing in `app/`:
- `app/_layout.tsx` — root layout, provider stack (Theme → Query → Storage → Auth → API → WebSocket → Call/SpaceCall → Toast)
- `app/(onboarding)/` — grouped onboarding flow
- `app/(tabs)/` — main tab navigator (messages, spaces, feed, wallet, profile, account)
- Top-level screens: `chat`, `apps`, `explore`, `settings`, `wallet`, `feed`

**The in-app browser is not a route.** A single `BrowserModal` is mounted by
`MiniappOverlayProvider` (`app/(tabs)/_layout.tsx`) and opened via
`useMiniappOverlay()`, which keeps one WebView alive across navigation and
minimize. It takes `mode: 'link' | 'miniapp'` — `'link'` is a plain browser with
no SDK bridge and no wallet; `'miniapp'` is the Farcaster/Q app host. Open links
through `useOpenLink()` rather than either directly, so YouTube hand-off and
failure toasts stay consistent. (A duplicate `app/browser.tsx` route was deleted
on 2026-08-10; do not reintroduce one.)

### State Management (3-tier)
1. **React Context** (`context/`) — auth state, WebSocket, API client, calls, storage, toasts, onboarding
2. **React Query** (`@tanstack/react-query` 5) — server state with MMKV persistence for offline support (`services/offline/`)
3. **MMKV** (`react-native-mmkv` 4) — fast local storage for config, bookmarks, navigation state

### Native Crypto Module
`modules/quorum-crypto/` is a Rust-based cryptographic module using **Nitro Modules**:
- Encryption/decryption, key generation, signing
- TypeScript interface in `modules/quorum-crypto/src/`
- Native implementations in its own `android/` and `ios/` subdirectories
- Wired through `services/crypto/native-provider.ts` and `native-signing-provider.ts`

### Realtime / Sync
- E2E-encrypted messaging over WebSocket (`context/WebSocketContext.tsx`)
- Per-space encryption sessions in `services/crypto/space-session.ts`
- Sync protocol shared with desktop via `@quilibrium/quorum-shared`

### Calling
- WebRTC via `react-native-webrtc` 124
- DM calls: `context/CallContext.tsx` + `components/Call/`
- Space calls: `context/SpaceCallContext.tsx` + `SpaceCallBubble`

---

## Code Patterns

### Path Alias
Use `@/*` for imports (maps to project root):
```typescript
import { AuthContext } from '@/context/AuthContext';
```

### Component Organization
- Feature-based folders: `components/Chat/`, `components/Call/`, `components/SocialFeed/`, `components/wallet/`, `components/qns/`, `components/onboarding/`
- Modals as top-level files: `*Modal.tsx`
- Shared utilities in `components/shared/`, themed primitives in `components/ui/`

### Hooks Organization
- `hooks/chat/` — all chat operations (channels, messages, reactions, pinned, search, DMs, space activity, etc.)
- `hooks/useFarcaster*.ts` — Farcaster: feed, thread, profile, search, channels, notifications, Pro
- `hooks/useWallet*.ts`, `hooks/useQNS*.ts` — wallet + naming
- Cross-cutting hooks at hooks root (auth, network, theme, OTA, governance, ...)

---

## Tech Stack Snapshot

| Layer | Tech |
|-------|------|
| Framework | Expo SDK 54, React Native 0.81, React 19, New Architecture **on** |
| Router | Expo Router 6 |
| Lists | `@shopify/flash-list` 2 |
| State | React Context + TanStack Query 5 + MMKV 4 |
| Crypto | Rust via Nitro Modules; `@noble/*`, `viem`, Polkadot, Solana, Bitcoin, Kaspa libs |
| Realtime | Custom WebSocket, `react-native-webrtc` |
| Social | Farcaster (`@farcaster/miniapp-host-react-native`) |
| Animation | `react-native-reanimated` 4 + `react-native-worklets` |
| Notifications | `expo-notifications` + custom iOS Notification Service Extension |
| Lint | ESLint 9 flat config (`expo-lint`) |
| TypeScript | 5.9 |

---

## Configuration Notes

- **Node version**: v20.19.2 (see `.node-version`)
- **New Architecture**: enabled in `app.json`
- **Metro config**: custom resolver to prevent duplicate React / React Query instances (`metro.config.js`)
- **Babel**: see `babel.config.js`
- **patch-package** runs on `postinstall`; patches live in `patches/`
- **VSCode**: auto-organizes imports on save (see `.vscode/settings.json`)

---

## Development Checklist

- [ ] Check `.agents/INDEX.md` for existing documentation
- [ ] Check if feature exists in quorum-desktop (use shared types for sync)
- [ ] All hooks before any conditional return (React Rules of Hooks)
- [ ] Use `@quilibrium/quorum-shared` types for sync compatibility
- [ ] Never run `expo prebuild` directly — see PREBUILD.md
- [ ] Run `npx tsc --noEmit` and `yarn lint` before marking work complete
- [ ] **Touching navigation, headers, chrome or modals?** Read
      `.agents/docs/ios-ui-pitfalls-android-only-testing.md` first — the dev loop here is
      Android-only, and the native header is drawn by UIKit, so an Android run gives you
      zero signal on it. Add a pass/fail item to `.agents/docs/ios-verification-checklist.md`.

---

_Last updated: 2026-08-17_
