import { storage } from '../offline/storage';
import {
  getAllSpaces as getSpacesFromStorage,
  getSpace as getSpaceFromStorage,
  saveSpace as saveSpaceToStorage,
  deleteSpace as deleteSpaceFromStorage,
} from '../config/spaceStorage';
import * as messagesDb from './messagesDb';
import type {
  StorageAdapter,
  GetMessagesParams,
  GetMessagesResult,
  Space,
  Channel,
  Message,
  Conversation,
  UserConfig,
  SpaceMember,
  SpaceMemberDevice,
} from '@quilibrium/quorum-shared';

// Key prefixes for organized storage.
// Messages used to live under `messages:<spaceId>:<channelId>` as one
// JSON blob per channel; they now live in a SQLite database (see
// messagesDb.ts), with a one-shot MMKV→SQLite migration that runs on
// first DB open. The MMKV key prefix is intentionally NOT listed here
// anymore — the migration deletes those keys as it moves them.
const KEYS = {
  CONVERSATIONS: (type: string) => `conversations:${type}`,
  CONVERSATION: (id: string) => `conversation:${id}`,
  USER_CONFIG: (address: string) => `userConfig:${address}`,
  SPACE_MEMBERS: (spaceId: string) => `spaceMembers:${spaceId}`,
  SPACE_MEMBER_DEVICES: (spaceId: string) => `spaceMemberDevices:${spaceId}`,
  SYNC_TIME: (key: string) => `sync:${key}`,
} as const;

export class MMKVAdapter implements StorageAdapter {
  // In-memory index for O(1) member lookups by address
  private memberIndexCache = new Map<string, { index: Map<string, number>; raw: string }>();

  async init(): Promise<void> {
    // MMKV is ready synchronously. The SQLite messages database, though,
    // wants to open + apply its SQLCipher key + run the one-shot
    // MMKV→SQLite migration before the first message read so the
    // migration's JS-thread cost isn't paid by whatever UI happens to
    // mount first.
    //
    // ensureDb uses the async SecureStore path to derive the SQLCipher
    // key, then memoizes it. This matters on iOS, where the sync
    // SecureStore bridge has been observed to fail (return null or
    // throw) under conditions where the async path works — running
    // here first ensures the cipher key cache is populated before any
    // sync read tries to consume it.
    //
    // Returns null gracefully if the Ed448 key isn't in SecureStore
    // yet (pre-onboarding); the first post-onboarding message
    // operation will run ensureDb again at that point.
    await messagesDb.ensureDb();
  }

  // Spaces (delegated to spaceStorage)

  async getSpaces(): Promise<Space[]> {
    return getSpacesFromStorage();
  }

  async getSpace(spaceId: string): Promise<Space | null> {
    return getSpaceFromStorage(spaceId);
  }

  async saveSpace(space: Space): Promise<void> {
    saveSpaceToStorage(space);
  }

  async deleteSpace(spaceId: string): Promise<void> {
    deleteSpaceFromStorage(spaceId);
  }

  // Channels

  async getChannels(spaceId: string): Promise<Channel[]> {
    const space = await this.getSpace(spaceId);
    if (!space) return [];
    return space.groups.flatMap((g) => g.channels);
  }

  // Messages — backed by SQLite via messagesDb. See the module header
  // there for the rationale (replaces the old "one JSON blob per
  // channel" MMKV layout). These methods are thin adapters that match
  // the StorageAdapter interface contract.

  async getMessages(params: GetMessagesParams): Promise<GetMessagesResult> {
    return messagesDb.getMessages(params);
  }

  /**
   * Synchronous read used by useMessages' initialData seed so the chat
   * UI paints with cached history on the first render after navigation,
   * with no spinner flash. Delegates to messagesDb.getMessagesSync which
   * uses expo-sqlite's sync query APIs — fast for the typical 50-row
   * page against an indexed table.
   */
  getMessagesSync(params: GetMessagesParams): GetMessagesResult {
    return messagesDb.getMessagesSync(params);
  }

  async getMessage(params: {
    spaceId: string;
    channelId: string;
    messageId: string;
  }): Promise<Message | undefined> {
    return messagesDb.getMessage(params);
  }

  async saveMessage(
    message: Message,
    _lastMessageTimestamp: number,
    _address: string,
    _conversationType: string,
    _icon: string,
    _displayName: string
  ): Promise<void> {
    return messagesDb.saveMessage(message);
  }

  async deleteMessage(messageId: string): Promise<void> {
    return messagesDb.deleteMessage(messageId);
  }

  // Conversations

  async getConversations(params: {
    type: 'direct' | 'group';
    cursor?: number;
    limit?: number;
  }): Promise<{ conversations: Conversation[]; nextCursor: number | null }> {
    const { type, cursor, limit = 50 } = params;

    const data = storage.getString(KEYS.CONVERSATIONS(type));
    const all: Conversation[] = data ? JSON.parse(data) : [];

    // Sort by timestamp descending
    all.sort((a, b) => b.timestamp - a.timestamp);

    let startIdx = 0;
    if (cursor) {
      const cursorIdx = all.findIndex((c) => c.timestamp <= cursor);
      startIdx = cursorIdx >= 0 ? cursorIdx : all.length;
    }

    const slice = all.slice(startIdx, startIdx + limit);

    return {
      conversations: slice,
      nextCursor: startIdx + limit < all.length ? all[startIdx + limit].timestamp : null,
    };
  }

