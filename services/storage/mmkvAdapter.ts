/**
 * MMKVAdapter - StorageAdapter implementation for React Native using MMKV
 */

import { storage } from '../offline/storage';
import {
  getAllSpaces as getSpacesFromStorage,
  getSpace as getSpaceFromStorage,
  saveSpace as saveSpaceToStorage,
  deleteSpace as deleteSpaceFromStorage,
} from '../config/spaceStorage';
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
} from '@quilibrium/quorum-shared';

// Key prefixes for organized storage
// Note: Space storage is handled by spaceStorage.ts (quorum-spaces MMKV instance)
const KEYS = {
  MESSAGES: (spaceId: string, channelId: string) => `messages:${spaceId}:${channelId}`,
  CONVERSATIONS: (type: string) => `conversations:${type}`,
  CONVERSATION: (id: string) => `conversation:${id}`,
  USER_CONFIG: (address: string) => `userConfig:${address}`,
  SPACE_MEMBERS: (spaceId: string) => `spaceMembers:${spaceId}`,
  SYNC_TIME: (key: string) => `sync:${key}`,
} as const;

export class MMKVAdapter implements StorageAdapter {
  async init(): Promise<void> {
    // MMKV is ready synchronously, no initialization needed
  }

  // ============ Spaces ============
  // Delegate to spaceStorage for consistent storage location

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

  // ============ Channels ============

  async getChannels(spaceId: string): Promise<Channel[]> {
    const space = await this.getSpace(spaceId);
    if (!space) return [];
    return space.groups.flatMap((g) => g.channels);
  }

  // ============ Messages ============

  async getMessages(params: GetMessagesParams): Promise<GetMessagesResult> {
    const { spaceId, channelId, cursor, direction = 'backward', limit = 50 } = params;

    const key = KEYS.MESSAGES(spaceId, channelId);
    const data = storage.getString(key);
    const allMessages: Message[] = data ? JSON.parse(data) : [];

    // Sort by createdDate descending (newest first)
    allMessages.sort((a, b) => b.createdDate - a.createdDate);

    let startIdx = 0;
    if (cursor) {
      const cursorIdx = allMessages.findIndex((m) => m.createdDate === cursor);
      if (cursorIdx >= 0) {
        startIdx = direction === 'backward' ? cursorIdx + 1 : Math.max(0, cursorIdx - limit);
      }
    }

    const slice = allMessages.slice(startIdx, startIdx + limit);

    // For display, reverse to chronological order
    if (direction === 'backward') {
      slice.reverse();
    }

    return {
      messages: slice,
      nextCursor: startIdx + limit < allMessages.length ? allMessages[startIdx + limit].createdDate : null,
      prevCursor: startIdx > 0 ? allMessages[startIdx - 1].createdDate : null,
    };
  }

  async getMessage(params: {
    spaceId: string;
    channelId: string;
    messageId: string;
  }): Promise<Message | undefined> {
    const key = KEYS.MESSAGES(params.spaceId, params.channelId);
    const data = storage.getString(key);
    if (!data) return undefined;

    const messages: Message[] = JSON.parse(data);
    return messages.find((m) => m.messageId === params.messageId);
  }

  async saveMessage(
    message: Message,
    _lastMessageTimestamp: number,
    _address: string,
    _conversationType: string,
    _icon: string,
    _displayName: string
  ): Promise<void> {
    const key = KEYS.MESSAGES(message.spaceId, message.channelId);
    const data = storage.getString(key);
    const messages: Message[] = data ? JSON.parse(data) : [];

    // Populate replyMetadata for replies (E2E encrypted, so client must do this lookup)
    const content = message.content as Record<string, unknown> | undefined;
    if (content?.repliesToMessageId && !message.replyMetadata) {
      const parentMessage = messages.find((m) => m.messageId === content.repliesToMessageId);
      const parentContent = parentMessage?.content as Record<string, unknown> | undefined;
      if (parentContent?.senderId) {
        message.replyMetadata = {
          parentAuthor: parentContent.senderId as string,
          parentChannelId: parentMessage.channelId,
        };
      }
    }

    // Update or add message
    const existingIdx = messages.findIndex((m) => m.messageId === message.messageId);
    if (existingIdx >= 0) {
      messages[existingIdx] = message;
    } else {
      messages.push(message);
    }

    // Keep only last 1000 messages per channel
    if (messages.length > 1000) {
      messages.sort((a, b) => b.createdDate - a.createdDate);
      messages.splice(1000);
    }

    storage.set(key, JSON.stringify(messages));
  }

  async deleteMessage(messageId: string): Promise<void> {
    // Need to find and delete from all channels - expensive but rare operation
    const spaces = await this.getSpaces();
    for (const space of spaces) {
      const channels = await this.getChannels(space.spaceId);
      for (const channel of channels) {
        const key = KEYS.MESSAGES(space.spaceId, channel.channelId);
        const data = storage.getString(key);
        if (!data) continue;

        const messages: Message[] = JSON.parse(data);
        const filtered = messages.filter((m) => m.messageId !== messageId);
        if (filtered.length !== messages.length) {
          storage.set(key, JSON.stringify(filtered));
          return;
        }
      }
    }
  }

  // ============ Conversations ============

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

  // ============ User Config ============

  async getUserConfig(address: string): Promise<UserConfig | undefined> {
    const data = storage.getString(KEYS.USER_CONFIG(address));
    return data ? JSON.parse(data) : undefined;
  }

  async saveUserConfig(userConfig: UserConfig): Promise<void> {
    storage.set(KEYS.USER_CONFIG(userConfig.address), JSON.stringify(userConfig));
  }

  // ============ Space Members ============

  async getSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
    const data = storage.getString(KEYS.SPACE_MEMBERS(spaceId));
    return data ? JSON.parse(data) : [];
  }

  async getSpaceMember(spaceId: string, address: string): Promise<SpaceMember | undefined> {
    const members = await this.getSpaceMembers(spaceId);
    return members.find((m) => m.address === address);
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
  }

  // ============ Sync Metadata ============

  async getLastSyncTime(key: string): Promise<number | undefined> {
    const data = storage.getString(KEYS.SYNC_TIME(key));
    return data ? parseInt(data, 10) : undefined;
  }

  async setLastSyncTime(key: string, time: number): Promise<void> {
    storage.set(KEYS.SYNC_TIME(key), time.toString());
  }
}

// Singleton instance
let adapter: MMKVAdapter | null = null;

export function getMMKVAdapter(): MMKVAdapter {
  if (!adapter) {
    adapter = new MMKVAdapter();
  }
  return adapter;
}
