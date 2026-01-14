---
type: doc
title: Quorum Ecosystem Architecture
status: done
created: 2026-01-14
updated: 2026-01-14
---

# Quorum Ecosystem Architecture

This document provides a comprehensive guide to the Quorum multi-repository ecosystem and the `@quilibrium/quorum-shared` package that connects them.

---

## Table of Contents

1. [Ecosystem Overview](#ecosystem-overview)
2. [Repository Structure](#repository-structure)
3. [Cross-Repo Feature Development](#cross-repo-feature-development)
4. [Package Structure](#package-structure)
5. [Types Module](#types-module)
6. [Storage Adapter](#storage-adapter)
7. [Sync Protocol](#sync-protocol)
8. [React Query Hooks](#react-query-hooks)
9. [Utilities](#utilities)
10. [Crypto and Signing](#crypto-and-signing)
11. [Transport Layer](#transport-layer)
12. [Mobile Integration](#mobile-integration)
13. [Usage Examples](#usage-examples)

---

## Ecosystem Overview

Quorum is built as a **multi-repository ecosystem** where shared functionality lives in a central package consumed by both web/desktop and mobile applications.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        QUORUM ECOSYSTEM                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                    ┌────────────────────────────┐                        │
│                    │   @quilibrium/quorum-      │                        │
│                    │         shared             │                        │
│                    │                            │                        │
│                    │  • Types & Interfaces      │                        │
│                    │  • Sync Protocol           │                        │
│                    │  • React Query Hooks       │                        │
│                    │  • Storage Adapter         │                        │
│                    │  • Crypto & Signing        │                        │
│                    │  • Utilities               │                        │
│                    └────────────┬───────────────┘                        │
│                                 │                                        │
│                    ┌────────────┴───────────────┐                        │
│                    │                            │                        │
│                    ▼                            ▼                        │
│     ┌──────────────────────────┐  ┌──────────────────────────┐          │
│     │   quorum-desktop         │  │    quorum-mobile         │          │
│     │                          │  │    (this repo)           │          │
│     │                          │  │                          │          │
│     │  • Web app (Vite)        │  │  • React Native          │          │
│     │  • Desktop (Electron)    │  │  • Expo                  │          │
│     │  • IndexedDB storage     │  │  • MMKV storage          │          │
│     │  • Web primitives        │  │  • Native primitives     │          │
│     └──────────────────────────┘  └──────────────────────────┘          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Principle: Data Sync Across Clients

All clients (desktop, web, mobile) sync data via the **same protocol** defined in `quorum-shared`. This means:
- A message sent from mobile appears on desktop (and vice versa)
- User config, bookmarks, read states sync across devices
- Features implemented on one platform should use shared types/hooks to ensure sync compatibility

---

## Repository Structure

### GitHub Repositories

| Repository | URL | Purpose |
|------------|-----|---------|
| **quorum-desktop** | `github.com/QuilibriumNetwork/quorum-desktop` | Web + Electron desktop app |
| **quorum-mobile** | `github.com/QuilibriumNetwork/quorum-mobile` | React Native + Expo mobile app (this repo) |
| **quorum-shared** | `github.com/QuilibriumNetwork/quorum-shared` | Shared types, hooks, sync protocol |

### What Lives Where

| Code Type | Location | Notes |
|-----------|----------|-------|
| **Shared types** | `quorum-shared` | Space, Message, User, etc. |
| **Shared hooks** | `quorum-shared` | useSpaces, useMessages, etc. |
| **Sync protocol** | `quorum-shared` | Hash-based delta sync |
| **Storage interface** | `quorum-shared` | `StorageAdapter` interface |
| **Storage implementation** | Each app | MMKV (mobile) / IndexedDB (desktop) |
| **UI primitives** | Each app | Platform-specific (React Native / Web) |
| **Business components** | Each app | Built on shared hooks + local primitives |

---

## Cross-Repo Feature Development

### When Implementing a Feature

Before implementing a feature, check:

1. **Does quorum-shared have the types?**
   - If yes → import and use them
   - If no → feature may need types added to shared first

2. **Does quorum-desktop already have this feature?**
   - Browse: `github.com/QuilibriumNetwork/quorum-desktop`
   - Check `src/` for similar components/hooks
   - If desktop has it → ensure your implementation uses same shared types for sync

3. **Will data need to sync?**
   - If yes → must use shared types and storage adapter interface
   - Bookmarks, read states, user config, messages all sync

### Checking Desktop Implementation

To inspect a feature on desktop:

```
https://github.com/QuilibriumNetwork/quorum-desktop/tree/main/src
```

Key directories to check:
- `src/components/` - UI components
- `src/hooks/` - Custom hooks (may have features not yet on mobile)
- `src/services/` - Business logic services
- `src/adapters/` - Storage adapters

### Feature Parity Checklist

When porting a feature from desktop to mobile:

- [ ] Identify the feature in `quorum-desktop`
- [ ] Check if it uses `quorum-shared` types/hooks
- [ ] Implement using same shared types for sync compatibility
- [ ] Test that data syncs correctly between platforms
- [ ] Document in `.agents/tasks/` if significant

---

## Package Details

The `@quilibrium/quorum-shared` package provides cross-platform functionality shared between `quorum-desktop` and `quorum-mobile`. It centralizes:

- **Type definitions** for consistent data structures across apps
- **Storage interface** for platform-agnostic persistence
- **Sync protocol** for hash-based delta synchronization between peers
- **React Query hooks** for data fetching and caching
- **Utilities** for common operations (logging, formatting, validation)
- **Crypto/Signing** for E2E encryption and message authentication

### Package Info

| Property | Value |
|----------|-------|
| **Package** | `@quilibrium/quorum-shared` |
| **Version** | 2.1.0 |
| **Peer Dependencies** | React 18+, TanStack React Query 5+ |
| **Build Format** | Dual ESM/CJS with TypeScript declarations |

---

## Package Structure

```
@quilibrium/quorum-shared/src/
├── api/           # API client interface and errors
├── crypto/        # E2E encryption (WASM-based)
├── hooks/         # React Query hooks for data fetching
├── signing/       # Ed448 signing (WASM-based)
├── storage/       # Platform-agnostic storage adapter interface
├── sync/          # Hash-based delta synchronization protocol
├── transport/     # HTTP and WebSocket communication
├── types/         # Comprehensive type definitions
└── utils/         # Formatting, validation, encoding, logging
```

---

## Types Module

The types module provides all shared type definitions used across both apps.

### Space Types

| Type | Description |
|------|-------------|
| `Space` | Complete space with groups, channels, roles, emojis, stickers |
| `Channel` | Channel within a group (with permissions, icons, pinning) |
| `Group` | Group containing channels |
| `Role` | Role with permissions and member list |
| `Permission` | `'message:delete' \| 'message:pin' \| 'user:kick' \| 'mention:everyone'` |
| `Emoji` | Custom emoji definition |
| `Sticker` | Custom sticker definition |

### Message Types

| Type | Description |
|------|-------------|
| `Message` | Full message with content, reactions, mentions, signature |
| `PostMessage` | Regular text message content |
| `EditMessage` | Message edit content |
| `ReactionMessage` | Emoji reaction |
| `PinMessage` | Pin/unpin action |
| `JoinMessage`, `LeaveMessage`, `KickMessage` | Membership events |
| `EventMessage`, `EmbedMessage`, `StickerMessage` | Special content types |

### User Types

| Type | Description |
|------|-------------|
| `UserProfile` | User display info (name, icon, status) |
| `UserConfig` | User preferences, space memberships, bookmarks |
| `SpaceMember` | User's membership in a space with roles |
| `NavItem` | Navigation item (space or folder) |
| `NotificationSettings` | Per-space notification preferences |

### Other Types

| Type | Description |
|------|-------------|
| `Conversation` | DM conversation (direct or group) |
| `Bookmark` | Bookmarked message reference with cached preview |

---

## Storage Adapter

The `StorageAdapter` interface provides platform-agnostic storage operations.

### Interface Overview

```typescript
interface StorageAdapter {
  // Initialization
  init(): Promise<void>;

  // Spaces
  getSpaces(): Promise<Space[]>;
  getSpace(spaceId: string): Promise<Space | null>;
  saveSpace(space: Space): Promise<void>;
  deleteSpace(spaceId: string): Promise<void>;

  // Messages
  getMessages(params: GetMessagesParams): Promise<GetMessagesResult>;
  getMessage(params): Promise<Message | undefined>;
  saveMessage(...): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;

  // Conversations
  getConversations(params): Promise<{ conversations; nextCursor }>;
  getConversation(conversationId: string): Promise<Conversation | undefined>;
  saveConversation(conversation: Conversation): Promise<void>;

  // User Config
  getUserConfig(address: string): Promise<UserConfig | undefined>;
  saveUserConfig(userConfig: UserConfig): Promise<void>;

  // Space Members
  getSpaceMembers(spaceId: string): Promise<SpaceMember[]>;
  getSpaceMember(spaceId, address): Promise<SpaceMember | undefined>;
  saveSpaceMember(spaceId: string, member: SpaceMember): Promise<void>;

  // Sync metadata
  getLastSyncTime(key: string): Promise<number | undefined>;
  setLastSyncTime(key: string, time: number): Promise<void>;

  // Optional sync-specific queries
  getMessageDigests?(spaceId, channelId): Promise<MessageDigest[] | undefined>;
  getMemberDigests?(spaceId): Promise<MemberDigest[] | undefined>;
  getTombstones?(spaceId, channelId): Promise<DeletedMessageTombstone[]>;
}
```

### Mobile Implementation

Mobile uses MMKV-based storage adapter:

```typescript
// services/offline/storage.ts
import type { StorageAdapter } from '@quilibrium/quorum-shared';
import { MMKV } from 'react-native-mmkv';

export class MMKVStorageAdapter implements StorageAdapter {
  private storage: MMKV;

  // Methods wrap MMKV to conform to shared interface
}
```

---

## Sync Protocol

The sync module implements hash-based delta synchronization for efficient data transfer between peers.

### Protocol Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SYNC PROTOCOL STEPS                               │
├─────────────────────────────────────────────────────────────────────┤
│  1. sync-request (broadcast)                                         │
│     → Send SyncSummary with manifestHash to discover peers           │
│                                                                      │
│  2. sync-info (response)                                             │
│     → Peers with different data respond with their summary           │
│                                                                      │
│  3. sync-initiate (to best candidate)                                │
│     → Send full manifest (per-message digests)                       │
│                                                                      │
│  4. sync-manifest (response)                                         │
│     → Peer responds with their manifest for comparison               │
│                                                                      │
│  5. sync-delta (chunked)                                             │
│     → Exchange only missing/updated messages                         │
│     → Includes member and peer map deltas                            │
│     → Final chunk marked with isFinal flag                           │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Types

| Type | Description |
|------|-------------|
| `SyncSummary` | Compact hash + counts for quick comparison |
| `SyncManifest` | Per-message digests for precise diff |
| `MessageDigest` | Hash of message content for comparison |
| `MemberDigest` | Hash of member data for comparison |
| `SyncDeltaPayload` | New/updated/deleted items to transfer |
| `DeletedMessageTombstone` | Record of deleted messages for sync |

### Key Functions

```typescript
// Create digests for comparison
createMessageDigest(message: Message): MessageDigest
createMemberDigest(member: SpaceMember): MemberDigest
createManifest(digests: MessageDigest[]): SyncManifest

// Compute differences
computeMessageDiff(local, remote): MessageDiffResult
computeMemberDiff(local, remote): MemberDiffResult

// Hash utilities
computeHash(data: string): string
computeManifestHash(manifest: SyncManifest): string
```

### SyncService

```typescript
import { SyncService } from '@quilibrium/quorum-shared';

const syncService = new SyncService({
  storage: storageAdapter,
  maxMessages: 1000,
  requestExpiry: 30000,
});
```

---

## React Query Hooks

The hooks module provides TanStack Query hooks for data fetching.

### Available Hooks

| Hook | Purpose |
|------|---------|
| `useSpaces` | Fetch all spaces |
| `useSpace` | Fetch single space by ID |
| `useSpaceMembers` | Fetch members of a space |
| `useChannels` | Fetch channels for a space |
| `useMessages` | Infinite query for paginated messages |
| `useInvalidateMessages` | Invalidate message cache |

### Query Keys

```typescript
import { queryKeys } from '@quilibrium/quorum-shared';

queryKeys.spaces()           // ['spaces']
queryKeys.space(spaceId)     // ['spaces', spaceId]
queryKeys.channels(spaceId)  // ['channels', spaceId]
queryKeys.messages(...)      // ['messages', spaceId, channelId, cursor]
```

### Mutation Hooks

| Hook | Purpose |
|------|---------|
| `useSendMessage` | Send new message |
| `useEditMessage` | Edit existing message |
| `useDeleteMessage` | Delete message |
| `useAddReaction` / `useRemoveReaction` | Manage reactions |

### Helper Functions

```typescript
import { flattenMessages, flattenChannels, findChannel } from '@quilibrium/quorum-shared';

// Flatten infinite query pages
const messages = flattenMessages(infiniteQueryData);
const channels = flattenChannels(space);
const channel = findChannel(space, channelId);
```

---

## Utilities

The utils module provides common helper functions.

### Logger

The most commonly imported utility:

```typescript
import { logger } from '@quilibrium/quorum-shared';

logger.info('Message', { context: 'data' });
logger.warn('Warning message');
logger.error('Error occurred', error);
logger.debug('Debug info');
```

### Formatting

```typescript
import {
  formatTime,
  formatDate,
  formatDateTime,
  formatRelativeTime,
  formatMessageDate,
  truncateText,
  formatFileSize,
  formatMemberCount
} from '@quilibrium/quorum-shared';
```

### Validation

```typescript
import {
  validateDisplayName,
  validateSpaceName,
  isValidCID
} from '@quilibrium/quorum-shared';
```

### Encoding

```typescript
import {
  base64Encode,
  base64Decode,
  hexEncode,
  hexDecode
} from '@quilibrium/quorum-shared';
```

### Mentions

```typescript
import {
  parseMentions,
  extractMentionedUsers
} from '@quilibrium/quorum-shared';
```

---

## Crypto and Signing

### Crypto Module

Provides E2E encryption via WASM:

```typescript
import { WasmCryptoProvider, EncryptionStateManager } from '@quilibrium/quorum-shared';

const crypto = new WasmCryptoProvider();
await crypto.init();
```

### Signing Module

Provides Ed448 digital signatures:

```typescript
import { WasmSigningProvider } from '@quilibrium/quorum-shared';

const signer = new WasmSigningProvider();
await signer.init();
```

### Mobile: Native Crypto Module

Mobile uses a native Rust-based crypto module (`modules/quorum-crypto/`) via Nitro for better performance:

```typescript
// services/crypto/native-provider.ts
import { QuorumCrypto } from '@/modules/quorum-crypto';

// Native implementation provides:
// - Encryption/decryption
// - Key generation
// - Signing operations
```

---

## Transport Layer

### HTTP Client

```typescript
import { TransportClient } from '@quilibrium/quorum-shared';
```

### WebSocket Clients

```typescript
// For React Native (mobile)
import { RNWebSocketClient } from '@quilibrium/quorum-shared';

// For browser/desktop
import { BrowserWebSocketClient } from '@quilibrium/quorum-shared';
```

---

## Mobile Integration

### Storage Adapter Setup

Mobile implements the `StorageAdapter` interface using MMKV:

```typescript
// services/offline/storage.ts
import type { StorageAdapter } from '@quilibrium/quorum-shared';
import { MMKV } from 'react-native-mmkv';

export class MMKVStorageAdapter implements StorageAdapter {
  private storage: MMKV;

  constructor() {
    this.storage = new MMKV();
  }

  // Methods wrap MMKV to conform to shared interface
}
```

### React Query Persistence

Mobile uses MMKV for React Query persistence:

```typescript
// services/api/queryConfig.ts
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { MMKV } from 'react-native-mmkv';

const storage = new MMKV();

const persister = createSyncStoragePersister({
  storage: {
    getItem: (key) => storage.getString(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  },
});
```

### WebSocket Context

Mobile WebSocket integration using shared client:

```typescript
// context/WebSocketContext.tsx
import { RNWebSocketClient } from '@quilibrium/quorum-shared';

const wsClient = new RNWebSocketClient({
  url: WS_URL,
  // ... config
});
```

---

## Usage Examples

### Importing Types

```typescript
import type {
  Space,
  Message,
  Channel,
  UserConfig,
  StorageAdapter
} from '@quilibrium/quorum-shared';
```

### Using Logger (Most Common Pattern)

```typescript
import { logger } from '@quilibrium/quorum-shared';

logger.info('Processing message', { messageId, channelId });
```

### Using Sync Utilities

```typescript
import {
  createMemberDigest,
  computeManifestHash,
  SyncService
} from '@quilibrium/quorum-shared';

const digest = createMemberDigest(member);
const hash = computeManifestHash(manifest);
```

### Using Hooks

```typescript
import { useSpaces, useMessages, flattenMessages } from '@quilibrium/quorum-shared';

function MyComponent() {
  const { data: spaces } = useSpaces();
  const { data: messagesData } = useMessages(spaceId, channelId);
  const messages = flattenMessages(messagesData);
}
```

---

_Last updated: 2026-01-14_