  async getConversation(conversationId: string): Promise<Conversation | undefined> {
    const data = storage.getString(KEYS.CONVERSATION(conversationId));
    return data ? JSON.parse(data) : undefined;
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    storage.set(KEYS.CONVERSATION(conversation.conversationId), JSON.stringify(conversation));

    // Update list
    const data = storage.getString(KEYS.CONVERSATIONS(conversation.type));
    const conversations: Conversation[] = data ? JSON.parse(data) : [];

    const existingIdx = conversations.findIndex(
      (c) => c.conversationId === conversation.conversationId
    );
    if (existingIdx >= 0) {
      conversations[existingIdx] = conversation;
    } else {
      conversations.push(conversation);
    }

    storage.set(KEYS.CONVERSATIONS(conversation.type), JSON.stringify(conversations));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const conversation = await this.getConversation(conversationId);
    if (!conversation) return;

    storage.remove(KEYS.CONVERSATION(conversationId));

    // Update list
    const data = storage.getString(KEYS.CONVERSATIONS(conversation.type));
    const conversations: Conversation[] = data ? JSON.parse(data) : [];
    const filtered = conversations.filter((c) => c.conversationId !== conversationId);
    storage.set(KEYS.CONVERSATIONS(conversation.type), JSON.stringify(filtered));
  }

  // User Config

  async getUserConfig(address: string): Promise<UserConfig | undefined> {
    const data = storage.getString(KEYS.USER_CONFIG(address));
    return data ? JSON.parse(data) : undefined;
  }

  async saveUserConfig(userConfig: UserConfig): Promise<void> {
    storage.set(KEYS.USER_CONFIG(userConfig.address), JSON.stringify(userConfig));
  }

  // Space Members

  async getSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
    const data = storage.getString(KEYS.SPACE_MEMBERS(spaceId));
    return data ? JSON.parse(data) : [];
  }

  async getSpaceMember(spaceId: string, address: string): Promise<SpaceMember | undefined> {
    const key = KEYS.SPACE_MEMBERS(spaceId);
    const data = storage.getString(key);
    if (!data) return undefined;

    const cached = this.memberIndexCache.get(spaceId);
    if (cached && cached.raw === data) {
      const idx = cached.index.get(address);
      if (idx === undefined) return undefined;
      const members: SpaceMember[] = JSON.parse(data);
      return members[idx];
    }

    const members: SpaceMember[] = JSON.parse(data);
    const index = new Map<string, number>();
    members.forEach((m, i) => index.set(m.address, i));
    this.memberIndexCache.set(spaceId, { index, raw: data });
    const idx = index.get(address);
    return idx !== undefined ? members[idx] : undefined;
  }

  async saveSpaceMember(spaceId: string, member: SpaceMember): Promise<void> {
    const members = await this.getSpaceMembers(spaceId);
    const existingIdx = members.findIndex((m) => m.address === member.address);
    if (existingIdx >= 0) {
      members[existingIdx] = member;
    } else {
      members.push(member);
    }
    storage.set(KEYS.SPACE_MEMBERS(spaceId), JSON.stringify(members));
    this.memberIndexCache.delete(spaceId);
  }

  // Per-device signing-key admissions (mirrors desktop's space_member_devices
  // store). Keyed by (spaceId, deviceInboxAddress); one JSON array per space.
  // Never touches the member row's join binding.

  async getSpaceMemberDevices(spaceId: string): Promise<SpaceMemberDevice[]> {
    const data = storage.getString(KEYS.SPACE_MEMBER_DEVICES(spaceId));
    return data ? JSON.parse(data) : [];
  }

  async getSpaceMemberDevice(
    spaceId: string,
    deviceInboxAddress: string
  ): Promise<SpaceMemberDevice | undefined> {
    const devices = await this.getSpaceMemberDevices(spaceId);
    return devices.find((d) => d.deviceInboxAddress === deviceInboxAddress);
  }

  async saveSpaceMemberDevice(device: SpaceMemberDevice): Promise<void> {
    const devices = await this.getSpaceMemberDevices(device.spaceId);
    const idx = devices.findIndex(
      (d) => d.deviceInboxAddress === device.deviceInboxAddress
    );
    if (idx >= 0) devices[idx] = device;
    else devices.push(device);
    storage.set(
      KEYS.SPACE_MEMBER_DEVICES(device.spaceId),
      JSON.stringify(devices)
    );
  }

  // Sync Metadata

  async getLastSyncTime(key: string): Promise<number | undefined> {
    const data = storage.getString(KEYS.SYNC_TIME(key));
    return data ? parseInt(data, 10) : undefined;
  }

  async setLastSyncTime(key: string, time: number): Promise<void> {
    storage.set(KEYS.SYNC_TIME(key), time.toString());
  }
}

/**
 * Synchronous conversation read (MMKV is sync-backed). Used where an async
 * getConversation can't be awaited — e.g. the DM receipt gate on the inbound
 * decrypt path.
 */
export function getConversationSync(conversationId: string): Conversation | undefined {
  const data = storage.getString(KEYS.CONVERSATION(conversationId));
  return data ? (JSON.parse(data) as Conversation) : undefined;
}

// Singleton instance
let adapter: MMKVAdapter | null = null;

export function getMMKVAdapter(): MMKVAdapter {
  if (!adapter) {
    adapter = new MMKVAdapter();
  }
  return adapter;
}
