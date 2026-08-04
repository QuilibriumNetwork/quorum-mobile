---
type: doc
title: Quorum Ecosystem Architecture
status: done
created: 2026-01-09T00:00:00.000Z
updated: 2026-06-11T00:00:00.000Z
---

# Quorum Ecosystem Architecture

> **AI-Generated**: May contain errors. Verify before use.

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
12. [UI Primitives](#ui-primitives)
13. [Desktop Integration](#desktop-integration)
14. [Usage Examples](#usage-examples)
15. [Related Documentation](#related-documentation)

---

## Ecosystem Overview

Quorum is built as a **multi-repository ecosystem** where shared functionality lives in a central package consumed by both web/desktop and mobile applications.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        QUORUM ECOSYSTEM                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                    ┌──────────────────────────┐                          │
│                    │   @quilibrium/quorum-    │                          │
│                    │         shared           │                          │
│                    │                          │                          │
│                    │  • Types & Interfaces    │                          │
│                    │  • UI Primitives         │                          │
│                    │  • Sync Protocol         │                          │
│                    │  • React Query Hooks     │                          │
│                    │  • Storage Adapter       │                          │
│                    │  • Crypto & Signing      │                          │
│                    │  • Utilities             │                          │
│                    └────────────┬─────────────┘                          │
│                                 │                                        │
│                    ┌────────────┴────────────┐                           │
│                    │                         │                           │
│                    ▼                         ▼                           │
│     ┌──────────────────────┐    ┌──────────────────────┐                │
│     │   quorum-desktop     │    │    quorum-mobile     │                │
│     │   (this repo)        │    │                      │                │
│     │                      │    │                      │                │
│     │  • Web app (Vite)    │    │  • React Native      │                │
│     │  • Desktop (Electron)│    │  • Expo              │                │
│     │  • IndexedDB storage │    │  • MMKV storage      │                │
│     │  • Web primitives    │    │  • Native primitives │                │
│     └──────────────────────┘    └──────────────────────┘                │
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
| **quorum-desktop** | `github.com/QuilibriumNetwork/quorum-desktop` | Web + Electron desktop app (this repo) |
| **quorum-mobile** | `github.com/QuilibriumNetwork/quorum-mobile` | React Native + Expo mobile app |
| **quorum-shared** | `github.com/QuilibriumNetwork/quorum-shared` | Shared types, hooks, sync protocol |

### What Lives Where

| Code Type | Location | Notes |
|-----------|----------|-------|
| **Shared types** | `quorum-shared` | Space, Message, User, etc. |
| **Shared hooks** | `quorum-shared` | useSpaces, useMessages, etc. |
| **Sync protocol** | `quorum-shared` | Hash-based delta sync |
| **Storage interface** | `quorum-shared` | `StorageAdapter` interface |
| **Storage implementation** | Each app | IndexedDB (desktop) / MMKV (mobile) |
| **UI primitives** | `quorum-shared` | Cross-platform (.web.tsx / .native.tsx) |
| **SCSS styles** | Each app | Web styling for primitives (quorum-desktop keeps SCSS locally) |
| **Business components** | Each app | Built on shared hooks + shared primitives |

---

## Cross-Repo Feature Development

### When Implementing a Feature

Before implementing a feature, check:

1. **Does quorum-shared have the types?**
   - If yes → import and use them
   - If no → feature may need types added to shared first

2. **Does quorum-mobile already have this feature?**
   - Browse: `github.com/QuilibriumNetwork/quorum-mobile`
   - Check `src/` for similar components/hooks
   - If mobile has it → ensure your implementation uses same shared types for sync

3. **Will data need to sync?**
   - If yes → must use shared types and storage adapter interface
   - Bookmarks, read states, user config, messages all sync

### Checking Mobile Implementation

To inspect a feature on mobile:

```
https://github.com/QuilibriumNetwork/quorum-mobile/tree/main/src
```

Key directories to check:
- `src/components/` - UI components
- `src/hooks/` - Custom hooks (may have features not yet on desktop)
- `src/screens/` - Screen-level components
- `src/services/` - Business logic services

### Feature Parity Checklist

When porting a feature from mobile to desktop:

- [ ] Identify the feature in `quorum-mobile`
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
| **Version (local desktop clone)** | `2.1.0-21` |
| **Version (remote `origin/master`)** | `2.1.0-21` (HEAD commit `a1de28f`) |
| **Version (mobile consumer)** | `2.1.0` (npm-published) |
| **Peer Dependencies** | React 19+, TanStack React Query 5+, `@noble/curves` 2.0.1 |
| **Build Format** | Dual ESM/CJS with TypeScript declarations |

---

## Package Structure

```
@quilibrium/quorum-shared/src/
├── api/           # API client interface and errors
├── crypto/        # E2E encryption (WASM-based)
├── farcaster/     # Hypersnap-first Farcaster client + signers + ~15 React Query hooks (expanded 2026-05-30)
├── hooks/         # React Query hooks + useTwoStepConfirm (cross-platform UI primitive)
├── primitives/    # Cross-platform UI components (22 components, web + native variants)
├── receipts/      # ReceiptService (delivery / read acks)
├── signing/       # Ed448 signing (WASM-based)
├── storage/       # Platform-agnostic storage adapter interface
├── sync/          # Hash-based delta synchronization protocol
├── transport/     # HTTP and WebSocket communication
├── types/         # Comprehensive type definitions
├── typing/        # TypingService (per-conversation indicators)
├── utils/         # Formatting, encoding, logging, permissions, role mutations, message preview, etc.
└── validation/    # Field validators with errorKey i18n pattern (validateSpaceName, etc.)
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
| `Permission` | `'message:delete' \| 'message:pin' \| 'mention:everyone' \| 'user:mute'` |
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
| `UserConfig` | User preferences, space memberships, bookmarks, sync settings |
| `UserNote` | Per-target private annotation (synced via `UserConfig.userNotes`) |
| `SpaceMember` | User's membership in a space with roles |
| `NavItem` | Navigation item (space or folder) |
| `SpaceNotificationSettings` | Per-space notification preferences (renamed from `NotificationSettings` with `Space*` prefix in PR #18 2026-05-28). Inner shape still placeholder `{ enabled?, mentions?, replies?, all? }` — desktop writes a richer shape; alignment is the open migration track (mobile issue #65). |
| `FarcasterLink` | Optional bidirectional Farcaster ↔ Quorum identity link. Significantly expanded 2026-05-30 (Cassandra's commits added Hypersnap-first client + 4 new Farcaster hooks). |

#### `UserConfig` fields most relevant to ongoing migration

- `notificationSettings?: { [spaceId: string]: NotificationSettings }` — per-space map. The map shape is correct on shared; the inner `NotificationSettings` is the placeholder.
- `bio?: string`
- `isProfilePublic?: boolean` (NEW on `origin/master`)
- `farcasterLink?: FarcasterLink` (NEW on `origin/master`)
- Privacy/device fields added 2026-05-27 (PR #16): `deliveryReceipts`, `readReceipts`, `typingIndicatorsDM`, `typingIndicatorsSpaces`, `generateYouTubePreviews`, `deviceNames`, `deletedDeviceNameAddresses`.

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

### Desktop Implementation

Desktop uses `IndexedDBAdapter` which wraps `MessageDB`:

```typescript
// src/adapters/indexedDbAdapter.ts
import type { StorageAdapter } from '@quilibrium/quorum-shared';

export class IndexedDBAdapter implements StorageAdapter {
  // Wraps MessageDB to conform to shared interface
}
```

---

## Sync Protocol

> **⚠️ Client divergence (verified 2026-06-11).** The hash-based delta sync protocol described below is **active on desktop only**. **Mobile has removed peer-to-peer mesh sync entirely** and replaced it with a server-side per-hub log transport (`listen-hub` + `log-since` WebSocket frames). On mobile, the `sync-request`/`sync-info`/`sync-initiate`/`sync-manifest`/`sync-delta` handlers are gone (imports remain as dead stubs; the code comments confirm "peer-to-peer mesh sync is gone"). The two clients therefore behave differently when catching up on space history — see [Cross-client divergence](#cross-client-divergence-desktop-p2p-vs-mobile-hub-log) below. This `quorum-shared` `sync` module is consumed by desktop; mobile does not instantiate `SharedSyncService`.

The sync module implements hash-based delta synchronization for efficient data transfer between peers.

### Protocol Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    SYNC PROTOCOL STEPS                           │
├─────────────────────────────────────────────────────────────────┤
│  1. sync-request (broadcast)                                     │
│     → Send SyncSummary with manifestHash to discover peers       │
│                                                                  │
│  2. sync-info (response)                                         │
│     → Peers with different data respond with their summary       │
│                                                                  │
│  3. sync-initiate (to best candidate)                            │
│     → Send full manifest (per-message digests)                   │
│                                                                  │
│  4. sync-manifest (response)                                     │
│     → Peer responds with their manifest for comparison           │
│                                                                  │
│  5. sync-delta (chunked)                                         │
│     → Exchange only missing/updated messages                     │
│     → Includes member and peer map deltas                        │
│     → Final chunk marked with isFinal flag                       │
└─────────────────────────────────────────────────────────────────┘
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

### Cross-client divergence: desktop P2P vs. mobile hub-log

As of 2026-06-11, desktop and mobile use **different transports** for delivering space chat messages and for catching up on history. This is verified against both repos' source, not inferred.

| Aspect | Desktop (this repo) | Mobile (`quorum-mobile`) |
|---|---|---|
| Live message transport | Hub WebSocket broadcast | Hub WebSocket (`log-append` / `log-update`) |
| History catch-up on join/reconnect | **P2P sync** — `sync-request` → `sync-info` → `sync-initiate` → `sync-manifest` → `sync-delta`, served by an **online peer** | **Server-side hub log** — `listen-hub` + `log-since` replays the server-retained log from a stored cursor |
| Requires another member online to backfill history | **Yes** — no online peer means no backfill | **No** — the server replays its hub log even if no peer is online |
| `SharedSyncService` (this module) instantiated? | Yes (`src/services/SyncService.ts`) | No — handlers removed; sync types imported only as dead stubs |
| Background / push-driven fetch | No | Yes (silent push + periodic background task) |

**What is NOT part of this divergence (verified, to avoid confusion):** the mobile **hub log carries chat messages** (post, embed, sticker, reaction, edit/remove, and `join`/`leave`/`kick`/`rekey`/`update-profile` control messages) — it is the primary chat transport, not a side-channel. The separate **public-profile** feature (`POST`/`GET /users/:addr/public-profile`) is plain HTTP REST on **both** clients and does **not** ride the hub log. The hub-log `update-profile` message (in-space member presence) is a different mechanism from the global public-profile endpoint.

**Shared cold-start behavior (both clients):** joining a space starts with an empty local DB — no messages, only the joiner in the member list (the space manifest carries neither). What differs is only *how* history then backfills (peer-dependent P2P on desktop; server hub-log on mobile). See the desktop-side detail in [data-management-architecture-guide.md → Cold-start when joining a Space](../../../quorum-desktop/.agents/docs/data-management-architecture-guide.md#cold-start-when-joining-a-space-expected-no-messages-only-me).

> Whether desktop is intended to migrate to the hub-log transport (converging with mobile) is a product decision not recorded in code — confirm with the lead dev before treating either model as the permanent end state.

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
| `useTwoStepConfirm` | Two-step confirmation state machine (cross-platform UI primitive, added in 2.1.0-18) |

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

The most commonly imported utility (used in 45+ files):

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

Shared exposes field validators under the `errorKey` i18n pattern — validators return codes, consuming apps translate to localized strings. Lets shared stay i18n-free while supporting any locale at the app layer.

```typescript
import {
  // Single-result validators (return { ok: true } | { ok: false; errorKey; errorVars? })
  validateSpaceName,
  validateDisplayName,
  validateChannelName,
  validateChannelTopic,
  validateGroupName,
  validateDeviceName,
  // Multi-result validators (return FieldValidationResult[])
  validateSpaceDescription,
  validateUserBio,
  validateUserNote,
  // Result types + helper
  type FieldValidationResult,
  isValidField,
  // XSS check (used inside the validators; also exported for direct use)
  validateNameForXSS,
  // Constants
  MAX_NAME_LENGTH,        // 50
  MIN_NAME_LENGTH,        // 2
  MAX_TOPIC_LENGTH,
  MAX_BIO_LENGTH,         // 160
  MAX_USER_NOTE_LENGTH,   // 256
  DEVICE_NAME_PATTERN,
  // CID validation
  isValidIPFSCID,
  createIPFSCIDRegex,
} from '@quilibrium/quorum-shared';
```

Desktop wraps each validator with a `errorKey → Lingui string` lookup in `src/hooks/business/validation/errorTranslator.ts`. Mobile does the same with plain English strings. The `errorKey` pattern is documented in `.agents/tasks/quorum-shared-migration/cross-repo-workflow.md`.

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

### Permissions and Role Mutations

Pure helpers for working with `Role` + `Permission`. Use these instead of inlining the math at call sites.

```typescript
import {
  // Read-side
  hasPermission,        // (userAddress, permission, space, isSpaceOwner) => boolean
  getUserPermissions,   // (userAddress, space, isSpaceOwner) => Permission[]
  getUserRoles,         // (userAddress, space) => Role[]
  // Channel permission narrowing (read-only channels, etc.)
  canManageReadOnlyChannel,
  createChannelPermissionChecker,
  findChannelByName,
  // Role mutation (immutable; returns new Role objects)
  toggleRolePermission, // (role, permission) => Role (added 2.1.0-21)
  setRolePermissions,   // (role, permissions) => Role  (added 2.1.0-21)
} from '@quilibrium/quorum-shared';
```

### Invite Domain Helpers

Environment-aware URL/prefix generation for invite links. Replaces hardcoded `qm.one`/`app.quorummessenger.com` regex literals.

```typescript
import {
  getInviteBaseDomain,       // env-aware: prod/staging/localhost
  getInviteUrlBase,          // (isPublicInvite: boolean) => string
  getInviteDisplayDomain,
  getValidInvitePrefixes,    // env-aware: prefix list for link detection
  parseInviteParams,         // parse an invite URL into structured parts
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

---

## Transport Layer

### HTTP Client

```typescript
import { TransportClient } from '@quilibrium/quorum-shared';
```

### WebSocket Clients

```typescript
// For browser/desktop
import { BrowserWebSocketClient } from '@quilibrium/quorum-shared';

// For React Native
import { RNWebSocketClient } from '@quilibrium/quorum-shared';
```

---

## UI Primitives

> **Status:** Migrated to quorum-shared. See [Migration Prep Task](../../../quorum-desktop/.agents/issues/quorum-shared-migration/.done/2026-03-15-primitives-migration-prep.md) for details.

18 cross-platform UI components with `.web.tsx` and `.native.tsx` implementations, plus a theme system with colors and ThemeProvider.

### Location

Primitives live in `@quilibrium/quorum-shared/src/primitives/`. Consuming apps import from `@quilibrium/quorum-shared`:

```typescript
import { Button, Modal, Input, useTheme } from '@quilibrium/quorum-shared';
```

In quorum-desktop, a local barrel (`src/components/primitives/index.ts`) re-exports from quorum-shared and imports SCSS styles. Existing imports (`from '../primitives'`) continue to work unchanged.

### Platform Resolution

The package ships pre-built bundles for each platform via `package.json` exports:

- **Web (Vite/webpack):** `dist/index.mjs` — resolves `.web.tsx` at build time
- **React Native (Metro):** `dist/index.native.js` — resolves `.native.tsx` at build time

### Components

| Category | Components |
|----------|------------|
| **Layout** | Flex, Spacer, ScrollContainer, OverlayBackdrop, Portal (web-only) |
| **Form** | Button, Input, TextArea, Select, Switch, RadioGroup, ColorSwatch, FileUpload |
| **Feedback** | Modal, Tooltip, Callout |
| **Content** | Icon, Text, Paragraph, Label, Caption, Title, InlineText |
| **Theme** | ThemeProvider, useTheme, getColors |

### Key Design Decisions

- **Web primitives are unstyled** — consuming apps provide CSS (SCSS files stay in quorum-desktop)
- **Native primitives are self-contained** — styles via React Native StyleSheet
- **No i18n dependency** — plain English defaults, apps pass translated strings via props
- **ModalContainer is internal** to Modal (not a public export)
- **Container primitive was dropped** — replaced with `<div>` (web) / `<View>` (native)

### Consumer Setup

See the [quorum-shared README](https://github.com/QuilibriumNetwork/quorum-shared#readme) for Vite, Metro, and Tailwind configuration requirements.

### Theme Integration

Primitives consume theme values differently per platform but use the same color palette:

**Web (CSS Variables):**
```tsx
// Button.web.tsx uses Tailwind/CSS variables
<button className="bg-accent text-white hover:bg-accent-400">
  {children}
</button>
```

**Native (JS Context):**
```tsx
// Button.native.tsx uses theme context
const { theme } = useTheme();
<Pressable style={{ backgroundColor: theme.colors.accent }}>
  <Text style={{ color: 'white' }}>{children}</Text>
</Pressable>
```

### Related Documentation

- [Primitives Migration Task](../../../quorum-desktop/.agents/issues/.done/primitives-migration-to-quorum-shared.md) - Step-by-step migration plan
- [Gap Analysis Report](../../../quorum-desktop/.agents/reports/primitives-gap-analysis-quorum-shared_2026-01-14.md) - Desktop vs mobile comparison
- Component Architecture Masterplan - Architectural philosophy

---

## Desktop Integration

### Storage Adapter Setup

Desktop implements the `StorageAdapter` interface using IndexedDB:

```typescript
// src/adapters/indexedDbAdapter.ts
import type { StorageAdapter } from '@quilibrium/quorum-shared';
import { MessageDB } from '../db/messages';

export class IndexedDBAdapter implements StorageAdapter {
  private db: MessageDB;

  constructor(db: MessageDB) {
    this.db = db;
  }

  // Methods wrap MessageDB to conform to shared interface
}
```

### SyncService Integration

```typescript
// src/services/SyncService.ts
import {
  SyncService as SharedSyncService,
  createMemberDigest,
  SyncSummary,
  SyncManifest
} from '@quilibrium/quorum-shared';

export class SyncService {
  private sharedSyncService: SharedSyncService;

  constructor(dependencies) {
    this.sharedSyncService = new SharedSyncService({
      storage: new IndexedDBAdapter(dependencies.messageDB),
      maxMessages: 1000,
      requestExpiry: 30000,
    });
  }
}
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

## Related Documentation

- [Data Management Architecture](../../../quorum-desktop/.agents/docs/data-management-architecture-guide.md) - Storage patterns and IndexedDB schema
- [Cryptographic Architecture](../../../quorum-desktop/.agents/docs/cryptographic-architecture.md) - Encryption protocols
- [Config Sync System](../../../quorum-desktop/.agents/docs/config-sync-system.md) - User config synchronization
- [quorum-shared Migration Analysis](../../../quorum-desktop/.agents/reports/quorum-shared-migration-analysis_2026-01-05.md) - Future migration planning and gap analysis
- [Primitives Migration Task](../../../quorum-desktop/.agents/issues/.done/primitives-migration-to-quorum-shared.md) - UI primitives migration plan
- [Primitives Gap Analysis](../../../quorum-desktop/.agents/reports/primitives-gap-analysis-quorum-shared_2026-01-14.md) - Desktop vs mobile comparison

---

*Last updated: 2026-06-11*
