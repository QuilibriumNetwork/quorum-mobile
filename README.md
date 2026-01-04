# Quorum Mobile

Privacy-first messaging and social platform built on the Quilibrium decentralized network. Combines end-to-end encrypted direct messaging, group spaces, and Farcaster social integration with a native mobile experience.

## Overview

Quorum implements X3DH key agreement and Double Ratchet protocols for end-to-end encryption over a decentralized infrastructure. The application provides encrypted direct messages, group spaces with channel organization, and integration with the Farcaster protocol for decentralized social features.

## Architecture

**Framework:** React Native 0.81 with Expo 54
**Platform Support:** iOS, Android, Web
**Language:** TypeScript 5.9 (strict mode)

### Core Technologies

- **Cryptography:** Custom native module (`quorum-crypto`) implementing Ed448/X448, supplemented by `@noble/curves` and `@noble/hashes`
- **Encryption Protocols:** `@quilibrium/quorum-shared` for X3DH key agreement, Double Ratchet, and Triple Ratchet session management
- **State Management:** TanStack React Query v5 with MMKV persistence for offline-first architecture
- **Storage:** React Native MMKV (encrypted), Expo Secure Store (credentials)
- **Networking:** WebSocket for real-time messaging, REST API for state synchronization
- **Navigation:** Expo Router with type-safe routes

### Key Features

**Messaging**
- End-to-end encrypted direct messages using X3DH + Double Ratchet
- Encrypted group spaces with channels, members, and permissions
- Message reactions, editing, and deletion
- Media attachments with image processing
- Background message synchronization

**Farcaster Integration**
- Social feed browsing and interaction (likes, recasts, replies)
- User profile viewing and threading
- Cast composition and posting
- Mini-app support via WebView host

**Security**
- BIP39 mnemonic-based key generation
- Private key import via hex or QR code
- Configurable privacy levels (maximum/enhanced/standard)
- Sealed sender protocol for initial contact
- Ed448 signature verification

## Project Structure

```
app/                    # Expo Router pages and navigation
components/            # React components (Chat, SocialFeed, UI)
context/               # React Context providers (Auth, WebSocket, API)
hooks/                 # Custom hooks for messaging and social features
services/              # Business logic (crypto, API, notifications, spaces)
modules/quorum-crypto/ # Native cryptography module interface
theme/                 # Theme system and color definitions
```

## Development

### Prerequisites

- Node.js (version specified in `.node-version`)
- Expo CLI
- iOS Simulator (macOS) or Android Emulator

### Installation

```bash
npm install
```

### Running the Application

```bash
# Start development server
npm start

# Platform-specific builds
npm run ios
npm run android
npm run web
```

### Code Quality

```bash
npm run lint
```

### Cache Management

```bash
# Clear Metro and Watchman caches
npm run clean

# Reset project state
npm run reset-project
```

## Configuration

**API Endpoints:**
- Primary API: `https://api.quorummessenger.com`
- WebSocket: `wss://api.quorummessenger.com/ws`
- Farcaster API: `https://client.farcaster.xyz`

**Build System:**
- EAS configuration in `eas.json`
- Metro bundler configured for module resolution
- React Native new architecture enabled

## Encryption Implementation

The application implements a layered encryption approach:

1. **Key Generation:** Ed448/X448 keypairs generated from BIP39 mnemonic or imported directly
2. **Session Establishment:** X3DH protocol for initial key agreement
3. **Message Encryption:** Double Ratchet for forward secrecy in direct messages
4. **Group Encryption:** Triple Ratchet for space-based communications
5. **Inbox Protection:** Sealed sender protocol prevents metadata leakage

Cryptographic operations leverage a native module for performance-critical Ed448/X448 operations, with fallback to JavaScript implementations via `@noble/curves`.

## Background Processing

Background message fetching runs at 15-minute intervals using Expo Background Fetch. The background task is registered before React initialization to ensure proper iOS/Android lifecycle handling.

## Mini-Apps

Supports Farcaster mini-apps via WebView with the Farcaster MiniApp Host protocol. Includes transaction validation and user warnings for potentially risky operations.

## License

See LICENSE file for details.
