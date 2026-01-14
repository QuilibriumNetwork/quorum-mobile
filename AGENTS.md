# AGENTS.md

This is the **Quorum Mobile** repository - the React Native/Expo mobile app for Quorum messenger.

---

## Product Context: Discord Clone

**Quorum is a Discord clone** running on a decentralized P2P network with end-to-end encryption. The UI/UX intentionally mirrors Discord to ease migration for users leaving Discord.

| Discord Term | Quorum Term | Notes |
|--------------|-------------|-------|
| Server | Space | Same hierarchical structure |
| Channel | Channel | Text channels within Spaces |
| DM | DM | Direct messages, separate from Spaces |
| Server list | Space sidebar | Left rail navigation |

**UX Philosophy**:
- **Mirror Discord patterns** - Users expect familiar behavior (navigation, message lists, reactions, mentions, etc.)
- **Mobile Discord app as benchmark** - When implementing UI, reference Discord mobile
- **Intentional improvements only** - Deviations from Discord should be documented and purposeful (better accessibility, privacy defaults, P2P optimizations)

---

## Multi-Repository Ecosystem

Quorum is built as a **multi-repo ecosystem**. This repo is one of three:

| Repository | Purpose |
|------------|---------|
| **[quorum-desktop](https://github.com/QuilibriumNetwork/quorum-desktop)** | Web + Electron desktop app |
| **[quorum-mobile](https://github.com/QuilibriumNetwork/quorum-mobile)** | React Native + Expo mobile app (this repo) |
| **[quorum-shared](https://github.com/QuilibriumNetwork/quorum-shared)** | Shared types, hooks, sync protocol |

All clients sync data via `@quilibrium/quorum-shared`. When implementing features, check if desktop has it and use shared types for sync compatibility.

**Full Guide**: [Quorum Ecosystem Architecture](.agents/docs/quorum-shared-architecture.md)

---

## Quick Start for AI Development

**IMPORTANT**: Before starting ANY task, check these files:

1. **[.agents/AGENTS.md](.agents/AGENTS.md)** - Documentation workflow guidelines
2. **[.agents/INDEX.md](.agents/INDEX.md)** - Find specific documentation for your task

---

## Commands

```bash
# Development
yarn start              # Start Expo dev server
yarn android            # Build and run on Android
yarn ios                # Build and run on iOS
yarn web                # Start web version

# Code quality
yarn lint               # Run ESLint
npx tsc --noEmit        # TypeScript type checking

# Cache management
yarn clean              # Clear watchman, Metro, and temp caches
```

---

## Repository Structure

```
quorum-mobile/
├── app/                    # Expo Router pages (file-based routing)
│   ├── (onboarding)/      # Onboarding flow screens
│   ├── _layout.tsx        # Root layout with providers
│   └── index.tsx          # Main chat interface
│
├── components/             # React components
│   ├── Chat/              # Chat UI (MessagesList, ChannelHeader, etc.)
│   ├── SocialFeed/        # Farcaster feed components
│   ├── onboarding/        # Onboarding UI
│   └── *Modal.tsx         # Modal components
│
├── context/                # React Context providers
│   ├── AuthContext.tsx    # User auth, encryption keys
│   ├── WebSocketContext.tsx # E2E encrypted messaging
│   └── ApiClientContext.tsx # API client with auth
│
├── services/               # Business logic
│   ├── crypto/            # Encryption, signing, native provider
│   ├── onboarding/        # Key generation, secure storage
│   ├── api/               # API client, React Query config
│   └── offline/           # MMKV persistence
│
├── hooks/                  # Custom React hooks
│   ├── chat/              # Chat operations (useMessages, etc.)
│   └── useFarcaster*.ts   # Farcaster integration
│
├── modules/quorum-crypto/  # Native Rust crypto module (Nitro)
│
└── .agents/                # Development documentation
    ├── docs/              # Architecture & feature guides
    ├── tasks/             # Task tracking
    ├── bugs/              # Bug reports
    └── reports/           # Analysis & audits
```

---

## @quilibrium/quorum-shared

Import shared types, hooks, and utilities from the shared package:

```typescript
// Types
import type { Space, Message, Channel, UserConfig } from '@quilibrium/quorum-shared';

// Utilities (most common)
import { logger } from '@quilibrium/quorum-shared';

// Sync utilities
import { SyncService, createMemberDigest } from '@quilibrium/quorum-shared';

// Hooks
import { useSpaces, useMessages } from '@quilibrium/quorum-shared';
```

**Full Reference**: [Quorum Ecosystem Architecture](.agents/docs/quorum-shared-architecture.md)

---

## Architecture

### Routing (Expo Router)
File-based routing in `app/` directory:
- `app/_layout.tsx` - Root layout with providers (Theme → Query → Storage → Auth → API → WebSocket)
- `app/(onboarding)/` - Grouped onboarding flow screens
- `app/index.tsx` - Main chat interface

### State Management (3-tier)
1. **React Context** (`context/`) - Auth state, WebSocket connections, API client
2. **React Query** - Server state with MMKV persistence for offline support
3. **MMKV** (`react-native-mmkv`) - Fast local storage for config, bookmarks, navigation state

### Native Crypto Module
`modules/quorum-crypto/` contains a Rust-based cryptographic module using Nitro:
- Provides encryption/decryption, key generation, signing
- TypeScript interface in `modules/quorum-crypto/src/`
- Native implementations in `android/` and `ios/` subdirectories

---

## Code Patterns

### Path Alias
Use `@/*` for imports (maps to project root):
```typescript
import { AuthContext } from '@/context/AuthContext';
```

### Component Organization
- Feature-based: `components/Chat/`, `components/SocialFeed/`, `components/onboarding/`
- Modals as top-level components: `*Modal.tsx`
- Shared utilities in `components/shared/`

### Hooks Organization
- `hooks/chat/` - Chat operations (useChannels, useMessages, useSendDirectMessage, etc.)
- `hooks/useFarcaster*.ts` - Farcaster integration hooks

---

## Configuration Notes

- **Node version**: v20.19.2 (see `.node-version`)
- **New Architecture**: Enabled in `app.json`
- **Metro config**: Custom resolver to prevent duplicate React/React Query instances
- **VSCode**: Auto-organizes imports on save (see `.vscode/settings.json`)

---

## Development Checklist

- [ ] Check `.agents/INDEX.md` for existing documentation
- [ ] Check if feature exists in quorum-desktop (use shared types for sync)
- [ ] Follow React Hooks rules (all hooks before conditional returns)
- [ ] Use `@quilibrium/quorum-shared` types for sync compatibility

---

_Last updated: 2026-01-14 (added Discord clone context)_
